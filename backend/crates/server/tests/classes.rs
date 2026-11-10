mod common;

use australis_core::Role;
use axum::http::StatusCode;
use common::{TestApp, TestUser};
use serde_json::{json, Value};

/// A SQLite expression evaluated on the test database, for example a shifted timestamp.
async fn sql_text(app: &TestApp, sql: &str, bind: &str) -> String {
    sqlx::query_scalar(sql)
        .bind(bind)
        .fetch_one(&app.db)
        .await
        .unwrap()
}

async fn utc_now(app: &TestApp) -> String {
    sql_text(app, "SELECT datetime('now', ?)", "+0 minutes").await
}

async fn create(app: &TestApp, user: &TestUser, campus: i64, body: Value) -> (StatusCode, Value) {
    app.post_json(
        &format!("/api/campuses/{campus}/classes"),
        Some(&user.cookie),
        body,
    )
    .await
}

fn class_body(starts_at: &str) -> Value {
    json!({ "title": "Clase 1", "starts_at": starts_at, "duration_min": 90 })
}

async fn set_offset(app: &TestApp, minutes: i64) {
    sqlx::query("UPDATE core_settings SET value_json = ? WHERE key = 'app.utc_offset_minutes'")
        .bind(minutes.to_string())
        .execute(&app.db)
        .await
        .unwrap();
}

#[tokio::test]
async fn creating_a_class_stores_the_join_url_from_the_provider() {
    let app = TestApp::new().await;
    let professor = app.login_as(Role::Professor).await;
    let campus = app.seed_campus(&professor).await;

    let (status, body) = create(&app, &professor, campus, class_body("2026-11-13T21:00:00Z")).await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    assert_eq!(body["source"], "placeholder");
    assert_eq!(body["simulated"], true);
    assert_eq!(body["starts_at"], "2026-11-13 21:00:00");
    assert_eq!(body["recording_status"], "none");
    let join = body["join_url"].as_str().unwrap();
    assert!(join.contains("/simulado/zoom/"), "{join}");
    assert!(body["start_url"].as_str().unwrap().contains("anfitrion=1"));

    let id = body["id"].as_i64().unwrap();
    let (status, fetched) = app
        .get(&format!("/api/classes/{id}"), Some(&professor.cookie))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(fetched["join_url"], join);
}

#[tokio::test]
async fn manual_link_is_stored_as_given_and_only_http_is_accepted() {
    let app = TestApp::new().await;
    let professor = app.login_as(Role::Professor).await;
    let campus = app.seed_campus(&professor).await;

    let mut body = class_body("2026-11-13 21:00:00");
    body["join_url"] = json!("https://zoom.us/j/123456789?pwd=abc");
    let (status, created) = create(&app, &professor, campus, body).await;
    assert_eq!(status, StatusCode::CREATED, "{created}");
    assert_eq!(created["source"], "manual");
    assert_eq!(created["simulated"], false);
    assert_eq!(created["join_url"], "https://zoom.us/j/123456789?pwd=abc");
    assert!(created["start_url"].is_null());

    for bad in [
        "javascript:alert(1)",
        "ftp://x.test/a",
        "https://",
        "https://a b",
    ] {
        let mut body = class_body("2026-11-13 21:00:00");
        body["join_url"] = json!(bad);
        let (status, err) = create(&app, &professor, campus, body).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{bad}: {err}");
        assert!(err["error"].is_string());
    }
}

#[tokio::test]
async fn invalid_fields_are_rejected() {
    let app = TestApp::new().await;
    let professor = app.login_as(Role::Professor).await;
    let campus = app.seed_campus(&professor).await;
    for body in [
        json!({ "title": " ", "starts_at": "2026-11-13 21:00:00", "duration_min": 60 }),
        json!({ "title": "x", "starts_at": "mañana", "duration_min": 60 }),
        json!({ "title": "x", "starts_at": "2026-11-13 21:00:00", "duration_min": 0 }),
    ] {
        let (status, _) = create(&app, &professor, campus, body).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    }
}

#[tokio::test]
async fn start_url_never_reaches_a_student() {
    let app = TestApp::new().await;
    let professor = app.login_as(Role::Professor).await;
    let campus = app.seed_campus(&professor).await;
    let student = app.seed_student(campus).await;
    let now = utc_now(&app).await;
    let (_, created) = create(&app, &professor, campus, class_body(&now)).await;
    let id = created["id"].as_i64().unwrap();
    let start = created["start_url"].as_str().unwrap().to_string();

    let (_, one) = app
        .get(&format!("/api/classes/{id}"), Some(&student.cookie))
        .await;
    let (_, list) = app
        .get(
            &format!("/api/campuses/{campus}/classes"),
            Some(&student.cookie),
        )
        .await;
    let (_, today) = app.get("/api/classes/today", Some(&student.cookie)).await;
    assert_eq!(today.as_array().unwrap().len(), 1);
    for body in [&one, &list, &today] {
        assert!(!body.to_string().contains(&start), "{body}");
        assert!(!body.to_string().contains("anfitrion"), "{body}");
    }
    assert_eq!(one["can_teach"], false);
    assert_eq!(list.as_array().unwrap().len(), 1);

    // A teacher still gets it.
    let (_, as_prof) = app
        .get(&format!("/api/classes/{id}"), Some(&professor.cookie))
        .await;
    assert_eq!(as_prof["start_url"], start.as_str());
}

