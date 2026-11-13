use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{header, HeaderMap, HeaderName, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use futures_util::StreamExt;
use serde_json::{json, Value};
use sqlx::sqlite::SqlitePool;

use crate::agente_config::{ConfigAgente, Precios, Proveedor};
use crate::auth::*;
use crate::util::*;

pub const MAXIMO_CUERPO_MODELO: usize = 32 * 1024 * 1024;
pub const MENSAJE_SIN_USO: &str = "No hay uso disponible del modelo por el momento.";
pub const ENCABEZADO_USUARIO_AUSTRALIS: &str = "x-campus-usuario";
pub const CURSO_AUSTRALIS_USO: &str = "australis";
const REEMPLAZO: &[u8] = b"[token-oculto]";
const RUTAS: [&str; 2] = ["/modelo/v1/messages", "/modelo/v1/messages/count_tokens"];
const SALTO_A_SALTO: [&str; 10] = [
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "proxy-connection",
    "te",
    "trailer",
    "trailers",
    "transfer-encoding",
    "upgrade",
];

pub struct Intermediario {
    proveedor: Option<Proveedor>,
    destino: String,
    beta: String,
    precios: Precios,
    http: reqwest::Client,
    reserva_tokens: i64,
    espera_sin_uso: Duration,
    cortes: Mutex<HashMap<String, (u64, String)>>,
    ejecuciones: Mutex<HashMap<String, (i64, String)>>,
    vuelo: Arc<Mutex<Vuelo>>,
    sin_uso_hasta: Mutex<Option<std::time::Instant>>,
    admision: tokio::sync::Mutex<()>,
}

#[derive(Default)]
struct Vuelo {
    profesores: HashMap<i64, i64>,
    universidades: HashMap<i64, i64>,
}

pub struct EnVuelo {
    vuelo: Arc<Mutex<Vuelo>>,
    profesor: Option<i64>,
    universidad: i64,
}

impl Drop for EnVuelo {
    fn drop(&mut self) {
        let mut v = self.vuelo.lock().unwrap();
        if let Some(p) = self.profesor {
            if let Some(n) = v.profesores.get_mut(&p) {
                *n -= 1;
                if *n <= 0 {
                    v.profesores.remove(&p);
                }
            }
        }
        if let Some(n) = v.universidades.get_mut(&self.universidad) {
            *n -= 1;
            if *n <= 0 {
                v.universidades.remove(&self.universidad);
            }
        }
    }
}

pub struct Ejecucion {
    intermediario: Arc<Intermediario>,
    curso: String,
}

impl Drop for Ejecucion {
    fn drop(&mut self) {
        self.intermediario.ejecuciones.lock().unwrap().remove(&self.curso);
    }
}

enum Admision {
    Admitida(EnVuelo),
    Agotado(crate::cupos::Agotado),
}

const TIPOS_DE_CLIENTE: [&str; 4] = ["bash_", "text_editor_", "computer_", "memory_"];

fn herramienta_permitida(h: &Value) -> bool {
    match h.get("type") {
        None | Some(Value::Null) => true,
        Some(Value::String(t)) => t == "custom" || TIPOS_DE_CLIENTE.iter().any(|p| t.starts_with(p)),
        Some(_) => false,
    }
}

fn bloque_permitido(b: &Value) -> bool {
    let Some(o) = b.as_object() else { return true };
    if let Some(fuente) = o.get("source").and_then(Value::as_object) {
        if fuente.get("type").and_then(Value::as_str) == Some("url") || fuente.contains_key("url") {
            return false;
        }
    }
    if o.get("type").and_then(Value::as_str) == Some("url") {
        return false;
    }
    match o.get("content") {
        Some(Value::Array(v)) => v.iter().all(bloque_permitido),
        _ => true,
    }
}

fn contenido_permitido(c: Option<&Value>) -> bool {
    match c {
        Some(Value::Array(v)) => v.iter().all(bloque_permitido),
        _ => true,
    }
}

pub fn cuerpo_permitido(v: &Value) -> bool {
    let Some(o) = v.as_object() else { return false };
    if let Some(h) = o.get("tools") {
        match h {
            Value::Array(lista) => {
                if !lista.iter().all(herramienta_permitida) {
                    return false;
                }
            }
            Value::Null => {}
            _ => return false,
        }
    }
    for clave in ["mcp_servers", "container"] {
        match o.get(clave) {
            None | Some(Value::Null) => {}
            Some(Value::Array(a)) if a.is_empty() => {}
            Some(_) => return false,
        }
    }
    if !contenido_permitido(o.get("system")) {
        return false;
    }
    match o.get("messages") {
        Some(Value::Array(m)) => m.iter().all(|x| contenido_permitido(x.get("content"))),
        None => true,
        _ => false,
    }
}

fn error_anthropic(estado: StatusCode, tipo: &str, mensaje: &str) -> Response {
    let mut r = (estado, Json(json!({"type": "error", "error": {"type": tipo, "message": mensaje}}))).into_response();
    r.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    r
}

/// El cuerpo queda sin leer (o leído a medias): se cierra la conexión para que
/// un cliente con keep-alive no la reutilice.
fn demasiado_grande() -> Response {
    let mut r = error_anthropic(StatusCode::PAYLOAD_TOO_LARGE, "request_too_large", "El pedido es demasiado grande.");
    cerrar_conexion(&mut r);
    r
}

fn no_autenticado() -> Response {
    error_anthropic(StatusCode::UNAUTHORIZED, "authentication_error", "La credencial del espacio de trabajo no es válida.")
}

pub fn token_valido(t: &str, prefijo: &str) -> bool {
    t.len() == prefijo.len() + 43
        && t.starts_with(prefijo)
        && t[prefijo.len()..].bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

pub fn reemplazar(texto: &[u8], secreto: &[u8]) -> Option<Vec<u8>> {
    if secreto.is_empty() || texto.len() < secreto.len() {
        return None;
    }
    let mut salida = Vec::with_capacity(texto.len());
    let mut inicio = 0;
    let mut cambio = false;
    while let Some(pos) = buscar(&texto[inicio..], secreto) {
        salida.extend_from_slice(&texto[inicio..inicio + pos]);
        salida.extend_from_slice(REEMPLAZO);
        inicio += pos + secreto.len();
        cambio = true;
    }
    if !cambio {
        return None;
    }
    salida.extend_from_slice(&texto[inicio..]);
    Some(salida)
}

fn buscar(pajar: &[u8], aguja: &[u8]) -> Option<usize> {
    if aguja.is_empty() || aguja.len() > pajar.len() {
        return None;
    }
    pajar.windows(aguja.len()).position(|v| v == aguja)
}

pub struct Censor {
    secreto: Vec<u8>,
    pendiente: Vec<u8>,
}

impl Censor {
    pub fn nuevo(secreto: Vec<u8>) -> Censor {
        Censor { secreto, pendiente: Vec::new() }
    }

    pub fn procesar(&mut self, trozo: &[u8]) -> Vec<u8> {
        if self.secreto.is_empty() {
            return trozo.to_vec();
        }
        let mut datos = std::mem::take(&mut self.pendiente);
        datos.extend_from_slice(trozo);
        let mut salida = Vec::with_capacity(datos.len());
        let mut inicio = 0;
        while let Some(pos) = buscar(&datos[inicio..], &self.secreto) {
            salida.extend_from_slice(&datos[inicio..inicio + pos]);
            salida.extend_from_slice(REEMPLAZO);
            inicio += pos + self.secreto.len();
        }
        let resto = &datos[inicio..];
        let maximo = resto.len().min(self.secreto.len().saturating_sub(1));
        let retener = (1..=maximo).rev().find(|&k| resto[resto.len() - k..] == self.secreto[..k]).unwrap_or(0);
        salida.extend_from_slice(&resto[..resto.len() - retener]);
        self.pendiente = resto[resto.len() - retener..].to_vec();
        salida
    }

    pub fn terminar(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.pendiente)
    }
}

const MAXIMO_JSON: usize = 16 * 1024 * 1024;
const MAXIMO_LINEA: usize = 4 * 1024 * 1024;

#[derive(Default, Clone, Debug)]
pub struct Uso {
    pub modelo: Option<String>,
    pub entrada: i64,
    pub salida: i64,
    pub cache_creacion: i64,
    pub cache_lectura: i64,
}

impl Uso {
    fn aplicar(&mut self, usage: &Value) {
        let campo = |n: &str| usage.get(n).and_then(Value::as_i64).filter(|v| *v >= 0);
        if let Some(v) = campo("input_tokens") {
            self.entrada = v;
        }
        if let Some(v) = campo("output_tokens") {
            self.salida = v;
        }
        if let Some(v) = campo("cache_creation_input_tokens") {
            self.cache_creacion = v;
        }
        if let Some(v) = campo("cache_read_input_tokens") {
            self.cache_lectura = v;
        }
    }
}

enum Modo {
    Json { datos: Vec<u8>, desbordado: bool },
    Sse { linea: Vec<u8>, descartando: bool },
    Nada,
}

pub struct Lector {
    modo: Modo,
    pub uso: Uso,
}

impl Lector {
    pub fn nuevo(tipo: &str) -> Lector {
        let t = tipo.to_ascii_lowercase();
        let modo = if t.starts_with("text/event-stream") {
            Modo::Sse { linea: Vec::new(), descartando: false }
        } else if t.starts_with("application/json") || t.contains("+json") {
            Modo::Json { datos: Vec::new(), desbordado: false }
        } else {
            Modo::Nada
        };
        Lector { modo, uso: Uso::default() }
    }

    pub fn alimentar(&mut self, trozo: &[u8]) {
        let mut lineas = Vec::new();
        match &mut self.modo {
            Modo::Json { datos, desbordado } => {
                if !*desbordado {
                    if datos.len() + trozo.len() > MAXIMO_JSON {
                        *desbordado = true;
                        datos.clear();
                    } else {
                        datos.extend_from_slice(trozo);
                    }
                }
            }
            Modo::Sse { linea, descartando } => {
                for &b in trozo {
                    if b == b'\n' {
                        if !*descartando {
                            lineas.push(std::mem::take(linea));
                        }
                        linea.clear();
                        *descartando = false;
                    } else if !*descartando {
                        if linea.len() >= MAXIMO_LINEA {
                            *descartando = true;
                            linea.clear();
                        } else {
                            linea.push(b);
                        }
                    }
                }
            }
            Modo::Nada => {}
        }
        for l in lineas {
            self.linea_sse(&l);
        }
    }

    fn linea_sse(&mut self, linea: &[u8]) {
        let linea = linea.strip_suffix(b"\r").unwrap_or(linea);
        let Some(datos) = linea.strip_prefix(b"data:") else { return };
        let Ok(v) = serde_json::from_slice::<Value>(datos) else { return };
        match v.get("type").and_then(Value::as_str) {
            Some("message_start") => {
                if let Some(m) = v.get("message") {
                    if let Some(modelo) = m.get("model").and_then(Value::as_str) {
                        self.uso.modelo = Some(modelo.to_string());
                    }
                    if let Some(u) = m.get("usage") {
                        self.uso.aplicar(u);
                    }
                }
            }
            Some("message_delta") => {
                if let Some(u) = v.get("usage") {
                    self.uso.aplicar(u);
                }
            }
            _ => {}
        }
    }

    pub fn terminar(&mut self) {
        match std::mem::replace(&mut self.modo, Modo::Nada) {
            Modo::Json { datos, desbordado: false } => {
                if let Ok(v) = serde_json::from_slice::<Value>(&datos) {
                    if let Some(modelo) = v.get("model").and_then(Value::as_str) {
                        self.uso.modelo = Some(modelo.to_string());
                    }
                    if let Some(u) = v.get("usage") {
                        self.uso.aplicar(u);
                    }
                }
            }
            Modo::Sse { linea, descartando: false } => {
                if !linea.is_empty() {
                    self.linea_sse(&linea);
                }
            }
            _ => {}
        }
    }
}

pub async fn total_universidad(db: &SqlitePool, universidad: i64, mes: &str) -> Result<f64, sqlx::Error> {
    sqlx::query_scalar(
        "SELECT COALESCE(SUM(u.usd), 0.0) FROM uso_agente u JOIN cursos c ON c.id = u.curso_id WHERE c.universidad_id = ? AND u.mes = ?",
    )
    .bind(universidad)
    .bind(mes)
    .fetch_one(db)
    .await
}

impl Intermediario {
    pub fn nuevo(cfg: &ConfigAgente) -> anyhow::Result<Intermediario> {
        let http = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(15))
            .read_timeout(Duration::from_secs(600))
            .build()?;
        Ok(Intermediario {
            proveedor: cfg.proveedor.clone(),
            destino: cfg.destino.clone(),
            beta: cfg.beta.clone(),
            precios: cfg.precios.clone(),
            http,
            reserva_tokens: cfg.reserva_tokens_pedido,
            espera_sin_uso: Duration::from_secs(cfg.espera_sin_uso_seg as u64),
            cortes: Mutex::new(HashMap::new()),
            ejecuciones: Mutex::new(HashMap::new()),
            vuelo: Arc::new(Mutex::new(Vuelo::default())),
            sin_uso_hasta: Mutex::new(None),
            admision: tokio::sync::Mutex::new(()),
        })
    }

    pub fn ejecutar_como(self: &Arc<Self>, curso: &str, usuario: i64, token: &str) -> Ejecucion {
        self.ejecuciones.lock().unwrap().insert(curso.to_string(), (usuario, token.to_string()));
        Ejecucion { intermediario: self.clone(), curso: curso.to_string() }
    }

    async fn a_quien(&self, db: &SqlitePool, curso: &str) -> Result<Option<i64>, sqlx::Error> {
        if let Some(u) = self.ejecuciones.lock().unwrap().get(curso).map(|e| e.0) {
            return Ok(Some(u));
        }
        sqlx::query_scalar("SELECT usuario_id FROM inscripciones WHERE curso_id = ? AND rol = 'dueño'").bind(curso).fetch_optional(db).await
    }

    async fn admitir(&self, db: &SqlitePool, profesor: Option<i64>, universidad: i64) -> Result<Admision, sqlx::Error> {
        let _g = self.admision.lock().await;
        let mes = mes_actual();
        let reserva = self.reserva_tokens as i128;
        let (en_vuelo_p, en_vuelo_u) = {
            let v = self.vuelo.lock().unwrap();
            (
                profesor.and_then(|p| v.profesores.get(&p).copied()).unwrap_or(0) as i128,
                v.universidades.get(&universidad).copied().unwrap_or(0) as i128,
            )
        };
        if let Some(p) = profesor {
            if let Some(cupo) = crate::cupos::cupo_profesor(db, p, universidad).await? {
                let usado = crate::cupos::usado_profesor(db, p, universidad, &mes).await? as i128;
                if usado + reserva * en_vuelo_p >= cupo as i128 {
                    return Ok(Admision::Agotado(crate::cupos::Agotado::Profesor));
                }
            }
        }
        let cupo = crate::cupos::cupo_universidad(db, universidad).await?.map(|c| c.0).unwrap_or(0) as i128;
        let usado = crate::cupos::usado_universidad(db, universidad, &mes).await? as i128;
        if usado + reserva * en_vuelo_u >= cupo {
            return Ok(Admision::Agotado(crate::cupos::Agotado::Universidad));
        }
        let mut v = self.vuelo.lock().unwrap();
        if let Some(p) = profesor {
            *v.profesores.entry(p).or_insert(0) += 1;
        }
        *v.universidades.entry(universidad).or_insert(0) += 1;
        Ok(Admision::Admitida(EnVuelo { vuelo: self.vuelo.clone(), profesor, universidad }))
    }

    fn token_vigente(&self, curso: &str) -> Option<String> {
        self.ejecuciones.lock().unwrap().get(curso).map(|e| e.1.clone())
    }

    pub fn disponible(&self) -> bool {
        self.proveedor.is_some()
    }

    pub fn modelo_disponible(&self) -> bool {
        let mut g = self.sin_uso_hasta.lock().unwrap();
        match *g {
            Some(h) if h > std::time::Instant::now() => false,
            Some(_) => {
                *g = None;
                true
            }
            None => true,
        }
    }

    fn sin_uso_por(&self, espera: Duration) {
        let hasta = std::time::Instant::now() + espera;
        let mut g = self.sin_uso_hasta.lock().unwrap();
        if g.map(|h| h < hasta).unwrap_or(true) {
            *g = Some(hasta);
        }
    }

    pub fn cortes(&self, curso: &str) -> u64 {
        self.cortes.lock().unwrap().get(curso).map(|c| c.0).unwrap_or(0)
    }

    pub fn ultimo_corte(&self, curso: &str) -> Option<String> {
        self.cortes.lock().unwrap().get(curso).map(|c| c.1.clone())
    }

    fn cortar(&self, curso: &str, mensaje: &str) {
        let mut c = self.cortes.lock().unwrap();
        let e = c.entry(curso.to_string()).or_insert((0, String::new()));
        e.0 += 1;
        e.1 = mensaje.to_string();
    }

    pub fn secreto(&self) -> &[u8] {
        self.proveedor.as_ref().map(|p| p.secreto().as_bytes()).unwrap_or(&[])
    }

    fn encabezados_destino(&self, origen: &HeaderMap, proveedor: &Proveedor) -> HeaderMap {
        let mut h = HeaderMap::new();
        let mut nombrados: Vec<String> = Vec::new();
        for v in origen.get_all(header::CONNECTION) {
            if let Ok(s) = v.to_str() {
                nombrados.extend(s.split(',').map(|p| p.trim().to_ascii_lowercase()));
            }
        }
        for (k, v) in origen.iter() {
            let n = k.as_str();
            if SALTO_A_SALTO.contains(&n)
                || nombrados.iter().any(|x| x == n)
                || n.starts_with("x-campus")
                || n.starts_with("proxy-")
                || n.starts_with("x-forwarded")
                || matches!(
                    n,
                    "authorization" | "x-api-key" | "cookie" | "host" | "content-length" | "accept-encoding" | "forwarded" | "x-real-ip" | "anthropic-beta"
                )
            {
                continue;
            }
            h.append(k.clone(), v.clone());
        }
        let mut betas: Vec<String> = Vec::new();
        for v in origen.get_all("anthropic-beta") {
            if let Ok(s) = v.to_str() {
                for b in s.split(',').map(str::trim).filter(|b| !b.is_empty()) {
                    if !betas.iter().any(|x| x == b) {
                        betas.push(b.to_string());
                    }
                }
            }
        }
        match proveedor {
            Proveedor::Suscripcion { token } => {
                if !betas.iter().any(|x| x == &self.beta) {
                    betas.push(self.beta.clone());
                }
                if let Ok(v) = HeaderValue::from_str(&format!("Bearer {token}")) {
                    let mut v = v;
                    v.set_sensitive(true);
                    h.insert(header::AUTHORIZATION, v);
                }
            }
            Proveedor::Api { clave } => {
                betas.retain(|b| b != "oauth-2025-04-20");
                if let Ok(mut v) = HeaderValue::from_str(clave) {
                    v.set_sensitive(true);
                    h.insert(HeaderName::from_static("x-api-key"), v);
                }
            }
        }
        if !betas.is_empty() {
            if let Ok(v) = HeaderValue::from_str(&betas.join(",")) {
                h.insert(HeaderName::from_static("anthropic-beta"), v);
            }
        }
        h
    }
}

