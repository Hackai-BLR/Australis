//! `auth` module skeleton. The auth package adds its routes here; the server already mounts
//! this router under `/api`.

use australis_core::AppState;
use axum::Router;

pub fn router() -> Router<AppState> {
    Router::new()
}
