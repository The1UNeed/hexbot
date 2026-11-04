//! Passwords: one KeePass (KDBX 4) vault per user,
//! `users/<id>/passwords/passwords.kdbx`. Its key is a random 256-bit secret
//! kept in the OS keychain (the macOS Keychain, or the Secret Service on
//! Linux), or, where there is none, in `users/<id>/passwords/passwords.key`,
//! readable by its owner only. Both, and the temporary files written on the
//! way, stay in that one folder, which bots' shells can't read. The key is the
//! vault's KeePass password, so KeePassXC and other KeePass apps open it too.
//!
//! The vault holds three kinds of item, named in each entry's custom data
//! (none means a login, so entries made in another KeePass app are logins):
//!
//! - a **login**: site, username, password and a one-time code key;
//! - an **SSH key**: an OpenSSH private key in the protected field
//!   `Private key`, its passphrase as the entry's password, and its public
//!   key in `Public key`;
//! - an **API key**: the key as the entry's password and the environment
//!   variable a command reads it from in `Variable`.
//!
//! Bots never read a secret. They list items (never a secret), ask the user
//! for a login or an API key through a card, have the daemon type a login
//! into a page, and run commands on the bots' computer with SSH keys in an
//! agent and API keys in the environment (`runtime_passwords.rs`). Each item
//! names the bots that may use it in its custom data; no list means every bot.
use crate::{Error, Result, common, db};
use keepass::{
    Database, DatabaseKey,
    config::{DatabaseConfig, KdfConfig},
    db::{CustomDataItem, CustomDataValue, EntryId, fields},
};
use serde_json::{Value, json};
use std::{
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

/// Entry custom data: the bots that may use an item, as a JSON array.
const BOTS: &str = "hexbot.bots";
/// Entry custom data: the item's kind; none is a login.
const KIND: &str = "hexbot.kind";
/// An SSH key's fields, named for people reading the vault in KeePassXC.
const PRIVATE_KEY: &str = "Private key";
const PUBLIC_KEY: &str = "Public key";
/// The environment variable an API key goes in.
const VARIABLE: &str = "Variable";
/// A private key is longer than other fields: an 8192-bit RSA key is 6.5 KB.
const MAX_KEY: usize = 16 * 1024;
/// Variables a key may not take: the shell and ssh need them.
const RESERVED_VARIABLES: &[&str] = &[
    "BASH_ENV",
    // Variables of the script that runs a command with keys.
    "d",
    "hexbot_agent",
    "ENV",
    "HOME",
    "IFS",
    "LD_LIBRARY_PATH",
    "LD_PRELOAD",
    "PATH",
    "PS4",
    "PWD",
    "SHELL",
    "SSH_AGENT_PID",
    "SSH_AUTH_SOCK",
    "USER",
];

/// What an item holds.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    Login,
    SshKey,
    ApiKey,
}
impl Kind {
    pub fn name(self) -> &'static str {
        match self {
            Kind::Login => "login",
            Kind::SshKey => "ssh_key",
            Kind::ApiKey => "api_key",
        }
    }
    pub fn parse(name: &str) -> Result<Kind> {
        match name {
            "login" => Ok(Kind::Login),
            "ssh_key" => Ok(Kind::SshKey),
            "api_key" => Ok(Kind::ApiKey),
            other => Err(Error::new(
                4202,
                format!("unknown kind: {other}. Use login, ssh_key or api_key."),
            )),
        }
    }
    /// The kind of an item as `row` writes it.
    pub fn of(item: &Value) -> Kind {
        item["kind"]
            .as_str()
            .and_then(|k| Kind::parse(k).ok())
            .unwrap_or(Kind::Login)
    }
    fn words(self) -> &'static str {
        match self {
            Kind::Login => "login",
            Kind::SshKey => "SSH key",
            Kind::ApiKey => "API key",
        }
    }
}
/// The keychain item's service name.
const SERVICE: &str = "hexbot-passwords";
const MAX_FIELD: usize = 4096;

/// Where a vault's key lives.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Store {
    Keychain,
    SecretService,
    File,
}
impl Store {
    pub(crate) fn name(self) -> &'static str {
        match self {
            Store::Keychain => "keychain",
            Store::SecretService => "secret_service",
            Store::File => "file",
        }
    }
}

/// The OS store this platform tries first. `HEXBOT_PASSWORD_KEY_STORE=file`
/// skips it; tests never touch the user's keychain.
fn os_store() -> Option<Store> {
    if cfg!(test) || std::env::var("HEXBOT_PASSWORD_KEY_STORE").as_deref() == Ok("file") {
        return None;
    }
    if cfg!(target_os = "macos") {
        Some(Store::Keychain)
    } else if cfg!(target_os = "linux") {
        Some(Store::SecretService)
    } else {
        None
    }
}

pub(crate) fn dir(home: &Path, owner: &str) -> Result<PathBuf> {
    common::identifier(owner)?;
    Ok(home.join("users").join(owner).join("passwords"))
}
/// The folder for the vault, its key and their temporary files, owner only.
fn private_dir(home: &Path, owner: &str) -> Result<()> {
    let dir = dir(home, owner)?;
    std::fs::create_dir_all(&dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}
fn vault_path(home: &Path, owner: &str) -> Result<PathBuf> {
    Ok(dir(home, owner)?.join("passwords.kdbx"))
}
fn key_path(home: &Path, owner: &str) -> Result<PathBuf> {
    Ok(dir(home, owner)?.join("passwords.key"))
}

/// One keychain item per daemon home and user, so dev daemons never share
/// the installed one's key.
fn account(home: &Path, owner: &str) -> String {
    use sha2::Digest;
    let home = std::fs::canonicalize(home).unwrap_or_else(|_| home.to_owned());
    let digest = sha2::Sha256::digest(home.to_string_lossy().as_bytes());
    let short = digest[..8]
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    format!("{owner}-{short}")
}

/// Runs a helper with `input` on stdin, never on its command line.
fn helper(program: &str, args: &[&str], input: &[u8]) -> Option<(i32, String)> {
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(input);
    }
    // A keyring that wants a GUI unlock nobody sees must not hang the daemon.
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    let output = child.wait_with_output().ok()?;
    Some((
        output.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&output.stdout).trim().to_owned(),
    ))
}

/// The key from the OS store: `Ok(None)` when it holds none, `Err` when the
/// store could not be asked.
fn os_read(store: Store, account: &str) -> Result<Option<String>> {
    let answer = match store {
        Store::Keychain => helper(
            "/usr/bin/security",
            &["find-generic-password", "-s", SERVICE, "-a", account, "-w"],
            b"",
        ),
        Store::SecretService => helper(
            "secret-tool",
            &["lookup", "service", SERVICE, "account", account],
            b"",
        ),
        Store::File => return Ok(None),
    };
    match answer {
        Some((0, key)) if !key.is_empty() => Ok(Some(key)),
        // The Keychain says 44 for no such item; secret-tool prints nothing.
        Some((44, _)) if store == Store::Keychain => Ok(None),
        Some((_, key)) if store == Store::SecretService && key.is_empty() => Ok(None),
        _ => Err(locked()),
    }
}

fn os_write(store: Store, account: &str, key: &str) -> bool {
    let done = match store {
        // `security -i` reads its command from stdin, so the key never shows in `ps`.
        Store::Keychain => helper(
            "/usr/bin/security",
            &["-i"],
            format!(
                "add-generic-password -U -s {SERVICE} -a {account} -l \"Hexbot passwords\" -w {key}\n"
            )
            .as_bytes(),
        ),
        Store::SecretService => helper(
            "secret-tool",
            &[
                "store",
                "--label=Hexbot passwords",
                "service",
                SERVICE,
                "account",
                account,
            ],
            key.as_bytes(),
        ),
        Store::File => return false,
    };
    matches!(done, Some((0, _))) && os_read(store, account).ok().flatten().as_deref() == Some(key)
}

