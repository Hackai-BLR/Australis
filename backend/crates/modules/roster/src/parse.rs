//! Turns an uploaded file or a pasted list into `(line, name, email)` rows. Only the name and
//! the email are kept; every other column is dropped here, before anything is stored.

use std::io::Cursor;

use australis_core::{AppError, AppResult};
use calamine::{open_workbook_from_rs, Data, Reader, Xlsx};
use encoding_rs::{Encoding, WINDOWS_1252};

pub const MAX_ROWS: usize = 5000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedRow {
    /// 1-based position in the file (the header counts), so the professor can find the row.
    pub line_no: i64,
    pub full_name: String,
    pub email: String,
}

/// Decodes text from a file: a BOM wins, then valid UTF-8, then Windows-1252 (what Excel
/// writes for "CSV" in Spanish locales).
pub fn decode(bytes: &[u8]) -> String {
    if let Some((encoding, len)) = Encoding::for_bom(bytes) {
        return encoding
            .decode_without_bom_handling(&bytes[len..])
            .0
            .into_owned();
    }
    match std::str::from_utf8(bytes) {
        Ok(text) => text.to_string(),
        Err(_) => WINDOWS_1252
            .decode_without_bom_handling(bytes)
            .0
            .into_owned(),
    }
}

pub fn parse_csv(bytes: &[u8]) -> AppResult<Vec<ParsedRow>> {
    parse_text(&decode(bytes))
}

pub fn parse_text(text: &str) -> AppResult<Vec<ParsedRow>> {
    let delimiter = detect_delimiter(text);
    let mut reader = csv::ReaderBuilder::new()
        .has_headers(false)
        .flexible(true)
        .delimiter(delimiter)
        .from_reader(text.as_bytes());
    let mut rows = Vec::new();
    for record in reader.records() {
        let record =
            record.map_err(|_| AppError::Unprocessable("the file is not valid CSV".into()))?;
        rows.push(record.iter().map(str::to_string).collect::<Vec<_>>());
        if rows.len() > MAX_ROWS + 1 {
            break;
        }
    }
    rows_to_parsed(rows)
}

pub fn parse_xlsx(bytes: &[u8]) -> AppResult<Vec<ParsedRow>> {
    let bad = || AppError::Unprocessable("the Excel file could not be read".into());
    let mut workbook: Xlsx<_> = open_workbook_from_rs(Cursor::new(bytes)).map_err(|_| bad())?;
    let range = workbook
        .worksheet_range_at(0)
        .ok_or_else(bad)?
        .map_err(|_| bad())?;
    let rows = range
        .rows()
        .map(|row| {
            row.iter()
                .map(|cell| match cell {
                    Data::Empty => String::new(),
                    other => other.to_string(),
                })
                .collect::<Vec<_>>()
        })
        .collect();
    rows_to_parsed(rows)
}

/// `;` wins ties (Spanish-locale Excel), then tab, then `,`.
fn detect_delimiter(text: &str) -> u8 {
    let line = text
        .lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("");
    let count = |c: char| line.chars().filter(|x| *x == c).count();
    let (semi, tab, comma) = (count(';'), count('\t'), count(','));
    if semi >= tab && semi >= comma && semi > 0 {
        b';'
    } else if tab >= comma && tab > 0 {
        b'\t'
    } else {
        b','
    }
}

