use std::collections::HashMap;
use std::os::unix::fs::DirBuilderExt;
use std::path::{Path as RutaFs, PathBuf};
use std::sync::{Arc, LazyLock, Mutex, OnceLock};
use std::time::Duration;

use axum::body::Body;
use axum::extract::{Path, RawQuery, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use futures_util::StreamExt;
use rand::RngCore;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::sqlite::SqliteRow;
use sqlx::Row;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

use crate::auth::{App, Ctx, Estado};
use crate::datos::{self, consulta, parametro, Actor};
use crate::util::*;

pub fn nombre_invalido() -> ApiError {
    ApiError::nuevo(StatusCode::BAD_REQUEST, "nombre_invalido", "El nombre del archivo no es válido.")
}

pub fn tipo_no_permitido() -> ApiError {
    ApiError::nuevo(StatusCode::BAD_REQUEST, "tipo_no_permitido", "Ese tipo de archivo no está permitido.")
}

pub fn archivo_demasiado_grande() -> ApiError {
    ApiError::nuevo(StatusCode::PAYLOAD_TOO_LARGE, "archivo_demasiado_grande", "El archivo es demasiado grande.")
}

pub fn cuota_excedida() -> ApiError {
    ApiError::conflicto("cuota_excedida", "El curso no tiene más espacio para archivos.")
}

fn cuota_persona_excedida() -> ApiError {
    ApiError::conflicto("cuota_excedida", "Ya usaste todo el espacio para archivos que te corresponde en este curso.")
}

fn ocupado() -> ApiError {
    ApiError::nuevo(StatusCode::SERVICE_UNAVAILABLE, "ocupado", "Hay demasiadas transferencias en curso. Probá de nuevo en unos segundos.")
}

fn archivo_alterado() -> ApiError {
    ApiError::nuevo(StatusCode::INTERNAL_SERVER_ERROR, "archivo_alterado", "El archivo guardado no coincide con el original.")
}

pub fn normalizar_nombre(crudo: &str) -> Option<String> {
    let t = crudo.trim().replace('\\', "/");
    let ultimo = t.rsplit('/').next().unwrap_or("").trim();
    if ultimo.is_empty() || ultimo == "." || ultimo == ".." || ultimo.chars().count() > 200 {
        return None;
    }
    if ultimo.chars().any(|c| (c as u32) < 0x20 || c as u32 == 0x7f) {
        return None;
    }
    Some(ultimo.to_string())
}

pub fn extension(nombre: &str) -> Option<String> {
    match nombre.rfind('.') {
        Some(i) if i > 0 => Some(nombre[i + 1..].to_lowercase()),
        _ => None,
    }
}

pub fn tipo_de(ext: &str) -> &'static str {
    match ext {
        "pdf" => "application/pdf",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "jpg" | "jpeg" => "image/jpeg",
        "txt" | "md" | "csv" | "py" | "c" | "cpp" | "h" | "java" | "ts" | "sql" | "ipynb" => "text/plain; charset=utf-8",
        "json" => "application/json",
        "zip" => "application/zip",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "odt" => "application/vnd.oasis.opendocument.text",
        "ods" => "application/vnd.oasis.opendocument.spreadsheet",
        "odp" => "application/vnd.oasis.opendocument.presentation",
        _ => "application/octet-stream",
    }
}

pub fn id_valido(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn id_nuevo() -> String {
    let mut b = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut b);
    hex::encode(b)
}

