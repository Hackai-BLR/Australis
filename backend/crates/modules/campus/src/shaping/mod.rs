//! AI shaping: the professor describes a change, the AI proposes it as operations, the
//! professor previews the result and accepts or rejects it.
//!
//! - `POST /campuses/{id}/ai/proposals` asks the AI. It stores a pending proposal (operations,
//!   the document they produce, the list of changes) and does not touch the campus.
//! - `POST .../{pid}/accept` saves the previewed document through [`crate::save_document`] in
//!   one transaction (a revision with `via = ai`). If the campus moved on since the proposal
//!   was made, the proposal becomes stale and the answer is 409.
//! - `POST .../{pid}/reject` closes the proposal without changing anything.
//!
//! The AI is offered eight tools (see [`ops`]) that edit the campus document and nothing
//! else. Grades, attendance, members and every other table are out of reach by construction.
//! Every provider call goes through `australis_core::ai::run`, so it consumes quota and
//! writes the usage log.

use std::time::Duration;

use australis_core::{
    ai::{self, AiRequest, UsageQuery, FEATURE_SHAPING},
    begin_write, directory, require_campus, settings, Access, AppError, AppResult, AppState,
    CurrentUser,
};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::SqliteConnection;
use tokio::time::Instant;

use crate::{
    document::{Block, Document},
    get_document, save_document, view, CampusView, SaveMeta, Via,
};

pub mod ops;

use ops::{apply_ops, Op};

/// The provider is asked at most this many times per proposal (the first answer plus
/// corrections after tool errors).
pub const MAX_ITERATIONS: usize = 4;
/// Time budget of one proposal.
pub const DEADLINE: Duration = Duration::from_secs(60);
const MAX_INSTRUCTION_CHARS: usize = 1_000;
const HISTORY_LIMIT: i64 = 50;

const SYSTEM_PROMPT: &str = "You help a professor shape a university campus page. The campus \
is a list of sections, each with blocks. Propose changes only by calling the tools you are \
given. Never change grades, attendance, students or anything outside the campus content: if \
asked to, make no tool call and say you cannot. The professor reviews every change before it \
is applied.";

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/campuses/{id}/ai/proposals",
            get(list_proposals).post(create_proposal),
        )
        .route("/campuses/{id}/ai/proposals/{pid}/accept", post(accept))
        .route("/campuses/{id}/ai/proposals/{pid}/reject", post(reject))
        .route("/campuses/{id}/ai/usage", get(usage))
}

// --- proposals --------------------------------------------------------------------------------

#[derive(sqlx::FromRow)]
struct Row {
    id: i64,
    user_id: i64,
    instruction: String,
    status: String,
    message: String,
    base_version: i64,
    ops_json: String,
    changes_json: String,
    preview_json: String,
    simulated: bool,
    revision_version: Option<i64>,
    created_at: String,
    decided_at: Option<String>,
}

const COLUMNS: &str = "id, user_id, instruction, status, message, base_version, ops_json, \
    changes_json, preview_json, simulated, revision_version, created_at, decided_at";

#[derive(Debug, Serialize)]
struct Proposal {
    id: i64,
    user_id: i64,
    user_name: Option<String>,
    instruction: String,
    /// pending, empty, accepted, rejected or stale.
    status: String,
    /// What the AI said.
    message: String,
    base_version: i64,
    ops: Value,
    /// One line per operation, in Spanish, for the professor to review.
    changes: Vec<String>,
    /// The campus as it would be after accepting. Only sent while the proposal is pending.
    preview: Option<Document>,
    /// True when the AI is the placeholder: the screens show "Simulado".
    simulated: bool,
    revision_version: Option<i64>,
    created_at: String,
    decided_at: Option<String>,
}

fn corrupt(what: &str, err: serde_json::Error) -> AppError {
    AppError::Internal(format!("stored proposal {what}: {err}"))
}

async fn to_proposal(conn: &mut SqliteConnection, row: Row) -> AppResult<Proposal> {
    let preview = if row.status == "pending" {
        Some(serde_json::from_str(&row.preview_json).map_err(|e| corrupt("preview", e))?)
    } else {
        None
    };
    Ok(Proposal {
        user_name: directory::find_user(conn, row.user_id)
            .await?
            .map(|user| user.full_name),
        id: row.id,
        user_id: row.user_id,
        instruction: row.instruction,
        status: row.status,
        message: row.message,
        base_version: row.base_version,
        ops: serde_json::from_str(&row.ops_json).map_err(|e| corrupt("ops", e))?,
        changes: serde_json::from_str(&row.changes_json).map_err(|e| corrupt("changes", e))?,
        preview,
        simulated: row.simulated,
        revision_version: row.revision_version,
        created_at: row.created_at,
        decided_at: row.decided_at,
    })
}