fn token_de(encabezados: &HeaderMap) -> Option<String> {
    let autorizaciones: Vec<&HeaderValue> = encabezados.get_all(header::AUTHORIZATION).iter().collect();
    let claves: Vec<&HeaderValue> = encabezados.get_all("x-api-key").iter().collect();
    if autorizaciones.len() + claves.len() != 1 {
        return None;
    }
    let token = if let Some(a) = autorizaciones.first() {
        let v = a.to_str().ok()?;
        let resto = v.strip_prefix("Bearer ")?;
        resto.to_string()
    } else {
        claves.first()?.to_str().ok()?.to_string()
    };
    if !token_valido(&token, "cmt_") {
        return None;
    }
    Some(token)
}

pub const SQL_PERSONA_AUSTRALIS: &str = "SELECT u.id, u.universidad_id FROM usuarios u \
     WHERE lower(u.email) = lower(?) AND u.universidad_id IS NOT NULL AND u.pendiente = 0 \
     AND (u.profesor = 1 OR u.administrador = 1) AND NOT ";

pub async fn persona_de_australis(db: &SqlitePool, email: &str) -> Option<(i64, i64)> {
    let consulta = format!("{SQL_PERSONA_AUSTRALIS}{}", crate::inhabilitar::SQL_INHABILITADA);
    sqlx::query_as(&consulta).bind(email.trim()).fetch_optional(db).await.ok().flatten()
}

