//! Explicitly opt-in: exercises the pinned Pi package without provider calls.

use std::{fs, time::Duration};

use hexbot_core::pi::{PiOptions, PiProcess};
use serde_json::json;

#[tokio::test]
#[ignore = "requires HEXBOT_TEST_PI pointing to the Pi 1.0.1 executable"]
async fn pinned_pi_accepts_commands_in_an_isolated_home() {
    let executable =
        std::env::var_os("HEXBOT_TEST_PI").expect("set HEXBOT_TEST_PI to the Pi 1.0.1 executable");
    let version = std::process::Command::new(&executable)
        .arg("--version")
        .output()
        .expect("start Pi");
    assert!(version.status.success());
    assert_eq!(String::from_utf8_lossy(&version.stdout).trim(), "1.0.1");
    let dir = tempfile::tempdir().unwrap();
    let cwd = dir.path().join("work");
    let agent_home = dir.path().join("agent");
    fs::create_dir(&cwd).unwrap();
    fs::create_dir(&agent_home).unwrap();
    let mut options = PiOptions::new(executable, cwd, agent_home);
    options.args = [
        "--mode",
        "rpc",
        "--no-session",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--no-tools",
    ]
    .iter()
    .map(|arg| (*arg).to_owned())
    .collect();
    let (process, _events) = PiProcess::spawn(options).unwrap();
    for command in ["get_state", "get_messages", "get_session_stats"] {
        let response = process
            .request(json!({"type":command}), Duration::from_secs(30))
            .await
            .expect("Pi command response");
        assert!(response.success, "{response:?}");
        assert_eq!(response.command, command);
        assert!(response.data.is_some());
    }
    process.shutdown().await.unwrap();
}

#[tokio::test]
#[ignore = "requires HEXBOT_TEST_PI pointing to the pinned Pi executable"]
async fn running_pi_section_reloads_rotated_and_disconnected_credentials() {
    use axum::{Router, http::HeaderMap, routing::post};
    use hexbot_core::{common, db, providers};
    let home = tempfile::tempdir().unwrap();
    db::migrate(home.path()).unwrap();
    let agent_home = home.path().join("profiles/owl/pi");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    let (sent, mut received) = tokio::sync::mpsc::unbounded_channel();
    let app = Router::new().route("/v1/chat/completions", post(move |headers: HeaderMap| {
        sent.send(headers["authorization"].to_str().unwrap().to_owned()).unwrap();
        async {
            let chunk = json!({"id":"reply","object":"chat.completion.chunk","created":1,"model":"fixture","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":"stop"}]});
            ([("content-type", "text/event-stream")], format!("data: {chunk}\n\ndata: [DONE]\n\n"))
        }
    }));
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    common::write_config(
        home.path(),
        &json!({"model":{"provider":"openai-api","default":"fixture","base_url":base}}),
    )
    .unwrap();
    providers::set_key(home.path(), "openai", "original").unwrap();
    providers::prepare_pi_for_bot(home.path(), "owl", &agent_home).unwrap();
    fs::write(agent_home.join("models.json"), json!({"providers":{"openai":{"baseUrl":base,"api":"openai-completions","models":[{"id":"fixture","name":"fixture","reasoning":false,"input":["text"],"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0},"contextWindow":32768,"maxTokens":1024}]}}}).to_string()).unwrap();
    let executable = std::env::var_os("HEXBOT_TEST_PI").expect("set HEXBOT_TEST_PI");
    let mut options = PiOptions::new(executable, home.path(), &agent_home);
    options.args = [
        "--mode",
        "rpc",
        "--no-session",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--no-tools",
        "--provider",
        "openai",
        "--model",
        "fixture",
    ]
    .iter()
    .map(|s| (*s).to_owned())
    .collect();
    let (process, mut events) = PiProcess::spawn(options).unwrap();
    let ready = process
        .request(json!({"type":"get_state"}), Duration::from_secs(30))
        .await
        .unwrap();
    assert!(ready.success, "{ready:?}");
    for key in [Some("original"), Some("rotated"), None, Some("reconnected")] {
        match key {
            Some(key) => providers::set_key(home.path(), "openai", key).unwrap(),
            None => providers::clear_key(home.path(), "openai").unwrap(),
        };
        let reply = process
            .request(
                json!({"type":"prompt","message":"Reply ok"}),
                Duration::from_secs(30),
            )
            .await
            .unwrap();
        assert!(reply.success, "{reply:?}");
        tokio::time::timeout(Duration::from_secs(30), async {
            loop {
                if events.recv().await.unwrap()["type"] == "agent_settled" {
                    break;
                }
            }
        })
        .await
        .unwrap();
        if let Some(key) = key {
            assert_eq!(received.try_recv().unwrap(), format!("Bearer {key}"));
        } else {
            assert!(
                received.try_recv().is_err(),
                "disconnected section must not send a provider request"
            );
        }
    }
    process.shutdown().await.unwrap();
    server.abort();
}
