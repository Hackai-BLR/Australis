use std::collections::HashMap;
use std::net::IpAddr;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex as MutexSync};
use std::time::{Duration, Instant};

use serde_json::Value;
use sqlx::sqlite::SqlitePool;
use sqlx::Row;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::Mutex;

use crate::agente_config::ConfigAgente;
use crate::auth::App;
use crate::config::{Config, ConfigContenedores, Red};
use crate::contenedores::{EscuchaApi, ProveedorCli, ProveedorDeContenedores};
use crate::repo::{abrir_permisos, git, git_ok, git_texto, quitar, resolver, Lugar};
use crate::supervisor::Supervisor;
use crate::util::*;

pub const PROTEGIDAS: [&str; 7] = ["vendor", "Containerfile", ".containerignore", ".dockerignore", ".gitignore", "CLAUDE.md", ".claude"];
const VALIDEZ_CACHE: Duration = Duration::from_secs(3);

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Ocupacion {
    Agente,
    Publicacion,
}

pub struct Turno {
    esp: Arc<Espacios>,
    id: String,
}

impl Drop for Turno {
    fn drop(&mut self) {
        self.esp.ocupacion.lock().unwrap().remove(&self.id);
    }
}

pub struct Activo {
    esp: Arc<Espacios>,
    id: String,
}

impl Drop for Activo {
    fn drop(&mut self) {
        let mut a = self.esp.activos.lock().unwrap();
        if let Some(n) = a.get_mut(&self.id) {
            *n = n.saturating_sub(1);
            if *n == 0 {
                a.remove(&self.id);
            }
        }
        self.esp.ultima.lock().unwrap().insert(self.id.clone(), Instant::now());
    }
}

#[derive(Clone, Debug, Default)]
struct Imagen {
    home: Option<String>,
}

pub struct Espacios {
    pub cfg: ConfigAgente,
    pub cli: ProveedorCli,
    pub cursos_cli: ProveedorCli,
    pub db: SqlitePool,
    pub secreto: Vec<u8>,
    pub publica: String,
    pub url_espacios: String,
    pub url_proxy: String,
    pub direccion: String,
    pub sin_root: bool,
    pub usuario: Option<String>,
    pub http: reqwest::Client,
    pub proxy_http: reqwest::Client,
    pub supervisor: Arc<Supervisor>,
    pub raiz_cursos: PathBuf,
    pub revision: Duration,
    cerrojos: MutexSync<HashMap<String, Arc<Mutex<()>>>>,
    cerrojos_git: MutexSync<HashMap<String, Arc<Mutex<()>>>>,
    cache: MutexSync<HashMap<String, (IpAddr, Instant, u64)>>,
    generaciones: MutexSync<HashMap<String, u64>>,
    listos: MutexSync<HashMap<String, u64>>,
    vigilados: MutexSync<HashMap<String, u64>>,
    ultima: MutexSync<HashMap<String, Instant>>,
    activos: MutexSync<HashMap<String, usize>>,
    ocupacion: MutexSync<HashMap<String, Ocupacion>>,
    imagen: MutexSync<Option<(String, Imagen)>>,
    sesiones: MutexSync<HashMap<String, u64>>,
}

pub struct Preparado {
    pub espacios: Arc<Espacios>,
    escucha: EscuchaApi,
    proxy: EscuchaApi,
    subred: Option<Red>,
}

pub fn nombre_espacio(prefijo: &str, id: &str) -> String {
    format!("{prefijo}-espacio-{id}")
}

