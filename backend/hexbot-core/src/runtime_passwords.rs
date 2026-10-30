//! `hexbot_passwords`: a bot signs in with the user's saved passwords
//! without ever reading one. It lists the logins it may use, asks the user
//! for a new one through a sign-in card, and has the daemon type a login's
//! fields into a page. In the browser the page must be on the login's site;
//! on the bots' computer, where the daemon can't see the address, filling
//! asks the user unless the bot runs in Bypass. The primary bot, in its own
//! chat, also chooses which bots get each login, renames and deletes them.
use super::*;

pub(super) const NAME: &str = "hexbot_passwords";

pub(super) fn descriptor() -> Value {
    json!({
        "name": NAME,
        "label": "Passwords",
        "description": "Sign in to websites with the user's saved passwords. You never see a password: the daemon types it into the page. Never ask the user to type a password or code in the chat. list shows the logins you may use (id, title, site, username). When a site needs a sign-in and none fits, call ask straight away, without asking first: it shows the user a secure sign-in card in your chat, and what they type is saved for all their bots and never reaches you. Pass id to ask for a new password for a login that stopped working. fill types a login's username, password or one-time code into fields: in the browser give each field's ref from browser_snapshot, and the page must be on the login's site; on the computer give each field's coordinate, which asks the user first. After filling, press the sign-in button yourself. The primary bot, in its own chat, can also share (choose which bots get a login; bots null means every bot), update (title, url, username) and delete.",
        "parameters": {
            "type": "object",
            "properties": {
                "action": { "type": "string", "enum": ["list", "ask", "fill", "share", "update", "delete"] },
                "id": { "type": "string", "description": "The login's id from list" },
                "title": { "type": "string", "description": "With ask or update: the site's name as people know it, such as Schoology" },
                "url": { "type": "string", "description": "With ask or update: the sign-in page's address" },
                "username": { "type": "string", "description": "With ask: a username to suggest; with update: the new username" },
                "fields": {
                    "type": "array",
                    "description": "With fill: the fields to type into, in order",
                    "items": {
                        "type": "object",
                        "properties": {
                            "field": { "type": "string", "enum": ["username", "password", "code"] },
                            "ref": { "type": "string", "description": "The field's ref from browser_snapshot" },
                            "coordinate": { "type": "array", "items": { "type": "integer" }, "minItems": 2, "maxItems": 2, "description": "The field's point in the latest computer screenshot" }
                        },
                        "required": ["field"]
                    }
                },
                "bots": {
                    "type": ["array", "null"],
                    "items": { "type": "string" },
                    "description": "With share: the bots that may use the login, or null for every bot"
                }
            },
            "required": ["action"]
        }
    })
}

/// A bot with a browser or the computer may sign in, in its own chat and
/// its scheduled jobs; rooms and threads between bots never see passwords.
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
                let logins = crate::passwords::list(
                    &self.home,
                    owner,
                    (!primary).then_some(s.bot.as_str()),
                )?
                .into_iter()
                .map(|login| {
                    let mut row = json!({
                        "id": login["id"],
                        "title": login["title"],
                        "site": login["site"],
                        "username": login["username"],
                        "has_code": login["has_code"],
                    });
                    if primary {
                        row["bots"] = login["bots"].clone();
                    }
                    row
                })
                .collect::<Vec<_>>();
                let empty = logins.is_empty();
                let mut out = json!({"logins": logins});
                if empty {
                    out["note"] = json!(
                        "No saved logins. To sign in, call ask with the site's title and url now: the user types the password into a secure card. Don't ask for it in the chat."
                    );
                }
                Ok(out)
            }
            "ask" => {
                if settings["canAsk"] == false || job {
                    return Err(Error::new(
                        4302,
                        "Nobody can answer a sign-in card here. Tell the user to save the password in Settings, Passwords.",
                    ));
                }
                let existing = match args["id"].as_str().filter(|id| !id.is_empty()) {
                    Some(id) => Some(usable(id)?),
                    None => None,
                };
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
                    crate::native_tools::browser_fill(
                        &self.home,
                        &s.bot,
                        &s.stored,
                        |page| crate::passwords::same_site(&saved, page),
                        &fills,
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
            "share" | "update" | "delete" => {
                if !primary {
                    return Err(Error::new(
                        4210,
                        "Only the primary bot manages passwords, from its own chat. The user can in Settings, Passwords.",
                    ));
                }
                let id = required(args, "id")?;
                let login = crate::passwords::find(&self.home, owner, id)?;
                let title = login["title"].as_str().unwrap_or("this login").to_owned();
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
                        for key in ["title", "url", "username"] {
                            if let Some(value) = args[key].as_str() {
                                patch[key] = json!(value);
                            }
                        }
                        crate::passwords::save(&self.home, owner, &patch)?
                    }
                    _ => {
                        let request = json!({
                            "tool": NAME,
                            "toolCall": {"title": format!("Delete the saved password for {title}")},
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
                Ok(json!({
                    "id": result["id"],
                    "title": result["title"],
                    "site": result["site"],
                    "username": result["username"],
                    "bots": result["bots"],
                }))
            }
            other => Err(Error::new(
                4202,
                format!("unknown action for {NAME}: {other}"),
            )),
        }
    }

    fn passwords_changed(&self, owner: &str) {
        self.events
            .emit(owner, None, "hexbot.passwords.changed", json!({}));
    }
}
