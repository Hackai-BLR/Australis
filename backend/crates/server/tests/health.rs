mod common;

use axum::{
    body::Body,
    http::{Method, StatusCode},
};
use common::TestApp;
use serde_json::json;

#[tokio::test]
async fn health_reports_ok() {
    let app = TestApp::new().await;
    let (status, body) = app.get("/api/health", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, json!({ "status": "ok", "database": "ok" }));
}

#[tokio::test]
async fn unknown_route_is_a_json_404() {
    let app = TestApp::new().await;
    for uri in ["/api/nope", "/nope"] {
        let (status, body) = app.get(uri, None).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{uri}");
        assert_eq!(body, json!({ "error": "not found" }), "{uri}");
    }
}

#[tokio::test]
async fn no_cors_headers_are_sent() {
    let app = TestApp::new().await;
    let request = common::request(Method::GET, "/api/health", None)
        .header("Origin", "https://elsewhere.example")
        .body(Body::empty())
        .unwrap();
    let response = app.send(request).await;
    assert_eq!(response.status, StatusCode::OK);
    assert!(response.header("access-control-allow-origin").is_none());
}
