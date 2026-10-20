//! The primary bot's tools. Each one calls the daemon method the app uses, as
//! the section's owner, so validation, change events and clean-up stay the
//! same. Deleting, changing a bot's or room's approval mode or a bot's
//! working folder, and changing settings ask the user every time, even in Bypass.
use super::*;

/// The tools a primary bot gets in its own sections, never in rooms, threads,
/// scheduled jobs or delegates.
pub(super) const TOOL_NAMES: &[&str] = &[
    "hexbot_bots",
    "hexbot_rooms",
    "hexbot_jobs",
    "hexbot_settings",
];

/// What the primary bot's sections add to the prompt, after the Hexbot guidance.
pub(super) const GUIDANCE: &str = r###"

# Primary bot
You are the user's primary bot. Besides your own work, you look after their Hexbot:
- hexbot_bots lists, creates, changes and deletes their bots. Check the list before creating one. Give a new bot a clear purpose, a soul written for that purpose, and only the tools it needs. When you change another bot's soul, tell the user what you changed.
- hexbot_rooms creates rooms and manages who is in them.
- hexbot_jobs schedules work for any of their bots.
- hexbot_settings reads and changes Hexbot's settings, skills and connectors.
Deleting a bot, room or job, changing a bot's or room's approval mode or a bot's or job's working folder, and changing settings always ask the user first. Do the rest when the user asks. You never see or set API keys or connector credentials; tell the user to add them in Settings.
These tools work only in your own sections."###;

const BOT_FIELDS: &[&str] = &[
    "name",
    "display_name",
    "title",
    "description",
    "persona",
    "provider",
    "model",
    "reasoning_effort",
    "tools",
    "skills",
    "approval_mode",
    "workdir",
    "dream_enabled",
    "notify",
];
const JOB_FIELDS: &[&str] = &[
    "action",
    "job_id",
    "prompt",
    "schedule",
    "name",
    "repeat",
    "include_disabled",
    "skills",
    "enabled_toolsets",
    "workdir",
    "reasoning_effort",
];
const ROOM_FIELDS: &[&str] = &["id", "name", "members", "main_bot", "approval_mode"];
/// Daemon settings the primary bot may change. Network, service and billing
/// settings stay with the user.
const SETTINGS: &[&str] = &[
    "approval_mode",
    "default_model",
    "fallback_model",
    "workspace_dir",
    "dream_enabled",
    "dream_time",
    "room_bot_turns_per_human_turn",
    "room_budget_tokens_per_human_turn",
    "bot_daily_token_budget",
];

