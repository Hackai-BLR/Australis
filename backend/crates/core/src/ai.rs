//! AI behind a trait, with a per-user daily quota that fails closed and a usage log.
//!
//! This build has no real provider and makes no outside call. `PlaceholderAi` answers from
//! scripted replies embedded in this crate (`scripts/*.json`); everything it returns is
//! simulated and the screens must say so.
//!
//! Modules call [`run`], which reserves quota, calls the provider and writes the usage log.
//! There is no way to call the provider without a reservation.
//!
//! The AI never changes grades, attendance or closed records. That is structural: a reply
//! can only carry calls to the tools the caller offered, and the caller decides what a tool
//! does. No module offers a tool that touches those records.
//!
//! # Scripted shaping replies
//!
//! For the `shaping` feature the placeholder proposes `add_section` calls with this input:
//!
//! ```json
//! { "title": "…",
//!   "placement": { "at": "start" | "end" } | { "before_title_containing": "examen" },
//!   "blocks": [ { "type": "text", "text": "…" },
//!               { "type": "callout", "text": "…" },
//!               { "type": "checklist", "items": ["…"] } ] }
//! ```
//!
//! A call is only returned if the request offers a tool with that name.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::SqliteConnection;

use crate::{settings, AppError, AppResult, AppState, ProviderError};

/// The feature name of campus shaping, as used in quota keys and the usage log.
pub const FEATURE_SHAPING: &str = "shaping";

/// A tool the provider may call. `input_schema` is a JSON Schema object.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AiTool {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