fn curso_seguro(curso: &str) -> bool {
    !curso.is_empty()
        && curso.len() <= 64
        && !curso.starts_with('.')
        && curso.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn ruta_de(app: &App, curso: &str, id: &str) -> Option<PathBuf> {
    if !curso_seguro(curso) || !id_valido(id) {
        return None;
    }
    Some(app.cfg.raiz_archivos.join(curso).join(id))
}

fn crear_carpeta(p: &RutaFs) -> std::io::Result<()> {
    std::fs::DirBuilder::new().recursive(true).mode(0o700).create(p)
}

pub fn preparar_raiz(raiz: &RutaFs) -> std::io::Result<()> {
    crear_carpeta(raiz)?;
    let subiendo = raiz.join(".subiendo");
    crear_carpeta(&subiendo)?;
    if let Ok(entradas) = std::fs::read_dir(&subiendo) {
        for e in entradas.flatten() {
            if e.file_type().map(|t| t.is_file()).unwrap_or(false) {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
    Ok(())
}

pub const SQL_ARCHIVO: &str = "SELECT a.id, a.nombre, a.extension, a.tamano, a.sha256, a.material, a.usuario_id, \
     u.nombre AS usuario_nombre, a.creado_en FROM archivos a JOIN usuarios u ON u.id = a.usuario_id";

pub fn archivo_json(actor: &Actor, f: &SqliteRow) -> Value {
    archivo_json_con(actor, f, "")
}

pub fn archivo_json_con(actor: &Actor, f: &SqliteRow, p: &str) -> Value {
    let col = |c: &str| format!("{p}{c}");
    let ext: String = f.get(col("extension").as_str());
    json!({
        "id": f.get::<String, _>(col("id").as_str()),
        "nombre": f.get::<String, _>(col("nombre").as_str()),
        "tipo": tipo_de(&ext),
        "tamano": f.get::<i64, _>(col("tamano").as_str()),
        "sha256": f.get::<String, _>(col("sha256").as_str()),
        "material": f.get::<i64, _>(col("material").as_str()) != 0,
        "usuario": {
            "id": actor.persona(f.get::<i64, _>(col("usuario_id").as_str())),
            "nombre": f.get::<String, _>(col("usuario_nombre").as_str()),
        },
        "fecha": f.get::<String, _>(col("creado_en").as_str()),
    })
}

const VIGENTE: &str = "a.id NOT IN (SELECT archivo_id FROM archivos_retirados)";

async fn usado(app: &App, curso: &str) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar(&format!("SELECT COALESCE(SUM(a.tamano), 0) FROM archivos a WHERE a.curso_id = ? AND {VIGENTE}"))
        .bind(curso)
        .fetch_one(&app.db)
        .await
}

async fn usado_persona(app: &App, curso: &str, persona: i64) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar(&format!(
        "SELECT COALESCE(SUM(a.tamano), 0) FROM archivos a WHERE a.curso_id = ? AND a.usuario_id = ? AND a.material = 0 AND {VIGENTE}"
    ))
    .bind(curso)
    .bind(persona)
    .fetch_one(&app.db)
    .await
}

pub async fn listar(app: &App, actor: &Actor) -> Resultado {
    let filas = if actor.docente() {
        sqlx::query(&format!("{SQL_ARCHIVO} WHERE a.curso_id = ? AND {VIGENTE} ORDER BY a.rowid"))
            .bind(&actor.curso)
            .fetch_all(&app.db)
            .await?
    } else {
        sqlx::query(&format!("{SQL_ARCHIVO} WHERE a.curso_id = ? AND (a.usuario_id = ? OR a.material = 1) AND {VIGENTE} ORDER BY a.rowid"))
            .bind(&actor.curso)
            .bind(actor.id)
            .fetch_all(&app.db)
            .await?
    };
    let archivos: Vec<Value> = filas.iter().map(|f| archivo_json(actor, f)).collect();
    Ok(ok(json!({"archivos": archivos, "usado": usado(app, &actor.curso).await?, "cuota": app.cfg.archivos_cuota_curso})))
}

static CANDADOS: LazyLock<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

fn candado(curso: &str) -> Arc<tokio::sync::Mutex<()>> {
    let mut m = CANDADOS.lock().unwrap_or_else(|e| e.into_inner());
    m.entry(curso.to_string()).or_default().clone()
}

#[derive(Default)]
struct Reservas {
    cursos: HashMap<String, u64>,
    personas: HashMap<(String, i64), u64>,
}

static RESERVAS: LazyLock<Mutex<Reservas>> = LazyLock::new(|| Mutex::new(Reservas::default()));

const PASO_RESERVA: u64 = 1024 * 1024;

struct Reserva {
    curso: String,
    persona: Option<i64>,
    bytes: u64,
}

impl Reserva {
    fn de(actor: &Actor) -> Reserva {
        Reserva { curso: actor.curso.clone(), persona: if actor.docente() { None } else { Some(actor.id) }, bytes: 0 }
    }

    async fn ampliar(&mut self, app: &App, hasta: u64) -> Result<(), ApiError> {
        if hasta <= self.bytes {
            return Ok(());
        }
        let extra = hasta - self.bytes;
        let c = candado(&self.curso);
        let _guardia = c.lock().await;
        let en_uso = usado(app, &self.curso).await?.max(0) as u64;
        let de_persona = match self.persona {
            Some(p) => Some(usado_persona(app, &self.curso, p).await?.max(0) as u64),
            None => None,
        };
        let mut r = RESERVAS.lock().unwrap_or_else(|e| e.into_inner());
        let curso_reservado = r.cursos.get(&self.curso).copied().unwrap_or(0);
        if en_uso.saturating_add(curso_reservado).saturating_add(extra) > app.cfg.archivos_cuota_curso {
            return Err(cuota_excedida());
        }
        if let (Some(p), Some(propio)) = (self.persona, de_persona) {
            let persona_reservado = r.personas.get(&(self.curso.clone(), p)).copied().unwrap_or(0);
            if propio.saturating_add(persona_reservado).saturating_add(extra) > app.cfg.archivos_cuota_persona {
                return Err(cuota_persona_excedida());
            }
            *r.personas.entry((self.curso.clone(), p)).or_insert(0) += extra;
        }
        *r.cursos.entry(self.curso.clone()).or_insert(0) += extra;
        self.bytes = hasta;
        Ok(())
    }

    fn liberar(&mut self) {
        if self.bytes == 0 {
            return;
        }
        let mut r = RESERVAS.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(v) = r.cursos.get_mut(&self.curso) {
            *v = v.saturating_sub(self.bytes);
            if *v == 0 {
                r.cursos.remove(&self.curso);
            }
        }
        if let Some(p) = self.persona {
            let clave = (self.curso.clone(), p);
            if let Some(v) = r.personas.get_mut(&clave) {
                *v = v.saturating_sub(self.bytes);
                if *v == 0 {
                    r.personas.remove(&clave);
                }
            }
        }
        self.bytes = 0;
    }
}

impl Drop for Reserva {
    fn drop(&mut self) {
        self.liberar();
    }
}

const POR_PERSONA: usize = 4;
const ESPERA_TURNO: Duration = Duration::from_secs(30);

static SUBIDAS: OnceLock<Arc<Semaphore>> = OnceLock::new();
static DESCARGAS: OnceLock<Arc<Semaphore>> = OnceLock::new();
static SUBIDAS_PERSONA: LazyLock<Mutex<HashMap<i64, Arc<Semaphore>>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
static DESCARGAS_PERSONA: LazyLock<Mutex<HashMap<i64, Arc<Semaphore>>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

struct Turno {
    _persona: OwnedSemaphorePermit,
    _global: OwnedSemaphorePermit,
}

async fn turno(
    global: &OnceLock<Arc<Semaphore>>,
    cupo: u64,
    mapa: &Mutex<HashMap<i64, Arc<Semaphore>>>,
    persona: i64,
) -> Result<Turno, ApiError> {
    let global = global.get_or_init(|| Arc::new(Semaphore::new(cupo.max(1) as usize))).clone();
    let propio = {
        let mut m = mapa.lock().unwrap_or_else(|e| e.into_inner());
        if m.len() > 1000 {
            m.retain(|_, s| Arc::strong_count(s) > 1);
        }
        m.entry(persona).or_insert_with(|| Arc::new(Semaphore::new(POR_PERSONA))).clone()
    };
    let p = tokio::time::timeout(ESPERA_TURNO, propio.acquire_owned())
        .await
        .map_err(|_| ApiError::demasiados_intentos())?
        .map_err(|_| ocupado())?;
    let g = tokio::time::timeout(ESPERA_TURNO, global.acquire_owned()).await.map_err(|_| ocupado())?.map_err(|_| ocupado())?;
    Ok(Turno { _persona: p, _global: g })
}

struct Temporal(Option<PathBuf>);

impl Temporal {
    fn soltar(&mut self) {
        self.0 = None;
    }
}

impl Drop for Temporal {
    fn drop(&mut self) {
        if let Some(p) = self.0.take() {
            let _ = std::fs::remove_file(p);
        }
    }
}

pub async fn subir(app: &App, actor: &Actor, cruda: Option<&str>, encabezados: &HeaderMap, cuerpo: Body) -> Resultado {
    let q = consulta(cruda);
    let nombre = parametro(&q, "nombre").and_then(normalizar_nombre).ok_or_else(nombre_invalido)?;
    let ext = extension(&nombre).filter(|e| app.cfg.archivos_tipos.iter().any(|t| t == e)).ok_or_else(tipo_no_permitido)?;
    let material = matches!(parametro(&q, "material"), Some("1") | Some("true"));
    if material && !actor.docente() {
        return Err(ApiError::prohibido());
    }
    let maximo = app.cfg.archivos_max_bytes;
    let declarado = encabezados
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().parse::<u64>().ok());
    if let Some(n) = declarado {
        if n > maximo {
            return Err(archivo_demasiado_grande());
        }
    }
    let mut reserva = Reserva::de(actor);
    if let Some(n) = declarado {
        reserva.ampliar(app, n).await?;
    }
    let _turno = turno(&SUBIDAS, app.cfg.subidas_simultaneas, &SUBIDAS_PERSONA, actor.id).await?;
    let raiz = &app.cfg.raiz_archivos;
    let subiendo = raiz.join(".subiendo");
    crear_carpeta(&subiendo).map_err(|e| anyhow::anyhow!("no se pudo crear la carpeta de subidas: {e}"))?;
    let destino_tmp = subiendo.join(id_nuevo());
    let mut tmp = Temporal(Some(destino_tmp.clone()));
    let mut archivo = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&destino_tmp)
        .await
        .map_err(|e| anyhow::anyhow!("no se pudo crear el archivo temporal: {e}"))?;
    let mut hash = Sha256::new();
    let mut total = 0u64;
    let mut flujo = cuerpo.into_data_stream();
    while let Some(trozo) = flujo.next().await {
        let trozo = trozo.map_err(|_| ApiError::datos_invalidos())?;
        total += trozo.len() as u64;
        if total > maximo {
            return Err(archivo_demasiado_grande());
        }
        match declarado {
            Some(n) if total > n => return Err(ApiError::datos_invalidos()),
            Some(_) => {}
            None if total > reserva.bytes => {
                let pedir = total.max(reserva.bytes.saturating_add(PASO_RESERVA).min(maximo));
                if reserva.ampliar(app, pedir).await.is_err() {
                    reserva.ampliar(app, total).await?;
                }
            }
            None => {}
        }
        hash.update(&trozo);
        archivo.write_all(&trozo).await.map_err(|e| anyhow::anyhow!("no se pudo escribir el archivo temporal: {e}"))?;
    }
    if declarado.is_some_and(|n| n != total) {
        return Err(ApiError::datos_invalidos());
    }
    archivo.flush().await.map_err(|e| anyhow::anyhow!("no se pudo escribir el archivo temporal: {e}"))?;
    archivo.sync_all().await.map_err(|e| anyhow::anyhow!("no se pudo escribir el archivo temporal: {e}"))?;
    drop(archivo);
    let sha = hex::encode(hash.finalize());
    let id = id_nuevo();
    let destino = ruta_de(app, &actor.curso, &id).ok_or_else(|| anyhow::anyhow!("curso con un id inesperado"))?;
    reserva.ampliar(app, total).await?;
    let c = candado(&actor.curso);
    let _guardia = c.lock().await;
    if let Some(carpeta) = destino.parent() {
        crear_carpeta(carpeta).map_err(|e| anyhow::anyhow!("no se pudo crear la carpeta del curso: {e}"))?;
    }
    tokio::fs::rename(&destino_tmp, &destino).await.map_err(|e| anyhow::anyhow!("no se pudo guardar el archivo: {e}"))?;
    tmp.soltar();
    let mut definitivo = Temporal(Some(destino.clone()));
    let creado = ahora_txt();
    sqlx::query(
        "INSERT INTO archivos (id, curso_id, usuario_id, nombre, extension, tamano, sha256, material, via, creado_en) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&actor.curso)
    .bind(actor.id)
    .bind(&nombre)
    .bind(&ext)
    .bind(total as i64)
    .bind(&sha)
    .bind(material as i64)
    .bind(actor.via())
    .bind(&creado)
    .execute(&app.db)
    .await?;
    definitivo.soltar();
    reserva.liberar();
    drop(_guardia);
    drop(_turno);
    let f = sqlx::query(&format!("{SQL_ARCHIVO} WHERE a.id = ?")).bind(&id).fetch_one(&app.db).await?;
    Ok(json_estado(StatusCode::CREATED, archivo_json(actor, &f)))
}

fn codificar_rfc5987(nombre: &str) -> String {
    let mut s = String::new();
    for b in nombre.as_bytes() {
        if b.is_ascii_alphanumeric() || b"!#$&+-.^_`|~".contains(b) {
            s.push(*b as char);
        } else {
            s.push_str(&format!("%{b:02X}"));
        }
    }
    s
}

fn respaldo_ascii(nombre: &str) -> String {
    nombre
        .chars()
        .map(|c| if !c.is_ascii() || c.is_ascii_control() || c == '"' || c == '\\' || c == ';' { '_' } else { c })
        .collect()
}

pub fn disposicion(nombre: &str) -> String {
    format!("attachment; filename*=UTF-8''{}; filename=\"{}\"", codificar_rfc5987(nombre), respaldo_ascii(nombre))
}

const TROZO_DESCARGA: usize = 64 * 1024;

pub async fn retirar(db: &sqlx::SqlitePool, raiz: &RutaFs, curso: &str, archivo: &str, motivo: &str) -> anyhow::Result<i64> {
    if !curso_seguro(curso) || !id_valido(archivo) {
        anyhow::bail!("El curso o el id del archivo no tienen el formato esperado");
    }
    let motivo = motivo.trim();
    if motivo.is_empty() || motivo.chars().count() > 500 {
        anyhow::bail!("El motivo tiene que tener entre 1 y 500 caracteres");
    }
    let tamano: Option<i64> = sqlx::query_scalar("SELECT tamano FROM archivos WHERE id = ? AND curso_id = ?")
        .bind(archivo)
        .bind(curso)
        .fetch_optional(db)
        .await?;
    let tamano = tamano.ok_or_else(|| anyhow::anyhow!("No existe ese archivo en ese curso"))?;
    let ya: Option<i64> = sqlx::query_scalar("SELECT 1 FROM archivos_retirados WHERE archivo_id = ?").bind(archivo).fetch_optional(db).await?;
    if ya.is_some() {
        anyhow::bail!("Ese archivo ya estaba retirado");
    }
    sqlx::query("INSERT INTO archivos_retirados (archivo_id, motivo, retirado_en) VALUES (?, ?, ?)")
        .bind(archivo)
        .bind(motivo)
        .bind(ahora_txt())
        .execute(db)
        .await?;
    match std::fs::remove_file(raiz.join(curso).join(archivo)) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => anyhow::bail!("El archivo quedó retirado pero no se pudo borrar del disco: {e}"),
    }
    Ok(tamano)
}

