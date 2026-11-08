//! Connector credentials, per-bot selection, skill discovery and MCP transport.
use crate::{
    Error, Result,
    common::{self, *},
    db,
};
use rusqlite::OptionalExtension;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    fs,
    path::{Path, PathBuf},
    sync::{Arc, OnceLock},
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout},
    sync::Mutex,
};
const CATALOG: &str = include_str!("connectors.json");
pub(crate) fn catalog() -> Vec<Value> {
    static DATA: std::sync::OnceLock<Vec<Value>> = std::sync::OnceLock::new();
    DATA.get_or_init(|| serde_json::from_str(CATALOG).expect("static connector catalog"))
        .clone()
}
fn spec(id: &str) -> Result<Value> {
    catalog()
        .into_iter()
        .find(|s| s["id"] == id)
        .ok_or_else(|| Error::new(4213, format!("unknown connector: {id}")))
}
fn strings(v: &Value) -> Vec<String> {
    v.as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}
pub(crate) fn names(home: &Path) -> Result<Vec<String>> {
    Ok(
        rows(&db::open(home)?, "SELECT name FROM bots ORDER BY name", &[])?
            .iter()
            .filter_map(|r| r["name"].as_str().map(str::to_owned))
            .collect(),
    )
}
fn profile(home: &Path, bot: &str) -> Result<PathBuf> {
    identifier(bot)?;
    if !names(home)?.iter().any(|n| n == bot) {
        return Err(Error::new(4205, format!("bot not found: {bot}")));
    }
    Ok(home.join("profiles").join(bot))
}
pub(crate) fn targets(home: &Path) -> Result<Vec<PathBuf>> {
    let mut paths = vec![home.to_path_buf()];
    if home.join("profiles").exists() {
        for entry in fs::read_dir(home.join("profiles"))? {
            let entry = entry?;
            if entry.file_type()?.is_dir() {
                paths.push(entry.path())
            }
        }
    }
    Ok(paths)
}
fn read_env(path: &Path) -> Result<BTreeMap<String, String>> {
    env_values(path)
}
pub fn credentials(home: &Path, bot: &str) -> Result<BTreeMap<String, String>> {
    profile_credentials(home, &profile(home, bot)?)
}
/// Credentials for a profile directory, including one whose bot is still
/// being created and not yet registered.
pub fn profile_credentials(home: &Path, dir: &Path) -> Result<BTreeMap<String, String>> {
    let mut values = read_env(home)?;
    for (k, v) in read_env(dir)? {
        if !v.is_empty() {
            values.insert(k, v);
        }
    }
    Ok(values)
}
fn value(home: &Path, bot: Option<&str>, key: &str) -> Result<Option<String>> {
    if let Some(bot) = bot
        && let Some(v) = read_env(&profile(home, bot)?)?
            .remove(key)
            .filter(|v| !v.is_empty())
    {
        return Ok(Some(v));
    }
    Ok(read_env(home)?
        .remove(key)
        .filter(|v| !v.is_empty())
        .or_else(|| std::env::var(key).ok().filter(|v| !v.is_empty())))
}
fn write_values(
    home: &Path,
    bot: Option<&str>,
    values: &BTreeMap<String, String>,
    clear: &[String],
) -> Result<()> {
    let _lock = credentials_lock().lock().unwrap_or_else(|e| e.into_inner());
    let paths = if let Some(bot) = bot {
        vec![profile(home, bot)?]
    } else {
        targets(home)?
    };
    for path in paths {
        let mut env = read_env(&path)?;
        for key in clear {
            env.remove(key);
        }
        env.extend(values.clone());
        let text = env
            .into_iter()
            .map(|(k, v)| format!("{k}={}\n", serde_json::to_string(&v).expect("string")))
            .collect::<String>();
        atomic_write(&path.join(".env"), text.as_bytes())?;
    }
    Ok(())
}
fn config_set(config: &mut Value, section: &str, key: &str, value: Value) {
    if !config.is_object() {
        *config = json!({})
    }
    if !config[section].is_object() {
        config[section] = json!({})
    }
    if value.is_null() {
        config[section].as_object_mut().unwrap().remove(key);
    } else {
        config[section][key] = value
    }
}
fn write_all(home: &Path, section: &str, key: &str, value: Value) -> Result<()> {
    for path in targets(home)? {
        common::update_config(&path, |config| {
            config_set(config, section, key, value.clone());
            Ok(())
        })?;
    }
    Ok(())
}
/// The provider in use: the one chosen, else the first whose key or setting
/// is saved, else the connector's default (SearXNG for web search).
fn selected(home: &Path, spec: &Value) -> Result<Option<Value>> {
    selected_for(home, None, spec)
}
/// The provider in use for `bot`: as `selected`, except that a key or sign-in
/// saved for that bot alone counts too.
fn selected_for(home: &Path, bot: Option<&str>, spec: &Value) -> Result<Option<Value>> {
    let config = read_config(home)?;
    let providers = spec["providers"].as_array().cloned().unwrap_or_default();
    for p in &providers {
        let a = strings(&p["selection"]);
        if a.len() == 3
            && config[&a[0]][&a[1]]
                .as_str()
                .is_some_and(|s| s.eq_ignore_ascii_case(&a[2]))
        {
            return Ok(Some(p.clone()));
        }
    }
    if spec["id"] == "web_search" {
        // In the order the search itself picks (`native_tools::web_backend`).
        for (backend, key) in crate::native_tools::WEB_BY_KEY {
            if value(home, None, key)?.is_some()
                && let Some(p) = providers.iter().find(|p| {
                    strings(&p["selection"])
                        .get(2)
                        .is_some_and(|b| b == backend)
                })
            {
                return Ok(Some(p.clone()));
            }
        }
    } else {
        // A saved key before a sign-in, so a choice made before sign-ins
        // were offered here keeps working the same way.
        let (keyed, signed): (Vec<_>, Vec<_>) =
            providers.iter().partition(|p| p["sign_in"].is_null());
        for p in keyed.into_iter().chain(signed) {
            if provider_configured(home, bot, p)? {
                return Ok(Some(p.clone()));
            }
        }
    }
    Ok(spec["default_provider"]
        .as_str()
        .and_then(|id| providers.into_iter().find(|p| p["id"] == id)))
}
/// The fields that belong to one provider alone.
fn provider_fields(spec: &Value, provider: &Value) -> Vec<String> {
    spec["fields"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|f| f["provider"] == provider["id"])
        .filter_map(|f| f["key"].as_str().map(str::to_owned))
        .collect()
}
/// Whether a provider has what it needs: its keys, or the sign-in it uses
/// (`sign_in`, a subscription such as SuperGrok).
fn provider_configured(home: &Path, bot: Option<&str>, provider: &Value) -> Result<bool> {
    match provider["sign_in"].as_str() {
        Some(grant) => signed_in(home, bot, grant),
        None => has_keys(home, bot, &strings(&provider["keys"])),
    }
}
fn signed_in(home: &Path, bot: Option<&str>, grant: &str) -> Result<bool> {
    match grant {
        "xai-oauth" => crate::providers::xai_signed_in(home, bot),
        _ => Ok(false),
    }
}
/// Whether a connector works for `bot` (or the daemon): its provider needs
/// no key, as the free web searches do, its sign-in is saved, or every key
/// it needs is.
fn set_up_for(home: &Path, bot: Option<&str>, spec: &Value) -> Result<bool> {
    let Some(provider) = selected_for(home, bot, spec)? else {
        return has_keys(home, bot, &strings(&spec["keys"]));
    };
    if let Some(grant) = provider["sign_in"].as_str() {
        return signed_in(home, bot, grant);
    }
    let keys = strings(&provider["keys"]);
    if keys.is_empty() {
        return Ok(true);
    }
    has_keys(home, bot, &keys)
}
/// The X search provider `bot` uses: `supergrok`, `xai` or `x_api`.
pub(crate) fn x_search_provider(home: &Path, bot: &str) -> Result<Option<String>> {
    Ok(selected_for(home, Some(bot), &spec("x_search")?)?
        .and_then(|p| p["id"].as_str().map(str::to_owned)))
}
fn has_keys(home: &Path, bot: Option<&str>, keys: &[String]) -> Result<bool> {
    for k in keys {
        if value(home, bot, k)?.is_none() {
            return Ok(false);
        }
    }
    Ok(!keys.is_empty())
}
fn required_keys(home: &Path, bot: Option<&str>, spec: &Value) -> Result<Vec<String>> {
    Ok(strings(
        &selected_for(home, bot, spec)?.unwrap_or_else(|| spec.clone())["keys"],
    ))
}
/// Toolsets no longer offered. Bots run code and browse on their own
/// computer through Computer use; image and video generation and Home
/// Assistant were removed with their connectors.
const RETIRED_TOOLSETS: &[&str] = &[
    "code_execution",
    "browser",
    "image_gen",
    "video_gen",
    "homeassistant",
];
/// Every bot has Computer use; it works once the computer is set up.
const BUILT_IN_TOOLSET: &str = "computer_use";

