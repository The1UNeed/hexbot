//! Google Sheets: read as rows of cells, made new, and written a range at a
//! time. What a bot writes is what the cell holds: a number is a number,
//! text starting with `=` is a formula, a date like 2026-11-12 is a date,
//! and other text stays the text it is.
use crate::{
    Error, Result,
    accounts::{self, SHEETS_API, Service, enc},
    drive,
    excel::{self, Cell, Range},
};
use reqwest::Method;
use serde_json::{Value, json};
use std::path::Path;

async fn call(
    home: &Path,
    svc: &Service,
    method: Method,
    path: &str,
    body: Option<&Value>,
) -> Result<Value> {
    accounts::api(
        home,
        svc,
        None,
        method,
        SHEETS_API,
        path,
        body,
        &[],
        "spreadsheet",
    )
    .await
}

/// A sheet's name as a range names it: quoted, a quote in it doubled.
fn quoted(sheet: &str) -> String {
    format!("'{}'", sheet.replace('\'', "''"))
}

/// A spreadsheet's title and its sheets with their sizes. Each sheet also
/// carries its `sheet_id`, which a change to its size names it by.
async fn info(home: &Path, svc: &Service, id: &str) -> Result<(String, Vec<Value>)> {
    let found = call(
        home,
        svc,
        Method::GET,
        &format!(
            "/v4/spreadsheets/{}?fields=properties.title,sheets.properties(sheetId,title,gridProperties(rowCount,columnCount))",
            drive::id(id)?
        ),
        None,
    )
    .await?;
    let sheets = found["sheets"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|s| {
            json!({
                "name": s["properties"]["title"],
                "rows": s["properties"]["gridProperties"]["rowCount"],
                "columns": s["properties"]["gridProperties"]["columnCount"],
                "sheet_id": s["properties"]["sheetId"].as_i64().unwrap_or(0),
            })
        })
        .collect();
    Ok((
        found["properties"]["title"]
            .as_str()
            .unwrap_or("")
            .to_owned(),
        sheets,
    ))
}

/// A sheet's rows and columns, as `info` found them: without end when it
/// didn't say.
fn size(sheets: &[Value], name: &str) -> (u32, u32) {
    let sheet = sheets.iter().find(|s| s["name"] == name);
    let side = |key: &str| {
        sheet
            .and_then(|s| s[key].as_u64())
            .map_or(u32::MAX, |n| n.min(u64::from(u32::MAX)) as u32)
    };
    (side("rows"), side("columns"))
}

/// The sheets as a bot is shown them: name and size.
fn shown(sheets: &[Value]) -> Vec<Value> {
    sheets
        .iter()
        .map(|s| json!({"name": s["name"], "rows": s["rows"], "columns": s["columns"]}))
        .collect()
}

/// The name of the sheet a call means: the one named, checked against the
/// spreadsheet's own, or its first.
fn pick(sheets: &[Value], name: Option<&str>) -> Result<String> {
    let names = sheets
        .iter()
        .filter_map(|s| s["name"].as_str())
        .collect::<Vec<_>>();
    match name.filter(|n| !n.is_empty()) {
        Some(name) => names
            .iter()
            .find(|n| n.eq_ignore_ascii_case(name))
            .map(|n| (*n).to_owned())
            .ok_or_else(|| {
                Error::new(
                    4215,
                    format!(
                        "The spreadsheet has no sheet called {name}. Its sheets: {}.",
                        names.join(", ")
                    ),
                )
            }),
        None => names
            .first()
            .map(|n| (*n).to_owned())
            .ok_or_else(|| Error::new(4202, "The spreadsheet has no sheet.")),
    }
}

