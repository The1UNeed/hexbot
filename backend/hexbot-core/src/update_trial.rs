//! A daemon a service runs starts each update on trial and rolls back on its
//! own (T3 Code's server update, `docs/channels.md`, "Trial and rollback").
//!
//! The old build snapshots the databases, writes `runtime/update-trial.json`
//! and switches to the new build. The new build counts its starts in the trial
//! file and commits once it can serve. If it can't, it points the selection
//! back and exits; the service starts the old build, which restores the
//! snapshot before it opens a database. The decisions are pure functions over
//! the trial file so tests can drive them; the I/O is in small wrappers.
use crate::{Error, Result, common, server::App, services};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};

/// The data the trial snapshots. Legacy `profiles/*/state.db`, skills and
/// other files are left as they are, as T3 Code leaves non-database state.
const DATABASES: [&str; 2] = ["hexbot.db", "hexbot-runtime.db"];
const CONFIG: &str = "config.yaml";
const COMPLETE: &str = "complete";
/// How long a new build has to commit before the watchdog fails the trial.
pub const WATCHDOG: Duration = Duration::from_secs(10 * 60);
/// The exit status of a failed trial. The service starts the old build.
pub const FAILED_EXIT: i32 = 75;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Trying,
    Failed,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Trial {
    pub id: String,
    pub from_version: String,
    pub to_version: String,
    /// The old build's launcher, and the selection record it had.
    pub from_executable: PathBuf,
    pub from_record: Value,
    /// The new build's launcher, canonicalised, and its build time.
    pub to_executable: PathBuf,
    pub to_built_at: u64,
    pub snapshot: PathBuf,
    pub attempts: u32,
    pub status: Status,
    #[serde(default)]
    pub reason: Option<String>,
    pub started_at: String,
}

fn trial_path(home: &Path) -> PathBuf {
    home.join("runtime/update-trial.json")
}
fn outcome_path(home: &Path) -> PathBuf {
    home.join("runtime/update-outcome.json")
}
fn snapshots(home: &Path) -> PathBuf {
    home.join("runtime/update-snapshots")
}

/// An update id from a client becomes a directory name that is later deleted.
pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

pub fn read_trial(home: &Path) -> Result<Option<Trial>> {
    let bytes = match fs::read(trial_path(home)) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    match serde_json::from_slice(&bytes) {
        Ok(trial) => Ok(Some(trial)),
        Err(_) => {
            // Atomic writes make this unlikely; never let it stop every start.
            eprintln!(
                "Update: update-trial.json can't be read; keeping it as update-trial.json.bad"
            );
            fs::rename(trial_path(home), home.join("runtime/update-trial.json.bad"))?;
            Ok(None)
        }
    }
}
pub fn write_trial(home: &Path, trial: &Trial) -> Result<()> {
    common::atomic_write(&trial_path(home), &serde_json::to_vec(trial).unwrap())
}
fn remove(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() => fs::remove_dir_all(path)?,
        Ok(_) => fs::remove_file(path)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    Ok(())
}

/// The last update's result, which a client reads by its id
/// (`hexbot.update.status`, `outcome`).
pub fn outcome(home: &Path) -> Option<Value> {
    fs::read(outcome_path(home))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
}
pub fn write_outcome(
    home: &Path,
    id: &str,
    from: &str,
    to: &str,
    status: &str,
    reason: Option<&str>,
) -> Result<()> {
    let outcome = json!({"id":id,"from":from,"to":to,"status":status,"reason":reason,
        "at":chrono::Utc::now().to_rfc3339()});
    common::atomic_write(&outcome_path(home), outcome.to_string().as_bytes())
}

/// Ends a trial: records its outcome, then removes the trial file and the
/// snapshot, in that order, so a crash part way repeats the same ending.
fn finish(home: &Path, trial: &Trial, status: &str, reason: Option<&str>) -> Result<()> {
    write_outcome(
        home,
        &trial.id,
        &trial.from_version,
        &trial.to_version,
        status,
        reason,
    )?;
    remove(&trial_path(home))?;
    remove(&snapshots(home).join(&trial.id))?;
    // Only empty: a later update's snapshot is never touched.
    let _ = fs::remove_dir(snapshots(home));
    Ok(())
}

