//! Composition root: opens SQLite, runs migrations, picks the providers and mounts every
//! module. `main.rs` only adds logging, the startup seed and the TCP listener, so tests
//! build the same app.

use std::sync::Arc;

use anyhow::bail;
use australis_core::{
    auth,
    ai::{AiProvider, ProxyAi},
    config::{AuthMode, PLACEHOLDER_PROVIDER, PROXY_PROVIDER},
    http, AppError, AppState, Config,
};
use axum::{
    extract::{Request, State},
    http::Method,
    middleware::Next,
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use sqlx::SqlitePool;
use tower_http::trace::TraceLayer;

pub mod seed;

/// Connects to SQLite and applies all migrations.
pub async fn init_db(database_url: &str) -> anyhow::Result<SqlitePool> {
    let db = australis_core::connect(database_url).await?;
    sqlx::migrate!("./migrations").run(&db).await?;
    Ok(db)
}

/// Opens the database and builds the shared state. Zoom and PowerPoint conversion are
/// placeholders in this build. The AI is the placeholder unless `AI_PROVIDER=proxy` asks for
/// the core's model proxy, which needs `AI_PROXY_URL` and `AI_API_KEY`. Asking for anything
/// else is an error rather than a silent simulation.
pub async fn build_state(config: Config) -> anyhow::Result<AppState> {
    if config.zoom_provider != PLACEHOLDER_PROVIDER {
        bail!(
            "ZOOM_PROVIDER={} is not available in this build; use {PLACEHOLDER_PROVIDER}",
            config.zoom_provider
        );
    }
    let ai: Option<Arc<dyn AiProvider>> = match config.ai_provider.as_str() {
        PLACEHOLDER_PROVIDER => None,
        PROXY_PROVIDER => {
            let (Some(url), Some(token)) = (&config.ai_proxy_url, &config.ai_api_key) else {
                bail!("AI_PROVIDER={PROXY_PROVIDER} needs AI_PROXY_URL and AI_API_KEY");
            };
            Some(Arc::new(ProxyAi::new(url, token, &config.ai_model)?))
        }
        other => bail!(
            "AI_PROVIDER={other} is not available; use {PLACEHOLDER_PROVIDER} or {PROXY_PROVIDER}"
        ),
    };
    let db = init_db(&config.database_url).await?;
    auth::purge_expired_sessions(&mut *db.acquire().await?).await?;
    let mut state = AppState::with_placeholders(db, config);
    if let Some(ai) = ai {
        state.ai = ai;
    }
    Ok(state)
}

/// `GET /api/auth/mode`: how the caller is identified, so the frontend knows whether to show
/// the password form or to send people to the platform's sign-in.
async fn auth_mode(
    State(state): State<AppState>,
) -> Json<std::collections::BTreeMap<&'static str, &'static str>> {
    Json([("mode", state.config.auth_mode.as_str())].into())
}

/// In header mode the identity comes from the platform, so the routes that sign in with a
/// password or hand out invites do not exist: 404, before any handler runs.
async fn header_mode_gate(State(state): State<AppState>, request: Request, next: Next) -> Response {
    if state.config.auth_mode == AuthMode::Header && is_password_route(&request) {
        return AppError::NotFound.into_response();
    }
    next.run(request).await
}

fn is_password_route(request: &Request) -> bool {
    let path = request.uri().path().trim_end_matches('/');
    path == "/api/auth/login"
        || path.starts_with("/api/auth/invites")
        || (path.starts_with("/api/users/") && path.ends_with("/invite"))
        || (path.starts_with("/api/campuses/") && path.ends_with("/invite"))
        || (path == "/api/users" && request.method() == Method::POST)
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

    let api = api.route("/auth/mode", get(auth_mode));

    Router::new()
        .nest("/api", api)
        .fallback(|| async { AppError::NotFound })
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            header_mode_gate,
        ))
        .layer(axum::middleware::from_fn(http::json_error_bodies))
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}
