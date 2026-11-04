//! `hexbot_passwords`: a bot uses the user's saved passwords, SSH keys and
//! API keys without ever reading one. It lists the items it may use, asks
//! the user for a new login or API key through a card in its chat, has the
//! daemon type a login's fields into a page, makes new SSH keys, and runs
//! commands on the bots' computer with SSH keys in an agent and API keys in
//! the environment. In the browser the page must be on the login's site; on
//! the bots' computer, where the daemon can't see the address or where a
//! command sends a key, filling and running ask the user unless the bot runs
//! in Bypass. The primary bot, in its own chat, also chooses which bots get
//! each item, renames and deletes them.
use super::*;

pub(super) const NAME: &str = "hexbot_passwords";

/// What a command runs with: API keys as (variable, key), SSH private keys.
type Keys = (Vec<(String, String)>, Vec<String>);

pub(super) fn descriptor() -> Value {
    json!({
        "name": NAME,
        "label": "Passwords",
        "description": "Use the user's saved passwords, SSH keys and API keys. You never see one: the daemon types or passes it for you. Never ask the user to type a password, code or key in the chat. list shows what you may use: each item's id, kind, title and site, a login's username, an SSH key's public key, an API key's variable. Logins: when a site needs a sign-in and none fits, call ask straight away, without asking first: it shows the user a secure card in your chat, and what they type is saved for all their bots and never reaches you. Pass id to ask for a new password for a login that stopped working. fill types a login's username, password or one-time code into fields on the bots' computer: give each field's coordinate from the latest screenshot. After filling, press the sign-in button yourself. SSH and API keys: run runs one shell command on the bots' computer with the keys in ids: each API key in its variable, each SSH key in an ssh-agent for that command only, so ssh and git use it. Key values are blanked from the output. For a host ssh hasn't seen, add -o StrictHostKeyChecking=accept-new. When you need an API key that isn't saved, call ask with kind api_key, the service's title, its variable and the page where the user gets one. generate makes a new SSH key and gives you its public key to add where it's needed, such as GitHub's SSH keys page. fill and run ask the user first, except in Bypass. The primary bot, in its own chat, can also share (choose which bots get an item; bots null means every bot), update (title, url, username, env) and delete.",
        "parameters": {
            "type": "object",
            "properties": {
                "action": { "type": "string", "enum": ["list", "ask", "fill", "run", "generate", "share", "update", "delete"] },
                "kind": { "type": "string", "enum": ["login", "api_key"], "description": "With ask: what to ask for; login when left out" },
                "id": { "type": "string", "description": "The item's id from list" },
                "ids": { "type": "array", "items": { "type": "string" }, "description": "With run: the SSH keys and API keys the command needs" },
                "command": { "type": "string", "description": "With run: the shell command; 30 s limit" },
                "title": { "type": "string", "description": "With ask, generate or update: the name people know, such as Schoology, OpenAI or GitHub" },
                "url": { "type": "string", "description": "With ask or update: the sign-in page's address, or for an API key the page where the user gets one" },
                "username": { "type": "string", "description": "With ask: a username to suggest; with update: the new username" },
                "env": { "type": "string", "description": "With ask or update for an API key: the environment variable it goes in, such as OPENAI_API_KEY" },
                "fields": {
                    "type": "array",
                    "description": "With fill: the fields to type into, in order",
                    "items": {
                        "type": "object",
                        "properties": {
                            "field": { "type": "string", "enum": ["username", "password", "code"] },
                            "coordinate": { "type": "array", "items": { "type": "integer" }, "minItems": 2, "maxItems": 2, "description": "The field's point in the latest computer screenshot" }
                        },
                        "required": ["field", "coordinate"]
                    }
                },
                "bots": {
                    "type": ["array", "null"],
                    "items": { "type": "string" },
                    "description": "With share: the bots that may use the item, or null for every bot"
                }
            },
            "required": ["action"]
        }
    })
}

/// What a bot reads about an item: never a secret.
fn listed(item: &Value, primary: bool) -> Value {
    use crate::passwords::Kind;
    let mut row = json!({
        "id": item["id"],
        "kind": item["kind"],
        "title": item["title"],
        "site": item["site"],
    });
    match Kind::of(item) {
        Kind::Login => {
            row["username"] = item["username"].clone();
            row["has_code"] = item["has_code"].clone();
        }
        Kind::SshKey => {
            row["public_key"] = item["public_key"].clone();
            row["fingerprint"] = item["fingerprint"].clone();
        }
        Kind::ApiKey => row["env"] = item["env"].clone(),
    }
    if primary {
        row["bots"] = item["bots"].clone();
    }
    row
}

