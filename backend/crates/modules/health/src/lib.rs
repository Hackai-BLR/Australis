//! Example module. Each module exposes a `router()` that the server mounts under `/api`.

use axum::{extract::State, routing::get, Json, Router};
use hackai_core::{AppResult, AppState};
use serde::Serialize;

pub fn router() -> Router<AppState> {
    Router::new().route("/health", get(health))
}

#[derive(Serialize)]
struct Health {
    status: &'static str,
    database: &'static str,
}

async fn health(State(state): State<AppState>) -> AppResult<Json<Health>> {
    sqlx::query("SELECT 1").execute(&state.db).await?;
    Ok(Json(Health {
        status: "ok",
        database: "ok",
    }))
}
