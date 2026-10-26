//! The bots' computer: one Cua sandbox per daemon, a Linux desktop that every
//! bot with Computer use drives with `computer_use`, and that the user watches,
//! or takes over, from the Computer tab. Bots take turns one action at a time;
//! the daemon remembers where each one last acted, so clients draw a cursor
//! with that bot's face there.
//!
//! The `cua` CLI creates, wakes and removes the sandbox; `cua mcp` carries the
//! bots' actions. The daemon serves the sandbox's viewer at
//! `/hexbot/computer/<token>/`, so every client reaches it through the daemon:
//! on this computer, over LAN or Tailscale, and through Hex Connect.
use crate::{Error, Result, common, connectors, db, events::EventHub};
use axum::{
    body::Body,
    extract::{FromRequestParts, Request, WebSocketUpgrade, ws},
    http::{HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};
use tokio_tungstenite::tungstenite::{self, client::IntoClientRequest};

/// Sizes the user picks, as (name, vCPUs, GB of memory). The computer gets
/// its size when it is created; Reset applies a new one.
pub const SIZES: [(&str, u32, u32); 3] = [("small", 2, 4), ("medium", 4, 8), ("large", 8, 16)];
const DEFAULT_SIZE: &str = "small";
const DEFAULT_IMAGE: &str = "linux";
/// The MCP server name for the computer, one `cua mcp` per bot that uses it.
const SERVER: &str = "hexbot-computer";
const VIEW_TTL: f64 = 3600.;
const WS_LIMIT: usize = 64 * 1024 * 1024;
/// How long a bot waits for its turn before giving up.
const TURN_WAIT: Duration = Duration::from_secs(120);
/// Screenshots are scaled so the long edge is at most 1200 px: a 1280×800
/// desktop until the first screenshot says otherwise.
const DEFAULT_SCREEN: (f64, f64) = (1200., 750.);
/// Environment `cua` needs to find the container engine and its own state.
const PASSED_ENV: [&str; 7] = [
    "DOCKER_HOST",
    "DOCKER_CONTEXT",
    "DOCKER_CONFIG",
    "CUA_HOME",
    "CUA_DEFAULT_ON",
    "CUA_DEFAULT_KIND",
    "CUA_DEFAULT_RUNTIME",
];

/// Where a bot last acted, as fractions of the screen, and what it did there.
#[derive(Clone)]
struct Cursor {
    x: f64,
    y: f64,
    action: String,
    at: f64,
}

/// What the daemon knows about the computer between `cua` calls.
#[derive(Default)]
struct Computer {
    /// The user took over: the bots' actions wait until they give it back.
    user_control: bool,
    /// The bot whose action is in progress, and the action, such as `click`.
    actor: Option<String>,
    activity: Option<String>,
    /// A lifecycle step in progress: starting, stopping, restarting, resetting.
    busy: Option<&'static str>,
    /// The last state `cua` reported, or `absent` before the first look.
    state: Option<&'static str>,
    error: Option<String>,
    cursors: BTreeMap<String, Cursor>,
    /// The size of the bots' screenshots, the space their coordinates are in.
    screen: Option<(f64, f64)>,
}
fn computers() -> &'static Mutex<HashMap<PathBuf, Computer>> {
    static MAP: OnceLock<Mutex<HashMap<PathBuf, Computer>>> = OnceLock::new();
    MAP.get_or_init(Default::default)
}
fn with<T>(home: &Path, f: impl FnOnce(&mut Computer) -> T) -> T {
    let mut map = computers().lock().unwrap_or_else(|e| e.into_inner());
    f(map.entry(home.to_owned()).or_default())
}
type Locks = Mutex<HashMap<PathBuf, Arc<tokio::sync::Mutex<()>>>>;
fn lock_for(locks: &'static OnceLock<Locks>, home: &Path) -> Arc<tokio::sync::Mutex<()>> {
    locks
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .entry(home.to_owned())
        .or_default()
        .clone()
}
/// One lifecycle step at a time.
fn lifecycle(home: &Path) -> Arc<tokio::sync::Mutex<()>> {
    static LOCKS: OnceLock<Locks> = OnceLock::new();
    lock_for(&LOCKS, home)
}
/// One bot's action at a time: the desktop has one pointer and one focus.
fn turns(home: &Path) -> Arc<tokio::sync::Mutex<()>> {
    static LOCKS: OnceLock<Locks> = OnceLock::new();
    lock_for(&LOCKS, home)
}
fn hubs() -> &'static Mutex<HashMap<PathBuf, EventHub>> {
    static HUBS: OnceLock<Mutex<HashMap<PathBuf, EventHub>>> = OnceLock::new();
    HUBS.get_or_init(Default::default)
}
/// Let the computer report changes to the clients of this daemon.
pub fn attach(home: &Path, events: EventHub) {
    hubs()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(home.to_owned(), events);
}

/// The sandbox name: readable in `cua sb ls`, unique per daemon home.
pub fn sandbox(home: &Path) -> String {
    let digest = Sha256::digest(home.display().to_string());
    format!(
        "hexbot-computer-{}",
        digest[..4]
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    )
}

