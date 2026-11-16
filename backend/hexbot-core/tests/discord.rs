//! A bot in Discord end to end, against a fake Discord: its REST API and its
//! Gateway. Nothing here sleeps; every wait is on something the fake saw.
use axum::{
    Json, Router,
    extract::{
        Path, Query, State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{any, get, post},
};
use hexbot_core::{
    Result, db,
    discord::Discord,
    events::EventHub,
    rooms::{self, RoomEngine, RoomRunner},
};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::mpsc;

/// What each token is: its Discord user, its app, and whether the app has the
/// message content intent.
fn account(token: &str) -> Option<(&'static str, &'static str, u64)> {
    match token {
        "T-owl" => Some(("100", "900", 1 << 19)),
        "T-fox" => Some(("200", "901", 1 << 18)),
        "T-plain" => Some(("250", "902", 0)),
        _ => None,
    }
}

#[derive(Default)]
struct Fake {
    port: Mutex<u16>,
    /// Each token's live Gateway, for the test to deliver messages on.
    sockets: Mutex<HashMap<String, mpsc::UnboundedSender<Value>>>,
    online: Mutex<Option<mpsc::UnboundedSender<String>>>,
    posts: Mutex<Option<mpsc::UnboundedSender<(String, String, Value)>>>,
    typing: Mutex<Vec<String>>,
    count: Mutex<u64>,
    /// How Discord answers the next posts: in trouble (nothing kept), or
    /// keeping the post but losing the answer. Then it answers normally.
    trouble: Mutex<Vec<Trouble>>,
    /// The message each nonce made, as Discord enforces it.
    nonces: Mutex<HashMap<String, String>>,
    /// What the channel's history answers, when a test sets it.
    history: Mutex<Option<Value>>,
}

#[derive(Clone, Copy, PartialEq)]
enum Trouble {
    Fine,
    Down,
    LostAnswer,
}

fn token(headers: &HeaderMap) -> String {
    headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bot "))
        .unwrap_or("")
        .to_owned()
}

async fn me(headers: HeaderMap) -> impl IntoResponse {
    match account(&token(&headers)) {
        Some((user, _, _)) => (
            StatusCode::OK,
            Json(json!({"id":user,"username":format!("app-{user}"),"bot":true})),
        ),
        None => (
            StatusCode::UNAUTHORIZED,
            Json(json!({"message":"401: Unauthorized"})),
        ),
    }
}
async fn application(headers: HeaderMap) -> impl IntoResponse {
    match account(&token(&headers)) {
        Some((_, app, flags)) => (StatusCode::OK, Json(json!({"id":app,"flags":flags}))),
        None => (
            StatusCode::UNAUTHORIZED,
            Json(json!({"message":"401: Unauthorized"})),
        ),
    }
}
async fn channel(Path(id): Path<String>) -> Json<Value> {
    Json(json!({"id":id,"name":"general"}))
}
async fn guild(Path(id): Path<String>) -> Json<Value> {
    Json(json!({"id":id,"name":"Test Server"}))
}
async fn history(
    State(fake): State<Arc<Fake>>,
    Query(q): Query<HashMap<String, String>>,
) -> Json<Value> {
    assert_eq!(q["limit"], "20");
    // Only what was said before, as Discord answers.
    if let Some(history) = fake.history.lock().unwrap().clone() {
        let before: u64 = q["before"].parse().unwrap();
        return Json(json!(
            history
                .as_array()
                .unwrap()
                .iter()
                .filter(|m| m["id"].as_str().unwrap().parse::<u64>().unwrap() < before)
                .collect::<Vec<_>>()
        ));
    }
    // Newest first, as Discord answers.
    Json(json!([
        {"id":"h2","type":0,"content":"older two","author":{"id":"300","username":"sam"},"mentions":[]},
        {"id":"h1","type":0,"content":"older one <@100>","author":{"id":"301","username":"kim"},"mentions":[{"id":"100","username":"app-100"}]},
    ]))
}
async fn send(
    State(fake): State<Arc<Fake>>,
    Path(channel): Path<String>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> (StatusCode, Json<Value>) {
    let trouble = {
        let mut trouble = fake.trouble.lock().unwrap();
        (!trouble.is_empty()).then(|| trouble.remove(0))
    };
    let trouble = trouble.filter(|t| *t != Trouble::Fine);
    if trouble == Some(Trouble::Down) {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"message":"busy"})),
        );
    }
    let nonce = body["nonce"].as_str().unwrap_or("").to_owned();
    let known = fake.nonces.lock().unwrap().get(&nonce).cloned();
    let id = match known {
        Some(id) => id,
        None => {
            let id = {
                let mut count = fake.count.lock().unwrap();
                *count += 1;
                format!("p{count}")
            };
            if !nonce.is_empty() {
                fake.nonces.lock().unwrap().insert(nonce, id.clone());
            }
            if let Some(posts) = fake.posts.lock().unwrap().as_ref() {
                let _ = posts.send((channel, token(&headers), body));
            }
            id
        }
    };
    if trouble == Some(Trouble::LostAnswer) {
        return (StatusCode::BAD_GATEWAY, Json(json!({"message":"lost"})));
    }
    (StatusCode::OK, Json(json!({"id":id})))
}
async fn typing(State(fake): State<Arc<Fake>>, headers: HeaderMap) -> StatusCode {
    fake.typing.lock().unwrap().push(token(&headers));
    StatusCode::NO_CONTENT
}
async fn gateway(State(fake): State<Arc<Fake>>, ws: WebSocketUpgrade) -> impl IntoResponse {
    ws.on_upgrade(move |socket| serve(fake, socket))
}
async fn serve(fake: Arc<Fake>, mut socket: WebSocket) {
    let hello = json!({"op":10,"d":{"heartbeat_interval":45000}});
    socket
        .send(Message::Text(hello.to_string().into()))
        .await
        .unwrap();
    let Some(Ok(Message::Text(identify))) = socket.recv().await else {
        return;
    };
    let identify: Value = serde_json::from_str(&identify).unwrap();
    assert_eq!(identify["op"], 2);
    // Guilds, guild messages, message content.
    assert_eq!(identify["d"]["intents"], 33281);
    let token = identify["d"]["token"].as_str().unwrap().to_owned();
    let (user, _, _) = account(&token).unwrap();
    let port = *fake.port.lock().unwrap();
    let ready = json!({"op":0,"t":"READY","s":1,"d":{"session_id":"s","resume_gateway_url":format!("ws://127.0.0.1:{port}/gateway"),"user":{"id":user}}});
    socket
        .send(Message::Text(ready.to_string().into()))
        .await
        .unwrap();
    let (tx, mut rx) = mpsc::unbounded_channel();
    fake.sockets.lock().unwrap().insert(token.clone(), tx);
    if let Some(online) = fake.online.lock().unwrap().as_ref() {
        let _ = online.send(token);
    }
    let mut seq = 1;
    loop {
        tokio::select! {
            out = rx.recv() => {
                let Some(d) = out else { return };
                seq += 1;
                let frame = json!({"op":0,"t":"MESSAGE_CREATE","s":seq,"d":d});
                if socket.send(Message::Text(frame.to_string().into())).await.is_err() {
                    return;
                }
            }
            incoming = socket.recv() => match incoming {
                Some(Ok(Message::Text(text))) => {
                    let frame: Value = serde_json::from_str(&text).unwrap();
                    if frame["op"] == 1 {
                        let _ = socket.send(Message::Text(json!({"op":11}).to_string().into())).await;
                    }
                }
                Some(Ok(_)) => {}
                _ => return,
            }
        }
    }
}