/// Removes an item from the OS store; one that is already gone is fine. A
/// store whose helper isn't installed holds nothing Hexbot wrote.
fn os_delete(store: Store, account: &str) -> Result<()> {
    let program = match store {
        Store::Keychain => "/usr/bin/security",
        Store::SecretService => "secret-tool",
        Store::File => return Ok(()),
    };
    if crate::native_tools::on_path(program).is_none() {
        return Ok(());
    }
    let done = match store {
        Store::Keychain => helper(
            program,
            &["delete-generic-password", "-s", SERVICE, "-a", account],
            b"",
        ),
        _ => helper(
            program,
            &["clear", "service", SERVICE, "account", account],
            b"",
        ),
    };
    // `security` says 44 for no such item; `secret-tool clear` succeeds then.
    match done {
        Some((0, _)) => Ok(()),
        Some((44, _)) if store == Store::Keychain => Ok(()),
        _ => Err(Error::new(
            5300,
            "Hexbot can't remove a saved key from this computer's keychain. Unlock the keychain and try again.",
        )),
    }
}

/// Another secret kept where the vault key is, such as the Vaultwarden master
/// password: in the OS store, or in `<name>.key` beside the vault, readable
/// by its owner only. It is written as hex, so any text survives the
/// keychain's command line.
pub(crate) fn keep(home: &Path, owner: &str, name: &str, value: &str) -> Result<()> {
    let hex = value
        .bytes()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    let file = dir(home, owner)?.join(format!("{name}.key"));
    let unsure = dir(home, owner)?.join(format!("{name}.os"));
    let os = format!("{}-{name}", account(home, owner));
    let mut left = false;
    if let Some(store) = os_store() {
        if os_write(store, &os, &hex) {
            let _ = std::fs::remove_file(&file);
            return Ok(());
        }
        // A write that didn't read back may still have landed.
        left = os_delete(store, &os).is_err();
    }
    private_dir(home, owner)?;
    if left {
        // `forget` then won't take the file to mean the OS store is empty.
        common::atomic_write(&unsure, b"")?;
    }
    common::atomic_write(&file, hex.as_bytes())
}

/// A secret `keep` wrote, and where it is.
pub(crate) fn kept(home: &Path, owner: &str, name: &str) -> Result<Option<(String, Store)>> {
    let decode = |hex: &str| {
        (0..hex.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(hex.get(i..i + 2)?, 16).ok())
            .collect::<Option<Vec<u8>>>()
            .and_then(|bytes| String::from_utf8(bytes).ok())
    };
    let file = dir(home, owner)?.join(format!("{name}.key"));
    if let Ok(text) = std::fs::read_to_string(&file)
        && let Some(value) = decode(text.trim())
    {
        return Ok(Some((value, Store::File)));
    }
    let Some(store) = os_store() else {
        return Ok(None);
    };
    Ok(os_read(store, &format!("{}-{name}", account(home, owner)))?
        .and_then(|hex| decode(&hex))
        .map(|value| (value, store)))
}

/// Removes a secret `keep` wrote, wherever it is.
pub(crate) fn forget(home: &Path, owner: &str, name: &str) -> Result<()> {
    let unsure = dir(home, owner)?.join(format!("{name}.os"));
    let may_be_in_store = unsure.exists();
    let in_file = match std::fs::remove_file(dir(home, owner)?.join(format!("{name}.key"))) {
        Ok(()) => true,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
        Err(e) => return Err(e.into()),
    };
    match os_store().map(|store| os_delete(store, &format!("{}-{name}", account(home, owner)))) {
        // `keep` uses the file only when the OS store can't take it, unless
        // it left a mark that a copy may have landed there.
        Some(Err(_)) if in_file && !may_be_in_store => Ok(()),
        Some(Err(error)) => Err(error),
        _ => match std::fs::remove_file(&unsure) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.into()),
            _ => Ok(()),
        },
    }
}

/// The folder for a user's items and their keys, made owner-only.
pub(crate) fn folder(home: &Path, owner: &str) -> Result<PathBuf> {
    private_dir(home, owner)?;
    dir(home, owner)
}

fn locked() -> Error {
    Error::new(
        5300,
        "Hexbot can't unlock your passwords: their key is not in this computer's keychain. Unlock the keychain and try again.",
    )
}

/// The vault key and where it lives. With `create`, makes one when there is
/// none and no vault either: in the OS store, or in the key file when that
/// store can't keep it.
fn key(home: &Path, owner: &str, create: bool) -> Result<Option<(String, Store)>> {
    let file = key_path(home, owner)?;
    if let Ok(text) = std::fs::read_to_string(&file) {
        let text = text.trim().to_owned();
        if !text.is_empty() {
            return Ok(Some((text, Store::File)));
        }
    }
    let account = account(home, owner);
    let os = os_store();
    let found = match os {
        Some(store) => match os_read(store, &account) {
            Ok(found) => found.map(|key| (key, store)),
            // A vault whose store can't answer stays locked; without one, a
            // store that can't answer is no store.
            Err(error) if vault_path(home, owner)?.exists() => return Err(error),
            Err(_) => None,
        },
        None => None,
    };
    if found.is_some() || !create {
        return Ok(found);
    }
    if vault_path(home, owner)?.exists() {
        return Err(locked());
    }
    let mut bytes = [0u8; 32];
    rand::Rng::fill(&mut rand::thread_rng(), &mut bytes);
    let key = bytes.iter().map(|b| format!("{b:02x}")).collect::<String>();
    if let Some(store) = os
        && os_write(store, &account, &key)
    {
        return Ok(Some((key, store)));
    }
    private_dir(home, owner)?;
    common::atomic_write(&file, key.as_bytes())?;
    Ok(Some((key, Store::File)))
}

/// Read-modify-write of any vault runs one at a time.
fn lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    // A Vaultwarden call may hold it for a minute.
    blocking(|| {
        LOCK.get_or_init(Default::default)
            .lock()
            .unwrap_or_else(|e| e.into_inner())
    })
}

/// Runs work that waits on another program, such as the Bitwarden CLI, so
/// it doesn't hold an async worker: on the daemon's runtime, the worker's
/// other tasks move to another thread while it waits.
pub(crate) fn blocking<T>(work: impl FnOnce() -> T) -> T {
    use tokio::runtime::{Handle, RuntimeFlavor};
    match Handle::try_current() {
        Ok(handle) if handle.runtime_flavor() == RuntimeFlavor::MultiThread => {
            tokio::task::block_in_place(work)
        }
        _ => work(),
    }
}

/// The key is 256 random bits, so the KDF only has to be one every KeePass
/// app reads, not slow: the default Argon2 settings take a gigabyte.
fn config() -> DatabaseConfig {
    let mut config = DatabaseConfig::default();
    config.kdf_config = KdfConfig::Aes { rounds: 10_000 };
    config
}

struct Vault {
    db: Database,
    key: String,
}

fn database_key(key: &str) -> DatabaseKey {
    DatabaseKey::new().with_password(key)
}

/// The user's vault, or None before anything was saved.
fn load(home: &Path, owner: &str) -> Result<Option<Vault>> {
    let path = vault_path(home, owner)?;
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    let (key, _) = key(home, owner, false)?.ok_or_else(locked)?;
    let db = Database::parse(&bytes, database_key(&key))
        .map_err(|e| Error::new(5300, format!("Hexbot can't open your passwords: {e}")))?;
    Ok(Some(Vault { db, key }))
}

fn load_or_new(home: &Path, owner: &str) -> Result<Vault> {
    if let Some(vault) = load(home, owner)? {
        return Ok(vault);
    }
    let (key, _) = key(home, owner, true)?.ok_or_else(locked)?;
    let mut db = Database::with_config(config());
    db.root_mut().name = "Hexbot".into();
    Ok(Vault { db, key })
}

fn persist(home: &Path, owner: &str, vault: &Vault) -> Result<()> {
    private_dir(home, owner)?;
    let mut bytes = Vec::new();
    vault
        .db
        .save(&mut bytes, database_key(&vault.key))
        .map_err(|e| Error::new(5300, format!("Hexbot can't save your passwords: {e}")))?;
    common::atomic_write(&vault_path(home, owner)?, &bytes)
}