fn credential(env: &BTreeMap<String, String>, name: &str) -> String {
    env.get(name)
        .cloned()
        .or_else(|| std::env::var(name).ok())
        .unwrap_or_default()
}
/// The `cua` program, when this computer has one.
pub fn command(cfg: &Value, env: &BTreeMap<String, String>) -> Option<PathBuf> {
    let configured = cfg["computer_use"]["command"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| credential(env, "HEXBOT_CUA_CMD"));
    crate::native_tools::on_path(if configured.is_empty() {
        "cua"
    } else {
        &configured
    })
}
/// The daemon's settings and credentials; the computer belongs to no one bot.
fn setup(home: &Path) -> Result<(Value, BTreeMap<String, String>)> {
    Ok((
        common::read_config(home)?,
        connectors::profile_credentials(home, home)?,
    ))
}
fn overrides(cfg: &Value) -> serde_json::Map<String, Value> {
    let mut env = serde_json::Map::new();
    for name in PASSED_ENV {
        if let Ok(value) = std::env::var(name) {
            env.insert(name.into(), json!(value));
        }
    }
    if cfg["computer_use"]["telemetry"] != true {
        env.insert("CUA_TELEMETRY".into(), json!("0"));
        env.insert("DO_NOT_TRACK".into(), json!("1"));
    }
    env
}
fn image(cfg: &Value) -> String {
    cfg["computer_use"]["image"]
        .as_str()
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_IMAGE)
        .to_owned()
}
fn size(home: &Path) -> &'static str {
    let chosen = std::fs::read_to_string(home.join("computer.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|v| v["size"].as_str().map(str::to_owned));
    SIZES
        .iter()
        .map(|(name, ..)| *name)
        .find(|name| Some(*name) == chosen.as_deref())
        .unwrap_or(DEFAULT_SIZE)
}

fn unavailable() -> Error {
    Error::new(
        4302,
        "The computer needs Cua on the daemon's computer. Install it with `uv tool install cua`, start Docker, then try again.",
    )
}
/// The last line `cua` printed to stderr, without its log lines and colours.
fn failure(stderr: &str, fallback: &str) -> Error {
    static ANSI: OnceLock<regex::Regex> = OnceLock::new();
    let ansi = ANSI.get_or_init(|| regex::Regex::new(r"\x1b\[[0-9;]*m").unwrap());
    let clean = ansi.replace_all(stderr, "");
    let line = clean
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .rfind(|line| !(line.contains(" WARN ") || line.contains(" INFO ")))
        .unwrap_or(fallback);
    Error::new(
        4211,
        line.trim_start_matches("cua: ")
            .chars()
            .take(400)
            .collect::<String>(),
    )
}
struct Output {
    code: i32,
    stdout: String,
    stderr: String,
}
async fn cua(
    cfg: &Value,
    env: &BTreeMap<String, String>,
    args: &[&str],
    seconds: u64,
) -> Result<Output> {
    let program = command(cfg, env).ok_or_else(unavailable)?;
    let mut cmd = tokio::process::Command::new(program);
    crate::credentials::desktop_environment(&mut cmd);
    for (name, value) in overrides(cfg) {
        cmd.env(name, value.as_str().unwrap_or(""));
    }
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(seconds), cmd.output())
        .await
        .map_err(|_| Error::new(4211, "The computer took too long to answer."))??;
    Ok(Output {
        code: output.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    })
}
fn parse(stdout: &str) -> Result<Value> {
    serde_json::from_str(stdout.trim())
        .or_else(|_| serde_json::from_str(stdout.lines().last().unwrap_or("")))
        .map_err(|_| Error::new(4211, "Cua returned an unreadable answer."))
}
/// What `cua sb info` says, or None when the computer was never created.
async fn info(home: &Path, cfg: &Value, env: &BTreeMap<String, String>) -> Result<Option<Value>> {
    let out = cua(cfg, env, &["sb", "info", &sandbox(home), "--json"], 30).await?;
    match out.code {
        0 => parse(&out.stdout).map(Some),
        3 => Ok(None),
        _ => Err(failure(&out.stderr, "Could not reach the computer.")),
    }
}
fn state(info: Option<&Value>) -> &'static str {
    let Some(info) = info else {
        return "absent";
    };
    match (info["state"].as_str(), info["status"].as_str()) {
        (Some("running"), Some("ready")) => "running",
        (Some("suspended" | "stopped" | "exited" | "paused"), _) => "stopped",
        (Some("failed" | "error"), _) | (_, Some("failed")) => "error",
        _ => "starting",
    }
}

fn snapshot(home: &Path) -> Value {
    with(home, |c| {
        json!({
            "state": c.busy.or(c.state).unwrap_or("absent"),
            "control": if c.user_control { "user" } else { "bot" },
            "actor": c.actor,
            "activity": c.activity,
            "error": c.error,
            "cursors": c.cursors.iter().map(|(bot, cursor)| json!({
                "bot": bot,
                "x": cursor.x,
                "y": cursor.y,
                "action": cursor.action,
                "at": cursor.at,
            })).collect::<Vec<_>>(),
        })
    })
}
/// Tell the daemon's clients what changed. They merge it into the status they hold.
fn changed(home: &Path) {
    let Some(events) = hubs()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(home)
        .cloned()
    else {
        return;
    };
    let owners = db::open(home)
        .and_then(|conn| common::rows(&conn, "SELECT DISTINCT owner_id FROM bots", &[]))
        .unwrap_or_default();
    let payload = snapshot(home);
    for owner in owners {
        if let Some(owner) = owner["owner_id"].as_str() {
            events.emit(owner, None, "hexbot.computer.changed", payload.clone());
        }
    }
}
fn set_busy(home: &Path, busy: Option<&'static str>) {
    with(home, |c| {
        c.busy = busy;
        if busy.is_some() {
            c.error = None;
        }
    });
    changed(home);
}
fn settle(home: &Path, result: &Result<&'static str>) {
    with(home, |c| {
        c.busy = None;
        match result {
            Ok(state) => {
                c.state = Some(state);
                c.error = None;
            }
            Err(error) => c.error = Some(error.message.clone()),
        }
    });
    changed(home);
}

