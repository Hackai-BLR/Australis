use std::net::IpAddr;
use std::path::{Path as RutaFs, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use serde_json::{json, Value};
use sqlx::Row;
use tokio::io::AsyncWriteExt;

use crate::agente::{cambios_sin_publicar, cuerpo_objeto, curso_no_listo, docente, ocupado};
use crate::auth::*;
use crate::contenedores::{EspecContenedor, ProveedorDeContenedores};
use crate::db::auditar;
use crate::espacios::{recortar, Espacios, Ocupacion, Turno};
use crate::modelo::reemplazar;
use crate::repo::{git, git_texto, quitar, resolver};
use crate::supervisor::nombre_contenedor;
use crate::util::*;

const MAXIMO_REGISTRO: usize = 20_000;
const ARCHIVO_RECETA: &str = "Containerfile.campusia";
const RECETA_IMAGEN: &str = "FROM node:22-bookworm-slim\n\
ENV NODE_ENV=production PORT=3000 CAMPUSIA_DATOS=/datos\n\
WORKDIR /app\n\
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn* /usr/local/bin/yarn /usr/local/bin/yarnpkg \\\n\
 && mkdir -p /datos \\\n\
 && chown node:node /datos \\\n\
 && chmod 700 /datos\n\
COPY node_modules ./node_modules\n\
COPY dist ./dist\n\
COPY package.json ./\n\
USER node\n\
EXPOSE 3000\n\
VOLUME [\"/datos\"]\n\
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \\\n\
  CMD [\"node\", \"-e\", \"fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/salud').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))\"]\n\
CMD [\"node\", \"dist/servidor/index.js\"]\n";

fn autor_json(id: Option<i64>, nombre: Option<String>) -> Value {
    match id {
        Some(i) => json!({"id": i, "nombre": nombre}),
        None => Value::Null,
    }
}

const SQL_PUBLICACION: &str = "SELECT p.id, p.tipo, p.estado, p.etapa, p.version, p.desde_version, p.descripcion, p.error, p.registro, \
     p.autor_id, u.nombre AS autor_nombre, p.creada_en, p.terminada_en FROM publicaciones p LEFT JOIN usuarios u ON u.id = p.autor_id";

fn publicacion_json(f: &sqlx::sqlite::SqliteRow) -> Value {
    json!({
        "id": f.get::<i64, _>("id"),
        "tipo": f.get::<String, _>("tipo"),
        "estado": f.get::<String, _>("estado"),
        "etapa": f.get::<String, _>("etapa"),
        "version": f.get::<Option<i64>, _>("version"),
        "desde_version": f.get::<Option<i64>, _>("desde_version"),
        "descripcion": f.get::<String, _>("descripcion"),
        "error": f.get::<Option<String>, _>("error"),
        "registro": f.get::<String, _>("registro"),
        "autor": autor_json(f.get("autor_id"), f.get("autor_nombre")),
        "creada": f.get::<String, _>("creada_en"),
        "terminada": f.get::<Option<String>, _>("terminada_en"),
    })
}

async fn publicacion(app: &App, id: &str, pid: i64) -> Result<Option<Value>, sqlx::Error> {
    let f = sqlx::query(&format!("{SQL_PUBLICACION} WHERE p.id = ? AND p.curso_id = ?")).bind(pid).bind(id).fetch_optional(&app.db).await?;
    Ok(f.as_ref().map(publicacion_json))
}

pub async fn ver_versiones(State(app): State<Estado>, ctx: Ctx, Path(id): Path<String>) -> Resultado {
    let curso = docente(&app, &ctx, &id).await?;
    let filas = sqlx::query(
        "SELECT v.numero, v.fecha, v.descripcion, v.autor_id, u.nombre AS autor_nombre, v.commit_main, v.origen \
         FROM versiones v LEFT JOIN usuarios u ON u.id = v.autor_id WHERE v.curso_id = ? ORDER BY v.numero DESC",
    )
    .bind(&id)
    .fetch_all(&app.db)
    .await?;
    let versiones: Vec<Value> = filas
        .iter()
        .map(|f| {
            json!({
                "numero": f.get::<i64, _>("numero"),
                "fecha": f.get::<String, _>("fecha"),
                "descripcion": f.get::<String, _>("descripcion"),
                "autor": autor_json(f.get("autor_id"), f.get("autor_nombre")),
                "commit": f.get::<String, _>("commit_main"),
                "origen": f.get::<Option<i64>, _>("origen"),
            })
        })
        .collect();
    Ok(ok(json!({
        "publicada": curso.version_publicada,
        "cambios_sin_publicar": cambios_sin_publicar(&app, &id).await,
        "versiones": versiones,
    })))
}

pub async fn ver_publicaciones(State(app): State<Estado>, ctx: Ctx, Path(id): Path<String>) -> Resultado {
    docente(&app, &ctx, &id).await?;
    let filas =
        sqlx::query(&format!("{SQL_PUBLICACION} WHERE p.curso_id = ? ORDER BY p.id DESC LIMIT 20")).bind(&id).fetch_all(&app.db).await?;
    Ok(ok(json!({"publicaciones": filas.iter().map(publicacion_json).collect::<Vec<_>>()})))
}

pub async fn ver_publicacion(State(app): State<Estado>, ctx: Ctx, Path((id, pid)): Path<(String, String)>) -> Resultado {
    docente(&app, &ctx, &id).await?;
    let pid = numero(&pid).ok_or_else(ApiError::no_encontrado)?;
    let p = publicacion(&app, &id, pid).await?.ok_or_else(ApiError::no_encontrado)?;
    Ok(ok(p))
}

fn numero(s: &str) -> Option<i64> {
    if s.is_empty() || s.len() > 12 || !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    s.parse::<i64>().ok().filter(|n| *n > 0)
}

struct Pedido {
    tipo: &'static str,
    candidato: String,
    descripcion: String,
    desde: Option<i64>,
}

async fn iniciar(app: &Estado, ctx: &Ctx, id: &str, universidad: i64, turno: Turno, esp: Arc<Espacios>, p: Pedido) -> Resultado {
    let pid: i64 = sqlx::query_scalar(
        "INSERT INTO publicaciones (curso_id, tipo, estado, etapa, version, desde_version, commit_candidato, descripcion, error, registro, \
         autor_id, creada_en) VALUES (?, ?, 'en_curso', 'preparando', NULL, ?, ?, ?, NULL, '', ?, ?) RETURNING id",
    )
    .bind(id)
    .bind(p.tipo)
    .bind(p.desde)
    .bind(&p.candidato)
    .bind(&p.descripcion)
    .bind(ctx.usuario.id)
    .bind(ahora_txt())
    .fetch_one(&app.db)
    .await?;
    let tarea = Tarea {
        app: app.clone(),
        esp,
        id: id.to_string(),
        pid,
        universidad,
        autor: ctx.usuario.id,
        email: ctx.usuario.email.clone(),
        ip: ctx.ip.clone(),
        tipo: p.tipo,
        candidato: p.candidato,
        descripcion: p.descripcion,
        desde: p.desde,
        registro: String::new(),
    };
    tokio::spawn(tarea.correr(turno));
    let v = publicacion(app, id, pid).await?.ok_or_else(ApiError::no_encontrado)?;
    Ok(json_estado(StatusCode::ACCEPTED, v))
}

pub async fn publicar(State(app): State<Estado>, ctx: Ctx, Path(id): Path<String>, encabezados: HeaderMap, cuerpo: Bytes) -> Resultado {
    let curso = docente(&app, &ctx, &id).await?;
    crate::agente::exigir_en_servicio(&app, &id).await?;
    let datos = cuerpo_objeto(&encabezados, &cuerpo)?;
    let descripcion = match datos.get("descripcion") {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => {
            let s = s.trim().to_string();
            if s.chars().count() > 200 {
                return Err(ApiError::datos_invalidos());
            }
            s
        }
        Some(_) => return Err(ApiError::datos_invalidos()),
    };
    let Some(esp) = app.espacios.clone() else { return Err(ApiError::servicio_no_disponible()) };
    if curso.estado != "listo" {
        return Err(curso_no_listo());
    }
    let turno = esp.tomar(&id, Ocupacion::Publicacion).map_err(ocupado)?;
    if !cambios_sin_publicar(&app, &id).await {
        return Err(ApiError::conflicto("sin_cambios", "No hay cambios sin publicar."));
    }
    let candidato = resolver(&esp.repo_curso(&id), "refs/heads/prueba").await.ok_or_else(ApiError::servicio_no_disponible)?;
    let descripcion = if descripcion.is_empty() { descripcion_por_defecto(&app, &id).await? } else { descripcion };
    iniciar(&app, &ctx, &id, curso.universidad_id, turno, esp, Pedido { tipo: "publicar", candidato, descripcion, desde: None }).await
}

async fn descripcion_por_defecto(app: &App, id: &str) -> Result<String, sqlx::Error> {
    let desde: Option<String> =
        sqlx::query_scalar("SELECT fecha FROM versiones WHERE curso_id = ? ORDER BY numero DESC LIMIT 1").bind(id).fetch_optional(&app.db).await?;
    let pedidos: Vec<String> = sqlx::query_scalar(
        "SELECT texto FROM mensajes_agente WHERE curso_id = ? AND rol = 'profesor' AND creado_en > ? ORDER BY id",
    )
    .bind(id)
    .bind(desde.unwrap_or_default())
    .fetch_all(&app.db)
    .await?;
    let unidos = pedidos.iter().map(|p| p.split_whitespace().collect::<Vec<_>>().join(" ")).collect::<Vec<_>>().join("; ");
    let recortado: String = unidos.chars().take(200).collect();
    Ok(if recortado.trim().is_empty() { "Publicación".to_string() } else { recortado.trim().to_string() })
}

pub async fn volver(
    State(app): State<Estado>,
    ctx: Ctx,
    Path((id, n)): Path<(String, String)>,
    encabezados: HeaderMap,
    cuerpo: Bytes,
) -> Resultado {
    let curso = docente(&app, &ctx, &id).await?;
    crate::agente::exigir_en_servicio(&app, &id).await?;
    cuerpo_objeto(&encabezados, &cuerpo)?;
    let Some(esp) = app.espacios.clone() else { return Err(ApiError::servicio_no_disponible()) };
    if curso.estado != "listo" {
        return Err(curso_no_listo());
    }
    let n = numero(&n).ok_or_else(ApiError::no_encontrado)?;
    let existe: Option<String> =
        sqlx::query_scalar("SELECT commit_main FROM versiones WHERE curso_id = ? AND numero = ?").bind(&id).bind(n).fetch_optional(&app.db).await?;
    if existe.is_none() {
        return Err(ApiError::no_encontrado());
    }
    if curso.version_publicada == Some(n) {
        return Err(ApiError::conflicto("es_la_publicada", "Esa versión es la publicada."));
    }
    let turno = esp.tomar(&id, Ocupacion::Publicacion).map_err(ocupado)?;
    let repo = esp.repo_curso(&id);
    let arbol = resolver(&repo, &format!("refs/tags/v{n}^{{tree}}")).await.ok_or_else(ApiError::no_encontrado)?;
    let main = resolver(&repo, "refs/heads/main").await.ok_or_else(ApiError::servicio_no_disponible)?;
    let descripcion = format!("Vuelta a la v{n}");
    let candidato = git_texto(&repo, &["commit-tree", &arbol, "-p", &main, "-m", &descripcion]).await?;
    iniciar(&app, &ctx, &id, curso.universidad_id, turno, esp, Pedido { tipo: "volver", candidato, descripcion, desde: Some(n) }).await
}

struct Tarea {
    app: Estado,
    esp: Arc<Espacios>,
    id: String,
    pid: i64,
    universidad: i64,
    autor: i64,
    email: String,
    ip: String,
    tipo: &'static str,
    candidato: String,
    descripcion: String,
    desde: Option<i64>,
    registro: String,
}

struct Falla {
    etapa: &'static str,
    error: String,
}

fn falla(etapa: &'static str, error: impl Into<String>) -> Falla {
    Falla { etapa, error: error.into() }
}

impl Tarea {
    fn trabajo(&self) -> PathBuf {
        self.esp.base(&self.id).join(format!("publicacion-{}", self.pid))
    }

    fn agregar(&mut self, texto: &str) {
        self.registro.push_str(texto);
        if !self.registro.ends_with('\n') {
            self.registro.push('\n');
        }
        let n = self.registro.chars().count();
        if n > MAXIMO_REGISTRO * 2 {
            self.registro = self.registro.chars().skip(n - MAXIMO_REGISTRO).collect();
        }
    }

    fn registro_final(&self) -> String {
        let mut r = recortar(&self.registro, MAXIMO_REGISTRO);
        let secreto = self.app.intermediario.secreto();
        if let Some(c) = reemplazar(r.as_bytes(), secreto) {
            r = String::from_utf8_lossy(&c).to_string();
        }
        r
    }

    async fn etapa(&self, etapa: &str) {
        let _ = sqlx::query("UPDATE publicaciones SET etapa = ?, registro = ? WHERE id = ?")
            .bind(etapa)
            .bind(self.registro_final())
            .bind(self.pid)
            .execute(&self.app.db)
            .await;
    }

    fn nombre_verificacion(&self) -> String {
        format!("{}-verificacion-{}-{}", self.esp.cli.prefijo(), self.id, self.pid)
    }

    fn nombre_nuevo(&self) -> String {
        format!("{}-curso-{}-nuevo{}", self.esp.cli.prefijo(), self.id, self.pid)
    }

    async fn correr(mut self, turno: Turno) {
        let resultado = self.pasos().await;
        let nombre_nuevo = self.nombre_nuevo();
        let _ = self.esp.cursos_cli.borrar(&self.nombre_verificacion()).await;
        let dir = self.trabajo();
        if quitar(&dir).is_err() {
            self.limpiar_con_contenedor(&dir).await;
        }
        match resultado {
            Ok(version) => {
                let _ = sqlx::query(
                    "UPDATE publicaciones SET estado = 'ok', etapa = 'listo', version = ?, registro = ?, terminada_en = ? WHERE id = ?",
                )
                .bind(version)
                .bind(self.registro_final())
                .bind(ahora_txt())
                .bind(self.pid)
                .execute(&self.app.db)
                .await;
                drop(turno);
                if let Err(e) = self.esp.sincronizar(&self.id).await {
                    eprintln!("no se pudo actualizar la copia del espacio de {}: {e:#}", self.id);
                }
                eprintln!("curso {} publicado como v{version}", self.id);
            }
            Err(f) => {
                let _ = self.esp.cursos_cli.borrar(&nombre_nuevo).await;
                let error = recortar(&f.error, 4000);
                let _ = sqlx::query(
                    "UPDATE publicaciones SET estado = 'error', etapa = ?, error = ?, registro = ?, terminada_en = ? WHERE id = ?",
                )
                .bind(f.etapa)
                .bind(&error)
                .bind(self.registro_final())
                .bind(ahora_txt())
                .bind(self.pid)
                .execute(&self.app.db)
                .await;
                let _ = auditar(
                    &self.app.db,
                    Some(self.universidad),
                    Some(self.autor),
                    "publicacion_fallida",
                    &format!("Publicación fallida del curso {} por {} en la etapa {}", self.id, self.email, f.etapa),
                    Some(&self.ip),
                )
                .await;
                drop(turno);
                eprintln!("la publicación {} del curso {} falló en {}", self.pid, self.id, f.etapa);
            }
        }
    }

    async fn limpiar_con_contenedor(&self, dir: &RutaFs) {
        let montaje = format!("type=bind,source={},target=/borrar", dir.display());
        let _ = self
            .esp
            .cli
            .correr(&[
                "run",
                "--rm",
                "--network",
                "none",
                "--label",
                &format!("campusia.prefijo={}", self.esp.cli.prefijo()),
                "--mount",
                &montaje,
                "--entrypoint",
                "sh",
                &self.esp.cfg.imagen,
                "-c",
                "rm -rf /borrar/* /borrar/.[!.]* 2>/dev/null; true",
            ])
            .await;
        let _ = quitar(dir);
    }

    async fn pasos(&mut self) -> Result<i64, Falla> {
        let repo = self.esp.repo_curso(&self.id);
        let dir = self.trabajo();
        let fuente = dir.join("trabajo");
        let _ = quitar(&dir);
        std::fs::create_dir_all(&fuente).map_err(|e| falla("preparando", format!("No se pudo preparar la carpeta: {e}")))?;
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&fuente, std::fs::Permissions::from_mode(0o777));
        }
        let archivo = git(&repo, &["archive", "--format=tar", &self.candidato])
            .await
            .map_err(|e| falla("preparando", format!("No se pudo leer la versión candidata: {e:#}")))?;
        extraer(&archivo, &fuente).await.map_err(|e| falla("preparando", format!("No se pudo preparar la versión candidata: {e:#}")))?;
        if self.esp.sin_root {
            crate::repo::abrir_permisos(&fuente);
        }
        self.etapa("dependencias").await;
        self.verificar(
            "dependencias",
            "pnpm install --frozen-lockfile",
            true,
            "No se pudieron instalar las dependencias.",
        )
        .await?;
        self.etapa("pruebas").await;
        self.verificar("pruebas", "pnpm test", false, "Las pruebas del curso fallaron.").await?;
        self.etapa("tipos").await;
        self.verificar("tipos", "pnpm exec tsc --noEmit -p tsconfig.json", false, "El chequeo de tipos falló.").await?;
        self.etapa("compilacion").await;
        self.verificar("compilacion", "pnpm build", false, "La compilación falló.").await?;
        self.etapa("imagen").await;
        let imagen = self.construir().await?;
        self.etapa("arranque").await;
        let token = self.arrancar(&imagen).await?;
        self.etapa("cambio").await;
        self.cambiar(&imagen, &token).await?;
        self.cerrar_git().await
    }

    async fn verificar(&mut self, etapa: &'static str, comando: &str, red: bool, mensaje: &str) -> Result<(), Falla> {
        let nombre = self.nombre_verificacion();
        let _ = self.esp.cli.borrar(&nombre).await;
        let (memoria, cpus, pids) = self.esp.cli.limites();
        let mut args: Vec<String> = vec![
            "run".into(),
            "--rm".into(),
            "-i".into(),
            "--name".into(),
            nombre.clone(),
            "--label".into(),
            format!("campusia.prefijo={}", self.esp.cli.prefijo()),
            "--label".into(),
            format!("campusia.curso={}", self.id),
            "--label".into(),
            "campusia.tipo=verificacion".into(),
            "--network".into(),
            if red { self.esp.cli.red().to_string() } else { "none".into() },
            "--read-only".into(),
            "--cap-drop".into(),
            "ALL".into(),
            "--security-opt".into(),
            "no-new-privileges".into(),
            "--memory".into(),
            memoria.clone(),
            "--memory-swap".into(),
            memoria,
            "--cpus".into(),
            cpus,
            "--pids-limit".into(),
            pids.to_string(),
            "--tmpfs".into(),
            "/tmp:rw,exec,nosuid,nodev,size=2g,mode=1777".into(),
            "--mount".into(),
            format!("type=bind,source={},target=/trabajo", self.trabajo().join("trabajo").display()),
            "-w".into(),
            "/trabajo".into(),
            "--entrypoint".into(),
            "sh".into(),
        ];
        if let Some(u) = &self.esp.usuario {
            args.push("--user".into());
            args.push(u.clone());
        }
        let mut entorno: Vec<(String, String)> = vec![("CI".into(), "1".into()), ("HOME".into(), "/tmp/inicio".into())];
        if red {
            for k in ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"] {
                entorno.push((k.into(), self.esp.url_proxy.clone()));
            }
            entorno.push(("NO_PROXY".into(), self.esp.direccion.clone()));
            entorno.push(("no_proxy".into(), self.esp.direccion.clone()));
        }
        let mut c = self.esp.cli.comando();
        for (k, v) in &entorno {
            args.push("-e".into());
            args.push(k.clone());
            c.env(k, v);
        }
        args.push(self.esp.cfg.imagen.clone());
        args.push("-c".into());
        let previo = if red {
            "if [ ! -e node_modules ] && [ -d /opt/campusia/plantilla/node_modules ]; then cp -a /opt/campusia/plantilla/node_modules node_modules; fi; "
        } else {
            ""
        };
        args.push(format!("mkdir -p \"$HOME\" && {previo}{comando} 2>&1"));
        c.args(&args).stdin(Stdio::null());
        self.agregar(&format!("$ {comando}"));
        let limite = Duration::from_secs(self.esp.cfg.publicacion_max_seg as u64);
        let hijo = c.spawn().map_err(|e| falla(etapa, format!("No se pudo ejecutar el CLI de contenedores: {e}")))?;
        match tokio::time::timeout(limite, hijo.wait_with_output()).await {
            Ok(Ok(salida)) => {
                let mut texto = String::from_utf8_lossy(&salida.stdout).to_string();
                texto.push_str(&String::from_utf8_lossy(&salida.stderr));
                self.agregar(&texto);
                if salida.status.success() {
                    Ok(())
                } else {
                    Err(falla(etapa, mensaje))
                }
            }
            Ok(Err(e)) => Err(falla(etapa, format!("No se pudo ejecutar la verificación: {e}"))),
            Err(_) => {
                let _ = self.esp.cli.borrar(&nombre).await;
                self.agregar("La etapa superó el tiempo máximo.");
                Err(falla(etapa, format!("{mensaje} Superó el tiempo máximo.")))
            }
        }
    }

    async fn construir(&mut self) -> Result<String, Falla> {
        let corto = &self.candidato[..12];
        let imagen = format!("{}-curso-{}:{}", self.esp.cli.prefijo(), self.id, corto);
        let receta = self.trabajo().join("receta");
        let preparar = || -> std::io::Result<()> {
            use std::os::unix::fs::PermissionsExt;
            std::fs::create_dir_all(&receta)?;
            std::fs::set_permissions(&receta, std::fs::Permissions::from_mode(0o755))?;
            let archivo = receta.join(ARCHIVO_RECETA);
            std::fs::write(&archivo, RECETA_IMAGEN)?;
            std::fs::set_permissions(&archivo, std::fs::Permissions::from_mode(0o644))
        };
        if let Err(e) = preparar() {
            return Err(falla("imagen", format!("No se pudo preparar la construcción de la imagen: {e}")));
        }
        let limite = Duration::from_secs(self.app.cfg.construccion_max_seg as u64);
        let id = self.id.clone();
        let r = {
            let tarea: &Tarea = self;
            crate::supervisor::con_reintentos("La construcción", &id, |_| tarea.construir_una_vez(&imagen, limite)).await
        };
        match r {
            Ok(salida) => {
                self.agregar(&salida);
                Ok(imagen)
            }
            Err(e) => {
                self.agregar(&format!("{e:#}"));
                Err(falla("imagen", "No se pudo construir la imagen del curso."))
            }
        }
    }

    async fn construir_una_vez(&self, imagen: &str, limite: Duration) -> anyhow::Result<String> {
        let (memoria, cpus, pids) = self.esp.cli.limites();
        let nombre = format!("{}-empaque-{}-{}", self.esp.cli.prefijo(), self.id, self.pid);
        let _ = self.esp.cli.borrar(&nombre).await;
        let mut args: Vec<String> = vec![
            "run".into(),
            "--rm".into(),
            "--name".into(),
            nombre.clone(),
            "--label".into(),
            format!("campusia.prefijo={}", self.esp.cli.prefijo()),
            "--label".into(),
            format!("campusia.curso={}", self.id),
            "--label".into(),
            "campusia.tipo=verificacion".into(),
            "--network".into(),
            "none".into(),
            "--read-only".into(),
            "--cap-drop".into(),
            "ALL".into(),
            "--security-opt".into(),
            "no-new-privileges".into(),
            "--memory".into(),
            memoria.clone(),
            "--memory-swap".into(),
            memoria,
            "--cpus".into(),
            cpus,
            "--pids-limit".into(),
            pids.to_string(),
            "--mount".into(),
            format!("type=bind,source={},target=/trabajo,readonly", self.trabajo().join("trabajo").display()),
            "--mount".into(),
            format!("type=bind,source={},target=/receta,readonly", self.trabajo().join("receta").display()),
            "--entrypoint".into(),
            "tar".into(),
        ];
        if let Some(u) = &self.esp.usuario {
            args.push("--user".into());
            args.push(u.clone());
        }
        args.push(self.esp.cfg.imagen.clone());
        for a in ["-c", "-f", "-", "-C", "/receta", ARCHIVO_RECETA, "-C", "/trabajo", "package.json", "dist", "node_modules"] {
            args.push(a.into());
        }
        let mut empaque = self.esp.cli.comando();
        empaque.args(&args);
        let mut hijo_empaque = empaque.spawn().map_err(|e| anyhow::anyhow!("no se pudo ejecutar el CLI de contenedores: {e}"))?;
        let salida_empaque = hijo_empaque.stdout.take().ok_or_else(|| anyhow::anyhow!("sin salida del empaque"))?;
        let entrada: Stdio = salida_empaque.try_into().map_err(|e| anyhow::anyhow!("no se pudo unir el empaque con la construcción: {e}"))?;
        let mut construccion = self.esp.cursos_cli.comando();
        construccion.args([
            "build",
            "--network",
            "none",
            "-t",
            imagen,
            "--label",
            &format!("campusia.prefijo={}", self.esp.cli.prefijo()),
            "--label",
            &format!("campusia.curso={}", self.id),
            "-f",
            ARCHIVO_RECETA,
            "-",
        ]);
        construccion.stdin(entrada);
        let hijo_construccion = construccion.spawn().map_err(|e| anyhow::anyhow!("no se pudo ejecutar el CLI de contenedores: {e}"))?;
        let resultado = tokio::time::timeout(limite, async {
            let (a, b) = tokio::join!(hijo_empaque.wait_with_output(), hijo_construccion.wait_with_output());
            (a, b)
        })
        .await;
        let Ok((empaque, construccion)) = resultado else {
            let _ = self.esp.cli.borrar(&nombre).await;
            anyhow::bail!("La construcción de la imagen superó el tiempo máximo");
        };
        let empaque = empaque?;
        let construccion = construccion?;
        if !empaque.status.success() {
            anyhow::bail!("No se pudieron reunir los archivos compilados del curso: {}", recortar(&String::from_utf8_lossy(&empaque.stderr), 2000));
        }
        let mut texto = String::from_utf8_lossy(&construccion.stdout).to_string();
        texto.push_str(&String::from_utf8_lossy(&construccion.stderr));
        if !construccion.status.success() {
            anyhow::bail!("La construcción de la imagen falló: {}", recortar(&texto, 2000));
        }
        Ok(recortar(&texto, 2000))
    }

    async fn arrancar(&mut self, imagen: &str) -> Result<String, Falla> {
        let nombre = self.nombre_nuevo();
        let datos = self.esp.raiz_cursos.join(&self.id).join("datos");
        let _ = std::fs::create_dir_all(&datos);
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&datos, std::fs::Permissions::from_mode(0o777));
        }
        let token = format!("cct_{}", token_aleatorio());
        let espec = EspecContenedor {
            nombre: nombre.clone(),
            imagen: imagen.to_string(),
            curso: self.id.clone(),
            datos: datos.to_string_lossy().to_string(),
            entorno: vec![
                ("PORT".into(), "3000".into()),
                ("CAMPUSIA_CURSO".into(), self.id.clone()),
                ("CAMPUSIA_CLAVE_PUBLICA".into(), self.esp.publica.clone()),
                ("CAMPUSIA_API".into(), self.esp.supervisor.url_api.clone()),
                ("CAMPUSIA_TOKEN_CURSO".into(), token.clone()),
                ("CAMPUSIA_DATOS".into(), "/datos".into()),
            ],
        };
        let cli = &self.esp.cursos_cli;
        let id = self.id.clone();
        let r = crate::supervisor::con_reintentos("El arranque", &id, |n| {
            let espec = &espec;
            let nombre = &nombre;
            async move {
                if n > 0 {
                    cli.borrar(nombre).await?;
                }
                cli.crear(espec).await?;
                cli.arrancar(nombre).await
            }
        })
        .await;
        if let Err(e) = r {
            self.agregar(&format!("{e:#}"));
            return Err(falla("arranque", "No se pudo crear el contenedor de la versión nueva."));
        }
        let limite = Instant::now() + Duration::from_secs(self.app.cfg.arranque_curso_seg as u64);
        let mut ip: Option<IpAddr> = None;
        loop {
            match cli.inspeccionar(&nombre).await {
                Ok(Some(i)) if i.corriendo => {
                    if i.ip.is_some() {
                        ip = i.ip;
                    }
                }
                Ok(_) => {
                    self.registros_contenedor(&nombre).await;
                    return Err(falla("arranque", "La versión nueva se detuvo al arrancar."));
                }
                Err(_) => {}
            }
            if let Some(ip) = ip {
                if self.esp.supervisor.salud(ip).await {
                    return Ok(token);
                }
            }
            if Instant::now() >= limite {
                self.registros_contenedor(&nombre).await;
                return Err(falla("arranque", "La versión nueva no respondió /salud a tiempo."));
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    }

    async fn registros_contenedor(&mut self, nombre: &str) {
        if let Ok(s) = self.esp.cursos_cli.correr(&["logs", "--tail", "100", nombre]).await {
            let mut t = s.stdout;
            t.push_str(&s.stderr);
            if !t.trim().is_empty() {
                self.agregar(&t);
            }
        }
    }

    async fn cambiar(&mut self, imagen: &str, token: &str) -> Result<(), Falla> {
        let sup = self.esp.supervisor.clone();
        let cerrojo = sup.cerrojo(&self.id);
        let _g = cerrojo.lock().await;
        let nombre = nombre_contenedor(self.esp.cli.prefijo(), &self.id);
        let nuevo = self.nombre_nuevo();
        if let Err(e) = self.esp.cursos_cli.borrar(&nombre).await {
            self.agregar(&format!("{e:#}"));
            return Err(falla("cambio", "No se pudo retirar la versión anterior."));
        }
        if let Err(e) = self.esp.cursos_cli.renombrar(&nuevo, &nombre).await {
            self.agregar(&format!("{e:#}"));
            return Err(falla("cambio", "No se pudo pasar el tráfico a la versión nueva."));
        }
        let r = sqlx::query(
            "UPDATE contenedores SET nombre = ?, imagen = ?, commit_main = ?, token_huella = ?, estado = 'encendido', error = NULL, \
             actualizado_en = ? WHERE curso_id = ?",
        )
        .bind(&nombre)
        .bind(imagen)
        .bind(&self.candidato[..12])
        .bind(huella(&self.esp.secreto, token))
        .bind(ahora_txt())
        .bind(&self.id)
        .execute(&self.app.db)
        .await;
        sup.invalidar(&self.id);
        if let Err(e) = r {
            return Err(falla("cambio", format!("No se pudo registrar el contenedor nuevo: {e}")));
        }
        Ok(())
    }

    async fn cerrar_git(&mut self) -> Result<i64, Falla> {
        let cerrojo = self.esp.cerrojo_git(&self.id);
        let _g = cerrojo.lock().await;
        let repo = self.esp.repo_curso(&self.id);
        let ultima: Option<i64> =
            sqlx::query_scalar("SELECT MAX(numero) FROM versiones WHERE curso_id = ?").bind(&self.id).fetch_one(&self.app.db).await.unwrap_or(None);
        let version = ultima.unwrap_or(0) + 1;
        let etiqueta = format!("v{version}");
        let pasos: Vec<Vec<String>> = vec![
            vec!["tag".into(), "-a".into(), "-f".into(), etiqueta.clone(), "-m".into(), self.descripcion.clone(), self.candidato.clone()],
            vec!["reset".into(), "-q".into(), "--hard".into(), self.candidato.clone()],
            vec!["branch".into(), "-f".into(), "prueba".into(), self.candidato.clone()],
        ];
        for p in pasos {
            let args: Vec<&str> = p.iter().map(String::as_str).collect();
            if let Err(e) = git(&repo, &args).await {
                self.agregar(&format!("{e:#}"));
                return Err(falla("cambio", "No se pudo registrar la versión en el repositorio."));
            }
        }
        let imagen = format!("{}-curso-{}:{}", self.esp.cli.prefijo(), self.id, &self.candidato[..12]);
        let ahora = ahora_txt();
        let (accion, detalle) = match self.tipo {
            "volver" => (
                "version_restaurada",
                format!(
                    "Vuelta a la v{} del curso {} publicada como v{version} por {}",
                    self.desde.unwrap_or(0),
                    self.id,
                    self.email
                ),
            ),
            _ => ("publicacion", format!("Publicación de la v{version} del curso {} por {}", self.id, self.email)),
        };
        let r = async {
            let mut tx = self.app.db.begin().await?;
            sqlx::query("UPDATE cursos SET version_publicada = ? WHERE id = ?").bind(version).bind(&self.id).execute(&mut *tx).await?;
            sqlx::query(
                "INSERT INTO versiones (curso_id, numero, commit_main, descripcion, autor_id, origen, imagen, fecha) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&self.id)
            .bind(version)
            .bind(&self.candidato)
            .bind(&self.descripcion)
            .bind(self.autor)
            .bind(self.desde)
            .bind(&imagen)
            .bind(&ahora)
            .execute(&mut *tx)
            .await?;
            auditar(&mut *tx, Some(self.universidad), Some(self.autor), accion, &detalle, Some(&self.ip)).await?;
            tx.commit().await
        }
        .await;
        if let Err(e) = r {
            return Err(falla("cambio", format!("No se pudo registrar la versión: {e}")));
        }
        Ok(version)
    }
}

async fn extraer(archivo: &[u8], destino: &RutaFs) -> anyhow::Result<()> {
    let mut c = tokio::process::Command::new("tar");
    c.kill_on_drop(true)
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .args(["-x", "--no-same-owner", "--no-same-permissions", "-C"])
        .arg(destino)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let mut hijo = c.spawn()?;
    let datos = archivo.to_vec();
    let mut entrada = hijo.stdin.take().ok_or_else(|| anyhow::anyhow!("sin entrada para tar"))?;
    let escritura = tokio::spawn(async move {
        let r = entrada.write_all(&datos).await;
        drop(entrada);
        r
    });
    let r = hijo.wait_with_output().await?;
    let _ = escritura.await;
    if !r.status.success() {
        anyhow::bail!("tar falló: {}", String::from_utf8_lossy(&r.stderr).trim());
    }
    Ok(())
}
