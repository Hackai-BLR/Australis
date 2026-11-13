//! Rules that are settings, not constants: the grading scale, the final-grade rule, the
//! attendance rule, AI quotas and the local time offset. Values are JSON in `core_settings`.
//! The kernel migrations seed the keys below in the `global` scope.
//!
//! A campus may override the keys in [`CAMPUS_OVERRIDABLE`]: its value lives in the scope
//! `campus:<id>`. Read a rule a campus can override with [`get_for_campus`] (or
//! [`grading_scale`], [`final_rule`], [`attendance_rule`]), which falls back to the global
//! value, and write it with [`set_for_campus`] / [`clear_for_campus`].

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::SqliteConnection;

use crate::{
    audit::{self, AuditEntry},
    begin_nested, directory, AppError, AppResult,
};

pub const GRADING_SCALE: &str = "grading.scale";
pub const GRADING_FINAL_RULE: &str = "grading.final_rule";
pub const AI_SHAPING_DAILY_QUOTA: &str = "ai.shaping.daily_quota";
pub const AI_SUMMARY_DAILY_QUOTA: &str = "ai.summary.daily_quota";
pub const APP_UTC_OFFSET_MINUTES: &str = "app.utc_offset_minutes";
pub const ATTENDANCE_RULE: &str = "attendance.rule";

/// The keys a campus may override. Everything else is global only.
pub const CAMPUS_OVERRIDABLE: &[&str] = &[GRADING_SCALE, GRADING_FINAL_RULE, ATTENDANCE_RULE];

/// The `kind` values of [`FinalRule`] the grades module can compute.
pub const FINAL_RULE_KINDS: &[&str] = &["weighted_mean"];

const GLOBAL_SCOPE: &str = "global";

/// The scope that holds the settings one campus overrides.
pub fn campus_scope(campus_id: i64) -> String {
    format!("campus:{campus_id}")
}

async fn read_value(
    conn: &mut SqliteConnection,
    scope: &str,
    key: &str,
) -> AppResult<Option<Value>> {
    let raw: Option<String> =
        sqlx::query_scalar("SELECT value_json FROM core_settings WHERE scope = ? AND key = ?")
            .bind(scope)
            .bind(key)
            .fetch_optional(conn)
            .await?;
    raw.map(|json| {
        serde_json::from_str(&json)
            .map_err(|err| AppError::Internal(format!("setting {key} is not valid JSON: {err}")))
    })
    .transpose()
}

fn decode<T: DeserializeOwned>(key: &str, value: Value) -> AppResult<T> {
    serde_json::from_value(value)
        .map_err(|err| AppError::Internal(format!("setting {key} has the wrong shape: {err}")))
}

/// The raw JSON value of a global setting, or `None` if the key does not exist.
pub async fn get_value(conn: &mut SqliteConnection, key: &str) -> AppResult<Option<Value>> {
    read_value(conn, GLOBAL_SCOPE, key).await
}

/// A global setting that must exist, decoded into `T`. A missing or malformed setting is an
/// internal error: there is no fallback constant on purpose.
pub async fn get<T: DeserializeOwned>(conn: &mut SqliteConnection, key: &str) -> AppResult<T> {
    let value = get_value(conn, key)
        .await?
        .ok_or_else(|| AppError::Internal(format!("setting {key} is missing")))?;
    decode(key, value)
}

/// What one campus overrides for a key, or `None` when it inherits the global value.
pub async fn campus_override(
    conn: &mut SqliteConnection,
    campus_id: i64,
    key: &str,
) -> AppResult<Option<Value>> {
    read_value(conn, &campus_scope(campus_id), key).await
}

/// The value a campus uses for a key: its own override, or else the global value.
pub async fn get_value_for_campus(
    conn: &mut SqliteConnection,
    campus_id: i64,
    key: &str,
) -> AppResult<Option<Value>> {
    match campus_override(conn, campus_id, key).await? {
        Some(value) => Ok(Some(value)),
        None => get_value(conn, key).await,
    }
}

/// [`get`] for a campus: the override if there is one, else the global value.
pub async fn get_for_campus<T: DeserializeOwned>(
    conn: &mut SqliteConnection,
    campus_id: i64,
    key: &str,
) -> AppResult<T> {
    let value = get_value_for_campus(conn, campus_id, key)
        .await?
        .ok_or_else(|| AppError::Internal(format!("setting {key} is missing")))?;
    decode(key, value)
}

