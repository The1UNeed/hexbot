//! Plugins: one view over connectors, skills and capabilities, and the bots
//! each is given to. Setup stays with each kind (`hexbot.connectors.setup`,
//! the skill's own prerequisites, the program a capability runs); this module
//! lists what is ready and assigns it to bots in one call.
//!
//! A package installs an MCP server with the skills that explain it, or
//! several skills, as one plugin. It lives in `plugins/<name>/` as
//! `plugin.json` and a `skills/` folder; its server is a daemon-level entry
//! in `mcp_servers` marked `plugin: <name>`, given to bots like any other.
use crate::{
    Error, Result,
    common::{self, *},
    connectors, db, native_tools, skills,
};
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
};

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
    let config = read_config(home)?;
    // A package's server is listed, given and removed with its package.
    rows.retain(|row| {
        row["mcp"]["name"]
            .as_str()
            .is_none_or(|name| !config["mcp_servers"][name]["plugin"].is_string())
    });
    for row in &mut rows {
        row["kind"] = json!("connector");
        if let Some(name) = row["mcp"]["name"].as_str() {
            let entry = &config["mcp_servers"][name];
            row["server"] = server_details(entry);
            if let Some((state, text)) = needs(entry) {
                row["state"] = state;
                row["state_text"] = text;
            }
        }
        // A switched-off server is still given to the bots on its stored list.
        let bots = match row["id"].as_str().and_then(|id| id.strip_prefix("mcp:")) {
            Some(server) => json!(connectors::mcp_bots(home, server)?),
            None => row["enabled_bots"].clone(),
        };
        row["bots"] = only(&bots, own);
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
    for skill in listed.into_iter().filter(|s| s.plugin.is_none()) {
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

pub(crate) fn list(home: &Path, caller: &str, bot: Option<&str>) -> Result<Value> {
    let own = own_bots(home, caller)?;
    Ok(json!({
        "connectors": connector_rows(home, &own, bot)?,
        "skills": skill_rows(home, &own, bot)?,
        "capabilities": capability_rows(home, &own, bot)?,
        "packages": package_rows(home, &own, bot)?,
    }))
}

pub(crate) fn find(home: &Path, caller: &str, kind: &str, id: &str) -> Result<Value> {
    find_for(home, caller, kind, id, None)
}

/// A row as `list` gives it, with `enabled_for_bot` when a bot is named.
pub(crate) fn find_for(
    home: &Path,
    caller: &str,
    kind: &str,
    id: &str,
    bot: Option<&str>,
) -> Result<Value> {
    let own = own_bots(home, caller)?;
    let rows = match kind {
        "connector" => connector_rows(home, &own, bot)?,
        "skill" => skill_rows(home, &own, bot)?,
        "capability" => capability_rows(home, &own, bot)?,
        "package" => package_rows(home, &own, bot)?,
        _ => return Err(Error::new(4202, format!("unknown plugin kind: {kind}"))),
    };
    rows.into_iter()
        .find(|row| row["id"] == id)
        .ok_or_else(|| Error::new(4213, format!("unknown {kind}: {id}")))
}

/// Give a plugin to exactly the caller's bots in `bots`. A plugin that is
/// not set up can be taken away from bots but not given to them.
pub(crate) fn set_bots(home: &Path, caller: &str, p: &Value) -> Result<Value> {
    let kind = required(p, "kind")?;
    let id = required(p, "id")?;
    if kind == "package" {
        let chosen = connectors::chosen_bots(home, caller, &[], &p["bots"])?;
        assign_package(home, caller, id, &chosen)?;
        // Choosing every bot means every bot, including later ones.
        let own = own_bots(home, caller)?;
        let scope = (!own.iter().all(|b| chosen.contains(b))).then_some(chosen);
        set_scope(home, id, scope.as_deref())?;
        return Ok(json!({"plugin": find(home, caller, kind, id)?}));
    }
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
    // A skill or connector can be ready for one bot through a key in that
    // bot's `.env`.
    let ready_for = |bot: &str| -> Result<bool> {
        match kind {
            "skill" => Ok(skills::resolve(home, Some(bot))?
                .iter()
                .any(|s| s.name == id && s.ready)),
            "connector" if !id.starts_with("mcp:") => {
                Ok(connectors::get(home, Some(bot), id)?["ready"] == true)
            }
            _ => Ok(current["ready"] == true),
        }
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
            "hexbot.plugins.install" => {
                let package = parse(p)?;
                let bots = match p.get("bots") {
                    None | Some(Value::Null) => None,
                    Some(value) => Some(connectors::chosen_bots(home, caller, &[], value)?),
                };
                install(home, caller, &package, None, bots.as_deref())?;
                Ok(json!({"plugin": find(home, caller, "package", &package.name)?}))
            }
            "hexbot.plugins.configure" => {
                let kind = required(p, "kind")?;
                let id = required(p, "id")?;
                configure(home, &server_of(kind, id)?, p)?;
                Ok(json!({"plugin": find(home, caller, kind, id)?}))
            }
            "hexbot.plugins.remove" => {
                if required(p, "kind")? != "package" {
                    return Err(Error::new(
                        4202,
                        "Only packages are removed here. Remove a server or a skill where it was added.",
                    ));
                }
                remove(home, required(p, "id")?)?;
                Ok(json!({"removed": true}))
            }
            _ => Err(Error::new(-32601, "method not found")),
        }
    })())
}

