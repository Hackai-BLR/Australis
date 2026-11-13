//! Synced presentations: a professor uploads a PDF, presents it live, and the students'
//! pages follow the current slide over server-sent events.
//!
//! The database is the source of truth (`slides_live.seq` grows on every change). `LiveHub`
//! only pushes the new state to open streams; a client that misses a message catches up
//! from `/live/{id}/state`.
//!
//! PowerPoint files go through `SlideConverter`, which is not configured in this build, so
//! a `.pptx` upload answers 422 and asks for a PDF.

use std::convert::Infallible;

pub mod notes;

use australis_core::{
    http::upload_body_limit, require_campus, Access, AppError, AppResult, AppState, CurrentUser,
};
use axum::{
    extract::{multipart::MultipartError, Multipart, Path, State},
    http::{header, StatusCode},
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Response,
    },
    routing::{get, post},
    Json, Router,
};
use futures::{stream, Stream, StreamExt};
use serde::{Deserialize, Serialize};
use sqlx::SqliteConnection;
use tokio_stream::wrappers::BroadcastStream;

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/campuses/{id}/presentations",
            post(upload).layer(upload_body_limit()).get(list),
        )
        .route("/campuses/{id}/live", get(campus_live))
        .route("/presentations/{pid}/file", get(file))
        .route("/presentations/{pid}/live", post(start_live))
        .route("/live/{lid}/state", get(state))
        .route("/live/{lid}/stream", get(stream_state))
        .route("/live/{lid}/goto", post(goto))
        .route("/live/{lid}/end", post(end))
        .merge(notes::router())
}

// --- types -----------------------------------------------------------------------------------

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct Presentation {
    pub id: i64,
    pub campus_id: i64,
    pub class_id: Option<i64>,
    pub title: String,
    pub source_filename: String,
    pub page_count: i64,
    pub created_at: String,
}

const PRESENTATION_COLUMNS: &str =
    "id, campus_id, class_id, title, source_filename, page_count, created_at";

/// What followers receive: one event per change, always the full state.
#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct LiveState {
    pub id: i64,
    pub presentation_id: i64,
    pub campus_id: i64,
    pub status: String,
    pub current_page: i64,
    pub page_count: i64,
    pub seq: i64,
}

const LIVE_SELECT: &str = "SELECT l.id, l.presentation_id, l.campus_id, l.status, \
     l.current_page, p.page_count, l.seq \
     FROM slides_live l JOIN slides_presentations p ON p.id = l.presentation_id";

fn topic(live_id: i64) -> String {
    format!("slides:{live_id}")
}

async fn load_live(conn: &mut SqliteConnection, live_id: i64) -> AppResult<LiveState> {
    sqlx::query_as::<_, LiveState>(&format!("{LIVE_SELECT} WHERE l.id = ?"))
        .bind(live_id)
        .fetch_optional(conn)
        .await?
        .ok_or(AppError::NotFound)
}

async fn campus_of_presentation(conn: &mut SqliteConnection, pid: i64) -> AppResult<i64> {
    sqlx::query_scalar("SELECT campus_id FROM slides_presentations WHERE id = ?")
        .bind(pid)
        .fetch_optional(conn)
        .await?
        .ok_or(AppError::NotFound)
}

fn publish(state: &AppState, live: &LiveState) {
    if let Ok(json) = serde_json::to_string(live) {
        state.live.publish(&topic(live.id), json);
    }
}

// --- upload ----------------------------------------------------------------------------------

/// An upload failure: either a rule of ours or axum's own multipart error (for example a
/// body over the limit, which keeps its 413).
enum UploadError {
    App(AppError),
    Multipart(MultipartError),
}

impl From<AppError> for UploadError {
    fn from(err: AppError) -> Self {
        Self::App(err)
    }
}

impl From<sqlx::Error> for UploadError {
    fn from(err: sqlx::Error) -> Self {
        Self::App(err.into())
    }
}

impl From<MultipartError> for UploadError {
    fn from(err: MultipartError) -> Self {
        Self::Multipart(err)
    }
}

