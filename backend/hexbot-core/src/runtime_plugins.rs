//! `hexbot_plugins`: a bot sees the plugins and asks for one it lacks.
//! Installing a plugin or turning one on always asks the user, even in
//! Bypass, and a scheduled job or a check-in, which nobody watches, cannot.
//! A package a bot installs is on for that bot only. The primary bot, in its
//! own chat, does the same for any bot and removes packages.
use super::*;

pub(super) const NAME: &str = "hexbot_plugins";

/// The kinds `hexbot.plugins.list` returns, by the list each sits in.
const SECTIONS: &[(&str, &str)] = &[
    ("connectors", "connector"),
    ("skills", "skill"),
    ("capabilities", "capability"),
    ("packages", "package"),
];

pub(super) fn descriptor() -> Value {
    let strings = json!({"type":"array","items":{"type":"string"}});
    json!({
        "name": NAME,
        "label": "Plugins",
        "description": "See and add plugins: connectors (services Hexbot supports), MCP servers, skills, built-in tools such as the browser, and packages. list shows every plugin and whether it is on for you; ids look like skill:pdf or package:github. install adds a package, an MCP server and the skills that explain it, or skills alone, and turns it on for you. enable turns a plugin on for you; disable turns it off. Installing and enabling always ask the user first. Read the mcp skill before installing an MCP server, and skill-create before writing skills. The primary bot, in its own chat, can pass bot to act for another bot, and remove a package for every bot.",
        "parameters": {
            "type": "object",
            "properties": {
                "action": { "type": "string", "enum": ["list", "install", "enable", "disable", "remove"] },
                "id": { "type": "string", "description": "With enable, disable or remove: the plugin's id from list" },
                "bot": { "type": "string", "description": "Primary bot only: the bot to act for. Defaults to you." },
                "name": { "type": "string", "description": "With install: the package's name, lowercase letters, digits, - or _" },
                "description": { "type": "string", "description": "With install: what the package is for, in one line" },
                "mcp": {
                    "type": "object",
                    "description": "With install: the MCP server. Either command and args for a server run on this computer, with env for its environment, or url for a streamable HTTP server, with headers. Leave secret values empty; the user fills them in.",
                    "properties": {
                        "command": { "type": "string" },
                        "args": strings,
                        "env": { "type": "object", "additionalProperties": { "type": "string" } },
                        "url": { "type": "string" },
                        "headers": { "type": "object", "additionalProperties": { "type": "string" } }
                    }
                },
                "skills": {
                    "type": "array",
                    "description": "With install: skills that come with the package, each a SKILL.md with YAML frontmatter holding a description",
                    "items": {
                        "type": "object",
                        "properties": {
                            "name": { "type": "string" },
                            "content": { "type": "string" }
                        },
                        "required": ["name", "content"]
                    }
                }
            },
            "required": ["action"]
        }
    })
}

/// `kind:id` as the bot sees it, split back.
fn split(id: &str) -> Result<(&str, &str)> {
    id.split_once(':')
        .filter(|(kind, _)| SECTIONS.iter().any(|(_, k)| k == kind))
        .ok_or_else(|| {
            Error::new(
                4202,
                format!("unknown plugin id: {id}. Use an id from list."),
            )
        })
}

fn bots_of(row: &Value) -> Vec<String> {
    row["bots"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|b| b.as_str().map(str::to_owned))
        .collect()
}

