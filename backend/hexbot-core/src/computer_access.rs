//! Where bots work. The user picks one of four choices: the bots' computer
//! and their own, the bots' computer only, their own computer only, or
//! neither, which keeps commands in the workspace sandbox. Inside a choice,
//! each computer has the bots allowed to use it, and each bot has the one it
//! uses when it names none: the active computer, which the user switches
//! from the chat.
//!
//! Tool declarations never depend on any of this, so a chat keeps its cached
//! prompt when computers change. The bot learns what it can use from a short
//! note that rides on the next message (`note`), and every call is checked
//! when it runs (`resolve`).
//!
//! Work on the bots' computer never asks: a reset undoes anything there. Work
//! on the daemon's computer keeps the approval mode.
use crate::{Error, Result, common};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{path::Path, sync::Mutex};

/// The bots' computer, the Cua sandbox in `computers.rs`.
pub const BOTS: &str = "bots";
/// The daemon's computer: its terminal, in the workspace sandbox the approval mode sets.
pub const DAEMON: &str = "daemon";
/// The four choices, as the daemon calls them.
pub const CHOICES: [&str; 4] = ["both", "bots", "yours", "none"];
const DEFAULT_CHOICE: &str = "both";
const FILE: &str = "computers.json";
/// Note ids start with this, beside heartbeat and reaction ids.
const NOTE_ID: &str = "computers:";

/// computers.json: `choice`; `bots.except` and `daemon.except`, the bots that
/// may not use that computer (every other bot may, including new ones);
/// `daemon.screen`, the bots that may also use the daemon's screen (none
/// until the user picks them); `devices`, each desktop app that lent its
/// computer once, by device id, with its name, OS, and the bots picked for
/// it (`bots`) and its screen (`screen`), none at first;
/// `active`, each bot's active computer; `told`, the note each conversation
/// last took.
fn saved(home: &Path) -> Value {
    std::fs::read_to_string(home.join(FILE))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}))
}
fn save(home: &Path, change: impl FnOnce(&mut Value)) -> Result<()> {
    // One save at a time, or two switches overwrite each other.
    static SAVING: Mutex<()> = Mutex::new(());
    let _saving = SAVING.lock().unwrap_or_else(|e| e.into_inner());
    let mut current = saved(home);
    let before = current.clone();
    change(&mut current);
    if current == before {
        return Ok(());
    }
    common::atomic_write(&home.join(FILE), current.to_string().as_bytes())
}

/// The user's choice: `both`, `bots`, `yours` or `none`.
pub fn choice(home: &Path) -> &'static str {
    let chosen = saved(home)["choice"].as_str().map(str::to_owned);
    CHOICES
        .into_iter()
        .find(|choice| Some(*choice) == chosen.as_deref())
        .unwrap_or(DEFAULT_CHOICE)
}

