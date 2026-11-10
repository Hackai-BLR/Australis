//! Kernel hardening: concurrent directory writes, JSON error bodies, email lookup and
//! the REPLACE loophole around the append-only triggers.

mod common;

use australis_core::{
    auth, begin_write,
    directory::{self, NewUser},
    Role,
};
use axum::http::{Method, StatusCode};
use common::TestApp;

async fn invited(app: &TestApp, email: &str) -> directory::User {
    let mut conn = app.db.acquire().await.unwrap();
    directory::create_user(
        &mut conn,
        NewUser {
            email,
            full_name: "Invited",
            role: Role::Student,
            password_hash: None,
        },
    )
    .await
    .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn directory_writes_wait_for_a_concurrent_writer() {
    let app = TestApp::new().await;
    let professor = app.login_as(Role::Professor).await;
    let user = invited(&app, "wait@example.com").await;
    let token = {
        let mut conn = app.db.acquire().await.unwrap();
        directory::create_invite(&mut conn, professor.id, user.id, 24)
            .await
            .unwrap()
    };

    // Another request holds the write lock for a moment.
    let holder_db = app.db.clone();
    let holder = tokio::spawn(async move {
        let tx = begin_write(&holder_db).await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(600)).await;
        tx.commit().await.unwrap();
    });
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;

    let mut conn = app.db.acquire().await.unwrap();
    directory::accept_invite(&mut conn, &token, "hash")
        .await
        .expect("accept_invite waits for the lock instead of failing");
    holder.await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn many_students_can_be_added_at_once() {
    let app = TestApp::new().await;
    let professor = app.login_as(Role::Professor).await;
    let campus = app.seed_campus(&professor).await;
    let mut ids = Vec::new();
    for n in 0..12 {
        ids.push(invited(&app, &format!("s{n}@example.com")).await.id);
    }
    let mut tasks = Vec::new();
    for id in ids {
        let db = app.db.clone();
        let actor = professor.id;
        tasks.push(tokio::spawn(async move {
            let mut conn = db.acquire().await.unwrap();
            directory::add_member(&mut conn, actor, campus, id, directory::MemberRole::Student)
                .await
        }));
    }
    for task in tasks {
        task.await.unwrap().expect("concurrent add_member");
    }
}

#[tokio::test]
async fn malformed_requests_get_a_json_error_body() {
    let app = TestApp::new().await;
    let response = app
        .send(
            axum::http::Request::builder()
                .method(Method::POST)
                .uri("/api/auth/login")
                .header("content-type", "application/json")
                .body(axum::body::Body::from("{not json"))
                .unwrap(),
        )
        .await;
    assert!(response.status.is_client_error());
    assert!(response.json()["error"].is_string(), "{}", response.text());

    // Wrong method on a known route.
    let response = app
        .send(
            axum::http::Request::builder()
                .method(Method::DELETE)
                .uri("/api/health")
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(response.status, StatusCode::METHOD_NOT_ALLOWED);
    assert!(response.json()["error"].is_string(), "{}", response.text());

    // Unknown route.
    let (status, body) = app.get("/api/nope", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert!(body["error"].is_string());
}

#[tokio::test]
async fn emails_with_non_ascii_capitals_are_found() {
    let app = TestApp::new().await;
    let mut conn = app.db.acquire().await.unwrap();
    let hash = auth::hash_password(&app.state.config, "pw-123456789")
        .await
        .unwrap();
    let user = directory::create_user(
        &mut conn,
        NewUser {
            email: "  \u{d1}and\u{fa}@Example.com ",
            full_name: "Nandu",
            role: Role::Student,
            password_hash: Some(hash),
        },
    )
    .await
    .unwrap();
    for lookup in [
        "\u{d1}and\u{fa}@example.com",
        " \u{d1}AND\u{da}@EXAMPLE.COM",
    ] {
        let found = directory::find_user_by_email(&mut conn, lookup)
            .await
            .unwrap();
        assert_eq!(found.map(|u| u.id), Some(user.id), "{lookup}");
        let creds = directory::find_credentials(&mut conn, lookup)
            .await
            .unwrap();
        assert!(creds.is_some(), "{lookup}");
    }
}

#[tokio::test]
async fn insert_or_replace_cannot_rewrite_protected_rows() {
    let app = TestApp::new().await;
    let professor = app.login_as(Role::Professor).await;
    let campus = app.seed_campus(&professor).await;
    let student = app.seed_student(campus).await;

    sqlx::query(
        "INSERT INTO core_audit_log (id, entity, entity_id, action) VALUES (900, 'x', 1, 'a')",
    )
    .execute(&app.db)
    .await
    .unwrap();
    let err = sqlx::query(
        "INSERT OR REPLACE INTO core_audit_log (id, entity, entity_id, action) VALUES (900, 'y', 2, 'b')",
    )
    .execute(&app.db)
    .await
    .unwrap_err();
    assert!(err.to_string().contains("append-only"), "{err}");

    let err = sqlx::query(
        "INSERT OR REPLACE INTO core_users (id, email, full_name, role, status) VALUES (?, 'zz@example.com', 'Z', 'student', 'active')",
    )
    .bind(student.id)
    .execute(&app.db)
    .await
    .unwrap_err();
    assert!(err.to_string().contains("never deleted"), "{err}");
}
