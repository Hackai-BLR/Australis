//! F10 attendance: one record per student per class (present, absent, late or excused).
//!
//! A teacher saves records by hand or fills them from the Zoom participant list and corrects
//! them afterwards. Every change after the first save needs a reason and writes an audit row
//! in the same transaction. A student reads only their own record. Nothing here is reachable
//! from the AI: no AI call touches this table.

use std::collections::{HashMap, HashSet};

use australis_core::{
    audit::{self, AuditEntry},
    directory::{self, MemberRole, MemberStatus},
    require_campus,
    settings::{self, AttendanceRule},
    zoom::{Invitee, Participant},
    Access, AppError, AppResult, AppState, CurrentUser,
};
use axum::{
    extract::{Path, State},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::SqliteConnection;

const STATUSES: [&str; 4] = ["present", "absent", "late", "excused"];
const MAX_ENTRIES: usize = 1000;
const MAX_REASON_CHARS: usize = 500;
const LATE_AFTER_KEY: &str = "attendance.late_after_minutes";

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/classes/{cid}/attendance",
            get(get_attendance).put(save_attendance),
        )
        .route(
            "/classes/{cid}/attendance/from-session",
            post(take_from_session),
        )
}

#[derive(Deserialize)]
struct LateAfter {
    minutes: i64,
    #[serde(default)]
    confirmed: bool,
}

#[derive(Serialize)]
struct Row {
    user_id: i64,
    full_name: String,
    /// `None` while no record exists for the student.
    status: Option<String>,
    source: Option<String>,
    reason: Option<String>,
    updated_at: Option<String>,
}

#[derive(Serialize)]
struct Sheet {
    class_id: i64,
    can_teach: bool,
    /// True when the participant list comes from the placeholder provider.
    simulated: bool,
    rule: AttendanceRule,
    late_after_minutes: i64,
    late_after_confirmed: bool,
    /// Everyone for a teacher; only the caller for a student.
    rows: Vec<Row>,
}

#[derive(Serialize)]
struct TakeResult {
    #[serde(flatten)]
    sheet: Sheet,
    /// Participants Zoom saw who match no student of the campus (guests, other devices).
    unmatched: Vec<String>,
}

struct ClassInfo {
    campus_id: i64,
    meeting_id: Option<String>,
}

async fn class_info(conn: &mut SqliteConnection, class_id: i64) -> AppResult<ClassInfo> {
    let (campus_id, meeting_id): (i64, Option<String>) =
        sqlx::query_as("SELECT campus_id, zoom_meeting_id FROM classes_classes WHERE id = ?")
            .bind(class_id)
            .fetch_optional(conn)
            .await?
            .ok_or(AppError::NotFound)?;
    Ok(ClassInfo {
        campus_id,
        meeting_id,
    })
}

async fn active_students(
    conn: &mut SqliteConnection,
    campus_id: i64,
) -> AppResult<Vec<directory::MemberDetail>> {
    Ok(directory::list_members(conn, campus_id)
        .await?
        .into_iter()
        .filter(|m| m.role == MemberRole::Student && m.status == MemberStatus::Active)
        .collect())
}

async fn build_sheet(
    state: &AppState,
    conn: &mut SqliteConnection,
    class_id: i64,
    campus_id: i64,
    can_teach: bool,
    user_id: i64,
) -> AppResult<Sheet> {
    let rule = settings::attendance_rule(conn, campus_id).await?;
    let late: LateAfter = settings::get(conn, LATE_AFTER_KEY).await?;
    let students = active_students(conn, campus_id).await?;
    let records: Vec<(i64, String, String, Option<String>, String)> = sqlx::query_as(
        "SELECT user_id, status, source, reason, updated_at FROM classes_attendance
         WHERE class_id = ?",
    )
    .bind(class_id)
    .fetch_all(&mut *conn)
    .await?;
    let mut by_user: HashMap<i64, (String, String, Option<String>, String)> = records
        .into_iter()
        .map(|(id, status, source, reason, at)| (id, (status, source, reason, at)))
        .collect();
    let mut rows: Vec<Row> = students
        .into_iter()
        .map(|m| {
            let record = by_user.remove(&m.user_id);
            Row {
                user_id: m.user_id,
                full_name: m.full_name,
                status: record.as_ref().map(|r| r.0.clone()),
                source: record.as_ref().map(|r| r.1.clone()),
                reason: record.as_ref().and_then(|r| r.2.clone()),
                updated_at: record.map(|r| r.3),
            }
        })
        .collect();
    if !can_teach {
        rows.retain(|row| row.user_id == user_id);
    }
    Ok(Sheet {
        class_id,
        can_teach,
        simulated: state.zoom.is_placeholder(),
        rule,
        late_after_minutes: late.minutes,
        late_after_confirmed: late.confirmed,
        rows,
    })
}

