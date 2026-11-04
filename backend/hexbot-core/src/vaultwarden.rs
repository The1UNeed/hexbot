//! Vaultwarden, or any Bitwarden-compatible server, as the store for a
//! user's Passwords. Hexbot never does Bitwarden's cryptography itself: it
//! runs the official Bitwarden CLI, `bw`, which logs in, unlocks the vault
//! with the master password, and encrypts and decrypts every item.
//!
//! Each user gets their own `bw` data folder,
//! `users/<id>/passwords/bitwarden`, inside the owner-only folder bots'
//! shells can't read. The master password is kept where the vault key is
//! (`passwords::keep`): the OS keychain, or an owner-only file. The session
//! key `bw unlock` returns lives in memory only, and reaches `bw` in its
//! environment, never on a command line; so do item contents, on stdin.
//!
//! Hexbot uses only the items in the account's **Hexbot** folder, made when
//! it connects. A login is a Login item; an API key a Login item whose
//! password is the key; an SSH key a Secure note with hidden fields, which
//! every Bitwarden app shows (an SSH key item made in a Bitwarden app is read
//! too). Custom fields carry what Hexbot adds: `hexbot.kind`, `hexbot.bots`,
//! `Variable`, `Private key`, `Public key`, `Passphrase`.
use crate::{
    Error, Result, common,
    passwords::{self, Kind, Record},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

/// The name `passwords::keep` stores the master password under.
pub const SECRET: &str = "vaultwarden";
/// The folder whose items Hexbot uses.
const FOLDER: &str = "Hexbot";
/// How long `bw` may take: a login runs the account's key derivation.
const TIMEOUT: Duration = Duration::from_secs(90);
/// How stale the CLI's copy of the vault may get before a list syncs.
const SYNC_AFTER: Duration = Duration::from_secs(30);
/// Custom fields Hexbot writes; others on an item stay as they are.
const MANAGED: &[&str] = &[
    "hexbot.kind",
    "hexbot.bots",
    "Variable",
    "Private key",
    "Public key",
    "Passphrase",
];
/// `bw` says this when its session key is gone or wrong.
const LOCKED: i64 = 5302;

/// A user's Vaultwarden, from `users/<id>/passwords/vaultwarden.json`.
#[derive(Clone, Debug)]
pub struct Account {
    pub server: String,
    pub email: String,
    /// The id of the Hexbot folder.
    pub folder: String,
}

fn config_path(home: &Path, owner: &str) -> Result<PathBuf> {
    Ok(passwords::dir(home, owner)?.join("vaultwarden.json"))
}
fn data_dir(home: &Path, owner: &str) -> Result<PathBuf> {
    Ok(passwords::folder(home, owner)?.join("bitwarden"))
}

/// The user's Vaultwarden, once they connected one.
pub fn account(home: &Path, owner: &str) -> Result<Option<Account>> {
    let text = match std::fs::read_to_string(config_path(home, owner)?) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    let saved: Value = serde_json::from_str(&text)
        .map_err(|_| Error::new(5300, "Hexbot can't read its Vaultwarden settings."))?;
    let field = |key: &str| saved[key].as_str().unwrap_or("").to_owned();
    Ok(Some(Account {
        server: field("server"),
        email: field("email"),
        folder: field("folder"),
    }))
}

/// Where Settings says the items are: `{kind: "local"}` or
/// `{kind: "vaultwarden", server, email, folder}`.
pub fn status(home: &Path, owner: &str) -> Result<Value> {
    Ok(match account(home, owner)? {
        None => json!({"kind": "local"}),
        Some(account) => json!({
            "kind": "vaultwarden",
            "server": account.server,
            "email": account.email,
            "folder": FOLDER,
        }),
    })
}

/// The `bw` program: `passwords.bitwarden_command` in config.yaml, then
/// `HEXBOT_BW_CMD`, then `bw` on the PATH.
fn program(home: &Path) -> Result<PathBuf> {
    let configured = common::read_config(home)?["passwords"]["bitwarden_command"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .or_else(|| {
            std::env::var("HEXBOT_BW_CMD")
                .ok()
                .filter(|s| !s.is_empty())
        });
    crate::native_tools::on_path(configured.as_deref().unwrap_or("bw")).ok_or_else(|| {
        Error::new(
            5301,
            "Hexbot needs the Bitwarden CLI on the daemon's computer. Install it with `npm install -g @bitwarden/cli` or `brew install bitwarden-cli`, then try again.",
        )
    })
}

/// What `bw` printed, and whether it exited cleanly.
struct Output {
    ok: bool,
    stdout: String,
    stderr: String,
}

/// Runs `bw` with only the environment it needs. `secret` goes in
/// `BW_PASSWORD`, `session` in `BW_SESSION`, `input` on stdin.
fn bw(
    home: &Path,
    owner: &str,
    args: &[&str],
    input: Option<&str>,
    session: Option<&str>,
    secret: Option<&str>,
) -> Result<Output> {
    let program = program(home)?;
    let data = data_dir(home, owner)?;
    std::fs::create_dir_all(&data)?;
    let mut command = Command::new(program);
    command
        .args(args)
        .arg("--nointeraction")
        .env_clear()
        .env("BITWARDENCLI_APPDATA_DIR", &data)
        .env("NODE_NO_WARNINGS", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // A private CA, a proxy, and what Node needs to find itself.
    for name in [
        "PATH",
        "HOME",
        "USERPROFILE",
        "SystemRoot",
        "TMPDIR",
        "TEMP",
        "LANG",
        "NODE_EXTRA_CA_CERTS",
        "SSL_CERT_FILE",
        "HTTPS_PROXY",
        "HTTP_PROXY",
        "NO_PROXY",
        "https_proxy",
        "http_proxy",
        "no_proxy",
    ] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    if let Some(session) = session {
        command.env("BW_SESSION", session);
    }
    if let Some(secret) = secret {
        command.env("BW_PASSWORD", secret);
    }
    let mut child = command
        .spawn()
        .map_err(|e| Error::new(5301, format!("Hexbot can't start the Bitwarden CLI: {e}")))?;
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(input.unwrap_or("").as_bytes());
    }
    // Read while it runs: a large vault fills a pipe before `bw` exits.
    let read = |pipe: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut text = String::new();
            if let Some(mut pipe) = pipe {
                let _ = pipe.read_to_string(&mut text);
            }
            text
        })
    };
    let stdout = read(
        child
            .stdout
            .take()
            .map(|p| Box::new(p) as Box<dyn Read + Send>),
    );
    let stderr = read(
        child
            .stderr
            .take()
            .map(|p| Box::new(p) as Box<dyn Read + Send>),
    );
    let deadline = Instant::now() + TIMEOUT;
    let status = loop {
        match child.try_wait()? {
            Some(status) => break status,
            None if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            None => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(Error::new(
                    5300,
                    "Vaultwarden didn't answer in time. Check that the server is up.",
                ));
            }
        }
    };
    Ok(Output {
        ok: status.success(),
        stdout: stdout.join().unwrap_or_default(),
        stderr: stderr.join().unwrap_or_default(),
    })
}

