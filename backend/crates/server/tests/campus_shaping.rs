mod common;

use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc, Mutex,
};

use async_trait::async_trait;
use australis_core::{
    ai::{AiProvider, AiReply, AiRequest, AiToolCall, Reservation},
    AppState, ProviderError, Role,
};
use axum::http::StatusCode;
use common::{TestApp, TestUser};
use serde_json::{json, Value};
use sqlx::Row;

const ETHICS: &str = "Agregá una semana sobre ética antes del examen";

/// A provider that records what it is asked and answers with a function of the call number.
struct ScriptedAi {
    calls: Arc<AtomicUsize>,
    feedback: Arc<Mutex<Vec<Vec<String>>>>,
    answer: Box<dyn Fn(usize) -> Result<Vec<AiToolCall>, ProviderError> + Send + Sync>,
}

#[async_trait]
impl AiProvider for ScriptedAi {
    fn name(&self) -> &'static str {
        "scripted"
    }

    fn is_placeholder(&self) -> bool {
        false
    }

    async fn complete(
        &self,
        request: &AiRequest,
        _reservation: &Reservation,
    ) -> Result<AiReply, ProviderError> {
        let n = self.calls.fetch_add(1, Ordering::SeqCst);
        self.feedback.lock().unwrap().push(request.feedback.clone());
        let tool_calls = (self.answer)(n)?;
        Ok(AiReply {
            text: "respuesta de prueba".into(),
            tool_calls,
            model: "test-model".into(),
            input_tokens: 100,
            output_tokens: 20,
        })
    }
}

struct Scripted {
    app: TestApp,
    calls: Arc<AtomicUsize>,
    feedback: Arc<Mutex<Vec<Vec<String>>>>,
}

async fn scripted(
    answer: impl Fn(usize) -> Result<Vec<AiToolCall>, ProviderError> + Send + Sync + 'static,
) -> Scripted {
    let calls = Arc::new(AtomicUsize::new(0));
    let feedback = Arc::new(Mutex::new(Vec::new()));
    let provider = ScriptedAi {
        calls: calls.clone(),
        feedback: feedback.clone(),
        answer: Box::new(answer),
    };
    let app = TestApp::with(|state: &mut AppState| state.ai = Arc::new(provider)).await;
    Scripted {
        app,
        calls,
        feedback,
    }
}

fn call(name: &str, input: Value) -> AiToolCall {
    AiToolCall {
        name: name.into(),
        input,
    }
}

fn good_call() -> AiToolCall {
    call(
        "add_section",
        json!({ "title": "Nueva sección", "blocks": [ { "type": "text", "text": "hola" } ] }),
    )
}