pub fn toolsets(home: &Path, bot: &str) -> Result<Vec<String>> {
    let mut sets = configured_toolsets(home, bot)?;
    sets.retain(|set| !RETIRED_TOOLSETS.contains(&set.as_str()));
    if !sets.iter().any(|set| set == BUILT_IN_TOOLSET) {
        sets.push(BUILT_IN_TOOLSET.to_owned());
    }
    Ok(sets)
}
fn configured_toolsets(home: &Path, bot: &str) -> Result<Vec<String>> {
    let config = read_config(&profile(home, bot)?)?;
    for v in [
        &config["tools"]["enabled_toolsets"],
        &config["platform_toolsets"]["cli"],
    ] {
        if v.is_array() {
            return Ok(strings(v));
        }
    }
    let root = read_config(home)?;
    for v in [
        &root["tools"]["enabled_toolsets"],
        &root["platform_toolsets"]["cli"],
    ] {
        if v.is_array() {
            return Ok(strings(v));
        }
    }
    Ok([
        "terminal",
        "file",
        "web",
        "vision",
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
    .map(str::to_string)
    .to_vec())
}
/// Whether a daemon-level server is given to `bot`. Its `bots` list is the
/// assignment; an entry without one predates it and reaches every bot until
/// the next start writes the list (`migrate`).
fn assigned(entry: &Value, bot: &str) -> bool {
    entry["bots"]
        .as_array()
        .is_none_or(|bots| bots.iter().any(|b| b == bot))
}
/// The servers a bot may use: daemon-level ones assigned to it, plus servers
/// defined only in its own profile. A profile entry never redefines a
/// daemon-level server; one marked disabled still withholds it. A daemon-level
/// server still waiting for a value reaches no bot.
pub fn mcp_servers(home: &Path, bot: &str) -> Result<Value> {
    let root = read_config(home)?;
    let mut servers = granted_servers(home, bot)?;
    if let Some(servers) = servers.as_object_mut() {
        servers.retain(|name, entry| {
            !root["mcp_servers"].get(name).is_some_and(Value::is_object)
                || missing_values(entry).is_empty()
        });
    }
    Ok(servers)
}
/// The servers given to a bot, set up or not: what assignments and their
/// migration count, so a value still missing never takes a server's bots.
fn granted_servers(home: &Path, bot: &str) -> Result<Value> {
    let root = read_config(home)?;
    let config = read_config(&profile(home, bot)?)?;
    let mut servers = root["mcp_servers"].as_object().cloned().unwrap_or_default();
    servers.retain(|_, entry| assigned(entry, bot));
    if let Some(own) = config["mcp_servers"].as_object() {
        for (name, entry) in own {
            if root["mcp_servers"].get(name).is_some_and(Value::is_object) {
                if entry["disabled"] == true {
                    servers.remove(name);
                }
            } else {
                servers.insert(name.clone(), entry.clone());
            }
        }
    }
    servers.retain(|_, entry| entry.is_object() && entry["disabled"] != true);
    Ok(Value::Object(servers))
}
/// Give a daemon-level server to exactly `bots`, and drop any copy of it a
/// bot profile still holds.
pub(crate) fn assign_mcp(home: &Path, server: &str, bots: &[String]) -> Result<()> {
    change_mcp_bots(home, server, |list| {
        *list = bots.to_vec();
        Ok(())
    })
}
/// Change a daemon-level server's `bots` list from read to write under the
/// config lock, so concurrent changes keep each other's bots. The stored list
/// counts even while the server is switched off; an entry without one starts
/// from the bots that use it now.
pub(crate) fn change_mcp_bots(
    home: &Path,
    server: &str,
    change: impl FnOnce(&mut Vec<String>) -> Result<()>,
) -> Result<()> {
    common::update_config(home, |config| {
        let entry = config["mcp_servers"]
            .get_mut(server)
            .filter(|v| v.is_object())
            .ok_or_else(|| Error::new(4213, format!("unknown MCP server: {server}")))?;
        let mut bots = if entry["bots"].is_array() {
            strings(&entry["bots"])
        } else {
            assigned_bots(home, server)?
        };
        change(&mut bots)?;
        bots.sort();
        bots.dedup();
        entry["bots"] = json!(bots);
        Ok(())
    })?;
    forget_profile_copies(home, server)
}
fn forget_profile_copies(home: &Path, server: &str) -> Result<()> {
    for path in targets(home)?.into_iter().skip(1) {
        if read_config(&path)?["mcp_servers"].get(server).is_some() {
            common::update_config(&path, |config| {
                if let Some(servers) = config["mcp_servers"].as_object_mut() {
                    servers.remove(server);
                }
                Ok(())
            })?;
        }
    }
    Ok(())
}
/// The bots a daemon-level server is given to: its stored list, which counts
/// while the server is switched off, or for an entry without one the bots
/// that use it now.
pub(crate) fn mcp_bots(home: &Path, server: &str) -> Result<Vec<String>> {
    match read_config(home)?["mcp_servers"].get(server) {
        Some(entry) if entry["bots"].is_array() => Ok(strings(&entry["bots"])),
        _ => assigned_bots(home, server),
    }
}
pub(crate) fn assigned_bots(home: &Path, server: &str) -> Result<Vec<String>> {
    let mut bots = vec![];
    for bot in names(home)? {
        if granted_servers(home, &bot)?.get(server).is_some() {
            bots.push(bot);
        }
    }
    Ok(bots)
}
/// Write each daemon-level server's `bots` list from what every bot can use
/// now, then remove the per-bot copies older versions kept. Runs at every
/// start; an entry that already has a list is left alone.
pub(crate) fn migrate(home: &Path) -> Result<()> {
    let root = read_config(home)?;
    let Some(servers) = root["mcp_servers"].as_object() else {
        return Ok(());
    };
    for (name, entry) in servers {
        if entry.is_object() && entry["bots"].is_null() {
            let bots = assigned_bots(home, name)?;
            assign_mcp(home, name, &bots)?;
        }
    }
    Ok(())
}
/// Take a deleted bot off every server, so a new bot with its name starts
/// with none.
pub(crate) fn forget_bot(home: &Path, bot: &str) -> Result<()> {
    let root = read_config(home)?;
    for (name, entry) in root["mcp_servers"].as_object().into_iter().flatten() {
        if let Some(bots) = entry["bots"].as_array()
            && bots.iter().any(|b| b == bot)
        {
            change_mcp_bots(home, name, |bots| {
                bots.retain(|b| b != bot);
                Ok(())
            })?;
        }
    }
    Ok(())
}
// Keep executable lookup and relative arguments out of bot-controlled folders.
fn mcp_cwd(home: &Path, bot: Option<&str>) -> Result<PathBuf> {
    if let Some(bot) = bot {
        identifier(bot)?;
    }
    let path = home.join("runtime/mcp").join(bot.unwrap_or("probe"));
    fs::create_dir_all(&path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(fs::canonicalize(path)?)
}

pub fn pi_mcp_servers(home: &Path, bot: &str, names: &[Value]) -> Result<Vec<Value>> {
    let servers = mcp_servers(home, bot)?;
    let env = credentials(home, bot)?;
    let mut result = vec![];
    for name in names.iter().filter_map(Value::as_str) {
        let Some(entry) = servers.get(name) else {
            continue;
        };
        if entry["transport"] == "sse" {
            continue;
        }
        let description = entry.get("description").cloned();
        let entry = expand_config(entry, &env);
        if validate_mcp_security(&entry).is_err() {
            result.push(json!({"name":name,"error":format!("Connected tool {name} has invalid settings. Check it in bot settings.")}));
            continue;
        }
        let keys: &[&str] = if entry["url"].is_string() {
            &["url", "headers", "description", "timeout"]
        } else {
            &["command", "args", "env", "description", "timeout"]
        };
        let mut config = json!({"exposure":"codemode"});
        for key in keys {
            if let Some(value) = entry.get(*key) {
                config[*key] = value.clone();
            }
        }
        // Descriptions are prompt metadata, never credential templates.
        if let Some(description) = description {
            config["description"] = description;
        }
        if !entry["url"].is_string() {
            config["cwd"] = json!(mcp_cwd(home, Some(bot))?);
        }
        let revision = format!("{:x}", Sha256::digest(config.to_string().as_bytes()));
        result.push(json!({"name":name,"config":config,"revision":revision}));
    }
    Ok(result)
}

pub(crate) fn enabled(home: &Path, bot: &str, id: &str) -> Result<bool> {
    if let Some(server) = id.strip_prefix("mcp:") {
        return Ok(mcp_servers(home, bot)?.get(server).is_some());
    }
    let s = spec(id)?;
    if let Some(skill) = s["skill"].as_str() {
        return Ok(crate::skills::resolve(home, Some(bot))?
            .iter()
            // Readiness only hides the skill; the bot's grant is its own.
            .any(|s| s.name == skill && s.enabled_for_bot && !s.disabled_globally));
    }
    let tools = toolsets(home, bot)?;
    if id == "web_search" {
        return Ok(tools.iter().any(|t| t == "web" || t == "search"));
    }
    Ok(strings(&s["toolsets"]).iter().all(|t| tools.contains(t)))
}
/// Turn a connector on or off for one bot. One that is not set up for that
/// bot can be turned off but not on.
pub(crate) fn set_enabled(home: &Path, bot: &str, id: &str, on: bool) -> Result<()> {
    if on {
        let row = get(home, Some(bot), id)?;
        if row["ready"] != true {
            return Err(not_set_up(row["name"].as_str().unwrap_or(id)));
        }
    }
    if !id.starts_with("mcp:") {
        let s = spec(id)?;
        if let Some(skill) = s["skill"].as_str() {
            let _guard = crate::skills::read_lock()?;
            crate::skills::find_unlocked(home, Some(bot), skill)?;
            return crate::skills::set_enabled(home, Some(bot), skill, on);
        }
    }
    if let Some(server) = id.strip_prefix("mcp:") {
        return change_mcp_bots(home, server, |bots| {
            bots.retain(|b| b != bot);
            if on {
                bots.push(bot.to_string());
            }
            Ok(())
        });
    }
    set_toolsets(home, bot, id, on)
}
/// Why a plugin that is not set up can't be given to a bot.
pub(crate) fn not_set_up(name: &str) -> Error {
    Error::new(4209, format!("Set up {name} before giving it to a bot."))
}
/// Turn a catalog connector's toolsets on or off for one bot.
pub(crate) fn set_toolsets(home: &Path, bot: &str, id: &str, on: bool) -> Result<()> {
    switch_toolsets(home, bot, &strings(&spec(id)?["toolsets"]), on)
}
/// Turn toolsets on or off for one bot, leaving its other toolsets as they are.
pub(crate) fn switch_toolsets(home: &Path, bot: &str, sets: &[String], on: bool) -> Result<()> {
    let path = profile(home, bot)?;
    common::update_config(&path, |config| {
        let mut tools = toolsets(home, bot)?.into_iter().collect::<BTreeSet<_>>();
        for t in sets.iter().cloned() {
            if on {
                tools.insert(t);
            } else {
                tools.remove(&t);
                if t == "web" {
                    tools.remove("search");
                }
            }
        }
        config_set(config, "tools", "enabled_toolsets", json!(tools));
        config_set(config, "platform_toolsets", "cli", json!(tools));
        config_set(config, "known_plugin_toolsets", "cli", json!(["hexbot"]));
        Ok(())
    })
}
fn last_test(home: &Path, id: &str) -> Result<Option<Value>> {
    let raw: Option<String> = db::open(home)?
        .query_row(
            "SELECT value FROM settings WHERE key=?",
            [format!("connector_test:{id}")],
            |r| r.get(0),
        )
        .optional()?;
    Ok(raw.and_then(|s| serde_json::from_str(&s).ok()))
}
fn save_test(home: &Path, id: &str, result: &Value, probed: bool) -> Result<()> {
    let mut v = result.clone();
    v["probed"] = json!(probed);
    v["at"] = json!(now());
    db::open(home)?.execute(
        "INSERT OR REPLACE INTO settings(key,value) VALUES (?,?)",
        [format!("connector_test:{id}"), v.to_string()],
    )?;
    Ok(())
}
pub(crate) fn list(home: &Path, bot: Option<&str>) -> Result<Value> {
    if let Some(b) = bot {
        profile(home, b)?;
    }
    let names = names(home)?;
    let mut out = vec![];
    let conn = db::open(home)?;
    let incidents = rows(
        &conn,
        "SELECT connector,text,created_at FROM bot_incidents WHERE resolved_at IS NULL AND kind='connector_error' AND connector IS NOT NULL ORDER BY created_at DESC",
        &[],
    )?;
    for s in catalog() {
        let id = s["id"].as_str().unwrap();
        let provider = selected_for(home, bot, &s)?;
        let required = required_keys(home, bot, &s)?;
        let ready = set_up_for(home, bot, &s)?;
        let last = if ready { last_test(home, id)? } else { None };
        let err = incidents.iter().find(|i| i["connector"] == id);
        let (state, mut state_text) = if let Some(err) = err {
            (
                "error",
                err["text"]
                    .as_str()
                    .unwrap_or("")
                    .lines()
                    .next()
                    .unwrap_or("")
                    .chars()
                    .take(80)
                    .collect(),
            )
        } else if ready && last.as_ref().is_some_and(|v| v["ok"] == false) {
            (
                "error",
                last.as_ref().unwrap()["message"]
                    .as_str()
                    .unwrap_or("The last test failed.")
                    .chars()
                    .take(80)
                    .collect(),
            )
        } else if ready {
            (
                "ready",
                if last.as_ref().is_some_and(|v| v["probed"] == true) {
                    "Connected"
                } else if provider.as_ref().is_some_and(|p| p["sign_in"].is_string()) {
                    "Signed in"
                } else if required.is_empty() {
                    "Ready"
                } else {
                    "Key saved"
                }
                .to_string(),
            )
        } else {
            ("not_set_up", "Not set up".to_string())
        };
        if state == "ready"
            && let Some(p) = &provider
        {
            state_text.push_str(&format!(" · {}", p["label"].as_str().unwrap_or("")));
            // The SearXNG Hexbot runs: starting, or why it is not running.
            if p["id"] == "searxng"
                && let Some(note) = crate::searxng::note(home)
            {
                state_text.push_str(&format!(" ({note})"));
            }
        }
        let mut fields = s["fields"].as_array().unwrap().clone();
        for field in &mut fields {
            let val = value(home, bot, field["key"].as_str().unwrap())?;
            field["set"] = json!(val.is_some());
            field["hint"] = val
                .filter(|v| v.chars().count() >= 8)
                .map(|v| {
                    json!(format!(
                        "…{}",
                        v.chars().skip(v.chars().count() - 4).collect::<String>()
                    ))
                })
                .unwrap_or(Value::Null);
        }
        let providers = if let Some(ps) = s["providers"].as_array() {
            let mut result = vec![];
            for p in ps {
                result.push(json!({"id":p["id"],"label":p["label"],"description":p["description"],"sign_in":p["sign_in"],"configured":provider_configured(home,bot,p)?}));
            }
            json!(result)
        } else {
            Value::Null
        };
        // A bot has a connector once it is on and set up for that bot; a
        // default left on before setup gives it to nobody. A key in a bot's
        // own `.env` sets it up for that bot alone.
        let mut bots = vec![];
        let mut ready_bots = vec![];
        // On for a bot but waiting for its key: kept, and given once set up.
        let mut waiting_bots = vec![];
        for n in &names {
            if set_up_for(home, Some(n), &s)? {
                ready_bots.push(n.clone());
                if enabled(home, n, id)? {
                    bots.push(n.clone())
                }
            } else if enabled(home, n, id)? {
                waiting_bots.push(n.clone());
            }
        }
        out.push(json!({
            "id": id,
            "name": s["name"],
            "description": s["description"],
            "group": s["group"],
            "icon": s["icon"],
            "scope": "daemon",
            "ready": ready,
            "state": state,
            "state_text": state_text,
            "providers": providers,
            "provider": provider.map(|p| p["id"].clone()),
            "fields": fields,
            "enabled_for_bot": bot.map(|b| bots.iter().any(|n| n == b)),
            "enabled_bots": bots,
            "ready_bots": ready_bots,
            "waiting_bots": waiting_bots,
            "last_error": err.map(|e| {
                json!({
                "text":e["text"],
                "at":e["created_at"]}
                )
            })
        }));
    }
    let config = read_config(home)?;
    if let Some(servers) = config["mcp_servers"].as_object() {
        for (name, entry) in servers {
            if !entry.is_object() {
                continue;
            }
            let id = format!("mcp:{name}");
            let err = incidents.iter().find(|e| e["connector"] == id);
            let disabled = entry["disabled"] == true;
            let missing = missing_values(entry);
            let ready = !disabled && missing.is_empty();
            let mut bots = vec![];
            for n in &names {
                if enabled(home, n, &id)? {
                    bots.push(n.clone())
                }
            }
            let tested = last_test(home, &id)?;
            let failed = tested.as_ref().is_some_and(|v| v["ok"] == false);
            // A value left empty keeps the server from starting, so it
            // outranks an error from an earlier run.
            let (state, state_text) = if !missing.is_empty() {
                ("not_set_up", format!("Needs {}", missing.join(", ")))
            } else if let Some(e) = err {
                (
                    "error",
                    e["text"].as_str().unwrap_or("").chars().take(80).collect(),
                )
            } else if failed {
                ("error", "Test failed".to_string())
            } else if disabled {
                ("not_set_up", "Disabled".to_string())
            } else {
                ("ready", "Running".to_string())
            };
            let description = entry["url"].as_str().map(str::to_owned).unwrap_or_else(|| {
                std::iter::once(entry["command"].as_str().unwrap_or("").to_string())
                    .chain(strings(&entry["args"]))
                    .collect::<Vec<_>>()
                    .join(" ")
            });
            out.push(json!({
                "id": id,
                "name": name,
                "description": description,
                "group": "mcp",
                "icon": "glyph:server",
                "scope": "daemon",
                "ready": ready,
                "state": state,
                "state_text": state_text,
                "providers": null,
                "provider": null,
                "fields": [],
                "enabled_for_bot": bot.map(|b| bots.iter().any(|n| n == b)),
                "enabled_bots": bots,
                "last_error": err.map(|e| {
                    json!({
                    "text":e["text"],
                    "at":e["created_at"]}
                    )
                }),
                "mcp": {
                    "name": name,
                    "transport": if entry["url"].is_string() {
                        entry["transport"].as_str().unwrap_or("http")
                    } else {
                        "stdio"
                    },
                    "tool_count": tested.as_ref().and_then(|v| v.get("tool_count")).cloned(),
                    "test_failed": failed,
                    "running": !disabled
                }
            }));
        }
    }
    Ok(json!({"connectors":out}))
}
/// The env or header values a server was added with but left empty: the
/// user still has to fill them in before it can start.
pub(crate) fn missing_values(entry: &Value) -> Vec<String> {
    [&entry["env"], &entry["headers"]]
        .into_iter()
        .flat_map(|v| v.as_object().into_iter().flatten())
        .filter(|(_, v)| v.as_str().is_some_and(str::is_empty))
        .map(|(k, _)| k.clone())
        .collect()
}
pub(crate) fn get(home: &Path, bot: Option<&str>, id: &str) -> Result<Value> {
    list(home, bot)?["connectors"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["id"] == id)
        .cloned()
        .ok_or_else(|| Error::new(4213, format!("unknown connector: {id}")))
}
/// A server's error with its own environment and header values cut out:
/// a server may quote the token it refused, and the message is saved and
/// shown to bots.
fn without_values(message: &str, entry: &Value, env: &BTreeMap<String, String>) -> String {
    let resolved = expand_config(entry, env);
    let mut secrets = [&resolved["env"], &resolved["headers"]]
        .into_iter()
        .flat_map(|v| v.as_object().into_iter().flatten())
        .filter_map(|(_, v)| v.as_str().filter(|v| !v.is_empty()))
        // A header such as `Bearer <token>` may be quoted by its token alone.
        .flat_map(|v| {
            std::iter::once(v).chain(v.split_whitespace().filter(|p| p.chars().count() >= 6))
        })
        .map(str::to_owned)
        .collect::<Vec<_>>();
    // Longest first, so a whole value goes before a part of it.
    secrets.sort_by_key(|v| std::cmp::Reverse(v.len()));
    secrets.iter().fold(message.to_owned(), |text, secret| {
        text.replace(secret.as_str(), "…")
    })
}
async fn probe(home: &Path, id: &str, bot: Option<&str>) -> Result<Value> {
    if let Some(server) = id.strip_prefix("mcp:") {
        let root = read_config(home)?["mcp_servers"].clone();
        // From a bot's settings, a server not given to it yet can still be
        // tested before it is: its own copy first, then the daemon's.
        let config = if let Some(bot) = bot {
            mcp_servers(home, bot)?
        } else {
            root.clone()
        };
        let Some(entry) = config.get(server).or_else(|| root.get(server)) else {
            return Ok(
                json!({"ok":false,"message":"This connected tool is not defined or is disabled."}),
            );
        };
        if entry["disabled"] == true {
            return Ok(json!({"ok":false,"message":"Disabled."}));
        }
        let env = if let Some(bot) = bot {
            credentials(home, bot)?
        } else {
            read_env(home)?
        };
        let result = async {
            let mut entry = entry.clone();
            entry["probe_env"] = json!(true);
            entry["cwd"] = json!(mcp_cwd(home, bot)?);
            let mut session = McpSession::connect(&entry, &env).await?;
            let mut count = 0;
            let mut cursor = Value::Null;
            let mut seen = BTreeSet::new();
            loop {
                let params = if cursor.is_null() {
                    json!({})
                } else {
                    json!({"cursor":cursor})
                };
                let response = session.request("tools/list", params).await?;
                count += response["tools"].as_array().map_or(0, Vec::len);
                cursor = response["nextCursor"].clone();
                if cursor.is_null() {
                    break;
                }
                if seen.len() >= 1000 || !seen.insert(cursor.to_string()) {
                    return Err(transport_error("server repeated tools cursor"));
                }
            }
            Ok(count)
        }
        .await;
        let result = match result {
            Ok(count) => json!({"ok":true,"message":"Connected.","tool_count":count}),
            Err(e) => json!({"ok":false,"message":without_values(&e.message, entry, &env)}),
        };
        save_test(home, id, &result, true)?;
        return Ok(result);
    }
    let s = spec(id)?;
    if id == "web_search"
        && let Some(provider) = selected(home, &s)?
        && strings(&provider["keys"]).is_empty()
    {
        let (result, probed) = probe_free_search(home, bot, &provider).await;
        save_test(home, id, &result, probed)?;
        return Ok(result);
    }
    if let Some(provider) = selected_for(home, bot, &s)?
        && provider["sign_in"].is_string()
    {
        let result = probe_sign_in(home, bot, &provider).await;
        save_test(home, id, &result, result["ok"] == true)?;
        return Ok(result);
    }
    let keys = required_keys(home, bot, &s)?;
    if keys.is_empty() {
        return Ok(json!({"ok":false,"message":"Choose a provider first."}));
    }
    let mut missing = vec![];
    for k in &keys {
        if value(home, bot, k)?.is_none() {
            missing.push(k.clone())
        }
    }
    if !missing.is_empty() {
        return Ok(json!({"ok":false,"message":format!("Missing {}.",missing.join(", "))}));
    }
    let key = |k: &str| value(home, bot, k).map(|v| v.unwrap_or_default());
    let mut headers = reqwest::header::HeaderMap::new();
    let (name, url, auth) = match id {
        "notion" => {
            headers.insert(
                "Notion-Version",
                reqwest::header::HeaderValue::from_static("2022-06-28"),
            );
            (
                "Notion",
                "https://api.notion.com/v1/users/me".to_string(),
                Some((
                    "authorization",
                    format!("Bearer {}", key("NOTION_API_KEY")?),
                )),
            )
        }
        // The usage summary costs nothing, unlike a search.
        "x_search" if keys.iter().any(|k| k == "X_BEARER_TOKEN") => (
            "X",
            format!("{}/2/usage/tweets", x_api_base(home, bot)?),
            Some((
                "authorization",
                format!("Bearer {}", key("X_BEARER_TOKEN")?),
            )),
        ),
        "x_search" => (
            "xAI",
            "https://api.x.ai/v1/models".to_string(),
            Some(("authorization", format!("Bearer {}", key("XAI_API_KEY")?))),
        ),
        _ => {
            let r = json!({"ok":true,"message":"Key saved."});
            save_test(home, id, &r, false)?;
            return Ok(r);
        }
    };
    if let Some((header, value)) = auth {
        headers.insert(
            reqwest::header::HeaderName::from_static(header),
            reqwest::header::HeaderValue::from_str(&value)
                .map_err(|_| Error::new(4202, "credential contains an invalid header character"))?,
        );
    }
    let client = crate::http::client(6, 0).map_err(|e| Error::new(5200, e.to_string()))?;
    let result = match client.get(url).headers(headers).send().await {
        Ok(response) => {
            let status = response.status().as_u16();
            if status == 401 || status == 403 {
                json!({"ok":false,"message":format!("{name} refused the token ({status}).")})
            } else if !(200..300).contains(&status) {
                json!({"ok":false,"message":format!("{name} answered {status}.")})
            } else {
                json!({"ok":true,"message":"Connected."})
            }
        }
        Err(e) => {
            json!({"ok":false,"message":format!("Could not reach {name}: {}.",if e.is_timeout(){"timed out"}else if e.is_connect(){"connection failed"}else{"request failed"})})
        }
    };
    save_test(home, id, &result, true)?;
    Ok(result)
}
/// Where the X API answers: `HEXBOT_X_API_BASE_URL`, else api.x.com.
pub(crate) fn x_api_base(home: &Path, bot: Option<&str>) -> Result<String> {
    Ok(value(home, bot, "HEXBOT_X_API_BASE_URL")?
        .unwrap_or_else(|| "https://api.x.com".to_owned())
        .trim_end_matches('/')
        .to_owned())
}
/// Test a subscription sign-in by fetching a fresh token: an expired one is
/// refreshed, and a revoked one fails here rather than in a bot's turn.
async fn probe_sign_in(home: &Path, bot: Option<&str>, provider: &Value) -> Value {
    let label = provider["label"].as_str().unwrap_or("your subscription");
    match provider["sign_in"].as_str() {
        Some("xai-oauth") if !signed_in(home, bot, "xai-oauth").unwrap_or(false) => {
            json!({"ok":false,"message":format!("Sign in with {label} first.")})
        }
        Some("xai-oauth") => match crate::providers::xai_subscription_token(home, bot).await {
            Ok(_) => json!({"ok":true,"message":"Signed in."}),
            Err(e) => json!({"ok":false,"message":format!("{label}: {}", e.message)}),
        },
        _ => json!({"ok":false,"message":"Choose a provider first."}),
    }
}
/// Test a web search that needs no key with one real search. The SearXNG
/// Hexbot runs starts first; until it runs, bots search with Tavily and
/// Wikipedia, and the answer says so. Returns the result and whether a
/// service answered.
async fn probe_free_search(home: &Path, bot: Option<&str>, provider: &Value) -> (Value, bool) {
    const FALLBACK: &str = "Until it runs, bots search with Tavily and Wikipedia.";
    if provider["id"] == "searxng" && crate::searxng::chosen(home) {
        if !crate::searxng::wanted(home) {
            return (
                json!({"ok":true,"message":format!("SearXNG needs Docker on the daemon's computer. {FALLBACK}")}),
                false,
            );
        }
        // A first start downloads SearXNG; it runs on after the test stops
        // waiting, which it does before the apps' 30-second request deadline.
        let owned = home.to_owned();
        let task = tokio::spawn(async move { crate::searxng::ensure(&owned).await });
        return match tokio::time::timeout(Duration::from_secs(25), task).await {
            Ok(Ok(Ok(_))) => (
                json!({"ok":true,"message":"SearXNG is running on this computer."}),
                true,
            ),
            Ok(Ok(Err(e))) => (
                json!({"ok":true,"message":format!("SearXNG did not start: {}. {FALLBACK}", e.message)}),
                false,
            ),
            _ => (
                json!({"ok":true,"message":format!("SearXNG is still starting. {FALLBACK}")}),
                false,
            ),
        };
    }
    match crate::native_tools::test_search(home, bot).await {
        Ok(()) => (json!({"ok":true,"message":"Connected."}), true),
        Err(e) => (json!({"ok":false,"message":e.message}), true),
    }
}
/// The bots a plugin goes to after the caller picks `value`, a list of bot
/// names they own. Bots in `current` that belong to someone else stay.
pub(crate) fn chosen_bots(
    home: &Path,
    caller: &str,
    current: &[String],
    value: &Value,
) -> Result<Vec<String>> {
    let list = value
        .as_array()
        .ok_or_else(|| Error::new(4202, "bots must be an array of bot names"))?;
    let mut bots = BTreeSet::new();
    for bot in list {
        let bot = bot
            .as_str()
            .ok_or_else(|| Error::new(4202, "bots must be an array of bot names"))?;
        bot_owner(home, caller, bot)?;
        bots.insert(bot.to_string());
    }
    for bot in current {
        if bot_owner(home, caller, bot).is_err() {
            bots.insert(bot.clone());
        }
    }
    Ok(bots.into_iter().collect())
}
pub(crate) fn validate_mcp(p: &Value) -> Result<(String, Value)> {
    let name = required(p, "name")?.trim();
    if name.len() > 64
        || !name
            .bytes()
            .next()
            .is_some_and(|c| c.is_ascii_alphanumeric())
        || !name
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    {
        return Err(Error::new(
            4202,
            "MCP server name must be letters, digits, - or _",
        ));
    }
    if p["transport"] == "sse" {
        return Err(Error::new(
            4202,
            "SSE is not supported. Use the server's streamable HTTP URL.",
        ));
    }
    let mut entry = json!({});
    if let Some(url) = p["url"].as_str().filter(|s| !s.is_empty()) {
        let parsed = url::Url::parse(url).map_err(|_| Error::new(4202, "invalid MCP URL"))?;
        if !matches!(parsed.scheme(), "https" | "http")
            || parsed.host_str().is_none()
            || !parsed.username().is_empty()
            || parsed.password().is_some()
        {
            return Err(Error::new(
                4202,
                "MCP URL must use HTTP or HTTPS without credentials",
            ));
        }
        let transport = p["transport"].as_str().unwrap_or("http");
        if !matches!(transport, "http" | "streamable-http") {
            return Err(Error::new(4202, "unknown MCP transport"));
        }
        entry["url"] = json!(url);
        entry["transport"] = json!(transport);
        if !p["headers"].is_null() {
            entry["headers"] = string_map(&p["headers"], "MCP headers")?;
        }
    } else {
        let command = p["command"]
            .as_str()
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| Error::new(4200, "an MCP server needs a command or a url"))?;
        if command.contains('\0') {
            return Err(Error::new(4202, "invalid MCP command"));
        }
        entry["command"] = json!(command);
        if !p["args"].is_null() {
            let args = p["args"]
                .as_array()
                .ok_or_else(|| Error::new(4202, "MCP args must be an array"))?;
            if args
                .iter()
                .any(|a| !a.is_string() || a.as_str().is_some_and(|s| s.contains('\0')))
            {
                return Err(Error::new(4202, "MCP args must be strings"));
            }
            entry["args"] = json!(args);
        }
    }
    if !p["env"].is_null() {
        let env = p["env"]
            .as_object()
            .ok_or_else(|| Error::new(4202, "MCP env must be an object"))?;
        if env.iter().any(|(k, v)| {
            k.is_empty()
                || k.contains(['=', '\0'])
                || !v.is_string()
                || v.as_str()
                    .is_some_and(|s| s.contains('\0') || s.starts_with('!'))
        }) {
            return Err(Error::new(4202, "invalid MCP environment"));
        }
        entry["env"] = p["env"].clone();
    }
    validate_mcp_security(&entry)?;
    Ok((name.to_string(), entry))
}
/// A map of plain strings, such as an MCP server's headers.
fn string_map(value: &Value, what: &str) -> Result<Value> {
    let map = value
        .as_object()
        .ok_or_else(|| Error::new(4202, format!("{what} must be an object")))?;
    if map.iter().any(|(k, v)| {
        k.is_empty()
            || k.contains([':', '\0', '\n', '\r'])
            || !v.is_string()
            || v.as_str().is_some_and(|s| s.contains(['\0', '\n', '\r']))
    }) {
        return Err(Error::new(4202, format!("invalid {what}")));
    }
    Ok(value.clone())
}
async fn dispatch(home: &Path, caller: &str, method: &str, p: &Value) -> Result<Value> {
    user(home, caller)?;
    let bot = p["bot"].as_str().filter(|s| !s.is_empty());
    if let Some(bot) = bot {
        bot_owner(home, caller, bot)?;
    }
    let id = p["id"].as_str().unwrap_or("");
    let bot_only = p["bot_only"] == true;
    match method {
        "hexbot.connectors.list" => list(home, bot),
        "hexbot.connectors.test" => probe(home, required(p, "id")?, bot).await,
        "hexbot.connectors.set_for_bot" => {
            let bot = required(p, "bot")?;
            let on = p["enabled"]
                .as_bool()
                .ok_or_else(|| Error::new(4200, "missing parameter: enabled"))?;
            set_enabled(home, bot, required(p, "id")?, on)?;
            Ok(json!({"connector":get(home,Some(bot),id)?}))
        }
        "hexbot.connectors.setup" => {
            user(home, caller)?;
            let s = spec(required(p, "id")?)?;
            if bot_only && bot.is_none() {
                return Err(Error::new(4200, "bot_only needs a bot"));
            }
            let mut values = BTreeMap::new();
            if !p["values"].is_null() {
                let fields = p["values"]
                    .as_object()
                    .ok_or_else(|| Error::new(4202, "values must be an object"))?;
                for (k, v) in fields {
                    let v = v
                        .as_str()
                        .ok_or_else(|| Error::new(4202, "credential values must be strings"))?
                        .trim();
                    if !s["fields"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|f| f["key"] == *k)
                    {
                        return Err(Error::new(4201, format!("unknown field: {k}")));
                    }
                    if !v.is_empty() {
                        values.insert(k.clone(), v.to_string());
                    }
                }
            }
            let provider = if let Some(ps) = s["providers"].as_array() {
                let chosen = if let Some(name) = p["provider"].as_str().filter(|s| !s.is_empty()) {
                    ps.iter().find(|p| p["id"] == name).cloned()
                } else {
                    // The provider whose keys were sent, then one whose own
                    // optional setting was, then the one in use.
                    ps.iter()
                        .find(|p| {
                            let keys = strings(&p["keys"]);
                            !keys.is_empty() && keys.iter().all(|k| values.contains_key(k))
                        })
                        .or_else(|| {
                            ps.iter().find(|p| {
                                provider_fields(&s, p)
                                    .iter()
                                    .any(|k| values.contains_key(k))
                            })
                        })
                        .cloned()
                        .or(selected(home, &s)?)
                };
                Some(chosen.ok_or_else(|| {
                    Error::new(
                        4202,
                        format!(
                            "choose a provider: {}",
                            ps.iter()
                                .filter_map(|p| p["id"].as_str())
                                .collect::<Vec<_>>()
                                .join(", ")
                        ),
                    )
                })?)
            } else {
                None
            };
            if id == "x_search"
                && !bot_only
                && let Some(key) = values.remove("XAI_API_KEY")
            {
                crate::providers::set_key(home, "xai", &key)?;
            }
            write_values(home, if bot_only { bot } else { None }, &values, &[])?;
            if let Some(provider) = provider {
                let selection = strings(&provider["selection"]);
                write_all(home, &selection[0], &selection[1], json!(selection[2]))?;
            }
            let result = probe(home, id, bot).await?;
            if result["ok"] == true {
                db::open(home)?.execute("UPDATE bot_incidents SET resolved_at=? WHERE connector=? AND resolved_at IS NULL",rusqlite::params![now(),id])?;
                if let Some(bot) = bot
                    && p["enable_for_bot"] != false
                {
                    set_enabled(home, bot, id, true)?;
                }
            }
            Ok(json!({"connector":get(home,bot,id)?,"test":result}))
        }
        "hexbot.connectors.clear" => {
            user(home, caller)?;
            let s = spec(required(p, "id")?)?;
            if bot_only && bot.is_none() {
                return Err(Error::new(4200, "bot_only needs a bot"));
            }
            let mut shared = BTreeSet::new();
            for other in catalog() {
                if other["id"] != id {
                    for key in required_keys(home, bot, &other)? {
                        if value(home, bot, &key)?.is_some() {
                            shared.insert(key);
                        }
                    }
                }
            }
            let keys = s["fields"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(|f| f["key"].as_str())
                .filter(|k| *k != "XAI_API_KEY" && !shared.contains(*k))
                .map(str::to_string)
                .collect::<Vec<_>>();
            write_values(
                home,
                if bot_only { bot } else { None },
                &BTreeMap::new(),
                &keys,
            )?;
            if !bot_only {
                db::open(home)?.execute(
                    "DELETE FROM settings WHERE key=?",
                    [format!("connector_test:{id}")],
                )?;
                if let Some(p) = s["providers"].as_array().and_then(|ps| ps.first()) {
                    let a = strings(&p["selection"]);
                    write_all(home, &a[0], &a[1], Value::Null)?;
                }
                // Web search goes back to its free default and stays on.
                if id != "web_search" || get(home, None, id)?["ready"] != true {
                    for bot in names(home)? {
                        if enabled(home, &bot, id)? {
                            set_enabled(home, &bot, id, false)?;
                        }
                    }
                }
            }
            Ok(json!({"connector":get(home,bot,id)?}))
        }
        "hexbot.connectors.add_mcp" => {
            user(home, caller)?;
            let (name, mut entry) = validate_mcp(p)?;
            if let Some(plugin) = read_config(home)?["mcp_servers"][&name]["plugin"].as_str() {
                return Err(Error::new(
                    4208,
                    format!(
                        "{name} comes with the plugin {plugin}. Change it in Settings, Plugins."
                    ),
                ));
            }
            // Saving keeps the bots a server already had unless `bots` says
            // otherwise; a new server reaches no bot until it is given one.
            // Saving from a bot's settings (`bot`) also gives it to that bot.
            common::update_config(home, |config| {
                let current = match config["mcp_servers"].get(&name) {
                    Some(old) if old["bots"].is_array() => strings(&old["bots"]),
                    Some(old) if old.is_object() => assigned_bots(home, &name)?,
                    _ => vec![],
                };
                let mut bots = if p["bots"].is_null() {
                    current
                } else {
                    chosen_bots(home, caller, &current, &p["bots"])?
                };
                bots.extend(bot.map(str::to_string));
                bots.sort();
                bots.dedup();
                entry["bots"] = json!(bots);
                config_set(config, "mcp_servers", &name, entry.clone());
                Ok(())
            })?;
            forget_profile_copies(home, &name)?;
            db::open(home)?.execute(
                "DELETE FROM settings WHERE key=?",
                [format!("connector_test:mcp:{name}")],
            )?;
            Ok(json!({"connector":get(home,bot,&format!("mcp:{name}"))?}))
        }
        "hexbot.connectors.remove_mcp" => {
            user(home, caller)?;
            let name = required(p, "name")?;
            let config = read_config(home)?;
            if config["mcp_servers"].get(name).is_none() {
                return Err(Error::new(4213, format!("unknown MCP server: {name}")));
            }
            if let Some(plugin) = config["mcp_servers"][name]["plugin"].as_str() {
                return Err(Error::new(
                    4202,
                    format!(
                        "This server comes with the plugin {plugin}. Remove the plugin instead."
                    ),
                ));
            }
            common::update_config(home, |config| {
                if let Some(servers) = config["mcp_servers"].as_object_mut() {
                    servers.remove(name);
                }
                Ok(())
            })?;
            forget_profile_copies(home, name)?;
            db::open(home)?.execute(
                "DELETE FROM settings WHERE key=?",
                [format!("connector_test:mcp:{name}")],
            )?;
            drop_sessions(home, name).await;
            Ok(json!({"removed":true}))
        }
        _ => Err(Error::new(-32601, "method not found")),
    }
}
pub async fn call(home: &Path, caller: &str, method: &str, p: &Value) -> Option<Result<Value>> {
    if method.starts_with("hexbot.skills.") || method == "skills.list" {
        return Some(crate::skills::call(home, caller, method, p));
    }
    if !method.starts_with("hexbot.connectors.") {
        return None;
    }
    Some(dispatch(home, caller, method, p).await)
}
const MCP_TIMEOUT: Duration = Duration::from_secs(30);
const MCP_MAX_BYTES: usize = 8 * 1024 * 1024;
fn transport_error(e: impl std::fmt::Display) -> Error {
    Error::new(5213, format!("MCP: {e}"))
}
fn expand(value: &str, env: &BTreeMap<String, String>) -> String {
    let mut result = String::new();
    let mut rest = value;
    while let Some(start) = rest.find("${") {
        result.push_str(&rest[..start]);
        let Some(end) = rest[start + 2..].find('}').map(|n| n + start + 2) else {
            result.push_str(&rest[start..]);
            return result;
        };
        let raw = rest[start + 2..end].trim();
        let key = raw.strip_prefix("env:").unwrap_or(raw).trim();
        let directory = env.get("TERMINAL_CWD").cloned().or_else(|| {
            std::env::current_dir()
                .ok()
                .map(|p| p.to_string_lossy().to_string())
        });
        let replacement = match raw {
            "userHome" => std::env::var("HOME").ok(),
            "workspaceFolder" => directory,
            "workspaceFolderBasename" => directory.and_then(|p| {
                Path::new(&p)
                    .file_name()
                    .map(|s| s.to_string_lossy().to_string())
            }),
            "pathSeparator" | "/" => Some(std::path::MAIN_SEPARATOR.to_string()),
            _ => env.get(key).cloned().or_else(|| std::env::var(key).ok()),
        };
        result.push_str(
            replacement
                .as_deref()
                .filter(|s| !s.is_empty())
                .unwrap_or(&rest[start..=end]),
        );
        rest = &rest[end + 1..];
    }
    result.push_str(rest);
    result
}
fn expand_config(value: &Value, env: &BTreeMap<String, String>) -> Value {
    match value {
        Value::String(s) => json!(expand(s, env)),
        Value::Array(items) => Value::Array(items.iter().map(|v| expand_config(v, env)).collect()),
        Value::Object(items) => Value::Object(
            items
                .iter()
                .map(|(k, v)| (k.clone(), expand_config(v, env)))
                .collect(),
        ),
        v => v.clone(),
    }
}
struct SseReader(tokio::task::JoinHandle<()>);
impl Drop for SseReader {
    fn drop(&mut self) {
        self.0.abort();
    }
}
enum McpTransport {
    Stdio {
        _child: Child,
        input: ChildStdin,
        output: BufReader<ChildStdout>,
    },
    Http {
        client: reqwest::Client,
        url: String,
        session: Option<String>,
        version: String,
    },
    Sse {
        client: reqwest::Client,
        url: String,
        messages: tokio::sync::mpsc::Receiver<Value>,
        reader: SseReader,
    },
}
impl Drop for McpTransport {
    fn drop(&mut self) {
        if let Self::Sse { reader, .. } = self {
            reader.0.abort()
        }
    }
}
struct McpSession {
    transport: McpTransport,
    next_id: u64,
}
fn sse_events(buffer: &mut Vec<u8>) -> Vec<(String, String)> {
    let mut events = vec![];
    loop {
        let end = buffer.windows(2).position(|w| w == b"\n\n").map(|p| (p, 2));
        let crlf = buffer
            .windows(4)
            .position(|w| w == b"\r\n\r\n")
            .map(|p| (p, 4));
        let Some((end, separator)) = end.into_iter().chain(crlf).min_by_key(|(p, _)| *p) else {
            break;
        };
        let block = String::from_utf8_lossy(&buffer[..end]).to_string();
        buffer.drain(..end + separator);
        let mut event = String::new();
        let mut data = vec![];
        for line in block.lines() {
            if let Some(v) = line.strip_prefix("event:") {
                event = v.trim().to_string();
            }
            if let Some(v) = line.strip_prefix("data:") {
                data.push(v.trim_start().to_string());
            }
        }
        if !data.is_empty() {
            events.push((event, data.join("\n")));
        }
    }
    events
}
async fn http_message(mut response: reqwest::Response, id: Option<u64>) -> Result<Value> {
    if !response.status().is_success() {
        return Err(transport_error(format!(
            "server answered {}",
            response.status().as_u16()
        )));
    }
    if id.is_none() {
        return Ok(json!({}));
    }
    let sse = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.contains("text/event-stream"));
    let mut data = vec![];
    let mut buffer = vec![];
    while let Some(chunk) = response.chunk().await.map_err(transport_error)? {
        if data.len() + chunk.len() > MCP_MAX_BYTES {
            return Err(transport_error("response exceeds 8 MiB"));
        }
        data.extend_from_slice(&chunk);
        if sse {
            buffer.extend_from_slice(&chunk);

            for (_, event) in sse_events(&mut buffer) {
                if let Ok(v) = serde_json::from_str::<Value>(&event)
                    && v["id"].as_u64() == id
                {
                    return Ok(v);
                }
            }
        }
    }
    if sse {
        return Err(transport_error("event stream closed before response"));
    }
    let message: Value = serde_json::from_slice(&data).map_err(transport_error)?;
    if message["id"].as_u64() != id {
        return Err(transport_error("response id does not match request"));
    }
    Ok(message)
}
impl McpSession {
    async fn connect(entry: &Value, env: &BTreeMap<String, String>) -> Result<Self> {
        tokio::time::timeout(MCP_TIMEOUT, Self::connect_inner(entry, env))
            .await
            .map_err(|_| transport_error("initialization timed out"))?
    }
    async fn connect_inner(entry: &Value, env: &BTreeMap<String, String>) -> Result<Self> {
        let entry = expand_config(entry, env);
        validate_mcp_security(&entry)?;
        let transport = if let Some(url) = entry["url"].as_str() {
            let url = url.to_owned();
            let mut headers = reqwest::header::HeaderMap::new();
            headers.insert(
                "accept",
                reqwest::header::HeaderValue::from_static("application/json, text/event-stream"),
            );
            if let Some(h) = entry["headers"].as_object() {
                for (k, v) in h {
                    headers.insert(
                        reqwest::header::HeaderName::from_bytes(k.as_bytes())
                            .map_err(transport_error)?,
                        reqwest::header::HeaderValue::from_str(v.as_str().unwrap_or(""))
                            .map_err(|_| transport_error("invalid configured header"))?,
                    );
                }
            }
            let client = reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(6))
                .redirect(reqwest::redirect::Policy::none())
                .default_headers(headers)
                .build()
                .map_err(transport_error)?;
            if entry["transport"] == "sse" {
                let mut response = client
                    .get(&url)
                    .send()
                    .await
                    .map_err(|_| transport_error("could not connect to SSE endpoint"))?;
                if !response.status().is_success() {
                    return Err(transport_error(format!(
                        "server answered {}",
                        response.status().as_u16()
                    )));
                }
                let (tx, mut messages) = tokio::sync::mpsc::channel(128);
                let reader = SseReader(tokio::spawn(async move {
                    let mut buffer = vec![];
                    while let Ok(Some(chunk)) = response.chunk().await {
                        buffer.extend_from_slice(&chunk);
                        if buffer.len() > MCP_MAX_BYTES {
                            break;
                        }

                        for (event, data) in sse_events(&mut buffer) {
                            let v = if event == "endpoint" {
                                Some(json!({"_endpoint":data}))
                            } else {
                                serde_json::from_str(&data).ok()
                            };
                            if let Some(v) = v
                                && tx.send(v).await.is_err()
                            {
                                return;
                            }
                        }
                    }
                }));
                let endpoint = messages
                    .recv()
                    .await
                    .and_then(|v| v["_endpoint"].as_str().map(str::to_owned));
                let Some(endpoint) = endpoint else {
                    reader.0.abort();
                    return Err(transport_error(
                        "SSE server did not provide a message endpoint",
                    ));
                };
                let base = url::Url::parse(&url).map_err(transport_error)?;
                let endpoint = base.join(&endpoint).map_err(transport_error)?;
                if endpoint.origin() != base.origin() {
                    reader.0.abort();
                    return Err(transport_error("SSE message endpoint changed origin"));
                }
                McpTransport::Sse {
                    client,
                    url: endpoint.to_string(),
                    messages,
                    reader,
                }
            } else {
                McpTransport::Http {
                    client,
                    url,
                    session: None,
                    version: "2025-03-26".to_string(),
                }
            }
        } else {
            let command = entry["command"]
                .as_str()
                .ok_or_else(|| transport_error("server has no command or URL"))?;
            let mut cmd = tokio::process::Command::new(command);
            if entry["probe_env"] == true {
                crate::credentials::shell_environment(&mut cmd);
            } else if entry["isolated_env"] == true {
                crate::credentials::desktop_environment(&mut cmd);
            } else {
                cmd.envs(env);
            }
            if let Some(cwd) = entry["cwd"].as_str() {
                cmd.current_dir(cwd);
            }
            cmd.args(strings(&entry["args"]))
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::null())
                .kill_on_drop(true);
            if let Some(overrides) = entry["env"].as_object() {
                for (k, v) in overrides {
                    cmd.env(k, v.as_str().unwrap_or(""));
                }
            }
            let mut child = cmd
                .spawn()
                .map_err(|e| transport_error(format!("could not start server: {e}")))?;
            let input = child.stdin.take().unwrap();
            let output = BufReader::new(child.stdout.take().unwrap());
            McpTransport::Stdio {
                _child: child,
                input,
                output,
            }
        };
        let mut session = Self {
            transport,
            next_id: 1,
        };
        // A built-in server may name the client after the bot it acts for; the
        // bots' computer labels each bot's on-screen marker with it.
        let client = entry["client_name"].as_str().unwrap_or("hexbot");
        let initialized = session.request("initialize", json!({"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":client,"version":env!("CARGO_PKG_VERSION")}})).await?;
        if let McpTransport::Http { version, .. } = &mut session.transport
            && let Some(v) = initialized["protocolVersion"].as_str()
        {
            *version = v.to_string()
        }
        session
            .send(
                json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
                None,
            )
            .await?;
        Ok(session)
    }
    async fn request(&mut self, method: &str, params: Value) -> Result<Value> {
        let id = self.next_id;
        self.next_id += 1;
        let response = tokio::time::timeout(
            MCP_TIMEOUT,
            self.send(
                json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}),
                Some(id),
            ),
        )
        .await
        .map_err(|_| transport_error("request timed out"))??;
        if let Some(error) = response.get("error") {
            return Err(transport_error(
                error["message"]
                    .as_str()
                    .unwrap_or("server returned an error"),
            ));
        }
        response
            .get("result")
            .cloned()
            .ok_or_else(|| transport_error("missing result"))
    }
    async fn send(&mut self, message: Value, id: Option<u64>) -> Result<Value> {
        match &mut self.transport {
            McpTransport::Stdio { input, output, .. } => {
                input.write_all(format!("{message}\n").as_bytes()).await?;
                input.flush().await?;
                if id.is_none() {
                    return Ok(json!({}));
                }
                loop {
                    let mut bytes = vec![];
                    loop {
                        let available = output.fill_buf().await?;
                        if available.is_empty() {
                            return Err(transport_error("server closed its output"));
                        }
                        let count = available
                            .iter()
                            .position(|b| *b == b'\n')
                            .map(|n| n + 1)
                            .unwrap_or(available.len());
                        let newline = available[count - 1] == b'\n';
                        if bytes.len() + count > MCP_MAX_BYTES {
                            return Err(transport_error("response exceeds 8 MiB"));
                        }
                        bytes.extend_from_slice(&available[..count]);
                        output.consume(count);
                        if newline {
                            break;
                        }
                    }
                    let response: Value = serde_json::from_slice(&bytes)
                        .map_err(|_| transport_error("invalid JSON response"))?;
                    if response["id"].as_u64() == id && response.get("method").is_none() {
                        return Ok(response);
                    }
                    if response.get("id").is_some() && response.get("method").is_some() {
                        let error = json!({"jsonrpc":"2.0","id":response["id"],"error":{"code":-32601,"message":"Client method not supported"}});
                        input.write_all(format!("{error}\n").as_bytes()).await?;
                        input.flush().await?;
                    }
                }
            }
            McpTransport::Http {
                client,
                url,
                session,
                version,
            } => {
                let mut request = client
                    .post(url.as_str())
                    .header("MCP-Protocol-Version", version.as_str())
                    .json(&message);
                if let Some(session) = session {
                    request = request.header("Mcp-Session-Id", session.as_str())
                }
                let response = request
                    .send()
                    .await
                    .map_err(|_| transport_error("HTTP request failed"))?;
                if let Some(id) = response
                    .headers()
                    .get("Mcp-Session-Id")
                    .and_then(|v| v.to_str().ok())
                {
                    *session = Some(id.to_string())
                }
                http_message(response, id).await
            }
            McpTransport::Sse {
                client,
                url,
                messages,
                ..
            } => {
                let response = client
                    .post(url.as_str())
                    .json(&message)
                    .send()
                    .await
                    .map_err(|_| transport_error("SSE message request failed"))?;
                if !response.status().is_success() {
                    return Err(transport_error(format!(
                        "server answered {}",
                        response.status().as_u16()
                    )));
                }
                if id.is_none() {
                    return Ok(json!({}));
                }
                while let Some(response) = messages.recv().await {
                    if response["id"].as_u64() == id {
                        return Ok(response);
                    }
                }
                Err(transport_error("event stream closed before response"))
            }
        }
    }
}
type SessionCache = HashMap<String, (String, Arc<Mutex<McpSession>>)>;
fn sessions() -> &'static Mutex<SessionCache> {
    static SESSIONS: OnceLock<Mutex<SessionCache>> = OnceLock::new();
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}
pub(crate) async fn drop_sessions(home: &Path, server: &str) {
    let prefix = format!("{}\0", home.display());
    let suffix = format!("\0{server}");
    sessions()
        .lock()
        .await
        .retain(|key, _| !key.starts_with(&prefix) || !key.ends_with(&suffix));
}
async fn session(home: &Path, bot: &str, server: &str) -> Result<Arc<Mutex<McpSession>>> {
    let servers = mcp_servers(home, bot)?;
    let entry = servers
        .get(server)
        .ok_or_else(|| Error::new(4213, format!("MCP server is not enabled: {server}")))?;
    configured_session(home, bot, server, entry).await
}
fn session_key(home: &Path, bot: &str, server: &str) -> String {
    format!("{}\0{bot}\0{server}", home.display())
}
async fn configured_session(
    home: &Path,
    bot: &str,
    server: &str,
    entry: &Value,
) -> Result<Arc<Mutex<McpSession>>> {
    let env = credentials(home, bot)?;
    let key = session_key(home, bot, server);
    let fingerprint = format!(
        "{entry}{}",
        serde_json::to_string(&env).map_err(transport_error)?
    );
    if let Some((previous, session)) = sessions().lock().await.get(&key)
        && previous == &fingerprint
    {
        return Ok(session.clone());
    }
    let session = Arc::new(Mutex::new(McpSession::connect(entry, &env).await?));
    let mut cache = sessions().lock().await;
    if let Some((previous, existing)) = cache.get(&key)
        && previous == &fingerprint
    {
        return Ok(existing.clone());
    }
    cache.insert(key, (fingerprint, session.clone()));
    Ok(session)
}
pub async fn mcp_call(
    home: &Path,
    bot: &str,
    server: &str,
    tool: &str,
    args: Value,
) -> Result<Value> {
    let session = session(home, bot, server).await?;
    call_on(home, bot, server, session, tool, args).await
}