/// Space for a snapshot: twice the databases, their write-ahead logs and the
/// config, so `VACUUM INTO` has room to work.
pub fn space_needed(home: &Path) -> u64 {
    let size = |path: PathBuf| fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    let mut total = size(home.join(CONFIG));
    for database in DATABASES {
        total += size(home.join(database));
        total += size(home.join(format!("{database}-wal")));
    }
    total * 2
}
pub fn check_space(needed: u64, free: u64) -> Result<()> {
    if free < needed {
        return Err(Error::new(
            4216,
            format!(
                "The daemon needs {} MB free to keep a copy of its data while it updates. Free some space and try again.",
                needed.div_ceil(1024 * 1024)
            ),
        ));
    }
    Ok(())
}
fn free_space(path: &Path) -> Result<u64> {
    use std::os::unix::ffi::OsStrExt;
    let path = std::ffi::CString::new(path.as_os_str().as_bytes())
        .map_err(|_| Error::new(4202, "invalid path"))?;
    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(path.as_ptr(), &mut stat) } != 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    #[allow(clippy::unnecessary_cast)]
    Ok(stat.f_bavail as u64 * stat.f_frsize as u64)
}
/// Refuses an update while the old daemon still serves, never after it stopped.
pub fn require_space(home: &Path) -> Result<()> {
    check_space(space_needed(home), free_space(home)?)
}

/// Copies the databases and the config into `runtime/update-snapshots/<id>/`.
/// Runs after shutdown; `complete` marks a finished copy.
pub fn snapshot(home: &Path, id: &str) -> Result<PathBuf> {
    if !valid_id(id) {
        return Err(Error::new(4200, "invalid parameter: update_id"));
    }
    let directory = snapshots(home).join(id);
    remove(&directory)?;
    fs::create_dir_all(&directory)?;
    for database in DATABASES {
        let source = home.join(database);
        if source.is_file() {
            let target = directory.join(database);
            rusqlite::Connection::open(&source)?
                .execute("VACUUM INTO ?1", [target.to_string_lossy()])?;
            fs::File::open(&target)?.sync_all()?;
        }
    }
    let config = home.join(CONFIG);
    if config.is_file() {
        fs::copy(&config, directory.join(CONFIG))?;
        fs::File::open(directory.join(CONFIG))?.sync_all()?;
    }
    common::atomic_write(&directory.join(COMPLETE), b"")?;
    Ok(directory)
}

/// Puts the snapshot back. Safe to repeat: the snapshot is deleted last.
fn restore(home: &Path, snapshot: &Path) -> Result<()> {
    if !snapshot.join(COMPLETE).is_file() {
        return Err(Error::new(5243, "The update snapshot is incomplete"));
    }
    let replace = |source: PathBuf, target: PathBuf| -> Result<()> {
        if !source.is_file() {
            // It didn't exist before the update.
            return remove(&target);
        }
        let mut partial = target.clone().into_os_string();
        partial.push(".restore");
        let partial = PathBuf::from(partial);
        fs::copy(&source, &partial)?;
        fs::File::open(&partial)?.sync_all()?;
        fs::rename(&partial, &target)?;
        Ok(())
    };
    for database in DATABASES {
        // A log from the new build would otherwise be replayed onto the copy.
        remove(&home.join(format!("{database}-wal")))?;
        remove(&home.join(format!("{database}-shm")))?;
        replace(snapshot.join(database), home.join(database))?;
    }
    replace(snapshot.join(CONFIG), home.join(CONFIG))?;
    fs::File::open(home)?.sync_all()?;
    Ok(())
}

