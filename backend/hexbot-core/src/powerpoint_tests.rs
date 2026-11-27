use super::*;
use serde_json::json;

fn deck() -> Vec<NewSlide> {
    outline(&json!([
        {"title": "Q3  plan", "body": "Hexbot team"},
        {"title": "Goals", "body": "- Ship connectors\n  - Google & Microsoft\n* Test\n\n"},
        {"title": "Thanks"},
    ]))
    .unwrap()
}

#[test]
fn an_outline_is_slides_with_nested_lines() {
    let slides = deck();
    assert_eq!(slides[0].title, "Q3 plan");
    assert_eq!(
        slides[1].body,
        [
            (0, "Ship connectors".to_owned()),
            (1, "Google & Microsoft".to_owned()),
            (0, "Test".to_owned())
        ]
    );
    assert!(slides[2].body.is_empty());
    for bad in [
        json!("x"),
        json!([]),
        json!(["x"]),
        json!([{}]),
        json!([{"title": 3}]),
    ] {
        assert_eq!(outline(&bad).unwrap_err().code, 4202, "{bad}");
    }
}

#[test]
fn a_new_presentation_reads_back_as_its_outline() {
    let file = Archive::open(create("Q3", &deck())).unwrap();
    assert_eq!(
        read(&file).unwrap(),
        [
            Slide {
                title: "Q3 plan".into(),
                text: "Hexbot team".into(),
                notes: String::new()
            },
            Slide {
                title: "Goals".into(),
                text: "Ship connectors\n  Google & Microsoft\nTest".into(),
                notes: String::new()
            },
            Slide {
                title: "Thanks".into(),
                text: String::new(),
                notes: String::new()
            },
        ]
    );
    // The first is a title slide; the others a title with content.
    let first = file.text("ppt/slides/slide1.xml").unwrap().unwrap();
    assert!(
        first.contains(r#"<p:ph type="ctrTitle"/>"#)
            && first.contains(r#"<p:ph type="subTitle" idx="1"/>"#)
    );
    let second = file.text("ppt/slides/slide2.xml").unwrap().unwrap();
    assert!(second.contains(r#"<p:ph type="title"/>"#) && second.contains(r#"<p:ph idx="1"/>"#));
    assert!(second.contains(r#"<a:pPr lvl="1"/>"#) && second.contains("Google &amp; Microsoft"));
    assert!(
        file.text("ppt/slides/_rels/slide2.xml.rels")
            .unwrap()
            .unwrap()
            .contains("../slideLayouts/slideLayout2.xml")
    );
    // Every part a slide, layout or master points to is in the file.
    for name in file
        .names()
        .filter(|n| n.ends_with(".xml") && !n.starts_with('['))
        .map(str::to_owned)
        .collect::<Vec<_>>()
    {
        for rel in ooxml::rels(&file, &name).unwrap() {
            assert!(
                rel.external || file.has(&rel.target),
                "{name} points to {}",
                rel.target
            );
        }
    }
    let types = file.text("[Content_Types].xml").unwrap().unwrap();
    for name in file
        .names()
        .filter(|n| n.starts_with("ppt/") && n.ends_with(".xml"))
    {
        assert!(
            types.contains(&format!(r#"PartName="/{name}""#)),
            "{name} has no content type"
        );
    }
}

/// A small file can unpack to far more text than it weighs.
#[test]
fn a_presentation_with_too_much_text_is_refused() {
    let file = Archive::open(create("Q3", &deck())).unwrap();
    assert!(read_within(&file, 1_000).is_ok());
    // Counting its slides reads none of their text.
    assert_eq!(count(&file).unwrap(), deck().len());
    assert_eq!(
        read_within(&file, 20).unwrap_err().message,
        "This presentation can't be read: it holds too much text."
    );
}

#[test]
fn slides_are_added_after_the_last_in_the_presentations_own_layout() {
    let file = Archive::open(create("Q3", &deck())).unwrap();
    let more =
        outline(&json!([{"title": "Next", "body": "One\nTwo"}, {"body": "No title"}])).unwrap();
    let changed = Archive::open(add(&file, &more).unwrap()).unwrap();
    let slides = read(&changed).unwrap();
    assert_eq!(slides.len(), 5);
    assert_eq!(slides[3].title, "Next");
    assert_eq!(slides[3].text, "One\nTwo");
    assert_eq!(slides[4].text, "No title");
    // New parts, each listed everywhere a slide must be, with ids of its own.
    let presentation = changed.text(PRESENTATION).unwrap().unwrap();
    assert!(
        presentation.contains(
            r#"<p:sldId id="259" r:id="rId6"/><p:sldId id="260" r:id="rId7"/></p:sldIdLst>"#
        ),
        "{presentation}"
    );
    assert!(
        changed
            .text("ppt/slides/_rels/slide4.xml.rels")
            .unwrap()
            .unwrap()
            .contains("../slideLayouts/slideLayout2.xml")
    );
    assert!(
        changed
            .text("[Content_Types].xml")
            .unwrap()
            .unwrap()
            .contains(r#"PartName="/ppt/slides/slide5.xml""#)
    );
    // The slides that were there are byte for byte what they were.
    assert_eq!(
        changed.read("ppt/slides/slide2.xml").unwrap(),
        file.read("ppt/slides/slide2.xml").unwrap()
    );
}

/// A presentation from elsewhere: its layout has no body placeholder, a
/// slide carries notes, a table and a footer, and old PowerPoint's copy of
/// a shape sits beside the new one.
fn foreign() -> Archive {
    let rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
    let rels = |body: &str| format!(r#"<Relationships>{body}</Relationships>"#).into_bytes();
    Archive::open(zip::build(&[
        ("[Content_Types].xml", b"<Types></Types>".to_vec()),
        (PRESENTATION, br#"<p:presentation><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst><p:sldId id="300" r:id="rId9"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/></p:presentation>"#.to_vec()),
        ("ppt/_rels/presentation.xml.rels", rels(&format!(r#"<Relationship Id="rId1" Type="{rel}/slideMaster" Target="slideMasters/slideMaster1.xml"/><Relationship Id="rId9" Type="{rel}/slide" Target="slides/slide7.xml"/>"#))),
        ("ppt/slideMasters/_rels/slideMaster1.xml.rels", rels(&format!(r#"<Relationship Id="rId1" Type="{rel}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>"#))),
        ("ppt/slideLayouts/slideLayout1.xml", br#"<p:sldLayout type="titleOnly"><p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr></p:sp><p:sp><p:nvSpPr><p:nvPr><p:ph type="sldNum" idx="12"/></p:nvPr></p:nvSpPr></p:sp></p:sldLayout>"#.to_vec()),
        ("ppt/slides/slide7.xml", br#"<p:sld><p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>Sales </a:t></a:r><a:r><a:t>2025</a:t></a:r></a:p></p:txBody></p:sp><p:sp><p:nvSpPr><p:nvPr><p:ph type="ftr"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>Confidential</a:t></a:r></a:p></p:txBody></p:sp><p:graphicFrame><a:tbl><a:tr><a:tc><a:txBody><a:p><a:r><a:t>Q1</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>12</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl></p:graphicFrame><mc:AlternateContent><mc:Choice><p:sp><p:txBody><a:p><a:r><a:t>Once in 2025</a:t></a:r></a:p></p:txBody></p:sp></mc:Choice><mc:Fallback><p:sp><p:txBody><a:p><a:r><a:t>Once in 2025</a:t></a:r></a:p></p:txBody></p:sp></mc:Fallback></mc:AlternateContent></p:sld>"#.to_vec()),
        ("ppt/slides/_rels/slide7.xml.rels", rels(&format!(r#"<Relationship Id="rId2" Type="{rel}/notesSlide" Target="../notesSlides/notesSlide1.xml"/>"#))),
        ("ppt/notesSlides/notesSlide1.xml", br#"<p:notes><p:sp><p:nvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr></p:sp><p:sp><p:nvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>Say hello.</a:t></a:r></a:p></p:txBody></p:sp><p:sp><p:nvSpPr><p:nvPr><p:ph type="sldNum"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:fld><a:t>1</a:t></a:fld></a:p></p:txBody></p:sp></p:notes>"#.to_vec()),
    ]))
    .unwrap()
}

#[test]
fn a_presentation_from_elsewhere_reads_with_its_notes_and_tables() {
    assert_eq!(
        read(&foreign()).unwrap(),
        [Slide {
            title: "Sales 2025".into(),
            text: "| Q1 | 12 |\nOnce in 2025".into(),
            notes: "Say hello.".into()
        }]
    );
}

#[test]
fn a_layout_without_a_body_gets_a_text_box_sized_to_the_slide() {
    let file = foreign();
    let changed = Archive::open(
        add(
            &file,
            &outline(&json!([{"title": "More", "body": "Line"}])).unwrap(),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(read(&changed).unwrap()[1].text, "Line");
    // The next free number, not one after a count.
    let slide = changed.text("ppt/slides/slide8.xml").unwrap().unwrap();
    assert!(slide.contains(r#"<p:ph type="title"/>"#));
    assert!(
        slide.contains(r#"<p:cNvSpPr txBox="1"/>"#)
            && slide.contains(r#"<a:off x="640080" y="1851660"/>"#),
        "{slide}"
    );
    assert!(
        changed
            .text(PRESENTATION)
            .unwrap()
            .unwrap()
            .contains(r#"<p:sldId id="301" r:id="rId10"/>"#)
    );
}

#[test]
fn replace_reaches_every_slide_and_words_split_across_runs() {
    let file = foreign();
    let (bytes, count) = replace(&file, "2025", "2026").unwrap();
    // The title, the shape, and old PowerPoint's copy of it.
    assert_eq!(count, 3);
    let changed = Archive::open(bytes).unwrap();
    let slide = &read(&changed).unwrap()[0];
    assert_eq!(slide.title, "Sales 2026");
    assert!(slide.text.ends_with("Once in 2026"));
    assert_eq!(replace(&file, "1999", "x").unwrap(), (vec![], 0));
    // Notes are not slides.
    assert_eq!(replace(&file, "hello", "bye").unwrap().1, 0);
}
