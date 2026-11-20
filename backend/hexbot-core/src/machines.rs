//! Computers: every place a bot can act, and which bots may act there.
//!
//! - `vm`, the bots' computer: the one Cua sandbox per daemon
//!   (`computers.rs`), shared by every bot. Easy to reset, so its terminal
//!   runs without the OS sandbox; Auto reviews only risky commands there.
//! - `host`, this computer: the daemon's own. Its terminal is Pi's bash in
//!   the OS sandbox, as before; its desktop goes through Cua's direct
//!   connection to this computer (`cua host setup --direct`), once the user
//!   turns it on.
//! - `device:<id>`, the user's computers: a paired desktop app that allowed
//!   bots on that computer. The app attaches over its own WebSocket
//!   (`hexbot.computers.attach`); the daemon sends it work as events on that
//!   one connection and the app answers with `hexbot.computers.reply`. Only
//!   the app decides whether it takes part, so nothing on the daemon can turn
//!   a laptop into a computer.
//!
//! A computer given to a bot is one of its environments: config.yaml keeps,
//! under `computers`, each computer's bots in its `terminal` list, like a
//! plugin's `bots`, and the bot's bash runs in every one. Its desktop on a
//! computer is never a grant of its own: the Computer Use connector
//! (`computers.computer_use`, a list of bots) puts its environments' screens
//! in reach where each is shared. A daemon without that key predates
//! computers: every bot then has the bots' computer's desktop, and the bots
//! with the `terminal` toolset have this computer's terminal, as before;
//! `migrate` writes that down once, giving every bot the bots' computer and
//! Computer Use.
//!
//! A section freezes the bot's computers with its tools (`session_list`), so
//! a computer coming online or going away never changes its prompt; the tools
//! answer that a computer is offline. Every call checks the grant again, so
//! taking one away applies at once.
use crate::{Error, Result, common, db};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

pub const VM: &str = "vm";
pub const HOST: &str = "host";
pub const TERMINAL: &str = "terminal";
pub const DESKTOP: &str = "desktop";
/// A request that ends what bots started on a user's computer.
const RELEASE: &str = "release";
const DEVICE: &str = "device:";
/// How long a command may run on another computer when the bot sets no timeout.
const TERMINAL_DEFAULT: u64 = 120;
const TERMINAL_MAX: u64 = 1800;
/// The most output a command returns, from its end.
const OUTPUT_CAP: usize = 60_000;
/// The Cua tool groups a desktop action on a real computer may use.
pub(crate) const DESKTOP_PERMISSIONS: &str = "computer:screenshot,computer:click,computer:drag,computer:scroll,computer:type,computer:key,computer:hotkey,computer:window";
/// How long a desktop action on a user's computer may take. Longer than the
/// app's own 60 s limit on a Cua call, so its answer (it ends the call)
/// always comes first and the computer stays held until then.
const DESKTOP_WAIT: Duration = Duration::from_secs(90);

pub fn device_id(computer: &str) -> Option<&str> {
    computer.strip_prefix(DEVICE).filter(|id| !id.is_empty())
}
pub fn device_computer(device: &str) -> String {
    format!("{DEVICE}{device}")
}

// ---------------------------------------------------------------- grants

// A bot's **environments** are the computers it works on: `terminal` in each
// computer's config keeps its bots, and bash runs in every one. Its desktop on
// a computer is not a grant of its own: the Computer Use connector
// (`computer_use`, a list of bots) puts the bot's environments' screens in
// reach, each where that computer's screen is shared (the bots' computer
// always; this computer once its desktop is shared; a user's computer while
// its app shares it, checked on every call).

/// The Computer Use connector's key in `computers`.
pub const COMPUTER_USE: &str = "computer_use";

