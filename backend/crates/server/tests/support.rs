//! "Report a problem": filing, routing to professors or the secretary, and the inbox.

mod common;

use australis_core::Role;
use axum::http::StatusCode;
use common::TestApp;
use serde_json::{json, Value};

fn ids(list: &Value) -> Vec<i64> {
    list.as_array()
        .unwrap()
        .iter()
        .map(|r| r["id"].as_i64().unwrap())
        .collect()
}

#[tokio::test]
async fn report_stores_page_campus_and_text() {
    let app = TestApp::new().await;
    let prof = app.login_as(Role::Professor).await;
    let campus = app.seed_campus(&prof).await;
    let student = app.seed_student(campus).await;
    let (status, report) = app
        .post_json(
            "/api/support/reports",
            Some(&student.cookie),
            json!({"page": "/campuses/1/grades", "campus_id": campus, "text": "  No veo mi nota  "}),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(report["page"], "/campuses/1/grades");
    assert_eq!(report["campus_id"], campus);
    assert_eq!(report["body"], "No veo mi nota");
    assert_eq!(report["status"], "open");
    assert_eq!(report["reporter_name"], student.full_name);
}

#[tokio::test]
async fn needs_sign_in_and_valid_text() {
    let app = TestApp::new().await;
    let student = app.login_as(Role::Student).await;
    let body = json!({"page": "/", "text": "hola"});
    let (status, _) = app.post_json("/api/support/reports", None, body).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    for bad in [
        json!({"page": "/", "text": "   "}),
        json!({"page": "", "text": "x"}),
        json!({"page": "/", "text": "x".repeat(4001)}),
    ] {
        let (status, _) = app
            .post_json("/api/support/reports", Some(&student.cookie), bad)
            .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    }
}

#[tokio::test]
async fn cannot_report_about_a_campus_you_cannot_see() {
    let app = TestApp::new().await;
    let prof = app.login_as(Role::Professor).await;
    let campus = app.seed_campus(&prof).await;
    let outsider = app.login_as(Role::Student).await;
    let (status, _) = app
        .post_json(
            "/api/support/reports",
            Some(&outsider.cookie),
            json!({"page": "/", "campus_id": campus, "text": "x"}),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn campus_report_goes_to_its_professors_and_not_to_others() {
    let app = TestApp::new().await;
    let owner = app.login_as(Role::Professor).await;
    let other_prof = app.login_as(Role::Professor).await;
    let campus = app.seed_campus(&owner).await;
    let other_campus = app.seed_campus(&other_prof).await;
    let guest = app.seed_guest(campus).await;
    let student = app.seed_student(campus).await;
    let secretary = app.login_as(Role::Secretary).await;

    let (_, report) = app
        .post_json(
            "/api/support/reports",
            Some(&student.cookie),
            json!({"page": "/p", "campus_id": campus, "text": "problema"}),
        )
        .await;
    let id = report["id"].as_i64().unwrap();

    for (who, expected) in [
        (&owner, true),
        (&secretary, true),
        (&other_prof, false),
        (&guest, false),
    ] {
        let (status, list) = app.get("/api/support/reports", Some(&who.cookie)).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(ids(&list).contains(&id), expected, "{}", who.email);
    }
    let _ = other_campus;

    // Students have no inbox.
    let (status, _) = app.get("/api/support/reports", Some(&student.cookie)).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn report_without_campus_goes_to_the_secretary_only() {
    let app = TestApp::new().await;
    let prof = app.login_as(Role::Professor).await;
    let secretary = app.login_as(Role::Secretary).await;
    let (_, report) = app
        .post_json(
            "/api/support/reports",
            Some(&prof.cookie),
            json!({"page": "/campuses", "text": "No carga la lista"}),
        )
        .await;
    let id = report["id"].as_i64().unwrap();
    let (_, list) = app
        .get("/api/support/reports", Some(&secretary.cookie))
        .await;
    assert!(ids(&list).contains(&id));
    let (_, list) = app.get("/api/support/reports", Some(&prof.cookie)).await;
    assert!(!ids(&list).contains(&id));
    let (status, _) = app
        .patch_json(
            &format!("/api/support/reports/{id}"),
            Some(&prof.cookie),
            json!({"status": "resolved"}),
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn inbox_filters_open_and_resolved() {
    let app = TestApp::new().await;
    let prof = app.login_as(Role::Professor).await;
    let campus = app.seed_campus(&prof).await;
    let mut created = Vec::new();
    for text in ["uno", "dos"] {
        let (_, r) = app
            .post_json(
                "/api/support/reports",
                Some(&prof.cookie),
                json!({"page": "/", "campus_id": campus, "text": text}),
            )
            .await;
        created.push(r["id"].as_i64().unwrap());
    }
    let (status, done) = app
        .patch_json(
            &format!("/api/support/reports/{}", created[0]),
            Some(&prof.cookie),
            json!({"status": "resolved"}),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(done["status"], "resolved");
    assert!(done["resolved_at"].is_string());

    let (_, open) = app
        .get("/api/support/reports?status=open", Some(&prof.cookie))
        .await;
    assert_eq!(ids(&open), vec![created[1]]);
    let (_, resolved) = app
        .get("/api/support/reports?status=resolved", Some(&prof.cookie))
        .await;
    assert_eq!(ids(&resolved), vec![created[0]]);

    let (_, reopened) = app
        .patch_json(
            &format!("/api/support/reports/{}", created[0]),
            Some(&prof.cookie),
            json!({"status": "open"}),
        )
        .await;
    assert_eq!(reopened["status"], "open");
    assert!(reopened["resolved_at"].is_null());

    let (status, _) = app
        .get("/api/support/reports?status=bogus", Some(&prof.cookie))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn page_must_be_an_in_app_path() {
    let app = TestApp::new().await;
    let student = app.login_as(Role::Student).await;
    for bad in [
        "javascript:alert(1)",
        "https://evil.example/login",
        "//evil.example/login",
        "/\\evil.example",
        "campuses/1",
        "/a\nb",
    ] {
        let (status, _) = app
            .post_json(
                "/api/support/reports",
                Some(&student.cookie),
                json!({"page": bad, "text": "x"}),
            )
            .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "page {bad:?}");
    }
    let (status, _) = app
        .post_json(
            "/api/support/reports",
            Some(&student.cookie),
            json!({"page": "/classes/12?x=1#top", "text": "x"}),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);
}