async fn curso_del_token_modelo(app: &App, encabezados: &HeaderMap) -> Option<(String, i64, Option<i64>)> {
    let token = token_de(encabezados)?;
    if let Some(propio) = app.cfg.australis_token_modelo.as_deref() {
        if iguales(propio, &token) {
            let email = encabezados.get(ENCABEZADO_USUARIO_AUSTRALIS)?.to_str().ok()?;
            let (usuario, universidad) = persona_de_australis(&app.db, email).await?;
            return Some((CURSO_AUSTRALIS_USO.to_string(), universidad, Some(usuario)));
        }
    }
    let h = huella(&app.cfg.session_secret, &token);
    let fila: Option<(String, String, i64)> = sqlx::query_as(&format!(
        "SELECT e.curso_id, e.token_modelo_huella, c.universidad_id FROM espacios e JOIN cursos c ON c.id = e.curso_id \
         WHERE e.token_modelo_huella = ? AND NOT {}",
        crate::inhabilitar::SQL_FUERA_DE_SERVICIO
    ))
    .bind(&h)
    .fetch_optional(&app.db)
    .await
    .ok()?;
    let (curso, guardada, universidad) = fila?;
    if !iguales(&guardada, &h) {
        return None;
    }
    Some((curso, universidad, None))
}

