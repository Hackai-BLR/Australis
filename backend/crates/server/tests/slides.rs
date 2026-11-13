//! Synced presentations: upload, live sessions, goto, and the SSE stream.

mod common;

use std::time::Duration;

use australis_core::Role;
use axum::{body::Body, http::Method, http::StatusCode};
use common::{Part, TestApp, TestUser};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tower::ServiceExt;

/// A valid PDF with `pages` blank pages. `padding` adds an unreferenced stream of that many
/// bytes, to make large files.
fn make_pdf(pages: usize, padding: usize) -> Vec<u8> {
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
    if padding > 0 {
        let mut body = format!("<< /Length {padding} >>\nstream\n").into_bytes();
        body.extend(std::iter::repeat_n(b'x', padding));
        body.extend_from_slice(b"\nendstream");
        object(&mut out, &body);
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
}

async fn setup() -> Setup {
    let app = TestApp::new().await;
    let professor = app.login_as(Role::Professor).await;
    let campus = app.seed_campus(&professor).await;
    let student = app.seed_student(campus).await;
    Setup {
        app,
        campus,
        professor,
        student,
    }
}

async fn upload(s: &Setup, cookie: &str, filename: &str, bytes: Vec<u8>) -> (StatusCode, Value) {
    s.app
        .post_multipart(
            &format!("/api/campuses/{}/presentations", s.campus),
            Some(cookie),
            vec![
                Part::text("title", "Clase 1"),
                Part::file("file", filename, "application/pdf", bytes),
            ],
        )
        .await
}

/// Uploads a PDF with `pages` pages and starts presenting it. Returns the live state.
async fn go_live(s: &Setup, pages: usize) -> Value {
    let (status, pres) = upload(s, &s.professor.cookie, "a.pdf", make_pdf(pages, 0)).await;
    assert_eq!(status, StatusCode::CREATED, "{pres}");
    let (status, live) = s
        .app
        .post_json(
            &format!("/api/presentations/{}/live", pres["id"]),
            Some(&s.professor.cookie),
            json!({}),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{live}");
    live
}

async fn goto(s: &Setup, cookie: &str, live: &Value, page: i64) -> (StatusCode, Value) {
    s.app
        .post_json(
            &format!("/api/live/{}/goto", live["id"]),
            Some(cookie),
            json!({ "page": page }),
        )
        .await
}

#[tokio::test]
async fn a_pdf_upload_stores_the_file_and_counts_pages() {
    let s = setup().await;
    let pdf = make_pdf(3, 0);
    let (status, body) = upload(&s, &s.professor.cookie, "clase.pdf", pdf.clone()).await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    assert_eq!(body["page_count"], 3);
    assert_eq!(body["title"], "Clase 1");
    assert_eq!(body["source_filename"], "clase.pdf");
    assert!(body.get("pdf_key").is_none());

    let (status, list) = s
        .app
        .get(
            &format!("/api/campuses/{}/presentations", s.campus),
            Some(&s.student.cookie),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(list.as_array().unwrap().len(), 1);

    let file = s
        .app
        .get_response(
            &format!("/api/presentations/{}/file", body["id"]),
            Some(&s.student.cookie),
        )
        .await;
    assert_eq!(file.status, StatusCode::OK);
    assert_eq!(file.header("content-type"), Some("application/pdf"));
    assert_eq!(file.body.to_vec(), pdf);
}

#[tokio::test]
async fn an_upload_with_a_non_positive_class_id_is_refused() {
    let s = setup().await;
    for bad in ["0", "-3"] {
        let (status, body) = s
            .app
            .post_multipart(
                &format!("/api/campuses/{}/presentations", s.campus),
                Some(&s.professor.cookie),
                vec![
                    Part::text("class_id", bad),
                    Part::file("file", "a.pdf", "application/pdf", make_pdf(1, 0)),
                ],
            )
            .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{bad}: {body}");
    }
}

#[tokio::test]
async fn an_upload_linked_to_a_class_of_another_campus_or_none_is_refused() {
    let s = setup().await;
    let other_owner = s.app.login_as(Role::Professor).await;
    let other_campus = s.app.seed_campus(&other_owner).await;
    let mut ids = Vec::new();
    for campus in [s.campus, other_campus] {
        let id: i64 = sqlx::query_scalar(
            "INSERT INTO classes_classes (campus_id, title, starts_at, duration_min, \
             meeting_source, join_url, created_by) \
             VALUES (?, 'Clase', '2026-11-20 12:00:00', 60, 'manual', 'https://example.test', ?) \
             RETURNING id",
        )
        .bind(campus)
        .bind(s.professor.id)
        .fetch_one(&s.app.db)
        .await
        .unwrap();
        ids.push(id);
    }
    let uri = format!("/api/campuses/{}/presentations", s.campus);
    let post = |class_id: i64| {
        s.app.post_multipart(
            &uri,
            Some(&s.professor.cookie),
            vec![
                Part::text("class_id", &class_id.to_string()),
                Part::file("file", "a.pdf", "application/pdf", make_pdf(1, 0)),
            ],
        )
    };
    for bad in [ids[1], 99_999] {
        let (status, body) = post(bad).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{bad}: {body}");
    }
    let (status, body) = post(ids[0]).await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    assert_eq!(body["class_id"], ids[0]);
}

#[tokio::test]
async fn a_file_over_2_mb_uploads() {
    let s = setup().await;
    let pdf = make_pdf(2, 3 * 1024 * 1024);
    assert!(pdf.len() > 2 * 1024 * 1024);
    let (status, body) = upload(&s, &s.professor.cookie, "grande.pdf", pdf).await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    assert_eq!(body["page_count"], 2);
}

#[tokio::test]
async fn a_pptx_is_a_422_that_asks_for_a_pdf() {
    let s = setup().await;
    let (status, body) = upload(
        &s,
        &s.professor.cookie,
        "clase.pptx",
        b"PK\x03\x04".to_vec(),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(body["error"].as_str().unwrap().contains("PDF"), "{body}");

    let (status, _) = upload(&s, &s.professor.cookie, "falso.pdf", b"not a pdf".to_vec()).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
}

#[tokio::test]
async fn goto_clamps_and_increments_seq() {
    let s = setup().await;
    let live = go_live(&s, 5).await;
    assert_eq!(live["current_page"], 1);
    assert_eq!(live["seq"], 0);
    assert_eq!(live["page_count"], 5);

    let (status, after) = goto(&s, &s.professor.cookie, &live, 3).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        (after["current_page"].clone(), after["seq"].clone()),
        (json!(3), json!(1))
    );

    let (_, after) = goto(&s, &s.professor.cookie, &live, 99).await;
    assert_eq!(
        (after["current_page"].clone(), after["seq"].clone()),
        (json!(5), json!(2))
    );

    let (_, after) = goto(&s, &s.professor.cookie, &live, -4).await;
    assert_eq!(
        (after["current_page"].clone(), after["seq"].clone()),
        (json!(1), json!(3))
    );

    // Followers can read the state.
    let (status, state) = s
        .app
        .get(
            &format!("/api/live/{}/state", live["id"]),
            Some(&s.student.cookie),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(state["seq"], 3);

    // An ended session no longer moves.
    let (status, ended) = s
        .app
        .post_json(
            &format!("/api/live/{}/end", live["id"]),
            Some(&s.professor.cookie),
            json!({}),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(ended["status"], "ended");
    let (status, _) = goto(&s, &s.professor.cookie, &live, 2).await;
    assert_eq!(status, StatusCode::CONFLICT);
}

#[tokio::test]
async fn only_teachers_upload_present_and_move() {
    let s = setup().await;
    let (status, _) = upload(&s, &s.student.cookie, "a.pdf", make_pdf(1, 0)).await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    let live = go_live(&s, 3).await;
    let (status, _) = goto(&s, &s.student.cookie, &live, 2).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = s
        .app
        .post_json(
            &format!("/api/live/{}/end", live["id"]),
            Some(&s.student.cookie),
            json!({}),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = s
        .app
        .post_json(
            &format!("/api/presentations/{}/live", live["presentation_id"]),
            Some(&s.student.cookie),
            json!({}),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // A guest teacher can.
    let guest = s.app.seed_guest(s.campus).await;
    let (status, _) = goto(&s, &guest.cookie, &live, 2).await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn a_non_member_cannot_read_file_state_or_stream() {
    let s = setup().await;
    let live = go_live(&s, 2).await;
    let outsider = s.app.login_as(Role::Student).await;

    for uri in [
        format!("/api/presentations/{}/file", live["presentation_id"]),
        format!("/api/live/{}/state", live["id"]),
        format!("/api/live/{}/stream", live["id"]),
        format!("/api/campuses/{}/live", s.campus),
        format!("/api/campuses/{}/presentations", s.campus),
    ] {
        let response = s.app.get_response(&uri, Some(&outsider.cookie)).await;
        assert_eq!(response.status, StatusCode::FORBIDDEN, "{uri}");
        let anonymous = s.app.get_response(&uri, None).await;
        assert_eq!(anonymous.status, StatusCode::UNAUTHORIZED, "{uri}");
    }
}

/// Reads SSE frames until one carries a state with at least `min_seq`.
async fn next_state(body: &mut Body, buffer: &mut String) -> Value {
    loop {
        if let Some(end) = buffer.find("\n\n") {
            let block: String = buffer.drain(..end + 2).collect();
            let data: String = block
                .lines()
                .filter_map(|line| line.strip_prefix("data:"))
                .map(str::trim)
                .collect();
            if !data.is_empty() {
                return serde_json::from_str(&data).unwrap();
            }
            continue;
        }
        let frame = tokio::time::timeout(Duration::from_secs(5), body.frame())
            .await
            .expect("stream frame in time")
            .expect("stream open")
            .expect("frame ok");
        if let Ok(data) = frame.into_data() {
            buffer.push_str(&String::from_utf8_lossy(&data));
        }
    }
}

#[tokio::test]
async fn a_new_stream_gets_the_current_state_first_then_changes() {
    let s = setup().await;
    let live = go_live(&s, 4).await;
    goto(&s, &s.professor.cookie, &live, 2).await;

    let request = common::request(
        Method::GET,
        &format!("/api/live/{}/stream", live["id"]),
        Some(&s.student.cookie),
    )
    .body(Body::empty())
    .unwrap();
    let response = s.app.router.clone().oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(response
        .headers()
        .get("content-type")
        .unwrap()
        .to_str()
        .unwrap()
        .starts_with("text/event-stream"));
    let mut body = Body::new(response.into_body());
    let mut buffer = String::new();

    let first = next_state(&mut body, &mut buffer).await;
    assert_eq!(
        (first["current_page"].clone(), first["seq"].clone()),
        (json!(2), json!(1))
    );

    goto(&s, &s.professor.cookie, &live, 4).await;
    let second = next_state(&mut body, &mut buffer).await;
    assert_eq!(
        (second["current_page"].clone(), second["seq"].clone()),
        (json!(4), json!(2))
    );
}

#[tokio::test]
async fn a_suspended_student_stops_receiving_the_stream() {
    let s = setup().await;
    let live = go_live(&s, 4).await;
    let request = common::request(
        Method::GET,
        &format!("/api/live/{}/stream", live["id"]),
        Some(&s.student.cookie),
    )
    .body(Body::empty())
    .unwrap();
    let response = s.app.router.clone().oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let mut body = Body::new(response.into_body());
    let mut buffer = String::new();
    next_state(&mut body, &mut buffer).await;

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
    goto(&s, &s.professor.cookie, &live, 3).await;

    // The stream must end without delivering the change.
    let ended = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            match body.frame().await {
                None => return,
                Some(Ok(frame)) => {
                    if let Ok(data) = frame.into_data() {
                        let text = String::from_utf8_lossy(&data).to_string();
                        assert!(!text.contains("\"current_page\":3"), "leaked: {text}");
                    }
                }
                Some(Err(_)) => return,
            }
        }
    })
    .await;
    assert!(
        ended.is_ok(),
        "the stream stayed open for a suspended student"
    );
}

#[tokio::test]
async fn a_second_live_session_ends_the_first() {
    let s = setup().await;
    let first = go_live(&s, 2).await;
    let second = go_live(&s, 3).await;
    assert_ne!(first["id"], second["id"]);

    let (_, old) = s
        .app
        .get(
            &format!("/api/live/{}/state", first["id"]),
            Some(&s.student.cookie),
        )
        .await;
    assert_eq!(old["status"], "ended");

    let (status, current) = s
        .app
        .get(
            &format!("/api/campuses/{}/live", s.campus),
            Some(&s.student.cookie),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(current["id"], second["id"]);
    assert_eq!(current["status"], "live");

    // Nothing live: the endpoint answers null.
    s.app
        .post_json(
            &format!("/api/live/{}/end", second["id"]),
            Some(&s.professor.cookie),
            json!({}),
        )
        .await;
    let (status, none) = s
        .app
        .get(
            &format!("/api/campuses/{}/live", s.campus),
            Some(&s.student.cookie),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert!(none.is_null());
}
