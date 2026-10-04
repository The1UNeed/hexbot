//! Connector credentials, per-bot selection, skill discovery and MCP transport.
use crate::{Error, Result, common::*, db};
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
fn catalog() -> Vec<Value> {
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
fn names(home: &Path) -> Result<Vec<String>> {
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
fn targets(home: &Path) -> Result<Vec<PathBuf>> {
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
    let mut values = read_env(home)?;
    for (k, v) in read_env(&profile(home, bot)?)? {
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
        let mut config = read_config(&path)?;
        config_set(&mut config, section, key, value.clone());
        write_config(&path, &config)?;
    }
    Ok(())
}
fn selected(home: &Path, spec: &Value) -> Result<Option<Value>> {
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
    for p in providers {
        if has_keys(home, None, &strings(&p["keys"]))? {
            return Ok(Some(p));
        }
    }
    Ok(None)
}
fn has_keys(home: &Path, bot: Option<&str>, keys: &[String]) -> Result<bool> {
    for k in keys {
        if value(home, bot, k)?.is_none() {
            return Ok(false);
        }
    }
    Ok(!keys.is_empty())
}
fn required_keys(home: &Path, spec: &Value) -> Result<Vec<String>> {
    Ok(strings(
        &selected(home, spec)?.unwrap_or_else(|| spec.clone())["keys"],
    ))
}
pub fn toolsets(home: &Path, bot: &str) -> Result<Vec<String>> {
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
    .map(str::to_string)
    .to_vec())
}
pub fn mcp_servers(home: &Path, bot: &str) -> Result<Value> {
    let root = read_config(home)?;
    let config = read_config(&profile(home, bot)?)?;
    let mut servers = root["mcp_servers"].as_object().cloned().unwrap_or_default();
    if let Some(overrides) = config["mcp_servers"].as_object() {
        servers.extend(overrides.clone())
    }
    servers.retain(|_, entry| entry.is_object() && entry["disabled"] != true);
    Ok(Value::Object(servers))
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
            result.push(json!({"name":name,"error":format!("Connected tool {name} has an invalid configuration. Ask an admin to check it.")}));
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

fn skill_files(root: &Path) -> Result<Vec<PathBuf>> {
    let mut files = vec![];
    if !root.exists() {
        return Ok(files);
    }
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        if ty.is_dir() {
            files.extend(skill_files(&entry.path())?)
        } else if ty.is_file() && entry.file_name() == "SKILL.md" {
            files.push(entry.path())
        }
    }
    files.sort();
    Ok(files)
}
fn list_skills(home: &Path, bot: &str) -> Result<Value> {
    let path = profile(home, bot)?;
    let config = read_config(&path)?;
    let disabled = strings(&config["skills"]["disabled"])
        .into_iter()
        .map(|s| s.to_lowercase())
        .collect::<BTreeSet<_>>();
    let root = path.join("skills");
    let mut seen = BTreeSet::new();
    let mut result = vec![];
    for file in skill_files(&root)? {
        let parent = file.parent().unwrap();
        let name = parent.file_name().unwrap().to_string_lossy().to_string();
        if !seen.insert(name.clone()) {
            continue;
        }
        let text = fs::read_to_string(&file)?;
        let meta = text
            .strip_prefix("---")
            .and_then(|s| s.split_once("\n---"))
            .and_then(|(s, _)| serde_yaml::from_str::<Value>(s).ok())
            .unwrap_or(Value::Null);
        let category = if parent.parent() == Some(root.as_path()) {
            String::new()
        } else {
            parent
                .parent()
                .and_then(Path::file_name)
                .unwrap_or_default()
                .to_string_lossy()
                .to_string()
        };
        result.push(json!({"name":name,"description":meta["description"].as_str().unwrap_or(""),"category":category,"enabled":!disabled.contains(&name.to_lowercase())}));
    }
    result.sort_by_key(|s| {
        (
            s["category"].as_str().unwrap_or("").to_string(),
            s["name"].as_str().unwrap_or("").to_string(),
        )
    });
    Ok(json!({"skills":result}))
}
fn enabled(home: &Path, bot: &str, id: &str) -> Result<bool> {
    if let Some(server) = id.strip_prefix("mcp:") {
        return Ok(mcp_servers(home, bot)?.get(server).is_some());
    }
    let s = spec(id)?;
    if let Some(skill) = s["skill"].as_str() {
        return Ok(list_skills(home, bot)?["skills"]
            .as_array()
            .unwrap()
            .iter()
            .any(|s| s["name"] == skill && s["enabled"] == true));
    }
    let tools = toolsets(home, bot)?;
    if id == "web_search" {
        return Ok(tools.iter().any(|t| t == "web" || t == "search"));
    }
    if id == "cloud_browser" && selected(home, &s)?.is_none() {
        return Ok(false);
    }
    Ok(strings(&s["toolsets"]).iter().all(|t| tools.contains(t)))
}
fn copy_dir(from: &Path, to: &Path) -> Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let e = entry?;
        if e.file_type()?.is_dir() {
            copy_dir(&e.path(), &to.join(e.file_name()))?
        } else if e.file_type()?.is_file() {
            atomic_write(&to.join(e.file_name()), &fs::read(e.path())?)?
        }
    }
    Ok(())
}
fn set_enabled(home: &Path, bot: &str, id: &str, on: bool) -> Result<()> {
    let path = profile(home, bot)?;
    let mut config = read_config(&path)?;
    if let Some(server) = id.strip_prefix("mcp:") {
        let root = read_config(home)?;
        let entry = root["mcp_servers"]
            .get(server)
            .filter(|v| v.is_object())
            .ok_or_else(|| Error::new(4213, format!("unknown MCP server: {server}")))?;
        let mut entry = entry.clone();
        entry["disabled"] = json!(!on);
        config_set(&mut config, "mcp_servers", server, entry);
    } else {
        let s = spec(id)?;
        if let Some(skill) = s["skill"].as_str() {
            if on
                && !skill_files(&path.join("skills"))?.iter().any(|f| {
                    f.parent()
                        .and_then(Path::file_name)
                        .is_some_and(|n| n == skill)
                })
            {
                let roots = [
                    home.join("skills"),
                    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../skills"),
                ];
                let source = roots
                    .iter()
                    .flat_map(|r| skill_files(r).unwrap_or_default())
                    .find(|f| {
                        f.parent()
                            .and_then(Path::file_name)
                            .is_some_and(|n| n == skill)
                    })
                    .ok_or_else(|| Error::new(4212, format!("bundled skill not found: {skill}")))?;
                let source = source.parent().unwrap();
                copy_dir(
                    source,
                    &path
                        .join("skills")
                        .join(
                            source
                                .parent()
                                .and_then(Path::file_name)
                                .unwrap_or_default(),
                        )
                        .join(skill),
                )?;
            }
            let mut disabled = strings(&config["skills"]["disabled"])
                .into_iter()
                .collect::<BTreeSet<_>>();
            if on {
                disabled.retain(|s| !s.eq_ignore_ascii_case(skill))
            } else {
                disabled.insert(skill.to_string());
            }
            config_set(&mut config, "skills", "disabled", json!(disabled));
        } else if id == "cloud_browser" {
            if !on {
                write_all(home, "browser", "cloud_provider", Value::Null)?;
            }
            return Ok(());
        } else {
            let mut tools = toolsets(home, bot)?.into_iter().collect::<BTreeSet<_>>();
            for t in strings(&s["toolsets"]) {
                if on {
                    tools.insert(t);
                } else {
                    tools.remove(&t);
                    if t == "web" {
                        tools.remove("search");
                    }
                }
            }
            config_set(&mut config, "tools", "enabled_toolsets", json!(tools));
            config_set(&mut config, "platform_toolsets", "cli", json!(tools));
            config_set(
                &mut config,
                "known_plugin_toolsets",
                "cli",
                json!(["hexbot"]),
            );
        }
    }
    write_config(&path, &config)
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
fn list(home: &Path, bot: Option<&str>) -> Result<Value> {
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
        let provider = selected(home, &s)?;
        let ready = has_keys(home, bot, &required_keys(home, &s)?)?;
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
                result.push(json!({"id":p["id"],"label":p["label"],"configured":has_keys(home,None,&strings(&p["keys"]))?}));
            }
            json!(result)
        } else {
            Value::Null
        };
        let mut bots = vec![];
        for n in &names {
            if enabled(home, n, id)? {
                bots.push(n.clone())
            }
        }
        out.push(json!({
            "id": id,
            "name": s["name"],
            "description": s["description"],
            "group": s["group"],
            "icon": s["icon"],
            "scope": "daemon",
            "state": state,
            "state_text": state_text,
            "providers": providers,
            "provider": provider.map(|p| p["id"].clone()),
            "fields": fields,
            "enabled_for_bot": bot.map(|b| bots.iter().any(|n| n == b)),
            "enabled_bots": bots,
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
            let mut bots = vec![];
            for n in &names {
                if enabled(home, n, &id)? {
                    bots.push(n.clone())
                }
            }
            let disabled = entry["disabled"] == true;
            let tested = last_test(home, &id)?;
            let failed = tested.as_ref().is_some_and(|v| v["ok"] == false);
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
                "state": if err.is_some() || failed {
                    "error"
                } else if disabled {
                    "not_set_up"
                } else {
                    "ready"
                },
                "state_text": err
                    .map(|e| {
                        e["text"]
                            .as_str()
                            .unwrap_or("")
                            .chars()
                            .take(80)
                            .collect::<String>()
                    })
                    .unwrap_or_else(|| if disabled { "Disabled" } else if failed { "Test failed" } else { "Running" }.to_string()),
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
fn get(home: &Path, bot: Option<&str>, id: &str) -> Result<Value> {
    list(home, bot)?["connectors"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["id"] == id)
        .cloned()
        .ok_or_else(|| Error::new(4213, format!("unknown connector: {id}")))
}
async fn probe(home: &Path, id: &str, bot: Option<&str>) -> Result<Value> {
    if let Some(server) = id.strip_prefix("mcp:") {
        let config = if let Some(bot) = bot {
            mcp_servers(home, bot)?
        } else {
            read_config(home)?["mcp_servers"].clone()
        };
        let Some(entry) = config.get(server) else {
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
            Err(e) => json!({"ok":false,"message":e.message}),
        };
        save_test(home, id, &result, true)?;
        return Ok(result);
    }
    let s = spec(id)?;
    let keys = required_keys(home, &s)?;
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
        "airtable" => (
            "Airtable",
            "https://api.airtable.com/v0/meta/whoami".to_string(),
            Some((
                "authorization",
                format!("Bearer {}", key("AIRTABLE_API_KEY")?),
            )),
        ),
        "home_assistant" => (
            "Home Assistant",
            format!("{}/api/", key("HASS_URL")?.trim_end_matches('/')),
            Some(("authorization", format!("Bearer {}", key("HASS_TOKEN")?))),
        ),
        "x_search" => (
            "xAI",
            "https://api.x.ai/v1/models".to_string(),
            Some(("authorization", format!("Bearer {}", key("XAI_API_KEY")?))),
        ),
        "premium_voice" if selected(home, &s)?.is_some_and(|p| p["id"] == "elevenlabs") => (
            "ElevenLabs",
            "https://api.elevenlabs.io/v1/user".to_string(),
            Some(("xi-api-key", key("ELEVENLABS_API_KEY")?)),
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
fn validate_mcp(p: &Value) -> Result<(String, Value)> {
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
        "skills.list" | "hexbot.skills.list" => list_skills(home, required(p, "bot")?),
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
            admin(home, caller)?;
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
                    ps.iter()
                        .find(|p| strings(&p["keys"]).iter().all(|k| values.contains_key(k)))
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
            admin(home, caller)?;
            let s = spec(required(p, "id")?)?;
            if bot_only && bot.is_none() {
                return Err(Error::new(4200, "bot_only needs a bot"));
            }
            let mut shared = BTreeSet::new();
            for other in catalog() {
                if other["id"] != id {
                    for key in required_keys(home, &other)? {
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
                for bot in names(home)? {
                    if enabled(home, &bot, id)? {
                        set_enabled(home, &bot, id, false)?;
                    }
                }
            }
            Ok(json!({"connector":get(home,bot,id)?}))
        }
        "hexbot.connectors.add_mcp" => {
            admin(home, caller)?;
            let (name, entry) = validate_mcp(p)?;
            write_all(home, "mcp_servers", &name, entry)?;
            db::open(home)?.execute(
                "DELETE FROM settings WHERE key=?",
                [format!("connector_test:mcp:{name}")],
            )?;
            Ok(json!({"connector":get(home,None,&format!("mcp:{name}"))?}))
        }
        "hexbot.connectors.remove_mcp" => {
            admin(home, caller)?;
            let name = required(p, "name")?;
            if read_config(home)?["mcp_servers"].get(name).is_none() {
                return Err(Error::new(4213, format!("unknown MCP server: {name}")));
            }
            write_all(home, "mcp_servers", name, Value::Null)?;
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
    if !method.starts_with("hexbot.connectors.")
        && !matches!(method, "hexbot.skills.list" | "skills.list")
    {
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
        let initialized = session.request("initialize", json!({"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"hexbot","version":env!("CARGO_PKG_VERSION")}})).await?;
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
async fn drop_sessions(home: &Path, server: &str) {
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
    if tool == "x_search" {
        return Ok(enabled(home, bot, "x_search")? && crate::providers::xai_configured(home, bot)?);
    }
    for spec in catalog() {
        if strings(&spec["tools"]).iter().any(|name| name == tool) {
            return Ok(enabled(home, bot, spec["id"].as_str().unwrap())?
                && has_keys(home, Some(bot), &required_keys(home, &spec)?)?);
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
