//! Per-user launchd and systemd service management.
use crate::{Error, Result, common};
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::process::Command;

struct Options {
    executable: String,
    home: String,
    path: String,
    log_dir: String,
}
fn xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}
fn launchd_plist(options: &Options) -> String {
    let executable = xml(&options.executable);
    let home = xml(&options.home);
    let path = xml(&options.path);
    let log_dir = xml(&options.log_dir);
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>app.hexbot.daemon</string>
  <key>ProgramArguments</key><array><string>{executable}</string><string>serve</string></array>
  <key>EnvironmentVariables</key><dict><key>HEXBOT_HOME</key><string>{home}</string><key>HEXBOT_SUPERVISOR</key><string>service</string><key>PATH</key><string>{path}</string></dict>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>{log_dir}/service.log</string>
  <key>StandardErrorPath</key><string>{log_dir}/service-error.log</string>
</dict></plist>
"#
    )
}
fn systemd_unit(options: &Options) -> String {
    let quote = |s: &str| {
        format!(
            "\"{}\"",
            s.replace('%', "%%")
                .replace('\\', "\\\\")
                .replace('"', "\\\"")
        )
    };
    let executable = quote(&options.executable);
    let home = quote(&options.home);
    let path = quote(&options.path);
    let log_dir = options.log_dir.replace('%', "%%");
    format!(
        "[Unit]\nDescription=Hexbot daemon\nAfter=network.target\n\n[Service]\nType=simple\nExecStart={executable} serve\nEnvironment=HEXBOT_HOME={home}\nEnvironment=HEXBOT_SUPERVISOR=service\nEnvironment=PATH={path}\nRestart=always\nStandardOutput=append:{log_dir}/service.log\nStandardError=append:{log_dir}/service-error.log\n\n[Install]\nWantedBy=default.target\n"
    )
}

// The gui domain needs someone signed in at the screen. Over SSH only the
// user domain exists, and the daemon still runs there.
fn launchd_domains() -> [String; 2] {
    let uid = unsafe { libc::getuid() };
    [format!("gui/{uid}"), format!("user/{uid}")]
}

fn linger_args(user: &str) -> Vec<&str> {
    if user.is_empty() {
        vec!["enable-linger"]
    } else {
        vec!["enable-linger", user]
    }
}

async fn start_launchd<F, Fut>(file: &str, mut run: F) -> Result<()>
where
    F: FnMut(Vec<String>) -> Fut,
    Fut: std::future::Future<Output = Result<String>>,
{
    let domains = launchd_domains();
    // Check both domains before choosing one, including an SSH-installed service.
    for domain in &domains {
        let service = format!("{domain}/app.hexbot.daemon");
        if let Ok(output) = run(vec!["print".into(), service.clone()]).await {
            // A loaded job can be waiting or exited; kickstart runs it now.
            if !output.lines().any(|line| line.trim() == "state = running") {
                run(vec!["kickstart".into(), service]).await?;
            }
            return Ok(());
        }
    }
    for domain in domains {
        // Only an unavailable domain permits falling back to the next one.
        if run(vec!["print".into(), domain.clone()]).await.is_err() {
            continue;
        }
        if let Err(error) = run(vec!["bootstrap".into(), domain.clone(), file.into()]).await {
            // Another start may have bootstrapped it after our first check.
            run(vec!["print".into(), format!("{domain}/app.hexbot.daemon")])
                .await
                .map_err(|_| error)?;
        }
        return Ok(());
    }
    Err(Error::new(5243, "No launchd user domain is available"))
}

