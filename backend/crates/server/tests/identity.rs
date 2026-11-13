//! Sign-in through the Campus IA core: the signed `X-Campus-Identidad` header (`AUTH_MODE=header`).

mod common;

use std::{
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use australis_core::{
    auth::IDENTITY_HEADER,
    config::AuthMode,
    directory::{self, UserStatus},
    Config, Role,
};
use axum::{
    body::Body,
    http::{header::COOKIE, Method, Request, StatusCode},
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use common::{TestApp, TestResponse};
use ed25519_dalek::{Signer, SigningKey};
use serde_json::{json, Value};

fn core_key() -> SigningKey {
    SigningKey::from_bytes(&[11u8; 32])
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

async fn header_app() -> TestApp {
    TestApp::with(|state| {
        let mut config = (*state.config).clone();
        config.auth_mode = AuthMode::Header;
        config.identity_key = Some(core_key().verifying_key());
        state.config = Arc::new(config);
    })
    .await
}

fn claims(email: &str, name: &str, rol: &str, administrador: bool) -> Value {
    json!({
        "v": 1, "curso": "australis", "usuario": "42", "email": email, "nombre": name,
        "rol": rol, "administrador": administrador,
        "emitido": now() - 1, "vence": now() + 60,
    })
}

fn sign_with(key: &SigningKey, claims: &Value) -> String {
    let payload = URL_SAFE_NO_PAD.encode(claims.to_string());
    let signature = URL_SAFE_NO_PAD.encode(key.sign(payload.as_bytes()).to_bytes());
    format!("{payload}.{signature}")
}

fn sign(claims: &Value) -> String {
    sign_with(&core_key(), claims)
}

async fn call(
    app: &TestApp,
    method: Method,
    uri: &str,
    identity: Option<&str>,
    cookie: Option<&str>,
    body: Option<Value>,
) -> TestResponse {
    let mut request = Request::builder().method(method).uri(uri);
    if let Some(identity) = identity {
        request = request.header(IDENTITY_HEADER, identity);
    }
    if let Some(cookie) = cookie {
        request = request.header(COOKIE, cookie);
    }
    let request = match body {
        Some(body) => request
            .header("content-type", "application/json")
            .body(Body::from(body.to_string())),
        None => request.body(Body::empty()),
    };
    app.send(request.unwrap()).await
}

async fn me(app: &TestApp, identity: Option<&str>) -> TestResponse {
    call(app, Method::GET, "/api/auth/me", identity, None, None).await
}

#[tokio::test]
async fn a_valid_identity_creates_the_account_on_first_sight() {
    let app = header_app().await;
    let header = sign(&claims(
        "Ana.Lopez@Demo.Test",
        "Ana López",
        "profesor",
        false,
    ));

    let first = me(&app, Some(&header)).await;
    assert_eq!(first.status, StatusCode::OK);
    let body = first.json();
    assert_eq!(body["email"], "ana.lopez@demo.test");
    assert_eq!(body["full_name"], "Ana López");
    assert_eq!(body["role"], "professor");

    let second = me(&app, Some(&header)).await;
    assert_eq!(second.json()["id"], body["id"]);

    let mut conn = app.db.acquire().await.unwrap();
    let users = directory::list_users(&mut conn).await.unwrap();
    assert_eq!(users.len(), 1);
    assert_eq!(users[0].status, UserStatus::Active);
    assert!(!users[0].has_password);

    let audited: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM core_audit_log WHERE action = 'create_from_identity' AND subject_user_id = ?",
    )
    .bind(users[0].id)
    .fetch_one(&mut *conn)
    .await
    .unwrap();
    assert_eq!(audited, 1);
}

#[tokio::test]
async fn platform_roles_map_to_australis_roles() {
    let app = header_app().await;
    let cases = [
        ("owner@demo.test", "dueño", false, "secretary"),
        ("admin@demo.test", "alumno", true, "secretary"),
        ("admin-prof@demo.test", "profesor", true, "secretary"),
        ("prof@demo.test", "profesor", false, "professor"),
        ("alumno@demo.test", "alumno", false, "student"),
        ("raro@demo.test", "otra-cosa", false, "student"),
    ];
    for (email, rol, administrador, expected) in cases {
        let header = sign(&claims(email, "Persona Demo", rol, administrador));
        let response = me(&app, Some(&header)).await;
        assert_eq!(response.status, StatusCode::OK, "{email}");
        assert_eq!(response.json()["role"], expected, "{email}");
    }
}

#[tokio::test]
async fn a_header_that_is_missing_forged_expired_or_for_another_service_is_refused() {
    let app = header_app().await;
    assert_eq!(me(&app, None).await.status, StatusCode::UNAUTHORIZED);

    let other = SigningKey::from_bytes(&[12u8; 32]);
    let forged = sign_with(&other, &claims("a@demo.test", "A", "dueño", true));
    assert_eq!(
        me(&app, Some(&forged)).await.status,
        StatusCode::UNAUTHORIZED
    );

    let mut expired = claims("a@demo.test", "A", "alumno", false);
    expired["emitido"] = json!(now() - 300);
    expired["vence"] = json!(now() - 100);
    assert_eq!(
        me(&app, Some(&sign(&expired))).await.status,
        StatusCode::UNAUTHORIZED
    );

    let mut too_long = claims("a@demo.test", "A", "alumno", false);
    too_long["vence"] = json!(now() + 3600);
    assert_eq!(
        me(&app, Some(&sign(&too_long))).await.status,
        StatusCode::UNAUTHORIZED
    );

    let mut course_header = claims("a@demo.test", "A", "alumno", false);
    course_header["curso"] = json!("algebra");
    assert_eq!(
        me(&app, Some(&sign(&course_header))).await.status,
        StatusCode::UNAUTHORIZED
    );

    let tampered = sign(&claims("a@demo.test", "A", "alumno", false));
    let (_, signature) = tampered.split_once('.').unwrap();
    let swapped = format!(
        "{}.{signature}",
        URL_SAFE_NO_PAD.encode(claims("a@demo.test", "A", "dueño", false).to_string())
    );
    assert_eq!(
        me(&app, Some(&swapped)).await.status,
        StatusCode::UNAUTHORIZED
    );

    let mut conn = app.db.acquire().await.unwrap();
    assert!(directory::list_users(&mut conn).await.unwrap().is_empty());
}

#[tokio::test]
async fn a_session_cookie_does_not_sign_anyone_in_header_mode() {
    let app = header_app().await;
    let secretary = app.login_as(Role::Secretary).await;
    let response = call(
        &app,
        Method::GET,
        "/api/auth/me",
        None,
        Some(&secretary.cookie),
        None,
    )
    .await;
    assert_eq!(response.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn the_header_is_ignored_in_password_mode() {
    let app = TestApp::new().await;
    let header = sign(&claims("a@demo.test", "A", "dueño", true));
    assert_eq!(
        me(&app, Some(&header)).await.status,
        StatusCode::UNAUTHORIZED
    );

    let mode = call(&app, Method::GET, "/api/auth/mode", None, None, None).await;
    assert_eq!(mode.json()["mode"], "password");
    let student = app.login_as(Role::Student).await;
    let (status, _) = app.get("/api/auth/me", Some(&student.cookie)).await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn the_role_and_name_follow_the_platform() {
    let app = header_app().await;
    let as_student = sign(&claims("ana@demo.test", "Ana", "alumno", false));
    assert_eq!(me(&app, Some(&as_student)).await.json()["role"], "student");

    let as_professor = sign(&claims("ana@demo.test", "Ana López", "profesor", false));
    let promoted = me(&app, Some(&as_professor)).await.json();
    assert_eq!(promoted["role"], "professor");
    assert_eq!(promoted["full_name"], "Ana López");

    let demoted = me(&app, Some(&as_student)).await.json();
    assert_eq!(demoted["role"], "student");
    assert_eq!(demoted["id"], promoted["id"]);

    let changes: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM core_audit_log WHERE action = 'sync_from_identity'",
    )
    .fetch_one(&app.db)
    .await
    .unwrap();
    assert_eq!(changes, 2);
}

#[tokio::test]
async fn an_account_suspended_in_australis_has_no_access() {
    let app = header_app().await;
    let admin = sign(&claims("admin@demo.test", "Admin", "dueño", false));
    let admin_id = me(&app, Some(&admin)).await.json()["id"].as_i64().unwrap();
    let header = sign(&claims("ana@demo.test", "Ana", "alumno", false));
    let ana_id = me(&app, Some(&header)).await.json()["id"].as_i64().unwrap();

    let uri = format!("/api/users/{ana_id}");
    let suspend = json!({ "status": "suspended", "reason": "baja" });
    let status = call(&app, Method::PATCH, &uri, Some(&admin), None, Some(suspend))
        .await
        .status;
    assert_eq!(status, StatusCode::OK);
    assert_ne!(admin_id, ana_id);

    assert_eq!(me(&app, Some(&header)).await.status, StatusCode::FORBIDDEN);
    let campuses = call(
        &app,
        Method::GET,
        "/api/campuses",
        Some(&header),
        None,
        None,
    )
    .await;
    assert_eq!(campuses.status, StatusCode::FORBIDDEN);

    let reactivate = json!({ "status": "active", "reason": "vuelve" });
    let status = call(
        &app,
        Method::PATCH,
        &uri,
        Some(&admin),
        None,
        Some(reactivate),
    )
    .await
    .status;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(me(&app, Some(&header)).await.status, StatusCode::OK);
}

#[tokio::test]
async fn an_account_invited_by_the_roster_is_activated_without_a_password() {
    let app = header_app().await;
    let mut conn = app.db.acquire().await.unwrap();
    let invited = directory::create_user(
        &mut conn,
        directory::NewUser {
            email: "carla@demo.test",
            full_name: "carla@demo.test",
            role: Role::Student,
            password_hash: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(invited.status, UserStatus::Invited);
    drop(conn);

    let header = sign(&claims("carla@demo.test", "Carla Sosa", "alumno", false));
    let response = me(&app, Some(&header)).await;
    assert_eq!(response.status, StatusCode::OK);
    assert_eq!(response.json()["id"], invited.id);
    assert_eq!(response.json()["full_name"], "Carla Sosa");

    let mut conn = app.db.acquire().await.unwrap();
    let user = directory::find_user(&mut conn, invited.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(user.status, UserStatus::Active);
    assert!(!user.has_password);
}

#[tokio::test]
async fn password_sign_in_and_invites_are_off_in_header_mode() {
    let app = header_app().await;
    let admin = sign(&claims("admin@demo.test", "Admin", "dueño", false));
    assert_eq!(me(&app, Some(&admin)).await.status, StatusCode::OK);

    let mode = call(&app, Method::GET, "/api/auth/mode", None, None, None).await;
    assert_eq!(mode.json()["mode"], "header");

    let login = call(
        &app,
        Method::POST,
        "/api/auth/login",
        None,
        None,
        Some(json!({ "email": "admin@demo.test", "password": "whatever-123" })),
    )
    .await;
    assert_eq!(login.status, StatusCode::NOT_FOUND);

    let show = call(&app, Method::GET, "/api/auth/invites/abc", None, None, None).await;
    assert_eq!(show.status, StatusCode::NOT_FOUND);
    let accept = call(
        &app,
        Method::POST,
        "/api/auth/invites/abc/accept",
        None,
        None,
        Some(json!({ "password": "a-long-password" })),
    )
    .await;
    assert_eq!(accept.status, StatusCode::NOT_FOUND);

    let create = call(
        &app,
        Method::POST,
        "/api/users",
        Some(&admin),
        None,
        Some(json!({ "email": "x@demo.test", "full_name": "X", "role": "professor" })),
    )
    .await;
    assert_eq!(create.status, StatusCode::NOT_FOUND);
    let reissue = call(
        &app,
        Method::POST,
        "/api/users/1/invite",
        Some(&admin),
        None,
        None,
    )
    .await;
    assert_eq!(reissue.status, StatusCode::NOT_FOUND);

    let list = call(&app, Method::GET, "/api/users", Some(&admin), None, None).await;
    assert_eq!(list.status, StatusCode::OK);
}

#[tokio::test]
async fn header_mode_cannot_be_configured_without_a_key() {
    let config = Config::from_lookup(|name| (name == "AUTH_MODE").then(|| "header".to_string()));
    assert!(config.is_err());
}

#[tokio::test]
async fn the_roster_creates_no_invites_in_header_mode() {
    let app = header_app().await;
    let owner = sign(&claims("prof@demo.test", "Prof", "profesor", false));
    let owner_id = me(&app, Some(&owner)).await.json()["id"].as_i64().unwrap();
    let mut conn = app.db.acquire().await.unwrap();
    let campus = directory::create_campus(&mut conn, owner_id, "Campus", owner_id)
        .await
        .unwrap()
        .id;
    drop(conn);

    let uri = format!("/api/campuses/{campus}/roster/imports");
    let preview = call(
        &app,
        Method::POST,
        &uri,
        Some(&owner),
        None,
        Some(json!({ "text": "Ana Pérez,ana@alumnos.test" })),
    )
    .await;
    assert_eq!(preview.status, StatusCode::CREATED, "{}", preview.json());
    let import = preview.json()["id"].as_i64().unwrap();
    let confirm = call(
        &app,
        Method::POST,
        &format!("{uri}/{import}/confirm"),
        Some(&owner),
        None,
        Some(json!({})),
    )
    .await;
    assert_eq!(confirm.status, StatusCode::OK, "{}", confirm.json());
    assert_eq!(confirm.json()["created"], 1);
    assert!(confirm.json()["invites"].as_array().unwrap().is_empty());
    let invites: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM core_invites")
        .fetch_one(&app.db)
        .await
        .unwrap();
    assert_eq!(invites, 0);

    let reissue = call(
        &app,
        Method::POST,
        &format!("/api/campuses/{campus}/members/1/invite"),
        Some(&owner),
        None,
        None,
    )
    .await;
    assert_eq!(reissue.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn losing_the_professor_mark_removes_manage_access_on_campuses() {
    let app = header_app().await;
    let professor = sign(&claims("prof@demo.test", "Prof", "profesor", false));
    let id = me(&app, Some(&professor)).await.json()["id"]
        .as_i64()
        .unwrap();
    let mut conn = app.db.acquire().await.unwrap();
    let campus = directory::create_campus(&mut conn, id, "Campus", id)
        .await
        .unwrap()
        .id;
    drop(conn);
    let uri = format!("/api/campuses/{campus}/roster/imports");
    let body = || Some(json!({ "text": "Ana Pérez,ana@alumnos.test" }));
    let allowed = call(&app, Method::POST, &uri, Some(&professor), None, body()).await;
    assert_eq!(allowed.status, StatusCode::CREATED);

    let demoted = sign(&claims("prof@demo.test", "Prof", "alumno", false));
    assert_eq!(me(&app, Some(&demoted)).await.json()["role"], "student");
    let denied = call(&app, Method::POST, &uri, Some(&demoted), None, body()).await;
    assert_eq!(denied.status, StatusCode::FORBIDDEN);
}
