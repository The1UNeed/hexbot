//! Actual debug router/host controls, included by the existing native suite.
use super::{powershell, process_handle::ProcessHandle, quote};
use futures_util::FutureExt;
use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::{TcpListener, TcpStream},
    process::{Child, Command},
};

fn fixture(root: &Path) -> PathBuf {
    let executable = root.join("工具 José & child.exe");
    let source = root.join("fixture.cs");
    fs::write(&source, include_str!("dev-child-fixture.cs")).unwrap();
    let output = powershell(&format!(
        "Add-Type -Path {} -OutputAssembly {} -OutputType ConsoleApplication",
        quote(&source),
        quote(&executable)
    ));
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    executable
}
async fn record(listener: &TcpListener) -> (Value, BufReader<TcpStream>) {
    record_with_budget(listener, 30).await
}
async fn record_with_budget(listener: &TcpListener, seconds: u64) -> (Value, BufReader<TcpStream>) {
    tokio::time::timeout(Duration::from_secs(seconds), async {
        let (stream, _) = listener.accept().await.unwrap();
        let mut stream = BufReader::new(stream);
        let mut text = String::new();
        assert_ne!(stream.read_line(&mut text).await.unwrap(), 0);
        (serde_json::from_str(&text).unwrap(), stream)
    })
    .await
    .expect("fixture readiness event")
}
async fn wait(child: &mut Child) -> i32 {
    tokio::time::timeout(Duration::from_secs(20), child.wait())
        .await
        .expect("host deadline")
        .unwrap()
        .code()
        .unwrap()
}
fn assert_ended(processes: &[ProcessHandle]) {
    let snapshots: Vec<_> = processes.iter().map(ProcessHandle::snapshot).collect();
    eprintln!("Dev host completion at API return: {snapshots:?}");
    assert!(
        processes.iter().all(|process| !process.alive()),
        "{snapshots:?}"
    );
}
fn host(binary: &Path, mode: &str, port: u16) -> Child {
    Command::new(env!("CARGO_BIN_EXE_hexbot"))
        .args(["__dev-child", "control", "--"])
        .arg(binary)
        .args([mode, &port.to_string()])
        .arg(binary)
        .stdin(Stdio::piped())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .unwrap()
}

#[tokio::test]
async fn dev_host_eof_root_exit_and_unrelated_survival() {
    let root = tempfile::tempdir().unwrap();
    let binary = fixture(root.path());
    for mode in ["tree", "root-exit"] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let mut unrelated = Command::new(&binary)
            .args(["unrelated", &port.to_string()])
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let (outside, mut outside_stream) = record(&listener).await;
        let outside = ProcessHandle::open(outside["pid"].as_u64().unwrap() as u32);
        outside_stream.write_all(&[1]).await.unwrap();
        let mut child = host(&binary, mode, port);
        let mut handles = vec![];
        let mut streams = vec![];
        for _ in 0..2 {
            let (event, stream) = record(&listener).await;
            handles.push(ProcessHandle::open(event["pid"].as_u64().unwrap() as u32));
            streams.push(stream);
        }
        assert!(handles.iter().all(ProcessHandle::alive));
        for stream in &mut streams {
            stream.write_all(&[1]).await.unwrap();
        }
        if mode == "tree" {
            drop(child.stdin.take());
        }
        let code = wait(&mut child).await;
        // Assert kernel completion before any later process waits.
        assert_ended(&handles);
        assert_eq!(code, if mode == "root-exit" { 17 } else { 0 });
        assert!(outside.alive(), "unrelated process was terminated");
        outside_stream.write_all(&[1]).await.unwrap();
        assert_eq!(wait(&mut unrelated).await, 0);
    }
}

