//! Composition root: opens SQLite, runs migrations and mounts every module.
//! `main.rs` only adds logging and the TCP listener, so tests can build the same app.

use australis_core::AppState;
use axum::Router;
use sqlx::SqlitePool;
use tower_http::{cors::CorsLayer, trace::TraceLayer};

/// Connects to SQLite and applies all migrations.
pub async fn init_db(database_url: &str) -> anyhow::Result<SqlitePool> {
    let db = australis_core::connect(database_url).await?;
    sqlx::migrate!("./migrations").run(&db).await?;
    Ok(db)
}

/// Builds the full HTTP app. Register new modules here.
pub fn app(state: AppState) -> Router {
    let api = Router::new().merge(australis_health::router());

    Router::new()
        .nest("/api", api)
        .layer(TraceLayer::new_for_http())
        .layer(CorsLayer::permissive())
        .with_state(state)
}