async fn load_row(conn: &mut SqliteConnection, campus_id: i64, id: i64) -> AppResult<Row> {
    sqlx::query_as::<_, Row>(&format!(
        "SELECT {COLUMNS} FROM campus_ai_proposals WHERE id = ? AND campus_id = ?"
    ))
    .bind(id)
    .bind(campus_id)
    .fetch_optional(conn)
    .await?
    .ok_or(AppError::NotFound)
}

async fn list_proposals(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<i64>,
) -> AppResult<Json<Vec<Proposal>>> {
    let mut conn = state.db.acquire().await?;
    require_campus(&mut conn, &user, id, Access::Manage).await?;
    let rows = sqlx::query_as::<_, Row>(&format!(
        "SELECT {COLUMNS} FROM campus_ai_proposals WHERE campus_id = ? ORDER BY id DESC LIMIT ?"
    ))
    .bind(id)
    .bind(HISTORY_LIMIT)
    .fetch_all(&mut *conn)
    .await?;
    let mut proposals = Vec::with_capacity(rows.len());
    for row in rows {
        proposals.push(to_proposal(&mut conn, row).await?);
    }
    Ok(Json(proposals))
}

#[derive(Deserialize)]
struct CreateProposal {
    instruction: String,
}

/// The campus as text for the model: ids included, so it can refer to sections and blocks.
fn describe_document(doc: &Document) -> String {
    let mut out = String::new();
    for section in &doc.sections {
        out.push_str(&format!(
            "section id={} title={:?} kind={:?} visible={}\n",
            section.id, section.title, section.kind, section.visible
        ));
        for block in &section.blocks {
            let line = match block {
                Block::Text { id, text } => format!("text id={id} {text:?}"),
                Block::Callout { id, text } => format!("callout id={id} {text:?}"),
                Block::Link { id, label, url } => format!("link id={id} {label:?} {url}"),
                Block::Checklist { id, items } => format!("checklist id={id} {items:?}"),
                Block::Widget { id, widget } => format!("widget id={id} {widget:?}"),
            };
            out.push_str("  ");
            out.push_str(&line);
            out.push('\n');
        }
    }
    out
}

/// What the loop produced.
struct Generated {
    ops: Vec<Op>,
    changes: Vec<String>,
    preview: Document,
    message: String,
    usage_id: i64,
    simulated: bool,
}

/// Asks the provider for operations, validating each one. Operations that fail go back as
/// tool errors for another attempt (at most [`MAX_ITERATIONS`] and within [`DEADLINE`]); every
/// attempt starts again from the current campus, so a model that repeats its whole answer
/// never duplicates anything. No database connection is held while the provider works.
async fn generate(
    state: &AppState,
    user_id: i64,
    campus_id: i64,
    doc: &Document,
    instruction: &str,
) -> AppResult<Generated> {
    let deadline = Instant::now() + DEADLINE;
    let context = describe_document(doc);
    let mut feedback: Vec<String> = Vec::new();
    let mut last: Option<Generated> = None;

    for iteration in 0..MAX_ITERATIONS {
        let request = AiRequest {
            feature: FEATURE_SHAPING.into(),
            system: SYSTEM_PROMPT.into(),
            context: context.clone(),
            instruction: instruction.into(),
            tools: ops::tools(),
            feedback: feedback.clone(),
        };
        let remaining = deadline.saturating_duration_since(Instant::now());
        let outcome = match tokio::time::timeout(
            remaining,
            ai::run(state, user_id, Some(campus_id), &request),
        )
        .await
        {
            Ok(Ok(outcome)) => outcome,
            // The first call failing is the request failing (429, provider error). A later
            // failure only stops the corrections; the previous attempt stands.
            Ok(Err(err)) if iteration == 0 => return Err(err),
            Err(_) if iteration == 0 => {
                return Err(AppError::Internal("the AI provider timed out".into()))
            }
            _ => break,
        };

        let mut accepted: Vec<Op> = Vec::new();
        let mut errors: Vec<String> = Vec::new();
        for call in &outcome.reply.tool_calls {
            let op = match Op::from_call(&call.name, &call.input) {
                Ok(op) => op,
                Err(e) => {
                    errors.push(format!("{}: {e}", call.name));
                    continue;
                }
            };
            accepted.push(op);
            if let Err(e) = apply_ops(doc, &accepted) {
                accepted.pop();
                errors.push(format!("{}: {e}", call.name));
            }
        }
        let (preview, changes) = apply_ops(doc, &accepted)
            .map_err(|e| AppError::Internal(format!("re-applying checked operations: {e}")))?;
        let mut message = outcome.reply.text.clone();
        if !errors.is_empty() {
            message.push_str(&format!(
                " (Se descartaron {} operación(es) inválida(s).)",
                errors.len()
            ));
        }
        last = Some(Generated {
            ops: accepted,
            changes,
            preview,
            message,
            usage_id: outcome.usage_id,
            simulated: outcome.simulated,
        });
        if errors.is_empty() || Instant::now() >= deadline {
            break;
        }
        feedback = errors;
    }
    last.ok_or_else(|| AppError::Internal("the AI produced no attempt".into()))
}

