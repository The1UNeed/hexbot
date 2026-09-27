//! Durable rooms and their per-bot conversation scheduler.
use crate::{Error, Result, common::*, db};
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};
use std::{collections::HashSet, path::Path};

pub fn get(home: &Path, caller: &str, room: &str, all: bool) -> Result<Value> {
    if all {
        admin(home, caller)?;
    } else {
        user(home, caller)?;
    }
    let conn = db::open(home)?;
    let mut row = rows(&conn, "SELECT * FROM rooms WHERE id=?", &[&room])?
        .into_iter()
        .next()
        .ok_or_else(|| Error::new(4230, format!("room not found: {room}")))?;
    if !all && row["owner_id"] != caller {
        return Err(Error::new(4302, "not the owner"));
    }
    row["limits"] = json_field(&row["limits_json"]);
    row.as_object_mut().unwrap().remove("limits_json");
    row["members"] = json!(rows(
        &conn,
        "SELECT * FROM room_members WHERE room_id=? ORDER BY added_at,member_id",
        &[&room]
    )?);
    Ok(row)
}

pub fn log(home: &Path, caller: &str, room: &str, after: i64, limit: i64) -> Result<Vec<Value>> {
    get(home, caller, room, false)?;
    let mut events = rows(
        &db::open(home)?,
        "SELECT * FROM room_events WHERE room_id=? AND seq>? ORDER BY seq LIMIT ?",
        &[&room, &after, &limit.clamp(1, 1000)],
    )?;
    for e in &mut events {
        e["payload"] = json_field(&e["payload_json"]);
        e.as_object_mut().unwrap().remove("payload_json");
    }
    Ok(events)
}

pub fn append(
    home: &Path,
    caller: &str,
    room: &str,
    kind: &str,
    actor_kind: &str,
    actor: Option<&str>,
    payload: Value,
) -> Result<Value> {
    get(home, caller, room, false)?;
    let mut conn = db::open(home)?;
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let time = now();
    tx.execute("INSERT INTO room_events(room_id,seq,kind,actor_kind,actor_id,payload_json,created_at) SELECT ?,COALESCE(MAX(seq),0)+1,?,?,?,?,? FROM room_events WHERE room_id=?",params![room,kind,actor_kind,actor,payload.to_string(),time,room])?;
    let seq: i64 = tx.query_row(
        "SELECT MAX(seq) FROM room_events WHERE room_id=?",
        [room],
        |r| r.get(0),
    )?;
    tx.execute(
        "UPDATE rooms SET updated_at=?,last_activity_at=? WHERE id=?",
        params![time, time, room],
    )?;
    tx.commit()?;
    Ok(
        json!({"room_id":room,"seq":seq,"kind":kind,"actor_kind":actor_kind,"actor_id":actor,"payload":payload,"created_at":time}),
    )
}

