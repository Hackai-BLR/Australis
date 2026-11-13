use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::task::{Context, Poll};

use axum::body::{Body, Bytes};
use axum::extract::Request;
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use http_body::{Body as _, Frame, SizeHint};
use axum::Json;
use base64::Engine;
use chrono::{DateTime, Duration, SecondsFormat, Utc};
use hmac::{Hmac, Mac};
use rand::RngCore;
use serde_json::{Map, Value};
use sha2::Sha256;

#[derive(Debug)]
pub struct ApiError {
    pub estado: StatusCode,
    pub codigo: &'static str,
    pub mensaje: String,
    pub extra: Option<(&'static str, Value)>,
}

impl ApiError {
    pub fn nuevo(estado: StatusCode, codigo: &'static str, mensaje: &str) -> ApiError {
        ApiError { estado, codigo, mensaje: mensaje.to_string(), extra: None }
    }
    pub fn datos_invalidos() -> ApiError {
        ApiError::nuevo(StatusCode::BAD_REQUEST, "datos_invalidos", "Los datos enviados no son válidos.")
    }
    pub fn email_invalido() -> ApiError {
        ApiError::nuevo(StatusCode::BAD_REQUEST, "email_invalido", "El mail no es válido.")
    }
    pub fn codigo_invalido() -> ApiError {
        ApiError::nuevo(StatusCode::BAD_REQUEST, "codigo_invalido", "El código no es válido o venció.")
    }
    pub fn dominio_no_habilitado() -> ApiError {
        ApiError::nuevo(StatusCode::BAD_REQUEST, "dominio_no_habilitado", "El dominio del mail no está habilitado.")
    }
    pub fn no_autenticado() -> ApiError {
        ApiError::nuevo(StatusCode::UNAUTHORIZED, "no_autenticado", "Tenés que iniciar sesión.")
    }
    pub fn prohibido() -> ApiError {
        ApiError::nuevo(StatusCode::FORBIDDEN, "prohibido", "No tenés permiso para hacer esto.")
    }
    pub fn cuenta_inhabilitada() -> ApiError {
        ApiError::nuevo(
            StatusCode::FORBIDDEN,
            "cuenta_inhabilitada",
            "Tu cuenta está inhabilitada. Consultá con la administración de tu universidad.",
        )
    }
    pub fn origen_invalido() -> ApiError {
        ApiError::nuevo(StatusCode::FORBIDDEN, "origen_invalido", "La petición no viene de un origen válido.")
    }
    pub fn reautenticacion_requerida() -> ApiError {
        ApiError::nuevo(
            StatusCode::FORBIDDEN,
            "reautenticacion_requerida",
            "Confirmá que sos vos con un código nuevo.",
        )
    }
    pub fn turnstile_requerido(site_key: &str) -> ApiError {
        let mut e = ApiError::nuevo(
            StatusCode::FORBIDDEN,
            "turnstile_requerido",
            "Completá la verificación para continuar.",
        );
        e.extra = Some(("site_key", Value::String(site_key.to_string())));
        e
    }
    pub fn turnstile_invalido() -> ApiError {
        ApiError::nuevo(StatusCode::FORBIDDEN, "turnstile_invalido", "La verificación no es válida.")
    }
    pub fn no_encontrado() -> ApiError {
        ApiError::nuevo(StatusCode::NOT_FOUND, "no_encontrado", "No se encontró.")
    }
    pub fn conflicto(codigo: &'static str, mensaje: &str) -> ApiError {
        ApiError::nuevo(StatusCode::CONFLICT, codigo, mensaje)
    }
    pub fn demasiados_intentos() -> ApiError {
        ApiError::nuevo(
            StatusCode::TOO_MANY_REQUESTS,
            "demasiados_intentos",
            "Hiciste demasiados pedidos. Probá de nuevo en unos minutos.",
        )
    }
    pub fn servicio_no_disponible() -> ApiError {
        ApiError::nuevo(
            StatusCode::SERVICE_UNAVAILABLE,
            "servicio_no_disponible",
            "El servicio no está disponible. Probá de nuevo en unos minutos.",
        )
    }
}

impl From<sqlx::Error> for ApiError {
    fn from(e: sqlx::Error) -> ApiError {
        eprintln!("error de base: {e}");
        ApiError::servicio_no_disponible()
    }
}

impl From<anyhow::Error> for ApiError {
    fn from(e: anyhow::Error) -> ApiError {
        eprintln!("error interno: {e:#}");
        ApiError::servicio_no_disponible()
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let mut cuerpo = Map::new();
        cuerpo.insert("error".into(), Value::String(self.codigo.to_string()));
        cuerpo.insert("mensaje".into(), Value::String(self.mensaje));
        let mut reintentar = None;
        if let Some((k, v)) = self.extra {
            if k == "reintentar_en" {
                reintentar = v.as_u64();
            } else {
                cuerpo.insert(k.into(), v);
            }
        }
        let mut r = (self.estado, Json(Value::Object(cuerpo))).into_response();
        if self.estado == StatusCode::TOO_MANY_REQUESTS {
            let segundos = reintentar.unwrap_or(60).max(1);
            if let Ok(v) = HeaderValue::from_str(&segundos.to_string()) {
                r.headers_mut().insert(header::RETRY_AFTER, v);
            }
        }
        r
    }
}

pub type Resultado<T = Response> = Result<T, ApiError>;

pub fn json_estado(estado: StatusCode, v: Value) -> Response {
    (estado, Json(v)).into_response()
}

pub fn ok(v: Value) -> Response {
    json_estado(StatusCode::OK, v)
}

pub fn sin_contenido() -> Response {
    StatusCode::NO_CONTENT.into_response()
}

pub fn ahora() -> DateTime<Utc> {
    Utc::now()
}

pub fn fecha(d: DateTime<Utc>) -> String {
    d.to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub fn ahora_txt() -> String {
    fecha(ahora())
}

pub fn en_segundos(seg: i64) -> DateTime<Utc> {
    ahora() + Duration::seconds(seg)
}

pub fn hace_segundos(seg: i64) -> String {
    fecha(ahora() - Duration::seconds(seg))
}

pub fn leer_fecha(s: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(s).ok().map(|d| d.with_timezone(&Utc))
}

pub fn mes_actual() -> String {
    ahora().format("%Y-%m").to_string()
}

pub fn inicio_del_dia() -> String {
    format!("{}T00:00:00.000Z", ahora().format("%Y-%m-%d"))
}

pub fn huella(secreto: &[u8], valor: &str) -> String {
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(secreto).expect("clave hmac");
    mac.update(valor.as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

pub fn iguales(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

pub fn token_aleatorio() -> String {
    let mut b = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut b);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b)
}

pub fn codigo_aleatorio() -> String {
    use rand::Rng;
    format!("{:06}", rand::rngs::OsRng.gen_range(0..1_000_000u32))
}

fn local_valido(local: &str) -> bool {
    !local.is_empty()
        && local.len() <= 64
        && !local.starts_with('.')
        && !local.ends_with('.')
        && !local.contains("..")
        && local.chars().all(|c| c.is_ascii_alphanumeric() || "!#$%&'*+/=?^_`{|}~.-".contains(c))
}

pub fn dominio_valido(d: &str) -> bool {
    if d.is_empty() || d.len() > 253 || !d.contains('.') {
        return false;
    }
    d.split('.').all(|e| {
        !e.is_empty()
            && e.len() <= 63
            && !e.starts_with('-')
            && !e.ends_with('-')
            && e.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    })
}

pub fn normalizar_email(crudo: &str) -> Option<String> {
    let e = crudo.trim().to_lowercase();
    if e.len() > 254 || e.chars().any(|c| c.is_whitespace()) {
        return None;
    }
    let mut partes = e.split('@');
    let local = partes.next()?;
    let dominio = partes.next()?;
    if partes.next().is_some() || !local_valido(local) || !dominio_valido(dominio) {
        return None;
    }
    Some(e)
}

pub fn dominio_de(email: &str) -> &str {
    email.rsplit('@').next().unwrap_or("")
}

pub fn normalizar_dominio(crudo: &str) -> Option<String> {
    let d = crudo.trim().trim_start_matches('@').to_lowercase();
    if dominio_valido(&d) {
        Some(d)
    } else {
        None
    }
}

pub fn nombre_desde_email(email: &str) -> String {
    let local = email.split('@').next().unwrap_or(email);
    let reemplazado: String = local.chars().map(|c| if c == '.' || c == '_' || c == '-' { ' ' } else { c }).collect();
    let palabras: Vec<String> = reemplazado
        .split_whitespace()
        .map(|p| {
            let mut cs = p.chars();
            match cs.next() {
                Some(primera) => primera.to_uppercase().collect::<String>() + cs.as_str(),
                None => String::new(),
            }
        })
        .collect();
    if palabras.is_empty() {
        local.to_string()
    } else {
        palabras.join(" ")
    }
}

pub fn sin_acentos(s: &str) -> String {
    deunicode::deunicode(s).to_lowercase()
}

pub fn cuerpo_json(encabezados: &HeaderMap, cuerpo: &Bytes) -> Result<Map<String, Value>, ApiError> {
    let tipo = encabezados
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    let esencia = tipo.split(';').next().unwrap_or("").trim().to_string();
    if esencia != "application/json" && !(esencia.starts_with("application/") && esencia.ends_with("+json")) {
        return Err(ApiError::datos_invalidos());
    }
    match serde_json::from_slice::<Value>(cuerpo) {
        Ok(Value::Object(m)) => Ok(m),
        _ => Err(ApiError::datos_invalidos()),
    }
}

pub fn texto_de<'a>(m: &'a Map<String, Value>, k: &str) -> Option<&'a str> {
    m.get(k).and_then(|v| v.as_str())
}

pub fn bool_de(v: i64) -> bool {
    v != 0
}

pub fn valores_cookie(encabezados: &HeaderMap, nombre: &str) -> Vec<String> {
    let mut valores = Vec::new();
    for v in encabezados.get_all(header::COOKIE) {
        let Ok(s) = v.to_str() else {
            valores.push(String::new());
            continue;
        };
        for parte in s.split(';') {
            let parte = parte.trim();
            if let Some((k, val)) = parte.split_once('=') {
                if k.trim() == nombre {
                    valores.push(val.trim().trim_matches('"').to_string());
                }
            }
        }
    }
    valores
}

pub fn valor_cookie(encabezados: &HeaderMap, nombre: &str) -> Option<String> {
    let valores = valores_cookie(encabezados, nombre);
    let primero = valores.first()?.clone();
    if primero.is_empty() || valores.iter().any(|v| *v != primero) {
        return None;
    }
    Some(primero)
}

pub fn cookie_repetida(encabezados: &HeaderMap, nombre: &str) -> bool {
    valores_cookie(encabezados, nombre).len() > 1
}

pub fn rutas_de_cookie(ruta: &str) -> Vec<String> {
    let mut rutas = Vec::new();
    if !ruta.starts_with('/') || ruta.bytes().any(|b| b <= b' ' || b == b';' || b == b',' || b >= 0x7f) {
        return rutas;
    }
    let bytes = ruta.as_bytes();
    for i in 1..=bytes.len() {
        let antes = &ruta[..i];
        let sigue_barra = bytes.get(i) == Some(&b'/');
        if i == bytes.len() || sigue_barra || antes.ends_with('/') {
            if !rutas.iter().any(|r| r == antes) {
                rutas.push(antes.to_string());
            }
        }
        if rutas.len() >= 40 {
            break;
        }
    }
    rutas
}

pub fn encabezado_no_store(r: &mut Response) {
    r.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
}

pub fn escapar_html(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&#39;")
}

pub fn json_nulo<T: Into<Value>>(v: Option<T>) -> Value {
    v.map(Into::into).unwrap_or(Value::Null)
}

/// Pide al cliente que no reutilice la conexión. Se usa cuando se responde sin
/// haber leído todo el cuerpo del pedido: el servidor abandona esa conexión y un
/// cliente con keep-alive que la reutilizara fallaría al escribir.
pub fn cerrar_conexion(r: &mut Response) {
    r.headers_mut().insert(header::CONNECTION, HeaderValue::from_static("close"));
}

struct CuerpoVigilado {
    cuerpo: Body,
    leido: Arc<AtomicBool>,
}

impl http_body::Body for CuerpoVigilado {
    type Data = Bytes;
    type Error = axum::Error;

