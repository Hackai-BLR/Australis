//! Roster: import students from Excel, CSV or a pasted list, and manage a campus's members.
//!
//! An import is two steps. The upload is parsed into a stored preview that keeps only the
//! name and the email of each row; confirming reads that stored preview (the client cannot
//! alter rows) and creates invited accounts plus student memberships. Nothing here deletes a
//! user or a member: removal is suspension, with a required reason, audited by the kernel.
//! Everything is Manage-level.
//!
//! All access to `core_*` tables goes through `australis_core`; the module's own tables are
//! `roster_imports` and `roster_import_rows`.

mod parse;

use std::collections::{BTreeMap, HashSet};

use australis_core::{
    audit::{self, AuditEntry},
    begin_write,
    directory::{self, MemberDetail, MemberRole, NewUser, UserStatus},
    http::upload_body_limit,
    Access, AppError, AppResult, AppState, CurrentUser, Role,
};
use axum::{
    body::Bytes,
    extract::{FromRequest, Multipart, Path, Request, State},
    http::{header::CONTENT_TYPE, StatusCode},
    routing::{get, post},
    Json, Router,
};
use parse::ParsedRow;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::SqliteConnection;

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/campuses/{id}/roster/imports",
            post(create_import).layer(upload_body_limit()),
        )
        .route("/campuses/{id}/roster/imports/{iid}/confirm", post(confirm))
        .route("/campuses/{id}/roster/imports/{iid}/discard", post(discard))
        .route("/campuses/{id}/members", get(list_members))
        .route("/campuses/{id}/members/{uid}/suspend", post(suspend))
        .route("/campuses/{id}/members/{uid}/reactivate", post(reactivate))
        .route("/campuses/{id}/members/{uid}/invite", post(reinvite))
        .route("/campuses/{id}/teachers", post(add_teacher))
}

// --- flags --------------------------------------------------------------------------------

const DUPLICATE_IN_FILE: &str = "duplicate_in_file";
const INVALID_EMAIL: &str = "invalid_email";
const MISSING_NAME: &str = "missing_name";
const ALREADY_MEMBER: &str = "already_member";
const EXISTING_ACCOUNT: &str = "existing_account";
const NON_STUDENT_ACCOUNT: &str = "non_student_account";
const SUSPENDED_ACCOUNT: &str = "suspended_account";

/// Flags that keep a row out of the import. `existing_account` only informs: the student
/// already has an account, so the row adds them to the campus without a new invite.
fn is_blocking(flag: &str) -> bool {
    flag != EXISTING_ACCOUNT
}

struct StoredRow {
    line_no: i64,
    full_name: String,
    email: String,
}

struct Classified {
    row: StoredRow,
    flags: Vec<&'static str>,
    account: Option<directory::User>,
}

impl Classified {
    fn importable(&self) -> bool {
        !self.flags.iter().any(|flag| is_blocking(flag))
    }
}

/// Flags every row against the current state of the database. Run both for the preview and
/// again at confirm, so a row that became invalid in between is never imported.
async fn classify(
    conn: &mut SqliteConnection,
    campus_id: i64,
    rows: Vec<StoredRow>,
) -> AppResult<Vec<Classified>> {
    let mut seen = HashSet::new();
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let mut flags = Vec::new();
        let mut account = None;
        if row.full_name.trim().is_empty() {
            flags.push(MISSING_NAME);
        }
        match directory::normalize_email(&row.email) {
            Err(_) => flags.push(INVALID_EMAIL),
            Ok(email) => {
                if !seen.insert(email.clone()) {
                    flags.push(DUPLICATE_IN_FILE);
                }
                if let Some(user) = directory::find_user_by_email(conn, &email).await? {
                    if user.role == Role::Student {
                        flags.push(EXISTING_ACCOUNT);
                    } else {
                        flags.push(NON_STUDENT_ACCOUNT);
                    }
                    if user.status == UserStatus::Suspended {
                        flags.push(SUSPENDED_ACCOUNT);
                    }
                    if directory::find_member(conn, campus_id, user.id)
                        .await?
                        .is_some()
                    {
                        flags.push(ALREADY_MEMBER);
                    }
                    account = Some(user);
                }
            }
        }
        out.push(Classified {
            row,
            flags,
            account,
        });
    }
    Ok(out)
}

