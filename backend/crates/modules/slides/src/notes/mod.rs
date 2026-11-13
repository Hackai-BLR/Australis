//! Seam for F15 (notes per slide). Empty on purpose: the feature fills in this folder.

use australis_core::AppState;
use axum::Router;

/// Merged into the crate router already; the feature adds its routes here and edits no
/// other file of the crate except its slot in `lib.rs` if it needs a new submodule.
pub fn router() -> Router<AppState> {
    Router::new()
}
