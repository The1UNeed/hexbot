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
            "Hexbot has no OS sandbox on this system (bubblewrap is missing or cannot start). Shell commands and scripts can read any file you can. Manual and Auto ask before every shell command and code run, and scheduled scripts run only in Bypass. Install bubblewrap and restart the daemon to restore isolation."
        )
    });
}
/// Unattended scripts assume the sandbox; without one only Off runs them.
pub fn require_isolation(mode: &str) -> Result<()> {
    if mode == "off" || isolation_available() {
        return Ok(());
    }
    Err(Error::new(
        4302,
        "No OS sandbox is available, so scheduled scripts do not run in Manual or Auto approval mode. Install bubblewrap and restart the daemon, or set approval mode to Bypass.",
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
fn real_root(path: &Path) -> std::io::Result<PathBuf> {
    match std::fs::canonicalize(path) {
        Ok(path) => Ok(path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            match (path.parent(), path.file_name()) {
                (Some(parent), Some(name)) => Ok(real_root(parent)?.join(name)),
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
/// starts, a few levels deep. Matches isolation.ts.
const WORKSPACE_DEPTH: usize = 3;
const WORKSPACE_DIRS: usize = 1000;
fn git_dir_regex() -> String {
    format!("/{}(/|$)", regex_escape(".git"))
}
const SCAN_REASON: &str = "The workspace safety scan exceeded its directory budget. This command needs approval: retry with full_access and a reason.";
const SCAN_FILE_REASON: &str = "The workspace safety scan reached its directory budget, so Git protection is partial. Approve this file change only if you trust its destination.";
#[derive(Default)]
struct WorkspaceProtected {
    git: Vec<PathBuf>,
    secrets: Vec<PathBuf>,
    exhausted: bool,
    failure: bool,
}
fn add_path(paths: &mut Vec<PathBuf>, path: &Path) -> Result<()> {
    if !paths.contains(&path.to_owned()) {
        paths.push(path.to_owned());
    }
    let real = real_root(path)?;
    if !paths.contains(&real) {
        paths.push(real);
    }
    Ok(())
}
fn git_hooks(git: &mut Vec<PathBuf>, dir: &Path, worktree: &Path) -> Result<()> {
    for config in [dir.join("config"), dir.join("config.worktree")] {
        if !config.exists() {
            continue;
        }
        // Use system Git, never a workspace executable from PATH. Parse only
        // repository config; ignore ambient Git overrides.
        let output = std::process::Command::new("/usr/bin/git")
            .args(["config", "--null", "--includes", "--file"])
            .arg(&config)
            .args([
                "--show-origin",
                "--path",
                "--get-regexp",
                r"^(core.hookspath|include.path|includeif\..*\.path)$",
            ])
            .env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap_or_default())
            .env("HOME", std::env::var_os("HOME").unwrap_or_default())
            .env("GIT_DIR", dir)
            .env("GIT_WORK_TREE", worktree)
            .output()?;
        if output.status.code() == Some(1) {
            continue;
        }
        if !output.status.success() {
            return Err(Error::new(
                5240,
                "Git hook configuration could not be read.",
            ));
        }
        let text = String::from_utf8_lossy(&output.stdout);
        let fields: Vec<_> = text.split('\0').collect();
        for pair in fields.chunks_exact(2) {
            let origin = Path::new(pair[0].strip_prefix("file:").unwrap_or(pair[0]));
            add_path(git, origin)?;
            if let Some((key, value)) = pair[1].split_once('\n')
                && !value.is_empty()
            {
                let base = if key == "core.hookspath" {
                    worktree
                } else {
                    origin.parent().unwrap()
                };
                add_path(git, &real_root(&base.join(value))?)?;
            }
        }
    }
    Ok(())
}
fn git_metadata(git: &mut Vec<PathBuf>, path: &Path, worktree: &Path) -> Result<()> {
    add_path(git, path)?;
    let mut dir = path.to_owned();
    if path.is_file() {
        let bytes = std::fs::read(path)?;
        let text = String::from_utf8_lossy(&bytes);
        let Some(pointer) = text.lines().find_map(|line| line.strip_prefix("gitdir:")) else {
            return Ok(()); // Cache markers remain locked, but are not pointers.
        };
        dir = real_root(&path.parent().unwrap().join(pointer.trim()))?;
        add_path(git, &dir)?;
    }
    let common = dir.join("commondir");
    if common.exists() {
        let target = real_root(&dir.join(std::fs::read_to_string(common)?.trim()))?;
        add_path(git, &target)?;
        git_hooks(git, &target, worktree)?;
    }
    git_hooks(git, &dir, worktree)
}
fn bare_repository(path: &Path) -> bool {
    path.file_name()
        .is_some_and(|name| folded(Path::new(name)).to_string_lossy().ends_with(".git"))
        && path.join("HEAD").exists()
        && path.join("objects").exists()
}
fn record_metadata(protected: &mut WorkspaceProtected, path: &Path, worktree: &Path) {
    if git_metadata(&mut protected.git, path, worktree).is_err() {
        protected.failure = true;
    }
}
fn workspace_protected(roots: &[PathBuf], limit: usize) -> Result<WorkspaceProtected> {
    let mut protected = WorkspaceProtected::default();
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
            record_metadata(&mut protected, &dir, &dir);
        }
        for parent in dir.ancestors().filter(|p| p.parent().is_some()) {
            let marker = parent.join(".git");
            if marker.exists() {
                record_metadata(&mut protected, &marker, parent);
            }
        }
        queue.push_back((dir, 0));
    }
    while let Some((dir, depth)) = queue.pop_front() {
        if seen.contains(&dir) {
            continue;
        }
        if seen.len() >= limit {
            protected.exhausted = true;
            break;
        }
        seen.insert(dir.clone());
        let mut list: Vec<_> = match std::fs::read_dir(&dir) {
            Ok(entries) => entries
                .filter_map(|entry| match entry {
                    Ok(entry) => Some(entry),
                    Err(_) => {
                        protected.failure = true;
                        None
                    }
                })
                .collect(),
            Err(_) => {
                protected.failure = true;
                continue;
            }
        };
        list.sort_by_key(|entry| entry.file_name());
        for entry in list {
            let path = entry.path();
            let name = entry.file_name();
            let name = name.to_string_lossy();
            let git_name = folded(Path::new(name.as_ref()));
            if git_name == Path::new(".git") || bare_repository(&path) {
                let worktree = if bare_repository(&path) { &path } else { &dir };
                record_metadata(&mut protected, &path, worktree);
            } else if secret_file_name(&name) && !path.is_dir() {
                if add_path(&mut protected.secrets, &path).is_err() {
                    protected.failure = true;
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
pub(crate) fn git_write_protected(path: &Path, roots: &[PathBuf]) -> Result<bool> {
    if path.ancestors().any(bare_repository) {
        return Ok(true);
    }
    let scan = workspace_protected(roots, WORKSPACE_DIRS)?;
    if scan
        .git
        .iter()
        .any(|root| under(path, root) || under(root, path))
    {
        return Ok(true);
    }
    if scan.failure {
        return Err(Error::new(
            5240,
            "Git metadata or hook configuration could not be scanned. Approve this file change only if you trust its destination.",
        ));
    }
    if scan.exhausted {
        return Err(Error::new(5240, SCAN_FILE_REASON));
    }
    Ok(false)
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
        let locked = confine.protected.git.iter().map(|p| format!("(subpath {})", quoted(p.to_string_lossy()))).collect::<Vec<_>>().join(" ");
        let mut protected = browser_roots.clone();
        protected.extend(confine.protected.git.clone());
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
                "Git metadata or hook configuration could not be scanned. Use an approved full_access command.",
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
    for path in layout
        .confine
        .iter()
        .flat_map(|c| &c.config)
        .filter(|p| p.exists())
    {
        args.extend(["--ro-bind".into(), path.into(), path.into()]);
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
        for target in &confine.protected.git {
            let mut path = target.as_path();
            while !path.exists() {
                let Some(parent) = path.parent() else { break };
                path = parent;
            }
            args.extend(["--ro-bind".into(), path.into(), path.into()]);
        }
        for path in &confine.protected.secrets {
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
/// Variables every child may inherit. Provider keys, connector secrets, and runtime
/// injection variables (NODE_OPTIONS, BASH_ENV) are never on the list.
pub fn inherited_environment(name: &str) -> bool {
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
        std::fs::create_dir_all(workspace[0].join(".local-hooks")).unwrap();
        std::fs::write(workspace[0].join("app/.env"), "secret").unwrap();
        std::fs::write(workspace[0].join(".env.example"), "example").unwrap();
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
    fn scheduled_scripts_need_a_sandbox_unless_off() {
        assert!(require_isolation("off").is_ok());
        assert_eq!(require_isolation("manual").is_ok(), isolation_available());
        assert_eq!(require_isolation("smart").is_ok(), isolation_available());
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