fn listed(list: &Value, bot: &str) -> bool {
    list.as_array()
        .is_some_and(|list| list.iter().any(|name| name == bot))
}
/// The device behind a lent computer's id, such as `app-1f2e3d4c`.
fn device_of(saved: &Value, id: &str) -> Option<String> {
    saved["devices"]
        .as_object()?
        .keys()
        .find(|device| crate::computer_lend::computer_id(device) == id)
        .cloned()
}
/// The device id behind a lent computer's id, if it is one.
pub fn device_for(home: &Path, id: &str) -> Option<String> {
    device_of(&saved(home), id)
}
/// Every computer's id in a fixed order: the bots', the daemon's, then lent
/// ones by name.
fn ids(saved: &Value) -> Vec<String> {
    let mut lent = saved["devices"]
        .as_object()
        .map(|devices| {
            devices
                .iter()
                .map(|(device, entry)| {
                    (
                        entry["name"].as_str().unwrap_or("").to_lowercase(),
                        crate::computer_lend::computer_id(device),
                    )
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    lent.sort();
    [BOTS.to_owned(), DAEMON.to_owned()]
        .into_iter()
        .chain(lent.into_iter().map(|(_, id)| id))
        .collect()
}
/// Whether the user lets this bot use a computer, whatever the choice.
fn assigned(saved: &Value, id: &str, bot: &str) -> bool {
    match id {
        BOTS | DAEMON => !listed(&saved[id]["except"], bot),
        _ => device_of(saved, id)
            .is_some_and(|device| listed(&saved["devices"][device]["bots"], bot)),
    }
}
/// Whether the choice turns a computer on.
fn chosen(choice: &str, id: &str) -> bool {
    match id {
        BOTS => matches!(choice, "both" | "bots"),
        // The daemon keeps the workspace terminal in `none`, sandboxed.
        DAEMON => choice != "bots",
        // Lent computers are the user's own.
        _ => matches!(choice, "both" | "yours"),
    }
}

fn os_name() -> &'static str {
    match std::env::consts::OS {
        "macos" => "macOS",
        "linux" => "Linux",
        "windows" => "Windows",
        other => other,
    }
}

/// Whether the user lets this bot see and use a computer's screen: the
/// daemon's, or a lent one's.
fn on_screen_of(saved: &Value, id: &str, bot: &str) -> bool {
    match id {
        DAEMON => listed(&saved[DAEMON]["screen"], bot),
        BOTS => true,
        _ => device_of(saved, id)
            .is_some_and(|device| listed(&saved["devices"][device]["screen"], bot)),
    }
}

/// A computer as clients and bots see it. `screen`: bots can see and use its
/// screen (for the daemon's, this bot can). `limited`: commands stay in the
/// workspace sandbox, whatever the approval mode. `ready`: what it needs is
/// installed.
fn describe(home: &Path, saved: &Value, id: &str, choice: &str, screen: bool) -> Value {
    if let Some(device) = device_of(saved, id) {
        let entry = &saved["devices"][&device];
        let live = crate::computer_lend::online(home, &device);
        let name = live.as_ref().map_or_else(
            || entry["name"].as_str().unwrap_or("").to_owned(),
            |l| l.0.clone(),
        );
        let os = live.as_ref().map_or_else(
            || entry["os"].as_str().unwrap_or("").to_owned(),
            |l| l.1.clone(),
        );
        let lends_screen = live.as_ref().is_some_and(|l| l.2);
        return json!({
            "id": id,
            "kind": "device",
            "name": name,
            "os": os,
            // The app lends its screen, and the user picked this bot for it.
            "screen": screen && lends_screen,
            "lends_screen": lends_screen,
            "limited": false,
            "asks": true,
            "ready": live.is_some(),
            "online": live.is_some(),
        });
    }
    match id {
        BOTS => json!({
            "id": BOTS,
            "kind": "bots",
            "name": "Bots' computer",
            "os": "Linux",
            "screen": true,
            "limited": false,
            "asks": false,
            "ready": crate::computers::available(home),
            "online": true,
        }),
        _ => json!({
            "id": DAEMON,
            "kind": "daemon",
            "name": crate::auth::daemon_name(),
            "os": os_name(),
            // Neither keeps bots in the workspace: no screen.
            "screen": screen && choice != "none",
            "limited": choice == "none",
            "asks": true,
            "ready": true,
            "online": true,
        }),
    }
}

/// The computers this bot may use now, active one marked, in a fixed order.
pub fn for_bot(home: &Path, bot: &str) -> Vec<Value> {
    let saved = saved(home);
    let choice = choice(home);
    let mut list = ids(&saved)
        .into_iter()
        .filter(|id| chosen(choice, id) && assigned(&saved, id, bot))
        .map(|id| describe(home, &saved, &id, choice, on_screen_of(&saved, &id, bot)))
        .collect::<Vec<_>>();
    let active = active_in(&saved, bot, &list);
    for computer in &mut list {
        computer["active"] =
            json!(Some(computer["id"].as_str().unwrap_or("")) == active.as_deref());
    }
    list
}
/// The bot's pick when it is still one of its computers. Otherwise the first
/// that is ready, so a daemon without Cua keeps its terminal where it was.
fn active_in(saved: &Value, bot: &str, list: &[Value]) -> Option<String> {
    let picked = saved["active"][bot].as_str();
    list.iter()
        .find(|c| picked.is_some() && c["id"].as_str() == picked && c["online"] != false)
        .or_else(|| list.iter().find(|c| c["ready"] == true))
        .or_else(|| list.first())
        .and_then(|c| c["id"].as_str())
        .map(str::to_owned)
}

/// The computer a call runs on: the one it names, by id or name, or the
/// bot's active one. Refused with a sentence the bot can act on.
pub fn resolve(home: &Path, bot: &str, requested: Option<&str>) -> Result<Value> {
    let list = for_bot(home, bot);
    let requested = requested.map(str::trim).filter(|name| !name.is_empty());
    let found = match requested {
        Some(name) => list.iter().find(|c| {
            c["id"].as_str() == Some(name)
                || c["name"]
                    .as_str()
                    .is_some_and(|known| known.eq_ignore_ascii_case(name))
        }),
        None => list.iter().find(|c| c["active"] == true),
    };
    if let Some(computer) = found {
        return Ok(computer.clone());
    }
    if list.is_empty() {
        return Err(Error::new(
            4302,
            "You have no computer to use. The user chooses where bots work in Settings, Computers.",
        ));
    }
    Err(Error::new(
        4302,
        format!(
            "There is no computer called {} for you. Use one of: {}.",
            requested.unwrap_or(""),
            names(&list)
        ),
    ))
}
fn names(list: &[Value]) -> String {
    list.iter()
        .map(|c| {
            format!(
                "{} ({})",
                c["id"].as_str().unwrap_or(""),
                c["name"].as_str().unwrap_or("")
            )
        })
        .collect::<Vec<_>>()
        .join(", ")
}

/// What the extension needs to route and gate the bot's commands.
pub fn session(home: &Path, bot: &str) -> Value {
    json!({"choice": choice(home), "list": for_bot(home, bot)})
}

/// What this bot can use, as one note. It changes only when the user changes
/// computers, so it is offered once per change.
fn note_text(home: &Path, bot: &str) -> String {
    let saved = saved(home);
    let mut list = for_bot(home, bot);
    // Only what the user chose, never a lent computer coming and going: its
    // name and screen as it was lent, and the bot's own pick as active.
    let picked = saved["active"][bot].as_str().map(str::to_owned);
    let pick_listed = list.iter().any(|c| c["id"].as_str() == picked.as_deref());
    for c in &mut list {
        let id = c["id"].as_str().unwrap_or_default().to_owned();
        if let Some(device) = device_of(&saved, &id) {
            let entry = &saved["devices"][&device];
            c["name"] = entry["name"].clone();
            c["screen"] = json!(entry["lends_screen"] == true && on_screen_of(&saved, &id, bot));
        }
        if pick_listed {
            c["active"] = json!(Some(id.as_str()) == picked.as_deref());
        } else if c["kind"] == "device" {
            c["active"] = json!(false);
        }
    }
    if list.is_empty() {
        return "[Computers] You have no computer right now: commands are refused. The user chooses where bots work in Settings, Computers.".into();
    }
    let lines = list
        .iter()
        .map(|c| {
            let mut line = format!(
                "- {}: {}, {}",
                c["id"].as_str().unwrap_or(""),
                c["name"].as_str().unwrap_or(""),
                c["os"].as_str().unwrap_or("")
            );
            line.push_str(match c["id"].as_str() {
                _ if c["kind"] == "device" => ". The user's computer, lent by the Hexbot app there while it is open: commands run in its workspace sandbox (~/Hexbot) and may ask the user, as the approval mode says. Files you make there stay there.",
                Some(BOTS) => ". A desktop your bots share, separate from the user's computer. Nothing there asks for approval and a reset undoes it, so install, browse and try risky things here. Each command has 30 seconds; start longer jobs in the background.",
                _ if c["limited"] == true => ". The user's computer: commands stay in the workspace sandbox, without internet, and full_access is refused.",
                _ => ". The user's computer: commands run in the workspace sandbox and may ask the user, as the approval mode says.",
            });
            if c["kind"] != "bots" && c["screen"] == true {
                line.push_str(&format!(
                    " You may also see and use its screen with computer_use and computer {}.",
                    c["id"].as_str().unwrap_or("")
                ));
                line.push_str(" It shows the user's own apps and files: the user may be asked first, look before each action, act only on what the task needs, and never touch Hexbot's own windows.");
            }
            if c["active"] == true {
                line.push_str(" Active: used when you name no computer.");
            }
            line
        })
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "[Computers] The user changed where you work, or this is the first time you hear it. Your terminal and computer_use take `computer`, one of these ids:\n{lines}\nWhen your active computer is offline, the first one here that is ready is used instead. File tools always work in the workspace on the daemon's computer."
    )
}
fn note_hash(text: &str) -> String {
    Sha256::digest(text)[..8]
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
/// A note is offered at most this often before Pi reports taking it, so a
/// lost reply cannot repeat it on every message.
const OFFERS: u64 = 2;
/// The note this conversation has not taken yet, with its id.
pub fn note(home: &Path, bot: &str, section: &str) -> Option<(String, String)> {
    // Heartbeats and dreams run no commands, and there is one per run.
    if section.starts_with("heartbeat-") || section.starts_with("dream-") {
        return None;
    }
    let text = note_text(home, bot);
    let hash = note_hash(&text);
    let saved = saved(home);
    let offered = &saved["offered"][section];
    let spent =
        offered["hash"].as_str() == Some(&hash) && offered["times"].as_u64().unwrap_or(0) >= OFFERS;
    (saved["told"][section].as_str() != Some(&hash) && !spent)
        .then(|| (text, format!("{NOTE_ID}{hash}")))
}
/// The note, counted as offered once more: it goes into the next request.
pub fn take_note(home: &Path, bot: &str, section: &str) -> Option<(String, String)> {
    let (text, id) = note(home, bot, section)?;
    let hash = id.trim_start_matches(NOTE_ID).to_owned();
    let _ = save(home, |saved| {
        if !saved["offered"].is_object() {
            saved["offered"] = json!({});
        }
        let times = match saved["offered"][section]["hash"].as_str() {
            Some(previous) if previous == hash => {
                saved["offered"][section]["times"].as_u64().unwrap_or(0)
            }
            _ => 0,
        };
        saved["offered"][section] = json!({"hash": hash, "times": times + 1});
        prune(home, saved);
    });
    Some((text, id))
}
/// Past this many conversations, notes kept for ones that are gone are dropped.
const KEPT: usize = 300;
fn prune(home: &Path, saved: &mut Value) {
    let size = |field: &str| saved[field].as_object().map_or(0, serde_json::Map::len);
    if size("told") + size("offered") <= KEPT {
        return;
    }
    let Ok(store) = crate::runtime_store::open(home) else {
        return;
    };
    let alive = |section: &String| {
        store
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM native_sessions WHERE stored_id=?)",
                [section],
                |r| r.get::<_, bool>(0),
            )
            .unwrap_or(true)
    };
    for field in ["told", "offered"] {
        if let Some(map) = saved[field].as_object_mut() {
            map.retain(|section, _| alive(section));
        }
    }
}

/// Pi reported the message carrying the note: the conversation has it.
pub fn acknowledge(home: &Path, section: &str, ids: &Value) -> Result<()> {
    let Some(hash) = ids
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .find_map(|id| id.strip_prefix(NOTE_ID))
    else {
        return Ok(());
    };
    save(home, |saved| {
        if !saved["told"].is_object() {
            saved["told"] = json!({});
        }
        saved["told"][section] = json!(hash);
        prune(home, saved);
    })
}

/// Everything Settings, Computers shows: the choice, and for each computer
/// the bots the user lets use it.
pub fn list(home: &Path, bots: &[String]) -> Value {
    let saved = saved(home);
    let choice = choice(home);
    json!({
        "choice": choice,
        "computers": ids(&saved).into_iter().map(|id| {
            let mut computer = describe(home, &saved, &id, choice, id != BOTS);
            computer["on"] = json!(chosen(choice, &id));
            computer["bots"] = json!(bots.iter().filter(|bot| assigned(&saved, &id, bot)).collect::<Vec<_>>());
            if id != BOTS {
                // The bots that may also use its screen.
                computer["screen_bots"] = json!(bots.iter().filter(|bot| on_screen_of(&saved, &id, bot)).collect::<Vec<_>>());
            }
            computer
        }).collect::<Vec<_>>(),
    })
}

fn owned_bots(home: &Path, owner: &str) -> Result<Vec<String>> {
    Ok(common::rows(
        &crate::db::open(home)?,
        "SELECT name FROM bots WHERE owner_id=? ORDER BY name",
        &[&owner],
    )?
    .into_iter()
    .filter_map(|row| row["name"].as_str().map(str::to_owned))
    .collect())
}

/// Change the choice, or whether one bot may use one computer.
fn configure(home: &Path, owner: &str, p: &Value) -> Result<()> {
    if let Some(choice) = p.get("choice").filter(|v| !v.is_null()) {
        let choice = choice
            .as_str()
            .filter(|c| CHOICES.contains(c))
            .ok_or_else(|| Error::new(4202, "choice must be both, bots, yours or none"))?;
        save(home, |saved| saved["choice"] = json!(choice))?;
    }
    if let Some(computer) = p.get("computer").filter(|v| !v.is_null()) {
        let current = saved(home);
        let computer = computer
            .as_str()
            .filter(|c| ids(&current).iter().any(|id| id == c))
            .ok_or_else(|| Error::new(4202, "no such computer"))?;
        let bot = common::required(p, "bot")?;
        common::bot_owner(home, owner, bot)?;
        let device = device_of(&current, computer);
        // A lent computer's bots and screen, and the daemon's screen, are
        // lists of the bots picked for them.
        let picked = |field: &'static str, on: bool| {
            save(home, |saved| {
                let slot = match &device {
                    Some(device) => &mut saved["devices"][device],
                    None => {
                        if !saved[DAEMON].is_object() {
                            saved[DAEMON] = json!({});
                        }
                        &mut saved[DAEMON]
                    }
                };
                let mut list = slot[field].as_array().cloned().unwrap_or_default();
                list.retain(|name| name != bot);
                if on {
                    list.push(json!(bot));
                }
                slot[field] = json!(list);
            })
        };
        if let Some(screen) = p.get("screen").filter(|v| !v.is_null()) {
            if computer == BOTS {
                return Err(Error::new(
                    4202,
                    "every bot on the bots' computer has its screen",
                ));
            }
            let screen = screen
                .as_bool()
                .ok_or_else(|| Error::new(4202, "screen must be true or false"))?;
            return picked("screen", screen);
        }
        let allowed = p["allowed"]
            .as_bool()
            .ok_or_else(|| Error::new(4202, "allowed must be true or false"))?;
        if device.is_some() {
            return picked("bots", allowed);
        }
        save(home, |saved| {
            let mut except = saved[computer]["except"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            except.retain(|name| name != bot);
            if !allowed {
                except.push(json!(bot));
            }
            if !saved[computer].is_object() {
                saved[computer] = json!({});
            }
            saved[computer]["except"] = json!(except);
        })?;
    }
    Ok(())
}

/// Switch the computer a bot uses when it names none.
fn use_computer(home: &Path, owner: &str, p: &Value) -> Result<Value> {
    let bot = common::required(p, "bot")?;
    common::bot_owner(home, owner, bot)?;
    let id = common::required(p, "computer")?;
    let list = for_bot(home, bot);
    if !list.iter().any(|c| c["id"] == id) {
        return Err(Error::new(
            4202,
            "This bot can't use that computer. Choose it for the bot in Settings, Computers first.",
        ));
    }
    save(home, |saved| {
        if !saved["active"].is_object() {
            saved["active"] = json!({});
        }
        saved["active"][bot] = json!(id);
    })?;
    Ok(json!({"bot": bot, "computers": for_bot(home, bot)}))
}

/// A desktop app lent its computer: remember it for Settings and the bots
/// picked for it, even while it is offline.
pub fn remember_device(
    home: &Path,
    device: &str,
    name: &str,
    os: &str,
    screen: bool,
) -> Result<()> {
    save(home, |saved| {
        if !saved["devices"].is_object() {
            saved["devices"] = json!({});
        }
        let entry = &mut saved["devices"][device];
        if !entry.is_object() {
            *entry = json!({"bots":[],"screen":[]});
        }
        entry["name"] = json!(name);
        entry["os"] = json!(os);
        // Whether it lent its screen the last time it was lent, for the note.
        entry["lends_screen"] = json!(screen);
    })
}
/// A revoked device's computer is gone, with the bots picked for it.
pub fn forget_device(home: &Path, device: &str) {
    let _ = save(home, |saved| {
        if let Some(devices) = saved["devices"].as_object_mut() {
            devices.remove(device);
        }
    });
}

/// A deleted bot leaves every list.
pub fn forget_bot(home: &Path, bot: &str) {
    let _ = save(home, |saved| {
        if let Some(devices) = saved["devices"].as_object_mut() {
            for entry in devices.values_mut() {
                for field in ["bots", "screen"] {
                    if let Some(list) = entry[field].as_array_mut() {
                        list.retain(|name| name != bot);
                    }
                }
            }
        }
        for id in [BOTS, DAEMON] {
            if let Some(except) = saved[id]["except"].as_array_mut() {
                except.retain(|name| name != bot);
            }
        }
        if let Some(screen) = saved[DAEMON]["screen"].as_array_mut() {
            screen.retain(|name| name != bot);
        }
        if let Some(active) = saved["active"].as_object_mut() {
            active.remove(bot);
        }
    });
}

/// Methods that change something clients show; the server tells them.
pub const CHANGES: [&str; 2] = ["hexbot.computers.configure", "hexbot.computers.use"];

/// `hexbot.computers.*`.
pub fn call(home: &Path, owner: &str, method: &str, p: &Value) -> Option<Result<Value>> {
    if !method.starts_with("hexbot.computers.") {
        return None;
    }
    Some((|| match method {
        "hexbot.computers.list" => Ok(list(home, &owned_bots(home, owner)?)),
        "hexbot.computers.for_bot" => {
            let bot = common::required(p, "bot")?;
            common::bot_owner(home, owner, bot)?;
            Ok(json!({"bot": bot, "computers": for_bot(home, bot)}))
        }
        "hexbot.computers.configure" => {
            configure(home, owner, p)?;
            Ok(list(home, &owned_bots(home, owner)?))
        }
        "hexbot.computers.use" => use_computer(home, owner, p),
        _ => Err(Error::new(-32601, format!("unknown method: {method}"))),
    })())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn home() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }
    fn ids(list: &[Value]) -> Vec<&str> {
        list.iter().filter_map(|c| c["id"].as_str()).collect()
    }

    #[test]
    fn every_bot_starts_with_both_computers() {
        let home = home();
        assert_eq!(choice(home.path()), "both");
        assert_eq!(ids(&for_bot(home.path(), "owl")), [BOTS, DAEMON]);
    }

    #[test]
    fn each_choice_turns_computers_on_and_off() {
        let home = home();
        for (choice, expected, limited) in [
            ("both", vec![BOTS, DAEMON], false),
            ("bots", vec![BOTS], false),
            ("yours", vec![DAEMON], false),
            ("none", vec![DAEMON], true),
        ] {
            save(home.path(), |saved| saved["choice"] = json!(choice)).unwrap();
            let list = for_bot(home.path(), "owl");
            assert_eq!(ids(&list), expected, "{choice}");
            let daemon = list.iter().find(|c| c["id"] == DAEMON);
            assert_eq!(
                daemon.is_some_and(|c| c["limited"] == true),
                limited,
                "{choice}"
            );
        }
    }

    #[test]
    fn an_excluded_bot_loses_only_that_computer() {
        let home = home();
        save(home.path(), |saved| {
            saved["bots"] = json!({"except":["owl"]})
        })
        .unwrap();
        assert_eq!(ids(&for_bot(home.path(), "owl")), [DAEMON]);
        assert_eq!(ids(&for_bot(home.path(), "fox")), [BOTS, DAEMON]);
        forget_bot(home.path(), "owl");
        assert_eq!(ids(&for_bot(home.path(), "owl")), [BOTS, DAEMON]);
    }

    #[test]
    fn resolve_takes_an_id_a_name_or_the_active_computer() {
        let home = home();
        save(home.path(), |saved| {
            saved["active"] = json!({"owl": DAEMON})
        })
        .unwrap();
        assert_eq!(resolve(home.path(), "owl", None).unwrap()["id"], DAEMON);
        assert_eq!(
            resolve(home.path(), "owl", Some("bots")).unwrap()["id"],
            BOTS
        );
        assert_eq!(
            resolve(home.path(), "owl", Some("bots' COMPUTER")).unwrap()["id"],
            BOTS
        );
        let error = resolve(home.path(), "owl", Some("laptop")).unwrap_err();
        assert!(
            error.message.contains("bots (Bots' computer)"),
            "{}",
            error.message
        );
        // A pick the choice took away falls back to what is left.
        save(home.path(), |saved| saved["choice"] = json!("bots")).unwrap();
        assert_eq!(resolve(home.path(), "owl", None).unwrap()["id"], BOTS);
        assert!(resolve(home.path(), "owl", Some(DAEMON)).is_err());
    }

    #[test]
    fn a_bot_with_no_computer_is_told_where_to_choose_one() {
        let home = home();
        save(home.path(), |saved| {
            saved["choice"] = json!("bots");
            saved["bots"] = json!({"except":["owl"]});
        })
        .unwrap();
        let error = resolve(home.path(), "owl", None).unwrap_err();
        assert!(error.message.contains("Settings, Computers"));
    }

    #[test]
    fn the_note_is_offered_until_taken_and_again_after_a_change() {
        let home = home();
        // Offered twice without Pi taking it, it stops.
        assert!(take_note(home.path(), "owl", "lost").is_some());
        assert!(take_note(home.path(), "owl", "lost").is_some());
        assert!(note(home.path(), "owl", "lost").is_none());
        let (text, id) = note(home.path(), "owl", "chat").unwrap();
        assert!(text.contains("- bots: Bots' computer"));
        assert!(text.contains("- daemon:"));
        // Other ids in the same message are not ours.
        acknowledge(home.path(), "chat", &json!(["heartbeat-1", id])).unwrap();
        assert!(note(home.path(), "owl", "chat").is_none());
        // Another conversation of the same bot still needs it.
        assert!(note(home.path(), "owl", "room-1").is_some());
        save(home.path(), |saved| saved["choice"] = json!("bots")).unwrap();
        let (text, _) = note(home.path(), "owl", "chat").unwrap();
        assert!(!text.contains("- daemon:"));
    }

    #[test]
    fn the_daemons_screen_is_only_for_the_bots_picked_for_it() {
        let home = home();
        let daemon = |bot: &str| {
            for_bot(home.path(), bot)
                .into_iter()
                .find(|c| c["id"] == DAEMON)
                .unwrap()
        };
        assert_eq!(daemon("owl")["screen"], false);
        save(home.path(), |saved| {
            saved[DAEMON] = json!({"screen":["owl"]})
        })
        .unwrap();
        assert_eq!(daemon("owl")["screen"], true);
        assert_eq!(daemon("fox")["screen"], false);
        assert!(
            note(home.path(), "owl", "chat")
                .unwrap()
                .0
                .contains("see and use its screen")
        );
        assert!(
            !note(home.path(), "fox", "chat")
                .unwrap()
                .0
                .contains("see and use its screen")
        );
        // Neither keeps bots off every screen; Settings still lists who was picked.
        save(home.path(), |saved| saved["choice"] = json!("none")).unwrap();
        assert_eq!(daemon("owl")["screen"], false);
        let listed = list(home.path(), &["owl".into(), "fox".into()]);
        assert_eq!(listed["computers"][1]["screen_bots"], json!(["owl"]));
        forget_bot(home.path(), "owl");
        assert_eq!(saved(home.path())[DAEMON]["screen"], json!([]));
    }

    #[test]
    fn a_lent_computer_is_for_the_bots_picked_for_it_and_only_while_online() {
        let home = home();
        remember_device(home.path(), "d1-abc", "Laptop", "macOS", false).unwrap();
        let id = crate::computer_lend::computer_id("d1-abc");
        // Nobody uses it until picked.
        assert_eq!(ids(&for_bot(home.path(), "owl")), [BOTS, DAEMON]);
        save(home.path(), |saved| {
            saved["devices"]["d1-abc"]["bots"] = json!(["owl"])
        })
        .unwrap();
        let owls = for_bot(home.path(), "owl");
        let laptop = owls.iter().find(|c| c["id"] == id.as_str()).unwrap();
        assert_eq!(laptop["kind"], "device");
        assert_eq!(laptop["online"], false);
        assert_eq!(laptop["screen"], false);
        assert!(
            note(home.path(), "owl", "chat")
                .unwrap()
                .0
                .contains("lent by the Hexbot app")
        );
        assert!(note(home.path(), "owl", "heartbeat-1").is_none());
        assert_eq!(
            resolve(home.path(), "owl", Some("laptop")).unwrap()["id"],
            id.as_str()
        );
        // With only the bots' computer, lent ones are off with the daemon's.
        save(home.path(), |saved| saved["choice"] = json!("bots")).unwrap();
        assert_eq!(ids(&for_bot(home.path(), "owl")), [BOTS]);
        // Settings lists it whatever the choice, with who uses it.
        let listed = list(home.path(), &["owl".into()]);
        assert_eq!(listed["computers"][2]["id"], id.as_str());
        assert_eq!(listed["computers"][2]["bots"], json!(["owl"]));
        forget_device(home.path(), "d1-abc");
        assert_eq!(
            list(home.path(), &["owl".into()])["computers"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
    }

    #[test]
    fn the_note_stays_the_same_while_a_lent_computer_comes_and_goes() {
        let home = home();
        remember_device(home.path(), "d1-abc", "Laptop", "macOS", true).unwrap();
        let id = crate::computer_lend::computer_id("d1-abc");
        save(home.path(), |saved| {
            saved["devices"]["d1-abc"]["bots"] = json!(["owl"]);
            saved["devices"]["d1-abc"]["screen"] = json!(["owl"]);
            saved["active"] = json!({"owl": id});
        })
        .unwrap();
        let offline = note_text(home.path(), "owl");
        assert!(offline.contains(&format!("computer {id}")), "{offline}");
        let (send, _frames) = tokio::sync::mpsc::unbounded_channel();
        crate::computer_lend::offer(
            home.path(),
            "local",
            "d1-abc",
            1,
            send,
            &json!({"name":"Laptop","os":"macOS","screen":true}),
        )
        .unwrap();
        assert_eq!(note_text(home.path(), "owl"), offline);
        crate::computer_lend::withdraw(home.path(), "d1-abc", 1);
        assert_eq!(note_text(home.path(), "owl"), offline);
        // The lent computer is the pick, so it is the one called active.
        assert!(offline.contains("Laptop, macOS"));
        assert!(
            offline
                .lines()
                .any(|l| l.contains("Laptop") && l.contains("Active"))
        );
    }

    #[test]
    fn configure_validates_and_keeps_exceptions_unique() {
        let home = home();
        assert!(configure(home.path(), "local", &json!({"choice":"all"})).is_err());
        configure(home.path(), "local", &json!({"choice":"yours"})).unwrap();
        assert_eq!(choice(home.path()), "yours");
        assert!(
            configure(
                home.path(),
                "local",
                &json!({"computer":"moon","bot":"owl","allowed":false})
            )
            .is_err()
        );
    }
}