pub async fn preparar(cfg: &Config, cc: &ConfigContenedores, db: SqlitePool, publica: String, supervisor: Arc<Supervisor>) -> anyhow::Result<Preparado> {
    let a = cfg.agente.clone();
    let base = ProveedorCli::nuevo(cc);
    let cli = base.derivado(&a.red_espacios, a.puerto_espacios, a.direccion_espacios.clone(), a.url_espacios.clone(), "espacios", &a.memoria, &a.cpus, a.pids);
    let red = cli
        .preparar_red()
        .await
        .map_err(|e| anyhow::anyhow!("No se pudo preparar la red de los espacios {}: {e:#}", a.red_espacios))?;
    let acceso = cli
        .abrir_acceso(&red)
        .await
        .map_err(|e| anyhow::anyhow!("No se pudo abrir la escucha de los espacios: {e:#}"))?;
    let direccion = match (&a.direccion_espacios, red.puerta) {
        (Some(d), _) => d.clone(),
        (None, Some(p)) => p.to_string(),
        (None, None) => anyhow::bail!("La red {} no tiene puerta de enlace: definí DIRECCION_ESPACIOS", a.red_espacios),
    };
    let proxy_cli = base.derivado(&a.red_espacios, a.puerto_proxy, Some(direccion.clone()), None, "proxy", &a.memoria, &a.cpus, a.pids);
    let acceso_proxy = proxy_cli
        .abrir_acceso(&red)
        .await
        .map_err(|e| anyhow::anyhow!("No se pudo abrir el proxy de salida: {e:#}"))?;
    eprintln!("escucha de espacios en {}", acceso.descripcion);
    eprintln!("proxy de salida en {}", acceso_proxy.descripcion);
    let sin_root = cli.sin_root().await.unwrap_or(false);
    let uid = unsafe { libc::getuid() };
    let gid = unsafe { libc::getgid() };
    let usuario = if !sin_root && uid != 0 { Some(format!("{uid}:{gid}")) } else { None };
    let mut b = reqwest::Client::builder();
    let mut b2 = reqwest::Client::builder();
    if let Some(s) = &acceso.socket_cursos {
        b = b.unix_socket(s.clone());
        b2 = b2.unix_socket(s.clone());
    }
    let http = b
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(2))
        .timeout(Duration::from_secs(3))
        .build()?;
    let proxy_http = b2
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(300))
        .build()?;
    match std::fs::create_dir_all(&a.raiz_espacios) {
        Ok(()) => {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&a.raiz_espacios, std::fs::Permissions::from_mode(0o700));
        }
        Err(e) => eprintln!("todavía no se puede usar RAIZ_ESPACIOS {}: {e}", a.raiz_espacios.display()),
    }
    let subred = red.subred.as_deref().and_then(Red::leer);
    let url_proxy = format!("http://{}", std::net::SocketAddr::new(direccion.parse()?, a.puerto_proxy));
    let espacios = Arc::new(Espacios {
        url_espacios: acceso.url_api.trim_end_matches('/').to_string(),
        url_proxy,
        direccion,
        cfg: a,
        cli,
        cursos_cli: base,
        db,
        secreto: cfg.session_secret.clone(),
        publica,
        sin_root,
        usuario,
        http,
        proxy_http,
        supervisor,
        raiz_cursos: cc.raiz_cursos.clone(),
        revision: Duration::from_secs(cfg.revision_inactividad_seg as u64),
        cerrojos: MutexSync::new(HashMap::new()),
        cerrojos_git: MutexSync::new(HashMap::new()),
        cache: MutexSync::new(HashMap::new()),
        generaciones: MutexSync::new(HashMap::new()),
        listos: MutexSync::new(HashMap::new()),
        vigilados: MutexSync::new(HashMap::new()),
        ultima: MutexSync::new(HashMap::new()),
        activos: MutexSync::new(HashMap::new()),
        ocupacion: MutexSync::new(HashMap::new()),
        imagen: MutexSync::new(None),
        sesiones: MutexSync::new(HashMap::new()),
    });
    espacios.al_arrancar().await?;
    Ok(Preparado { espacios, escucha: acceso.escucha, proxy: acceso_proxy.escucha, subred })
}

pub fn lanzar(app: Arc<App>, p: Preparado) {
    let rutas = crate::modelo::router(app.clone());
    tokio::spawn(async move {
        let r = match p.escucha {
            EscuchaApi::Tcp(l) => axum::serve(l, rutas.into_make_service()).await,
            EscuchaApi::Unix(l) => axum::serve(l, rutas.into_make_service()).await,
        };
        if let Err(e) = r {
            eprintln!("la escucha de espacios se detuvo: {e}");
        }
    });
    let proxy = Arc::new(crate::proxy_salida::ProxySalida::nuevo(p.espacios.cfg.salida_permitida.clone(), p.subred.clone()));
    tokio::spawn(proxy.servir(p.proxy));
    tokio::spawn(p.espacios.clone().vigilar_inactividad());
}

impl Espacios {
    pub fn nombre(&self, id: &str) -> String {
        nombre_espacio(self.cli.prefijo(), id)
    }

    pub fn base(&self, id: &str) -> PathBuf {
        self.cfg.raiz_espacios.join(id)
    }

    pub fn trabajo(&self, id: &str) -> PathBuf {
        self.base(id).join("repo")
    }

    pub fn datos(&self, id: &str) -> PathBuf {
        self.base(id).join("datos")
    }

    pub fn gitdir(&self, id: &str) -> PathBuf {
        self.base(id).join("git")
    }

    pub fn copia(&self, id: &str) -> Lugar {
        Lugar::Separado { git: self.gitdir(id), trabajo: self.trabajo(id) }
    }

    pub fn repo_curso(&self, id: &str) -> Lugar {
        Lugar::Repo(self.raiz_cursos.join(id))
    }

    fn cerrojo(&self, id: &str) -> Arc<Mutex<()>> {
        self.cerrojos.lock().unwrap().entry(id.to_string()).or_default().clone()
    }

    pub fn cerrojo_git(&self, id: &str) -> Arc<Mutex<()>> {
        self.cerrojos_git.lock().unwrap().entry(id.to_string()).or_default().clone()
    }

    fn generacion(&self, id: &str) -> u64 {
        self.generaciones.lock().unwrap().get(id).copied().unwrap_or(0)
    }

    fn nueva_generacion(&self, id: &str) -> u64 {
        let mut g = self.generaciones.lock().unwrap();
        let n = g.entry(id.to_string()).or_insert(0);
        *n += 1;
        self.cache.lock().unwrap().remove(id);
        *n
    }

    pub fn olvidar(&self, id: &str) {
        self.cache.lock().unwrap().remove(id);
    }

