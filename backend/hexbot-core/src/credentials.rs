//! Credential paths, host write tiers, the child environment, and child-process
//! isolation. All four come from `../../pi-runtime/credential-policy.json`, which the
//! private extension reads for Pi's bash and file tools; the parity test below keeps
//! the two sandbox builders identical.
use crate::{Error, Result};
use serde::Deserialize;
use std::{
    collections::{HashMap, HashSet, VecDeque},
    ffi::OsString,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};
#[derive(Deserialize)]
struct Policy {
    basename: String,
    home: String,
    user: Vec<String>,
    #[serde(rename = "sshPublic")]
    ssh_public: String,
    #[serde(rename = "secretFile")]
    secret_file: String,
    #[serde(rename = "secretFileExample")]
    secret_file_example: String,
    skip: Vec<String>,
    #[serde(rename = "readDeny")]
    read_deny: Vec<String>,
    write: WritePolicy,
    environment: Vec<String>,
    #[serde(rename = "displayEnvironment")]
    display_environment: Vec<String>,
}
#[derive(Deserialize)]
struct WritePolicy {
    deny: Vec<String>,
    ask: Vec<String>,
    /// System configuration: the file tools never write it; shell commands ask.
    #[serde(rename = "fileDeny")]
    file_deny: Vec<String>,
}
fn policy() -> &'static Policy {
    static POLICY: OnceLock<Policy> = OnceLock::new();
    POLICY.get_or_init(|| {
        serde_json::from_str(include_str!("../../pi-runtime/credential-policy.json"))
            .expect("credential policy")
    })
}
type Patterns = (
    regex::Regex,
    regex::Regex,
    regex::Regex,
    regex::Regex,
    regex::Regex,
);
fn patterns() -> &'static Patterns {
    static PATTERNS: OnceLock<Patterns> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        let compile = |source: &str| {
            regex::Regex::new(&format!("{}{source}", if FOLD_CASE { "(?i)" } else { "" })).unwrap()
        };
        (
            compile(&policy().basename),
            compile(&policy().home),
            compile(&policy().ssh_public),
            compile(&policy().secret_file),
            compile(&policy().secret_file_example),
        )
    })
}
/// macOS and Windows file systems ignore case, so path comparisons and the policy
/// matchers do too.
pub(crate) const FOLD_CASE: bool = cfg!(any(target_os = "macos", windows));
fn folded(path: &Path) -> PathBuf {
    if FOLD_CASE {
        PathBuf::from(path.to_string_lossy().to_lowercase())
    } else {
        path.to_owned()
    }
}
pub(crate) fn under(path: &Path, root: &Path) -> bool {
    folded(path).starts_with(folded(root))
}
/// The Hexbot home rules alone: credential names anywhere and protected home paths.
fn home_credential_name(home: &Path, path: &Path) -> bool {
    let (name, local, ..) = patterns();
    let (path_folded, home_folded) = (folded(path), folded(home));
    path_folded.strip_prefix(&home_folded).is_ok_and(|p| {
        name.is_match(path.file_name().and_then(|s| s.to_str()).unwrap_or(""))
            || local.is_match(&p.to_string_lossy().replace('\\', "/"))
    })
}
pub fn credential_name(home: &Path, path: &Path) -> bool {
    if std::env::var_os("HOME").is_some_and(|user| {
        user_credential_name(Path::new(&user), path)
            || ssh_credential_name(Path::new(&user), path)
            || store_credential_name(path)
    }) {
        return true;
    }
    if read_denied().iter().any(|store| under(path, store)) {
        return true;
    }
    if path
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(secret_file_name)
        && !path.is_dir()
    {
        return true;
    }
    home_credential_name(home, path)
}
/// Project secrets such as .env, wherever they are; .env.example and the like are not.
pub(crate) fn secret_file_name(name: &str) -> bool {
    let (.., secret, example) = patterns();
    secret.is_match(name) && !example.is_match(name)
}
fn user_credential_name(user: &Path, path: &Path) -> bool {
    policy().user.iter().any(|local| {
        let secret = user.join(local);
        under(path, &secret) || std::fs::canonicalize(secret).is_ok_and(|p| under(path, &p))
    })
}
/// Credential stores such as ~/.aws and ~/.netrc are private to reads too.
fn store_credential_name(path: &Path) -> bool {
    policy()
        .write
        .deny
        .iter()
        .filter_map(|entry| policy_root(entry))
        .any(|store| {
            under(path, &store) || std::fs::canonicalize(&store).is_ok_and(|p| under(path, &p))
        })
}
fn ssh_credential_name(user: &Path, path: &Path) -> bool {
    let ssh = user.join(".ssh");
    [ssh.clone(), std::fs::canonicalize(&ssh).unwrap_or(ssh)]
        .iter()
        .any(|root| {
            under(path, root)
                && (path
                    .parent()
                    .is_none_or(|parent| folded(parent) != folded(root))
                    || path
                        .file_name()
                        .and_then(|n| n.to_str())
                        .is_some_and(private_key))
        })
}
fn entries(dir: &Path) -> impl Iterator<Item = std::fs::DirEntry> {
    std::fs::read_dir(dir).into_iter().flatten().flatten()
}
pub(crate) fn private_key(name: &str) -> bool {
    !patterns().2.is_match(name)
}
/// Host paths the file tools treat specially: `Deny` is never written by a tool
/// outside Bypass; `Ask` needs approval in Manual and Auto.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WriteTier {
    Deny,
    Ask,
}
pub const NEVER_WRITTEN: &str =
    "Credential and system configuration files are never written by tools.";
