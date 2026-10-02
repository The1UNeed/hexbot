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
        ConnectInfo, DefaultBodyLimit, Extension, Query, State, WebSocketUpgrade,
        ws::{CloseFrame, Message, WebSocket},
    },
    http::{HeaderMap, HeaderValue, StatusCode},
    response::{Html, IntoResponse, Response},
    routing::{get, post},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    net::SocketAddr,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};

pub(crate) const WS_MESSAGE_LIMIT: usize = 64 * 1024 * 1024;

pub struct App {
    pub home: PathBuf,
    pub events: EventHub,
    pub runtime: Arc<Runtime>,
    pub rooms: Arc<RoomEngine>,
    pub dreaming: Arc<crate::dreaming::Dreaming>,
    memory: MemoryStore,
    tickets: Mutex<HashMap<String, (String, f64)>>,
    logins: Mutex<HashMap<String, BrowserLogin>>,
    auth_connection: Mutex<rusqlite::Connection>,
    pub address: SocketAddr,
    _network_guard: common::DaemonListener,
    pub web_dist: Option<PathBuf>,
    stop: tokio::sync::watch::Sender<bool>,
}
struct BrowserLogin {
    client: String,
    verifier: String,
    next: String,
    expires: f64,
    redirect_uri: String,
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
        let events = EventHub::new();
        let runtime = Runtime::new(home.clone(), events.clone(), pi)?;
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            let runtime = runtime.clone();
            let home = home.clone();
            handle.spawn(async move {
                match db::open(&home).and_then(|conn| {
                    common::rows(&conn, "SELECT name FROM bots ORDER BY name", &[])
                }) {
                    Ok(bots) => {
                        for bot in bots {
                            if let Some(name) = bot["name"].as_str() {
                                runtime.refresh_description(name).await;
                            }
                        }
                    }
                    Err(error) => {
                        eprintln!("Could not refresh bot descriptions: {}", error.message)
                    }
                }
            });
        }
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
            auth_connection: Mutex::new(db::open(&home)?),
            home,
            events,
            runtime,
            rooms,
            dreaming,
            tickets: Mutex::new(HashMap::new()),
            logins: Mutex::new(HashMap::new()),
            address,
            _network_guard: common::DaemonListener::register(address),
            web_dist,
            stop,
        }))
    }
    /// Serve another address with the same bots: running turns and the event
    /// log carry over; connections to the old address are closed by `disconnect`.
    pub fn rebind(&self, address: SocketAddr) -> Result<Arc<Self>> {
        let (stop, _) = tokio::sync::watch::channel(false);
        Ok(Arc::new(Self {
            memory: MemoryStore::new(self.home.clone()),
            auth_connection: Mutex::new(db::open(&self.home)?),
            home: self.home.clone(),
            events: self.events.clone(),
            runtime: self.runtime.clone(),
            rooms: self.rooms.clone(),
            dreaming: self.dreaming.clone(),
            tickets: Mutex::new(std::mem::take(&mut *self.tickets.lock().unwrap())),
            logins: Mutex::new(std::mem::take(&mut *self.logins.lock().unwrap())),
            address,
            _network_guard: common::DaemonListener::register(address),
            web_dist: self.web_dist.clone(),
            stop,
        }))
    }
    pub async fn call(self: &Arc<Self>, owner: &str, method: &str, p: &Value) -> Result<Value> {
        if *self.stop.borrow() {
            return Err(Error::new(5200, "Reconnect to continue"));
        }
        common::user(&self.home, owner)?;
        let mut affected_rooms = Vec::new();
        // Everyone in a room hears about its changes, including whoever a
        // delete or removal takes out of it.
        let room_wide = matches!(
            method,
            "hexbot.rooms.create"
                | "hexbot.rooms.update"
                | "hexbot.rooms.add_member"
                | "hexbot.rooms.remove_member"
                | "hexbot.rooms.send"
                | "hexbot.rooms.archive"
                | "hexbot.rooms.unarchive"
                | "hexbot.rooms.delete"
        );
        let mut audience = if matches!(method, "hexbot.rooms.delete" | "hexbot.rooms.remove_member")
        {
            self.audience(p["id"].as_str())
        } else {
            Vec::new()
        };
        // Deletes are orchestrated here alone: one busy check, one close pass.
        if method == "hexbot.sections.delete" {
            let stored = common::required(p, "id")?;
            catalog::section(&self.home, owner, stored)?;
            self.runtime.delete_stored(owner, stored).await?;
        }
        if method == "hexbot.bots.delete" {
            let bot = common::required(p, "name")?;
            common::bot_owner(&self.home, owner, bot)?;
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
            // Sections, room conversations and hidden jobs, each under its owner.
            let sessions = common::rows(
                &crate::runtime_store::open(&self.home)?,
                "SELECT stored_id,owner FROM native_sessions WHERE bot=?",
                &[&bot],
            )?;
            for session in sessions {
                self.runtime
                    .delete_stored(
                        common::required(&session, "owner")?,
                        common::required(&session, "stored_id")?,
                    )
                    .await?;
            }
        }
        let mut removed_sessions = Vec::new();
        // Removing a bot or the room closes sessions first, so ownership is
        // checked once here and the rooms helpers below do not repeat it.
        // Removing a person closes nothing and stays in the rooms module.
        let closes = method == "hexbot.rooms.delete"
            || (method == "hexbot.rooms.remove_member" && p.get("user").is_none());
        if closes {
            let room = common::required(p, "id")?;
            let row = rooms::owned(&self.home, owner, room)?;
            let bot = p["bot"].as_str();
            let active = row["members"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|m| m["member_kind"] == "bot" && m["left_at"].is_null())
                .map(|m| m["member_id"].as_str())
                .collect::<Vec<_>>();
            // Removing the last bot deletes the room.
            let deleting = method == "hexbot.rooms.delete" || active == [bot];
            removed_sessions = common::rows(
                &db::open(&self.home)?,
                "SELECT stored_session_id FROM room_sessions WHERE room_id=?1 AND (?2 OR bot=?3)",
                &[&room, &deleting, &bot],
            )?;
            if deleting {
                // Close before metadata cascades remove the only stored-id mapping.
                self.rooms.stop_internal(room).await?;
                for session in std::mem::take(&mut removed_sessions) {
                    self.runtime
                        .close_stored(owner, common::required(&session, "stored_session_id")?)
                        .await?;
                }
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
            "hexbot.info" => Ok(json!({
                "version": crate::version(),
                "hermes_version": serde_json::from_str::<Value>(include_str!("../../pi-runtime/package.json"))
                    .ok()
                    .and_then(|p| {
                        p["dependencies"]["@earendil-works/pi-coding-agent"]
                            .as_str()
                            .map(str::to_owned)
                    }),
                "daemon_name": auth::daemon_name(),
                "install_id": self.install_id()?,
                // Always true; kept for older clients that still read it.
                "auth_required": true,
                "pairing_supported": true,
                "update_capability": std::env::var("HEXBOT_SUPERVISOR")
                    .ok()
                    .filter(|s| matches!(s.as_str(), "desktop" | "service")),
                "lan_enabled": settings::get(&self.home)?["lan_enabled"],
                "addresses": self.addresses(),
                "platform": std::env::consts::OS,
                "sandbox": crate::credentials::sandbox(),
                "home": if common::admin(&self.home, owner).is_ok() {
                    json!(self.home)
                } else {
                    json!("")
                }
            })),
            "hexbot.rooms.stop" => {
                Ok(json!({"stopped":self.rooms.stop(owner,common::required(p,"id")?).await?}))
            }
            "hexbot.rooms.delete" => rooms::delete(&self.home, common::required(p, "id")?),
            "hexbot.rooms.remove_member" if closes => rooms::remove_bot(
                &self.home,
                owner,
                common::required(p, "id")?,
                common::required(p, "bot")?,
            ),
            _ => {
                if let Some(result) = self.dreaming.call(owner, method, p).await {
                    result
                } else if let Some(result) = self.runtime.call(owner, method, p).await {
                    result
                } else if crate::rpc::METHODS.contains(&method) {
                    crate::rpc::call(&self.memory, owner, method, p)
                } else if let Some(result) = auth::call(&self.home, owner, method, p) {
                    result
                } else if let Some(result) = catalog::call(&self.home, owner, method, p) {
                    if let Ok(value) = &result
                        && matches!(
                            method,
                            "hexbot.bots.create" | "hexbot.bots.update" | "profiles.configure"
                        )
                        && let Some(name) = value["bot"]["name"].as_str().or(value["name"].as_str())
                    {
                        self.runtime.spawn_description_refresh(name);
                    }
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
        // Opening a room restores the owner's cards or a member's status.
        if method == "hexbot.rooms.get" {
            let room_owner = common::required(&result["room"], "owner_id")?;
            for turn in result["room"]["turns"].as_array().into_iter().flatten() {
                if let Some(live) = turn["live_session_id"].as_str() {
                    self.runtime.replay_pending(room_owner, live, owner);
                }
            }
        }
        if method == "hexbot.rooms.archive" && result["room"]["archived_at"].is_number() {
            self.rooms.stop(owner, common::required(p, "id")?).await?;
        }
        if matches!(
            method,
            "hexbot.rooms.add_member" | "hexbot.rooms.remove_member"
        ) && !closes
        {
            self.rooms.share(common::required(p, "id")?)?;
        }
        if !removed_sessions.is_empty() {
            // Only the removed bot stops; the rest of the room keeps going.
            for session in removed_sessions {
                self.runtime
                    .close_stored(owner, common::required(&session, "stored_session_id")?)
                    .await?;
            }
            db::open(&self.home)?.execute(
                "UPDATE room_sessions SET live_session_id=NULL WHERE room_id=? AND bot=?",
                rusqlite::params![common::required(p, "id")?, common::required(p, "bot")?],
            )?;
        }
        if method == "hexbot.bots.delete" {
            crate::connectors::close_bot(&self.home, common::required(p, "name")?).await;
        }
        let after = if room_wide {
            self.audience(result["room"]["id"].as_str().or(p["id"].as_str()))
        } else {
            Vec::new()
        };
        for user in std::iter::once(owner.to_owned()).chain(after) {
            if !audience.contains(&user) {
                audience.push(user);
            }
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
                // Kept for older apps: the listener moves and clients reconnect,
                // but the daemon and its running turns carry on.
                result["restarting"] = json!(true);
            } else {
                result["bind_host"] = json!(self.address.ip().to_string());
            }
        }
        if method == "hexbot.rooms.send" {
            let id = common::required(p, "id")?;
            for user in &audience {
                self.events.emit(
                    user,
                    None,
                    "hexbot.rooms.event",
                    json!({"room_id":id,"event":result["event"]}),
                );
            }
            self.rooms.notify(owner, id).await?;
        }
        if matches!(
            method,
            "hexbot.rooms.add_member" | "hexbot.rooms.remove_member"
        ) && result["event"].is_object()
        {
            let event = result.as_object_mut().unwrap().remove("event").unwrap();
            for user in &audience {
                self.events.emit(
                    user,
                    None,
                    "hexbot.rooms.event",
                    json!({"room_id":p["id"],"event":event}),
                );
            }
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
        self.changed(&audience, method, p, &result);
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
    /// Close this App's connections and refuse new calls; bots keep running.
    pub fn disconnect(&self) {
        self.stop.send_replace(true);
    }
    pub async fn shutdown(&self) {
        self.disconnect();
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
        let _guard = self
            .auth_connection
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let path = self.home.join("install_id");
        for candidate in [&path, &self.home.join("install-id")] {
            match std::fs::read_to_string(candidate) {
                Ok(value) if !value.trim().is_empty() => {
                    let id = value.trim().to_owned();
                    if candidate != &path {
                        common::atomic_write(&path, id.as_bytes())?;
                    }
                    return Ok(id);
                }
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
        let id = uuid::Uuid::new_v4().simple().to_string();
        common::atomic_write(&path, id.as_bytes())?;
        Ok(id)
    }
    fn audience(&self, room: Option<&str>) -> Vec<String> {
        room.and_then(|room| rooms::audience(&self.home, room).ok())
            .unwrap_or_default()
    }
    fn changed(&self, audience: &[String], method: &str, p: &Value, result: &Value) {
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
        // Whoever a removal takes out of the room drops it from their list.
        let removed = (method == "hexbot.rooms.remove_member")
            .then(|| p["user"].as_str())
            .flatten();
        for owner in audience {
            let mut payload = payload.clone();
            if removed == Some(owner.as_str()) {
                payload["removed"] = json!(true);
            }
            self.events.emit(owner, None, &event, payload.clone());
            if group == "connectors" {
                self.events
                    .emit(owner, None, "hexbot.bots.changed", payload.clone());
            }
        }
    }
}

fn safe_next(value: &str) -> String {
    if value.starts_with('/')
        && !value.starts_with("//")
        && !value.contains('\\')
        && !value.chars().any(char::is_control)
    {
        value.to_owned()
    } else {
        "/".into()
    }
}
fn registered(app: &App) -> Result<services::ConnectConfig> {
    services::ConnectConfig::load(&app.home)?
        .filter(|c| !c.daemon_id.is_empty())
        .ok_or_else(|| Error::new(4231, "Hex Connect is not set up on this daemon"))
}
/// Only the App on this machine asks: cloudflared and local proxies also
/// connect from loopback, but they forward another Host.
async fn daemon_identity(
    State(app): State<Arc<App>>,
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
    headers: HeaderMap,
) -> Response {
    let local_host = headers
        .get("host")
        .and_then(|h| h.to_str().ok())
        .and_then(|h| url::Url::parse(&format!("http://{h}")).ok())
        .is_some_and(|u| match u.host() {
            Some(url::Host::Domain(name)) => name == "localhost",
            Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
            Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
            None => false,
        });
    if !local_host
        || !peer.is_some_and(|Extension(ConnectInfo(address))| address.ip().is_loopback())
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    match app.install_id() {
        Ok(id) => Json(json!({"install_id": id, "pid": std::process::id()})).into_response(),
        Err(error) => http_error(error),
    }
}

async fn auth_providers(State(app): State<Arc<App>>) -> Json<Value> {
    let mut providers =
        vec![json!({"name":"hexbot","display_name":"Hexbot pairing","supports_password":true})];
    if registered(&app).is_ok() {
        providers
            .push(json!({"name":"connect","display_name":"Hex Connect","supports_password":false}));
    }
    Json(json!({"providers":providers}))
}
fn pkce_cookie(
    app: &App,
    headers: &HeaderMap,
    peer: Option<SocketAddr>,
    value: &str,
    max_age: u32,
) -> HeaderValue {
    HeaderValue::from_str(&format!(
        "hermes_session_pkce={value}; Path=/; HttpOnly; SameSite=Lax; Max-Age={max_age}{}",
        if secure_request(app, headers, peer) {
            "; Secure"
        } else {
            ""
        }
    ))
    .expect("PKCE cookie")
}
async fn browser_login(
    State(app): State<Arc<App>>,
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
    headers: HeaderMap,
    Query(p): Query<HashMap<String, String>>,
) -> Response {
    let address = peer.as_ref().map(|Extension(ConnectInfo(p))| *p);
    let result = (|| {
        if p.get("provider").map(String::as_str) != Some("connect") {
            return Err(Error::new(4231, "invalid provider"));
        }
        let config = registered(&app)?;
        if !tunnel_host(&headers, &config.tunnel_hostname) {
            let mut target =
                url::Url::parse(&format!("https://{}/auth/login", config.tunnel_hostname))
                    .map_err(|_| Error::new(4231, "invalid tunnel hostname"))?;
            target.query_pairs_mut().extend_pairs(p.iter());
            return Ok(axum::response::Redirect::to(target.as_str()).into_response());
        }
        let client = client_address(&app, peer, &headers);
        let state = format!("{}{}", common::id(), common::id());
        let verifier = format!("{}{}", common::id(), common::id());
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        let redirect_uri = format!("https://{}/auth/callback", config.tunnel_hostname);
        let mut target = url::Url::parse(&format!("{}/connect/browser", config.api_base))
            .map_err(|_| Error::new(4231, "invalid Hex Connect URL"))?;
        target.query_pairs_mut().extend_pairs([
            ("daemon", config.daemon_id.as_str()),
            ("state", &state),
            ("code_challenge", &challenge),
            ("redirect_uri", &redirect_uri),
        ]);
        let mut logins = app.logins.lock().unwrap_or_else(|e| e.into_inner());
        logins.retain(|_, login| login.expires > common::now());
        if logins.len() >= 4096
            || logins
                .values()
                .filter(|login| login.client == client)
                .count()
                >= 8
        {
            return Err(Error::new(4232, "too many attempts"));
        }
        logins.insert(
            state.clone(),
            BrowserLogin {
                client,
                verifier: verifier.clone(),
                next: safe_next(p.get("next").map(String::as_str).unwrap_or("/")),
                expires: common::now() + 600.,
                redirect_uri,
            },
        );
        let mut response = axum::response::Redirect::to(target.as_str()).into_response();
        response.headers_mut().insert(
            "set-cookie",
            pkce_cookie(&app, &headers, address, &format!("{state}.{verifier}"), 600),
        );
        response
            .headers_mut()
            .insert("cache-control", HeaderValue::from_static("no-store"));
        Ok(response)
    })();
    result.unwrap_or_else(http_error)
}
fn take_browser_login(app: &App, headers: &HeaderMap, state: &str) -> Result<BrowserLogin> {
    let invalid = || Error::new(4231, "Sign-in expired or invalid. Try again.");
    let cookie = cookie_value(headers, "hermes_session_pkce").ok_or_else(invalid)?;
    let (cookie_state, verifier) = cookie.split_once('.').ok_or_else(invalid)?;
    if cookie_state != state {
        return Err(invalid());
    }
    let mut logins = app.logins.lock().unwrap_or_else(|e| e.into_inner());
    let login = logins.get(state).ok_or_else(invalid)?;
    if login.expires <= common::now() || login.verifier != verifier {
        return Err(invalid());
    }
    Ok(logins.remove(state).expect("checked login"))
}
async fn browser_callback(
    State(app): State<Arc<App>>,
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
    headers: HeaderMap,
    Query(p): Query<HashMap<String, String>>,
) -> Response {
    let address = peer.map(|Extension(ConnectInfo(p))| p);
    let result = async {
        let login = take_browser_login(
            &app,
            &headers,
            p.get("state").map(String::as_str).unwrap_or(""),
        )?;
        let code = p
            .get("code")
            .filter(|s| !s.is_empty())
            .ok_or_else(|| Error::new(4231, "Missing sign-in code"))?;
        let config = registered(&app)?;
        if login.redirect_uri != format!("https://{}/auth/callback", config.tunnel_hostname) {
            return Err(Error::new(
                4231,
                "Hex Connect registration changed. Sign in again.",
            ));
        }
        let grant =
            services::exchange_browser_grant(&config, code, &login.verifier, &login.redirect_uri)
                .await?;
        let device = services::redeem_grant(&app.home, &grant, "", "connect").await?;
        let mut response = axum::response::Redirect::to(&login.next).into_response();
        response.headers_mut().insert(
            "set-cookie",
            session_cookie(
                &app,
                &headers,
                address,
                common::required(&device, "device_token")?,
            ),
        );
        Ok(response)
    }
    .await;
    let mut response = result.unwrap_or_else(http_error);
    response
        .headers_mut()
        .append("set-cookie", pkce_cookie(&app, &headers, address, "", 0));
    response
        .headers_mut()
        .insert("cache-control", HeaderValue::from_static("no-store"));
    response
}
fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}
async fn login_page(
    State(app): State<Arc<App>>,
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
    headers: HeaderMap,
    Query(p): Query<HashMap<String, String>>,
) -> Response {
    let next = safe_next(p.get("next").map(String::as_str).unwrap_or("/"));
    // A one-time sign-in link (`hexbot serve` prints one) carries an ordinary pairing
    // code. Redeeming it here sets the same cookie the form would; the page is the
    // only place a credential ever goes, and only after the code is spent.
    let mut notice = "";
    // A browser that is already signed in keeps its session: a link cannot swap it
    // for a device someone else minted, and the code stays unused.
    let signed_in = || {
        cookie(&app, &headers)
            .and_then(|token| auth::verify_token(&app.home, &token).ok().flatten())
            .is_some()
    };
    // Only a navigation the user started spends a code. A terminal link sends no
    // Sec-Fetch-Site or `none`; a page from another site cannot sign this browser
    // in by linking here.
    let own_navigation = || {
        headers
            .get("sec-fetch-site")
            .is_none_or(|site| matches!(site.to_str(), Ok("none") | Ok("same-origin")))
    };
    if p.contains_key("code") && signed_in() {
        let mut response = axum::response::Redirect::to(&next).into_response();
        response
            .headers_mut()
            .insert("cache-control", HeaderValue::from_static("no-store"));
        return response;
    }
    if p.contains_key("code") && !own_navigation() {
        notice = "<p class=\"form-error\" role=\"alert\">Sign-in links work only when opened directly. Enter the pairing code instead.</p>";
    } else if let Some(code) = p.get("code") {
        let address = peer.as_ref().map(|Extension(ConnectInfo(p))| *p);
        let local = address.is_some_and(|a| a.ip().is_loopback())
            && !headers.contains_key("cf-connecting-ip");
        let client = client_address(&app, peer, &headers);
        let name = if local {
            "Browser on this computer"
        } else {
            "Browser"
        };
        match auth::redeem_code_from(&app.home, code, name, "browser", &client) {
            Ok(device) => {
                let mut response = axum::response::Redirect::to(&next).into_response();
                if let Some(token) = device["device_token"].as_str() {
                    response
                        .headers_mut()
                        .insert("set-cookie", session_cookie(&app, &headers, address, token));
                }
                response
                    .headers_mut()
                    .insert("cache-control", HeaderValue::from_static("no-store"));
                return response;
            }
            Err(error) if error.code == 4232 => {
                notice = "<p class=\"form-error\" role=\"alert\">Too many attempts. Wait a minute and try again.</p>";
            }
            Err(_) => {
                notice = "<p class=\"form-error\" role=\"alert\">That sign-in link has been used or has expired. Enter a new pairing code.</p>";
            }
        }
    }
    let query = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("provider", "connect")
        .append_pair("next", &next)
        .finish();
    let connect = if registered(&app).is_ok() {
        format!(
            "<a class=\"provider-btn\" href=\"/auth/login?{}\">Sign in with Hex Connect</a><div class=\"or\">or</div>",
            escape_html(&query)
        )
    } else {
        String::new()
    };
    let mut response = Html(
        LOGIN_PAGE
            .replace("<!--NOTICE-->", notice)
            .replace("<!--CONNECT-->", &connect)
            .replace("<!--NEXT-->", &escape_html(&next)),
    )
    .into_response();
    response
        .headers_mut()
        .insert("cache-control", HeaderValue::from_static("no-store"));
    response
}

fn cookie_value(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get("cookie")?
        .to_str()
        .ok()?
        .split(';')
        .find_map(|part| {
            let (key, value) = part.trim().split_once('=')?;
            (key == name).then(|| value.to_owned())
        })
}
/// Browsers scope cookies by host, not port, so the plain cookie carries the daemon's
/// port: two daemons on one machine (pnpm dev worktrees) must not sign each other out.
fn cookie_name(app: &App) -> String {
    format!("hermes_session_at_{}", app.address.port())
}
fn cookie(app: &App, headers: &HeaderMap) -> Option<String> {
    [
        "__Host-hermes_session_at".to_owned(),
        "__Secure-hermes_session_at".to_owned(),
        cookie_name(app),
        "hermes_session_at".to_owned(),
    ]
    .iter()
    .find_map(|name| cookie_value(headers, name))
}
fn secure_request(app: &App, headers: &HeaderMap, peer: Option<SocketAddr>) -> bool {
    let public_https = common::read_config(&app.home)
        .ok()
        .and_then(|c| c["dashboard"]["public_url"].as_str().map(str::to_owned))
        .and_then(|u| url::Url::parse(&u).ok())
        .is_some_and(|u| {
            u.scheme() == "https"
                && headers.get("host").and_then(|h| h.to_str().ok())
                    == Some(&u[url::Position::BeforeHost..url::Position::AfterPort])
        });
    public_https
        || (peer.is_some_and(|p| p.ip().is_loopback())
            && services::ConnectConfig::load(&app.home)
                .ok()
                .flatten()
                .is_some_and(|c| {
                    !c.tunnel_hostname.is_empty() && tunnel_host(headers, &c.tunnel_hostname)
                }))
}
fn session_cookie(
    app: &App,
    headers: &HeaderMap,
    peer: Option<SocketAddr>,
    token: &str,
) -> HeaderValue {
    let secure = secure_request(app, headers, peer);
    let name = if secure {
        "__Host-hermes_session_at".to_owned()
    } else {
        cookie_name(app)
    };
    HeaderValue::from_str(&format!(
        "{name}={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=315360000{}",
        if secure { "; Secure" } else { "" }
    ))
    .expect("device cookie")
}
fn bearer(app: &App, headers: &HeaderMap) -> Option<String> {
    headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::to_owned)
        .or_else(|| cookie(app, headers))
}
fn valid_origin(app: &App, headers: &HeaderMap) -> bool {
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
    if !matches!(url.scheme(), "http" | "https") {
        return false;
    }
    if std::env::var("HEXBOT_WEB_DEV_URL").ok().as_deref() == Some(origin) {
        return true;
    }
    let authority = &url[url::Position::BeforeHost..url::Position::AfterPort];
    let own = authority == app.address.to_string()
        || (app.address.ip().is_loopback()
            && authority == format!("localhost:{}", app.address.port()));
    let configured = common::read_config(&app.home)
        .ok()
        .and_then(|c| c["dashboard"]["public_url"].as_str().map(str::to_owned));
    let tunnel = services::ConnectConfig::load(&app.home)
        .ok()
        .flatten()
        .map(|c| format!("https://{}", c.tunnel_hostname));
    let same_daemon = url.port_or_known_default() == Some(app.address.port())
        && headers.get("host").and_then(|h| h.to_str().ok()) == Some(authority);
    own || same_daemon || configured.as_deref() == Some(origin) || tunnel.as_deref() == Some(origin)
}

async fn origin_guard(
    State(app): State<Arc<App>>,
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    if !valid_origin(&app, request.headers()) {
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
async fn login(
    State(app): State<Arc<App>>,
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
    headers: HeaderMap,
    Json(p): Json<Value>,
) -> Response {
    let address = peer.as_ref().map(|Extension(ConnectInfo(p))| *p);
    let client = client_address(&app, peer, &headers);
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
            auth::check_attempt(&app.home, &client)?;
            services::redeem_grant(&app.home, grant, &name, "connect").await
        } else {
            auth::redeem_code_from(&app.home, password, &name, "browser", &client)
        }
    }
    .await;
    match result {
        Ok(device) => {
            let mut response = Json(json!({"ok":true,"daemon_name":device["daemon_name"],"next":safe_next(p["next"].as_str().unwrap_or("/"))})).into_response();
            if let Some(token) = device["device_token"].as_str() {
                response
                    .headers_mut()
                    .insert("set-cookie", session_cookie(&app, &headers, address, token));
            }
            response
        }
        Err(e) => http_error(e),
    }
}
fn tunnel_host(headers: &HeaderMap, hostname: &str) -> bool {
    headers
        .get("host")
        .and_then(|h| h.to_str().ok())
        .is_some_and(|host| {
            host.eq_ignore_ascii_case(hostname)
                || host.eq_ignore_ascii_case(&format!("{hostname}:443"))
        })
}
fn client_address(
    app: &App,
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
    headers: &HeaderMap,
) -> String {
    let Some(Extension(ConnectInfo(address))) = peer else {
        return "unknown".into();
    };
    let mut ip = address.ip();
    // Trust Cloudflare's overwritten header only at the tunnel's local origin.
    if ip.is_loopback()
        && services::ConnectConfig::load(&app.home)
            .ok()
            .flatten()
            .is_some_and(|config| {
                !config.tunnel_hostname.is_empty() && tunnel_host(headers, &config.tunnel_hostname)
            })
        && let Some(forwarded) = headers
            .get("cf-connecting-ip")
            .and_then(|h| h.to_str().ok())
            .and_then(|h| h.parse().ok())
    {
        ip = forwarded;
    }
    match ip {
        std::net::IpAddr::V4(ip) => ip.to_string(),
        std::net::IpAddr::V6(ip) => match ip.to_ipv4_mapped() {
            Some(ip) => ip.to_string(),
            None => {
                let bits = u128::from(ip) & (u128::MAX << 64);
                format!("{}/64", std::net::Ipv6Addr::from(bits))
            }
        },
    }
}
async fn pair(
    State(app): State<Arc<App>>,
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
    headers: HeaderMap,
    Json(p): Json<Value>,
) -> Response {
    match common::required(&p, "code").and_then(|code| {
        auth::redeem_code_from(
            &app.home,
            code,
            p["device_name"].as_str().unwrap_or("Unnamed device"),
            p["platform"].as_str().unwrap_or("browser"),
            &client_address(&app, peer, &headers),
        )
    }) {
        Ok(value) => Json(value).into_response(),
        Err(e) => http_error(e),
    }
}
async fn session(
    State(app): State<Arc<App>>,
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
    headers: HeaderMap,
) -> Response {
    let address = peer.map(|Extension(ConnectInfo(p))| p);
    let token = bearer(&app, &headers).unwrap_or_default();
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
        session_cookie(&app, &headers, address, &token),
    );
    response
}
async fn ticket(State(app): State<Arc<App>>, headers: HeaderMap) -> Response {
    let token = bearer(&app, &headers).unwrap_or_default();
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
    // The page never carries a credential, whatever the bind address: any local process
    // can fetch it. A browser signs in at /login with a pairing code or the one-time
    // link `hexbot serve` prints; the app reads its private token file.
    if headers
        .get("accept")
        .and_then(|h| h.to_str().ok())
        .is_some_and(|h| h.contains("text/html"))
        && cookie(&app, &headers)
            .and_then(|token| auth::verify_token(&app.home, &token).ok().flatten())
            .is_none()
    {
        return axum::response::Redirect::to("/login").into_response();
    }
    let mut body = app
        .web_dist
        .as_ref()
        .and_then(|p| std::fs::read_to_string(p.join("index.html")).ok())
        .unwrap_or_else(|| {
            "<!doctype html><html><head></head><body>Hexbot daemon is running. Build apps/web to serve the browser app.</body></html>"
                .into()
        });
    // Kept for older clients: the web bundle reads it only as a "served by
    // a daemon" marker, and the daemon always requires sign-in.
    body = body.replacen(
        "</head>",
        "<script>window.__HERMES_AUTH_REQUIRED__=true;</script></head>",
        1,
    );
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
        p.get("token").cloned().or_else(|| bearer(&app, &headers))
    };
    let Some(token) = token else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let Some(device) = auth::verify_token(&app.home, &token).ok().flatten() else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let owner = device["owner_id"].as_str().unwrap_or("").to_owned();
    let id = device["id"].as_str().unwrap_or("").to_owned();
    ws.max_message_size(WS_MESSAGE_LIMIT)
        .max_frame_size(WS_MESSAGE_LIMIT)
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
    let bytes = Arc::new(tokio::sync::Semaphore::new(WS_MESSAGE_LIMIT));
    'connection: loop {
        tokio::select! {
            _ = stop.changed() => {
                let _ = socket
                    .send(Message::Close(Some(CloseFrame {
                        code: 1012,
                        reason: "Reconnect to continue".into(),
                    })))
                    .await;
                break;
            }
            _ = verify.tick() => {
                if auth::verify_token_with(
                    &app.auth_connection
                        .lock()
                        .unwrap_or_else(|e| e.into_inner()),
                    &token,
                )
                .ok()
                .flatten()
                .is_none()
                {
                    let _ = socket
                        .send(Message::Close(Some(CloseFrame {
                            code: 4401,
                            reason: "Device revoked".into(),
                        })))
                        .await;
                    break;
                }
            }
            result = events.recv() => match result {
                Ok(event) => {
                    if let Some(frame) = event.frame_for(&owner)
                        && socket
                            .send(Message::Text(format!("{frame}\n").into()))
                            .await
                            .is_err()
                    {
                        break;
                    }
                }
                Err(_) => {
                    let _ = socket
                        .send(Message::Close(Some(CloseFrame {
                            code: 1013,
                            reason: "Reconnect to recover missed events".into(),
                        })))
                        .await;
                    break;
                }
            },
            Some(result) = tasks.join_next(), if !tasks.is_empty() => {
                if let Ok(Some(response)) = result
                    && socket
                        .send(Message::Text(format!("{response}\n").into()))
                        .await
                        .is_err()
                {
                    break;
                }
            }
            incoming = socket.recv() => match incoming {
                Some(Ok(Message::Text(text))) => {
                    if tasks.len() >= 64 {
                        let _ = socket
                            .send(Message::Close(Some(CloseFrame {
                                code: 1013,
                                reason: "Too many requests".into(),
                            })))
                            .await;
                        break;
                    }
                    for line in text.split('\n').filter(|s| !s.trim().is_empty()) {
                        let Ok(permit) = bytes.clone().try_acquire_many_owned(line.len() as u32) else {
                            let _ = socket
                                .send(Message::Close(Some(CloseFrame {
                                    code: 1013,
                                    reason: "Too many request bytes".into(),
                                })))
                                .await;
                            break 'connection;
                        };
                        let request = serde_json::from_str::<Value>(line);
                        if tasks.len() >= 64 {
                            let _ = socket
                                .send(Message::Close(Some(CloseFrame {
                                    code: 1013,
                                    reason: "Too many requests".into(),
                                })))
                                .await;
                            break 'connection;
                        }
                        let app = app.clone();
                        let owner = owner.clone();
                        let device_id = device_id.clone();
                        let token = token.clone();
                        tasks.spawn(async move {
                            let _permit = permit;
                            handle_request(app, owner, device_id, token, request).await
                        });
                    }
                }
                Some(Ok(Message::Ping(data))) => {
                    if socket.send(Message::Pong(data)).await.is_err() {
                        break;
                    }
                }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                _ => {}
            },
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
        .route("/login", get(login_page))
        .route("/api/auth/providers", get(auth_providers))
        .route("/api/daemon/identity", get(daemon_identity))
        .route("/auth/login", get(browser_login))
        .route("/auth/callback", get(browser_callback))
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
        .layer(axum::middleware::from_fn_with_state(
            app.clone(),
            origin_guard,
        ))
        .with_state(app)
}

// Self-contained sign-in page preserving the existing browser login flow.
#[rustfmt::skip]
const LOGIN_PAGE: &str = r###"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in · Hexbot</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A//www.w3.org/2000/svg%22%20viewBox%3D%220%200%20100%20100%22%20aria-hidden%3D%22true%22%3E%3Cpath%20d%3D%22M44%206a12%2012%200%200%201%2012%200l30%2017a12%2012%200%200%201%206%2010v34a12%2012%200%200%201-6%2010L56%2094a12%2012%200%200%201-12%200L14%2077a12%2012%200%200%201-6-10V33a12%2012%200%200%201%206-10Z%22%20fill%3D%22%23141414%22/%3E%3Crect%20x%3D%2231%22%20y%3D%2235%22%20width%3D%2213%22%20height%3D%2230%22%20rx%3D%226.5%22%20fill%3D%22%23fff%22/%3E%3Crect%20x%3D%2256%22%20y%3D%2235%22%20width%3D%2213%22%20height%3D%2230%22%20rx%3D%226.5%22%20fill%3D%22%23fff%22/%3E%3C/svg%3E">
<style>
  :root { --bg: #fff; --surface: #f5f5f5; --text: #141414; --muted: #767676; --border: #e3e3e3; --danger: #d92d20;
    font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, Inter, 'Segoe UI', sans-serif; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #0e0e0e; --surface: #171717; --text: #f4f4f4; --muted: #8e8e8e; --border: #2a2a2a; --danger: #f4645b; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; background: var(--surface);
    color: var(--text); font-size: 15px; line-height: 1.5; -webkit-font-smoothing: antialiased; }
  main { width: 100%; max-width: 380px; }
  .brand { display: flex; align-items: center; gap: 10px; justify-content: center; margin-bottom: 20px;
    font-weight: 600; font-size: 20px; }
  .brand svg { width: 32px; height: 32px; }
  .card { background: var(--bg); border: 1px solid var(--border); border-radius: 16px; padding: 28px; }
  h1 { margin: 0 0 6px; font-size: 22px; font-weight: 600; letter-spacing: -0.01em; }
  p { margin: 0; color: var(--muted); }
  .stack { display: grid; gap: 12px; margin-top: 22px; }
  .provider-btn { display: block; width: 100%; padding: 11px 16px; border: 0; border-radius: 999px; background: var(--text);
    color: var(--bg); font: inherit; font-weight: 600; text-align: center; text-decoration: none; cursor: pointer; }
  .provider-btn:disabled { opacity: .5; cursor: default; }
  .or { display: flex; align-items: center; gap: 12px; color: var(--muted); font-size: 13px; }
  .or::before, .or::after { content: ""; flex: 1; height: 1px; background: var(--border); }
  form { display: grid; gap: 12px; }
  label { display: grid; gap: 6px; font-size: 13px; font-weight: 500; }
  input { width: 100%; padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg);
    color: var(--text); font: inherit; }
  input:focus { outline: 2px solid var(--text); outline-offset: 1px; }
  .code { font-family: ui-monospace, 'SF Mono', Menlo, monospace; letter-spacing: .12em; text-transform: uppercase; }
  .hint, .form-error { font-size: 13px; }
  .form-error { color: var(--danger); }
  code { font-family: ui-monospace, 'SF Mono', Menlo, monospace; font-size: 13px; }
</style>
</head>
<body>
<main>
  <div class="brand"><svg viewBox="0 0 100 100" aria-hidden="true"><path d="M44 6a12 12 0 0 1 12 0l30 17a12 12 0 0 1 6 10v34a12 12 0 0 1-6 10L56 94a12 12 0 0 1-12 0L14 77a12 12 0 0 1-6-10V33a12 12 0 0 1 6-10Z" fill="currentColor"/><rect x="31" y="35" width="13" height="30" rx="6.5" fill="var(--bg)"/><rect x="56" y="35" width="13" height="30" rx="6.5" fill="var(--bg)"/></svg>Hexbot</div>
  <div class="card">
<h1>Sign in</h1><p>This daemon asks who you are before it lets a new device in.</p><div class="stack"><!--NOTICE--><!--CONNECT-->
<form class="provider-form" data-provider="hexbot"><input type="hidden" name="next" value="<!--NEXT-->">
<label>Device name<input name="username" autocomplete="username" placeholder="My laptop" required></label>
<label>Pairing code<input class="code" name="password" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" placeholder="XXXX-XXXX" required></label>
<div class="form-error" role="alert" hidden></div><button class="provider-btn" type="submit">Sign in with a pairing code</button>
<p class="hint">Get a code in the Hexbot app under Settings, Network, or run <code>hexbot pair</code> where the daemon runs.</p></form></div>
  </div>
</main>
<script>
document.querySelectorAll('form.provider-form').forEach(function (form) {
  form.addEventListener('submit', function (event) {
    event.preventDefault();
    var error = form.querySelector('.form-error'), button = form.querySelector('button');
    error.hidden = true; button.disabled = true;
    var value = function (name) { return form.querySelector('[name=' + name + ']').value; };
    fetch('/auth/password-login', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: form.dataset.provider, username: value('username'), password: value('password'), next: value('next') }) })
      .then(function (response) {
        if (response.ok) return response.json().then(function (data) { window.location.assign((data && data.next) || '/'); });
        throw new Error(response.status === 429 ? 'Too many attempts. Wait a minute and try again.'
          : response.status === 401 ? 'That code did not work. Codes expire after ten minutes.' : 'Sign-in failed. Try again.');
      })
      .catch(function (reason) {
        error.textContent = reason instanceof TypeError ? 'Could not reach the daemon. Try again.' : reason.message;
        error.hidden = false; button.disabled = false;
      });
  });
});
</script>
</body>
</html>
"###;

