//! User identity and revocable device credentials compatible with Hexbot storage.
use crate::{
    Error, Result,
    common::{self, admin, now, required, rows, user},
    db,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use rand::{Rng, RngCore};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, VecDeque},
    fs,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};

const DEVICE_COLUMNS: &str =
    "d.id,d.name,d.platform,d.owner_id,d.created_at,d.last_seen_at,d.revoked_at,d.jkt";
const CODE_ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
type Attempts = HashMap<(PathBuf, String), VecDeque<f64>>;
static FAILURES: OnceLock<Mutex<Attempts>> = OnceLock::new();
fn digest(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}
fn normalize_code(value: &str) -> String {
    value.trim().to_uppercase().replace(['-', ' '], "")
}
// Count before inspecting credentials. Both the client buckets and their total size are bounded.
pub fn check_attempt(home: &Path, client: &str) -> Result<()> {
    let mut failures = FAILURES
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    check_attempt_with(&mut failures, home, client, now())
}
fn check_attempt_with(failures: &mut Attempts, home: &Path, client: &str, time: f64) -> Result<()> {
    failures.retain(|_, attempts| {
        while attempts.front().is_some_and(|t| *t <= time - 60.) {
            attempts.pop_front();
        }
        !attempts.is_empty()
    });
    let key = (home.to_owned(), client.to_owned());
    if failures.len() >= 4096
        && !failures.contains_key(&key)
        && let Some(oldest) = failures
            .iter()
            .min_by(|a, b| a.1.back().unwrap().total_cmp(b.1.back().unwrap()))
            .map(|(key, _)| key.clone())
    {
        failures.remove(&oldest);
    }
    let attempts = failures.entry(key).or_default();
    if attempts.len() >= 10 {
        return Err(Error::new(4232, "too many attempts"));
    }
    attempts.push_back(time);
    Ok(())
}
fn invalid_code() -> Error {
    Error::new(4231, "invalid or expired pairing code")
}
fn create_code(conn: &Connection, owner: &str, replace: bool) -> Result<Value> {
    let mut rng = rand::thread_rng();
    let raw: String = (0..8)
        .map(|_| CODE_ALPHABET[rng.gen_range(0..CODE_ALPHABET.len())] as char)
        .collect();
    let time = now();
    if replace {
        conn.execute(
            "UPDATE pairing_codes SET used_at=? WHERE used_at IS NULL AND user_id=?",
            params![time, owner],
        )?;
    }
    conn.execute("INSERT INTO pairing_codes(code_hash,created_at,expires_at,used_at,user_id) VALUES (?,?,?,NULL,?)", params![digest(&raw), time, time+600., owner])?;
    Ok(json!({"code":format!("{}-{}", &raw[..4], &raw[4..]), "expires_at":time+600.}))
}
pub fn new_code(home: &Path, owner: &str) -> Result<Value> {
    code(home, owner, true)
}
/// A startup link must not cancel a code already handed to another device.
pub fn new_sign_in_code(home: &Path) -> Result<Value> {
    code(home, "local", false)
}
fn code(home: &Path, owner: &str, replace: bool) -> Result<Value> {
    db::migrate(home)?;
    user(home, owner)?;
    let mut conn = db::open(home)?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let code = create_code(&tx, owner, replace)?;
    tx.commit()?;
    Ok(code)
}
fn mint(
    conn: &Connection,
    name: &str,
    platform: &str,
    owner: &str,
    jkt: Option<&str>,
) -> Result<Value> {
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    let token = format!("hxb_{}", URL_SAFE_NO_PAD.encode(bytes));
    let id = uuid::Uuid::new_v4().to_string();
    let time = now();
    conn.execute(
        "INSERT INTO devices(id,name,platform,token_hash,owner_id,created_at,last_seen_at,jkt) VALUES (?,?,?,?,?,?,?,?)",
        params![id, name, platform, digest(&token), owner, time, time, jkt],
    )?;
    Ok(
        json!({"device_token": token, "device_id": id, "owner_id":owner, "daemon_name":daemon_name()}),
    )
}
fn hostname(bytes: &[u8]) -> Option<String> {
    let length = bytes.iter().position(|b| *b == 0).unwrap_or(bytes.len());
    (length > 0).then(|| String::from_utf8_lossy(&bytes[..length]).into_owned())
}
pub fn daemon_name() -> String {
    let mut bytes = [0u8; 256];
    // The buffer is valid for its entire length and is read only after gethostname returns.
    if unsafe { libc::gethostname(bytes.as_mut_ptr().cast(), bytes.len()) } == 0
        && let Some(name) = hostname(&bytes)
    {
        return name;
    }
    std::env::var("HOSTNAME")
        .ok()
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "Hexbot".into())
}
/// Main maps the pinned cloud owner to the local admin. Spend and mint atomically.
pub fn redeem_verified_grant(
    home: &Path,
    name: &str,
    platform: &str,
    jti: &str,
    exp: f64,
    jkt: Option<&str>,
) -> Result<Value> {
    let mut conn = db::open(home)?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let active = tx
        .query_row(
            "SELECT 1 FROM users WHERE id='local' AND disabled_at IS NULL",
            [],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if !active {
        return Err(Error::new(4302, "not the owner"));
    }
    tx.execute("DELETE FROM spent_grants WHERE exp <= ?", [now() - 60.])?;
    tx.execute(
        "INSERT INTO spent_grants(jti,exp) VALUES (?,?)",
        params![jti, exp],
    )
    .map_err(|_| Error::new(4231, "Hex Connect grant already used"))?;
    let device = mint(&tx, name, platform, "local", jkt)?;
    tx.commit()?;
    Ok(device)
}
pub fn redeem_code_from(
    home: &Path,
    code: &str,
    device_name: &str,
    platform: &str,
    client: &str,
    jkt: Option<&str>,
) -> Result<Value> {
    check_attempt(home, client)?;
    let mut conn = db::open(home)?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let hash = digest(&normalize_code(code));
    let time = now();
    let owner: Option<String> = tx
        .query_row(
            "SELECT c.user_id FROM pairing_codes c JOIN users u ON u.id=c.user_id WHERE c.code_hash=? AND c.used_at IS NULL AND c.expires_at>? AND u.disabled_at IS NULL",
            params![hash, time],
            |row| row.get(0),
        )
        .optional()?;
    let owner = owner.ok_or_else(invalid_code)?;
    if tx.execute(
        "UPDATE pairing_codes SET used_at=? WHERE code_hash=? AND used_at IS NULL",
        params![time, hash],
    )? != 1
    {
        return Err(invalid_code());
    }
    let device = mint(&tx, device_name, platform, &owner, jkt)?;
    tx.commit()?;
    Ok(device)
}
pub fn verify_token(home: &Path, token: &str) -> Result<Option<Value>> {
    if token.is_empty() {
        return Ok(None);
    }
    let conn = db::open(home)?;
    verify_token_with(&conn, token)
}
pub fn verify_token_with(conn: &Connection, token: &str) -> Result<Option<Value>> {
    let Some(mut device) = lookup_token_with(conn, token)? else {
        return Ok(None);
    };
    touch_device(conn, &mut device)?;
    Ok(Some(device))
}
pub(crate) fn lookup_token_with(conn: &Connection, token: &str) -> Result<Option<Value>> {
    let sql = format!(
        "SELECT {DEVICE_COLUMNS} FROM devices d JOIN users u ON u.id=d.owner_id WHERE d.token_hash=? AND d.revoked_at IS NULL AND u.disabled_at IS NULL"
    );
    let Some(device) = rows(conn, &sql, &[&digest(token)])?.into_iter().next() else {
        return Ok(None);
    };
    Ok(Some(device))
}
pub(crate) fn touch_device(conn: &Connection, device: &mut Value) -> Result<()> {
    let time = now();
    if time - device["last_seen_at"].as_f64().unwrap_or(0.) >= 60. {
        conn.execute(
            "UPDATE devices SET last_seen_at=? WHERE id=? AND revoked_at IS NULL",
            params![time, device["id"].as_str()],
        )?;
        device["last_seen_at"] = json!(time);
    }
    Ok(())
}
/// Recover or atomically replace the local credential while serializing other creators.
pub fn local_token(home: &Path) -> Result<String> {
    db::migrate(home)?;
    let mut conn = db::open(home)?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let active = tx
        .query_row(
            "SELECT 1 FROM users WHERE id='local' AND disabled_at IS NULL",
            [],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if !active {
        return Err(Error::new(4302, "not the owner"));
    }
    let path = home.join("local-device.token");
    if let Ok(token) = fs::read_to_string(&path) {
        let token = token.trim();
        let valid = tx
            .query_row(
                "SELECT 1 FROM devices WHERE token_hash=? AND owner_id='local' AND name='This computer' AND platform='local' AND revoked_at IS NULL",
                [digest(token)],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        if valid {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
            }
            tx.commit()?;
            return Ok(token.to_owned());
        }
    }
    tx.execute(
        "UPDATE devices SET revoked_at=? WHERE owner_id='local' AND name='This computer' AND platform='local' AND revoked_at IS NULL",
        [now()],
    )?;
    let device = mint(&tx, "This computer", "local", "local", None)?;
    let token = device["device_token"].as_str().expect("mint token");
    common::atomic_write(&path, format!("{token}\n").as_bytes())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
    }
    tx.commit()?;
    Ok(token.to_owned())
}
fn shape_user(mut row: Value) -> Value {
    row["limits"] = common::json_field(&row["limits_json"]);
    row.as_object_mut().expect("row").remove("limits_json");
    row
}
fn get_user(conn: &Connection, id: &str) -> Result<Value> {
    rows(conn, "SELECT * FROM users WHERE id=?", &[&id])?
        .into_iter()
        .next()
        .map(shape_user)
        .ok_or_else(|| Error::new(4204, format!("user not found: {id}")))
}
pub fn call(home: &Path, caller: &str, method: &str, p: &Value) -> Option<Result<Value>> {
    if !matches!(
        method,
        "hexbot.users.me"
            | "hexbot.users.list"
            | "hexbot.users.invite"
            | "hexbot.users.update"
            | "hexbot.devices.list"
            | "hexbot.devices.revoke"
            | "hexbot.pairing.code"
    ) {
        return None;
    }
    Some((|| {
        db::migrate(home)?;
        let current = user(home, caller)?;
        match method {
            "hexbot.users.me" => Ok(
                json!({"id":current["id"],"display_name":current["display_name"],"role":current["role"]}),
            ),
            "hexbot.users.list" => {
                admin(home, caller)?;
                Ok(
                    json!({"users": rows(&db::open(home)?,"SELECT * FROM users ORDER BY created_at,id",&[])?.into_iter().map(shape_user).collect::<Vec<_>>()}),
                )
            }
            "hexbot.users.invite" => {
                admin(home, caller)?;
                let name = required(p, "display_name")?.trim();
                if name.is_empty() {
                    return Err(Error::new(4200, "missing parameter: display_name"));
                }
                let role = p.get("role").unwrap_or(&Value::Null);
                let role = if role.is_null() && p.get("role").is_none() {
                    "member"
                } else {
                    role.as_str().unwrap_or("")
                };
                if !matches!(role, "admin" | "member") {
                    return Err(Error::new(4202, "role must be admin or member"));
                }
                let id = common::id();
                let mut conn = db::open(home)?;
                let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
                tx.execute("INSERT INTO users(id,display_name,role,limits_json,created_at) VALUES (?,?,?,'{}',?)",params![id,name,role,now()])?;
                let mut result = create_code(&tx, &id, true)?;
                result["user"] = get_user(&tx, &id)?;
                tx.commit()?;
                Ok(result)
            }
            "hexbot.users.update" => {
                admin(home, caller)?;
                let id = required(p, "id")?;
                if let Some(map) = p.as_object() {
                    for key in map.keys() {
                        if !["id", "display_name", "role", "disabled", "limits"]
                            .contains(&key.as_str())
                        {
                            return Err(Error::new(4201, format!("unknown parameter: {key}")));
                        }
                    }
                }
                if let Some(role) = p.get("role")
                    && role != "admin"
                    && role != "member"
                {
                    return Err(Error::new(4202, "role must be admin or member"));
                }
                if let Some(limits) = p.get("limits") {
                    if !limits.is_object() {
                        return Err(Error::new(4202, "limits must be an object"));
                    }
                    if let Some(value) = limits.get("daily_tokens")
                        && !value.is_null()
                        && value.as_u64().is_none()
                    {
                        return Err(Error::new(
                            4202,
                            "daily_tokens must be a non-negative integer or null",
                        ));
                    }
                }
                if p.get("display_name").is_some_and(|v| !v.is_string()) {
                    return Err(Error::new(4202, "display_name must be a string"));
                }
                let mut conn = db::open(home)?;
                let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
                let caller_active: bool = tx.query_row(
                    "SELECT EXISTS(SELECT 1 FROM users WHERE id=? AND role='admin' AND disabled_at IS NULL)",
                    [caller], |r| r.get(0),
                )?;
                if !caller_active {
                    return Err(Error::new(4301, "admin required"));
                }
                for key in ["display_name", "role"] {
                    if let Some(value) = p.get(key) {
                        tx.execute(
                            &format!("UPDATE users SET {key}=? WHERE id=?"),
                            params![value.as_str(), id],
                        )?;
                    }
                }
                if let Some(value) = p.get("disabled") {
                    let disabled = if truthy(value) { Some(now()) } else { None };
                    tx.execute(
                        "UPDATE users SET disabled_at=? WHERE id=?",
                        params![disabled, id],
                    )?;
                }
                if let Some(value) = p.get("limits") {
                    tx.execute(
                        "UPDATE users SET limits_json=? WHERE id=?",
                        params![value.to_string(), id],
                    )?;
                }
                let updated = get_user(&tx, id)?;
                let active_admin: bool = tx.query_row(
                    "SELECT EXISTS(SELECT 1 FROM users WHERE role='admin' AND disabled_at IS NULL)",
                    [],
                    |r| r.get(0),
                )?;
                if !active_admin {
                    return Err(Error::new(4202, "At least one active admin is required"));
                }
                tx.commit()?;
                Ok(json!({"user":updated}))
            }
            "hexbot.devices.list" => {
                let all = p.get("all").is_some_and(truthy);
                if all {
                    admin(home, caller)?;
                }
                let conn = db::open(home)?;
                let mut devices = if all {
                    rows(
                        &conn,
                        "SELECT id,name,platform,created_at,last_seen_at FROM devices WHERE revoked_at IS NULL ORDER BY created_at DESC",
                        &[],
                    )?
                } else {
                    rows(
                        &conn,
                        "SELECT id,name,platform,created_at,last_seen_at FROM devices WHERE revoked_at IS NULL AND owner_id=? ORDER BY created_at DESC",
                        &[&caller],
                    )?
                };
                for device in &mut devices {
                    device["current"] = json!(false);
                }
                Ok(json!({"devices":devices}))
            }
            "hexbot.devices.revoke" => {
                let id = required(p, "id")?;
                let mut conn = db::open(home)?;
                let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
                let owner: Option<String> = tx
                    .query_row(
                        "SELECT owner_id FROM devices WHERE id=? AND revoked_at IS NULL",
                        [id],
                        |r| r.get(0),
                    )
                    .optional()?;
                match owner {
                    Some(owner) if owner != caller => {
                        return Err(Error::new(4302, "not the owner"));
                    }
                    None => return Err(Error::new(4204, format!("device not found: {id}"))),
                    _ => {}
                }
                tx.execute(
                    "UPDATE devices SET revoked_at=? WHERE id=?",
                    params![now(), id],
                )?;
                tx.commit()?;
                Ok(json!({"revoked":true}))
            }
            "hexbot.pairing.code" => {
                admin(home, caller)?;
                new_code(home, caller)
            }
            _ => unreachable!(),
        }
    })())
}
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(v) => *v,
        Value::Number(v) => v.as_f64() != Some(0.),
        Value::String(v) => !v.is_empty(),
        Value::Array(v) => !v.is_empty(),
        Value::Object(v) => !v.is_empty(),
    }
}

