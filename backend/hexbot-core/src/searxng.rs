//! The web search Hexbot runs itself: SearXNG in a container on the daemon's
//! computer, one per daemon home, listening on localhost only. It runs in
//! whatever Docker answers. Hexbot never starts a container engine for it
//! (Computer use does that while the computer is on); until Docker answers,
//! web search uses Tavily's free tier, then Wikipedia (`native_tools`).
//!
//! It starts with the first web search, or with Save or Test in Settings,
//! never on its own, and stops with the daemon. Each start removes the
//! containers this computer's daemons left behind for homes that are gone.
//!
//! The settings go in with `docker cp` rather than a bind mount, so it works
//! with any engine: Colima and Docker Desktop share different folders with
//! their VM, and a remote Docker context shares none.
use crate::{Error, Result, common, native_tools};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};

/// Pinned like every other dependency. A new tag replaces the container.
pub const IMAGE: &str = "docker.io/searxng/searxng:2026.10.19-81371861f";
/// How long after a failed start the next search or tick tries again.
const RETRY: Duration = Duration::from_secs(60);
/// The first start downloads about 100 MB.
const CREATE_WAIT: Duration = Duration::from_secs(600);
/// SearXNG answers its health check a few seconds after it starts.
const HEALTHY_WAIT: Duration = Duration::from_secs(60);

#[derive(Default)]
struct State {
    /// Where it answered last, such as `http://127.0.0.1:32770`.
    url: Option<String>,
    starting: bool,
    /// This daemon started or found the container, healthy or not, so it
    /// stops it as it stops.
    touched: bool,
    /// The daemon is stopping: no start launches the container again.
    closed: bool,
    /// Why the last start failed, in words for Settings.
    error: Option<String>,
    failed_at: Option<Instant>,
}
fn states() -> &'static Mutex<HashMap<PathBuf, State>> {
    static MAP: OnceLock<Mutex<HashMap<PathBuf, State>>> = OnceLock::new();
    MAP.get_or_init(Default::default)
}
fn with<T>(home: &Path, f: impl FnOnce(&mut State) -> T) -> T {
    let mut map = states().lock().unwrap_or_else(|e| e.into_inner());
    f(map.entry(home.to_owned()).or_default())
}
/// One start at a time for each home.
fn start_lock(home: &Path) -> Arc<tokio::sync::Mutex<()>> {
    static LOCKS: OnceLock<Locks> = OnceLock::new();
    lock_in(&LOCKS, home)
}
/// Held only around `docker start`, which shutdown waits for.
fn launch_lock(home: &Path) -> Arc<tokio::sync::Mutex<()>> {
    static LOCKS: OnceLock<Locks> = OnceLock::new();
    lock_in(&LOCKS, home)
}
type Locks = Mutex<HashMap<PathBuf, Arc<tokio::sync::Mutex<()>>>>;
fn lock_in(locks: &'static OnceLock<Locks>, home: &Path) -> Arc<tokio::sync::Mutex<()>> {
    locks
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .entry(home.to_owned())
        .or_default()
        .clone()
}

/// The container's name for this daemon home, so worktrees and test homes
/// each get their own.
pub fn container(home: &Path) -> String {
    let digest = Sha256::digest(home.to_string_lossy().as_bytes());
    let hex = digest
        .iter()
        .take(6)
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    format!("hexbot-searxng-{hex}")
}

/// Whether web search uses the SearXNG Hexbot runs: SearXNG is the provider
/// in use, chosen or by default, and the user set no SearXNG URL of their own.
pub fn chosen(home: &Path) -> bool {
    let (Ok(config), Ok(env)) = (common::read_config(home), common::env_values(home)) else {
        return false;
    };
    native_tools::web_backend(&config, &env, false) == "searxng"
        && native_tools::credential(&env, "SEARXNG_URL")
            .trim()
            .is_empty()
}
/// Chosen, and this computer has Docker to run it in.
pub fn wanted(home: &Path) -> bool {
    chosen(home) && common::read_config(home).is_ok_and(|config| docker(&config).is_some())
}

