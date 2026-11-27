//! Word documents (.docx): read as text, written from Markdown, added to,
//! and searched and replaced. Graph has no API for a document's content, so
//! the file itself is read and changed here; what a change does not touch
//! stays as Word wrote it (`ooxml.rs`).
use crate::{
    Error, Result,
    markdown::{Block, Run, blocks},
    ooxml::{self, Tok, attr, escape, text_of, tokens},
    zip::{self, Archive},
};
use std::collections::HashMap;

const DOCUMENT: &str = "word/document.xml";

fn document(file: &Archive) -> Result<String> {
    file.text(DOCUMENT)?
        .ok_or_else(|| Error::new(4202, "This isn't a Word document Hexbot can read (.docx)."))
}

/// The document's styles as (id, name). Word names a style `heading 1` in
/// every language; only its id is translated.
fn style_names(file: &Archive) -> Result<Vec<(String, String)>> {
    let mut found = vec![];
    let Some(xml) = file.text("word/styles.xml")? else {
        return Ok(found);
    };
    let mut style = None;
    for tok in tokens(&xml) {
        match tok {
            Tok::Open {
                name: "w:style",
                raw,
                ..
            } => style = attr(raw, "w:styleId"),
            Tok::Open {
                name: "w:name",
                raw,
                ..
            } => {
                if let Some(id) = style.take() {
                    found.push((id, attr(raw, "w:val").unwrap_or_default().to_lowercase()));
                }
            }
            _ => {}
        }
    }
    Ok(found)
}

/// `heading 3` as 3.
fn heading_level(name: &str) -> Option<u8> {
    name.strip_prefix("heading ")
        .and_then(|n| n.parse::<u8>().ok())
        .filter(|n| (1..=6).contains(n))
}

/// Heading levels by style id, for reading: a title reads as the top one.
fn heading_styles(file: &Archive) -> Result<HashMap<String, u8>> {
    Ok(style_names(file)?
        .into_iter()
        .filter_map(|(id, name)| {
            let level = if name == "title" {
                Some(1)
            } else {
                heading_level(&name)
            };
            level.map(|level| (id, level))
        })
        .collect())
}

#[derive(Default)]
struct Paragraph {
    text: String,
    heading: Option<u8>,
    /// Its nesting level when it is a list item.
    item: Option<u8>,
}

impl Paragraph {
    fn markdown(&self) -> String {
        let text = self.text.trim();
        if text.is_empty() {
            return String::new();
        }
        match (self.heading, self.item) {
            (Some(level), _) => format!("{} {text}", "#".repeat(level as usize)),
            (None, Some(level)) => format!("{}- {text}", "  ".repeat(level as usize)),
            _ => text.to_owned(),
        }
    }
}

