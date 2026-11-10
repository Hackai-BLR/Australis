//! The operations the AI may propose, and the pure function that applies them to a document.
//!
//! There are exactly eight: add/update/move/remove a section and add/update/move/remove a
//! block. They work on a [`Document`] and nothing else, so no operation can reach grades,
//! attendance, members or any table outside the campus module.

use australis_core::ai::AiTool;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::document::{Block, Document, Section, SectionKind};

/// A rejected operation; the message goes back to the model as a tool error.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpError(pub String);

impl std::fmt::Display for OpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

fn err<T>(message: impl Into<String>) -> Result<T, OpError> {
    Err(OpError(message.into()))
}

/// Where to put something. Exactly one field may be set; none means "at the end".
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Placement {
    /// `"start"` or `"end"`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<String>,
    /// Put it right before the section (or block) with this id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before_id: Option<String>,
    /// Sections only: before the first section whose title contains this text (ignoring case
    /// and accents). If none matches, it goes at the end.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before_title_containing: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Op {
    AddSection {
        title: String,
        #[serde(default)]
        kind: Option<SectionKind>,
        #[serde(default)]
        visible: Option<bool>,
        #[serde(default)]
        placement: Placement,
        #[serde(default)]
        blocks: Vec<Block>,
    },
    UpdateSection {
        section_id: String,
        #[serde(default)]
        title: Option<String>,
        #[serde(default)]
        kind: Option<SectionKind>,
        #[serde(default)]
        visible: Option<bool>,
    },
    MoveSection {
        section_id: String,
        placement: Placement,
    },
    RemoveSection {
        section_id: String,
    },
    AddBlock {
        section_id: String,
        block: Block,
        #[serde(default)]
        placement: Placement,
    },
    UpdateBlock {
        block_id: String,
        /// The fields to change (`text`, `label`, `url`, `items`). `type` and `id` cannot change.
        fields: Map<String, Value>,
    },
    MoveBlock {
        block_id: String,
        section_id: String,
        #[serde(default)]
        placement: Placement,
    },
    RemoveBlock {
        block_id: String,
    },
}

/// Names of the tools offered to the provider: the only way it can change anything.
pub const TOOL_NAMES: [&str; 8] = [
    "add_section",
    "update_section",
    "move_section",
    "remove_section",
    "add_block",
    "update_block",
    "move_block",
    "remove_block",
];

impl Op {
    /// Builds an operation from a provider tool call. Unknown tools and malformed input are
    /// tool errors.
    pub fn from_call(name: &str, input: &Value) -> Result<Op, OpError> {
        if !TOOL_NAMES.contains(&name) {
            return err(format!("unknown tool '{name}'"));
        }
        let mut object = match input {
            Value::Object(map) => map.clone(),
            _ => return err(format!("the input of '{name}' must be a JSON object")),
        };
        object.insert("op".into(), Value::String(name.to_string()));
        serde_json::from_value(Value::Object(object))
            .map_err(|e| OpError(format!("invalid input for '{name}': {e}")))
    }
}

// --- applying ---------------------------------------------------------------------------------

/// Lowercase, without Spanish accents, for title matching.
fn fold(text: &str) -> String {
    text.chars()
        .flat_map(char::to_lowercase)
        .map(|c| match c {
            'á' | 'à' | 'ä' => 'a',
            'é' | 'è' | 'ë' => 'e',
            'í' | 'ì' | 'ï' => 'i',
            'ó' | 'ò' | 'ö' => 'o',
            'ú' | 'ù' | 'ü' => 'u',
            other => other,
        })
        .collect()
}

fn section_index(doc: &Document, id: &str) -> Result<usize, OpError> {
    doc.sections
        .iter()
        .position(|s| s.id == id)
        .ok_or_else(|| OpError(format!("there is no section with id '{id}'")))
}

fn block_pos(doc: &Document, id: &str) -> Result<(usize, usize), OpError> {
    for (si, section) in doc.sections.iter().enumerate() {
        if let Some(bi) = section.blocks.iter().position(|b| block_id(b) == id) {
            return Ok((si, bi));
        }
    }
    err(format!("there is no block with id '{id}'"))
}

fn block_id(block: &Block) -> &str {
    match block {
        Block::Text { id, .. }
        | Block::Callout { id, .. }
        | Block::Link { id, .. }
        | Block::Checklist { id, .. }
        | Block::Widget { id, .. } => id,
    }
}