fn entry_id(id: &str) -> Result<EntryId> {
    uuid::Uuid::parse_str(id)
        .map(EntryId::from_uuid)
        .map_err(|_| not_found())
}
fn not_found() -> Error {
    Error::new(
        4204,
        "No saved password has that id. Use one from the list.",
    )
}

/// The host a login or page belongs to, without `www.`.
pub fn host(url: &str) -> Option<String> {
    let url = url::Url::parse(url).ok()?;
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    let host = url.host_str()?.to_ascii_lowercase();
    Some(host.strip_prefix("www.").unwrap_or(&host).to_owned())
}

/// Whether a login saved for `saved` may be typed into `page`: the same
/// host or one inside the other, as browsers autofill, and never from an
/// https login into a plain http page.
pub fn same_site(saved: &str, page: &str) -> bool {
    let (Ok(s), Ok(p)) = (url::Url::parse(saved), url::Url::parse(page)) else {
        return false;
    };
    if s.scheme() == "https" && p.scheme() != "https" {
        return false;
    }
    let (Some(a), Some(b)) = (host(saved), host(page)) else {
        return false;
    };
    a == b || a.ends_with(&format!(".{b}")) || b.ends_with(&format!(".{a}"))
}

fn custom<'a>(entry: &'a keepass::db::Entry, key: &str) -> Option<&'a str> {
    match entry.custom_data.get(key)?.value.as_ref()? {
        CustomDataValue::String(text) => Some(text),
        CustomDataValue::Binary(_) => None,
    }
}

fn set_custom(entry: &mut keepass::db::Entry, key: &str, value: Option<String>) {
    match value {
        None => {
            entry.custom_data.remove(key);
        }
        Some(value) => {
            entry.custom_data.insert(
                key.into(),
                CustomDataItem {
                    value: Some(CustomDataValue::String(value)),
                    last_modification_time: Some(keepass::db::Times::now()),
                },
            );
        }
    }
}

/// `SHA256:…`, as `ssh-keygen -l` and GitHub show a key.
pub(crate) fn fingerprint(public: &str) -> Option<String> {
    let key = ssh_key::PublicKey::from_openssh(public).ok()?;
    Some(key.fingerprint(ssh_key::HashAlg::Sha256).to_string())
}

/// One saved item, whichever store keeps it: the vault on this daemon or
/// Vaultwarden (`vaultwarden.rs`). `password` is a login's password, an API
/// key's key or an SSH key's passphrase; `otp` an `otpauth://` link.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Record {
    pub kind: Kind,
    pub title: String,
    pub url: String,
    pub username: String,
    pub password: String,
    pub otp: String,
    pub notes: String,
    pub private_key: String,
    pub public_key: String,
    pub env: String,
    pub bots: Option<Vec<String>>,
    pub updated_at: Option<i64>,
}

impl Record {
    pub(crate) fn new(kind: Kind) -> Record {
        Record {
            kind,
            title: String::new(),
            url: String::new(),
            username: String::new(),
            password: String::new(),
            otp: String::new(),
            notes: String::new(),
            private_key: String::new(),
            public_key: String::new(),
            env: String::new(),
            bots: None,
            updated_at: None,
        }
    }
}

/// An item as clients and bots read it: never a password, key or code key.
fn row(id: &str, item: &Record) -> Value {
    let title = Some(item.title.clone())
        .filter(|t| !t.is_empty())
        .or_else(|| host(&item.url))
        .unwrap_or_else(|| match item.kind {
            Kind::Login => "Login".into(),
            Kind::SshKey => "SSH key".into(),
            Kind::ApiKey => "API key".into(),
        });
    let mut row = json!({
        "id": id,
        "kind": item.kind.name(),
        "title": title,
        "url": item.url,
        "site": host(&item.url),
        "username": item.username,
        "bots": item.bots,
        "has_password": !item.password.is_empty(),
        "has_code": !item.otp.is_empty(),
        "notes": item.notes,
        "updated_at": item.updated_at,
    });
    match item.kind {
        Kind::Login => {}
        Kind::SshKey => {
            row["public_key"] = json!(item.public_key);
            row["fingerprint"] = json!(fingerprint(&item.public_key));
            row["has_passphrase"] = json!(!item.password.is_empty());
        }
        Kind::ApiKey => row["env"] = json!(item.env),
    }
    row
}

// ---- The vault on this daemon ----

fn bots_of(entry: &keepass::db::Entry) -> Option<Vec<String>> {
    serde_json::from_str(custom(entry, BOTS)?).ok()
}

fn kind_of(entry: &keepass::db::Entry) -> Kind {
    custom(entry, KIND)
        .and_then(|k| Kind::parse(k).ok())
        .unwrap_or(Kind::Login)
}

fn record_of(entry: &keepass::db::Entry) -> Record {
    let text = |name: &str| entry.get(name).unwrap_or("").to_owned();
    Record {
        kind: kind_of(entry),
        title: text(fields::TITLE),
        url: text(fields::URL),
        username: text(fields::USERNAME),
        password: text(fields::PASSWORD),
        otp: entry.get_raw_otp_value().unwrap_or("").to_owned(),
        notes: text(fields::NOTES),
        private_key: text(PRIVATE_KEY),
        public_key: text(PUBLIC_KEY),
        env: text(VARIABLE),
        bots: bots_of(entry),
        updated_at: entry
            .times
            .last_modification
            .map(|t| t.and_utc().timestamp()),
    }
}

/// Writes the fields Hexbot keeps; anything else a KeePass app added stays.
fn write_entry(entry: &mut keepass::db::Entry, item: &Record) {
    if item.kind != Kind::Login {
        set_custom(entry, KIND, Some(item.kind.name().into()));
    }
    entry.set_unprotected(fields::TITLE, &item.title);
    entry.set_unprotected(fields::URL, &item.url);
    entry.set_unprotected(fields::USERNAME, &item.username);
    entry.set_unprotected(fields::NOTES, &item.notes);
    entry.set_protected(fields::PASSWORD, &item.password);
    if item.otp.is_empty() {
        entry.fields.remove(fields::OTP);
    } else {
        entry.set_protected(fields::OTP, &item.otp);
    }
    match item.kind {
        Kind::Login => {}
        Kind::SshKey => {
            entry.set_protected(PRIVATE_KEY, &item.private_key);
            entry.set_unprotected(PUBLIC_KEY, &item.public_key);
        }
        Kind::ApiKey => entry.set_unprotected(VARIABLE, &item.env),
    }
    set_custom(
        entry,
        BOTS,
        item.bots.as_ref().map(|b| json!(b).to_string()),
    );
    let now = keepass::db::Times::now();
    entry.times.last_modification = Some(now);
    if entry.times.creation.is_none() {
        entry.times.creation = Some(now);
    }
}

/// Items outside the recycle bin.
fn local_list(home: &Path, owner: &str) -> Result<Vec<(String, Record)>> {
    let Some(vault) = load(home, owner)? else {
        return Ok(vec![]);
    };
    let bin = vault.db.recycle_bin().map(|g| g.id());
    Ok(vault
        .db
        .iter_all_entries()
        .filter(|e| bin.is_none_or(|bin| e.parent().id() != bin))
        .map(|e| (e.id().uuid().to_string(), record_of(&e)))
        .collect())
}

fn local_get(home: &Path, owner: &str, id: &str) -> Result<Record> {
    let vault = load(home, owner)?.ok_or_else(not_found)?;
    let entry = vault.db.entry(entry_id(id)?).ok_or_else(not_found)?;
    Ok(record_of(&entry))
}

fn local_put(home: &Path, owner: &str, id: Option<&str>, item: &Record) -> Result<String> {
    let mut vault = load_or_new(home, owner)?;
    let id = match id {
        Some(id) => {
            let id = entry_id(id)?;
            vault.db.entry(id).ok_or_else(not_found)?;
            id
        }
        None => vault.db.root_mut().add_entry().id(),
    };
    {
        let mut entry = vault.db.entry_mut(id).ok_or_else(not_found)?;
        write_entry(&mut entry, item);
    }
    persist(home, owner, &vault)?;
    Ok(id.uuid().to_string())
}

