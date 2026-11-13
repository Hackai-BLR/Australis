//! `admin` module: the secretary's cross-campus screens (F13). Skeleton: the feature fills
//! it in. Read the lists through `australis_core::directory` (`list_campus_summaries`,
//! `list_memberships_of_user`), never with its own SQL on `core_*` tables.

use australis_core::AppState;
use axum::Router;

pub fn router() -> Router<AppState> {
    Router::new()
}
