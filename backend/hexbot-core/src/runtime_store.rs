//! Durable chat projection and usage, separate from the backwards-compatible Hexbot database.
use crate::{
    Result,
    common::{self, id},
};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock, RwLock, RwLockReadGuard, RwLockWriteGuard, Weak},
    time::Duration,
};

/// One boundary per store, including every delegated source. Product work is
/// synchronous and shares the read side; tombstoning waits for it to finish.
/// Take this before any database transaction or skills/config/todo lock. Never
/// hold it over an await, approval, Python kernel or ordinary async tool.
fn product_boundary(home: &Path) -> Result<Arc<RwLock<()>>> {
    static LOCKS: OnceLock<Mutex<HashMap<PathBuf, Weak<RwLock<()>>>>> = OnceLock::new();
    let home = fs::canonicalize(home)?;
    let mut locks = LOCKS.get_or_init(Default::default).lock().unwrap();
    locks.retain(|_, lock| lock.strong_count() > 0);
    if let Some(lock) = locks.get(&home).and_then(Weak::upgrade) {
        return Ok(lock);
    }
    let lock = Arc::new(RwLock::new(()));
    locks.insert(home, Arc::downgrade(&lock));
    Ok(lock)
}

pub(crate) fn with_product_tool<T>(home: &Path, work: impl FnOnce() -> Result<T>) -> Result<T> {
    let boundary = product_boundary(home)?;
    let _guard: RwLockReadGuard<'_, ()> = boundary
        .read()
        .map_err(|_| crate::Error::new(5200, "product tool boundary unavailable"))?;
    work()
}

pub(crate) fn with_tombstone<T>(home: &Path, work: impl FnOnce() -> Result<T>) -> Result<T> {
    let boundary = product_boundary(home)?;
    #[cfg(test)]
    if matches!(
        boundary.try_write(),
        Err(std::sync::TryLockError::WouldBlock)
    ) {
        crate::native_product_tools::deletion_tests::deletion_waiting(home);
    }
    let _guard: RwLockWriteGuard<'_, ()> = boundary
        .write()
        .map_err(|_| crate::Error::new(5200, "product tool boundary unavailable"))?;
    work()
}