#[derive(Serialize)]
struct PreviewRow {
    line: i64,
    full_name: String,
    email: String,
    flags: Vec<&'static str>,
    importable: bool,
}

#[derive(Serialize)]
struct Preview {
    id: i64,
    total: usize,
    importable: usize,
    /// How many rows carry each flag.
    counts: BTreeMap<&'static str, usize>,
    rows: Vec<PreviewRow>,
}

fn preview_of(id: i64, classified: Vec<Classified>) -> Preview {
    let mut counts = BTreeMap::new();
    for row in &classified {
        for flag in &row.flags {
            *counts.entry(*flag).or_insert(0) += 1;
        }
    }
    let importable = classified.iter().filter(|c| c.importable()).count();
    Preview {
        id,
        total: classified.len(),
        importable,
        counts,
        rows: classified
            .into_iter()
            .map(|c| PreviewRow {
                importable: c.importable(),
                line: c.row.line_no,
                full_name: c.row.full_name,
                email: c.row.email,
                flags: c.flags,
            })
            .collect(),
    }
}

// --- import -------------------------------------------------------------------------------

#[derive(Deserialize)]
struct PastedText {
    text: String,
}

fn bad_upload(_: impl std::fmt::Display) -> AppError {
    AppError::BadRequest("the upload could not be read".into())
}

/// Reads the request: a multipart form with a `file` part (.xlsx or .csv), or JSON
/// `{"text": "..."}`. The format is detected from the content, not from the file name.
async fn read_source(
    state: &AppState,
    request: Request,
) -> AppResult<(&'static str, Vec<ParsedRow>)> {
    let content_type = request
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    if content_type.starts_with("multipart/form-data") {
        let mut multipart = Multipart::from_request(request, state)
            .await
            .map_err(bad_upload)?;
        while let Some(field) = multipart.next_field().await.map_err(bad_upload)? {
            if field.name() != Some("file") {
                continue;
            }
            let name = field.file_name().unwrap_or("").to_lowercase();
            let bytes = field.bytes().await.map_err(bad_upload)?;
            if bytes.starts_with(b"PK") {
                return Ok(("xlsx", parse::parse_xlsx(&bytes)?));
            }
            if name.ends_with(".xls") || bytes.starts_with(&[0xD0, 0xCF, 0x11, 0xE0]) {
                return Err(AppError::Unprocessable(
                    "old .xls files are not supported; save it as .xlsx or .csv".into(),
                ));
            }
            return Ok(("csv", parse::parse_csv(&bytes)?));
        }
        return Err(AppError::BadRequest("the form has no \"file\" part".into()));
    }
    let bytes = Bytes::from_request(request, state)
        .await
        .map_err(bad_upload)?;
    let body: PastedText = serde_json::from_slice(&bytes)
        .map_err(|_| AppError::BadRequest("send a file or JSON {\"text\": \"...\"}".into()))?;
    Ok(("text", parse::parse_text(&body.text)?))
}

async fn create_import(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(campus_id): Path<i64>,
    request: Request,
) -> AppResult<(StatusCode, Json<Preview>)> {
    {
        let mut conn = state.db.acquire().await?;
        australis_core::require_campus(&mut conn, &user, campus_id, Access::Manage).await?;
    }
    let (source, parsed) = read_source(&state, request).await?;
    let rows: Vec<StoredRow> = parsed
        .into_iter()
        .map(|row| StoredRow {
            line_no: row.line_no,
            email: directory::normalize_email(&row.email).unwrap_or(row.email),
            full_name: row.full_name,
        })
        .collect();

    let mut tx = begin_write(&state.db).await?;
    let import_id =
        sqlx::query("INSERT INTO roster_imports (campus_id, created_by, source) VALUES (?, ?, ?)")
            .bind(campus_id)
            .bind(user.id)
            .bind(source)
            .execute(&mut *tx)
            .await?
            .last_insert_rowid();
    for row in &rows {
        sqlx::query(
            "INSERT INTO roster_import_rows (import_id, line_no, full_name, email)
             VALUES (?, ?, ?, ?)",
        )
        .bind(import_id)
        .bind(row.line_no)
        .bind(&row.full_name)
        .bind(&row.email)
        .execute(&mut *tx)
        .await?;
    }
    let classified = classify(&mut tx, campus_id, rows).await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(preview_of(import_id, classified))))
}

