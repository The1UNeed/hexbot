#![cfg(all(windows, not(debug_assertions)))]
use std::process::Command;

#[test]
fn release_daemon_has_no_dev_child_action() {
    let root = tempfile::tempdir().unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_hexbot"))
        .args(["__dev-child", "web", "--", "C:\\does-not-exist.exe"])
        .env("HEXBOT_HOME", root.path().join("state"))
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(!String::from_utf8_lossy(&output.stderr).contains("Dev host"));
    let output = Command::new(env!("CARGO_BIN_EXE_hexbot"))
        .arg("--help")
        .output()
        .unwrap();
    assert!(!String::from_utf8_lossy(&output.stdout).contains("__dev-child"));
}
