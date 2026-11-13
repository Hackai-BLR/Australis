//! Automatic recording and Zoom transcript for a class.
//!
//! There is no background task: whenever a class is read, or sync is called, and the class is
//! over (its scheduled end has passed or the teacher ended it), the module asks the Zoom
//! provider for the recording and moves the status forward. The status only moves forward:
//! `none -> pending -> available -> transcript_ready`. Video files are never stored.

use australis_core::{require_campus, Access, AppError, AppResult, AppState, CurrentUser};
use axum::{
    extract::{Path, Query, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};

mod vtt;
pub use vtt::vtt_to_text;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/classes/{cid}/recording", get(get_recording))
        .route("/classes/{cid}/recording/sync", post(sync_recording))
        .route("/classes/{cid}/transcript", get(get_transcript))
        .route("/classes/{cid}/end", post(end_class))
}

fn rank(status: &str) -> u8 {
    match status {
        "pending" => 1,
        "available" => 2,
        "transcript_ready" => 3,
        _ => 0,
    }
}

#[derive(sqlx::FromRow)]
struct Progress {
    status: String,
    meeting_id: Option<String>,
    over: bool,
}

/// Advances the recording status of one class as far as the provider allows. Idempotent and
/// safe under concurrent calls: the provider is asked outside any transaction, and the write
/// re-reads the status inside one so it can never move backwards or insert twice.
pub async fn sync_class(state: &AppState, class_id: i64) -> AppResult<()> {
    let progress: Option<Progress> = {
        let mut conn = state.db.acquire().await?;
        sqlx::query_as(
            "SELECT recording_status AS status, zoom_meeting_id AS meeting_id,
                    (ended_at IS NOT NULL
                     OR datetime(starts_at, '+' || duration_min || ' minutes') <= datetime('now'))
                        AS over
             FROM classes_classes WHERE id = ?",
        )
        .bind(class_id)
        .fetch_optional(&mut *conn)
        .await?
    };
    let Some(progress) = progress else {
        return Err(AppError::NotFound);
    };
    // A pasted (manual) meeting has no provider meeting id: nothing to fetch.
    let Some(meeting_id) = progress.meeting_id.filter(|_| progress.over) else {
        return Ok(());
    };
    if progress.status == "transcript_ready" {
        return Ok(());
    }

    let recording = state.zoom.fetch_recording(&meeting_id).await?;

    let mut tx = australis_core::begin_write(&state.db).await?;
    let current: String =
        sqlx::query_scalar("SELECT recording_status FROM classes_classes WHERE id = ?")
            .bind(class_id)
            .fetch_one(&mut *tx)
            .await?;
    let mut next = current.clone();
    if rank(&next) < rank("pending") {
        next = "pending".into();
    }
    if let Some(rec) = recording {
        let text = rec.transcript_vtt.as_deref().map(vtt_to_text);
        sqlx::query(
            "INSERT INTO classes_recordings
                (class_id, play_url, duration_s, transcript_vtt, transcript_text)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT (class_id) DO UPDATE SET
                transcript_vtt = COALESCE(classes_recordings.transcript_vtt,
                                          excluded.transcript_vtt),
                transcript_text = COALESCE(classes_recordings.transcript_text,
                                           excluded.transcript_text)",
        )
        .bind(class_id)
        .bind(&rec.play_url)
        .bind(rec.duration_seconds)
        .bind(&rec.transcript_vtt)
        .bind(&text)
        .execute(&mut *tx)
        .await?;
        let has_transcript: bool = sqlx::query_scalar(
            "SELECT transcript_vtt IS NOT NULL FROM classes_recordings WHERE class_id = ?",
        )
        .bind(class_id)
        .fetch_one(&mut *tx)
        .await?;
        let reached = if has_transcript {
            "transcript_ready"
        } else {
            "available"
        };
        if rank(reached) > rank(&next) {
            next = reached.into();
        }
    }
    if next != current {
        sqlx::query("UPDATE classes_classes SET recording_status = ? WHERE id = ?")
            .bind(&next)
            .bind(class_id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(())
}

/// Sync used by reads: a provider failure must not break the page, so it is only logged.
pub async fn refresh_class(state: &AppState, class_id: i64) {
    if let Err(err) = sync_class(state, class_id).await {
        tracing::warn!(class_id, %err, "recording sync failed");
    }
}

/// Refreshes every class of a campus that is over and not finished yet.
pub async fn refresh_campus(state: &AppState, campus_id: i64) {
    let ids: Result<Vec<i64>, sqlx::Error> = async {
        let mut conn = state.db.acquire().await?;
        sqlx::query_scalar(
            "SELECT id FROM classes_classes
             WHERE campus_id = ? AND recording_status <> 'transcript_ready'
               AND zoom_meeting_id IS NOT NULL
               AND (ended_at IS NOT NULL
                    OR datetime(starts_at, '+' || duration_min || ' minutes') <= datetime('now'))",
        )
        .bind(campus_id)
        .fetch_all(&mut *conn)
        .await
    }
    .await;
    match ids {
        Ok(ids) => {
            for id in ids {
                refresh_class(state, id).await;
            }
        }
        Err(err) => tracing::warn!(campus_id, %err, "listing classes to sync failed"),
    }
}

async fn class_campus(state: &AppState, class_id: i64) -> AppResult<i64> {
    let mut conn = state.db.acquire().await?;
    sqlx::query_scalar("SELECT campus_id FROM classes_classes WHERE id = ?")
        .bind(class_id)
        .fetch_optional(&mut *conn)
        .await?
        .ok_or(AppError::NotFound)
}

async fn require_member(state: &AppState, user: &CurrentUser, class_id: i64) -> AppResult<()> {
    let campus_id = class_campus(state, class_id).await?;
    let mut conn = state.db.acquire().await?;
    require_campus(&mut conn, user, campus_id, Access::View).await?;
    Ok(())
}

#[derive(sqlx::FromRow)]
struct RecordingRow {
    status: String,
    play_url: Option<String>,
    duration_s: Option<i64>,
    transcript_text: Option<String>,
    published_at: Option<String>,
    delay_seconds: Option<i64>,
}

#[derive(Serialize)]
struct RecordingView {
    /// `none`, `pending`, `available` or `transcript_ready`.
    status: String,
    /// True when the provider is a placeholder: the screens show the "Simulado" badge.
    simulated: bool,
    play_url: Option<String>,
    duration_s: Option<i64>,
    transcript_text: Option<String>,
    /// UTC, `YYYY-MM-DD HH:MM:SS`.
    published_at: Option<String>,
    /// Seconds from the end of the class to the publication of the recording.
    delay_seconds: Option<i64>,
}

async fn recording_view(state: &AppState, class_id: i64) -> AppResult<RecordingView> {
    let mut conn = state.db.acquire().await?;
    let row: RecordingRow = sqlx::query_as(
        "SELECT cl.recording_status AS status,
                r.play_url, r.duration_s, r.transcript_text, r.published_at,
                MAX(0, CAST(strftime('%s', r.published_at) AS INTEGER)
                     - CAST(strftime('%s', COALESCE(cl.ended_at,
                            datetime(cl.starts_at, '+' || cl.duration_min || ' minutes')))
                        AS INTEGER)) AS delay_seconds
         FROM classes_classes cl
         LEFT JOIN classes_recordings r ON r.class_id = cl.id
         WHERE cl.id = ?",
    )
    .bind(class_id)
    .fetch_optional(&mut *conn)
    .await?
    .ok_or(AppError::NotFound)?;
    Ok(RecordingView {
        status: row.status,
        simulated: state.zoom.is_placeholder(),
        play_url: row.play_url,
        duration_s: row.duration_s,
        transcript_text: row.transcript_text,
        published_at: row.published_at,
        delay_seconds: row.delay_seconds,
    })
}

async fn get_recording(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(class_id): Path<i64>,
) -> AppResult<Json<RecordingView>> {
    require_member(&state, &user, class_id).await?;
    refresh_class(&state, class_id).await;
    Ok(Json(recording_view(&state, class_id).await?))
}

async fn sync_recording(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(class_id): Path<i64>,
) -> AppResult<Json<RecordingView>> {
    let campus_id = class_campus(&state, class_id).await?;
    let mut conn = state.db.acquire().await?;
    require_campus(&mut conn, &user, campus_id, Access::Teach).await?;
    drop(conn);
    sync_class(&state, class_id).await?;
    Ok(Json(recording_view(&state, class_id).await?))
}

#[derive(Deserialize)]
struct TranscriptQuery {
    format: Option<String>,
}

async fn get_transcript(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(class_id): Path<i64>,
    Query(query): Query<TranscriptQuery>,
) -> AppResult<Response> {
    let (column, ext, content_type) = match query.format.as_deref().unwrap_or("txt") {
        "txt" => ("transcript_text", "txt", "text/plain; charset=utf-8"),
        "vtt" => ("transcript_vtt", "vtt", "text/vtt; charset=utf-8"),
        _ => return Err(AppError::Unprocessable("format must be txt or vtt".into())),
    };
    require_member(&state, &user, class_id).await?;
    refresh_class(&state, class_id).await;
    let mut conn = state.db.acquire().await?;
    let body: Option<String> = sqlx::query_scalar(&format!(
        "SELECT {column} FROM classes_recordings WHERE class_id = ?"
    ))
    .bind(class_id)
    .fetch_optional(&mut *conn)
    .await?
    .flatten();
    let body = body.ok_or(AppError::NotFound)?;
    Ok((
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, content_type.to_string()),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"transcripcion-clase-{class_id}.{ext}\""),
            ),
        ],
        body,
    )
        .into_response())
}

/// The teacher ends the class now; the recording is requested right away.
async fn end_class(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(class_id): Path<i64>,
) -> AppResult<Json<crate::ClassView>> {
    let campus_id = class_campus(&state, class_id).await?;
    {
        let mut conn = state.db.acquire().await?;
        require_campus(&mut conn, &user, campus_id, Access::Teach).await?;
    }
    let mut tx = australis_core::begin_write(&state.db).await?;
    sqlx::query(
        "UPDATE classes_classes SET ended_at = COALESCE(ended_at, datetime('now')) WHERE id = ?",
    )
    .bind(class_id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    refresh_class(&state, class_id).await;
    let mut conn = state.db.acquire().await?;
    let row = crate::find_class(&mut conn, class_id).await?;
    Ok(Json(row.into_view(true)))
}
