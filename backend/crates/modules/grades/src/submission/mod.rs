//! F12: a campus's grades go draft -> sent -> checked. A teacher sends them; the secretary
//! marks them checked or returns them to draft with a note. Every change is audited in the
//! same transaction. Closing the grades is F20.

use australis_core::{
    access::{require_campus, require_role, Access},
    audit::{self, AuditEntry},
    begin_write, directory, AppError, AppResult, AppState, CurrentUser, Role,
};
use axum::{
    extract::{Path, State},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::SqliteConnection;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/campuses/{id}/grades/submission", get(show))
        .route("/campuses/{id}/grades/submission/send", post(send))
        .route("/campuses/{id}/grades/submission/check", post(check))
        .route("/campuses/{id}/grades/submission/return", post(return_back))
        .route("/grades/submissions", get(list_all))
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
struct Submission {
    campus_id: i64,
    status: String,
    /// The secretary's note from the last return, cleared by the next send.
    note: Option<String>,
    updated_at: Option<String>,
    updated_by: Option<i64>,
}

async fn current(conn: &mut SqliteConnection, campus_id: i64) -> AppResult<Submission> {
    let row = sqlx::query_as::<_, Submission>(
        "SELECT campus_id, status, note, updated_at, updated_by
         FROM grades_submissions WHERE campus_id = ?",
    )
    .bind(campus_id)
    .fetch_optional(conn)
    .await?;
    Ok(row.unwrap_or(Submission {
        campus_id,
        status: "draft".into(),
        note: None,
        updated_at: None,
        updated_by: None,
    }))
}

fn clean(text: &Option<String>) -> Option<String> {
    text.as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(str::to_string)
}

/// Writes the new status and its audit row. The caller holds the write transaction.
async fn change(
    tx: &mut SqliteConnection,
    user: &CurrentUser,
    before: &Submission,
    status: &str,
    note: Option<&str>,
    action: &str,
) -> AppResult<Submission> {
    // A return stores its note; a send clears the previous one, as the migration says.
    let kept = if action == "return" { note } else { None };
    sqlx::query(
        "INSERT INTO grades_submissions (campus_id, status, note, updated_at, updated_by)
         VALUES (?1, ?2, ?3, datetime('now'), ?4)
         ON CONFLICT (campus_id) DO UPDATE SET status = excluded.status, note = excluded.note,
            updated_at = excluded.updated_at, updated_by = excluded.updated_by",
    )
    .bind(before.campus_id)
    .bind(status)
    .bind(kept)
    .bind(user.id)
    .execute(&mut *tx)
    .await?;
    audit::record(
        &mut *tx,
        AuditEntry {
            actor_id: Some(user.id),
            campus_id: Some(before.campus_id),
            entity: "grades.submission",
            entity_id: before.campus_id,
            subject_user_id: None,
            action,
            before: Some(json!({ "status": before.status })),
            after: Some(json!({ "status": status })),
            reason: match action {
                "return" => note,
                "edit" => Some("grades edited after sending"),
                _ => None,
            },
        },
    )
    .await?;
    current(tx, before.campus_id).await
}

async fn show(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(campus_id): Path<i64>,
) -> AppResult<Json<Submission>> {
    let mut conn = state.db.acquire().await?;
    require_campus(&mut conn, &user, campus_id, Access::Teach).await?;
    Ok(Json(current(&mut conn, campus_id).await?))
}

async fn send(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(campus_id): Path<i64>,
) -> AppResult<Json<Submission>> {
    let mut tx = begin_write(&state.db).await?;
    require_campus(&mut tx, &user, campus_id, Access::Teach).await?;
    let before = current(&mut tx, campus_id).await?;
    if before.status != "draft" {
        return Err(AppError::Conflict(
            "the grades were already sent to the secretary".into(),
        ));
    }
    let after = change(&mut tx, &user, &before, "sent", None, "send").await?;
    tx.commit().await?;
    Ok(Json(after))
}

/// Called by the gradebook inside the transaction of any grade or item change: a campus whose
/// grades were sent or checked goes back to draft, with an audit row, because the check no
/// longer describes the gradebook.
pub(crate) async fn reset_after_edit(
    tx: &mut SqliteConnection,
    user: &CurrentUser,
    campus_id: i64,
) -> AppResult<()> {
    let before = current(tx, campus_id).await?;
    if before.status == "draft" {
        return Ok(());
    }
    change(tx, user, &before, "draft", None, "edit").await?;
    Ok(())
}

/// Secretary-only: 403 for anyone else, including a professor of the campus.
async fn require_secretary(
    conn: &mut SqliteConnection,
    user: &CurrentUser,
    campus_id: i64,
) -> AppResult<()> {
    require_role(user, &[Role::Secretary])?;
    require_campus(conn, user, campus_id, Access::Manage).await?;
    Ok(())
}

async fn check(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(campus_id): Path<i64>,
) -> AppResult<Json<Submission>> {
    let mut tx = begin_write(&state.db).await?;
    require_secretary(&mut tx, &user, campus_id).await?;
    let before = current(&mut tx, campus_id).await?;
    if before.status != "sent" {
        return Err(AppError::Conflict(
            "only sent grades can be marked as checked".into(),
        ));
    }
    if before.updated_by == Some(user.id) {
        return Err(AppError::Forbidden);
    }
    let after = change(&mut tx, &user, &before, "checked", None, "check").await?;
    tx.commit().await?;
    Ok(Json(after))
}

#[derive(Deserialize)]
struct ReturnBody {
    note: Option<String>,
}

async fn return_back(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(campus_id): Path<i64>,
    Json(body): Json<ReturnBody>,
) -> AppResult<Json<Submission>> {
    let note = clean(&body.note)
        .ok_or_else(|| AppError::Unprocessable("a note is required to return the grades".into()))?;
    if note.chars().count() > 2000 {
        return Err(AppError::Unprocessable(
            "the note must have at most 2000 characters".into(),
        ));
    }
    let mut tx = begin_write(&state.db).await?;
    require_secretary(&mut tx, &user, campus_id).await?;
    let before = current(&mut tx, campus_id).await?;
    if before.status == "draft" {
        return Err(AppError::Conflict(
            "the grades were not sent to the secretary".into(),
        ));
    }
    let after = change(&mut tx, &user, &before, "draft", Some(&note), "return").await?;
    tx.commit().await?;
    Ok(Json(after))
}

/// The status of every campus the secretary may see (used by F21).
async fn list_all(State(state): State<AppState>, user: CurrentUser) -> AppResult<Json<Value>> {
    let mut conn = state.db.acquire().await?;
    let campuses = directory::list_campus_summaries(&mut conn, &user).await?;
    let mut rows = Vec::new();
    for campus in campuses {
        let sub = current(&mut conn, campus.id).await?;
        rows.push(json!({
            "campus_id": campus.id,
            "campus_name": campus.name,
            "university": campus.university,
            "university_name": campus.university,
            "students": campus.students,
            "status": sub.status,
            "note": sub.note,
            "updated_at": sub.updated_at,
        }));
    }
    Ok(Json(json!({ "campuses": rows })))
}