// ---------------------------------------------------------------------------
// Packages
// ---------------------------------------------------------------------------

const MAX_SKILLS: usize = 20;
const MAX_DESCRIPTION: usize = 300;

pub(crate) fn packages_root(home: &Path) -> PathBuf {
    home.join("plugins")
}

/// Installed packages, sorted. A folder without `plugin.json` is not one;
/// dot folders are installs still being staged.
pub(crate) fn package_names(home: &Path) -> Result<Vec<String>> {
    let mut out = vec![];
    let Ok(entries) = fs::read_dir(packages_root(home)) else {
        return Ok(out);
    };
    for entry in entries {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if entry.file_type()?.is_dir()
            && skills::valid_skill_name(&name).is_ok()
            && entry.path().join("plugin.json").is_file()
        {
            out.push(name);
        }
    }
    out.sort();
    Ok(out)
}

fn manifest(home: &Path, name: &str) -> Result<Value> {
    skills::valid_skill_name(name)?;
    let path = packages_root(home).join(name).join("plugin.json");
    skills::safe_path(home, &path)?;
    if !path.is_file() {
        return Err(Error::new(4213, format!("unknown package: {name}")));
    }
    serde_json::from_str(&common::read_regular_text(&path, 64 * 1024)?)
        .map_err(|e| Error::new(5200, format!("plugin {name} is damaged: {e}")))
}

fn write_manifest(home: &Path, name: &str, manifest: &Value) -> Result<()> {
    common::atomic_write(
        &packages_root(home).join(name).join("plugin.json"),
        serde_json::to_string_pretty(manifest)
            .expect("json")
            .as_bytes(),
    )
}

/// A package to install, checked before anyone is asked about it.
#[derive(Debug)]
pub(crate) struct Package {
    pub name: String,
    pub description: String,
    pub server: Option<Value>,
    pub skills: Vec<(String, String)>,
}

impl Package {
    /// What the package does, as the approval card says it.
    pub fn summary(&self) -> String {
        let mut parts = vec![];
        if let Some(server) = &self.server {
            parts.push(match server["url"].as_str() {
                Some(url) => format!("connects to the MCP server at {url}"),
                None => format!(
                    "runs the MCP server `{}` on this computer",
                    std::iter::once(server["command"].as_str().unwrap_or(""))
                        .chain(
                            server["args"]
                                .as_array()
                                .into_iter()
                                .flatten()
                                .filter_map(Value::as_str)
                        )
                        .collect::<Vec<_>>()
                        .join(" ")
                ),
            });
            // Everything the server is given shows on the card, empty or not.
            let values = [&server["env"], &server["headers"]]
                .into_iter()
                .flat_map(|v| v.as_object().into_iter().flatten())
                .map(|(key, value)| match value.as_str().unwrap_or("") {
                    "" => format!("{key} (empty, for you to fill in)"),
                    value => format!("{key}={value}"),
                })
                .collect::<Vec<_>>();
            if !values.is_empty() {
                parts.push(format!("passes {}", values.join(", ")));
            }
        }
        if !self.skills.is_empty() {
            let names = self
                .skills
                .iter()
                .map(|(n, _)| n.as_str())
                .collect::<Vec<_>>();
            parts.push(format!(
                "adds the skill{} {}",
                if names.len() == 1 { "" } else { "s" },
                names.join(", ")
            ));
        }
        parts.join(" and ")
    }
}