/// Everything a client shows about the computer.
pub async fn status(home: &Path) -> Result<Value> {
    let (cfg, env) = setup(home)?;
    let mut status = json!({
        "available": command(&cfg, &env).is_some(),
        "size": size(home),
        "sizes": SIZES.iter().map(|(name, cpu, memory)| json!({"name":name,"cpu":cpu,"memory_gb":memory})).collect::<Vec<_>>(),
        "image": image(&cfg),
    });
    if status["available"] == true && with(home, |c| c.busy.is_none()) {
        match info(home, &cfg, &env).await {
            Ok(info) => with(home, |c| c.state = Some(state(info.as_ref()))),
            Err(error) => with(home, |c| {
                c.state = Some("error");
                c.error = Some(error.message);
            }),
        }
    }
    for (key, value) in snapshot(home).as_object().into_iter().flatten() {
        status[key] = value.clone();
    }
    Ok(status)
}

async fn create(home: &Path, cfg: &Value, env: &BTreeMap<String, String>) -> Result<()> {
    let (_, cpu, memory) = SIZES
        .iter()
        .find(|(name, ..)| *name == size(home))
        .copied()
        .unwrap_or(SIZES[0]);
    let (name, image, cpu, memory) = (
        sandbox(home),
        image(cfg),
        cpu.to_string(),
        format!("{memory}GB"),
    );
    // The first create downloads the image, which can take a while.
    let out = cua(
        cfg,
        env,
        &[
            "sb", "create", &image, "--name", &name, "--json", "--wait", "desktop", "--cpu", &cpu,
            "--memory", &memory,
        ],
        1800,
    )
    .await?;
    if out.code != 0 {
        return Err(failure(&out.stderr, "The computer could not start."));
    }
    Ok(())
}
async fn remove(home: &Path, cfg: &Value, env: &BTreeMap<String, String>) -> Result<()> {
    let out = cua(cfg, env, &["sb", "rm", "-f", &sandbox(home)], 300).await?;
    if !matches!(out.code, 0 | 3) {
        return Err(failure(&out.stderr, "The computer could not be removed."));
    }
    Ok(())
}
/// Wait for a woken or restarted computer to take input again.
async fn ready(home: &Path, cfg: &Value, env: &BTreeMap<String, String>) -> Result<()> {
    for _ in 0..120 {
        if state(info(home, cfg, env).await?.as_ref()) == "running" {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    Err(Error::new(4211, "The computer did not come back."))
}
/// Close every bot's `cua mcp` and the views: they point at the old machine.
async fn forget(home: &Path) {
    let bots = db::open(home)
        .and_then(|conn| common::rows(&conn, "SELECT name FROM bots", &[]))
        .unwrap_or_default();
    for bot in bots {
        if let Some(bot) = bot["name"].as_str() {
            connectors::close_config(home, bot, SERVER).await;
        }
    }
    views()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .retain(|_, view| view.home != home);
    with(home, |c| {
        c.cursors.clear();
        c.screen = None;
    });
}

/// Turn the computer on: create it the first time, wake it when it sleeps.
async fn ensure(home: &Path, cfg: &Value, env: &BTreeMap<String, String>) -> Result<()> {
    let lock = lifecycle(home);
    let _guard = lock.lock().await;
    let current = match info(home, cfg, env).await {
        Ok(current) => current,
        Err(error) => {
            settle(home, &Err(Error::new(error.code, error.message.clone())));
            return Err(error);
        }
    };
    let found = state(current.as_ref());
    if found == "running" {
        if with(home, |c| c.busy.is_some() || c.state != Some("running")) {
            settle(home, &Ok("running"));
        }
        return Ok(());
    }
    set_busy(home, Some("starting"));
    let mut unfinished = Unfinished { home, armed: true };
    let result = match found {
        "absent" => create(home, cfg, env).await,
        "stopped" => {
            async {
                let out = cua(cfg, env, &["sb", "resume", &sandbox(home)], 120).await?;
                if out.code != 0 {
                    return Err(failure(&out.stderr, "The computer could not wake up."));
                }
                ready(home, cfg, env).await
            }
            .await
        }
        "starting" => ready(home, cfg, env).await,
        // A computer that failed to start is made again.
        _ => {
            async {
                remove(home, cfg, env).await?;
                create(home, cfg, env).await
            }
            .await
        }
    };
    forget(home).await;
    let result = result.map(|_| "running");
    settle(home, &result);
    unfinished.armed = false;
    result.map(|_| ())
}

/// A bot stopped while its first action starts the computer: the start is
/// dropped unfinished, and the computer must not stay busy. Armed only while
/// the busy mark is this start's own.
struct Unfinished<'a> {
    home: &'a Path,
    armed: bool,
}
impl Drop for Unfinished<'_> {
    fn drop(&mut self) {
        if self.armed && with(self.home, |c| c.busy.take().is_some()) {
            changed(self.home);
        }
    }
}

