//! A per-user Task Scheduler job. No password or administrator access is needed.
use crate::{Error, Result, common, install_ownership, platform};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::process::Command;

fn xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn request_daemon_shutdown(home: &Path, pid: u32) -> Result<bool> {
    if !platform::process_alive(pid) {
        return Ok(false);
    }
    match platform::request_shutdown(pid, home) {
        Ok(()) => Ok(true),
        // A reused PID without this home's event belongs to another process.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}

fn definition(home: &Path, sid: &str) -> String {
    let executable = xml(&platform::stable_executable(home).to_string_lossy());
    let arguments = xml(&format!("service-run \"{}\"", home.display()));
    let home = xml(&home.to_string_lossy());
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
<RegistrationInfo><Description>Hexbot daemon for {home}</Description></RegistrationInfo>
<Triggers><LogonTrigger><Enabled>true</Enabled><UserId>{sid}</UserId></LogonTrigger></Triggers>
<Principals><Principal id="Owner"><UserId>{sid}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure></Settings>
<Actions Context="Owner"><Exec><Command>{executable}</Command><Arguments>{arguments}</Arguments><WorkingDirectory>{home}</WorkingDirectory></Exec></Actions>
</Task>
"#
    )
}

struct Service {
    home: PathBuf,
    file: PathBuf,
    no_load: bool,
}
impl Service {
    fn from_env(home: &Path) -> Result<Self> {
        let home = install_ownership::resolved(home)?;
        let root = std::env::var_os("HEXBOT_SERVICE_ROOT")
            .or_else(platform::user_home)
            .ok_or_else(|| Error::new(4200, "A user home directory is required"))?;
        Ok(Self {
            home,
            file: PathBuf::from(root).join(".config/hexbot/daemon.xml"),
            no_load: std::env::var("HEXBOT_SERVICE_NO_LOAD").as_deref() == Ok("1"),
        })
    }
    async fn powershell(&self, source: &str) -> Result<std::process::Output> {
        let script = format!(
            "$ErrorActionPreference='Stop';[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);{source}"
        );
        let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
        let executable = PathBuf::from(
            std::env::var_os("SystemRoot")
                .ok_or_else(|| Error::new(5243, "SystemRoot is not set"))?,
        )
        .join("System32/WindowsPowerShell/v1.0/powershell.exe");
        tokio::time::timeout(
            Duration::from_secs(30),
            Command::new(executable)
                .args([
                    "-NoLogo",
                    "-NoProfile",
                    "-NonInteractive",
                    "-EncodedCommand",
                    &STANDARD.encode(bytes),
                ])
                .stdin(Stdio::null())
                .kill_on_drop(true)
                .output(),
        )
        .await
        .map_err(|_| Error::new(5243, "Task Scheduler request timed out"))?
        .map_err(Into::into)
    }
    async fn scheduler(&self, source: &str) -> Result<String> {
        if self.no_load {
            return Ok(String::new());
        }
        let output = self.powershell(&format!("$scheduler=New-Object -ComObject Schedule.Service;$scheduler.Connect();$folder=$scheduler.GetFolder('\\');{source}")).await?;
        if !output.status.success() {
            return Err(Error::new(
                5243,
                format!(
                    "Task Scheduler request failed: {}",
                    String::from_utf8_lossy(&output.stderr).trim()
                ),
            ));
        }
        Ok(String::from_utf8_lossy(&output.stdout).trim().into())
    }
    fn task_name(&self) -> Result<String> {
        install_ownership::windows_task_name(&self.home).map_err(Into::into)
    }
    async fn existing(&self) -> Result<Option<String>> {
        let task = self.task_name()?;
        if self.no_load {
            return Ok(None);
        }
        let output = self.powershell(&format!("$scheduler=New-Object -ComObject Schedule.Service;$scheduler.Connect();$folder=$scheduler.GetFolder('\\');try{{$task=$folder.GetTask('{task}');$task.Xml}}catch{{$error=$_.Exception;while($error.InnerException){{$error=$error.InnerException}};if($error.HResult -eq -2147024894){{exit 3}};throw}}")).await?;
        if output.status.code() == Some(3) {
            return Ok(None);
        }
        if !output.status.success() {
            return Err(Error::new(
                5243,
                format!(
                    "Cannot read the existing Hexbot task: {}",
                    String::from_utf8_lossy(&output.stderr).trim()
                ),
            ));
        }
        let text = String::from_utf8_lossy(&output.stdout).trim().to_owned();
        install_ownership::check_windows_service_text(&text, &self.home)?;
        Ok(Some(text))
    }
    fn check_file(&self) -> Result<()> {
        install_ownership::check_service(&self.file, &self.home, false).map_err(Into::into)
    }
    async fn install(&self) -> Result<()> {
        let task = self.task_name()?;
        self.check_file()?;
        if !self.no_load {
            platform::selected_native(&self.home)?;
            let dispatcher = platform::stable_executable(&self.home);
            if !fs::symlink_metadata(&dispatcher)
                .is_ok_and(|metadata| metadata.is_file() && !platform::is_link(&metadata))
            {
                return Err(Error::new(
                    5243,
                    "Run hexbot setup --activate before installing the daemon task",
                ));
            }
        }
        let existing = self.existing().await?;
        let sid = if self.no_load {
            "S-1-5-21-0".into()
        } else {
            let output = self
                .powershell("[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value")
                .await?;
            if !output.status.success() {
                return Err(Error::new(5243, "Cannot identify the Windows account"));
            }
            let sid = String::from_utf8_lossy(&output.stdout).trim().to_owned();
            if !sid.starts_with("S-1-")
                || !sid
                    .chars()
                    .all(|ch| ch.is_ascii_digit() || matches!(ch, 'S' | '-'))
            {
                return Err(Error::new(5243, "Invalid Windows account identifier"));
            }
            sid
        };
        fs::create_dir_all(self.home.join("logs"))?;
        let definition = definition(&self.home, &sid);
        // Validate before touching Task Scheduler, including paths containing quotes.
        install_ownership::check_windows_service_text(&definition, &self.home)?;
        if !self.no_load {
            let encoded = STANDARD.encode(definition.as_bytes());
            // TASK_CREATE=2 for a new name, TASK_CREATE_OR_UPDATE=6 only after ownership is verified.
            let flags = if existing.is_some() { 6 } else { 2 };
            self.scheduler(&format!("$xml=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{encoded}'));$null=$folder.RegisterTask('{task}',$xml,{flags},$null,$null,3,$null)")).await?;
        }
        common::atomic_write(&self.file, definition.as_bytes())?;
        self.start().await
    }
    async fn start(&self) -> Result<()> {
        let task = self.task_name()?;
        self.check_file()?;
        if !self.file.is_file() {
            return Err(Error::new(
                4200,
                "Service is not installed; run hexbot service install",
            ));
        }
        if !self.no_load && self.existing().await?.is_none() {
            return Err(Error::new(
                5243,
                "The Hexbot task is missing; run hexbot service install",
            ));
        }
        self.scheduler(&format!("$null=$folder.GetTask('{task}').Run($null)"))
            .await?;
        Ok(())
    }
    async fn stop(&self) -> Result<()> {
        let task = self.task_name()?;
        self.check_file()?;
        let existing = self.existing().await?;
        if self.no_load {
            return Ok(());
        }
        if let Ok(bytes) = fs::read(self.home.join("runtime/native-running.json")) {
            let record: Value = serde_json::from_slice(&bytes)
                .map_err(|error| Error::new(5243, error.to_string()))?;
            if let Some(pid) = record["pid"]
                .as_u64()
                .and_then(|pid| u32::try_from(pid).ok())
            {
                // The event includes this home's canonical hash, so a stale PID cannot stop another home.
                let requested = request_daemon_shutdown(&self.home, pid)?;
                if requested {
                    let mut interval = tokio::time::interval(Duration::from_millis(100));
                    tokio::time::timeout(Duration::from_secs(20), async {
                        while platform::process_alive(pid) {
                            interval.tick().await;
                        }
                    })
                    .await
                    .map_err(|_| Error::new(5243, "The daemon did not finish stopping"))?;
                }
            }
        }
        if existing.is_some() {
            self.scheduler(&format!("$folder.GetTask('{task}').Stop(0)"))
                .await?;
        }
        Ok(())
    }
    async fn uninstall(&self) -> Result<()> {
        let task = self.task_name()?;
        self.check_file()?;
        let existing = self.existing().await?;
        self.stop().await?;
        if existing.is_some() {
            self.scheduler(&format!("$folder.DeleteTask('{task}',0)"))
                .await?;
        }
        match fs::remove_file(&self.file) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        Ok(())
    }
    async fn status(&self) -> Value {
        let task = match self.task_name() {
            Ok(task) => task,
            Err(_) => {
                return json!({"installed":false,"running":false,"manager":"task-scheduler","file":self.file});
            }
        };
        let installed = self.file.is_file()
            && self.check_file().is_ok()
            && (self.no_load || self.existing().await.is_ok_and(|task| task.is_some()));
        let running = installed
            && !self.no_load
            && self
                .scheduler(&format!("$folder.GetTask('{task}').State"))
                .await
                .is_ok_and(|state| state == "4");
        json!({"installed":installed,"running":running,"manager":"task-scheduler","file":self.file})
    }
    async fn logs(&self, follow: bool) -> Result<()> {
        use std::io::{Read, Seek, SeekFrom};
        let files = [
            self.home.join("logs/service.log"),
            self.home.join("logs/service-error.log"),
        ];
        let mut offsets = [0u64; 2];
        loop {
            for (index, path) in files.iter().enumerate() {
                match fs::File::open(path) {
                    Ok(mut file) => {
                        if file.metadata()?.len() < offsets[index] {
                            offsets[index] = 0;
                        }
                        file.seek(SeekFrom::Start(offsets[index]))?;
                        let mut bytes = Vec::new();
                        file.read_to_end(&mut bytes)?;
                        offsets[index] += bytes.len() as u64;
                        print!("{}", String::from_utf8_lossy(&bytes));
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => return Err(error.into()),
                }
            }
            if !follow {
                return Ok(());
            }
            tokio::select! { _=tokio::signal::ctrl_c()=>return Ok(()), _=tokio::time::sleep(Duration::from_millis(250))=>{} }
        }
    }
}

pub async fn status(home: &Path) -> Result<Value> {
    Ok(Service::from_env(home)?.status().await)
}
pub async fn run(home: &Path, args: &[String]) -> Result<()> {
    let service = Service::from_env(home)?;
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    match args.as_slice() {
        ["install"] => service.install().await?,
        ["uninstall"] => service.uninstall().await?,
        ["start"] => service.start().await?,
        ["stop"] => service.stop().await?,
        ["restart"] => {
            service.stop().await?;
            service.start().await?;
        }
        ["status"] | ["status", "--json"] => {
            let status = service.status().await;
            println!("{status}");
            return Ok(());
        }
        ["logs"] => return service.logs(false).await,
        ["logs", "-f"] => return service.logs(true).await,
        _ => {
            return Err(Error::new(
                4200,
                "service expects install, uninstall, start, stop, restart, status [--json] or logs [-f]",
            ));
        }
    }
    println!("Daemon service {}", args[0]);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_stale_record_for_an_unrelated_live_pid_does_not_block_service_removal() {
        let home = tempfile::tempdir().unwrap();
        assert!(!request_daemon_shutdown(home.path(), std::process::id()).unwrap());
        assert!(platform::process_alive(std::process::id()));
    }
    #[test]
    fn service_homes_drop_trailing_separators_before_windows_argument_quoting() {
        let home = tempfile::tempdir().unwrap();
        let trailing = PathBuf::from(format!("{}\\", home.path().display()));
        let service = Service::from_env(&trailing).unwrap();
        assert_eq!(service.home, home.path().canonicalize().unwrap());
        assert!(!service.home.to_string_lossy().ends_with('\\'));
        install_ownership::check_windows_service_text(
            &definition(&service.home, "S-1-5-21-0"),
            home.path(),
        )
        .unwrap();
    }
    #[test]
    fn generated_task_retains_ownership_with_spaces_and_xml_characters() {
        let home = tempfile::tempdir().unwrap();
        let path = home.path().join("space & quote'");
        fs::create_dir(&path).unwrap();
        let text = definition(&path, "S-1-5-21-0");
        install_ownership::check_windows_service_text(&text, &path).unwrap();
        assert!(install_ownership::check_windows_service_text(&text, home.path()).is_err());
    }
    #[tokio::test]
    async fn task_file_lifecycle_preserves_other_homes() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home 你好 & space");
        fs::create_dir(&home).unwrap();
        let file = root.path().join("service/daemon.xml");
        let service = Service {
            home: home.clone(),
            file: file.clone(),
            no_load: true,
        };
        service.install().await.unwrap();
        assert_eq!(service.status().await["installed"], true);
        assert_eq!(service.status().await["running"], false);
        service.start().await.unwrap();
        service.stop().await.unwrap();
        let foreign = Service {
            home: root.path().to_owned(),
            file: file.clone(),
            no_load: true,
        };
        assert!(foreign.install().await.is_err());
        assert!(foreign.stop().await.is_err());
        assert!(foreign.uninstall().await.is_err());
        assert!(file.is_file());
        service.uninstall().await.unwrap();
        assert_eq!(service.status().await["installed"], false);
        assert!(!file.exists());
    }
}