fn block_label(block: &Block) -> &'static str {
    match block {
        Block::Text { .. } => "texto",
        Block::Callout { .. } => "aviso",
        Block::Link { .. } => "enlace",
        Block::Checklist { .. } => "lista",
        Block::Widget { .. } => "contenido del campus",
    }
}

/// The same block with its id cleared, so the server assigns a new one.
fn without_id(block: &Block) -> Result<Block, OpError> {
    let mut value = serde_json::to_value(block).map_err(|e| OpError(e.to_string()))?;
    value["id"] = Value::String(String::new());
    serde_json::from_value(value).map_err(|e| OpError(e.to_string()))
}

/// The index in a list of `len` items, given how to find the "before" item.
fn resolve(
    p: &Placement,
    len: usize,
    find_before: impl Fn(&str) -> Option<usize>,
    by_title: Option<&dyn Fn(&str) -> usize>,
) -> Result<usize, OpError> {
    let set = [
        p.at.is_some(),
        p.before_id.is_some(),
        p.before_title_containing.is_some(),
    ]
    .iter()
    .filter(|set| **set)
    .count();
    if set > 1 {
        return err("a placement uses only one of 'at', 'before_id' and 'before_title_containing'");
    }
    if let Some(at) = &p.at {
        return match at.as_str() {
            "start" => Ok(0),
            "end" => Ok(len),
            other => err(format!("'at' is 'start' or 'end', not '{other}'")),
        };
    }
    if let Some(id) = &p.before_id {
        return find_before(id).ok_or_else(|| OpError(format!("there is no item with id '{id}'")));
    }
    if let Some(text) = &p.before_title_containing {
        return match by_title {
            Some(find) => Ok(find(text)),
            None => err("'before_title_containing' only works for sections"),
        };
    }
    Ok(len)
}

fn section_target(doc: &Document, p: &Placement) -> Result<usize, OpError> {
    let by_title = |text: &str| {
        let needle = fold(text);
        doc.sections
            .iter()
            .position(|s| fold(&s.title).contains(&needle))
            .unwrap_or(doc.sections.len())
    };
    resolve(
        p,
        doc.sections.len(),
        |id| doc.sections.iter().position(|s| s.id == id),
        Some(&by_title),
    )
}

fn block_target(section: &Section, p: &Placement) -> Result<usize, OpError> {
    resolve(
        p,
        section.blocks.len(),
        |id| section.blocks.iter().position(|b| block_id(b) == id),
        None,
    )
}

fn quoted(title: &str) -> String {
    format!("«{title}»")
}

