//! Persistent bots and sections. Runtime attachment is handled by `runtime`.
use crate::{Error, Result, common::*, db, runtime_store};
use base64::{Engine, engine::general_purpose::STANDARD};
use rusqlite::{Connection, OpenFlags, OptionalExtension, params};
use serde_json::{Value, json};
use std::{
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
const FIELDS: &[&str] = &[
    "name",
    "display_name",
    "title",
    "description",
    "persona",
    "provider",
    "model",
    "avatar",
    "dream_enabled",
    "shareable",
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

fn bot_row(home: &Path, caller: &str, name: &str, all: bool) -> Result<Value> {
    identifier(name)?;
    user(home, caller)?;
    if all {
        admin(home, caller)?;
    }
    let row = rows(
        &db::open(home)?,
        "SELECT * FROM bots WHERE name=?",
        &[&name],
    )?
    .into_iter()
    .next()
    .ok_or_else(|| Error::new(4205, format!("bot not found: {name}")))?;
    if !all {
        owner(home, caller, row["owner_id"].as_str().unwrap_or(""))?;
    }
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
fn legacy_ids(conn: &Connection, id: &str) -> Result<Vec<String>> {
    let columns = rows(conn, "PRAGMA table_info(sessions)", &[])?;
    let has = |key: &str| columns.iter().any(|c| c["name"] == key);
    let predicate = if has("session_key") {
        "id=?1 OR session_key=?1"
    } else {
        "id=?1"
    };
    let query = if has("parent_session_id") {
        format!(
            "WITH RECURSIVE chain(id) AS (SELECT id FROM sessions WHERE {predicate} UNION SELECT s.id FROM sessions s JOIN chain c ON s.parent_session_id=c.id) SELECT id FROM chain"
        )
    } else {
        format!("SELECT id FROM sessions WHERE {predicate}")
    };
    Ok(rows(conn, &query, &[&id])?
        .into_iter()
        .filter_map(|r| r["id"].as_str().map(str::to_owned))
        .collect())
}
fn history_summary(home: &Path, row: &Value) -> Result<(String, i64)> {
    let id = row["id"].as_str().unwrap_or("");
    let summary = runtime_store::summary(home, id)?;
    let native: bool = runtime_store::open(home)?.query_row(
        "SELECT EXISTS(SELECT 1 FROM native_sessions WHERE stored_id=?1) OR EXISTS(SELECT 1 FROM native_pi_journal WHERE session_id=?1)",
        [id], |r|r.get(0))?;
    if native || summary["message_count"].as_i64().unwrap_or(0) > 0 {
        return Ok((
            summary["preview"].as_str().unwrap_or("").to_owned(),
            summary["message_count"].as_i64().unwrap_or(0),
        ));
    }
    let name = row["bot"].as_str().unwrap_or("");
    let path = profile(home, name)?.join("state.db");
    safe(home, &path)?;
    if !path.exists() {
        return Ok((String::new(), 0));
    }
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let active = if rows(&conn, "PRAGMA table_info(messages)", &[])?
        .iter()
        .any(|c| c["name"] == "active")
    {
        " AND active=1"
    } else {
        ""
    };
    let mut count = 0;
    let mut preview = String::new();
    for key in legacy_ids(&conn, id)? {
        count += conn
            .query_row(
                &format!("SELECT COUNT(*) FROM messages WHERE session_id=?{active}"),
                [&key],
                |r| r.get::<_, i64>(0),
            )
            .unwrap_or(0);
        if let Some(text)=conn.query_row(&format!("SELECT content FROM messages WHERE session_id=?{active} AND role IN ('user','assistant') AND content IS NOT NULL ORDER BY id DESC LIMIT 1"),[&key],|r|r.get::<_,String>(0)).optional().unwrap_or(None){preview=text.chars().take(200).collect();}
    }
    Ok((preview, count))
}
fn shape_section(home: &Path, row: Value) -> Result<Value> {
    let (preview, count) = history_summary(home, &row)?;
    Ok(
        json!({"id":row["id"],"bot":row["bot"],"title":row["title"],"created_at":row["created_at"],"updated_at":row["updated_at"],"archived_at":row["archived_at"],"done_at":row["done_at"],"live_session_id":row["last_live_session_id"],"preview":preview,"message_count":count}),
    )
}
pub fn section(home: &Path, caller: &str, id: &str) -> Result<Value> {
    shape_section(home, section_row(home, caller, id)?)
}
fn list_sections(home: &Path, caller: &str, p: &Value) -> Result<Vec<Value>> {
    user(home, caller)?;
    let all = p["all"].as_bool().unwrap_or(false);
    if all {
        admin(home, caller)?;
    }
    let bot = p["bot"].as_str();
    let archived = p["include_archived"].as_bool().unwrap_or(false);
    rows(&db::open(home)?,"SELECT * FROM sections WHERE (? OR owner_id=?) AND (? IS NULL OR bot=?) AND (? OR archived_at IS NULL) ORDER BY updated_at DESC,id ASC",&[&all,&caller,&bot,&bot,&archived])?.into_iter().map(|r|shape_section(home,r)).collect()
}
pub fn create_section(home: &Path, caller: &str, name: &str, title: &str) -> Result<Value> {
    bot_owner(home, caller, name)?;
    let title = if title.trim().is_empty() {
        "New section"
    } else {
        title.trim()
    };
    let id = id();
    let now = now();
    let mut conn = db::open(home)?;
    let tx = conn.transaction()?;
    tx.execute(
        "INSERT INTO sections(id,bot,title,owner_id,created_at,updated_at) VALUES (?,?,?,?,?,?)",
        params![id, name, title, caller, now, now],
    )?;
    tx.execute(
        "UPDATE bots SET last_activity_at=? WHERE name=?",
        params![now, name],
    )?;
    tx.commit()?;
    section(home, caller, &id)
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
fn set_avatar(home: &Path, name: &str, value: &Value) -> Result<()> {
    let image = decode_avatar(value)?;
    let dir = profile(home, name)?.join("assets");
    for ext in ["png", "jpg", "webp"] {
        safe(home, &dir.join(format!("avatar.{ext}")))?;
    }
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
fn shape_bot(home: &Path, caller: &str, row: Value, all: bool) -> Result<Value> {
    let name = row["name"].as_str().unwrap_or("");
    let cfg = config(home, name)?;
    let sections = list_sections(
        home,
        caller,
        &json!({"bot":name,"include_archived":true,"all":all}),
    )?;
    let recent = sections
        .iter()
        .filter(|s| s["archived_at"].is_null() && s["title"] != "Dreams")
        .take(2)
        .cloned()
        .collect::<Vec<_>>();
    let incident=rows(&db::open(home)?,"SELECT * FROM bot_incidents WHERE bot=? AND resolved_at IS NULL ORDER BY created_at DESC LIMIT 1",&[&name])?.into_iter().next();
    let (mut status, mut detail) = ("idle", Value::Null);
    if let Some(i) = incident {
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
        let wait=rows(&db::open(home)?,"SELECT e.room_id,e.created_at,r.name FROM room_events e JOIN rooms r ON r.id=e.room_id WHERE e.kind='waiting.human' AND e.actor_id=? AND e.seq=(SELECT MAX(seq) FROM room_events WHERE room_id=e.room_id) AND r.archived_at IS NULL ORDER BY e.created_at DESC LIMIT 1",&[&name])?.into_iter().next();
        if let Some(r)=wait {status="needs_you";detail=json!({"text":format!("Waiting on you in “{}”.",r["name"].as_str().unwrap_or("")),"section_id":null,"room_id":r["room_id"],"session_id":null,"since":r["created_at"],"action":null});}
        else if let Some(r)=rows(&db::open(home)?,"SELECT t.room_id,t.started_at,r.name FROM room_turns t JOIN rooms r ON r.id=t.room_id WHERE t.bot=? AND t.status='running' ORDER BY t.started_at DESC LIMIT 1",&[&name])?.into_iter().next() {status="working";detail=json!({"text":format!("Working in “{}”.",r["name"].as_str().unwrap_or("")),"section_id":null,"room_id":r["room_id"],"session_id":null,"since":r["started_at"],"action":null});}
    }
    let enabled = crate::connectors::toolsets(home, name)?;
    let tools = json!(
        TOOLS
            .iter()
            .filter(|(_, v)| enabled.iter().any(|t| t == v))
            .map(|(k, _)| *k)
            .collect::<Vec<_>>()
    );
    Ok(
        json!({"name":name,"display_name":row["display_name"].as_str().filter(|s|!s.is_empty()).map(str::to_owned).unwrap_or_else(||display_name(name)),"title":row["title"].as_str().unwrap_or(""),"description":row["description"].as_str().unwrap_or(""),"persona":read_text(home,&profile(home,name)?.join("SOUL.md"))?,"skills":serde_json::from_str::<Value>(row["skills_json"].as_str().unwrap_or("[]")).unwrap_or(json!([])),"tools":tools,"dream_enabled":row["dream_enabled"].as_i64().unwrap_or(1)!=0,"shareable":row["shareable"].as_i64().unwrap_or(0)!=0,"notify":row["notify"].as_i64().unwrap_or(1)!=0,"approval_mode":row["approval_mode"].as_str().unwrap_or("inherit"),"workdir":row["workdir"],"status":status,"status_detail":detail,"provider":cfg["model"]["provider"],"model":cfg["model"].as_str().map(Value::from).unwrap_or_else(||cfg["model"]["default"].clone()),"avatar":avatar(home,name)?,"created_at":row["created_at"],"updated_at":row["updated_at"],"last_activity_at":row["last_activity_at"],"owner_id":row["owner_id"],"sections_total":sections.len(),"sections_recent":recent}),
    )
}
pub fn bot(home: &Path, caller: &str, name: &str) -> Result<Value> {
    shape_bot(home, caller, bot_row(home, caller, name, false)?, false)
}
fn validate_patch(p: &Value) -> Result<()> {
    let object = p
        .as_object()
        .ok_or_else(|| Error::new(4202, "bot fields must be an object"))?;
    for (key, value) in object {
        if !FIELDS.contains(&key.as_str()) {
            return Err(Error::new(4201, format!("unknown bot field: {key}")));
        }
        match key.as_str() {
            "notify" | "dream_enabled" | "shareable" if !value.is_boolean() => {
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
fn seed_skills(home: &Path, destination: &Path) -> Result<()> {
    fn copy(source: &Path, dest: &Path) -> Result<()> {
        fs::create_dir_all(dest)?;
        for entry in fs::read_dir(source)? {
            let entry = entry?;
            let kind = entry.file_type()?;
            let name = entry.file_name();
            if name.to_string_lossy().starts_with('.') {
                continue;
            }
            if kind.is_dir() {
                copy(&entry.path(), &dest.join(name))?;
            } else if kind.is_file() {
                fs::copy(entry.path(), dest.join(name))?;
            }
        }
        Ok(())
    }
    let source = std::env::var_os("HEXBOT_BUNDLED_SKILLS")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../skills"));
    safe(home, destination)?;
    if source.is_dir() {
        copy(&source, destination)?;
    }
    Ok(())
}
pub fn enabled_skills(home: &Path, name: &str) -> Result<Vec<Value>> {
    fn walk(home: &Path, path: &Path, disabled: &[Value], out: &mut Vec<Value>) -> Result<()> {
        safe(home, path)?;
        if !path.exists() {
            return Ok(());
        }
        for entry in fs::read_dir(path)? {
            let entry = entry?;
            let kind = entry.file_type()?;
            if kind.is_dir() {
                walk(home, &entry.path(), disabled, out)?;
            } else if kind.is_file() && entry.file_name() == "SKILL.md" {
                let name = path
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string();
                if !disabled
                    .iter()
                    .any(|d| d.as_str().is_some_and(|d| d.eq_ignore_ascii_case(&name)))
                    && !out.iter().any(|s| s["name"] == name)
                {
                    out.push(json!({"name":name,"path":entry.path(),"content":read_text(home,&entry.path())?}));
                }
            }
        }
        Ok(())
    }
    let cfg = config(home, name)?;
    let disabled = cfg["skills"]["disabled"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let mut result = vec![];
    walk(
        home,
        &profile(home, name)?.join("skills"),
        &disabled,
        &mut result,
    )?;
    walk(home, &home.join("skills"), &disabled, &mut result)?;
    result.sort_by_key(|s| s["name"].as_str().unwrap_or("").to_string());
    Ok(result)
}
fn installed_skills(home: &Path, name: &str) -> Result<Vec<String>> {
    fn walk(home: &Path, path: &Path, out: &mut Vec<String>) -> Result<()> {
        safe(home, path)?;
        if !path.exists() {
            return Ok(());
        }
        for entry in fs::read_dir(path)? {
            let entry = entry?;
            let kind = entry.file_type()?;
            if kind.is_dir() {
                walk(home, &entry.path(), out)?;
            } else if kind.is_file()
                && entry.file_name() == "SKILL.md"
                && let Some(name) = path.file_name()
            {
                out.push(name.to_string_lossy().into_owned());
            }
        }
        Ok(())
    }
    let mut names = Vec::new();
    walk(home, &profile(home, name)?.join("skills"), &mut names)?;
    names.sort();
    names.dedup();
    Ok(names)
}
fn profile_call(home: &Path, caller: &str, method: &str, p: &Value) -> Result<Value> {
    let name = required(p, "name")?;
    let row = bot_row(home, caller, name, false)?;
    match method {
        "profiles.describe" => {
            let cfg = config(home, name)?;
            let disabled = cfg["skills"]["disabled"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            let skills=installed_skills(home,name)?.into_iter().map(|s|json!({"enabled":!disabled.iter().any(|d|d.as_str().is_some_and(|d|d.eq_ignore_ascii_case(&s))),"name":s})).collect::<Vec<_>>();
            let enabled = crate::connectors::toolsets(home, name)?;
            let mut names = enabled.clone();
            names.extend(TOOLS.iter().map(|(_, t)| t.to_string()));
            names.sort();
            names.dedup();
            Ok(
                json!({"name":name,"description":row["description"].as_str().unwrap_or(""),"soul":read_text(home,&profile(home,name)?.join("SOUL.md"))?,"model":cfg["model"],"skills":skills,"toolsets":names.iter().map(|s|json!({"name":s,"enabled":enabled.contains(s),"description":"","tool_count":0})).collect::<Vec<_>>()}),
            )
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
            validate_patch(&patch)?;
            configure(home, name, &patch)?;
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
            write_yaml(home, &profile(home, name)?.join("config.yaml"), &cfg)?;
            if let Some(description) = p["description"].as_str() {
                db::open(home)?.execute(
                    "UPDATE bots SET description=?,updated_at=? WHERE name=?",
                    params![description, now(), name],
                )?;
            }
            Ok(
                json!({"name":name,"applied":{"model":p.get("model").is_some()||p.get("provider").is_some(),"soul":p.get("soul").is_some(),"skills":p.get("disabled_skills").is_some(),"tools":p.get("enabled_toolsets").is_some()}}),
            )
        }
        _ => Err(Error::new(-32601, "method not found")),
    }
}
fn configure(home: &Path, name: &str, p: &Value) -> Result<()> {
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
        enabled.retain(|v| !TOOLS.iter().any(|(_, t)| v == t));
        for item in tools {
            if let Some((_, t)) = TOOLS.iter().find(|(k, _)| item == k)
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
        let installed = installed_skills(home, name)?;
        for chosen in v {
            if !installed.iter().any(|s| chosen == s) {
                return Err(Error::new(
                    4202,
                    format!("unknown skill: {}", chosen.as_str().unwrap_or("")),
                ));
            }
        }
        cfg["skills"]["disabled"] = json!(
            installed
                .into_iter()
                .filter(|s| !v.contains(&json!(s)))
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
    write_yaml(home, &dir.join("config.yaml"), &cfg)?;
    if let Some(v) = p["persona"].as_str() {
        let path = dir.join("SOUL.md");
        safe(home, &path)?;
        atomic_write(&path, v.as_bytes())?;
    }
    if let Some(v) = p.get("avatar") {
        set_avatar(home, name, v)?;
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
    user(home, caller)?;
    validate_patch(p)?;
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
    {
        return Err(Error::new(4202, "invalid or reserved bot name"));
    }
    if db::open(home)?
        .query_row("SELECT 1 FROM bots WHERE name=?", [name], |_| Ok(()))
        .optional()?
        .is_some()
    {
        return Err(Error::new(4208, format!("bot already exists: {name}")));
    }
    let dir = profile(home, name)?;
    if dir.exists() {
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
    // Seed deployment defaults so every new bot sees the existing model and tool settings.
    let result = (|| {
        let global = read_config(home)?;
        seed_skills(home, &dir.join("skills"))?;
        write_yaml(home, &dir.join("config.yaml"), &global)?;
        configure(home, name, &patch)?;
        let now = now();
        let mut conn = db::open(home)?;
        let tx = conn.transaction()?;
        tx.execute("INSERT INTO bots(name,display_name,title,description,owner_id,created_at,updated_at,last_activity_at,tools_json,skills_json) VALUES (?,?,?,?,?,?,?,?,?,?)",params![name,display,p["title"].as_str().unwrap_or(""),p["description"].as_str().unwrap_or(""),caller,now,now,now,p.get("tools").unwrap_or(&json!([])).to_string(),p.get("skills").unwrap_or(&json!([])).to_string()])?;
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
fn update_bot(home: &Path, caller: &str, p: &Value) -> Result<Value> {
    let name = required(p, "name")?;
    bot_row(home, caller, name, false)?;
    validate_patch(p)?;
    configure(home, name, p)?;
    let mut conn = db::open(home)?;
    let tx = conn.transaction()?;
    for key in [
        "display_name",
        "title",
        "description",
        "dream_enabled",
        "shareable",
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
    tx.execute(
        "UPDATE bots SET updated_at=? WHERE name=?",
        params![now(), name],
    )?;
    tx.commit()?;
    crate::settings::mirror(home, &profile(home, name)?)?;
    Ok(json!({"bot":bot(home,caller,name)?}))
}
fn delete_section(home: &Path, caller: &str, id: &str, purge: bool) -> Result<()> {
    let row = section_row(home, caller, id)?;
    if purge {
        runtime_store::delete(home, id)?;
        let path = profile(home, row["bot"].as_str().unwrap_or(""))?.join("state.db");
        safe(home, &path)?;
        if path.exists() {
            let mut conn = Connection::open(path)?;
            conn.busy_timeout(std::time::Duration::from_secs(10))?;
            let tx = conn.transaction()?;
            for key in legacy_ids(&tx, id)? {
                tx.execute("DELETE FROM messages WHERE session_id=?", [&key])?;
                tx.execute("DELETE FROM sessions WHERE id=?", [&key])?;
            }
            tx.commit()?;
        }
    }
    let mut conn = db::open(home)?;
    let tx = conn.transaction()?;
    tx.execute("DELETE FROM sections WHERE id=?", [id])?;
    tx.execute(
        "UPDATE bots SET last_activity_at=? WHERE name=?",
        params![now(), row["bot"].as_str()],
    )?;
    tx.commit()?;
    Ok(())
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
        "hexbot.bots.update" => update_bot(home, caller, p),
        "hexbot.bots.get" => {
            let all = p["all"].as_bool().unwrap_or(false);
            Ok(
                json!({"bot":shape_bot(home,caller,bot_row(home,caller,required(p,"name")?,all)?,all)?}),
            )
        }
        "hexbot.bots.list" => {
            user(home, caller)?;
            let all = p["all"].as_bool().unwrap_or(false);
            if all {
                admin(home, caller)?;
            }
            let bots=rows(&db::open(home)?,"SELECT * FROM bots WHERE (? OR owner_id=?) ORDER BY last_activity_at DESC,name ASC",&[&all,&caller])?.into_iter().map(|r|shape_bot(home,caller,r,all)).collect::<Result<Vec<_>>>()?;
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
        "hexbot.bots.delete" => {
            let name = required(p, "name")?;
            bot_owner(home, caller, name)?;
            let dir = profile(home, name)?;
            let conn = db::open(home)?;
            let busy: bool = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM room_turns WHERE bot=? AND status='running')",
                [name],
                |r| r.get(0),
            )?;
            if busy {
                return Err(Error::new(4211, "bot has a running room turn"));
            }
            drop(conn);
            for s in list_sections(home, caller, &json!({"bot":name,"include_archived":true}))? {
                delete_section(home, caller, s["id"].as_str().unwrap_or(""), true)?;
            }
            let mut conn = db::open(home)?;
            let tx = conn.transaction()?;
            tx.execute("DELETE FROM dreams WHERE bot=?", [name])?;
            tx.execute("UPDATE room_members SET left_at=? WHERE member_kind='bot' AND member_id=? AND left_at IS NULL",params![now(),name])?;
            tx.execute("UPDATE rooms SET main_bot=NULL WHERE main_bot=?", [name])?;
            tx.execute("DELETE FROM room_sessions WHERE bot=?", [name])?;
            tx.execute("DELETE FROM bot_incidents WHERE bot=?", [name])?;
            tx.execute("DELETE FROM bots WHERE name=?", [name])?;
            if dir.exists() {
                fs::remove_dir_all(dir)?;
            }
            tx.commit()?;
            Ok(json!({"deleted":true}))
        }
        "hexbot.sections.list" => Ok(json!({"sections":list_sections(home,caller,p)?})),
        "hexbot.sections.create" => Ok(
            json!({"section":create_section(home,caller,required(p,"bot")?,p["title"].as_str().unwrap_or("New section"))?}),
        ),
        "hexbot.sections.delete" => {
            delete_section(
                home,
                caller,
                required(p, "id")?,
                p["purge_memory"].as_bool().unwrap_or(true),
            )?;
            Ok(json!({"deleted":true}))
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
                        "UPDATE sections SET title=?,updated_at=?,title_dirty=1 WHERE id=?",
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
