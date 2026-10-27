#[cfg(unix)]
use crate::check_output;
use crate::{Installer, Progress, ProgressCallback, Result, fail, install_ownership, remove_path};
#[cfg(unix)]
use std::os::unix::fs::MetadataExt;
use std::{
    fs,
    io::ErrorKind,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

const STOP: &str = "Stop the Hexbot daemon, then run the installer again.";

fn check_internal(home: &Path, relative: &str) -> Result<()> {
    if !home.exists() {
        return Ok(());
    }
    let root = home.canonicalize()?;
    let mut path = root.clone();
    for part in Path::new(relative).components() {
        path.push(part);
        match fs::symlink_metadata(&path) {
            Ok(meta) if meta.file_type().is_symlink() => {
                if relative == "runtime/native-executable" && path == root.join(relative) {
                    let target = fs::read_link(&path)?;
                    let target = if target.is_absolute() {
                        target
                    } else {
                        path.parent().unwrap().join(target)
                    };
                    if install_ownership::resolved(&target)?.starts_with(&root) {
                        continue;
                    }
                }
                return fail(format!(
                    "Refusing to remove through a symlink: {}",
                    path.display()
                ));
            }
            Ok(_) => {
                if !path.canonicalize()?.starts_with(&root) {
                    return fail("Removal path escaped HEXBOT_HOME.");
                }
            }
            Err(e) if e.kind() == ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(e.into()),
        }
    }
    Ok(())
}

pub(crate) fn appimage_running(proc: &Path, app: &Path) -> Result<bool> {
    #[cfg(not(unix))]
    {
        let _ = (proc, app);
        Ok(false)
    }
    #[cfg(unix)]
    {
        let entries = match fs::read_dir(proc) {
            Ok(entries) => entries,
            Err(e) if e.kind() == ErrorKind::NotFound => return Ok(false),
            Err(e) => return Err(e.into()),
        };
        let app = app.canonicalize().unwrap_or_else(|_| app.to_owned());
        for entry in entries {
            let entry = entry?;
            if entry.file_name().to_string_lossy().parse::<u32>().is_err() {
                continue;
            }
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            if meta.uid() != unsafe { libc::getuid() } {
                continue;
            }
            let bytes = match fs::read(entry.path().join("environ")) {
                Ok(bytes) => bytes,
                // Linux hides the environment of non-dumpable processes (keyrings,
                // setuid helpers, other namespaces) and of processes that just
                // exited. A running AppImage is an ordinary, readable process.
                Err(_) => continue,
            };
            for value in bytes
                .split(|b| *b == 0)
                .filter_map(|v| v.strip_prefix(b"APPIMAGE="))
            {
                use std::os::unix::ffi::OsStrExt;
                let path = Path::new(std::ffi::OsStr::from_bytes(value));
                if path.canonicalize().unwrap_or_else(|_| path.to_owned()) == app {
                    return Ok(true);
                }
            }
        }
        Ok(false)
    }
}

fn alive(pid: i32) -> bool {
    #[cfg(unix)]
    {
        unsafe {
            libc::kill(pid, 0) == 0
                || std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
        }
    }
    #[cfg(windows)]
    {
        process_still_active(pid)
    }
}

fn process_executable(pid: i32) -> Option<PathBuf> {
    #[cfg(target_os = "linux")]
    {
        fs::read_link(format!("/proc/{pid}/exe")).ok()
    }
    #[cfg(target_os = "macos")]
    {
        let mut buffer = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
        let len =
            unsafe { libc::proc_pidpath(pid, buffer.as_mut_ptr().cast(), buffer.len() as u32) };
        if len <= 0 {
            return None;
        }
        buffer.truncate(buffer.iter().position(|b| *b == 0).unwrap_or(buffer.len()));
        use std::os::unix::ffi::OsStringExt;
        Some(PathBuf::from(std::ffi::OsString::from_vec(buffer)))
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = pid;
        None
    }
}

/// Take an exclusive lock, saying what the installer waits for when it is held.
fn lock_or_wait(
    file: fs::File,
    progress: &mut ProgressCallback<'_>,
    waiting: &str,
) -> Result<fs::File> {
    let mut blocking = false;
    loop {
        match try_lock(&file, blocking) {
            Ok(()) => return Ok(file),
            Err(error) if lock_contended(&error) && !blocking => {
                progress(Progress::new("wait", waiting));
                blocking = true;
            }
            Err(error) if error.kind() == ErrorKind::Interrupted => {}
            Err(error) => return Err(error.into()),
        }
    }
}

fn lock_contended(error: &std::io::Error) -> bool {
    error.kind() == ErrorKind::WouldBlock || error.raw_os_error() == Some(33)
}

fn try_lock(file: &fs::File, blocking: bool) -> std::io::Result<()> {
    if blocking {
        file.lock()
    } else {
        file.try_lock().map_err(|e| match e {
            std::fs::TryLockError::WouldBlock => std::io::Error::from(ErrorKind::WouldBlock),
            std::fs::TryLockError::Error(error) => error,
        })
    }
}

impl Installer {
    /// Kept outside HEXBOT_HOME so uninstalling data cannot replace a locked inode.
    /// All terminal/windowed installers for this user share it, including custom homes.
    pub(crate) fn lock_installation(
        &self,
        progress: &mut ProgressCallback<'_>,
    ) -> Result<fs::File> {
        self.paths.validate()?;
        let path = self.paths.installer_lock(self.target);
        fs::create_dir_all(path.parent().ok_or("Invalid installer lock path")?)?;
        let file = open_lock(&path)?;
        if !file.metadata()?.is_file() {
            return fail("The installer lock must be a regular file.");
        }
        lock_or_wait(
            file,
            progress,
            "Waiting for another Hexbot installer to finish.",
        )
    }

    /// The daemon's native updater and `hexbot setup` select runtimes under
    /// this lock. Holding it from the last version check through `hexbot
    /// setup --activate` keeps an automatic update from landing in between.
    pub(crate) fn lock_activation(&self, progress: &mut ProgressCallback<'_>) -> Result<fs::File> {
        let runtime = self.paths.hexbot_home.join("runtime");
        fs::create_dir_all(&runtime)?;
        // Open it as the daemon does, so both lock the same file.
        let file = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(runtime.join("activate.lock"))?;
        lock_or_wait(
            file,
            progress,
            "Waiting for another Hexbot setup or update to finish.",
        )
    }

    pub(crate) fn preflight_ownership(&self) -> Result<()> {
        if self.target.is_windows() {
            crate::windows_service::check_service(
                &self.paths.service_file(self.target),
                &self.paths.hexbot_home,
            )?;
            if let Some(owner) = crate::windows_service::foreign_wrapper_owner(
                &self.paths.cli_wrapper(self.target),
                &self.paths.hexbot_home,
            )? {
                return fail(format!(
                    "The Hexbot CLI on this computer belongs to {}. Uninstall it from there first.",
                    owner.display()
                ));
            }
            return Ok(());
        }
        #[cfg(not(unix))]
        {
            fail("This service target cannot be managed on Windows.")
        }
        #[cfg(unix)]
        {
            install_ownership::check_service(
                &self.paths.service_file(self.target),
                &self.paths.hexbot_home,
                self.target.is_macos(),
            )?;
            if let Ok(text) = fs::read_to_string(self.paths.wrapper())
                && let Some(owner) = install_ownership::wrapper_home(&text)
                && !install_ownership::wrapper_owned(&self.paths.wrapper(), &self.paths.hexbot_home)
            {
                return fail(format!(
                    "The Hexbot CLI on this computer belongs to {}. Uninstall it from there first.",
                    owner.display()
                ));
            }
            Ok(())
        }
    }

    pub(crate) fn remove_owned_path(&self, path: &Path) -> Result<()> {
        if let Ok(relative) = path.strip_prefix(&self.paths.hexbot_home) {
            check_internal(
                &self.paths.hexbot_home,
                relative.to_str().ok_or("Invalid removal path")?,
            )?;
        }
        remove_path(path)
    }

    pub(crate) fn preflight_home_removal(&self) -> Result<()> {
        self.paths.validate()?;
        for relative in [
            "runtime/native-executable",
            "runtime/native-current.json",
            "runtime/native",
            "runtime/native-running.json",
            "native-daemon.lock",
            "install.json",
        ] {
            check_internal(&self.paths.hexbot_home, relative)?;
        }
        Ok(())
    }

    pub(crate) fn preflight_service_removal(&self) -> Result<()> {
        // Discovery hides foreign/invalid tasks. A destructive action must
        // distinguish them from absence even when no working daemon exists.
        if self.target.is_windows() {
            crate::windows_service::check_service(
                &self.paths.service_file(self.target),
                &self.paths.hexbot_home,
            )?;
        }
        Ok(())
    }

    pub(crate) fn remove_service(&self, progress: &mut ProgressCallback<'_>) -> Result<()> {
        let file = self.paths.service_file(self.target);
        if self.target.is_windows() {
            crate::windows_service::check_service(&file, &self.paths.hexbot_home)?;
            let service = crate::windows_service::inspect(&file, &self.paths.hexbot_home)?;
            if !service.installed && !service.recoverable {
                return Ok(());
            }
            // Authenticate and remove via the same scheduler contract even if
            // runtime selection or the daemon binary is damaged.
            #[cfg(windows)]
            crate::windows_service::remove(
                &file,
                &self.paths.hexbot_home,
                self.paths.service_no_load,
            )?;
            #[cfg(windows)]
            {
                progress(Progress::new("service", "Daemon service removed."));
                return Ok(());
            }
            #[cfg(not(windows))]
            return fail("Windows tasks must be removed on Windows.");
        }
        #[cfg(not(unix))]
        {
            fail("This service target cannot be managed on Windows.")
        }
        #[cfg(unix)]
        {
            install_ownership::check_service(
                &file,
                &self.paths.hexbot_home,
                self.target.is_macos(),
            )?;
            if !file.exists() {
                return Ok(());
            }
            // Do not depend on a working native-executable pointer to uninstall a service.
            if !self.paths.service_no_load {
                if self.target.is_macos() {
                    #[cfg(not(unix))]
                    return fail("The macOS service can only be removed on macOS.");
                    #[cfg(unix)]
                    {
                        let uid = unsafe { libc::getuid() };
                        let mut stopped = false;
                        for domain in [format!("gui/{uid}"), format!("user/{uid}")] {
                            stopped |= self
                                .paths
                                .command("launchctl")
                                .args(["bootout", &domain])
                                .arg(&file)
                                .output()?
                                .status
                                .success();
                        }
                        if !stopped {
                            check_output(
                                self.paths
                                    .command("launchctl")
                                    .args(["unload", "-w"])
                                    .arg(&file)
                                    .output()?,
                            )?;
                        }
                    }
                } else {
                    let _ = self
                        .paths
                        .command("systemctl")
                        .args(["--user", "disable", "--now", "hexbot"])
                        .output();
                }
            }
            self.remove_owned_path(&file)?;
            if !self.paths.service_no_load && self.target.is_linux() {
                let _ = self
                    .paths
                    .command("systemctl")
                    .args(["--user", "daemon-reload"])
                    .output();
            }
            progress(Progress::new("service", "Daemon service removed."));
            Ok(())
        }
    }

    // Hold the lock through removal so no daemon can start against files being deleted.
    pub(crate) fn stop_daemon(&self) -> Result<Option<fs::File>> {
        let lock_path = self.paths.hexbot_home.join("native-daemon.lock");
        let lock = match fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&lock_path)
        {
            Ok(file) => Some(file),
            Err(e) if e.kind() == ErrorKind::NotFound => None,
            Err(e) => return Err(e.into()),
        };
        let try_lock = || {
            lock.as_ref()
                .is_none_or(|file| try_lock(file, false).is_ok())
        };
        // A free lock means any running record is stale, even if its PID was reused.
        if try_lock() {
            return Ok(lock);
        }
        let record_path = self.paths.hexbot_home.join("runtime/native-running.json");
        let record: Option<serde_json::Value> = match fs::read(record_path) {
            Ok(bytes) => Some(serde_json::from_slice(&bytes).map_err(|_| STOP)?),
            Err(e) if e.kind() == ErrorKind::NotFound => None,
            Err(e) => return Err(e.into()),
        };
        let pid = record
            .as_ref()
            .and_then(|v| v["pid"].as_i64())
            .filter(|p| *p > 0 && *p <= i32::MAX as i64)
            .map(|p| p as i32);
        if let Some(pid) = pid.filter(|p| alive(*p)) {
            let owner = fs::read_to_string(&lock_path)
                .ok()
                .and_then(|s| s.trim().parse::<i32>().ok());
            let recorded = record
                .as_ref()
                .and_then(|v| v["executable"].as_str())
                .and_then(|p| Path::new(p).canonicalize().ok());
            let actual = process_executable(pid).and_then(|p| p.canonicalize().ok());
            if owner != Some(pid)
                || recorded.is_none()
                || actual != recorded
                || pid == std::process::id() as i32
            {
                return fail(STOP);
            }
            if !terminate(pid) {
                return fail(STOP);
            }
            let deadline = Instant::now() + Duration::from_secs(15);
            while !try_lock() {
                if Instant::now() >= deadline {
                    return fail(STOP);
                }
                std::thread::sleep(Duration::from_millis(25));
            }
        } else {
            return fail(STOP);
        }
        Ok(lock)
    }
}

