use crate::{Error, Result, db};
use rusqlite::{Connection, OptionalExtension};
use serde_json::{Value, json};
use std::{fs, io::Write, path::Path};

pub fn now() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
}
pub fn id() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}
pub fn required<'a>(p: &'a Value, key: &str) -> Result<&'a str> {
    p.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| Error::new(4200, format!("missing parameter: {key}")))
}
pub fn identifier(value: &str) -> Result<()> {
    if value.is_empty()
        || matches!(value, "." | "..")
        || value
            .chars()
            .any(|c| c == '/' || c == '\\' || c.is_control())
    {
        return Err(Error::new(4202, "invalid identifier"));
    }
    Ok(())
}
pub fn rows(conn: &Connection, sql: &str, params: &[&dyn rusqlite::ToSql]) -> Result<Vec<Value>> {
    let mut stmt = conn.prepare(sql)?;
    let names = stmt
        .column_names()
        .iter()
        .map(|s| s.to_string())
        .collect::<Vec<_>>();
    let results = stmt.query_map(params, |row| {
        let mut object = serde_json::Map::new();
        for (i, name) in names.iter().enumerate() {
            use rusqlite::types::ValueRef;
            let value = match row.get_ref(i)? {
                ValueRef::Null => Value::Null,
                ValueRef::Integer(v) => json!(v),
                ValueRef::Real(v) => json!(v),
                ValueRef::Text(v) => json!(String::from_utf8_lossy(v)),
                ValueRef::Blob(_) => Value::Null,
            };
            object.insert(name.clone(), value);
        }
        Ok(Value::Object(object))
    })?;
    results
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(Into::into)
}
pub fn user(home: &Path, caller: &str) -> Result<Value> {
    identifier(caller)?;
    rows(
        &db::open(home)?,
        "SELECT * FROM users WHERE id=? AND disabled_at IS NULL",
        &[&caller],
    )?
    .into_iter()
    .next()
    .ok_or_else(|| Error::new(4302, "not the owner"))
}
pub fn admin(home: &Path, caller: &str) -> Result<()> {
    if user(home, caller)?["role"] != "admin" {
        return Err(Error::new(4301, "admin only"));
    }
    Ok(())
}
pub fn owner(home: &Path, caller: &str, owner: &str) -> Result<()> {
    user(home, caller)?;
    if caller != owner {
        return Err(Error::new(4302, "not the owner"));
    }
    Ok(())
}
pub fn bot_owner(home: &Path, caller: &str, bot: &str) -> Result<()> {
    identifier(bot)?;
    let owner_id: Option<String> = db::open(home)?
        .query_row("SELECT owner_id FROM bots WHERE name=?", [bot], |r| {
            r.get(0)
        })
        .optional()?;
    owner(
        home,
        caller,
        &owner_id.ok_or_else(|| Error::new(4205, format!("bot not found: {bot}")))?,
    )
}
/// Authorize a bot's tools without granting room owners access to unrelated profiles.
/// Delegates retain a parent-session link and lose access when that room loses access.
pub fn bot_session_access(home: &Path, caller: &str, bot: &str, stored: &str) -> Result<()> {
    user(home, caller)?;
    identifier(bot)?;
    identifier(stored)?;
    let conn = db::open(home)?;
    let row: Option<(String, bool)> = conn
        .query_row(
            "SELECT owner_id,shareable FROM bots WHERE name=?",
            [bot],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let (owner, shared) = row.ok_or_else(|| Error::new(4205, format!("bot not found: {bot}")))?;
    if owner == caller {
        return Ok(());
    }
    if !shared {
        return Err(Error::new(4302, "not the owner"));
    }
    let mut session = stored.to_owned();
    let mut seen = std::collections::HashSet::new();
    for _ in 0..16 {
        if !seen.insert(session.clone()) {
            break;
        }
        let authorized: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM room_sessions s JOIN rooms r ON r.id=s.room_id JOIN room_members m ON m.room_id=r.id AND m.member_kind='bot' AND m.member_id=s.bot WHERE s.stored_session_id=?1 AND s.bot=?2 AND r.owner_id=?3 AND r.archived_at IS NULL AND m.left_at IS NULL)",
            rusqlite::params![session, bot, caller], |r| r.get(0),
        )?;
        if authorized {
            return Ok(());
        }
        let parent =
            Connection::open_with_flags(
                home.join("hexbot-runtime.db"),
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
            )
            .ok()
            .and_then(|native| {
                native.query_row(
                "SELECT options FROM native_sessions WHERE stored_id=? AND owner=? AND bot=?",
                rusqlite::params![session, caller, bot], |r| r.get::<_, String>(0),
            ).optional().ok().flatten()
            })
            .and_then(|options| serde_json::from_str::<Value>(&options).ok())
            .and_then(|options| options["parent_session"].as_str().map(str::to_owned));
        let Some(parent) = parent else {
            break;
        };
        identifier(&parent)?;
        session = parent;
    }
    Err(Error::new(4302, "not the owner"))
}
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| Error::new(4202, "invalid path"))?;
    fs::create_dir_all(parent)?;
    let mut tmp = tempfile::NamedTempFile::new_in(parent)?;
    tmp.write_all(bytes)?;
    tmp.as_file().sync_all()?;
    tmp.persist(path).map_err(|e| Error::from(e.error))?;
    #[cfg(unix)]
    fs::File::open(parent)?.sync_all()?;
    Ok(())
}
pub fn read_config(home: &Path) -> Result<Value> {
    let path = home.join("config.yaml");
    match fs::read_to_string(path) {
        Ok(s) => serde_yaml::from_str(&s).map_err(|e| Error::new(5200, e.to_string())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
        Err(e) => Err(e.into()),
    }
}
pub fn write_config(home: &Path, value: &Value) -> Result<()> {
    write_yaml(&home.join("config.yaml"), value)
}

/// Write a complete YAML value while retaining unchanged syntax and comments.
/// Callers read and merge the existing mapping first; absent keys are deletions.
pub fn write_yaml(path: &Path, value: &Value) -> Result<()> {
    use std::str::FromStr;
    let fresh = serde_yaml::to_string(value).map_err(|e| Error::new(5200, e.to_string()))?;
    let source = match fs::read_to_string(path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return atomic_write(path, fresh.as_bytes());
        }
        Err(e) => return Err(e.into()),
    };
    let previous: Value =
        serde_yaml::from_str(&source).map_err(|e| Error::new(5200, e.to_string()))?;
    if &previous == value {
        return Ok(());
    }
    let file =
        yaml_edit::YamlFile::from_str(&source).map_err(|e| Error::new(5200, e.to_string()))?;
    let document = file.ensure_document();
    let target =
        yaml_edit::Document::from_str(&fresh).map_err(|e| Error::new(5200, e.to_string()))?;
    let empty = json!({});
    let text = if let (Some(existing), Some(wanted)) = (document.as_mapping(), target.as_mapping())
    {
        patch_yaml_mapping(
            &existing,
            &wanted,
            if previous.is_null() {
                &empty
            } else {
                &previous
            },
            value,
        )?;
        file.to_string()
    } else if previous.is_null() && value.is_object() {
        for (key, _) in value.as_object().unwrap() {
            let node = target
                .get(key.as_str())
                .ok_or_else(|| Error::new(5200, "missing serialized YAML key"))?;
            if !document.set(key.as_str(), node) {
                return Err(Error::new(5200, "configuration must be a YAML mapping"));
            }
        }
        file.to_string()
    } else {
        // A root type change replaces the full value; preserve standalone comments.
        let comments = source
            .lines()
            .filter(|line| line.trim_start().starts_with('#'))
            .collect::<Vec<_>>()
            .join("\n");
        if comments.is_empty() {
            fresh
        } else {
            format!("{comments}\n{fresh}")
        }
    };
    // Lossless parsers have different YAML dialect support. Never persist a
    // formatting edit unless the independent semantic parser confirms its value.
    let actual: Value = serde_yaml::from_str(&text)
        .map_err(|e| Error::new(5200, format!("edited YAML failed validation: {e}")))?;
    if &actual != value {
        return Err(Error::new(5200, "edited YAML changed configuration values"));
    }
    atomic_write(path, text.as_bytes())
}

