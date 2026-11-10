//! Test helpers shared by all integration tests.

use axum::{
    body::Body,
    http::{Request, StatusCode},
    Router,
};
use hackai_core::AppState;
use http_body_util::BodyExt;
use tower::ServiceExt;

/// App backed by a fresh in-memory SQLite with all migrations applied.
pub async fn test_app() -> Router {
    let db = hackai_server::init_db("sqlite::memory:")
        .await
        .expect("init test db");
    hackai_server::app(AppState { db })
}

/// Sends a GET and returns the status and the JSON body.
pub async fn get_json(app: Router, uri: &str) -> (StatusCode, serde_json::Value) {
    let response = app
        .oneshot(Request::get(uri).body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let json = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
    (status, json)
}
