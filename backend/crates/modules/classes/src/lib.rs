//! Classes: one Zoom meeting per class and the "join today's class" view.
//!
//! The Zoom connection is a placeholder that only records that a professor connected. Meetings
//! come from `AppState::zoom` (a simulated provider in this build) or from a link the teacher
//! pastes. The host link (`start_url`) is only ever sent to people who can teach the campus.

use australis_core::{
    directory, require_campus, require_role, settings, zoom::MeetingRequest, Access, AppError,
    AppResult, AppState, CurrentUser, Role,
};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    routing::get,
    Json, Router,
};
use serde::{Deserialize, Serialize};
use sqlx::SqliteConnection;
use time::{
    format_description::{well_known::Rfc3339, FormatItem},
    macros::format_description,
    OffsetDateTime, PrimitiveDateTime,
};

pub mod recordings;

const DB_TIME: &[FormatItem<'static>] =
    format_description!("[year]-[month]-[day] [hour]:[minute]:[second]");
const MAX_TITLE_CHARS: usize = 200;
const MAX_DURATION_MIN: i64 = 24 * 60;
const MAX_LINK_CHARS: usize = 2000;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/zoom/connection", get(get_connection).post(connect_zoom))
        .route(
            "/campuses/{id}/classes",
            get(list_classes).post(create_class),
        )
        .route("/classes/today", get(today))
        .route("/classes/{cid}", get(get_class).patch(update_class))
        .merge(recordings::router())
}

// ---------------------------------------------------------------------------------------
// Zoom connection
// ---------------------------------------------------------------------------------------

#[derive(Serialize)]
struct Connection {
    connected: bool,
    provider: String,
    simulated: bool,
    connected_at: Option<String>,
}

async fn connection_of(state: &AppState, user: &CurrentUser) -> AppResult<Connection> {
    let mut conn = state.db.acquire().await?;
    let connected_at: Option<String> =
        sqlx::query_scalar("SELECT connected_at FROM classes_zoom_links WHERE user_id = ?")
            .bind(user.id)
            .fetch_optional(&mut *conn)
            .await?;
    Ok(Connection {
        connected: connected_at.is_some(),
        provider: state.zoom.name().to_string(),
        simulated: state.zoom.is_placeholder(),
        connected_at,
    })
}

async fn get_connection(
    State(state): State<AppState>,
    user: CurrentUser,
) -> AppResult<Json<Connection>> {
    require_role(&user, &[Role::Professor, Role::Secretary])?;
    Ok(Json(connection_of(&state, &user).await?))
}

async fn connect_zoom(
    State(state): State<AppState>,
    user: CurrentUser,
) -> AppResult<Json<Connection>> {
    require_role(&user, &[Role::Professor, Role::Secretary])?;
    let mut tx = australis_core::begin_write(&state.db).await?;
    sqlx::query(
        "INSERT INTO classes_zoom_links (user_id, provider) VALUES (?, ?)
         ON CONFLICT (user_id) DO UPDATE SET provider = excluded.provider,
            connected_at = datetime('now')",
    )
    .bind(user.id)
    .bind(state.zoom.name())
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Json(connection_of(&state, &user).await?))
}

// ---------------------------------------------------------------------------------------
// Classes
// ---------------------------------------------------------------------------------------

#[derive(sqlx::FromRow)]
struct ClassRow {
    id: i64,
    campus_id: i64,
    title: String,
    starts_at: String,
    duration_min: i64,
    meeting_source: String,
    zoom_meeting_id: Option<String>,
    join_url: String,
    start_url: Option<String>,
    recording_status: String,
    ended_at: Option<String>,
    campus_name: String,
}

#[derive(Serialize)]
struct ClassView {
    id: i64,
    campus_id: i64,
    campus_name: String,
    title: String,
    /// UTC, `YYYY-MM-DD HH:MM:SS`.
    starts_at: String,
    duration_min: i64,
    /// `placeholder` or `manual`.
    source: String,
    /// True for a simulated meeting: the screens show the "Simulado" badge.
    simulated: bool,
    zoom_meeting_id: Option<String>,
    join_url: String,
    /// The host link; present only for people who can teach the campus.
    start_url: Option<String>,
    can_teach: bool,
    recording_status: String,
    ended_at: Option<String>,
}

