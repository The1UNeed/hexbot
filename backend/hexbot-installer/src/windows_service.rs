//! Ownership of scripts written by the native Windows CLI.
use std::{
    fs, io,
    path::{Path, PathBuf},
};
const MARKER: &str = "# Hexbot owned home: ";
fn owner(path: &Path) -> Option<PathBuf> {
    if !fs::symlink_metadata(path).ok()?.is_file() {
        return None;
    }
    let text = fs::read_to_string(path).ok()?;
    serde_json::from_str(
        text.trim_start_matches('\u{feff}')
            .lines()
            .next()?
            .strip_prefix(MARKER)?,
    )
    .ok()
}
pub fn wrapper_owned(path: &Path, home: &Path) -> bool {
    owner(path).is_some_and(|owner| {
        crate::install_ownership::resolved(&owner)
            .ok()
            .zip(crate::install_ownership::resolved(home).ok())
            .is_some_and(|(a, b)| a == b)
    })
}
pub fn installed(path: &Path, home: &Path) -> io::Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) if !wrapper_owned(path, home) => {
            return Err(io::Error::other(
                "Existing Windows service belongs to another installation",
            ));
        }
        Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e),
        _ => {}
    }
    let owned = wrapper_owned(path, home);
    #[cfg(windows)]
    if std::env::var("HEXBOT_SERVICE_NO_LOAD").as_deref() != Ok("1") {
        use std::os::windows::process::CommandExt;
        let output = std::process::Command::new(crate::windows_paths::system_program(
            "WindowsPowerShell/v1.0/powershell.exe",
        )?)
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            &crate::windows_task::control(path, home, "state")?,
        ])
        .creation_flags(0x08000000)
        .output()?;
        if !output.status.success() {
            return Err(io::Error::other(
                String::from_utf8_lossy(&output.stderr).trim(),
            ));
        }
        let state = String::from_utf8_lossy(&output.stdout);
        return Ok(owned || state.trim() != "missing");
    }
    Ok(owned)
}
pub fn check_service(path: &Path, home: &Path) -> io::Result<()> {
    installed(path, home).map(|_| ())
}
pub fn foreign_wrapper_owner(path: &Path, home: &Path) -> io::Result<Option<PathBuf>> {
    if matches!(fs::symlink_metadata(path), Err(e) if e.kind() == io::ErrorKind::NotFound)
        || crate::windows_cli::owned(path, home)
    {
        return Ok(None);
    }
    Ok(Some(crate::windows_cli::owner(path).ok_or_else(|| {
        io::Error::other("Unrecognized Windows CLI wrapper; left it alone")
    })?))
}
