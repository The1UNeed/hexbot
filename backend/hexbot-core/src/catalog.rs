//! Persistent bots and sections. Runtime attachment is handled by `runtime`.
use crate::{
    Error, Result,
    common::{self, *},
    db, runtime_store,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use rusqlite::{Connection, OpenFlags, OptionalExtension, TransactionBehavior, params};
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
};

const TOOLS: &[(&str, &str)] = &[
    ("terminal", "terminal"),
    ("files", "file"),
    ("code_execution", "code_execution"),
    ("browser", "browser"),
    ("computer_use", "computer_use"),
    ("vision", "vision"),
    ("voice", "tts"),
    ("message_bots", "hexbot"),
    ("delegate", "delegation"),
    ("scheduling", "cronjob"),
];
/// The primary bot's handle. Only the primary bot may take it.
pub const PRIMARY_NAME: &str = "hexbot";
const PRIMARY_DISPLAY_NAME: &str = "HexBot";
const PRIMARY_TITLE: &str = "Primary bot";
const PRIMARY_DESCRIPTION: &str =
    "Sets up and looks after your other bots, rooms, scheduled jobs and settings.";
const PRIMARY_SOUL: &str = "You are the user's primary bot in Hexbot: the one they come to first and the one that runs the place. You create and set up their other bots, put bots together in rooms, schedule work for any bot, and change Hexbot's settings when they ask. Before creating a bot, check whether one they already have fits the job. Give each new bot a clear purpose, a soul written for that purpose, and only the tools it needs. Be direct and concise: match the length of your reply to the weight of the ask. Ask when a request is ambiguous, and remember what matters about the people you work with.";
const FIELDS: &[&str] = &[
    "name",
    "display_name",
    "title",
    "description",
    "persona",
    "provider",
    "model",
    "reasoning_effort",
    "avatar",
    "face",
    "dream_enabled",
    "tools",
    "skills",
    "notify",
    "approval_mode",
    "workdir",
];

pub fn profile(home: &Path, name: &str) -> Result<PathBuf> {
    identifier(name)?;
    let path = home.join("profiles").join(name);
    safe(home, &path)?;
    Ok(path)
}
fn safe(home: &Path, path: &Path) -> Result<()> {
    let relative = path
        .strip_prefix(home)
        .map_err(|_| Error::new(4202, "invalid profile path"))?;
    let mut current = home.to_path_buf();
    for part in relative.components() {
        current.push(part);
        if fs::symlink_metadata(&current).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err(Error::new(4202, "profile path must not contain symlinks"));
        }
    }
    Ok(())
}
fn read_text(home: &Path, path: &Path) -> Result<String> {
    safe(home, path)?;
    match fs::read_to_string(path) {
        Ok(v) => Ok(v),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(e.into()),
    }
}
fn config(home: &Path, name: &str) -> Result<Value> {
    let path = profile(home, name)?.join("config.yaml");
    let text = read_text(home, &path)?;
    if text.trim().is_empty() {
        return Ok(json!({}));
    }
    let value: Value = serde_yaml::from_str(&text).map_err(|e| Error::new(5200, e.to_string()))?;
    Ok(if value.is_object() { value } else { json!({}) })
}
fn write_yaml(home: &Path, path: &Path, value: &Value) -> Result<()> {
    safe(home, path)?;
    crate::common::write_yaml(path, value)
}

fn bot_row(home: &Path, caller: &str, name: &str) -> Result<Value> {
    identifier(name)?;
    user(home, caller)?;
    let row = rows(
        &db::open(home)?,
        "SELECT * FROM bots WHERE name=?",
        &[&name],
    )?
    .into_iter()
    .next()
    .ok_or_else(|| Error::new(4205, format!("bot not found: {name}")))?;
    owner(home, caller, row["owner_id"].as_str().unwrap_or(""))?;
    Ok(row)
}
fn section_row(home: &Path, caller: &str, id: &str) -> Result<Value> {
    user(home, caller)?;
    let row = rows(
        &db::open(home)?,
        "SELECT * FROM sections WHERE id=?",
        &[&id],
    )?
    .into_iter()
    .next()
    .ok_or_else(|| Error::new(4204, format!("section not found: {id}")))?;
    owner(home, caller, row["owner_id"].as_str().unwrap_or(""))?;
    Ok(row)
}
// The profile identifies old schemas without ownership columns. When a schema
// or a current mapping does carry ownership, never cross that boundary, even
// through a continuation whose parent points at the requested conversation.
fn legacy_delete_owned(
    catalog: &Connection,
    native: &Connection,
    bot: &str,
    owner: &str,
    row: &Value,
) -> Result<bool> {
    for key in ["owner_id", "owner", "user_id"] {
        if row[key]
            .as_str()
            .is_some_and(|v| !v.is_empty() && v != owner)
        {
            return Ok(false);
        }
    }
    if row["bot"]
        .as_str()
        .is_some_and(|v| !v.is_empty() && v != bot)
    {
        return Ok(false);
    }
    for key in ["id", "session_key"] {
        if let Some(id) = row[key].as_str() {
            let foreign: bool = catalog.query_row(
                "SELECT EXISTS(SELECT 1 FROM sections WHERE id=?1 AND (bot<>?2 OR owner_id<>?3))",
                params![id, bot, owner],
                |r| r.get(0),
            )?;
            let native_foreign: bool = native.query_row("SELECT EXISTS(SELECT 1 FROM native_sessions WHERE stored_id=?1 AND (bot<>?2 OR owner<>?3)) OR EXISTS(SELECT 1 FROM native_delete_options WHERE session_id=?1 AND (bot<>?2 OR owner<>?3))", params![id,bot,owner], |r| r.get(0))?;
            if foreign || native_foreign {
                return Ok(false);
            }
        }
    }
    Ok(true)
}
fn legacy_delete_connection(home: &Path, bot: &str, owner: &str) -> Result<Option<Connection>> {
    let path = profile(home, bot)?.join("state.db");
    safe(home, &path)?;
    let current: Option<String> = db::open(home)?
        .query_row("SELECT owner_id FROM bots WHERE name=?", [bot], |r| {
            r.get(0)
        })
        .optional()?;
    if current.as_deref().is_some_and(|current| current != owner)
        || (current.is_none() && path.try_exists()?)
    {
        return Err(Error::new(
            5200,
            "legacy profile ownership is unknown; kept the cleanup request",
        ));
    }
    if !path.try_exists()? {
        return Ok(None);
    }
    // Do not replace an unavailable database with a new empty file.
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
    conn.busy_timeout(std::time::Duration::from_secs(10))?;
    Ok(Some(conn))
}

pub(crate) fn legacy_delete_ids(
    home: &Path,
    bot: &str,
    owner: &str,
    stored: &str,
) -> Result<Vec<String>> {
    let Some(conn) = legacy_delete_connection(home, bot, owner)? else {
        return Ok(vec![stored.to_owned()]);
    };
    let sessions = rows(&conn, "SELECT * FROM sessions", &[])?;
    let catalog = db::open(home)?;
    let native = runtime_store::open(home)?;
    let mut pending = sessions;
    let mut ids = BTreeSet::from([stored.to_owned()]);
    let mut selected = BTreeSet::new();
    loop {
        let before = selected.len();
        let mut waiting = Vec::new();
        for row in pending {
            let root = row["id"] == stored || row["session_key"] == stored;
            if !root
                && !row["parent_session_id"]
                    .as_str()
                    .is_some_and(|parent| selected.contains(parent))
            {
                waiting.push(row);
                continue;
            }
            if !legacy_delete_owned(&catalog, &native, bot, owner, &row)? {
                if root {
                    return Err(Error::new(
                        4302,
                        "legacy history belongs to another bot or owner",
                    ));
                }
                continue;
            }
            let id = required(&row, "id")?;
            selected.insert(id.to_owned());
            // Traverse a completed alias to find unfinished descendants, while
            // preserving replacement rows for the completed conversation.
            let mut completed = false;
            for key in ["id", "session_key"]
                .iter()
                .filter_map(|key| row[key].as_str())
            {
                completed |= native.query_row(
                    "SELECT EXISTS(SELECT 1 FROM native_delete_completed WHERE session_id=?)",
                    [key],
                    |r| r.get::<_, bool>(0),
                )?;
            }
            if !root && completed {
                continue;
            }
            ids.insert(id.to_owned());
            if let Some(alias) = row["session_key"].as_str() {
                ids.insert(alias.to_owned());
            }
        }
        if selected.len() == before {
            break;
        }
        pending = waiting;
    }
    Ok(ids.into_iter().collect())
}

pub(crate) fn purge_legacy_delete(
    home: &Path,
    bot: &str,
    owner: &str,
    keys: &[String],
) -> Result<()> {
    let Some(mut conn) = legacy_delete_connection(home, bot, owner)? else {
        return Ok(());
    };
    let catalog = db::open(home)?;
    let native = runtime_store::open(home)?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    // A legacy continuation can sort after its parent. Check their foreign keys
    // after every selected message and session row has been removed.
    tx.execute_batch("PRAGMA defer_foreign_keys=ON")?;
    // Saved keys keep their proven provenance after native/legacy parent rows
    // disappear. Refuse a conflicting replacement instead of following it.
    let mut protected = BTreeSet::new();
    for row in rows(&tx, "SELECT * FROM sessions", &[])? {
        let mut completed = false;
        for key in ["id", "session_key"]
            .iter()
            .filter_map(|key| row[key].as_str())
        {
            completed |= native.query_row(
                "SELECT EXISTS(SELECT 1 FROM native_delete_completed WHERE session_id=?)",
                [key],
                |r| r.get::<_, bool>(0),
            )?;
        }
        if completed {
            protected.extend(
                ["id", "session_key"]
                    .iter()
                    .filter_map(|key| row[key].as_str())
                    .map(str::to_owned),
            );
            continue;
        }
        if ["id", "session_key"].iter().any(|key| {
            row[key]
                .as_str()
                .is_some_and(|id| keys.iter().any(|key| key == id))
        }) && !legacy_delete_owned(&catalog, &native, bot, owner, &row)?
        {
            return Err(Error::new(4302, "legacy cleanup target changed ownership"));
        }
    }
    for key in keys {
        if protected.contains(key) {
            continue;
        }
        tx.execute("DELETE FROM messages WHERE session_id=?", [key])?;
        tx.execute("DELETE FROM sessions WHERE id=?", [key])?;
    }
    tx.commit()?;
    Ok(())
}
fn history_summary(home: &Path, row: &Value) -> Result<(String, i64)> {
    let id = row["id"].as_str().unwrap_or("");
    let summary = runtime_store::summary(home, id)?;
    let native: bool = runtime_store::open(home)?.query_row(
        "SELECT EXISTS(SELECT 1 FROM native_sessions WHERE stored_id=?1) OR EXISTS(SELECT 1 FROM native_pi_journal WHERE session_id=?1)",
        [id],
        |r| r.get(0),
    )?;
    if native || summary["message_count"].as_i64().unwrap_or(0) > 0 {
        return Ok((
            summary["preview"].as_str().unwrap_or("").to_owned(),
            summary["message_count"].as_i64().unwrap_or(0),
        ));
    }
    // An older store that cannot be read counts as empty until it can.
    let Some((preview, count, _)) = legacy_history(home, row, &BTreeSet::new())? else {
        return Ok((String::new(), 0));
    };
    runtime_store::open(home)?.execute(
        "INSERT OR REPLACE INTO native_summaries VALUES(?,?,?)",
        params![id, count, preview],
    )?;
    Ok((preview, count))
}
/// The section's preview, message count and newest message time in the store
/// from before the native daemon, or none when that store cannot be read.
fn legacy_history(
    home: &Path,
    row: &Value,
    reports: &BTreeSet<String>,
) -> Result<Option<(String, i64, ChatActivity)>> {
    let id = row["id"].as_str().unwrap_or("");
    let name = row["bot"].as_str().unwrap_or("");
    let path = profile(home, name)?.join("state.db");
    safe(home, &path)?;
    if runtime_store::fresh(home, id)? {
        return Ok(Some((String::new(), 0, ChatActivity::default())));
    }
    let exists = match path.try_exists() {
        Ok(exists) => exists,
        Err(error) => {
            unreadable_store(name, &error.into());
            return Ok(None);
        }
    };
    if !exists {
        return Ok(Some((String::new(), 0, ChatActivity::default())));
    }
    let messages = match Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(Error::from)
        .and_then(|conn| runtime_store::legacy_rows(&conn, id))
    {
        Ok((messages, _)) => messages,
        Err(error) => {
            unreadable_store(name, &error);
            return Ok(None);
        }
    };
    let conversation = |m: &&Value| {
        !runtime_store::dream_report_text(m).is_some_and(|text| reports.contains(&text))
    };
    let count = messages
        .iter()
        .filter(conversation)
        .filter(|m| matches!(m["role"].as_str(), Some("user" | "assistant" | "tool")))
        .count() as i64;
    let preview = messages
        .iter()
        .rev()
        .find(|m| {
            matches!(m["role"].as_str(), Some("user" | "assistant"))
                && m["display_kind"] != "hidden"
                && m["content"].as_str().is_some_and(|text| !text.is_empty())
        })
        .map(|m| runtime_store::preview(m["content"].as_str().unwrap_or("")))
        .unwrap_or_default();
    let mut activity = ChatActivity::default();
    for message in &messages {
        if matches!(
            message["role"].as_str(),
            Some("user" | "assistant" | "tool")
        ) {
            activity.record(&message["timestamp"], !conversation(&message));
        }
    }
    Ok(Some((preview, count, activity)))
}
/// Says once per start that a bot's store from before the native daemon
/// cannot be read; every list and search would say it again.
pub(crate) fn unreadable_store(bot: &str, error: &Error) {
    static SAID: std::sync::Mutex<BTreeSet<String>> = std::sync::Mutex::new(BTreeSet::new());
    if SAID
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(bot.to_owned())
    {
        eprintln!("Could not read {bot}'s conversations from before the native daemon: {error}");
    }
}
fn shape_section(home: &Path, row: Value) -> Result<Value> {
    let (preview, count) = history_summary(home, &row)?;
    Ok(json!({
        "id": row["id"],
        "bot": row["bot"],
        "peer_bot": row["peer_bot"],
        "title": row["title"],
        "title_by": row["title_by"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "archived_at": row["archived_at"],
        "done_at": row["done_at"],
        "live_session_id": row["last_live_session_id"],
        "preview": preview,
        "message_count": count
    }))
}
pub fn section(home: &Path, caller: &str, id: &str) -> Result<Value> {
    shape_section(home, section_row(home, caller, id)?)
}
/// Public deletion is only for peer threads. Keep owner chats, including
/// archived or unreadable legacy targets, until their bot is deleted.
pub(crate) fn check_section_delete(home: &Path, caller: &str, id: &str) -> Result<()> {
    let row = section_row(home, caller, id)?;
    if row["peer_bot"].is_null() {
        return Err(Error::new(
            4202,
            "A bot chat cannot be deleted; delete the bot to remove it",
        ));
    }
    Ok(())
}
fn list_sections(home: &Path, caller: &str, p: &Value) -> Result<Vec<Value>> {
    user(home, caller)?;
    let bot = p["bot"].as_str();
    let archived = p["include_archived"].as_bool().unwrap_or(false);
    let threads = p["include_threads"] == true;
    rows(
        &db::open(home)?,
        "SELECT * FROM sections WHERE owner_id=? AND (? IS NULL OR bot=?) AND (? OR archived_at IS NULL) AND (? OR peer_bot IS NULL) ORDER BY updated_at DESC,id ASC",
        &[&caller, &bot, &bot, &archived, &threads],
    )?
    .into_iter()
    .map(|r| shape_section(home, r))
    .collect()
}
/// A bot's one chat with its owner, made on first use. Threads in which other
/// bots ask it for help are not chats. A chat an older client archived comes back.
/// A derived conversation is disposable until its catalog row commits.
struct PendingChat<'a> {
    home: &'a Path,
    id: Option<String>,
}
impl Drop for PendingChat<'_> {
    fn drop(&mut self) {
        if let Some(id) = &self.id
            && let Err(error) = finish_chat_fork(self.home, id)
        {
            eprintln!("Could not remove uncommitted chat {id}: {error}");
        }
    }
}

/// Inspect the publication decision while holding the same reservation as the
/// publisher. A pending identity alone authorizes cleanup of its private copy,
/// never of a catalog conversation, a bot journal target, or retained history.
fn finish_chat_fork(home: &Path, target: &str) -> Result<()> {
    let mut catalog = db::open(home)?;
    let tx = catalog.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let native = runtime_store::open(home)?;
    let Some(row) = rows(
        &native,
        "SELECT * FROM native_pending_chat_forks WHERE target=?",
        &[&target],
    )?
    .pop() else {
        return Ok(());
    };
    let source = required(&row, "source")?;
    let adopted = setting(&tx, "dream_chat_adoptions")?;
    if adopted[source]["target"] == target {
        // The section and this exact adoption committed together. A later
        // section read or marker-removal failure cannot unpublish it.
        native.execute(
            "DELETE FROM native_pending_chat_forks WHERE target=?",
            [target],
        )?;
    } else {
        let listed: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM sections WHERE id=?1) OR EXISTS(SELECT 1 FROM room_sessions WHERE stored_session_id=?1)",
            [target], |r| r.get(0),
        )?;
        if listed || pending_bot_delete_targets(home)?.contains(target) {
            return Err(Error::new(
                5200,
                "pending chat fork has another catalog owner or decision",
            ));
        }
        // The reservation waited out the sole publisher. Its rolled-back ID
        // cannot be published later or discovered by bot deletion. Release the
        // writer before cleanup, which may acquire the product gate in builds
        // that have one. No catalog writer may wait for that gate.
        tx.commit()?;
        drop(catalog);
        return runtime_store::discard_chat_fork(
            home,
            source,
            target,
            required(&row, "bot")?,
            required(&row, "owner")?,
        );
    }
    tx.commit()?;
    Ok(())
}

pub(crate) fn finish_chat_forks(home: &Path) -> Result<()> {
    let targets = rows(
        &runtime_store::open(home)?,
        "SELECT target FROM native_pending_chat_forks ORDER BY target",
        &[],
    )?;
    let mut result = Ok(());
    for row in targets {
        let target = required(&row, "target")?;
        if let Err(error) = finish_chat_fork(home, target) {
            eprintln!("Could not finish pending chat {target}: {error}");
            if result.is_ok() {
                result = Err(error);
            }
        }
    }
    result
}

#[cfg(all(test, unix))]
pub(crate) fn chat_fork_barrier(home: &Path, phase: &str) -> Result<()> {
    use std::io::{Read, Write};
    let path = home.join("fork-barrier.sock");
    if path.try_exists()? {
        let mut socket = std::os::unix::net::UnixStream::connect(path)?;
        socket.write_all(phase.as_bytes())?;
        socket.read_exact(&mut [0])?;
    }
    Ok(())
}

#[cfg(all(test, unix))]
#[path = "catalog_fork_tests.rs"]
mod fork_tests;

/// Checked under the opener's shared conversation lease. Adoption holds the
/// exclusive lease through commit, so an old ID cannot admit input in between.
pub(crate) fn check_chat_source(home: &Path, source: &str) -> Result<()> {
    let conn = db::open(home)?;
    if let Some(target) = setting(&conn, "dream_chat_adoptions")?[source]["target"].as_str() {
        let present: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM sections s JOIN sections t ON t.bot=s.bot AND t.owner_id=s.owner_id WHERE s.id=? AND t.id=? AND t.peer_bot IS NULL)",
            params![source, target], |r| r.get(0),
        )?;
        if present {
            return Err(Error::new(
                4002,
                format!(
                    "This conversation moved to the bot's chat ({target}). Open the chat to continue."
                ),
            ));
        }
    }
    Ok(())
}

