//! The campus templates, embedded in the binary as JSON (Spanish content).

use australis_core::{AppError, AppResult};
use serde::{Deserialize, Serialize};

use crate::document::Document;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Template {
    pub key: String,
    pub name: String,
    pub description: String,
    pub document: Document,
}

const SOURCES: [&str; 4] = [
    include_str!("templates/weekly_topics.json"),
    include_str!("templates/case_method.json"),
    include_str!("templates/workshop.json"),
    include_str!("templates/thesis_group.json"),
];

/// All templates, validated, with fresh section and block ids.
pub fn all() -> AppResult<Vec<Template>> {
    SOURCES
        .iter()
        .map(|source| {
            let mut template: Template = serde_json::from_str(source)
                .map_err(|err| AppError::Internal(format!("template: {err}")))?;
            template.document = template.document.validated()?;
            Ok(template)
        })
        .collect()
}

pub fn find(key: &str) -> AppResult<Option<Template>> {
    Ok(all()?.into_iter().find(|template| template.key == key))
}