impl Runtime {
    pub(super) async fn plugins_tool(&self, s: &Live, args: &Value) -> Result<Value> {
        if !s.tools.iter().any(|t| t["name"] == NAME) {
            return Err(Error::new(4210, "This tool is disabled for this section."));
        }
        // The primary bot looks after other bots from its own chat only, like
        // its other tools; in a room or a job it is a bot like any other.
        let primary = crate::catalog::primary_bot(&self.home, &s.owner)?.as_deref()
            == Some(s.bot.as_str())
            && !self.session_settings(s)?["job"].is_string()
            && shows_visuals(&self.home, &s.stored)?;
        let target = match args["bot"].as_str().filter(|b| !b.is_empty()) {
            Some(bot) if bot != s.bot => {
                if !primary {
                    return Err(Error::new(
                        4210,
                        "Only the primary bot manages plugins for other bots, from its own chat. Ask the user, or the primary bot.",
                    ));
                }
                common::bot_owner(&self.home, &s.owner, bot)?;
                bot.to_owned()
            }
            _ => s.bot.clone(),
        };
        let own = target == s.bot;
        let whom = self.bot_label(&target);
        let owner = s.owner.as_str();
        let action = required(args, "action")?;
        match action {
            "list" => self.plugin_list(owner, &target, primary),
            "install" => {
                let package = crate::plugins::parse(args)?;
                // The daemon fills `${NAME}` from stored keys when a server
                // starts. A bot's server gets only what the card shows.
                if package
                    .server
                    .as_ref()
                    .is_some_and(|server| server.to_string().contains("${"))
                {
                    return Err(Error::new(
                        4202,
                        "A plugin you install can't refer to stored keys with ${…}. Leave the value empty; the user fills it in Settings, Plugins.",
                    ));
                }
                self.ask_plugin(
                    s,
                    format!(
                        "Install the plugin {} for {whom}: it {}",
                        package.name,
                        package.summary()
                    ),
                    args,
                )
                .await?;
                crate::plugins::install(
                    &self.home,
                    owner,
                    &package,
                    Some(&s.bot),
                    Some(std::slice::from_ref(&target)),
                )?;
                self.plugins_changed(owner);
                let plugin = crate::plugins::find_for(
                    &self.home,
                    owner,
                    "package",
                    &package.name,
                    Some(&target),
                )?;
                Ok(json!({
                    "plugin": format!("package:{}", package.name),
                    "on": plugin["enabled_for_bot"],
                    "note": after_change(&plugin, own, &package.skills.iter().map(|(n, _)| n.clone()).collect::<Vec<_>>()),
                }))
            }
            "enable" | "disable" => {
                let full = required(args, "id")?;
                let (kind, id) = split(full)?;
                let on = action == "enable";
                let plugin = crate::plugins::find(&self.home, owner, kind, id)?;
                let was = bots_of(&plugin).contains(&target);
                // A package counts as on when any part is, so only other kinds
                // can be fully on already; a disable always runs.
                if on && was && kind != "package" {
                    return Ok(json!({"plugin": full, "on": true, "note": "Already on."}));
                }
                // Turning one off for yourself takes nothing new; everything else asks.
                if on || !own {
                    let verb = if on { "Turn on" } else { "Turn off" };
                    self.ask_plugin(
                        s,
                        format!(
                            "{verb} the plugin {} for {whom}",
                            plugin["name"].as_str().unwrap_or(id)
                        ),
                        args,
                    )
                    .await?;
                }
                // Read again after the user answered: only this bot changes.
                crate::plugins::set_for_bot(&self.home, owner, kind, id, &target, on)?;
                self.plugins_changed(owner);
                let plugin = crate::plugins::find_for(&self.home, owner, kind, id, Some(&target))?;
                let skills = plugin["skills"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|s| s["name"].as_str().map(str::to_owned))
                    .chain((kind == "skill").then(|| id.to_owned()))
                    .collect::<Vec<_>>();
                Ok(json!({
                    "plugin": full,
                    "on": on,
                    "note": if on { after_change(&plugin, own, &skills) } else { "Off from the next message.".into() },
                }))
            }
            "remove" => {
                if !primary {
                    return Err(Error::new(
                        4210,
                        "Only the primary bot removes plugins, from its own chat. Use disable to turn one off for you.",
                    ));
                }
                let full = required(args, "id")?;
                let (kind, id) = split(full)?;
                if kind != "package" {
                    return Err(Error::new(
                        4202,
                        "Only packages are removed here. Ask the user to remove other plugins in Settings, Plugins.",
                    ));
                }
                let plugin = crate::plugins::find(&self.home, owner, kind, id)?;
                self.ask_plugin(
                    s,
                    format!(
                        "Remove the plugin {} for every bot",
                        plugin["name"].as_str().unwrap_or(id)
                    ),
                    args,
                )
                .await?;
                crate::plugins::remove(&self.home, id)?;
                crate::connectors::drop_sessions(&self.home, id).await;
                self.plugins_changed(owner);
                Ok(json!({"removed": full}))
            }
            other => Err(Error::new(
                4202,
                format!("unknown action for {NAME}: {other}"),
            )),
        }
    }

