//! The model-proxy AI provider (M4): what it sends to the core's proxy, how it reads the
//! reply, how a quota refusal from the core surfaces, and how the provider is chosen.
//! A fake proxy on a local port stands in for the core; nothing leaves the machine.

mod common;

use std::sync::{Arc, Mutex};

use australis_core::{
    ai::{self, AiRequest, AiTool, ProxyAi, UsageQuery, UsageStatus, FEATURE_SHAPING},
    config::Argon2Cost,
    Config, Role,
};
use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    routing::post,
    Json, Router,
};
use common::TestApp;
use serde_json::{json, Value};

const TOKEN: &str = "cmt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

#[derive(Clone, Default)]
struct Fake {
    seen: Arc<Mutex<Vec<(HeaderMap, Value)>>>,
    /// When set, the fake answers 429 with this message.
    refuse: Arc<Mutex<Option<String>>>,
}

async fn messages(
    State(fake): State<Fake>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> (StatusCode, Json<Value>) {
    fake.seen.lock().unwrap().push((headers, body));
    if let Some(message) = fake.refuse.lock().unwrap().clone() {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(json!({ "type": "error", "error": { "type": "rate_limit_error", "message": message } })),
        );
    }
    (
        StatusCode::OK,
        Json(json!({
            "model": "claude-test",
            "content": [
                { "type": "text", "text": "Listo, agregué la sección." },
                { "type": "tool_use", "id": "t1", "name": "add_section",
                  "input": { "title": "Ética", "placement": { "at": "end" }, "blocks": [] } },
                { "type": "tool_use", "id": "t2", "name": "change_grade", "input": { "grade": 10 } }
            ],
            "usage": { "input_tokens": 100, "output_tokens": 40, "cache_read_input_tokens": 10 }
        })),
    )
}

