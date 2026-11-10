//! Seam for the recordings package: it fills this module in (recording and transcript
//! endpoints). Its router is already merged into the classes router.

use australis_core::AppState;
use axum::Router;

pub fn router() -> Router<AppState> {
    Router::new()
}
