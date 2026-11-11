use super::*;
use crate::accounts::testing::{Reply, connected, stand_in};

fn sheets_api(asked: &crate::accounts::testing::Asked) -> Reply {
    match (asked.method.as_str(), asked.path.as_str()) {
        ("GET", "/v4/spreadsheets/s1") => Reply::Json(
            200,
            json!({"properties": {"title": "Budget"}, "sheets": [
                {"properties": {"sheetId": 0, "title": "Q1 '26", "gridProperties": {"rowCount": 1000, "columnCount": 26}}},
                {"properties": {"sheetId": 77, "title": "Notes", "gridProperties": {"rowCount": 10, "columnCount": 2}}},
            ]}),
        ),
        ("GET", path) if path.starts_with("/v4/spreadsheets/s1/values/") => Reply::Json(
            200,
            json!({"values": [["Item", "Cost"], ["Rent", "$1,200.50"]]}),
        ),
        ("PUT", _) => Reply::Json(200, json!({"updatedRange": "'Q1 ''26'!B2:C3"})),
        ("POST", "/v4/spreadsheets") => Reply::Json(
            200,
            json!({"spreadsheetId": "new", "spreadsheetUrl": "https://sheets.example/new"}),
        ),
        ("POST", path) if path.ends_with(":append") => {
            Reply::Json(200, json!({"updates": {"updatedRange": "Notes!A3:B3"}}))
        }
        _ => Reply::Json(200, json!({})),
    }
}

#[tokio::test]
async fn a_range_is_read_from_a_sheet_named_as_the_spreadsheet_names_it() {
    let (origin, log) = stand_in(sheets_api).await;
    let home = connected(&["google_sheets"], &origin);
    let svc = accounts::service("google_sheets").unwrap();
    let range = excel::range("A1:B2").unwrap().1;
    let (found, shown, rest) = read(home.path(), svc, "s1", Some("q1 '26"), range, false, 1_000)
        .await
        .unwrap();
    assert_eq!(
        found,
        json!({
            "title": "Budget",
            "sheets": [{"name": "Q1 '26", "rows": 1000, "columns": 26}, {"name": "Notes", "rows": 10, "columns": 2}],
            "sheet": "Q1 '26",
            "rows": [["Item", "Cost"], ["Rent", "$1,200.50"]],
        })
    );
    assert_eq!((shown, rest), (range, None));
    let asked = log.lock().unwrap().last().unwrap().clone();
    // The sheet's name is quoted, its own quote doubled, and all of it encoded.
    assert_eq!(
        asked.path,
        "/v4/spreadsheets/s1/values/%27Q1%20%27%2726%27%21A1%3AB2"
    );
    assert_eq!(asked.param("valueRenderOption"), "FORMATTED_VALUE");
    read(home.path(), svc, "s1", None, range, true, 1_000)
        .await
        .unwrap();
    assert_eq!(
        log.lock()
            .unwrap()
            .last()
            .unwrap()
            .param("valueRenderOption"),
        "FORMULA"
    );
    let missing = read(home.path(), svc, "s1", Some("Nope"), range, false, 1_000)
        .await
        .unwrap_err();
    assert_eq!(missing.code, 4215);
    assert!(
        missing.message.contains("Q1 '26, Notes"),
        "{}",
        missing.message
    );

    // Sheets refuses a range that leaves the sheet, so only the cells the
    // sheet has are asked for, a read's worth at a time.
    let wide = excel::range("A1:AX200").unwrap().1;
    let (_, shown, rest) = read(home.path(), svc, "s1", Some("Notes"), wide, false, 8)
        .await
        .unwrap();
    assert_eq!(shown.name(), "A1:B4");
    assert_eq!(rest.unwrap().name(), "A5:B10");
    assert!(
        log.lock()
            .unwrap()
            .last()
            .unwrap()
            .path
            .ends_with("%21A1%3AB4")
    );
    // One that starts past the sheet's edge holds nothing, and isn't asked for.
    let asked = log.lock().unwrap().len();
    let past = excel::range("D1:E5").unwrap().1;
    let (found, ..) = read(home.path(), svc, "s1", Some("Notes"), past, false, 8)
        .await
        .unwrap();
    assert_eq!(found["rows"], json!([]));
    // Only the spreadsheet's sheets were read.
    assert_eq!(log.lock().unwrap().len(), asked + 1);
}