/// config.yaml `web.searxng.docker`: the Docker CLI to use, or `off` so this
/// computer never runs SearXNG. Tests run it only when they say which.
fn docker(config: &Value) -> Option<PathBuf> {
    match config["web"]["searxng"]["docker"].as_str().map(str::trim) {
        Some("off") => None,
        Some(path) if !path.is_empty() => {
            let path = PathBuf::from(path);
            if path.is_absolute() {
                common::executable_file(&path).then_some(path)
            } else {
                native_tools::on_path(&path.to_string_lossy())
            }
        }
        _ if cfg!(test) => None,
        _ => native_tools::on_path("docker"),
    }
}

/// The local SearXNG's address when it answers now. Otherwise it starts in
/// the background, at most once a minute after a failure, and this search
/// uses another service.
pub async fn url(home: &Path) -> Option<String> {
    if let Some(url) = with(home, |s| s.url.clone()) {
        if healthy(&url).await {
            return Some(url);
        }
        with(home, |s| s.url = None);
    }
    start_soon(home);
    None
}

/// Start SearXNG in the background when web search wants it and it is not
/// running, starting, or waiting to try again.
fn start_soon(home: &Path) {
    if !wanted(home) {
        return;
    }
    let go = with(home, |s| {
        let waiting = s.failed_at.is_some_and(|at| at.elapsed() < RETRY);
        if s.url.is_some() || s.starting || waiting {
            return false;
        }
        s.starting = true;
        true
    });
    if !go {
        return;
    }
    let home = home.to_owned();
    tokio::spawn(async move {
        let _ = run(&home).await;
    });
}

/// Stop this daemon's SearXNG as the daemon stops, if it started it. The
/// next search starts it again.
pub async fn stop(home: &Path) {
    let touched = with(home, |s| {
        s.url = None;
        s.closed = true;
        std::mem::take(&mut s.touched)
    });
    // A `docker start` under way finishes first (seconds, never a download);
    // every later one sees `closed` and does not run.
    let lock = launch_lock(home);
    let _held = lock.lock().await;
    if touched {
        halt(home).await;
    }
}
async fn halt(home: &Path) {
    let Some(docker) = common::read_config(home).ok().and_then(|c| docker(&c)) else {
        return;
    };
    let _ = run_docker(
        &docker,
        &["stop", "--time", "2", &container(home)],
        Duration::from_secs(20),
    )
    .await;
}

/// Start SearXNG now and wait until it answers: Settings' Save and Test.
pub async fn ensure(home: &Path) -> Result<String> {
    with(home, |s| s.starting = true);
    run(home).await
}

/// What Settings says about it while web search uses it: starting, or why
/// it is not running.
pub fn note(home: &Path) -> Option<String> {
    if !chosen(home) {
        return None;
    }
    if !wanted(home) {
        return Some("needs Docker".to_owned());
    }
    with(home, |s| {
        if s.url.is_some() {
            None
        } else if s.starting {
            Some("starting".to_owned())
        } else {
            s.error.as_ref().map(|e| e.chars().take(60).collect())
        }
    })
}

async fn run(home: &Path) -> Result<String> {
    let lock = start_lock(home);
    let _one = lock.lock().await;
    let result = match with(home, |s| s.url.clone()) {
        Some(url) if healthy(&url).await => Ok(url),
        _ => start(home).await,
    };
    with(home, |s| {
        s.starting = false;
        match &result {
            Ok(url) => {
                s.url = Some(url.clone());
                s.error = None;
                s.failed_at = None;
            }
            Err(error) => {
                s.url = None;
                s.error = Some(error.message.clone());
                s.failed_at = Some(Instant::now());
            }
        }
    });
    result
}

