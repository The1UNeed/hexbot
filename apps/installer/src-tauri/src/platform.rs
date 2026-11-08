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
    let mut command = std::process::Command::new(app);
    command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // A GUI app outlives this installer without inheriting its console.
        // Keep the ambient job boundary; do not request job breakaway.
        command.creation_flags(0x00000008 | 0x00000200); // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
    }
    hexbot_installer::sanitize_appimage_env(&mut command);
    command.spawn()?;
    Ok(())
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::{ffi::c_void, os::windows::ffi::OsStrExt, process::Command};
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CreateEventW(
            attributes: *const c_void,
            manual: i32,
            initial: i32,
            name: *const u16,
        ) -> *mut c_void;
        fn SetEvent(handle: *mut c_void) -> i32;
        fn WaitForSingleObject(handle: *mut c_void, milliseconds: u32) -> u32;
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut c_void;
        fn CloseHandle(handle: *mut c_void) -> i32;
    }
    struct Handle(*mut c_void);
    impl Drop for Handle {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
    struct StopOnDrop(Handle);
    impl Drop for StopOnDrop {
        fn drop(&mut self) {
            unsafe {
                SetEvent(self.0.0);
            }
        }
    }
    fn event(name: &str) -> Handle {
        let name: Vec<_> = std::ffi::OsStr::new(name)
            .encode_wide()
            .chain(Some(0))
            .collect();
        let handle = unsafe { CreateEventW(std::ptr::null(), 1, 0, name.as_ptr()) };
        assert!(!handle.is_null(), "{}", std::io::Error::last_os_error());
        Handle(handle)
    }
    #[test]
    #[ignore = "subprocess fixture; invoked only with an isolated executable"]
    fn open_parent_fixture() {
        let executable = std::env::var_os("HEXBOT_OPEN_FIXTURE").expect("explicit fixture path");
        open(Path::new(&executable)).unwrap();
    }
    #[test]
    fn windows_app_outlives_installer_without_a_console() {
        let root = tempfile::tempdir().unwrap();
        let ready_name = format!(
            "Local\\Hexbot-open-ready-{}-{}",
            std::process::id(),
            root.path().file_name().unwrap().to_string_lossy()
        );
        let stop_name = ready_name.replace("ready", "stop");
        let ready = event(&ready_name);
        let stop = StopOnDrop(event(&stop_name));
        let app = root.path().join("Jos\u{e9} app.exe");
        let marker = root.path().join("running.txt");
        let literal = |value: &str| value.replace('"', "\"\"");
        let source = format!(
            r#"public class Probe {{
[System.Runtime.InteropServices.DllImport("kernel32.dll")] public static extern System.IntPtr GetConsoleWindow();
public static void Main() {{ using (var ready = System.Threading.EventWaitHandle.OpenExisting(@"{}")) using (var stop = System.Threading.EventWaitHandle.OpenExisting(@"{}")) {{
System.IO.File.WriteAllText(@"{}", System.Diagnostics.Process.GetCurrentProcess().Id + "|" + GetConsoleWindow().ToInt64());
ready.Set(); stop.WaitOne(20000); }} }} }}"#,
            literal(&ready_name),
            literal(&stop_name),
            literal(&marker.to_string_lossy())
        );
        let quote = |value: &str| format!("'{}'", value.replace('\'', "''"));
        let ps = std::path::PathBuf::from(std::env::var_os("SystemRoot").unwrap())
            .join("System32")
            .join("WindowsPowerShell")
            .join("v1.0")
            .join("powershell.exe");
        let output = Command::new(ps)
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                &format!(
                    "Add-Type -TypeDefinition {} -OutputAssembly {} -OutputType ConsoleApplication",
                    quote(&source),
                    quote(&app.to_string_lossy())
                ),
            ])
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let parent = Command::new(std::env::current_exe().unwrap())
            .args([
                "--ignored",
                "--exact",
                "platform::tests::open_parent_fixture",
            ])
            .env("HEXBOT_OPEN_FIXTURE", &app)
            .output()
            .unwrap();
        assert!(
            parent.status.success(),
            "{}",
            String::from_utf8_lossy(&parent.stderr)
        );
        assert_eq!(
            unsafe { WaitForSingleObject(ready.0, 15000) },
            0,
            "Child did not signal readiness after installer exit"
        );
        let value = std::fs::read_to_string(marker).unwrap();
        let (pid, console) = value.split_once('|').unwrap();
        assert_eq!(console, "0", "GUI launch inherited a console");
        let process = Handle(unsafe { OpenProcess(0x00100000, 0, pid.parse().unwrap()) }); // SYNCHRONIZE
        assert!(!process.0.is_null(), "Child did not outlive its installer");
        assert_eq!(unsafe { WaitForSingleObject(process.0, 0) }, 258); // WAIT_TIMEOUT: still alive
        unsafe {
            SetEvent(stop.0.0);
        }
        assert_eq!(
            unsafe { WaitForSingleObject(process.0, 15000) },
            0,
            "Fixture did not stop"
        );
    }
}
