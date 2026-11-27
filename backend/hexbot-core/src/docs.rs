//! Google Docs: read as text, written from Markdown, added to, and searched
//! and replaced. A new document is HTML that Drive turns into a document;
//! one that exists is changed through the Docs API, which counts places in
//! UTF-16 units.
use crate::{
    Error, Result,
    accounts::{self, DOCS_API, Service},
    drive::{self, File, GOOGLE_DOC},
    markdown::{self, Block, Run},
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
        DOCS_API,
        path,
        body,
        &[],
        "document",
    )
    .await
}

// --- Reading --------------------------------------------------------------

/// The text of a paragraph's pieces.
fn paragraph_text(paragraph: &Value) -> String {
    let mut text = String::new();
    for element in paragraph["elements"].as_array().into_iter().flatten() {
        if let Some(run) = element["textRun"]["content"].as_str() {
            text.push_str(run);
        } else if let Some(title) = element["richLink"]["richLinkProperties"]["title"].as_str() {
            text.push_str(title);
        } else if let Some(name) = element["person"]["personProperties"]["name"].as_str() {
            text.push_str(name);
        }
    }
    // A line break inside a paragraph is a vertical tab.
    text.replace('\u{b}', "\n")
        .trim_end_matches('\n')
        .to_owned()
}

/// Whether a list numbers its items at `level`.
fn numbered(lists: &Value, list: &str, level: usize) -> bool {
    lists[list]["listProperties"]["nestingLevels"][level]["glyphType"]
        .as_str()
        .is_some_and(|glyph| !matches!(glyph, "GLYPH_TYPE_UNSPECIFIED" | "NONE"))
}

/// The document's content as text: headings as `#`, list items as `-` or
/// `1.`, tables as rows of `|` cells.
fn render(content: &Value, lists: &Value, out: &mut Vec<String>, was_item: &mut bool) {
    for element in content.as_array().into_iter().flatten() {
        if let Some(paragraph) = element.get("paragraph") {
            let text = paragraph_text(paragraph);
            if text.trim().is_empty() {
                continue;
            }
            let heading = match paragraph["paragraphStyle"]["namedStyleType"].as_str() {
                Some("TITLE") => Some(1),
                Some(style) => style
                    .strip_prefix("HEADING_")
                    .and_then(|n| n.parse::<usize>().ok()),
                None => None,
            };
            let bullet = &paragraph["bullet"];
            let item = heading.is_none() && bullet.is_object();
            let line = if let Some(level) = heading {
                format!("{} {text}", "#".repeat(level.clamp(1, 6)))
            } else if item {
                let level = bullet["nestingLevel"].as_u64().unwrap_or(0) as usize;
                let mark = if numbered(lists, bullet["listId"].as_str().unwrap_or(""), level) {
                    "1."
                } else {
                    "-"
                };
                format!("{}{mark} {text}", "  ".repeat(level.min(8)))
            } else {
                text
            };
            // List items sit on consecutive lines; the rest are apart.
            match out.last_mut() {
                Some(last) if item && *was_item => {
                    last.push('\n');
                    last.push_str(&line);
                }
                _ => out.push(line),
            }
            *was_item = item;
        } else if let Some(table) = element.get("table") {
            let rows = table["tableRows"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|row| {
                    let cells = row["tableCells"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .map(|cell| {
                            let mut inner = vec![];
                            render(&cell["content"], lists, &mut inner, &mut false);
                            inner.join(" ").replace('\n', " ").replace('|', "\\|")
                        })
                        .collect::<Vec<_>>();
                    format!("| {} |", cells.join(" | "))
                })
                .collect::<Vec<_>>();
            if !rows.is_empty() {
                out.push(rows.join("\n"));
                *was_item = false;
            }
        }
    }
}

/// A document's tabs, each with the tabs under it after it.
fn tabs<'a>(list: &'a Value, out: &mut Vec<&'a Value>) {
    for tab in list.as_array().into_iter().flatten() {
        out.push(tab);
        tabs(&tab["childTabs"], out);
    }
}

/// A document's title and its text: every tab's, since a replace reaches
/// every tab. With more than one, each starts with its name.
pub(crate) async fn read(home: &Path, svc: &Service, id: &str) -> Result<(String, String)> {
    let document = call(
        home,
        svc,
        Method::GET,
        &format!(
            "/v1/documents/{}?includeTabsContent=true&fields=title,tabs",
            drive::id(id)?
        ),
        None,
    )
    .await?;
    let mut all = vec![];
    tabs(&document["tabs"], &mut all);
    let mut out = vec![];
    for tab in &all {
        if all.len() > 1 {
            out.push(format!(
                "[Tab: {}]",
                tab["tabProperties"]["title"].as_str().unwrap_or("Untitled")
            ));
        }
        render(
            &tab["documentTab"]["body"]["content"],
            &tab["documentTab"]["lists"],
            &mut out,
            &mut false,
        );
    }
    Ok((
        document["title"].as_str().unwrap_or("").to_owned(),
        out.join("\n\n"),
    ))
}