pub(super) fn descriptors() -> Vec<Value> {
    let strings = json!({"type":"array","items":{"type":"string"}});
    vec![
        json!({
            "name": "hexbot_bots",
            "label": "Bots",
            "description": "List, read, create, change and delete the user's bots. get returns a bot's soul. create needs name (lowercase letters, digits, - or _) and display_name. update changes only the fields given; tools and skills replace the whole list. Deleting a bot, or setting approval_mode or workdir, asks the user first.",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": { "type": "string", "enum": ["list", "get", "create", "update", "delete"] },
                    "name": { "type": "string", "description": "The bot's handle" },
                    "display_name": { "type": "string" },
                    "title": { "type": "string", "description": "A few words on what the bot is for" },
                    "description": { "type": "string" },
                    "persona": { "type": "string", "description": "The bot's soul, complete" },
                    "provider": { "type": "string" },
                    "model": { "type": "string" },
                    "reasoning_effort": { "type": "string", "description": "An empty string returns to the model's default" },
                    "tools": { "type": "array", "items": { "type": "string", "enum": ["terminal", "files", "code_execution", "browser", "computer_use", "vision", "voice", "message_bots", "delegate", "scheduling"] } },
                    "skills": strings,
                    "approval_mode": { "type": "string", "enum": ["inherit", "manual", "smart", "off"], "description": "inherit follows Settings; smart is Auto; off is Bypass" },
                    "workdir": { "type": "string", "description": "A folder on this computer; an empty string returns the bot to the Settings workspace" },
                    "dream_enabled": { "type": "boolean" },
                    "notify": { "type": "boolean" }
                },
                "required": ["action"]
            }
        }),
        json!({
            "name": "hexbot_rooms",
            "label": "Rooms",
            "description": "List, read, create and change the user's rooms. create needs name and members (bot handles). Removing a room's last bot deletes the room. Deleting a room, or setting its approval_mode, asks the user first.",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": { "type": "string", "enum": ["list", "get", "create", "update", "add_member", "remove_member", "archive", "unarchive", "delete"] },
                    "id": { "type": "string", "description": "The room's id" },
                    "name": { "type": "string" },
                    "members": strings,
                    "main_bot": { "type": "string", "description": "The bot that answers when nobody is mentioned; an empty string removes it" },
                    "bot": { "type": "string", "description": "With add_member and remove_member" },
                    "approval_mode": { "type": "string", "enum": ["inherit", "manual", "smart", "off"], "description": "inherit follows each bot and Settings; smart is Auto; off is Bypass" },
                    "include_archived": { "type": "boolean" }
                },
                "required": ["action"]
            }
        }),
        json!({
            "name": "hexbot_jobs",
            "label": "Scheduled jobs",
            "description": "Create and manage scheduled jobs for any of the user's bots. Actions: create, list, update, pause, resume, remove, run. Each job runs as that bot in a fresh session and saves its output locally. Removing a job, or setting its workdir, asks the user first.",
            "parameters": {
                "type": "object",
                "properties": {
                    "bot": { "type": "string", "description": "The bot whose jobs these are" },
                    "action": { "type": "string", "enum": ["create", "list", "update", "pause", "resume", "remove", "run"] },
                    "job_id": { "type": "string" },
                    "prompt": { "type": "string" },
                    "schedule": { "type": "string" },
                    "name": { "type": "string" },
                    "repeat": { "type": "integer", "minimum": 0, "description": "How many times it runs; 0 removes the limit" },
                    "include_disabled": { "type": "boolean" },
                    "skills": strings,
                    "enabled_toolsets": strings,
                    "workdir": { "type": "string" },
                    "reasoning_effort": { "type": "string" }
                },
                "required": ["bot", "action"]
            }
        }),
        json!({
            "name": "hexbot_settings",
            "label": "Settings",
            "description": "Read and change Hexbot's settings. get returns them. set changes settings given in patch. skill turns an installed skill on or off in Settings, Skills; a bot that turned it off in its own settings keeps it off, so use hexbot_bots update skills for one bot. connector turns a connector that is already set up on or off for one bot. Every change asks the user first.",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": { "type": "string", "enum": ["get", "set", "skill", "connector"] },
                    "patch": {
                        "type": "object",
                        "description": "With set: approval_mode (manual, smart or off), default_model and fallback_model (provider/model), workspace_dir, dream_enabled, dream_time (HH:MM), room_bot_turns_per_human_turn, room_budget_tokens_per_human_turn, bot_daily_token_budget"
                    },
                    "name": { "type": "string", "description": "With skill: the skill's name" },
                    "id": { "type": "string", "description": "With connector: the connector's id" },
                    "bot": { "type": "string", "description": "With connector: the bot" },
                    "enabled": { "type": "boolean" }
                },
                "required": ["action"]
            }
        }),
    ]
}

fn pick(args: &Value, keys: &[&str]) -> Value {
    let mut out = json!({});
    for key in keys {
        if let Some(value) = args.get(*key) {
            out[*key] = value.clone();
        }
    }
    out
}

/// A bot as the primary bot reads it: no image data or section previews.
fn compact_bot(bot: &Value, soul: bool) -> Value {
    let mut out = pick(
        bot,
        &[
            "name",
            "display_name",
            "title",
            "description",
            "primary",
            "provider",
            "model",
            "reasoning_effort",
            "tools",
            "available_tools",
            "skills",
            "approval_mode",
            "workdir",
            "dream_enabled",
            "notify",
            "status",
        ],
    );
    if soul {
        out["persona"] = bot["persona"].clone();
    }
    out
}

impl Runtime {
    /// Called once the App exists, and again when it moves to another address.
    pub fn set_dispatcher(&self, app: Weak<crate::server::App>) {
        *self.dispatcher.lock().unwrap() = Some(app);
    }

