mod common;

use australis_core::{
    audit::{self, AuditQuery},
    Role,
};
use axum::http::StatusCode;
use common::{TestApp, TestUser};
use serde_json::{json, Value};

async fn create_class(app: &TestApp, prof: &TestUser, campus: i64, source: &str) -> i64 {
    let mut body = json!({
        "title": "Clase", "starts_at": "2026-11-13 21:00:00", "duration_min": 60
    });
    if source == "manual" {
        body["join_url"] = json!("https://zoom.example/j/1");
    }
    let (status, class) = app
        .post_json(
            &format!("/api/campuses/{campus}/classes"),
            Some(&prof.cookie),
            body,
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{class}");
    class["id"].as_i64().unwrap()
}

fn uri(class: i64) -> String {
    format!("/api/classes/{class}/attendance")
}

async fn save(
    app: &TestApp,
    who: &TestUser,
    class: i64,
    entries: Value,
    reason: Option<&str>,
) -> (StatusCode, Value) {
    app.put_json(
        &uri(class),
        Some(&who.cookie),
        json!({ "entries": entries, "reason": reason }),
    )
    .await
}

async fn audit_rows(app: &TestApp, campus: i64) -> Vec<audit::AuditRecord> {
    let mut conn = app.db.acquire().await.unwrap();
    audit::list(
        &mut conn,
        AuditQuery {
            campus_id: Some(campus),
            entity_prefix: Some("classes.attendance"),
            ..Default::default()
        },
    )
    .await
    .unwrap()
}

fn status_of(sheet: &Value, user: i64) -> Value {
    sheet["rows"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["user_id"] == user)
        .unwrap()["status"]
        .clone()
}

#[tokio::test]
async fn first_save_needs_no_reason_and_is_audited() {
    let app = TestApp::new().await;
    let prof = app.login_as(Role::Professor).await;
    let campus = app.seed_campus(&prof).await;
    let class = create_class(&app, &prof, campus, "placeholder").await;
    let a = app.seed_student(campus).await;
    let b = app.seed_student(campus).await;

    let (status, sheet) = save(
        &app,
        &prof,
        class,
        json!([{"user_id": a.id, "status": "present"}, {"user_id": b.id, "status": "excused"}]),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{sheet}");
    assert_eq!(status_of(&sheet, a.id), "present");
    assert_eq!(status_of(&sheet, b.id), "excused");
    let rows = audit_rows(&app, campus).await;
    assert_eq!(rows.len(), 2);
    assert!(rows.iter().all(|r| r.action == "create"));
    assert_eq!(rows[0].actor_id, Some(prof.id));
}

#[tokio::test]
async fn a_change_needs_a_reason_and_writes_an_audit_row() {
    let app = TestApp::new().await;
    let prof = app.login_as(Role::Professor).await;
    let campus = app.seed_campus(&prof).await;
    let class = create_class(&app, &prof, campus, "placeholder").await;
    let a = app.seed_student(campus).await;
    save(
        &app,
        &prof,
        class,
        json!([{"user_id": a.id, "status": "absent"}]),
        None,
    )
    .await;

    for reason in [
        None,
        Some("   "),
        Some("\u{200B}"),
        Some("\u{FEFF}\u{2060} "),
    ] {
        let (status, body) = save(
            &app,
            &prof,
            class,
            json!([{"user_id": a.id, "status": "present"}]),
            reason,
        )
        .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    }
    let (_, sheet) = app.get(&uri(class), Some(&prof.cookie)).await;
    assert_eq!(status_of(&sheet, a.id), "absent");
    assert_eq!(audit_rows(&app, campus).await.len(), 1);

    let (status, sheet) = save(
        &app,
        &prof,
        class,
        json!([{"user_id": a.id, "status": "excused"}]),
        Some("Presentó certificado médico"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{sheet}");
    assert_eq!(status_of(&sheet, a.id), "excused");
    let rows = audit_rows(&app, campus).await;
    assert_eq!(rows.len(), 2);
    let update = &rows[0];
    assert_eq!(update.action, "update");
    assert_eq!(
        update.reason.as_deref(),
        Some("Presentó certificado médico")
    );
    assert_eq!(update.subject_user_id, Some(a.id));
    assert_eq!(update.before.as_ref().unwrap()["status"], "absent");
    assert_eq!(update.after.as_ref().unwrap()["status"], "excused");

    // Saving the same status again is not a change.
    let (status, _) = save(
        &app,
        &prof,
        class,
        json!([{"user_id": a.id, "status": "excused"}]),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(audit_rows(&app, campus).await.len(), 2);
}

#[tokio::test]
async fn a_rejected_batch_writes_nothing() {
    let app = TestApp::new().await;
    let prof = app.login_as(Role::Professor).await;
    let campus = app.seed_campus(&prof).await;
    let class = create_class(&app, &prof, campus, "placeholder").await;
    let a = app.seed_student(campus).await;
    let outsider = app.login_as(Role::Student).await;

    let (status, _) = save(
        &app,
        &prof,
        class,
        json!([{"user_id": a.id, "status": "present"}, {"user_id": outsider.id, "status": "present"}]),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    let (status, _) = save(
        &app,
        &prof,
        class,
        json!([{"user_id": a.id, "status": "maybe"}]),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    let (_, sheet) = app.get(&uri(class), Some(&prof.cookie)).await;
    assert!(status_of(&sheet, a.id).is_null());
    assert!(audit_rows(&app, campus).await.is_empty());
}

#[tokio::test]
async fn taking_from_the_session_fills_every_student_and_can_be_corrected() {
    let app = TestApp::new().await;
    let prof = app.login_as(Role::Professor).await;
    let campus = app.seed_campus(&prof).await;
    let class = create_class(&app, &prof, campus, "placeholder").await;
    let mut students = Vec::new();
    for _ in 0..6 {
        students.push(app.seed_student(campus).await);
    }

    let (status, taken) = app
        .post_json(
            &format!("{}/from-session", uri(class)),
            Some(&prof.cookie),
            json!({}),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{taken}");
    assert_eq!(taken["simulated"], true);
    assert_eq!(taken["late_after_confirmed"], false);
    assert_eq!(taken["rule"]["confirmed"], false);
    let statuses: Vec<&str> = taken["rows"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["status"].as_str().unwrap())
        .collect();
    assert_eq!(statuses.len(), 6);
    assert_eq!(statuses.iter().filter(|s| **s == "present").count(), 4);
    assert_eq!(statuses.iter().filter(|s| **s == "late").count(), 1);
    assert_eq!(statuses.iter().filter(|s| **s == "absent").count(), 1);
    assert!(taken["rows"]
        .as_array()
        .unwrap()
        .iter()
        .all(|r| r["source"] == "session"));
    assert_eq!(
        taken["unmatched"],
        json!(["Invitado externo (simulado)"]),
        "the guest matches no student"
    );
    assert_eq!(audit_rows(&app, campus).await.len(), 6);

    // Taking it again changes nothing, so no reason is needed.
    let (status, _) = app
        .post_json(
            &format!("{}/from-session", uri(class)),
            Some(&prof.cookie),
            json!({}),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(audit_rows(&app, campus).await.len(), 6);

    // The professor corrects one; that needs a reason.
    let absent = taken["rows"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["status"] == "absent")
        .unwrap()["user_id"]
        .as_i64()
        .unwrap();
    let (status, _) = save(
        &app,
        &prof,
        class,
        json!([{"user_id": absent, "status": "present"}]),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    let (status, sheet) = save(
        &app,
        &prof,
        class,
        json!([{"user_id": absent, "status": "present"}]),
        Some("Se conectó desde otra cuenta"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{sheet}");
    assert_eq!(status_of(&sheet, absent), "present");
    assert_eq!(audit_rows(&app, campus).await.len(), 7);
}

#[tokio::test]
async fn a_class_without_a_meeting_cannot_be_taken_from_the_session() {
    let app = TestApp::new().await;
    let prof = app.login_as(Role::Professor).await;
    let campus = app.seed_campus(&prof).await;
    let class = create_class(&app, &prof, campus, "manual").await;
    app.seed_student(campus).await;
    let (status, body) = app
        .post_json(
            &format!("{}/from-session", uri(class)),
            Some(&prof.cookie),
            json!({}),
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
}

#[tokio::test]
async fn a_student_reads_only_their_own_record_and_cannot_write() {
    let app = TestApp::new().await;
    let prof = app.login_as(Role::Professor).await;
    let campus = app.seed_campus(&prof).await;
    let class = create_class(&app, &prof, campus, "placeholder").await;
    let a = app.seed_student(campus).await;
    let b = app.seed_student(campus).await;
    save(
        &app,
        &prof,
        class,
        json!([{"user_id": a.id, "status": "late"}, {"user_id": b.id, "status": "absent"}]),
        None,
    )
    .await;

    let (status, sheet) = app.get(&uri(class), Some(&a.cookie)).await;
    assert_eq!(status, StatusCode::OK, "{sheet}");
    assert_eq!(sheet["can_teach"], false);
    let rows = sheet["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["user_id"], a.id);
    assert_eq!(rows[0]["status"], "late");

    let (status, _) = save(
        &app,
        &a,
        class,
        json!([{"user_id": a.id, "status": "present"}]),
        Some("x"),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = app
        .post_json(
            &format!("{}/from-session", uri(class)),
            Some(&a.cookie),
            json!({}),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn people_outside_the_campus_and_guests_are_handled() {
    let app = TestApp::new().await;
    let prof = app.login_as(Role::Professor).await;
    let campus = app.seed_campus(&prof).await;
    let class = create_class(&app, &prof, campus, "placeholder").await;
    let a = app.seed_student(campus).await;
    let guest = app.seed_guest(campus).await;
    let outsider = app.login_as(Role::Student).await;
    let other_prof = app.login_as(Role::Professor).await;

    let (status, _) = app.get(&uri(class), Some(&outsider.cookie)).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = save(
        &app,
        &other_prof,
        class,
        json!([{"user_id": a.id, "status": "present"}]),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = app.get(&uri(class), None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _) = app.get(&uri(9999), Some(&prof.cookie)).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    let (status, sheet) = save(
        &app,
        &guest,
        class,
        json!([{"user_id": a.id, "status": "present"}]),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{sheet}");
}

#[tokio::test]
async fn a_suspended_student_is_not_listed_and_the_record_stays() {
    let app = TestApp::new().await;
    let prof = app.login_as(Role::Professor).await;
    let campus = app.seed_campus(&prof).await;
    let class = create_class(&app, &prof, campus, "placeholder").await;
    let a = app.seed_student(campus).await;
    save(
        &app,
        &prof,
        class,
        json!([{"user_id": a.id, "status": "present"}]),
        None,
    )
    .await;
    {
        let mut conn = app.db.acquire().await.unwrap();
        australis_core::directory::suspend_member(
            &mut conn,
            prof.id,
            campus,
            a.id,
            "Baja de prueba",
        )
        .await
        .unwrap();
    }
    let (_, sheet) = app.get(&uri(class), Some(&prof.cookie)).await;
    assert!(sheet["rows"].as_array().unwrap().is_empty());
    let (status, _) = save(
        &app,
        &prof,
        class,
        json!([{"user_id": a.id, "status": "absent"}]),
        Some("x"),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    let kept: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM classes_attendance")
        .fetch_one(&app.db)
        .await
        .unwrap();
    assert_eq!(kept, 1);
}

#[tokio::test]
async fn a_second_take_from_the_session_keeps_manual_corrections() {
    let app = TestApp::new().await;
    let prof = app.login_as(Role::Professor).await;
    let campus = app.seed_campus(&prof).await;
    let class = create_class(&app, &prof, campus, "placeholder").await;
    for _ in 0..6 {
        app.seed_student(campus).await;
    }
    let url = format!("{}/from-session", uri(class));
    let (status, taken) = app.post_json(&url, Some(&prof.cookie), json!({})).await;
    assert_eq!(status, StatusCode::OK, "{taken}");
    let absent = taken["rows"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["status"] == "absent")
        .unwrap()["user_id"]
        .as_i64()
        .unwrap();
    let (status, sheet) = save(
        &app,
        &prof,
        class,
        json!([{"user_id": absent, "status": "excused"}]),
        Some("Avisó que faltaba"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{sheet}");
    let audits = audit_rows(&app, campus).await.len();

    let (status, again) = app.post_json(&url, Some(&prof.cookie), json!({})).await;
    assert_eq!(status, StatusCode::OK, "{again}");
    assert_eq!(status_of(&again, absent), "excused");
    let row = again["rows"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["user_id"] == absent)
        .unwrap();
    assert_eq!(row["source"], "manual");
    assert_eq!(audit_rows(&app, campus).await.len(), audits);
}

#[tokio::test]
async fn the_secretary_reads_and_writes_on_a_campus_she_is_not_a_member_of() {
    let app = TestApp::new().await;
    let prof = app.login_as(Role::Professor).await;
    let secretary = app.login_as(Role::Secretary).await;
    let campus = app.seed_campus(&prof).await;
    let class = create_class(&app, &prof, campus, "placeholder").await;
    let student = app.seed_student(campus).await;

    let (status, sheet) = app.get(&uri(class), Some(&secretary.cookie)).await;
    assert_eq!(status, StatusCode::OK, "{sheet}");
    assert_eq!(sheet["can_teach"], true);
    let (status, sheet) = save(
        &app,
        &secretary,
        class,
        json!([{"user_id": student.id, "status": "present"}]),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{sheet}");
    let (status, _) = save(
        &app,
        &secretary,
        class,
        json!([{"user_id": student.id, "status": "late"}]),
        Some("Corrección de secretaría"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, taken) = app
        .post_json(
            &format!("{}/from-session", uri(class)),
            Some(&secretary.cookie),
            json!({ "reason": "Sesión" }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{taken}");

    // A professor who is not a member of the campus is refused on every route.
    let outsider = app.login_as(Role::Professor).await;
    let (status, _) = app.get(&uri(class), Some(&outsider.cookie)).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = save(
        &app,
        &outsider,
        class,
        json!([{"user_id": student.id, "status": "absent"}]),
        Some("x"),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = app
        .post_json(
            &format!("{}/from-session", uri(class)),
            Some(&outsider.cookie),
            json!({}),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}
