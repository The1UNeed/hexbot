use crate::{Error, Result, db};
use rusqlite::{Connection, OptionalExtension};
use serde_json::{Value, json};
use std::{fs, io::Write, path::Path};

pub fn pi_executable() -> Result<std::path::PathBuf> {
    if let Some(path) = std::env::var_os("HEXBOT_PI_EXECUTABLE").filter(|path| !path.is_empty()) {
        return Ok(path.into());
    }
    #[cfg(debug_assertions)]
    {
        let candidate = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../pi-runtime/node_modules/.bin/pi");
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    Err(Error::new(
        5200,
        "Pi runtime missing. Set HEXBOT_PI_EXECUTABLE to the Pi launcher",
    ))
}

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
/// Bypass reads everything the daemon can, the admin's provider keys included,
/// so only the admin chooses it for a bot or a room.
pub fn bypass_allowed(home: &Path, caller: &str, patch: &Value) -> Result<()> {
    if patch.get("approval_mode").and_then(Value::as_str) == Some("off")
        && user(home, caller)?["role"] != "admin"
    {
        return Err(Error::new(4301, "Only the admin can choose Bypass."));
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
            rusqlite::params![session, bot, caller],
            |r| r.get(0),
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
        // A file with only comments, or none at all, is the empty mapping.
        Ok(s) => serde_yaml::from_str::<Value>(&s)
            .map(|value| if value.is_null() { json!({}) } else { value })
            .map_err(|e| Error::new(5200, e.to_string())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
        Err(e) => Err(e.into()),
    }
}
// All daemon config mutations hold this lock from read through write. Never
// hold it across an await. If both locks are needed, acquire skills first.
static CONFIG_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub(crate) struct ConfigWriter(std::sync::MutexGuard<'static, ()>);

pub(crate) fn config_writer() -> Result<ConfigWriter> {
    Ok(ConfigWriter(CONFIG_LOCK.lock().map_err(|_| {
        Error::new(5200, "config lock unavailable")
    })?))
}
impl ConfigWriter {
    pub(crate) fn write(&self, home: &Path, value: &Value) -> Result<()> {
        let _guard = &self.0;
        write_yaml(&home.join("config.yaml"), value)
    }
}

pub fn update_config(home: &Path, change: impl FnOnce(&mut Value) -> Result<()>) -> Result<()> {
    let writer = config_writer()?;
    let mut config = read_config(home)?;
    change(&mut config)?;
    writer.write(home, &config)
}

/// Replace a config. Read-modify-write callers must use update_config instead.
pub fn write_config(home: &Path, value: &Value) -> Result<()> {
    config_writer()?.write(home, value)
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
    // Removing the last key leaves a document with no value, which reads as null; that is
    // the empty mapping the caller asked for (`read_config` treats it the same way).
    let emptied = actual.is_null() && value.as_object().is_some_and(|map| map.is_empty());
    if &actual != value && !emptied {
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

/// Open without blocking on a FIFO, then check the opened object and bound the read.
pub fn read_regular(path: &Path, limit: usize) -> Result<Vec<u8>> {
    use std::io::Read;
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK);
    }
    let file = options.open(path)?;
    if !file.metadata()?.is_file() {
        return Err(Error::new(4202, "path must be a regular file"));
    }
    let mut bytes = Vec::new();
    file.take(limit as u64 + 1).read_to_end(&mut bytes)?;
    if bytes.len() > limit {
        return Err(Error::new(4202, "file exceeds the read limit"));
    }
    Ok(bytes)
}
pub fn read_regular_text(path: &Path, limit: usize) -> Result<String> {
    String::from_utf8(read_regular(path, limit)?)
        .map_err(|_| Error::new(4202, "file is not UTF-8 text"))
}
pub fn managed_python(home: &Path) -> std::path::PathBuf {
    let managed = home.join("bin/python3.11");
    if managed.is_file() {
        managed
    } else {
        "python3".into()
    }
}

/// Expand a leading `~` or `~/` to the user's home directory.
pub fn expand_home(path: &str) -> Result<std::path::PathBuf> {
    expand_home_in(path, std::env::var_os("HOME"))
}
fn expand_home_in(path: &str, home: Option<std::ffi::OsString>) -> Result<std::path::PathBuf> {
    if path == "~" || path.starts_with("~/") {
        // Without HOME the path would silently become relative to the daemon's cwd.
        let home = home
            .filter(|home| !home.is_empty())
            .ok_or_else(|| Error::new(4202, "HOME is not set, so ~ cannot be expanded"))?;
        Ok(std::path::PathBuf::from(home).join(path.strip_prefix("~/").unwrap_or("")))
    } else {
        Ok(std::path::PathBuf::from(path))
    }
}

/// Refuse a working directory inside the daemon home, symlinks included, without creating it.
/// The tool guards treat the working directory as writable, so it would open the home.
pub fn check_workdir(home: &Path, configured: &str) -> Result<std::path::PathBuf> {
    let path = std::path::absolute(expand_home(configured)?)?;
    if path
        .components()
        .any(|part| part == std::path::Component::ParentDir)
    {
        return Err(Error::new(
            4202,
            "the working directory must not contain ..",
        ));
    }
    // Canonicalise the deepest existing ancestor; the missing rest cannot be a symlink yet.
    let mut existing = path.as_path();
    while !existing.exists()
        && let Some(parent) = existing.parent()
    {
        existing = parent;
    }
    let rest = path.strip_prefix(existing).unwrap_or(Path::new(""));
    outside_home(home, &fs::canonicalize(existing)?.join(rest))?;
    Ok(path)
}

/// The first non-empty candidate (a section override, then the bot's own
/// workdir), else the workspace setting, else `~/Hexbot`.
pub fn configured_workdir<'a>(candidates: &[Option<&'a str>], settings: &'a Value) -> &'a str {
    candidates
        .iter()
        .flatten()
        .copied()
        .find(|s| !s.is_empty())
        .unwrap_or_else(|| settings["workspace_dir"].as_str().unwrap_or("~/Hexbot"))
}

/// Check, create and canonicalise a working directory.
pub fn resolve_workdir(home: &Path, configured: &str) -> Result<std::path::PathBuf> {
    let path = check_workdir(home, configured)?;
    fs::create_dir_all(&path)?;
    let path = fs::canonicalize(path)?;
    outside_home(home, &path)?;
    Ok(path)
}

/// A saved working directory, reused only while it passes the workdir checks
/// (it may sit inside the home); otherwise warn once and let the caller fall
/// back to the default workspace.
pub fn saved_workdir(home: &Path, saved: &str) -> Option<std::path::PathBuf> {
    match resolve_workdir(home, saved) {
        Ok(path) => Some(path),
        Err(error) => {
            static WARN: std::sync::Once = std::sync::Once::new();
            WARN.call_once(|| {
                eprintln!(
                    "Ignoring the saved working directory {saved}: {}. The section uses the default workspace.",
                    error.message
                )
            });
            None
        }
    }
}

fn outside_home(home: &Path, canonical: &Path) -> Result<()> {
    if canonical.starts_with(fs::canonicalize(home)?) {
        return Err(Error::new(
            4202,
            "the working directory cannot be inside the Hexbot home",
        ));
    }
    Ok(())
}

pub fn merged_config(home: &Path, bot: &str) -> Result<Value> {
    fn merge(dst: &mut Value, src: &Value) {
        if let Some(src) = src.as_object() {
            if !dst.is_object() {
                *dst = json!({});
            }
            for (key, value) in src {
                merge(
                    dst.as_object_mut()
                        .unwrap()
                        .entry(key)
                        .or_insert(Value::Null),
                    value,
                );
            }
        } else {
            *dst = src.clone();
        }
    }
    let mut cfg = read_config(home)?;
    merge(
        &mut cfg,
        &read_config(&crate::catalog::profile(home, bot)?)?,
    );
    Ok(cfg)
}

pub fn allow_private_urls(home: &Path, bot: &str) -> Result<bool> {
    let mut env = env_values(home)?;
    env.extend(env_values(&crate::catalog::profile(home, bot)?)?);
    let setting = env
        .get("HERMES_ALLOW_PRIVATE_URLS")
        .cloned()
        .or_else(|| std::env::var("HERMES_ALLOW_PRIVATE_URLS").ok());
    match setting
        .as_deref()
        .map(str::trim)
        .map(str::to_lowercase)
        .as_deref()
    {
        Some("true" | "1" | "yes") => return Ok(true),
        Some("false" | "0" | "no") => return Ok(false),
        _ => (),
    }
    let cfg = merged_config(home, bot)?;
    Ok(["security", "browser"].iter().any(|section| {
        cfg[section]["allow_private_urls"]
            .as_bool()
            .unwrap_or(false)
    }))
}
fn blocked_ip(ip: std::net::IpAddr, allow_private: bool) -> bool {
    use std::net::IpAddr;
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, c, d] = ip.octets();
            if a == 0 || (a == 169 && b == 254) || [a, b, c, d] == [100, 100, 100, 200] {
                return true;
            }
            !allow_private
                && (ip.is_private()
                    || ip.is_loopback()
                    || ip.is_link_local()
                    || ip.is_multicast()
                    || ip.is_broadcast()
                    || ip.is_documentation()
                    || a == 0
                    || a >= 240
                    || (a == 100 && (64..128).contains(&b))
                    || (a == 198 && (b == 18 || b == 19))
                    || (a == 192 && b == 0 && c == 0))
        }
        IpAddr::V6(ip) => {
            if let Some(ip) = ip.to_ipv4_mapped() {
                return blocked_ip(IpAddr::V4(ip), allow_private);
            }
            if ip.is_unspecified() || ip == "fd00:ec2::254".parse::<std::net::Ipv6Addr>().unwrap() {
                return true;
            }
            !allow_private
                && (ip.is_loopback()
                    || ip.is_unspecified()
                    || ip.is_multicast()
                    || ip.is_unique_local()
                    || ip.is_unicast_link_local()
                    || (ip.segments()[0] & 0xe000 != 0x2000)
                    || (ip.segments()[0] == 0x2001 && ip.segments()[1] <= 0x1ff)
                    || (ip.segments()[0] == 0x2001 && ip.segments()[1] == 0xdb8)
                    || ip.segments()[0] == 0x2002)
        }
    }
}
/// Resolve once and return the checked addresses for the actual connection.
// Keep this process's listeners out of tool traffic even when LAN access is enabled.
fn daemon_listeners()
-> &'static std::sync::Mutex<std::collections::HashMap<std::net::SocketAddr, usize>> {
    static LISTENERS: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<std::net::SocketAddr, usize>>,
    > = std::sync::OnceLock::new();
    LISTENERS.get_or_init(Default::default)
}
pub struct DaemonListener(std::net::SocketAddr);
impl DaemonListener {
    pub fn register(address: std::net::SocketAddr) -> Self {
        *daemon_listeners()
            .lock()
            .unwrap()
            .entry(address)
            .or_default() += 1;
        Self(address)
    }
}
impl Drop for DaemonListener {
    fn drop(&mut self) {
        let mut listeners = daemon_listeners().lock().unwrap();
        if let Some(count) = listeners.get_mut(&self.0) {
            *count -= 1;
            if *count == 0 {
                listeners.remove(&self.0);
            }
        }
    }
}
fn is_daemon_address(address: &std::net::SocketAddr) -> bool {
    daemon_listeners().lock().unwrap().keys().any(|listener| {
        listener.port() == address.port()
            && (address.ip().is_unspecified()
                || matches!(address.ip().to_canonical(), std::net::IpAddr::V4(ip) if ip.octets()[0] == 0)
                || listener.ip().to_canonical() == address.ip().to_canonical()
                || listener.ip().is_unspecified()
                    && (address.ip().is_loopback()
                        || std::net::UdpSocket::bind(std::net::SocketAddr::new(address.ip(), 0))
                            .is_ok()))
    })
}
pub async fn url_addresses(
    url: &url::Url,
    allow_private: bool,
) -> Result<Vec<std::net::SocketAddr>> {
    let denied = || Error::new(4302, "URL is blocked by network safety settings");
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(denied());
    }
    let host = url
        .host_str()
        .ok_or_else(denied)?
        .trim_start_matches('[')
        .trim_end_matches(']')
        .trim_end_matches('.');
    if ["metadata.google.internal", "metadata.goog"].contains(&host) {
        return Err(denied());
    }
    let port = url.port_or_known_default().ok_or_else(denied)?;
    let addresses: Vec<_> = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        tokio::net::lookup_host((host, port)),
    )
    .await
    .map_err(|_| denied())?
    .map_err(|_| denied())?
    .collect();
    if addresses.is_empty()
        || addresses
            .iter()
            .any(|a| is_daemon_address(a) || blocked_ip(a.ip(), allow_private))
    {
        return Err(denied());
    }
    Ok(addresses)
}
/// Redirects are checked independently and DNS answers are pinned on every hop.
pub async fn safe_get(value: &str, allow_private: bool) -> Result<reqwest::Response> {
    let mut url = url::Url::parse(value).map_err(|_| Error::new(4202, "invalid URL"))?;
    for _ in 0..6 {
        let addresses = url_addresses(&url, allow_private).await?;
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(std::time::Duration::from_secs(90))
            .redirect(reqwest::redirect::Policy::none())
            .resolve_to_addrs(url.host_str().unwrap(), &addresses)
            .build()
            .map_err(|_| Error::new(4211, "HTTP client unavailable"))?;
        let response = client
            .get(url.clone())
            .send()
            .await
            .map_err(|_| Error::new(4211, "URL request failed"))?;
        if !response.status().is_redirection() {
            return Ok(response);
        }
        let location = response
            .headers()
            .get(reqwest::header::LOCATION)
            .and_then(|v| v.to_str().ok())
            .ok_or_else(|| Error::new(4211, "invalid URL redirect"))?;
        url = url
            .join(location)
            .map_err(|_| Error::new(4211, "invalid URL redirect"))?;
    }
    Err(Error::new(4211, "too many URL redirects"))
}

