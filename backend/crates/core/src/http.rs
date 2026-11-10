//! HTTP helpers shared by the modules.

use axum::extract::DefaultBodyLimit;

use crate::config::{mb_to_bytes, DEFAULT_MAX_UPLOAD_MB};

/// The body limit for upload routes. Axum stops a request body at 2 MB by default, which is
/// too small for spreadsheets and presentations; add this layer to each upload route:
///
/// ```ignore
/// Router::new().route("/campuses/{id}/presentations", post(upload).layer(upload_body_limit()))
/// ```
///
/// A module builds its router before the app state exists, so this reads `MAX_UPLOAD_MB`
/// from the environment itself (same variable and default as `Config::max_upload_mb`).
pub fn upload_body_limit() -> DefaultBodyLimit {
    let mb = std::env::var("MAX_UPLOAD_MB")
        .ok()
        .and_then(|raw| raw.trim().parse::<u64>().ok())
        .filter(|mb| *mb > 0)
        .unwrap_or(DEFAULT_MAX_UPLOAD_MB);
    DefaultBodyLimit::max(mb_to_bytes(mb))
}