struct Service {
    file: PathBuf,
    home: PathBuf,
    no_load: bool,
}
impl Service {
    fn from_env(home: &Path) -> Result<Self> {
        let root = std::env::var_os("HEXBOT_SERVICE_ROOT")
            .or_else(|| std::env::var_os("HOME"))
            .ok_or_else(|| Error::new(4200, "HOME is required"))?;
        Ok(Self::new(
            home,
            Path::new(&root),
            std::env::var("HEXBOT_SERVICE_NO_LOAD").as_deref() == Ok("1"),
        ))
    }
    fn new(home: &Path, root: &Path, no_load: bool) -> Self {
        Self {
            home: home.to_owned(),
            no_load,
            file: root.join(if cfg!(target_os = "macos") {
                "Library/LaunchAgents/app.hexbot.daemon.plist"
            } else {
                ".config/systemd/user/hexbot.service"
            }),
        }
    }
    async fn command(&self, program: &str, args: &[&str]) -> Result<String> {
        if self.no_load {
            return Ok(String::new());
        }
        let output = tokio::time::timeout(
            Duration::from_secs(15),
            Command::new(program)
                .args(args)
                .stdin(Stdio::null())
                .kill_on_drop(true)
                .output(),
        )
        .await
        .map_err(|_| Error::new(5243, format!("{program} timed out")))??;
        if !output.status.success() {
            return Err(Error::new(
                5243,
                format!(
                    "{program} failed: {}",
                    String::from_utf8_lossy(&output.stderr).trim()
                ),
            ));
        }
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    }
    fn check_owner(&self) -> Result<()> {
        crate::install_ownership::check_service(&self.file, &self.home, cfg!(target_os = "macos"))?;
        Ok(())
    }
    async fn start(&self) -> Result<()> {
        self.check_owner()?;
        if !self.file.is_file() {
            return Err(Error::new(
                4200,
                "Service is not installed; run hexbot service install",
            ));
        }
        if cfg!(target_os = "macos") {
            let file = self.file.to_string_lossy();
            if !self.no_load {
                start_launchd(&file, |args| async move {
                    let args: Vec<&str> = args.iter().map(String::as_str).collect();
                    self.command("launchctl", &args).await
                })
                .await?;
            }
        } else {
            self.command("systemctl", &["--user", "start", "hexbot"])
                .await?;
        }
        Ok(())
    }
    async fn stop(&self) -> Result<()> {
        self.check_owner()?;
        if cfg!(target_os = "macos") {
            let file = self.file.to_string_lossy();
            for domain in launchd_domains() {
                if self
                    .command("launchctl", &["bootout", &domain, &file])
                    .await
                    .is_ok()
                {
                    return Ok(());
                }
            }
            self.command("launchctl", &["unload", "-w", &file]).await?;
        } else {
            self.command("systemctl", &["--user", "stop", "hexbot"])
                .await?;
        }
        Ok(())
    }
    async fn install(&self) -> Result<()> {
        self.check_owner()?;
        let options = Options {
            executable: self
                .home
                .join("runtime/native-executable")
                .to_string_lossy()
                .into_owned(),
            home: self.home.to_string_lossy().into_owned(),
            path: format!(
                "{}:{}",
                self.home.join("bin").display(),
                std::env::var("PATH").unwrap_or_default()
            ),
            log_dir: self.home.join("logs").to_string_lossy().into_owned(),
        };
        fs::create_dir_all(self.file.parent().unwrap())?;
        fs::create_dir_all(&options.log_dir)?;
        // Unload an existing definition before replacing its environment.
        if self.file.exists() {
            let _ = self.stop().await;
        }
        common::atomic_write(
            &self.file,
            if cfg!(target_os = "macos") {
                launchd_plist(&options)
            } else {
                systemd_unit(&options)
            }
            .as_bytes(),
        )?;
        if cfg!(target_os = "macos") {
            self.start().await?;
        } else {
            self.command("systemctl", &["--user", "daemon-reload"])
                .await?;
            self.command("systemctl", &["--user", "enable", "--now", "hexbot"])
                .await?;
            let user = std::env::var("USER").unwrap_or_default();
            if let Err(error) = self.command("loginctl", &linger_args(&user)).await {
                eprintln!("Could not enable the daemon after logout: {error}");
            }
        }
        Ok(())
    }
    async fn uninstall(&self) -> Result<()> {
        self.check_owner()?;
        if !self.file.exists() {
            return Ok(());
        }
        if cfg!(target_os = "macos") {
            let _ = self.stop().await;
        } else {
            let _ = self
                .command("systemctl", &["--user", "disable", "--now", "hexbot"])
                .await;
        }
        match fs::remove_file(&self.file) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
        if cfg!(target_os = "linux") {
            self.command("systemctl", &["--user", "daemon-reload"])
                .await?;
        }
        Ok(())
    }
    async fn status(&self) -> Value {
        let installed = self.file.is_file() && self.check_owner().is_ok();
        let running = if self.no_load || !installed {
            false
        } else if cfg!(target_os = "macos") {
            let mut running = false;
            for domain in launchd_domains() {
                running |= self
                    .command(
                        "launchctl",
                        &["print", &format!("{domain}/app.hexbot.daemon")],
                    )
                    .await
                    .is_ok_and(|output| {
                        output.lines().any(|line| line.trim() == "state = running")
                    });
            }
            running
        } else {
            self.command("systemctl", &["--user", "is-active", "hexbot"])
                .await
                .is_ok()
        };
        json!({"installed":installed,"running":running,"manager":if cfg!(target_os = "macos") {"launchd"} else {"systemd"},"file":self.file})
    }
    async fn logs(&self, follow: bool) -> Result<()> {
        let files = [
            self.home.join("logs/service.log"),
            self.home.join("logs/service-error.log"),
        ];
        if !follow {
            for file in files {
                match fs::read_to_string(file) {
                    Ok(text) => print!("{text}"),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => return Err(e.into()),
                }
            }
            return Ok(());
        }
        let mut child = Command::new("tail")
            .args(["-n", "100", "-F"])
            .args(files)
            .stdin(Stdio::null())
            .kill_on_drop(true)
            .spawn()?;
        tokio::select! {
            result = child.wait() => {
                if !result?.success() { return Err(Error::new(5243, "Could not follow service logs")); }
            }
            _ = tokio::signal::ctrl_c() => { let _ = child.kill().await; let _ = child.wait().await; }
        }
        Ok(())
    }
}
pub async fn status(home: &Path) -> Result<Value> {
    Ok(Service::from_env(home)?.status().await)
}
pub async fn run(home: &Path, args: &[String]) -> Result<()> {
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    let service = Service::from_env(home)?;
    let action = match args.as_slice() {
        ["status"] | ["status", "--json"] => {
            let status = service.status().await;
            if args.len() == 2 {
                println!("{status}");
            } else {
                println!(
                    "Daemon service: {}, {}",
                    if status["installed"] == true {
                        "installed"
                    } else {
                        "not installed"
                    },
                    if status["running"] == true {
                        "running"
                    } else {
                        "stopped"
                    }
                );
            }
            return Ok(());
        }
        ["logs"] => return service.logs(false).await,
        ["logs", "-f"] => return service.logs(true).await,
        [action @ ("install" | "uninstall" | "start" | "stop" | "restart")] => *action,
        _ => {
            return Err(Error::new(
                4200,
                "service expects install, uninstall, start, stop, restart, status [--json] or logs [-f]",
            ));
        }
    };
    match action {
        "install" => service.install().await?,
        "uninstall" => service.uninstall().await?,
        "start" => service.start().await?,
        "stop" => service.stop().await?,
        "restart" => {
            let _ = service.stop().await;
            service.start().await?;
        }
        _ => unreachable!(),
    }
    println!(
        "{}",
        match action {
            "install" => "Daemon service installed",
            "uninstall" => "Daemon service removed",
            "start" => "Daemon service started",
            "stop" => "Daemon service stopped",
            _ => "Daemon service restarted",
        }
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn service_files_match_desktop_fixtures() {
        let options = Options {
            executable: "/home/me/.hexbot/runtime/native-executable".into(),
            home: "/home/me/.hexbot".into(),
            path: "/home/me/.hexbot/bin:/usr/bin".into(),
            log_dir: "/home/me/.hexbot/logs".into(),
        };
        assert_eq!(
            launchd_plist(&options),
            include_str!("../tests/fixtures/daemon.plist")
        );
        assert_eq!(
            systemd_unit(&options),
            include_str!("../tests/fixtures/daemon.service")
        );
    }
    #[test]
    fn systemd_specifiers_match_desktop_fixture() {
        let home = "/home/me%n/.hexbot";
        let options = Options {
            executable: format!("{home}/runtime/native-executable"),
            home: home.into(),
            path: format!("{home}/bin:/usr/bin"),
            log_dir: format!("{home}/logs"),
        };
        assert_eq!(
            systemd_unit(&options),
            include_str!("../tests/fixtures/daemon-percent.service")
        );
    }

    #[test]
    fn linger_defaults_to_current_user() {
        assert_eq!(linger_args(""), ["enable-linger"]);
        assert_eq!(linger_args("sam"), ["enable-linger", "sam"]);
    }

    #[tokio::test]
    async fn launchd_start_checks_both_domains_before_bootstrapping() {
        for loaded in ["gui", "user"] {
            let mut calls = Vec::new();
            start_launchd("fixture.plist", |args| {
                let found = args[0] == "print" && args[1].starts_with(loaded);
                calls.push(args);
                std::future::ready(if found {
                    Ok("\tstate = running\n".into())
                } else {
                    Err(Error::new(5243, "not loaded"))
                })
            })
            .await
            .unwrap();
            assert!(calls.iter().all(|args| args[0] == "print"));
        }
    }

    #[tokio::test]
    async fn launchd_kickstarts_a_loaded_job_that_is_not_running() {
        let mut calls = Vec::new();
        start_launchd("fixture.plist", |args| {
            let output = if args[0] == "print" {
                Ok("\tstate = waiting\n".into())
            } else {
                Ok(String::new())
            };
            calls.push(args);
            std::future::ready(output)
        })
        .await
        .unwrap();
        let service = format!("{}/app.hexbot.daemon", launchd_domains()[0]);
        assert_eq!(
            calls.last().unwrap(),
            &vec!["kickstart".to_string(), service]
        );
        assert!(!calls.iter().any(|args| args[0] == "bootstrap"));
    }

    #[tokio::test]
    async fn launchd_falls_back_only_when_gui_is_unavailable() {
        for gui_available in [false, true] {
            let mut calls = Vec::new();
            let result = start_launchd("fixture.plist", |args| {
                let ok = if args[0] == "bootstrap" {
                    !gui_available
                } else {
                    !args[1].ends_with("app.hexbot.daemon")
                        && (!args[1].starts_with("gui/") || gui_available)
                };
                calls.push(args);
                std::future::ready(if ok {
                    Ok(String::new())
                } else {
                    Err(Error::new(5243, "failed"))
                })
            })
            .await;
            assert_eq!(result.is_ok(), !gui_available);
            let bootstraps: Vec<_> = calls.iter().filter(|args| args[0] == "bootstrap").collect();
            assert_eq!(bootstraps.len(), 1);
            assert!(bootstraps[0][1].starts_with(if gui_available { "gui/" } else { "user/" }));
        }
    }

    #[tokio::test]
    async fn launchd_accepts_a_concurrent_bootstrap_without_falling_back() {
        let mut bootstrapped = false;
        start_launchd("fixture.plist", |args| {
            let ok = args[0] == "print" && (args[1] == launchd_domains()[0] || bootstrapped);
            if args[0] == "bootstrap" {
                assert!(!bootstrapped);
                bootstrapped = true;
            }
            std::future::ready(if ok {
                Ok(String::new())
            } else {
                Err(Error::new(5243, "already loaded"))
            })
        })
        .await
        .unwrap();
        assert!(bootstrapped);
    }

    #[tokio::test]
    async fn another_home_cannot_replace_stop_or_remove_the_service() {
        let home = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        let owner = Service::new(home.path(), root.path(), true);
        owner.install().await.unwrap();
        let before = fs::read(&owner.file).unwrap();
        let foreign = Service::new(other.path(), root.path(), true);
        assert!(
            foreign
                .install()
                .await
                .unwrap_err()
                .to_string()
                .contains("belongs to")
        );
        assert!(foreign.uninstall().await.is_err());
        assert!(foreign.stop().await.is_err());
        assert!(foreign.start().await.is_err());
        assert_eq!(fs::read(&owner.file).unwrap(), before);
        assert_eq!(foreign.status().await["installed"], false);
        owner.uninstall().await.unwrap();
    }

    #[tokio::test]
    async fn service_lifecycle_without_loading() {
        let home = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        let service = Service::new(home.path(), root.path(), true);
        assert_eq!(service.status().await["installed"], false);
        service.install().await.unwrap();
        assert!(service.file.starts_with(root.path()));
        assert_eq!(service.status().await["installed"], true);
        assert_eq!(service.status().await["running"], false);
        service.start().await.unwrap();
        service.stop().await.unwrap();
        service.uninstall().await.unwrap();
        service.uninstall().await.unwrap();
        assert_eq!(service.status().await["installed"], false);
        assert!(service.start().await.is_err());
    }
}
