//! `support` module: the "report a problem" inbox (F16). Skeleton: the feature fills it in.
//! Its tables use the prefix `support_` and the migration range 0660 to 0669.

use australis_core::AppState;
use axum::Router;

pub fn router() -> Router<AppState> {
    Router::new()
}
