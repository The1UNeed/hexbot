//! Discord: a bot joins Discord servers as its own Discord app.
//!
//! The user makes a Discord app for a bot, pastes its token, and adds it to
//! servers with the invite link. The daemon keeps one Gateway connection per
//! connected bot (an outbound WebSocket, so no public address is needed).
//! The first time someone mentions the bot in a channel, that channel becomes
//! a Hexbot room the owner can watch: everything said there afterwards lands in
//! the room, the room engine decides who answers, and each bot's reply goes
//! back to Discord as that bot. Each bot keeps its own room session, so what a
//! Discord channel says reaches only the bots in it.
//!
//! People in a Discord channel are not the owner. A Discord room is locked to
//! Manual, its sessions get only `TOOLS`, notes are the only memory they can
//! write, and their prompt leaves out About you (`SECURITY.md`).
use crate::{Error, Result, common::*, db, events::EventHub, rooms::RoomEngine};
use futures_util::{SinkExt, StreamExt};
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

/// The only tools a bot has in a Discord room: notes, and the web.
pub const TOOLS: &[&str] = &["memory", "web_search", "web_extract"];
/// What a note taken in a Discord room is filed under for the bot's dream,
/// which treats it as untrusted, like a scheduled job's proposal.
pub const PROPOSAL_SOURCE: &str = "discord";
const API: &str = "https://discord.com/api/v10";
const GATEWAY: &str = "wss://gateway.discord.gg";
/// Guilds, guild messages and message content.
const INTENTS: u64 = 1 | (1 << 9) | (1 << 15);
/// View channels, send messages, read message history, send in threads.
const PERMISSIONS: u64 = (1 << 10) | (1 << 11) | (1 << 16) | (1 << 38);
/// GATEWAY_MESSAGE_CONTENT and GATEWAY_MESSAGE_CONTENT_LIMITED.
const CONTENT_FLAGS: u64 = (1 << 18) | (1 << 19);
/// Messages before the first mention a new room starts with.
const HISTORY: usize = 20;
/// How long before the mention that opens a room another mention may still be
/// on its way through another bot's connection (`open_room`).
const IN_FLIGHT_MS: u64 = 60_000;
const LIMIT: usize = 2000;

pub const TOKEN_REFUSED: i64 = 4250;
pub const NOT_IN_DISCORD: i64 = 4251;
pub const TAKEN: i64 = 4252;
pub const INTENT: i64 = 4253;
/// Discord can't be reached or is having trouble: what was being sent waits.
const OFFLINE: i64 = 5250;
const INTENT_TEXT: &str =
    "Turn on Message Content Intent under Bot in the Discord Developer Portal, then connect again.";
const REFUSED_TEXT: &str = "Discord didn't accept this token. Reset it under Bot in the Discord Developer Portal and paste the new one.";

pub(crate) const DISCORD_ROOM_TEXT: &str = "This room is in Discord. Reply there.";

/// A failure that passes: what was being posted waits and is tried again.
fn waits(error: &Error) -> bool {
    error.code == OFFLINE
        || error
            .data
            .as_ref()
            .is_some_and(|data| data["transient"] == true)
}

/// Whether a stored session is a bot's conversation in a Discord room.
pub fn public_session(home: &Path, stored: &str) -> Result<bool> {
    Ok(db::open(home)?.query_row(
        "SELECT EXISTS(SELECT 1 FROM room_sessions s JOIN discord_channels d ON d.room_id=s.room_id WHERE s.stored_session_id=?)",
        [stored],
        |r| r.get(0),
    )?)
}

/// The Discord channel a room mirrors, or null.
pub(crate) fn room_info(conn: &rusqlite::Connection, room: &str) -> Result<Value> {
    Ok(rows(
        conn,
        "SELECT guild_id,channel_id,guild_name,channel_name FROM discord_channels WHERE room_id=?",
        &[&room],
    )?
    .into_iter()
    .next()
    .map(|mut row| {
        row["url"] = json!(format!(
            "https://discord.com/channels/{}/{}",
            row["guild_id"].as_str().unwrap_or(""),
            row["channel_id"].as_str().unwrap_or("")
        ));
        row
    })
    .unwrap_or(Value::Null))
}

/// A Discord room is being deleted: its channel remembers when, so a room it
/// opens again doesn't take what was said before as new (`open_room`).
pub(crate) fn closing(conn: &rusqlite::Connection, room: &str) -> Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO discord_closed(channel_id,closed_at) SELECT channel_id,? FROM discord_channels WHERE room_id=?",
        params![now(), room],
    )?;
    Ok(())
}

pub(crate) fn is_room(conn: &rusqlite::Connection, room: &str) -> Result<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM discord_channels WHERE room_id=?)",
        [room],
        |r| r.get(0),
    )?)
}

/// What the room session sees as a speaker: a display name that cannot pose
/// as a bot, the system, or a second line.
pub(crate) fn speaker(name: &str) -> String {
    let clean: String = name
        .chars()
        .filter(|c| !c.is_control() && !matches!(c, '@' | ':' | '[' | ']'))
        .collect();
    let clean = clean.trim();
    if clean.is_empty() {
        "Someone".into()
    } else {
        clean.chars().take(40).collect()
    }
}