async fn curso_del_token_espacio(app: &App, encabezados: &HeaderMap) -> Result<String, ApiError> {
    let token = bearer(encabezados).ok_or_else(ApiError::no_autenticado)?;
    if !token_valido(&token, "cct_") {
        return Err(ApiError::no_autenticado());
    }
    let h = huella(&app.cfg.session_secret, &token);
    let id: Option<String> = sqlx::query_scalar(&format!(
        "SELECT e.curso_id FROM espacios e JOIN cursos c ON c.id = e.curso_id WHERE e.token_curso_huella = ? AND NOT {}",
        crate::inhabilitar::SQL_FUERA_DE_SERVICIO
    ))
        .bind(&h)
        .fetch_optional(&app.db)
        .await?;
    id.ok_or_else(ApiError::no_autenticado)
}

async fn yo(State(app): State<Estado>, encabezados: HeaderMap) -> Resultado {
    let id = curso_del_token_espacio(&app, &encabezados).await?;
    let f: (String, String, String) =
        sqlx::query_as("SELECT id, nombre, periodo FROM cursos WHERE id = ?").bind(&id).fetch_one(&app.db).await?;
    Ok(ok(json!({"id": f.0, "nombre": f.1, "periodo": f.2})))
}

async fn inscriptos(State(app): State<Estado>, encabezados: HeaderMap) -> Resultado {
    let id = curso_del_token_espacio(&app, &encabezados).await?;
    let lista = crate::cursos::inscriptos_ordenados(&app, &id).await?;
    let plano: Vec<Value> =
        lista.iter().map(|i| json!({"id": i.id.to_string(), "nombre": i.nombre, "email": i.email, "rol": i.rol})).collect();
    Ok(ok(Value::Array(plano)))
}

async fn salud() -> Response {
    Json(json!({"ok": true})).into_response()
}

async fn no_encontrada() -> Response {
    ApiError::no_encontrado().into_response()
}

async fn resto(State(app): State<Estado>, req: Request) -> Response {
    let ruta = req.uri().path().to_string();
    if ruta == "/modelo" || ruta.starts_with("/modelo/") {
        return intermediar(app, req).await;
    }
    no_encontrada().await
}