#[cfg(test)]
mod auth_tests {
    use super::*;
    fn connect_fixture() -> (tempfile::TempDir, Arc<App>) {
        let home = tempfile::tempdir().unwrap();
        let app = App::new(
            home.path().into(),
            "127.0.0.1:9119".parse().unwrap(),
            PathBuf::from("unused"),
            None,
        )
        .unwrap();
        common::atomic_write(
            &home.path().join("connect.json"),
            json!({
                "api_base": "https://connect.hexbot.app",
                "daemon_id": "daemon",
                "owner_id": "alice",
                "issuer": "https://issuer.test",
                "keys": [{}],
                "tunnel_hostname": "owl.hexbot.app"
            })
            .to_string()
            .as_bytes(),
        )
        .unwrap();
        (home, app)
    }
    #[tokio::test]
    async fn daemon_identity_is_tied_to_the_home_and_local_process() {
        let (_home, app) = connect_fixture();
        let host = |value: &str| {
            let mut headers = HeaderMap::new();
            headers.insert("host", value.parse().unwrap());
            headers
        };
        let local = || Some(Extension(ConnectInfo("127.0.0.1:1234".parse().unwrap())));
        let response = daemon_identity(State(app.clone()), local(), host("127.0.0.1:9119")).await;
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(response.into_body(), 4096)
            .await
            .unwrap();
        let identity: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(identity["install_id"], app.install_id().unwrap());
        assert_eq!(identity["pid"], std::process::id());
        for peer in [
            None,
            Some(Extension(ConnectInfo("192.168.1.2:1234".parse().unwrap()))),
        ] {
            assert_eq!(
                daemon_identity(State(app.clone()), peer, host("127.0.0.1:9119"))
                    .await
                    .status(),
                StatusCode::FORBIDDEN
            );
        }
        // cloudflared connects from loopback but forwards the tunnel hostname.
        for value in ["owl.hexbot.app", "owl.hexbot.app:443", "example.com", ""] {
            let headers = if value.is_empty() {
                HeaderMap::new()
            } else {
                host(value)
            };
            assert_eq!(
                daemon_identity(State(app.clone()), local(), headers)
                    .await
                    .status(),
                StatusCode::FORBIDDEN
            );
        }
        for value in ["localhost:9119", "[::1]:9119"] {
            assert_eq!(
                daemon_identity(State(app.clone()), local(), host(value))
                    .await
                    .status(),
                StatusCode::OK
            );
        }
    }

