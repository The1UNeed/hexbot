//! What Word, Excel and PowerPoint files share (`word.rs`, `excel.rs`,
//! `powerpoint.rs`): the XML their parts are written in, and the lists that
//! tie one part to another. The XML is read as a run of tags and text and
//! written back from the same pieces, so whatever a change does not touch
//! stays exactly as Office wrote it.
use crate::{Error, Result, zip::Archive};

/// One piece of an XML part, as it is written.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum Tok<'a> {
    /// `<w:p ...>` or, with `empty`, `<w:p .../>`.
    Open {
        name: &'a str,
        raw: &'a str,
        empty: bool,
    },
    Close {
        name: &'a str,
        raw: &'a str,
    },
    /// Text between tags, still escaped.
    Text(&'a str),
    /// A CDATA section's text, which is never escaped.
    Literal {
        text: &'a str,
        raw: &'a str,
    },
    /// A declaration, comment or instruction.
    Other(&'a str),
}

impl<'a> Tok<'a> {
    pub(crate) fn raw(&self) -> &'a str {
        match self {
            Tok::Open { raw, .. } | Tok::Close { raw, .. } | Tok::Literal { raw, .. } => raw,
            Tok::Text(raw) | Tok::Other(raw) => raw,
        }
    }
    pub(crate) fn opens(&self, tag: &str) -> bool {
        matches!(self, Tok::Open { name, .. } if *name == tag)
    }
    pub(crate) fn closes(&self, tag: &str) -> bool {
        matches!(self, Tok::Close { name, .. } if *name == tag)
    }
}

/// The pieces of `xml`, in order; joined, their `raw` is `xml` again.
pub(crate) fn tokens(xml: &str) -> Vec<Tok<'_>> {
    let bytes = xml.as_bytes();
    let mut out = vec![];
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] != b'<' {
            let end = xml[at..].find('<').map_or(xml.len(), |i| at + i);
            out.push(Tok::Text(&xml[at..end]));
            at = end;
            continue;
        }
        let rest = &xml[at..];
        let closed = |open: &str, close: &str| {
            rest.starts_with(open)
                .then(|| rest.find(close).map(|i| i + close.len()))
        };
        if let Some(end) = closed("<!--", "-->") {
            let end = end.unwrap_or(rest.len());
            out.push(Tok::Other(&rest[..end]));
            at += end;
        } else if let Some(end) = closed("<![CDATA[", "]]>") {
            let end = end.unwrap_or(rest.len());
            let text = rest[..end]
                .strip_prefix("<![CDATA[")
                .map(|t| t.strip_suffix("]]>").unwrap_or(t))
                .unwrap_or("");
            out.push(Tok::Literal {
                text,
                raw: &rest[..end],
            });
            at += end;
        } else if rest.starts_with("<?") || rest.starts_with("<!") {
            let close = if rest.starts_with("<?") { "?>" } else { ">" };
            let end = rest.find(close).map_or(rest.len(), |i| i + close.len());
            out.push(Tok::Other(&rest[..end]));
            at += end;
        } else {
            // A `>` inside a quoted attribute does not end the tag.
            let mut quote = None;
            let mut end = rest.len();
            for (i, b) in rest.bytes().enumerate().skip(1) {
                match (quote, b) {
                    (None, b'"' | b'\'') => quote = Some(b),
                    (Some(q), b) if b == q => quote = None,
                    (None, b'>') => {
                        end = i + 1;
                        break;
                    }
                    _ => {}
                }
            }
            let raw = &rest[..end];
            let inner = raw
                .trim_start_matches('<')
                .trim_end_matches('>')
                .trim_end_matches('/');
            if let Some(name) = inner.strip_prefix('/') {
                out.push(Tok::Close {
                    name: name.trim(),
                    raw,
                });
            } else {
                let name = inner
                    .split(|c: char| c.is_whitespace())
                    .next()
                    .unwrap_or("");
                out.push(Tok::Open {
                    name,
                    raw,
                    empty: raw.ends_with("/>"),
                });
            }
            at += end;
        }
    }
    out
}

