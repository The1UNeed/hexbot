//! PowerPoint presentations (.pptx): read slide by slide, written new from
//! an outline, added to, and searched and replaced. Graph has no API for a
//! presentation's content, so the file itself is read and changed here;
//! what a change does not touch stays as PowerPoint wrote it (`ooxml.rs`).
use crate::{
    Error, Result,
    ooxml::{self, Tok, attr, escape, text_of, tokens},
    zip::{self, Archive},
};
use serde_json::Value;

const PRESENTATION: &str = "ppt/presentation.xml";
const MAX_SLIDES: usize = 200;

fn presentation(file: &Archive) -> Result<String> {
    file.text(PRESENTATION)?.ok_or_else(|| {
        Error::new(
            4202,
            "This isn't a PowerPoint presentation Hexbot can read (.pptx).",
        )
    })
}

// --- Reading --------------------------------------------------------------

/// A slide as a bot reads it.
#[derive(Debug, Clone, PartialEq, Default)]
pub(crate) struct Slide {
    pub title: String,
    /// Everything else on it, a paragraph a line, nested ones indented.
    pub text: String,
    pub notes: String,
}

/// The parts that hold the slides, in the order they are shown.
fn slide_parts(file: &Archive) -> Result<Vec<String>> {
    let rels = ooxml::rels(file, PRESENTATION)?;
    Ok(tokens(&presentation(file)?)
        .iter()
        .filter(|tok| tok.opens("p:sldId"))
        .filter_map(|tok| attr(tok.raw(), "r:id"))
        .filter_map(|id| rels.iter().find(|r| r.id == id && r.kind == "slide"))
        .map(|rel| rel.target.clone())
        .collect())
}

/// A slide's title and its other text. Dates, footers and slide numbers
/// are left out.
fn slide_text(xml: &str) -> (String, String) {
    let mut title = String::new();
    let mut lines: Vec<String> = vec![];
    // The shape being read: its placeholder kind and its lines.
    let mut shape: Option<(Option<String>, Vec<String>)> = None;
    let mut para: Option<(usize, String)> = None;
    let mut in_text = false;
    // The same content twice: once for new PowerPoint, once for old.
    let mut fallback = 0;
    let mut table: Option<Vec<Vec<String>>> = None;
    for tok in tokens(xml) {
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
                name: "p:sp",
                empty: false,
                ..
            } => shape = Some((None, vec![])),
            Tok::Open {
                name: "p:ph", raw, ..
            } => {
                if let Some(shape) = &mut shape {
                    shape.0 = Some(attr(raw, "type").unwrap_or_else(|| "body".into()));
                }
            }
            Tok::Open {
                name: "a:p",
                empty: false,
                ..
            } => para = Some((0, String::new())),
            Tok::Open {
                name: "a:pPr", raw, ..
            } => {
                if let Some(para) = &mut para {
                    para.0 = attr(raw, "lvl").and_then(|l| l.parse().ok()).unwrap_or(0);
                }
            }
            Tok::Open {
                name: "a:t", empty, ..
            } => in_text = !empty,
            Tok::Close { name: "a:t", .. } => in_text = false,
            Tok::Text(_) | Tok::Literal { .. } if in_text => {
                if let Some(para) = &mut para {
                    para.1.push_str(&text_of(&tok));
                }
            }
            Tok::Open { name: "a:br", .. } => {
                if let Some(para) = &mut para {
                    para.1.push(' ');
                }
            }
            Tok::Close { name: "a:p", .. } => {
                let Some((level, text)) = para.take() else {
                    continue;
                };
                let text = text.trim();
                if text.is_empty() {
                    continue;
                }
                if let Some(cell) = table
                    .as_mut()
                    .and_then(|t| t.last_mut())
                    .and_then(|r| r.last_mut())
                {
                    if !cell.is_empty() {
                        cell.push(' ');
                    }
                    cell.push_str(text);
                } else {
                    let line = format!("{}{text}", "  ".repeat(level.min(8)));
                    match &mut shape {
                        Some(shape) => shape.1.push(line),
                        None => lines.push(line),
                    }
                }
            }
            Tok::Close { name: "p:sp", .. } => {
                let Some((kind, text)) = shape.take() else {
                    continue;
                };
                match kind.as_deref() {
                    Some("title" | "ctrTitle") if title.is_empty() => {
                        title = text.iter().map(|l| l.trim()).collect::<Vec<_>>().join(" ");
                    }
                    Some("dt" | "ftr" | "sldNum" | "hdr") => {}
                    _ => lines.extend(text),
                }
            }
            Tok::Open { name: "a:tbl", .. } => table = Some(vec![]),
            Tok::Open { name: "a:tr", .. } => {
                if let Some(table) = &mut table {
                    table.push(vec![]);
                }
            }
            Tok::Open { name: "a:tc", .. } => {
                if let Some(row) = table.as_mut().and_then(|t| t.last_mut()) {
                    row.push(String::new());
                }
            }
            Tok::Close { name: "a:tbl", .. } => {
                for row in table.take().unwrap_or_default() {
                    lines.push(format!(
                        "| {} |",
                        row.iter()
                            .map(|c| c.replace('|', "\\|"))
                            .collect::<Vec<_>>()
                            .join(" | ")
                    ));
                }
            }
            _ => {}
        }
    }
    (title, lines.join("\n"))
}

