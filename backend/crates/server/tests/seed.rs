mod common;

use std::sync::Arc;

use australis_core::{
    auth,
    directory::{self, UserStatus},
    Config, Role,
};
use australis_server::seed::{self, DEMO_ACCOUNTS};
use common::TestApp;

const ADMIN_EMAIL: &str = "secretaria@test.example";
const ADMIN_PASSWORD: &str = "a-long-admin-password";

async fn app_with_seed(demo: bool) -> TestApp {
    TestApp::with(|state| {
        state.config = Arc::new(Config {
            seed_admin_email: Some(ADMIN_EMAIL.into()),
            seed_admin_password: Some(ADMIN_PASSWORD.into()),
            seed_demo: demo,
            ..(*state.config).clone()
        });
    })
    .await
}

async fn user_count(app: &TestApp) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM core_users")
        .fetch_one(&app.db)
        .await
        .unwrap()
}

#[tokio::test]
async fn without_seed_variables_nothing_is_created() {
    let app = TestApp::new().await;
    assert_eq!(seed::run(&app.state).await.unwrap(), 0);
    assert_eq!(user_count(&app).await, 0);
}

#[tokio::test]
async fn seed_admin_creates_the_first_secretary_once() {
    let app = app_with_seed(false).await;
    assert_eq!(seed::run(&app.state).await.unwrap(), 1);
    assert_eq!(seed::run(&app.state).await.unwrap(), 0);
    assert_eq!(user_count(&app).await, 1);

    let mut conn = app.db.acquire().await.unwrap();
    let credentials = directory::find_credentials(&mut conn, ADMIN_EMAIL)
        .await
        .unwrap()
        .expect("the secretary exists");
    assert_eq!(credentials.user.role, Role::Secretary);
    assert_eq!(credentials.user.status, UserStatus::Active);
    let hash = credentials.password_hash.expect("has a password");
    assert!(auth::verify_password(&hash, ADMIN_PASSWORD).await);
    assert!(!auth::verify_password(&hash, "something else").await);
}

#[tokio::test]
async fn seed_demo_adds_fake_professors_and_students_and_is_idempotent() {
    let app = app_with_seed(true).await;
    assert_eq!(
        seed::run(&app.state).await.unwrap(),
        1 + DEMO_ACCOUNTS.len()
    );
    assert_eq!(seed::run(&app.state).await.unwrap(), 0);
    assert_eq!(user_count(&app).await as usize, 1 + DEMO_ACCOUNTS.len());

    let mut conn = app.db.acquire().await.unwrap();
    let users = directory::list_users(&mut conn).await.unwrap();
    assert!(users.iter().any(|user| user.role == Role::Professor));
    assert!(users.iter().any(|user| user.role == Role::Student));
    assert!(users.iter().all(|user| user.status == UserStatus::Active));
    // Demo people are invented: every address is on a reserved example domain.
    assert!(DEMO_ACCOUNTS
        .iter()
        .all(|(email, _, _)| email.ends_with(".example")));
}

#[tokio::test]
async fn seed_does_not_touch_an_existing_account() {
    let app = app_with_seed(false).await;
    seed::run(&app.state).await.unwrap();
    let before: String = sqlx::query_scalar("SELECT password_hash FROM core_users WHERE email = ?")
        .bind(ADMIN_EMAIL)
        .fetch_one(&app.db)
        .await
        .unwrap();

    seed::run(&app.state).await.unwrap();
    let after: String = sqlx::query_scalar("SELECT password_hash FROM core_users WHERE email = ?")
        .bind(ADMIN_EMAIL)
        .fetch_one(&app.db)
        .await
        .unwrap();
    assert_eq!(before, after);
}

#[tokio::test]
async fn seed_demo_without_admin_variables_creates_nothing() {
    let app = TestApp::with(|state| {
        state.config = Arc::new(Config {
            seed_demo: true,
            ..(*state.config).clone()
        });
    })
    .await;
    assert_eq!(seed::run(&app.state).await.unwrap(), 0);
    assert_eq!(user_count(&app).await, 0);
}

#[tokio::test]
async fn a_short_admin_password_is_refused() {
    let app = TestApp::with(|state| {
        state.config = Arc::new(Config {
            seed_admin_email: Some(ADMIN_EMAIL.into()),
            seed_admin_password: Some("short".into()),
            ..(*state.config).clone()
        });
    })
    .await;
    assert!(seed::run(&app.state).await.is_err());
    assert_eq!(user_count(&app).await, 0);
}