/// What `bw` said went wrong: its message, without Node's stack trace.
fn failure(output: &Output) -> Error {
    let message = serde_json::from_str::<Value>(output.stdout.trim())
        .ok()
        .and_then(|v| v["message"].as_str().map(str::to_owned))
        .or_else(|| {
            [&output.stdout, &output.stderr]
                .into_iter()
                .flat_map(|text| text.lines())
                .map(str::trim)
                .rfind(|line| {
                    !line.is_empty()
                        && !line.starts_with("at ")
                        && !line.starts_with("Node.js")
                        && !line.starts_with("ERROR ")
                })
                .map(str::to_owned)
        })
        .unwrap_or_else(|| "the Bitwarden CLI failed".into());
    let lower = message.to_lowercase();
    if lower.contains("vault is locked") {
        Error::new(LOCKED, "Vaultwarden is locked.")
    } else if lower.contains("not logged in") {
        Error::new(
            5303,
            "Hexbot is signed out of Vaultwarden. Connect it again in Settings, Passwords.",
        )
    } else if lower.contains("two-step")
        || lower.contains("two step")
        || lower.contains("code is required")
        || lower.contains("no provider selected")
    {
        Error::new(
            4207,
            "This account uses two-step login. Enter the code from your authenticator app.",
        )
    } else {
        Error::new(5300, format!("Vaultwarden: {message}"))
    }
}

