//! The campus document, schema v1.
//!
//! `{ "schema": 1, "sections": [ { id, title, kind, visible, blocks: [ ... ] } ] }`
//!
//! Blocks: `text` and `callout` (plain text, never markdown or HTML), `link` (http/https only),
//! `checklist` and `widget`. A widget only names live data to show (`classes`, `join_class`,
//! `recordings`, `grades`); it holds no records, so no document change can alter a grade.
//!
//! [`Document::validated`] is the only way a document gets stored: it drops unknown fields,
//! assigns missing ids, and enforces the limits below.

use std::collections::HashSet;

use australis_core::{AppError, AppResult};
use rand::RngCore;
use serde::{Deserialize, Serialize};

pub const SCHEMA_VERSION: u32 = 1;
pub const MAX_SECTIONS: usize = 40;
pub const MAX_BLOCKS_PER_SECTION: usize = 30;
pub const MAX_TEXT_CHARS: usize = 8_000;
pub const MAX_TITLE_CHARS: usize = 200;
pub const MAX_ID_CHARS: usize = 64;
pub const MAX_CHECKLIST_ITEMS: usize = 50;
pub const MAX_ITEM_CHARS: usize = 300;
pub const MAX_URL_CHARS: usize = 2_000;
pub const MAX_DOCUMENT_BYTES: usize = 512 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Document {
    pub schema: u32,
    #[serde(default)]
    pub sections: Vec<Section>,
}

/// What a section is for. A closed list so screens can pick a label.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SectionKind {
    General,
    Info,
    Week,
    Session,
    Assignment,
    Resources,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Section {
    #[serde(default)]
    pub id: String,
    pub title: String,
    #[serde(default = "default_kind")]
    pub kind: SectionKind,
    #[serde(default = "default_visible")]
    pub visible: bool,
    #[serde(default)]
    pub blocks: Vec<Block>,
}

fn default_kind() -> SectionKind {
    SectionKind::General
}

fn default_visible() -> bool {
    true
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WidgetKind {
    Classes,
    JoinClass,
    Recordings,
    Grades,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Block {
    Text {
        #[serde(default)]
        id: String,
        text: String,
    },
    Callout {
        #[serde(default)]
        id: String,
        text: String,
    },
    Link {
        #[serde(default)]
        id: String,
        label: String,
        url: String,
    },
    Checklist {
        #[serde(default)]
        id: String,
        items: Vec<String>,
    },
    Widget {
        #[serde(default)]
        id: String,
        widget: WidgetKind,
    },
}

impl Block {
    fn id_mut(&mut self) -> &mut String {
        match self {
            Block::Text { id, .. }
            | Block::Callout { id, .. }
            | Block::Link { id, .. }
            | Block::Checklist { id, .. }
            | Block::Widget { id, .. } => id,
        }
    }
}

fn invalid(message: impl Into<String>) -> AppError {
    AppError::Unprocessable(message.into())
}

fn new_id(prefix: char) -> String {
    let mut bytes = [0u8; 5];
    rand::thread_rng().fill_bytes(&mut bytes);
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    format!("{prefix}{hex}")
}

fn check_id(id: &str, seen: &mut HashSet<String>) -> AppResult<()> {
    if id.chars().count() > MAX_ID_CHARS
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(invalid(
            "ids use only letters, digits, '-' and '_' (at most 64)",
        ));
    }
    if !seen.insert(id.to_string()) {
        return Err(invalid(format!("the id '{id}' is used twice")));
    }
    Ok(())
}

/// Plain text: no control characters other than newline and tab, and nothing that looks like
/// an HTML tag. Screens render it as text, never as markdown or HTML.
fn check_plain(text: &str, what: &str, max_chars: usize, allow_newlines: bool) -> AppResult<()> {
    if text.trim().is_empty() {
        return Err(invalid(format!("{what} cannot be empty")));
    }
    if text.chars().count() > max_chars {
        return Err(invalid(format!(
            "{what} is longer than {max_chars} characters"
        )));
    }
    if text
        .chars()
        .any(|c| c.is_control() && !(allow_newlines && (c == '\n' || c == '\t')))
    {
        return Err(invalid(format!("{what} has control characters")));
    }
    let chars: Vec<char> = text.chars().collect();
    let has_tag = chars.windows(2).any(|pair| {
        pair[0] == '<' && (pair[1].is_ascii_alphabetic() || pair[1] == '/' || pair[1] == '!')
    });
    if has_tag {
        return Err(invalid(format!(
            "{what} is plain text: HTML is not allowed"
        )));
    }
    Ok(())
}

fn check_url(url: &str) -> AppResult<()> {
    let lower = url.to_ascii_lowercase();
    let rest = lower
        .strip_prefix("https://")
        .or_else(|| lower.strip_prefix("http://"))
        .ok_or_else(|| invalid("links must start with http:// or https://"))?;
    if rest.is_empty() || url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(invalid("the link is not a valid address"));
    }
    if url.len() > MAX_URL_CHARS {
        return Err(invalid(format!(
            "links are limited to {MAX_URL_CHARS} characters"
        )));
    }
    Ok(())
}

