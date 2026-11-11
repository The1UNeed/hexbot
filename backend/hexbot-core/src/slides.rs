//! Google Slides: read slide by slide, made new from an outline, added to,
//! and searched and replaced.
use crate::{
    Error, Result,
    accounts::{self, SLIDES_API, Service},
    drive,
    powerpoint::{NewSlide, Slide},
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
        SLIDES_API,
        path,
        body,
        &[],
        "presentation",
    )
    .await
}

// --- Reading --------------------------------------------------------------

/// The lines of a shape's or a cell's text, nested ones indented.
fn text_lines(text: &Value) -> Vec<String> {
    let mut lines = vec![];
    let mut level = 0;
    let mut current = String::new();
    for element in text["textElements"].as_array().into_iter().flatten() {
        if let Some(marker) = element.get("paragraphMarker") {
            level = marker["bullet"]["nestingLevel"].as_u64().unwrap_or(0) as usize;
        } else if let Some(run) = element["textRun"]["content"].as_str() {
            for (i, piece) in run.split('\n').enumerate() {
                if i > 0 {
                    // The paragraph ended.
                    let line = std::mem::take(&mut current);
                    if !line.trim().is_empty() {
                        lines.push(format!("{}{}", "  ".repeat(level.min(8)), line.trim()));
                    }
                }
                current.push_str(&piece.replace('\u{b}', " "));
            }
        }
    }
    if !current.trim().is_empty() {
        lines.push(format!("{}{}", "  ".repeat(level.min(8)), current.trim()));
    }
    lines
}

/// A page's title and its other text.
fn page_text(elements: &Value, title: &mut String, lines: &mut Vec<String>) {
    for element in elements.as_array().into_iter().flatten() {
        if let Some(shape) = element.get("shape") {
            let text = text_lines(&shape["text"]);
            match shape["placeholder"]["type"].as_str() {
                Some("TITLE" | "CENTERED_TITLE") if title.is_empty() => {
                    *title = text.iter().map(|l| l.trim()).collect::<Vec<_>>().join(" ");
                }
                Some("SLIDE_NUMBER" | "DATE_AND_TIME" | "FOOTER" | "HEADER" | "SLIDE_IMAGE") => {}
                _ => lines.extend(text),
            }
        } else if let Some(table) = element.get("table") {
            for row in table["tableRows"].as_array().into_iter().flatten() {
                let cells = row["tableCells"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|cell| text_lines(&cell["text"]).join(" ").replace('|', "\\|"))
                    .collect::<Vec<_>>();
                lines.push(format!("| {} |", cells.join(" | ")));
            }
        } else if let Some(group) = element.get("elementGroup") {
            page_text(&group["children"], title, lines);
        }
    }
}

/// A presentation's title and its slides.
pub(crate) async fn read(home: &Path, svc: &Service, id: &str) -> Result<(String, Vec<Slide>)> {
    let found = call(
        home,
        svc,
        Method::GET,
        &format!(
            "/v1/presentations/{}?fields=title,slides(pageElements,slideProperties.notesPage.pageElements)",
            drive::id(id)?
        ),
        None,
    )
    .await?;
    let slides = found["slides"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|slide| {
            let (mut title, mut lines) = (String::new(), vec![]);
            page_text(&slide["pageElements"], &mut title, &mut lines);
            let (mut unused, mut notes) = (String::new(), vec![]);
            page_text(
                &slide["slideProperties"]["notesPage"]["pageElements"],
                &mut unused,
                &mut notes,
            );
            Slide {
                title,
                text: lines.join("\n"),
                notes: notes.join("\n"),
            }
        })
        .collect();
    Ok((found["title"].as_str().unwrap_or("").to_owned(), slides))
}

// --- Writing --------------------------------------------------------------

/// Which layout a new slide uses and how its two placeholders are named.
struct Layout {
    reference: Value,
    title: &'static str,
    body: &'static str,
}

const TITLE_SLIDE: Layout = Layout {
    reference: Value::Null,
    title: "CENTERED_TITLE",
    body: "SUBTITLE",
};

