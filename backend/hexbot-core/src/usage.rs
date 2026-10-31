//! Anonymous usage data (docs/usage-data.md). Nothing leaves the daemon until
//! the user turns on `usage_data` in Settings or the setup guide; bots cannot
//! change it. Events carry counts, the version, and the platform, keyed to a
//! random install id that is deleted when usage data is turned off. Never a
//! name, a path, an address, chat text, or an error message.
//!
//! The PostHog project key is baked in at build time (`HEXBOT_POSTHOG_KEY`,
//! set by release.yml), so source and dev builds send nothing. `DO_NOT_TRACK`
//! or `HEXBOT_USAGE_DATA=0` turns it off whatever the setting says.
use crate::{common, db, settings};
use serde_json::{Value, json};
use std::{path::Path, sync::Once, time::Duration};

const KEY: Option<&str> = option_env!("HEXBOT_POSTHOG_KEY");
const CAPTURE_URL: &str = "https://us.i.posthog.com/i/v0/e/";
const FILE: &str = "usage.json";

fn key() -> Option<&'static str> {
    KEY.map(str::trim).filter(|key| !key.is_empty())
}

/// An environment that refuses usage data, whatever the setting says.
pub fn refused(var: impl Fn(&str) -> Option<String>) -> bool {
    let set = |name| var(name).is_some_and(|v| !matches!(v.trim(), "" | "0" | "false"));
    set("DO_NOT_TRACK")
        || var("HEXBOT_USAGE_DATA").is_some_and(|v| matches!(v.trim(), "0" | "false"))
}

pub fn enabled(home: &Path) -> bool {
    key().is_some()
        && !refused(|name| std::env::var(name).ok())
        && settings::get(home).is_ok_and(|s| s["usage_data"] == true)
}

fn state(home: &Path) -> Value {
    std::fs::read_to_string(home.join(FILE))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_else(|| json!({}))
}

/// The random install id, made the first time usage data is sent.
fn install_id(home: &Path) -> Option<String> {
    let mut state = state(home);
    if let Some(id) = state["id"].as_str() {
        return Some(id.to_owned());
    }
    let id = uuid::Uuid::new_v4().to_string();
    state["id"] = json!(id);
    common::atomic_write(&home.join(FILE), state.to_string().as_bytes()).ok()?;
    Some(id)
}

/// Turning usage data off forgets the install id, so turning it back on starts anew.
pub fn forget(home: &Path) {
    let _ = std::fs::remove_file(home.join(FILE));
}

fn os() -> &'static str {
    match std::env::consts::OS {
        "macos" => "Mac OS X",
        "windows" => "Windows",
        "linux" => "Linux",
        other => other,
    }
}

/// One event as PostHog's capture endpoint takes it.
pub fn payload(key: &str, id: &str, event: &str, mut properties: Value) -> Value {
    let props = properties
        .as_object_mut()
        .expect("usage properties are an object");
    props.extend([
        ("surface".into(), json!("daemon")),
        ("version".into(), json!(crate::version())),
        ("$os".into(), json!(os())),
        ("arch".into(), json!(std::env::consts::ARCH)),
        ("$lib".into(), json!("hexbot-daemon")),
        // Anonymous: no person profile, no location from the address.
        ("$process_person_profile".into(), json!(false)),
        ("$geoip_disable".into(), json!(true)),
    ]);
    json!({"api_key":key,"event":event,"distinct_id":id,"properties":properties})
}

/// Sends one event in the background when usage data is on. Never fails the caller.
pub fn capture(home: &Path, event: &str, properties: Value) {
    let Some(key) = key() else { return };
    if !enabled(home) || tokio::runtime::Handle::try_current().is_err() {
        return;
    }
    let Some(id) = install_id(home) else { return };
    let body = payload(key, &id, event, properties);
    tokio::spawn(async move {
        if let Ok(client) = crate::http::client(10, 0) {
            let _ = client.post(CAPTURE_URL).json(&body).send().await;
        }
    });
}

/// The event an RPC result is counted as, if any. Methods and codes only.
pub fn event_for(method: &str, result: &crate::Result<Value>) -> Option<(&'static str, Value)> {
    match (method, result) {
        (_, Err(error)) if error.code >= 5000 => {
            Some(("daemon_error", json!({"method":method,"code":error.code})))
        }
        (_, Err(_)) => None,
        ("prompt.submit", _) => Some(("message_sent", json!({"place":"chat"}))),
        ("hexbot.rooms.send", _) => Some(("message_sent", json!({"place":"room"}))),
        ("hexbot.bots.create" | "hexbot.bots.create_primary", _) => {
            Some(("bot_created", json!({})))
        }
        ("hexbot.rooms.create", _) => Some(("room_created", json!({}))),
        _ => None,
    }
}

pub fn rpc(home: &Path, method: &str, result: &crate::Result<Value>) {
    if let Some((event, properties)) = event_for(method, result) {
        capture(home, event, properties);
    }
}

