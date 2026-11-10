mod common;

use axum::http::StatusCode;
use serde_json::json;

#[tokio::test]
async fn health_reports_ok() {
    let (status, body) = common::get_json(common::test_app().await, "/api/health").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, json!({ "status": "ok", "database": "ok" }));
}

#[tokio::test]
async fn unknown_route_is_404() {
    let (status, _) = common::get_json(common::test_app().await, "/api/nope").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}
