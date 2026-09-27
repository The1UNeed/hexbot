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
    time::Duration,
};

pub fn open(home: &Path) -> Result<Connection> {
    fs::create_dir_all(home)?;
    let conn = Connection::open(home.join("hexbot-runtime.db"))?;
    conn.busy_timeout(Duration::from_secs(5))?;
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS native_sessions(stored_id TEXT PRIMARY KEY,owner TEXT NOT NULL,bot TEXT NOT NULL,prompt TEXT NOT NULL,options TEXT NOT NULL DEFAULT '{}');
      CREATE TABLE IF NOT EXISTS native_live_sessions(stored_id TEXT PRIMARY KEY REFERENCES native_sessions(stored_id) ON DELETE CASCADE,live_id TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS native_messages(session_id TEXT NOT NULL,seq INTEGER NOT NULL,message_json TEXT NOT NULL,PRIMARY KEY(session_id,seq));
      CREATE TABLE IF NOT EXISTS native_usage(id INTEGER PRIMARY KEY,session_id TEXT NOT NULL,owner_id TEXT NOT NULL,bot TEXT NOT NULL,model TEXT NOT NULL,provider TEXT NOT NULL,input_tokens INTEGER NOT NULL,output_tokens INTEGER NOT NULL,cache_read_tokens INTEGER NOT NULL,cache_write_tokens INTEGER NOT NULL,cost REAL NOT NULL,timestamp REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS native_pi_journal(journal_id TEXT PRIMARY KEY,session_id TEXT NOT NULL,raw_json TEXT NOT NULL,entry_id TEXT,projection_seq INTEGER,usage_id INTEGER UNIQUE,active INTEGER NOT NULL DEFAULT 1,UNIQUE(session_id,entry_id));
      CREATE INDEX IF NOT EXISTS idx_native_pi_journal_session ON native_pi_journal(session_id);
      CREATE TABLE IF NOT EXISTS native_prompt_intents(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,text TEXT NOT NULL,display_kind TEXT NOT NULL,created_at REAL NOT NULL,consumed_by TEXT);
      CREATE INDEX IF NOT EXISTS idx_native_prompt_intents_session ON native_prompt_intents(session_id,consumed_by);
      CREATE TABLE IF NOT EXISTS native_summaries(session_id TEXT PRIMARY KEY, message_count INTEGER NOT NULL, preview TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS native_deleted(session_id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS native_quarantine(session_id TEXT PRIMARY KEY, error TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS summary_session_insert AFTER INSERT ON native_sessions BEGIN DELETE FROM native_summaries WHERE session_id=NEW.stored_id; END;
      CREATE TRIGGER IF NOT EXISTS summary_journal_insert AFTER INSERT ON native_pi_journal BEGIN DELETE FROM native_summaries WHERE session_id=NEW.session_id; END;
      CREATE TRIGGER IF NOT EXISTS summary_message_insert AFTER INSERT ON native_messages BEGIN DELETE FROM native_summaries WHERE session_id=NEW.session_id; END;
      CREATE TRIGGER IF NOT EXISTS summary_message_update AFTER UPDATE ON native_messages BEGIN DELETE FROM native_summaries WHERE session_id=NEW.session_id; END;
      CREATE TRIGGER IF NOT EXISTS summary_message_delete AFTER DELETE ON native_messages BEGIN DELETE FROM native_summaries WHERE session_id=OLD.session_id; END;
      CREATE TRIGGER IF NOT EXISTS summary_journal_update AFTER UPDATE ON native_pi_journal BEGIN DELETE FROM native_summaries WHERE session_id=NEW.session_id; END;")?;
    crate::db::migrate_runtime(&conn)?;
    Ok(conn)
}
pub fn history(home: &Path, stored: &str) -> Result<Vec<Value>> {
    let conn = open(home)?;
    let mut stmt =
        conn.prepare("SELECT m.message_json FROM native_messages m LEFT JOIN native_pi_journal p ON p.session_id=m.session_id AND p.projection_seq=m.seq WHERE m.session_id=? AND (p.active IS NULL OR p.active=1) ORDER BY m.seq")?;
    let rows = stmt.query_map([stored], |r| r.get::<_, String>(0))?;
    rows.map(|r| {
        let s = r?;
        serde_json::from_str(&s).map_err(|e| crate::Error::new(5200, e.to_string()))
    })
    .collect()
}
pub fn append(home: &Path, stored: &str, mut message: Value) -> Result<()> {
    let conn = open(home)?;
    check_deleted(&conn, stored)?;
    if message.get("timestamp").is_none() {
        message["timestamp"] = json!(common::now());
    }
    if message.get("row_id").is_none() {
        message["row_id"] = json!(id());
    }
    conn.execute("INSERT INTO native_messages(session_id,seq,message_json) SELECT ?1,COALESCE(MAX(seq),0)+1,?2 FROM native_messages WHERE session_id=?1",params![stored,message.to_string()])?;
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
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let cached: Option<(i64, String)> = tx
        .query_row(
            "SELECT message_count,preview FROM native_summaries WHERE session_id=?",
            [stored],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let (count, preview) = if let Some(cached) = cached {
        cached
    } else {
        let count: i64 = tx.query_row("SELECT COUNT(*) FROM native_messages m LEFT JOIN native_pi_journal p ON p.session_id=m.session_id AND p.projection_seq=m.seq WHERE m.session_id=? AND (p.active IS NULL OR p.active=1)", [stored], |r| r.get(0))?;
        let text: String = tx.query_row("SELECT COALESCE(json_extract(m.message_json,'$.text'),'') FROM native_messages m LEFT JOIN native_pi_journal p ON p.session_id=m.session_id AND p.projection_seq=m.seq WHERE m.session_id=? AND (p.active IS NULL OR p.active=1) AND json_extract(m.message_json,'$.role')='user' AND COALESCE(json_extract(m.message_json,'$.display_kind'),'normal')<>'hidden' ORDER BY m.seq LIMIT 1", [stored], |r| r.get(0)).optional()?.unwrap_or_default();
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
    common::rows(&open(home)?, "WITH RECURSIVE tree(id) AS (SELECT ?1 UNION SELECT s.stored_id FROM native_sessions s JOIN tree t ON json_extract(s.options,'$.parent_session')=t.id) SELECT id FROM tree", &[&stored])?
        .into_iter().map(|row| common::required(&row,"id").map(str::to_owned)).collect()
}
pub fn mark_deleted(home: &Path, stored: &str) -> Result<Vec<String>> {
    let mut conn = open(home)?;
    let tx = conn.transaction()?;
    let targets = descendants(home, stored)?;
    for target in &targets {
        tx.execute("INSERT OR IGNORE INTO native_deleted VALUES(?)", [target])?;
    }
    tx.commit()?;
    Ok(targets)
}
pub fn unmark_deleted(home: &Path, stored: &str) -> Result<()> {
    let mut conn = open(home)?;
    let tx = conn.transaction()?;
    for target in descendants(home, stored)? {
        tx.execute("DELETE FROM native_deleted WHERE session_id=?", [target])?;
    }
    tx.commit()?;
    Ok(())
}
pub fn delete(home: &Path, stored: &str) -> Result<()> {
    common::identifier(stored)?;
    let targets = descendants(home, stored)?;
    for stored in targets.iter().rev() {
        let mut conn = open(home)?;
        let tx = conn.transaction()?;
        tx.execute("INSERT OR IGNORE INTO native_deleted VALUES(?)", [stored])?;
        tx.execute("DELETE FROM native_summaries WHERE session_id=?", [stored])?;
        tx.execute("DELETE FROM native_quarantine WHERE session_id=?", [stored])?;
        tx.execute("DELETE FROM native_pi_journal WHERE session_id=?", [stored])?;
        tx.execute(
            "DELETE FROM native_prompt_intents WHERE session_id=?",
            [stored],
        )?;
        tx.execute("DELETE FROM native_messages WHERE session_id=?", [stored])?;
        tx.execute("DELETE FROM native_sessions WHERE stored_id=?", [stored])?;
        tx.commit()?;
        let path = home.join("runtime/sessions").join(stored);
        if path.exists() {
            fs::remove_dir_all(path)?;
        }
    }
    Ok(())
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
    conn.query_row("SELECT COALESCE(SUM(input_tokens),0),COALESCE(SUM(output_tokens),0),COALESCE(SUM(cache_read_tokens),0),COALESCE(SUM(cache_write_tokens),0),COALESCE(SUM(cost),0) FROM native_usage WHERE session_id=?",[stored],|r|{
        let input:i64=r.get(0)?;let output:i64=r.get(1)?;let read:i64=r.get(2)?;let write:i64=r.get(3)?;
        Ok(json!({"input_tokens":input,"output_tokens":output,"cache_read_tokens":read,"cache_write_tokens":write,"total_tokens":input+output+read+write,"cost":r.get::<_,f64>(4)?}))
    }).map_err(Into::into)
}
pub fn usage_rows(home: &Path) -> Result<Vec<Value>> {
    common::rows(&open(home)?, "SELECT * FROM native_usage", &[])
}
pub fn record_usage(
    home: &Path,
    stored: &str,
    owner: &str,
    bot: &str,
    message: &Value,
) -> Result<()> {
    let u = &message["usage"];
    if !u.is_object() {
        return Ok(());
    }
    open(home)?.execute("INSERT INTO native_usage(session_id,owner_id,bot,model,provider,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cost,timestamp) VALUES(?,?,?,?,?,?,?,?,?,?,?)",params![stored,owner,bot,message["model"].as_str().unwrap_or(""),message["provider"].as_str().unwrap_or(""),u["input"].as_i64().unwrap_or(0),u["output"].as_i64().unwrap_or(0),u["cacheRead"].as_i64().unwrap_or(0),u["cacheWrite"].as_i64().unwrap_or(0),u["cost"]["total"].as_f64().unwrap_or(0.),common::now()])?;
    Ok(())
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
    if path.exists() {
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
                let mut projection = json!({"role":role,"text":body,"row_id":format!("legacy-{}",row["id"]),"display_kind":row["display_kind"],"timestamp":row["timestamp"]});
                let message = match role {
                    "user" => {
                        let content = if let Some(blocks) = parsed.as_array() {
                            json!(blocks.iter().filter_map(|block|{
                            if block["type"]=="text"{return Some(block.clone());}
                            if block["type"]=="image_url"{let url=block["image_url"]["url"].as_str()?;if let Some((header,data))=url.strip_prefix("data:").and_then(|u|u.split_once(";base64,")){return Some(json!({"type":"image","mimeType":header,"data":data}));}return Some(json!({"type":"text","text":format!("Image: {url}")}));}
                            if block["type"]=="image"{return Some(block.clone());}None
                        }).collect::<Vec<_>>())
                        } else {
                            parsed
                        };
                        json!({"role":"user","content":content,"timestamp":ts})
                    }
                    "assistant" => {
                        let mut blocks = vec![];
                        if !body.is_empty() {
                            blocks.push(json!({"type":"text","text":body}));
                        }
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
                        json!({"role":"assistant","content":blocks,"api":"openai-completions","provider":"imported","model":"legacy","usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"totalTokens":0,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"stop","timestamp":ts})
                    }
                    "tool" => {
                        projection["name"] = row["tool_name"].clone();
                        json!({"role":"toolResult","toolCallId":row["tool_call_id"],"toolName":row["tool_name"],"content":[{"type":"text","text":body}],"isError":false,"timestamp":ts})
                    }
                    _ => continue,
                };
                if context {
                    raw.push((row["id"].as_i64().unwrap_or(0), message, projection.clone()));
                }
                projected.push(projection);
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
    let mut conn = open(home)?;
    let tx = conn.transaction()?;
    let count: i64 = tx.query_row(
        "SELECT COUNT(*) FROM native_messages WHERE session_id=?",
        [stored],
        |r| r.get(0),
    )?;
    if count == 0 {
        for (i, message) in projected.iter().enumerate() {
            tx.execute(
                "INSERT INTO native_messages VALUES(?,?,?)",
                params![stored, i + 1, message.to_string()],
            )?;
        }
    }
    tx.commit()?;
    // Write the import marker only after its transcript transaction commits.
    // A crash before this point can safely repeat the import on next startup.
    common::atomic_write(&target, format!("{}\n", lines.join("\n")).as_bytes())?;
    Ok(())
}

/// Commit display metadata before sending a prompt to Pi. Matching by final text
/// survives a daemon crash between Pi's JSONL append and the message_end handler.
pub fn stage_prompt(home: &Path, stored: &str, text: &str, display: &str) -> Result<String> {
    common::identifier(stored)?;
    if !matches!(display, "normal" | "hidden") {
        return Err(crate::Error::new(4202, "invalid prompt display kind"));
    }
    let id = id();
    open(home)?.execute("INSERT INTO native_prompt_intents(id,session_id,text,display_kind,created_at) VALUES (?,?,?,?,?)",params![id,stored,text,display,common::now()])?;
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
/// before its SessionManager appends that entry to disk.
pub fn project_message(
    home: &Path,
    stored: &str,
    owner: &str,
    bot: &str,
    message: &Value,
    display: Option<&str>,
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
        None,
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
            let calls=message["content"].as_array().into_iter().flatten().filter(|block|block["type"]=="toolCall").map(|block|json!({"id":block["id"],"type":"function","function":{"name":block["name"],"arguments":block["arguments"].to_string()}})).collect::<Vec<_>>();
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
            result["name"] = message["toolName"].clone();
            result["tool_name"] = message["toolName"].clone();
            result["tool_id"] = message["toolCallId"].clone();
            result["tool_call_id"] = message["toolCallId"].clone();
            result["is_error"] = message["isError"].clone();
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
        let intent:Option<(String,String)>=conn.query_row("SELECT id,display_kind FROM native_prompt_intents WHERE session_id=? AND text=? AND consumed_by IS NULL ORDER BY created_at,rowid LIMIT 1",params![stored,body],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
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
            projected[key] = value.clone();
        }
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
            conn.query_row("SELECT u.id FROM native_usage u WHERE session_id=? AND owner_id=? AND bot=? AND model=? AND provider=? AND input_tokens=? AND output_tokens=? AND cache_read_tokens=? AND cache_write_tokens=? AND cost=? AND NOT EXISTS(SELECT 1 FROM native_pi_journal p WHERE p.usage_id=u.id) ORDER BY u.id LIMIT 1",params![stored,owner,bot,model,provider,values.0,values.1,values.2,values.3,values.4],|r|r.get(0)).optional()?
        } else {
            None
        };
        Some(if let Some(id) = existing {
            id
        } else {
            conn.execute("INSERT INTO native_usage(session_id,owner_id,bot,model,provider,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cost,timestamp) VALUES(?,?,?,?,?,?,?,?,?,?,?)",params![stored,owner,bot,model,provider,values.0,values.1,values.2,values.3,values.4,message_timestamp(message)])?;
            conn.last_insert_rowid()
        })
    } else {
        None
    };
    conn.execute("INSERT INTO native_pi_journal(journal_id,session_id,raw_json,entry_id,projection_seq,usage_id) VALUES (?,?,?,?,?,?)",params![journal,stored,raw,entry,projection_seq,usage_id])?;
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
    if !path.exists() {
        return Ok(());
    }
    let entries = read_pi_entries(&path)?;
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
    let mut conn = open(home)?;
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
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
            "usage" | "compaction" | "branch_summary" if entry["usage"].is_object() => Some(
                json!({"role":"usage","usage":entry["usage"],"provider":entry["provider"].as_str().unwrap_or(&model.0),"model":entry["model"].as_str().unwrap_or(&model.1),"timestamp":entry_timestamp(entry)*1000.0}),
            ),
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
            let waiting:Option<String>=tx.query_row("SELECT journal_id FROM native_pi_journal WHERE session_id=? AND entry_id IS NULL AND raw_json=? ORDER BY rowid LIMIT 1",params![stored,message.to_string()],|r|r.get(0)).optional()?;
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
    entry["timestamp"]
        .as_str()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|d| d.timestamp_millis() as f64 / 1000.0)
        .unwrap_or_else(common::now)
}
fn read_pi_entries(path: &Path) -> Result<Vec<Value>> {
    let bytes = fs::read(path)?;
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
pub fn reconcile_all(home: &Path) -> Result<()> {
    let sessions = common::rows(
        &open(home)?,
        "SELECT stored_id,owner,bot FROM native_sessions ORDER BY stored_id",
        &[],
    )?;
    for session in sessions {
        let stored = common::required(&session, "stored_id")?;
        if let Err(error) = reconcile(
            home,
            common::required(&session, "bot")?,
            stored,
            common::required(&session, "owner")?,
        ) {
            if !matches!(error.code, 5200 | 4302)
                || error.data.as_ref().is_some_and(|d| d["transient"] == true)
            {
                eprintln!("Could not recover conversation {stored}: {error}");
                continue;
            }
            eprintln!("Quarantining conversation {stored}: {}", error.message);
            let path = home
                .join("runtime/sessions")
                .join(stored)
                .join("conversation.jsonl");
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
        }
    }
    Ok(())
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
        return Err(crate::Error::new(5200, error));
    }
    Ok(())
}

fn check_deleted(conn: &Connection, stored: &str) -> Result<()> {
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
