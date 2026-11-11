//! Excel workbooks (.xlsx): read as rows of cells, written new, and changed
//! a range at a time. Microsoft's workbook API does not serve personal
//! OneDrive accounts, so the file itself is read and changed here, for every
//! account alike; what a change does not touch stays as Excel wrote it
//! (`ooxml.rs`). Formulas are written, not worked out: Excel recalculates
//! when it next opens the workbook.
use crate::{
    Error, Result,
    ooxml::{self, Tok, attr, escape, text_of, tokens},
    zip::{self, Archive},
};
use serde_json::{Value, json};
use std::collections::BTreeMap;

const WORKBOOK: &str = "xl/workbook.xml";
pub(crate) const MAX_ROWS: u32 = 1_048_576;
pub(crate) const MAX_COLUMNS: u32 = 16_384;
const CELL_TEXT_CAP: usize = 32_767;

/// A tag's name without a namespace prefix: a few writers put one on.
fn local(name: &str) -> &str {
    name.rsplit(':').next().unwrap_or(name)
}

fn opens(tok: &Tok, tag: &str) -> bool {
    matches!(tok, Tok::Open { name, .. } if local(name) == tag)
}
fn closes(tok: &Tok, tag: &str) -> bool {
    matches!(tok, Tok::Close { name, .. } if local(name) == tag)
}
fn is_empty(tok: &Tok) -> bool {
    matches!(tok, Tok::Open { empty: true, .. })
}

// --- Cell names -----------------------------------------------------------

/// `B` as 2.
fn column_number(letters: &str) -> Option<u32> {
    if letters.is_empty() || letters.len() > 3 {
        return None;
    }
    let mut n = 0u32;
    for c in letters.chars() {
        if !c.is_ascii_alphabetic() {
            return None;
        }
        n = n * 26 + (c.to_ascii_uppercase() as u32 - 'A' as u32 + 1);
    }
    (n <= MAX_COLUMNS).then_some(n)
}

/// 2 as `B`.
pub(crate) fn column_name(mut column: u32) -> String {
    let mut name = String::new();
    while column > 0 {
        let rem = (column - 1) % 26;
        name.insert(0, (b'A' + rem as u8) as char);
        column = (column - 1) / 26;
    }
    name
}

/// `B12` as (row 12, column 2). `$` signs are ignored.
pub(crate) fn cell_ref(text: &str) -> Option<(u32, u32)> {
    let text = text.replace('$', "");
    let split = text.find(|c: char| c.is_ascii_digit())?;
    let column = column_number(&text[..split])?;
    let row = text[split..].parse::<u32>().ok()?;
    (1..=MAX_ROWS).contains(&row).then_some((row, column))
}

pub(crate) fn cell_name(row: u32, column: u32) -> String {
    format!("{}{row}", column_name(column))
}

/// Cells from `from` to `to`, both included, as (row, column).
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Range {
    pub from: (u32, u32),
    pub to: (u32, u32),
}

impl Range {
    pub(crate) fn name(&self) -> String {
        format!(
            "{}:{}",
            cell_name(self.from.0, self.from.1),
            cell_name(self.to.0, self.to.1)
        )
    }

    /// The part of this range one read shows: what lies inside a sheet of
    /// `rows` by `columns`, cut by whole rows to `cap` cells. With it, the
    /// rest of the range, for a next read. None when the range starts
    /// outside the sheet.
    pub(crate) fn window(
        self,
        rows: u32,
        columns: u32,
        cap: u32,
    ) -> Option<(Range, Option<Range>)> {
        let to = (self.to.0.min(rows), self.to.1.min(columns));
        if self.from.0 > to.0 || self.from.1 > to.1 {
            return None;
        }
        let fit = (cap / (to.1 - self.from.1 + 1)).max(1);
        let last = to.0.min(self.from.0.saturating_add(fit - 1));
        let shown = Range {
            from: self.from,
            to: (last, to.1),
        };
        let rest = (last < to.0).then_some(Range {
            from: (last + 1, self.from.1),
            to,
        });
        Some((shown, rest))
    }
}

/// `A1:C10`, `B2`, or either after a sheet's name and `!`: the sheet when
/// one is named, and the cells.
pub(crate) fn range(text: &str) -> Result<(Option<String>, Range)> {
    let invalid = || {
        Error::new(
            4202,
            "range must name cells like A1:C10 or B2, with a sheet in front if needed: Sheet1!A1:C10",
        )
    };
    let text = text.trim();
    let (sheet, cells) = match text.rsplit_once('!') {
        Some((sheet, cells)) => {
            let sheet = sheet.trim();
            // A name with spaces is quoted, and a quote in it is doubled.
            let sheet = match sheet.strip_prefix('\'').and_then(|s| s.strip_suffix('\'')) {
                Some(quoted) => quoted.replace("''", "'"),
                None => sheet.to_owned(),
            };
            (Some(sheet), cells)
        }
        None => (None, text),
    };
    let (from, to) = match cells.split_once(':') {
        Some((from, to)) => (
            cell_ref(from.trim()).ok_or_else(invalid)?,
            cell_ref(to.trim()).ok_or_else(invalid)?,
        ),
        None => {
            let cell = cell_ref(cells.trim()).ok_or_else(invalid)?;
            (cell, cell)
        }
    };
    Ok((
        sheet.filter(|s| !s.is_empty()),
        Range {
            from: (from.0.min(to.0), from.1.min(to.1)),
            to: (from.0.max(to.0), from.1.max(to.1)),
        },
    ))
}

