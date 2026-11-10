//! Composition root: loads config, opens SQLite, runs migrations and mounts every module.

use axum::Router;
use hackai_core::{AppState, Config};
use tower_http::{cors::CorsLayer, trace::TraceLayer};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| "info,sqlx=warn".into()),
        )
        .init();

    let config = Config::from_env();
    let db = hackai_core::connect(&config.database_url).await?;
    sqlx::migrate!("./migrations").run(&db).await?;

    let state = AppState { db };

    // Register modules here.
    let api = Router::new().merge(hackai_health::router());

    let app = Router::new()
        .nest("/api", api)
        .layer(TraceLayer::new_for_http())
        .layer(CorsLayer::permissive())
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(&config.bind_addr).await?;
    tracing::info!("hackai-server listening on {}", config.bind_addr);
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}
