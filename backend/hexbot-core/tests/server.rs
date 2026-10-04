//! Exercise the actual HTTP/WebSocket router with the unchanged browser protocol.
mod support;
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
            axum::serve(
                listener,
                router.into_make_service_with_connect_info::<std::net::SocketAddr>(),
            )
            .await
            .unwrap();
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
    // Any local process can fetch this page, so it never carries the admin token,
    // even on a loopback daemon: the browser signs in with a cookie instead.
    assert!(html.contains("window.__HERMES_AUTH_REQUIRED__=true"));
    assert!(!html.contains(&fixture.token));
    assert!(!html.contains("__HERMES_SESSION_TOKEN__"));
    for host in [
        "localhost",
        "localhost:9119",
        "127.0.0.1:9119",
        "[::1]:9119",
    ] {
        let body = client
            .get(&fixture.base)
            .header("host", host)
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap();
        assert!(!body.contains(&fixture.token));
        assert!(!body.contains("__HERMES_SESSION_TOKEN__"));
        // The same host behind any proxy header gets the gated bundle.
        let forwarded = client
            .get(&fixture.base)
            .header("host", host)
            .header("x-forwarded-for", "10.0.0.2")
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap();
        assert!(forwarded.contains("window.__HERMES_AUTH_REQUIRED__=true"));
        assert!(!forwarded.contains(&fixture.token));
        assert!(!forwarded.contains("__HERMES_SESSION_TOKEN__"));
    }
    let redirected = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap()
        .get(&fixture.base)
        .header("accept", "text/html")
        .header("x-forwarded-for", "10.0.0.2")
        .send()
        .await
        .unwrap();
    assert_eq!(redirected.status(), 303);
    assert_eq!(redirected.headers()["location"], "/login");
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
async fn one_time_sign_in_link_signs_a_browser_in_once() {
    let fixture = Fixture::new(false).await;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    // A loopback browser without a cookie is sent to sign in like any other.
    let response = client
        .get(&fixture.base)
        .header("accept", "text/html")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 303);
    assert_eq!(response.headers()["location"], "/login");
    let code = auth::new_code(&fixture.home, "local").unwrap()["code"]
        .as_str()
        .unwrap()
        .to_owned();
    let link = format!("{}/login?code={code}&next=/b/owl", fixture.base);
    let signed = client.get(&link).send().await.unwrap();
    assert_eq!(signed.status(), 303);
    assert_eq!(signed.headers()["location"], "/b/owl");
    let cookie = signed.headers()["set-cookie"].to_str().unwrap().to_owned();
    assert!(cookie.starts_with("hermes_session_at_"));
    assert!(cookie.contains("HttpOnly"));
    let again = client.get(&link).send().await.unwrap();
    assert_eq!(again.status(), 200);
    assert!(again.headers().get("set-cookie").is_none());
    assert!(again.text().await.unwrap().contains("used or has expired"));
    // The cookie is an ordinary browser session: it loads the app and mints tickets.
    let cookie = cookie.split(';').next().unwrap().to_owned();
    let page = client
        .get(&fixture.base)
        .header("accept", "text/html")
        .header("cookie", &cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(page.status(), 200);
    let html = page.text().await.unwrap();
    assert!(html.contains("__HERMES_AUTH_REQUIRED__=true"));
    assert!(!html.contains("__HERMES_SESSION_TOKEN__"));
    let ticket = client
        .post(format!("{}/api/auth/ws-ticket", fixture.base))
        .header("cookie", &cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(ticket.status(), 200);
    let devices = auth::call(&fixture.home, "local", "hexbot.devices.list", &json!({}))
        .unwrap()
        .unwrap();
    assert!(devices["devices"].as_array().unwrap().iter().any(|device| {
        device["name"] == "Browser on this computer" && device["platform"] == "browser"
    }));
    fixture.shutdown().await;
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
        .header("x-forwarded-proto", "https")
        .bearer_auth(token)
        .send()
        .await
        .unwrap();
    assert_eq!(login.status(), 200);
    assert!(
        login.headers()["set-cookie"]
            .to_str()
            .unwrap()
            .starts_with("hermes_session_at_")
    );
    assert!(
        !login.headers()["set-cookie"]
            .to_str()
            .unwrap()
            .contains("; Secure")
    );
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
    let member = support::mint_device(&fixture.home, "Member", "test", "member").unwrap();
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
    let device = support::mint_device(&fixture.home, "Victim", "test", "local").unwrap();
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
    let other = support::mint_device(&fixture.home, "Other", "test", "other").unwrap();
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
async fn attachment_transport_accepts_supported_sizes_and_reports_oversize() {
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
    // The largest supported generic file fits as one base64 JSON-RPC frame.
    let bytes = vec![b'a'; 45 * 1024 * 1024];
    let attached=request(&mut socket,"large","file.attach",json!({"session_id":live,"name":"large.txt","data_url":format!("data:text/plain;base64,{}",base64::engine::general_purpose::STANDARD.encode(&bytes))})).await;
    assert!(attached.get("error").is_none(), "{attached}");
    assert_eq!(
        fs::metadata(attached["result"]["path"].as_str().unwrap())
            .unwrap()
            .len(),
        bytes.len() as u64
    );
    // A rejected upload fits the transport and leaves other RPCs usable.
    let oversized = "A".repeat(4 * (46usize * 1024 * 1024).div_ceil(3));
    for method in ["file.attach", "pdf.attach"] {
        let params = if method == "file.attach" {
            json!({"session_id":live,"name":"too-big.bin","data_url":format!("data:application/octet-stream;base64,{oversized}")})
        } else {
            json!({"session_id":live,"content_base64":oversized})
        };
        let rejected = request(&mut socket, "oversized", method, params).await;
        assert_eq!(rejected["error"]["code"], 4202);
        assert_eq!(rejected["error"]["message"], "attachment exceeds 45 MiB");
        assert_eq!(
            request(&mut socket, "ping", "gateway.ping", json!({})).await["result"]["pong"],
            true
        );
    }
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

#[tokio::test]
async fn websocket_disconnect_during_prompt_ack_keeps_the_section_running() {
    let fixture = Fixture::new(false).await;
    let pi = fixture._directory.path().join("fake-pi.cjs");
    fs::write(&pi,r#"#!/usr/bin/env node
const emit=v=>process.stdout.write(JSON.stringify(v)+'\n');
const rl=require('node:readline').createInterface({input:process.stdin});
let pending;
const reply=c=>emit({type:'response',id:c.id,command:c.type,success:true,data:{}});
rl.on('line',line=>{const c=JSON.parse(line);
if(c.type==='prompt'){pending=c;emit({type:'agent_start'});emit({type:'message_end',message:{role:'user',content:c.message}});return;}
reply(c);
if(c.type==='steer' && pending){reply(pending);pending=null;emit({type:'message_end',message:{role:'user',content:c.message}});emit({type:'message_end',message:{role:'assistant',content:'Completed after disconnect',stopReason:'stop'}});emit({type:'agent_settled'});}
});
"#).unwrap();
    db::open(&fixture.home).unwrap().execute_batch("INSERT INTO bots(name,owner_id) VALUES('owl','local'); INSERT INTO sections(id,bot,owner_id) VALUES('first','owl','local');").unwrap();
    fs::create_dir_all(fixture.home.join("profiles/owl")).unwrap();
    fs::write(
        fixture.home.join("profiles/owl/config.yaml"),
        "tools:\n  enabled_toolsets: []\n",
    )
    .unwrap();
    let mut socket = fixture.socket(&fixture.token).await;
    let opened = request(
        &mut socket,
        "open",
        "hexbot.sections.open",
        json!({"id":"first"}),
    )
    .await;
    let live = &opened["result"]["section"]["live_session_id"];
    assert!(live.is_string(), "{opened}");
    socket.send(Message::Text(json!({"jsonrpc":"2.0","id":"prompt","method":"prompt.submit","params":{"session_id":live,"text":"long request"}}).to_string().into())).await.unwrap();
    loop {
        if frame(&mut socket).await["params"]["type"] == "message.start" {
            break;
        }
    }
    socket.close(None).await.unwrap();
    drop(socket);
    let mut reconnected = fixture.socket(&fixture.token).await;
    // A second client releases the fake's acknowledgement barrier.
    let reply = request(
        &mut reconnected,
        "finish",
        "session.steer",
        json!({"session_id":live,"text":"finish"}),
    )
    .await;
    assert!(reply.get("error").is_none(), "{reply}");
    let history = request(
        &mut reconnected,
        "history",
        "session.history",
        json!({"session_id":live}),
    )
    .await;
    // Wait on the saved completion event if the history RPC won that race.
    if !history.to_string().contains("Completed after disconnect") {
        loop {
            if frame(&mut reconnected).await["params"]["type"] == "message.complete" {
                break;
            }
        }
    }
    let history = request(
        &mut reconnected,
        "saved",
        "session.history",
        json!({"session_id":live}),
    )
    .await;
    assert!(history.to_string().contains("Completed after disconnect"));
    fixture.shutdown().await;
}

#[tokio::test]
async fn daemon_home_is_only_returned_to_admins() {
    let fixture = Fixture::new(false).await;
    db::open(&fixture.home).unwrap().execute("INSERT INTO users(id,display_name,role,created_at) VALUES('info-member','Member','member',0)", []).unwrap();
    let member = support::mint_device(&fixture.home, "Member", "test", "info-member").unwrap();
    let mut socket = fixture
        .socket(member["device_token"].as_str().unwrap())
        .await;
    let info = request(&mut socket, "member-info", "hexbot.info", json!({})).await;
    assert_eq!(info["result"]["home"], "");
    assert!(info["result"]["install_id"].is_string());
    // The sandbox state is reported to every user, so Settings can show it.
    let sandbox = &info["result"]["sandbox"];
    if cfg!(target_os = "macos") {
        assert_eq!(sandbox, "sandbox-exec");
    } else {
        assert!(sandbox.is_null() || sandbox == "bubblewrap", "{sandbox}");
    }
    assert_eq!(info["result"]["auth_required"], true);
    socket.close(None).await.unwrap();
    let mut socket = fixture.socket(&fixture.token).await;
    assert_eq!(
        request(&mut socket, "admin-info", "hexbot.info", json!({})).await["result"]["home"],
        json!(fixture.home)
    );
    socket.close(None).await.unwrap();
    fixture.shutdown().await;
}

#[tokio::test]
async fn connect_browser_login_starts_pkce_redirect() {
    let fixture = Fixture::new(true).await;
    fs::write(fixture.home.join("connect.json"), json!({"api_base":"https://connect.hexbot.app","daemon_id":"daemon-1","daemon_token":"fixture-only","tunnel_token":"fixture-only","tunnel_hostname":"fixture.hexbot.test","owner_id":"owner-1","issuer":"https://connect.hexbot.app","keys":[{"kid":"fixture"}]}).to_string()).unwrap();
    let response = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap()
        .get(format!(
            "{}/auth/login?provider=connect&next=/",
            fixture.base
        ))
        .send()
        .await
        .unwrap();
    let status = response.status();
    let location = response.headers().get("location").cloned();
    fixture.shutdown().await;
    assert!(
        status.is_redirection() && location.is_some(),
        "Connect browser login returned {status} without a redirect"
    );
}

#[tokio::test]
async fn remote_index_and_secure_cookies_do_not_expose_local_token() {
    let fixture = Fixture::new(false).await;
    let client = reqwest::Client::new();
    let local = client
        .get(&fixture.base)
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert!(!local.contains("__HERMES_SESSION_TOKEN__"));
    assert!(!local.contains(&fixture.token));
    for header in [
        "cf-connecting-ip",
        "x-forwarded-for",
        "x-forwarded-host",
        "forwarded",
    ] {
        let body = client
            .get(&fixture.base)
            .header(header, "fixture")
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap();
        assert!(
            !body.contains("__HERMES_SESSION_TOKEN__"),
            "token leaked through {header}"
        );
    }
    hexbot_core::common::write_config(
        &fixture.home,
        &json!({"dashboard":{"public_url":"https://daemon.example"}}),
    )
    .unwrap();
    let body = client
        .get(&fixture.base)
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert!(!body.contains("__HERMES_SESSION_TOKEN__"));
    let response = client
        .post(format!("{}/hexbot/session", fixture.base))
        .bearer_auth(&fixture.token)
        .header("host", "daemon.example")
        .header("x-forwarded-proto", "https")
        .send()
        .await
        .unwrap();
    let cookie = response.headers()["set-cookie"].to_str().unwrap();
    assert!(cookie.starts_with("__Host-hermes_session_at="));
    for attribute in ["Secure", "HttpOnly", "SameSite=Strict", "Path=/"] {
        assert!(cookie.contains(attribute));
    }
    let response = client
        .post(format!("{}/api/auth/ws-ticket", fixture.base))
        .header("cookie", cookie.split(';').next().unwrap())
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let response = client
        .get(&fixture.base)
        .header("origin", "http://localhost:4321")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 403);
    let mut socket = fixture.socket(&fixture.token).await;
    assert_eq!(
        request(&mut socket, "info-version", "hexbot.info", json!({})).await["result"]["hermes_version"],
        "1.0.1"
    );
    fixture.shutdown().await;
}

#[tokio::test]
async fn browser_pkce_exchange_checks_state_and_redirects_to_same_origin() {
    use axum::{
        Json, Router,
        routing::{get, post},
    };
    use hexbot_core::common;
    use sha2::{Digest, Sha256};
    let fixture = Fixture::new(true).await;
    let (tx, mut exchanges) =
        tokio::sync::mpsc::unbounded_channel::<(axum::http::HeaderMap, Value)>();
    let claims = json!({"aud":"daemon-1","sub":"owner-1","iss":"https://connect.hexbot.app","daemon_id":"daemon-1","device_name":"Browser","jti":"browser-code","iat":common::now() as u64,"exp":common::now() as u64+300});
    let key = b"-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg/h5RZbRebJ4W8wDj\n0zi0DKNjL3NKu4LSLTr3GDLW1AuhRANCAATxLUB7ibYZJBU9qYp7mPjCc/fQfWet\nd1HBTxun6HHLoMilyIfHMI8E9KdpMIfgyZ8cQ6tCl8+s34X5gbiue9D9\n-----END PRIVATE KEY-----\n";
    let keys = json!({"keys":[{"kty":"EC","crv":"P-256","kid":"fixture","x":"8S1Ae4m2GSQVPamKe5j4wnP30H1nrXdRwU8bp-hxy6A","y":"yKXIh8cwjwT0p2kwh-DJnxxDq0KXz6zfhfmBuK570P0"}]});
    let mut header = jsonwebtoken::Header::new(jsonwebtoken::Algorithm::ES256);
    header.typ = Some("hexbot-grant+jwt".into());
    header.kid = Some("fixture".into());
    let grant = jsonwebtoken::encode(
        &header,
        &claims,
        &jsonwebtoken::EncodingKey::from_ec_pem(key).unwrap(),
    )
    .unwrap();
    let published = keys.clone();
    let broker = Router::new()
        .route(
            "/.well-known/jwks.json",
            get(move || async move { Json(published) }),
        )
        .route(
            "/api/grants/exchange",
            post(
                move |headers: axum::http::HeaderMap, Json(p): Json<Value>| {
                    let tx = tx.clone();
                    let grant = grant.clone();
                    async move {
                        tx.send((headers, p)).unwrap();
                        Json(json!({"grant":grant}))
                    }
                },
            ),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move { axum::serve(listener, broker).await.unwrap() });
    fs::write(fixture.home.join("connect.json"),json!({"api_base":base,"daemon_id":"daemon-1","daemon_token":"secret","tunnel_hostname":"fixture.test","owner_id":"owner-1","issuer":"https://connect.hexbot.app","keys":keys["keys"]}).to_string()).unwrap();
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    let providers: Value = client
        .get(format!("{}/api/auth/providers", fixture.base))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(
        providers["providers"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["name"] == "connect")
    );
    let start = client
        .get(format!(
            "{}/auth/login?provider=connect&next=//evil.test",
            fixture.base
        ))
        .header("host", "fixture.test")
        .header("x-forwarded-proto", "https")
        .send()
        .await
        .unwrap();
    assert!(start.status().is_redirection());
    let cookie = start.headers()["set-cookie"].to_str().unwrap().to_owned();
    for attribute in ["Secure", "HttpOnly", "SameSite=Lax", "Max-Age=600"] {
        assert!(cookie.contains(attribute));
    }
    let location = url::Url::parse(start.headers()["location"].to_str().unwrap()).unwrap();
    assert_eq!(location.path(), "/connect/browser");
    let query: std::collections::HashMap<_, _> = location.query_pairs().into_owned().collect();
    assert_eq!(query["daemon"], "daemon-1");
    assert_eq!(query["redirect_uri"], "https://fixture.test/auth/callback");
    let cookie = cookie.split(';').next().unwrap();
    let invalid = client
        .get(format!(
            "{}/auth/callback?code=code&state=wrong",
            fixture.base
        ))
        .header("host", "fixture.test")
        .header("cookie", cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(invalid.status(), 401);
    assert!(exchanges.try_recv().is_err());
    let callback = client
        .get(format!(
            "{}/auth/callback?code=code&state={}",
            fixture.base, query["state"]
        ))
        .header("host", "fixture.test")
        .header("cookie", cookie)
        .header("x-forwarded-proto", "https")
        .send()
        .await
        .unwrap();
    assert_eq!(callback.status(), 303);
    assert_eq!(callback.headers()["location"], "/");
    assert!(
        callback
            .headers()
            .get_all("set-cookie")
            .iter()
            .any(|c| c.to_str().unwrap().starts_with("__Host-hermes_session_at="))
    );
    let (headers, body) = exchanges.recv().await.unwrap();
    assert_eq!(headers["authorization"], "Bearer secret");
    assert_eq!(body["code"], "code");
    assert_eq!(body["redirect_uri"], query["redirect_uri"]);
    assert_eq!(
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(
            body["code_verifier"].as_str().unwrap().as_bytes()
        )),
        query["code_challenge"]
    );
    let replay = client
        .get(format!(
            "{}/auth/callback?code=code&state={}",
            fixture.base, query["state"]
        ))
        .header("host", "fixture.test")
        .header("cookie", cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(replay.status(), 401);
    assert!(exchanges.try_recv().is_err());
    task.abort();
    fixture.shutdown().await;
}

#[tokio::test]
async fn websocket_bounds_aggregate_request_bytes_while_requests_are_pending() {
    let fixture = Fixture::new(false).await;
    let (entered, mut observed) = tokio::sync::mpsc::unbounded_channel();
    let broker = axum::Router::new().route(
        "/api/register/poll",
        axum::routing::post(move || {
            let entered = entered.clone();
            async move {
                entered.send(()).unwrap();
                std::future::pending::<axum::Json<Value>>().await
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    hexbot_core::common::write_config(
        &fixture.home,
        &json!({"connect":{"api_base":format!("http://{}",listener.local_addr().unwrap())}}),
    )
    .unwrap();
    let broker = tokio::spawn(async move { axum::serve(listener, broker).await.unwrap() });
    let mut socket = fixture.socket(&fixture.token).await;
    let request = json!({"jsonrpc":"2.0","id":"large","method":"hexbot.connect.register_poll","params":{"device_code":"code","padding":"x".repeat(33*1024*1024)}}).to_string();
    socket
        .send(Message::Text(request.clone().into()))
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(10), observed.recv())
        .await
        .unwrap()
        .unwrap();
    socket.send(Message::Text(request.into())).await.unwrap();
    let close = tokio::time::timeout(Duration::from_secs(10), async {
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
    assert_eq!(close.reason, "Too many request bytes");
    broker.abort();
    fixture.shutdown().await;
}

#[tokio::test]
async fn websocket_rejects_a_message_over_64_mib() {
    let fixture = Fixture::new(false).await;
    let mut socket = fixture.socket(&fixture.token).await;
    let result = socket
        .send(Message::Text(" ".repeat(64 * 1024 * 1024 + 1).into()))
        .await;
    if result.is_ok() {
        let closed = tokio::time::timeout(Duration::from_secs(10), socket.next())
            .await
            .unwrap();
        assert!(matches!(
            closed,
            None | Some(Err(_)) | Some(Ok(Message::Close(_)))
        ));
    }
    fixture.shutdown().await;
}

#[tokio::test]
#[ignore = "run by configured_dev_origin_is_allowed"]
async fn configured_dev_origin_child() {
    let fixture = Fixture::new(false).await;
    let client = reqwest::Client::new();
    let response = client
        .get(&fixture.base)
        .header("origin", "http://localhost:45678")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(
        response.headers()["access-control-allow-origin"],
        "http://localhost:45678"
    );
    assert!(
        !response
            .text()
            .await
            .unwrap()
            .contains("__HERMES_SESSION_TOKEN__")
    );
    let rejected = client
        .get(&fixture.base)
        .header("origin", "http://localhost:45679")
        .send()
        .await
        .unwrap();
    assert_eq!(rejected.status(), 403);
    fixture.shutdown().await;
}

#[test]
fn configured_dev_origin_is_allowed() {
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--ignored",
            "--exact",
            "configured_dev_origin_child",
            "--nocapture",
        ])
        .env("HEXBOT_WEB_DEV_URL", "http://localhost:45678")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

/// A cross-site page must not redeem a link and replace an existing session
/// with a device it minted (login CSRF).
#[tokio::test]
async fn sign_in_link_ignores_cross_site_navigation_and_keeps_an_existing_session() {
    let fixture = Fixture::new(false).await;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    let code = || {
        auth::new_code(&fixture.home, "local").unwrap()["code"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    let first = code();
    let link = |code: &str| format!("{}/login?code={code}&next=/b/owl", fixture.base);
    // A navigation from another site shows the form and leaves the code unspent.
    let foreign = client
        .get(link(&first))
        .header("sec-fetch-site", "cross-site")
        .header("referer", "https://evil.test/")
        .send()
        .await
        .unwrap();
    assert_eq!(foreign.status(), 200);
    assert!(foreign.headers().get("set-cookie").is_none());
    let html = foreign.text().await.unwrap();
    assert!(html.contains("Sign-in links work only when opened directly."));
    assert!(!html.contains("used or has expired"));
    for site in ["same-site", "cross-site"] {
        let page = client
            .get(link(&first))
            .header("sec-fetch-site", site)
            .send()
            .await
            .unwrap();
        assert_eq!(page.status(), 200, "{site}");
    }
    // The same link opened from the terminal (none) or the app itself still signs in.
    let signed = client
        .get(link(&first))
        .header("sec-fetch-site", "none")
        .send()
        .await
        .unwrap();
    assert_eq!(signed.status(), 303);
    let cookie = signed.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    // A signed-in browser is sent on without redeeming or replacing its session.
    let second = code();
    for site in [None, Some("cross-site")] {
        let mut request = client.get(link(&second)).header("cookie", &cookie);
        if let Some(site) = site {
            request = request.header("sec-fetch-site", site);
        }
        let kept = request.send().await.unwrap();
        assert_eq!(kept.status(), 303);
        assert_eq!(kept.headers()["location"], "/b/owl");
        assert!(kept.headers().get("set-cookie").is_none());
    }
    let fresh = client
        .get(link(&second))
        .header("sec-fetch-site", "same-origin")
        .send()
        .await
        .unwrap();
    assert_eq!(fresh.status(), 303);
    assert!(fresh.headers().contains_key("set-cookie"));
    fixture.shutdown().await;
}

#[tokio::test]
async fn login_link_rate_limit_has_a_distinct_notice() {
    let fixture = Fixture::new(false).await;
    let client = reqwest::Client::new();
    for _ in 0..10 {
        let page = client
            .get(format!("{}/login?code=invalid", fixture.base))
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap();
        assert!(page.contains("used or has expired"));
    }
    let page = client
        .get(format!("{}/login?code=invalid", fixture.base))
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert!(page.contains("Too many attempts. Wait a minute and try again."));
    assert!(!page.contains("used or has expired"));
    fixture.shutdown().await;
}
#[tokio::test]
async fn plain_cookies_are_scoped_by_daemon_port_and_accept_upgrade_cookies() {
    let first = Fixture::new(false).await;
    let second = Fixture::new(false).await;
    let client = reqwest::Client::new();
    let cookie = |fixture: &Fixture| {
        format!(
            "hermes_session_at_{}={}",
            fixture.base.rsplit(':').next().unwrap(),
            fixture.token
        )
    };
    let path = format!("{}/api/auth/ws-ticket", first.base);
    assert_eq!(
        client
            .post(&path)
            .header("cookie", cookie(&second))
            .send()
            .await
            .unwrap()
            .status(),
        401
    );
    let both = format!("{}; {}", cookie(&second), cookie(&first));
    assert_eq!(
        client
            .post(&path)
            .header("cookie", both)
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    assert_eq!(
        client
            .post(&path)
            .header("cookie", format!("hermes_session_at={}", first.token))
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    first.shutdown().await;
    second.shutdown().await;
}

#[tokio::test]
async fn private_threads_open_with_hidden_questions_for_the_owner_only() {
    let fixture = Fixture::new(false).await;
    db::open(&fixture.home).unwrap().execute_batch("INSERT INTO users(id,display_name,role,created_at) VALUES('other','Other','member',0); INSERT INTO bots(name,owner_id,description) VALUES('owl','local','Reviews code'); INSERT INTO sections(id,bot,owner_id,title,peer_bot) VALUES('private-thread','owl','local','From Cat','cat');").unwrap();
    fs::create_dir_all(fixture.home.join("profiles/owl")).unwrap();
    fs::write(
        fixture.home.join("profiles/owl/config.yaml"),
        "tools:\n  enabled_toolsets: []\n",
    )
    .unwrap();
    hexbot_core::runtime_store::append(
        &fixture.home,
        "private-thread",
        json!({"role":"user","text":"@cat: Review this code","display_kind":"hidden"}),
    )
    .unwrap();
    let opened = fixture
        .app
        .call(
            "local",
            "hexbot.sections.open",
            &json!({"id":"private-thread"}),
        )
        .await
        .unwrap();
    assert_eq!(opened["section"]["peer_bot"], "cat");
    assert_eq!(opened["messages"][0]["text"], "@cat: Review this code");
    assert_eq!(opened["messages"][0]["display_kind"], "hidden");
    assert_eq!(
        fixture
            .app
            .call(
                "other",
                "hexbot.sections.open",
                &json!({"id":"private-thread"})
            )
            .await
            .unwrap_err()
            .code,
        4302
    );
    fixture.shutdown().await;
}

#[tokio::test]
async fn description_startup_and_catalog_triggers_do_not_block_rpc_replies() {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    let home = support::TestHome::new();
    let h = home.path();
    db::migrate(h).unwrap();
    db::open(h).unwrap().execute_batch("INSERT INTO bots(name,owner_id,description) VALUES('seed','local',''),('updated','local','User description'),('configured','local','User description');").unwrap();
    for bot in ["seed", "updated", "configured"] {
        fs::create_dir_all(h.join("profiles").join(bot)).unwrap();
        fs::write(
            h.join("profiles").join(bot).join("config.yaml"),
            "tools:\n  enabled_toolsets: []\n",
        )
        .unwrap();
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let script = h.join("descriptions.cjs");
    fs::write(&script, format!(r#"#!/usr/bin/env node
const net=require('node:net'),rl=require('node:readline').createInterface({{input:process.stdin}});
const emit=v=>process.stdout.write(JSON.stringify(v)+'\n');
rl.on('line',line=>{{const c=JSON.parse(line);emit({{type:'response',id:c.id,command:c.type,success:true,data:{{}}}});if(c.type==='prompt'){{const socket=net.connect({port},'127.0.0.1',()=>socket.write(c.message+'\n'));socket.once('data',()=>{{emit({{type:'message_end',message:{{role:'assistant',content:[{{type:'text',text:'Helps with code.'}}]}}}});emit({{type:'agent_settled'}});socket.end();}});}}}});
"#)).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&script, fs::Permissions::from_mode(0o700)).unwrap();
    }
    let app = App::new(h.into(), "127.0.0.1:0".parse().unwrap(), script, None).unwrap();
    let mut pending = vec![];
    async fn refresh(
        listener: &tokio::net::TcpListener,
    ) -> (Value, BufReader<tokio::net::TcpStream>) {
        tokio::time::timeout(Duration::from_secs(5), async {
            let (socket, _) = listener.accept().await.unwrap();
            let mut socket = BufReader::new(socket);
            let mut line = String::new();
            socket.read_line(&mut line).await.unwrap();
            (serde_json::from_str(&line).unwrap(), socket)
        })
        .await
        .unwrap()
    }
    let (profile, socket) = refresh(&listener).await;
    assert_eq!(profile["name"], "seed");
    pending.push(socket);
    for (method, params, name) in [
        (
            "hexbot.bots.create",
            json!({"name":"created","description":"","tools":[]}),
            "created",
        ),
        (
            "hexbot.bots.update",
            json!({"name":"updated","description":""}),
            "updated",
        ),
        (
            "profiles.configure",
            json!({"name":"configured","description":""}),
            "configured",
        ),
    ] {
        tokio::time::timeout(Duration::from_secs(5), app.call("local", method, &params))
            .await
            .unwrap()
            .unwrap();
        let (profile, socket) = refresh(&listener).await;
        assert_eq!(profile["name"], name);
        pending.push(socket);
    }
    for mut socket in pending {
        socket.get_mut().write_all(b"finish\n").await.unwrap();
        let mut end = String::new();
        tokio::time::timeout(Duration::from_secs(5), socket.read_line(&mut end))
            .await
            .unwrap()
            .unwrap();
    }
    app.shutdown().await;
}

#[path = "fixtures/dpop.rs"]
mod dpop_fixture;

#[tokio::test]
async fn bound_devices_require_proofs_on_every_token_entry_point() {
    use dpop_fixture::{claims, proof};
    let f = Fixture::new(true).await;
    let client = reqwest::Client::new();
    for route in ["/hexbot/pair", "/auth/password-login"] {
        let code = auth::new_code(&f.home, "local").unwrap();
        let url = format!("{}{route}", f.base);
        let body = if route == "/hexbot/pair" {
            json!({"code":code["code"],"device_name":"proof app","platform":"app"})
        } else {
            json!({"password":code["code"],"username":"proof app"})
        };
        let response = client
            .post(&url)
            .header("DPoP", proof(&claims("POST", &url, None)))
            .json(&body)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        let device: Value = response.json().await.unwrap();
        let token = device["device_token"].as_str().unwrap();
        let stored = auth::verify_token(&f.home, token).unwrap().unwrap();
        assert_eq!(
            stored["jkt"],
            hexbot_core::dpop::token_hash(&dpop_fixture::jwk().to_string())
        );
        for path in ["/api/auth/ws-ticket", "/hexbot/session"] {
            let url = format!("{}{path}", f.base);
            for cookie in [false, true] {
                let request = client.post(&url);
                let request = if cookie {
                    request.header("Cookie", format!("hermes_session_at={token}"))
                } else {
                    request.bearer_auth(token)
                };
                assert_eq!(request.send().await.unwrap().status(), 401);
            }
            let signed = proof(&claims("POST", &url, Some(token)));
            assert_eq!(
                client
                    .post(&url)
                    .bearer_auth(token)
                    .header("DPoP", &signed)
                    .send()
                    .await
                    .unwrap()
                    .status(),
                200
            );
            assert_eq!(
                client
                    .post(&url)
                    .bearer_auth(token)
                    .header("DPoP", &signed)
                    .send()
                    .await
                    .unwrap()
                    .status(),
                401
            );
            // A forwarded host cannot validate a proof for a different authority.
            let wrong = proof(&claims(
                "POST",
                &format!("https://evil.test{path}"),
                Some(token),
            ));
            assert_eq!(
                client
                    .post(&url)
                    .bearer_auth(token)
                    .header("DPoP", wrong)
                    .header("X-Forwarded-Host", "evil.test")
                    .header("Forwarded", "host=evil.test;proto=https")
                    .send()
                    .await
                    .unwrap()
                    .status(),
                401
            );
        }
        for mode in ["query", "bearer", "cookie"] {
            let ws_url = if mode == "query" {
                format!("{}?token={token}", f.ws())
            } else {
                f.ws()
            };
            let mut request = ws_url.into_client_request().unwrap();
            if mode == "bearer" {
                request
                    .headers_mut()
                    .insert("authorization", format!("Bearer {token}").parse().unwrap());
            }
            if mode == "cookie" {
                request.headers_mut().insert(
                    "cookie",
                    format!("hermes_session_at={token}").parse().unwrap(),
                );
            }
            assert!(connect_async(request.clone()).await.is_err());
            request.headers_mut().insert(
                "dpop",
                proof(&claims("GET", &format!("{}/api/ws", f.base), Some(token)))
                    .parse()
                    .unwrap(),
            );
            let (mut socket, _) = connect_async(request).await.unwrap();
            assert!(socket.next().await.unwrap().is_ok());
            socket.close(None).await.unwrap();
        }
        let url = format!("{}/api/auth/ws-ticket", f.base);
        let ticket: Value = client
            .post(&url)
            .bearer_auth(token)
            .header("DPoP", proof(&claims("POST", &url, Some(token))))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let ws = format!("{}?ticket={}", f.ws(), ticket["ticket"].as_str().unwrap());
        let (mut socket, _) = connect_async(&ws).await.unwrap();
        assert!(socket.next().await.unwrap().is_ok());
        assert!(connect_async(&ws).await.is_err());
        socket.close(None).await.unwrap();
    }
    // Old/local tokens still use bearer or cookie authentication without a proof.
    for path in ["/api/auth/ws-ticket", "/hexbot/session"] {
        assert_eq!(
            client
                .post(format!("{}{path}", f.base))
                .bearer_auth(&f.token)
                .send()
                .await
                .unwrap()
                .status(),
            200
        );
    }
}

#[path = "fixtures/connect_mock.rs"]
#[allow(dead_code)]
mod connect_mock;
use hexbot_core::common;

#[tokio::test]
async fn connect_login_requires_the_grants_key_and_token_hash() {
    use dpop_fixture::{claims, proof};
    let f = Fixture::new(true).await;
    let mock = connect_mock::Mock::new().await;
    mock.persist_registration(&f.home);
    let jkt = hexbot_core::dpop::token_hash(&dpop_fixture::jwk().to_string());
    let grant = dpop_fixture::grant(
        &json!({"sub":"cloud-user","iss":"https://connect.hexbot.app","aud":"daemon-1","jti":"bound-grant","daemon_id":"daemon-1","device_name":"proof app","iat":common::now() as i64,"exp":common::now() as i64+300,"cnf":{"jkt":jkt}}),
    );
    let token = format!("cg_{grant}");
    let url = format!("{}/auth/password-login", f.base);
    let body = json!({"provider":"hexbot","username":"proof app","password":token});
    let client = reqwest::Client::new();
    assert_eq!(
        client.post(&url).json(&body).send().await.unwrap().status(),
        401
    );
    assert_eq!(
        client
            .post(&url)
            .json(&body)
            .header("DPoP", proof(&claims("POST", &url, None)))
            .send()
            .await
            .unwrap()
            .status(),
        401
    );
    assert_eq!(
        client
            .post(&url)
            .json(&body)
            .header("DPoP", proof(&claims("POST", &url, Some(&grant))))
            .send()
            .await
            .unwrap()
            .status(),
        401
    );
    let response = client
        .post(&url)
        .json(&body)
        .header("DPoP", proof(&claims("POST", &url, Some(&token))))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let device: Value = response.json().await.unwrap();
    assert_eq!(
        auth::verify_token(&f.home, device["device_token"].as_str().unwrap())
            .unwrap()
            .unwrap()["jkt"],
        jkt
    );
}

#[tokio::test]
async fn remote_browser_without_key_storage_keeps_a_cookie_only_session() {
    let f = Fixture::new(true).await;
    let code = auth::new_code(&f.home, "local").unwrap();
    let client = reqwest::Client::new();
    let response = client.post(format!("{}/auth/password-login", f.base))
        .json(&json!({"username":"remote browser","password":code["code"],"return_token":true,"next":"/settings"}))
        .send().await.unwrap();
    assert_eq!(response.status(), 200);
    let cookie = response.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let body: Value = response.json().await.unwrap();
    assert!(body.get("device_token").is_none());
    assert_eq!(body["next"], "/settings");
    assert_eq!(
        client
            .post(format!("{}/api/auth/ws-ticket", f.base))
            .header("Cookie", cookie)
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
}

#[tokio::test]
async fn proof_errors_are_distinct_and_do_not_touch_last_seen() {
    use dpop_fixture::{claims, proof};
    let f = Fixture::new(true).await;
    let client = reqwest::Client::new();
    let code = auth::new_code(&f.home, "local").unwrap();
    let login = format!("{}/auth/password-login", f.base);
    let response = client
        .post(&login)
        .json(&json!({"password":code["code"],"next":"/settings"}))
        .header("DPoP", proof(&claims("POST", &login, None)))
        .send()
        .await
        .unwrap();
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["next"], "/settings");
    let token = body["device_token"].as_str().unwrap();
    let conn = db::open(&f.home).unwrap();
    conn.execute(
        "UPDATE devices SET last_seen_at=0 WHERE id=?",
        [body["device_id"].as_str().unwrap()],
    )
    .unwrap();
    let ticket = format!("{}/api/auth/ws-ticket", f.base);
    let mut stale = claims("POST", &ticket, Some(token));
    stale["iat"] = json!(common::now() as i64 - 600);
    for (proof_value, expected) in [
        (None, "dpop_proof_required"),
        (Some(proof(&stale)), "dpop_clock_skew"),
    ] {
        let mut request = client.post(&ticket).bearer_auth(token);
        if let Some(proof_value) = proof_value {
            request = request.header("DPoP", proof_value);
        }
        let response = request.send().await.unwrap();
        assert_eq!(response.status(), 401);
        assert_eq!(
            response.headers()["www-authenticate"],
            "DPoP error=\"invalid_dpop_proof\""
        );
        let error: Value = response.json().await.unwrap();
        assert_eq!(error["code"], expected);
        if expected == "dpop_clock_skew" {
            assert!(
                error["server_time"].as_i64().unwrap() - error["proof_time"].as_i64().unwrap()
                    >= 600
            );
        }
        assert_eq!(
            conn.query_row(
                "SELECT last_seen_at FROM devices WHERE id=?",
                [body["device_id"].as_str().unwrap()],
                |r| r.get::<_, f64>(0)
            )
            .unwrap(),
            0.
        );
    }
    for _ in 0..1024 {
        assert_eq!(
            client
                .post(&ticket)
                .bearer_auth(token)
                .header("DPoP", proof(&claims("POST", &ticket, Some(token))))
                .send()
                .await
                .unwrap()
                .status(),
            200
        );
    }
    let full = client
        .post(&ticket)
        .bearer_auth(token)
        .header("DPoP", proof(&claims("POST", &ticket, Some(token))))
        .send()
        .await
        .unwrap();
    assert_eq!(full.status(), 503);
    assert_eq!(full.headers()["retry-after"], "1");
    assert_eq!(
        full.json::<Value>().await.unwrap()["code"],
        "dpop_cache_full"
    );
    // A full proof cache cannot block a new login with a single-use code.
    let code = auth::new_code(&f.home, "local").unwrap();
    assert_eq!(
        client
            .post(&login)
            .json(&json!({"password":code["code"]}))
            .header("DPoP", proof(&claims("POST", &login, None)))
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
}

#[tokio::test]
async fn device_storage_failure_is_not_revocation() {
    let f = Fixture::new(true).await;
    let conn = db::open(&f.home).unwrap();
    conn.execute("ALTER TABLE devices RENAME TO unavailable_devices", [])
        .unwrap();
    let response = reqwest::Client::new()
        .post(format!("{}/api/auth/ws-ticket", f.base))
        .bearer_auth(&f.token)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 500);
    assert!(response.headers().get("www-authenticate").is_none());
    conn.execute("ALTER TABLE unavailable_devices RENAME TO devices", [])
        .unwrap();
}

#[tokio::test]
async fn connect_identity_is_public_host_bound_and_validates_nonces() {
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use ring::signature::{ED25519, Ed25519KeyPair, KeyPair, UnparsedPublicKey};
    let fixture = Fixture::new(true).await;
    let client = reqwest::Client::new();
    let nonce = URL_SAFE_NO_PAD.encode([7u8; 32]);
    let url = format!("{}/api/connect/identity?nonce={nonce}", fixture.base);
    assert_eq!(client.get(&url).send().await.unwrap().status(), 404);
    let pkcs8 = Ed25519KeyPair::generate_pkcs8(&ring::rand::SystemRandom::new()).unwrap();
    let key = Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).unwrap();
    hexbot_core::common::atomic_write(
        &fixture.home.join("connect.json"),
        &serde_json::to_vec(&json!({"daemon_id":"daemon-1","daemon_token":"secret",
            "owner_id":"owner","issuer":"https://connect.hexbot.app","keys":[{}],
            "tunnel_hostname":"owl.example"}))
        .unwrap(),
    )
    .unwrap();
    fs::write(
        fixture.home.join("connect-identity.key"),
        URL_SAFE_NO_PAD.encode(pkcs8.as_ref()),
    )
    .unwrap();
    // HTML Accept must not turn this public endpoint into a login redirect.
    for (host, normalized) in [
        ("OWL.Example.:443", "owl.example"),
        ("OWL.Example:80", "owl.example"),
        ("localhost:9119", "localhost:9119"),
        ("[::1]:9119", "[::1]:9119"),
    ] {
        let response = client
            .get(&url)
            .header("Host", host)
            .header("Origin", "http://localhost:5173")
            .header("Accept", "text/html")
            .header("X-Forwarded-Host", "evil.example")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        assert_eq!(response.headers()["cache-control"], "no-store");
        assert_eq!(response.headers()["access-control-allow-origin"], "*");
        assert!(
            !response
                .headers()
                .contains_key("access-control-allow-credentials")
        );
        let body: Value = response.json().await.unwrap();
        assert_eq!(body["daemon_id"], "daemon-1");
        assert_eq!(
            body["public_key"],
            URL_SAFE_NO_PAD.encode(key.public_key().as_ref())
        );
        let signature = URL_SAFE_NO_PAD
            .decode(body["signature"].as_str().unwrap())
            .unwrap();
        let verifier = UnparsedPublicKey::new(&ED25519, key.public_key());
        verifier
            .verify(
                format!("hexbot-identity-v1\ndaemon-1\n{normalized}\n{nonce}").as_bytes(),
                &signature,
            )
            .unwrap();
        assert!(
            verifier
                .verify(
                    format!("hexbot-identity-v1\ndaemon-1\nother.example\n{nonce}").as_bytes(),
                    &signature
                )
                .is_err()
        );
    }
    for origin in ["http://localhost:5173", "https://other-daemon.example"] {
        let preflight = client
            .request(reqwest::Method::OPTIONS, &url)
            .header("Origin", origin)
            .header("Access-Control-Request-Method", "GET")
            .send()
            .await
            .unwrap();
        assert_eq!(preflight.status(), 204);
        assert_eq!(preflight.headers()["access-control-allow-origin"], "*");
        assert!(
            !preflight
                .headers()
                .contains_key("access-control-allow-credentials")
        );
        assert_eq!(
            client
                .get(format!("{}/api/auth/providers", fixture.base))
                .header("Origin", origin)
                .send()
                .await
                .unwrap()
                .status(),
            403
        );
        assert_eq!(
            client
                .post(&url)
                .header("Origin", origin)
                .send()
                .await
                .unwrap()
                .status(),
            403
        );
    }
    for nonce in [
        "".to_owned(),
        "%%%".to_owned(),
        URL_SAFE_NO_PAD.encode([0u8; 15]),
        URL_SAFE_NO_PAD.encode([0u8; 65]),
        format!("{}=", URL_SAFE_NO_PAD.encode([0u8; 16])),
    ] {
        assert_eq!(
            client
                .get(format!("{}/api/connect/identity", fixture.base))
                .query(&[("nonce", nonce)])
                .send()
                .await
                .unwrap()
                .status(),
            400
        );
    }
    for size in [16, 64] {
        assert_eq!(
            client
                .get(format!("{}/api/connect/identity", fixture.base))
                .query(&[("nonce", URL_SAFE_NO_PAD.encode(vec![0u8; size]))])
                .send()
                .await
                .unwrap()
                .status(),
            200
        );
    }
    fixture.shutdown().await;
}
