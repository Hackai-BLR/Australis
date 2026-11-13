//! Gradebook: items, scores with fast bulk entry, finals computed on read, and an audit
//! trail. The grading scale and the final rule come from core settings. No operation of
//! this module is reachable from the AI.

use std::collections::HashMap;

use australis_core::{
    access::{require_campus, Access},
    audit::{self, AuditEntry, AuditQuery, AuditRecord},
    begin_write,
    directory::{self, MemberRole, MemberStatus},
    settings::{self, GradingScale},
    AppError, AppResult, AppState, CurrentUser,
};
use axum::{
    body::Bytes,
    extract::{Path, State},
    routing::{get, patch, post, put},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::SqliteConnection;

mod submission;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/campuses/{id}/gradebook", get(gradebook))
        .route("/campuses/{id}/gradebook/items", post(create_item))
        .route("/campuses/{id}/gradebook/entries", put(put_entries))
        .route("/campuses/{id}/gradebook/audit", get(audit_list))
        .route("/gradebook/items/{iid}", patch(update_item))
        .route("/gradebook/items/{iid}/archive", post(archive_item))
        .route("/grades/mine", get(mine))
        .merge(submission::router())
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
struct Item {
    id: i64,
    campus_id: i64,
    title: String,
    weight: f64,
    position: i64,
    archived_at: Option<String>,
}

const ITEM_SELECT: &str =
    "SELECT id, campus_id, title, weight, position, archived_at FROM grades_items";

#[derive(Serialize)]
struct StudentRow {
    user_id: i64,
    full_name: String,
    email: String,
    suspended: bool,
}

#[derive(Serialize, sqlx::FromRow)]
struct Entry {
    item_id: i64,
    student_id: i64,
    score: Option<f64>,
}

#[derive(Serialize)]
struct Final {
    student_id: i64,
    #[serde(rename = "final")]
    value: Option<f64>,
}

/// The final-grade rule. Only the weighted mean exists; any other configured kind is a
/// configuration error rather than a silent fallback.
///
/// Items without a score are left out of the mean (the final is provisional until every
/// item is graded). Returns `None` when nothing is graded yet.
fn compute_final(kind: &str, scored: &[(f64, f64)]) -> AppResult<Option<f64>> {
    if kind != "weighted_mean" {
        return Err(AppError::Internal(format!("unknown final rule {kind}")));
    }
    let total: f64 = scored.iter().map(|(_, weight)| weight).sum();
    if scored.is_empty() || total <= 0.0 {
        return Ok(None);
    }
    let sum: f64 = scored.iter().map(|(score, weight)| score * weight).sum();
    Ok(Some((sum / total * 100.0).round() / 100.0))
}

async fn items_of(conn: &mut SqliteConnection, campus_id: i64) -> AppResult<Vec<Item>> {
    Ok(sqlx::query_as::<_, Item>(&format!(
        "{ITEM_SELECT} WHERE campus_id = ? ORDER BY archived_at IS NOT NULL, position, id"
    ))
    .bind(campus_id)
    .fetch_all(conn)
    .await?)
}

async fn find_item(conn: &mut SqliteConnection, item_id: i64) -> AppResult<Item> {
    sqlx::query_as::<_, Item>(&format!("{ITEM_SELECT} WHERE id = ?"))
        .bind(item_id)
        .fetch_optional(conn)
        .await?
        .ok_or(AppError::NotFound)
}

fn clean_reason(reason: &Option<String>) -> Option<String> {
    reason
        .as_deref()
        .map(australis_core::audit::trim_reason)
        .filter(|r| !r.is_empty())
        .map(str::to_string)
}

/// A change to an item moves every student's final, so once the item has any score the
/// change must carry a reason. Returns the cleaned reason.
async fn item_change_reason(
    conn: &mut SqliteConnection,
    item_id: i64,
    reason: &Option<String>,
) -> AppResult<Option<String>> {
    let reason = clean_reason(reason);
    if reason.is_none() {
        let graded: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM grades_entries WHERE item_id = ? AND score IS NOT NULL",
        )
        .bind(item_id)
        .fetch_one(conn)
        .await?;
        if graded > 0 {
            return Err(AppError::Unprocessable(
                "a reason is required to change an item that already has grades".into(),
            ));
        }
    }
    Ok(reason)
}