struct Output {
    ok: bool,
    stdout: String,
    stderr: String,
}
async fn run_docker(docker: &Path, args: &[&str], wait: Duration) -> Result<Output> {
    let mut cmd = tokio::process::Command::new(docker);
    crate::credentials::desktop_environment(&mut cmd);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let output = tokio::time::timeout(wait, cmd.output())
        .await
        .map_err(|_| failure("Docker took too long to answer"))?
        .map_err(|_| failure("Docker would not run"))?;
    Ok(Output {
        ok: output.status.success(),
        stdout: String::from_utf8_lossy(&output.stdout).trim().to_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).trim().to_owned(),
    })
}
fn failure(message: impl Into<String>) -> Error {
    Error::new(4211, message)
}
/// Docker's last line of complaint, short enough for Settings.
fn complaint(output: &Output, fallback: &str) -> Error {
    let line = output
        .stderr
        .lines()
        .map(str::trim)
        .rfind(|l| !l.is_empty())
        .unwrap_or(fallback);
    failure(line.chars().take(160).collect::<String>())
}

/// `docker start`, unless the daemon is stopping.
async fn launch(home: &Path, docker: &Path, name: &str) -> Result<Output> {
    let lock = launch_lock(home);
    let _held = lock.lock().await;
    if with(home, |s| s.closed) {
        return Err(failure("Hexbot is stopping"));
    }
    run_docker(docker, &["start", name], Duration::from_secs(60)).await
}

