use super::*;
use axum::{
    Json, Router,
    extract::{Path as UrlPath, RawQuery},
    http::HeaderMap,
    routing::{get, patch, post},
};
use std::sync::{Arc, Mutex};

async fn serve(app: Router) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    origin
}

/// A home signed in to `service`, whose requests go to `origin`.
fn signed_in(service: &str, origin: &str) -> tempfile::TempDir {
    let home = tempfile::tempdir().unwrap();
    std::fs::write(
        home.path().join("config.yaml"),
        format!("accounts:\n  {service}:\n    endpoint: {origin}\n"),
    )
    .unwrap();
    std::fs::create_dir_all(home.path().join("accounts")).unwrap();
    std::fs::write(
        home.path().join(format!("accounts/{service}.json")),
        json!({"email":"me@example.com","client_id":"c","access_token":"tok","refresh_token":"r","expires_at":crate::common::now() + 3600.0}).to_string(),
    )
    .unwrap();
    home
}

fn draft_of(p: Value) -> Draft {
    draft(&p).unwrap()
}

#[test]
fn addresses_take_one_address_each_and_no_line_breaks() {
    assert_eq!(
        addresses(&json!("ana@example.com, Bo Li <bo@example.org>;"), "to").unwrap(),
        ["ana@example.com", "Bo Li <bo@example.org>"]
    );
    for bad in [
        "ana@example.com\r\nBcc: spy@evil.example",
        "not an address",
        "ana@localhost",
        "a b@example.com",
    ] {
        assert!(addresses(&json!([bad]), "to").is_err(), "{bad}");
    }
    assert!(draft(&json!({"subject":"Hi\r\nBcc: spy@evil.example"})).is_err());
}

#[test]
fn a_comma_in_a_name_keeps_one_person() {
    assert_eq!(
        addresses(
            &json!("Lima, Ana <ana@contoso.com>; \"Doe, Jo\" <jo@example.com>, bo@example.org"),
            "to"
        )
        .unwrap(),
        [
            "Lima, Ana <ana@contoso.com>",
            "\"Doe, Jo\" <jo@example.com>",
            "bo@example.org"
        ]
    );
    let draft = draft_of(json!({"to":["Lima, Ana <ana@contoso.com>"]}));
    assert!(mime(&draft, &[]).starts_with("To: \"Lima, Ana\" <ana@contoso.com>\r\n"));
    assert_eq!(
        person(&json!({"emailAddress":{"name":"Lima, Ana","address":"ana@contoso.com"}})),
        "\"Lima, Ana\" <ana@contoso.com>"
    );
}

#[test]
fn a_draft_becomes_plain_utf8_mime_with_its_thread() {
    let draft = draft_of(json!({
        "to": ["Zoë Ana <ana@example.com>"],
        "cc": ["bo@example.org"],
        "subject": "Café plans",
        "body": "Hi Ana,\nSee you at 6.\n",
    }));
    let text = mime(
        &draft,
        &[
            ("In-Reply-To", "<m1@mail.example>".into()),
            ("References", "<m0@mail.example> <m1@mail.example>".into()),
        ],
    );
    assert!(text.starts_with("To: =?UTF-8?B?"), "{text}");
    assert!(text.contains(" <ana@example.com>\r\nCc: bo@example.org\r\n"));
    assert!(text.contains("Subject: =?UTF-8?B?Q2Fmw6kgcGxhbnM=?=\r\n"));
    assert!(text.contains("In-Reply-To: <m1@mail.example>\r\n"));
    assert!(text.contains("Content-Type: text/plain; charset=UTF-8\r\n"));
    let body = text.split("\r\n\r\n").nth(1).unwrap().replace("\r\n", "");
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(body)
        .unwrap();
    assert_eq!(
        String::from_utf8(decoded).unwrap(),
        "Hi Ana,\r\nSee you at 6.\r\n"
    );
}

