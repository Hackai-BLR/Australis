mod common;

use australis_core::Role;
use axum::http::StatusCode;
use common::{TestApp, TestUser, TEST_PASSWORD};
use serde_json::json;

async fn login(app: &TestApp, email: &str, password: &str) -> common::TestResponse {
    app.json_response(
        axum::http::Method::POST,
        "/api/auth/login",
        None,
        json!({ "email": email, "password": password }),
    )
    .await
}

/// Creates an invited professor as the secretary and returns (user id, invite token).
async fn invite_professor(app: &TestApp, secretary: &TestUser, email: &str) -> (i64, String) {
    let (status, body) = app
        .post_json(
            "/api/users",
            Some(&secretary.cookie),
            json!({ "email": email, "full_name": "Docente Invitado", "role": "professor" }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let url = body["invite_url"].as_str().unwrap();
    let token = url.rsplit('/').next().unwrap().to_string();
    (body["user"]["id"].as_i64().unwrap(), token)
}

#[tokio::test]
async fn good_login_returns_the_user_and_a_session_cookie() {
    let app = TestApp::new().await;
    let user = app.login_as(Role::Professor).await;

    let response = login(&app, &user.email, TEST_PASSWORD).await;
    assert_eq!(response.status, StatusCode::OK);
    let body = response.json();
    assert_eq!(body["email"], user.email.as_str());
    assert_eq!(body["role"], "professor");
    assert!(body.get("password_hash").is_none());
    let set_cookie = response.header("set-cookie").unwrap();
    assert!(set_cookie.contains("HttpOnly") && set_cookie.contains("SameSite=Lax"));

    let cookie = response.session_cookie().expect("session cookie");
    let (status, me) = app.get("/api/auth/me", Some(&cookie)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(me["id"], body["id"]);
}

#[tokio::test]
async fn bad_login_is_a_generic_401_and_does_not_reveal_which_emails_exist() {
    let app = TestApp::new().await;
    let user = app.login_as(Role::Student).await;

    let wrong_password = login(&app, &user.email, "not-the-password").await;
    let unknown_email = login(&app, "nobody@test.example", "not-the-password").await;
    assert_eq!(wrong_password.status, StatusCode::UNAUTHORIZED);
    assert_eq!(unknown_email.status, StatusCode::UNAUTHORIZED);
    assert_eq!(wrong_password.json(), unknown_email.json());
    assert!(wrong_password.session_cookie().is_none());

    // Malformed bodies are still JSON errors.
    let response = app
        .json_response(
            axum::http::Method::POST,
            "/api/auth/login",
            None,
            json!({ "email": "a@b.co" }),
        )
        .await;
    assert!(response.status.is_client_error());
    assert!(response.json()["error"].is_string());
}

#[tokio::test]
async fn me_needs_a_session() {
    let app = TestApp::new().await;
    let (status, body) = app.get("/api/auth/me", None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert!(body["error"].is_string());
}

#[tokio::test]
async fn logout_revokes_the_session() {
    let app = TestApp::new().await;
    let user = app.login_as(Role::Student).await;
    let (status, _) = app.get("/api/auth/me", Some(&user.cookie)).await;
    assert_eq!(status, StatusCode::OK);

    let response = app
        .json_response(
            axum::http::Method::POST,
            "/api/auth/logout",
            Some(&user.cookie),
            json!({}),
        )
        .await;
    assert_eq!(response.status, StatusCode::NO_CONTENT);
    assert!(response.header("set-cookie").unwrap().contains("Max-Age=0"));

    let (status, _) = app.get("/api/auth/me", Some(&user.cookie)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    // Logging out without a session is harmless.
    let response = app
        .json_response(
            axum::http::Method::POST,
            "/api/auth/logout",
            None,
            json!({}),
        )
        .await;
    assert_eq!(response.status, StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn suspended_user_cannot_log_in_and_the_session_stops_working() {
    let app = TestApp::new().await;
    let secretary = app.login_as(Role::Secretary).await;
    let student = app.login_as(Role::Student).await;

    let (status, _) = app.get("/api/auth/me", Some(&student.cookie)).await;
    assert_eq!(status, StatusCode::OK);

    // A reason is required.
    let (status, _) = app
        .patch_json(
            &format!("/api/users/{}", student.id),
            Some(&secretary.cookie),
            json!({ "status": "suspended", "reason": "  " }),
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);

    let (status, body) = app
        .patch_json(
            &format!("/api/users/{}", student.id),
            Some(&secretary.cookie),
            json!({ "status": "suspended", "reason": "Baja del programa" }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["status"], "suspended");

    let (status, _) = app.get("/api/auth/me", Some(&student.cookie)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let response = login(&app, &student.email, TEST_PASSWORD).await;
    assert_eq!(response.status, StatusCode::UNAUTHORIZED);

    // The change is audited with who and why.
    let row: (Option<i64>, Option<String>, String) = sqlx::query_as(
        "SELECT actor_id, reason, action FROM core_audit_log WHERE entity = 'user' AND entity_id = ? AND action = 'suspend'",
    )
    .bind(student.id)
    .fetch_one(&app.db)
    .await
    .unwrap();
    assert_eq!(row.0, Some(secretary.id));
    assert_eq!(row.1.as_deref(), Some("Baja del programa"));

    // Reactivating lets the person in again.
    let (status, body) = app
        .patch_json(
            &format!("/api/users/{}", student.id),
            Some(&secretary.cookie),
            json!({ "status": "active", "reason": "Reincorporación" }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        login(&app, &student.email, TEST_PASSWORD).await.status,
        StatusCode::OK
    );
}

#[tokio::test]
async fn invite_accept_sets_the_password_once_and_signs_in() {
    let app = TestApp::new().await;
    let secretary = app.login_as(Role::Secretary).await;
    let (_, token) = invite_professor(&app, &secretary, "nuevo@test.example").await;

    // The invite page can say who it is for, without a session.
    let (status, body) = app.get(&format!("/api/auth/invites/{token}"), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["email"], "nuevo@test.example");
    assert_eq!(body["role"], "professor");

    // A short password is refused and does not use up the invite.
    let (status, _) = app
        .post_json(
            &format!("/api/auth/invites/{token}/accept"),
            None,
            json!({ "password": "short" }),
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);

    let response = app
        .json_response(
            axum::http::Method::POST,
            &format!("/api/auth/invites/{token}/accept"),
            None,
            json!({ "password": "una-clave-larga" }),
        )
        .await;
    assert_eq!(response.status, StatusCode::OK, "{}", response.text());
    let cookie = response.session_cookie().expect("signed in");
    let (status, me) = app.get("/api/auth/me", Some(&cookie)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(me["email"], "nuevo@test.example");
    assert_eq!(
        login(&app, "nuevo@test.example", "una-clave-larga")
            .await
            .status,
        StatusCode::OK
    );

    // The invite is spent: it cannot be shown or accepted again, and the password stays.
    let (status, _) = app.get(&format!("/api/auth/invites/{token}"), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = app
        .post_json(
            &format!("/api/auth/invites/{token}/accept"),
            None,
            json!({ "password": "otra-clave-larga" }),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(
        login(&app, "nuevo@test.example", "otra-clave-larga")
            .await
            .status,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn invite_never_works_on_an_account_that_has_a_password() {
    let app = TestApp::new().await;
    let secretary = app.login_as(Role::Secretary).await;
    let (user_id, token) = invite_professor(&app, &secretary, "tomada@test.example").await;

    // Give the account a password behind the invite's back: the invite must not overwrite it.
    let hash = australis_core::auth::hash_password(&app.state.config, "clave-original-1")
        .await
        .unwrap();
    sqlx::query("UPDATE core_users SET password_hash = ?, status = 'active' WHERE id = ?")
        .bind(hash)
        .bind(user_id)
        .execute(&app.db)
        .await
        .unwrap();

    let (status, _) = app.get(&format!("/api/auth/invites/{token}"), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = app
        .post_json(
            &format!("/api/auth/invites/{token}/accept"),
            None,
            json!({ "password": "clave-del-atacante" }),
        )
        .await;
    assert!(status.is_client_error());
    assert_eq!(
        login(&app, "tomada@test.example", "clave-original-1")
            .await
            .status,
        StatusCode::OK
    );
    assert_eq!(
        login(&app, "tomada@test.example", "clave-del-atacante")
            .await
            .status,
        StatusCode::UNAUTHORIZED
    );

    // And an unknown token is a 404.
    let (status, _) = app
        .post_json(
            "/api/auth/invites/nope/accept",
            None,
            json!({ "password": "una-clave-larga" }),
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn users_endpoints_are_secretary_only() {
    let app = TestApp::new().await;
    let secretary = app.login_as(Role::Secretary).await;
    let professor = app.login_as(Role::Professor).await;
    let student = app.login_as(Role::Student).await;
    let new_user = json!({ "email": "x@test.example", "full_name": "X", "role": "professor" });
    let patch = json!({ "status": "suspended", "reason": "motivo" });

    // Anonymous: 401.
    assert_eq!(
        app.get("/api/users", None).await.0,
        StatusCode::UNAUTHORIZED
    );
    for who in [&professor, &student] {
        assert_eq!(
            app.get("/api/users", Some(&who.cookie)).await.0,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            app.post_json("/api/users", Some(&who.cookie), new_user.clone())
                .await
                .0,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            app.patch_json(
                &format!("/api/users/{}", student.id),
                Some(&who.cookie),
                patch.clone()
            )
            .await
            .0,
            StatusCode::FORBIDDEN
        );
    }

    let (status, body) = app.get("/api/users", Some(&secretary.cookie)).await;
    assert_eq!(status, StatusCode::OK);
    assert!(body.as_array().unwrap().len() >= 3);

    // Students are not created here; duplicates conflict.
    let (status, _) = app
        .post_json(
            "/api/users",
            Some(&secretary.cookie),
            json!({ "email": "s@test.example", "full_name": "S", "role": "student" }),
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    let (status, body) = app
        .post_json("/api/users", Some(&secretary.cookie), new_user.clone())
        .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(body["user"]["status"], "invited");
    let (status, _) = app
        .post_json("/api/users", Some(&secretary.cookie), new_user)
        .await;
    assert_eq!(status, StatusCode::CONFLICT);

    // A secretary cannot suspend themselves.
    let (status, _) = app
        .patch_json(
            &format!("/api/users/{}", secretary.id),
            Some(&secretary.cookie),
            patch,
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
}