fn busy_word(step: &str) -> &'static str {
    match step {
        "start" => "starting",
        "stop" => "stopping",
        "restart" => "restarting",
        _ => "resetting",
    }
}
async fn lifecycle_step(home: &Path, step: &str) -> Result<()> {
    let (cfg, env) = match setup(home).and_then(|(cfg, env)| {
        command(&cfg, &env).ok_or_else(unavailable)?;
        Ok((cfg, env))
    }) {
        Ok(found) => found,
        Err(error) => {
            settle(home, &Err(Error::new(error.code, error.message.clone())));
            return Err(error);
        }
    };
    if step == "start" {
        return ensure(home, &cfg, &env).await;
    }
    let lock = lifecycle(home);
    let _guard = lock.lock().await;
    // A bot's action finishes first, and no bot acts on the machine meanwhile.
    let _turn = turns(home).lock_owned().await;
    let name = sandbox(home);
    set_busy(home, Some(busy_word(step)));
    let result = async {
        match step {
            "stop" => {
                let out = cua(&cfg, &env, &["sb", "suspend", &name], 120).await?;
                if !matches!(out.code, 0 | 3) {
                    return Err(failure(
                        &out.stderr,
                        "The computer could not be turned off.",
                    ));
                }
                Ok(if out.code == 3 { "absent" } else { "stopped" })
            }
            "restart" => {
                let out = cua(&cfg, &env, &["sb", "restart", &name], 300).await?;
                if out.code != 0 {
                    return Err(failure(&out.stderr, "The computer could not restart."));
                }
                ready(home, &cfg, &env).await?;
                Ok("running")
            }
            "reset" => {
                remove(home, &cfg, &env).await?;
                create(home, &cfg, &env).await?;
                Ok("running")
            }
            _ => Ok("absent"),
        }
    }
    .await;
    forget(home).await;
    release(home);
    settle(home, &result);
    result.map(|_| ())
}

/// A deleted bot leaves the computer; only its cursor goes.
pub async fn forget_bot(home: &Path, bot: &str) {
    connectors::close_config(home, bot, SERVER).await;
    if with(home, |c| c.cursors.remove(bot).is_some()) {
        changed(home);
    }
}

/// `hexbot.computer.*`. The computer is the daemon's, shared by its bots.
pub async fn call(home: &Path, method: &str, p: &Value) -> Option<Result<Value>> {
    if !method.starts_with("hexbot.computer.") {
        return None;
    }
    Some(
        async {
            match method {
                "hexbot.computer.status" => status(home).await,
                // A first start downloads an image; it runs on and reports by event.
                "hexbot.computer.start"
                | "hexbot.computer.stop"
                | "hexbot.computer.restart"
                | "hexbot.computer.reset" => {
                    let step = method.trim_start_matches("hexbot.computer.").to_owned();
                    if with(home, |c| c.busy.is_some()) {
                        return Err(Error::new(
                            4209,
                            "The computer is busy. Try again in a moment.",
                        ));
                    }
                    set_busy(home, Some(busy_word(&step)));
                    let owned = home.to_owned();
                    tokio::spawn(async move {
                        let _ = lifecycle_step(&owned, &step).await;
                    });
                    Ok(snapshot(home))
                }
                "hexbot.computer.control" => {
                    let user = match common::required(p, "holder")? {
                        "user" => true,
                        "bot" => false,
                        _ => return Err(Error::new(4202, "holder must be user or bot")),
                    };
                    if user {
                        with(home, |c| c.user_control = true);
                    } else {
                        release(home);
                    }
                    changed(home);
                    Ok(snapshot(home))
                }
                "hexbot.computer.view" => view(home, p["control"] == true).await,
                "hexbot.computer.configure" => {
                    let chosen = common::required(p, "size")?;
                    if !SIZES.iter().any(|(name, ..)| *name == chosen) {
                        return Err(Error::new(4202, "size must be small, medium or large"));
                    }
                    common::atomic_write(
                        &home.join("computer.json"),
                        json!({"size":chosen}).to_string().as_bytes(),
                    )?;
                    status(home).await
                }
                _ => Err(Error::new(-32601, format!("unknown method: {method}"))),
            }
        }
        .await,
    )
}