pub(crate) fn read(file: &Archive) -> Result<Vec<Slide>> {
    read_within(file, ooxml::TEXT_BUDGET)
}

/// The slides, as long as their text together stays within `budget`.
fn read_within(file: &Archive, budget: usize) -> Result<Vec<Slide>> {
    let mut slides = vec![];
    let mut held = 0;
    for part in slide_parts(file)? {
        let Some(xml) = file.text(&part)? else {
            continue;
        };
        let (title, text) = slide_text(&xml);
        let notes = match ooxml::rels(file, &part)?
            .into_iter()
            .find(|r| r.kind == "notesSlide")
        {
            Some(rel) => file
                .text(&rel.target)?
                .map(|xml| slide_text(&xml).1)
                .unwrap_or_default(),
            None => String::new(),
        };
        held += title.len() + text.len() + notes.len();
        if held > budget {
            return Err(Error::new(
                4202,
                "This presentation can't be read: it holds too much text.",
            ));
        }
        slides.push(Slide { title, text, notes });
    }
    Ok(slides)
}

// --- Writing --------------------------------------------------------------

/// A slide as a bot writes it: a title, and lines under it with how deep
/// each is nested.
#[derive(Debug, Clone, PartialEq, Default)]
pub(crate) struct NewSlide {
    pub title: String,
    pub body: Vec<(u8, String)>,
}

/// The lines of a slide's body. A line may start with a list mark, which
/// is dropped; two spaces or a tab of indent nest it one level.
pub(crate) fn body_lines(text: &str) -> Vec<(u8, String)> {
    text.lines()
        .filter_map(|line| {
            let indent = line
                .chars()
                .take_while(|c| c.is_whitespace())
                .map(|c| if c == '\t' { 2 } else { 1 })
                .sum::<usize>();
            let rest = line.trim();
            let rest = ["- ", "* ", "\u{2022} ", "+ "]
                .iter()
                .find_map(|mark| rest.strip_prefix(mark))
                .unwrap_or(rest)
                .trim();
            (!rest.is_empty()).then(|| ((indent / 2).min(4) as u8, rest.to_owned()))
        })
        .collect()
}

/// Slides from the JSON a bot sends: a list of `{title, body}`.
pub(crate) fn outline(value: &Value) -> Result<Vec<NewSlide>> {
    let invalid = || {
        Error::new(
            4202,
            "slides must be a list of slides, each with a title and a body: [{\"title\": \"Plan\", \"body\": \"- First\\n- Second\"}]",
        )
    };
    let list = value.as_array().ok_or_else(invalid)?;
    if list.is_empty() {
        return Err(Error::new(4202, "slides is empty"));
    }
    if list.len() > MAX_SLIDES {
        return Err(Error::new(4202, "Write at most 200 slides at a time."));
    }
    list.iter()
        .map(|slide| {
            if !slide.is_object() {
                return Err(invalid());
            }
            let text = |key: &str| -> Result<&str> {
                match &slide[key] {
                    Value::Null => Ok(""),
                    Value::String(text) if text.chars().count() <= 20_000 => Ok(text),
                    Value::String(_) => {
                        Err(Error::new(4202, format!("A slide's {key} is too long.")))
                    }
                    _ => Err(invalid()),
                }
            };
            let slide = NewSlide {
                title: text("title")?
                    .split_whitespace()
                    .collect::<Vec<_>>()
                    .join(" "),
                body: body_lines(text("body")?),
            };
            if slide.title.is_empty() && slide.body.is_empty() {
                return Err(Error::new(4202, "A slide needs a title or a body."));
            }
            Ok(slide)
        })
        .collect()
}

