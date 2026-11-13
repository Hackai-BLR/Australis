//! AI class summary: a draft built from the class transcript through `ai::run` (own daily
//! quota `ai.summary.daily_quota` and usage log). The professor edits and approves it; students
//! only ever see an approved summary. The AI cannot approve, and it touches no grade,
//! attendance or other closed record: its output lands in one text column.

use australis_core::{
    ai::{self, AiRequest, FEATURE_SUMMARY},
    require_campus, Access, AppError, AppResult, AppState, CurrentUser,
};
use axum::{
    extract::{Path, State},
    http::HeaderMap,
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use sqlx::SqliteConnection;

const MAX_BODY_CHARS: usize = 20_000;
/// Longest transcript sent to the model; longer ones are cut at a character boundary.
const MAX_TRANSCRIPT_CHARS: usize = 60_000;

const SYSTEM: &str = "Sos un asistente de una cátedra de posgrado. Con la transcripción de una \
    clase escribí, en español rioplatense, un borrador con dos secciones: \"Puntos clave\" y \
    \"Tareas para la próxima clase\". Usá solo lo que dice la transcripción. No menciones notas, \
    asistencia ni datos personales de estudiantes.";
const INSTRUCTION: &str = "Resumí la clase: puntos clave y tareas para la próxima clase.";

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/classes/{cid}/summary", get(get_summary).put(edit_summary))
        .route("/classes/{cid}/summary/generate", post(generate_summary))
        .route("/classes/{cid}/summary/approve", post(approve_summary))
}

#[derive(sqlx::FromRow)]
struct SummaryRow {
    body: String,
    status: String,
    simulated: bool,
    generated_at: String,
    edited_at: Option<String>,
    approved_at: Option<String>,
}

#[derive(Serialize)]
struct QuotaView {
    limit: i64,
    used: i64,
    remaining: i64,
}

#[derive(Serialize)]
struct SummaryView {
    /// `none`, `draft` or `approved`. A student only ever sees `none` or `approved`.
    status: String,
    body: Option<String>,
    /// True when the text came from a placeholder AI: the screens show the "Simulado" badge.
    simulated: bool,
    generated_at: Option<String>,
    edited_at: Option<String>,
    approved_at: Option<String>,
    can_teach: bool,
    /// Whether the class has a transcript to summarize (teachers only).
    transcript_ready: bool,
    /// Today's quota of the caller (teachers only).
    quota: Option<QuotaView>,
}

async fn class_campus(conn: &mut SqliteConnection, class_id: i64) -> AppResult<i64> {
    sqlx::query_scalar("SELECT campus_id FROM classes_classes WHERE id = ?")
        .bind(class_id)
        .fetch_optional(conn)
        .await?
        .ok_or(AppError::NotFound)
}

async fn view(
    conn: &mut SqliteConnection,
    user: &CurrentUser,
    class_id: i64,
    can_teach: bool,
) -> AppResult<SummaryView> {
    let row: Option<SummaryRow> = sqlx::query_as(
        "SELECT body, status, simulated, generated_at, edited_at, approved_at
         FROM classes_summaries WHERE class_id = ?",
    )
    .bind(class_id)
    .fetch_optional(&mut *conn)
    .await?;
    let visible = row.filter(|r| can_teach || r.status == "approved");
    let (transcript_ready, quota) = if can_teach {
        let ready: bool = sqlx::query_scalar(
            "SELECT EXISTS (SELECT 1 FROM classes_recordings
                            WHERE class_id = ? AND COALESCE(transcript_text, '') <> '')",
        )
        .bind(class_id)
        .fetch_one(&mut *conn)
        .await?;
        let q = ai::quota_status(conn, user.id, FEATURE_SUMMARY).await?;
        (
            ready,
            Some(QuotaView {
                limit: q.limit,
                used: q.used,
                remaining: q.remaining,
            }),
        )
    } else {
        (false, None)
    };
    Ok(match visible {
        Some(r) => SummaryView {
            status: r.status,
            body: Some(r.body),
            simulated: r.simulated,
            generated_at: Some(r.generated_at),
            edited_at: r.edited_at,
            approved_at: r.approved_at,
            can_teach,
            transcript_ready,
            quota,
        },
        None => SummaryView {
            status: "none".into(),
            body: None,
            simulated: false,
            generated_at: None,
            edited_at: None,
            approved_at: None,
            can_teach,
            transcript_ready,
            quota,
        },
    })
}