async fn fake_discord() -> (Arc<Fake>, String, String) {
    let fake = Arc::new(Fake::default());
    let app = Router::new()
        .route("/api/users/@me", get(me))
        .route("/api/oauth2/applications/@me", get(application))
        .route("/api/channels/{id}", get(channel))
        .route("/api/guilds/{id}", get(guild))
        .route("/api/channels/{id}/messages", get(history).post(send))
        .route("/api/channels/{id}/typing", post(typing))
        .route("/gateway", any(gateway))
        .route("/gateway/", any(gateway))
        .with_state(fake.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    *fake.port.lock().unwrap() = port;
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (
        fake,
        format!("http://127.0.0.1:{port}/api"),
        format!("ws://127.0.0.1:{port}/gateway"),
    )
}

/// Each bot answers with its next scripted reply and reports the prompt it got.
struct Bots {
    replies: Mutex<HashMap<String, Vec<String>>>,
    prompts: mpsc::UnboundedSender<(String, String)>,
}
impl RoomRunner for Bots {
    fn run<'a>(
        &'a self,
        _: &'a str,
        bot: &'a str,
        _: &'a str,
        text: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<String>> + Send + 'a>> {
        Box::pin(async move {
            let _ = self.prompts.send((bot.to_owned(), text.to_owned()));
            Ok(self
                .replies
                .lock()
                .unwrap()
                .get_mut(bot)
                .and_then(|r| (!r.is_empty()).then(|| r.remove(0)))
                .unwrap_or_else(|| "(pass)".into()))
        })
    }
    fn interrupt<'a>(
        &'a self,
        _: &'a str,
        _: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + Send + 'a>> {
        Box::pin(async { Ok(()) })
    }
}

