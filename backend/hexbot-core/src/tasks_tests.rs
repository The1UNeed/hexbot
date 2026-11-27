use super::*;
use crate::accounts::testing::{Reply, connected, stand_in};

#[tokio::test]
async fn google_tasks_list_across_lists_and_change_by_list_and_id() {
    let (origin, log) = stand_in(|asked| match (asked.method.as_str(), asked.path.as_str()) {
        ("GET", "/tasks/v1/users/@me/lists") => Reply::Json(200, json!({"items": [{"id": "inbox", "title": "My Tasks"}, {"id": "home", "title": "Home"}]})),
        ("GET", "/tasks/v1/lists/inbox/tasks") => Reply::Json(200, json!({"items": [
            {"id": "t1", "title": "File taxes", "due": "2026-12-01T00:00:00.000Z", "status": "needsAction", "notes": "IR3"},
            {"id": "t2", "title": "No date", "status": "needsAction"},
            {"id": "t3", "title": "Done already", "status": "completed", "due": "2026-01-01T00:00:00.000Z"},
        ]})),
        ("GET", "/tasks/v1/lists/home/tasks") => Reply::Json(200, json!({"items": [
            {"id": "t4", "title": "Fix tap", "due": "2026-11-15T00:00:00.000Z", "status": "needsAction", "parent": "t9"},
        ]})),
        ("GET", "/tasks/v1/lists/@default/tasks/t1") | ("GET", "/tasks/v1/lists/inbox/tasks/t1") => Reply::Json(200, json!({"id": "t1", "title": "File taxes"})),
        ("GET", _) => Reply::Json(404, json!({"error": {"message": "Not Found"}})),
        ("DELETE", _) => Reply::Json(204, Value::Null),
        _ => Reply::Json(200, json!({"id": "new", "title": "Call Ana", "status": "completed"})),
    })
    .await;
    let home = connected(&["google_tasks"], &origin);
    let h = home.path();
    let svc = accounts::service("google_tasks").unwrap();
    assert_eq!(
        lists(h, svc).await.unwrap(),
        [
            json!({"id": "inbox", "name": "My Tasks", "default": true}),
            json!({"id": "home", "name": "Home", "default": false})
        ]
    );
    // Open ones first, the soonest due at the top, undated after.
    let found = list(h, svc, None, true, 50).await.unwrap();
    assert_eq!(
        found["tasks"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| (
                t["title"].as_str().unwrap(),
                t["due"].as_str().unwrap(),
                t["list"].as_str().unwrap()
            ))
            .collect::<Vec<_>>(),
        [
            ("Fix tap", "2026-11-15", "home"),
            ("File taxes", "2026-12-01", "inbox"),
            ("No date", "", "inbox"),
            ("Done already", "2026-01-01", "inbox")
        ]
    );
    assert_eq!(found["tasks"][0]["subtask"], true);
    assert_eq!(found["tasks"][1]["notes"], "IR3");
    assert_eq!(
        log.lock().unwrap().last().unwrap().param("showCompleted"),
        "true"
    );
    let found = list(h, svc, Some("home"), false, 50).await.unwrap();
    assert_eq!(found["tasks"].as_array().unwrap().len(), 1);
    assert_eq!(
        log.lock().unwrap().last().unwrap().param("showCompleted"),
        "false"
    );
    assert_eq!(
        list(h, svc, Some("nope"), false, 50)
            .await
            .unwrap_err()
            .code,
        4215
    );

    let change =
        Change::parse(&json!({"title": "Call Ana", "notes": "About Friday", "due": "2026-11-20"}))
            .unwrap();
    add(h, svc, &change, None).await.unwrap();
    let sent = log.lock().unwrap().last().unwrap().clone();
    assert!(sent.is("POST", "/tasks/v1/lists/@default/tasks"));
    assert_eq!(
        sent.json(),
        json!({"title": "Call Ana", "notes": "About Friday", "due": "2026-11-20T00:00:00.000Z"})
    );
    // Reopening clears what Google keeps of its finish; an empty date clears the date.
    let reopen = Change::parse(&json!({"done": false, "due": ""})).unwrap();
    update(h, svc, "t1", &reopen, Some("inbox")).await.unwrap();
    let sent = log.lock().unwrap().last().unwrap().clone();
    assert!(sent.is("PATCH", "/tasks/v1/lists/inbox/tasks/t1"));
    assert_eq!(
        sent.json(),
        json!({"status": "needsAction", "completed": null, "due": null})
    );

    assert_eq!(
        add(h, svc, &Change::default(), None)
            .await
            .unwrap_err()
            .code,
        4202
    );
    assert_eq!(
        update(h, svc, "t1", &Change::default(), None)
            .await
            .unwrap_err()
            .code,
        4202
    );
    assert!(Change::parse(&json!({"due": "tomorrow"})).is_err());
    assert!(Change::parse(&json!({"done": "yes"})).is_err());

    // Deleting takes the task's title as well as its id.
    let wrong = delete(h, svc, "t1", "Call Ana", None).await.unwrap_err();
    assert!(
        wrong.message.contains("\"File taxes\", not \"Call Ana\""),
        "{}",
        wrong.message
    );
    assert!(!log.lock().unwrap().iter().any(|a| a.method == "DELETE"));
    assert_eq!(
        delete(h, svc, "gone", "x", None).await.unwrap_err().code,
        4215
    );
    assert_eq!(
        delete(h, svc, "t1", "file taxes", None).await.unwrap()["deleted"],
        true
    );
    assert!(
        log.lock()
            .unwrap()
            .last()
            .unwrap()
            .is("DELETE", "/tasks/v1/lists/@default/tasks/t1")
    );
}

