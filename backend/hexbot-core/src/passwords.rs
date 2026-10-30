//! Passwords: one KeePass (KDBX 4) vault per user,
//! `users/<id>/passwords/passwords.kdbx`. Its key is a random 256-bit secret
//! kept in the OS keychain (the macOS Keychain, or the Secret Service on
//! Linux), or, where there is none, in `users/<id>/passwords/passwords.key`,
//! readable by its owner only. Both, and the temporary files written on the
//! way, stay in that one folder, which bots' shells can't read. The key is the
//! vault's KeePass password, so KeePassXC and other KeePass apps open it too.
//!
//! Bots never read a password. They list logins (title, site, username),
//! ask the user for one through a sign-in card, and have the daemon type it
//! into a page (`runtime_passwords.rs`). Each login names the bots that may
//! use it in its custom data; no list means every bot.
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

/// Entry custom data: the bots that may use a login, as a JSON array.
const BOTS: &str = "hexbot.bots";
/// The keychain item's service name.
const SERVICE: &str = "hexbot-passwords";
const MAX_FIELD: usize = 4096;

/// Where a vault's key lives.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Store {
    Keychain,
    SecretService,
    File,
}
impl Store {
    fn name(self) -> &'static str {
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

fn dir(home: &Path, owner: &str) -> Result<PathBuf> {
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
    LOCK.get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner())
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

fn bots_of(entry: &keepass::db::Entry) -> Option<Vec<String>> {
    match entry.custom_data.get(BOTS)?.value.as_ref()? {
        CustomDataValue::String(text) => serde_json::from_str(text).ok(),
        CustomDataValue::Binary(_) => None,
    }
}

fn set_bots_of(entry: &mut keepass::db::Entry, bots: Option<&[String]>) {
    match bots {
        None => {
            entry.custom_data.remove(BOTS);
        }
        Some(bots) => {
            entry.custom_data.insert(
                BOTS.into(),
                CustomDataItem {
                    value: Some(CustomDataValue::String(json!(bots).to_string())),
                    last_modification_time: Some(keepass::db::Times::now()),
                },
            );
        }
    }
}

/// A login as clients and bots read it: never its password or code key.
fn row(entry: &keepass::db::Entry, id: EntryId) -> Value {
    let url = entry.get_url().unwrap_or("");
    let title = entry
        .get_title()
        .filter(|t| !t.is_empty())
        .map(str::to_owned)
        .or_else(|| host(url))
        .unwrap_or_else(|| "Login".into());
    json!({
        "id": id.uuid().to_string(),
        "title": title,
        "url": url,
        "site": host(url),
        "username": entry.get_username().unwrap_or(""),
        "bots": bots_of(entry),
        "has_password": entry.get_password().is_some_and(|p| !p.is_empty()),
        "has_code": entry.get_raw_otp_value().is_some_and(|v| !v.is_empty()),
        "notes": entry.get(fields::NOTES).unwrap_or(""),
        "updated_at": entry.times.last_modification.map(|t| t.and_utc().timestamp()),
    })
}

/// Logins outside the recycle bin, sorted by title.
fn rows(db: &Database, bot: Option<&str>) -> Vec<Value> {
    let bin = db.recycle_bin().map(|g| g.id());
    let mut rows = db
        .iter_all_entries()
        .filter(|e| bin.is_none_or(|bin| e.parent().id() != bin))
        .filter(|e| match (bot, bots_of(e)) {
            (Some(bot), Some(bots)) => bots.iter().any(|b| b == bot),
            _ => true,
        })
        .map(|e| row(&e, e.id()))
        .collect::<Vec<_>>();
    rows.sort_by_key(|r| r["title"].as_str().unwrap_or("").to_lowercase());
    rows
}

/// Every login the user saved, or those a bot may use.
pub fn list(home: &Path, owner: &str, bot: Option<&str>) -> Result<Vec<Value>> {
    let _lock = lock();
    Ok(load(home, owner)?
        .map(|vault| rows(&vault.db, bot))
        .unwrap_or_default())
}

pub fn find(home: &Path, owner: &str, id: &str) -> Result<Value> {
    let _lock = lock();
    let vault = load(home, owner)?.ok_or_else(not_found)?;
    let id = entry_id(id)?;
    let entry = vault.db.entry(id).ok_or_else(not_found)?;
    Ok(row(&entry, id))
}

/// Whether `bot` may use the login.
pub fn allowed(login: &Value, bot: &str) -> bool {
    login["bots"]
        .as_array()
        .is_none_or(|bots| bots.iter().any(|b| b == bot))
}

fn text<'a>(p: &'a Value, key: &str) -> Result<Option<&'a str>> {
    match p.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) if s.len() <= MAX_FIELD => Ok(Some(s)),
        Some(Value::String(_)) => Err(Error::new(4202, format!("{key} is too long"))),
        Some(_) => Err(Error::new(4202, format!("{key} must be text"))),
    }
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
fn otp_uri(code: &str, title: &str) -> Result<String> {
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

/// Creates a login (no `id`) or changes one. Fields left out stay; an empty
/// `code` removes the one-time code key. New logins go to every bot unless
/// `bots` says otherwise.
pub fn save(home: &Path, owner: &str, p: &Value) -> Result<Value> {
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
    let _lock = lock();
    let mut vault = load_or_new(home, owner)?;
    let id = match text(p, "id")? {
        Some(id) => {
            let id = entry_id(id)?;
            vault.db.entry(id).ok_or_else(not_found)?;
            id
        }
        None => {
            if url.is_none_or(str::is_empty)
                && text(p, "title")?.is_none_or(|t| t.trim().is_empty())
            {
                return Err(Error::new(4202, "A password needs a site or a name."));
            }
            if text(p, "password")?.is_none_or(str::is_empty) {
                return Err(Error::new(4202, "Enter the password."));
            }
            vault.db.root_mut().add_entry().id()
        }
    };
    let title = text(p, "title")?.map(str::trim);
    let code = match text(p, "code")? {
        Some(code) if !code.trim().is_empty() => {
            let name = title
                .filter(|t| !t.is_empty())
                .map(str::to_owned)
                .or_else(|| url.and_then(host))
                .unwrap_or_else(|| "Hexbot".into());
            Some(Some(otp_uri(code, &name)?))
        }
        Some(_) => Some(None),
        None => None,
    };
    let mut entry = vault.db.entry_mut(id).ok_or_else(not_found)?;
    if let Some(title) = title {
        entry.set_unprotected(fields::TITLE, title);
    }
    if let Some(url) = url {
        entry.set_unprotected(fields::URL, url);
    }
    if let Some(username) = text(p, "username")? {
        entry.set_unprotected(fields::USERNAME, username);
    }
    if let Some(password) = text(p, "password")?.filter(|p| !p.is_empty()) {
        entry.set_protected(fields::PASSWORD, password);
    }
    if let Some(notes) = text(p, "notes")? {
        entry.set_unprotected(fields::NOTES, notes);
    }
    match code {
        Some(Some(uri)) => entry.set_protected(fields::OTP, uri),
        Some(None) => {
            entry.fields.remove(fields::OTP);
        }
        None => {}
    }
    if let Some(bots) = &bots {
        set_bots_of(&mut entry, bots.as_deref());
    }
    let now = keepass::db::Times::now();
    entry.times.last_modification = Some(now);
    if entry.times.creation.is_none() {
        entry.times.creation = Some(now);
    }
    let login = row(&entry, id);
    persist(home, owner, &vault)?;
    Ok(login)
}

pub fn delete(home: &Path, owner: &str, id: &str) -> Result<()> {
    let _lock = lock();
    let mut vault = load(home, owner)?.ok_or_else(not_found)?;
    let id = entry_id(id)?;
    vault.db.entry_mut(id).ok_or_else(not_found)?.remove();
    vault
        .db
        .deleted_objects
        .insert(id.uuid(), Some(keepass::db::Times::now()));
    persist(home, owner, &vault)
}

/// A deleted bot leaves every login's list in every vault, so a later bot
/// with its name gets nothing it was not given. Bot deletion keeps the name
/// reserved until this succeeds; a locked vault fails it.
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
    let Some(mut vault) = load(home, owner)? else {
        return Ok(());
    };
    let mut changed = false;
    vault.db.foreach_entry_mut(|mut entry| {
        if let Some(bots) = bots_of(&entry)
            && bots.iter().any(|b| b == bot)
        {
            let kept = bots.into_iter().filter(|b| b != bot).collect::<Vec<_>>();
            set_bots_of(&mut entry, Some(&kept));
            changed = true;
        }
    });
    if changed {
        persist(home, owner, &vault)?;
    }
    Ok(())
}