/// Parse `{name, description?, mcp?: {command, args, env} | {url, headers},
/// skills?: [{name, content}]}`.
pub(crate) fn parse(p: &Value) -> Result<Package> {
    let name = required(p, "name")?.trim();
    skills::valid_skill_name(name).map_err(|_| {
        Error::new(
            4202,
            "plugin name must use lowercase letters, digits, hyphens or underscores, up to 64 characters",
        )
    })?;
    let description = p["description"].as_str().unwrap_or("").trim();
    if description.chars().count() > MAX_DESCRIPTION {
        return Err(Error::new(4202, "plugin description is too long"));
    }
    let server = match &p["mcp"] {
        Value::Null => None,
        Value::Object(_) => {
            let mut params = p["mcp"].clone();
            params["name"] = json!(name);
            let (_, mut entry) = connectors::validate_mcp(&params)?;
            if !description.is_empty() {
                entry["description"] = json!(description);
            }
            entry["plugin"] = json!(name);
            Some(entry)
        }
        _ => return Err(Error::new(4202, "mcp must be an object")),
    };
    let mut list = vec![];
    if !p["skills"].is_null() {
        let items = p["skills"]
            .as_array()
            .ok_or_else(|| Error::new(4202, "skills must be a list"))?;
        if items.len() > MAX_SKILLS {
            return Err(Error::new(4202, "a plugin holds up to 20 skills"));
        }
        for item in items {
            let skill = required(item, "name")?.trim().to_owned();
            skills::valid_skill_name(&skill)?;
            let content = required(item, "content")?;
            skills::valid_skill_content(content)?;
            if list.iter().any(|(n, _)| n == &skill) {
                return Err(Error::new(4202, format!("skill {skill} is listed twice")));
            }
            list.push((skill, content.to_owned()));
        }
    }
    if server.is_none() && list.is_empty() {
        return Err(Error::new(
            4200,
            "a plugin needs an MCP server, a skill, or both",
        ));
    }
    Ok(Package {
        name: name.to_owned(),
        description: description.to_owned(),
        server,
        skills: list,
    })
}