impl ClassRow {
    fn into_view(self, can_teach: bool) -> ClassView {
        ClassView {
            id: self.id,
            campus_id: self.campus_id,
            campus_name: self.campus_name,
            title: self.title,
            starts_at: self.starts_at,
            duration_min: self.duration_min,
            simulated: self.meeting_source == "placeholder",
            source: self.meeting_source,
            zoom_meeting_id: self.zoom_meeting_id,
            join_url: self.join_url,
            start_url: if can_teach { self.start_url } else { None },
            can_teach,
            recording_status: self.recording_status,
            ended_at: self.ended_at,
        }
    }
}

const CLASS_SELECT: &str = "SELECT cl.id, cl.campus_id, cl.title, cl.starts_at, cl.duration_min,
        cl.meeting_source, cl.zoom_meeting_id, cl.join_url, cl.start_url, cl.recording_status,
        cl.ended_at, ca.name AS campus_name
    FROM classes_classes cl
    JOIN core_campuses ca ON ca.id = cl.campus_id";

async fn find_class(conn: &mut SqliteConnection, class_id: i64) -> AppResult<ClassRow> {
    sqlx::query_as::<_, ClassRow>(&format!("{CLASS_SELECT} WHERE cl.id = ?"))
        .bind(class_id)
        .fetch_optional(conn)
        .await?
        .ok_or(AppError::NotFound)
}

async fn list_classes(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(campus_id): Path<i64>,
) -> AppResult<Json<Vec<ClassView>>> {
    let mut conn = state.db.acquire().await?;
    let access = require_campus(&mut conn, &user, campus_id, Access::View).await?;
    let can_teach = access.can(Access::Teach);
    let rows = sqlx::query_as::<_, ClassRow>(&format!(
        "{CLASS_SELECT} WHERE cl.campus_id = ? ORDER BY cl.starts_at, cl.id"
    ))
    .bind(campus_id)
    .fetch_all(&mut *conn)
    .await?;
    Ok(Json(
        rows.into_iter().map(|r| r.into_view(can_teach)).collect(),
    ))
}

#[derive(Deserialize)]
struct CreateClass {
    title: String,
    /// UTC: `YYYY-MM-DD HH:MM:SS` or RFC 3339.
    starts_at: String,
    duration_min: i64,
    /// A real meeting link pasted by the teacher; when present no meeting is created.
    join_url: Option<String>,
}

/// Parses a start time into the stored UTC form.
fn parse_starts_at(raw: &str) -> AppResult<String> {
    let raw = raw.trim();
    let parsed = if let Ok(at) = OffsetDateTime::parse(raw, &Rfc3339) {
        let utc = at.to_offset(time::UtcOffset::UTC);
        PrimitiveDateTime::new(utc.date(), utc.time())
    } else {
        PrimitiveDateTime::parse(raw, DB_TIME)
            .map_err(|_| AppError::Unprocessable("starts_at is not a valid date and time".into()))?
    };
    parsed
        .format(DB_TIME)
        .map_err(|e| AppError::Internal(format!("format time: {e}")))
}

fn clean_title(raw: &str) -> AppResult<String> {
    let title = raw.trim();
    if title.is_empty() {
        return Err(AppError::Unprocessable("title is required".into()));
    }
    if title.chars().count() > MAX_TITLE_CHARS {
        return Err(AppError::Unprocessable("title is too long".into()));
    }
    Ok(title.to_string())
}

fn check_duration(minutes: i64) -> AppResult<i64> {
    if (1..=MAX_DURATION_MIN).contains(&minutes) {
        Ok(minutes)
    } else {
        Err(AppError::Unprocessable(format!(
            "duration_min must be between 1 and {MAX_DURATION_MIN}"
        )))
    }
}

/// A pasted meeting link: http or https only, no spaces or control characters.
fn clean_link(raw: &str) -> AppResult<String> {
    let link = raw.trim();
    let lower = link.to_ascii_lowercase();
    let scheme_ok = lower.starts_with("http://") || lower.starts_with("https://");
    let host_ok = link
        .split_once("://")
        .is_some_and(|(_, rest)| !rest.is_empty());
    let chars_ok = !link.chars().any(|c| c.is_whitespace() || c.is_control());
    if scheme_ok && host_ok && chars_ok && link.chars().count() <= MAX_LINK_CHARS {
        Ok(link.to_string())
    } else {
        Err(AppError::Unprocessable(
            "the meeting link must be an http or https address".into(),
        ))
    }
}