/// A link to the computer's screen through this daemon. With `control` the
/// user takes over and the link can type and click; without it, it only watches.
async fn view(home: &Path, control: bool) -> Result<Value> {
    let (cfg, env) = setup(home)?;
    if command(&cfg, &env).is_none() {
        return Err(unavailable());
    }
    let mut args = vec![
        "sb".to_owned(),
        "view".into(),
        sandbox(home),
        "--no-open".into(),
        "--json".into(),
        "--ttl".into(),
        format!("{}s", VIEW_TTL as u64),
    ];
    let held = with(home, |c| c.user_control);
    if control {
        with(home, |c| c.user_control = true);
        changed(home);
    } else {
        args.push("--view-only".into());
    }
    // Taking control is what the user asked for; a link that fails hands it back.
    let made = async {
        let out = cua(
            &cfg,
            &env,
            &args.iter().map(String::as_str).collect::<Vec<_>>(),
            30,
        )
        .await?;
        if out.code == 3 {
            return Err(Error::new(4209, "The computer is off."));
        }
        if out.code != 0 {
            return Err(failure(
                &out.stderr,
                "Could not open the computer's screen.",
            ));
        }
        let link = parse(&out.stdout)?;
        let url = url::Url::parse(link["url"].as_str().unwrap_or(""))
            .map_err(|_| Error::new(4211, "Cua returned no screen link."))?;
        if !matches!(
            url.host_str(),
            Some("127.0.0.1" | "localhost" | "::1" | "[::1]")
        ) {
            return Err(Error::new(
                4211,
                "The computer's screen is not on this machine.",
            ));
        }
        Ok(url)
    }
    .await;
    if control && !held && made.is_err() {
        release(home);
        changed(home);
    }
    let url = made?;
    let upstream = url.origin().ascii_serialization();
    let token = format!("{}{}", common::id(), common::id());
    let expires = common::now() + VIEW_TTL;
    // Checked under the lock `release` holds, so a give-back can't slip between.
    let mut map = views().lock().unwrap_or_else(|e| e.into_inner());
    if control && !with(home, |c| c.user_control) {
        return Err(Error::new(4209, "The computer went back to your bots."));
    }
    map.retain(|_, v| v.expires > common::now());
    map.insert(
        token.clone(),
        View {
            home: home.to_owned(),
            upstream,
            control,
            expires,
        },
    );
    Ok(json!({
        "path": format!("/hexbot/computer/{token}/viewer/#{}", url.fragment().unwrap_or("")),
        "control": control,
        "expires_at": expires,
    }))
}

/// The bots have the computer again: screens that could type stop working.
fn release(home: &Path) {
    let mut map = views().lock().unwrap_or_else(|e| e.into_inner());
    with(home, |c| c.user_control = false);
    map.retain(|_, v| !(v.home == home && v.control));
}

struct View {
    home: PathBuf,
    upstream: String,
    control: bool,
    expires: f64,
}
fn views() -> &'static Mutex<HashMap<String, View>> {
    static VIEWS: OnceLock<Mutex<HashMap<String, View>>> = OnceLock::new();
    VIEWS.get_or_init(Default::default)
}

/// Serve `/hexbot/computer/<token>/...` from the computer's own viewer. The
/// token in the path is the credential: the viewer's calls omit cookies, and
/// the Cua ticket in the page's fragment authorises what it may do.
pub async fn proxy(token: String, request: Request) -> Response {
    let found = views()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&token)
        .filter(|v| v.expires > common::now())
        .map(|v| (v.upstream.clone(), !v.control));
    let Some((upstream, watching)) = found else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let (mut parts, body) = request.into_parts();
    let prefix = format!("/hexbot/computer/{token}/");
    let rest = parts.uri.path().strip_prefix(&prefix).unwrap_or("");
    let query = parts
        .uri
        .query()
        .map(|q| format!("?{q}"))
        .unwrap_or_default();
    let target = format!("{upstream}/{}{query}", rest.trim_start_matches('/'));
    let upgrade = parts
        .headers
        .get("upgrade")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.eq_ignore_ascii_case("websocket"));
    if upgrade {
        return match WebSocketUpgrade::from_request_parts(&mut parts, &()).await {
            Ok(ws) => websocket(ws, target, &parts.headers, token).await,
            Err(rejection) => rejection.into_response(),
        };
    }
    let page = watching && rest == "viewer/";
    forward(parts, body, target, upstream, page).await
}
/// A watching screen is small and takes no input: the viewer's toolbar would
/// only cover it. Its status overlay stays, so a lost stream still says so.
const WATCH_STYLE: &str =
    "<style>.cua-toolbar,.cua-stats,.cua-chips{display:none!important}</style>";