/// Install a package for `bots`, or for every bot of the caller's when
/// `bots` is left out. An install for some bots keeps that list even if it
/// names every bot today, so bots created later don't get it.
pub(crate) fn install(
    home: &Path,
    caller: &str,
    package: &Package,
    installed_by: Option<&str>,
    bots: Option<&[String]>,
) -> Result<()> {
    let own = own_bots(home, caller)?;
    {
        let _guard = skills::LOCK
            .write()
            .map_err(|_| Error::new(5200, "skills lock unavailable"))?;
        let dir = packages_root(home).join(&package.name);
        if dir.exists() {
            return Err(Error::new(
                4208,
                format!("A plugin named {} is already installed.", package.name),
            ));
        }
        if package.server.is_some()
            && read_config(home)?["mcp_servers"]
                .get(&package.name)
                .is_some()
        {
            return Err(Error::new(
                4208,
                format!("An MCP server named {} already exists.", package.name),
            ));
        }
        // A bot's private skill keeps its name too: giving the package to
        // that bot or taking it away would otherwise switch the private skill.
        let mut taken = skills::resolve_unlocked(home, None)?
            .into_iter()
            .map(|s| s.name)
            .collect::<BTreeSet<_>>();
        for bot in connectors::names(home)? {
            taken.extend(
                skills::resolve_unlocked(home, Some(&bot))?
                    .into_iter()
                    .map(|s| s.name),
            );
        }
        if let Some((skill, _)) = package.skills.iter().find(|(n, _)| taken.contains(n)) {
            return Err(Error::new(
                4208,
                format!("A skill named {skill} already exists."),
            ));
        }
        fs::create_dir_all(packages_root(home))?;
        skills::safe_path(home, &packages_root(home))?;
        let stage = tempfile::tempdir_in(packages_root(home))?;
        let work = stage.path().join("work");
        fs::create_dir_all(work.join("skills"))?;
        for (skill, content) in &package.skills {
            fs::create_dir(work.join("skills").join(skill))?;
            fs::write(work.join("skills").join(skill).join("SKILL.md"), content)?;
        }
        let manifest = json!({
            "name": package.name,
            "description": package.description,
            "server": package.server.is_some(),
            "installed_by": installed_by,
            "installed_at": now(),
            "bots": bots,
        });
        fs::write(
            work.join("plugin.json"),
            serde_json::to_string_pretty(&manifest).expect("json"),
        )?;
        fs::rename(&work, &dir)?;
        if let Some(entry) = &package.server {
            let mut entry = entry.clone();
            entry["bots"] = json!([]);
            if let Err(error) = common::update_config(home, |config| {
                if !config["mcp_servers"].is_object() {
                    config["mcp_servers"] = json!({});
                }
                config["mcp_servers"][&package.name] = entry;
                Ok(())
            }) {
                undo_install(home, package);
                return Err(error);
            }
        }
    }
    let chosen = bots.map(<[String]>::to_vec).unwrap_or(own);
    if let Err(error) = assign_package(home, caller, &package.name, &chosen) {
        undo_install(home, package);
        return Err(error);
    }
    Ok(())
}

/// Best effort: take back whatever a failed install already wrote.
fn undo_install(home: &Path, package: &Package) {
    if package.server.is_some() {
        let _ = forget_server(home, &package.name);
    }
    let _ = fs::remove_dir_all(packages_root(home).join(&package.name));
}

fn forget_server(home: &Path, name: &str) -> Result<()> {
    common::update_config(home, |config| {
        if let Some(servers) = config["mcp_servers"].as_object_mut() {
            servers.remove(name);
        }
        Ok(())
    })?;
    db::open(home)?.execute(
        "DELETE FROM settings WHERE key=?",
        [format!("connector_test:mcp:{name}")],
    )?;
    Ok(())
}

fn package_skills(home: &Path, name: &str) -> Result<Vec<String>> {
    Ok(skills::resolve(home, None)?
        .into_iter()
        .filter(|s| s.plugin.as_deref() == Some(name))
        .map(|s| s.name)
        .collect())
}

/// Give every part of a package to exactly `chosen` of the caller's bots.
fn assign_package(home: &Path, caller: &str, name: &str, chosen: &[String]) -> Result<()> {
    let manifest = manifest(home, name)?;
    let own = own_bots(home, caller)?;
    if manifest["server"] == true {
        connectors::change_mcp_bots(home, name, |bots| {
            bots.retain(|b| !own.contains(b));
            bots.extend(chosen.iter().filter(|b| own.contains(b)).cloned());
            Ok(())
        })?;
    }
    let parts = package_skills(home, name)?;
    let _guard = skills::LOCK
        .write()
        .map_err(|_| Error::new(5200, "skills lock unavailable"))?;
    for bot in &own {
        for skill in &parts {
            skills::set_enabled(home, Some(bot), skill, chosen.contains(bot))?;
        }
    }
    Ok(())
}