fn capability(name: &str) -> Result<&'static str> {
    match name {
        TERMINAL => Ok(TERMINAL),
        DESKTOP => Err(Error::new(
            4202,
            "A desktop comes with Computer Use, a plugin: give the bot the computer, then turn Computer Use on for it in Settings, Plugins (hexbot plugins assign connector computer_use BOT).",
        )),
        _ => Err(Error::new(4202, "capability must be terminal")),
    }
}
fn valid_computer(computer: &str) -> Result<()> {
    if computer == VM || computer == HOST || device_id(computer).is_some() {
        Ok(())
    } else {
        Err(Error::new(4202, format!("unknown computer: {computer}")))
    }
}
/// `computers` in config.yaml, when this daemon has written it.
fn configured(home: &Path) -> Result<Option<Value>> {
    Ok(common::read_config_cached(home)?
        .get("computers")
        .filter(|v| v.is_object())
        .cloned())
}
fn names(value: &Value) -> Vec<String> {
    value
        .as_array()
        .map(|v| {
            v.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}
/// The bots of a daemon from before computers: every bot has the bots'
/// computer and Computer Use (it had Computer use there), and its own
/// `terminal` toolset decides this computer's terminal.
fn legacy(home: &Path, bot: &str, computer: &str, capability: &str) -> Result<bool> {
    Ok(match (computer, capability) {
        (VM, TERMINAL) => false,
        (VM, _) => true,
        (HOST, TERMINAL) => crate::connectors::legacy_toolsets(home, bot)?
            .iter()
            .any(|t| t == TERMINAL),
        _ => false,
    })
}
/// Whether the bots' computer is in use. The user can leave it off in setup.
pub fn vm_on(home: &Path) -> Result<bool> {
    Ok(configured(home)?.is_none_or(|c| c[VM]["off"] != true))
}
/// Whether this computer's desktop is shared with the bots.
pub fn host_desktop_on(home: &Path) -> Result<bool> {
    Ok(configured(home)?.is_some_and(|c| c[HOST]["desktop_on"] == true))
}
pub fn has(home: &Path, bot: &str, computer: &str, capability: &str) -> Result<bool> {
    Ok(Grants::read(home, bot)?.has(computer, capability))
}
/// One bot's grants, read once: `computers` from config.yaml, or what a
/// daemon from before computers gave it.
struct Grants {
    config: Option<Value>,
    bot: String,
    /// Before computers: whether the bot's own toolsets had a terminal.
    legacy_terminal: bool,
}
impl Grants {
    fn read(home: &Path, bot: &str) -> Result<Self> {
        let config = configured(home)?;
        let legacy_terminal = config.is_none() && legacy(home, bot, HOST, TERMINAL)?;
        Ok(Self {
            config,
            bot: bot.to_owned(),
            legacy_terminal,
        })
    }
    fn has(&self, computer: &str, capability: &str) -> bool {
        match &self.config {
            Some(c) => {
                let here = !(computer == VM && c[VM]["off"] == true)
                    && names(&c[computer][TERMINAL]).contains(&self.bot);
                match capability {
                    TERMINAL => here,
                    // Its screen, through Computer Use, where it is shared.
                    _ => {
                        here && names(&c[COMPUTER_USE]).contains(&self.bot)
                            && (computer != HOST || c[HOST]["desktop_on"] == true)
                    }
                }
            }
            None => match (computer, capability) {
                (VM, TERMINAL) => false,
                (VM, _) => true,
                (HOST, TERMINAL) => self.legacy_terminal,
                _ => false,
            },
        }
    }
    fn computers(&self) -> Vec<String> {
        let mut ids = vec![VM.to_owned(), HOST.to_owned()];
        if let Some(c) = &self.config {
            let mut devices = c
                .as_object()
                .into_iter()
                .flatten()
                .filter(|(id, _)| device_id(id).is_some())
                .map(|(id, _)| id.clone())
                .collect::<Vec<_>>();
            devices.sort();
            ids.extend(devices);
        }
        ids
    }
}
/// Whether `bot` may use some computer's terminal, and some computer's
/// desktop, by the `computers` config alone. The bots' computer counts only
/// while it can run (`vm_runs`): a bot whose only environment is a bots'
/// computer with no Cua here has no bash to offer, as its prompt lists none.
pub fn capabilities_in(computers: &Value, bot: &str, vm_runs: bool) -> (bool, bool) {
    let grants = Grants {
        config: Some(computers.clone()),
        bot: bot.to_owned(),
        legacy_terminal: false,
    };
    grants
        .computers()
        .iter()
        .filter(|id| vm_runs || id.as_str() != VM)
        .fold((false, false), |(t, d), id| {
            (t || grants.has(id, TERMINAL), d || grants.has(id, DESKTOP))
        })
}
/// The computers a bot has, in the order its tools pick a default: the bots'
/// computer first, then this one, then the user's.
pub fn granted(home: &Path, bot: &str) -> Result<Vec<(String, bool, bool)>> {
    let grants = Grants::read(home, bot)?;
    Ok(grants
        .computers()
        .into_iter()
        .filter_map(|id| {
            let terminal = grants.has(&id, TERMINAL);
            let desktop = grants.has(&id, DESKTOP);
            (terminal || desktop).then_some((id, terminal, desktop))
        })
        .collect())
}
/// Whether the bot has `capability` on any computer: its bash or
/// computer_use tool is offered only then.
/// The bots' computer counts only while it can run, as in its prompt.
pub fn any(home: &Path, bot: &str, capability: &str) -> Result<bool> {
    let vm_runs = vm_usable(home)?;
    Ok(granted(home, bot)?
        .iter()
        .filter(|(id, ..)| vm_runs || id != VM)
        .any(|(_, terminal, desktop)| {
            if capability == TERMINAL {
                *terminal
            } else {
                *desktop
            }
        }))
}
fn bot_names(home: &Path) -> Result<Vec<String>> {
    let conn = db::open(home)?;
    let mut stmt = conn.prepare("SELECT name FROM bots ORDER BY name")?;
    let rows = stmt
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows)
}
/// Writes down what a daemon from before computers gave each bot, once.
pub fn migrate(home: &Path) -> Result<()> {
    if configured(home)?.is_some() {
        return Ok(());
    }
    let bots = bot_names(home)?;
    let mut terminal = vec![];
    for bot in &bots {
        if legacy(home, bot, HOST, TERMINAL)? {
            terminal.push(bot.clone());
        }
    }
    // An install from before computers never saw setup's question: new bots
    // keep getting this computer's terminal as they did, while the daemon's
    // toolsets give it. A fresh one (no bots yet) asks in setup.
    let defaults = if bots.is_empty() {
        json!({})
    } else {
        json!({
            "host_terminal": crate::connectors::daemon_toolsets(home)?
                .iter()
                .any(|t| t == TERMINAL)
        })
    };
    common::update_config(home, |config| {
        if config.get("computers").is_some_and(Value::is_object) {
            return Ok(());
        }
        // Every bot had Computer use on the bots' computer: it keeps the bots'
        // computer as an environment and Computer Use.
        config["computers"] = json!({
            VM: {TERMINAL: bots},
            HOST: {TERMINAL: terminal},
            COMPUTER_USE: bots,
            "defaults": defaults,
        });
        Ok(())
    })
}
/// Change the bots on one computer's capability under the config lock.
fn change(
    home: &Path,
    computer: &str,
    capability: &str,
    edit: impl FnOnce(&mut Vec<String>),
) -> Result<()> {
    migrate(home)?;
    common::update_config(home, |config| {
        let list = &mut config["computers"][computer][capability];
        let mut bots = names(list);
        edit(&mut bots);
        bots.sort();
        bots.dedup();
        *list = json!(bots);
        Ok(())
    })
}
pub fn set(home: &Path, computer: &str, capability: &str, bot: &str, on: bool) -> Result<()> {
    valid_computer(computer)?;
    let capability = self::capability(capability)?;
    change(home, computer, capability, |bots| {
        bots.retain(|b| b != bot);
        if on {
            bots.push(bot.to_owned());
        }
    })
}
/// Whether `bot` has the Computer Use connector.
pub fn computer_use_on(home: &Path, bot: &str) -> Result<bool> {
    Ok(match configured(home)? {
        Some(c) => names(&c[COMPUTER_USE]).iter().any(|b| b == bot),
        // Before computers every bot had Computer use.
        None => true,
    })
}
/// The Computer Use connector's switch for one bot.
pub fn set_computer_use(home: &Path, bot: &str, on: bool) -> Result<()> {
    migrate(home)?;
    common::update_config(home, |config| {
        let list = &mut config["computers"][COMPUTER_USE];
        let mut bots = names(list);
        bots.retain(|b| b != bot);
        if on {
            bots.push(bot.to_owned());
        }
        bots.sort();
        *list = json!(bots);
        Ok(())
    })
}
/// The Computer Use connector switched for `bot`, however (the Plugins page,
/// a bot's settings, the primary bot): which screens it reaches changed, so
/// open Computers pages read them again. A bot being made says so itself.
pub fn computer_use_changed(home: &Path, bot: &str) -> Result<()> {
    let owner: Option<String> = db::open(home)?
        .query_row("SELECT owner_id FROM bots WHERE name=?", [bot], |r| {
            r.get(0)
        })
        .ok();
    if let Some(owner) = owner {
        changed(home, &owner);
    }
    Ok(())
}
/// Whether the bots' computer can run: in use, and Cua on this computer.
pub fn vm_usable(home: &Path) -> Result<bool> {
    // Read on every section build and staleness check: the cached config.
    if !vm_on(home)? {
        return Ok(false);
    }
    let cfg = common::read_config_cached(home)?;
    let env = crate::connectors::profile_credentials(home, home)?;
    Ok(crate::computers::command(&cfg, &env).is_some())
}
/// What a new bot gets on a daemon that keeps computers: the bots' computer
/// when it can run; this computer's terminal as setup chose, or when there
/// is no bots' computer and setup chose nothing; this computer's desktop
/// when setup shared it.
pub fn new_bot(home: &Path, bot: &str) -> Result<()> {
    let Some(config) = configured(home)? else {
        return Ok(());
    };
    let defaults = &config["defaults"];
    let vm = vm_usable(home)?;
    if vm {
        set(home, VM, TERMINAL, bot, true)?;
    }
    // Setup's choice wins, a no included; without one, a bot that can't have
    // the bots' computer gets this computer's terminal, as bots always did.
    let host_terminal = defaults["host_terminal"].as_bool().unwrap_or(!vm);
    if host_terminal {
        set(home, HOST, TERMINAL, bot, true)?;
    }
    // Computer Use as setup chose; without a choice, wherever a screen is in
    // reach (the bots' computer, or this one's shared desktop).
    let computer_use = defaults[COMPUTER_USE]
        .as_bool()
        .unwrap_or(vm || host_terminal && host_desktop_on(home)?);
    if computer_use {
        set_computer_use(home, bot, true)?;
    }
    Ok(())
}
/// A deleted bot leaves every computer, and its allowed apps go with it.
pub fn forget_bot(home: &Path, bot: &str) -> Result<()> {
    if configured(home)?.is_none() {
        return Ok(());
    }
    common::update_config(home, |config| {
        if let Some(computers) = config["computers"].as_object_mut() {
            for (id, entry) in computers.iter_mut() {
                if id == "apps" {
                    for apps in entry
                        .as_object_mut()
                        .into_iter()
                        .flat_map(|m| m.values_mut())
                    {
                        if let Some(map) = apps.as_object_mut() {
                            map.remove(bot);
                        }
                    }
                    continue;
                }
                if id == COMPUTER_USE {
                    let mut bots = names(entry);
                    bots.retain(|b| b != bot);
                    *entry = json!(bots);
                    continue;
                }
                if entry[TERMINAL].is_array() {
                    let mut bots = names(&entry[TERMINAL]);
                    bots.retain(|b| b != bot);
                    entry[TERMINAL] = json!(bots);
                }
            }
        }
        Ok(())
    })?;
    session_apps()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .retain(|(_, b, _, _), _| b != bot);
    Ok(())
}
/// The bot settings' Terminal switch: on gives the bot the default
/// environment when it has none; off takes every one.
/// `give` false only takes away: a new bot's tool list never adds a
/// computer setup said no to.
pub fn sync_tools(home: &Path, bot: &str, terminal: bool, give: bool) -> Result<()> {
    migrate(home)?;
    let have = any(home, bot, TERMINAL)?;
    if terminal && !have && give {
        let computer = if vm_usable(home)? { VM } else { HOST };
        set(home, computer, TERMINAL, bot, true)?;
    } else if !terminal && have {
        // Only a switch that really goes off: a computer switched off leaves
        // the list as if off, and an unrelated save must keep its
        // environments. Then every saved one goes, a switched-off computer's
        // included, so turning it back on can't bring back what was taken.
        for computer in saved_grants(home, bot, TERMINAL)? {
            set(home, &computer, TERMINAL, bot, false)?;
        }
    }
    Ok(())
}
/// The computers whose saved `capability` list names `bot`, whether or not
/// the computer is on now.
fn saved_grants(home: &Path, bot: &str, capability: &str) -> Result<Vec<String>> {
    let Some(config) = configured(home)? else {
        return Ok(vec![]);
    };
    Ok(config
        .as_object()
        .into_iter()
        .flatten()
        .filter(|(id, entry)| {
            valid_computer(id).is_ok() && names(&entry[capability]).iter().any(|b| b == bot)
        })
        .map(|(id, _)| id.clone())
        .collect())
}

// ------------------------------------------------- what a section freezes

fn host_name() -> String {
    crate::osutil::hostname().unwrap_or_else(|| "This computer".into())
}
fn host_os() -> &'static str {
    match std::env::consts::OS {
        "macos" => "macOS",
        "windows" => "Windows",
        "linux" => "Linux",
        other => other,
    }
}
/// A device's name as the user named it when pairing.
fn device_row(home: &Path, owner: &str, device: &str) -> Result<Option<String>> {
    use rusqlite::OptionalExtension;
    Ok(db::open(home)?
        .query_row(
            "SELECT name FROM devices WHERE id=? AND owner_id=? AND revoked_at IS NULL AND platform<>'local'",
            [device, owner],
            |r| r.get::<_, Option<String>>(0),
        )
        .optional()?
        .map(|name| name.unwrap_or_else(|| "A computer".into())))
}
/// The bot's computers as a section freezes them: ids, names, what each
/// offers this bot. Nothing here changes when a computer comes or goes.
pub fn session_list(home: &Path, owner: &str, bot: &str) -> Result<Value> {
    let mut out = vec![];
    for (id, terminal, desktop) in granted(home, bot)? {
        let (name, kind, os) = if id == VM {
            ("The bots' computer".to_owned(), "vm", "Linux".to_owned())
        } else if id == HOST {
            (host_name(), "host", host_os().to_owned())
        } else {
            let device = device_id(&id).unwrap_or_default();
            let Some(name) = device_row(home, owner, device)? else {
                continue;
            };
            let os = saved_os(home, &id).unwrap_or_else(|| "a desktop".into());
            (name, "device", os)
        };
        out.push(
            json!({"id":id,"name":name,"kind":kind,"os":os,"terminal":terminal,"desktop":desktop}),
        );
    }
    Ok(json!(out))
}
fn saved_os(home: &Path, computer: &str) -> Option<String> {
    configured(home).ok().flatten()?[computer]["os"]
        .as_str()
        .map(str::to_owned)
}
/// A section's computers kept to what its tools can reach.
pub fn restricted_list(list: &Value, terminal: bool, desktop: bool) -> Value {
    json!(
        list.as_array()
            .into_iter()
            .flatten()
            .filter_map(|c| {
                let t = terminal && c[TERMINAL] == true;
                let d = desktop && c[DESKTOP] == true;
                (t || d).then(|| {
                    let mut c = c.clone();
                    c[TERMINAL] = json!(t);
                    c[DESKTOP] = json!(d);
                    c
                })
            })
            .collect::<Vec<_>>()
    )
}
/// The computers a section can really reach: a terminal only when it has
/// bash, a desktop only when it has computer_use, and the bots' computer only
/// when it can run. What the prompt lists and what `tools_stale` compares.
pub fn reachable_list(list: &Value, terminal: bool, desktop: bool, vm_runs: bool) -> Value {
    let kept = restricted_list(list, terminal, desktop);
    if vm_runs {
        return kept;
    }
    json!(
        kept.as_array()
            .into_iter()
            .flatten()
            .filter(|c| c["id"] != VM)
            .cloned()
            .collect::<Vec<_>>()
    )
}
/// The computers a chat frozen before computers had, from its toolsets:
/// the bots' computer's desktop with Computer use, this computer's terminal
/// with Terminal. Only ids and capabilities, for `grants_of`.
pub fn legacy_list(toolsets: &Value) -> Value {
    let has = |set: &str| {
        toolsets
            .as_array()
            .is_some_and(|sets| sets.iter().any(|s| s == set))
    };
    let mut out = vec![];
    if has("computer_use") {
        out.push(json!({"id":VM,"terminal":false,"desktop":true}));
    }
    if has("terminal") {
        out.push(json!({"id":HOST,"terminal":true,"desktop":false}));
    }
    json!(out)
}
/// What decides whether a chat's computers changed: ids and what each
/// offers, never a name or an OS.
pub fn grants_of(list: &Value) -> Value {
    json!(
        list.as_array()
            .into_iter()
            .flatten()
            .map(|c| json!([c["id"], c[TERMINAL], c[DESKTOP]]))
            .collect::<Vec<_>>()
    )
}
/// The prompt's Computers block, from the frozen list.
pub fn prompt_block(list: &Value) -> String {
    let Some(items) = list.as_array().filter(|v| !v.is_empty()) else {
        return String::new();
    };
    let first = |cap: &str| {
        items
            .iter()
            .find(|c| c[cap] == true)
            .and_then(|c| c["id"].as_str())
    };
    let mut lines = vec![
        "\n\n# Computers\nYou can act on these computers. Name one by its id in `computer` on bash and computer_use."
            .to_owned(),
    ];
    let mut defaults = vec![];
    if let Some(id) = first(TERMINAL) {
        defaults.push(format!("bash runs on {id}"));
    }
    if let Some(id) = first(DESKTOP) {
        defaults.push(format!("computer_use acts on {id}"));
    }
    if !defaults.is_empty() {
        lines[0].push_str(&format!(" Without it, {}.", defaults.join(" and ")));
    }
    for c in items {
        let mut offers = vec![];
        if c[TERMINAL] == true {
            offers.push("terminal");
        }
        if c[DESKTOP] == true {
            offers.push("desktop");
        }
        let note = match c["kind"].as_str() {
            Some("vm") => {
                "A Linux computer you share with the other bots, separate from the user's. Run code, install programs and browse there first. It is easy to reset, so commands run there without the sandbox; risky ones may be checked first. Your working directory and file tools are on the computer Hexbot runs on, not here: copy what a command needs."
                    .to_owned()
            }
            Some("host") if c["os"] == "Windows" => {
                "The computer Hexbot runs on. Hexbot has no sandbox on Windows yet, so its terminal works only in Bypass. The user allows each app on its desktop the first time."
                    .to_owned()
            }
            Some("host") => {
                "The computer Hexbot runs on. Its terminal is sandboxed as your approval mode says; set full_access with a reason when a command needs the internet or writes outside the workspace. The user allows each app on its desktop the first time."
                    .to_owned()
            }
            _ => format!(
                "One of the user's own computers. It is online only while Hexbot is open there; a tool says when it is not. {} Your working directory and file tools are on the computer Hexbot runs on, not there. Commands there may be checked or asked about first, and the user allows each app on its desktop the first time.",
                if c["os"].as_str().is_some_and(|os| os.to_lowercase().contains("windows")) {
                    "Commands there run in PowerShell, so use PowerShell syntax."
                } else {
                    "Commands there run in the user's login shell."
                }
            ),
        };
        lines.push(format!(
            "- {}: {} ({}). {}. {}",
            c["id"].as_str().unwrap_or(""),
            c["name"].as_str().unwrap_or(""),
            c["os"].as_str().unwrap_or(""),
            offers.join(" and "),
            note
        ));
    }
    lines.join("\n")
}

// --------------------------------------------- the user's computers online