#[tokio::test]
async fn microsoft_to_do_uses_its_default_list_and_its_own_shapes() {
    let (origin, log) = stand_in(|asked| match (asked.method.as_str(), asked.path.as_str()) {
        ("GET", "/v1.0/me/todo/lists") => Reply::Json(200, json!({"value": [
            {"id": "flagged", "displayName": "Flagged", "wellknownListName": "flaggedEmails"},
            {"id": "tasks", "displayName": "Tasks", "wellknownListName": "defaultList"},
        ]})),
        ("GET", "/v1.0/me/mailboxSettings/timeZone") => Reply::Json(200, json!({"value": "New Zealand Standard Time"})),
        ("GET", "/v1.0/me/todo/lists/tasks/tasks") => Reply::Json(200, json!({"value": [
            {"id": "a", "title": "Book flights", "status": "notStarted", "importance": "high",
             "dueDateTime": {"dateTime": "2026-11-18T00:00:00.0000000", "timeZone": "New Zealand Standard Time"}, "body": {"content": "<p>To <b>Sydney</b></p>", "contentType": "html"}},
            // Still in UTC: the midnights that start 19 November in Berlin,
            // in Auckland's summer and in Honolulu.
            {"id": "b", "title": "Pack", "status": "notStarted",
             "dueDateTime": {"dateTime": "2026-11-18T23:00:00.0000000", "timeZone": "UTC"}},
            {"id": "c", "title": "Pack", "status": "notStarted",
             "dueDateTime": {"dateTime": "2026-11-18T11:00:00.0000000", "timeZone": "UTC"}},
            {"id": "d", "title": "Pack", "status": "notStarted",
             "dueDateTime": {"dateTime": "2026-11-19T10:00:00.0000000", "timeZone": "UTC"}},
        ]})),
        ("GET", "/v1.0/me/todo/lists/flagged/tasks") => Reply::Json(200, json!({"value": []})),
        _ => Reply::Json(201, json!({"id": "new", "title": "Renew passport", "status": "completed"})),
    })
    .await;
    let home = connected(&["microsoft_todo"], &origin);
    let h = home.path();
    let svc = accounts::service("microsoft_todo").unwrap();
    assert_eq!(
        lists(h, svc).await.unwrap()[0],
        json!({"id": "tasks", "name": "Tasks", "default": true})
    );
    let found = list(h, svc, None, false, 50).await.unwrap();
    assert_eq!(
        found["tasks"][0],
        json!({"id": "a", "list": "tasks", "list_name": "Tasks", "title": "Book flights", "notes": "To Sydney", "due": "2026-11-18", "done": false, "important": true})
    );
    for task in &found["tasks"].as_array().unwrap()[1..] {
        assert_eq!(task["due"], "2026-11-19", "{}", task["id"]);
    }
    // Only open tasks are asked for, with their times in the user's zone.
    let asked = log
        .lock()
        .unwrap()
        .iter()
        .find(|a| a.path == "/v1.0/me/todo/lists/tasks/tasks")
        .unwrap()
        .clone();
    assert_eq!(asked.param("$filter"), "status ne 'completed'");
    assert_eq!(
        asked.header("prefer"),
        "outlook.timezone=\"New Zealand Standard Time\""
    );

    let change = Change::parse(
        &json!({"title": "Renew passport", "notes": "Form", "due": "2026-12-01", "done": true}),
    )
    .unwrap();
    let done = update(h, svc, "a", &change, Some("tasks")).await.unwrap();
    assert_eq!(done["done"], true);
    let sent = log.lock().unwrap().last().unwrap().clone();
    assert!(sent.is("PATCH", "/v1.0/me/todo/lists/tasks/tasks/a"));
    assert_eq!(
        sent.json(),
        json!({"title": "Renew passport", "body": {"content": "Form", "contentType": "text"}, "status": "completed",
               // The day starts at its midnight where the user is.
               "dueDateTime": {"dateTime": "2026-12-01T00:00:00", "timeZone": "New Zealand Standard Time"}})
    );
    // With no list named, a new task goes to the default one.
    add(h, svc, &change, None).await.unwrap();
    assert!(
        log.lock()
            .unwrap()
            .last()
            .unwrap()
            .is("POST", "/v1.0/me/todo/lists/tasks/tasks")
    );
}

