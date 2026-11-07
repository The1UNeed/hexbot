//! Exercise the actual terminal error streams without reaching destructive work.
use serde_json::json;
use std::{
    fs,
    process::{Command, Stdio},
};

#[test]
fn unconfirmed_uninstall_preserves_state_and_reports_json_or_plain_error() {
    let root = tempfile::tempdir().unwrap();
    let home = root.path().join("user π");
    let state = home.join(".hexbot");
    fs::create_dir_all(&state).unwrap();
    let receipt = json!({"option":"headless","channel":"nightly","version":"1.0.0-nightly.1",
        "paths":[],"installedAt":"fixture"})
    .to_string();
    fs::write(state.join("install.json"), &receipt).unwrap();
    fs::write(state.join("user-data.txt"), "retain on cancellation").unwrap();
    let message = "Uninstall cancelled. Use --yes to confirm in a script.";
    for json in [true, false] {
        let mut command = Command::new(env!("CARGO_BIN_EXE_hexbot-install"));
        command.arg("--uninstall");
        if json {
            command.arg("--json");
        }
        let output = command
            .env("HEXBOT_HOME", &state)
            .env("HOME", &home)
            .env("USERPROFILE", &home)
            .env("HEXBOT_INSTALL_APPS_DIR", root.path().join("apps"))
            .env("HEXBOT_SERVICE_ROOT", root.path().join("service"))
            .env("HEXBOT_SERVICE_NO_LOAD", "1")
            .env("HEXBOT_UPDATE_URL", "http://127.0.0.1:1")
            .stdin(Stdio::null())
            .output()
            .unwrap();
        eprintln!(
            "CLI cancellation json={json} status={} stdout={} stderr={}",
            output.status,
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(output.status.code(), Some(1));
        if json {
            // Exact parsing also refuses extra done events or non-JSON output.
            assert_eq!(
                serde_json::from_slice::<serde_json::Value>(&output.stdout).unwrap(),
                json!({"stage":"error","message":message})
            );
            assert!(output.stderr.is_empty());
        } else {
            assert!(output.stdout.is_empty());
            assert_eq!(String::from_utf8(output.stderr).unwrap().trim(), message);
        }
        assert_eq!(
            fs::read_to_string(state.join("install.json")).unwrap(),
            receipt
        );
        assert_eq!(
            fs::read_to_string(state.join("user-data.txt")).unwrap(),
            "retain on cancellation"
        );
        assert!(!root.path().join("apps").exists());
        assert!(!root.path().join("service").exists());
        assert!(!state.join("runtime").exists());
    }
}