    fn cache_valida(&self, id: &str) -> Option<IpAddr> {
        let g = self.generacion(id);
        let c = self.cache.lock().unwrap();
        let (ip, cuando, gen) = c.get(id)?;
        if *gen == g && cuando.elapsed() < VALIDEZ_CACHE {
            Some(*ip)
        } else {
            None
        }
    }

    pub fn listo(&self, id: &str) -> bool {
        self.listos.lock().unwrap().get(id).copied() == Some(self.generacion(id))
    }

    pub fn tocar(&self, id: &str) {
        self.ultima.lock().unwrap().insert(id.to_string(), Instant::now());
    }

    pub fn activo(self: &Arc<Self>, id: &str) -> Activo {
        *self.activos.lock().unwrap().entry(id.to_string()).or_insert(0) += 1;
        self.tocar(id);
        Activo { esp: self.clone(), id: id.to_string() }
    }

    pub fn ocupado(&self, id: &str) -> Option<Ocupacion> {
        self.ocupacion.lock().unwrap().get(id).copied()
    }

    pub fn tomar(self: &Arc<Self>, id: &str, o: Ocupacion) -> Result<Turno, Ocupacion> {
        let mut m = self.ocupacion.lock().unwrap();
        if let Some(actual) = m.get(id) {
            return Err(*actual);
        }
        m.insert(id.to_string(), o);
        Ok(Turno { esp: self.clone(), id: id.to_string() })
    }

    pub async fn estado(&self, id: &str) -> Result<(String, Option<String>), sqlx::Error> {
        let f: Option<(String, Option<String>)> =
            sqlx::query_as("SELECT estado, error FROM espacios WHERE curso_id = ?").bind(id).fetch_optional(&self.db).await?;
        Ok(f.unwrap_or_else(|| ("ninguno".to_string(), None)))
    }

    pub async fn guardar_estado(&self, id: &str, estado: &str, error: Option<&str>) {
        let r = sqlx::query("UPDATE espacios SET estado = ?, error = ?, actualizado_en = ? WHERE curso_id = ?")
            .bind(estado)
            .bind(error)
            .bind(ahora_txt())
            .bind(id)
            .execute(&self.db)
            .await;
        if let Err(e) = r {
            eprintln!("no se pudo guardar el estado del espacio de {id}: {e}");
        }
    }

    async fn al_arrancar(self: &Arc<Self>) -> anyhow::Result<()> {
        let ahora = ahora_txt();
        sqlx::query(
            "UPDATE mensajes_agente SET estado = 'error', texto = CASE WHEN texto = '' THEN 'La ejecución se interrumpió.' ELSE texto END, \
             terminado_en = ? WHERE estado = 'en_curso'",
        )
        .bind(&ahora)
        .execute(&self.db)
        .await?;
        sqlx::query(
            "UPDATE publicaciones SET estado = 'error', error = 'La publicación se interrumpió.', terminada_en = ? WHERE estado = 'en_curso'",
        )
        .bind(&ahora)
        .execute(&self.db)
        .await?;
        let filas = sqlx::query("SELECT curso_id, estado FROM espacios").fetch_all(&self.db).await?;
        for f in filas {
            let id: String = f.get("curso_id");
            let estado: String = f.get("estado");
            let info = self.cli.inspeccionar(&self.nombre(&id)).await.unwrap_or(None);
            match info {
                Some(i) if i.corriendo => {
                    self.tocar(&id);
                    self.guardar_estado(&id, "encendiendo", None).await;
                    if let Some(ip) = i.ip {
                        let g = self.generacion(&id);
                        tokio::spawn(self.clone().vigilar_salud(id.clone(), ip, g));
                    }
                }
                _ if estado != "error" => self.guardar_estado(&id, "apagado", None).await,
                _ => {}
            }
        }
        let sobrantes = self
            .cli
            .correr(&[
                "ps",
                "-aq",
                "--filter",
                &format!("label=campusia.prefijo={}", self.cli.prefijo()),
                "--filter",
                "label=campusia.tipo=verificacion",
            ])
            .await;
        if let Ok(s) = sobrantes {
            for c in s.stdout.split_whitespace() {
                let _ = self.cli.correr(&["rm", "-f", c]).await;
            }
        }
        Ok(())
    }

    pub async fn revisar_fuera_de_servicio(&self) {
        let ids: Vec<String> = match sqlx::query_scalar(&format!(
            "SELECT e.curso_id FROM espacios e JOIN cursos c ON c.id = e.curso_id WHERE {}",
            crate::inhabilitar::SQL_FUERA_DE_SERVICIO
        ))
        .fetch_all(&self.db)
        .await
        {
            Ok(v) => v,
            Err(e) => {
                eprintln!("no se pudieron revisar los espacios fuera de servicio: {e}");
                return;
            }
        };
        for id in ids {
            let nombre = self.nombre(&id);
            let corriendo = matches!(self.cli.inspeccionar(&nombre).await, Ok(Some(i)) if i.corriendo);
            if !corriendo {
                continue;
            }
            let cerrojo = self.cerrojo(&id);
            let _g = cerrojo.lock().await;
            self.nueva_generacion(&id);
            match self.cli.detener(&nombre).await {
                Ok(()) => {
                    self.ultima.lock().unwrap().remove(&id);
                    self.guardar_estado(&id, "apagado", None).await;
                    eprintln!("espacio de {id} detenido por estar fuera de servicio");
                }
                Err(e) => eprintln!("no se pudo detener el espacio de {id}: {e:#}"),
            }
        }
    }

