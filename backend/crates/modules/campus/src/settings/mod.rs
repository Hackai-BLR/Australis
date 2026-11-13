//! Settings per campus: a campus may override the grading scale, the final-grade rule and
//! the attendance rule. A value without an override is inherited from the global setting.
//!
//! Overrides live in `core_settings` (scope `campus:<id>`) and are written and audited
//! through `australis_core::settings`, so the gradebook and attendance read the same value
//! this screen shows. Only Manage access may read or write.

use australis_core::{
    audit::{self, AuditQuery},
    begin_write, require_campus, settings, Access, AppError, AppResult, AppState, CurrentUser,
};
use axum::{
    extract::{Path, State},
    routing::{get, post, put},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::SqliteConnection;

const KEYS: [&str; 3] = [
    settings::GRADING_SCALE,
    settings::GRADING_FINAL_RULE,
    settings::ATTENDANCE_RULE,
];
const AUDIT_ENTITY: &str = "campus.setting";
const MAX_REASON_CHARS: usize = 500;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/campuses/{id}/settings", get(overview))
        .route("/campuses/{id}/settings/{key}", put(set_override))
        .route("/campuses/{id}/settings/{key}/reset", post(reset))
}

#[derive(Debug, Serialize)]
struct Entry {
    key: &'static str,
    /// The value in force for this campus.
    value: Value,
    /// `campus` when overridden, `global` when inherited.
    source: &'static str,
    /// The global value, shown so the professor sees what an override replaces.
    global_value: Value,
    /// True while the value in force has not been confirmed by the program.
    unconfirmed: bool,
}

#[derive(Debug, Serialize)]
struct Change {
    id: i64,
    actor_name: Option<String>,
    action: String,
    key: Option<String>,
    before: Option<Value>,
    after: Option<Value>,
    reason: Option<String>,
    created_at: String,
}

#[derive(Debug, Serialize)]
struct Overview {
    settings: Vec<Entry>,
    changes: Vec<Change>,
}

fn static_key(key: &str) -> AppResult<&'static str> {
    KEYS.iter()
        .copied()
        .find(|known| *known == key)
        .ok_or(AppError::NotFound)
}

async fn global_of(conn: &mut SqliteConnection, key: &str) -> AppResult<Value> {
    settings::get_value(conn, key)
        .await?
        .ok_or_else(|| AppError::Internal(format!("setting {key} is missing")))
}

async fn entry(conn: &mut SqliteConnection, campus_id: i64, key: &'static str) -> AppResult<Entry> {
    let global_value = global_of(conn, key).await?;
    let own = settings::campus_override(conn, campus_id, key).await?;
    let (value, source) = match own {
        Some(value) => (value, "campus"),
        None => (global_value.clone(), "global"),
    };
    let unconfirmed = value.get("confirmed").and_then(Value::as_bool) != Some(true);
    Ok(Entry {
        key,
        value,
        source,
        global_value,
        unconfirmed,
    })
}

async fn overview(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(campus_id): Path<i64>,
) -> AppResult<Json<Overview>> {
    let mut conn = state.db.acquire().await?;
    require_campus(&mut conn, &user, campus_id, Access::Manage).await?;
    let mut entries = Vec::new();
    for key in KEYS {
        entries.push(entry(&mut conn, campus_id, key).await?);
    }
    let rows = audit::list(
        &mut conn,
        AuditQuery {
            campus_id: Some(campus_id),
            entity_prefix: Some(AUDIT_ENTITY),
            entity_id: None,
            subject_user_id: None,
            limit: Some(50),
        },
    )
    .await?;
    let changes = rows
        .into_iter()
        .map(|row| Change {
            id: row.id,
            actor_name: row.actor_name,
            key: row
                .after
                .as_ref()
                .or(row.before.as_ref())
                .and_then(|v| v.get("key"))
                .and_then(Value::as_str)
                .map(str::to_owned),
            before: row.before.as_ref().and_then(|v| v.get("value")).cloned(),
            after: row.after.as_ref().and_then(|v| v.get("value")).cloned(),
            action: row.action,
            reason: row.reason,
            created_at: row.created_at,
        })
        .collect();
    Ok(Json(Overview {
        settings: entries,
        changes,
    }))
}