// --- Writing --------------------------------------------------------------

/// A new document called `title` from Markdown.
pub(crate) async fn create(home: &Path, svc: &Service, title: &str, content: &str) -> Result<File> {
    let html = format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"></head><body>{}</body></html>",
        markdown::html(content)
    );
    drive::put_new(
        home,
        svc,
        &drive::file_name(title, "Untitled document"),
        None,
        html.as_bytes(),
        "text/html",
        Some(GOOGLE_DOC),
    )
    .await
}

/// A paragraph to add: its text, its heading level or 0, whether it is a
/// list item and of which kind, and the styled stretches inside it as
/// (start, end, run) in UTF-16 units from the paragraph's start.
struct Para {
    text: String,
    heading: u8,
    item: Option<bool>,
    spans: Vec<(usize, usize, Run)>,
}

fn units(text: &str) -> usize {
    text.encode_utf16().count()
}

fn para(runs: &[Run], heading: u8, item: Option<bool>, indent: u8) -> Para {
    // Tabs in front say how deep a list item sits; Docs reads and drops them.
    let mut text = "\t".repeat(indent as usize);
    let mut spans = vec![];
    for run in runs {
        // A break inside a paragraph, not a new one.
        let piece = run.text.replace('\n', "\u{b}");
        let start = units(&text);
        text.push_str(&piece);
        if run.bold || run.italic || run.code || run.link.is_some() {
            spans.push((start, units(&text), run.clone()));
        }
    }
    Para {
        text,
        heading,
        item,
        spans,
    }
}

fn paragraphs(blocks: &[Block]) -> Vec<Para> {
    let mut out = vec![];
    for block in blocks {
        match block {
            Block::Heading(level, runs) => out.push(para(runs, *level, None, 0)),
            Block::Paragraph(runs) => out.push(para(runs, 0, None, 0)),
            Block::Item {
                ordered,
                level,
                runs,
                ..
            } => out.push(para(runs, 0, Some(*ordered), *level)),
            Block::Code(text) => {
                for line in text.split('\n') {
                    let run = Run {
                        text: line.to_owned(),
                        code: true,
                        ..Run::default()
                    };
                    out.push(para(&[run], 0, None, 0));
                }
            }
            // The Docs API places table cells one request at a time; rows
            // of tab-separated cells say the same in one.
            Block::Table(rows) => {
                for (i, row) in rows.iter().enumerate() {
                    let mut runs = vec![];
                    for (j, cell) in row.iter().enumerate() {
                        if j > 0 {
                            runs.push(Run {
                                text: "\t".into(),
                                ..Run::default()
                            });
                        }
                        runs.extend(cell.iter().cloned().map(|mut run| {
                            run.bold |= i == 0;
                            run
                        }));
                    }
                    out.push(para(&runs, 0, None, 0));
                }
            }
            Block::Rule => out.push(para(
                &[Run {
                    text: "\u{2014}".repeat(12),
                    ..Run::default()
                }],
                0,
                None,
                0,
            )),
        }
    }
    out
}