/// A `bw` command whose answer is JSON (`--response`): its `data`.
fn answer(
    home: &Path,
    owner: &str,
    args: &[&str],
    input: Option<&str>,
    session: Option<&str>,
) -> Result<Value> {
    let mut all = args.to_vec();
    all.push("--response");
    let output = bw(home, owner, &all, input, session, None)?;
    let reply: Value = serde_json::from_str(output.stdout.trim()).unwrap_or(Value::Null);
    if output.ok && reply["success"] == true {
        Ok(reply["data"].clone())
    } else {
        Err(failure(&output))
    }
}

type Key = (PathBuf, String);
/// Session keys by daemon home and user, in memory only.
fn sessions() -> &'static Mutex<HashMap<Key, String>> {
    static SESSIONS: OnceLock<Mutex<HashMap<Key, String>>> = OnceLock::new();
    SESSIONS.get_or_init(Default::default)
}
/// When each user's copy of the vault last synced.
fn synced() -> &'static Mutex<HashMap<Key, Instant>> {
    static SYNCED: OnceLock<Mutex<HashMap<Key, Instant>>> = OnceLock::new();
    SYNCED.get_or_init(Default::default)
}
fn key(home: &Path, owner: &str) -> Key {
    (home.to_owned(), owner.to_owned())
}

/// Unlocks with the kept master password, once per daemon run.
fn session(home: &Path, owner: &str) -> Result<String> {
    if let Some(session) = sessions().lock().unwrap().get(&key(home, owner)) {
        return Ok(session.clone());
    }
    let (password, _) = passwords::kept(home, owner, SECRET)?.ok_or_else(|| {
        Error::new(
            5300,
            "Hexbot can't find your Vaultwarden master password. Connect Vaultwarden again in Settings, Passwords.",
        )
    })?;
    let output = bw(
        home,
        owner,
        &["unlock", "--passwordenv", "BW_PASSWORD", "--raw"],
        None,
        None,
        Some(&password),
    )?;
    let session = output.stdout.trim().to_owned();
    if !output.ok || session.is_empty() || session.contains(char::is_whitespace) {
        return Err(failure(&output));
    }
    sessions()
        .lock()
        .unwrap()
        .insert(key(home, owner), session.clone());
    Ok(session)
}

/// A command on the unlocked vault; a session `bw` forgot unlocks again once.
fn vault(home: &Path, owner: &str, args: &[&str], input: Option<&str>) -> Result<Value> {
    let first = session(home, owner)?;
    match answer(home, owner, args, input, Some(&first)) {
        Err(error) if error.code == LOCKED => {
            sessions().lock().unwrap().remove(&key(home, owner));
            answer(home, owner, args, input, Some(&session(home, owner)?))
        }
        result => result,
    }
}

fn encoded(item: &Value) -> String {
    STANDARD.encode(item.to_string())
}

fn field(item: &Value, name: &str) -> Option<String> {
    item["fields"]
        .as_array()?
        .iter()
        .find(|f| f["name"] == name)
        .and_then(|f| f["value"].as_str())
        .map(str::to_owned)
}

