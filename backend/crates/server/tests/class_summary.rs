mod common;

use australis_core::Role;
use axum::http::StatusCode;
use common::{TestApp, TestUser};
use serde_json::{json, Value};

const PAST: &str = "2020-01-01 10:00:00";
const FUTURE: &str = "2099-01-01 10:00:00";

async fn create_class(app: &TestApp, prof: &TestUser, campus: i64, starts_at: &str) -> i64 {
    let (status, body) = app
        .post_json(
            &format!("/api/campuses/{campus}/classes"),
            Some(&prof.cookie),
            json!({ "title": "Clase", "starts_at": starts_at, "duration_min": 60 }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    body["id"].as_i64().unwrap()
}

/// A finished class: reading it publishes the simulated recording and transcript.
async fn finished_class(app: &TestApp, prof: &TestUser, campus: i64) -> i64 {
    let id = create_class(app, prof, campus, PAST).await;
    let (status, _) = app
        .get(&format!("/api/classes/{id}"), Some(&prof.cookie))
        .await;
    assert_eq!(status, StatusCode::OK);
    id
}

async fn generate(app: &TestApp, user: &TestUser, id: i64) -> (StatusCode, Value) {
    app.post_json(
        &format!("/api/classes/{id}/summary/generate"),
        Some(&user.cookie),
        json!({}),
    )
    .await
}

async fn summary(app: &TestApp, user: &TestUser, id: i64) -> Value {
    let (status, body) = app
        .get(&format!("/api/classes/{id}/summary"), Some(&user.cookie))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body
}

/// Approves the text the professor saw (`body`), the way the screen does.
async fn approve(app: &TestApp, user: &TestUser, id: i64, body: &str) -> (StatusCode, Value) {
    app.post_json(
        &format!("/api/classes/{id}/summary/approve"),
        Some(&user.cookie),
        json!({ "body": body }),
    )
    .await
}

async fn count(app: &TestApp, sql: &str) -> i64 {
    sqlx::query_scalar(sql).fetch_one(&app.db).await.unwrap()
}

#[tokio::test]
async fn generating_makes_a_simulated_draft_with_key_points_and_tasks() {
    let app = TestApp::new().await;
    let prof = app.login_as(Role::Professor).await;
    let campus = app.seed_campus(&prof).await;
    let id = finished_class(&app, &prof, campus).await;

    let before = summary(&app, &prof, id).await;
    assert_eq!(before["status"], "none");
    assert_eq!(before["transcript_ready"], true);

    let (status, body) = generate(&app, &prof, id).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["status"], "draft");
    assert_eq!(body["simulated"], true);
    let text = body["body"].as_str().unwrap();
    assert!(text.contains("Puntos clave"), "{text}");
    assert!(text.contains("Tareas para la próxima clase"), "{text}");
}

#[tokio::test]
async fn a_class_without_a_transcript_cannot_be_summarized() {
    let app = TestApp::new().await;
    let prof = app.login_as(Role::Professor).await;
    let campus = app.seed_campus(&prof).await;
    let id = create_class(&app, &prof, campus, FUTURE).await;

    let (status, body) = generate(&app, &prof, id).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(count(&app, "SELECT COUNT(*) FROM core_ai_usage").await, 0);
}

#[tokio::test]
async fn students_see_the_summary_only_after_approval() {
    let app = TestApp::new().await;
    let prof = app.login_as(Role::Professor).await;
    let campus = app.seed_campus(&prof).await;
    let student = app.seed_student(campus).await;
    let id = finished_class(&app, &prof, campus).await;
    generate(&app, &prof, id).await;

    let seen = summary(&app, &student, id).await;
    assert_eq!(seen["status"], "none");
    assert!(seen["body"].is_null());
    assert!(seen["quota"].is_null());

    let text = summary(&app, &prof, id).await["body"]
        .as_str()
        .unwrap()
        .to_string();
    let (status, approved) = approve(&app, &prof, id, &text).await;
    assert_eq!(status, StatusCode::OK, "{approved}");
    assert_eq!(approved["status"], "approved");

    let seen = summary(&app, &student, id).await;
    assert_eq!(seen["status"], "approved");
    assert!(seen["body"].as_str().unwrap().contains("Puntos clave"));
    assert_eq!(seen["simulated"], true);
    assert_eq!(seen["can_teach"], false);
}

#[tokio::test]
async fn editing_changes_the_draft_and_unpublishes_an_approved_summary() {
    let app = TestApp::new().await;
    let prof = app.login_as(Role::Professor).await;
    let campus = app.seed_campus(&prof).await;
    let student = app.seed_student(campus).await;
    let id = finished_class(&app, &prof, campus).await;
    generate(&app, &prof, id).await;

    let uri = format!("/api/classes/{id}/summary");
    let (status, edited) = app
        .put_json(&uri, Some(&prof.cookie), json!({ "body": "Texto propio" }))
        .await;
    assert_eq!(status, StatusCode::OK, "{edited}");
    assert_eq!(edited["body"], "Texto propio");
    assert_eq!(edited["status"], "draft");

    approve(&app, &prof, id, "Texto propio").await;
    assert_eq!(summary(&app, &student, id).await["body"], "Texto propio");

    let (status, _) = app
        .put_json(&uri, Some(&prof.cookie), json!({ "body": "Otra versión" }))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(summary(&app, &student, id).await["status"], "none");

    let (status, _) = app
        .put_json(&uri, Some(&prof.cookie), json!({ "body": "   " }))
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
}

#[tokio::test]
async fn an_approved_summary_is_not_overwritten_by_generating_again() {
    let app = TestApp::new().await;
    let prof = app.login_as(Role::Professor).await;
    let campus = app.seed_campus(&prof).await;
    let id = finished_class(&app, &prof, campus).await;
    generate(&app, &prof, id).await;
    let text = summary(&app, &prof, id).await["body"]
        .as_str()
        .unwrap()
        .to_string();
    approve(&app, &prof, id, &text).await;

    let (status, _) = generate(&app, &prof, id).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(count(&app, "SELECT COUNT(*) FROM core_ai_usage").await, 1);
}

#[tokio::test]
async fn generating_over_an_edited_draft_needs_confirmation() {
    let app = TestApp::new().await;
    let prof = app.login_as(Role::Professor).await;
    let campus = app.seed_campus(&prof).await;
    let id = finished_class(&app, &prof, campus).await;
    generate(&app, &prof, id).await;
    let uri = format!("/api/classes/{id}/summary");
    app.put_json(&uri, Some(&prof.cookie), json!({ "body": "Texto propio" }))
        .await;

    let (status, _) = generate(&app, &prof, id).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(summary(&app, &prof, id).await["body"], "Texto propio");
    assert_eq!(count(&app, "SELECT COUNT(*) FROM core_ai_usage").await, 1);

    let (status, body) = app
        .post_json(
            &format!("{uri}/generate"),
            Some(&prof.cookie),
            json!({ "overwrite": true }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_ne!(body["body"], "Texto propio");
    assert!(body["edited_at"].is_null());
}

#[tokio::test]
async fn students_and_outsiders_cannot_generate_edit_or_approve() {
    let app = TestApp::new().await;
    let prof = app.login_as(Role::Professor).await;
    let campus = app.seed_campus(&prof).await;
    let student = app.seed_student(campus).await;
    let outsider = app.login_as(Role::Professor).await;
    let id = finished_class(&app, &prof, campus).await;
    generate(&app, &prof, id).await;

    let uri = format!("/api/classes/{id}/summary");
    for user in [&student, &outsider] {
        let (status, _) = generate(&app, user, id).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        let (status, _) = app
            .put_json(&uri, Some(&user.cookie), json!({ "body": "x" }))
            .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        let (status, _) = approve(&app, user, id, "x").await;
        assert_eq!(status, StatusCode::FORBIDDEN);
    }
    let (status, _) = app.get(&uri, Some(&outsider.cookie)).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = app.get(&uri, None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(summary(&app, &prof, id).await["status"], "draft");
}

#[tokio::test]
async fn generating_uses_its_own_daily_quota_and_writes_the_usage_log() {
    let app = TestApp::new().await;
    let prof = app.login_as(Role::Professor).await;
    let campus = app.seed_campus(&prof).await;
    let id = finished_class(&app, &prof, campus).await;
    sqlx::query("UPDATE core_settings SET value_json = '2' WHERE key = 'ai.summary.daily_quota'")
        .execute(&app.db)
        .await
        .unwrap();

    for _ in 0..2 {
        let (status, body) = generate(&app, &prof, id).await;
        assert_eq!(status, StatusCode::OK, "{body}");
    }
    let (status, body) = generate(&app, &prof, id).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{body}");
    assert!(
        body["error"].as_str().unwrap().contains("límite diario"),
        "{body}"
    );

    let view = summary(&app, &prof, id).await;
    assert_eq!(view["quota"]["limit"], 2);
    assert_eq!(view["quota"]["used"], 2);
    assert_eq!(view["quota"]["remaining"], 0);

    assert_eq!(
        count(
            &app,
            "SELECT COUNT(*) FROM core_ai_usage WHERE feature = 'summary' AND status = 'ok'
             AND simulated = 1"
        )
        .await,
        2
    );
    assert_eq!(
        count(
            &app,
            "SELECT COUNT(*) FROM core_ai_usage WHERE feature = 'summary' AND status = 'refused'"
        )
        .await,
        1
    );
    // The shaping quota is separate.
    assert_eq!(
        count(
            &app,
            "SELECT COUNT(*) FROM core_ai_quota WHERE feature <> 'summary'"
        )
        .await,
        0
    );
}

#[tokio::test]
async fn the_summary_never_touches_grades_or_attendance() {
    let app = TestApp::new().await;
    let prof = app.login_as(Role::Professor).await;
    let campus = app.seed_campus(&prof).await;
    let id = finished_class(&app, &prof, campus).await;
    let audit_before = count(&app, "SELECT COUNT(*) FROM core_audit_log").await;
    generate(&app, &prof, id).await;
    assert_eq!(
        count(&app, "SELECT COUNT(*) FROM core_audit_log").await,
        audit_before
    );
}

#[tokio::test]
async fn approving_a_text_that_changed_since_it_was_seen_is_refused() {
    let app = TestApp::new().await;
    let prof = app.login_as(Role::Professor).await;
    let campus = app.seed_campus(&prof).await;
    let student = app.seed_student(campus).await;
    let id = finished_class(&app, &prof, campus).await;
    generate(&app, &prof, id).await;
    let seen = summary(&app, &prof, id).await["body"]
        .as_str()
        .unwrap()
        .to_string();

    // Another session edits the draft after the professor loaded it.
    let (status, _) = app
        .put_json(
            &format!("/api/classes/{id}/summary"),
            Some(&prof.cookie),
            json!({ "body": "Otra versión" }),
        )
        .await;
    assert_eq!(status, StatusCode::OK);

    let (status, body) = approve(&app, &prof, id, &seen).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(summary(&app, &prof, id).await["status"], "draft");
    assert_eq!(summary(&app, &student, id).await["status"], "none");

    let (status, body) = approve(&app, &prof, id, "Otra versión").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(summary(&app, &student, id).await["body"], "Otra versión");
}

#[tokio::test]
async fn the_simulated_flag_goes_away_once_the_professor_edits_the_text() {
    let app = TestApp::new().await;
    let prof = app.login_as(Role::Professor).await;
    let campus = app.seed_campus(&prof).await;
    let id = finished_class(&app, &prof, campus).await;
    generate(&app, &prof, id).await;
    assert_eq!(summary(&app, &prof, id).await["simulated"], true);

    let (status, edited) = app
        .put_json(
            &format!("/api/classes/{id}/summary"),
            Some(&prof.cookie),
            json!({ "body": "Escrito a mano por completo" }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{edited}");
    assert_eq!(edited["simulated"], false);
    assert!(edited["edited_at"].is_string());
    assert_eq!(summary(&app, &prof, id).await["simulated"], false);

    // The usage log still says the draft was simulated.
    assert_eq!(
        count(
            &app,
            "SELECT COUNT(*) FROM core_ai_usage WHERE simulated = 1"
        )
        .await,
        1
    );

    // Generating again over the edit brings the badge back with the new AI draft.
    let (status, again) = app
        .post_json(
            &format!("/api/classes/{id}/summary/generate"),
            Some(&prof.cookie),
            json!({ "overwrite": true }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{again}");
    assert_eq!(again["simulated"], true);
}