async fn within<T>(what: &str, future: impl Future<Output = Option<T>>) -> T {
    tokio::time::timeout(Duration::from_secs(20), future)
        .await
        .unwrap_or_else(|_| panic!("timed out waiting for {what}"))
        .unwrap_or_else(|| panic!("{what} ended"))
}

fn message(id: &str, content: &str, author: (&str, &str), mentions: &[&str]) -> Value {
    json!({
        "id": id, "type": 0, "guild_id": "g1", "channel_id": "c1", "content": content,
        "author": {"id": author.0, "username": author.1.to_lowercase(), "global_name": author.1},
        "mentions": mentions.iter().map(|m| json!({"id": m, "username": format!("app-{m}")})).collect::<Vec<_>>(),
    })
}

#[tokio::test]
async fn a_mention_opens_a_room_and_each_bot_answers_in_discord_as_itself() {
    let home = tempfile::tempdir().unwrap();
    let h = home.path();
    db::migrate(h).unwrap();
    db::open(h)
        .unwrap()
        .execute_batch(
            "INSERT INTO users(id,display_name,role,created_at) VALUES('alice','Alice','admin',0);
         INSERT INTO bots(name,owner_id) VALUES('owl','alice'),('fox','alice');",
        )
        .unwrap();
    let (fake, api, ws) = fake_discord().await;
    let (online_tx, mut online) = mpsc::unbounded_channel();
    let (posts_tx, mut posts) = mpsc::unbounded_channel();
    *fake.online.lock().unwrap() = Some(online_tx);
    *fake.posts.lock().unwrap() = Some(posts_tx);
    let (prompts_tx, mut prompts) = mpsc::unbounded_channel();
    let bots = Arc::new(Bots {
        replies: Mutex::new(HashMap::from([
            (
                "owl".into(),
                vec!["Hi Sam. @fox, do you know?".into(), "Noted.".into()],
            ),
            ("fox".into(), vec!["I do.".into()]),
        ])),
        prompts: prompts_tx,
    });
    let events = EventHub::new();
    let engine = Arc::new(RoomEngine::with_runner(
        h.into(),
        bots.clone(),
        events.clone(),
    ));
    let discord = Discord::with_endpoints(h.into(), events, engine, &api, &ws);
    discord.start().await.unwrap();
    let call = |method: &str, p: Value| {
        let discord = discord.clone();
        let method = format!("hexbot.discord.{method}");
        async move { discord.call("alice", &method, &p).await.unwrap() }
    };

    // Each bot connects its own Discord app.
    let owl = call("connect", json!({"bot":"owl","token":" Bot T-owl "}))
        .await
        .unwrap();
    assert_eq!(owl["discord"]["application_id"], "900");
    assert_eq!(
        owl["discord"]["invite_url"],
        "https://discord.com/oauth2/authorize?client_id=900&scope=bot&permissions=274877975552"
    );
    call("connect", json!({"bot":"fox","token":"T-fox"}))
        .await
        .unwrap();
    let mut up = vec![
        within("owl online", online.recv()).await,
        within("fox online", online.recv()).await,
    ];
    up.sort();
    assert_eq!(up, ["T-fox", "T-owl"]);
    let deliver = |token: &str, d: Value| {
        fake.sockets.lock().unwrap()[token].send(d).unwrap();
    };

    // Someone mentions owl. Both bots are in the channel and both see it.
    let first = message("m1", "<@100> what's new?", ("300", "Sam"), &["100"]);
    deliver("T-owl", first.clone());
    deliver("T-fox", first);
    let (bot, prompt) = within("owl's turn", prompts.recv()).await;
    assert_eq!(bot, "owl");
    assert!(
        prompt.starts_with("Discord channel: #general · Test Server\nYou are @owl"),
        "{prompt}"
    );
    // The room starts with what was said just before, then the mention.
    assert!(
        prompt.contains("kim: older one @owl\nsam: older two\nSam: @owl what's new?"),
        "{prompt}"
    );
    let (channel, token, body) = within("owl's reply", posts.recv()).await;
    assert_eq!((channel.as_str(), token.as_str()), ("c1", "T-owl"));
    assert_eq!(body["content"], "Hi Sam. <@200>, do you know?");
    assert_eq!(body["message_reference"]["message_id"], "m1");
    // Only the bot it hands over to is pinged, not Sam it answers.
    assert_eq!(
        body["allowed_mentions"],
        json!({"parse":[],"users":["200"],"replied_user":false})
    );
    assert_eq!(body["enforce_nonce"], true);

    // Discord shows fox owl's reply, with its nonce. Fox joins the room and answers owl.
    let mut owls = message(
        "p1",
        "Hi Sam. <@200>, do you know?",
        ("100", "Owl"),
        &["200"],
    );
    owls["nonce"] = body["nonce"].clone();
    deliver("T-fox", owls.clone());
    deliver("T-owl", owls);
    let (bot, prompt) = within("fox's turn", prompts.recv()).await;
    assert_eq!(bot, "fox");
    assert!(
        prompt.contains("@owl: Hi Sam. @fox, do you know?"),
        "{prompt}"
    );
    let (_, token, body) = within("fox's reply", posts.recv()).await;
    assert_eq!(token, "T-fox");
    assert_eq!(body["content"], "I do.");
    assert_eq!(body["message_reference"]["message_id"], "p1");

    // A message for nobody lands in the room; the next mention carries it.
    deliver(
        "T-owl",
        message("m2", "unrelated chatter", ("301", "Kim"), &[]),
    );
    let mut reply = message("m3", "thanks", ("300", "Sam"), &[]);
    reply["type"] = json!(19);
    reply["referenced_message"] = json!({"id":"p1","author":{"id":"100"}});
    deliver("T-owl", reply);
    let (bot, prompt) = within("owl's second turn", prompts.recv()).await;
    assert_eq!(bot, "owl");
    assert!(
        prompt.contains("Kim: unrelated chatter\nSam: thanks"),
        "{prompt}"
    );
    let (_, _, body) = within("owl's second reply", posts.recv()).await;
    assert_eq!(body["content"], "Noted.");

    // The room is the owner's to watch, once per message, and theirs alone to post in from Discord.
    let room = rooms::call(h, "alice", "hexbot.rooms.list", &json!({}))
        .unwrap()
        .unwrap()["rooms"][0]
        .clone();
    assert_eq!(room["name"], "#general · Test Server");
    assert_eq!(room["approval_mode"], "manual");
    assert_eq!(room["discord"]["url"], "https://discord.com/channels/g1/c1");
    let id = room["id"].as_str().unwrap();
    let log = rooms::log(h, "alice", id, 0, None, 100).unwrap();
    let said: Vec<String> = log
        .iter()
        .filter(|e| e["kind"] == "message.user" || e["kind"] == "message.bot")
        .map(|e| e["payload"]["text"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(
        said,
        [
            "older one @owl",
            "older two",
            "@owl what's new?",
            "Hi Sam. @fox, do you know?",
            "I do.",
            "unrelated chatter",
            "thanks",
            "Noted."
        ]
    );
    assert_eq!(
        rooms::call(
            h,
            "alice",
            "hexbot.rooms.send",
            &json!({"id":id,"text":"hi"})
        )
        .unwrap()
        .unwrap_err()
        .code,
        hexbot_core::discord::NOT_IN_DISCORD
    );
    let status = call("get", json!({"bot":"owl"})).await.unwrap();
    assert_eq!(status["discord"]["status"], "online");
    assert_eq!(status["discord"]["rooms"][0]["channel_name"], "general");
    assert!(fake.typing.lock().unwrap().iter().any(|t| t == "T-owl"));

    // Disconnecting drops the token and takes owl out of the room, so it
    // can't be picked to answer there; the room and its history stay.
    call("disconnect", json!({"bot":"owl"})).await.unwrap();
    assert_eq!(
        call("get", json!({"bot":"owl"})).await.unwrap()["discord"],
        Value::Null
    );
    assert!(!h.join("accounts/discord/owl.json").exists());
    assert!(h.join("accounts/discord/fox.json").exists());
    let after = rooms::log(h, "alice", id, 0, None, 100).unwrap();
    assert_eq!(after.len(), log.len() + 1);
    assert_eq!(after.last().unwrap()["kind"], "member.left");
    let active = |bot: &str| {
        rooms::get(h, "alice", id).unwrap()["members"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["member_id"] == bot && m["left_at"].is_null())
    };
    assert!(!active("owl"));
    assert!(active("fox"));
    // While owl is away, fox's connection takes in a mention of it.
    deliver(
        "T-fox",
        message("m-away", "<@100> are you there?", ("300", "Sam"), &["100"]),
    );

    // Connected again, owl comes back the next time it is mentioned, and
    // answers that, not what was said while it was away.
    call("connect", json!({"bot":"owl","token":"T-owl"}))
        .await
        .unwrap();
    assert_eq!(within("owl online again", online.recv()).await, "T-owl");
    deliver(
        "T-owl",
        message("m4", "<@100> back?", ("300", "Sam"), &["100"]),
    );
    let (bot, prompt) = within("owl's turn after reconnecting", prompts.recv()).await;
    assert_eq!(bot, "owl");
    assert!(active("owl"));
    assert!(
        prompt.contains("Sam: @app-100 are you there?\nSam: @owl back?"),
        "{prompt}"
    );
    let triggers: Vec<String> = {
        let conn = db::open(h).unwrap();
        let mut statement = conn
            .prepare("SELECT d.message_id FROM room_turns t JOIN discord_messages d ON d.room_id=t.room_id AND d.seq=t.trigger_seq WHERE t.bot='owl' AND t.status!='skipped' ORDER BY t.trigger_seq")
            .unwrap();
        statement
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    };
    assert_eq!(triggers.last().map(String::as_str), Some("m4"));
    assert!(!triggers.iter().any(|t| t == "m-away"), "{triggers:?}");
    discord.shutdown().await;
}

#[tokio::test]
async fn connect_refuses_bad_tokens_apps_without_the_intent_and_another_bots_app() {
    let home = tempfile::tempdir().unwrap();
    let h = home.path();
    db::migrate(h).unwrap();
    db::open(h).unwrap().execute_batch(
        "INSERT INTO users(id,display_name,role,created_at) VALUES('alice','Alice','admin',0),('bob','Bob','member',0);
         INSERT INTO bots(name,owner_id) VALUES('owl','alice'),('fox','alice'),('private','bob');",
    ).unwrap();
    let (_fake, api, ws) = fake_discord().await;
    let (prompts, _) = mpsc::unbounded_channel();
    let bots = Arc::new(Bots {
        replies: Mutex::default(),
        prompts,
    });
    let events = EventHub::new();
    let engine = Arc::new(RoomEngine::with_runner(h.into(), bots, events.clone()));
    let discord = Discord::with_endpoints(h.into(), events, engine, &api, &ws);
    discord.start().await.unwrap();
    let code = |bot: &'static str, token: &'static str| {
        let discord = discord.clone();
        async move {
            discord
                .call(
                    "alice",
                    "hexbot.discord.connect",
                    &json!({"bot":bot,"token":token}),
                )
                .await
                .unwrap()
                .map(|_| 0)
                .unwrap_or_else(|e| e.code)
        }
    };
    assert_eq!(
        code("owl", "T-wrong").await,
        hexbot_core::discord::TOKEN_REFUSED
    );
    assert_eq!(
        code("owl", "two words").await,
        hexbot_core::discord::TOKEN_REFUSED
    );
    assert_eq!(code("owl", "T-plain").await, hexbot_core::discord::INTENT);
    assert_eq!(code("owl", "T-owl").await, 0);
    assert_eq!(code("fox", "T-owl").await, hexbot_core::discord::TAKEN);
    assert_eq!(code("private", "T-fox").await, 4302);
    assert!(!h.join("accounts/discord/fox.json").exists());
    let list = discord
        .call("alice", "hexbot.discord.list", &json!({}))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(list["bots"].as_array().unwrap().len(), 1);
    assert_eq!(list["bots"][0]["bot"], "owl");
    discord.shutdown().await;
}

#[tokio::test]
async fn a_reply_waits_out_discord_trouble_and_never_repeats_a_part() {
    let home = tempfile::tempdir().unwrap();
    let h = home.path();
    db::migrate(h).unwrap();
    db::open(h)
        .unwrap()
        .execute_batch(
            "INSERT INTO users(id,display_name,role,created_at) VALUES('alice','Alice','admin',0);
         INSERT INTO bots(name,owner_id) VALUES('owl','alice');",
        )
        .unwrap();
    let (fake, api, ws) = fake_discord().await;
    let (online_tx, mut online) = mpsc::unbounded_channel();
    let (posts_tx, mut posts) = mpsc::unbounded_channel();
    *fake.online.lock().unwrap() = Some(online_tx);
    *fake.posts.lock().unwrap() = Some(posts_tx);
    let parts = ["a".repeat(1990), "b".repeat(1990), "c".repeat(100)];
    let (prompts_tx, _prompts) = mpsc::unbounded_channel();
    let bots = Arc::new(Bots {
        replies: Mutex::new(HashMap::from([("owl".into(), vec![parts.join("\n")])])),
        prompts: prompts_tx,
    });
    let events = EventHub::new();
    let engine = Arc::new(RoomEngine::with_runner(h.into(), bots, events.clone()));
    let discord = Discord::with_endpoints(h.into(), events, engine, &api, &ws);
    discord.retry_every(Duration::from_millis(20));
    discord.start().await.unwrap();
    discord
        .call(
            "alice",
            "hexbot.discord.connect",
            &json!({"bot":"owl","token":"T-owl"}),
        )
        .await
        .unwrap()
        .unwrap();
    within("owl online", online.recv()).await;
    // A reply in three parts. Discord takes the first, keeps the second but
    // loses its answer, then is down for longer than one post's retries, so
    // the outbox tries again later and carries on from the second part.
    *fake.trouble.lock().unwrap() = vec![
        Trouble::Fine,
        Trouble::LostAnswer,
        Trouble::Down,
        Trouble::Down,
        Trouble::Down,
    ];
    fake.sockets.lock().unwrap()["T-owl"]
        .send(message(
            "m1",
            "<@100> write a lot",
            ("300", "Sam"),
            &["100"],
        ))
        .unwrap();
    // Each part reaches the channel once, in order: a repeat would come
    // before the last part.
    for part in &parts {
        let (_, _, body) = within("a part", posts.recv()).await;
        assert_eq!(body["enforce_nonce"], true);
        assert_eq!(body["content"].as_str().unwrap(), part);
    }
    assert!(fake.trouble.lock().unwrap().is_empty());
    discord.shutdown().await;
}

#[tokio::test]
async fn a_bot_answers_the_mention_that_brings_it_in_whichever_connection_saw_it_first() {
    let home = tempfile::tempdir().unwrap();
    let h = home.path();
    db::migrate(h).unwrap();
    db::open(h)
        .unwrap()
        .execute_batch(
            "INSERT INTO users(id,display_name,role,created_at) VALUES('alice','Alice','admin',0);
         INSERT INTO bots(name,owner_id) VALUES('owl','alice'),('fox','alice');",
        )
        .unwrap();
    let (fake, api, ws) = fake_discord().await;
    let (online_tx, mut online) = mpsc::unbounded_channel();
    *fake.online.lock().unwrap() = Some(online_tx);
    let (prompts_tx, mut prompts) = mpsc::unbounded_channel();
    let bots = Arc::new(Bots {
        replies: Mutex::default(),
        prompts: prompts_tx,
    });
    let events = EventHub::new();
    let engine = Arc::new(RoomEngine::with_runner(h.into(), bots, events.clone()));
    let discord = Discord::with_endpoints(h.into(), events, engine, &api, &ws);
    discord.start().await.unwrap();
    for (bot, token) in [("owl", "T-owl"), ("fox", "T-fox")] {
        discord
            .call(
                "alice",
                "hexbot.discord.connect",
                &json!({"bot":bot,"token":token}),
            )
            .await
            .unwrap()
            .unwrap();
        within("online", online.recv()).await;
    }
    let deliver = |token: &str, d: Value| {
        fake.sockets.lock().unwrap()[token].send(d).unwrap();
    };
    // Owl's room already exists.
    deliver(
        "T-owl",
        message("m1", "<@100> hi", ("300", "Sam"), &["100"]),
    );
    assert_eq!(within("owl's turn", prompts.recv()).await.0, "owl");
    // Fox is mentioned for the first time, and owl's connection sees it first.
    let second = message("m2", "<@200> and you?", ("300", "Sam"), &["200"]);
    deliver("T-owl", second.clone());
    deliver("T-fox", second);
    let (bot, prompt) = within("fox's turn", prompts.recv()).await;
    assert_eq!(bot, "fox");
    assert!(prompt.contains("Sam: @fox and you?"), "{prompt}");
    discord.shutdown().await;
}

/// Discord's id for a message sent `ago` milliseconds before now; negative
/// is just after now.
fn snowflake(ago: i64) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    (((now - ago) - 1_420_070_400_000) << 22).to_string()
}

#[tokio::test]
async fn a_mention_still_on_its_way_when_another_opens_the_room_is_answered() {
    let home = tempfile::tempdir().unwrap();
    let h = home.path();
    db::migrate(h).unwrap();
    db::open(h)
        .unwrap()
        .execute_batch(
            "INSERT INTO users(id,display_name,role,created_at) VALUES('alice','Alice','admin',0);
         INSERT INTO bots(name,owner_id) VALUES('owl','alice'),('fox','alice');",
        )
        .unwrap();
    let (fake, api, ws) = fake_discord().await;
    let (online_tx, mut online) = mpsc::unbounded_channel();
    *fake.online.lock().unwrap() = Some(online_tx);
    let (prompts_tx, mut prompts) = mpsc::unbounded_channel();
    let bots = Arc::new(Bots {
        replies: Mutex::default(),
        prompts: prompts_tx,
    });
    let events = EventHub::new();
    let engine = Arc::new(RoomEngine::with_runner(h.into(), bots, events.clone()));
    let discord = Discord::with_endpoints(h.into(), events, engine, &api, &ws);
    discord.start().await.unwrap();
    for (bot, token) in [("owl", "T-owl"), ("fox", "T-fox")] {
        discord
            .call(
                "alice",
                "hexbot.discord.connect",
                &json!({"bot":bot,"token":token}),
            )
            .await
            .unwrap()
            .unwrap();
        within("online", online.recv()).await;
    }
    // Long ago someone asked owl, while it was away; that stays history.
    let old = message(
        &snowflake(3_600_000),
        "<@100> old question",
        ("301", "Kim"),
        &["100"],
    );
    // Sam asks owl, chats, then asks fox. Fox's connection is quicker, so the
    // channel's history already holds the mention owl hasn't seen yet.
    let first = message(&snowflake(3_000), "<@100> first", ("300", "Sam"), &["100"]);
    let chat = message(&snowflake(2_000), "anyway", ("300", "Sam"), &[]);
    let second = message(&snowflake(1_000), "<@200> second", ("300", "Sam"), &["200"]);
    *fake.history.lock().unwrap() = Some(json!([chat, first, old]));
    let deliver = |token: &str, d: Value| {
        fake.sockets.lock().unwrap()[token].send(d).unwrap();
    };
    deliver("T-fox", second.clone());
    let mut asked = HashMap::new();
    for _ in 0..2 {
        let (bot, prompt) = within("a turn", prompts.recv()).await;
        asked.insert(bot, prompt);
    }
    assert!(asked["owl"].contains("Sam: @owl first"), "{}", asked["owl"]);
    assert!(
        asked["fox"].contains("Sam: @fox second"),
        "{}",
        asked["fox"]
    );
    // Owl's late copies change nothing: each message is in the room once,
    // in the order it was said, and the old question is history.
    deliver("T-owl", first);
    deliver("T-owl", chat);
    deliver("T-owl", second);
    deliver(
        "T-fox",
        message(&snowflake(0), "<@100> thanks", ("300", "Sam"), &["100"]),
    );
    let (bot, prompt) = within("owl's second turn", prompts.recv()).await;
    assert_eq!(bot, "owl");
    assert!(prompt.contains("Sam: @owl thanks"), "{prompt}");
    let conn = db::open(h).unwrap();
    let said: Vec<(String, bool)> = conn
        .prepare("SELECT payload_json FROM room_events WHERE kind='message.user' ORDER BY seq")
        .unwrap()
        .query_map([], |r| r.get::<_, String>(0))
        .unwrap()
        .map(|p| {
            let p: Value = serde_json::from_str(&p.unwrap()).unwrap();
            (p["text"].as_str().unwrap().to_owned(), p["history"] == true)
        })
        .collect();
    assert_eq!(
        said,
        [
            ("@owl old question".to_owned(), true),
            ("@owl first".to_owned(), false),
            ("anyway".to_owned(), false),
            ("@fox second".to_owned(), false),
            ("@owl thanks".to_owned(), false),
        ]
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(300), prompts.recv())
            .await
            .is_err(),
        "nobody answers the old question or a late copy"
    );
    discord.shutdown().await;
}

