use super::*;
use axum::{Json as AxumJson, Router, routing::post};

/// Holds a send with the subject "Slow" until the test lets it go.
#[derive(Default)]
struct Gate {
    arrived: tokio::sync::Notify,
    release: tokio::sync::Notify,
}

/// Gmail, as far as sending and saving drafts go; every body it got is kept.
async fn gmail() -> (String, Arc<Mutex<Vec<(String, Value)>>>, Arc<Gate>) {
    let got = Arc::new(Mutex::new(vec![]));
    let gate = Arc::new(Gate::default());
    let (a, b, held) = (got.clone(), got.clone(), gate.clone());
    let app = Router::new()
        .route(
            "/gmail/v1/users/me/messages/send",
            post(move |AxumJson(body): AxumJson<Value>| {
                let (a, held) = (a.clone(), held.clone());
                async move {
                    // "Slow" waits for the test; "Refused" doesn't go at all.
                    if raw_of(&body).contains("Subject: Slow\r\n") {
                        held.arrived.notify_one();
                        held.release.notified().await;
                    }
                    if raw_of(&body).contains("Subject: Refused\r\n") {
                        return (
                            axum::http::StatusCode::FORBIDDEN,
                            AxumJson(json!({"error":{"message":"Delegation denied"}})),
                        );
                    }
                    a.lock().unwrap().push(("send".into(), body));
                    (axum::http::StatusCode::OK, AxumJson(json!({"id":"sent-1"})))
                }
            }),
        )
        // "m1" is Ana's message; Gmail is busy for "busy", calls "nope" a
        // malformed id, and has no other message.
        .route(
            "/gmail/v1/users/me/messages/{id}",
            axum::routing::get(
                |axum::extract::Path(id): axum::extract::Path<String>| async move {
                    use axum::{http::StatusCode, response::IntoResponse};
                    match id.as_str() {
                        "m1" => AxumJson(json!({"id":"m1","threadId":"t1","payload":{"headers":[
                            {"name":"Subject","value":"Friday"},
                            {"name":"Message-ID","value":"<m1@mail.example>"}
                        ]}}))
                        .into_response(),
                        "busy" => StatusCode::SERVICE_UNAVAILABLE.into_response(),
                        "nope" => (
                            StatusCode::BAD_REQUEST,
                            AxumJson(json!({"error":{"message":"Invalid id value"}})),
                        )
                            .into_response(),
                        _ => StatusCode::NOT_FOUND.into_response(),
                    }
                },
            ),
        )
        .route(
            "/gmail/v1/users/me/drafts",
            post(move |AxumJson(body): AxumJson<Value>| {
                let b = b.clone();
                async move {
                    b.lock().unwrap().push(("draft".into(), body));
                    AxumJson(json!({"id":"draft-1"}))
                }
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (origin, got, gate)
}

fn raw_of(body: &Value) -> String {
    use base64::Engine;
    let raw = body["raw"]
        .as_str()
        .or(body["message"]["raw"].as_str())
        .unwrap();
    String::from_utf8(
        base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(raw)
            .unwrap(),
    )
    .unwrap()
}

/// The bot drafts, the user edits and sends, and what goes out is what the
/// user left on the card. The card asks even in Bypass, a closed card sends
/// nothing, and a malformed answer leaves the card waiting.
#[tokio::test]
async fn only_the_user_sends_a_draft_and_sends_what_they_left() {
    let (home, runtime, hub) = setup();
    let h = home.path();
    let (origin, got, gate) = gmail().await;
    let mut config = fs::read_to_string(h.join("config.yaml")).unwrap_or_default();
    config.push_str(&format!("\naccounts:\n  google:\n    endpoint: {origin}\n"));
    fs::write(h.join("config.yaml"), config).unwrap();
    fs::create_dir_all(h.join("accounts")).unwrap();
    fs::write(
        h.join("accounts/gmail.json"),
        json!({"email":"alice@example.com","client_id":"c","access_token":"tok","refresh_token":"r","expires_at":common::now() + 3600.0}).to_string(),
    )
    .unwrap();
    fs::write(
        h.join("profiles/owl/config.yaml"),
        "model:\n  provider: openai\n  default: fixture\ntools:\n  enabled_toolsets: [google_workspace]\n",
    )
    .unwrap();
    db::open(h)
        .unwrap()
        .execute("UPDATE bots SET approval_mode='off' WHERE name='owl'", [])
        .unwrap();
    let id = open(&runtime).await;
    let s = runtime.sessions.lock().unwrap()["first"].clone();
    assert!(s.tools.iter().any(|t| t["name"] == "hexbot_mail"));

    let card = |hub: &EventHub| {
        let mut events = hub.subscribe();
        async move {
            tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    let event = events.recv().await.unwrap();
                    if event.frame["params"]["type"] == "approval.request" {
                        break event.frame["params"]["payload"].clone();
                    }
                }
            })
            .await
            .unwrap()
        }
    };
    let draft = |runtime: Arc<Runtime>, s: Arc<Live>| {
        tokio::spawn(async move {
            runtime
                .tool(
                    &s,
                    "hexbot_mail",
                    &json!({"action":"draft","to":["ana@example.com"],"subject":"Friday","body":"Hi Ana,\nFriday works."}),
                )
                .await
        })
    };
    let respond = |runtime: Arc<Runtime>, request: Value, choice: &str, extra: Value| {
        let mut p = json!({"session_id":id,"request_id":request,"choice":choice});
        p.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        async move { runtime.call("alice", "approval.respond", &p).await.unwrap() }
    };

    let waiting = card(&hub);
    let asked = draft(runtime.clone(), s.clone());
    let shown = waiting.await;
    assert_eq!(shown["command"], "Email to ana@example.com");
    assert_eq!(shown["form"]["kind"], "email_draft");
    assert_eq!(shown["form"]["from"], "alice@example.com");
    assert_eq!(shown["form"]["service_name"], "Gmail");
    assert_eq!(shown["form"]["body"], "Hi Ana,\nFriday works.");
    let request = shown["request_id"].clone();
    // A header smuggled into an address is refused, and the card keeps waiting.
    let smuggled = json!({"mail_action":"send","draft":{"to":["ana@example.com\r\nBcc: spy@evil.example"],"subject":"Friday","body":"x"}});
    assert_eq!(
        respond(runtime.clone(), request.clone(), "once", smuggled)
            .await
            .unwrap_err()
            .code,
        4202
    );
    assert!(got.lock().unwrap().is_empty());
    // Only once sends; an answer the card doesn't offer sends nothing.
    let once_only = json!({"mail_action":"send","draft":{"to":["ana@example.com"],"subject":"Friday","body":"x"}});
    assert_eq!(
        respond(runtime.clone(), request.clone(), "session", once_only)
            .await
            .unwrap_err()
            .code,
        4202
    );
    // Gmail refuses it: the user hears why on the card, which stays open.
    let refused = json!({"mail_action":"send","draft":{"to":["ana@example.com"],"subject":"Refused","body":"x"}});
    let error = respond(runtime.clone(), request.clone(), "once", refused)
        .await
        .unwrap_err();
    assert!(
        error.message.contains("Delegation denied"),
        "{}",
        error.message
    );
    // Signed in as someone else now: it isn't sent from their mailbox.
    let account = fs::read_to_string(h.join("accounts/gmail.json")).unwrap();
    fs::write(
        h.join("accounts/gmail.json"),
        account.replace("alice@example.com", "mallory@example.com"),
    )
    .unwrap();
    let ok = json!({"mail_action":"send","draft":{"to":["ana@example.com"],"subject":"Friday","body":"x"}});
    let error = respond(runtime.clone(), request.clone(), "once", ok)
        .await
        .unwrap_err();
    assert_eq!(error.code, 4210);
    assert!(
        error
            .message
            .contains("mallory@example.com now, not alice@example.com")
    );
    fs::write(h.join("accounts/gmail.json"), account).unwrap();
    assert!(got.lock().unwrap().is_empty());
    let mut events = hub.subscribe();
    let edited = json!({"mail_action":"send","draft":{"to":["ana@example.com"],"cc":["bo@example.org"],"subject":"Friday at 6","body":"Hi Ana,\nFriday at 6 works.\nAlice"}});
    respond(runtime.clone(), request, "once", edited)
        .await
        .unwrap();
    let result = asked.await.unwrap().unwrap();
    assert_eq!(result["sent"], true);
    assert_eq!(result["subject"], "Friday at 6");
    let (kind, body) = got.lock().unwrap()[0].clone();
    assert_eq!(kind, "send");
    let raw = raw_of(&body);
    assert!(raw.contains("Subject: Friday at 6\r\n"), "{raw}");
    assert!(raw.contains("Cc: bo@example.org\r\n"));
    // Every app is told what went out, with the user's edits.
    let resolved = loop {
        let event = events.recv().await.unwrap();
        if event.frame["params"]["type"] == "approval.resolved" {
            break event.frame["params"]["payload"].clone();
        }
    };
    assert_eq!(resolved["mail_action"], "send");
    assert_eq!(resolved["draft"]["subject"], "Friday at 6");

    // Answers from another app while it goes, Send or Discard, are refused:
    // one email goes, and the bot is told it went.
    let waiting = card(&hub);
    let asked = draft(runtime.clone(), s.clone());
    let request = waiting.await["request_id"].clone();
    let slow = json!({"mail_action":"send","draft":{"to":["ana@example.com"],"subject":"Slow","body":"x"}});
    let first = tokio::spawn(respond(
        runtime.clone(),
        request.clone(),
        "once",
        slow.clone(),
    ));
    gate.arrived.notified().await;
    let second = respond(runtime.clone(), request.clone(), "once", slow)
        .await
        .unwrap_err();
    assert_eq!(second.code, 4204);
    assert!(second.message.contains("on its way"));
    let discard = respond(runtime.clone(), request, "deny", json!({}))
        .await
        .unwrap_err();
    assert_eq!(discard.code, 4204);
    gate.release.notify_one();
    first.await.unwrap().unwrap();
    assert_eq!(asked.await.unwrap().unwrap()["sent"], true);
    assert_eq!(got.lock().unwrap().len(), 2);

    // Stop while it goes: the card isn't expired, and settles as sent.
    let waiting = card(&hub);
    let asked = draft(runtime.clone(), s.clone());
    let request = waiting.await["request_id"].clone();
    let mut events = hub.subscribe();
    let slow = json!({"mail_action":"send","draft":{"to":["ana@example.com"],"subject":"Slow","body":"y"}});
    let going = tokio::spawn(respond(runtime.clone(), request.clone(), "once", slow));
    gate.arrived.notified().await;
    runtime
        .call("alice", "session.interrupt", &json!({"session_id":id}))
        .await
        .unwrap()
        .unwrap();
    gate.release.notify_one();
    going.await.unwrap().unwrap();
    // A tool still waiting hears it went, never that the user closed it. In
    // a real turn Stop has ended the tool by then, and only the apps hear.
    assert_eq!(asked.await.unwrap().unwrap()["sent"], true);
    assert_eq!(got.lock().unwrap().len(), 3);
    let settled = loop {
        let event = events.recv().await.unwrap();
        let params = &event.frame["params"];
        assert!(
            !(params["type"] == "approval.expire" && params["payload"]["request_id"] == request),
            "a card going out isn't expired"
        );
        if params["type"] == "approval.resolved" && params["payload"]["request_id"] == request {
            break params["payload"].clone();
        }
    };
    assert_eq!(settled["mail_action"], "send");

    // Saved to Drafts, not sent.
    let waiting = card(&hub);
    let asked = draft(runtime.clone(), s.clone());
    let request = waiting.await["request_id"].clone();
    let save = json!({"mail_action":"save","draft":{"to":["ana@example.com"],"subject":"Friday","body":"Later"}});
    respond(runtime.clone(), request, "once", save)
        .await
        .unwrap();
    assert_eq!(asked.await.unwrap().unwrap()["saved_to_drafts"], true);
    assert_eq!(got.lock().unwrap()[3].0, "draft");

    // A reply to a message that isn't there goes back to the bot, with no
    // card the user couldn't send.
    let error = runtime
        .tool(
            &s,
            "hexbot_mail",
            &json!({"action":"draft","to":["ana@example.com"],"subject":"Re: Friday","body":"x","reply_to":"nope"}),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, 4202, "{}", error.message);
    assert!(error.message.contains("Pass reply_to"), "{}", error.message);
    // A well-formed id that names nothing gets the same hint.
    let error = runtime
        .tool(
            &s,
            "hexbot_mail",
            &json!({"action":"draft","to":["ana@example.com"],"subject":"Re: Friday","body":"x","reply_to":"m-gone"}),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, 4215, "{}", error.message);
    assert!(error.message.contains("Pass reply_to"), "{}", error.message);
    assert!(s.state.lock().unwrap().pending.is_empty());
    // A passing failure doesn't tell the bot to drop the thread.
    let error = runtime
        .tool(
            &s,
            "hexbot_mail",
            &json!({"action":"draft","to":["ana@example.com"],"subject":"Re: Friday","body":"x","reply_to":"busy"}),
        )
        .await
        .unwrap_err();
    assert!(
        !error.message.contains("Pass reply_to"),
        "{}",
        error.message
    );
    assert!(s.state.lock().unwrap().pending.is_empty());

    // A reply left without a subject keeps its message's, from a light read.
    let waiting = card(&hub);
    let asked = tokio::spawn({
        let (runtime, s) = (runtime.clone(), s.clone());
        async move {
            runtime
                .tool(&s, "hexbot_mail", &json!({"action":"draft","to":["ana@example.com"],"body":"Yes.","reply_to":"m1"}))
                .await
        }
    });
    let shown = waiting.await;
    assert_eq!(shown["form"]["subject"], "Re: Friday");
    assert_eq!(shown["form"]["reply_to"], "m1");
    respond(
        runtime.clone(),
        shown["request_id"].clone(),
        "deny",
        json!({}),
    )
    .await
    .unwrap();
    assert_eq!(asked.await.unwrap().unwrap_err().code, 4302);

    // Closed: nothing goes out and the bot is told so.
    let waiting = card(&hub);
    let asked = draft(runtime.clone(), s.clone());
    let request = waiting.await["request_id"].clone();
    respond(runtime.clone(), request, "deny", json!({}))
        .await
        .unwrap();
    let error = asked.await.unwrap().unwrap_err();
    assert_eq!(error.code, 4302);
    assert!(error.message.contains("without sending"));
    assert_eq!(got.lock().unwrap().len(), 4);
}