/// The cells of `range` in `sheet` as rows, as the spreadsheet shows them,
/// or with `formulas` as they were typed: at most `cap` cells, and only
/// those the sheet has, since Sheets refuses a range that leaves its grid.
/// With them, the range they are and the rest of what was asked for.
pub(crate) async fn read(
    home: &Path,
    svc: &Service,
    id: &str,
    sheet: Option<&str>,
    range: Range,
    formulas: bool,
    cap: u32,
) -> Result<(Value, Range, Option<Range>)> {
    let (title, sheets) = info(home, svc, id).await?;
    let sheet = pick(&sheets, sheet)?;
    let (rows, columns) = size(&sheets, &sheet);
    let about = |rows: Vec<Value>| {
        json!({
            "title": title,
            "sheets": shown(&sheets),
            "sheet": sheet,
            "rows": rows,
        })
    };
    let Some((range, rest)) = range.window(rows, columns, cap) else {
        return Ok((about(vec![]), range, None));
    };
    let found = call(
        home,
        svc,
        Method::GET,
        &format!(
            "/v4/spreadsheets/{}/values/{}?majorDimension=ROWS&valueRenderOption={}",
            drive::id(id)?,
            enc(&format!("{}!{}", quoted(&sheet), range.name())),
            if formulas {
                "FORMULA"
            } else {
                "FORMATTED_VALUE"
            }
        ),
        None,
    )
    .await?;
    Ok((
        about(found["values"].as_array().cloned().unwrap_or_default()),
        range,
        rest,
    ))
}

/// Text as Sheets takes it typed. Sheets reads what is typed for what it
/// looks like, so "007" would become 7 and "+64 21 555 0101" a broken
/// formula: an apostrophe in front, which Sheets does not show, keeps text
/// as it is. A date like 2026-11-12 goes without one and becomes a date.
fn typed(text: &str) -> String {
    let dated = chrono::NaiveDate::parse_from_str(text, "%Y-%m-%d").is_ok()
        || ["%Y-%m-%d %H:%M", "%Y-%m-%d %H:%M:%S"]
            .iter()
            .any(|form| chrono::NaiveDateTime::parse_from_str(text, form).is_ok());
    if dated {
        text.to_owned()
    } else {
        format!("'{text}")
    }
}

/// Cells as the JSON Sheets takes.
fn values(rows: &[Vec<Cell>]) -> Value {
    json!(
        rows.iter()
            .map(|row| {
                row.iter()
                    .map(|cell| match cell {
                        // Sheets leaves a cell sent as null alone.
                        Cell::Skip => Value::Null,
                        Cell::Empty => json!(""),
                        Cell::Text(text) => json!(typed(text)),
                        Cell::Number(n) => json!(n),
                        Cell::Bool(b) => json!(b),
                        Cell::Formula(formula) => json!(format!("={formula}")),
                    })
                    .collect::<Vec<_>>()
            })
            .collect::<Vec<_>>()
    )
}

/// A new spreadsheet with these sheets, each a name and its rows.
pub(crate) async fn create(
    home: &Path,
    svc: &Service,
    title: &str,
    sheets: &[(String, Vec<Vec<Cell>>)],
) -> Result<Value> {
    let mut names: Vec<String> = vec![];
    for (i, (name, _)) in sheets.iter().enumerate() {
        let name = name.trim();
        let mut name = if name.is_empty() {
            format!("Sheet{}", i + 1)
        } else {
            name.chars().take(100).collect()
        };
        while names.iter().any(|n| n.eq_ignore_ascii_case(&name)) {
            name.push_str(" 2");
        }
        names.push(name);
    }
    let made = call(
        home,
        svc,
        Method::POST,
        "/v4/spreadsheets?fields=spreadsheetId,spreadsheetUrl",
        Some(&json!({
            "properties": {"title": drive::file_name(title, "Untitled spreadsheet")},
            // A new sheet is 1,000 rows by 26 columns, and Sheets refuses
            // values past its edge: one with more is made that large.
            "sheets": names.iter().zip(sheets).map(|(name, (_, rows))| json!({"properties": {
                "title": name,
                "gridProperties": {
                    "rowCount": rows.len().max(1_000),
                    "columnCount": rows.iter().map(Vec::len).max().unwrap_or(0).max(26),
                },
            }})).collect::<Vec<_>>(),
        })),
    )
    .await?;
    let id = made["spreadsheetId"].as_str().unwrap_or("").to_owned();
    let data = sheets
        .iter()
        .zip(&names)
        .filter(|((_, rows), _)| !rows.is_empty())
        .map(|((_, rows), name)| json!({"range": format!("{}!A1", quoted(name)), "values": values(rows)}))
        .collect::<Vec<_>>();
    if !data.is_empty() {
        call(
            home,
            svc,
            Method::POST,
            &format!("/v4/spreadsheets/{}/values:batchUpdate", drive::id(&id)?),
            Some(&json!({"valueInputOption": "USER_ENTERED", "data": data})),
        )
        .await?;
    }
    Ok(json!({"id": id, "link": made["spreadsheetUrl"], "sheets": names}))
}

