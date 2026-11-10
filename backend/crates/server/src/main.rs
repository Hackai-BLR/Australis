use std::{future::IntoFuture, sync::Arc, time::Duration};

use australis_core::Config;
use tokio::sync::Notify;
use tracing_subscriber::EnvFilter;

/// How long open connections (for example live slide streams) get to finish after a stop
/// signal before the process exits anyway.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(5);

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| "info,sqlx=warn".into()),
        )
        .init();

    let config = Config::from_env()?;
    let bind_addr = config.bind_addr.clone();
    let state = australis_server::build_state(config).await?;
    australis_server::seed::run(&state).await?;
    tracing::info!(
        ai = state.ai.name(),
        zoom = state.zoom.name(),
        slides = state.slides.name(),
        "providers (placeholders are simulated)"
    );
    let app = australis_server::app(state);

    let listener = tokio::net::TcpListener::bind(&bind_addr).await?;
    tracing::info!("australis-server listening on {bind_addr}");

    let stopping = Arc::new(Notify::new());
    let server = axum::serve(listener, app)
        .with_graceful_shutdown({
            let stopping = stopping.clone();
            async move {
                shutdown_signal().await;
                stopping.notify_one();
            }
        })
        .into_future();

    tokio::select! {
        result = server => result?,
        _ = async {
            stopping.notified().await;
            tokio::time::sleep(SHUTDOWN_GRACE).await;
        } => tracing::warn!("open connections did not close in time; exiting anyway"),
    }
    Ok(())
}

/// Resolves on Ctrl-C or, on Unix, on SIGTERM (what `docker stop` sends).
async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };

    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(err) => {
                tracing::warn!(error = %err, "cannot listen for SIGTERM");
                std::future::pending::<()>().await;
            }
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {}
        _ = terminate => {}
    }
}