#[derive(Debug, Clone, Default)]
pub struct AiRequest {
    /// Which feature is asking: selects the quota (`ai.<feature>.daily_quota`).
    pub feature: String,
    /// Stable instructions for the model.
    pub system: String,
    /// The current state the model may read (for shaping, the campus document as text).
    pub context: String,
    /// What the person asked for, in their words.
    pub instruction: String,
    pub tools: Vec<AiTool>,
    /// Errors from the previous attempt's tool calls, so the model can correct itself.
    pub feedback: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AiToolCall {
    pub name: String,
    pub input: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AiReply {
    /// What to show the person.
    pub text: String,
    /// Proposed operations. The caller validates and previews them; nothing is applied here.
    pub tool_calls: Vec<AiToolCall>,
    pub model: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
}

#[async_trait]
pub trait AiProvider: Send + Sync {
    /// Short name for the usage log, for example `placeholder`.
    fn name(&self) -> &'static str;
    /// True when replies are simulated; the UI then shows the "Simulado" badge.
    fn is_placeholder(&self) -> bool;
    async fn complete(&self, request: &AiRequest) -> Result<AiReply, ProviderError>;
}

// ---------------------------------------------------------------------------------------
// Placeholder provider
// ---------------------------------------------------------------------------------------

const SCRIPT_FILES: &[&str] = &[include_str!("../scripts/shaping.json")];
const PLACEHOLDER_MODEL: &str = "placeholder-scripted";
const NO_SCRIPT_REPLY: &str = "Esta es una respuesta simulada: el asistente de IA todavía no \
    está conectado y esta función no tiene respuestas preparadas.";

#[derive(Debug, Deserialize)]
struct Script {
    feature: String,
    /// The reply to an instruction that matches no keyword.
    unknown: String,
    replies: Vec<ScriptedReply>,
}

#[derive(Debug, Deserialize)]
struct ScriptedReply {
    /// The reply is used when any keyword appears in the instruction as whole words,
    /// ignoring case and accents. The first matching reply wins.
    keywords: Vec<String>,
    text: String,
    #[serde(default)]
    tool_calls: Vec<AiToolCall>,
}

/// Answers from scripted replies. Deterministic, offline and free.
pub struct PlaceholderAi {
    scripts: Vec<Script>,
}

impl PlaceholderAi {
    pub fn new() -> Self {
        let scripts = SCRIPT_FILES
            .iter()
            .map(|json| serde_json::from_str(json).expect("embedded AI script is valid JSON"))
            .collect();
        Self { scripts }
    }
}

impl Default for PlaceholderAi {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl AiProvider for PlaceholderAi {
    fn name(&self) -> &'static str {
        "placeholder"
    }

    fn is_placeholder(&self) -> bool {
        true
    }

    async fn complete(&self, request: &AiRequest) -> Result<AiReply, ProviderError> {
        let script = self
            .scripts
            .iter()
            .find(|script| script.feature == request.feature);
        let instruction = normalize(&request.instruction);
        let matched = script.and_then(|script| {
            script.replies.iter().find(|reply| {
                reply
                    .keywords
                    .iter()
                    .any(|keyword| instruction.contains(&normalize(keyword)))
            })
        });

        let (text, tool_calls) = match (script, matched) {
            (_, Some(reply)) => {
                let offered = reply
                    .tool_calls
                    .iter()
                    .filter(|call| request.tools.iter().any(|tool| tool.name == call.name))
                    .cloned()
                    .collect();
                (reply.text.clone(), offered)
            }
            (Some(script), None) => (script.unknown.clone(), Vec::new()),
            (None, None) => (NO_SCRIPT_REPLY.to_string(), Vec::new()),
        };

        let input_chars = request.system.len() + request.context.len() + request.instruction.len();
        let output_chars = text.len()
            + tool_calls
                .iter()
                .map(|call| call.input.to_string().len())
                .sum::<usize>();
        Ok(AiReply {
            text,
            tool_calls,
            model: PLACEHOLDER_MODEL.to_string(),
            input_tokens: estimate_tokens(input_chars),
            output_tokens: estimate_tokens(output_chars),
        })
    }
}

/// Rough size of a text in tokens, so the simulated usage log has plausible numbers.
fn estimate_tokens(chars: usize) -> i64 {
    (chars as i64 / 4).max(1)
}

/// Lowercases, strips Spanish accents and turns every run of other characters into one
/// space, with a space at both ends, so `contains(" palabra ")` matches whole words.
fn normalize(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push(' ');
    for ch in text.chars().flat_map(char::to_lowercase) {
        let ch = match ch {
            'á' | 'à' | 'ä' => 'a',
            'é' | 'è' | 'ë' => 'e',
            'í' | 'ì' | 'ï' => 'i',
            'ó' | 'ò' | 'ö' => 'o',
            'ú' | 'ù' | 'ü' => 'u',
            other => other,
        };
        if ch.is_alphanumeric() {
            out.push(ch);
        } else if !out.ends_with(' ') {
            out.push(' ');
        }
    }
    if !out.ends_with(' ') {
        out.push(' ');
    }
    out
}

// ---------------------------------------------------------------------------------------
// Quota
// ---------------------------------------------------------------------------------------

/// One reserved call. Give it back with [`release`] if the provider fails.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reservation {
    pub user_id: i64,
    pub feature: String,
    pub day: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct QuotaStatus {
    pub limit: i64,
    pub used: i64,
    pub remaining: i64,
    /// The local day the count belongs to, `YYYY-MM-DD`.
    pub day: String,
}

/// The daily limit of a feature from the `ai.<feature>.daily_quota` setting. A missing or
/// malformed setting means 0: no calls.
async fn daily_limit(conn: &mut SqliteConnection, feature: &str) -> AppResult<i64> {
    let value = settings::get_value(conn, &format!("ai.{feature}.daily_quota")).await?;
    Ok(value.and_then(|value| value.as_i64()).unwrap_or(0).max(0))
}

/// Reserves one call for today, or fails with 429. The count and the check are one
/// statement, so concurrent reservations cannot pass the limit, and a limit of 0 (or a
/// missing setting) lets nothing through.
pub async fn reserve(
    conn: &mut SqliteConnection,
    user_id: i64,
    feature: &str,
) -> AppResult<Reservation> {
    let limit = daily_limit(conn, feature).await?;
    let day = settings::local_today(conn).await?;
    let result = sqlx::query(
        "INSERT INTO core_ai_quota (user_id, feature, day, calls)
         SELECT ?1, ?2, ?3, 1 WHERE ?4 > 0
         ON CONFLICT (user_id, feature, day) DO UPDATE SET calls = calls + 1 WHERE calls < ?4",
    )
    .bind(user_id)
    .bind(feature)
    .bind(&day)
    .bind(limit)
    .execute(conn)
    .await?;
    if result.rows_affected() == 1 {
        Ok(Reservation {
            user_id,
            feature: feature.to_string(),
            day,
        })
    } else {
        Err(AppError::TooManyRequests(format!(
            "daily AI limit reached ({limit} per day)"
        )))
    }
}

/// Gives a reserved call back (the provider failed, so nothing was consumed).
pub async fn release(conn: &mut SqliteConnection, reservation: &Reservation) -> AppResult<()> {
    sqlx::query(
        "UPDATE core_ai_quota SET calls = calls - 1
         WHERE user_id = ? AND feature = ? AND day = ? AND calls > 0",
    )
    .bind(reservation.user_id)
    .bind(&reservation.feature)
    .bind(&reservation.day)
    .execute(conn)
    .await?;
    Ok(())
}

/// How much of today's quota a user has used.
pub async fn quota_status(
    conn: &mut SqliteConnection,
    user_id: i64,
    feature: &str,
) -> AppResult<QuotaStatus> {
    let limit = daily_limit(conn, feature).await?;
    let day = settings::local_today(conn).await?;
    let used: Option<i64> = sqlx::query_scalar(
        "SELECT calls FROM core_ai_quota WHERE user_id = ? AND feature = ? AND day = ?",
    )
    .bind(user_id)
    .bind(feature)
    .bind(&day)
    .fetch_optional(conn)
    .await?;
    let used = used.unwrap_or(0);
    Ok(QuotaStatus {
        limit,
        used,
        remaining: (limit - used).max(0),
        day,
    })
}

// ---------------------------------------------------------------------------------------
// Usage log
// ---------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, sqlx::Type)]
#[serde(rename_all = "lowercase")]
#[sqlx(rename_all = "lowercase")]
pub enum UsageStatus {
    Ok,
    /// The provider failed; the reserved call was given back.
    Error,
    /// The quota was used up; the provider was not called.
    Refused,
}

#[derive(Debug, Clone)]
pub struct UsageEntry<'a> {
    pub user_id: i64,
    pub campus_id: Option<i64>,
    pub feature: &'a str,
    pub provider: &'a str,
    pub model: &'a str,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub status: UsageStatus,
    pub simulated: bool,
}

/// Appends one row to the usage log and returns its id.
pub async fn record_usage(conn: &mut SqliteConnection, entry: UsageEntry<'_>) -> AppResult<i64> {
    let result = sqlx::query(
        "INSERT INTO core_ai_usage
            (user_id, campus_id, feature, provider, model, input_tokens, output_tokens,
             status, simulated)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(entry.user_id)
    .bind(entry.campus_id)
    .bind(entry.feature)
    .bind(entry.provider)
    .bind(entry.model)
    .bind(entry.input_tokens)
    .bind(entry.output_tokens)
    .bind(entry.status)
    .bind(entry.simulated)
    .execute(conn)
    .await?;
    Ok(result.last_insert_rowid())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, sqlx::FromRow)]
pub struct UsageRecord {
    pub id: i64,
    pub user_id: i64,
    pub user_name: String,
    pub campus_id: Option<i64>,
    pub feature: String,
    pub provider: String,
    pub model: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub status: UsageStatus,
    pub simulated: bool,
    pub created_at: String,
}

/// Which usage rows to list. Unset fields do not filter.
#[derive(Debug, Clone, Default)]
pub struct UsageQuery<'a> {
    pub user_id: Option<i64>,
    pub campus_id: Option<i64>,
    pub feature: Option<&'a str>,
    /// Defaults to 200; capped at 1000.
    pub limit: Option<i64>,
}