#[test]
fn gmail_bodies_read_as_text() {
    let data = |s: &str| b64url(s.as_bytes());
    let payload = json!({
        "mimeType": "multipart/mixed",
        "parts": [
            {"mimeType":"multipart/alternative","parts":[
                {"mimeType":"text/plain","body":{"data":data("Plain hello")}},
                {"mimeType":"text/html","body":{"data":data("<p>HTML hello</p>")}}
            ]},
            {"mimeType":"application/pdf","filename":"invoice.pdf","body":{"attachmentId":"x"}}
        ]
    });
    let mut attachments = vec![];
    assert_eq!(gmail_text(&payload, &mut attachments), "Plain hello");
    assert_eq!(attachments, ["invoice.pdf"]);
    let html = json!({"mimeType":"text/html","body":{"data":data("<style>p{}</style><p>One &amp; two</p><p>Three<br>four</p>")}});
    assert_eq!(gmail_text(&html, &mut vec![]), "One & two\nThree\nfour");
}

#[tokio::test]
async fn gmail_searches_reads_and_sends_replies_in_their_thread() {
    let sent = Arc::new(Mutex::new(vec![]));
    let record = sent.clone();
    let origin = serve(
        Router::new()
            .route(
                "/gmail/v1/users/me/messages",
                get(|RawQuery(q): RawQuery, headers: HeaderMap| async move {
                    assert_eq!(headers["authorization"], "Bearer tok");
                    assert!(q.unwrap().contains("q=from%3Aana"));
                    Json(json!({"messages":[{"id":"m1","threadId":"t1"}]}))
                }),
            )
            .route(
                "/gmail/v1/users/me/messages/{id}",
                get(|UrlPath(id): UrlPath<String>, RawQuery(q): RawQuery| async move {
                    assert_eq!(id, "m1");
                    let q = q.unwrap_or_default();
                    let body = b64url("Can we meet Friday?".as_bytes());
                    Json(json!({
                        "id":"m1","threadId":"t1","labelIds":["INBOX","UNREAD"],"snippet":"Can we meet &amp; talk",
                        "payload":{"mimeType":"text/plain","body":{"data": if q.contains("format=full") { body } else { String::new() }},"headers":[
                            {"name":"From","value":"Ana <ana@example.com>"},
                            {"name":"Subject","value":"Friday"},
                            {"name":"Message-ID","value":"<m1@mail.example>"}
                        ]}
                    }))
                }),
            )
            .route(
                "/gmail/v1/users/me/messages/send",
                post(move |Json(body): Json<Value>| {
                    let record = record.clone();
                    async move {
                        record.lock().unwrap().push(body);
                        Json(json!({"id":"sent-1"}))
                    }
                }),
            )
            .route(
                "/gmail/v1/users/me/drafts",
                post(|Json(body): Json<Value>| async move {
                    assert!(body["message"]["raw"].is_string());
                    Json(json!({"id":"draft-1"}))
                }),
            ),
    )
    .await;
    let home = signed_in("google", &origin);
    let svc = accounts::service(GOOGLE).unwrap();
    let found = search(home.path(), svc, "from:ana", 5).await.unwrap();
    assert_eq!(found[0]["from"], "Ana <ana@example.com>");
    assert_eq!(found[0]["snippet"], "Can we meet & talk");
    assert_eq!(found[0]["unread"], true);
    let message = read(home.path(), svc, "m1").await.unwrap();
    assert_eq!(message["body"], "Can we meet Friday?");

    let reply = draft_of(
        json!({"to":["ana@example.com"],"subject":"Re: Friday","body":"Yes.","reply_to":"m1"}),
    );
    assert_eq!(
        deliver(home.path(), svc, &reply, true, None).await.unwrap()["id"],
        "sent-1"
    );
    let body = sent.lock().unwrap()[0].clone();
    assert_eq!(body["threadId"], "t1");
    let raw = String::from_utf8(unb64url(body["raw"].as_str().unwrap()).unwrap()).unwrap();
    assert!(raw.contains("In-Reply-To: <m1@mail.example>\r\n"));
    assert!(raw.contains("References: <m1@mail.example>\r\n"));
    assert_eq!(
        deliver(home.path(), svc, &reply, false, None)
            .await
            .unwrap()["id"],
        "draft-1"
    );
    // Sending needs someone to send it to; saving does not.
    let empty = draft_of(json!({"subject":"Notes","body":"..."}));
    assert_eq!(
        deliver(home.path(), svc, &empty, true, None)
            .await
            .unwrap_err()
            .code,
        4202
    );
}

