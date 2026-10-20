//! Per-user Windows service definition. The daemon's launchd/systemd parser does not
//! own this file; the installer recognizes the marker and the exact `set` lines.
use crate::{Result, fail, install_ownership};
use std::{
    fs, io,
    path::{Path, PathBuf},
};

pub const SERVICE_MARKER: &str = "rem HEXBOT_SERVICE_SCRIPT";
pub const CLI_MARKER: &str = "rem HEXBOT_CLI";
pub const TASK_NAME: &str = "Hexbot";

pub fn windows_service_script(home: &str, path: &str, executable: &str) -> Result<String> {
    for value in [home, path, executable] {
        reject_service_text(value)?;
    }
    if home.is_empty() || executable.is_empty() {
        return fail("The Windows service path is empty.");
    }
    Ok(format!(
        "@echo off\n{SERVICE_MARKER}\nset \"HEXBOT_HOME={home}\"\nset \"HEXBOT_SUPERVISOR=service\"\nset \"PATH={path}\"\n\"{executable}\" serve\n"
    ))
}

pub fn windows_cli_script(home: &str, executable: &str) -> Result<String> {
    for value in [home, executable] {
        reject_service_text(value)?;
    }
    if home.is_empty() || executable.is_empty() {
        return fail("The Windows CLI path is empty.");
    }
    Ok(format!(
        "@echo off\n{CLI_MARKER}\nset \"HEXBOT_HOME={home}\"\n\"{executable}\" %*\n"
    ))
}

/// Join a directory onto PATH with the Windows separator. The script runs on
/// Windows even when this installer is tested on another host.
pub fn windows_path_env(prefix: &Path, current: &str) -> Result<String> {
    let prefix = path_text(prefix)?;
    reject_service_text(&prefix)?;
    reject_service_text(current)?;
    if prefix.contains(';') {
        return fail("The Windows PATH prefix contains a separator.");
    }
    if current.is_empty() {
        Ok(prefix)
    } else {
        Ok(format!("{prefix};{current}"))
    }
}

pub fn windows_task_xml(command: &str) -> Result<String> {
    reject_service_text(command)?;
    if command.is_empty() {
        return fail("The Windows task command is empty.");
    }
    let command = xml_escape(command);
    Ok(format!(
        r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Hexbot daemon</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>{command}</Command>
    </Exec>
  </Actions>
</Task>
"#
    ))
}

pub fn windows_task_xml_bytes(command: &str) -> Result<Vec<u8>> {
    Ok(encode_utf16_le(&windows_task_xml(command)?))
}

pub fn task_xml_path(service_cmd: &Path) -> PathBuf {
    service_cmd.with_extension("xml")
}

pub fn schtasks_create(xml: &Path) -> Vec<String> {
    vec![
        "/Create".into(),
        "/TN".into(),
        TASK_NAME.into(),
        "/XML".into(),
        xml.to_string_lossy().into_owned(),
        "/F".into(),
    ]
}

pub fn schtasks_run() -> [&'static str; 3] {
    ["/Run", "/TN", TASK_NAME]
}

pub fn schtasks_end() -> [&'static str; 3] {
    ["/End", "/TN", TASK_NAME]
}

pub fn schtasks_delete() -> [&'static str; 4] {
    ["/Delete", "/TN", TASK_NAME, "/F"]
}

pub fn check_service(path: &Path, home: &Path) -> Result<()> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.into()),
    };
    if !metadata.is_file() {
        return fail("Refusing a symlink or non-file Hexbot service definition");
    }
    let text = fs::read_to_string(path)?;
    if !text.lines().any(|line| line == SERVICE_MARKER) || text.matches("HEXBOT_HOME").count() != 1
    {
        return fail("Cannot identify the owner of the Hexbot service; left it alone");
    }
    let owner = single_set(&text, "HEXBOT_HOME")
        .ok_or("Cannot identify the home of the existing Hexbot service; left it alone")?;
    let expected = install_ownership::resolved(home)?;
    if install_ownership::resolved(Path::new(&owner))? != expected {
        return fail(format!(
            "The Hexbot service on this computer belongs to {owner}. Uninstall it from there first."
        ));
    }
    let executable = service_executable(&text)
        .ok_or("Cannot identify the executable of the existing Hexbot service")?;
    if !executable_belongs(Path::new(&executable), &expected)? {
        return fail("The Hexbot service executable does not belong to this home; left it alone");
    }
    Ok(())
}

pub fn wrapper_owned(path: &Path, home: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|meta| meta.is_file())
        && fs::read_to_string(path)
            .ok()
            .and_then(|text| wrapper_home(&text))
            .is_some_and(|owner| {
                install_ownership::resolved(&owner)
                    .ok()
                    .zip(install_ownership::resolved(home).ok())
                    .is_some_and(|(owner, home)| owner == home)
            })
}

pub fn foreign_wrapper_owner(path: &Path, home: &Path) -> Result<Option<PathBuf>> {
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    let Some(owner) = wrapper_home(&text) else {
        return Ok(None);
    };
    let same = install_ownership::resolved(&owner)
        .ok()
        .zip(install_ownership::resolved(home).ok())
        .is_some_and(|(owner, home)| owner == home);
    if same { Ok(None) } else { Ok(Some(owner)) }
}

fn wrapper_home(text: &str) -> Option<PathBuf> {
    if !text.lines().any(|line| line == CLI_MARKER) || text.matches("HEXBOT_HOME").count() != 1 {
        return None;
    }
    single_set(text, "HEXBOT_HOME").map(PathBuf::from)
}