/// A browser proxy validates each new HTTP request or HTTPS tunnel and connects to
/// the checked address. Keeping the guard alive keeps the listener alive.
pub struct BrowserProxy {
    pub address: std::net::SocketAddr,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for BrowserProxy {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl BrowserProxy {
    pub async fn start(allow_private: bool) -> Result<Self> {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let address = listener.local_addr()?;
        let task = tokio::spawn(async move {
            let mut connections = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                    accepted = listener.accept() => {
                        let Ok((mut client, _)) = accepted else { break };
                        connections.spawn(async move {
                            if tokio::time::timeout(std::time::Duration::from_secs(120), proxy_request(&mut client, allow_private)).await.is_err() {
                                use tokio::io::AsyncWriteExt;
                                let _ = client.shutdown().await;
                            }
                        });
                    }
                    _ = connections.join_next(), if !connections.is_empty() => (),
                }
            }
        });
        Ok(Self { address, task })
    }
}
async fn proxy_request(client: &mut tokio::net::TcpStream, allow_private: bool) -> Result<()> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut header = Vec::new();
    while !header.ends_with(b"\r\n\r\n") {
        if header.len() >= 32 * 1024 {
            return Err(Error::new(4202, "browser request header is too large"));
        }
        header.push(client.read_u8().await?);
    }
    let header =
        std::str::from_utf8(&header).map_err(|_| Error::new(4202, "invalid browser request"))?;
    let mut lines = header.split("\r\n");
    let request = lines
        .next()
        .unwrap_or("")
        .split_whitespace()
        .collect::<Vec<_>>();
    if request.len() != 3 {
        return Err(Error::new(4202, "invalid browser request"));
    }
    let tunnel = request[0] == "CONNECT";
    let target = if tunnel {
        format!("https://{}/", request[1])
    } else {
        request[1].to_owned()
    };
    let url = url::Url::parse(&target).map_err(|_| Error::new(4202, "invalid browser URL"))?;
    let addresses = match url_addresses(&url, allow_private).await {
        Ok(addresses) => addresses,
        Err(error) => {
            client
                .write_all(
                    b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .await?;
            return Err(error);
        }
    };
    let mut upstream = tokio::net::TcpStream::connect(addresses.as_slice()).await?;
    if tunnel {
        client
            .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            .await?;
        tokio::io::copy_bidirectional(client, &mut upstream).await?;
    } else {
        // One origin per connection. Do not permit absolute-form targets to be
        // reinterpreted by the upstream or keep-alive requests to skip validation.
        let path = &url[url::Position::BeforePath..url::Position::AfterQuery];
        let mut forwarded = format!(
            "{} {} HTTP/1.1\r\nHost: {}\r\n",
            request[0],
            path,
            &url[url::Position::BeforeHost..url::Position::AfterPort]
        );
        let mut length = None;
        for line in lines.filter(|line| !line.is_empty()) {
            let (name, value) = line
                .split_once(':')
                .ok_or_else(|| Error::new(4202, "invalid browser header"))?;
            let name = name.to_ascii_lowercase();
            match name.as_str() {
                "content-length" => {
                    let size = value
                        .trim()
                        .parse::<u64>()
                        .map_err(|_| Error::new(4202, "invalid browser body length"))?;
                    if length.replace(size).is_some() || size > 24 * 1024 * 1024 {
                        return Err(Error::new(4202, "invalid browser body length"));
                    }
                }
                "transfer-encoding" | "upgrade" => {
                    return Err(Error::new(4202, "unsupported browser request framing"));
                }
                "host" | "connection" | "proxy-connection" | "proxy-authorization" | "expect" => (),
                _ => {
                    forwarded.push_str(line);
                    forwarded.push_str("\r\n");
                }
            }
        }
        if let Some(size) = length {
            forwarded.push_str(&format!("Content-Length: {size}\r\n"));
        }
        forwarded.push_str("Connection: close\r\n\r\n");
        upstream.write_all(forwarded.as_bytes()).await?;
        if let Some(size) = length
            && tokio::io::copy(&mut (&mut *client).take(size), &mut upstream).await? != size
        {
            return Err(Error::new(4202, "incomplete browser request body"));
        }
        tokio::io::copy(&mut upstream, client).await?;
    }
    Ok(())
}

