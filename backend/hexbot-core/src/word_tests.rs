use super::*;

const DOC_NS: &str = r#"xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main""#;

/// A document as Word in another language writes one: its heading style
/// has a translated id, and its page setup closes the body.
fn german(body: &str) -> Archive {
    Archive::open(zip::build(&[
        (
            DOCUMENT,
            format!(
                r#"<w:document {DOC_NS}><w:body>{body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>"#
            )
            .into_bytes(),
        ),
        (
            "word/styles.xml",
            format!(
                r#"<w:styles {DOC_NS}><w:style w:type="paragraph" w:styleId="berschrift1"><w:name w:val="heading 1"/></w:style><w:style w:type="paragraph" w:styleId="Titel"><w:name w:val="Title"/></w:style></w:styles>"#
            )
            .into_bytes(),
        ),
    ]))
    .unwrap()
}

#[test]
fn a_document_written_from_markdown_reads_back_as_the_same_text() {
    let file = create(
        "Plan",
        "# Plan\n\nShip **now**, see [the docs](https://example.com/docs).\n\n- one\n- two\n  - inner\n\n1. first\n2. second\n\n| Name | Total |\n|---|---|\n| Ana | 12 |\n\n```\nlet a = 1 < 2;\n```\n",
    );
    let archive = Archive::open(file).unwrap();
    assert_eq!(
        read(&archive).unwrap(),
        "# Plan\n\nShip now, see the docs.\n\n- one\n- two\n  - inner\n- first\n- second\n\n| Name | Total |\n| Ana | 12 |\n\nlet a = 1 < 2;"
    );
    let xml = archive.text(DOCUMENT).unwrap().unwrap();
    assert!(xml.contains(r#"<w:pStyle w:val="Heading1"/>"#));
    assert!(xml.contains("<w:b/>"));
    // The link is a real one, to an address the file names once.
    assert!(xml.contains(r#"<w:hyperlink r:id="rId100">"#));
    let rels = archive
        .text("word/_rels/document.xml.rels")
        .unwrap()
        .unwrap();
    assert!(rels.contains(r#"Target="https://example.com/docs" TargetMode="External""#));
    // Each numbered list counts from one; bullets share one list.
    let numbering = archive.text("word/numbering.xml").unwrap().unwrap();
    assert_eq!(numbering.matches("<w:num w:numId=").count(), 2);
    assert!(xml.contains("1 &lt; 2"));
}

#[test]
fn reading_keeps_structure_and_leaves_out_what_is_not_text() {
    let file = german(
        r#"<w:p><w:pPr><w:pStyle w:val="Titel"/></w:pPr><w:r><w:t>Bericht</w:t></w:r></w:p><w:p><w:pPr><w:pStyle w:val="berschrift1"/></w:pPr><w:r><w:t>Ein</w:t></w:r><w:r><w:t xml:space="preserve">s &amp; zwei</w:t></w:r></w:p><w:p><w:r><w:t>a</w:t><w:tab/><w:t>b</w:t><w:br/><w:t>c</w:t></w:r><w:r><w:delText>gone</w:delText></w:r></w:p><w:p><w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="3"/></w:numPr></w:pPr><w:r><w:t>nested</w:t></w:r></w:p><w:p/><mc:AlternateContent><mc:Choice><w:p><w:r><w:t>once</w:t></w:r></w:p></mc:Choice><mc:Fallback><w:p><w:r><w:t>once</w:t></w:r></w:p></mc:Fallback></mc:AlternateContent><w:tbl><w:tr><w:tc><w:p><w:r><w:t>A|1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B</w:t></w:r></w:p><w:p><w:r><w:t>more</w:t></w:r></w:p></w:tc></w:tr></w:tbl>"#,
    );
    assert_eq!(
        read(&file).unwrap(),
        "# Bericht\n\n# Eins & zwei\n\na\tb\nc\n\n  - nested\n\nonce\n\n| A\\|1 | B more |"
    );
}

#[test]
fn appended_content_goes_before_the_page_setup_in_the_documents_own_styles() {
    let file = german(r#"<w:p><w:r><w:t>Start</w:t></w:r></w:p>"#);
    let changed = Archive::open(
        append(
            &file,
            "# Neu\n\nMore [here](https://example.com).\n\n1. a\n2. b",
        )
        .unwrap(),
    )
    .unwrap();
    let xml = changed.text(DOCUMENT).unwrap().unwrap();
    // Its heading style is used by the id this document gives it.
    assert!(xml.contains(r#"<w:pStyle w:val="berschrift1"/>"#), "{xml}");
    assert!(!xml.contains("Heading1"));
    // Lists are written out, since this document's numbering is its own.
    assert_eq!(
        read(&changed).unwrap(),
        "Start\n\n# Neu\n\nMore here (https://example.com).\n\n1.\ta\n\n2.\tb"
    );
    let body_end = xml.find("<w:sectPr>").unwrap();
    assert!(xml.find("Neu").unwrap() < body_end);
    assert!(xml.ends_with("</w:sectPr></w:body></w:document>"));
    // Nothing else in the file changed.
    assert_eq!(
        changed.read("word/styles.xml").unwrap(),
        file.read("word/styles.xml").unwrap()
    );
    assert_eq!(append(&file, "  ").unwrap_err().code, 4202);
}

#[test]
fn a_section_break_inside_a_paragraph_is_not_the_end_of_the_body() {
    let file = Archive::open(zip::build(&[(
        DOCUMENT,
        format!(
            r#"<w:document {DOC_NS}><w:body><w:p><w:pPr><w:sectPr><w:pgSz w:w="1"/></w:sectPr></w:pPr><w:r><w:t>Last</w:t></w:r></w:p></w:body></w:document>"#
        )
        .into_bytes(),
    )]))
    .unwrap();
    let changed = Archive::open(append(&file, "After").unwrap()).unwrap();
    assert_eq!(read(&changed).unwrap(), "Last\n\nAfter");
}

#[test]
fn replace_finds_words_split_across_runs_and_counts_them() {
    let file = german(
        r#"<w:p><w:r><w:t>Due in 20</w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>25</w:t></w:r><w:r><w:t xml:space="preserve"> and 2025 again</w:t></w:r></w:p><w:p><w:r><w:t>Untouched 2024</w:t></w:r></w:p>"#,
    );
    let (bytes, count) = replace(&file, "2025", "2026 ").unwrap();
    assert_eq!(count, 2);
    let changed = Archive::open(bytes).unwrap();
    assert_eq!(
        read(&changed).unwrap(),
        "Due in 2026  and 2026  again\n\nUntouched 2024"
    );
    let xml = changed.text(DOCUMENT).unwrap().unwrap();
    // The paragraph that did not match is byte for byte what it was.
    assert!(xml.contains(r#"<w:p><w:r><w:t>Untouched 2024</w:t></w:r></w:p>"#));
    // The new words sit where the match began; the run it reached into
    // keeps its style and loses only the matched characters; the third
    // run changes in place. A space at an end is kept.
    assert!(
        xml.contains(r#"<w:r><w:t xml:space="preserve">Due in 2026 </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t></w:t></w:r><w:r><w:t xml:space="preserve"> and 2026  again</w:t></w:r>"#),
        "{xml}"
    );
    // No match changes nothing and uploads nothing.
    assert_eq!(replace(&file, "1999", "x").unwrap(), (vec![], 0));
}

/// Changing one word leaves every break, link and run of the paragraph
/// where it was.
#[test]
fn replace_leaves_breaks_links_and_other_runs_in_place() {
    let body = r#"<w:p><w:r><w:t>Before</w:t><w:br/><w:t>old</w:t></w:r><w:hyperlink r:id="rId5"><w:r><w:rPr><w:u w:val="single"/></w:rPr><w:t>Link</w:t></w:r></w:hyperlink><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>PAGE</w:instrText></w:r><w:r><w:t xml:space="preserve"> old</w:t></w:r></w:p>"#;
    let (changed, count) = ooxml::replace_in(body, "w:p", "w:t", "old", "new");
    assert_eq!(count, 2);
    assert_eq!(changed, body.replace("old", "new"));
    // A match that ends inside a link takes only its own characters from it.
    let (changed, count) = ooxml::replace_in(body, "w:p", "w:t", "oldLi", "X");
    assert_eq!(count, 1);
    assert!(
        changed.contains(r#"<w:t>Before</w:t><w:br/><w:t>X</w:t></w:r><w:hyperlink r:id="rId5"><w:r><w:rPr><w:u w:val="single"/></w:rPr><w:t>nk</w:t></w:r></w:hyperlink>"#),
        "{changed}"
    );
    assert_eq!(
        ooxml::replace_in(body, "w:p", "w:t", "", "x"),
        (body.to_owned(), 0)
    );
    // Words either side of a tab or a line break are not one word.
    let fields =
        r#"<w:p><w:r><w:t>12</w:t><w:tab/><w:t>34</w:t><w:br/><w:t>1234</w:t></w:r></w:p>"#;
    let (changed, count) = ooxml::replace_in(fields, "w:p", "w:t", "1234", "9");
    assert_eq!(count, 1);
    assert_eq!(
        changed,
        r#"<w:p><w:r><w:t>12</w:t><w:tab/><w:t>34</w:t><w:br/><w:t>9</w:t></w:r></w:p>"#
    );
    // A match may start inside words a tab kept from matching.
    let (changed, count) = ooxml::replace_in(
        r#"<w:p><w:r><w:t>a</w:t><w:tab/><w:t>aa</w:t></w:r></w:p>"#,
        "w:p",
        "w:t",
        "aa",
        "X",
    );
    assert_eq!(count, 1);
    assert_eq!(
        changed,
        r#"<w:p><w:r><w:t>a</w:t><w:tab/><w:t>X</w:t></w:r></w:p>"#
    );
}

#[test]
fn a_file_that_is_not_a_word_document_says_so() {
    let other = Archive::open(zip::build(&[("xl/workbook.xml", b"<workbook/>".to_vec())])).unwrap();
    assert!(read(&other).unwrap_err().message.contains("Word document"));
}