fn single_set(text: &str, name: &str) -> Option<String> {
    let prefix = format!("set \"{name}=");
    let mut values = text.lines().filter_map(|line| {
        line.strip_prefix(&prefix)
            .and_then(|rest| rest.strip_suffix('"'))
    });
    let value = values.next()?;
    if values.next().is_some() || value.contains(['"', '\r', '\n']) {
        return None;
    }
    Some(value.to_string())
}

fn service_executable(text: &str) -> Option<String> {
    let mut values = text.lines().filter_map(|line| {
        let rest = line.strip_prefix('"')?;
        let (executable, tail) = rest.split_once('"')?;
        (tail == " serve" && !executable.contains(['"', '\r', '\n']))
            .then(|| executable.to_string())
    });
    let value = values.next()?;
    values.next().is_none().then_some(value)
}

fn executable_belongs(executable: &Path, home: &Path) -> Result<bool> {
    let runtime = home.join("runtime");
    let name_ok = executable
        .file_name()
        .is_some_and(|name| name == "native-executable" || name == "native-executable.exe");
    let parent_ok = executable
        .parent()
        .and_then(|parent| install_ownership::resolved(parent).ok())
        == Some(install_ownership::resolved(&runtime)?);
    if name_ok && parent_ok {
        return stable_pointer(executable, home);
    }
    Ok(install_ownership::resolved(executable)
        .is_ok_and(|path| path.starts_with(home.join("runtime/native"))))
}

fn stable_pointer(executable: &Path, home: &Path) -> Result<bool> {
    match fs::symlink_metadata(executable) {
        Ok(meta) if meta.file_type().is_symlink() => {
            let link = fs::read_link(executable)?;
            let link = if link.is_absolute() {
                link
            } else {
                executable.parent().unwrap().join(link)
            };
            Ok(install_ownership::resolved(&link)
                .is_ok_and(|path| path.starts_with(home.join("runtime/native"))))
        }
        Ok(meta) => Ok(meta.is_file()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(true),
        Err(e) => Err(e.into()),
    }
}

fn reject_service_text(value: &str) -> Result<()> {
    if value.contains(['"', '\r', '\n']) {
        return fail("The Windows service path contains a quote or newline.");
    }
    Ok(())
}

fn path_text(path: &Path) -> Result<String> {
    path.to_str()
        .filter(|text| !text.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "The Windows path is not valid text.".into())
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn encode_utf16_le(text: &str) -> Vec<u8> {
    let mut bytes = vec![0xFF, 0xFE];
    for unit in text.encode_utf16() {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    bytes
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn service_script_matches_the_daemon_marker() {
        let script = windows_service_script(
            r"C:\Users\me",
            r"C:\Users\me\.hexbot\bin;C:\Windows",
            r"C:\Users\me\.hexbot\runtime\native-executable.exe",
        )
        .unwrap();
        assert_eq!(
            script,
            "@echo off\nrem HEXBOT_SERVICE_SCRIPT\nset \"HEXBOT_HOME=C:\\Users\\me\"\nset \"HEXBOT_SUPERVISOR=service\"\nset \"PATH=C:\\Users\\me\\.hexbot\\bin;C:\\Windows\"\n\"C:\\Users\\me\\.hexbot\\runtime\\native-executable.exe\" serve\n"
        );
        assert!(windows_service_script("a\"b", "p", "e").is_err());
        assert!(windows_service_script("a\nb", "p", "e").is_err());
        assert!(windows_service_script("a", "p\r", "e").is_err());
    }

    #[test]
    fn task_xml_is_a_logon_task_for_the_cmd_script() {
        let command = r"C:\Users\me\AppData\Local\Hexbot\hexbot-service.cmd";
        let xml = windows_task_xml(command).unwrap();
        assert!(xml.contains(r#"version="1.2""#));
        assert!(xml.contains("http://schemas.microsoft.com/windows/2004/02/mit/task"));
        assert!(xml.contains("<LogonTrigger>"));
        assert!(xml.contains("<RunLevel>LeastPrivilege</RunLevel>"));
        assert!(xml.contains("<RestartOnFailure>"));
        assert!(xml.contains(&format!("<Command>{command}</Command>")));
        let bytes = windows_task_xml_bytes(command).unwrap();
        assert_eq!(&bytes[..2], &[0xFF, 0xFE]);
        assert!(windows_task_xml("quote\"here").is_err());
        let path = Path::new(command);
        assert_eq!(
            schtasks_create(&task_xml_path(path)),
            [
                "/Create",
                "/TN",
                "Hexbot",
                "/XML",
                path.with_extension("xml").to_string_lossy().as_ref(),
                "/F",
            ]
        );
    }

    #[test]
    fn ownership_accepts_this_home_and_rejects_another() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        fs::create_dir_all(home.join("runtime")).unwrap();
        let home = home.canonicalize().unwrap();
        let executable = home.join("runtime/native-executable.exe");
        let script = windows_service_script(
            home.to_str().unwrap(),
            r"C:\Windows",
            executable.to_str().unwrap(),
        )
        .unwrap();
        let file = root.path().join("hexbot-service.cmd");
        fs::write(&file, &script).unwrap();
        check_service(&file, &home).unwrap();
        let other = root.path().join("other");
        fs::create_dir(&other).unwrap();
        assert!(check_service(&file, &other).is_err());
        fs::write(&file, "not a service").unwrap();
        assert!(check_service(&file, &home).is_err());

        let wrapper = root.path().join("hexbot.cmd");
        fs::write(
            &wrapper,
            windows_cli_script(home.to_str().unwrap(), executable.to_str().unwrap()).unwrap(),
        )
        .unwrap();
        assert!(wrapper_owned(&wrapper, &home));
        assert!(foreign_wrapper_owner(&wrapper, &home).unwrap().is_none());
        assert!(foreign_wrapper_owner(&wrapper, &other).unwrap().is_some());
    }
}