async fn create_proposal(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<i64>,
    Json(body): Json<CreateProposal>,
) -> AppResult<(StatusCode, Json<Proposal>)> {
    let instruction = body.instruction.trim().to_string();
    if instruction.is_empty() {
        return Err(AppError::Unprocessable(
            "write what you want to change".into(),
        ));
    }
    if instruction.chars().count() > MAX_INSTRUCTION_CHARS {
        return Err(AppError::Unprocessable(format!(
            "the instruction is longer than {MAX_INSTRUCTION_CHARS} characters"
        )));
    }
    let stored = {
        let mut conn = state.db.acquire().await?;
        require_campus(&mut conn, &user, id, Access::Manage).await?;
        get_document(&mut conn, id)
            .await?
            .ok_or(AppError::NotFound)?
    };

    let generated = generate(&state, user.id, id, &stored.document, &instruction).await?;

    let status = if generated.ops.is_empty() {
        "empty"
    } else {
        "pending"
    };
    let ops_json = to_json(&generated.ops)?;
    let changes_json = to_json(&generated.changes)?;
    let preview_json = to_json(&generated.preview)?;
    let mut tx = begin_write(&state.db).await?;
    let proposal_id = sqlx::query(
        "INSERT INTO campus_ai_proposals
            (campus_id, user_id, instruction, status, message, base_version, ops_json,
             changes_json, preview_json, simulated, usage_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(id)
    .bind(user.id)
    .bind(&instruction)
    .bind(status)
    .bind(&generated.message)
    .bind(stored.version)
    .bind(&ops_json)
    .bind(&changes_json)
    .bind(&preview_json)
    .bind(generated.simulated)
    .bind(generated.usage_id)
    .execute(&mut *tx)
    .await?
    .last_insert_rowid();
    let row = load_row(&mut tx, id, proposal_id).await?;
    let proposal = to_proposal(&mut tx, row).await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(proposal)))
}

fn to_json<T: Serialize>(value: &T) -> AppResult<String> {
    serde_json::to_string(value).map_err(|e| AppError::Internal(e.to_string()))
}

/// The revision summary: the professor's instruction on one line, cut to fit.
fn revision_summary(instruction: &str) -> String {
    let flat: String = instruction
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let flat = flat.split_whitespace().collect::<Vec<_>>().join(" ");
    let short: String = flat.chars().take(200).collect();
    format!("IA: {short}")
}