fn number(value: &Value, field: &str) -> AppResult<f64> {
    value
        .get(field)
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite())
        .ok_or_else(|| AppError::Unprocessable(format!("{field} must be a number")))
}

/// Checks the shape of an override and returns it normalised (`confirmed` always present).
fn validate(key: &str, value: &Value) -> AppResult<Value> {
    if !value.is_object() {
        return Err(AppError::Unprocessable("value must be an object".into()));
    }
    if value.to_string().len() > 1024 {
        return Err(AppError::Unprocessable("the value is too large".into()));
    }
    // The system decides `confirmed` (the kernel overwrites it); a sent value is ignored.
    let confirmed = false;
    match key {
        settings::GRADING_SCALE => {
            let (min, max, pass) = (
                number(value, "min")?,
                number(value, "max")?,
                number(value, "pass")?,
            );
            if min >= max {
                return Err(AppError::Unprocessable("min must be below max".into()));
            }
            if pass < min || pass > max {
                return Err(AppError::Unprocessable(
                    "pass must be between min and max".into(),
                ));
            }
            Ok(json!({ "min": min, "max": max, "pass": pass, "confirmed": confirmed }))
        }
        settings::GRADING_FINAL_RULE => {
            let kind = value.get("kind").and_then(Value::as_str).unwrap_or("");
            if kind != "weighted_mean" {
                return Err(AppError::Unprocessable(
                    "kind must be weighted_mean, the only rule the gradebook can compute".into(),
                ));
            }
            Ok(json!({ "kind": kind, "confirmed": confirmed }))
        }
        settings::ATTENDANCE_RULE => {
            let rate = number(value, "min_percent")?;
            if !(0.0..=100.0).contains(&rate) {
                return Err(AppError::Unprocessable(
                    "min_percent must be between 0 and 100".into(),
                ));
            }
            Ok(json!({ "min_percent": rate, "confirmed": confirmed }))
        }
        _ => Err(AppError::NotFound),
    }
}

fn clean_reason(reason: &str) -> AppResult<String> {
    let reason = australis_core::audit::trim_reason(reason);
    if reason.is_empty() {
        return Err(AppError::Unprocessable("a reason is required".into()));
    }
    if reason.chars().count() > MAX_REASON_CHARS {
        return Err(AppError::Unprocessable("the reason is too long".into()));
    }
    Ok(reason.to_owned())
}

#[derive(Debug, Deserialize)]
struct SetBody {
    value: Value,
    reason: String,
}

#[derive(Debug, Deserialize)]
struct ResetBody {
    reason: String,
}

async fn set_override(
    State(state): State<AppState>,
    user: CurrentUser,
    Path((campus_id, key)): Path<(i64, String)>,
    Json(body): Json<SetBody>,
) -> AppResult<Json<Entry>> {
    let key = static_key(&key)?;
    let reason = clean_reason(&body.reason)?;
    let mut tx = begin_write(&state.db).await?;
    require_campus(&mut tx, &user, campus_id, Access::Manage).await?;
    let value = validate(key, &body.value)?;
    settings::set_for_campus(&mut tx, user.id, campus_id, key, &value, Some(&reason)).await?;
    let after = entry(&mut tx, campus_id, key).await?;
    tx.commit().await?;
    Ok(Json(after))
}

async fn reset(
    State(state): State<AppState>,
    user: CurrentUser,
    Path((campus_id, key)): Path<(i64, String)>,
    Json(body): Json<ResetBody>,
) -> AppResult<Json<Entry>> {
    let key = static_key(&key)?;
    let reason = clean_reason(&body.reason)?;
    let mut tx = begin_write(&state.db).await?;
    require_campus(&mut tx, &user, campus_id, Access::Manage).await?;
    let before = entry(&mut tx, campus_id, key).await?;
    if before.source != "campus" {
        return Err(AppError::Conflict(
            "this setting is already inherited".into(),
        ));
    }
    settings::clear_for_campus(&mut tx, user.id, campus_id, key, Some(&reason)).await?;
    let after = entry(&mut tx, campus_id, key).await?;
    tx.commit().await?;
    Ok(Json(after))
}
