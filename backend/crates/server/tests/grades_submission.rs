mod common;

use australis_core::Role;
use axum::http::StatusCode;
use common::{TestApp, TestUser};
use serde_json::{json, Value};

struct Setup {
    app: TestApp,
    prof: TestUser,
    secretary: TestUser,
    campus: i64,
}

async fn setup() -> Setup {
    let app = TestApp::new().await;
    let prof = app.login_as(Role::Professor).await;
    let secretary = app.login_as(Role::Secretary).await;
    let campus = app.seed_campus(&prof).await;
    Setup {
        app,
        prof,
        secretary,
        campus,
    }
}

impl Setup {
    fn url(&self, tail: &str) -> String {
        format!("/api/campuses/{}/grades/submission{tail}", self.campus)
    }

    async fn post(&self, who: &TestUser, tail: &str, body: Value) -> (StatusCode, Value) {
        self.app
            .post_json(&self.url(tail), Some(&who.cookie), body)
            .await
    }

    async fn status(&self) -> String {
        let (code, body) = self.app.get(&self.url(""), Some(&self.prof.cookie)).await;
        assert_eq!(code, StatusCode::OK, "{body}");
        body["status"].as_str().unwrap().to_string()
    }

    async fn audit(&self, action: &str) -> i64 {
        sqlx::query_scalar(
            "SELECT COUNT(*) FROM core_audit_log WHERE entity = 'grades.submission' AND action = ?",
        )
        .bind(action)
        .fetch_one(&self.app.db)
        .await
        .unwrap()
    }
}

#[tokio::test]
async fn a_new_campus_is_a_draft() {
    let s = setup().await;
    assert_eq!(s.status().await, "draft");
}

#[tokio::test]
async fn teacher_sends_and_secretary_checks() {
    let s = setup().await;
    let (code, body) = s.post(&s.prof, "/send", json!({})).await;
    assert_eq!(code, StatusCode::OK, "{body}");
    assert_eq!(body["status"], "sent");
    let (code, body) = s.post(&s.secretary, "/check", json!({})).await;
    assert_eq!(code, StatusCode::OK, "{body}");
    assert_eq!(body["status"], "checked");
    assert_eq!(s.status().await, "checked");
    assert_eq!(s.audit("send").await, 1);
    assert_eq!(s.audit("check").await, 1);
}

#[tokio::test]
async fn return_needs_a_note_and_goes_back_to_draft() {
    let s = setup().await;
    s.post(&s.prof, "/send", json!({})).await;
    let (code, _) = s.post(&s.secretary, "/return", json!({})).await;
    assert_eq!(code, StatusCode::UNPROCESSABLE_ENTITY);
    let (code, body) = s
        .post(
            &s.secretary,
            "/return",
            json!({ "note": "Falta el parcial" }),
        )
        .await;
    assert_eq!(code, StatusCode::OK, "{body}");
    assert_eq!(body["status"], "draft");
    assert_eq!(body["note"], "Falta el parcial");
    let reason: String = sqlx::query_scalar(
        "SELECT reason FROM core_audit_log WHERE entity = 'grades.submission' AND action = 'return'",
    )
    .fetch_one(&s.app.db)
    .await
    .unwrap();
    assert_eq!(reason, "Falta el parcial");
    // The teacher can send again.
    let (code, _) = s.post(&s.prof, "/send", json!({})).await;
    assert_eq!(code, StatusCode::OK);
}

#[tokio::test]
async fn a_checked_campus_can_be_returned() {
    let s = setup().await;
    s.post(&s.prof, "/send", json!({})).await;
    s.post(&s.secretary, "/check", json!({})).await;
    let (code, body) = s
        .post(
            &s.secretary,
            "/return",
            json!({ "note": "Error en un acta" }),
        )
        .await;
    assert_eq!(code, StatusCode::OK, "{body}");
    assert_eq!(s.status().await, "draft");
}

#[tokio::test]
async fn invalid_transitions_are_conflicts() {
    let s = setup().await;
    let (code, _) = s.post(&s.secretary, "/check", json!({})).await;
    assert_eq!(code, StatusCode::CONFLICT);
    let (code, _) = s
        .post(&s.secretary, "/return", json!({ "note": "x" }))
        .await;
    assert_eq!(code, StatusCode::CONFLICT);
    s.post(&s.prof, "/send", json!({})).await;
    let (code, _) = s.post(&s.prof, "/send", json!({})).await;
    assert_eq!(code, StatusCode::CONFLICT);
    assert_eq!(s.audit("send").await, 1);
}

#[tokio::test]
async fn only_the_secretary_checks_or_returns() {
    let s = setup().await;
    s.post(&s.prof, "/send", json!({})).await;
    let (code, _) = s.post(&s.prof, "/check", json!({})).await;
    assert_eq!(code, StatusCode::FORBIDDEN);
    let (code, _) = s.post(&s.prof, "/return", json!({ "note": "x" })).await;
    assert_eq!(code, StatusCode::FORBIDDEN);
    assert_eq!(s.status().await, "sent");
}

#[tokio::test]
async fn students_and_outsiders_cannot_send_or_read() {
    let s = setup().await;
    let student = s.app.seed_student(s.campus).await;
    let outsider = s.app.login_as(Role::Professor).await;
    for who in [&student, &outsider] {
        let (code, _) = s.post(who, "/send", json!({})).await;
        assert_eq!(code, StatusCode::FORBIDDEN);
        let (code, _) = s.app.get(&s.url(""), Some(&who.cookie)).await;
        assert_eq!(code, StatusCode::FORBIDDEN);
    }
    let (code, _) = s.app.get(&s.url(""), None).await;
    assert_eq!(code, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn a_guest_teacher_can_send() {
    let s = setup().await;
    let guest = s.app.seed_guest(s.campus).await;
    let (code, body) = s.post(&guest, "/send", json!({})).await;
    assert_eq!(code, StatusCode::OK, "{body}");
}

#[tokio::test]
async fn the_secretary_lists_every_campus_status() {
    let s = setup().await;
    let other = s.app.seed_campus(&s.prof).await;
    s.post(&s.prof, "/send", json!({})).await;
    let (code, body) = s
        .app
        .get("/api/grades/submissions", Some(&s.secretary.cookie))
        .await;
    assert_eq!(code, StatusCode::OK, "{body}");
    let rows = body["campuses"].as_array().unwrap();
    let status_of = |id: i64| {
        rows.iter()
            .find(|r| r["campus_id"] == id)
            .map(|r| r["status"].as_str().unwrap().to_string())
    };
    assert_eq!(status_of(s.campus).as_deref(), Some("sent"));
    assert_eq!(status_of(other).as_deref(), Some("draft"));

    let (code, _) = s
        .app
        .get("/api/grades/submissions", Some(&s.prof.cookie))
        .await;
    assert_eq!(code, StatusCode::FORBIDDEN);
}