#[cfg(test)]
mod hostname_tests {
    use super::*;
    #[test]
    fn hostname_ignores_empty_results_and_stops_at_nul() {
        assert_eq!(hostname(&[0; 256]), None);
        assert_eq!(hostname(b"owl\0ignored"), Some("owl".into()));
        assert_eq!(hostname(b"fox"), Some("fox".into()));
        assert!(!daemon_name().is_empty());
    }
}

#[cfg(test)]
mod attempt_tests {
    use super::*;
    #[test]
    fn capacity_evicts_oldest_bucket_without_resetting_active_clients() {
        let mut attempts = Attempts::new();
        let home = Path::new("fixture");
        for i in 0..4096 {
            check_attempt_with(&mut attempts, home, &i.to_string(), i as f64 / 4096.).unwrap();
        }
        for _ in 1..10 {
            check_attempt_with(&mut attempts, home, "4095", 1.).unwrap();
        }
        check_attempt_with(&mut attempts, home, "new", 2.).unwrap();
        assert_eq!(attempts.len(), 4096);
        assert!(!attempts.contains_key(&(home.to_owned(), "0".into())));
        assert_eq!(
            check_attempt_with(&mut attempts, home, "4095", 2.)
                .unwrap_err()
                .code,
            4232
        );
        check_attempt_with(&mut attempts, home, "4095", 62.).unwrap();
        assert_eq!(attempts.len(), 1);
    }
}
