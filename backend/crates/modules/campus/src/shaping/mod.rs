//! Seam for the AI shaping package. It owns this folder and fills in the routes; the router is
//! already merged into the campus router. Every write it makes must go through
//! `crate::save_document`.

use australis_core::AppState;
use axum::Router;

pub fn router() -> Router<AppState> {
    Router::new()
}