fn patch_yaml_mapping(
    existing: &yaml_edit::Mapping,
    target: &yaml_edit::Mapping,
    previous: &Value,
    wanted: &Value,
) -> Result<()> {
    use std::str::FromStr;
    // Flow mappings cannot contain the serializer's block-style child nodes.
    let target = if existing.is_flow_style() {
        yaml_edit::Document::from_str(&wanted.to_string())
            .map_err(|e| Error::new(5200, e.to_string()))?
            .as_mapping()
            .ok_or_else(|| Error::new(5200, "invalid flow mapping"))?
    } else {
        target.clone()
    };
    let old = previous
        .as_object()
        .ok_or_else(|| Error::new(5200, "configuration must be a mapping"))?;
    let new = wanted
        .as_object()
        .ok_or_else(|| Error::new(5200, "configuration must be a mapping"))?;
    for key in old.keys() {
        if !new.contains_key(key) {
            existing.remove(key.as_str());
        }
    }
    for (key, value) in new {
        if old.get(key) == Some(value) {
            continue;
        }
        let next = target
            .get(key.as_str())
            .ok_or_else(|| Error::new(5200, "missing serialized YAML key"))?;
        if let (Some(child), Some(target_child), Some(previous)) = (
            existing.get_mapping(key.as_str()),
            next.as_mapping(),
            old.get(key).filter(|v| v.is_object()),
        ) && value.is_object()
        {
            patch_yaml_mapping(&child, target_child, previous, value)?;
            continue;
        }
        existing.set(key.as_str(), next);
    }
    Ok(())
}
pub fn json_field(value: &Value) -> Value {
    value
        .as_str()
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_else(|| json!({}))
}