fn accessible_bot(home: &Path, caller: &str, bot: &str) -> Result<()> {
    identifier(bot)?;
    let c = db::open(home)?;
    let row: Option<(String, bool)> = c
        .query_row(
            "SELECT owner_id,shareable FROM bots WHERE name=?",
            [bot],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    if let Some((owner, shared)) = row
        && owner != caller
        && !shared
    {
        return Err(Error::new(4302, "not the owner"));
    }
    Ok(())
}
fn strings(p: &Value, key: &str) -> Result<Vec<String>> {
    match p.get(key) {
        None | Some(Value::Null) => Ok(vec![]),
        Some(Value::Array(a)) => a
            .iter()
            .map(|v| {
                v.as_str()
                    .map(str::to_string)
                    .ok_or_else(|| Error::new(4202, format!("{key} must contain strings")))
            })
            .collect(),
        _ => Err(Error::new(4202, format!("{key} must be an array"))),
    }
}
fn active_bots(room: &Value) -> Vec<String> {
    room["members"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|m| m["member_kind"] == "bot" && m["left_at"].is_null())
        .filter_map(|m| m["member_id"].as_str().map(str::to_string))
        .collect()
}

pub fn call(home: &Path, caller: &str, method: &str, p: &Value) -> Option<Result<Value>> {
    if !method.starts_with("hexbot.rooms.")
        && !matches!(
            method,
            "hexbot.activity.pairs" | "hexbot.activity.messages" | "hexbot.activity.list"
        )
    {
        return None;
    }
    if method == "hexbot.rooms.stop" {
        return None;
    }
    Some((|| {
        user(home, caller)?;
        let all = p["all"]
            .as_bool()
            .or(p["all_users"].as_bool())
            .unwrap_or(false);
        if all {
            admin(home, caller)?;
        }
        let conn = db::open(home)?;
        match method {
            "hexbot.rooms.list" => {
                let archived = p["include_archived"].as_bool().unwrap_or(false);
                let ids = rows(
                    &conn,
                    "SELECT id,owner_id FROM rooms WHERE (? OR archived_at IS NULL) AND (? OR owner_id=?) ORDER BY last_activity_at DESC,name",
                    &[&archived, &all, &caller],
                )?;
                let rooms = ids
                    .iter()
                    .map(|r| get(home, caller, r["id"].as_str().unwrap(), all))
                    .collect::<Result<Vec<_>>>()?;
                Ok(json!({"rooms":rooms}))
            }
            "hexbot.rooms.get" => Ok(json!({"room":get(home,caller,required(p,"id")?,all)?})),
            "hexbot.rooms.create" => {
                validate_approval_mode(p)?;
                let name = required(p, "name")?.trim();
                if name.is_empty() {
                    return Err(Error::new(4200, "missing parameter: name"));
                }
                let mut humans = strings(p, "humans")?;
                humans.push(caller.to_string());
                let mut bots = vec![];
                for m in strings(p, "members")? {
                    let is_user=conn.query_row("SELECT 1 FROM users WHERE id=? AND disabled_at IS NULL AND NOT EXISTS(SELECT 1 FROM bots WHERE name=?)",params![m,m],|_|Ok(())).optional()?.is_some();
                    if is_user {
                        humans.push(m);
                    } else {
                        accessible_bot(home, caller, &m)?;
                        bots.push(m);
                    }
                }
                humans.sort();
                humans.dedup();
                bots.sort();
                bots.dedup();
                if let Some(main) = p["main_bot"].as_str().filter(|s| !s.is_empty())
                    && !bots.iter().any(|b| b == main)
                {
                    return Err(Error::new(4231, "main_bot must be a room member"));
                }
                let room = id();
                let time = now();
                let mut conn = conn;
                let tx = conn.transaction()?;
                tx.execute(
                    "INSERT INTO rooms VALUES (?,?,?,?,?,?,?,?,?,NULL)",
                    params![
                        room,
                        name,
                        caller,
                        p["main_bot"].as_str(),
                        p["approval_mode"].as_str(),
                        p.get("limits").unwrap_or(&json!({})).to_string(),
                        time,
                        time,
                        time
                    ],
                )?;
                for human in &humans {
                    tx.execute(
                        "INSERT INTO room_members VALUES (?,'human',?,?,?,NULL,0)",
                        params![room, human, caller, time],
                    )?;
                }
                for bot in &bots {
                    tx.execute(
                        "INSERT INTO room_members VALUES (?,'bot',?,?,?,NULL,0)",
                        params![room, bot, caller, time],
                    )?;
                }
                tx.commit()?;
                for human in humans.iter().filter(|h| h.as_str() != caller) {
                    append(
                        home,
                        caller,
                        &room,
                        "member.added",
                        "human",
                        Some(caller),
                        json!({"user":human}),
                    )?;
                }
                for bot in bots {
                    append(
                        home,
                        caller,
                        &room,
                        "member.added",
                        "human",
                        Some(caller),
                        json!({"bot":bot}),
                    )?;
                }
                Ok(json!({"room":get(home,caller,&room,false)?}))
            }
            "hexbot.rooms.update" => {
                validate_approval_mode(p)?;
                let room = required(p, "id")?;
                let current = get(home, caller, room, false)?;
                if let Some(o) = p.as_object() {
                    for k in o.keys() {
                        if !["id", "name", "main_bot", "approval_mode", "limits"]
                            .contains(&k.as_str())
                        {
                            return Err(Error::new(4201, format!("unknown room field: {k}")));
                        }
                    }
                }
                if let Some(main) = p["main_bot"].as_str().filter(|s| !s.is_empty())
                    && !active_bots(&current).iter().any(|b| b == main)
                {
                    return Err(Error::new(4231, "main_bot must be an active room member"));
                }
                let mut conn = conn;
                let tx = conn.transaction()?;
                for k in ["name", "main_bot", "approval_mode", "limits"] {
                    if let Some(v) = p.get(k) {
                        let column = if k == "limits" { "limits_json" } else { k };
                        let value = if k == "limits" {
                            Some(v.to_string())
                        } else {
                            v.as_str().map(str::to_string)
                        };
                        if k == "name" && value.as_deref().is_none_or(|n| n.trim().is_empty()) {
                            return Err(Error::new(4200, "missing parameter: name"));
                        }
                        tx.execute(
                            &format!("UPDATE rooms SET {column}=?,updated_at=? WHERE id=?"),
                            params![value, now(), room],
                        )?;
                    }
                }
                tx.commit()?;
                Ok(json!({"room":get(home,caller,room,false)?}))
            }
            "hexbot.rooms.add_member" | "hexbot.rooms.remove_member" => {
                let room = required(p, "id")?;
                let bot = required(p, "bot")?;
                get(home, caller, room, false)?;
                let event;
                if method.ends_with("add_member") {
                    accessible_bot(home, caller, bot)?;
                    conn.execute("INSERT INTO room_members VALUES (?,'bot',?,?,?,NULL,0) ON CONFLICT(room_id,member_kind,member_id) DO UPDATE SET left_at=NULL,added_by=excluded.added_by,added_at=excluded.added_at,last_read_seq=0",params![room,bot,caller,now()])?;
                    event = append(
                        home,
                        caller,
                        room,
                        "member.added",
                        "human",
                        Some(caller),
                        json!({"bot":bot}),
                    )?;
                } else {
                    if conn.execute("UPDATE room_members SET left_at=? WHERE room_id=? AND member_kind='bot' AND member_id=? AND left_at IS NULL",params![now(),room,bot])?==0{return Err(Error::new(4232,format!("active room member not found: {bot}")));}
                    event = append(
                        home,
                        caller,
                        room,
                        "member.left",
                        "human",
                        Some(caller),
                        json!({"bot":bot}),
                    )?;
                    let mut result = get(home, caller, room, false)?;
                    if active_bots(&result).is_empty() {
                        purge_transcripts(home, room)?;
                        conn.execute("DELETE FROM rooms WHERE id=?", [room])?;
                        result["deleted"] = json!(true);
                        return Ok(json!({"room":result,"event":event}));
                    }
                    conn.execute(
                        "UPDATE rooms SET main_bot=NULL WHERE id=? AND main_bot=?",
                        params![room, bot],
                    )?;
                }
                Ok(json!({"room":get(home,caller,room,false)?,"event":event}))
            }
            "hexbot.rooms.send" => Ok(
                json!({"event":append(home,caller,required(p,"id")?,"message.user","human",Some(caller),json!({"text":required(p,"text")?,"attachments":p.get("attachments").cloned().unwrap_or(json!([]))}))?}),
            ),
            "hexbot.rooms.log" => Ok(
                json!({"events":log(home,caller,required(p,"id")?,p["after_seq"].as_i64().unwrap_or(0),p["limit"].as_i64().filter(|n|*n!=0).unwrap_or(200))?}),
            ),
            "hexbot.rooms.mark_read" => {
                let room = required(p, "id")?;
                get(home, caller, room, false)?;
                let seq = p["seq"]
                    .as_i64()
                    .ok_or_else(|| Error::new(4200, "missing parameter: seq"))?;
                conn.execute("UPDATE room_members SET last_read_seq=MAX(last_read_seq,?) WHERE room_id=? AND member_kind='human' AND member_id=?",params![seq,room,caller])?;
                Ok(json!({"room":get(home,caller,room,false)?}))
            }
            "hexbot.rooms.archive" | "hexbot.rooms.unarchive" => {
                let room = required(p, "id")?;
                get(home, caller, room, false)?;
                let archived = if method.ends_with("unarchive") || p["archived"] == false {
                    None
                } else {
                    Some(now())
                };
                conn.execute(
                    "UPDATE rooms SET archived_at=?,updated_at=? WHERE id=?",
                    params![archived, now(), room],
                )?;
                Ok(json!({"room":get(home,caller,room,false)?}))
            }
            "hexbot.rooms.delete" => {
                let room = required(p, "id")?;
                get(home, caller, room, false)?;
                purge_transcripts(home, room)?;
                conn.execute("DELETE FROM rooms WHERE id=?", [room])?;
                Ok(json!({"deleted":true}))
            }
            "hexbot.activity.pairs" | "hexbot.activity.messages" | "hexbot.activity.list" => {
                let pairs = method.ends_with("pairs");
                let base = if pairs {
                    "SELECT from_bot,to_bot,COUNT(*) count,MAX(created_at) last_at FROM bot_messages"
                } else {
                    "SELECT * FROM bot_messages"
                };
                let suffix = if pairs {
                    " GROUP BY from_bot,to_bot ORDER BY last_at DESC"
                } else {
                    " ORDER BY created_at DESC LIMIT ?6"
                };
                let sql = format!(
                    "{base} WHERE (?1 OR from_bot IN (SELECT name FROM bots WHERE owner_id=?2) OR to_bot IN (SELECT name FROM bots WHERE owner_id=?2)) AND (?3 IS NULL OR from_bot=?3) AND (?4 IS NULL OR to_bot=?4) AND ?5 {suffix}"
                );
                let from = p["from"].as_str().or(p["from_bot"].as_str());
                let to = p["to"].as_str().or(p["to_bot"].as_str());
                let limit = p["limit"].as_i64().unwrap_or(200).clamp(1, 1000);
                let mut args: Vec<&dyn rusqlite::ToSql> = vec![&all, &caller, &from, &to, &true];
                if !pairs {
                    args.push(&limit);
                }
                let found = rows(&conn, &sql, &args)?;
                Ok(if pairs {
                    json!({"pairs":found})
                } else {
                    json!({"messages":found})
                })
            }
            _ => Err(Error::new(-32601, format!("unknown method: {method}"))),
        }
    })())
}

/// Keep mention matching independent of the model and stable across restarts.
pub fn select_responders(
    room: &Value,
    event: &Value,
    already: &HashSet<String>,
) -> (Vec<String>, bool) {
    let text = event["payload"]["text"].as_str().unwrap_or("");
    let chars: Vec<char> = text.chars().collect();
    let mut mentions = HashSet::new();
    for (i, c) in chars.iter().enumerate() {
        if *c == '@'
            && (i == 0 || !(chars[i - 1].is_alphanumeric() || matches!(chars[i - 1], '_' | '-')))
        {
            let handle: String = chars[i + 1..]
                .iter()
                .take_while(|c| c.is_alphanumeric() || matches!(c, '_' | '-'))
                .collect();
            if !handle.is_empty() {
                mentions.insert(handle.to_lowercase());
            }
        }
    }
    let human_question = text.contains('?')
        && text
            .split(|c: char| !c.is_alphanumeric())
            .any(|s| matches!(s.to_lowercase().as_str(), "user" | "human" | "you"));
    if event["kind"] == "message.bot" && (mentions.contains("user") || human_question) {
        return (vec![], true);
    }
    let active = active_bots(room);
    let mut selected: Vec<String> = active
        .iter()
        .filter(|b| mentions.contains(&b.to_lowercase()) && !already.contains(*b))
        .cloned()
        .collect();
    if event["kind"] == "message.user"
        && selected.is_empty()
        && let Some(main) = room["main_bot"].as_str()
        && active.iter().any(|b| b == main)
        && !already.contains(main)
    {
        selected.push(main.to_string());
    }
    (selected, false)
}

pub fn render_prompt(
    room: &Value,
    bot: &str,
    events: &[Value],
    memory: &str,
    collecting: &[(String, String)],
) -> String {
    let members = room["members"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|m| m["left_at"].is_null())
        .filter_map(|m| m["member_id"].as_str())
        .map(|m| {
            let title = room["member_titles"][m].as_str().unwrap_or("");
            if title.is_empty() {
                format!("@{m}")
            } else {
                format!("@{m} ({title})")
            }
        })
        .collect::<Vec<_>>()
        .join(", ");
    let mut lines = vec![];
    for e in events {
        let kind = e["kind"].as_str().unwrap_or("");
        if !["message.user", "message.bot", "note"].contains(&kind) {
            continue;
        }
        let text = e["payload"]["text"]
            .as_str()
            .unwrap_or("")
            .replace('\r', "");
        let text = text.trim();
        let speaker = match kind {
            "message.user" => "User".to_string(),
            "note" => "System".to_string(),
            _ => format!("@{}", e["actor_id"].as_str().unwrap_or("")),
        };
        for (i, line) in text.lines().enumerate() {
            lines.push(if i == 0 {
                format!("{speaker}: {line}")
            } else {
                line.to_string()
            });
        }
    }
    let mut omitted = 0;
    while lines.len() > 40 || lines.join("\n").len() > 96 * 1024 {
        lines.remove(0);
        omitted += 1;
    }
    if omitted > 0 {
        loop {
            let summary = format!("[... {omitted} older transcript lines omitted ...]");
            if lines.is_empty()
                || (lines.len() < 40 && summary.len() + 1 + lines.join("\n").len() <= 96 * 1024)
            {
                lines.insert(0, summary);
                break;
            }
            lines.remove(0);
            omitted += 1;
        }
    }
    if !collecting.is_empty() {
        lines.push("Replies to collect:".into());
        for (name, text) in collecting {
            lines.push(format!("@{name}: {text}"));
        }
    }
    let memory: String = memory.chars().take(3000).collect();
    let memory = if memory.is_empty() {
        String::new()
    } else {
        format!("\n\nRoom memory:\n{memory}")
    };
    let transcript = if lines.is_empty() {
        "(no messages)".into()
    } else {
        lines.join("\n")
    };
    format!(
        "Room: {}\nYou are @{bot}. Members: {members}{memory}\n\nTranscript since your last turn:\n{transcript}\n\nRoom rules:\n- Reply once. Say (pass) when you have nothing to add.\n- Mention a member by @handle to bring them in.\n- Mention @user when you need the human, then wait.\n- Do not reveal private conversations.",
        room["name"].as_str().unwrap_or("")
    )
}

use crate::events::EventHub;
use std::{
    collections::HashMap,
    future::Future,
    path::PathBuf,
    pin::Pin,
    sync::{Arc, Mutex},
};

type TurnFuture<'a> = Pin<Box<dyn Future<Output = Result<String>> + Send + 'a>>;
type InterruptFuture<'a> = Pin<Box<dyn Future<Output = Result<()>> + Send + 'a>>;
/// The scheduler can be tested without credentials, network access, or an LLM.
pub trait RoomRunner: Send + Sync {
    fn ensure<'a>(&'a self, _owner: &'a str, _bot: &'a str, stored: &'a str) -> TurnFuture<'a> {
        Box::pin(async move { Ok(stored.to_string()) })
    }

    fn run<'a>(
        &'a self,
        owner: &'a str,
        bot: &'a str,
        stored: &'a str,
        text: &'a str,
    ) -> TurnFuture<'a>;
    fn interrupt<'a>(&'a self, owner: &'a str, stored: &'a str) -> InterruptFuture<'a>;
}
impl RoomRunner for crate::runtime::Runtime {
    fn ensure<'a>(&'a self, owner: &'a str, bot: &'a str, stored: &'a str) -> TurnFuture<'a> {
        Box::pin(async move { self.ensure_hidden(owner, bot, stored).await })
    }

