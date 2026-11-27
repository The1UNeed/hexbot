use super::*;
use crate::accounts::testing::{Reply, connected, stand_in};

fn document() -> Value {
    let p = |style: &str, text: &str| json!({"paragraph": {"paragraphStyle": {"namedStyleType": style}, "elements": [{"textRun": {"content": format!("{text}\n")}}]}});
    let item = |list: &str, level: u64, text: &str| json!({"paragraph": {"bullet": {"listId": list, "nestingLevel": level}, "elements": [{"textRun": {"content": format!("{text}\n")}}]}});
    let body = json!({
        "lists": {
            "dots": {"listProperties": {"nestingLevels": [{"glyphSymbol": "●"}, {"glyphSymbol": "○"}]}},
            "numbers": {"listProperties": {"nestingLevels": [{"glyphType": "DECIMAL"}]}},
        },
        "body": {"content": [
            {"sectionBreak": {}},
            p("TITLE", "Q3 plan"),
            p("HEADING_2", "Goals"),
            {"paragraph": {"elements": [{"textRun": {"content": "Ship "}}, {"textRun": {"content": "now"}}, {"person": {"personProperties": {"name": "Ana"}}}, {"textRun": {"content": "\u{b}then rest\n"}}]}},
            p("NORMAL_TEXT", ""),
            item("dots", 0, "one"),
            item("dots", 1, "inner"),
            item("numbers", 0, "first"),
            {"table": {"tableRows": [
                {"tableCells": [{"content": [p("NORMAL_TEXT", "A|1")]}, {"content": [p("NORMAL_TEXT", "B"), p("NORMAL_TEXT", "more")]}]},
            ]}},
            {"tableOfContents": {}},
        ]},
    });
    // As Docs sends a document asked for with its tabs: the first tab,
    // and under it a second with a line of its own.
    json!({
        "title": "Q3 plan",
        "tabs": [{
            "tabProperties": {"title": "Plan"},
            "documentTab": body,
            "childTabs": [{
                "tabProperties": {"title": "Budget"},
                "documentTab": {"body": {"content": [
                    {"paragraph": {"elements": [{"textRun": {"content": "Costs 2025\n"}}]}},
                ]}},
            }],
        }],
    })
}

#[tokio::test]
async fn a_document_reads_as_text_with_its_structure() {
    let (origin, log) = stand_in(|_| Reply::Json(200, document())).await;
    let home = connected(&["google_docs"], &origin);
    let svc = accounts::service("google_docs").unwrap();
    let (title, text) = read(home.path(), svc, "d1").await.unwrap();
    assert_eq!(title, "Q3 plan");
    // Every tab is read, each under its name: a replace reaches them all.
    assert_eq!(
        text,
        "[Tab: Plan]\n\n# Q3 plan\n\n## Goals\n\nShip nowAna\nthen rest\n\n- one\n  - inner\n1. first\n\n| A\\|1 | B more |\n\n[Tab: Budget]\n\nCosts 2025"
    );
    let asked = log.lock().unwrap().last().unwrap().clone();
    assert!(asked.is("GET", "/v1/documents/d1"));
    assert_eq!(asked.param("includeTabsContent"), "true");
    assert_eq!(asked.header("authorization"), "Bearer tok");
}