async fn get_attendance(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(class_id): Path<i64>,
) -> AppResult<Json<Sheet>> {
    let mut conn = state.db.acquire().await?;
    let info = class_info(&mut conn, class_id).await?;
    let access = require_campus(&mut conn, &user, info.campus_id, Access::View).await?;
    let sheet = build_sheet(
        &state,
        &mut conn,
        class_id,
        info.campus_id,
        access.can(Access::Teach),
        user.id,
    )
    .await?;
    Ok(Json(sheet))
}

struct Change {
    user_id: i64,
    status: String,
    source: &'static str,
}

#[derive(sqlx::FromRow)]
struct Existing {
    id: i64,
    status: String,
    source: String,
    reason: Option<String>,
}

fn clean_reason(raw: Option<&str>) -> AppResult<Option<String>> {
    let reason = raw.map(str::trim).filter(|r| !r.is_empty());
    if reason.is_some_and(|r| r.chars().count() > MAX_REASON_CHARS) {
        return Err(AppError::Unprocessable("the reason is too long".into()));
    }
    Ok(reason.map(str::to_string))
}

/// Writes the changes in one transaction. A first save needs no reason; changing an existing
/// record to another status needs one. Records that already hold the status are left alone, and a record saved
/// by hand is never replaced by the session's status.
async fn apply(
    state: &AppState,
    actor: &CurrentUser,
    class_id: i64,
    campus_id: i64,
    changes: Vec<Change>,
    reason: Option<&str>,
) -> AppResult<()> {
    let mut tx = australis_core::begin_write(&state.db).await?;
    let students: HashSet<i64> = active_students(&mut tx, campus_id)
        .await?
        .into_iter()
        .map(|m| m.user_id)
        .collect();
    for change in &changes {
        if !students.contains(&change.user_id) {
            return Err(AppError::Unprocessable(format!(
                "user {} is not an active student of this campus",
                change.user_id
            )));
        }
    }
    for change in changes {
        let existing: Option<Existing> = sqlx::query_as(
            "SELECT id, status, source, reason FROM classes_attendance
             WHERE class_id = ? AND user_id = ?",
        )
        .bind(class_id)
        .bind(change.user_id)
        .fetch_optional(&mut *tx)
        .await?;
        match existing {
            None => {
                let id: i64 = sqlx::query_scalar(
                    "INSERT INTO classes_attendance (class_id, user_id, status, source, updated_by)
                     VALUES (?, ?, ?, ?, ?) RETURNING id",
                )
                .bind(class_id)
                .bind(change.user_id)
                .bind(&change.status)
                .bind(change.source)
                .bind(actor.id)
                .fetch_one(&mut *tx)
                .await?;
                audit::record(
                    &mut tx,
                    AuditEntry {
                        actor_id: Some(actor.id),
                        campus_id: Some(campus_id),
                        entity: "classes.attendance",
                        entity_id: id,
                        subject_user_id: Some(change.user_id),
                        action: "create",
                        before: None,
                        after: Some(json!({
                            "class_id": class_id,
                            "status": change.status,
                            "source": change.source,
                        })),
                        reason: None,
                    },
                )
                .await?;
            }
            Some(old) if old.status == change.status => {}
            // A second take from the session never overwrites a record saved by hand.
            Some(old) if change.source == "session" && old.source != "session" => {}
            Some(old) => {
                let reason = reason.ok_or_else(|| {
                    AppError::Unprocessable(
                        "a reason is required to change an attendance record".into(),
                    )
                })?;
                sqlx::query(
                    "UPDATE classes_attendance SET status = ?, source = ?, reason = ?,
                        updated_by = ?, updated_at = datetime('now') WHERE id = ?",
                )
                .bind(&change.status)
                .bind(change.source)
                .bind(reason)
                .bind(actor.id)
                .bind(old.id)
                .execute(&mut *tx)
                .await?;
                audit::record(
                    &mut tx,
                    AuditEntry {
                        actor_id: Some(actor.id),
                        campus_id: Some(campus_id),
                        entity: "classes.attendance",
                        entity_id: old.id,
                        subject_user_id: Some(change.user_id),
                        action: "update",
                        before: Some(json!({
                            "class_id": class_id,
                            "status": old.status,
                            "source": old.source,
                            "reason": old.reason,
                        })),
                        after: Some(json!({
                            "class_id": class_id,
                            "status": change.status,
                            "source": change.source,
                        })),
                        reason: Some(reason),
                    },
                )
                .await?;
            }
        }
    }
    tx.commit().await?;
    Ok(())
}

#[derive(Deserialize)]
struct Entry {
    user_id: i64,
    status: String,
}

#[derive(Deserialize)]
struct SaveBody {
    entries: Vec<Entry>,
    /// Required when any entry changes a record that already exists.
    reason: Option<String>,
}

