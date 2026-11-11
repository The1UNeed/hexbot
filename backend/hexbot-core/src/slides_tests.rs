use super::*;
use crate::accounts::testing::{Reply, connected, stand_in};
use crate::powerpoint::outline;

fn text(lines: &[(u64, &str)]) -> Value {
    let mut elements = vec![];
    for (level, line) in lines {
        elements.push(json!({"paragraphMarker": {"bullet": {"nestingLevel": level}}}));
        elements.push(json!({"textRun": {"content": format!("{line}\n")}}));
    }
    json!({"textElements": elements})
}

fn slides_api(asked: &crate::accounts::testing::Asked) -> Reply {
    match (asked.method.as_str(), asked.path.as_str()) {
        ("POST", "/v1/presentations") => Reply::Json(
            200,
            json!({"presentationId": "new", "slides": [{"objectId": "p"}]}),
        ),
        ("GET", "/v1/presentations/p1") if asked.param("fields").starts_with("title") => {
            Reply::Json(
                200,
                json!({
                    "title": "Q3 review",
                    "slides": [{
                        "pageElements": [
                            {"shape": {"placeholder": {"type": "TITLE"}, "text": text(&[(0, "Sales")])}},
                            {"shape": {"placeholder": {"type": "BODY"}, "text": text(&[(0, "Up 12%"), (1, "Mostly Q2")])}},
                            {"shape": {"placeholder": {"type": "SLIDE_NUMBER"}, "text": text(&[(0, "1")])}},
                            {"table": {"tableRows": [{"tableCells": [{"text": text(&[(0, "Q1")])}, {"text": text(&[(0, "12")])}]}]}},
                            {"elementGroup": {"children": [{"shape": {"text": text(&[(0, "In a group")])}}]}},
                        ],
                        "slideProperties": {"notesPage": {"pageElements": [
                            {"shape": {"placeholder": {"type": "SLIDE_IMAGE"}}},
                            {"shape": {"placeholder": {"type": "BODY"}, "text": text(&[(0, "Say hello.")])}},
                        ]}},
                    }],
                }),
            )
        }
        ("GET", "/v1/presentations/p1") => Reply::Json(
            200,
            json!({
                "slides": [{"objectId": "a"}, {"objectId": "b", "slideProperties": {"masterObjectId": "m2"}}],
                "layouts": [
                    // Another master's layout, which Slides would refuse here.
                    {"objectId": "other", "layoutProperties": {"name": "TITLE_AND_BODY", "masterObjectId": "m1"}, "pageElements": [{"shape": {"placeholder": {"type": "TITLE"}}}, {"shape": {"placeholder": {"type": "BODY"}}}]},
                    {"objectId": "blank", "layoutProperties": {"name": "BLANK", "masterObjectId": "m2"}},
                    {"objectId": "custom", "layoutProperties": {"name": "Brand", "masterObjectId": "m2"}, "pageElements": [{"shape": {"placeholder": {"type": "TITLE"}}}, {"shape": {"placeholder": {"type": "BODY"}}}]},
                ],
            }),
        ),
        ("GET", "/v1/presentations/bare") => Reply::Json(
            200,
            json!({"slides": [], "layouts": [{"objectId": "blank"}]}),
        ),
        _ => Reply::Json(
            200,
            json!({"replies": [{"replaceAllText": {"occurrencesChanged": 2}}]}),
        ),
    }
}

#[tokio::test]
async fn slides_read_with_their_titles_text_and_notes() {
    let (origin, _) = stand_in(slides_api).await;
    let home = connected(&["google_slides"], &origin);
    let svc = accounts::service("google_slides").unwrap();
    let (title, slides) = read(home.path(), svc, "p1").await.unwrap();
    assert_eq!(title, "Q3 review");
    assert_eq!(
        slides,
        [Slide {
            title: "Sales".into(),
            text: "Up 12%\n  Mostly Q2\n| Q1 | 12 |\nIn a group".into(),
            notes: "Say hello.".into(),
        }]
    );
}

