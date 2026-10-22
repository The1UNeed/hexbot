#![cfg(windows)]
//! Owned desktop pipe shutdown must reach App/Pi cleanup and release the home.
use futures_util::{SinkExt, StreamExt};
use hexbot_core::{auth, db, osutil, windows_paths};
use serde_json::{Value, json};
use std::{fs, path::PathBuf, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Command,
};
use tokio_tungstenite::{connect_async, tungstenite::Message};

#[tokio::test]
#[ignore = "requires the real locked Node/Pi bundle on a native Windows runner"]
async fn owned_desktop_pipe_quit_and_restart_clean_up_real_pi_and_home_lock() {
    let bundle =
        PathBuf::from(std::env::var_os("HEXBOT_NATIVE_TEST_BUNDLE").expect("native bundle"));
    let root = tempfile::tempdir().unwrap();
    let home = root.path().join("Jos\u{e9} Full state");
    fs::create_dir_all(home.join("profiles/owl")).unwrap();
    db::migrate(&home).unwrap();
    db::open(&home).unwrap().execute_batch(
        "INSERT INTO bots(name,owner_id) VALUES('owl','local'); INSERT INTO sections(id,bot,owner_id,title) VALUES('first','owl','local','First');"
    ).unwrap();
    fs::write(
        home.join("profiles/owl/config.yaml"),
        "model:\n  provider: openai\n  default: gpt-4o-mini\n",
    )
    .unwrap();
    let token = auth::local_token(&home).unwrap();
    let fixture = root.path().join("trusted launch wrapper");
    fs::create_dir_all(fixture.join("pi")).unwrap();
    fs::copy(bundle.join("node.exe"), fixture.join("node.exe")).unwrap();
    let descendants = fixture.join("descendants.json");
    fs::write(fixture.join("pi/launch.mjs"), format!(r#"import {{spawn}} from 'node:child_process';
import {{writeFileSync}} from 'node:fs';
// Deliberately keep a descendant alive after Pi itself is killed. The daemon
// lifetime job must reap it even in the force fallback; no containment claim.
const child = spawn(process.execPath, ['-e', 'setInterval(() => {{}}, 1000)'], {{stdio:'ignore', windowsHide:true}});
writeFileSync({}, JSON.stringify([process.pid, child.pid]));
await import({});
"#, json!(descendants), json!(url::Url::from_file_path(bundle.join("pi/launch.mjs")).unwrap().as_str()))).unwrap();
    for mode in ["command", "eof", "force"] {
        let mut child = Command::new(env!("CARGO_BIN_EXE_hexbot"))
            .args(["serve", "--host", "127.0.0.1", "--port", "0"])
            .env("HEXBOT_HOME", &home)
            .env("HEXBOT_PI_EXECUTABLE", fixture.join("node.exe"))
            .env("HEXBOT_SUPERVISOR", "desktop")
            .env("HEXBOT_DESKTOP_CONTROL", "stdin-v1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .creation_flags(0x08000000)
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let daemon_pid = child.id().unwrap();
        let mut output = BufReader::new(child.stdout.take().unwrap()).lines();
        let port: u16 = tokio::time::timeout(Duration::from_secs(45), async {
            while let Some(line) = output.next_line().await.unwrap() {
                if let Some(port) = line.strip_prefix("HERMES_BACKEND_READY port=") {
                    return port.parse().unwrap();
                }
            }
            panic!("daemon exited before readiness");
        })
        .await
        .unwrap();
        let (mut socket, _) = connect_async(format!("ws://127.0.0.1:{port}/api/ws?token={token}"))
            .await
            .unwrap();
        socket.send(Message::Text(json!({"jsonrpc":"2.0","id":"open-pi","method":"hexbot.sections.open","params":{"id":"first"}}).to_string().into())).await.unwrap();
        tokio::time::timeout(Duration::from_secs(90), async {
            while let Some(frame) = socket.next().await {
                let frame = frame.unwrap();
                if !frame.is_text() {
                    continue;
                }
                let value: Value = serde_json::from_str(frame.to_text().unwrap()).unwrap();
                if value["id"] == "open-pi" {
                    assert!(
                        value.get("error").is_none(),
                        "Actual Pi open failed: {value}"
                    );
                    return;
                }
            }
            panic!("socket closed before Pi open reply");
        })
        .await
        .unwrap();
        let children = Command::new(windows_paths::system_program("WindowsPowerShell/v1.0/powershell.exe").unwrap())
            .args(["-NoProfile", "-NonInteractive", "-Command", &format!("ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process -Filter 'ParentProcessId = {daemon_pid}' | Where-Object Name -eq 'node.exe' | ForEach-Object ProcessId)")])
            .output().await.unwrap();
        assert!(
            children.status.success(),
            "{}",
            String::from_utf8_lossy(&children.stderr)
        );
        let mut pi_pids: Vec<u32> = serde_json::from_slice(&children.stdout).unwrap();
        let descendants: Vec<u32> =
            serde_json::from_slice(&fs::read(&descendants).unwrap()).unwrap();
        pi_pids.extend(descendants);
        assert!(!pi_pids.is_empty(), "No actual Runtime-owned Pi child");
        assert!(pi_pids.iter().all(|pid| osutil::process_alive(*pid)));
        let handles = pi_pids
            .iter()
            .map(|pid| ProcessHandle::open(*pid))
            .collect::<Vec<_>>();
        let mut input = child.stdin.take().unwrap();
        if mode == "command" {
            input.write_all(b"HEXBOT_SHUTDOWN_V1\n").await.unwrap();
        }
        if mode == "force" {
            child.start_kill().unwrap();
        }
        drop(input); // EOF also cleans up if the owning app exits unexpectedly.
        let status = tokio::time::timeout(Duration::from_secs(15), child.wait())
            .await
            .unwrap()
            .unwrap();
        if mode != "force" {
            assert!(
                status.success(),
                "Owned daemon did not shut down normally: {status}"
            );
        }
        for process in handles {
            process.wait();
        }
        assert!(
            pi_pids.iter().all(|pid| !osutil::process_alive(*pid)),
            "Pi survived owned daemon shutdown: {pi_pids:?}"
        );
        if mode != "force" {
            assert!(!home.join("serve-state.json").exists());
        }
        let lock = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(home.join("native-daemon.lock"))
            .unwrap();
        lock.try_lock()
            .expect("Home lock was not released before restart");
    }
}

// Capture handles before shutdown, then wait on kernel exit events. PIDs alone
// cannot prove all descendants have finished when the daemon wait completes.
struct ProcessHandle(*mut std::ffi::c_void);
#[link(name = "kernel32")]
unsafe extern "system" {
    fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut std::ffi::c_void;
    fn WaitForSingleObject(handle: *mut std::ffi::c_void, milliseconds: u32) -> u32;
    fn CloseHandle(handle: *mut std::ffi::c_void) -> i32;
}
impl ProcessHandle {
    fn open(pid: u32) -> Self {
        let handle = unsafe { OpenProcess(0x00100000, 0, pid) };
        assert!(!handle.is_null(), "Cannot own fixture process {pid}");
        Self(handle)
    }
    fn wait(&self) {
        assert_eq!(
            unsafe { WaitForSingleObject(self.0, 15000) },
            0,
            "Descendant did not exit"
        );
    }
}
impl Drop for ProcessHandle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}