/// What a starting process does with the trial file it finds. `attempts`
/// already counts this start when the trial is this build's.
#[derive(Debug, PartialEq, Eq)]
pub enum Start {
    Trial,
    Fail(&'static str),
    Restore,
    Superseded,
}
pub fn decide(trial: &Trial, version: &str, selected: Option<&Path>) -> Start {
    let ours = trial.to_version == version;
    match trial.status {
        Status::Trying if ours && trial.attempts >= 2 => Start::Fail("crashed while starting"),
        Status::Trying if ours => Start::Trial,
        // A rollback that didn't finish pointing the selection back.
        Status::Failed if ours && selected == Some(trial.to_executable.as_path()) => {
            Start::Fail("didn't start")
        }
        _ if trial.from_version == version => Start::Restore,
        _ => Start::Superseded,
    }
}

/// Reads the trial file right after the home lock is taken, before any
/// database is opened. Returns a guard while this build is on trial.
pub fn on_start(home: &Path) -> Result<Option<TrialGuard>> {
    let Some(mut trial) = read_trial(home)? else {
        // Left by an update that failed before it switched.
        remove(&snapshots(home))?;
        return Ok(None);
    };
    // The snapshot is only ever read and deleted at its own place.
    let expected = snapshots(home).join(&trial.id);
    if !valid_id(&trial.id) || trial.snapshot != expected {
        remove(&trial_path(home))?;
        return Ok(None);
    }
    let version = crate::version();
    if trial.status == Status::Trying && trial.to_version == version {
        trial.attempts += 1;
        write_trial(home, &trial)?;
    }
    let selected = services::selected_native_executable(home)
        .ok()
        .and_then(|path| path.canonicalize().ok());
    match decide(&trial, &version, selected.as_deref()) {
        Start::Trial => Ok(Some(TrialGuard::new(home, trial))),
        Start::Fail(reason) => fail_trial(home, &trial, reason),
        Start::Restore => {
            services::repair_rolled_back_selection(home, &trial)?;
            restore(home, &expected)?;
            let reason = trial
                .reason
                .clone()
                .unwrap_or_else(|| "didn't start".into());
            finish(home, &trial, "rolled-back", Some(&reason))?;
            eprintln!(
                "Update to {} rolled back: {reason}. Running {}.",
                trial.to_version, trial.from_version
            );
            Ok(None)
        }
        Start::Superseded => {
            finish(home, &trial, "superseded", None)?;
            Ok(None)
        }
    }
}

/// Points the selection back at the old build, if it still names the trial's,
/// then marks the trial failed. Switching first means a crash in between
/// leaves `trying` with the old build selected, which restores as `from_version`.
pub fn mark_failed(home: &Path, trial: &Trial, reason: &str) -> Result<()> {
    services::roll_back_selection(home, trial)?;
    let mut failed = trial.clone();
    failed.status = Status::Failed;
    failed.reason = Some(reason.into());
    write_trial(home, &failed)
}
/// Never restores in the failing process: the service starts the old build,
/// with a clean environment, and that build restores the snapshot.
pub fn fail_trial(home: &Path, trial: &Trial, reason: &str) -> ! {
    if let Err(error) = mark_failed(home, trial, reason) {
        // The service will start this build again, and it fails again.
        eprintln!(
            "Update rollback could not switch back to {}: {error}",
            trial.from_version
        );
    }
    eprintln!(
        "Update to {} failed: {reason}. Starting {} again.",
        trial.to_version, trial.from_version
    );
    std::process::exit(FAILED_EXIT)
}

/// An update that failed before the old build switched away from itself.
/// Returns the launcher to run now. If the switch did happen, fails the trial.
pub fn abandon(home: &Path, id: &str, to_version: &str, reason: &str) -> Result<PathBuf> {
    let trial = read_trial(home)?;
    if let Some(trial) = &trial {
        let selected = services::selected_native_executable(home)?.canonicalize()?;
        if selected == trial.to_executable {
            fail_trial(home, trial, reason)
        }
        services::repair_rolled_back_selection(home, trial)?;
        finish(home, trial, "failed", Some(reason))?;
    } else {
        write_outcome(
            home,
            id,
            &crate::version(),
            to_version,
            "failed",
            Some(reason),
        )?;
        remove(&snapshots(home).join(id))?;
    }
    services::selected_native_executable(home)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    Open,
    Committed,
    Failing,
}
/// This build is on trial until `commit`.
pub struct TrialGuard {
    home: PathBuf,
    trial: Trial,
    state: Arc<Mutex<State>>,
    app: Arc<OnceLock<Arc<App>>>,
}
impl TrialGuard {
    fn new(home: &Path, trial: Trial) -> Self {
        Self {
            home: home.to_owned(),
            trial,
            state: Arc::new(Mutex::new(State::Open)),
            app: Arc::default(),
        }
    }
    pub fn trial(&self) -> &Trial {
        &self.trial
    }
    /// The app the watchdog and a failure shut down before they exit.
    pub fn set_app(&self, app: Arc<App>) {
        let _ = self.app.set(app);
    }
    /// Claims the trial for a failure. False once committed.
    fn claim(state: &Mutex<State>) -> bool {
        let mut state = state.lock().unwrap_or_else(|e| e.into_inner());
        if *state != State::Open {
            return *state == State::Failing;
        }
        *state = State::Failing;
        true
    }
    /// Fails the trial if it hasn't committed within `after`.
    pub fn start_watchdog(&self, handle: tokio::runtime::Handle, after: Duration) {
        let (home, trial, state, app) = (
            self.home.clone(),
            self.trial.clone(),
            self.state.clone(),
            self.app.clone(),
        );
        std::thread::spawn(move || {
            std::thread::sleep(after);
            if !Self::claim(&state) {
                return;
            }
            if let Some(app) = app.get() {
                let _ = handle.block_on(tokio::time::timeout(
                    Duration::from_secs(10),
                    app.shutdown(),
                ));
            }
            fail_trial(&home, &trial, "didn't start within 10 minutes")
        });
    }
    /// The new build can serve: keep it.
    pub fn commit(&self) -> Result<()> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        match *state {
            State::Committed => return Ok(()),
            State::Failing => return Err(Error::new(5243, "The update trial already failed")),
            State::Open => {}
        }
        finish(&self.home, &self.trial, "committed", None)?;
        *state = State::Committed;
        Ok(())
    }
    /// `serve` failed before the commit.
    pub async fn fail(&self, reason: &str) {
        if !Self::claim(&self.state) {
            return;
        }
        if let Some(app) = self.app.get() {
            let _ = tokio::time::timeout(Duration::from_secs(10), app.shutdown()).await;
        }
        fail_trial(&self.home, &self.trial, reason)
    }
}

