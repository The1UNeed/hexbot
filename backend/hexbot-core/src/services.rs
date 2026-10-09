//! Connect registration, tunnel lifecycle, grant verification and native updates.
use crate::{Error, Result, common};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use reqwest::{Client, Method};
use ring::signature::{Ed25519KeyPair, KeyPair};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, OnceLock},
    time::Duration,
};
use tokio::{
    process::{Child, Command},
    sync::{Mutex, watch},
    task::JoinHandle,
};
use url::Url;

const CONNECT_URL: &str = "https://connect.hexbot.app";
const UPDATE_URL: &str = "https://updates.hexbot.app";
const CLOUDFLARED_VERSION: &str = "2026.8.0";
fn default_connect_base() -> String {
    std::env::var("HEXBOT_CONNECT_URL")
        .unwrap_or_else(|_| CONNECT_URL.into())
        .trim_end_matches('/')
        .to_owned()
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ConnectConfig {
    #[serde(default = "default_connect_base")]
    pub api_base: String,
    #[serde(default)]
    pub daemon_id: String,
    #[serde(default)]
    pub daemon_token: String,
    #[serde(default)]
    pub slug: String,
    #[serde(default)]
    pub tunnel_hostname: String,
    #[serde(default)]
    pub tunnel_token: String,
    #[serde(default)]
    pub registered_at: Option<f64>,
    #[serde(default)]
    pub jwks_url: String,
    #[serde(default)]
    pub owner_id: String,
    #[serde(default)]
    pub issuer: String,
    #[serde(default)]
    pub keys: Vec<Value>,
}
impl ConnectConfig {
    pub fn load(home: &Path) -> Result<Option<Self>> {
        match fs::read(home.join("connect.json")) {
            Ok(bytes) => {
                let mut config: Self = serde_json::from_slice(&bytes)
                    .map_err(|_| Error::new(5241, "invalid Hex Connect configuration"))?;
                config.api_base = config.api_base.trim_end_matches('/').to_owned();
                service_url(&config.api_base)?;
                if config.jwks_url.is_empty() {
                    config.jwks_url = format!("{}/.well-known/jwks.json", config.api_base);
                }
                same_origin(&config.api_base, &config.jwks_url)?;
                if !config.daemon_id.is_empty()
                    && (config.owner_id.is_empty()
                        || config.issuer.is_empty()
                        || config.keys.is_empty())
                {
                    eprintln!(
                        "This Hex Connect registration predates owner pinning; run `hexbot connect` again"
                    );
                    return Ok(None);
                }
                Ok(Some(config))
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.into()),
        }
    }
    fn save(&self, home: &Path) -> Result<()> {
        common::atomic_write(
            &home.join("connect.json"),
            &serde_json::to_vec_pretty(self)
                .map_err(|_| Error::new(5241, "invalid Hex Connect configuration"))?,
        )
    }
}

fn new_identity_key() -> Result<String> {
    let key = Ed25519KeyPair::generate_pkcs8(&ring::rand::SystemRandom::new())
        .map_err(|_| Error::new(5241, "could not generate daemon identity key"))?;
    Ok(URL_SAFE_NO_PAD.encode(key.as_ref()))
}
const IDENTITY_FILE: &str = "connect-identity.key";
const IDENTITY_CONFLICT: &str =
    "Hex Connect has a different key for this daemon. Disconnect and connect again.";
const IDENTITY_UNAVAILABLE: &str = "connect-identity.key in the Hexbot home could not be read or saved. Check the file and restart the daemon.";

struct CachedIdentity {
    daemon_id: String,
    key: Option<Arc<Ed25519KeyPair>>,
}
fn parse_identity_key(encoded: &[u8]) -> Result<Arc<Ed25519KeyPair>> {
    let bytes = URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| Error::new(5241, "invalid daemon identity key"))?;
    Ed25519KeyPair::from_pkcs8(&bytes)
        .map(Arc::new)
        .map_err(|_| Error::new(5241, "invalid daemon identity key"))
}
fn read_identity_key(home: &Path) -> Result<Vec<u8>> {
    match fs::read(home.join(IDENTITY_FILE)) {
        Ok(bytes) => Ok(bytes),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let encoded = new_identity_key()?;
            common::atomic_write(&home.join(IDENTITY_FILE), encoded.as_bytes())?;
            Ok(encoded.into_bytes())
        }
        Err(error) => Err(error.into()),
    }
}
async fn identity_error(service: &Service, message: Option<String>) {
    let mut data = service.data.lock().await;
    data.identity_error = message;
    drop(data);
    bump(service);
}

/// Local preparation runs under lifecycle; network enrollment never blocks startup.
async fn start_identity(home: &Path, service: &Arc<Service>, config: &ConnectConfig) {
    let prepared = read_identity_key(home).and_then(|encoded| parse_identity_key(&encoded));
    let (key, replacement) = match prepared {
        Ok(key) => (Some(key), None),
        Err(error) => {
            eprintln!("Connect identity: {error}");
            identity_error(service, Some(IDENTITY_UNAVAILABLE.into())).await;
            // Only malformed keys may be replaced. I/O failures need operator repair.
            // Keep a candidate in memory until Connect's TOFU write accepts it.
            let replacement = if error.code == 5241 {
                new_identity_key().ok().and_then(|encoded| {
                    parse_identity_key(encoded.as_bytes())
                        .ok()
                        .map(|key| (encoded, key))
                })
            } else {
                None
            };
            (None, replacement)
        }
    };
    *service.identity.lock().await = Some(CachedIdentity {
        daemon_id: config.daemon_id.clone(),
        key: key.clone(),
    });
    if !service
        .data
        .lock()
        .await
        .identity_attempted
        .insert(config.daemon_id.clone())
    {
        return;
    }
    let Some(enrollment_key) = key.or_else(|| replacement.as_ref().map(|(_, key)| key.clone()))
    else {
        return;
    };
    let home = home.to_owned();
    let config = config.clone();
    let worker_service = service.clone();
    let task =
        tokio::spawn(async move {
            let result = object(Method::POST,
            &format!("{}/api/daemons/{}/identity", config.api_base, config.daemon_id),
            Some(&config.daemon_token),
            Some(json!({"public_key": URL_SAFE_NO_PAD.encode(enrollment_key.public_key().as_ref()),
                "tunnel_token": config.tunnel_token}))).await;
            if result.as_ref().is_err_and(revoked_by_connect) {
                forget_later(&home, &worker_service, &config.daemon_id);
                return;
            }
            let _operation = worker_service.lifecycle.lock().await;
            // A response from an old registration must never change a newer one.
            if worker_service
                .identity
                .lock()
                .await
                .as_ref()
                .is_none_or(|c| c.daemon_id != config.daemon_id)
            {
                return;
            }
            match result {
                Ok(_) => {
                    if let Some((encoded, key)) = replacement {
                        if let Err(error) =
                            common::atomic_write(&home.join(IDENTITY_FILE), encoded.as_bytes())
                        {
                            eprintln!("Connect identity: {error}");
                            identity_error(&worker_service, Some(IDENTITY_UNAVAILABLE.into()))
                                .await;
                            return;
                        }
                        *worker_service.identity.lock().await = Some(CachedIdentity {
                            daemon_id: config.daemon_id,
                            key: Some(key),
                        });
                    }
                    identity_error(&worker_service, None).await;
                }
                Err(error) => {
                    if error
                        .data
                        .as_ref()
                        .is_some_and(|data| data["status"] == 409)
                    {
                        identity_error(&worker_service, Some(IDENTITY_CONFLICT.into())).await;
                    }
                    if !error
                        .data
                        .as_ref()
                        .is_some_and(|data| data["status"] == 404)
                    {
                        eprintln!("Connect identity enrollment: {error}");
                    }
                    bump(&worker_service);
                }
            }
        });
    *service.identity_task.lock().await = Some(task);
}

/// Parsed once per registration, invalidated by registration, disconnect and revoke.
/// The lazy load supports a CLI registration made before this process starts serving.
pub async fn identity_response(home: &Path, host: &str, nonce: &str) -> Result<Option<Value>> {
    let service = service(home).await?;
    let _operation = service.lifecycle.lock().await;
    let mut cached = service.identity.lock().await;
    if cached.is_none() {
        let Some(config) = ConnectConfig::load(home)?.filter(|c| !c.daemon_id.is_empty()) else {
            return Ok(None);
        };
        let key = match read_identity_key(home).and_then(|encoded| parse_identity_key(&encoded)) {
            Ok(key) => Some(key),
            Err(error) => {
                eprintln!("Connect identity: {error}");
                identity_error(&service, Some(IDENTITY_UNAVAILABLE.into())).await;
                None
            }
        };
        *cached = Some(CachedIdentity {
            daemon_id: config.daemon_id,
            key,
        });
    }
    let identity = cached.as_ref().expect("initialized identity");
    let key = identity
        .key
        .as_ref()
        .ok_or_else(|| Error::new(5241, IDENTITY_UNAVAILABLE))?;
    let message = format!(
        "hexbot-identity-v1\n{}\n{host}\n{nonce}",
        identity.daemon_id
    );
    Ok(Some(json!({"daemon_id": identity.daemon_id,
        "public_key": URL_SAFE_NO_PAD.encode(key.public_key().as_ref()),
        "signature": URL_SAFE_NO_PAD.encode(key.sign(message.as_bytes()).as_ref())})))
}