/// The document as text: headings as `#`, list items as `-`, tables as rows
/// of `|` cells. Deleted text, comments, headers and footers are left out.
pub(crate) fn read(file: &Archive) -> Result<String> {
    let headings = heading_styles(file)?;
    let xml = document(file)?;
    let mut out: Vec<String> = vec![];
    // A text box holds paragraphs inside a paragraph.
    let mut open: Vec<Paragraph> = vec![];
    let mut in_text = false;
    // The same content twice: once for new Word, once for old.
    let mut fallback = 0;
    // Tables being read, innermost last: rows of cells.
    let mut tables: Vec<Vec<Vec<String>>> = vec![];
    let mut was_item = false;
    for tok in tokens(&xml) {
        if tok.opens("mc:Fallback") {
            fallback += 1;
        } else if tok.closes("mc:Fallback") {
            fallback -= 1;
        }
        if fallback > 0 {
            continue;
        }
        match tok {
            Tok::Open {
                name: "w:p", empty, ..
            } => {
                open.push(Paragraph::default());
                if empty {
                    open.pop();
                }
            }
            Tok::Open {
                name: "w:pStyle",
                raw,
                ..
            } => {
                if let (Some(p), Some(id)) = (open.last_mut(), attr(raw, "w:val")) {
                    p.heading = headings.get(&id).copied();
                }
            }
            Tok::Open {
                name: "w:numPr", ..
            } => {
                if let Some(p) = open.last_mut() {
                    p.item.get_or_insert(0);
                }
            }
            Tok::Open {
                name: "w:ilvl",
                raw,
                ..
            } => {
                if let Some(p) = open.last_mut() {
                    p.item = attr(raw, "w:val").and_then(|v| v.parse().ok()).or(Some(0));
                }
            }
            Tok::Open {
                name: "w:t", empty, ..
            } => in_text = !empty,
            Tok::Close { name: "w:t", .. } => in_text = false,
            Tok::Text(_) | Tok::Literal { .. } if in_text => {
                if let Some(p) = open.last_mut() {
                    p.text.push_str(&text_of(&tok));
                }
            }
            Tok::Open { name: "w:tab", .. } => {
                if let Some(p) = open.last_mut() {
                    p.text.push('\t');
                }
            }
            Tok::Open {
                name: "w:br" | "w:cr",
                ..
            } => {
                if let Some(p) = open.last_mut() {
                    p.text.push('\n');
                }
            }
            Tok::Open {
                name: "w:noBreakHyphen",
                ..
            } => {
                if let Some(p) = open.last_mut() {
                    p.text.push('-');
                }
            }
            Tok::Close { name: "w:p", .. } => {
                let Some(p) = open.pop() else { continue };
                let text = p.markdown();
                if text.is_empty() {
                    continue;
                }
                if let Some(cell) = tables
                    .last_mut()
                    .and_then(|t| t.last_mut())
                    .and_then(|r| r.last_mut())
                {
                    if !cell.is_empty() {
                        cell.push(' ');
                    }
                    cell.push_str(&text.replace('\n', " "));
                } else {
                    // List items sit on consecutive lines; the rest are apart.
                    let item = p.item.is_some() && p.heading.is_none();
                    match out.last_mut() {
                        Some(last) if item && was_item => {
                            last.push('\n');
                            last.push_str(&text);
                        }
                        _ => out.push(text),
                    }
                    was_item = item;
                }
            }
            Tok::Open { name: "w:tbl", .. } => tables.push(vec![]),
            Tok::Open { name: "w:tr", .. } => {
                if let Some(table) = tables.last_mut() {
                    table.push(vec![]);
                }
            }
            Tok::Open { name: "w:tc", .. } => {
                if let Some(row) = tables.last_mut().and_then(|t| t.last_mut()) {
                    row.push(String::new());
                }
            }
            Tok::Close { name: "w:tbl", .. } => {
                let Some(table) = tables.pop() else { continue };
                let text = table
                    .iter()
                    .map(|row| {
                        format!(
                            "| {} |",
                            row.iter()
                                .map(|c| c.replace('|', "\\|"))
                                .collect::<Vec<_>>()
                                .join(" | ")
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                // A table inside a cell reads as part of that cell.
                match tables
                    .last_mut()
                    .and_then(|t| t.last_mut())
                    .and_then(|r| r.last_mut())
                {
                    Some(cell) => cell.push_str(&text.replace('\n', " ")),
                    None if !text.is_empty() => {
                        out.push(text);
                        was_item = false;
                    }
                    None => {}
                }
            }
            _ => {}
        }
    }
    Ok(out.join("\n\n"))
}

// --- Writing --------------------------------------------------------------

/// How a document's own styles are named, for content added to it.
#[derive(Default)]
struct Styles {
    /// Style ids for heading levels 1 to 6, where the document has them.
    headings: HashMap<u8, String>,
    /// A new file: its list and link parts are ours to write.
    own: bool,
    /// In a new file, the list each numbered Markdown list is, from 2 up
    /// with no gaps; list 1 is the bullets.
    numbered: HashMap<u32, u32>,
}

/// Hyperlinks a new document points to, as (relationship id, address).
type Links = Vec<(String, String)>;

fn run_xml(run: &Run, extra: &str, links: Option<&mut Links>) -> String {
    let mut props = String::from(extra);
    if run.bold {
        props.push_str("<w:b/>");
    }
    if run.italic {
        props.push_str("<w:i/>");
    }
    if run.code {
        props.push_str(r#"<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/>"#);
    }
    let link = match (&run.link, links) {
        (Some(url), Some(links)) => {
            let id = format!("rId{}", 100 + links.len());
            links.push((id.clone(), url.clone()));
            props.push_str(r#"<w:color w:val="0563C1"/><w:u w:val="single"/>"#);
            Some(id)
        }
        _ => None,
    };
    let props = if props.is_empty() {
        String::new()
    } else {
        format!("<w:rPr>{props}</w:rPr>")
    };
    // A line break inside a run is its own element.
    let mut body = String::new();
    for (i, line) in run.text.split('\n').enumerate() {
        if i > 0 {
            body.push_str("<w:br/>");
        }
        if !line.is_empty() {
            body.push_str(&format!(
                r#"<w:t xml:space="preserve">{}</w:t>"#,
                escape(line)
            ));
        }
    }
    let mut text = format!("<w:r>{props}{body}</w:r>");
    // Where links can't be made, the address follows the words.
    if let (Some(url), None) = (&run.link, &link)
        && *url != run.text
    {
        text.push_str(&format!(
            r#"<w:r><w:t xml:space="preserve"> ({})</w:t></w:r>"#,
            escape(url)
        ));
    }
    match link {
        Some(id) => format!(r#"<w:hyperlink r:id="{id}">{text}</w:hyperlink>"#),
        None => text,
    }
}

fn paragraph(props: &str, runs: &[Run], run_props: &str, mut links: Option<&mut Links>) -> String {
    let props = if props.is_empty() {
        String::new()
    } else {
        format!("<w:pPr>{props}</w:pPr>")
    };
    let body = runs
        .iter()
        .map(|run| run_xml(run, run_props, links.as_deref_mut()))
        .collect::<String>();
    format!("<w:p>{props}{body}</w:p>")
}

/// Sizes for headings in a document without heading styles, in half points.
const HEADING_SIZES: [u32; 6] = [40, 32, 28, 26, 24, 22];

fn body_xml(blocks: &[Block], styles: &Styles, mut links: Option<&mut Links>) -> String {
    let mut out = String::new();
    // Numbers for numbered lists in a document whose lists aren't ours.
    let mut counters: HashMap<u32, u32> = HashMap::new();
    for block in blocks {
        match block {
            Block::Heading(level, runs) => match styles.headings.get(level) {
                Some(id) => out.push_str(&paragraph(
                    &format!(r#"<w:pStyle w:val="{}"/>"#, escape(id)),
                    runs,
                    "",
                    links.as_deref_mut(),
                )),
                None => out.push_str(&paragraph(
                    r#"<w:keepNext/><w:spacing w:before="240" w:after="80"/>"#,
                    runs,
                    &format!(
                        r#"<w:b/><w:sz w:val="{0}"/><w:szCs w:val="{0}"/>"#,
                        HEADING_SIZES[(*level as usize - 1).min(5)]
                    ),
                    links.as_deref_mut(),
                )),
            },
            Block::Paragraph(runs) => {
                out.push_str(&paragraph("", runs, "", links.as_deref_mut()))
            }
            Block::Item {
                list,
                ordered,
                level,
                runs,
            } => {
                if styles.own {
                    let num = if *ordered {
                        styles.numbered.get(list).copied().unwrap_or(1)
                    } else {
                        1
                    };
                    out.push_str(&paragraph(
                        &format!(
                            r#"<w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="{level}"/><w:numId w:val="{num}"/></w:numPr>"#
                        ),
                        runs,
                        "",
                        links.as_deref_mut(),
                    ));
                } else {
                    // Another document's lists are its own; write the mark.
                    let mark = if *ordered {
                        let n = counters.entry(*list).or_insert(0);
                        *n += 1;
                        format!("{n}.\t")
                    } else {
                        "\u{2022}\t".to_owned()
                    };
                    let left = 720 * (u32::from(*level) + 1);
                    let mut marked = vec![Run {
                        text: mark,
                        ..Run::default()
                    }];
                    marked.extend(runs.iter().cloned());
                    out.push_str(&paragraph(
                        &format!(
                            r#"<w:tabs><w:tab w:val="left" w:pos="{left}"/></w:tabs><w:ind w:left="{left}" w:hanging="360"/>"#
                        ),
                        &marked,
                        "",
                        links.as_deref_mut(),
                    ));
                }
            }
            Block::Code(text) => {
                for line in text.split('\n') {
                    out.push_str(&paragraph(
                        r#"<w:spacing w:before="0" w:after="0"/>"#,
                        &[Run {
                            text: line.to_owned(),
                            code: true,
                            ..Run::default()
                        }],
                        r#"<w:sz w:val="20"/>"#,
                        None,
                    ));
                }
                out.push_str("<w:p/>");
            }
            Block::Table(rows) => {
                let columns = rows.iter().map(Vec::len).max().unwrap_or(0).max(1);
                out.push_str(r#"<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblBorders>"#);
                for side in ["top", "left", "bottom", "right", "insideH", "insideV"] {
                    out.push_str(&format!(
                        r#"<w:{side} w:val="single" w:sz="4" w:space="0" w:color="A6A6A6"/>"#
                    ));
                }
                out.push_str("</w:tblBorders></w:tblPr><w:tblGrid>");
                out.push_str(&"<w:gridCol/>".repeat(columns));
                out.push_str("</w:tblGrid>");
                for (i, row) in rows.iter().enumerate() {
                    out.push_str("<w:tr>");
                    for column in 0..columns {
                        let empty = vec![];
                        let runs = row.get(column).unwrap_or(&empty);
                        out.push_str(r#"<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr>"#);
                        out.push_str(&paragraph(
                            "",
                            runs,
                            if i == 0 { "<w:b/>" } else { "" },
                            links.as_deref_mut(),
                        ));
                        out.push_str("</w:tc>");
                    }
                    out.push_str("</w:tr>");
                }
                // Word needs a paragraph after a table.
                out.push_str("</w:tbl><w:p/>");
            }
            Block::Rule => out.push_str(
                r#"<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="A6A6A6"/></w:pBdr></w:pPr></w:p>"#,
            ),
        }
    }
    out
}

const NS: &str = r#"xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships""#;

fn styles_xml() -> String {
    let mut out = format!(
        r#"<w:styles {NS}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>"#
    );
    for (i, size) in HEADING_SIZES.iter().enumerate() {
        let level = i + 1;
        out.push_str(&format!(
            r#"<w:style w:type="paragraph" w:styleId="Heading{level}"><w:name w:val="heading {level}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="{before}" w:after="80"/><w:outlineLvl w:val="{i}"/></w:pPr><w:rPr><w:rFonts w:ascii="Calibri Light" w:hAnsi="Calibri Light" w:eastAsia="Calibri Light" w:cs="Calibri Light"/><w:color w:val="1F3864"/><w:sz w:val="{size}"/><w:szCs w:val="{size}"/></w:rPr></w:style>"#,
            before = if level == 1 { 360 } else { 200 },
        ));
    }
    out.push_str(r#"<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="34"/><w:qFormat/><w:pPr><w:spacing w:after="60"/><w:contextualSpacing/></w:pPr></w:style></w:styles>"#);
    out
}

/// The numbered lists of some Markdown, each given the list it is in the
/// file: 2, 3, 4 and so on, so each counts from one.
fn numbered_lists(blocks: &[Block]) -> HashMap<u32, u32> {
    let mut lists: Vec<u32> = blocks
        .iter()
        .filter_map(|b| match b {
            Block::Item {
                list,
                ordered: true,
                ..
            } => Some(*list),
            _ => None,
        })
        .collect();
    lists.sort_unstable();
    lists.dedup();
    lists
        .into_iter()
        .enumerate()
        .map(|(i, list)| (list, i as u32 + 2))
        .collect()
}

/// The list formats: one for bullets, one for numbers, and `numbered`
/// lists that use the second.
fn numbering_xml(numbered: usize) -> String {
    let level = |i: u32, format: &str, text: &str| {
        format!(
            r#"<w:lvl w:ilvl="{i}"><w:start w:val="1"/><w:numFmt w:val="{format}"/><w:lvlText w:val="{text}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="{left}" w:hanging="360"/></w:pPr></w:lvl>"#,
            left = 720 * (i + 1)
        )
    };
    let mut out = format!(
        r#"<w:numbering {NS}><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>"#
    );
    for i in 0..9 {
        out.push_str(&level(
            i,
            "bullet",
            ["\u{2022}", "\u{25E6}", "\u{25AA}"][i as usize % 3],
        ));
    }
    out.push_str(r#"</w:abstractNum><w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>"#);
    for i in 0..9 {
        let format = ["decimal", "lowerLetter", "lowerRoman"][i as usize % 3];
        out.push_str(&level(i, format, &format!("%{}.", i + 1)));
    }
    out.push_str(r#"</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>"#);
    for list in 0..numbered {
        out.push_str(&format!(
            r#"<w:num w:numId="{}"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>"#,
            list + 2
        ));
    }
    out.push_str("</w:numbering>");
    out
}

/// A new document from Markdown.
pub(crate) fn create(title: &str, markdown: &str) -> Vec<u8> {
    let blocks = blocks(markdown);
    let styles = Styles {
        headings: (1..=6).map(|n| (n, format!("Heading{n}"))).collect(),
        own: true,
        numbered: numbered_lists(&blocks),
    };
    let mut links = Links::new();
    let body = body_xml(&blocks, &styles, Some(&mut links));
    let document = format!(
        r#"<w:document {NS}><w:body>{body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>"#
    );
    let mut rels = String::from(
        r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>"#,
    );
    for (id, url) in &links {
        rels.push_str(&format!(
            r#"<Relationship Id="{id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="{}" TargetMode="External"/>"#,
            escape(url)
        ));
    }
    rels.push_str("</Relationships>");
    zip::build(&[
        (
            "[Content_Types].xml",
            ooxml::part(
                r#"<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>"#,
            ),
        ),
        (
            "_rels/.rels",
            ooxml::part(
                r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>"#,
            ),
        ),
        ("docProps/core.xml", ooxml::core(title)),
        (DOCUMENT, ooxml::part(&document)),
        ("word/_rels/document.xml.rels", ooxml::part(&rels)),
        ("word/styles.xml", ooxml::part(&styles_xml())),
        (
            "word/numbering.xml",
            ooxml::part(&numbering_xml(styles.numbered.len())),
        ),
    ])
}

/// The document with `markdown` added at its end, in its own heading
/// styles where it has them.
pub(crate) fn append(file: &Archive, markdown: &str) -> Result<Vec<u8>> {
    let xml = document(file)?;
    let styles = Styles {
        headings: style_names(file)?
            .into_iter()
            .filter_map(|(id, name)| heading_level(&name).map(|level| (level, id)))
            .collect(),
        own: false,
        numbered: HashMap::new(),
    };
    let addition = body_xml(&blocks(markdown), &styles, None);
    if addition.is_empty() {
        return Err(Error::new(4202, "content is empty"));
    }
    let end = xml
        .rfind("</w:body>")
        .ok_or_else(|| Error::new(4202, "This document can't be changed: it has no body."))?;
    // The page setup is the body's last element; new content goes before it.
    // One inside a paragraph, which ends a section, is followed by more.
    let at = match xml[..end].rfind("<w:sectPr") {
        Some(sect) => {
            let tail = xml[sect..end].trim_end();
            let whole = (tail.ends_with("</w:sectPr>") && tail.matches("</w:sectPr>").count() == 1)
                || (tail.ends_with("/>") && !tail.contains("</"));
            if whole { sect } else { end }
        }
        None => end,
    };
    let changed = format!("{}{addition}{}", &xml[..at], &xml[at..]);
    Ok(file.with(&[(DOCUMENT.into(), Some(changed.into_bytes()))]))
}

/// The document with `find` replaced by `with`, and how many times.
pub(crate) fn replace(file: &Archive, find: &str, with: &str) -> Result<(Vec<u8>, usize)> {
    let (changed, count) = ooxml::replace_in(&document(file)?, "w:p", "w:t", find, with);
    if count == 0 {
        return Ok((vec![], 0));
    }
    Ok((
        file.with(&[(DOCUMENT.into(), Some(changed.into_bytes()))]),
        count,
    ))
}

#[cfg(test)]
#[path = "word_tests.rs"]
mod tests;