fn fold(text: &str) -> String {
    text.to_lowercase()
        .chars()
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

fn clean(text: &str) -> String {
    text.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim_matches(|c| c == '"' || c == '\'')
        .trim()
        .to_string()
}

struct Header {
    email: usize,
    full: Option<usize>,
    given: Option<usize>,
    family: Option<usize>,
}

fn detect_header(row: &[String]) -> Option<Header> {
    if row.iter().any(|cell| cell.contains('@')) {
        return None;
    }
    let cells: Vec<String> = row.iter().map(|cell| fold(cell)).collect();
    let email = cells
        .iter()
        .position(|c| c.contains("mail") || c.contains("correo"))?;
    let find = |pred: &dyn Fn(&str) -> bool| {
        cells
            .iter()
            .enumerate()
            .position(|(i, c)| i != email && pred(c))
    };
    let full = find(&|c| {
        (c.contains("nombre") && c.contains("apellido"))
            || c.contains("completo")
            || c.contains("alumn")
            || c.contains("estudiante")
            || c.contains("student")
            || c.contains("full")
    });
    let given = find(&|c| {
        (c.contains("nombre") || c.contains("name") || c.contains("first"))
            && !c.contains("apellido")
    });
    let family = find(&|c| c.contains("apellido") || c.contains("last") || c.contains("surname"));
    Some(Header {
        email,
        full,
        given,
        family,
    })
}

/// Splits one cell that holds an email into (email, name text around it): handles
/// `Ana Perez <ana@x.com>` and `Ana Perez ana@x.com`.
fn split_email_cell(cell: &str) -> (String, String) {
    if let (Some(open), Some(close)) = (cell.find('<'), cell.rfind('>')) {
        if open < close && cell[open..close].contains('@') {
            let email = cell[open + 1..close].trim().to_string();
            let name = format!("{} {}", &cell[..open], &cell[close + 1..]);
            return (email, name);
        }
    }
    let mut email = String::new();
    let mut name = Vec::new();
    for token in cell.split_whitespace() {
        if email.is_empty() && token.contains('@') {
            email = token
                .trim_matches(|c| c == ',' || c == ';' || c == '"')
                .to_string();
        } else {
            name.push(token);
        }
    }
    (email, name.join(" "))
}

fn rows_to_parsed(rows: Vec<Vec<String>>) -> AppResult<Vec<ParsedRow>> {
    let mut parsed = Vec::new();
    let mut header = None;
    let mut first_seen = false;
    for (index, row) in rows.iter().enumerate() {
        if row.iter().all(|cell| cell.trim().is_empty()) {
            continue;
        }
        if !first_seen {
            first_seen = true;
            if let Some(found) = detect_header(row) {
                header = Some(found);
                continue;
            }
        }
        let (name, email) = match &header {
            Some(h) => {
                let cell = |i: Option<usize>| i.and_then(|i| row.get(i)).map(|c| clean(c));
                let mut name = cell(h.full).filter(|n| !n.is_empty()).unwrap_or_else(|| {
                    [cell(h.given), cell(h.family)]
                        .into_iter()
                        .flatten()
                        .filter(|n| !n.is_empty())
                        .collect::<Vec<_>>()
                        .join(" ")
                });
                if name.is_empty() && h.full.is_none() && h.given.is_none() && h.family.is_none() {
                    name = row
                        .iter()
                        .enumerate()
                        .filter(|(i, _)| *i != h.email)
                        .map(|(_, c)| clean(c))
                        .find(|c| !c.is_empty())
                        .unwrap_or_default();
                }
                let (email, extra) = split_email_cell(row.get(h.email).map_or("", String::as_str));
                (clean(&format!("{name} {extra}")), clean(&email))
            }
            None => {
                let at = row.iter().position(|c| c.contains('@'));
                let mut email = String::new();
                let mut parts: Vec<String> = Vec::new();
                for (i, cell) in row.iter().enumerate() {
                    if Some(i) == at {
                        let (e, extra) = split_email_cell(cell);
                        email = e;
                        parts.push(extra);
                    } else {
                        parts.push(cell.clone());
                    }
                }
                let name = parts.iter().map(|p| clean(p)).filter(|p| !p.is_empty());
                (name.collect::<Vec<_>>().join(" "), clean(&email))
            }
        };
        parsed.push(ParsedRow {
            line_no: index as i64 + 1,
            full_name: name,
            email,
        });
        if parsed.len() > MAX_ROWS {
            return Err(AppError::Unprocessable(format!(
                "the file has more than {MAX_ROWS} rows"
            )));
        }
    }
    if parsed.is_empty() {
        return Err(AppError::Unprocessable("the file has no students".into()));
    }
    Ok(parsed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn header_columns_are_picked_and_the_rest_dropped() {
        let rows =
            parse_text("Apellido;Nombre;DNI;Correo\nPérez;Ana;30111222;ana@x.com\n").unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].full_name, "Ana Pérez");
        assert_eq!(rows[0].email, "ana@x.com");
        assert_eq!(rows[0].line_no, 2);
    }

    #[test]
    fn pasted_lists_in_several_shapes() {
        let rows = parse_text("Ana Perez <ana@x.com>\nLuis Gomez luis@x.com\nMaría, maria@x.com\n")
            .unwrap();
        let got: Vec<_> = rows
            .iter()
            .map(|r| (r.full_name.as_str(), r.email.as_str()))
            .collect();
        assert_eq!(
            got,
            vec![
                ("Ana Perez", "ana@x.com"),
                ("Luis Gomez", "luis@x.com"),
                ("María", "maria@x.com")
            ]
        );
    }

    #[test]
    fn windows_1252_is_decoded() {
        let bytes = b"Nombre;Email\nJos\xe9 Mu\xf1oz;jose@x.com\n";
        assert_eq!(parse_csv(bytes).unwrap()[0].full_name, "José Muñoz");
    }
}
