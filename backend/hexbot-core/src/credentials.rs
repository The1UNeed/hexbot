//! Credential paths, host write tiers, the child environment, and child-process
//! isolation. All four come from `../../pi-runtime/credential-policy.json`, which the
//! private extension reads for Pi's bash and file tools; the parity test below keeps
//! the two sandbox builders identical.
use crate::{Error, Result};
use serde::Deserialize;
use std::{
    collections::HashMap,
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
    skip: Vec<String>,
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
fn patterns() -> &'static (regex::Regex, regex::Regex, regex::Regex) {
    static PATTERNS: OnceLock<(regex::Regex, regex::Regex, regex::Regex)> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        let compile = |source: &str| {
            regex::Regex::new(&format!("{}{source}", if FOLD_CASE { "(?i)" } else { "" })).unwrap()
        };
        (
            compile(&policy().basename),
            compile(&policy().home),
            compile(&policy().ssh_public),
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
    let (name, local, _) = patterns();
    let (path_folded, home_folded) = (folded(path), folded(home));
    path_folded.strip_prefix(&home_folded).is_ok_and(|p| {
        name.is_match(path.file_name().and_then(|s| s.to_str()).unwrap_or(""))
            || local.is_match(&p.to_string_lossy().replace('\\', "/"))
    })
}
pub fn credential_name(home: &Path, path: &Path) -> bool {
    if std::env::var_os("HOME").is_some_and(|user| {
        user_credential_name(Path::new(&user), path) || ssh_credential_name(Path::new(&user), path)
    }) {
        return true;
    }
    home_credential_name(home, path)
}
fn user_credential_name(user: &Path, path: &Path) -> bool {
    policy().user.iter().any(|local| {
        let secret = user.join(local);
        under(path, &secret) || std::fs::canonicalize(secret).is_ok_and(|p| under(path, &p))
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
    confine: Option<Confine>,
}
/// Codex's workspace sandbox for a section's code in Manual and Auto: no
/// network and no host Unix sockets, writes only inside the workspace (none in
/// Manual), and shell profiles and login items read-only even inside it.
/// Matches isolation.ts.
struct Confine {
    writable: Vec<PathBuf>,
    config: Vec<PathBuf>,
}
fn confine(workspace: &[PathBuf]) -> Result<Confine> {
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
    Ok(Confine { writable, config })
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
fn layout(home: &Path, writable: &[PathBuf], workspace: Option<&[PathBuf]>) -> Result<Layout> {
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
        confine: workspace.map(confine).transpose()?,
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
        let inside = std::iter::once(Path::new("/dev"))
            .chain(confine.writable.iter().map(PathBuf::as_path))
            .map(|p| format!("(subpath {})", quoted(p.to_string_lossy())))
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
        format!(
            "(deny network-outbound (remote ip))(deny network-outbound (remote unix-socket))(deny file-write* (require-not (require-any {inside})))(deny file-write* {config})"
        )
    });
    format!(
        "(version 1)(allow default)(deny process-exec (literal \"/usr/bin/open\") (literal \"/bin/launchctl\") (literal \"/usr/bin/osascript\"))(deny file-write* (require-all (require-any {inside_home}) {except_writable}))(deny file-write* {stores}){ancestors}{confine}(deny file-read* file-write* {})",
        filters.join(" ")
    )
}
fn bwrap_arguments(layout: &Layout) -> Vec<OsString> {
    let base: &[&str] = if layout.confine.is_some() {
        &[
            "--die-with-parent",
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
    for path in layout.confine.iter().flat_map(|c| &c.writable) {
        args.extend(["--bind".into(), path.into(), path.into()]);
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
    for path in layout
        .denied
        .iter()
        .chain(layout.confine.iter().flat_map(|c| &c.config))
        .filter(|p| p.exists())
    {
        args.extend(["--ro-bind".into(), path.into(), path.into()]);
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
    args
}
/// A sandboxed command. `confine` adds the workspace sandbox, with `writable`
/// and the temporary folders as the workspace.
pub fn isolated_command(
    home: &Path,
    program: &str,
    writable: &[PathBuf],
    confine: bool,
) -> Result<tokio::process::Command> {
    let workspace: Vec<PathBuf> = writable
        .iter()
        .cloned()
        .chain([std::env::temp_dir(), PathBuf::from("/tmp")])
        .collect();
    let layout = layout(home, writable, confine.then_some(workspace.as_slice()))?;
    if cfg!(target_os = "macos") {
        let mut command = tokio::process::Command::new("/usr/bin/sandbox-exec");
        command.args(["-p", &sandbox_profile(&layout), program]);
        return Ok(command);
    }
    if let Some(bwrap) = bwrap() {
        let mut command = tokio::process::Command::new(bwrap);
        command
            .args(bwrap_arguments(&layout))
            .arg("--")
            .arg(program);
        return Ok(command);
    }
    warn_unavailable_isolation();
    Ok(tokio::process::Command::new(program))
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
        let paths = secret_paths(home.path());
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
        std::fs::create_dir_all(&workspace[0]).unwrap();
        let confined = super::layout(
            &home,
            &[attachments.clone(), outputs.clone()],
            Some(&workspace),
        )
        .unwrap();
        let script = "const {sandboxProfile, bwrapArguments} = await import(process.argv[1]); const [home, work, ...outputs] = process.argv.slice(2); const workspace = [work, outputs[1]]; console.log(JSON.stringify({profile: sandboxProfile(home, outputs), bwrap: bwrapArguments(home, outputs), confined: sandboxProfile(home, outputs, workspace), confinedBwrap: bwrapArguments(home, outputs, workspace)}));";
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
        assert_eq!(bwrap, bwrap_arguments(&layout));
        assert_eq!(
            extension["confined"].as_str().unwrap(),
            sandbox_profile(&confined)
        );
        assert!(sandbox_profile(&confined).contains("(deny network-outbound (remote ip))"));
        let confined_bwrap: Vec<OsString> = extension["confinedBwrap"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().into())
            .collect();
        assert_eq!(confined_bwrap, bwrap_arguments(&confined));
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
            r#"echo ready; read -r go; secret='{}/profiles/owl'; cat "$secret/.env" >/dev/null 2>&1 && exit 10; cat "$secret/connect.json" >/dev/null 2>&1 && exit 13; cat '{}/connect.json' || exit 11; for p in config.yaml bin/script hooks/script skills/script profiles/owl/config.yaml; do (echo bad > '{}'/$p) 2>/dev/null && exit 12; done; echo ok > '{}/result'; echo ok > '{}/profiles/owl/artifacts/result'; echo ok > '{}/runtime/sessions/one/attachments/result'; echo ok > '{}/normal-workspace'"#,
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
            false,
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
            let args = bwrap_arguments(&layout(home.path(), &[], None).unwrap());
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
        let result = isolated_command(home.path(), "/bin/bash", &[], false)
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
    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn python_isolated_from_secrets() {
        let home = tempfile::tempdir().unwrap();
        std::fs::write(home.path().join(".env"), "SECRET").unwrap();
        let result = isolated_command(home.path(), "/bin/cat", &[], false)
            .unwrap()
            .arg(home.path().join(".env"))
            .output()
            .await
            .unwrap();
        assert!(!result.status.success());
        let result = isolated_command(home.path(), "python3", &[], false)
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
        let result = isolated_command(home.path(), "/bin/echo", &[], false)
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