#[test]
fn appended_markdown_becomes_text_with_styles_placed_in_utf16_units() {
    // The body ends at 20 with a last paragraph that holds text.
    let requests = append_requests(
        &markdown::blocks(
            "## Né\n\nSee **this** and [that](https://example.com).\n\n- a\n  - b\n\nEnd",
        ),
        20,
        false,
    );
    let text = requests[0]["insertText"]["text"].as_str().unwrap();
    assert_eq!(requests[0]["insertText"]["location"]["index"], 19);
    // A new paragraph for each block; a tab nests a list item.
    assert_eq!(text, "\nNé\nSee this and that.\na\n\tb\nEnd");
    let end = 19 + text.encode_utf16().count();
    // What is added starts plain, whatever it follows.
    assert_eq!(
        requests[1]["updateTextStyle"]["range"],
        json!({"startIndex": 20, "endIndex": end})
    );
    assert_eq!(requests[1]["updateTextStyle"]["textStyle"], json!({}));
    assert_eq!(
        requests[2]["deleteParagraphBullets"]["range"],
        json!({"startIndex": 20, "endIndex": end})
    );
    let styles = requests
        .iter()
        .filter_map(|r| r.get("updateParagraphStyle"))
        .map(|r| {
            (
                r["paragraphStyle"]["namedStyleType"].as_str().unwrap(),
                r["range"]["startIndex"].as_u64().unwrap(),
                r["range"]["endIndex"].as_u64().unwrap(),
            )
        })
        .collect::<Vec<_>>();
    // "Né" is two units, and each range runs through its newline.
    assert_eq!(
        styles,
        [
            ("HEADING_2", 20, 23),
            ("NORMAL_TEXT", 23, 42),
            ("NORMAL_TEXT", 42, 44),
            ("NORMAL_TEXT", 44, 47),
            ("NORMAL_TEXT", 47, 51)
        ]
    );
    let looks = requests
        .iter()
        .skip(3)
        .filter_map(|r| r.get("updateTextStyle"))
        .map(|r| {
            (
                r["fields"].as_str().unwrap(),
                r["range"]["startIndex"].as_u64().unwrap(),
                r["range"]["endIndex"].as_u64().unwrap(),
            )
        })
        .collect::<Vec<_>>();
    assert_eq!(looks, [("bold", 27, 31), ("link", 36, 40)]);
    // The list is made last, over both items, so its tabs go after every
    // other place was set.
    let last = requests.last().unwrap();
    assert_eq!(
        last["createParagraphBullets"]["range"],
        json!({"startIndex": 42, "endIndex": 47})
    );
    assert_eq!(
        last["createParagraphBullets"]["bulletPreset"],
        "BULLET_DISC_CIRCLE_SQUARE"
    );

    // After an empty last paragraph nothing is put in front, and two
    // lists are made from the end back.
    let requests = append_requests(&markdown::blocks("1. a\n\nmid\n\n- b"), 2, true);
    assert_eq!(
        requests[0]["insertText"],
        json!({"location": {"index": 1}, "text": "a\nmid\nb"})
    );
    let lists = requests
        .iter()
        .filter_map(|r| r.get("createParagraphBullets"))
        .map(|r| {
            (
                r["bulletPreset"].as_str().unwrap(),
                r["range"]["startIndex"].as_u64().unwrap(),
            )
        })
        .collect::<Vec<_>>();
    assert_eq!(
        lists,
        [
            ("BULLET_DISC_CIRCLE_SQUARE", 7),
            ("NUMBERED_DECIMAL_ALPHA_ROMAN", 1)
        ]
    );
    // A list right after one of the other kind is a list of its own.
    let requests = append_requests(&markdown::blocks("- a\n\n1. b\n2. c"), 2, true);
    let lists = requests
        .iter()
        .filter_map(|r| r.get("createParagraphBullets"))
        .map(|r| {
            (
                r["bulletPreset"].as_str().unwrap(),
                r["range"]["startIndex"].as_u64().unwrap(),
            )
        })
        .collect::<Vec<_>>();
    assert_eq!(
        lists,
        [
            ("NUMBERED_DECIMAL_ALPHA_ROMAN", 3),
            ("BULLET_DISC_CIRCLE_SQUARE", 1)
        ]
    );
    assert!(append_requests(&[], 2, true).is_empty());
}

#[tokio::test]
async fn a_document_is_made_from_html_added_to_and_searched_and_replaced() {
    let (origin, log) = stand_in(|asked| match (asked.method.as_str(), asked.path.as_str()) {
        ("POST", "/upload/drive/v3/files") => Reply::Location(format!("{}/session", asked.origin)),
        ("PUT", "/session") => Reply::Json(200, json!({"id": "new-doc", "name": "Q3 plan", "mimeType": drive::GOOGLE_DOC, "webViewLink": "https://docs.example/new-doc"})),
        ("GET", "/v1/documents/d1") => Reply::Json(200, json!({"body": {"content": [{"startIndex": 0, "endIndex": 1}, {"startIndex": 1, "endIndex": 20}]}})),
        ("POST", "/v1/documents/d1:batchUpdate") => Reply::Json(200, json!({"replies": [{"replaceAllText": {"occurrencesChanged": 3}}]})),
        _ => Reply::Json(404, json!({"error": {"message": "Requested entity was not found."}})),
    })
    .await;
    let home = connected(&["google_docs"], &origin);
    let h = home.path();
    let svc = accounts::service("google_docs").unwrap();
    let made = create(
        h,
        svc,
        "Q3: plan",
        "# Plan\n\n| A | B |\n|---|---|\n| 1 | <b>2</b> |",
    )
    .await
    .unwrap();
    assert_eq!(made.to_json()["type"], "document");
    let asked = log.lock().unwrap().clone();
    assert_eq!(
        asked[0].json(),
        json!({"name": "Q3 plan", "mimeType": drive::GOOGLE_DOC})
    );
    assert_eq!(asked[0].header("x-upload-content-type"), "text/html");
    let html = String::from_utf8(asked[1].body.clone()).unwrap();
    assert!(
        html.contains("<h1>Plan</h1>") && html.contains("<table>"),
        "{html}"
    );
    // HTML a bot wrote in the middle of its Markdown stays text.
    assert!(html.contains("&lt;b&gt;2&lt;/b&gt;"), "{html}");

    append(h, svc, "d1", "More.").await.unwrap();
    let sent = log.lock().unwrap().last().unwrap().json();
    assert_eq!(
        sent["requests"][0]["insertText"],
        json!({"location": {"index": 19}, "text": "\nMore."})
    );
    assert_eq!(append(h, svc, "d1", "   ").await.unwrap_err().code, 4202);

    assert_eq!(replace(h, svc, "d1", "2025", "2026").await.unwrap(), 3);
    let sent = log.lock().unwrap().last().unwrap().json();
    assert_eq!(
        sent["requests"][0]["replaceAllText"],
        json!({"containsText": {"text": "2025", "matchCase": true}, "replaceText": "2026"})
    );
    let missing = read(h, svc, "nope").await.unwrap_err();
    assert_eq!(missing.code, 4215);
    assert_eq!(missing.message, "Google Docs has no such document.");
}
