use std::net::SocketAddr;
use std::sync::Arc;

use axum::extract::{ConnectInfo, FromRequestParts};
use axum::http::request::Parts;
use axum::http::{header, HeaderMap, HeaderValue};
use axum::response::Response;
use chrono::{DateTime, Duration, Utc};
use serde_json::{json, Value};
use sqlx::sqlite::SqlitePool;
use sqlx::Row;

use crate::config::{Config, ModoReautenticacion};
use crate::email::ProveedorDeEmail;
use crate::util::*;

pub const COOKIE: &str = "campusia_sesion";

pub struct App {
    pub cfg: Config,
    pub db: SqlitePool,
    pub email: Box<dyn ProveedorDeEmail>,
    pub http: reqwest::Client,
    pub proxy: reqwest::Client,
    pub identidad: crate::identidad::Identidad,
    pub supervisor: Option<Arc<crate::supervisor::Supervisor>>,
    pub espacios: Option<Arc<crate::espacios::Espacios>>,
    pub intermediario: Arc<crate::modelo::Intermediario>,
}

pub type Estado = Arc<App>;

#[derive(Clone, Debug)]
pub struct Usuario {
    pub id: i64,
    pub email: String,
    pub nombre: String,
    pub universidad_id: Option<i64>,
    pub universidad_nombre: Option<String>,
    pub profesor: bool,
    pub administrador: bool,
    pub owner: bool,
}

impl Usuario {
    pub fn json(&self) -> Value {
        let universidad = match (self.universidad_id, &self.universidad_nombre) {
            (Some(id), Some(n)) => json!({"id": id, "nombre": n}),
            _ => Value::Null,
        };
        json!({
            "id": self.id,
            "email": self.email,
            "nombre": self.nombre,
            "universidad": universidad,
            "profesor": self.profesor,
            "administrador": self.administrador,
            "owner": self.owner,
        })
    }
}

const SQL_USUARIO: &str = "SELECT u.id, u.email, u.nombre, u.universidad_id, un.nombre AS universidad_nombre, \
     u.profesor, u.administrador, u.owner FROM usuarios u LEFT JOIN universidades un ON un.id = u.universidad_id";

fn usuario_de_fila(f: &sqlx::sqlite::SqliteRow) -> Usuario {
    Usuario {
        id: f.get("id"),
        email: f.get("email"),
        nombre: f.get("nombre"),
        universidad_id: f.get("universidad_id"),
        universidad_nombre: f.get("universidad_nombre"),
        profesor: bool_de(f.get("profesor")),
        administrador: bool_de(f.get("administrador")),
        owner: bool_de(f.get("owner")),
    }
}

pub async fn usuario_por_id(db: &SqlitePool, id: i64) -> Result<Option<Usuario>, sqlx::Error> {
    let f = sqlx::query(&format!("{SQL_USUARIO} WHERE u.id = ?")).bind(id).fetch_optional(db).await?;
    Ok(f.as_ref().map(usuario_de_fila))
}

pub async fn usuario_por_email(db: &SqlitePool, email: &str) -> Result<Option<Usuario>, sqlx::Error> {
    let f = sqlx::query(&format!("{SQL_USUARIO} WHERE u.email = ?")).bind(email).fetch_optional(db).await?;
    Ok(f.as_ref().map(usuario_de_fila))
}

#[derive(Clone, Debug)]
pub enum Via {
    Sesion { id: i64, vence: DateTime<Utc>, reautenticada_en: Option<DateTime<Utc>> },
    Agente,
}

#[derive(Clone, Debug)]
pub struct Sesion {
    pub id: i64,
    pub usuario_id: i64,
    pub vence: DateTime<Utc>,
    pub reautenticada_en: Option<DateTime<Utc>>,
    pub ultimo_uso: Option<DateTime<Utc>>,
}

pub async fn sesion_por_token(app: &App, token: &str) -> Result<Option<Sesion>, sqlx::Error> {
    if token.len() < 32 || token.len() > 128 {
        return Ok(None);
    }
    let h = huella(&app.cfg.session_secret, token);
    let f = sqlx::query(
        "SELECT id, usuario_id, vence_en, reautenticada_en, ultimo_uso FROM sesiones WHERE huella = ? AND revocada = 0 AND vence_en > ?",
    )
    .bind(&h)
    .bind(ahora_txt())
    .fetch_optional(&app.db)
    .await?;
    Ok(f.and_then(|f| {
        let vence = leer_fecha(&f.get::<String, _>("vence_en"))?;
        if vence <= ahora() {
            return None;
        }
        Some(Sesion {
            id: f.get("id"),
            usuario_id: f.get("usuario_id"),
            vence,
            reautenticada_en: f.get::<Option<String>, _>("reautenticada_en").and_then(|s| leer_fecha(&s)),
            ultimo_uso: f.get::<Option<String>, _>("ultimo_uso").and_then(|s| leer_fecha(&s)),
        })
    }))
}

pub async fn sesion_de_cookie(app: &App, encabezados: &HeaderMap) -> Result<Option<Sesion>, sqlx::Error> {
    match valor_cookie(encabezados, COOKIE) {
        Some(t) => sesion_por_token(app, &t).await,
        None => Ok(None),
    }
}

pub fn ip_cliente(cfg: &Config, encabezados: &HeaderMap, conexion: Option<SocketAddr>) -> String {
    let Some(conexion) = conexion else { return String::new() };
    let par = conexion.ip();
    let confiable = cfg.proxies_confiables.iter().any(|r| r.contiene(par));
    if let (true, Some(nombre)) = (confiable, &cfg.encabezado_ip_cliente) {
        if let Some(v) = encabezados.get(nombre.as_str()).and_then(|v| v.to_str().ok()) {
            if let Ok(ip) = v.split(',').next().unwrap_or("").trim().parse::<std::net::IpAddr>() {
                return ip.to_string();
            }
        }
    }
    par.to_string()
}