    fn poll_frame(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Result<Frame<Bytes>, axum::Error>>> {
        let r = Pin::new(&mut self.cuerpo).poll_frame(cx);
        if matches!(r, Poll::Ready(None)) || (matches!(r, Poll::Ready(Some(Ok(_)))) && self.cuerpo.is_end_stream()) {
            self.leido.store(true, Ordering::Relaxed);
        }
        r
    }

    fn is_end_stream(&self) -> bool {
        self.cuerpo.is_end_stream()
    }

    fn size_hint(&self) -> SizeHint {
        self.cuerpo.size_hint()
    }
}

/// Si la respuesta sale sin que se haya leído el cuerpo completo del pedido
/// (rechazos tempranos, límites de tamaño, errores de autenticación), agrega
/// `Connection: close` para que el cliente no reutilice la conexión.
pub async fn cerrar_si_queda_cuerpo(req: Request, next: Next) -> Response {
    let (partes, cuerpo) = req.into_parts();
    if cuerpo.is_end_stream() {
        return next.run(Request::from_parts(partes, cuerpo)).await;
    }
    let leido = Arc::new(AtomicBool::new(false));
    let vigilado = Body::new(CuerpoVigilado { cuerpo, leido: leido.clone() });
    let mut r = next.run(Request::from_parts(partes, vigilado)).await;
    if !leido.load(Ordering::Relaxed) {
        cerrar_conexion(&mut r);
    }
    r
}
