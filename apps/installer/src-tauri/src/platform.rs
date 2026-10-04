//! The two places where a windowed app differs from a terminal: the PATH it
//! starts with, and how it opens another app.

use std::path::Path;
#[cfg(target_os = "macos")]
use std::{io::Read, process::Stdio, sync::mpsc, thread, time::Duration};

/// Apps opened from Finder get launchd's short PATH, while the terminal
/// installer runs with the user's own. `hexbot service install` writes PATH
/// into the service file, and `hexbot setup` checks it for ~/.local/bin, so
/// both should see the login shell's PATH. Runs before any other thread.
pub fn prepare_environment() {
    #[cfg(target_os = "macos")]
    if let Some(shell_path) = login_shell_path() {
        let current = std::env::var_os("PATH").unwrap_or_default();
        let mut seen = std::collections::HashSet::new();
        let joined = std::env::split_paths(&shell_path)
            .chain(std::env::split_paths(&current))
            .filter(|path| seen.insert(path.clone()))
            .collect::<Vec<_>>();
        if let Ok(joined) = std::env::join_paths(joined) {
            // SAFETY: called first thing in main, before Tauri starts any thread.
            unsafe { std::env::set_var("PATH", joined) };
        }
    }
}

#[cfg(target_os = "macos")]
fn login_shell_path() -> Option<String> {
    const MARK: &str = "__HEXBOT_PATH__";
    let shell = std::env::var("SHELL").ok().filter(|s| s.starts_with('/'))?;
    let mut child = std::process::Command::new(shell)
        .args(["-ilc", &format!("printf '{MARK}%s{MARK}' \"$PATH\"")])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        let mut output = String::new();
        let _ = stdout.read_to_string(&mut output);
        let _ = sender.send(output);
    });
    // A slow shell profile must not hold up the window for long.
    let output = receiver.recv_timeout(Duration::from_secs(3));
    let _ = child.kill();
    let _ = child.wait();
    let path = output.ok()?.split(MARK).nth(1)?.to_string();
    (!path.is_empty()).then_some(path)
}

#[cfg(target_os = "macos")]
pub fn open(app: &Path) -> hexbot_installer::Result<()> {
    let status = std::process::Command::new("/usr/bin/open")
        .arg(app)
        .status()?;
    if !status.success() {
        return Err(format!("Could not open {}.", app.display()).into());
    }
    Ok(())
}

/// The installer itself runs from an AppImage, whose runtime points GTK and
/// friends into its own mount. Hexbot is a different AppImage and must start
/// with the user's environment, not the installer's.
#[cfg(not(target_os = "macos"))]
pub fn open(app: &Path) -> hexbot_installer::Result<()> {
    use std::os::unix::process::CommandExt;
    let mut command = std::process::Command::new(app);
    command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .process_group(0);
    hexbot_installer::sanitize_appimage_env(&mut command);
    command.spawn()?;
    Ok(())
}