struct Endpoint {
    owner: String,
    connection: u64,
    name: String,
    os: String,
    terminal: bool,
    desktop: bool,
    sender: tokio::sync::mpsc::UnboundedSender<Value>,
}
type Pending = tokio::sync::oneshot::Sender<Result<Value>>;
#[derive(Default)]
struct Registry {
    endpoints: HashMap<(PathBuf, String), Endpoint>,
    /// Waiting requests: home, device, the connection they went out on, and
    /// the computer's name for an error the bot reads.
    pending: HashMap<String, (PathBuf, String, u64, String, Pending)>,
}
impl Registry {
    /// Fails what went out on one connection of a device: it can't answer
    /// any more, even when the device is back on another connection.
    fn fail_connection(
        &mut self,
        home: &Path,
        device: &str,
        connection: u64,
        error: fn(&str) -> Error,
    ) {
        let ids = self
            .pending
            .iter()
            .filter(|(_, (h, d, c, ..))| h == home && d == device && *c == connection)
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        for id in ids {
            if let Some((.., label, sender)) = self.pending.remove(&id) {
                let _ = sender.send(Err(error(&label)));
            }
        }
    }
}
fn registry() -> &'static Mutex<Registry> {
    static REGISTRY: OnceLock<Mutex<Registry>> = OnceLock::new();
    REGISTRY.get_or_init(Default::default)
}
fn lock() -> std::sync::MutexGuard<'static, Registry> {
    registry().lock().unwrap_or_else(|e| e.into_inner())
}
/// A connection number, so a device's older connection never detaches its newer one.
pub fn connection_id() -> u64 {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}
/// `hexbot.computers.attach`: a desktop app offers its computer. The app
/// sends what the user allowed there; attaching with neither withdraws it.
pub fn attach(
    home: &Path,
    owner: &str,
    device: &str,
    connection: u64,
    sender: tokio::sync::mpsc::UnboundedSender<Value>,
    p: &Value,
) -> Result<Value> {
    if device_row(home, owner, device)?.is_none() {
        return Err(Error::new(
            4302,
            "This is the daemon's own computer. Set it up under This computer in Settings, Computers.",
        ));
    }
    let terminal = p[TERMINAL] == true;
    let desktop = p[DESKTOP] == true;
    let key = (home.to_owned(), device.to_owned());
    let computer = device_computer(device);
    let os = p["os"]
        .as_str()
        .map(|os| os.chars().take(40).collect::<String>())
        .unwrap_or_default();
    let mut replaced = None;
    {
        let mut registry = lock();
        if !terminal && !desktop {
            if registry
                .endpoints
                .get(&key)
                .is_some_and(|e| e.connection == connection)
            {
                registry.endpoints.remove(&key);
                registry.fail_connection(home, device, connection, offline_error);
            }
        } else {
            // A newer connection replaces an older one, which may be dead
            // without anyone knowing yet. What went out on it may still be
            // running in the app, so it fails only once the app, asked on
            // the new connection, confirms it stopped everything bots
            // started there; until then it waits as before, until the old
            // connection closes or the request times out.
            replaced = registry
                .endpoints
                .get(&key)
                .map(|e| e.connection)
                .filter(|old| *old != connection)
                .filter(|old| {
                    registry
                        .pending
                        .values()
                        .any(|(h, d, c, ..)| h == home && d == device && c == old)
                });
            registry.endpoints.insert(
                key,
                Endpoint {
                    owner: owner.to_owned(),
                    connection,
                    name: p["name"]
                        .as_str()
                        .map(|n| n.chars().take(80).collect())
                        .unwrap_or_default(),
                    os: os.clone(),
                    terminal,
                    desktop,
                    sender,
                },
            );
        }
    }
    if (terminal || desktop) && !os.is_empty() && saved_os(home, &computer).as_deref() != Some(&os)
    {
        // Kept so a frozen prompt can say what the computer runs while it is
        // away; written only when it changed, so an offer rereads no config.
        migrate(home)?;
        common::update_config(home, |config| {
            config["computers"][&computer]["os"] = json!(os);
            Ok(())
        })?;
    }
    if let (Some(old), Ok(runtime)) = (replaced, tokio::runtime::Handle::try_current()) {
        let (home, owner, device) = (home.to_owned(), owner.to_owned(), device.to_owned());
        runtime.spawn(async move {
            // Marked, so the app keeps offering its computer on the new
            // connection (Forget's release takes the offer away).
            let released = device_call(
                &home,
                &owner,
                &device,
                RELEASE,
                json!({"reason":"replaced"}),
                Duration::from_secs(5),
            )
            .await
            .is_ok_and(|answer| answer["released"] == true);
            if released {
                lock().fail_connection(&home, &device, old, replaced_error);
            }
        });
    }
    changed(home, owner);
    Ok(json!({"computer":computer,"attached":terminal || desktop}))
}
/// The connection closed: its computer goes offline and its waiting work fails.
pub fn detach(home: &Path, device: &str, connection: u64) {
    let owner = {
        let mut registry = lock();
        let key = (home.to_owned(), device.to_owned());
        // What went out on this connection fails, even when the device is
        // already back on a newer one.
        registry.fail_connection(home, device, connection, offline_error);
        if !registry
            .endpoints
            .get(&key)
            .is_some_and(|e| e.connection == connection)
        {
            return;
        }
        registry.endpoints.remove(&key).map(|e| e.owner)
    };
    if let Some(owner) = owner {
        // Its screen may differ when it comes back: the next pointed action
        // waits for a new screenshot.
        SHOTS
            .get_or_init(Default::default)
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&(home.to_owned(), format!("device:{device}")));
        changed(home, &owner);
    }
}
/// `hexbot.computers.reply`: the app's answer to one request. Only the device
/// that was asked can answer it.
pub fn reply(home: &Path, device: &str, p: &Value) -> Result<Value> {
    let id = common::required(p, "request_id")?;
    let sender = {
        let mut registry = lock();
        match registry.pending.get(id) {
            Some((h, d, ..)) if h == home && d == device => registry.pending.remove(id),
            _ => None,
        }
    };
    let Some((.., sender)) = sender else {
        return Err(Error::new(4204, "request is no longer waiting"));
    };
    let result = match p["error"].as_str() {
        Some(error) => Err(Error::new(
            4211,
            error.chars().take(2000).collect::<String>(),
        )),
        None => Ok(p["result"].clone()),
    };
    let _ = sender.send(result);
    Ok(json!({"ok":true}))
}
/// A request on a connection that a newer one replaced, stopped once the
/// app confirmed it: the computer is back, so the bot can try again.
fn replaced_error(name: &str) -> Error {
    Error::new(
        4212,
        format!("The connection to {name} was replaced and this was stopped there. Try again."),
    )
}
fn offline_error(name: &str) -> Error {
    Error::new(
        4212,
        format!(
            "{name} is offline: Hexbot is not open there, or the user stopped bots on it. Tell the user, or use another computer."
        ),
    )
}
fn online(home: &Path, device: &str) -> Option<(bool, bool, String, String)> {
    lock()
        .endpoints
        .get(&(home.to_owned(), device.to_owned()))
        .map(|e| (e.terminal, e.desktop, e.name.clone(), e.os.clone()))
}
/// Sends one request to a user's computer and waits for its answer.
async fn device_call(
    home: &Path,
    owner: &str,
    device: &str,
    kind: &str,
    payload: Value,
    wait: Duration,
) -> Result<Value> {
    device_call_until(home, owner, device, kind, payload, wait, None).await
}
/// `device_call` that also watches `stop`: when it turns true (the chat was
/// stopped), the computer is told to end the request, and the call keeps
/// waiting for its answer, so whoever holds the computer holds it until the
/// request has settled.
#[allow(clippy::too_many_arguments)]
async fn device_call_until(
    home: &Path,
    owner: &str,
    device: &str,
    kind: &str,
    mut payload: Value,
    wait: Duration,
    stop: Option<tokio::sync::watch::Receiver<bool>>,
) -> Result<Value> {
    let label = device_row(home, owner, device)?.unwrap_or_else(|| "That computer".into());
    let id = common::id();
    let (sender, receiver) = tokio::sync::oneshot::channel();
    {
        let mut registry = lock();
        let key = (home.to_owned(), device.to_owned());
        let Some(endpoint) = registry.endpoints.get(&key).filter(|e| e.owner == owner) else {
            return Err(offline_error(&label));
        };
        let allowed = match kind {
            TERMINAL => endpoint.terminal,
            DESKTOP => endpoint.desktop,
            _ => true,
        };
        if !allowed {
            return Err(Error::new(
                4302,
                if kind == TERMINAL {
                    format!(
                        "{label} does not let bots work on it. The user turns on Let bots work here in Hexbot on that computer."
                    )
                } else {
                    format!(
                        "{label} does not let Computer Use reach its screen. The user turns on Computer Use here in Hexbot on that computer."
                    )
                },
            ));
        }
        payload["request_id"] = json!(id);
        payload["kind"] = json!(kind);
        let frame = json!({"jsonrpc":"2.0","method":"event","params":{"type":"hexbot.computers.request","session_id":null,"payload":payload}});
        if endpoint.sender.send(frame).is_err() {
            return Err(offline_error(&label));
        }
        let connection = endpoint.connection;
        registry.pending.insert(
            id.clone(),
            (
                home.to_owned(),
                device.to_owned(),
                connection,
                label.clone(),
                sender,
            ),
        );
    }
    // Dropped before its answer (the user stopped the chat): the computer is
    // told to end that one request.
    struct Cancel<'a> {
        home: &'a Path,
        device: &'a str,
        id: String,
        done: bool,
    }
    impl Drop for Cancel<'_> {
        fn drop(&mut self) {
            if self.done {
                return;
            }
            let mut registry = lock();
            registry.pending.remove(&self.id);
            if let Some(endpoint) = registry
                .endpoints
                .get(&(self.home.to_owned(), self.device.to_owned()))
            {
                let frame = json!({"jsonrpc":"2.0","method":"event","params":{"type":"hexbot.computers.request","session_id":null,"payload":{"kind":"cancel","request_id":common::id(),"cancels":self.id}}});
                let _ = endpoint.sender.send(frame);
            }
        }
    }
    let mut cancel = Cancel {
        home,
        device,
        id: id.clone(),
        done: false,
    };
    // Some(answer) when it came, None when the wait ran out.
    let answer = match stop {
        None => tokio::time::timeout(wait, receiver).await.ok(),
        Some(mut stop) => {
            let deadline = tokio::time::Instant::now() + wait;
            let mut receiver = receiver;
            let mut told = false;
            loop {
                tokio::select! {
                    got = &mut receiver => break Some(got),
                    _ = tokio::time::sleep_until(deadline) => break None,
                    changed = stop.changed(), if !told => {
                        if changed.is_err() || *stop.borrow() {
                            told = true;
                            if let Some(endpoint) = lock()
                                .endpoints
                                .get(&(home.to_owned(), device.to_owned()))
                            {
                                let frame = json!({"jsonrpc":"2.0","method":"event","params":{"type":"hexbot.computers.request","session_id":null,"payload":{"kind":"cancel","request_id":common::id(),"cancels":id}}});
                                let _ = endpoint.sender.send(frame);
                            }
                        }
                    }
                }
            }
        }
    };
    // An answer arrived: nothing to cancel. A timeout leaves the guard to
    // tell the computer, so a late action is refused there.
    cancel.done = answer.is_some();
    drop(cancel);
    lock().pending.remove(&id);
    match answer {
        Some(Ok(result)) => result,
        Some(Err(_)) => Err(offline_error(&label)),
        None => Err(Error::new(
            4211,
            format!("{label} took too long to answer."),
        )),
    }
}
/// Tells the owner's apps to read the computers again.
pub(crate) fn changed(home: &Path, owner: &str) {
    if let Some(events) = hubs().lock().unwrap_or_else(|e| e.into_inner()).get(home) {
        events.emit(owner, None, "hexbot.computers.changed", json!({}));
    }
}
fn hubs() -> &'static Mutex<HashMap<PathBuf, crate::events::EventHub>> {
    static HUBS: OnceLock<Mutex<HashMap<PathBuf, crate::events::EventHub>>> = OnceLock::new();
    HUBS.get_or_init(Default::default)
}
pub fn attach_events(home: &Path, events: crate::events::EventHub) {
    hubs()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(home.to_owned(), events);
}

// ------------------------------------------------------------- terminals