/// Applies one operation in place and returns a one-line description in Spanish for the
/// list of changes.
pub fn apply_op(doc: &mut Document, op: &Op) -> Result<String, OpError> {
    match op {
        Op::AddSection {
            title,
            kind,
            visible,
            placement,
            blocks,
        } => {
            let index = section_target(doc, placement)?;
            let blocks = blocks
                .iter()
                .map(without_id)
                .collect::<Result<Vec<_>, _>>()?;
            let count = blocks.len();
            doc.sections.insert(
                index,
                Section {
                    id: String::new(),
                    title: title.clone(),
                    kind: kind.unwrap_or(SectionKind::General),
                    visible: visible.unwrap_or(true),
                    blocks,
                },
            );
            Ok(format!(
                "Agregar la sección {} ({count} bloque{})",
                quoted(title.trim()),
                if count == 1 { "" } else { "s" }
            ))
        }
        Op::UpdateSection {
            section_id,
            title,
            kind,
            visible,
        } => {
            if title.is_none() && kind.is_none() && visible.is_none() {
                return err("update_section needs at least one of 'title', 'kind' and 'visible'");
            }
            let index = section_index(doc, section_id)?;
            let section = &mut doc.sections[index];
            let old = section.title.clone();
            if let Some(title) = title {
                section.title = title.clone();
            }
            if let Some(kind) = kind {
                section.kind = *kind;
            }
            if let Some(visible) = visible {
                section.visible = *visible;
            }
            Ok(format!("Modificar la sección {}", quoted(&old)))
        }
        Op::MoveSection {
            section_id,
            placement,
        } => {
            let from = section_index(doc, section_id)?;
            let section = doc.sections.remove(from);
            let title = section.title.clone();
            let index = section_target(doc, placement)?;
            doc.sections.insert(index, section);
            Ok(format!("Mover la sección {}", quoted(&title)))
        }
        Op::RemoveSection { section_id } => {
            let index = section_index(doc, section_id)?;
            let section = doc.sections.remove(index);
            Ok(format!("Quitar la sección {}", quoted(&section.title)))
        }
        Op::AddBlock {
            section_id,
            block,
            placement,
        } => {
            let si = section_index(doc, section_id)?;
            let index = block_target(&doc.sections[si], placement)?;
            let section = &mut doc.sections[si];
            section.blocks.insert(index, without_id(block)?);
            Ok(format!(
                "Agregar un bloque de {} en {}",
                block_label(block),
                quoted(&section.title)
            ))
        }
        Op::UpdateBlock { block_id, fields } => {
            let (si, bi) = block_pos(doc, block_id)?;
            let block = &doc.sections[si].blocks[bi];
            let mut value = serde_json::to_value(block).map_err(|e| OpError(e.to_string()))?;
            for (key, new) in fields {
                if key == "type" || key == "id" {
                    return err(format!("the field '{key}' of a block cannot be changed"));
                }
                if value.get(key).is_none() {
                    return err(format!(
                        "a {} block has no field '{key}'",
                        block_label(block)
                    ));
                }
                value[key] = new.clone();
            }
            let updated: Block = serde_json::from_value(value)
                .map_err(|e| OpError(format!("invalid block fields: {e}")))?;
            let label = block_label(&updated);
            doc.sections[si].blocks[bi] = updated;
            Ok(format!(
                "Modificar un bloque de {label} en {}",
                quoted(&doc.sections[si].title)
            ))
        }
        Op::MoveBlock {
            block_id,
            section_id,
            placement,
        } => {
            let (si, bi) = block_pos(doc, block_id)?;
            let target = section_index(doc, section_id)?;
            let block = doc.sections[si].blocks.remove(bi);
            let index = block_target(&doc.sections[target], placement)?;
            let label = block_label(&block);
            doc.sections[target].blocks.insert(index, block);
            Ok(format!(
                "Mover un bloque de {label} a {}",
                quoted(&doc.sections[target].title)
            ))
        }
        Op::RemoveBlock { block_id } => {
            let (si, bi) = block_pos(doc, block_id)?;
            let block = doc.sections[si].blocks.remove(bi);
            Ok(format!(
                "Quitar un bloque de {} de {}",
                block_label(&block),
                quoted(&doc.sections[si].title)
            ))
        }
    }
}

/// Applies the operations in order to a copy of `doc`. Returns the new, validated document
/// (the server assigns every new id) and one description per operation. The first operation
/// that fails, or a result that breaks a document limit, is an error and nothing is returned.
pub fn apply_ops(doc: &Document, ops: &[Op]) -> Result<(Document, Vec<String>), OpError> {
    let mut working = doc.clone();
    let mut changes = Vec::with_capacity(ops.len());
    for (i, op) in ops.iter().enumerate() {
        let number = i + 1;
        let change =
            apply_op(&mut working, op).map_err(|e| OpError(format!("operation {number}: {e}")))?;
        changes.push(change);
        // Validating after each step keeps limit errors attached to the operation that caused
        // them, and gives new sections their ids so later operations can refer to them.
        working = working
            .validated()
            .map_err(|e| OpError(format!("operation {number}: {e}")))?;
    }
    Ok((working, changes))
}

// --- tool definitions -------------------------------------------------------------------------

fn block_schema() -> Value {
    json!({
        "type": "object",
        "description": "A block: text and callout have 'text'; link has 'label' and 'url' (http/https); checklist has 'items'; widget has 'widget' (classes, join_class, recordings, grades). Ids are assigned by the server.",
        "properties": {
            "type": { "enum": ["text", "callout", "link", "checklist", "widget"] },
            "text": { "type": "string" },
            "label": { "type": "string" },
            "url": { "type": "string" },
            "items": { "type": "array", "items": { "type": "string" } },
            "widget": { "enum": ["classes", "join_class", "recordings", "grades"] }
        },
        "required": ["type"]
    })
}