pub fn open(home: &Path) -> Result<Connection> {
    fs::create_dir_all(home)?;
    let conn = Connection::open(home.join("hexbot-runtime.db"))?;
    conn.busy_timeout(Duration::from_secs(5))?;
    conn.execute_batch(
        "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS native_sessions(stored_id TEXT PRIMARY KEY,owner TEXT NOT NULL,bot TEXT NOT NULL,prompt TEXT NOT NULL,options TEXT NOT NULL DEFAULT '{}');
      CREATE TABLE IF NOT EXISTS native_live_sessions(stored_id TEXT PRIMARY KEY REFERENCES native_sessions(stored_id) ON DELETE CASCADE,live_id TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS native_messages(session_id TEXT NOT NULL,seq INTEGER NOT NULL,message_json TEXT NOT NULL,PRIMARY KEY(session_id,seq));
      CREATE TABLE IF NOT EXISTS native_usage(id INTEGER PRIMARY KEY,session_id TEXT NOT NULL,owner_id TEXT NOT NULL,bot TEXT NOT NULL,model TEXT NOT NULL,provider TEXT NOT NULL,input_tokens INTEGER NOT NULL,output_tokens INTEGER NOT NULL,cache_read_tokens INTEGER NOT NULL,cache_write_tokens INTEGER NOT NULL,cost REAL NOT NULL,timestamp REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS native_pi_journal(journal_id TEXT PRIMARY KEY,session_id TEXT NOT NULL,raw_json TEXT NOT NULL,entry_id TEXT,projection_seq INTEGER,usage_id INTEGER UNIQUE,active INTEGER NOT NULL DEFAULT 1,UNIQUE(session_id,entry_id));
      CREATE INDEX IF NOT EXISTS idx_native_pi_journal_session ON native_pi_journal(session_id);
      CREATE INDEX IF NOT EXISTS idx_native_pi_journal_projection ON native_pi_journal(session_id,projection_seq);
      CREATE TABLE IF NOT EXISTS native_prompt_intents(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,text TEXT NOT NULL,display_kind TEXT NOT NULL,created_at REAL NOT NULL,consumed_by TEXT);
      CREATE INDEX IF NOT EXISTS idx_native_prompt_intents_session ON native_prompt_intents(session_id,consumed_by);
      CREATE TABLE IF NOT EXISTS native_summaries(session_id TEXT PRIMARY KEY, message_count INTEGER NOT NULL, preview TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS native_deleted(session_id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS native_delete_options(session_id TEXT PRIMARY KEY REFERENCES native_deleted(session_id) ON DELETE CASCADE,bot TEXT NOT NULL,owner TEXT NOT NULL,purge INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS native_delete_pending(session_id TEXT PRIMARY KEY REFERENCES native_deleted(session_id) ON DELETE CASCADE,root_id TEXT NOT NULL,cataloged INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS native_delete_claims(attempt TEXT NOT NULL,session_id TEXT NOT NULL REFERENCES native_delete_pending(session_id) ON DELETE CASCADE,PRIMARY KEY(attempt,session_id));
      CREATE TABLE IF NOT EXISTS native_delete_completed(session_id TEXT PRIMARY KEY REFERENCES native_deleted(session_id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS native_delete_legacy(session_id TEXT NOT NULL REFERENCES native_delete_options(session_id) ON DELETE CASCADE,legacy_id TEXT NOT NULL,PRIMARY KEY(session_id,legacy_id));
      CREATE TABLE IF NOT EXISTS native_quarantine(session_id TEXT PRIMARY KEY, error TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS native_unrecovered(session_id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS native_fresh(session_id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS native_pending_chat_forks(target TEXT PRIMARY KEY,source TEXT NOT NULL,bot TEXT NOT NULL,owner TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS summary_session_insert AFTER INSERT ON native_sessions BEGIN DELETE FROM native_summaries WHERE session_id=NEW.stored_id; END;
      CREATE TRIGGER IF NOT EXISTS summary_journal_insert AFTER INSERT ON native_pi_journal BEGIN DELETE FROM native_summaries WHERE session_id=NEW.session_id; END;
      CREATE TRIGGER IF NOT EXISTS summary_message_insert AFTER INSERT ON native_messages BEGIN DELETE FROM native_summaries WHERE session_id=NEW.session_id; END;
      CREATE TRIGGER IF NOT EXISTS summary_message_update AFTER UPDATE ON native_messages BEGIN DELETE FROM native_summaries WHERE session_id=NEW.session_id; END;
      CREATE TRIGGER IF NOT EXISTS summary_message_delete AFTER DELETE ON native_messages BEGIN DELETE FROM native_summaries WHERE session_id=OLD.session_id; END;
      CREATE TRIGGER IF NOT EXISTS summary_journal_update AFTER UPDATE ON native_pi_journal BEGIN DELETE FROM native_summaries WHERE session_id=NEW.session_id; END;
      CREATE TABLE IF NOT EXISTS native_history_versions(session_id TEXT PRIMARY KEY, version INTEGER NOT NULL);
      CREATE TRIGGER IF NOT EXISTS history_message_insert AFTER INSERT ON native_messages BEGIN INSERT INTO native_history_versions VALUES(NEW.session_id,1) ON CONFLICT(session_id) DO UPDATE SET version=version+1; END;
      CREATE TRIGGER IF NOT EXISTS history_message_update AFTER UPDATE ON native_messages BEGIN INSERT INTO native_history_versions VALUES(NEW.session_id,1) ON CONFLICT(session_id) DO UPDATE SET version=version+1; END;
      CREATE TRIGGER IF NOT EXISTS history_message_delete AFTER DELETE ON native_messages BEGIN INSERT INTO native_history_versions VALUES(OLD.session_id,1) ON CONFLICT(session_id) DO UPDATE SET version=version+1; END;
      CREATE TRIGGER IF NOT EXISTS history_journal_insert AFTER INSERT ON native_pi_journal WHEN NEW.projection_seq IS NOT NULL BEGIN INSERT INTO native_history_versions VALUES(NEW.session_id,1) ON CONFLICT(session_id) DO UPDATE SET version=version+1; END;
      CREATE TRIGGER IF NOT EXISTS history_journal_update AFTER UPDATE OF active,projection_seq ON native_pi_journal WHEN OLD.active IS NOT NEW.active OR OLD.projection_seq IS NOT NEW.projection_seq BEGIN INSERT INTO native_history_versions VALUES(NEW.session_id,1) ON CONFLICT(session_id) DO UPDATE SET version=version+1; END;
      CREATE TRIGGER IF NOT EXISTS history_journal_delete AFTER DELETE ON native_pi_journal WHEN OLD.projection_seq IS NOT NULL BEGIN INSERT INTO native_history_versions VALUES(OLD.session_id,1) ON CONFLICT(session_id) DO UPDATE SET version=version+1; END;",
    )?;
    crate::db::migrate_runtime(&conn)?;
    Ok(conn)
}
pub fn history(home: &Path, stored: &str) -> Result<Vec<Value>> {
    let conn = open(home)?;
    let mut stmt = conn.prepare(
        "SELECT m.message_json FROM native_messages m LEFT JOIN native_pi_journal p ON p.session_id=m.session_id AND p.projection_seq=m.seq WHERE m.session_id=? AND (p.active IS NULL OR p.active=1) ORDER BY m.seq",
    )?;
    let rows = stmt.query_map([stored], |r| r.get::<_, String>(0))?;
    rows.map(|r| {
        let s = r?;
        serde_json::from_str(&s).map_err(|e| crate::Error::new(5200, e.to_string()))
    })
    .collect()
}
/// Stream visible owner evidence, newest first. Stops before allocating an
/// oversized row, or when the caller's serialized request is full; either way
/// the result is false and the older messages are left out.
pub(crate) fn user_history(
    home: &Path,
    stored: &str,
    row_bytes: usize,
    mut visit: impl FnMut(Value) -> Result<bool>,
) -> Result<bool> {
    let conn = open(home)?;
    let mut stmt = conn.prepare(
        "SELECT CASE WHEN octet_length(m.message_json)<=?2 THEN m.message_json END
         FROM native_messages m LEFT JOIN native_pi_journal p ON p.session_id=m.session_id AND p.projection_seq=m.seq
         WHERE m.session_id=?1 AND (p.active IS NULL OR p.active=1)
         AND CASE WHEN octet_length(m.message_json)>?2 THEN 1 ELSE
             json_extract(m.message_json,'$.role')='user'
             AND json_extract(m.message_json,'$.display_kind') IS NOT 'hidden'
             AND json_extract(m.message_json,'$.custom_type') IS NULL END ORDER BY m.seq DESC",
    )?;
    let mut rows = stmt.query(params![stored, row_bytes])?;
    while let Some(row) = rows.next()? {
        // Size is checked before JSON parsing, including for non-owner rows:
        // an oversized row and everything older count as left out.
        let Some(raw) = row.get::<_, Option<String>>(0)? else {
            return Ok(false);
        };
        let message =
            serde_json::from_str(&raw).map_err(|e| crate::Error::new(5200, e.to_string()))?;
        if !visit(message)? {
            return Ok(false);
        }
    }
    Ok(true)
}
/// A counter the triggers bump whenever a session's displayed history can change:
/// a message row, or the journal link that orders it or hides it on another branch.
/// History search compares it to skip sections it already indexed. A version only
/// grows; the row goes only with `delete`, which tombstones the session, so a
/// session without one has never been written or is gone for good.
pub fn history_version(conn: &Connection, stored: &str) -> Result<i64> {
    Ok(conn
        .query_row(
            "SELECT version FROM native_history_versions WHERE session_id=?",
            [stored],
            |r| r.get(0),
        )
        .optional()?
        .unwrap_or(0))
}
pub fn append(home: &Path, stored: &str, mut message: Value) -> Result<()> {
    let mut conn = open(home)?;
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    check_deleted(&tx, stored)?;
    if message.get("timestamp").is_none() {
        message["timestamp"] = json!(common::now());
    }
    if message.get("row_id").is_none() {
        message["row_id"] = json!(id());
    }
    tx.execute(
        "INSERT INTO native_messages(session_id,seq,message_json) SELECT ?1,COALESCE(MAX(seq),0)+1,?2 FROM native_messages WHERE session_id=?1",
        params![stored, message.to_string()],
    )?;
    tx.commit()?;
    Ok(())
}
pub fn preview(text: &str) -> String {
    let mut chars = text.chars();
    let mut result = chars.by_ref().take(60).collect::<String>();
    if chars.next().is_some() {
        result.push_str("...");
    }
    result
}
pub fn summary(home: &Path, stored: &str) -> Result<Value> {
    let mut conn = open(home)?;
    let cached = |conn: &Connection| -> Result<Option<(i64, String)>> {
        Ok(conn
            .query_row(
                "SELECT message_count,preview FROM native_summaries WHERE session_id=?",
                [stored],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?)
    };
    // The section list reads every summary; only a miss needs the write lock.
    // The preview is the latest message either side said, as a chat list shows.
    if let Some((count, preview)) = cached(&conn)? {
        return Ok(json!({"preview":preview,"message_count":count}));
    }
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let (count, preview) = if let Some(cached) = cached(&tx)? {
        cached
    } else {
        let count: i64 = tx.query_row(
            "SELECT COUNT(*) FROM native_messages m LEFT JOIN native_pi_journal p ON p.session_id=m.session_id AND p.projection_seq=m.seq WHERE m.session_id=? AND (p.active IS NULL OR p.active=1)",
            [stored],
            |r| r.get(0),
        )?;
        let text: String = tx
            .query_row(
                "SELECT COALESCE(json_extract(m.message_json,'$.text'),'') FROM native_messages m LEFT JOIN native_pi_journal p ON p.session_id=m.session_id AND p.projection_seq=m.seq WHERE m.session_id=? AND (p.active IS NULL OR p.active=1) AND json_extract(m.message_json,'$.role') IN ('user','assistant') AND COALESCE(json_extract(m.message_json,'$.display_kind'),'normal')<>'hidden' AND COALESCE(json_extract(m.message_json,'$.text'),'')<>'' ORDER BY m.seq DESC LIMIT 1",
                [stored],
                |r| r.get(0),
            )
            .optional()?
            .unwrap_or_default();
        let preview = preview(&text);
        tx.execute(
            "INSERT INTO native_summaries VALUES(?,?,?)",
            params![stored, count, preview],
        )?;
        (count, preview)
    };
    tx.commit()?;
    Ok(json!({"preview":preview,"message_count":count}))
}
pub fn descendants(home: &Path, stored: &str) -> Result<Vec<String>> {
    descendant_ids(&open(home)?, stored)
}
fn descendant_ids(conn: &Connection, stored: &str) -> Result<Vec<String>> {
    common::rows(
        conn,
        "WITH RECURSIVE tree(id) AS (SELECT ?1 UNION SELECT s.stored_id FROM native_sessions s JOIN tree t ON json_extract(s.options,'$.parent_session')=t.id) SELECT id FROM tree",
        &[&stored],
    )?
    .into_iter()
    .map(|row| common::required(&row, "id").map(str::to_owned))
    .collect()
}
fn deletion_owner(conn: &Connection, stored: &str) -> Result<Option<(String, String)>> {
    Ok(conn.query_row(
        "SELECT bot,owner FROM native_sessions WHERE stored_id=?1 UNION SELECT bot,owner FROM native_delete_options WHERE session_id=?1 LIMIT 1",
        [stored], |r| Ok((r.get::<_, String>(0)?,r.get::<_, String>(1)?)),
    ).optional()?)
}
fn owned_deletion_targets(
    conn: &Connection,
    stored: &str,
    bot: &str,
    owner: &str,
) -> Result<Vec<String>> {
    let foreign: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM native_sessions WHERE stored_id=?1 AND (bot<>?2 OR owner<>?3)) OR EXISTS(SELECT 1 FROM native_delete_options WHERE session_id=?1 AND (bot<>?2 OR owner<>?3))", params![stored,bot,owner], |r| r.get(0))?;
    if foreign {
        return Err(crate::Error::new(
            4302,
            "history belongs to another bot or owner",
        ));
    }
    common::rows(conn,
        "WITH RECURSIVE tree(id) AS (SELECT ?1 UNION SELECT s.stored_id FROM native_sessions s JOIN tree t ON json_extract(s.options,'$.parent_session')=t.id WHERE s.bot=?2 AND s.owner=?3 AND NOT EXISTS(SELECT 1 FROM native_delete_options o WHERE o.session_id=s.stored_id AND (o.bot<>?2 OR o.owner<>?3))) SELECT id FROM tree",
        &[&stored,&bot,&owner])?.into_iter().map(|row| common::required(&row,"id").map(str::to_owned)).collect()
}
/// Explicit storage deletion and genuinely ownerless old tombstones retain
/// their native-only traversal. Catalog retirement must never use that fallback.
fn deletion_targets(conn: &Connection, stored: &str) -> Result<Vec<String>> {
    let ownership = deletion_owner(conn, stored)?;
    let Some((bot, owner)) = ownership else {
        return descendant_ids(conn, stored);
    };
    owned_deletion_targets(conn, stored, &bot, &owner)
}
fn retirement_targets(home: &Path, conn: &Connection, stored: &str) -> Result<Vec<String>> {
    let ownership = crate::db::open(home)?.query_row(
        "SELECT bot,owner_id FROM sections WHERE id=?1 UNION SELECT s.bot,r.owner_id FROM room_sessions s JOIN rooms r ON r.id=s.room_id JOIN bots b ON b.name=s.bot AND b.owner_id=r.owner_id WHERE s.stored_session_id=?1 LIMIT 1",
        [stored], |r| Ok((r.get::<_, String>(0)?,r.get::<_, String>(1)?)),
    ).optional()?.or(deletion_owner(conn, stored)?);
    match ownership {
        Some((bot, owner)) => owned_deletion_targets(conn, stored, &bot, &owner),
        None => Ok(vec![stored.to_owned()]),
    }
}
pub(crate) fn retiring_descendants(home: &Path, stored: &str) -> Result<Vec<String>> {
    retirement_targets(home, &open(home)?, stored)
}
fn mark_targets(
    conn: &Connection,
    stored: &str,
    cataloged: bool,
    targets: Vec<String>,
) -> Result<Vec<String>> {
    for target in &targets {
        common::identifier(target)?;
        if delete_completed(conn, target)? {
            continue;
        }
        if conn.execute("INSERT OR IGNORE INTO native_deleted VALUES(?)", [target])? > 0 {
            conn.execute(
                "INSERT INTO native_delete_pending VALUES(?,?,?)",
                params![target, stored, cataloged],
            )?;
        }
        // Keep ownership after native_sessions and the catalog row have gone,
        // including when removing the session directory failed.
        conn.execute(
            "INSERT OR IGNORE INTO native_delete_options SELECT stored_id,bot,owner,1 FROM native_sessions WHERE stored_id=? AND EXISTS(SELECT 1 FROM native_delete_pending WHERE session_id=stored_id)",
            [target],
        )?;
    }
    Ok(targets)
}
/// A retirement can release only its own claims on provisional markers.
/// Committing a deletion removes those claims, so a late rollback is harmless.
#[derive(Debug)]
pub(crate) struct Retirement {
    pub(crate) targets: Vec<String>,
    attempt: String,
}
fn claim_retirement(conn: &Connection, targets: Vec<String>) -> Result<Retirement> {
    let attempt = id();
    for target in &targets {
        conn.execute("INSERT INTO native_delete_claims SELECT ?1,session_id FROM native_delete_pending WHERE session_id=?2", params![attempt, target])?;
    }
    Ok(Retirement { targets, attempt })
}
// native_delete_pending.cataloged identifies the catalog decision: 0 is an
// uncataloged source, 1 a section, 2 a room. Existing 0/1 rows keep their meaning.
struct CatalogIds {
    sections: HashSet<String>,
    rooms: HashSet<String>,
}
impl CatalogIds {
    fn contains(&self, stored: &str) -> bool {
        self.sections.contains(stored)
    }
    fn root_exists(&self, root: &str, cataloged: i64) -> bool {
        match cataloged {
            1 => self.sections.contains(root),
            2 => self.rooms.contains(root),
            _ => false,
        }
    }
}
fn catalog_ids(home: &Path) -> Result<CatalogIds> {
    let conn = crate::db::open(home)?;
    Ok(CatalogIds {
        sections: conn
            .prepare("SELECT id FROM sections")?
            .query_map([], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?,
        rooms: conn
            .prepare("SELECT id FROM rooms")?
            .query_map([], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?,
    })
}
/// Builds before retention wrote only native_deleted: no pending root,
/// retention choice or completion records which decision a marker belongs to.
fn unrecorded(id: &str) -> String {
    format!(
        "NOT EXISTS(SELECT 1 FROM native_delete_pending WHERE session_id={id}) AND NOT EXISTS(SELECT 1 FROM native_delete_options WHERE session_id={id}) AND NOT EXISTS(SELECT 1 FROM native_delete_completed WHERE session_id={id})"
    )
}
/// Only a surviving catalog root or an exact uncommitted bot journal can
/// justify rolling back an old marker. Recorded decisions and foreign branches
/// stop traversal, preserving their independently committed deletion.
fn reopen_unrecorded(
    conn: &Connection,
    root: &str,
    bot: &str,
    owner: &str,
    protected: &BTreeSet<String>,
) -> Result<()> {
    if protected.contains(root) {
        return Ok(());
    }
    let ids = conn
        .prepare(&format!("WITH RECURSIVE tree(id) AS (
            SELECT ?1 WHERE EXISTS(SELECT 1 FROM native_deleted WHERE session_id=?1) AND {} AND NOT EXISTS(SELECT 1 FROM native_sessions WHERE stored_id=?1 AND (bot<>?2 OR owner<>?3))
            UNION SELECT s.stored_id FROM native_sessions s JOIN tree t ON json_extract(s.options,'$.parent_session')=t.id
            WHERE s.bot=?2 AND s.owner=?3 AND {}) SELECT id FROM tree", unrecorded("?1"), unrecorded("s.stored_id")))?
        .query_map(params![root, bot, owner], |r| r.get(0))?
        .collect::<rusqlite::Result<Vec<String>>>()?;
    for id in ids.iter().filter(|id| !protected.contains(*id)) {
        conn.execute("DELETE FROM native_deleted WHERE session_id=?", [id])?;
    }
    Ok(())
}
/// Old retirement was provisional while its section or owned room mapping
/// survived. Rows are (id, bot, owner); recorded decisions take precedence.
fn surviving_roots(home: &Path) -> Result<Vec<(String, String, String)>> {
    Ok(crate::db::open(home)?
        .prepare("SELECT id,bot,owner_id FROM sections UNION SELECT s.stored_session_id,s.bot,r.owner_id FROM room_sessions s JOIN rooms r ON r.id=s.room_id JOIN bots b ON b.name=s.bot AND b.owner_id=r.owner_id")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<rusqlite::Result<_>>()?)
}
pub fn mark_deleted(home: &Path, stored: &str) -> Result<Vec<String>> {
    with_tombstone(home, || {
        let listed = catalog_ids(home)?;
        let mut conn = open(home)?;
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let targets = mark_targets(
            &tx,
            stored,
            listed.contains(stored),
            deletion_targets(&tx, stored)?,
        )?;
        tx.commit()?;
        Ok(targets)
    })
}
pub(crate) fn mark_retiring(home: &Path, stored: &str) -> Result<Retirement> {
    with_tombstone(home, || {
        let listed = catalog_ids(home)?;
        let mut conn = open(home)?;
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let targets = mark_targets(
            &tx,
            stored,
            listed.contains(stored),
            retirement_targets(home, &tx, stored)?,
        )?;
        let retirement = claim_retirement(&tx, targets)?;
        tx.commit()?;
        Ok(retirement)
    })
}
pub(crate) fn mark_room_retiring(home: &Path, stored: &str, room: &str) -> Result<Retirement> {
    with_tombstone(home, || {
        let mut conn = open(home)?;
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let targets = mark_targets(&tx, stored, false, retirement_targets(home, &tx, stored)?)?;
        for target in &targets {
            tx.execute("UPDATE native_delete_pending SET root_id=?,cataloged=2 WHERE session_id=? AND cataloged=0 AND root_id=?", params![room,target,stored])?;
        }
        let retirement = claim_retirement(&tx, targets)?;
        tx.commit()?;
        Ok(retirement)
    })
}
fn release_retirement(
    conn: &Connection,
    retirement: &Retirement,
    listed: &CatalogIds,
    protected: &BTreeSet<String>,
) -> Result<()> {
    conn.execute(
        "DELETE FROM native_delete_claims WHERE attempt=?",
        [&retirement.attempt],
    )?;
    for target in &retirement.targets {
        if protected.contains(target) {
            continue;
        }
        let pending = conn.query_row("SELECT root_id,cataloged FROM native_delete_pending WHERE session_id=? AND NOT EXISTS(SELECT 1 FROM native_delete_claims WHERE session_id=?1)", [target], |r| Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?))).optional()?;
        if let Some((root, cataloged)) = pending
            && (cataloged == 0 || listed.root_exists(&root, cataloged))
        {
            conn.execute("DELETE FROM native_deleted WHERE session_id=?", [target])?;
        }
    }
    Ok(())
}
pub(crate) fn rollback_retiring(home: &Path, retirement: &Retirement) -> Result<()> {
    // Releasing a claim never creates a tombstone or changes disposition. The
    // native transaction serializes it with claim acquisition and completion;
    // taking the product gate here could stall a failed caller behind another
    // deletion that is waiting for the same catalog writer.
    let listed = catalog_ids(home)?;
    let mut conn = open(home)?;
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    release_retirement(
        &tx,
        retirement,
        &listed,
        &crate::catalog::pending_bot_delete_targets(home)?,
    )?;
    tx.commit()?;
    Ok(())
}

/// The catalog journal persists this attempt before native retirement starts.
/// Callers already hold the product boundary, before either database writer.
pub(crate) fn mark_bot_retiring(
    home: &Path,
    bot: &str,
    targets: &[Value],
    attempt: &str,
) -> Result<()> {
    let listed = catalog_ids(home)?;
    let mut conn = open(home)?;
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    for target in targets {
        let stored = common::required(target, "id")?;
        let owned = owned_deletion_targets(&tx, stored, bot, common::required(target, "owner")?)?;
        for id in mark_targets(&tx, stored, listed.contains(stored), owned)? {
            tx.execute("INSERT OR IGNORE INTO native_delete_claims SELECT ?1,session_id FROM native_delete_pending WHERE session_id=?2", params![attempt,id])?;
        }
    }
    tx.commit()?;
    Ok(())
}

pub(crate) fn rollback_bot_retiring(
    home: &Path,
    bot: &str,
    targets: &[Value],
    attempt: Option<&str>,
    recovering: bool,
) -> Result<()> {
    let listed = catalog_ids(home)?;
    let mut conn = open(home)?;
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    if let Some(attempt) = attempt {
        let targets = tx
            .prepare("SELECT session_id FROM native_delete_claims WHERE attempt=?")?
            .query_map([attempt], |r| r.get(0))?
            .collect::<rusqlite::Result<Vec<String>>>()?;
        release_retirement(
            &tx,
            &Retirement {
                targets,
                attempt: attempt.into(),
            },
            &listed,
            &BTreeSet::new(),
        )?;
    } else {
        // Old bot journals had no claim ID. Only undo provably provisional
        // work; a catalogless retained child is already a committed deletion.
        for target in targets {
            let root = common::required(target, "id")?;
            reopen_unrecorded(
                &tx,
                root,
                bot,
                common::required(target, "owner")?,
                &BTreeSet::new(),
            )?;
            for stored in descendant_ids(&tx, root)? {
                let pending = tx.query_row("SELECT root_id,cataloged FROM native_delete_pending WHERE session_id=? AND NOT EXISTS(SELECT 1 FROM native_delete_claims WHERE session_id=?1)", [&stored], |r| Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?))).optional()?;
                if pending.is_some_and(|(root, cataloged)| {
                    cataloged == 0 || listed.root_exists(&root, cataloged)
                }) {
                    tx.execute("DELETE FROM native_deleted WHERE session_id=?", [&stored])?;
                }
            }
        }
    }
    if recovering {
        // Startup has no live claim owners. The exact uncommitted bot journal
        // also covers older prepare -> Runtime retirement callers whose claim
        // IDs were not attached to the journal. Only provisional roots roll
        // back; an absent section/room decision or completion stays terminal.
        for target in targets {
            for stored in descendant_ids(&tx, common::required(target, "id")?)? {
                let pending = tx
                    .query_row(
                        "SELECT root_id,cataloged FROM native_delete_pending WHERE session_id=?",
                        [&stored],
                        |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)),
                    )
                    .optional()?;
                if !delete_completed(&tx, &stored)?
                    && pending
                        .is_some_and(|(root, kind)| kind == 0 || listed.root_exists(&root, kind))
                {
                    tx.execute("DELETE FROM native_deleted WHERE session_id=?", [&stored])?;
                }
            }
        }
    }
    tx.commit()?;
    Ok(())
}

/// Only the committed, generation-checked bot journal may promote retention.
/// All exact IDs survive partial native cleanup in that catalog journal.
pub(crate) fn purge_bot_targets(home: &Path, bot: &str, targets: &[Value]) -> Result<()> {
    let mut conn = open(home)?;
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    for target in targets {
        let stored = common::required(target, "id")?;
        common::identifier(stored)?;
        if delete_completed(&tx, stored)? {
            continue;
        }
        tx.execute("INSERT OR IGNORE INTO native_deleted VALUES(?)", [stored])?;
        tx.execute("INSERT INTO native_delete_options VALUES(?,?,?,1) ON CONFLICT(session_id) DO UPDATE SET purge=1", params![stored,bot,common::required(target,"owner")?])?;
        tx.execute(
            "DELETE FROM native_delete_pending WHERE session_id=?",
            [stored],
        )?;
    }
    tx.commit()?;
    for target in targets {
        purge_locked(home, common::required(target, "id")?, false)?;
    }
    Ok(())
}
/// Serialize durable disposition, catalog commit and any rollback under the
/// product boundary. No database writer is reserved while waiting for tools.
/// Prior committed tombstones keep their disposition until a successful purge.
pub(crate) fn with_section_delete(
    home: &Path,
    stored: &str,
    bot: &str,
    owner: &str,
    purge: bool,
    commit_catalog: impl FnOnce() -> Result<()>,
) -> Result<Option<crate::Error>> {
    with_tombstone(home, || {
        with_catalog_delete_locked(
            home,
            &[json!({"id":stored,"bot":bot,"owner":owner})],
            stored,
            1,
            purge,
            commit_catalog,
        )
    })
}

pub(crate) fn with_room_delete(
    home: &Path,
    room: &str,
    targets: &[Value],
    commit_catalog: impl FnOnce() -> Result<()>,
) -> Result<Option<crate::Error>> {
    // The room caller already took the product boundary before its IMMEDIATE
    // catalog reservation. All mapped roots share this one catalog decision.
    with_catalog_delete_locked(home, targets, room, 2, true, commit_catalog)
}
fn with_catalog_delete_locked(
    home: &Path,
    roots: &[Value],
    decision: &str,
    decision_kind: i64,
    purge: bool,
    commit_catalog: impl FnOnce() -> Result<()>,
) -> Result<Option<crate::Error>> {
    let listed = catalog_ids(home)?;
    let mut conn = open(home)?;
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let mut targets = BTreeMap::new();
    for root in roots {
        let stored = common::required(root, "id")?;
        let bot = common::required(root, "bot")?;
        let owner = common::required(root, "owner")?;
        let owned = owned_deletion_targets(&tx, stored, bot, owner)?;
        for target in mark_targets(&tx, stored, listed.contains(stored), owned)? {
            targets.insert(
                target,
                (
                    common::required(root, "bot")?.to_owned(),
                    common::required(root, "owner")?.to_owned(),
                ),
            );
        }
    }
    let retirement = claim_retirement(&tx, targets.keys().cloned().collect())?;
    let mut previous = Vec::new();
    for target in &retirement.targets {
        let pending = tx
            .query_row(
                "SELECT root_id,cataloged FROM native_delete_pending WHERE session_id=?",
                [target],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)),
            )
            .optional()?;
        let Some((root, cataloged)) = pending else {
            continue;
        };
        // A prior catalog commit remains terminal even if finalizing its
        // markers failed. Never change that deletion's options/provenance.
        if cataloged != 0 && !listed.root_exists(&root, cataloged) {
            continue;
        }
        previous.push((
            target.clone(),
            tx.query_row(
                "SELECT bot,owner,purge FROM native_delete_options WHERE session_id=?",
                [target],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, bool>(2)?,
                    ))
                },
            )
            .optional()?,
            root,
            cataloged,
        ));
        // This request can commit a cataloged child independently of a
        // still-retiring parent. Persist its own recovery root *before*
        // catalog COMMIT, so a crash or final-marker fault cannot let the
        // parent's later rollback reopen the committed child/subtree.
        if listed.root_exists(decision, decision_kind) {
            tx.execute(
                "UPDATE native_delete_pending SET root_id=?,cataloged=? WHERE session_id=?",
                params![decision, decision_kind, target],
            )?;
        }
        let (bot, owner) = &targets[target];
        tx.execute("INSERT INTO native_delete_options VALUES(?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET purge=excluded.purge", params![target,bot,owner,purge])?;
    }
    tx.commit()?;
    if let Err(error) = commit_catalog() {
        #[cfg(all(test, unix))]
        if decision_kind == 1 {
            crate::catalog::section_delete_barrier(home, "after_failed_catalog")?;
        }
        // The boundary excludes overlapping disposition/commit/rollback.
        // Restore only provisional options changed above, then release this
        // attempt. Runtime retirement has its own independent claim.
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        for (target, options, root, cataloged) in previous {
            tx.execute(
                "UPDATE native_delete_pending SET root_id=?,cataloged=? WHERE session_id=?",
                params![root, cataloged, target],
            )?;
            if let Some((bot, owner, purge)) = options {
                tx.execute(
                    "UPDATE native_delete_options SET bot=?,owner=?,purge=? WHERE session_id=?",
                    params![bot, owner, purge, target],
                )?;
            } else {
                tx.execute(
                    "DELETE FROM native_delete_options WHERE session_id=?",
                    [&target],
                )?;
            }
        }
        release_retirement(
            &tx,
            &retirement,
            &listed,
            &crate::catalog::pending_bot_delete_targets(home)?,
        )?;
        tx.commit()?;
        return Err(error);
    }
    let finalized: Result<()> = (|| {
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        for target in &retirement.targets {
            let request = tx
                .query_row(
                    "SELECT root_id,cataloged FROM native_delete_pending WHERE session_id=?",
                    [target],
                    |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)),
                )
                .optional()?;
            // End provisional claims through the FK cascade, while retaining
            // the committed cleanup identity until native and legacy work ends.
            tx.execute(
                "DELETE FROM native_delete_pending WHERE session_id=?",
                [target],
            )?;
            if purge && let Some((root, kind)) = request {
                tx.execute(
                    "INSERT INTO native_delete_pending VALUES(?,?,?)",
                    params![target, root, kind],
                )?;
            }
        }
        tx.commit()?;
        Ok(())
    })();
    if let Err(error) = finalized {
        // The catalog already committed. Keep the durable markers and
        // disposition for startup rather than report a reversible failure.
        return Ok(Some(error));
    }
    Ok(None)
}
pub fn unmark_deleted(home: &Path, stored: &str) -> Result<()> {
    let mut conn = open(home)?;
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    for target in descendant_ids(&tx, stored)? {
        tx.execute("DELETE FROM native_deleted WHERE session_id=?", [target])?;
    }
    tx.commit()?;
    Ok(())
}
pub fn owned_sessions(home: &Path, bot: &str) -> Result<Vec<Value>> {
    common::rows(
        &open(home)?,
        "SELECT stored_id,owner FROM (SELECT stored_id,owner,bot FROM native_sessions UNION SELECT session_id AS stored_id,owner,bot FROM native_delete_options) WHERE bot=?1 AND stored_id NOT IN (SELECT session_id FROM native_delete_completed)",
        &[&bot],
    )
}
fn delete_completed(conn: &Connection, stored: &str) -> Result<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM native_delete_completed WHERE session_id=?)",
        [stored],
        |r| r.get(0),
    )?)
}
/// Purge native rows, files and identifiable legacy history before recording
/// completion. The permanent tombstone still rejects late opens and writes.
pub fn delete(home: &Path, stored: &str) -> Result<()> {
    purge(home, stored, true)
}
/// Startup and bulk deletion never retry completed descendants, even when a
/// parent still has native relationship rows or a snapshot still lists them.
pub(crate) fn delete_pending(home: &Path, stored: &str) -> Result<()> {
    purge(home, stored, false)
}
fn purge(home: &Path, stored: &str, retry_completed: bool) -> Result<()> {
    with_tombstone(home, || purge_locked(home, stored, retry_completed))
}
/// The caller holds the product boundary before reserving a catalog writer.
pub(crate) fn purge_locked(home: &Path, stored: &str, retry_completed: bool) -> Result<()> {
    if !retry_completed {
        let listed = catalog_ids(home)?;
        let conn = open(home)?;
        let pending = conn
            .query_row(
                "SELECT root_id,cataloged FROM native_delete_pending WHERE session_id=?",
                [stored],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)),
            )
            .optional()?;
        if pending.is_some_and(|(root, kind)| listed.root_exists(&root, kind)) {
            return Err(crate::Error::new(
                5200,
                "catalog deletion did not commit; kept the original history",
            ));
        }
    }
    // Commit every descendant's ownership and purge intent before any rows go.
    // A retry can then find children whose parent relationship was removed.
    let targets = (|| -> Result<Vec<String>> {
        let mut conn = open(home)?;
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        // A modern retirement without ownership claimed only its root. It
        // cannot gain descendants on restart. Only explicit storage deletion
        // and genuinely old ownerless markers keep the historical fallback.
        let ownerless_pending = !retry_completed
            && deletion_owner(&tx, stored)?.is_none()
            && tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM native_delete_pending WHERE session_id=?)",
                [stored],
                |r| r.get::<_, bool>(0),
            )?;
        let selected = if ownerless_pending {
            vec![stored.to_owned()]
        } else {
            deletion_targets(&tx, stored)?
        };
        let targets = selected
            .iter()
            .cloned()
            .filter_map(|target| match delete_completed(&tx, &target) {
                Ok(true) if !retry_completed => None,
                Ok(_) => Some(Ok(target)),
                Err(error) => Some(Err(error)),
            })
            .collect::<Result<Vec<_>>>()?;
        // Purging is already past the catalog boundary, or an explicit store
        // delete. It cannot be undone by a still-finishing retirement.
        mark_targets(&tx, stored, false, selected)?;
        for target in &targets {
            tx.execute("INSERT OR IGNORE INTO native_delete_options SELECT stored_id,bot,owner,1 FROM native_sessions WHERE stored_id=?", [target])?;
            // An explicit delete retries even a completed ID, for example when
            // removing a newly replaced leaf symlink. Startup and owner cleanup
            // skip completed IDs throughout the tree.
            tx.execute(
                "DELETE FROM native_delete_completed WHERE session_id=?",
                [target],
            )?;
            tx.execute(
                "UPDATE native_delete_options SET purge=1 WHERE session_id=?",
                [target],
            )?;
        }
        tx.commit()?;
        Ok(targets)
    })()?;
    let bot_targets = crate::catalog::committed_bot_delete_targets(home)?;
    // Freeze aliases for the entire owned tree before native parent links go.
    // A failed snapshot leaves native history intact; a later legacy failure
    // cannot prevent the other already-committed native targets from finishing.
    let conn = open(home)?;
    let mut legacy = BTreeMap::new();
    for stored in &targets {
        let ownership = conn
            .query_row(
                "SELECT bot,owner FROM native_delete_options WHERE session_id=?",
                [stored],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
            )
            .optional()?;
        if let Some((bot, owner)) = ownership
            && !bot_targets.contains(stored)
        {
            let keys = crate::catalog::legacy_delete_ids(home, &bot, &owner, stored)?;
            for key in keys {
                conn.execute(
                    "INSERT OR IGNORE INTO native_delete_legacy VALUES(?,?)",
                    params![stored, key],
                )?;
            }
            let keys = conn
                .prepare("SELECT legacy_id FROM native_delete_legacy WHERE session_id=?")?
                .query_map([stored], |r| r.get(0))?
                .collect::<rusqlite::Result<Vec<String>>>()?;
            legacy.insert(stored.clone(), (bot, owner, keys));
        }
    }
    let mut result = Ok(());
    for stored in targets.iter().rev() {
        // Native relationship failures keep unprocessed ancestors intact. File
        // or legacy failures leave their own durable request and allow the next
        // native target to finish, matching the committed tree decision.
        if let Err(error) = delete_native(home, stored) {
            if result.is_ok() {
                result = Err(error);
            }
            break;
        }
        let cleaned = (|| {
            remove_session_files(home, stored)?;
            if !bot_targets.contains(stored) {
                if let Some((bot, owner, keys)) = legacy.get(stored) {
                    crate::catalog::purge_legacy_delete(home, bot, owner, keys)?;
                }
                complete_legacy_delete(home, stored)?;
            } else if !delete_completed(&conn, stored)? {
                conn.execute("INSERT INTO native_delete_completed VALUES(?)", [stored])?;
            }
            Ok(())
        })();
        if let Err(error) = cleaned
            && result.is_ok()
        {
            result = Err(error);
        }
    }
    result
}