    #[test]
    fn cookies_use_public_https_from_lan_and_trust_connect_only_on_loopback() {
        let (home, app) = connect_fixture();
        let mut headers = HeaderMap::new();
        let local = Some("127.0.0.1:4000".parse().unwrap());
        let remote = Some("192.168.1.2:4000".parse().unwrap());
        headers.insert("host", "localhost:9119".parse().unwrap());
        headers.insert("x-forwarded-proto", "https".parse().unwrap());
        for peer in [None, local, remote] {
            assert!(!secure_request(&app, &headers, peer));
            let cookie = session_cookie(&app, &headers, peer, "fixture");
            assert!(
                cookie
                    .to_str()
                    .unwrap()
                    .starts_with(&format!("{}=", cookie_name(&app)))
            );
            assert!(!cookie.to_str().unwrap().contains("; Secure"));
        }
        headers.insert("host", "OWL.HEXBOT.APP:443".parse().unwrap());
        assert!(secure_request(&app, &headers, local));
        assert!(!secure_request(&app, &headers, remote));
        assert!(
            session_cookie(&app, &headers, local, "fixture")
                .to_str()
                .unwrap()
                .starts_with("__Host-hermes_session_at=")
        );
        common::write_config(
            home.path(),
            &json!({"dashboard":{"public_url":"https://public.test:8443"}}),
        )
        .unwrap();
        headers.insert("host", "public.test:8443".parse().unwrap());
        assert!(secure_request(&app, &headers, local));
        for peer in [None, local, remote] {
            assert!(secure_request(&app, &headers, peer));
            let cookie = session_cookie(&app, &headers, peer, "fixture");
            assert!(
                cookie
                    .to_str()
                    .unwrap()
                    .starts_with("__Host-hermes_session_at=")
            );
            assert!(cookie.to_str().unwrap().contains("; Secure"));
        }
        headers.insert("host", "unconfigured.test".parse().unwrap());
        assert!(!secure_request(&app, &headers, local));
    }
    #[test]
    fn install_identity_preserves_legacy_and_early_native_files() {
        for legacy in [true, false] {
            let home = tempfile::tempdir().unwrap();
            let app = App::new(
                home.path().into(),
                "127.0.0.1:9119".parse().unwrap(),
                "unused".into(),
                None,
            )
            .unwrap();
            let name = if legacy { "install_id" } else { "install-id" };
            std::fs::write(home.path().join(name), "0123456789abcdef0123456789abcdef\n").unwrap();
            if legacy {
                std::fs::write(home.path().join("install-id"), "different-native-id").unwrap();
            }
            assert_eq!(
                app.install_id().unwrap(),
                "0123456789abcdef0123456789abcdef"
            );
            assert_eq!(
                std::fs::read_to_string(home.path().join("install_id"))
                    .unwrap()
                    .trim(),
                app.install_id().unwrap()
            );
        }
        let home = tempfile::tempdir().unwrap();
        let app = App::new(
            home.path().into(),
            "127.0.0.1:9119".parse().unwrap(),
            "unused".into(),
            None,
        )
        .unwrap();
        let tasks: Vec<_> = (0..8)
            .map(|_| {
                let app = app.clone();
                std::thread::spawn(move || app.install_id().unwrap())
            })
            .collect();
        let ids: std::collections::HashSet<_> =
            tasks.into_iter().map(|t| t.join().unwrap()).collect();
        assert_eq!(ids.len(), 1);
        assert!(home.path().join("install_id").is_file());
    }
    #[tokio::test]
    async fn lan_signin_redirects_before_setting_cookie_and_tunnel_logins_are_bounded() {
        let (_home, app) = connect_fixture();
        let mut headers = HeaderMap::new();
        headers.insert("host", "localhost:9119".parse().unwrap());
        let params = HashMap::from([
            ("provider".into(), "connect".into()),
            ("next".into(), "/rooms?x=1".into()),
        ]);
        let response = browser_login(
            State(app.clone()),
            None,
            headers.clone(),
            Query(params.clone()),
        )
        .await;
        assert!(
            response.headers()["location"]
                .to_str()
                .unwrap()
                .starts_with("https://owl.hexbot.app/auth/login?")
        );
        assert!(!response.headers().contains_key("set-cookie"));
        assert!(app.logins.lock().unwrap().is_empty());
        headers.insert("host", "owl.hexbot.app".parse().unwrap());
        headers.insert("cf-connecting-ip", "2001:db8::1".parse().unwrap());
        for _ in 0..8 {
            let response = browser_login(
                State(app.clone()),
                Some(Extension(ConnectInfo("127.0.0.1:4000".parse().unwrap()))),
                headers.clone(),
                Query(params.clone()),
            )
            .await;
            assert!(response.headers().contains_key("set-cookie"));
        }
        headers.insert("cf-connecting-ip", "2001:db8::2".parse().unwrap());
        let response = browser_login(
            State(app.clone()),
            Some(Extension(ConnectInfo("127.0.0.1:4000".parse().unwrap()))),
            headers,
            Query(params),
        )
        .await;
        assert!(!response.headers().contains_key("set-cookie"));
        assert_eq!(app.logins.lock().unwrap().len(), 8);
    }
    #[test]
    fn tunnel_client_keys_trust_only_local_tunnel_requests_and_group_ipv6() {
        let (_home, app) = connect_fixture();
        let mut headers = HeaderMap::new();
        headers.insert("host", "owl.hexbot.app".parse().unwrap());
        headers.insert(
            "cf-connecting-ip",
            "2001:db8:abcd:1234::1234".parse().unwrap(),
        );
        let key = |peer: &str, headers: &HeaderMap| {
            client_address(
                &app,
                Some(Extension(ConnectInfo(peer.parse().unwrap()))),
                headers,
            )
        };
        assert_eq!(key("127.0.0.1:4000", &headers), "2001:db8:abcd:1234::/64");
        assert_eq!(key("192.168.1.2:4000", &headers), "192.168.1.2");
        headers.insert("host", "localhost:9119".parse().unwrap());
        assert_eq!(key("127.0.0.1:4000", &headers), "127.0.0.1");
    }
    #[test]
    fn callback_state_expiry_single_use_and_safe_redirects() {
        let home = tempfile::tempdir().unwrap();
        let app = App::new(
            home.path().to_owned(),
            "127.0.0.1:9119".parse().unwrap(),
            PathBuf::from("unused"),
            None,
        )
        .unwrap();
        let mut headers = HeaderMap::new();
        headers.insert(
            "cookie",
            "hermes_session_pkce=state.verifier".parse().unwrap(),
        );
        let login = |expires| BrowserLogin {
            client: "test".into(),
            verifier: "verifier".into(),
            next: "/rooms".into(),
            expires,
            redirect_uri: "https://fixture.test/auth/callback".into(),
        };
        app.logins
            .lock()
            .unwrap()
            .insert("state".into(), login(common::now() + 60.));
        assert!(take_browser_login(&app, &headers, "wrong").is_err());
        headers.insert("cookie", "hermes_session_pkce=state.wrong".parse().unwrap());
        assert!(take_browser_login(&app, &headers, "state").is_err());
        headers.insert(
            "cookie",
            "hermes_session_pkce=state.verifier".parse().unwrap(),
        );
        assert_eq!(
            take_browser_login(&app, &headers, "state").unwrap().next,
            "/rooms"
        );
        assert!(take_browser_login(&app, &headers, "state").is_err());
        app.logins
            .lock()
            .unwrap()
            .insert("state".into(), login(common::now() - 1.));
        assert!(take_browser_login(&app, &headers, "state").is_err());
        for next in [
            "//evil.test",
            "https://evil.test",
            "/\\evil.test",
            "/\r\nLocation: evil",
        ] {
            assert_eq!(safe_next(next), "/");
        }
        assert_eq!(safe_next("/rooms?tab=recent"), "/rooms?tab=recent");
    }
    #[test]
    fn reads_all_cookie_names_and_rejects_unrelated_local_origins() {
        let home = tempfile::tempdir().unwrap();
        let app = App::new(
            home.path().to_owned(),
            "127.0.0.1:9119".parse().unwrap(),
            PathBuf::from("unused"),
            None,
        )
        .unwrap();
        let mut headers = HeaderMap::new();
        for name in [
            "hermes_session_at_9119",
            "hermes_session_at",
            "__Secure-hermes_session_at",
            "__Host-hermes_session_at",
        ] {
            headers.insert("cookie", format!("{name}=credential").parse().unwrap());
            assert_eq!(cookie(&app, &headers).as_deref(), Some("credential"));
        }
        // Another daemon's cookie on the same host is not this daemon's session.
        headers.insert(
            "cookie",
            "hermes_session_at_9120=credential".parse().unwrap(),
        );
        assert_eq!(cookie(&app, &headers), None);
        headers.insert("host", "127.0.0.1:9119".parse().unwrap());
        for origin in [
            "http://localhost:1111",
            "http://127.0.0.1:1111",
            "https://attacker.test",
        ] {
            headers.insert("origin", origin.parse().unwrap());
            assert!(!valid_origin(&app, &headers));
        }
        for origin in [
            "http://127.0.0.1:9119",
            "http://localhost:9119",
            "hexbot-app://app",
        ] {
            headers.insert("origin", origin.parse().unwrap());
            assert!(valid_origin(&app, &headers));
        }
    }
}