#[tokio::test]
async fn a_room_opened_again_keeps_what_came_before_and_a_failing_message_loses_no_other() {
    let home = tempfile::tempdir().unwrap();
    let h = home.path();
    db::migrate(h).unwrap();
    db::open(h)
        .unwrap()
        .execute_batch(
            "INSERT INTO users(id,display_name,role,created_at) VALUES('alice','Alice','admin',0);
         INSERT INTO bots(name,owner_id) VALUES('owl','alice'),('fox','alice');",
        )
        .unwrap();
    let (fake, api, ws) = fake_discord().await;
    let (online_tx, mut online) = mpsc::unbounded_channel();
    *fake.online.lock().unwrap() = Some(online_tx);
    let (prompts_tx, mut prompts) = mpsc::unbounded_channel();
    let bots = Arc::new(Bots {
        replies: Mutex::default(),
        prompts: prompts_tx,
    });
    let events = EventHub::new();
    let engine = Arc::new(RoomEngine::with_runner(h.into(), bots, events.clone()));
    let discord = Discord::with_endpoints(h.into(), events, engine, &api, &ws);
    discord.retry_every(Duration::from_millis(20));
    discord.start().await.unwrap();
    for (bot, token) in [("owl", "T-owl"), ("fox", "T-fox")] {
        discord
            .call(
                "alice",
                "hexbot.discord.connect",
                &json!({"bot":bot,"token":token}),
            )
            .await
            .unwrap()
            .unwrap();
        within("online", online.recv()).await;
    }
    let deliver = |token: &str, d: Value| {
        fake.sockets.lock().unwrap()[token].send(d).unwrap();
    };
    let said = || -> Vec<(String, bool)> {
        db::open(h)
            .unwrap()
            .prepare("SELECT payload_json FROM room_events WHERE kind='message.user' ORDER BY seq")
            .unwrap()
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .map(|p| {
                let p: Value = serde_json::from_str(&p.unwrap()).unwrap();
                (p["text"].as_str().unwrap().to_owned(), p["history"] == true)
            })
            .collect()
    };
    let room = || -> String {
        db::open(h)
            .unwrap()
            .query_row(
                "SELECT room_id FROM discord_channels WHERE channel_id='c1'",
                [],
                |r| r.get(0),
            )
            .unwrap()
    };

    // Owl answers in the channel, then the owner deletes the room.
    let asked = message(&snowflake(5_000), "<@100> hi", ("300", "Sam"), &["100"]);
    *fake.history.lock().unwrap() = Some(json!([]));
    deliver("T-owl", asked.clone());
    assert_eq!(within("owl's turn", prompts.recv()).await.0, "owl");
    rooms::delete(h, &room()).unwrap();
    // Fox's late copy of the mention owl answered opens no room.
    deliver("T-fox", asked.clone());
    // Moments later Sam asks fox: what owl answered is history in the new room,
    // and another late copy of it changes nothing there.
    *fake.history.lock().unwrap() = Some(json!([asked]));
    deliver(
        "T-fox",
        message(&snowflake(-5), "<@200> you too", ("300", "Sam"), &["200"]),
    );
    deliver("T-fox", asked.clone());
    let (bot, prompt) = within("fox's turn", prompts.recv()).await;
    assert_eq!(bot, "fox");
    assert!(prompt.contains("Sam: @fox you too"), "{prompt}");
    assert_eq!(
        said(),
        [
            ("@owl hi".to_owned(), true),
            ("@fox you too".to_owned(), false)
        ]
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(300), prompts.recv())
            .await
            .is_err(),
        "owl doesn't answer again what it answered in the deleted room"
    );
    // Opened again once more, a mention still on its way after the deletion
    // is answered.
    rooms::delete(h, &room()).unwrap();
    // (Sent a few milliseconds after the deletion, as nothing can be sooner.)
    let on_its_way = message(&snowflake(-5), "<@100> and now?", ("300", "Sam"), &["100"]);
    let opening = message(&snowflake(-10), "<@200> and you?", ("300", "Sam"), &["200"]);
    *fake.history.lock().unwrap() = Some(json!([on_its_way, asked]));
    deliver("T-fox", opening);
    let mut asked_now = HashMap::new();
    for _ in 0..2 {
        let (bot, prompt) = within("a turn", prompts.recv()).await;
        asked_now.insert(bot, prompt);
    }
    assert!(
        asked_now["owl"].contains("Sam: @owl and now?"),
        "{}",
        asked_now["owl"]
    );
    assert!(
        asked_now["fox"].contains("Sam: @fox and you?"),
        "{}",
        asked_now["fox"]
    );

    // In another channel a mention on its way can't be saved; what follows
    // it still is, and the mention that opened the room is answered.
    let in_c2 = |mut m: Value| {
        m["channel_id"] = json!("c2");
        m
    };
    let lost = in_c2(message(
        &snowflake(2_000),
        "<@100> lost",
        ("300", "Sam"),
        &["100"],
    ));
    let chat = in_c2(message(&snowflake(1_000), "anyway", ("300", "Sam"), &[]));
    let second = in_c2(message(
        &snowflake(0),
        "<@200> second",
        ("300", "Sam"),
        &["200"],
    ));
    db::open(h)
        .unwrap()
        .execute_batch(&format!(
            "CREATE TRIGGER broken BEFORE INSERT ON discord_messages WHEN NEW.message_id='{}'
             BEGIN SELECT RAISE(ABORT,'disk trouble'); END;",
            lost["id"].as_str().unwrap()
        ))
        .unwrap();
    *fake.history.lock().unwrap() = Some(json!([chat, lost]));
    deliver("T-fox", second);
    let (bot, prompt) = within("fox's turn", prompts.recv()).await;
    assert_eq!(bot, "fox");
    assert!(prompt.contains("Sam: @fox second"), "{prompt}");
    let c2: String = db::open(h)
        .unwrap()
        .query_row(
            "SELECT room_id FROM discord_channels WHERE channel_id='c2'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let in_room: Vec<String> = db::open(h)
        .unwrap()
        .prepare("SELECT json_extract(payload_json,'$.text') FROM room_events WHERE room_id=? AND kind='message.user' ORDER BY seq")
        .unwrap()
        .query_map([&c2], |r| r.get(0))
        .unwrap()
        .map(|t| t.unwrap())
        .collect();
    assert_eq!(in_room, ["anyway", "@fox second"]);
    discord.shutdown().await;
}
