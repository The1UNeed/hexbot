#![cfg(unix)]
//! Rust recovery orchestration with a scheduler response fixture. Actual COM
//! ownership/action validation is exercised separately on native Windows.
use std::{fs, os::unix::fs::PermissionsExt, process::Command};

#[test]
fn missing_script_status_uses_the_remaining_scheduler_context() {
    let root = tempfile::tempdir().unwrap();
    let home = root.path().join("state");
    fs::create_dir(&home).unwrap();
    let bin = root.path().join("bin");
    fs::create_dir(&bin).unwrap();
    let ps = bin.join("powershell.exe");
    fs::write(&ps, "#!/bin/sh\nprintf '3\\n'\n").unwrap();
    fs::set_permissions(&ps, fs::Permissions::from_mode(0o755)).unwrap();
    let path = std::env::join_paths(std::iter::once(bin).chain(std::env::split_paths(
        &std::env::var_os("PATH").unwrap_or_default(),
    )))
    .unwrap();
    let output = Command::new(std::env::current_exe().unwrap())
        .args([
            "--ignored",
            "--exact",
            "scheduler_status_fixture",
            "--nocapture",
        ])
        .env("PATH", path)
        .env("HEXBOT_SERVICE_ROOT", root.path())
        .env("HEXBOT_TEST_RECOVERY_HOME", &home)
        .env_remove("HEXBOT_SERVICE_NO_LOAD")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}
#[tokio::test]
#[ignore = "isolated scheduler response subprocess"]
async fn scheduler_status_fixture() {
    let home = std::path::PathBuf::from(std::env::var_os("HEXBOT_TEST_RECOVERY_HOME").unwrap());
    let status = hexbot_core::windows_service::status(&home).await.unwrap();
    assert_eq!(status["installed"], true);
    assert_eq!(status["running"], false);
}