/// Give a plugin to one bot or take it away, leaving every other bot as it
/// is, as a bot asking for itself does. A server's list changes under the
/// config lock; a package's scope gains or loses only this bot, so a bot's
/// request never reaches bots created later.
pub(crate) fn set_for_bot(
    home: &Path,
    caller: &str,
    kind: &str,
    id: &str,
    bot: &str,
    on: bool,
) -> Result<()> {
    bot_owner(home, caller, bot)?;
    let current = find(home, caller, kind, id)?;
    let server = match (kind, id.strip_prefix("mcp:")) {
        ("connector", Some(server)) => Some(server.to_owned()),
        ("package", _) if manifest(home, id)?["server"] == true => Some(id.to_owned()),
        _ => None,
    };
    let toolset = CAPABILITIES
        .iter()
        .find(|(tool, ..)| *tool == id)
        .map(|(_, toolset, ..)| *toolset);
    // Ready for this bot: a skill or connector can be, through a key in its own `.env`.
    let ready = match kind {
        "skill" => skills::resolve(home, Some(bot))?
            .iter()
            .any(|s| s.name == id && s.ready),
        "connector" if server.is_none() => connectors::get(home, Some(bot), id)?["ready"] == true,
        "capability" => native_tools::set_up_on_daemon(
            home,
            toolset.ok_or_else(|| Error::new(4213, format!("unknown capability: {id}")))?,
        )?,
        _ => current["ready"] != false,
    };
    if on && !ready {
        return Err(Error::new(
            4209,
            format!(
                "Set up {} before giving it to a bot.",
                current["name"].as_str().unwrap_or(id)
            ),
        ));
    }
    if let Some(server) = &server {
        connectors::change_mcp_bots(home, server, |bots| {
            bots.retain(|b| b != bot);
            if on {
                bots.push(bot.to_owned());
            }
            Ok(())
        })?;
    }
    match kind {
        "package" => {
            for skill in package_skills(home, id)? {
                skills::set_enabled(home, Some(bot), &skill, on)?;
            }
            let mut manifest = manifest(home, id)?;
            if let Some(scope) = manifest["bots"].as_array_mut() {
                scope.retain(|b| b != bot);
                if on {
                    scope.push(json!(bot));
                }
                write_manifest(home, id, &manifest)?;
            }
        }
        "connector" if server.is_some() => {}
        // The cloud browser's provider is the daemon's; a bot has it through
        // its browser tool.
        "connector" if id == "cloud_browser" => connectors::set_toolsets(home, bot, id, on)?,
        "connector" => connectors::set_enabled(home, bot, id, on)?,
        "skill" => {
            let _guard = skills::LOCK
                .write()
                .map_err(|_| Error::new(5200, "skills lock unavailable"))?;
            skills::find_unlocked(home, Some(bot), id)?;
            skills::set_enabled(home, Some(bot), id, on)?;
        }
        _ => connectors::switch_toolsets(home, bot, &[toolset.unwrap_or(id).to_string()], on)?,
    }
    Ok(())
}

fn set_scope(home: &Path, name: &str, bots: Option<&[String]>) -> Result<()> {
    let mut manifest = manifest(home, name)?;
    manifest["bots"] = json!(bots);
    write_manifest(home, name, &manifest)
}

/// A new bot starts with every package installed for every bot, and
/// without those installed for some: skills are on for new bots and
/// servers off, so each is set to match.
pub(crate) fn scope_new_bot(home: &Path, bot: &str) -> Result<()> {
    for name in package_names(home)? {
        let Ok(manifest) = manifest(home, &name) else {
            continue;
        };
        let on = !manifest["bots"].is_array()
            || manifest["bots"]
                .as_array()
                .is_some_and(|bots| bots.iter().any(|b| b == bot));
        // A server missing from the config (removed by hand, or a removal
        // cut short) has nobody to give; the bot is created all the same.
        if manifest["server"] == true
            && read_config(home)?["mcp_servers"][name.as_str()].is_object()
        {
            connectors::change_mcp_bots(home, &name, |bots| {
                bots.retain(|b| b != bot);
                if on {
                    bots.push(bot.to_owned());
                }
                Ok(())
            })?;
        }
        if !on {
            for skill in package_skills(home, &name)? {
                skills::set_enabled(home, Some(bot), &skill, false)?;
            }
        }
    }
    Ok(())
}

