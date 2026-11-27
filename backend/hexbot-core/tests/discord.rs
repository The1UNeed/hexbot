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
    // #announcements: everyone reads, nobody but the admins posts.
    if id == "c-ro" {
        return Json(
            json!({"id":id,"type":5,"name":"announcements","permission_overwrites":[
                {"id":"g1","type":0,"allow":"0","deny":"2048"}
            ]}),
        );
    }
    Json(json!({"id":id,"type":0,"name":"general"}))
}
async fn guild(Path(id): Path<String>) -> Json<Value> {
    // Everyone sees channels; the mods role has nothing more of its own.
    // View Channel, Send Messages and Read Message History.
    Json(
        json!({"id":id,"name":"Test Server","owner_id":"999","roles":[
            {"id":id,"permissions":"68608"},{"id":"mods","permissions":"0"}
        ]}),
    )
}
async fn member(Path((guild, _user)): Path<(String, String)>) -> Json<Value> {
    assert_eq!(guild, "g1");
    Json(json!({"roles":[]}))
}
async fn guild_channels(Path(id): Path<String>) -> Json<Value> {
    assert_eq!(id, "g1");
    Json(json!([
        {"id":"c1","type":0,"name":"general","topic":null},
        {"id":"c-news","type":5,"name":"news","topic":"What ships"},
        {"id":"v1","type":2,"name":"Voice"},
        // Only for mods: the bots aren't, so they never hear of it.
        {"id":"c-mods","type":0,"name":"mods","topic":"Layoffs","permission_overwrites":[
            {"id":"g1","type":0,"allow":"0","deny":"1024"},
            {"id":"mods","type":0,"allow":"1024","deny":"0"}
        ]},
    ]))
}
async fn guild_threads(Path(id): Path<String>) -> Json<Value> {
    assert_eq!(id, "g1");
    Json(json!({"threads":[
        {"id":"t1","type":11,"guild_id":"g1","parent_id":"c1","name":"release plan"},
        {"id":"t2","type":12,"guild_id":"g1","parent_id":"c1","name":"private chat"},
        {"id":"t3","type":11,"guild_id":"g1","parent_id":"c-mods","name":"who goes"}
    ]}))
}
async fn history(
    State(fake): State<Arc<Fake>>,
    Path(id): Path<String>,
    Query(q): Query<HashMap<String, String>>,
) -> Json<Value> {
    // Another channel, as the read tool asks for it.
    if id == "c-news" {
        assert_eq!(q["limit"], "2");
        return Json(json!([
            {"id":"n2","type":0,"timestamp":"2026-11-16T10:01:00Z","content":"launch is friday","author":{"id":"302","username":"lee"},"mentions":[]},
            {"id":"n1","type":0,"timestamp":"2026-11-16T10:00:00Z","content":"<@100> heads up","author":{"id":"302","username":"lee"},"mentions":[{"id":"100","username":"app-100"}]},
        ]));
    }
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
    // In #log the bots may post but not read back, so not reply.
    if channel == "c-log" && body["message_reference"].is_object() {
        return (
            StatusCode::FORBIDDEN,
            Json(
                json!({"message":"Cannot reply without permission to read message history","code":160002}),
            ),
        );
    }
    // Nobody but the admins posts in #announcements.
    if channel == "c-ro" {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({"message":"Missing Permissions","code":50013})),
        );
    }
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
    let ready = json!({"op":0,"t":"READY","s":1,"d":{"session_id":"s","resume_gateway_url":format!("ws://127.0.0.1:{port}/gateway"),"user":{"id":user},"guilds":[{"id":"g1","unavailable":true}]}});
    socket
        .send(Message::Text(ready.to_string().into()))
        .await
        .unwrap();
    let server = json!({"op":0,"t":"GUILD_CREATE","s":1,"d":{"id":"g1","name":"Test Server"}});
    socket
        .send(Message::Text(server.to_string().into()))
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
        .route("/api/guilds/{id}/channels", get(guild_channels))
        .route("/api/guilds/{id}/members/{user}", get(member))
        .route("/api/guilds/{id}/threads/active", get(guild_threads))
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
         INSERT INTO bots(name,owner_id) VALUES('owl','alice'),('fox','alice');
         INSERT INTO discord_plugin(bot,owner_id,enabled_at) SELECT name,owner_id,0 FROM bots;",
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
        prompt.contains("Kim: unrelated chatter\nSam (replying to @owl): thanks"),
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
         INSERT INTO bots(name,owner_id) VALUES('owl','alice'),('fox','alice'),('private','bob');
         INSERT INTO discord_plugin(bot,owner_id,enabled_at) SELECT name,owner_id,0 FROM bots;",
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
         INSERT INTO bots(name,owner_id) VALUES('owl','alice');
         INSERT INTO discord_plugin(bot,owner_id,enabled_at) SELECT name,owner_id,0 FROM bots;",
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
         INSERT INTO bots(name,owner_id) VALUES('owl','alice'),('fox','alice');
         INSERT INTO discord_plugin(bot,owner_id,enabled_at) SELECT name,owner_id,0 FROM bots;",
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
         INSERT INTO bots(name,owner_id) VALUES('owl','alice'),('fox','alice');
         INSERT INTO discord_plugin(bot,owner_id,enabled_at) SELECT name,owner_id,0 FROM bots;",
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
         INSERT INTO bots(name,owner_id) VALUES('owl','alice'),('fox','alice');
         INSERT INTO discord_plugin(bot,owner_id,enabled_at) SELECT name,owner_id,0 FROM bots;",
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

