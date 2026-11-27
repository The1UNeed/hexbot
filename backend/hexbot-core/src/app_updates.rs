//! The desktop apps connected to this daemon, for Update everything
//! (docs/channels.md, "Updating everything at once"). Each app reports its
//! version and its updater on its own connection. The client that plans a
//! run lists them and has the daemon pass prepare, commit or cancel on to
//! one app. Like `machines.rs`, the daemon only relays: each app updates
//! itself. One run at a time: a claim in `runtime/update-run.json` outlives
//! the daemon's own restart during the run.
use crate::{Error, Result, auth, common, db};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};
use tokio::sync::mpsc::UnboundedSender;

const RUN: &str = "runtime/update-run.json";
const RUN_SECONDS: f64 = 30.0 * 60.0;
const REQUEST_STATES: [&str; 6] = [
    "preparing",
    "ready",
    "installing",
    "postponed",
    "failed",
    "not_applied",
];

struct Entry {
    owner: String,
    connection: u64,
    sender: UnboundedSender<Value>,
    report: Value,
}
#[derive(Default)]
struct Registry {
    /// By home, device and app id: a Stable and a Nightly app on one
    /// computer share the computer's device but are two apps.
    apps: HashMap<(PathBuf, String, String), Entry>,
    /// Connections from the app that haven't reported: older apps, which a
    /// run can't update from here.
    unreported: HashMap<(PathBuf, u64), (String, String)>,
}
fn lock() -> std::sync::MutexGuard<'static, Registry> {
    static REGISTRY: OnceLock<Mutex<Registry>> = OnceLock::new();
    REGISTRY
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}
fn hubs() -> std::sync::MutexGuard<'static, HashMap<PathBuf, crate::events::EventHub>> {
    static HUBS: OnceLock<Mutex<HashMap<PathBuf, crate::events::EventHub>>> = OnceLock::new();
    HUBS.get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}
pub fn attach_events(home: &Path, events: crate::events::EventHub) {
    hubs().insert(home.to_owned(), events);
}
fn changed(home: &Path, owner: &str) {
    if let Some(events) = hubs().get(home) {
        events.emit(owner, None, "hexbot.apps.changed", json!({}));
    }
}

/// A paired device's name, the daemon's own computer by its host name.
fn label(home: &Path, owner: &str, device: &str) -> Result<Option<String>> {
    use rusqlite::OptionalExtension;
    Ok(db::open(home)?
        .query_row(
            "SELECT name, platform FROM devices WHERE id=? AND owner_id=? AND revoked_at IS NULL",
            [device, owner],
            |r| Ok((r.get::<_, Option<String>>(0)?, r.get::<_, String>(1)?)),
        )
        .optional()?
        .map(|(name, platform)| {
            if platform == "local" {
                auth::daemon_name()
            } else {
                name.unwrap_or_else(|| "A computer".into())
            }
        }))
}

/// A connection from the desktop app opened (its `Origin`).
pub fn connected(home: &Path, owner: &str, device: &str, connection: u64) {
    lock().unreported.insert(
        (home.to_owned(), connection),
        (owner.to_owned(), device.to_owned()),
    );
}
/// The connection closed. A newer connection of the same app stays.
pub fn detach(home: &Path, connection: u64) {
    let owners = {
        let mut registry = lock();
        registry.unreported.remove(&(home.to_owned(), connection));
        let mut owners = Vec::new();
        registry.apps.retain(|(h, ..), entry| {
            let gone = h == home && entry.connection == connection;
            if gone {
                owners.push(entry.owner.clone());
            }
            !gone
        });
        owners
    };
    for owner in owners {
        changed(home, &owner);
    }
}

fn text(p: &Value, key: &str, max: usize) -> Option<String> {
    p[key]
        .as_str()
        .filter(|v| !v.is_empty() && v.len() <= max && !v.chars().any(char::is_control))
        .map(str::to_owned)
}
fn one_of(p: &Value, key: &str, allowed: &[&str]) -> Result<String> {
    p[key]
        .as_str()
        .filter(|v| allowed.contains(v))
        .map(str::to_owned)
        .ok_or_else(|| Error::new(4200, format!("invalid parameter: {key}")))
}
/// What an app may say about itself, and nothing else.
fn sanitize(p: &Value) -> Result<Value> {
    let invalid = |key: &str| Error::new(4200, format!("invalid parameter: {key}"));
    let app_id = text(p, "app_id", 120)
        .filter(|id| {
            id.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b".-_".contains(&b))
        })
        .ok_or_else(|| invalid("app_id"))?;
    let version = text(p, "version", 64).ok_or_else(|| invalid("version"))?;
    let updater = &p["updater"];
    let request = match &p["request"] {
        Value::Null => Value::Null,
        request => {
            let id = text(request, "id", 64)
                .filter(|id| crate::update_trial::valid_id(id))
                .ok_or_else(|| invalid("request"))?;
            json!({
                "id": id,
                "state": one_of(request, "state", &REQUEST_STATES)?,
                "downloaded_version": text(request, "downloaded_version", 64),
                "error": text(request, "error", 300),
            })
        }
    };
    Ok(json!({
        "app_id": app_id,
        "version": version,
        "edition": one_of(p, "edition", &["full", "client"])?,
        "platform": text(p, "platform", 20).ok_or_else(|| invalid("platform"))?,
        "track": one_of(p, "track", &["stable", "nightly"])?,
        "hosts_daemon": p["hosts_daemon"] == true,
        // The app's updater as `update-state.ts` keeps it.
        "updater": {
            "status": text(updater, "status", 20),
            "available": text(updater, "available", 64),
            "downloaded": text(updater, "downloaded", 64),
            "percent": updater["percent"].as_f64().map(|p| p.clamp(0.0, 100.0)),
            "message": text(updater, "message", 300),
        },
        "request": request,
    }))
}

