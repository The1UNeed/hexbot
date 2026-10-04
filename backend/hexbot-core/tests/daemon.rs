//! Exercise the actual entry point, including listener replacement and child cleanup.
use futures_util::{SinkExt, StreamExt};
use hexbot_core::auth;
use serde_json::{Value, json};
use std::{path::Path, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{Child, ChildStdout, Command},
};
use tokio_tungstenite::{connect_async, tungstenite::Message};

async fn ready(output: &mut BufReader<ChildStdout>) -> u16 {
    tokio::time::timeout(Duration::from_secs(15), async {
        let mut line = String::new();
        loop {
            line.clear();
            assert!(
                output.read_line(&mut line).await.unwrap() > 0,
                "daemon ended before ready"
            );
            if let Some(port) = line.trim().strip_prefix("HERMES_BACKEND_READY port=") {
                return port.parse().unwrap();
            }
        }
    })
    .await
    .expect("daemon readiness deadline")
}
fn start(home: &Path) -> Child {
    Command::new(env!("CARGO_BIN_EXE_hexbot"))
        .args(["serve", "--port", "0"])
        .env("HEXBOT_HOME", home)
        .env_remove("HERMES_HOME")
        .env("HEXBOT_PI_EXECUTABLE", "/usr/bin/false")
        .env_remove("HEXBOT_PORT")
        .env_remove("HEXBOT_SUPERVISOR")
        .kill_on_drop(true)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::inherit())
        .spawn()
        .unwrap()
}
#[tokio::test]
#[cfg(unix)]
async fn listener_restart_single_owner_and_graceful_shutdown() {
    let home = tempfile::tempdir().unwrap();
    let mut child = start(home.path());
    let mut output = BufReader::new(child.stdout.take().unwrap());
    let port = ready(&mut output).await;
    let service_root = tempfile::tempdir().unwrap();
    let status = Command::new(env!("CARGO_BIN_EXE_hexbot"))
        .args(["status", "--json"])
        .env("HEXBOT_HOME", home.path())
        .env("HEXBOT_SERVICE_ROOT", service_root.path())
        .env("HEXBOT_SERVICE_NO_LOAD", "1")
        .env_remove("HEXBOT_PORT")
        .output()
        .await
        .unwrap();
    assert!(
        status.status.success(),
        "{}",
        String::from_utf8_lossy(&status.stderr)
    );
    let status: Value = serde_json::from_slice(&status.stdout).unwrap();
    assert_eq!(status["running"], true);
    assert_eq!(status["version"], hexbot_core::version());
    assert_eq!(status["port"], port);
    assert_eq!(status["service"]["installed"], false);
    let token = auth::local_token(home.path()).unwrap();
    let (mut socket, _) = connect_async(format!("ws://127.0.0.1:{port}/api/ws?token={token}"))
        .await
        .unwrap();
    let initial: Value = serde_json::from_str(
        socket
            .next()
            .await
            .unwrap()
            .unwrap()
            .to_text()
            .unwrap()
            .trim(),
    )
    .unwrap();
    assert_eq!(initial["params"]["type"], "gateway.ready");
    let duplicate = Command::new(env!("CARGO_BIN_EXE_hexbot"))
        .args(["serve", "--port", "0"])
        .env("HEXBOT_HOME", home.path())
        .env("HEXBOT_PI_EXECUTABLE", "/usr/bin/false")
        .output()
        .await
        .unwrap();
    assert!(!duplicate.status.success());
    assert!(String::from_utf8_lossy(&duplicate.stderr).contains("already owns"));
    for (id, lan) in [(1, true), (2, false)] {
        socket.send(Message::Text(json!({"jsonrpc":"2.0","id":id,"method":"hexbot.network.set","params":{"lan_enabled":lan}}).to_string().into())).await.unwrap();
        tokio::time::timeout(Duration::from_secs(10), async {
            let mut reply = false;
            while let Some(message) = socket.next().await {
                match message.unwrap() {
                    Message::Close(close) => {
                        assert_eq!(u16::from(close.unwrap().code), 1012);
                        assert!(reply);
                        return;
                    }
                    Message::Text(text) => {
                        for line in text.lines() {
                            let frame: Value = serde_json::from_str(line).unwrap();
                            if frame["id"] == id {
                                assert_eq!(frame["result"]["restarting"], true);
                                reply = true;
                            }
                        }
                    }
                    _ => {}
                }
            }
            panic!("socket ended without restart close");
        })
        .await
        .unwrap();
        assert_eq!(ready(&mut output).await, port);
        let (connected, _) = connect_async(format!("ws://127.0.0.1:{port}/api/ws?token={token}"))
            .await
            .unwrap();
        socket = connected;
        let frame: Value = serde_json::from_str(
            socket
                .next()
                .await
                .unwrap()
                .unwrap()
                .to_text()
                .unwrap()
                .trim(),
        )
        .unwrap();
        // Bots and their event log survive a LAN change, so clients replay from it.
        assert_eq!(
            frame["params"]["payload"]["replay_epoch"],
            initial["params"]["payload"]["replay_epoch"]
        );
        let state: Value =
            serde_json::from_slice(&std::fs::read(home.path().join("serve-state.json")).unwrap())
                .unwrap();
        assert_eq!(state["host"], if lan { "0.0.0.0" } else { "127.0.0.1" });
    }
    // Leave a WebSocket open: graceful shutdown must actively close it.
    unsafe {
        libc::kill(child.id().unwrap() as i32, libc::SIGTERM);
    }
    let status = tokio::time::timeout(Duration::from_secs(10), child.wait())
        .await
        .unwrap()
        .unwrap();
    assert!(status.success());
    assert!(!home.path().join("serve-state.json").exists());
    let mut restarted = start(home.path());
    let mut output = BufReader::new(restarted.stdout.take().unwrap());
    ready(&mut output).await;
    unsafe {
        libc::kill(restarted.id().unwrap() as i32, libc::SIGTERM);
    }
    assert!(
        tokio::time::timeout(Duration::from_secs(10), restarted.wait())
            .await
            .unwrap()
            .unwrap()
            .success()
    );
}
/// Only a hand-started daemon prints the link: the app signs itself in with the
/// private token file, and a log file must not hold a usable code.
#[tokio::test]
#[cfg(unix)]
async fn serve_keeps_sign_in_links_out_of_pipes_and_supervisor_logs() {
    async fn ready_with_link(output: &mut BufReader<ChildStdout>) -> (u16, Option<String>) {
        tokio::time::timeout(Duration::from_secs(15), async {
            let mut link = None;
            let mut line = String::new();
            loop {
                line.clear();
                assert!(
                    output.read_line(&mut line).await.unwrap() > 0,
                    "daemon ended before ready"
                );
                if let Some(url) = line.trim().strip_prefix("Sign in: ") {
                    link = Some(url.to_owned());
                }
                if let Some(port) = line.trim().strip_prefix("HERMES_BACKEND_READY port=") {
                    return (port.parse().unwrap(), link);
                }
            }
        })
        .await
        .expect("daemon readiness deadline")
    }
    let home = tempfile::tempdir().unwrap();
    let mut child = start(home.path());
    let mut output = BufReader::new(child.stdout.take().unwrap());
    let (port, link) = ready_with_link(&mut output).await;
    assert_eq!(link, None, "piped stdout must not hold a sign-in code");
    assert!(port > 0);
    unsafe {
        libc::kill(child.id().unwrap() as i32, libc::SIGTERM);
    }
    assert!(child.wait().await.unwrap().success());
    let supervised = tempfile::tempdir().unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_hexbot"))
        .args(["serve", "--port", "0"])
        .env("HEXBOT_HOME", supervised.path())
        .env_remove("HERMES_HOME")
        .env("HEXBOT_PI_EXECUTABLE", "/usr/bin/false")
        .env_remove("HEXBOT_PORT")
        .env("HEXBOT_SUPERVISOR", "service")
        .kill_on_drop(true)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::inherit())
        .spawn()
        .unwrap();
    let mut output = BufReader::new(child.stdout.take().unwrap());
    let (_, link) = ready_with_link(&mut output).await;
    assert_eq!(link, None);
    unsafe {
        libc::kill(child.id().unwrap() as i32, libc::SIGTERM);
    }
    assert!(child.wait().await.unwrap().success());
}
#[test]
fn product_version_and_cli_errors_are_consistent() {
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_hexbot"))
        .arg("--version")
        .output()
        .unwrap();
    assert!(output.status.success());
    assert_eq!(
        String::from_utf8(output.stdout).unwrap().trim(),
        hexbot_core::version()
    );
    let home = tempfile::tempdir().unwrap();
    for args in [
        vec!["serve", "--port", "not-a-number"],
        vec!["serve", "--lan", "--no-lan"],
        vec!["pair", "unexpected"],
        vec!["version", "unexpected"],
        vec!["rooms", "list", "unexpected"],
    ] {
        let output = std::process::Command::new(env!("CARGO_BIN_EXE_hexbot"))
            .args(&args)
            .env("HEXBOT_HOME", home.path())
            .output()
            .unwrap();
        assert!(!output.status.success(), "accepted {args:?}");
    }
    assert!(!home.path().join("hexbot.db").exists());
}

