//! Private notes per presentation page. A note belongs to its author: every query filters by
//! the caller's id, so nobody else (not even the secretary) can read it. The author needs
//! View access to the campus, so a suspended student loses the notes along with the access.

use australis_core::{require_campus, Access, AppError, AppResult, AppState, CurrentUser};
use axum::{
    extract::{Path, State},
    http::header,
    response::{IntoResponse, Response},
    routing::{get, put},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use sqlx::SqliteConnection;

use super::campus_of_presentation;

const MAX_NOTE_CHARS: usize = 10_000;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/presentations/{pid}/notes", get(list))
        .route("/presentations/{pid}/notes/export", get(export))
        .route("/presentations/{pid}/notes/{page}", put(save))
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct Note {
    pub page: i64,
    pub body: String,
    pub updated_at: String,
}

/// Checks View access to the presentation's campus; returns its title and page count.
async fn open(
    conn: &mut SqliteConnection,
    user: &CurrentUser,
    pid: i64,
) -> AppResult<(String, i64)> {
    let campus_id = campus_of_presentation(conn, pid).await?;
    require_campus(conn, user, campus_id, Access::View).await?;
    Ok(
        sqlx::query_as("SELECT title, page_count FROM slides_presentations WHERE id = ?")
            .bind(pid)
            .fetch_one(conn)
            .await?,
    )
}

async fn my_notes(conn: &mut SqliteConnection, pid: i64, user_id: i64) -> AppResult<Vec<Note>> {
    Ok(sqlx::query_as::<_, Note>(
        "SELECT page, body, updated_at FROM slides_notes \
         WHERE presentation_id = ? AND user_id = ? ORDER BY page",
    )
    .bind(pid)
    .bind(user_id)
    .fetch_all(conn)
    .await?)
}

async fn list(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(pid): Path<i64>,
) -> AppResult<Json<Vec<Note>>> {
    let mut conn = state.db.acquire().await?;
    open(&mut conn, &user, pid).await?;
    Ok(Json(my_notes(&mut conn, pid, user.id).await?))
}

#[derive(Deserialize)]
struct SaveNote {
    body: String,
}

/// Creates or replaces the caller's note on a page; an empty body removes it.
async fn save(
    State(state): State<AppState>,
    user: CurrentUser,
    Path((pid, page)): Path<(i64, i64)>,
    Json(input): Json<SaveNote>,
) -> AppResult<Json<Option<Note>>> {
    if input.body.chars().count() > MAX_NOTE_CHARS {
        return Err(AppError::Unprocessable(format!(
            "a note can have at most {MAX_NOTE_CHARS} characters"
        )));
    }
    let mut tx = australis_core::begin_write(&state.db).await?;
    let (_, page_count) = open(&mut tx, &user, pid).await?;
    if page < 1 || page > page_count {
        return Err(AppError::Unprocessable(
            "the page is not part of the presentation".into(),
        ));
    }
    let note = if input.body.trim().is_empty() {
        sqlx::query(
            "DELETE FROM slides_notes WHERE presentation_id = ? AND user_id = ? AND page = ?",
        )
        .bind(pid)
        .bind(user.id)
        .bind(page)
        .execute(&mut *tx)
        .await?;
        None
    } else {
        Some(
            sqlx::query_as::<_, Note>(
                "INSERT INTO slides_notes (presentation_id, user_id, page, body) \
                 VALUES (?, ?, ?, ?) \
                 ON CONFLICT (presentation_id, user_id, page) \
                 DO UPDATE SET body = excluded.body, updated_at = datetime('now') \
                 RETURNING page, body, updated_at",
            )
            .bind(pid)
            .bind(user.id)
            .bind(page)
            .bind(&input.body)
            .fetch_one(&mut *tx)
            .await?,
        )
    };
    tx.commit().await?;
    Ok(Json(note))
}

/// All the caller's notes of a presentation as one text file, in page order.
async fn export(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(pid): Path<i64>,
) -> AppResult<Response> {
    let mut conn = state.db.acquire().await?;
    let (title, _) = open(&mut conn, &user, pid).await?;
    let notes = my_notes(&mut conn, pid, user.id).await?;
    let mut text = format!("Notas: {title}\n");
    for note in &notes {
        text.push_str(&format!("\n--- Página {} ---\n{}\n", note.page, note.body));
    }
    Ok((
        [
            (
                header::CONTENT_TYPE,
                "text/plain; charset=utf-8".to_string(),
            ),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"notas-{pid}.txt\""),
            ),
            (header::CACHE_CONTROL, "private, no-store".to_string()),
        ],
        text,
    )
        .into_response())
}