/// Read dotenv credentials without changing the daemon process environment.
/// Normalize Python dotenv's quoted escapes before passing to dotenvy; never
/// include parser diagnostics in RPC errors because those contain secret lines.
pub fn env_values(path: &Path) -> Result<std::collections::BTreeMap<String, String>> {
    let text = match fs::read_to_string(path.join(".env")) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(e.into()),
    };
    let mut normalized = String::new();
    let mut lines = text.lines();
    while let Some(line) = lines.next() {
        let line = line.trim().strip_prefix("export ").unwrap_or(line.trim());
        if line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        let value = value.trim();
        let quoted = value.starts_with(['\'', '"']);
        let value = if let Some(quote) = value.chars().next().filter(|c| *c == '\'' || *c == '"') {
            let mut raw = value[1..].to_string();
            let end = loop {
                let mut escaped = false;
                let end = raw.char_indices().find_map(|(i, c)| {
                    if escaped {
                        escaped = false;
                        return None;
                    }
                    if c == '\\' {
                        escaped = true;
                        return None;
                    }
                    (c == quote).then_some(i)
                });
                if let Some(end) = end {
                    break end;
                }
                let Some(next) = lines.next() else {
                    return Err(Error::new(4202, "unterminated quoted value in .env"));
                };
                raw.push('\n');
                raw.push_str(next);
            };
            let mut decoded = String::new();
            let mut chars = raw[..end].chars();
            while let Some(c) = chars.next() {
                if c != '\\' {
                    decoded.push(c);
                    continue;
                }
                let Some(next) = chars.next() else {
                    decoded.push(c);
                    break;
                };
                let replacement = match next {
                    '\\' => Some('\\'),
                    '\'' => Some('\''),
                    '"' if quote == '"' => Some('"'),
                    'n' if quote == '"' => Some('\n'),
                    'r' if quote == '"' => Some('\r'),
                    't' if quote == '"' => Some('\t'),
                    'b' if quote == '"' => Some('\x08'),
                    'f' if quote == '"' => Some('\x0c'),
                    'v' if quote == '"' => Some('\x0b'),
                    'a' if quote == '"' => Some('\x07'),
                    _ => None,
                };
                if let Some(c) = replacement {
                    decoded.push(c)
                } else {
                    decoded.push('\\');
                    decoded.push(next)
                }
            }
            decoded
        } else {
            value.split(" #").next().unwrap_or("").trim().to_string()
        };
        normalized.push_str(key);
        normalized.push('=');
        if quoted {
            normalized.push('"');
            normalized.push_str(
                &value
                    .replace('\\', "\\\\")
                    .replace('"', "\\\"")
                    .replace('$', "\\$"),
            );
            normalized.push('"');
        } else {
            normalized.push_str(&value);
        }
        normalized.push('\n');
    }
    dotenvy::from_read_iter(normalized.as_bytes())
        .map(|entry| entry.map_err(|_| Error::new(4202, "invalid .env syntax")))
        .collect()
}

/// Serialize read/modify/write credential edits across providers and connectors.
pub fn credentials_lock() -> &'static std::sync::Mutex<()> {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    &LOCK
}