// --- Reading --------------------------------------------------------------

/// A sheet and the part of the file that holds it.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Sheet {
    pub name: String,
    pub part: String,
}

fn workbook(file: &Archive) -> Result<String> {
    file.text(WORKBOOK)?.ok_or_else(|| {
        Error::new(
            4202,
            "This isn't an Excel workbook Hexbot can read (.xlsx).",
        )
    })
}

/// The workbook's sheets, in tab order. Chart sheets are left out.
pub(crate) fn sheets(file: &Archive) -> Result<Vec<Sheet>> {
    let rels = ooxml::rels(file, WORKBOOK)?;
    Ok(tokens(&workbook(file)?)
        .iter()
        .filter(|tok| opens(tok, "sheet"))
        .filter_map(|tok| {
            let raw = tok.raw();
            let id = attr(raw, "r:id").or_else(|| attr(raw, "id"))?;
            let rel = rels.iter().find(|r| r.id == id && r.kind == "worksheet")?;
            Some(Sheet {
                name: attr(raw, "name")?,
                part: rel.target.clone(),
            })
        })
        .collect())
}

/// The sheet called `name`, or the first when none is named.
pub(crate) fn sheet(file: &Archive, name: Option<&str>) -> Result<Sheet> {
    let all = sheets(file)?;
    match name.filter(|n| !n.is_empty()) {
        Some(name) => all
            .iter()
            .find(|s| s.name.eq_ignore_ascii_case(name))
            .cloned()
            .ok_or_else(|| {
                Error::new(
                    4215,
                    format!(
                        "The workbook has no sheet called {name}. Its sheets: {}.",
                        all.iter()
                            .map(|s| s.name.as_str())
                            .collect::<Vec<_>>()
                            .join(", ")
                    ),
                )
            }),
        None => all
            .into_iter()
            .next()
            .ok_or_else(|| Error::new(4202, "The workbook has no sheet.")),
    }
}

/// The strings cells share, by their place in the list.
fn shared_strings(file: &Archive) -> Result<Vec<String>> {
    let Some(rel) = ooxml::rels(file, WORKBOOK)?
        .into_iter()
        .find(|r| r.kind == "sharedStrings")
    else {
        return Ok(vec![]);
    };
    let Some(xml) = file.text(&rel.target)? else {
        return Ok(vec![]);
    };
    let mut found = vec![];
    let mut current: Option<String> = None;
    let mut in_text = false;
    // Phonetic hints for East Asian text aren't part of the string.
    let mut phonetic = 0;
    for tok in tokens(&xml) {
        if opens(&tok, "si") {
            current = Some(String::new());
            if is_empty(&tok) {
                found.push(String::new());
                current = None;
            }
        } else if closes(&tok, "si") {
            found.push(current.take().unwrap_or_default());
        } else if opens(&tok, "rPh") && !is_empty(&tok) {
            phonetic += 1;
        } else if closes(&tok, "rPh") {
            phonetic -= 1;
        } else if opens(&tok, "t") {
            in_text = !is_empty(&tok) && phonetic == 0;
        } else if closes(&tok, "t") {
            in_text = false;
        } else if in_text && let Some(current) = &mut current {
            current.push_str(&text_of(&tok));
        }
    }
    Ok(found)
}

/// Whether a number format shows a date or a time.
fn date_format(id: u32, code: Option<&str>) -> bool {
    if matches!(id, 14..=22 | 27..=36 | 45..=47 | 50..=58) {
        return true;
    }
    let Some(code) = code else { return false };
    // Quoted words, colours and escaped characters aren't the format.
    let mut bare = String::new();
    let mut chars = code.chars();
    while let Some(c) = chars.next() {
        match c {
            '"' => {
                for q in chars.by_ref() {
                    if q == '"' {
                        break;
                    }
                }
            }
            '[' => {
                for q in chars.by_ref() {
                    if q == ']' {
                        break;
                    }
                }
            }
            '\\' | '_' | '*' => {
                chars.next();
            }
            c => bare.push(c.to_ascii_lowercase()),
        }
    }
    bare != "general" && bare.chars().any(|c| "ymdhs".contains(c))
}

/// Whether a number format shows a length of time, like `[h]:mm:ss`: hours
/// that run past a day, where a date format would start a new one.
fn elapsed_format(id: u32, code: Option<&str>) -> bool {
    id == 46
        || code.is_some_and(|code| {
            let code = code.to_ascii_lowercase();
            ["[h]", "[hh]", "[m]", "[mm]", "[s]", "[ss]"]
                .iter()
                .any(|unit| code.contains(unit))
        })
}

/// A number of days as hours, minutes and seconds, like `36:00:00`.
fn elapsed_text(days: f64) -> Option<String> {
    let seconds = (days.abs() * 86_400.0).round();
    (seconds < 1.0e12).then(|| {
        let seconds = seconds as i64;
        format!(
            "{}{}:{:02}:{:02}",
            if days < 0.0 && seconds > 0 { "-" } else { "" },
            seconds / 3_600,
            seconds % 3_600 / 60,
            seconds % 60
        )
    })
}