/// A bot with a browser or the computer may use saved items, in its own
/// chat and its scheduled jobs; rooms and threads between bots never see them.
pub(super) fn offered(tools: &[Value], own: bool, overrides: Option<&Value>) -> bool {
    let job = overrides.is_some_and(|o| o["job"].is_string());
    let signs_in = tools.iter().any(|t| {
        t["name"]
            .as_str()
            .is_some_and(|n| n == "computer_use" || n == "browser_type")
    });
    signs_in && ((own && overrides.is_none()) || job)
}

impl Runtime {
    pub(super) async fn passwords_tool(&self, s: &Live, args: &Value) -> Result<Value> {
        if !s.tools.iter().any(|t| t["name"] == NAME) {
            return Err(Error::new(4210, "This tool is disabled for this section."));
        }
        let owner = s.owner.as_str();
        let settings = self.session_settings(s)?;
        let job = settings["job"].is_string();
        let primary = crate::catalog::primary_bot(&self.home, owner)?.as_deref()
            == Some(s.bot.as_str())
            && !job
            && shows_visuals(&self.home, &s.stored)?;
        let usable = |id: &str| -> Result<Value> {
            let login = crate::passwords::find(&self.home, owner, id)?;
            if !primary && !crate::passwords::allowed(&login, &s.bot) {
                return Err(Error::new(
                    4302,
                    "That login isn't shared with you. Use one from list, or ask the user.",
                ));
            }
            Ok(login)
        };
        match required(args, "action")? {
            "list" => {
                let items = crate::passwords::list(
                    &self.home,
                    owner,
                    (!primary).then_some(s.bot.as_str()),
                )?
                .iter()
                .map(|item| listed(item, primary))
                .collect::<Vec<_>>();
                let empty = items.is_empty();
                let mut out = json!({"items": items});
                if empty {
                    out["note"] = json!(
                        "Nothing saved. To sign in, call ask with the site's title and url now: the user types the password into a secure card. For an API key, call ask with kind api_key. Don't ask for either in the chat."
                    );
                }
                Ok(out)
            }
            "ask" => {
                if settings["canAsk"] == false || job {
                    return Err(Error::new(
                        4302,
                        "Nobody can answer a card here. Tell the user to save it in Settings, Passwords.",
                    ));
                }
                let kind = crate::passwords::Kind::parse(args["kind"].as_str().unwrap_or("login"))?;
                let existing = match args["id"].as_str().filter(|id| !id.is_empty()) {
                    Some(id) => Some(usable(id)?),
                    None => None,
                };
                if existing
                    .as_ref()
                    .is_some_and(|item| crate::passwords::Kind::of(item) != kind)
                {
                    return Err(Error::new(
                        4202,
                        "That id is another kind of item. Pass the kind it has, or leave out id.",
                    ));
                }
                match kind {
                    crate::passwords::Kind::Login => {}
                    crate::passwords::Kind::ApiKey => {
                        return self.ask_api_key(s, args, existing).await;
                    }
                    crate::passwords::Kind::SshKey => {
                        return Err(Error::new(
                            4202,
                            "To get an SSH key, call generate and add its public key where it's needed. The user can add an existing key in Settings, Passwords.",
                        ));
                    }
                }
                let url = args["url"]
                    .as_str()
                    .or_else(|| existing.as_ref().and_then(|l| l["url"].as_str()))
                    .unwrap_or("")
                    .trim()
                    .to_owned();
                let site = crate::passwords::host(&url).ok_or_else(|| {
                    Error::new(4202, "url must be the sign-in page's http or https address")
                })?;
                let title = args["title"]
                    .as_str()
                    .map(str::trim)
                    .filter(|t| !t.is_empty())
                    .map(str::to_owned)
                    .or_else(|| {
                        existing
                            .as_ref()
                            .and_then(|l| l["title"].as_str())
                            .map(str::to_owned)
                    })
                    .unwrap_or_else(|| site.clone());
                let username = args["username"]
                    .as_str()
                    .or_else(|| existing.as_ref().and_then(|l| l["username"].as_str()))
                    .unwrap_or("");
                let request = json!({
                    "tool": NAME,
                    "toolCall": {"title": format!("Sign in to {title}")},
                    "reason": "Whatever you type goes straight to the page. The bot never sees it.",
                    "form": {
                        "kind": "sign_in",
                        "title": title,
                        "site": site,
                        "url": url,
                        "username": username,
                        "update": existing.is_some(),
                    },
                });
                let Some(answer) = self.ask_native(s, request, true).await? else {
                    return Err(Error::new(
                        4302,
                        "The user closed the sign-in card. Ask what they would like to do instead.",
                    ));
                };
                let typed: Value = serde_json::from_str(&answer)
                    .map_err(|_| Error::new(5201, "The sign-in card sent no login."))?;
                let mut fields = json!({
                    "title": title,
                    "url": url,
                    "username": typed["username"].as_str().unwrap_or(""),
                    "password": typed["password"].as_str().unwrap_or(""),
                });
                if let Some(login) = &existing {
                    fields["id"] = login["id"].clone();
                }
                let login = crate::passwords::save(&self.home, owner, &fields)?;
                self.passwords_changed(owner);
                Ok(json!({
                    "id": login["id"],
                    "title": login["title"],
                    "site": login["site"],
                    "username": login["username"],
                    "note": "Saved for all the user's bots. Now fill it into the sign-in form with fill.",
                }))
            }
            "fill" => {
                let login = usable(required(args, "id")?)?;
                if crate::passwords::Kind::of(&login) != crate::passwords::Kind::Login {
                    return Err(Error::new(
                        4202,
                        "fill types logins only. Use run for SSH keys and API keys.",
                    ));
                }
                let id = login["id"].as_str().unwrap_or("");
                let title = login["title"].as_str().unwrap_or("this site");
                let fields = args["fields"]
                    .as_array()
                    .filter(|f| !f.is_empty() && f.len() <= 4)
                    .ok_or_else(|| Error::new(4202, "fields must list one to four fields"))?;
                let browser = fields.iter().any(|f| f["ref"].is_string());
                if browser && fields.iter().any(|f| !f["ref"].is_string())
                    || !browser && fields.iter().any(|f| !f["coordinate"].is_array())
                {
                    return Err(Error::new(
                        4202,
                        "Give every field a ref for the browser, or a coordinate for the computer.",
                    ));
                }
                // Read when typed: a one-time code read before a wait expires.
                let read = || -> Result<Vec<String>> {
                    fields
                        .iter()
                        .map(|f| {
                            crate::passwords::secret(&self.home, owner, id, required(f, "field")?)
                        })
                        .collect()
                };
                // A field the login lacks fails before anyone is asked.
                let secrets = read()?;
                let typed = fields
                    .iter()
                    .filter_map(|f| f["field"].as_str())
                    .collect::<Vec<_>>()
                    .join(" and ");
                if browser {
                    let saved = login["url"].as_str().unwrap_or("").to_owned();
                    let fills = fields
                        .iter()
                        .zip(secrets)
                        .map(|(f, secret)| (f["ref"].as_str().unwrap_or("").to_owned(), secret))
                        .collect::<Vec<_>>();
                    // The bot knows usernames from list; only these are hidden after.
                    let hidden = fields
                        .iter()
                        .zip(&fills)
                        .filter(|(f, _)| f["field"] != "username")
                        .map(|(_, (_, secret))| secret.clone())
                        .collect::<Vec<_>>();
                    crate::native_tools::browser_fill(
                        &self.home,
                        &s.bot,
                        &s.stored,
                        |page| crate::passwords::same_site(&saved, page),
                        &fills,
                        &hidden,
                    )
                    .await?;
                } else {
                    let request = json!({
                        "tool": NAME,
                        "toolCall": {"title": format!("Type your {title} {typed} on the bots' computer")},
                        "reason": "Hexbot can't check which site the computer shows. Look at it before you allow this.",
                    });
                    if !self.native_approval(s, request).await? {
                        return Err(Error::new(
                            4302,
                            "The user said no. Ask what they would like instead.",
                        ));
                    }
                    let fills = fields
                        .iter()
                        .zip(read()?)
                        .map(|(f, secret)| (Some(f["coordinate"].clone()), secret))
                        .collect::<Vec<_>>();
                    crate::native_tools::computer_fill(&self.home, &s.bot, &fills).await?;
                }
                Ok(json!({"filled": typed, "login": title}))
            }
            "run" => {
                let command = required(args, "command")?.trim();
                if command.is_empty() || command.len() > 8000 {
                    return Err(Error::new(4202, "command must be one shell command"));
                }
                let mut ids = args["ids"]
                    .as_array()
                    .map(|ids| ids.iter().filter_map(Value::as_str).collect::<Vec<_>>())
                    .unwrap_or_default();
                if let Some(id) = args["id"].as_str() {
                    ids.push(id);
                }
                ids.dedup();
                if ids.is_empty() || ids.len() > 8 {
                    return Err(Error::new(
                        4202,
                        "ids must name one to eight keys from list",
                    ));
                }
                let items = ids
                    .iter()
                    .map(|id| {
                        let item = usable(id)?;
                        if crate::passwords::Kind::of(&item) == crate::passwords::Kind::Login {
                            return Err(Error::new(
                                4202,
                                "run takes SSH keys and API keys. To sign in to a site, use fill.",
                            ));
                        }
                        Ok(item)
                    })
                    .collect::<Result<Vec<_>>>()?;
                let mut names = vec![];
                for item in &items {
                    let env = item["env"].as_str().unwrap_or("");
                    if !env.is_empty() && names.contains(&env) {
                        return Err(Error::new(
                            4202,
                            format!("Two of these keys go in {env}. Run them one at a time."),
                        ));
                    }
                    names.push(env);
                }
                // Read when used, and before asking: a missing key fails first.
                let read = || -> Result<Keys> {
                    let (mut vars, mut keys) = (vec![], vec![]);
                    for item in &items {
                        let id = item["id"].as_str().unwrap_or("");
                        match crate::passwords::Kind::of(item) {
                            crate::passwords::Kind::ApiKey => vars.push((
                                item["env"].as_str().unwrap_or("").to_owned(),
                                crate::passwords::secret(&self.home, owner, id, "key")?,
                            )),
                            _ => keys.push(crate::passwords::secret(
                                &self.home,
                                owner,
                                id,
                                "private_key",
                            )?),
                        }
                    }
                    Ok((vars, keys))
                };
                read()?;
                let named = items
                    .iter()
                    .map(|item| {
                        let what = match crate::passwords::Kind::of(item) {
                            crate::passwords::Kind::ApiKey => "API key",
                            _ => "SSH key",
                        };
                        format!("{} {what}", item["title"].as_str().unwrap_or(""))
                    })
                    .collect::<Vec<_>>();
                let request = json!({
                    "tool": NAME,
                    "toolCall": {"title": format!("Run with your {} on the bots' computer:\n{command}", and_list(&named))},
                    "reason": "Hexbot can't check where a command sends a key. Read it before you allow this.",
                });
                if !self.native_approval(s, request).await? {
                    return Err(Error::new(
                        4302,
                        "The user said no. Ask what they would like instead.",
                    ));
                }
                let (vars, keys) = read()?;
                crate::native_tools::computer_run(
                    &self.home, &s.bot, &s.stored, command, &vars, &keys,
                )
                .await
            }
            "generate" => {
                let title = args["title"]
                    .as_str()
                    .map(str::trim)
                    .filter(|t| !t.is_empty())
                    .ok_or_else(|| {
                        Error::new(4202, "title must say what the key is for, such as GitHub")
                    })?;
                let key = crate::passwords::save(
                    &self.home,
                    owner,
                    &json!({"kind": "ssh_key", "title": title, "generate": true}),
                )?;
                self.passwords_changed(owner);
                Ok(json!({
                    "id": key["id"],
                    "title": key["title"],
                    "public_key": key["public_key"],
                    "fingerprint": key["fingerprint"],
                    "note": "Saved for all the user's bots. Add the public key where it's needed, such as GitHub's SSH keys page or a server's ~/.ssh/authorized_keys, then use run with this id.",
                }))
            }
            "share" | "update" | "delete" => {
                if !primary {
                    return Err(Error::new(
                        4210,
                        "Only the primary bot manages passwords, from its own chat. The user can in Settings, Passwords.",
                    ));
                }
                let id = required(args, "id")?;
                let login = crate::passwords::find(&self.home, owner, id)?;
                let title = login["title"].as_str().unwrap_or("this item").to_owned();
                let result = match required(args, "action")? {
                    "share" => {
                        if args.get("bots").is_none() {
                            return Err(Error::new(4200, "missing parameter: bots"));
                        }
                        crate::passwords::save(
                            &self.home,
                            owner,
                            &json!({"id": id, "bots": args["bots"]}),
                        )?
                    }
                    "update" => {
                        let mut patch = json!({"id": id});
                        for key in ["title", "url", "username", "env"] {
                            if let Some(value) = args[key].as_str() {
                                patch[key] = json!(value);
                            }
                        }
                        crate::passwords::save(&self.home, owner, &patch)?
                    }
                    _ => {
                        let request = json!({
                            "tool": NAME,
                            "toolCall": {"title": format!("Delete {title} from Passwords")},
                            "reason": "Deleting always asks.",
                        });
                        if !self.ask_approval(s, request, true).await? {
                            return Err(Error::new(
                                4302,
                                "The user said no. Leave it, and ask what they would like instead.",
                            ));
                        }
                        crate::passwords::delete(&self.home, owner, id)?;
                        self.passwords_changed(owner);
                        return Ok(json!({"deleted": id}));
                    }
                };
                self.passwords_changed(owner);
                Ok(listed(&result, true))
            }
            other => Err(Error::new(
                4202,
                format!("unknown action for {NAME}: {other}"),
            )),
        }
    }