#[tokio::test]
async fn each_bot_acts_as_its_mode_says_and_reads_the_rest_of_its_server() {
    let home = tempfile::tempdir().unwrap();
    let h = home.path();
    db::migrate(h).unwrap();
    db::open(h)
        .unwrap()
        .execute_batch(
            "INSERT INTO users(id,display_name,role,created_at) VALUES('alice','Alice','admin',0);
         INSERT INTO bots(name,owner_id) VALUES('owl','alice'),('fox','alice');
         INSERT INTO discord_plugin(bot,owner_id,enabled_at) SELECT name,owner_id,0 FROM bots;",
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
            ("owl".into(), vec!["Hi Sam.".into()]),
            (
                "fox".into(),
                vec![
                    "Here.".into(),
                    "Hi.".into(),
                    "Again.".into(),
                    "Can I post?".into(),
                    "(pass)".into(),
                    "Plain.".into(),
                ],
            ),
        ])),
        prompts: prompts_tx,
    });
    let events = EventHub::new();
    let mut changes = events.subscribe();
    let engine = Arc::new(RoomEngine::with_runner(h.into(), bots, events.clone()));
    let discord = Discord::with_endpoints(h.into(), events, engine, &api, &ws);
    discord.start().await.unwrap();
    let call = |method: &str, p: Value| {
        let discord = discord.clone();
        let method = format!("hexbot.discord.{method}");
        async move { discord.call("alice", &method, &p).await.unwrap() }
    };
    // A new bot reads along, as every bot did before modes.
    call("connect", json!({"bot":"owl","token":"T-owl"}))
        .await
        .unwrap();
    call("connect", json!({"bot":"fox","token":"T-fox"}))
        .await
        .unwrap();
    within("owl online", online.recv()).await;
    within("fox online", online.recv()).await;
    // The server each one is in comes from its Gateway.
    let mut servers = 0;
    while servers < 2 {
        let event = within("a server", async { changes.recv().await.ok() }).await;
        let p = &event.frame["params"];
        if p["type"] == "hexbot.discord.changed" {
            for bot in ["owl", "fox"] {
                let status = call("get", json!({"bot":bot})).await.unwrap();
                if status["discord"]["servers"]
                    == json!([{"id":"g1","name":"Test Server","mode":null}])
                    && p["payload"]["bot"] == bot
                {
                    servers += 1;
                }
            }
        }
    }
    let owl = call("get", json!({"bot":"owl"})).await.unwrap();
    assert_eq!(owl["discord"]["mode"], "reads");
    assert_eq!(owl["enabled"], true);
    // Owl is an active member of this server; fox sees only its mentions everywhere.
    let owl = call(
        "set_mode",
        json!({"bot":"owl","guild_id":"g1","mode":"active"}),
    )
    .await
    .unwrap();
    assert_eq!(owl["discord"]["mode"], "reads");
    assert_eq!(owl["discord"]["servers"][0]["mode"], "active");
    call("set_mode", json!({"bot":"fox","mode":"mentions"}))
        .await
        .unwrap();
    assert_eq!(
        call("set_mode", json!({"bot":"fox","mode":"loud"}))
            .await
            .unwrap_err()
            .code,
        4202
    );
    assert_eq!(
        call(
            "set_mode",
            json!({"bot":"fox","guild_id":"elsewhere","mode":"active"})
        )
        .await
        .unwrap_err()
        .code,
        hexbot_core::discord::NOT_IN_DISCORD
    );
    let deliver = |token: &str, d: Value| {
        fake.sockets.lock().unwrap()[token].send(d).unwrap();
    };

    // Where owl can't post, nothing opens for it.
    let mut announcement = message("m0", "launch day", ("999", "Admin"), &[]);
    announcement["channel_id"] = json!("c-ro");
    deliver("T-owl", announcement);
    // Nobody mentions anyone: the channel opens for owl, which takes it in
    // and answers, with what was said before as history.
    let hello = message("m1", "morning all", ("300", "Sam"), &[]);
    deliver("T-owl", hello.clone());
    deliver("T-fox", hello);
    let (bot, prompt) = within("owl's turn", prompts.recv()).await;
    assert_eq!(bot, "owl");
    assert!(
        prompt.contains("sam: older two\nSam: morning all"),
        "{prompt}"
    );
    assert!(prompt.contains("active member of this server"), "{prompt}");
    let (_, token, body) = within("owl's reply", posts.recv()).await;
    assert_eq!(
        (token.as_str(), body["content"].as_str()),
        ("T-owl", Some("Hi Sam."))
    );
    assert_eq!(body["message_reference"]["message_id"], "m1");
    let mut own = message("p1", "Hi Sam.", ("100", "Owl"), &[]);
    own["nonce"] = body["nonce"].clone();
    deliver("T-owl", own.clone());
    deliver("T-fox", own);

    let opened_ro: i64 = db::open(h)
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM discord_channels WHERE channel_id='c-ro'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(opened_ro, 0);

    // Fox answers its mention seeing only that, a reply to someone's message
    // with what it replies to; owl, listening, leaves fox's message to fox.
    let mut ask = message("m2", "<@200> are you around?", ("301", "Kim"), &["200"]);
    ask["type"] = json!(19);
    ask["referenced_message"] = json!({"id":"m1","content":"morning all","author":{"id":"300","username":"sam","global_name":"Sam"}});
    deliver("T-fox", ask.clone());
    deliver("T-owl", ask);
    let (bot, fox) = within("fox's turn", prompts.recv()).await;
    assert_eq!(bot, "fox");
    let fox = &fox;
    assert!(
        fox.contains("Messages to you since your last turn"),
        "{fox}"
    );
    assert!(
        fox.contains("Kim (replying to Sam: morning all): @fox are you around?"),
        "{fox}"
    );
    assert!(
        !fox.contains("older two") && !fox.contains("Hi Sam."),
        "{fox}"
    );
    assert!(!fox.contains("read it."), "{fox}");
    let (_, token, body) = within("fox's reply", posts.recv()).await;
    assert_eq!(
        (token.as_str(), body["content"].as_str()),
        ("T-fox", Some("Here."))
    );

    // Owl reads the server's other channels and threads, and nothing else.
    let stored: String = db::open(h)
        .unwrap()
        .query_row(
            "SELECT stored_session_id FROM room_sessions WHERE bot='owl'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let listed = discord
        .read("owl", &stored, &json!({"action":"channels"}))
        .await
        .unwrap();
    assert_eq!(
        listed["channels"],
        json!([
            {"id":"c1","name":"general","kind":"channel","topic":null},
            {"id":"c-news","name":"news","kind":"channel","topic":"What ships"},
            {"id":"t1","name":"release plan","kind":"thread","in":"#general"},
        ])
    );
    assert_eq!(listed["more"], 0);
    assert_eq!(
        discord
            .read("owl", &stored, &json!({"action":"read","channel":"c-mods"}))
            .await
            .unwrap_err()
            .code,
        4213
    );
    let news = discord
        .read(
            "owl",
            &stored,
            &json!({"action":"read","channel":"#news","limit":2}),
        )
        .await
        .unwrap();
    assert_eq!(news["channel"], "#news");
    assert_eq!(news["messages"][0]["text"], "@owl heads up");
    assert_eq!(news["messages"][1]["from"], "lee");
    assert_eq!(news["messages"][1]["text"], "launch is friday");
    assert_eq!(
        discord
            .read(
                "owl",
                &stored,
                &json!({"action":"read","channel":"#elsewhere"})
            )
            .await
            .unwrap_err()
            .code,
        4213
    );
    // Fox sees only its mentions, so it reads nothing else.
    let fox_stored: String = db::open(h)
        .unwrap()
        .query_row(
            "SELECT stored_session_id FROM room_sessions WHERE bot='fox'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        discord
            .read("fox", &fox_stored, &json!({"action":"channels"}))
            .await
            .unwrap_err()
            .code,
        4302
    );

    // In a channel where only fox is, what nobody says to it isn't kept,
    // nor what was said before it was mentioned.
    let in_c3 = |mut m: Value| {
        m["channel_id"] = json!("c3");
        m
    };
    call("set_mode", json!({"bot":"owl","guild_id":"g1","mode":null}))
        .await
        .unwrap();
    deliver(
        "T-fox",
        in_c3(message("m3", "<@200> hi", ("300", "Sam"), &["200"])),
    );
    let (bot, _) = within("fox's turn in c3", prompts.recv()).await;
    assert_eq!(bot, "fox");
    deliver(
        "T-fox",
        in_c3(message("m4", "just chatting", ("300", "Sam"), &[])),
    );
    deliver(
        "T-fox",
        in_c3(message("m5", "<@200> again", ("300", "Sam"), &["200"])),
    );
    let (bot, prompt) = within("fox's second turn in c3", prompts.recv()).await;
    assert_eq!(bot, "fox");
    assert!(!prompt.contains("just chatting"), "{prompt}");
    let c3: Vec<String> = db::open(h)
        .unwrap()
        .prepare("SELECT json_extract(e.payload_json,'$.text') FROM room_events e JOIN discord_channels d ON d.room_id=e.room_id WHERE d.channel_id='c3' AND e.kind='message.user' ORDER BY e.seq")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .map(|t| t.unwrap())
        .collect();
    assert_eq!(c3, ["@fox hi", "@fox again"]);

    // In #announcements a mention of fox opens a room; owl, an active member
    // again, can't post there, so it doesn't join. Fox answers, Discord
    // refuses its post, and fox leaves the room until it is mentioned.
    call(
        "set_mode",
        json!({"bot":"owl","guild_id":"g1","mode":"active"}),
    )
    .await
    .unwrap();
    let in_ro = |mut m: Value| {
        m["channel_id"] = json!("c-ro");
        m
    };
    deliver(
        "T-fox",
        in_ro(message(
            "m6",
            "<@200> can you post?",
            ("300", "Sam"),
            &["200"],
        )),
    );
    let (bot, _) = within("fox's turn in #announcements", prompts.recv()).await;
    assert_eq!(bot, "fox");
    deliver(
        "T-owl",
        in_ro(message("m7", "anyone?", ("300", "Sam"), &[])),
    );
    loop {
        let event = within("fox's refused post", async { changes.recv().await.ok() }).await;
        let p = &event.frame["params"];
        if p["type"] == "hexbot.rooms.event" && p["payload"]["event"]["kind"] == "member.left" {
            assert_eq!(p["payload"]["event"]["payload"]["bot"], "fox");
            break;
        }
    }
    // Owl's message was taken before fox's post failed, in order.
    deliver(
        "T-fox",
        in_c3(message("m8", "<@200> sync", ("300", "Sam"), &["200"])),
    );
    within("fox's turn in c3", prompts.recv()).await;
    let in_ro_room: Vec<(String, bool)> = db::open(h)
        .unwrap()
        .prepare("SELECT m.member_id,m.left_at IS NULL FROM room_members m JOIN discord_channels d ON d.room_id=m.room_id WHERE d.channel_id='c-ro' AND m.member_kind='bot' ORDER BY m.member_id")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .map(|r| r.unwrap())
        .collect();
    assert_eq!(in_ro_room, [("fox".to_owned(), false)]);

    // Where a reply can't be made, fox's answer goes out as a plain message,
    // and fox stays.
    let mut in_log = message("m9", "<@200> log this", ("300", "Sam"), &["200"]);
    in_log["channel_id"] = json!("c-log");
    deliver("T-fox", in_log);
    within("fox's turn in #log", prompts.recv()).await;
    // (Fox's earlier answers in c3 went out first.)
    let (token, body) = loop {
        let (channel, token, body) = within("fox's plain post", posts.recv()).await;
        if channel == "c-log" {
            break (token, body);
        }
    };
    assert_eq!(token, "T-fox");
    assert_eq!(body["content"], "Plain.");
    assert!(body["message_reference"].is_null());
    let fox_stays: bool = db::open(h)
        .unwrap()
        .query_row(
            "SELECT m.left_at IS NULL FROM room_members m JOIN discord_channels d ON d.room_id=m.room_id WHERE d.channel_id='c-log' AND m.member_id='fox'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(fox_stays);
    discord.shutdown().await;
}