/// Writes `rows` into `sheet` from the cell (`row`, `column`) down and
/// right, and says which range it filled.
pub(crate) async fn write(
    home: &Path,
    svc: &Service,
    id: &str,
    sheet: Option<&str>,
    at: (u32, u32),
    rows: &[Vec<Cell>],
) -> Result<String> {
    let (_, sheets) = info(home, svc, id).await?;
    let sheet = pick(&sheets, sheet)?;
    // Sheets refuses values past the sheet's edge, so the sheet grows first.
    let (have_rows, have_columns) = size(&sheets, &sheet);
    let widest = rows.iter().map(Vec::len).max().unwrap_or(0) as u64;
    let grow = [
        ("ROWS", u64::from(at.0) + rows.len() as u64 - 1, have_rows),
        ("COLUMNS", u64::from(at.1) + widest.max(1) - 1, have_columns),
    ]
    .iter()
    .filter(|(_, need, have)| *need > u64::from(*have))
    .map(|(dimension, need, have)| {
        json!({"appendDimension": {
            "sheetId": sheets.iter().find(|s| s["name"] == sheet.as_str()).map(|s| s["sheet_id"].clone()),
            "dimension": dimension,
            "length": need - u64::from(*have),
        }})
    })
    .collect::<Vec<_>>();
    if !grow.is_empty() {
        call(
            home,
            svc,
            Method::POST,
            &format!("/v4/spreadsheets/{}:batchUpdate", drive::id(id)?),
            Some(&json!({"requests": grow})),
        )
        .await?;
    }
    let done = call(
        home,
        svc,
        Method::PUT,
        &format!(
            "/v4/spreadsheets/{}/values/{}?valueInputOption=USER_ENTERED",
            drive::id(id)?,
            enc(&format!(
                "{}!{}",
                quoted(&sheet),
                excel::cell_name(at.0, at.1)
            ))
        ),
        Some(&json!({"values": values(rows)})),
    )
    .await?;
    Ok(done["updatedRange"].as_str().unwrap_or("").to_owned())
}

/// Adds `rows` under the last row of `sheet` that holds anything, and says
/// which range they filled.
pub(crate) async fn append(
    home: &Path,
    svc: &Service,
    id: &str,
    sheet: Option<&str>,
    rows: &[Vec<Cell>],
) -> Result<String> {
    let (_, sheets) = info(home, svc, id).await?;
    let sheet = pick(&sheets, sheet)?;
    let done = call(
        home,
        svc,
        Method::POST,
        &format!(
            "/v4/spreadsheets/{}/values/{}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS",
            drive::id(id)?,
            enc(&format!("{}!A1", quoted(&sheet)))
        ),
        Some(&json!({"values": values(rows)})),
    )
    .await?;
    Ok(done["updates"]["updatedRange"]
        .as_str()
        .unwrap_or("")
        .to_owned())
}

#[cfg(test)]
#[path = "sheets_tests.rs"]
mod tests;