#[tokio::test]
async fn dev_host_parent_death_console_events_and_assignment_refusal() {
    let root = tempfile::tempdir().unwrap();
    let binary = fixture(root.path());
    for mode in ["parent", "break", "ctrlc", "assignment"] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let mut launcher = Command::new(&binary)
            .args([mode, &port.to_string()])
            .arg(&binary)
            .arg(env!("CARGO_BIN_EXE_hexbot"))
            .stdin(Stdio::piped())
            .creation_flags(0x08000000)
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        // Keep the real input writer alive even after the parent is killed, so
        // parent-death tests cannot pass merely because stdin reached EOF.
        let input = launcher.stdin.take().unwrap();
        let (parent, mut parent_stream) = record(&listener).await;
        assert_eq!(parent["role"], "parent");
        let host = ProcessHandle::open(parent["host"].as_u64().unwrap() as u32);
        parent_stream.write_all(&[1]).await.unwrap();
        if mode == "assignment" {
            assert_eq!(wait(&mut launcher).await, 126);
            assert!(!host.alive());
            // A refused suspended root cannot connect to the listener.
            assert!(listener.accept().now_or_never().is_none());
            continue;
        }
        let mut handles = vec![];
        let mut root_stream = None;
        let mut leaf_stream = None;
        for _ in 0..2 {
            let (event, mut stream) = record(&listener).await;
            handles.push(ProcessHandle::open(event["pid"].as_u64().unwrap() as u32));
            stream.write_all(&[1]).await.unwrap();
            if event["role"] == "tree" {
                root_stream = Some(stream);
            } else {
                leaf_stream = Some(stream);
            }
        }
        if mode == "parent" {
            launcher.kill().await.unwrap();
            assert!(host.exits_within(20_000));
        } else {
            parent_stream.write_all(&[1]).await.unwrap();
            let mut event = String::new();
            tokio::time::timeout(
                Duration::from_secs(10),
                root_stream.as_mut().unwrap().read_line(&mut event),
            )
            .await
            .unwrap()
            .unwrap();
            assert_eq!(
                serde_json::from_str::<Value>(&event).unwrap()["role"],
                "console-event"
            );
            assert!(host.alive(), "console event bypassed the host barrier");
            drop(input);
            assert_eq!(wait(&mut launcher).await, 0);
        }
        assert_ended(&handles);
        assert!(!host.alive());
        drop(leaf_stream);
    }
}

#[tokio::test]
async fn dev_host_literal_unicode_argv_and_invalid_arguments() {
    let root = tempfile::tempdir().unwrap();
    let node = super::powershell("(Get-Command node.exe -ErrorAction Stop).Source");
    assert!(node.status.success());
    let node = PathBuf::from(String::from_utf8(node.stdout).unwrap().trim());
    let script = root.path().join("literal 工具 & script.mjs");
    fs::write(
        &script,
        "console.log(JSON.stringify(process.argv.slice(2)));process.exit(19)",
    )
    .unwrap();
    let literal = ["space π 中文", "a&b", "quote\"arg", "%PATH%", "", "tail\\"];
    let mut child = Command::new(env!("CARGO_BIN_EXE_hexbot"))
        .args(["__dev-child", "argv", "--"])
        .arg(&node)
        .arg(&script)
        .args(literal)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    let line = tokio::time::timeout(Duration::from_secs(20), lines.next_line())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(serde_json::from_str::<Vec<String>>(&line).unwrap(), literal);
    assert_eq!(wait(&mut child).await, 19);
    for args in [
        vec!["web", "node.exe"],
        vec!["web", "--", "node.exe"],
        vec!["web", "--", "C:\\run.cmd"],
        vec!["web", "--", "C:\\run.bat"],
        vec!["web", "--", "C:\\run.sh"],
    ] {
        let output = Command::new(env!("CARGO_BIN_EXE_hexbot"))
            .arg("__dev-child")
            .args(args)
            .env("HEXBOT_HOME", root.path().join("must-not-exist"))
            .output()
            .await
            .unwrap();
        assert_eq!(output.status.code(), Some(2));
        assert!(!root.path().join("must-not-exist").exists());
    }
    let help = Command::new(env!("CARGO_BIN_EXE_hexbot"))
        .arg("--help")
        .output()
        .await
        .unwrap();
    assert!(!String::from_utf8_lossy(&help.stdout).contains("__dev-child"));
}