// --- GET gradebook ----------------------------------------------------------------------

async fn gradebook(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(campus_id): Path<i64>,
) -> AppResult<Json<Value>> {
    let mut conn = state.db.acquire().await?;
    require_campus(&mut conn, &user, campus_id, Access::Teach).await?;
    let scale = settings::grading_scale(&mut conn, campus_id).await?;
    let rule = settings::final_rule(&mut conn, campus_id).await?;
    let items = items_of(&mut conn, campus_id).await?;
    let students: Vec<StudentRow> = directory::list_members(&mut conn, campus_id)
        .await?
        .into_iter()
        .filter(|m| m.role == MemberRole::Student)
        .map(|m| StudentRow {
            user_id: m.user_id,
            full_name: m.full_name,
            email: m.email,
            suspended: m.status == MemberStatus::Suspended,
        })
        .collect();
    let entries = sqlx::query_as::<_, Entry>(
        "SELECT e.item_id, e.student_id, e.score FROM grades_entries e
         JOIN grades_items i ON i.id = e.item_id WHERE i.campus_id = ?",
    )
    .bind(campus_id)
    .fetch_all(&mut *conn)
    .await?;

    let active: HashMap<i64, f64> = items
        .iter()
        .filter(|i| i.archived_at.is_none())
        .map(|i| (i.id, i.weight))
        .collect();
    let mut scored: HashMap<i64, Vec<(f64, f64)>> = HashMap::new();
    for e in &entries {
        if let (Some(weight), Some(score)) = (active.get(&e.item_id), e.score) {
            scored
                .entry(e.student_id)
                .or_default()
                .push((score, *weight));
        }
    }
    let mut finals = Vec::new();
    for s in &students {
        let list = scored.get(&s.user_id).map(Vec::as_slice).unwrap_or(&[]);
        finals.push(Final {
            student_id: s.user_id,
            value: compute_final(&rule.kind, list)?,
        });
    }
    Ok(Json(json!({
        "items": items,
        "students": students,
        "entries": entries,
        "finals": finals,
        "scale": scale,
        "final_rule": rule,
    })))
}

// --- items ------------------------------------------------------------------------------

fn clean_title(raw: &str) -> AppResult<String> {
    let title = raw.trim();
    if title.is_empty() || title.chars().count() > 120 {
        return Err(AppError::Unprocessable(
            "the title must have between 1 and 120 characters".into(),
        ));
    }
    Ok(title.to_string())
}

fn check_weight(weight: f64) -> AppResult<f64> {
    if !weight.is_finite() || !(0.0..=1000.0).contains(&weight) {
        return Err(AppError::Unprocessable(
            "the weight must be a number between 0 and 1000".into(),
        ));
    }
    Ok(weight)
}

fn item_json(item: &Item) -> Value {
    json!({
        "title": item.title,
        "weight": item.weight,
        "position": item.position,
        "archived": item.archived_at.is_some(),
    })
}

#[derive(Deserialize)]
struct NewItem {
    title: String,
    weight: Option<f64>,
    reason: Option<String>,
}