fn proxy_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(10))
            .build()
            .expect("proxy client")
    })
}
const HOP: [&str; 9] = [
    "host",
    "connection",
    "keep-alive",
    "transfer-encoding",
    "upgrade",
    "te",
    "trailer",
    "proxy-authorization",
    "content-length",
];
async fn forward(
    parts: axum::http::request::Parts,
    body: Body,
    target: String,
    upstream: String,
    watch_page: bool,
) -> Response {
    let Ok(body) = axum::body::to_bytes(body, 64 * 1024 * 1024).await else {
        return StatusCode::PAYLOAD_TOO_LARGE.into_response();
    };
    let mut request = proxy_client().request(parts.method.clone(), &target);
    for (name, value) in &parts.headers {
        // Hexbot's own credentials never reach the computer.
        if HOP.contains(&name.as_str()) || matches!(name.as_str(), "cookie" | "origin" | "referer")
        {
            continue;
        }
        request = request.header(name, value);
    }
    if parts.headers.contains_key("origin") {
        request = request.header("origin", &upstream);
    }
    let response = match request.body(body).send().await {
        Ok(response) => response,
        Err(_) => return StatusCode::BAD_GATEWAY.into_response(),
    };
    let mut headers = HeaderMap::new();
    for (name, value) in response.headers() {
        if HOP.contains(&name.as_str()) && name.as_str() != "content-length" {
            continue;
        }
        if name.as_str() == "content-security-policy" {
            headers.insert(name, embeddable(value));
            continue;
        }
        headers.append(name, value.clone());
    }
    let status = response.status();
    let html = headers
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.starts_with("text/html"));
    if watch_page && html && status.is_success() {
        let Ok(page) = crate::http::bytes(
            response,
            1024 * 1024,
            |_| Error::new(4211, "viewer"),
            Error::new(4211, "viewer"),
        )
        .await
        else {
            return StatusCode::BAD_GATEWAY.into_response();
        };
        let page =
            String::from_utf8_lossy(&page).replacen("</head>", &format!("{WATCH_STYLE}</head>"), 1);
        headers.remove("content-length");
        let mut out = Response::new(Body::from(page));
        *out.status_mut() = status;
        *out.headers_mut() = headers;
        return out;
    }
    // Streamed, so server-streaming calls reach the viewer as they happen.
    let stream = futures_util::stream::unfold(response, |mut response| async move {
        match response.chunk().await {
            Ok(Some(chunk)) => Some((Ok::<_, std::io::Error>(chunk), response)),
            Ok(None) => None,
            Err(error) => Some((Err(std::io::Error::other(error)), response)),
        }
    });
    let mut out = Response::new(Body::from_stream(stream));
    *out.status_mut() = status;
    *out.headers_mut() = headers;
    out
}
/// The viewer forbids framing; Hexbot shows it inside its own pages, and in
/// the desktop app, whose pages come from `hexbot-app://` or the dev server.
fn embeddable(policy: &HeaderValue) -> HeaderValue {
    let policy = policy.to_str().unwrap_or("");
    let rewritten = policy
        .split(';')
        .map(str::trim)
        .filter(|part| !part.is_empty() && !part.starts_with("frame-ancestors"))
        .chain(["frame-ancestors 'self' hexbot-app: http://localhost:* http://127.0.0.1:*"])
        .collect::<Vec<_>>()
        .join("; ");
    HeaderValue::from_str(&rewritten)
        .unwrap_or_else(|_| HeaderValue::from_static("frame-ancestors 'self'"))
}

async fn websocket(
    ws: WebSocketUpgrade,
    target: String,
    headers: &HeaderMap,
    token: String,
) -> Response {
    let target = if let Some(rest) = target.strip_prefix("https://") {
        format!("wss://{rest}")
    } else {
        format!("ws://{}", target.trim_start_matches("http://"))
    };
    let Ok(mut request) = target.into_client_request() else {
        return StatusCode::BAD_GATEWAY.into_response();
    };
    if let Some(protocols) = headers.get("sec-websocket-protocol") {
        request
            .headers_mut()
            .insert("sec-websocket-protocol", protocols.clone());
    }
    let config = tungstenite::protocol::WebSocketConfig::default()
        .max_message_size(Some(WS_LIMIT))
        .max_frame_size(Some(WS_LIMIT));
    let Ok((upstream, response)) =
        tokio_tungstenite::connect_async_with_config(request, Some(config), true).await
    else {
        return StatusCode::BAD_GATEWAY.into_response();
    };
    let ws = match response
        .headers()
        .get("sec-websocket-protocol")
        .and_then(|v| v.to_str().ok())
    {
        Some(protocol) => ws.protocols([protocol.to_owned()]),
        None => ws,
    };
    ws.max_message_size(WS_LIMIT)
        .max_frame_size(WS_LIMIT)
        .on_upgrade(move |client| pump(client, upstream, token))
}
async fn pump(
    client: ws::WebSocket,
    upstream: tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    token: String,
) {
    use tungstenite::Message as Up;
    let (mut client_tx, mut client_rx) = client.split();
    let (mut up_tx, mut up_rx) = upstream.split();
    let outbound = async {
        while let Some(Ok(message)) = client_rx.next().await {
            let message = match message {
                ws::Message::Text(text) => Up::Text(text.as_str().into()),
                ws::Message::Binary(bytes) => Up::Binary(bytes),
                ws::Message::Ping(bytes) => Up::Ping(bytes),
                ws::Message::Pong(bytes) => Up::Pong(bytes),
                ws::Message::Close(_) => break,
            };
            if up_tx.send(message).await.is_err() {
                break;
            }
        }
        let _ = up_tx.close().await;
    };
    let inbound = async {
        while let Some(Ok(message)) = up_rx.next().await {
            let message = match message {
                Up::Text(text) => ws::Message::Text(text.as_str().into()),
                Up::Binary(bytes) => ws::Message::Binary(bytes),
                Up::Ping(bytes) => ws::Message::Ping(bytes),
                Up::Pong(bytes) => ws::Message::Pong(bytes),
                Up::Close(_) => break,
                Up::Frame(_) => continue,
            };
            if client_tx.send(message).await.is_err() {
                break;
            }
        }
        let _ = client_tx.close().await;
    };
    // Giving the computer back, or the link expiring, ends an open screen too.
    let revoked = async {
        loop {
            tokio::time::sleep(Duration::from_secs(1)).await;
            let live = views()
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get(&token)
                .is_some_and(|v| v.expires > common::now());
            if !live {
                break;
            }
        }
    };
    tokio::select! {
        _ = outbound => {},
        _ = inbound => {},
        _ = revoked => {},
    }
}