async fn encabezados_api(req: Request, next: axum::middleware::Next) -> Response {
    let mut r = next.run(req).await;
    let h = r.headers_mut();
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    h.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    r
}

pub fn router(app: Estado) -> Router {
    Router::new()
        .route("/salud", get(salud))
        .route("/api/curso/yo", get(yo))
        .route("/api/curso/inscriptos", get(inscriptos))
        .route("/api/curso/acciones", axum::routing::any(crate::acciones::en_espacios))
        .route("/api/curso/acciones/{*resto}", axum::routing::any(crate::acciones::en_espacios))
        .fallback(resto)
        .method_not_allowed_fallback(no_encontrada)
        .layer(axum::middleware::from_fn(encabezados_api))
        .layer(axum::middleware::from_fn(cerrar_si_queda_cuerpo))
        .with_state(app)
}

fn censurar_encabezados(h: &mut HeaderMap, secreto: &[u8]) {
    if secreto.is_empty() {
        return;
    }
    let claves: Vec<HeaderName> = h.keys().cloned().collect();
    for k in claves {
        let valores: Vec<HeaderValue> = h.get_all(&k).iter().cloned().collect();
        if !valores.iter().any(|v| buscar(v.as_bytes(), secreto).is_some()) {
            continue;
        }
        h.remove(&k);
        for v in valores {
            let nuevo = reemplazar(v.as_bytes(), secreto).unwrap_or_else(|| v.as_bytes().to_vec());
            if let Ok(v) = HeaderValue::from_bytes(&nuevo) {
                h.append(k.clone(), v);
            }
        }
    }
}

fn es_base64url(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'-' || b == b'_'
}

pub fn ocultar_tokens_viejos(cuerpo: axum::body::Bytes, vigente: Option<&str>) -> axum::body::Bytes {
    let largo = 4 + 43;
    let mut salida: Option<Vec<u8>> = None;
    let mut inicio = 0;
    let mut i = 0;
    while i + largo <= cuerpo.len() {
        let candidato = &cuerpo[i..i + largo];
        let es_token = candidato.starts_with(b"cat_")
            && candidato[4..].iter().all(|b| es_base64url(*b))
            && (i == 0 || !es_base64url(cuerpo[i - 1]))
            && cuerpo.get(i + largo).map(|b| !es_base64url(*b)).unwrap_or(true);
        if es_token && vigente.map(|v| v.as_bytes() != candidato).unwrap_or(true) {
            let s = salida.get_or_insert_with(|| Vec::with_capacity(cuerpo.len()));
            s.extend_from_slice(&cuerpo[inicio..i]);
            s.extend_from_slice(REEMPLAZO);
            i += largo;
            inicio = i;
        } else {
            i += 1;
        }
    }
    match salida {
        None => cuerpo,
        Some(mut s) => {
            s.extend_from_slice(&cuerpo[inicio..]);
            axum::body::Bytes::from(s)
        }
    }
}

fn sin_reintento(estado: StatusCode, mensaje: &str) -> Response {
    let mut r = error_anthropic(estado, "rate_limit_error", mensaje);
    r.headers_mut().insert("x-should-retry", HeaderValue::from_static("false"));
    r
}

fn espera_de(h: &HeaderMap, defecto: Duration) -> Duration {
    h.get(header::RETRY_AFTER)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().parse::<u64>().ok())
        .filter(|n| (1..=86_400).contains(n))
        .map(Duration::from_secs)
        .unwrap_or(defecto)
}