/// The import must belong to this campus and still be a preview.
async fn open_import(conn: &mut SqliteConnection, campus_id: i64, import_id: i64) -> AppResult<()> {
    let status: Option<String> =
        sqlx::query_scalar("SELECT status FROM roster_imports WHERE id = ? AND campus_id = ?")
            .bind(import_id)
            .bind(campus_id)
            .fetch_optional(&mut *conn)
            .await?;
    match status.as_deref() {
        None => Err(AppError::NotFound),
        Some("preview") => Ok(()),
        Some(_) => Err(AppError::Conflict(
            "this import was already confirmed or discarded".into(),
        )),
    }
}

async fn close_import(conn: &mut SqliteConnection, import_id: i64, status: &str) -> AppResult<()> {
    sqlx::query("DELETE FROM roster_import_rows WHERE import_id = ?")
        .bind(import_id)
        .execute(&mut *conn)
        .await?;
    sqlx::query("UPDATE roster_imports SET status = ?, closed_at = datetime('now') WHERE id = ?")
        .bind(status)
        .bind(import_id)
        .execute(conn)
        .await?;
    Ok(())
}

#[derive(Serialize)]
struct InviteLink {
    user_id: i64,
    full_name: String,
    email: String,
    invite_url: String,
}

#[derive(Serialize)]
struct ConfirmResult {
    /// New accounts created.
    created: usize,
    /// Existing student accounts added to the campus.
    added_existing: usize,
    /// Flagged rows that were left out.
    skipped: usize,
    invites: Vec<InviteLink>,
}

async fn confirm(
    State(state): State<AppState>,
    user: CurrentUser,
    Path((campus_id, import_id)): Path<(i64, i64)>,
) -> AppResult<Json<ConfirmResult>> {
    let mut tx = begin_write(&state.db).await?;
    australis_core::require_campus(&mut tx, &user, campus_id, Access::Manage).await?;
    open_import(&mut tx, campus_id, import_id).await?;
    let rows = sqlx::query_as::<_, (i64, String, String)>(
        "SELECT line_no, full_name, email FROM roster_import_rows
         WHERE import_id = ? ORDER BY line_no, id",
    )
    .bind(import_id)
    .fetch_all(&mut *tx)
    .await?
    .into_iter()
    .map(|(line_no, full_name, email)| StoredRow {
        line_no,
        full_name,
        email,
    })
    .collect();

    let mut result = ConfirmResult {
        created: 0,
        added_existing: 0,
        skipped: 0,
        invites: Vec::new(),
    };
    for item in classify(&mut tx, campus_id, rows).await? {
        if !item.importable() {
            result.skipped += 1;
            continue;
        }
        let (account, is_new) = match item.account {
            Some(account) => (account, false),
            None => {
                let created = directory::create_user(
                    &mut tx,
                    NewUser {
                        email: &item.row.email,
                        full_name: &item.row.full_name,
                        role: Role::Student,
                        password_hash: None,
                    },
                )
                .await?;
                (created, true)
            }
        };
        directory::add_member(&mut tx, user.id, campus_id, account.id, MemberRole::Student).await?;
        if is_new {
            result.created += 1;
        } else {
            result.added_existing += 1;
        }
        // An account that never set a password gets a link; one that did signs in as usual.
        if !account.has_password {
            let token = directory::create_invite(
                &mut tx,
                user.id,
                account.id,
                state.config.invite_ttl_hours,
            )
            .await?;
            result.invites.push(InviteLink {
                user_id: account.id,
                full_name: account.full_name,
                email: account.email,
                invite_url: directory::invite_url(&state.config, &token),
            });
        }
    }
    close_import(&mut tx, import_id, "confirmed").await?;
    audit::record(
        &mut tx,
        AuditEntry {
            actor_id: Some(user.id),
            campus_id: Some(campus_id),
            entity: "roster.import",
            entity_id: import_id,
            subject_user_id: None,
            action: "confirm",
            before: None,
            after: Some(json!({
                "created": result.created,
                "added_existing": result.added_existing,
                "skipped": result.skipped,
            })),
            reason: None,
        },
    )
    .await?;
    tx.commit().await?;
    Ok(Json(result))
}