fn token_path(home: &Path, bot: &str) -> PathBuf {
    home.join("accounts")
        .join("discord")
        .join(format!("{bot}.json"))
}
fn read_token(home: &Path, bot: &str) -> Option<String> {
    let bytes = std::fs::read(token_path(home, bot)).ok()?;
    serde_json::from_slice::<Value>(&bytes).ok()?["token"]
        .as_str()
        .filter(|t| !t.is_empty())
        .map(str::to_owned)
}
fn write_token(home: &Path, bot: &str, token: &str) -> Result<()> {
    let file = token_path(home, bot);
    let dir = file.parent().expect("discord dir");
    std::fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(
            home.join("accounts"),
            std::fs::Permissions::from_mode(0o700),
        )?;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    atomic_write(&file, json!({"token":token}).to_string().as_bytes())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

pub fn invite_url(application: &str) -> String {
    format!(
        "https://discord.com/oauth2/authorize?client_id={application}&scope=bot&permissions={PERMISSIONS}"
    )
}

/// Inbound text as the room reads it: a mention of a connected bot becomes
/// its handle; anyone else's becomes their name, never a handle in the room.
pub(crate) fn inbound_text(message: &Value, ours: &HashMap<String, String>) -> String {
    let mut names = HashMap::new();
    for m in message["mentions"].as_array().into_iter().flatten() {
        if let Some(id) = m["id"].as_str() {
            let name = m["global_name"]
                .as_str()
                .or(m["username"].as_str())
                .unwrap_or("someone");
            names.insert(id.to_owned(), speaker(name));
        }
    }
    let handles: HashSet<String> = ours.values().map(|h| h.to_lowercase()).collect();
    let text = message["content"].as_str().unwrap_or("");
    let pattern = regex::Regex::new(r"<(@!?|@&|#)(\d+)>").unwrap();
    let mut out = pattern
        .replace_all(text, |c: &regex::Captures| {
            let id = &c[2];
            match &c[1] {
                "#" => "#channel".to_owned(),
                "@&" => "@role".to_owned(),
                _ => match ours.get(id) {
                    Some(handle) => format!("@{handle}"),
                    None => {
                        let name = names.get(id).cloned().unwrap_or_else(|| "someone".into());
                        // A person named like a bot must not summon it.
                        if handles.contains(&name.to_lowercase()) {
                            name
                        } else {
                            format!("@{name}")
                        }
                    }
                },
            }
        })
        .into_owned();
    for a in message["attachments"].as_array().into_iter().flatten() {
        if let (Some(name), Some(url)) = (a["filename"].as_str(), a["url"].as_str()) {
            out.push_str(&format!("\n[{}]({url})", speaker(name)));
        }
    }
    out.trim().to_owned()
}

/// The connected bots a message speaks to: the ones it mentions and, when a
/// person wrote it, the one it replies to. The reply link on a bot's own post
/// is Hexbot's, not the bot's choice, so it doesn't count.
fn addressed(message: &Value, ours: &HashMap<String, String>) -> Vec<String> {
    let mut addressed: Vec<String> = vec![];
    for m in message["mentions"].as_array().into_iter().flatten() {
        if let Some(handle) = m["id"].as_str().and_then(|id| ours.get(id)) {
            addressed.push(handle.clone());
        }
    }
    let own = message["author"]["id"]
        .as_str()
        .is_some_and(|id| ours.contains_key(id));
    if !own
        && let Some(handle) = message["referenced_message"]["author"]["id"]
            .as_str()
            .and_then(|id| ours.get(id))
    {
        addressed.push(handle.clone());
    }
    addressed.sort();
    addressed.dedup();
    addressed
}

/// Whether a message turns its channel into a room: a person, not a bot,
/// speaks to one of the owner's connected bots.
fn opens_room(message: &Value, ours: &HashMap<String, String>) -> bool {
    let author = message["author"]["id"].as_str().unwrap_or("");
    !ours.contains_key(author)
        && message["author"]["bot"] != true
        && !addressed(message, ours).is_empty()
}

/// When the channel's last Discord room was deleted, in Unix milliseconds.
fn closed_at(conn: &rusqlite::Connection, channel: &str) -> Result<Option<u64>> {
    Ok(conn
        .query_row(
            "SELECT closed_at FROM discord_closed WHERE channel_id=?",
            [channel],
            |r| r.get::<_, f64>(0),
        )
        .optional()?
        .map(|closed| (closed * 1000.0) as u64))
}

/// When a Discord message was sent, in Unix milliseconds, from its id.
fn sent_at(id: &str) -> Option<u64> {
    const DISCORD_EPOCH: u64 = 1_420_070_400_000;
    id.parse::<u64>().ok().map(|id| (id >> 22) + DISCORD_EPOCH)
}

/// A reply as Discord shows it: handles of connected bots become mentions,
/// cut into messages Discord accepts, at line ends where it can.
pub(crate) fn outbound(text: &str, ours: &HashMap<String, String>) -> (Vec<String>, Vec<String>) {
    let by_handle: HashMap<String, &String> = ours
        .iter()
        .map(|(id, handle)| (handle.to_lowercase(), id))
        .collect();
    let mut users = vec![];
    let pattern = regex::Regex::new(r"(^|[^\w-])@([\w-]+)").unwrap();
    let text = pattern
        .replace_all(text, |c: &regex::Captures| {
            match by_handle.get(&c[2].to_lowercase()) {
                Some(id) => {
                    if !users.contains(*id) {
                        users.push((*id).clone());
                    }
                    format!("{}<@{id}>", &c[1])
                }
                None => c[0].to_owned(),
            }
        })
        .into_owned();
    let mut chunks = vec![];
    let mut rest = text.trim();
    while !rest.is_empty() {
        if rest.chars().count() <= LIMIT {
            chunks.push(rest.to_owned());
            break;
        }
        let hard = rest
            .char_indices()
            .nth(LIMIT)
            .map_or(rest.len(), |(i, _)| i);
        let cut = rest[..hard]
            .rfind('\n')
            .filter(|i| *i > hard / 2)
            .or_else(|| rest[..hard].rfind(' ').filter(|i| *i > hard / 2))
            .unwrap_or(hard);
        chunks.push(rest[..cut].trim_end().to_owned());
        rest = rest[cut..].trim_start();
    }
    (chunks, users)
}

enum End {
    /// Connect again, resuming when Discord allows it.
    Again,
    /// Wait, then connect again.
    Retry(String),
    /// Stop until the user connects again.
    Stop(String),
}

struct Resume {
    session: String,
    url: String,
    seq: Option<u64>,
}

pub struct Discord {
    home: PathBuf,
    events: EventHub,
    rooms: Arc<RoomEngine>,
    client: reqwest::Client,
    api: String,
    gateway: String,
    links: Mutex<HashMap<String, tokio::task::AbortHandle>>,
    inbox: Mutex<Option<mpsc::UnboundedSender<(String, Value)>>>,
    outbox: Mutex<Option<mpsc::UnboundedSender<String>>>,
    tasks: Mutex<Vec<tokio::task::AbortHandle>>,
    /// Rooms whose replies wait for Discord, and how long they wait.
    retrying: Mutex<std::collections::HashSet<String>>,
    retry: std::sync::atomic::AtomicU64,
}

impl Discord {
    pub fn new(home: PathBuf, events: EventHub, rooms: Arc<RoomEngine>) -> Arc<Self> {
        Self::with_endpoints(home, events, rooms, API, GATEWAY)
    }
    pub fn with_endpoints(
        home: PathBuf,
        events: EventHub,
        rooms: Arc<RoomEngine>,
        api: &str,
        gateway: &str,
    ) -> Arc<Self> {
        Arc::new(Self {
            home,
            events,
            rooms,
            client: crate::http::client(30, 0).expect("HTTP client"),
            api: api.trim_end_matches('/').to_owned(),
            gateway: gateway.trim_end_matches('/').to_owned(),
            links: Mutex::default(),
            inbox: Mutex::default(),
            outbox: Mutex::default(),
            tasks: Mutex::default(),
            retrying: Mutex::default(),
            retry: 30_000.into(),
        })
    }

    /// How long replies wait after Discord couldn't take them. Tests shorten it.
    pub fn retry_every(&self, wait: Duration) {
        self.retry.store(
            wait.as_millis() as u64,
            std::sync::atomic::Ordering::Relaxed,
        );
    }

    fn retry_wait(&self) -> Duration {
        Duration::from_millis(self.retry.load(std::sync::atomic::Ordering::Relaxed))
    }

    /// Post the room's replies again once Discord may be back.
    fn retry_later(self: &Arc<Self>, room: &str) {
        if !self.retrying.lock().unwrap().insert(room.to_owned()) {
            return;
        }
        let me = self.clone();
        let room = room.to_owned();
        let task = tokio::spawn(async move {
            tokio::time::sleep(me.retry_wait()).await;
            me.retrying.lock().unwrap().remove(&room);
            if let Some(outbox) = me.outbox.lock().unwrap().as_ref() {
                let _ = outbox.send(room);
            }
        });
        let mut tasks = self.tasks.lock().unwrap();
        tasks.retain(|t| !t.is_finished());
        tasks.push(task.abort_handle());
    }

    /// Start the workers and every connected bot's Gateway connection.
    pub async fn start(self: &Arc<Self>) -> Result<()> {
        let (inbox, mut incoming) = mpsc::unbounded_channel::<(String, Value)>();
        let (outbox, mut outgoing) = mpsc::unbounded_channel::<String>();
        *self.inbox.lock().unwrap() = Some(inbox);
        *self.outbox.lock().unwrap() = Some(outbox.clone());
        let mut tasks = vec![];
        // One worker takes every channel's messages in the order they came,
        // whichever bot's connection saw them first.
        let me = self.clone();
        tasks.push(
            tokio::spawn(async move {
                while let Some((bot, message)) = incoming.recv().await {
                    me.take(&bot, &message).await;
                }
            })
            .abort_handle(),
        );
        let me = self.clone();
        tasks.push(
            tokio::spawn(async move {
                while let Some(room) = outgoing.recv().await {
                    if let Err(error) = me.flush(&room).await {
                        eprintln!("Discord: could not post in room {room}: {}", error.message);
                        if waits(&error) {
                            me.retry_later(&room);
                        }
                    }
                }
            })
            .abort_handle(),
        );
        // Room events only wake the outbox; what was posted is in the database,
        // so a missed event or a restart never loses or repeats a reply.
        let me = self.clone();
        let mut hub = self.events.subscribe();
        tasks.push(
            tokio::spawn(async move {
                loop {
                    match hub.recv().await {
                        Ok(event) => {
                            let p = &event.frame["params"];
                            if p["type"] != "hexbot.rooms.event" {
                                continue;
                            }
                            let room = p["payload"]["room_id"].as_str().unwrap_or("");
                            let e = &p["payload"]["event"];
                            match e["kind"].as_str() {
                                Some("message.bot") => {
                                    let _ = outbox.send(room.to_owned());
                                }
                                // Its own task, so Discord trouble never holds up posting.
                                Some("turn.started") => {
                                    let me = me.clone();
                                    let room = room.to_owned();
                                    let bot = e["actor_id"].as_str().unwrap_or("").to_owned();
                                    tokio::spawn(async move { me.typing(&room, &bot).await });
                                }
                                _ => {}
                            }
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                            me.flush_all();
                        }
                        Err(_) => break,
                    }
                }
            })
            .abort_handle(),
        );
        *self.tasks.lock().unwrap() = tasks;
        self.flush_all();
        let bots = rows(
            &db::open(&self.home)?,
            "SELECT bot FROM discord_bots ORDER BY bot",
            &[],
        )?;
        for row in bots {
            let bot = required(&row, "bot")?;
            match read_token(&self.home, bot) {
                Some(token) => self.link(bot, token),
                None => self.set_status(bot, "error", Some("Paste the bot's token again.")),
            }
        }
        Ok(())
    }

    pub async fn shutdown(&self) {
        for (_, link) in self.links.lock().unwrap().drain() {
            link.abort();
        }
        for task in self.tasks.lock().unwrap().drain(..) {
            task.abort();
        }
    }

    fn flush_all(&self) {
        let Some(outbox) = self.outbox.lock().unwrap().clone() else {
            return;
        };
        if let Ok(conn) = db::open(&self.home)
            && let Ok(rooms) = rows(&conn, "SELECT room_id FROM discord_channels", &[])
        {
            for room in rooms {
                if let Some(id) = room["room_id"].as_str() {
                    let _ = outbox.send(id.to_owned());
                }
            }
        }
    }

    pub async fn call(
        self: &Arc<Self>,
        owner: &str,
        method: &str,
        p: &Value,
    ) -> Option<Result<Value>> {
        if !method.starts_with("hexbot.discord.") {
            return None;
        }
        Some(
            async {
                user(&self.home, owner)?;
                match method {
                    "hexbot.discord.list" => Ok(json!({"bots": self.list(owner)?})),
                    "hexbot.discord.get" => {
                        let bot = required(p, "bot")?;
                        bot_owner(&self.home, owner, bot)?;
                        Ok(json!({"discord": self.status(bot)?}))
                    }
                    "hexbot.discord.connect" => {
                        let bot = required(p, "bot")?;
                        bot_owner(&self.home, owner, bot)?;
                        let token = required(p, "token")?.trim();
                        let token = token.strip_prefix("Bot ").unwrap_or(token).trim();
                        self.connect(owner, bot, token).await?;
                        Ok(json!({"discord": self.status(bot)?}))
                    }
                    "hexbot.discord.disconnect" => {
                        let bot = required(p, "bot")?;
                        bot_owner(&self.home, owner, bot)?;
                        self.forget(bot)?;
                        Ok(json!({"discord": Value::Null}))
                    }
                    _ => Err(Error::new(-32601, format!("unknown method: {method}"))),
                }
            }
            .await,
        )
    }

    fn list(&self, owner: &str) -> Result<Vec<Value>> {
        let names = rows(
            &db::open(&self.home)?,
            "SELECT d.bot FROM discord_bots d JOIN bots b ON b.name=d.bot WHERE b.owner_id=? ORDER BY d.bot",
            &[&owner],
        )?;
        names
            .iter()
            .filter_map(|row| row["bot"].as_str())
            .map(|bot| self.status(bot))
            .collect()
    }

    /// What the app shows for a bot: its Discord app, its state, and the link
    /// that adds it to a server. Null when it has no Discord app.
    fn status(&self, bot: &str) -> Result<Value> {
        let conn = db::open(&self.home)?;
        let Some(mut row) = rows(
            &conn,
            "SELECT bot,application_id,user_id,username,status,error,connected_at FROM discord_bots WHERE bot=?",
            &[&bot],
        )?
        .into_iter()
        .next() else {
            return Ok(Value::Null);
        };
        row["invite_url"] = json!(invite_url(row["application_id"].as_str().unwrap_or("")));
        row["rooms"] = json!(rows(
            &conn,
            "SELECT d.room_id AS id,d.guild_name,d.channel_name FROM discord_channels d JOIN room_members m ON m.room_id=d.room_id AND m.member_kind='bot' AND m.member_id=? AND m.left_at IS NULL ORDER BY d.guild_name,d.channel_name",
            &[&bot],
        )?);
        Ok(row)
    }

    fn set_status(&self, bot: &str, status: &str, error: Option<&str>) {
        let Ok(conn) = db::open(&self.home) else {
            return;
        };
        let owner: Option<String> = conn
            .query_row(
                "SELECT owner_id FROM discord_bots WHERE bot=?",
                [bot],
                |r| r.get(0),
            )
            .optional()
            .ok()
            .flatten();
        let changed = conn
            .execute(
                "UPDATE discord_bots SET status=?,error=?,updated_at=? WHERE bot=? AND (status IS NOT ? OR error IS NOT ?)",
                params![status, error, now(), bot, status, error],
            )
            .unwrap_or(0);
        if changed > 0
            && let Some(owner) = owner
        {
            self.events
                .emit(&owner, None, "hexbot.discord.changed", json!({"bot":bot}));
        }
    }

    async fn connect(self: &Arc<Self>, owner: &str, bot: &str, token: &str) -> Result<()> {
        if token.is_empty() || token.chars().any(|c| c.is_whitespace() || c.is_control()) {
            return Err(Error::new(TOKEN_REFUSED, REFUSED_TEXT));
        }
        let me = self
            .rest(token, reqwest::Method::GET, "/users/@me", None)
            .await?;
        let app = self
            .rest(
                token,
                reqwest::Method::GET,
                "/oauth2/applications/@me",
                None,
            )
            .await?;
        let user_id = required(&me, "id")?.to_owned();
        let application = required(&app, "id")?.to_owned();
        if app["flags"].as_u64().unwrap_or(0) & CONTENT_FLAGS == 0 {
            return Err(Error::new(INTENT, INTENT_TEXT));
        }
        let conn = db::open(&self.home)?;
        let other: Option<String> = conn
            .query_row(
                "SELECT bot FROM discord_bots WHERE user_id=? AND bot<>?",
                params![user_id, bot],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(other) = other {
            return Err(Error::new(
                TAKEN,
                format!("This Discord app is already {other}'s. Make a new app for this bot."),
            ));
        }
        write_token(&self.home, bot, token)?;
        let name = me["global_name"]
            .as_str()
            .or(me["username"].as_str())
            .unwrap_or("")
            .to_owned();
        conn.execute(
            "INSERT INTO discord_bots(bot,owner_id,application_id,user_id,username,status,error,connected_at,updated_at) VALUES (?1,?2,?3,?4,?5,'connecting',NULL,?6,?6) ON CONFLICT(bot) DO UPDATE SET owner_id=excluded.owner_id,application_id=excluded.application_id,user_id=excluded.user_id,username=excluded.username,status='connecting',error=NULL,connected_at=excluded.connected_at,updated_at=excluded.updated_at",
            params![bot, owner, application, user_id, name, now()],
        )?;
        self.events
            .emit(owner, None, "hexbot.discord.changed", json!({"bot":bot}));
        self.link(bot, token.to_owned());
        Ok(())
    }

    /// Disconnect a bot and drop its token. Its Discord rooms stay with
    /// their history; it leaves them, and joins again when it's connected and
    /// mentioned there.
    pub fn forget(&self, bot: &str) -> Result<()> {
        if let Some(link) = self.links.lock().unwrap().remove(bot) {
            link.abort();
        }
        match std::fs::remove_file(token_path(&self.home, bot)) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.into()),
            _ => {}
        }
        let conn = db::open(&self.home)?;
        let owner: Option<String> = conn
            .query_row(
                "SELECT owner_id FROM discord_bots WHERE bot=?",
                [bot],
                |r| r.get(0),
            )
            .optional()?;
        let mut left = vec![];
        {
            let mut conn = conn;
            let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            tx.execute("DELETE FROM discord_bots WHERE bot=?", [bot])?;
            let rooms = rows(
                &tx,
                "SELECT m.room_id FROM room_members m JOIN discord_channels d ON d.room_id=m.room_id WHERE m.member_kind='bot' AND m.member_id=? AND m.left_at IS NULL",
                &[&bot],
            )?;
            for room in rooms {
                let room = required(&room, "room_id")?.to_owned();
                tx.execute(
                    "UPDATE room_members SET left_at=? WHERE room_id=? AND member_kind='bot' AND member_id=?",
                    params![now(), room, bot],
                )?;
                let event = crate::rooms::append_with_conn(
                    &tx,
                    &room,
                    "member.left",
                    "system",
                    None,
                    json!({"bot":bot}),
                )?;
                left.push((room, event));
            }
            tx.commit()?;
        }
        if let Some(owner) = owner {
            for (room, event) in left {
                self.events.emit(
                    &owner,
                    None,
                    "hexbot.rooms.event",
                    json!({"room_id":room,"event":event}),
                );
                self.events
                    .emit(&owner, None, "hexbot.rooms.changed", json!({"id":room}));
            }
            self.events
                .emit(&owner, None, "hexbot.discord.changed", json!({"bot":bot}));
        }
        Ok(())
    }

    fn link(self: &Arc<Self>, bot: &str, token: String) {
        let me = self.clone();
        let name = bot.to_owned();
        let task = tokio::spawn(async move { me.run(&name, &token).await });
        if let Some(old) = self
            .links
            .lock()
            .unwrap()
            .insert(bot.to_owned(), task.abort_handle())
        {
            old.abort();
        }
    }

    async fn run(self: &Arc<Self>, bot: &str, token: &str) {
        let mut resume = None;
        // Back off while connecting fails; a connection Discord accepted
        // starts the next wait over.
        let mut wait = 1;
        loop {
            match self.session(bot, token, &mut resume, &mut wait).await {
                End::Again => {}
                End::Retry(why) => {
                    eprintln!("Discord: {bot} lost its connection: {why}");
                    self.set_status(bot, "connecting", None);
                    tokio::time::sleep(Duration::from_secs(wait)).await;
                    wait = (wait * 2).min(60);
                }
                End::Stop(why) => {
                    self.set_status(bot, "error", Some(&why));
                    return;
                }
            }
        }
    }

    /// One Gateway connection, from Hello until it ends.
    async fn session(
        &self,
        bot: &str,
        token: &str,
        resume: &mut Option<Resume>,
        wait: &mut u64,
    ) -> End {
        let base = resume.as_ref().map_or(self.gateway.as_str(), |r| &r.url);
        let url = format!("{}/?v=10&encoding=json", base.trim_end_matches('/'));
        let socket = match tokio::time::timeout(
            Duration::from_secs(30),
            tokio_tungstenite::connect_async(url.as_str()),
        )
        .await
        {
            Ok(Ok((socket, _))) => socket,
            Ok(Err(e)) => return End::Retry(e.to_string()),
            Err(_) => return End::Retry("timed out".into()),
        };
        let (mut sink, mut stream) = socket.split();
        let hello = match tokio::time::timeout(Duration::from_secs(30), stream.next()).await {
            Ok(Some(Ok(Message::Text(text)))) => {
                serde_json::from_str::<Value>(&text).unwrap_or_default()
            }
            _ => return End::Retry("no hello".into()),
        };
        let every =
            Duration::from_millis(hello["d"]["heartbeat_interval"].as_u64().unwrap_or(41250));
        let opening = match resume {
            Some(r) => json!({"op":6,"d":{"token":token,"session_id":r.session,"seq":r.seq}}),
            None => {
                json!({"op":2,"d":{"token":token,"intents":INTENTS,"properties":{"os":std::env::consts::OS,"browser":"hexbot","device":"hexbot"}}})
            }
        };
        if let Err(e) = sink.send(Message::text(opening.to_string())).await {
            return End::Retry(e.to_string());
        }
        let first = tokio::time::Instant::now() + every.mul_f64(rand::random::<f64>());
        let mut beat = tokio::time::interval_at(first, every);
        let mut acked = true;
        let mut seq = resume.as_ref().and_then(|r| r.seq);
        loop {
            tokio::select! {
                _ = beat.tick() => {
                    if !acked {
                        return End::Retry("Discord stopped answering".into());
                    }
                    acked = false;
                    if let Err(e) = sink.send(Message::text(json!({"op":1,"d":seq}).to_string())).await {
                        return End::Retry(e.to_string());
                    }
                }
                frame = stream.next() => {
                    let text = match frame {
                        Some(Ok(Message::Text(text))) => text,
                        Some(Ok(Message::Close(close))) => {
                            let code = close.map_or(1000, |c| u16::from(c.code));
                            return match code {
                                4004 => End::Stop(REFUSED_TEXT.into()),
                                4014 => End::Stop(INTENT_TEXT.into()),
                                4010..=4013 => End::Stop(format!("Discord closed the connection ({code}). Connect again.")),
                                4007 | 4009 => {
                                    *resume = None;
                                    End::Retry(format!("session ended ({code})"))
                                }
                                _ => End::Retry(format!("closed ({code})")),
                            };
                        }
                        Some(Ok(_)) => continue,
                        Some(Err(e)) => return End::Retry(e.to_string()),
                        None => return End::Retry("closed".into()),
                    };
                    let frame: Value = serde_json::from_str(&text).unwrap_or_default();
                    if let Some(s) = frame["s"].as_u64() {
                        seq = Some(s);
                        if let Some(r) = resume.as_mut() {
                            r.seq = seq;
                        }
                    }
                    match frame["op"].as_u64() {
                        Some(0) => match frame["t"].as_str() {
                            Some("READY") => {
                                let d = &frame["d"];
                                *resume = Some(Resume {
                                    session: d["session_id"].as_str().unwrap_or("").to_owned(),
                                    url: d["resume_gateway_url"].as_str().unwrap_or(&self.gateway).to_owned(),
                                    seq,
                                });
                                if let Some(id) = d["user"]["id"].as_str() {
                                    let _ = db::open(&self.home).and_then(|c| Ok(c.execute("UPDATE discord_bots SET user_id=? WHERE bot=?", params![id, bot])?));
                                }
                                *wait = 1;
                                self.set_status(bot, "online", None);
                            }
                            Some("RESUMED") => {
                                *wait = 1;
                                self.set_status(bot, "online", None);
                            }
                            Some("MESSAGE_CREATE") => {
                                if let Some(inbox) = self.inbox.lock().unwrap().as_ref() {
                                    let _ = inbox.send((bot.to_owned(), frame["d"].clone()));
                                }
                            }
                            _ => {}
                        },
                        Some(1) => {
                            if let Err(e) = sink.send(Message::text(json!({"op":1,"d":seq}).to_string())).await {
                                return End::Retry(e.to_string());
                            }
                        }
                        Some(7) => return End::Again,
                        // Invalid session: wait, with the backoff, before trying again.
                        Some(9) => {
                            if frame["d"] != true {
                                *resume = None;
                            }
                            return End::Retry("Discord ended the session".into());
                        }
                        Some(11) => acked = true,
                        _ => {}
                    }
                }
            }
        }
    }

    async fn rest(
        &self,
        token: &str,
        method: reqwest::Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value> {
        for _ in 0..4 {
            let mut request = self
                .client
                .request(method.clone(), format!("{}{path}", self.api))
                .header("Authorization", format!("Bot {token}"))
                .header("User-Agent", "DiscordBot (https://hexbot.app, 1)");
            if let Some(body) = &body {
                request = request.json(body);
            }
            let response = request.send().await.map_err(|e| {
                crate::http::error(
                    e,
                    OFFLINE,
                    [
                        "Discord took too long to answer.",
                        "Couldn't reach Discord. Check the daemon's internet connection.",
                        "Couldn't reach Discord.",
                    ],
                )
            })?;
            let status = response.status().as_u16();
            let value: Value = response.json().await.unwrap_or(Value::Null);
            match status {
                200..=299 => return Ok(value),
                429 => {
                    let wait = value["retry_after"]
                        .as_f64()
                        .unwrap_or(1.0)
                        .clamp(0.0, 30.0);
                    tokio::time::sleep(Duration::from_secs_f64(wait)).await;
                }
                401 => return Err(Error::new(TOKEN_REFUSED, REFUSED_TEXT)),
                // Discord's own trouble passes; the caller keeps what it was
                // sending and tries again later.
                500..=599 => {
                    tokio::time::sleep(self.retry_wait().min(Duration::from_secs(1))).await
                }
                _ => {
                    let said = value["message"].as_str().unwrap_or("no reason given");
                    return Err(Error::new(5251, format!("Discord said: {said} ({status})")));
                }
            }
        }
        Err(Error::new(
            OFFLINE,
            "Discord is busy. Try again in a minute.",
        ))
    }

    /// Every connected bot's Discord user, mapped to its handle.
    fn ours(&self, owner: &str) -> Result<HashMap<String, String>> {
        Ok(rows(
            &db::open(&self.home)?,
            "SELECT user_id,bot FROM discord_bots WHERE owner_id=? AND user_id IS NOT NULL",
            &[&owner],
        )?
        .into_iter()
        .filter_map(|r| {
            Some((
                r["user_id"].as_str()?.to_owned(),
                r["bot"].as_str()?.to_owned(),
            ))
        })
        .collect())
    }

    /// A message one bot's connection saw. The first time a bot is mentioned in
    /// a channel, the channel becomes a room; then every message there lands
    /// in it once, however many bots saw it.
    /// Discord won't send a message again, so a passing failure (a busy
    /// database) is tried twice more before it's dropped.
    async fn take(&self, bot: &str, message: &Value) {
        for attempt in 1..=3u64 {
            match self.ingest(bot, message).await {
                Ok(()) => break,
                Err(error) if attempt == 3 => {
                    eprintln!("Discord: {bot} could not take a message: {}", error.message);
                }
                Err(_) => {
                    tokio::time::sleep(
                        self.retry_wait().min(Duration::from_secs(1)) * attempt as u32,
                    )
                    .await
                }
            }
        }
    }

    pub(crate) async fn ingest(&self, bot: &str, message: &Value) -> Result<()> {
        let Some(guild) = message["guild_id"].as_str() else {
            return Ok(());
        };
        // Ordinary messages and replies; joins, pins and the like say nothing.
        if !matches!(message["type"].as_i64().unwrap_or(0), 0 | 19) {
            return Ok(());
        }
        let channel = required(message, "channel_id")?;
        let id = required(message, "id")?;
        // A late copy of something said before the channel's last room was
        // deleted belongs to that room: it neither opens nor reaches another.
        if let (Some(at), Some(closed)) = (sent_at(id), closed_at(&db::open(&self.home)?, channel)?)
            && at <= closed
        {
            return Ok(());
        }
        let owner: Option<String> = db::open(&self.home)?
            .query_row(
                "SELECT owner_id FROM discord_bots WHERE bot=?",
                [bot],
                |r| r.get(0),
            )
            .optional()?;
        let Some(owner) = owner else {
            return Ok(());
        };
        let ours = self.ours(&owner)?;
        let author = message["author"]["id"].as_str().unwrap_or("");
        // A connected bot's own reply is in the room already. When it mentions
        // another bot here, that bot joins, so the room engine can hand it over.
        let own = ours.contains_key(author);
        // Another app's bot is talked about, never listened to: its message
        // is saved but opens no room and brings no bot in.
        let foreign = !own && message["author"]["bot"] == true;
        let addressed = addressed(message, &ours);
        let mapped: Option<String> = db::open(&self.home)?
            .query_row(
                "SELECT room_id FROM discord_channels WHERE channel_id=?",
                [channel],
                |r| r.get(0),
            )
            .optional()?;
        let (room, created) = match mapped {
            Some(room) => (room, false),
            None if opens_room(message, &ours) => {
                let Some((room, live)) = self.open_room(&owner, bot, guild, channel, id).await?
                else {
                    return Ok(());
                };
                // What was said since a mention still on its way is taken as
                // it would have been, before this message, each with its own
                // tries: the room is open now, so a retry of this message
                // wouldn't come back to them.
                for mut earlier in live {
                    earlier["guild_id"] = json!(guild);
                    Box::pin(self.take(bot, &earlier)).await;
                }
                (room, true)
            }
            None => return Ok(()),
        };
        // The message is always saved. Waking the room needs its admission,
        // which a member removal or deletion holds while it waits for a turn
        // to finish; then the wake waits for it in its own task.
        let admission = self.rooms.admit(&room).ok();
        let text = inbound_text(message, &ours);
        // A connected bot's own post carries a nonce saying which reply and
        // part of which room it is (`post`); one from another room, such as a
        // deleted one, says nothing about this one.
        let posted_seq = own
            .then(|| message["nonce"].as_str())
            .flatten()
            .and_then(|n| {
                let mut parts = n.splitn(3, '.');
                let seq = parts.next()?.parse::<i64>().ok()?;
                parts.next()?;
                room.starts_with(parts.next()?).then_some(seq)
            });
        // The connection closes before the room engine is woken.
        let (emitted, joined) = {
            let mut conn = db::open(&self.home)?;
            let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            let mut emitted = vec![];
            // Which reply a bot's own post belongs to: as recorded when it was
            // posted, else by its nonce, else, with no nonce at all, the
            // author's oldest reply not yet fully posted (the outbox posts in
            // order).
            let reply: Option<i64> = if own {
                let recorded: Option<i64> = tx
                    .query_row(
                        "SELECT seq FROM discord_messages WHERE message_id=? AND bot IS NOT NULL",
                        [id],
                        |r| r.get(0),
                    )
                    .optional()?
                    .flatten();
                match recorded.or(posted_seq) {
                    Some(seq) => Some(seq),
                    // A nonce that isn't this room's says the post isn't
                    // one of its replies.
                    None if !message["nonce"].is_null() => None,
                    None => tx
                        .query_row(
                            "SELECT MIN(seq) FROM room_events WHERE room_id=?1 AND kind='message.bot' AND actor_id=?2 AND seq>(SELECT posted_seq FROM discord_channels WHERE room_id=?1)",
                            params![room, ours[author]],
                            |r| r.get(0),
                        )
                        .optional()?
                        .flatten(),
                }
            } else {
                None
            };
            // Recording the part means one Discord took after its answer was
            // lost isn't sent again.
            if let Some(seq) = posted_seq {
                tx.execute(
                    "INSERT OR IGNORE INTO discord_messages(message_id,room_id,seq,bot) VALUES (?,?,?,?)",
                    params![id, room, seq, ours[author]],
                )?;
            }
            // Every bot the message mentions joins the room before the message
            // is saved, whichever bot's connection saw it first; one that was
            // removed or disconnected comes back the same way. It is in the
            // room as of now, or, brought in by another bot's reply, as of
            // that reply, so it answers that and nothing said before
            // (`rooms::select_responders`).
            let since: f64 = match reply {
                Some(seq) => tx
                    .query_row(
                        "SELECT created_at FROM room_events WHERE room_id=? AND seq=?",
                        params![room, seq],
                        |r| r.get(0),
                    )
                    .optional()?
                    .unwrap_or_else(now),
                None => now(),
            };
            // Only the first copy of a person's message brings bots in, and a
            // bot reply only brings back a bot removed before it was written:
            // a late copy never undoes a removal.
            let fresh = !own
                && tx.execute(
                    "INSERT OR IGNORE INTO discord_messages(message_id,room_id) VALUES (?,?)",
                    params![id, room],
                )? > 0;
            let mut joined = vec![];
            for handle in addressed.iter().filter(|_| (fresh && !foreign) || own) {
                let left: Option<f64> = tx
                    .query_row(
                        "SELECT left_at FROM room_members WHERE room_id=? AND member_kind='bot' AND member_id=?",
                        params![room, handle],
                        |r| r.get(0),
                    )
                    .optional()?
                    .flatten();
                // A bot post that can't be matched to a reply brings nobody in.
                if own && (reply.is_none() || left.is_some_and(|left| left > since)) {
                    continue;
                }
                if tx.execute(
                    "INSERT INTO room_members VALUES (?,'bot',?,?,?,NULL,0) ON CONFLICT(room_id,member_kind,member_id) DO UPDATE SET left_at=NULL,added_at=excluded.added_at WHERE left_at IS NOT NULL",
                    params![room, handle, owner, since],
                )? > 0
                {
                    emitted.push(crate::rooms::append_with_conn(
                        &tx,
                        &room,
                        "member.added",
                        "system",
                        None,
                        json!({"bot":handle}),
                    )?);
                    joined.push(handle.clone());
                }
            }
            if fresh {
                // What is said while the room is archived starts nothing later.
                let archived: bool = tx.query_row(
                    "SELECT archived_at IS NOT NULL FROM rooms WHERE id=?",
                    [&room],
                    |r| r.get(0),
                )?;
                let name = message["member"]["nick"]
                    .as_str()
                    .or(message["author"]["global_name"].as_str())
                    .or(message["author"]["username"].as_str())
                    .unwrap_or("Someone");
                let event = crate::rooms::append_with_conn(
                    &tx,
                    &room,
                    "message.user",
                    "discord",
                    Some(author),
                    json!({
                        "text": text,
                        "attachments": [],
                        "author": {"id": author, "name": speaker(name), "bot": message["author"]["bot"] == true},
                        "mentions": addressed,
                        "history": archived,
                        "discord": {"message_id": id},
                    }),
                )?;
                tx.execute(
                    "UPDATE discord_messages SET seq=? WHERE message_id=?",
                    params![event["seq"].as_i64(), id],
                )?;
                emitted.push(event);
            }
            tx.commit()?;
            (emitted, joined)
        };
        for event in emitted {
            self.events.emit(
                &owner,
                None,
                "hexbot.rooms.event",
                json!({"room_id":room,"event":event}),
            );
        }
        if created || !joined.is_empty() {
            self.events
                .emit(&owner, None, "hexbot.rooms.changed", json!({"id":room}));
        }
        for handle in created
            .then_some(bot)
            .into_iter()
            .chain(joined.iter().map(String::as_str))
        {
            self.events.emit(
                &owner,
                None,
                "hexbot.discord.changed",
                json!({"bot":handle}),
            );
        }
        // Discord rooms have no main bot: a message wakes the room engine when
        // it mentions a bot, by Discord mention, reply, or a typed @handle.
        // Each connection that sees it wakes it, so a retry after a failed
        // wake wakes it again; the engine answers a message once.
        let lower = text.to_lowercase();
        let typed = ours.values().any(|h| lower.contains(&format!("@{h}")));
        if !addressed.is_empty() || typed {
            match admission {
                Some(admission) => self.rooms.notify_admitted(&owner, &room, &admission)?,
                None => {
                    let rooms = self.rooms.clone();
                    tokio::spawn(async move {
                        if let Err(error) = rooms.notify_later(&owner, &room).await {
                            eprintln!("Discord: could not wake room {room}: {}", error.message);
                        }
                    });
                }
            }
        }
        Ok(())
    }

    /// The room a channel becomes, with what was said just before. A mention
    /// moments earlier may still be on its way through another bot's
    /// connection, so it and what followed it aren't history: they come back
    /// to be taken live, oldest first, unless the room was there already.
    /// Nothing, when the message was sent before the channel's last room was
    /// deleted.
    async fn open_room(
        &self,
        owner: &str,
        bot: &str,
        guild: &str,
        channel: &str,
        before: &str,
    ) -> Result<Option<(String, Vec<Value>)>> {
        let token =
            read_token(&self.home, bot).ok_or_else(|| Error::new(NOT_IN_DISCORD, "no token"))?;
        let info = self
            .rest(
                &token,
                reqwest::Method::GET,
                &format!("/channels/{channel}"),
                None,
            )
            .await
            .unwrap_or_default();
        let server = self
            .rest(
                &token,
                reqwest::Method::GET,
                &format!("/guilds/{guild}"),
                None,
            )
            .await
            .unwrap_or_default();
        // Without Read Message History the room starts from this message.
        let history = self
            .rest(
                &token,
                reqwest::Method::GET,
                &format!("/channels/{channel}/messages?before={before}&limit={HISTORY}"),
                None,
            )
            .await
            .ok()
            .and_then(|v| v.as_array().cloned())
            .unwrap_or_default();
        let channel_name = info["name"].as_str().unwrap_or("channel").to_owned();
        let guild_name = server["name"].as_str().unwrap_or("Discord").to_owned();
        let ours = self.ours(owner)?;
        let mut history: Vec<Value> = history
            .into_iter()
            .rev()
            .filter(|m| m["id"].is_string() && matches!(m["type"].as_i64().unwrap_or(0), 0 | 19))
            .collect();
        let mut conn = db::open(&self.home)?;
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        // What was said before the channel's last room was deleted was
        // answered there, or never will be; read where no deletion can land
        // before the room is made, so a message from before one opens nothing.
        let closed = closed_at(&tx, channel)?;
        if let (Some(at), Some(closed)) = (sent_at(before), closed)
            && at <= closed
        {
            return Ok(None);
        }
        let recent = sent_at(before).map(|at| {
            at.saturating_sub(IN_FLIGHT_MS)
                .max(closed.map_or(0, |closed| closed + 1))
        });
        let live = history
            .iter()
            .position(|m| {
                opens_room(m, &ours)
                    && recent.is_some_and(|recent| {
                        m["id"]
                            .as_str()
                            .and_then(sent_at)
                            .is_some_and(|at| at >= recent)
                    })
            })
            .map(|at| history.split_off(at))
            .unwrap_or_default();
        let mapped: Option<String> = tx
            .query_row(
                "SELECT room_id FROM discord_channels WHERE channel_id=?",
                [channel],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(room) = mapped {
            return Ok(Some((room, vec![])));
        }
        let room = id();
        let time = now();
        tx.execute(
            "INSERT INTO rooms(id,name,owner_id,main_bot,approval_mode,limits_json,created_at,updated_at,last_activity_at) VALUES (?,?,?,NULL,'manual','{}',?,?,?)",
            params![room, format!("#{channel_name} · {guild_name}"), owner, time, time, time],
        )?;
        tx.execute(
            "INSERT INTO room_members VALUES (?,'human',?,?,?,NULL,0)",
            params![room, owner, owner, time],
        )?;
        tx.execute(
            "INSERT INTO discord_channels(channel_id,guild_id,room_id,guild_name,channel_name,posted_seq) VALUES (?,?,?,?,?,0)",
            params![channel, guild, room, guild_name, channel_name],
        )?;
        for message in &history {
            let mid = message["id"].as_str().unwrap_or("");
            let author = message["author"]["id"].as_str().unwrap_or("");
            let name = message["author"]["global_name"]
                .as_str()
                .or(message["author"]["username"].as_str())
                .unwrap_or("Someone");
            let event = crate::rooms::append_with_conn(
                &tx,
                &room,
                "message.user",
                "discord",
                Some(author),
                json!({
                    "text": inbound_text(message, &ours),
                    "attachments": [],
                    "author": {"id": author, "name": speaker(name), "bot": message["author"]["bot"] == true},
                    "history": true,
                    "discord": {"message_id": mid},
                }),
            )?;
            tx.execute(
                "INSERT OR IGNORE INTO discord_messages(message_id,room_id,seq) VALUES (?,?,?)",
                params![mid, room, event["seq"].as_i64()],
            )?;
        }
        tx.commit()?;
        Ok(Some((room, live)))
    }

    /// Post the room's new replies, each as the bot that wrote it.
    pub(crate) async fn flush(&self, room: &str) -> Result<()> {
        let conn = db::open(&self.home)?;
        let Some((channel, posted, owner)) = conn
            .query_row(
                "SELECT d.channel_id,d.posted_seq,r.owner_id FROM discord_channels d JOIN rooms r ON r.id=d.room_id WHERE d.room_id=?",
                [room],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, String>(2)?)),
            )
            .optional()?
        else {
            return Ok(());
        };
        let replies = rows(
            &conn,
            "SELECT seq,actor_id,payload_json FROM room_events WHERE room_id=? AND seq>? AND kind='message.bot' ORDER BY seq",
            &[&room, &posted],
        )?;
        drop(conn);
        let ours = self.ours(&owner)?;
        for reply in replies {
            let seq = reply["seq"].as_i64().unwrap_or(0);
            let bot = reply["actor_id"].as_str().unwrap_or("");
            let payload = json_field(&reply["payload_json"]);
            let posted = match read_token(&self.home, bot) {
                Some(token) => {
                    self.post(&token, room, &channel, bot, seq, &payload, &ours)
                        .await
                }
                None => Err(Error::new(
                    NOT_IN_DISCORD,
                    "It was disconnected from Discord before its reply went out.",
                )),
            };
            match posted {
                Ok(()) => {}
                // Discord is unreachable or in trouble, or the database is
                // busy: the reply waits and the outbox tries again.
                Err(e) if waits(&e) => return Err(e),
                Err(e) => {
                    self.events.emit(
                        &owner,
                        None,
                        "warning",
                        json!({"room_id":room,"message":format!("{bot} couldn't post in Discord. {}", e.message)}),
                    );
                }
            }
            db::open(&self.home)?.execute(
                "UPDATE discord_channels SET posted_seq=MAX(posted_seq,?) WHERE room_id=?",
                params![seq, room],
            )?;
        }
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    async fn post(
        &self,
        token: &str,
        room: &str,
        channel: &str,
        bot: &str,
        seq: i64,
        payload: &Value,
        ours: &HashMap<String, String>,
    ) -> Result<()> {
        let (chunks, users) = outbound(payload["text"].as_str().unwrap_or(""), ours);
        let trigger: Option<String> = db::open(&self.home)?
            .query_row(
                "SELECT message_id FROM discord_messages WHERE room_id=? AND seq=? ORDER BY rowid LIMIT 1",
                params![room, payload["trigger_seq"].as_i64()],
                |r| r.get(0),
            )
            .optional()?;
        // A long reply goes out in parts. The parts Discord took are in
        // `discord_messages`, so a retry carries on after them; the nonce
        // makes Discord drop a part it took when its answer was lost.
        let sent: usize = db::open(&self.home)?.query_row(
            "SELECT COUNT(*) FROM discord_messages WHERE room_id=? AND seq=? AND bot=?",
            params![room, seq, bot],
            |r| r.get(0),
        )?;
        for (i, chunk) in chunks.iter().enumerate().skip(sent) {
            // `seq.part.room`, cut to Discord's 25 characters; `ingest` reads
            // the reply and part back from the bot's own post.
            let nonce = format!("{seq}.{i}.{room}");
            let nonce = &nonce[..nonce.len().min(25)];
            let mut body = json!({
                "content": chunk,
                "nonce": nonce,
                "enforce_nonce": true,
                // Only the bots it names are pinged, never the person it answers.
                "allowed_mentions": {"parse": [], "users": users, "replied_user": false},
            });
            if i == 0
                && let Some(trigger) = &trigger
            {
                body["message_reference"] =
                    json!({"message_id": trigger, "fail_if_not_exists": false});
            }
            let sent = self
                .rest(
                    token,
                    reqwest::Method::POST,
                    &format!("/channels/{channel}/messages"),
                    Some(body),
                )
                .await?;
            // Discord took it but its answer can't be read: try again, and the
            // nonce keeps it from posting twice.
            let Some(mid) = sent["id"].as_str() else {
                return Err(Error::new(OFFLINE, "Discord's answer couldn't be read."));
            };
            db::open(&self.home)?.execute(
                "INSERT OR IGNORE INTO discord_messages(message_id,room_id,seq,bot) VALUES (?,?,?,?)",
                params![mid, room, seq, bot],
            )?;
        }
        Ok(())
    }

    /// Discord shows "<bot> is typing" while a bot's turn starts.
    async fn typing(&self, room: &str, bot: &str) {
        let channel: Option<String> = db::open(&self.home).ok().and_then(|c| {
            c.query_row(
                "SELECT channel_id FROM discord_channels WHERE room_id=?",
                [room],
                |r| r.get(0),
            )
            .ok()
        });
        if let (Some(channel), Some(token)) = (channel, read_token(&self.home, bot)) {
            let _ = self
                .rest(
                    &token,
                    reqwest::Method::POST,
                    &format!("/channels/{channel}/typing"),
                    None,
                )
                .await;
        }
    }
}

#[cfg(test)]
#[path = "discord_tests.rs"]
mod tests;