#[tokio::test]
async fn a_new_presentation_is_its_outline_in_place_of_the_empty_first_slide() {
    let (origin, log) = stand_in(slides_api).await;
    let home = connected(&["google_slides"], &origin);
    let svc = accounts::service("google_slides").unwrap();
    let deck = outline(&json!([
        {"title": "Q3 plan", "body": "Hexbot team"},
        {"title": "Goals", "body": "- Ship\n  - Google\n- Test"},
        {"title": "One line", "body": "Just this"},
    ]))
    .unwrap();
    let made = create(home.path(), svc, "Q3: plan", &deck).await.unwrap();
    assert_eq!(
        made["link"],
        "https://docs.google.com/presentation/d/new/edit"
    );
    let asked = log.lock().unwrap().clone();
    assert_eq!(asked[0].json(), json!({"title": "Q3 plan"}));
    assert!(asked[1].is("POST", "/v1/presentations/new:batchUpdate"));
    let requests = asked[1].json()["requests"].as_array().unwrap().clone();
    let made = requests
        .iter()
        .filter_map(|r| r.get("createSlide"))
        .collect::<Vec<_>>();
    // A title slide first, then a title with a body, in order.
    assert_eq!(
        made[0]["slideLayoutReference"],
        json!({"predefinedLayout": "TITLE"})
    );
    assert_eq!(
        made[0]["placeholderIdMappings"][1]["layoutPlaceholder"]["type"],
        "SUBTITLE"
    );
    assert_eq!(
        made[1]["slideLayoutReference"],
        json!({"predefinedLayout": "TITLE_AND_BODY"})
    );
    assert_eq!(
        made.iter()
            .map(|m| m["insertionIndex"].as_u64().unwrap())
            .collect::<Vec<_>>(),
        [0, 1, 2]
    );
    let texts = requests
        .iter()
        .filter_map(|r| r.get("insertText"))
        .map(|r| r["text"].as_str().unwrap())
        .collect::<Vec<_>>();
    // A tab nests a line once its body is a list.
    assert_eq!(
        texts,
        [
            "Q3 plan",
            "Hexbot team",
            "Goals",
            "Ship\n\tGoogle\nTest",
            "One line",
            "Just this"
        ]
    );
    // Only the body with several lines is a list.
    let lists = requests
        .iter()
        .filter_map(|r| r.get("createParagraphBullets"))
        .collect::<Vec<_>>();
    assert_eq!(lists.len(), 1);
    assert_eq!(
        lists[0]["objectId"],
        made[1]["placeholderIdMappings"][1]["objectId"]
    );
    // Ids are new to any presentation and long enough for Slides.
    let id = made[0]["objectId"].as_str().unwrap();
    assert!(
        id.len() >= 5 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'),
        "{id}"
    );
    assert_eq!(
        requests.last().unwrap(),
        &json!({"deleteObject": {"objectId": "p"}})
    );
}

#[tokio::test]
async fn slides_are_added_in_the_presentations_own_layout_and_text_is_replaced() {
    let (origin, log) = stand_in(slides_api).await;
    let home = connected(&["google_slides"], &origin);
    let h = home.path();
    let svc = accounts::service("google_slides").unwrap();
    let more = outline(&json!([{"title": "Next", "body": "Short"}])).unwrap();
    assert_eq!(add(h, svc, "p1", &more).await.unwrap(), 3);
    let requests = log.lock().unwrap().last().unwrap().json()["requests"].clone();
    // After the last slide, in this presentation's layout, and never a title slide.
    assert_eq!(requests[0]["createSlide"]["insertionIndex"], 2);
    assert_eq!(
        requests[0]["createSlide"]["slideLayoutReference"],
        json!({"layoutId": "custom"})
    );
    assert_eq!(
        requests[0]["createSlide"]["placeholderIdMappings"][1]["layoutPlaceholder"]["type"],
        "BODY"
    );
    let none = add(h, svc, "bare", &more).await.unwrap_err();
    assert!(
        none.message.contains("no layout with a title and a body"),
        "{}",
        none.message
    );

    assert_eq!(replace(h, svc, "p1", "2025", "2026").await.unwrap(), 2);
    let sent = log.lock().unwrap().last().unwrap().clone();
    assert!(sent.is("POST", "/v1/presentations/p1:batchUpdate"));
    assert_eq!(
        sent.json()["requests"][0]["replaceAllText"]["containsText"],
        json!({"text": "2025", "matchCase": true})
    );
}