async fn create_campus(app: &TestApp, user: &TestUser) -> Value {
    let (status, body) = app
        .post_json(
            "/api/campuses",
            Some(&user.cookie),
            json!({ "name": "Seminario", "template_key": "weekly_topics" }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    body
}

async fn propose(
    app: &TestApp,
    user: &TestUser,
    campus: i64,
    instruction: &str,
) -> (StatusCode, Value) {
    app.post_json(
        &format!("/api/campuses/{campus}/ai/proposals"),
        Some(&user.cookie),
        json!({ "instruction": instruction }),
    )
    .await
}

async fn decide(
    app: &TestApp,
    user: &TestUser,
    campus: i64,
    proposal: i64,
    action: &str,
) -> (StatusCode, Value) {
    app.post_json(
        &format!("/api/campuses/{campus}/ai/proposals/{proposal}/{action}"),
        Some(&user.cookie),
        json!({}),
    )
    .await
}

async fn campus_json(app: &TestApp, user: &TestUser, campus: i64) -> Value {
    let (status, body) = app
        .get(&format!("/api/campuses/{campus}"), Some(&user.cookie))
        .await;
    assert_eq!(status, StatusCode::OK);
    body
}

async fn proposals(app: &TestApp, user: &TestUser, campus: i64) -> Vec<Value> {
    let (status, body) = app
        .get(
            &format!("/api/campuses/{campus}/ai/proposals"),
            Some(&user.cookie),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body.as_array().unwrap().clone()
}

async fn revisions(app: &TestApp, user: &TestUser, campus: i64) -> Vec<Value> {
    let (_, body) = app
        .get(
            &format!("/api/campuses/{campus}/revisions"),
            Some(&user.cookie),
        )
        .await;
    body.as_array().unwrap().clone()
}

async fn usage(app: &TestApp, user: &TestUser, campus: i64) -> Value {
    let (status, body) = app
        .get(
            &format!("/api/campuses/{campus}/ai/usage"),
            Some(&user.cookie),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body
}

async fn usage_rows(app: &TestApp, status: &str) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM core_ai_usage WHERE status = ?")
        .bind(status)
        .fetch_one(&app.db)
        .await
        .unwrap()
}

fn section_titles(campus: &Value) -> Vec<String> {
    campus["document"]["sections"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["title"].as_str().unwrap().to_string())
        .collect()
}

#[tokio::test]
async fn propose_leaves_the_campus_unchanged() {
    let app = TestApp::new().await;
    let professor = app.login_as(Role::Professor).await;
    let campus = create_campus(&app, &professor).await;
    let id = campus["id"].as_i64().unwrap();

    let (status, proposal) = propose(&app, &professor, id, ETHICS).await;
    assert_eq!(status, StatusCode::CREATED, "{proposal}");
    assert_eq!(proposal["status"], "pending");
    assert_eq!(proposal["simulated"], true);
    assert_eq!(proposal["base_version"], 1);
    assert_eq!(proposal["ops"].as_array().unwrap().len(), 1);
    assert_eq!(proposal["changes"].as_array().unwrap().len(), 1);
    let preview = proposal["preview"]["sections"].as_array().unwrap();
    assert_eq!(
        preview.len(),
        campus["document"]["sections"].as_array().unwrap().len() + 1
    );
    assert!(preview
        .iter()
        .any(|s| s["title"] == "Semana de ética profesional"
            && !s["id"].as_str().unwrap().is_empty()));

    let after = campus_json(&app, &professor, id).await;
    assert_eq!(after["version"], 1);
    assert_eq!(after["document"], campus["document"]);
    assert_eq!(revisions(&app, &professor, id).await.len(), 1);
}

#[tokio::test]
async fn accept_applies_the_change_with_an_ai_revision() {
    let app = TestApp::new().await;
    let professor = app.login_as(Role::Professor).await;
    let campus = create_campus(&app, &professor).await;
    let id = campus["id"].as_i64().unwrap();
    let (_, proposal) = propose(&app, &professor, id, ETHICS).await;
    let pid = proposal["id"].as_i64().unwrap();

    let (status, saved) = decide(&app, &professor, id, pid, "accept").await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!(saved["version"], 2);
    assert_eq!(saved["document"], proposal["preview"]);
    assert!(section_titles(&saved).contains(&"Semana de ética profesional".to_string()));

    let revs = revisions(&app, &professor, id).await;
    assert_eq!(revs.len(), 2);
    assert_eq!(revs[0]["via"], "ai");
    assert_eq!(revs[0]["proposal_id"], pid);
    assert!(revs[0]["summary"].as_str().unwrap().starts_with("IA: "));

    let listed = proposals(&app, &professor, id).await;
    assert_eq!(listed[0]["status"], "accepted");
    assert_eq!(listed[0]["revision_version"], 2);
    // A decided proposal cannot be decided again.
    let (status, _) = decide(&app, &professor, id, pid, "accept").await;
    assert_eq!(status, StatusCode::CONFLICT);
    let (status, _) = decide(&app, &professor, id, pid, "reject").await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(campus_json(&app, &professor, id).await["version"], 2);
}

#[tokio::test]
async fn accepting_after_the_campus_changed_is_a_409_and_marks_the_proposal_stale() {
    let app = TestApp::new().await;
    let professor = app.login_as(Role::Professor).await;
    let campus = create_campus(&app, &professor).await;
    let id = campus["id"].as_i64().unwrap();
    let (_, proposal) = propose(&app, &professor, id, ETHICS).await;
    let pid = proposal["id"].as_i64().unwrap();

    // Someone edits the campus after the proposal was made.
    let (status, edited) = app
        .put_json(
            &format!("/api/campuses/{id}/document"),
            Some(&professor.cookie),
            json!({ "version": 1, "document": { "schema": 1, "sections": [
                { "title": "Otra", "blocks": [] } ] } }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{edited}");

    let (status, body) = decide(&app, &professor, id, pid, "accept").await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert!(body["error"].is_string());
    assert_eq!(proposals(&app, &professor, id).await[0]["status"], "stale");
    let after = campus_json(&app, &professor, id).await;
    assert_eq!(after["version"], 2);
    assert_eq!(section_titles(&after), ["Otra"]);
    assert_eq!(revisions(&app, &professor, id).await.len(), 2);
}

#[tokio::test]
async fn accepting_one_proposal_makes_the_other_open_ones_stale() {
    let app = TestApp::new().await;
    let professor = app.login_as(Role::Professor).await;
    let id = create_campus(&app, &professor).await["id"]
        .as_i64()
        .unwrap();
    let (_, first) = propose(&app, &professor, id, ETHICS).await;
    let (_, second) = propose(&app, &professor, id, "agregá la bibliografía").await;
    let (status, _) = decide(
        &app,
        &professor,
        id,
        first["id"].as_i64().unwrap(),
        "accept",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = decide(
        &app,
        &professor,
        id,
        second["id"].as_i64().unwrap(),
        "accept",
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(campus_json(&app, &professor, id).await["version"], 2);
}

#[tokio::test]
async fn reject_changes_nothing() {
    let app = TestApp::new().await;
    let professor = app.login_as(Role::Professor).await;
    let campus = create_campus(&app, &professor).await;
    let id = campus["id"].as_i64().unwrap();
    let (_, proposal) = propose(&app, &professor, id, ETHICS).await;
    let pid = proposal["id"].as_i64().unwrap();

    let (status, rejected) = decide(&app, &professor, id, pid, "reject").await;
    assert_eq!(status, StatusCode::OK, "{rejected}");
    assert_eq!(rejected["status"], "rejected");
    assert!(rejected["preview"].is_null());
    let after = campus_json(&app, &professor, id).await;
    assert_eq!(after["version"], 1);
    assert_eq!(after["document"], campus["document"]);
    assert_eq!(revisions(&app, &professor, id).await.len(), 1);
    let (status, _) = decide(&app, &professor, id, pid, "accept").await;
    assert_eq!(status, StatusCode::CONFLICT);
}

#[tokio::test]
async fn an_exhausted_quota_is_a_429_and_the_provider_is_not_called() {
    let s = scripted(|_| Ok(vec![good_call()])).await;
    let professor = s.app.login_as(Role::Professor).await;
    let id = create_campus(&s.app, &professor).await["id"]
        .as_i64()
        .unwrap();
    sqlx::query("UPDATE core_settings SET value_json = '1' WHERE key = 'ai.shaping.daily_quota'")
        .execute(&s.app.db)
        .await
        .unwrap();

    let (status, _) = propose(&s.app, &professor, id, "agregá algo").await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(s.calls.load(Ordering::SeqCst), 1);

    let (status, body) = propose(&s.app, &professor, id, "agregá algo más").await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{body}");
    assert_eq!(s.calls.load(Ordering::SeqCst), 1);
    assert_eq!(proposals(&s.app, &professor, id).await.len(), 1);
    assert_eq!(usage_rows(&s.app, "refused").await, 1);
    let counter = usage(&s.app, &professor, id).await;
    assert_eq!(counter["used_today"], 1);
    assert_eq!(counter["quota"], 1);
    assert_eq!(counter["remaining"], 0);
}

#[tokio::test]
async fn a_zero_quota_fails_closed() {
    let s = scripted(|_| Ok(vec![good_call()])).await;
    let professor = s.app.login_as(Role::Professor).await;
    let id = create_campus(&s.app, &professor).await["id"]
        .as_i64()
        .unwrap();
    sqlx::query("UPDATE core_settings SET value_json = '0' WHERE key = 'ai.shaping.daily_quota'")
        .execute(&s.app.db)
        .await
        .unwrap();
    let (status, _) = propose(&s.app, &professor, id, "agregá algo").await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(s.calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn a_provider_error_releases_the_quota_and_stores_no_proposal() {
    let s = scripted(|_| Err(ProviderError::Failed("down".into()))).await;
    let professor = s.app.login_as(Role::Professor).await;
    let id = create_campus(&s.app, &professor).await["id"]
        .as_i64()
        .unwrap();

    let (status, body) = propose(&s.app, &professor, id, "agregá algo").await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(body["error"], "internal error");
    assert_eq!(s.calls.load(Ordering::SeqCst), 1);
    assert_eq!(usage(&s.app, &professor, id).await["used_today"], 0);
    assert_eq!(usage_rows(&s.app, "error").await, 1);
    assert!(proposals(&s.app, &professor, id).await.is_empty());
    assert_eq!(campus_json(&s.app, &professor, id).await["version"], 1);
}

#[tokio::test]
async fn every_provider_call_writes_the_usage_log_and_the_usage_endpoint_estimates_cost() {
    let app = TestApp::new().await;
    let professor = app.login_as(Role::Professor).await;
    let id = create_campus(&app, &professor).await["id"]
        .as_i64()
        .unwrap();
    for text in [ETHICS, "agregá la bibliografía"] {
        let (status, _) = propose(&app, &professor, id, text).await;
        assert_eq!(status, StatusCode::CREATED);
    }
    let row = sqlx::query(
        "SELECT user_id, campus_id, feature, provider, status, simulated, input_tokens
         FROM core_ai_usage ORDER BY id",
    )
    .fetch_all(&app.db)
    .await
    .unwrap();
    assert_eq!(row.len(), 2);
    for r in &row {
        assert_eq!(r.get::<i64, _>("user_id"), professor.id);
        assert_eq!(r.get::<i64, _>("campus_id"), id);
        assert_eq!(r.get::<String, _>("feature"), "shaping");
        assert_eq!(r.get::<String, _>("provider"), "placeholder");
        assert_eq!(r.get::<String, _>("status"), "ok");
        assert!(r.get::<bool, _>("simulated"));
        assert!(r.get::<i64, _>("input_tokens") > 0);
    }
    let u = usage(&app, &professor, id).await;
    assert_eq!(u["used_today"], 2);
    assert_eq!(u["quota"], 20);
    assert_eq!(u["remaining"], 18);
    assert_eq!(u["logged_calls"], 2);
    assert_eq!(u["cost_is_estimate"], true);
    assert_eq!(u["simulated"], true);
    assert!(u["input_tokens"].as_i64().unwrap() > 0);
    assert!(u["estimated_cost_usd"].as_f64().unwrap() > 0.0);
}

#[tokio::test]
async fn an_instruction_about_grades_gets_a_refusal_with_no_operations() {
    let app = TestApp::new().await;
    let professor = app.login_as(Role::Professor).await;
    let campus = create_campus(&app, &professor).await;
    let id = campus["id"].as_i64().unwrap();
    for text in [
        "Cambiá la nota de Ana a 10",
        "poné presente en la asistencia de ayer",
    ] {
        let (status, proposal) = propose(&app, &professor, id, text).await;
        assert_eq!(status, StatusCode::CREATED, "{proposal}");
        assert!(proposal["ops"].as_array().unwrap().is_empty());
        assert!(proposal["changes"].as_array().unwrap().is_empty());
        assert_eq!(proposal["status"], "empty");
        assert!(proposal["message"]
            .as_str()
            .unwrap()
            .contains("No puedo cambiar notas"));
        let (status, _) = decide(
            &app,
            &professor,
            id,
            proposal["id"].as_i64().unwrap(),
            "accept",
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
    }
    let after = campus_json(&app, &professor, id).await;
    assert_eq!(after["version"], 1);
    assert_eq!(after["document"], campus["document"]);
}

#[tokio::test]
async fn an_unknown_instruction_gets_the_placeholders_defined_reply() {
    let app = TestApp::new().await;
    let professor = app.login_as(Role::Professor).await;
    let id = create_campus(&app, &professor).await["id"]
        .as_i64()
        .unwrap();
    let (status, proposal) = propose(&app, &professor, id, "hacé algo sorprendente").await;
    assert_eq!(status, StatusCode::CREATED);
    assert!(proposal["ops"].as_array().unwrap().is_empty());
    assert_eq!(proposal["status"], "empty");
    assert!(proposal["message"]
        .as_str()
        .unwrap()
        .contains("respuesta simulada"));
}

#[tokio::test]
async fn guests_students_and_visitors_cannot_use_the_shaping_endpoints() {
    let app = TestApp::new().await;
    let professor = app.login_as(Role::Professor).await;
    let id = create_campus(&app, &professor).await["id"]
        .as_i64()
        .unwrap();
    let (_, proposal) = propose(&app, &professor, id, ETHICS).await;
    let pid = proposal["id"].as_i64().unwrap();
    let guest = app.seed_guest(id).await;
    let student = app.seed_student(id).await;
    let outsider = app.login_as(Role::Professor).await;

    let base = format!("/api/campuses/{id}/ai");
    for user in [&guest, &student] {
        let (status, _) = propose(&app, user, id, ETHICS).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        let (status, _) = app
            .get(&format!("{base}/proposals"), Some(&user.cookie))
            .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        let (status, _) = app.get(&format!("{base}/usage"), Some(&user.cookie)).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        for action in ["accept", "reject"] {
            let (status, _) = decide(&app, user, id, pid, action).await;
            assert_eq!(status, StatusCode::FORBIDDEN);
        }
    }
    let (status, _) = propose(&app, &outsider, id, ETHICS).await;
    assert!(status == StatusCode::FORBIDDEN || status == StatusCode::NOT_FOUND);
    let (status, _) = app.get(&format!("{base}/proposals"), None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    // Nothing the others tried changed the proposal or spent quota.
    assert_eq!(
        proposals(&app, &professor, id).await[0]["status"],
        "pending"
    );
    assert_eq!(usage(&app, &professor, id).await["used_today"], 1);
}

#[tokio::test]
async fn a_secretary_can_shape_any_campus() {
    let app = TestApp::new().await;
    let professor = app.login_as(Role::Professor).await;
    let secretary = app.login_as(Role::Secretary).await;
    let id = create_campus(&app, &professor).await["id"]
        .as_i64()
        .unwrap();
    let (status, proposal) = propose(&app, &secretary, id, ETHICS).await;
    assert_eq!(status, StatusCode::CREATED, "{proposal}");
    let (status, _) = decide(
        &app,
        &secretary,
        id,
        proposal["id"].as_i64().unwrap(),
        "accept",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn blank_and_oversized_instructions_are_422() {
    let app = TestApp::new().await;
    let professor = app.login_as(Role::Professor).await;
    let id = create_campus(&app, &professor).await["id"]
        .as_i64()
        .unwrap();
    for text in ["   ".to_string(), "x".repeat(1001)] {
        let (status, _) = propose(&app, &professor, id, &text).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    }
    assert_eq!(usage(&app, &professor, id).await["used_today"], 0);
}

#[tokio::test]
async fn restoring_after_an_ai_change_works() {
    let app = TestApp::new().await;
    let professor = app.login_as(Role::Professor).await;
    let campus = create_campus(&app, &professor).await;
    let id = campus["id"].as_i64().unwrap();
    let (_, proposal) = propose(&app, &professor, id, ETHICS).await;
    decide(
        &app,
        &professor,
        id,
        proposal["id"].as_i64().unwrap(),
        "accept",
    )
    .await;

    let (status, restored) = app
        .post_json(
            &format!("/api/campuses/{id}/revisions/1/restore"),
            Some(&professor.cookie),
            json!({}),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{restored}");
    assert_eq!(restored["version"], 3);
    assert_eq!(restored["document"], campus["document"]);
    let revs = revisions(&app, &professor, id).await;
    assert_eq!(revs.len(), 3);
    assert_eq!(revs[0]["via"], "restore");
    assert_eq!(revs[1]["via"], "ai");
}

#[tokio::test]
async fn invalid_tool_calls_go_back_as_errors_and_the_valid_answer_is_used() {
    let s = scripted(|n| {
        Ok(if n == 0 {
            vec![
                call("set_grade", json!({ "student": 1, "score": 10 })),
                call("remove_section", json!({ "section_id": "does-not-exist" })),
            ]
        } else {
            vec![good_call()]
        })
    })
    .await;
    let professor = s.app.login_as(Role::Professor).await;
    let id = create_campus(&s.app, &professor).await["id"]
        .as_i64()
        .unwrap();

    let (status, proposal) = propose(&s.app, &professor, id, "agregá algo").await;
    assert_eq!(status, StatusCode::CREATED, "{proposal}");
    assert_eq!(s.calls.load(Ordering::SeqCst), 2);
    let feedback = s.feedback.lock().unwrap().clone();
    assert!(feedback[0].is_empty());
    assert_eq!(feedback[1].len(), 2);
    assert!(feedback[1][0].contains("unknown tool 'set_grade'"));
    assert_eq!(proposal["status"], "pending");
    assert_eq!(proposal["ops"].as_array().unwrap().len(), 1);
    // Both calls are in the usage log and count against the quota.
    assert_eq!(usage_rows(&s.app, "ok").await, 2);
    assert_eq!(usage(&s.app, &professor, id).await["used_today"], 2);
}

#[tokio::test]
async fn a_provider_that_keeps_failing_stops_after_four_iterations_with_no_operations() {
    let s = scripted(|_| Ok(vec![call("set_grade", json!({ "score": 10 }))])).await;
    let professor = s.app.login_as(Role::Professor).await;
    let id = create_campus(&s.app, &professor).await["id"]
        .as_i64()
        .unwrap();
    let (status, proposal) = propose(&s.app, &professor, id, "cambiá una nota").await;
    assert_eq!(status, StatusCode::CREATED, "{proposal}");
    assert_eq!(s.calls.load(Ordering::SeqCst), 4);
    assert_eq!(proposal["status"], "empty");
    assert!(proposal["ops"].as_array().unwrap().is_empty());
    assert_eq!(campus_json(&s.app, &professor, id).await["version"], 1);
}

#[tokio::test]
async fn the_provider_is_offered_exactly_the_eight_campus_tools() {
    struct Spy(Arc<Mutex<Vec<String>>>);
    #[async_trait]
    impl AiProvider for Spy {
        fn name(&self) -> &'static str {
            "spy"
        }
        fn is_placeholder(&self) -> bool {
            false
        }
        async fn complete(
            &self,
            request: &AiRequest,
            _reservation: &Reservation,
        ) -> Result<AiReply, ProviderError> {
            *self.0.lock().unwrap() = request.tools.iter().map(|t| t.name.clone()).collect();
            Ok(AiReply {
                text: String::new(),
                tool_calls: vec![],
                model: "m".into(),
                input_tokens: 1,
                output_tokens: 1,
            })
        }
    }
    let seen = Arc::new(Mutex::new(Vec::new()));
    let spy = Spy(seen.clone());
    let app = TestApp::with(|state: &mut AppState| state.ai = Arc::new(spy)).await;
    let professor = app.login_as(Role::Professor).await;
    let id = create_campus(&app, &professor).await["id"]
        .as_i64()
        .unwrap();
    propose(&app, &professor, id, "hola").await;
    assert_eq!(
        *seen.lock().unwrap(),
        [
            "add_section",
            "update_section",
            "move_section",
            "remove_section",
            "add_block",
            "update_block",
            "move_block",
            "remove_block"
        ]
    );
}

/// Every row of every table except the campus module's and the AI usage and quota tables.
async fn snapshot_outside_campus(app: &TestApp) -> Vec<(String, String)> {
    let tables: Vec<String> = sqlx::query_scalar(
        "SELECT name FROM sqlite_master WHERE type = 'table'
           AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
           AND name NOT LIKE '\\_sqlx%' ESCAPE '\\'
         ORDER BY name",
    )
    .fetch_all(&app.db)
    .await
    .unwrap();
    let mut out = Vec::new();
    for table in tables {
        if table.starts_with("campus_") || table == "core_ai_usage" || table == "core_ai_quota" {
            continue;
        }
        let columns: Vec<String> = sqlx::query(&format!("PRAGMA table_info({table})"))
            .fetch_all(&app.db)
            .await
            .unwrap()
            .iter()
            .map(|row| row.get::<String, _>("name"))
            .collect();
        let expr = columns
            .iter()
            .map(|c| format!("quote({c})"))
            .collect::<Vec<_>>()
            .join(" || '|' || ");
        let rows: Vec<String> =
            sqlx::query_scalar(&format!("SELECT {expr} FROM {table} ORDER BY rowid"))
                .fetch_all(&app.db)
                .await
                .unwrap();
        out.push((table, rows.join("\n")));
    }
    out
}

#[tokio::test]
async fn propose_and_accept_touch_no_table_outside_the_campus_and_ai_tables() {
    let app = TestApp::new().await;
    let professor = app.login_as(Role::Professor).await;
    let id = create_campus(&app, &professor).await["id"]
        .as_i64()
        .unwrap();
    let _student = app.seed_student(id).await;

    let before = snapshot_outside_campus(&app).await;
    assert!(before.len() >= 5, "snapshot covers the kernel tables");
    assert!(before
        .iter()
        .any(|(t, rows)| t == "core_members" && !rows.is_empty()));

    // An instruction that adds content, and one that asks for a grade change.
    for text in [ETHICS, "Cambiá la nota de Ana a 10"] {
        let (status, proposal) = propose(&app, &professor, id, text).await;
        assert_eq!(status, StatusCode::CREATED);
        if proposal["status"] == "pending" {
            let (status, _) = decide(
                &app,
                &professor,
                id,
                proposal["id"].as_i64().unwrap(),
                "accept",
            )
            .await;
            assert_eq!(status, StatusCode::OK);
        }
    }

    let after = snapshot_outside_campus(&app).await;
    assert_eq!(before, after);

    // The tables that must change did.
    let usage: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM core_ai_usage")
        .fetch_one(&app.db)
        .await
        .unwrap();
    let calls: i64 = sqlx::query_scalar("SELECT COALESCE(SUM(calls), 0) FROM core_ai_quota")
        .fetch_one(&app.db)
        .await
        .unwrap();
    assert_eq!(usage, 2);
    assert_eq!(calls, 2);
}