    /// Runs a daemon method through the App, the same way a client would.
    fn dispatch<'a>(
        &self,
        owner: &'a str,
        method: &'a str,
        params: Value,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Value>> + Send + 'a>> {
        let app = self
            .dispatcher
            .lock()
            .unwrap()
            .as_ref()
            .and_then(Weak::upgrade);
        Box::pin(async move {
            let app = app.ok_or_else(|| Error::new(5201, "daemon is stopping"))?;
            app.call(owner, method, &params).await
        })
    }

    pub(super) async fn confirm(
        &self,
        s: &Live,
        tool: &str,
        title: String,
        args: &Value,
    ) -> Result<()> {
        let request = json!({"tool":tool,"toolCall":{"title":title},"input":args,"reason":"The primary bot always asks before this."});
        if !self.ask_approval(s, request, true).await? {
            return Err(Error::new(4302, "The user denied this action."));
        }
        Ok(())
    }

    pub(super) async fn primary_tool(&self, s: &Live, name: &str, args: &Value) -> Result<Value> {
        // The tools are frozen into the primary bot's own sections only; a
        // job or a delegate never gets them, but refuse here too.
        let settings = self.session_settings(s)?;
        if !s.tools.iter().any(|t| t["name"] == name)
            || settings["job"].is_string()
            || !shows_visuals(&self.home, &s.stored)?
        {
            return Err(Error::new(4210, "This tool is disabled for this section."));
        }
        let owner = s.owner.as_str();
        let action = required(args, "action")?;
        match (name, action) {
            ("hexbot_bots", "list") => {
                let result = self.dispatch(owner, "hexbot.bots.list", json!({})).await?;
                let bots = result["bots"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|b| compact_bot(b, false))
                    .collect::<Vec<_>>();
                Ok(json!({"bots":bots}))
            }
            ("hexbot_bots", "get") => {
                let result = self
                    .dispatch(
                        owner,
                        "hexbot.bots.get",
                        json!({"name":required(args,"name")?}),
                    )
                    .await?;
                Ok(json!({"bot":compact_bot(&result["bot"], true)}))
            }
            ("hexbot_bots", "create" | "update") => {
                let mut patch = pick(args, BOT_FIELDS);
                required(&patch, "name")?;
                // Schemas stay plain strings for every provider; empty clears the override.
                for key in ["workdir", "reasoning_effort"] {
                    if patch[key].as_str().is_some_and(|v| v.trim().is_empty()) {
                        patch[key] = Value::Null;
                    }
                }
                if ["approval_mode", "workdir"]
                    .iter()
                    .any(|k| patch.get(*k).is_some())
                {
                    let target = patch["name"].as_str().unwrap_or("");
                    let mut changes = vec![];
                    if let Some(mode) = patch["approval_mode"].as_str() {
                        changes.push(format!("approval mode to {}", approval_label(mode)));
                    }
                    if patch.get("workdir").is_some() {
                        changes.push(format!(
                            "working folder to {}",
                            patch["workdir"]
                                .as_str()
                                .unwrap_or("the Settings workspace")
                        ));
                    }
                    let verb = if action == "create" {
                        "Create"
                    } else {
                        "Change"
                    };
                    self.confirm(
                        s,
                        name,
                        format!("{verb} {target}: set {}", changes.join(" and ")),
                        args,
                    )
                    .await?;
                }
                let method = if action == "create" {
                    "hexbot.bots.create"
                } else {
                    "hexbot.bots.update"
                };
                let result = self.dispatch(owner, method, patch).await?;
                Ok(json!({"bot":compact_bot(&result["bot"], false)}))
            }
            ("hexbot_bots", "delete") => {
                let target = required(args, "name")?;
                crate::catalog::check_deletable(&self.home, owner, target)?;
                self.confirm(
                    s,
                    name,
                    format!("Delete the bot {target} and all its sections"),
                    args,
                )
                .await?;
                self.dispatch(owner, "hexbot.bots.delete", json!({"name":target}))
                    .await
            }
            ("hexbot_rooms", "list") => {
                self.dispatch(
                    owner,
                    "hexbot.rooms.list",
                    json!({"include_archived":args["include_archived"] == true}),
                )
                .await
            }
            ("hexbot_rooms", "get" | "archive" | "unarchive") => {
                let method = format!("hexbot.rooms.{action}");
                self.dispatch(owner, &method, json!({"id":required(args,"id")?}))
                    .await
            }
            ("hexbot_rooms", "create" | "update") => {
                let mut patch = pick(args, ROOM_FIELDS);
                if patch["main_bot"]
                    .as_str()
                    .is_some_and(|b| b.trim().is_empty())
                {
                    patch["main_bot"] = Value::Null;
                }
                if action == "create" {
                    patch.as_object_mut().unwrap().remove("id");
                } else {
                    required(&patch, "id")?;
                    patch.as_object_mut().unwrap().remove("members");
                }
                // A room's mode governs every bot's sandbox in it, so it asks like a bot's.
                if let Some(mode) = patch["approval_mode"].as_str() {
                    let title = patch["name"]
                        .as_str()
                        .or(patch["id"].as_str())
                        .unwrap_or("the room");
                    let verb = if action == "create" {
                        "Create"
                    } else {
                        "Change"
                    };
                    self.confirm(
                        s,
                        name,
                        format!(
                            "{verb} {title}: set approval mode to {}",
                            approval_label(mode)
                        ),
                        args,
                    )
                    .await?;
                }
                let method = format!("hexbot.rooms.{action}");
                self.dispatch(owner, &method, patch).await
            }
            ("hexbot_rooms", "add_member") => {
                let room = required(args, "id")?;
                let bot = required(args, "bot")?;
                self.dispatch(
                    owner,
                    "hexbot.rooms.add_member",
                    json!({"id":room,"bot":bot}),
                )
                .await
            }
            ("hexbot_rooms", "remove_member") => {
                let room = required(args, "id")?;
                let bot = required(args, "bot")?;
                // The daemon refuses to empty the room in the same statement
                // that removes the bot, so only a removal that deletes it asks.
                let kept = self
                    .dispatch(
                        owner,
                        "hexbot.rooms.remove_member",
                        json!({"id":room,"bot":bot,"keep_room":true}),
                    )
                    .await;
                match kept {
                    Err(error) if error.code == crate::rooms::LAST_BOT => {
                        let current = crate::rooms::get(&self.home, owner, room)?;
                        let title = current["name"].as_str().unwrap_or(room);
                        self.confirm(
                            s,
                            name,
                            format!("Remove {bot}, the last bot, and delete the room {title}"),
                            args,
                        )
                        .await?;
                        self.dispatch(
                            owner,
                            "hexbot.rooms.remove_member",
                            json!({"id":room,"bot":bot}),
                        )
                        .await
                    }
                    other => other,
                }
            }
            ("hexbot_rooms", "delete") => {
                let room = required(args, "id")?;
                let current = crate::rooms::get(&self.home, owner, room)?;
                let title = current["name"].as_str().unwrap_or(room);
                self.confirm(
                    s,
                    name,
                    format!("Delete the room {title} and its history"),
                    args,
                )
                .await?;
                self.dispatch(owner, "hexbot.rooms.delete", json!({"id":room}))
                    .await
            }
            ("hexbot_jobs", _) => {
                let bot = required(args, "bot")?;
                common::bot_owner(&self.home, owner, bot)?;
                if action == "remove" {
                    let job = required(args, "job_id")?;
                    self.confirm(s, name, format!("Remove {bot}'s scheduled job {job}"), args)
                        .await?;
                }
                if ![
                    "create", "list", "update", "pause", "resume", "remove", "run",
                ]
                .contains(&action)
                {
                    return Err(Error::new(
                        4202,
                        format!("unknown action for {name}: {action}"),
                    ));
                }
                // Scripts and monitors stay with the bot's own cronjob_manage.
                // The jobs method tells paired clients the jobs changed.
                let mut job = pick(args, JOB_FIELDS);
                job.as_object_mut().unwrap().remove("action");
                // An unattended job's folder is where its tools work, so it asks like a bot's.
                // Clearing it moves the job too, so any folder asks.
                if matches!(action, "create" | "update")
                    && let Some(folder) = job_folder(&job)
                {
                    self.confirm(
                        s,
                        name,
                        format!("Run {bot}'s scheduled job in {folder}"),
                        args,
                    )
                    .await?;
                }
                if job["repeat"] == 0 {
                    job["repeat"] = Value::Null;
                }
                job["bot"] = json!(bot);
                let method = format!("hexbot.jobs.{action}");
                self.dispatch(owner, &method, job).await
            }
            ("hexbot_settings", "get") => {
                self.dispatch(owner, "hexbot.settings.get", json!({})).await
            }
            ("hexbot_settings", "set") => {
                let patch = args["patch"]
                    .as_object()
                    .filter(|p| !p.is_empty())
                    .ok_or_else(|| Error::new(4200, "missing parameter: patch"))?;
                if let Some(key) = patch.keys().find(|k| !SETTINGS.contains(&k.as_str())) {
                    return Err(Error::new(
                        4201,
                        format!("{key} can only be changed by the user in Settings"),
                    ));
                }
                let summary = settings_summary(patch);
                self.confirm(s, name, format!("Change settings: {summary}"), args)
                    .await?;
                self.dispatch(owner, "hexbot.settings.set", json!({"patch":patch}))
                    .await
            }
            ("hexbot_settings", "skill") => {
                let skill = required(args, "name")?;
                let enabled = args["enabled"]
                    .as_bool()
                    .ok_or_else(|| Error::new(4200, "missing parameter: enabled"))?;
                let verb = if enabled { "Turn on" } else { "Turn off" };
                self.confirm(
                    s,
                    name,
                    format!("{verb} the skill {skill} in Settings"),
                    args,
                )
                .await?;
                self.dispatch(
                    owner,
                    "hexbot.skills.set_global",
                    json!({"name":skill,"enabled":enabled}),
                )
                .await
            }
            ("hexbot_settings", "connector") => {
                let id = required(args, "id")?;
                let bot = required(args, "bot")?;
                let enabled = args["enabled"]
                    .as_bool()
                    .ok_or_else(|| Error::new(4200, "missing parameter: enabled"))?;
                let verb = if enabled { "Turn on" } else { "Turn off" };
                self.confirm(
                    s,
                    name,
                    format!("{verb} the {id} connector for {bot}"),
                    args,
                )
                .await?;
                self.dispatch(
                    owner,
                    "hexbot.connectors.set_for_bot",
                    json!({"id":id,"bot":bot,"enabled":enabled}),
                )
                .await
            }
            _ => Err(Error::new(
                4202,
                format!("unknown action for {name}: {action}"),
            )),
        }
    }
}