/// What a cell style makes of a number.
#[derive(Clone, Copy, PartialEq)]
enum Shows {
    Number,
    Date,
    Elapsed,
}

/// For each cell style, whether it shows a date or a length of time.
fn date_styles(file: &Archive) -> Result<Vec<Shows>> {
    let Some(rel) = ooxml::rels(file, WORKBOOK)?
        .into_iter()
        .find(|r| r.kind == "styles")
    else {
        return Ok(vec![]);
    };
    let Some(xml) = file.text(&rel.target)? else {
        return Ok(vec![]);
    };
    let mut formats: BTreeMap<u32, String> = BTreeMap::new();
    let mut styles = vec![];
    let mut in_cells = false;
    for tok in tokens(&xml) {
        if opens(&tok, "numFmt") {
            if let (Some(id), Some(code)) = (
                attr(tok.raw(), "numFmtId").and_then(|v| v.parse().ok()),
                attr(tok.raw(), "formatCode"),
            ) {
                formats.insert(id, code);
            }
        } else if opens(&tok, "cellXfs") {
            in_cells = !is_empty(&tok);
        } else if closes(&tok, "cellXfs") {
            in_cells = false;
        } else if in_cells && opens(&tok, "xf") {
            let id = attr(tok.raw(), "numFmtId")
                .and_then(|v| v.parse::<u32>().ok())
                .unwrap_or(0);
            let code = formats.get(&id).map(String::as_str);
            styles.push(if elapsed_format(id, code) {
                Shows::Elapsed
            } else if date_format(id, code) {
                Shows::Date
            } else {
                Shows::Number
            });
        }
    }
    Ok(styles)
}

/// Excel's day count as a date, a time, or both.
fn serial_text(serial: f64, from_1904: bool) -> Option<String> {
    if !serial.is_finite() || !(0.0..3_000_000.0).contains(&serial) {
        return None;
    }
    let days = serial.floor();
    let seconds = ((serial - days) * 86_400.0).round() as i64;
    let (days, seconds) = if seconds >= 86_400 {
        (days as i64 + 1, 0)
    } else {
        (days as i64, seconds)
    };
    let mut time = format!("{:02}:{:02}", seconds / 3_600, seconds % 3_600 / 60);
    if seconds % 60 != 0 {
        time.push_str(&format!(":{:02}", seconds % 60));
    }
    if days == 0 && !from_1904 {
        return Some(time);
    }
    // Day 1 is 1 January 1900, and Excel counts a 29 February 1900 that
    // never was, so every real date after it is one day less.
    let epoch = if from_1904 {
        chrono::NaiveDate::from_ymd_opt(1904, 1, 1)?
    } else if days < 61 {
        chrono::NaiveDate::from_ymd_opt(1899, 12, 31)?
    } else {
        chrono::NaiveDate::from_ymd_opt(1899, 12, 30)?
    };
    let date = epoch.checked_add_signed(chrono::Duration::days(days))?;
    Some(if seconds == 0 {
        date.to_string()
    } else {
        format!("{date} {time}")
    })
}

/// A number as JSON holds it: whole when it is whole, without the noise
/// binary fractions leave. Fifteen digits are kept, as many as Excel keeps.
fn number(n: f64) -> Value {
    if n.fract() == 0.0 && n.abs() < 9.0e15 {
        return json!(n as i64);
    }
    let rounded = format!("{n:.14e}").parse::<f64>().unwrap_or(n);
    serde_json::Number::from_f64(rounded).map_or(Value::Null, Value::Number)
}

/// A shared formula as the cell `rows` down and `columns` right of its first
/// cell holds it. Excel writes a formula filled across cells once, in the
/// first; in the others every cell it names without a `$` moves with them.
/// Whole rows and columns (`A:A`, `1:1`) stay as written.
fn moved(formula: &str, rows: i64, columns: i64) -> String {
    let named = |b: u8| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'$') || b >= 0x80;
    let bytes = formula.as_bytes();
    let mut out = String::with_capacity(formula.len());
    let mut i = 0;
    while i < bytes.len() {
        // Text, a quoted sheet name and a table's column pass as they are.
        let close = match bytes[i] {
            b'"' => Some(b'"'),
            b'\'' => Some(b'\''),
            b'[' => Some(b']'),
            _ => None,
        };
        let end = match close {
            Some(close) => bytes[i + 1..]
                .iter()
                .position(|b| *b == close)
                .map_or(bytes.len(), |at| i + at + 2),
            None if named(bytes[i]) => {
                i + bytes[i..]
                    .iter()
                    .position(|b| !named(*b))
                    .unwrap_or(bytes.len() - i)
            }
            None => i + 1,
        };
        let word = &formula[i..end];
        // A name before `(`, `!` or `[` is a function, a sheet or a table.
        let cell = (close.is_none() && !matches!(bytes.get(end), Some(b'(' | b'!' | b'[')))
            .then(|| moved_cell(word, rows, columns))
            .flatten();
        out.push_str(cell.as_deref().unwrap_or(word));
        i = end;
    }
    out
}

