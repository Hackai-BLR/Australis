mod common;

use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

use async_trait::async_trait;
use australis_core::{
    zoom::{Invitee, Meeting, MeetingRequest, Participant, Recording, ZoomProvider},
    ProviderError, Role,
};
use axum::http::StatusCode;
use common::{TestApp, TestUser};
use serde_json::{json, Value};

const PAST: &str = "2020-01-01 10:00:00";
const FUTURE: &str = "2099-01-01 10:00:00";

async fn create_class(app: &TestApp, prof: &TestUser, campus: i64, starts_at: &str) -> i64 {
    let (status, body) = app
        .post_json(
            &format!("/api/campuses/{campus}/classes"),
            Some(&prof.cookie),
            json!({ "title": "Clase", "starts_at": starts_at, "duration_min": 60 }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    body["id"].as_i64().unwrap()
}

async fn recording(app: &TestApp, user: &TestUser, id: i64) -> Value {
    let (status, body) = app
        .get(&format!("/api/classes/{id}/recording"), Some(&user.cookie))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body
}

#[tokio::test]
async fn nothing_is_published_before_the_end_unless_the_class_was_ended() {
    let app = TestApp::new().await;
    let prof = app.login_as(Role::Professor).await;
    let campus = app.seed_campus(&prof).await;
    let id = create_class(&app, &prof, campus, FUTURE).await;

    let (_, class) = app
        .get(&format!("/api/classes/{id}"), Some(&prof.cookie))
        .await;
    assert_eq!(class["recording_status"], "none");
    let (status, synced) = app
        .post_json(
            &format!("/api/classes/{id}/recording/sync"),
            Some(&prof.cookie),
            json!({}),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{synced}");
    assert_eq!(synced["status"], "none");
    assert!(synced["play_url"].is_null());

    let (status, ended) = app
        .post_json(
            &format!("/api/classes/{id}/end"),
            Some(&prof.cookie),
            json!({}),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{ended}");
    assert_eq!(ended["recording_status"], "transcript_ready");
    let rec = recording(&app, &prof, id).await;
    assert_eq!(rec["status"], "transcript_ready");
    assert_eq!(rec["simulated"], true);
    assert!(rec["play_url"].as_str().unwrap().contains("/simulado/"));
    assert!(rec["delay_seconds"].is_i64());
}

#[tokio::test]
async fn reading_a_finished_class_publishes_the_recording() {
    let app = TestApp::new().await;
    let prof = app.login_as(Role::Professor).await;
    let campus = app.seed_campus(&prof).await;
    let student = app.seed_student(campus).await;
    let id = create_class(&app, &prof, campus, PAST).await;

    // The campus list advances it too.
    let (_, list) = app
        .get(
            &format!("/api/campuses/{campus}/classes"),
            Some(&student.cookie),
        )
        .await;
    assert_eq!(list[0]["recording_status"], "transcript_ready");
    let rec = recording(&app, &student, id).await;
    assert!(rec["transcript_text"]
        .as_str()
        .unwrap()
        .contains("Buenas tardes"));
}

#[tokio::test]
async fn sync_twice_yields_one_recording() {
    let app = TestApp::new().await;
    let prof = app.login_as(Role::Professor).await;
    let campus = app.seed_campus(&prof).await;
    let id = create_class(&app, &prof, campus, PAST).await;
    let uri = format!("/api/classes/{id}/recording/sync");
    let (a, b) = tokio::join!(
        app.post_json(&uri, Some(&prof.cookie), json!({})),
        app.post_json(&uri, Some(&prof.cookie), json!({})),
    );
    assert_eq!(a.0, StatusCode::OK);
    assert_eq!(b.0, StatusCode::OK);
    app.post_json(&uri, Some(&prof.cookie), json!({})).await;
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM classes_recordings")
        .fetch_one(&app.db)
        .await
        .unwrap();
    assert_eq!(count, 1);
}

/// Publishes the recording first without a transcript, then with it; `None` before that.
struct Staged {
    calls: AtomicUsize,
}

#[async_trait]
impl ZoomProvider for Staged {
    fn name(&self) -> &'static str {
        "staged"
    }
    fn is_placeholder(&self) -> bool {
        true
    }
    async fn create_meeting(&self, _r: &MeetingRequest) -> Result<Meeting, ProviderError> {
        Ok(Meeting {
            meeting_id: "42".into(),
            join_url: "http://x.test/j".into(),
            start_url: "http://x.test/s".into(),
        })
    }
    async fn fetch_recording(&self, _id: &str) -> Result<Option<Recording>, ProviderError> {
        let n = self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(match n {
            0 => None,
            1 => Some(Recording {
                play_url: "http://x.test/r".into(),
                duration_seconds: 10,
                transcript_vtt: None,
            }),
            2 => Some(Recording {
                play_url: "http://x.test/r".into(),
                duration_seconds: 10,
                transcript_vtt: Some("WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\nHola\n".into()),
            }),
            // After that the provider "forgets" the recording: status must not go back.
            _ => None,
        })
    }
    async fn fetch_participants(
        &self,
        _id: &str,
        _invitees: &[Invitee],
    ) -> Result<Vec<Participant>, ProviderError> {
        Ok(Vec::new())
    }
}

#[tokio::test]
async fn status_moves_in_order_and_never_backwards() {
    let app = TestApp::with(|s| {
        s.zoom = Arc::new(Staged {
            calls: AtomicUsize::new(0),
        })
    })
    .await;
    let prof = app.login_as(Role::Professor).await;
    let campus = app.seed_campus(&prof).await;
    let id = create_class(&app, &prof, campus, PAST).await;
    let uri = format!("/api/classes/{id}/recording/sync");
    let mut seen = vec![];
    for _ in 0..4 {
        let (_, body) = app.post_json(&uri, Some(&prof.cookie), json!({})).await;
        seen.push(body["status"].as_str().unwrap().to_string());
    }
    assert_eq!(
        seen,
        [
            "pending",
            "available",
            "transcript_ready",
            "transcript_ready"
        ]
    );
    let rec = recording(&app, &prof, id).await;
    assert_eq!(rec["transcript_text"], "Hola\n");
}

#[tokio::test]
async fn transcript_downloads_as_txt_and_vtt() {
    let app = TestApp::new().await;
    let prof = app.login_as(Role::Professor).await;
    let campus = app.seed_campus(&prof).await;
    let id = create_class(&app, &prof, campus, PAST).await;

    let txt = app
        .get_response(
            &format!("/api/classes/{id}/transcript?format=txt"),
            Some(&prof.cookie),
        )
        .await;
    assert_eq!(txt.status, StatusCode::OK);
    assert!(txt
        .header("content-type")
        .unwrap()
        .starts_with("text/plain"));
    assert!(txt
        .header("content-disposition")
        .unwrap()
        .contains(&format!("transcripcion-clase-{id}.txt")));
    assert!(!txt.text().contains("-->"));
    assert!(txt.text().contains("Buenas tardes"));

    let vtt = app
        .get_response(
            &format!("/api/classes/{id}/transcript?format=vtt"),
            Some(&prof.cookie),
        )
        .await;
    assert_eq!(vtt.status, StatusCode::OK);
    assert!(vtt.header("content-type").unwrap().starts_with("text/vtt"));
    assert!(vtt.text().starts_with("WEBVTT"));
    assert!(vtt.text().contains("-->"));

    let bad = app
        .get_response(
            &format!("/api/classes/{id}/transcript?format=pdf"),
            Some(&prof.cookie),
        )
        .await;
    assert_eq!(bad.status, StatusCode::UNPROCESSABLE_ENTITY);
}

#[tokio::test]
async fn transcript_is_not_found_before_it_exists() {
    let app = TestApp::new().await;
    let prof = app.login_as(Role::Professor).await;
    let campus = app.seed_campus(&prof).await;
    let id = create_class(&app, &prof, campus, FUTURE).await;
    let res = app
        .get_response(&format!("/api/classes/{id}/transcript"), Some(&prof.cookie))
        .await;
    assert_eq!(res.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn only_members_of_the_campus_can_read_the_recording() {
    let app = TestApp::new().await;
    let prof = app.login_as(Role::Professor).await;
    let campus = app.seed_campus(&prof).await;
    let other_campus = app.seed_campus(&prof).await;
    let outsider = app.seed_student(other_campus).await;
    let id = create_class(&app, &prof, campus, PAST).await;

    for uri in [
        format!("/api/classes/{id}/recording"),
        format!("/api/classes/{id}/transcript"),
    ] {
        let (status, _) = app.get(&uri, Some(&outsider.cookie)).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{uri}");
    }
    let (status, _) = app
        .post_json(
            &format!("/api/classes/{id}/recording/sync"),
            Some(&outsider.cookie),
            json!({}),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = app
        .post_json(
            &format!("/api/classes/{id}/end"),
            Some(&outsider.cookie),
            json!({}),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = app.get(&format!("/api/classes/{id}/recording"), None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn a_student_cannot_end_a_class() {
    let app = TestApp::new().await;
    let prof = app.login_as(Role::Professor).await;
    let campus = app.seed_campus(&prof).await;
    let student = app.seed_student(campus).await;
    let id = create_class(&app, &prof, campus, FUTURE).await;
    let (status, _) = app
        .post_json(
            &format!("/api/classes/{id}/end"),
            Some(&student.cookie),
            json!({}),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}
