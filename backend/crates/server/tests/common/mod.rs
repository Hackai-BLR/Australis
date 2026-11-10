//! Test helpers shared by all integration tests. Declare `mod common;` in a test file.
//!
//! Each `TestApp` has its own SQLite file in the temp directory (removed on drop), with all
//! migrations applied, placeholder providers and a cheap Argon2 cost. Requests go through
//! `tower::ServiceExt::oneshot`; no port is opened.
//!
//! ```ignore
//! let app = TestApp::new().await;
//! let professor = app.login_as(Role::Professor).await;
//! let campus = app.seed_campus(&professor).await;
//! let student = app.seed_student(campus).await;
//! let (status, body) = app.get(&format!("/api/campuses/{campus}"), Some(&student.cookie)).await;
//! ```
#![allow(dead_code)]

use std::{
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};

use australis_core::{
    auth::{self, SESSION_COOKIE},
    config::Argon2Cost,
    directory::{self, MemberRole, NewUser},
    AppState, Config, CurrentUser, Role,
};
use axum::{
    body::{Body, Bytes},
    http::{
        header::{CONTENT_TYPE, COOKIE, SET_COOKIE},
        request::Builder,
        HeaderMap, Method, Request, StatusCode,
    },
    Router,
};
use http_body_util::BodyExt;
use rand::RngCore;
use serde_json::Value;
use sqlx::SqlitePool;
use tower::ServiceExt;

/// The password of every account the helpers create.
pub const TEST_PASSWORD: &str = "test-password-123";

static COUNTER: AtomicU64 = AtomicU64::new(1);

pub struct TestApp {
    /// The full app, exactly as `main.rs` serves it.
    pub router: Router,
    pub db: SqlitePool,
    pub state: AppState,
    db_path: PathBuf,
}

/// An account created by a helper, with a session already open.
#[derive(Debug, Clone)]
pub struct TestUser {
    pub id: i64,
    pub email: String,
    pub full_name: String,
    pub role: Role,
    /// Ready to pass as the `cookie` argument of the request helpers.
    pub cookie: String,
}

impl TestUser {
    pub fn current(&self) -> CurrentUser {
        CurrentUser {
            id: self.id,
            email: self.email.clone(),
            full_name: self.full_name.clone(),
            role: self.role,
        }
    }
}

pub struct TestResponse {
    pub status: StatusCode,
    pub headers: HeaderMap,
    pub body: Bytes,
}

impl TestResponse {
    /// The body as JSON, or `Value::Null` if it is not JSON.
    pub fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or(Value::Null)
    }

    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }

    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).and_then(|value| value.to_str().ok())
    }

    /// The session cookie set by the response (`australis_session=<token>`), ready to pass
    /// as the `cookie` argument of the request helpers. `None` if none was set or it was
    /// cleared.
    pub fn session_cookie(&self) -> Option<String> {
        self.headers
            .get_all(SET_COOKIE)
            .iter()
            .filter_map(|value| value.to_str().ok())
            .filter_map(|value| value.split(';').next())
            .find(|pair| {
                pair.strip_prefix(SESSION_COOKIE)
                    .and_then(|rest| rest.strip_prefix('='))
                    .is_some_and(|token| !token.is_empty())
            })
            .map(str::to_string)
    }
}

/// One part of a multipart form.
pub struct Part {
    pub name: String,
    pub filename: Option<String>,
    pub content_type: Option<String>,
    pub bytes: Vec<u8>,
}

impl Part {
    pub fn text(name: &str, value: &str) -> Self {
        Self {
            name: name.into(),
            filename: None,
            content_type: None,
            bytes: value.as_bytes().to_vec(),
        }
    }

    pub fn file(name: &str, filename: &str, content_type: &str, bytes: impl Into<Vec<u8>>) -> Self {
        Self {
            name: name.into(),
            filename: Some(filename.into()),
            content_type: Some(content_type.into()),
            bytes: bytes.into(),
        }
    }
}

impl TestApp {
    pub async fn new() -> Self {
        Self::with(|_| {}).await
    }