/// `word` moved when it is one cell's name, like `B2` or `$B2`.
fn moved_cell(word: &str, rows: i64, columns: i64) -> Option<String> {
    let (fixed_column, rest) = match word.strip_prefix('$') {
        Some(rest) => (true, rest),
        None => (false, word),
    };
    let split = rest.find(|c: char| !c.is_ascii_alphabetic())?;
    let (letters, rest) = rest.split_at(split);
    let (fixed_row, digits) = match rest.strip_prefix('$') {
        Some(rest) => (true, rest),
        None => (false, rest),
    };
    if letters.is_empty() || digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let column = i64::from(column_number(letters)?) + if fixed_column { 0 } else { columns };
    let row = digits.parse::<i64>().ok()? + if fixed_row { 0 } else { rows };
    if !(1..=i64::from(MAX_ROWS)).contains(&row) || !(1..=i64::from(MAX_COLUMNS)).contains(&column)
    {
        return Some("#REF!".into());
    }
    Some(format!(
        "{}{}{}{row}",
        if fixed_column { "$" } else { "" },
        column_name(column as u32),
        if fixed_row { "$" } else { "" },
    ))
}

/// The most text the cells of one sheet may hold together. Every cell that
/// points at a shared string holds its own copy, so a small file with one
/// long string and many cells would otherwise fill memory.
const SHEET_TEXT_CAP: usize = 32 * 1024 * 1024;

/// A sheet's cells that hold something, by (row, column): what each shows
/// and its formula when it has one.
pub(crate) struct Grid {
    pub rows: u32,
    pub columns: u32,
    cells: BTreeMap<(u32, u32), (Value, Option<String>)>,
}

impl Grid {
    /// The cells of `range` as rows, top to bottom. Empty cells at the end
    /// of a row and empty rows at the end are left off. With `formulas`, a
    /// cell with a formula shows it instead of its result.
    pub(crate) fn rows(&self, range: Range, formulas: bool) -> Vec<Value> {
        let mut rows = vec![];
        for row in range.from.0..=range.to.0.min(self.rows) {
            let mut cells = vec![];
            for column in range.from.1..=range.to.1.min(self.columns) {
                cells.push(match self.cells.get(&(row, column)) {
                    Some((_, Some(formula))) if formulas => json!(format!("={formula}")),
                    Some((shown, _)) => shown.clone(),
                    None => json!(""),
                });
            }
            while cells.last().is_some_and(|c| c == "") {
                cells.pop();
            }
            rows.push(json!(cells));
        }
        while rows
            .last()
            .is_some_and(|r| r.as_array().is_some_and(Vec::is_empty))
        {
            rows.pop();
        }
        rows
    }
}

pub(crate) fn grid(file: &Archive, sheet: &Sheet) -> Result<Grid> {
    let xml = file
        .text(&sheet.part)?
        .ok_or_else(|| Error::new(4202, "This workbook can't be read: a sheet is missing."))?;
    let strings = shared_strings(file)?;
    let dates = date_styles(file)?;
    let from_1904 = tokens(&workbook(file)?).iter().any(|tok| {
        opens(tok, "workbookPr")
            && matches!(attr(tok.raw(), "date1904").as_deref(), Some("1" | "true"))
    });
    let mut cells = BTreeMap::new();
    let (mut row, mut column) = (0u32, 0u32);
    // The cell being read: its type, style, value, formula and own text.
    let mut cell: Option<(String, Option<usize>)> = None;
    let (mut value, mut formula, mut inline) = (String::new(), None::<String>, String::new());
    // Shared formulas by their number: the cell that holds each, and it.
    let mut shared: BTreeMap<String, (u32, u32, String)> = BTreeMap::new();
    let mut sharing: Option<String> = None;
    let mut inside = "";
    let mut held = 0usize;
    for tok in tokens(&xml) {
        if opens(&tok, "row") {
            row = attr(tok.raw(), "r")
                .and_then(|r| r.parse().ok())
                .unwrap_or(row + 1);
            column = 0;
        } else if opens(&tok, "c") {
            column = attr(tok.raw(), "r")
                .and_then(|r| cell_ref(&r))
                .map_or(column + 1, |(_, c)| c);
            cell = Some((
                attr(tok.raw(), "t").unwrap_or_default(),
                attr(tok.raw(), "s").and_then(|s| s.parse().ok()),
            ));
            value.clear();
            inline.clear();
            formula = None;
            sharing = None;
            if is_empty(&tok) {
                cell = None;
            }
        } else if cell.is_some() && opens(&tok, "v") {
            inside = if is_empty(&tok) { "" } else { "v" };
        } else if cell.is_some() && opens(&tok, "f") {
            inside = if is_empty(&tok) { "" } else { "f" };
            if attr(tok.raw(), "t").as_deref() == Some("shared") {
                sharing = attr(tok.raw(), "si");
            }
        } else if cell.is_some() && opens(&tok, "t") {
            inside = if is_empty(&tok) { "" } else { "t" };
        } else if closes(&tok, "v") || closes(&tok, "f") || closes(&tok, "t") {
            inside = "";
        } else if matches!(tok, Tok::Text(_) | Tok::Literal { .. }) && !inside.is_empty() {
            let text = text_of(&tok);
            match inside {
                "v" => value.push_str(&text),
                "f" => formula.get_or_insert_default().push_str(&text),
                _ => inline.push_str(&text),
            }
        } else if closes(&tok, "c")
            && let Some((kind, style)) = cell.take()
        {
            let shown = match kind.as_str() {
                "s" => json!(
                    value
                        .trim()
                        .parse::<usize>()
                        .ok()
                        .and_then(|i| strings.get(i))
                        .cloned()
                        .unwrap_or_default()
                ),
                "inlineStr" => json!(inline),
                "str" | "e" => json!(value),
                "b" => json!(value.trim() == "1"),
                _ => match value.trim().parse::<f64>() {
                    Ok(n) => match style.and_then(|s| dates.get(s)) {
                        Some(Shows::Date) => serial_text(n, from_1904),
                        Some(Shows::Elapsed) => elapsed_text(n),
                        _ => None,
                    }
                    .map_or_else(|| number(n), |text| json!(text)),
                    Err(_) => json!(value),
                },
            };
            if let Some(number) = sharing.take() {
                match (&formula, shared.get(&number)) {
                    (Some(first), _) => {
                        shared.insert(number, (row, column, first.clone()));
                    }
                    (None, Some((from_row, from_column, first))) => {
                        formula = Some(moved(
                            first,
                            i64::from(row) - i64::from(*from_row),
                            i64::from(column) - i64::from(*from_column),
                        ));
                    }
                    (None, None) => {}
                }
            }
            held += shown.as_str().map_or(0, str::len) + formula.as_ref().map_or(0, String::len);
            if held > SHEET_TEXT_CAP {
                return Err(Error::new(
                    4202,
                    "This workbook can't be read: a sheet holds too much text.",
                ));
            }
            if shown != "" || formula.is_some() {
                cells.insert((row, column), (shown, formula.take()));
            }
        }
    }
    Ok(Grid {
        rows: cells.keys().map(|(r, _)| *r).max().unwrap_or(0),
        columns: cells.keys().map(|(_, c)| *c).max().unwrap_or(0),
        cells,
    })
}