async fn create_class(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(campus_id): Path<i64>,
    Json(body): Json<CreateClass>,
) -> AppResult<(StatusCode, Json<ClassView>)> {
    {
        let mut conn = state.db.acquire().await?;
        require_campus(&mut conn, &user, campus_id, Access::Teach).await?;
    }
    let title = clean_title(&body.title)?;
    let starts_at = parse_starts_at(&body.starts_at)?;
    let duration_min = check_duration(body.duration_min)?;
    let pasted = body
        .join_url
        .as_deref()
        .map(str::trim)
        .filter(|link| !link.is_empty())
        .map(clean_link)
        .transpose()?;

    // The provider call happens before the write transaction opens.
    let (source, meeting_id, join_url, start_url) = match pasted {
        Some(link) => ("manual", None, link, None),
        None => {
            let meeting = state
                .zoom
                .create_meeting(&MeetingRequest {
                    topic: title.clone(),
                    starts_at: starts_at.clone(),
                    duration_minutes: duration_min,
                })
                .await?;
            (
                "placeholder",
                Some(meeting.meeting_id),
                meeting.join_url,
                Some(meeting.start_url),
            )
        }
    };

    let mut tx = australis_core::begin_write(&state.db).await?;
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO classes_classes
            (campus_id, title, starts_at, duration_min, meeting_source, zoom_meeting_id,
             join_url, start_url, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
    )
    .bind(campus_id)
    .bind(&title)
    .bind(&starts_at)
    .bind(duration_min)
    .bind(source)
    .bind(meeting_id)
    .bind(&join_url)
    .bind(start_url)
    .bind(user.id)
    .fetch_one(&mut *tx)
    .await?;
    let row = find_class(&mut tx, id).await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(row.into_view(true))))
}

async fn today(
    State(state): State<AppState>,
    user: CurrentUser,
) -> AppResult<Json<Vec<ClassView>>> {
    let mut conn = state.db.acquire().await?;
    let campuses = directory::campuses_for_user(&mut conn, &user).await?;
    let modifier = settings::local_time_modifier(&mut conn).await?;
    let day = settings::local_today(&mut conn).await?;
    let rows = sqlx::query_as::<_, ClassRow>(&format!(
        "{CLASS_SELECT} WHERE date(cl.starts_at, ?) = ? ORDER BY cl.starts_at, cl.id"
    ))
    .bind(modifier)
    .bind(day)
    .fetch_all(&mut *conn)
    .await?;
    let views = rows
        .into_iter()
        .filter_map(|row| {
            let campus = campuses.iter().find(|c| c.id == row.campus_id)?;
            Some(row.into_view(campus.access >= Access::Teach))
        })
        .collect();
    Ok(Json(views))
}

async fn get_class(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(class_id): Path<i64>,
) -> AppResult<Json<ClassView>> {
    let mut conn = state.db.acquire().await?;
    let row = find_class(&mut conn, class_id).await?;
    let access = require_campus(&mut conn, &user, row.campus_id, Access::View).await?;
    Ok(Json(row.into_view(access.can(Access::Teach))))
}

#[derive(Deserialize)]
struct UpdateClass {
    title: Option<String>,
    starts_at: Option<String>,
    duration_min: Option<i64>,
    /// true marks the class as ended now; false reopens it.
    ended: Option<bool>,
}

async fn update_class(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(class_id): Path<i64>,
    Json(body): Json<UpdateClass>,
) -> AppResult<Json<ClassView>> {
    let title = body.title.as_deref().map(clean_title).transpose()?;
    let starts_at = body.starts_at.as_deref().map(parse_starts_at).transpose()?;
    let duration_min = body.duration_min.map(check_duration).transpose()?;

    let mut tx = australis_core::begin_write(&state.db).await?;
    let existing = find_class(&mut tx, class_id).await?;
    require_campus(&mut tx, &user, existing.campus_id, Access::Teach).await?;
    sqlx::query(
        "UPDATE classes_classes SET
            title = COALESCE(?1, title),
            starts_at = COALESCE(?2, starts_at),
            duration_min = COALESCE(?3, duration_min),
            ended_at = CASE ?4 WHEN 1 THEN COALESCE(ended_at, datetime('now'))
                               WHEN 0 THEN NULL ELSE ended_at END
         WHERE id = ?5",
    )
    .bind(title)
    .bind(starts_at)
    .bind(duration_min)
    .bind(body.ended)
    .bind(class_id)
    .execute(&mut *tx)
    .await?;
    let row = find_class(&mut tx, class_id).await?;
    tx.commit().await?;
    Ok(Json(row.into_view(true)))
}