async fn registrar_uso(app: &App, curso: &str, universidad: i64, usuario: Option<i64>, ruta: &str, estado: u16, uso: &Uso) {
    let p = app.intermediario.precios.de(uso.modelo.as_deref());
    let usd = (uso.entrada as f64 * p.entrada
        + uso.salida as f64 * p.salida
        + uso.cache_creacion as f64 * p.cache_creacion
        + uso.cache_lectura as f64 * p.cache_lectura)
        / 1_000_000.0;
    let mes = mes_actual();
    let r = async {
        let mut tx = app.db.begin().await?;
        sqlx::query(
            "INSERT INTO uso_modelo (curso_id, universidad_id, mes, fecha, ruta, estado, modelo, tokens_entrada, tokens_salida, \
             tokens_cache_creacion, tokens_cache_lectura, usd, usuario_id, tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(curso)
        .bind(universidad)
        .bind(&mes)
        .bind(ahora_txt())
        .bind(ruta)
        .bind(estado as i64)
        .bind(&uso.modelo)
        .bind(uso.entrada)
        .bind(uso.salida)
        .bind(uso.cache_creacion)
        .bind(uso.cache_lectura)
        .bind(usd)
        .bind(usuario)
        .bind(uso.entrada + uso.cache_creacion + uso.cache_lectura + uso.salida)
        .execute(&mut *tx)
        .await?;
        sqlx::query("INSERT INTO uso_agente (curso_id, mes, usd) VALUES (?, ?, ?) ON CONFLICT(curso_id, mes) DO UPDATE SET usd = usd + excluded.usd")
            .bind(curso)
            .bind(&mes)
            .bind(usd)
            .execute(&mut *tx)
            .await?;
        tx.commit().await
    }
    .await;
    if let Err(e) = r {
        eprintln!("no se pudo registrar el uso del modelo del curso {curso}: {e}");
    }
}

async fn intermediar(app: Estado, req: Request) -> Response {
    let Some((curso, universidad, usuario_directo)) = curso_del_token_modelo(&app, req.headers()).await else {
        return no_autenticado();
    };
    let ruta = req.uri().path().to_string();
    if !RUTAS.contains(&ruta.as_str()) {
        return error_anthropic(StatusCode::NOT_FOUND, "not_found_error", "Ruta no permitida.");
    }
    if req.method() != Method::POST {
        return error_anthropic(StatusCode::METHOD_NOT_ALLOWED, "invalid_request_error", "Método no permitido.");
    }
    let declarado = req
        .headers()
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().parse::<u64>().ok());
    if declarado.map(|n| n > MAXIMO_CUERPO_MODELO as u64).unwrap_or(false) {
        return demasiado_grande();
    }
    let consulta = req.uri().query().map(str::to_string);
    let (partes, cuerpo) = req.into_parts();
    let cuerpo = match axum::body::to_bytes(cuerpo, MAXIMO_CUERPO_MODELO).await {
        Ok(b) => b,
        Err(_) => return demasiado_grande(),
    };
    let Some(proveedor) = app.intermediario.proveedor.clone() else {
        return error_anthropic(StatusCode::SERVICE_UNAVAILABLE, "api_error", "El servicio del modelo no está disponible.");
    };
    let Ok(pedido) = serde_json::from_slice::<Value>(&cuerpo) else {
        return error_anthropic(StatusCode::BAD_REQUEST, "invalid_request_error", "El pedido no es JSON válido.");
    };
    if !cuerpo_permitido(&pedido) {
        return error_anthropic(
            StatusCode::BAD_REQUEST,
            "invalid_request_error",
            "El espacio de trabajo no puede usar herramientas del servidor ni contenido desde URL.",
        );
    }
    if !app.intermediario.modelo_disponible() {
        app.intermediario.cortar(&curso, MENSAJE_SIN_USO);
        return sin_reintento(StatusCode::TOO_MANY_REQUESTS, MENSAJE_SIN_USO);
    }
    let quien = match usuario_directo {
        Some(u) => Ok(Some(u)),
        None => app.intermediario.a_quien(&app.db, &curso).await,
    };
    let admision = match quien {
        Ok(profesor) => app.intermediario.admitir(&app.db, profesor, universidad).await.map(|a| (profesor, a)),
        Err(e) => Err(e),
    };
    let (profesor, reserva) = match admision {
        Ok((p, Admision::Admitida(r))) => (p, r),
        Ok((_, Admision::Agotado(a))) => {
            app.intermediario.cortar(&curso, a.mensaje());
            return sin_reintento(StatusCode::TOO_MANY_REQUESTS, a.mensaje());
        }
        Err(e) => {
            eprintln!("no se pudo consultar el cupo del curso {curso}: {e}");
            return error_anthropic(StatusCode::SERVICE_UNAVAILABLE, "api_error", "El servicio del modelo no está disponible.");
        }
    };
    let sin_prefijo = &ruta["/modelo".len()..];
    let url = match &consulta {
        Some(q) => format!("{}{}?{}", app.intermediario.destino, sin_prefijo, q),
        None => format!("{}{}", app.intermediario.destino, sin_prefijo),
    };
    let encabezados = app.intermediario.encabezados_destino(&partes.headers, &proveedor);
    let cuerpo = ocultar_tokens_viejos(cuerpo, app.intermediario.token_vigente(&curso).as_deref());
    let respuesta = app.intermediario.http.post(&url).headers(encabezados).body(cuerpo).send().await;
    let respuesta = match respuesta {
        Ok(r) => r,
        Err(_) => {
            eprintln!("el destino del modelo no respondió para el curso {curso}");
            return error_anthropic(StatusCode::BAD_GATEWAY, "api_error", "No se pudo conectar con el modelo.");
        }
    };
    let estado = respuesta.status();
    if estado == StatusCode::TOO_MANY_REQUESTS && matches!(proveedor, Proveedor::Suscripcion { .. }) {
        app.intermediario.sin_uso_por(espera_de(respuesta.headers(), app.intermediario.espera_sin_uso));
        let tipo = respuesta.headers().get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
        let mut lector = Lector::nuevo(&tipo);
        if let Ok(Ok(b)) = tokio::time::timeout(Duration::from_secs(30), respuesta.bytes()).await {
            lector.alimentar(&b);
        }
        lector.terminar();
        let mut uso = lector.uso;
        if uso.modelo.is_none() {
            uso.modelo = pedido.get("model").and_then(Value::as_str).map(str::to_string);
        }
        registrar_uso(&app, &curso, universidad, profesor, sin_prefijo, estado.as_u16(), &uso).await;
        drop(reserva);
        app.intermediario.cortar(&curso, MENSAJE_SIN_USO);
        return sin_reintento(StatusCode::TOO_MANY_REQUESTS, MENSAJE_SIN_USO);
    }
    let mut h = respuesta.headers().clone();
    let mut nombrados: Vec<String> = Vec::new();
    for v in h.get_all(header::CONNECTION) {
        if let Ok(s) = v.to_str() {
            nombrados.extend(s.split(',').map(|p| p.trim().to_ascii_lowercase()));
        }
    }
    for n in nombrados {
        h.remove(n.as_str());
    }
    for n in SALTO_A_SALTO {
        h.remove(n);
    }
    h.remove(header::CONTENT_LENGTH);
    h.remove(header::SET_COOKIE);
    let secreto = app.intermediario.secreto().to_vec();
    censurar_encabezados(&mut h, &secreto);
    let tipo = h.get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let modelo_pedido = pedido.get("model").and_then(Value::as_str).map(str::to_string);
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<axum::body::Bytes, std::io::Error>>(64);
    let ruta_uso = sin_prefijo.to_string();
    let app2 = app.clone();
    tokio::spawn(async move {
        let mut lector = Lector::nuevo(&tipo);
        let mut censor = Censor::nuevo(secreto);
        let mut flujo = respuesta.bytes_stream();
        let mut cliente = true;
        while let Some(trozo) = flujo.next().await {
            match trozo {
                Ok(b) => {
                    lector.alimentar(&b);
                    let salida = censor.procesar(&b);
                    if cliente && !salida.is_empty() && tx.send(Ok(axum::body::Bytes::from(salida))).await.is_err() {
                        cliente = false;
                    }
                }
                Err(_) => {
                    if cliente {
                        let _ = tx.send(Err(std::io::Error::other("el destino cortó la respuesta"))).await;
                        cliente = false;
                    }
                    break;
                }
            }
        }
        let fin = censor.terminar();
        if cliente && !fin.is_empty() {
            let _ = tx.send(Ok(axum::body::Bytes::from(fin))).await;
        }
        lector.terminar();
        let mut uso = lector.uso;
        if uso.modelo.is_none() {
            uso.modelo = modelo_pedido;
        }
        registrar_uso(&app2, &curso, universidad, profesor, &ruta_uso, estado.as_u16(), &uso).await;
        drop(reserva);
        drop(tx);
    });
    let flujo = futures_util::stream::unfold(rx, |mut rx| async move { rx.recv().await.map(|x| (x, rx)) });
    let mut r = Response::new(Body::from_stream(flujo));
    *r.status_mut() = estado;
    *r.headers_mut() = h;
    r
}

