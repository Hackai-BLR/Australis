use std::collections::HashMap;
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as MutexSync};
use std::time::{Duration, Instant};

use sqlx::sqlite::SqlitePool;
use sqlx::Row;
use tokio::process::Command;
use tokio::sync::{Mutex, Semaphore};

use crate::config::ConfigContenedores;
use crate::contenedores::{EspecContenedor, ProveedorDeContenedores};
use crate::util::*;

const VALIDEZ_CACHE: Duration = Duration::from_secs(3);
const REINTENTOS_DOCKER: u32 = 3;
const ESPERA_REINTENTO: Duration = Duration::from_secs(1);

const FALLAS_TRANSITORIAS: [&str; 23] = [
    "no such image",
    "unexpected media type",
    "content digest",
    "not found: not found",
    "failed to get reader",
    "failed to compute cache key",
    "failed to read dockerfile",
    "failed to prepare",
    "failed to create lease",
    "lease does not exist",
    "error from sender",
    "no such file or directory",
    "snapshot",
    "context canceled",
    "connection reset",
    "connection refused",
    "broken pipe",
    "i/o timeout",
    "tls handshake timeout",
    "cannot connect to the docker daemon",
    "is the docker daemon running",
    "device or resource busy",
    "conflict",
];

fn falla_transitoria(error: &anyhow::Error) -> bool {
    let texto = format!("{error:#}").to_lowercase();
    if texto.contains("superó el tiempo máximo") {
        return false;
    }
    FALLAS_TRANSITORIAS.iter().any(|p| texto.contains(p))
}

pub(crate) async fn con_reintentos<T, F, Fut>(que: &str, id: &str, mut intento: F) -> anyhow::Result<T>
where
    F: FnMut(u32) -> Fut,
    Fut: std::future::Future<Output = anyhow::Result<T>>,
{
    let mut espera = ESPERA_REINTENTO;
    let mut n = 0;
    loop {
        match intento(n).await {
            Ok(v) => return Ok(v),
            Err(e) if n < REINTENTOS_DOCKER && falla_transitoria(&e) => {
                n += 1;
                eprintln!("{que} del curso {id} falló ({e:#}); reintento {n} de {REINTENTOS_DOCKER} en {} s", espera.as_secs());
                tokio::time::sleep(espera).await;
                espera *= 2;
            }
            Err(e) => return Err(e),
        }
    }
}

struct Cache {
    ip: IpAddr,
    verificado: Instant,
    generacion: u64,
}

pub struct Supervisor {
    pub cfg: ConfigContenedores,
    proveedor: Box<dyn ProveedorDeContenedores>,
    db: SqlitePool,
    secreto: Vec<u8>,
    publica: String,
    pub url_api: String,
    arranque: Duration,
    inactividad: Duration,
    construccion: Duration,
    cerrojos: MutexSync<HashMap<String, Arc<Mutex<()>>>>,
    cache: MutexSync<HashMap<String, Cache>>,
    ultima: MutexSync<HashMap<String, Instant>>,
    activos: MutexSync<HashMap<String, usize>>,
    generacion: AtomicU64,
    construcciones: Semaphore,
    http: reqwest::Client,
}

pub struct Activo {
    sup: Arc<Supervisor>,
    id: String,
}

impl Drop for Activo {
    fn drop(&mut self) {
        let mut a = self.sup.activos.lock().unwrap();
        if let Some(n) = a.get_mut(&self.id) {
            *n = n.saturating_sub(1);
            if *n == 0 {
                a.remove(&self.id);
            }
        }
        self.sup.ultima.lock().unwrap().insert(self.id.clone(), Instant::now());
    }
}

#[derive(Debug)]
pub enum FallaArranque {
    NoListo,
    Error(anyhow::Error),
}

pub fn nombre_contenedor(prefijo: &str, id: &str) -> String {
    format!("{prefijo}-curso-{id}")
}