const NS: &str = r#"xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main""#;
/// The group every slide's shapes sit in.
const TREE: &str = r#"<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>"#;

/// How a slide's two shapes hang on its layout.
struct Frame {
    /// The title placeholder, as `type="title"`; None for a plain text box.
    title: Option<String>,
    /// The body placeholder, as `idx="1"`; None for a plain text box.
    body: Option<String>,
    /// The slide's size, for where a plain text box goes.
    size: (u64, u64),
}

fn paragraphs(lines: &[(u8, String)]) -> String {
    if lines.is_empty() {
        return "<a:p/>".into();
    }
    lines
        .iter()
        .map(|(level, text)| {
            let level = if *level > 0 {
                format!(r#"<a:pPr lvl="{level}"/>"#)
            } else {
                String::new()
            };
            format!(
                r#"<a:p>{level}<a:r><a:rPr lang="en-US"/><a:t>{}</a:t></a:r></a:p>"#,
                escape(text)
            )
        })
        .collect()
}

/// One shape: a placeholder of the layout, or a text box at a place of
/// its own when the layout has none to fill.
fn shape(
    id: u32,
    name: &str,
    placeholder: Option<&str>,
    at: (u64, u64, u64, u64),
    big: bool,
    text: &str,
) -> String {
    match placeholder {
        Some(ph) => format!(
            r#"<p:sp><p:nvSpPr><p:cNvPr id="{id}" name="{name} {id}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph {ph}/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr><a:normAutofit/></a:bodyPr><a:lstStyle/>{text}</p:txBody></p:sp>"#
        ),
        None => format!(
            r#"<p:sp><p:nvSpPr><p:cNvPr id="{id}" name="{name} {id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="{}" y="{}"/><a:ext cx="{}" cy="{}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr wrap="square" rtlCol="0"><a:normAutofit/></a:bodyPr><a:lstStyle><a:lvl1pPr><a:defRPr sz="{size}"/></a:lvl1pPr></a:lstStyle>{text}</p:txBody></p:sp>"#,
            at.0,
            at.1,
            at.2,
            at.3,
            size = if big { 3600 } else { 2000 },
        ),
    }
}

fn slide_xml(slide: &NewSlide, frame: &Frame) -> String {
    let (w, h) = frame.size;
    let mut shapes = String::new();
    if !slide.title.is_empty() || frame.title.is_some() {
        shapes.push_str(&shape(
            2,
            "Title",
            frame.title.as_deref(),
            (w * 7 / 100, h * 6 / 100, w * 86 / 100, h * 18 / 100),
            true,
            &paragraphs(&[(0, slide.title.clone())]),
        ));
    }
    if !slide.body.is_empty() {
        shapes.push_str(&shape(
            3,
            "Content",
            frame.body.as_deref(),
            (w * 7 / 100, h * 27 / 100, w * 86 / 100, h * 63 / 100),
            false,
            &paragraphs(&slide.body),
        ));
    }
    format!(
        r#"<p:sld {NS}><p:cSld><p:spTree>{TREE}{shapes}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>"#
    )
}

const SLIDE_TYPE: &str = "application/vnd.openxmlformats-officedocument.presentationml.slide+xml";
const REL: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

fn layout_rel(target: &str) -> Vec<u8> {
    ooxml::part(&format!(
        r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="{REL}/slideLayout" Target="{target}"/></Relationships>"#
    ))
}

// A new presentation's own master, layouts and theme: a title slide and a
// title with content, 16:9, in plain black on white.

const THEME: &str = r#"<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Hexbot"><a:themeElements><a:clrScheme name="Hexbot"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F2937"/></a:dk2><a:lt2><a:srgbClr val="F3F4F6"/></a:lt2><a:accent1><a:srgbClr val="2563EB"/></a:accent1><a:accent2><a:srgbClr val="EA580C"/></a:accent2><a:accent3><a:srgbClr val="059669"/></a:accent3><a:accent4><a:srgbClr val="CA8A04"/></a:accent4><a:accent5><a:srgbClr val="7C3AED"/></a:accent5><a:accent6><a:srgbClr val="DB2777"/></a:accent6><a:hlink><a:srgbClr val="2563EB"/></a:hlink><a:folHlink><a:srgbClr val="7C3AED"/></a:folHlink></a:clrScheme><a:fontScheme name="Hexbot"><a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Hexbot"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln><a:ln w="12700" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln><a:ln w="19050" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>"#;

/// A placeholder on the master or a layout, with its place when it has one.
fn holder(
    id: u32,
    name: &str,
    ph: &str,
    at: Option<(u64, u64, u64, u64)>,
    body: &str,
    list: &str,
    prompt: &str,
) -> String {
    let place = match at {
        Some((x, y, cx, cy)) => format!(
            r#"<p:spPr><a:xfrm><a:off x="{x}" y="{y}"/><a:ext cx="{cx}" cy="{cy}"/></a:xfrm></p:spPr>"#
        ),
        None => "<p:spPr/>".into(),
    };
    format!(
        r#"<p:sp><p:nvSpPr><p:cNvPr id="{id}" name="{name}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph {ph}/></p:nvPr></p:nvSpPr>{place}<p:txBody><a:bodyPr{body}/><a:lstStyle>{list}</a:lstStyle><a:p><a:r><a:rPr lang="en-US"/><a:t>{prompt}</a:t></a:r></a:p></p:txBody></p:sp>"#
    )
}

fn master_xml() -> String {
    let text = r#"<a:solidFill><a:schemeClr val="tx1"/></a:solidFill>"#;
    let mut body_style = String::new();
    for (i, (margin, size)) in [
        (228_600, 2800),
        (685_800, 2400),
        (1_143_000, 2000),
        (1_600_200, 1800),
        (2_057_400, 1800),
    ]
    .iter()
    .enumerate()
    {
        body_style.push_str(&format!(
            r#"<a:lvl{n}pPr marL="{margin}" indent="-228600" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:lnSpc><a:spcPct val="90000"/></a:lnSpc><a:spcBef><a:spcPts val="{before}"/></a:spcBef><a:buFont typeface="Arial"/><a:buChar char="&#8226;"/><a:defRPr sz="{size}" kern="1200">{text}<a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl{n}pPr>"#,
            n = i + 1,
            before = if i == 0 { 1000 } else { 500 },
        ));
    }
    format!(
        r#"<p:sldMaster {NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>{TREE}{title}{body}</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/><p:sldLayoutId id="2147483650" r:id="rId2"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle><a:lvl1pPr algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:lnSpc><a:spcPct val="90000"/></a:lnSpc><a:spcBef><a:spcPct val="0"/></a:spcBef><a:buNone/><a:defRPr sz="4400" kern="1200">{text}<a:latin typeface="+mj-lt"/><a:ea typeface="+mj-ea"/><a:cs typeface="+mj-cs"/></a:defRPr></a:lvl1pPr></p:titleStyle><p:bodyStyle>{body_style}</p:bodyStyle><p:otherStyle><a:defPPr><a:defRPr lang="en-US"/></a:defPPr></p:otherStyle></p:txStyles></p:sldMaster>"#,
        title = holder(
            2,
            "Title Placeholder 1",
            r#"type="title""#,
            Some((838_200, 365_125, 10_515_600, 1_325_563)),
            r#" vert="horz" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0" anchor="ctr""#,
            "",
            "Click to edit Master title style",
        ),
        body = holder(
            3,
            "Text Placeholder 2",
            r#"type="body" idx="1""#,
            Some((838_200, 1_825_625, 10_515_600, 4_351_338)),
            r#" vert="horz" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0""#,
            "",
            "Click to edit Master text styles",
        ),
    )
}

fn layout_xml(title_slide: bool) -> String {
    let (kind, name, shapes) = if title_slide {
        (
            "title",
            "Title Slide",
            format!(
                "{}{}",
                holder(
                    2,
                    "Title 1",
                    r#"type="ctrTitle""#,
                    Some((1_524_000, 1_122_363, 9_144_000, 2_387_600)),
                    r#" anchor="b""#,
                    r#"<a:lvl1pPr algn="ctr"><a:defRPr sz="6000"/></a:lvl1pPr>"#,
                    "Click to edit Master title style",
                ),
                holder(
                    3,
                    "Subtitle 2",
                    r#"type="subTitle" idx="1""#,
                    Some((1_524_000, 3_602_038, 9_144_000, 1_655_762)),
                    "",
                    r#"<a:lvl1pPr marL="0" indent="0" algn="ctr"><a:buNone/><a:defRPr sz="2400"/></a:lvl1pPr><a:lvl2pPr marL="457200" indent="0" algn="ctr"><a:buNone/><a:defRPr sz="2000"/></a:lvl2pPr>"#,
                    "Click to edit Master subtitle style",
                ),
            ),
        )
    } else {
        (
            "obj",
            "Title and Content",
            format!(
                "{}{}",
                holder(
                    2,
                    "Title 1",
                    r#"type="title""#,
                    None,
                    "",
                    "",
                    "Click to edit Master title style"
                ),
                holder(
                    3,
                    "Content Placeholder 2",
                    r#"idx="1""#,
                    None,
                    "",
                    "",
                    "Click to edit Master text styles"
                ),
            ),
        )
    };
    format!(
        r#"<p:sldLayout {NS} type="{kind}" preserve="1"><p:cSld name="{name}"><p:spTree>{TREE}{shapes}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>"#
    )
}

const WIDE: (u64, u64) = (12_192_000, 6_858_000);

/// A new presentation from an outline. The first slide is a title slide
/// when it has two lines or fewer under its title.
pub(crate) fn create(title: &str, slides: &[NewSlide]) -> Vec<u8> {
    let mut types = String::from(
        r#"<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/slideLayouts/slideLayout2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>"#,
    );
    let mut rels = format!(
        r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="{REL}/slideMaster" Target="slideMasters/slideMaster1.xml"/><Relationship Id="rId2" Type="{REL}/theme" Target="theme/theme1.xml"/>"#
    );
    let mut ids = String::new();
    let mut parts: Vec<(String, Vec<u8>)> = vec![];
    for (i, slide) in slides.iter().enumerate() {
        let n = i + 1;
        let title_slide = i == 0 && slide.body.len() <= 2;
        let frame = Frame {
            title: Some(
                if title_slide {
                    r#"type="ctrTitle""#
                } else {
                    r#"type="title""#
                }
                .into(),
            ),
            body: Some(
                if title_slide {
                    r#"type="subTitle" idx="1""#
                } else {
                    r#"idx="1""#
                }
                .into(),
            ),
            size: WIDE,
        };
        types.push_str(&format!(
            r#"<Override PartName="/ppt/slides/slide{n}.xml" ContentType="{SLIDE_TYPE}"/>"#
        ));
        rels.push_str(&format!(
            r#"<Relationship Id="rId{}" Type="{REL}/slide" Target="slides/slide{n}.xml"/>"#,
            n + 2
        ));
        ids.push_str(&format!(
            r#"<p:sldId id="{}" r:id="rId{}"/>"#,
            255 + n,
            n + 2
        ));
        parts.push((
            format!("ppt/slides/slide{n}.xml"),
            ooxml::part(&slide_xml(slide, &frame)),
        ));
        parts.push((
            format!("ppt/slides/_rels/slide{n}.xml.rels"),
            layout_rel(if title_slide {
                "../slideLayouts/slideLayout1.xml"
            } else {
                "../slideLayouts/slideLayout2.xml"
            }),
        ));
    }
    types.push_str("</Types>");
    rels.push_str("</Relationships>");
    let presentation = format!(
        r#"<p:presentation {NS} saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>{ids}</p:sldIdLst><p:sldSz cx="{}" cy="{}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>"#,
        WIDE.0, WIDE.1
    );
    let master_rels = format!(
        r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="{REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="{REL}/slideLayout" Target="../slideLayouts/slideLayout2.xml"/><Relationship Id="rId3" Type="{REL}/theme" Target="../theme/theme1.xml"/></Relationships>"#
    );
    let to_master = ooxml::part(&format!(
        r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="{REL}/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>"#
    ));
    let mut all: Vec<(&str, Vec<u8>)> = vec![
        ("[Content_Types].xml", ooxml::part(&types)),
        (
            "_rels/.rels",
            ooxml::part(&format!(
                r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="{REL}/officeDocument" Target="ppt/presentation.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>"#
            )),
        ),
        ("docProps/core.xml", ooxml::core(title)),
        (PRESENTATION, ooxml::part(&presentation)),
        ("ppt/_rels/presentation.xml.rels", ooxml::part(&rels)),
        (
            "ppt/slideMasters/slideMaster1.xml",
            ooxml::part(&master_xml()),
        ),
        (
            "ppt/slideMasters/_rels/slideMaster1.xml.rels",
            ooxml::part(&master_rels),
        ),
        (
            "ppt/slideLayouts/slideLayout1.xml",
            ooxml::part(&layout_xml(true)),
        ),
        (
            "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
            to_master.clone(),
        ),
        (
            "ppt/slideLayouts/slideLayout2.xml",
            ooxml::part(&layout_xml(false)),
        ),
        ("ppt/slideLayouts/_rels/slideLayout2.xml.rels", to_master),
        ("ppt/theme/theme1.xml", ooxml::part(THEME)),
    ];
    for (name, bytes) in &parts {
        all.push((name.as_str(), bytes.clone()));
    }
    zip::build(&all)
}

/// The layout new slides in an existing presentation use: its title and
/// content one where it has it, and how that layout names its two
/// placeholders.
fn layout(file: &Archive) -> Result<(String, Option<String>, Option<String>)> {
    let no_layout = || {
        Error::new(
            4202,
            "This presentation has no slide layout to add a slide with.",
        )
    };
    let master = ooxml::rels(file, PRESENTATION)?
        .into_iter()
        .find(|r| r.kind == "slideMaster")
        .ok_or_else(no_layout)?;
    let mut best: Option<(u8, String, Option<String>, Option<String>)> = None;
    for rel in ooxml::rels(file, &master.target)?
        .into_iter()
        .filter(|r| r.kind == "slideLayout")
    {
        let Some(xml) = file.text(&rel.target)? else {
            continue;
        };
        let toks = tokens(&xml);
        let kind = toks
            .iter()
            .find(|t| t.opens("p:sldLayout"))
            .and_then(|t| attr(t.raw(), "type"))
            .unwrap_or_default();
        let (mut title, mut body) = (None, None);
        for tok in toks.iter().filter(|t| t.opens("p:ph")) {
            let raw = tok.raw();
            let idx = attr(raw, "idx")
                .filter(|i| i.chars().all(|c| c.is_ascii_digit()))
                .map(|i| format!(r#" idx="{i}""#))
                .unwrap_or_default();
            match attr(raw, "type").as_deref() {
                Some(kind @ ("title" | "ctrTitle")) if title.is_none() => {
                    title = Some(format!(r#"type="{kind}""#));
                }
                None if body.is_none() => body = Some(idx.trim().to_owned()),
                Some("body") if body.is_none() => body = Some(format!(r#"type="body"{idx}"#)),
                _ => {}
            }
        }
        // Title and content first, then any layout with both, then any.
        let rank = match (kind.as_str(), title.is_some(), body.is_some()) {
            ("obj", true, true) => 0,
            ("tx", true, true) => 1,
            (_, true, true) => 2,
            (_, true, false) => 3,
            _ => 4,
        };
        if best.as_ref().is_none_or(|b| rank < b.0) {
            best = Some((rank, rel.target, title, body));
        }
    }
    let (_, part, title, body) = best.ok_or_else(no_layout)?;
    Ok((part, title, body.filter(|b| !b.is_empty())))
}

/// The presentation with `slides` added after its last slide.
pub(crate) fn add(file: &Archive, slides: &[NewSlide]) -> Result<Vec<u8>> {
    let xml = presentation(file)?;
    let toks = tokens(&xml);
    let size = toks
        .iter()
        .find(|t| t.opens("p:sldSz"))
        .and_then(|t| {
            Some((
                attr(t.raw(), "cx")?.parse::<u64>().ok()?,
                attr(t.raw(), "cy")?.parse::<u64>().ok()?,
            ))
        })
        .unwrap_or(WIDE);
    let (layout, title, body) = layout(file)?;
    let frame = Frame { title, body, size };
    let rels_name = ooxml::rels_name(PRESENTATION);
    let rels = ooxml::rels(file, PRESENTATION)?;
    let mut rel = ooxml::next_rel(&rels);
    let mut id = toks
        .iter()
        .filter(|t| t.opens("p:sldId"))
        .filter_map(|t| attr(t.raw(), "id")?.parse::<u32>().ok())
        .max()
        .unwrap_or(255)
        + 1;
    let mut number = file
        .names()
        .filter_map(|name| {
            name.strip_prefix("ppt/slides/slide")?
                .strip_suffix(".xml")?
                .parse::<u32>()
                .ok()
        })
        .max()
        .unwrap_or(0)
        + 1;
    // Seen from the slides' folder.
    let layout_target = match layout.strip_prefix("ppt/") {
        Some(rest) => format!("../{rest}"),
        None => format!("/{layout}"),
    };
    let (mut ids, mut new_rels, mut types) = (String::new(), String::new(), String::new());
    let mut changes: Vec<(String, Option<Vec<u8>>)> = vec![];
    for slide in slides {
        ids.push_str(&format!(r#"<p:sldId id="{id}" r:id="rId{rel}"/>"#));
        new_rels.push_str(&format!(
            r#"<Relationship Id="rId{rel}" Type="{REL}/slide" Target="slides/slide{number}.xml"/>"#
        ));
        types.push_str(&format!(
            r#"<Override PartName="/ppt/slides/slide{number}.xml" ContentType="{SLIDE_TYPE}"/>"#
        ));
        changes.push((
            format!("ppt/slides/slide{number}.xml"),
            Some(ooxml::part(&slide_xml(slide, &frame))),
        ));
        changes.push((
            format!("ppt/slides/_rels/slide{number}.xml.rels"),
            Some(layout_rel(&layout_target)),
        ));
        (id, rel, number) = (id + 1, rel + 1, number + 1);
    }
    let damaged = || {
        Error::new(
            4202,
            "This presentation can't be changed: a part of it is damaged.",
        )
    };
    let listed = if xml.contains("</p:sldIdLst>") {
        ooxml::before_close(&xml, "p:sldIdLst", &ids)?
    } else if xml.contains("<p:sldIdLst/>") {
        xml.replacen(
            "<p:sldIdLst/>",
            &format!("<p:sldIdLst>{ids}</p:sldIdLst>"),
            1,
        )
    } else {
        // A presentation with no slide yet: the list goes before the size.
        let at = xml.find("<p:sldSz").ok_or_else(damaged)?;
        format!("{}<p:sldIdLst>{ids}</p:sldIdLst>{}", &xml[..at], &xml[at..])
    };
    changes.push((PRESENTATION.into(), Some(listed.into_bytes())));
    changes.push((
        rels_name.clone(),
        Some(
            ooxml::before_close(
                &file.text(&rels_name)?.ok_or_else(damaged)?,
                "Relationships",
                &new_rels,
            )?
            .into_bytes(),
        ),
    ));
    changes.push((
        "[Content_Types].xml".into(),
        Some(
            ooxml::before_close(
                &file.text("[Content_Types].xml")?.ok_or_else(damaged)?,
                "Types",
                &types,
            )?
            .into_bytes(),
        ),
    ));
    Ok(file.with(&changes))
}

/// The presentation with `find` replaced by `with` on every slide, and how
/// many times.
pub(crate) fn replace(file: &Archive, find: &str, with: &str) -> Result<(Vec<u8>, usize)> {
    let mut changes = vec![];
    let mut total = 0;
    for part in slide_parts(file)? {
        let Some(xml) = file.text(&part)? else {
            continue;
        };
        let (changed, count) = ooxml::replace_in(&xml, "a:p", "a:t", find, with);
        if count > 0 {
            total += count;
            changes.push((part, Some(changed.into_bytes())));
        }
    }
    if total == 0 {
        return Ok((vec![], 0));
    }
    Ok((file.with(&changes), total))
}

#[cfg(test)]
#[path = "powerpoint_tests.rs"]
mod tests;
