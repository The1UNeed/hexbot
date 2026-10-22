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
        "$expectedSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $taskName = 'Hexbot-daemon-' + $expectedSid; $expectedPowerShell = {}; $expectedArguments = {}; $expectedOwner = {}; $allowLegacy = ${}; $operation = {};\n{}",
        quote(&executable.to_string_lossy()),
        quote(&arguments),
        quote(&owner(home)?),
        legacy,
        quote(operation),
        include_str!("../assets/windows-task-control.ps1")
    ))
}