/// Take a deleted bot out of every package's list, so a new bot with its
/// name doesn't get what it was given.
pub(crate) fn forget_bot(home: &Path, bot: &str) -> Result<()> {
    for name in package_names(home)? {
        let Ok(mut manifest) = manifest(home, &name) else {
            continue;
        };
        if let Some(scope) = manifest["bots"].as_array_mut()
            && scope.iter().any(|b| b == bot)
        {
            scope.retain(|b| b != bot);
            write_manifest(home, &name, &manifest)?;
        }
    }
    Ok(())
}

/// Remove a package: its server and its skills, for every bot.
pub(crate) fn remove(home: &Path, name: &str) -> Result<()> {
    let manifest = manifest(home, name)?;
    let _guard = skills::LOCK
        .write()
        .map_err(|_| Error::new(5200, "skills lock unavailable"))?;
    if manifest["server"] == true {
        forget_server(home, name)?;
    }
    fs::remove_dir_all(packages_root(home).join(name))?;
    Ok(())
}

/// The daemon-level server a plugin row runs: `mcp:<name>`, or a package with one.
pub(crate) fn server_of(kind: &str, id: &str) -> Result<String> {
    match (kind, id.strip_prefix("mcp:")) {
        ("connector", Some(name)) => Ok(name.to_owned()),
        ("package", _) => Ok(id.to_owned()),
        _ => Err(Error::new(4202, "only MCP servers have settings here")),
    }
}

/// Change an MCP server's command, address, environment or headers. Values
/// set to null are removed; names left out keep theirs. The server keeps its
/// bots, description and package.
pub(crate) fn configure(home: &Path, name: &str, p: &Value) -> Result<()> {
    // Read, merge and write under the config lock, so saves made at the same
    // time, and bots given in between, all keep their part.
    common::update_config(home, |config| {
        let entry = config["mcp_servers"][name].clone();
        if !entry.is_object() {
            return Err(Error::new(4213, format!("unknown MCP server: {name}")));
        }
        let command = p["command"].as_str().filter(|s| !s.trim().is_empty());
        let url = p["url"]
            .as_str()
            .filter(|s| !s.trim().is_empty())
            .or_else(|| command.is_none().then(|| entry["url"].as_str()).flatten());
        let mut params = json!({"name": name});
        if let Some(url) = url {
            params["url"] = json!(url);
            params["transport"] = entry["transport"].clone();
            params["headers"] = merged(&entry["headers"], &p["headers"], "headers")?;
        } else {
            params["command"] = command
                .map(Value::from)
                .unwrap_or_else(|| entry["command"].clone());
            params["args"] = if p["args"].is_null() {
                entry["args"].clone()
            } else {
                p["args"].clone()
            };
            params["env"] = merged(&entry["env"], &p["env"], "env")?;
        }
        let (_, mut next) = connectors::validate_mcp(&params)?;
        for key in ["description", "plugin", "timeout", "bots", "disabled"] {
            if let Some(value) = entry.get(key) {
                next[key] = value.clone();
            }
        }
        config["mcp_servers"][name] = next;
        Ok(())
    })?;
    db::open(home)?.execute(
        "DELETE FROM settings WHERE key=?",
        [format!("connector_test:mcp:{name}")],
    )?;
    Ok(())
}

fn merged(current: &Value, change: &Value, what: &str) -> Result<Value> {
    let mut map = current.as_object().cloned().unwrap_or_default();
    if !change.is_null() {
        let change = change
            .as_object()
            .ok_or_else(|| Error::new(4202, format!("{what} must be an object")))?;
        for (key, value) in change {
            match value {
                Value::Null => {
                    map.remove(key);
                }
                Value::String(_) => {
                    map.insert(key.clone(), value.clone());
                }
                _ => return Err(Error::new(4202, format!("{what} values must be strings"))),
            }
        }
    }
    Ok(if map.is_empty() {
        Value::Null
    } else {
        Value::Object(map)
    })
}

