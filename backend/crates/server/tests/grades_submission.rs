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

#[tokio::test]
async fn a_send_clears_the_previous_return_note() {
    let s = setup().await;
    s.post(&s.prof, "/send", json!({})).await;
    s.post(
        &s.secretary,
        "/return",
        json!({ "note": "Falta el parcial" }),
    )
    .await;
    let (code, body) = s.post(&s.prof, "/send", json!({})).await;
    assert_eq!(code, StatusCode::OK, "{body}");
    assert_eq!(body["status"], "sent");
    assert!(body["note"].is_null(), "{body}");
    let note: Option<String> =
        sqlx::query_scalar("SELECT note FROM grades_submissions WHERE campus_id = ?")
            .bind(s.campus)
            .fetch_one(&s.app.db)
            .await
            .unwrap();
    assert_eq!(note, None);
}

#[tokio::test]
async fn the_sender_cannot_check_their_own_send() {
    let s = setup().await;
    // The secretary may teach any campus, so she can send; she cannot also check it.
    let (code, _) = s.post(&s.secretary, "/send", json!({})).await;
    assert_eq!(code, StatusCode::OK);
    let (code, _) = s.post(&s.secretary, "/check", json!({})).await;
    assert_eq!(code, StatusCode::FORBIDDEN);
    assert_eq!(s.status().await, "sent");
    assert_eq!(s.audit("check").await, 0);
    let other = s.app.login_as(Role::Secretary).await;
    let (code, body) = s.post(&other, "/check", json!({})).await;
    assert_eq!(code, StatusCode::OK, "{body}");
    assert_eq!(s.status().await, "checked");
}

impl Setup {
    async fn grade(&self, who: &TestUser, item: i64, student: i64, score: f64, reason: &str) {
        let (code, body) = self
            .app
            .put_json(
                &format!("/api/campuses/{}/gradebook/entries", self.campus),
                Some(&who.cookie),
                json!({ "entries": [{ "item_id": item, "student_id": student, "score": score }],
                        "reason": reason }),
            )
            .await;
        assert_eq!(code, StatusCode::OK, "{body}");
    }

    async fn item(&self) -> i64 {
        let (code, body) = self
            .app
            .post_json(
                &format!("/api/campuses/{}/gradebook/items", self.campus),
                Some(&self.prof.cookie),
                json!({ "title": "Parcial", "weight": 1.0 }),
            )
            .await;
        assert_eq!(code, StatusCode::OK, "{body}");
        body["id"].as_i64().unwrap()
    }
}

#[tokio::test]
async fn editing_grades_after_sending_goes_back_to_draft_with_an_audit_row() {
    let s = setup().await;
    let student = s.app.seed_student(s.campus).await;
    let item = s.item().await;
    s.grade(&s.prof, item, student.id, 7.0, "").await;
    s.post(&s.prof, "/send", json!({})).await;
    assert_eq!(s.status().await, "sent");

    s.grade(&s.prof, item, student.id, 8.0, "corrección").await;
    assert_eq!(s.status().await, "draft");
    let (actor, before, after, reason): (i64, String, String, String) = sqlx::query_as(
        "SELECT actor_id, before_json, after_json, reason FROM core_audit_log
         WHERE entity = 'grades.submission' AND action = 'edit'",
    )
    .fetch_one(&s.app.db)
    .await
    .unwrap();
    assert_eq!(actor, s.prof.id);
    assert!(before.contains("sent"), "{before}");
    assert!(after.contains("draft"), "{after}");
    assert_eq!(reason, "grades edited after sending");

    // A checked campus also goes back to draft; an edit on a draft adds no audit row.
    s.post(&s.prof, "/send", json!({})).await;
    s.post(&s.secretary, "/check", json!({})).await;
    s.grade(&s.prof, item, student.id, 9.0, "otra").await;
    assert_eq!(s.status().await, "draft");
    s.grade(&s.prof, item, student.id, 6.0, "otra").await;
    assert_eq!(s.audit("edit").await, 2);
}

#[tokio::test]
async fn a_save_that_changes_nothing_keeps_the_status() {
    let s = setup().await;
    let student = s.app.seed_student(s.campus).await;
    let item = s.item().await;
    s.grade(&s.prof, item, student.id, 7.0, "").await;
    s.post(&s.prof, "/send", json!({})).await;
    s.grade(&s.prof, item, student.id, 7.0, "igual").await;
    assert_eq!(s.status().await, "sent");
}

#[tokio::test]
async fn changing_an_item_after_sending_goes_back_to_draft() {
    let s = setup().await;
    let item = s.item().await;
    s.post(&s.prof, "/send", json!({})).await;
    let (code, body) = s
        .app
        .patch_json(
            &format!("/api/gradebook/items/{item}"),
            Some(&s.prof.cookie),
            json!({ "weight": 2.0 }),
        )
        .await;
    assert_eq!(code, StatusCode::OK, "{body}");
    assert_eq!(s.status().await, "draft");
}

#[tokio::test]
async fn the_list_is_limited_to_a_university_administrators_campuses() {
    let s = setup().await;
    let admin = s.app.login_as(Role::Secretary).await;
    let other_prof = s.app.login_as(Role::Professor).await;
    let theirs = s.app.seed_campus(&other_prof).await;
    {
        let mut conn = s.app.db.acquire().await.unwrap();
        australis_core::directory::set_university(&mut conn, admin.id, Some("uni-a"), true)
            .await
            .unwrap();
        for (campus, uni) in [(s.campus, "uni-a"), (theirs, "uni-b")] {
            sqlx::query("UPDATE core_campuses SET university = ? WHERE id = ?")
                .bind(uni)
                .bind(campus)
                .execute(&mut *conn)
                .await
                .unwrap();
        }
    }
    let (code, body) = s
        .app
        .get("/api/grades/submissions", Some(&admin.cookie))
        .await;
    assert_eq!(code, StatusCode::OK, "{body}");
    let ids: Vec<i64> = body["campuses"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["campus_id"].as_i64().unwrap())
        .collect();
    assert_eq!(ids, vec![s.campus]);
}
