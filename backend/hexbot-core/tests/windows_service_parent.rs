#![cfg(windows)]
//! Actual creator exit/kill and watchdog events. Real Runtime/Pi cleanup is
//! exercised separately by windows_shutdown and the scheduler recovery probe.
#[path = "support/windows_process_handle.rs"]
mod process_handle;
#[path = "../src/windows_process_lifetime.rs"]
mod process_lifetime;
#[path = "../src/windows_service_parent.rs"]
mod service_parent;
use process_handle::ProcessHandle;
use serde_json::{Value, json};
use service_parent::trusted_paths as windows_paths;
use std::{
    fs,
    process::Stdio,
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Command,
};

#[tokio::test]
async fn owned_service_creator_exit_reaps_only_its_daemon_tree() {
    let root = tempfile::tempdir().unwrap();
    let mut unrelated = Command::new(std::env::current_exe().unwrap())
        .args(["--ignored", "--exact", "service_leaf_fixture"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let unrelated_handle = ProcessHandle::open(unrelated.id().unwrap());
    for mode in ["exit", "kill", "watchdog", "acquisition-race"] {
        let home = root.path().join(mode);
        fs::create_dir(&home).unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let quote = |p: &std::path::Path| format!("'{}'", p.to_string_lossy().replace('\'', "''"));
        let script = format!(
            "$ErrorActionPreference='Stop';$p=[Diagnostics.ProcessStartInfo]::new();$p.FileName={};$p.Arguments='--ignored --exact service_parent_fixture --nocapture';$p.UseShellExecute=$false;$p.CreateNoWindow=$true;$child=[Diagnostics.Process]::Start($p);[Console]::WriteLine('HEXBOT_PARENT_CHILD '+$child.Id);$null=[Console]::ReadLine();exit 0",
            quote(&std::env::current_exe().unwrap())
        );
        let mut parent = Command::new(
            windows_paths::system_program("WindowsPowerShell/v1.0/powershell.exe").unwrap(),
        )
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .env("HEXBOT_SUPERVISOR", "service")
        .env("HEXBOT_PARENT_FIXTURE_MODE", mode)
        .env("HEXBOT_PARENT_FIXTURE_HOME", &home)
        .env(
            "HEXBOT_PARENT_FIXTURE_ADDRESS",
            listener.local_addr().unwrap().to_string(),
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
        let parent_handle = ProcessHandle::open(parent.id().unwrap());
        let mut lines = BufReader::new(parent.stdout.take().unwrap()).lines();
        let pid = tokio::time::timeout(Duration::from_secs(20), async {
            while let Some(line) = lines.next_line().await.unwrap() {
                if let Some(pid) = line.strip_prefix("HEXBOT_PARENT_CHILD ") {
                    return pid.parse::<u32>().unwrap();
                }
            }
            panic!("Parent exited without fixture child")
        })
        .await
        .unwrap();
        let daemon = ProcessHandle::open(pid);
        let (stream, _) = tokio::time::timeout(Duration::from_secs(20), listener.accept())
            .await
            .unwrap()
            .unwrap();
        let mut stream = BufReader::new(stream);
        let mut text = String::new();
        tokio::time::timeout(Duration::from_secs(10), stream.read_line(&mut text))
            .await
            .unwrap()
            .unwrap();
        let proof: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(proof["pid"], pid);
        let leaf = proof["leaf"]
            .as_u64()
            .map(|pid| ProcessHandle::open(pid as u32));
        assert!(parent_handle.alive() && daemon.alive() && unrelated_handle.alive());
        if let Some(leaf) = &leaf {
            assert!(leaf.alive());
        }
        eprintln!(
            "Service parent before {mode}: parent={} daemon={} proof={proof} unrelated={}",
            parent_handle.snapshot(),
            daemon.snapshot(),
            unrelated_handle.snapshot()
        );
        let started = Instant::now();
        if mode == "kill" || mode == "acquisition-race" {
            parent.start_kill().unwrap();
        } else {
            parent
                .stdin
                .take()
                .unwrap()
                .write_all(b"exit\n")
                .await
                .unwrap();
        }
        let parent_exit = tokio::time::timeout(Duration::from_secs(10), parent.wait())
            .await
            .unwrap()
            .unwrap();
        parent_handle.wait();
        assert!(!parent_handle.alive());
        if mode == "acquisition-race" {
            stream.get_mut().write_all(b"acquire\n").await.unwrap();
        }
        daemon.wait();
        let snapshot = daemon.snapshot();
        eprintln!(
            "Service parent after {mode}: parentExit={parent_exit}; daemon={snapshot}; leaf={:?}; unrelated={}",
            leaf.as_ref().map(ProcessHandle::snapshot),
            unrelated_handle.snapshot()
        );
        assert_eq!(
            snapshot["exitCode"],
            if mode == "watchdog" {
                124
            } else if mode == "acquisition-race" {
                101
            } else {
                0
            }
        );
        if mode == "watchdog" {
            assert!(
                started.elapsed() >= Duration::from_secs(10),
                "Watchdog forced before its cleanup deadline"
            );
        }
        if mode == "acquisition-race" {
            assert!(!home.join("native-daemon.lock").exists());
        } else {
            if let Some(leaf) = &leaf {
                leaf.wait();
                assert!(!leaf.alive());
            }
            let lock = fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(home.join("native-daemon.lock"))
                .unwrap();
            lock.try_lock()
                .expect("Parent shutdown did not release its home");
        }
        assert!(unrelated_handle.alive(), "An unrelated process was killed");
    }
    unrelated.start_kill().unwrap();
    unrelated.wait().await.unwrap();
}

#[tokio::test]
async fn service_startup_refuses_an_unverified_non_powershell_parent() {
    let root = tempfile::tempdir().unwrap();
    let output = Command::new(std::env::current_exe().unwrap())
        .args([
            "--ignored",
            "--exact",
            "service_parent_fixture",
            "--nocapture",
        ])
        .env("HEXBOT_SUPERVISOR", "service")
        .env("HEXBOT_PARENT_FIXTURE_MODE", "exit")
        .env("HEXBOT_PARENT_FIXTURE_HOME", root.path())
        .stdin(Stdio::null())
        .kill_on_drop(true)
        .output()
        .await
        .unwrap();
    assert!(!output.status.success());
    assert!(
        String::from_utf8_lossy(&output.stderr)
            .contains("Cannot verify the live Windows service creator"),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(!root.path().join("native-daemon.lock").exists());
}

#[tokio::test]
#[ignore = "isolated child of the actual System32 PowerShell fixture"]
async fn service_parent_fixture() {
    process_lifetime::retain_until_process_exit().unwrap();
    let mode = std::env::var("HEXBOT_PARENT_FIXTURE_MODE").unwrap();
    let mut barrier = if mode == "acquisition-race" {
        let mut stream =
            tokio::net::TcpStream::connect(std::env::var("HEXBOT_PARENT_FIXTURE_ADDRESS").unwrap())
                .await
                .unwrap();
        stream
            .write_all(format!("{}\n", json!({"pid":std::process::id()})).as_bytes())
            .await
            .unwrap();
        let mut line = String::new();
        BufReader::new(&mut stream)
            .read_line(&mut line)
            .await
            .unwrap();
        Some(stream)
    } else {
        None
    };
    let shutdown = service_parent::shutdown().unwrap();
    let home = std::path::PathBuf::from(std::env::var_os("HEXBOT_PARENT_FIXTURE_HOME").unwrap());
    let lock = fs::File::create(home.join("native-daemon.lock")).unwrap();
    lock.lock().unwrap();
    let mut leaf = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--ignored", "--exact", "service_leaf_fixture"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut stream =
        tokio::net::TcpStream::connect(std::env::var("HEXBOT_PARENT_FIXTURE_ADDRESS").unwrap())
            .await
            .unwrap();
    stream
        .write_all(format!("{}\n", json!({"pid":std::process::id(),"leaf":leaf.id()})).as_bytes())
        .await
        .unwrap();
    shutdown.await;
    if mode == "watchdog" {
        std::future::pending::<()>().await;
    }
    leaf.kill().unwrap();
    leaf.wait().unwrap();
    drop(lock);
    drop(barrier.take());
    std::process::exit(0);
}
#[test]
#[ignore = "owned descendant or unrelated process fixture"]
fn service_leaf_fixture() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let _ = listener.accept();
}
