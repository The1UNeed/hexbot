//! Deployment settings, profile mirroring, attributed usage, and bot incidents.
use crate::{Error, Result, common, db};
use rusqlite::{Connection, OpenFlags, OptionalExtension, params, params_from_iter};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::Path,
};

pub const PLATFORM_HINT: &str = "You are chatting in Hexbot, a desktop app. Markdown renders with GitHub flavor: headings, lists, tables and fenced code. To hand over a file, give its absolute path or URL; the user opens it themselves. Scheduled jobs run on their own and their output is not delivered back into this conversation.";

pub fn defaults() -> Value {
    json!({
        "approval_mode": "manual",
        "auto_approver_model": null,
        "lan_enabled": false,
        "service_installed": false,
        "workspace_dir": "~/Hexbot",
        "billing_notice_ack": false,
        "room_bot_turns_per_human_turn": 8,
        "room_budget_tokens_per_human_turn": null,
        "bot_daily_token_budget": null,
        "dream_time": "03:00",
        "dream_enabled": true,
        "default_model": null,
        "fallback_model": null
    })
}

pub fn get(home: &Path) -> Result<Value> {
    let mut result = defaults();
    for row in common::rows(&db::open(home)?, "SELECT key,value FROM settings", &[])? {
        if let Some(key) = row["key"].as_str().filter(|k| result.get(k).is_some())
            && let Ok(value) = serde_json::from_str::<Value>(row["value"].as_str().unwrap_or(""))
        {
            result[key] = value;
        }
    }
    Ok(result)
}

fn validate(patch: &Value) -> Result<()> {
    let patch = patch
        .as_object()
        .ok_or_else(|| Error::new(4201, "patch must be an object"))?;
    for (key, value) in patch {
        if defaults().get(key).is_none() {
            return Err(Error::new(4201, format!("unknown setting: {key}")));
        }
        let valid = match key.as_str() {
            "approval_mode" => matches!(value.as_str(), Some("manual" | "smart" | "off")),
            "auto_approver_model" | "default_model" | "fallback_model" => {
                value.is_null() || value.as_str().is_some_and(|s| s.contains('/'))
            }
            "dream_enabled" | "lan_enabled" | "service_installed" | "billing_notice_ack" => {
                value.is_boolean()
            }
            "workspace_dir" => value
                .as_str()
                .is_some_and(|s| !s.is_empty() && !s.contains('\0')),
            "dream_time" => value.as_str().is_some_and(|s| {
                let b = s.as_bytes();
                b.len() == 5
                    && b[2] == b':'
                    && [b[0], b[1], b[3], b[4]].iter().all(u8::is_ascii_digit)
                    && &s[..2] <= "23"
                    && &s[3..] <= "59"
            }),
            "room_bot_turns_per_human_turn"
            | "room_budget_tokens_per_human_turn"
            | "bot_daily_token_budget" => value.is_null() || value.as_u64().is_some(),
            _ => true,
        };
        if !valid {
            return Err(Error::new(4202, format!("invalid value for {key}")));
        }
    }
    Ok(())
}

fn object(value: &mut Value) -> &mut serde_json::Map<String, Value> {
    if !value.is_object() {
        *value = json!({});
    }
    value.as_object_mut().unwrap()
}