fn local_delete(home: &Path, owner: &str, id: &str) -> Result<()> {
    let mut vault = load(home, owner)?.ok_or_else(not_found)?;
    let id = entry_id(id)?;
    vault.db.entry_mut(id).ok_or_else(not_found)?.remove();
    vault
        .db
        .deleted_objects
        .insert(id.uuid(), Some(keepass::db::Times::now()));
    persist(home, owner, &vault)
}

// ---- Either store ----

/// Where a user's items are: the vault on this daemon, or Vaultwarden once
/// they connect it.
enum Backend {
    Local,
    Vaultwarden(crate::vaultwarden::Account),
}

fn backend(home: &Path, owner: &str) -> Result<Backend> {
    Ok(match crate::vaultwarden::account(home, owner)? {
        Some(account) => Backend::Vaultwarden(account),
        None => Backend::Local,
    })
}

fn all(home: &Path, owner: &str) -> Result<Vec<(String, Record)>> {
    match backend(home, owner)? {
        Backend::Local => local_list(home, owner),
        Backend::Vaultwarden(account) => crate::vaultwarden::list(home, owner, &account),
    }
}

fn get(home: &Path, owner: &str, id: &str) -> Result<Record> {
    match backend(home, owner)? {
        Backend::Local => local_get(home, owner, id),
        Backend::Vaultwarden(account) => crate::vaultwarden::get(home, owner, &account, id),
    }
}

fn put(home: &Path, owner: &str, id: Option<&str>, item: &Record) -> Result<String> {
    match backend(home, owner)? {
        Backend::Local => local_put(home, owner, id, item),
        Backend::Vaultwarden(account) => crate::vaultwarden::put(home, owner, &account, id, item),
    }
}

/// Every item the user saved, or those a bot may use, sorted by title.
pub fn list(home: &Path, owner: &str, bot: Option<&str>) -> Result<Vec<Value>> {
    let _lock = lock();
    let mut rows = all(home, owner)?
        .iter()
        .filter(|(_, item)| match (bot, &item.bots) {
            (Some(bot), Some(bots)) => bots.iter().any(|b| b == bot),
            _ => true,
        })
        .map(|(id, item)| row(id, item))
        .collect::<Vec<_>>();
    rows.sort_by_key(|r| r["title"].as_str().unwrap_or("").to_lowercase());
    Ok(rows)
}

pub fn find(home: &Path, owner: &str, id: &str) -> Result<Value> {
    let _lock = lock();
    Ok(row(id, &get(home, owner, id)?))
}

/// Whether `bot` may use the item.
pub fn allowed(login: &Value, bot: &str) -> bool {
    login["bots"]
        .as_array()
        .is_none_or(|bots| bots.iter().any(|b| b == bot))
}

fn text<'a>(p: &'a Value, key: &str) -> Result<Option<&'a str>> {
    let max = if key == "private_key" {
        MAX_KEY
    } else {
        MAX_FIELD
    };
    match p.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) if s.len() <= max => Ok(Some(s)),
        Some(Value::String(_)) => Err(Error::new(4202, format!("{key} is too long"))),
        Some(_) => Err(Error::new(4202, format!("{key} must be text"))),
    }
}

/// An SSH private key as saved: the key as given, its public key, and
/// whether it has a passphrase. Only the OpenSSH format, which ssh-keygen
/// has written by default since 2018, is read.
fn ssh_key(text: &str, passphrase: &str) -> Result<(String, String, bool)> {
    let text = text.trim();
    if text.starts_with("ssh-") || text.starts_with("ecdsa-") || text.starts_with("sk-") {
        return Err(Error::new(
            4202,
            "That's a public key. Paste the private key, which starts with -----BEGIN OPENSSH PRIVATE KEY-----.",
        ));
    }
    if text.starts_with("-----BEGIN") && !text.starts_with("-----BEGIN OPENSSH PRIVATE KEY-----") {
        return Err(Error::new(
            4202,
            "Hexbot reads SSH keys in the OpenSSH format. Convert this one with ssh-keygen -p -f <key file>, then paste it again.",
        ));
    }
    let key = ssh_key::PrivateKey::from_openssh(text).map_err(|_| {
        Error::new(
            4202,
            "That isn't an SSH private key. It starts with -----BEGIN OPENSSH PRIVATE KEY-----.",
        )
    })?;
    let encrypted = key.is_encrypted();
    // A locked key keeps its comment inside, with the private half.
    let key = if encrypted {
        if passphrase.is_empty() {
            return Err(Error::new(4202, "This key has a passphrase. Enter it too."));
        }
        key.decrypt(passphrase)
            .map_err(|_| Error::new(4202, "That passphrase doesn't open this key."))?
    } else {
        key
    };
    let public = key
        .public_key()
        .to_openssh()
        .map_err(|_| Error::new(4202, "Hexbot can't read this key's public half."))?;
    Ok((format!("{text}\n"), public, encrypted))
}

/// A new Ed25519 key, the kind GitHub and OpenSSH recommend, named `comment`.
fn new_ssh_key(comment: &str) -> Result<String> {
    let mut key = ssh_key::PrivateKey::random(&mut rand::rngs::OsRng, ssh_key::Algorithm::Ed25519)
        .map_err(|e| Error::new(5300, format!("Hexbot can't make an SSH key: {e}")))?;
    key.set_comment(comment);
    Ok(key
        .to_openssh(ssh_key::LineEnding::LF)
        .map_err(|e| Error::new(5300, format!("Hexbot can't make an SSH key: {e}")))?
        .to_string())
}

/// An environment variable name a command can read.
pub fn variable(name: &str) -> Result<String> {
    let name = name.trim();
    let mut chars = name.chars();
    let valid = chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
        && name.len() <= 128;
    if !valid {
        return Err(Error::new(
            4202,
            "The variable name takes letters, digits and _, such as OPENAI_API_KEY.",
        ));
    }
    if RESERVED_VARIABLES.contains(&name) {
        return Err(Error::new(
            4202,
            format!("{name} is used by the shell. Choose another name."),
        ));
    }
    Ok(name.to_owned())
}

/// The variable a key goes in when none is given: OpenAI makes
/// OPENAI_API_KEY, GitHub token makes GITHUB_TOKEN.
pub fn default_variable(title: &str) -> String {
    let mut name = String::new();
    for c in title.chars() {
        if c.is_ascii_alphanumeric() {
            name.push(c.to_ascii_uppercase());
        } else if !name.is_empty() && !name.ends_with('_') {
            name.push('_');
        }
    }
    let mut name = name.trim_end_matches('_').to_owned();
    if name.is_empty() {
        return "API_KEY".into();
    }
    if name.starts_with(|c: char| c.is_ascii_digit()) {
        name.insert(0, '_');
    }
    if !["KEY", "TOKEN", "SECRET"]
        .iter()
        .any(|end| name.ends_with(end))
    {
        name.push_str("_API_KEY");
    }
    name
}

/// `bots`: absent leaves it, null means every bot, a list names them.
fn bots_param(home: &Path, owner: &str, p: &Value) -> Result<Option<Option<Vec<String>>>> {
    match p.get("bots") {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(None)),
        Some(Value::Array(items)) => {
            let mut bots = vec![];
            for item in items {
                let bot = item
                    .as_str()
                    .ok_or_else(|| Error::new(4202, "bots must be bot names"))?;
                common::bot_owner(home, owner, bot)?;
                if !bots.iter().any(|b| b == bot) {
                    bots.push(bot.to_owned());
                }
            }
            Ok(Some(Some(bots)))
        }
        Some(_) => Err(Error::new(4202, "bots must be a list or null")),
    }
}

