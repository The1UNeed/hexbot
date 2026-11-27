//! Markdown as the blocks a document is made of. A bot writes a document's
//! content as Markdown; Word files and Google Docs are built from these
//! blocks (`word.rs`, `docs.rs`), so both read the same text the same way.
use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};

/// A stretch of text in one style.
#[derive(Debug, Clone, PartialEq, Default)]
pub(crate) struct Run {
    pub text: String,
    pub bold: bool,
    pub italic: bool,
    pub code: bool,
    pub link: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Block {
    /// Level 1 to 6.
    Heading(u8, Vec<Run>),
    Paragraph(Vec<Run>),
    /// A list item. `list` numbers the list it belongs to, so each numbered
    /// list counts from one; `ordered` is its number style.
    Item {
        list: u32,
        ordered: bool,
        level: u8,
        runs: Vec<Run>,
    },
    Code(String),
    /// Rows of cells; the first row is the header.
    Table(Vec<Vec<Vec<Run>>>),
    Rule,
}

/// The plain text of some runs.
#[cfg(test)]
pub(crate) fn plain(runs: &[Run]) -> String {
    runs.iter().map(|r| r.text.as_str()).collect()
}

#[derive(Default)]
struct Style {
    bold: u32,
    italic: u32,
    quote: u32,
    link: Option<String>,
}

pub(crate) fn blocks(markdown: &str) -> Vec<Block> {
    let mut out = vec![];
    let mut runs: Vec<Run> = vec![];
    let mut style = Style::default();
    // Open lists, innermost last: (list number, ordered).
    let mut lists: Vec<(u32, bool)> = vec![];
    let mut list_count = 0;
    // Whether the text being gathered belongs to a list item.
    let mut item = false;
    let mut heading = None;
    let mut code: Option<String> = None;
    let mut table: Option<Vec<Vec<Vec<Run>>>> = None;
    let mut row: Vec<Vec<Run>> = vec![];

    fn push(runs: &mut Vec<Run>, style: &Style, text: &str, code: bool) {
        if text.is_empty() {
            return;
        }
        let run = Run {
            text: text.to_owned(),
            bold: style.bold > 0,
            italic: style.italic > 0 || style.quote > 0,
            code,
            link: style.link.clone(),
        };
        match runs.last_mut() {
            Some(last)
                if (last.bold, last.italic, last.code, &last.link)
                    == (run.bold, run.italic, run.code, &run.link) =>
            {
                last.text.push_str(&run.text)
            }
            _ => runs.push(run),
        }
    }
    // Ends the text gathered so far as a paragraph or a list item.
    fn flush(out: &mut Vec<Block>, runs: &mut Vec<Run>, lists: &[(u32, bool)], item: bool) {
        if runs.is_empty() {
            return;
        }
        let runs = std::mem::take(runs);
        match lists.last() {
            Some((list, ordered)) if item => out.push(Block::Item {
                list: *list,
                ordered: *ordered,
                level: (lists.len() - 1).min(8) as u8,
                runs,
            }),
            _ => out.push(Block::Paragraph(runs)),
        }
    }

    let options = Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH;
    for event in Parser::new_ext(markdown, options) {
        match event {
            Event::Start(tag) => match tag {
                Tag::Heading { level, .. } => {
                    flush(&mut out, &mut runs, &lists, item);
                    heading = Some(level as u8);
                }
                Tag::Paragraph => {
                    // A second paragraph in one item stays in it, on a new line.
                    if item && !runs.is_empty() {
                        push(&mut runs, &style, "\n", false);
                    }
                }
                Tag::List(first) => {
                    flush(&mut out, &mut runs, &lists, item);
                    list_count += 1;
                    lists.push((list_count, first.is_some()));
                }
                Tag::Item => {
                    flush(&mut out, &mut runs, &lists, item);
                    item = true;
                }
                Tag::CodeBlock(_) => {
                    flush(&mut out, &mut runs, &lists, item);
                    code = Some(String::new());
                }
                Tag::Table(_) => {
                    flush(&mut out, &mut runs, &lists, item);
                    table = Some(vec![]);
                }
                Tag::TableHead | Tag::TableRow => row = vec![],
                Tag::TableCell => runs = vec![],
                Tag::Emphasis => style.italic += 1,
                Tag::Strong => style.bold += 1,
                Tag::BlockQuote(_) => {
                    flush(&mut out, &mut runs, &lists, item);
                    style.quote += 1;
                }
                Tag::Link { dest_url, .. } => {
                    style.link = web_link(&dest_url).then(|| dest_url.to_string());
                }
                _ => {}
            },
            Event::End(tag) => match tag {
                TagEnd::Heading(_) => {
                    let level = heading.take().unwrap_or(1).clamp(1, 6);
                    out.push(Block::Heading(level, std::mem::take(&mut runs)));
                }
                TagEnd::Paragraph => {
                    if !item && table.is_none() {
                        flush(&mut out, &mut runs, &lists, item);
                    }
                }
                TagEnd::Item => {
                    flush(&mut out, &mut runs, &lists, item);
                    // Back in the item that holds this list, if any.
                    item = !lists.is_empty();
                }
                TagEnd::List(_) => {
                    flush(&mut out, &mut runs, &lists, item);
                    lists.pop();
                    item = !lists.is_empty();
                }
                TagEnd::CodeBlock => {
                    if let Some(text) = code.take() {
                        out.push(Block::Code(text.trim_end_matches('\n').to_owned()));
                    }
                }
                TagEnd::TableCell => row.push(std::mem::take(&mut runs)),
                TagEnd::TableHead | TagEnd::TableRow => {
                    if let Some(table) = &mut table {
                        table.push(std::mem::take(&mut row));
                    }
                }
                TagEnd::Table => {
                    if let Some(rows) = table.take() {
                        out.push(Block::Table(rows));
                    }
                }
                TagEnd::Emphasis => style.italic = style.italic.saturating_sub(1),
                TagEnd::Strong => style.bold = style.bold.saturating_sub(1),
                TagEnd::BlockQuote(_) => {
                    flush(&mut out, &mut runs, &lists, item);
                    style.quote = style.quote.saturating_sub(1);
                }
                TagEnd::Link => style.link = None,
                _ => {}
            },
            Event::Text(text) => match &mut code {
                Some(code) => code.push_str(&text),
                None => push(&mut runs, &style, &text, false),
            },
            Event::Code(text) => push(&mut runs, &style, &text, true),
            Event::SoftBreak => push(&mut runs, &style, " ", false),
            Event::HardBreak => push(&mut runs, &style, "\n", false),
            Event::Rule => {
                flush(&mut out, &mut runs, &lists, item);
                out.push(Block::Rule);
            }
            // Raw HTML is shown as the text it is, never interpreted.
            Event::Html(text) | Event::InlineHtml(text) => push(&mut runs, &style, &text, false),
            Event::TaskListMarker(done) => {
                push(&mut runs, &style, if done { "☑ " } else { "☐ " }, false)
            }
            _ => {}
        }
    }
    flush(&mut out, &mut runs, &lists, item);
    out
}

/// Whether a link goes to the web or to an address: the only kinds kept.
fn web_link(url: &str) -> bool {
    ["https://", "http://", "mailto:"]
        .iter()
        .any(|scheme| url.starts_with(scheme))
}

/// Markdown as HTML, for a service that turns HTML into its own document.
/// Raw HTML in the source is escaped, so it arrives as text, and a link
/// that isn't to the web goes nowhere.
pub(crate) fn html(markdown: &str) -> String {
    let options = Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH;
    let events = Parser::new_ext(markdown, options).map(|event| match event {
        Event::Html(text) | Event::InlineHtml(text) => Event::Text(text),
        Event::Start(Tag::Link {
            link_type,
            dest_url,
            title,
            id,
        }) if !web_link(&dest_url) => Event::Start(Tag::Link {
            link_type,
            dest_url: "".into(),
            title,
            id,
        }),
        other => other,
    });
    let mut out = String::new();
    pulldown_cmark::html::push_html(&mut out, events);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(block: &Block) -> String {
        match block {
            Block::Heading(_, runs) | Block::Paragraph(runs) | Block::Item { runs, .. } => {
                plain(runs)
            }
            Block::Code(text) => text.clone(),
            _ => String::new(),
        }
    }

    #[test]
    fn markdown_becomes_headings_paragraphs_lists_and_tables() {
        let found = blocks(
            "# Plan\n\nShip **now**, see [docs](https://example.com).\n\n- one\n- two\n  - inner\n\n1. first\n2. second\n\n```\nlet a = 1;\n```\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n---\n",
        );
        assert!(matches!(&found[0], Block::Heading(1, _)));
        assert_eq!(text(&found[0]), "Plan");
        let Block::Paragraph(runs) = &found[1] else {
            panic!("{found:?}")
        };
        assert_eq!(plain(runs), "Ship now, see docs.");
        assert!(runs.iter().any(|r| r.bold && r.text == "now"));
        assert_eq!(
            runs.iter()
                .find(|r| r.text == "docs")
                .unwrap()
                .link
                .as_deref(),
            Some("https://example.com")
        );
        let items = found
            .iter()
            .filter_map(|b| match b {
                Block::Item {
                    list,
                    ordered,
                    level,
                    runs,
                } => Some((*list, *ordered, *level, plain(runs))),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(
            items,
            [
                (1, false, 0, "one".to_owned()),
                (1, false, 0, "two".to_owned()),
                (2, false, 1, "inner".to_owned()),
                (3, true, 0, "first".to_owned()),
                (3, true, 0, "second".to_owned()),
            ]
        );
        assert!(found.contains(&Block::Code("let a = 1;".into())));
        let Some(Block::Table(rows)) = found.iter().find(|b| matches!(b, Block::Table(_))) else {
            panic!("{found:?}")
        };
        assert_eq!(rows.len(), 2);
        assert_eq!(plain(&rows[1][1]), "2");
        assert_eq!(found.last(), Some(&Block::Rule));
    }

    #[test]
    fn raw_html_stays_text_and_only_web_links_are_links() {
        let found = blocks("<script>x</script> and [a](javascript:alert(1))");
        let all = found.iter().map(text).collect::<String>();
        assert!(all.contains("<script>"), "{all}");
        for block in &found {
            if let Block::Paragraph(runs) = block {
                assert!(runs.iter().all(|r| r.link.is_none()));
            }
        }
        assert!(html("<script>x</script>").contains("&lt;script&gt;"));
    }
}
