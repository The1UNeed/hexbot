//! Plugins: one view over connectors, skills and capabilities, and the bots
//! each is given to. Setup stays with each kind (`hexbot.connectors.setup`,
//! the skill's own prerequisites, the program a capability runs); this module
//! lists what is ready and assigns it to bots in one call.
use crate::{
    Error, Result,
    common::{self, *},
    connectors, db, native_tools, skills,
};
use serde_json::{Value, json};
use std::path::Path;

/// Built-in tools that need a program or service on the daemon's computer:
/// (bot tool, toolset, name, description, what setting it up takes).
const CAPABILITIES: &[(&str, &str, &str, &str, &str)] = &[
    (
        "computer_use",
        "computer_use",
        "Computer use",
        "Use the shared computer: see its screen, click and type in its apps.",
        "Install Cua on the daemon's computer with `uv tool install cua` and start Docker.",
    ),
    (
        "browser",
        "browser",
        "Browser",
        "Open pages and click through them in Chrome.",
        "Install Chrome or Chromium, or set up a cloud browser connector.",
    ),
    (
        "code_execution",
        "code_execution",
        "Code execution",
        "Run scripts in a sandbox for data work and quick checks.",
        "Install Python 3 on the daemon's computer.",
    ),
];

/// The caller's bots, by name.
fn own_bots(home: &Path, caller: &str) -> Result<Vec<String>> {
    Ok(rows(
        &db::open(home)?,
        "SELECT name FROM bots WHERE owner_id=? ORDER BY name",
        &[&caller],
    )?
    .iter()
    .filter_map(|r| r["name"].as_str().map(str::to_owned))
    .collect())
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}

fn only(bots: &Value, own: &[String]) -> Value {
    json!(
        bots.as_array()
            .into_iter()
            .flatten()
            .filter(|b| own.iter().any(|o| *b == o.as_str()))
            .collect::<Vec<_>>()
    )
}