/// A PTY exercises IsTerminal without storing a live-install credential.
#[tokio::test]
#[cfg(unix)]
async fn terminal_startup_link_preserves_pair_codes_and_mint_failure_keeps_serving() {
    const TERMINAL: &str = r#"
import os, pty, select, subprocess, sys, time
master, slave = pty.openpty()
child = subprocess.Popen([sys.argv[1], 'serve', '--port', '0'], stdout=slave, stderr=subprocess.PIPE)
os.close(slave)
try:
    output = b''
    deadline = time.monotonic() + 15
    while b'HERMES_BACKEND_READY' not in output:
        remaining = deadline - time.monotonic()
        if remaining <= 0 or not select.select([master], [], [], remaining)[0]:
            raise RuntimeError('daemon did not become ready')
        output += os.read(master, 65536)
    os.write(1, output.replace(b'\r\n', b'\n'))
    sys.stdin.readline()
finally:
    child.terminate()
    _, error = child.communicate(timeout=10)
    os.write(2, error)
    os.close(master)
sys.exit(child.returncode)
"#;
    for fail in [false, true] {
        let home = tempfile::tempdir().unwrap();
        let pair = auth::new_code(home.path(), "local").unwrap();
        if fail {
            hexbot_core::db::open(home.path()).unwrap().execute_batch(
                "CREATE TRIGGER refuse_code BEFORE INSERT ON pairing_codes BEGIN SELECT RAISE(ABORT, 'mint failed'); END;"
            ).unwrap();
        }
        let mut child = Command::new("python3")
            .args(["-c", TERMINAL, env!("CARGO_BIN_EXE_hexbot")])
            .env("HEXBOT_HOME", home.path())
            .env("HEXBOT_PI_EXECUTABLE", "/usr/bin/false")
            .env("XPC_SERVICE_NAME", "0")
            .env_remove("HERMES_HOME")
            .env_remove("HEXBOT_PORT")
            .env_remove("HEXBOT_SUPERVISOR")
            .env_remove("INVOCATION_ID")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let mut output = BufReader::new(child.stdout.take().unwrap());
        let text = tokio::time::timeout(Duration::from_secs(20), async {
            let mut text = String::new();
            loop {
                let mut line = String::new();
                assert!(output.read_line(&mut line).await.unwrap() > 0);
                text.push_str(&line);
                if line.starts_with("HERMES_BACKEND_READY") {
                    return text;
                }
            }
        })
        .await
        .unwrap();
        let port = text
            .lines()
            .find_map(|line| line.strip_prefix("HERMES_BACKEND_READY port="))
            .unwrap();
        let link = text.lines().find_map(|line| line.strip_prefix("Sign in: "));
        assert_eq!(link.is_none(), fail, "{text}");
        if let Some(link) = link {
            assert!(link.starts_with(&format!("http://127.0.0.1:{port}/login?code=")));
            assert!(text.contains(
                "The link works once and expires in 10 minutes. Run `hexbot pair` for a new code."
            ));
            let client = reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .unwrap();
            assert_eq!(client.get(link).send().await.unwrap().status(), 303);
        }
        // The server is ready in either case, and the previous code still works.
        assert!(
            auth::redeem_code_from(
                home.path(),
                pair["code"].as_str().unwrap(),
                "Phone",
                "browser",
                "local",
                None
            )
            .is_ok()
        );
        use tokio::io::AsyncWriteExt;
        child
            .stdin
            .take()
            .unwrap()
            .write_all(b"stop\n")
            .await
            .unwrap();
        let result = tokio::time::timeout(Duration::from_secs(15), child.wait_with_output())
            .await
            .unwrap()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        if fail {
            assert!(String::from_utf8_lossy(&result.stderr).contains("Sign-in link:"));
        }
    }
}
