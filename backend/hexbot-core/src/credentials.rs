//! Credential paths shared with the private extension and child-process isolation.
use crate::{Error, Result};
use serde::Deserialize;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};
#[derive(Deserialize)]
struct Policy {
    basename: String,
    home: String,
}
fn policy() -> &'static Policy {
    static POLICY: OnceLock<Policy> = OnceLock::new();
    POLICY.get_or_init(|| {
        serde_json::from_str(include_str!("../../pi-runtime/credential-policy.json"))
            .expect("credential policy")
    })
}
pub fn credential_name(home: &Path, path: &Path) -> bool {
    static PATTERNS: OnceLock<(regex::Regex, regex::Regex)> = OnceLock::new();
    let (name, local) = PATTERNS.get_or_init(|| {
        (
            regex::Regex::new(&policy().basename).unwrap(),
            regex::Regex::new(&policy().home).unwrap(),
        )
    });
    path.strip_prefix(home).is_ok_and(|p| {
        name.is_match(path.file_name().and_then(|s| s.to_str()).unwrap_or(""))
            || local.is_match(&p.to_string_lossy().replace('\\', "/"))
    })
}
fn entries(dir: &Path) -> impl Iterator<Item = std::fs::DirEntry> {
    std::fs::read_dir(dir).into_iter().flatten().flatten()
}
pub(crate) fn private_key(name: &str) -> bool {
    (name.starts_with("id_") || name.ends_with(".pem") || name.ends_with(".key"))
        && !name.ends_with(".pub")
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
            if credential_name(home, &path) {
                add(path, paths);
            } else if entry.file_type().is_ok_and(|t| t.is_dir())
                && ![
                    "node_modules",
                    ".git",
                    "bin",
                    "venv",
                    "native",
                    "artifacts",
                    "python",
                    "cache",
                ]
                .contains(&entry.file_name().to_string_lossy().as_ref())
                && path != home.join("runtime/sessions")
            {
                walk(home, &path, paths);
            }
        }
    }
    let mut paths = vec![];
    fn walk_ssh(dir: &Path, paths: &mut Vec<PathBuf>) {
        for entry in entries(dir) {
            if private_key(&entry.file_name().to_string_lossy()) {
                add(entry.path(), paths);
            } else if entry.file_type().is_ok_and(|t| t.is_dir()) {
                walk_ssh(&entry.path(), paths);
            }
        }
    }
    if let Some(user) = std::env::var_os("HOME") {
        walk_ssh(&PathBuf::from(user).join(".ssh"), &mut paths);
    }
    walk(home, home, &mut paths);
    paths.sort();
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
            let status = std::process::Command::new(&path)
                .args([
                    "--die-with-parent",
                    "--unshare-pid",
                    "--ro-bind",
                    "/",
                    "/",
                    "--proc",
                    "/proc",
                    "--",
                    "/bin/true",
                ])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status();
            status.is_ok_and(|s| s.success()).then_some(path)
        })
        .as_deref()
}
pub fn warn_unavailable_isolation() {
    if cfg!(target_os = "macos") || bwrap().is_some() {
        return;
    }
    static WARN: std::sync::Once = std::sync::Once::new();
    WARN.call_once(|| {
        eprintln!(
            "Hexbot credential isolation is unavailable; command approval guards remain active."
        )
    });
}
fn quoted(path: impl AsRef<str>) -> String {
    serde_json::to_string(path.as_ref()).unwrap()
}
fn sandbox_profile(roots: &[PathBuf], paths: &[PathBuf], writable: &[PathBuf]) -> String {
    let mut filters = vec![];
    for root in roots {
        let root = regex::escape(&root.to_string_lossy());
        for pattern in [
            format!("^{root}/(.*/)?{}", &policy().basename[1..]),
            format!("^{root}/{}", &policy().home[1..]),
        ] {
            filters.push(format!("(regex {})", quoted(pattern)));
        }
    }
    if let Some(user) = std::env::var_os("HOME") {
        let ssh = PathBuf::from(user).join(".ssh");
        for root in [ssh.clone(), std::fs::canonicalize(&ssh).unwrap_or(ssh)] {
            filters.push(format!(
                "(require-all (regex {}) (require-not (regex {})))",
                quoted(format!(
                    r"^{}/(.*/)?(id_[^/]*|[^/]*\.(pem|key))$",
                    regex::escape(&root.to_string_lossy())
                )),
                quoted(r"\.pub$")
            ));
        }
    }
    for path in paths {
        filters.push(format!("(subpath {})", quoted(path.to_string_lossy())));
    }
    let inside_home = roots
        .iter()
        .map(|p| format!("(subpath {})", quoted(p.to_string_lossy())))
        .collect::<Vec<_>>()
        .join(" ");
    let except_writable = if writable.is_empty() {
        String::new()
    } else {
        format!(
            "(require-not (require-any {}))",
            writable
                .iter()
                .map(|p| format!("(subpath {})", quoted(p.to_string_lossy())))
                .collect::<Vec<_>>()
                .join(" ")
        )
    };
    format!(
        "(version 1)(allow default)(deny file-write* (require-all (require-any {inside_home}) {except_writable}))(deny file-read* file-write* {})",
        filters.join(" ")
    )
}
pub fn isolated_command(
    home: &Path,
    program: &str,
    writable: &[PathBuf],
) -> Result<tokio::process::Command> {
    let paths = secret_paths(home);
    let roots = vec![home.to_owned(), std::fs::canonicalize(home)?];
    let writable: Vec<_> = writable
        .iter()
        .filter_map(|p| std::fs::canonicalize(p).ok())
        .filter(|p| roots.iter().any(|root| p != root && p.starts_with(root)))
        .collect();
    if cfg!(target_os = "macos") {
        let mut command = tokio::process::Command::new("/usr/bin/sandbox-exec");
        command.args(["-p", &sandbox_profile(&roots, &paths, &writable), program]);
        return Ok(command);
    }
    if let Some(bwrap) = bwrap() {
        let mut command = tokio::process::Command::new(bwrap);
        command.args([
            "--die-with-parent",
            "--unshare-pid",
            "--bind",
            "/",
            "/",
            "--proc",
            "/proc",
        ]);
        for root in roots {
            command.arg("--ro-bind").arg(&root).arg(&root);
        }
        for path in writable {
            command.arg("--bind").arg(&path).arg(&path);
        }
        for path in paths.into_iter().filter(|p| p.exists()) {
            if path.is_dir() {
                command
                    .arg("--tmpfs")
                    .arg(&path)
                    .arg("--remount-ro")
                    .arg(&path);
            } else {
                command.args(["--ro-bind", "/dev/null"]).arg(path);
            }
        }
        command.arg("--").arg(program);
        return Ok(command);
    }
    warn_unavailable_isolation();
    Ok(tokio::process::Command::new(program))
}
/// Explicit inheritance prevents provider keys and runtime injection variables reaching scripts.
pub fn shell_environment(command: &mut tokio::process::Command) {
    command
        .env_clear()
        .envs(std::env::vars().filter(|(name, _)| {
            matches!(
                name.as_str(),
                "PATH"
                    | "HOME"
                    | "USER"
                    | "LOGNAME"
                    | "SHELL"
                    | "TMPDIR"
                    | "TMP"
                    | "TEMP"
                    | "LANG"
                    | "LANGUAGE"
                    | "TZ"
                    | "SSH_AUTH_SOCK"
                    | "SystemRoot"
                    | "WINDIR"
                    | "PATHEXT"
                    | "COMSPEC"
            ) || name.starts_with("LC_")
        }));
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
        for name in ["id_rsa", "id_ed25519", "work.pem", "work.key"] {
            assert!(private_key(name));
        }
        let profile = sandbox_profile(&[home.path().to_owned()], &paths, &[]);
        assert!(!profile.contains("regex #"));
        assert!(profile.contains("(deny file-write*"));
        assert!(profile.contains(&quoted(format!(
            "^{}/{}",
            regex::escape(&home.path().to_string_lossy()),
            &policy().home[1..]
        ))));
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
    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn python_isolated_from_secrets() {
        let home = tempfile::tempdir().unwrap();
        std::fs::write(home.path().join(".env"), "SECRET").unwrap();
        let result = isolated_command(home.path(), "/bin/cat", &[])
            .unwrap()
            .arg(home.path().join(".env"))
            .output()
            .await
            .unwrap();
        assert!(!result.status.success());
        let result = isolated_command(home.path(), "python3", &[])
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
        let result = isolated_command(home.path(), "/bin/echo", &[])
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
