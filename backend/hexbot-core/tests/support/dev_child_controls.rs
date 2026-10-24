//! Actual debug router/host controls, included by the existing native suite.
#[path = "dev_host_completion.rs"]
mod completion;
use super::{powershell, process_handle::ProcessHandle, quote};
use completion::assert_parent_completion;
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
        if mode == "parent" {
            assert_parent_completion(&host.snapshot());
        }
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

// Direct-daemon termination authority is a Child retained at creation, not a
// PID read from readiness. The driver still owns production web/desktop hosts.
async fn app_event(control: &mut BufReader<TcpStream>, deadline: tokio::time::Instant) -> Value {
    tokio::time::timeout_at(deadline, async {
        let mut line = String::new();
        assert_ne!(
            control.read_line(&mut line).await.unwrap(),
            0,
            "Driver closed before its checkpoint"
        );
        serde_json::from_str(&line).unwrap()
    })
    .await
    .expect("shared Dev fixture deadline")
}
async fn app_command(control: &mut BufReader<TcpStream>, value: Value) {
    control
        .write_all(format!("{value}\n").as_bytes())
        .await
        .unwrap();
}
fn descendants(snapshot: &[(u32, u32)], root: u32) -> std::collections::BTreeSet<u32> {
    let mut owned = std::collections::BTreeSet::from([root]);
    loop {
        let before = owned.len();
        for (pid, parent) in snapshot {
            if owned.contains(parent) {
                owned.insert(*pid);
            }
        }
        if before == owned.len() {
            return owned;
        }
    }
}
async fn cleanup_app_fixture(
    driver: &mut Child,
    direct: &mut Option<Child>,
    observed: &[ProcessHandle],
) -> Result<(), String> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    let mut errors = vec![];
    let mut late = vec![];
    // Read-only discovery can add wait witnesses on an early failure before
    // the first readiness record. It never grants termination authority.
    if let Some(pid) = driver.id() {
        match super::windows_task::completion::identity::snapshot() {
            Ok(snapshot) => {
                for child in descendants(&snapshot, pid)
                    .into_iter()
                    .filter(|child| *child != pid)
                {
                    if let Ok(handle) = ProcessHandle::try_open(child) {
                        late.push(handle);
                    }
                }
            }
            Err(error) => errors.push(format!("Fixture wait discovery failed: {error}")),
        }
    }
    // Signal all owned roots before waiting on any of them. Child::start_kill
    // uses the creation handle. Neither snapshots nor readiness grant authority.
    for child in std::iter::once(&mut *driver).chain(direct.iter_mut()) {
        match child.try_wait() {
            Ok(Some(_)) => {}
            _ => {
                if let Err(error) = child.start_kill() {
                    errors.push(error.to_string());
                }
            }
        }
    }
    for child in std::iter::once(driver).chain(direct.iter_mut()) {
        if !matches!(
            tokio::time::timeout_at(deadline, child.wait()).await,
            Ok(Ok(_))
        ) {
            errors.push("Owned fixture root was not reaped".into());
        }
    }
    for process in observed.iter().chain(late.iter()) {
        let millis = deadline
            .saturating_duration_since(tokio::time::Instant::now())
            .as_millis()
            .min(u32::MAX as u128) as u32;
        if !process.exits_within(millis) {
            errors.push(format!(
                "Fixture descendant survived: {}",
                process.snapshot()
            ));
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}
#[derive(Debug)]
struct InjectedReadinessFailure;

#[tokio::test]
async fn dev_runner_actual_pnpm_electron_daemon_and_direct_web_stop_separately() {
    use super::windows_task::completion::identity;
    use serde_json::json;
    let root = tempfile::tempdir().unwrap();
    let repository = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap();
    let node = powershell("(Get-Command node.exe -ErrorAction Stop).Source");
    assert!(node.status.success());
    let node = PathBuf::from(String::from_utf8(node.stdout).unwrap().trim());
    let binary = fixture(root.path());
    for mode in [
        "desktop",
        "parent",
        "sibling",
        "direct",
        "direct-readiness-failure",
    ] {
        let home = root.path().join(mode);
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        // The unrelated control is outside both the driver and daemon trees.
        let mut unrelated = Command::new(&binary)
            .args(["unrelated", &port.to_string()])
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let (outside, mut outside_stream) = record(&listener).await;
        let outside = ProcessHandle::open(outside["pid"].as_u64().unwrap() as u32);
        outside_stream.write_all(&[1]).await.unwrap();
        // The original 180s contains provisioning, Vite, Electron, ONE normal
        // bridge start and the real daemon handshake. No phase resets it.
        let startup = tokio::time::Instant::now() + Duration::from_secs(180);
        let wall_deadline = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis()
            + 180_000;
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
            .arg(wall_deadline.to_string())
            .env_remove("ELECTRON_RUN_AS_NODE")
            .stdin(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let mut direct = None;
        let mut observed = vec![];
        let mut failure_ports = None;
        let outcome = std::panic::AssertUnwindSafe(async {
            let (stream, _) = tokio::time::timeout_at(startup, listener.accept()).await.unwrap().unwrap();
            let mut control = BufReader::new(stream);
            let mut event = app_event(&mut control, startup).await;
            if mode.starts_with("direct") {
                assert_eq!(event["role"], "direct-start", "{event}");
                let env: std::collections::BTreeMap<String, String> = serde_json::from_value(event["env"].clone()).unwrap();
                direct = Some(Command::new(env!("CARGO_BIN_EXE_hexbot"))
                    .args(["serve", "--host", "127.0.0.1", "--port", "0"])
                    .current_dir(&repository).envs(env).env("HEXBOT_SUPERVISOR", "dev")
                    .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::inherit()).kill_on_drop(true).spawn().unwrap());
                let pid = direct.as_ref().unwrap().id().unwrap();
                observed.push(ProcessHandle::open(pid));
                app_command(&mut control, json!({"action":"direct-started","pid":pid})).await;
                event = app_event(&mut control, startup).await;
                assert_eq!(event["identity"]["pid"], pid);
            }
            assert_eq!(event["role"], if mode == "direct-readiness-failure" {"injected-readiness-failure"} else {"apps"}, "{event}");
            let driver_pid = driver.id().unwrap();
            let snapshot = identity::snapshot().unwrap();
            let owned = descendants(&snapshot, driver_pid);
            observed.extend(owned.iter().filter(|pid| **pid != driver_pid).map(|pid| ProcessHandle::open(*pid)));
            let images: Vec<_> = owned.iter().filter(|pid| **pid != driver_pid).map(|pid| {
                use std::os::windows::io::AsRawHandle;
                identity::image(identity::open(*pid).unwrap().unwrap().as_raw_handle()).unwrap()
            }).collect();
            assert!(images.iter().any(|path| path.file_name().unwrap().to_string_lossy().eq_ignore_ascii_case("node.exe")));
            if !mode.starts_with("direct") {
                let desktop = descendants(&snapshot, event["hosts"]["desktop"].as_u64().unwrap() as u32);
                assert!(desktop.contains(&(event["identity"]["pid"].as_u64().unwrap() as u32)), "Bridge did not start an owned daemon");
                assert!(images.iter().any(|path| path.file_name().unwrap().to_string_lossy().eq_ignore_ascii_case("electron.exe")));
            }
            if mode == "direct-readiness-failure" {
                assert!(observed.iter().all(ProcessHandle::alive));
                failure_ports = Some([event["daemon"]["port"].as_u64().unwrap() as u16, event["webPort"].as_u64().unwrap() as u16]);
                // The daemon and web are live, but no apps readiness record is
                // accepted. Exercise the same unwind cleanup as an early panic.
                std::panic::panic_any(InjectedReadinessFailure);
            }
            let stop_deadline = tokio::time::Instant::now() + Duration::from_secs(20);
            if mode == "parent" {
                driver.start_kill().unwrap();
                tokio::time::timeout_at(stop_deadline, driver.wait()).await.unwrap().unwrap();
                for process in &observed {
                    let remaining = stop_deadline.saturating_duration_since(tokio::time::Instant::now()).as_millis() as u32;
                    assert!(process.exits_within(remaining));
                }
                assert_ended(&observed);
                for label in ["web", "desktop"] {
                    let pid = event["hosts"][label].as_u64().unwrap() as u32;
                    let host = observed.iter().find(|process| process.pid == pid).expect("Host handle retained before parent death");
                    assert_parent_completion(&host.snapshot());
                }
                return;
            }
            if let Some(child) = &mut direct { child.start_kill().unwrap(); }
            app_command(&mut control, json!({"action":if mode == "sibling" {"fail-web"} else {"stop"}})).await;
            let completion = app_event(&mut control, stop_deadline).await;
            assert_eq!(completion["role"], "completion", "{completion}");
            assert_eq!(completion["code"], if mode == "sibling" {1} else {0});
            let checked_root = if mode == "sibling" {"desktop"} else {"web"};
            assert_eq!(completion["exits"][checked_root], 0, "{completion}");
            assert!(completion["kills"].as_array().unwrap().iter().all(|kill| kill["label"] != checked_root), "Fallback cannot manufacture a pass: {completion}");
            assert!(completion["diagnostics"].as_array().unwrap().iter().all(|line| !line.as_str().unwrap().contains(&format!("cleanup of {checked_root} was not confirmed"))));
            let checked = descendants(&snapshot, event["hosts"][checked_root].as_u64().unwrap() as u32);
            let retained: Vec<_> = observed.iter().filter(|process| checked.contains(&process.pid)).collect();
            assert!(!retained.is_empty());
            eprintln!("Surviving host checkpoint BEFORE runner completion: {completion}; retained={:?}", retained.iter().map(|p| p.snapshot()).collect::<Vec<_>>());
            assert!(retained.iter().all(|process| !process.alive()));
            if mode == "desktop" {
                assert_eq!(completion["exits"]["desktop"], 0);
                assert!(completion["kills"].as_array().unwrap().is_empty());
                assert_ended(&observed);
            }
            if let Some(child) = &mut direct {
                tokio::time::timeout_at(stop_deadline, child.wait()).await.unwrap().unwrap();
                eprintln!("Direct daemon root reaped by creation handle; descendant completion remains unproved");
            }
            app_command(&mut control, json!({"action":"verified"})).await;
            let code = tokio::time::timeout_at(stop_deadline, driver.wait()).await.unwrap().unwrap().code().unwrap();
            assert_eq!(code, if mode == "sibling" {1} else {0});
        }).catch_unwind().await;
        // All success assertions precede this fallback. It runs for EVERY
        // readiness timeout, assertion panic and driver failure, even before IPC.
        let cleanup = cleanup_app_fixture(&mut driver, &mut direct, &observed).await;
        assert!(
            outside.alive(),
            "Fixture cleanup killed an unrelated process"
        );
        outside_stream.write_all(&[1]).await.unwrap();
        assert_eq!(wait(&mut unrelated).await, 0);
        // Preserve the original assertion failure if cleanup also fails.
        if let Err(failure) = &outcome
            && !failure.is::<InjectedReadinessFailure>()
        {
            eprintln!("Fixture cleanup after primary failure: {cleanup:?}");
        }
        if mode == "direct-readiness-failure" {
            let failure = outcome.expect_err("Injected readiness failure was not exercised");
            assert!(
                failure.is::<InjectedReadinessFailure>(),
                "A different failure cannot satisfy the negative control"
            );
            assert!(cleanup.is_ok(), "Fixture cleanup failed: {cleanup:?}");
            assert_ended(&observed);
            for port in failure_ports.unwrap() {
                assert!(
                    TcpStream::connect(("127.0.0.1", port)).await.is_err(),
                    "Fixture left port {port} open"
                );
            }
            let lock = fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(home.join("native-daemon.lock"))
                .unwrap();
            lock.try_lock().expect("Fixture left daemon home locked");
            drop(lock);
            fs::remove_dir_all(&home).unwrap();
            assert!(!home.exists());
            eprintln!(
                "Injected readiness failure reaped the owned direct daemon and web, released both ports/home, and preserved the independent process"
            );
        } else if let Err(failure) = outcome {
            std::panic::resume_unwind(failure);
        } else {
            assert!(cleanup.is_ok(), "Fixture cleanup failed: {cleanup:?}");
        }
    }
}