/// The folder a job create or update moves the job to, if it names one;
/// an empty or null `workdir` is the Settings workspace.
pub(super) fn job_folder(args: &Value) -> Option<String> {
    let value = args.get("workdir")?;
    Some(
        value
            .as_str()
            .map(str::trim)
            .filter(|w| !w.is_empty())
            .unwrap_or("the Settings workspace")
            .to_owned(),
    )
}

/// What the approval card says a settings change does, in the words Settings uses.
fn settings_summary(patch: &serde_json::Map<String, Value>) -> String {
    patch
        .iter()
        .map(|(k, v)| {
            let value = match v {
                Value::String(mode) if k == "approval_mode" => approval_label(mode).to_owned(),
                Value::String(v) => v.clone(),
                Value::Bool(on) => if *on { "on" } else { "off" }.to_owned(),
                Value::Null => "none".to_owned(),
                v => v.to_string(),
            };
            format!("{} to {value}", setting_label(k))
        })
        .collect::<Vec<_>>()
        .join(", ")
}

/// A name from `SETTINGS` as the user reads it.
fn setting_label(key: &str) -> &str {
    match key {
        "approval_mode" => "approval mode",
        "default_model" => "default model",
        "fallback_model" => "fallback model",
        "workspace_dir" => "workspace folder",
        "dream_enabled" => "dreaming",
        "dream_time" => "dream time",
        "room_bot_turns_per_human_turn" => "bot turns per message in rooms",
        "room_budget_tokens_per_human_turn" => "token budget per message in rooms",
        "bot_daily_token_budget" => "daily token budget for each bot",
        other => other,
    }
}

fn approval_label(mode: &str) -> &str {
    match mode {
        "smart" => "Auto",
        "manual" => "Manual",
        "off" => "Bypass",
        "inherit" => "the Settings default",
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_changes_read_in_plain_words() {
        let patch = json!({"approval_mode":"off","dream_time":"04:30"});
        assert_eq!(
            settings_summary(patch.as_object().unwrap()),
            "approval mode to Bypass, dream time to 04:30"
        );
        let patch = json!({"dream_enabled":false,"fallback_model":null});
        assert_eq!(
            settings_summary(patch.as_object().unwrap()),
            "dreaming to off, fallback model to none"
        );
        for key in SETTINGS {
            assert_ne!(setting_label(key), *key);
        }
    }
}
