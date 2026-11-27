use super::*;
use crate::accounts::testing::{Reply, connected, stand_in};

fn google(asked: &crate::accounts::testing::Asked) -> Reply {
    let event = |id: &str, title: &str, start: Value, end: Value| json!({"id": id, "summary": title, "start": start, "end": end, "htmlLink": format!("https://calendar.example/{id}")});
    match (asked.method.as_str(), asked.path.as_str()) {
        ("GET", "/calendar/v3/users/me/calendarList") => Reply::Json(
            200,
            json!({"items": [
                {"id": "family@group", "summary": "Family", "selected": true, "accessRole": "reader", "timeZone": "Pacific/Auckland"},
                {"id": "me@example.com", "summary": "Me", "primary": true, "selected": true, "accessRole": "owner", "timeZone": "Pacific/Auckland"},
                {"id": "holidays", "summary": "Holidays", "accessRole": "reader"},
                {"id": "hidden", "summary": "Hidden", "selected": true, "hidden": true},
            ]}),
        ),
        ("GET", "/calendar/v3/calendars/me%40example.com/events") => Reply::Json(
            200,
            json!({"items": [
                // Inside the day asked for, in the calendar's own time.
                event("lunch", "Lunch", json!({"dateTime": "2026-11-12T12:00:00+13:00"}), json!({"dateTime": "2026-11-12T13:00:00+13:00"})),
                // The evening before: inside what was asked of Google, outside the day.
                event("late", "Late call", json!({"dateTime": "2026-11-11T21:00:00+13:00"}), json!({"dateTime": "2026-11-11T22:00:00+13:00"})),
                {"id": "gone", "status": "cancelled"},
                // All day, and Google's end is the day after.
                {"id": "trip", "summary": "Trip", "start": {"date": "2026-11-12"}, "end": {"date": "2026-11-14"},
                 "description": "<p>Pack <b>light</b></p>", "recurringEventId": "series", "hangoutLink": "https://meet.example/x",
                 "attendees": [{"email": "bo@example.org", "displayName": "Bo", "responseStatus": "tentative"}], "organizer": {"email": "me@example.com"}},
            ]}),
        ),
        ("GET", "/calendar/v3/calendars/family%40group/events") => Reply::Json(
            200,
            json!({"items": [
                event("school", "School run", json!({"dateTime": "2026-11-12T08:30:00+13:00"}), json!({"dateTime": "2026-11-12T09:00:00+13:00"})),
            ]}),
        ),
        ("GET", "/calendar/v3/calendars/primary") => {
            Reply::Json(200, json!({"timeZone": "Pacific/Auckland"}))
        }
        ("GET", "/calendar/v3/calendars/primary/events/lunch") => Reply::Json(
            200,
            event(
                "lunch",
                "Lunch",
                json!({"dateTime": "2026-11-12T12:00:00+13:00"}),
                json!({"dateTime": "2026-11-12T13:30:00+13:00"}),
            ),
        ),
        ("GET", _) => Reply::Json(404, json!({"error": {"message": "Not Found"}})),
        ("DELETE", _) => Reply::Json(204, Value::Null),
        _ => Reply::Json(
            200,
            json!({"id": "made", "htmlLink": "https://calendar.example/made"}),
        ),
    }
}

#[test]
fn times_are_a_day_a_local_time_or_an_instant() {
    assert!(matches!(when("2026-11-12", "start").unwrap(), When::Day(_)));
    assert!(matches!(
        when("2026-11-12T09:00", "start").unwrap(),
        When::Local(_)
    ));
    assert!(matches!(
        when(" 2026-11-12 09:00:30 ", "start").unwrap(),
        When::Local(_)
    ));
    let When::Instant(at) = when("2026-11-12T09:00:00+13:00", "start").unwrap() else {
        panic!("an offset is an instant")
    };
    assert_eq!(instant_text(at), "2026-11-11T20:00:00Z");
    assert!(matches!(
        when("2026-11-12T09:00:00Z", "start").unwrap(),
        When::Instant(_)
    ));
    let error = when("next Tuesday", "start").unwrap_err();
    assert_eq!(error.code, 4202);
    assert!(error.message.starts_with("start must be"));
    assert_eq!(
        without_offset("2026-11-12T09:00:00.0000000"),
        "2026-11-12T09:00:00"
    );
    assert_eq!(without_offset("2026-11-12T09:00"), "2026-11-12T09:00:00");
}

