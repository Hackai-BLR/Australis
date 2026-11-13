//! Private notes per presentation page: saving, privacy, export.

mod common;

use australis_core::Role;
use axum::http::StatusCode;
use common::{Part, TestApp, TestUser};
use serde_json::{json, Value};

/// A valid PDF with `pages` blank pages.
fn make_pdf(pages: usize) -> Vec<u8> {
    let mut out = b"%PDF-1.4\n".to_vec();
    let mut offsets = Vec::new();
    let mut object = |out: &mut Vec<u8>, body: &[u8]| {
        offsets.push(out.len());
        let n = offsets.len();
        out.extend_from_slice(format!("{n} 0 obj\n").as_bytes());
        out.extend_from_slice(body);
        out.extend_from_slice(b"\nendobj\n");
    };
    object(&mut out, b"<< /Type /Catalog /Pages 2 0 R >>");
    let kids: String = (0..pages).map(|i| format!("{} 0 R ", 3 + i)).collect();
    object(
        &mut out,
        format!("<< /Type /Pages /Kids [{kids}] /Count {pages} >>").as_bytes(),
    );
    for _ in 0..pages {
        object(
            &mut out,
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] >>",
        );
    }
    let xref = out.len();
    let count = offsets.len() + 1;
    out.extend_from_slice(format!("xref\n0 {count}\n0000000000 65535 f \n").as_bytes());
    for offset in &offsets {
        out.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
    }
    out.extend_from_slice(
        format!("trailer\n<< /Size {count} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n").as_bytes(),
    );
    out
}

struct Setup {
    app: TestApp,
    campus: i64,
    professor: TestUser,
    student: TestUser,
    other_student: TestUser,
    pid: i64,
}

async fn setup() -> Setup {
    let app = TestApp::new().await;
    let professor = app.login_as(Role::Professor).await;
    let campus = app.seed_campus(&professor).await;
    let student = app.seed_student(campus).await;
    let other_student = app.seed_student(campus).await;
    let (status, pres) = app
        .post_multipart(
            &format!("/api/campuses/{campus}/presentations"),
            Some(&professor.cookie),
            vec![
                Part::text("title", "Clase 1"),
                Part::file("file", "a.pdf", "application/pdf", make_pdf(3)),
            ],
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{pres}");
    let pid = pres["id"].as_i64().unwrap();
    Setup {
        app,
        campus,
        professor,
        student,
        other_student,
        pid,
    }
}

async fn save(s: &Setup, cookie: &str, page: i64, body: &str) -> (StatusCode, Value) {
    s.app
        .put_json(
            &format!("/api/presentations/{}/notes/{page}", s.pid),
            Some(cookie),
            json!({ "body": body }),
        )
        .await
}

async fn list(s: &Setup, cookie: &str) -> Value {
    let (status, notes) = s
        .app
        .get(&format!("/api/presentations/{}/notes", s.pid), Some(cookie))
        .await;
    assert_eq!(status, StatusCode::OK, "{notes}");
    notes
}

#[tokio::test]
async fn a_student_saves_updates_and_lists_notes_in_page_order() {
    let s = setup().await;
    let c = &s.student.cookie;
    assert_eq!(save(&s, c, 3, "tercera").await.0, StatusCode::OK);
    assert_eq!(save(&s, c, 1, "primera").await.0, StatusCode::OK);
    let (status, updated) = save(&s, c, 1, "primera, corregida").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(updated["body"], "primera, corregida");

    let notes = list(&s, c).await;
    let notes = notes.as_array().unwrap();
    assert_eq!(notes.len(), 2);
    assert_eq!(notes[0]["page"], 1);
    assert_eq!(notes[0]["body"], "primera, corregida");
    assert_eq!(notes[1]["page"], 3);
}

#[tokio::test]
async fn an_empty_note_removes_it() {
    let s = setup().await;
    let c = &s.student.cookie;
    save(&s, c, 2, "algo").await;
    let (status, body) = save(&s, c, 2, "   ").await;
    assert_eq!(status, StatusCode::OK);
    assert!(body.is_null());
    assert!(list(&s, c).await.as_array().unwrap().is_empty());
}

#[tokio::test]
async fn notes_are_private_to_their_author_even_from_the_secretary() {
    let s = setup().await;
    save(&s, &s.student.cookie, 1, "secreto").await;

    let secretary = s.app.login_as(Role::Secretary).await;
    for cookie in [
        &s.other_student.cookie,
        &s.professor.cookie,
        &secretary.cookie,
    ] {
        assert!(list(&s, cookie).await.as_array().unwrap().is_empty());
        let response = s
            .app
            .get_response(
                &format!("/api/presentations/{}/notes/export", s.pid),
                Some(cookie),
            )
            .await;
        assert_eq!(response.status, StatusCode::OK);
        assert!(!response.text().contains("secreto"));
    }

    // Another user's note on the same page is a separate note, not an overwrite.
    save(&s, &s.other_student.cookie, 1, "mía").await;
    assert_eq!(list(&s, &s.student.cookie).await[0]["body"], "secreto");
}

#[tokio::test]
async fn a_stranger_or_signed_out_caller_gets_nothing() {
    let s = setup().await;
    let stranger = s.app.login_as(Role::Student).await;
    let (status, _) = save(&s, &stranger.cookie, 1, "x").await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = s
        .app
        .get(&format!("/api/presentations/{}/notes", s.pid), None)
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _) = s
        .app
        .get(
            &format!("/api/presentations/{}/notes", s.pid),
            Some(&stranger.cookie),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn a_suspended_student_loses_access_to_notes() {
    let s = setup().await;
    save(&s, &s.student.cookie, 1, "hola").await;
    let mut conn = s.app.db.acquire().await.unwrap();
    australis_core::directory::suspend_member(
        &mut conn,
        s.professor.id,
        s.campus,
        s.student.id,
        "baja",
    )
    .await
    .unwrap();
    drop(conn);
    let (status, _) = s
        .app
        .get(
            &format!("/api/presentations/{}/notes", s.pid),
            Some(&s.student.cookie),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn pages_outside_the_presentation_and_huge_notes_are_refused() {
    let s = setup().await;
    let c = &s.student.cookie;
    assert_eq!(
        save(&s, c, 0, "x").await.0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        save(&s, c, 4, "x").await.0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let huge = "a".repeat(10_001);
    assert_eq!(
        save(&s, c, 1, &huge).await.0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let (status, _) = s
        .app
        .put_json(
            "/api/presentations/9999/notes/1",
            Some(c),
            json!({"body": "x"}),
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn the_export_is_a_text_file_with_every_note_in_page_order() {
    let s = setup().await;
    let c = &s.student.cookie;
    save(&s, c, 2, "segunda").await;
    save(&s, c, 1, "primera").await;
    let response = s
        .app
        .get_response(
            &format!("/api/presentations/{}/notes/export", s.pid),
            Some(c),
        )
        .await;
    assert_eq!(response.status, StatusCode::OK);
    assert!(response
        .header("content-type")
        .unwrap()
        .starts_with("text/plain"));
    assert!(response
        .header("content-disposition")
        .unwrap()
        .starts_with("attachment"));
    let text = response.text();
    assert!(text.contains("Clase 1"));
    let first = text.find("primera").unwrap();
    let second = text.find("segunda").unwrap();
    assert!(first < second);
    assert!(text.contains("Página 1") && text.contains("Página 2"));
}