    fn run<'a>(
        &'a self,
        owner: &'a str,
        bot: &'a str,
        stored: &'a str,
        text: &'a str,
    ) -> TurnFuture<'a> {
        Box::pin(async move { self.run_hidden(owner, bot, stored, text).await })
    }
    fn interrupt<'a>(&'a self, owner: &'a str, stored: &'a str) -> InterruptFuture<'a> {
        Box::pin(async move { self.interrupt_stored(owner, stored).await.map(|_| ()) })
    }
}
#[derive(Default)]
struct Work {
    generation: u64,
    abort: Option<tokio::task::AbortHandle>,
    running: bool,
    dirty: bool,
    stopped: bool,
}
pub struct RoomEngine {
    home: PathBuf,
    runner: Arc<dyn RoomRunner>,
    events: EventHub,
    work: Mutex<HashMap<String, Work>>,
    closed: std::sync::atomic::AtomicBool,
}
impl RoomEngine {
    pub fn new(home: PathBuf, runtime: Arc<crate::runtime::Runtime>, events: EventHub) -> Self {
        Self::with_runner(home, runtime, events)
    }
    pub fn with_runner(home: PathBuf, runner: Arc<dyn RoomRunner>, events: EventHub) -> Self {
        Self {
            home,
            runner,
            events,
            work: Mutex::new(HashMap::new()),
            closed: std::sync::atomic::AtomicBool::new(false),
        }
    }
    pub async fn reconcile(self: &Arc<Self>) -> Result<()> {
        let pending = {
            let conn = db::open(&self.home)?;
            conn.execute(
                "UPDATE room_turns SET status='failed',finished_at=? WHERE status='running'",
                [now()],
            )?;
            conn.execute("UPDATE room_sessions SET live_session_id=NULL", [])?;
            rows(
                &conn,
                "SELECT DISTINCT r.id,r.owner_id FROM rooms r JOIN room_events e ON e.room_id=r.id JOIN users u ON u.id=r.owner_id WHERE u.disabled_at IS NULL AND r.archived_at IS NULL AND e.kind='message.user'",
                &[],
            )?
        };
        for room in pending {
            self.notify(
                room["owner_id"].as_str().unwrap(),
                room["id"].as_str().unwrap(),
            )
            .await?;
        }
        Ok(())
    }
    pub async fn notify(self: &Arc<Self>, owner: &str, room: &str) -> Result<()> {
        get(&self.home, owner, room, false)?;
        let engine = self.clone();
        let owner = owner.to_string();
        let room = room.to_string();
        let mut work = self.work.lock().unwrap();
        if self.closed.load(std::sync::atomic::Ordering::Acquire) {
            return Err(Error::new(5200, "room engine is shutting down"));
        }
        let w = work.entry(room.clone()).or_default();
        w.dirty = true;
        w.stopped = false;
        if w.running {
            return Ok(());
        }
        w.running = true;
        let task = tokio::spawn(async move {
            loop {
                {
                    let mut work = engine.work.lock().unwrap();
                    if let Some(w) = work.get_mut(&room) {
                        w.dirty = false;
                    }
                }
                if let Err(e) = engine.drain(&owner, &room).await {
                    let _ = engine.emit(
                        &owner,
                        &room,
                        "turn.failed",
                        "system",
                        None,
                        json!({"error":e.message}),
                    );
                }
                let mut work = engine.work.lock().unwrap();
                let w = work.entry(room.clone()).or_default();
                if w.dirty && !w.stopped {
                    continue;
                }
                w.running = false;
                break;
            }
        });
        w.abort = Some(task.abort_handle());
        Ok(())
    }
    /// Stop every worker without consulting user permissions during daemon teardown.
    pub async fn shutdown(&self) {
        self.closed
            .store(true, std::sync::atomic::Ordering::Release);
        {
            let mut work = self.work.lock().unwrap();
            for w in work.values_mut() {
                w.stopped = true;
                w.dirty = false;
                w.running = false;
                w.generation = w.generation.wrapping_add(1);
                if let Some(abort) = w.abort.take() {
                    abort.abort();
                }
            }
        }
        let sessions = if let Ok(conn) = db::open(&self.home) {
            let _ = conn.execute(
                "UPDATE room_turns SET status='failed',finished_at=? WHERE status='running'",
                [now()],
            );
            rows(&conn,"SELECT r.owner_id,s.stored_session_id FROM room_sessions s JOIN rooms r ON r.id=s.room_id",&[]).unwrap_or_default()
        } else {
            vec![]
        };
        let mut interrupts = futures_util::stream::FuturesUnordered::new();
        for session in &sessions {
            let owner = session["owner_id"].as_str().unwrap_or("");
            let stored = session["stored_session_id"].as_str().unwrap_or("");
            interrupts.push(tokio::time::timeout(
                std::time::Duration::from_secs(3),
                self.runner.interrupt(owner, stored),
            ));
        }
        use futures_util::StreamExt;
        while interrupts.next().await.is_some() {}
    }
    pub async fn stop(&self, owner: &str, room: &str) -> Result<bool> {
        get(&self.home, owner, room, false)?;
        self.stop_work(owner, room, false).await
    }
    /// Internal lifecycle operations may stop rooms whose owner has been disabled.
    pub async fn stop_internal(&self, room: &str) -> Result<bool> {
        let owner: String = db::open(&self.home)?
            .query_row("SELECT owner_id FROM rooms WHERE id=?", [room], |r| {
                r.get(0)
            })
            .optional()?
            .unwrap_or_default();
        self.stop_work(&owner, room, true).await
    }
    async fn stop_work(&self, owner: &str, room: &str, abort: bool) -> Result<bool> {
        {
            let mut work = self.work.lock().unwrap();
            let w = work.entry(room.into()).or_default();
            w.stopped = true;
            w.generation = w.generation.wrapping_add(1);
            w.dirty = false;
            if abort {
                w.running = false;
                if let Some(task) = w.abort.take() {
                    task.abort();
                }
            }
        }
        db::open(&self.home)?.execute("UPDATE room_turns SET status='failed',finished_at=? WHERE room_id=? AND status='running'",params![now(),room])?;
        let sessions = rows(
            &db::open(&self.home)?,
            "SELECT stored_session_id FROM room_sessions WHERE room_id=?",
            &[&room],
        )?;
        for session in sessions {
            let _ = self
                .runner
                .interrupt(owner, session["stored_session_id"].as_str().unwrap())
                .await;
        }
        Ok(true)
    }
    fn stopped(&self, room: &str) -> bool {
        self.closed.load(std::sync::atomic::Ordering::Acquire)
            || self
                .work
                .lock()
                .unwrap()
                .get(room)
                .is_some_and(|w| w.stopped)
    }
    fn generation(&self, room: &str) -> u64 {
        self.work
            .lock()
            .unwrap()
            .get(room)
            .map_or(0, |w| w.generation)
    }
    fn cancelled(&self, room: &str, generation: u64) -> bool {
        self.stopped(room) || self.generation(room) != generation
    }
    fn emit(
        &self,
        owner: &str,
        room: &str,
        kind: &str,
        actor_kind: &str,
        actor: Option<&str>,
        payload: Value,
    ) -> Result<Value> {
        let event = append(&self.home, owner, room, kind, actor_kind, actor, payload)?;
        self.events.emit(
            owner,
            None,
            "hexbot.rooms.event",
            json!({"room_id":room,"event":event}),
        );
        Ok(event)
    }
    /// Processes durable triggers in sequence; only one worker owns a room.
    pub async fn drain(&self, owner: &str, room_id: &str) -> Result<()> {
        let mut after_seq = 0;
        while !self.stopped(room_id) {
            let mut room = get(&self.home, owner, room_id, false)?;
            let titles = rows(
                &db::open(&self.home)?,
                "SELECT name,COALESCE(NULLIF(title,''),display_name,'') AS title FROM bots WHERE name IN (SELECT member_id FROM room_members WHERE room_id=? AND member_kind='bot' AND left_at IS NULL)",
                &[&room_id],
            )?;
            room["member_titles"] = json!({});
            for row in titles {
                room["member_titles"][row["name"].as_str().unwrap()] = row["title"].clone();
            }
            if !room["archived_at"].is_null() {
                return Ok(());
            }
            // Query candidates directly, avoiding the old first-1000-events ceiling.
            let candidates = {
                let conn = db::open(&self.home)?;
                let mut events = rows(
                    &conn,
                    "SELECT e.*, (SELECT json_group_array(t.bot) FROM room_turns t WHERE t.room_id=e.room_id AND t.trigger_seq=e.seq) AS done_bots, EXISTS(SELECT 1 FROM room_events w WHERE w.room_id=e.room_id AND w.kind='waiting.human' AND json_extract(w.payload_json,'$.trigger_seq')=e.seq) AS waited FROM room_events e WHERE e.room_id=? AND e.seq>? AND e.kind IN ('message.user','message.bot') ORDER BY e.seq",
                    &[&room_id, &after_seq],
                )?;
                for e in &mut events {
                    e["payload"] = json_field(&e["payload_json"]);
                }
                events
            };
            let mut candidate = None;
            for event in candidates {
                let seq = event["seq"].as_i64().unwrap();
                let done = json_field(&event["done_bots"])
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|v| v.as_str().map(str::to_owned))
                    .collect();
                let (selected, waiting) = select_responders(&room, &event, &done);
                if waiting {
                    let waited = event["waited"] == 1;
                    if !waited {
                        self.emit(
                            owner,
                            room_id,
                            "waiting.human",
                            "bot",
                            event["actor_id"].as_str(),
                            json!({"trigger_seq":seq}),
                        )?;
                        return Ok(());
                    }
                } else if !selected.is_empty() {
                    candidate = Some((event, selected));
                    break;
                }
                after_seq = seq;
            }
            let Some((event, bots)) = candidate else {
                return Ok(());
            };
            let mut tasks = futures_util::stream::FuturesUnordered::new();
            let mut capped = false;
            // Reserve each turn before dispatch so a concurrent fanout cannot exceed its cap.
            for bot in &bots {
                if !self.check_limits(owner, &room, bot, event["seq"].as_i64().unwrap())? {
                    capped = true;
                    break;
                }
                tasks.push(self.execute(owner, &room, bot, &event, &[]));
            }
            use futures_util::StreamExt;
            let mut replies = vec![];
            while let Some(result) = tasks.next().await {
                if let Some(reply) = result? {
                    replies.push(reply);
                }
            }
            if capped {
                self.work
                    .lock()
                    .unwrap()
                    .entry(room_id.into())
                    .or_default()
                    .stopped = true;
                return Ok(());
            }
            if event["kind"] == "message.bot"
                && event["actor_id"] == room["main_bot"]
                && !replies.is_empty()
                && !self.stopped(room_id)
            {
                let main = room["main_bot"].as_str().unwrap();
                if self.check_limits(owner, &room, main, event["seq"].as_i64().unwrap())? {
                    self.execute(owner, &room, main, &event, &replies).await?;
                }
            }
        }
        Ok(())
    }
    fn check_limits(&self, owner: &str, room: &Value, bot: &str, seq: i64) -> Result<bool> {
        let rid = room["id"].as_str().unwrap();
        let conn = db::open(&self.home)?;
        let last_human:i64=conn.query_row("SELECT COALESCE(MAX(seq),0) FROM room_events WHERE room_id=? AND kind='message.user' AND seq<=?",params![rid,seq],|r|r.get(0))?;
        let (turns,tokens):(i64,i64)=conn.query_row("SELECT COUNT(*),COALESCE(SUM(input_tokens+output_tokens),0) FROM room_turns WHERE room_id=? AND trigger_seq>=? AND status IN ('running','complete')",params![rid,last_human],|r|Ok((r.get(0)?,r.get(1)?)))?;
        let mut limits = json!({"room_bot_turns_per_human_turn":8});
        for row in rows(&conn, "SELECT key,value FROM settings", &[])? {
            if let (Some(k), Some(v)) = (row["key"].as_str(), row["value"].as_str())
                && let Ok(v) = serde_json::from_str::<Value>(v)
            {
                limits[k] = v;
            }
        }
        if let Some(overrides) = room["limits"].as_object() {
            for (k, v) in overrides {
                limits[k] = v.clone();
            }
        }
        let bot_usage = usage(&self.home, bot, None, Some(now() - now() % 86400.0));
        let day = now() - now() % 86400.0;
        let native_daily:i64=crate::runtime_store::open(&self.home)?.query_row("SELECT COALESCE(SUM(input_tokens+output_tokens+cache_read_tokens+cache_write_tokens),0) FROM native_usage WHERE owner_id=? AND timestamp>=?",params![owner,day],|r|r.get(0))?;
        let routes = rows(
            &conn,
            "SELECT bot,id AS session FROM sections WHERE owner_id=?1 UNION SELECT rs.bot,rs.stored_session_id AS session FROM room_sessions rs JOIN room_members rm ON rm.room_id=rs.room_id AND rm.member_kind='bot' AND rm.member_id=rs.bot WHERE rm.added_by=?1",
            &[&owner],
        )?;
        let daily_used = native_daily
            + routes
                .iter()
                .map(|r| {
                    let u = legacy_usage(
                        &self.home,
                        r["bot"].as_str().unwrap(),
                        r["session"].as_str(),
                        Some(day),
                    );
                    u.0 + u.1
                })
                .sum::<i64>();
        let user_limits = json_field(&user(&self.home, owner)?["limits_json"]);
        for (key, used, cap) in [
            (
                "daily_tokens",
                daily_used,
                user_limits["daily_tokens"].as_i64(),
            ),
            (
                "room_bot_turns_per_human_turn",
                turns,
                limits["room_bot_turns_per_human_turn"].as_i64(),
            ),
            (
                "room_budget_tokens_per_human_turn",
                tokens,
                limits["room_budget_tokens_per_human_turn"].as_i64(),
            ),
            (
                "bot_daily_token_budget",
                bot_usage.0 + bot_usage.1,
                limits["bot_daily_token_budget"].as_i64(),
            ),
        ] {
            if let Some(cap) = cap
                && used >= cap
            {
                conn.execute(
                    "INSERT INTO room_turns VALUES (?,?,?,?,?,?,'limit',0,0,0)",
                    params![id(), rid, bot, seq, now(), now()],
                )?;
                self.emit(
                    owner,
                    rid,
                    "limit.tripped",
                    "system",
                    None,
                    json!({"limit":key,"used":used,"cap":cap}),
                )?;
                return Ok(false);
            }
        }
        conn.execute(
            "INSERT INTO room_turns VALUES (?,?,?,?,?,NULL,'running',0,0,0)",
            params![id(), rid, bot, seq, now()],
        )?;
        Ok(true)
    }
    async fn execute(
        &self,
        owner: &str,
        room: &Value,
        bot: &str,
        event: &Value,
        collecting: &[(String, String)],
    ) -> Result<Option<(String, String)>> {
        let rid = room["id"].as_str().unwrap();
        if self.stopped(rid) {
            return Ok(None);
        }
        let generation = self.generation(rid);
        // Each bot keeps the same stored session, including across daemon restarts.
        let (stored, delta, text, turn, before) = {
            let conn = db::open(&self.home)?;
            conn.execute(
                "INSERT OR IGNORE INTO room_sessions VALUES (?,?,?,NULL)",
                params![rid, bot, id()],
            )?;
            let stored: String = conn.query_row(
                "SELECT stored_session_id FROM room_sessions WHERE room_id=? AND bot=?",
                params![rid, bot],
                |r| r.get(0),
            )?;
            let cursor:i64=conn.query_row("SELECT last_read_seq FROM room_members WHERE room_id=? AND member_kind='bot' AND member_id=?",params![rid,bot],|r|r.get(0))?;
            let mut delta = rows(
                &conn,
                "SELECT * FROM room_events WHERE room_id=? AND seq>? ORDER BY seq",
                &[&rid, &cursor],
            )?;
            for e in &mut delta {
                e["payload"] = json_field(&e["payload_json"]);
            }
            let memory: String = conn
                .query_row("SELECT text FROM room_memory WHERE room_id=?", [rid], |r| {
                    r.get(0)
                })
                .optional()?
                .unwrap_or_default();
            let text = render_prompt(room, bot, &delta, &memory, collecting);
            let turn:String=conn.query_row("SELECT id FROM room_turns WHERE room_id=? AND bot=? AND trigger_seq=? AND status='running' ORDER BY started_at DESC LIMIT 1",params![rid,bot,event["seq"].as_i64()],|r|r.get(0))?;
            let before = usage(&self.home, bot, Some(&stored), None);
            (stored, delta, text, turn, before)
        };
        let opened = self.runner.ensure(owner, bot, &stored).await;
        let live = opened.as_ref().ok().cloned();
        if let Some(live) = &live {
            db::open(&self.home)?.execute(
                "UPDATE room_sessions SET live_session_id=? WHERE room_id=? AND bot=?",
                params![live, rid, bot],
            )?;
        }
        self.emit(
            owner,
            rid,
            "turn.started",
            "bot",
            Some(bot),
            json!({"turn_id":turn,"trigger_seq":event["seq"],"live_session_id":live}),
        )?;
        self.events.emit(
            owner,
            None,
            "hexbot.rooms.turn",
            json!({"room_id":rid,"bot":bot,"live_session_id":live,"status":"running"}),
        );
        let result = match opened {
            Ok(_) if !self.cancelled(rid, generation) => {
                self.runner.run(owner, bot, &stored, &text).await
            }
            Ok(_) => Err(Error::new(5200, "turn interrupted")),
            Err(e) => Err(e),
        };
        let status = if result.is_ok() && !self.cancelled(rid, generation) {
            "complete"
        } else {
            "failed"
        };
        let after = usage(&self.home, bot, Some(&stored), None);
        db::open(&self.home)?.execute("UPDATE room_turns SET finished_at=?,status=?,input_tokens=?,output_tokens=?,cost_usd=? WHERE id=?",params![now(),status,(after.0-before.0).max(0),(after.1-before.1).max(0),(after.2-before.2).max(0.0),turn])?;
        self.events.emit(
            owner,
            None,
            "hexbot.rooms.turn",
            json!({"room_id":rid,"bot":bot,"live_session_id":live,"status":status}),
        );
        match result {
            Ok(answer) if !self.cancelled(rid, generation) => {
                let cursor = delta
                    .last()
                    .and_then(|e| e["seq"].as_i64())
                    .or(event["seq"].as_i64())
                    .unwrap_or(0);
                db::open(&self.home)?.execute("UPDATE room_members SET last_read_seq=MAX(last_read_seq,?) WHERE room_id=? AND member_kind='bot' AND member_id=?",params![cursor,rid,bot])?;
                let answer = answer.trim();
                if answer.is_empty() || answer.eq_ignore_ascii_case("(pass)") {
                    return Ok(None);
                }
                self.emit(
                    owner,
                    rid,
                    "message.bot",
                    "bot",
                    Some(bot),
                    json!({"text":answer,"trigger_seq":event["seq"]}),
                )?;
                Ok(Some((bot.into(), answer.into())))
            }
            other => {
                let error = other
                    .err()
                    .map(|e| e.message)
                    .unwrap_or_else(|| "turn interrupted".into());
                self.emit(
                    owner,
                    rid,
                    "turn.failed",
                    "bot",
                    Some(bot),
                    json!({"error":error,"trigger_seq":event["seq"]}),
                )?;
                Ok(None)
            }
        }
    }
}

