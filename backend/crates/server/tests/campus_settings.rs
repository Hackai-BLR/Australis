mod common;

use australis_core::Role;
use axum::http::StatusCode;
use common::TestApp;
use serde_json::{json, Value};

fn find<'a>(body: &'a Value, key: &str) -> &'a Value {
    body["settings"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["key"] == key)
        .unwrap()
}

#[tokio::test]
async fn inherits_global_values_and_marks_unconfirmed() {
    let app = TestApp::new().await;
    let prof = app.login_as(Role::Professor).await;
    let campus = app.seed_campus(&prof).await;
    let (status, body) = app
        .get(
            &format!("/api/campuses/{campus}/settings"),
            Some(&prof.cookie),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    for key in ["grading.scale", "grading.final_rule", "attendance.rule"] {
        let entry = find(&body, key);
        assert_eq!(entry["source"], "global", "{key}");
        assert_eq!(entry["unconfirmed"], true, "{key}");
        assert_eq!(entry["value"], entry["global_value"]);
    }
    assert_eq!(find(&body, "grading.scale")["value"]["pass"], 4.0);
}

#[tokio::test]
async fn override_replaces_value_for_one_campus_only_and_is_audited() {
    let app = TestApp::new().await;
    let prof = app.login_as(Role::Professor).await;
    let campus = app.seed_campus(&prof).await;
    let other = app.seed_campus(&prof).await;
    let (status, body) = app
        .put_json(
            &format!("/api/campuses/{campus}/settings/grading.scale"),
            Some(&prof.cookie),
            json!({ "value": { "min": 0, "max": 100, "pass": 60, "confirmed": true },
                    "reason": "Escala del posgrado" }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["source"], "campus");
    assert_eq!(body["unconfirmed"], false);
    assert_eq!(body["global_value"]["max"], 10.0);

    let (_, body) = app
        .get(
            &format!("/api/campuses/{campus}/settings"),
            Some(&prof.cookie),
        )
        .await;
    assert_eq!(find(&body, "grading.scale")["value"]["pass"], 60.0);
    let change = &body["changes"][0];
    assert_eq!(change["action"], "update");
    assert_eq!(change["key"], "grading.scale");
    assert_eq!(change["reason"], "Escala del posgrado");
    assert!(change["before"].is_null());
    assert_eq!(change["after"]["pass"], 60.0);
    assert!(change["actor_name"].is_string());

    let (_, body) = app
        .get(
            &format!("/api/campuses/{other}/settings"),
            Some(&prof.cookie),
        )
        .await;
    assert_eq!(find(&body, "grading.scale")["source"], "global");
    assert!(body["changes"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn an_override_without_confirmation_stays_unconfirmed() {
    let app = TestApp::new().await;
    let prof = app.login_as(Role::Professor).await;
    let campus = app.seed_campus(&prof).await;
    let (status, body) = app
        .put_json(
            &format!("/api/campuses/{campus}/settings/attendance.rule"),
            Some(&prof.cookie),
            json!({ "value": { "min_percent": 80 }, "reason": "Pedido del coordinador" }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["source"], "campus");
    assert_eq!(body["unconfirmed"], true);
    assert_eq!(body["value"]["min_percent"], 80.0);
}

#[tokio::test]
async fn reset_returns_to_inherited_and_is_audited() {
    let app = TestApp::new().await;
    let prof = app.login_as(Role::Professor).await;
    let campus = app.seed_campus(&prof).await;
    let url = format!("/api/campuses/{campus}/settings/attendance.rule");
    let (status, _) = app
        .post_json(
            &format!("{url}/reset"),
            Some(&prof.cookie),
            json!({ "reason": "nada que volver" }),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT);

    app.put_json(
        &url,
        Some(&prof.cookie),
        json!({ "value": { "min_percent": 50 }, "reason": "Prueba" }),
    )
    .await;
    let (status, body) = app
        .post_json(
            &format!("{url}/reset"),
            Some(&prof.cookie),
            json!({ "reason": "Volver al valor general" }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["source"], "global");

    let (_, body) = app
        .get(
            &format!("/api/campuses/{campus}/settings"),
            Some(&prof.cookie),
        )
        .await;
    let changes = body["changes"].as_array().unwrap();
    assert_eq!(changes.len(), 2);
    assert_eq!(changes[0]["action"], "clear");
    assert_eq!(changes[0]["reason"], "Volver al valor general");
    assert_eq!(find(&body, "attendance.rule")["source"], "global");
}

#[tokio::test]
async fn invalid_values_and_missing_reason_are_refused() {
    let app = TestApp::new().await;
    let prof = app.login_as(Role::Professor).await;
    let campus = app.seed_campus(&prof).await;
    let scale = format!("/api/campuses/{campus}/settings/grading.scale");
    let cases = [
        (
            &scale,
            json!({ "value": { "min": 10, "max": 1, "pass": 4 }, "reason": "x" }),
        ),
        (
            &scale,
            json!({ "value": { "min": 1, "max": 10, "pass": 11 }, "reason": "x" }),
        ),
        (
            &scale,
            json!({ "value": { "min": 1, "max": 10, "pass": 4 }, "reason": "  " }),
        ),
        (
            &format!("/api/campuses/{campus}/settings/grading.final_rule"),
            json!({ "value": { "kind": "median" }, "reason": "x" }),
        ),
        (
            &format!("/api/campuses/{campus}/settings/attendance.rule"),
            json!({ "value": { "min_percent": 140 }, "reason": "x" }),
        ),
    ];
    for (url, body) in cases {
        let (status, response) = app.put_json(url, Some(&prof.cookie), body.clone()).await;
        assert_eq!(
            status,
            StatusCode::UNPROCESSABLE_ENTITY,
            "{body} {response}"
        );
    }
    let (status, _) = app
        .put_json(
            &format!("/api/campuses/{campus}/settings/ai.shaping.daily_quota"),
            Some(&prof.cookie),
            json!({ "value": { "kind": "x" }, "reason": "x" }),
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (_, body) = app
        .get(
            &format!("/api/campuses/{campus}/settings"),
            Some(&prof.cookie),
        )
        .await;
    assert!(body["changes"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn only_manage_access_reads_or_writes() {
    let app = TestApp::new().await;
    let prof = app.login_as(Role::Professor).await;
    let campus = app.seed_campus(&prof).await;
    let guest = app.seed_guest(campus).await;
    let student = app.seed_student(campus).await;
    let stranger = app.login_as(Role::Professor).await;
    let secretary = app.login_as(Role::Secretary).await;
    let url = format!("/api/campuses/{campus}/settings");
    let put_url = format!("{url}/grading.scale");
    let body = json!({ "value": { "min": 1, "max": 10, "pass": 5 }, "reason": "Prueba" });

    for user in [&guest, &student, &stranger] {
        let (status, _) = app.get(&url, Some(&user.cookie)).await;
        assert!(
            status == StatusCode::FORBIDDEN || status == StatusCode::NOT_FOUND,
            "{status}"
        );
        let (status, _) = app
            .put_json(&put_url, Some(&user.cookie), body.clone())
            .await;
        assert!(
            status == StatusCode::FORBIDDEN || status == StatusCode::NOT_FOUND,
            "{status}"
        );
    }
    let (status, _) = app.get(&url, None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    let (status, _) = app.get(&url, Some(&secretary.cookie)).await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = app.put_json(&put_url, Some(&secretary.cookie), body).await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn the_override_is_the_value_the_kernel_reads_and_the_audit_row_is_the_kernel_s() {
    let app = TestApp::new().await;
    let prof = app.login_as(Role::Professor).await;
    let campus = app.seed_campus(&prof).await;
    let other = app.seed_campus(&prof).await;
    let (status, body) = app
        .put_json(
            &format!("/api/campuses/{campus}/settings/grading.scale"),
            Some(&prof.cookie),
            json!({ "value": { "min": 0, "max": 100, "pass": 60 }, "reason": "Escala" }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, _) = app
        .put_json(
            &format!("/api/campuses/{campus}/settings/attendance.rule"),
            Some(&prof.cookie),
            json!({ "value": { "min_percent": 80 }, "reason": "Asistencia" }),
        )
        .await;
    assert_eq!(status, StatusCode::OK);

    let mut conn = app.db.acquire().await.unwrap();
    let scale = australis_core::settings::grading_scale(&mut conn, campus)
        .await
        .unwrap();
    assert_eq!((scale.min, scale.max, scale.pass), (0.0, 100.0, 60.0));
    let rule = australis_core::settings::attendance_rule(&mut conn, campus)
        .await
        .unwrap();
    assert_eq!(rule.min_percent, 80.0);
    let untouched = australis_core::settings::grading_scale(&mut conn, other)
        .await
        .unwrap();
    assert_eq!(untouched.max, 10.0);
    let rows: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM core_audit_log WHERE entity = 'campus.setting' AND campus_id = ?",
    )
    .bind(campus)
    .fetch_one(&mut *conn)
    .await
    .unwrap();
    assert_eq!(rows, 2);
}

#[tokio::test]
async fn a_scale_that_leaves_stored_scores_outside_it_is_refused() {
    let app = TestApp::new().await;
    let prof = app.login_as(Role::Professor).await;
    let campus = app.seed_campus(&prof).await;
    let student = app.seed_student(campus).await;
    let mut conn = app.db.acquire().await.unwrap();
    sqlx::query("INSERT INTO grades_items (id, campus_id, title) VALUES (1, ?, 'TP')")
        .bind(campus)
        .execute(&mut *conn)
        .await
        .unwrap();
    sqlx::query("INSERT INTO grades_entries (item_id, student_id, score) VALUES (1, ?, 8)")
        .bind(student.id)
        .execute(&mut *conn)
        .await
        .unwrap();
    drop(conn);
    let url = format!("/api/campuses/{campus}/settings/grading.scale");
    let (status, body) = app
        .put_json(
            &url,
            Some(&prof.cookie),
            json!({ "value": { "min": 1, "max": 5, "pass": 3 }, "reason": "Escala" }),
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    let (_, body) = app
        .get(
            &format!("/api/campuses/{campus}/settings"),
            Some(&prof.cookie),
        )
        .await;
    assert_eq!(find(&body, "grading.scale")["source"], "global");
    assert!(body["changes"].as_array().unwrap().is_empty());
}