/// An attribute of an opening tag, unescaped.
pub(crate) fn attr(raw: &str, name: &str) -> Option<String> {
    let mut rest = raw;
    while let Some(i) = rest.find(name) {
        let before = rest[..i].chars().next_back();
        let after = rest[i + name.len()..].trim_start();
        if before.is_some_and(char::is_whitespace)
            && let Some(value) = after.strip_prefix('=')
        {
            let value = value.trim_start();
            let quote = value.chars().next()?;
            if quote == '"' || quote == '\'' {
                let value = &value[1..];
                return value.find(quote).map(|end| unescape(&value[..end]));
            }
        }
        rest = &rest[i + name.len()..];
    }
    None
}

pub(crate) fn unescape(text: &str) -> String {
    if !text.contains('&') {
        return text.to_owned();
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        rest = &rest[i..];
        let Some(end) = rest.find(';').filter(|end| *end <= 12) else {
            out.push('&');
            rest = &rest[1..];
            continue;
        };
        let name = &rest[1..end];
        let found = match name {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            _ => name
                .strip_prefix("#x")
                .or_else(|| name.strip_prefix("#X"))
                .and_then(|hex| u32::from_str_radix(hex, 16).ok())
                .or_else(|| name.strip_prefix('#').and_then(|n| n.parse().ok()))
                .and_then(char::from_u32)
                .filter(|c| *c != '\0'),
        };
        match found {
            Some(c) => {
                out.push(c);
                rest = &rest[end + 1..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// Text as XML holds it, in an element or a quoted attribute. Characters
/// XML cannot hold at all are dropped.
pub(crate) fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 8);
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\t' | '\n' | '\r' => out.push(c),
            c if (c as u32) < 0x20 || matches!(c as u32, 0xFFFE | 0xFFFF) => {}
            c => out.push(c),
        }
    }
    out
}

/// The text between an element's tags, for elements that hold only text.
pub(crate) fn text_of(tok: &Tok) -> String {
    match tok {
        Tok::Text(raw) => unescape(raw),
        Tok::Literal { text, .. } => (*text).to_owned(),
        _ => String::new(),
    }
}

/// A part's name from where another part points: `../media/a.png` seen from
/// `ppt/slides/slide1.xml` is `ppt/media/a.png`.
pub(crate) fn resolve(from: &str, target: &str) -> String {
    if let Some(absolute) = target.strip_prefix('/') {
        return absolute.to_owned();
    }
    let mut parts: Vec<&str> = from.split('/').collect();
    parts.pop();
    for piece in target.split('/') {
        match piece {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            piece => parts.push(piece),
        }
    }
    parts.join("/")
}

/// The file that lists what `part` points to: `word/_rels/document.xml.rels`.
pub(crate) fn rels_name(part: &str) -> String {
    match part.rsplit_once('/') {
        Some((dir, file)) => format!("{dir}/_rels/{file}.rels"),
        None => format!("_rels/{part}.rels"),
    }
}

/// One thing a part points to.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Rel {
    pub id: String,
    /// What it is, as the last word of its type: `slide`, `notesSlide`.
    pub kind: String,
    /// The part's full name in the file.
    pub target: String,
    pub external: bool,
}

/// What `part` points to.
pub(crate) fn rels(file: &Archive, part: &str) -> Result<Vec<Rel>> {
    let Some(xml) = file.text(&rels_name(part))? else {
        return Ok(vec![]);
    };
    Ok(tokens(&xml)
        .iter()
        .filter_map(|tok| match tok {
            Tok::Open { name, raw, .. } if *name == "Relationship" => {
                let external = attr(raw, "TargetMode").as_deref() == Some("External");
                let target = attr(raw, "Target")?;
                Some(Rel {
                    id: attr(raw, "Id")?,
                    kind: attr(raw, "Type")?
                        .rsplit('/')
                        .next()
                        .unwrap_or("")
                        .to_owned(),
                    target: if external {
                        target
                    } else {
                        resolve(part, &target)
                    },
                    external,
                })
            }
            _ => None,
        })
        .collect())
}

/// The first number above every `rId<n>` in use.
pub(crate) fn next_rel(rels: &[Rel]) -> u32 {
    rels.iter()
        .filter_map(|r| r.id.strip_prefix("rId").and_then(|n| n.parse::<u32>().ok()))
        .max()
        .unwrap_or(0)
        + 1
}

/// `xml` with `addition` put just before its last `</name>`.
pub(crate) fn before_close(xml: &str, name: &str, addition: &str) -> Result<String> {
    let close = format!("</{name}>");
    let at = xml
        .rfind(&close)
        .ok_or_else(|| Error::new(4202, "This file can't be changed: a part of it is damaged."))?;
    Ok(format!("{}{addition}{}", &xml[..at], &xml[at..]))
}