struct Workers {
    stop: watch::Sender<bool>,
    tasks: Vec<JoinHandle<()>>,
}
struct Data {
    running: bool,
    identity_attempted: std::collections::HashSet<String>,
    identity_error: Option<String>,
    heartbeat: Option<f64>,
    error: Option<String>,
    port: u16,
    update: Value,
    update_task: Option<JoinHandle<()>>,
    restart: Option<PathBuf>,
}
impl Default for Data {
    fn default() -> Self {
        Self {
            running: false,
            identity_attempted: Default::default(),
            identity_error: None,
            heartbeat: None,
            error: None,
            port: 9119,
            update: json!({"status":"idle","requested":null,"version":null,"message":null,"percent":null,"at":null}),
            update_task: None,
            restart: None,
        }
    }
}
struct Service {
    data: Mutex<Data>,
    workers: Mutex<Option<Workers>>,
    lifecycle: Mutex<()>,
    jwks: Mutex<JwksCache>,
    identity: Mutex<Option<CachedIdentity>>,
    identity_task: Mutex<Option<JoinHandle<()>>>,
    /// Bumped after every heartbeat outcome and after a registration is dropped, so
    /// in-crate tests can wait for the worker instead of sleeping.
    changed: watch::Sender<u64>,
}
impl Default for Service {
    fn default() -> Self {
        Self {
            data: Mutex::default(),
            workers: Mutex::default(),
            lifecycle: Mutex::default(),
            jwks: Mutex::default(),
            identity: Mutex::default(),
            identity_task: Mutex::default(),
            changed: watch::channel(0).0,
        }
    }
}
fn bump(service: &Service) {
    service.changed.send_modify(|generation| *generation += 1);
}
/// What Settings shows after the owner revoked this daemon on the Connect dashboard.
const REVOKED_REASON: &str = "Removed in Hex Connect";
/// Only Connect's own `410 daemon_revoked` means the owner revoked this daemon. A 401, a
/// 5xx, or an unreachable service never does: a Connect outage must not disconnect daemons.
fn revoked_by_connect(error: &Error) -> bool {
    error
        .data
        .as_ref()
        .is_some_and(|data| data["status"] == 410 && data["error"] == "daemon_revoked")
}
/// Forget the registration the way `hexbot.connect.disconnect` does: stop the workers,
/// remove `connect.json`, clear the public URL (which also removes the login button).
/// With `only` set, nothing happens unless that daemon id is still the registered one,
/// so a stale worker cannot remove a registration made after it.
async fn drop_registration(
    home: &Path,
    service: &Service,
    only: Option<&str>,
    reason: Option<&str>,
    notify_connect: bool,
) -> Result<bool> {
    let _operation = service.lifecycle.lock().await;
    let config = ConnectConfig::load(home).ok().flatten();
    if let Some(expected) = only
        && config.as_ref().is_none_or(|c| c.daemon_id != expected)
    {
        return Ok(false);
    }
    stop_workers(service).await;
    if notify_connect
        && let Some(config) = &config
        && common::identifier(&config.daemon_id).is_ok()
    {
        let _ = object(
            Method::DELETE,
            &format!("{}/api/daemons/{}", config.api_base, config.daemon_id),
            Some(&config.daemon_token),
            None,
        )
        .await;
    }
    // Still under the lock, but re-read right before removing anything: the registration
    // on disk is what gets removed, and it must be the one this call was asked to drop.
    if let Some(expected) = only
        && ConnectConfig::load(home)
            .ok()
            .flatten()
            .is_none_or(|c| c.daemon_id != expected)
    {
        return Ok(false);
    }
    *service.identity.lock().await = None;
    match fs::remove_file(home.join("connect.json")) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.into()),
    }
    match fs::remove_file(home.join(IDENTITY_FILE)) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.into()),
    }
    apply_public_url(home, None)?;
    {
        let mut data = service.data.lock().await;
        data.heartbeat = None;
        data.identity_error = None;
        data.error = reason.map(str::to_owned);
    }
    bump(service);
    Ok(true)
}
/// A worker cannot stop itself (stopping waits for it), so it hands the removal to a task
/// of its own and returns.
fn forget_later(home: &Path, service: &Arc<Service>, daemon_id: &str) {
    let home = home.to_owned();
    let service = service.clone();
    let daemon_id = daemon_id.to_owned();
    tokio::spawn(async move {
        if let Err(error) = drop_registration(
            &home,
            &service,
            Some(&daemon_id),
            Some(REVOKED_REASON),
            false,
        )
        .await
        {
            eprintln!("Connect: {error}");
        }
    });
}
/// How the tunnel supervisor judges `cloudflared`. A tunnel that is gone on Cloudflare's
/// side does not make `cloudflared` exit quickly: it retries for most of a minute, and an
/// `Unauthorized` answer keeps it retrying for ever, so readiness (an edge connection,
/// `/ready` on its metrics port) is what counts. Tests shorten these.
#[derive(Clone, Copy)]
struct TunnelTiming {
    /// How often `/ready` is polled.
    poll: Duration,
    /// Not ready for this long, since start or since it was last ready, is a failure.
    ready_timeout: Duration,
    /// An exit this soon after start is a failure.
    exit_window: Duration,
    /// Wait between repairs; longer than Connect's own two-minute cooldown so the first
    /// retry is not a guaranteed 429. Doubled while repairs keep not helping.
    repair_interval: Duration,
    repair_interval_max: Duration,
    /// This many failures in a row mean the tunnel itself may be broken.
    failures_before_repair: u32,
}
impl Default for TunnelTiming {
    fn default() -> Self {
        Self {
            poll: Duration::from_secs(5),
            ready_timeout: Duration::from_secs(180),
            exit_window: Duration::from_secs(300),
            repair_interval: Duration::from_secs(150),
            repair_interval_max: Duration::from_secs(1800),
            failures_before_repair: 3,
        }
    }
}
/// Ask Connect for a tunnel that works. Connect re-points the hostname at the tunnel it
/// already has and answers `replaced: false`, or, when that tunnel is gone, creates a
/// replacement under the same hostname and answers its token with `replaced: true`. Only
/// then is `connect.json` rewritten; `Some` carries the new configuration. `None` when
/// nothing changed, Connect predates repair (404), or it refused for now (429).
async fn repair_tunnel(home: &Path, config: &ConnectConfig) -> Result<Option<ConnectConfig>> {
    let result = daemon_request(
        home,
        config,
        Method::POST,
        &format!("/api/daemons/{}/tunnel", config.daemon_id),
        Some(json!({"tunnel_token": config.tunnel_token})),
    )
    .await;
    let value = match result {
        Ok(value) => value,
        Err(error)
            if error
                .data
                .as_ref()
                .is_some_and(|data| data["status"] == 404 || data["status"] == 429) =>
        {
            return Ok(None);
        }
        Err(error) => return Err(error),
    };
    if value["replaced"] != true {
        return Ok(None);
    }
    let token = common::required(&value, "tunnel_token")?.to_owned();
    let mut updated = ConnectConfig::load(home)?
        .filter(|current| current.daemon_id == config.daemon_id)
        .ok_or_else(|| Error::new(5241, "Hex Connect registration changed"))?;
    updated.tunnel_token = token;
    if let Some(host) = value["tunnel_hostname"]
        .as_str()
        .filter(|host| !host.is_empty() && *host != updated.tunnel_hostname)
    {
        apply_public_url(home, Some(host))?;
        updated.tunnel_hostname = host.to_owned();
    }
    updated.save(home)?;
    Ok(Some(updated))
}
/// A Connect call with the daemon token. On `410 daemon_revoked` the registration is dropped.
async fn daemon_request(
    home: &Path,
    config: &ConnectConfig,
    method: Method,
    path: &str,
    body: Option<Value>,
) -> Result<Value> {
    let result = object(
        method,
        &format!("{}{path}", config.api_base),
        Some(&config.daemon_token),
        body,
    )
    .await;
    if let Err(error) = &result
        && revoked_by_connect(error)
        && let Ok(service) = service(home).await
    {
        forget_later(home, &service, &config.daemon_id);
    }
    result
}
static SERVICES: OnceLock<Mutex<HashMap<PathBuf, Arc<Service>>>> = OnceLock::new();
async fn service(home: &Path) -> Result<Arc<Service>> {
    if !home.is_absolute() {
        return Err(Error::new(4202, "service home must be absolute"));
    }
    let key = fs::canonicalize(home)?;
    Ok(SERVICES
        .get_or_init(Default::default)
        .lock()
        .await
        .entry(key)
        .or_default()
        .clone())
}
fn client() -> Result<Client> {
    crate::http::client(15, 0).map_err(|_| Error::new(5241, "could not create HTTP client"))
}
fn service_url(value: &str) -> Result<Url> {
    let url = Url::parse(value).map_err(|_| Error::new(5241, "invalid service URL"))?;
    let local = matches!(
        url.host_str(),
        Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
    );
    if (url.scheme() != "https" && !(url.scheme() == "http" && local))
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(Error::new(
            5241,
            "service URL requires HTTPS or loopback HTTP",
        ));
    }
    Ok(url)
}
fn same_origin(base: &str, target: &str) -> Result<()> {
    let base = service_url(base)?;
    let target = service_url(target)?;
    if base.origin() != target.origin() {
        return Err(Error::new(
            5241,
            "service response changed credential origin",
        ));
    }
    Ok(())
}
/// Resolve signed artifact paths against this daemon's update server.
fn artifact_url(base: &str, location: &str) -> Result<Url> {
    let root = service_url(&format!("{}/", base.trim_end_matches('/')))?;
    if location.trim().is_empty() {
        return Err(Error::new(5243, "invalid native update URL"));
    }
    let url = root
        .join(location.trim())
        .map_err(|_| Error::new(5243, "invalid native update URL"))?;
    same_origin(base, url.as_str())?;
    Ok(url)
}
async fn object(
    method: Method,
    url: &str,
    token: Option<&str>,
    body: Option<Value>,
) -> Result<Value> {
    service_url(url)?;
    let mut request = client()?.request(method, url);
    if let Some(token) = token {
        request = request.bearer_auth(token);
    }
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request
        .send()
        .await
        .map_err(|_| Error::new(5241, "Hex Connect service unreachable"))?;
    if !response.status().is_success() {
        // Keep the status and Connect's error code: a 410 `daemon_revoked` means something
        // (see `revoked_by_connect`), every other failure is just an error.
        let status = response.status().as_u16();
        let code = crate::http::json(
            response,
            64 * 1024,
            |_| Error::new(5241, "Hex Connect response failed"),
            Error::new(5241, "Hex Connect response exceeds byte limit"),
            Error::new(5241, "Hex Connect returned invalid JSON"),
        )
        .await
        .ok()
        .and_then(|value| value["error"].as_str().map(str::to_owned));
        return Err(
            Error::new(5241, format!("Hex Connect service returned HTTP {status}"))
                .with_data(json!({"status":status,"error":code})),
        );
    }
    let value = crate::http::json(
        response,
        1024 * 1024,
        |_| Error::new(5241, "Hex Connect response failed"),
        Error::new(5241, "Hex Connect response exceeds byte limit"),
        Error::new(5241, "Hex Connect returned invalid JSON"),
    )
    .await?;
    if !value.is_object() {
        return Err(Error::new(
            5241,
            "Hex Connect returned a non-object response",
        ));
    }
    Ok(value)
}
fn api_base(home: &Path) -> Result<String> {
    let configured = common::read_config(home)?;
    let value = configured
        .pointer("/connect/api_base")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| std::env::var("HEXBOT_CONNECT_URL").ok())
        .unwrap_or_else(|| CONNECT_URL.into());
    service_url(&value)?;
    Ok(value.trim_end_matches('/').to_owned())
}