// --- Writing --------------------------------------------------------------

/// What a bot puts in a cell.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Cell {
    /// Leaves the cell as it is.
    Skip,
    /// Clears the cell.
    Empty,
    Text(String),
    Number(f64),
    Bool(bool),
    /// Without its leading `=`.
    Formula(String),
}

impl Cell {
    /// A cell from the JSON a bot sends, as Google Sheets reads the same:
    /// a number stays a number, text that starts with `=` is a formula,
    /// null leaves the cell alone and empty text clears it.
    pub(crate) fn from_json(value: &Value) -> Result<Self> {
        Ok(match value {
            Value::Null => Cell::Skip,
            Value::Bool(b) => Cell::Bool(*b),
            Value::Number(n) => match n.as_f64().filter(|n| n.is_finite()) {
                Some(n) => Cell::Number(n),
                None => Cell::Text(n.to_string()),
            },
            Value::String(s) if s.is_empty() => Cell::Empty,
            Value::String(s) if s.chars().count() > CELL_TEXT_CAP => {
                return Err(Error::new(4202, "A cell holds at most 32,767 characters."));
            }
            Value::String(s) => match s.strip_prefix('=').filter(|f| !f.trim().is_empty()) {
                Some(formula) => Cell::Formula(formula.to_owned()),
                None => Cell::Text(s.clone()),
            },
            other => Cell::Text(other.to_string()),
        })
    }
}

/// Rows of cells from the JSON a bot sends: a list of lists.
pub(crate) fn cells(value: &Value) -> Result<Vec<Vec<Cell>>> {
    let invalid = || {
        Error::new(
            4202,
            "rows must be a list of rows, each a list of cells: [[\"Name\", \"Total\"], [\"Ana\", 12]]",
        )
    };
    let rows = value.as_array().ok_or_else(invalid)?;
    if rows.is_empty() {
        return Err(Error::new(4202, "rows is empty"));
    }
    if rows.len() > 50_000 {
        return Err(Error::new(4202, "Write at most 50,000 rows at a time."));
    }
    rows.iter()
        .map(|row| {
            let row = row.as_array().ok_or_else(invalid)?;
            if row.len() as u32 > MAX_COLUMNS {
                return Err(Error::new(4202, "A row holds at most 16,384 cells."));
            }
            row.iter().map(Cell::from_json).collect()
        })
        .collect()
}