impl IntoResponse for UploadError {
    fn into_response(self) -> Response {
        match self {
            Self::App(err) => err.into_response(),
            Self::Multipart(err) => err.into_response(),
        }
    }
}

fn pdf_page_count(bytes: &[u8]) -> AppResult<i64> {
    if !bytes.starts_with(b"%PDF-") {
        return Err(AppError::Unprocessable("the file is not a PDF".into()));
    }
    let doc = lopdf::Document::load_mem(bytes)
        .map_err(|_| AppError::Unprocessable("the PDF could not be read".into()))?;
    let pages = doc.get_pages().len() as i64;
    if pages == 0 {
        return Err(AppError::Unprocessable("the PDF has no pages".into()));
    }
    Ok(pages)
}

async fn upload(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(campus_id): Path<i64>,
    mut multipart: Multipart,
) -> Result<(StatusCode, Json<Presentation>), UploadError> {
    {
        let mut conn = state.db.acquire().await.map_err(AppError::from)?;
        require_campus(&mut conn, &user, campus_id, Access::Teach).await?;
    }

    let mut file: Option<(String, Vec<u8>)> = None;
    let mut title: Option<String> = None;
    let mut class_id: Option<i64> = None;
    while let Some(field) = multipart.next_field().await? {
        match field.name().unwrap_or_default() {
            "file" => {
                let name = field.file_name().unwrap_or("presentacion").to_string();
                file = Some((name, field.bytes().await?.to_vec()));
            }
            "title" => title = Some(field.text().await?.trim().to_string()),
            "class_id" => {
                let raw = field.text().await?;
                let raw = raw.trim();
                if !raw.is_empty() {
                    let id: i64 = raw
                        .parse()
                        .map_err(|_| AppError::BadRequest("class_id must be a number".into()))?;
                    if id < 1 {
                        return Err(AppError::Unprocessable(
                            "class_id must be a positive id".into(),
                        )
                        .into());
                    }
                    class_id = Some(id);
                }
            }
            _ => {}
        }
    }
    if let Some(id) = class_id {
        let mut conn = state.db.acquire().await.map_err(AppError::from)?;
        let in_campus: Option<i64> =
            sqlx::query_scalar("SELECT 1 FROM classes_classes WHERE id = ? AND campus_id = ?")
                .bind(id)
                .bind(campus_id)
                .fetch_optional(&mut *conn)
                .await?;
        if in_campus.is_none() {
            return Err(
                AppError::Unprocessable("class_id is not a class of this campus".into()).into(),
            );
        }
    }
    let (filename, bytes) =
        file.ok_or_else(|| AppError::BadRequest("a file field is required".into()))?;

    let lower = filename.to_lowercase();
    let pdf_bytes = if lower.ends_with(".pptx") || lower.ends_with(".ppt") {
        // Not configured in this build: the clear 422 that asks for a PDF.
        match state.slides.pptx_to_pdf(&bytes).await {
            Ok(pdf) => pdf,
            Err(_) => {
                return Err(AppError::Unprocessable(
                    "PowerPoint conversion is not available yet: export the presentation to PDF and upload that"
                        .into(),
                )
                .into())
            }
        }
    } else if lower.ends_with(".pdf") {
        bytes
    } else {
        return Err(AppError::Unprocessable("upload a PDF file".into()).into());
    };
    let page_count = pdf_page_count(&pdf_bytes)?;

    let title = title.filter(|t| !t.is_empty()).unwrap_or_else(|| {
        filename
            .rsplit_once('.')
            .map_or(filename.clone(), |(stem, _)| stem.into())
    });
    let key = state.files.save("pdf", &pdf_bytes).await?;

    let inserted = sqlx::query_as::<_, Presentation>(&format!(
        "INSERT INTO slides_presentations \
         (campus_id, class_id, title, source_filename, pdf_key, page_count, created_by) \
         VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING {PRESENTATION_COLUMNS}"
    ))
    .bind(campus_id)
    .bind(class_id)
    .bind(&title)
    .bind(&filename)
    .bind(&key)
    .bind(page_count)
    .bind(user.id)
    .fetch_one(&state.db)
    .await;
    match inserted {
        Ok(presentation) => Ok((StatusCode::CREATED, Json(presentation))),
        Err(err) => {
            let _ = state.files.remove(&key).await;
            Err(err.into())
        }
    }
}