pub fn apply_public_url(home: &Path, hostname: Option<&str>) -> Result<()> {
    if let Some(host) = hostname {
        let url = service_url(&format!("https://{host}"))?;
        if url.host_str() != Some(host) || url.path() != "/" || url.port().is_some() {
            return Err(Error::new(5241, "invalid tunnel hostname"));
        }
    }
    let mut targets = vec![home.to_owned()];
    if home.join("profiles").is_dir() {
        for entry in fs::read_dir(home.join("profiles"))? {
            let entry = entry?;
            if entry.file_type()?.is_dir() {
                targets.push(entry.path());
            }
        }
    }
    for target in targets {
        let writer = common::config_writer()?;
        let Ok(mut config) = common::read_config(&target) else {
            continue;
        };
        if !config.is_object() {
            config = json!({});
        }
        if let Some(host) = hostname {
            if !config["dashboard"].is_object() {
                config["dashboard"] = json!({});
            }
            config["dashboard"]["public_url"] = json!(format!("https://{host}"));
        } else if let Some(dashboard) = config.get_mut("dashboard").and_then(Value::as_object_mut) {
            dashboard.remove("public_url");
            if dashboard.is_empty() {
                config.as_object_mut().unwrap().remove("dashboard");
            }
        }
        writer.write(&target, &config)?;
    }
    Ok(())
}

pub(crate) async fn download(url: &str, path: &Path, max_bytes: u64, github: bool) -> Result<()> {
    let mut current = service_url(url)?;
    let http =
        crate::http::client(180, 0).map_err(|_| Error::new(5242, "download client unavailable"))?;
    for _ in 0..6 {
        let mut response = http
            .get(current.clone())
            .send()
            .await
            .map_err(|_| Error::new(5242, "download failed"))?;
        if response.status().is_redirection() {
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or_else(|| Error::new(5242, "invalid download redirect"))?;
            let next = current
                .join(location)
                .map_err(|_| Error::new(5242, "invalid download redirect"))?;
            let allowed = github
                && next.scheme() == "https"
                && matches!(
                    next.host_str(),
                    Some(
                        "github.com"
                            | "objects.githubusercontent.com"
                            | "release-assets.githubusercontent.com"
                    )
                );
            if !allowed {
                return Err(Error::new(5242, "download redirect refused"));
            }
            current = next;
            continue;
        }
        if !response.status().is_success() {
            return Err(Error::new(
                5242,
                format!("download returned HTTP {}", response.status().as_u16()),
            ));
        }
        let mut file = fs::File::create(path)?;
        let mut received = 0;
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| Error::new(5242, "download interrupted"))?
        {
            received += chunk.len() as u64;
            if received > max_bytes {
                return Err(Error::new(5242, "download exceeds byte limit"));
            }
            file.write_all(&chunk)?;
        }
        file.sync_all()?;
        return Ok(());
    }
    Err(Error::new(5242, "too many download redirects"))
}
fn cloudflared_asset() -> Result<(&'static str, &'static str)> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Ok((
            "cloudflared-darwin-arm64.tgz",
            "6244b4b199515690f93e170110d219d8d141184ba847179980c2f5906800c931",
        )),
        ("macos", "x86_64") => Ok((
            "cloudflared-darwin-amd64.tgz",
            "95c57d69cf6b19a94880090d76f24f46cd359c68ca82a14b143ea604dff33020",
        )),
        ("linux", "aarch64") => Ok((
            "cloudflared-linux-arm64",
            "d2b49df8dbb3a36e743ce00b091c180e0942a0b67487257c573a631db001796c",
        )),
        ("linux", "x86_64") => Ok((
            "cloudflared-linux-amd64",
            "14ecae0dd17ba74f8055e22b8f5b5acc3cbb5a9c3be4e7d6507fe1c4eadaea95",
        )),
        _ => Err(Error::new(5242, "unsupported cloudflared platform")),
    }
}
fn verified_cloudflared(asset: &Path, expected: &str, compressed: bool) -> Result<Vec<u8>> {
    let bytes = fs::read(asset)?;
    if bytes.len() > 128 * 1024 * 1024 || format!("{:x}", Sha256::digest(&bytes)) != expected {
        return Err(Error::new(
            5242,
            "cloudflared does not match its pinned SHA-256",
        ));
    }
    if !compressed {
        return Ok(bytes);
    }
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(bytes.as_slice()));
    for entry in archive.entries()? {
        let mut entry = entry?;
        if entry.path()?.file_name() == Some(std::ffi::OsStr::new("cloudflared"))
            && entry.header().entry_type().is_file()
        {
            let mut binary = Vec::new();
            entry
                .by_ref()
                .take(128 * 1024 * 1024 + 1)
                .read_to_end(&mut binary)?;
            if binary.len() > 128 * 1024 * 1024 {
                return Err(Error::new(5242, "cloudflared exceeds byte limit"));
            }
            return Ok(binary);
        }
    }
    Err(Error::new(5242, "cloudflared missing from archive"))
}
fn install_cloudflared(binary: &Path, bytes: &[u8]) -> Result<()> {
    // Always compare with the pinned asset, including a cached executable.
    if fs::symlink_metadata(binary).is_ok_and(|m| m.file_type().is_symlink())
        || fs::read(binary).ok().as_deref() != Some(bytes)
    {
        let mut temporary =
            tempfile::NamedTempFile::new_in(binary.parent().expect("binary directory"))?;
        temporary.write_all(bytes)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            temporary
                .as_file()
                .set_permissions(fs::Permissions::from_mode(0o700))?;
        }
        temporary.as_file().sync_all()?;
        temporary
            .persist(binary)
            .map_err(|e| Error::from(e.error))?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(binary, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}
async fn ensure_cloudflared(home: &Path) -> Result<PathBuf> {
    let (name, digest) = cloudflared_asset()?;
    let url = format!(
        "https://github.com/cloudflare/cloudflared/releases/download/{CLOUDFLARED_VERSION}/{name}"
    );
    ensure_cloudflared_asset(home, name, digest, &url).await
}
async fn ensure_cloudflared_asset(
    home: &Path,
    name: &str,
    digest: &str,
    url: &str,
) -> Result<PathBuf> {
    let directory = home.join("bin");
    fs::create_dir_all(&directory)?;
    let binary = directory.join(format!("cloudflared-{CLOUDFLARED_VERSION}"));
    let asset = directory.join(format!("{name}-{CLOUDFLARED_VERSION}.asset"));
    let compressed = name.ends_with(".tgz");
    let bytes = match verified_cloudflared(&asset, digest, compressed) {
        Ok(bytes) => bytes,
        Err(_) => {
            let temporary = tempfile::NamedTempFile::new_in(&directory)?;
            download(url, temporary.path(), 128 * 1024 * 1024, true).await?;
            let bytes = verified_cloudflared(temporary.path(), digest, compressed)?;
            temporary
                .persist(&asset)
                .map_err(|e| Error::from(e.error))?;
            bytes
        }
    };
    install_cloudflared(&binary, &bytes)?;
    // The unversioned binary from older releases is never executed.
    match fs::remove_file(directory.join("cloudflared")) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.into()),
    }
    Ok(binary)
}
async fn terminate(child: &mut Child) {
    #[cfg(unix)]
    if let Some(pid) = child.id() {
        unsafe {
            libc::kill(pid as i32, libc::SIGTERM);
        }
    }
    if tokio::time::timeout(Duration::from_secs(2), child.wait())
        .await
        .is_err()
    {
        let _ = child.start_kill();
        let _ = child.wait().await;
    }
}
async fn stop_workers(service: &Service) {
    if let Some(task) = service.identity_task.lock().await.take() {
        task.abort();
        let _ = task.await;
    }
    if let Some(workers) = service.workers.lock().await.take() {
        workers.stop.send_replace(true);
        for task in workers.tasks {
            let _ = task.await;
        }
    }
    service.data.lock().await.running = false;
}