/// An item as Hexbot reads it; None for kinds it doesn't use, such as cards.
fn record_of(item: &Value) -> Option<Record> {
    let text = |value: &Value| value.as_str().unwrap_or("").to_owned();
    let title = text(&item["name"]);
    let marked = field(item, "hexbot.kind");
    let mut record = match item["type"].as_i64()? {
        1 => {
            let kind = if marked.as_deref() == Some("api_key") {
                Kind::ApiKey
            } else {
                Kind::Login
            };
            let login = &item["login"];
            let totp = text(&login["totp"]);
            Record {
                kind,
                url: text(&login["uris"][0]["uri"]),
                username: text(&login["username"]),
                password: text(&login["password"]),
                // Bitwarden takes a bare key too; Hexbot reads an otpauth link.
                otp: if totp.is_empty() {
                    totp
                } else {
                    passwords::otp_uri(&totp, &title).unwrap_or_default()
                },
                env: field(item, "Variable").unwrap_or_default(),
                ..Record::new(kind)
            }
        }
        2 if marked.as_deref() == Some("ssh_key") => Record {
            private_key: field(item, "Private key").unwrap_or_default(),
            public_key: field(item, "Public key").unwrap_or_default(),
            password: field(item, "Passphrase").unwrap_or_default(),
            ..Record::new(Kind::SshKey)
        },
        5 => Record {
            private_key: text(&item["sshKey"]["privateKey"]),
            public_key: text(&item["sshKey"]["publicKey"]),
            ..Record::new(Kind::SshKey)
        },
        _ => return None,
    };
    record.title = title;
    record.notes = text(&item["notes"]);
    record.bots = field(item, "hexbot.bots").and_then(|b| serde_json::from_str(&b).ok());
    record.updated_at = item["revisionDate"]
        .as_str()
        .and_then(|d| chrono::DateTime::parse_from_rfc3339(d).ok())
        .map(|d| d.timestamp());
    Some(record)
}

/// The item to save: `base` (the item as Vaultwarden has it, or a new one)
/// with Hexbot's fields written over it. Fields, URIs and anything else a
/// Bitwarden app added stay.
fn item_of(record: &Record, mut base: Value) -> Value {
    let mut fields = base["fields"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|f| !f["name"].as_str().is_some_and(|n| MANAGED.contains(&n)))
        .collect::<Vec<_>>();
    let mut add = |name: &str, value: &str, hidden: bool| {
        fields.push(json!({"name": name, "value": value, "type": if hidden { 1 } else { 0 }}));
    };
    if record.kind != Kind::Login {
        add("hexbot.kind", record.kind.name(), false);
    }
    if let Some(bots) = &record.bots {
        add("hexbot.bots", &json!(bots).to_string(), false);
    }
    base["name"] = json!(record.title);
    base["notes"] = if record.notes.is_empty() {
        Value::Null
    } else {
        json!(record.notes)
    };
    match record.kind {
        Kind::Login | Kind::ApiKey => {
            if record.kind == Kind::ApiKey {
                add("Variable", &record.env, false);
            }
            let mut login = base["login"].as_object().cloned().unwrap_or_default();
            let rest = login
                .get("uris")
                .and_then(Value::as_array)
                .map(|uris| uris.iter().skip(1).cloned().collect::<Vec<_>>())
                .unwrap_or_default();
            let mut uris = vec![];
            if !record.url.is_empty() {
                uris.push(json!({"uri": record.url, "match": null}));
            }
            uris.extend(rest);
            login.insert("uris".into(), json!(uris));
            login.insert("username".into(), json!(record.username));
            login.insert("password".into(), json!(record.password));
            login.insert(
                "totp".into(),
                if record.otp.is_empty() {
                    Value::Null
                } else {
                    json!(record.otp)
                },
            );
            base["type"] = json!(1);
            base["login"] = Value::Object(login);
        }
        Kind::SshKey if base["type"] == 5 => {
            base["sshKey"] = json!({
                "privateKey": record.private_key,
                "publicKey": record.public_key,
                "keyFingerprint": passwords::fingerprint(&record.public_key),
            });
        }
        Kind::SshKey => {
            add("Private key", &record.private_key, true);
            add("Public key", &record.public_key, false);
            if !record.password.is_empty() {
                add("Passphrase", &record.password, true);
            }
            base["type"] = json!(2);
            base["secureNote"] = json!({"type": 0});
            base["login"] = Value::Null;
        }
    }
    base["fields"] = json!(fields);
    base
}