fn placement_schema(sections: bool) -> Value {
    let mut properties = json!({
        "at": { "enum": ["start", "end"] },
        "before_id": { "type": "string" }
    });
    if sections {
        properties["before_title_containing"] = json!({ "type": "string" });
    }
    json!({ "type": "object", "description": "Use exactly one field. Default: at the end.", "properties": properties })
}

fn tool(name: &str, description: &str, properties: Value, required: &[&str]) -> AiTool {
    AiTool {
        name: name.into(),
        description: description.into(),
        input_schema: json!({ "type": "object", "properties": properties, "required": required }),
    }
}

/// The tool definitions for exactly the eight operations.
pub fn tools() -> Vec<AiTool> {
    let kinds =
        json!({ "enum": ["general", "info", "week", "session", "assignment", "resources"] });
    vec![
        tool(
            "add_section",
            "Add a section to the campus, with its blocks.",
            json!({
                "title": { "type": "string" },
                "kind": kinds,
                "visible": { "type": "boolean" },
                "placement": placement_schema(true),
                "blocks": { "type": "array", "items": block_schema() }
            }),
            &["title"],
        ),
        tool(
            "update_section",
            "Change the title, kind or visibility of a section.",
            json!({ "section_id": { "type": "string" }, "title": { "type": "string" }, "kind": kinds, "visible": { "type": "boolean" } }),
            &["section_id"],
        ),
        tool(
            "move_section",
            "Move a section.",
            json!({ "section_id": { "type": "string" }, "placement": placement_schema(true) }),
            &["section_id", "placement"],
        ),
        tool(
            "remove_section",
            "Remove a section and its blocks.",
            json!({ "section_id": { "type": "string" } }),
            &["section_id"],
        ),
        tool(
            "add_block",
            "Add a block to a section.",
            json!({ "section_id": { "type": "string" }, "block": block_schema(), "placement": placement_schema(false) }),
            &["section_id", "block"],
        ),
        tool(
            "update_block",
            "Change fields of a block.",
            json!({ "block_id": { "type": "string" }, "fields": { "type": "object" } }),
            &["block_id", "fields"],
        ),
        tool(
            "move_block",
            "Move a block, possibly to another section.",
            json!({ "block_id": { "type": "string" }, "section_id": { "type": "string" }, "placement": placement_schema(false) }),
            &["block_id", "section_id"],
        ),
        tool(
            "remove_block",
            "Remove a block.",
            json!({ "block_id": { "type": "string" } }),
            &["block_id"],
        ),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(id: &str, t: &str) -> Block {
        Block::Text {
            id: id.into(),
            text: t.into(),
        }
    }

    fn section(id: &str, title: &str, blocks: Vec<Block>) -> Section {
        Section {
            id: id.into(),
            title: title.into(),
            kind: SectionKind::General,
            visible: true,
            blocks,
        }
    }

    fn doc() -> Document {
        Document {
            schema: 1,
            sections: vec![
                section("s1", "Inicio", vec![text("b1", "uno"), text("b2", "dos")]),
                section("s2", "Examen final", vec![text("b3", "tres")]),
                section("s3", "Cierre", vec![]),
            ],
        }
    }

    fn titles(d: &Document) -> Vec<&str> {
        d.sections.iter().map(|s| s.title.as_str()).collect()
    }

    fn at(at: &str) -> Placement {
        Placement {
            at: Some(at.into()),
            ..Placement::default()
        }
    }

    fn before(id: &str) -> Placement {
        Placement {
            before_id: Some(id.into()),
            ..Placement::default()
        }
    }

    fn add_section(title: &str, placement: Placement, blocks: Vec<Block>) -> Op {
        Op::AddSection {
            title: title.into(),
            kind: None,
            visible: None,
            placement,
            blocks,
        }
    }

    #[test]
    fn add_section_placements() {
        let d = doc();
        let (n, _) = apply_ops(&d, &[add_section("A", at("start"), vec![])]).unwrap();
        assert_eq!(titles(&n), ["A", "Inicio", "Examen final", "Cierre"]);
        let (n, _) = apply_ops(&d, &[add_section("A", at("end"), vec![])]).unwrap();
        assert_eq!(titles(&n), ["Inicio", "Examen final", "Cierre", "A"]);
        let (n, _) = apply_ops(&d, &[add_section("A", Placement::default(), vec![])]).unwrap();
        assert_eq!(titles(&n), ["Inicio", "Examen final", "Cierre", "A"]);
        let (n, _) = apply_ops(&d, &[add_section("A", before("s3"), vec![])]).unwrap();
        assert_eq!(titles(&n), ["Inicio", "Examen final", "A", "Cierre"]);
        let by_title = Placement {
            before_title_containing: Some("EXAMEN".into()),
            ..Placement::default()
        };
        let (n, _) = apply_ops(&d, &[add_section("A", by_title, vec![])]).unwrap();
        assert_eq!(titles(&n), ["Inicio", "A", "Examen final", "Cierre"]);
    }

    #[test]
    fn title_match_ignores_accents_and_falls_back_to_the_end() {
        let mut d = doc();
        d.sections[1].title = "Evaluación".into();
        let p = Placement {
            before_title_containing: Some("evaluacion".into()),
            ..Placement::default()
        };
        let (n, _) = apply_ops(&d, &[add_section("A", p, vec![])]).unwrap();
        assert_eq!(titles(&n), ["Inicio", "A", "Evaluación", "Cierre"]);
        let p = Placement {
            before_title_containing: Some("nada".into()),
            ..Placement::default()
        };
        let (n, _) = apply_ops(&d, &[add_section("A", p, vec![])]).unwrap();
        assert_eq!(titles(&n).last(), Some(&"A"));
    }

    #[test]
    fn server_assigns_ids_and_ignores_ids_from_the_provider() {
        let d = doc();
        let op = add_section("Nueva", at("end"), vec![text("b1", "x")]);
        let (n, _) = apply_ops(&d, &[op]).unwrap();
        let added = n.sections.last().unwrap();
        assert!(!added.id.is_empty());
        let id = block_id(&added.blocks[0]);
        assert_ne!(id, "b1");
        assert!(!id.is_empty());
    }

    #[test]
    fn invalid_placements_are_errors() {
        let d = doc();
        let both = Placement {
            at: Some("start".into()),
            before_id: Some("s1".into()),
            ..Placement::default()
        };
        assert!(apply_ops(&d, &[add_section("A", both, vec![])]).is_err());
        assert!(apply_ops(&d, &[add_section("A", at("middle"), vec![])]).is_err());
        assert!(apply_ops(&d, &[add_section("A", before("nope"), vec![])]).is_err());
        let op = Op::AddBlock {
            section_id: "s1".into(),
            block: text("", "x"),
            placement: Placement {
                before_title_containing: Some("x".into()),
                ..Placement::default()
            },
        };
        assert!(apply_ops(&d, &[op]).is_err());
    }

    #[test]
    fn update_section_changes_only_the_given_fields() {
        let d = doc();
        let op = Op::UpdateSection {
            section_id: "s2".into(),
            title: Some("Examen".into()),
            kind: Some(SectionKind::Assignment),
            visible: Some(false),
        };
        let (n, changes) = apply_ops(&d, &[op]).unwrap();
        assert_eq!(n.sections[1].title, "Examen");
        assert_eq!(n.sections[1].kind, SectionKind::Assignment);
        assert!(!n.sections[1].visible);
        assert_eq!(n.sections[1].blocks, d.sections[1].blocks);
        assert_eq!(changes, ["Modificar la sección «Examen final»"]);
        let empty = Op::UpdateSection {
            section_id: "s2".into(),
            title: None,
            kind: None,
            visible: None,
        };
        assert!(apply_ops(&d, &[empty]).is_err());
        let missing = Op::UpdateSection {
            section_id: "zz".into(),
            title: Some("x".into()),
            kind: None,
            visible: None,
        };
        assert!(apply_ops(&d, &[missing]).is_err());
    }

    #[test]
    fn move_section() {
        let d = doc();
        let op = Op::MoveSection {
            section_id: "s3".into(),
            placement: at("start"),
        };
        let (n, _) = apply_ops(&d, &[op]).unwrap();
        assert_eq!(titles(&n), ["Cierre", "Inicio", "Examen final"]);
        let op = Op::MoveSection {
            section_id: "s1".into(),
            placement: before("s3"),
        };
        let (n, _) = apply_ops(&d, &[op]).unwrap();
        assert_eq!(titles(&n), ["Examen final", "Inicio", "Cierre"]);
        // Before itself, or before a missing section: error, and the input is untouched.
        for p in [before("s1"), before("zz")] {
            let op = Op::MoveSection {
                section_id: "s1".into(),
                placement: p,
            };
            assert!(apply_ops(&d, &[op]).is_err());
        }
        assert_eq!(titles(&d), ["Inicio", "Examen final", "Cierre"]);
    }

    #[test]
    fn remove_section() {
        let d = doc();
        let op = Op::RemoveSection {
            section_id: "s2".into(),
        };
        let (n, changes) = apply_ops(&d, &[op.clone()]).unwrap();
        assert_eq!(titles(&n), ["Inicio", "Cierre"]);
        assert_eq!(changes, ["Quitar la sección «Examen final»"]);
        assert!(apply_ops(&n, &[op]).is_err());
    }

    #[test]
    fn add_block_placements() {
        let d = doc();
        let add = |p: Placement| Op::AddBlock {
            section_id: "s1".into(),
            block: text("", "nuevo"),
            placement: p,
        };
        let is_new = |b: &Block| matches!(b, Block::Text { text, .. } if text == "nuevo");
        let (n, _) = apply_ops(&d, &[add(at("start"))]).unwrap();
        assert_eq!(n.sections[0].blocks.len(), 3);
        assert!(is_new(&n.sections[0].blocks[0]));
        let (n, _) = apply_ops(&d, &[add(at("end"))]).unwrap();
        assert!(is_new(&n.sections[0].blocks[2]));
        let (n, _) = apply_ops(&d, &[add(before("b2"))]).unwrap();
        assert!(is_new(&n.sections[0].blocks[1]));
        assert_eq!(block_id(&n.sections[0].blocks[0]), "b1");
        assert!(apply_ops(&d, &[add(before("b3"))]).is_err());
        let wrong_section = Op::AddBlock {
            section_id: "zz".into(),
            block: text("", "x"),
            placement: Placement::default(),
        };
        assert!(apply_ops(&d, &[wrong_section]).is_err());
    }

    #[test]
    fn update_block_merges_fields_and_keeps_type_and_id() {
        let d = doc();
        let fields = |v: Value| v.as_object().unwrap().clone();
        let op = Op::UpdateBlock {
            block_id: "b1".into(),
            fields: fields(json!({ "text": "cambiado" })),
        };
        let (n, _) = apply_ops(&d, &[op]).unwrap();
        assert_eq!(
            n.sections[0].blocks[0],
            Block::Text {
                id: "b1".into(),
                text: "cambiado".into()
            }
        );
        for bad in [
            json!({ "type": "callout" }),
            json!({ "id": "x" }),
            json!({ "items": ["a"] }),
            json!({ "text": 5 }),
        ] {
            let op = Op::UpdateBlock {
                block_id: "b1".into(),
                fields: fields(bad),
            };
            assert!(apply_ops(&d, &[op]).is_err());
        }
        let missing = Op::UpdateBlock {
            block_id: "zz".into(),
            fields: fields(json!({ "text": "x" })),
        };
        assert!(apply_ops(&d, &[missing]).is_err());
    }

    #[test]
    fn move_block_within_and_across_sections() {
        let d = doc();
        let op = Op::MoveBlock {
            block_id: "b1".into(),
            section_id: "s1".into(),
            placement: at("end"),
        };
        let (n, _) = apply_ops(&d, &[op]).unwrap();
        assert_eq!(block_id(&n.sections[0].blocks[1]), "b1");
        let op = Op::MoveBlock {
            block_id: "b1".into(),
            section_id: "s3".into(),
            placement: Placement::default(),
        };
        let (n, _) = apply_ops(&d, &[op]).unwrap();
        assert_eq!(n.sections[0].blocks.len(), 1);
        assert_eq!(block_id(&n.sections[2].blocks[0]), "b1");
        let op = Op::MoveBlock {
            block_id: "b1".into(),
            section_id: "zz".into(),
            placement: Placement::default(),
        };
        assert!(apply_ops(&d, &[op]).is_err());
    }

    #[test]
    fn remove_block() {
        let d = doc();
        let op = Op::RemoveBlock {
            block_id: "b2".into(),
        };
        let (n, changes) = apply_ops(&d, &[op.clone()]).unwrap();
        assert_eq!(n.sections[0].blocks.len(), 1);
        assert_eq!(changes, ["Quitar un bloque de texto de «Inicio»"]);
        assert!(apply_ops(&n, &[op]).is_err());
    }

    #[test]
    fn ops_apply_in_order() {
        let d = doc();
        let ops = [
            add_section("Nueva", at("start"), vec![]),
            Op::RemoveSection {
                section_id: "s1".into(),
            },
        ];
        let (n, changes) = apply_ops(&d, &ops).unwrap();
        assert_eq!(titles(&n), ["Nueva", "Examen final", "Cierre"]);
        assert_eq!(changes.len(), 2);
        // The second operation refers to something the first removed.
        let ops = [
            Op::RemoveSection {
                section_id: "s1".into(),
            },
            Op::RemoveBlock {
                block_id: "b1".into(),
            },
        ];
        let error = apply_ops(&d, &ops).unwrap_err();
        assert!(error.0.starts_with("operation 2:"), "{error}");
    }

    #[test]
    fn a_failing_batch_changes_nothing() {
        let d = doc();
        let before = d.clone();
        let ops = [
            add_section("Buena", at("end"), vec![]),
            Op::RemoveSection {
                section_id: "zz".into(),
            },
        ];
        assert!(apply_ops(&d, &ops).is_err());
        assert_eq!(d, before);
    }

    #[test]
    fn document_limits_apply_to_the_result() {
        let d = doc();
        assert!(apply_ops(&d, &[add_section("  ", at("end"), vec![])]).is_err());
        assert!(apply_ops(&d, &[add_section("<b>x", at("end"), vec![])]).is_err());
        let link = Block::Link {
            id: String::new(),
            label: "x".into(),
            url: "javascript:alert(1)".into(),
        };
        assert!(apply_ops(&d, &[add_section("A", at("end"), vec![link])]).is_err());
        let mut full = d.clone();
        for i in 0..40 {
            full.sections
                .push(section(&format!("x{i}"), "Extra", vec![]));
        }
        full.sections.truncate(40);
        assert!(apply_ops(&full, &[add_section("A", at("end"), vec![])]).is_err());
    }

    #[test]
    fn applying_no_ops_is_the_identity() {
        let d = doc();
        let (n, changes) = apply_ops(&d, &[]).unwrap();
        assert_eq!(n, d);
        assert!(changes.is_empty());
    }

    #[test]
    fn from_call_parses_the_scripted_add_section_shape() {
        let input = json!({
            "title": "Semana",
            "placement": { "before_title_containing": "examen" },
            "blocks": [
                { "type": "text", "text": "hola" },
                { "type": "checklist", "items": ["a"] },
                { "type": "callout", "text": "ojo" }
            ]
        });
        let op = Op::from_call("add_section", &input).unwrap();
        let (n, _) = apply_ops(&doc(), &[op]).unwrap();
        assert_eq!(n.sections[1].title, "Semana");
        assert_eq!(n.sections[1].blocks.len(), 3);
    }

    #[test]
    fn from_call_rejects_unknown_tools_and_bad_input() {
        for name in [
            "set_grade",
            "mark_attendance",
            "add_member",
            "delete_campus",
            "",
        ] {
            assert!(Op::from_call(name, &json!({})).is_err(), "{name}");
        }
        assert!(Op::from_call("add_section", &json!("x")).is_err());
        assert!(Op::from_call("add_section", &json!({})).is_err());
        assert!(Op::from_call("remove_block", &json!({ "block_id": 3 })).is_err());
        // An "op" field in the input cannot choose another operation.
        let op = Op::from_call(
            "remove_block",
            &json!({ "op": "remove_section", "block_id": "b1" }),
        )
        .unwrap();
        assert!(matches!(op, Op::RemoveBlock { .. }));
    }

    #[test]
    fn there_are_exactly_eight_tools() {
        let tools = tools();
        let names: Vec<&str> = tools.iter().map(|t| t.name.as_str()).collect();
        assert_eq!(names, TOOL_NAMES);
        for t in &tools {
            assert_eq!(t.input_schema["type"], "object");
        }
    }

    #[test]
    fn ops_round_trip_through_json() {
        let ops = vec![
            add_section("A", at("end"), vec![text("", "x")]),
            Op::MoveBlock {
                block_id: "b1".into(),
                section_id: "s1".into(),
                placement: before("b2"),
            },
        ];
        let json = serde_json::to_string(&ops).unwrap();
        let back: Vec<Op> = serde_json::from_str(&json).unwrap();
        assert_eq!(back, ops);
    }
}