/// Start the persisted Connect registration. The daemon calls this after binding.
pub async fn start_daemon(home: &Path, port: u16) -> Result<bool> {
    let service = service(home).await?;
    let _operation = service.lifecycle.lock().await;
    stop_workers(&service).await;
    service.data.lock().await.port = port;
    let Some(config) = ConnectConfig::load(home)?.filter(|c| !c.daemon_id.is_empty()) else {
        return Ok(false);
    };
    common::identifier(&config.daemon_id)?;
    if config.daemon_token.is_empty() || config.tunnel_token.is_empty() {
        return Err(Error::new(5241, "incomplete Hex Connect registration"));
    }
    start_identity(home, &service, &config).await;
    apply_public_url(home, Some(&config.tunnel_hostname))?;
    let binary = ensure_cloudflared(home).await?;
    run_tunnel(
        home,
        port,
        service.clone(),
        config,
        binary,
        TunnelTiming::default(),
    )
    .await
}
/// A loopback port for cloudflared's metrics endpoint, where `/ready` lives.
fn free_port() -> Result<u16> {
    Ok(std::net::TcpListener::bind("127.0.0.1:0")?
        .local_addr()?
        .port())
}
/// True while cloudflared reports at least one registered edge connection.
async fn tunnel_ready(client: Option<&Client>, url: &str) -> bool {
    match client {
        Some(client) => client
            .get(url)
            .send()
            .await
            .is_ok_and(|response| response.status() == reqwest::StatusCode::OK),
        None => false,
    }
}
fn spawn_cloudflared(
    binary: &Path,
    settings: &Path,
    logs: &Path,
    port: u16,
    metrics: u16,
    token: &str,
) -> Result<Child> {
    common::atomic_write(
        settings,
        &serde_json::to_vec(&json!({"ingress":[{"service":format!("http://127.0.0.1:{port}")}]}))
            .expect("tunnel settings"),
    )?;
    let log = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(logs)?;
    Command::new(binary)
        .arg("tunnel")
        .arg("--config")
        .arg(settings)
        .args([
            "--no-autoupdate",
            "--metrics",
            &format!("127.0.0.1:{metrics}"),
            "run",
        ])
        .env("TUNNEL_TOKEN", token)
        .stdin(Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log)
        .kill_on_drop(true)
        .spawn()
        .map_err(Into::into)
}
/// Why one cloudflared lifetime ended.
enum Outcome {
    Exited(std::io::Result<std::process::ExitStatus>),
    NotReady,
}
async fn run_tunnel(
    home: &Path,
    port: u16,
    service: Arc<Service>,
    config: ConnectConfig,
    binary: PathBuf,
    timing: TunnelTiming,
) -> Result<bool> {
    let tunnel_settings = home.join("cloudflared.yml");
    fs::create_dir_all(home.join("logs"))?;
    let logs = home.join("logs/cloudflared.log");
    let metrics = free_port()?;
    let child = spawn_cloudflared(
        &binary,
        &tunnel_settings,
        &logs,
        port,
        metrics,
        &config.tunnel_token,
    )?;
    // `running` means ready: an edge connection, not merely a live process.
    service.data.lock().await.running = false;
    let (stop, mut stopped) = watch::channel(false);
    let mut heartbeat_stop = stopped.clone();
    let tunnel_service = service.clone();
    let tunnel_home = home.to_owned();
    let mut tunnel_config = config.clone();
    let tunnel = tokio::spawn(async move {
        let mut ready_url = format!("http://127.0.0.1:{metrics}/ready");
        let probe = Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(2))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .ok();
        let mut child = child;
        let mut backoff = 1;
        let mut failures = 0;
        let mut repair_interval = timing.repair_interval;
        let mut last_repair: Option<std::time::Instant> = None;
        'supervise: loop {
            let started = std::time::Instant::now();
            let mut last_ok = started;
            let outcome = loop {
                let watch = async {
                    tokio::time::sleep(timing.poll).await;
                    tunnel_ready(probe.as_ref(), &ready_url).await
                };
                tokio::select! {
                    _ = stopped.changed() => {
                        terminate(&mut child).await;
                        break 'supervise;
                    }
                    result = child.wait() => break Outcome::Exited(result),
                    ready = watch => {
                        if ready {
                            last_ok = std::time::Instant::now();
                            failures = 0;
                            backoff = 1;
                        }
                        let mut data = tunnel_service.data.lock().await;
                        let changed = data.running != ready;
                        data.running = ready;
                        if ready { data.error = None; }
                        drop(data);
                        if changed { bump(&tunnel_service); }
                        if !ready && last_ok.elapsed() >= timing.ready_timeout {
                            terminate(&mut child).await;
                            break Outcome::NotReady;
                        }
                    },
                }
            };
            {
                let mut data = tunnel_service.data.lock().await;
                data.running = false;
                data.error = Some(match outcome {
                    Outcome::Exited(Ok(status)) => format!("cloudflared exited: {status}"),
                    Outcome::Exited(Err(_)) => "cloudflared process failed".into(),
                    Outcome::NotReady => "cloudflared has no connection to Cloudflare".into(),
                });
            }
            let failed = match outcome {
                Outcome::Exited(_) => started.elapsed() < timing.exit_window,
                Outcome::NotReady => true,
            };
            failures = if failed { failures + 1 } else { 0 };
            bump(&tunnel_service);
            // cloudflared that cannot connect usually means the tunnel is gone on
            // Cloudflare's side. Ask Connect to repair it rather than restarting forever.
            if failures >= timing.failures_before_repair
                && last_repair.is_none_or(|at| at.elapsed() >= repair_interval)
            {
                last_repair = Some(std::time::Instant::now());
                let repair = repair_tunnel(&tunnel_home, &tunnel_config);
                let result = tokio::select! {
                    _ = stopped.changed() => break 'supervise,
                    result = repair => result,
                };
                match result {
                    Ok(Some(updated)) => {
                        tunnel_config = updated;
                        backoff = 1;
                        failures = 0;
                        repair_interval = timing.repair_interval;
                    }
                    Err(error) if revoked_by_connect(&error) => {
                        // The registration is being dropped; it stops these workers.
                        break 'supervise;
                    }
                    other => {
                        if let Err(error) = other {
                            tunnel_service.data.lock().await.error =
                                Some(format!("tunnel repair failed: {}", error.message));
                        }
                        // Not helping: ask less often.
                        repair_interval = (repair_interval * 2).min(timing.repair_interval_max);
                    }
                }
            }
            loop {
                tokio::select! { _=stopped.changed()=>break 'supervise, _=tokio::time::sleep(Duration::from_secs(backoff))=>{} }
                backoff = (backoff * 2).min(16);
                let restarted = free_port().and_then(|metrics| {
                    let child = spawn_cloudflared(
                        &binary,
                        &tunnel_settings,
                        &logs,
                        port,
                        metrics,
                        &tunnel_config.tunnel_token,
                    )?;
                    ready_url = format!("http://127.0.0.1:{metrics}/ready");
                    Ok(child)
                });
                match restarted {
                    Ok(new_child) => {
                        child = new_child;
                        break;
                    }
                    Err(_) => {
                        tunnel_service.data.lock().await.error =
                            Some("could not restart cloudflared".into());
                    }
                }
            }
        }
        tunnel_service.data.lock().await.running = false;
    });
    let heartbeat_service = service.clone();
    let heartbeat_home = home.to_owned();
    let heartbeat = tokio::spawn(async move {
        let heartbeat_path = format!("/api/daemons/{}/heartbeat", config.daemon_id);
        // The first beat goes out at once; the rest every five minutes.
        loop {
            let request = daemon_request(
                &heartbeat_home,
                &config,
                Method::POST,
                &heartbeat_path,
                Some(json!({"port":port})),
            );
            tokio::select! {
                _ = heartbeat_stop.changed() => break,
                result = request => {
                    let revoked = result.as_ref().is_err_and(revoked_by_connect);
                    {
                        let mut data = heartbeat_service.data.lock().await;
                        match result {
                            Ok(_) => {
                                data.heartbeat = Some(common::now());
                                data.error = None;
                            }
                            Err(error) => data.error = Some(error.message),
                        }
                    }
                    bump(&heartbeat_service);
                    if revoked {
                        // `daemon_request` is dropping the registration; it will stop the tunnel too.
                        break;
                    }
                }
            }
            tokio::select! { _=heartbeat_stop.changed()=>break, _=tokio::time::sleep(Duration::from_secs(300))=>{} }
        }
    });
    *service.workers.lock().await = Some(Workers {
        stop,
        tasks: vec![tunnel, heartbeat],
    });
    Ok(true)
}
pub async fn shutdown(home: &Path) -> Result<()> {
    let service = service(home).await?;
    let _operation = service.lifecycle.lock().await;
    stop_workers(&service).await;
    if let Some(task) = service.data.lock().await.update_task.take() {
        task.abort();
        let _ = task.await;
    }
    Ok(())
}
pub async fn take_restart(home: &Path) -> Result<Option<PathBuf>> {
    Ok(service(home).await?.data.lock().await.restart.take())
}
async fn connect_status(home: &Path) -> Result<Value> {
    let config = ConnectConfig::load(home)?;
    let service = service(home).await?;
    let data = service.data.lock().await;
    Ok(json!({
        "registered": config.as_ref().is_some_and(|c| !c.daemon_id.is_empty()),
        "daemon_id": config.as_ref().map(|c| &c.daemon_id),
        "slug": config.as_ref().map(|c| &c.slug),
        "tunnel_hostname": config.as_ref().map(|c| &c.tunnel_hostname),
        "tunnel_running": data.running,
        "last_heartbeat_at": data.heartbeat,
        "last_error": data.error,
        "identity_error": data.identity_error
    }))
}

#[derive(Default)]
struct JwksCache {
    url: String,
    at: Option<f64>,
    keys: Vec<Value>,
}
async fn published_keys(home: &Path, config: &ConnectConfig, kid: &str) -> Result<Vec<Value>> {
    let service = service(home).await?;
    let mut cache = service.jwks.lock().await;
    let now = common::now();
    let age = cache.at.map(|at| now - at);
    if cache.url == config.jwks_url
        && age.is_some_and(|age| {
            age >= 0.
                && (age < 60. || (age < 600. && cache.keys.iter().any(|key| key["kid"] == kid)))
        })
    {
        return Ok(cache.keys.clone());
    }
    // Remember failures too; unauthenticated clients cannot force repeated fetches.
    cache.url = config.jwks_url.clone();
    cache.at = Some(now);
    cache.keys.clear();
    let raw = object(Method::GET, &config.jwks_url, None, None).await?;
    cache.keys = raw["keys"]
        .as_array()
        .ok_or_else(|| Error::new(4231, "invalid Hex Connect signing keys"))?
        .clone();
    Ok(cache.keys.clone())
}