/// Locate a child command in its workspace or PATH, without extra search roots.
pub fn command_path(program: &str, cwd: &Path) -> Option<std::path::PathBuf> {
    if program.contains(std::path::MAIN_SEPARATOR) {
        let path = cwd.join(program);
        return executable_file(&path).then_some(path);
    }
    std::env::split_paths(&std::env::var_os("PATH")?)
        .map(|dir| cwd.join(dir).join(program))
        .find(|path| executable_file(path))
}
pub(crate) fn executable_file(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// A temporary Hexbot home with its workspace beside it; a workdir may never sit inside the home.
#[cfg(test)]
pub(crate) struct TestHome {
    root: tempfile::TempDir,
    home: std::path::PathBuf,
}
#[cfg(test)]
impl TestHome {
    pub(crate) fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        fs::create_dir(&home).unwrap();
        Self { root, home }
    }
    pub(crate) fn path(&self) -> &Path {
        &self.home
    }
    pub(crate) fn workspace(&self) -> std::path::PathBuf {
        self.root.path().join("workspace")
    }
}

#[cfg(test)]
mod workdir_tests {
    use super::*;
    /// One resolver for every runtime path: a bare `~` is the home directory,
    /// nothing named `~` is created, and the Hexbot home itself is refused.
    #[test]
    fn workdir_expands_a_bare_tilde_and_refuses_the_home() {
        let home = TestHome::new();
        let user_home = std::env::var_os("HOME")
            .map(std::path::PathBuf::from)
            .unwrap();
        assert_eq!(
            resolve_workdir(home.path(), "~").unwrap(),
            fs::canonicalize(&user_home).unwrap()
        );
        assert!(!Path::new("~").exists());
        let space = home.workspace().join("space");
        assert_eq!(
            resolve_workdir(home.path(), space.to_str().unwrap()).unwrap(),
            fs::canonicalize(&space).unwrap()
        );
        assert!(space.is_dir());
        assert!(resolve_workdir(home.path(), home.path().to_str().unwrap()).is_err());
        assert_eq!(
            saved_workdir(home.path(), space.to_str().unwrap()).unwrap(),
            fs::canonicalize(&space).unwrap()
        );
        assert!(
            saved_workdir(
                home.path(),
                home.path().join("profiles/owl").to_str().unwrap()
            )
            .is_none()
        );
        assert!(
            check_workdir(
                home.path(),
                home.path().join("profiles/owl").to_str().unwrap()
            )
            .is_err()
        );
        for home in [None, Some(std::ffi::OsString::new())] {
            assert_eq!(expand_home_in("~/Hexbot", home).unwrap_err().code, 4202);
        }
        assert_eq!(
            expand_home_in("~/Hexbot", Some("/srv/alex".into())).unwrap(),
            Path::new("/srv/alex/Hexbot")
        );
        assert_eq!(expand_home_in("/tmp/x", None).unwrap(), Path::new("/tmp/x"));
    }
}