async fn create_item(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(campus_id): Path<i64>,
    Json(body): Json<NewItem>,
) -> AppResult<Json<Item>> {
    let title = clean_title(&body.title)?;
    let weight = check_weight(body.weight.unwrap_or(1.0))?;
    let mut tx = begin_write(&state.db).await?;
    require_campus(&mut tx, &user, campus_id, Access::Teach).await?;
    let id = sqlx::query(
        "INSERT INTO grades_items (campus_id, title, weight, position)
         VALUES (?1, ?2, ?3,
            (SELECT COALESCE(MAX(position), 0) + 1 FROM grades_items WHERE campus_id = ?1))",
    )
    .bind(campus_id)
    .bind(&title)
    .bind(weight)
    .execute(&mut *tx)
    .await?
    .last_insert_rowid();
    let item = find_item(&mut tx, id).await?;
    submission::reset_after_edit(&mut tx, &user, campus_id).await?;
    audit::record(
        &mut tx,
        AuditEntry {
            actor_id: Some(user.id),
            campus_id: Some(campus_id),
            entity: "grades.item",
            entity_id: id,
            subject_user_id: None,
            action: "create",
            before: None,
            after: Some(item_json(&item)),
            reason: clean_reason(&body.reason).as_deref(),
        },
    )
    .await?;
    tx.commit().await?;
    Ok(Json(item))
}

#[derive(Deserialize)]
struct ItemPatch {
    title: Option<String>,
    weight: Option<f64>,
    position: Option<i64>,
    reason: Option<String>,
}

async fn update_item(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(item_id): Path<i64>,
    Json(body): Json<ItemPatch>,
) -> AppResult<Json<Item>> {
    let mut tx = begin_write(&state.db).await?;
    let before = find_item(&mut tx, item_id).await?;
    require_campus(&mut tx, &user, before.campus_id, Access::Teach).await?;
    if before.archived_at.is_some() {
        return Err(AppError::Conflict("the item is archived".into()));
    }
    let title = match &body.title {
        Some(t) => clean_title(t)?,
        None => before.title.clone(),
    };
    let weight = match body.weight {
        Some(w) => check_weight(w)?,
        None => before.weight,
    };
    let position = body.position.unwrap_or(before.position);
    let reason = item_change_reason(&mut tx, item_id, &body.reason).await?;
    sqlx::query("UPDATE grades_items SET title = ?, weight = ?, position = ? WHERE id = ?")
        .bind(&title)
        .bind(weight)
        .bind(position)
        .bind(item_id)
        .execute(&mut *tx)
        .await?;
    let after = find_item(&mut tx, item_id).await?;
    submission::reset_after_edit(&mut tx, &user, before.campus_id).await?;
    audit::record(
        &mut tx,
        AuditEntry {
            actor_id: Some(user.id),
            campus_id: Some(before.campus_id),
            entity: "grades.item",
            entity_id: item_id,
            subject_user_id: None,
            action: "update",
            before: Some(item_json(&before)),
            after: Some(item_json(&after)),
            reason: reason.as_deref(),
        },
    )
    .await?;
    tx.commit().await?;
    Ok(Json(after))
}

#[derive(Deserialize, Default)]
struct ArchiveBody {
    reason: Option<String>,
}

async fn archive_item(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(item_id): Path<i64>,
    raw: Bytes,
) -> AppResult<Json<Item>> {
    // The body is optional: an empty or missing one means no reason.
    let body: ArchiveBody = if raw.iter().all(u8::is_ascii_whitespace) {
        ArchiveBody::default()
    } else {
        serde_json::from_slice::<Option<ArchiveBody>>(&raw)
            .map_err(|_| AppError::Unprocessable("the body is not valid JSON".into()))?
            .unwrap_or_default()
    };
    let mut tx = begin_write(&state.db).await?;
    let before = find_item(&mut tx, item_id).await?;
    require_campus(&mut tx, &user, before.campus_id, Access::Teach).await?;
    if before.archived_at.is_some() {
        return Ok(Json(before));
    }
    let reason = item_change_reason(&mut tx, item_id, &body.reason).await?;
    sqlx::query("UPDATE grades_items SET archived_at = datetime('now') WHERE id = ?")
        .bind(item_id)
        .execute(&mut *tx)
        .await?;
    let after = find_item(&mut tx, item_id).await?;
    submission::reset_after_edit(&mut tx, &user, before.campus_id).await?;
    audit::record(
        &mut tx,
        AuditEntry {
            actor_id: Some(user.id),
            campus_id: Some(before.campus_id),
            entity: "grades.item",
            entity_id: item_id,
            subject_user_id: None,
            action: "archive",
            before: Some(item_json(&before)),
            after: Some(item_json(&after)),
            reason: reason.as_deref(),
        },
    )
    .await?;
    tx.commit().await?;
    Ok(Json(after))
}

