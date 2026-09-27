//! Explicitly opt-in: exercises the pinned Pi package without provider calls.

use std::{fs, time::Duration};

use hexbot_core::pi::{PiOptions, PiProcess};
use serde_json::json;

#[tokio::test]
#[ignore = "requires HEXBOT_TEST_PI pointing to the Pi 0.87.1 executable"]
async fn pinned_pi_accepts_commands_in_an_isolated_home() {
    let executable =
        std::env::var_os("HEXBOT_TEST_PI").expect("set HEXBOT_TEST_PI to the Pi 0.87.1 executable");
    let version = std::process::Command::new(&executable)
        .arg("--version")
        .output()
        .expect("start Pi");
    assert!(version.status.success());
    assert_eq!(String::from_utf8_lossy(&version.stdout).trim(), "0.87.1");
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