fn managed_config(home: &Path, profile: &Path, settings: &Value) -> Result<Value> {
    let mut data = common::read_config(profile)?;
    object(&mut data);
    let name = profile.file_name().and_then(|s| s.to_str()).unwrap_or("");
    let overrides: Option<(Option<String>, Option<String>)> = db::open(home)?
        .query_row(
            "SELECT approval_mode,workdir FROM bots WHERE name=?",
            [name],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let (mode, workdir) = overrides.unwrap_or_default();
    let mode = mode.filter(|v| matches!(v.as_str(), "manual" | "smart" | "off"));
    object(&mut data["approvals"]).insert(
        "mode".into(),
        mode.map_or_else(|| settings["approval_mode"].clone(), Value::String),
    );
    let workdir = common::expand_home(common::configured_workdir(&[workdir.as_deref()], settings))?;
    // Inaccessible workspaces remain configured so terminal execution reports the actual failure.
    let _ = fs::create_dir_all(&workdir);
    object(&mut data["terminal"]).insert("cwd".into(), json!(workdir));
    for platform in ["tui", "hexbot_room"] {
        object(&mut data["platform_hints"])
            .insert(platform.into(), json!({"replace":PLATFORM_HINT}));
    }
    object(&mut data["memory"]).insert("user_profile_enabled".into(), json!(false));
    if let Some(choice) = settings["auto_approver_model"]
        .as_str()
        .filter(|s| !s.is_empty())
        && let Some((provider, model)) = choice.split_once('/')
    {
        object(&mut data["auxiliary"]);
        let approval = object(&mut data["auxiliary"]["approval"]);
        approval.insert("provider".into(), json!(provider));
        approval.insert("model".into(), json!(model));
    }
    if let Some(choice) = settings["fallback_model"]
        .as_str()
        .filter(|s| !s.is_empty())
        && let Some((provider, model)) = choice.split_once('/')
    {
        data["fallback_providers"] = json!([{"provider":provider,"model":model}]);
    } else {
        object(&mut data).remove("fallback_providers");
    }
    Ok(data)
}

pub fn mirror(home: &Path, profile: &Path) -> Result<()> {
    common::write_config(profile, &managed_config(home, profile, &get(home)?)?)
}

pub fn update(home: &Path, caller: &str, patch: &Value) -> Result<Value> {
    common::admin(home, caller)?;
    validate(patch)?;
    if let Some(dir) = patch["workspace_dir"].as_str() {
        common::check_workdir(home, dir)?;
    }
    let mut settings = get(home)?;
    for (key, value) in patch.as_object().unwrap() {
        settings[key] = value.clone();
    }
    let mut profiles = vec![home.to_path_buf()];
    if home.join("profiles").exists() {
        for entry in fs::read_dir(home.join("profiles"))? {
            let entry = entry?;
            if entry.file_type()?.is_dir() {
                profiles.push(entry.path());
            }
        }
    }
    profiles.sort();
    // Parse every profile before changing a setting or a file.
    let configs = profiles
        .iter()
        .map(|profile| managed_config(home, profile, &settings))
        .collect::<Result<Vec<_>>>()?;
    let mut conn = db::open(home)?;
    let tx = conn.transaction()?;
    for (key, value) in patch.as_object().unwrap() {
        tx.execute(
            "INSERT OR REPLACE INTO settings(key,value) VALUES (?,?)",
            params![key, value.to_string()],
        )?;
    }
    for (profile, config) in profiles.iter().zip(configs.iter()) {
        common::write_config(profile, config)?;
    }
    tx.commit()?;
    Ok(settings)
}

fn routes(home: &Path, user: &str) -> Result<BTreeMap<String, BTreeSet<String>>> {
    let conn = db::open(home)?;
    let mut result: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for row in common::rows(
        &conn,
        "SELECT bot,id AS session FROM sections WHERE owner_id=? UNION SELECT rs.bot,rs.stored_session_id AS session FROM room_sessions rs JOIN room_members rm ON rm.room_id=rs.room_id AND rm.member_kind='bot' AND rm.member_id=rs.bot WHERE rm.added_by=?",
        &[&user, &user],
    )? {
        if let (Some(bot), Some(session)) = (row["bot"].as_str(), row["session"].as_str()) {
            common::identifier(bot)?;
            result.entry(bot.into()).or_default().insert(session.into());
        }
    }
    Ok(result)
}

fn profile_usage(path: &Path, sessions: &BTreeSet<String>, since: f64) -> Result<(i64, i64, f64)> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let mut totals = (0, 0, 0.0);
    // Chunking avoids SQLite's bind-variable limit on long-lived deployments.
    let sessions = sessions.iter().collect::<Vec<_>>();
    for chunk in sessions.chunks(500) {
        let marks = vec!["?"; chunk.len()].join(",");
        let sql = format!(
            "SELECT COALESCE(SUM(input_tokens),0),COALESCE(SUM(output_tokens),0),COALESCE(SUM(estimated_cost_usd),0) FROM session_model_usage WHERE session_id IN ({marks}) AND last_seen>=?"
        );
        let mut args = chunk
            .iter()
            .map(|s| rusqlite::types::Value::Text((*s).to_string()))
            .collect::<Vec<_>>();
        args.push(rusqlite::types::Value::Real(since));
        let row: (i64, i64, f64) = conn.query_row(&sql, params_from_iter(args), |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })?;
        totals.0 += row.0;
        totals.1 += row.1;
        totals.2 += row.2;
    }
    Ok(totals)
}