/// Verify pinned identity and signing material, then spend and mint in one transaction.
pub async fn redeem_grant(
    home: &Path,
    grant: &str,
    _device_name: &str,
    platform: &str,
    proof_jkt: Option<&str>,
) -> Result<Value> {
    let check = async {
        use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode, decode_header, jwk::Jwk};
        let config = ConnectConfig::load(home)?
            .ok_or_else(|| Error::new(4231, "Hex Connect is not set up on this daemon"))?;
        let invalid = || Error::new(4231, "invalid Hex Connect grant");
        let header = decode_header(grant).map_err(|_| invalid())?;
        if header.alg != Algorithm::ES256 || header.typ.as_deref() != Some("hexbot-grant+jwt") {
            return Err(invalid());
        }
        let kid = header.kid.ok_or_else(invalid)?;
        let pin = config
            .keys
            .iter()
            .find(|key| key["kid"] == kid && key["kty"] == "EC" && key["crv"] == "P-256")
            .ok_or_else(invalid)?;
        let published = published_keys(home, &config, &kid).await?;
        if !published.iter().any(|key| {
            ["kid", "kty", "crv", "x", "y"]
                .iter()
                .all(|field| key[*field].is_string() && key[*field] == pin[*field])
        }) {
            return Err(invalid());
        }
        let jwk: Jwk = serde_json::from_value(pin.clone()).map_err(|_| invalid())?;
        let key = DecodingKey::from_jwk(&jwk).map_err(|_| invalid())?;
        let mut validation = Validation::new(Algorithm::ES256);
        validation.set_required_spec_claims(&["sub", "exp", "iat", "aud", "iss"]);
        validation.set_audience(&[&config.daemon_id]);
        validation.set_issuer(&[&config.issuer]);
        validation.leeway = 60;
        let claims = decode::<Value>(grant, &key, &validation)
            .map_err(|_| invalid())?
            .claims;
        if claims["iss"] != config.issuer
            || claims["aud"] != config.daemon_id
            || claims["sub"] != config.owner_id
            || claims["daemon_id"] != config.daemon_id
            || claims["iat"]
                .as_f64()
                .is_none_or(|iat| iat - 60. > common::now())
            || claims["exp"]
                .as_f64()
                .is_none_or(|exp| exp + 60. <= common::now())
        {
            return Err(invalid());
        }
        let jti = claims["jti"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or_else(invalid)?;
        let name = claims["device_name"]
            .as_str()
            .ok_or_else(invalid)?
            .trim()
            .chars()
            .take(80)
            .collect::<String>();
        if name.is_empty() {
            return Err(invalid());
        }
        if let Some(cnf) = claims.get("cnf") {
            let jkt = cnf["jkt"]
                .as_str()
                .filter(|jkt| !jkt.is_empty())
                .ok_or_else(invalid)?;
            if proof_jkt.is_none() {
                return Err(Error::new(crate::dpop::REQUIRED, "device proof required"));
            }
            if proof_jkt != Some(jkt) {
                return Err(Error::new(
                    crate::dpop::KEY_MISMATCH,
                    "device proof key does not match",
                ));
            }
        }
        crate::auth::redeem_verified_grant(
            home,
            &name,
            platform,
            jti,
            claims["exp"].as_f64().ok_or_else(invalid)?,
            proof_jkt,
        )
    }
    .await;
    check.map_err(|error| {
        if crate::dpop::error_code(error.code).is_some() {
            error
        } else {
            Error::new(4231, "invalid Hex Connect grant")
        }
    })
}

pub async fn exchange_browser_grant(
    home: &Path,
    config: &ConnectConfig,
    code: &str,
    verifier: &str,
    redirect_uri: &str,
) -> Result<String> {
    let result = daemon_request(
        home,
        config,
        Method::POST,
        "/api/grants/exchange",
        Some(json!({"code":code,"code_verifier":verifier,"redirect_uri":redirect_uri})),
    )
    .await?;
    Ok(common::required(&result, "grant")?.to_owned())
}

fn capability() -> Option<String> {
    std::env::var("HEXBOT_SUPERVISOR")
        .ok()
        .filter(|v| matches!(v.as_str(), "desktop" | "service"))
}
fn valid_version(version: &str) -> bool {
    let (numbers, suffix) = version
        .split_once('-')
        .map_or((version, None), |(v, s)| (v, Some(s)));
    let pieces = numbers.split('.').collect::<Vec<_>>();
    semver::Version::parse(version).is_ok()
        && pieces.len() == 3
        && pieces
            .iter()
            .all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()))
        && suffix.is_none_or(|s| {
            !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.')
        })
}
fn require_newer_native_build(requested: &Value, current: &Value) -> Result<()> {
    // Match desktop bootstrap: source chronology decides across update tracks.
    // A runtime predating builtAt has chronology zero.
    let built_at = |manifest: &Value| manifest["builtAt"].as_u64().unwrap_or(0);
    if built_at(requested) <= built_at(current) {
        return Err(Error::new(
            4212,
            "The daemon already runs this build or a newer one.",
        ));
    }
    Ok(())
}
fn native_manifest(executable: &Path, version: &str) -> Value {
    executable
        .parent()
        .and_then(|directory| fs::read(directory.join("manifest.json")).ok())
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .filter(|manifest| manifest["version"] == version)
        .unwrap_or_else(|| json!({}))
}
async fn update_status(home: &Path) -> Result<Value> {
    let service = service(home).await?;
    let data = service.data.lock().await;
    let mut current = data.update.clone();
    let capability = capability();
    if capability.as_deref() == Some("desktop")
        && current["status"] != "idle"
        && let Ok(bytes) = fs::read(home.join("runtime/update-status.json"))
        && let Ok(raw) = serde_json::from_slice::<Value>(&bytes)
        && raw["status"].is_string()
    {
        let before = raw["at"]
            .as_str()
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .zip(
                current["at"]
                    .as_str()
                    .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok()),
            )
            .is_some_and(|(a, b)| a < b);
        if !before {
            for key in ["status", "percent", "message", "version", "at"] {
                current[key] = raw[key].clone();
            }
        }
    }
    current["capability"] = json!(capability);
    Ok(current)
}
async fn update_state(
    service: &Service,
    status: &str,
    version: Option<&str>,
    message: Option<&str>,
) {
    let mut data = service.data.lock().await;
    data.update["status"] = json!(status);
    data.update["at"] = json!(chrono::Utc::now().to_rfc3339());
    data.update["message"] = json!(message);
    if let Some(version) = version {
        data.update["version"] = json!(version);
    }
}
pub(crate) fn native_directory(home: &Path) -> Result<PathBuf> {
    let mut directory = home.canonicalize()?;
    for part in ["runtime", "native"] {
        directory.push(part);
        match fs::symlink_metadata(&directory) {
            Ok(metadata) if metadata.file_type().is_dir() => {}
            Ok(_) => {
                return Err(Error::new(
                    5243,
                    "native runtime directory must not be a symlink or file",
                ));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir(&directory)?
            }
            Err(error) => return Err(error.into()),
        }
    }
    Ok(directory)
}

// Preserve the selected runtime, its predecessor, and any daemon still using an
// older runtime. Directory names may include the updater's random suffix.
fn prune_native(
    native: &Path,
    active: &Path,
    previous: Option<&Path>,
    running: Option<&Path>,
) -> Result<()> {
    for entry in fs::read_dir(native)? {
        let entry = entry?;
        let path = entry.path();
        if !entry.file_type()?.is_dir()
            || !path.join("hexbot").is_file()
            || entry.file_name().to_string_lossy().starts_with('.')
            || entry.file_name().to_string_lossy().contains(".staging-")
        {
            continue;
        }
        if [Some(active), previous, running]
            .into_iter()
            .flatten()
            .any(|exe| exe.parent() == Some(path.as_path()))
        {
            continue;
        }
        fs::remove_dir_all(path)?;
    }
    Ok(())
}

/// Retry deferred cleanup after restart, when the former daemon no longer uses
/// its bundle. Called only after this process holds the home lock.
pub fn prune_current_native(home: &Path) -> Result<()> {
    let runtime = home.join("runtime");
    if !runtime.is_dir() {
        return Ok(());
    }
    let _lock = activation_lock(&runtime)?;
    let metadata = match fs::read(runtime.join("native-current.json")) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    let metadata: Value =
        serde_json::from_slice(&metadata).map_err(|error| Error::new(5243, error.to_string()))?;
    let active = runtime.join("native-executable").canonicalize()?;
    let native = native_directory(home)?;
    if !active.starts_with(&native) {
        return Err(Error::new(5243, "invalid native runtime selection"));
    }
    let previous = metadata["previous"].as_str().map(Path::new);
    let running = std::env::current_exe().ok();
    prune_native(&native, &active, previous, running.as_deref())
}