fn delete_one(home: &Path, stored: &str) -> Result<()> {
    delete_native(home, stored)?;
    remove_session_files(home, stored)
}
fn delete_native(home: &Path, stored: &str) -> Result<()> {
    common::identifier(stored)?;
    let mut conn = open(home)?;
    let tx = conn.transaction()?;
    tx.execute("INSERT OR IGNORE INTO native_deleted VALUES(?)", [stored])?;
    tx.execute("DELETE FROM native_summaries WHERE session_id=?", [stored])?;
    tx.execute("DELETE FROM native_quarantine WHERE session_id=?", [stored])?;
    tx.execute(
        "DELETE FROM native_unrecovered WHERE session_id=?",
        [stored],
    )?;
    tx.execute("DELETE FROM native_fresh WHERE session_id=?", [stored])?;
    tx.execute("DELETE FROM native_pi_journal WHERE session_id=?", [stored])?;
    tx.execute(
        "DELETE FROM native_prompt_intents WHERE session_id=?",
        [stored],
    )?;
    tx.execute("DELETE FROM native_messages WHERE session_id=?", [stored])?;
    // Last, after the message delete trigger has bumped it: the session is
    // tombstoned above, so its history can never be written again.
    tx.execute(
        "DELETE FROM native_history_versions WHERE session_id=?",
        [stored],
    )?;
    tx.execute("DELETE FROM native_sessions WHERE stored_id=?", [stored])?;
    tx.commit()?;
    Ok(())
}
fn remove_session_files(home: &Path, stored: &str) -> Result<()> {
    common::identifier(stored)?;
    for parent in [home.join("runtime"), home.join("runtime/sessions")] {
        if fs::symlink_metadata(parent).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err(crate::Error::new(
                4202,
                "session path must not contain symlinks",
            ));
        }
    }
    let path = home.join("runtime/sessions").join(stored);
    match fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.is_dir() => fs::remove_dir_all(path)?,
        Ok(_) => fs::remove_file(path)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    Ok(())
}

/// Bot cleanup calls this only after removing the old profile, while its
/// catalog journal still reserves the name. A metadata failure keeps that
/// journal, so an old section request cannot later touch a reused profile.
pub(crate) fn complete_legacy_delete(home: &Path, stored: &str) -> Result<()> {
    let mut conn = open(home)?;
    let tx = conn.transaction()?;
    if !delete_completed(&tx, stored)? {
        tx.execute("INSERT INTO native_delete_completed VALUES(?)", [stored])?;
    }
    tx.execute(
        "DELETE FROM native_delete_legacy WHERE session_id=?",
        [stored],
    )?;
    tx.execute(
        "DELETE FROM native_delete_pending WHERE session_id=?",
        [stored],
    )?;
    tx.commit()?;
    Ok(())
}

/// Sections still on a bot's previous provider and model move with the bot from
/// their next message, and take its new thinking level if they had its old one.
/// A section on another model, like a scheduled job with its own, keeps both.
/// Deleted sections keep their retained options exactly as they were.
pub fn follow_bot_model(home: &Path, bot: &str, before: &Value, after: &Value) -> Result<()> {
    let conn = open(home)?;
    let rows = conn
        .prepare("SELECT stored_id,options FROM native_sessions WHERE bot=? AND NOT EXISTS(SELECT 1 FROM native_deleted WHERE session_id=stored_id)")?
        .query_map([bot], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (stored, raw) in rows {
        let mut options: Value =
            serde_json::from_str(&raw).map_err(|e| crate::Error::new(5200, e.to_string()))?;
        // Only a section on the bot's previous model follows the bot at all. A
        // delegated task keeps its parent section's frozen choice.
        if !options["parent_session"].is_null()
            || (&options["provider"], &options["model"]) != (&before["provider"], &before["model"])
        {
            continue;
        }
        let mut moved = false;
        if (&before["provider"], &before["model"]) != (&after["provider"], &after["model"]) {
            options["provider"] = after["provider"].clone();
            options["model"] = after["model"].clone();
            moved = true;
        }
        if before["reasoning_effort"] != after["reasoning_effort"]
            && options["reasoning_effort"] == before["reasoning_effort"]
        {
            options["reasoning_effort"] = after["reasoning_effort"].clone();
            moved = true;
        }
        if moved {
            conn.execute(
                "UPDATE native_sessions SET options=? WHERE stored_id=? AND NOT EXISTS(SELECT 1 FROM native_deleted WHERE session_id=stored_id)",
                params![options.to_string(), stored],
            )?;
        }
    }
    Ok(())
}
/// Records a section this daemon made: the store from before it has nothing
/// to import into it, so it opens even while that store cannot be read.
pub fn mark_fresh(home: &Path, stored: &str) -> Result<()> {
    open(home)?.execute("INSERT OR IGNORE INTO native_fresh VALUES(?)", [stored])?;
    Ok(())
}
pub fn fresh(home: &Path, stored: &str) -> Result<bool> {
    Ok(open(home)?.query_row(
        "SELECT EXISTS(SELECT 1 FROM native_fresh WHERE session_id=?)",
        [stored],
        |r| r.get(0),
    )?)
}
/// Reserve an unpublished copy before its first native write. A catalog adoption
/// is the commit decision; this record survives rollback and process termination.
pub(crate) fn prepare_chat_fork(
    home: &Path,
    source: &str,
    target: &str,
    bot: &str,
    owner: &str,
) -> Result<()> {
    common::identifier(source)?;
    common::identifier(target)?;
    let target_path = home.join("runtime/sessions").join(target);
    let present = match fs::symlink_metadata(target_path) {
        Ok(_) => true,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => return Err(error.into()),
    };
    if source == target || present {
        return Err(crate::Error::new(5200, "chat fork target already exists"));
    }
    let mut conn = open(home)?;
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    for (table, column) in [
        ("native_sessions", "stored_id"),
        ("native_messages", "session_id"),
        ("native_pi_journal", "session_id"),
        ("native_usage", "session_id"),
        ("native_deleted", "session_id"),
        ("native_fresh", "session_id"),
        ("native_prompt_intents", "session_id"),
        ("native_summaries", "session_id"),
        ("native_history_versions", "session_id"),
        ("native_quarantine", "session_id"),
        ("native_unrecovered", "session_id"),
    ] {
        let present: bool = tx.query_row(
            &format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE {column}=?)"),
            [target],
            |r| r.get(0),
        )?;
        if present {
            return Err(crate::Error::new(5200, "chat fork target already exists"));
        }
    }
    tx.execute(
        "INSERT INTO native_pending_chat_forks VALUES(?,?,?,?)",
        params![target, source, bot, owner],
    )?;
    tx.commit()?;
    Ok(())
}