    async fn vigilar_inactividad(self: Arc<Self>) {
        let mut intervalo = tokio::time::interval(self.revision);
        intervalo.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let limite = Duration::from_secs(self.cfg.inactividad_seg as u64);
        loop {
            intervalo.tick().await;
            self.revisar_fuera_de_servicio().await;
            let candidatos: Vec<(String, Instant)> = self.ultima.lock().unwrap().iter().map(|(k, v)| (k.clone(), *v)).collect();
            for (id, cuando) in candidatos {
                let _ = sqlx::query("UPDATE espacios SET ultima_actividad = ? WHERE curso_id = ?")
                    .bind(fecha(ahora() - chrono::Duration::from_std(cuando.elapsed()).unwrap_or_default()))
                    .bind(&id)
                    .execute(&self.db)
                    .await;
                if cuando.elapsed() < limite {
                    continue;
                }
                let cerrojo = self.cerrojo(&id);
                let Ok(_g) = cerrojo.try_lock() else { continue };
                let vigente = self.ultima.lock().unwrap().get(&id).copied();
                let ocupado = self.activos.lock().unwrap().get(&id).copied().unwrap_or(0) > 0 || self.ocupado(&id) == Some(Ocupacion::Agente);
                if ocupado || vigente.map(|v| v.elapsed() < limite).unwrap_or(false) {
                    continue;
                }
                self.nueva_generacion(&id);
                match self.cli.detener(&self.nombre(&id)).await {
                    Ok(()) => {
                        self.ultima.lock().unwrap().remove(&id);
                        self.guardar_estado(&id, "apagado", None).await;
                        eprintln!("espacio de {id} apagado por inactividad");
                    }
                    Err(e) => eprintln!("no se pudo apagar el espacio de {id}: {e:#}"),
                }
            }
        }
    }

    async fn info_imagen(&self) -> Imagen {
        if let Some((nombre, i)) = self.imagen.lock().unwrap().clone() {
            if nombre == self.cfg.imagen {
                return i;
            }
        }
        let mut i = Imagen::default();
        if let Ok(s) = self.cli.correr(&["image", "inspect", "--format", "{{json .Config}}", &self.cfg.imagen]).await {
            if s.exito {
                if let Ok(v) = serde_json::from_str::<Value>(s.stdout.trim()) {
                    for e in v.get("Env").and_then(Value::as_array).into_iter().flatten() {
                        if let Some(h) = e.as_str().and_then(|e| e.strip_prefix("HOME=")) {
                            i.home = Some(h.to_string());
                        }
                    }
                }
                *self.imagen.lock().unwrap() = Some((self.cfg.imagen.clone(), i.clone()));
            }
        }
        i
    }

