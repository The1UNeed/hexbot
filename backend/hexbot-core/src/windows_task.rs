//! Shared task ownership context for the daemon and standalone installer.
use std::{
    fs, io,
    path::{Path, PathBuf},
};
const MARKER: &str = "# Hexbot owned home: ";
pub fn owner(home: &Path) -> io::Result<String> {
    let home = crate::install_ownership::resolved(home)?;
    Ok(format!(
        "Hexbot owned home: {}",
        serde_json::to_string(&home).map_err(io::Error::other)?
    ))
}
pub fn script_owned(path: &Path, home: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|m| m.is_file())
        && fs::read_to_string(path)
            .ok()
            .and_then(|text| {
                text.trim_start_matches('\u{feff}')
                    .lines()
                    .next()?
                    .strip_prefix(MARKER)
                    .and_then(|s| serde_json::from_str::<PathBuf>(s).ok())
            })
            .and_then(|owner| crate::install_ownership::resolved(&owner).ok())
            .zip(crate::install_ownership::resolved(home).ok())
            .is_some_and(|(a, b)| a == b)
}
pub fn check_script(path: &Path, home: &Path) -> io::Result<bool> {
    match fs::symlink_metadata(path) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(false),
        Ok(_) if script_owned(path, home) => Ok(true),
        Err(e) => Err(e),
        _ => Err(io::Error::other(
            "Windows service belongs to another installation; left it alone",
        )),
    }
}
// A held byte-range lock is different from an I/O/permission failure. Never
// turn the latter into a misleading thirty-second "still running" timeout.
pub fn home_idle(home: &Path) -> io::Result<bool> {
    match fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(home.join("native-daemon.lock"))
    {
        Ok(file) => match file.try_lock() {
            Ok(()) => Ok(true),
            Err(fs::TryLockError::WouldBlock) => Ok(false),
            Err(fs::TryLockError::Error(error)) => Err(error),
        },
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(true),
        Err(error) => Err(error),
    }
}

pub fn control(file: &Path, home: &Path, operation: &str) -> io::Result<String> {
    let legacy = check_script(file, home)?;
    #[cfg(windows)]
    let executable = crate::windows_paths::system_program("WindowsPowerShell/v1.0/powershell.exe")?;
    #[cfg(not(windows))]
    let executable = PathBuf::from("powershell.exe");
    let quote = |value: &str| format!("'{}'", value.replace('\'', "''"));
    let arguments = format!(
        "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File \"{}\"",
        file.display()
    );
    Ok(format!(
        "$expectedSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $taskName = 'Hexbot-daemon-' + $expectedSid; $expectedPowerShell = {}; $expectedArguments = {}; $expectedOwner = {}; $allowLegacy = ${}; $operation = {}; $diagnosticHome = {};\n{}\n{}\n{}",
        quote(&executable.to_string_lossy()),
        quote(&arguments),
        quote(&owner(home)?),
        legacy,
        quote(operation),
        quote(&home.to_string_lossy()),
        include_str!("../assets/windows-task-identity.ps1"),
        include_str!("../assets/windows-task-diagnostic.ps1"),
        include_str!("../assets/windows-task-control.ps1")
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn idle_probe_distinguishes_a_live_lock_from_missing_free_and_invalid_files() {
        let home = tempfile::tempdir().unwrap();
        assert!(home_idle(home.path()).unwrap());
        let lock = home.path().join("native-daemon.lock");
        let file = fs::File::create(&lock).unwrap();
        file.lock().unwrap();
        assert!(!home_idle(home.path()).unwrap());
        drop(file);
        assert!(home_idle(home.path()).unwrap());
        fs::remove_file(&lock).unwrap();
        fs::create_dir(&lock).unwrap();
        assert!(home_idle(home.path()).is_err());
    }
}

#[cfg(windows)]
#[path = "windows_task_stop.rs"]
mod completion;
#[cfg(windows)]
pub fn stop(file: &Path, home: &Path) -> io::Result<()> {
    completion::stop(file, home)
}