/// Lists usage rows, newest first.
pub async fn list_usage(
    conn: &mut SqliteConnection,
    query: UsageQuery<'_>,
) -> AppResult<Vec<UsageRecord>> {
    let rows = sqlx::query_as::<_, UsageRecord>(
        "SELECT a.id, a.user_id, u.full_name AS user_name, a.campus_id, a.feature, a.provider,
                a.model, a.input_tokens, a.output_tokens, a.status, a.simulated, a.created_at
         FROM core_ai_usage a
         JOIN core_users u ON u.id = a.user_id
         WHERE (?1 IS NULL OR a.user_id = ?1)
           AND (?2 IS NULL OR a.campus_id = ?2)
           AND (?3 IS NULL OR a.feature = ?3)
         ORDER BY a.id DESC
         LIMIT ?4",
    )
    .bind(query.user_id)
    .bind(query.campus_id)
    .bind(query.feature)
    .bind(query.limit.unwrap_or(200).clamp(1, 1000))
    .fetch_all(conn)
    .await?;
    Ok(rows)
}

// ---------------------------------------------------------------------------------------
// The one way to call the provider
// ---------------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AiOutcome {
    pub reply: AiReply,
    /// The id of the usage-log row of this call.
    pub usage_id: i64,
    /// True when the reply came from a placeholder provider.
    pub simulated: bool,
}