fn not_found() -> Error {
    Error::new(
        4204,
        "No saved password has that id. Use one from the list.",
    )
}

/// Syncs the CLI's copy of the vault when it is more than `SYNC_AFTER` old,
/// so an item moved, changed or unshared in a Bitwarden app counts soon.
fn fresh(home: &Path, owner: &str) -> Result<()> {
    let stale = synced()
        .lock()
        .unwrap()
        .get(&key(home, owner))
        .is_none_or(|at| at.elapsed() > SYNC_AFTER);
    if stale {
        vault(home, owner, &["sync"], None)?;
        synced()
            .lock()
            .unwrap()
            .insert(key(home, owner), Instant::now());
    }
    Ok(())
}

/// The item as Vaultwarden has it, if it is in the Hexbot folder.
fn raw(home: &Path, owner: &str, account: &Account, id: &str) -> Result<Value> {
    if uuid::Uuid::parse_str(id).is_err() {
        return Err(not_found());
    }
    fresh(home, owner)?;
    let item = vault(home, owner, &["get", "item", id], None).map_err(|error| {
        if error.code == 5300 && error.message.to_lowercase().contains("not found") {
            not_found()
        } else {
            error
        }
    })?;
    if item["folderId"] != account.folder || !item["deletedDate"].is_null() {
        return Err(not_found());
    }
    Ok(item)
}

/// The items in the Hexbot folder, fresh from the server at most
/// `SYNC_AFTER` ago.
pub(crate) fn list(home: &Path, owner: &str, account: &Account) -> Result<Vec<(String, Record)>> {
    fresh(home, owner)?;
    let items = vault(
        home,
        owner,
        &["list", "items", "--folderid", &account.folder],
        None,
    )?;
    Ok(items["data"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| Some((item["id"].as_str()?.to_owned(), record_of(item)?)))
        .collect())
}

pub(crate) fn get(home: &Path, owner: &str, account: &Account, id: &str) -> Result<Record> {
    record_of(&raw(home, owner, account, id)?).ok_or_else(not_found)
}

/// Creates an item in the Hexbot folder (no `id`) or changes one there.
pub(crate) fn put(
    home: &Path,
    owner: &str,
    account: &Account,
    id: Option<&str>,
    record: &Record,
) -> Result<String> {
    let saved = match id {
        Some(id) => {
            let item = item_of(record, raw(home, owner, account, id)?);
            vault(home, owner, &["edit", "item", id], Some(&encoded(&item)))?
        }
        None => {
            let base = json!({
                "organizationId": null,
                "collectionIds": null,
                "folderId": account.folder,
                "favorite": false,
                "fields": [],
                "reprompt": 0,
            });
            let item = item_of(record, base);
            vault(home, owner, &["create", "item"], Some(&encoded(&item)))?
        }
    };
    saved["id"]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| Error::new(5300, "Vaultwarden didn't say what it saved."))
}

/// Moves an item to Vaultwarden's trash, where Bitwarden apps can restore it.
pub fn delete(home: &Path, owner: &str, account: &Account, id: &str) -> Result<()> {
    raw(home, owner, account, id)?;
    vault(home, owner, &["delete", "item", id], None).map(|_| ())
}

