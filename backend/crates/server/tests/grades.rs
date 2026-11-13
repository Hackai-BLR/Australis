mod common;

use australis_core::{directory, Role};
use axum::http::StatusCode;
use common::{TestApp, TestUser};
use serde_json::{json, Value};

struct Setup {
    app: TestApp,
    prof: TestUser,
    campus: i64,
}

async fn setup() -> Setup {
    let app = TestApp::new().await;
    let prof = app.login_as(Role::Professor).await;
    let campus = app.seed_campus(&prof).await;
    Setup { app, prof, campus }
}

impl Setup {
    async fn item(&self, title: &str, weight: f64) -> i64 {
        let (status, body) = self
            .app
            .post_json(
                &format!("/api/campuses/{}/gradebook/items", self.campus),
                Some(&self.prof.cookie),
                json!({ "title": title, "weight": weight }),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        body["id"].as_i64().unwrap()
    }

    async fn put(&self, cookie: &str, body: Value) -> (StatusCode, Value) {
        self.app
            .put_json(
                &format!("/api/campuses/{}/gradebook/entries", self.campus),
                Some(cookie),
                body,
            )
            .await
    }

    async fn book(&self, cookie: &str) -> (StatusCode, Value) {
        self.app
            .get(
                &format!("/api/campuses/{}/gradebook", self.campus),
                Some(cookie),
            )
            .await
    }

    async fn audit_rows(&self, entity: &str) -> i64 {
        sqlx::query_scalar("SELECT COUNT(*) FROM core_audit_log WHERE entity = ?")
            .bind(entity)
            .fetch_one(&self.app.db)
            .await
            .unwrap()
    }
}

#[tokio::test]
async fn thirty_entries_in_one_request() {
    let s = setup().await;
    let item = s.item("Parcial", 1.0).await;
    let mut entries = Vec::new();
    for n in 0..30 {
        let student = s.app.seed_student(s.campus).await;
        entries.push(json!({ "item_id": item, "student_id": student.id, "score": 1 + n % 10 }));
    }
    let (status, body) = s.put(&s.prof.cookie, json!({ "entries": entries })).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["changed"], 30);
    let (_, book) = s.book(&s.prof.cookie).await;
    assert_eq!(book["entries"].as_array().unwrap().len(), 30);
    assert_eq!(s.audit_rows("grades.entry").await, 30);
}