pub struct Ip(pub String);

impl FromRequestParts<Estado> for Ip {
    type Rejection = ApiError;
    async fn from_request_parts(parts: &mut Parts, app: &Estado) -> Result<Self, Self::Rejection> {
        let conexion = parts.extensions.get::<ConnectInfo<SocketAddr>>().map(|c| c.0);
        Ok(Ip(ip_cliente(&app.cfg, &parts.headers, conexion)))
    }
}

pub fn bearer(encabezados: &HeaderMap) -> Option<String> {
    let v = encabezados.get(header::AUTHORIZATION)?.to_str().ok()?.trim();
    let (esquema, resto) = v.split_once(' ').unwrap_or((v, ""));
    if esquema.eq_ignore_ascii_case("bearer") {
        Some(resto.trim().to_string())
    } else {
        None
    }
}

pub struct Ctx {
    pub usuario: Usuario,
    pub via: Via,
    pub ip: String,
    pub alcance: crate::roles::Alcance,
}

impl FromRequestParts<Estado> for Ctx {
    type Rejection = ApiError;
    async fn from_request_parts(parts: &mut Parts, app: &Estado) -> Result<Self, Self::Rejection> {
        let conexion = parts.extensions.get::<ConnectInfo<SocketAddr>>().map(|c| c.0);
        let ip = ip_cliente(&app.cfg, &parts.headers, conexion);
        if parts.headers.contains_key(header::AUTHORIZATION) {
            return Err(ApiError::no_autenticado());
        }
        let s = sesion_de_cookie(app, &parts.headers).await?.ok_or_else(ApiError::no_autenticado)?;
        crate::endurecimiento::limitar_api(&app.cfg, &format!("s{}", s.id))?;
        if s.ultimo_uso.map(|u| ahora() - u >= Duration::seconds(60)).unwrap_or(true) {
            sqlx::query("UPDATE sesiones SET ultimo_uso = ? WHERE id = ?").bind(ahora_txt()).bind(s.id).execute(&app.db).await?;
        }
        let usuario = usuario_por_id(&app.db, s.usuario_id).await?.ok_or_else(ApiError::no_autenticado)?;
        crate::inhabilitar::exigir_habilitada(&app.db, usuario.id).await?;
        let alcance = crate::roles::alcance_admin(&app.db, &usuario, parts.uri.query()).await?;
        Ok(Ctx { usuario, via: Via::Sesion { id: s.id, vence: s.vence, reautenticada_en: s.reautenticada_en }, ip, alcance })
    }
}

impl Ctx {
    pub fn sesion_id(&self) -> Option<i64> {
        match self.via {
            Via::Sesion { id, .. } => Some(id),
            Via::Agente => None,
        }
    }

    pub fn solo_sesion(&self) -> Result<i64, ApiError> {
        self.sesion_id().ok_or_else(ApiError::prohibido)
    }

    pub fn admin(&self) -> Result<i64, ApiError> {
        match self.alcance {
            crate::roles::Alcance::Universidad(u) => Ok(u),
            crate::roles::Alcance::NoEncontrado => Err(ApiError::no_encontrado()),
            crate::roles::Alcance::Prohibido => Err(ApiError::prohibido()),
        }
    }

    pub fn owner(&self) -> Result<(), ApiError> {
        if self.usuario.owner {
            Ok(())
        } else {
            Err(ApiError::prohibido())
        }
    }

    pub fn reautenticada_hasta(&self, cfg: &Config) -> Option<DateTime<Utc>> {
        if let (ModoReautenticacion::Sesion, Via::Sesion { vence, .. }) = (cfg.reautenticacion_modo, &self.via) {
            return Some(*vence);
        }
        match self.via {
            Via::Sesion { reautenticada_en: Some(r), .. } => {
                let hasta = r + Duration::seconds(cfg.reautenticacion_seg);
                if hasta > ahora() {
                    Some(hasta)
                } else {
                    None
                }
            }
            _ => None,
        }
    }

    pub fn reautenticada(&self, cfg: &Config) -> Result<(), ApiError> {
        if self.reautenticada_hasta(cfg).is_some() {
            Ok(())
        } else {
            Err(ApiError::reautenticacion_requerida())
        }
    }
}

pub fn cookie_sesion(cfg: &Config, valor: &str, max_age: i64) -> HeaderValue {
    let seguro = if cfg.desarrollo { "" } else { "; Secure" };
    HeaderValue::from_str(&format!(
        "{COOKIE}={valor}; Domain={}; Path=/; HttpOnly; SameSite=Lax; Max-Age={max_age}{seguro}",
        cfg.dominio_base
    ))
    .expect("cookie")
}

pub fn borrar_cookies_repetidas(cfg: &Config, ruta: &str, host_propio: bool) -> Vec<HeaderValue> {
    let seguro = if cfg.desarrollo { "" } else { "; Secure" };
    let mut salida = Vec::new();
    for r in rutas_de_cookie(ruta) {
        if r != "/" {
            salida.push(format!("{COOKIE}=; Domain={}; Path={r}; Max-Age=0{seguro}", cfg.dominio_base));
        }
        if host_propio {
            salida.push(format!("{COOKIE}=; Path={r}; Max-Age=0{seguro}"));
        }
    }
    salida.into_iter().filter_map(|c| HeaderValue::from_str(&c).ok()).collect()
}

pub fn con_cookie(mut r: Response, cookie: HeaderValue) -> Response {
    r.headers_mut().append(header::SET_COOKIE, cookie);
    r
}