// ---- The bots' side: the `computer_use` tool ----

/// The tool a bot with Computer use gets. The computer is the bots' own:
/// nothing done there touches the user's computer or a workspace.
pub fn descriptor() -> Value {
    let point = json!({"type":"array","items":{"type":"integer"},"minItems":2,"maxItems":2});
    json!({
        "name": "computer_use",
        "description": "Use the computer your bots share: a Linux desktop with a browser and a terminal, separate from the user's computer and your workspace. It starts on first use. Other bots may work on it too, one action at a time, and the user can watch and take over, so look before you act. Start with screenshot; coordinates are pixels in the latest screenshot. After an action that changes the screen, look again, or pass capture_after. Use shell for installs and files on that computer and open for a URL. If the user has taken over, wait for them to hand it back.",
        "parameters": {
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["screenshot", "click", "double_click", "right_click", "middle_click", "move", "drag", "scroll", "type", "key", "open", "launch", "windows", "shell", "wait"]
                },
                "coordinate": point,
                "to_coordinate": point,
                "text": { "type": "string", "description": "Text to type" },
                "keys": { "type": "string", "description": "A key such as enter, or a shortcut such as ctrl+l" },
                "direction": { "type": "string", "enum": ["up", "down", "left", "right"] },
                "amount": { "type": "integer", "minimum": 1, "maximum": 50 },
                "url": { "type": "string", "description": "URL or file path for open" },
                "app": { "type": "string", "description": "Application for launch, such as firefox" },
                "command": { "type": "string", "description": "Shell command for shell; runs on that computer, 30 s limit; start longer jobs in the background" },
                "seconds": { "type": "number", "minimum": 0, "maximum": 30 },
                "capture_after": { "type": "boolean" }
            },
            "required": ["action"]
        }
    })
}

/// The bot's name as people see it.
fn display_name(home: &Path, bot: &str) -> String {
    db::open(home)
        .ok()
        .and_then(|conn| {
            conn.query_row("SELECT display_name FROM bots WHERE name=?", [bot], |r| {
                r.get::<_, Option<String>>(0)
            })
            .ok()
            .flatten()
        })
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| bot.to_owned())
}

/// Ends a bot's turn however the action ends, cancelled included.
struct Acting<'a> {
    home: &'a Path,
}
impl Drop for Acting<'_> {
    fn drop(&mut self) {
        with(self.home, |c| {
            c.actor = None;
            c.activity = None;
        });
        changed(self.home);
    }
}

fn point(args: &Value, key: &str) -> Result<(i64, i64)> {
    args[key]
        .as_array()
        .filter(|v| v.len() == 2)
        .and_then(|v| Some((v[0].as_i64()?, v[1].as_i64()?)))
        .ok_or_else(|| Error::new(4200, format!("{key} must be [x, y]")))
}
/// The width and height of a screenshot's PNG, read from its header.
fn png_size(result: &Value) -> Option<(f64, f64)> {
    let data = result["content"]
        .as_array()?
        .iter()
        .find(|v| v["type"] == "image")?["data"]
        .as_str()?;
    let head = STANDARD.decode(data.get(..32)?).ok()?;
    if head.get(..8)? != b"\x89PNG\r\n\x1a\n" {
        return None;
    }
    let side = |at: usize| Some(u32::from_be_bytes(head.get(at..at + 4)?.try_into().ok()?) as f64);
    Some((side(16)?, side(20)?)).filter(|(w, h)| *w > 0. && *h > 0.)
}
/// Put a bot's cursor where it acts, or keep it where it was and say what it
/// does. A bot whose first action has no place, such as a screenshot, starts
/// in the middle of the screen, so it shows from its first action.
fn aim(home: &Path, bot: &str, action: &str, at: Option<(i64, i64)>) {
    with(home, |c| {
        let (width, height) = c.screen.unwrap_or(DEFAULT_SCREEN);
        let previous = c.cursors.get(bot).map(|cursor| (cursor.x, cursor.y));
        let (x, y) = at
            .map(|(x, y)| {
                (
                    (x as f64 / width).clamp(0., 1.),
                    (y as f64 / height).clamp(0., 1.),
                )
            })
            .or(previous)
            .unwrap_or((0.5, 0.5));
        c.cursors.insert(
            bot.to_owned(),
            Cursor {
                x,
                y,
                action: action.to_owned(),
                at: common::now(),
            },
        );
    });
}