    pub async fn preparar_copia(&self, id: &str) -> anyhow::Result<()> {
        let cerrojo = self.cerrojo_git(id);
        let _g = cerrojo.lock().await;
        let gitdir = self.gitdir(id);
        let trabajo = self.trabajo(id);
        let datos = self.datos(id);
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::create_dir_all(&datos)?;
            std::fs::set_permissions(&datos, std::fs::Permissions::from_mode(0o777))?;
        }
        let solo = Lugar::SoloGit(gitdir.clone());
        if gitdir.join("HEAD").is_file() && trabajo.is_dir() && resolver(&solo, "refs/heads/prueba").await.is_some() {
            return Ok(());
        }
        let _ = quitar(&gitdir);
        std::fs::create_dir_all(&trabajo)?;
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&trabajo, std::fs::Permissions::from_mode(0o777))?;
        }
        git(&Lugar::Repo(self.base(id)), &["init", "-q", "--bare", "git"]).await?;
        git(&solo, &["config", "core.bare", "false"]).await?;
        git(&solo, &["symbolic-ref", "HEAD", "refs/heads/prueba"]).await?;
        let origen = self.raiz_cursos.join(id).to_string_lossy().to_string();
        git(&solo, &["fetch", "-q", "--no-tags", "--update-head-ok", &origen, "+refs/heads/prueba:refs/heads/prueba"]).await?;
        let copia = self.copia(id);
        git(&copia, &["reset", "-q", "--hard", "refs/heads/prueba"]).await?;
        let _ = quitar(&trabajo.join(".git"));
        if self.sin_root {
            abrir_permisos(&trabajo);
        }
        Ok(())
    }

    pub async fn sincronizar(&self, id: &str) -> anyhow::Result<()> {
        if !self.gitdir(id).join("HEAD").is_file() {
            return Ok(());
        }
        let cerrojo = self.cerrojo_git(id);
        let _g = cerrojo.lock().await;
        self.permisos_en_contenedor(id).await;
        let solo = Lugar::SoloGit(self.gitdir(id));
        let origen = self.raiz_cursos.join(id).to_string_lossy().to_string();
        git(&solo, &["fetch", "-q", "--no-tags", "--update-head-ok", &origen, "+refs/heads/prueba:refs/heads/prueba"]).await?;
        let trabajo = self.trabajo(id);
        let _ = quitar(&trabajo.join(".git"));
        let copia = self.copia(id);
        git(&copia, &["reset", "-q", "--hard", "refs/heads/prueba"]).await?;
        git(&copia, &["clean", "-q", "-fd"]).await?;
        if self.sin_root {
            abrir_permisos(&trabajo);
        }
        Ok(())
    }

    pub async fn permisos_en_contenedor(&self, id: &str) {
        if !self.sin_root {
            return;
        }
        let nombre = self.nombre(id);
        if let Ok(Some(i)) = self.cli.inspeccionar(&nombre).await {
            if i.corriendo {
                let exec = ["exec", "-e", "ANTHROPIC_AUTH_TOKEN=", "-e", "CAMPUSIA_TOKEN_CURSO=", &nombre, "sh", "-c", "chmod -R a+rwX /repo /datos 2>/dev/null; true"];
                let _ = self.cli.correr(&exec).await;
            }
        }
    }

    pub async fn guardar_cambios(&self, id: &str, mensaje: &str) -> anyhow::Result<(Option<String>, Vec<(String, String)>)> {
        let cerrojo = self.cerrojo_git(id);
        let _g = cerrojo.lock().await;
        self.permisos_en_contenedor(id).await;
        let trabajo = self.trabajo(id);
        let copia = self.copia(id);
        let _ = quitar(&trabajo.join(".git"));
        for p in PROTEGIDAS {
            quitar(&trabajo.join(p))?;
            let enlistado = git_texto(&copia, &["ls-tree", "--name-only", "HEAD", "--", p]).await.unwrap_or_default();
            if !enlistado.is_empty() {
                git(&copia, &["checkout", "-q", "HEAD", "--", p]).await?;
            }
        }
        git(&copia, &["add", "-A"]).await?;
        let mut sacar: Vec<String> = Vec::new();
        let indice = git(&copia, &["diff", "--cached", "--name-only", "-z", "--no-renames", "HEAD"]).await?;
        for r in indice.split(|b| *b == 0).filter(|r| !r.is_empty()) {
            let r = String::from_utf8_lossy(r).to_string();
            let protegida = PROTEGIDAS.iter().any(|p| r == *p || r.starts_with(&format!("{p}/")));
            if protegida || r.split('/').any(|c| c == ".git") {
                sacar.push(r);
            }
        }
        for r in &sacar {
            git(&copia, &["rm", "-q", "--cached", "--ignore-unmatch", "--", r]).await?;
            if resolver(&copia, &format!("HEAD:{r}")).await.is_some() {
                git(&copia, &["reset", "-q", "HEAD", "--", r]).await?;
            }
        }
        if git_ok(&copia, &["diff", "--cached", "--quiet", "HEAD"]).await {
            return Ok((None, Vec::new()));
        }
        let mut msj = mensaje.chars().filter(|c| !c.is_control() || *c == '\n').take(500).collect::<String>();
        if msj.trim().is_empty() {
            msj = "Cambios del agente".to_string();
        }
        git(&copia, &["commit", "-q", "--no-verify", "--allow-empty-message", "-m", &msj]).await?;
        let sha = git_texto(&copia, &["rev-parse", "HEAD"]).await?;
        let cambios = git(&copia, &["diff-tree", "-r", "-z", "--no-commit-id", "--name-status", "--no-renames", "HEAD~1", "HEAD"]).await?;
        let partes: Vec<String> =
            cambios.split(|b| *b == 0).filter(|p| !p.is_empty()).map(|p| String::from_utf8_lossy(p).to_string()).collect();
        let mut archivos = Vec::new();
        let mut i = 0;
        while i + 1 < partes.len() {
            let cambio = match partes[i].chars().next() {
                Some('A') => "agregado",
                Some('D') => "borrado",
                _ => "modificado",
            };
            archivos.push((partes[i + 1].clone(), cambio.to_string()));
            i += 2;
        }
        archivos.sort();
        let gitdir = self.gitdir(id).to_string_lossy().to_string();
        git(&self.repo_curso(id), &["fetch", "-q", "--no-tags", &gitdir, "+refs/heads/prueba:refs/heads/prueba"]).await?;
        if self.sin_root {
            abrir_permisos(&trabajo);
        }
        Ok((Some(sha), archivos))
    }

    async fn crear_contenedor(&self, id: &str) -> anyhow::Result<()> {
        let nombre = self.nombre(id);
        self.cli.borrar(&nombre).await?;
        let modelo = format!("cmt_{}", token_aleatorio());
        let curso = format!("cct_{}", token_aleatorio());
        let ahora = ahora_txt();
        sqlx::query(
            "INSERT INTO espacios (curso_id, nombre, estado, token_modelo_huella, token_curso_huella, ultima_actividad, error, creado_en, actualizado_en) \
             VALUES (?, ?, 'encendiendo', ?, ?, ?, NULL, ?, ?) ON CONFLICT(curso_id) DO UPDATE SET nombre = excluded.nombre, \
             estado = 'encendiendo', token_modelo_huella = excluded.token_modelo_huella, token_curso_huella = excluded.token_curso_huella, \
             error = NULL, actualizado_en = excluded.actualizado_en",
        )
        .bind(id)
        .bind(&nombre)
        .bind(huella(&self.secreto, &modelo))
        .bind(huella(&self.secreto, &curso))
        .bind(&ahora)
        .bind(&ahora)
        .bind(&ahora)
        .execute(&self.db)
        .await?;
        let imagen = self.info_imagen().await;
        let (memoria, cpus, pids) = self.cli.limites();
        let mut args: Vec<String> = vec![
            "create".into(),
            "--name".into(),
            nombre.clone(),
            "--label".into(),
            format!("campusia.prefijo={}", self.cli.prefijo()),
            "--label".into(),
            format!("campusia.curso={id}"),
            "--label".into(),
            "campusia.tipo=espacio".into(),
            "--network".into(),
            self.cli.red().to_string(),
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
            "--restart".into(),
            "no".into(),
            "--tmpfs".into(),
            "/tmp:rw,exec,nosuid,nodev,size=2g,mode=1777".into(),
            "--mount".into(),
            format!("type=bind,source={},target=/repo", self.trabajo(id).display()),
            "--mount".into(),
            format!("type=bind,source={},target=/datos", self.datos(id).display()),
        ];
        let mut extra: Vec<(String, String)> = Vec::new();
        match imagen.home.as_deref() {
            Some(h) if h == "/tmp" || h.starts_with("/tmp/") => {}
            Some(h) if h.starts_with('/') && h != "/" => {
                args.push("--tmpfs".into());
                args.push(format!("{h}:rw,exec,nosuid,nodev,size=1g,mode=1777"));
            }
            _ => extra.push(("HOME".into(), "/tmp/inicio".into())),
        }
        if let Some(u) = &self.usuario {
            args.push("--user".into());
            args.push(u.clone());
        }
        let proxy = self.url_proxy.clone();
        let mut entorno: Vec<(String, String)> = vec![
            ("PORT".into(), "3000".into()),
            ("CAMPUSIA_CURSO".into(), id.to_string()),
            ("CAMPUSIA_CLAVE_PUBLICA".into(), self.publica.clone()),
            ("CAMPUSIA_API".into(), self.url_espacios.clone()),
            ("CAMPUSIA_TOKEN_CURSO".into(), curso),
            ("CAMPUSIA_DATOS".into(), "/datos".into()),
            ("ANTHROPIC_BASE_URL".into(), format!("{}/modelo", self.url_espacios)),
            ("ANTHROPIC_AUTH_TOKEN".into(), modelo),
            ("HTTP_PROXY".into(), proxy.clone()),
            ("HTTPS_PROXY".into(), proxy.clone()),
            ("http_proxy".into(), proxy.clone()),
            ("https_proxy".into(), proxy),
            ("NO_PROXY".into(), self.direccion.clone()),
            ("no_proxy".into(), self.direccion.clone()),
        ];
        entorno.extend(extra);
        let mut c = self.cli.comando();
        for (k, v) in &entorno {
            args.push("-e".into());
            args.push(k.clone());
            c.env(k, v);
        }
        args.push(self.cfg.imagen.clone());
        c.args(&args);
        let r = tokio::time::timeout(Duration::from_secs(120), c.output())
            .await
            .map_err(|_| anyhow::anyhow!("la creación del espacio no terminó a tiempo"))?
            .map_err(|e| anyhow::anyhow!("no se pudo ejecutar el CLI de contenedores: {e}"))?;
        if !r.status.success() {
            let texto = String::from_utf8_lossy(&r.stderr).to_string();
            anyhow::bail!("No se pudo crear el espacio de trabajo: {}", recortar(&texto, 1000));
        }
        Ok(())
    }

    pub async fn encender(self: &Arc<Self>, id: &str) -> Result<(), sqlx::Error> {
        let info = self.cli.inspeccionar(&self.nombre(id)).await.unwrap_or(None);
        let corriendo = matches!(&info, Some(i) if i.corriendo);
        let (estado, _) = self.estado(id).await?;
        if !corriendo && estado != "ninguno" {
            self.guardar_estado(id, "encendiendo", None).await;
        }
        if corriendo && estado == "encendido" && self.listo(id) {
            return Ok(());
        }
        let esp = self.clone();
        let id = id.to_string();
        tokio::spawn(async move {
            let _ = esp.asegurar(&id).await;
        });
        Ok(())
    }

    pub async fn asegurar(self: &Arc<Self>, id: &str) -> Result<IpAddr, String> {
        if let Some(ip) = self.cache_valida(id) {
            return Ok(ip);
        }
        let cerrojo = self.cerrojo(id);
        let _g = cerrojo.lock().await;
        if let Some(ip) = self.cache_valida(id) {
            return Ok(ip);
        }
        match self.asegurar_interno(id).await {
            Ok(ip) => {
                let g = self.generacion(id);
                self.cache.lock().unwrap().insert(id.to_string(), (ip, Instant::now(), g));
                Ok(ip)
            }
            Err(e) => {
                let m = format!("{e:#}");
                eprintln!("no se pudo encender el espacio de {id}: {m}");
                let corto = recortar(&m, 2000);
                let ahora = ahora_txt();
                let _ = sqlx::query(
                    "INSERT INTO espacios (curso_id, nombre, estado, token_modelo_huella, token_curso_huella, error, creado_en, actualizado_en) \
                     VALUES (?, ?, 'error', ?, ?, ?, ?, ?) ON CONFLICT(curso_id) DO UPDATE SET estado = 'error', error = excluded.error, \
                     actualizado_en = excluded.actualizado_en",
                )
                .bind(id)
                .bind(self.nombre(id))
                .bind(huella(&self.secreto, &format!("sin_token:{}", token_aleatorio())))
                .bind(huella(&self.secreto, &format!("sin_token:{}", token_aleatorio())))
                .bind(&corto)
                .bind(&ahora)
                .bind(&ahora)
                .execute(&self.db)
                .await;
                Err(corto)
            }
        }
    }

    async fn asegurar_interno(self: &Arc<Self>, id: &str) -> anyhow::Result<IpAddr> {
        self.preparar_copia(id).await?;
        let nombre = self.nombre(id);
        let info = self.cli.inspeccionar(&nombre).await?;
        let (estado, _) = self.estado(id).await?;
        match info {
            Some(i) if i.corriendo && i.ip.is_some() && estado != "ninguno" => {
                let ip = i.ip.unwrap_or(IpAddr::from([0, 0, 0, 0]));
                self.tocar(id);
                let g = self.generacion(id);
                if !self.listo(id) && self.vigilados.lock().unwrap().get(id).copied() != Some(g) {
                    if estado != "encendido" {
                        self.guardar_estado(id, "encendiendo", None).await;
                    }
                    tokio::spawn(self.clone().vigilar_salud(id.to_string(), ip, g));
                }
                return Ok(ip);
            }
            Some(i) if i.corriendo => {
                self.cli.borrar(&nombre).await?;
                self.crear_contenedor(id).await?;
            }
            Some(_) if estado != "ninguno" => {
                self.guardar_estado(id, "encendiendo", None).await;
            }
            _ => {
                self.crear_contenedor(id).await?;
            }
        }
        let g = self.nueva_generacion(id);
        if self.sin_root {
            abrir_permisos(&self.trabajo(id));
        }
        crate::supervisor::con_reintentos("El arranque del espacio", id, |_| self.cli.arrancar(&nombre)).await?;
        let info = self.cli.inspeccionar(&nombre).await?;
        let ip = match info {
            Some(i) if i.corriendo => i.ip,
            _ => None,
        };
        let Some(ip) = ip else { anyhow::bail!("El espacio de trabajo no quedó corriendo") };
        self.tocar(id);
        tokio::spawn(self.clone().vigilar_salud(id.to_string(), ip, g));
        Ok(ip)
    }

    async fn vigilar_salud(self: Arc<Self>, id: String, ip: IpAddr, g: u64) {
        {
            let mut v = self.vigilados.lock().unwrap();
            if v.get(&id).copied() == Some(g) {
                return;
            }
            v.insert(id.clone(), g);
        }
        let limite = Instant::now() + Duration::from_secs(self.cfg.arranque_seg as u64);
        let mut vueltas = 0u64;
        loop {
            if self.generacion(&id) != g {
                return;
            }
            if self.salud(ip).await {
                if self.generacion(&id) != g {
                    return;
                }
                self.listos.lock().unwrap().insert(id.clone(), g);
                self.guardar_estado(&id, "encendido", None).await;
                return;
            }
            vueltas += 1;
            if vueltas % 10 == 0 {
                match self.cli.inspeccionar(&self.nombre(&id)).await {
                    Ok(Some(i)) if i.corriendo => {}
                    Ok(_) => {
                        if self.generacion(&id) == g {
                            self.olvidar(&id);
                            self.guardar_estado(&id, "error", Some("El espacio de trabajo se detuvo mientras arrancaba.")).await;
                        }
                        self.vigilados.lock().unwrap().remove(&id);
                        return;
                    }
                    Err(_) => {}
                }
            }
            if Instant::now() >= limite {
                if self.generacion(&id) == g {
                    self.guardar_estado(&id, "error", Some("El espacio de trabajo no respondió /salud a tiempo.")).await;
                }
                self.vigilados.lock().unwrap().remove(&id);
                return;
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    }

    pub async fn salud(&self, ip: IpAddr) -> bool {
        let url = format!("http://{}/salud", std::net::SocketAddr::new(ip, 3000));
        matches!(self.http.get(&url).send().await, Ok(r) if r.status().is_success())
    }

    pub async fn esperar_listo(self: &Arc<Self>, id: &str, espera: Duration) -> Option<IpAddr> {
        let limite = Instant::now() + espera;
        let esp = self.clone();
        let idc = id.to_string();
        let tarea = tokio::spawn(async move { esp.asegurar(&idc).await });
        let ip = match tokio::time::timeout(espera, tarea).await {
            Ok(Ok(Ok(ip))) => ip,
            _ => return None,
        };
        loop {
            if self.listo(id) {
                return Some(ip);
            }
            if Instant::now() >= limite {
                return None;
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    }

    pub async fn reiniciar(self: &Arc<Self>, id: &str) {
        let cerrojo = self.cerrojo(id);
        let _g = cerrojo.lock().await;
        self.nueva_generacion(id);
        let _ = self.cli.detener(&self.nombre(id)).await;
        self.guardar_estado(id, "apagado", None).await;
    }

    pub fn generacion_actual(&self, id: &str) -> u64 {
        self.generacion(id)
    }

    pub fn sesion_viva(&self, id: &str) -> Option<u64> {
        let g = self.generacion(id);
        (self.sesiones.lock().unwrap().get(id).copied() == Some(g)).then_some(g)
    }

    pub fn guardar_sesion(&self, id: &str, g: u64) {
        if self.generacion(id) == g {
            self.sesiones.lock().unwrap().insert(id.to_string(), g);
        }
    }

    pub fn comando_agente(&self, id: &str, continuar: bool, token: &str) -> tokio::process::Command {
        let mut c = self.cli.comando();
        c.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        c.env("CAMPUSIA_TOKEN_AGENTE", token);
        let modelo = format!("CAMPUSIA_MODELO={}", self.cfg.modelo_agente);
        let nombre = self.nombre(id);
        let mut args: Vec<&str> = vec![
            "exec",
            "-i",
            "-w",
            "/repo",
            "-e",
            &modelo,
            "-e",
            "CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1",
            "-e",
            "CAMPUSIA_TOKEN_AGENTE",
            &nombre,
            "campusia-agente",
        ];
        if continuar {
            args.push("--continuar");
        }
        c.args(args);
        c
    }
}

pub fn recortar(s: &str, max: usize) -> String {
    let s = s.trim();
    let n = s.chars().count();
    if n > max {
        s.chars().skip(n - max).collect()
    } else {
        s.to_string()
    }
}

pub struct LineaAgente {
    pub textos: Vec<String>,
    pub herramientas: Vec<(String, Option<String>)>,
    pub resultado: Option<(String, bool)>,
}

pub fn interpretar_linea(linea: &str) -> LineaAgente {
    let mut l = LineaAgente { textos: Vec::new(), herramientas: Vec::new(), resultado: None };
    let Ok(v) = serde_json::from_str::<Value>(linea) else { return l };
    match v.get("type").and_then(Value::as_str) {
        Some("assistant") => {
            for b in v.pointer("/message/content").and_then(Value::as_array).into_iter().flatten() {
                match b.get("type").and_then(Value::as_str) {
                    Some("text") => {
                        if let Some(t) = b.get("text").and_then(Value::as_str) {
                            if !t.is_empty() {
                                l.textos.push(t.to_string());
                            }
                        }
                    }
                    Some("tool_use") => {
                        let nombre = b.get("name").and_then(Value::as_str).unwrap_or("").to_string();
                        let entrada = b.get("input");
                        let ruta = entrada
                            .and_then(|e| e.get("file_path").or_else(|| e.get("notebook_path")).or_else(|| e.get("path")))
                            .and_then(Value::as_str)
                            .and_then(ruta_relativa);
                        l.herramientas.push((nombre, ruta));
                    }
                    _ => {}
                }
            }
        }
        Some("result") => {
            let texto = v.get("result").and_then(Value::as_str).unwrap_or("").to_string();
            let error = v.get("is_error").and_then(Value::as_bool).unwrap_or(false)
                || v.get("subtype").and_then(Value::as_str).map(|s| s != "success").unwrap_or(false);
            l.resultado = Some((texto, error));
        }
        _ => {}
    }
    l
}

pub fn ruta_relativa(r: &str) -> Option<String> {
    let r = r.trim();
    let rel = if let Some(x) = r.strip_prefix("/repo/") {
        x
    } else if r.starts_with('/') {
        return None;
    } else {
        r.strip_prefix("./").unwrap_or(r)
    };
    let partes: Vec<&str> = rel.split('/').filter(|p| !p.is_empty() && *p != ".").collect();
    if partes.is_empty() || partes.iter().any(|p| *p == "..") {
        return None;
    }
    Some(partes.join("/"))
}

pub async fn leer_lineas(
    hijo: &mut tokio::process::Child,
    mut al_leer: impl FnMut(&str),
) {
    let Some(salida) = hijo.stdout.take() else { return };
    let mut lineas = BufReader::new(salida).lines();
    while let Ok(Some(l)) = lineas.next_line().await {
        al_leer(&l);
    }
}

pub async fn escribir_entrada(hijo: &mut tokio::process::Child, texto: &str) {
    if let Some(mut e) = hijo.stdin.take() {
        let _ = e.write_all(texto.as_bytes()).await;
        let _ = e.shutdown().await;
    }
}