#[cfg(test)]
mod pruebas {
    use super::*;

    #[test]
    fn censura_partida() {
        let secreto = b"sk-ant-oat01-SECRETO".to_vec();
        let texto = b"aaa sk-ant-oat01-SECRETO bbb sk-ant-oat01-SECRETO".to_vec();
        for corte in 0..texto.len() {
            for corte2 in corte..texto.len() {
                let mut c = Censor::nuevo(secreto.clone());
                let mut salida = c.procesar(&texto[..corte]);
                salida.extend(c.procesar(&texto[corte..corte2]));
                salida.extend(c.procesar(&texto[corte2..]));
                salida.extend(c.terminar());
                assert_eq!(salida, b"aaa [token-oculto] bbb [token-oculto]".to_vec());
            }
        }
    }

    #[test]
    fn tokens() {
        assert!(token_valido(&format!("cmt_{}", "a".repeat(43)), "cmt_"));
        assert!(!token_valido(&format!("cmt_{}", "a".repeat(42)), "cmt_"));
        assert!(!token_valido(&format!("cct_{}", "a".repeat(43)), "cmt_"));
    }

    async fn base_con_personas() -> SqlitePool {
        let db = sqlx::sqlite::SqlitePoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
        crate::db::migrar(&db).await.unwrap();
        sqlx::query("INSERT INTO universidades (id, nombre, creada_en) VALUES (1, 'Demo', 'x'), (2, 'Otra', 'x')").execute(&db).await.unwrap();
        sqlx::query("UPDATE universidades SET deshabilitada_en = 'x' WHERE id = 2").execute(&db).await.unwrap();
        for (id, email, uni, profesor, admin, pendiente, suspendida) in [
            (1, "Prof@demo.test", 1, 1, 0, 0, None),
            (2, "alumno@demo.test", 1, 0, 0, 0, None),
            (3, "admin@demo.test", 1, 0, 1, 0, None),
            (4, "baja@demo.test", 1, 1, 0, 0, Some("x")),
            (5, "otra@demo.test", 2, 1, 0, 0, None),
            (6, "pendiente@demo.test", 1, 1, 0, 1, None),
        ] {
            sqlx::query(
                "INSERT INTO usuarios (id, email, nombre, universidad_id, profesor, administrador, pendiente, creado_en, suspendida_en) \
                 VALUES (?, ?, 'N', ?, ?, ?, ?, 'x', ?)",
            )
            .bind(id)
            .bind(email)
            .bind(uni)
            .bind(profesor)
            .bind(admin)
            .bind(pendiente)
            .bind(suspendida)
            .execute(&db)
            .await
            .unwrap();
        }
        db
    }

    #[tokio::test]
    async fn australis_atribuye_el_uso_a_un_profesor_o_administrador_activo() {
        let db = base_con_personas().await;
        assert_eq!(persona_de_australis(&db, "prof@demo.test").await, Some((1, 1)));
        assert_eq!(persona_de_australis(&db, " PROF@demo.test ").await, Some((1, 1)));
        assert_eq!(persona_de_australis(&db, "admin@demo.test").await, Some((3, 1)));
    }

    #[tokio::test]
    async fn australis_no_atribuye_el_uso_a_quien_no_corresponde() {
        let db = base_con_personas().await;
        for email in ["alumno@demo.test", "baja@demo.test", "otra@demo.test", "pendiente@demo.test", "nadie@demo.test", ""] {
            assert_eq!(persona_de_australis(&db, email).await, None, "{email}");
        }
    }

    #[test]
    fn el_token_se_toma_de_un_solo_encabezado() {
        let token = format!("cmt_{}", "a".repeat(43));
        let mut h = HeaderMap::new();
        h.insert("x-api-key", HeaderValue::from_str(&token).unwrap());
        assert_eq!(token_de(&h), Some(token.clone()));
        h.insert(header::AUTHORIZATION, HeaderValue::from_str(&format!("Bearer {token}")).unwrap());
        assert_eq!(token_de(&h), None);
        let mut otro = HeaderMap::new();
        otro.insert("x-api-key", HeaderValue::from_static("cmt_corto"));
        assert_eq!(token_de(&otro), None);
    }

    struct CorreoMudo;

    #[async_trait::async_trait]
    impl crate::email::ProveedorDeEmail for CorreoMudo {
        async fn enviar(&self, _mail: &crate::email::Mail) -> anyhow::Result<()> {
            Ok(())
        }
    }

    const TOKEN_AUSTRALIS: &str = "cmt_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const TOKEN_CURSO: &str = "cmt_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

