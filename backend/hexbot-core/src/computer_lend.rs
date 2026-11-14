//! Computers lent by desktop apps. The user turns on "Let bots use this
//! computer" in the Hexbot app on that computer; the app offers it over its
//! own paired connection (`hexbot.computers.offer`), so it works over LAN,
//! Tailscale and Connect alike, and stops when the app disconnects.
//!
//! The daemon decides everything: which bot, which computer, the approval
//! and the sandbox level. The app only runs what it is sent, on that one
//! connection: a shell command at a sandbox level, or one of Cua's screen
//! tools (`hexbot.computer.request`), and answers with `hexbot.computers.reply`.
use crate::{Error, Result};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        Mutex, OnceLock,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::sync::{mpsc::UnboundedSender, oneshot};

/// How long the daemon waits for an app to answer one request.
const REPLY_WAIT: Duration = Duration::from_secs(150);

/// One open offer: the connection that made it and what it lends.
struct Offer {
    connection: u64,
    owner: String,
    name: String,
    os: String,
    screen: bool,
    send: UnboundedSender<String>,
}

type Pending = (PathBuf, String, oneshot::Sender<Result<Value>>);

fn offers() -> &'static Mutex<HashMap<(PathBuf, String), Offer>> {
    static OFFERS: OnceLock<Mutex<HashMap<(PathBuf, String), Offer>>> = OnceLock::new();
    OFFERS.get_or_init(Default::default)
}
fn pending() -> &'static Mutex<HashMap<String, Pending>> {
    static PENDING: OnceLock<Mutex<HashMap<String, Pending>>> = OnceLock::new();
    PENDING.get_or_init(Default::default)
}

/// A number for each WebSocket connection, so an offer ends with its own.
pub fn connection_id() -> u64 {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    NEXT.fetch_add(1, Ordering::Relaxed)
}

/// The id bots and clients use for a device's computer.
pub fn computer_id(device: &str) -> String {
    format!(
        "app-{}",
        device
            .chars()
            .filter(char::is_ascii_alphanumeric)
            .take(8)
            .collect::<String>()
    )
}

/// What an app lends now, if it is connected: name, OS, and whether its
/// screen is lent too.
pub fn online(home: &Path, device: &str) -> Option<(String, String, bool)> {
    offers()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&(home.to_owned(), device.to_owned()))
        .map(|offer| (offer.name.clone(), offer.os.clone(), offer.screen))
}

fn short(p: &Value, key: &str, limit: usize) -> Result<String> {
    let text = p[key].as_str().unwrap_or("").trim();
    if text.is_empty() || text.chars().count() > limit || text.chars().any(char::is_control) {
        return Err(Error::new(
            4202,
            format!("{key} must be 1 to {limit} characters"),
        ));
    }
    Ok(text.to_owned())
}

/// `hexbot.computers.offer {name, os, screen}` from a desktop app.
pub fn offer(
    home: &Path,
    owner: &str,
    device: &str,
    connection: u64,
    send: UnboundedSender<String>,
    p: &Value,
) -> Result<Value> {
    if device.is_empty() {
        return Err(Error::new(4302, "Only a paired app can lend its computer."));
    }
    let name = short(p, "name", 64)?;
    let os = short(p, "os", 32)?;
    let screen = p["screen"] == true;
    crate::computer_access::remember_device(home, device, &name, &os, screen)?;
    offers().lock().unwrap_or_else(|e| e.into_inner()).insert(
        (home.to_owned(), device.to_owned()),
        Offer {
            connection,
            owner: owner.to_owned(),
            name,
            os,
            screen,
            send,
        },
    );
    Ok(json!({"computer": computer_id(device)}))
}

/// The app stopped lending, or its connection closed. Requests waiting on
/// it fail at once.
pub fn withdraw(home: &Path, device: &str, connection: u64) -> bool {
    let key = (home.to_owned(), device.to_owned());
    let mut offers = offers().lock().unwrap_or_else(|e| e.into_inner());
    if offers
        .get(&key)
        .is_none_or(|offer| offer.connection != connection)
    {
        return false;
    }
    offers.remove(&key);
    drop(offers);
    let mut waiting = pending().lock().unwrap_or_else(|e| e.into_inner());
    let gone = waiting
        .iter()
        .filter(|(_, (h, d, _))| h == home && d == device)
        .map(|(id, _)| id.clone())
        .collect::<Vec<_>>();
    for id in gone {
        if let Some((.., reply)) = waiting.remove(&id) {
            let _ = reply.send(Err(offline()));
        }
    }
    true
}

/// The owner of a lent computer, to tell their apps when it comes and goes.
pub fn owner(home: &Path, device: &str) -> Option<String> {
    offers()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&(home.to_owned(), device.to_owned()))
        .map(|offer| offer.owner.clone())
}

fn offline() -> Error {
    Error::new(
        4302,
        "That computer is offline: the Hexbot app there is closed or stopped lending it.",
    )
}