    /// Every plugin as a bot reads it: no keys, values, addresses or other
    /// bots' state unless it looks after them.
    fn plugin_list(&self, owner: &str, bot: &str, every_bot: bool) -> Result<Value> {
        let listed = crate::plugins::list(&self.home, owner, Some(bot))?;
        let config = common::read_config(&self.home)?;
        let mut plugins = vec![];
        for (section, kind) in SECTIONS {
            for p in listed[*section].as_array().into_iter().flatten() {
                let id = p["id"].as_str().unwrap_or("");
                // Only what was written as a description: a server without
                // one would show its address or command line, which can hold a token.
                let description = match id.strip_prefix("mcp:") {
                    Some(server) => config["mcp_servers"][server]["description"].clone(),
                    None => p["description"].clone(),
                };
                let mut row = json!({
                    "id": format!("{kind}:{id}"),
                    "name": p["name"],
                    "description": description.as_str().unwrap_or(""),
                    "on": bots_of(p).iter().any(|b| b == bot),
                    "ready": p["ready"] != false,
                });
                if let Some(text) = p["state_text"].as_str().or(p["setup"].as_str()) {
                    row["state"] = json!(text);
                }
                if let Some(skills) = p["skills"].as_array() {
                    row["skills"] =
                        json!(skills.iter().map(|s| s["name"].clone()).collect::<Vec<_>>());
                }
                if every_bot {
                    row["bots"] = p["bots"].clone();
                }
                plugins.push(row);
            }
        }
        let mut out = json!({"plugins": plugins});
        if every_bot {
            out["bots"] = json!(
                db::open(&self.home)?
                    .prepare("SELECT name FROM bots WHERE owner_id=? ORDER BY name")?
                    .query_map([owner], |r| r.get::<_, String>(0))?
                    .collect::<std::result::Result<Vec<_>, _>>()?
            );
        }
        Ok(out)
    }

    async fn ask_plugin(&self, s: &Live, title: String, args: &Value) -> Result<()> {
        let request = json!({"tool":NAME,"toolCall":{"title":title},"input":args,"reason":"Adding or changing a plugin always asks."});
        if !self.ask_approval(s, request, true).await? {
            return Err(Error::new(
                4302,
                "The user said no. Leave it, and ask what they would like instead.",
            ));
        }
        Ok(())
    }

    /// Settings, the bot lists and skill lists all show plugins.
    fn plugins_changed(&self, owner: &str) {
        for event in [
            "hexbot.connectors.changed",
            "hexbot.skills.changed",
            "hexbot.bots.changed",
        ] {
            self.events.emit(owner, None, event, json!({}));
        }
    }
}

/// What the bot should know once a plugin is on.
fn after_change(plugin: &Value, own: bool, skills: &[String]) -> String {
    let mut note = if own {
        "On for you. New tools reach you from your next message.".to_owned()
    } else {
        "On for that bot from its next message.".to_owned()
    };
    if own && !skills.is_empty() {
        note.push_str(&format!(" Read {} with skill_view now.", skills.join(", ")));
    }
    if plugin["state"] == "not_set_up" {
        note.push_str(&format!(
            " It is not ready yet ({}): ask the user to finish it in Settings, Plugins, {}.",
            plugin["state_text"].as_str().unwrap_or("needs setup"),
            plugin["name"].as_str().unwrap_or("")
        ));
    }
    note
}
