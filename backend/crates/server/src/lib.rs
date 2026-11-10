//! Composition root: opens SQLite, runs migrations, picks the providers and mounts every
//! module. `main.rs` only adds logging, the startup seed and the TCP listener, so tests
//! build the same app.

use anyhow::bail;
use australis_core::{auth, config::PLACEHOLDER_PROVIDER, AppError, AppState, Config};
use axum::Router;
use sqlx::SqlitePool;
use tower_http::trace::TraceLayer;

pub mod seed;

/// Connects to SQLite and applies all migrations.
pub async fn init_db(database_url: &str) -> anyhow::Result<SqlitePool> {
    let db = australis_core::connect(database_url).await?;
    sqlx::migrate!("./migrations").run(&db).await?;
    Ok(db)
}

/// Opens the database and builds the shared state. Every outside provider is a placeholder
/// in this build; asking for another one is an error rather than a silent simulation.
pub async fn build_state(config: Config) -> anyhow::Result<AppState> {
    for (variable, value) in [
        ("AI_PROVIDER", &config.ai_provider),
        ("ZOOM_PROVIDER", &config.zoom_provider),
    ] {
        if value != PLACEHOLDER_PROVIDER {
            bail!("{variable}={value} is not available in this build; use {PLACEHOLDER_PROVIDER}");
        }
    }
    let db = init_db(&config.database_url).await?;
    auth::purge_expired_sessions(&mut *db.acquire().await?).await?;
    Ok(AppState::with_placeholders(db, config))
}

/// Builds the full HTTP app. Every module is mounted under `/api`.
///
/// There is no CORS layer on purpose: the frontend reaches the API on its own origin
/// (nginx in production, the Vite proxy in development), and the session cookie must not
/// be usable from any other origin.
pub fn app(state: AppState) -> Router {
    let api = Router::new()
        .merge(australis_health::router())
        .merge(australis_auth::router())
        .merge(australis_campus::router())
        .merge(australis_roster::router())
        .merge(australis_grades::router())
        .merge(australis_classes::router())
        .merge(australis_slides::router());

    Router::new()
        .nest("/api", api)
        .fallback(|| async { AppError::NotFound })
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}