/// A one-time code key: an `otpauth://` URI or a bare base32 secret.
pub(crate) fn otp_uri(code: &str, title: &str) -> Result<String> {
    let invalid = || Error::new(4202, "That one-time code key isn't valid.");
    let code = code.trim();
    let mut uri = if code.starts_with("otpauth://") {
        url::Url::parse(code).map_err(|_| invalid())?
    } else {
        let mut uri = url::Url::parse("otpauth://totp/").map_err(|_| invalid())?;
        uri.set_path(title);
        uri.query_pairs_mut().append_pair("secret", code);
        uri
    };
    // Authenticator apps assume six digits and unpadded, spaced base32;
    // the KeePass reader assumes neither.
    let mut pairs = uri
        .query_pairs()
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect::<Vec<_>>();
    for (key, value) in &mut pairs {
        if key == "secret" {
            let mut secret = value.replace([' ', '-', '='], "").to_uppercase();
            while secret.len() % 8 != 0 {
                secret.push('=');
            }
            *value = secret;
        }
    }
    if !pairs.iter().any(|(k, _)| k == "digits") {
        pairs.push(("digits".into(), "6".into()));
    }
    uri.query_pairs_mut().clear().extend_pairs(&pairs);
    let uri = uri.to_string();
    uri.parse::<keepass::db::TOTP>().map_err(|_| invalid())?;
    Ok(uri)
}

/// Applies a save's fields to an item, or to a new one when there is none.
/// Fields left out stay; an empty `code` removes a login's one-time code
/// key. `kind` (login when left out) is fixed when the item is made. A login
/// takes `password` and `code`; an SSH key `private_key` and `passphrase`,
/// or `generate: true` for a new key; an API key `key` and `env`.
fn apply(home: &Path, owner: &str, existing: Option<Record>, p: &Value) -> Result<Record> {
    let bots = bots_param(home, owner, p)?;
    let url = text(p, "url")?.map(str::trim);
    if let Some(url) = url
        && !url.is_empty()
        && host(url).is_none()
    {
        return Err(Error::new(
            4202,
            "The site must be an http or https address.",
        ));
    }
    let asked = text(p, "kind")?.map(Kind::parse).transpose()?;
    let title = text(p, "title")?.map(str::trim);
    let named = |title: Option<&str>| title.is_some_and(|t| !t.is_empty());
    let mut item = match existing {
        Some(item) => {
            if asked.is_some_and(|asked| asked != item.kind) {
                return Err(Error::new(4202, "An item keeps its kind."));
            }
            item
        }
        None => {
            let kind = asked.unwrap_or(Kind::Login);
            match kind {
                Kind::Login => {
                    if url.is_none_or(str::is_empty) && !named(title) {
                        return Err(Error::new(4202, "A password needs a site or a name."));
                    }
                    if text(p, "password")?.is_none_or(str::is_empty) {
                        return Err(Error::new(4202, "Enter the password."));
                    }
                }
                Kind::SshKey => {
                    if !named(title) {
                        return Err(Error::new(4202, "Give the SSH key a name."));
                    }
                    if p["generate"] != true && text(p, "private_key")?.is_none_or(str::is_empty) {
                        return Err(Error::new(4202, "Paste the private key."));
                    }
                }
                Kind::ApiKey => {
                    if !named(title) {
                        return Err(Error::new(4202, "Give the API key a name."));
                    }
                    if text(p, "key")?.is_none_or(|k| k.trim().is_empty()) {
                        return Err(Error::new(4202, "Enter the key."));
                    }
                }
            }
            Record::new(kind)
        }
    };
    let kind = item.kind;
    if let Some(title) = title {
        item.title = title.to_owned();
    }
    if let Some(url) = url {
        item.url = url.to_owned();
    }
    if let Some(username) = text(p, "username")? {
        item.username = username.to_owned();
    }
    if let Some(notes) = text(p, "notes")? {
        item.notes = notes.to_owned();
    }
    match text(p, "code")? {
        Some(code) if !code.trim().is_empty() => {
            if kind != Kind::Login {
                return Err(Error::new(4202, "Only logins have a one-time code."));
            }
            let name = Some(item.title.clone())
                .filter(|t| !t.is_empty())
                .or_else(|| host(&item.url))
                .unwrap_or_else(|| "Hexbot".into());
            item.otp = otp_uri(code, &name)?;
        }
        Some(_) => item.otp.clear(),
        None => {}
    }
    match kind {
        Kind::Login => {
            if let Some(password) = text(p, "password")?.filter(|p| !p.is_empty()) {
                item.password = password.to_owned();
            }
        }
        Kind::SshKey => {
            // The key pasted, or a new one, with its public key.
            let pasted = text(p, "private_key")?.filter(|k| !k.trim().is_empty());
            let given = match pasted {
                Some(private) => Some((private.to_owned(), text(p, "passphrase")?.unwrap_or(""))),
                None if p["generate"] == true => {
                    let comment = Some(item.title.as_str()).filter(|t| !t.is_empty());
                    Some((new_ssh_key(comment.unwrap_or("Hexbot"))?, ""))
                }
                None => None,
            };
            if let Some((private, passphrase)) = given {
                let (private, public, encrypted) = ssh_key(&private, passphrase)?;
                item.private_key = private;
                item.public_key = public;
                item.password = if encrypted {
                    passphrase.to_owned()
                } else {
                    String::new()
                };
            }
        }
        Kind::ApiKey => {
            if let Some(key) = text(p, "key")?.map(str::trim).filter(|k| !k.is_empty()) {
                item.password = key.to_owned();
            }
            match text(p, "env")?.filter(|e| !e.trim().is_empty()) {
                Some(env) => item.env = variable(env)?,
                None if item.env.is_empty() => item.env = default_variable(&item.title),
                None => {}
            }
        }
    }
    if let Some(bots) = bots {
        item.bots = bots;
    }
    item.updated_at = Some(chrono::Utc::now().timestamp());
    Ok(item)
}

/// Creates an item (no `id`) or changes one (`apply`). New items go to every
/// bot unless `bots` says otherwise.
pub fn save(home: &Path, owner: &str, p: &Value) -> Result<Value> {
    let _lock = lock();
    let id = text(p, "id")?;
    let existing = id.map(|id| get(home, owner, id)).transpose()?;
    let item = apply(home, owner, existing, p)?;
    let id = put(home, owner, id, &item)?;
    Ok(row(&id, &item))
}

pub fn delete(home: &Path, owner: &str, id: &str) -> Result<()> {
    let _lock = lock();
    match backend(home, owner)? {
        Backend::Local => local_delete(home, owner, id),
        Backend::Vaultwarden(account) => crate::vaultwarden::delete(home, owner, &account, id),
    }
}

/// A deleted bot leaves every item's list in every user's store, so a later
/// bot with its name gets nothing it was not given. Bot deletion keeps the
/// name reserved until this succeeds; a locked vault or an unreachable
/// Vaultwarden fails it.
pub fn forget_bot(home: &Path, bot: &str) -> Result<()> {
    let users = match std::fs::read_dir(home.join("users")) {
        Ok(users) => users,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.into()),
    };
    for user in users {
        if let Some(owner) = user?.file_name().to_str() {
            forget_in(home, owner, bot)?;
        }
    }
    Ok(())
}
fn forget_in(home: &Path, owner: &str, bot: &str) -> Result<()> {
    let _lock = lock();
    // The vault on the daemon, recycle bin included, which comes back if
    // Vaultwarden is disconnected: read and saved once.
    if let Some(mut vault) = load(home, owner)? {
        let mut changed = false;
        vault.db.foreach_entry_mut(|mut entry| {
            if let Some(bots) = bots_of(&entry)
                && bots.iter().any(|b| b == bot)
            {
                let kept = bots.into_iter().filter(|b| b != bot).collect::<Vec<_>>();
                set_custom(&mut entry, BOTS, Some(json!(kept).to_string()));
                changed = true;
            }
        });
        if changed {
            persist(home, owner, &vault)?;
        }
    }
    if let Backend::Vaultwarden(account) = backend(home, owner)? {
        for (id, item) in without(crate::vaultwarden::list(home, owner, &account)?, bot) {
            crate::vaultwarden::put(home, owner, &account, Some(&id), &item)?;
        }
        crate::vaultwarden::forget_in_trash(home, owner, &account, bot)?;
    }
    Ok(())
}

