//! Exercise the actual HTTP/WebSocket router with the unchanged browser protocol.
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use hexbot_core::{
    auth, db,
    server::{self, App},
    services,
};
use serde_json::{Value, json};
use std::{fs, path::PathBuf, sync::Arc, time::Duration};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{Message, client::IntoClientRequest},
};

type Socket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;
struct Fixture {
    _directory: tempfile::TempDir,
    home: PathBuf,
    app: Arc<App>,
    base: String,
    token: String,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Fixture {
    async fn new(gated: bool) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let home = directory.path().join("home");
        db::migrate(&home).unwrap();
        let workspace = directory.path().join("workspace");
        db::open(&home)
            .unwrap()
            .execute(
                "INSERT INTO settings VALUES ('workspace_dir',?)",
                [json!(workspace).to_string()],
            )
            .unwrap();
        let dist = directory.path().join("web");
        fs::create_dir(&dist).unwrap();
        fs::write(
            dist.join("index.html"),
            "<!doctype html><html><head></head><body>unchanged app</body></html>",
        )
        .unwrap();
        fs::write(dist.join("app.js"), "const originalFrontend = true;").unwrap();
        fs::write(directory.path().join("private.txt"), "outside static root").unwrap();
        let pi = directory.path().join("fake-pi.cjs");
        fs::write(&pi,r#"#!/usr/bin/env node
const emit=v=>process.stdout.write(JSON.stringify(v)+'\n');
const rl=require('node:readline').createInterface({input:process.stdin});
process.on('SIGTERM',()=>process.exit(0));
rl.on('line',line=>{const c=JSON.parse(line);emit({type:'response',id:c.id,command:c.type,success:true,data:c.type==='get_available_models'?{models:[{id:'one',provider:'fixture'}]}:{}});if(c.type==='prompt'){
emit({type:'agent_start'});emit({type:'message_end',message:{role:'user',content:c.message}});
emit({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'Fixture reply'}});
emit({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'Fixture reply'}],usage:{input:5,output:2,cost:{total:0}},stopReason:'stop'}});
emit({type:'agent_end'});emit({type:'agent_settled'});}});
"#).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&pi, fs::Permissions::from_mode(0o700)).unwrap();
        }
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let mut advertised = address;
        if gated {
            advertised.set_ip("0.0.0.0".parse().unwrap());
        }
        let app = App::new(home.clone(), advertised, pi, Some(dist)).unwrap();
        let token = auth::local_token(&home).unwrap();
        let router = server::router(app.clone());
        let task = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        Self {
            _directory: directory,
            home,
            app,
            base: format!("http://{address}"),
            token,
            task,
        }
    }
    fn ws(&self) -> String {
        self.base.replacen("http", "ws", 1) + "/api/ws"
    }
    async fn socket(&self, token: &str) -> Socket {
        let (mut socket, _) = connect_async(format!("{}?token={token}", self.ws()))
            .await
            .unwrap();
        assert_eq!(frame(&mut socket).await["params"]["type"], "gateway.ready");
        socket
    }
    async fn shutdown(&self) {
        self.app.shutdown().await;
        services::shutdown(&self.home).await.unwrap();
    }
}
async fn frame(socket: &mut Socket) -> Value {
    tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            match socket.next().await.unwrap().unwrap() {
                Message::Text(text) => return serde_json::from_str(text.trim()).unwrap(),
                Message::Ping(bytes) => socket.send(Message::Pong(bytes)).await.unwrap(),
                other => panic!("expected JSON frame, got {other:?}"),
            }
        }
    })
    .await
    .unwrap()
}
async fn response(socket: &mut Socket, id: &str) -> Value {
    loop {
        let frame = frame(socket).await;
        if frame["id"] == id {
            return frame;
        }
    }
}
async fn request(socket: &mut Socket, id: &str, method: &str, params: Value) -> Value {
    socket
        .send(Message::Text(
            json!({"jsonrpc":"2.0","id":id,"method":method,"params":params})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    response(socket, id).await
}

#[tokio::test]
async fn browser_bootstrap_static_files_and_host_origin_checks() {
    let fixture = Fixture::new(false).await;
    let client = reqwest::Client::new();
    let response = client.get(&fixture.base).send().await.unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(response.headers()["cache-control"], "no-store");
    let html = response.text().await.unwrap();
    assert!(html.contains("unchanged app"));
    assert!(html.contains("window.__HERMES_AUTH_REQUIRED__=false"));
    assert!(html.contains(&fixture.token));
    let hostile = client
        .get(&fixture.base)
        .header("host", "attacker.example")
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert!(hostile.contains("window.__HERMES_AUTH_REQUIRED__=true"));
    assert!(!hostile.contains(&fixture.token));
    assert_eq!(
        client
            .get(format!("{}/app.js", fixture.base))
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap(),
        "const originalFrontend = true;"
    );
    let traversal = client
        .get(format!("{}/%2e%2e/private.txt", fixture.base))
        .send()
        .await
        .unwrap();
    assert!(!traversal.status().is_success());
    assert!(
        !traversal
            .text()
            .await
            .unwrap()
            .contains("outside static root")
    );
    assert_eq!(
        client
            .get(&fixture.base)
            .header("origin", "https://attacker.example")
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    let options = client
        .request(
            reqwest::Method::OPTIONS,
            format!("{}/api/auth/ws-ticket", fixture.base),
        )
        .header("origin", "hexbot-app://app")
        .send()
        .await
        .unwrap();
    assert_eq!(options.status(), 204);
    assert_eq!(
        options.headers()["access-control-allow-origin"],
        "hexbot-app://app"
    );
    fixture.shutdown().await;
    let gated = Fixture::new(true).await;
    let html = client
        .get(&gated.base)
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert!(html.contains("window.__HERMES_AUTH_REQUIRED__=true"));
    assert!(!html.contains(&gated.token));
    gated.shutdown().await;
}

#[tokio::test]
async fn pairing_cookie_login_single_use_tickets_and_bearer_session() {
    let fixture = Fixture::new(true).await;
    let client = reqwest::Client::new();
    assert_eq!(
        client
            .post(format!("{}/api/auth/ws-ticket", fixture.base))
            .send()
            .await
            .unwrap()
            .status(),
        401
    );
    assert!(connect_async(fixture.ws()).await.is_err());
    let code = auth::new_code(&fixture.home, "local").unwrap()["code"]
        .as_str()
        .unwrap()
        .to_owned();
    let paired = client
        .post(format!("{}/hexbot/pair", fixture.base))
        .json(&json!({"code":code,"device_name":"Browser","platform":"browser"}))
        .send()
        .await
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    let token = paired["device_token"].as_str().unwrap();
    assert_eq!(
        client
            .post(format!("{}/hexbot/pair", fixture.base))
            .json(&json!({"code":code}))
            .send()
            .await
            .unwrap()
            .status(),
        401
    );
    let login = client
        .post(format!("{}/hexbot/session", fixture.base))
        .bearer_auth(token)
        .send()
        .await
        .unwrap();
    assert_eq!(login.status(), 200);
    let cookie = login.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let minted = client
        .post(format!("{}/api/auth/ws-ticket", fixture.base))
        .header("cookie", &cookie)
        .send()
        .await
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    let ticket = minted["ticket"].as_str().unwrap();
    let (mut socket, _) = connect_async(format!("{}?ticket={ticket}", fixture.ws()))
        .await
        .unwrap();
    assert_eq!(frame(&mut socket).await["params"]["type"], "gateway.ready");
    assert!(
        connect_async(format!("{}?ticket={ticket}", fixture.ws()))
            .await
            .is_err()
    );
    let info = request(&mut socket, "info", "hexbot.info", json!({})).await;
    assert!(info["result"]["auth_required"].as_bool().unwrap());
    assert_eq!(info["result"]["version"], hexbot_core::version());
    let code = auth::new_code(&fixture.home, "local").unwrap()["code"]
        .as_str()
        .unwrap()
        .to_owned();
    let login = client
        .post(format!("{}/auth/password-login", fixture.base))
        .json(&json!({"provider":"hexbot","username":"Paired browser","password":code}))
        .send()
        .await
        .unwrap();
    assert_eq!(login.status(), 200);
    assert!(
        login.headers()["set-cookie"]
            .to_str()
            .unwrap()
            .contains("HttpOnly")
    );
    assert_eq!(login.json::<Value>().await.unwrap()["ok"], true);
    socket.close(None).await.unwrap();
    fixture.shutdown().await;
}

#[tokio::test]
async fn websocket_rpc_errors_notifications_and_current_device_shape() {
    let fixture = Fixture::new(false).await;
    let mut socket = fixture.socket(&fixture.token).await;
    socket
        .send(Message::Text("{broken\n".into()))
        .await
        .unwrap();
    assert_eq!(frame(&mut socket).await["error"]["code"], -32700);
    socket
        .send(Message::Text(
            json!({"jsonrpc":"1.0","id":1,"method":"gateway.ping"})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    assert_eq!(frame(&mut socket).await["error"]["code"], -32600);
    assert_eq!(
        request(&mut socket, "params", "gateway.ping", json!([])).await["error"]["code"],
        -32602
    );
    assert_eq!(
        request(&mut socket, "missing", "does.not.exist", json!({})).await["error"]["code"],
        -32601
    );
    socket
        .send(Message::Text(
            format!(
                "{}\n{}\n",
                json!({"jsonrpc":"2.0","method":"gateway.ping"}),
                json!({"jsonrpc":"2.0","id":"after-notification","method":"gateway.ping"})
            )
            .into(),
        ))
        .await
        .unwrap();
    let next = frame(&mut socket).await;
    assert_eq!(next["id"], "after-notification");
    assert_eq!(next["result"]["pong"], true);
    let devices = request(&mut socket, "devices", "hexbot.devices.list", json!({})).await;
    assert_eq!(
        devices["result"]["devices"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|v| v["current"] == true)
            .count(),
        1
    );
    assert!(!devices.to_string().contains(&fixture.token));
    socket.close(None).await.unwrap();
    fixture.shutdown().await;
}

#[tokio::test]
async fn websocket_mutation_events_owner_isolation_and_flat_replay() {
    let fixture = Fixture::new(false).await;
    db::open(&fixture.home)
        .unwrap()
        .execute(
            "INSERT INTO users VALUES ('member','Member','member','{}',0,NULL)",
            [],
        )
        .unwrap();
    let member = auth::mint_device(&fixture.home, "Member", "test", "member").unwrap();
    let mut member_socket = fixture
        .socket(member["device_token"].as_str().unwrap())
        .await;
    let mut admin = fixture.socket(&fixture.token).await;
    assert_eq!(
        request(
            &mut member_socket,
            "denied",
            "hexbot.settings.get",
            json!({})
        )
        .await["error"]["code"],
        4301
    );
    admin.send(Message::Text(json!({"jsonrpc":"2.0","id":"memory","method":"hexbot.memory.user.set","params":{"text":"User-authored text"}}).to_string().into())).await.unwrap();
    let mut saw_event = false;
    let mut saw_response = false;
    while !saw_event || !saw_response {
        let frame = frame(&mut admin).await;
        if frame["id"] == "memory" {
            assert_eq!(frame["result"]["text"], "User-authored text");
            saw_response = true;
        }
        if frame["params"]["type"] == "hexbot.memory.user.changed" {
            saw_event = true;
        }
    }
    fixture.app.events.emit(
        "local",
        Some("test-session"),
        "message.delta",
        json!({"text":"secret"}),
    );
    fixture.app.events.emit(
        "member",
        Some("member-session"),
        "status.update",
        json!({"status":"idle"}),
    );
    let event = frame(&mut member_socket).await;
    assert_eq!(event["params"]["session_id"], "member-session");
    assert!(!event.to_string().contains("secret"));
    let replay = request(
        &mut admin,
        "replay",
        "session.events.since",
        json!({"session_id":"test-session","last_seen":0}),
    )
    .await;
    assert_eq!(replay["result"]["events"][0]["type"], "message.delta");
    assert_eq!(replay["result"]["events"][0]["payload"]["text"], "secret");
    assert!(replay["result"]["events"][0].get("jsonrpc").is_none());
    let hidden = request(
        &mut member_socket,
        "hidden",
        "session.events.since",
        json!({"session_id":"test-session","last_seen":0}),
    )
    .await;
    assert_eq!(hidden["result"]["count"], 0);
    admin.close(None).await.unwrap();
    member_socket.close(None).await.unwrap();
    fixture.shutdown().await;
}

#[tokio::test]
async fn revocation_closes_existing_socket_and_invalidates_unused_ticket() {
    let fixture = Fixture::new(false).await;
    let client = reqwest::Client::new();
    let device = auth::mint_device(&fixture.home, "Victim", "test", "local").unwrap();
    let token = device["device_token"].as_str().unwrap();
    let mut socket = fixture.socket(token).await;
    let ticket = client
        .post(format!("{}/api/auth/ws-ticket", fixture.base))
        .bearer_auth(token)
        .send()
        .await
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    fixture
        .app
        .call(
            "local",
            "hexbot.devices.revoke",
            &json!({"id":device["device_id"]}),
        )
        .await
        .unwrap();
    let close = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(Ok(Message::Close(close))) = socket.next().await {
                break close;
            }
        }
    })
    .await
    .unwrap()
    .unwrap();
    assert_eq!(u16::from(close.code), 4401);
    assert!(
        connect_async(format!(
            "{}?ticket={}",
            fixture.ws(),
            ticket["ticket"].as_str().unwrap()
        ))
        .await
        .is_err()
    );
    assert_eq!(
        client
            .post(format!("{}/hexbot/session", fixture.base))
            .bearer_auth(token)
            .send()
            .await
            .unwrap()
            .status(),
        401
    );
    fixture.shutdown().await;
}

#[cfg(unix)]
#[tokio::test]
async fn rpc_chat_and_attachment_bytes_work_without_frontend_changes() {
    let fixture = Fixture::new(false).await;
    let mut socket = fixture.socket(&fixture.token).await;
    let created = request(
        &mut socket,
        "create",
        "hexbot.bots.create",
        json!({"name":"scout","display_name":"Scout","tools":[]}),
    )
    .await;
    assert!(created.get("error").is_none(), "{created}");
    let sections = request(
        &mut socket,
        "sections",
        "hexbot.sections.list",
        json!({"bot":"scout"}),
    )
    .await;
    let stored = sections["result"]["sections"][0]["id"].as_str().unwrap();
    let opened = request(
        &mut socket,
        "open",
        "hexbot.sections.open",
        json!({"id":stored}),
    )
    .await;
    assert!(opened.get("error").is_none(), "{opened}");
    let live = opened["result"]["section"]["live_session_id"]
        .as_str()
        .unwrap();
    let attached = request(
        &mut socket,
        "attach",
        "file.attach",
        json!({"session_id":live,"name":"notes.txt","data_url":"data:text/plain;base64,aGVsbG8="}),
    )
    .await;
    assert_eq!(attached["result"]["attached"], true);
    let path = attached["result"]["path"].as_str().unwrap();
    assert!(PathBuf::from(path).starts_with(&fixture.home));
    assert_eq!(fs::read(path).unwrap(), b"hello");
    let escaped=request(&mut socket,"path","file.attach",json!({"session_id":live,"name":"../../outside.txt","data_url":"data:text/plain;base64,aGVsbG8="})).await;
    if let Some(path) = escaped["result"]["path"].as_str() {
        assert!(
            fs::canonicalize(path)
                .unwrap()
                .starts_with(fs::canonicalize(&fixture.home).unwrap())
        );
    }
    assert!(!fixture._directory.path().join("outside.txt").exists());
    assert!(
        request(
            &mut socket,
            "model",
            "config.set",
            json!({"session_id":live,"key":"model","value":"fixture/one"})
        )
        .await
        .get("error")
        .is_none()
    );
    db::open(&fixture.home)
        .unwrap()
        .execute(
            "INSERT INTO users VALUES ('other','Other','member','{}',0,NULL)",
            [],
        )
        .unwrap();
    let other = auth::mint_device(&fixture.home, "Other", "test", "other").unwrap();
    let mut other_socket = fixture
        .socket(other["device_token"].as_str().unwrap())
        .await;
    assert!(request(&mut other_socket,"foreign-attach","file.attach",json!({"session_id":live,"name":"other.txt","data_url":"data:text/plain;base64,aGVsbG8="})).await.get("error").is_some());
    other_socket.close(None).await.unwrap();
    let mut count = escaped["result"]["count"].as_u64().unwrap_or(1);
    while count < 20 {
        let result=request(&mut socket,"fill","file.attach",json!({"session_id":live,"name":"extra.txt","data_url":"data:text/plain;base64,aGVsbG8="})).await;
        assert!(result.get("error").is_none(), "{result}");
        count = result["result"]["count"].as_u64().unwrap();
    }
    let extra=request(&mut socket,"extra","file.attach",json!({"session_id":live,"name":"twenty-first.txt","data_url":"data:text/plain;base64,aGVsbG8="})).await;
    assert_eq!(
        extra["result"]["count"], 21,
        "the existing API does not impose a 20-file limit: {extra}"
    );
    let directory = std::path::Path::new(path).parent().unwrap();
    let before = fs::read_dir(directory).unwrap().count();
    assert!(
        request(
            &mut socket,
            "bad-attach",
            "file.attach",
            json!({"session_id":live,"name":"notes.txt","data_url":"data:text/plain;base64,!!!"})
        )
        .await
        .get("error")
        .is_some()
    );
    assert_eq!(
        fs::read_dir(directory).unwrap().count(),
        before,
        "invalid attachments must not write files"
    );
    socket.send(Message::Text(json!({"jsonrpc":"2.0","id":"prompt","method":"prompt.submit","params":{"session_id":live,"text":"Read the file"}}).to_string().into())).await.unwrap();
    let mut complete = false;
    let mut accepted = false;
    while !complete || !accepted {
        let frame = frame(&mut socket).await;
        if frame["id"] == "prompt" {
            assert!(frame.get("error").is_none(), "{frame}");
            accepted = true;
        }
        if frame["params"]["type"] == "message.complete" {
            complete = true;
        }
    }
    let history = request(
        &mut socket,
        "history",
        "session.history",
        json!({"session_id":live}),
    )
    .await;
    assert!(
        history["result"]["messages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["role"] == "assistant")
    );
    socket.close(None).await.unwrap();
    fixture.shutdown().await;
}

#[tokio::test]
async fn app_shutdown_closes_connected_clients_for_reconnect() {
    let fixture = Fixture::new(false).await;
    let mut socket = fixture.socket(&fixture.token).await;
    fixture.app.shutdown().await;
    let close = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(Ok(Message::Close(frame))) = socket.next().await {
                break frame;
            }
        }
    })
    .await
    .unwrap()
    .unwrap();
    assert_eq!(u16::from(close.code), 1012);
    services::shutdown(&fixture.home).await.unwrap();
}

