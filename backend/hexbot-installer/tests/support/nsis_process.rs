//! Retain the actual spawned kernel handle, never infer identity from a PID file.
use serde_json::json;
use std::{
    io::{BufRead, BufReader, Read, Seek, SeekFrom, Write},
    os::windows::io::AsRawHandle,
    process::{Child, Command, Stdio},
    sync::mpsc,
    thread,
};
unsafe extern "system" {
    fn WaitForSingleObject(handle: *mut std::ffi::c_void, ms: u32) -> u32;
    fn GetProcessTimes(
        handle: *mut std::ffi::c_void,
        created: *mut u64,
        exited: *mut u64,
        kernel: *mut u64,
        user: *mut u64,
    ) -> i32;
    fn GetExitCodeProcess(handle: *mut std::ffi::c_void, code: *mut u32) -> i32;
}
pub struct OwnedChild {
    child: Child,
    reader: Option<thread::JoinHandle<()>>,
    errors: std::fs::File,
}
impl OwnedChild {
    pub fn start(mut command: Command, ready: &'static str) -> Self {
        let errors = tempfile::tempfile().unwrap();
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(errors.try_clone().unwrap())
            .spawn()
            .unwrap();
        let stdout = child.stdout.take().unwrap();
        let (tx, rx) = mpsc::channel();
        let reader = thread::spawn(move || {
            let mut sent = false;
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if !sent && line.contains(ready) {
                    let _ = tx.send(());
                    sent = true;
                }
            }
        });
        let mut owned = Self {
            child,
            reader: Some(reader),
            errors,
        };
        if let Err(error) = rx.recv_timeout(std::time::Duration::from_secs(30)) {
            panic!("Process readiness {error}: {}", owned.diagnostic());
        }
        assert_eq!(owned.snapshot()["wait"], 258);
        owned
    }
    pub fn snapshot(&self) -> serde_json::Value {
        let (mut created, mut exited, mut kernel, mut user, mut code) = (0, 0, 0, 0, 0);
        assert_ne!(
            unsafe {
                GetProcessTimes(
                    self.child.as_raw_handle(),
                    &mut created,
                    &mut exited,
                    &mut kernel,
                    &mut user,
                )
            },
            0
        );
        assert_ne!(
            unsafe { GetExitCodeProcess(self.child.as_raw_handle(), &mut code) },
            0
        );
        json!({"pid":self.child.id(),"created":created.to_string(),"wait":unsafe{WaitForSingleObject(self.child.as_raw_handle(),0)},"exitCode":code})
    }
    fn diagnostic(&mut self) -> String {
        self.errors.seek(SeekFrom::Start(0)).unwrap();
        let mut text = String::new();
        let _ = Read::by_ref(&mut self.errors)
            .take(4096)
            .read_to_string(&mut text);
        format!("kernel={} stderr={text}", self.snapshot())
    }
    pub fn stop(mut self, daemon: bool) {
        if let Some(mut stdin) = self.child.stdin.take() {
            if daemon {
                stdin.write_all(b"HEXBOT_SHUTDOWN_V1\n").unwrap();
            }
            drop(stdin);
        }
        assert_eq!(
            unsafe { WaitForSingleObject(self.child.as_raw_handle(), 15_000) },
            0,
            "{}",
            self.diagnostic()
        );
        let status = self.child.wait().unwrap();
        assert_eq!(status.code(), Some(0), "{}", self.diagnostic());
    }
}
impl Drop for OwnedChild {
    fn drop(&mut self) {
        self.child.stdin.take();
        if unsafe { WaitForSingleObject(self.child.as_raw_handle(), 1000) } != 0 {
            let _ = self.child.kill();
        }
        let _ = self.child.wait();
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
    }
}

pub fn terminal(
    installer: &hexbot_installer::Installer,
    args: &[&str],
    policy: Option<&str>,
) -> std::process::Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_hexbot-install"));
    command
        .args(args)
        .env("HEXBOT_HOME", &installer.paths.hexbot_home)
        .env("HOME", &installer.paths.home)
        .env("USERPROFILE", &installer.paths.home)
        .env(
            "HEXBOT_INSTALL_APPS_DIR",
            installer.paths.apps_override.as_ref().unwrap(),
        )
        .env("HEXBOT_SERVICE_ROOT", &installer.paths.service_root)
        .env("HEXBOT_SERVICE_NO_LOAD", "1")
        .env("HEXBOT_CLI_NO_PATH", "1")
        .env("HEXBOT_UPDATE_URL", &installer.base_url);
    if let Some(policy) = policy {
        command.env("PSExecutionPolicyPreference", policy);
        // Controlled policy scenarios only. A PowerShell 7 runner's module
        // path reaches Windows PowerShell 5.1 through this Rust child, and 5.1
        // then resolves incompatible same-name modules (about_PSModulePath).
        // Removing it lets 5.1 build its default path; production is unchanged.
        command.env_remove("PSModulePath");
    }
    let stdout = tempfile::tempfile().unwrap();
    let stderr = tempfile::tempfile().unwrap();
    let mut child = command
        .stdin(Stdio::null())
        .stdout(stdout.try_clone().unwrap())
        .stderr(stderr.try_clone().unwrap())
        .spawn()
        .unwrap();
    let event = unsafe { WaitForSingleObject(child.as_raw_handle(), 180_000) };
    if event != 0 {
        let _ = child.kill();
        let _ = child.wait();
        panic!("Installer watchdog expired for {args:?}");
    }
    let status = child.wait().unwrap();
    let bytes = |mut file: std::fs::File| {
        file.seek(SeekFrom::Start(0)).unwrap();
        let mut bytes = Vec::new();
        file.take(262145).read_to_end(&mut bytes).unwrap();
        assert!(bytes.len() <= 262144);
        bytes
    };
    let output = std::process::Output {
        status,
        stdout: bytes(stdout),
        stderr: bytes(stderr),
    };
    eprintln!(
        "NSIS terminal {args:?}: status={} stdout={} stderr={}",
        output.status,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    output
}