/// The most text one read of a file keeps: a small file can unpack to far
/// more than it weighs.
pub(crate) const TEXT_BUDGET: usize = 32 * 1024 * 1024;

/// `xml` with `find` replaced by `with` in every paragraph that holds it,
/// and how many times. A paragraph's words are spread over runs wherever
/// their style changes, so a match is found in the paragraph's whole text
/// and may span several runs. The new words go where the match began, in
/// that run's style, and only the matched characters leave the others:
/// every run, line break, link and field stays where it was. `para` and
/// `text` name the tags: `w:p` and `w:t` in Word, `a:p` and `a:t` in
/// PowerPoint.
pub(crate) fn replace_in(
    xml: &str,
    para: &str,
    text: &str,
    find: &str,
    with: &str,
) -> (String, usize) {
    let toks = tokens(xml);
    let mut out = String::with_capacity(xml.len());
    let mut count = 0;
    let mut i = 0;
    let whole = |tok: &Tok| tok.opens(para) && !matches!(tok, Tok::Open { empty: true, .. });
    while i < toks.len() {
        if find.is_empty() || !whole(&toks[i]) {
            out.push_str(toks[i].raw());
            i += 1;
            continue;
        }
        // To this paragraph's own end: one nested in it (a text box) is
        // left as it is, and looked at on its own.
        let mut depth = 0;
        let mut end = i;
        let mut nested = false;
        for (j, tok) in toks.iter().enumerate().skip(i) {
            if whole(tok) {
                depth += 1;
                nested |= depth > 1;
            } else if tok.closes(para) {
                depth -= 1;
                if depth == 0 {
                    end = j;
                    break;
                }
            }
        }
        // This paragraph's text, piece by piece: where each sits in the
        // tokens, and where it starts in the paragraph's whole text.
        let mut pieces: Vec<(usize, usize)> = vec![];
        let mut joined = String::new();
        let mut in_text = false;
        // Where a tab or a line break sits in the text: the words either
        // side of one are apart, and no match runs across it.
        let mut gaps: Vec<usize> = vec![];
        for (j, tok) in toks.iter().enumerate().take(end).skip(i) {
            if tok.opens(text) {
                in_text = !matches!(tok, Tok::Open { empty: true, .. });
            } else if tok.closes(text) {
                in_text = false;
            } else if in_text && matches!(tok, Tok::Text(_) | Tok::Literal { .. }) {
                pieces.push((j, joined.len()));
                joined.push_str(&text_of(tok));
            } else if ["w:tab", "w:br", "w:cr", "a:br"]
                .iter()
                .any(|tag| tok.opens(tag))
            {
                gaps.push(joined.len());
            }
        }
        let mut hits: Vec<usize> = vec![];
        // Nothing is looked for in a paragraph that holds another.
        let mut from = if nested || end == i { joined.len() } else { 0 };
        while let Some(at) = joined[from..].find(find).map(|at| from + at) {
            if gaps.iter().any(|gap| *gap > at && *gap < at + find.len()) {
                // Not a match, and one may still start inside it.
                from = at + joined[at..].chars().next().map_or(1, char::len_utf8);
            } else {
                hits.push(at);
                from = at + find.len();
            }
        }
        if hits.is_empty() {
            out.push_str(toks[i].raw());
            i += 1;
            continue;
        }
        count += hits.len();
        // Each piece's new text: what of it no match took, with the new
        // words in the piece where a match began.
        let piece_end = |k: usize| pieces.get(k + 1).map_or(joined.len(), |next| next.1);
        let piece_at = |at: usize| {
            (0..pieces.len())
                .find(|k| at >= pieces[*k].1 && at < piece_end(*k))
                .unwrap_or(pieces.len() - 1)
        };
        let mut changed = vec![String::new(); pieces.len()];
        let keep = |changed: &mut Vec<String>, from: usize, to: usize| {
            for (k, piece) in pieces.iter().enumerate() {
                let (start, stop) = (piece.1.max(from), piece_end(k).min(to));
                if start < stop {
                    changed[k].push_str(&joined[start..stop]);
                }
            }
        };
        let mut at = 0;
        for hit in hits {
            keep(&mut changed, at, hit);
            changed[piece_at(hit)].push_str(with);
            at = hit + find.len();
        }
        keep(&mut changed, at, joined.len());
        for (j, tok) in toks.iter().enumerate().take(end + 1).skip(i) {
            if let Some(k) = pieces.iter().position(|piece| piece.0 == j) {
                out.push_str(&escape(&changed[k]));
            } else if let Tok::Open { raw, .. } = tok
                && tok.opens(text)
                && text == "w:t"
                && !raw.contains("xml:space")
                && pieces
                    .iter()
                    .position(|piece| piece.0 == j + 1)
                    .is_some_and(|k| changed[k].trim() != changed[k])
            {
                // Word drops a space at either end unless it is told to keep it.
                out.push_str(&format!(
                    "{} xml:space=\"preserve\">",
                    raw.trim_end_matches('>')
                ));
            } else {
                out.push_str(tok.raw());
            }
        }
        i = end + 1;
    }
    (out, count)
}