async fn list(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(campus_id): Path<i64>,
) -> AppResult<Json<Vec<Presentation>>> {
    let mut conn = state.db.acquire().await?;
    require_campus(&mut conn, &user, campus_id, Access::View).await?;
    let rows = sqlx::query_as::<_, Presentation>(&format!(
        "SELECT {PRESENTATION_COLUMNS} FROM slides_presentations \
         WHERE campus_id = ? ORDER BY id DESC"
    ))
    .bind(campus_id)
    .fetch_all(&mut *conn)
    .await?;
    Ok(Json(rows))
}

async fn file(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(pid): Path<i64>,
) -> AppResult<Response> {
    let mut conn = state.db.acquire().await?;
    let campus_id = campus_of_presentation(&mut conn, pid).await?;
    require_campus(&mut conn, &user, campus_id, Access::View).await?;
    let key: String = sqlx::query_scalar("SELECT pdf_key FROM slides_presentations WHERE id = ?")
        .bind(pid)
        .fetch_one(&mut *conn)
        .await?;
    drop(conn);
    let bytes = state.files.read(&key).await?;
    Ok((
        [
            (header::CONTENT_TYPE, "application/pdf"),
            (header::CONTENT_DISPOSITION, "inline"),
            (header::CACHE_CONTROL, "private, max-age=3600"),
        ],
        bytes,
    )
        .into_response())
}

// --- live sessions -----------------------------------------------------------------------------

/// Starts presenting. A campus has one live session: starting another ends the previous one
/// (followers of the old session see it end and can join the new one).
async fn start_live(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(pid): Path<i64>,
) -> AppResult<(StatusCode, Json<LiveState>)> {
    let mut tx = australis_core::begin_write(&state.db).await?;
    let campus_id = campus_of_presentation(&mut tx, pid).await?;
    require_campus(&mut tx, &user, campus_id, Access::Teach).await?;

    let previous: Vec<i64> =
        sqlx::query_scalar("SELECT id FROM slides_live WHERE campus_id = ? AND status = 'live'")
            .bind(campus_id)
            .fetch_all(&mut *tx)
            .await?;
    sqlx::query(
        "UPDATE slides_live SET status = 'ended', seq = seq + 1, ended_at = datetime('now') \
         WHERE campus_id = ? AND status = 'live'",
    )
    .bind(campus_id)
    .execute(&mut *tx)
    .await?;
    let live_id: i64 = sqlx::query_scalar(
        "INSERT INTO slides_live (presentation_id, campus_id, started_by) \
         VALUES (?, ?, ?) RETURNING id",
    )
    .bind(pid)
    .bind(campus_id)
    .bind(user.id)
    .fetch_one(&mut *tx)
    .await?;
    let mut ended = Vec::new();
    for id in previous {
        ended.push(load_live(&mut tx, id).await?);
    }
    let live = load_live(&mut tx, live_id).await?;
    tx.commit().await?;

    for old in &ended {
        publish(&state, old);
    }
    Ok((StatusCode::CREATED, Json(live)))
}

async fn campus_live(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(campus_id): Path<i64>,
) -> AppResult<Json<Option<LiveState>>> {
    let mut conn = state.db.acquire().await?;
    require_campus(&mut conn, &user, campus_id, Access::View).await?;
    let live = sqlx::query_as::<_, LiveState>(&format!(
        "{LIVE_SELECT} WHERE l.campus_id = ? AND l.status = 'live'"
    ))
    .bind(campus_id)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(Json(live))
}

/// Loads a live session and checks the caller's access to its campus.
async fn live_for(
    state: &AppState,
    user: &CurrentUser,
    live_id: i64,
    needed: Access,
) -> AppResult<LiveState> {
    let mut conn = state.db.acquire().await?;
    let live = load_live(&mut conn, live_id).await?;
    require_campus(&mut conn, user, live.campus_id, needed).await?;
    Ok(live)
}