/// The requests that add `blocks` at the end of a document whose body ends
/// at `end`, after a last paragraph that is `empty` or not.
fn append_requests(blocks: &[Block], end: usize, empty: bool) -> Vec<Value> {
    let paras = paragraphs(blocks);
    if paras.is_empty() {
        return vec![];
    }
    // Before the newline that ends the body. Text put there joins the
    // last paragraph, so a new one starts with a newline of its own.
    let at = end.saturating_sub(1).max(1);
    let mut text = String::new();
    let mut starts = vec![];
    let mut cursor = at;
    for (i, para) in paras.iter().enumerate() {
        if i > 0 || !empty {
            text.push('\n');
            cursor += 1;
        }
        starts.push(cursor);
        text.push_str(&para.text);
        cursor += units(&para.text);
    }
    let range = |start: usize, end: usize| json!({"startIndex": start, "endIndex": end});
    let first = starts[0];
    let mut requests = vec![
        json!({"insertText": {"location": {"index": at}, "text": text}}),
        // What is added must not take on the look of what it follows.
        json!({"updateTextStyle": {
            "range": range(first, cursor.max(first + 1)),
            "textStyle": {},
            "fields": "bold,italic,underline,strikethrough,link,weightedFontFamily",
        }}),
        json!({"deleteParagraphBullets": {"range": range(first, cursor.max(first + 1))}}),
    ];
    for (para, start) in paras.iter().zip(&starts) {
        let style = match para.heading {
            0 => "NORMAL_TEXT".to_owned(),
            level => format!("HEADING_{}", level.min(6)),
        };
        requests.push(json!({"updateParagraphStyle": {
            // Through its newline, so an empty paragraph has a range too.
            "range": range(*start, start + units(&para.text) + 1),
            "paragraphStyle": {"namedStyleType": style},
            "fields": "namedStyleType",
        }}));
        for (from, to, run) in &para.spans {
            if from == to {
                continue;
            }
            let mut look = json!({});
            let mut fields = vec![];
            if run.bold {
                look["bold"] = json!(true);
                fields.push("bold");
            }
            if run.italic {
                look["italic"] = json!(true);
                fields.push("italic");
            }
            if run.code {
                look["weightedFontFamily"] = json!({"fontFamily": "Courier New"});
                fields.push("weightedFontFamily");
            }
            if let Some(url) = &run.link {
                look["link"] = json!({"url": url});
                fields.push("link");
            }
            requests.push(json!({"updateTextStyle": {
                "range": range(start + from, start + to),
                "textStyle": look,
                "fields": fields.join(","),
            }}));
        }
    }
    // Lists last and from the end back: making one drops the tabs in
    // front of its items, which moves everything after them.
    let mut groups: Vec<(usize, usize, bool)> = vec![];
    let mut open: Option<(usize, usize, bool)> = None;
    for (para, start) in paras.iter().zip(&starts) {
        let stop = start + units(&para.text) + 1;
        match (para.item, &mut open) {
            (Some(ordered), Some(group)) if group.2 == ordered => group.1 = stop,
            // A list of the other kind is a list of its own.
            (Some(ordered), _) => {
                groups.extend(open.take());
                open = Some((*start, stop, ordered));
            }
            (None, _) => groups.extend(open.take()),
        }
    }
    groups.extend(open);
    for (start, stop, ordered) in groups.into_iter().rev() {
        requests.push(json!({"createParagraphBullets": {
            "range": range(start, stop),
            "bulletPreset": if ordered {
                "NUMBERED_DECIMAL_ALPHA_ROMAN"
            } else {
                "BULLET_DISC_CIRCLE_SQUARE"
            },
        }}));
    }
    requests
}

/// Adds Markdown at the end of a document.
pub(crate) async fn append(home: &Path, svc: &Service, id: &str, content: &str) -> Result<()> {
    let id = drive::id(id)?;
    let blocks = markdown::blocks(content);
    if blocks.is_empty() {
        return Err(Error::new(4202, "content is empty"));
    }
    let document = call(
        home,
        svc,
        Method::GET,
        &format!("/v1/documents/{id}?fields=body.content(startIndex,endIndex)"),
        None,
    )
    .await?;
    let last = document["body"]["content"]
        .as_array()
        .and_then(|content| content.last())
        .ok_or_else(|| Error::new(5240, "Google Docs sent the document without its body."))?;
    let end = last["endIndex"].as_u64().unwrap_or(1) as usize;
    let start = last["startIndex"].as_u64().unwrap_or(0) as usize;
    let requests = append_requests(&blocks, end, end.saturating_sub(start) <= 1);
    call(
        home,
        svc,
        Method::POST,
        &format!("/v1/documents/{id}:batchUpdate"),
        Some(&json!({"requests": requests})),
    )
    .await?;
    Ok(())
}

/// Replaces `find` with `with` everywhere in a document, and says how many
/// times it did.
pub(crate) async fn replace(
    home: &Path,
    svc: &Service,
    id: &str,
    find: &str,
    with: &str,
) -> Result<usize> {
    let done = call(
        home,
        svc,
        Method::POST,
        &format!("/v1/documents/{}:batchUpdate", drive::id(id)?),
        Some(&json!({"requests": [{"replaceAllText": {
            "containsText": {"text": find, "matchCase": true},
            "replaceText": with,
        }}]})),
    )
    .await?;
    Ok(done["replies"][0]["replaceAllText"]["occurrencesChanged"]
        .as_u64()
        .unwrap_or(0) as usize)
}

#[cfg(test)]
#[path = "docs_tests.rs"]
mod tests;