// Unknown running state defers cleanup. Setup can run from a different bundle
// than the daemon which still owns this home's lock.
fn recorded_native_runtime(native: &Path) -> Result<Option<PathBuf>> {
    use std::os::fd::AsRawFd;
    let runtime = native
        .parent()
        .ok_or_else(|| Error::new(5243, "Missing runtime directory"))?;
    let home = runtime
        .parent()
        .ok_or_else(|| Error::new(5243, "Missing home"))?;
    let locked = match fs::File::open(home.join("native-daemon.lock")) {
        Ok(file) => unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) != 0 },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
        Err(e) => return Err(e.into()),
    };
    let bytes = match fs::read(runtime.join("native-running.json")) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound && !locked => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    let record: Value =
        serde_json::from_slice(&bytes).map_err(|e| Error::new(5243, e.to_string()))?;
    let pid = record["pid"]
        .as_i64()
        .filter(|pid| *pid > 0 && *pid <= i32::MAX as i64)
        .ok_or_else(|| Error::new(5243, "Invalid running daemon PID"))? as i32;
    let alive = unsafe { libc::kill(pid, 0) } == 0
        || std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH);
    if !alive && !locked {
        return Ok(None);
    }
    if !alive {
        return Err(Error::new(5243, "Daemon lock owner is unknown"));
    }
    let executable = Path::new(
        record["executable"]
            .as_str()
            .ok_or_else(|| Error::new(5243, "Missing running daemon executable"))?,
    )
    .canonicalize()?;
    if !executable.starts_with(native) {
        return Err(Error::new(
            5243,
            "Running daemon is outside the native runtime directory",
        ));
    }
    Ok(Some(executable))
}

pub(crate) fn activation_lock(runtime: &Path) -> Result<fs::File> {
    use std::os::fd::AsRawFd;
    let file = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(runtime.join("activate.lock"))?;
    loop {
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) } == 0 {
            return Ok(file);
        }
        let error = std::io::Error::last_os_error();
        if error.kind() != std::io::ErrorKind::Interrupted {
            return Err(error.into());
        }
    }
}

// Staging directories remain hidden from pruning until the activation lock is held.
pub(crate) fn publish_native(
    native: &Path,
    version: &str,
    staging: &Path,
    entrypoint: &str,
) -> Result<PathBuf> {
    let _lock = activation_lock(
        native
            .parent()
            .ok_or_else(|| Error::new(5243, "Missing runtime directory"))?,
    )?;
    let directory = native.join(format!("{version}-{}", common::id()));
    fs::rename(staging, &directory)?;
    let executable = directory.join(entrypoint);
    activate_native_locked(native, version, &executable)?;
    Ok(executable)
}

#[cfg(test)]
fn activate_native(native: &Path, version: &str, executable: &Path) -> Result<()> {
    let _lock = activation_lock(native.parent().unwrap())?;
    activate_native_locked(native, version, executable)
}

fn activate_native_locked(native: &Path, version: &str, executable: &Path) -> Result<()> {
    let runtime = native
        .parent()
        .ok_or_else(|| Error::new(5243, "invalid native runtime directory"))?;
    let executable = executable.canonicalize()?;
    if !executable.starts_with(native) || !executable.is_file() {
        return Err(Error::new(
            5243,
            "native update launcher escaped its runtime directory",
        ));
    }
    let stable = runtime.join("native-executable");
    let previous = stable.canonicalize().ok();
    // Replacing a symlink never follows its previous target. A directory cannot
    // be replaced this way and must be rejected before updating the metadata.
    if fs::symlink_metadata(&stable).is_ok_and(|m| m.file_type().is_dir()) {
        return Err(Error::new(
            5243,
            "native executable pointer must not be a directory",
        ));
    }
    #[cfg(unix)]
    let staged_link = {
        let temporary = tempfile::tempdir_in(runtime)?;
        std::os::unix::fs::symlink(&executable, temporary.path().join("launcher"))?;
        temporary
    };
    let manifest = native_manifest(&executable, version);
    common::atomic_write(
        &runtime.join("native-current.json"),
        &serde_json::to_vec(
            &json!({"version":version,"executable":executable,"previous":previous,"files":manifest["files"]}),
        )
        .unwrap(),
    )?;
    #[cfg(unix)]
    {
        fs::rename(staged_link.path().join("launcher"), stable)?;
        fs::File::open(runtime)?.sync_all()?;
    }
    let running = match recorded_native_runtime(native) {
        Ok(recorded) => recorded.or_else(|| std::env::current_exe().ok()),
        Err(error) => {
            eprintln!("Runtime cleanup deferred: {error}");
            return Ok(());
        }
    };
    // Activation has committed. Cleanup failure must not turn it into a failed update.
    if let Err(error) = prune_native(native, &executable, previous.as_deref(), running.as_deref()) {
        eprintln!("Runtime cleanup: {error}");
    }
    Ok(())
}

#[cfg(all(test, unix))]
mod activation_tests {
    use super::*;
    use std::os::unix::fs::{PermissionsExt, symlink};

