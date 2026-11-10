//! The campus module's tables. `save_document` is the single write path: the editor, restore
//! and AI shaping all go through it, so every change leaves a revision in the same transaction.

use australis_core::{AppError, AppResult};
use serde::Serialize;
use sqlx::{Connection, SqliteConnection};

use crate::document::Document;

/// How a revision came about.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Via {
    Template,
    Editor,
    Ai,
    Restore,
}

impl Via {
    fn as_str(self) -> &'static str {
        match self {
            Via::Template => "template",
            Via::Editor => "editor",
            Via::Ai => "ai",
            Via::Restore => "restore",
        }
    }
}

/// Who saved, how, and why (the text shown in the revision history).
#[derive(Debug, Clone)]
pub struct SaveMeta<'a> {
    pub user_id: i64,
    pub via: Via,
    pub summary: &'a str,
    /// The AI proposal behind the change (a row of another module), if any.
    pub proposal_id: Option<i64>,
}

/// The document as stored, after a save or a read.
#[derive(Debug, Clone, Serialize)]
pub struct StoredDocument {
    pub template_key: String,
    pub version: i64,
    pub document: Document,
    pub updated_at: String,
    pub updated_by: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct RevisionInfo {
    pub id: i64,
    pub version: i64,
    pub summary: String,
    pub via: String,
    pub proposal_id: Option<i64>,
    pub created_by: i64,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Revision {
    #[serde(flatten)]
    pub info: RevisionInfo,
    pub document: Document,
}

const MAX_SUMMARY_CHARS: usize = 300;

fn clean_summary(summary: &str, fallback: &str) -> AppResult<String> {
    let summary = summary.trim();
    if summary.chars().count() > MAX_SUMMARY_CHARS {
        return Err(AppError::Unprocessable(format!(
            "the summary is longer than {MAX_SUMMARY_CHARS} characters"
        )));
    }
    if summary.chars().any(char::is_control) {
        return Err(AppError::Unprocessable(
            "the summary has control characters".into(),
        ));
    }
    Ok(if summary.is_empty() {
        fallback.to_string()
    } else {
        summary.to_string()
    })
}

fn to_json(document: &Document) -> AppResult<String> {
    serde_json::to_string(document).map_err(|err| AppError::Internal(err.to_string()))
}

fn from_json(json: &str) -> AppResult<Document> {
    serde_json::from_str(json).map_err(|err| AppError::Internal(format!("stored document: {err}")))
}

async fn insert_revision(
    conn: &mut SqliteConnection,
    campus_id: i64,
    version: i64,
    content_json: &str,
    summary: &str,
    meta: &SaveMeta<'_>,
) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO campus_revisions
            (campus_id, version, content_json, summary, via, proposal_id, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(campus_id)
    .bind(version)
    .bind(content_json)
    .bind(summary)
    .bind(meta.via.as_str())
    .bind(meta.proposal_id)
    .bind(meta.user_id)
    .execute(conn)
    .await?;
    Ok(())
}

/// Stores the first version (1) of a new campus from a template.
pub async fn init_document(
    conn: &mut SqliteConnection,
    campus_id: i64,
    template_key: &str,
    document: Document,
    user_id: i64,
    summary: &str,
) -> AppResult<StoredDocument> {
    let document = document.validated()?;
    let json = to_json(&document)?;
    let summary = clean_summary(summary, "Campus creado")?;
    let mut tx = conn.begin().await?;
    sqlx::query(
        "INSERT INTO campus_documents (campus_id, template_key, content_json, version, updated_by)
         VALUES (?, ?, ?, 1, ?)",
    )
    .bind(campus_id)
    .bind(template_key)
    .bind(&json)
    .bind(user_id)
    .execute(&mut *tx)
    .await?;
    let meta = SaveMeta {
        user_id,
        via: Via::Template,
        summary: &summary,
        proposal_id: None,
    };
    insert_revision(&mut tx, campus_id, 1, &json, &summary, &meta).await?;
    tx.commit().await?;
    get_document(conn, campus_id)
        .await?
        .ok_or(AppError::NotFound)
}

/// Saves a new version of the campus document and writes its revision, in the caller's
/// transaction (pass `&mut *tx` from `australis_core::begin_write`). `base_version` is the
/// version the change was made on; if the document has moved on, nothing is written and the
/// result is 409. The document is validated here, so no write path can store an invalid one.
pub async fn save_document(
    conn: &mut SqliteConnection,
    campus_id: i64,
    base_version: i64,
    document: Document,
    meta: SaveMeta<'_>,
) -> AppResult<StoredDocument> {
    let document = document.validated()?;
    let json = to_json(&document)?;
    let summary = clean_summary(meta.summary, "Cambios en el campus")?;
    let mut tx = conn.begin().await?;
    let new_version: Option<i64> = sqlx::query_scalar(
        "UPDATE campus_documents
         SET content_json = ?, version = version + 1, updated_at = datetime('now'), updated_by = ?
         WHERE campus_id = ? AND version = ?
         RETURNING version",
    )
    .bind(&json)
    .bind(meta.user_id)
    .bind(campus_id)
    .bind(base_version)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(new_version) = new_version else {
        let exists: Option<i64> =
            sqlx::query_scalar("SELECT version FROM campus_documents WHERE campus_id = ?")
                .bind(campus_id)
                .fetch_optional(&mut *tx)
                .await?;
        return Err(match exists {
            Some(_) => AppError::Conflict(
                "the campus was changed by someone else; reload and try again".into(),
            ),
            None => AppError::NotFound,
        });
    };
    insert_revision(&mut tx, campus_id, new_version, &json, &summary, &meta).await?;
    tx.commit().await?;
    get_document(conn, campus_id)
        .await?
        .ok_or(AppError::NotFound)
}

#[derive(sqlx::FromRow)]
struct DocumentRow {
    template_key: String,
    content_json: String,
    version: i64,
    updated_at: String,
    updated_by: i64,
}

pub async fn get_document(
    conn: &mut SqliteConnection,
    campus_id: i64,
) -> AppResult<Option<StoredDocument>> {
    let row = sqlx::query_as::<_, DocumentRow>(
        "SELECT template_key, content_json, version, updated_at, updated_by
         FROM campus_documents WHERE campus_id = ?",
    )
    .bind(campus_id)
    .fetch_optional(conn)
    .await?;
    row.map(|row| {
        Ok(StoredDocument {
            template_key: row.template_key,
            version: row.version,
            document: from_json(&row.content_json)?,
            updated_at: row.updated_at,
            updated_by: row.updated_by,
        })
    })
    .transpose()
}

#[derive(sqlx::FromRow)]
struct RevisionRow {
    id: i64,
    version: i64,
    summary: String,
    via: String,
    proposal_id: Option<i64>,
    created_by: i64,
    created_at: String,
    content_json: String,
}

impl RevisionRow {
    fn info(&self) -> RevisionInfo {
        RevisionInfo {
            id: self.id,
            version: self.version,
            summary: self.summary.clone(),
            via: self.via.clone(),
            proposal_id: self.proposal_id,
            created_by: self.created_by,
            created_at: self.created_at.clone(),
        }
    }
}

/// Revisions of a campus, newest first, without their content. At most 200.
pub async fn list_revisions(
    conn: &mut SqliteConnection,
    campus_id: i64,
) -> AppResult<Vec<RevisionInfo>> {
    let rows = sqlx::query_as::<_, RevisionRow>(
        "SELECT id, version, summary, via, proposal_id, created_by, created_at,
                '' AS content_json
         FROM campus_revisions WHERE campus_id = ? ORDER BY version DESC LIMIT 200",
    )
    .bind(campus_id)
    .fetch_all(conn)
    .await?;
    Ok(rows.iter().map(RevisionRow::info).collect())
}

pub async fn get_revision(
    conn: &mut SqliteConnection,
    campus_id: i64,
    version: i64,
) -> AppResult<Option<Revision>> {
    let row = sqlx::query_as::<_, RevisionRow>(
        "SELECT id, version, summary, via, proposal_id, created_by, created_at, content_json
         FROM campus_revisions WHERE campus_id = ? AND version = ?",
    )
    .bind(campus_id)
    .bind(version)
    .fetch_optional(conn)
    .await?;
    row.map(|row| {
        Ok(Revision {
            info: row.info(),
            document: from_json(&row.content_json)?,
        })
    })
    .transpose()
}