fn count(home: &Path, sql: &str) -> u64 {
    db::open(home)
        .and_then(|conn| Ok(conn.query_row(sql, [], |row| row.get::<_, i64>(0))?))
        .map_or(0, |n| n.max(0) as u64)
}

/// The once-a-day summary: counts only, so active installs can be measured.
pub fn summary(home: &Path) -> Value {
    let settings = settings::get(home).unwrap_or_else(|_| settings::defaults());
    json!({
        "bots": count(home, "SELECT COUNT(*) FROM bots"),
        "rooms": count(home, "SELECT COUNT(*) FROM rooms WHERE archived_at IS NULL"),
        "chats": count(home, "SELECT COUNT(*) FROM sections WHERE archived_at IS NULL"),
        "users": count(home, "SELECT COUNT(*) FROM users WHERE disabled_at IS NULL"),
        "lan": settings["lan_enabled"] == true,
        "approval_mode": settings["approval_mode"],
    })
}

/// Sends `daemon_active` at most once per UTC day.
pub fn daily(home: &Path) {
    if !enabled(home) {
        return;
    }
    let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
    if state(home)["active_day"] == today.as_str() {
        return;
    }
    capture(home, "daemon_active", summary(home));
    // Read again: the capture may have just written the install id.
    let mut next = state(home);
    next["active_day"] = json!(today);
    let _ = common::atomic_write(&home.join(FILE), next.to_string().as_bytes());
}

/// Checks hourly for as long as the daemon runs, so a daemon that stays up still counts each day.
pub fn start(home: std::path::PathBuf) {
    static STARTED: Once = Once::new();
    STARTED.call_once(|| {
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(3600));
            loop {
                tick.tick().await;
                let home = home.clone();
                let _ = tokio::task::spawn_blocking(move || daily(&home)).await;
            }
        });
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Error;

    #[test]
    fn counts_messages_and_creations_without_their_content() {
        let ok = Ok(json!({"text":"private"}));
        assert_eq!(
            event_for("prompt.submit", &ok),
            Some(("message_sent", json!({"place":"chat"})))
        );
        assert_eq!(
            event_for("hexbot.rooms.send", &ok),
            Some(("message_sent", json!({"place":"room"})))
        );
        assert_eq!(
            event_for("hexbot.bots.create", &ok),
            Some(("bot_created", json!({})))
        );
        assert_eq!(
            event_for("hexbot.rooms.create", &ok),
            Some(("room_created", json!({})))
        );
        assert_eq!(event_for("hexbot.bots.list", &ok), None);
    }

    #[test]
    fn reports_internal_errors_by_code_and_never_by_message() {
        let failed = Err(Error::new(5200, "/Users/someone/secret failed"));
        let (event, properties) = event_for("hexbot.rooms.send", &failed).unwrap();
        assert_eq!(event, "daemon_error");
        assert_eq!(
            properties,
            json!({"method":"hexbot.rooms.send","code":5200})
        );
        assert_eq!(
            event_for("hexbot.rooms.send", &Err(Error::new(4201, "bad input"))),
            None
        );
    }

    #[test]
    fn events_are_anonymous() {
        let body = payload("phc_test", "install", "daemon_active", json!({"bots":2}));
        let props = &body["properties"];
        assert_eq!(props["$process_person_profile"], false);
        assert_eq!(props["$geoip_disable"], true);
        assert_eq!(props["surface"], "daemon");
        assert_eq!(props["bots"], 2);
        assert!(props.get("$set").is_none());
    }

    #[test]
    fn do_not_track_and_the_override_refuse() {
        let env = |pairs: &'static [(&'static str, &'static str)]| {
            move |name: &str| {
                pairs
                    .iter()
                    .find(|(k, _)| *k == name)
                    .map(|(_, v)| v.to_string())
            }
        };
        assert!(refused(env(&[("DO_NOT_TRACK", "1")])));
        assert!(refused(env(&[("HEXBOT_USAGE_DATA", "0")])));
        assert!(!refused(env(&[("DO_NOT_TRACK", "0")])));
        assert!(!refused(env(&[])));
    }

    #[test]
    fn off_by_default_and_forgetting_removes_the_id() {
        let home = tempfile::tempdir().unwrap();
        db::migrate(home.path()).unwrap();
        assert_eq!(settings::get(home.path()).unwrap()["usage_data"], false);
        assert!(!enabled(home.path()));
        let id = install_id(home.path()).unwrap();
        assert_eq!(install_id(home.path()).unwrap(), id);
        forget(home.path());
        assert_ne!(install_id(home.path()).unwrap(), id);
    }

    #[test]
    fn summary_holds_counts_only() {
        let home = tempfile::tempdir().unwrap();
        db::migrate(home.path()).unwrap();
        let summary = summary(home.path());
        for key in summary.as_object().unwrap().keys() {
            assert!(
                ["bots", "rooms", "chats", "users", "lan", "approval_mode"].contains(&key.as_str())
            );
        }
    }
}