pub fn summary(home: &Path, caller: &str, user: Option<&str>, since: f64) -> Result<Value> {
    common::user(home, caller)?;
    let user = user.filter(|s| !s.is_empty()).unwrap_or(caller);
    if user != caller {
        common::admin(home, caller)?;
    }
    if !since.is_finite() {
        return Err(Error::new(4202, "since must be a finite timestamp"));
    }
    let mut bots: BTreeMap<String, (i64, i64, f64)> = BTreeMap::new();
    for (bot, sessions) in routes(home, user)? {
        let path = home.join("profiles").join(&bot).join("state.db");
        let values = if path.exists() {
            profile_usage(&path, &sessions, since).unwrap_or_default()
        } else {
            (0, 0, 0.0)
        };
        bots.insert(bot, values);
    }
    if home.join("hexbot-runtime.db").exists() {
        let conn = crate::runtime_store::open(home)?;
        for row in common::rows(
            &conn,
            "SELECT bot,SUM(input_tokens+cache_read_tokens+cache_write_tokens) AS input_tokens,SUM(output_tokens) AS output_tokens,SUM(cost) AS cost FROM native_usage WHERE owner_id=? AND timestamp>=? GROUP BY bot",
            &[&user, &since],
        )? {
            let values = bots
                .entry(row["bot"].as_str().unwrap_or("").to_owned())
                .or_default();
            values.0 += row["input_tokens"].as_i64().unwrap_or(0);
            values.1 += row["output_tokens"].as_i64().unwrap_or(0);
            values.2 += row["cost"].as_f64().unwrap_or(0.0);
        }
    }
    let mut totals = (0, 0, 0.0);
    let mut by_bot = Vec::new();
    for (bot, values) in bots {
        totals.0 += values.0;
        totals.1 += values.1;
        totals.2 += values.2;
        by_bot.push(json!({"bot":bot,"input_tokens":values.0,"output_tokens":values.1,"estimated_cost_usd":values.2}));
    }
    Ok(
        json!({"input_tokens":totals.0,"output_tokens":totals.1,"estimated_cost_usd":totals.2,"by_bot":by_bot}),
    )
}

pub fn check_budget(home: &Path, caller: &str) -> Result<()> {
    let user = common::user(home, caller)?;
    let limits = common::json_field(&user["limits_json"]);
    let limit = limits["daily_tokens"].as_i64();
    if let Some(limit) = limit {
        let now = common::now();
        let usage = summary(home, caller, None, now - now % 86400.0)?;
        let used = usage["input_tokens"].as_i64().unwrap_or(0)
            + usage["output_tokens"].as_i64().unwrap_or(0);
        if used >= limit {
            return Err(Error::new(4303, "daily token budget reached")
                .with_data(json!({"user":caller,"used":used,"limit":limit})));
        }
    }
    Ok(())
}

fn ipv4_interfaces(interfaces: Vec<if_addrs::Interface>) -> BTreeSet<String> {
    interfaces
        .into_iter()
        .filter(|interface| interface.is_oper_up())
        .filter_map(|interface| match interface.ip() {
            std::net::IpAddr::V4(ip) if !ip.is_loopback() && !ip.is_unspecified() => {
                Some(ip.to_string())
            }
            _ => None,
        })
        .collect()
}

pub fn network(home: &Path) -> Result<Value> {
    let enabled = get(home)?["lan_enabled"].as_bool().unwrap_or(false);
    let state: Value = fs::read(home.join("serve-state.json"))
        .ok()
        .and_then(|s| serde_json::from_slice(&s).ok())
        .unwrap_or(Value::Null);
    let port = std::env::var("HEXBOT_PORT")
        .ok()
        .and_then(|s| s.parse::<u16>().ok())
        .map(u64::from)
        .or_else(|| state["port"].as_u64())
        .unwrap_or(9119);
    let addresses = ipv4_interfaces(if_addrs::get_if_addrs().unwrap_or_default());
    Ok(
        json!({"lan_enabled":enabled,"bind_host":if enabled {"0.0.0.0"} else {"127.0.0.1"},"port":port,"addresses":addresses}),
    )
}

/// Internal incident write; the runtime publishes the returned row to affected clients.
pub fn record_incident(
    home: &Path,
    bot: &str,
    kind: &str,
    text: &str,
    context: &Value,
) -> Result<Value> {
    common::identifier(bot)?;
    if !matches!(kind, "connector_error" | "turn_failed") {
        return Err(Error::new(4202, "invalid incident kind"));
    }
    let mut conn = db::open(home)?;
    let tx = conn.transaction()?;
    let connector = context["connector"].as_str();
    let section = context["section_id"].as_str();
    let existing = common::rows(
        &tx,
        "SELECT * FROM bot_incidents WHERE bot=? AND kind=? AND resolved_at IS NULL AND COALESCE(connector,'')=COALESCE(?,'') AND COALESCE(section_id,'')=COALESCE(?,'')",
        &[&bot, &kind, &connector, &section],
    )?
    .into_iter()
    .next();
    let text = text.trim().chars().take(500).collect::<String>();
    let now = common::now();
    let id = if let Some(existing) = existing {
        let id = existing["id"].as_str().unwrap().to_string();
        let text = if text.is_empty() {
            existing["text"].as_str().unwrap_or("")
        } else {
            &text
        };
        let session = context["session_id"]
            .as_str()
            .filter(|s| !s.is_empty())
            .or_else(|| existing["session_id"].as_str());
        tx.execute(
            "UPDATE bot_incidents SET text=?,created_at=?,session_id=? WHERE id=?",
            params![text, now, session, id],
        )?;
        id
    } else {
        let id = common::id();
        tx.execute(
            "INSERT INTO bot_incidents(id,bot,section_id,room_id,session_id,kind,connector,text,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
            params![
                id,
                bot,
                section,
                context["room_id"].as_str(),
                context["session_id"].as_str(),
                kind,
                connector,
                text,
                now
            ],
        )?;
        id
    };
    let row = common::rows(&tx, "SELECT * FROM bot_incidents WHERE id=?", &[&id])?.remove(0);
    tx.commit()?;
    Ok(row)
}