/// Fourteen shown calendars, one of which won't answer.
fn many(asked: &crate::accounts::testing::Asked) -> Reply {
    match asked.path.as_str() {
        "/calendar/v3/users/me/calendarList" => Reply::Json(
            200,
            json!({"items": (1..=14).map(|n| json!({
                "id": format!("c{n}"), "summary": format!("Calendar {n}"),
                "selected": true, "primary": n == 1, "timeZone": "UTC",
            })).collect::<Vec<_>>()}),
        ),
        "/calendar/v3/calendars/c5/events" => {
            Reply::Json(404, json!({"error": {"message": "gone"}}))
        }
        _ => Reply::Json(200, json!({"items": []})),
    }
}

/// A calendar past the cap, or one that won't answer, is named: a bot
/// must not take what it never read for free time.
#[tokio::test]
async fn calendars_left_out_of_a_list_are_named() {
    let (origin, _log) = stand_in(many).await;
    let home = connected(&["google_calendar"], &origin);
    let svc = accounts::service("google_calendar").unwrap();
    let found = list(home.path(), svc, None, None, "", None, 25)
        .await
        .unwrap();
    assert_eq!(
        found["calendars_not_read"],
        json!(["Calendar 13", "Calendar 14", "Calendar 5"])
    );
    // One calendar, read, leaves nothing to name.
    let found = list(home.path(), svc, None, None, "", Some("c2"), 25)
        .await
        .unwrap();
    assert!(found.get("calendars_not_read").is_none());
}

#[tokio::test]
async fn a_day_lists_every_shown_calendar_in_the_calendars_own_time() {
    let (origin, log) = stand_in(google).await;
    let home = connected(&["google_calendar"], &origin);
    let svc = accounts::service("google_calendar").unwrap();
    let found = list(
        home.path(),
        svc,
        Some("2026-11-12"),
        Some("2026-11-12"),
        "",
        None,
        25,
    )
    .await
    .unwrap();
    assert_eq!(found["time_zone"], "Pacific/Auckland");
    assert_eq!(found["account"], "google");
    let events = found["events"].as_array().unwrap();
    assert_eq!(
        events
            .iter()
            .map(|e| (
                e["title"].as_str().unwrap(),
                e["start"].as_str().unwrap(),
                e["end"].as_str().unwrap()
            ))
            .collect::<Vec<_>>(),
        [
            ("Trip", "2026-11-12", "2026-11-13"),
            ("School run", "2026-11-12T08:30:00", "2026-11-12T09:00:00"),
            ("Lunch", "2026-11-12T12:00:00", "2026-11-12T13:00:00"),
        ]
    );
    let trip = &events[0];
    assert_eq!(trip["all_day"], true);
    assert_eq!(trip["description"], "Pack light");
    assert_eq!(trip["repeats"], true);
    assert_eq!(trip["meeting_link"], "https://meet.example/x");
    assert_eq!(
        trip["attendees"][0],
        json!({"email": "bo@example.org", "name": "Bo", "response": "maybe", "you": false})
    );
    assert_eq!(events[1]["calendar_name"], "Family");
    // Google is asked for every instant the local day could be, in the
    // calendar's zone, and only for calendars the user shows.
    let asked = log.lock().unwrap().clone();
    let mine = asked
        .iter()
        .find(|a| a.path.ends_with("/me%40example.com/events"))
        .unwrap();
    assert_eq!(mine.param("timeMin"), "2026-11-11T10:00:00Z");
    assert_eq!(mine.param("timeMax"), "2026-11-13T12:00:00Z");
    assert_eq!(mine.param("timeZone"), "Pacific/Auckland");
    assert_eq!(mine.param("singleEvents"), "true");
    assert_eq!(mine.header("authorization"), "Bearer tok");
    assert!(
        !asked
            .iter()
            .any(|a| a.path.contains("holidays") || a.path.contains("hidden"))
    );

    // One calendar by name, words to look for, and bounds that make no sense.
    let found = list(
        home.path(),
        svc,
        Some("2026-11-12T00:00:00+13:00"),
        Some("2026-11-13T00:00:00+13:00"),
        "run",
        Some("family@group"),
        5,
    )
    .await
    .unwrap();
    assert_eq!(found["events"].as_array().unwrap().len(), 1);
    let last = log.lock().unwrap().last().unwrap().clone();
    assert_eq!(
        (last.param("q"), last.param("timeMin")),
        ("run".into(), "2026-11-11T11:00:00Z".into())
    );
    assert_eq!(
        list(home.path(), svc, None, None, "", Some("nope"), 5)
            .await
            .unwrap_err()
            .code,
        4215
    );
    assert_eq!(
        list(
            home.path(),
            svc,
            Some("2026-11-12"),
            Some("2026-11-10"),
            "",
            None,
            5
        )
        .await
        .unwrap_err()
        .code,
        4202
    );
}