// --- PUT entries ------------------------------------------------------------------------

#[derive(Deserialize)]
struct EntryChange {
    item_id: i64,
    student_id: i64,
    score: Option<f64>,
}

#[derive(Deserialize)]
struct EntriesBody {
    entries: Vec<EntryChange>,
    reason: Option<String>,
}

async fn put_entries(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(campus_id): Path<i64>,
    Json(body): Json<EntriesBody>,
) -> AppResult<Json<Value>> {
    if body.entries.len() > 5000 {
        return Err(AppError::Unprocessable(
            "too many entries in one save".into(),
        ));
    }
    let reason = clean_reason(&body.reason);
    let mut tx = begin_write(&state.db).await?;
    require_campus(&mut tx, &user, campus_id, Access::Teach).await?;
    let scale: GradingScale = settings::grading_scale(&mut tx, campus_id).await?;

    let items: HashMap<i64, Item> = items_of(&mut tx, campus_id)
        .await?
        .into_iter()
        .map(|i| (i.id, i))
        .collect();
    let students: HashMap<i64, bool> = directory::list_members(&mut tx, campus_id)
        .await?
        .into_iter()
        .filter(|m| m.role == MemberRole::Student)
        .map(|m| (m.user_id, m.status == MemberStatus::Suspended))
        .collect();

    // Validate everything first, so a bad row changes nothing.
    for change in &body.entries {
        match items.get(&change.item_id) {
            None => {
                return Err(AppError::Unprocessable(
                    "an item does not belong to this campus".into(),
                ))
            }
            Some(item) if item.archived_at.is_some() => {
                return Err(AppError::Unprocessable("an item is archived".into()))
            }
            _ => {}
        }
        if !students.contains_key(&change.student_id) {
            return Err(AppError::Unprocessable(
                "a student is not a member of this campus".into(),
            ));
        }
        if let Some(score) = change.score {
            if !score.is_finite() || !scale.contains(score) {
                return Err(AppError::Unprocessable(format!(
                    "a score is outside the scale ({} to {})",
                    scale.min, scale.max
                )));
            }
        }
    }

    // Later rows for the same cell win.
    let mut latest: Vec<&EntryChange> = Vec::new();
    let mut seen: HashMap<(i64, i64), usize> = HashMap::new();
    for change in &body.entries {
        match seen.get(&(change.item_id, change.student_id)) {
            Some(&at) => latest[at] = change,
            None => {
                seen.insert((change.item_id, change.student_id), latest.len());
                latest.push(change);
            }
        }
    }

    let mut changes = Vec::new();
    let mut overwrites = false;
    for change in latest {
        let existing: Option<Option<f64>> = sqlx::query_scalar(
            "SELECT score FROM grades_entries WHERE item_id = ? AND student_id = ?",
        )
        .bind(change.item_id)
        .bind(change.student_id)
        .fetch_optional(&mut *tx)
        .await?;
        let before = existing.flatten();
        if before == change.score {
            continue;
        }
        if before.is_some() {
            overwrites = true;
        }
        if students.get(&change.student_id) == Some(&true) {
            return Err(AppError::Unprocessable(
                "un estudiante suspendido no puede recibir calificaciones nuevas".into(),
            ));
        }
        changes.push((change, before));
    }
    if overwrites && reason.is_none() {
        return Err(AppError::Unprocessable(
            "a reason is required when the save overwrites existing scores".into(),
        ));
    }

    for (change, before) in &changes {
        sqlx::query(
            "INSERT INTO grades_entries (item_id, student_id, score, updated_at, updated_by)
             VALUES (?1, ?2, ?3, datetime('now'), ?4)
             ON CONFLICT (item_id, student_id) DO UPDATE SET
                score = excluded.score, updated_at = excluded.updated_at,
                updated_by = excluded.updated_by",
        )
        .bind(change.item_id)
        .bind(change.student_id)
        .bind(change.score)
        .bind(user.id)
        .execute(&mut *tx)
        .await?;
        let action = match (before, change.score) {
            (None, _) => "set",
            (Some(_), None) => "clear",
            (Some(_), Some(_)) => "update",
        };
        audit::record(
            &mut tx,
            AuditEntry {
                actor_id: Some(user.id),
                campus_id: Some(campus_id),
                entity: "grades.entry",
                entity_id: change.item_id,
                subject_user_id: Some(change.student_id),
                action,
                before: Some(json!({ "score": before })),
                after: Some(json!({ "score": change.score })),
                reason: reason.as_deref(),
            },
        )
        .await?;
    }
    if !changes.is_empty() {
        submission::reset_after_edit(&mut tx, &user, campus_id).await?;
    }
    tx.commit().await?;
    Ok(Json(json!({ "changed": changes.len() })))
}