/// Runs a command on the bots' computer or a user's computer. This
/// computer's terminal is Pi's bash, which the extension runs itself.
/// `still` checks, right before the command is sent, that the approval
/// mode its gate decided under is still the section's.
pub async fn terminal(
    home: &Path,
    owner: &str,
    bot: &str,
    computer: &str,
    command: &str,
    timeout: Option<u64>,
    still: impl Fn() -> Result<()>,
) -> Result<Value> {
    if command.trim().is_empty() {
        return Err(Error::new(4202, "command is empty"));
    }
    if !has(home, bot, computer, TERMINAL)? {
        return Err(not_granted(computer, "terminal"));
    }
    let seconds = timeout.unwrap_or(TERMINAL_DEFAULT).clamp(1, TERMINAL_MAX);
    if computer == VM {
        // Pause bots gives the user the bots' computer alone: no new commands.
        crate::computers::refuse_if_paused(home)?;
        let (cfg, env) = crate::computers::setup(home)?;
        crate::computers::ensure(home, &cfg, &env).await?;
        crate::computers::refuse_if_paused(home)?;
        // Starting the computer can take a while: a grant taken away
        // meanwhile applies.
        if !has(home, bot, computer, TERMINAL)? {
            return Err(not_granted(computer, "terminal"));
        }
        still()?;
        let sandbox = crate::computers::sandbox(home);
        let limit = seconds.to_string();
        // Its own session there, with its process group's id in a file, so a
        // stopped chat ends the command and what it started.
        let run = common::id();
        let line = vm_line(&run, command);
        struct Stop {
            cfg: Value,
            env: std::collections::BTreeMap<String, String>,
            sandbox: String,
            run: String,
            done: bool,
        }
        impl Drop for Stop {
            fn drop(&mut self) {
                if self.done {
                    return;
                }
                let (cfg, env, sandbox, run) = (
                    self.cfg.clone(),
                    self.env.clone(),
                    self.sandbox.clone(),
                    self.run.clone(),
                );
                if let Ok(handle) = tokio::runtime::Handle::try_current() {
                    handle.spawn(async move {
                        let kill = vm_stop_line(&run);
                        let _ = crate::computers::cua(
                            &cfg,
                            &env,
                            &["sb", "exec", &sandbox, "--timeout", "20", "--", &kill],
                            40,
                        )
                        .await;
                    });
                }
            }
        }
        let mut stop = Stop {
            cfg: cfg.clone(),
            env: env.clone(),
            sandbox: sandbox.clone(),
            run,
            done: false,
        };
        let out = crate::computers::cua(
            &cfg,
            &env,
            &["sb", "exec", &sandbox, "--timeout", &limit, "--", &line],
            seconds + 30,
        )
        .await;
        stop.done = finished(&out);
        let out = out?;
        let mut text = out.stdout;
        if !out.stderr.trim().is_empty() {
            if !text.is_empty() && !text.ends_with('\n') {
                text.push('\n');
            }
            text.push_str(&out.stderr);
        }
        return Ok(command_result(text, out.code, out.code == 124, seconds));
    }
    let Some(device) = device_id(computer) else {
        return Err(Error::new(
            4202,
            "This computer's terminal runs through bash itself.",
        ));
    };
    still()?;
    let answer = device_call(
        home,
        owner,
        device,
        TERMINAL,
        json!({"command":command,"timeout":seconds}),
        Duration::from_secs(seconds + 30),
    )
    .await?;
    let code = answer["exit_code"].as_i64().unwrap_or(-1) as i32;
    Ok(command_result(
        answer["output"].as_str().unwrap_or("").to_owned(),
        code,
        answer["timed_out"] == true,
        seconds,
    ))
}
/// Whether a command on the bots' computer ended on its own. Cua's time limit
/// (exit 124) doesn't end it: the command runs in a session of its own, so
/// the stop line must still end its group.
fn finished(out: &Result<crate::computers::Output>) -> bool {
    out.as_ref().is_ok_and(|o| o.code != 124)
}
/// The shell line that runs `command` on the bots' computer in a session
/// of its own (`setsid -w` waits for it), leaving its process group's id in
/// /tmp/hexbot-run-<run> for a stop to end.
///
/// A stop and a start can't miss each other: the command writes its group's
/// id first and then looks for the stop's marker; a stop writes the marker
/// first and then reads the id (`vm_stop_line`).
fn vm_line(run: &str, command: &str) -> String {
    let quoted = format!("'{}'", command.replace('\'', "'\\''"));
    format!(
        "setsid -w sh -c 'echo $$ > /tmp/hexbot-run-{run}; if [ -e /tmp/hexbot-stop-{run} ]; then rm -f /tmp/hexbot-run-{run} /tmp/hexbot-stop-{run}; exit 130; fi; if command -v bash >/dev/null 2>&1; then bash -c \"$1\"; else sh -c \"$1\"; fi; code=$?; rm -f /tmp/hexbot-run-{run}; exit $code' _ {quoted}"
    )
}
/// What a stop runs on the bots' computer: its marker first, then the group.
fn vm_stop_line(run: &str) -> String {
    format!(
        "touch /tmp/hexbot-stop-{run}; if [ -e /tmp/hexbot-run-{run} ]; then kill -s KILL -- \"-$(cat /tmp/hexbot-run-{run})\" 2>/dev/null; rm -f /tmp/hexbot-run-{run}; fi"
    )
}
fn command_result(mut output: String, code: i32, timed_out: bool, seconds: u64) -> Value {
    if output.len() > OUTPUT_CAP {
        let mut start = output.len() - OUTPUT_CAP;
        while !output.is_char_boundary(start) {
            start += 1;
        }
        output = format!("[earlier output cut]\n{}", &output[start..]);
    }
    if timed_out {
        output.push_str(&format!(
            "\n[Stopped after {seconds} s. Run long jobs in the background and check on them.]"
        ));
    } else if code != 0 {
        output.push_str(&format!("\n[exit code {code}]"));
    }
    json!({"output":output,"exit_code":code,"timed_out":timed_out})
}
fn not_granted(computer: &str, what: &str) -> Error {
    let where_ = if what == DESKTOP {
        "Settings, Computers (the computer) and Settings, Plugins (Computer Use)"
    } else {
        "Settings, Computers"
    };
    Error::new(
        4302,
        format!(
            "You can't use the {what} of {computer}. Your Computers list says what you may use; the user changes it in {where_}."
        ),
    )
}

// ---------------------------------------------------------------- desktops

