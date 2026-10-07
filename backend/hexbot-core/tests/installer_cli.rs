use serde_json::Value;
use std::process::{Command, Output};

fn run(home: &std::path::Path, user: &std::path::Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_hexbot"))
        .args(args)
        .env("HEXBOT_HOME", home)
        .env("HOME", user)
        .env("HEXBOT_SERVICE_ROOT", user.join("services"))
        .env("HEXBOT_SERVICE_NO_LOAD", "1")
        .output()
        .unwrap()
}
#[test]
fn isolated_service_and_offline_status() {
    let home = tempfile::tempdir().unwrap();
    let user = tempfile::tempdir().unwrap();
    let output = run(home.path(), user.path(), &["service", "install"]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let output = run(home.path(), user.path(), &["service", "status", "--json"]);
    let status: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(status["installed"], true);
    assert_eq!(status["running"], false);
    assert!(
        std::path::Path::new(status["file"].as_str().unwrap())
            .starts_with(user.path().join("services"))
    );
    let output = run(home.path(), user.path(), &["status", "--json"]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let status: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(status["running"], false);
    assert!(status["lan_addresses"].is_array());
    assert!(status["sandbox_available"].is_boolean());
    assert_eq!(status["service"]["installed"], true);
    assert!(!home.path().join("hexbot.db").exists());
    for action in ["start", "stop", "restart", "uninstall"] {
        assert!(
            run(home.path(), user.path(), &["service", action])
                .status
                .success()
        );
    }
}
#[test]
fn setup_errors_are_ndjson_and_do_not_write_a_wrapper() {
    let home = tempfile::tempdir().unwrap();
    let user = tempfile::tempdir().unwrap();
    for args in [
        vec!["setup", "--invalid", "--json"],
        vec!["setup", "--activate", "--no-code-tools", "--json"],
    ] {
        let output = run(home.path(), user.path(), &args);
        assert!(!output.status.success());
        let lines: Vec<Value> = String::from_utf8(output.stdout)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(lines.last().unwrap()["stage"], "error");
        assert!(!user.path().join(".local/bin/hexbot").exists());
    }
}
#[test]
fn lan_access_turns_on_and_off_without_a_daemon() {
    let home = tempfile::tempdir().unwrap();
    let user = tempfile::tempdir().unwrap();
    for (action, expected) in [("on", true), ("off", false)] {
        let output = run(home.path(), user.path(), &["lan", action]);
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(stdout.starts_with(&format!("LAN access is {action}.\n")));
        assert_eq!(
            stdout.contains("does not encrypt sign-ins or chat"),
            expected
        );
        let output = run(home.path(), user.path(), &["status", "--json"]);
        let status: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(status["lan_enabled"], expected);
    }
}