// Requires the same native workspace dependencies as the existing launcher job.
// No fake Electron, daemon or pnpm executable is substituted.
#[tokio::test]
async fn dev_runner_actual_pnpm_electron_daemon_and_direct_web_stop_separately() {
    use super::windows_task::completion::identity;
    let root = tempfile::tempdir().unwrap();
    let repository = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap();
    let node = powershell("(Get-Command node.exe -ErrorAction Stop).Source");
    assert!(node.status.success());
    let node = PathBuf::from(String::from_utf8(node.stdout).unwrap().trim());
    for mode in ["desktop", "parent", "sibling", "direct"] {
        let home = root.path().join(mode);
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let mut driver = Command::new(&node)
            .arg(
                super::windows_node_path::node_path(
                    &repository.join("backend/hexbot-core/tests/support/dev-app-controls.mjs"),
                )
                .unwrap(),
            )
            .arg(super::windows_node_path::node_path(&repository).unwrap())
            .arg(env!("CARGO_BIN_EXE_hexbot"))
            .arg(&home)
            .arg(mode)
            .arg(port.to_string())
            .env_remove("ELECTRON_RUN_AS_NODE")
            .stdin(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let (event, mut control) = record_with_budget(&listener, 180).await;
        assert_eq!(event["role"], "apps");
        let mut owned = std::collections::BTreeSet::from([driver.id().unwrap()]);
        let snapshot = identity::snapshot().unwrap();
        loop {
            let before = owned.len();
            for (pid, parent) in &snapshot {
                if owned.contains(parent) {
                    owned.insert(*pid);
                }
            }
            if before == owned.len() {
                break;
            }
        }
        let driver_pid = driver.id().unwrap();
        let processes: Vec<_> = owned
            .iter()
            .filter(|pid| **pid != driver_pid)
            .map(|pid| ProcessHandle::open(*pid))
            .collect();
        assert!(
            processes.len() >= 4,
            "Actual Vite/pnpm/Electron/daemon tree was not present"
        );
        let images: Vec<_> = owned
            .iter()
            .filter(|pid| **pid != driver_pid)
            .map(|pid| {
                use std::os::windows::io::AsRawHandle;
                identity::image(identity::open(*pid).unwrap().unwrap().as_raw_handle()).unwrap()
            })
            .collect();
        let has = |name: &str| {
            images.iter().any(|path| {
                path.file_name()
                    .is_some_and(|file| file.to_string_lossy().eq_ignore_ascii_case(name))
            })
        };
        assert!(has("node.exe") && has("hexbot.exe"));
        if mode != "direct" {
            assert!(has("electron.exe"), "No actual Electron in {images:?}");
        }
        let web_host = event["hosts"][0].as_u64().unwrap() as u32;
        let mut web = std::collections::BTreeSet::from([web_host]);
        loop {
            let before = web.len();
            for (pid, parent) in &snapshot {
                if web.contains(parent) {
                    web.insert(*pid);
                }
            }
            if before == web.len() {
                break;
            }
        }
        let web_handles: Vec<_> = web.iter().map(|pid| ProcessHandle::open(*pid)).collect();
        if mode == "parent" {
            driver.kill().await.unwrap();
            let deadline = std::time::Instant::now() + Duration::from_secs(20);
            for process in &processes {
                let remaining = deadline
                    .saturating_duration_since(std::time::Instant::now())
                    .as_millis()
                    .min(u32::MAX as u128) as u32;
                assert!(
                    process.exits_within(remaining),
                    "Parent death left {}",
                    process.snapshot()
                );
            }
            // Killing the runner loses its final acknowledgement. These are
            // retained native exit observations, not a runner success code.
            assert_ended(&processes);
            continue;
        }
        control
            .write_all(&[if mode == "sibling" { 2 } else { 1 }])
            .await
            .unwrap();
        let code = wait(&mut driver).await;
        if mode == "sibling" {
            assert_eq!(code, 1, "Sibling failure must stay primary");
            // A forced host loses its acknowledgement. No successful-cleanup
            // assertion is made for that branch's kill-on-close fallback.
        } else if mode == "direct" {
            assert_eq!(code, 0);
            // Direct daemon stop force-kills its owned root. Its job's
            // kill-on-close is containment, not acknowledged tree completion.
            assert_ended(&web_handles);
            eprintln!("Direct daemon completion unproved; web host checked separately");
        } else {
            assert_eq!(code, 0);
            assert_ended(&processes);
        }
    }
}