async fn start_fake() -> (String, Fake) {
    let fake = Fake::default();
    let router = Router::new()
        .route("/modelo/v1/messages", post(messages))
        .with_state(fake.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    (url, fake)
}

async fn app_with_proxy(url: &str) -> TestApp {
    let provider = ProxyAi::new(url, TOKEN, "claude-test").unwrap();
    TestApp::with(|state| state.ai = Arc::new(provider)).await
}

fn request(instruction: &str) -> AiRequest {
    AiRequest {
        feature: FEATURE_SHAPING.into(),
        system: "Sos el asistente del campus.".into(),
        context: "Semana 1: Introducción".into(),
        instruction: instruction.into(),
        tools: vec![AiTool {
            name: "add_section".into(),
            description: "Adds a section".into(),
            input_schema: json!({ "type": "object" }),
        }],
        feedback: vec!["title is required".into()],
    }
}

async fn calls_used(app: &TestApp, user_id: i64) -> i64 {
    sqlx::query_scalar("SELECT COALESCE(SUM(calls), 0) FROM core_ai_quota WHERE user_id = ?")
        .bind(user_id)
        .fetch_one(&app.db)
        .await
        .unwrap()
}

#[tokio::test]
async fn the_call_goes_to_the_proxy_with_its_token_and_the_professor_and_is_logged_real() {
    let (url, fake) = start_fake().await;
    let app = app_with_proxy(&url).await;
    let professor = app.login_as(Role::Professor).await;

    let outcome = ai::run(&app.state, professor.id, None, &request("agregá ética"))
        .await
        .unwrap();

    assert!(!outcome.simulated, "no Simulado badge with the proxy provider");
    assert_eq!(outcome.reply.text, "Listo, agregué la sección.");
    assert_eq!(outcome.reply.model, "claude-test");
    assert_eq!(outcome.reply.input_tokens, 110);
    assert_eq!(outcome.reply.output_tokens, 40);
    assert_eq!(
        outcome.reply.tool_calls.len(),
        1,
        "a tool that was not offered is dropped"
    );
    assert_eq!(outcome.reply.tool_calls[0].name, "add_section");

    let seen = fake.seen.lock().unwrap();
    assert_eq!(seen.len(), 1);
    let (headers, body) = &seen[0];
    assert_eq!(headers["x-api-key"], TOKEN);
    assert_eq!(headers["x-campus-usuario"], professor.email.as_str());
    assert!(headers.get("authorization").is_none());
    assert_eq!(body["model"], "claude-test");
    assert_eq!(body["system"], "Sos el asistente del campus.");
    assert_eq!(body["tools"][0]["name"], "add_section");
    let text = body["messages"][0]["content"].as_str().unwrap();
    assert!(text.contains("Semana 1: Introducción"));
    assert!(text.contains("agregá ética"));
    assert!(text.contains("title is required"));

    let mut conn = app.db.acquire().await.unwrap();
    let usage = ai::list_usage(
        &mut conn,
        UsageQuery {
            user_id: Some(professor.id),
            ..UsageQuery::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(usage.len(), 1);
    assert_eq!(usage[0].provider, "proxy");
    assert!(!usage[0].simulated);
    assert_eq!(usage[0].status, UsageStatus::Ok);
    assert_eq!(usage[0].input_tokens, 110);
}

#[tokio::test]
async fn the_daily_quota_stays_as_a_second_limit_before_the_proxy_is_called() {
    let (url, fake) = start_fake().await;
    let app = app_with_proxy(&url).await;
    sqlx::query("UPDATE core_settings SET value_json = '1' WHERE key = 'ai.shaping.daily_quota'")
        .execute(&app.db)
        .await
        .unwrap();
    let professor = app.login_as(Role::Professor).await;

    ai::run(&app.state, professor.id, None, &request("uno"))
        .await
        .unwrap();
    let err = ai::run(&app.state, professor.id, None, &request("dos"))
        .await
        .unwrap_err();

    assert_eq!(err.status(), StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(fake.seen.lock().unwrap().len(), 1, "the proxy was not called");
}

#[tokio::test]
async fn the_core_quota_refusal_is_a_429_with_its_message_and_gives_the_call_back() {
    let (url, fake) = start_fake().await;
    *fake.refuse.lock().unwrap() = Some("Se agotó tu cupo mensual de uso del agente.".into());
    let app = app_with_proxy(&url).await;
    let professor = app.login_as(Role::Professor).await;

    let err = ai::run(&app.state, professor.id, None, &request("agregá ética"))
        .await
        .unwrap_err();

    assert_eq!(err.status(), StatusCode::TOO_MANY_REQUESTS);
    assert!(err.to_string().contains("Se agotó tu cupo mensual"));
    assert_eq!(calls_used(&app, professor.id).await, 0);
    let mut conn = app.db.acquire().await.unwrap();
    let usage = ai::list_usage(&mut conn, UsageQuery::default())
        .await
        .unwrap();
    assert_eq!(usage[0].status, UsageStatus::Error);
}

#[tokio::test]
async fn an_unreachable_proxy_is_an_error_that_leaks_no_token() {
    let app = app_with_proxy("http://127.0.0.1:1").await;
    let professor = app.login_as(Role::Professor).await;

    let err = ai::run(&app.state, professor.id, None, &request("hola"))
        .await
        .unwrap_err();

    assert!(!format!("{err:?}").contains(TOKEN));
    assert_eq!(calls_used(&app, professor.id).await, 0);
}

fn config(provider: &str, url: Option<&str>, key: Option<&str>) -> Config {
    let id = std::process::id();
    let nonce = rand_suffix();
    Config {
        database_url: format!(
            "sqlite://{}/australis-m4-{id}-{nonce}.db",
            std::env::temp_dir().display()
        ),
        ai_provider: provider.into(),
        ai_proxy_url: url.map(str::to_string),
        ai_api_key: key.map(str::to_string),
        argon2: Argon2Cost::for_tests(),
        ..Config::default()
    }
}

fn rand_suffix() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos() as u64;
    nanos ^ NEXT.fetch_add(1, Ordering::SeqCst)
}

#[tokio::test]
async fn the_proxy_provider_is_chosen_only_when_configured_completely() {
    let placeholder = australis_server::build_state(config("placeholder", None, None))
        .await
        .unwrap();
    assert!(placeholder.ai.is_placeholder());

    let proxy = australis_server::build_state(config(
        "proxy",
        Some("http://127.0.0.1:9"),
        Some(TOKEN),
    ))
    .await
    .unwrap();
    assert!(!proxy.ai.is_placeholder());
    assert_eq!(proxy.ai.name(), "proxy");

    for incomplete in [
        config("proxy", None, Some(TOKEN)),
        config("proxy", Some("http://127.0.0.1:9"), None),
        config("openai", None, None),
    ] {
        assert!(australis_server::build_state(incomplete).await.is_err());
    }
}