/// This computer's Cua target: the direct connection `cua host setup
/// --direct` serves on loopback. Looked up at most every 30 s.
type HostFound = Option<(Instant, Option<String>)>;
static HOST_TARGET: OnceLock<Mutex<HostFound>> = OnceLock::new();
async fn host_target(home: &Path) -> Result<String> {
    let cache = HOST_TARGET.get_or_init(Default::default);
    if let Some((at, found)) = cache.lock().unwrap_or_else(|e| e.into_inner()).clone()
        && at.elapsed() < Duration::from_secs(30)
    {
        return found.ok_or_else(host_not_set_up);
    }
    let (cfg, env) = crate::computers::setup(home)?;
    let out = crate::computers::cua(&cfg, &env, &["sb", "ls", "--json"], 30).await?;
    let found = serde_json::from_str::<Value>(out.stdout.trim())
        .ok()
        .and_then(|list| {
            list.as_array()?
                .iter()
                .find(|s| {
                    s["location"] == "direct"
                        && s["id"].as_str().is_some_and(local_direct)
                        && s["state"] == "running"
                })
                .and_then(|s| s["id"].as_str().map(str::to_owned))
        });
    *cache.lock().unwrap_or_else(|e| e.into_inner()) = Some((Instant::now(), found.clone()));
    found.ok_or_else(host_not_set_up)
}
fn local_direct(id: &str) -> bool {
    ["direct:127.0.0.1:", "direct:localhost:", "direct:[::1]:"]
        .iter()
        .any(|prefix| id.starts_with(prefix))
}
fn host_not_set_up() -> Error {
    Error::new(
        4302,
        "This computer's desktop is not set up for bots yet. The user sets it up in Settings, Computers.",
    )
}
/// Sets this computer up so Cua can use its desktop: a direct connection on
/// loopback that never joins Cua's relay. macOS then asks once for Screen
/// Recording and Accessibility.
pub async fn setup_host_desktop(home: &Path) -> Result<Value> {
    if host_target(home).await.is_ok() {
        return Ok(json!({"ok":true}));
    }
    let (cfg, env) = crate::computers::setup(home)?;
    let out = crate::computers::cua(
        &cfg,
        &env,
        &[
            "host",
            "setup",
            "--direct",
            "127.0.0.1:3211",
            "--no-provide-spaces",
            "--json",
        ],
        300,
    )
    .await?;
    if out.code != 0 {
        return Err(crate::computers::failure(
            &out.stderr,
            "Cua could not set up this computer's desktop.",
        ));
    }
    // What was cached before setup is stale: look again.
    *HOST_TARGET
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = None;
    host_target(home).await?;
    Ok(json!({"ok":true}))
}
/// Calls one Cua tool on a computer's desktop. `vm` is never asked here;
/// it has its own path with turns, the viewer and pause (`computers::act`).
async fn desktop_call(
    home: &Path,
    owner: &str,
    bot: &str,
    computer: &str,
    tool: &str,
    params: Value,
) -> Result<Value> {
    desktop_send(home, owner, bot, computer, None, tool, params).await
}
fn changed_under() -> Error {
    Error::new(
        4302,
        "The screen changed before this ran. Take a screenshot and try again.",
    )
}
/// One Cua tool on this computer's desktop (its target found already, or
/// found now) or a user's computer's.
#[allow(clippy::too_many_arguments)]
async fn desktop_send(
    home: &Path,
    owner: &str,
    bot: &str,
    computer: &str,
    target: Option<&str>,
    tool: &str,
    params: Value,
) -> Result<Value> {
    desktop_send_until(
        home, owner, bot, computer, target, tool, params, None, false,
    )
    .await
}
/// The final send of an action: `stop` carries a stopped chat to a user's
/// computer, and `final_send` requires this computer's Cua session to be the
/// one already up when the action was last checked.
#[allow(clippy::too_many_arguments)]
async fn desktop_send_until(
    home: &Path,
    owner: &str,
    bot: &str,
    computer: &str,
    target: Option<&str>,
    tool: &str,
    params: Value,
    stop: Option<tokio::sync::watch::Receiver<bool>>,
    final_send: bool,
) -> Result<Value> {
    let result = if computer == HOST {
        let target = match target {
            Some(target) => target.to_owned(),
            None => host_target(home).await?,
        };
        let (cfg, env) = crate::computers::setup(home)?;
        let program =
            crate::computers::command(&cfg, &env).ok_or_else(crate::computers::unavailable)?;
        let server = json!({
            "command": program,
            // Only the tool groups desktop actions use: never Cua's shell,
            // files, clipboard or accessibility actions on a real computer.
            "args": ["mcp", "--sandbox", target, "--permissions", DESKTOP_PERMISSIONS],
            "isolated_env": true,
            "env": crate::computers::overrides(&cfg),
            "client_name": "Hexbot",
        });
        // Once this computer's session is up and held: the chat wasn't
        // stopped, and its switch and the bot's grant are still on.
        crate::connectors::mcp_call_config_checked(
            home,
            bot,
            "hexbot-this-computer",
            &server,
            tool,
            params,
            final_send,
            || {
                if stop.as_ref().is_some_and(|stop| *stop.borrow()) {
                    return Err(Error::new(5201, "The action was stopped."));
                }
                allowed_here(home, bot, computer)
            },
        )
        .await?
    } else {
        let device = device_id(computer).ok_or_else(|| not_granted(computer, "desktop"))?;
        // Right before it is queued: refused, never sent, when the chat was
        // already stopped or the bot lost the computer meanwhile.
        if final_send {
            if stop.as_ref().is_some_and(|stop| *stop.borrow()) {
                return Err(Error::new(5201, "The action was stopped."));
            }
            allowed_here(home, bot, computer)?;
        }
        device_call_until(
            home,
            owner,
            device,
            DESKTOP,
            // A final action goes only through the Cua session already up there.
            json!({"tool":tool,"args":params,"final":final_send}),
            DESKTOP_WAIT,
            stop,
        )
        .await?
    };
    if result["isError"] == true {
        return Err(Error::new(
            4211,
            format!(
                "computer action {tool} failed: {}",
                result["content"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|v| v["text"].as_str())
                    .collect::<Vec<_>>()
                    .join("\n")
            ),
        ));
    }
    Ok(result)
}
/// Window titles of a browser's script console (Chrome, Edge, Safari, Firefox).
const DEVTOOLS: [&str; 4] = [
    "devtools",
    "web inspector",
    "developer tools",
    "browser toolbox",
];
/// Apps that never take a bot's input on the user's computers: a terminal
/// would bypass the terminal's approvals, and Hexbot would approve itself.
pub fn blocked_app(app: &str) -> Option<&'static str> {
    let lower = app.to_lowercase();
    // "term" catches most emulators by name (Terminal, xterm, urxvt's
    // rxvt-term, WezTerm, Windows Terminal, xfce4-terminal…); the rest are
    // named. Shells and remote consoles count too.
    const TERMINALS: [&str; 42] = [
        "term",
        "rxvt",
        "foot",
        "warp",
        "ghostty",
        "kitty",
        "alacritty",
        "konsole",
        "console",
        "tilix",
        "tilda",
        "guake",
        "yakuake",
        "sakura",
        "terminator",
        "hyper",
        "tabby",
        "contour",
        "rio",
        "cool-retro",
        "putty",
        "mintty",
        "conemu",
        "cmder",
        "powershell",
        "pwsh",
        "cmd.exe",
        "command prompt",
        "wsl",
        "termius",
        "ssh",
        "tmux",
        "screen",
        "conhost",
        "command processor",
        "ptyxis",
        "blackbox",
        "black box",
        "xshell",
        "securecrt",
        // foot in client mode and Warp's preview build, by their own names.
        "footclient",
        "warppreview",
    ];
    // A process name as Cua may report it: "/bin/zsh", "-zsh" (a login
    // shell), "bash.exe" all mean the shell.
    let base = lower.trim().rsplit(['/', '\\']).next().unwrap_or("");
    let base = base
        .trim_start_matches('-')
        .trim_matches(['(', '[', ')', ']']);
    let base = base.strip_suffix(".exe").unwrap_or(base);
    let exact = [
        "st", "cmd", "bash", "zsh", "fish", "sh", "dash", "ksh", "tcsh", "csh", "nu", "xonsh",
        "elvish", "python", "python3", "node", "irb", "ubuntu", "debian", "idle", "idle3",
        // Interpreters and command runners, so "env python3 x.py" or
        // "nohup sh" isn't an app's name.
        "r", "julia", "ruby", "perl", "php", "lua", "env", "nohup", "nice", "timeout", "setsid",
        "exec", "sudo", "doas", "xargs",
    ];
    if exact.contains(&base) {
        return Some(
            "Terminal apps never take a bot's input. Use bash with this computer instead.",
        );
    }
    if lower.contains("hexbot") {
        return Some("Hexbot itself never takes a bot's input.");
    }
    if editor(&lower) || editor(base) {
        return Some(
            "Editors and IDEs never take a bot's input: their own buttons can run code past the terminal's approvals. Edit files with bash instead.",
        );
    }
    // Apps with a terminal of their own, and terminals whose names say
    // nothing ("Wave", "Prompt 3"): whole words, so Wavebox isn't one.
    let named: Vec<&str> = lower.split(|c: char| !c.is_alphanumeric()).collect();
    if lower.contains("docker desktop") || named.contains(&"wave") || lower.contains("prompt 3") {
        return Some(
            "Apps with a terminal of their own never take a bot's input: it runs commands past the terminal's approvals. Use bash with this computer instead.",
        );
    }
    // Coding agents run commands on that computer themselves.
    const AGENTS: [&str; 10] = [
        "claude",
        "codex",
        "t3 code",
        "antigravity",
        "kiro",
        "trae",
        "void",
        "goose",
        "opencode",
        "conductor",
    ];
    let words: Vec<&str> = lower.split(|c: char| !c.is_alphanumeric()).collect();
    if AGENTS.iter().any(|a| {
        if a.len() <= 4 {
            words.contains(a)
        } else {
            lower.contains(a)
        }
    }) {
        return Some(
            "Coding agents never take a bot's input: they run commands past the terminal's approvals. Use bash with this computer instead.",
        );
    }
    if DEVTOOLS.iter().any(|d| lower.contains(d)) {
        return Some(
            "A browser's developer tools never take a bot's input: their console runs code in any page, Hexbot's included.",
        );
    }
    // Apps whose job is running scripts or typed commands, and Windows' Run box.
    const SCRIPTS: [&str; 27] = [
        "script editor",
        "automator",
        "shortcuts",
        "applescript",
        "alfred",
        "krunner",
        "powertoys",
        "powerlauncher",
        "raycast",
        "spotlight",
        "searchhost",
        "searchapp",
        "startmenuexperiencehost",
        "windows search",
        "task manager",
        "taskmgr",
        "task scheduler",
        "taskschd",
        "management console",
        "notepad++",
        "power automate",
        "pad.designer",
        "keyboard maestro",
        "osascript",
        "wscript",
        "cscript",
        "mshta",
    ];
    // Launchers that run what is typed in them ("> cmd"), the short ones
    // as whole words so "Albertsons" or "Wordle" aren't.
    const LAUNCHERS: [&str; 4] = ["flow launcher", "ulauncher", "xfce4-appfinder", "appfinder"];
    const SHORT_LAUNCHERS: [&str; 5] = ["wox", "albert", "rofi", "wofi", "dmenu"];
    let words: Vec<&str> = lower.split(|c: char| !c.is_alphanumeric()).collect();
    if matches!(lower.trim(), "run" | "search" | "start")
        || matches!(base, "run" | "search" | "start" | "mmc")
        || SCRIPTS.iter().any(|s| lower.contains(s))
        || LAUNCHERS.iter().any(|s| lower.contains(s))
        || SHORT_LAUNCHERS.iter().any(|s| words.contains(s))
        || base.starts_with("dmenu")
    {
        return Some(
            "Script, automation and launcher apps never take a bot's input: they run commands past the terminal's approvals. Use bash with this computer instead.",
        );
    }
    // Remote desktops reach another computer's terminals and Hexbot itself.
    const REMOTE: [&str; 14] = [
        "teamviewer",
        "anydesk",
        "parsec",
        "rustdesk",
        "remote desktop",
        "mstsc",
        "jump desktop",
        "iphone mirroring",
        "windows app",
        "chrome remote",
        "remmina",
        "nomachine",
        "splashtop",
        "royal ts",
    ];
    if lower.contains("vnc") || REMOTE.iter().any(|r| lower.contains(r)) {
        return Some(
            "Remote desktop apps never take a bot's input: they reach another computer past its approvals.",
        );
    }
    // Short names match whole words only, so "Priority Matrix", "Screenshot"
    // or Spanish macOS's "Calendario" isn't a terminal; the rest anywhere.
    const WHOLE: [&str; 7] = ["rio", "foot", "warp", "hyper", "screen", "kitty", "tilda"];
    let words: Vec<&str> = lower.split(|c: char| !c.is_alphanumeric()).collect();
    if TERMINALS.iter().any(|t| {
        if WHOLE.contains(t) {
            words.contains(t)
        } else {
            lower.contains(t)
        }
    }) {
        return Some(
            "Terminal apps never take a bot's input. Use bash with this computer instead.",
        );
    }
    None
}
/// Editors and IDEs: their terminals, run buttons and tasks start commands
/// past the terminal's approvals, so they take no input at all.
fn editor(lower: &str) -> bool {
    const EDITORS: [&str; 35] = [
        "code",
        "codium",
        "emacs",
        "vim",
        "macvim",
        "gvim",
        "neovim",
        "eclipse",
        "rstudio",
        "positron",
        "kate",
        "visual studio",
        "visualstudio",
        "vscode",
        "spyder",
        "thonny",
        "jupyter",
        "vs code",
        "cursor",
        "windsurf",
        "zed",
        "xcode",
        "intellij",
        "pycharm",
        "webstorm",
        "goland",
        "rider",
        "clion",
        "rubymine",
        "phpstorm",
        "datagrip",
        "android studio",
        "fleet",
        "nova",
        "sublime",
    ];
    EDITORS.iter().any(|e| {
        lower == *e || lower.starts_with(&format!("{e} ")) || lower.contains(e) && e.len() > 4
    })
}
/// Words for an app whose card should say more about what it reaches.
fn app_warning(app: &str) -> Option<&'static str> {
    let lower = app.to_lowercase();
    // Short names match whole words only: "Edge", not "Knowledge".
    let words: Vec<&str> = lower.split(|c: char| !c.is_alphanumeric()).collect();
    if [
        "safari", "chrome", "firefox", "edge", "msedge", "arc", "brave", "opera", "vivaldi",
    ]
    .iter()
    .any(|b| {
        if b.len() <= 4 {
            words.contains(b)
        } else {
            lower.contains(b)
        }
    }) {
        Some(
            "A browser is signed in to your accounts; the bot can read and act on anything open there, Hexbot and Hex Connect included if you're signed in to them in this browser.",
        )
    } else if [
        "microsoft word",
        "microsoft excel",
        "microsoft powerpoint",
        "microsoft outlook",
        "microsoft access",
        "libreoffice",
    ]
    .iter()
    .any(|o| lower.contains(o))
        // Windows process names: EXCEL.EXE, WINWORD.EXE, olk.exe, soffice.
        || [
            "excel", "winword", "powerpnt", "outlook", "olk", "msaccess", "soffice",
        ]
        .iter()
        .any(|o| words.contains(o))
    {
        Some(
            "Office apps run macros, which can run commands on your computer past the terminal's approvals.",
        )
    } else if lower.contains("regedit") || lower.contains("registry editor") {
        Some("Registry Editor can change how Windows and its programs start and run.")
    } else if lower.contains("explorer") {
        Some(
            "File Explorer can move, rename and delete your files, open or run any program or script on it, and run commands typed in its address bar.",
        )
    } else if ["finder", "files", "nautilus", "dolphin"]
        .iter()
        .any(|b| lower.contains(b))
        // The Dock and Launchpad open any app or file dropped on them, whole
        // words so a "Dockside" app isn't one.
        || ["dock", "launchpad"].iter().any(|b| words.contains(b))
    {
        Some(
            "A file manager can move, rename and delete your files, and open or run any program or script on it.",
        )
    } else if ["system settings", "system preferences", "settings"]
        .iter()
        .any(|b| lower.contains(b))
    {
        Some("System settings can change how your computer works and who can use it.")
    } else {
        None
    }
}
/// A key combination the system takes before the focused app does: the
/// Windows or Super key, and the launchers that open a terminal or search.
/// `mac` says the computer runs macOS; anywhere else, or when it isn't
/// known, Cmd is the same key as Windows or Super (Cua has one logo key).
fn system_shortcut(keys: &str, mac: bool) -> bool {
    // One name per key: "Super_L", "winleft" and "RWin" are all "win".
    let parts: Vec<String> = keys.split('+').map(key_name).collect();
    let has = |k: &str| parts.iter().any(|p| p == k);
    has("win")
        || !mac && has("cmd")
        // Terminal, run boxes and launchers (Alt+F2, Xfce's Alt+F3, KRunner,
        // Alfred, Raycast, PowerToys Run), Spotlight, the Start menu, Task
        // Manager.
        || has("ctrl") && has("alt") && has("t")
        || has("alt") && (has("f2") || has("f3") || has("space"))
        || has("cmd") && has("space")
        || has("ctrl") && has("esc")
}
/// The OS a computer runs, when known: this computer's own, or what one of
/// the user's computers reported when it last offered itself.
fn computer_os(home: &Path, computer: &str) -> Option<String> {
    if computer == HOST {
        Some(host_os().to_owned())
    } else {
        saved_os(home, computer)
    }
}
/// The keys that open a browser's developer tools: F12, Ctrl+Shift+I/J/C/K,
/// Cmd+Option+I/J/C/K (K is Firefox's Web Console).
fn devtools_shortcut(keys: &str) -> bool {
    let parts: Vec<String> = keys.split('+').map(key_name).collect();
    let has = |k: &str| parts.iter().any(|p| p == k);
    let letter = has("i") || has("j") || has("c") || has("k");
    has("f12") || has("ctrl") && has("shift") && letter || has("cmd") && has("alt") && letter
}
/// A key's one name, whatever side or spelling: "Super_L" and "winleft" are
/// "win", "Control_R" is "ctrl", "Option" is "alt".
fn key_name(key: &str) -> String {
    let key = key.trim().to_lowercase().replace(['_', '-', ' '], "");
    let key = key
        .strip_suffix("left")
        .or_else(|| key.strip_suffix("right"))
        .filter(|base| !base.is_empty())
        .unwrap_or(&key);
    let key = match key {
        "superl" | "superr" | "metal" | "metar" | "hyperl" | "hyperr" | "controll" | "controlr"
        | "altl" | "altr" | "shiftl" | "shiftr" | "cmdl" | "cmdr" => &key[..key.len() - 1],
        _ => key,
    };
    match key {
        // Hyper shares Super's modifier on Linux: the same logo key.
        "lwin" | "rwin" | "windows" | "super" | "meta" | "hyper" | "os" => "win",
        "control" | "ctl" | "lctrl" | "rctrl" => "ctrl",
        "command" | "lcmd" | "rcmd" => "cmd",
        "option" | "opt" | "lalt" | "ralt" => "alt",
        "escape" => "esc",
        other => other,
    }
    .to_owned()
}
/// Actions that only look: they reach no app.
fn looks_only(action: &str) -> bool {
    matches!(action, "screenshot" | "windows" | "wait" | "move")
}
/// The apps an action reaches, by what it actually does: the app it
/// launches, the window under each point of a click, scroll or drag, and the
/// focused window for typing and keys, which ignore coordinates. An action
/// whose app can't be told is refused, never approved under another name.
async fn target_apps(
    home: &Path,
    owner: &str,
    bot: &str,
    computer: &str,
    action: &str,
    args: &Value,
) -> Result<Vec<String>> {
    // Read exactly as `computers::translate` reads what it sends (two whole
    // numbers), so the point checked is the point pressed.
    let point = |key: &str| {
        args[key]
            .as_array()
            .filter(|p| p.len() == 2)
            .and_then(|p| Some((p[0].as_i64()? as f64, p[1].as_i64()? as f64)))
    };
    match action {
        "launch" => {
            let app = common::required(args, "app")?.trim().to_owned();
            // An app id or path (com.microsoft.VSCode, code.desktop, an .exe)
            // would slip past the names the checks know: the app's name only.
            let lower = app.to_lowercase();
            let id_like = app.contains(['/', '\\'])
                || [".desktop", ".app", ".exe"]
                    .iter()
                    .any(|e| lower.ends_with(e))
                || app.matches('.').count() >= 2 && !app.contains(' ');
            if id_like {
                return Err(Error::new(
                    4202,
                    "Launch an app by its name as the screen shows it (such as Notes), not an app id or path.",
                ));
            }
            // A command line, not an app's name: quotes, shell characters, a
            // control character (a line break could end the name) or an
            // option word. Parentheses only as a trailing qualifier, as
            // Windows names apps ("Outlook (new)"), never "(sh x.sh)".
            let qualifier = match (app.find('('), app.rfind(')')) {
                (None, None) => true,
                (Some(open), Some(close)) => {
                    open > 0
                        && app[..open].ends_with(' ')
                        && close == app.len() - 1
                        && app.matches('(').count() == 1
                        && app.matches(')').count() == 1
                }
                _ => false,
            };
            if !qualifier
                || app.contains([
                    '\'', '"', '`', '$', '|', ';', '&', '<', '>', '{', '}', '[', ']', ',',
                ])
                || app.chars().any(char::is_control)
                || app.split_whitespace().any(|word| word.starts_with('-'))
            {
                return Err(Error::new(
                    4202,
                    "Launch an app by its name as the screen shows it (such as Notes), not a command line.",
                ));
            }
            // A trailing qualifier's words are checked too: "Notes (bash)".
            if let Some(reason) = app
                .find('(')
                .map(|open| app[open..].trim_matches(['(', ')']).trim())
                .and_then(|inside| {
                    blocked_app(inside)
                        .or_else(|| inside.split_whitespace().next().and_then(blocked_app))
                })
            {
                return Err(Error::new(4302, reason));
            }
            // The first word too, so "bash something" is a shell.
            if let Some(reason) = app
                .split_whitespace()
                .next()
                .filter(|first| *first != app)
                .and_then(blocked_app)
            {
                return Err(Error::new(4302, reason));
            }
            // An app's name of several words starts with a capital ("Microsoft
            // Teams", "LibreOffice Calc"); one starting with a lowercase word
            // reads as a command and its arguments ("flock x touch y",
            // "dbus-launch sh"), whatever the program, so it isn't launched.
            // That helps where program names are case-sensitive (Linux);
            // Windows ignores case, so the comma refused above closes its
            // runner without quotes (rundll32's "file.dll,Entry").
            if app.split_whitespace().nth(1).is_some()
                && app
                    .split_whitespace()
                    .next()
                    .is_some_and(|first| first.chars().all(|c| !c.is_uppercase()))
            {
                return Err(Error::new(
                    4202,
                    "Launch an app by its name as the screen shows it (such as Notes), not a command line.",
                ));
            }
            // A one-dot id (Microsoft.VisualStudioCode) is checked by its
            // last part too, so a blocked app can't hide behind its vendor.
            if !app.contains(' ')
                && let Some(reason) = app
                    .rsplit_once('.')
                    .map(|(_, last)| last)
                    .filter(|last| last.len() > 1)
                    .and_then(blocked_app)
            {
                return Err(Error::new(4302, reason));
            }
            return Ok(vec![app]);
        }
        // The app that opens a file or link can't be known in advance.
        "open" => {
            return Err(Error::new(
                4302,
                "open is refused on the user's computers: the app that opens it can't be checked. Launch the app, then use it.",
            ));
        }
        // A browser's developer tools: a docked console can't be told from
        // its page, so the keys that open one are refused.
        "key" if devtools_shortcut(args["keys"].as_str().unwrap_or("")) => {
            return Err(Error::new(
                4302,
                "Developer tools shortcuts are refused on the user's computers.",
            ));
        }
        // System-wide shortcuts reach the system, not the app in front.
        "key"
            if system_shortcut(
                args["keys"].as_str().unwrap_or(""),
                computer_os(home, computer).as_deref() == Some("macOS"),
            ) =>
        {
            return Err(Error::new(
                4302,
                "System-wide shortcuts (the Windows or Super key, which Cmd is outside macOS, Ctrl+Alt+T, Cmd+Space) reach the system, not the app in front, so bots can't press them here. Launch the app instead.",
            ));
        }
        // One check covers a whole typed string: a line break inside it could
        // land in a window that took focus while it was typed.
        "type"
            if args["text"]
                .as_str()
                .is_some_and(|t| t.contains(['\n', '\r'])) =>
        {
            return Err(Error::new(
                4202,
                "Typed text can't include line breaks here: type the text, then press Return with a key action.",
            ));
        }
        "type" | "key" if args.get("coordinate").is_some_and(|c| !c.is_null()) => {
            return Err(Error::new(
                4202,
                "Typing and keys go to the focused window, not to a point. Click the field first, then type without a coordinate.",
            ));
        }
        _ => {}
    }
    let points = match action {
        "type" | "key" => vec![None],
        // The start is `from_coordinate` only when `coordinate` is absent, as
        // `translate` decides; a malformed `coordinate` is refused, never
        // swapped for another point.
        "drag" => vec![
            Some(
                if args.get("coordinate").is_some_and(|c| !c.is_null()) {
                    point("coordinate")
                } else {
                    point("from_coordinate")
                }
                .ok_or_else(|| Error::new(4202, "drag needs coordinate as [x, y]"))?,
            ),
            Some(point("to_coordinate").ok_or_else(|| Error::new(4202, "drag needs to_coordinate"))?),
        ],
        _ => vec![Some(point("coordinate").ok_or_else(|| {
            Error::new(
                4202,
                format!("{action} needs a coordinate on the user's computers, so the app it reaches can be checked."),
            )
        })?)],
    };
    let list = desktop_call(
        home,
        owner,
        bot,
        computer,
        "computer_window_list",
        json!({}),
    )
    .await?;
    let windows = list["content"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|c| c["text"].as_str())
        .filter_map(|t| serde_json::from_str::<Value>(t).ok())
        .find_map(|v| v["windows"].as_array().cloned())
        .unwrap_or_default();
    let scale = if points.iter().any(Option::is_some) {
        screen_scale(home, owner, bot, computer).await?
    } else {
        1.
    };
    let mut apps = vec![];
    for at in points {
        let here = apps_at(&windows, at.map(|(x, y)| (x * scale, y * scale)));
        if here.is_empty() {
            return Err(Error::new(
                4302,
                "Can't tell which app this reaches. Take a screenshot and act on a window you can see.",
            ));
        }
        for app in here {
            if !apps.contains(&app) {
                apps.push(app);
            }
        }
    }
    Ok(apps)
}
/// The apps a point can reach: every app with a window under it, since Cua
/// doesn't say which is in front. Without a point, the focused window's app.
/// Empty when nothing listed is there, which the caller refuses.
fn apps_at(windows: &[Value], point: Option<(f64, f64)>) -> Vec<String> {
    // A window showing Hexbot, such as its web app in a browser, counts as
    // Hexbot, which never takes a bot's input: a bot can't answer its own cards.
    let app = |w: &Value| {
        let name = w["app"].as_str().filter(|a| !a.is_empty())?;
        let title = w["title"].as_str().unwrap_or("").to_lowercase();
        Some(
            // Hex Connect's pages (signing an app in, approving a daemon)
            // reach the owner's daemons too.
            if (title.contains("hexbot") || title.contains("hex connect"))
                && !name.to_lowercase().contains("hexbot")
            {
                format!("Hexbot in {name}")
            } else if DEVTOOLS
                .iter()
                .any(|d| title.starts_with(d) || title.contains(d))
            {
                // A browser's script console runs code in whatever page it
                // inspects, Hexbot's included, whatever its title says.
                format!("DevTools in {name}")
            } else {
                name.to_owned()
            },
        )
    };
    let mut found: Vec<String> = vec![];
    let mut add = |name: Option<String>| {
        if let Some(name) = name
            && !found.contains(&name)
        {
            found.push(name);
        }
    };
    match point {
        Some((x, y)) => {
            for w in windows.iter().filter(|w| w["state"] != "minimized") {
                // A window that can't be placed may be over the point.
                let here = match (
                    w["position"][0].as_f64(),
                    w["position"][1].as_f64(),
                    w["size"][0].as_f64(),
                    w["size"][1].as_f64(),
                ) {
                    (Some(px), Some(py), Some(sw), Some(sh)) => {
                        x >= px && x < px + sw && y >= py && y < py + sh
                    }
                    _ => true,
                };
                if here {
                    // One that can't be named makes the whole point unknown.
                    let Some(name) = app(w) else { return vec![] };
                    add(Some(name));
                }
            }
        }
        // Every window marked focused (Cua may mark one per app): each must
        // pass, and one that can't be named makes the target unknown.
        None => {
            for w in windows.iter().filter(|w| w["focused"] == true) {
                let Some(name) = app(w) else { return vec![] };
                add(Some(name));
            }
        }
    }
    found
}
/// Screenshot pixels to screen points, from the last screenshot's size. With
/// no screenshot or no screen size the scale is unknown, and the action is
/// refused rather than checked at a point it may not land on.
async fn screen_scale(home: &Path, owner: &str, bot: &str, computer: &str) -> Result<f64> {
    let unknown = || {
        Error::new(
            4302,
            "Take a screenshot of that computer first, so where this lands can be checked.",
        )
    };
    let shot = SHOTS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&(home.to_owned(), computer.to_owned()))
        .copied();
    let (width, then) = shot.ok_or_else(unknown)?;
    // The screen the bot saw must be the screen now: a display that changed
    // since then makes the screenshot's coordinates mean something else.
    // Cua maps screenshot pixels to points by the screen's size in points
    // (its screenshots are scaled to 1200 px), so density alone doesn't.
    let now = screen_points(home, owner, bot, computer)
        .await
        .ok_or_else(unknown)?;
    if (now.0 - then.0).abs() > 0.5 || (now.1 - then.1).abs() > 0.5 {
        return Err(Error::new(
            4302,
            "That computer's screen changed since your last screenshot. Take a screenshot first.",
        ));
    }
    if width > 0. {
        Ok(then.0 / width)
    } else {
        Err(unknown())
    }
}
/// The screen's width and height in points, as Cua reports them (height 0
/// when it doesn't say).
async fn screen_points(home: &Path, owner: &str, bot: &str, computer: &str) -> Option<(f64, f64)> {
    let size = desktop_call(
        home,
        owner,
        bot,
        computer,
        "computer_get_screen_size",
        json!({}),
    )
    .await
    .ok()?;
    size["content"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|c| c["text"].as_str())
        .filter_map(|t| serde_json::from_str::<Value>(t).ok())
        .find_map(|v| {
            let width = v["width"].as_f64().or_else(|| v["size"][0].as_f64())?;
            let height = v["height"]
                .as_f64()
                .or_else(|| v["size"][1].as_f64())
                .unwrap_or(0.);
            Some((width, height))
        })
}
/// The last screenshot of each computer: its width in pixels and the
/// screen's size in points when it was taken.
type Shots = Mutex<HashMap<(PathBuf, String), (f64, (f64, f64))>>;
static SHOTS: OnceLock<Shots> = OnceLock::new();
/// Apps allowed for one section until the daemon restarts: (home, bot, computer, app) by section.
type SessionApps = Mutex<HashMap<(PathBuf, String, String, String), HashSet<String>>>;
fn session_apps() -> &'static SessionApps {
    static APPS: OnceLock<SessionApps> = OnceLock::new();
    APPS.get_or_init(Default::default)
}
fn app_key(app: &str) -> String {
    app.trim().to_lowercase()
}
/// The apps a bot may always use on a computer.
pub fn always_apps(home: &Path, computer: &str, bot: &str) -> Result<Vec<String>> {
    Ok(configured(home)?
        .map(|c| names(&c["apps"][computer][bot]))
        .unwrap_or_default())
}
fn app_allowed(home: &Path, computer: &str, bot: &str, section: &str, app: &str) -> Result<bool> {
    let key = app_key(app);
    if always_apps(home, computer, bot)?
        .iter()
        .any(|a| app_key(a) == key)
    {
        return Ok(true);
    }
    Ok(session_apps()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&(home.to_owned(), bot.to_owned(), computer.to_owned(), key))
        .is_some_and(|sections| sections.contains(section)))
}
pub fn allow_app(
    home: &Path,
    computer: &str,
    bot: &str,
    section: &str,
    app: &str,
    always: bool,
) -> Result<()> {
    if always {
        migrate(home)?;
        common::update_config(home, |config| {
            let list = &mut config["computers"]["apps"][computer][bot];
            let mut apps = names(list);
            if !apps.iter().any(|a| app_key(a) == app_key(app)) {
                apps.push(app.trim().to_owned());
            }
            apps.sort();
            *list = json!(apps);
            Ok(())
        })?;
    } else {
        session_apps()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entry((
                home.to_owned(),
                bot.to_owned(),
                computer.to_owned(),
                app_key(app),
            ))
            .or_default()
            .insert(section.to_owned());
    }
    Ok(())
}
pub fn remove_app(home: &Path, computer: &str, bot: &str, app: &str) -> Result<()> {
    if configured(home)?.is_none() {
        return Ok(());
    }
    common::update_config(home, |config| {
        let list = &mut config["computers"]["apps"][computer][bot];
        let mut apps = names(list);
        apps.retain(|a| app_key(a) != app_key(app));
        *list = json!(apps);
        Ok(())
    })?;
    session_apps()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .retain(|(h, b, c, a), _| !(h == home && b == bot && c == computer && *a == app_key(app)));
    Ok(())
}
/// What a desktop action on a user's computer needs before it runs: nothing,
/// or the user's yes for an app.
pub enum Needs {
    Nothing,
    App {
        app: String,
        command: String,
        reason: String,
    },
}
/// Where a desktop action lands, and whether it is refused outright: the
/// grant and this computer's switch first, then refused actions, then the
/// apps it reaches, none of which may be blocked. Empty apps: it only looks,
/// or it is on the bots' computer, which has no app checks.
async fn resolve_desktop(
    home: &Path,
    owner: &str,
    bot: &str,
    computer: &str,
    args: &Value,
) -> Result<Vec<String>> {
    allowed_here(home, bot, computer)?;
    if computer == VM {
        return Ok(vec![]);
    }
    let (action, ..) = crate::computers::translate(args)?;
    if action == "shell" {
        return Err(Error::new(
            4302,
            "shell is refused on the user's computers. Use bash with this computer instead.",
        ));
    }
    if looks_only(action) {
        return Ok(vec![]);
    }
    let apps = target_apps(home, owner, bot, computer, action, args).await?;
    for app in &apps {
        if let Some(why) = blocked_app(app) {
            return Err(Error::new(4302, format!("{app}: {why}")));
        }
    }
    Ok(apps)
}
/// Whether `bot` may still use `computer`'s desktop, as it is now: an
/// answer to a card waits on this before it is recorded.
pub fn may_use_desktop(home: &Path, bot: &str, computer: &str) -> Result<()> {
    allowed_here(home, bot, computer)
}
/// The grant and this computer's desktop switch, as they are now.
fn allowed_here(home: &Path, bot: &str, computer: &str) -> Result<()> {
    // This computer's screen first: with it unshared, no bot has it.
    if computer == HOST && !host_desktop_on(home)? {
        return Err(host_not_set_up());
    }
    if !has(home, bot, computer, DESKTOP)? {
        return Err(not_granted(computer, "desktop"));
    }
    Ok(())
}
/// The first app still waiting for the user's yes, as things are now; none
/// in Bypass (`off`). Reads only local state, so it can run right before an
/// action with nothing awaited in between.
fn waiting_app(
    home: &Path,
    bot: &str,
    section: &str,
    computer: &str,
    mode: &str,
    apps: &[String],
) -> Result<Option<String>> {
    allowed_here(home, bot, computer)?;
    if mode == "off" {
        return Ok(None);
    }
    for app in apps {
        if !app_allowed(home, computer, bot, section, app)? {
            return Ok(Some(app.clone()));
        }
    }
    Ok(None)
}
/// Checks a desktop action before it runs: the grant, a refused action or
/// app, and whether an app still needs the user's yes. Bypass (`off`) asks
/// for no app, but blocked apps stay blocked in every mode.
#[allow(clippy::too_many_arguments)]
pub async fn check_desktop(
    home: &Path,
    owner: &str,
    bot: &str,
    section: &str,
    computer: &str,
    mode: &str,
    args: &Value,
) -> Result<Needs> {
    // Its lookups take the computer's turn too, so they never sit between
    // another action's last check and its send.
    let lock = desktop_lock(home, computer);
    let _turn = tokio::time::timeout(Duration::from_secs(120), lock.lock())
        .await
        .map_err(|_| Error::new(4209, "Another bot kept that computer busy. Try again."))?;
    let apps = resolve_desktop(home, owner, bot, computer, args).await?;
    let Some(app) = waiting_app(home, bot, section, computer, mode, &apps)? else {
        return Ok(Needs::Nothing);
    };
    let place = computer_label(home, owner, computer)?;
    let mut reason = format!(
        "The bot wants to use {app} on {place}. Allow it for now, in this conversation, or always."
    );
    if let Some(warning) = app_warning(&app) {
        reason = format!("{reason} {warning}");
    }
    Ok(Needs::App {
        command: format!("Use {app} on {place}"),
        app,
        reason,
    })
}
pub fn computer_label(home: &Path, owner: &str, computer: &str) -> Result<String> {
    Ok(if computer == VM {
        "the bots' computer".into()
    } else if computer == HOST {
        host_name()
    } else {
        device_id(computer)
            .map(|d| device_row(home, owner, d))
            .transpose()?
            .flatten()
            .unwrap_or_else(|| "that computer".into())
    })
}
/// One desktop action at a time on each computer, so a check and the
/// action it allowed can't be split by another bot's action.
fn desktop_lock(home: &Path, computer: &str) -> std::sync::Arc<tokio::sync::Mutex<()>> {
    type Locks = Mutex<HashMap<(PathBuf, String), std::sync::Arc<tokio::sync::Mutex<()>>>>;
    static LOCKS: OnceLock<Locks> = OnceLock::new();
    LOCKS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .entry((home.to_owned(), computer.to_owned()))
        .or_default()
        .clone()
}
/// Runs a desktop action on this computer or a user's computer. It checks
/// the grant, the computer and every app the action reaches again right
/// before it runs, under the computer's lock: an answer to an earlier card
/// never carries an action to a window or a bot it no longer fits.
/// `mode` reads the section's approval mode; it is read once the lock is
/// held, so a mode changed while the action waited applies.
#[allow(clippy::too_many_arguments)]
pub async fn act(
    home: &Path,
    owner: &str,
    bot: &str,
    section: &str,
    computer: &str,
    mode: impl Fn() -> Result<String>,
    args: &Value,
) -> Result<Value> {
    let lock = desktop_lock(home, computer);
    // Owned, so the action sent below keeps the computer until it is done,
    // even when the chat is stopped while it runs.
    // The mode before waiting for the computer, to say why an action that was
    // fine then is refused now.
    let mode_before = mode()?;
    let turn = std::sync::Arc::new(
        tokio::time::timeout(Duration::from_secs(120), lock.lock_owned())
            .await
            .map_err(|_| Error::new(4209, "Another bot kept that computer busy. Try again."))?,
    );
    let (action, tool, params) = crate::computers::translate(args)?;
    // This computer's Cua target is found first, so nothing waits on it later.
    let target = if computer == HOST {
        Some(host_target(home).await?)
    } else {
        None
    };
    // Cua's session on this computer or the user's starts here, before the
    // last check, so sending the action waits on nothing else.
    if computer != VM {
        desktop_send(
            home,
            owner,
            bot,
            computer,
            target.as_deref(),
            "computer_get_screen_size",
            json!({}),
        )
        .await?;
    }
    // A scroll moves the pointer over its point before it is checked.
    if action == "scroll"
        && let Some(point) = args["coordinate"].as_array()
    {
        let apps = resolve_desktop(home, owner, bot, computer, args).await?;
        if waiting_app(home, bot, section, computer, &mode()?, &apps)?.is_some() {
            return Err(changed_under());
        }
        desktop_send(
            home,
            owner,
            bot,
            computer,
            target.as_deref(),
            "computer_move_cursor",
            json!({"x":point.first(),"y":point.get(1)}),
        )
        .await?;
    }
    // Where it lands now, then the mode, grant, switch and apps as they are
    // after that lookup; the next await is the action being sent.
    let apps = resolve_desktop(home, owner, bot, computer, args).await?;
    let mode_now = mode()?;
    if let Some(app) = waiting_app(home, bot, section, computer, &mode_now, &apps)? {
        if mode_now != mode_before {
            return Err(Error::new(
                4302,
                format!(
                    "The approval mode changed before this ran, and {app} hasn't been allowed in this one. Take a screenshot and try again."
                ),
            ));
        }
        return Err(Error::new(
            4302,
            format!(
                "The screen changed before this ran: it now reaches {app}, which you haven't been allowed to use. Take a screenshot and try again."
            ),
        ));
    }
    if action == "wait" {
        tokio::time::sleep(Duration::from_secs_f64(
            params["seconds"].as_f64().unwrap_or(1.),
        ))
        .await;
        return Ok(json!({"ok":true,"action":"wait"}));
    }
    // Sent from a task that holds the computer until the action is done: a
    // stopped chat can't let another bot's action in while this one lands.
    // A stopped chat drops this future: the guard tells the task, which
    // cancels the request on a user's computer and still holds the computer
    // until the request has settled.
    struct Stopped(Option<tokio::sync::watch::Sender<bool>>);
    impl Drop for Stopped {
        fn drop(&mut self) {
            if let Some(sender) = self.0.take() {
                let _ = sender.send(true);
            }
        }
    }
    let (stop_tx, stop_rx) = tokio::sync::watch::channel(false);
    let mut stopped = Stopped(Some(stop_tx));
    let result = {
        let held = turn.clone();
        let (home2, owner2, bot2, computer2, target2) = (
            home.to_owned(),
            owner.to_owned(),
            bot.to_owned(),
            computer.to_owned(),
            target.clone(),
        );
        tokio::spawn(async move {
            let _held = held;
            desktop_send_until(
                &home2,
                &owner2,
                &bot2,
                &computer2,
                target2.as_deref(),
                tool,
                params,
                Some(stop_rx),
                true,
            )
            .await
        })
        .await
        .map_err(|_| Error::new(4211, "The computer action stopped unexpectedly."))??
    };
    // Finished: nothing to stop.
    stopped.0 = None;
    // Remembers the screenshot's width with the screen's width then; without
    // both, no scale is kept and the next pointed action asks for another.
    let look = |result: Value, points: Option<(f64, f64)>| {
        let mut shots = SHOTS
            .get_or_init(Default::default)
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let key = (home.to_owned(), computer.to_owned());
        match (png_size(&result), points) {
            (Some((width, _)), Some(points)) => {
                shots.insert(key, (width, points));
            }
            _ => {
                shots.remove(&key);
            }
        }
        drop(shots);
        crate::native_tools::save_capture(home, bot, result)
    };
    if action == "screenshot" {
        let points = screen_points(home, owner, bot, computer).await;
        return look(result, points);
    }
    if args["capture_after"] == true {
        tokio::time::sleep(Duration::from_millis(500)).await;
        // A grant or switch taken away during that wait applies to the look.
        allowed_here(home, bot, computer)?;
        let shot = desktop_send(
            home,
            owner,
            bot,
            computer,
            target.as_deref(),
            "computer_screenshot",
            json!({}),
        )
        .await?;
        let points = screen_points(home, owner, bot, computer).await;
        let capture = look(shot, points)?;
        let mut content = result["content"].as_array().cloned().unwrap_or_default();
        content.extend(capture["content"].as_array().cloned().unwrap_or_default());
        return Ok(json!({"content":content,"screenshot_path":capture["screenshot_path"]}));
    }
    Ok(result)
}
fn png_size(result: &Value) -> Option<(f64, f64)> {
    use base64::Engine;
    let data = result["content"]
        .as_array()?
        .iter()
        .find(|c| c["type"] == "image")?["data"]
        .as_str()?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.get(..64.min(data.len()) / 4 * 4)?)
        .ok()?;
    if bytes.len() < 24 || &bytes[..8] != b"\x89PNG\r\n\x1a\n" {
        return None;
    }
    let width = u32::from_be_bytes(bytes[16..20].try_into().ok()?) as f64;
    let height = u32::from_be_bytes(bytes[20..24].try_into().ok()?) as f64;
    Some((width, height))
}

