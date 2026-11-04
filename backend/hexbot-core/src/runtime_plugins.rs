//! `hexbot_plugins`: a bot sees the plugins and asks for one it lacks.
//! Installing a plugin or turning one on always asks the user, even in
//! Bypass, and a scheduled job or a check-in, which nobody watches, cannot.
//! A package a bot installs is on for that bot only. The primary bot, in its
//! own chat, does the same for any bot and removes packages.
//!
//! Each of these asks with a plugin card in the chat, which also takes the
//! keys a plugin still needs: what the user types there goes to the waiting
//! tool only and is saved as Settings, Plugins saves it. The bot never sees it.
use super::*;

pub(super) const NAME: &str = "hexbot_plugins";

/// The kinds `hexbot.plugins.list` returns, by the list each sits in.
const SECTIONS: &[(&str, &str)] = &[
    ("connectors", "connector"),
    ("skills", "skill"),
    ("packages", "package"),
];

pub(super) fn descriptor() -> Value {
    let strings = json!({"type":"array","items":{"type":"string"}});
    json!({
        "name": NAME,
        "label": "Plugins",
        "description": "See and add plugins: connectors (services Hexbot supports), MCP servers, skills, and packages. list shows every plugin and whether it is on for you; ids look like skill:pdf or package:github. install adds a package, an MCP server and the skills that explain it, or skills alone, and turns it on for you once its keys are filled in. enable turns a plugin on for you; disable turns it off. Installing and enabling always show the user a card to approve first, where they can also enter the keys the plugin needs. setup shows the user a card to enter a plugin's keys, such as an API key or token: when a plugin is not ready, call setup straight away, without asking first. What the user types is saved for their bots and never reaches you. Never ask the user to paste a key in the chat. Read the mcp skill before installing an MCP server, and skill-create before writing skills. The primary bot, in its own chat, can pass bot to act for another bot, and remove a package for every bot.",
        "parameters": {
            "type": "object",
            "properties": {
                "action": { "type": "string", "enum": ["list", "install", "enable", "setup", "disable", "remove"] },
                "id": { "type": "string", "description": "With enable, setup, disable or remove: the plugin's id from list" },
                "bot": { "type": "string", "description": "Primary bot only: the bot to act for. Defaults to you." },
                "name": { "type": "string", "description": "With install: the package's name, lowercase letters, digits, - or _" },
                "description": { "type": "string", "description": "With install: what the package is for, in one line" },
                "mcp": {
                    "type": "object",
                    "description": "With install: the MCP server. Either command and args for a server run on this computer, with env for its environment, or url for a streamable HTTP server, with headers. Leave secret values empty; the user fills them in on the card.",
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
                let full = format!("package:{}", package.name);
                let form = json!({
                    "kind": "plugin",
                    "action": "install",
                    "id": full,
                    "name": package.name,
                    "description": package.description,
                    "bot": whom,
                    "other": !own,
                    "detail": package.summary(),
                    "run": package.server.as_ref().map(runs).unwrap_or_default(),
                    "fields": package.server.as_ref().map(|server| server_fields(server, false)).unwrap_or_default(),
                });
                let answer = self
                    .ask_card(
                        s,
                        format!(
                            "Install the plugin {} for {whom}: it {}",
                            package.name,
                            package.summary()
                        ),
                        form.clone(),
                    )
                    .await?;
                crate::plugins::install(
                    &self.home,
                    owner,
                    &package,
                    Some(&s.bot),
                    Some(std::slice::from_ref(&target)),
                )?;
                self.save_keys(owner, &target, &form, &answer).await?;
                self.plugins_changed(owner);
                let plugin = crate::plugins::find_for(
                    &self.home,
                    owner,
                    "package",
                    &package.name,
                    Some(&target),
                )?;
                Ok(json!({
                    "plugin": full,
                    "on": plugin["enabled_for_bot"],
                    "note": after_change(&plugin, &full, own, &package.skills.iter().map(|(n, _)| n.clone()).collect::<Vec<_>>()),
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
                let title = format!(
                    "{} the plugin {} for {whom}",
                    if on { "Turn on" } else { "Turn off" },
                    plugin["name"].as_str().unwrap_or(id)
                );
                // Turning one on asks with its card, which takes the keys it
                // still needs. Turning one off for yourself takes nothing new.
                if on {
                    let mut form = self.plugin_form(owner, &target, &whom, full, "enable")?;
                    form["other"] = json!(!own);
                    let answer = self.ask_card(s, title, form.clone()).await?;
                    self.save_keys(owner, &target, &form, &answer).await?;
                } else if !own {
                    self.ask_plugin(s, title, args).await?;
                }
                // Read again after the user answered: only this bot changes.
                // A plugin still missing its keys reaches no bot yet.
                crate::plugins::set_for_bot(&self.home, owner, kind, id, &target, on).map_err(
                    |e| match e.code {
                        4209 => Error::new(
                            4209,
                            format!("{} Call setup with id {full}, so the user can finish it on a card.", e.message),
                        ),
                        _ => e,
                    },
                )?;
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
                    "note": if on { after_change(&plugin, full, own, &skills) } else { "Off from the next message.".into() },
                }))
            }
            "setup" => {
                let full = required(args, "id")?;
                let (kind, id) = split(full)?;
                let settings = self.session_settings(s)?;
                let mut form = self.plugin_form(owner, &target, &whom, full, "setup")?;
                form["other"] = json!(!own);
                let name = form["name"].as_str().unwrap_or(id).to_owned();
                if form["fields"].as_array().is_none_or(Vec::is_empty) {
                    return Err(Error::new(
                        4202,
                        format!(
                            "{name} has nothing to fill in. If it still fails, ask the user to check it in Settings, Plugins."
                        ),
                    ));
                }
                if settings["canAsk"] == false || settings["job"].is_string() {
                    return Err(Error::new(
                        4302,
                        format!(
                            "Nobody can answer a card here. Tell the user to finish {name} in Settings, Plugins."
                        ),
                    ));
                }
                let answer = self
                    .ask_card(s, format!("Set up {name}"), form.clone())
                    .await?;
                let test = self.save_keys(owner, &target, &form, &answer).await?;
                self.plugins_changed(owner);
                let plugin = crate::plugins::find_for(&self.home, owner, kind, id, Some(&target))?;
                let note = match test.as_ref().filter(|t| t["ok"] != true) {
                    Some(test) => format!(
                        "Saved, but the test failed: {}. Tell the user, and call setup again if they want to fix it.",
                        test["message"].as_str().unwrap_or("no reply")
                    ),
                    None if plugin["enabled_for_bot"] != true => {
                        format!("Set up. It is off for {whom}: call enable to turn it on.")
                    }
                    None if server(kind, id).is_some() => {
                        "Set up. Its tools reach you from your next message.".into()
                    }
                    None => "Set up. Try it now.".into(),
                };
                Ok(
                    json!({"plugin": full, "ready": test.is_none_or(|t| t["ok"] == true), "note": note}),
                )
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
    pub(super) fn plugin_list(&self, owner: &str, bot: &str, every_bot: bool) -> Result<Value> {
        let listed = crate::plugins::list(&self.home, owner, Some(bot))?;
        let config = common::read_config(&self.home)?;
        let mut plugins = vec![];
        for (section, kind) in SECTIONS {
            // A bot's own private skills are its to manage with skill_manage.
            for p in listed[*section]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|p| p["source"] != "bot")
            {
                let id = p["id"].as_str().unwrap_or("");
                // Only what was written as a description: a server without
                // one would show its address or command line, which can hold a token.
                let description = match id.strip_prefix("mcp:") {
                    Some(server) => config["mcp_servers"][server]["description"].clone(),
                    None => p["description"].clone(),
                };
                // Ready for this bot: a package of skills can be, through its own `.env`.
                let ready = p["ready"] != false
                    || p["ready_bots"]
                        .as_array()
                        .is_some_and(|bots| bots.iter().any(|b| b == bot));
                let mut row = json!({
                    "id": format!("{kind}:{id}"),
                    "name": p["name"],
                    "description": description.as_str().unwrap_or(""),
                    "on": bots_of(p).iter().any(|b| b == bot),
                    "ready": ready,
                });
                if let Some(text) = p["state_text"]
                    .as_str()
                    .or(p["setup"].as_str())
                    .filter(|_| !ready || p["ready"] != false)
                {
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

    /// The card for a plugin that exists: what it is, and with setup, or
    /// when it is not ready, the keys the user can enter on it.
    fn plugin_form(
        &self,
        owner: &str,
        bot: &str,
        whom: &str,
        full: &str,
        action: &str,
    ) -> Result<Value> {
        let (kind, id) = split(full)?;
        let setup = action == "setup";
        let plugin = crate::plugins::find_for(&self.home, owner, kind, id, Some(bot))?;
        let config = common::read_config(&self.home)?;
        let mut form = json!({
            "kind": "plugin",
            "action": action,
            "id": full,
            "name": plugin["name"].as_str().unwrap_or(id),
            "description": plugin["description"].as_str().unwrap_or(""),
            "icon": plugin["icon"],
            "bot": whom,
            "fields": [],
        });
        if let Some(name) = server(kind, id) {
            let entry = &config["mcp_servers"][name];
            // As list shows it: a server's own description only, never its address.
            form["description"] = json!(entry["description"].as_str().unwrap_or(""));
            form["fields"] = json!(server_fields(entry, setup));
        } else if kind == "connector" && (setup || plugin["ready"] == false) {
            let fields = plugin["fields"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|f| f["advanced"] != true)
                .map(|f| {
                    json!({
                        "key": f["key"],
                        "label": f["label"],
                        "help": f["help"],
                        "url": f["url"],
                        "secret": f["secret"],
                        "provider": f["provider"],
                        "set": f["set"],
                        "hint": f["hint"],
                    })
                })
                .collect::<Vec<_>>();
            if let Some(providers) = plugin["providers"].as_array() {
                form["providers"] = json!(
                    providers
                        .iter()
                        .map(|p| json!({"id": p["id"], "label": p["label"]}))
                        .collect::<Vec<_>>()
                );
                form["provider"] = match &plugin["provider"] {
                    Value::Null => providers.first().map_or(Value::Null, |p| p["id"].clone()),
                    chosen => chosen.clone(),
                };
            }
            form["fields"] = json!(fields);
        }
        Ok(form)
    }

    /// Shows a plugin card and waits for the user: the keys they entered
    /// and the provider they chose, as `answer` checked them.
    async fn ask_card(&self, s: &Live, title: String, form: Value) -> Result<Value> {
        let request = json!({
            "tool": NAME,
            "toolCall": {"title": title},
            "reason": "Adding or changing a plugin always asks. Keys you enter here are saved for your bots; the bot never sees them.",
            "form": form,
        });
        let Some(answer) = self.ask_native(s, request, true).await? else {
            return Err(Error::new(
                4302,
                "The user said no. Leave it, and ask what they would like instead.",
            ));
        };
        serde_json::from_str(&answer).map_err(|_| Error::new(5201, "The card sent no answer."))
    }

    /// Saves what the user entered on a card where Settings, Plugins saves
    /// it. With setup, tests the plugin and returns the test.
    async fn save_keys(
        &self,
        owner: &str,
        bot: &str,
        form: &Value,
        answer: &Value,
    ) -> Result<Option<Value>> {
        let (kind, id) = split(form["id"].as_str().unwrap_or(""))?;
        let setup = form["action"] == "setup";
        let values = answer["values"].as_object().cloned().unwrap_or_default();
        let fields = form["fields"].as_array().cloned().unwrap_or_default();
        // A provider chosen on the card counts as a change even with no new key.
        let chosen = answer["provider"] != form["provider"];
        if fields.is_empty() || (values.is_empty() && !setup && !chosen) {
            return Ok(None);
        }
        let Some(name) = server(kind, id) else {
            let result = crate::connectors::call(
                &self.home,
                owner,
                "hexbot.connectors.setup",
                &json!({
                    "id": id,
                    "values": values,
                    "provider": answer["provider"],
                    "bot": bot,
                    "enable_for_bot": false,
                }),
            )
            .await
            .expect("a connectors method")?;
            return Ok(Some(result["test"].clone()));
        };
        if !values.is_empty() {
            let mut change = json!({});
            for field in &fields {
                let key = field["key"].as_str().unwrap_or("");
                if let Some(value) = values.get(key) {
                    change[field["place"].as_str().unwrap_or("env")][key] = value.clone();
                }
            }
            crate::plugins::configure(&self.home, name, &change)?;
            crate::connectors::drop_sessions(&self.home, name).await;
        }
        if !setup {
            return Ok(None);
        }
        let test = crate::connectors::call(
            &self.home,
            owner,
            "hexbot.connectors.test",
            &json!({"id": format!("mcp:{name}"), "bot": bot}),
        )
        .await
        .expect("a connectors method")?;
        Ok(Some(test))
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

/// The MCP server behind a plugin id, if it has one.
fn server<'a>(kind: &str, id: &'a str) -> Option<&'a str> {
    match kind {
        "connector" => id.strip_prefix("mcp:"),
        "package" => Some(id),
        _ => None,
    }
}

/// What an installed server runs, as the card shows it: its command line or
/// address, then every value it is given that isn't left for the user.
fn runs(server: &Value) -> Vec<String> {
    let first = match server["url"].as_str() {
        Some(url) => url.to_owned(),
        None => std::iter::once(&server["command"])
            .chain(server["args"].as_array().into_iter().flatten())
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join(" "),
    };
    std::iter::once(first)
        .chain(
            [&server["env"], &server["headers"]]
                .into_iter()
                .flat_map(|v| v.as_object().into_iter().flatten())
                .filter_map(|(key, value)| {
                    value
                        .as_str()
                        .filter(|v| !v.is_empty())
                        .map(|v| format!("{key}={v}"))
                }),
        )
        .collect()
}

/// An MCP server's environment and headers as card fields: those still
/// empty, or with `every` and none empty, all of them.
fn server_fields(entry: &Value, every: bool) -> Vec<Value> {
    let fields = [("env", &entry["env"]), ("headers", &entry["headers"])]
        .into_iter()
        .flat_map(|(place, values)| {
            values
                .as_object()
                .into_iter()
                .flatten()
                .map(move |(key, value)| {
                    json!({
                        "key": key,
                        "label": key,
                        "place": place,
                        "secret": true,
                        "set": value.as_str().is_some_and(|v| !v.is_empty()),
                    })
                })
        })
        .collect::<Vec<_>>();
    let empty = fields
        .iter()
        .filter(|f| f["set"] == false)
        .cloned()
        .collect::<Vec<_>>();
    if empty.is_empty() && every {
        fields
    } else {
        empty
    }
}

/// What a plugin card answers, read from `approval.respond`: only the
/// card's own fields, for the chosen provider. With setup, a field that has
/// no saved value must be filled in. The values go to the waiting tool only.
pub(super) fn answer(form: &Value, p: &Value) -> Result<Value> {
    let providers = form["providers"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|p| p["id"].as_str())
        .collect::<Vec<_>>();
    let provider = p["provider"]
        .as_str()
        .filter(|p| !p.is_empty())
        .or(form["provider"].as_str());
    if !providers.is_empty() && !provider.is_some_and(|p| providers.contains(&p)) {
        return Err(Error::new(4202, "Choose a provider."));
    }
    let setup = form["action"] == "setup";
    let mut values = serde_json::Map::new();
    for field in form["fields"].as_array().into_iter().flatten() {
        if field["provider"].is_string() && field["provider"].as_str() != provider {
            continue;
        }
        let key = field["key"].as_str().unwrap_or("");
        let value = p["values"][key].as_str().unwrap_or("").trim();
        if value.len() > 4096 {
            return Err(Error::new(4202, "That value is too long."));
        }
        if !value.is_empty() {
            values.insert(key.to_owned(), json!(value));
        } else if setup && field["set"] != true {
            return Err(Error::new(
                4202,
                format!("Enter the {}.", field["label"].as_str().unwrap_or(key)),
            ));
        }
    }
    Ok(json!({"values": values, "provider": provider}))
}

/// What the bot should know once a plugin is on.
fn after_change(plugin: &Value, id: &str, own: bool, skills: &[String]) -> String {
    // Installed but waiting for a value: no bot has it until the user sets it up.
    // A bot whose own keys set it up already has it.
    let waiting = plugin["state"] == "not_set_up" && plugin["enabled_for_bot"] != true;
    // A package of skills alone has no card: what it needs is set up by hand.
    if waiting && plugin["kind"] == "package" && plugin["server"].is_null() {
        return format!(
            "Installed, not set up yet ({}). Ask the user to finish it in Settings, Plugins; {} from the next message after that.",
            plugin["state_text"].as_str().unwrap_or("needs setup"),
            if own {
                "it reaches you"
            } else {
                "it reaches that bot"
            }
        );
    }
    if waiting {
        return format!(
            "Installed, not set up yet ({}): call setup with id {id} now, so the user can finish it on a card. {} from the next message after that.",
            plugin["state_text"].as_str().unwrap_or("needs setup"),
            if own {
                "It reaches you"
            } else {
                "It reaches that bot"
            }
        );
    }
    let mut note = if own {
        "On for you. New tools reach you from your next message.".to_owned()
    } else {
        "On for that bot from its next message.".to_owned()
    };
    if own && !skills.is_empty() {
        note.push_str(&format!(" Read {} with skill_view now.", skills.join(", ")));
    }
    if plugin["state"] == "error" {
        note.push_str(&format!(
            " It is not ready yet ({}): call setup with id {id} now, so the user can finish it on a card.",
            plugin["state_text"].as_str().unwrap_or("needs setup"),
        ));
    }
    note
}