#[cfg(test)]
mod tool_safety_tests {
    use super::*;
    #[test]
    fn profile_config_deep_merges_objects_and_replaces_other_values() {
        let home = tempfile::tempdir().unwrap();
        write_config(home.path(), &json!({"video_gen":{"fal":{"model":"A","timeout":60}},"browser":{"allow_private_urls":true},"scalar":false,"list":[1,2]})).unwrap();
        write_config(&home.path().join("profiles/owl"), &json!({"video_gen":{"fal":{"model":"B"}},"browser":{"allow_private_urls":false},"scalar":{"nested":true},"list":[3]})).unwrap();
        let cfg = merged_config(home.path(), "owl").unwrap();
        assert_eq!(cfg["video_gen"]["fal"], json!({"model":"B","timeout":60}));
        assert_eq!(cfg["scalar"], json!({"nested":true}));
        assert_eq!(cfg["list"], json!([3]));
        assert!(!allow_private_urls(home.path(), "owl").unwrap());
        assert!(merged_config(home.path(), "../escape").is_err());
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), home.path().join("profiles/link")).unwrap();
        assert!(merged_config(home.path(), "link").is_err());
        assert!(allow_private_urls(home.path(), "link").is_err());
    }

    #[test]
    fn reads_reject_devices_directories_and_oversize_files() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("text");
        fs::write(&file, b"12345").unwrap();
        assert_eq!(read_regular(&file, 5).unwrap(), b"12345");
        assert!(read_regular(&file, 4).is_err());
        assert!(read_regular(dir.path(), 5).is_err());
        #[cfg(unix)]
        {
            assert!(read_regular(Path::new("/dev/zero"), 5).is_err());
            let fifo = dir.path().join("fifo");
            let name = std::ffi::CString::new(fifo.as_os_str().as_encoded_bytes()).unwrap();
            assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
            assert!(read_regular(&fifo, 5).is_err());
        }
    }
    #[test]
    fn managed_interpreter_precedes_path_fallback() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(managed_python(dir.path()), Path::new("python3"));
        fs::create_dir(dir.path().join("bin")).unwrap();
        fs::write(dir.path().join("bin/python3.11"), "managed").unwrap();
        assert_eq!(
            managed_python(dir.path()),
            dir.path().join("bin/python3.11")
        );
    }
    #[tokio::test]
    async fn own_listener_is_denied_even_with_private_urls_enabled() {
        let listener = tokio::net::TcpListener::bind("0.0.0.0:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let _guard = DaemonListener::register(address);
        let url =
            url::Url::parse(&format!("http://127.0.0.1:{}/auth/session", address.port())).unwrap();
        assert!(url_addresses(&url, true).await.is_err());
        let url = url::Url::parse(&format!("http://0.0.0.0:{}/", address.port())).unwrap();
        assert!(is_daemon_address(
            &format!("0.0.0.0:{}", address.port()).parse().unwrap()
        ));
        assert!(url_addresses(&url, true).await.is_err());
    }
    #[test]
    fn metadata_is_always_denied_and_internal_ranges_require_opt_in() {
        for ip in [
            "0.0.0.0",
            "0.1.2.3",
            "::",
            "::ffff:0.0.0.0",
            "169.254.169.254",
            "169.254.170.2",
            "169.254.1.1",
            "100.100.100.200",
            "fd00:ec2::254",
            "::ffff:169.254.169.254",
        ] {
            for allow in [false, true] {
                assert!(blocked_ip(ip.parse().unwrap(), allow), "{ip}");
            }
        }
        for ip in [
            "127.0.0.1",
            "10.0.0.1",
            "172.16.0.1",
            "192.168.0.1",
            "100.64.0.1",
            "198.18.0.1",
            "::1",
            "fe80::1",
            "fc00::1",
            "::ffff:127.0.0.1",
        ] {
            assert!(blocked_ip(ip.parse().unwrap(), false), "{ip}");
            assert!(!blocked_ip(ip.parse().unwrap(), true), "{ip}");
        }
        for ip in ["8.8.8.8", "2606:4700:4700::1111"] {
            assert!(!blocked_ip(ip.parse().unwrap(), false));
        }
    }
    #[tokio::test]
    async fn dns_failures_and_metadata_names_fail_closed() {
        for url in [
            "http://metadata.google.internal./",
            "http://metadata.goog/",
            "file:///etc/passwd",
            "http://does-not-exist.invalid",
            "http://user:pass@localhost/",
        ] {
            assert!(
                url_addresses(&url::Url::parse(url).unwrap(), true)
                    .await
                    .is_err()
            );
        }
        assert!(
            url_addresses(&url::Url::parse("http://localhost/").unwrap(), false)
                .await
                .is_err()
        );
    }
    #[tokio::test]
    async fn local_http_redirects_and_browser_proxy_enforce_the_same_policy() {
        use axum::{
            Router,
            response::Redirect,
            routing::{get, post},
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = Router::new()
            .route("/ok", get(|| async { "fixture" }))
            .route("/echo", post(|body: String| async move { body }))
            .route("/redirect", get(|| async { Redirect::temporary("/ok") }))
            .route(
                "/metadata",
                get(|| async { Redirect::temporary("http://169.254.169.254/latest") }),
            );
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let url = format!("http://{address}");
        assert!(safe_get(&format!("{url}/ok"), false).await.is_err());
        assert_eq!(
            safe_get(&format!("{url}/redirect"), true)
                .await
                .unwrap()
                .text()
                .await
                .unwrap(),
            "fixture"
        );
        assert!(safe_get(&format!("{url}/metadata"), true).await.is_err());
        for allow in [false, true] {
            let proxy = BrowserProxy::start(allow).await.unwrap();
            let client = reqwest::Client::builder()
                .proxy(reqwest::Proxy::all(format!("http://{}", proxy.address)).unwrap())
                .build()
                .unwrap();
            let response = client.get(format!("{url}/ok")).send().await.unwrap();
            assert_eq!(response.status().is_success(), allow);
            if allow {
                assert_eq!(
                    client
                        .post(format!("{url}/echo"))
                        .body("upload")
                        .send()
                        .await
                        .unwrap()
                        .text()
                        .await
                        .unwrap(),
                    "upload"
                );
            }
            assert!(client.get("https://169.254.169.254/").send().await.is_err());
            let response = client.get(format!("{url}/metadata")).send().await.unwrap();
            assert_eq!(response.status(), reqwest::StatusCode::FORBIDDEN);
        }
        server.abort();
    }
}