    async fn destino_falso() -> String {
        let router = Router::new().route(
            "/v1/messages",
            axum::routing::post(|| async {
                Json(json!({
                    "model": "claude-test",
                    "content": [{ "type": "text", "text": "hola" }],
                    "usage": { "input_tokens": 100, "output_tokens": 40 }
                }))
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        url
    }

    async fn app_con_modelo() -> Estado {
        let ruta = std::env::temp_dir().join(format!("campusia-modelo-{}.db", token_aleatorio()));
        for (k, v) in [
            ("SESSION_SECRET", "0123456789abcdef0123456789abcdef"),
            ("PROVEEDOR_EMAIL", "archivo"),
            ("ARCHIVO_EMAIL", "/dev/null"),
            ("DOMINIO_BASE", "campusia.test"),
            ("TURNSTILE_SITE_KEY", "x"),
            ("TURNSTILE_SECRET", "x"),
            ("ENTORNO", "desarrollo"),
        ] {
            std::env::set_var(k, v);
        }
        std::env::set_var("DATABASE_URL", format!("sqlite://{}", ruta.display()));
        let mut cfg = crate::config::Config::desde_entorno().unwrap();
        cfg.australis_token_modelo = Some(TOKEN_AUSTRALIS.to_string());
        cfg.agente.proveedor = Some(Proveedor::Api { clave: "clave-falsa".to_string() });
        cfg.agente.destino = destino_falso().await;
        cfg.agente.reserva_tokens_pedido = 10;
        let db = crate::db::conectar(&cfg.database_url).await.unwrap();
        crate::db::migrar(&db).await.unwrap();
        let identidad = crate::identidad::Identidad::cargar(&db, Some("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8")).await.unwrap();
        let intermediario = Arc::new(Intermediario::nuevo(&cfg.agente).unwrap());
        sqlx::query("INSERT INTO universidades (id, nombre, creada_en) VALUES (1, 'Demo', 'x')").execute(&db).await.unwrap();
        for (id, email, profesor) in [(1, "prof@demo.test", 1), (2, "otra@demo.test", 1)] {
            sqlx::query(
                "INSERT INTO usuarios (id, email, nombre, universidad_id, profesor, administrador, pendiente, creado_en) VALUES (?, ?, 'N', 1, ?, 0, 0, 'x')",
            )
            .bind(id)
            .bind(email)
            .bind(profesor)
            .execute(&db)
            .await
            .unwrap();
        }
        Arc::new(App {
            cfg,
            db,
            email: Box::new(CorreoMudo),
            http: reqwest::Client::new(),
            proxy: reqwest::Client::new(),
            identidad,
            supervisor: None,
            espacios: None,
            intermediario,
        })
    }

    async fn llamar(app: &Estado, token: &str, usuario: Option<&str>) -> StatusCode {
        let mut b = Request::builder()
            .method(Method::POST)
            .uri("/modelo/v1/messages")
            .header("x-api-key", token)
            .header(header::CONTENT_TYPE, "application/json");
        if let Some(u) = usuario {
            b = b.header(ENCABEZADO_USUARIO_AUSTRALIS, u);
        }
        let respuesta = intermediar(app.clone(), b.body(Body::from(r#"{"model":"claude-test","max_tokens":10,"messages":[]}"#)).unwrap()).await;
        let estado = respuesta.status();
        let _ = axum::body::to_bytes(respuesta.into_body(), 1 << 20).await;
        estado
    }

    async fn filas_de_uso(app: &Estado, esperadas: usize) -> Vec<(String, Option<i64>, i64)> {
        for _ in 0..100 {
            let filas: Vec<(String, Option<i64>, i64)> = sqlx::query_as("SELECT curso_id, usuario_id, tokens FROM uso_modelo ORDER BY id")
                .fetch_all(&app.db)
                .await
                .unwrap();
            if filas.len() >= esperadas {
                return filas;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        Vec::new()
    }

    #[tokio::test]
    async fn la_llamada_de_australis_se_cobra_al_profesor_nombrado() {
        let app = app_con_modelo().await;
        let estado = llamar(&app, TOKEN_AUSTRALIS, Some("prof@demo.test")).await;
        assert_eq!(estado, StatusCode::OK);
        let filas = filas_de_uso(&app, 1).await;
        assert_eq!(filas, vec![(CURSO_AUSTRALIS_USO.to_string(), Some(1), 140)]);
    }

    #[tokio::test]
    async fn con_el_cupo_del_profesor_agotado_australis_recibe_429_con_su_mensaje() {
        let app = app_con_modelo().await;
        sqlx::query("INSERT INTO cupos_profesor (usuario_id, universidad_id, tokens, actualizado_en) VALUES (1, 1, 100, 'x')")
            .execute(&app.db)
            .await
            .unwrap();
        assert_eq!(llamar(&app, TOKEN_AUSTRALIS, Some("prof@demo.test")).await, StatusCode::OK);
        assert_eq!(filas_de_uso(&app, 1).await.len(), 1);
        let respuesta = intermediar(
            app.clone(),
            Request::builder()
                .method(Method::POST)
                .uri("/modelo/v1/messages")
                .header("x-api-key", TOKEN_AUSTRALIS)
                .header(ENCABEZADO_USUARIO_AUSTRALIS, "prof@demo.test")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(r#"{"model":"claude-test","max_tokens":10,"messages":[]}"#))
                .unwrap(),
        )
        .await;
        assert_eq!(respuesta.status(), StatusCode::TOO_MANY_REQUESTS);
        let cuerpo = axum::body::to_bytes(respuesta.into_body(), 1 << 20).await.unwrap();
        let texto = String::from_utf8(cuerpo.to_vec()).unwrap();
        assert!(texto.contains(crate::cupos::Agotado::Profesor.mensaje()), "{texto}");
        assert_eq!(llamar(&app, TOKEN_AUSTRALIS, Some("otra@demo.test")).await, StatusCode::OK);
        assert_eq!(filas_de_uso(&app, 2).await.len(), 2);
    }

    #[tokio::test]
    async fn un_token_de_curso_se_cobra_al_dueno_y_no_a_quien_diga_el_encabezado() {
        let app = app_con_modelo().await;
        sqlx::query("INSERT INTO cursos (id, nombre, periodo, color, universidad_id, creado_en) VALUES ('c1', 'C', 'p', 'c', 1, 'x')")
            .execute(&app.db)
            .await
            .unwrap();
        sqlx::query("INSERT INTO inscripciones (curso_id, usuario_id, rol, creada_en) VALUES ('c1', 2, 'dueño', 'x')")
            .execute(&app.db)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO espacios (curso_id, nombre, estado, token_modelo_huella, token_curso_huella, creado_en, actualizado_en)              VALUES ('c1', 'e', 'encendido', ?, 'otra', 'x', 'x')",
        )
        .bind(huella(&app.cfg.session_secret, TOKEN_CURSO))
        .execute(&app.db)
        .await
        .unwrap();
        assert_eq!(llamar(&app, TOKEN_CURSO, Some("prof@demo.test")).await, StatusCode::OK);
        let filas = filas_de_uso(&app, 1).await;
        assert_eq!(filas, vec![("c1".to_string(), Some(2), 140)]);
    }
}