#[tokio::test]
async fn out_of_scale_is_422_and_changes_nothing() {
    let s = setup().await;
    let item = s.item("Parcial", 1.0).await;
    let a = s.app.seed_student(s.campus).await;
    let b = s.app.seed_student(s.campus).await;
    let (status, _) = s
        .put(
            &s.prof.cookie,
            json!({ "entries": [
                { "item_id": item, "student_id": a.id, "score": 5 },
                { "item_id": item, "student_id": b.id, "score": 11 },
            ]}),
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    let (_, book) = s.book(&s.prof.cookie).await;
    assert!(book["entries"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn overwrite_needs_a_reason_and_each_change_is_audited() {
    let s = setup().await;
    let item = s.item("Parcial", 1.0).await;
    let a = s.app.seed_student(s.campus).await;
    let first = json!({ "entries": [{ "item_id": item, "student_id": a.id, "score": 6 }] });
    assert_eq!(s.put(&s.prof.cookie, first).await.0, StatusCode::OK);
    assert_eq!(s.audit_rows("grades.entry").await, 1);

    let second = json!({ "entries": [{ "item_id": item, "student_id": a.id, "score": 8 }] });
    let (status, _) = s.put(&s.prof.cookie, second.clone()).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(s.audit_rows("grades.entry").await, 1);

    let mut with_reason = second;
    with_reason["reason"] = json!("recuperatorio");
    assert_eq!(s.put(&s.prof.cookie, with_reason).await.0, StatusCode::OK);
    assert_eq!(s.audit_rows("grades.entry").await, 2);

    // Saving the same value again changes and records nothing.
    let same = json!({ "entries": [{ "item_id": item, "student_id": a.id, "score": 8 }] });
    let (status, body) = s.put(&s.prof.cookie, same).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["changed"], 0);
    assert_eq!(s.audit_rows("grades.entry").await, 2);

    let (status, rows) = s
        .app
        .get(
            &format!("/api/campuses/{}/gradebook/audit", s.campus),
            Some(&s.prof.cookie),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(rows[0]["reason"], "recuperatorio");
    assert_eq!(rows[0]["before"]["score"], 6.0);
    assert_eq!(rows[0]["after"]["score"], 8.0);
}

#[tokio::test]
async fn item_changes_are_audited_and_archive_keeps_the_row() {
    let s = setup().await;
    let item = s.item("TP1", 1.0).await;
    assert_eq!(s.audit_rows("grades.item").await, 1);
    let (status, _) = s
        .app
        .patch_json(
            &format!("/api/gradebook/items/{item}"),
            Some(&s.prof.cookie),
            json!({ "title": "TP uno", "weight": 2 }),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let (status, body) = s
        .app
        .post_json(
            &format!("/api/gradebook/items/{item}/archive"),
            Some(&s.prof.cookie),
            json!({}),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert!(body["archived_at"].is_string());
    assert_eq!(s.audit_rows("grades.item").await, 3);
    let (status, _) = s
        .app
        .delete(
            &format!("/api/gradebook/items/{item}"),
            Some(&s.prof.cookie),
        )
        .await;
    assert_ne!(status, StatusCode::OK);
    let (_, book) = s.book(&s.prof.cookie).await;
    assert_eq!(book["items"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn changing_a_graded_item_needs_a_reason_recorded_in_the_audit() {
    let s = setup().await;
    let item = s.item("Parcial", 1.0).await;
    let a = s.app.seed_student(s.campus).await;
    let put = json!({ "entries": [{ "item_id": item, "student_id": a.id, "score": 6 }] });
    assert_eq!(s.put(&s.prof.cookie, put).await.0, StatusCode::OK);
    let url = format!("/api/gradebook/items/{item}");
    let archive = format!("{url}/archive");

    for body in [
        json!({ "weight": 3 }),
        json!({ "weight": 3, "reason": "  " }),
    ] {
        let (status, _) = s.app.patch_json(&url, Some(&s.prof.cookie), body).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    }
    for body in [json!({}), json!({ "reason": "" })] {
        let (status, _) = s.app.post_json(&archive, Some(&s.prof.cookie), body).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    }
    // Only the create row so far.
    assert_eq!(s.audit_rows("grades.item").await, 1);

    let (status, _) = s
        .app
        .patch_json(
            &url,
            Some(&s.prof.cookie),
            json!({ "weight": 3, "reason": "peso corregido" }),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = s
        .app
        .post_json(
            &archive,
            Some(&s.prof.cookie),
            json!({ "reason": "se anula el parcial" }),
        )
        .await;
    assert_eq!(status, StatusCode::OK);

    let rows: Vec<(String, Option<String>, Option<i64>)> = sqlx::query_as(
        "SELECT action, reason, actor_id FROM core_audit_log
         WHERE entity = 'grades.item' ORDER BY id",
    )
    .fetch_all(&s.app.db)
    .await
    .unwrap();
    assert_eq!(rows.len(), 3);
    assert_eq!(rows[1].0, "update");
    assert_eq!(rows[1].1.as_deref(), Some("peso corregido"));
    assert_eq!(rows[1].2, Some(s.prof.id));
    assert_eq!(rows[2].0, "archive");
    assert_eq!(rows[2].1.as_deref(), Some("se anula el parcial"));
    assert_eq!(rows[2].2, Some(s.prof.id));
}

#[tokio::test]
async fn archive_works_without_a_body_when_the_item_has_no_grades() {
    let s = setup().await;
    let item = s.item("TP1", 1.0).await;
    let (status, body) = s
        .app
        .post_json(
            &format!("/api/gradebook/items/{item}/archive"),
            Some(&s.prof.cookie),
            Value::Null,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(body["archived_at"].is_string());
}

#[tokio::test]
async fn final_is_the_weighted_mean_and_follows_the_setting() {
    let s = setup().await;
    let a = s.item("A", 1.0).await;
    let b = s.item("B", 3.0).await;
    let st = s.app.seed_student(s.campus).await;
    let (status, _) = s
        .put(
            &s.prof.cookie,
            json!({ "entries": [
                { "item_id": a, "student_id": st.id, "score": 4 },
                { "item_id": b, "student_id": st.id, "score": 8 },
            ]}),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let (_, book) = s.book(&s.prof.cookie).await;
    assert_eq!(book["finals"][0]["final"], 7.0);
    assert_eq!(book["scale"]["max"], 10.0);

    // The scale is a setting: shrinking it makes the stored score invalid for new saves and
    // is reported by the book.
    sqlx::query(
        "UPDATE core_settings SET value_json = '{\"min\":0,\"max\":100,\"pass\":60}'
         WHERE key = 'grading.scale'",
    )
    .execute(&s.app.db)
    .await
    .unwrap();
    let (_, book) = s.book(&s.prof.cookie).await;
    assert_eq!(book["scale"]["max"], 100.0);
    let (status, _) = s
        .put(
            &s.prof.cookie,
            json!({ "entries": [{ "item_id": a, "student_id": st.id, "score": 95 }],
                    "reason": "escala nueva" }),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let (_, book) = s.book(&s.prof.cookie).await;
    assert_eq!(book["finals"][0]["final"], 29.75);

    // Changing the rule setting to an unknown kind is a configuration error, not a fallback.
    sqlx::query(
        "UPDATE core_settings SET value_json = '{\"kind\":\"median\"}'
         WHERE key = 'grading.final_rule'",
    )
    .execute(&s.app.db)
    .await
    .unwrap();
    let (status, _) = s.book(&s.prof.cookie).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
}

#[tokio::test]
async fn student_sees_only_own_grades_and_cannot_use_the_gradebook() {
    let s = setup().await;
    let item = s.item("Parcial", 1.0).await;
    let a = s.app.seed_student(s.campus).await;
    let b = s.app.seed_student(s.campus).await;
    s.put(
        &s.prof.cookie,
        json!({ "entries": [
            { "item_id": item, "student_id": a.id, "score": 9 },
            { "item_id": item, "student_id": b.id, "score": 3 },
        ]}),
    )
    .await;
    let (status, body) = s.app.get("/api/grades/mine", Some(&a.cookie)).await;
    assert_eq!(status, StatusCode::OK);
    let courses = body["courses"].as_array().unwrap();
    assert_eq!(courses.len(), 1);
    assert_eq!(courses[0]["final"], 9.0);
    assert_eq!(courses[0]["items"][0]["score"], 9.0);
    // The scale lives on each course; there is no top-level one to misread.
    assert!(body.get("scale").is_none(), "{body}");
    assert_eq!(courses[0]["scale"]["max"], 10.0);
    assert!(!body.to_string().contains(&b.email));

    assert_eq!(s.book(&a.cookie).await.0, StatusCode::FORBIDDEN);
    let (status, _) = s
        .put(
            &a.cookie,
            json!({ "entries": [{ "item_id": item, "student_id": a.id, "score": 10 }],
                    "reason": "x" }),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = s
        .app
        .get(
            &format!("/api/campuses/{}/gradebook/audit", s.campus),
            Some(&a.cookie),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(
        s.app.get("/api/grades/mine", None).await.0,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn guest_can_grade() {
    let s = setup().await;
    let item = s.item("Parcial", 1.0).await;
    let st = s.app.seed_student(s.campus).await;
    let guest = s.app.seed_guest(s.campus).await;
    let (status, _) = s
        .put(
            &guest.cookie,
            json!({ "entries": [{ "item_id": item, "student_id": st.id, "score": 7 }] }),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(s.book(&guest.cookie).await.0, StatusCode::OK);
}

#[tokio::test]
async fn suspended_students_stay_visible_and_marked() {
    let s = setup().await;
    let item = s.item("Parcial", 1.0).await;
    let st = s.app.seed_student(s.campus).await;
    s.put(
        &s.prof.cookie,
        json!({ "entries": [{ "item_id": item, "student_id": st.id, "score": 7 }] }),
    )
    .await;
    let mut conn = s.app.db.acquire().await.unwrap();
    directory::suspend_member(&mut conn, s.prof.id, s.campus, st.id, "baja")
        .await
        .unwrap();
    drop(conn);
    let (_, book) = s.book(&s.prof.cookie).await;
    let students = book["students"].as_array().unwrap();
    assert_eq!(students.len(), 1);
    assert_eq!(students[0]["suspended"], true);
    assert_eq!(book["entries"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn an_item_of_another_campus_is_rejected() {
    let s = setup().await;
    let other = s.app.seed_campus(&s.prof).await;
    let (_, body) = s
        .app
        .post_json(
            &format!("/api/campuses/{other}/gradebook/items"),
            Some(&s.prof.cookie),
            json!({ "title": "Otro" }),
        )
        .await;
    let foreign = body["id"].as_i64().unwrap();
    let st = s.app.seed_student(s.campus).await;
    let (status, _) = s
        .put(
            &s.prof.cookie,
            json!({ "entries": [{ "item_id": foreign, "student_id": st.id, "score": 5 }] }),
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
}
