//! Credential paths shared with the private extension and child-process isolation.
use crate::{Error, Result};
use serde::Deserialize;
use std::{
    path::{Path, PathBuf},
    sync::OnceLock,
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
    name.is_match(path.file_name().and_then(|s| s.to_str()).unwrap_or(""))
        || path
            .strip_prefix(home)
            .is_ok_and(|p| local.is_match(&p.to_string_lossy().replace('\\', "/")))
}
fn secret_paths(home: &Path) -> Result<Vec<PathBuf>> {
    fn walk(home: &Path, dir: &Path, paths: &mut Vec<PathBuf>) -> Result<()> {
        for entry in std::fs::read_dir(dir)? {
            let entry = entry?;
            let path = entry.path();
            if credential_name(home, &path) {
                paths.push(path.clone());
                if let Ok(target) = std::fs::canonicalize(&path) {
                    paths.push(target);
                }
            } else if entry.file_type()?.is_dir()
                && !["node_modules", ".git", "bin", "venv", "native", "artifacts"]
                    .contains(&entry.file_name().to_string_lossy().as_ref())
            {
                walk(home, &path, paths)?;
            }
        }
        Ok(())
    }
    let mut paths = vec![];
    if let Some(user) = std::env::var_os("HOME") {
        let ssh = PathBuf::from(user).join(".ssh");
        if let Ok(target) = std::fs::canonicalize(&ssh) {
            paths.push(target);
        }
        paths.push(ssh);
    }
    walk(home, home, &mut paths)?;
    paths.sort();
    paths.dedup();
    Ok(paths)
}
pub fn warn_unavailable_isolation() {
    if cfg!(target_os = "macos")
        || cfg!(target_os = "linux")
            && std::env::var_os("PATH")
                .is_some_and(|p| std::env::split_paths(&p).any(|dir| dir.join("bwrap").is_file()))
    {
        return;
    }
    static WARN: std::sync::Once = std::sync::Once::new();
    WARN.call_once(|| {
        eprintln!(
            "Hexbot credential isolation is unavailable; command approval guards remain active."
        )
    });
}
pub fn isolated_command(home: &Path, program: &str) -> Result<tokio::process::Command> {
    let paths = secret_paths(home)?;
    if cfg!(target_os = "macos") {
        let mut filters = vec![format!(
            "(regex #{})",
            serde_json::to_string(&format!("/{}", &policy().basename[1..])).unwrap()
        )];
        for root in [home.to_owned(), std::fs::canonicalize(home)?] {
            filters.push(format!(
                "(regex #{})",
                serde_json::to_string(&format!(
                    "^{}/{}",
                    regex::escape(&root.to_string_lossy()),
                    &policy().home[1..]
                ))
                .unwrap()
            ));
        }
        for path in paths {
            filters.push(format!(
                "(subpath {})",
                serde_json::to_string(&path.to_string_lossy()).unwrap()
            ));
        }
        let mut command = tokio::process::Command::new("/usr/bin/sandbox-exec");
        command.args([
            "-p",
            &format!(
                "(version 1)(allow default)(deny file-read* file-write* {})",
                filters.join(" ")
            ),
            program,
        ]);
        return Ok(command);
    }
    if cfg!(target_os = "linux")
        && let Some(bwrap) = std::env::var_os("PATH").and_then(|p| {
            std::env::split_paths(&p)
                .map(|d| d.join("bwrap"))
                .find(|p| p.is_file())
        })
    {
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
        for path in paths.into_iter().filter(|p| p.exists()) {
            if path.is_dir() {
                command.arg("--tmpfs").arg(path);
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
        let result = isolated_command(home.path(), "/bin/cat")
            .unwrap()
            .arg(home.path().join(".env"))
            .output()
            .await
            .unwrap();
        assert!(!result.status.success());
        let result = isolated_command(home.path(), "python3")
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
        let result = isolated_command(home.path(), "/bin/echo")
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