#[tokio::test]
async fn an_event_is_written_in_the_calendars_zone_and_guests_are_told() {
    let (origin, log) = stand_in(google).await;
    let home = connected(&["google_calendar"], &origin);
    let svc = accounts::service("google_calendar").unwrap();
    let change = Change::parse(&json!({"title": "Lunch", "start": "2026-11-12T12:00", "location": "Cuba St", "attendees": ["Bo Li <bo@example.org>"]})).unwrap();
    let made = create(home.path(), svc, &change, None).await.unwrap();
    assert_eq!(
        made,
        json!({"id": "made", "link": "https://calendar.example/made"})
    );
    let sent = log.lock().unwrap().last().unwrap().clone();
    assert!(sent.is("POST", "/calendar/v3/calendars/primary/events"));
    assert_eq!(sent.param("sendUpdates"), "all");
    assert_eq!(
        sent.json(),
        json!({
            "summary": "Lunch", "location": "Cuba St", "attendees": [{"email": "bo@example.org"}],
            // A local time is resolved by Google, in the calendar's zone, for an hour.
            "start": {"dateTime": "2026-11-12T12:00:00", "timeZone": "Pacific/Auckland", "date": null},
            "end": {"dateTime": "2026-11-12T13:00:00", "timeZone": "Pacific/Auckland", "date": null},
        })
    );
    // Whole days: the last day is included, so Google's end is the day after.
    let days = Change::parse(&json!({"start": "2026-11-12", "end": "2026-11-13"})).unwrap();
    update(home.path(), svc, "lunch", &days, None)
        .await
        .unwrap();
    let sent = log.lock().unwrap().last().unwrap().clone();
    assert!(sent.is("PATCH", "/calendar/v3/calendars/primary/events/lunch"));
    assert_eq!(
        sent.json(),
        json!({"start": {"date": "2026-11-12", "dateTime": null}, "end": {"date": "2026-11-14", "dateTime": null}})
    );
    // A new start alone moves the event, which keeps its hour and a half.
    let moved = Change::parse(&json!({"start": "2026-11-13T15:00"})).unwrap();
    update(home.path(), svc, "lunch", &moved, None)
        .await
        .unwrap();
    let sent = log.lock().unwrap().last().unwrap().clone();
    assert_eq!(sent.json()["start"]["dateTime"], "2026-11-13T15:00:00");
    assert_eq!(sent.json()["end"]["dateTime"], "2026-11-13T16:30:00");

    for (bad, why) in [
        (json!({"start": "2026-11-12T12:00"}), "title"),
        (json!({"title": "x"}), "start"),
        (
            json!({"title": "x", "start": "2026-11-12", "end": "2026-11-12T10:00"}),
            "same way",
        ),
        (
            json!({"title": "x", "start": "2026-11-12T10:00", "end": "2026-11-12T09:00"}),
            "after start",
        ),
    ] {
        let error = match Change::parse(&bad) {
            Ok(change) => create(home.path(), svc, &change, None).await.unwrap_err(),
            Err(error) => error,
        };
        assert!(
            error.code == 4202 && error.message.contains(why),
            "{}",
            error.message
        );
    }
    assert!(Change::parse(&json!({"attendees": ["not an address"]})).is_err());
    assert!(Change::parse(&json!({"time_zone": "Pacific/Auckland\" x"})).is_err());
    assert_eq!(
        update(home.path(), svc, "lunch", &Change::default(), None)
            .await
            .unwrap_err()
            .code,
        4202
    );
}