async fn save_attendance(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(class_id): Path<i64>,
    Json(body): Json<SaveBody>,
) -> AppResult<Json<Sheet>> {
    let info = {
        let mut conn = state.db.acquire().await?;
        let info = class_info(&mut conn, class_id).await?;
        require_campus(&mut conn, &user, info.campus_id, Access::Teach).await?;
        info
    };
    if body.entries.is_empty() || body.entries.len() > MAX_ENTRIES {
        return Err(AppError::Unprocessable(format!(
            "send between 1 and {MAX_ENTRIES} entries"
        )));
    }
    let mut seen = HashSet::new();
    let mut changes = Vec::new();
    for entry in &body.entries {
        if !STATUSES.contains(&entry.status.as_str()) {
            return Err(AppError::Unprocessable(
                "status must be present, absent, late or excused".into(),
            ));
        }
        if !seen.insert(entry.user_id) {
            return Err(AppError::Unprocessable("a student appears twice".into()));
        }
        changes.push(Change {
            user_id: entry.user_id,
            status: entry.status.clone(),
            source: "manual",
        });
    }
    let reason = clean_reason(body.reason.as_deref())?;
    apply(
        &state,
        &user,
        class_id,
        info.campus_id,
        changes,
        reason.as_deref(),
    )
    .await?;
    let mut conn = state.db.acquire().await?;
    Ok(Json(
        build_sheet(&state, &mut conn, class_id, info.campus_id, true, user.id).await?,
    ))
}

#[derive(Deserialize, Default)]
struct SessionBody {
    /// Required when the class already has records that the session would change.
    reason: Option<String>,
}

fn normalize(name: &str) -> String {
    name.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// The status Zoom's list implies for one student: absent if they never joined, late if they
/// joined after the campus threshold, present otherwise.
fn status_from(participant: Option<&Participant>, late_after_minutes: i64) -> &'static str {
    match participant {
        None => "absent",
        Some(p) if p.joined_after_seconds > late_after_minutes * 60 => "late",
        Some(_) => "present",
    }
}

async fn take_from_session(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(class_id): Path<i64>,
    body: Option<Json<SessionBody>>,
) -> AppResult<Json<TakeResult>> {
    let body = body.map(|Json(b)| b).unwrap_or_default();
    let (info, students, late) = {
        let mut conn = state.db.acquire().await?;
        let info = class_info(&mut conn, class_id).await?;
        require_campus(&mut conn, &user, info.campus_id, Access::Teach).await?;
        let students = active_students(&mut conn, info.campus_id).await?;
        let late: LateAfter = settings::get(&mut conn, LATE_AFTER_KEY).await?;
        (info, students, late)
    };
    let meeting_id = info.meeting_id.clone().ok_or_else(|| {
        AppError::Unprocessable("this class has no Zoom meeting to take attendance from".into())
    })?;
    let invitees: Vec<Invitee> = students
        .iter()
        .map(|m| Invitee {
            user_id: m.user_id,
            email: m.email.clone(),
            full_name: m.full_name.clone(),
        })
        .collect();
    // The provider call happens before the write transaction opens.
    let participants = state
        .zoom
        .fetch_participants(&meeting_id, &invitees)
        .await?;

    let by_email: HashMap<String, usize> = students
        .iter()
        .enumerate()
        .map(|(i, m)| (m.email.to_lowercase(), i))
        .collect();
    let mut by_name: HashMap<String, Vec<usize>> = HashMap::new();
    for (i, m) in students.iter().enumerate() {
        by_name.entry(normalize(&m.full_name)).or_default().push(i);
    }
    // Earliest join per student: a student who reconnects counts once.
    let mut matched: HashMap<usize, &Participant> = HashMap::new();
    let mut unmatched = Vec::new();
    for p in &participants {
        let by_mail = p
            .email
            .as_ref()
            .and_then(|e| by_email.get(&e.trim().to_lowercase()).copied());
        let index = by_mail.or_else(|| match by_name.get(&normalize(&p.name)) {
            Some(list) if list.len() == 1 => Some(list[0]),
            _ => None,
        });
        match index {
            Some(i) => {
                let best = matched.entry(i).or_insert(p);
                if p.joined_after_seconds < best.joined_after_seconds {
                    *best = p;
                }
            }
            None => unmatched.push(p.name.clone()),
        }
    }
    let changes: Vec<Change> = students
        .iter()
        .enumerate()
        .map(|(i, m)| Change {
            user_id: m.user_id,
            status: status_from(matched.get(&i).copied(), late.minutes).to_string(),
            source: "session",
        })
        .collect();
    let reason = clean_reason(body.reason.as_deref())?;
    apply(
        &state,
        &user,
        class_id,
        info.campus_id,
        changes,
        reason.as_deref(),
    )
    .await?;
    let mut conn = state.db.acquire().await?;
    let sheet = build_sheet(&state, &mut conn, class_id, info.campus_id, true, user.id).await?;
    Ok(Json(TakeResult { sheet, unmatched }))
}
