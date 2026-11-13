use axum::http::{HeaderMap, StatusCode};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ed25519_dalek::{Signature, VerifyingKey};
use serde_json::{json, Value};
use sqlx::Row;

use crate::auth::{App, Ctx};
use crate::cursos::ROL_EFECTIVO;
use crate::util::*;

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Via {
    Plataforma,
    Curso,
}

pub struct Actor {
    pub curso: String,
    pub id: i64,
    pub rol: String,
    pub via: Via,
}

impl Actor {
    pub fn docente(&self) -> bool {
        self.rol != "alumno"
    }

    pub fn persona(&self, id: i64) -> Value {
        match self.via {
            Via::Plataforma => json!(id),
            Via::Curso => json!(id.to_string()),
        }
    }

    pub fn via(&self) -> &'static str {
        match self.via {
            Via::Plataforma => "plataforma",
            Via::Curso => "curso",
        }
    }
}

pub fn identidad_invalida() -> ApiError {
    ApiError::nuevo(StatusCode::UNAUTHORIZED, "identidad_invalida", "La identidad de la persona no es válida.")
}

pub async fn rol_en(app: &App, curso: &str, usuario: i64) -> Result<Option<String>, sqlx::Error> {
    let f = sqlx::query(&format!(
        "SELECT {ROL_EFECTIVO} AS rol FROM inscripciones i JOIN usuarios u ON u.id = i.usuario_id WHERE i.curso_id = ? AND i.usuario_id = ?"
    ))
    .bind(curso)
    .bind(usuario)
    .fetch_optional(&app.db)
    .await?;
    Ok(f.map(|f| f.get::<String, _>("rol")))
}

pub async fn de_plataforma(app: &App, ctx: &Ctx, curso: &str, permiso: &str) -> Result<Actor, ApiError> {
    let rol = rol_en(app, curso, ctx.usuario.id).await?.ok_or_else(ApiError::no_encontrado)?;
    crate::inhabilitar::curso_visible(&app.db, curso, &rol).await?;
    if permiso == "cursos:escribir" {
        crate::inhabilitar::curso_modificable(&app.db, curso).await?;
    }
    Ok(Actor { curso: curso.to_string(), id: ctx.usuario.id, rol, via: Via::Plataforma })
}

fn entero(v: &Value) -> Option<i64> {
    v.as_i64()
}

pub fn verificar_identidad(app: &App, curso: &str, valor: &str) -> Option<i64> {
    if valor.is_empty() || valor.len() > 4096 || !valor.bytes().all(|b| b.is_ascii_graphic()) {
        return None;
    }
    let (carga, firma) = valor.split_once('.')?;
    if firma.contains('.') {
        return None;
    }
    let firma = URL_SAFE_NO_PAD.decode(firma.as_bytes()).ok()?;
    let firma: [u8; 64] = firma.try_into().ok()?;
    let publica: [u8; 32] = URL_SAFE_NO_PAD.decode(app.identidad.publica().as_bytes()).ok()?.try_into().ok()?;
    let clave = VerifyingKey::from_bytes(&publica).ok()?;
    clave.verify_strict(carga.as_bytes(), &Signature::from_bytes(&firma)).ok()?;
    let json: Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(carga.as_bytes()).ok()?).ok()?;
    if json.get("v").and_then(entero) != Some(1) {
        return None;
    }
    if json.get("curso").and_then(Value::as_str) != Some(curso) {
        return None;
    }
    let emitido = json.get("emitido").and_then(entero)?;
    let vence = json.get("vence").and_then(entero)?;
    let ahora = chrono::Utc::now().timestamp();
    if vence <= ahora || emitido > ahora + 30 || vence - emitido > 120 || vence < emitido {
        return None;
    }
    let usuario = json.get("usuario").and_then(Value::as_str)?;
    if usuario.is_empty() || usuario.len() > 18 || !usuario.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    usuario.parse::<i64>().ok()
}

pub async fn de_curso(app: &App, encabezados: &HeaderMap) -> Result<Actor, ApiError> {
    let curso = crate::api_cursos::curso_del_token(app, encabezados).await?;
    let valores: Vec<_> = encabezados.get_all("x-campus-identidad").iter().collect();
    if valores.len() != 1 {
        return Err(identidad_invalida());
    }
    let valor = valores[0].to_str().map_err(|_| identidad_invalida())?;
    let usuario = verificar_identidad(app, &curso, valor).ok_or_else(identidad_invalida)?;
    let rol = rol_en(app, &curso, usuario).await?.ok_or_else(ApiError::prohibido)?;
    Ok(Actor { curso, id: usuario, rol, via: Via::Curso })
}

pub fn consulta(cruda: Option<&str>) -> Vec<(String, String)> {
    match cruda {
        Some(q) => url::form_urlencoded::parse(q.as_bytes()).map(|(k, v)| (k.into_owned(), v.into_owned())).collect(),
        None => Vec::new(),
    }
}

pub fn parametro<'a>(q: &'a [(String, String)], k: &str) -> Option<&'a str> {
    q.iter().find(|(c, _)| c == k).map(|(_, v)| v.as_str())
}

pub fn actividad_valida(a: &str) -> bool {
    let b = a.as_bytes();
    !b.is_empty()
        && b.len() <= 80
        && b[0].is_ascii_alphanumeric()
        && b.iter().all(|c| c.is_ascii_alphanumeric() || *c == b'.' || *c == b'_' || *c == b'-')
}

pub fn id_persona(v: &Value) -> Option<i64> {
    match v {
        Value::Number(n) => n.as_i64().filter(|n| *n > 0),
        Value::String(s) => texto_id(s),
        _ => None,
    }
}

pub fn texto_id(s: &str) -> Option<i64> {
    if s.is_empty() || s.len() > 18 || !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    s.parse::<i64>().ok().filter(|n| *n > 0)
}

pub struct Filtros {
    pub actividad: Option<String>,
    pub usuario: Option<i64>,
}

pub fn filtros(actor: &Actor, cruda: Option<&str>) -> Result<Filtros, ApiError> {
    let q = consulta(cruda);
    let actividad = match parametro(&q, "actividad") {
        None => None,
        Some(a) if actividad_valida(a) => Some(a.to_string()),
        Some(_) => return Err(ApiError::datos_invalidos()),
    };
    let usuario = match parametro(&q, "usuario") {
        None => None,
        Some(u) => Some(texto_id(u).ok_or_else(ApiError::datos_invalidos)?),
    };
    if !actor.docente() {
        if usuario.is_some_and(|u| u != actor.id) {
            return Err(ApiError::prohibido());
        }
        return Ok(Filtros { actividad, usuario: Some(actor.id) });
    }
    Ok(Filtros { actividad, usuario })
}