async fn accept(
    State(state): State<AppState>,
    user: CurrentUser,
    Path((id, pid)): Path<(i64, i64)>,
) -> AppResult<Json<CampusView>> {
    let mut tx = begin_write(&state.db).await?;
    let access = require_campus(&mut tx, &user, id, Access::Manage).await?;
    let row = load_row(&mut tx, id, pid).await?;
    match row.status.as_str() {
        "pending" => {}
        "empty" => {
            return Err(AppError::Conflict(
                "this proposal has no changes to apply".into(),
            ))
        }
        other => {
            return Err(AppError::Conflict(format!(
                "this proposal was already decided ({other})"
            )))
        }
    }
    let current = get_document(&mut tx, id).await?.ok_or(AppError::NotFound)?;
    if current.version != row.base_version {
        sqlx::query(
            "UPDATE campus_ai_proposals
             SET status = 'stale', decided_by = ?, decided_at = datetime('now') WHERE id = ?",
        )
        .bind(user.id)
        .bind(pid)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        return Err(AppError::Conflict(
            "the campus changed after this proposal was made; ask for it again".into(),
        ));
    }
    let preview: Document =
        serde_json::from_str(&row.preview_json).map_err(|e| corrupt("preview", e))?;
    let saved = save_document(
        &mut tx,
        id,
        row.base_version,
        preview,
        SaveMeta {
            user_id: user.id,
            via: Via::Ai,
            summary: &revision_summary(&row.instruction),
            proposal_id: Some(pid),
        },
    )
    .await?;
    sqlx::query(
        "UPDATE campus_ai_proposals
         SET status = 'accepted', decided_by = ?, decided_at = datetime('now'),
             revision_version = ?
         WHERE id = ?",
    )
    .bind(user.id)
    .bind(saved.version)
    .bind(pid)
    .execute(&mut *tx)
    .await?;
    // Other open proposals were made on the old version.
    sqlx::query(
        "UPDATE campus_ai_proposals
         SET status = 'stale', decided_at = datetime('now')
         WHERE campus_id = ? AND status = 'pending' AND id != ?",
    )
    .bind(id)
    .bind(pid)
    .execute(&mut *tx)
    .await?;
    let campus = view(&mut tx, &access, id).await?;
    tx.commit().await?;
    Ok(Json(campus))
}

async fn reject(
    State(state): State<AppState>,
    user: CurrentUser,
    Path((id, pid)): Path<(i64, i64)>,
) -> AppResult<Json<Proposal>> {
    let mut tx = begin_write(&state.db).await?;
    require_campus(&mut tx, &user, id, Access::Manage).await?;
    let row = load_row(&mut tx, id, pid).await?;
    if row.status != "pending" {
        return Err(AppError::Conflict(format!(
            "this proposal cannot be rejected ({})",
            row.status
        )));
    }
    sqlx::query(
        "UPDATE campus_ai_proposals
         SET status = 'rejected', decided_by = ?, decided_at = datetime('now') WHERE id = ?",
    )
    .bind(user.id)
    .bind(pid)
    .execute(&mut *tx)
    .await?;
    let row = load_row(&mut tx, id, pid).await?;
    let proposal = to_proposal(&mut tx, row).await?;
    tx.commit().await?;
    Ok(Json(proposal))
}

// --- usage ------------------------------------------------------------------------------------

#[derive(Serialize)]
struct Usage {
    /// Calls the caller made today (the quota counter).
    used_today: i64,
    quota: i64,
    remaining: i64,
    /// Provider calls logged for this campus by the caller, and their tokens.
    logged_calls: i64,
    input_tokens: i64,
    output_tokens: i64,
    /// What those tokens would cost with a real provider. It is an estimate from the prices
    /// in the settings; the placeholder provider costs nothing.
    estimated_cost_usd: f64,
    cost_is_estimate: bool,
    simulated: bool,
}

/// A price setting (USD per million tokens); a missing one counts as 0.
async fn price(conn: &mut SqliteConnection, key: &str) -> AppResult<f64> {
    let value = settings::get_value(conn, key).await?;
    Ok(value.and_then(|v| v.as_f64()).unwrap_or(0.0))
}

async fn usage(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<i64>,
) -> AppResult<Json<Usage>> {
    let mut conn = state.db.acquire().await?;
    require_campus(&mut conn, &user, id, Access::Manage).await?;
    let quota = ai::quota_status(&mut conn, user.id, FEATURE_SHAPING).await?;
    let records = ai::list_usage(
        &mut conn,
        UsageQuery {
            user_id: Some(user.id),
            campus_id: Some(id),
            feature: Some(FEATURE_SHAPING),
            limit: Some(1000),
        },
    )
    .await?;
    let counted = || records.iter().filter(|r| r.status == ai::UsageStatus::Ok);
    let input_tokens: i64 = counted().map(|r| r.input_tokens).sum();
    let output_tokens: i64 = counted().map(|r| r.output_tokens).sum();
    let price_in = price(&mut conn, "ai.shaping.price_input_usd_per_mtok").await?;
    let price_out = price(&mut conn, "ai.shaping.price_output_usd_per_mtok").await?;
    Ok(Json(Usage {
        used_today: quota.used,
        quota: quota.limit,
        remaining: quota.remaining,
        logged_calls: counted().count() as i64,
        input_tokens,
        output_tokens,
        estimated_cost_usd: (input_tokens as f64 * price_in + output_tokens as f64 * price_out)
            / 1_000_000.0,
        cost_is_estimate: true,
        simulated: state.ai.is_placeholder(),
    }))
}
