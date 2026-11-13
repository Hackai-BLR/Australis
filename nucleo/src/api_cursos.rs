use axum::extract::{Request, State};
use axum::http::{header, HeaderValue};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get};
use axum::{Json, Router};
use serde_json::{json, Value};
use sqlx::Row;

use crate::auth::*;
use crate::cursos::inscriptos_ordenados;
use crate::util::*;

pub async fn curso_del_token(app: &App, encabezados: &axum::http::HeaderMap) -> Result<String, ApiError> {
    let token = bearer(encabezados).ok_or_else(ApiError::no_autenticado)?;
    if !token.starts_with("cct_") || token.len() != 47 {
        return Err(ApiError::no_autenticado());
    }
    let h = huella(&app.cfg.session_secret, &token);
    let id: Option<String> = sqlx::query_scalar(
        "SELECT c.id FROM contenedores k JOIN cursos c ON c.id = k.curso_id WHERE k.token_huella = ?",
    )
    .bind(&h)
    .fetch_optional(&app.db)
    .await?;
    let id = id.ok_or_else(ApiError::no_autenticado)?;
    if crate::inhabilitar::curso_fuera_de_servicio(&app.db, &id).await? {
        return Err(ApiError::no_autenticado());
    }
    crate::endurecimiento::limitar_curso(&app.cfg, &id)?;
    Ok(id)
}

async fn yo(State(app): State<Estado>, encabezados: axum::http::HeaderMap) -> Resultado {
    let id = curso_del_token(&app, &encabezados).await?;
    let f = sqlx::query("SELECT id, nombre, periodo FROM cursos WHERE id = ?")
        .bind(&id)
        .fetch_one(&app.db)
        .await?;
    Ok(ok(json!({
        "id": f.get::<String, _>("id"),
        "nombre": f.get::<String, _>("nombre"),
        "periodo": f.get::<String, _>("periodo"),
    })))
}

async fn inscriptos(State(app): State<Estado>, encabezados: axum::http::HeaderMap) -> Resultado {
    let id = curso_del_token(&app, &encabezados).await?;
    let lista = inscriptos_ordenados(&app, &id).await?;
    let plano: Vec<Value> = lista
        .iter()
        .filter(|i| !i.suspendida)
        .map(|i| json!({"id": i.id.to_string(), "nombre": i.nombre, "email": i.email, "rol": i.rol}))
        .collect();
    Ok(ok(Value::Array(plano)))
}

async fn salud() -> Response {
    Json(json!({"ok": true})).into_response()
}

async fn no_encontrada() -> Response {
    ApiError::no_encontrado().into_response()
}

async fn encabezados(req: Request, next: Next) -> Response {
    let mut r = next.run(req).await;
    let h = r.headers_mut();
    if !h.contains_key(header::CACHE_CONTROL) {
        h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    }
    h.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    r
}

pub fn router(app: Estado) -> Router {
    Router::new()
        .route("/api/curso/yo", get(yo))
        .route("/api/curso/inscriptos", get(inscriptos))
        .route("/api/curso/archivos", get(crate::archivos::c_listar).post(crate::archivos::c_subir))
        .route("/api/curso/archivos/{archivo}", get(crate::archivos::c_bajar))
        .route("/api/curso/entregas", get(crate::registros::c_entregas).post(crate::registros::c_entregar))
        .route("/api/curso/notas", get(crate::registros::c_notas).post(crate::registros::c_poner_nota))
        .route("/api/curso/notas/historial", get(crate::registros::c_historial))
        .route("/api/curso/acciones", any(crate::acciones::en_cursos))
        .route("/api/curso/acciones/{*resto}", any(crate::acciones::en_cursos))
        .route("/salud", get(salud))
        .fallback(no_encontrada)
        .method_not_allowed_fallback(no_encontrada)
        .layer(middleware::from_fn(encabezados))
        .layer(middleware::from_fn(cerrar_si_queda_cuerpo))
        .with_state(app)
}