#[tokio::test]
async fn outlook_replies_start_as_its_own_reply_draft() {
    let calls = Arc::new(Mutex::new(vec![]));
    let (a, b, c) = (calls.clone(), calls.clone(), calls.clone());
    let origin = serve(
        Router::new()
            .route(
                "/v1.0/me/messages",
                get(|RawQuery(q): RawQuery| async move {
                    assert!(q.unwrap().contains("$search=%22budget%22"));
                    Json(json!({"value":[{"id":"AAMk=","conversationId":"c1","subject":"Budget","from":{"emailAddress":{"name":"Sam","address":"sam@contoso.com"}},"toRecipients":[],"receivedDateTime":"2026-11-09T10:00:00Z","bodyPreview":"Numbers","isRead":false}]}))
                }),
            )
            .route(
                "/v1.0/me/messages/{id}/createReply",
                post(move |UrlPath(id): UrlPath<String>| {
                    let a = a.clone();
                    async move {
                        a.lock().unwrap().push(format!("createReply {id}"));
                        Json(json!({"id":"draft-9"}))
                    }
                }),
            )
            .route(
                "/v1.0/me/messages/{id}",
                patch(move |UrlPath(id): UrlPath<String>, Json(body): Json<Value>| {
                    let b = b.clone();
                    async move {
                        assert_eq!(body["body"]["contentType"], "Text");
                        assert_eq!(body["toRecipients"][0]["emailAddress"]["address"], "sam@contoso.com");
                        b.lock().unwrap().push(format!("patch {id}"));
                        Json(json!({"id":id}))
                    }
                }),
            )
            .route(
                "/v1.0/me/messages/{id}/send",
                post(move |UrlPath(id): UrlPath<String>| {
                    let c = c.clone();
                    async move {
                        c.lock().unwrap().push(format!("send {id}"));
                        axum::http::StatusCode::ACCEPTED
                    }
                }),
            ),
    )
    .await;
    let home = signed_in("microsoft", &origin);
    let svc = accounts::service(MICROSOFT).unwrap();
    let found = search(home.path(), svc, "budget", 5).await.unwrap();
    assert_eq!(found[0]["from"], "Sam <sam@contoso.com>");
    assert_eq!(found[0]["unread"], true);
    let reply = draft_of(
        json!({"to":["Sam <sam@contoso.com>"],"subject":"Re: Budget","body":"Looks good.","reply_to":"AAMk="}),
    );
    deliver(home.path(), svc, &reply, true, None).await.unwrap();
    assert_eq!(
        *calls.lock().unwrap(),
        ["createReply AAMk=", "patch draft-9", "send draft-9"]
    );
}

/// A send or a save the service took but never answered may have happened:
/// the user is told where to look before trying again.
#[tokio::test]
async fn a_dropped_answer_says_where_to_look() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move {
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            // The request arrives, then the connection drops unanswered.
            let mut buf = vec![0; 65536];
            let _ = tokio::io::AsyncReadExt::read(&mut socket, &mut buf).await;
            drop(socket);
        }
    });
    let home = signed_in("google", &origin);
    let svc = accounts::service(GOOGLE).unwrap();
    let email = draft_of(json!({"to":["ana@example.com"],"subject":"Hi","body":"x"}));
    let sent = deliver(home.path(), svc, &email, true, None)
        .await
        .unwrap_err();
    assert!(
        sent.message.contains("look in Sent in Gmail"),
        "{}",
        sent.message
    );
    let saved = deliver(home.path(), svc, &email, false, None)
        .await
        .unwrap_err();
    assert!(
        saved.message.contains("look in Drafts in Gmail"),
        "{}",
        saved.message
    );
    // A reply's lookup did nothing yet: a failure, not "may have gone out".
    let reply =
        draft_of(json!({"to":["ana@example.com"],"subject":"Re: Hi","body":"x","reply_to":"m1"}));
    let lookup = deliver(home.path(), svc, &reply, true, None)
        .await
        .unwrap_err();
    assert_eq!(lookup.code, 5240, "{}", lookup.message);
    assert!(!lookup.message.contains("look in"), "{}", lookup.message);

    // Outlook: a save, new or a reply, may be in Drafts; a send that failed
    // while making its draft hasn't gone out.
    let home = signed_in("microsoft", &origin);
    let svc = accounts::service(MICROSOFT).unwrap();
    for draft in [&email, &reply] {
        let saved = deliver(home.path(), svc, draft, false, None)
            .await
            .unwrap_err();
        assert!(
            saved.message.contains("look in Drafts in Outlook"),
            "{}",
            saved.message
        );
        let sent = deliver(home.path(), svc, draft, true, None)
            .await
            .unwrap_err();
        assert_eq!(sent.code, 5240, "{}", sent.message);
    }
}