/// Checks that a value can be stored as a campus override of `key`: the key is overridable
/// and the value has the right shape and sensible numbers. 422 otherwise.
fn validate_campus_value(key: &str, value: &Value) -> AppResult<()> {
    let bad = |message: &str| AppError::Unprocessable(message.to_string());
    match key {
        GRADING_SCALE => {
            let scale: GradingScale = serde_json::from_value(value.clone())
                .map_err(|_| bad("the grading scale needs min, max and pass"))?;
            let finite = [scale.min, scale.max, scale.pass]
                .iter()
                .all(|n| n.is_finite());
            if !finite || scale.min >= scale.max || !scale.contains(scale.pass) {
                return Err(bad(
                    "the grading scale needs min < max and a pass mark inside it",
                ));
            }
        }
        GRADING_FINAL_RULE => {
            let rule: FinalRule = serde_json::from_value(value.clone())
                .map_err(|_| bad("the final-grade rule needs a kind"))?;
            if !FINAL_RULE_KINDS.contains(&rule.kind.as_str()) {
                return Err(bad("unknown final-grade rule"));
            }
        }
        ATTENDANCE_RULE => {
            let rule: AttendanceRule = serde_json::from_value(value.clone())
                .map_err(|_| bad("the attendance rule needs min_percent"))?;
            if !(0.0..=100.0).contains(&rule.min_percent) {
                return Err(bad("min_percent must be between 0 and 100"));
            }
        }
        _ => return Err(bad("this setting cannot be set for one campus")),
    }
    Ok(())
}

/// Refuses (422) a grading scale that leaves a score already stored for the campus outside
/// it: that would change every student's result without a grade being touched. This reads
/// the grades tables directly (read only) because the campus module cannot reach them and
/// the kernel is the only place that sees both sides.
async fn ensure_scores_fit(
    conn: &mut SqliteConnection,
    campus_id: i64,
    value: &Value,
) -> AppResult<()> {
    let scale: GradingScale = serde_json::from_value(value.clone())
        .map_err(|_| AppError::Unprocessable("the grading scale needs min, max and pass".into()))?;
    let outside: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM grades_entries e JOIN grades_items i ON i.id = e.item_id
         WHERE i.campus_id = ? AND e.score IS NOT NULL AND (e.score < ? OR e.score > ?)",
    )
    .bind(campus_id)
    .bind(scale.min)
    .bind(scale.max)
    .fetch_one(conn)
    .await?;
    if outside > 0 {
        return Err(AppError::Unprocessable(
            "the grading scale leaves scores already entered outside it".into(),
        ));
    }
    Ok(())
}

/// Sets a campus override and writes an audit row (entity `campus.setting`, entity id the
/// campus, before and after carrying the key and the value) in the same transaction. The
/// caller checks that `actor_id` may manage the campus.
pub async fn set_for_campus(
    conn: &mut SqliteConnection,
    actor_id: i64,
    campus_id: i64,
    key: &str,
    value: &Value,
    reason: Option<&str>,
) -> AppResult<()> {
    validate_campus_value(key, value)?;
    let mut tx = begin_nested(conn).await?;
    directory::find_campus(&mut tx, campus_id)
        .await?
        .ok_or(AppError::NotFound)?;
    if key == GRADING_SCALE {
        ensure_scores_fit(&mut tx, campus_id, value).await?;
    }
    let before = campus_override(&mut tx, campus_id, key).await?;
    sqlx::query(
        "INSERT INTO core_settings (scope, key, value_json, updated_by, updated_at)
         VALUES (?, ?, ?, ?, datetime('now'))
         ON CONFLICT (scope, key) DO UPDATE SET value_json = excluded.value_json,
             updated_by = excluded.updated_by, updated_at = excluded.updated_at",
    )
    .bind(campus_scope(campus_id))
    .bind(key)
    .bind(value.to_string())
    .bind(actor_id)
    .execute(&mut *tx)
    .await?;
    audit::record(
        &mut tx,
        AuditEntry {
            actor_id: Some(actor_id),
            campus_id: Some(campus_id),
            entity: "campus.setting",
            entity_id: campus_id,
            subject_user_id: None,
            action: "update",
            before: before.map(|value| json!({ "key": key, "value": value })),
            after: Some(json!({ "key": key, "value": value })),
            reason,
        },
    )
    .await?;
    tx.commit().await?;
    Ok(())
}