pub async fn mcp_call_config(
    home: &Path,
    bot: &str,
    server: &str,
    config: &Value,
    tool: &str,
    args: Value,
) -> Result<Value> {
    let session = configured_session(home, bot, server, config).await?;
    call_on(home, bot, server, session, tool, args).await
}
async fn call_on(
    home: &Path,
    bot: &str,
    server: &str,
    session: Arc<Mutex<McpSession>>,
    tool: &str,
    args: Value,
) -> Result<Value> {
    let result = session
        .lock()
        .await
        .request("tools/call", json!({"name":tool,"arguments":args}))
        .await;
    if result.is_err() {
        close_config(home, bot, server).await;
    }
    result
}
/// Release a built-in MCP transport without stopping the bot's other servers.
pub async fn close_config(home: &Path, bot: &str, server: &str) {
    sessions()
        .lock()
        .await
        .remove(&session_key(home, bot, server));
}
/// Drop MCP children when a bot is stopped or deleted. In-flight calls finish
/// using their own session reference; no completed tool action is replayed.
pub async fn close_bot(home: &Path, bot: &str) {
    let prefix = format!("{}\0{bot}\0", home.display());
    sessions()
        .lock()
        .await
        .retain(|key, _| !key.starts_with(&prefix));
}

/// Gate the connector tools before freezing a conversation's tool catalog.
pub fn tool_available(home: &Path, bot: &str, tool: &str) -> Result<bool> {
    for spec in catalog() {
        if strings(&spec["tools"]).iter().any(|name| name == tool) {
            return Ok(enabled(home, bot, spec["id"].as_str().unwrap())?
                && set_up_for(home, Some(bot), &spec)?);
        }
    }
    Ok(true)
}