#[tokio::test]
async fn text_stays_text_and_a_sheet_grows_to_hold_what_is_written() {
    let (origin, log) = stand_in(sheets_api).await;
    let home = connected(&["google_sheets"], &origin);
    let h = home.path();
    let svc = accounts::service("google_sheets").unwrap();
    let rows = excel::cells(&json!([
        ["Rent", 1200.5],
        [null, "=SUM(B2:B2)"],
        ["", true]
    ]))
    .unwrap();
    // Sheets would read these as a number, a formula and a date; only the
    // date is meant as one.
    let texts = excel::cells(&json!([[
        "007",
        "+64 21 555 0101",
        "'quoted",
        "2026-11-12",
        "2026-11-12 09:30"
    ]]))
    .unwrap();
    assert_eq!(
        values(&texts),
        json!([[
            "'007",
            "'+64 21 555 0101",
            "''quoted",
            "2026-11-12",
            "2026-11-12 09:30"
        ]])
    );
    assert_eq!(
        write(h, svc, "s1", None, (2, 2), &rows).await.unwrap(),
        "'Q1 ''26'!B2:C3"
    );
    let sent = log.lock().unwrap().last().unwrap().clone();
    assert!(
        sent.method == "PUT" && sent.path.ends_with("%21B2"),
        "{}",
        sent.path
    );
    assert_eq!(sent.param("valueInputOption"), "USER_ENTERED");
    // Null leaves a cell alone; empty text empties it.
    assert_eq!(
        sent.json(),
        json!({"values": [["'Rent", 1200.5], [null, "=SUM(B2:B2)"], ["", true]]})
    );
    // Nothing grew: the rows fit the sheet.
    assert!(
        !log.lock()
            .unwrap()
            .iter()
            .any(|a| a.path.ends_with(":batchUpdate"))
    );
    // Rows past the sheet's last row and column: it grows by what is missing.
    write(h, svc, "s1", Some("Notes"), (10, 2), &rows)
        .await
        .unwrap();
    let asked = log.lock().unwrap().clone();
    let grew = &asked[asked.len() - 2];
    assert!(grew.is("POST", "/v4/spreadsheets/s1:batchUpdate"));
    assert_eq!(
        grew.json(),
        json!({"requests": [
            {"appendDimension": {"sheetId": 77, "dimension": "ROWS", "length": 2}},
            {"appendDimension": {"sheetId": 77, "dimension": "COLUMNS", "length": 1}},
        ]})
    );
    assert_eq!(asked.last().unwrap().method, "PUT");

    assert_eq!(
        append(h, svc, "s1", Some("Notes"), &rows).await.unwrap(),
        "Notes!A3:B3"
    );
    let sent = log.lock().unwrap().last().unwrap().clone();
    assert_eq!(
        sent.path,
        "/v4/spreadsheets/s1/values/%27Notes%27%21A1:append"
    );
    assert_eq!(sent.param("insertDataOption"), "INSERT_ROWS");

    let made = create(
        h,
        svc,
        "Budget: 2026",
        &[
            ("Plan".into(), rows.clone()),
            ("plan".into(), vec![]),
            (String::new(), vec![]),
        ],
    )
    .await
    .unwrap();
    assert_eq!(
        made,
        json!({"id": "new", "link": "https://sheets.example/new", "sheets": ["Plan", "plan 2", "Sheet3"]})
    );
    let asked = log.lock().unwrap().clone();
    let (book, values) = (&asked[asked.len() - 2], &asked[asked.len() - 1]);
    assert_eq!(book.json()["properties"]["title"], "Budget 2026");
    assert_eq!(book.json()["sheets"].as_array().unwrap().len(), 3);
    // A new sheet is at least Sheets' own size, and as large as its rows.
    assert_eq!(
        book.json()["sheets"][0]["properties"],
        json!({"title": "Plan", "gridProperties": {"rowCount": 1000, "columnCount": 26}})
    );
    let tall = vec![vec![excel::Cell::Number(1.0); 30]; 1_500];
    create(h, svc, "Big", &[("Data".into(), tall)])
        .await
        .unwrap();
    let asked = log.lock().unwrap().clone();
    assert_eq!(
        asked[asked.len() - 2].json()["sheets"][0]["properties"]["gridProperties"],
        json!({"rowCount": 1500, "columnCount": 30})
    );
    assert!(values.is("POST", "/v4/spreadsheets/new/values:batchUpdate"));
    assert_eq!(values.json()["data"].as_array().unwrap().len(), 1);
    assert_eq!(values.json()["data"][0]["range"], "'Plan'!A1");
}