/// Removes a campus override, so the campus inherits the global value again. Audited like
/// [`set_for_campus`]. Clearing a key that has no override changes and records nothing.
pub async fn clear_for_campus(
    conn: &mut SqliteConnection,
    actor_id: i64,
    campus_id: i64,
    key: &str,
    reason: Option<&str>,
) -> AppResult<()> {
    if !CAMPUS_OVERRIDABLE.contains(&key) {
        return Err(AppError::Unprocessable(
            "this setting cannot be set for one campus".into(),
        ));
    }
    let mut tx = begin_nested(conn).await?;
    directory::find_campus(&mut tx, campus_id)
        .await?
        .ok_or(AppError::NotFound)?;
    if let Some(before) = campus_override(&mut tx, campus_id, key).await? {
        sqlx::query("DELETE FROM core_settings WHERE scope = ? AND key = ?")
            .bind(campus_scope(campus_id))
            .bind(key)
            .execute(&mut *tx)
            .await?;
        audit::record(
            &mut tx,
            AuditEntry {
                actor_id: Some(actor_id),
                campus_id: Some(campus_id),
                entity: "campus.setting",
                entity_id: campus_id,
                subject_user_id: None,
                action: "clear",
                before: Some(json!({ "key": key, "value": before })),
                after: None,
                reason,
            },
        )
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

/// The grading scale. `confirmed: false` means the program has not confirmed it, and the
/// screens must say so.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GradingScale {
    pub min: f64,
    pub max: f64,
    pub pass: f64,
    #[serde(default)]
    pub confirmed: bool,
}

impl GradingScale {
    pub fn contains(&self, score: f64) -> bool {
        score >= self.min && score <= self.max
    }
}

/// How the final grade is computed. The only `kind` seeded is `weighted_mean`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FinalRule {
    pub kind: String,
    #[serde(default)]
    pub confirmed: bool,
}

/// The attendance rule: the share of classes a student must attend. `confirmed: false` means
/// the program has not confirmed it, and the screens must say so.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AttendanceRule {
    pub min_percent: f64,
    #[serde(default)]
    pub confirmed: bool,
}

/// The grading scale of a campus: its override, or the global scale.
pub async fn grading_scale(conn: &mut SqliteConnection, campus_id: i64) -> AppResult<GradingScale> {
    get_for_campus(conn, campus_id, GRADING_SCALE).await
}

/// The final-grade rule of a campus: its override, or the global rule.
pub async fn final_rule(conn: &mut SqliteConnection, campus_id: i64) -> AppResult<FinalRule> {
    get_for_campus(conn, campus_id, GRADING_FINAL_RULE).await
}

/// The attendance rule of a campus: its override, or the global rule.
pub async fn attendance_rule(
    conn: &mut SqliteConnection,
    campus_id: i64,
) -> AppResult<AttendanceRule> {
    get_for_campus(conn, campus_id, ATTENDANCE_RULE).await
}

/// Minutes to add to UTC to get local time (-180 for Argentina).
pub async fn utc_offset_minutes(conn: &mut SqliteConnection) -> AppResult<i64> {
    get(conn, APP_UTC_OFFSET_MINUTES).await
}

/// The SQLite date modifier for the local offset, for example `-180 minutes`. Use it as
/// `date(some_utc_column, ?)` to get the local day of a stored UTC time.
pub async fn local_time_modifier(conn: &mut SqliteConnection) -> AppResult<String> {
    let offset = utc_offset_minutes(conn).await?;
    Ok(format!("{offset:+} minutes"))
}

/// Today's local date as `YYYY-MM-DD`.
pub async fn local_today(conn: &mut SqliteConnection) -> AppResult<String> {
    let modifier = local_time_modifier(conn).await?;
    let day: String = sqlx::query_scalar("SELECT date('now', ?)")
        .bind(modifier)
        .fetch_one(conn)
        .await?;
    Ok(day)
}