fn open_lock(path: &Path) -> Result<fs::File> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        Ok(fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(path)?)
    }
    #[cfg(windows)]
    {
        Ok(fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(path)?)
    }
}

fn terminate(pid: i32) -> bool {
    #[cfg(unix)]
    {
        unsafe { libc::kill(pid, libc::SIGTERM) == 0 }
    }
    #[cfg(windows)]
    {
        // No signal is sent using a recorded PID on Windows. The owned task
        // is stopped first; otherwise ask the user to stop the daemon.
        let _ = pid;
        false
    }
}

#[cfg(windows)]
fn process_still_active(pid: i32) -> bool {
    const STILL_ACTIVE: u32 = 259;
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut std::ffi::c_void;
        fn GetExitCodeProcess(process: *mut std::ffi::c_void, code: *mut u32) -> i32;
        fn CloseHandle(handle: *mut std::ffi::c_void) -> i32;
    }
    if pid <= 0 {
        return false;
    }
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid as u32);
        if handle.is_null() {
            return std::io::Error::last_os_error().raw_os_error() != Some(87);
        }
        let mut code = 0u32;
        let ok = GetExitCodeProcess(handle, &mut code) != 0 && code == STILL_ACTIVE;
        CloseHandle(handle);
        ok
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::{Paths, Target};
    use std::os::fd::AsRawFd;
    use std::{
        io::{BufRead, BufReader, Write},
        process::{Command, Stdio},
    };
    fn engine(root: &Path) -> Installer {
        Installer {
            paths: Paths {
                opt_override: None,
                home: root.join("user"),
                hexbot_home: root.join("hexbot"),
                apps_override: Some(root.join("apps")),
                service_root: root.join("services"),
                service_no_load: true,
            },
            target: Target::LinuxX86_64,
            base_url: String::new(),
        }
    }

    #[test]
    fn proc_environ_finds_appimages_even_when_executable_is_a_mount() {
        let root = tempfile::tempdir().unwrap();
        let proc = root.path().join("proc");
        fs::create_dir_all(proc.join("123")).unwrap();
        let app = root.path().join("legacy.AppImage");
        fs::write(&app, "app").unwrap();
        fs::write(
            proc.join("123/environ"),
            format!("OTHER=value\0APPIMAGE={}\0", app.display()),
        )
        .unwrap();
        assert!(appimage_running(&proc, &app).unwrap());
        assert!(!appimage_running(&proc, &root.path().join("other.AppImage")).unwrap());
    }

    #[test]
    #[ignore = "subprocess fixture for graceful shutdown"]
    fn daemon_fixture() {
        let home = PathBuf::from(std::env::var_os("HEXBOT_TEST_STOP_HOME").unwrap());
        fs::create_dir_all(home.join("runtime")).unwrap();
        let mut lock = fs::File::create(home.join("native-daemon.lock")).unwrap();
        assert_eq!(unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX) }, 0);
        write!(lock, "{}", std::process::id()).unwrap();
        fs::write(home.join("runtime/native-running.json"), serde_json::json!({"pid":std::process::id(),"executable":std::env::current_exe().unwrap()}).to_string()).unwrap();
        extern "C" fn terminate(_: i32) {
            unsafe {
                libc::_exit(0);
            }
        }
        unsafe {
            libc::signal(libc::SIGTERM, terminate as *const () as libc::sighandler_t);
        }
        println!("DAEMON_READY");
        std::io::stdout().flush().unwrap();
        loop {
            unsafe {
                libc::pause();
            }
        }
    }

    #[test]
    fn unsupervised_daemon_receives_sigterm_and_releases_lock_before_removal() {
        let root = tempfile::tempdir().unwrap();
        let engine = engine(root.path());
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "safety::tests::daemon_fixture",
                "--ignored",
                "--nocapture",
            ])
            .env("HEXBOT_TEST_STOP_HOME", &engine.paths.hexbot_home)
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut ready = false;
        for line in BufReader::new(child.stdout.take().unwrap()).lines() {
            if line.unwrap().contains("DAEMON_READY") {
                ready = true;
                break;
            }
        }
        assert!(ready);
        let result = engine.stop_daemon();
        if result.is_err() {
            let _ = child.kill();
        }
        let exit = child.wait().unwrap();
        result.unwrap();
        assert!(
            exit.success(),
            "the fixture handles SIGTERM and exits successfully"
        );
    }
}