fn connector_rows(home: &Path, own: &[String], bot: Option<&str>) -> Result<Vec<Value>> {
    let mut rows = connectors::list(home, bot)?["connectors"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    for row in &mut rows {
        row["kind"] = json!("connector");
        row["bots"] = only(&row["enabled_bots"], own);
    }
    Ok(rows)
}

fn skill_rows(home: &Path, own: &[String], bot: Option<&str>) -> Result<Vec<Value>> {
    let per_bot = own
        .iter()
        .map(|b| Ok((b.as_str(), skills::resolve(home, Some(b))?)))
        .collect::<Result<Vec<_>>>()?;
    // With a bot, each row is that bot's own view: its grant, its private
    // skills and the keys in its `.env`.
    let listed = match bot.and_then(|b| per_bot.iter().find(|(name, _)| *name == b)) {
        Some((_, list)) => list.clone(),
        None => skills::resolve(home, None)?,
    };
    let mut rows = vec![];
    for skill in listed {
        let given = per_bot
            .iter()
            .filter(|(_, list)| {
                list.iter()
                    .any(|s| s.name == skill.name && s.enabled_for_bot)
            })
            .map(|(b, _)| *b)
            .collect::<Vec<_>>();
        let mut row = json!(skill);
        row["kind"] = json!("skill");
        row["id"] = json!(skill.name);
        row["bots"] = json!(given);
        row.as_object_mut().unwrap().remove("path");
        rows.push(row);
    }
    Ok(rows)
}

fn capability_rows(home: &Path, own: &[String], bot: Option<&str>) -> Result<Vec<Value>> {
    let toolsets = own
        .iter()
        .map(|b| Ok((b.as_str(), connectors::toolsets(home, b)?)))
        .collect::<Result<Vec<_>>>()?;
    let mut rows = vec![];
    for (id, toolset, name, description, setup) in CAPABILITIES {
        let ready = native_tools::set_up_on_daemon(home, toolset)?;
        let given = toolsets
            .iter()
            .filter(|(_, sets)| sets.iter().any(|t| t == toolset))
            .map(|(b, _)| *b)
            .collect::<Vec<_>>();
        let mut row = json!({
            "kind": "capability",
            "id": id,
            "name": name,
            "description": description,
            "ready": ready,
            "setup": if ready { Value::Null } else { json!(setup) },
            "bots": given,
        });
        if let Some(bot) = bot {
            row["enabled_for_bot"] = json!(given.contains(&bot));
        }
        rows.push(row);
    }
    Ok(rows)
}

fn list(home: &Path, caller: &str, bot: Option<&str>) -> Result<Value> {
    let own = own_bots(home, caller)?;
    Ok(json!({
        "connectors": connector_rows(home, &own, bot)?,
        "skills": skill_rows(home, &own, bot)?,
        "capabilities": capability_rows(home, &own, bot)?,
    }))
}

fn find(home: &Path, caller: &str, kind: &str, id: &str) -> Result<Value> {
    let own = own_bots(home, caller)?;
    let rows = match kind {
        "connector" => connector_rows(home, &own, None)?,
        "skill" => skill_rows(home, &own, None)?,
        "capability" => capability_rows(home, &own, None)?,
        _ => return Err(Error::new(4202, format!("unknown plugin kind: {kind}"))),
    };
    rows.into_iter()
        .find(|row| row["id"] == id)
        .ok_or_else(|| Error::new(4213, format!("unknown {kind}: {id}")))
}

/// Give a plugin to exactly the caller's bots in `bots`. A plugin that is
/// not set up can be taken away from bots but not given to them.
fn set_bots(home: &Path, caller: &str, p: &Value) -> Result<Value> {
    let kind = required(p, "kind")?;
    let id = required(p, "id")?;
    let current = find(home, caller, kind, id)?;
    let own = own_bots(home, caller)?;
    // A switched-off server is still given to the bots on its stored list.
    let current_bots = match id.strip_prefix("mcp:").filter(|_| kind == "connector") {
        Some(server) => connectors::mcp_bots(home, server)?
            .into_iter()
            .filter(|b| own.contains(b))
            .collect(),
        None => strings(&current["bots"]),
    };
    let chosen = connectors::chosen_bots(home, caller, &current_bots, &p["bots"])?;
    let wanted = |bot: &str| chosen.iter().any(|b| b == bot);
    // A skill can be ready for one bot through a key in that bot's `.env`.
    let ready_for = |bot: &str| -> Result<bool> {
        if kind == "skill" {
            return Ok(skills::resolve(home, Some(bot))?
                .iter()
                .any(|s| s.name == id && s.ready));
        }
        Ok(current["ready"] == true)
    };
    let mut blocked = false;
    for bot in own
        .iter()
        .filter(|b| wanted(b) && !current_bots.contains(b))
    {
        blocked |= !ready_for(bot)?;
    }
    let not_set_up = || {
        Error::new(
            4209,
            format!(
                "Set up {} before giving it to a bot.",
                current["name"].as_str().unwrap_or(id)
            ),
        )
    };
    if blocked {
        return Err(not_set_up());
    }
    match kind {
        "connector" if id.starts_with("mcp:") => {
            let server = &id["mcp:".len()..];
            connectors::change_mcp_bots(home, server, |bots| {
                // Checked again on the list as it is under the lock, so a
                // concurrent change can't turn keeping a bot into giving it.
                if current["ready"] != true && own.iter().any(|b| wanted(b) && !bots.contains(b)) {
                    return Err(not_set_up());
                }
                bots.retain(|b| !own.contains(b));
                bots.extend(chosen.iter().filter(|b| own.contains(b)).cloned());
                Ok(())
            })?;
        }
        "connector" => {
            for bot in &own {
                if wanted(bot) != current_bots.contains(bot) {
                    // The cloud browser's provider is the daemon's; a bot has
                    // it through its browser tool.
                    if id == "cloud_browser" {
                        connectors::set_toolsets(home, bot, id, wanted(bot))?;
                    } else {
                        connectors::set_enabled(home, bot, id, wanted(bot))?;
                    }
                }
            }
        }
        "skill" => {
            let _guard = skills::LOCK
                .write()
                .map_err(|_| Error::new(5200, "skills lock unavailable"))?;
            for bot in &own {
                if wanted(bot) != current_bots.contains(bot) {
                    skills::find_unlocked(home, Some(bot), id)?;
                    skills::set_enabled(home, Some(bot), id, wanted(bot))?;
                }
            }
        }
        _ => {
            let toolset = CAPABILITIES
                .iter()
                .find(|(tool, ..)| *tool == id)
                .map(|(_, toolset, ..)| *toolset)
                .unwrap_or(id);
            for bot in &own {
                if wanted(bot) == current_bots.contains(bot) {
                    continue;
                }
                // Only this capability's toolset changes; other granted tools
                // stay on even while they wait for setup.
                connectors::switch_toolsets(home, bot, &[toolset.to_string()], wanted(bot))?;
            }
        }
    }
    Ok(json!({"plugin": find(home, caller, kind, id)?}))
}

pub fn call(home: &Path, caller: &str, method: &str, p: &Value) -> Option<Result<Value>> {
    if !method.starts_with("hexbot.plugins.") {
        return None;
    }
    Some((|| {
        common::user(home, caller)?;
        let bot = p["bot"].as_str().filter(|s| !s.is_empty());
        if let Some(bot) = bot {
            bot_owner(home, caller, bot)?;
        }
        match method {
            "hexbot.plugins.list" => list(home, caller, bot),
            "hexbot.plugins.set_bots" => set_bots(home, caller, p),
            _ => Err(Error::new(-32601, "method not found")),
        }
    })())
}

#[cfg(test)]
#[path = "plugins_tests.rs"]
mod tests;