/// The items that name `bot`, with it taken off their lists.
pub(crate) fn without(items: Vec<(String, Record)>, bot: &str) -> Vec<(String, Record)> {
    items
        .into_iter()
        .filter_map(|(id, mut item)| {
            let bots = item.bots.as_ref()?;
            if !bots.iter().any(|b| b == bot) {
                return None;
            }
            item.bots = Some(bots.iter().filter(|b| *b != bot).cloned().collect());
            Some((id, item))
        })
        .collect()
}

/// The private key in the OpenSSH format, its passphrase taken off, for an
/// agent to hold.
fn ssh_private(item: &Record) -> Result<Option<String>> {
    if item.private_key.is_empty() {
        return Ok(None);
    }
    let broken = || Error::new(5300, "Hexbot can't read this SSH key. Save it again.");
    let key = ssh_key::PrivateKey::from_openssh(&item.private_key).map_err(|_| broken())?;
    let key = if key.is_encrypted() {
        key.decrypt(&item.password).map_err(|_| broken())?
    } else {
        key
    };
    Ok(Some(
        key.to_openssh(ssh_key::LineEnding::LF)
            .map_err(|_| broken())?
            .to_string(),
    ))
}

/// The one-time code for now and how long it lasts, from a login's key.
fn code_now(item: &Record) -> Result<Option<(String, u64)>> {
    if item.otp.is_empty() {
        return Ok(None);
    }
    // Vaultwarden keeps a key as an app saved it, such as a bare base32
    // secret; a Steam key gives no code here.
    let Some(otp) = otp_uri(&item.otp, &item.title)
        .ok()
        .and_then(|uri| uri.parse::<keepass::db::TOTP>().ok())
    else {
        return Ok(None);
    };
    let code = otp
        .value_now()
        .map_err(|_| Error::new(5300, "The clock is wrong."))?;
    Ok(Some((code.code, code.valid_for.as_secs())))
}

/// A secret for the daemon to use: a login's `username`, `password`, or
/// `code`, the one-time code for now; an API key's `key`; an SSH key's
/// `private_key`, without its passphrase.
pub fn secret(home: &Path, owner: &str, id: &str, field: &str) -> Result<String> {
    let _lock = lock();
    let item = get(home, owner, id)?;
    let kind = item.kind;
    let value = match (kind, field) {
        (Kind::Login, "username") => Some(item.username.clone()),
        (Kind::Login, "password") | (Kind::ApiKey, "key") => Some(item.password.clone()),
        (Kind::Login, "code") => code_now(&item)?.map(|(code, _)| code),
        (Kind::SshKey, "private_key") => ssh_private(&item)?,
        (Kind::Login, other) => {
            return Err(Error::new(
                4202,
                format!("unknown field: {other}. Use username, password or code."),
            ));
        }
        (kind, other) => {
            return Err(Error::new(
                4202,
                format!(
                    "An {} has no {other}. Only logins are typed into pages; use run for SSH and API keys.",
                    kind.words()
                ),
            ));
        }
    };
    value.filter(|v| !v.is_empty()).ok_or_else(|| {
        Error::new(
            4204,
            format!(
                "This {} has no saved {field}. Ask the user to add it.",
                kind.words()
            ),
        )
    })
}

/// Everything about one item, for its owner in Settings: a login's password
/// and one-time code, an API key's key, an SSH key's private key and
/// passphrase.
fn reveal(home: &Path, owner: &str, id: &str) -> Result<Value> {
    let _lock = lock();
    let item = get(home, owner, id)?;
    let login = row(id, &item);
    Ok(match item.kind {
        Kind::Login => {
            let code = code_now(&item)
                .ok()
                .flatten()
                .map(|(code, valid_for)| json!({"code": code, "valid_for": valid_for}));
            json!({"login": login, "password": item.password, "code": code})
        }
        Kind::ApiKey => json!({"login": login, "key": item.password}),
        Kind::SshKey => json!({
            "login": login,
            "private_key": item.private_key,
            "passphrase": item.password,
        }),
    })
}

/// Where the key that opens the user's items is kept, for Settings:
/// keychain, secret_service, file, locked, or null before the first item.
/// With Vaultwarden, that is its master password.
fn store(home: &Path, owner: &str) -> Result<Value> {
    if let Backend::Vaultwarden(_) = backend(home, owner)? {
        return Ok(match kept(home, owner, crate::vaultwarden::SECRET) {
            Ok(Some((_, store))) => json!(store.name()),
            _ => json!("locked"),
        });
    }
    if !vault_path(home, owner)?.exists() {
        return Ok(Value::Null);
    }
    Ok(match key(home, owner, false) {
        Ok(Some((_, store))) => json!(store.name()),
        _ => json!("locked"),
    })
}

/// Every item in the vault on this daemon, for Vaultwarden's connect to copy.
pub(crate) fn local_items(home: &Path, owner: &str) -> Result<Vec<(String, Record)>> {
    local_list(home, owner)
}

pub const CHANGES: &[&str] = &[
    "hexbot.passwords.save",
    "hexbot.passwords.delete",
    "hexbot.passwords.set_bots",
    "hexbot.passwords.connect",
    "hexbot.passwords.disconnect",
];

