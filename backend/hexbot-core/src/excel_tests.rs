use super::*;

const MAIN: &str = r#"xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships""#;

/// A workbook as Excel writes one: shared strings, a date style, a formula
/// with a kept result, a row width hint, and its formula order list.
fn budget() -> Archive {
    let rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
    Archive::open(zip::build(&[
        (
            "[Content_Types].xml",
            br#"<Types><Override PartName="/xl/workbook.xml" ContentType="a"/><Override PartName="/xl/calcChain.xml" ContentType="b"/></Types>"#.to_vec(),
        ),
        (
            WORKBOOK,
            format!(r#"<workbook {MAIN}><bookViews><workbookView><extLst/></workbookView></bookViews><sheets><sheet name="Budget" sheetId="1" r:id="rId1"/><sheet name="Notes &amp; more" sheetId="2" r:id="rId2"/></sheets><definedNames><definedName name="x">Budget!$A$1</definedName></definedNames><extLst/></workbook>"#).into_bytes(),
        ),
        (
            "xl/_rels/workbook.xml.rels",
            format!(r#"<Relationships><Relationship Id="rId1" Type="{rel}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="{rel}/worksheet" Target="/xl/worksheets/sheet2.xml"/><Relationship Id="rId3" Type="{rel}/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rId4" Type="{rel}/styles" Target="styles.xml"/><Relationship Id="rId5" Type="{rel}/calcChain" Target="calcChain.xml"/></Relationships>"#).into_bytes(),
        ),
        (
            "xl/sharedStrings.xml",
            br#"<sst><si><t>Item</t></si><si><r><t>To</t></r><r><t>tal</t></r><rPh><t>ignored</t></rPh></si><si><t xml:space="preserve">Rent &amp; power</t></si></sst>"#.to_vec(),
        ),
        (
            "xl/styles.xml",
            br#"<styleSheet><numFmts><numFmt numFmtId="164" formatCode="yyyy\-mm\-dd"/><numFmt numFmtId="165" formatCode="0.0 &quot;days&quot;"/></numFmts><cellStyleXfs><xf numFmtId="0"/></cellStyleXfs><cellXfs><xf numFmtId="0"/><xf numFmtId="164"/><xf numFmtId="165"/><xf numFmtId="14"/></cellXfs></styleSheet>"#.to_vec(),
        ),
        (
            "xl/worksheets/sheet1.xml",
            format!(r#"<worksheet {MAIN}><dimension ref="A1:C3"/><sheetData><row r="1" spans="1:3" ht="20"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" s="1"><v>45000</v></c></row><row r="2" spans="1:3"><c r="A2" t="s"><v>2</v></c><c r="B2" s="2"><v>1200.5</v></c><c r="C2" t="b"><v>1</v></c></row><row r="3"><c r="B3"><f>SUM(B2:B2)</f><v>1200.5</v></c><c r="C3" t="inlineStr"><is><t>inline</t></is></c></row></sheetData><mergeCells count="0"/></worksheet>"#).into_bytes(),
        ),
        (
            "xl/worksheets/sheet2.xml",
            format!(r#"<worksheet {MAIN}><sheetData/></worksheet>"#).into_bytes(),
        ),
        ("xl/calcChain.xml", br#"<calcChain><c r="B3"/></calcChain>"#.to_vec()),
    ]))
    .unwrap()
}

fn shown(file: &Archive, sheet: &str, range: &str, formulas: bool) -> Value {
    let sheet = super::sheet(file, Some(sheet)).unwrap();
    json!(
        grid(file, &sheet)
            .unwrap()
            .rows(super::range(range).unwrap().1, formulas)
    )
}

#[test]
fn cells_are_named_and_ranges_parsed() {
    assert_eq!(cell_ref("B12"), Some((12, 2)));
    assert_eq!(cell_ref("$AA$1"), Some((1, 27)));
    assert_eq!(cell_ref("XFD1048576"), Some((MAX_ROWS, MAX_COLUMNS)));
    for bad in ["", "12", "B", "XFE1", "A0", "A1048577", "A1B"] {
        assert_eq!(cell_ref(bad), None, "{bad}");
    }
    assert_eq!(column_name(1), "A");
    assert_eq!(column_name(26), "Z");
    assert_eq!(column_name(27), "AA");
    assert_eq!(column_name(MAX_COLUMNS), "XFD");
    assert_eq!(
        range("'Q1 ''26'!c10:A1").unwrap(),
        (
            Some("Q1 '26".into()),
            Range {
                from: (1, 1),
                to: (10, 3)
            }
        )
    );
    assert_eq!(range("B2").unwrap().1.name(), "B2:B2");
    assert_eq!(range("A:C").unwrap_err().code, 4202);
}

/// Every cell that points at a shared string holds a copy of it, so a small
/// file with one long string and many cells is refused, not read.
#[test]
fn a_sheet_that_repeats_a_long_string_is_refused() {
    let cells = (1..=40)
        .map(|row| format!(r#"<row r="{row}"><c r="A{row}" t="s"><v>0</v></c></row>"#))
        .collect::<String>();
    let file = Archive::open(
        budget().with(&[
            (
                "xl/sharedStrings.xml".into(),
                Some(
                    format!("<sst><si><t>{}</t></si></sst>", "x".repeat(1024 * 1024)).into_bytes(),
                ),
            ),
            (
                "xl/worksheets/sheet2.xml".into(),
                Some(
                    format!(r#"<worksheet {MAIN}><sheetData>{cells}</sheetData></worksheet>"#)
                        .into_bytes(),
                ),
            ),
        ]),
    )
    .unwrap();
    let sheet = super::sheet(&file, Some("Notes & more")).unwrap();
    let error = grid(&file, &sheet).err().unwrap();
    assert_eq!(error.code, 4202);
    assert!(error.message.contains("too much text"), "{}", error.message);
    // The sheet that points at it once still reads.
    let first = super::sheet(&file, Some("Budget")).unwrap();
    assert!(grid(&file, &first).is_ok());
}

#[test]
fn one_read_takes_a_window_of_a_range() {
    let cells = |text: &str| range(text).unwrap().1;
    // What fits is shown whole.
    assert_eq!(
        cells("A1:B2").window(10, 10, 100),
        Some((cells("A1:B2"), None))
    );
    // Only what the sheet holds, cut by whole rows, with the rest named.
    let (shown, rest) = cells("B2:D500").window(40, 3, 30).unwrap();
    assert_eq!(shown.name(), "B2:C16");
    assert_eq!(rest.unwrap().name(), "B17:C40");
    // A sheet whose last cell is a million rows down is never made whole.
    let (shown, rest) = cells("A1:XFD1048576")
        .window(MAX_ROWS, MAX_COLUMNS, 20_000)
        .unwrap();
    assert_eq!(shown.name(), "A1:XFD1");
    assert_eq!(rest.unwrap().name(), "A2:XFD1048576");
    // A range that starts past the sheet's edge holds nothing.
    assert_eq!(cells("E1:F2").window(40, 3, 30), None);
    assert_eq!(cells("A1:B2").window(0, 0, 30), None);
}

#[test]
fn a_workbook_reads_as_what_its_cells_show() {
    let file = budget();
    assert_eq!(
        sheets(&file)
            .unwrap()
            .iter()
            .map(|s| s.name.as_str())
            .collect::<Vec<_>>(),
        ["Budget", "Notes & more"]
    );
    // Shared and rich strings, a date, a number, a tick, a result, own text.
    assert_eq!(
        shown(&file, "budget", "A1:C3", false),
        json!([
            ["Item", "Total", "2023-03-15"],
            ["Rent & power", 1200.5, true],
            ["", 1200.5, "inline"]
        ])
    );
    assert_eq!(
        shown(&file, "Budget", "B3:B3", true),
        json!([["=SUM(B2:B2)"]])
    );
    // Past what is in use there is nothing to pad.
    assert_eq!(
        shown(&file, "Budget", "A3:Z99", false),
        json!([["", 1200.5, "inline"]])
    );
    assert_eq!(shown(&file, "Notes & more", "A1:C3", false), json!([]));
    let missing = sheet(&file, Some("Nope")).unwrap_err();
    assert_eq!(missing.code, 4215);
    assert!(missing.message.contains("Budget, Notes & more"));
}

#[test]
fn dates_and_numbers_read_as_people_write_them() {
    assert_eq!(serial_text(1.0, false).as_deref(), Some("1900-01-01"));
    assert_eq!(serial_text(59.0, false).as_deref(), Some("1900-02-28"));
    assert_eq!(serial_text(61.0, false).as_deref(), Some("1900-03-01"));
    assert_eq!(
        serial_text(45000.75, false).as_deref(),
        Some("2023-03-15 18:00")
    );
    assert_eq!(serial_text(0.5, false).as_deref(), Some("12:00"));
    assert_eq!(
        serial_text(0.5003472222222223, false).as_deref(),
        Some("12:00:30")
    );
    assert_eq!(serial_text(0.0, true).as_deref(), Some("1904-01-01"));
    assert_eq!(serial_text(-1.0, false), None);
    assert!(date_format(14, None));
    assert!(date_format(164, Some("yyyy\\-mm\\-dd")));
    assert!(date_format(170, Some("[$-409]h:mm AM/PM")));
    assert!(!date_format(165, Some("0.0 \"days\"")));
    assert!(!date_format(0, Some("General")));
    assert!(!date_format(166, Some("[Red]#,##0.00_);(0)")));
    assert_eq!(number(3.0), json!(3));
    assert_eq!(number(0.1 + 0.2), json!(0.3));
    // Small numbers and long fractions keep what Excel keeps.
    assert_eq!(number(1e-12), json!(1e-12));
    assert_eq!(number(1.234567890123), json!(1.234567890123));
}

/// Excel writes a formula filled across cells once, in the first of them.
#[test]
fn a_formula_filled_across_cells_reads_in_each() {
    assert_eq!(moved("B1*2", 1, 0), "B2*2");
    assert_eq!(
        moved(
            "SUM($A$1:A1)+LOG10(B$1)+'Q1 2026'!C3&\"A1\"+Sheet2!$D4+T1[A1]+1E5",
            2,
            1
        ),
        "SUM($A$1:B3)+LOG10(C$1)+'Q1 2026'!D5&\"A1\"+Sheet2!$D6+T1[A1]+1E5"
    );
    assert_eq!(moved("A1+1", -1, 0), "#REF!+1");
    let file = Archive::open(zip::build(&[
        (WORKBOOK, format!(r#"<workbook {MAIN}><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>"#).into_bytes()),
        ("xl/_rels/workbook.xml.rels", br#"<Relationships><Relationship Id="rId1" Type="x/worksheet" Target="worksheets/sheet1.xml"/></Relationships>"#.to_vec()),
        ("xl/worksheets/sheet1.xml", format!(r#"<worksheet {MAIN}><sheetData><row r="1"><c r="A1"><f t="shared" ref="A1:B2" si="0">C1*$D$1</f><v>2</v></c><c r="B1"><f t="shared" si="0"/><v>3</v></c></row><row r="2"><c r="A2"><f t="shared" si="0"/><v>4</v></c><c r="B2"><f>A2+1</f><v>5</v></c></row></sheetData></worksheet>"#).into_bytes()),
    ]))
    .unwrap();
    assert_eq!(
        shown(&file, "S", "A1:B2", true),
        json!([["=C1*$D$1", "=D1*$D$1"], ["=C2*$D$1", "=A2+1"]])
    );
    assert_eq!(shown(&file, "S", "A1:B2", false), json!([[2, 3], [4, 5]]));
}

#[test]
fn writing_changes_the_named_cells_and_nothing_else() {
    let file = budget();
    let sheet = sheet(&file, None).unwrap();
    // Null leaves A3 alone; empty text clears B3 and its formula.
    let rows = cells(&json!([["Water", 80, "=B2*2"], [null, "", false]])).unwrap();
    let changed = Archive::open(write(&file, &sheet, 2, 1, &rows).unwrap()).unwrap();
    assert_eq!(
        shown(&changed, "Budget", "A1:C4", true),
        json!([
            ["Item", "Total", "2023-03-15"],
            ["Water", 80, "=B2*2"],
            ["", "", false]
        ])
    );
    let xml = changed.text(&sheet.part).unwrap().unwrap();
    // A cell keeps its style, a row its height, and the width hint goes.
    assert!(xml.contains(r#"<c r="B2" s="2"><v>80</v></c>"#), "{xml}");
    assert!(xml.contains(r#"<row r="1" spans="1:3" ht="20">"#));
    assert!(xml.contains(r#"<row r="2">"#));
    assert!(xml.contains(r#"<mergeCells count="0"/>"#));
    assert!(xml.contains(r#"<dimension ref="A1:C3"/>"#));
    // Excel is told to work formulas out again, where the schema allows,
    // and its stale order list goes from every part that names it.
    let book = changed.text(WORKBOOK).unwrap().unwrap();
    assert!(
        book.contains(r#"</definedNames><calcPr fullCalcOnLoad="1"/><extLst/></workbook>"#),
        "{book}"
    );
    assert!(!changed.has("xl/calcChain.xml"));
    assert!(
        !changed
            .text("xl/_rels/workbook.xml.rels")
            .unwrap()
            .unwrap()
            .contains("calcChain")
    );
    assert!(
        !changed
            .text("[Content_Types].xml")
            .unwrap()
            .unwrap()
            .contains("calcChain")
    );
    // The other sheet and the strings are byte for byte what they were.
    for part in [
        "xl/worksheets/sheet2.xml",
        "xl/sharedStrings.xml",
        "xl/styles.xml",
    ] {
        assert_eq!(changed.read(part).unwrap(), file.read(part).unwrap());
    }
}

#[test]
fn rows_are_added_under_the_last_one_in_use() {
    let file = budget();
    let sheet = sheet(&file, None).unwrap();
    let (bytes, row) = append(&file, &sheet, &cells(&json!([["Gas", 40]])).unwrap()).unwrap();
    assert_eq!(row, 4);
    let changed = Archive::open(bytes).unwrap();
    assert_eq!(
        shown(&changed, "Budget", "A4:B4", false),
        json!([["Gas", 40]])
    );
    assert!(
        changed
            .text(&sheet.part)
            .unwrap()
            .unwrap()
            .contains(r#"<dimension ref="A1:C4"/>"#)
    );
    // An empty sheet starts at its first row.
    let empty = super::sheet(&file, Some("Notes & more")).unwrap();
    let (bytes, row) = append(&file, &empty, &cells(&json!([["a < b"]])).unwrap()).unwrap();
    assert_eq!(row, 1);
    assert_eq!(
        shown(
            &Archive::open(bytes).unwrap(),
            "Notes & more",
            "A1:A1",
            false
        ),
        json!([["a < b"]])
    );
}

#[test]
fn a_write_that_would_break_the_workbook_is_refused() {
    let file = Archive::open(zip::build(&[
        (WORKBOOK, format!(r#"<workbook {MAIN}><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>"#).into_bytes()),
        ("xl/_rels/workbook.xml.rels", br#"<Relationships><Relationship Id="rId1" Type="x/worksheet" Target="worksheets/sheet1.xml"/></Relationships>"#.to_vec()),
        ("xl/worksheets/sheet1.xml", format!(r#"<worksheet {MAIN}><sheetData><row r="1"><c r="A1"><f t="shared" ref="A1:A3" si="0">B1*2</f><v>2</v></c></row><row r="2"><c r="A2"><f t="shared" si="0"/><v>4</v></c></row></sheetData></worksheet>"#).into_bytes()),
    ]))
    .unwrap();
    let sheet = sheet(&file, None).unwrap();
    let one = cells(&json!([[1]])).unwrap();
    // The first cell of a shared formula holds it for the others.
    let error = write(&file, &sheet, 1, 1, &one).unwrap_err();
    assert!(
        error.message.contains("A1 starts a formula"),
        "{}",
        error.message
    );
    // One that only uses it can be written over, and a new workbook part is made.
    let changed = Archive::open(write(&file, &sheet, 2, 1, &one).unwrap()).unwrap();
    assert!(
        changed
            .text(WORKBOOK)
            .unwrap()
            .unwrap()
            .contains(r#"</sheets><calcPr fullCalcOnLoad="1"/></workbook>"#)
    );
    assert_eq!(
        write(
            &file,
            &sheet,
            MAX_ROWS,
            1,
            &cells(&json!([[1], [2]])).unwrap()
        )
        .unwrap_err()
        .code,
        4202
    );
    assert_eq!(
        write(
            &file,
            &sheet,
            1,
            MAX_COLUMNS,
            &cells(&json!([[1, 2]])).unwrap()
        )
        .unwrap_err()
        .code,
        4202
    );
    for bad in [
        json!("x"),
        json!([]),
        json!([1, 2]),
        json!([["x".repeat(40_000)]]),
    ] {
        assert_eq!(cells(&bad).unwrap_err().code, 4202, "{bad}");
    }
}

#[test]
fn a_new_workbook_holds_its_sheets_under_names_excel_accepts() {
    let bytes = create(
        "Budget",
        &[
            (
                "Plan: Q1/Q2?".into(),
                cells(&json!([
                    ["Name", "Total"],
                    ["Ana", 12.5],
                    ["Sum", "=SUM(B2:B2)"]
                ]))
                .unwrap(),
            ),
            ("plan  q1 q2".into(), vec![]),
            (String::new(), cells(&json!([[true]])).unwrap()),
        ],
    )
    .unwrap();
    let file = Archive::open(bytes).unwrap();
    assert_eq!(
        sheets(&file)
            .unwrap()
            .iter()
            .map(|s| s.name.as_str())
            .collect::<Vec<_>>(),
        ["Plan  Q1 Q2", "plan  q1 q2 2", "Sheet3"]
    );
    assert_eq!(
        shown(&file, "Plan  Q1 Q2", "A1:B3", true),
        json!([["Name", "Total"], ["Ana", 12.5], ["Sum", "=SUM(B2:B2)"]])
    );
    assert_eq!(shown(&file, "Sheet3", "A1:A1", false), json!([[true]]));
    assert!(
        file.text(WORKBOOK)
            .unwrap()
            .unwrap()
            .contains("fullCalcOnLoad")
    );
    assert!(
        file.text("docProps/core.xml")
            .unwrap()
            .unwrap()
            .contains("<dc:title>Budget</dc:title>")
    );
}

#[test]
fn a_sheet_written_with_a_prefix_or_without_cell_names_keeps_its_order() {
    let xml = r#"<x:worksheet><x:sheetData><x:row><x:c t="inlineStr"><x:is><x:t>a</x:t></x:is></x:c><x:c><x:v>2</x:v></x:c></x:row><x:row r="3"/></x:sheetData></x:worksheet>"#;
    let changed = write_sheet(
        xml,
        1,
        3,
        &[vec![Cell::Number(3.0)], vec![Cell::Text("b".into())]],
    )
    .unwrap();
    assert_eq!(
        changed,
        r#"<x:worksheet><x:sheetData><x:row r="1"><x:c r="A1" t="inlineStr"><x:is><x:t>a</x:t></x:is></x:c><x:c r="B1"><x:v>2</x:v></x:c><x:c r="C1"><x:v>3</x:v></x:c></x:row><x:row r="2"><x:c r="C2" t="inlineStr"><x:is><x:t xml:space="preserve">b</x:t></x:is></x:c></x:row><x:row r="3"/></x:sheetData></x:worksheet>"#
    );
}