// --- audit ------------------------------------------------------------------------------

async fn audit_list(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(campus_id): Path<i64>,
) -> AppResult<Json<Vec<AuditRecord>>> {
    let mut conn = state.db.acquire().await?;
    require_campus(&mut conn, &user, campus_id, Access::Teach).await?;
    let rows = audit::list(
        &mut conn,
        AuditQuery {
            campus_id: Some(campus_id),
            entity_prefix: Some("grades."),
            limit: Some(500),
            ..Default::default()
        },
    )
    .await?;
    Ok(Json(rows))
}

// --- student view -----------------------------------------------------------------------

#[derive(sqlx::FromRow)]
struct MineRow {
    item_id: i64,
    title: String,
    weight: f64,
    score: Option<f64>,
}

async fn mine(State(state): State<AppState>, user: CurrentUser) -> AppResult<Json<Value>> {
    let mut conn = state.db.acquire().await?;
    // The scale of each course is its own (a campus may override it). There is no top-level
    // scale: a screen must read `courses[].scale`.
    let campuses = directory::campuses_for_user(&mut conn, &user).await?;
    let mut courses = Vec::new();
    for campus in campuses
        .into_iter()
        .filter(|c| c.member_role == Some(MemberRole::Student))
    {
        let scale = settings::grading_scale(&mut conn, campus.id).await?;
        let rule = settings::final_rule(&mut conn, campus.id).await?;
        let rows = sqlx::query_as::<_, MineRow>(
            "SELECT i.id AS item_id, i.title, i.weight, e.score
             FROM grades_items i
             LEFT JOIN grades_entries e ON e.item_id = i.id AND e.student_id = ?
             WHERE i.campus_id = ? AND i.archived_at IS NULL
             ORDER BY i.position, i.id",
        )
        .bind(user.id)
        .bind(campus.id)
        .fetch_all(&mut *conn)
        .await?;
        let scored: Vec<(f64, f64)> = rows
            .iter()
            .filter_map(|r| r.score.map(|s| (s, r.weight)))
            .collect();
        courses.push(json!({
            "campus_id": campus.id,
            "campus_name": campus.name,
            "final": compute_final(&rule.kind, &scored)?,
            "scale": scale,
            "items": rows.iter().map(|r| json!({
                "item_id": r.item_id, "title": r.title, "weight": r.weight, "score": r.score,
            })).collect::<Vec<_>>(),
        }));
    }
    Ok(Json(json!({ "courses": courses })))
}
