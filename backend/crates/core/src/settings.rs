//! Rules that are settings, not constants: the grading scale, the final-grade rule, AI
//! quotas and the local time offset. Values are JSON in `core_settings`; only the `global`
//! scope exists for now. The kernel migration seeds the keys below.

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;
use sqlx::SqliteConnection;

use crate::{AppError, AppResult};

pub const GRADING_SCALE: &str = "grading.scale";
pub const GRADING_FINAL_RULE: &str = "grading.final_rule";
pub const AI_SHAPING_DAILY_QUOTA: &str = "ai.shaping.daily_quota";
pub const APP_UTC_OFFSET_MINUTES: &str = "app.utc_offset_minutes";

const GLOBAL_SCOPE: &str = "global";

/// The raw JSON value of a setting, or `None` if the key does not exist.
pub async fn get_value(conn: &mut SqliteConnection, key: &str) -> AppResult<Option<Value>> {
    let raw: Option<String> =
        sqlx::query_scalar("SELECT value_json FROM core_settings WHERE scope = ? AND key = ?")
            .bind(GLOBAL_SCOPE)
            .bind(key)
            .fetch_optional(conn)
            .await?;
    raw.map(|json| {
        serde_json::from_str(&json)
            .map_err(|err| AppError::Internal(format!("setting {key} is not valid JSON: {err}")))
    })
    .transpose()
}

/// A setting that must exist, decoded into `T`. A missing or malformed setting is an
/// internal error: there is no fallback constant on purpose.
pub async fn get<T: DeserializeOwned>(conn: &mut SqliteConnection, key: &str) -> AppResult<T> {
    let value = get_value(conn, key)
        .await?
        .ok_or_else(|| AppError::Internal(format!("setting {key} is missing")))?;
    serde_json::from_value(value)
        .map_err(|err| AppError::Internal(format!("setting {key} has the wrong shape: {err}")))
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

pub async fn grading_scale(conn: &mut SqliteConnection) -> AppResult<GradingScale> {
    get(conn, GRADING_SCALE).await
}

pub async fn final_rule(conn: &mut SqliteConnection) -> AppResult<FinalRule> {
    get(conn, GRADING_FINAL_RULE).await
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