/// Names of an MCP server's environment or headers, with a masked tail of
/// each value. Values never leave the daemon.
fn masked(values: &Value) -> Vec<Value> {
    values
        .as_object()
        .into_iter()
        .flatten()
        .map(|(key, value)| {
            let text = value.as_str().unwrap_or("");
            let count = text.chars().count();
            json!({
                "key": key,
                "set": !text.is_empty(),
                "hint": (count >= 8).then(|| format!("…{}", text.chars().skip(count - 4).collect::<String>())),
            })
        })
        .collect()
}

fn server_details(entry: &Value) -> Value {
    let mut details = json!({
        "transport": if entry["url"].is_string() { "http" } else { "stdio" },
        "env": masked(&entry["env"]),
        "headers": masked(&entry["headers"]),
    });
    if let Some(url) = entry["url"].as_str() {
        details["url"] = json!(url);
    } else {
        details["command"] = entry["command"].clone();
        details["args"] = entry["args"]
            .as_array()
            .cloned()
            .map_or(json!([]), Value::Array);
    }
    details
}

/// A server with values left empty still needs them before it can start.
fn needs(entry: &Value) -> Option<(Value, Value)> {
    let missing = [&entry["env"], &entry["headers"]]
        .into_iter()
        .flat_map(|v| v.as_object().into_iter().flatten())
        .filter(|(_, v)| v.as_str().is_some_and(str::is_empty))
        .map(|(k, _)| k.clone())
        .collect::<Vec<_>>();
    (!missing.is_empty()).then(|| {
        (
            json!("not_set_up"),
            json!(format!("Needs {}", missing.join(", "))),
        )
    })
}

fn package_rows(home: &Path, own: &[String], bot: Option<&str>) -> Result<Vec<Value>> {
    let config = read_config(home)?;
    let connectors = connectors::list(home, None)?["connectors"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let per_bot = own
        .iter()
        .map(|b| Ok((b.clone(), skills::resolve(home, Some(b))?)))
        .collect::<Result<Vec<_>>>()?;
    let mut rows = vec![];
    for name in package_names(home)? {
        let Ok(manifest) = manifest(home, &name) else {
            continue;
        };
        let parts = skills::resolve(home, None)?
            .into_iter()
            .filter(|s| s.plugin.as_deref() == Some(name.as_str()))
            .collect::<Vec<_>>();
        let entry = &config["mcp_servers"][name.as_str()];
        let server = (manifest["server"] == true)
            .then(|| connectors.iter().find(|c| c["id"] == format!("mcp:{name}")))
            .flatten();
        let server_bots = if server.is_some() {
            connectors::mcp_bots(home, &name)?
        } else {
            vec![]
        };
        // On for a bot while any part is, so a part left on can always be
        // taken away here; giving it switches every part on.
        let given = own
            .iter()
            .filter(|b| {
                server_bots.contains(b)
                    || per_bot.iter().any(|(owner, list)| {
                        owner == *b
                            && list.iter().any(|s| {
                                parts.iter().any(|p| p.name == s.name) && s.enabled_for_bot
                            })
                    })
            })
            .cloned()
            .collect::<Vec<_>>();
        let (state, state_text) = match server {
            Some(c) => needs(entry).unwrap_or((c["state"].clone(), c["state_text"].clone())),
            None => (
                json!("ready"),
                json!(format!(
                    "{} skill{}",
                    parts.len(),
                    if parts.len() == 1 { "" } else { "s" }
                )),
            ),
        };
        let mut row = json!({
            "kind": "package",
            "id": name,
            "name": name,
            "description": manifest["description"],
            "ready": true,
            "state": state,
            "state_text": state_text,
            "bots": given,
            "installed_by": manifest["installed_by"],
            "skills": parts.iter().map(|s| json!({"name": s.name, "description": s.description})).collect::<Vec<_>>(),
            "connector": server,
            "server": server.map(|_| server_details(entry)),
        });
        if let Some(bot) = bot {
            row["enabled_for_bot"] = json!(given.iter().any(|b| b == bot));
        }
        rows.push(row);
    }
    Ok(rows)
}

#[cfg(test)]
#[path = "plugins_tests.rs"]
mod tests;