/// The caller has waited out publication under the catalog reservation, ruled
/// out other decisions, and released the writer before entering cleanup.
/// Never traverse descendants or touch a legacy store.
/// Keep the identity until files, native data and copied zero-charge usage go.
pub(crate) fn discard_chat_fork(
    home: &Path,
    source: &str,
    target: &str,
    bot: &str,
    owner: &str,
) -> Result<()> {
    with_tombstone(home, || {
        let mut conn = open(home)?;
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let reservation = tx
            .query_row(
                "SELECT source,bot,owner FROM native_pending_chat_forks WHERE target=?",
                [target],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                    ))
                },
            )
            .optional()?;
        let Some(reservation) = reservation else {
            return Ok(());
        };
        if reservation != (source.into(), bot.into(), owner.into()) {
            return Err(crate::Error::new(5200, "chat fork reservation changed"));
        }
        // Ok(false) from fork_dream_chat precedes every target write. Prove
        // that state again under the native writer before releasing only the
        // exact reservation. No tombstone is needed for an unused random ID.
        let mut unused = true;
        for (table, column) in [
            ("native_sessions", "stored_id"),
            ("native_messages", "session_id"),
            ("native_pi_journal", "session_id"),
            ("native_usage", "session_id"),
            ("native_deleted", "session_id"),
            ("native_fresh", "session_id"),
            ("native_prompt_intents", "session_id"),
            ("native_summaries", "session_id"),
            ("native_history_versions", "session_id"),
            ("native_quarantine", "session_id"),
            ("native_unrecovered", "session_id"),
        ] {
            let present: bool = tx.query_row(
                &format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE {column}=?)"),
                [target],
                |r| r.get(0),
            )?;
            unused &= !present;
        }
        let path = home.join("runtime/sessions").join(target);
        unused &= match fs::symlink_metadata(&path) {
            Ok(_) => false,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => true,
            Err(error) => return Err(error.into()),
        };
        let ambiguous: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM native_sessions WHERE stored_id=?1 OR json_extract(options,'$.parent_session')=?1)
         OR EXISTS(SELECT 1 FROM native_delete_options WHERE session_id=?1)
         OR EXISTS(SELECT 1 FROM native_delete_pending WHERE session_id=?1)
         OR EXISTS(SELECT 1 FROM native_delete_completed WHERE session_id=?1)
         OR EXISTS(SELECT 1 FROM native_usage WHERE session_id=?1 AND (bot<>?2 OR owner_id<>?3 OR input_tokens<>0 OR output_tokens<>0 OR cache_read_tokens<>0 OR cache_write_tokens<>0 OR cost<>0))",
        params![target, bot, owner],
        |r| r.get(0),
    )?;
        if ambiguous {
            return Err(crate::Error::new(
                5200,
                "unpublished chat has another history owner or decision",
            ));
        }
        if unused {
            tx.execute("DELETE FROM native_pending_chat_forks WHERE target=? AND source=? AND bot=? AND owner=?", params![target,source,bot,owner])?;
            tx.commit()?;
            return Ok(());
        }
        tx.commit()?;
        delete_one(home, target)?;
        let mut conn = open(home)?;
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM native_usage WHERE session_id=?", [target])?;
        tx.execute(
            "DELETE FROM native_pending_chat_forks WHERE target=? AND source=? AND bot=? AND owner=?",
            params![target,source,bot,owner],
        )?;
        tx.commit()?;
        Ok(())
    })
}

