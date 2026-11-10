//! Credential paths, host write tiers, the child environment, and child-process
//! isolation. All four come from `../../pi-runtime/credential-policy.json`, which the
//! private extension reads for Pi's bash and file tools; the parity test below keeps
//! the two sandbox builders identical. On Windows the same scan builds the policy
//! `hexbot sandbox exec` applies (`windows_policy`).
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
    #[serde(rename = "managedRuntime")]
    managed_runtime: Vec<String>,
    skip: Vec<String>,
    #[serde(rename = "readDeny")]
    read_deny: Vec<String>,
    /// Windows-only credential stores, applied on Windows alone.
    #[cfg(windows)]
    #[serde(rename = "windowsReadDeny", default)]
    windows_read_deny: Vec<String>,
    #[cfg(windows)]
    #[serde(rename = "windowsWriteDeny", default)]
    windows_write_deny: Vec<String>,
    write: WritePolicy,
    environment: Vec<String>,
    #[cfg(windows)]
    #[serde(rename = "windowsEnvironment")]
    windows_environment: Vec<String>,
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
/// The Windows-only read-denied stores, empty on other platforms.
fn windows_read() -> std::slice::Iter<'static, String> {
    #[cfg(windows)]
    {
        policy().windows_read_deny.iter()
    }
    #[cfg(not(windows))]
    {
        let empty: &[String] = &[];
        empty.iter()
    }
}
/// The Windows-only write-denied stores, empty on other platforms.
fn windows_write() -> std::slice::Iter<'static, String> {
    #[cfg(windows)]
    {
        policy().windows_write_deny.iter()
    }
    #[cfg(not(windows))]
    {
        let empty: &[String] = &[];
        empty.iter()
    }
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
/// `fs::canonicalize` in the form paths are compared in. On Windows that is
/// the plain `C:\x`, not `\\?\C:\x`, so a resolved path and a given one match.
pub(crate) fn canonical(path: &Path) -> std::io::Result<PathBuf> {
    let real = std::fs::canonicalize(path)?;
    #[cfg(windows)]
    if let Some(text) = real.to_str() {
        return crate::windows_paths::sandbox::simplify(text)
            .map(PathBuf::from)
            .map_err(|reason| {
                std::io::Error::new(std::io::ErrorKind::Unsupported, format!("{text}: {reason}"))
            });
    }
    Ok(real)
}
/// On Windows a path from a workspace, a Git setting or a link is checked by
/// its text before any file system call reaches it: a network, device or
/// stream path is never opened.
#[cfg(windows)]
fn local(path: &Path) -> Result<()> {
    path.to_str()
        .ok_or(crate::windows_paths::sandbox::RELATIVE)
        .and_then(crate::windows_paths::sandbox::local)
        .map(drop)
        .map_err(|reason| Error::new(5240, format!("{reason}: {}", path.display())))
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
/// One of the Hexbot home's credential stores by its place in the home (the
/// .env files, approvals, passwords, provider sign-ins, desktop data), not a
/// credential file name found anywhere.
#[cfg(any(windows, test))]
fn home_store(home: &Path, path: &Path) -> bool {
    let (_, local, ..) = patterns();
    folded(path)
        .strip_prefix(folded(home))
        .is_ok_and(|p| local.is_match(&p.to_string_lossy().replace('\\', "/")))
}
pub fn credential_name(home: &Path, path: &Path) -> bool {
    if user_homes()
        .iter()
        .any(|user| user_credential_name(user, path) || ssh_credential_name(user, path))
        || store_credential_name(path)
    {
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
        under(path, &secret) || canonical(&secret).is_ok_and(|p| under(path, &p))
    })
}
/// Credential stores such as ~/.aws and ~/.netrc are private to reads too.
fn store_credential_name(path: &Path) -> bool {
    policy()
        .write
        .deny
        .iter()
        .chain(windows_write())
        .flat_map(|entry| policy_roots(entry))
        .any(|store| under(path, &store) || canonical(&store).is_ok_and(|p| under(path, &p)))
}
fn ssh_credential_name(user: &Path, path: &Path) -> bool {
    let ssh = user.join(".ssh");
    [ssh.clone(), canonical(&ssh).unwrap_or(ssh)]
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
/// Windows programs can use USERPROFILE even when Git Bash sets a different
/// HOME. Protect both rather than trusting one spelling of the user's home.
fn user_homes() -> Vec<PathBuf> {
    let mut homes = vec![];
    for name in if cfg!(windows) {
        &["USERPROFILE", "HOME"][..]
    } else {
        &["HOME"][..]
    } {
        if let Some(path) = std::env::var_os(name).filter(|path| !path.is_empty()) {
            let path = PathBuf::from(path);
            if !homes.contains(&path) {
                homes.push(path);
            }
        }
    }
    homes
}
/// A policy entry is absolute or relative to every applicable user home.
fn policy_roots(entry: &str) -> Vec<PathBuf> {
    if Path::new(entry).is_absolute() {
        vec![PathBuf::from(entry)]
    } else {
        user_homes().iter().map(|user| user.join(entry)).collect()
    }
}
/// A managed runtime or selection path, including a parent that could replace
/// one. Callers check both lexical and resolved paths and homes. Output grants
/// never override this write denial; Bypass deliberately skips it.
pub(crate) fn managed_runtime_roots(home: &Path) -> Result<Vec<PathBuf>> {
    require_supported_execution()?;
    let real_home = real_root(home)?;
    let mut roots = Vec::new();
    for local in &policy().managed_runtime {
        let path = home.join(local);
        let real = real_root(&path)?;
        // A managed root must not point into a writable output or workspace.
        // Reject this topology instead of trying to maintain dynamic sandbox
        // deny rules for mutable root aliases. An alias of the home is fine.
        if folded(&real) != folded(&real_home.join(local)) {
            return Err(Error::new(
                4302,
                "Managed runtime roots must not be symlinked.",
            ));
        }
        for root in [path, real] {
            if !roots.contains(&root) {
                roots.push(root);
            }
        }
    }
    Ok(roots)
}
pub(crate) fn managed_runtime_path(home: &Path, path: &Path) -> Result<bool> {
    let roots = managed_runtime_roots(home)?;
    Ok(roots
        .iter()
        .any(|managed| under(path, managed) || under(managed, path)))
}
/// The file tools' tier for a host path.
pub fn host_write_tier(path: &Path) -> Option<WriteTier> {
    let write = &policy().write;
    let denied: Vec<String> = write.deny.iter().chain(windows_write()).cloned().collect();
    let tiers = [
        (WriteTier::Deny, &denied),
        (WriteTier::Deny, &write.file_deny),
        (WriteTier::Ask, &write.ask),
    ];
    for (tier, entries) in tiers {
        for root in entries.iter().flat_map(|entry| policy_roots(entry)) {
            if under(path, &root) || canonical(&root).is_ok_and(|root| under(path, &root)) {
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
        if let Ok(target) = canonical(&path) {
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
    for user in user_homes() {
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
        appcontainer().then_some("appcontainer")
    } else {
        bwrap().map(|_| "bubblewrap")
    }
}
/// Whether the AppContainer probe ran a contained command, once per process.
#[cfg(windows)]
fn appcontainer() -> bool {
    crate::windows_container::probe_available()
}
#[cfg(not(windows))]
fn appcontainer() -> bool {
    false
}
/// macOS always sandboxes (sandbox-exec fails closed). Elsewhere only bubblewrap
/// and an AppContainer that passed its probe do.
pub fn isolation_available() -> bool {
    sandbox().is_some()
}
/// The sandbox for session settings: its kind and, on Windows, the helper and
/// the shell Pi's commands run in, its path and kind, or why they have none:
/// the runtime has no shell, or it cannot start inside the sandbox. Null when
/// there is no sandbox.
pub fn sandbox_settings(home: &Path) -> Result<serde_json::Value> {
    let Some(kind) = sandbox() else {
        return Ok(serde_json::Value::Null);
    };
    #[cfg(windows)]
    {
        use crate::windows_sandbox::{SHELL_KIND, contained_shell, helper};
        let (shell, refusal) = match contained_shell(home) {
            Ok(path) => (
                serde_json::json!({"path": path, "kind": SHELL_KIND}),
                serde_json::Value::Null,
            ),
            Err(error) => (serde_json::Value::Null, serde_json::json!(error.message)),
        };
        Ok(serde_json::json!({
            "kind": kind,
            "helper": helper()?,
            "shell": shell,
            "shellRefusal": refusal,
        }))
    }
    #[cfg(not(windows))]
    {
        let _ = home;
        Ok(serde_json::json!({ "kind": kind }))
    }
}
/// The daemon runs its own executable as the Windows sandbox helper. An
/// integration test links this library into its own executable, which has no
/// `sandbox exec`, so it names the daemon binary once instead.
#[cfg(windows)]
pub fn use_sandbox_helper(helper: PathBuf) -> bool {
    crate::windows_sandbox::use_helper(helper)
}
/// Approval card text for code that would run without a sandbox.
#[cfg(not(windows))]
pub const UNSANDBOXED_REASON: &str = "Hexbot has no OS sandbox on this system, so this code can read any file you can, including credentials. Install bubblewrap and restart the daemon to restore isolation.";
#[cfg(windows)]
pub const UNSANDBOXED_REASON: &str = crate::windows_sandbox::UNAVAILABLE;

/// Auto/Manual execution must not turn missing Windows containment into an
/// approval that runs with the host user's permissions, so on Windows it needs
/// the AppContainer. Bypass callers do not use this helper or isolated_command.
pub fn require_supported_execution() -> Result<()> {
    if cfg!(windows) && !isolation_available() {
        return Err(Error::new(4302, UNSANDBOXED_REASON));
    }
    Ok(())
}
/// The daemon's Python worker and the file callbacks it reaches never run on
/// Windows, whatever the sandbox: code runs on the bot's own computer.
pub fn require_native_worker() -> Result<()> {
    #[cfg(windows)]
    return Err(Error::new(4302, crate::windows_sandbox::NATIVE_WORKER));
    #[cfg(not(windows))]
    Ok(())
}
pub fn warn_unavailable_isolation() {
    if isolation_available() {
        return;
    }
    static WARN: std::sync::Once = std::sync::Once::new();
    WARN.call_once(|| {
        #[cfg(windows)]
        eprintln!("{UNSANDBOXED_REASON}");
        #[cfg(not(windows))]
        eprintln!(
            "Hexbot has no OS sandbox on this system (bubblewrap is missing or cannot start). Shell commands and scripts can read any file you can. Manual and Auto ask before every shell command and code run, and scheduled scripts refuse to run. Install bubblewrap and restart the daemon to restore isolation."
        )
    });
}
/// Unattended scripts always require OS isolation.
pub fn require_isolation() -> Result<()> {
    require_supported_execution()?;
    if isolation_available() {
        return Ok(());
    }
    Err(Error::new(
        4302,
        "No OS sandbox is available, so scheduled scripts cannot run. Install bubblewrap and restart the daemon.",
    ))
}
#[cfg(unix)]
fn quoted(path: impl AsRef<str>) -> String {
    serde_json::to_string(path.as_ref()).unwrap()
}
/// The extension's escape set, so the profiles compare equal.
#[cfg(unix)]
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
#[cfg(unix)]
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
#[cfg(unix)]
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
#[cfg(unix)]
const DEVICES: [&str; 5] = [
    "/dev/null",
    "/dev/zero",
    "/dev/stdout",
    "/dev/stderr",
    "/dev/dtracehelper",
];
#[cfg(unix)]
struct Confinement {
    writable: Vec<PathBuf>,
    config: Vec<PathBuf>,
    protected: WorkspaceProtected,
    readable: Vec<PathBuf>,
}
#[cfg(unix)]
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
        .flat_map(|entry| policy_roots(entry))
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
pub(crate) fn real_root(path: &Path) -> std::io::Result<PathBuf> {
    real_root_after(path, 0)
}
fn real_root_after(path: &Path, hops: usize) -> std::io::Result<PathBuf> {
    match canonical(path) {
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
#[cfg(unix)]
fn denied_writes() -> Result<Vec<PathBuf>> {
    let mut denied: Vec<PathBuf> = vec![];
    for root in policy()
        .write
        .deny
        .iter()
        .flat_map(|entry| policy_roots(entry))
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
    type ReadCache = HashMap<Vec<PathBuf>, (Instant, Vec<PathBuf>)>;
    static CACHE: OnceLock<Mutex<ReadCache>> = OnceLock::new();
    let user = user_homes();
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
        .chain(windows_read())
        .flat_map(|entry| policy_roots(entry))
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
#[cfg(unix)]
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
/// from either. Matches isolation.ts. On Windows they are opened only by a
/// local disk path and never through a final link (`windows_sandbox`).
const GIT_FILE_BYTES: u64 = 1 << 20;
#[cfg(unix)]
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
#[cfg(windows)]
fn regular_file(path: &Path) -> Result<Option<Vec<u8>>> {
    crate::windows_sandbox::regular_file(path, GIT_FILE_BYTES)
}
#[cfg(unix)]
fn regular_file(path: &Path) -> Result<Option<Vec<u8>>> {
    use std::io::Read;
    use std::os::unix::fs::OpenOptionsExt;
    let file = match std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK)
        .open(path)
    {
        Ok(file) => file,
        Err(error)
            if error.kind() == std::io::ErrorKind::NotFound
                || [Some(libc::ENOTDIR), Some(libc::ENXIO)].contains(&error.raw_os_error()) =>
        {
            return Ok(None);
        }
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
#[cfg(unix)]
const GIT_CACHE: usize = 2048;
/// Windows reads Git settings itself rather than run a Git executable: there
/// is no trusted Git it could pick without the PATH, which a workspace can
/// change. Git for Windows expands `~` with HOME, else the user's profile.
#[cfg(windows)]
fn config_entries(text: &[u8]) -> Result<Vec<(String, String)>> {
    let home = ["HOME", "USERPROFILE"]
        .into_iter()
        .find_map(|name| std::env::var_os(name).filter(|value| !value.is_empty()))
        .map(PathBuf::from);
    git_config_settings(text, home.as_deref(), &|| {
        crate::windows_sandbox::git_install().map(|git| git.join("mingw64"))
    })
}
/// Git's config syntax, read as Git reads it: CRLF as LF, a UTF-8 byte order
/// mark skipped, and the end of the text as the end of a line.
#[cfg(any(windows, test))]
struct GitConfigText<'a> {
    bytes: &'a [u8],
    at: usize,
    end: bool,
}
#[cfg(any(windows, test))]
impl GitConfigText<'_> {
    fn next(&mut self) -> u8 {
        let Some(&c) = self.bytes.get(self.at) else {
            self.end = true;
            return b'\n';
        };
        self.at += 1;
        if c == b'\r' && self.bytes.get(self.at) == Some(&b'\n') {
            self.at += 1;
            return b'\n';
        }
        c
    }
}
/// Git's own whitespace and name characters, ASCII only.
#[cfg(any(windows, test))]
fn git_space(c: u8) -> bool {
    matches!(c, b' ' | b'\t' | b'\n' | b'\r')
}
#[cfg(any(windows, test))]
fn git_key_char(c: u8) -> bool {
    c.is_ascii_alphanumeric() || c == b'-'
}
/// The settings the scan follows (core.hooksPath, include.path and
/// includeIf.<condition>.path) as `git config --no-includes --path
/// --get-regexp` prints them, so Windows never runs Git to read a config.
/// Text Git refuses fails here too, as do `~user` and an unknown
/// `%(prefix)`, which this does not expand. `:(optional)` paths are kept
/// even when missing: the scan protects them in case they appear.
#[cfg(any(windows, test))]
fn git_config_settings(
    text: &[u8],
    home: Option<&Path>,
    prefix: &dyn Fn() -> Option<PathBuf>,
) -> Result<Vec<(String, String)>> {
    let bad = || Error::new(5240, "Git hook configuration could not be read.");
    static WANTED: OnceLock<regex::bytes::Regex> = OnceLock::new();
    let wanted = WANTED.get_or_init(|| {
        regex::bytes::Regex::new(r"^(core.hookspath|include.path|includeif\..*\.path)$").unwrap()
    });
    // NUL never appears in a config Git writes; refuse it rather than guess.
    if text.contains(&0) {
        return Err(bad());
    }
    let mut cfg = GitConfigText {
        bytes: text.strip_prefix(b"\xef\xbb\xbf").unwrap_or(text),
        at: 0,
        end: false,
    };
    let mut settings = Vec::new();
    let mut section: Vec<u8> = Vec::new();
    let mut comment = false;
    loop {
        let c = cfg.next();
        if c == b'\n' {
            if cfg.end {
                return Ok(settings);
            }
            comment = false;
            continue;
        }
        if comment || git_space(c) {
            continue;
        }
        if c == b'#' || c == b';' {
            comment = true;
            continue;
        }
        if c == b'[' {
            section = git_section(&mut cfg).ok_or_else(bad)?;
            section.push(b'.');
            continue;
        }
        if !c.is_ascii_alphabetic() {
            return Err(bad());
        }
        let mut name = section.clone();
        name.push(c.to_ascii_lowercase());
        let value = git_value(&mut cfg, &mut name).ok_or_else(bad)?;
        if !wanted.is_match(&name) {
            continue;
        }
        // A path setting without `=` has no value, which Git refuses.
        let value = String::from_utf8(value.ok_or_else(bad)?).map_err(|_| bad())?;
        let value = value.strip_prefix(":(optional)").unwrap_or(&value);
        let value = if let Some(rest) = value.strip_prefix("%(prefix)/") {
            format!("{}/{rest}", prefix().ok_or_else(bad)?.display())
        } else if let Some(rest) = value.strip_prefix('~') {
            let (user, rest) = rest.split_at(rest.find('/').unwrap_or(rest.len()));
            if !user.is_empty() {
                return Err(bad());
            }
            format!("{}{rest}", home.ok_or_else(bad)?.display())
        } else {
            value.to_owned()
        };
        settings.push((String::from_utf8_lossy(&name).into_owned(), value));
    }
}
/// A section header after its `[`: `[section]`, `[section "subsection"]` or
/// the old `[section.subsection]`, as the name settings start with.
#[cfg(any(windows, test))]
fn git_section(cfg: &mut GitConfigText) -> Option<Vec<u8>> {
    let mut name = Vec::new();
    loop {
        let c = cfg.next();
        if cfg.end {
            return None;
        }
        if c == b']' {
            break;
        }
        if git_space(c) {
            let mut c = c;
            while git_space(c) {
                if c == b'\n' {
                    return None;
                }
                c = cfg.next();
            }
            if c != b'"' {
                return None;
            }
            // A subsection keeps its case; a backslash escapes any byte.
            name.push(b'.');
            loop {
                let mut c = cfg.next();
                if c == b'\n' {
                    return None;
                }
                if c == b'"' {
                    break;
                }
                if c == b'\\' {
                    c = cfg.next();
                    if c == b'\n' {
                        return None;
                    }
                }
                name.push(c);
            }
            if cfg.next() != b']' {
                return None;
            }
            break;
        }
        if !git_key_char(c) && c != b'.' {
            return None;
        }
        name.push(c.to_ascii_lowercase());
    }
    (!name.is_empty()).then_some(name)
}
/// The rest of a setting's name and its value, None for text Git refuses.
/// A name without `=` has no value.
#[cfg(any(windows, test))]
fn git_value(cfg: &mut GitConfigText, name: &mut Vec<u8>) -> Option<Option<Vec<u8>>> {
    let mut c;
    loop {
        c = cfg.next();
        if cfg.end || !git_key_char(c) {
            break;
        }
        name.push(c.to_ascii_lowercase());
    }
    while c == b' ' || c == b'\t' {
        c = cfg.next();
    }
    if c == b'\n' {
        return Some(None);
    }
    if c != b'=' {
        return None;
    }
    // Whitespace around a value goes, inside it stays; quotes group and
    // `;` or `#` outside them starts a comment.
    let (mut quote, mut comment, mut trim) = (false, false, 0);
    let mut value = Vec::new();
    loop {
        let mut c = cfg.next();
        if c == b'\n' {
            if quote {
                return None;
            }
            if trim > 0 {
                value.truncate(trim);
            }
            return Some(Some(value));
        }
        if comment {
            continue;
        }
        if git_space(c) && !quote {
            if trim == 0 {
                trim = value.len();
            }
            if !value.is_empty() {
                value.push(c);
            }
            continue;
        }
        if !quote && (c == b';' || c == b'#') {
            comment = true;
            continue;
        }
        trim = 0;
        if c == b'\\' {
            c = match cfg.next() {
                b'\n' => continue,
                b't' => b'\t',
                b'b' => 0x08,
                b'n' => b'\n',
                c @ (b'\\' | b'"') => c,
                _ => return None,
            };
            value.push(c);
            continue;
        }
        if c == b'"' {
            quote = !quote;
            continue;
        }
        value.push(c);
    }
}
#[cfg(unix)]
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
    let mut child = std::process::Command::new("/usr/bin/git")
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
    let pid = child.id() as libc::pid_t;
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
            // SAFETY: the waiting thread has not reaped the child, so the pid is still ours.
            unsafe { libc::kill(pid, libc::SIGKILL) };
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
/// system file elsewhere; it is not read. Matches isolation.ts. Git for Windows
/// reads %ProgramData%\Git\config and its own etc\gitconfig as system files,
/// and uses the user's profile when HOME is not set.
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
    let home = set("HOME").or_else(|| set("USERPROFILE").filter(|_| cfg!(windows)));
    let mut files = match (set("GIT_CONFIG_GLOBAL"), home) {
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
        // Git for Windows reads this one even when GIT_CONFIG_SYSTEM is set.
        if cfg!(windows) {
            files.extend(set("ProgramData").map(|root| root.join(r"Git\config")));
        }
        match set("GIT_CONFIG_SYSTEM") {
            Some(path) => files.push(path),
            None if cfg!(windows) => {
                files.extend(set("ProgramFiles").map(|root| root.join(r"Git\etc\gitconfig")));
                // Git for Windows installed elsewhere keeps its system file there.
                #[cfg(all(windows, not(test)))]
                if let Some(file) =
                    crate::windows_sandbox::git_install().map(|git| git.join(r"etc\gitconfig"))
                    && !files.contains(&file)
                {
                    files.push(file);
                }
            }
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
    #[cfg(windows)]
    local(&path)?;
    linked(protected, configs, &path, &[])?;
    Ok(real_root(&path)?)
}
/// The path is walked as the kernel walks it, so a `..` after a link leaves the
/// link's target, not the link's folder. Links inside locked Git metadata
/// (`exempt`) are locked with it. On Windows a drive starts the walk again
/// on that drive, and a link to anything but a local disk (a network share,
/// a device) fails the walk before it is read.
fn linked(
    protected: &mut WorkspaceProtected,
    configs: &GitConfigs,
    path: &Path,
    exempt: &[PathBuf],
) -> Result<()> {
    use std::path::{Component, Prefix};
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
            Some(Component::Prefix(prefix)) => match prefix.kind() {
                Prefix::Disk(drive) | Prefix::VerbatimDisk(drive) => {
                    // A mapped network drive is not local, whatever its
                    // letter says; the scan follows links only on fixed
                    // drives.
                    #[cfg(windows)]
                    crate::windows_sandbox::fixed_drive(&format!("{}:\\", drive as char))?;
                    dir = PathBuf::from(format!("{}:", drive as char))
                }
                _ => {
                    return Err(Error::new(
                        5240,
                        format!(
                            "Git metadata is reached through a network or device path: {}",
                            path.display()
                        ),
                    ));
                }
            },
            // The drive, if any, stays.
            Some(Component::RootDir) => dir.push(&part),
            Some(Component::ParentDir) => {
                dir.pop();
            }
            Some(Component::Normal(name)) => {
                let next = dir.join(name);
                #[cfg(windows)]
                local(&next)?;
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
    Ok(())
}
/// On Windows a link in the workspace can name a network share, which the
/// scan must never reach: only a link whose every hop stays on a local disk
/// is followed.
#[cfg(windows)]
pub(crate) fn local_link(path: &Path) -> bool {
    linked(
        &mut WorkspaceProtected::default(),
        &GitConfigs::default(),
        path,
        &[],
    )
    .is_ok()
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
    // First, before anything resolves the path: on Windows a `.git` that is
    // a link to a network share fails here, unopened.
    linked(protected, configs, path, &[])?;
    add_path(&mut protected.git, path)?;
    protected.worktrees.insert(real_root(worktree)?);
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
            linked(protected, configs, &entry, &exempt)?;
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
        && present(&path.join("HEAD"))
        && present(&path.join("objects"))
}
/// Whether Git metadata has this entry. Windows does not follow a link to
/// find out: it may name a network share. Counting one as present only
/// protects more.
fn present(path: &Path) -> bool {
    if cfg!(windows) {
        path.symlink_metadata().is_ok()
    } else {
        path.exists()
    }
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
            if present(&marker) {
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
            #[cfg(windows)]
            {
                // Every reparse point, not only symlinks: a directory
                // junction is not is_symlink(), and the scan must never
                // follow one to a network share. Unreadable metadata fails
                // the scan rather than risk opening the entry.
                let reparse = entry.metadata().is_ok_and(|meta| {
                    use std::os::windows::fs::MetadataExt;
                    meta.file_attributes() & 0x400 != 0
                });
                if reparse && !local_link(&path) {
                    protected.failure = true;
                    continue;
                }
            }
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
/// Bubblewrap and the Windows sandbox name the paths they protect, so a scan
/// that stopped early cannot protect a workspace and the code does not run.
fn scan_complete(scan: &WorkspaceProtected) -> Result<()> {
    if scan.exhausted {
        return Err(Error::new(5240, SCAN_REASON));
    }
    if scan.failure {
        return Err(Error::new(
            5240,
            format!(
                "Git metadata or hook configuration could not be scanned{}, so this code cannot run in the sandbox.",
                because(scan)
            ),
        ));
    }
    Ok(())
}
fn because(scan: &WorkspaceProtected) -> String {
    scan.cause
        .as_ref()
        .map(|cause| format!(" because {cause}"))
        .unwrap_or_default()
}
pub(crate) fn git_write_protected(path: &Path, roots: &[PathBuf]) -> Result<bool> {
    require_supported_execution()?;
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
#[cfg(unix)]
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
#[cfg(unix)]
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
#[cfg(all(test, unix))]
fn layout(home: &Path, writable: &[PathBuf], workspace: Option<&[PathBuf]>) -> Result<Layout> {
    layout_scanned(home, writable, workspace, workspace.unwrap_or_default())
}
#[cfg(unix)]
fn layout_scanned(
    home: &Path,
    writable: &[PathBuf],
    workspace: Option<&[PathBuf]>,
    search: &[PathBuf],
) -> Result<Layout> {
    let mut roots = vec![home.to_owned(), std::fs::canonicalize(home)?];
    roots.dedup();
    let managed = managed_runtime_roots(home)?;
    let writable = writable
        .iter()
        .filter_map(|p| std::fs::canonicalize(p).ok())
        .filter(|p| roots.iter().any(|root| p != root && p.starts_with(root)))
        .filter(|p| !managed.iter().any(|root| under(p, root) || under(root, p)))
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
#[cfg(unix)]
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
#[cfg(unix)]
fn bwrap_arguments(layout: &Layout) -> Result<Vec<OsString>> {
    if let Some(confine) = &layout.confine {
        scan_complete(&confine.protected)?;
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
#[cfg(unix)]
const PROCESS_HEADROOM: usize = 512;
#[cfg(unix)]
fn process_limit() -> Option<usize> {
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
#[cfg(unix)]
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
    Ok(command)
}
/// On Windows the command is `hexbot sandbox exec <policy> -- <program>`: the
/// helper grants the policy to its own AppContainer, which has no network,
/// and runs the program there. Dropping the command's child ends the helper,
/// whose job ends the program's whole tree.
#[cfg(windows)]
pub(crate) fn isolated_command_with_outputs(
    home: &Path,
    program: &str,
    writable: &[PathBuf],
    confine: Confine,
    approved_outputs: &[PathBuf],
) -> Result<tokio::process::Command> {
    windows_command(home, program, writable, confine, approved_outputs, &[])
}
/// A scheduled script's command. On Windows the folder the script sits in
/// outside its roots (the bot's scripts folder) is readable too, since a
/// container reads only what it is granted; the other sandboxes read
/// everything outside the credential stores already.
pub(crate) fn script_command(
    home: &Path,
    program: &str,
    writable: &[PathBuf],
    confine: Confine,
    readable: &[PathBuf],
) -> Result<tokio::process::Command> {
    #[cfg(windows)]
    return windows_command(home, program, writable, confine, &[], readable);
    #[cfg(not(windows))]
    {
        let _ = readable;
        isolated_command(home, program, writable, confine)
    }
}
/// The helper and policy Pi runs one of a section's commands with on Windows.
/// `cwd` is the section's working folder and `outputs` its output folders;
/// in Manual the outputs are the approved writable folders.
pub fn sandbox_policy(
    home: &Path,
    cwd: &Path,
    outputs: &[PathBuf],
    confine: Confine,
) -> Result<(PathBuf, String)> {
    #[cfg(windows)]
    {
        let mut roots = vec![cwd.to_path_buf()];
        roots.extend(outputs.iter().cloned());
        let policy = windows_command_policy(home, &roots, confine, outputs, &[])?;
        Ok((crate::windows_sandbox::helper()?, policy))
    }
    #[cfg(not(windows))]
    {
        let _ = (home, cwd, outputs, confine);
        Err(Error::new(
            4302,
            "Only the Windows sandbox runs commands through a policy helper.",
        ))
    }
}
#[cfg(windows)]
fn windows_command(
    home: &Path,
    program: &str,
    writable: &[PathBuf],
    confine: Confine,
    approved_outputs: &[PathBuf],
    readable: &[PathBuf],
) -> Result<tokio::process::Command> {
    let policy = windows_command_policy(home, writable, confine, approved_outputs, readable)?;
    let (program, leading) = windows_program(home, program)?;
    let mut command = tokio::process::Command::new(crate::windows_sandbox::helper()?);
    command
        .args(["sandbox", "exec"])
        .arg(policy)
        .arg("--")
        .arg(program)
        .args(leading);
    Ok(command)
}
/// The program a contained command starts, by its full path, and the
/// arguments that come before the caller's. `bash`, which shell scripts run
/// in, is the runtime's BusyBox running its `sh`, once its probe ran it
/// inside the sandbox. A contained command never searches the PATH, which a
/// workspace can change.
#[cfg(windows)]
fn windows_program(home: &Path, program: &str) -> Result<(PathBuf, &'static [&'static str])> {
    if program == "bash" {
        let shell = crate::windows_sandbox::contained_shell(home)?;
        return Ok((shell, &[crate::windows_sandbox::SHELL_APPLET]));
    }
    let path = Path::new(program);
    if !path.is_absolute() {
        return Err(Error::new(
            4302,
            format!(
                "The Windows sandbox starts programs by their full path, so {program} cannot run."
            ),
        ));
    }
    local(path)?;
    Ok((path.to_owned(), &[]))
}
/// A policy is one command-line argument, and a Windows command line holds
/// 32,767 characters with the program and its arguments.
#[cfg(windows)]
const POLICY_CHARS: usize = 24 * 1024;
/// The base64 policy for `hexbot sandbox exec`. Full access refuses first;
/// then every path is checked by its text, before the scan reaches it.
#[cfg(windows)]
fn windows_command_policy(
    home: &Path,
    writable: &[PathBuf],
    confine: Confine,
    approved_outputs: &[PathBuf],
    readable: &[PathBuf],
) -> Result<String> {
    use base64::Engine;
    if confine == Confine::No {
        return Err(Error::new(4302, crate::windows_paths::sandbox::FULL_ACCESS));
    }
    require_supported_execution()?;
    for path in std::iter::once(home)
        .chain(writable.iter().map(PathBuf::as_path))
        .chain(approved_outputs.iter().map(PathBuf::as_path))
        .chain(readable.iter().map(PathBuf::as_path))
    {
        local(path)?;
    }
    let readable: Vec<PathBuf> = readable
        .iter()
        .filter(|path| path.exists())
        .cloned()
        .collect();
    let roots: Vec<PathBuf> = writable.iter().chain(&readable).cloned().collect();
    let scan = workspace_protected(&roots, WORKSPACE_DIRS)?;
    let mut programs = crate::windows_sandbox::programs(home);
    programs.extend(readable);
    let mut policy = windows_policy(home, writable, confine, approved_outputs, &scan, &programs)?;
    // Every command may run the runtime's shell; the helper keeps it out of
    // the container's name.
    policy.shell = crate::windows_sandbox::bundled_shell();
    let json = serde_json::to_vec(&policy).map_err(|error| Error::new(5200, error.to_string()))?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(json);
    if encoded.len() > POLICY_CHARS {
        return Err(Error::new(5240, crate::windows_sandbox::TOO_LARGE));
    }
    Ok(encoded)
}
/// What one contained command may reach on Windows, from the scan the other
/// sandboxes use. Auto writes `writable`, the working folder and outputs;
/// Manual reads them and writes only `approved_outputs` in the home. Every
/// policy reads `programs`. Git metadata in a writable root is never written,
/// and project secrets and credential files under a granted root are never
/// read. A root may sit inside the Hexbot home, as outputs do, but a root
/// that is, holds or sits inside one of its credential stores is refused,
/// as are a scan that stopped early and the base layer alone (full_access).
/// The helper refuses the rest: the user's profile and its credential
/// stores, the home itself and the managed runtime.
#[cfg(any(windows, test))]
fn windows_policy(
    home: &Path,
    writable: &[PathBuf],
    confine: Confine,
    approved_outputs: &[PathBuf],
    scan: &WorkspaceProtected,
    programs: &[PathBuf],
) -> Result<crate::windows_paths::sandbox::Policy> {
    use crate::windows_paths::sandbox::{Access, FULL_ACCESS, Policy, STORE};
    let access = match confine {
        Confine::No => return Err(Error::new(4302, FULL_ACCESS)),
        Confine::Workspace => Access::Workspace,
        Confine::ReadOnly => Access::Read,
    };
    scan_complete(scan)?;
    let real = |paths: &[PathBuf]| -> Result<Vec<PathBuf>> {
        let mut roots = Vec::new();
        for path in paths {
            let root = canonical(path)?;
            if !roots.contains(&root) {
                roots.push(root);
            }
        }
        Ok(roots)
    };
    let (writable, mut readable) = match access {
        Access::Workspace => (real(writable)?, Vec::new()),
        Access::Read => {
            let outputs: Vec<PathBuf> = approved_outputs
                .iter()
                .filter(|path| under(path, home))
                .cloned()
                .collect();
            (real(&outputs)?, real(writable)?)
        }
    };
    // A root inside a writable one is granted by it already.
    for root in real(programs)? {
        if !readable.contains(&root) {
            readable.push(root);
        }
    }
    readable.retain(|root| !within(root, &writable));
    let credentials = secret_paths(home);
    for root in writable.iter().chain(&readable) {
        if credential_name(home, root)
            || credentials
                .iter()
                .any(|path| under(path, root) && home_store(home, path))
        {
            return Err(Error::new(4302, format!("{STORE}: {}", root.display())));
        }
    }
    let granted: Vec<PathBuf> = writable.iter().chain(&readable).cloned().collect();
    let mut deny_all = PathSet::default();
    for path in scan.secrets.iter().chain(&credentials) {
        // A link denies nothing: its target is not granted unless it is
        // inside a root, where it is found as itself.
        let real = canonical(path).unwrap_or_else(|_| path.clone());
        if within(&real, &granted) {
            deny_all.insert(real);
        }
    }
    Ok(Policy {
        home: canonical(home)?,
        access: Some(access),
        deny_write: locked_git(scan, &writable, true)?,
        deny_all: deny_all.list,
        writable,
        readable,
        shell: None,
    })
}
/// Variables every child may inherit. Provider keys, connector secrets, and runtime
/// injection variables (NODE_OPTIONS, BASH_ENV) are never on the list.
pub fn inherited_environment(name: &str) -> bool {
    // Windows children need OS and profile locations even with env_clear().
    // This extends only the location allowlist, never provider/injection keys.
    #[cfg(windows)]
    if policy()
        .windows_environment
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
#[cfg(all(test, unix))]
mod tests {
    use super::*;
    #[test]
    fn uv_cache_hardlinks_do_not_require_dependency_tree_walks_to_launch() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let home = root.join("home");
        let work = root.join("work");
        let output = home.join("profiles/owl/artifacts");
        let package = home.join("runtime/tools/code-python/site-packages/voice.py");
        let cache = home.join("runtime/uv-cache/voice.py");
        let ignored = work.join("node_modules");
        for path in [
            package.parent().unwrap(),
            cache.parent().unwrap(),
            &output,
            &ignored,
        ] {
            std::fs::create_dir_all(path).unwrap();
        }
        std::fs::write(&package, "trusted package").unwrap();
        std::fs::hard_link(&package, &cache).unwrap();
        // A stand-in for a dependency tree whose contents are not needed to
        // launch a command. The Git scan already excludes node_modules.
        std::fs::set_permissions(&ignored, std::fs::Permissions::from_mode(0o000)).unwrap();
        let grants = [work, output.clone()];
        let mut commands = vec![];
        for mode in [Confine::No, Confine::Workspace, Confine::ReadOnly] {
            for program in ["/bin/sh", "/usr/bin/python3"] {
                commands.push((
                    program,
                    isolated_command_with_outputs(
                        &home,
                        program,
                        &grants,
                        mode,
                        std::slice::from_ref(&output),
                    ),
                ));
            }
        }
        std::fs::set_permissions(&ignored, std::fs::Permissions::from_mode(0o755)).unwrap();
        for (program, command) in commands {
            let mut command = command.unwrap();
            command.arg("-c").arg(if program.ends_with("python3") {
                "print('launched')"
            } else {
                "printf launched"
            });
            let result = command.as_std_mut().output().unwrap();
            assert!(
                result.status.success(),
                "{}",
                String::from_utf8_lossy(&result.stderr)
            );
            assert!(String::from_utf8_lossy(&result.stdout).contains("launched"));
        }
        assert_eq!(std::fs::read_to_string(package).unwrap(), "trusted package");
    }
    #[tokio::test]
    async fn managed_runtime_outputs_never_reopen_runtime_or_selection() {
        if !isolation_available() {
            return;
        }
        let home = tempfile::tempdir().unwrap();
        let mut outputs = vec![];
        let mut files = vec![];
        for local in &policy().managed_runtime {
            let path = if local.ends_with(".json") {
                home.path().join(local)
            } else {
                home.path().join(local).join("probe")
            };
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, "keep").unwrap();
            outputs.push(path.parent().unwrap().to_owned());
            files.push(path);
        }
        let script = files
            .iter()
            .map(|path| {
                format!(
                    "if (echo changed > '{}') 2>/dev/null; then exit 23; fi",
                    path.display()
                )
            })
            .collect::<Vec<_>>()
            .join("; ");
        let output = isolated_command(home.path(), "/bin/sh", &outputs, Confine::No)
            .unwrap()
            .args(["-c", &script])
            .output()
            .await
            .unwrap();
        assert!(output.status.success(), "{output:?}");
        for path in files {
            assert_eq!(std::fs::read_to_string(path).unwrap(), "keep");
        }
    }
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
        for name in [
            "NODE_OPTIONS",
            "BASH_ENV",
            "OPENAI_API_KEY",
            "SystemRoot",
            "WINDIR",
            "USERPROFILE",
            "APPDATA",
            "LOCALAPPDATA",
            "PATHEXT",
            "COMSPEC",
            "DISPLAY",
        ] {
            assert!(!inherited_environment(name), "{name}");
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

    /// What Git prints for the settings the scan follows, or None when Git
    /// refuses the text. HOME is /h, as the reader is given below.
    #[cfg(unix)]
    fn git_settings(text: &[u8]) -> Option<Vec<(String, String)>> {
        use std::io::Write;
        let mut child = std::process::Command::new("/usr/bin/git")
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
            .env("HOME", "/h")
            .env("PATH", "/usr/bin:/bin")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(text).unwrap();
        let output = child.wait_with_output().unwrap();
        if !output.status.success()
            && !(output.status.code() == Some(1) && output.stderr.is_empty())
        {
            return None;
        }
        Some(
            String::from_utf8(output.stdout)
                .unwrap()
                .split('\0')
                .filter_map(|field| field.split_once('\n'))
                .map(|(key, value)| (key.to_owned(), value.to_owned()))
                .collect(),
        )
    }

    #[test]
    #[cfg(unix)]
    fn the_windows_git_config_reader_reads_what_git_reads() {
        let cases: &[&[u8]] = &[
            b"[core]\n\thooksPath = .githooks\n",
            b"[core] hooksPath = a b  \n",
            b"[core]\n  hooksPath = \"a  b\"  # c\n",
            b"[core]\nhooksPath=a\\\n b\n",
            b"[core]\n\thooksPath = a\\\r\n b\n",
            b"[includeIf \"gitdir:~/Work/\"]\n\tpath = x\n",
            b"[includeIf \"gitdir:/w\xc3\xb6rk/\"]\n\tpath = \xc3\xbc\n",
            b"[includeIf.gitdir:x]\n\tpath = x\n",
            b"[Include]\n\tPATH = x\n",
            b"[core]\r\n\thooksPath = x\r\n",
            b"\xef\xbb\xbf[core]\n\thooksPath = x\n",
            b"\xef\xbb[core]\n\thooksPath = x\n",
            b"[core]\n\thooksPath = a\\qb\n",
            b"[core]\n\thooksPath = \"a\n",
            b"[include \"sub\"]\n\tpath = x\n",
            b"[includeif \"a\\\"b\\\\c\\d\"]\n\tpath = x\n",
            b"[core]\n\thooksPath = a\\tb\\\"c\\\\d\\nx\\by\n",
            b"hooksPath = x\n",
            b"[core]\n\thooksPath = x;y\n",
            b"[core]\n\thooksPath = \"\"\n",
            b"[core]\n\thooksPath =\n",
            b"[ core ]\n\thooksPath = x\n",
            b"[core \"x\" ]\n\thooksPath = x\n",
            b"[ \"sub\"]\n\tpath = x\n",
            b"[]\n",
            b"[core",
            b"[core]\n\thooks-path = x\n\thooksPath2 = y\n",
            b"[core]\n\t1hooksPath = x\n",
            b"[core]\n\thooksP\xc3\xa4th = x\n",
            b"[core]\n\thooksPath = x\n\thooksPath = y\n",
            b"[core.Sub]\n\thooksPath = x\n",
            b"[include.]\n\tpath = x\n",
            b"[core]\n\thooksPath = x # c \"q\n",
            b"[core]\n\thooksPath = \"x # y\"\n",
            b"[core]\n\thooksPath = \"a\" \"b\"\n",
            b"[core]\n\thooksPath = ~/hooks\n",
            b"[core]\n\thooksPath = ~\n",
            b"[include]\n\tpath\n",
            b"[core]\n\tbare\n\thooksPath = x\n",
            b"[core]\n\thooksPath = %(prefix)x\n",
            b"[section]\n# comment\n; other\n\n[core]\n\thooksPath = y # trailing\n",
            b"[core]\n\thooksPath = \t x \t \n",
            b"[core]\n\thooksPath = x\\\n",
            b"[core]\n\thooksPath = x",
            b"[core]\n\thooksPath = x\x0cy\x0bz\n",
            b"[core]\n\t\x0chooksPath = x\n",
            b"[core]\n\thooksPath \x0c= x\n",
            b"[core]\n\thooksPath\t= x\n",
            b"[core]hooksPath=x[include]path=y\n",
            b"[core]\n\thooksPath = x\n[include]\n\tpath = ../a.inc\n\tpath = /abs/b.inc\n",
        ];
        for text in cases {
            assert_eq!(
                git_config_settings(text, Some(Path::new("/h")), &|| None).ok(),
                git_settings(text),
                "{}",
                String::from_utf8_lossy(text)
            );
        }
        // Git leaves out a missing optional include; the scan keeps it, in
        // case it appears. `%(prefix)` is Git's own install folder.
        let read = |text: &[u8], prefix: Option<&str>| {
            git_config_settings(text, Some(Path::new("/h")), &|| prefix.map(PathBuf::from))
        };
        assert_eq!(
            read(b"[include]\n\tpath = :(optional)~/missing\n", None).unwrap(),
            [("include.path".to_owned(), "/h/missing".to_owned())]
        );
        assert_eq!(
            read(b"[include]\n\tpath = %(prefix)/etc/x\n", Some("/git")).unwrap(),
            [("include.path".to_owned(), "/git/etc/x".to_owned())]
        );
        // What this reader does not expand fails the scan rather than guess.
        for text in [
            &b"[include]\n\tpath = %(prefix)/etc/x\n"[..],
            b"[include]\n\tpath = ~root/x\n",
            b"[core]\n\thooksPath = a\0b\n",
            b"[core]\n\thooksPath = \xff\n",
        ] {
            assert!(
                read(text, None).is_err(),
                "{}",
                String::from_utf8_lossy(text)
            );
        }
        assert!(git_config_settings(b"[core]\n\thooksPath = ~/x\n", None, &|| None).is_err());
    }

    /// A home with outputs and credential stores, and a workspace with Git
    /// metadata and secrets, as the Windows policy sees them.
    struct PolicyFixture {
        _base: tempfile::TempDir,
        home: PathBuf,
        work: PathBuf,
        artifacts: PathBuf,
        attachments: PathBuf,
        python: PathBuf,
    }
    fn policy_fixture() -> PolicyFixture {
        let base = tempfile::tempdir().unwrap();
        let root = base.path().canonicalize().unwrap();
        let (home, work) = (root.join("home"), root.join("work"));
        let artifacts = home.join("profiles/owl/artifacts");
        let attachments = home.join("runtime/sessions/first/attachments");
        let python = home.join("runtime/tools/code-python");
        for dir in [
            &artifacts,
            &attachments,
            &python.join("Lib/site-packages/tool"),
            &home.join("users/alice/passwords"),
            &home.join("runtime/provider-auth"),
            &work.join("src"),
            &work.join("nested"),
        ] {
            std::fs::create_dir_all(dir).unwrap();
        }
        for (path, text) in [
            (home.join("connect.json"), "private"),
            (home.join("profiles/owl/.env"), "private"),
            (python.join("Lib/site-packages/tool/auth.json"), "{}"),
            (work.join(".env"), "private"),
            (work.join("nested/.envrc"), "private"),
            (work.join(".env.example"), "public"),
            (work.join("src/a.txt"), "hello"),
        ] {
            std::fs::write(path, text).unwrap();
        }
        git_init(&work, &[]);
        PolicyFixture {
            _base: base,
            home,
            work,
            artifacts,
            attachments,
            python,
        }
    }

    #[test]
    fn the_windows_policy_grants_the_workspace_and_denies_git_and_secrets() {
        let f = policy_fixture();
        let roots = [f.work.clone(), f.artifacts.clone(), f.attachments.clone()];
        let scan = workspace_protected(&roots, WORKSPACE_DIRS).unwrap();
        let programs = [f.python.clone()];
        // Auto writes the working folder and outputs and reads the programs.
        let auto =
            windows_policy(&f.home, &roots, Confine::Workspace, &[], &scan, &programs).unwrap();
        assert_eq!(auto.home, f.home);
        assert_eq!(
            auto.access,
            Some(crate::windows_paths::sandbox::Access::Workspace)
        );
        assert_eq!(auto.writable, roots);
        assert_eq!(auto.readable, programs);
        assert!(auto.deny_write.contains(&f.work.join(".git")));
        for secret in [f.work.join(".env"), f.work.join("nested/.envrc")] {
            assert!(auto.deny_all.contains(&secret), "{}", secret.display());
        }
        // A credential file in a granted root is denied; the root stays.
        assert!(
            auto.deny_all
                .contains(&f.python.join("Lib/site-packages/tool/auth.json"))
        );
        for public in [f.work.join(".env.example"), f.work.join("src/a.txt")] {
            assert!(!auto.deny_all.contains(&public), "{}", public.display());
        }
        // Manual reads them and writes only the approved output in the home.
        let outside = f.work.join("src");
        let manual = windows_policy(
            &f.home,
            &roots,
            Confine::ReadOnly,
            &[f.artifacts.clone(), outside],
            &scan,
            &programs,
        )
        .unwrap();
        assert_eq!(
            manual.access,
            Some(crate::windows_paths::sandbox::Access::Read)
        );
        assert_eq!(manual.writable, std::slice::from_ref(&f.artifacts));
        assert_eq!(
            manual.readable,
            [f.work.clone(), f.attachments.clone(), f.python.clone()]
        );
        assert!(manual.deny_write.is_empty());
        assert!(manual.deny_all.contains(&f.work.join(".env")));
        let manual_only_reads =
            windows_policy(&f.home, &roots, Confine::ReadOnly, &[], &scan, &programs).unwrap();
        assert!(manual_only_reads.writable.is_empty());
        // The policy round-trips through the helper's argument.
        let json = serde_json::to_vec(&auto).unwrap();
        assert_eq!(
            serde_json::from_slice::<crate::windows_paths::sandbox::Policy>(&json).unwrap(),
            auto
        );
    }

    #[test]
    fn the_windows_policy_refuses_full_access_partial_scans_and_credential_roots() {
        let f = policy_fixture();
        let roots = [f.work.clone(), f.artifacts.clone()];
        let scan = workspace_protected(&roots, WORKSPACE_DIRS).unwrap();
        let error = windows_policy(&f.home, &roots, Confine::No, &[], &scan, &[]).unwrap_err();
        assert_eq!(error.code, 4302);
        assert_eq!(error.message, crate::windows_paths::sandbox::FULL_ACCESS);
        let exhausted = WorkspaceProtected {
            exhausted: true,
            ..Default::default()
        };
        let error =
            windows_policy(&f.home, &roots, Confine::Workspace, &[], &exhausted, &[]).unwrap_err();
        assert_eq!(error.message, SCAN_REASON);
        let failed = WorkspaceProtected {
            failure: true,
            cause: Some("a config could not be read".into()),
            ..Default::default()
        };
        let error =
            windows_policy(&f.home, &roots, Confine::ReadOnly, &[], &failed, &[]).unwrap_err();
        assert!(
            error.message.contains("because a config could not be read"),
            "{}",
            error.message
        );
        // Roots that are, hold or sit inside one of the home's credential
        // stores are refused, writable or not; ordinary outputs are not.
        for root in [
            f.home.join("users/alice"),
            f.home.join("users"),
            f.home.join("users/alice/passwords"),
            f.home.join("runtime/provider-auth"),
            f.home.join("runtime"),
            f.home.join("profiles/owl"),
            f.home.join("connect.json"),
        ] {
            for confine in [Confine::Workspace, Confine::ReadOnly] {
                let error = windows_policy(
                    &f.home,
                    std::slice::from_ref(&root),
                    confine,
                    &[],
                    &WorkspaceProtected::default(),
                    &[],
                )
                .unwrap_err();
                assert_eq!(error.code, 4302, "{}", root.display());
                assert!(
                    error
                        .message
                        .starts_with(crate::windows_paths::sandbox::STORE),
                    "{}: {}",
                    root.display(),
                    error.message
                );
            }
            let error = windows_policy(
                &f.home,
                std::slice::from_ref(&f.work),
                Confine::Workspace,
                &[],
                &WorkspaceProtected::default(),
                std::slice::from_ref(&root),
            )
            .unwrap_err();
            assert!(
                error
                    .message
                    .starts_with(crate::windows_paths::sandbox::STORE)
            );
        }
        for root in [&f.artifacts, &f.attachments, &f.python, &f.work] {
            assert!(
                windows_policy(
                    &f.home,
                    std::slice::from_ref(root),
                    Confine::Workspace,
                    &[],
                    &WorkspaceProtected::default(),
                    &[],
                )
                .is_ok(),
                "{}",
                root.display()
            );
        }
        // A missing target that would pin the workspace refuses, as on Linux.
        git(&[
            "-C",
            &f.work.to_string_lossy(),
            "config",
            "core.hooksPath",
            ".githooks",
        ]);
        let scan = workspace_protected(&roots, WORKSPACE_DIRS).unwrap();
        let error =
            windows_policy(&f.home, &roots, Confine::Workspace, &[], &scan, &[]).unwrap_err();
        assert!(
            error.message.contains("does not exist yet"),
            "{}",
            error.message
        );
        std::fs::create_dir(f.work.join(".githooks")).unwrap();
        let scan = workspace_protected(&roots, WORKSPACE_DIRS).unwrap();
        let policy = windows_policy(&f.home, &roots, Confine::Workspace, &[], &scan, &[]).unwrap();
        assert!(policy.deny_write.contains(&f.work.join(".githooks")));
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