/// `hexbot.apps.report`: this connection's app, its version and its updater.
pub fn report(
    home: &Path,
    owner: &str,
    device: &str,
    connection: u64,
    sender: UnboundedSender<Value>,
    p: &Value,
) -> Result<Value> {
    let report = sanitize(p)?;
    let Some(label) = label(home, owner, device)? else {
        return Err(Error::new(4302, "Unknown device"));
    };
    let mut report = report;
    report["device"] = json!(device);
    report["label"] = json!(label);
    {
        let mut registry = lock();
        registry.unreported.remove(&(home.to_owned(), connection));
        let key = (
            home.to_owned(),
            device.to_owned(),
            report["app_id"].as_str().unwrap_or_default().to_owned(),
        );
        registry.apps.insert(
            key,
            Entry {
                owner: owner.to_owned(),
                connection,
                sender,
                report,
            },
        );
    }
    changed(home, owner);
    Ok(json!({"reported": true}))
}

/// `hexbot.apps.list`: every connected app, the caller's marked `current`,
/// apps too old to report, and the run in progress.
pub fn list(home: &Path, owner: &str, connection: u64) -> Result<Value> {
    let (mut apps, unreported) = {
        let registry = lock();
        let apps: Vec<Value> = registry
            .apps
            .iter()
            .filter(|((h, ..), entry)| h == home && entry.owner == owner)
            .map(|(_, entry)| {
                let mut app = entry.report.clone();
                app["current"] = json!(entry.connection == connection);
                app
            })
            .collect();
        let unreported: Vec<String> = registry
            .unreported
            .iter()
            .filter(|((h, _), (o, _))| h == home && o == owner)
            .map(|(_, (_, device))| device.clone())
            .collect();
        (apps, unreported)
    };
    apps.sort_by(|a, b| {
        (a["label"].as_str(), a["app_id"].as_str())
            .cmp(&(b["label"].as_str(), b["app_id"].as_str()))
    });
    let mut older = Vec::new();
    for device in unreported {
        if let Some(label) = label(home, owner, &device)?
            && !older.iter().any(|o: &Value| o["device"] == device)
        {
            older.push(json!({"device": device, "label": label}));
        }
    }
    Ok(json!({"apps": apps, "older": older, "run": live_run(home)?}))
}

/// `hexbot.apps.update`: pass prepare, commit or cancel on to one app.
pub fn update(home: &Path, owner: &str, p: &Value) -> Result<Value> {
    let device =
        text(p, "device", 120).ok_or_else(|| Error::new(4200, "invalid parameter: device"))?;
    let app_id =
        text(p, "app_id", 120).ok_or_else(|| Error::new(4200, "invalid parameter: app_id"))?;
    let action = one_of(p, "action", &["prepare", "commit", "cancel"])?;
    let request_id = text(p, "request_id", 64)
        .filter(|id| crate::update_trial::valid_id(id))
        .ok_or_else(|| Error::new(4200, "invalid parameter: request_id"))?;
    let track = match p.get("track") {
        None | Some(Value::Null) => Value::Null,
        Some(_) => json!(one_of(p, "track", &["stable", "nightly"])?),
    };
    // Only the caller's own devices, the daemon's computer included.
    if label(home, owner, &device)?.is_none() {
        return Err(Error::new(4302, "Unknown device"));
    }
    let registry = lock();
    let entry = registry
        .apps
        .get(&(home.to_owned(), device, app_id))
        .filter(|entry| entry.owner == owner)
        .ok_or_else(|| Error::new(4404, "That app isn't connected"))?;
    let frame = json!({"jsonrpc":"2.0","method":"event","params":{"type":"hexbot.apps.update_requested","session_id":null,"payload":{
        "action": action,
        "request_id": request_id,
        "version": text(p, "version", 64),
        "track": track,
    }}});
    entry
        .sender
        .send(frame)
        .map_err(|_| Error::new(4404, "That app isn't connected"))?;
    Ok(json!({"sent": true}))
}

fn read_run(home: &Path) -> Result<Option<Value>> {
    match std::fs::read(home.join(RUN)) {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes).ok()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}
fn live_run(home: &Path) -> Result<Option<Value>> {
    Ok(read_run(home)?.filter(|run| run["expires_at"].as_f64().unwrap_or(0.0) > common::now()))
}

/// `hexbot.update.run`: claim the one run this daemon allows, or end it.
/// The same run may claim again, as it does after the daemon restarts.
pub fn run(home: &Path, owner: &str, device: &str, p: &Value) -> Result<Value> {
    let run_id = text(p, "run_id", 64)
        .filter(|id| crate::update_trial::valid_id(id))
        .ok_or_else(|| Error::new(4200, "invalid parameter: run_id"))?;
    let action = one_of(p, "action", &["begin", "end"])?;
    // The claim is one small file; the registry lock keeps two claims apart.
    let _registry = lock();
    let current = live_run(home)?;
    let ours = current.as_ref().is_some_and(|run| run["run_id"] == run_id);
    let run = if action == "begin" {
        if current.is_some() && !ours {
            return Err(Error::new(4409, "Another update is running"));
        }
        let run =
            json!({"run_id": run_id, "device": device, "expires_at": common::now() + RUN_SECONDS});
        common::atomic_write(&home.join(RUN), run.to_string().as_bytes())?;
        Some(run)
    } else {
        if ours || current.is_none() {
            match std::fs::remove_file(home.join(RUN)) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
        None
    };
    drop(_registry);
    changed(home, owner);
    Ok(json!({"run": run}))
}

#[cfg(test)]
#[path = "app_updates_tests.rs"]
mod tests;
