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
        assert_ne!(
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