pub async fn bajar(app: &App, actor: &Actor, archivo_id: &str) -> Resultado {
    if !id_valido(archivo_id) {
        return Err(ApiError::datos_invalidos());
    }
    let f = sqlx::query(&format!("{SQL_ARCHIVO} WHERE a.id = ? AND a.curso_id = ? AND {VIGENTE}"))
        .bind(archivo_id)
        .bind(&actor.curso)
        .fetch_optional(&app.db)
        .await?
        .ok_or_else(ApiError::no_encontrado)?;
    let propio = f.get::<i64, _>("usuario_id") == actor.id;
    let material = f.get::<i64, _>("material") != 0;
    if !actor.docente() && !propio && !material {
        return Err(ApiError::no_encontrado());
    }
    let tamano: i64 = f.get("tamano");
    let sha: String = f.get("sha256");
    let nombre: String = f.get("nombre");
    let ext: String = f.get("extension");
    let ruta = ruta_de(app, &actor.curso, archivo_id).ok_or_else(ApiError::no_encontrado)?;
    let alterado = || {
        eprintln!("archivo alterado o faltante: curso {} archivo {}", actor.curso, archivo_id);
        archivo_alterado()
    };
    let turno = turno(&DESCARGAS, app.cfg.descargas_simultaneas, &DESCARGAS_PERSONA, actor.id).await?;
    let tamano = tamano.max(0) as u64;
    let mut archivo = tokio::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&ruta)
        .await
        .map_err(|_| alterado())?;
    let meta = archivo.metadata().await.map_err(|_| alterado())?;
    if !meta.is_file() || meta.len() != tamano {
        return Err(alterado());
    }
    let mut hash = Sha256::new();
    let mut leido = 0u64;
    let mut buffer = vec![0u8; TROZO_DESCARGA];
    loop {
        let n = archivo.read(&mut buffer).await.map_err(|_| alterado())?;
        if n == 0 {
            break;
        }
        leido += n as u64;
        if leido > tamano {
            return Err(alterado());
        }
        hash.update(&buffer[..n]);
    }
    drop(buffer);
    if leido != tamano || !iguales(&hex::encode(hash.finalize()), &sha) {
        return Err(alterado());
    }
    archivo.seek(std::io::SeekFrom::Start(0)).await.map_err(|_| alterado())?;
    let largo = tamano;
    let flujo = futures_util::stream::unfold((archivo, tamano, turno), |(mut archivo, resta, turno)| async move {
        if resta == 0 {
            return None;
        }
        let mut trozo = vec![0u8; (TROZO_DESCARGA as u64).min(resta) as usize];
        match archivo.read(&mut trozo).await {
            Ok(0) => Some((Err(std::io::Error::from(std::io::ErrorKind::UnexpectedEof)), (archivo, 0, turno))),
            Ok(n) => {
                trozo.truncate(n);
                Some((Ok(axum::body::Bytes::from(trozo)), (archivo, resta - n as u64, turno)))
            }
            Err(e) => Some((Err(e), (archivo, 0, turno))),
        }
    });
    let mut r = Response::new(Body::from_stream(flujo));
    let h = r.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static(tipo_de(&ext)));
    if let Ok(v) = HeaderValue::from_str(&disposicion(&nombre)) {
        h.insert(header::CONTENT_DISPOSITION, v);
    } else {
        h.insert(header::CONTENT_DISPOSITION, HeaderValue::from_static("attachment"));
    }
    h.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    h.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static("default-src 'none'; sandbox"));
    h.insert("cross-origin-resource-policy", HeaderValue::from_static("same-origin"));
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("private, no-store"));
    h.insert(header::CONTENT_LENGTH, HeaderValue::from(largo));
    Ok(r)
}