async fn correr_git(dir: &Path, args: &[&str]) -> anyhow::Result<Vec<u8>> {
    let mut c = Command::new("git");
    c.kill_on_drop(true)
        .arg("-C")
        .arg(dir)
        .args(["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", "-c", "core.autocrlf=false"])
        .args(args)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        .stdin(Stdio::null());
    let r = c.output().await.map_err(|e| anyhow::anyhow!("no se pudo ejecutar git: {e}"))?;
    if !r.status.success() {
        anyhow::bail!("git {} falló: {}", args.first().unwrap_or(&""), String::from_utf8_lossy(&r.stderr).trim());
    }
    Ok(r.stdout)
}

fn copiar_plantilla(origen: &Path, destino: &Path, raiz: bool) -> anyhow::Result<()> {
    std::fs::create_dir_all(destino)?;
    for e in std::fs::read_dir(origen)? {
        let e = e?;
        let nombre = e.file_name();
        let n = nombre.to_string_lossy();
        if n == "node_modules" || n == "dist" || n == ".git" || (raiz && n == "datos") {
            continue;
        }
        let tipo = e.file_type()?;
        let desde = e.path();
        let hacia = destino.join(&nombre);
        if tipo.is_dir() {
            copiar_plantilla(&desde, &hacia, false)?;
        } else if tipo.is_file() {
            std::fs::copy(&desde, &hacia)?;
        }
    }
    Ok(())
}

fn sdk_empaquetado(dir: &Path) -> Option<PathBuf> {
    let vendor = dir.join("vendor");
    let mut lista: Vec<PathBuf> = std::fs::read_dir(&vendor)
        .ok()?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.starts_with("campusia-sdk-") && n.ends_with(".tgz"))
                .unwrap_or(false)
        })
        .collect();
    lista.sort();
    lista.pop()
}

async fn lanzar_pnpm(programa: &str, previos: &[&str], dir: &Path, args: &[&str]) -> std::io::Result<std::process::Output> {
    Command::new(programa)
        .kill_on_drop(true)
        .current_dir(dir)
        .args(previos)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .await
}

async fn correr_pnpm_con(principal: &str, respaldo: &str, dir: &Path, args: &[&str]) -> anyhow::Result<()> {
    let r = match lanzar_pnpm(principal, &[], dir, args).await {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => lanzar_pnpm(respaldo, &["pnpm"], dir, args).await,
        otro => otro,
    }
    .map_err(|e| anyhow::anyhow!("no se pudo ejecutar pnpm: {e}"))?;
    if !r.status.success() {
        anyhow::bail!("pnpm {} falló: {}", args.join(" "), String::from_utf8_lossy(&r.stderr).trim());
    }
    Ok(())
}

async fn correr_pnpm(dir: &Path, args: &[&str]) -> anyhow::Result<()> {
    correr_pnpm_con("pnpm", "corepack", dir, args).await
}