#[tokio::test]
async fn multiline_overload_closes_instead_of_silently_dropping_requests() {
    let fixture = Fixture::new(false).await;
    let mut socket = fixture.socket(&fixture.token).await;
    let frame = (0..65)
        .map(|id| json!({"jsonrpc":"2.0","id":id,"method":"gateway.ping","params":{}}).to_string())
        .collect::<Vec<_>>()
        .join("\n");
    socket.send(Message::Text(frame.into())).await.unwrap();
    let close = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(Ok(Message::Close(frame))) = socket.next().await {
                break frame;
            }
        }
    })
    .await
    .unwrap()
    .unwrap();
    assert_eq!(u16::from(close.code), 1013);
    fixture.shutdown().await;
}

#[tokio::test]
async fn websocket_upgrade_rejects_cross_origin_even_with_valid_token() {
    let fixture = Fixture::new(false).await;
    let mut request = format!("{}?token={}", fixture.ws(), fixture.token)
        .into_client_request()
        .unwrap();
    request
        .headers_mut()
        .insert("origin", "https://attacker.example".parse().unwrap());
    assert!(connect_async(request).await.is_err());
    fixture.shutdown().await;
}

#[cfg(unix)]
#[tokio::test]
async fn attachment_transport_accepts_existing_size_ranges() {
    let fixture = Fixture::new(false).await;
    let mut socket = fixture.socket(&fixture.token).await;
    let created = request(
        &mut socket,
        "create",
        "hexbot.bots.create",
        json!({"name":"uploader","tools":[]}),
    )
    .await;
    let id = created["result"]["section"]["id"].as_str().unwrap();
    let opened = request(
        &mut socket,
        "open",
        "hexbot.sections.open",
        json!({"id":id}),
    )
    .await;
    let live = opened["result"]["section"]["live_session_id"]
        .as_str()
        .unwrap();
    // This valid generic file becomes a >16 MiB JSON-RPC frame after base64.
    let bytes = vec![b'a'; 13 * 1024 * 1024];
    let attached=request(&mut socket,"large","file.attach",json!({"session_id":live,"name":"large.txt","data_url":format!("data:text/plain;base64,{}",base64::engine::general_purpose::STANDARD.encode(&bytes))})).await;
    assert!(attached.get("error").is_none(), "{attached}");
    assert_eq!(
        fs::metadata(attached["result"]["path"].as_str().unwrap())
            .unwrap()
            .len(),
        bytes.len() as u64
    );
    // Image commands must also fit the Pi subprocess record boundary.
    let mut image = vec![0; 2 * 1024 * 1024];
    image[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
    let image=request(&mut socket,"image","image.attach_bytes",json!({"session_id":live,"filename":"image.png","content_base64":base64::engine::general_purpose::STANDARD.encode(image)})).await;
    assert!(image.get("error").is_none(), "{image}");
    socket.send(Message::Text(json!({"jsonrpc":"2.0","id":"prompt","method":"prompt.submit","params":{"session_id":live,"text":"Read these attachments"}}).to_string().into())).await.unwrap();
    let response = response(&mut socket, "prompt").await;
    assert!(response.get("error").is_none(), "{response}");
    socket.close(None).await.unwrap();
    fixture.shutdown().await;
}