/// Recover provisional markers by their catalog operation, without unmarking an
/// earlier committed descendant. Once the catalog root is gone, cleanup is
/// destructive and must stay retryable even if files or legacy storage fail.
pub fn finish_deletes(home: &Path) -> Result<()> {
    let mut bot_cleanup = crate::catalog::finish_chat_forks(home);
    if let Err(error) = crate::catalog::finish_bot_deletes(home)
        && bot_cleanup.is_ok()
    {
        bot_cleanup = Err(error);
    }
    let mut protected = crate::catalog::pending_bot_delete_targets(home)?;
    protected.extend(
        open(home)?
            .prepare("SELECT target FROM native_pending_chat_forks")?
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?,
    );
    with_tombstone(home, || {
        let listed = catalog_ids(home)?;
        let surviving = surviving_roots(home)?;
        let mut conn = open(home)?;
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        // Inspect old markers before removing any modern pending metadata.
        // An absent decision root must never turn a recorded committed child
        // into an apparently old marker under a surviving ancestor.
        for (stored, bot, owner) in surviving {
            if protected.contains(&stored) {
                continue;
            }
            reopen_unrecorded(&tx, &stored, &bot, &owner, &protected)?;
            // Before claims, retirement could save purge=1 without a pending
            // root. A surviving section's own native root was still provisional.
            // Require that root row: a descendant or an already erased row can
            // instead belong to a committed ancestor whose cleanup failed.
            if listed.contains(&stored) {
                tx.execute("DELETE FROM native_deleted WHERE session_id=?1
                    AND NOT EXISTS(SELECT 1 FROM native_delete_pending WHERE session_id=?1)
                    AND NOT EXISTS(SELECT 1 FROM native_delete_completed WHERE session_id=?1)
                    AND EXISTS(SELECT 1 FROM native_delete_options WHERE session_id=?1 AND bot=?2 AND owner=?3 AND purge=1)
                    AND EXISTS(SELECT 1 FROM native_sessions WHERE stored_id=?1 AND bot=?2 AND owner=?3 AND json_extract(options,'$.parent_session') IS NULL)", params![stored,bot,owner])?;
            }
        }
        let pending = common::rows(&tx, "SELECT * FROM native_delete_pending", &[])?;
        for row in pending {
            let stored = common::required(&row, "session_id")?;
            if protected.contains(stored) {
                continue;
            }
            if listed.root_exists(
                common::required(&row, "root_id")?,
                row["cataloged"].as_i64().unwrap_or(0),
            ) && let Err(error) =
                tx.execute("DELETE FROM native_deleted WHERE session_id=?", [stored])
            {
                eprintln!("Could not roll back deleting {stored}: {error}");
                if bot_cleanup.is_ok() {
                    bot_cleanup = Err(error.into());
                }
            }
        }
        tx.commit()?;
        Ok(())
    })?;
    let tombstones = open(home)?
        .prepare("SELECT d.session_id FROM native_deleted d LEFT JOIN native_delete_options o USING(session_id) LEFT JOIN native_delete_completed c USING(session_id) WHERE COALESCE(o.purge,1)<>0 AND c.session_id IS NULL")?
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for id in tombstones {
        if protected.contains(&id) {
            continue;
        }
        if let Err(error) = delete_pending(home, &id) {
            eprintln!("Could not finish deleting {id}: {}", error.message);
            if bot_cleanup.is_ok() {
                bot_cleanup = Err(error);
            }
        }
    }
    bot_cleanup
}
pub fn session_dir(home: &Path, stored: &str) -> Result<PathBuf> {
    common::identifier(stored)?;
    check_deleted(&open(home)?, stored)?;
    let path = home.join("runtime/sessions").join(stored);
    fs::create_dir_all(&path)?;
    Ok(path)
}
pub fn usage(home: &Path, stored: &str) -> Result<Value> {
    let conn = open(home)?;
    conn.query_row(
        "SELECT COALESCE(SUM(input_tokens),0),COALESCE(SUM(output_tokens),0),COALESCE(SUM(cache_read_tokens),0),COALESCE(SUM(cache_write_tokens),0),COALESCE(SUM(cost),0) FROM native_usage WHERE session_id=?",
        [stored],
        |r| {
            let input: i64 = r.get(0)?;
            let output: i64 = r.get(1)?;
            let read: i64 = r.get(2)?;
            let write: i64 = r.get(3)?;
            Ok(json!({"input_tokens":input,"output_tokens":output,"cache_read_tokens":read,"cache_write_tokens":write,"total_tokens":input+output+read+write,"cost":r.get::<_,f64>(4)?}))
        },
    )
    .map_err(Into::into)
}
fn insert_usage(conn: &Connection, route: PiRoute<'_>, message: &Value) -> Result<i64> {
    let u = &message["usage"];
    conn.execute(
        "INSERT INTO native_usage(session_id,owner_id,bot,model,provider,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cost,timestamp) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        params![
            route.stored,
            route.owner,
            route.bot,
            message["model"].as_str().unwrap_or(""),
            message["provider"].as_str().unwrap_or(""),
            u["input"].as_i64().unwrap_or(0),
            u["output"].as_i64().unwrap_or(0),
            u["cacheRead"].as_i64().unwrap_or(0),
            u["cacheWrite"].as_i64().unwrap_or(0),
            u["cost"]["total"].as_f64().unwrap_or(0.),
            message_timestamp(message)
        ],
    )?;
    Ok(conn.last_insert_rowid())
}
pub fn text(content: &Value) -> String {
    if let Some(s) = content.as_str() {
        return s.to_owned();
    }
    content
        .as_array()
        .map(|blocks| {
            blocks
                .iter()
                .filter_map(|b| b.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}
/// Old reports were plain assistant text. Equal text in a tool reply, thinking
/// message or an unfamiliar block is not report identity. The same test accepts
/// Pi messages, native projections and legacy rows with serialized content.
pub(crate) fn dream_report_text(message: &Value) -> Option<String> {
    let empty = |value: &Value| {
        value.is_null()
            || value.as_str().is_some_and(str::is_empty)
            || value.as_array().is_some_and(Vec::is_empty)
    };
    let no_calls = empty(&message["tool_calls"])
        || message["tool_calls"]
            .as_str()
            .and_then(|s| serde_json::from_str::<Value>(s).ok())
            .is_some_and(|calls| empty(&calls));
    if message["role"] != "assistant"
        || message["dream_report_eligible"] == false
        || !no_calls
        || !empty(&message["reasoning"])
        || !empty(&message["thinking"])
        || !empty(&message["reasoning_content"])
    {
        return None;
    }
    let Some(content) = message.get("content") else {
        return message["text"].as_str().map(str::to_owned);
    };
    let parsed = content
        .as_str()
        .and_then(|s| serde_json::from_str::<Value>(s).ok())
        .filter(Value::is_array);
    match parsed.as_ref().unwrap_or(content) {
        Value::String(text) => Some(text.clone()),
        Value::Array(blocks)
            if blocks.len() == 1
                && blocks[0]["type"] == "text"
                && blocks[0].as_object().is_some_and(|block| {
                    block
                        .keys()
                        .all(|key| matches!(key.as_str(), "type" | "text"))
                }) =>
        {
            blocks[0]["text"].as_str().map(str::to_owned)
        }
        _ => None,
    }
}

/// Only projection metadata changes here. In particular, an old text-only
/// classifier's mistake can be disproved by the linked raw message without
/// changing that message, its Pi file, or any frozen session options.
pub(crate) fn classify_dream_reports(
    home: &Path,
    stored: &str,
    reports: &BTreeSet<String>,
) -> Result<()> {
    let mut conn = open(home)?;
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    for row in common::rows(
        &tx,
        "SELECT m.seq,m.message_json,p.raw_json FROM native_messages m LEFT JOIN native_pi_journal p ON p.session_id=m.session_id AND p.projection_seq=m.seq WHERE m.session_id=?",
        &[&stored],
    )? {
        let mut shown: Value = serde_json::from_str(row["message_json"].as_str().unwrap_or(""))
            .map_err(|e| crate::Error::new(5200, e.to_string()))?;
        let before = shown.clone();
        let raw = row["raw_json"]
            .as_str()
            .map(serde_json::from_str::<Value>)
            .transpose()
            .map_err(|e| crate::Error::new(5200, e.to_string()))?;
        if shown["role"] == "assistant" {
            if dream_report_text(&shown).is_none()
                || raw.as_ref().is_some_and(|m| dream_report_text(m).is_none())
            {
                shown["dream_report_eligible"] = json!(false);
                shown.as_object_mut().unwrap().remove("dream");
            } else if dream_report_text(&shown).is_some_and(|text| reports.contains(&text)) {
                shown["dream"] = json!(true);
            }
        }
        if shown != before {
            tx.execute(
                "UPDATE native_messages SET message_json=? WHERE session_id=? AND seq=?",
                params![shown.to_string(), stored, row["seq"].as_i64()],
            )?;
        }
    }
    tx.commit()?;
    Ok(())
}
/// Resolve a continuation without crossing explicit branch or delegation boundaries.
pub fn legacy_lineage(conn: &Connection, stored: &str) -> Result<Vec<String>> {
    let all = common::rows(conn, "SELECT * FROM sessions", &[])?;
    let fork = |row: &Value| {
        let config: Value = row["model_config"]
            .as_str()
            .and_then(|s| serde_json::from_str(s).ok())
            .unwrap_or(Value::Null);
        !config["_branched_from"].is_null()
            || !config["_delegate_from"].is_null()
            || row["source"] == "tool"
    };
    let by_id = all
        .iter()
        .filter_map(|r| r["id"].as_str().map(|id| (id, r)))
        .collect::<HashMap<_, _>>();
    let Some(mut current) = by_id
        .get(stored)
        .copied()
        .or_else(|| {
            all.iter()
                .find(|r| r["session_key"] == stored && r["parent_session_id"].is_null())
        })
        .or_else(|| all.iter().find(|r| r["session_key"] == stored))
    else {
        return Ok(vec![]);
    };
    let continuation = |child: &Value, parent: &Value| {
        !fork(child)
            && (parent["end_reason"] == "compression" || parent.get("end_reason").is_none())
    };
    let mut seen = HashSet::new();
    while !fork(current) {
        if !seen.insert(current["id"].as_str().unwrap()) {
            return Err(crate::Error::new(
                5200,
                "Conversation lineage contains a cycle",
            ));
        }
        let Some(parent) = current["parent_session_id"]
            .as_str()
            .and_then(|id| by_id.get(id).copied())
        else {
            break;
        };
        if !continuation(current, parent) {
            break;
        }
        current = parent;
    }
    let mut lineage = vec![];
    seen.clear();
    loop {
        let id = common::required(current, "id")?;
        if !seen.insert(id) {
            return Err(crate::Error::new(
                5200,
                "Conversation lineage contains a cycle",
            ));
        }
        lineage.push(id.to_owned());
        let mut children = all
            .iter()
            .filter(|c| c["parent_session_id"] == id && continuation(c, current))
            .collect::<Vec<_>>();
        children.sort_by(|a, b| {
            let rank = |r: &Value| {
                if r["end_reason"] == "compression" {
                    0
                } else if r["ended_at"].is_null() {
                    1
                } else {
                    2
                }
            };
            rank(a)
                .cmp(&rank(b))
                .then_with(|| {
                    b["last_active"]
                        .as_f64()
                        .unwrap_or(0.)
                        .total_cmp(&a["last_active"].as_f64().unwrap_or(0.))
                })
                .then_with(|| {
                    b["started_at"]
                        .as_f64()
                        .unwrap_or(0.)
                        .total_cmp(&a["started_at"].as_f64().unwrap_or(0.))
                })
                .then_with(|| b["id"].as_str().cmp(&a["id"].as_str()))
        });
        let Some(next) = children.first() else { break };
        current = next;
    }
    Ok(lineage)
}
pub fn legacy_rows(conn: &Connection, stored: &str) -> Result<(Vec<Value>, String)> {
    let lineage = legacy_lineage(conn, stored)?;
    let columns = common::rows(conn, "PRAGMA table_info(messages)", &[])?;
    let has = |name: &str| columns.iter().any(|c| c["name"] == name);
    let active = if has("compacted") {
        " AND (active=1 OR compacted=1)"
    } else if has("active") {
        " AND active=1"
    } else {
        ""
    };
    let mut result: Vec<Value> = vec![];
    let mut seen = HashMap::new();
    for id in &lineage {
        for row in common::rows(
            conn,
            &format!("SELECT * FROM messages WHERE session_id=?{active} ORDER BY id"),
            &[&id],
        )? {
            let key = json!([
                row["role"],
                row["content"],
                row["timestamp"],
                row["tool_call_id"],
                row["tool_calls"],
                row["tool_name"]
            ])
            .to_string();
            if let Some(index) = seen.get(&key).copied() {
                let previous: &Value = &result[index];
                if previous["session_id"] == row["session_id"]
                    && previous["active"] == 1
                    && row["active"] == 0
                {
                    continue;
                }
                result[index] = row;
            } else {
                seen.insert(key, result.len());
                result.push(row);
            }
        }
    }
    Ok((result, lineage.last().cloned().unwrap_or_default()))
}
/// A list kept in a setting.
fn listed(home: &Path, key: &str) -> Result<BTreeSet<String>> {
    let value: Option<String> = crate::db::open(home)?
        .query_row("SELECT value FROM settings WHERE key=?", [key], |r| {
            r.get(0)
        })
        .optional()?;
    Ok(value
        .and_then(|value| serde_json::from_str(&value).ok())
        .unwrap_or_default())
}
/// Sections an earlier build posted dream reports to, as the upgrade to one
/// chat per bot found them.
pub fn dream_logs(home: &Path) -> Result<BTreeSet<String>> {
    listed(home, "dream_logs")
}
/// The reports an earlier build posted, unmarked, to a section: none unless it
/// is a dream log, since a reply elsewhere can read like one.
pub fn legacy_reports(home: &Path, bot: &str, stored: &str) -> Result<HashSet<String>> {
    if !crate::catalog::dream_logs(home, bot)?.contains(stored) {
        return Ok(HashSet::new());
    }
    Ok(common::rows(
        &crate::db::open(home)?,
        "SELECT DISTINCT summary FROM dreams WHERE bot=? AND summary<>''",
        &[&bot],
    )?
    .into_iter()
    .filter_map(|row| row["summary"].as_str().map(str::to_owned))
    .collect())
}
/// Read the old store without changing it, retaining hidden rows and tool results.
/// Imported Pi files are written once; subsequent launches let Pi own the log.
pub fn import_hermes(home: &Path, bot: &str, stored: &str, cwd: &Path) -> Result<()> {
    common::identifier(bot)?;
    check_quarantine(home, stored)?;
    let dir = session_dir(home, stored)?;
    let target = dir.join("conversation.jsonl");
    if target.exists() {
        return Ok(());
    }
    let path = home.join("profiles").join(bot).join("state.db");
    let mut raw = Vec::<(i64, Value, Value)>::new();
    let mut projected = Vec::<Value>::new();
    if path.exists() && !fresh(home, stored)? {
        // Dream reports an earlier build posted as the bot's messages: shown,
        // never the bot's context.
        let reports = legacy_reports(home, bot, stored)?;
        let conn = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        let (rows, tip) = legacy_rows(&conn, stored)?;
        {
            for row in rows {
                let context = row["session_id"] == tip && row["active"] != 0;
                let role = row["role"].as_str().unwrap_or("");
                let content = row["content"].as_str().unwrap_or("");
                let parsed = serde_json::from_str::<Value>(content)
                    .ok()
                    .filter(|v| v.is_array())
                    .unwrap_or_else(|| json!(content));
                let body = text(&parsed);
                let ts = row["timestamp"].as_f64().unwrap_or(0.) * 1000.;
                let mut shown = json!({"role":role,"text":body,"row_id":format!("legacy-{}",row["id"]),"display_kind":row["display_kind"],"timestamp":row["timestamp"]});
                let message = match role {
                    "user" => {
                        let content = if let Some(blocks) = parsed.as_array() {
                            json!(
                                blocks
                                    .iter()
                                    .filter_map(|block| {
                                        if block["type"] == "text" {
                                            return Some(block.clone());
                                        }
                                        if block["type"] == "image_url" {
                                            let url = block["image_url"]["url"].as_str()?;
                                            if let Some((header, data)) = url
                                                .strip_prefix("data:")
                                                .and_then(|u| u.split_once(";base64,"))
                                            {
                                                return Some(json!({
                                                "type":"image",
                                                "mimeType":header,
                                                "data":data}
                                                ));
                                            }
                                            return Some(json!({
                                            "type":"text",
                                            "text":format!("Image: {url}")}
                                            ));
                                        }
                                        if block["type"] == "image" {
                                            return Some(block.clone());
                                        }
                                        None
                                    })
                                    .collect::<Vec<_>>()
                            )
                        } else {
                            parsed
                        };
                        json!({"role":"user","content":content,"timestamp":ts})
                    }
                    "assistant" => {
                        let mut blocks = parsed.as_array().cloned().unwrap_or_else(|| {
                            if body.is_empty() {
                                vec![]
                            } else {
                                vec![json!({"type":"text","text":body})]
                            }
                        });
                        if let Some(calls) = row["tool_calls"]
                            .as_str()
                            .and_then(|s| serde_json::from_str::<Value>(s).ok())
                            .and_then(|v| v.as_array().cloned())
                        {
                            for call in calls {
                                let args = call["function"]["arguments"]
                                    .as_str()
                                    .and_then(|s| serde_json::from_str::<Value>(s).ok())
                                    .unwrap_or_else(|| json!({}));
                                blocks.push(json!({"type":"toolCall","id":call["id"],"name":call["function"]["name"],"arguments":args}));
                            }
                        }
                        json!({
                            "role": "assistant",
                            "content": blocks,
                            "api": "openai-completions",
                            "provider": "imported",
                            "model": "legacy",
                            "usage": {
                                "input": 0,
                                "output": 0,
                                "cacheRead": 0,
                                "cacheWrite": 0,
                                "totalTokens": 0,
                                "cost": {
                                    "input": 0,
                                    "output": 0,
                                    "cacheRead": 0,
                                    "cacheWrite": 0,
                                    "total": 0
                                }
                            },
                            "stopReason": "stop",
                            "timestamp": ts
                        })
                    }
                    "tool" => {
                        shown["name"] = row["tool_name"].clone();
                        shown["tool_name"] = row["tool_name"].clone();
                        shown["tool_id"] = row["tool_call_id"].clone();
                        shown["tool_call_id"] = row["tool_call_id"].clone();
                        json!({"role":"toolResult","toolCallId":row["tool_call_id"],"toolName":row["tool_name"],"content":[{"type":"text","text":body}],"isError":false,"timestamp":ts})
                    }
                    _ => continue,
                };
                if role == "assistant" {
                    shown.as_object_mut().unwrap().extend(
                        projection(&message, None)
                            .unwrap()
                            .as_object()
                            .unwrap()
                            .clone(),
                    );
                }
                if role == "assistant" && dream_report_text(&row).is_none() {
                    shown["dream_report_eligible"] = json!(false);
                }
                let report = dream_report_text(&row).is_some_and(|text| reports.contains(&text));
                if report {
                    shown["dream"] = json!(true);
                }
                if context && !report {
                    raw.push((row["id"].as_i64().unwrap_or(0), message, shown.clone()));
                }
                projected.push(shown);
            }
        }
    }
    let timestamp = chrono::Utc::now().to_rfc3339();
    let mut lines = vec![
        json!({"type":"session","version":3,"id":stored,"timestamp":timestamp,"cwd":cwd})
            .to_string(),
    ];
    let mut parent = Value::Null;
    raw.sort_by_key(|(id, _, _)| *id);
    for (_, message, projection) in raw {
        let next = id();
        lines.push(json!({"type":"message","id":next,"parentId":parent,"timestamp":timestamp,"message":message,"hexbot":projection}).to_string());
        parent = json!(next);
    }
    if !projected.is_empty() {
        let mut conn = open(home)?;
        // Take the write lock first: reading, then writing in a deferred
        // transaction fails at once if a running section wrote in between.
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let existing = common::rows(
            &tx,
            "SELECT message_json FROM native_messages WHERE session_id=? ORDER BY seq",
            &[&stored],
        )?;
        // Dream reports posted before the chat was first opened follow its history.
        let reports = existing
            .iter()
            .map(|row| serde_json::from_str::<Value>(row["message_json"].as_str().unwrap_or("")))
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(|_| crate::Error::new(5200, "invalid stored message"))?;
        if reports.iter().all(|message| message["dream"] == true) {
            tx.execute("DELETE FROM native_messages WHERE session_id=?", [stored])?;
            for (i, message) in projected.iter().chain(&reports).enumerate() {
                tx.execute(
                    "INSERT INTO native_messages VALUES(?,?,?)",
                    params![stored, i + 1, message.to_string()],
                )?;
            }
        }
        tx.commit()?;
    }
    // Write the import marker only after its transcript transaction commits.
    // A crash before this point can safely repeat the import on next startup.
    common::atomic_write(&target, format!("{}\n", lines.join("\n")).as_bytes())?;
    Ok(())
}

/// Starts an independent owner conversation from an already-imported Dream log.
/// The original JSONL, prompt, journal and cached prefix remain untouched. Old
/// compaction/branch summaries may contain reports, so replay original messages
/// on the selected branch rather than transferring those generated summaries.
/// Display history still includes reports, marked as output; usage stays on the
/// original conversation and is never billed again for this copy.
/// The caller owns the unpublished target, including cleanup on any error.
/// Ok(false) means no target files or native rows were written.
/// Release its catalog transaction before deleting that target: deletion takes
/// the product boundary, which must always precede database writers.
pub(crate) fn fork_dream_chat(
    home: &Path,
    bot: &str,
    owner: &str,
    source: &str,
    target: &str,
    reports: &HashSet<String>,
) -> Result<bool> {
    common::identifier(source)?;
    common::identifier(target)?;
    let source_path = home
        .join("runtime/sessions")
        .join(source)
        .join("conversation.jsonl");
    let bytes = match fs::read(&source_path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.into()),
    };
    let (entries, _, torn) = parse_pi_entries(&bytes)?;
    if torn {
        return Err(crate::Error::new(
            5200,
            "The old Dream log needs recovery before it can become a chat",
        ));
    }
    let is_report = |entry: &Value| {
        entry["type"] == "message"
            && entry["hexbot"]["dream_report_eligible"] != false
            && dream_report_text(&entry["message"]).is_some_and(|text| reports.contains(&text))
    };
    if !entries.iter().any(is_report) {
        return Ok(false);
    }
    let mut active = active_ids(&entries)?;
    let by_id = entries
        .iter()
        .filter_map(|e| e["id"].as_str().map(|id| (id, e)))
        .collect::<HashMap<_, _>>();
    // Branch summaries also stand for original messages. Expand their source
    // paths before removing generated summaries, including nested branches.
    loop {
        let mut added = false;
        for summary in entries.iter().filter(|e| e["type"] == "branch_summary") {
            if !summary["id"].as_str().is_some_and(|id| active.contains(id)) {
                continue;
            }
            let mut from = summary["fromId"].as_str();
            while let Some(id) = from.filter(|id| *id != "root") {
                let entry = by_id.get(id).ok_or_else(|| crate::Error::new(5200, "The old Dream log is missing a summarized branch; its original conversation has been preserved"))?;
                if !active.insert(id) {
                    break;
                }
                added = true;
                from = entry["parentId"].as_str();
            }
        }
        if !added {
            break;
        }
    }
    let original = history(home, source)?;
    let header = bytes
        .split(|b| *b == b'\n')
        .find(|line| !line.iter().all(u8::is_ascii_whitespace))
        .and_then(|line| serde_json::from_slice::<Value>(line).ok())
        .unwrap_or(Value::Null);
    let timestamp = chrono::Utc::now().to_rfc3339();
    let mut lines = vec![
        json!({"type":"session","version":3,"id":target,"timestamp":timestamp,"cwd":header["cwd"]})
            .to_string(),
    ];
    let mut parent = Value::Null;
    let mut missing_reports = Vec::new();
    for entry in entries
        .iter()
        .filter(|e| e["id"].as_str().is_some_and(|id| active.contains(id)))
    {
        if entry["type"] != "message" && entry["type"] != "custom_message" {
            continue;
        }
        if is_report(entry) {
            let mut shown = projection(&entry["message"], None).unwrap_or(Value::Null);
            shown["dream"] = json!(true);
            if !original
                .iter()
                .any(|m| dream_report_text(m).is_some() && m["text"] == shown["text"])
            {
                missing_reports.push(shown);
            }
            continue;
        }
        let mut message = entry["message"].clone();
        if message["role"] == "assistant" {
            message["usage"] = json!({"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"totalTokens":0,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}});
        }
        let next = id();
        let mut copied = entry.clone();
        copied["id"] = json!(next);
        copied["parentId"] = parent;
        if copied["type"] == "message" {
            copied["message"] = message;
        }
        lines.push(copied.to_string());
        parent = json!(next);
    }
    mark_fresh(home, target)?;
    #[cfg(all(test, unix))]
    let mut first = true;
    for mut shown in original.into_iter().chain(missing_reports) {
        if dream_report_text(&shown).is_some_and(|text| reports.contains(&text)) {
            shown["dream"] = json!(true);
        }
        append(home, target, shown)?;
        #[cfg(all(test, unix))]
        if first {
            first = false;
            crate::catalog::chat_fork_barrier(home, "during_copy")?;
        }
    }
    let path = session_dir(home, target)?.join("conversation.jsonl");
    common::atomic_write(&path, format!("{}\n", lines.join("\n")).as_bytes())?;
    reconcile(home, bot, target, owner)?;
    Ok(true)
}

/// Commit display metadata before sending a prompt to Pi. Matching by final text
/// survives a daemon crash between Pi's JSONL append and the message_end handler.
pub fn stage_prompt(home: &Path, stored: &str, text: &str, display: &str) -> Result<String> {
    common::identifier(stored)?;
    if !matches!(display, "normal" | "hidden") {
        return Err(crate::Error::new(4202, "invalid prompt display kind"));
    }
    let mut conn = open(home)?;
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    check_deleted(&tx, stored)?;
    let id = id();
    tx.execute("INSERT INTO native_prompt_intents(id,session_id,text,display_kind,created_at) VALUES (?,?,?,?,?)",params![id,stored,text,display,common::now()])?;
    tx.commit()?;
    Ok(id)
}
pub fn reject_prompt(home: &Path, stored: &str, intent: &str) -> Result<()> {
    open(home)?.execute(
        "DELETE FROM native_prompt_intents WHERE id=? AND session_id=? AND consumed_by IS NULL",
        params![intent, stored],
    )?;
    Ok(())
}

/// Persist a live Pi event, its UI projection, and its billing record together.
/// The log entry id is bound during reconciliation because Pi emits message_end
/// before its SessionManager appends that entry to disk. `seed` adds
/// client-facing fields to the projected row, such as a tool preview.
pub fn project_seeded(
    home: &Path,
    stored: &str,
    owner: &str,
    bot: &str,
    message: &Value,
    display: Option<&str>,
    seed: Option<&Value>,
) -> Result<()> {
    common::identifier(stored)?;
    common::identifier(bot)?;
    let mut conn = open(home)?;
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    check_deleted(&tx, stored)?;
    persist_pi_message(
        &tx,
        PiRoute { stored, owner, bot },
        message,
        display,
        None,
        seed,
        false,
    )?;
    tx.commit()?;
    Ok(())
}

fn message_timestamp(message: &Value) -> f64 {
    // Pi user, assistant, and tool timestamps are milliseconds since Unix epoch.
    message["timestamp"]
        .as_f64()
        .filter(|t| t.is_finite())
        .map(|t| t / 1000.0)
        .unwrap_or_else(common::now)
}
/// Clients label Pi's built-in tools by the names the legacy daemon sent.
pub(crate) fn client_tool_name(name: &str) -> &str {
    match name {
        "bash" => "terminal",
        "read" => "read_file",
        "write" => "write_file",
        "edit" => "patch",
        "grep" | "find" => "search_files",
        other => other,
    }
}
fn projection(message: &Value, display: Option<&str>) -> Option<Value> {
    let role = message["role"].as_str()?;
    if role == "assistant" && message["stopReason"] == "error" {
        return None;
    }
    let mut result = json!({"role":match role{"toolResult"=>"tool","custom"=>"user",other=>other},"text":text(&message["content"]),"timestamp":message_timestamp(message)});
    match role {
        "user" => {
            result["display_kind"] = json!(display.unwrap_or("normal"));
            result["content"] = message["content"].clone();
        }
        "assistant" => {
            // Text extraction deliberately omits other blocks. Keep that fact
            // with the display row, including blocks this daemon cannot render.
            if dream_report_text(message).is_none() {
                result["dream_report_eligible"] = json!(false);
            }
            let calls = message["content"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|block| block["type"] == "toolCall")
                .map(|block| {
                    json!({
                        "id": block["id"],
                        "type": "function",
                        "function": {
                            "name": client_tool_name(block["name"].as_str().unwrap_or("")),
                            "arguments": block["arguments"].to_string()
                        }
                    })
                })
                .collect::<Vec<_>>();
            if !calls.is_empty() {
                result["tool_calls"] = json!(calls);
            }
            let reasoning = message["content"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|b| b["type"] == "thinking")
                .filter_map(|b| b["thinking"].as_str())
                .collect::<Vec<_>>()
                .join("\n");
            if !reasoning.is_empty() {
                result["reasoning"] = json!(reasoning);
            }
            result["stop_reason"] = message["stopReason"].clone();
        }
        "toolResult" => {
            let name = client_tool_name(message["toolName"].as_str().unwrap_or(""));
            result["name"] = json!(name);
            result["tool_name"] = json!(name);
            result["tool_id"] = message["toolCallId"].clone();
            result["tool_call_id"] = message["toolCallId"].clone();
            result["is_error"] = message["isError"].clone();
            result["nested_calls"] = message["nestedCalls"].clone();
            if let Some(calls) = result["nested_calls"]["calls"].as_array_mut() {
                for call in calls {
                    call["name"] = json!(client_tool_name(call["name"].as_str().unwrap_or("")));
                }
            }
            result["content"] = message["content"].clone();
        }
        "custom" => {
            result["display_kind"] = json!(if message["display"] == false {
                "hidden"
            } else {
                display.unwrap_or("normal")
            });
            result["custom_type"] = message["customType"].clone();
        }
        "system" => {
            result["display_kind"] = json!("hidden");
        }
        _ => return None,
    }
    Some(result)
}
/// Hidden instructions Hexbot's Pi extension adds to a chat: the todo list
/// after a compaction and the notice that the fallback model took over.
/// Neither the user nor the bot said them.
pub(crate) fn hexbot_instruction(kind: &Value, hidden: bool) -> bool {
    hidden
        && kind
            .as_str()
            .is_some_and(|kind| matches!(kind, "hexbot_todo" | "hexbot_fallback"))
}
/// Pi log records the live runtime never journals: Pi's empty system/tool
/// catalog updates and Hexbot's hidden instructions. Only recovery records
/// them, as hidden rows. Any other message must come through message_end.
pub(crate) fn journaled_on_recovery(message: &Value) -> bool {
    match message["role"].as_str() {
        Some("system") => text(&message["content"]).is_empty(),
        Some("custom") => hexbot_instruction(&message["customType"], message["display"] == false),
        _ => false,
    }
}
struct PiRoute<'a> {
    stored: &'a str,
    owner: &'a str,
    bot: &'a str,
}
fn persist_pi_message(
    conn: &Connection,
    route: PiRoute<'_>,
    message: &Value,
    display: Option<&str>,
    entry: Option<&str>,
    seed: Option<&Value>,
    recover: bool,
) -> Result<String> {
    let PiRoute { stored, owner, bot } = route;
    let journal = id();
    let raw = message.to_string();
    let mut display = display.map(str::to_owned);
    if message["role"] == "user" {
        let body = text(&message["content"]);
        let intent: Option<(String, String)> = conn
            .query_row(
                "SELECT id,display_kind FROM native_prompt_intents WHERE session_id=? AND consumed_by IS NULL AND (id=? OR (? IS NULL AND text=?)) ORDER BY created_at,rowid LIMIT 1",
                params![stored, seed.and_then(|s| s["_input_intent"].as_str()), seed.and_then(|s| s["_input_intent"].as_str()), body],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        if let Some((intent, kind)) = intent {
            display = Some(kind);
            conn.execute(
                "UPDATE native_prompt_intents SET consumed_by=? WHERE id=?",
                params![journal, intent],
            )?;
        }
    }
    let mut projected = projection(message, display.as_deref());
    if let (Some(projected), Some(seed)) = (&mut projected, seed.and_then(Value::as_object)) {
        for (key, value) in seed {
            if key == "_input_intent" {
                continue;
            }
            projected[key] = value.clone();
        }
    }
    if let Some(projected) = &mut projected
        && message["role"] == "assistant"
        && dream_report_text(message).is_none()
    {
        projected["dream_report_eligible"] = json!(false);
        projected.as_object_mut().unwrap().remove("dream");
    }
    let mut projection_seq = None;
    if let Some(mut projected) = projected {
        let existing = if recover {
            legacy_projection(conn, stored, &projected)?
        } else {
            None
        };
        if let Some((seq, old)) = existing {
            projection_seq = Some(seq);
            // Upgrade metadata while retaining the original row id and hidden flag.
            if let Some(map) = old.as_object() {
                for (key, value) in map {
                    projected[key] = value.clone();
                }
            }
            // Structural evidence belongs to this actual message, even when an
            // older projection or imported seed called equal text a report.
            if message["role"] == "assistant" && dream_report_text(message).is_none() {
                projected["dream_report_eligible"] = json!(false);
                projected.as_object_mut().unwrap().remove("dream");
            }
            conn.execute(
                "UPDATE native_messages SET message_json=? WHERE session_id=? AND seq=?",
                params![projected.to_string(), stored, seq],
            )?;
        } else {
            if projected.get("row_id").is_none() {
                projected["row_id"] = json!(
                    entry
                        .map(|entry| format!("pi-{entry}"))
                        .unwrap_or_else(|| format!("pi-live-{journal}"))
                );
            }
            let seq: i64 = conn.query_row(
                "SELECT COALESCE(MAX(seq),0)+1 FROM native_messages WHERE session_id=?",
                [stored],
                |r| r.get(0),
            )?;
            conn.execute(
                "INSERT INTO native_messages(session_id,seq,message_json) VALUES (?,?,?)",
                params![stored, seq, projected.to_string()],
            )?;
            projection_seq = Some(seq);
        }
    }
    let usage_id = if message["usage"].is_object() && message["provider"] != "imported" {
        let u = &message["usage"];
        let values = (
            u["input"].as_i64().unwrap_or(0),
            u["output"].as_i64().unwrap_or(0),
            u["cacheRead"].as_i64().unwrap_or(0),
            u["cacheWrite"].as_i64().unwrap_or(0),
            u["cost"]["total"].as_f64().unwrap_or(0.0),
        );
        let provider = message["provider"].as_str().unwrap_or("");
        let model = message["model"].as_str().unwrap_or("");
        let existing: Option<i64> = if recover {
            conn.query_row(
                "SELECT u.id FROM native_usage u WHERE session_id=? AND owner_id=? AND bot=? AND model=? AND provider=? AND input_tokens=? AND output_tokens=? AND cache_read_tokens=? AND cache_write_tokens=? AND cost=? AND NOT EXISTS(SELECT 1 FROM native_pi_journal p WHERE p.usage_id=u.id) ORDER BY u.id LIMIT 1",
                params![
                    stored, owner, bot, model, provider, values.0, values.1, values.2, values.3,
                    values.4
                ],
                |r| r.get(0),
            )
            .optional()?
        } else {
            None
        };
        Some(match existing {
            Some(id) => id,
            None => insert_usage(conn, PiRoute { stored, owner, bot }, message)?,
        })
    } else {
        None
    };
    conn.execute(
        "INSERT INTO native_pi_journal(journal_id,session_id,raw_json,entry_id,projection_seq,usage_id) VALUES (?,?,?,?,?,?)",
        params![journal, stored, raw, entry, projection_seq, usage_id],
    )?;
    Ok(journal)
}
fn legacy_projection(
    conn: &Connection,
    stored: &str,
    wanted: &Value,
) -> Result<Option<(i64, Value)>> {
    let rows = common::rows(
        conn,
        "SELECT m.seq,m.message_json FROM native_messages m WHERE m.session_id=? AND NOT EXISTS(SELECT 1 FROM native_pi_journal p WHERE p.session_id=m.session_id AND p.projection_seq=m.seq) ORDER BY seq",
        &[&stored],
    )?;
    for row in rows {
        let old: Value = serde_json::from_str(row["message_json"].as_str().unwrap_or(""))
            .map_err(|e| crate::Error::new(5200, e.to_string()))?;
        let row_matches = wanted
            .get("row_id")
            .is_some_and(|id| old.get("row_id") == Some(id));
        let same_text = old["role"] == wanted["role"]
            && old["text"] == wanted["text"]
            && (old["role"] != "assistant"
                || old["tool_calls"] == wanted["tool_calls"]
                    && old["reasoning"] == wanted["reasoning"]
                    && dream_report_text(&old).is_some() == dream_report_text(wanted).is_some())
            && (old["role"] != "tool"
                || old["name"] == wanted["name"]
                || old["tool_name"] == wanted["tool_name"]);
        let same_time = match (old["timestamp"].as_f64(), wanted["timestamp"].as_f64()) {
            (Some(a), Some(b)) => (a - b).abs() < 5.0,
            _ => true,
        };
        if row_matches || (same_text && same_time) {
            return Ok(Some((row["seq"].as_i64().unwrap(), old)));
        }
    }
    Ok(None)
}

/// Recover durable Pi entries before starting the process for this section.
/// UI history follows the current branch but retains its compacted transcripts;
/// context edits and compaction summaries never rewrite a user's displayed past.
/// Billing includes all branches because those model calls already happened.
pub fn reconcile(home: &Path, bot: &str, stored: &str, owner: &str) -> Result<()> {
    common::identifier(bot)?;
    common::identifier(stored)?;
    check_quarantine(home, stored)?;
    let path = home
        .join("runtime/sessions")
        .join(stored)
        .join("conversation.jsonl");
    if !path.try_exists()? {
        return Ok(());
    }
    let entries = read_pi_entries(&path)?;
    let by_id = entries
        .iter()
        .filter_map(|entry| entry["id"].as_str().map(|id| (id, entry)))
        .collect::<HashMap<_, _>>();
    let active = active_ids(&entries)?;
    let mut conn = open(home)?;
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    check_deleted(&tx, stored)?;
    let known: Option<(String, String)> = tx
        .query_row(
            "SELECT owner,bot FROM native_sessions WHERE stored_id=?",
            [stored],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    if let Some((actual_owner, actual_bot)) = known
        && (actual_owner != owner || actual_bot != bot)
    {
        return Err(crate::Error::new(4302, "not the owner"));
    }
    let old_entries = common::rows(
        &tx,
        "SELECT entry_id FROM native_pi_journal WHERE session_id=? AND entry_id IS NOT NULL",
        &[&stored],
    )?;
    if old_entries.iter().any(|row| {
        row["entry_id"]
            .as_str()
            .is_some_and(|id| !by_id.contains_key(id))
    }) {
        return Err(crate::Error::new(
            5200,
            "conversation lost previously recorded entries; restore its JSONL backup",
        ));
    }
    let mut order = Vec::new();
    let mut models: HashMap<String, (String, String)> = HashMap::new();
    for entry in &entries {
        let entry_id = common::required(entry, "id")?;
        let mut model = entry["parentId"]
            .as_str()
            .and_then(|parent| models.get(parent))
            .cloned()
            .unwrap_or_default();
        if entry["type"] == "model_change" {
            model = (
                entry["provider"].as_str().unwrap_or("").into(),
                entry["modelId"].as_str().unwrap_or("").into(),
            );
        }
        if entry["type"] == "message" && entry["message"]["role"] == "assistant" {
            model = (
                entry["message"]["provider"].as_str().unwrap_or("").into(),
                entry["message"]["model"].as_str().unwrap_or("").into(),
            );
        }
        models.insert(entry_id.into(), model.clone());
        let message = match entry["type"].as_str().unwrap_or("") {
            "message" => Some(entry["message"].clone()),
            "custom_message" => Some(
                json!({"role":"custom","content":entry["content"],"customType":entry["customType"],"display":entry["display"],"details":entry["details"],"timestamp":entry_timestamp(entry)*1000.0}),
            ),
            "usage" | "compaction" | "branch_summary" if entry["usage"].is_object() => {
                Some(json!({
                    "role": "usage",
                    "usage": entry["usage"],
                    "provider": entry["provider"].as_str().unwrap_or(&model.0),
                    "model": entry["model"].as_str().unwrap_or(&model.1),
                    "timestamp": entry_timestamp(entry) * 1000.0
                }))
            }
            _ => None,
        };
        let Some(message) = message else {
            continue;
        };
        let existing: Option<String> = tx
            .query_row(
                "SELECT journal_id FROM native_pi_journal WHERE session_id=? AND entry_id=?",
                params![stored, entry_id],
                |r| r.get(0),
            )
            .optional()?;
        let journal = if let Some(existing) = existing {
            existing
        } else {
            let waiting: Option<String> = tx
                .query_row(
                    "SELECT journal_id FROM native_pi_journal WHERE session_id=? AND entry_id IS NULL AND raw_json=? ORDER BY rowid LIMIT 1",
                    params![stored, message.to_string()],
                    |r| r.get(0),
                )
                .optional()?;
            if let Some(waiting) = waiting {
                tx.execute(
                    "UPDATE native_pi_journal SET entry_id=? WHERE journal_id=?",
                    params![entry_id, waiting],
                )?;
                waiting
            } else {
                persist_pi_message(
                    &tx,
                    PiRoute { stored, owner, bot },
                    &message,
                    None,
                    Some(entry_id),
                    entry.get("hexbot"),
                    true,
                )?
            }
        };
        tx.execute(
            "UPDATE native_pi_journal SET active=? WHERE journal_id=?",
            params![active.contains(entry_id), journal],
        )?;
        let seq: Option<i64> = tx.query_row(
            "SELECT projection_seq FROM native_pi_journal WHERE journal_id=?",
            [&journal],
            |r| r.get(0),
        )?;
        if let Some(seq) = seq {
            order.push(seq);
        }
    }
    reorder_projection(&tx, stored, &order)?;
    // Intents without a durable message belonged to the previous process.
    // Leaving them pending could hide a later, unrelated prompt with equal text.
    tx.execute(
        "DELETE FROM native_prompt_intents WHERE session_id=? AND consumed_by IS NULL",
        [stored],
    )?;
    tx.commit()?;
    Ok(())
}
fn entry_timestamp(entry: &Value) -> f64 {
    parsed_entry_timestamp(entry).unwrap_or_else(common::now)
}
fn parsed_entry_timestamp(entry: &Value) -> Option<f64> {
    entry["timestamp"]
        .as_str()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|d| d.timestamp_millis() as f64 / 1000.0)
}
/// Read a conversation for recovery: a torn final record is backed up and cut
/// so the next Pi append starts on a clean line. Only call this before the
/// section's process starts; a live file is read with `parse_pi_entries`.
fn read_pi_entries(path: &Path) -> Result<Vec<Value>> {
    let bytes = fs::read(path)?;
    let (entries, valid_end, torn) = parse_pi_entries(&bytes)?;
    if torn {
        // Preserve the complete damaged file, then remove only its incomplete
        // final record so the next Pi append starts on a clean line.
        let backup = path.with_file_name(format!("conversation.recovery-{}.jsonl", id()));
        common::atomic_write(&backup, &bytes)?;
        common::atomic_write(path, &bytes[..valid_end])?;
    } else if !bytes.is_empty() && !bytes.ends_with(b"\n") {
        let mut normalized = bytes;
        normalized.push(b'\n');
        common::atomic_write(path, &normalized)?;
    }
    Ok(entries)
}
/// Parse a conversation without touching it: the entries after the header,
/// the end of the last complete record, and whether the final record is torn.
fn parse_pi_entries(bytes: &[u8]) -> Result<(Vec<Value>, usize, bool)> {
    let mut entries = Vec::new();
    let mut offset = 0;
    let mut valid_end = 0;
    let mut seen = HashSet::new();
    let mut header = false;
    let mut torn = false;
    for line in bytes.split_inclusive(|byte| *byte == b'\n') {
        let end = offset + line.len();
        let final_line = end == bytes.len();
        let newline = line.last() == Some(&b'\n');
        if line.iter().all(u8::is_ascii_whitespace) {
            valid_end = end;
            offset = end;
            continue;
        }
        let entry: Value = match serde_json::from_slice(line) {
            Ok(entry) => entry,
            Err(_) if final_line && !newline => {
                torn = true;
                break;
            }
            Err(error) => {
                return Err(crate::Error::new(
                    5200,
                    format!("invalid conversation JSONL at byte {offset}: {error}"),
                ));
            }
        };
        if !header {
            if entry["type"] != "session" || entry["version"] != 3 {
                return Err(crate::Error::new(
                    5200,
                    "expected a version 3 conversation header",
                ));
            }
            header = true;
        } else {
            let id = common::required(&entry, "id")?;
            if !seen.insert(id.to_owned()) {
                return Err(crate::Error::new(5200, "duplicate conversation entry id"));
            }
            if let Some(parent) = entry["parentId"].as_str()
                && (parent == id || !seen.contains(parent))
            {
                return Err(crate::Error::new(
                    5200,
                    "conversation parent must name an earlier entry",
                ));
            }
            if !entry["parentId"].is_null() && !entry["parentId"].is_string() {
                return Err(crate::Error::new(5200, "invalid conversation parent id"));
            }
            if entry["type"] == "message" && !entry["message"].is_object() {
                return Err(crate::Error::new(
                    5200,
                    "invalid conversation message entry",
                ));
            }
            entries.push(entry);
        }
        valid_end = end;
        offset = end;
    }
    if !header {
        return Err(crate::Error::new(5200, "missing conversation header"));
    }
    Ok((entries, valid_end, torn))
}
/// The ids on the current branch: the last entry and its parents.
fn active_ids(entries: &[Value]) -> Result<HashSet<&str>> {
    let by_id = entries
        .iter()
        .filter_map(|entry| entry["id"].as_str().map(|id| (id, entry)))
        .collect::<HashMap<_, _>>();
    let mut active = HashSet::new();
    let mut current = entries.last();
    while let Some(entry) = current {
        let id = common::required(entry, "id")?;
        if !active.insert(id) {
            return Err(crate::Error::new(
                5200,
                "conversation contains a parent cycle",
            ));
        }
        current = entry["parentId"]
            .as_str()
            .and_then(|parent| by_id.get(parent).copied());
    }
    Ok(active)
}
/// The first display row still in Pi's verbatim context after its latest
/// compaction. Bind completed live appends without replaying messages, changing
/// their projections, or billing them again. An incomplete/unknown boundary is
/// an error, never evidence that every row was summarized.
pub fn summarised_before(home: &Path, stored: &str) -> Result<Option<i64>> {
    common::identifier(stored)?;
    let path = home
        .join("runtime/sessions")
        .join(stored)
        .join("conversation.jsonl");
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let uncertain = || {
        crate::Error::new(
            5200,
            "Cannot determine which conversation messages were summarized; the log and saved message journal do not yet agree",
        )
    };
    let (entries, _, torn) = parse_pi_entries(&bytes)?;
    if torn {
        return Err(uncertain());
    }
    let active = active_ids(&entries)?;
    let on_path = |entry: &&Value| entry["id"].as_str().is_some_and(|id| active.contains(id));
    let branch = entries.iter().filter(on_path).collect::<Vec<_>>();
    let Some(compact) = branch
        .iter()
        .rposition(|entry| entry["type"] == "compaction")
    else {
        return Ok(None);
    };
    let kept = branch[compact]["firstKeptEntryId"]
        .as_str()
        .ok_or_else(uncertain)?;
    // Pi uses the compaction's own id when it keeps no earlier entries.
    let first = branch[..=compact]
        .iter()
        .position(|entry| entry["id"] == kept)
        .ok_or_else(uncertain)?;
    let retained = branch[first..]
        .iter()
        .filter_map(|entry| entry["id"].as_str())
        .collect::<HashSet<_>>();
    let mut conn = open(home)?;
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    check_deleted(&tx, stored)?;
    let mut earlier = 0;
    let mut cutoff = None::<i64>;
    for entry in &entries {
        let message = match entry["type"].as_str() {
            Some("message") => entry["message"].clone(),
            Some("custom_message") => {
                json!({"role":"custom","content":entry["content"],"customType":entry["customType"],"display":entry["display"],"details":entry["details"],"timestamp":entry_timestamp(entry)*1000.0})
            }
            _ => continue,
        };
        let entry_id = common::required(entry, "id")?;
        let raw = message.to_string();
        let existing: Option<(String, String)> = tx.query_row(
            "SELECT journal_id,raw_json FROM native_pi_journal WHERE session_id=? AND entry_id=?",
            params![stored, entry_id], |r| Ok((r.get(0)?, r.get(1)?)),
        ).optional()?;
        let journal = if let Some((journal, recorded)) = existing {
            if recorded != raw {
                return Err(uncertain());
            }
            Some(journal)
        } else {
            // Consume occurrences in append order, including abandoned branches.
            // Equal text, timestamps, or tool arguments alone cannot identify an
            // event; the entire raw message and its multiplicity must agree.
            let waiting: Option<String> = tx.query_row(
                "SELECT journal_id FROM native_pi_journal WHERE session_id=? AND entry_id IS NULL AND raw_json=? ORDER BY rowid LIMIT 1",
                params![stored, raw], |r| r.get(0),
            ).optional()?;
            if let Some(journal) = &waiting {
                tx.execute(
                    "UPDATE native_pi_journal SET entry_id=? WHERE journal_id=?",
                    params![entry_id, journal],
                )?;
            }
            waiting
        };
        let Some(journal) = journal else {
            // The durable append may have beaten native event projection. A
            // visible message without a row cannot prove a seq cutoff. A record
            // the runtime journals only on recovery has no row to prove one.
            if projection(&message, None).is_some() && !journaled_on_recovery(&message) {
                return Err(uncertain());
            }
            continue;
        };
        let is_active = active.contains(entry_id);
        tx.execute(
            "UPDATE native_pi_journal SET active=? WHERE journal_id=? AND active<>?",
            params![is_active, journal, is_active],
        )?;
        let seq: Option<i64> = tx.query_row(
            "SELECT projection_seq FROM native_pi_journal WHERE journal_id=?",
            [&journal],
            |r| r.get(0),
        )?;
        if let Some(seq) = seq.filter(|_| is_active) {
            if retained.contains(entry_id) {
                cutoff = Some(cutoff.map_or(seq, |old| old.min(seq)));
            } else {
                earlier = earlier.max(seq);
            }
        }
    }
    // A fully summarized log has a finite boundary too: an event projected
    // before its next disk append must remain excluded from recall.
    let cutoff = cutoff.unwrap_or(earlier.checked_add(1).ok_or_else(uncertain)?);
    if earlier >= cutoff {
        return Err(uncertain());
    }
    let unknown: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM native_pi_journal WHERE session_id=? AND entry_id IS NULL AND projection_seq<?)",
        params![stored, cutoff], |r| r.get(0),
    )?;
    let ids = entries
        .iter()
        .filter_map(|entry| entry["id"].as_str())
        .collect::<HashSet<_>>();
    let lost = common::rows(
        &tx,
        "SELECT entry_id FROM native_pi_journal WHERE session_id=? AND entry_id IS NOT NULL",
        &[&stored],
    )?
    .iter()
    .any(|row| row["entry_id"].as_str().is_none_or(|id| !ids.contains(id)));
    if unknown || lost {
        return Err(uncertain());
    }
    tx.commit()?;
    Ok(Some(cutoff))
}
/// Summaries Pi wrote when it compacted this section's current branch in
/// `[since, until)`, oldest first, as `(timestamp, summary)`. Reads the
/// conversation file without changing it, so it is safe while Pi runs; a
/// section without one (legacy or deleted) has none.
pub fn compaction_summaries(
    home: &Path,
    stored: &str,
    since: f64,
    until: f64,
) -> Result<Vec<(f64, String)>> {
    common::identifier(stored)?;
    let path = home
        .join("runtime/sessions")
        .join(stored)
        .join("conversation.jsonl");
    let metadata = match fs::metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(error) => return Err(error.into()),
    };
    // A recent compaction requires a recent append. Leave idle files unread.
    // Allow for filesystems such as HFS+ that round mtimes to whole seconds.
    if metadata
        .modified()
        .ok()
        .and_then(|at| at.duration_since(std::time::UNIX_EPOCH).ok())
        .is_some_and(|at| at.as_secs_f64() < since - 1.0)
    {
        return Ok(vec![]);
    }
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(error) => return Err(error.into()),
    };
    let (entries, _, _) = parse_pi_entries(&bytes)?;
    let active = active_ids(&entries)?;
    Ok(entries
        .iter()
        .filter(|entry| entry["type"] == "compaction")
        .filter(|entry| entry["id"].as_str().is_some_and(|id| active.contains(id)))
        .filter_map(|entry| {
            let at = parsed_entry_timestamp(entry)?;
            let summary = entry["summary"].as_str()?;
            (at >= since && at < until).then(|| (at, summary.to_owned()))
        })
        .collect())
}
fn reorder_projection(conn: &Connection, stored: &str, source_order: &[i64]) -> Result<()> {
    let rows = common::rows(
        conn,
        "SELECT seq,message_json FROM native_messages WHERE session_id=? ORDER BY seq",
        &[&stored],
    )?;
    let linked = source_order.iter().copied().collect::<BTreeSet<_>>();
    let mut messages = BTreeMap::new();
    let mut extras: BTreeMap<Option<i64>, Vec<i64>> = BTreeMap::new();
    let mut preceding = None;
    for row in rows {
        let seq = row["seq"].as_i64().unwrap();
        messages.insert(seq, row["message_json"].as_str().unwrap_or("").to_owned());
        if linked.contains(&seq) {
            preceding = Some(seq);
        } else {
            extras.entry(preceding).or_default().push(seq);
        }
    }
    let mut order = extras.remove(&None).unwrap_or_default();
    for seq in source_order {
        order.push(*seq);
        order.extend(extras.remove(&Some(*seq)).unwrap_or_default());
    }
    for remaining in extras.into_values() {
        order.extend(remaining);
    }
    let old_order = messages.keys().copied().collect::<Vec<_>>();
    if order == old_order {
        return Ok(());
    }
    let links = common::rows(
        conn,
        "SELECT journal_id,projection_seq FROM native_pi_journal WHERE session_id=? AND projection_seq IS NOT NULL",
        &[&stored],
    )?;
    conn.execute("DELETE FROM native_messages WHERE session_id=?", [stored])?;
    let mut remap = HashMap::new();
    for (index, old) in order.iter().enumerate() {
        let seq = index as i64 + 1;
        remap.insert(*old, seq);
        conn.execute(
            "INSERT INTO native_messages(session_id,seq,message_json) VALUES (?,?,?)",
            params![stored, seq, messages[old]],
        )?;
    }
    for link in links {
        let old = link["projection_seq"].as_i64().unwrap();
        if let Some(seq) = remap.get(&old) {
            conn.execute(
                "UPDATE native_pi_journal SET projection_seq=? WHERE journal_id=?",
                params![seq, link["journal_id"].as_str()],
            )?;
        }
    }
    Ok(())
}