impl Supervisor {
    pub fn nuevo(
        cfg: ConfigContenedores,
        proveedor: Box<dyn ProveedorDeContenedores>,
        db: SqlitePool,
        secreto: Vec<u8>,
        publica: String,
        url_api: String,
        socket_cursos: Option<PathBuf>,
        tiempos: (i64, i64, i64),
    ) -> anyhow::Result<Supervisor> {
        let mut b = reqwest::Client::builder();
        if let Some(s) = socket_cursos {
            b = b.unix_socket(s);
        }
        let http = b
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(2))
            .timeout(Duration::from_secs(3))
            .build()?;
        Ok(Supervisor {
            cfg,
            proveedor,
            db,
            secreto,
            publica,
            url_api,
            arranque: Duration::from_secs(tiempos.0 as u64),
            inactividad: Duration::from_secs(tiempos.1 as u64),
            construccion: Duration::from_secs(tiempos.2 as u64),
            cerrojos: MutexSync::new(HashMap::new()),
            cache: MutexSync::new(HashMap::new()),
            ultima: MutexSync::new(HashMap::new()),
            activos: MutexSync::new(HashMap::new()),
            generacion: AtomicU64::new(0),
            construcciones: Semaphore::new(3),
            http,
        })
    }

    fn nombre(&self, id: &str) -> String {
        nombre_contenedor(&self.cfg.prefijo, id)
    }

    fn repo(&self, id: &str) -> PathBuf {
        self.cfg.raiz_cursos.join(id)
    }

    pub fn cerrojo(&self, id: &str) -> Arc<Mutex<()>> {
        self.cerrojos.lock().unwrap().entry(id.to_string()).or_default().clone()
    }

    fn cache_valida(&self, id: &str) -> Option<IpAddr> {
        let g = self.generacion.load(Ordering::SeqCst);
        let c = self.cache.lock().unwrap();
        let e = c.get(id)?;
        if e.generacion == g && e.verificado.elapsed() < VALIDEZ_CACHE {
            Some(e.ip)
        } else {
            None
        }
    }

    fn guardar_cache(&self, id: &str, ip: IpAddr) {
        let g = self.generacion.load(Ordering::SeqCst);
        self.cache.lock().unwrap().insert(id.to_string(), Cache { ip, verificado: Instant::now(), generacion: g });
    }

    pub fn olvidar(&self, id: &str) {
        self.cache.lock().unwrap().remove(id);
    }

    pub fn invalidar(&self, id: &str) {
        self.generacion.fetch_add(1, Ordering::SeqCst);
        self.olvidar(id);
        self.ultima.lock().unwrap().insert(id.to_string(), Instant::now());
    }

    pub fn activo(self: &Arc<Self>, id: &str) -> Activo {
        *self.activos.lock().unwrap().entry(id.to_string()).or_insert(0) += 1;
        self.ultima.lock().unwrap().insert(id.to_string(), Instant::now());
        Activo { sup: self.clone(), id: id.to_string() }
    }

    async fn estado_db(&self, id: &str, estado: &str, error: Option<&str>) {
        let r = sqlx::query("UPDATE contenedores SET estado = ?, error = ?, actualizado_en = ? WHERE curso_id = ?")
            .bind(estado)
            .bind(error)
            .bind(ahora_txt())
            .bind(id)
            .execute(&self.db)
            .await;
        if let Err(e) = r {
            eprintln!("no se pudo guardar el estado del contenedor de {id}: {e}");
        }
    }

    pub async fn salud(&self, ip: IpAddr) -> bool {
        let url = format!("http://{}/salud", std::net::SocketAddr::new(ip, 3000));
        matches!(self.http.get(&url).send().await, Ok(r) if r.status().is_success())
    }

    async fn esperar_salud(&self, ip: IpAddr) -> bool {
        let limite = Instant::now() + self.arranque;
        loop {
            if self.salud(ip).await {
                return true;
            }
            if Instant::now() >= limite {
                return false;
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    }

    pub async fn al_arrancar(self: &Arc<Self>) -> anyhow::Result<()> {
        let filas = sqlx::query("SELECT curso_id FROM contenedores").fetch_all(&self.db).await?;
        for f in filas {
            let id: String = f.get("curso_id");
            let info = self.proveedor.inspeccionar(&self.nombre(&id)).await.unwrap_or(None);
            match info {
                Some(i) if i.corriendo => {
                    self.ultima.lock().unwrap().insert(id.clone(), Instant::now());
                    self.estado_db(&id, "encendido", None).await;
                }
                _ => {
                    sqlx::query("UPDATE contenedores SET estado = 'apagado', actualizado_en = ? WHERE curso_id = ? AND estado <> 'error'")
                        .bind(ahora_txt())
                        .bind(&id)
                        .execute(&self.db)
                        .await?;
                }
            }
        }
        let pendientes: Vec<String> =
            sqlx::query_scalar("SELECT id FROM cursos WHERE estado = 'preparando' ORDER BY id").fetch_all(&self.db).await?;
        for id in pendientes {
            eprintln!("se retoma la preparación del curso {id}");
            tokio::spawn(self.clone().preparar(id));
        }
        self.revisar_fuera_de_servicio().await;
        Ok(())
    }

    pub async fn revisar_fuera_de_servicio(&self) {
        let ids: Vec<String> = match sqlx::query_scalar(&format!(
            "SELECT k.curso_id FROM contenedores k JOIN cursos c ON c.id = k.curso_id WHERE {}",
            crate::inhabilitar::SQL_FUERA_DE_SERVICIO
        ))
        .fetch_all(&self.db)
        .await
        {
            Ok(v) => v,
            Err(e) => {
                eprintln!("no se pudieron revisar los cursos fuera de servicio: {e}");
                return;
            }
        };
        for id in ids {
            self.olvidar(&id);
            let nombre = self.nombre(&id);
            let corriendo = matches!(self.proveedor.inspeccionar(&nombre).await, Ok(Some(i)) if i.corriendo);
            if !corriendo {
                continue;
            }
            let cerrojo = self.cerrojo(&id);
            let _g = cerrojo.lock().await;
            self.olvidar(&id);
            match self.proveedor.detener(&nombre).await {
                Ok(()) => {
                    self.ultima.lock().unwrap().remove(&id);
                    self.estado_db(&id, "apagado", None).await;
                    eprintln!("curso {id} detenido por estar fuera de servicio");
                }
                Err(e) => eprintln!("no se pudo detener el curso {id}: {e:#}"),
            }
        }
    }

    pub async fn vigilar_inactividad(self: Arc<Self>, cada: Duration) {
        let mut intervalo = tokio::time::interval(cada);
        intervalo.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            intervalo.tick().await;
            self.revisar_fuera_de_servicio().await;
            let candidatos: Vec<(String, Instant)> =
                self.ultima.lock().unwrap().iter().map(|(k, v)| (k.clone(), *v)).collect();
            for (id, cuando) in candidatos {
                let _ = sqlx::query("UPDATE contenedores SET ultima_peticion = ? WHERE curso_id = ?")
                    .bind(fecha(ahora() - chrono::Duration::from_std(cuando.elapsed()).unwrap_or_default()))
                    .bind(&id)
                    .execute(&self.db)
                    .await;
                if cuando.elapsed() < self.inactividad {
                    continue;
                }
                let cerrojo = self.cerrojo(&id);
                let _g = cerrojo.lock().await;
                let vigente = self.ultima.lock().unwrap().get(&id).copied();
                let ocupado = self.activos.lock().unwrap().get(&id).copied().unwrap_or(0) > 0;
                if ocupado || vigente.map(|v| v.elapsed() < self.inactividad).unwrap_or(false) {
                    continue;
                }
                self.olvidar(&id);
                match self.proveedor.detener(&self.nombre(&id)).await {
                    Ok(()) => {
                        self.ultima.lock().unwrap().remove(&id);
                        self.estado_db(&id, "apagado", None).await;
                        eprintln!("curso {id} apagado por inactividad");
                    }
                    Err(e) => eprintln!("no se pudo apagar el curso {id}: {e:#}"),
                }
            }
        }
    }

    pub async fn asegurar(&self, id: &str) -> Result<IpAddr, FallaArranque> {
        if let Some(ip) = self.cache_valida(id) {
            return Ok(ip);
        }
        let cerrojo = self.cerrojo(id);
        let _g = cerrojo.lock().await;
        if let Some(ip) = self.cache_valida(id) {
            return Ok(ip);
        }
        let r = self.asegurar_con_cerrojo(id).await;
        if let Err(FallaArranque::Error(e)) = &r {
            eprintln!("no se pudo encender el curso {id}: {e:#}");
        }
        r
    }

    async fn asegurar_con_cerrojo(&self, id: &str) -> Result<IpAddr, FallaArranque> {
        match crate::inhabilitar::curso_servible(&self.db, id).await {
            Ok(true) => {}
            Ok(false) => return Err(FallaArranque::NoListo),
            Err(e) => return Err(FallaArranque::Error(e.into())),
        }
        let nombre = self.nombre(id);
        let info = self.proveedor.inspeccionar(&nombre).await.map_err(FallaArranque::Error)?;
        let mut recien = false;
        match info {
            Some(i) if i.corriendo => {
                if let Some(ip) = i.ip {
                    self.guardar_cache(id, ip);
                    self.ultima.lock().unwrap().entry(id.to_string()).or_insert_with(Instant::now);
                    return Ok(ip);
                }
            }
            Some(_) => {
                self.estado_db(id, "encendiendo", None).await;
                con_reintentos("El arranque", id, |_| self.proveedor.arrancar(&nombre)).await.map_err(FallaArranque::Error)?;
                recien = true;
            }
            None => {
                self.estado_db(id, "encendiendo", None).await;
                self.recrear(id).await.map_err(FallaArranque::Error)?;
                recien = true;
            }
        }
        let info = self.proveedor.inspeccionar(&nombre).await.map_err(FallaArranque::Error)?;
        let ip = match info {
            Some(i) if i.corriendo => i.ip,
            _ => None,
        };
        let Some(ip) = ip else {
            self.estado_db(id, "apagado", None).await;
            return Err(FallaArranque::Error(anyhow::anyhow!("el contenedor no quedó corriendo")));
        };
        self.ultima.lock().unwrap().insert(id.to_string(), Instant::now());
        if recien && !self.esperar_salud(ip).await {
            self.estado_db(id, "encendido", None).await;
            return Err(FallaArranque::NoListo);
        }
        self.estado_db(id, "encendido", None).await;
        self.guardar_cache(id, ip);
        Ok(ip)
    }

    async fn recrear(&self, id: &str) -> anyhow::Result<()> {
        let fila = sqlx::query("SELECT imagen FROM contenedores WHERE curso_id = ?").bind(id).fetch_optional(&self.db).await?;
        let imagen: Option<String> = fila.and_then(|f| f.get("imagen"));
        let (imagen, commit) = match imagen {
            Some(i) if self.proveedor.imagen_existe(&i).await? => {
                let commit = i.rsplit(':').next().unwrap_or("").to_string();
                (i, commit)
            }
            _ => self.construir(id).await?,
        };
        self.crear_contenedor(id, &imagen, &commit).await
    }

    async fn repo_completo(&self, repo: &Path) -> bool {
        if !repo.join(".git").is_dir() {
            return false;
        }
        for rama in ["refs/heads/main", "refs/heads/prueba"] {
            if correr_git(repo, &["rev-parse", "--verify", "--quiet", rama]).await.is_err() {
                return false;
            }
        }
        true
    }

    fn limpiar_repo_parcial(repo: &Path) -> anyhow::Result<()> {
        for e in std::fs::read_dir(repo)? {
            let e = e?;
            if e.file_name() == "datos" {
                continue;
            }
            let tipo = e.file_type()?;
            if tipo.is_dir() {
                std::fs::remove_dir_all(e.path())?;
            } else {
                std::fs::remove_file(e.path())?;
            }
        }
        Ok(())
    }

    async fn crear_repo(&self, id: &str) -> anyhow::Result<()> {
        let repo = self.repo(id);
        if repo.exists() {
            if self.repo_completo(&repo).await {
                std::fs::create_dir_all(repo.join("datos"))?;
                return Ok(());
            }
            let r = repo.clone();
            tokio::task::spawn_blocking(move || Self::limpiar_repo_parcial(&r)).await??;
        }
        std::fs::create_dir_all(&self.cfg.raiz_cursos)?;
        let plantilla = self.cfg.plantilla_dir.clone();
        let destino = repo.clone();
        tokio::task::spawn_blocking(move || copiar_plantilla(&plantilla, &destino, true)).await??;
        if sdk_empaquetado(&repo).is_none() {
            let sdk = self.cfg.sdk_dir.clone();
            if !sdk.join("dist").exists() {
                correr_pnpm(&sdk, &["install", "--frozen-lockfile"]).await?;
                correr_pnpm(&sdk, &["run", "build"]).await?;
            }
            let vendor = repo.join("vendor");
            std::fs::create_dir_all(&vendor)?;
            let destino = vendor.to_string_lossy().to_string();
            correr_pnpm(&sdk, &["pack", "--pack-destination", &destino]).await?;
            if sdk_empaquetado(&repo).is_none() {
                anyhow::bail!("No se pudo empaquetar el SDK");
            }
        }
        correr_git(&repo, &["init", "-q", "-b", "main"]).await?;
        std::fs::create_dir_all(repo.join(".git").join("info"))?;
        std::fs::write(repo.join(".git").join("info").join("exclude"), "/datos/\n")?;
        correr_git(&repo, &["add", "-A"]).await?;
        correr_git(
            &repo,
            &["-c", "user.name=Campus IA", "-c", "user.email=cursos@campusia.invalid", "commit", "-q", "--no-verify", "-m", "Curso inicial"],
        )
        .await?;
        correr_git(&repo, &["branch", "prueba", "main"]).await?;
        let datos = repo.join("datos");
        std::fs::create_dir_all(&datos)?;
        Ok(())
    }

    async fn construir(&self, id: &str) -> anyhow::Result<(String, String)> {
        let repo = self.repo(id);
        let commit = String::from_utf8_lossy(&correr_git(&repo, &["rev-parse", "refs/heads/main"]).await?).trim().to_string();
        if commit.len() < 12 {
            anyhow::bail!("No se encontró la rama main");
        }
        let corto = &commit[..12];
        let imagen = format!("{}-curso-{}:{}", self.cfg.prefijo, id, corto);
        let archivos = String::from_utf8_lossy(&correr_git(&repo, &["ls-tree", "--name-only", "refs/heads/main"]).await?).to_string();
        let archivo = if archivos.lines().any(|l| l == "Containerfile") {
            "Containerfile"
        } else if archivos.lines().any(|l| l == "Dockerfile") {
            "Dockerfile"
        } else {
            anyhow::bail!("El curso no tiene Containerfile ni Dockerfile");
        };
        let contexto = correr_git(&repo, &["archive", "--format=tar", "refs/heads/main"]).await?;
        let _permiso = self.construcciones.acquire().await?;
        con_reintentos("La construcción", id, |_| self.proveedor.construir_imagen(&imagen, id, archivo, contexto.clone(), self.construccion)).await?;
        Ok((imagen, corto.to_string()))
    }

    async fn crear_contenedor(&self, id: &str, imagen: &str, commit: &str) -> anyhow::Result<()> {
        let nombre = self.nombre(id);
        self.proveedor.borrar(&nombre).await?;
        let datos = self.repo(id).join("datos");
        std::fs::create_dir_all(&datos)?;
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&datos, std::fs::Permissions::from_mode(0o777))?;
        }
        let token = format!("cct_{}", token_aleatorio());
        let ahora = ahora_txt();
        sqlx::query(
            "INSERT INTO contenedores (curso_id, nombre, imagen, commit_main, token_huella, estado, error, creado_en, actualizado_en) \
             VALUES (?, ?, ?, ?, ?, 'apagado', NULL, ?, ?) ON CONFLICT(curso_id) DO UPDATE SET nombre = excluded.nombre, \
             imagen = excluded.imagen, commit_main = excluded.commit_main, token_huella = excluded.token_huella, \
             estado = 'apagado', error = NULL, actualizado_en = excluded.actualizado_en",
        )
        .bind(id)
        .bind(&nombre)
        .bind(imagen)
        .bind(commit)
        .bind(huella(&self.secreto, &token))
        .bind(&ahora)
        .bind(&ahora)
        .execute(&self.db)
        .await?;
        self.generacion.fetch_add(1, Ordering::SeqCst);
        self.olvidar(id);
        let espec = EspecContenedor {
            nombre: nombre.clone(),
            imagen: imagen.to_string(),
            curso: id.to_string(),
            datos: datos.to_string_lossy().to_string(),
            entorno: vec![
                ("PORT".into(), "3000".into()),
                ("CAMPUSIA_CURSO".into(), id.to_string()),
                ("CAMPUSIA_CLAVE_PUBLICA".into(), self.publica.clone()),
                ("CAMPUSIA_API".into(), self.url_api.clone()),
                ("CAMPUSIA_TOKEN_CURSO".into(), token),
                ("CAMPUSIA_DATOS".into(), "/datos".into()),
            ],
        };
        con_reintentos("El arranque", id, |n| {
            let espec = &espec;
            let nombre = &nombre;
            async move {
                if n > 0 {
                    self.proveedor.borrar(nombre).await?;
                }
                self.proveedor.crear(espec).await?;
                self.proveedor.arrancar(nombre).await
            }
        })
        .await?;
        Ok(())
    }

    async fn preparar_interno(&self, id: &str) -> anyhow::Result<()> {
        self.crear_repo(id).await?;
        let (imagen, commit) = self.construir(id).await?;
        let cerrojo = self.cerrojo(id);
        let _g = cerrojo.lock().await;
        self.estado_db(id, "encendiendo", None).await;
        self.crear_contenedor(id, &imagen, &commit).await?;
        self.estado_db(id, "encendiendo", None).await;
        let info = self.proveedor.inspeccionar(&self.nombre(id)).await?;
        let ip = info.and_then(|i| if i.corriendo { i.ip } else { None });
        let Some(ip) = ip else { anyhow::bail!("El contenedor no quedó corriendo") };
        self.ultima.lock().unwrap().insert(id.to_string(), Instant::now());
        if !self.esperar_salud(ip).await {
            anyhow::bail!("El curso no respondió /salud a tiempo");
        }
        self.estado_db(id, "encendido", None).await;
        self.guardar_cache(id, ip);
        Ok(())
    }

    pub async fn preparar(self: Arc<Self>, id: String) {
        match self.preparar_interno(&id).await {
            Ok(()) => {
                let _ = sqlx::query("UPDATE cursos SET estado = 'listo' WHERE id = ?").bind(&id).execute(&self.db).await;
                eprintln!("curso {id} listo");
            }
            Err(e) => {
                let motivo = format!("{e:#}");
                eprintln!("no se pudo preparar el curso {id}: {motivo}");
                let ahora = ahora_txt();
                let _ = sqlx::query(
                    "INSERT INTO contenedores (curso_id, nombre, token_huella, estado, error, creado_en, actualizado_en) \
                     VALUES (?, ?, ?, 'error', ?, ?, ?) ON CONFLICT(curso_id) DO UPDATE SET estado = 'error', error = excluded.error, \
                     actualizado_en = excluded.actualizado_en",
                )
                .bind(&id)
                .bind(self.nombre(&id))
                .bind(huella(&self.secreto, &format!("sin_token:{}", token_aleatorio())))
                .bind(&motivo)
                .bind(&ahora)
                .bind(&ahora)
                .execute(&self.db)
                .await;
                let _ = sqlx::query("UPDATE cursos SET estado = 'error' WHERE id = ?").bind(&id).execute(&self.db).await;
            }
        }
    }
}

#[cfg(test)]
mod pruebas_pnpm {
    use super::*;

    #[tokio::test]
    async fn usa_corepack_cuando_no_hay_pnpm() {
        let dir = std::env::temp_dir();
        correr_pnpm_con("pnpm-que-no-existe-xyz", "echo", &dir, &["--version"]).await.unwrap();
    }

    #[tokio::test]
    async fn falla_con_mensaje_si_no_hay_ninguno() {
        let dir = std::env::temp_dir();
        let e = correr_pnpm_con("pnpm-que-no-existe-xyz", "corepack-que-no-existe-xyz", &dir, &["--version"])
            .await
            .unwrap_err();
        assert!(e.to_string().contains("no se pudo ejecutar pnpm"));
    }
}