/// Rooms, threads between bots and heartbeats never get the mailbox.
#[tokio::test]
async fn mail_stays_in_the_bots_own_chat_and_jobs() {
    let (home, runtime, _) = setup();
    let h = home.path();
    fs::create_dir_all(h.join("accounts")).unwrap();
    fs::write(
        h.join("accounts/gmail.json"),
        json!({"email":"alice@example.com","client_id":"c","access_token":"t","refresh_token":"r","expires_at":common::now() + 3600.0}).to_string(),
    )
    .unwrap();
    fs::write(
        h.join("profiles/owl/config.yaml"),
        "model:\n  provider: openai\n  default: fixture\ntools:\n  enabled_toolsets: [google_workspace]\n",
    )
    .unwrap();
    let names = |tools: Vec<Value>| {
        tools
            .iter()
            .filter_map(|t| t["name"].as_str().map(str::to_owned))
            .collect::<Vec<_>>()
    };
    let own = names(
        runtime
            .fresh_tools("alice", "owl", "first", None, None)
            .unwrap()
            .0,
    );
    assert!(own.iter().any(|n| n == "hexbot_mail"));
    let job = names(
        runtime
            .fresh_tools("alice", "owl", "first", None, Some(&json!({"job":"j1"})))
            .unwrap()
            .0,
    );
    assert!(job.iter().any(|n| n == "hexbot_mail"));
    for overrides in [json!({"heartbeat":"h1"}), json!({"parent_session":"p"})] {
        let tools = names(
            runtime
                .fresh_tools("alice", "owl", "first", None, Some(&overrides))
                .unwrap()
                .0,
        );
        assert!(!tools.iter().any(|n| n == "hexbot_mail"), "{overrides}");
    }
    // Signed out: the tool goes at the next rebuild.
    fs::remove_file(h.join("accounts/gmail.json")).unwrap();
    let own = names(
        runtime
            .fresh_tools("alice", "owl", "first", None, None)
            .unwrap()
            .0,
    );
    assert!(!own.iter().any(|n| n == "hexbot_mail"));
}