/// One cell's XML, or None to leave the cell out: an empty cell keeps
/// only a style it had. `p` is the namespace prefix the sheet's tags use.
fn cell_xml(p: &str, row: u32, column: u32, style: Option<&str>, cell: &Cell) -> Option<String> {
    let at = cell_name(row, column);
    let style = style
        .filter(|s| !s.is_empty())
        .map(|s| format!(r#" s="{}""#, escape(s)))
        .unwrap_or_default();
    Some(match cell {
        Cell::Skip => return None,
        Cell::Empty if style.is_empty() => return None,
        Cell::Empty => format!(r#"<{p}c r="{at}"{style}/>"#),
        Cell::Text(text) => format!(
            r#"<{p}c r="{at}"{style} t="inlineStr"><{p}is><{p}t xml:space="preserve">{}</{p}t></{p}is></{p}c>"#,
            escape(text)
        ),
        Cell::Number(n) => format!(r#"<{p}c r="{at}"{style}><{p}v>{n}</{p}v></{p}c>"#),
        Cell::Bool(b) => format!(
            r#"<{p}c r="{at}"{style} t="b"><{p}v>{}</{p}v></{p}c>"#,
            u8::from(*b)
        ),
        Cell::Formula(formula) => {
            format!(
                r#"<{p}c r="{at}"{style}><{p}f>{}</{p}f></{p}c>"#,
                escape(formula)
            )
        }
    })
}

/// A row as the sheet holds it: its opening tag, its cells in column
/// order as their XML, and anything else it held.
struct Row {
    number: u32,
    open: String,
    cells: Vec<(u32, String)>,
    rest: String,
}

/// `tag` without its `name="…"` attribute.
fn without_attr(tag: &str, name: &str) -> String {
    let needle = format!(" {name}=\"");
    match tag.find(&needle) {
        Some(start) => match tag[start + needle.len()..].find('"') {
            Some(len) => format!(
                "{}{}",
                &tag[..start],
                &tag[start + needle.len() + len + 1..]
            ),
            None => tag.to_owned(),
        },
        None => tag.to_owned(),
    }
}

/// The sheet's XML with `rows` written from (`row`, `column`) down and
/// right. Other cells, and everything else in the sheet, stay.
fn write_sheet(xml: &str, row: u32, column: u32, rows: &[Vec<Cell>]) -> Result<String> {
    let last_row = u64::from(row) + rows.len() as u64 - 1;
    let widest = rows.iter().map(Vec::len).max().unwrap_or(0) as u64;
    if last_row > u64::from(MAX_ROWS)
        || u64::from(column) + widest.max(1) - 1 > u64::from(MAX_COLUMNS)
    {
        return Err(Error::new(4202, "That goes past the edge of the sheet."));
    }
    let damaged = || Error::new(4202, "This sheet can't be changed: it holds no cell data.");
    let toks = tokens(xml);
    let start = toks
        .iter()
        .position(|t| opens(t, "sheetData"))
        .ok_or_else(damaged)?;
    let prefix = match toks[start] {
        Tok::Open { name, .. } => name.strip_suffix("sheetData").unwrap_or("").to_owned(),
        _ => String::new(),
    };
    let p = prefix.as_str();
    let end = if is_empty(&toks[start]) {
        start
    } else {
        start
            + toks[start..]
                .iter()
                .position(|t| closes(t, "sheetData"))
                .ok_or_else(damaged)?
    };
    // Read the rows as they are.
    let mut sheet: Vec<Row> = vec![];
    let mut i = start + 1;
    while i < end {
        if !opens(&toks[i], "row") {
            i += 1;
            continue;
        }
        let raw = toks[i].raw();
        let number = attr(raw, "r")
            .and_then(|r| r.parse().ok())
            .unwrap_or_else(|| sheet.last().map_or(1, |r| r.number + 1));
        let mut current = Row {
            number,
            // A row written without its number gets it, so order is safe.
            open: if attr(raw, "r").is_some() {
                raw.trim_end_matches("/>").trim_end_matches('>').to_owned()
            } else {
                format!(r#"<{p}row r="{number}""#)
            },
            cells: vec![],
            rest: String::new(),
        };
        let closed = is_empty(&toks[i]);
        i += 1;
        while !closed && i < end && !closes(&toks[i], "row") {
            if opens(&toks[i], "c") {
                let raw = toks[i].raw();
                let at = attr(raw, "r")
                    .and_then(|r| cell_ref(&r))
                    .map_or_else(|| current.cells.last().map_or(1, |c| c.0 + 1), |(_, c)| c);
                let mut text = if attr(raw, "r").is_some() {
                    raw.to_owned()
                } else {
                    raw.replacen(
                        &format!("<{p}c"),
                        &format!(r#"<{p}c r="{}""#, cell_name(number, at)),
                        1,
                    )
                };
                if !is_empty(&toks[i]) {
                    i += 1;
                    while i < end && !closes(&toks[i], "c") {
                        text.push_str(toks[i].raw());
                        i += 1;
                    }
                    if i < end {
                        text.push_str(toks[i].raw());
                    }
                }
                current.cells.push((at, text));
            } else {
                current.rest.push_str(toks[i].raw());
            }
            i += 1;
        }
        if !closed {
            // Past the row's closing tag.
            i += 1;
        }
        sheet.push(current);
    }
    // Write the new cells over them.
    for (offset, cells) in rows.iter().enumerate() {
        let number = row + offset as u32;
        let at = match sheet.binary_search_by_key(&number, |r| r.number) {
            Ok(at) => at,
            Err(at) => {
                sheet.insert(
                    at,
                    Row {
                        number,
                        open: format!(r#"<{p}row r="{number}""#),
                        cells: vec![],
                        rest: String::new(),
                    },
                );
                at
            }
        };
        let target = &mut sheet[at];
        // A hint of the row's width that the new cells may break.
        target.open = without_attr(&target.open, "spans");
        for (offset, cell) in cells.iter().enumerate() {
            if *cell == Cell::Skip {
                continue;
            }
            let column = column + offset as u32;
            let found = target.cells.binary_search_by_key(&column, |c| c.0);
            let old = found.ok().map(|i| target.cells[i].1.clone());
            // The first cell of a formula that fills a range holds it for
            // the others.
            let shared = old.as_deref().is_some_and(|old| {
                tokens(old)
                    .iter()
                    .any(|t| opens(t, "f") && attr(t.raw(), "ref").is_some_and(|r| r.contains(':')))
            });
            if shared {
                return Err(Error::new(
                    4202,
                    format!(
                        "{} starts a formula other cells share, so it can't be written over here. Download the workbook, change it, and upload it.",
                        cell_name(number, column)
                    ),
                ));
            }
            let style = old
                .as_deref()
                .and_then(|old| attr(old.split('>').next().unwrap_or(""), "s"));
            match (cell_xml(p, number, column, style.as_deref(), cell), found) {
                (Some(xml), Ok(i)) => target.cells[i].1 = xml,
                (Some(xml), Err(i)) => target.cells.insert(i, (column, xml)),
                (None, Ok(i)) => {
                    target.cells.remove(i);
                }
                (None, Err(_)) => {}
            }
        }
    }
    let mut body = format!("<{p}sheetData>");
    let (mut low, mut high) = ((u32::MAX, u32::MAX), (0, 0));
    for row in &sheet {
        if let (Some(first), Some(last)) = (row.cells.first(), row.cells.last()) {
            low = (low.0.min(row.number), low.1.min(first.0));
            high = (high.0.max(row.number), high.1.max(last.0));
        }
        body.push_str(&row.open);
        if row.cells.is_empty() && row.rest.is_empty() {
            body.push_str("/>");
            continue;
        }
        body.push('>');
        for (_, cell) in &row.cells {
            body.push_str(cell);
        }
        body.push_str(&row.rest);
        body.push_str(&format!("</{p}row>"));
    }
    body.push_str(&format!("</{p}sheetData>"));
    let mut out = String::with_capacity(xml.len() + body.len());
    for (i, tok) in toks.iter().enumerate() {
        if i == start {
            out.push_str(&body);
        } else if i > start && i <= end {
            // Replaced by the rows above.
        } else if opens(tok, "dimension") {
            // The area in use, which now reaches the new cells.
            let area = if high == (0, 0) {
                "A1".to_owned()
            } else {
                Range {
                    from: low,
                    to: high,
                }
                .name()
            };
            out.push_str(&format!(r#"<{p}dimension ref="{area}"/>"#));
        } else if closes(tok, "dimension") {
            // Written whole above.
        } else {
            out.push_str(tok.raw());
        }
    }
    Ok(out)
}

/// The workbook part asking Excel to work every formula out again when it
/// opens: results kept in the file are from before the change.
fn recalculate(xml: &str) -> String {
    let toks = tokens(xml);
    let prefix = toks
        .iter()
        .find_map(|t| match t {
            Tok::Open { name, .. } if local(name) == "workbook" => {
                Some(name.strip_suffix("workbook").unwrap_or("").to_owned())
            }
            _ => None,
        })
        .unwrap_or_default();
    if let Some(tok) = toks.iter().find(|t| opens(t, "calcPr")) {
        let raw = tok.raw();
        let tag = without_attr(raw, "fullCalcOnLoad");
        let (head, tail) = match tag.strip_suffix("/>") {
            Some(head) => (head, "/>"),
            None => (tag.trim_end_matches('>'), ">"),
        };
        return xml.replacen(raw, &format!(r#"{head} fullCalcOnLoad="1"{tail}"#), 1);
    }
    // Where the schema puts it: before whichever of these comes first.
    let after = [
        "oleSize",
        "customWorkbookViews",
        "pivotCaches",
        "smartTagPr",
        "smartTagTypes",
        "webPublishing",
        "fileRecoveryPr",
        "webPublishObjects",
        "extLst",
    ];
    let mut at = 0;
    let mut found = None;
    // Only the workbook's own children count: a view may hold an extLst too.
    let mut depth = 0;
    for tok in &toks {
        let here = match tok {
            Tok::Open { name, .. } => depth == 1 && after.contains(&local(name)),
            Tok::Close { name, .. } => local(name) == "workbook",
            _ => false,
        };
        if here {
            found = Some(at);
            break;
        }
        match tok {
            Tok::Open { empty: false, .. } => depth += 1,
            Tok::Close { .. } => depth -= 1,
            _ => {}
        }
        at += tok.raw().len();
    }
    match found {
        Some(at) => format!(
            r#"{}<{prefix}calcPr fullCalcOnLoad="1"/>{}"#,
            &xml[..at],
            &xml[at..]
        ),
        None => xml.to_owned(),
    }
}

/// `xml` without the tags named `tag` for which `drop` holds.
fn without_tags(xml: &str, tag: &str, drop: impl Fn(&str) -> bool) -> String {
    let toks = tokens(xml);
    let mut out = String::with_capacity(xml.len());
    let mut skipping = false;
    for tok in &toks {
        if opens(tok, tag) && drop(tok.raw()) {
            skipping = !is_empty(tok);
            continue;
        }
        if skipping {
            skipping = !closes(tok, tag);
            continue;
        }
        out.push_str(tok.raw());
    }
    out
}

/// The workbook with `rows` written into `sheet` from (`row`, `column`).
pub(crate) fn write(
    file: &Archive,
    sheet: &Sheet,
    row: u32,
    column: u32,
    rows: &[Vec<Cell>],
) -> Result<Vec<u8>> {
    let xml = file
        .text(&sheet.part)?
        .ok_or_else(|| Error::new(4202, "This workbook can't be read: a sheet is missing."))?;
    let mut changes = vec![
        (
            sheet.part.clone(),
            Some(write_sheet(&xml, row, column, rows)?.into_bytes()),
        ),
        (
            WORKBOOK.to_owned(),
            Some(recalculate(&workbook(file)?).into_bytes()),
        ),
    ];
    // Excel's list of the order formulas were worked out in names cells
    // that may no longer hold one; without it Excel builds a new list.
    if let Some(chain) = ooxml::rels(file, WORKBOOK)?
        .into_iter()
        .find(|r| r.kind == "calcChain")
    {
        let rels = ooxml::rels_name(WORKBOOK);
        if let Some(xml) = file.text(&rels)? {
            changes.push((
                rels,
                Some(
                    without_tags(&xml, "Relationship", |raw| {
                        attr(raw, "Id").as_deref() == Some(chain.id.as_str())
                    })
                    .into_bytes(),
                ),
            ));
        }
        if let Some(xml) = file.text("[Content_Types].xml")? {
            let part = format!("/{}", chain.target);
            changes.push((
                "[Content_Types].xml".to_owned(),
                Some(
                    without_tags(&xml, "Override", |raw| {
                        attr(raw, "PartName").as_deref() == Some(part.as_str())
                    })
                    .into_bytes(),
                ),
            ));
        }
        changes.push((chain.target, None));
    }
    Ok(file.with(&changes))
}

/// The workbook with `rows` added under the sheet's last row that holds
/// anything, from column A, and the row they start at.
pub(crate) fn append(file: &Archive, sheet: &Sheet, rows: &[Vec<Cell>]) -> Result<(Vec<u8>, u32)> {
    let row = grid(file, sheet)?.rows + 1;
    Ok((write(file, sheet, row, 1, rows)?, row))
}

/// A sheet name Excel accepts: no `[]:*?/\`, 31 characters at most, and
/// not one of `taken`.
fn sheet_name(wanted: &str, index: usize, taken: &[String]) -> String {
    let clean: String = wanted
        .chars()
        .map(|c| if "[]:*?/\\".contains(c) { ' ' } else { c })
        .collect();
    let clean = clean.trim().trim_matches('\'').trim();
    let base: String = if clean.is_empty() {
        format!("Sheet{}", index + 1)
    } else {
        clean.chars().take(31).collect()
    };
    let mut name = base.clone();
    let mut n = 2;
    while taken.iter().any(|t| t.eq_ignore_ascii_case(&name)) {
        let suffix = format!(" {n}");
        name = format!(
            "{}{suffix}",
            base.chars().take(31 - suffix.len()).collect::<String>()
        );
        n += 1;
    }
    name
}

/// A new workbook with these sheets, each a name and its rows.
pub(crate) fn create(title: &str, sheets: &[(String, Vec<Vec<Cell>>)]) -> Result<Vec<u8>> {
    const MAIN: &str = r#"xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main""#;
    let mut names: Vec<String> = vec![];
    for (i, (name, _)) in sheets.iter().enumerate() {
        let name = sheet_name(name, i, &names);
        names.push(name);
    }
    let mut types = String::from(
        r#"<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>"#,
    );
    let mut book = format!(
        r#"<workbook {MAIN} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>"#
    );
    let mut rels = String::from(
        r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">"#,
    );
    let mut parts: Vec<(String, Vec<u8>)> = vec![];
    let empty = format!(r#"<worksheet {MAIN}><sheetData/></worksheet>"#);
    for (i, ((_, rows), name)) in sheets.iter().zip(&names).enumerate() {
        let n = i + 1;
        types.push_str(&format!(
            r#"<Override PartName="/xl/worksheets/sheet{n}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>"#
        ));
        book.push_str(&format!(
            r#"<sheet name="{}" sheetId="{n}" r:id="rId{n}"/>"#,
            escape(name)
        ));
        rels.push_str(&format!(
            r#"<Relationship Id="rId{n}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet{n}.xml"/>"#
        ));
        let xml = if rows.is_empty() {
            empty.clone()
        } else {
            write_sheet(&empty, 1, 1, rows)?
        };
        parts.push((format!("xl/worksheets/sheet{n}.xml"), ooxml::part(&xml)));
    }
    types.push_str("</Types>");
    book.push_str(r#"</sheets><calcPr fullCalcOnLoad="1"/></workbook>"#);
    rels.push_str(&format!(
        r#"<Relationship Id="rId{}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>"#,
        sheets.len() + 1
    ));
    let styles = format!(
        r#"<styleSheet {MAIN}><fonts count="1"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>"#
    );
    let mut all: Vec<(&str, Vec<u8>)> = vec![
        ("[Content_Types].xml", ooxml::part(&types)),
        (
            "_rels/.rels",
            ooxml::part(
                r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>"#,
            ),
        ),
        ("docProps/core.xml", ooxml::core(title)),
        (WORKBOOK, ooxml::part(&book)),
        ("xl/_rels/workbook.xml.rels", ooxml::part(&rels)),
        ("xl/styles.xml", ooxml::part(&styles)),
    ];
    for (name, bytes) in &parts {
        all.push((name.as_str(), bytes.clone()));
    }
    Ok(zip::build(&all))
}

#[cfg(test)]
#[path = "excel_tests.rs"]
mod tests;