/// Signs in to a Vaultwarden with the user's email and master password, and
/// a two-step code when the account asks for one. Keeps the master password
/// to unlock it after a restart, finds or makes the Hexbot folder, and with
/// `copy` copies every item saved on this daemon into it. The vault on this
/// daemon stays as it was.
pub fn connect(home: &Path, owner: &str, p: &Value) -> Result<Value> {
    let server = common::required(p, "server")?.trim().trim_end_matches('/');
    let parsed = url::Url::parse(server)
        .ok()
        .filter(|u| u.scheme() == "https" && u.host_str().is_some())
        .ok_or_else(|| {
            Error::new(
                4202,
                "The server must be an https address, such as https://vault.example.com.",
            )
        })?;
    let email = common::required(p, "email")?.trim();
    let password = common::required(p, "password")?;
    let code = p["code"].as_str().map(str::trim).filter(|c| !c.is_empty());
    program(home)?;
    // A sign-in that fails part way leaves no password, session or CLI data.
    let signed_in = (|| -> Result<Value> {
        // A fresh sign-in, so a server or account changed here leaves nothing behind.
        forget_session(home, owner);
        let data = data_dir(home, owner)?;
        match std::fs::remove_dir_all(&data) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.into()),
            _ => {}
        }
        answer(
            home,
            owner,
            &["config", "server", parsed.as_str()],
            None,
            None,
        )?;
        let mut login = vec!["login", email, "--passwordenv", "BW_PASSWORD", "--raw"];
        if let Some(code) = code {
            login.extend(["--method", "0", "--code", code]);
        }
        let output = bw(home, owner, &login, None, None, Some(password))?;
        let session = output.stdout.trim().to_owned();
        if !output.ok || session.is_empty() || session.contains(char::is_whitespace) {
            return Err(failure(&output));
        }
        sessions().lock().unwrap().insert(key(home, owner), session);
        passwords::keep(home, owner, SECRET, password)?;
        let folders = vault(home, owner, &["list", "folders"], None)?;
        let folder = match folders["data"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|f| f["name"] == FOLDER)
        {
            Some(folder) => folder["id"].as_str().unwrap_or("").to_owned(),
            None => vault(
                home,
                owner,
                &["create", "folder"],
                Some(&encoded(&json!({"name": FOLDER}))),
            )?["id"]
                .as_str()
                .unwrap_or("")
                .to_owned(),
        };
        if folder.is_empty() {
            return Err(Error::new(
                5300,
                "Vaultwarden didn't make the Hexbot folder.",
            ));
        }
        let account = Account {
            server: server.to_owned(),
            email: email.to_owned(),
            folder,
        };
        let mut copied = 0;
        if p["copy"] == true {
            for item in passwords::local_items(home, owner)? {
                put(home, owner, &account, None, &item)?;
                copied += 1;
            }
        }
        common::atomic_write(
            &config_path(home, owner)?,
            json!({"server": account.server, "email": account.email, "folder": account.folder})
                .to_string()
                .as_bytes(),
        )?;
        Ok(json!({"vault": status(home, owner)?, "copied": copied}))
    })();
    match signed_in {
        Err(mut error) => {
            // A master password the keychain wouldn't give back is said too;
            // Disconnect, or connecting again, removes it.
            if let Err(left) = clear(home, owner) {
                error.message = format!("{} {}", error.message, left.message);
            }
            Err(error)
        }
        ok => ok,
    }
}

/// Removes everything a connection keeps on the daemon, whatever is left.
fn clear(home: &Path, owner: &str) -> Result<()> {
    forget_session(home, owner);
    passwords::forget(home, owner, SECRET)?;
    for removed in [
        std::fs::remove_dir_all(data_dir(home, owner)?),
        std::fs::remove_file(config_path(home, owner)?),
    ] {
        match removed {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.into()),
            _ => {}
        }
    }
    Ok(())
}

fn forget_session(home: &Path, owner: &str) {
    sessions().lock().unwrap().remove(&key(home, owner));
    synced().lock().unwrap().remove(&key(home, owner));
}

/// Signs out and forgets the master password; Passwords goes back to the
/// vault on this daemon. Nothing in Vaultwarden is deleted. It runs whole
/// every time, so it also cleans up after a failed connect.
pub fn disconnect(home: &Path, owner: &str) -> Result<()> {
    if data_dir(home, owner)?.exists() && program(home).is_ok() {
        let _ = bw(home, owner, &["logout"], None, None, None);
    }
    clear(home, owner)
}

#[cfg(all(test, unix))]
#[path = "vaultwarden_tests.rs"]
mod tests;