pub async fn act(
    home: &Path,
    bot: &str,
    cfg: &Value,
    env: &BTreeMap<String, String>,
    args: &Value,
) -> Result<Value> {
    let action = common::required(args, "action")?;
    if action == "wait" {
        let seconds = args["seconds"].as_f64().unwrap_or(1.);
        if !(0. ..=30.).contains(&seconds) {
            return Err(Error::new(4202, "wait seconds must be between 0 and 30"));
        }
        tokio::time::sleep(Duration::from_secs_f64(seconds)).await;
        return Ok(json!({"ok":true,"action":"wait"}));
    }
    let (tool, params) = match action {
        "screenshot" => ("computer_screenshot", json!({})),
        "click" | "right_click" | "middle_click" => {
            let (x, y) = point(args, "coordinate")?;
            let button = match action {
                "right_click" => "right",
                "middle_click" => "middle",
                _ => "left",
            };
            ("computer_click", json!({"x":x,"y":y,"button":button}))
        }
        "double_click" => {
            let (x, y) = point(args, "coordinate")?;
            ("computer_double_click", json!({"x":x,"y":y}))
        }
        "move" => {
            let (x, y) = point(args, "coordinate")?;
            ("computer_move_cursor", json!({"x":x,"y":y}))
        }
        "drag" => {
            let (start_x, start_y) = point(args, "coordinate")?;
            let (end_x, end_y) = point(args, "to_coordinate")?;
            (
                "computer_drag",
                json!({"start_x":start_x,"start_y":start_y,"end_x":end_x,"end_y":end_y}),
            )
        }
        "scroll" => (
            "computer_scroll",
            json!({
                "direction": args["direction"].as_str().unwrap_or("down"),
                "amount": args["amount"].as_u64().unwrap_or(3).clamp(1, 50),
            }),
        ),
        "type" => (
            "computer_type",
            json!({"text":common::required(args, "text")?}),
        ),
        "key" => {
            let keys = common::required(args, "keys")?.trim();
            if keys.contains('+') {
                ("computer_hotkey", json!({"keys":keys}))
            } else {
                ("computer_key", json!({"key":keys}))
            }
        }
        "open" => (
            "computer_window_open",
            json!({"path":common::required(args, "url")?}),
        ),
        "launch" => (
            "computer_launch",
            json!({"app":common::required(args, "app")?}),
        ),
        "windows" => ("computer_window_list", json!({})),
        "shell" => (
            "computer_shell",
            json!({"command":common::required(args, "command")?}),
        ),
        _ => {
            return Err(Error::new(
                4202,
                format!("unknown computer action: {action}"),
            ));
        }
    };
    let taken_over = || {
        Error::new(
            4302,
            "The user has taken over the computer. Wait until they hand it back before using it again, and ask what changed if it matters.",
        )
    };
    if with(home, |c| c.user_control) {
        return Err(taken_over());
    }
    if command(cfg, env).is_none() {
        return Err(unavailable());
    }
    ensure(home, cfg, env).await?;
    // Other bots finish their action first; the desktop has one pointer.
    let turn = tokio::time::timeout(TURN_WAIT, turns(home).lock_owned())
        .await
        .map_err(|_| Error::new(4209, "Another bot kept the computer busy. Try again."))?;
    if with(home, |c| c.user_control) {
        return Err(taken_over());
    }
    let at = point(args, "coordinate").ok();
    aim(home, bot, action, at);
    with(home, |c| {
        c.actor = Some(bot.to_owned());
        c.activity = Some(action.to_owned());
    });
    changed(home);
    let _acting = Acting { home };
    let turn = Arc::new(turn);
    let server = json!({
        "command": command(cfg, env).ok_or_else(unavailable)?,
        "args": ["mcp", "--sandbox", sandbox(home), "--permissions", "computer:all"],
        "isolated_env": true,
        "env": overrides(cfg),
        "client_name": display_name(home, bot),
    });
    if action == "scroll"
        && let Some((x, y)) = at
    {
        request(
            home,
            bot,
            &server,
            "computer_move_cursor",
            json!({"x":x,"y":y}),
            &turn,
        )
        .await?;
    }
    let result = request(home, bot, &server, tool, params, &turn).await?;
    if action == "drag" {
        aim(home, bot, action, point(args, "to_coordinate").ok());
    }
    let look = |result: Value| {
        if let Some(screen) = png_size(&result) {
            with(home, |c| c.screen = Some(screen));
        }
        crate::native_tools::save_capture(home, bot, result)
    };
    if action == "screenshot" {
        return look(result);
    }
    if args["capture_after"] == true {
        // Let the screen draw what the action did.
        tokio::time::sleep(Duration::from_millis(500)).await;
        let capture =
            look(request(home, bot, &server, "computer_screenshot", json!({}), &turn).await?)?;
        let mut content = result["content"].as_array().cloned().unwrap_or_default();
        content.extend(capture["content"].as_array().cloned().unwrap_or_default());
        return Ok(json!({"content":content,"screenshot_path":capture["screenshot_path"]}));
    }
    Ok(result)
}
/// One call to the computer. It runs to its end even if the bot is stopped,
/// and keeps the turn until then, so no other bot acts on the screen meanwhile.
async fn request(
    home: &Path,
    bot: &str,
    server: &Value,
    tool: &str,
    args: Value,
    turn: &Arc<tokio::sync::OwnedMutexGuard<()>>,
) -> Result<Value> {
    let (home, bot, server, name) = (
        home.to_owned(),
        bot.to_owned(),
        server.clone(),
        tool.to_owned(),
    );
    let held = turn.clone();
    let result = tokio::spawn(async move {
        let _held = held;
        connectors::mcp_call_config(&home, &bot, SERVER, &server, &name, args).await
    })
    .await
    .map_err(|_| Error::new(4211, "The computer action stopped unexpectedly."))??;
    if result["isError"] == true {
        return Err(Error::new(
            4211,
            format!(
                "computer action {tool} failed: {}",
                result["content"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|v| v["text"].as_str())
                    .collect::<Vec<_>>()
                    .join("\n")
            ),
        ));
    }
    Ok(result)
}
