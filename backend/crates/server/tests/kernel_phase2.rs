//! Kernel additions of the phase 2 kickoff: campus-scoped settings, the Zoom participant
//! list, the directory lists of the secretary and the scripted class summary.

mod common;

use australis_core::{
    ai::{self, AiRequest, FEATURE_SUMMARY},
    audit::{self, AuditQuery},
    directory::{self, MemberRole, MemberStatus},
    settings::{self, AttendanceRule, GradingScale},
    zoom::{Invitee, PLACEHOLDER_GUEST_NAME},
    Role,
};
use axum::http::StatusCode;
use common::TestApp;
use serde_json::json;

fn scale_0_100() -> serde_json::Value {
    json!({ "min": 0, "max": 100, "pass": 60, "confirmed": true })
}

// ---------------------------------------------------------------------------------------
// Settings per campus
// ---------------------------------------------------------------------------------------

#[tokio::test]
async fn a_campus_without_an_override_reads_the_global_value() {
    let app = TestApp::new().await;
    let prof = app.login_as(Role::Professor).await;
    let campus = app.seed_campus(&prof).await;
    let mut conn = app.db.acquire().await.unwrap();

    let scale = settings::grading_scale(&mut conn, campus).await.unwrap();
    assert_eq!((scale.min, scale.max, scale.pass), (1.0, 10.0, 4.0));
    assert!(!scale.confirmed);
    assert_eq!(
        settings::final_rule(&mut conn, campus).await.unwrap().kind,
        "weighted_mean"
    );
    assert_eq!(
        settings::campus_override(&mut conn, campus, settings::GRADING_SCALE)
            .await
            .unwrap(),
        None
    );
}