async fn discard(
    State(state): State<AppState>,
    user: CurrentUser,
    Path((campus_id, import_id)): Path<(i64, i64)>,
) -> AppResult<StatusCode> {
    let mut tx = begin_write(&state.db).await?;
    australis_core::require_campus(&mut tx, &user, campus_id, Access::Manage).await?;
    open_import(&mut tx, campus_id, import_id).await?;
    close_import(&mut tx, import_id, "discarded").await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

// --- members ------------------------------------------------------------------------------

async fn list_members(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(campus_id): Path<i64>,
) -> AppResult<Json<Vec<MemberDetail>>> {
    let mut conn = state.db.acquire().await?;
    australis_core::require_campus(&mut conn, &user, campus_id, Access::Manage).await?;
    Ok(Json(directory::list_members(&mut conn, campus_id).await?))
}

#[derive(Deserialize)]
struct ReasonBody {
    reason: String,
}

/// Students and guest teachers can be suspended here; the campus's professors cannot, and
/// nobody can suspend themselves.
async fn check_target(
    conn: &mut SqliteConnection,
    actor: &CurrentUser,
    campus_id: i64,
    target: i64,
) -> AppResult<()> {
    let member = directory::find_member(conn, campus_id, target)
        .await?
        .ok_or(AppError::NotFound)?;
    if member.role == MemberRole::Professor || target == actor.id {
        return Err(AppError::Unprocessable(
            "this member cannot be suspended here".into(),
        ));
    }
    Ok(())
}

async fn suspend(
    State(state): State<AppState>,
    user: CurrentUser,
    Path((campus_id, target)): Path<(i64, i64)>,
    Json(body): Json<ReasonBody>,
) -> AppResult<Json<directory::Member>> {
    let mut tx = begin_write(&state.db).await?;
    australis_core::require_campus(&mut tx, &user, campus_id, Access::Manage).await?;
    check_target(&mut tx, &user, campus_id, target).await?;
    let member =
        directory::suspend_member(&mut tx, user.id, campus_id, target, &body.reason).await?;
    tx.commit().await?;
    Ok(Json(member))
}

async fn reactivate(
    State(state): State<AppState>,
    user: CurrentUser,
    Path((campus_id, target)): Path<(i64, i64)>,
    Json(body): Json<ReasonBody>,
) -> AppResult<Json<directory::Member>> {
    let mut tx = begin_write(&state.db).await?;
    australis_core::require_campus(&mut tx, &user, campus_id, Access::Manage).await?;
    check_target(&mut tx, &user, campus_id, target).await?;
    let member =
        directory::reactivate_member(&mut tx, user.id, campus_id, target, &body.reason).await?;
    tx.commit().await?;
    Ok(Json(member))
}

/// Re-issues an invite link for a member whose account never set a password.
async fn reinvite(
    State(state): State<AppState>,
    user: CurrentUser,
    Path((campus_id, target)): Path<(i64, i64)>,
) -> AppResult<Json<serde_json::Value>> {
    let mut tx = begin_write(&state.db).await?;
    australis_core::require_campus(&mut tx, &user, campus_id, Access::Manage).await?;
    directory::find_member(&mut tx, campus_id, target)
        .await?
        .ok_or(AppError::NotFound)?;
    let token =
        directory::create_invite(&mut tx, user.id, target, state.config.invite_ttl_hours).await?;
    tx.commit().await?;
    Ok(Json(json!({
        "user_id": target,
        "invite_url": directory::invite_url(&state.config, &token),
    })))
}

#[derive(Deserialize)]
struct TeacherBody {
    email: String,
}

/// Adds an existing professor account to the campus as a guest teacher.
async fn add_teacher(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(campus_id): Path<i64>,
    Json(body): Json<TeacherBody>,
) -> AppResult<(StatusCode, Json<directory::Member>)> {
    let mut tx = begin_write(&state.db).await?;
    australis_core::require_campus(&mut tx, &user, campus_id, Access::Manage).await?;
    let account = directory::find_user_by_email(&mut tx, &body.email)
        .await?
        .ok_or(AppError::NotFound)?;
    if account.role != Role::Professor {
        return Err(AppError::Unprocessable(
            "only a professor account can be added as a guest teacher".into(),
        ));
    }
    let member =
        directory::add_member(&mut tx, user.id, campus_id, account.id, MemberRole::Guest).await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(member)))
}