pub fn call(home: &Path, owner: &str, method: &str, p: &Value) -> Option<Result<Value>> {
    if !method.starts_with("hexbot.passwords.") {
        return None;
    }
    Some((|| {
        common::user(home, owner)?;
        match method {
            "hexbot.passwords.list" => {
                let bots = common::rows(
                    &db::open(home)?,
                    "SELECT name FROM bots WHERE owner_id=? ORDER BY name",
                    &[&owner],
                )?
                .into_iter()
                .filter_map(|r| r["name"].as_str().map(str::to_owned))
                .collect::<Vec<_>>();
                // Settings names a Vaultwarden it can't reach, so it can be disconnected.
                let vault = crate::vaultwarden::status(home, owner)?;
                let (logins, error) = match list(home, owner, None) {
                    Ok(logins) => (logins, None),
                    Err(error) if vault["kind"] == "vaultwarden" => (vec![], Some(error.message)),
                    Err(error) => return Err(error),
                };
                Ok(json!({
                    "logins": logins,
                    "bots": bots,
                    "store": store(home, owner)?,
                    "vault": vault,
                    "error": error,
                }))
            }
            // Where the items are, without reading them or waiting on the
            // lock: a Vaultwarden that doesn't answer still shows, so it can
            // be disconnected. `local` counts the items saved on the daemon.
            "hexbot.passwords.vault" => {
                let vault = crate::vaultwarden::status(home, owner)?;
                // The count is for copying in at connect; once connected, the
                // daemon's vault isn't opened at all.
                let local = if vault["kind"] == "local" {
                    local_list(home, owner)?.len()
                } else {
                    0
                };
                Ok(json!({"vault": vault, "local": local}))
            }
            "hexbot.passwords.save" => Ok(json!({"login": save(home, owner, p)?})),
            "hexbot.passwords.set_bots" => {
                let id = common::required(p, "id")?;
                if p.get("bots").is_none() {
                    return Err(Error::new(4200, "missing parameter: bots"));
                }
                Ok(json!({"login": save(home, owner, &json!({"id":id,"bots":p["bots"]}))?}))
            }
            "hexbot.passwords.delete" => {
                let id = common::required(p, "id")?;
                delete(home, owner, id)?;
                Ok(json!({"deleted": id}))
            }
            "hexbot.passwords.reveal" => reveal(home, owner, common::required(p, "id")?),
            "hexbot.passwords.connect" => {
                let _lock = lock();
                crate::vaultwarden::connect(home, owner, p)
            }
            "hexbot.passwords.disconnect" => {
                let _lock = lock();
                crate::vaultwarden::disconnect(home, owner)?;
                Ok(json!({"vault": crate::vaultwarden::status(home, owner)?}))
            }
            _ => Err(Error::new(-32601, format!("unknown method: {method}"))),
        }
    })())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    fn home() -> tempfile::TempDir {
        let home = tempfile::tempdir().unwrap();
        crate::db::migrate(home.path()).unwrap();
        crate::db::open(home.path())
            .unwrap()
            .execute_batch(
                "INSERT INTO users(id,display_name,role,created_at) VALUES('alice','Alice','admin',0);
                 INSERT INTO bots(name,owner_id) VALUES('owl','alice'),('fox','alice');",
            )
            .unwrap();
        home
    }

    #[test]
    fn saved_logins_list_without_secrets_and_open_in_keepass() {
        let home = home();
        let h = home.path();
        assert!(list(h, "alice", None).unwrap().is_empty());
        let login = save(
            h,
            "alice",
            &json!({"title":"Schoology","url":"https://app.schoology.com/login","username":"alex","password":"hunter2"}),
        )
        .unwrap();
        assert_eq!(login["site"], "app.schoology.com");
        assert_eq!(login["bots"], Value::Null);
        assert!(!login.to_string().contains("hunter2"));
        let id = login["id"].as_str().unwrap();
        assert_eq!(secret(h, "alice", id, "password").unwrap(), "hunter2");
        assert_eq!(secret(h, "alice", id, "username").unwrap(), "alex");
        assert_eq!(
            secret(h, "alice", id, "code").unwrap_err().code,
            4204,
            "no one-time code key yet"
        );
        // The file is a KeePass vault its key file opens.
        let key = std::fs::read_to_string(key_path(h, "alice").unwrap()).unwrap();
        let bytes = std::fs::read(vault_path(h, "alice").unwrap()).unwrap();
        assert!(!String::from_utf8_lossy(&bytes).contains("hunter2"));
        let db = Database::parse(&bytes, DatabaseKey::new().with_password(&key)).unwrap();
        assert_eq!(db.iter_all_entries().count(), 1);
        assert!(Database::parse(&bytes, DatabaseKey::new().with_password("wrong")).is_err());
        // Bots' shells and file tools can read neither file.
        for path in [
            key_path(h, "alice").unwrap(),
            vault_path(h, "alice").unwrap(),
        ] {
            assert!(crate::credentials::credential_name(h, &path));
        }
        assert!(!crate::credentials::credential_name(
            h,
            &h.join("users/alice/user.md")
        ));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            for path in [
                key_path(h, "alice").unwrap(),
                vault_path(h, "alice").unwrap(),
            ] {
                let mode = std::fs::metadata(path).unwrap().permissions().mode();
                assert_eq!(mode & 0o077, 0, "only the owner reads it");
            }
        }
    }

    #[test]
    fn bots_see_what_they_are_given_and_a_deleted_bot_leaves() {
        let home = home();
        let h = home.path();
        let login = save(
            h,
            "alice",
            &json!({"url":"https://example.com","password":"pw"}),
        )
        .unwrap();
        let id = login["id"].as_str().unwrap();
        assert_eq!(login["title"], "example.com");
        assert_eq!(list(h, "alice", Some("fox")).unwrap().len(), 1);
        let only = save(h, "alice", &json!({"id":id,"bots":["owl"]})).unwrap();
        assert_eq!(only["bots"], json!(["owl"]));
        assert!(list(h, "alice", Some("fox")).unwrap().is_empty());
        assert!(allowed(&only, "owl") && !allowed(&only, "fox"));
        assert_eq!(
            save(h, "alice", &json!({"id":id,"bots":["stranger"]}))
                .unwrap_err()
                .code,
            4205
        );
        forget_bot(h, "owl").unwrap();
        assert_eq!(find(h, "alice", id).unwrap()["bots"], json!([]));
        save(h, "alice", &json!({"id":id,"bots":null})).unwrap();
        assert_eq!(list(h, "alice", Some("fox")).unwrap().len(), 1);
        // Changing other fields keeps the password.
        save(
            h,
            "alice",
            &json!({"id":id,"username":"me","title":"Example"}),
        )
        .unwrap();
        assert_eq!(secret(h, "alice", id, "password").unwrap(), "pw");
        delete(h, "alice", id).unwrap();
        assert!(list(h, "alice", None).unwrap().is_empty());
        assert_eq!(find(h, "alice", id).unwrap_err().code, 4204);
    }

    #[test]
    fn one_time_codes_come_from_their_key() {
        let home = home();
        let h = home.path();
        let login = save(
            h,
            "alice",
            &json!({"url":"https://example.com","password":"pw","code":"JBSW Y3DP EHPK 3PXP"}),
        )
        .unwrap();
        assert_eq!(login["has_code"], true);
        let code = secret(h, "alice", login["id"].as_str().unwrap(), "code").unwrap();
        assert_eq!(code.len(), 6);
        // RFC 6238's example key gives its known code at a known time.
        let uri = otp_uri("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", "x").unwrap();
        let totp = uri.parse::<keepass::db::TOTP>().unwrap();
        assert_eq!(totp.value_at(59).code, "287082");
        let google = otp_uri(
            "otpauth://totp/G:me?secret=jbsw y3dp ehpk 3pxp a&issuer=G",
            "x",
        )
        .unwrap();
        assert!(google.contains("digits=6") && google.contains("issuer=G"));
        assert!(code.chars().all(|c| c.is_ascii_digit()));
        assert_eq!(
            save(
                h,
                "alice",
                &json!({"url":"https://x.com","password":"p","code":"not base32!"})
            )
            .unwrap_err()
            .code,
            4202
        );
        let cleared = save(h, "alice", &json!({"id":login["id"],"code":""})).unwrap();
        assert_eq!(cleared["has_code"], false);
    }

    #[test]
    fn new_logins_need_a_password_and_a_real_site() {
        let home = home();
        let h = home.path();
        assert_eq!(
            save(h, "alice", &json!({"url":"https://x.com"}))
                .unwrap_err()
                .code,
            4202
        );
        assert_eq!(
            save(
                h,
                "alice",
                &json!({"url":"javascript:alert(1)","password":"p"})
            )
            .unwrap_err()
            .code,
            4202
        );
        assert_eq!(
            save(h, "alice", &json!({"password":"p"})).unwrap_err().code,
            4202
        );
    }

    #[test]
    fn a_vault_without_its_key_stays_locked() {
        let home = home();
        let h = home.path();
        save(h, "alice", &json!({"url":"https://x.com","password":"p"})).unwrap();
        std::fs::remove_file(key_path(h, "alice").unwrap()).unwrap();
        assert_eq!(list(h, "alice", None).unwrap_err().code, 5300);
        // Deleting a bot must wait for it, keeping the bot's name reserved.
        assert_eq!(forget_bot(h, "owl").unwrap_err().code, 5300);
        // Saving must not replace the vault with a new key.
        assert_eq!(
            save(h, "alice", &json!({"url":"https://y.com","password":"p"}))
                .unwrap_err()
                .code,
            5300
        );
    }

    /// `ssh-keygen -t ed25519 -N 'correct horse' -C fixture`.
    pub(crate) const LOCKED_KEY: &str = "-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAACmFlczI1Ni1jdHIAAAAGYmNyeXB0AAAAGAAAABDQv9xYPp
