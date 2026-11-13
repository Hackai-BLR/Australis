//! Append-only audit log: who changed what, when and why.
//!
//! Every change to grades, grade items and membership status writes a row here in the same
//! transaction as the change: pass `&mut *tx` as the connection. Database triggers abort any
//! UPDATE or DELETE on the table.

use serde::Serialize;
use serde_json::Value;
use sqlx::SqliteConnection;

use crate::AppResult;

/// One change to record.
#[derive(Debug, Clone)]
pub struct AuditEntry<'a> {
    /// Who made the change. `None` only for the system itself (the startup seed).
    pub actor_id: Option<i64>,
    pub campus_id: Option<i64>,
    /// What kind of record changed, prefixed by the owning module: `member`, `grades.entry`.
    pub entity: &'a str,
    pub entity_id: i64,
    /// The person the change is about, if any (the student of a grade).
    pub subject_user_id: Option<i64>,
    /// What happened: `suspend`, `update`.
    pub action: &'a str,
    pub before: Option<Value>,
    pub after: Option<Value>,
    pub reason: Option<&'a str>,
}

/// True for a character that shows nothing: whitespace, control and format characters,
/// fillers that render as blanks (braille blank, hangul fillers), variation selectors and
/// tag characters.
fn is_invisible(c: char) -> bool {
    c.is_whitespace()
        || c.is_control()
        || matches!(
            c,
            '\u{00AD}'
                | '\u{034F}'
                | '\u{061C}'
                | '\u{115F}'..='\u{1160}'
                | '\u{17B4}'..='\u{17B5}'
                | '\u{180B}'..='\u{180F}'
                | '\u{200B}'..='\u{200F}'
                | '\u{202A}'..='\u{202E}'
                | '\u{2060}'..='\u{206F}'
                | '\u{2800}'
                | '\u{3164}'
                | '\u{FE00}'..='\u{FE0F}'
                | '\u{FEFF}'
                | '\u{FFA0}'
                | '\u{FFF9}'..='\u{FFFB}'
                | '\u{E0000}'..='\u{E007F}'
                | '\u{E0100}'..='\u{E01EF}'
        )
}

/// Trims whitespace and invisible characters (zero-width space, joiners, BOM, soft hyphen,
/// bidi marks, braille blank, hangul fillers, variation selectors, tag characters) from both
/// ends, so a reason made only of them counts as empty.
pub fn trim_reason(text: &str) -> &str {
    text.trim_matches(is_invisible)
}