/// Runs one AI call for a user: reserves quota (429 when it is used up, before any provider
/// call), calls the provider, and logs the usage. If the provider fails, the reserved call
/// is given back and the failure is logged.
pub async fn run(
    state: &AppState,
    user_id: i64,
    campus_id: Option<i64>,
    request: &AiRequest,
) -> AppResult<AiOutcome> {
    let provider = state.ai.as_ref();
    let simulated = provider.is_placeholder();

    // No connection is held while the provider works.
    let reservation = {
        let mut conn = state.db.acquire().await?;
        match reserve(&mut conn, user_id, &request.feature).await {
            Ok(reservation) => reservation,
            Err(err) => {
                if matches!(err, AppError::TooManyRequests(_)) {
                    record_usage(
                        &mut conn,
                        UsageEntry {
                            user_id,
                            campus_id,
                            feature: &request.feature,
                            provider: provider.name(),
                            model: "",
                            input_tokens: 0,
                            output_tokens: 0,
                            status: UsageStatus::Refused,
                            simulated,
                        },
                    )
                    .await?;
                }
                return Err(err);
            }
        }
    };

    let result = provider.complete(request).await;

    let mut conn = state.db.acquire().await?;
    match result {
        Ok(reply) => {
            let usage_id = record_usage(
                &mut conn,
                UsageEntry {
                    user_id,
                    campus_id,
                    feature: &request.feature,
                    provider: provider.name(),
                    model: &reply.model,
                    input_tokens: reply.input_tokens,
                    output_tokens: reply.output_tokens,
                    status: UsageStatus::Ok,
                    simulated,
                },
            )
            .await?;
            Ok(AiOutcome {
                reply,
                usage_id,
                simulated,
            })
        }
        Err(err) => {
            release(&mut conn, &reservation).await?;
            record_usage(
                &mut conn,
                UsageEntry {
                    user_id,
                    campus_id,
                    feature: &request.feature,
                    provider: provider.name(),
                    model: "",
                    input_tokens: 0,
                    output_tokens: 0,
                    status: UsageStatus::Error,
                    simulated,
                },
            )
            .await?;
            Err(err.into())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn request(instruction: &str, tools: &[&str]) -> AiRequest {
        AiRequest {
            feature: FEATURE_SHAPING.into(),
            instruction: instruction.into(),
            tools: tools
                .iter()
                .map(|name| AiTool {
                    name: name.to_string(),
                    description: String::new(),
                    input_schema: json!({ "type": "object" }),
                })
                .collect(),
            ..AiRequest::default()
        }
    }

    #[test]
    fn normalize_strips_accents_and_marks_word_boundaries() {
        assert_eq!(normalize("¡Agregá ÉTICA, ya!"), " agrega etica ya ");
        assert!(!normalize("anotar").contains(&normalize("nota")));
    }

    #[tokio::test]
    async fn scripted_instruction_proposes_a_section() {
        let ai = PlaceholderAi::new();
        let reply = ai
            .complete(&request(
                "Agregá una semana sobre ética antes del examen",
                &["add_section"],
            ))
            .await
            .unwrap();
        assert_eq!(reply.tool_calls.len(), 1);
        assert_eq!(reply.tool_calls[0].name, "add_section");
        assert_eq!(
            reply.tool_calls[0].input["placement"]["before_title_containing"],
            "examen"
        );
        assert!(reply.input_tokens > 0 && reply.output_tokens > 0);
    }

    #[tokio::test]
    async fn a_tool_that_was_not_offered_is_never_called() {
        let ai = PlaceholderAi::new();
        let reply = ai
            .complete(&request("agregá la bibliografía", &["rename_campus"]))
            .await
            .unwrap();
        assert!(reply.tool_calls.is_empty());
        assert!(!reply.text.is_empty());
    }

    #[tokio::test]
    async fn requests_about_records_are_refused_without_tool_calls() {
        let ai = PlaceholderAi::new();
        for instruction in [
            "Cambiá la nota de Ana a 10",
            "poné presente en la asistencia de ayer",
            "modificá el acta cerrada y agregá la bibliografía",
        ] {
            let reply = ai
                .complete(&request(instruction, &["add_section"]))
                .await
                .unwrap();
            assert!(reply.tool_calls.is_empty(), "{instruction}");
            assert!(
                reply.text.contains("No puedo cambiar notas"),
                "{instruction}"
            );
        }
    }

    #[tokio::test]
    async fn unknown_instructions_and_features_have_a_defined_reply() {
        let ai = PlaceholderAi::new();
        let reply = ai
            .complete(&request("hacé algo sorprendente", &["add_section"]))
            .await
            .unwrap();
        assert!(reply.tool_calls.is_empty());
        assert!(reply.text.contains("respuesta simulada"));

        let mut other = request("agregá la bibliografía", &["add_section"]);
        other.feature = "summary".into();
        let reply = ai.complete(&other).await.unwrap();
        assert!(reply.tool_calls.is_empty());
        assert_eq!(reply.text, NO_SCRIPT_REPLY);
    }

    #[test]
    fn every_scripted_call_is_an_add_section_with_a_title_and_blocks() {
        for script in PlaceholderAi::new().scripts {
            for reply in script.replies {
                assert!(!reply.keywords.is_empty());
                for call in reply.tool_calls {
                    assert_eq!(call.name, "add_section");
                    assert!(call.input["title"].is_string());
                    assert!(call.input["blocks"].is_array());
                }
            }
        }
    }
}