async fn state(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(lid): Path<i64>,
) -> AppResult<Json<LiveState>> {
    Ok(Json(live_for(&state, &user, lid, Access::View).await?))
}

const ACCESS_RECHECK: std::time::Duration = std::time::Duration::from_secs(3);

/// The same rule that opened the stream; any failure (including a database error) closes it.
async fn still_allowed(state: &AppState, user: &CurrentUser, live_id: i64) -> bool {
    live_for(state, user, live_id, Access::View).await.is_ok()
}

async fn stream_state(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(lid): Path<i64>,
) -> AppResult<Sse<impl Stream<Item = Result<Event, Infallible>>>> {
    // Check access first so a stranger cannot create topics; then subscribe before reading
    // the state, so a change in between is not lost (followers drop a lower seq).
    live_for(&state, &user, lid, Access::View).await?;
    let receiver = state.live.subscribe(&topic(lid));
    let current = live_for(&state, &user, lid, Access::View).await?;
    let first = serde_json::to_string(&current)
        .map_err(|err| AppError::Internal(format!("serialise state: {err}")))?;
    // Access is re-checked on every change and on a periodic tick; the stream ends as soon
    // as the caller no longer has View access (suspended, removed, disabled).
    // A lagged receiver skips ahead; the follower's safety poll fills any gap.
    let changes = BroadcastStream::new(receiver);
    let mut tick = tokio::time::interval(ACCESS_RECHECK);
    tick.tick().await;
    let events = stream::unfold(
        (Some(first), changes, tick),
        move |(pending, mut changes, mut tick)| {
            let state = state.clone();
            let user = user.clone();
            async move {
                let data = match pending {
                    Some(first) => first,
                    None => loop {
                        tokio::select! {
                            message = changes.next() => match message {
                                Some(Ok(data)) => {
                                    if still_allowed(&state, &user, lid).await {
                                        break data;
                                    }
                                    return None;
                                }
                                Some(Err(_)) => continue,
                                None => return None,
                            },
                            _ = tick.tick() => {
                                if !still_allowed(&state, &user, lid).await {
                                    return None;
                                }
                            }
                        }
                    },
                };
                Some((Ok(Event::default().data(data)), (None, changes, tick)))
            }
        },
    );
    Ok(Sse::new(events).keep_alive(KeepAlive::default()))
}

#[derive(Deserialize)]
struct Goto {
    page: i64,
}

async fn goto(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(lid): Path<i64>,
    Json(body): Json<Goto>,
) -> AppResult<Json<LiveState>> {
    let mut tx = australis_core::begin_write(&state.db).await?;
    let live = load_live(&mut tx, lid).await?;
    require_campus(&mut tx, &user, live.campus_id, Access::Teach).await?;
    if live.status != "live" {
        return Err(AppError::Conflict("the presentation has ended".into()));
    }
    // Clamp and bump in one statement so concurrent moves never reuse a seq.
    sqlx::query(
        "UPDATE slides_live SET seq = seq + 1, \
         current_page = MAX(1, MIN(?, (SELECT page_count FROM slides_presentations \
                                       WHERE id = slides_live.presentation_id))) \
         WHERE id = ?",
    )
    .bind(body.page)
    .bind(lid)
    .execute(&mut *tx)
    .await?;
    let live = load_live(&mut tx, lid).await?;
    tx.commit().await?;
    publish(&state, &live);
    Ok(Json(live))
}

async fn end(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(lid): Path<i64>,
) -> AppResult<Json<LiveState>> {
    let mut tx = australis_core::begin_write(&state.db).await?;
    let live = load_live(&mut tx, lid).await?;
    require_campus(&mut tx, &user, live.campus_id, Access::Teach).await?;
    sqlx::query(
        "UPDATE slides_live SET status = 'ended', seq = seq + 1, ended_at = datetime('now') \
         WHERE id = ? AND status = 'live'",
    )
    .bind(lid)
    .execute(&mut *tx)
    .await?;
    let live = load_live(&mut tx, lid).await?;
    tx.commit().await?;
    publish(&state, &live);
    Ok(Json(live))
}