/// A secret for the daemon to type: `username`, `password`, or `code`, the
/// one-time code for now.
pub fn secret(home: &Path, owner: &str, id: &str, field: &str) -> Result<String> {
    let _lock = lock();
    let vault = load(home, owner)?.ok_or_else(not_found)?;
    let entry = vault.db.entry(entry_id(id)?).ok_or_else(not_found)?;
    let value = match field {
        "username" => entry.get_username().map(str::to_owned),
        "password" => entry.get_password().map(str::to_owned),
        "code" => match entry.get_otp() {
            Ok(otp) => Some(
                otp.value_now()
                    .map_err(|_| Error::new(5300, "The clock is wrong."))?
                    .code,
            ),
            Err(_) => None,
        },
        other => {
            return Err(Error::new(
                4202,
                format!("unknown field: {other}. Use username, password or code."),
            ));
        }
    };
    value.filter(|v| !v.is_empty()).ok_or_else(|| {
        Error::new(
            4204,
            format!("This login has no saved {field}. Ask the user to add it."),
        )
    })
}

/// Everything about one login, for its owner in Settings.
fn reveal(home: &Path, owner: &str, id: &str) -> Result<Value> {
    let _lock = lock();
    let vault = load(home, owner)?.ok_or_else(not_found)?;
    let id = entry_id(id)?;
    let entry = vault.db.entry(id).ok_or_else(not_found)?;
    let code = entry
        .get_otp()
        .ok()
        .and_then(|otp| otp.value_now().ok())
        .map(|c| json!({"code":c.code,"valid_for":c.valid_for.as_secs()}));
    Ok(json!({
        "login": row(&entry, id),
        "password": entry.get_password().unwrap_or(""),
        "code": code,
    }))
}

/// Where the vault's key is kept, for Settings: keychain, secret_service,
/// file, or null before the first password.
fn store(home: &Path, owner: &str) -> Result<Value> {
    if !vault_path(home, owner)?.exists() {
        return Ok(Value::Null);
    }
    Ok(match key(home, owner, false) {
        Ok(Some((_, store))) => json!(store.name()),
        _ => json!("locked"),
    })
}

pub const CHANGES: &[&str] = &[
    "hexbot.passwords.save",
    "hexbot.passwords.delete",
    "hexbot.passwords.set_bots",
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
                Ok(json!({
                    "logins": list(home, owner, None)?,
                    "bots": bots,
                    "store": store(home, owner)?,
                }))
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
            _ => Err(Error::new(-32601, format!("unknown method: {method}"))),
        }
    })())
}

#[cfg(test)]
mod tests {
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