pub fn chat_section(home: &Path, caller: &str, name: &str) -> Result<Value> {
    bot_owner(home, caller, name)?;
    // Before the transaction: finding the bot's dream logs may write.
    let logs = dream_logs(home, name)?;
    // Drop the catalog writer before cleanup takes the product boundary.
    // This guard owns even a partially built fork that returns an error.
    let mut forked = PendingChat { home, id: None };
    let mut source_lease = None;
    let mut conn = db::open(home)?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let candidates = rows(
        &tx,
        "SELECT * FROM sections WHERE bot=? AND owner_id=? AND peer_bot IS NULL ORDER BY updated_at DESC,id",
        &[&name, &caller],
    )?;
    // Failed recovery includes transient I/O, not only damaged data. Both
    // stay for repair; neither would open. Recovery runs before serving RPCs,
    // never here under the catalog write lock.
    let unavailable = runtime_store::open(home)?
        .prepare("SELECT session_id FROM native_quarantine UNION SELECT session_id FROM native_unrecovered")?
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<std::result::Result<BTreeSet<_>, _>>()?;
    let adopted = setting(&tx, "dream_chat_adoptions")?;
    let present = candidates
        .iter()
        .filter_map(|r| r["id"].as_str())
        .filter(|id| !unavailable.contains(*id))
        .collect::<BTreeSet<_>>();
    let superseded = candidates
        .iter()
        .filter_map(|row| {
            let source = row["id"].as_str()?;
            let replacement = adopted[source]["target"].as_str()?;
            present.contains(replacement).then(|| source.to_owned())
        })
        .collect::<BTreeSet<_>>();
    let healthy = candidates
        .into_iter()
        .filter(|row| !superseded.contains(row["id"].as_str().unwrap_or("")))
        .filter(|row| !unavailable.contains(row["id"].as_str().unwrap_or("")))
        .collect();
    // Ranked as the upgrade ranks them: sections it could not remove never
    // put a dream log ahead of a conversation.
    let mut ranked = chat_candidates(home, healthy, &logs)?;
    rank_chats(&mut ranked, &logs);
    // A dream log with nothing to mark is never the chat, nor one whose
    // history cannot be read yet: it would not open. Both stay.
    let existing = ranked
        .into_iter()
        .next()
        .filter(|candidate| candidate.count >= 0)
        .and_then(|candidate| candidate.row["id"].as_str().map(str::to_owned));
    let id = if let Some(mut id) = existing {
        if logs.contains(&id) && {
            let lease = runtime_store::conversation_lock(home, &id)?;
            match lease.try_lock() {
                Ok(()) => source_lease = Some(lease),
                // Keep the source as the chat until its runtime, accepted input,
                // uploads and background work have finished. Never stop them to
                // migrate, and never wait for them under the catalog writer.
                Err(fs::TryLockError::WouldBlock) => (),
                Err(fs::TryLockError::Error(error)) => return Err(error.into()),
            }
            source_lease.is_some()
        } {
            let reports = rows(
                &tx,
                "SELECT summary FROM dreams WHERE bot=? AND summary<>''",
                &[&name],
            )?
            .into_iter()
            .filter_map(|r| r["summary"].as_str().map(str::to_owned))
            .collect();
            let version: i64 = runtime_store::open(home)?.query_row("SELECT COALESCE((SELECT version FROM native_history_versions WHERE session_id=?),0)", [&id], |r| r.get(0))?;
            let next = common::id();
            let listed: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM sections WHERE id=?1) OR EXISTS(SELECT 1 FROM room_sessions WHERE stored_session_id=?1)",
                [&next], |r| r.get(0),
            )?;
            if listed {
                return Err(Error::new(5200, "chat fork target already exists"));
            }
            if runtime_store::fork_dream_chat_with_prepare(
                home,
                name,
                caller,
                &id,
                &next,
                &reports,
                || {
                    runtime_store::prepare_chat_fork(home, &id, &next, name, caller)?;
                    forked.id = Some(next.clone());
                    #[cfg(all(test, unix))]
                    chat_fork_barrier(home, "before_copy")?;
                    Ok(())
                },
            )? {
                #[cfg(all(test, unix))]
                chat_fork_barrier(home, "after_copy")?;
                tx.execute("INSERT INTO sections(id,bot,title,owner_id,created_at,updated_at) SELECT ?,bot,CASE WHEN title='Dreams' THEN 'General' ELSE title END,owner_id,created_at,updated_at FROM sections WHERE id=?", params![next, id])?;
                let mut adopted = setting(&tx, "dream_chat_adoptions")?
                    .as_object()
                    .cloned()
                    .unwrap_or_default();
                adopted.insert(id.clone(), json!({"target":next,"version":version}));
                tx.execute(
                    "INSERT OR REPLACE INTO settings VALUES('dream_chat_adoptions',?)",
                    [Value::Object(adopted).to_string()],
                )?;
                id = next;
            }
        }
        tx.execute(
            "UPDATE sections SET archived_at=NULL WHERE id=? AND archived_at IS NOT NULL",
            [&id],
        )?;
        id
    } else {
        let id = id();
        let now = now();
        // Recorded first: a chat made while the older store cannot be read
        // must open without it.
        runtime_store::mark_fresh(home, &id)?;
        tx.execute(
            "INSERT INTO sections(id,bot,title,owner_id,created_at,updated_at) VALUES (?,?,'General',?,?,?)",
            params![id, name, caller, now, now],
        )?;
        tx.execute(
            "UPDATE bots SET last_activity_at=? WHERE name=?",
            params![now, name],
        )?;
        id
    };
    #[cfg(all(test, unix))]
    if forked.id.is_some() {
        chat_fork_barrier(home, "before_commit")?;
    }
    tx.commit()?;
    #[cfg(all(test, unix))]
    if forked.id.is_some() {
        chat_fork_barrier(home, "after_commit")?;
    }
    if let Some(target) = &forked.id
        && let Err(error) = finish_chat_fork(home, target)
    {
        eprintln!("Could not finish pending chat {target}: {error}");
    }
    forked.id = None;
    section(home, caller, &id)
}
/// A JSON setting, or null.
fn setting(conn: &Connection, key: &str) -> Result<Value> {
    let value: Option<String> = conn
        .query_row("SELECT value FROM settings WHERE key=?", [key], |r| {
            r.get(0)
        })
        .optional()?;
    Ok(value
        .and_then(|value| serde_json::from_str(&value).ok())
        .unwrap_or(Value::Null))
}
/// Reports can overwrite the same catalog timestamp an older client's
/// unarchive RPC uses to save its choice. No old field records that choice
/// separately. If a report followed the dialogue, keep the competing histories.
#[derive(Default)]
struct ChatActivity {
    dialogue: f64,
    report: f64,
    uncertain: bool,
}
impl ChatActivity {
    fn record(&mut self, timestamp: &Value, report: bool) {
        if let Some(at) = timestamp.as_f64().filter(|at| at.is_finite() && *at > 0.0) {
            let latest = if report {
                &mut self.report
            } else {
                &mut self.dialogue
            };
            *latest = latest.max(at);
        } else {
            self.uncertain = true;
        }
    }
    fn merge(&mut self, other: Self) {
        self.dialogue = self.dialogue.max(other.dialogue);
        self.report = self.report.max(other.report);
        self.uncertain |= other.uncertain;
    }
}
struct ChatCandidate {
    row: Value,
    // -1: legacy report-only log, -2: unreadable legacy history.
    count: i64,
    activity_at: f64,
    preserve: bool,
}
/// A bot's chats with non-report activity, preserving an ambiguous old choice.
fn chat_candidates(
    home: &Path,
    sections: Vec<Value>,
    logs: &BTreeSet<String>,
) -> Result<Vec<ChatCandidate>> {
    let mut result = vec![];
    for row in sections {
        let (_, mut count) = history_summary(home, &row)?;
        // A crash before the imported JSONL commit leaves history in both stores.
        let id = row["id"].as_str().unwrap_or("");
        let native = native_history(home, &row)?;
        let log = logs.contains(id);
        let mut activity = ChatActivity::default();
        let reports = if log {
            count = 0;
            for message in rows(
                &runtime_store::open(home)?,
                "SELECT message_json FROM native_messages WHERE session_id=?",
                &[&id],
            )? {
                let message: Value =
                    serde_json::from_str(message["message_json"].as_str().unwrap_or(""))
                        .map_err(|error| Error::new(5200, error.to_string()))?;
                if matches!(
                    message["role"].as_str(),
                    Some("user" | "assistant" | "tool")
                ) {
                    let report = message["dream"] == true;
                    count += i64::from(!report);
                    activity.record(&message["timestamp"], report);
                }
            }
            rows(
                &db::open(home)?,
                "SELECT summary FROM dreams WHERE bot=? AND summary<>''",
                &[&row["bot"].as_str()],
            )?
            .into_iter()
            .filter_map(|r| r["summary"].as_str().map(str::to_owned))
            .collect()
        } else {
            BTreeSet::new()
        };
        let mut readable = true;
        if !home
            .join("runtime/sessions")
            .join(id)
            .join("conversation.jsonl")
            .try_exists()?
        {
            match legacy_history(home, &row, &reports)? {
                Some((_, legacy_count, legacy_activity)) => {
                    count = count.max(legacy_count);
                    activity.merge(legacy_activity);
                }
                None => readable = false,
            }
        }
        let updated = row["updated_at"].as_f64().unwrap_or(0.0);
        let preserve =
            log && count > 0 && (activity.uncertain || activity.report >= activity.dialogue);
        let activity_at = if log {
            // With no report after dialogue, retain updated_at: the owner may
            // have picked this older chat via unarchive without sending a message.
            if preserve {
                activity.dialogue
            } else {
                activity.dialogue.max(updated)
            }
        } else {
            let said: Option<f64> = runtime_store::open(home)?.query_row(
                "SELECT MAX(json_extract(message_json,'$.timestamp')) FROM native_messages WHERE session_id=?",
                [id], |r| r.get(0),
            )?;
            said.unwrap_or(0.0).max(activity.dialogue).max(updated)
        };
        if log && !native && count == 0 {
            count = -1;
        }
        if !readable {
            count = -2;
        }
        result.push(ChatCandidate {
            row,
            count,
            activity_at,
            preserve,
        });
    }
    Ok(result)
}
/// Best first: readable, dialogue, not a report-only log, not archived, newest.
fn rank_chats(sections: &mut [ChatCandidate], logs: &BTreeSet<String>) {
    sections.sort_by(|a, b| {
        let rank = |candidate: &ChatCandidate| {
            (
                candidate.count > -2,
                candidate.count > 0,
                candidate.count > 0 || !logs.contains(candidate.row["id"].as_str().unwrap_or("")),
                candidate.row["archived_at"].is_null(),
            )
        };
        rank(b)
            .cmp(&rank(a))
            .then(b.activity_at.total_cmp(&a.activity_at))
            .then_with(|| a.row["id"].as_str().cmp(&b.row["id"].as_str()))
    });
}
/// Sections an earlier build posted dream reports to. A bot the upgrade could
/// not look at, because its older store could not be read, is looked at
/// first; while that store still cannot be read, what was found stands and
/// the next call tries again. It may write, so never call it inside a
/// catalog write transaction.
pub(crate) fn dream_logs(home: &Path, bot: &str) -> Result<BTreeSet<String>> {
    // Older builds can add logs even after the one-shot migration. Inspect
    // current candidates again; this only marks display history, never Pi context.
    if let Err(error) = classify_dream_logs(home, bot) {
        unreadable_store(bot, &error);
    }
    runtime_store::dream_logs(home)
}
/// Finds which of a bot's chats are logs an earlier build posted dream
/// reports to, marks the reports already copied into them, and records them
/// in `dream_logs`. The log opened with a report: one titled like it but begun
/// by the user is a chat. A log the user renamed is still the log: it opens
/// with a report an earlier build posted, unmarked. A chat this build made for
/// a report opens with a marked one. Fails, recording nothing, while the bot's
/// store from before the native daemon cannot be read; the next read of that
/// store tries again.
pub(crate) fn classify_dream_logs(home: &Path, bot: &str) -> Result<BTreeSet<String>> {
    // The log earlier builds posted dream reports to, never renamed.
    const DREAM_LOG: &str = "title='Dreams' AND title_by IS NULL AND COALESCE(title_dirty,0)=0";
    let mut conn = db::open(home)?;
    let reports = rows(
        &conn,
        "SELECT DISTINCT summary FROM dreams WHERE bot=? AND summary<>''",
        &[&bot],
    )?
    .into_iter()
    .filter_map(|row| row["summary"].as_str().map(str::to_owned))
    .collect::<BTreeSet<_>>();
    let sections = rows(
        &conn,
        &format!(
            "SELECT id,({DREAM_LOG}) AS titled FROM sections WHERE bot=? AND peer_bot IS NULL"
        ),
        &[&bot],
    )?;
    if sections.is_empty() {
        return Ok(BTreeSet::new());
    }
    let path = profile(home, bot)?.join("state.db");
    safe(home, &path)?;
    let legacy = if path.try_exists()? {
        Some(Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY,
        )?)
    } else {
        None
    };
    let runtime = runtime_store::open(home)?;
    let known = runtime_store::dream_logs(home)?;
    let mut logs = BTreeSet::new();
    for row in sections {
        let id = row["id"].as_str().unwrap_or("");
        // What an earlier build kept comes first; reports this build posted
        // to a log never opened since follow it.
        let mut first = match &legacy {
            Some(legacy) => runtime_store::legacy_rows(legacy, id)?.0.first().cloned(),
            None => None,
        };
        if first.is_none() {
            let native = runtime
                .query_row(
                    "SELECT m.message_json,p.raw_json FROM native_messages m LEFT JOIN native_pi_journal p ON p.session_id=m.session_id AND p.projection_seq=m.seq WHERE m.session_id=? ORDER BY m.seq LIMIT 1",
                    [id],
                    |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?)),
                )
                .optional()?;
            if let Some((message, raw)) = native {
                first = serde_json::from_str(&message).ok();
                if let Some(raw) = raw {
                    let raw: Value =
                        serde_json::from_str(&raw).map_err(|e| Error::new(5200, e.to_string()))?;
                    if runtime_store::dream_report_text(&raw).is_none() {
                        first = Some(raw);
                    }
                }
            }
        }
        let first = first.unwrap_or(Value::Null);
        if known.contains(id)
            || runtime_store::dream_report_text(&first).is_some()
                && (row["titled"] == 1
                    || first["dream"] != true
                        && runtime_store::dream_report_text(&first)
                            .is_some_and(|text| reports.contains(&text)))
        {
            logs.insert(id.to_owned());
        }
    }
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let mut all: BTreeSet<String> =
        serde_json::from_value(setting(&tx, "dream_logs")?).unwrap_or_default();
    all.extend(logs.iter().cloned());
    let mut bots: BTreeSet<String> =
        serde_json::from_value(setting(&tx, "dream_log_bots")?).unwrap_or_default();
    bots.insert(bot.to_owned());
    tx.execute(
        "INSERT OR REPLACE INTO settings(key,value) VALUES('dream_logs',?),('dream_log_bots',?)",
        params![json!(all).to_string(), json!(bots).to_string()],
    )?;
    // Persist identity before marking. If marking fails, the next call can
    // retry even for a renamed log whose first report is already marked.
    tx.commit()?;
    // The reports in a dream log, not what the user said there or the bot's
    // replies; a reply elsewhere can read like a report.
    for id in &logs {
        runtime_store::classify_dream_reports(home, id, &reports)?;
    }
    Ok(logs)
}
/// Earlier builds kept many sections per bot. At the first start of this
/// version, before the runtime starts and any client can connect, the one
/// with the latest conversation stays as the bot's chat and the others are
/// deleted with their history, after a full copy of everything they are
/// deleted from goes to `backups/`; memory and notes stay. Tried once: if
/// anything fails, nothing more is deleted and the sections left stay for
/// good. Dream reports in old dream logs are marked as reports.
pub fn one_chat_per_bot(home: &Path) -> Result<()> {
    let mut conn = db::open(home)?;
    if !setting(&conn, "one_chat_per_bot")?.is_null() {
        return Ok(());
    }
    let (doomed, renamed) = plan_one_chat_per_bot(home, &conn).unwrap_or_else(|error| {
        eprintln!("Kept every section from before one chat per bot: {error}");
        (vec![], vec![])
    });
    // Recorded before the first delete: whatever happens next, no later start
    // deletes anything. Sections an older build makes later stay too:
    // chat_section picks the bot's chat among them.
    let tx = conn.transaction()?;
    tx.execute(
        "INSERT OR REPLACE INTO settings(key,value) VALUES('one_chat_per_bot','true')",
        [],
    )?;
    for id in renamed {
        tx.execute(
            "UPDATE sections SET title='General',title_by=NULL WHERE id=?",
            [id],
        )?;
    }
    tx.commit()?;
    for (owner, bot, id) in doomed {
        // Deleting stamps activity; this is not the bot's.
        let deleted = conn
            .query_row(
                "SELECT last_activity_at FROM bots WHERE name=?",
                [&bot],
                |r| r.get::<_, Option<f64>>(0),
            )
            .optional()
            .map_err(Error::from)
            .and_then(|activity| {
                let pending = delete_section(home, &owner, &id, true)?;
                conn.execute(
                    "UPDATE bots SET last_activity_at=? WHERE name=?",
                    params![activity.flatten(), bot],
                )?;
                if let Some(error) = pending {
                    return Err(error);
                }
                Ok(())
            });
        if let Err(error) = deleted {
            eprintln!("Kept the sections not yet deleted: could not delete {id}: {error}");
            break;
        }
    }
    // Previews were each section's first message; a chat shows its latest.
    if let Err(error) = runtime_store::open(home)
        .and_then(|runtime| Ok(runtime.execute("DELETE FROM native_summaries", [])?))
    {
        eprintln!("Could not refresh section previews: {error}");
    }
    Ok(())
}
/// The sections the upgrade deletes, as (owner, bot, id), once they are
/// backed up, and the dream logs it keeps as a bot's chat.
#[allow(clippy::type_complexity)]
fn plan_one_chat_per_bot(
    home: &Path,
    conn: &Connection,
) -> Result<(Vec<(String, String, String)>, Vec<String>)> {
    // Each bot on its own, recorded before anything else can fail, so the
    // chat is never a dream log whatever stops the upgrade. A bot whose store
    // from before the native daemon cannot be read keeps all its sections.
    let mut unreadable = BTreeSet::new();
    for row in rows(
        conn,
        "SELECT DISTINCT bot FROM sections WHERE peer_bot IS NULL",
        &[],
    )? {
        let bot = row["bot"].as_str().unwrap_or("");
        if let Err(error) = classify_dream_logs(home, bot) {
            eprintln!(
                "Kept every section of {bot}: could not read its older conversations: {error}"
            );
            unreadable.insert(bot.to_owned());
        }
    }
    let logs = runtime_store::dream_logs(home)?;
    // After a crash Pi's own log can hold the newest messages; recover them
    // before choosing which conversation stays.
    let unrecovered = runtime_store::reconcile_all(home)?;
    let mut chats: std::collections::BTreeMap<(String, String), Vec<Value>> = Default::default();
    for row in rows(
        conn,
        "SELECT * FROM sections WHERE peer_bot IS NULL ORDER BY id",
        &[],
    )? {
        let key = (
            row["owner_id"].as_str().unwrap_or("").to_owned(),
            row["bot"].as_str().unwrap_or("").to_owned(),
        );
        chats.entry(key).or_default().push(row);
    }
    // A bot with a conversation recovery set aside or could not read keeps
    // all its sections: what it holds is unknown, so none is deleted.
    let quarantined = runtime_store::open(home)?
        .prepare("SELECT session_id FROM native_quarantine")?
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<std::result::Result<BTreeSet<_>, _>>()?;
    let mut doomed = vec![];
    let mut renamed = vec![];
    for ((owner, bot), sections) in chats {
        if unreadable.contains(&bot)
            || sections.iter().any(|row| {
                let id = row["id"].as_str().unwrap_or("");
                quarantined.contains(id) || unrecovered.contains(id)
            })
        {
            continue;
        }
        let mut sections = chat_candidates(home, sections, &logs)?;
        // Unreadable history or a report-overwritten old choice is unknown.
        // Preserve the whole bot rather than guess which history to delete.
        if sections
            .iter()
            .any(|candidate| candidate.count == -2 || sections.len() > 1 && candidate.preserve)
        {
            continue;
        }
        rank_chats(&mut sections, &logs);
        let ChatCandidate { row, count, .. } = sections.remove(0);
        let id = |row: &Value| row["id"].as_str().unwrap_or("").to_owned();
        for other in sections {
            doomed.push((owner.clone(), bot.clone(), id(&other.row)));
        }
        if count < 0 {
            // The chat is made on first use.
            doomed.push((owner, bot, id(&row)));
        } else if logs.contains(&id(&row)) && row["title"] == "Dreams" {
            renamed.push(id(&row));
        }
    }
    if !doomed.is_empty() {
        let bots = doomed
            .iter()
            .map(|(_, bot, _)| bot.as_str())
            .collect::<BTreeSet<_>>();
        let dir = back_up(home, &bots).map_err(|error| {
            Error::new(
                error.code,
                format!("could not back them up first: {}", error.message),
            )
        })?;
        eprintln!(
            "Each bot now keeps one chat. The sections before the upgrade are backed up in {}",
            dir.display()
        );
    }
    Ok((doomed, renamed))
}
/// Copies the databases and conversation files the upgrade deletes from into
/// `backups/one-chat-per-bot-<time>/`, whole or not at all.
fn back_up(home: &Path, bots: &BTreeSet<&str>) -> Result<PathBuf> {
    let backups = home.join("backups");
    // A copy that failed part way, on this start or an earlier one, only
    // takes space.
    if backups.is_dir() {
        for entry in fs::read_dir(&backups)? {
            let entry = entry?;
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with("one-chat-per-bot-") && name.ends_with(".partial") {
                fs::remove_dir_all(entry.path())?;
            }
        }
    }
    let dir = backups.join(format!(
        "one-chat-per-bot-{}",
        chrono::Utc::now().format("%Y%m%d-%H%M%S")
    ));
    let partial = dir.with_extension("partial");
    let copied = copy_backup(home, bots, &partial).and_then(|()| Ok(fs::rename(&partial, &dir)?));
    if let Err(error) = copied {
        let _ = fs::remove_dir_all(&partial);
        return Err(error);
    }
    Ok(dir)
}
fn copy_backup(home: &Path, bots: &BTreeSet<&str>, to: &Path) -> Result<()> {
    fs::create_dir_all(to)?;
    let copy = |conn: &Connection, path: PathBuf| -> Result<()> {
        fs::create_dir_all(path.parent().unwrap_or(to))?;
        conn.execute("VACUUM INTO ?", [path.to_string_lossy()])?;
        Ok(())
    };
    copy(&db::open(home)?, to.join("hexbot.db"))?;
    copy(&runtime_store::open(home)?, to.join("hexbot-runtime.db"))?;
    // Conversations from before the native daemon are deleted there too.
    for bot in bots {
        let path = profile(home, bot)?.join("state.db");
        safe(home, &path)?;
        if path.try_exists()? {
            copy(
                &Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?,
                to.join("profiles").join(bot).join("state.db"),
            )?;
        }
    }
    let sessions = home.join("runtime/sessions");
    if sessions.try_exists()? {
        copy_tree(&sessions, &to.join("runtime/sessions"))?;
    }
    Ok(())
}
fn copy_tree(from: &Path, to: &Path) -> Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        let target = to.join(entry.file_name());
        if kind.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else if kind.is_file() {
            fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}
fn native_history(home: &Path, row: &Value) -> Result<bool> {
    Ok(runtime_store::open(home)?.query_row(
        "SELECT EXISTS(SELECT 1 FROM native_messages WHERE session_id=?1) OR EXISTS(SELECT 1 FROM native_pi_journal WHERE session_id=?1)",
        [row["id"].as_str().unwrap_or("")],
        |r| r.get(0),
    )?)
}
fn avatar(home: &Path, name: &str) -> Result<Value> {
    let dir = profile(home, name)?.join("assets");
    for (ext, mime) in [
        ("png", "image/png"),
        ("jpg", "image/jpeg"),
        ("webp", "image/webp"),
    ] {
        let path = dir.join(format!("avatar.{ext}"));
        safe(home, &path)?;
        if path.exists() {
            let data = fs::read(path)?;
            return Ok(
                json!({"mime":mime,"data":format!("data:{mime};base64,{}",STANDARD.encode(data))}),
            );
        }
    }
    Ok(Value::Null)
}
fn decode_avatar(value: &Value) -> Result<Option<(&'static str, Vec<u8>)>> {
    if value.is_null() {
        return Ok(None);
    }
    let text = value
        .as_str()
        .ok_or_else(|| Error::new(4202, "avatar must be an image or null"))?;
    let payload = if text.starts_with("data:") {
        text.split_once(',')
            .map(|(_, v)| v)
            .ok_or_else(|| Error::new(4068, "data is not valid base64"))?
    } else {
        text
    };
    if payload.len() > 2_666_672 {
        return Err(Error::new(4069, "asset too large (max 2MB)"));
    }
    let data = STANDARD
        .decode(payload)
        .map_err(|_| Error::new(4068, "data is not valid base64"))?;
    if data.len() > 2_000_000 {
        return Err(Error::new(4069, "asset too large (max 2MB)"));
    }
    let ext = if data.starts_with(b"\x89PNG\r\n\x1a\n") {
        "png"
    } else if data.starts_with(b"\xff\xd8\xff") {
        "jpg"
    } else if data.starts_with(b"RIFF") && data.get(8..12) == Some(b"WEBP") {
        "webp"
    } else {
        return Err(Error::new(
            4070,
            "unsupported image format (PNG/JPEG/WebP only)",
        ));
    };
    Ok(Some((ext, data)))
}
/// The shape and colour of a face picked in an app, `{shape, color}`, kept
/// beside the picture it describes so clients can draw it live.
fn face(home: &Path, name: &str) -> Result<Value> {
    let path = profile(home, name)?.join("assets/face.json");
    let text = read_text(home, &path)?;
    Ok(serde_json::from_str::<Value>(&text)
        .ok()
        .filter(|v| check_face(v).is_ok() && !v.is_null())
        .unwrap_or(Value::Null))
}
fn check_face(value: &Value) -> Result<()> {
    if value.is_null() {
        return Ok(());
    }
    let id = |v: &Value| {
        v.as_str().is_some_and(|s| {
            (1..=32).contains(&s.len())
                && s.bytes()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
        })
    };
    match value.as_object() {
        Some(o) if o.len() == 2 && id(&value["shape"]) && id(&value["color"]) => Ok(()),
        _ => Err(Error::new(
            4202,
            "face must be {shape, color} with short lowercase ids, or null",
        )),
    }
}
fn set_face(home: &Path, name: &str, value: &Value) -> Result<()> {
    let path = profile(home, name)?.join("assets/face.json");
    safe(home, &path)?;
    if value.is_null() {
        if path.exists() {
            fs::remove_file(path)?;
        }
        return Ok(());
    }
    let face = json!({"shape": value["shape"], "color": value["color"]});
    atomic_write(&path, face.to_string().as_bytes())
}
/// Replaces the picture. Any face stored for the old one no longer describes
/// it, so it goes too; a client picking a face sends `face` with the picture.
fn set_avatar(home: &Path, name: &str, value: &Value) -> Result<()> {
    let image = decode_avatar(value)?;
    let dir = profile(home, name)?.join("assets");
    for ext in ["png", "jpg", "webp"] {
        safe(home, &dir.join(format!("avatar.{ext}")))?;
    }
    set_face(home, name, &Value::Null)?;
    if let Some((ext, data)) = &image {
        atomic_write(&dir.join(format!("avatar.{ext}")), data)?;
    }
    for ext in ["png", "jpg", "webp"] {
        if image.as_ref().is_some_and(|(wanted, _)| *wanted == ext) {
            continue;
        }
        let path = dir.join(format!("avatar.{ext}"));
        if path.exists() {
            fs::remove_file(path)?;
        }
    }
    Ok(())
}
fn display_name(name: &str) -> String {
    name.split(['-', '_'])
        .map(|s| {
            let mut c = s.chars();
            c.next()
                .map(|c| c.to_uppercase().collect::<String>())
                .unwrap_or_default()
                + c.as_str()
        })
        .collect::<Vec<_>>()
        .join(" ")
}
/// The bot's newest failure that still has a visible cause. Hidden native runs
/// have no catalog section: require their bot and owner, and exclude deleted
/// sessions and catalog entries hidden by other filters. Connector and global
/// failures outlive their original chat. Needs `runtime` attached.
const OPEN_INCIDENT: &str = "SELECT i.* FROM bot_incidents i JOIN bots b ON b.name=i.bot
 WHERE i.bot=? AND i.resolved_at IS NULL AND (
    i.kind<>'turn_failed' OR CASE WHEN i.room_id IS NOT NULL
        THEN EXISTS(SELECT 1 FROM rooms r WHERE r.id=i.room_id AND r.owner_id=b.owner_id)
        ELSE i.section_id IS NULL
            OR EXISTS(SELECT 1 FROM room_sessions s JOIN rooms r ON r.id=s.room_id
                WHERE s.stored_session_id=i.section_id AND s.bot=i.bot AND r.owner_id=b.owner_id)
            OR EXISTS(SELECT 1 FROM sections s WHERE s.id=i.section_id
                AND s.bot=i.bot AND s.owner_id=b.owner_id AND s.archived_at IS NULL)
            OR (NOT EXISTS(SELECT 1 FROM sections s WHERE s.id=i.section_id)
                AND NOT EXISTS(SELECT 1 FROM room_sessions s WHERE s.stored_session_id=i.section_id)
                AND EXISTS(SELECT 1 FROM runtime.native_sessions s WHERE s.stored_id=i.section_id
                    AND s.bot=i.bot AND s.owner=b.owner_id)
                AND NOT EXISTS(SELECT 1 FROM runtime.native_deleted d WHERE d.session_id=i.section_id))
        END
 ) ORDER BY i.created_at DESC LIMIT 1";