pub async fn p_listar(State(app): State<Estado>, ctx: Ctx, Path(curso): Path<String>) -> Resultado {
    let actor = datos::de_plataforma(&app, &ctx, &curso, "cursos:leer").await?;
    listar(&app, &actor).await
}

pub async fn p_subir(
    State(app): State<Estado>,
    ctx: Ctx,
    Path(curso): Path<String>,
    RawQuery(q): RawQuery,
    encabezados: HeaderMap,
    cuerpo: Body,
) -> Resultado {
    let actor = datos::de_plataforma(&app, &ctx, &curso, "cursos:escribir").await?;
    subir(&app, &actor, q.as_deref(), &encabezados, cuerpo).await
}

pub async fn p_bajar(State(app): State<Estado>, ctx: Ctx, Path((curso, archivo)): Path<(String, String)>) -> Resultado {
    let actor = datos::de_plataforma(&app, &ctx, &curso, "cursos:leer").await?;
    bajar(&app, &actor, &archivo).await
}

pub async fn c_listar(State(app): State<Estado>, encabezados: HeaderMap) -> Resultado {
    let actor = datos::de_curso(&app, &encabezados).await?;
    listar(&app, &actor).await
}

pub async fn c_subir(State(app): State<Estado>, RawQuery(q): RawQuery, encabezados: HeaderMap, cuerpo: Body) -> Resultado {
    let actor = datos::de_curso(&app, &encabezados).await?;
    subir(&app, &actor, q.as_deref(), &encabezados, cuerpo).await
}

pub async fn c_bajar(State(app): State<Estado>, Path(archivo): Path<String>, encabezados: HeaderMap) -> Response {
    match datos::de_curso(&app, &encabezados).await {
        Ok(actor) => bajar(&app, &actor, &archivo).await.into_response(),
        Err(e) => e.into_response(),
    }
}