/// The default computer for a capability, as the frozen list orders them.
pub fn default_for(list: &Value, capability: &str) -> Option<String> {
    list.as_array()?
        .iter()
        .find(|c| c[capability] == true)
        .and_then(|c| c["id"].as_str().map(str::to_owned))
}

// ------------------------------------------------------- what clients see

/// Every computer the user has or could have, with its bots.
pub async fn list(home: &Path, owner: &str) -> Result<Value> {
    let config = configured(home)?;
    let bots = bot_names(home)?;
    let bots_for = |computer: &str, capability: &str| -> Result<Vec<String>> {
        let mut out = vec![];
        for bot in &bots {
            if has(home, bot, computer, capability)? {
                out.push(bot.clone());
            }
        }
        Ok(out)
    };
    let apps = |computer: &str| {
        config
            .as_ref()
            .map(|c| c["apps"][computer].clone())
            .filter(Value::is_object)
            .unwrap_or_else(|| json!({}))
    };
    let (cfg, env) = crate::computers::setup(home)?;
    let cua = crate::computers::command(&cfg, &env).is_some();
    let vm_on = vm_on(home)?;
    let mut out = vec![json!({
        "id": VM,
        "kind": "vm",
        "name": "The bots' computer",
        "os": "Linux",
        "online": cua && vm_on,
        "on": vm_on,
        "available": cua,
        "terminal": {"available": cua, "bots": bots_for(VM, TERMINAL)?},
        "desktop": {"available": cua, "bots": bots_for(VM, DESKTOP)?},
        "apps": {},
    })];
    let host_desktop = host_desktop_on(home)?;
    let host_screen = cfg!(target_os = "macos")
        || cfg!(target_os = "windows")
        || std::env::var_os("DISPLAY").is_some()
        || std::env::var_os("WAYLAND_DISPLAY").is_some();
    let host_ready = host_desktop && host_target(home).await.is_ok();
    out.push(json!({
        "id": HOST,
        "kind": "host",
        "name": host_name(),
        "os": host_os(),
        "online": true,
        "on": true,
        "available": true,
        "terminal": {"available": true, "bots": bots_for(HOST, TERMINAL)?, "sandboxed": !cfg!(windows)},
        "desktop": {
            "available": host_screen && cua,
            "on": host_desktop,
            "ready": host_ready,
            "bots": bots_for(HOST, DESKTOP)?,
            "note": if !host_screen { Some(format!("{} has no screen. Use the bots' computer for a desktop.", host_name())) }
                else if !cua { Some(format!("Install Cua on {} to share its desktop.", host_name())) }
                else { None },
        },
        "apps": apps(HOST),
    }));
    let devices = {
        let conn = db::open(home)?;
        let mut stmt = conn.prepare(
            "SELECT id, COALESCE(name,'A computer') FROM devices WHERE owner_id=? AND revoked_at IS NULL AND platform<>'local' ORDER BY created_at",
        )?;
        stmt.query_map([owner], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?
    };
    for (device, name) in devices {
        let computer = device_computer(&device);
        let live = online(home, &device);
        // Granted: a bot working on it, or an app allowed there
        // (its saved OS alone doesn't keep it listed).
        let granted = config.as_ref().is_some_and(|c| {
            [TERMINAL, DESKTOP]
                .iter()
                .any(|cap| !names(&c[computer.as_str()][*cap]).is_empty())
                || c["apps"][computer.as_str()]
                    .as_object()
                    .is_some_and(|apps| apps.values().any(|v| !names(v).is_empty()))
        });
        if live.is_none() && !granted {
            continue;
        }
        let (terminal, desktop) = live
            .as_ref()
            .map(|(t, d, ..)| (*t, *d))
            .unwrap_or((false, false));
        out.push(json!({
            "id": computer,
            "kind": "device",
            "name": name,
            "os": live.as_ref().map(|l| l.3.clone()).filter(|o| !o.is_empty())
                .or_else(|| saved_os(home, &computer)).unwrap_or_default(),
            "online": live.is_some(),
            "on": true,
            "available": live.is_some(),
            "terminal": {"available": terminal, "bots": bots_for(&computer, TERMINAL)?},
            // The bots that reach its screen now: only while its app shares it.
            "desktop": {
                "available": desktop,
                "bots": if desktop { bots_for(&computer, DESKTOP)? } else { vec![] },
            },
            "apps": apps(&computer),
        }));
    }
    Ok(json!({"computers": out}))
}

/// `hexbot.computers.*` methods that need no connection of their own.
pub async fn call(home: &Path, owner: &str, method: &str, p: &Value) -> Option<Result<Value>> {
    Some(match method {
        "hexbot.computers.list" => list(home, owner).await,
        "hexbot.computers.grant" => (|| {
            let computer = common::required(p, "computer")?;
            let capability = common::required(p, "capability")?;
            let bot = common::required(p, "bot")?;
            common::bot_owner(home, owner, bot)?;
            let on = p["on"] != false;
            // A user's computer must be one of the owner's paired devices: a
            // mistyped id would give a tool for a computer nobody can see.
            if on
                && let Some(device) = device_id(computer)
                && device_row(home, owner, device)?.is_none()
            {
                return Err(Error::new(
                    4204,
                    format!(
                        "No paired computer is called {computer}. hexbot computers lists them."
                    ),
                ));
            }
            set(home, computer, capability, bot, on)?;
            changed(home, owner);
            bots_changed(home, owner, bot);
            Ok(json!({"ok":true}))
        })(),
        "hexbot.computers.set" => set_computer(home, owner, p).await,
        // Setup's choice for every bot made from now on, HexBot first.
        "hexbot.computers.defaults" => (|| {
            migrate(home)?;
            common::update_config(home, |config| {
                // This computer as an environment, and Computer Use, for
                // every bot made from now on.
                for key in ["host_terminal", COMPUTER_USE] {
                    if let Some(on) = p[key].as_bool() {
                        config["computers"]["defaults"][key] = json!(on);
                    }
                }
                Ok(())
            })?;
            Ok(configured(home)?
                .map(|c| c["defaults"].clone())
                .unwrap_or(json!({})))
        })(),
        "hexbot.computers.remove_app" => (|| {
            let computer = common::required(p, "computer")?;
            valid_computer(computer)?;
            let bot = common::required(p, "bot")?;
            let app = common::required(p, "app")?;
            common::bot_owner(home, owner, bot)?;
            remove_app(home, computer, bot, app)?;
            changed(home, owner);
            Ok(json!({"ok":true}))
        })(),
        "hexbot.computers.forget" => forget(home, owner, p).await,
        _ => return None,
    })
}
/// A user's computer leaves every bot: its grants and allowed apps go. Used
/// by Forget and when the device is revoked, so no bot keeps a tool for a
/// computer nobody can see any more.
pub fn forget_device(home: &Path, owner: &str, device: &str) -> Result<()> {
    let computer = format!("device:{device}");
    let Some(config) = configured(home)? else {
        return Ok(());
    };
    // Bots that used it: their tools change, so open bot settings reload.
    let mut holders: Vec<String> = [TERMINAL, DESKTOP]
        .iter()
        .flat_map(|capability| names(&config[computer.as_str()][*capability]))
        .collect();
    holders.sort();
    holders.dedup();
    common::update_config(home, |config| {
        if let Some(map) = config["computers"].as_object_mut() {
            map.remove(&computer);
        }
        if let Some(map) = config["computers"]["apps"].as_object_mut() {
            map.remove(&computer);
        }
        Ok(())
    })?;
    session_apps()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .retain(|(h, _, c, _), _| !(h == home && *c == computer));
    changed(home, owner);
    for bot in &holders {
        bots_changed(home, owner, bot);
    }
    Ok(())
}
/// `hexbot.computers.forget`: a user's computer loses its bots and allowed
/// apps. Online now, its running and waiting work ends there first and the
/// app confirms it within a few seconds; then it goes offline until Hexbot
/// there offers it again. `released` false: the app didn't confirm.
async fn forget(home: &Path, owner: &str, p: &Value) -> Result<Value> {
    let computer = common::required(p, "computer")?;
    let Some(device) = device_id(computer) else {
        return Err(Error::new(4202, "only a user's computer can be forgotten"));
    };
    forget_device(home, owner, device)?;
    let connection = lock()
        .endpoints
        .get(&(home.to_owned(), device.to_owned()))
        .map(|e| e.connection);
    let mut out = json!({"ok":true});
    if let Some(connection) = connection {
        let answer = device_call(
            home,
            owner,
            device,
            RELEASE,
            json!({}),
            Duration::from_secs(5),
        )
        .await;
        let released = answer.is_ok_and(|a| a["released"] == true);
        detach(home, device, connection);
        out["released"] = json!(released);
        if !released {
            let name = device_row(home, owner, device)?.unwrap_or_else(|| "That computer".into());
            out["note"] = json!(format!(
                "{name} didn't confirm that bots stopped there. Choose Stop bots on this computer from Hexbot's icon there (menu bar or notification area), or quit Hexbot there."
            ));
        }
    }
    changed(home, owner);
    Ok(out)
}
fn bots_changed(home: &Path, owner: &str, bot: &str) {
    if let Some(events) = hubs().lock().unwrap_or_else(|e| e.into_inner()).get(home) {
        events.emit(owner, None, "hexbot.bots.changed", json!({"name":bot}));
    }
}
fn switches() -> &'static Mutex<HashMap<PathBuf, u64>> {
    static SWITCHES: OnceLock<Mutex<HashMap<PathBuf, u64>>> = OnceLock::new();
    SWITCHES.get_or_init(Default::default)
}
/// A new request for this computer's desktop switch: its generation.
fn next_switch(home: &Path) -> u64 {
    let mut map = switches().lock().unwrap_or_else(|e| e.into_inner());
    let generation = map.entry(home.to_owned()).or_default();
    *generation += 1;
    *generation
}
fn switch_now(home: &Path) -> u64 {
    *switches()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(home)
        .unwrap_or(&0)
}
/// `hexbot.computers.set`: the bots' computer on or off, and this computer's
/// desktop on (set up first) or off.
async fn set_computer(home: &Path, owner: &str, p: &Value) -> Result<Value> {
    let computer = common::required(p, "computer")?;
    migrate(home)?;
    match computer {
        VM => {
            let on = p["on"] != false;
            common::update_config(home, |config| {
                config["computers"][VM]["off"] = json!(!on);
                Ok(())
            })?;
            if !on {
                // Nothing keeps the computer running for no one.
                let _ = crate::computers::call(home, "hexbot.computer.stop", &json!({})).await;
            }
        }
        HOST => {
            let on = p["desktop"] == true;
            // Every request moves the switch's generation on; an enable whose
            // setup finishes after a later request changes nothing, so turning
            // it off always wins over a setup still running.
            let generation = next_switch(home);
            if !on {
                common::update_config(home, |config| {
                    config["computers"][HOST]["desktop_on"] = json!(false);
                    Ok(())
                })?;
            } else {
                setup_host_desktop(home).await?;
                let mut stale = false;
                common::update_config(home, |config| {
                    if switch_now(home) != generation {
                        stale = true;
                        return Ok(());
                    }
                    config["computers"][HOST]["desktop_on"] = json!(true);
                    Ok(())
                })?;
                if stale {
                    return Err(Error::new(
                        4209,
                        "Sharing this computer's desktop changed while it was being set up. It stays as you set it last.",
                    ));
                }
            }
        }
        _ => return Err(Error::new(4202, "only vm and host have settings")),
    }
    changed(home, owner);
    for bot in bot_names(home)? {
        bots_changed(home, owner, &bot);
    }
    list(home, owner).await
}

#[cfg(test)]
#[path = "machines_tests.rs"]
mod tests;
