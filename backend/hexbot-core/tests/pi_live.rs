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
    let mut message_count = ready.data.as_ref().unwrap()["messageCount"].clone();
    for key in [Some("original"), Some("rotated"), None, Some("reconnected")] {
        match key {
            Some(key) => providers::set_key(home.path(), "openai", key).unwrap(),
            None => providers::clear_key(home.path(), "openai").unwrap(),
        };
        let message = format!("Reply ok for {}", key.unwrap_or("disconnected"));
        let reply = process
            .request(
                json!({"type":"prompt","message":message}),
                Duration::from_secs(30),
            )
            .await
            .unwrap();
        if reply.success {
            assert_eq!(reply.data.as_ref().unwrap()["disposition"], "started");
            let assistant = tokio::time::timeout(Duration::from_secs(30), async {
                let mut started = false;
                let mut user_seen = false;
                let mut assistant = None;
                loop {
                    let event = events.recv().await.unwrap();
                    match event["type"].as_str() {
                        Some("agent_start") => {
                            assert!(!started, "duplicate agent_start: {event}");
                            started = true;
                        }
                        Some("message_end") if event["message"]["role"] == "user" => {
                            assert!(started && !user_seen, "unexpected user message: {event}");
                            assert_eq!(
                                event["message"]["content"],
                                json!([{"type":"text","text":message}])
                            );
                            user_seen = true;
                        }
                        Some("message_end") if event["message"]["role"] == "assistant" => {
                            assert!(user_seen, "assistant before current prompt: {event}");
                            assert!(assistant.replace(event["message"].clone()).is_none());
                        }
                        Some("agent_settled") => {
                            assert!(
                                started && user_seen,
                                "settled before current prompt: {event}"
                            );
                            break assistant.expect("assistant terminal message before settlement");
                        }
                        _ => {}
                    }
                }
            })
            .await
            .unwrap();
            assert_eq!(assistant["provider"], "openai");
            assert_eq!(assistant["model"], "fixture");
            if key.is_some() {
                assert_eq!(assistant["stopReason"], "stop", "{assistant}");
                assert_eq!(assistant["content"], json!([{"type":"text","text":"ok"}]));
            } else {
                // Pi's cached auth snapshot can accept preflight before request-time
                // credential loading notices the disconnect. No HTTP request may follow.
                assert_eq!(assistant["stopReason"], "error", "{assistant}");
                assert_eq!(
                    assistant["errorMessage"],
                    "Provider is not configured: openai"
                );
            }
        } else {
            // An up-to-date auth snapshot refuses preflight without starting a turn,
            // so there is no agent_settled event to wait for in this case.
            assert!(key.is_none(), "{reply:?}");
            assert_eq!(
                reply.error.as_deref().unwrap().lines().next(),
                Some("No API key found for openai."),
                "{reply:?}"
            );
        }
        // A correlated RPC after the terminal response/events orders the next phase
        // after this one, including Pi's agent_settled callbacks.
        let state = process
            .request(json!({"type":"get_state"}), Duration::from_secs(30))
            .await
            .unwrap();
        assert!(state.success, "{state:?}");
        let state = state.data.unwrap();
        assert_eq!(
            state["sessionId"],
            ready.data.as_ref().unwrap()["sessionId"]
        );
        assert_eq!(state["isStreaming"], false);
        assert_eq!(state["isCompacting"], false);
        assert_eq!(state["pendingMessageCount"], 0);
        if !reply.success {
            assert_eq!(state["messageCount"], message_count);
        }
        message_count = state["messageCount"].clone();
        if let Some(key) = key {
            assert_eq!(received.try_recv().unwrap(), format!("Bearer {key}"));
        }
        assert_eq!(
            received.try_recv(),
            Err(tokio::sync::mpsc::error::TryRecvError::Empty),
            "unexpected provider request after {message}"
        );
    }
    process.shutdown().await.unwrap();
    server.abort();
}