#[tokio::test]
async fn deleting_takes_the_events_title_as_well_as_its_id() {
    let (origin, log) = stand_in(google).await;
    let home = connected(&["google_calendar"], &origin);
    let svc = accounts::service("google_calendar").unwrap();
    let wrong = delete(home.path(), svc, "lunch", "Dentist", None)
        .await
        .unwrap_err();
    assert_eq!(wrong.code, 4202);
    assert!(
        wrong.message.contains("\"Lunch\", not \"Dentist\""),
        "{}",
        wrong.message
    );
    assert!(!log.lock().unwrap().iter().any(|a| a.method == "DELETE"));
    assert_eq!(
        delete(home.path(), svc, "missing", "x", None)
            .await
            .unwrap_err()
            .code,
        4215
    );
    let done = delete(home.path(), svc, "lunch", " lunch ", None)
        .await
        .unwrap();
    assert_eq!(done, json!({"deleted": true, "title": "Lunch"}));
    let sent = log.lock().unwrap().last().unwrap().clone();
    assert!(sent.is("DELETE", "/calendar/v3/calendars/primary/events/lunch"));
    assert_eq!(sent.param("sendUpdates"), "all");
}

#[tokio::test]
async fn outlook_reads_and_writes_in_the_mailboxs_zone() {
    let (origin, log) = stand_in(|asked| match (asked.method.as_str(), asked.path.as_str()) {
        ("GET", "/v1.0/me/calendars") => Reply::Json(200, json!({"value": [{"id": "cal-1", "name": "Calendar", "isDefaultCalendar": true, "canEdit": true}]})),
        ("GET", "/v1.0/me/mailboxSettings/timeZone") => Reply::Json(200, json!({"value": "New Zealand Standard Time"})),
        ("GET", "/v1.0/me/calendars/shared/events/e9") => Reply::Json(200, json!({"id": "e9", "subject": "Workshop",
            "start": {"dateTime": "2026-11-12T02:00:00.0000000"}, "end": {"dateTime": "2026-11-12T03:30:00.0000000"}})),
        ("GET", "/v1.0/me/calendars/cal-1/calendarView") => Reply::Json(200, json!({"value": [
            {"id": "e1", "subject": "Review", "start": {"dateTime": "2026-11-12T15:00:00.0000000"}, "end": {"dateTime": "2026-11-12T15:30:00.0000000"},
             "location": {"displayName": "Room 2"}, "attendees": [{"emailAddress": {"address": "bo@contoso.com", "name": "Bo"}, "status": {"response": "accepted"}}],
             "onlineMeeting": {"joinUrl": "https://teams.example/j"}, "webLink": "https://outlook.example/e1"},
            {"id": "e2", "subject": "Leave", "isAllDay": true, "start": {"dateTime": "2026-11-12T00:00:00.0000000"}, "end": {"dateTime": "2026-11-13T00:00:00.0000000"}},
            {"id": "e3", "subject": "Dropped", "isCancelled": true, "start": {"dateTime": "2026-11-12T10:00:00.0000000"}, "end": {"dateTime": "2026-11-12T11:00:00.0000000"}},
        ]})),
        _ => Reply::Json(201, json!({"id": "made", "webLink": "https://outlook.example/made"})),
    })
    .await;
    let home = connected(&["outlook_calendar"], &origin);
    let svc = accounts::service("outlook_calendar").unwrap();
    let found = list(
        home.path(),
        svc,
        Some("2026-11-12"),
        Some("2026-11-12"),
        "",
        None,
        25,
    )
    .await
    .unwrap();
    assert_eq!(found["time_zone"], "New Zealand Standard Time");
    let events = found["events"].as_array().unwrap();
    assert_eq!(
        events
            .iter()
            .map(|e| (
                e["title"].as_str().unwrap(),
                e["start"].as_str().unwrap(),
                e["end"].as_str().unwrap()
            ))
            .collect::<Vec<_>>(),
        [
            ("Leave", "2026-11-12", "2026-11-12"),
            ("Review", "2026-11-12T15:00:00", "2026-11-12T15:30:00")
        ]
    );
    assert_eq!(events[1]["meeting_link"], "https://teams.example/j");
    assert_eq!(events[1]["attendees"][0]["response"], "accepted");
    let view = log
        .lock()
        .unwrap()
        .iter()
        .find(|a| a.path.ends_with("calendarView"))
        .unwrap()
        .clone();
    assert_eq!(
        view.header("prefer"),
        "outlook.timezone=\"New Zealand Standard Time\""
    );
    assert_eq!(view.param("startDateTime"), "2026-11-11T10:00:00Z");
    // Words are looked for here: Graph's view has no search.
    let found = list(
        home.path(),
        svc,
        Some("2026-11-12"),
        Some("2026-11-12"),
        "room 2",
        None,
        25,
    )
    .await
    .unwrap();
    assert_eq!(found["events"].as_array().unwrap().len(), 1);

    // A whole day starts at a midnight in the mailbox's zone and ends at
    // the next; an instant is sent as UTC.
    let day =
        Change::parse(&json!({"title": "Leave", "start": "2026-11-12", "description": "Away"}))
            .unwrap();
    create(home.path(), svc, &day, None).await.unwrap();
    let sent = log.lock().unwrap().last().unwrap().clone();
    assert!(sent.is("POST", "/v1.0/me/events"));
    assert_eq!(
        sent.json(),
        json!({
            "subject": "Leave", "body": {"contentType": "text", "content": "Away"}, "isAllDay": true,
            "start": {"dateTime": "2026-11-12T00:00:00", "timeZone": "New Zealand Standard Time"},
            "end": {"dateTime": "2026-11-13T00:00:00", "timeZone": "New Zealand Standard Time"},
        })
    );
    let instant = Change::parse(
        &json!({"start": "2026-11-12T09:00:00+13:00", "end": "2026-11-12T10:00:00+13:00"}),
    )
    .unwrap();
    update(home.path(), svc, "e1", &instant, None)
        .await
        .unwrap();
    let sent = log.lock().unwrap().last().unwrap().clone();
    assert!(sent.is("PATCH", "/v1.0/me/events/e1"));
    assert_eq!(
        sent.json()["start"],
        json!({"dateTime": "2026-11-11T20:00:00", "timeZone": "UTC"})
    );
    assert_eq!(sent.json()["isAllDay"], false);
    // An event of another calendar is reached there, and one moved by its
    // start alone keeps its length.
    let moved = Change::parse(&json!({"start": "2026-11-14T09:00:00+13:00"})).unwrap();
    update(home.path(), svc, "e9", &moved, Some("shared"))
        .await
        .unwrap();
    let sent = log.lock().unwrap().last().unwrap().clone();
    assert!(sent.is("PATCH", "/v1.0/me/calendars/shared/events/e9"));
    assert_eq!(
        sent.json()["end"],
        json!({"dateTime": "2026-11-13T21:30:00", "timeZone": "UTC"})
    );
}
