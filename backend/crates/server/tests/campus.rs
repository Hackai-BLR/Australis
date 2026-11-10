mod common;

use australis_core::Role;
use axum::http::StatusCode;
use common::{TestApp, TestUser};
use serde_json::{json, Value};

const TEMPLATE_KEYS: [&str; 4] = ["weekly_topics", "case_method", "workshop", "thesis_group"];

async fn create(app: &TestApp, user: &TestUser, template: &str) -> Value {
    let (status, body) = app
        .post_json(
            "/api/campuses",
            Some(&user.cookie),
            json!({ "name": "Seminario de prueba", "template_key": template }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    body
}

fn doc_with_text(text: &str) -> Value {
    json!({ "schema": 1, "sections": [
        { "title": "Una sección", "blocks": [ { "type": "text", "text": text } ] }
    ] })
}

async fn put(
    app: &TestApp,
    user: &TestUser,
    campus: i64,
    version: i64,
    document: Value,
) -> (StatusCode, Value) {
    app.put_json(
        &format!("/api/campuses/{campus}/document"),
        Some(&user.cookie),
        json!({ "version": version, "document": document, "summary": "Cambio de prueba" }),
    )
    .await
}

async fn revisions(app: &TestApp, user: &TestUser, campus: i64) -> Vec<Value> {
    let (status, body) = app
        .get(
            &format!("/api/campuses/{campus}/revisions"),
            Some(&user.cookie),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body.as_array().unwrap().clone()
}

async fn revision_rows(app: &TestApp, campus: i64) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM campus_revisions WHERE campus_id = ?")
        .bind(campus)
        .fetch_one(&app.db)
        .await
        .unwrap()
}

#[tokio::test]
async fn lists_four_valid_templates() {
    let app = TestApp::new().await;
    let (status, _) = app.get("/api/campus-templates", None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    let student = app.login_as(Role::Student).await;
    let (status, body) = app
        .get("/api/campus-templates", Some(&student.cookie))
        .await;
    assert_eq!(status, StatusCode::OK);
    let templates = body.as_array().unwrap();
    let keys: Vec<&str> = templates
        .iter()
        .map(|t| t["key"].as_str().unwrap())
        .collect();
    assert_eq!(keys, TEMPLATE_KEYS);
    for template in templates {
        assert!(!template["name"].as_str().unwrap().is_empty());
        assert!(!template["document"]["sections"]
            .as_array()
            .unwrap()
            .is_empty());
    }
}

#[tokio::test]
async fn creates_a_campus_from_each_template() {
    let app = TestApp::new().await;
    let professor = app.login_as(Role::Professor).await;
    let (_, templates) = app
        .get("/api/campus-templates", Some(&professor.cookie))
        .await;
    for key in TEMPLATE_KEYS {
        let created = create(&app, &professor, key).await;
        let id = created["id"].as_i64().unwrap();
        assert_eq!(created["template_key"], key);
        assert_eq!(created["version"], 1);
        assert_eq!(created["access"], "manage");
        assert_eq!(created["member_role"], "professor");
        let template = templates
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["key"] == key)
            .unwrap();
        assert_eq!(
            created["document"]["sections"].as_array().unwrap().len(),
            template["document"]["sections"].as_array().unwrap().len()
        );
        // Every section and block got an id.
        for section in created["document"]["sections"].as_array().unwrap() {
            assert!(!section["id"].as_str().unwrap().is_empty());
            for block in section["blocks"].as_array().unwrap() {
                assert!(!block["id"].as_str().unwrap().is_empty());
            }
        }
        let revs = revisions(&app, &professor, id).await;
        assert_eq!(revs.len(), 1);
        assert_eq!(revs[0]["version"], 1);
        assert_eq!(revs[0]["via"], "template");
    }

    let (status, list) = app.get("/api/campuses", Some(&professor.cookie)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(list.as_array().unwrap().len(), 4);
}

#[tokio::test]
async fn only_professors_and_secretaries_create_and_input_is_checked() {
    let app = TestApp::new().await;
    let student = app.login_as(Role::Student).await;
    let (status, _) = app
        .post_json(
            "/api/campuses",
            Some(&student.cookie),
            json!({ "name": "X", "template_key": "workshop" }),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    let secretary = app.login_as(Role::Secretary).await;
    let created = create(&app, &secretary, "workshop").await;
    assert_eq!(created["member_role"], "professor");

    let professor = app.login_as(Role::Professor).await;
    let (status, _) = app
        .post_json(
            "/api/campuses",
            Some(&professor.cookie),
            json!({ "name": "X", "template_key": "nope" }),
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    let (status, _) = app
        .post_json(
            "/api/campuses",
            Some(&professor.cookie),
            json!({ "name": "  ", "template_key": "workshop" }),
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    let (_, list) = app.get("/api/campuses", Some(&professor.cookie)).await;
    assert!(list.as_array().unwrap().is_empty());
}

#[tokio::test]
async fn document_limits_are_enforced() {
    let app = TestApp::new().await;
    let professor = app.login_as(Role::Professor).await;
    let created = create(&app, &professor, "workshop").await;
    let id = created["id"].as_i64().unwrap();

    let many_sections: Vec<Value> = (0..41)
        .map(|i| json!({ "title": format!("S{i}") }))
        .collect();
    let many_blocks: Vec<Value> = (0..31)
        .map(|_| json!({ "type": "text", "text": "x" }))
        .collect();
    let cases = [
        (
            "41 sections",
            json!({ "schema": 1, "sections": many_sections }),
        ),
        (
            "31 blocks",
            json!({ "schema": 1, "sections": [ { "title": "A", "blocks": many_blocks } ] }),
        ),
        ("8001 chars", doc_with_text(&"a".repeat(8001))),
        ("html", doc_with_text("hola <script>alert(1)</script>")),
        (
            "javascript url",
            json!({ "schema": 1, "sections": [ { "title": "A", "blocks": [
                { "type": "link", "label": "x", "url": "javascript:alert(1)" } ] } ] }),
        ),
        (
            "unknown widget",
            json!({ "schema": 1, "sections": [ { "title": "A", "blocks": [
                { "type": "widget", "widget": "records" } ] } ] }),
        ),
        (
            "unknown block type",
            json!({ "schema": 1, "sections": [ { "title": "A", "blocks": [
                { "type": "script", "text": "x" } ] } ] }),
        ),
        (
            "duplicate ids",
            json!({ "schema": 1, "sections": [
                { "id": "a", "title": "A" }, { "id": "a", "title": "B" } ] }),
        ),
        ("schema 2", json!({ "schema": 2, "sections": [] })),
        (
            "empty title",
            json!({ "schema": 1, "sections": [ { "title": " " } ] }),
        ),
    ];
    for (name, document) in cases {
        let (status, body) = put(&app, &professor, id, 1, document).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{name}: {body}");
        assert!(body["error"].is_string(), "{name}");
    }

    // The limits themselves are allowed.
    let sections: Vec<Value> = (0..40)
        .map(|i| json!({ "title": format!("S{i}") }))
        .collect();
    let (status, body) = put(
        &app,
        &professor,
        id,
        1,
        json!({ "schema": 1, "sections": sections }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, body) = put(&app, &professor, id, 2, doc_with_text(&"a".repeat(8000))).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["version"], 3);
    // Only the two good saves added revisions.
    assert_eq!(revision_rows(&app, id).await, 3);
}

#[tokio::test]
async fn saving_a_widget_keeps_no_data_with_it() {
    let app = TestApp::new().await;
    let professor = app.login_as(Role::Professor).await;
    let id = create(&app, &professor, "workshop").await["id"]
        .as_i64()
        .unwrap();
    let (status, body) = put(
        &app,
        &professor,
        id,
        1,
        json!({ "schema": 1, "sections": [ { "title": "Notas", "blocks": [
            { "type": "widget", "widget": "grades", "rows": [ { "score": 10 } ] } ] } ] }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let block = &body["document"]["sections"][0]["blocks"][0];
    assert_eq!(block["widget"], "grades");
    assert!(block.get("rows").is_none());
}

#[tokio::test]
async fn a_stale_version_is_a_conflict() {
    let app = TestApp::new().await;
    let professor = app.login_as(Role::Professor).await;
    let id = create(&app, &professor, "workshop").await["id"]
        .as_i64()
        .unwrap();

    let (status, body) = put(&app, &professor, id, 1, doc_with_text("primera")).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["version"], 2);

    let (status, body) = put(&app, &professor, id, 1, doc_with_text("segunda")).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert!(body["error"].is_string());
    assert_eq!(revision_rows(&app, id).await, 2);
    let (_, current) = app
        .get(&format!("/api/campuses/{id}"), Some(&professor.cookie))
        .await;
    assert_eq!(current["version"], 2);
    assert_eq!(
        current["document"]["sections"][0]["blocks"][0]["text"],
        "primera"
    );
}

#[tokio::test]
async fn a_save_writes_its_revision_in_the_same_transaction() {
    let app = TestApp::new().await;
    let professor = app.login_as(Role::Professor).await;
    let id = create(&app, &professor, "workshop").await["id"]
        .as_i64()
        .unwrap();

    let (status, _) = put(&app, &professor, id, 1, doc_with_text("uno")).await;
    assert_eq!(status, StatusCode::OK);
    let revs = revisions(&app, &professor, id).await;
    assert_eq!(revs.len(), 2);
    assert_eq!(revs[0]["version"], 2);
    assert_eq!(revs[0]["via"], "editor");
    assert_eq!(revs[0]["summary"], "Cambio de prueba");
    assert_eq!(revs[0]["created_by"], professor.id);
    assert_eq!(revs[0]["created_by_name"], professor.full_name);

    // Make the revision insert fail (version 3 already taken): the document update that
    // ran just before it in the same transaction must roll back too.
    sqlx::query(
        "INSERT INTO campus_revisions (campus_id, version, content_json, summary, via, created_by)
         VALUES (?, 3, '{}', 'bloqueo', 'editor', ?)",
    )
    .bind(id)
    .bind(professor.id)
    .execute(&app.db)
    .await
    .unwrap();
    let (status, _) = put(&app, &professor, id, 2, doc_with_text("dos")).await;
    assert_ne!(status, StatusCode::OK);
    let version: i64 =
        sqlx::query_scalar("SELECT version FROM campus_documents WHERE campus_id = ?")
            .bind(id)
            .fetch_one(&app.db)
            .await
            .unwrap();
    assert_eq!(version, 2, "the document changed without its revision");
}

#[tokio::test]
async fn another_professor_is_forbidden_and_the_secretary_is_not() {
    let app = TestApp::new().await;
    let owner = app.login_as(Role::Professor).await;
    let id = create(&app, &owner, "case_method").await["id"]
        .as_i64()
        .unwrap();
    let other = app.login_as(Role::Professor).await;

    let base = format!("/api/campuses/{id}");
    let (status, _) = app.get(&base, Some(&other.cookie)).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = put(&app, &other, id, 1, doc_with_text("x")).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = app
        .get(&format!("{base}/revisions"), Some(&other.cookie))
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = app
        .get(&format!("{base}/revisions/1"), Some(&other.cookie))
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = app
        .post_json(
            &format!("{base}/revisions/1/restore"),
            Some(&other.cookie),
            json!({}),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (_, list) = app.get("/api/campuses", Some(&other.cookie)).await;
    assert!(list.as_array().unwrap().is_empty());

    let (status, _) = app.get(&base, None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _) = app.get("/api/campuses/99999", Some(&owner.cookie)).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    let secretary = app.login_as(Role::Secretary).await;
    let (status, body) = app.get(&base, Some(&secretary.cookie)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["access"], "manage");
    let (status, _) = put(&app, &secretary, id, 1, doc_with_text("x")).await;
    assert_eq!(status, StatusCode::OK);
    let (_, list) = app.get("/api/campuses", Some(&secretary.cookie)).await;
    assert_eq!(list.as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn a_student_reads_but_cannot_write() {
    let app = TestApp::new().await;
    let owner = app.login_as(Role::Professor).await;
    let id = create(&app, &owner, "workshop").await["id"]
        .as_i64()
        .unwrap();
    // Hide a section from students.
    let (_, current) = app
        .get(&format!("/api/campuses/{id}"), Some(&owner.cookie))
        .await;
    let mut document = current["document"].clone();
    let total = document["sections"].as_array().unwrap().len();
    document["sections"][0]["visible"] = json!(false);
    let (status, _) = put(&app, &owner, id, 1, document).await;
    assert_eq!(status, StatusCode::OK);

    let student = app.seed_student(id).await;
    let (status, body) = app
        .get(&format!("/api/campuses/{id}"), Some(&student.cookie))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["access"], "view");
    assert_eq!(body["member_role"], "student");
    assert_eq!(
        body["document"]["sections"].as_array().unwrap().len(),
        total - 1
    );
    let (_, list) = app.get("/api/campuses", Some(&student.cookie)).await;
    assert_eq!(list.as_array().unwrap().len(), 1);

    let (status, _) = put(&app, &student, id, 2, doc_with_text("x")).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let base = format!("/api/campuses/{id}");
    let (status, _) = app
        .get(&format!("{base}/revisions"), Some(&student.cookie))
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = app
        .post_json(
            &format!("{base}/revisions/1/restore"),
            Some(&student.cookie),
            json!({}),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(revision_rows(&app, id).await, 2);
}

#[tokio::test]
async fn a_guest_teacher_reads_history_but_cannot_edit() {
    let app = TestApp::new().await;
    let owner = app.login_as(Role::Professor).await;
    let id = create(&app, &owner, "workshop").await["id"]
        .as_i64()
        .unwrap();
    let guest = app.seed_guest(id).await;
    let (status, body) = app
        .get(&format!("/api/campuses/{id}"), Some(&guest.cookie))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["access"], "teach");
    assert_eq!(revisions(&app, &guest, id).await.len(), 1);
    let (status, _) = put(&app, &guest, id, 1, doc_with_text("x")).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn restore_creates_a_new_revision() {
    let app = TestApp::new().await;
    let professor = app.login_as(Role::Professor).await;
    let created = create(&app, &professor, "thesis_group").await;
    let id = created["id"].as_i64().unwrap();
    let original = created["document"].clone();

    let (status, _) = put(&app, &professor, id, 1, doc_with_text("cambiado")).await;
    assert_eq!(status, StatusCode::OK);

    let (status, body) = app
        .post_json(
            &format!("/api/campuses/{id}/revisions/1/restore"),
            Some(&professor.cookie),
            json!({}),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["version"], 3);
    assert_eq!(body["document"], original);

    let revs = revisions(&app, &professor, id).await;
    assert_eq!(revs.len(), 3, "history is kept, not rewritten");
    assert_eq!(revs[0]["version"], 3);
    assert_eq!(revs[0]["via"], "restore");
    assert_eq!(revs[2]["version"], 1);

    let (status, rev) = app
        .get(
            &format!("/api/campuses/{id}/revisions/2"),
            Some(&professor.cookie),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        rev["document"]["sections"][0]["blocks"][0]["text"],
        "cambiado"
    );

    let (status, _) = app
        .post_json(
            &format!("/api/campuses/{id}/revisions/99/restore"),
            Some(&professor.cookie),
            json!({}),
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(revision_rows(&app, id).await, 3);
}