impl Document {
    pub fn empty() -> Self {
        Self {
            schema: SCHEMA_VERSION,
            sections: Vec::new(),
        }
    }

    /// Parses stored or submitted JSON into a normalised document.
    pub fn from_value(value: serde_json::Value) -> AppResult<Self> {
        let doc: Document = serde_json::from_value(value)
            .map_err(|err| invalid(format!("the document is not valid: {err}")))?;
        doc.validated()
    }

    /// Enforces schema and limits, and assigns ids to sections and blocks that have none.
    pub fn validated(mut self) -> AppResult<Self> {
        if self.schema != SCHEMA_VERSION {
            return Err(invalid(format!(
                "unsupported document schema {}",
                self.schema
            )));
        }
        if self.sections.len() > MAX_SECTIONS {
            return Err(invalid(format!("at most {MAX_SECTIONS} sections")));
        }
        let mut seen = HashSet::new();
        for section in &mut self.sections {
            if section.id.is_empty() {
                section.id = new_id('s');
            }
            check_id(&section.id, &mut seen)?;
            section.title = section.title.trim().to_string();
            check_plain(&section.title, "a section title", MAX_TITLE_CHARS, false)?;
            if section.blocks.len() > MAX_BLOCKS_PER_SECTION {
                return Err(invalid(format!(
                    "at most {MAX_BLOCKS_PER_SECTION} blocks per section"
                )));
            }
            for block in &mut section.blocks {
                if block.id_mut().is_empty() {
                    *block.id_mut() = new_id('b');
                }
                check_id(block.id_mut(), &mut seen)?;
                match block {
                    Block::Text { text, .. } => {
                        check_plain(text, "a text block", MAX_TEXT_CHARS, true)?
                    }
                    Block::Callout { text, .. } => {
                        check_plain(text, "a callout", MAX_TEXT_CHARS, true)?
                    }
                    Block::Link { label, url, .. } => {
                        check_plain(label, "a link label", MAX_TITLE_CHARS, false)?;
                        check_url(url)?;
                    }
                    Block::Checklist { items, .. } => {
                        if items.is_empty() || items.len() > MAX_CHECKLIST_ITEMS {
                            return Err(invalid(format!(
                                "a checklist has 1 to {MAX_CHECKLIST_ITEMS} items"
                            )));
                        }
                        for item in items {
                            check_plain(item, "a checklist item", MAX_ITEM_CHARS, false)?;
                        }
                    }
                    Block::Widget { .. } => {}
                }
            }
        }
        let size = serde_json::to_string(&self)
            .map_err(|err| AppError::Internal(err.to_string()))?
            .len();
        if size > MAX_DOCUMENT_BYTES {
            return Err(invalid("the document is too large"));
        }
        Ok(self)
    }
}