    /// The API key card: the user types the key, which is saved for every
    /// bot and never reaches this one.
    async fn ask_api_key(&self, s: &Live, args: &Value, existing: Option<Value>) -> Result<Value> {
        let text = |key: &str| {
            args[key]
                .as_str()
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .map(str::to_owned)
                .or_else(|| {
                    existing
                        .as_ref()
                        .and_then(|item| item[key].as_str())
                        .filter(|v| !v.is_empty())
                        .map(str::to_owned)
                })
        };
        let title = text("title")
            .ok_or_else(|| Error::new(4202, "title must name the service, such as OpenAI"))?;
        let env = crate::passwords::variable(
            &text("env").unwrap_or_else(|| crate::passwords::default_variable(&title)),
        )?;
        let url = text("url").unwrap_or_default();
        let site = if url.is_empty() {
            None
        } else {
            Some(crate::passwords::host(&url).ok_or_else(|| {
                Error::new(
                    4202,
                    "url must be the http or https page where the user gets the key",
                )
            })?)
        };
        let request = json!({
            "tool": NAME,
            "toolCall": {"title": format!("Add your {title} API key")},
            "reason": "Hexbot keeps it in Passwords and hands it to commands. The bot never sees it.",
            "form": {
                "kind": "api_key",
                "title": title,
                "env": env,
                "url": url,
                "site": site,
                "update": existing.is_some(),
            },
        });
        let Some(answer) = self.ask_native(s, request, true).await? else {
            return Err(Error::new(
                4302,
                "The user closed the card. Ask what they would like to do instead.",
            ));
        };
        let typed: Value =
            serde_json::from_str(&answer).map_err(|_| Error::new(5201, "The card sent no key."))?;
        let mut fields = json!({
            "kind": "api_key",
            "title": title,
            "env": env,
            "url": url,
            "key": typed["key"].as_str().unwrap_or(""),
        });
        if let Some(item) = &existing {
            fields["id"] = item["id"].clone();
        }
        let key = crate::passwords::save(&self.home, &s.owner, &fields)?;
        self.passwords_changed(&s.owner);
        let mut out = listed(&key, false);
        out["note"] = json!(format!(
            "Saved for all the user's bots. Use it with run and ids [\"{}\"]; the command reads it from ${}.",
            key["id"].as_str().unwrap_or(""),
            key["env"].as_str().unwrap_or("")
        ));
        Ok(out)
    }

    fn passwords_changed(&self, owner: &str) {
        self.events
            .emit(owner, None, "hexbot.passwords.changed", json!({}));
    }
}

/// "a", "a and b", "a, b and c".
fn and_list(items: &[String]) -> String {
    match items {
        [] => String::new(),
        [one] => one.clone(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    }
}