/// A write policy entry is absolute or relative to the user's home; `None`
/// when it is relative and HOME is unset.
fn policy_root(entry: &str) -> Option<PathBuf> {
    if entry.starts_with('/') {
        Some(PathBuf::from(entry))
    } else {
        std::env::var_os("HOME").map(|user| PathBuf::from(user).join(entry))
    }
}
/// The file tools' tier for a host path.
pub fn host_write_tier(path: &Path) -> Option<WriteTier> {
    let write = &policy().write;
    let tiers = [
        (WriteTier::Deny, &write.deny),
        (WriteTier::Deny, &write.file_deny),
        (WriteTier::Ask, &write.ask),
    ];
    for (tier, entries) in tiers {
        for root in entries.iter().filter_map(|entry| policy_root(entry)) {
            if under(path, &root)
                || std::fs::canonicalize(&root).is_ok_and(|root| under(path, &root))
            {
                return Some(tier);
            }
        }
    }
    None
}
fn secret_paths(home: &Path) -> Vec<PathBuf> {
    type Cache = HashMap<PathBuf, (Instant, Vec<PathBuf>)>;
    static CACHE: OnceLock<Mutex<Cache>> = OnceLock::new();
    let mut cache = CACHE.get_or_init(Default::default).lock().unwrap();
    if let Some((at, paths)) = cache.get(home)
        && at.elapsed() < Duration::from_secs(5)
    {
        return paths.clone();
    }
    fn add(path: PathBuf, paths: &mut Vec<PathBuf>) {
        if let Ok(target) = std::fs::canonicalize(&path) {
            paths.push(target);
        }
        paths.push(path);
    }
    fn walk(home: &Path, dir: &Path, paths: &mut Vec<PathBuf>) {
        for entry in entries(dir) {
            let path = entry.path();
            if home_credential_name(home, &path) {
                add(path, paths);
            } else if entry.file_type().is_ok_and(|t| t.is_dir())
                && !policy()
                    .skip
                    .iter()
                    .any(|skip| folded(Path::new(&entry.file_name())) == folded(Path::new(skip)))
                && folded(&path) != folded(&home.join("runtime/sessions"))
            {
                walk(home, &path, paths);
            }
        }
    }
    let mut paths = vec![];
    fn walk_ssh(dir: &Path, paths: &mut Vec<PathBuf>) {
        for entry in entries(dir) {
            if entry.file_type().is_ok_and(|t| t.is_dir())
                || private_key(&entry.file_name().to_string_lossy())
            {
                add(entry.path(), paths);
            }
        }
    }
    walk(home, home, &mut paths);
    if let Some(user) = std::env::var_os("HOME") {
        let user = PathBuf::from(user);
        walk_ssh(&user.join(".ssh"), &mut paths);
        for local in &policy().user {
            add(user.join(local), &mut paths);
        }
    }
    // Byte order, as the extension sorts, so both profiles list filters alike.
    paths.sort_by(|a, b| a.as_os_str().cmp(b.as_os_str()));
    paths.dedup();
    cache.insert(home.to_owned(), (Instant::now(), paths.clone()));
    paths
}
fn bwrap() -> Option<&'static Path> {
    static BWRAP: OnceLock<Option<PathBuf>> = OnceLock::new();
    BWRAP
        .get_or_init(|| {
            if !cfg!(target_os = "linux") {
                return None;
            }
            let path = std::env::var_os("PATH").and_then(|p| {
                std::env::split_paths(&p)
                    .map(|d| d.join("bwrap"))
                    .find(|p| p.is_file())
            })?;
            let mut child = std::process::Command::new(&path)
                .args([
                    "--die-with-parent",
                    "--unshare-pid",
                    "--ro-bind",
                    "/",
                    "/",
                    "--proc",
                    "/proc",
                    "--",
                    "/usr/bin/env",
                    "true",
                ])
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .ok()?;
            // A hung probe must not hold the daemon; the extension gives it 5 s too.
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                match child.try_wait() {
                    Ok(Some(status)) => return status.success().then_some(path),
                    Ok(None) if Instant::now() < deadline => {
                        std::thread::sleep(Duration::from_millis(20))
                    }
                    _ => {
                        let _ = child.kill();
                        let _ = child.wait();
                        return None;
                    }
                }
            }
        })
        .as_deref()
}
/// The OS sandbox shell and code children run in, for `hexbot.info`.
pub fn sandbox() -> Option<&'static str> {
    if cfg!(target_os = "macos") {
        Some("sandbox-exec")
    } else if cfg!(windows) {
        Some("appcontainer")
    } else {
        bwrap().map(|_| "bubblewrap")
    }
}
/// macOS always sandboxes (sandbox-exec fails closed). Elsewhere only bubblewrap does.
pub fn isolation_available() -> bool {
    sandbox().is_some()
}
/// Approval card text for code that would run without a sandbox.
pub const UNSANDBOXED_REASON: &str = "Hexbot has no OS sandbox on this system, so this code can read any file you can, including credentials. Install bubblewrap and restart the daemon to restore isolation.";
pub fn warn_unavailable_isolation() {
    if isolation_available() {
        return;
    }
    static WARN: std::sync::Once = std::sync::Once::new();
    WARN.call_once(|| {
        eprintln!(
            "Hexbot has no OS sandbox on this system (bubblewrap is missing or cannot start). Shell commands and scripts can read any file you can. Manual and Auto ask before every shell command and code run, and scheduled scripts refuse to run. Install bubblewrap and restart the daemon to restore isolation."
        )
    });
}
/// Unattended scripts always require OS isolation.
pub fn require_isolation() -> Result<()> {
    if isolation_available() {
        return Ok(());
    }
    Err(Error::new(
        4302,
        "No OS sandbox is available, so scheduled scripts cannot run. Install bubblewrap and restart the daemon.",
    ))
}
fn quoted(path: impl AsRef<str>) -> String {
    serde_json::to_string(path.as_ref()).unwrap()
}
/// The extension's escape set, so the profiles compare equal.
fn regex_escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        if ".*+?^${}()|[]\\".contains(c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}
// Seatbelt regexes use character pairs for the platform's case policy.
fn sandbox_regex(source: &str) -> String {
    source
        .chars()
        .map(|c| {
            if FOLD_CASE && c.is_ascii_alphabetic() {
                format!("[{}{}]", c.to_ascii_lowercase(), c.to_ascii_uppercase())
            } else {
                c.to_string()
            }
        })
        .collect()
}
struct Layout {
    roots: Vec<PathBuf>,
    paths: Vec<PathBuf>,
    writable: Vec<PathBuf>,
    denied: Vec<PathBuf>,
    confine: Option<Confinement>,
}
/// Codex's workspace sandbox for a section's code in Manual and Auto: no
/// network, no host Unix sockets, no signals outside it, writes only inside the
/// workspace (none in Manual) and to a few device files, and shell profiles
/// and login items read-only even inside it. On Linux /run and /tmp are
/// private. Matches isolation.ts.
const DEVICES: [&str; 5] = [
    "/dev/null",
    "/dev/zero",
    "/dev/stdout",
    "/dev/stderr",
    "/dev/dtracehelper",
];
struct Confinement {
    writable: Vec<PathBuf>,
    config: Vec<PathBuf>,
    protected: WorkspaceProtected,
    readable: Vec<PathBuf>,
}
fn confine(workspace: &[PathBuf], search: &[PathBuf]) -> Result<Confinement> {
    let mut writable: Vec<PathBuf> = vec![];
    for path in workspace
        .iter()
        .filter_map(|p| std::fs::canonicalize(p).ok())
    {
        if !writable.contains(&path) {
            writable.push(path);
        }
    }
    let mut config: Vec<PathBuf> = vec![];
    for root in policy()
        .write
        .ask
        .iter()
        .filter_map(|entry| policy_root(entry))
    {
        let real = real_root(&root)?;
        for path in [root, real] {
            if !config.contains(&path) {
                config.push(path);
            }
        }
    }
    Ok(Confinement {
        writable,
        config,
        protected: workspace_protected(search, WORKSPACE_DIRS)?,
        readable: search
            .iter()
            .filter_map(|p| std::fs::canonicalize(p).ok())
            .fold(vec![], |mut paths, p| {
                if !paths.contains(&p) {
                    paths.push(p);
                }
                paths
            }),
    })
}
/// A path that does not exist yet resolves through its existing parent, and a
/// dangling link to where its target would be. Matches isolation.ts.
const LINK_HOPS: usize = 40;
fn real_root(path: &Path) -> std::io::Result<PathBuf> {
    real_root_after(path, 0)
}
fn real_root_after(path: &Path, hops: usize) -> std::io::Result<PathBuf> {
    match std::fs::canonicalize(path) {
        Ok(path) => Ok(path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            match (path.parent(), path.file_name()) {
                (Some(parent), Some(name)) => match std::fs::read_link(path) {
                    Ok(link) if hops < LINK_HOPS => {
                        real_root_after(&real_root(parent)?.join(link), hops + 1)
                    }
                    _ => Ok(real_root(parent)?.join(name)),
                },
                _ => Err(error),
            }
        }
        Err(error) => Err(error),
    }
}
/// Credential stores are read-only for every program a command starts.
fn denied_writes() -> Result<Vec<PathBuf>> {
    let mut denied: Vec<PathBuf> = vec![];
    for root in policy()
        .write
        .deny
        .iter()
        .filter_map(|entry| policy_root(entry))
    {
        let real = real_root(&root)?;
        for path in [root, real] {
            if !denied.contains(&path) {
                denied.push(path);
            }
        }
    }
    Ok(denied)
}
/// Keychains and browser profiles (cookies, saved passwords). Unreadable in
/// Manual and Auto and to the file tools; an approved full-access command may
/// read them.
fn read_denied() -> Vec<PathBuf> {
    type ReadCache = HashMap<OsString, (Instant, Vec<PathBuf>)>;
    static CACHE: OnceLock<Mutex<ReadCache>> = OnceLock::new();
    let user = std::env::var_os("HOME").unwrap_or_default();
    let mut cache = CACHE.get_or_init(Default::default).lock().unwrap();
    if let Some((at, paths)) = cache.get(&user)
        && at.elapsed() < Duration::from_secs(5)
    {
        return paths.clone();
    }
    let mut denied = vec![];
    for root in policy()
        .read_deny
        .iter()
        .filter_map(|entry| policy_root(entry))
    {
        let real = real_root(&root).unwrap_or_else(|_| root.clone());
        for path in [root, real] {
            if !denied.contains(&path) {
                denied.push(path);
            }
        }
    }
    cache.insert(user, (Instant::now(), denied.clone()));
    denied
}
/// Inside the workspace sandbox git's own folders are read-only, as in Codex: a
/// hook, config or gitdir written there would run outside the sandbox on the
/// user's next commit. Project secrets are unreadable there too. Seatbelt matches
/// these names wherever they appear, including ones created later; bubblewrap
/// cannot match names, so on Linux the workspace is searched when a program
/// starts, a few levels deep. The search reads at most WORKSPACE_DIRS folders
/// and WORKSPACE_ENTRIES entries for each of them in all (50,000), so a huge
/// flat folder cannot stall it either. Matches isolation.ts.
const WORKSPACE_DEPTH: usize = 3;
const WORKSPACE_DIRS: usize = 1000;
const WORKSPACE_ENTRIES: usize = 50;
fn git_dir_regex() -> String {
    format!("/{}(/|$)", regex_escape(".git"))
}
const SCAN_REASON: &str = "The workspace safety scan exceeded its directory budget, so this code cannot run in the sandbox. Choose a smaller workspace.";
const SCAN_FILE_REASON: &str = "The workspace safety scan reached its directory budget, so Git protection is partial. Approve this file change only if you trust its destination.";
/// Paths in the order they were found, each once.
#[derive(Default)]
struct PathSet {
    list: Vec<PathBuf>,
    seen: HashSet<PathBuf>,
}
impl PathSet {
    fn insert(&mut self, path: PathBuf) {
        if self.seen.insert(path.clone()) {
            self.list.push(path);
        }
    }
}
impl std::ops::Deref for PathSet {
    type Target = [PathBuf];
    fn deref(&self) -> &[PathBuf] {
        &self.list
    }
}
/// git: Git metadata, config files and configured folders, as named and as real
/// paths. worktrees: the folders their repositories belong to. files: targets
/// Git reads as files (includes). links: symbolic links inside the scanned
/// roots on the way to any of them. cause: why Git configuration could not be
/// scanned, when a limit stopped it.
#[derive(Default)]
struct WorkspaceProtected {
    git: PathSet,
    secrets: Vec<PathBuf>,
    worktrees: PathSet,
    files: PathSet,
    links: PathSet,
    exhausted: bool,
    failure: bool,
    cause: Option<String>,
}
fn add_path(paths: &mut PathSet, path: &Path) -> Result<()> {
    paths.insert(path.to_owned());
    paths.insert(real_root(path)?);
    Ok(())
}
/// Inside a writable root, as the sandboxes and file tools compare paths.
fn within(path: &Path, roots: &[PathBuf]) -> bool {
    roots.iter().any(|root| under(path, root))
}
/// A command can create the files the scan reads (.git pointers, commondir,
/// configs and their includes), so they are opened without blocking and read
/// only when they are small regular files: a FIFO or device would stall the
/// daemon. Anything else stays locked but unread, which Git cannot load hooks
/// from either. Matches isolation.ts.
const GIT_FILE_BYTES: u64 = 1 << 20;
const GIT_TIMEOUT: Duration = Duration::from_secs(5);
/// Includes are followed at most this deep. A scan reads each config file once
/// and visits it once per worktree. Beyond the repository and user configs it
/// reads at most GIT_INCLUDES include files for one worktree, which real
/// configurations never reach, and GIT_SCAN_INCLUDES in all, and visits at
/// most GIT_CONFIG_STEPS settings, so include cycles and fan-out cannot stall
/// it.
const GIT_INCLUDE_DEPTH: usize = 10;
const GIT_INCLUDES: usize = 64;
const GIT_SCAN_INCLUDES: usize = 256;
const GIT_CONFIG_STEPS: usize = 10000;
fn regular_file(path: &Path) -> Result<Option<Vec<u8>>> {
    use std::io::Read;
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK);
    }
    let file = match options.open(path) {
        Ok(file) => file,
        Err(error) if crate::osutil::absent_path(&error) => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Ok(None);
    }
    if metadata.len() > GIT_FILE_BYTES {
        return Err(Error::new(5240, "Git metadata is too large to scan."));
    }
    let mut bytes = vec![];
    file.take(metadata.len() + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > metadata.len() {
        return Err(Error::new(
            5240,
            "Git metadata changed while it was scanned.",
        ));
    }
    Ok(Some(bytes))
}
/// Hook settings by a hash of the config contents, so unchanged repositories
/// cost no Git process. The least recently used entry goes first, and the
/// cache holds more configs than a scan of the largest workspace reads.
const GIT_CACHE: usize = 2048;
fn config_entries(text: &[u8]) -> Result<Vec<(String, String)>> {
    use sha2::Digest;
    type ConfigCache = (u64, HashMap<[u8; 32], (u64, Vec<(String, String)>)>);
    static CACHE: OnceLock<Mutex<ConfigCache>> = OnceLock::new();
    let cache = CACHE.get_or_init(Default::default);
    let key: [u8; 32] = sha2::Sha256::digest(text).into();
    {
        let mut cache = cache.lock().unwrap();
        let (clock, entries) = &mut *cache;
        if let Some((used, entries)) = entries.get_mut(&key) {
            *clock += 1;
            *used = *clock;
            return Ok(entries.clone());
        }
    }
    let unreadable = || Error::new(5240, "Git hook configuration could not be read.");
    // git config only parses; it does not run hooks, aliases or commands. Use
    // system Git, never a workspace executable from PATH, and give it the bytes
    // already read: with --no-includes it opens no file, so includes are
    // followed here. It is killed at the deadline.
    let git = if cfg!(windows) { "git" } else { "/usr/bin/git" };
    let mut child = std::process::Command::new(git)
        .args([
            "config",
            "--no-includes",
            "--null",
            "--file",
            "-",
            "--path",
            "--get-regexp",
            r"^(core.hookspath|include.path|includeif\..*\.path)$",
        ])
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .env("HOME", std::env::var_os("HOME").unwrap_or_default())
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|_| unreadable())?;
    let pid = child.id();
    let mut stdin = child.stdin.take().ok_or_else(unreadable)?;
    let input = text.to_vec();
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        use std::io::Write;
        let _ = stdin.write_all(&input);
        drop(stdin);
        let _ = sender.send(child.wait_with_output());
    });
    let output = match receiver.recv_timeout(GIT_TIMEOUT) {
        Ok(output) => output.map_err(|_| unreadable())?,
        Err(_) => {
            // The waiting thread has not reaped the child, so the pid is still ours.
            crate::osutil::terminate(pid);
            let _ = receiver.recv();
            return Err(unreadable());
        }
    };
    // Exit 1 without a message is "no matching settings"; a missing Git (the
    // macOS shim without developer tools) also exits 1, but says so.
    if !output.status.success() && !(output.status.code() == Some(1) && output.stderr.is_empty()) {
        return Err(unreadable());
    }
    let found: Vec<_> = String::from_utf8_lossy(&output.stdout)
        .split('\0')
        .filter_map(|field| field.split_once('\n'))
        .filter(|(key, _)| !key.is_empty())
        .map(|(key, value)| (key.to_owned(), value.to_owned()))
        .collect();
    let mut cache = cache.lock().unwrap();
    let (clock, entries) = &mut *cache;
    if entries.len() >= GIT_CACHE
        && let Some(oldest) = entries
            .iter()
            .min_by_key(|(_, (used, _))| *used)
            .map(|(key, _)| *key)
    {
        entries.remove(&oldest);
    }
    *clock += 1;
    entries.insert(key, (*clock, found.clone()));
    Ok(found)
}
#[cfg(test)]
thread_local! {
    // The user's Git config files for one test thread. Tests read none unless
    // they choose some, so the developer's own configuration never applies.
    static TEST_GIT_CONFIGS: std::cell::RefCell<Vec<PathBuf>> = const { std::cell::RefCell::new(vec![]) };
}
/// The user's own Git configuration applies to every repository: a global
/// core.hooksPath such as .githooks names a folder in each worktree. The files
/// are the ones Git reads: GIT_CONFIG_GLOBAL replaces ~/.gitconfig and the XDG
/// file, and GIT_CONFIG_SYSTEM or GIT_CONFIG_NOSYSTEM choose the system file,
/// which is otherwise /etc/gitconfig or Homebrew's. Other Git builds keep a
/// system file elsewhere; it is not read. Matches isolation.ts.
const SYSTEM_GIT_CONFIGS: [&str; 3] = [
    "/etc/gitconfig",
    "/opt/homebrew/etc/gitconfig",
    "/usr/local/etc/gitconfig",
];
fn git_config_files(var: impl Fn(&str) -> Option<OsString>) -> Vec<PathBuf> {
    let set = |name: &str| {
        var(name)
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
    };
    let mut files = match (set("GIT_CONFIG_GLOBAL"), set("HOME")) {
        (Some(global), _) => vec![global],
        (None, Some(home)) => vec![
            home.join(".gitconfig"),
            set("XDG_CONFIG_HOME")
                .unwrap_or_else(|| home.join(".config"))
                .join("git/config"),
        ],
        (None, None) => vec![],
    };
    let system = set("GIT_CONFIG_NOSYSTEM").is_none_or(|value| {
        ["0", "false", "no", "off"]
            .iter()
            .any(|off| value.as_os_str().eq_ignore_ascii_case(off))
    });
    if system {
        match set("GIT_CONFIG_SYSTEM") {
            Some(path) => files.push(path),
            None => files.extend(SYSTEM_GIT_CONFIGS.iter().map(PathBuf::from)),
        }
    }
    files.retain(|file| file.is_absolute());
    files
}
fn global_git_configs() -> Vec<PathBuf> {
    #[cfg(test)]
    return TEST_GIT_CONFIGS.with(|files| files.borrow().clone());
    #[cfg(not(test))]
    git_config_files(|name| std::env::var_os(name))
}
/// Config files read during one scan, and the include files and settings seen.
#[derive(Default)]
struct GitConfigs {
    roots: Vec<PathBuf>,
    files: HashMap<PathBuf, Vec<(String, String)>>,
    includes: HashSet<PathBuf>,
    steps: usize,
}
impl GitConfigs {
    fn read(&mut self, file: &Path) -> Result<(PathBuf, Vec<(String, String)>)> {
        let real = real_root(file)?;
        if let Some(found) = self.files.get(&real) {
            return Ok((real, found.clone()));
        }
        let found = match regular_file(&real)? {
            Some(text) => config_entries(&text)?,
            None => vec![],
        };
        self.files.insert(real.clone(), found.clone());
        Ok((real, found))
    }
}
/// The real path a pointer or setting names. A command could replace a link
/// inside the scanned roots on the way to it and so swap the metadata a later
/// ordinary git command trusts, so those links are recorded.
fn pointer_target(
    protected: &mut WorkspaceProtected,
    configs: &GitConfigs,
    base: &Path,
    value: &str,
) -> Result<PathBuf> {
    let path = base.join(value);
    linked(protected, configs, &path, &[]);
    Ok(real_root(&path)?)
}
/// The path is walked as the kernel walks it, so a `..` after a link leaves the
/// link's target, not the link's folder. Links inside locked Git metadata
/// (`exempt`) are locked with it.
fn linked(
    protected: &mut WorkspaceProtected,
    configs: &GitConfigs,
    path: &Path,
    exempt: &[PathBuf],
) {
    use std::path::Component;
    let parts = |path: &Path| -> Vec<PathBuf> {
        path.components()
            .rev()
            .map(|part| PathBuf::from(part.as_os_str()))
            .collect()
    };
    let mut rest = parts(path);
    let mut dir = PathBuf::from("/");
    let mut hops = 0;
    while let Some(part) = rest.pop() {
        match part.components().next() {
            Some(Component::RootDir) => dir = PathBuf::from("/"),
            Some(Component::ParentDir) => {
                dir.pop();
            }
            Some(Component::Normal(name)) => {
                let next = dir.join(name);
                match std::fs::read_link(&next) {
                    Ok(link) if hops < LINK_HOPS => {
                        hops += 1;
                        if within(&next, &configs.roots)
                            && !configs
                                .roots
                                .iter()
                                .any(|root| folded(root) == folded(&next))
                            && !within(&next, exempt)
                        {
                            protected.links.insert(next);
                        }
                        rest.extend(parts(&link));
                    }
                    _ => dir = next,
                }
            }
            _ => {}
        }
    }
}
/// Settings from the user's own configuration matter only where they name a
/// folder inside the scanned roots; the rest is outside the sandbox already.
fn git_hooks(
    protected: &mut WorkspaceProtected,
    configs: &mut GitConfigs,
    dirs: &[PathBuf],
    worktree: &Path,
) -> Result<()> {
    let mut queue: Vec<(PathBuf, usize, bool)> = dirs
        .iter()
        .flat_map(|dir| [dir.join("config"), dir.join("config.worktree")])
        .map(|file| (file, 0, false))
        .chain(global_git_configs().into_iter().map(|file| (file, 0, true)))
        .collect();
    let mut visited = HashSet::new();
    let mut own = HashSet::new();
    let mut i = 0;
    while let Some((file, depth, user)) = queue.get(i).cloned() {
        i += 1;
        let (real, found) = configs.read(&file)?;
        if !visited.insert(real) {
            continue;
        }
        for (key, value) in found {
            if value.is_empty() {
                continue;
            }
            configs.steps += 1;
            if configs.steps > GIT_CONFIG_STEPS {
                return Err(stop_scan(
                    protected,
                    format!(
                        "Git configuration in the workspace has more than {GIT_CONFIG_STEPS} settings"
                    ),
                ));
            }
            let hooks_path = key == "core.hookspath";
            let base = if hooks_path {
                worktree
            } else {
                file.parent().unwrap()
            };
            let target = pointer_target(protected, configs, base, &value)?;
            if !hooks_path && !own.contains(&target) {
                if own.len() >= GIT_INCLUDES {
                    return Err(stop_scan(
                        protected,
                        format!(
                            "Git configuration for {} includes more than {GIT_INCLUDES} files",
                            crate::install_ownership::shell_quote(&worktree.to_string_lossy())
                        ),
                    ));
                }
                own.insert(target.clone());
                if !configs.includes.contains(&target)
                    && configs.includes.len() >= GIT_SCAN_INCLUDES
                {
                    return Err(stop_scan(
                        protected,
                        format!(
                            "Git configuration in the workspace includes more than {GIT_SCAN_INCLUDES} files"
                        ),
                    ));
                }
                configs.includes.insert(target.clone());
            }
            if !user || within(&target, &configs.roots) {
                add_path(&mut protected.git, &target)?;
                if !hooks_path {
                    protected.files.insert(target.clone());
                }
            }
            if !hooks_path && depth < GIT_INCLUDE_DEPTH {
                queue.push((target, depth + 1, user));
            }
        }
    }
    Ok(())
}
fn stop_scan(protected: &mut WorkspaceProtected, reason: String) -> Error {
    let error = Error::new(5240, reason.clone());
    protected.cause.get_or_insert(reason);
    error
}
fn git_metadata(
    protected: &mut WorkspaceProtected,
    configs: &mut GitConfigs,
    path: &Path,
    worktree: &Path,
) -> Result<()> {
    add_path(&mut protected.git, path)?;
    protected.worktrees.insert(real_root(worktree)?);
    linked(protected, configs, path, &[]);
    let mut dir = path.to_owned();
    if !path.is_dir() {
        let text = regular_file(path)?.unwrap_or_default();
        let text = String::from_utf8_lossy(&text);
        let Some(pointer) = text.lines().find_map(|line| line.strip_prefix("gitdir:")) else {
            return Ok(()); // Cache markers and other files stay locked.
        };
        dir = pointer_target(protected, configs, path.parent().unwrap(), pointer.trim())?;
        add_path(&mut protected.git, &dir)?;
    }
    let mut dirs = vec![];
    if let Some(common) = regular_file(&dir.join("commondir"))? {
        let common = String::from_utf8_lossy(&common);
        let common = common.trim();
        if !common.is_empty() {
            let target = pointer_target(protected, configs, &dir, common)?;
            add_path(&mut protected.git, &target)?;
            dirs.push(target);
        }
    }
    dirs.push(dir);
    // The metadata folder itself is locked, but a hooks folder or config in it
    // can be a link to a folder or file in the workspace, which is locked too,
    // as is every link in the workspace on the way there.
    let mut exempt = vec![];
    for git_dir in &dirs {
        exempt.push(git_dir.clone());
        exempt.push(real_root(git_dir)?);
    }
    for git_dir in &dirs {
        for name in ["hooks", "config", "config.worktree", "commondir"] {
            let entry = git_dir.join(name);
            linked(protected, configs, &entry, &exempt);
            add_path(&mut protected.git, &entry)?;
            if name != "hooks" {
                protected.files.insert(real_root(&entry)?);
            }
        }
    }
    git_hooks(protected, configs, &dirs, worktree)
}
/// A folder with HEAD and objects whose name ends in .git is Git metadata. A
/// literal .git belongs to the worktree around it; any other one is a bare
/// repository, its own worktree.
fn git_directory(path: &Path) -> bool {
    path.file_name()
        .is_some_and(|name| folded(Path::new(name)).to_string_lossy().ends_with(".git"))
        && path.join("HEAD").exists()
        && path.join("objects").exists()
}
fn bare_repository(path: &Path) -> bool {
    path.file_name()
        .is_some_and(|name| folded(Path::new(name)) != Path::new(".git"))
        && git_directory(path)
}
fn record_metadata(
    protected: &mut WorkspaceProtected,
    configs: &mut GitConfigs,
    path: &Path,
    worktree: &Path,
) {
    if git_metadata(protected, configs, path, worktree).is_err() {
        protected.failure = true;
    }
}
fn workspace_protected(roots: &[PathBuf], limit: usize) -> Result<WorkspaceProtected> {
    let mut protected = WorkspaceProtected::default();
    let mut configs = GitConfigs {
        roots: roots
            .iter()
            .filter_map(|root| real_root(root).ok())
            .collect(),
        ..Default::default()
    };
    let mut queue = VecDeque::new();
    let mut seen = HashSet::new();
    for root in roots
        .iter()
        .filter(|root| *root != Path::new("/tmp") && **root != std::env::temp_dir())
    {
        let dir = match real_root(root) {
            Ok(dir) => dir,
            Err(_) => {
                protected.failure = true;
                continue;
            }
        };
        if bare_repository(&dir) {
            record_metadata(&mut protected, &mut configs, &dir, &dir);
        }
        for parent in dir.ancestors().filter(|p| p.parent().is_some()) {
            let marker = parent.join(".git");
            if marker.exists() {
                record_metadata(&mut protected, &mut configs, &marker, parent);
            }
        }
        queue.push_back((dir, 0));
    }
    let mut entries_left = limit * WORKSPACE_ENTRIES;
    while let Some((dir, depth)) = queue.pop_front() {
        if seen.contains(&dir) {
            continue;
        }
        if seen.len() >= limit {
            protected.exhausted = true;
            break;
        }
        seen.insert(dir.clone());
        // Record every entry before visiting any child, even at the budget boundary.
        let mut list = vec![];
        match std::fs::read_dir(&dir) {
            Ok(entries) => {
                for entry in entries {
                    if list.len() >= entries_left {
                        protected.exhausted = true;
                        break;
                    }
                    match entry {
                        Ok(entry) => list.push(entry),
                        Err(_) => protected.failure = true,
                    }
                }
            }
            Err(_) => {
                protected.failure = true;
                continue;
            }
        }
        if protected.exhausted {
            break;
        }
        entries_left -= list.len();
        list.sort_by_key(|entry| entry.file_name());
        for entry in list {
            let path = entry.path();
            let name = entry.file_name();
            let name = name.to_string_lossy();
            let git_name = folded(Path::new(name.as_ref()));
            if git_name == Path::new(".git") {
                record_metadata(&mut protected, &mut configs, &path, &dir);
            } else if bare_repository(&path) {
                record_metadata(&mut protected, &mut configs, &path, &path);
            } else if secret_file_name(&name) && !path.is_dir() {
                // A link that cannot be resolved (a loop) is masked by name alone.
                if !protected.secrets.contains(&path) {
                    protected.secrets.push(path.clone());
                }
                if let Ok(real) = real_root(&path)
                    && !protected.secrets.contains(&real)
                {
                    protected.secrets.push(real);
                }
            } else if entry.file_type().is_ok_and(|kind| kind.is_dir())
                && depth < WORKSPACE_DEPTH
                && !policy()
                    .skip
                    .iter()
                    .any(|skip| folded(Path::new(name.as_ref())) == folded(Path::new(skip)))
            {
                queue.push_back((path, depth + 1));
            }
        }
    }
    Ok(protected)
}
fn because(scan: &WorkspaceProtected) -> String {
    scan.cause
        .as_ref()
        .map(|cause| format!(" because {cause}"))
        .unwrap_or_default()
}
pub(crate) fn git_write_protected(path: &Path, roots: &[PathBuf]) -> Result<bool> {
    if path.ancestors().any(git_directory) {
        return Ok(true);
    }
    let scan = workspace_protected(roots, WORKSPACE_DIRS)?;
    // A repository config can name any folder as its hooks path. One that holds
    // a writable root (hooksPath = / or the home) would refuse every write, so it
    // is ignored here as it is in the sandboxes; the folders it can name outside
    // the workspace stay refused.
    let writable: Vec<PathBuf> = roots
        .iter()
        .cloned()
        .chain([std::env::temp_dir(), PathBuf::from("/tmp")])
        .map(|root| real_root(&root).unwrap_or(root))
        .collect();
    if scan
        .git
        .iter()
        .filter(|target| {
            !writable
                .iter()
                .any(|root| under(root, target) && folded(root) != folded(target))
        })
        .any(|root| under(path, root) || under(root, path))
    {
        return Ok(true);
    }
    if scan.failure {
        return Err(Error::new(
            5240,
            format!(
                "Git metadata or hook configuration could not be scanned{}. Approve this file change only if you trust its destination.",
                because(&scan)
            ),
        ));
    }
    if scan.exhausted {
        return Err(Error::new(5240, SCAN_FILE_REASON));
    }
    Ok(false)
}
/// Repository files a command can write choose some Git targets (gitdir:,
/// commondir, core.hooksPath, include.path), so only real paths inside a
/// writable root are locked: anything else is read-only already, and binding or
/// locking it could cover a mask (hooksPath = ~/.config/google-chrome) or the
/// whole file system (hooksPath = /). On Linux a missing target is pinned at its
/// nearest existing parent inside the writable root. A folder inside a
/// repository is fine (.husky for a missing .husky/_), and so is one already
/// locked, but pinning a repository's own folder, a writable root or a folder
/// holding one would make all of it read-only, so the program cannot run in the
/// sandbox, and creating the targets restores it. A symbolic link on the way to
/// Git metadata inside a writable root could be replaced, which bubblewrap
/// cannot prevent, so that stops it too; Seatbelt locks the link itself.
/// Matches isolation.ts, which asks for an approved full_access retry instead.
fn missing_git_reason(missing: &[(PathBuf, bool)]) -> String {
    let quote = |path: &PathBuf| crate::install_ownership::shell_quote(&path.to_string_lossy());
    let one = missing.len() == 1;
    let files: Vec<&PathBuf> = missing
        .iter()
        .filter(|(_, file)| *file)
        .map(|(path, _)| path)
        .collect();
    let mut dirs: Vec<PathBuf> = vec![];
    for dir in missing
        .iter()
        .filter(|(_, file)| !*file)
        .map(|(path, _)| path.clone())
        .chain(
            files
                .iter()
                .filter_map(|file| file.parent())
                .filter(|dir| !dir.exists())
                .map(Path::to_owned),
        )
    {
        if !dirs.contains(&dir) {
            dirs.push(dir);
        }
    }
    let mut create = vec![];
    if !dirs.is_empty() {
        create.push(format!(
            "mkdir -p {}",
            dirs.iter().map(quote).collect::<Vec<_>>().join(" ")
        ));
    }
    if !files.is_empty() {
        create.push(format!(
            "touch {}",
            files
                .iter()
                .map(|file| quote(file))
                .collect::<Vec<_>>()
                .join(" ")
        ));
    }
    format!(
        "Git is set to load hooks or settings from {}, which {} not exist yet. The sandbox could keep {} read-only only by making a whole repository or the workspace read-only, so this code cannot run in the sandbox. Once {} ({}), it runs in the sandbox again.",
        missing
            .iter()
            .map(|(path, _)| quote(path))
            .collect::<Vec<_>>()
            .join(", "),
        if one { "does" } else { "do" },
        if one { "it" } else { "them" },
        if one { "it exists" } else { "they exist" },
        create.join(" && ")
    )
}
fn linked_git_reason(links: &[PathBuf]) -> String {
    let one = links.len() == 1;
    format!(
        "Git metadata in the workspace is reached through {} ({}) that a command could replace, so this code cannot run in the sandbox. Once {} replaced by the folder or file {} to, it runs in the sandbox again.",
        if one {
            "a symbolic link"
        } else {
            "symbolic links"
        },
        links
            .iter()
            .map(|path| crate::install_ownership::shell_quote(&path.to_string_lossy()))
            .collect::<Vec<_>>()
            .join(", "),
        if one { "it is" } else { "they are" },
        if one { "it points" } else { "they point" }
    )
}
fn locked_git(scan: &WorkspaceProtected, roots: &[PathBuf], pin: bool) -> Result<Vec<PathBuf>> {
    let mut locked = PathSet::default();
    let mut missing: Vec<(PathBuf, bool)> = vec![];
    let holders: Vec<PathBuf> = roots.iter().chain(scan.worktrees.iter()).cloned().collect();
    // Only targets that are themselves locked can hold a pinned folder.
    let present: Vec<PathBuf> = scan
        .git
        .iter()
        .filter_map(|path| real_root(path).ok())
        .filter(|real| real.exists() && within(real, roots))
        .collect();
    for path in scan.git.iter() {
        let Ok(mut real) = real_root(path) else {
            continue;
        };
        let target = real.clone();
        while pin && !real.exists() {
            match real.parent() {
                Some(parent) if within(parent, roots) => real = parent.to_owned(),
                _ => break,
            }
        }
        if pin
            && real != target
            && within(&real, roots)
            && holders.iter().any(|holder| under(holder, &real))
            && !within(&real, &present)
        {
            if !missing.iter().any(|(path, _)| *path == target) {
                let file = scan.files.contains(&target);
                missing.push((target, file));
            }
            continue;
        }
        if within(&real, roots) && (!pin || real.exists()) {
            locked.insert(real);
        }
    }
    let links: Vec<PathBuf> = scan
        .links
        .iter()
        .filter(|link| {
            within(link, roots) && !roots.iter().any(|root| folded(root) == folded(link))
        })
        .cloned()
        .collect();
    if pin && !missing.is_empty() {
        return Err(Error::new(5240, missing_git_reason(&missing)));
    }
    if pin && !links.is_empty() {
        return Err(Error::new(5240, linked_git_reason(&links)));
    }
    for link in links {
        locked.insert(link);
    }
    // A path inside a locked folder is locked with it.
    let folded_locked: HashSet<PathBuf> = locked.iter().map(|path| folded(path)).collect();
    Ok(locked
        .list
        .into_iter()
        .filter(|path| {
            !path
                .ancestors()
                .skip(1)
                .filter(|dir| dir.parent().is_some())
                .any(|dir| folded_locked.contains(&folded(dir)))
        })
        .collect())
}
fn path_ancestors(paths: &[PathBuf]) -> Vec<PathBuf> {
    let mut ancestors = vec![];
    for path in paths {
        for dir in path.ancestors().skip(1).filter(|p| p.parent().is_some()) {
            if !ancestors.iter().any(|p| p == dir) {
                ancestors.push(dir.to_owned());
            }
        }
    }
    ancestors
}
/// Renaming an ancestor would carry a nested store (~/.config/gh) out from under
/// its rule, so the directories between the home and a store cannot be renamed
/// or removed either; creating siblings inside them stays allowed.
fn store_ancestors(denied: &[PathBuf]) -> Vec<PathBuf> {
    let Some(user) = std::env::var_os("HOME").map(PathBuf::from) else {
        return vec![];
    };
    let mut homes = vec![user.clone(), real_root(&user).unwrap_or(user)];
    homes.dedup();
    let mut ancestors: Vec<PathBuf> = vec![];
    for path in denied {
        for home in &homes {
            let mut dir = path.parent();
            while let Some(current) = dir.filter(|d| d.starts_with(home) && *d != home) {
                if !ancestors.iter().any(|a| a == current) {
                    ancestors.push(current.to_owned());
                }
                dir = current.parent();
            }
        }
    }
    ancestors
}
#[cfg(test)]
fn layout(home: &Path, writable: &[PathBuf], workspace: Option<&[PathBuf]>) -> Result<Layout> {
    layout_scanned(home, writable, workspace, workspace.unwrap_or_default())
}
fn layout_scanned(
    home: &Path,
    writable: &[PathBuf],
    workspace: Option<&[PathBuf]>,
    search: &[PathBuf],
) -> Result<Layout> {
    let mut roots = vec![home.to_owned(), std::fs::canonicalize(home)?];
    roots.dedup();
    let writable = writable
        .iter()
        .filter_map(|p| std::fs::canonicalize(p).ok())
        .filter(|p| roots.iter().any(|root| p != root && p.starts_with(root)))
        .collect();
    Ok(Layout {
        roots,
        paths: secret_paths(home),
        writable,
        denied: denied_writes()?,
        confine: workspace
            .map(|workspace| confine(workspace, search))
            .transpose()?,
    })
}
fn sandbox_profile(layout: &Layout) -> String {
    let mut filters = vec![];
    if let Some(user) = std::env::var_os("HOME") {
        let ssh = PathBuf::from(user).join(".ssh");
        let mut roots = vec![ssh.clone(), std::fs::canonicalize(&ssh).unwrap_or(ssh)];
        roots.dedup();
        for root in roots {
            filters.push(format!(
                "(require-all (subpath {}) (require-not (regex {})))",
                quoted(root.to_string_lossy()),
                quoted(sandbox_regex(&format!(
                    "^{}/{}",
                    regex_escape(&root.to_string_lossy()),
                    &policy().ssh_public[1..]
                )))
            ));
        }
    }
    for root in &layout.roots {
        let root = regex_escape(&root.to_string_lossy());
        for pattern in [
            format!("^{root}/(.*/)?{}", &policy().basename[1..]),
            format!("^{root}/{}", &policy().home[1..]),
        ] {
            filters.push(format!("(regex {})", quoted(sandbox_regex(&pattern))));
        }
    }
    for path in &layout.paths {
        filters.push(format!("(subpath {})", quoted(path.to_string_lossy())));
    }
    let inside_home = layout
        .roots
        .iter()
        .map(|p| format!("(subpath {})", quoted(p.to_string_lossy())))
        .collect::<Vec<_>>()
        .join(" ");
    let except_writable = if layout.writable.is_empty() {
        String::new()
    } else {
        format!(
            "(require-not (require-any {}))",
            layout
                .writable
                .iter()
                .map(|p| format!("(subpath {})", quoted(p.to_string_lossy())))
                .collect::<Vec<_>>()
                .join(" ")
        )
    };
    let stores = layout
        .denied
        .iter()
        .map(|p| {
            let path = quoted(p.to_string_lossy());
            format!(
                "(literal {path}) (subpath {path}) (regex {})",
                quoted(sandbox_regex(&format!(
                    "^{}(/|$)",
                    regex_escape(&p.to_string_lossy())
                )))
            )
        })
        .collect::<Vec<_>>()
        .join(" ");
    let ancestors = store_ancestors(&layout.denied)
        .iter()
        .map(|p| format!("(literal {})", quoted(p.to_string_lossy())))
        .collect::<Vec<_>>()
        .join(" ");
    let ancestors = if ancestors.is_empty() {
        String::new()
    } else {
        format!("(deny file-write-unlink {ancestors})")
    };
    let confine = layout.confine.as_ref().map_or_else(String::new, |confine| {
        let inside = DEVICES
            .iter()
            .map(|p| format!("(literal {})", quoted(p)))
            .chain(
                std::iter::once(Path::new("/dev/fd"))
                    .chain(confine.writable.iter().map(PathBuf::as_path))
                    .map(|p| format!("(subpath {})", quoted(p.to_string_lossy()))),
            )
            .collect::<Vec<_>>()
            .join(" ");
        let config = confine
            .config
            .iter()
            .map(|p| {
                let path = quoted(p.to_string_lossy());
                format!("(literal {path}) (subpath {path})")
            })
            .collect::<Vec<_>>()
            .join(" ");
        let secret_paths = confine.protected.secrets.iter().map(|p| format!("(subpath {})", quoted(p.to_string_lossy()))).collect::<Vec<_>>().join(" ");
        let browser_roots = read_denied();
        // Only pinning (Linux) can fail.
        let git = locked_git(&confine.protected, &confine.writable, false).unwrap_or_default();
        let locked = git.iter().map(|p| format!("(subpath {})", quoted(p.to_string_lossy()))).collect::<Vec<_>>().join(" ");
        let mut protected = browser_roots.clone();
        protected.extend(git.clone());
        protected.extend(confine.protected.secrets.clone());
        let parents = path_ancestors(&protected).iter().map(|p| format!("(literal {})", quoted(p.to_string_lossy()))).collect::<Vec<_>>().join(" ");
        let browsers = browser_roots
            .iter()
            .map(|p| {
                let path = quoted(p.to_string_lossy());
                format!(
                    "(literal {path}) (subpath {path}) (regex {})",
                    quoted(sandbox_regex(&format!(
                        "^{}(/|$)",
                        regex_escape(&p.to_string_lossy())
                    )))
                )
            })
            .collect::<Vec<_>>()
            .join(" ");
        let secret = format!(
            "(require-all (vnode-type REGULAR-FILE) (regex {}) (require-not (regex {})))",
            quoted(sandbox_regex(&format!("/{}", &policy().secret_file[1..]))),
            quoted(sandbox_regex(&policy().secret_file_example))
        );
        let git = quoted(sandbox_regex(&git_dir_regex()));
        format!(
            "(deny network-inbound)(deny network-outbound (remote ip))(deny network-outbound (remote unix-socket))(deny signal)(allow signal (target same-sandbox))(deny file-read* {stores} {browsers} {secret} {secret_paths})(deny file-write* (require-not (require-any {inside})))(deny file-write* {config})(deny file-write* {browsers} {secret} {secret_paths} {locked})(deny file-write-unlink {parents})(deny file-write* (regex {git}))"
        )
    });
    // Apple Events would let a program drive Finder or another app outside the sandbox.
    format!(
        "(version 1)(allow default)(deny process-exec (literal \"/usr/bin/open\") (literal \"/bin/launchctl\") (literal \"/usr/bin/osascript\"))(deny appleevent-send)(deny file-write* (require-all (require-any {inside_home}) {except_writable}))(deny file-write* {stores}){ancestors}{confine}(deny file-read* file-write* {})",
        filters.join(" ")
    )
}
fn bwrap_arguments(layout: &Layout) -> Result<Vec<OsString>> {
    if let Some(confine) = &layout.confine {
        if confine.protected.exhausted {
            return Err(Error::new(5240, SCAN_REASON));
        }
        if confine.protected.failure {
            return Err(Error::new(
                5240,
                format!(
                    "Git metadata or hook configuration could not be scanned{}, so this code cannot run in the sandbox.",
                    because(&confine.protected)
                ),
            ));
        }
    }
    let base: &[&str] = if layout.confine.is_some() {
        &[
            "--die-with-parent",
            "--new-session",
            "--unshare-pid",
            "--unshare-net",
            "--ro-bind",
            "/",
            "/",
            "--dev",
            "/dev",
            "--proc",
            "/proc",
            "--tmpfs",
            "/run",
            "--tmpfs",
            "/tmp",
        ]
    } else {
        &[
            "--die-with-parent",
            "--unshare-pid",
            "--bind",
            "/",
            "/",
            "--proc",
            "/proc",
        ]
    };
    let mut args: Vec<OsString> = base.iter().map(Into::into).collect();
    for path in layout
        .confine
        .iter()
        .flat_map(|c| &c.writable)
        .filter(|p| *p != Path::new("/tmp"))
    {
        args.extend(["--bind".into(), path.into(), path.into()]);
    }
    if let Some(confine) = &layout.confine {
        for path in &confine.readable {
            if !confine.writable.iter().any(|root| path.starts_with(root)) {
                args.extend(["--ro-bind".into(), path.into(), path.into()]);
            }
        }
    }
    for root in &layout.roots {
        args.extend(["--ro-bind".into(), root.into(), root.into()]);
    }
    for path in layout.writable.iter().filter(|path| {
        layout
            .confine
            .as_ref()
            .is_none_or(|c| c.writable.iter().any(|root| path.starts_with(root)))
    }) {
        args.extend(["--bind".into(), path.into(), path.into()]);
    }
    // Host binds come before every mask, so a later bind can never uncover one.
    if let Some(confine) = &layout.confine {
        let open: Vec<PathBuf> = confine
            .writable
            .iter()
            .filter(|p| *p != Path::new("/tmp"))
            .cloned()
            .collect();
        for path in locked_git(&confine.protected, &open, true)? {
            args.extend(["--ro-bind".into(), path.clone().into(), path.into()]);
        }
        for path in confine.config.iter().filter(|p| p.exists()) {
            args.extend(["--ro-bind".into(), path.into(), path.into()]);
        }
    }
    // A store that does not exist yet cannot be bound (bubblewrap would create the
    // mount point on the host).
    for path in layout.denied.iter().filter(|p| p.exists()) {
        if layout.confine.is_none() {
            args.extend(["--ro-bind".into(), path.into(), path.into()]);
        } else if path.is_dir() {
            args.extend([
                "--tmpfs".into(),
                path.into(),
                "--remount-ro".into(),
                path.into(),
            ]);
        } else {
            args.extend(["--ro-bind".into(), "/dev/null".into(), path.into()]);
        }
    }
    if let Some(confine) = &layout.confine {
        for path in read_denied().iter().filter(|p| p.exists()) {
            if path.is_dir() {
                args.extend([
                    "--tmpfs".into(),
                    path.into(),
                    "--remount-ro".into(),
                    path.into(),
                ]);
            } else {
                args.extend(["--ro-bind".into(), "/dev/null".into(), path.into()]);
            }
        }
        // A dangling link has nothing to read yet, and bubblewrap would create its target.
        for path in confine.protected.secrets.iter().filter(|p| p.exists()) {
            args.extend(["--ro-bind".into(), "/dev/null".into(), path.into()]);
        }
    }
    for path in layout.paths.iter().filter(|p| p.exists()) {
        if path.is_dir() {
            args.extend([
                "--tmpfs".into(),
                path.into(),
                "--remount-ro".into(),
                path.into(),
            ]);
        } else {
            args.extend(["--ro-bind".into(), "/dev/null".into(), path.into()]);
        }
    }
    Ok(args)
}
/// Neither sandbox caps process creation, so a workspace program may start at
/// most this many more processes than the user already runs.
const PROCESS_HEADROOM: usize = 512;
fn process_limit() -> Option<usize> {
    #[cfg(windows)]
    {
        // ActiveProcessLimit counts the sandboxed job only. The Unix cap is
        // every process this user already has, plus the same headroom.
        return crate::osutil::windows_process_count().map(|_| PROCESS_HEADROOM);
    }
    #[cfg(unix)]
    {
        // SAFETY: getuid has no preconditions and cannot fail.
        let uid = unsafe { libc::getuid() };
        // Linux charges the limit per thread, macOS per process.
        let threads: &[&str] = if cfg!(target_os = "linux") {
            &["-L"]
        } else {
            &[]
        };
        let listed = std::process::Command::new("ps")
            .args(threads)
            .args(["-U", &uid.to_string(), "-o", "pid="])
            .output()
            .ok()
            .filter(|o| o.status.success())?;
        Some(
            String::from_utf8_lossy(&listed.stdout)
                .lines()
                .filter(|l| !l.trim().is_empty())
                .count()
                + PROCESS_HEADROOM,
        )
    }
}
/// Which sandbox a program gets on top of the base layer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Confine {
    /// The base layer only: credential files hidden, the Hexbot home read-only.
    No,
    /// Codex's workspace sandbox, with `writable` and the temp folders writable (Auto).
    Workspace,
    /// The workspace sandbox with the workspace and temp folders read-only
    /// (Manual). Output exceptions must be granted explicitly by the caller.
    ReadOnly,
}
/// A sandboxed command.
pub fn isolated_command(
    home: &Path,
    program: &str,
    writable: &[PathBuf],
    confine: Confine,
) -> Result<tokio::process::Command> {
    isolated_command_with_outputs(home, program, writable, confine, &[])
}
/// Only approved execute_code calls grant an output exception in Manual mode.
pub(crate) fn isolated_command_with_outputs(
    home: &Path,
    program: &str,
    writable: &[PathBuf],
    confine: Confine,
    approved_outputs: &[PathBuf],
) -> Result<tokio::process::Command> {
    let workspace: Vec<PathBuf> = match confine {
        Confine::No => vec![],
        Confine::Workspace => writable
            .iter()
            .cloned()
            .chain([std::env::temp_dir(), PathBuf::from("/tmp")])
            .collect(),
        Confine::ReadOnly => approved_outputs
            .iter()
            .filter(|path| under(path, home))
            .cloned()
            .collect(),
    };
    let layout = layout_scanned(
        home,
        writable,
        (confine != Confine::No).then_some(workspace.as_slice()),
        writable,
    )?;
    #[cfg(windows)]
    {
        return windows_launch(home, program, confine, &layout);
    }
    #[cfg(unix)]
    let mut command = if cfg!(target_os = "macos") {
        let mut command = tokio::process::Command::new("/usr/bin/sandbox-exec");
        command.args(["-p", &sandbox_profile(&layout), program]);
        command
    } else if let Some(bwrap) = bwrap() {
        let mut command = tokio::process::Command::new(bwrap);
        command
            .args(bwrap_arguments(&layout)?)
            .arg("--")
            .arg(program);
        command
    } else {
        warn_unavailable_isolation();
        tokio::process::Command::new(program)
    };
    #[cfg(unix)]
    if confine != Confine::No {
        // The child applies the cap before it starts the sandbox, which keeps it;
        // a program that cannot be capped does not start.
        let limit = process_limit()
            .ok_or_else(|| Error::new(5240, "Hexbot could not cap processes for the sandbox."))?
            as libc::rlim_t;
        // SAFETY: setrlimit is async-signal-safe and touches only this child.
        unsafe {
            command.pre_exec(move || {
                let cap = libc::rlimit {
                    rlim_cur: limit,
                    rlim_max: limit,
                };
                if libc::setrlimit(libc::RLIMIT_NPROC, &cap) == 0 {
                    Ok(())
                } else {
                    Err(std::io::Error::last_os_error())
                }
            });
        }
    }
    #[cfg(unix)]
    return Ok(command);
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (home, program, confine, layout);
        Err(Error::new(5240, "Hexbot could not create the sandbox."))
    }
}