/// Appends a row and returns its id.
pub async fn record(conn: &mut SqliteConnection, entry: AuditEntry<'_>) -> AppResult<i64> {
    let result = sqlx::query(
        "INSERT INTO core_audit_log
            (actor_id, campus_id, entity, entity_id, subject_user_id, action,
             before_json, after_json, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(entry.actor_id)
    .bind(entry.campus_id)
    .bind(entry.entity)
    .bind(entry.entity_id)
    .bind(entry.subject_user_id)
    .bind(entry.action)
    .bind(entry.before.map(|value| value.to_string()))
    .bind(entry.after.map(|value| value.to_string()))
    .bind(entry.reason)
    .execute(conn)
    .await?;
    Ok(result.last_insert_rowid())
}

/// A stored row, with the actor's name for display.
#[derive(Debug, Clone, Serialize)]
pub struct AuditRecord {
    pub id: i64,
    pub actor_id: Option<i64>,
    pub actor_name: Option<String>,
    pub campus_id: Option<i64>,
    pub entity: String,
    pub entity_id: i64,
    pub subject_user_id: Option<i64>,
    pub action: String,
    pub before: Option<Value>,
    pub after: Option<Value>,
    pub reason: Option<String>,
    pub created_at: String,
}

/// Which rows to list. Unset fields do not filter.
#[derive(Debug, Clone, Default)]
pub struct AuditQuery<'a> {
    pub campus_id: Option<i64>,
    /// Matches entities that start with this text, so `grades.` covers the whole module.
    pub entity_prefix: Option<&'a str>,
    pub entity_id: Option<i64>,
    pub subject_user_id: Option<i64>,
    /// Defaults to 200; capped at 1000.
    pub limit: Option<i64>,
}

#[derive(sqlx::FromRow)]
struct RawRecord {
    id: i64,
    actor_id: Option<i64>,
    actor_name: Option<String>,
    campus_id: Option<i64>,
    entity: String,
    entity_id: i64,
    subject_user_id: Option<i64>,
    action: String,
    before_json: Option<String>,
    after_json: Option<String>,
    reason: Option<String>,
    created_at: String,
}

/// Lists rows, newest first.
pub async fn list(
    conn: &mut SqliteConnection,
    query: AuditQuery<'_>,
) -> AppResult<Vec<AuditRecord>> {
    let prefix = query.entity_prefix.map(|prefix| {
        let escaped = prefix
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_");
        format!("{escaped}%")
    });
    let rows = sqlx::query_as::<_, RawRecord>(
        "SELECT a.id, a.actor_id, u.full_name AS actor_name, a.campus_id, a.entity, a.entity_id,
                a.subject_user_id, a.action, a.before_json, a.after_json, a.reason, a.created_at
         FROM core_audit_log a
         LEFT JOIN core_users u ON u.id = a.actor_id
         WHERE (?1 IS NULL OR a.campus_id = ?1)
           AND (?2 IS NULL OR a.entity LIKE ?2 ESCAPE '\\')
           AND (?3 IS NULL OR a.entity_id = ?3)
           AND (?4 IS NULL OR a.subject_user_id = ?4)
         ORDER BY a.id DESC
         LIMIT ?5",
    )
    .bind(query.campus_id)
    .bind(prefix)
    .bind(query.entity_id)
    .bind(query.subject_user_id)
    .bind(query.limit.unwrap_or(200).clamp(1, 1000))
    .fetch_all(conn)
    .await?;

    Ok(rows
        .into_iter()
        .map(|row| AuditRecord {
            id: row.id,
            actor_id: row.actor_id,
            actor_name: row.actor_name,
            campus_id: row.campus_id,
            entity: row.entity,
            entity_id: row.entity_id,
            subject_user_id: row.subject_user_id,
            action: row.action,
            before: row
                .before_json
                .and_then(|json| serde_json::from_str(&json).ok()),
            after: row
                .after_json
                .and_then(|json| serde_json::from_str(&json).ok()),
            reason: row.reason,
            created_at: row.created_at,
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::trim_reason;

    #[test]
    fn a_reason_of_only_invisible_characters_is_empty() {
        let cases = [
            ("zero-width space", "\u{200B}"),
            ("mixed format characters", "\u{FEFF}\u{2060} "),
            ("braille blank", "\u{2800}"),
            ("hangul filler U+3164", "\u{3164}"),
            ("hangul choseong filler", "\u{115F}"),
            ("hangul jungseong filler", "\u{1160}"),
            ("halfwidth hangul filler", "\u{FFA0}"),
            ("variation selector", "\u{FE0F}"),
            ("variation selector supplement", "\u{E0100}\u{E01EF}"),
            ("tag characters", "\u{E0001}\u{E0020}\u{E007F}"),
            ("control characters", "\u{0000}\u{0007}\u{009F}"),
            (
                "all of them with spaces",
                " \u{2800}\u{3164}\u{FE0F}\u{E0041} \n",
            ),
        ];
        for (name, text) in cases {
            assert_eq!(trim_reason(text), "", "{name}");
        }
    }

    #[test]
    fn visible_text_is_kept_and_trimmed_at_the_ends() {
        assert_eq!(trim_reason("  error de carga \u{200B}"), "error de carga");
        assert_eq!(trim_reason("\u{2800}a\u{3164}b\u{FE0F}"), "a\u{3164}b");
    }
}