5H9ENVN9QrXI0YAAAAGAAAAAEAAAAzAAAAC3NzaC1lZDI1NTE5AAAAIGou53ZeHy9mJCrn
DtuPRCQ2bn3hsmoiLLXj38gV9k58AAAAkFn7NOmk9zaPmylcxbMqQdaa2ebLjLcPNoKQaJ
YyYw1ReYKibAoyHh/u6PbLYIWRzJ8zh2QUuq7YN0SaSidrKdAXsgqiVm/q5s1uwTKhev/C
kh3xBceQ3HasQwrcl7I0XRTQzIegdNkHQZBEO6EeS0dA4C7yN8FJ0lUdvR0LAwF3unqOxu
RRt6ydivhAlY3kFw==
-----END OPENSSH PRIVATE KEY-----
";

    #[test]
    fn ssh_keys_keep_their_private_half_and_show_the_public_one() {
        let home = home();
        let h = home.path();
        let err = |p: Value| save(h, "alice", &p).unwrap_err().message;
        assert!(
            err(json!({"kind":"ssh_key","title":"GitHub","private_key":LOCKED_KEY}))
                .contains("passphrase")
        );
        assert!(err(json!({"kind":"ssh_key","title":"GitHub","private_key":LOCKED_KEY,"passphrase":"wrong"})).contains("doesn't open"));
        assert!(err(json!({"kind":"ssh_key","title":"GitHub","private_key":"-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----"})).contains("ssh-keygen -p"));
        assert!(
            err(json!({"kind":"ssh_key","title":"GitHub","private_key":"ssh-ed25519 AAAA me"}))
                .contains("public key")
        );
        assert!(err(json!({"kind":"ssh_key","private_key":LOCKED_KEY})).contains("name"));
        let key = save(
            h,
            "alice",
            &json!({"kind":"ssh_key","title":"GitHub","private_key":LOCKED_KEY,"passphrase":"correct horse"}),
        )
        .unwrap();
        assert_eq!(key["kind"], "ssh_key");
        assert_eq!(key["has_passphrase"], true);
        assert_eq!(
            key["fingerprint"],
            "SHA256:GPeuPte1++Gywv986aVurpkbhakdHkMnkVHx0lvvGDY"
        );
        assert!(
            key["public_key"]
                .as_str()
                .unwrap()
                .starts_with("ssh-ed25519 AAAA")
        );
        assert!(!key.to_string().contains("b3BlbnNzaC1rZXkt"));
        let id = key["id"].as_str().unwrap();
        // The agent gets it without its passphrase, and it is still the same key.
        let open = secret(h, "alice", id, "private_key").unwrap();
        let parsed = ssh_key::PrivateKey::from_openssh(&open).unwrap();
        assert!(!parsed.is_encrypted());
        assert_eq!(
            parsed.public_key().to_openssh().unwrap(),
            key["public_key"].as_str().unwrap()
        );
        // Only logins are typed into pages.
        assert_eq!(secret(h, "alice", id, "password").unwrap_err().code, 4202);
        let shown = reveal(h, "alice", id).unwrap();
        assert_eq!(shown["private_key"], LOCKED_KEY);
        assert_eq!(shown["passphrase"], "correct horse");
        // Renaming keeps the key; a kind never changes.
        let renamed = save(h, "alice", &json!({"id":id,"title":"Work GitHub"})).unwrap();
        assert_eq!(renamed["fingerprint"], key["fingerprint"]);
        assert!(err(json!({"id":id,"kind":"login"})).contains("kind"));
        assert!(err(json!({"id":id,"code":"JBSWY3DPEHPK3PXP"})).contains("one-time"));
        // KeePass apps see the fields by name.
        let k = std::fs::read_to_string(key_path(h, "alice").unwrap()).unwrap();
        let bytes = std::fs::read(vault_path(h, "alice").unwrap()).unwrap();
        let db = Database::parse(&bytes, DatabaseKey::new().with_password(&k)).unwrap();
        let entry = db.iter_all_entries().next().unwrap();
        assert_eq!(entry.get(PRIVATE_KEY), Some(LOCKED_KEY));
        assert_eq!(entry.get_password(), Some("correct horse"));
    }

    #[test]
    fn new_ssh_keys_are_ed25519_and_never_leave_the_vault() {
        let home = home();
        let h = home.path();
        let key = save(
            h,
            "alice",
            &json!({"kind":"ssh_key","title":"Deploy","generate":true,"bots":["owl"]}),
        )
        .unwrap();
        let public = key["public_key"].as_str().unwrap();
        assert!(
            public.starts_with("ssh-ed25519 ") && public.ends_with(" Deploy"),
            "{public}"
        );
        assert_eq!(key["has_passphrase"], false);
        assert_eq!(key["bots"], json!(["owl"]));
        let other = save(
            h,
            "alice",
            &json!({"kind":"ssh_key","title":"Deploy","generate":true}),
        )
        .unwrap();
        assert_ne!(other["public_key"], key["public_key"], "every key is new");
        assert!(
            secret(h, "alice", key["id"].as_str().unwrap(), "private_key")
                .unwrap()
                .starts_with("-----BEGIN OPENSSH PRIVATE KEY-----")
        );
    }

    #[test]
    fn api_keys_name_the_variable_they_go_in() {
        let home = home();
        let h = home.path();
        let err = |p: Value| save(h, "alice", &p).unwrap_err().message;
        assert!(err(json!({"kind":"api_key","title":"OpenAI"})).contains("key"));
        assert!(err(json!({"kind":"api_key","key":"sk-1"})).contains("name"));
        assert!(
            err(json!({"kind":"api_key","title":"x","key":"sk-1","env":"1BAD"}))
                .contains("letters")
        );
        assert!(
            err(json!({"kind":"api_key","title":"x","key":"sk-1","env":"PATH"})).contains("shell")
        );
        assert!(
            err(json!({"kind":"api_key","title":"x","key":"sk-1","env":"d"})).contains("shell")
        );
        assert!(
            err(json!({"kind":"api_key","title":"x","key":"sk-1","env":"hexbot_agent"}))
                .contains("shell")
        );
        let key = save(
            h,
            "alice",
            &json!({"kind":"api_key","title":"OpenAI","key":" sk-secret ","url":"https://platform.openai.com"}),
        )
        .unwrap();
        assert_eq!(key["kind"], "api_key");
        assert_eq!(key["env"], "OPENAI_API_KEY");
        assert_eq!(key["site"], "platform.openai.com");
        assert!(!key.to_string().contains("sk-secret"));
        let id = key["id"].as_str().unwrap();
        assert_eq!(secret(h, "alice", id, "key").unwrap(), "sk-secret");
        assert_eq!(reveal(h, "alice", id).unwrap()["key"], "sk-secret");
        let changed = save(h, "alice", &json!({"id":id,"env":"OPENAI_KEY"})).unwrap();
        assert_eq!(changed["env"], "OPENAI_KEY");
        assert_eq!(secret(h, "alice", id, "key").unwrap(), "sk-secret");
        for (title, env) in [
            ("GitHub token", "GITHUB_TOKEN"),
            ("Stripe secret", "STRIPE_SECRET"),
            ("ElevenLabs", "ELEVENLABS_API_KEY"),
            ("1Password", "_1PASSWORD_API_KEY"),
            ("!!", "API_KEY"),
        ] {
            assert_eq!(default_variable(title), env);
        }
        // Lists hold every kind, sorted by title.
        save(
            h,
            "alice",
            &json!({"url":"https://a.com","password":"p","title":"Amazon"}),
        )
        .unwrap();
        let kinds = list(h, "alice", None)
            .unwrap()
            .iter()
            .map(|i| i["kind"].as_str().unwrap().to_owned())
            .collect::<Vec<_>>();
        assert_eq!(kinds, ["login", "api_key"]);
    }

    #[test]
    fn logins_fill_only_on_their_own_site() {
        let saved = "https://app.schoology.com/login";
        assert!(same_site(saved, "https://app.schoology.com/home"));
        assert!(same_site(saved, "https://schoology.com/"));
        assert!(same_site(
            "https://www.example.com",
            "https://example.com/a"
        ));
        assert!(same_site(
            "https://example.com",
            "https://login.example.com/"
        ));
        assert!(!same_site(saved, "https://lms.schoology.com/"));
        assert!(!same_site(saved, "http://app.schoology.com/login"));
        assert!(!same_site(saved, "https://app.schoology.com.evil.io/"));
        assert!(!same_site(saved, "https://evilschoology.com/"));
        assert!(!same_site(saved, "data:text/html,hi"));
        assert!(same_site(
            "http://intranet.local",
            "http://intranet.local/x"
        ));
    }
}
