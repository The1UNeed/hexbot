//! Connect registration, tunnel lifecycle, grant verification and native updates.
use crate::{Error, Result, common};
use reqwest::{Client, Method};
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
}
impl ConnectConfig {
    pub fn load(home: &Path) -> Result<Option<Self>> {
        match fs::read(home.join("connect.json")) {
            Ok(bytes) => {
                let mut config: Self = serde_json::from_slice(&bytes)
                    .map_err(|_| Error::new(5241, "invalid Connect configuration"))?;
                config.api_base = config.api_base.trim_end_matches('/').to_owned();
                service_url(&config.api_base)?;
                if config.jwks_url.is_empty() {
                    config.jwks_url = format!("{}/.well-known/jwks.json", config.api_base);
                }
                same_origin(&config.api_base, &config.jwks_url)?;
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
                .map_err(|_| Error::new(5241, "invalid Connect configuration"))?,
        )
    }
}

struct Workers {
    stop: watch::Sender<bool>,
    tasks: Vec<JoinHandle<()>>,
}
struct Data {
    running: bool,
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
            heartbeat: None,
            error: None,
            port: 9119,
            update: json!({"status":"idle","requested":null,"version":null,"message":null,"percent":null,"at":null}),
            update_task: None,
            restart: None,
        }
    }
}
#[derive(Default)]
struct Service {
    data: Mutex<Data>,
    workers: Mutex<Option<Workers>>,
    lifecycle: Mutex<()>,
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
    Client::builder()
        .timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| Error::new(5241, "could not create HTTP client"))
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
    let mut response = request
        .send()
        .await
        .map_err(|_| Error::new(5241, "Connect service unreachable"))?;
    if !response.status().is_success() {
        return Err(Error::new(
            5241,
            format!(
                "Connect service returned HTTP {}",
                response.status().as_u16()
            ),
        ));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| Error::new(5241, "Connect response failed"))?
    {
        if bytes.len() + chunk.len() > 1024 * 1024 {
            return Err(Error::new(5241, "Connect response exceeds byte limit"));
        }
        bytes.extend_from_slice(&chunk);
    }
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|_| Error::new(5241, "Connect returned invalid JSON"))?;
    if !value.is_object() {
        return Err(Error::new(5241, "Connect returned a non-object response"));
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
        common::write_config(&target, &config)?;
    }
    Ok(())
}

