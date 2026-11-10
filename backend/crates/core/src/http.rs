//! HTTP helpers shared by the modules.

use axum::{
    body::to_bytes,
    extract::{DefaultBodyLimit, Request},
    http::{
        header::{CONTENT_LENGTH, CONTENT_TYPE},
        StatusCode,
    },
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};

/// Middleware that makes every error body `{"error": "<message>"}`. Axum's own rejections
/// (malformed JSON, a bad path parameter, a wrong method, a body over the limit) are plain
/// text or empty; this rewrites any 4xx/5xx response that is not already JSON. `app()` applies
/// it, so handlers may use `axum::Json`, `Path` and `Multipart` directly.
pub async fn json_error_bodies(request: Request, next: Next) -> Response {
    let response = next.run(request).await;
    let status = response.status();
    if !(status.is_client_error() || status.is_server_error()) {
        return response;
    }
    let is_json = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.starts_with("application/json"));
    if is_json {
        return response;
    }
    let (parts, body) = response.into_parts();
    let detail = match to_bytes(body, 8 * 1024).await {
        Ok(bytes) => String::from_utf8_lossy(&bytes).trim().to_string(),
        Err(_) => String::new(),
    };
    let message = if status == StatusCode::PAYLOAD_TOO_LARGE {
        "the request body is too large".to_string()
    } else if status.is_server_error() {
        "internal error".to_string()
    } else if detail.is_empty() {
        status
            .canonical_reason()
            .unwrap_or("request failed")
            .to_lowercase()
    } else {
        detail
    };
    let mut response = (status, Json(serde_json::json!({ "error": message }))).into_response();
    // Keep headers such as `Allow` (405) and `Set-Cookie`; the body headers are new.
    for (name, value) in parts.headers.iter() {
        if *name != CONTENT_TYPE && *name != CONTENT_LENGTH {
            response.headers_mut().append(name.clone(), value.clone());
        }
    }
    response
}

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