/// Send one request to the app lending `device` and wait for its answer.
pub async fn request(home: &Path, device: &str, kind: &str, mut payload: Value) -> Result<Value> {
    let id = crate::common::id();
    let (reply, answer) = oneshot::channel();
    payload["id"] = json!(id);
    payload["kind"] = json!(kind);
    let frame = json!({"jsonrpc":"2.0","method":"event","params":{"type":"hexbot.computer.request","payload":payload}});
    pending()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(id.clone(), (home.to_owned(), device.to_owned(), reply));
    let sent = offers()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&(home.to_owned(), device.to_owned()))
        .is_some_and(|offer| offer.send.send(format!("{frame}\n")).is_ok());
    if !sent {
        pending()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&id);
        return Err(offline());
    }
    match tokio::time::timeout(REPLY_WAIT, answer).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err(offline()),
        Err(_) => {
            pending()
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&id);
            Err(Error::new(4211, "That computer took too long to answer."))
        }
    }
}

/// `hexbot.computers.reply {id, result | error}` from the app that was asked.
pub fn reply(home: &Path, device: &str, p: &Value) -> Result<Value> {
    let id = crate::common::required(p, "id")?;
    let mut waiting = pending().lock().unwrap_or_else(|e| e.into_inner());
    // Only the device that was asked can answer.
    if waiting
        .get(id)
        .is_none_or(|(h, d, _)| h != home || d != device)
    {
        return Err(Error::new(4204, "no such request"));
    }
    let (.., answer) = waiting.remove(id).expect("checked above");
    let result = match p["error"].as_str() {
        Some(message) => Err(Error::new(
            4211,
            message.chars().take(2000).collect::<String>(),
        )),
        None => Ok(p["result"].clone()),
    };
    let _ = answer.send(result);
    Ok(json!({"ok":true}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn requests_go_to_the_offering_connection_and_only_it_answers() {
        let home = tempfile::tempdir().unwrap();
        let (send, mut frames) = tokio::sync::mpsc::unbounded_channel();
        offer(
            home.path(),
            "local",
            "d1-abc",
            7,
            send,
            &json!({"name":"Laptop","os":"macOS","screen":true}),
        )
        .unwrap();
        assert_eq!(
            online(home.path(), "d1-abc"),
            Some(("Laptop".into(), "macOS".into(), true))
        );
        let asked = tokio::spawn({
            let home = home.path().to_owned();
            async move { request(&home, "d1-abc", "shell", json!({"command":"uname"})).await }
        });
        let frame: Value = serde_json::from_str(frames.recv().await.unwrap().trim()).unwrap();
        assert_eq!(frame["params"]["type"], "hexbot.computer.request");
        let payload = &frame["params"]["payload"];
        assert_eq!(payload["kind"], "shell");
        assert_eq!(payload["command"], "uname");
        let id = payload["id"].as_str().unwrap();
        // Another device cannot answer it.
        assert!(reply(home.path(), "other", &json!({"id":id,"result":{}})).is_err());
        reply(
            home.path(),
            "d1-abc",
            &json!({"id":id,"result":{"output":"Darwin"}}),
        )
        .unwrap();
        assert_eq!(asked.await.unwrap().unwrap()["output"], "Darwin");
    }

    #[tokio::test]
    async fn closing_the_connection_ends_the_offer_and_fails_what_waits() {
        let home = tempfile::tempdir().unwrap();
        let (send, mut frames) = tokio::sync::mpsc::unbounded_channel();
        let p = json!({"name":"Laptop","os":"macOS"});
        offer(home.path(), "local", "d1", 7, send, &p).unwrap();
        let asked = tokio::spawn({
            let home = home.path().to_owned();
            async move { request(&home, "d1", "shell", json!({"command":"sleep 9"})).await }
        });
        frames.recv().await.unwrap();
        // An older connection of the same device does not end the new offer.
        assert!(!withdraw(home.path(), "d1", 6));
        assert!(withdraw(home.path(), "d1", 7));
        assert!(
            asked
                .await
                .unwrap()
                .unwrap_err()
                .message
                .contains("offline")
        );
        assert!(online(home.path(), "d1").is_none());
        let error = request(home.path(), "d1", "shell", json!({}))
            .await
            .unwrap_err();
        assert!(error.message.contains("offline"));
    }

    #[test]
    fn offers_need_a_device_and_a_short_name() {
        let home = tempfile::tempdir().unwrap();
        let (send, _frames) = tokio::sync::mpsc::unbounded_channel();
        assert!(
            offer(
                home.path(),
                "local",
                "",
                1,
                send.clone(),
                &json!({"name":"A","os":"macOS"})
            )
            .is_err()
        );
        assert!(
            offer(
                home.path(),
                "local",
                "d",
                1,
                send,
                &json!({"name":"","os":"macOS"})
            )
            .is_err()
        );
        assert_eq!(computer_id("1f2e-3d4c-5b6a-7980"), "app-1f2e3d4c");
    }
}