    /// Like `new`, but lets the test change the state before the router is built, for
    /// example to swap a provider: `TestApp::with(|state| state.ai = Arc::new(MyAi)).await`.
    pub async fn with(customize: impl FnOnce(&mut AppState)) -> Self {
        let id = random_hex();
        let dir = std::env::temp_dir();
        let db_path = dir.join(format!("australis-test-{id}.db"));
        let config = Config {
            database_url: format!("sqlite://{}", db_path.display()),
            upload_dir: dir.join(format!("australis-test-{id}-uploads")),
            argon2: Argon2Cost::for_tests(),
            ..Config::default()
        };
        let mut state = australis_server::build_state(config)
            .await
            .expect("build test state");
        customize(&mut state);
        Self {
            router: australis_server::app(state.clone()),
            db: state.db.clone(),
            state,
            db_path,
        }
    }

    // --- requests -----------------------------------------------------------------------

    /// Sends any request to the app.
    pub async fn send(&self, request: Request<Body>) -> TestResponse {
        send(&self.router, request).await
    }

    pub async fn get(&self, uri: &str, cookie: Option<&str>) -> (StatusCode, Value) {
        as_json(self.get_response(uri, cookie).await)
    }

    /// GET that keeps the headers and the raw body (downloads, cookies).
    pub async fn get_response(&self, uri: &str, cookie: Option<&str>) -> TestResponse {
        self.send(
            request(Method::GET, uri, cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
    }

    pub async fn post_json(
        &self,
        uri: &str,
        cookie: Option<&str>,
        body: Value,
    ) -> (StatusCode, Value) {
        as_json(self.json_response(Method::POST, uri, cookie, body).await)
    }

    pub async fn put_json(
        &self,
        uri: &str,
        cookie: Option<&str>,
        body: Value,
    ) -> (StatusCode, Value) {
        as_json(self.json_response(Method::PUT, uri, cookie, body).await)
    }

    pub async fn patch_json(
        &self,
        uri: &str,
        cookie: Option<&str>,
        body: Value,
    ) -> (StatusCode, Value) {
        as_json(self.json_response(Method::PATCH, uri, cookie, body).await)
    }

    pub async fn delete(&self, uri: &str, cookie: Option<&str>) -> (StatusCode, Value) {
        as_json(
            self.send(
                request(Method::DELETE, uri, cookie)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await,
        )
    }

    /// A JSON request with any method that keeps the response headers (for `Set-Cookie`).
    pub async fn json_response(
        &self,
        method: Method,
        uri: &str,
        cookie: Option<&str>,
        body: Value,
    ) -> TestResponse {
        self.send(json_request(method, uri, cookie, &body)).await
    }

    pub async fn post_multipart(
        &self,
        uri: &str,
        cookie: Option<&str>,
        parts: Vec<Part>,
    ) -> (StatusCode, Value) {
        as_json(self.send(multipart_request(uri, cookie, parts)).await)
    }

    // --- seeding ------------------------------------------------------------------------

    /// Creates an active account with the role and opens a session for it.
    pub async fn login_as(&self, role: Role) -> TestUser {
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let label = role.as_str();
        let mut conn = self.db.acquire().await.expect("acquire");
        let password_hash = auth::hash_password(&self.state.config, TEST_PASSWORD)
            .await
            .expect("hash password");
        let user = directory::create_user(
            &mut conn,
            NewUser {
                email: &format!("{label}{n}-{}@test.example", &random_hex()[..6]),
                full_name: &format!("Test {label} {n}"),
                role,
                password_hash: Some(password_hash),
            },
        )
        .await
        .expect("create user");
        let token = auth::create_session(&mut conn, user.id, self.state.config.session_ttl_hours)
            .await
            .expect("create session");
        TestUser {
            id: user.id,
            email: user.email,
            full_name: user.full_name,
            role: user.role,
            cookie: format!("{SESSION_COOKIE}={token}"),
        }
    }

    /// Creates a campus owned by `owner` (who becomes its professor member) and returns
    /// its id. Only the kernel row exists; a module that needs its own rows adds them.
    pub async fn seed_campus(&self, owner: &TestUser) -> i64 {
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let mut conn = self.db.acquire().await.expect("acquire");
        directory::create_campus(&mut conn, owner.id, &format!("Test campus {n}"), owner.id)
            .await
            .expect("create campus")
            .id
    }

    /// Creates a student account, signed in, that is an active student of the campus.
    pub async fn seed_student(&self, campus_id: i64) -> TestUser {
        let student = self.login_as(Role::Student).await;
        self.add_member(campus_id, &student, MemberRole::Student)
            .await;
        student
    }

    /// Creates a professor account, signed in, that is a guest teacher of the campus.
    pub async fn seed_guest(&self, campus_id: i64) -> TestUser {
        let guest = self.login_as(Role::Professor).await;
        self.add_member(campus_id, &guest, MemberRole::Guest).await;
        guest
    }

    /// Adds an existing account to a campus, acting as the campus owner.
    pub async fn add_member(&self, campus_id: i64, user: &TestUser, role: MemberRole) {
        let mut conn = self.db.acquire().await.expect("acquire");
        let owner_id = directory::find_campus(&mut conn, campus_id)
            .await
            .expect("find campus")
            .expect("campus exists")
            .owner_id;
        directory::add_member(&mut conn, owner_id, campus_id, user.id, role)
            .await
            .expect("add member");
    }
}

impl Drop for TestApp {
    fn drop(&mut self) {
        let base = self.db_path.display().to_string();
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{base}{suffix}"));
        }
        let _ = std::fs::remove_dir_all(&self.state.config.upload_dir);
    }
}

// --- free helpers, usable with any router ---------------------------------------------------

/// Sends a request to a router. Use it for test-only routers built on `app.state`.
pub async fn send(router: &Router, request: Request<Body>) -> TestResponse {
    let response = router.clone().oneshot(request).await.expect("request");
    let status = response.status();
    let headers = response.headers().clone();
    let body = response
        .into_body()
        .collect()
        .await
        .expect("read body")
        .to_bytes();
    TestResponse {
        status,
        headers,
        body,
    }
}

/// Starts a request, with the session cookie if there is one.
pub fn request(method: Method, uri: &str, cookie: Option<&str>) -> Builder {
    let builder = Request::builder().method(method).uri(uri);
    match cookie {
        Some(cookie) => builder.header(COOKIE, cookie),
        None => builder,
    }
}

pub fn json_request(
    method: Method,
    uri: &str,
    cookie: Option<&str>,
    body: &Value,
) -> Request<Body> {
    request(method, uri, cookie)
        .header(CONTENT_TYPE, "application/json")
        .body(Body::from(body.to_string()))
        .unwrap()
}

pub fn multipart_request(uri: &str, cookie: Option<&str>, parts: Vec<Part>) -> Request<Body> {
    let boundary = format!("australis-test-{}", random_hex());
    let mut body = Vec::new();
    for part in parts {
        body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
        let mut disposition = format!("Content-Disposition: form-data; name=\"{}\"", part.name);
        if let Some(filename) = &part.filename {
            disposition.push_str(&format!("; filename=\"{filename}\""));
        }
        body.extend_from_slice(disposition.as_bytes());
        body.extend_from_slice(b"\r\n");
        if let Some(content_type) = &part.content_type {
            body.extend_from_slice(format!("Content-Type: {content_type}\r\n").as_bytes());
        }
        body.extend_from_slice(b"\r\n");
        body.extend_from_slice(&part.bytes);
        body.extend_from_slice(b"\r\n");
    }
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    request(Method::POST, uri, cookie)
        .header(
            CONTENT_TYPE,
            format!("multipart/form-data; boundary={boundary}"),
        )
        .body(Body::from(body))
        .unwrap()
}

fn as_json(response: TestResponse) -> (StatusCode, Value) {
    (response.status, response.json())
}

fn random_hex() -> String {
    let mut bytes = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