    #[test]
    fn concurrent_publications_keep_selection_and_metadata_together() {
        use std::{
            os::fd::AsRawFd,
            sync::{Arc, Barrier},
            thread,
        };
        let home = tempfile::tempdir().unwrap();
        let native = native_directory(home.path()).unwrap();
        let runtime = native.parent().unwrap();
        let lock = activation_lock(runtime).unwrap();
        let contender = fs::File::open(runtime.join("activate.lock")).unwrap();
        assert_ne!(
            unsafe { libc::flock(contender.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
            0
        );
        drop(lock);
        assert_eq!(
            unsafe { libc::flock(contender.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
            0
        );
        drop(contender);
        let barrier = Arc::new(Barrier::new(8));
        thread::scope(|scope| {
            for version in 0..8 {
                let native = &native;
                let barrier = barrier.clone();
                scope.spawn(move || {
                    let staging = tempfile::tempdir_in(native).unwrap();
                    fs::write(staging.path().join("hexbot"), version.to_string()).unwrap();
                    barrier.wait();
                    publish_native(native, &version.to_string(), staging.path(), "hexbot").unwrap();
                });
            }
        });
        let metadata: Value =
            serde_json::from_slice(&fs::read(runtime.join("native-current.json")).unwrap())
                .unwrap();
        let active = runtime.join("native-executable").canonicalize().unwrap();
        assert_eq!(active.to_str(), metadata["executable"].as_str());
        assert_eq!(
            fs::read_to_string(&active).unwrap(),
            metadata["version"].as_str().unwrap()
        );
        assert!(Path::new(metadata["previous"].as_str().unwrap()).is_file());
        assert_eq!(fs::read_dir(&native).unwrap().count(), 2);
    }

    #[test]
    fn service_pointer_follows_consecutive_updates_and_keeps_one_predecessor() {
        let home = tempfile::tempdir().unwrap();
        let native = native_directory(home.path()).unwrap();
        let runtime = native.parent().unwrap();
        let stable = runtime.join("native-executable");
        let outside = home.path().join("unrelated");
        fs::write(&outside, "keep me").unwrap();
        symlink(&outside, &stable).unwrap();
        for version in ["9.8.7", "9.8.8", "9.8.9"] {
            let directory = native.join(version);
            fs::create_dir(&directory).unwrap();
            let executable = directory.join("hexbot");
            fs::write(&executable, format!("#!/bin/sh\nprintf '{version}\\n'\n")).unwrap();
            fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
            let files = json!({"node": format!("signed-node-{version}"), "hexbot-core": format!("signed-daemon-{version}")});
            fs::write(
                directory.join("manifest.json"),
                serde_json::to_vec(&json!({"version": version, "builtAt": 300, "files": files}))
                    .unwrap(),
            )
            .unwrap();
            activate_native(&native, version, &executable).unwrap();
            let output = std::process::Command::new(&stable)
                .arg("version")
                .output()
                .unwrap();
            assert!(output.status.success());
            assert_eq!(String::from_utf8(output.stdout).unwrap().trim(), version);
            let metadata: Value =
                serde_json::from_slice(&fs::read(runtime.join("native-current.json")).unwrap())
                    .unwrap();
            assert_eq!(metadata["version"], version);
            assert_eq!(metadata["files"], files);
            assert_eq!(stable.canonicalize().unwrap(), executable);
        }
        assert_eq!(fs::read_to_string(outside).unwrap(), "keep me");
        assert!(!native.join("9.8.7").exists());
        assert!(native.join("9.8.8/hexbot").is_file());
    }

    #[test]
    fn pruning_keeps_active_previous_and_running_and_failed_activation_keeps_all() {
        let home = tempfile::tempdir().unwrap();
        let native = native_directory(home.path()).unwrap();
        let executables: Vec<_> = ["1.0.0-first", "2.0.0-second", "3.0.0-third", "4.0.0-fourth"]
            .into_iter()
            .map(|name| {
                let directory = native.join(name);
                fs::create_dir(&directory).unwrap();
                let executable = directory.join("hexbot");
                fs::write(&executable, "runtime").unwrap();
                executable
            })
            .collect();
        assert!(activate_native(&native, "bad", &native.join("missing")).is_err());
        assert!(executables.iter().all(|exe| exe.is_file()));
        prune_native(
            &native,
            &executables[3],
            Some(&executables[2]),
            Some(&executables[0]),
        )
        .unwrap();
        assert!(executables[0].is_file());
        assert!(!executables[1].exists());
        assert!(executables[2].is_file());
        assert!(executables[3].is_file());
        prune_native(
            &native,
            &executables[3],
            Some(&executables[2]),
            Some(&executables[3]),
        )
        .unwrap();
        assert!(!executables[0].exists());
    }

    #[test]
    fn setup_activation_preserves_recorded_live_daemon_across_updates() {
        let home = tempfile::tempdir().unwrap();
        let native = native_directory(home.path()).unwrap();
        let runtime = native.parent().unwrap();
        for version in ["1", "2", "3", "4"] {
            let dir = native.join(version);
            fs::create_dir(&dir).unwrap();
            fs::write(dir.join("hexbot"), "runtime").unwrap();
            activate_native(&native, version, &dir.join("hexbot")).unwrap();
            if version == "1" {
                fs::write(
                    runtime.join("native-running.json"),
                    json!({"pid":std::process::id(),"executable":dir.join("hexbot")}).to_string(),
                )
                .unwrap();
            }
        }
        assert!(native.join("1/hexbot").exists());
        assert!(!native.join("2").exists());
        assert!(native.join("3/hexbot").exists());
        assert!(native.join("4/hexbot").exists());
        fs::write(runtime.join("native-running.json"), "invalid").unwrap();
        let dir = native.join("5");
        fs::create_dir(&dir).unwrap();
        fs::write(dir.join("hexbot"), "runtime").unwrap();
        activate_native(&native, "5", &dir.join("hexbot")).unwrap();
        assert!(native.join("1/hexbot").exists());
        assert!(native.join("3/hexbot").exists());
    }

    #[test]
    fn pruning_defers_when_lock_is_held_without_a_running_record() {
        use std::os::fd::AsRawFd;
        let home = tempfile::tempdir().unwrap();
        let native = native_directory(home.path()).unwrap();
        let lock = fs::File::create(home.path().join("native-daemon.lock")).unwrap();
        assert_eq!(
            unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
            0
        );
        for version in ["1", "2", "3"] {
            let dir = native.join(version);
            fs::create_dir(&dir).unwrap();
            fs::write(dir.join("hexbot"), "runtime").unwrap();
            activate_native(&native, version, &dir.join("hexbot")).unwrap();
        }
        assert!(native.join("1/hexbot").exists());
        assert!(native.join("2/hexbot").exists());
    }

    #[test]
    fn activation_refuses_escaped_directories_and_invalid_pointers() {
        let home = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        symlink(outside.path(), home.path().join("runtime")).unwrap();
        assert!(native_directory(home.path()).is_err());
        fs::remove_file(home.path().join("runtime")).unwrap();
        let native = native_directory(home.path()).unwrap();
        let runtime = native.parent().unwrap();
        let escaped = outside.path().join("hexbot");
        fs::write(&escaped, "keep me").unwrap();
        symlink(&escaped, native.join("hexbot")).unwrap();
        assert!(activate_native(&native, "9.8.7", &native.join("hexbot")).is_err());
        fs::write(native.join("valid"), "valid").unwrap();
        fs::create_dir(runtime.join("native-executable")).unwrap();
        assert!(activate_native(&native, "9.8.7", &native.join("valid")).is_err());
        assert!(!runtime.join("native-current.json").exists());
        assert_eq!(fs::read_to_string(escaped).unwrap(), "keep me");
    }
}

pub(crate) fn file_sha256(path: &Path) -> Result<String> {
    let mut hash = Sha256::new();
    let mut source = fs::File::open(path)?;
    let mut chunk = [0; 65536];
    loop {
        let n = source.read(&mut chunk)?;
        if n == 0 {
            break;
        }
        hash.update(&chunk[..n]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

pub(crate) fn extract_archive(source: &Path, destination: &Path, limit: u64) -> Result<()> {
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(fs::File::open(source)?));
    let mut size = 0u64;
    for entry in archive.entries()? {
        let mut entry = entry?;
        let path = entry.path()?.into_owned();
        if path.components().any(|part| {
            !matches!(
                part,
                std::path::Component::Normal(_) | std::path::Component::CurDir
            )
        }) || (!entry.header().entry_type().is_file() && !entry.header().entry_type().is_dir())
        {
            return Err(Error::new(5243, "unsafe entry in native update archive"));
        }
        size = size
            .checked_add(entry.size())
            .ok_or_else(|| Error::new(5243, "native update archive exceeds byte limit"))?;
        if size > limit {
            return Err(Error::new(5243, "native update archive exceeds byte limit"));
        }
        if !entry.unpack_in(destination)? {
            return Err(Error::new(
                5243,
                "native update archive escaped destination",
            ));
        }
    }
    Ok(())
}

/// A native update manifest with its release signature (`<url>.sig`) checked
/// before anything in it is trusted.
async fn signed_manifest(url: &str) -> Result<Value> {
    service_url(url)?;
    let fetch = |url: String, limit: usize| async move {
        let response = client()?
            .get(&url)
            .send()
            .await
            .map_err(|_| Error::new(5243, "native update manifest unavailable"))?;
        if !response.status().is_success() {
            return Err(Error::new(
                5243,
                format!(
                    "native update manifest returned HTTP {}",
                    response.status().as_u16()
                ),
            ));
        }
        crate::http::bytes(
            response,
            limit,
            |_| Error::new(5243, "native update manifest interrupted"),
            Error::new(5243, "native update manifest exceeds byte limit"),
        )
        .await
    };
    let manifest = fetch(url.to_owned(), 1024 * 1024).await?;
    let signature = fetch(
        format!("{url}.sig"),
        crate::update_signature::SIGNATURE_LIMIT,
    )
    .await?;
    if !crate::update_signature::verify(&manifest, &signature) {
        return Err(Error::new(5243, crate::update_signature::INVALID));
    }
    serde_json::from_slice(&manifest)
        .map_err(|_| Error::new(5243, "native update manifest is invalid JSON"))
}

async fn native_update(home: &Path, version: &str, service: &Service) -> Result<PathBuf> {
    let config = common::read_config(home)?;
    let base = config
        .pointer("/updates/base_url")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| std::env::var("HEXBOT_UPDATE_URL").ok())
        .unwrap_or_else(|| UPDATE_URL.into());
    service_url(&base)?;
    let target = format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH);
    update_state(service, "checking", None, None).await;
    let manifest = signed_manifest(&format!(
        "{}/daemon/native/{version}/{target}/manifest.json",
        base.trim_end_matches('/')
    ))
    .await?;
    if manifest["version"] != version || manifest["target"] != target {
        return Err(Error::new(
            5243,
            "native update manifest does not match this daemon",
        ));
    }
    let current = std::env::current_exe()
        .map(|executable| native_manifest(&executable, &crate::version()))
        .unwrap_or_else(|_| json!({}));
    require_newer_native_build(&manifest, &current)?;
    let url = artifact_url(&base, common::required(&manifest, "url")?)?;
    let digest = common::required(&manifest, "sha256")?;
    if digest.len() != 64 || !digest.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(Error::new(5243, "invalid native update checksum"));
    }
    let native = native_directory(home)?;
    let staging = tempfile::tempdir_in(&native)?;
    let tmp = tempfile::NamedTempFile::new_in(&native)?;
    update_state(service, "downloading", None, None).await;
    download(url.as_str(), tmp.path(), 1024 * 1024 * 1024, false).await?;
    if file_sha256(tmp.path())? != digest.to_ascii_lowercase() {
        return Err(Error::new(5243, "native update checksum mismatch"));
    }
    update_state(service, "installing", None, None).await;
    let entrypoint = manifest
        .get("entrypoint")
        .and_then(Value::as_str)
        .unwrap_or("hexbot");
    common::identifier(entrypoint)?;
    if manifest["format"] == "tar.gz" {
        extract_archive(tmp.path(), staging.path(), 4 * 1024 * 1024 * 1024)?;
    } else if manifest["format"].is_null() || manifest["format"] == "binary" {
        fs::copy(tmp.path(), staging.path().join(entrypoint))?;
    } else {
        return Err(Error::new(5243, "unsupported native update format"));
    }
    let staged_executable = staging.path().join(entrypoint);
    if !staged_executable.is_file() {
        return Err(Error::new(5243, "native update entrypoint missing"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&staged_executable, fs::Permissions::from_mode(0o700))?;
    }
    let mut child = Command::new(&staged_executable)
        .arg("version")
        .env("HEXBOT_HOME", home)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()?;
    let checked = tokio::time::timeout(Duration::from_secs(15), async {
        use tokio::io::AsyncReadExt;
        let mut output = Vec::new();
        child
            .stdout
            .take()
            .ok_or_else(|| Error::new(5243, "version check stdout missing"))?
            .take(4097)
            .read_to_end(&mut output)
            .await?;
        if output.len() > 4096 {
            return Err(Error::new(5243, "version check exceeded output limit"));
        }
        Ok::<_, Error>((child.wait().await?, output))
    })
    .await;
    let (exit, output) = match checked {
        Ok(Ok(result)) => result,
        Ok(Err(error)) => {
            terminate(&mut child).await;
            return Err(error);
        }
        Err(_) => {
            terminate(&mut child).await;
            return Err(Error::new(5243, "updated daemon version check timed out"));
        }
    };
    if !exit.success() || String::from_utf8_lossy(&output).trim() != version {
        return Err(Error::new(
            5243,
            "updated daemon version does not match request",
        ));
    }
    publish_native(&native, version, staging.path(), entrypoint)
}

/// CLI registration persists credentials without starting a tunnel outside the daemon.
pub async fn register_poll(home: &Path, code: &str, start_tunnel: bool) -> Result<Value> {
    let base = api_base(home)?;
    let identity_private_key = new_identity_key()?;
    let key_bytes = URL_SAFE_NO_PAD
        .decode(&identity_private_key)
        .expect("generated key");
    let key = Ed25519KeyPair::from_pkcs8(&key_bytes).expect("generated key");
    let public_key = URL_SAFE_NO_PAD.encode(key.public_key().as_ref());
    let reply = object(
        Method::POST,
        &format!("{base}/api/register/poll"),
        None,
        Some(json!({"device_code":code,"public_key":public_key})),
    )
    .await;
    // Older Connect uses a strict poll schema, rather than ignoring new fields.
    let mut result = match reply {
        Err(error)
            if error.data.as_ref().is_some_and(|data| {
                data["status"] == 400 && data["error"] == "invalid_request"
            }) =>
        {
            object(
                Method::POST,
                &format!("{base}/api/register/poll"),
                None,
                Some(json!({"device_code":code})),
            )
            .await?
        }
        other => other?,
    };
    let status = result["status"]
        .as_str()
        .unwrap_or(if result["daemon_token"].as_str().is_some() {
            "approved"
        } else {
            "pending"
        })
        .to_owned();
    result["status"] = json!(status);
    if status == "approved" {
        let config = ConnectConfig {
            owner_id: common::required(&result, "owner_id")?.into(),
            issuer: common::required(&result, "issuer")?.into(),
            keys: result["keys"]
                .as_array()
                .filter(|keys| !keys.is_empty())
                .ok_or_else(|| {
                    Error::new(5241, "Hex Connect registration is missing signing keys")
                })?
                .clone(),
            api_base: base.clone(),
            daemon_id: common::required(&result, "daemon_id")?.into(),
            daemon_token: common::required(&result, "daemon_token")?.into(),
            slug: common::required(&result, "slug")?.into(),
            tunnel_hostname: common::required(&result, "tunnel_hostname")?.into(),
            tunnel_token: common::required(&result, "tunnel_token")?.into(),
            registered_at: Some(common::now()),
            jwks_url: format!("{base}/.well-known/jwks.json"),
        };
        common::identifier(&config.daemon_id)?;
        {
            // Under the lifecycle lock, so a registration being dropped (revoked, or
            // disconnected) cannot interleave with this one being written.
            let service = service(home).await?;
            let _operation = service.lifecycle.lock().await;
            apply_public_url(home, Some(&config.tunnel_hostname))?;
            // Old daemons may rewrite connect.json during tunnel repair. The key
            // lives separately so a rollback cannot erase it.
            common::atomic_write(&home.join(IDENTITY_FILE), identity_private_key.as_bytes())?;
            config.save(home)?;
            if let Some(task) = service.identity_task.lock().await.take() {
                task.abort();
            }
            *service.identity.lock().await = Some(CachedIdentity {
                daemon_id: config.daemon_id.clone(),
                key: Some(Arc::new(key)),
            });
            service
                .data
                .lock()
                .await
                .identity_attempted
                .insert(config.daemon_id.clone());
            identity_error(&service, None).await;
            service.data.lock().await.error = None;
        }
        if start_tunnel {
            let port = service(home).await?.data.lock().await.port;
            if let Err(error) = start_daemon(home, port).await {
                service(home).await?.data.lock().await.error = Some(error.message.clone());
                return Err(error);
            }
        }
    }
    Ok(json!({"status":status}))
}

pub async fn call(home: &Path, caller: &str, method: &str, p: &Value) -> Option<Result<Value>> {
    if !matches!(
        method,
        "hexbot.connect.status"
            | "hexbot.connect.disconnect"
            | "hexbot.connect.register_start"
            | "hexbot.connect.register_poll"
            | "hexbot.update.request"
            | "hexbot.update.status"
    ) {
        return None;
    }
    Some(
        async {
            if method == "hexbot.update.status" {
                common::user(home, caller)?;
            } else {
                common::admin(home, caller)?;
            }
            match method {
                "hexbot.connect.status" => connect_status(home).await,
                "hexbot.connect.register_start" => {
                    if ConnectConfig::load(home)?.is_some_and(|c| !c.daemon_id.is_empty()) {
                        return Err(Error::new(
                            4240,
                            "Already connected to Hex Connect. Disconnect first to register again.",
                        ));
                    }
                    let base = api_base(home)?;
                    object(
                        Method::POST,
                        &format!("{base}/api/register/start"),
                        None,
                        Some(json!({
                            "daemon_name": p["daemon_name"].as_str().unwrap_or("Hexbot"),
                            "platform": if cfg!(target_os = "macos") {
                                "darwin"
                            } else {
                                std::env::consts::OS
                            }
                        })),
                    )
                    .await
                }
                "hexbot.connect.register_poll" => {
                    register_poll(home, common::required(p, "device_code")?, true).await
                }
                "hexbot.connect.disconnect" => {
                    let service = service(home).await?;
                    drop_registration(home, &service, None, None, true).await?;
                    connect_status(home).await
                }
                "hexbot.update.status" => update_status(home).await,
                "hexbot.update.request" => {
                    let version = common::required(p, "version")?;
                    if !valid_version(version) {
                        return Err(Error::new(4200, "invalid parameter: version"));
                    }
                    let method = capability().ok_or_else(|| {
                        Error::new(
                            4210,
                            "This daemon cannot update itself. Update Hexbot on its machine.",
                        )
                    })?;
                    if version == crate::version() {
                        return Err(Error::new(
                            4212,
                            format!("The daemon already runs {version}"),
                        ));
                    }
                    let service = service(home).await?;
                    let mut data = service.data.lock().await;
                    if matches!(data.update["status"].as_str(),
    Some("requested"|"checking"|"downloading"|"installing"|"restarting")) {
                        return Err(Error::new(4211, "A daemon update is already in progress"));
                    }
                    data.update = json!({"status":"requested","requested":version,"version":null,"message":null,"percent":null,"at":chrono::Utc::now().to_rfc3339()});
                    if method == "desktop" {
                        match fs::remove_file(home.join("runtime/update-status.json")) {
                            Ok(()) => {}
                            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                            Err(e) => return Err(e.into()),
                        }
                        println!("HEXBOT_UPDATE_REQUESTED version={version}");
                        let _ = std::io::stdout().flush();
                    } else {
                        let home = home.to_owned();
                        let version = version.to_owned();
                        let worker_service = service.clone();
                        data.update_task = Some(tokio::spawn(async move {
                            match native_update(&home, &version, &worker_service).await {
                                Ok(executable) => {
                                    update_state(
                                        &worker_service,
                                        "restarting",
                                        Some(&version),
                                        None,
                                    )
                                    .await;
                                    worker_service.data.lock().await.restart = Some(executable);
                                }
                                Err(error) => {
                                    update_state(
                                        &worker_service,
                                        "failed",
                                        None,
                                        Some(&error.message),
                                    )
                                    .await
                                }
                            }
                        }));
                    }
                    Ok(json!({"accepted":true,"method":method,"version":version}))
                }
                _ => unreachable!(),
            }
        }
        .await,
    )
}

#[cfg(all(test, unix))]
#[path = "../tests/fixtures/connect_tunnel.rs"]
mod tunnel_tests;

#[cfg(test)]
mod cloudflared_tests {
    use super::*;
    #[test]
    fn digest_mismatch_and_stale_cached_executable() {
        let home = tempfile::tempdir().unwrap();
        let asset = home.path().join("asset");
        let binary = home.path().join("cloudflared-2026.8.0");
        let bytes = b"verified fixture executable";
        fs::write(&asset, bytes).unwrap();
        let digest = format!("{:x}", Sha256::digest(bytes));
        assert!(verified_cloudflared(&asset, "wrong", false).is_err());
        let verified = verified_cloudflared(&asset, &digest, false).unwrap();
        fs::write(&binary, b"unverified old binary").unwrap();
        install_cloudflared(&binary, &verified).unwrap();
        assert_eq!(fs::read(&binary).unwrap(), bytes);
        fs::write(&binary, b"tampered cached binary").unwrap();
        install_cloudflared(&binary, &verified).unwrap();
        assert_eq!(fs::read(&binary).unwrap(), bytes);
        fs::write(&asset, b"tampered cached asset").unwrap();
        assert!(verified_cloudflared(&asset, &digest, false).is_err());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&binary).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
    }
}

#[cfg(test)]
mod native_version_tests {
    use super::*;
    #[test]
    fn chronology_comes_from_the_running_bundle_not_the_selected_update() {
        let home = tempfile::tempdir().unwrap();
        let executable = home.path().join("hexbot-core");
        fs::write(
            home.path().join("manifest.json"),
            br#"{"version":"0.1.6-nightly.20260930.1","builtAt":200}"#,
        )
        .unwrap();
        let current = native_manifest(&executable, "0.1.6-nightly.20260930.1");
        assert_eq!(current["builtAt"], 200);
        assert!(
            require_newer_native_build(&json!({"version":"0.1.6-alpha.2","builtAt":300}), &current)
                .is_ok()
        );
        assert!(
            require_newer_native_build(&json!({"version":"0.1.7","builtAt":100}), &current)
                .is_err()
        );
        assert_eq!(native_manifest(&executable, "wrong-version"), json!({}));
        assert!(!valid_version("0.1.6-alpha.01"));
    }

    #[test]
    fn native_updates_use_chronology_in_both_directions_across_tracks() {
        for (requested, current) in [
            ("0.1.6-alpha.2", "0.1.6-nightly.20260930.1"),
            ("0.1.6-nightly.20261001.1", "0.1.6-alpha.2"),
            ("0.1.6-alpha.3", "0.1.6-alpha.2"),
            ("0.1.6-nightly.20261001.2", "0.1.6-nightly.20261001.1"),
        ] {
            let newer = json!({"version": requested, "builtAt": 300});
            let older = json!({"version": current, "builtAt": 200});
            assert!(require_newer_native_build(&newer, &older).is_ok());
            assert_eq!(
                require_newer_native_build(&older, &newer).unwrap_err().code,
                4212
            );
            assert_eq!(
                require_newer_native_build(&newer, &newer).unwrap_err().code,
                4212
            );
        }
        assert!(require_newer_native_build(&json!({"builtAt": 1}), &json!({})).is_ok());
        assert!(require_newer_native_build(&json!({}), &json!({"builtAt": 1})).is_err());
    }

    #[test]
    fn native_archives_are_fetched_from_the_configured_update_server() {
        let path = "daemon/native/1.2.3/linux-x86_64/bundle.tar.gz";
        for base in ["https://mirror.example", "https://mirror.example/hexbot/"] {
            let expected = format!("{}/{path}", base.trim_end_matches('/'));
            assert_eq!(artifact_url(base, path).unwrap().as_str(), expected);
            assert_eq!(artifact_url(base, &expected).unwrap().as_str(), expected);
            for location in [
                "",
                "https://attacker.example/binary",
                "//attacker.example/binary",
                "http://mirror.example/binary",
                "https://user@mirror.example/binary",
            ] {
                assert!(artifact_url(base, location).is_err());
            }
        }
        assert!(artifact_url("http://mirror.example", "binary").is_err());
    }
}