const XML: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>"#;

/// A part's text with the XML declaration in front.
pub(crate) fn part(body: &str) -> Vec<u8> {
    format!("{XML}\n{body}").into_bytes()
}

/// The `docProps/core.xml` every new file carries: its title.
pub(crate) fn core(title: &str) -> Vec<u8> {
    let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ");
    part(&format!(
        r#"<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>{}</dc:title><dc:creator>Hexbot</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">{now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">{now}</dcterms:modified></cp:coreProperties>"#,
        escape(title)
    ))
}

/// Text cut to `cap` characters from `offset`, with where to read on. For
/// a document too long to hand a model whole.
pub(crate) fn window(text: &str, offset: usize, cap: usize) -> (String, Option<usize>) {
    let total = text.chars().count();
    if offset >= total {
        return (String::new(), None);
    }
    let piece: String = text.chars().skip(offset).take(cap).collect();
    let next = (offset + cap < total).then_some(offset + cap);
    (piece, next)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn xml_splits_into_pieces_that_join_back_exactly() {
        let xml = r#"<?xml version="1.0"?><w:p a="x > y"><!-- note --><w:t xml:space="preserve">a &amp; b</w:t><w:br/><![CDATA[1 < 2]]></w:p>"#;
        let toks = tokens(xml);
        assert_eq!(toks.iter().map(Tok::raw).collect::<String>(), xml);
        assert!(toks[1].opens("w:p"));
        assert_eq!(attr(toks[1].raw(), "a").as_deref(), Some("x > y"));
        assert!(toks[3].opens("w:t"));
        assert_eq!(text_of(&toks[4]), "a & b");
        assert!(matches!(
            toks[6],
            Tok::Open {
                name: "w:br",
                empty: true,
                ..
            }
        ));
        assert_eq!(text_of(&toks[7]), "1 < 2");
        assert!(toks[8].closes("w:p"));
    }

    #[test]
    fn attributes_are_found_by_their_whole_name() {
        let raw = r#"<c r="B2" customr="no" t = 's' w:val="&quot;x&#233;&#x41;"/>"#;
        assert_eq!(attr(raw, "r").as_deref(), Some("B2"));
        assert_eq!(attr(raw, "t").as_deref(), Some("s"));
        assert_eq!(attr(raw, "w:val").as_deref(), Some("\"x\u{e9}A"));
        assert_eq!(attr(raw, "val"), None);
        assert_eq!(attr(raw, "missing"), None);
    }

    #[test]
    fn escaping_round_trips_and_drops_what_xml_cannot_hold() {
        let text = "a < b & \"c\" > d\u{1}";
        assert_eq!(unescape(&escape(text)), "a < b & \"c\" > d");
        assert_eq!(
            unescape("AT&T &unknown; &#0; 5 & 6"),
            "AT&T &unknown; &#0; 5 & 6"
        );
    }

    #[test]
    fn parts_resolve_from_where_they_are_named() {
        assert_eq!(
            resolve("ppt/slides/slide1.xml", "../slideLayouts/slideLayout2.xml"),
            "ppt/slideLayouts/slideLayout2.xml"
        );
        assert_eq!(
            resolve("xl/workbook.xml", "worksheets/sheet1.xml"),
            "xl/worksheets/sheet1.xml"
        );
        assert_eq!(
            resolve("xl/workbook.xml", "/xl/styles.xml"),
            "xl/styles.xml"
        );
        assert_eq!(
            rels_name("word/document.xml"),
            "word/_rels/document.xml.rels"
        );
    }

    /// Writes one of each file Hexbot makes or changes into the folder
    /// `HEXBOT_OFFICE_SAMPLES` names, to open in Word, Excel and PowerPoint
    /// (`docs/testing.md`, "Office files").
    #[test]
    #[ignore = "writes files for a person to open in Office"]
    fn writes_sample_files_for_opening_in_office() {
        use crate::{excel, powerpoint, word, zip::Archive};
        use serde_json::json;
        let dir = std::path::PathBuf::from(
            std::env::var("HEXBOT_OFFICE_SAMPLES").expect("HEXBOT_OFFICE_SAMPLES"),
        );
        std::fs::create_dir_all(&dir).unwrap();
        let save = |name: &str, bytes: &[u8]| std::fs::write(dir.join(name), bytes).unwrap();

        let document = word::create(
            "Hexbot sample",
            "# Quarterly plan\n\nShip the **connectors** and *test* them, see [the docs](https://hexbot.app/docs).\n\n## Steps\n\n- Connect Gmail\n- Connect Calendar\n  - Google\n  - Outlook\n\n1. Draft\n2. Review\n3. Send\n\n| Service | Status |\n|---|---|\n| Word | Done |\n| Excel | Done |\n\n```\nlet total = a + b;\n```\n\n---\n\nCaf\u{e9} & <tags> \"quoted\".",
        );
        save("created.docx", &document);
        let document = Archive::open(document).unwrap();
        let appended = word::append(&document, "## Added later\n\nA new paragraph with a [link](https://example.com).\n\n- extra one\n- extra two").unwrap();
        save("appended.docx", &appended);
        let (replaced, _) =
            word::replace(&Archive::open(appended).unwrap(), "connectors", "plugins").unwrap();
        save("replaced.docx", &replaced);

        let rows = |v: serde_json::Value| excel::cells(&v).unwrap();
        let workbook = excel::create(
            "Hexbot sample",
            &[
                (
                    "Budget".into(),
                    rows(json!([
                        ["Item", "Cost", "Paid"],
                        ["Rent", 1200.5, true],
                        ["Power", 80, false],
                        ["Total", "=SUM(B2:B3)", null]
                    ])),
                ),
                ("Notes".into(), rows(json!([["Caf\u{e9} & <tags>"]]))),
            ],
        )
        .unwrap();
        save("created.xlsx", &workbook);
        let workbook = Archive::open(workbook).unwrap();
        let sheet = excel::sheet(&workbook, Some("Budget")).unwrap();
        let written = excel::write(
            &workbook,
            &sheet,
            3,
            2,
            &rows(json!([[95], ["=SUM(B2:B3)*2"]])),
        )
        .unwrap();
        let written = Archive::open(written).unwrap();
        let (appended, _) =
            excel::append(&written, &sheet, &rows(json!([["Water", 40, true]]))).unwrap();
        save("changed.xlsx", &appended);

        let outline = |v: serde_json::Value| powerpoint::outline(&v).unwrap();
        let deck = powerpoint::create(
            "Hexbot sample",
            &outline(json!([
                {"title": "Hexbot connectors", "body": "November 2026"},
                {"title": "What ships", "body": "- Google\n  - Gmail, Calendar, Drive\n  - Docs, Sheets, Slides, Tasks\n- Microsoft\n  - Outlook, Calendar, OneDrive\n  - Word, Excel, PowerPoint, To Do"},
                {"title": "Caf\u{e9} & <tags>", "body": "One line"},
            ])),
        );
        save("created.pptx", &deck);
        let added = powerpoint::add(
            &Archive::open(deck).unwrap(),
            &outline(json!([{"title": "Added later", "body": "First\nSecond"}])),
        )
        .unwrap();
        let (replaced, _) =
            powerpoint::replace(&Archive::open(added).unwrap(), "Microsoft", "Microsoft too")
                .unwrap();
        save("changed.pptx", &replaced);
    }

    #[test]
    fn a_long_text_is_read_in_windows() {
        assert_eq!(window("abcdef", 0, 4), ("abcd".into(), Some(4)));
        assert_eq!(window("abcdef", 4, 4), ("ef".into(), None));
        assert_eq!(window("abc", 9, 4), (String::new(), None));
    }
}