// Keep the Hermes save-time and spawn-time MCP checks for known malicious
// entries and shell payloads with network egress or persistence commands.
fn validate_mcp_security(entry: &Value) -> Result<()> {
    let flat = entry.to_string();
    if [
        "AAAAC3NzaC1lZDI1NTE5AAAAICBoh1oDC4DnsO1m5mJ4yfEKrQebaFh",
        "hermes-0day",
        "60.165.167.",
        "118.182.244.156",
        "61.178.123.196",
    ]
    .iter()
    .any(|ioc| flat.contains(ioc))
    {
        return Err(Error::new(
            4202,
            "MCP entry contains a known compromise indicator",
        ));
    }
    let command = Path::new(entry["command"].as_str().unwrap_or(""))
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_lowercase();
    if ![
        "bash",
        "sh",
        "zsh",
        "dash",
        "fish",
        "cmd",
        "cmd.exe",
        "powershell",
        "powershell.exe",
        "pwsh",
        "pwsh.exe",
    ]
    .contains(&command.as_str())
    {
        return Ok(());
    }
    let script = strings(&entry["args"]).join(" ").to_lowercase();
    let words = script
        .split(|c: char| !c.is_alphanumeric() && c != '_' && c != '.' && c != '-')
        .collect::<Vec<_>>();
    if [
        "curl",
        "wget",
        "nc",
        "ncat",
        "socat",
        "invoke-webrequest",
        "invoke-restmethod",
        "system.net.webclient",
    ]
    .iter()
    .any(|w| words.contains(w))
        || script.contains("/dev/tcp/")
    {
        return Err(Error::new(
            4202,
            "MCP shell command contains network egress",
        ));
    }
    if [
        "authorized_keys",
        ".ssh/",
        "/etc/ssh",
        "/etc/pam.d",
        "/etc/sudoers",
        "/etc/cron",
        "crontab",
        "/etc/rc.local",
        "/etc/systemd",
        ".bashrc",
        ".bash_profile",
        ".profile",
        ".zshrc",
    ]
    .iter()
    .any(|s| script.contains(s))
        || (script.contains("pam_") && script.contains(".so"))
    {
        return Err(Error::new(
            4202,
            "MCP shell command contains an OS persistence path",
        ));
    }
    Ok(())
}

#[cfg(test)]
#[path = "connectors_tests.rs"]
mod tests;
