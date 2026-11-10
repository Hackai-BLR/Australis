//! The demo path end to end, through HTTP only (students are added with the kernel helper
//! because the roster import is not part of this branch).

mod common;

use australis_core::{directory::MemberRole, Role};
use axum::http::{Method, StatusCode};
use common::{TestApp, TEST_PASSWORD};
use serde_json::json;

#[tokio::test]
async fn demo_flow_from_secretary_to_student_home() {
    let app = TestApp::new().await;
    let secretary = app.login_as(Role::Secretary).await;

    // The secretary creates a professor, who accepts the invite and is signed in.
    let (status, body) = app
        .post_json(
            "/api/users",
            Some(&secretary.cookie),
            json!({ "email": "docente@demo.example", "full_name": "Docente Demo", "role": "professor" }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let token = body["invite_url"]
        .as_str()
        .unwrap()
        .rsplit('/')
        .next()
        .unwrap();
    let accepted = app
        .json_response(
            Method::POST,
            &format!("/api/auth/invites/{token}/accept"),
            None,
            json!({ "password": "una-clave-larga" }),
        )
        .await;
    assert_eq!(accepted.status, StatusCode::OK, "{}", accepted.text());
    let professor = accepted.session_cookie().expect("professor signed in");

    // The professor creates a campus from a template.
    let (status, campus) = app
        .post_json(
            "/api/campuses",
            Some(&professor),
            json!({ "name": "Seminario Demo", "template_key": "weekly_topics" }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{campus}");
    let campus_id = campus["id"].as_i64().unwrap();

    // Two students join (kernel helper).
    let ada = app.login_as(Role::Student).await;
    let bruno = app.login_as(Role::Student).await;
    app.add_member(campus_id, &ada, MemberRole::Student).await;
    app.add_member(campus_id, &bruno, MemberRole::Student).await;

    // Graded items and grades.
    let mut items = Vec::new();
    for (title, weight) in [("Parcial", 0.6), ("TP final", 0.4)] {
        let (status, item) = app
            .post_json(
                &format!("/api/campuses/{campus_id}/gradebook/items"),
                Some(&professor),
                json!({ "title": title, "weight": weight }),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{item}");
        items.push(item["id"].as_i64().unwrap());
    }
    let (status, saved) = app
        .put_json(
            &format!("/api/campuses/{campus_id}/gradebook/entries"),
            Some(&professor),
            json!({ "entries": [
                { "item_id": items[0], "student_id": ada.id, "score": 8 },
                { "item_id": items[1], "student_id": ada.id, "score": 9 },
                { "item_id": items[0], "student_id": bruno.id, "score": 6 },
            ]}),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!(saved["changed"], 3);

    // A class today (now, in UTC, is always today).
    let now: String = sqlx::query_scalar("SELECT datetime('now')")
        .fetch_one(&app.db)
        .await
        .unwrap();
    let (status, class) = app
        .post_json(
            &format!("/api/campuses/{campus_id}/classes"),
            Some(&professor),
            json!({ "title": "Clase 1", "starts_at": now, "duration_min": 90 }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{class}");

    // The student signs in with email and password.
    let login = app
        .json_response(
            Method::POST,
            "/api/auth/login",
            None,
            json!({ "email": ada.email, "password": TEST_PASSWORD }),
        )
        .await;
    assert_eq!(login.status, StatusCode::OK);
    let student = login.session_cookie().expect("student signed in");

    let (status, campuses) = app.get("/api/campuses", Some(&student)).await;
    assert_eq!(status, StatusCode::OK);
    let campuses = campuses.as_array().unwrap();
    assert_eq!(campuses.len(), 1);
    assert_eq!(campuses[0]["id"], campus_id);

    let (status, mine) = app.get("/api/grades/mine", Some(&student)).await;
    assert_eq!(status, StatusCode::OK, "{mine}");
    let courses = mine["courses"].as_array().unwrap();
    assert_eq!(courses.len(), 1);
    assert_eq!(courses[0]["campus_id"], campus_id);
    assert_eq!(courses[0]["items"].as_array().unwrap().len(), 2);
    assert!(courses[0]["final"].as_f64().is_some(), "{mine}");

    let (status, today) = app.get("/api/classes/today", Some(&student)).await;
    assert_eq!(status, StatusCode::OK);
    let today = today.as_array().unwrap();
    assert_eq!(today.len(), 1);
    assert_eq!(today[0]["campus_id"], campus_id);
    assert!(today[0]["start_url"].is_null());

    // A second professor is refused; the secretary is allowed.
    let other = app.login_as(Role::Professor).await;
    let book = format!("/api/campuses/{campus_id}/gradebook");
    let (status, _) = app.get(&book, Some(&other.cookie)).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = app
        .post_json(
            &format!("/api/campuses/{campus_id}/gradebook/items"),
            Some(&other.cookie),
            json!({ "title": "Intruso", "weight": 1 }),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = app.get(&book, Some(&secretary.cookie)).await;
    assert_eq!(status, StatusCode::OK);
}