/// A list past the cap is named: a bot must not take it for empty.
#[tokio::test]
async fn task_lists_left_out_of_a_list_are_named() {
    let (origin, _log) = stand_in(|asked| match asked.path.as_str() {
        "/tasks/v1/users/@me/lists" => Reply::Json(
            200,
            json!({"items": (1..=22).map(|n| json!({"id": format!("l{n}"), "title": format!("List {n}")})).collect::<Vec<_>>()}),
        ),
        _ => Reply::Json(200, json!({"items": []})),
    })
    .await;
    let home = connected(&["google_tasks"], &origin);
    let svc = accounts::service("google_tasks").unwrap();
    let found = list(home.path(), svc, None, false, 25).await.unwrap();
    assert_eq!(found["lists_not_read"], json!(["List 21", "List 22"]));
    let found = list(home.path(), svc, Some("l22"), false, 25)
        .await
        .unwrap();
    assert!(found.get("lists_not_read").is_none());
}

/// Neither service sorts by due date, so a list is read to its end before
/// the soonest are picked; one too long to finish says there is more.
#[tokio::test]
async fn the_soonest_task_is_found_on_a_later_page() {
    let (origin, log) = stand_in(|asked| {
        match (asked.path.as_str(), asked.param("pageToken").as_str()) {
            ("/tasks/v1/users/@me/lists", _) => Reply::Json(
                200,
                json!({"items": [{"id": "inbox", "title": "My Tasks"}]}),
            ),
            ("/tasks/v1/lists/inbox/tasks", "") => Reply::Json(
                200,
                json!({
                    "items": [{"id": "later", "title": "Later", "due": "2026-12-30T00:00:00.000Z", "status": "needsAction"}],
                    "nextPageToken": "p 2",
                }),
            ),
            ("/tasks/v1/lists/inbox/tasks", "p 2") => Reply::Json(
                200,
                json!({
                    "items": [{"id": "today", "title": "Today", "due": "2026-11-10T00:00:00.000Z", "status": "needsAction"}],
                }),
            ),
            // To Do: a list whose pages never end.
            ("/v1.0/me/todo/lists", _) => Reply::Json(
                200,
                json!({"value": [{"id": "tasks", "displayName": "Tasks", "wellknownListName": "defaultList"}]}),
            ),
            _ => Reply::Json(
                200,
                json!({
                    "value": [{"id": "t", "title": "Again", "status": "notStarted"}],
                    "@odata.nextLink": format!("{}/v1.0/me/todo/lists/tasks/tasks?$skip=1", asked.origin),
                }),
            ),
        }
    })
    .await;
    let home = connected(&["google_tasks", "microsoft_todo"], &origin);
    let google = accounts::service("google_tasks").unwrap();
    let found = list(home.path(), google, None, false, 1).await.unwrap();
    assert_eq!(found["tasks"][0]["title"], "Today");
    assert_eq!(found["more"], true);
    assert_eq!(
        log.lock().unwrap().last().unwrap().param("pageToken"),
        "p 2"
    );
    let todo = accounts::service("microsoft_todo").unwrap();
    let found = list(home.path(), todo, None, false, 100).await.unwrap();
    // Ten pages read, and the answer says the list went on.
    assert_eq!(found["tasks"].as_array().unwrap().len(), 10);
    assert_eq!(found["more"], true);
}
