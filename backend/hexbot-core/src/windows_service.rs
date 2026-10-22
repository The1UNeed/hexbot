//! Per-user Windows task. The task resolves the selected runtime on every start.
use crate::{Error, Result, common, services};
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Stdio,
};
use tokio::process::Command;

#[path = "windows_service_logs.rs"]
mod service_logs;

const MARKER: &str = "# Hexbot owned home: ";
fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}
fn script(home: &Path, service: bool) -> Result<String> {
    let text = home
        .to_str()
        .ok_or_else(|| Error::new(4200, "Invalid home path"))?;
    let marker = serde_json::to_string(text).map_err(|e| Error::new(4200, e.to_string()))?;
    let command = if service {
        r#"$env:HEXBOT_SUPERVISOR = 'service'
do {
    $exe = Select-HexbotRuntime
    $ErrorActionPreference = 'Continue'
    & $exe serve >> (Join-Path $env:HEXBOT_HOME 'logs/service.log') 2>> (Join-Path $env:HEXBOT_HOME 'logs/service-error.log')
    $ErrorActionPreference = 'Stop'
} while ($LASTEXITCODE -eq 0)"#
    } else {
        "$exe = Select-HexbotRuntime\n$ErrorActionPreference = 'Continue'\n& $exe @args"
    };
    Ok(format!(
        "{MARKER}{marker}\n$ErrorActionPreference = 'Stop'\n$env:HEXBOT_HOME = {}\n{}\n{command}\nexit $LASTEXITCODE\n",
        quote(text), include_str!("../assets/windows-runtime-selection.ps1")
    ).replace('\n', "\r\n"))
}
pub fn owned(path: &Path, home: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|m| m.is_file())
        && fs::read_to_string(path)
            .ok()
            .and_then(|s| {
                s.trim_start_matches('\u{feff}')
                    .lines()
                    .next()
                    .and_then(|s| s.strip_prefix(MARKER))
                    .and_then(|s| serde_json::from_str::<PathBuf>(s).ok())
            })
            .is_some_and(|owner| {
                crate::install_ownership::resolved(&owner).ok()
                    == crate::install_ownership::resolved(home).ok()
            })
}
pub fn write_owned_script(path: &Path, home: &Path, service: bool) -> Result<()> {
    if fs::symlink_metadata(path).is_ok() && !owned(path, home) {
        return Err(Error::new(
            4208,
            "Existing Windows script belongs to another installation; left it alone",
        ));
    }
    common::atomic_write(
        path,
        format!("\u{feff}{}", script(home, service)?).as_bytes(),
    )
}
fn root() -> Result<PathBuf> {
    std::env::var_os("HEXBOT_SERVICE_ROOT")
        .map(PathBuf::from)
        .or_else(crate::osutil::user_home)
        .ok_or_else(|| Error::new(4200, "User home is required"))
}
pub fn service_file() -> Result<PathBuf> {
    Ok(root()?.join("AppData/Local/Hexbot/daemon.ps1"))
}
fn xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}
fn task_xml(file: &Path, sid: &str, powershell: &Path) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><Triggers><LogonTrigger><Enabled>true</Enabled><UserId>{sid}</UserId></LogonTrigger></Triggers><Principals><Principal id="Owner"><UserId>{sid}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><StartWhenAvailable>true</StartWhenAvailable><RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure></Settings><Actions Context="Owner"><Exec><Command>{}</Command><Arguments>-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File &quot;{}&quot;</Arguments></Exec></Actions></Task>"#,
        xml(&powershell.to_string_lossy()),
        xml(&file.to_string_lossy())
    )
}
async fn powershell(script: &str) -> Result<String> {
    #[cfg(windows)]
    let executable = crate::windows_paths::system_program("WindowsPowerShell/v1.0/powershell.exe")?;
    #[cfg(not(windows))]
    let executable = PathBuf::from("powershell.exe");
    let mut command = Command::new(executable);
    command.args(["-NoProfile", "-NonInteractive", "-Command", script]);
    output(command).await
}
async fn output(mut command: Command) -> Result<String> {
    #[cfg(windows)]
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    let output = command
        .stdin(Stdio::null())
        .kill_on_drop(true)
        .output()
        .await?;
    if !output.status.success() {
        return Err(Error::new(
            5244,
            String::from_utf8_lossy(&output.stderr).trim(),
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().into())
}
async fn task_name() -> Result<(String, String)> {
    let sid = powershell("[Security.Principal.WindowsIdentity]::GetCurrent().User.Value").await?;
    if !sid.starts_with("S-1-")
        || !sid
            .bytes()
            .all(|b| b.is_ascii_digit() || b == b'S' || b == b'-')
    {
        return Err(Error::new(5244, "Invalid Windows user SID"));
    }
    Ok((format!("Hexbot-daemon-{sid}"), sid))
}
async fn schtasks(args: &[&str]) -> Result<String> {
    #[cfg(windows)]
    let executable = crate::windows_paths::system_program("schtasks.exe")?;
    #[cfg(not(windows))]
    let executable = PathBuf::from("schtasks.exe");
    let mut command = Command::new(executable);
    command.args(args);
    output(command).await
}
pub async fn status(home: &Path) -> Result<Value> {
    let file = service_file()?;
    let installed = owned(&file, home);
    let running = if installed && std::env::var("HEXBOT_SERVICE_NO_LOAD").as_deref() != Ok("1") {
        let (name, _) = task_name().await?;
        powershell(&format!(
            "[int](Get-ScheduledTask -TaskName {} -ErrorAction Stop).State",
            quote(&name)
        ))
        .await
        .is_ok_and(|s| s == "4")
    } else {
        false
    };
    Ok(json!({"installed":installed,"running":running,"file":file}))
}
// /End acknowledges cancellation before the task job and daemon lock are gone.
// A restart may launch only after both are stopped, or it races the home lock.
async fn wait_stopped(home: &Path, name: &str) -> Result<()> {
    let mut interval = tokio::time::interval(std::time::Duration::from_millis(200));
    let wait = async {
        loop {
            let state = powershell(&format!("$task = Get-ScheduledTask -TaskName {} -ErrorAction SilentlyContinue; if ($task) {{ [int]$task.State }} else {{ 0 }}", quote(name))).await?;
            let available = match fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(home.join("native-daemon.lock"))
            {
                Ok(file) => file.try_lock().is_ok(),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => true,
                Err(error) => return Err(error.into()),
            };
            if state != "4" && available {
                return Ok(());
            }
            interval.tick().await;
        }
    };
    tokio::time::timeout(std::time::Duration::from_secs(30), wait)
        .await
        .map_err(|_| {
            Error::new(
                5244,
                "Windows task did not stop and release the daemon lock",
            )
        })?
}
pub async fn run(home: &Path, args: &[String]) -> Result<()> {
    let action = args.first().map(String::as_str).unwrap_or("status");
    if !matches!(
        action,
        "install" | "uninstall" | "start" | "stop" | "restart" | "status" | "logs"
    ) {
        return Err(Error::new(4200, "Unknown service action"));
    }
    match args
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .as_slice()
    {
        [] | ["status"] | ["status", "--json"] => {
            println!("{}", status(home).await?);
            return Ok(());
        }
        ["logs"] => return service_logs::logs(home, false).await,
        ["logs", "-f"] => return service_logs::logs(home, true).await,
        ["install" | "uninstall" | "start" | "stop" | "restart"] => {}
        _ => {
            return Err(Error::new(
                4200,
                "service expects install, uninstall, start, stop, restart, status [--json] or logs [-f]",
            ));
        }
    }
    let file = service_file()?;
    if fs::symlink_metadata(&file).is_ok() && !owned(&file, home) {
        return Err(Error::new(
            4208,
            "Windows service belongs to another installation",
        ));
    }
    let no_load = std::env::var("HEXBOT_SERVICE_NO_LOAD").as_deref() == Ok("1");
    if action == "install" {
        services::selected_native_executable(home)?;
        fs::create_dir_all(home.join("logs"))?;
        write_owned_script(&file, home, true)?;
        if !no_load {
            let (name, sid) = task_name().await?;
            #[cfg(windows)]
            let powershell =
                crate::windows_paths::system_program("WindowsPowerShell/v1.0/powershell.exe")?;
            #[cfg(not(windows))]
            let powershell = PathBuf::from("powershell.exe");
            let bytes = task_xml(&file, &sid, &powershell)
                .encode_utf16()
                .flat_map(u16::to_le_bytes)
                .collect::<Vec<_>>();
            let mut xml = vec![0xff, 0xfe];
            xml.extend(bytes);
            let path = file.with_extension("xml");
            common::atomic_write(&path, &xml)?;
            schtasks(&[
                "/Create",
                "/TN",
                &name,
                "/XML",
                &path.to_string_lossy(),
                "/F",
            ])
            .await?;
            schtasks(&["/Run", "/TN", &name]).await?;
        }
    } else if owned(&file, home) {
        if !no_load {
            let (name, _) = task_name().await?;
            if matches!(action, "stop" | "restart" | "uninstall") {
                let _ = schtasks(&["/End", "/TN", &name]).await;
                wait_stopped(home, &name).await?;
            }
            if action == "uninstall" {
                schtasks(&["/Delete", "/TN", &name, "/F"]).await?;
            }
            if matches!(action, "start" | "restart") {
                schtasks(&["/Run", "/TN", &name]).await?;
            }
        }
        if action == "uninstall" {
            fs::remove_file(&file)?;
            let _ = fs::remove_file(file.with_extension("xml"));
        }
    } else {
        return Err(Error::new(5244, "Windows service is not installed"));
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn task_principal_and_context_match_and_commands_do_not_embed_the_user_name() {
        let task = task_xml(
            Path::new("C:/User & name/daemon.ps1"),
            "S-1-5-21-123",
            Path::new("C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"),
        );
        assert!(task.contains("Principal id=\"Owner\""));
        assert!(task.contains("Actions Context=\"Owner\""));
        assert_eq!(task.matches("<UserId>S-1-5-21-123</UserId>").count(), 2);
        assert!(task.contains("User &amp; name"));
        assert!(task.contains("LeastPrivilege"));
    }
    #[test]
    fn script_ownership_and_selection_are_explicit() {
        let home = tempfile::tempdir().unwrap();
        let file = home.path().join("cli.ps1");
        write_owned_script(&file, home.path(), false).unwrap();
        assert!(owned(&file, home.path()));
        let other = tempfile::tempdir().unwrap();
        assert!(!owned(&file, other.path()));
        assert!(write_owned_script(&file, other.path(), false).is_err());
        let script = fs::read_to_string(file).unwrap();
        assert!(script.contains("native-current.json"));
        assert!(script.contains("& $exe @args"));
    }
}