fn usage(home: &Path, bot: &str, stored: Option<&str>, since: Option<f64>) -> (i64, i64, f64) {
    let legacy = legacy_usage(home, bot, stored, since);
    let native=crate::runtime_store::open(home).and_then(|conn| Ok(conn.query_row("SELECT COALESCE(SUM(input_tokens+cache_read_tokens+cache_write_tokens),0),COALESCE(SUM(output_tokens),0),COALESCE(SUM(cost),0) FROM native_usage WHERE bot=?1 AND (?2 IS NULL OR session_id=?2) AND (?3 IS NULL OR timestamp>=?3)",params![bot,stored,since],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,i64>(1)?,r.get::<_,f64>(2)?)))?)).unwrap_or((0,0,0.0));
    (
        legacy.0 + native.0,
        legacy.1 + native.1,
        legacy.2 + native.2,
    )
}
fn legacy_usage(
    home: &Path,
    bot: &str,
    stored: Option<&str>,
    since: Option<f64>,
) -> (i64, i64, f64) {
    if identifier(bot).is_err() {
        return (0, 0, 0.0);
    }
    let read = || -> std::result::Result<(i64, i64, f64), rusqlite::Error> {
        let conn = rusqlite::Connection::open_with_flags(
            home.join("profiles").join(bot).join("state.db"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )?;
        conn.query_row("SELECT COALESCE(SUM(input_tokens),0),COALESCE(SUM(output_tokens),0),COALESCE(SUM(CASE WHEN actual_cost_usd>0 THEN actual_cost_usd ELSE estimated_cost_usd END),0) FROM session_model_usage WHERE (?1 IS NULL OR session_id=?1) AND (?2 IS NULL OR last_seen>=?2)",params![stored,since],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))
    };
    read().unwrap_or((0, 0, 0.0))
}

fn purge_transcripts(home: &Path, room: &str) -> Result<()> {
    for row in rows(
        &db::open(home)?,
        "SELECT stored_session_id FROM room_sessions WHERE room_id=?",
        &[&room],
    )? {
        crate::runtime_store::delete(home, required(&row, "stored_session_id")?)?;
    }
    Ok(())
}
fn validate_approval_mode(p: &Value) -> Result<()> {
    if let Some(mode) = p.get("approval_mode")
        && !mode
            .as_str()
            .is_some_and(|m| ["manual", "smart", "off", "inherit"].contains(&m))
    {
        return Err(Error::new(
            4202,
            "approval_mode must be manual, smart, off, or inherit",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod approval_tests {
    use super::*;
    #[test]
    fn room_approval_modes_are_validated() {
        for mode in [
            json!("manual"),
            json!("smart"),
            json!("off"),
            json!("inherit"),
        ] {
            assert!(validate_approval_mode(&json!({"approval_mode":mode})).is_ok());
        }
        for mode in [json!("auto"), json!("invalid"), json!(7), Value::Null] {
            assert_eq!(
                validate_approval_mode(&json!({"approval_mode":mode}))
                    .unwrap_err()
                    .code,
                4202
            );
        }
    }
}