/// Recover every previously opened session before serving usage or catalog RPCs.
/// Unread conversations must count toward budgets and dreaming after a crash.
/// Records and returns the conversations a transient error kept from being
/// recovered. Catalog lookup skips them without rereading every Pi log. A
/// successful recovery on a later start makes them eligible again.
pub fn reconcile_all(home: &Path) -> Result<BTreeSet<String>> {
    let mut unrecovered = BTreeSet::new();
    let sessions = common::rows(
        &open(home)?,
        "SELECT stored_id,owner,bot FROM native_sessions WHERE stored_id NOT IN (SELECT session_id FROM native_deleted) ORDER BY stored_id",
        &[],
    )?;
    for session in sessions {
        let stored = common::required(&session, "stored_id")?;
        let path = home
            .join("runtime/sessions")
            .join(stored)
            .join("conversation.jsonl");
        // A quarantined section stays closed until someone puts a conversation
        // file back in place; that file then gets a fresh recovery attempt.
        let quarantined: bool = open(home)?.query_row(
            "SELECT EXISTS(SELECT 1 FROM native_quarantine WHERE session_id=?)",
            [stored],
            |r| r.get(0),
        )?;
        if quarantined {
            if !path.exists() {
                continue;
            }
            open(home)?.execute("DELETE FROM native_quarantine WHERE session_id=?", [stored])?;
        }
        if let Err(error) = reconcile(
            home,
            common::required(&session, "bot")?,
            stored,
            common::required(&session, "owner")?,
        ) {
            if !matches!(error.code, 5200 | 4302)
                || error
                    .data
                    .as_ref()
                    .is_some_and(|d| d["transient"] == true || d["quarantined"] == true)
            {
                eprintln!("Could not recover conversation {stored}: {error}");
                open(home)?.execute(
                    "INSERT OR IGNORE INTO native_unrecovered VALUES(?)",
                    [stored],
                )?;
                unrecovered.insert(stored.to_owned());
                continue;
            }
            eprintln!("Quarantining conversation {stored}: {}", error.message);
            // Record the failure first, so a failed rename cannot permit reopening.
            open(home)?.execute(
                "INSERT OR REPLACE INTO native_quarantine VALUES(?,?)",
                params![
                    stored,
                    "This conversation could not be recovered. Its files have been kept for repair."
                ],
            )?;
            if path.exists()
                && let Err(error) = fs::rename(
                    &path,
                    path.with_file_name(format!("conversation.quarantine-{}.jsonl", id())),
                )
            {
                eprintln!("Could not move damaged conversation {stored}: {error}");
            }
        } else {
            open(home)?.execute(
                "DELETE FROM native_unrecovered WHERE session_id=?",
                [stored],
            )?;
        }
    }
    Ok(unrecovered)
}