#[tokio::test]
async fn guest_can_create_student_cannot_and_non_member_gets_403() {
    let app = TestApp::new().await;
    let professor = app.login_as(Role::Professor).await;
    let campus = app.seed_campus(&professor).await;
    let guest = app.seed_guest(campus).await;
    let student = app.seed_student(campus).await;
    let outsider = app.login_as(Role::Professor).await;
    let outside_student = app.login_as(Role::Student).await;

    let (status, created) = create(&app, &guest, campus, class_body("2026-11-13 21:00:00")).await;
    assert_eq!(status, StatusCode::CREATED);
    let id = created["id"].as_i64().unwrap();
    let (status, _) = create(&app, &student, campus, class_body("2026-11-13 21:00:00")).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = create(&app, &outsider, campus, class_body("2026-11-13 21:00:00")).await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    for user in [&outsider, &outside_student] {
        let (status, _) = app
            .get(
                &format!("/api/campuses/{campus}/classes"),
                Some(&user.cookie),
            )
            .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        let (status, _) = app
            .get(&format!("/api/classes/{id}"), Some(&user.cookie))
            .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
    }
    let (status, _) = app.get("/api/classes/99999", Some(&guest.cookie)).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = app.get("/api/classes/today", None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    // Patch: teachers yes, students no.
    let (status, patched) = app
        .patch_json(
            &format!("/api/classes/{id}"),
            Some(&guest.cookie),
            json!({ "title": "Clase 1 bis", "ended": true }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{patched}");
    assert_eq!(patched["title"], "Clase 1 bis");
    assert!(patched["ended_at"].is_string());
    let (status, _) = app
        .patch_json(
            &format!("/api/classes/{id}"),
            Some(&student.cookie),
            json!({ "title": "no" }),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn today_returns_only_the_callers_campuses() {
    let app = TestApp::new().await;
    let professor = app.login_as(Role::Professor).await;
    let other_professor = app.login_as(Role::Professor).await;
    let mine = app.seed_campus(&professor).await;
    let theirs = app.seed_campus(&other_professor).await;
    let student = app.seed_student(mine).await;
    // "Now" is today whatever the offset is.
    let now = utc_now(&app).await;
    create(&app, &professor, mine, class_body(&now)).await;
    create(&app, &other_professor, theirs, class_body(&now)).await;

    for user in [&professor, &student] {
        let (status, body) = app.get("/api/classes/today", Some(&user.cookie)).await;
        assert_eq!(status, StatusCode::OK);
        let list = body.as_array().unwrap();
        assert_eq!(list.len(), 1, "{body}");
        assert_eq!(list[0]["campus_id"], mine);
    }
    let secretary = app.login_as(Role::Secretary).await;
    let (_, body) = app.get("/api/classes/today", Some(&secretary.cookie)).await;
    assert_eq!(body.as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn today_respects_the_utc_offset_around_midnight() {
    let app = TestApp::new().await;
    let professor = app.login_as(Role::Professor).await;
    let campus = app.seed_campus(&professor).await;
    set_offset(&app, -180).await;

    // 23:30 local today is already the next day in UTC.
    let local_today = sql_text(&app, "SELECT date('now', ?)", "-180 minutes").await;
    let late = sql_text(
        &app,
        "SELECT datetime(?, '+180 minutes')",
        &format!("{local_today} 23:30:00"),
    )
    .await;
    // 00:30 local tomorrow is not today.
    let early_tomorrow = sql_text(
        &app,
        "SELECT datetime(?, '+180 minutes', '+1 day')",
        &format!("{local_today} 00:30:00"),
    )
    .await;
    // 00:30 local today (03:30 UTC) is today.
    let early_today = sql_text(
        &app,
        "SELECT datetime(?, '+180 minutes')",
        &format!("{local_today} 00:30:00"),
    )
    .await;
    for starts_at in [&late, &early_tomorrow, &early_today] {
        let (status, body) = create(&app, &professor, campus, class_body(starts_at)).await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
    }

    let (_, body) = app.get("/api/classes/today", Some(&professor.cookie)).await;
    let starts: Vec<&str> = body
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["starts_at"].as_str().unwrap())
        .collect();
    assert_eq!(starts, vec![early_today.as_str(), late.as_str()]);

    // With a UTC clock the same 23:30-local class belongs to the next UTC day.
    set_offset(&app, 0).await;
    let (_, body) = app.get("/api/classes/today", Some(&professor.cookie)).await;
    let utc_today = sql_text(&app, "SELECT date('now', ?)", "+0 minutes").await;
    for class in body.as_array().unwrap() {
        assert!(class["starts_at"].as_str().unwrap().starts_with(&utc_today));
    }
}

#[tokio::test]
async fn zoom_connection_is_recorded_for_teachers_only() {
    let app = TestApp::new().await;
    let professor = app.login_as(Role::Professor).await;
    let student = app.login_as(Role::Student).await;

    let (status, body) = app
        .get("/api/zoom/connection", Some(&professor.cookie))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["connected"], false);
    assert_eq!(body["simulated"], true);
    let (status, body) = app
        .post_json("/api/zoom/connection", Some(&professor.cookie), json!({}))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["connected"], true);
    let (_, body) = app
        .get("/api/zoom/connection", Some(&professor.cookie))
        .await;
    assert_eq!(body["connected"], true);

    let (status, _) = app.get("/api/zoom/connection", Some(&student.cookie)).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = app
        .post_json("/api/zoom/connection", Some(&student.cookie), json!({}))
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}