fn shape_bot(home: &Path, caller: &str, row: Value) -> Result<Value> {
    let name = row["name"].as_str().unwrap_or("");
    let cfg = config(home, name)?;
    let sections = list_sections(home, caller, &json!({"bot":name,"include_archived":true}))?;
    let recent = sections
        .iter()
        .filter(|s| s["archived_at"].is_null())
        .take(2)
        .cloned()
        .collect::<Vec<_>>();
    let conn = db::open(home)?;
    runtime_store::open(home)?;
    conn.execute(
        "ATTACH DATABASE ? AS runtime",
        [home.join("hexbot-runtime.db").to_string_lossy().as_ref()],
    )?;
    let incident = rows(&conn, OPEN_INCIDENT, &[&name])?.into_iter().next();
    let (mut status, mut detail) = ("idle", Value::Null);
    if let Some(mut i) = incident {
        crate::settings::normalize_incident_room(&conn, &mut i)?;
        status = "stopped";
        let action = if i["kind"] == "turn_failed" {
            json!({"kind":"retry"})
        } else if i["connector"].is_string() {
            json!({"kind":"fix_connector","connector":i["connector"]})
        } else {
            Value::Null
        };
        detail = json!({"text":i["text"],"section_id":i["section_id"],"room_id":i["room_id"],"session_id":i["session_id"],"since":i["created_at"],"action":action});
    } else {
        let wait = rows(
            &db::open(home)?,
            "SELECT e.room_id,e.created_at,r.name FROM room_events e JOIN rooms r ON r.id=e.room_id WHERE e.kind='waiting.human' AND e.actor_id=? AND e.seq=(SELECT MAX(seq) FROM room_events WHERE room_id=e.room_id) AND r.archived_at IS NULL ORDER BY e.created_at DESC LIMIT 1",
            &[&name],
        )?
        .into_iter()
        .next();
        if let Some(r) = wait {
            status = "needs_you";
            detail = json!({
                "text": format!("Waiting on you in “{}”.", r["name"].as_str().unwrap_or("")),
                "section_id": null,
                "room_id": r["room_id"],
                "session_id": null,
                "since": r["created_at"],
                "action": null
            });
        } else if let Some(r) = rows(
            &db::open(home)?,
            "SELECT t.room_id,t.started_at,r.name FROM room_turns t JOIN rooms r ON r.id=t.room_id WHERE t.bot=? AND t.status='running' ORDER BY t.started_at DESC LIMIT 1",
            &[&name],
        )?
        .into_iter()
        .next()
        {
            status = "working";
            detail = json!({
                "text": format!("Working in “{}”.", r["name"].as_str().unwrap_or("")),
                "section_id": null,
                "room_id": r["room_id"],
                "session_id": null,
                "since": r["started_at"],
                "action": null
            });
        }
    }
    let enabled = crate::connectors::toolsets(home, name)?;
    let missing = crate::native_tools::not_set_up(home, name)?;
    let available = TOOLS
        .iter()
        .filter(|(_, v)| !missing.contains(v))
        .collect::<Vec<_>>();
    let tools = available
        .iter()
        .filter(|(_, v)| enabled.iter().any(|t| t == v))
        .map(|(k, _)| *k)
        .collect::<Vec<_>>();
    Ok(json!({
        "name": name,
        "display_name": row["display_name"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| display_name(name)),
        "title": row["title"].as_str().unwrap_or(""),
        "description": row["description"].as_str().unwrap_or(""),
        "primary": row["is_primary"].as_i64() == Some(1),
        "persona": read_text(home, &profile(home, name)?.join("SOUL.md"))?,
        "skills": crate::skills::resolve(home, Some(name))?.into_iter().filter(|s| s.enabled).map(|s| s.name).collect::<Vec<_>>(),
        "tools": tools,
        "available_tools": available.iter().map(|(k, _)| *k).collect::<Vec<_>>(),
        "dream_enabled": row["dream_enabled"].as_i64().unwrap_or(1) != 0,
        "notify": row["notify"].as_i64().unwrap_or(1) != 0,
        "approval_mode": row["approval_mode"].as_str().unwrap_or("inherit"),
        "workdir": row["workdir"],
        "status": status,
        "status_detail": detail,
        "provider": cfg["model"]["provider"],
        "model": cfg["model"]
            .as_str()
            .map(Value::from)
            .unwrap_or_else(|| cfg["model"]["default"].clone()),
        "reasoning_effort": cfg["model"]["reasoning_effort"],
        "avatar": avatar(home, name)?,
        "face": face(home, name)?,
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "last_activity_at": row["last_activity_at"],
        "owner_id": row["owner_id"],
        "sections_total": sections.len(),
        "sections_recent": recent
    }))
}
pub fn bot(home: &Path, caller: &str, name: &str) -> Result<Value> {
    shape_bot(home, caller, bot_row(home, caller, name)?)
}
fn validate_patch(home: &Path, p: &Value) -> Result<()> {
    let object = p
        .as_object()
        .ok_or_else(|| Error::new(4202, "bot fields must be an object"))?;
    for (key, value) in object {
        if !FIELDS.contains(&key.as_str()) {
            return Err(Error::new(4201, format!("unknown bot field: {key}")));
        }
        match key.as_str() {
            "notify" | "dream_enabled" if !value.is_boolean() => {
                return Err(Error::new(4202, format!("{key} must be a boolean")));
            }
            "approval_mode"
                if !["inherit", "manual", "smart", "off"]
                    .contains(&value.as_str().unwrap_or("")) =>
            {
                return Err(Error::new(
                    4202,
                    "approval_mode must be inherit, manual, smart, or off",
                ));
            }
            "workdir"
                if !value.is_null() && !value.as_str().is_some_and(|s| !s.trim().is_empty()) =>
            {
                return Err(Error::new(4202, "workdir must be a path or null"));
            }
            "workdir" => {
                if let Some(dir) = value.as_str() {
                    check_workdir(home, dir.trim())?;
                }
            }
            "skills" | "tools" => {
                let items = value
                    .as_array()
                    .ok_or_else(|| Error::new(4202, format!("{key} must be a list")))?;
                for item in items {
                    let item = item
                        .as_str()
                        .ok_or_else(|| Error::new(4202, format!("{key} must contain strings")))?;
                    if key == "tools" && !TOOLS.iter().any(|(k, _)| *k == item) {
                        return Err(Error::new(4202, format!("unknown tool: {item}")));
                    }
                }
            }
            "avatar" => {
                decode_avatar(value)?;
            }
            "face" => check_face(value)?,
            "reasoning_effort"
                if !value.is_null()
                    && !value
                        .as_str()
                        .is_some_and(|s| crate::pi::THINKING_LEVELS.contains(&s)) =>
            {
                return Err(Error::new(
                    4202,
                    format!(
                        "reasoning_effort must be null or one of {}",
                        crate::pi::THINKING_LEVELS.join(", ")
                    ),
                ));
            }
            "name" | "display_name" | "title" | "description" | "persona" | "provider"
            | "model"
                if !value.is_null() && !value.is_string() =>
            {
                return Err(Error::new(4202, format!("{key} must be a string")));
            }
            _ => {}
        }
    }
    Ok(())
}
pub fn enabled_skills(home: &Path, name: &str) -> Result<Vec<Value>> {
    Ok(crate::skills::resolve(home, Some(name))?
        .into_iter()
        .filter(|s| s.enabled)
        .map(|s| json!(s))
        .collect())
}
fn profile_call(home: &Path, caller: &str, method: &str, p: &Value) -> Result<Value> {
    let name = required(p, "name")?;
    let row = bot_row(home, caller, name)?;
    match method {
        "profiles.describe" => {
            let cfg = config(home, name)?;
            let skills = crate::skills::resolve(home, Some(name))?;
            let enabled = crate::connectors::toolsets(home, name)?;
            let mut names = enabled.clone();
            names.extend(TOOLS.iter().map(|(_, t)| t.to_string()));
            names.sort();
            names.dedup();
            Ok(json!({
                "name": name,
                "description": row["description"].as_str().unwrap_or(""),
                "soul": read_text(home, &profile(home, name)?.join("SOUL.md"))?,
                "model": public_model(&cfg["model"]),
                "skills": skills,
                "toolsets": names
                    .iter()
                    .map(|s| {
                        json!({
                        "name":s,
                        "enabled":enabled.contains(s),
                        "description":"",
                        "tool_count":0}
                        )
                    })
                    .collect::<Vec<_>>()
            }))
        }
        "profiles.get_asset" => {
            if p["asset"].as_str().is_some_and(|s| s != "avatar") {
                return Err(Error::new(4066, "unknown asset"));
            }
            let mut result = avatar(home, name)?;
            if result.is_null() {
                return Ok(json!({"found":false}));
            }
            result["found"] = json!(true);
            Ok(result)
        }
        "profiles.set_asset" => {
            if p["asset"].as_str().is_some_and(|s| s != "avatar") {
                return Err(Error::new(4066, "unknown asset"));
            }
            let value = if p["clear"] == true {
                Value::Null
            } else {
                p["data"].clone()
            };
            let size = decode_avatar(&value)?.map(|(_, v)| v.len()).unwrap_or(0);
            set_avatar(home, name, &value)?;
            Ok(json!({"ok":true,"asset":"avatar","size":size}))
        }
        "profiles.configure" => {
            let mut patch = json!({"name":name});
            for key in ["description", "provider", "model"] {
                if let Some(value) = p.get(key) {
                    patch[key] = value.clone();
                }
            }
            if let Some(value) = p.get("soul") {
                patch["persona"] = value.clone();
            }
            validate_patch(home, &patch)?;
            configure(home, name, &patch)?;
            let writer = common::config_writer()?;
            let mut cfg = config(home, name)?;
            for (key, section, leaf) in [
                ("disabled_skills", "skills", "disabled"),
                ("enabled_toolsets", "tools", "enabled_toolsets"),
            ] {
                if let Some(value) = p.get(key) {
                    if !value
                        .as_array()
                        .is_some_and(|v| v.iter().all(Value::is_string))
                    {
                        return Err(Error::new(4202, format!("{key} must be a list of strings")));
                    }
                    if !cfg[section].is_object() {
                        cfg[section] = json!({});
                    }
                    cfg[section][leaf] = value.clone();
                }
            }
            writer.write(&profile(home, name)?, &cfg)?;
            if let Some(description) = p["description"].as_str() {
                db::open(home)?.execute(
                    "UPDATE bots SET description=?,updated_at=? WHERE name=?",
                    params![description, now(), name],
                )?;
            }
            Ok(json!({
                "name": name,
                "applied": {
                    "model": p.get("model").is_some() || p.get("provider").is_some(),
                    "soul": p.get("soul").is_some(),
                    "skills": p.get("disabled_skills").is_some(),
                    "tools": p.get("enabled_toolsets").is_some()
                }
            }))
        }
        _ => Err(Error::new(-32601, "method not found")),
    }
}
/// Writes a bot's profile. Sections still on its previous model move with it,
/// under the same lock so concurrent updates move them in order.
fn configure(home: &Path, name: &str, p: &Value) -> Result<()> {
    let _skills = crate::skills::read_lock()?;
    let writer = common::config_writer()?;
    // Only a patch that names a model field moves sections; any other edit
    // leaves an inherited deployment model alone.
    let moves = ["provider", "model", "reasoning_effort"]
        .iter()
        .any(|key| p.get(*key).is_some());
    let before = section_model(home, name)?;
    let dir = profile(home, name)?;
    let mut cfg = config(home, name)?;
    if cfg["model"].is_string() {
        cfg["model"] = json!({"default":cfg["model"].clone()});
    }
    for block in [
        "model",
        "tools",
        "platform_toolsets",
        "known_plugin_toolsets",
        "skills",
        "hexbot",
        "terminal",
    ] {
        if !cfg[block].is_object() {
            cfg[block] = json!({});
        }
    }
    for (key, target) in [("provider", "provider"), ("model", "default")] {
        if let Some(v) = p.get(key).filter(|v| !v.is_null()) {
            cfg["model"][target] = v.clone();
        }
    }
    match p.get("reasoning_effort") {
        Some(Value::Null) => {
            cfg["model"]
                .as_object_mut()
                .unwrap()
                .remove("reasoning_effort");
        }
        Some(level) => cfg["model"]["reasoning_effort"] = level.clone(),
        None => {}
    }
    if let Some(tools) = p["tools"].as_array() {
        // Creating a bot configures its profile before the registry row exists.
        let mut enabled = cfg["tools"]["enabled_toolsets"]
            .as_array()
            .or_else(|| cfg["platform_toolsets"]["cli"].as_array())
            .cloned()
            .unwrap_or_else(|| {
                [
                    "terminal",
                    "file",
                    "web",
                    "browser",
                    "vision",
                    "image_gen",
                    "tts",
                    "skills",
                    "todo",
                    "memory",
                    "session_search",
                    "clarify",
                    "delegation",
                    "cronjob",
                    "hexbot",
                ]
                .into_iter()
                .map(Value::from)
                .collect()
            });
        // A tool that isn't set up on this computer is dropped, so a bot
        // never keeps one switched on that settings no longer shows.
        let effective = common::merged_config_with(home, &cfg)?;
        let missing = crate::native_tools::not_set_up_with_config(home, name, &effective)?;
        enabled.retain(|v| !TOOLS.iter().any(|(_, t)| v == t));
        for item in tools {
            if let Some((_, t)) = TOOLS.iter().find(|(k, _)| item == k)
                && !missing.contains(t)
                && !enabled.contains(&json!(t))
            {
                enabled.push(json!(t));
            }
        }
        cfg["tools"]["enabled_toolsets"] = json!(enabled);
        cfg["platform_toolsets"]["cli"] = json!(enabled);
        cfg["known_plugin_toolsets"]["cli"] = json!(["hexbot"]);
    }
    if let Some(v) = p["skills"].as_array() {
        let installed = crate::skills::resolve_unlocked(home, Some(name))?;
        for chosen in v {
            if !installed.iter().any(|s| chosen == &s.name) {
                return Err(Error::new(
                    4202,
                    format!("unknown skill: {}", chosen.as_str().unwrap_or("")),
                ));
            }
        }
        cfg["skills"]["disabled"] = json!(
            installed
                .into_iter()
                .filter(|s| if s.disabled_globally {
                    !s.enabled_for_bot
                } else {
                    !v.contains(&json!(s.name))
                })
                .map(|s| s.name)
                .collect::<Vec<_>>()
        );
    }
    if let Some(v) = p.get("approval_mode") {
        cfg["hexbot"]["approval_mode"] = v.clone();
    }
    if let Some(v) = p.get("workdir") {
        cfg["terminal"]["cwd"] = v
            .as_str()
            .map(str::trim)
            .map(Value::from)
            .unwrap_or(Value::Null);
    }
    writer.write(&dir, &cfg)?;
    let after = section_model(home, name)?;
    if moves && before != after {
        runtime_store::follow_bot_model(home, name, &before, &after)?;
    }
    if let Some(v) = p["persona"].as_str() {
        let path = dir.join("SOUL.md");
        safe(home, &path)?;
        atomic_write(&path, v.as_bytes())?;
    }
    if let Some(v) = p.get("avatar") {
        set_avatar(home, name, v)?;
    }
    if let Some(v) = p.get("face") {
        set_face(home, name, v)?;
    }
    let path = dir.join("profile.yaml");
    let text = read_text(home, &path)?;
    let mut meta = serde_yaml::from_str::<Value>(&text).unwrap_or(json!({}));
    if !meta.is_object() {
        meta = json!({});
    }
    for key in ["display_name", "description"] {
        if let Some(v) = p.get(key) {
            meta[key] = v.clone();
        }
    }
    write_yaml(home, &path, &meta)
}
fn create_bot(home: &Path, caller: &str, p: &Value) -> Result<Value> {
    create(home, caller, p, false)
}
/// The caller's primary bot, if they have one.
pub fn primary_bot(home: &Path, caller: &str) -> Result<Option<String>> {
    Ok(db::open(home)?
        .query_row(
            "SELECT name FROM bots WHERE owner_id=? AND is_primary=1",
            [caller],
            |r| r.get(0),
        )
        .optional()?)
}
fn no_primary_yet(home: &Path, caller: &str) -> Result<()> {
    if primary_bot(home, caller)?.is_some() {
        return Err(Error::new(4214, "There is already a primary bot."));
    }
    Ok(())
}
/// The primary bot stays: the daemon checks before it stops any of a bot's sections.
pub fn check_deletable(home: &Path, caller: &str, name: &str) -> Result<()> {
    if bot_row(home, caller, name)?["is_primary"].as_i64() == Some(1) {
        return Err(Error::new(4214, "The primary bot can't be deleted."));
    }
    Ok(())
}
/// Creates HexBot: every tool it can use, a soul for running the place, and
/// the primary mark. The caller may choose its display name, model, avatar and face.
fn create_primary(home: &Path, caller: &str, p: &Value) -> Result<Value> {
    user(home, caller)?;
    let object = p
        .as_object()
        .ok_or_else(|| Error::new(4202, "bot fields must be an object"))?;
    if let Some(key) = object.keys().find(|key| {
        ![
            "display_name",
            "provider",
            "model",
            "reasoning_effort",
            "avatar",
            "face",
        ]
        .contains(&key.as_str())
    }) {
        return Err(Error::new(4201, format!("unknown bot field: {key}")));
    }
    no_primary_yet(home, caller)?;
    let mut patch = p.clone();
    patch["name"] = json!(PRIMARY_NAME);
    if !p["display_name"]
        .as_str()
        .is_some_and(|s| !s.trim().is_empty())
    {
        patch["display_name"] = json!(PRIMARY_DISPLAY_NAME);
    }
    patch["title"] = json!(PRIMARY_TITLE);
    patch["description"] = json!(PRIMARY_DESCRIPTION);
    patch["persona"] = json!(PRIMARY_SOUL);
    patch["tools"] = json!(TOOLS.iter().map(|(k, _)| *k).collect::<Vec<_>>());
    create(home, caller, &patch, true)
}
/// Makes an existing bot primary. Only while there is none, so the role never moves.
fn set_primary(home: &Path, caller: &str, name: &str) -> Result<Value> {
    bot_row(home, caller, name)?;
    let changed = db::open(home)?.execute(
        "UPDATE bots SET is_primary=1,updated_at=?1 WHERE name=?2 AND owner_id=?3 AND NOT EXISTS(SELECT 1 FROM bots WHERE owner_id=?3 AND is_primary=1)",
        params![now(), name, caller],
    )?;
    if changed == 0 {
        return Err(Error::new(4214, "There is already a primary bot."));
    }
    Ok(json!({"bot":bot(home,caller,name)?}))
}
fn create(home: &Path, caller: &str, p: &Value, primary: bool) -> Result<Value> {
    user(home, caller)?;
    validate_patch(home, p)?;
    let name = required(p, "name")?;
    if name.len() > 64
        || !name
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_' || c == b'-')
        || !name
            .bytes()
            .next()
            .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        || ["default", "hermes", "test", "tmp", "root", "sudo"].contains(&name)
        || (name == PRIMARY_NAME && !primary)
    {
        return Err(Error::new(4202, "invalid or reserved bot name"));
    }
    // Reserve the name and profile against journal cleanup. Release the catalog
    // write reservation before taking the skills/config locks below.
    let mut conn = db::open(home)?;
    let reservation = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if reservation
        .query_row("SELECT 1 FROM bots WHERE name=?", [name], |_| Ok(()))
        .optional()?
        .is_some()
    {
        return Err(Error::new(
            4208,
            if primary {
                format!("A bot named {name} already exists. Make it your primary bot instead.")
            } else {
                format!("bot already exists: {name}")
            },
        ));
    }
    if bot_delete_journal(&reservation, name)?.is_some() {
        return Err(Error::new(
            4208,
            format!("bot deletion is still pending: {name}; restart to retry cleanup"),
        ));
    }
    let dir = profile(home, name)?;
    if dir.try_exists()? {
        return Err(Error::new(4208, format!("profile already exists: {name}")));
    }
    let mut patch = p.clone();
    let display = p["display_name"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| display_name(name));
    patch["display_name"] = json!(display);
    if !p["persona"].as_str().is_some_and(|s| !s.trim().is_empty()) {
        let role = p["title"]
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| format!(", {s}"))
            .unwrap_or_default();
        patch["persona"] = json!(format!(
            "You are {display}{role}, a bot in Hexbot. Be direct and concise: match the length of your reply to the weight of the ask. Use your tools when they help, ask when a request is ambiguous, and remember what matters about the people you work with."
        ));
    }
    fs::create_dir_all(dir.parent().unwrap())?;
    fs::create_dir(&dir).map_err(|e| {
        if e.kind() == std::io::ErrorKind::AlreadyExists {
            Error::new(4208, format!("profile already exists: {name}"))
        } else {
            e.into()
        }
    })?;
    reservation.commit()?;
    // Seed deployment defaults so every new bot sees the existing model and tool settings.
    let result = (|| {
        {
            let writer = common::config_writer()?;
            let global = creation_config(read_config(home)?);
            writer.write(&dir, &global)?;
        }
        configure(home, name, &patch)?;
        let now = now();
        let mut conn = db::open(home)?;
        let tx = conn.transaction()?;
        // The unique index refuses a second primary bot created at the same time.
        tx.execute(
            "INSERT INTO bots(name,display_name,title,description,owner_id,created_at,updated_at,last_activity_at,is_primary) VALUES (?,?,?,?,?,?,?,?,?)",
            params![
                name,
                display,
                p["title"].as_str().unwrap_or(""),
                p["description"].as_str().unwrap_or(""),
                caller,
                now,
                now,
                now,
                primary
            ],
        )
        .map_err(|e| {
            if primary
                && let rusqlite::Error::SqliteFailure(f, _) = &e
                && f.code == rusqlite::ErrorCode::ConstraintViolation
            {
                Error::new(4214, "There is already a primary bot.")
            } else {
                e.into()
            }
        })?;
        write_bot_columns(&tx, name, &patch)?;
        let sid = id();
        tx.execute("INSERT INTO sections(id,bot,title,owner_id,created_at,updated_at) VALUES (?,?,'General',?,?,?)",params![sid,name,caller,now,now])?;
        tx.commit()?;
        Ok(sid)
    })();
    let sid = match result {
        Ok(v) => v,
        Err(e) => {
            let _ = fs::remove_dir_all(dir);
            return Err(e);
        }
    };
    crate::settings::mirror(home, &profile(home, name)?)?;
    Ok(json!({"bot":bot(home,caller,name)?,"section":section(home,caller,&sid)?}))
}
/// Create and update store every accepted column the same way.
fn write_bot_columns(tx: &rusqlite::Transaction, name: &str, p: &Value) -> Result<()> {
    for key in [
        "display_name",
        "title",
        "description",
        "dream_enabled",
        "notify",
        "approval_mode",
        "workdir",
        "tools",
        "skills",
    ] {
        if let Some(value) = p.get(key) {
            let column = match key {
                "tools" => "tools_json",
                "skills" => "skills_json",
                other => other,
            };
            let value = match value {
                Value::Null => rusqlite::types::Value::Null,
                Value::Bool(v) => rusqlite::types::Value::Integer(i64::from(*v)),
                Value::String(v) => rusqlite::types::Value::Text(if key == "workdir" {
                    v.trim().into()
                } else {
                    v.clone()
                }),
                Value::Array(items) => {
                    let mut unique = Vec::new();
                    for item in items {
                        if !unique.contains(item) {
                            unique.push(item.clone());
                        }
                    }
                    rusqlite::types::Value::Text(json!(unique).to_string())
                }
                _ => return Err(Error::new(4202, "invalid bot field")),
            };
            tx.execute(
                &format!("UPDATE bots SET {column}=? WHERE name=?"),
                params![value, name],
            )?;
        }
    }
    Ok(())
}
/// The provider, model and thinking level a new section of this bot starts with.
fn section_model(home: &Path, name: &str) -> Result<Value> {
    let mut model = config(home, name)?["model"].clone();
    if model.is_null() {
        model = common::read_config(home)?["model"].clone();
    }
    if model.is_string() {
        model = json!({"default":model});
    }
    Ok(json!({
        "provider": model["provider"],
        "model": model["default"],
        "reasoning_effort": model["reasoning_effort"]
    }))
}
fn update_bot(home: &Path, caller: &str, p: &Value) -> Result<Value> {
    let name = required(p, "name")?;
    bot_row(home, caller, name)?;
    validate_patch(home, p)?;
    // A face describes the picture sent with it; alone it would sit on a photo.
    if p.get("face").is_some_and(|v| !v.is_null()) && p.get("avatar").is_none_or(Value::is_null) {
        return Err(Error::new(4202, "face needs the avatar it describes"));
    }
    configure(home, name, p)?;
    let mut conn = db::open(home)?;
    let tx = conn.transaction()?;
    write_bot_columns(&tx, name, p)?;
    tx.execute(
        "UPDATE bots SET updated_at=? WHERE name=?",
        params![now(), name],
    )?;
    tx.commit()?;
    crate::settings::mirror(home, &profile(home, name)?)?;
    Ok(json!({"bot":bot(home,caller,name)?}))
}
/// The catalog row goes first, in a transaction of its own, and the history
/// after it: a stop before the row goes leaves the section as it was, and one
/// after leaves history no section reads, which the next start removes
/// (`runtime_store::finish_deletes`). With `purge` the bot's older store loses
/// the section too. An error means the catalog delete failed; Some(error)
/// means it committed but history cleanup failed. Callers must not present
/// the latter as a section the user can still open or retry deleting.
fn delete_section(home: &Path, caller: &str, id: &str, purge: bool) -> Result<Option<Error>> {
    let row = section_row(home, caller, id)?;
    let pending = runtime_store::with_section_delete(
        home,
        id,
        required(&row, "bot")?,
        required(&row, "owner_id")?,
        purge,
        || {
            let mut conn = db::open(home)?;
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            if tx.execute("DELETE FROM sections WHERE id=?", [id])? == 0 {
                return Err(Error::new(4204, "section not found"));
            }
            // Room and connector failures still have a cause outside this section.
            tx.execute(
                "UPDATE bot_incidents SET resolved_at=? WHERE section_id=? AND bot=?
                 AND kind='turn_failed' AND room_id IS NULL AND resolved_at IS NULL
                 AND EXISTS(SELECT 1 FROM bots b WHERE b.name=bot_incidents.bot AND b.owner_id=?4)
                 AND NOT EXISTS(SELECT 1 FROM room_sessions s JOIN rooms r ON r.id=s.room_id
                     WHERE s.stored_session_id=bot_incidents.section_id
                     AND s.bot=bot_incidents.bot AND r.owner_id=?4)",
                params![now(), id, row["bot"].as_str(), caller],
            )?;
            tx.execute(
                "UPDATE bots SET last_activity_at=? WHERE name=?",
                params![now(), row["bot"].as_str()],
            )?;
            #[cfg(all(test, unix))]
            section_delete_barrier(home, "before_commit")?;
            tx.commit()?;
            #[cfg(all(test, unix))]
            section_delete_barrier(home, "after_commit")?;
            Ok(())
        },
    )?;
    let cleaned = pending.map_or_else(
        || {
            if purge {
                runtime_store::delete_pending(home, id)
            } else {
                Ok(())
            }
        },
        Err,
    );
    if let Err(error) = cleaned {
        let error = Error::new(
            error.code,
            format!("Deleted section {id}, but not all of its history yet: {error}"),
        )
        .with_data(json!({"section_deleted":id}));
        eprintln!("{error}");
        return Ok(Some(error));
    }
    Ok(None)
}