fn check_quarantine(home: &Path, stored: &str) -> Result<()> {
    check_deleted(&open(home)?, stored)?;
    let error: Option<String> = open(home)?
        .query_row(
            "SELECT error FROM native_quarantine WHERE session_id=?",
            [stored],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(error) = error {
        return Err(crate::Error::new(5200, error).with_data(json!({"quarantined":true})));
    }
    Ok(())
}

pub(crate) fn check_deleted(conn: &Connection, stored: &str) -> Result<()> {
    let deleted: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM native_deleted WHERE session_id=?)",
        [stored],
        |r| r.get(0),
    )?;
    if deleted {
        return Err(crate::Error::new(4001, "The section was deleted"));
    }
    Ok(())
}

#[cfg(test)]
mod deletion_attempt_tests {
    use super::*;

    #[test]
    fn unknown_retirement_never_gains_a_branch_during_restart() {
        let home = tempfile::tempdir().unwrap();
        let h = home.path();
        crate::db::migrate(h).unwrap();
        let conn = open(h).unwrap();
        conn.execute("INSERT INTO native_sessions VALUES('child','local','owl','KEEP','{\"parent_session\":\"unknown\"}')", []).unwrap();
        append(h, "child", json!({"role":"user","text":"KEEP"})).unwrap();
        fs::write(
            session_dir(h, "child").unwrap().join("conversation.jsonl"),
            "RAW",
        )
        .unwrap();
        let before = history(h, "child").unwrap();
        let retirement = mark_retiring(h, "unknown").unwrap();
        assert_eq!(retirement.targets, ["unknown"]);
        for _ in 0..2 {
            finish_deletes(h).unwrap();
            assert_eq!(history(h, "child").unwrap(), before);
            assert_eq!(
                fs::read(session_dir(h, "child").unwrap().join("conversation.jsonl")).unwrap(),
                b"RAW"
            );
            assert_eq!(
                conn.query_row(
                    "SELECT count(*) FROM native_deleted WHERE session_id='child'",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
                0
            );
        }
        // Explicit store deletion remains a separate destructive operation.
        delete(h, "unknown").unwrap();
        assert!(history(h, "child").unwrap().is_empty());
    }

    #[test]
    fn overlapping_retirements_release_only_their_own_provisional_markers() {
        for legacy_only in [false, true] {
            for committed in [false, true] {
                let home = tempfile::tempdir().unwrap();
                let h = home.path();
                crate::db::migrate(h).unwrap();
                crate::db::open(h)
                    .unwrap()
                    .execute(
                        "INSERT INTO sections(id,bot,owner_id) VALUES('parent','owl','local')",
                        [],
                    )
                    .unwrap();
                let conn = open(h).unwrap();
                if !legacy_only {
                    conn.execute(
                        "INSERT INTO native_sessions VALUES('parent','local','owl','frozen','{}')",
                        [],
                    )
                    .unwrap();
                }
                conn.execute("INSERT INTO native_sessions VALUES('child','local','owl','child prompt','{\"parent_session\":\"parent\"}')", []).unwrap();
                let first = mark_retiring(h, "parent").unwrap();
                let second = mark_retiring(h, "child").unwrap();
                rollback_retiring(h, &first).unwrap();
                // The overlapping child attempt still owns its provisional
                // marker. The otherwise untouched parent can already reopen.
                assert!(session_dir(h, "parent").is_ok());
                assert_eq!(session_dir(h, "child").unwrap_err().code, 4001);
                if committed {
                    with_section_delete(h, "child", "owl", "local", false, || Ok(())).unwrap();
                }
                rollback_retiring(h, &second).unwrap();
                assert_eq!(session_dir(h, "child").is_err(), committed);
                if committed {
                    let row = common::rows(
                        &conn,
                        "SELECT * FROM native_delete_options WHERE session_id='child'",
                        &[],
                    )
                    .unwrap();
                    assert_eq!(row[0]["purge"], 0);
                    assert_eq!(row[0]["bot"], "owl");
                    assert_eq!(row[0]["owner"], "local");
                }
            }
        }
    }

    #[test]
    fn late_retirement_rollback_keeps_completed_purges_and_legacy_only_ownership() {
        let home = tempfile::tempdir().unwrap();
        let h = home.path();
        crate::db::migrate(h).unwrap();
        crate::db::open(h)
            .unwrap()
            .execute(
                "INSERT INTO sections(id,bot,owner_id) VALUES('parent','owl','local')",
                [],
            )
            .unwrap();
        let first = mark_retiring(h, "parent").unwrap();
        let second = mark_retiring(h, "parent").unwrap();
        with_section_delete(h, "parent", "owl", "local", true, || {
            crate::db::open(h)?.execute("DELETE FROM sections WHERE id='parent'", [])?;
            Ok(())
        })
        .unwrap();
        delete_pending(h, "parent").unwrap();
        for retirement in [&first, &second] {
            rollback_retiring(h, retirement).unwrap();
            assert_eq!(session_dir(h, "parent").unwrap_err().code, 4001);
            assert!(delete_completed(&open(h).unwrap(), "parent").unwrap());
        }
        let rows = owned_sessions(h, "owl").unwrap();
        assert!(rows.is_empty());
        let conn = open(h).unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT owner FROM native_delete_options WHERE session_id='parent'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "local"
        );
    }