/// The requests that put `slides` in a presentation from position `at`.
/// Ids start with `prefix`, which must be new to the presentation.
/// `content` is the layout for a title with a body; `opening` makes the
/// first a title slide when it has little under its title.
fn slide_requests(
    slides: &[NewSlide],
    at: usize,
    prefix: &str,
    content: &Layout,
    opening: bool,
) -> Vec<Value> {
    let mut requests = vec![];
    for (i, slide) in slides.iter().enumerate() {
        let title_slide = opening && i == 0 && slide.body.len() <= 2;
        let layout = if title_slide { &TITLE_SLIDE } else { content };
        let reference = if title_slide {
            json!({"predefinedLayout": "TITLE"})
        } else {
            layout.reference.clone()
        };
        let (page, title, body) = (
            format!("{prefix}_s{i}"),
            format!("{prefix}_t{i}"),
            format!("{prefix}_b{i}"),
        );
        requests.push(json!({"createSlide": {
            "objectId": page,
            "insertionIndex": at + i,
            "slideLayoutReference": reference,
            "placeholderIdMappings": [
                {"layoutPlaceholder": {"type": layout.title, "index": 0}, "objectId": title},
                {"layoutPlaceholder": {"type": layout.body, "index": 0}, "objectId": body},
            ],
        }}));
        if !slide.title.is_empty() {
            requests.push(json!({"insertText": {
                "objectId": title, "insertionIndex": 0, "text": slide.title,
            }}));
        }
        if !slide.body.is_empty() {
            // A tab in front nests a line one level once it is a list.
            let nested = slide.body.iter().any(|(level, _)| *level > 0);
            let listed = !title_slide && (slide.body.len() > 1 || nested);
            let text = slide
                .body
                .iter()
                .map(|(level, line)| {
                    format!(
                        "{}{line}",
                        if listed {
                            "\t".repeat(*level as usize)
                        } else {
                            String::new()
                        }
                    )
                })
                .collect::<Vec<_>>()
                .join("\n");
            requests.push(json!({"insertText": {
                "objectId": body, "insertionIndex": 0, "text": text,
            }}));
            if listed {
                requests.push(json!({"createParagraphBullets": {
                    "objectId": body,
                    "textRange": {"type": "ALL"},
                    "bulletPreset": "BULLET_DISC_CIRCLE_SQUARE",
                }}));
            }
        }
    }
    requests
}

fn prefix() -> String {
    // New to any presentation, and within the letters an id may hold.
    format!(
        "hx{}",
        crate::common::id()
            .replace('-', "")
            .chars()
            .take(12)
            .collect::<String>()
    )
}

/// A new presentation from an outline.
pub(crate) async fn create(
    home: &Path,
    svc: &Service,
    title: &str,
    slides: &[NewSlide],
) -> Result<Value> {
    let made = call(
        home,
        svc,
        Method::POST,
        "/v1/presentations",
        Some(&json!({"title": drive::file_name(title, "Untitled presentation")})),
    )
    .await?;
    let id = made["presentationId"].as_str().unwrap_or("").to_owned();
    let content = Layout {
        reference: json!({"predefinedLayout": "TITLE_AND_BODY"}),
        title: "TITLE",
        body: "BODY",
    };
    let mut requests = slide_requests(slides, 0, &prefix(), &content, true);
    // A new presentation starts with one empty slide; ours take its place.
    if let Some(first) = made["slides"][0]["objectId"].as_str() {
        requests.push(json!({"deleteObject": {"objectId": first}}));
    }
    call(
        home,
        svc,
        Method::POST,
        &format!("/v1/presentations/{}:batchUpdate", drive::id(&id)?),
        Some(&json!({"requests": requests})),
    )
    .await?;
    Ok(json!({
        "id": id,
        "link": format!("https://docs.google.com/presentation/d/{id}/edit"),
    }))
}

/// Adds `slides` after a presentation's last slide, in its own layout for
/// a title with a body, and says how many slides it has now.
pub(crate) async fn add(
    home: &Path,
    svc: &Service,
    id: &str,
    slides: &[NewSlide],
) -> Result<usize> {
    let id = drive::id(id)?;
    let found = call(
        home,
        svc,
        Method::GET,
        &format!(
            "/v1/presentations/{id}?fields=slides(objectId,slideProperties.masterObjectId),layouts(objectId,layoutProperties(name,masterObjectId),pageElements.shape.placeholder.type)"
        ),
        None,
    )
    .await?;
    let count = found["slides"].as_array().map_or(0, Vec::len);
    let has = |layout: &Value, kind: &str| {
        layout["pageElements"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|e| e["shape"]["placeholder"]["type"] == kind)
    };
    // New slides go after the last one and take its master: Slides
    // refuses a layout that belongs to another.
    let master = &found["slides"][count.saturating_sub(1)]["slideProperties"]["masterObjectId"];
    let layouts = found["layouts"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|l| !master.is_string() || l["layoutProperties"]["masterObjectId"] == *master)
        .cloned()
        .collect::<Vec<_>>();
    let chosen = layouts
        .iter()
        .find(|l| {
            l["layoutProperties"]["name"] == "TITLE_AND_BODY" && has(l, "TITLE") && has(l, "BODY")
        })
        .or_else(|| layouts.iter().find(|l| has(l, "TITLE") && has(l, "BODY")))
        .ok_or_else(|| {
            Error::new(
                4202,
                "This presentation has no layout with a title and a body to add slides with.",
            )
        })?;
    let content = Layout {
        reference: json!({"layoutId": chosen["objectId"]}),
        title: "TITLE",
        body: "BODY",
    };
    call(
        home,
        svc,
        Method::POST,
        &format!("/v1/presentations/{id}:batchUpdate"),
        Some(&json!({"requests": slide_requests(slides, count, &prefix(), &content, false)})),
    )
    .await?;
    Ok(count + slides.len())
}

/// Replaces `find` with `with` on every slide, and says how many times.
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
        &format!("/v1/presentations/{}:batchUpdate", drive::id(id)?),
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
#[path = "slides_tests.rs"]
mod tests;