/// The plan the Windows helper applies. The helper rebuilds it from the home
/// and the writable roots, so a plan file on disk cannot widen the sandbox.
#[cfg(any(windows, test))]
pub(crate) fn confinement_plan(
    home: &Path,
    confine: Confine,
    writable: &[PathBuf],
) -> Result<crate::windows_sandbox::Plan> {
    let workspace: Vec<PathBuf> = match confine {
        Confine::No => vec![],
        Confine::Workspace => writable
            .iter()
            .cloned()
            .chain([std::env::temp_dir(), PathBuf::from("/tmp")])
            .collect(),
        Confine::ReadOnly => writable
            .iter()
            .filter(|path| under(path, home))
            .cloned()
            .collect(),
    };
    let layout = layout_scanned(
        home,
        writable,
        (confine != Confine::No).then_some(workspace.as_slice()),
        writable,
    )?;
    let must_cap = confine != Confine::No;
    let user = crate::osutil::user_home().unwrap_or_else(|| home.to_owned());
    let (mut allow_write, mut readable): (Vec<PathBuf>, Vec<PathBuf>) =
        if let Some(confinement) = &layout.confine {
            (
                confinement.writable.clone(),
                confinement
                    .readable
                    .iter()
                    .chain(&confinement.config)
                    .cloned()
                    .collect(),
            )
        } else {
            (vec![user.clone(), std::env::temp_dir()], vec![user])
        };
    allow_write.retain(|path| path.is_absolute());
    readable.retain(|path| path.is_absolute());
    let mut deny = layout.paths.clone();
    deny.extend(layout.denied.clone());
    let limit = if must_cap {
        process_limit().and_then(|count| u32::try_from(count).ok())
    } else {
        None
    };
    crate::windows_sandbox::prepare(
        confine == Confine::No,
        limit,
        must_cap,
        &allow_write,
        &readable,
        &deny,
        FOLD_CASE,
    )
}