    #[test]
    fn bot_journal_startup_rollback_keeps_independently_committed_children() {
        for purge in [false, true] {
            for final_marker_fault in [false, true] {
                let home = common::TestHome::new();
                let h = home.path();
                let app = crate::server::App::new(
                    h.into(),
                    "127.0.0.1:0".parse().unwrap(),
                    h.join("unused-pi"),
                    None,
                )
                .unwrap();
                let made =
                    crate::catalog::call(h, "local", "hexbot.bots.create", &json!({"name":"owl"}))
                        .unwrap()
                        .unwrap();
                let root = made["section"]["id"].as_str().unwrap();
                let native = open(h).unwrap();
                crate::db::open(h).unwrap().execute("INSERT INTO sections(id,bot,owner_id,peer_bot) VALUES('child','owl','local','owl')",[]).unwrap();
                for (stored, parent) in [
                    (root, None),
                    ("child", Some(root)),
                    ("grandchild", Some("child")),
                ] {
                    native.execute("INSERT INTO native_sessions VALUES(?,'local','owl','original prompt',?)",params![stored,json!({"parent_session":parent}).to_string()]).unwrap();
                    append(h, stored, json!({"role":"user","text":"original history"})).unwrap();
                }
                crate::catalog::retire_bot_delete(h, "local", "owl").unwrap();
                if final_marker_fault {
                    native.execute_batch("CREATE TRIGGER refuse_child_finalization BEFORE DELETE ON native_delete_pending WHEN OLD.session_id='child' BEGIN SELECT RAISE(ABORT,'child final marker fault'); END").unwrap();
                }
                let result = crate::catalog::call(
                    h,
                    "local",
                    "hexbot.sections.delete",
                    &json!({"id":"child","purge_memory":purge}),
                )
                .unwrap()
                .unwrap();
                assert_eq!(result["deleted"], true);
                assert_eq!(result["history_pending"] == true, final_marker_fault);
                if final_marker_fault {
                    native
                        .execute_batch("DROP TRIGGER refuse_child_finalization")
                        .unwrap();
                }
                finish_deletes(h).unwrap();
                assert!(crate::catalog::bot(h, "local", "owl").is_ok());
                append(h, root, json!({"role":"user","text":"live parent"})).unwrap();
                for stored in ["child", "grandchild"] {
                    assert_eq!(
                        append(h, stored, json!({"role":"user","text":"late"}))
                            .unwrap_err()
                            .code,
                        4001
                    );
                    assert_eq!(history(h, stored).unwrap().len(), usize::from(!purge));
                    if !purge {
                        let saved = common::rows(
                            &native,
                            "SELECT prompt,options FROM native_sessions WHERE stored_id=?",
                            &[&stored],
                        )
                        .unwrap();
                        assert_eq!(saved[0]["prompt"], "original prompt");
                        assert_eq!(
                            native
                                .query_row(
                                    "SELECT purge FROM native_delete_options WHERE session_id=?",
                                    [stored],
                                    |r| r.get::<_, bool>(0)
                                )
                                .unwrap(),
                            purge
                        );
                    }
                }
                drop(app);
            }
        }
    }

    #[test]
    fn room_retirement_startup_uses_its_catalog_decision_and_keeps_child_commit() {
        let home = tempfile::tempdir().unwrap();
        let h = home.path();
        crate::db::migrate(h).unwrap();
        crate::db::open(h).unwrap().execute_batch("INSERT INTO rooms(id,name,owner_id) VALUES('room','Room','local'); INSERT INTO sections(id,bot,owner_id) VALUES('child','owl','local');").unwrap();
        let native = open(h).unwrap();
        for (stored, parent) in [
            ("root", None),
            ("child", Some("root")),
            ("grandchild", Some("child")),
        ] {
            native
                .execute(
                    "INSERT INTO native_sessions VALUES(?,'local','owl','frozen',?)",
                    params![stored, json!({"parent_session":parent}).to_string()],
                )
                .unwrap();
            append(h, stored, json!({"role":"user","text":"keep history"})).unwrap();
        }
        let retirement = mark_room_retiring(h, "root", "room").unwrap();
        with_section_delete(h, "child", "owl", "local", false, || {
            crate::db::open(h)?.execute("DELETE FROM sections WHERE id='child'", [])?;
            Ok(())
        })
        .unwrap();
        finish_deletes(h).unwrap();
        rollback_retiring(h, &retirement).unwrap();
        append(h, "root", json!({"role":"user","text":"room still live"})).unwrap();
        for stored in ["child", "grandchild"] {
            assert_eq!(
                append(h, stored, json!({"role":"user","text":"late"}))
                    .unwrap_err()
                    .code,
                4001
            );
            assert_eq!(history(h, stored).unwrap().len(), 1);
            assert_eq!(
                native
                    .query_row(
                        "SELECT prompt FROM native_sessions WHERE stored_id=?",
                        [stored],
                        |r| r.get::<_, String>(0)
                    )
                    .unwrap(),
                "frozen"
            );
        }
    }

    #[test]
    fn old_journal_startup_reopens_only_its_unrecorded_markers() {
        let home = tempfile::tempdir().unwrap();
        let h = home.path();
        crate::db::migrate(h).unwrap();
        crate::db::open(h).unwrap().execute_batch("INSERT INTO bots(name,owner_id) VALUES('owl','local'),('fox','local'); INSERT INTO sections(id,bot,owner_id) VALUES('chat','owl','local');").unwrap();
        let native = open(h).unwrap();
        for (stored, bot, parent) in [
            ("chat", "owl", None),
            ("delegate", "owl", Some("chat")),
            ("hidden", "owl", None),
            ("claimed", "owl", Some("chat")),
            ("retained", "owl", Some("chat")),
            ("completed", "owl", Some("chat")),
            ("unrelated", "fox", None),
        ] {
            native
                .execute(
                    "INSERT INTO native_sessions VALUES(?,'local',?,'frozen',?)",
                    params![stored, bot, json!({"parent_session":parent}).to_string()],
                )
                .unwrap();
            append(h, stored, json!({"role":"user","text":"original"})).unwrap();
        }
        // Earlier-build markers, beside another attempt's committed claim,
        // recorded retention and completion, and an unrelated old deletion.
        native.execute_batch("INSERT INTO native_deleted VALUES('chat'),('delegate'),('hidden'),('claimed'),('retained'),('completed'),('unrelated');
            INSERT INTO native_delete_pending VALUES('claimed','gone-section',1);
            INSERT INTO native_delete_claims VALUES('other-attempt','claimed');
            INSERT INTO native_delete_options VALUES('claimed','owl','local',0),('retained','owl','local',0),('completed','owl','local',1);
            INSERT INTO native_delete_completed VALUES('completed');").unwrap();
        let targets = [
            "chat",
            "delegate",
            "hidden",
            "claimed",
            "retained",
            "completed",
        ]
        .map(|id| json!({"id":id,"owner":"local"}));
        crate::db::open(h)
            .unwrap()
            .execute(
                "INSERT INTO settings(key,value) VALUES('pending_bot_delete:owl',?)",
                [json!({"targets":targets,"committed":false,"name_reserved":true}).to_string()],
            )
            .unwrap();
        for _ in 0..2 {
            finish_deletes(h).unwrap();
            assert!(
                crate::catalog::pending_bot_delete_targets(h)
                    .unwrap()
                    .is_empty()
            );
            for stored in ["chat", "delegate", "hidden"] {
                assert!(session_dir(h, stored).is_ok(), "{stored}");
                assert_eq!(history(h, stored).unwrap().len(), 1);
            }
            for (stored, kept) in [
                ("claimed", 1),
                ("retained", 1),
                ("completed", 1),
                ("unrelated", 0),
            ] {
                assert_eq!(session_dir(h, stored).unwrap_err().code, 4001, "{stored}");
                assert_eq!(history(h, stored).unwrap().len(), kept, "{stored}");
            }
            assert!(delete_completed(&native, "unrelated").unwrap());
        }
    }

    #[test]
    fn old_catalog_recovery_keeps_foreign_and_recorded_decisions_closed() {
        let home = tempfile::tempdir().unwrap();
        let h = home.path();
        crate::db::migrate(h).unwrap();
        crate::db::open(h).unwrap().execute_batch("INSERT INTO bots(name,owner_id) VALUES('owl','local');
            INSERT INTO sections(id,bot,owner_id) VALUES('live','owl','local'),('mismatched','owl','local'),('committed-child','owl','local');").unwrap();
        let native = open(h).unwrap();
        for (stored, bot, owner, parent) in [
            ("live", "owl", "local", None),
            ("delegate", "owl", "local", Some("live")),
            ("foreign-bot", "fox", "local", Some("live")),
            ("foreign-owner", "owl", "bob", Some("live")),
            ("beyond-foreign", "owl", "local", Some("foreign-bot")),
            ("mismatched", "owl", "bob", None),
            ("committed-child", "owl", "local", Some("live")),
            ("completed-child", "owl", "local", Some("live")),
            ("retained-child", "owl", "local", Some("live")),
        ] {
            native
                .execute(
                    "INSERT INTO native_sessions VALUES(?,?,?,'frozen',?)",
                    params![
                        stored,
                        owner,
                        bot,
                        json!({"parent_session":parent}).to_string()
                    ],
                )
                .unwrap();
            append(h, stored, json!({"role":"user","text":"original"})).unwrap();
            native
                .execute("INSERT INTO native_deleted VALUES(?)", [stored])
                .unwrap();
        }
        native.execute_batch("INSERT INTO native_delete_options VALUES('committed-child','owl','local',1),('completed-child','owl','local',1),('retained-child','owl','local',0);
            INSERT INTO native_delete_pending VALUES('committed-child','absent-decision',1);
            INSERT INTO native_delete_completed VALUES('completed-child');
            CREATE TABLE IF NOT EXISTS native_delete_legacy(session_id TEXT NOT NULL REFERENCES native_delete_options(session_id) ON DELETE CASCADE,legacy_id TEXT NOT NULL,PRIMARY KEY(session_id,legacy_id));
            INSERT INTO native_delete_legacy VALUES('committed-child','saved-legacy-alias');
            CREATE TRIGGER fail_committed_cleanup BEFORE DELETE ON native_sessions WHEN OLD.stored_id='committed-child' BEGIN SELECT RAISE(ABORT,'committed cleanup fault'); END;
            CREATE TRIGGER keep_unknown BEFORE DELETE ON native_sessions WHEN OLD.stored_id IN ('foreign-bot','foreign-owner','beyond-foreign','mismatched') BEGIN SELECT RAISE(ABORT,'preserve boundary control for inspection'); END;").unwrap();
        for _ in 0..2 {
            let error = finish_deletes(h).unwrap_err();
            assert_eq!(error.code, 5200);
            assert!(
                error
                    .message
                    .contains("preserve boundary control for inspection")
                    || error
                        .message
                        .contains("legacy profile ownership is unknown")
            );
            for stored in ["live", "delegate"] {
                assert!(session_dir(h, stored).is_ok(), "{stored}");
                assert_eq!(history(h, stored).unwrap().len(), 1);
            }
            for stored in [
                "foreign-bot",
                "foreign-owner",
                "beyond-foreign",
                "mismatched",
                "committed-child",
                "completed-child",
                "retained-child",
            ] {
                assert_eq!(
                    append(h, stored, json!({"role":"user","text":"late"}))
                        .unwrap_err()
                        .code,
                    4001,
                    "{stored}"
                );
            }
            assert!(!delete_completed(&native, "committed-child").unwrap());
            assert_eq!(native.query_row("SELECT legacy_id FROM native_delete_legacy WHERE session_id='committed-child' AND legacy_id='saved-legacy-alias'",[],|r|r.get::<_,String>(0)).unwrap(),"saved-legacy-alias");
            assert_eq!(history(h, "committed-child").unwrap().len(), 1);
            assert_eq!(history(h, "retained-child").unwrap().len(), 1);
            assert_eq!(history(h, "completed-child").unwrap().len(), 1);
        }
        native
            .execute_batch("DROP TRIGGER fail_committed_cleanup")
            .unwrap();
        // Unknown/foreign cleanup faults still report failure after this
        // independent committed child finishes. Every terminal check remains.
        let error = finish_deletes(h).unwrap_err();
        assert_eq!(error.code, 5200);
        assert!(
            error
                .message
                .contains("preserve boundary control for inspection")
                || error
                    .message
                    .contains("legacy profile ownership is unknown")
        );
        assert_eq!(session_dir(h, "committed-child").unwrap_err().code, 4001);
        assert!(history(h, "committed-child").unwrap().is_empty());
        assert!(delete_completed(&native, "committed-child").unwrap());
    }

    #[test]
    fn old_committed_child_under_an_unmarked_live_parent_stays_terminal() {
        let home = tempfile::tempdir().unwrap();
        let h = home.path();
        crate::db::migrate(h).unwrap();
        crate::db::open(h)
            .unwrap()
            .execute(
                "INSERT INTO sections(id,bot,owner_id) VALUES('live','owl','local')",
                [],
            )
            .unwrap();
        let native = open(h).unwrap();
        for (stored, parent) in [("live", None), ("committed", Some("live"))] {
            native
                .execute(
                    "INSERT INTO native_sessions VALUES(?,'local','owl','frozen',?)",
                    params![stored, json!({"parent_session":parent}).to_string()],
                )
                .unwrap();
            append(h, stored, json!({"role":"user","text":"original"})).unwrap();
        }
        // The old child's catalog decision committed. Its healthy parent was
        // never retired, so that parent's existence cannot reverse the delete.
        native
            .execute("INSERT INTO native_deleted VALUES('committed')", [])
            .unwrap();
        for _ in 0..2 {
            finish_deletes(h).unwrap();
            assert!(session_dir(h, "live").is_ok());
            assert_eq!(history(h, "live").unwrap().len(), 1);
            assert_eq!(session_dir(h, "committed").unwrap_err().code, 4001);
            assert!(history(h, "committed").unwrap().is_empty());
            assert!(delete_completed(&native, "committed").unwrap());
        }
    }
}