/// Outlook answering every step but one: the request starting with `drop`
/// arrives whole and its connection closes unanswered.
async fn outlook_dropping(drop: &'static str) -> String {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move {
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut got = vec![];
            let mut buf = [0; 8192];
            // The headers, then as much body as they say.
            let request = loop {
                let n = socket.read(&mut buf).await.unwrap_or(0);
                got.extend_from_slice(&buf[..n]);
                let text = String::from_utf8_lossy(&got).to_string();
                if let Some(end) = text.find("\r\n\r\n") {
                    let length = text[..end]
                        .lines()
                        .find_map(|l| {
                            l.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .map(|v| v.trim().parse::<usize>().unwrap_or(0))
                        })
                        .unwrap_or(0);
                    if got.len() >= end + 4 + length || n == 0 {
                        break text;
                    }
                } else if n == 0 {
                    break text;
                }
            };
            if request.starts_with(drop) {
                continue;
            }
            let body = r#"{"id":"draft-9"}"#;
            let reply = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = socket.write_all(reply.as_bytes()).await;
        }
    });
    origin
}

/// Outlook's later steps: a send whose last request drops may have gone out,
/// and a reply saved whose PATCH drops may be in Drafts.
#[tokio::test]
async fn outlook_says_where_to_look_when_a_later_step_drops() {
    let svc = accounts::service(MICROSOFT).unwrap();
    let email = draft_of(json!({"to":["sam@contoso.com"],"subject":"Hi","body":"x"}));
    let reply = draft_of(
        json!({"to":["sam@contoso.com"],"subject":"Re: Hi","body":"x","reply_to":"AAMk="}),
    );

    let home = signed_in(
        "microsoft",
        &outlook_dropping("POST /v1.0/me/messages/draft-9/send").await,
    );
    let sent = deliver(home.path(), svc, &email, true, None)
        .await
        .unwrap_err();
    assert!(
        sent.message.contains("look in Sent in Outlook"),
        "{}",
        sent.message
    );

    let home = signed_in(
        "microsoft",
        &outlook_dropping("PATCH /v1.0/me/messages/draft-9").await,
    );
    let saved = deliver(home.path(), svc, &reply, false, None)
        .await
        .unwrap_err();
    assert!(
        saved.message.contains("look in Drafts in Outlook"),
        "{}",
        saved.message
    );
    // A send that dropped at the same step hasn't gone out.
    let unsent = deliver(home.path(), svc, &reply, true, None)
        .await
        .unwrap_err();
    assert_eq!(unsent.code, 5240, "{}", unsent.message);
}

/// The email a reply answers was deleted after the card showed: Send says so.
#[tokio::test]
async fn a_reply_to_a_deleted_email_says_so() {
    let origin = serve(Router::new()).await;
    let reply =
        draft_of(json!({"to":["ana@example.com"],"subject":"Re: Hi","body":"x","reply_to":"m1"}));
    for (service, mail) in [("google", "Gmail"), ("microsoft", "Outlook")] {
        let home = signed_in(service, &origin);
        let svc = accounts::service(service).unwrap();
        let error = deliver(home.path(), svc, &reply, true, None)
            .await
            .unwrap_err();
        assert_eq!(error.code, 4215, "{}", error.message);
        assert!(
            error.message.contains(&format!("no longer in {mail}")),
            "{}",
            error.message
        );
    }
}

#[tokio::test]
async fn a_lapsed_sign_in_says_how_to_fix_it() {
    let home = tempfile::tempdir().unwrap();
    let svc = accounts::service(GOOGLE).unwrap();
    let error = search(home.path(), svc, "", 5).await.unwrap_err();
    assert_eq!(error.code, 4210);
    assert!(error.message.contains("Settings, Plugins"));
}

use crate::accounts::MICROSOFT;