async fn download(url: &str, path: &Path, max_bytes: u64, github: bool) -> Result<()> {
    let mut current = service_url(url)?;
    let http = Client::builder()
        .timeout(Duration::from_secs(180))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| Error::new(5242, "download client unavailable"))?;
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
async fn ensure_cloudflared(home: &Path) -> Result<PathBuf> {
    let binary = home.join("bin/cloudflared");
    if binary.is_file() {
        return Ok(binary);
    }
    let architecture = match std::env::consts::ARCH {
        "x86_64" => "amd64",
        "aarch64" => "arm64",
        _ => return Err(Error::new(5242, "unsupported cloudflared architecture")),
    };
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        "linux" => "linux",
        _ => return Err(Error::new(5242, "unsupported cloudflared platform")),
    };
    fs::create_dir_all(home.join("bin"))?;
    let tmp = tempfile::NamedTempFile::new_in(home.join("bin"))?;
    let suffix = if os == "darwin" { ".tgz" } else { "" };
    let url = format!(
        "https://github.com/cloudflare/cloudflared/releases/download/{CLOUDFLARED_VERSION}/cloudflared-{os}-{architecture}{suffix}"
    );
    download(&url, tmp.path(), 128 * 1024 * 1024, true).await?;
    if os == "darwin" {
        let mut archive =
            tar::Archive::new(flate2::read::GzDecoder::new(fs::File::open(tmp.path())?));
        let mut found = None;
        for entry in archive.entries()? {
            let mut entry = entry?;
            if entry.path()?.file_name() == Some(std::ffi::OsStr::new("cloudflared"))
                && entry.header().entry_type().is_file()
            {
                let mut bytes = Vec::new();
                entry
                    .by_ref()
                    .take(128 * 1024 * 1024 + 1)
                    .read_to_end(&mut bytes)?;
                if bytes.len() > 128 * 1024 * 1024 {
                    return Err(Error::new(5242, "cloudflared exceeds byte limit"));
                }
                found = Some(bytes);
                break;
            }
        }
        common::atomic_write(
            &binary,
            &found.ok_or_else(|| Error::new(5242, "cloudflared missing from archive"))?,
        )?;
    } else {
        tmp.persist(&binary).map_err(|e| Error::from(e.error))?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&binary, fs::Permissions::from_mode(0o700))?;
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
    #[cfg(not(unix))]
    {
        let _ = child.start_kill();
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
        return Err(Error::new(5241, "incomplete Connect registration"));
    }
    apply_public_url(home, Some(&config.tunnel_hostname))?;
    let binary = ensure_cloudflared(home).await?;
    fs::create_dir_all(home.join("logs"))?;
    let logs = home.join("logs/cloudflared.log");
    let spawn = |binary: &Path, config: &ConnectConfig| -> Result<Child> {
        let log = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&logs)?;
        Command::new(binary)
            .args(["tunnel", "run"])
            .env("TUNNEL_TOKEN", &config.tunnel_token)
            .stdin(Stdio::null())
            .stdout(log.try_clone()?)
            .stderr(log)
            .kill_on_drop(true)
            .spawn()
            .map_err(Into::into)
    };
    let child = spawn(&binary, &config)?;
    service.data.lock().await.running = true;
    let (stop, mut stopped) = watch::channel(false);
    let mut heartbeat_stop = stopped.clone();
    let tunnel_service = service.clone();
    let tunnel_config = config.clone();
    let tunnel = tokio::spawn(async move {
        let mut child = child;
        let mut backoff = 1;
        loop {
            tokio::select! {
                _=stopped.changed()=> { terminate(&mut child).await; break; }
                result=child.wait()=> {
                    let mut data=tunnel_service.data.lock().await;
                    data.running=false;
                    data.error=Some(match result { Ok(status)=>format!("cloudflared exited: {status}"), Err(_)=>"cloudflared process failed".into() });
                }
            }
            loop {
                tokio::select! { _=stopped.changed()=>return, _=tokio::time::sleep(Duration::from_secs(backoff))=>{} }
                backoff = (backoff * 2).min(16);
                let log = fs::OpenOptions::new().create(true).append(true).open(&logs);
                let restarted = log.and_then(|log| {
                    Command::new(&binary)
                        .args(["tunnel", "run"])
                        .env("TUNNEL_TOKEN", &tunnel_config.tunnel_token)
                        .stdin(Stdio::null())
                        .stdout(log.try_clone()?)
                        .stderr(log)
                        .kill_on_drop(true)
                        .spawn()
                });
                match restarted {
                    Ok(new_child) => {
                        child = new_child;
                        tunnel_service.data.lock().await.running = true;
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
    let heartbeat = tokio::spawn(async move {
        let heartbeat_url = format!(
            "{}/api/daemons/{}/heartbeat",
            config.api_base, config.daemon_id
        );
        loop {
            let request = object(
                Method::POST,
                &heartbeat_url,
                Some(&config.daemon_token),
                Some(json!({"port":port})),
            );
            tokio::select! {
                _=heartbeat_stop.changed()=>break,
                result=request=> { let mut data=heartbeat_service.data.lock().await; match result { Ok(_)=>{data.heartbeat=Some(common::now());data.error=None;},Err(error)=>data.error=Some(error.message) } }
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
    Ok(
        json!({"registered":config.as_ref().is_some_and(|c|!c.daemon_id.is_empty()),"daemon_id":config.as_ref().map(|c|&c.daemon_id),"slug":config.as_ref().map(|c|&c.slug),"tunnel_hostname":config.as_ref().map(|c|&c.tunnel_hostname),"tunnel_running":data.running,"last_heartbeat_at":data.heartbeat,"last_error":data.error}),
    )
}

/// Verify the cloud grant before creating a locally revocable device credential.
pub async fn redeem_grant(
    home: &Path,
    grant: &str,
    _device_name: &str,
    platform: &str,
) -> Result<Value> {
    let check = async {
        use jsonwebtoken::{
            Algorithm, DecodingKey, Validation, decode, decode_header, jwk::JwkSet,
        };
        let config = ConnectConfig::load(home)?
            .ok_or_else(|| Error::new(4231, "Connect is not configured"))?;
        let header = decode_header(grant).map_err(|_| Error::new(4231, "invalid Connect grant"))?;
        if header.alg != Algorithm::ES256 {
            return Err(Error::new(4231, "invalid Connect grant"));
        }
        let kid = header
            .kid
            .ok_or_else(|| Error::new(4231, "invalid Connect grant"))?;
        let raw = object(Method::GET, &config.jwks_url, None, None).await?;
        let keys: JwkSet = serde_json::from_value(raw)
            .map_err(|_| Error::new(4231, "invalid Connect signing keys"))?;
        let key = keys
            .find(&kid)
            .ok_or_else(|| Error::new(4231, "unknown Connect signing key"))?;
        let key = DecodingKey::from_jwk(key)
            .map_err(|_| Error::new(4231, "invalid Connect signing key"))?;
        let mut validation = Validation::new(Algorithm::ES256);
        validation.set_required_spec_claims(&["sub", "exp", "iat"]);
        validation.leeway = 0;
        let claims = decode::<Value>(grant, &key, &validation)
            .map_err(|_| Error::new(4231, "invalid Connect grant"))?
            .claims;
        if claims["daemon_id"] != config.daemon_id
            || claims["sub"].as_str().is_none_or(str::is_empty)
            || claims["iat"].as_f64().is_none_or(|iat| iat > common::now())
        {
            return Err(Error::new(4231, "invalid Connect grant"));
        }
        let name = claims["device_name"]
            .as_str()
            .ok_or_else(|| Error::new(4231, "invalid Connect grant"))?
            .trim()
            .chars()
            .take(80)
            .collect::<String>();
        if name.is_empty() {
            return Err(Error::new(4231, "invalid Connect grant"));
        }
        crate::auth::mint_device(home, &name, platform, "local")
    }
    .await;
    check.map_err(|_| Error::new(4231, "invalid Connect grant"))
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
    pieces.len() == 3
        && pieces
            .iter()
            .all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()))
        && suffix.is_none_or(|s| {
            !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.')
        })
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
fn native_directory(home: &Path) -> Result<PathBuf> {
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

fn activate_native(native: &Path, version: &str, executable: &Path) -> Result<()> {
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
    common::atomic_write(
        &runtime.join("native-current.json"),
        &serde_json::to_vec(
            &json!({"version":version,"executable":executable,"previous":previous}),
        )
        .unwrap(),
    )?;
    #[cfg(unix)]
    {
        fs::rename(staged_link.path().join("launcher"), stable)?;
        fs::File::open(runtime)?.sync_all()?;
    }
    let running = std::env::current_exe().ok();
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
    let manifest = object(
        Method::GET,
        &format!(
            "{}/daemon/native/{version}/{target}/manifest.json",
            base.trim_end_matches('/')
        ),
        None,
        None,
    )
    .await?;
    if manifest["version"] != version || manifest["target"] != target {
        return Err(Error::new(
            5243,
            "native update manifest does not match this daemon",
        ));
    }
    let url = common::required(&manifest, "url")?;
    same_origin(&base, url)?;
    let digest = common::required(&manifest, "sha256")?;
    if digest.len() != 64 || !digest.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(Error::new(5243, "invalid native update checksum"));
    }
    let native = native_directory(home)?;
    let staging = tempfile::tempdir_in(&native)?;
    let tmp = tempfile::NamedTempFile::new_in(&native)?;
    update_state(service, "downloading", None, None).await;
    download(url, tmp.path(), 1024 * 1024 * 1024, false).await?;
    let mut hash = Sha256::new();
    let mut source = fs::File::open(tmp.path())?;
    let mut chunk = [0; 65536];
    loop {
        let n = source.read(&mut chunk)?;
        if n == 0 {
            break;
        }
        hash.update(&chunk[..n]);
    }
    if format!("{:x}", hash.finalize()) != digest.to_ascii_lowercase() {
        return Err(Error::new(5243, "native update checksum mismatch"));
    }
    update_state(service, "installing", None, None).await;
    let entrypoint = manifest
        .get("entrypoint")
        .and_then(Value::as_str)
        .unwrap_or(if cfg!(windows) {
            "hexbot.exe"
        } else {
            "hexbot"
        });
    common::identifier(entrypoint)?;
    if manifest["format"] == "tar.gz" {
        let mut archive =
            tar::Archive::new(flate2::read::GzDecoder::new(fs::File::open(tmp.path())?));
        let mut size = 0u64;
        for entry in archive.entries()? {
            let mut entry = entry?;
            let path = entry.path()?.into_owned();
            if path.components().any(|part| {
                !matches!(
                    part,
                    std::path::Component::Normal(_) | std::path::Component::CurDir
                )
            }) || (!entry.header().entry_type().is_file()
                && !entry.header().entry_type().is_dir())
            {
                return Err(Error::new(5243, "unsafe entry in native update archive"));
            }
            size = size
                .checked_add(entry.size())
                .ok_or_else(|| Error::new(5243, "native update archive exceeds byte limit"))?;
            if size > 4 * 1024 * 1024 * 1024 {
                return Err(Error::new(5243, "native update archive exceeds byte limit"));
            }
            if !entry.unpack_in(staging.path())? {
                return Err(Error::new(
                    5243,
                    "native update archive escaped destination",
                ));
            }
        }
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
    let directory = native.join(format!("{version}-{}", common::id()));
    fs::rename(staging.path(), &directory)?;
    let executable = directory.join(entrypoint);
    activate_native(&native, version, &executable)?;
    Ok(executable)
}

/// CLI registration persists credentials without starting a tunnel outside the daemon.
pub async fn register_poll(home: &Path, code: &str, start_tunnel: bool) -> Result<Value> {
    let base = api_base(home)?;
    let mut result = object(
        Method::POST,
        &format!("{base}/api/register/poll"),
        None,
        Some(json!({"device_code":code})),
    )
    .await?;
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
        apply_public_url(home, Some(&config.tunnel_hostname))?;
        config.save(home)?;
        if start_tunnel {
            let port = service(home).await?.data.lock().await.port;
            if let Err(error) = start_daemon(home, port).await {
                service(home).await?.data.lock().await.error = Some(error.message.clone());
                return Err(error);
            }
        }
    }
    Ok(result)
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
    Some(async {
        if method=="hexbot.update.status" {common::user(home,caller)?;}else{common::admin(home,caller)?;}
        match method {
            "hexbot.connect.status"=>connect_status(home).await,
            "hexbot.connect.register_start"=>{
                let base=api_base(home)?;
                object(Method::POST,&format!("{base}/api/register/start"),None,Some(json!({"daemon_name":p["daemon_name"].as_str().unwrap_or("Hexbot"),"platform":if cfg!(target_os="macos"){"darwin"}else{std::env::consts::OS}}))).await
            }
            "hexbot.connect.register_poll"=>{
                register_poll(home, common::required(p,"device_code")?, true).await
            }
            "hexbot.connect.disconnect"=>{
                let service=service(home).await?;let _operation=service.lifecycle.lock().await;stop_workers(&service).await;
                if let Ok(Some(config))=ConnectConfig::load(home)
                    && common::identifier(&config.daemon_id).is_ok() {
                    let _=object(Method::DELETE,&format!("{}/api/daemons/{}",config.api_base,config.daemon_id),Some(&config.daemon_token),None).await;
                }
                match fs::remove_file(home.join("connect.json")) {Ok(())=>{},Err(e) if e.kind()==std::io::ErrorKind::NotFound=>{},Err(e)=>return Err(e.into())}
                apply_public_url(home,None)?;connect_status(home).await
            }
            "hexbot.update.status"=>update_status(home).await,
            "hexbot.update.request"=>{
                let version=common::required(p,"version")?;
                if !valid_version(version) {return Err(Error::new(4200,"invalid parameter: version"));}
                let method=capability().ok_or_else(||Error::new(4210,"This daemon cannot update itself. Update Hexbot on its machine."))?;
                if version==crate::version() {return Err(Error::new(4212,format!("The daemon already runs {version}")));}
                let service=service(home).await?;let mut data=service.data.lock().await;
                if matches!(data.update["status"].as_str(),Some("requested"|"checking"|"downloading"|"installing"|"restarting")) {return Err(Error::new(4211,"A daemon update is already in progress"));}
                data.update=json!({"status":"requested","requested":version,"version":null,"message":null,"percent":null,"at":chrono::Utc::now().to_rfc3339()});
                if method=="desktop" {
                    match fs::remove_file(home.join("runtime/update-status.json")) {Ok(())=>{},Err(e) if e.kind()==std::io::ErrorKind::NotFound=>{},Err(e)=>return Err(e.into())}
                    println!("HEXBOT_UPDATE_REQUESTED version={version}");let _=std::io::stdout().flush();
                } else {
                    let home=home.to_owned();let version=version.to_owned();let worker_service=service.clone();
                    data.update_task=Some(tokio::spawn(async move {
                        match native_update(&home,&version,&worker_service).await {
                            Ok(executable)=> {update_state(&worker_service,"restarting",Some(&version),None).await;worker_service.data.lock().await.restart=Some(executable);}
                            Err(error)=>update_state(&worker_service,"failed",None,Some(&error.message)).await,
                        }
                    }));
                }
                Ok(json!({"accepted":true,"method":method,"version":version}))
            }
            _=>unreachable!(),
        }
    }.await)
}
