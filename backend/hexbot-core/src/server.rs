use crate::{
    Error, Result, auth, catalog, common, connectors, db,
    events::EventHub,
    memory::MemoryStore,
    providers,
    rooms::{self, RoomEngine},
    runtime::Runtime,
    services, settings,
};
use axum::{
    Json, Router,
    extract::{
        DefaultBodyLimit, Query, State, WebSocketUpgrade,
        ws::{CloseFrame, Message, WebSocket},
    },
    http::{HeaderMap, HeaderValue, StatusCode},
    response::{Html, IntoResponse, Response},
    routing::{get, post},
};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    net::SocketAddr,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};

pub struct App {
    pub home: PathBuf,
    pub events: EventHub,
    pub runtime: Arc<Runtime>,
    pub rooms: Arc<RoomEngine>,
    pub dreaming: Arc<crate::dreaming::Dreaming>,
    memory: MemoryStore,
    tickets: Mutex<HashMap<String, (String, f64)>>,
    pub address: SocketAddr,
    pub web_dist: Option<PathBuf>,
    stop: tokio::sync::watch::Sender<bool>,
}
// A CLI request owns its hidden run even if the WebSocket disappears mid-turn.
struct HiddenRun {
    runtime: Arc<Runtime>,
    owner: String,
    stored: String,
}
impl Drop for HiddenRun {
    fn drop(&mut self) {
        let runtime = self.runtime.clone();
        let owner = self.owner.clone();
        let stored = self.stored.clone();
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move {
                let _ = runtime.close_stored(&owner, &stored).await;
            });
        }
    }
}
impl App {
    pub fn new(
        home: PathBuf,
        address: SocketAddr,
        pi: PathBuf,
        web_dist: Option<PathBuf>,
    ) -> Result<Arc<Self>> {
        db::migrate(&home)?;
        db::open(&home)?.execute("UPDATE sections SET last_live_session_id=NULL", [])?;
        let events = EventHub::new();
        let runtime = Runtime::new(home.clone(), events.clone(), pi)?;
        let rooms = Arc::new(RoomEngine::new(
            home.clone(),
            runtime.clone(),
            events.clone(),
        ));
        let dreaming =
            crate::dreaming::Dreaming::new(home.clone(), runtime.clone(), events.clone());
        auth::local_token(&home)?;
        let (stop, _) = tokio::sync::watch::channel(false);
        Ok(Arc::new(Self {
            memory: MemoryStore::new(home.clone()),
            home,
            events,
            runtime,
            rooms,
            dreaming,
            tickets: Mutex::new(HashMap::new()),
            address,
            web_dist,
            stop,
        }))
    }
    pub async fn call(self: &Arc<Self>, owner: &str, method: &str, p: &Value) -> Result<Value> {
        if *self.stop.borrow() {
            return Err(Error::new(5200, "Daemon is restarting"));
        }
        common::user(&self.home, owner)?;
        let mut affected_rooms = Vec::new();
        // Capture the session before removing the last bot cascades room metadata.
        let removed_sessions = if method == "hexbot.rooms.remove_member" {
            let room = common::required(p, "id")?;
            rooms::get(&self.home, owner, room, false)?;
            common::rows(
                &db::open(&self.home)?,
                "SELECT stored_session_id FROM room_sessions WHERE room_id=? AND bot=?",
                &[&room, &common::required(p, "bot")?],
            )?
        } else {
            Vec::new()
        };
        if method == "hexbot.sections.delete" {
            let stored = common::required(p, "id")?;
            catalog::section(&self.home, owner, stored)?;
            self.runtime.close_stored(owner, stored).await?;
        }
        if method == "hexbot.bots.delete" {
            let bot = common::required(p, "name")?;
            common::bot_owner(&self.home, owner, bot)?;
            let sessions = common::rows(
                &db::open(&self.home)?,
                "SELECT id,owner_id FROM sections WHERE bot=?1 UNION SELECT s.stored_session_id AS id,r.owner_id FROM room_sessions s JOIN rooms r ON r.id=s.room_id WHERE s.bot=?1",
                &[&bot],
            )?;
            let running: bool = db::open(&self.home)?.query_row(
                "SELECT EXISTS(SELECT 1 FROM room_turns WHERE bot=? AND status='running')",
                [bot],
                |r| r.get(0),
            )?;
            let busy = self.runtime.busy_sections(bot);
            if running || !busy.is_empty() {
                let sections = busy
                    .iter()
                    .map(|s| json!({"id":s["id"],"status":s["status"]}))
                    .collect::<Vec<_>>();
                return Err(
                    Error::new(4211, format!("bot {bot} has a streaming section"))
                        .with_data(json!({"sections":sections})),
                );
            }
            affected_rooms = common::rows(
                &db::open(&self.home)?,
                "SELECT r.id,r.owner_id FROM rooms r JOIN room_members m ON m.room_id=r.id WHERE m.member_kind='bot' AND m.member_id=? AND m.left_at IS NULL",
                &[&bot],
            )?;
            for room in &affected_rooms {
                self.rooms
                    .stop_internal(room["id"].as_str().unwrap_or(""))
                    .await?;
            }
            for session in sessions {
                let stored = session["id"].as_str().unwrap_or("");
                self.runtime
                    .close_stored(session["owner_id"].as_str().unwrap_or(""), stored)
                    .await?;
                crate::runtime_store::delete(&self.home, stored)?;
            }
        }
        let result = match method {
            "hexbot.cli.send" => {
                let bot = common::required(p, "bot")?;
                common::bot_owner(&self.home, owner, bot)?;
                let stored = format!("cli-{}", common::id());
                let _run = HiddenRun {
                    runtime: self.runtime.clone(),
                    owner: owner.to_owned(),
                    stored: stored.clone(),
                };
                let live = self.runtime.ensure_hidden(owner, bot, &stored).await?;
                self.events.emit(
                    owner,
                    Some(&live),
                    "hexbot.cli.session",
                    json!({"request_id":p["request_id"]}),
                );
                let answer = self
                    .runtime
                    .run_hidden_job(
                        owner,
                        bot,
                        &stored,
                        common::required(p, "text")?,
                        &json!({}),
                    )
                    .await;
                let _ = self.runtime.close_stored(owner, &stored).await;
                answer.map(|text| json!({"text":text}))
            }
            "gateway.ping" => Ok(json!({"pong":true,"timestamp":common::now()})),
            "gateway.capabilities" => Ok(
                json!({"heartbeat":true,"change_events":true,"replay_epoch":self.events.epoch()}),
            ),
            "session.events.since" => Ok(self.events.since(
                owner,
                common::required(p, "session_id")?,
                p["last_seen"].as_u64().unwrap_or(0),
            )),
            "hexbot.info" => Ok(
                json!({"version":crate::version(),"hermes_version":null,"daemon_name":hostname(),"install_id":self.install_id()?,"auth_required":!self.address.ip().is_loopback(),"pairing_supported":true,"update_capability":std::env::var("HEXBOT_SUPERVISOR").ok().filter(|s|matches!(s.as_str(),"desktop"|"service")),"lan_enabled":settings::get(&self.home)?["lan_enabled"],"addresses":self.addresses(),"platform":std::env::consts::OS,"home":self.home}),
            ),
            "hexbot.rooms.stop" => {
                Ok(json!({"stopped":self.rooms.stop(owner,common::required(p,"id")?).await?}))
            }
            _ => {
                if method == "hexbot.rooms.delete" || method == "hexbot.rooms.archive" {
                    self.rooms.stop(owner, common::required(p, "id")?).await?;
                }
                if let Some(result) = self.dreaming.call(owner, method, p).await {
                    result
                } else if let Some(result) = self.runtime.call(owner, method, p).await {
                    result
                } else if crate::rpc::METHODS.contains(&method) {
                    crate::rpc::call(&self.memory, owner, method, p)
                } else if let Some(result) = auth::call(&self.home, owner, method, p) {
                    result
                } else if let Some(result) = catalog::call(&self.home, owner, method, p) {
                    result
                } else if let Some(result) = settings::call(&self.home, owner, method, p) {
                    result
                } else if let Some(result) = rooms::call(&self.home, owner, method, p) {
                    result
                } else if let Some(result) = connectors::call(&self.home, owner, method, p).await {
                    result
                } else if let Some(result) = providers::call(&self.home, owner, method, p).await {
                    result
                } else if let Some(result) = services::call(&self.home, owner, method, p).await {
                    result
                } else {
                    Err(Error::new(-32601, format!("unknown method: {method}")))
                }
            }
        }?;
        let mut result = result;
        if method == "hexbot.rooms.remove_member" {
            let room = common::required(p, "id")?;
            self.rooms.stop_internal(room).await?;
            for session in removed_sessions {
                self.runtime
                    .close_stored(owner, session["stored_session_id"].as_str().unwrap_or(""))
                    .await?;
            }
            db::open(&self.home)?.execute(
                "UPDATE room_sessions SET live_session_id=NULL WHERE room_id=? AND bot=?",
                rusqlite::params![room, common::required(p, "bot")?],
            )?;
        }
        if method == "hexbot.bots.update" && p["shareable"] == false {
            let bot = common::required(p, "name")?;
            // Unsharing preserves membership and history, but revokes active execution.
            let rooms = common::rows(
                &db::open(&self.home)?,
                "SELECT r.id,r.owner_id FROM rooms r JOIN room_members m ON m.room_id=r.id WHERE m.member_kind='bot' AND m.member_id=? AND m.left_at IS NULL AND r.owner_id<>?",
                &[&bot, &owner],
            )?;
            for room in rooms {
                let id = room["id"].as_str().unwrap_or("");
                let owner = room["owner_id"].as_str().unwrap_or("");
                self.rooms.stop_internal(id).await?;
                let sessions = common::rows(
                    &db::open(&self.home)?,
                    "SELECT stored_session_id FROM room_sessions WHERE room_id=? AND bot=?",
                    &[&id, &bot],
                )?;
                for session in sessions {
                    self.runtime
                        .close_stored(owner, session["stored_session_id"].as_str().unwrap_or(""))
                        .await?;
                }
                db::open(&self.home)?.execute(
                    "UPDATE room_sessions SET live_session_id=NULL WHERE room_id=? AND bot=?",
                    rusqlite::params![id, bot],
                )?;
                affected_rooms.push(room);
            }
        }
        if method == "hexbot.pairing.code" {
            let code = result["code"].as_str().unwrap_or("");
            result["link"] = json!(format!(
                "hexbot://pair?host={}&port={}#code={code}",
                self.addresses()
                    .first()
                    .cloned()
                    .unwrap_or_else(|| self.address.ip().to_string()),
                self.address.port()
            ));
            result["addresses"] = json!(self.addresses());
        }
        if method == "hexbot.network.get" || method == "hexbot.network.set" {
            result["port"] = json!(self.address.port());
            if method == "hexbot.network.set" {
                result["restarting"] = json!(true);
            } else {
                result["bind_host"] = json!(self.address.ip().to_string());
            }
        }
        if method == "hexbot.rooms.send" {
            let id = common::required(p, "id")?;
            self.events.emit(
                owner,
                None,
                "hexbot.rooms.event",
                json!({"room_id":id,"event":result["event"]}),
            );
            self.rooms.notify(owner, id).await?;
        }
        if matches!(
            method,
            "hexbot.rooms.add_member" | "hexbot.rooms.remove_member"
        ) && result["event"].is_object()
        {
            let event = result.as_object_mut().unwrap().remove("event").unwrap();
            self.events.emit(
                owner,
                None,
                "hexbot.rooms.event",
                json!({"room_id":p["id"],"event":event}),
            );
        }
        if method == "hexbot.bots.list" {
            if let Some(bots) = result["bots"].as_array_mut() {
                for bot in bots {
                    self.bot_status(owner, bot);
                }
            }
        } else if method == "hexbot.bots.get" {
            self.bot_status(owner, &mut result["bot"]);
        }
        self.changed(owner, method, p, &result);
        for room in affected_rooms {
            self.events.emit(
                room["owner_id"].as_str().unwrap_or(""),
                None,
                "hexbot.rooms.changed",
                json!({"id":room["id"]}),
            );
        }
        Ok(result)
    }
    pub async fn shutdown(&self) {
        self.stop.send_replace(true);
        self.rooms.shutdown().await;
        self.dreaming.shutdown().await;
        self.runtime.shutdown().await;
    }
    fn addresses(&self) -> Vec<String> {
        settings::network(&self.home)
            .ok()
            .and_then(|v| v["addresses"].as_array().cloned())
            .unwrap_or_default()
            .into_iter()
            .filter_map(|v| v.as_str().map(str::to_owned))
            .collect()
    }
    fn bot_status(&self, owner: &str, bot: &mut Value) {
        if bot["status"] == "stopped" {
            return;
        }
        if let Some(status) = bot["name"]
            .as_str()
            .and_then(|name| self.runtime.status_for_bot(owner, name))
        {
            bot["status"] = status["status"].clone();
            bot["status_detail"] = status["status_detail"].clone();
        }
    }
    fn install_id(&self) -> Result<String> {
        let path = self.home.join("install-id");
        if let Ok(value) = std::fs::read_to_string(&path) {
            return Ok(value.trim().to_owned());
        }
        let id = common::id();
        common::atomic_write(&path, id.as_bytes())?;
        Ok(id)
    }
    fn changed(&self, owner: &str, method: &str, p: &Value, result: &Value) {
        let group = method.split('.').nth(1).unwrap_or("");
        let action = method.rsplit('.').next().unwrap_or("");
        if !matches!(
            action,
            "create"
                | "update"
                | "delete"
                | "clear_status"
                | "setup"
                | "clear"
                | "set_for_bot"
                | "add_mcp"
                | "remove_mcp"
                | "rename"
                | "archive"
                | "unarchive"
                | "touch"
                | "mark_read"
                | "set"
                | "disconnect"
                | "register_poll"
                | "add_member"
                | "remove_member"
                | "run_now"
                | "restore"
        ) {
            return;
        }
        let mut payload = json!({});
        for candidate in [&result["section"], &result["room"], p] {
            if payload.get("id").is_none() && candidate["id"].is_string() {
                payload["id"] = candidate["id"].clone();
            }
        }
        if result["deleted"] == true || result["room"]["deleted"] == true {
            payload["deleted"] = json!(true);
        }
        if let Some(bot) = result["bot"]["name"]
            .as_str()
            .or(result["section"]["bot"].as_str())
            .or(p["bot"].as_str())
            .or(p["name"].as_str())
        {
            payload["bot"] = json!(bot);
            payload["name"] = json!(bot);
        }
        if result["connector"]["id"].is_string() {
            payload["connector"] = result["connector"]["id"].clone();
        }
        let event = if method == "hexbot.memory.user.set" {
            "hexbot.memory.user.changed".to_string()
        } else if matches!(
            group,
            "bots" | "sections" | "rooms" | "connectors" | "network" | "connect" | "dreaming"
        ) {
            format!("hexbot.{group}.changed")
        } else {
            return;
        };
        self.events.emit(owner, None, &event, payload.clone());
        if group == "connectors" {
            self.events
                .emit(owner, None, "hexbot.bots.changed", payload);
        }
    }
}
fn hostname() -> String {
    auth::daemon_name()
}

