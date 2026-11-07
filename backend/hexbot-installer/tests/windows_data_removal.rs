#![cfg(windows)]
//! Actual Windows delete sharing and terminal uninstall, with both locks retained.
use hexbot_installer::{Paths, Target};
use serde_json::json;
use std::{fs, io::Write, path::Path, process::Command};

fn paths(root: &Path) -> Paths {
    let home = root.join("user π");
    Paths {
        hexbot_home: home.join(".hexbot"),
        service_root: root.join("services"),
        apps_override: Some(root.join("apps")),
        opt_override: None,
        service_no_load: true,
        home,
    }
}
fn open_lock(path: &Path) -> fs::File {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
        .unwrap()
}
fn uninstall(paths: &Paths, remove: bool) -> std::process::Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_hexbot-install"));
    command.args(["--uninstall", "--yes", "--json"]);
    if remove {
        command.arg("--remove-data");
    }
    command
        .env("HEXBOT_HOME", &paths.hexbot_home)
        .env("HOME", &paths.home)
        .env("USERPROFILE", &paths.home)
        .env("HEXBOT_SERVICE_ROOT", &paths.service_root)
        .env(
            "HEXBOT_INSTALL_APPS_DIR",
            paths.apps_override.as_ref().unwrap(),
        )
        .env("HEXBOT_SERVICE_NO_LOAD", "1")
        .env("HEXBOT_CLI_NO_PATH", "1")
        .env("HEXBOT_UPDATE_URL", "file:///must-not-download")
        .output()
        .unwrap()
}
fn data(paths: &Paths) {
    fs::create_dir_all(paths.hexbot_home.join("runtime")).unwrap();
    fs::write(
        paths.hexbot_home.join("user-data.txt"),
        "keep unless requested",
    )
    .unwrap();
    fs::write(paths.receipt(), json!({"option":"headless","channel":"stable","version":"1.0.0","paths":[],"installedAt":"fixture"}).to_string()).unwrap();
}
#[test]
fn windows_default_share_delete_removes_home_while_both_file_locks_are_retained() {
    let root = tempfile::tempdir().unwrap();
    let paths = paths(root.path());
    data(&paths);
    let installation = open_lock(&paths.installer_lock(Target::WindowsX86_64));
    let daemon = open_lock(&paths.hexbot_home.join("native-daemon.lock"));
    installation.try_lock().unwrap();
    daemon.try_lock().unwrap();
    for path in [
        paths.installer_lock(Target::WindowsX86_64),
        paths.hexbot_home.join("native-daemon.lock"),
    ] {
        assert!(matches!(
            open_lock(&path).try_lock(),
            Err(fs::TryLockError::WouldBlock)
        ));
    }
    // std::OpenOptions defaults include FILE_SHARE_DELETE. LockFileEx locks
    // bytes, not directory entries. Do not drop either lock to permit deletion.
    fs::remove_dir_all(&paths.hexbot_home).unwrap();
    assert!(!paths.hexbot_home.exists());
    assert!(daemon.metadata().unwrap().is_file());
    assert!(matches!(
        open_lock(&paths.installer_lock(Target::WindowsX86_64)).try_lock(),
        Err(fs::TryLockError::WouldBlock)
    ));
    eprintln!(
        "Windows retained locks: homeGone=true daemonHandleStillValid=true installerStillExcluded=true"
    );
}
#[test]
fn terminal_uninstall_delete_data_and_keep_data_preserve_live_foreign_lock() {
    for remove in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let paths = paths(root.path());
        data(&paths);
        let original_receipt = fs::read(paths.receipt()).unwrap();
        let mut daemon = open_lock(&paths.hexbot_home.join("native-daemon.lock"));
        write!(daemon, "{}", std::process::id()).unwrap();
        daemon.flush().unwrap();
        daemon.try_lock().unwrap();
        let record =
            json!({"pid":std::process::id(),"executable":std::env::current_exe().unwrap()});
        fs::write(
            paths.hexbot_home.join("runtime/native-running.json"),
            record.to_string(),
        )
        .unwrap();
        let refused = uninstall(&paths, remove);
        eprintln!(
            "Windows uninstall foreign lock: removeData={remove} status={} stdout={} stderr={}",
            refused.status,
            String::from_utf8_lossy(&refused.stdout),
            String::from_utf8_lossy(&refused.stderr)
        );
        assert!(!refused.status.success());
        assert!(!String::from_utf8_lossy(&refused.stdout).contains("\"stage\":\"done\""));
        assert_eq!(fs::read(paths.receipt()).unwrap(), original_receipt);
        assert_eq!(
            fs::read_to_string(paths.hexbot_home.join("user-data.txt")).unwrap(),
            "keep unless requested"
        );
        assert_eq!(
            fs::read_to_string(paths.hexbot_home.join("runtime/native-running.json")).unwrap(),
            record.to_string()
        );
        drop(daemon); // Only the test's explicitly owned foreign process releases it.
        let output = uninstall(&paths, remove);
        eprintln!(
            "Windows uninstall free lock: removeData={remove} status={} stdout={} stderr={}",
            output.status,
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(output.status.success());
        assert!(String::from_utf8_lossy(&output.stdout).contains("\"stage\":\"done\""));
        assert!(!paths.receipt().exists());
        if remove {
            assert!(!paths.hexbot_home.exists());
        } else {
            assert_eq!(
                fs::read_to_string(paths.hexbot_home.join("user-data.txt")).unwrap(),
                "keep unless requested"
            );
        }
    }
}