#[tokio::test]
async fn an_override_applies_to_its_campus_only_and_clearing_it_restores_the_global_value() {
    let app = TestApp::new().await;
    let prof = app.login_as(Role::Professor).await;
    let a = app.seed_campus(&prof).await;
    let b = app.seed_campus(&prof).await;
    let mut conn = app.db.acquire().await.unwrap();

    settings::set_for_campus(
        &mut conn,
        prof.id,
        a,
        settings::GRADING_SCALE,
        &scale_0_100(),
        Some("posgrado con escala de 100"),
    )
    .await
    .unwrap();
    let on_a = settings::grading_scale(&mut conn, a).await.unwrap();
    assert_eq!((on_a.min, on_a.max, on_a.pass), (0.0, 100.0, 60.0));
    assert!(on_a.confirmed);
    let on_b = settings::grading_scale(&mut conn, b).await.unwrap();
    assert_eq!(on_b.max, 10.0, "another campus keeps the global scale");

    // Changing the global value moves the campuses that inherit it, not the one that overrides.
    sqlx::query("UPDATE core_settings SET value_json = ? WHERE scope = 'global' AND key = ?")
        .bind(r#"{"min":1,"max":7,"pass":4,"confirmed":true}"#)
        .bind(settings::GRADING_SCALE)
        .execute(&app.db)
        .await
        .unwrap();
    assert_eq!(
        settings::grading_scale(&mut conn, a).await.unwrap().max,
        100.0
    );
    assert_eq!(
        settings::grading_scale(&mut conn, b).await.unwrap().max,
        7.0
    );

    settings::clear_for_campus(&mut conn, prof.id, a, settings::GRADING_SCALE, None)
        .await
        .unwrap();
    assert_eq!(
        settings::grading_scale(&mut conn, a).await.unwrap().max,
        7.0
    );

    // The generic reader gives the same answer for a typed value.
    let rule: AttendanceRule = settings::get_for_campus(&mut conn, a, settings::ATTENDANCE_RULE)
        .await
        .unwrap();
    assert_eq!(rule.min_percent, 75.0);
}

#[tokio::test]
async fn setting_and_clearing_an_override_are_audited_with_who_and_why() {
    let app = TestApp::new().await;
    let prof = app.login_as(Role::Professor).await;
    let campus = app.seed_campus(&prof).await;
    let mut conn = app.db.acquire().await.unwrap();

    let rule = json!({ "min_percent": 80, "confirmed": true });
    settings::set_for_campus(
        &mut conn,
        prof.id,
        campus,
        settings::ATTENDANCE_RULE,
        &rule,
        Some("pide el programa"),
    )
    .await
    .unwrap();
    let rule2 = json!({ "min_percent": 70, "confirmed": true });
    settings::set_for_campus(
        &mut conn,
        prof.id,
        campus,
        settings::ATTENDANCE_RULE,
        &rule2,
        None,
    )
    .await
    .unwrap();
    settings::clear_for_campus(
        &mut conn,
        prof.id,
        campus,
        settings::ATTENDANCE_RULE,
        Some("vuelve al valor general"),
    )
    .await
    .unwrap();
    // Clearing what is not overridden records nothing.
    settings::clear_for_campus(&mut conn, prof.id, campus, settings::ATTENDANCE_RULE, None)
        .await
        .unwrap();

    let mut rows = audit::list(
        &mut conn,
        AuditQuery {
            campus_id: Some(campus),
            entity_prefix: Some("campus.setting"),
            ..AuditQuery::default()
        },
    )
    .await
    .unwrap();
    rows.sort_by_key(|row| row.id);
    assert_eq!(rows.len(), 3);
    assert_eq!(rows[0].action, "update");
    assert_eq!(rows[0].actor_id, Some(prof.id));
    assert_eq!(rows[0].reason.as_deref(), Some("pide el programa"));
    assert_eq!(rows[0].before, None);
    assert_eq!(
        rows[0].after,
        Some(json!({ "key": "attendance.rule", "value": rule }))
    );
    assert_eq!(
        rows[1].before,
        Some(json!({ "key": "attendance.rule", "value": rule }))
    );
    assert_eq!(rows[2].action, "clear");
    assert_eq!(rows[2].after, None);
    assert_eq!(rows[2].reason.as_deref(), Some("vuelve al valor general"));
}

#[tokio::test]
async fn bad_overrides_are_refused_and_change_nothing() {
    let app = TestApp::new().await;
    let prof = app.login_as(Role::Professor).await;
    let campus = app.seed_campus(&prof).await;
    let mut conn = app.db.acquire().await.unwrap();

    let cases = [
        // Not a key a campus may override.
        (settings::AI_SHAPING_DAILY_QUOTA, json!(1000)),
        // An inverted scale, a pass mark outside it, the wrong shape.
        (
            settings::GRADING_SCALE,
            json!({ "min": 10, "max": 1, "pass": 4 }),
        ),
        (
            settings::GRADING_SCALE,
            json!({ "min": 1, "max": 10, "pass": 11 }),
        ),
        (settings::GRADING_SCALE, json!("alta")),
        (settings::GRADING_FINAL_RULE, json!({ "kind": "median" })),
        (settings::ATTENDANCE_RULE, json!({ "min_percent": 140 })),
    ];
    for (key, value) in cases {
        let err = settings::set_for_campus(&mut conn, prof.id, campus, key, &value, None)
            .await
            .unwrap_err();
        assert_eq!(
            err.status(),
            StatusCode::UNPROCESSABLE_ENTITY,
            "{key} {value}"
        );
    }
    let err =
        settings::clear_for_campus(&mut conn, prof.id, campus, "app.utc_offset_minutes", None)
            .await
            .unwrap_err();
    assert_eq!(err.status(), StatusCode::UNPROCESSABLE_ENTITY);

    let err = settings::set_for_campus(
        &mut conn,
        prof.id,
        9999,
        settings::GRADING_SCALE,
        &scale_0_100(),
        None,
    )
    .await
    .unwrap_err();
    assert_eq!(err.status(), StatusCode::NOT_FOUND);

    let stored: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM core_settings WHERE scope LIKE 'campus:%'")
            .fetch_one(&app.db)
            .await
            .unwrap();
    assert_eq!(stored, 0);
    let audited: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM core_audit_log WHERE entity = 'campus.setting'")
            .fetch_one(&app.db)
            .await
            .unwrap();
    assert_eq!(audited, 0);
}

#[tokio::test]
async fn an_override_inside_a_rolled_back_transaction_leaves_nothing_behind() {
    let app = TestApp::new().await;
    let prof = app.login_as(Role::Professor).await;
    let campus = app.seed_campus(&prof).await;

    let mut tx = australis_core::begin_write(&app.db).await.unwrap();
    settings::set_for_campus(
        &mut tx,
        prof.id,
        campus,
        settings::GRADING_SCALE,
        &scale_0_100(),
        None,
    )
    .await
    .unwrap();
    tx.rollback().await.unwrap();

    let mut conn = app.db.acquire().await.unwrap();
    assert_eq!(
        settings::grading_scale(&mut conn, campus)
            .await
            .unwrap()
            .max,
        10.0
    );
    let audited: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM core_audit_log WHERE entity = 'campus.setting'")
            .fetch_one(&app.db)
            .await
            .unwrap();
    assert_eq!(audited, 0, "the audit row belongs to the same transaction");
}

#[tokio::test]
async fn the_gradebook_and_my_grades_use_each_campuss_own_scale() {
    let app = TestApp::new().await;
    let prof = app.login_as(Role::Professor).await;
    let a = app.seed_campus(&prof).await;
    let b = app.seed_campus(&prof).await;
    let student = app.seed_student(a).await;
    app.add_member(b, &student, MemberRole::Student).await;
    {
        let mut conn = app.db.acquire().await.unwrap();
        settings::set_for_campus(
            &mut conn,
            prof.id,
            a,
            settings::GRADING_SCALE,
            &scale_0_100(),
            None,
        )
        .await
        .unwrap();
    }

    let mut items = Vec::new();
    for campus in [a, b] {
        let (status, body) = app
            .post_json(
                &format!("/api/campuses/{campus}/gradebook/items"),
                Some(&prof.cookie),
                json!({ "title": "Parcial", "weight": 1.0 }),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        items.push(body["id"].as_i64().unwrap());
    }

    for (campus, item) in [a, b].into_iter().zip(&items) {
        let (_, book) = app
            .get(
                &format!("/api/campuses/{campus}/gradebook"),
                Some(&prof.cookie),
            )
            .await;
        let expected = if campus == a { 100.0 } else { 10.0 };
        assert_eq!(book["scale"]["max"], expected);
        let (status, _) = app
            .put_json(
                &format!("/api/campuses/{campus}/gradebook/entries"),
                Some(&prof.cookie),
                json!({ "entries": [{ "item_id": item, "student_id": student.id, "score": 55 }] }),
            )
            .await;
        // 55 fits a scale of 100 but not a scale of 10.
        assert_eq!(
            status,
            if campus == a {
                StatusCode::OK
            } else {
                StatusCode::UNPROCESSABLE_ENTITY
            }
        );
    }

    let (status, mine) = app.get("/api/grades/mine", Some(&student.cookie)).await;
    assert_eq!(status, StatusCode::OK);
    let scales: Vec<(i64, f64)> = mine["courses"]
        .as_array()
        .unwrap()
        .iter()
        .map(|course| {
            (
                course["campus_id"].as_i64().unwrap(),
                course["scale"]["max"].as_f64().unwrap(),
            )
        })
        .collect();
    assert!(
        scales.contains(&(a, 100.0)) && scales.contains(&(b, 10.0)),
        "{scales:?}"
    );
    assert_eq!(
        mine["scale"]["max"], 10.0,
        "the top-level scale is the global one"
    );
}

#[tokio::test]
async fn phase_2_settings_are_seeded_and_unconfirmed() {
    let app = TestApp::new().await;
    let mut conn = app.db.acquire().await.unwrap();
    let rule = settings::attendance_rule(&mut conn, 1).await.unwrap();
    assert_eq!(rule.min_percent, 75.0);
    assert!(!rule.confirmed, "the default attendance rule is a guess");
    let quota: i64 = settings::get(&mut conn, settings::AI_SUMMARY_DAILY_QUOTA)
        .await
        .unwrap();
    assert_eq!(quota, 20);
    let scale: GradingScale = settings::get(&mut conn, settings::GRADING_SCALE)
        .await
        .unwrap();
    assert!(!scale.confirmed);
}

// ---------------------------------------------------------------------------------------
// Zoom participants
// ---------------------------------------------------------------------------------------

#[tokio::test]
async fn placeholder_participants_come_from_the_campus_members() {
    let app = TestApp::new().await;
    let prof = app.login_as(Role::Professor).await;
    let campus = app.seed_campus(&prof).await;
    let mut students = Vec::new();
    for _ in 0..5 {
        students.push(app.seed_student(campus).await);
    }

    let mut conn = app.db.acquire().await.unwrap();
    let invitees: Vec<Invitee> = directory::list_members(&mut conn, campus)
        .await
        .unwrap()
        .into_iter()
        .filter(|member| member.role == MemberRole::Student)
        .map(|member| Invitee {
            user_id: member.user_id,
            email: member.email,
            full_name: member.full_name,
        })
        .collect();
    assert_eq!(invitees.len(), 5);

    assert!(app.state.zoom.is_placeholder());
    let list = app
        .state
        .zoom
        .fetch_participants("12345678901", &invitees)
        .await
        .unwrap();
    // Four of the five students joined, plus the made-up guest.
    assert_eq!(list.len(), 5);
    let joined: Vec<&str> = list.iter().filter_map(|p| p.email.as_deref()).collect();
    assert_eq!(joined.len(), 4);
    for email in joined {
        assert!(students.iter().any(|s| s.email == email));
    }
    assert_eq!(list.last().unwrap().name, PLACEHOLDER_GUEST_NAME);
    // The placeholder reads nothing but what it is given.
    let none = app.state.zoom.fetch_participants("1", &[]).await.unwrap();
    assert_eq!(none.len(), 1);
}

// ---------------------------------------------------------------------------------------
// Directory lists of the secretary
// ---------------------------------------------------------------------------------------

#[tokio::test]
async fn the_secretary_lists_every_campus_with_member_counts() {
    let app = TestApp::new().await;
    let secretary = app.login_as(Role::Secretary).await;
    let prof = app.login_as(Role::Professor).await;
    let campus_a = app.seed_campus(&prof).await;
    let campus_b = app.seed_campus(&prof).await;
    let guest = app.seed_guest(campus_a).await;
    let s1 = app.seed_student(campus_a).await;
    let _s2 = app.seed_student(campus_a).await;
    let _s3 = app.seed_student(campus_b).await;
    let mut conn = app.db.acquire().await.unwrap();
    directory::suspend_member(&mut conn, prof.id, campus_a, s1.id, "baja")
        .await
        .unwrap();

    let list = directory::list_campus_summaries(&mut conn, &secretary.current())
        .await
        .unwrap();
    assert_eq!(list.len(), 2);
    let a = list.iter().find(|c| c.id == campus_a).unwrap();
    assert_eq!(
        (a.professors, a.guests, a.students, a.suspended),
        (1, 1, 1, 1),
        "a suspended student is counted as suspended, not as a student"
    );
    let b = list.iter().find(|c| c.id == campus_b).unwrap();
    assert_eq!(
        (b.professors, b.guests, b.students, b.suspended),
        (1, 0, 1, 0)
    );
    let _ = guest;

    // A campus nobody joined still shows, with zeros.
    let empty = {
        let owner = app.login_as(Role::Secretary).await;
        directory::create_campus(&mut conn, owner.id, "Vacío", owner.id)
            .await
            .unwrap()
    };
    let list = directory::list_campus_summaries(&mut conn, &secretary.current())
        .await
        .unwrap();
    let vacio = list.iter().find(|c| c.id == empty.id).unwrap();
    assert_eq!(
        (vacio.professors, vacio.students, vacio.suspended),
        (1, 0, 0)
    );
}

#[tokio::test]
async fn the_directory_lists_are_for_the_secretary_only() {
    let app = TestApp::new().await;
    let prof = app.login_as(Role::Professor).await;
    let student = app.login_as(Role::Student).await;
    let mut conn = app.db.acquire().await.unwrap();
    for actor in [&prof, &student] {
        let err = directory::list_campus_summaries(&mut conn, &actor.current())
            .await
            .unwrap_err();
        assert_eq!(err.status(), StatusCode::FORBIDDEN);
        let err = directory::list_memberships_of_user(&mut conn, &actor.current(), student.id)
            .await
            .unwrap_err();
        assert_eq!(err.status(), StatusCode::FORBIDDEN);
    }
}

#[tokio::test]
async fn the_secretary_lists_all_memberships_of_a_user() {
    let app = TestApp::new().await;
    let secretary = app.login_as(Role::Secretary).await;
    let prof = app.login_as(Role::Professor).await;
    let a = app.seed_campus(&prof).await;
    let b = app.seed_campus(&prof).await;
    let c = app.seed_campus(&prof).await;
    let student = app.seed_student(a).await;
    app.add_member(b, &student, MemberRole::Student).await;
    let mut conn = app.db.acquire().await.unwrap();
    directory::suspend_member(&mut conn, prof.id, b, student.id, "licencia")
        .await
        .unwrap();

    let list = directory::list_memberships_of_user(&mut conn, &secretary.current(), student.id)
        .await
        .unwrap();
    let ids: Vec<i64> = list.iter().map(|m| m.campus_id).collect();
    assert_eq!(ids, vec![a, b], "campus c is not listed: not a member");
    assert!(!ids.contains(&c));
    assert_eq!(list[0].status, MemberStatus::Active);
    assert_eq!(list[1].status, MemberStatus::Suspended);
    assert_eq!(list[1].suspended_reason.as_deref(), Some("licencia"));
    assert!(list.iter().all(|m| m.role == MemberRole::Student));

    // The professor is a member of all three.
    let prof_list = directory::list_memberships_of_user(&mut conn, &secretary.current(), prof.id)
        .await
        .unwrap();
    assert_eq!(prof_list.len(), 3);
    assert!(prof_list.iter().all(|m| m.role == MemberRole::Professor));

    let err = directory::list_memberships_of_user(&mut conn, &secretary.current(), 99_999)
        .await
        .unwrap_err();
    assert_eq!(err.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn a_university_administrator_sees_only_their_universitys_campuses_and_memberships() {
    let app = TestApp::new().await;
    let prof = app.login_as(Role::Professor).await;
    let admin = app.login_as(Role::Secretary).await;
    let other_admin = app.login_as(Role::Secretary).await;
    let a = app.seed_campus(&prof).await;
    let b = app.seed_campus(&prof).await;
    let student = app.seed_student(a).await;
    app.add_member(b, &student, MemberRole::Student).await;
    let mut conn = app.db.acquire().await.unwrap();
    for (campus, university) in [(a, "uni-a"), (b, "uni-b")] {
        sqlx::query("UPDATE core_campuses SET university = ? WHERE id = ?")
            .bind(university)
            .bind(campus)
            .execute(&app.db)
            .await
            .unwrap();
    }
    for user in [&prof, &student] {
        directory::set_university(&mut conn, user.id, Some("uni-a"), false)
            .await
            .unwrap();
    }
    directory::set_university(&mut conn, admin.id, Some("uni-a"), true)
        .await
        .unwrap();
    directory::set_university(&mut conn, other_admin.id, Some("uni-b"), true)
        .await
        .unwrap();

    let campuses = directory::list_campus_summaries(&mut conn, &admin.current())
        .await
        .unwrap();
    assert_eq!(campuses.iter().map(|c| c.id).collect::<Vec<_>>(), vec![a]);

    let memberships = directory::list_memberships_of_user(&mut conn, &admin.current(), student.id)
        .await
        .unwrap();
    assert_eq!(
        memberships.iter().map(|m| m.campus_id).collect::<Vec<_>>(),
        vec![a],
        "the membership in the other university's campus stays hidden"
    );

    // A person of another university is out of reach altogether.
    directory::set_university(&mut conn, student.id, Some("uni-b"), false)
        .await
        .unwrap();
    let err = directory::list_memberships_of_user(&mut conn, &admin.current(), student.id)
        .await
        .unwrap_err();
    assert_eq!(err.status(), StatusCode::FORBIDDEN);
}

// ---------------------------------------------------------------------------------------
// Class summary reply
// ---------------------------------------------------------------------------------------

#[tokio::test]
async fn a_class_summary_goes_through_the_quota_and_the_usage_log() {
    let app = TestApp::new().await;
    let prof = app.login_as(Role::Professor).await;
    let campus = app.seed_campus(&prof).await;
    let request = AiRequest {
        feature: FEATURE_SUMMARY.into(),
        system: "Resumí la clase en puntos clave y tareas.".into(),
        context: "Laura: hoy cerramos la unidad dos.".into(),
        instruction: "Resumí la clase".into(),
        tools: Vec::new(),
        feedback: Vec::new(),
        identity: None,
    };

    let outcome = ai::run(&app.state, prof.id, Some(campus), &request)
        .await
        .unwrap();
    assert!(outcome.simulated);
    assert!(outcome.reply.text.contains("Puntos clave"));
    assert!(outcome.reply.text.contains("Tareas para la próxima clase"));
    assert!(outcome.reply.tool_calls.is_empty());

    let mut conn = app.db.acquire().await.unwrap();
    let status = ai::quota_status(&mut conn, prof.id, FEATURE_SUMMARY)
        .await
        .unwrap();
    assert_eq!((status.limit, status.used), (20, 1));

    // Its quota is its own setting: shutting it down does not touch shaping.
    sqlx::query("UPDATE core_settings SET value_json = '0' WHERE key = 'ai.summary.daily_quota'")
        .execute(&app.db)
        .await
        .unwrap();
    let err = ai::run(&app.state, prof.id, Some(campus), &request)
        .await
        .unwrap_err();
    assert_eq!(err.status(), StatusCode::TOO_MANY_REQUESTS);
    let shaping = ai::quota_status(&mut conn, prof.id, ai::FEATURE_SHAPING)
        .await
        .unwrap();
    assert_eq!(shaping.limit, 20);
}

// ---------------------------------------------------------------------------------------
// New modules and seams
// ---------------------------------------------------------------------------------------

#[tokio::test]
async fn the_new_modules_and_seams_are_mounted_without_adding_routes() {
    // `TestApp::new` builds the whole app: a seam router that clashed with an existing
    // route would panic there. An unknown path under a seam is a plain 404.
    let app = TestApp::new().await;
    let prof = app.login_as(Role::Professor).await;
    for path in ["/api/admin", "/api/support", "/api/campuses/1/settings"] {
        let (status, _) = app.get(path, Some(&prof.cookie)).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{path}");
    }
}