#[cfg(all(test, unix))]
pub(crate) fn section_delete_barrier(home: &Path, phase: &str) -> Result<()> {
    use std::io::{Read, Write};
    let path = home.join("delete-barrier.sock");
    if path.try_exists()? {
        let mut socket = std::os::unix::net::UnixStream::connect(path)?;
        socket.write_all(phase.as_bytes())?;
        socket.read_exact(&mut [0])?;
    }
    Ok(())
}

// A bot deletion spans the catalog, native SQLite store and profile directory.
// Keep its exact targets in the existing settings journal until cleanup finishes.
// The bot row is the commit decision; no history or profile is removed before it.
const BOT_DELETE_PREFIX: &str = "pending_bot_delete:";

fn bot_delete_journal(conn: &Connection, name: &str) -> Result<Option<Value>> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key=?",
            [format!("{BOT_DELETE_PREFIX}{name}")],
            |r| r.get(0),
        )
        .optional()?;
    raw.map(|raw| serde_json::from_str(&raw).map_err(|e| Error::new(5200, e.to_string())))
        .transpose()
}

pub fn prepare_bot_delete(home: &Path, caller: &str, name: &str) -> Result<Vec<Value>> {
    runtime_store::with_tombstone(home, || prepare_bot_delete_locked(home, caller, name))
}

fn prepare_bot_delete_locked(home: &Path, caller: &str, name: &str) -> Result<Vec<Value>> {
    let mut conn = db::open(home)?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let targets = prepare_bot_delete_in(home, caller, name, &tx)?;
    tx.commit()?;
    Ok(targets)
}

pub(crate) fn retire_bot_delete(home: &Path, caller: &str, name: &str) -> Result<Vec<Value>> {
    runtime_store::with_tombstone(home, || {
        let targets = prepare_bot_delete_locked(home, caller, name)?;
        let mut conn = db::open(home)?;
        let journal = bot_delete_journal(&conn, name)?.unwrap();
        // The journal must precede retirement in the other store, including if
        // this process stops between these commits. Retention is not changed.
        if let Err(error) =
            runtime_store::mark_bot_retiring(home, name, &targets, required(&journal, "attempt")?)
        {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            rollback_bot_delete_in(home, name, &tx, Some(&targets), false)?;
            tx.commit()?;
            return Err(error);
        }
        Ok(targets)
    })
}

fn prepare_bot_delete_in(
    home: &Path,
    caller: &str,
    name: &str,
    conn: &Connection,
) -> Result<Vec<Value>> {
    bot_owner(home, caller, name)?;
    check_deletable(home, caller, name)?;
    let journal = bot_delete_journal(conn, name)?;
    let previous = if let Some(journal) = &journal {
        if journal["committed"] == true {
            return Err(Error::new(
                4208,
                format!("bot deletion is still pending: {name}"),
            ));
        }
        journal["targets"]
            .as_array()
            .cloned()
            .ok_or_else(|| Error::new(5200, "Invalid bot deletion journal"))?
    } else {
        Vec::new()
    };
    // Validate the profile boundary before retiring anything.
    safe(home, &profile(home, name)?.join("memories/MEMORY.md"))?;
    let mut targets = runtime_store::owned_sessions(home, name)?
        .into_iter()
        .map(|session| json!({"id":session["stored_id"],"owner":session["owner"]}))
        .collect::<Vec<_>>();
    targets.extend(rows(conn, "SELECT id,owner_id AS owner FROM sections WHERE bot=? UNION SELECT stored_session_id AS id,owner_id AS owner FROM room_sessions JOIN rooms ON rooms.id=room_sessions.room_id WHERE room_sessions.bot=?", &[&name, &name])?);
    // A repeated preparation may discover new sessions, but must retain the
    // original exact targets even if their catalog/native mappings disappeared.
    for target in previous {
        if !targets.iter().any(|t| t["id"] == target["id"]) {
            targets.push(target);
        }
    }
    // Capture descendants before any purge can remove their parent links.
    for target in targets.clone() {
        for id in runtime_store::descendants(home, required(&target, "id")?)? {
            if !targets.iter().any(|t| t["id"] == id) {
                targets.push(json!({"id":id,"owner":target["owner"]}));
            }
        }
    }
    conn.execute(
        "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![
            format!("{BOT_DELETE_PREFIX}{name}"),
            json!({"targets":targets,"committed":false,"name_reserved":true,
                "attempt":journal.as_ref().and_then(|j|j["attempt"].as_str()).map(str::to_owned).unwrap_or_else(id)}).to_string()
        ],
    )?;
    Ok(targets)
}

pub fn rollback_bot_delete(home: &Path, name: &str) -> Result<()> {
    runtime_store::with_tombstone(home, || {
        let mut conn = db::open(home)?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        rollback_bot_delete_in(home, name, &tx, None, false)?;
        tx.commit()?;
        Ok(())
    })
}

fn rollback_bot_delete_in(
    home: &Path,
    name: &str,
    conn: &Connection,
    expected: Option<&[Value]>,
    recovering: bool,
) -> Result<()> {
    if let Some(journal) = bot_delete_journal(conn, name)? {
        if journal["committed"] == true {
            return Ok(());
        }
        let targets = journal["targets"]
            .as_array()
            .ok_or_else(|| Error::new(5200, "Invalid bot deletion journal"))?;
        if expected.is_some_and(|expected| expected != targets) {
            return Ok(());
        }
        runtime_store::rollback_bot_retiring(
            home,
            name,
            targets,
            journal["attempt"].as_str(),
            recovering,
        )?;
        conn.execute(
            "DELETE FROM settings WHERE key=?",
            [format!("{BOT_DELETE_PREFIX}{name}")],
        )?;
    }
    Ok(())
}

fn finish_bot_delete(home: &Path, name: &str) -> Result<()> {
    // A product closure may need either SQLite writer to finish. Wait for its
    // real work before reserving the catalog writer used to order name reuse.
    runtime_store::with_tombstone(home, || finish_bot_delete_locked(home, name))
}

fn finish_bot_delete_locked(home: &Path, name: &str) -> Result<()> {
    let mut conn = db::open(home)?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    // Another cleanup may have completed since the caller enumerated journals.
    let Some(journal) = bot_delete_journal(&tx, name)? else {
        return Ok(());
    };
    if journal["committed"] != true {
        rollback_bot_delete_in(home, name, &tx, None, true)?;
        tx.commit()?;
        return Ok(());
    }
    let dir = profile(home, name)?;
    let bot_exists: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM bots WHERE name=?)",
        [name],
        |r| r.get(0),
    )?;
    if bot_exists {
        return Err(Error::new(
            5200,
            format!(
                "Cannot finish deleting bot {name}: catalog bot exists; preserved data and pending journal for recovery"
            ),
        ));
    }
    // Older journals allowed name reuse. With a remaining profile and no
    // reservation provenance, its generation is unknown, even without a row.
    if journal["name_reserved"] != true && dir.try_exists()? {
        return Err(Error::new(
            5200,
            format!(
                "Cannot finish deleting bot {name}: profile ownership is unknown; preserved data and pending journal for recovery"
            ),
        ));
    }
    let targets = journal["targets"]
        .as_array()
        .ok_or_else(|| Error::new(5200, "Invalid bot deletion journal"))?;
    runtime_store::purge_bot_targets(home, name, targets)?;
    let jobs = runtime_store::open(home)?;
    jobs.execute("DELETE FROM native_jobs WHERE bot=?", [name])?;
    jobs.execute("DELETE FROM native_job_imports WHERE bot=?", [name])?;
    if dir.try_exists()? {
        // Save durable memory before removing the profile. A failed save keeps it all.
        let memory = dir.join("memories/MEMORY.md");
        safe(home, &memory)?;
        if memory.try_exists()? {
            let saved = home
                .join("runtime/deleted-bots")
                .join(format!("{name}-{}", id()))
                .join("MEMORY.md");
            safe(home, &saved)?;
            atomic_write(&saved, &fs::read(&memory)?)?;
        }
        fs::remove_dir_all(&dir)?;
    }
    for target in targets {
        runtime_store::complete_legacy_delete(home, required(target, "id")?)?;
    }
    tx.execute(
        "DELETE FROM settings WHERE key=?",
        [format!("{BOT_DELETE_PREFIX}{name}")],
    )?;
    tx.commit()?;
    Ok(())
}

/// Runs before generic section tombstones: hidden sessions share the bot's commit decision.
pub fn finish_bot_deletes(home: &Path) -> Result<()> {
    let conn = db::open(home)?;
    let mut result = Ok(());
    for row in rows(
        &conn,
        "SELECT key FROM settings WHERE key LIKE 'pending_bot_delete:%'",
        &[],
    )? {
        let key = required(&row, "key")?;
        let name = &key[BOT_DELETE_PREFIX.len()..];
        if let Err(error) = finish_bot_delete(home, name) {
            eprintln!("Could not finish deleting bot {name}: {error}");
            if result.is_ok() {
                result = Err(error);
            }
        }
    }
    result
}

/// Generic tombstone recovery must leave unresolved bot decisions alone.
pub(crate) fn pending_bot_delete_targets(home: &Path) -> Result<BTreeSet<String>> {
    bot_delete_targets(home, false)
}

/// Only a committed bot decision delegates legacy purging to profile removal.
/// Provisional journals still protect rollback and generic startup recovery.
pub(crate) fn committed_bot_delete_targets(home: &Path) -> Result<BTreeSet<String>> {
    bot_delete_targets(home, true)
}

fn bot_delete_targets(home: &Path, committed_only: bool) -> Result<BTreeSet<String>> {
    let mut targets = BTreeSet::new();
    for row in rows(
        &db::open(home)?,
        "SELECT value FROM settings WHERE key LIKE 'pending_bot_delete:%'",
        &[],
    )? {
        let journal: Value = serde_json::from_str(required(&row, "value")?)
            .map_err(|e| Error::new(5200, e.to_string()))?;
        if committed_only && journal["committed"] != true {
            continue;
        }
        for target in journal["targets"]
            .as_array()
            .ok_or_else(|| Error::new(5200, "Invalid bot deletion journal"))?
        {
            let id = required(target, "id")?;
            targets.insert(id.to_owned());
            targets.extend(runtime_store::descendants(home, id)?);
            // A pending section purge captured these links before native
            // cleanup could remove them. The unresolved bot journal owns all.
            for row in rows(
                &runtime_store::open(home)?,
                "SELECT session_id FROM native_delete_pending WHERE root_id=?",
                &[&id],
            )? {
                targets.insert(required(&row, "session_id")?.to_owned());
            }
        }
    }
    Ok(targets)
}

fn delete_bot(home: &Path, caller: &str, name: &str) -> Result<Value> {
    // Persist retirement provenance before touching the separate native store.
    let targets = retire_bot_delete(home, caller, name)?;
    let committed = runtime_store::with_tombstone(home, || {
        let mut conn = db::open(home)?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let journal = bot_delete_journal(&tx, name)?;
        if !journal.as_ref().is_some_and(|journal| {
            journal["committed"] == false && journal["targets"].as_array() == Some(&targets)
        }) {
            return Err(Error::new(
                4208,
                format!("bot deletion changed: {name}; retry"),
            ));
        }
        bot_owner(home, caller, name)?;
        tx.execute("DELETE FROM sections WHERE bot=?", [name])?;
        // Threads where this bot asked others stay with their recipients.
        tx.execute("UPDATE sections SET archived_at=? WHERE peer_bot=? AND owner_id=? AND archived_at IS NULL", params![now(), name, caller])?;
        tx.execute("DELETE FROM dreams WHERE bot=?", [name])?;
        tx.execute("DELETE FROM memory_proposals WHERE bot=?", [name])?;
        tx.execute("UPDATE room_members SET left_at=? WHERE member_kind='bot' AND member_id=? AND left_at IS NULL", params![now(), name])?;
        tx.execute("UPDATE rooms SET main_bot=NULL WHERE main_bot=?", [name])?;
        tx.execute("DELETE FROM room_sessions WHERE bot=?", [name])?;
        tx.execute("DELETE FROM bot_incidents WHERE bot=?", [name])?;
        tx.execute("DELETE FROM bots WHERE name=?", [name])?;
        tx.execute(
            "UPDATE settings SET value=json_set(value,'$.committed',json('true')) WHERE key=?",
            [format!("{BOT_DELETE_PREFIX}{name}")],
        )?;
        tx.commit()?;
        Ok::<_, Error>(())
    });
    if let Err(error) = committed {
        runtime_store::with_tombstone(home, || {
            let mut conn = db::open(home)?;
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            rollback_bot_delete_in(home, name, &tx, Some(&targets), false)?;
            tx.commit()?;
            Ok(())
        })?;
        return Err(error);
    }
    if let Err(error) = finish_bot_delete(home, name) {
        eprintln!("Deleted bot {name}, but cleanup is pending: {error}");
        return Ok(json!({"deleted":true,"history_pending":true}));
    }
    Ok(json!({"deleted":true}))
}

pub fn call(home: &Path, caller: &str, method: &str, p: &Value) -> Option<Result<Value>> {
    if matches!(
        method,
        "profiles.describe" | "profiles.configure" | "profiles.get_asset" | "profiles.set_asset"
    ) {
        return Some(profile_call(home, caller, method, p));
    }
    if !method.starts_with("hexbot.bots.") && !method.starts_with("hexbot.sections.") {
        return None;
    }
    if matches!(method, "hexbot.sections.open" | "hexbot.bots.introduce") {
        return None;
    }
    Some((|| match method {
        "hexbot.bots.create" => create_bot(home, caller, p),
        "hexbot.bots.create_primary" => create_primary(home, caller, p),
        "hexbot.bots.set_primary" => set_primary(home, caller, required(p, "name")?),
        "hexbot.bots.update" => update_bot(home, caller, p),
        "hexbot.bots.get" => {
            Ok(json!({"bot":shape_bot(home,caller,bot_row(home,caller,required(p,"name")?)?)?}))
        }
        "hexbot.bots.list" => {
            user(home, caller)?;
            let bots = rows(
                &db::open(home)?,
                "SELECT * FROM bots WHERE owner_id=? ORDER BY is_primary DESC,last_activity_at DESC,name ASC",
                &[&caller],
            )?
            .into_iter()
            .map(|r| shape_bot(home, caller, r))
            .collect::<Result<Vec<_>>>()?;
            Ok(json!({"bots":bots}))
        }
        "hexbot.bots.clear_status" => {
            let name = required(p, "name")?;
            bot_owner(home, caller, name)?;
            db::open(home)?.execute(
                "UPDATE bot_incidents SET resolved_at=? WHERE bot=? AND resolved_at IS NULL",
                params![now(), name],
            )?;
            Ok(json!({"bot":bot(home,caller,name)?}))
        }
        "hexbot.bots.delete" => delete_bot(home, caller, required(p, "name")?),
        "hexbot.sections.thread" => {
            let bot = required(p, "bot")?;
            let peer = required(p, "peer")?;
            bot_owner(home, caller, bot)?;
            let row = rows(&db::open(home)?, "SELECT * FROM sections WHERE bot=? AND owner_id=? AND peer_bot=? AND archived_at IS NULL ORDER BY created_at LIMIT 1", &[&bot, &caller, &peer])?.into_iter().next();
            Ok(json!({"section":row.map(|r| shape_section(home,r)).transpose()?}))
        }
        "hexbot.sections.list" => Ok(json!({"sections":list_sections(home,caller,p)?})),
        // Opens the bot's chat; there is only ever one, so a title is ignored.
        "hexbot.sections.create" => {
            Ok(json!({"section":chat_section(home,caller,required(p,"bot")?)?}))
        }
        "hexbot.sections.delete" => {
            let id = required(p, "id")?;
            check_section_delete(home, caller, id)?;
            let pending = delete_section(
                home,
                caller,
                id,
                p["purge_memory"].as_bool().unwrap_or(true),
            )?;
            Ok(if pending.is_some() {
                json!({"deleted":true,"history_pending":true})
            } else {
                json!({"deleted":true})
            })
        }
        "hexbot.sections.close" => {
            let id = required(p, "id")?;
            let row = section_row(home, caller, id)?;
            db::open(home)?.execute(
                "UPDATE sections SET last_live_session_id=NULL WHERE id=?",
                [id],
            )?;
            Ok(json!({"closed":!row["last_live_session_id"].is_null()}))
        }
        "hexbot.sections.rename"
        | "hexbot.sections.archive"
        | "hexbot.sections.unarchive"
        | "hexbot.sections.touch"
        | "hexbot.sections.mark_read" => {
            let id = required(p, "id")?;
            let row = section_row(home, caller, id)?;
            let now = now();
            let mut conn = db::open(home)?;
            let tx = conn.transaction()?;
            match method {
                "hexbot.sections.rename" => {
                    let title = required(p, "title")?.trim();
                    if title.is_empty() {
                        return Err(Error::new(4200, "missing parameter: title"));
                    }
                    tx.execute(
                        "UPDATE sections SET title=?,title_by=NULL,updated_at=?,title_dirty=1 WHERE id=?",
                        params![title, now, id],
                    )?;
                }
                "hexbot.sections.archive" => {
                    tx.execute(
                        "UPDATE sections SET archived_at=?,updated_at=? WHERE id=?",
                        params![now, now, id],
                    )?;
                }
                "hexbot.sections.unarchive" => {
                    tx.execute(
                        "UPDATE sections SET archived_at=NULL,updated_at=? WHERE id=?",
                        params![now, id],
                    )?;
                }
                "hexbot.sections.touch" => {
                    tx.execute(
                        "UPDATE sections SET updated_at=?,done_at=? WHERE id=?",
                        params![now, now, id],
                    )?;
                }
                _ => {
                    tx.execute("UPDATE sections SET done_at=NULL WHERE id=?", [id])?;
                }
            }
            if method != "hexbot.sections.mark_read" {
                tx.execute(
                    "UPDATE bots SET last_activity_at=? WHERE name=?",
                    params![now, row["bot"].as_str()],
                )?;
            }
            tx.commit()?;
            Ok(json!({"section":section(home,caller,id)?}))
        }
        _ => Err(Error::new(-32601, "method not found")),
    })())
}

fn public_model(model: &Value) -> Value {
    json!({"provider":model["provider"],"default":model.as_str().map(Value::from).unwrap_or_else(||model["default"].clone())})
}

fn creation_config(mut config: Value) -> Value {
    if config["model"].is_object() {
        config["model"] = public_model(&config["model"]);
    }
    if let Some(object) = config.as_object_mut() {
        object.remove("custom_providers");
        // Global skill revocations stay global; new bots inherit new grants live.
        object.remove("skills");
    }
    if let Some(servers) = config["mcp_servers"].as_object_mut() {
        for server in servers.values_mut() {
            if let Some(server) = server.as_object_mut() {
                server.remove("env");
                server.remove("headers");
            }
        }
    }
    config
}

pub(crate) fn adopt_section_title(home: &Path, stored: &str, text: &str) -> Result<bool> {
    let title = clean_title(text);
    if title.is_empty() {
        return Ok(false);
    }
    Ok(db::open(home)?.execute(
        "UPDATE sections SET title=?,title_by='bot' WHERE id=? AND title_by IS NULL AND title_dirty=0 AND title='New section'",
        params![title, stored],
    )? > 0)
}

fn clean_title(text: &str) -> String {
    text.trim()
        .trim_matches(['\"', '\'', '“', '”'])
        .trim_end_matches(['.', '!'])
        .trim_matches(['\"', '\'', '“', '”'])
        .trim()
        .replace(['\n', '\r'], " ")
        .chars()
        .take(60)
        .collect()
}