fn cookie(headers: &HeaderMap) -> Option<String> {
    headers
        .get("cookie")?
        .to_str()
        .ok()?
        .split(';')
        .find_map(|part| {
            part.trim()
                .strip_prefix("hermes_session_at=")
                .map(str::to_owned)
        })
}
fn bearer(headers: &HeaderMap) -> Option<String> {
    headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::to_owned)
        .or_else(|| cookie(headers))
}
fn valid_origin(headers: &HeaderMap) -> bool {
    let Some(origin) = headers.get("origin") else {
        return true;
    };
    let Ok(origin) = origin.to_str() else {
        return false;
    };
    if origin == "hexbot-app://app" {
        return true;
    }
    let Ok(url) = url::Url::parse(origin) else {
        return false;
    };
    let host = url.host_str().unwrap_or("");
    if matches!(host, "127.0.0.1" | "localhost" | "[::1]" | "::1") {
        return true;
    }
    matches!(url.scheme(), "http" | "https")
        && headers
            .get("host")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|h| h == &url[url::Position::BeforeHost..url::Position::AfterPort])
}
async fn origin_guard(request: axum::extract::Request, next: axum::middleware::Next) -> Response {
    if !valid_origin(request.headers()) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let origin = request.headers().get("origin").cloned();
    let options = request.method() == axum::http::Method::OPTIONS;
    let mut response = if options {
        StatusCode::NO_CONTENT.into_response()
    } else {
        next.run(request).await
    };
    if let Some(origin) = origin {
        response
            .headers_mut()
            .insert("access-control-allow-origin", origin);
        response
            .headers_mut()
            .insert("vary", HeaderValue::from_static("Origin"));
        response.headers_mut().insert(
            "access-control-allow-headers",
            HeaderValue::from_static("Content-Type, Authorization"),
        );
        response.headers_mut().insert(
            "access-control-allow-methods",
            HeaderValue::from_static("GET, POST, OPTIONS"),
        );
        response.headers_mut().insert(
            "access-control-allow-credentials",
            HeaderValue::from_static("true"),
        );
    }
    response
}
fn http_error(error: Error) -> Response {
    let status = match error.code {
        4301 | 4302 => StatusCode::FORBIDDEN,
        4231 => StatusCode::UNAUTHORIZED,
        4232 => StatusCode::TOO_MANY_REQUESTS,
        4200..=4299 => StatusCode::BAD_REQUEST,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    };
    (
        status,
        Json(json!({"error":error.message,"code":error.code})),
    )
        .into_response()
}
async fn login(State(app): State<Arc<App>>, Json(p): Json<Value>) -> Response {
    let result = async {
        if p["provider"].as_str().unwrap_or("hexbot") != "hexbot" {
            return Err(Error::new(4231, "invalid provider"));
        }
        let password = common::required(&p, "password")?;
        let name = p["username"]
            .as_str()
            .unwrap_or("Unnamed device")
            .trim()
            .chars()
            .take(80)
            .collect::<String>();
        if let Some(grant) = password.strip_prefix("cg_") {
            services::redeem_grant(&app.home, grant, &name, "connect").await
        } else {
            auth::redeem_code(&app.home, password, &name, "browser")
        }
    }
    .await;
    match result {
        Ok(device) => {
            let mut response =
                Json(json!({"ok":true,"daemon_name":device["daemon_name"]})).into_response();
            if let Some(token) = device["device_token"].as_str()
                && let Ok(cookie) = HeaderValue::from_str(&format!(
                    "hermes_session_at={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=315360000"
                ))
            {
                response.headers_mut().insert("set-cookie", cookie);
            }
            response
        }
        Err(e) => http_error(e),
    }
}
async fn pair(State(app): State<Arc<App>>, Json(p): Json<Value>) -> Response {
    match common::required(&p, "code").and_then(|code| {
        auth::redeem_code(
            &app.home,
            code,
            p["device_name"].as_str().unwrap_or("Unnamed device"),
            p["platform"].as_str().unwrap_or("browser"),
        )
    }) {
        Ok(value) => Json(value).into_response(),
        Err(e) => http_error(e),
    }
}
async fn session(State(app): State<Arc<App>>, headers: HeaderMap) -> Response {
    let token = bearer(&headers).unwrap_or_default();
    if auth::verify_token(&app.home, &token)
        .ok()
        .flatten()
        .is_none()
    {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let mut response = Json(json!({"ok":true})).into_response();
    response.headers_mut().insert(
        "set-cookie",
        HeaderValue::from_str(&format!(
            "hermes_session_at={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=315360000"
        ))
        .unwrap(),
    );
    response
}
async fn ticket(State(app): State<Arc<App>>, headers: HeaderMap) -> Response {
    let token = bearer(&headers).unwrap_or_default();
    if auth::verify_token(&app.home, &token)
        .ok()
        .flatten()
        .is_none()
    {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let ticket = format!("{}{}", common::id(), common::id());
    let mut tickets = app.tickets.lock().unwrap_or_else(|e| e.into_inner());
    tickets.retain(|_, (_, deadline)| *deadline > common::now());
    if tickets.len() >= 4096 {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    }
    tickets.insert(ticket.clone(), (token, common::now() + 30.));
    Json(json!({"ticket":ticket})).into_response()
}
async fn index(State(app): State<Arc<App>>, headers: HeaderMap) -> Response {
    let host = headers
        .get("host")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let local_host = url::Url::parse(&format!("http://{host}"))
        .ok()
        .is_some_and(|u| matches!(u.host_str(), Some("localhost" | "127.0.0.1" | "[::1]")));
    let auth_required = !app.address.ip().is_loopback() || !local_host;
    let token = if !auth_required {
        auth::local_token(&app.home).ok()
    } else {
        None
    };
    let mut body=app.web_dist.as_ref().and_then(|p|std::fs::read_to_string(p.join("index.html")).ok()).unwrap_or_else(||"<!doctype html><html><head></head><body>Hexbot daemon is running. Build apps/web to serve the browser app.</body></html>".into());
    let script = format!(
        "<script>window.__HERMES_AUTH_REQUIRED__={auth_required};{}</script>",
        token
            .map(|t| format!("window.__HERMES_SESSION_TOKEN__={};", json!(t)))
            .unwrap_or_default()
    );
    body = body.replacen("</head>", &format!("{script}</head>"), 1);
    let mut response = Html(body).into_response();
    response
        .headers_mut()
        .insert("cache-control", HeaderValue::from_static("no-store"));
    response
}
async fn spa(State(app): State<Arc<App>>, headers: HeaderMap, uri: axum::http::Uri) -> Response {
    if uri.path().starts_with("/api/")
        || uri
            .path()
            .rsplit('/')
            .next()
            .is_some_and(|name| name.contains('.'))
    {
        return StatusCode::NOT_FOUND.into_response();
    }
    index(State(app), headers).await
}
async fn upgrade(
    State(app): State<Arc<App>>,
    Query(p): Query<HashMap<String, String>>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    let token = if let Some(ticket) = p.get("ticket") {
        app.tickets
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(ticket)
            .filter(|(_, expiry)| *expiry > common::now())
            .map(|(token, _)| token)
    } else {
        p.get("token").cloned().or_else(|| bearer(&headers))
    };
    let Some(token) = token else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let Some(device) = auth::verify_token(&app.home, &token).ok().flatten() else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let owner = device["owner_id"].as_str().unwrap_or("").to_owned();
    let id = device["id"].as_str().unwrap_or("").to_owned();
    ws.max_message_size(384 * 1024 * 1024)
        .max_frame_size(384 * 1024 * 1024)
        .on_upgrade(move |socket| connection(app, socket, owner, id, token))
}
async fn connection(
    app: Arc<App>,
    mut socket: WebSocket,
    owner: String,
    device_id: String,
    token: String,
) {
    let mut events = app.events.subscribe();
    let mut stop = app.stop.subscribe();
    if *stop.borrow() {
        return;
    }
    let ready = json!({"jsonrpc":"2.0","method":"event","params":{"type":"gateway.ready","payload":{"change_events":true,"heartbeat":true,"replay_epoch":app.events.epoch()}}});
    if socket
        .send(Message::Text(format!("{ready}\n").into()))
        .await
        .is_err()
    {
        return;
    }
    let mut verify = tokio::time::interval(Duration::from_secs(1));
    let mut tasks = tokio::task::JoinSet::new();
    'connection: loop {
        tokio::select! {
            _=stop.changed()=>{let _=socket.send(Message::Close(Some(CloseFrame{code:1012,reason:"Daemon restarting".into()}))).await;break;}
            _=verify.tick()=>{
                if auth::verify_token(&app.home,&token).ok().flatten().is_none(){let _=socket.send(Message::Close(Some(CloseFrame{code:4401,reason:"Device revoked".into()}))).await;break;}
            }
            result=events.recv()=>match result {
                Ok(event) if event.owner==owner=>if socket.send(Message::Text(format!("{}\n",event.frame).into())).await.is_err(){break;},
                Ok(_)=>{},
                Err(_)=>{let _=socket.send(Message::Close(Some(CloseFrame{code:1013,reason:"Reconnect to recover missed events".into()}))).await;break;}
            },
            Some(result)=tasks.join_next(),if !tasks.is_empty()=>{
                if let Ok(Some(response))=result && socket.send(Message::Text(format!("{response}\n").into())).await.is_err(){break;}
            }
            incoming=socket.recv()=>match incoming {
                Some(Ok(Message::Text(text)))=>{
                    if tasks.len()>=64 {let _=socket.send(Message::Close(Some(CloseFrame{code:1013,reason:"Too many requests".into()}))).await;break;}
                    for line in text.split('\n').filter(|s|!s.trim().is_empty()) {
                        let request=serde_json::from_str::<Value>(line);
                        if tasks.len()>=64 {let _=socket.send(Message::Close(Some(CloseFrame{code:1013,reason:"Too many requests".into()}))).await;break 'connection;}
                        let app=app.clone();let owner=owner.clone();let device_id=device_id.clone();let token=token.clone();
                        tasks.spawn(handle_request(app,owner,device_id,token,request));
                    }
                }
                Some(Ok(Message::Ping(data)))=>{if socket.send(Message::Pong(data)).await.is_err(){break;}},
                Some(Ok(Message::Close(_)))|None|Some(Err(_))=>break,
                _=>{}
            }
        }
    }
    // Runtime RPCs own their command tasks. One-shot requests still cancel
    // with this connection and run their scoped cleanup.
    tasks.abort_all();
}
async fn handle_request(
    app: Arc<App>,
    owner: String,
    device_id: String,
    token: String,
    request: std::result::Result<Value, serde_json::Error>,
) -> Option<Value> {
    let request = match request {
        Ok(value) => value,
        Err(_) => return Some(crate::rpc::parse_error()),
    };
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    if request["jsonrpc"] != "2.0"
        || !request["method"].is_string()
        || !(id.is_null() || id.is_string() || id.is_number())
    {
        return Some(
            json!({"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"invalid request"}}),
        );
    }
    let method = request["method"].as_str().unwrap();
    let params = request.get("params").cloned().unwrap_or_else(|| json!({}));
    let result = if auth::verify_token(&app.home, &token)
        .ok()
        .flatten()
        .is_none()
    {
        Err(Error::new(4302, "device revoked"))
    } else if !params.is_object() {
        Err(Error::new(-32602, "params must be an object"))
    } else {
        app.call(&owner, method, &params).await
    };
    request.get("id")?;
    Some(match result {
        Ok(mut value) => {
            if method == "hexbot.devices.list"
                && let Some(devices) = value["devices"].as_array_mut()
            {
                for device in devices {
                    device["current"] = json!(device["id"] == device_id);
                }
            }
            json!({"jsonrpc":"2.0","id":id,"result":value})
        }
        Err(error) => json!({"jsonrpc":"2.0","id":id,"error":error.rpc_value()}),
    })
}
pub fn router(app: Arc<App>) -> Router {
    let mut router = Router::new()
        .route("/", get(index))
        .route("/api/ws", get(upgrade))
        .route("/auth/password-login", post(login))
        .route("/api/auth/ws-ticket", post(ticket))
        .route("/hexbot/pair", post(pair))
        .route("/hexbot/session", post(session));
    if let Some(dist) = app.web_dist.clone() {
        router = router.fallback_service(
            tower_http::services::ServeDir::new(dist).fallback(get(spa).with_state(app.clone())),
        );
    }
    router
        .layer(DefaultBodyLimit::max(16 * 1024 * 1024))
        .layer(axum::middleware::from_fn(origin_guard))
        .with_state(app)
}