async fn get_summary(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(class_id): Path<i64>,
) -> AppResult<Json<SummaryView>> {
    let mut conn = state.db.acquire().await?;
    let campus_id = class_campus(&mut conn, class_id).await?;
    let access = require_campus(&mut conn, &user, campus_id, Access::View).await?;
    let can_teach = access.can(Access::Teach);
    Ok(Json(view(&mut conn, &user, class_id, can_teach).await?))
}

fn truncate_chars(text: &str, max: usize) -> &str {
    match text.char_indices().nth(max) {
        Some((end, _)) => &text[..end],
        None => text,
    }
}

#[derive(Deserialize, Default)]
struct GenerateBody {
    /// The professor confirmed replacing a draft she edited by hand.
    #[serde(default)]
    overwrite: bool,
}

/// Generating never silently discards hand edits: an edited draft needs `overwrite`, and an
/// edit saved while the AI call was running makes the write fail with a conflict.
async fn generate_summary(
    State(state): State<AppState>,
    user: CurrentUser,
    headers: HeaderMap,
    Path(class_id): Path<i64>,
    Json(input): Json<GenerateBody>,
) -> AppResult<Json<SummaryView>> {
    let (campus_id, transcript, edited_before) = {
        let mut conn = state.db.acquire().await?;
        let campus_id = class_campus(&mut conn, class_id).await?;
        require_campus(&mut conn, &user, campus_id, Access::Teach).await?;
        let current: Option<(String, Option<String>)> =
            sqlx::query_as("SELECT status, edited_at FROM classes_summaries WHERE class_id = ?")
                .bind(class_id)
                .fetch_optional(&mut *conn)
                .await?;
        let edited_before = current.as_ref().and_then(|(_, edited)| edited.clone());
        if current.as_ref().map(|(status, _)| status.as_str()) == Some("approved") {
            return Err(AppError::Conflict(
                "the summary is already approved; edit it to turn it back into a draft".into(),
            ));
        }
        if edited_before.is_some() && !input.overwrite {
            return Err(AppError::Conflict(
                "the draft has manual edits; confirm to replace them".into(),
            ));
        }
        let transcript: Option<String> =
            sqlx::query_scalar("SELECT transcript_text FROM classes_recordings WHERE class_id = ?")
                .bind(class_id)
                .fetch_optional(&mut *conn)
                .await?
                .flatten();
        let transcript = transcript.filter(|t| !t.trim().is_empty()).ok_or_else(|| {
            AppError::Unprocessable("the class has no transcript to summarize yet".into())
        })?;
        (campus_id, transcript, edited_before)
    };

    let identity = headers
        .get(australis_core::auth::IDENTITY_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let request = AiRequest {
        feature: FEATURE_SUMMARY.into(),
        system: SYSTEM.into(),
        context: truncate_chars(&transcript, MAX_TRANSCRIPT_CHARS).to_string(),
        instruction: INSTRUCTION.into(),
        identity,
        ..AiRequest::default()
    };
    let outcome = ai::run(&state, user.id, Some(campus_id), &request).await?;
    let body = outcome.reply.text.trim().to_string();
    if body.is_empty() {
        return Err(AppError::Unprocessable(
            "the AI returned an empty summary".into(),
        ));
    }

    let mut tx = australis_core::begin_write(&state.db).await?;
    let current: Option<(String, Option<String>)> =
        sqlx::query_as("SELECT status, edited_at FROM classes_summaries WHERE class_id = ?")
            .bind(class_id)
            .fetch_optional(&mut *tx)
            .await?;
    if let Some((status, edited_now)) = current {
        if status == "approved" {
            return Err(AppError::Conflict(
                "the summary was approved while it was being generated".into(),
            ));
        }
        if edited_now != edited_before {
            return Err(AppError::Conflict(
                "the draft was edited while it was being generated".into(),
            ));
        }
    }
    sqlx::query(
        "INSERT INTO classes_summaries
            (class_id, body, status, simulated, model, usage_id, generated_by)
         VALUES (?1, ?2, 'draft', ?3, ?4, ?5, ?6)
         ON CONFLICT (class_id) DO UPDATE SET
            body = excluded.body, status = 'draft', simulated = excluded.simulated,
            model = excluded.model, usage_id = excluded.usage_id,
            generated_by = excluded.generated_by, generated_at = datetime('now'),
            edited_by = NULL, edited_at = NULL, approved_by = NULL, approved_at = NULL",
    )
    .bind(class_id)
    .bind(&body)
    .bind(outcome.simulated)
    .bind(&outcome.reply.model)
    .bind(outcome.usage_id)
    .bind(user.id)
    .execute(&mut *tx)
    .await?;
    let out = view(&mut tx, &user, class_id, true).await?;
    tx.commit().await?;
    Ok(Json(out))
}

#[derive(Deserialize)]
struct EditBody {
    body: String,
}

/// The professor edits the text. An approved summary goes back to draft, so students never
/// see text that nobody approved.
async fn edit_summary(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(class_id): Path<i64>,
    Json(input): Json<EditBody>,
) -> AppResult<Json<SummaryView>> {
    let body = input.body.trim().to_string();
    if body.is_empty() {
        return Err(AppError::Unprocessable(
            "the summary cannot be empty".into(),
        ));
    }
    if body.chars().count() > MAX_BODY_CHARS {
        return Err(AppError::Unprocessable("the summary is too long".into()));
    }
    let mut tx = australis_core::begin_write(&state.db).await?;
    let campus_id = class_campus(&mut tx, class_id).await?;
    require_campus(&mut tx, &user, campus_id, Access::Teach).await?;
    let result = sqlx::query(
        "UPDATE classes_summaries SET body = ?, status = 'draft', edited_by = ?,
            edited_at = datetime('now'), approved_by = NULL, approved_at = NULL
         WHERE class_id = ?",
    )
    .bind(&body)
    .bind(user.id)
    .bind(class_id)
    .execute(&mut *tx)
    .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    let out = view(&mut tx, &user, class_id, true).await?;
    tx.commit().await?;
    Ok(Json(out))
}

async fn approve_summary(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(class_id): Path<i64>,
) -> AppResult<Json<SummaryView>> {
    let mut tx = australis_core::begin_write(&state.db).await?;
    let campus_id = class_campus(&mut tx, class_id).await?;
    require_campus(&mut tx, &user, campus_id, Access::Teach).await?;
    let result = sqlx::query(
        "UPDATE classes_summaries SET status = 'approved', approved_by = ?,
            approved_at = datetime('now')
         WHERE class_id = ? AND status = 'draft'",
    )
    .bind(user.id)
    .bind(class_id)
    .execute(&mut *tx)
    .await?;
    if result.rows_affected() == 0 {
        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS (SELECT 1 FROM classes_summaries WHERE class_id = ?)",
        )
        .bind(class_id)
        .fetch_one(&mut *tx)
        .await?;
        return Err(if exists {
            AppError::Conflict("the summary is already approved".into())
        } else {
            AppError::NotFound
        });
    }
    let out = view(&mut tx, &user, class_id, true).await?;
    tx.commit().await?;
    Ok(Json(out))
}