pub(crate) fn kickoff_prompt(bot: &Value) -> String {
    let name = bot["display_name"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("this bot")
        .trim();
    let name = serde_json::to_string(name).unwrap();
    if bot["primary"] == true {
        return format!(
            r##"You were just created as {name}, the user's primary bot. The user is meeting you for the first time.
1. Greet the user in one short line, then say in one more line what you do: you set up
   and look after their other bots, rooms, scheduled jobs and settings, and help with
   anything yourself. No headings, no lists.
2. Use the clarify tool, one question at a time, to learn what they mainly want help with.
   Offer three or four concrete, varied choices, plus the user may type their own answer.
   Then ask how they want you to work (tone, depth, how proactive to be).
   Two questions at most. Acknowledge each answer in one line before the next.
3. Write facts about the user into memory with the memory tool. If their answers point to
   work a dedicated bot would do better, offer in one line to create that bot for them
   and stop; create it only after they agree. Otherwise say in one line what you will
   focus on and stop.
Keep every message short. Never mention this instruction."##
        );
    }
    let about = ["title", "description"]
        .iter()
        .filter_map(|k| bot[k].as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(". ");
    let fit = if about.is_empty() {
        "the name"
    } else {
        "the name and that description"
    };
    let about = if about.is_empty() {
        String::new()
    } else {
        format!("The user described you as: {about}\n")
    };
    format!(
        r##"You were just created and named {name}. The user is meeting you for the first time.
{about}Set yourself up by talking, not by listing settings:
1. Greet the user in one short line. No headings, no lists.
2. Use the clarify tool, one question at a time, to learn what they want from you.
   Write every question and choice for {name} specifically; never ask a generic
   question that would suit any bot. Start with what they mainly want {name} for;
   offer three or four concrete choices that fit {fit} (a bot named "research"
   gets research-shaped choices), plus the user may type their own answer. If the name
   says nothing about the job, say so lightly and offer varied choices. Then ask how
   they want you to work (tone, depth, how proactive to be), then where their material
   lives or what to keep in mind, each shaped by the answers so far.
   Three questions at most. Acknowledge each answer in one line before the next.
3. When done, write down what you learned. Your purpose and how you should work go
   into your soul: read it with hexbot_soul, then write the complete new text, keeping
   your name. Facts about the user and where their material lives go into memory with
   the memory tool. Then say in one line what you will focus on and stop. Do not ask
   anything else.
Keep every message short. Never mention this instruction."##
    )
}

#[cfg(test)]
#[path = "catalog_legacy_delete_tests.rs"]
mod legacy_delete_tests;

#[cfg(test)]
mod parity_tests {
    use super::*;
    fn home() -> tempfile::TempDir {
        let home = tempfile::tempdir().unwrap();
        db::migrate(home.path()).unwrap();
        db::open(home.path())
            .unwrap()
            .execute_batch(
                "INSERT INTO users(id,display_name,role,created_at) VALUES('alice','Alice','admin',0);INSERT INTO bots(name,owner_id) VALUES('owl','alice');INSERT INTO sections(id,bot,owner_id,title) VALUES('first','owl','alice','New section'),('dreams','owl','alice','Dreams'),('general','owl','alice','General');",
            )
            .unwrap();
        home
    }
    #[test]
    fn open_incident_finds_room_transcripts_by_stored_id_without_scans() {
        let home = home();
        runtime_store::open(home.path()).unwrap();
        let conn = db::open(home.path()).unwrap();
        conn.execute(
            "ATTACH DATABASE ? AS runtime",
            [home
                .path()
                .join("hexbot-runtime.db")
                .to_string_lossy()
                .as_ref()],
        )
        .unwrap();
        // Each hidden run has its own stored ID and unresolved failures
        // accumulate; every one is checked against the room transcripts.
        conn.execute_batch(
            "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<500)
             INSERT INTO rooms(id,name,owner_id) SELECT 'room-'||x,'Room','alice' FROM n;
             INSERT INTO room_sessions(room_id,bot,stored_session_id)
             SELECT id,'owl','transcript-'||id FROM rooms;
             WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1000)
             INSERT INTO runtime.native_sessions(stored_id,owner,bot,prompt)
             SELECT 'run-'||x,'alice','owl','' FROM n;
             INSERT INTO bot_incidents(id,bot,section_id,kind,created_at)
             SELECT 'failure-'||substr(stored_id,5),'owl',stored_id,'turn_failed',
              CAST(substr(stored_id,5) AS REAL) FROM runtime.native_sessions;
             INSERT INTO runtime.native_deleted(session_id) VALUES('run-1000');",
        )
        .unwrap();
        let plan = conn
            .prepare(&format!("EXPLAIN QUERY PLAN {OPEN_INCIDENT}"))
            .unwrap()
            .query_map(["owl"], |row| row.get::<_, String>(3))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert!(
            !plan.iter().any(|step| step.starts_with("SCAN")),
            "{plan:#?}"
        );
        assert_eq!(
            plan.iter()
                .filter(|step| step.contains("idx_room_sessions_stored"))
                .count(),
            2,
            "{plan:#?}"
        );
        let mut query = conn.prepare(OPEN_INCIDENT).unwrap();
        let id: String = query.query_row(["owl"], |row| row.get("id")).unwrap();
        assert_eq!(id, "failure-999");
        assert_eq!(query.get_status(rusqlite::StatementStatus::FullscanStep), 0);
    }

    #[test]
    fn runtime_backup_includes_pending_legacy_cleanup_and_its_exact_keys() {
        let home = home();
        let h = home.path();
        said(h, "first", json!({"role":"user","text":"original"}));
        let dir = profile(h, "owl").unwrap();
        fs::create_dir_all(&dir).unwrap();
        Connection::open(dir.join("state.db")).unwrap().execute_batch("CREATE TABLE sessions(id TEXT PRIMARY KEY,session_key TEXT); CREATE TABLE messages(id INTEGER,session_id TEXT,role TEXT,content TEXT); INSERT INTO sessions VALUES('legacy','first'); INSERT INTO messages VALUES(1,'legacy','user','original'); CREATE TRIGGER stuck BEFORE DELETE ON messages BEGIN SELECT RAISE(ABORT,'legacy failure'); END;").unwrap();
        assert!(delete_section(h, "alice", "first", true).unwrap().is_some());
        let backup = back_up(h, &BTreeSet::from(["owl"])).unwrap();
        let copied = Connection::open(backup.join("hexbot-runtime.db")).unwrap();
        let request:(String,String,bool,String) = copied.query_row("SELECT bot,owner,purge,root_id FROM native_delete_options JOIN native_delete_pending USING(session_id) WHERE session_id='first'",[],|r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).unwrap();
        assert_eq!(
            request,
            ("owl".into(), "alice".into(), true, "first".into())
        );
        let key: String = copied
            .query_row(
                "SELECT legacy_id FROM native_delete_legacy WHERE legacy_id='legacy'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(key, "legacy");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn peer_thread_delete_crash_at_the_real_catalog_commit_recovers_the_decision() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        const CHILD: &str = "HEXBOT_TEST_SECTION_DELETE_CRASH_HOME";
        if let Some(path) = std::env::var_os(CHILD) {
            call(
                Path::new(&path),
                "alice",
                "hexbot.sections.delete",
                &json!({"id":"first"}),
            )
            .unwrap()
            .unwrap();
            return;
        }
        for cut in ["before_commit", "after_commit"] {
            let home = home();
            let h = home.path();
            db::open(h).unwrap().execute_batch("INSERT INTO bots(name,owner_id) VALUES('teammate','alice'); UPDATE sections SET peer_bot='teammate' WHERE id='first';").unwrap();
            said(h, "first", json!({"role":"user","text":"original"}));
            let raw = h.join("runtime/sessions/first/conversation.jsonl");
            fs::create_dir_all(raw.parent().unwrap()).unwrap();
            fs::write(&raw, "original Pi bytes").unwrap();
            let dir = profile(h, "owl").unwrap();
            fs::create_dir_all(&dir).unwrap();
            let legacy = Connection::open(dir.join("state.db")).unwrap();
            legacy.execute_batch("CREATE TABLE sessions(id TEXT PRIMARY KEY,session_key TEXT); CREATE TABLE messages(id INTEGER,session_id TEXT,role TEXT,content TEXT); INSERT INTO sessions VALUES('legacy','first'); INSERT INTO messages VALUES(1,'legacy','user','old human history');").unwrap();
            let socket = h.join("delete-barrier.sock");
            let listener = tokio::net::UnixListener::bind(&socket).unwrap();
            let mut child = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact","catalog::parity_tests::peer_thread_delete_crash_at_the_real_catalog_commit_recovers_the_decision","--nocapture"])
                .env(CHILD,h).spawn().unwrap();
            loop {
                let (mut stream, _) =
                    tokio::time::timeout(std::time::Duration::from_secs(10), listener.accept())
                        .await
                        .unwrap()
                        .unwrap();
                let mut phase = [0; 32];
                let n = stream.read(&mut phase).await.unwrap();
                if &phase[..n] == cut.as_bytes() {
                    break;
                }
                stream.write_all(&[1]).await.unwrap();
            }
            // Kill the actual process at the event boundary, without allowing
            // any cleanup/error path to run or manufacturing a committed flag.
            child.kill().unwrap();
            child.wait().unwrap();
            fs::remove_file(socket).unwrap();
            assert!(raw.is_file());
            assert_eq!(
                runtime_store::history(h, "first").unwrap()[0]["text"],
                "original"
            );
            assert_eq!(
                legacy
                    .query_row("SELECT count(*) FROM messages", [], |r| r.get::<_, i64>(0))
                    .unwrap(),
                1
            );
            runtime_store::finish_deletes(h).unwrap();
            runtime_store::finish_deletes(h).unwrap();
            let committed = cut == "after_commit";
            assert_eq!(section(h, "alice", "first").is_err(), committed);
            assert_eq!(raw.is_file(), !committed);
            assert_eq!(
                runtime_store::history(h, "first").unwrap().is_empty(),
                committed
            );
            assert_eq!(
                legacy
                    .query_row("SELECT count(*) FROM messages", [], |r| r.get::<_, i64>(0))
                    .unwrap(),
                i64::from(!committed)
            );
            assert_eq!(runtime_store::session_dir(h, "first").is_err(), committed);
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn late_failed_peer_parent_rollback_preserves_an_independently_committed_child() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        const CHILD: &str = "HEXBOT_TEST_LATE_SECTION_ROLLBACK_HOME";
        if let Some(path) = std::env::var_os(CHILD) {
            assert!(
                call(
                    Path::new(&path),
                    "alice",
                    "hexbot.sections.delete",
                    &json!({"id":"first"})
                )
                .unwrap()
                .is_err()
            );
            return;
        }
        let home = home();
        let h = home.path();
        db::open(h).unwrap().execute_batch("INSERT INTO bots(name,owner_id) VALUES('teammate','alice'); UPDATE sections SET peer_bot='teammate' WHERE id='first';").unwrap();
        db::open(h).unwrap().execute_batch("INSERT INTO sections(id,bot,owner_id,title) VALUES('delegate','owl','alice','child'); CREATE TRIGGER stop_parent BEFORE DELETE ON sections WHEN OLD.id='first' BEGIN SELECT RAISE(ABORT,'parent failed'); END;").unwrap();
        said(h, "first", json!({"role":"user","text":"original parent"}));
        said(
            h,
            "delegate",
            json!({"role":"user","text":"original child"}),
        );
        runtime_store::open(h)
            .unwrap()
            .execute(
                "UPDATE native_sessions SET options=? WHERE stored_id='delegate'",
                [json!({"parent_session":"first"}).to_string()],
            )
            .unwrap();
        let dir = profile(h, "owl").unwrap();
        fs::create_dir_all(&dir).unwrap();
        let legacy = Connection::open(dir.join("state.db")).unwrap();
        legacy.execute_batch("CREATE TABLE sessions(id TEXT PRIMARY KEY,session_key TEXT); CREATE TABLE messages(id INTEGER,session_id TEXT,role TEXT,content TEXT); INSERT INTO sessions VALUES('legacy-parent','first'),('legacy-child','delegate'); INSERT INTO messages VALUES(1,'legacy-parent','user','parent'),(2,'legacy-child','user','child');").unwrap();
        let socket = h.join("delete-barrier.sock");
        let listener = tokio::net::UnixListener::bind(&socket).unwrap();
        let mut child=std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact","catalog::parity_tests::late_failed_peer_parent_rollback_preserves_an_independently_committed_child","--nocapture"])
            .env(CHILD,h).spawn().unwrap();
        let (mut stream, _) =
            tokio::time::timeout(std::time::Duration::from_secs(10), listener.accept())
                .await
                .unwrap()
                .unwrap();
        let mut phase = [0; 32];
        let n = stream.read(&mut phase).await.unwrap();
        assert_eq!(&phase[..n], b"after_failed_catalog");
        fs::remove_file(socket).unwrap();
        // Actual independent catalog COMMIT and full purge while the failed
        // parent's rollback is paused outside its catalog transaction.
        assert!(
            delete_section(h, "alice", "delegate", true)
                .unwrap()
                .is_none()
        );
        assert!(runtime_store::history(h, "delegate").unwrap().is_empty());
        assert_eq!(
            legacy
                .query_row(
                    "SELECT count(*) FROM messages WHERE session_id='legacy-child'",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
        stream.write_all(&[1]).await.unwrap();
        assert!(child.wait().unwrap().success());
        runtime_store::finish_deletes(h).unwrap();
        assert!(runtime_store::session_dir(h, "delegate").is_err());
        assert!(
            runtime_store::append(h, "delegate", json!({"role":"user","text":"late"})).is_err()
        );
        assert!(runtime_store::session_dir(h, "first").is_ok());
        assert_eq!(
            runtime_store::history(h, "first").unwrap()[0]["text"],
            "original parent"
        );
        assert_eq!(
            legacy
                .query_row(
                    "SELECT count(*) FROM messages WHERE session_id='legacy-parent'",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
    }

    #[test]
    fn model_and_new_bot_config_do_not_copy_secrets() {
        let config = json!({
            "model": {
                "provider": "custom",
                "default": "chat",
                "api_key": "SECRET",
                "base_url": "https://secret"
            },
            "custom_providers": [{ "api_key": "SECRET" }],
            "mcp_servers": {
                "local": {
                    "command": "tool",
                    "env": { "KEY": "SECRET" },
                    "headers": { "Authorization": "SECRET" }
                }
            }
        });
        assert_eq!(
            public_model(&config["model"]),
            json!({"provider":"custom","default":"chat"})
        );
        let copy = creation_config(config);
        assert!(!copy.to_string().contains("SECRET"));
        assert_eq!(copy["mcp_servers"]["local"]["command"], "tool");
        assert_eq!(
            public_model(&json!("standalone")),
            json!({"provider":null,"default":"standalone"})
        );
    }
    #[test]
    fn naming_tracks_bot_and_user_and_previews_the_latest_message() {
        let home = home();
        assert!(adopt_section_title(home.path(), "first", "Plan the garden.").unwrap());
        assert_eq!(
            section(home.path(), "alice", "first").unwrap()["title_by"],
            "bot"
        );
        assert!(!adopt_section_title(home.path(), "first", "Another message").unwrap());
        // The General section created with each bot keeps its name.
        assert!(!adopt_section_title(home.path(), "general", "Fix my arm64 build").unwrap());
        assert!(!adopt_section_title(home.path(), "dreams", "Rename the dreams").unwrap());
        call(
            home.path(),
            "alice",
            "hexbot.sections.rename",
            &json!({"id":"first","title":"My title"}),
        )
        .unwrap()
        .unwrap();
        assert!(section(home.path(), "alice", "first").unwrap()["title_by"].is_null());
        assert!(!adopt_section_title(home.path(), "first", "Overwrite user title").unwrap());
        assert_eq!(clean_title(&"x".repeat(100)).len(), 60);
        runtime_store::open(home.path()).unwrap().execute("INSERT INTO native_sessions(stored_id,owner,bot,prompt) VALUES('first','alice','owl','')",[]).unwrap();
        for (seq, message) in [
            json!({"role":"user","text":"Earlier"}),
            json!({"role":"assistant","text":format!("{}\nend","a".repeat(61))}),
            json!({"role":"user","text":"Hidden follow-up","display_kind":"hidden"}),
        ]
        .iter()
        .enumerate()
        {
            runtime_store::open(home.path())
                .unwrap()
                .execute(
                    "INSERT INTO native_messages VALUES('first',?,?)",
                    params![seq, message.to_string()],
                )
                .unwrap();
        }
        assert_eq!(
            section(home.path(), "alice", "first").unwrap()["preview"],
            format!("{}...", "a".repeat(60))
        );
    }
    fn said(home: &Path, id: &str, message: Value) {
        let section = db::open(home)
            .unwrap()
            .query_row("SELECT owner_id,bot FROM sections WHERE id=?", [id], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })
            .optional()
            .unwrap()
            .unwrap_or_else(|| ("alice".into(), "owl".into()));
        runtime_store::open(home)
            .unwrap()
            .execute(
                "INSERT OR IGNORE INTO native_sessions(stored_id,owner,bot,prompt) VALUES(?,?,?,'')",
                params![id,section.0,section.1],
            )
            .unwrap();
        runtime_store::append(home, id, message).unwrap();
    }
    #[test]
    fn each_bot_keeps_one_chat_with_its_latest_conversation() {
        let home = tempfile::tempdir().unwrap();
        db::migrate(home.path()).unwrap();
        db::open(home.path())
            .unwrap()
            .execute_batch(
                "INSERT INTO users(id,display_name,role,created_at) VALUES('alice','Alice','admin',0);
                 INSERT INTO bots(name,owner_id,last_activity_at) VALUES('owl','alice',7),('fox','alice',NULL),('ant','alice',NULL),('bee','alice',NULL),('cat','alice',NULL);
                 INSERT INTO sections(id,bot,owner_id,title,title_dirty) VALUES('bee_dreams','bee','alice','Dreams',0),('cat_chat','cat','alice','Dreams',1);
                 INSERT INTO bot_incidents(id,bot,section_id,kind,created_at) VALUES('failed','owl','put_away','turn_failed',1);
                 INSERT INTO dreams(id,bot,started_at,status,summary) VALUES('d1','fox',1,'complete','In fox_dreams'),('owl_report','owl',1,'complete','In owl_dreams'),('bee_report','bee',1,'complete','Last night I learned');
                 INSERT INTO sections(id,bot,owner_id,title,title_by) VALUES('dog_chat','dog','alice','Dreams','bot');
                 INSERT INTO sections(id,bot,owner_id,title,updated_at) VALUES('kit_named','kit','alice','Dreams',9),('kit_old','kit','alice','Old',2);
                 INSERT INTO bots(name,owner_id) VALUES('dog','alice'),('elk','alice'),('fly','alice'),('gnu','alice'),('hen','alice'),('ivy','alice'),('jay','alice'),('kit','alice'),('lynx','alice'),('mole','alice');
                 INSERT INTO sections(id,bot,owner_id,title,updated_at) VALUES('mole_native','mole','alice','Native',3),('mole_legacy','mole','alice','Legacy',1);
                 INSERT INTO bots(name,owner_id) VALUES('nan','alice'),('yak','alice');
                 INSERT INTO sections(id,bot,owner_id,title,updated_at,archived_at) VALUES('nan_trip','nan','alice','Trip',5,5),('nan_dreams','nan','alice','Dreams',10,NULL);
                 INSERT INTO dreams(id,bot,started_at,status,summary) VALUES('d6','nan',1,'complete','Nan learned');
                 INSERT INTO sections(id,bot,owner_id,title,updated_at) VALUES('yak_new','yak','alice','New',9),('yak_old','yak','alice','Old',2);
                 INSERT INTO sections(id,bot,owner_id,title,updated_at) VALUES('lynx_damaged','lynx','alice','Damaged',9),('lynx_healthy','lynx','alice','Healthy',2);
                 INSERT INTO sections(id,bot,owner_id,title,title_dirty,updated_at) VALUES('jay_log','jay','alice','Nightly',1,9),('jay_chat','jay','alice','Plans',0,2);
                 INSERT INTO sections(id,bot,owner_id,title,updated_at) VALUES('ivy_chat','ivy','alice','General',9),('ivy_old','ivy','alice','Old',2);
                 INSERT INTO sections(id,bot,owner_id,title,title_dirty,updated_at) VALUES('gnu_log','gnu','alice','Nightly',1,9),('gnu_chat','gnu','alice','Plans',0,2),('hen_log','hen','alice','Nightly',1,9);
                 INSERT INTO dreams(id,bot,started_at,status,summary) VALUES('d2','gnu',1,'complete','Gnu learned'),('d3','hen',1,'complete','Hen learned'),('d4','ivy',1,'complete','Ivy learned'),('d5','jay',1,'complete','Jay learned');
                 INSERT INTO sections(id,bot,owner_id,title,updated_at) VALUES('fly_native','fly','alice','Native',5),('fly_legacy','fly','alice','Legacy',9);
                 INSERT INTO sections(id,bot,owner_id,title,updated_at) VALUES('elk_listed','elk','alice','Listed',5),('elk_recovered','elk','alice','Recovered',1);
                 INSERT INTO sections(id,bot,owner_id,title,updated_at,archived_at,peer_bot) VALUES
                  ('old','owl','alice','Garden',1,NULL,NULL),
                  ('put_away','owl','alice','Trip',5,5,NULL),
                  ('empty','owl','alice','New section',9,NULL,NULL),
                  ('owl_dreams','owl','alice','Dreams',10,NULL,NULL),
                  ('thread','owl','alice','From Fox',11,NULL,'fox'),
                  ('fox_dreams','fox','alice','Dreams',3,NULL,NULL),
                  ('fox_empty','fox','alice','New section',4,NULL,NULL);",
            )
            .unwrap();
        for (id, time) in [
            ("old", 1),
            ("put_away", 5),
            ("owl_dreams", 10),
            ("fox_dreams", 3),
        ] {
            said(
                home.path(),
                id,
                json!({"role":"assistant","text":format!("In {id}"),"timestamp":time}),
            );
        }
        said(home.path(), "thread", json!({"role":"user","text":"Help"}));
        // The user answered a report in the log; that stays conversation.
        said(
            home.path(),
            "fox_dreams",
            json!({"role":"user","text":"Why?"}),
        );
        said(
            home.path(),
            "fox_dreams",
            json!({"role":"assistant","text":"Because"}),
        );
        said(
            home.path(),
            "dog_chat",
            json!({"role":"user","text":"Dreams"}),
        );
        // Recovered after a crash: newer than its section's time says.
        said(
            home.path(),
            "elk_listed",
            json!({"role":"user","text":"Earlier","timestamp":4}),
        );
        said(
            home.path(),
            "elk_recovered",
            json!({"role":"user","text":"Later","timestamp":9}),
        );
        // Fly's newest conversation was opened once before a crash, so its
        // messages are still only in the old store.
        said(
            home.path(),
            "fly_native",
            json!({"role":"user","text":"Older","timestamp":4}),
        );
        let fly = home.path().join("profiles/fly");
        fs::create_dir_all(&fly).unwrap();
        Connection::open(fly.join("state.db"))
            .unwrap()
            .execute_batch(
                "CREATE TABLE sessions(id TEXT,session_key TEXT,parent_session_id TEXT,model_config TEXT,source TEXT);
                 CREATE TABLE messages(id INTEGER,session_id TEXT,role TEXT,content TEXT,timestamp REAL);
                 INSERT INTO sessions(id,session_key) VALUES('fly_legacy','fly_legacy');
                 INSERT INTO messages VALUES(1,'fly_legacy','user','Newer',8);",
            )
            .unwrap();
        runtime_store::open(home.path())
            .unwrap()
            .execute(
                "INSERT INTO native_sessions(stored_id,owner,bot,prompt) VALUES('fly_legacy','alice','fly','')",
                [],
            )
            .unwrap();
        // Logs the user renamed, still opening with a report.
        said(
            home.path(),
            "gnu_log",
            json!({"role":"assistant","text":"Gnu learned","timestamp":8}),
        );
        said(
            home.path(),
            "gnu_chat",
            json!({"role":"user","text":"Plans","timestamp":1}),
        );
        said(
            home.path(),
            "hen_log",
            json!({"role":"assistant","text":"Hen learned","timestamp":8}),
        );
        // Ivy's chat began with a report this build posted, then an older
        // build left another section behind.
        said(
            home.path(),
            "ivy_chat",
            json!({"role":"assistant","text":"Ivy learned","dream":true,"timestamp":8}),
        );
        said(
            home.path(),
            "ivy_old",
            json!({"role":"user","text":"Old","timestamp":1}),
        );
        // Mole's newest message is in a conversation never opened since the
        // native daemon, whose section time was never advanced.
        said(
            home.path(),
            "mole_native",
            json!({"role":"user","text":"Older","timestamp":4}),
        );
        let mole = home.path().join("profiles/mole");
        fs::create_dir_all(&mole).unwrap();
        Connection::open(mole.join("state.db"))
            .unwrap()
            .execute_batch(
                "CREATE TABLE sessions(id TEXT,session_key TEXT,parent_session_id TEXT,model_config TEXT,source TEXT);
                 CREATE TABLE messages(id INTEGER,session_id TEXT,role TEXT,content TEXT,timestamp REAL);
                 INSERT INTO sessions(id,session_key) VALUES('mole_legacy','mole_legacy');
                 INSERT INTO messages VALUES(1,'mole_legacy','user','Newer',8);",
            )
            .unwrap();
        // Nan put a real conversation away; its Dreams log is still out.
        said(
            home.path(),
            "nan_trip",
            json!({"role":"user","text":"Plan the trip","timestamp":5}),
        );
        said(
            home.path(),
            "nan_dreams",
            json!({"role":"assistant","text":"Nan learned","timestamp":10}),
        );
        // Yak's older conversation could not be read when the upgrade ran.
        said(
            home.path(),
            "yak_new",
            json!({"role":"user","text":"Newer","timestamp":9}),
        );
        said(
            home.path(),
            "yak_old",
            json!({"role":"user","text":"Older","timestamp":2}),
        );
        fs::create_dir_all(
            home.path()
                .join("runtime/sessions/yak_old/conversation.jsonl"),
        )
        .unwrap();
        // A file of a conversation the upgrade deletes.
        let upload = home.path().join("runtime/sessions/put_away/attachments");
        fs::create_dir_all(&upload).unwrap();
        fs::write(upload.join("ticket.txt"), "seat 12").unwrap();
        // Recovery set Lynx's newest conversation aside.
        said(
            home.path(),
            "lynx_damaged",
            json!({"role":"user","text":"Newer","timestamp":8}),
        );
        said(
            home.path(),
            "lynx_healthy",
            json!({"role":"user","text":"Older","timestamp":1}),
        );
        runtime_store::open(home.path())
            .unwrap()
            .execute(
                "INSERT INTO native_quarantine(session_id,error) VALUES('lynx_damaged','damaged')",
                [],
            )
            .unwrap();
        // Kit's newest chat was created with the title Dreams, by the user.
        said(
            home.path(),
            "kit_named",
            json!({"role":"user","text":"About my dreams","timestamp":8}),
        );
        said(
            home.path(),
            "kit_old",
            json!({"role":"user","text":"Old","timestamp":1}),
        );
        said(
            home.path(),
            "jay_chat",
            json!({"role":"user","text":"Plans","timestamp":1}),
        );
        let jay = home.path().join("profiles/jay");
        fs::create_dir_all(&jay).unwrap();
        Connection::open(jay.join("state.db"))
            .unwrap()
            .execute_batch(
                "CREATE TABLE sessions(id TEXT,session_key TEXT,parent_session_id TEXT,model_config TEXT,source TEXT);
                 CREATE TABLE messages(id INTEGER,session_id TEXT,role TEXT,content TEXT,timestamp REAL);
                 INSERT INTO sessions(id,session_key) VALUES('jay_log','jay_log');
                 INSERT INTO messages VALUES(1,'jay_log','assistant','Jay learned',8);",
            )
            .unwrap();
        // Opened once, but its old history was never copied in.
        runtime_store::open(home.path())
            .unwrap()
            .execute(
                "INSERT INTO native_sessions(stored_id,owner,bot,prompt) VALUES('bee_dreams','alice','bee','')",
                [],
            )
            .unwrap();
        said(
            home.path(),
            "cat_chat",
            json!({"role":"user","text":"About my dreams"}),
        );
        // Bee's dream log is known only from before the native daemon.
        let bee = home.path().join("profiles/bee");
        fs::create_dir_all(&bee).unwrap();
        Connection::open(bee.join("state.db"))
            .unwrap()
            .execute_batch(
                "CREATE TABLE sessions(id TEXT,session_key TEXT,parent_session_id TEXT,model_config TEXT,source TEXT);
                 CREATE TABLE messages(id INTEGER,session_id TEXT,role TEXT,content TEXT,timestamp REAL);
                 INSERT INTO sessions(id,session_key) VALUES('bee_dreams','bee_dreams');
                 INSERT INTO messages VALUES(1,'bee_dreams','assistant','Last night I learned',1);",
            )
            .unwrap();
        one_chat_per_bot(home.path()).unwrap();
        // Everything it deleted from was copied first.
        let backups = fs::read_dir(home.path().join("backups"))
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect::<Vec<_>>();
        assert_eq!(backups.len(), 1);
        let backup = &backups[0];
        assert!(
            backup
                .file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .starts_with("one-chat-per-bot-")
        );
        assert_eq!(
            fs::read_to_string(backup.join("runtime/sessions/put_away/attachments/ticket.txt"))
                .unwrap(),
            "seat 12"
        );
        let copied: String = Connection::open(backup.join("hexbot.db"))
            .unwrap()
            .query_row("SELECT title FROM sections WHERE id='put_away'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(copied, "Trip");
        let copied: i64 = Connection::open(backup.join("hexbot-runtime.db"))
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM native_messages WHERE session_id='put_away'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(copied, 1);
        let copied: String = Connection::open(backup.join("profiles/fly/state.db"))
            .unwrap()
            .query_row("SELECT content FROM messages", [], |r| r.get(0))
            .unwrap();
        assert_eq!(copied, "Newer");
        // Lynx keeps both until its conversation is repaired.
        let lynx: i64 = db::open(home.path())
            .unwrap()
            .query_row("SELECT COUNT(*) FROM sections WHERE bot='lynx'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(lynx, 2);
        // Its chat is the healthy one.
        assert_eq!(
            chat_section(home.path(), "alice", "lynx").unwrap()["id"],
            "lynx_healthy"
        );
        // With Lynx set aside every bot has one chat, and rerunning does
        // nothing: a cached preview survives it.
        db::open(home.path())
            .unwrap()
            .execute("DELETE FROM sections WHERE bot='lynx'", [])
            .unwrap();
        runtime_store::open(home.path())
            .unwrap()
            .execute(
                "INSERT OR REPLACE INTO native_summaries VALUES('kit_named',1,'cached')",
                [],
            )
            .unwrap();
        // A section an older build makes afterwards is never deleted.
        db::open(home.path())
            .unwrap()
            .execute(
                "INSERT INTO sections(id,bot,owner_id,title,updated_at) VALUES('again','owl','alice','Again',20)",
                [],
            )
            .unwrap();
        said(
            home.path(),
            "again",
            json!({"role":"user","text":"Hello again","timestamp":20}),
        );
        one_chat_per_bot(home.path()).unwrap();
        assert_eq!(
            runtime_store::summary(home.path(), "kit_named").unwrap()["preview"],
            "cached"
        );
        assert_eq!(
            fs::read_dir(home.path().join("backups")).unwrap().count(),
            1
        );
        let ids = |bot: &str| {
            rows(
                &db::open(home.path()).unwrap(),
                "SELECT id FROM sections WHERE bot=? ORDER BY id",
                &[&bot],
            )
            .unwrap()
            .into_iter()
            .map(|r| r["id"].as_str().unwrap().to_owned())
            .collect::<Vec<_>>()
        };
        // Said something, not the dream log, not archived: Garden, though older.
        assert_eq!(ids("owl"), ["again", "old", "thread"]);
        assert!(
            runtime_store::history(home.path(), "put_away")
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            chat_section(home.path(), "alice", "owl").unwrap()["id"],
            "again"
        );
        // A conversation put away outranks a Dreams log still out.
        assert_eq!(ids("nan"), ["nan_trip"]);
        assert_eq!(
            chat_section(home.path(), "alice", "nan").unwrap()["id"],
            "nan_trip"
        );
        // A bot with a conversation recovery could not read keeps them all.
        assert_eq!(ids("yak"), ["yak_new", "yak_old"]);
        // A bot whose only conversation was its dream log keeps it, as reports.
        assert_eq!(ids("fox"), ["fox_dreams"]);
        let fox = chat_section(home.path(), "alice", "fox").unwrap();
        assert_eq!(fox["title"], "General");
        let fox = runtime_store::history(home.path(), "fox_dreams").unwrap();
        assert_eq!(
            fox.iter().map(|m| m["dream"] == true).collect::<Vec<_>>(),
            [true, false, false]
        );
        assert_eq!(ids("elk"), ["elk_recovered"]);
        assert_eq!(ids("fly"), ["fly_legacy"]);
        assert_eq!(ids("mole"), ["mole_legacy"]);
        // A renamed log loses to a real chat, newer or not; kept alone, its
        // reports are marked and its name stays.
        assert_eq!(ids("gnu"), ["gnu_chat"]);
        assert_eq!(ids("hen"), ["hen_log"]);
        assert_eq!(ids("ivy"), ["ivy_chat"]);
        // A renamed log never opened since the native daemon goes too.
        assert_eq!(ids("jay"), ["jay_chat"]);
        assert_eq!(ids("kit"), ["kit_named"]);
        assert!(runtime_store::history(home.path(), "kit_named").unwrap()[0]["dream"].is_null());
        assert_eq!(
            runtime_store::history(home.path(), "hen_log").unwrap()[0]["dream"],
            true
        );
        assert_eq!(
            chat_section(home.path(), "alice", "hen").unwrap()["title"],
            "Nightly"
        );
        // A chat the bot titled Dreams is a chat.
        assert_eq!(ids("dog"), ["dog_chat"]);
        assert_eq!(
            chat_section(home.path(), "alice", "dog").unwrap()["title"],
            "Dreams"
        );
        // A dream log with nothing to mark goes; the chat is made on first use.
        assert!(ids("bee").is_empty());
        // A chat the user named Dreams is a chat.
        assert_eq!(ids("cat"), ["cat_chat"]);
        let cat = chat_section(home.path(), "alice", "cat").unwrap();
        assert_eq!(cat["title"], "Dreams");
        assert!(runtime_store::history(home.path(), "cat_chat").unwrap()[0]["dream"].is_null());
        // Deleting the others is not the bot's activity.
        let activity = |bot: &str| {
            db::open(home.path())
                .unwrap()
                .query_row(
                    "SELECT last_activity_at FROM bots WHERE name=?",
                    [bot],
                    |r| r.get::<_, Option<f64>>(0),
                )
                .unwrap()
        };
        assert_eq!(activity("owl"), Some(7.0));
        // A failed turn in a deleted section no longer stops the bot.
        assert!(
            db::open(home.path())
                .unwrap()
                .query_row(
                    "SELECT resolved_at FROM bot_incidents WHERE id='failed'",
                    [],
                    |r| r.get::<_, Option<f64>>(0),
                )
                .unwrap()
                .is_some()
        );
        assert_eq!(activity("fox"), None);
        // A bot without a chat gets one, once; an archived chat comes back.
        let ant = chat_section(home.path(), "alice", "ant").unwrap();
        call(
            home.path(),
            "alice",
            "hexbot.sections.archive",
            &json!({"id":ant["id"]}),
        )
        .unwrap()
        .unwrap();
        let again = call(
            home.path(),
            "alice",
            "hexbot.sections.create",
            &json!({"bot":"ant","title":"Another"}),
        )
        .unwrap()
        .unwrap();
        assert_eq!(again["section"]["id"], ant["id"]);
        assert!(again["section"]["archived_at"].is_null());
        assert_eq!(ids("ant").len(), 1);
    }
    #[test]
    fn older_dream_reports_stay_out_of_the_bots_context() {
        let home = tempfile::tempdir().unwrap();
        db::migrate(home.path()).unwrap();
        db::open(home.path())
            .unwrap()
            .execute_batch(
                "INSERT INTO users(id,display_name,role,created_at) VALUES('alice','Alice','admin',0);
                 INSERT INTO bots(name,owner_id) VALUES('owl','alice');
                 INSERT INTO sections(id,bot,owner_id,title) VALUES('log','owl','alice','Dreams');
                 INSERT INTO dreams(id,bot,started_at,status,summary) VALUES('d1','owl',1,'complete','Owl learned'),('d2','owl',2,'complete','Owl learned more');",
            )
            .unwrap();
        // An earlier build posted the first report; this one posted the second
        // before the log was ever opened.
        let owl = home.path().join("profiles/owl");
        fs::create_dir_all(&owl).unwrap();
        Connection::open(owl.join("state.db"))
            .unwrap()
            .execute_batch(
                "CREATE TABLE sessions(id TEXT,session_key TEXT,parent_session_id TEXT,model_config TEXT,source TEXT);
                 CREATE TABLE messages(id INTEGER,session_id TEXT,role TEXT,content TEXT,timestamp REAL);
                 INSERT INTO sessions(id,session_key) VALUES('log','log');
                 INSERT INTO messages VALUES(1,'log','assistant','Owl learned',1),(2,'log','user','Why?',1.5),(3,'log','assistant','Because',1.6);",
            )
            .unwrap();
        said(
            home.path(),
            "log",
            json!({"role":"assistant","text":"Owl learned more","dream":true,"timestamp":2000}),
        );
        one_chat_per_bot(home.path()).unwrap();
        let workspace = tempfile::tempdir().unwrap();
        runtime_store::import_hermes(home.path(), "owl", "log", workspace.path()).unwrap();
        let history = runtime_store::history(home.path(), "log").unwrap();
        assert_eq!(
            history
                .iter()
                .map(|m| (m["text"].as_str().unwrap(), m["dream"] == true))
                .collect::<Vec<_>>(),
            [
                ("Owl learned", true),
                ("Why?", false),
                ("Because", false),
                ("Owl learned more", true)
            ]
        );
        let context =
            fs::read_to_string(home.path().join("runtime/sessions/log/conversation.jsonl"))
                .unwrap();
        assert!(!context.contains("Owl learned"));
        assert!(context.contains("Because"));
    }
    /// Owl's Dreams log is its newest section; Trip is its chat.
    fn owl_with_a_newer_dream_log(home: &Path) {
        db::open(home)
            .unwrap()
            .execute_batch(
                "INSERT INTO users(id,display_name,role,created_at) VALUES('alice','Alice','admin',0);
                 INSERT INTO bots(name,owner_id) VALUES('owl','alice');
                 INSERT INTO sections(id,bot,owner_id,title,updated_at) VALUES('log','owl','alice','Dreams',9),('trip','owl','alice','Trip',2);
                 INSERT INTO dreams(id,bot,started_at,status,summary) VALUES('d1','owl',1,'complete','Owl learned');",
            )
            .unwrap();
        said(
            home,
            "log",
            json!({"role":"assistant","text":"Owl learned","timestamp":9}),
        );
        said(
            home,
            "trip",
            json!({"role":"user","text":"Book the train","timestamp":2}),
        );
    }
    fn setting_of(home: &Path, key: &str) -> Value {
        setting(&db::open(home).unwrap(), key).unwrap()
    }
    fn ids_of(home: &Path, bot: &str) -> Vec<String> {
        rows(
            &db::open(home).unwrap(),
            "SELECT id FROM sections WHERE bot=? ORDER BY id",
            &[&bot],
        )
        .unwrap()
        .into_iter()
        .map(|r| r["id"].as_str().unwrap().to_owned())
        .collect()
    }
    #[test]
    fn the_upgrade_deletes_nothing_it_could_not_back_up_and_never_tries_again() {
        let home = tempfile::tempdir().unwrap();
        db::migrate(home.path()).unwrap();
        owl_with_a_newer_dream_log(home.path());
        // Something in the way of the backup folder.
        fs::write(home.path().join("backups"), "").unwrap();
        one_chat_per_bot(home.path()).unwrap();
        assert_eq!(setting_of(home.path(), "one_chat_per_bot"), true);
        assert_eq!(ids_of(home.path(), "owl"), ["log", "trip"]);
        // The Dreams log never outranks a conversation, though newer.
        assert_eq!(
            chat_section(home.path(), "alice", "owl").unwrap()["id"],
            "trip"
        );
        assert_eq!(
            runtime_store::history(home.path(), "log").unwrap()[0]["dream"],
            true
        );
        // The next start deletes nothing, even with room for a backup.
        fs::remove_file(home.path().join("backups")).unwrap();
        one_chat_per_bot(home.path()).unwrap();
        assert_eq!(ids_of(home.path(), "owl"), ["log", "trip"]);
        assert!(!home.path().join("backups").exists());
    }
    #[cfg(unix)]
    #[test]
    fn a_failed_backup_leaves_nothing_behind() {
        use std::os::unix::fs::PermissionsExt;
        let home = tempfile::tempdir().unwrap();
        db::migrate(home.path()).unwrap();
        db::open(home.path())
            .unwrap()
            .execute_batch(
                "INSERT INTO users(id,display_name,role,created_at) VALUES('alice','Alice','admin',0);
                 INSERT INTO bots(name,owner_id) VALUES('owl','alice');
                 INSERT INTO sections(id,bot,owner_id,title,updated_at) VALUES('new','owl','alice','New',9),('old','owl','alice','Old',2);",
            )
            .unwrap();
        said(home.path(), "new", json!({"role":"user","text":"Newer"}));
        said(home.path(), "old", json!({"role":"user","text":"Older"}));
        // A copy an earlier build could not finish.
        let backups = home.path().join("backups");
        fs::create_dir_all(backups.join("one-chat-per-bot-20260101-000000.partial/runtime"))
            .unwrap();
        // A file the copy cannot read stops it part way.
        let file = home.path().join("runtime/sessions/old/locked.txt");
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, "locked").unwrap();
        fs::set_permissions(&file, fs::Permissions::from_mode(0o000)).unwrap();
        if fs::File::open(&file).is_ok() {
            // Running as root reads anything.
            return;
        }
        one_chat_per_bot(home.path()).unwrap();
        fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(fs::read_dir(&backups).unwrap().count(), 0);
        assert_eq!(ids_of(home.path(), "owl"), ["new", "old"]);
        one_chat_per_bot(home.path()).unwrap();
        assert_eq!(fs::read_dir(&backups).unwrap().count(), 0);
        assert_eq!(ids_of(home.path(), "owl"), ["new", "old"]);
    }
    #[test]
    fn the_dream_log_is_never_the_chat_when_recovery_fails() {
        let home = tempfile::tempdir().unwrap();
        db::migrate(home.path()).unwrap();
        owl_with_a_newer_dream_log(home.path());
        // A conversation recovery cannot even start on stops the upgrade
        // after it found the dream logs.
        runtime_store::open(home.path())
            .unwrap()
            .execute(
                "INSERT INTO native_sessions(stored_id,owner,bot,prompt) VALUES('broken','alice','','')",
                [],
            )
            .unwrap();
        one_chat_per_bot(home.path()).unwrap();
        assert_eq!(setting_of(home.path(), "one_chat_per_bot"), true);
        assert_eq!(ids_of(home.path(), "owl"), ["log", "trip"]);
        assert_eq!(
            chat_section(home.path(), "alice", "owl").unwrap()["id"],
            "trip"
        );
        // Repaired, the next start still deletes nothing.
        runtime_store::open(home.path())
            .unwrap()
            .execute("DELETE FROM native_sessions WHERE stored_id='broken'", [])
            .unwrap();
        one_chat_per_bot(home.path()).unwrap();
        assert_eq!(ids_of(home.path(), "owl"), ["log", "trip"]);
        assert!(!home.path().join("backups").exists());
    }
    #[test]
    fn a_bot_whose_older_store_cannot_be_read_holds_up_no_other() {
        let home = tempfile::tempdir().unwrap();
        db::migrate(home.path()).unwrap();
        owl_with_a_newer_dream_log(home.path());
        db::open(home.path())
            .unwrap()
            .execute_batch(
                "INSERT INTO bots(name,owner_id) VALUES('yak','alice');
                 INSERT INTO sections(id,bot,owner_id,title,updated_at) VALUES('yak_log','yak','alice','Dreams',1),('yak_b','yak','alice','B',2);
                 INSERT INTO dreams(id,bot,started_at,status,summary) VALUES('d2','yak',1,'complete','Yak learned');",
            )
            .unwrap();
        let yak = home.path().join("profiles/yak");
        fs::create_dir_all(&yak).unwrap();
        fs::write(yak.join("state.db"), "not a database").unwrap();
        one_chat_per_bot(home.path()).unwrap();
        assert_eq!(setting_of(home.path(), "one_chat_per_bot"), true);
        assert_eq!(ids_of(home.path(), "owl"), ["trip"]);
        assert_eq!(ids_of(home.path(), "yak"), ["yak_b", "yak_log"]);
        assert_eq!(
            chat_section(home.path(), "alice", "owl").unwrap()["id"],
            "trip"
        );
        // Neither of its sections would open, so it gets a new chat that
        // does, and keeps it.
        let fresh = chat_section(home.path(), "alice", "yak").unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        assert!(!["yak_b", "yak_log"].contains(&fresh.as_str()));
        assert_eq!(
            chat_section(home.path(), "alice", "yak").unwrap()["id"],
            fresh
        );
        let workspace = tempfile::tempdir().unwrap();
        runtime_store::import_hermes(home.path(), "yak", &fresh, workspace.path()).unwrap();
        assert!(
            runtime_store::import_hermes(home.path(), "yak", "yak_b", workspace.path()).is_err()
        );
        // Repaired, the mixed log is a conversation too, and its newer
        // dialogue makes it the chat at the first lookup.
        fs::remove_file(yak.join("state.db")).unwrap();
        Connection::open(yak.join("state.db"))
            .unwrap()
            .execute_batch(
                "CREATE TABLE sessions(id TEXT,session_key TEXT,parent_session_id TEXT,model_config TEXT,source TEXT);
                 CREATE TABLE messages(id INTEGER,session_id TEXT,role TEXT,content TEXT,timestamp REAL);
                 INSERT INTO sessions(id,session_key) VALUES('yak_log','yak_log'),('yak_b','yak_b');
                 INSERT INTO messages VALUES(1,'yak_log','assistant','Yak learned',5),(2,'yak_log','user','Why?',5.5),(3,'yak_b','user','Plans',1),(4,'yak_b','assistant','Sure',1.5);",
            )
            .unwrap();
        assert_eq!(
            chat_section(home.path(), "alice", "yak").unwrap()["id"],
            "yak_log"
        );
        runtime_store::import_hermes(home.path(), "yak", "yak_log", workspace.path()).unwrap();
        assert_eq!(
            runtime_store::history(home.path(), "yak_log")
                .unwrap()
                .iter()
                .map(|m| (m["text"].as_str().unwrap(), m["dream"] == true))
                .collect::<Vec<_>>(),
            [("Yak learned", true), ("Why?", false)]
        );
        let context = fs::read_to_string(
            home.path()
                .join("runtime/sessions/yak_log/conversation.jsonl"),
        )
        .unwrap();
        assert!(!context.contains("Yak learned"));
        // Still never deleted.
        one_chat_per_bot(home.path()).unwrap();
        assert_eq!(ids_of(home.path(), "yak").len(), 3);
    }
    fn owl_with_four_conversations(home: &Path) {
        db::open(home)
            .unwrap()
            .execute_batch(
                "INSERT INTO users(id,display_name,role,created_at) VALUES('alice','Alice','admin',0);
                 INSERT INTO bots(name,owner_id) VALUES('owl','alice');
                 INSERT INTO sections(id,bot,owner_id,title,updated_at) VALUES('new','owl','alice','New',9),('mid','owl','alice','Mid',5),('stuck','owl','alice','Stuck',3),('old','owl','alice','Old',2);",
            )
            .unwrap();
        for (id, time) in [("new", 9), ("mid", 5), ("stuck", 3), ("old", 2)] {
            said(
                home,
                id,
                json!({"role":"user","text":format!("In {id}"),"timestamp":time}),
            );
        }
    }
    #[test]
    fn migration_incident_cleanup_follows_the_catalog_commit_when_history_fails() {
        for failure in ["catalog", "native", "legacy"] {
            let home = tempfile::tempdir().unwrap();
            db::migrate(home.path()).unwrap();
            owl_with_four_conversations(home.path());
            let conn = db::open(home.path()).unwrap();
            conn.execute_batch(
                "INSERT INTO users(id,display_name,role,created_at) VALUES('bob','Bob','member',0);
                 INSERT INTO bots(name,owner_id) VALUES('remote','bob');
                 INSERT INTO rooms(id,name,owner_id) VALUES('room','Room','alice');
                 INSERT INTO room_sessions(room_id,bot,stored_session_id) VALUES('room','owl','room-transcript');
                 INSERT INTO bot_incidents(id,bot,section_id,room_id,kind,connector,text,created_at) VALUES
                 ('private-mid','owl','mid',NULL,'turn_failed',NULL,'Private mid',1),
                 ('private-stuck','owl','stuck',NULL,'turn_failed',NULL,'Private stuck',2),
                 ('private-new','owl','new',NULL,'turn_failed',NULL,'Private new',3),
                 ('room','owl','mid','room','turn_failed',NULL,'Room',4),
                 ('legacy-room','owl','room-transcript',NULL,'turn_failed',NULL,'Legacy room',5),
                 ('connector','owl','mid',NULL,'connector_error','github','Connector',6),
                 ('global','owl',NULL,NULL,'turn_failed',NULL,'Global',7),
                 ('foreign','remote','mid',NULL,'turn_failed',NULL,'Other bot',8);",
            ).unwrap();
            let native = runtime_store::open(home.path()).unwrap();
            let profile = profile(home.path(), "owl").unwrap();
            fs::create_dir_all(&profile).unwrap();
            let legacy = Connection::open(profile.join("state.db")).unwrap();
            legacy.execute_batch(
                "CREATE TABLE sessions(id TEXT,session_key TEXT,parent_session_id TEXT,model_config TEXT,source TEXT);
                 CREATE TABLE messages(id INTEGER,session_id TEXT,role TEXT,content TEXT,timestamp REAL);
                 INSERT INTO sessions(id,session_key) VALUES('mid','mid');
                 INSERT INTO messages VALUES(1,'mid','user','Older mid',5);",
            ).unwrap();
            match failure {
                // Failing incident retirement must roll back the catalog row too.
                "catalog" => conn.execute_batch(
                    "CREATE TRIGGER stuck BEFORE UPDATE ON bot_incidents WHEN OLD.id='private-mid'
                     BEGIN SELECT RAISE(ABORT,'incident cleanup failed'); END;",
                ).unwrap(),
                "native" => native.execute_batch(
                    "CREATE TRIGGER stuck BEFORE DELETE ON native_messages WHEN OLD.session_id='mid'
                     BEGIN SELECT RAISE(ABORT,'native purge failed'); END;",
                ).unwrap(),
                "legacy" => legacy.execute_batch(
                    "CREATE TRIGGER stuck BEFORE DELETE ON messages
                     BEGIN SELECT RAISE(ABORT,'legacy purge failed'); END;",
                ).unwrap(),
                _ => unreachable!(),
            }
            one_chat_per_bot(home.path()).unwrap();
            let committed = failure != "catalog";
            let expected = if committed {
                vec!["new", "old", "stuck"]
            } else {
                vec!["mid", "new", "old", "stuck"]
            };
            assert_eq!(ids_of(home.path(), "owl"), expected, "{failure}");
            let resolved = || {
                rows(
                    &conn,
                    "SELECT id FROM bot_incidents WHERE resolved_at IS NOT NULL ORDER BY id",
                    &[],
                )
                .unwrap()
                .into_iter()
                .map(|r| r["id"].as_str().unwrap().to_owned())
                .collect::<Vec<_>>()
            };
            assert_eq!(
                resolved(),
                if committed {
                    vec!["private-mid"]
                } else {
                    vec![]
                },
                "{failure}"
            );
            assert_eq!(
                chat_section(home.path(), "alice", "owl").unwrap()["id"],
                "new"
            );
            assert_eq!(
                bot(home.path(), "alice", "owl").unwrap()["status_detail"]["text"],
                "Global"
            );
            assert_eq!(
                native
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM native_deleted WHERE session_id='mid')",
                        [],
                        |r| r.get::<_, bool>(0)
                    )
                    .unwrap(),
                committed
            );
            assert_eq!(
                runtime_store::history(home.path(), "mid")
                    .unwrap()
                    .is_empty(),
                failure == "legacy"
            );
            assert_eq!(
                legacy
                    .query_row("SELECT content FROM messages", [], |r| r
                        .get::<_, String>(0))
                    .unwrap(),
                "Older mid"
            );
            let backup = fs::read_dir(home.path().join("backups"))
                .unwrap()
                .next()
                .unwrap()
                .unwrap()
                .path();
            let saved = Connection::open(backup.join("hexbot.db")).unwrap();
            assert_eq!(
                saved
                    .query_row("SELECT count(*) FROM sections", [], |r| r.get::<_, i64>(0))
                    .unwrap(),
                4
            );
            assert_eq!(
                saved
                    .query_row(
                        "SELECT count(*) FROM bot_incidents WHERE resolved_at IS NOT NULL",
                        [],
                        |r| r.get::<_, i64>(0)
                    )
                    .unwrap(),
                0
            );
            assert_eq!(
                runtime_store::history(&backup, "mid").unwrap()[0]["text"],
                "In mid"
            );
            match failure {
                "catalog" => conn.execute_batch("DROP TRIGGER stuck;").unwrap(),
                "native" => native.execute_batch("DROP TRIGGER stuck;").unwrap(),
                "legacy" => legacy.execute_batch("DROP TRIGGER stuck;").unwrap(),
                _ => unreachable!(),
            }
            runtime_store::finish_deletes(home.path()).unwrap();
            one_chat_per_bot(home.path()).unwrap();
            assert_eq!(ids_of(home.path(), "owl"), expected);
            assert_eq!(
                resolved(),
                if committed {
                    vec!["private-mid"]
                } else {
                    vec![]
                }
            );
            assert_eq!(
                fs::read_dir(home.path().join("backups")).unwrap().count(),
                1
            );
            assert_eq!(
                runtime_store::history(home.path(), "mid")
                    .unwrap()
                    .is_empty(),
                committed
            );
            // The combined deletion contract retries identifiable legacy cleanup
            // after the catalog commit; failed decisions keep it byte for byte.
            assert_eq!(
                legacy
                    .query_row("SELECT count(*) FROM messages", [], |r| r.get::<_, i64>(0))
                    .unwrap(),
                i64::from(!committed)
            );
            for id in ["new", "old", "stuck"] {
                assert_eq!(
                    runtime_store::history(home.path(), id).unwrap()[0]["text"],
                    format!("In {id}")
                );
            }
        }
    }
    #[test]
    fn unreadable_native_chats_stay_for_repair_but_are_never_canonical() {
        for healthy in [false, true] {
            let home = tempfile::tempdir().unwrap();
            db::migrate(home.path()).unwrap();
            db::open(home.path()).unwrap().execute_batch(
                "INSERT INTO users(id,display_name,role,created_at) VALUES('alice','Alice','admin',0);
                 INSERT INTO bots(name,owner_id) VALUES('owl','alice');
                 INSERT INTO sections(id,bot,owner_id,title,updated_at) VALUES('unreadable','owl','alice','Unreadable',9);",
            ).unwrap();
            said(
                home.path(),
                "unreadable",
                json!({"role":"user","text":"Keep me","timestamp":9}),
            );
            let path = home
                .path()
                .join("runtime/sessions/unreadable/conversation.jsonl");
            fs::create_dir_all(&path).unwrap();
            fs::write(path.join("kept"), "for repair").unwrap();
            if healthy {
                db::open(home.path()).unwrap().execute_batch(
                    "INSERT INTO sections(id,bot,owner_id,title,updated_at) VALUES('healthy','owl','alice','Healthy',2);",
                ).unwrap();
                said(
                    home.path(),
                    "healthy",
                    json!({"role":"user","text":"Open me","timestamp":2}),
                );
            }
            one_chat_per_bot(home.path()).unwrap();
            let selected = chat_section(home.path(), "alice", "owl").unwrap();
            let id = selected["id"].as_str().unwrap();
            assert_ne!(id, "unreadable");
            if healthy {
                assert_eq!(id, "healthy");
            }
            runtime_store::reconcile(home.path(), "owl", id, "alice").unwrap();
            let workspace = tempfile::tempdir().unwrap();
            runtime_store::import_hermes(home.path(), "owl", id, workspace.path()).unwrap();
            assert_eq!(chat_section(home.path(), "alice", "owl").unwrap()["id"], id);
            assert!(ids_of(home.path(), "owl").contains(&"unreadable".to_owned()));
            assert_eq!(fs::read_to_string(path.join("kept")).unwrap(), "for repair");
            assert_eq!(
                runtime_store::history(home.path(), "unreadable").unwrap()[0]["text"],
                "Keep me"
            );
            // A later start may recover the repaired chat, but never reruns the deletes.
            fs::remove_dir_all(&path).unwrap();
            fs::write(
                &path,
                "{\"type\":\"session\",\"version\":3,\"id\":\"unreadable\"}\n",
            )
            .unwrap();
            runtime_store::reconcile_all(home.path()).unwrap();
            one_chat_per_bot(home.path()).unwrap();
            assert!(ids_of(home.path(), "owl").contains(&"unreadable".to_owned()));
            assert_eq!(
                chat_section(home.path(), "alice", "owl").unwrap()["id"],
                "unreadable"
            );
        }
    }
    #[cfg(unix)]
    #[test]
    fn native_recovery_does_not_mistake_denied_metadata_for_a_missing_file() {
        use std::os::unix::fs::PermissionsExt;
        let home = tempfile::tempdir().unwrap();
        db::migrate(home.path()).unwrap();
        owl_with_four_conversations(home.path());
        let dir = runtime_store::session_dir(home.path(), "new").unwrap();
        let path = dir.join("conversation.jsonl");
        fs::write(
            &path,
            "{\"type\":\"session\",\"version\":3,\"id\":\"new\"}\n",
        )
        .unwrap();
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o000)).unwrap();
        if fs::read(&path).is_ok() {
            fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).unwrap();
            return; // Root can read through these permissions.
        }
        one_chat_per_bot(home.path()).unwrap();
        let selected = chat_section(home.path(), "alice", "owl").unwrap();
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(ids_of(home.path(), "owl"), ["mid", "new", "old", "stuck"]);
        assert_eq!(selected["id"], "mid");
        assert!(path.is_file());
        runtime_store::reconcile_all(home.path()).unwrap();
        assert_eq!(
            chat_section(home.path(), "alice", "owl").unwrap()["id"],
            "new"
        );
    }
    #[test]
    fn a_failed_native_history_purge_stops_the_upgrade_and_retries_only_cleanup() {
        let home = tempfile::tempdir().unwrap();
        db::migrate(home.path()).unwrap();
        owl_with_four_conversations(home.path());
        runtime_store::open(home.path()).unwrap().execute_batch(
            "CREATE TRIGGER stuck BEFORE DELETE ON native_messages WHEN OLD.session_id='mid' BEGIN SELECT RAISE(ABORT,'history purge failed'); END;",
        ).unwrap();
        one_chat_per_bot(home.path()).unwrap();
        assert_eq!(ids_of(home.path(), "owl"), ["new", "old", "stuck"]);
        assert_eq!(
            runtime_store::history(home.path(), "mid").unwrap()[0]["text"],
            "In mid"
        );
        assert!(
            runtime_store::append(
                home.path(),
                "mid",
                json!({"role":"user","text":"No resurrection"})
            )
            .is_err()
        );
        runtime_store::open(home.path())
            .unwrap()
            .execute_batch("DROP TRIGGER stuck;")
            .unwrap();
        runtime_store::finish_deletes(home.path()).unwrap();
        one_chat_per_bot(home.path()).unwrap();
        assert!(
            runtime_store::history(home.path(), "mid")
                .unwrap()
                .is_empty()
        );
        assert_eq!(ids_of(home.path(), "owl"), ["new", "old", "stuck"]);
        for id in ["old", "stuck"] {
            assert_eq!(
                runtime_store::history(home.path(), id).unwrap()[0]["text"],
                format!("In {id}")
            );
        }
        assert_eq!(
            fs::read_dir(home.path().join("backups")).unwrap().count(),
            1
        );
    }
    #[test]
    fn a_failed_legacy_purge_stops_the_upgrade_after_the_catalog_commit() {
        let home = tempfile::tempdir().unwrap();
        db::migrate(home.path()).unwrap();
        owl_with_four_conversations(home.path());
        let profile = profile(home.path(), "owl").unwrap();
        fs::create_dir_all(&profile).unwrap();
        Connection::open(profile.join("state.db")).unwrap().execute_batch(
            "CREATE TABLE sessions(id TEXT,session_key TEXT,parent_session_id TEXT,model_config TEXT,source TEXT);
             CREATE TABLE messages(id INTEGER,session_id TEXT,role TEXT,content TEXT,timestamp REAL);
             INSERT INTO sessions(id,session_key) VALUES('mid','mid');
             INSERT INTO messages VALUES(1,'mid','user','Older copy',5);
             CREATE TRIGGER stuck BEFORE DELETE ON messages BEGIN SELECT RAISE(ABORT,'legacy purge failed'); END;",
        ).unwrap();
        one_chat_per_bot(home.path()).unwrap();
        assert_eq!(ids_of(home.path(), "owl"), ["new", "old", "stuck"]);
        assert!(
            runtime_store::history(home.path(), "mid")
                .unwrap()
                .is_empty()
        );
        assert!(runtime_store::session_dir(home.path(), "mid").is_err());
        let legacy = Connection::open(profile.join("state.db")).unwrap();
        assert_eq!(
            legacy
                .query_row("SELECT count(*) FROM messages", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
        legacy.execute_batch("DROP TRIGGER stuck;").unwrap();
        runtime_store::finish_deletes(home.path()).unwrap();
        one_chat_per_bot(home.path()).unwrap();
        assert_eq!(ids_of(home.path(), "owl"), ["new", "old", "stuck"]);
    }
    #[test]
    fn a_committed_peer_thread_delete_reports_pending_history_as_success() {
        let home = tempfile::tempdir().unwrap();
        db::migrate(home.path()).unwrap();
        owl_with_four_conversations(home.path());
        db::open(home.path()).unwrap().execute_batch("INSERT INTO bots(name,owner_id) VALUES('teammate','alice'); UPDATE sections SET peer_bot='teammate' WHERE id='mid';").unwrap();
        let private = crate::settings::record_incident(
            home.path(),
            "owl",
            "turn_failed",
            "Private failure",
            &json!({"section_id":"mid"}),
        )
        .unwrap();
        let connector = crate::settings::record_incident(
            home.path(),
            "owl",
            "connector_error",
            "Connector failure",
            &json!({"section_id":"mid","connector":"github"}),
        )
        .unwrap();
        runtime_store::open(home.path()).unwrap().execute_batch(
            "CREATE TRIGGER stuck BEFORE DELETE ON native_messages WHEN OLD.session_id='mid' BEGIN SELECT RAISE(ABORT,'history purge failed'); END;",
        ).unwrap();
        let result = call(
            home.path(),
            "alice",
            "hexbot.sections.delete",
            &json!({"id":"mid"}),
        )
        .unwrap()
        .unwrap();
        assert_eq!(result["deleted"], true);
        assert_eq!(result["history_pending"], true);
        assert_eq!(ids_of(home.path(), "owl"), ["new", "old", "stuck"]);
        assert!(runtime_store::session_dir(home.path(), "mid").is_err());
        let conn = db::open(home.path()).unwrap();
        for (incident, resolved) in [(private, true), (connector, false)] {
            assert_eq!(
                conn.query_row(
                    "SELECT resolved_at IS NOT NULL FROM bot_incidents WHERE id=?",
                    [incident["id"].as_str().unwrap()],
                    |r| r.get::<_, bool>(0)
                )
                .unwrap(),
                resolved
            );
        }
        assert!(
            call(
                home.path(),
                "alice",
                "hexbot.sections.delete",
                &json!({"id":"mid"})
            )
            .unwrap()
            .is_err()
        );
    }
    fn legacy_log(home: &Path, title: &str, dialogue: bool, ordinary: bool) {
        db::migrate(home).unwrap();
        let conn = db::open(home).unwrap();
        conn.execute_batch(
            "INSERT INTO users(id,display_name,role,created_at) VALUES('alice','Alice','admin',0);
             INSERT INTO bots(name,owner_id) VALUES('owl','alice');
             INSERT INTO dreams(id,bot,started_at,status,summary) VALUES('dream','owl',1,'complete','Stored report');",
        ).unwrap();
        conn.execute("INSERT INTO sections(id,bot,owner_id,title,updated_at) VALUES('log','owl','alice',?,3)", [title]).unwrap();
        if ordinary {
            conn.execute_batch("INSERT INTO sections(id,bot,owner_id,title,updated_at) VALUES('ordinary','owl','alice','Trip',9)").unwrap();
            said(
                home,
                "ordinary",
                json!({"role":"user","text":"Trip plans","timestamp":9}),
            );
        }
        let dir = profile(home, "owl").unwrap();
        fs::create_dir_all(&dir).unwrap();
        let legacy = Connection::open(dir.join("state.db")).unwrap();
        legacy.execute_batch(
            "CREATE TABLE sessions(id TEXT,session_key TEXT,parent_session_id TEXT,model_config TEXT,source TEXT);
             CREATE TABLE messages(id INTEGER,session_id TEXT,role TEXT,content TEXT,timestamp REAL);
             INSERT INTO sessions(id,session_key) VALUES('log','log');
             INSERT INTO messages VALUES(1,'log','assistant','Stored report',1);",
        ).unwrap();
        if dialogue {
            legacy.execute_batch("INSERT INTO messages VALUES(2,'log','user','Human question',2),(3,'log','assistant','Actual reply',3)").unwrap();
        }
        legacy
            .execute_batch("ALTER TABLE messages ADD COLUMN active INTEGER DEFAULT 1")
            .unwrap();
    }
    // Native-only, legacy-only and a projection interrupted before its JSONL
    // commit must all use the same non-report dialogue time.
    #[test]
    fn reports_do_not_rank_a_mixed_log_above_newer_dialogue() {
        for source in ["native", "legacy", "partial", "imported"] {
            for title in ["Dreams", "Night notes"] {
                let home = tempfile::tempdir().unwrap();
                legacy_log(home.path(), title, true, true);
                // The ordinary conversation is fully native, beside a log
                // whose legacy import may still be unfinished.
                let workspace = tempfile::tempdir().unwrap();
                runtime_store::import_hermes(home.path(), "owl", "ordinary", workspace.path())
                    .unwrap();
                let conn = db::open(home.path()).unwrap();
                conn.execute_batch("INSERT INTO dreams(id,bot,started_at,status,summary) VALUES('later','owl',20,'complete','Later report'); UPDATE sections SET updated_at=20.001 WHERE id='log';").unwrap();
                Connection::open(profile(home.path(), "owl").unwrap().join("state.db")).unwrap().execute_batch("INSERT INTO messages(id,session_id,role,content,timestamp) VALUES(4,'log','assistant','Later report',20);").unwrap();
                if source == "imported" {
                    let workspace = tempfile::tempdir().unwrap();
                    runtime_store::import_hermes(home.path(), "owl", "log", workspace.path())
                        .unwrap();
                } else if source != "legacy" {
                    said(
                        home.path(),
                        "log",
                        json!({"role":"assistant","text":"Stored report","timestamp":1}),
                    );
                    if source == "native" {
                        said(
                            home.path(),
                            "log",
                            json!({"role":"user","text":"Human question","timestamp":2}),
                        );
                        said(
                            home.path(),
                            "log",
                            json!({"role":"assistant","text":"Actual reply","timestamp":3}),
                        );
                        fs::remove_file(profile(home.path(), "owl").unwrap().join("state.db"))
                            .unwrap();
                    }
                    said(
                        home.path(),
                        "log",
                        json!({"role":"assistant","text":"Later report","timestamp":20}),
                    );
                }
                assert_eq!(
                    chat_section(home.path(), "alice", "owl").unwrap()["id"],
                    "ordinary",
                    "{source} {title}"
                );
                one_chat_per_bot(home.path()).unwrap();
                // updated_at cannot tell a report from an overwritten chooser
                // selection. Preserve both histories rather than delete either.
                assert_eq!(ids_of(home.path(), "owl"), ["log", "ordinary"]);
                assert_eq!(setting_of(home.path(), "one_chat_per_bot"), true);
                // Finish an interrupted import before checking its native digest.
                // Migration itself must preserve the still-legacy human rows.
                if source == "partial" {
                    let workspace = tempfile::tempdir().unwrap();
                    runtime_store::import_hermes(home.path(), "owl", "log", workspace.path())
                        .unwrap();
                }
                let digest = crate::dreaming::build_digest(home.path(), "owl", 0.0, f64::MAX, None)
                    .unwrap()
                    .to_string();
                assert!(
                    digest.contains("Human question") && digest.contains("Trip plans"),
                    "{source} {title}: {digest}"
                );
                assert!(!digest.contains("Stored report") && !digest.contains("Later report"));
                one_chat_per_bot(home.path()).unwrap();
                assert_eq!(ids_of(home.path(), "owl"), ["log", "ordinary"]);
            }
        }
    }
    #[test]
    fn reports_after_an_explicit_old_choice_preserve_both_conversations() {
        for picked in ["log", "ordinary"] {
            let home = tempfile::tempdir().unwrap();
            legacy_log(home.path(), "Night notes", true, true);
            call(
                home.path(),
                "alice",
                "hexbot.sections.unarchive",
                &json!({"id":picked}),
            )
            .unwrap()
            .unwrap();
            let later = now() + 1.0;
            Connection::open(profile(home.path(), "owl").unwrap().join("state.db")).unwrap().execute("INSERT INTO messages(id,session_id,role,content,timestamp) VALUES(4,'log','assistant','Stored report',?)", [later]).unwrap();
            db::open(home.path())
                .unwrap()
                .execute(
                    "UPDATE sections SET updated_at=? WHERE id='log'",
                    [later + 0.001],
                )
                .unwrap();
            one_chat_per_bot(home.path()).unwrap();
            assert_eq!(ids_of(home.path(), "owl"), ["log", "ordinary"]);
            assert_eq!(
                chat_section(home.path(), "alice", "owl").unwrap()["id"],
                "ordinary"
            );
        }
    }
    #[test]
    fn mixed_log_timestamps_that_cannot_order_dialogue_preserve_history() {
        for timestamp in [Value::Null, json!("broken"), json!(0), json!(-1)] {
            let home = tempfile::tempdir().unwrap();
            legacy_log(home.path(), "Night notes", true, true);
            fs::remove_file(profile(home.path(), "owl").unwrap().join("state.db")).unwrap();
            said(
                home.path(),
                "log",
                json!({"role":"assistant","text":"Stored report","timestamp":1}),
            );
            said(
                home.path(),
                "log",
                json!({"role":"user","text":"Keep this question","timestamp":timestamp}),
            );
            one_chat_per_bot(home.path()).unwrap();
            assert_eq!(ids_of(home.path(), "owl"), ["log", "ordinary"]);
            assert_eq!(
                chat_section(home.path(), "alice", "owl").unwrap()["id"],
                "ordinary"
            );
        }
    }
    #[test]
    fn a_standalone_mixed_log_keeps_dialogue_when_the_last_message_is_a_report() {
        for imported in [false, true] {
            let home = tempfile::tempdir().unwrap();
            legacy_log(home.path(), "Dreams", true, false);
            Connection::open(profile(home.path(), "owl").unwrap().join("state.db")).unwrap().execute_batch("INSERT INTO messages(id,session_id,role,content,timestamp) VALUES(4,'log','assistant','Stored report',20)").unwrap();
            db::open(home.path())
                .unwrap()
                .execute_batch("UPDATE sections SET updated_at=20.001 WHERE id='log'")
                .unwrap();
            if imported {
                let workspace = tempfile::tempdir().unwrap();
                runtime_store::import_hermes(home.path(), "owl", "log", workspace.path()).unwrap();
            }
            one_chat_per_bot(home.path()).unwrap();
            assert_eq!(ids_of(home.path(), "owl"), ["log"]);
            assert_eq!(
                chat_section(home.path(), "alice", "owl").unwrap()["id"],
                "log"
            );
            assert_eq!(
                section(home.path(), "alice", "log").unwrap()["title"],
                "General"
            );
            let digest = crate::dreaming::build_digest(home.path(), "owl", 0.0, f64::MAX, None)
                .unwrap()
                .to_string();
            assert!(digest.contains("Human question"));
            assert!(!digest.contains("Stored report"));
        }
    }
    #[test]
    fn uncertain_legacy_dialogue_times_cannot_authorize_deletion() {
        for timestamp in [Value::Null, json!("broken"), json!(0), json!(-1)] {
            let home = tempfile::tempdir().unwrap();
            legacy_log(home.path(), "Night notes", true, true);
            let conn =
                Connection::open(profile(home.path(), "owl").unwrap().join("state.db")).unwrap();
            conn.execute(
                "UPDATE messages SET timestamp=json_extract(?, '$') WHERE role<>'assistant'",
                [timestamp.to_string()],
            )
            .unwrap();
            one_chat_per_bot(home.path()).unwrap();
            assert_eq!(ids_of(home.path(), "owl"), ["log", "ordinary"]);
            assert_eq!(
                chat_section(home.path(), "alice", "owl").unwrap()["id"],
                "ordinary"
            );
        }
    }
    #[cfg(unix)]
    struct RestorePermissions(PathBuf, fs::Permissions);
    #[cfg(unix)]
    impl RestorePermissions {
        fn deny(path: PathBuf) -> Self {
            use std::os::unix::fs::PermissionsExt;
            let original = fs::metadata(&path).unwrap().permissions();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o000)).unwrap();
            Self(path, original)
        }
    }
    #[cfg(unix)]
    impl Drop for RestorePermissions {
        fn drop(&mut self) {
            fs::set_permissions(&self.0, self.1.clone()).unwrap();
        }
    }
    #[cfg(unix)]
    #[test]
    fn legacy_metadata_errors_preserve_catalog_history_and_one_shot_marker() {
        for healthy in [false, true] {
            let home = tempfile::tempdir().unwrap();
            legacy_log(home.path(), "Night notes", true, healthy);
            if healthy {
                runtime_store::mark_fresh(home.path(), "ordinary").unwrap();
            } else {
                db::open(home.path()).unwrap().execute_batch("INSERT INTO sections(id,bot,owner_id,title,updated_at) VALUES('older','owl','alice','Older',1);").unwrap();
                Connection::open(profile(home.path(), "owl").unwrap().join("state.db")).unwrap().execute_batch("INSERT INTO sessions(id,session_key) VALUES('older','older'); INSERT INTO messages(id,session_id,role,content,timestamp) VALUES(4,'older','user','Older conversation',1);").unwrap();
            }
            let profile = profile(home.path(), "owl").unwrap();
            let denied = RestorePermissions::deny(profile.clone());
            assert!(
                profile.join("state.db").try_exists().is_err(),
                "fixture must deny actual traversal"
            );
            one_chat_per_bot(home.path()).unwrap();
            assert_eq!(
                ids_of(home.path(), "owl"),
                if healthy {
                    vec!["log", "ordinary"]
                } else {
                    vec!["log", "older"]
                }
            );
            assert_eq!(setting_of(home.path(), "one_chat_per_bot"), true);
            assert!(setting_of(home.path(), "dream_log_bots").is_null());
            if healthy {
                assert_eq!(
                    chat_section(home.path(), "alice", "owl").unwrap()["id"],
                    "ordinary"
                );
            } else {
                assert_ne!(
                    chat_section(home.path(), "alice", "owl").unwrap()["id"],
                    "log"
                );
            }
            assert!(!home.path().join("backups").exists());
            let before = ids_of(home.path(), "owl");
            drop(denied);
            one_chat_per_bot(home.path()).unwrap();
            assert_eq!(ids_of(home.path(), "owl"), before);
            assert_eq!(
                section(home.path(), "alice", "log").unwrap()["message_count"],
                3
            );
            assert_eq!(
                chat_section(home.path(), "alice", "owl").unwrap()["id"],
                if healthy { "ordinary" } else { "log" }
            );
        }
    }
    #[cfg(unix)]
    #[test]
    fn backup_refuses_unreadable_legacy_database_and_removes_partial_copy() {
        let home = tempfile::tempdir().unwrap();
        legacy_log(home.path(), "Night notes", true, true);
        let denied = RestorePermissions::deny(profile(home.path(), "owl").unwrap());
        assert!(back_up(home.path(), &BTreeSet::from(["owl"])).is_err());
        assert_eq!(
            fs::read_dir(home.path().join("backups")).unwrap().count(),
            0
        );
        drop(denied);
        let backup = back_up(home.path(), &BTreeSet::from(["owl"])).unwrap();
        assert!(backup.join("profiles/owl/state.db").is_file());
    }
    #[test]
    fn later_legacy_logs_are_classified_without_repeating_migration() {
        for title in ["Dreams", "Night notes"] {
            for mixed in [false, true] {
                let home = tempfile::tempdir().unwrap();
                legacy_log(home.path(), "Initial notes", false, true);
                let workspace = tempfile::tempdir().unwrap();
                runtime_store::import_hermes(home.path(), "owl", "ordinary", workspace.path())
                    .unwrap();
                one_chat_per_bot(home.path()).unwrap();
                assert_eq!(ids_of(home.path(), "owl"), ["ordinary"]);
                db::open(home.path()).unwrap().execute("INSERT INTO sections(id,bot,owner_id,title,updated_at) VALUES('later-log','owl','alice',?,20.001)", [title]).unwrap();
                // This log is native-only. Its first open completes the import
                // before the human reply below; the older log stays legacy.
                let workspace = tempfile::tempdir().unwrap();
                runtime_store::import_hermes(home.path(), "owl", "later-log", workspace.path())
                    .unwrap();
                said(
                    home.path(),
                    "later-log",
                    json!({"role":"assistant","text":"Stored report","timestamp":1}),
                );
                if mixed {
                    said(
                        home.path(),
                        "later-log",
                        json!({"role":"user","text":"Old human reply","timestamp":2}),
                    );
                }
                said(
                    home.path(),
                    "later-log",
                    json!({"role":"assistant","text":"Stored report","timestamp":20}),
                );
                let before_lookup =
                    crate::dreaming::build_digest(home.path(), "owl", 0.0, f64::MAX, None)
                        .unwrap()
                        .to_string();
                assert!(!before_lookup.contains("Stored report"));
                assert_eq!(
                    chat_section(home.path(), "alice", "owl").unwrap()["id"],
                    "ordinary"
                );
                assert!(
                    runtime_store::dream_logs(home.path())
                        .unwrap()
                        .contains("later-log")
                );
                let history = runtime_store::history(home.path(), "later-log").unwrap();
                assert_eq!(history[0]["dream"], true);
                assert_eq!(history.last().unwrap()["dream"], true);
                let digest = crate::dreaming::build_digest(home.path(), "owl", 0.0, f64::MAX, None)
                    .unwrap()
                    .to_string();
                assert!(!digest.contains("Stored report"));
                assert_eq!(digest.contains("Old human reply"), mixed);
                one_chat_per_bot(home.path()).unwrap();
                assert_eq!(ids_of(home.path(), "owl"), ["later-log", "ordinary"]);
                assert!(
                    runtime_store::dream_logs(home.path())
                        .unwrap()
                        .contains("log")
                );
            }
        }
    }
    #[test]
    fn a_partial_log_classification_retries_without_losing_report_markers() {
        for failure in ["catalog", "projection"] {
            let home = tempfile::tempdir().unwrap();
            legacy_log(home.path(), "Initial notes", false, true);
            one_chat_per_bot(home.path()).unwrap();
            db::open(home.path()).unwrap().execute_batch("INSERT INTO sections(id,bot,owner_id,title,updated_at) VALUES('later-log','owl','alice','Renamed',20)").unwrap();
            said(
                home.path(),
                "later-log",
                json!({"role":"assistant","text":"Stored report","timestamp":20}),
            );
            let conn = if failure == "catalog" {
                db::open(home.path()).unwrap()
            } else {
                runtime_store::open(home.path()).unwrap()
            };
            conn.execute_batch(if failure == "catalog" {
                "CREATE TRIGGER refuse_classification BEFORE INSERT ON settings WHEN NEW.key='dream_logs' BEGIN SELECT RAISE(ABORT,'classification failed'); END;"
            } else {
                "CREATE TRIGGER refuse_classification BEFORE UPDATE ON native_messages BEGIN SELECT RAISE(ABORT,'marking failed'); END;"
            }).unwrap();
            assert!(classify_dream_logs(home.path(), "owl").is_err());
            assert_eq!(
                runtime_store::dream_logs(home.path())
                    .unwrap()
                    .contains("later-log"),
                failure == "projection"
            );
            assert_ne!(
                runtime_store::history(home.path(), "later-log").unwrap()[0]["dream"],
                true
            );
            conn.execute_batch("DROP TRIGGER refuse_classification")
                .unwrap();
            assert_eq!(
                chat_section(home.path(), "alice", "owl").unwrap()["id"],
                "ordinary"
            );
            assert!(
                runtime_store::dream_logs(home.path())
                    .unwrap()
                    .contains("later-log")
            );
            assert_eq!(
                runtime_store::history(home.path(), "later-log").unwrap()[0]["dream"],
                true
            );
            one_chat_per_bot(home.path()).unwrap();
            assert_eq!(ids_of(home.path(), "owl"), ["later-log", "ordinary"]);
        }
    }
    #[cfg(unix)]
    #[test]
    fn a_recreated_legacy_log_is_classified_after_permissions_are_repaired() {
        let home = tempfile::tempdir().unwrap();
        legacy_log(home.path(), "Initial notes", false, true);
        runtime_store::mark_fresh(home.path(), "ordinary").unwrap();
        one_chat_per_bot(home.path()).unwrap();
        db::open(home.path()).unwrap().execute_batch("INSERT INTO sections(id,bot,owner_id,title,updated_at) VALUES('later-log','owl','alice','Renamed',20.001)").unwrap();
        Connection::open(profile(home.path(), "owl").unwrap().join("state.db")).unwrap().execute_batch("INSERT INTO sessions(id,session_key) VALUES('later-log','later-log'); INSERT INTO messages(id,session_id,role,content,timestamp) VALUES(5,'later-log','assistant','Stored report',1),(6,'later-log','user','Keep this human reply',2),(7,'later-log','assistant','Stored report',20);").unwrap();
        let denied = RestorePermissions::deny(profile(home.path(), "owl").unwrap());
        assert!(classify_dream_logs(home.path(), "owl").is_err());
        assert!(crate::dreaming::build_digest(home.path(), "owl", 0.0, f64::MAX, None).is_err());
        assert!(
            !runtime_store::dream_logs(home.path())
                .unwrap()
                .contains("later-log")
        );
        assert_eq!(
            chat_section(home.path(), "alice", "owl").unwrap()["id"],
            "ordinary"
        );
        drop(denied);
        let digest = crate::dreaming::build_digest(home.path(), "owl", 0.0, f64::MAX, None)
            .unwrap()
            .to_string();
        assert!(digest.contains("Keep this human reply"));
        assert!(!digest.contains("Stored report"));
        assert!(
            runtime_store::dream_logs(home.path())
                .unwrap()
                .contains("later-log")
        );
        one_chat_per_bot(home.path()).unwrap();
        assert_eq!(ids_of(home.path(), "owl"), ["later-log", "ordinary"]);
    }
    #[test]
    fn a_legacy_dream_log_with_dialogue_is_a_chat_before_and_after_import() {
        for title in ["Dreams", "Night notes"] {
            let home = tempfile::tempdir().unwrap();
            legacy_log(home.path(), title, true, false);
            one_chat_per_bot(home.path()).unwrap();
            assert_eq!(ids_of(home.path(), "owl"), ["log"]);
            assert_eq!(
                chat_section(home.path(), "alice", "owl").unwrap()["id"],
                "log"
            );
            let digest = crate::dreaming::build_digest(home.path(), "owl", 0.0, f64::MAX, None)
                .unwrap()
                .to_string();
            assert!(digest.contains("Human question") && digest.contains("Actual reply"));
            assert!(!digest.contains("Stored report"));
            let dir = runtime_store::session_dir(home.path(), "log").unwrap();
            let workspace = tempfile::tempdir().unwrap();
            // A failed projection transaction leaves the legacy conversation
            // eligible; retry imports it with its report markers intact.
            runtime_store::open(home.path()).unwrap().execute_batch(
                "CREATE TRIGGER refuse_import BEFORE INSERT ON native_messages BEGIN SELECT RAISE(ABORT,'import failed'); END;",
            ).unwrap();
            assert!(
                runtime_store::import_hermes(home.path(), "owl", "log", workspace.path()).is_err()
            );
            assert_eq!(
                chat_section(home.path(), "alice", "owl").unwrap()["id"],
                "log"
            );
            runtime_store::open(home.path())
                .unwrap()
                .execute_batch("DROP TRIGGER refuse_import")
                .unwrap();
            runtime_store::import_hermes(home.path(), "owl", "log", workspace.path()).unwrap();
            let history = runtime_store::history(home.path(), "log").unwrap();
            assert_eq!(
                history
                    .iter()
                    .map(|m| (m["text"].as_str().unwrap(), m["dream"] == true))
                    .collect::<Vec<_>>(),
                [
                    ("Stored report", true),
                    ("Human question", false),
                    ("Actual reply", false)
                ]
            );
            let context = fs::read_to_string(dir.join("conversation.jsonl")).unwrap();
            assert!(context.contains("Actual reply"));
            assert!(!context.contains("Stored report"));
        }
    }
    #[test]
    fn persisting_an_older_chat_selection_survives_upgrade_without_a_message() {
        for mixed_log in [false, true] {
            for archived in [false, true] {
                let home = tempfile::tempdir().unwrap();
                legacy_log(home.path(), "Night notes", mixed_log, true);
                if !mixed_log {
                    Connection::open(profile(home.path(), "owl").unwrap().join("state.db")).unwrap().execute_batch(
                        "DELETE FROM messages; INSERT INTO messages(id,session_id,role,content,timestamp) VALUES(1,'log','user','Ordinary older chat',2);",
                    ).unwrap();
                }
                if archived {
                    db::open(home.path())
                        .unwrap()
                        .execute("UPDATE sections SET archived_at=3 WHERE id='log'", [])
                        .unwrap();
                }
                // This exact RPC and SQL also exist on the pre-feature main.
                let selected = call(
                    home.path(),
                    "alice",
                    "hexbot.sections.unarchive",
                    &json!({"id":"log"}),
                )
                .unwrap()
                .unwrap();
                assert!(selected["section"]["updated_at"].as_f64().unwrap() > 9.0);
                assert_eq!(selected["section"]["title"], "Night notes");
                one_chat_per_bot(home.path()).unwrap();
                assert_eq!(ids_of(home.path(), "owl"), ["log"]);
                assert_eq!(
                    chat_section(home.path(), "alice", "owl").unwrap()["id"],
                    "log"
                );
            }
        }
    }
    #[test]
    fn legacy_report_only_logs_yield_but_real_dialogue_competes_by_recency() {
        for dialogue in [false, true] {
            let home = tempfile::tempdir().unwrap();
            legacy_log(home.path(), "Night notes", dialogue, true);
            one_chat_per_bot(home.path()).unwrap();
            assert_eq!(ids_of(home.path(), "owl"), ["ordinary"]);
        }
        let home = tempfile::tempdir().unwrap();
        legacy_log(home.path(), "Night notes", false, false);
        one_chat_per_bot(home.path()).unwrap();
        assert!(ids_of(home.path(), "owl").is_empty());
        assert_ne!(
            chat_section(home.path(), "alice", "owl").unwrap()["id"],
            "log"
        );
        // A title alone is insufficient evidence that the assistant's text is a report.
        let home = tempfile::tempdir().unwrap();
        legacy_log(home.path(), "Dreams", true, false);
        db::open(home.path())
            .unwrap()
            .execute("DELETE FROM dreams", [])
            .unwrap();
        one_chat_per_bot(home.path()).unwrap();
        assert_eq!(ids_of(home.path(), "owl"), ["log"]);
    }
    #[test]
    fn legacy_dialogue_counts_even_when_a_native_report_precedes_import() {
        let home = tempfile::tempdir().unwrap();
        legacy_log(home.path(), "Night notes", true, true);
        said(
            home.path(),
            "log",
            json!({"role":"assistant","text":"Another report","dream":true,"timestamp":8}),
        );
        call(
            home.path(),
            "alice",
            "hexbot.sections.unarchive",
            &json!({"id":"log"}),
        )
        .unwrap()
        .unwrap();
        one_chat_per_bot(home.path()).unwrap();
        // A later native report and a chooser selection both update the same
        // timestamp. Preserve both chats when that old choice is ambiguous.
        assert_eq!(ids_of(home.path(), "owl"), ["log", "ordinary"]);
        assert_eq!(
            chat_section(home.path(), "alice", "owl").unwrap()["id"],
            "ordinary"
        );
        let workspace = tempfile::tempdir().unwrap();
        runtime_store::import_hermes(home.path(), "owl", "log", workspace.path()).unwrap();
        let history = runtime_store::history(home.path(), "log").unwrap();
        assert_eq!(history.iter().filter(|m| m["dream"] == true).count(), 2);
        assert!(history.iter().any(|m| m["text"] == "Human question"));
        assert!(history.iter().any(|m| m["text"] == "Actual reply"));
        let digest = crate::dreaming::build_digest(home.path(), "owl", 0.0, f64::MAX, None)
            .unwrap()
            .to_string();
        assert!(digest.contains("Human question") && digest.contains("Actual reply"));
        assert!(!digest.contains("Stored report") && !digest.contains("Another report"));
    }
    #[test]
    fn a_delete_that_fails_keeps_the_rest_for_good() {
        let home = tempfile::tempdir().unwrap();
        db::migrate(home.path()).unwrap();
        owl_with_four_conversations(home.path());
        db::open(home.path())
            .unwrap()
            .execute_batch(
                "CREATE TRIGGER stuck BEFORE DELETE ON sections WHEN OLD.id='stuck' BEGIN SELECT RAISE(ABORT,'stuck'); END;",
            )
            .unwrap();
        one_chat_per_bot(home.path()).unwrap();
        let backups = || fs::read_dir(home.path().join("backups")).unwrap().count();
        assert_eq!(backups(), 1);
        // Newest first: Mid went, Stuck could not, Old was never tried.
        assert_eq!(ids_of(home.path(), "owl"), ["new", "old", "stuck"]);
        // What could not be deleted is whole and opens.
        for id in ["stuck", "old"] {
            assert_eq!(
                runtime_store::history(home.path(), id).unwrap()[0]["text"],
                format!("In {id}")
            );
            runtime_store::session_dir(home.path(), id).unwrap();
        }
        assert_eq!(
            chat_section(home.path(), "alice", "owl").unwrap()["id"],
            "new"
        );
        one_chat_per_bot(home.path()).unwrap();
        assert_eq!(backups(), 1);
        assert_eq!(ids_of(home.path(), "owl"), ["new", "old", "stuck"]);
    }
    #[cfg(unix)]
    #[test]
    fn history_a_delete_could_not_remove_goes_at_the_next_start() {
        use std::os::unix::fs::PermissionsExt;
        let home = tempfile::tempdir().unwrap();
        db::migrate(home.path()).unwrap();
        owl_with_four_conversations(home.path());
        // A folder the copy can read but the delete cannot empty.
        let stuck = home.path().join("runtime/sessions/stuck/files");
        fs::create_dir_all(&stuck).unwrap();
        fs::write(stuck.join("file.txt"), "kept").unwrap();
        fs::set_permissions(&stuck, fs::Permissions::from_mode(0o500)).unwrap();
        if fs::write(stuck.join("probe"), "").is_ok() {
            // Running as root writes anywhere.
            return;
        }
        one_chat_per_bot(home.path()).unwrap();
        fs::set_permissions(&stuck, fs::Permissions::from_mode(0o700)).unwrap();
        // Stuck's catalog delete committed, but cleanup stops the migration.
        assert_eq!(ids_of(home.path(), "owl"), ["new", "old"]);
        assert!(
            runtime_store::history(home.path(), "stuck")
                .unwrap()
                .is_empty()
        );
        assert!(stuck.exists());
        runtime_store::finish_deletes(home.path()).unwrap();
        assert!(!home.path().join("runtime/sessions/stuck").exists());
        one_chat_per_bot(home.path()).unwrap();
        assert_eq!(ids_of(home.path(), "owl"), ["new", "old"]);
        assert_eq!(
            runtime_store::history(home.path(), "new").unwrap()[0]["text"],
            "In new"
        );
    }
    #[test]
    fn a_stop_part_way_through_a_delete_never_leaves_a_broken_section() {
        let home = tempfile::tempdir().unwrap();
        db::migrate(home.path()).unwrap();
        owl_with_four_conversations(home.path());
        fs::create_dir_all(home.path().join("runtime/sessions/mid")).unwrap();
        // Stopped after the tombstone, before the catalog row went.
        runtime_store::mark_deleted(home.path(), "stuck").unwrap();
        // Stopped after the catalog row went, before the history.
        runtime_store::mark_deleted(home.path(), "mid").unwrap();
        db::open(home.path())
            .unwrap()
            .execute("DELETE FROM sections WHERE id='mid'", [])
            .unwrap();
        runtime_store::finish_deletes(home.path()).unwrap();
        assert_eq!(ids_of(home.path(), "owl"), ["new", "old", "stuck"]);
        runtime_store::session_dir(home.path(), "stuck").unwrap();
        assert_eq!(
            runtime_store::history(home.path(), "stuck").unwrap()[0]["text"],
            "In stuck"
        );
        assert!(
            runtime_store::history(home.path(), "mid")
                .unwrap()
                .is_empty()
        );
        assert!(!home.path().join("runtime/sessions/mid").exists());
        assert_eq!(
            runtime_store::session_dir(home.path(), "mid")
                .unwrap_err()
                .code,
            4001
        );
    }
    #[test]
    fn a_reply_that_reads_like_a_dream_report_stays_the_bots() {
        let home = tempfile::tempdir().unwrap();
        db::migrate(home.path()).unwrap();
        db::open(home.path())
            .unwrap()
            .execute_batch(
                "INSERT INTO users(id,display_name,role,created_at) VALUES('alice','Alice','admin',0);
                 INSERT INTO bots(name,owner_id) VALUES('owl','alice');
                 INSERT INTO sections(id,bot,owner_id,title,updated_at) VALUES('chat','owl','alice','Chat',2);
                 INSERT INTO dreams(id,bot,started_at,status,summary) VALUES('d1','owl',1,'complete','Owl learned');",
            )
            .unwrap();
        // Never opened since the native daemon; the bot's reply repeats a report.
        let owl = home.path().join("profiles/owl");
        fs::create_dir_all(&owl).unwrap();
        Connection::open(owl.join("state.db"))
            .unwrap()
            .execute_batch(
                "CREATE TABLE sessions(id TEXT,session_key TEXT,parent_session_id TEXT,model_config TEXT,source TEXT);
                 CREATE TABLE messages(id INTEGER,session_id TEXT,role TEXT,content TEXT,timestamp REAL);
                 INSERT INTO sessions(id,session_key) VALUES('chat','chat');
                 INSERT INTO messages VALUES(1,'chat','user','What did you learn?',1),(2,'chat','assistant','Owl learned',1.5);",
            )
            .unwrap();
        one_chat_per_bot(home.path()).unwrap();
        let workspace = tempfile::tempdir().unwrap();
        runtime_store::import_hermes(home.path(), "owl", "chat", workspace.path()).unwrap();
        let history = runtime_store::history(home.path(), "chat").unwrap();
        assert!(history.iter().all(|m| m["dream"].is_null()), "{history:?}");
        let context =
            fs::read_to_string(home.path().join("runtime/sessions/chat/conversation.jsonl"))
                .unwrap();
        assert!(context.contains("Owl learned"));
    }
    #[test]
    fn kickoff_keeps_marker_and_name_shaped_questions() {
        let prompt = kickoff_prompt(
            &json!({"display_name":"Research","description":"Read papers","title":"Science"}),
        );
        assert!(prompt.starts_with("You were just created and named \"Research\"."));
        assert!(prompt.contains("Science. Read papers"));
        assert!(prompt.contains("Three questions at most"));
        assert!(prompt.contains("hexbot_soul"));
        assert!(prompt.contains("memory tool"));
        assert!(kickoff_prompt(&json!({})).contains("\"this bot\""));
    }
}