#[cfg(windows)]
fn windows_launch(
    home: &Path,
    program: &str,
    confine: Confine,
    layout: &Layout,
) -> Result<tokio::process::Command> {
    let executable =
        std::env::current_exe().map_err(|error| Error::new(5240, error.to_string()))?;
    let mode = match confine {
        Confine::No => "base",
        Confine::Workspace => "workspace",
        Confine::ReadOnly => "readonly",
    };
    let mut command = tokio::process::Command::new(executable);
    // The helper is not the sandboxed command. Drop the daemon's secrets here.
    // It copies this environment into the AppContainer process, so a caller
    // may add provider auth afterwards and must not put secrets back.
    command
        .env_clear()
        .envs(std::env::vars().filter(|(name, _)| inherited_environment(name)))
        .arg("sandbox")
        .arg("--home")
        .arg(home)
        .arg("--confine")
        .arg(mode);
    if let Some(confinement) = &layout.confine {
        for path in &confinement.writable {
            if path.is_absolute() {
                command.arg("--write").arg(path);
            }
        }
    }
    command.arg("--").arg(program);
    Ok(command)
}
/// Variables every child may inherit. Provider keys, connector secrets, and runtime
/// injection variables (NODE_OPTIONS, BASH_ENV) are never on the list.
/// Winsock and `CreateProcess` need these. They are not credentials. AppContainer
/// still cannot read the profile paths the plan denies.
const WINDOWS_ESSENTIAL: &[&str] = &[
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "SYSTEMDRIVE",
];
pub fn inherited_environment(name: &str) -> bool {
    if cfg!(windows)
        && WINDOWS_ESSENTIAL
            .iter()
            .any(|allowed| allowed.eq_ignore_ascii_case(name))
    {
        return true;
    }
    name.to_ascii_uppercase().starts_with("LC_")
        || policy()
            .environment
            .iter()
            .any(|allowed| allowed.eq_ignore_ascii_case(name))
}
/// Display variables for children that open windows: the browser, the code runtime,
/// and MCP servers with an isolated environment.
pub fn display_environment(name: &str) -> bool {
    policy().display_environment.iter().any(|v| v == name)
}
pub fn shell_environment(command: &mut tokio::process::Command) {
    command
        .env_clear()
        .envs(std::env::vars().filter(|(name, _)| inherited_environment(name)));
}
pub fn desktop_environment(command: &mut tokio::process::Command) {
    command.env_clear().envs(
        std::env::vars()
            .filter(|(name, _)| inherited_environment(name) || display_environment(name)),
    );
}
/// Cheap floor for literal catastrophic Python actions. Approval remains required
/// for arbitrary code, including indirection that a textual guard cannot prove safe.
pub fn check_code(code: &str) -> Result<()> {
    let home = std::env::var("HOME").unwrap_or_default();
    let user = std::env::var("USER").unwrap_or_default();
    let expanded = code
        .replace("${HOME}", &home)
        .replace("$HOME", &home)
        .replace("${USER}", &user)
        .replace("$USER", &user);
    let code = expanded.as_str();
    static BLOCKS: OnceLock<regex::RegexSet> = OnceLock::new();
    let patterns = BLOCKS.get_or_init(|| regex::RegexSet::new([
        r#"(?:shutil\.)?rmtree\s*\(\s*["'](?:/|/Users|/home|/root|/etc|/usr|/var|/bin|/sbin|/boot|/lib|/private|/System|/Library|~)["']"#,
        r#"(?:shutil\.)?rmtree\s*\(\s*(?:os\.path\.expanduser\s*\(\s*["']~["']|Path\.home\s*\()"#,
        r#"\brm\s+(?:-[^\s]*\s+)*-[^\s]*[rR][^\s]*\s+(?:/|/Users|/home|/root|/etc|/usr|/var|/bin|/sbin|/boot|/lib|/private|/System|/Library|~|\$HOME)(?:["'\s]|$)"#,
        r#"\b(?:system|popen|run|call|check_call|check_output)\s*\(\s*(?:\[\s*)?["'](?:/[^"']*/)?(?:mkfs(?:\.[a-z0-9]+)?|shutdown|reboot|poweroff)(?:["'\s])"#,
        r#"\b(?:os\.)?kill\s*\(\s*-1\s*,"#,
        r#"\b(?:Popen|run|call|check_call|check_output)\s*\(\s*\[\s*["'](?:/[^"']*/)?rm["']\s*,\s*["']-[^"']*[rR][^"']*["']\s*,\s*["'](?:/|/home|/Users|/etc|/usr|/var|~)["']"#,
        r#"(?:shutil\.)?rmtree\s*\(\s*os\.environ\s*\[\s*["']HOME["']"#,
        r#"["']/dev/(?:sd[a-z]|disk[0-9]|nvme[0-9]|rdisk[0-9])"#,
    ]).unwrap());
    let literal_home = std::env::var("HOME").ok().is_some_and(|home| {
        regex::Regex::new(&format!(
            r#"(?:rmtree\s*\(\s*|\brm\s+[^\n]*?)["']{}["']"#,
            regex::escape(&home)
        ))
        .unwrap()
        .is_match(code)
    });
    if literal_home || patterns.is_match(code) {
        return Err(Error::new(
            4302,
            "Code blocked: destructive system operation",
        ));
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    /// A repository as `git init` makes it (HEAD, objects, refs, config), with
    /// settings added to its config.
    fn git_init(dir: &Path, settings: &[(&str, &str)]) {
        git(&["init", "-q", &dir.to_string_lossy()]);
        for (key, value) in settings {
            git(&["-C", &dir.to_string_lossy(), "config", "--add", key, value]);
        }
    }
    fn git(args: &[&str]) {
        let status = std::process::Command::new("/usr/bin/git")
            .args(args)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .status()
            .unwrap();
        assert!(status.success(), "{args:?}");
    }
    #[test]
    fn user_auth_paths_and_child_environment_are_explicit() {
        let user = tempfile::tempdir().unwrap();
        for path in [".codex/auth.json", ".hermes/auth.json", ".hermes/.env"] {
            assert!(user_credential_name(user.path(), &user.path().join(path)));
        }
        assert!(!user_credential_name(
            user.path(),
            &user.path().join("project/auth.json")
        ));
        for name in [
            "HTTP_PROXY",
            "https_proxy",
            "No_Proxy",
            "SSL_CERT_FILE",
            "SSL_CERT_DIR",
            "NODE_EXTRA_CA_CERTS",
            "SSH_AUTH_SOCK",
            "TERM",
            "lc_all",
        ] {
            assert!(inherited_environment(name), "{name}");
        }
        for name in ["NODE_OPTIONS", "BASH_ENV", "OPENAI_API_KEY", "DISPLAY"] {
            assert!(!inherited_environment(name), "{name}");
        }
        for name in ["SystemRoot", "WINDIR", "PATHEXT", "COMSPEC", "USERPROFILE"] {
            assert_eq!(inherited_environment(name), cfg!(windows), "{name}");
        }
        assert!(display_environment("DISPLAY") && display_environment("WAYLAND_DISPLAY"));
        assert!(!display_environment("LOCALAPPDATA"));
        for name in ["github", "deploy_key", "nested/config"] {
            assert!(ssh_credential_name(
                user.path(),
                &user.path().join(".ssh").join(name)
            ));
        }
        for name in [
            "config",
            "known_hosts.old",
            "id_ed25519.pub",
            "authorized_keys",
        ] {
            assert!(!ssh_credential_name(
                user.path(),
                &user.path().join(".ssh").join(name)
            ));
        }
        let profile = sandbox_profile(&Layout {
            roots: vec![user.path().to_owned()],
            paths: vec![],
            writable: vec![],
            denied: denied_writes().unwrap(),
            confine: None,
        });
        for binary in ["/usr/bin/open", "/bin/launchctl", "/usr/bin/osascript"] {
            assert!(profile.contains(&format!("(literal {})", quoted(binary))));
        }
    }
    #[test]
    fn windows_workspace_plan_is_offline_and_denies_secrets() {
        let home = tempfile::tempdir().unwrap();
        let home = home.path().canonicalize().unwrap();
        let work = home.join("work");
        std::fs::create_dir_all(&work).unwrap();
        let secret = home.join("connect.json");
        std::fs::write(&secret, "secret").unwrap();
        let plan =
            confinement_plan(&home, Confine::Workspace, std::slice::from_ref(&work)).unwrap();
        assert!(!plan.network);
        assert!(plan.process_limit > 0);
        assert!(
            plan.allow
                .iter()
                .any(|grant| grant.write && grant.path == work.canonicalize().unwrap())
        );
        assert!(plan.deny.iter().any(|path| path == &secret));
        assert!(!plan.allow.iter().any(|grant| grant.path == secret));
        let open = confinement_plan(&home, Confine::No, &[]).unwrap();
        assert!(open.network);
        assert_eq!(open.process_limit, 0);
    }
    #[test]
    fn policy_is_scoped_and_walk_skips_heavy_trees() {
        let home = tempfile::tempdir().unwrap();
        for name in [
            "python",
            "desktop-data",
            "runtime/sessions",
            "cache",
            "node_modules",
            "venv",
            "bin",
            "native",
        ] {
            let dir = home.path().join(name).join("deep");
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("auth.json"), "secret").unwrap();
        }
        assert!(credential_name(
            home.path(),
            &home.path().join("desktop-data/Local Storage/token")
        ));
        assert!(!credential_name(
            home.path(),
            Path::new("/unrelated/auth.json")
        ));
        let keys = ["connect-identity.key", "nested/connect-identity.key"];
        std::fs::create_dir_all(home.path().join("nested")).unwrap();
        for key in keys {
            std::fs::write(home.path().join(key), "secret").unwrap();
            assert!(credential_name(home.path(), &home.path().join(key)));
        }
        assert!(!credential_name(
            home.path(),
            Path::new("/unrelated/connect-identity.key")
        ));
        let oauth = home.path().join("profiles/owl/pi/mcp-auth.json");
        std::fs::create_dir_all(oauth.parent().unwrap()).unwrap();
        std::fs::write(&oauth, "secret").unwrap();
        assert!(credential_name(home.path(), &oauth));
        let paths = secret_paths(home.path());
        for key in keys {
            assert!(paths.contains(&home.path().join(key)), "{key}");
        }
        assert!(paths.contains(&oauth));
        assert!(paths.contains(&home.path().join("desktop-data")));
        assert!(
            !paths
                .iter()
                .any(|p| p.to_string_lossy().contains("deep/auth.json"))
        );
        for name in ["known_hosts", "config", "id_ed25519.pub"] {
            assert!(!private_key(name));
        }
        for name in [
            "id_rsa",
            "id_ed25519",
            "work.pem",
            "work.key",
            "github",
            "deploy_key",
        ] {
            assert!(private_key(name));
        }
        let profile = sandbox_profile(&Layout {
            roots: vec![home.path().to_owned()],
            paths,
            writable: vec![],
            denied: denied_writes().unwrap(),
            confine: None,
        });
        if let Some(user) = std::env::var_os("HOME") {
            let user = PathBuf::from(user);
            let aws = quoted(user.join(".aws").to_string_lossy());
            assert!(profile.contains(&format!("(literal {aws}) (subpath {aws})")));
            // The parent of ~/.config/gh cannot be renamed out from under the rule;
            // the home itself and the stores' own literals are not listed again.
            let config = quoted(user.join(".config").to_string_lossy());
            assert!(profile.contains(&format!("(deny file-write-unlink (literal {config})")));
            let ancestors = store_ancestors(&denied_writes().unwrap());
            assert!(
                !ancestors
                    .iter()
                    .any(|a| *a == user || a.ends_with(".config/gh"))
            );
        }
        assert!(!profile.contains("regex #"));
        assert!(profile.contains("(deny file-write*"));
        assert!(profile.contains(&quoted(sandbox_regex(&format!(
            "^{}/{}",
            regex_escape(&home.path().to_string_lossy()),
            &policy().home[1..]
        )))));
    }
    #[test]
    fn scan_is_breadth_first_bounded_and_masks_read_only_secrets() {
        let base = tempfile::tempdir().unwrap();
        let root = base.path().canonicalize().unwrap();
        let home = root.join("home");
        let work = root.join("work");
        for path in [
            &home,
            &work,
            &work.join("a"),
            &work.join("z/.git"),
            &work.join("bare.git/hooks"),
            &root.join("metadata"),
            &root.join("common"),
        ] {
            std::fs::create_dir_all(path).unwrap();
        }
        std::fs::create_dir_all(work.join("bare.git/objects")).unwrap();
        std::fs::write(work.join("bare.git/HEAD"), "ref: refs/heads/main\n").unwrap();
        std::fs::write(work.join(".git"), "gitdir: ../metadata\n").unwrap();
        std::fs::write(root.join("metadata/commondir"), "../common\n").unwrap();
        std::fs::write(work.join("z/.env"), "dummy").unwrap();
        std::fs::write(work.join(".envrc"), "dummy").unwrap();
        std::fs::write(
            work.join("notes.git"),
            "ordinary file, not a gitdir pointer",
        )
        .unwrap();
        #[cfg(unix)]
        {
            std::fs::write(root.join("secret"), "dummy").unwrap();
            std::os::unix::fs::symlink("../secret", work.join(".env")).unwrap();
        }
        let bare = work.join("bare.git");
        assert!(
            workspace_protected(std::slice::from_ref(&bare), 3)
                .unwrap()
                .git
                .contains(&bare)
        );
        let scan = workspace_protected(std::slice::from_ref(&work), 3).unwrap();
        assert!(scan.secrets.contains(&work.join("z/.env")));
        for path in [
            work.join(".git"),
            work.join("bare.git"),
            root.join("metadata"),
            root.join("common"),
        ] {
            assert!(scan.git.contains(&path));
        }
        let layout = layout_scanned(&home, &[], Some(&[]), std::slice::from_ref(&work)).unwrap();
        let args = bwrap_arguments(&layout).unwrap();
        assert!(!args.iter().any(|arg| arg == "--bind"));
        for path in scan.secrets {
            assert!(
                args.windows(3)
                    .any(|w| w[0] == "--ro-bind" && w[1] == "/dev/null" && w[2] == path)
            );
        }
        #[cfg(unix)]
        assert!(
            args.windows(3)
                .any(|w| w[0] == "--ro-bind" && w[1] == "/dev/null" && w[2] == root.join("secret"))
        );
        std::fs::create_dir(work.join("a/deep")).unwrap();
        assert!(
            workspace_protected(std::slice::from_ref(&work), 3)
                .unwrap()
                .exhausted
        );
        for i in 0..1001 {
            std::fs::create_dir(work.join("a").join(i.to_string())).unwrap();
        }
        let partial = layout_scanned(&home, &[], Some(&[]), &[work]).unwrap();
        assert!(bwrap_arguments(&partial).is_err());
        assert!(!sandbox_profile(&partial).is_empty());
    }

    #[tokio::test]
    async fn directory_common_hooks_and_partial_scans_preserve_protection() {
        let base = tempfile::tempdir().unwrap();
        let root = base.path().canonicalize().unwrap();
        let home = root.join("home");
        let work = root.join("project.git");
        for path in [
            &home,
            &work.join(".git"),
            &work.join("shared/hooks"),
            &work.join(".local-hooks"),
            &work.join("markers"),
            &work.join("ordinary.git"),
        ] {
            std::fs::create_dir_all(path).unwrap();
        }
        std::fs::write(work.join(".git/commondir"), "../shared\n").unwrap();
        std::fs::write(
            work.join("shared/config"),
            "[include]\n path = ../hooks-config\n",
        )
        .unwrap();
        std::fs::write(
            work.join("hooks-config"),
            "[core]\n hooksPath = \".local-hooks\"\n",
        )
        .unwrap();
        std::fs::write(work.join(".gitignore"), ".local-hooks/\n").unwrap();
        std::fs::write(work.join("markers/.git"), [0xff]).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink("missing-secret", work.join(".env")).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink("ordinary.git", work.join(".env.venv")).unwrap();
        let scan = workspace_protected(std::slice::from_ref(&work), WORKSPACE_DIRS).unwrap();
        assert!(!scan.failure);
        #[cfg(unix)]
        assert!(scan.secrets.contains(&work.join(".env")));
        assert!(!scan.secrets.contains(&work.join(".env.venv")));
        let layout = layout(&home, &[], Some(std::slice::from_ref(&work))).unwrap();
        let args = bwrap_arguments(&layout).unwrap();
        for local in [
            ".git",
            "shared",
            ".local-hooks",
            "hooks-config",
            "markers/.git",
        ] {
            let path = work.join(local);
            assert!(scan.git.contains(&path), "{}", path.display());
            assert!(git_write_protected(&path, std::slice::from_ref(&work)).unwrap());
            assert!(
                args.windows(3)
                    .any(|w| w[0] == "--ro-bind" && w[1] == path && w[2] == path)
            );
        }
        assert!(git_write_protected(&work, std::slice::from_ref(&work)).unwrap());
        for local in ["notes.git", "ordinary.git/notes", "notes"] {
            assert!(!git_write_protected(&work.join(local), std::slice::from_ref(&work)).unwrap());
        }
        // Real macOS reproduction, using only dummy files.
        if cfg!(target_os = "macos") {
            let profile = sandbox_profile(&layout);
            for script in [
                "echo x > shared/hooks/pre-commit",
                "echo x > .local-hooks/pre-commit",
                "mv shared moved",
                "mv .local-hooks moved",
                "echo x > hooks-config",
                "echo x > markers/.git",
            ] {
                let result = tokio::process::Command::new("/usr/bin/sandbox-exec")
                    .args(["-p", &profile, "/bin/bash", "-c", script])
                    .current_dir(&work)
                    .output()
                    .await
                    .unwrap();
                assert!(!result.status.success(), "{script}");
                assert!(!String::from_utf8_lossy(&result.stderr).contains("sandbox_init"));
            }
        }
        for i in 0..1001 {
            std::fs::create_dir(work.join(i.to_string())).unwrap();
        }
        let partial = super::layout(&home, &[], Some(std::slice::from_ref(&work))).unwrap();
        assert!(partial.confine.as_ref().unwrap().protected.exhausted);
        assert!(bwrap_arguments(&partial).is_err());
        assert!(
            git_write_protected(&work.join("notes.git"), std::slice::from_ref(&work))
                .unwrap_err()
                .message
                .contains("directory budget")
        );
        if cfg!(target_os = "macos") {
            let result = isolated_command(
                &home,
                "/bin/bash",
                std::slice::from_ref(&work),
                Confine::Workspace,
            )
            .unwrap()
            .args([
                "-c",
                "echo ok > notes.git; echo ok > ordinary.git/notes; cat notes.git",
            ])
            .current_dir(&work)
            .output()
            .await
            .unwrap();
            assert!(
                result.status.success(),
                "{}",
                String::from_utf8_lossy(&result.stderr)
            );
            assert_eq!(result.stdout, b"ok\n");
        }
    }

    #[tokio::test]
    async fn sandbox_blocks_secret_moves_and_linked_git_writes() {
        if !isolation_available() {
            return;
        }
        let base = tempfile::tempdir().unwrap();
        let root = base.path().canonicalize().unwrap();
        let home = root.join("home");
        let work = root.join("work");
        for path in [
            &home,
            &work,
            &work.join("nested"),
            &work.join("bare.git/hooks"),
            &root.join("metadata/hooks"),
            &root.join("common/hooks"),
        ] {
            std::fs::create_dir_all(path).unwrap();
        }
        std::fs::create_dir_all(work.join("bare.git/objects")).unwrap();
        std::fs::write(work.join("bare.git/HEAD"), "ref: refs/heads/main\n").unwrap();
        std::fs::write(work.join(".git"), "gitdir: ../metadata\n").unwrap();
        std::fs::write(root.join("metadata/commondir"), "../common\n").unwrap();
        std::fs::write(work.join(".env"), "dummy").unwrap();
        std::fs::write(work.join("nested/.env"), "dummy").unwrap();
        let script = "mv .env moved && exit 10; echo x >> .env && exit 11; rm .env && exit 12; echo x > ../metadata/hooks/pre-commit && exit 13; echo x > ../common/hooks/pre-commit && exit 14; echo x > bare.git/hooks/pre-commit && exit 15; echo ok > notes; cat notes";
        let output = isolated_command(
            &home,
            "/bin/bash",
            std::slice::from_ref(&root),
            Confine::Workspace,
        )
        .unwrap()
        .args(["-c", script])
        .current_dir(&work)
        .output()
        .await
        .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(output.stdout, b"ok\n");
        let outputs = home.join("profiles/owl/artifacts");
        std::fs::create_dir_all(&outputs).unwrap();
        let script = format!("echo artifact > '{}'", outputs.join("result").display());
        let output = isolated_command(
            &home,
            "/bin/bash",
            &[work.clone(), outputs.clone()],
            Confine::ReadOnly,
        )
        .unwrap()
        .args(["-c", &script])
        .output()
        .await
        .unwrap();
        assert!(!output.status.success());
        let output = isolated_command_with_outputs(
            &home,
            "/bin/bash",
            &[work.clone(), outputs.clone()],
            Confine::ReadOnly,
            &[outputs],
        )
        .unwrap()
        .args(["-c", &script])
        .output()
        .await
        .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let output = isolated_command(
            &home,
            "/bin/cat",
            std::slice::from_ref(&work),
            Confine::ReadOnly,
        )
        .unwrap()
        .arg(work.join("notes"))
        .output()
        .await
        .unwrap();
        assert_eq!(
            output.stdout,
            b"ok\n",
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        for mode in [Confine::ReadOnly, Confine::Workspace] {
            let output = isolated_command(&home, "/bin/cat", std::slice::from_ref(&work), mode)
                .unwrap()
                .arg(work.join(".env"))
                .output()
                .await
                .unwrap();
            assert!(!String::from_utf8_lossy(&output.stdout).contains("dummy"));
        }
    }

    /// Arguments after the confined base: no host bind may follow the first mask.
    fn masks_last(args: &[OsString]) -> bool {
        let rest = &args[15..];
        let host_bind = |i: usize| {
            (rest[i] == "--bind" || rest[i] == "--ro-bind")
                && rest.get(i + 1).is_some_and(|arg| arg != "/dev/null")
        };
        let mask = |i: usize| rest[i] == "--tmpfs" || (rest[i] == "--ro-bind" && !host_bind(i));
        (0..rest.len())
            .find(|&i| mask(i))
            .is_none_or(|first| !(first..rest.len()).any(host_bind))
    }

    #[tokio::test]
    async fn repository_hook_paths_outside_the_workspace_never_bind_or_lock_host_folders() {
        let base = tempfile::tempdir().unwrap();
        let root = base.path().canonicalize().unwrap();
        let home = root.join("home");
        let work = root.join("work");
        for path in [&home, &work.join(".git"), &work.join("inside-hooks")] {
            std::fs::create_dir_all(path).unwrap();
        }
        std::os::unix::fs::symlink("/", work.join("linked-root")).unwrap();
        let user = PathBuf::from(std::env::var_os("HOME").unwrap_or_default());
        for target in [PathBuf::from("/"), read_denied()[0].clone(), user.clone()] {
            std::fs::write(
                work.join(".git/config"),
                format!("[core]\n\thooksPath = {}\n", target.display()),
            )
            .unwrap();
            let layout = layout(&home, &[], Some(std::slice::from_ref(&work))).unwrap();
            assert!(!layout.confine.as_ref().unwrap().protected.failure);
            let args = bwrap_arguments(&layout).unwrap();
            let real = std::fs::canonicalize(&target).unwrap_or(target.clone());
            for path in real.ancestors() {
                assert!(
                    !args[15..]
                        .windows(3)
                        .any(|w| w[0] == "--ro-bind" && w[1] == path && w[2] == path),
                    "{}: {}",
                    target.display(),
                    path.display()
                );
            }
            assert!(masks_last(&args), "{}", target.display());
            assert!(
                !git_write_protected(&work.join("notes"), std::slice::from_ref(&work)).unwrap()
            );
            assert!(
                git_write_protected(
                    &work.join(".git/hooks/pre-commit"),
                    std::slice::from_ref(&work)
                )
                .unwrap()
            );
            let profile = sandbox_profile(&layout);
            assert!(!profile.contains("(subpath \"/\")"));
            assert!(!profile.contains(&format!("(subpath {})", quoted(user.to_string_lossy()))));
            if cfg!(target_os = "macos") {
                let result = tokio::process::Command::new("/usr/bin/sandbox-exec")
                    .args([
                        "-p",
                        &profile,
                        "/bin/bash",
                        "-c",
                        "echo ok > notes; cat notes",
                    ])
                    .current_dir(&work)
                    .output()
                    .await
                    .unwrap();
                assert_eq!(
                    result.stdout,
                    b"ok\n",
                    "{}",
                    String::from_utf8_lossy(&result.stderr)
                );
            }
        }
        // Through a link inside the workspace the target is the host root, but a
        // program could replace the link with a folder of hooks. Bubblewrap
        // cannot protect the link, so the program does not start; Seatbelt locks
        // the link itself.
        let link = work.join("linked-root");
        std::fs::write(
            work.join(".git/config"),
            format!("[core]\n\thooksPath = {}\n", link.display()),
        )
        .unwrap();
        let linked = layout(&home, &[], Some(std::slice::from_ref(&work))).unwrap();
        assert_eq!(
            linked.confine.as_ref().unwrap().protected.links.to_vec(),
            vec![link.clone()]
        );
        let error = bwrap_arguments(&linked).unwrap_err().to_string();
        assert!(error.contains("symbolic link"), "{error}");
        assert!(!git_write_protected(&work.join("notes"), std::slice::from_ref(&work)).unwrap());
        let profile = sandbox_profile(&linked);
        assert!(profile.contains(&format!("(subpath {})", quoted(link.to_string_lossy()))));
        assert!(!profile.contains("(subpath \"/\")"));
        if cfg!(target_os = "macos") {
            for (command, allowed) in [
                ("echo ok > notes", true),
                ("rm linked-root", false),
                ("ln -sfn inside-hooks linked-root", false),
            ] {
                let result = tokio::process::Command::new("/usr/bin/sandbox-exec")
                    .args(["-p", &profile, "/bin/bash", "-c", command])
                    .current_dir(&work)
                    .output()
                    .await
                    .unwrap();
                assert_eq!(result.status.success(), allowed, "{command}");
            }
        }
        // Inside the workspace the configured folder is still locked, before any mask.
        std::fs::write(
            work.join(".git/config"),
            "[core]\n\thooksPath = inside-hooks\n",
        )
        .unwrap();
        let layout = layout(&home, &[], Some(std::slice::from_ref(&work))).unwrap();
        let args = bwrap_arguments(&layout).unwrap();
        let hooks = work.join("inside-hooks");
        assert!(
            args.windows(3)
                .any(|w| w[0] == "--ro-bind" && w[1] == hooks && w[2] == hooks)
        );
        assert!(masks_last(&args));
        assert!(
            git_write_protected(&hooks.join("pre-commit"), std::slice::from_ref(&work)).unwrap()
        );
    }

    #[test]
    fn fifos_in_git_metadata_and_includes_do_not_stall_the_scan() {
        use std::os::unix::ffi::OsStrExt;
        let base = tempfile::tempdir().unwrap();
        let work = base.path().canonicalize().unwrap().join("work");
        for path in ["a/.git", "b/.git", "c", "d/.git"] {
            std::fs::create_dir_all(work.join(path)).unwrap();
        }
        std::fs::write(
            work.join("b/.git/config"),
            "[include]\n\tpath = ../include-fifo\n",
        )
        .unwrap();
        for fifo in [
            "a/.git/commondir",
            "b/include-fifo",
            "c/.git",
            "d/.git/config",
        ] {
            let path = std::ffi::CString::new(work.join(fifo).as_os_str().as_bytes()).unwrap();
            // SAFETY: path is a valid NUL-terminated string.
            assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
        }
        let (sender, receiver) = std::sync::mpsc::channel();
        let roots = vec![work.clone()];
        std::thread::spawn(move || {
            let _ = sender.send(
                workspace_protected(&roots, WORKSPACE_DIRS).map(|scan| (scan.git, scan.failure)),
            );
        });
        let (git, failure) = receiver
            .recv_timeout(Duration::from_secs(20))
            .expect("the scan finishes")
            .unwrap();
        assert!(!failure);
        for path in ["a/.git", "b/.git", "b/include-fifo", "c/.git", "d/.git"] {
            assert!(git.contains(&work.join(path)), "{path}");
        }
    }

    #[test]
    fn cyclic_and_fanned_out_git_includes_are_read_once_and_bounded() {
        let base = tempfile::tempdir().unwrap();
        let work = base.path().canonicalize().unwrap().join("work");
        let wide = base.path().canonicalize().unwrap().join("wide");
        for path in [work.join(".git"), wide.join(".git")] {
            std::fs::create_dir_all(path).unwrap();
        }
        // Every file includes every other one and itself: without a visited set
        // this is 12^10 visits at the depth limit.
        let names: Vec<String> = (0..12).map(|i| format!("inc{i}")).collect();
        let includes = |prefix: &str| {
            names.iter().fold("[include]\n".to_owned(), |text, name| {
                text + &format!("\tpath = {prefix}{name}\n")
            })
        };
        std::fs::write(work.join(".git/config"), includes("../")).unwrap();
        for name in &names {
            std::fs::write(
                work.join(name),
                includes("") + &format!("[core]\n\thooksPath = {name}-hooks\n"),
            )
            .unwrap();
        }
        // Beyond the repository and user configs a scan reads 64 include files
        // for one worktree.
        let fan_out = |count: usize| {
            (0..count).fold("[include]\n".to_owned(), |text, i| {
                text + &format!("\tpath = ../missing{i}\n")
            })
        };
        let fits = base.path().canonicalize().unwrap().join("fits");
        std::fs::create_dir_all(fits.join(".git")).unwrap();
        std::fs::write(fits.join(".git/config"), fan_out(64)).unwrap();
        std::fs::write(wide.join(".git/config"), fan_out(10001)).unwrap();
        let (sender, receiver) = std::sync::mpsc::channel();
        let roots = (vec![work.clone()], vec![wide.clone()], vec![fits]);
        std::thread::spawn(move || {
            let scan = |roots: &[PathBuf]| {
                workspace_protected(roots, WORKSPACE_DIRS).map(|scan| (scan.git, scan.failure))
            };
            let started = Instant::now();
            let _ = sender.send((
                scan(&roots.0),
                scan(&roots.1),
                scan(&roots.2),
                started.elapsed(),
            ));
        });
        let (cyclic, fanned, fits, elapsed) = receiver
            .recv_timeout(Duration::from_secs(20))
            .expect("the scan finishes");
        assert!(elapsed < Duration::from_secs(5), "{elapsed:?}");
        assert!(!fits.unwrap().1);
        let (git, failure) = cyclic.unwrap();
        assert!(!failure);
        for name in &names {
            assert!(git.contains(&work.join(name)), "{name}");
            assert!(git.contains(&work.join(format!("{name}-hooks"))), "{name}");
        }
        assert!(fanned.unwrap().1);
    }

    #[test]
    fn a_global_hooks_path_is_protected_in_each_worktree_and_a_missing_one_asks() {
        let base = tempfile::tempdir().unwrap();
        let base = base.path().canonicalize().unwrap();
        let (home, work, xdg) = (base.join("home"), base.join("work"), base.join("xdg"));
        git_init(&work.join("app"), &[]);
        git_init(&work.join("lib"), &[("core.hooksPath", "tools/hooks")]);
        for path in [
            home.clone(),
            work.join("app/.githooks"),
            work.join("lib/tools"),
            xdg.join("git"),
        ] {
            std::fs::create_dir_all(path).unwrap();
        }
        std::fs::write(
            xdg.join("git/config"),
            "[include]\n\tpath = more\n[core]\n\thooksPath = .githooks\n",
        )
        .unwrap();
        std::fs::write(
            xdg.join("git/more"),
            format!(
                "[core]\n\thooksPath = {}\n",
                base.join("outside-hooks").display()
            ),
        )
        .unwrap();
        TEST_GIT_CONFIGS.with(|files| *files.borrow_mut() = vec![xdg.join("git/config")]);
        let scan = workspace_protected(std::slice::from_ref(&work), WORKSPACE_DIRS).unwrap();
        // The user's own setting names app/.githooks and lib/.githooks; the
        // absolute folder outside the workspace is read-only to programs already.
        for path in ["app/.githooks", "lib/.githooks", "lib/tools/hooks"] {
            assert!(scan.git.contains(&work.join(path)), "{path}");
        }
        assert!(!scan.git.contains(&base.join("outside-hooks")));
        assert!(
            git_write_protected(
                &work.join("app/.githooks/pre-commit"),
                std::slice::from_ref(&work)
            )
            .unwrap()
        );
        assert!(
            !git_write_protected(&work.join("app/notes"), std::slice::from_ref(&work)).unwrap()
        );
        let confined = layout(&home, &[], Some(std::slice::from_ref(&work))).unwrap();
        assert!(sandbox_profile(&confined).contains(&format!(
            "(subpath {})",
            quoted(work.join("app/.githooks").to_string_lossy())
        )));
        // lib/tools/hooks is missing and pins lib/tools, a folder inside the
        // repository. lib/.githooks is missing too and would pin the whole lib
        // repository, so the program cannot run in the sandbox, and creating it
        // is the fix, whether lib is the workspace or a repository inside it.
        let bound = |args: &[OsString], path: &Path| {
            args.windows(2)
                .any(|w| w[0] == "--ro-bind" && w[1] == path.as_os_str())
        };
        let lib = work.join("lib");
        for root in [&work, &lib] {
            let error =
                bwrap_arguments(&layout(&home, &[], Some(std::slice::from_ref(root))).unwrap())
                    .unwrap_err()
                    .to_string();
            assert!(error.contains("does not exist yet"), "{error}");
            assert!(error.contains("cannot run in the sandbox"), "{error}");
            assert!(!error.contains("full_access"), "{error}");
            assert!(
                error.contains(&format!("mkdir -p '{}'", lib.join(".githooks").display())),
                "{error}"
            );
            assert!(!error.contains("tools"), "{error}");
        }
        std::fs::create_dir(lib.join(".githooks")).unwrap();
        for root in [&work, &lib] {
            let args =
                bwrap_arguments(&layout(&home, &[], Some(std::slice::from_ref(root))).unwrap())
                    .unwrap();
            assert!(bound(&args, &lib.join(".githooks")));
            assert!(bound(&args, &lib.join("tools")));
            assert!(!bound(&args, &lib));
            assert!(root == &lib || bound(&args, &work.join("app/.githooks")));
        }
        TEST_GIT_CONFIGS.with(|files| files.borrow_mut().clear());
    }

    #[test]
    fn git_config_files_follow_the_git_environment() {
        let env = |pairs: &'static [(&'static str, &'static str)]| {
            move |name: &str| {
                pairs
                    .iter()
                    .find(|(key, _)| *key == name)
                    .map(|(_, value)| OsString::from(value))
            }
        };
        let paths = |list: &[&str]| list.iter().map(PathBuf::from).collect::<Vec<_>>();
        assert_eq!(
            git_config_files(env(&[("HOME", "/h")])),
            paths(&[
                "/h/.gitconfig",
                "/h/.config/git/config",
                "/etc/gitconfig",
                "/opt/homebrew/etc/gitconfig",
                "/usr/local/etc/gitconfig"
            ])
        );
        assert_eq!(
            git_config_files(env(&[
                ("HOME", "/h"),
                ("XDG_CONFIG_HOME", "/x"),
                ("GIT_CONFIG_SYSTEM", "/s")
            ])),
            paths(&["/h/.gitconfig", "/x/git/config", "/s"])
        );
        assert_eq!(
            git_config_files(env(&[
                ("HOME", "/h"),
                ("GIT_CONFIG_GLOBAL", "/g"),
                ("GIT_CONFIG_NOSYSTEM", "1")
            ])),
            paths(&["/g"])
        );
        assert_eq!(
            git_config_files(env(&[
                ("GIT_CONFIG_GLOBAL", "relative"),
                ("GIT_CONFIG_NOSYSTEM", "false"),
                ("GIT_CONFIG_SYSTEM", "/s")
            ])),
            paths(&["/s"])
        );
    }

    #[tokio::test]
    async fn a_missing_target_never_pins_a_repository_and_links_to_git_are_locked_or_refused() {
        let base = tempfile::tempdir().unwrap();
        let base = base.path().canonicalize().unwrap();
        let (home, work) = (base.join("home"), base.join("work"));
        // The workspace's own repository includes a missing file, a nested
        // repository names a missing hooks folder, and husky's .husky/_ is
        // missing inside .husky.
        git_init(&work, &[("include.path", "../.gitconfig.local")]);
        git_init(&work.join("app"), &[("core.hooksPath", ".githooks")]);
        git_init(&work.join("lib"), &[("core.hooksPath", ".husky/_")]);
        for path in [home.clone(), work.join("app/src"), work.join("lib/.husky")] {
            std::fs::create_dir_all(path).unwrap();
        }
        let args =
            |root: &Path| bwrap_arguments(&layout(&home, &[], Some(&[root.to_owned()])).unwrap());
        let binds = |args: &[OsString]| -> Vec<PathBuf> {
            args.windows(2)
                .filter(|w| w[0] == "--ro-bind" && w[1] != "/dev/null")
                .map(|w| PathBuf::from(&w[1]))
                .collect()
        };
        let error = args(&work).unwrap_err().to_string();
        // One message names both targets and creates each as Git reads it.
        let (hooks, include) = (work.join("app/.githooks"), work.join(".gitconfig.local"));
        assert!(
            error.contains(&format!("'{}', '{}'", include.display(), hooks.display()))
                || error.contains(&format!("'{}', '{}'", hooks.display(), include.display())),
            "{error}"
        );
        assert!(
            error.contains(&format!(
                "mkdir -p '{}' && touch '{}'",
                hooks.display(),
                include.display()
            )),
            "{error}"
        );
        assert!(error.contains("do not exist yet"), "{error}");
        assert!(!error.contains(".husky"), "{error}");
        assert!(
            args(&work.join("app"))
                .unwrap_err()
                .to_string()
                .contains(&hooks.display().to_string())
        );
        std::fs::write(&include, "").unwrap();
        std::fs::create_dir(&hooks).unwrap();
        let bound = binds(&args(&work).unwrap());
        for path in ["app/.githooks", "lib/.husky", ".gitconfig.local"] {
            assert!(bound.contains(&work.join(path)), "{path}");
        }
        for path in ["", "app", "lib"] {
            assert!(!bound.contains(&work.join(path)), "{path}");
        }
        // A bare repository's own folder is Git metadata already, so a missing
        // hooks folder inside it pins nothing new.
        let bare = work.join("bare.git");
        std::fs::create_dir_all(bare.join("objects")).unwrap();
        std::fs::write(bare.join("HEAD"), "ref: refs/heads/main\n").unwrap();
        std::fs::write(bare.join("config"), "[core]\n\thooksPath = hooks\n").unwrap();
        assert!(binds(&args(&work).unwrap()).contains(&bare));
        // A .git entry or hooks folder that is a link inside the workspace could
        // be replaced: bubblewrap refuses, and Seatbelt locks the link and its
        // target.
        std::fs::create_dir_all(work.join("store/linked-git")).unwrap();
        std::fs::create_dir_all(work.join("store/hooks")).unwrap();
        std::fs::create_dir(work.join("linked")).unwrap();
        std::os::unix::fs::symlink("../store/linked-git", work.join("linked/.git")).unwrap();
        std::os::unix::fs::symlink("../store/hooks", work.join("app/hooks-link")).unwrap();
        git(&[
            "-C",
            &work.join("app").to_string_lossy(),
            "config",
            "core.hooksPath",
            "hooks-link",
        ]);
        let scan = workspace_protected(std::slice::from_ref(&work), WORKSPACE_DIRS).unwrap();
        let mut links = scan.links.to_vec();
        links.sort();
        assert_eq!(
            links,
            vec![work.join("app/hooks-link"), work.join("linked/.git")]
        );
        let error = args(&work).unwrap_err().to_string();
        assert!(error.contains("symbolic links"), "{error}");
        assert!(error.contains("cannot run in the sandbox"), "{error}");
        let locked = locked_git(&scan, std::slice::from_ref(&work), false).unwrap();
        for path in [
            "app/hooks-link",
            "linked/.git",
            "store/hooks",
            "store/linked-git",
        ] {
            assert!(locked.contains(&work.join(path)), "{path}");
        }
        if cfg!(target_os = "macos") {
            let confined = layout(&home, &[], Some(std::slice::from_ref(&work))).unwrap();
            for command in [
                "rm linked/.git",
                "mv linked/.git linked/moved",
                "rm app/hooks-link",
                "mv app/hooks-link app/moved",
                "echo x > store/hooks/pre-commit",
                "echo x > app/hooks-link/pre-commit",
            ] {
                let output = tokio::process::Command::new("/usr/bin/sandbox-exec")
                    .args([
                        "-p",
                        &sandbox_profile(&confined),
                        "/bin/bash",
                        "-c",
                        command,
                    ])
                    .current_dir(&work)
                    .output()
                    .await
                    .unwrap();
                assert!(!output.status.success(), "{command}");
            }
            let output = tokio::process::Command::new("/usr/bin/sandbox-exec")
                .args([
                    "-p",
                    &sandbox_profile(&confined),
                    "/bin/bash",
                    "-c",
                    "echo ok > app/src/notes; cat app/src/notes",
                ])
                .current_dir(&work)
                .output()
                .await
                .unwrap();
            assert_eq!(output.stdout, b"ok\n");
        }
    }

    #[tokio::test]
    async fn links_inside_git_metadata_lock_their_targets_and_only_locked_targets_hold_a_missing_one()
     {
        let base = tempfile::tempdir().unwrap();
        let base = base.path().canonicalize().unwrap();
        let (home, work) = (base.join("home"), base.join("work"));
        git_init(&work, &[]);
        for path in [home.clone(), work.join(".githooks"), work.join("src")] {
            std::fs::create_dir_all(path).unwrap();
        }
        // .git/hooks and .git/config are links to tracked files the program can write.
        std::fs::remove_file(work.join(".git/config")).unwrap();
        std::fs::remove_dir_all(work.join(".git/hooks")).unwrap();
        std::fs::write(work.join("repo.gitconfig"), "[core]\n\tbare = false\n").unwrap();
        std::os::unix::fs::symlink("../repo.gitconfig", work.join(".git/config")).unwrap();
        std::os::unix::fs::symlink("../.githooks", work.join(".git/hooks")).unwrap();
        let args =
            |root: &Path| bwrap_arguments(&layout(&home, &[], Some(&[root.to_owned()])).unwrap());
        let binds = |args: &[OsString]| -> Vec<PathBuf> {
            args.windows(2)
                .filter(|w| w[0] == "--ro-bind" && w[1] != "/dev/null")
                .map(|w| PathBuf::from(&w[1]))
                .collect()
        };
        let sandboxed = async |root: &Path, command: &str| {
            let confined = layout(&home, &[], Some(&[root.to_owned()])).unwrap();
            tokio::process::Command::new("/usr/bin/sandbox-exec")
                .args([
                    "-p",
                    &sandbox_profile(&confined),
                    "/bin/bash",
                    "-c",
                    command,
                ])
                .current_dir(root)
                .output()
                .await
                .unwrap()
        };
        // The links sit in .git, which is locked, so nothing refuses.
        let bound = binds(&args(&work).unwrap());
        for path in [".git", ".githooks", "repo.gitconfig"] {
            assert!(bound.contains(&work.join(path)), "{path}");
        }
        assert!(!bound.contains(&work));
        if cfg!(target_os = "macos") {
            for command in [
                "echo x > .githooks/pre-commit",
                "echo x > .git/hooks/pre-commit",
                "printf '[core]\\n\\thooksPath = /tmp/x\\n' >> repo.gitconfig",
                "rm repo.gitconfig",
                "mv .githooks moved",
            ] {
                assert!(
                    !sandboxed(&work, command).await.status.success(),
                    "{command}"
                );
            }
            let output = sandboxed(&work, "echo ok > src/notes; cat src/notes").await;
            assert_eq!(output.stdout, b"ok\n");
        }
        // A dangling hooks link names a folder the program could create.
        std::fs::remove_dir(work.join(".githooks")).unwrap();
        let error = args(&work).unwrap_err().to_string();
        assert!(error.contains("does not exist yet"), "{error}");
        assert!(
            error.contains(&format!("mkdir -p '{}'", work.join(".githooks").display())),
            "{error}"
        );
        if cfg!(target_os = "macos") {
            assert!(!sandboxed(&work, "mkdir .githooks").await.status.success());
        }
        std::fs::create_dir(work.join(".githooks")).unwrap();
        // hooks-link/../hooks goes through the link's target, store/nested, to
        // store/hooks: the link is found although the path names app/hooks.
        let app = work.join("app");
        git_init(&app, &[("core.hooksPath", "hooks-link/../hooks")]);
        for path in [
            app.join("hooks"),
            work.join("store/nested"),
            work.join("store/hooks"),
        ] {
            std::fs::create_dir_all(path).unwrap();
        }
        std::os::unix::fs::symlink("../store/nested", app.join("hooks-link")).unwrap();
        let scan = workspace_protected(std::slice::from_ref(&work), WORKSPACE_DIRS).unwrap();
        assert_eq!(scan.links.to_vec(), vec![app.join("hooks-link")]);
        assert!(scan.git.contains(&work.join("store/hooks")));
        let error = args(&work).unwrap_err().to_string();
        assert!(error.contains("a symbolic link"), "{error}");
        assert!(error.contains("app/hooks-link"), "{error}");
        if cfg!(target_os = "macos") {
            for command in ["echo x > store/hooks/pre-commit", "rm app/hooks-link"] {
                assert!(
                    !sandboxed(&work, command).await.status.success(),
                    "{command}"
                );
            }
        }
        // hooksPath = / is never locked, so it cannot hold a missing .githooks
        // that a later setting chooses: the program stops instead of making the
        // repository read-only.
        let plain = base.join("plain");
        git_init(
            &plain,
            &[("core.hooksPath", "/"), ("core.hooksPath", ".githooks")],
        );
        let error = args(&plain).unwrap_err().to_string();
        assert!(error.contains("does not exist yet"), "{error}");
        assert!(
            error.contains(&format!("mkdir -p '{}'", plain.join(".githooks").display())),
            "{error}"
        );
        std::fs::create_dir(plain.join(".githooks")).unwrap();
        assert!(!binds(&args(&plain).unwrap()).contains(&plain));
    }

    #[tokio::test]
    async fn a_nested_repository_made_by_git_init_keeps_its_relative_hooks_path_in_its_own_folder()
    {
        let base = tempfile::tempdir().unwrap();
        let base = base.path().canonicalize().unwrap();
        let (home, work) = (base.join("home"), base.join("work"));
        let (web, api) = (work.join("web"), work.join("api"));
        std::fs::create_dir(&home).unwrap();
        // husky sets core.hooksPath = .husky/_; another project uses .githooks.
        git_init(&web, &[("core.hooksPath", ".husky/_")]);
        git_init(&api, &[("core.hooksPath", ".githooks")]);
        std::fs::create_dir_all(web.join(".husky/_")).unwrap();
        let scan = workspace_protected(std::slice::from_ref(&work), WORKSPACE_DIRS).unwrap();
        let mut worktrees: Vec<PathBuf> = scan.worktrees.iter().cloned().collect();
        worktrees.sort();
        assert_eq!(worktrees, vec![api.clone(), web.clone()]);
        for path in [web.join(".husky/_"), api.join(".githooks")] {
            assert!(scan.git.contains(&path), "{}", path.display());
        }
        // The missing .githooks would pin the api repository, so the program
        // cannot run in the sandbox.
        let args =
            || bwrap_arguments(&layout(&home, &[], Some(std::slice::from_ref(&work))).unwrap());
        let error = args().unwrap_err().to_string();
        assert!(error.contains("does not exist yet"), "{error}");
        assert!(
            error.contains(&format!("mkdir -p '{}'", api.join(".githooks").display())),
            "{error}"
        );
        if cfg!(target_os = "macos") {
            let confined = layout(&home, &[], Some(std::slice::from_ref(&work))).unwrap();
            let sandboxed = async |cwd: &Path, command: &str| {
                tokio::process::Command::new("/usr/bin/sandbox-exec")
                    .args([
                        "-p",
                        &sandbox_profile(&confined),
                        "/bin/bash",
                        "-c",
                        command,
                    ])
                    .current_dir(cwd)
                    .output()
                    .await
                    .unwrap()
            };
            for (cwd, command) in [
                (&web, "echo x > .husky/_/pre-commit"),
                (&web, "rm -r .husky/_"),
                (&api, "mkdir -p .githooks"),
            ] {
                assert!(!sandboxed(cwd, command).await.status.success(), "{command}");
            }
            let output = sandboxed(&api, "echo ok > notes; cat notes").await;
            assert_eq!(output.stdout, b"ok\n");
        }
        std::fs::create_dir(api.join(".githooks")).unwrap();
        let args = args().unwrap();
        let bound = |path: &Path| {
            args.windows(2)
                .any(|w| w[0] == "--ro-bind" && w[1] == path.as_os_str())
        };
        for path in [
            web.join(".husky/_"),
            api.join(".githooks"),
            web.join(".git"),
            api.join(".git"),
        ] {
            assert!(bound(&path), "{}", path.display());
        }
        for path in [
            web.clone(),
            api.clone(),
            web.join(".git/.husky"),
            api.join(".git/.githooks"),
        ] {
            assert!(!bound(&path), "{}", path.display());
        }
    }

    #[tokio::test]
    async fn a_link_between_git_metadata_and_its_target_in_the_workspace_is_locked_or_refused() {
        let base = tempfile::tempdir().unwrap();
        let base = base.path().canonicalize().unwrap();
        let (home, work) = (base.join("home"), base.join("work"));
        let app = work.join("app");
        std::fs::create_dir(&home).unwrap();
        // app/.git/hooks -> ../.githooks -> store/hooks: .githooks could be
        // pointed somewhere writable, so it is part of the protected path.
        git_init(&app, &[]);
        std::fs::remove_dir_all(app.join(".git/hooks")).unwrap();
        std::fs::create_dir_all(app.join("store/hooks")).unwrap();
        std::os::unix::fs::symlink("../.githooks", app.join(".git/hooks")).unwrap();
        std::os::unix::fs::symlink("store/hooks", app.join(".githooks")).unwrap();
        let scan = workspace_protected(std::slice::from_ref(&work), WORKSPACE_DIRS).unwrap();
        assert_eq!(scan.links.to_vec(), vec![app.join(".githooks")]);
        let error =
            bwrap_arguments(&layout(&home, &[], Some(std::slice::from_ref(&work))).unwrap())
                .unwrap_err()
                .to_string();
        assert!(error.contains("a symbolic link"), "{error}");
        assert!(error.contains("app/.githooks"), "{error}");
        let locked = locked_git(&scan, std::slice::from_ref(&work), false).unwrap();
        for path in [".git", ".githooks", "store/hooks"] {
            assert!(locked.contains(&app.join(path)), "{path}");
        }
        if cfg!(target_os = "macos") {
            let confined = layout(&home, &[], Some(std::slice::from_ref(&work))).unwrap();
            let sandboxed = async |command: &str| {
                tokio::process::Command::new("/usr/bin/sandbox-exec")
                    .args([
                        "-p",
                        &sandbox_profile(&confined),
                        "/bin/bash",
                        "-c",
                        command,
                    ])
                    .current_dir(&app)
                    .output()
                    .await
                    .unwrap()
            };
            for command in [
                "rm .githooks",
                "ln -sfn src .githooks",
                "mv .githooks moved",
                "echo x > store/hooks/pre-commit",
            ] {
                assert!(!sandboxed(command).await.status.success(), "{command}");
            }
            assert_eq!(
                sandboxed("echo ok > notes; cat notes").await.stdout,
                b"ok\n"
            );
        }
    }

    #[test]
    fn include_limits_count_each_repository_and_a_stopped_scan_names_the_cause() {
        let base = tempfile::tempdir().unwrap();
        let base = base.path().canonicalize().unwrap();
        let (home, work) = (base.join("home"), base.join("work"));
        std::fs::create_dir_all(&home).unwrap();
        // Seventy repositories each include their own tracked config: 70 include
        // files in all, one for each repository.
        let repos = |count: usize| {
            for i in 0..count {
                let repo = work.join(format!("p{i}"));
                std::fs::create_dir_all(repo.join(".git")).unwrap();
                std::fs::write(repo.join(".gitconfig"), "[core]\n\tautocrlf = input\n").unwrap();
                std::fs::write(
                    repo.join(".git/config"),
                    "[include]\n\tpath = ../.gitconfig\n",
                )
                .unwrap();
            }
        };
        repos(70);
        let fits = workspace_protected(std::slice::from_ref(&work), WORKSPACE_DIRS).unwrap();
        assert!(!fits.failure);
        assert!(fits.git.contains(&work.join("p69/.gitconfig")));
        // A whole scan reads at most 256.
        repos(260);
        let error = git_write_protected(&work.join("notes"), std::slice::from_ref(&work))
            .unwrap_err()
            .to_string();
        assert!(
            error.contains(
                "because Git configuration in the workspace includes more than 256 files"
            ),
            "{error}"
        );
        let error =
            bwrap_arguments(&layout(&home, &[], Some(std::slice::from_ref(&work))).unwrap())
                .unwrap_err()
                .to_string();
        assert!(
            error.contains("because Git configuration in the workspace includes more than 256 files, so this code cannot run in the sandbox"),
            "{error}"
        );
        // One repository may include at most 64.
        let wide = base.join("wide");
        std::fs::create_dir_all(wide.join(".git")).unwrap();
        std::fs::write(
            wide.join(".git/config"),
            (0..65).fold("[include]\n".to_owned(), |text, i| {
                text + &format!("\tpath = ../missing{i}\n")
            }),
        )
        .unwrap();
        let scan = workspace_protected(std::slice::from_ref(&wide), WORKSPACE_DIRS).unwrap();
        assert_eq!(
            scan.cause.as_deref(),
            Some(
                format!(
                    "Git configuration for '{}' includes more than 64 files",
                    wide.display()
                )
                .as_str()
            )
        );
    }

    #[test]
    fn the_scan_reads_a_bounded_number_of_entries() {
        let base = tempfile::tempdir().unwrap();
        let work = base.path().canonicalize().unwrap().join("work");
        std::fs::create_dir_all(work.join("flat")).unwrap();
        // Three folders allow 150 entries.
        for i in 0..140 {
            std::fs::write(work.join("flat").join(i.to_string()), "").unwrap();
        }
        let scan = || {
            workspace_protected(std::slice::from_ref(&work), 3)
                .unwrap()
                .exhausted
        };
        assert!(!scan());
        for i in 140..150 {
            std::fs::write(work.join("flat").join(i.to_string()), "").unwrap();
        }
        assert!(scan());
    }

    /// The extension builds the same sandbox for Pi's bash tool from the same policy.
    #[test]
    fn sandbox_policy_matches_the_extension() {
        let base = tempfile::tempdir().unwrap();
        let home = base.path().join("hexbot-home");
        let attachments = home.join("runtime/sessions/one/attachments");
        let outputs = home.join("profiles/owl/artifacts");
        for dir in [
            &attachments,
            &outputs,
            &home.join("python/deep"),
            &home.join("desktop-data"),
        ] {
            std::fs::create_dir_all(dir).unwrap();
        }
        std::fs::write(home.join(".env"), "secret").unwrap();
        std::fs::write(home.join("profiles/owl/AUTH.JSON"), "secret").unwrap();
        std::fs::write(home.join("python/deep/auth.json"), "skipped").unwrap();
        std::fs::write(home.join("desktop-data/token"), "secret").unwrap();
        let layout = layout(&home, &[attachments.clone(), outputs.clone()], None).unwrap();
        let workspace = [base.path().join("work"), outputs.clone()];
        std::fs::create_dir_all(workspace[0].join(".git/hooks")).unwrap();
        std::fs::create_dir_all(workspace[0].join("app")).unwrap();
        std::fs::create_dir_all(workspace[0].join("linked")).unwrap();
        std::fs::create_dir_all(workspace[0].join("bare.git/hooks")).unwrap();
        std::fs::create_dir_all(workspace[0].join("bare.git/objects")).unwrap();
        std::fs::write(workspace[0].join("bare.git/HEAD"), "ref: refs/heads/main\n").unwrap();
        std::fs::create_dir_all(base.path().join("metadata")).unwrap();
        std::fs::create_dir_all(base.path().join("common")).unwrap();
        std::fs::write(workspace[0].join("linked/.git"), "gitdir: ../../metadata\n").unwrap();
        std::fs::write(base.path().join("metadata/commondir"), "../common\n").unwrap();
        std::fs::write(workspace[0].join(".git/commondir"), "../../common\n").unwrap();
        // A config in the metadata that links to a tracked file is locked there.
        std::fs::write(
            workspace[0].join("repo.gitconfig"),
            "[core]\n bare = false\n",
        )
        .unwrap();
        std::os::unix::fs::symlink("../repo.gitconfig", workspace[0].join(".git/config")).unwrap();
        std::fs::write(
            base.path().join("common/config"),
            "[include]\n path = ../hooks-config\n",
        )
        .unwrap();
        std::fs::write(
            base.path().join("hooks-config"),
            "[core]\n hooksPath = .local-hooks\n",
        )
        .unwrap();
        // The shared config names .local-hooks in both worktrees.
        for dir in [
            workspace[0].join(".local-hooks"),
            workspace[0].join("linked/.local-hooks"),
        ] {
            std::fs::create_dir_all(dir).unwrap();
        }
        std::fs::write(workspace[0].join("app/.env"), "secret").unwrap();
        std::fs::write(workspace[0].join(".env.example"), "example").unwrap();
        // The user's own Git config names a hooks folder in every worktree.
        let xdg = base.path().join("xdg");
        std::fs::create_dir_all(xdg.join("git")).unwrap();
        std::fs::write(xdg.join("git/config"), "[core]\n hooksPath = .githooks\n").unwrap();
        // A nested repository made by git init keeps husky's relative hooks
        // path in its own folder.
        git_init(&workspace[0].join("web"), &[("core.hooksPath", ".husky/_")]);
        for dir in [
            workspace[0].join(".githooks"),
            workspace[0].join("linked/.githooks"),
            workspace[0].join("web/.githooks"),
            workspace[0].join("web/.husky/_"),
        ] {
            std::fs::create_dir_all(dir).unwrap();
        }
        TEST_GIT_CONFIGS.with(|files| *files.borrow_mut() = vec![xdg.join("git/config")]);
        let confined = super::layout(
            &home,
            &[attachments.clone(), outputs.clone()],
            Some(&workspace),
        )
        .unwrap();
        let script = "const {sandboxProfile, bwrapArguments} = await import(process.argv[1]); const [home, work, ...outputs] = process.argv.slice(2); const workspace = [work, outputs[1]]; console.log(JSON.stringify({profile: sandboxProfile(home, outputs), bwrap: bwrapArguments(home, outputs), confined: sandboxProfile(home, outputs, workspace), confinedBwrap: bwrapArguments(home, outputs, workspace), manual: sandboxProfile(home, outputs, [], workspace), manualBwrap: bwrapArguments(home, outputs, [], workspace)}));";
        let output = std::process::Command::new("node")
            .args(["--input-type=module", "-e", script, "--"])
            .arg(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../pi-runtime/isolation.ts"
            ))
            .args([&home, &workspace[0], &attachments, &outputs])
            .env("GIT_CONFIG_GLOBAL", xdg.join("git/config"))
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .output()
            .expect("node runs the extension's isolation module");
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let extension: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(
            extension["profile"].as_str().unwrap(),
            sandbox_profile(&layout)
        );
        let bwrap: Vec<OsString> = extension["bwrap"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().into())
            .collect();
        assert_eq!(bwrap, bwrap_arguments(&layout).unwrap());
        assert_eq!(
            extension["confined"].as_str().unwrap(),
            sandbox_profile(&confined)
        );
        assert!(sandbox_profile(&confined).contains("(deny network-outbound (remote ip))"));
        assert!(sandbox_profile(&confined).contains("(deny network-inbound)"));
        let confined_bwrap: Vec<OsString> = extension["confinedBwrap"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().into())
            .collect();
        assert_eq!(confined_bwrap, bwrap_arguments(&confined).unwrap());
        let manual = layout_scanned(
            &home,
            &[attachments.clone(), outputs],
            Some(&[]),
            &workspace,
        )
        .unwrap();
        assert_eq!(
            extension["manual"].as_str().unwrap(),
            sandbox_profile(&manual)
        );
        let manual_bwrap: Vec<OsString> = extension["manualBwrap"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().into())
            .collect();
        assert_eq!(manual_bwrap, bwrap_arguments(&manual).unwrap());
        let work = workspace[0].canonicalize().unwrap();
        assert!(confined_bwrap.windows(3).any(|w| w[0] == "--ro-bind"
            && w[1] == work.join(".git").as_os_str()
            && w[2] == work.join(".git").as_os_str()));
        assert!(confined_bwrap.windows(3).any(|w| w[0] == "--ro-bind"
            && w[1] == "/dev/null"
            && w[2] == work.join("app/.env").as_os_str()));
        for hooks in [
            work.join(".githooks"),
            work.join("linked/.githooks"),
            work.join("repo.gitconfig"),
            work.join("web/.husky/_"),
            work.join("web/.githooks"),
        ] {
            assert!(
                confined_bwrap
                    .windows(2)
                    .any(|w| w[0] == "--ro-bind" && w[1] == hooks.as_os_str()),
                "{}",
                hooks.display()
            );
        }
        TEST_GIT_CONFIGS.with(|files| files.borrow_mut().clear());
        assert!(
            !confined_bwrap
                .iter()
                .any(|arg| arg == work.join(".env.example").as_os_str())
        );
        assert!(sandbox_profile(&confined).contains("(deny appleevent-send)"));
        assert!(sandbox_profile(&layout).contains("(deny appleevent-send)"));
        assert!(confined_bwrap.iter().any(|arg| arg == "--unshare-net"));
        assert!(
            bwrap
                .iter()
                .any(|arg| arg == attachments.canonicalize().unwrap().as_os_str())
        );
        assert!(
            !bwrap
                .iter()
                .any(|arg| arg.to_string_lossy().contains("deep/auth.json"))
        );
    }
    #[test]
    fn host_write_tiers_follow_the_policy() {
        let Some(user) = std::env::var_os("HOME").map(PathBuf::from) else {
            return;
        };
        for path in [
            ".netrc",
            ".git-credentials",
            ".aws/credentials",
            ".config/gh/hosts.yml",
            ".kube/config",
        ] {
            assert_eq!(
                host_write_tier(&user.join(path)),
                Some(WriteTier::Deny),
                "{path}"
            );
        }
        assert_eq!(
            host_write_tier(Path::new("/etc/hosts")),
            Some(WriteTier::Deny)
        );
        for path in [
            ".zshrc",
            ".bashrc",
            ".gitconfig",
            "Library/LaunchAgents/com.example.plist",
            ".config/autostart/x.desktop",
            ".config/systemd/user/x.service",
            ".zlogin",
            ".bash_login",
            ".config/fish/config.fish",
            ".xprofile",
            ".local/share/systemd/user/x.service",
            ".config/git/config",
            ".cargo/config.toml",
        ] {
            assert_eq!(
                host_write_tier(&user.join(path)),
                Some(WriteTier::Ask),
                "{path}"
            );
        }
        if FOLD_CASE {
            assert_eq!(
                host_write_tier(&user.join(".AWS/credentials")),
                Some(WriteTier::Deny)
            );
            assert_eq!(host_write_tier(&user.join(".ZSHRC")), Some(WriteTier::Ask));
            assert_eq!(
                host_write_tier(&user.join("library/launchagents/x.plist")),
                Some(WriteTier::Ask)
            );
            assert_eq!(
                host_write_tier(Path::new("/ETC/hosts")),
                Some(WriteTier::Deny)
            );
            let home = tempfile::tempdir().unwrap();
            for path in [
                "AUTH.JSON",
                "profiles/owl/.ENV",
                "Connect.json",
                "CONNECT-IDENTITY.KEY",
                ".SSH/id_ed25519",
            ] {
                let path = if path.starts_with(".SSH") {
                    user.join(path)
                } else {
                    home.path().join(path)
                };
                assert!(credential_name(home.path(), &path), "{}", path.display());
            }
            assert!(!credential_name(
                home.path(),
                &user.join(".ssh/ID_ED25519.PUB")
            ));
        }
        assert_eq!(
            host_write_tier(Path::new("/Library/LaunchDaemons/x.plist")),
            Some(WriteTier::Ask)
        );
        for path in ["Hexbot/notes.md", ".config/other/settings.json", ".zshrc.d"] {
            assert_eq!(host_write_tier(&user.join(path)), None, "{path}");
        }
    }
    #[test]
    fn scheduled_scripts_always_need_a_sandbox() {
        assert_eq!(require_isolation().is_ok(), isolation_available());
    }
    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn newly_created_secrets_and_home_writes_are_denied() {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
        let base = tempfile::tempdir().unwrap();
        let home = base.path().join("home");
        let workspace = home.join("workspace");
        for path in [
            "workspace",
            "profiles/owl",
            "bin",
            "hooks",
            "skills",
            "profiles/owl/artifacts",
            "runtime/sessions/one/attachments",
        ] {
            std::fs::create_dir_all(home.join(path)).unwrap();
        }
        std::fs::write(base.path().join("connect.json"), "outside").unwrap();
        let script = format!(
            r#"echo ready; read -r go; secret='{}/profiles/owl'; cat "$secret/.env" >/dev/null 2>&1 && exit 10; cat "$secret/connect.json" >/dev/null 2>&1 && exit 13; cat "$secret/connect-identity.key" >/dev/null 2>&1 && exit 14; cat '{}/connect.json' || exit 11; for p in config.yaml bin/script hooks/script skills/script profiles/owl/config.yaml; do (echo bad > '{}'/$p) 2>/dev/null && exit 12; done; echo ok > '{}/result'; echo ok > '{}/profiles/owl/artifacts/result'; echo ok > '{}/runtime/sessions/one/attachments/result'; echo ok > '{}/normal-workspace'"#,
            home.display(),
            base.path().display(),
            home.display(),
            workspace.display(),
            home.display(),
            home.display(),
            base.path().display()
        );
        let mut child = isolated_command(
            &home,
            "/bin/bash",
            &[
                workspace.clone(),
                home.join("profiles/owl/artifacts"),
                home.join("runtime/sessions/one/attachments"),
            ],
            Confine::No,
        )
        .unwrap()
        .args(["-c", &script])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
        let mut output = BufReader::new(child.stdout.take().unwrap());
        let mut line = String::new();
        output.read_line(&mut line).await.unwrap();
        assert_eq!(line.trim(), "ready", "sandbox did not start");
        std::fs::write(home.join("profiles/owl/.env"), "secret").unwrap();
        std::fs::write(home.join("profiles/owl/connect.json"), "secret").unwrap();
        std::fs::write(home.join("profiles/owl/connect-identity.key"), "secret").unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(b"go\n")
            .await
            .unwrap();
        let result = child.wait_with_output().await.unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
    }
    /// Neither sandbox caps processes, so a workspace program runs behind a limit.
    #[tokio::test]
    async fn confined_programs_cannot_start_unbounded_processes() {
        if !isolation_available() {
            return;
        }
        let home = tempfile::tempdir().unwrap();
        let limit = |confine| {
            let mut command = isolated_command(home.path(), "/bin/bash", &[], confine).unwrap();
            command.args(["-c", "ulimit -u"]);
            async move {
                let output = command.output().await.unwrap();
                String::from_utf8_lossy(&output.stdout)
                    .trim()
                    .parse::<u64>()
                    .unwrap_or(u64::MAX)
            }
        };
        let own = limit(Confine::No).await;
        for confine in [Confine::Workspace, Confine::ReadOnly] {
            let capped = limit(confine).await;
            assert!(capped > 512 && capped < own, "{confine:?} {capped} {own}");
        }
    }
    #[test]
    fn code_floor() {
        for code in [
            "import shutil; shutil.rmtree('/')",
            "os.system('rm -rf /')",
            "shutil.rmtree(Path.home())",
            "os.kill(-1, 9)",
            "os.system('reboot')",
            r#"subprocess.run(["rm", "-rf", "/"])"#,
            r#"shutil.rmtree(os.environ["HOME"])"#,
        ] {
            assert!(check_code(code).is_err(), "{code}");
        }
        assert!(check_code("print('hello')").is_ok());
    }
    /// The deny tier holds for any program, by any spelling; run in a child with a
    /// scratch HOME because the stores are enumerated from the user's home.
    #[tokio::test]
    #[ignore = "run by credential_stores_are_unwritable_in_the_sandbox"]
    async fn credential_stores_unwritable_child() {
        let user = PathBuf::from(std::env::var_os("HOME").unwrap());
        if !isolation_available() {
            let home = tempfile::tempdir().unwrap();
            let args = bwrap_arguments(&layout(home.path(), &[], None).unwrap()).unwrap();
            for local in &policy().write.deny {
                let path = user.join(local);
                assert!(
                    args.windows(3).any(|args| args
                        == ["--ro-bind", path.to_str().unwrap(), path.to_str().unwrap()])
                );
            }
            return;
        }
        let home = tempfile::tempdir().unwrap();
        let script = "curl -s -o \"$HOME/.aws/credentials\" \"file://$HOME/source\" 2>/dev/null && exit 17; truncate -s0 \"$HOME/.netrc\" 2>/dev/null && exit 18; echo x > \"$HOME/.aws/credentials\" 2>/dev/null && exit 10; echo x > \"$HOME/.netrc\" 2>/dev/null && exit 12; echo x > \"$HOME/.npmrc\" 2>/dev/null && exit 13; python3 -c 'open(\"'\"$HOME\"'/.aws/other\",\"w\")' 2>/dev/null && exit 15; echo ok > \"$HOME/notes.txt\" || exit 16; echo done";
        let result = isolated_command(home.path(), "/bin/bash", &[], Confine::No)
            .unwrap()
            .args(["-c", script])
            .output()
            .await
            .unwrap();
        assert_eq!(
            String::from_utf8_lossy(&result.stdout),
            "done\n",
            "{:?} {}",
            result.status,
            String::from_utf8_lossy(&result.stderr)
        );
        assert_eq!(
            std::fs::read_to_string(user.join(".aws/credentials")).unwrap(),
            "keep"
        );
        assert_eq!(
            std::fs::read_to_string(user.join(".netrc")).unwrap(),
            "keep"
        );
        assert_eq!(
            std::fs::read_to_string(user.join("notes.txt")).unwrap(),
            "ok\n"
        );
    }
    #[test]
    fn credential_stores_are_unwritable_in_the_sandbox() {
        let user = tempfile::tempdir().unwrap();
        for local in &policy().write.deny {
            let path = user.path().join(local);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            if [
                ".aws",
                ".gnupg",
                ".kube",
                ".docker",
                ".azure",
                ".config/gh",
                ".config/gcloud",
            ]
            .contains(&local.as_str())
            {
                std::fs::create_dir_all(path).unwrap();
            } else if local != ".npmrc" || !cfg!(target_os = "macos") {
                std::fs::write(path, "keep").unwrap();
            }
        }
        std::fs::write(user.path().join(".aws/credentials"), "keep").unwrap();
        std::fs::write(user.path().join(".netrc"), "keep").unwrap();
        std::fs::write(user.path().join("source"), "replacement").unwrap();
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--ignored",
                "--exact",
                "credentials::tests::credential_stores_unwritable_child",
                "--nocapture",
            ])
            .env("HOME", user.path())
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
    #[tokio::test]
    async fn identity_key_is_hidden_in_auto_and_manual_sandboxes() {
        if !isolation_available() {
            return;
        }
        let home = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let key = home.path().join("connect-identity.key");
        std::fs::write(&key, "private key").unwrap();
        for mode in [Confine::Workspace, Confine::ReadOnly] {
            let result =
                isolated_command(home.path(), "/bin/sh", &[workspace.path().to_owned()], mode)
                    .unwrap()
                    .args(["-c", "cat \"$1\" && exit 10; echo denied", "identity-test"])
                    .arg(&key)
                    .output()
                    .await
                    .unwrap();
            assert!(
                result.status.success(),
                "{mode:?}: {}",
                String::from_utf8_lossy(&result.stderr)
            );
            assert_eq!(result.stdout, b"denied\n", "{mode:?}");
        }
    }
    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn python_isolated_from_secrets() {
        let home = tempfile::tempdir().unwrap();
        std::fs::write(home.path().join(".env"), "SECRET").unwrap();
        let result = isolated_command(home.path(), "/bin/cat", &[], Confine::No)
            .unwrap()
            .arg(home.path().join(".env"))
            .output()
            .await
            .unwrap();
        assert!(!result.status.success());
        let result = isolated_command(home.path(), "python3", &[], Confine::No)
            .unwrap()
            .args([
                "-c",
                &format!(
                    "open({:?}).read()",
                    home.path().join(".env").to_string_lossy()
                ),
            ])
            .output()
            .await
            .unwrap();
        assert!(!result.status.success());
        let result = isolated_command(home.path(), "/bin/echo", &[], Confine::No)
            .unwrap()
            .arg("ordinary")
            .output()
            .await
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        assert_eq!(result.stdout, b"ordinary\n");
    }
}