/// The directories a launcher's environment can point into: the runtime as
/// the home names it and canonicalised, so `/var` and `/private/var` match.
pub fn native_roots(home: &Path) -> Vec<PathBuf> {
    let given = home.join("runtime/native");
    let mut roots = vec![given.clone()];
    if let Ok(canonical) = given.canonicalize()
        && canonical != given
    {
        roots.push(canonical);
    }
    roots
}
/// The environment for the next launcher. The bundle's launcher keeps any
/// `HEXBOT_WEB_DIST` or `HEXBOT_BUNDLED_SKILLS` it inherits, so without this
/// a new build would serve the old build's web app and skills
/// (`scripts/desktop/native-runtime.mjs`, `launchers`).
pub fn launcher_env(
    vars: impl IntoIterator<Item = (OsString, OsString)>,
    roots: &[PathBuf],
) -> Vec<(OsString, Option<OsString>)> {
    let inside = |path: &Path| {
        roots.iter().any(|root| path.starts_with(root))
            || path
                .canonicalize()
                .is_ok_and(|path| roots.iter().any(|root| path.starts_with(root)))
    };
    let mut changes = Vec::new();
    for (key, value) in vars {
        match key.to_str() {
            Some("HEXBOT_WEB_DIST" | "HEXBOT_BUNDLED_SKILLS" | "HEXBOT_PI_EXECUTABLE")
                if inside(Path::new(&value)) =>
            {
                changes.push((key, None));
            }
            Some("PATH") => {
                let kept: Vec<PathBuf> = std::env::split_paths(&value)
                    .filter(|entry| !inside(entry))
                    .collect();
                if let Ok(path) = std::env::join_paths(kept)
                    && path != value
                {
                    changes.push((key, Some(path)));
                }
            }
            _ => {}
        }
    }
    changes
}
/// Replaces this process with `serve` from another launcher. Returns only on failure.
pub fn exec_launcher(
    home: &Path,
    executable: &Path,
    address: std::net::SocketAddr,
) -> std::io::Error {
    use std::os::unix::process::CommandExt;
    let mut next = std::process::Command::new(executable);
    next.arg("serve")
        .arg("--host")
        .arg(address.ip().to_string())
        .arg("--port")
        .arg(address.port().to_string())
        .env("HEXBOT_HOME", home);
    for (key, value) in launcher_env(std::env::vars_os(), &native_roots(home)) {
        match value {
            Some(value) => next.env(key, value),
            None => next.env_remove(key),
        };
    }
    next.exec()
}

#[cfg(test)]
#[path = "update_trial_tests.rs"]
mod tests;