async fn start(home: &Path) -> Result<String> {
    let config = common::read_config(home)?;
    let docker = docker(&config).ok_or_else(|| failure("Docker isn't installed"))?;
    with(home, |s| s.touched = true);
    let version = run_docker(
        &docker,
        &["version", "--format", "{{.Server.Version}}"],
        Duration::from_secs(20),
    )
    .await?;
    if !version.ok || version.stdout.is_empty() {
        return Err(failure("Docker isn't running"));
    }
    sweep(&docker).await;
    let name = container(home);
    let inspect = run_docker(
        &docker,
        &[
            "inspect",
            "--format",
            "{{.State.Running}} {{index .Config.Labels \"app.hexbot.image\"}}",
            &name,
        ],
        Duration::from_secs(20),
    )
    .await?;
    let (running, image) = inspect
        .stdout
        .split_once(' ')
        .map_or(("", ""), |(r, i)| (r, i.trim()));
    if !inspect.ok || image != IMAGE {
        if inspect.ok {
            // An older image: make the container again from the new one.
            run_docker(&docker, &["rm", "-f", &name], Duration::from_secs(60)).await?;
        }
        create(home, &docker, &name).await?;
    } else if running != "true" {
        let started = launch(home, &docker, &name).await?;
        if !started.ok {
            return Err(complaint(&started, "SearXNG would not start"));
        }
    }
    let port = run_docker(
        &docker,
        &["port", &name, "8080/tcp"],
        Duration::from_secs(20),
    )
    .await?;
    let address = port
        .stdout
        .lines()
        .map(str::trim)
        .find(|l| l.starts_with("127.0.0.1:"))
        .ok_or_else(|| complaint(&port, "SearXNG has no port"))?;
    let url = format!("http://{address}");
    let deadline = Instant::now() + HEALTHY_WAIT;
    while Instant::now() < deadline {
        if healthy(&url).await {
            return Ok(url);
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    Err(failure("SearXNG started but does not answer"))
}

/// This computer's name, so a sweep never touches what another computer
/// made in a shared Docker.
fn host() -> String {
    crate::osutil::hostname().unwrap_or_default()
}

/// Remove the containers this computer made for homes that no longer exist,
/// such as a deleted worktree's or an uninstalled daemon's.
async fn sweep(docker: &Path) {
    let Ok(list) = run_docker(
        docker,
        &[
            "ps",
            "--all",
            "--filter",
            "label=app.hexbot.searxng",
            "--format",
            "{{.Names}}\t{{.Label \"app.hexbot.home\"}}\t{{.Label \"app.hexbot.host\"}}",
        ],
        Duration::from_secs(20),
    )
    .await
    else {
        return;
    };
    let here = host();
    for line in list.stdout.lines() {
        let mut parts = line.split('\t');
        let (Some(name), Some(home), Some(made_on)) = (parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        if !home.is_empty() && made_on == here && !Path::new(home).exists() {
            let _ = run_docker(docker, &["rm", "-f", name], Duration::from_secs(60)).await;
        }
    }
}

async fn create(home: &Path, docker: &Path, name: &str) -> Result<()> {
    let label = format!("app.hexbot.image={IMAGE}");
    let home_label = format!("app.hexbot.home={}", home.display());
    let host_label = format!("app.hexbot.host={}", host());
    let created = run_docker(
        docker,
        &[
            "create",
            "--name",
            name,
            "--label",
            "app.hexbot.searxng=1",
            "--label",
            &label,
            "--label",
            &home_label,
            "--label",
            &host_label,
            // Localhost only, on a port Docker picks.
            "--publish",
            "127.0.0.1::8080",
            IMAGE,
        ],
        CREATE_WAIT,
    )
    .await?;
    if !created.ok {
        return Err(complaint(&created, "SearXNG could not be downloaded"));
    }
    let dir = home.join("runtime/searxng");
    std::fs::create_dir_all(&dir)?;
    let settings = dir.join("settings.yml");
    common::atomic_write(&settings, settings_yaml().as_bytes())?;
    let target = format!("{name}:/etc/searxng/settings.yml");
    let copied = run_docker(
        docker,
        &["cp", &settings.to_string_lossy(), &target],
        Duration::from_secs(60),
    )
    .await?;
    if !copied.ok {
        let _ = run_docker(docker, &["rm", "-f", name], Duration::from_secs(60)).await;
        return Err(complaint(&copied, "SearXNG's settings could not be copied"));
    }
    let started = launch(home, docker, name).await?;
    if !started.ok {
        return Err(complaint(&started, "SearXNG would not start"));
    }
    Ok(())
}

/// JSON answers for the bots, and no bot check or image proxy: only this
/// computer reaches it.
fn settings_yaml() -> String {
    let secret = (0..32)
        .map(|_| format!("{:02x}", rand::random::<u8>()))
        .collect::<String>();
    format!(
        "use_default_settings: true\n\
         server:\n  secret_key: \"{secret}\"\n  limiter: false\n  public_instance: false\n  image_proxy: false\n\
         search:\n  formats: [html, json]\n"
    )
}

/// A client for this computer's own SearXNG, which no proxy should see.
pub fn client(seconds: u64) -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(seconds))
        .build()
        .map_err(|_| failure("HTTP client unavailable"))
}
async fn healthy(url: &str) -> bool {
    let Ok(client) = client(3) else {
        return false;
    };
    client
        .get(format!("{url}/healthz"))
        .send()
        .await
        .is_ok_and(|r| r.status().is_success())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_home_has_its_own_container() {
        let a = container(Path::new("/Users/me/.hexbot"));
        let b = container(Path::new("/Users/me/work/.hexbot"));
        assert!(a.starts_with("hexbot-searxng-"));
        assert_eq!(a.len(), "hexbot-searxng-".len() + 12);
        assert_ne!(a, b);
        assert_eq!(a, container(Path::new("/Users/me/.hexbot")));
    }

    #[test]
    fn settings_answer_json_without_a_bot_check() {
        let yaml = settings_yaml();
        let parsed: serde_yaml::Value = serde_yaml::from_str(&yaml).unwrap();
        assert_eq!(parsed["use_default_settings"], true);
        assert_eq!(parsed["server"]["limiter"], false);
        assert_eq!(parsed["server"]["secret_key"].as_str().unwrap().len(), 64);
        let formats = parsed["search"]["formats"].as_sequence().unwrap();
        assert!(formats.iter().any(|f| f == "json"));
        assert_ne!(yaml, settings_yaml(), "every container gets its own secret");
    }

    #[test]
    fn off_or_a_tests_home_never_runs_docker() {
        assert!(docker(&serde_json::json!({})).is_none());
        assert!(docker(&serde_json::json!({"web":{"searxng":{"docker":"off"}}})).is_none());
    }
}