pub fn resolve_incidents(home: &Path, filters: &Value) -> Result<Vec<Value>> {
    if !["bot", "connector", "section_id", "incident_id"]
        .iter()
        .any(|key| filters[key].as_str().is_some_and(|s| !s.is_empty()))
    {
        return Err(Error::new(4202, "resolve needs a filter"));
    }
    if let Some(kind) = filters["kind"].as_str()
        && !matches!(kind, "connector_error" | "turn_failed")
    {
        return Err(Error::new(4202, "invalid incident kind"));
    }
    let mut sql = "SELECT * FROM bot_incidents WHERE resolved_at IS NULL".to_string();
    let mut args = Vec::new();
    for key in ["bot", "connector", "section_id", "incident_id", "kind"] {
        if let Some(value) = filters[key].as_str().filter(|s| !s.is_empty()) {
            sql.push_str(&format!(
                " AND {}=?",
                if key == "incident_id" { "id" } else { key }
            ));
            args.push(value);
        }
    }
    let mut conn = db::open(home)?;
    let tx = conn.transaction()?;
    let args = args
        .iter()
        .map(|s| s as &dyn rusqlite::ToSql)
        .collect::<Vec<_>>();
    let mut rows = common::rows(&tx, &sql, &args)?;
    let now = common::now();
    for row in &mut rows {
        tx.execute(
            "UPDATE bot_incidents SET resolved_at=? WHERE id=?",
            params![now, row["id"].as_str()],
        )?;
        row["resolved_at"] = json!(now);
    }
    tx.commit()?;
    Ok(rows)
}

pub fn call(home: &Path, caller: &str, method: &str, p: &Value) -> Option<Result<Value>> {
    Some(match method {
        "hexbot.settings.get" => common::admin(home, caller).and_then(|()| get(home)),
        "hexbot.settings.set" => update(home, caller, &p["patch"]),
        "hexbot.usage.summary" => {
            let since = p
                .get("since")
                .filter(|v| !v.is_null())
                .map(|v| {
                    v.as_f64()
                        .ok_or_else(|| Error::new(4202, "since must be a number"))
                })
                .transpose();
            since.and_then(|s| summary(home, caller, p["user"].as_str(), s.unwrap_or(0.0)))
        }
        "hexbot.network.get" => common::admin(home, caller).and_then(|()| network(home)),
        "hexbot.network.set" => update(home, caller, &json!({"lan_enabled":p["lan_enabled"]}))
            .and_then(|_| network(home)),
        _ => return None,
    })
}

#[cfg(test)]
mod network_tests {
    use super::*;
    fn interface(ip: &str, up: bool) -> if_addrs::Interface {
        if_addrs::Interface {
            name: "fixture".into(),
            addr: if_addrs::IfAddr::V4(if_addrs::Ifv4Addr {
                ip: ip.parse().unwrap(),
                netmask: "255.255.255.0".parse().unwrap(),
                prefixlen: 24,
                broadcast: None,
            }),
            index: None,
            oper_status: if up {
                if_addrs::IfOperStatus::Up
            } else {
                if_addrs::IfOperStatus::Down
            },
            is_p2p: false,
            #[cfg(windows)]
            adapter_name: "fixture".into(),
        }
    }
    #[test]
    fn includes_lan_and_vpn_interfaces_without_hostname_or_default_route() {
        let addresses = ipv4_interfaces(vec![
            interface("192.168.1.5", true),
            interface("100.64.0.2", true),
            interface("127.0.0.1", true),
            interface("0.0.0.0", true),
            interface("10.1.1.5", false),
            interface("192.168.1.5", true),
        ]);
        assert_eq!(
            addresses,
            BTreeSet::from(["192.168.1.5".into(), "100.64.0.2".into()])
        );
        let home = tempfile::tempdir().unwrap();
        db::migrate(home.path()).unwrap();
        let reported = network(home.path()).unwrap();
        for address in ipv4_interfaces(if_addrs::get_if_addrs().unwrap()) {
            assert!(
                reported["addresses"]
                    .as_array()
                    .unwrap()
                    .contains(&json!(address))
            );
        }
    }
}
