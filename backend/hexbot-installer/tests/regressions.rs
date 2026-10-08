mod common;
use common::*;
use hexbot_installer::{
    Artifacts, InstallOption, Installer, Manifest, Receipt, Target, Track, fetch_manifest,
};
use std::{
    fs,
    os::{fd::AsRawFd, unix::fs::symlink},
    path::Path,
    process::Command,
};

fn engine(root: &Path) -> Installer {
    Installer {
        paths: paths(root),
        target: Target::LinuxX86_64,
        base_url: "http://127.0.0.1:1".into(),
    }
}
fn service(engine: &Installer, owner: &Path) {
    let file = engine.paths.service_file(engine.target);
    fs::create_dir_all(file.parent().unwrap()).unwrap();
    fs::write(
        file,
        format!(
            "Environment=HEXBOT_HOME=\"{}\"\nExecStart=\"{}/runtime/native-executable\" serve\n",
            owner.display(),
            owner.display()
        ),
    )
    .unwrap();
}

#[test]
fn uninstall_rejects_symlinked_runtime_ancestors_and_targets() {
    for relative in [
        "runtime",
        "runtime/native",
        "runtime/native-current.json",
        "install.json",
    ] {
        let temp = tempfile::tempdir().unwrap();
        let engine = engine(temp.path());
        let outside = temp.path().join("outside");
        fs::create_dir_all(outside.join("native")).unwrap();
        fs::write(outside.join("native/keep"), "keep").unwrap();
        fs::write(outside.join("native-current.json"), "keep").unwrap();
        let link = engine.paths.hexbot_home.join(relative);
        fs::create_dir_all(link.parent().unwrap()).unwrap();
        symlink(&outside, &link).unwrap();
        for data in [false, true] {
            assert!(
                engine
                    .uninstall(data, &mut |_| {})
                    .unwrap_err()
                    .to_string()
                    .contains("symlink")
            );
            assert_eq!(
                fs::read_to_string(outside.join("native/keep")).unwrap(),
                "keep"
            );
            assert!(fs::symlink_metadata(&link).is_ok());
        }
    }
}

#[test]
fn foreign_service_and_wrapper_survive_uninstall() {
    let temp = tempfile::tempdir().unwrap();
    let engine = engine(temp.path());
    let other = temp.path().join("other-home");
    fs::create_dir_all(&other).unwrap();
    service(&engine, &other);
    let before = fs::read(engine.paths.service_file(engine.target)).unwrap();
    assert!(!engine.detect().unwrap().service);
    engine.uninstall(false, &mut |_| {}).unwrap();
    assert_eq!(
        fs::read(engine.paths.service_file(engine.target)).unwrap(),
        before
    );
    assert!(!engine.paths.apps_override.as_ref().unwrap().exists());
    fs::remove_file(engine.paths.service_file(engine.target)).unwrap();
    fs::create_dir_all(engine.paths.wrapper().parent().unwrap()).unwrap();
    let wrapper = format!(
        "#!/bin/sh\n# Hexbot CLI, written by hexbot setup\nexport HEXBOT_HOME='{}'\n",
        other.display()
    );
    fs::write(engine.paths.wrapper(), &wrapper).unwrap();
    engine.uninstall(false, &mut |_| {}).unwrap();
    assert_eq!(fs::read_to_string(engine.paths.wrapper()).unwrap(), wrapper);
}

#[test]
fn broken_or_missing_runtime_pointer_does_not_block_service_removal() {
    for broken in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let engine = engine(temp.path());
        fs::create_dir_all(engine.paths.hexbot_home.join("runtime")).unwrap();
        if broken {
            symlink("native/missing/hexbot", engine.paths.executable()).unwrap();
        }
        service(&engine, &engine.paths.hexbot_home);
        fs::write(engine.paths.hexbot_home.join("memory.txt"), "keep").unwrap();
        engine.uninstall(false, &mut |_| {}).unwrap();
        assert!(!engine.paths.service_file(engine.target).exists());
        assert!(fs::symlink_metadata(engine.paths.executable()).is_err());
        assert!(engine.paths.hexbot_home.join("memory.txt").exists());
    }
}

#[test]
fn live_unverified_daemon_refuses_uninstall_without_removing_runtime() {
    let temp = tempfile::tempdir().unwrap();
    let engine = engine(temp.path());
    fs::create_dir_all(engine.paths.hexbot_home.join("runtime/native/one")).unwrap();
    fs::write(
        engine.paths.hexbot_home.join("runtime/native/one/hexbot"),
        "keep",
    )
    .unwrap();
    fs::write(
        engine.paths.hexbot_home.join("runtime/native-running.json"),
        serde_json::json!({"pid":std::process::id(),"executable":std::env::current_exe().unwrap()})
            .to_string(),
    )
    .unwrap();
    let lock = fs::File::create(engine.paths.hexbot_home.join("native-daemon.lock")).unwrap();
    assert_eq!(unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX) }, 0);
    assert_eq!(
        engine
            .uninstall(false, &mut |_| {})
            .unwrap_err()
            .to_string(),
        "Stop the Hexbot daemon, then run the installer again."
    );
    assert!(
        engine
            .paths
            .hexbot_home
            .join("runtime/native/one/hexbot")
            .exists()
    );
}

#[test]
fn linux_detection_does_not_authorize_deleting_prefix_matches_or_directories() {
    let temp = tempfile::tempdir().unwrap();
    let engine = engine(temp.path());
    let apps = engine.paths.apps_override.as_ref().unwrap();
    fs::create_dir_all(apps).unwrap();
    for name in [
        "Hexbot-my-backup.AppImage",
        "Hexbot-1.2.3-linux-x86_64.AppImage",
    ] {
        fs::write(apps.join(name), "not an ELF").unwrap();
    }
    fs::create_dir(apps.join("HexbotClient-1.2.3-linux-x86_64.AppImage")).unwrap();
    fs::create_dir(apps.join("app.hexbot.desktop.AppImage")).unwrap();
    fs::write(
        apps.join("HexbotClient-1.2.4-linux-x86_64.AppImage"),
        b"\x7fELFvalid",
    )
    .unwrap();
    fs::write(apps.join("app.hexbot.client.nightly.AppImage"), "managed").unwrap();
    let renamed = apps.join("Renamed.AppImage");
    fs::write(&renamed, "receipt managed").unwrap();
    fs::create_dir_all(&engine.paths.hexbot_home).unwrap();
    let receipt = Receipt {
        option: InstallOption::Client,
        channel: Track::Stable,
        version: "1.2.4".into(),
        paths: vec![renamed],
        installed_at: "now".into(),
    };
    fs::write(
        engine.paths.receipt(),
        serde_json::to_vec(&receipt).unwrap(),
    )
    .unwrap();
    assert_eq!(engine.detect().unwrap().apps.len(), 3);
    engine.uninstall(false, &mut |_| {}).unwrap();
    assert_eq!(fs::read_dir(apps).unwrap().count(), 4);
    assert!(apps.join("Hexbot-my-backup.AppImage").exists());
    assert!(apps.join("app.hexbot.desktop.AppImage").is_dir());
}

#[test]
fn manifests_and_redirects_cannot_leave_the_configured_origin() {
    let temp = tempfile::tempdir().unwrap();
    fs::create_dir(temp.path().join("install")).unwrap();
    let server = Server::new(temp.path());
    let foreign_dir = tempfile::tempdir().unwrap();
    let foreign = Server::new(foreign_dir.path());
    let artifact = app_artifact(
        temp.path(),
        &foreign.base,
        InstallOption::Client,
        Target::LinuxX86_64,
    );
    let mut manifest = Manifest {
        schema: 1,
        channel: Track::Stable,
        version: "0.0.1".into(),
        min_installer: "0.0.1".into(),
        targets: std::collections::BTreeMap::from([(
            "linux-x86_64".into(),
            Artifacts {
                client: Some(artifact),
                ..Default::default()
            },
        )]),
    };
    let publish = |m: &Manifest| publish(temp.path(), "stable", m);
    publish(&manifest);
    assert!(
        fetch_manifest(&server.base, Track::Stable)
            .unwrap_err()
            .to_string()
            .contains("same origin")
    );
    let mut engine = engine(temp.path());
    engine.base_url = server.base.clone();
    manifest
        .targets
        .get_mut("linux-x86_64")
        .unwrap()
        .client
        .as_mut()
        .unwrap()
        .url = format!("{}/client.AppImage", server.base);
    publish(&manifest);
    fs::write(
        temp.path().join("client.AppImage.redirect"),
        format!("{}/payload", foreign.base),
    )
    .unwrap();
    assert!(
        engine
            .apply(InstallOption::Client, Track::Stable, &mut |_| {})
            .is_err()
    );
    assert!(foreign.requests.lock().unwrap().is_empty());
    fs::write(
        temp.path().join("install/stable.json.redirect"),
        format!("{}/manifest", foreign.base),
    )
    .unwrap();
    assert!(fetch_manifest(&server.base, Track::Stable).is_err());
    assert!(foreign.requests.lock().unwrap().is_empty());
    fs::write(
        temp.path().join("install/stable.json.redirect"),
        format!("{}/actual.json", server.base),
    )
    .unwrap();
    fs::write(
        temp.path().join("actual.json"),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();
    fetch_manifest(&server.base, Track::Stable).unwrap();
}

#[cfg(target_os = "linux")]
#[test]
fn running_legacy_appimage_blocks_replace_change_and_uninstall() {
    use std::{
        io::{BufRead, BufReader},
        process::{Command, Stdio},
    };
    let temp = tempfile::tempdir().unwrap();
    let mut engine = engine(temp.path());
    let apps = engine.paths.apps_override.as_ref().unwrap();
    fs::create_dir_all(apps).unwrap();
    let legacy = apps.join("HexbotClient-1.2.3-linux-x86_64.AppImage");
    fs::write(&legacy, b"\x7fELFlegacy").unwrap();
    let server = Server::new(temp.path());
    engine.base_url = server.base.clone();
    fs::create_dir(temp.path().join("install")).unwrap();
    let artifact = app_artifact(
        temp.path(),
        &server.base,
        InstallOption::Client,
        Target::LinuxX86_64,
    );
    let manifest = Manifest {
        schema: 1,
        channel: Track::Stable,
        version: "0.0.1".into(),
        min_installer: "0.0.1".into(),
        targets: std::collections::BTreeMap::from([(
            "linux-x86_64".into(),
            Artifacts {
                client: Some(artifact),
                ..Default::default()
            },
        )]),
    };
    publish(temp.path(), "stable", &manifest);
    let mut child = Command::new("sh")
        .args(["-c", "printf 'ready\\n'; read line"])
        .env("APPIMAGE", &legacy)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut ready = String::new();
    BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut ready)
        .unwrap();
    let replace = engine.apply(InstallOption::Client, Track::Stable, &mut |_| {});
    let change = engine.change(
        InstallOption::Client,
        InstallOption::Headless,
        Track::Stable,
        &mut |_| true,
        &mut |_| {},
    );
    let uninstall = engine.uninstall(false, &mut |_| {});
    drop(child.stdin.take());
    child.wait().unwrap();
    for error in [
        replace.unwrap_err(),
        change.unwrap_err(),
        uninstall.unwrap_err(),
    ] {
        assert!(error.to_string().starts_with("Quit "), "{error}");
    }
    assert!(legacy.exists());
    assert!(!apps.join("app.hexbot.client.AppImage").exists());
}

fn publish_options(root: &Path, engine: &Installer) {
    fs::create_dir_all(root.join("install")).unwrap();
    let manifest = Manifest {
        schema: 1,
        channel: Track::Stable,
        version: "0.0.1".into(),
        min_installer: "0.0.1".into(),
        targets: std::collections::BTreeMap::from([(
            engine.target.to_string(),
            Artifacts {
                client: Some(app_artifact(
                    root,
                    &engine.base_url,
                    InstallOption::Client,
                    engine.target,
                )),
                full: Some(app_artifact(
                    root,
                    &engine.base_url,
                    InstallOption::Full,
                    engine.target,
                )),
                headless: Some(native_artifact(root, &engine.base_url)),
                ..Default::default()
            },
        )]),
    };
    publish(root, "stable", &manifest);
}

#[test]
fn foreign_and_legacy_services_do_not_block_apps_or_become_headless() {
    for executable in [
        "runtime/native-executable",
        "runtime/venv/bin/hexbot",
        "dev/hexbot",
    ] {
        let root = tempfile::tempdir().unwrap();
        let mut engine = engine(root.path());
        let server = Server::new(root.path());
        engine.base_url = server.base.clone();
        publish_options(root.path(), &engine);
        let owner = if executable == "runtime/native-executable" {
            root.path().join("foreign")
        } else {
            engine.paths.hexbot_home.clone()
        };
        service(&engine, &owner);
        let file = engine.paths.service_file(engine.target);
        let definition = fs::read_to_string(&file)
            .unwrap()
            .replace("runtime/native-executable", executable);
        fs::write(&file, &definition).unwrap();
        fs::create_dir_all(engine.paths.executable().parent().unwrap()).unwrap();
        fs::write(engine.paths.executable(), "daemon from Full").unwrap();
        fs::create_dir_all(engine.paths.wrapper().parent().unwrap()).unwrap();
        let wrapper = format!(
            "#!/bin/sh\n# Hexbot CLI, written by hexbot setup\nexport HEXBOT_HOME='{}'\n",
            root.path().join("other").display()
        );
        fs::write(engine.paths.wrapper(), &wrapper).unwrap();
        let installed = engine.detect().unwrap();
        assert!(installed.runtime);
        assert!(!installed.service);
        assert_eq!(installed.option(), None);
        assert!(engine.repair(&mut |_| {}).is_err());
        engine
            .apply(InstallOption::Client, Track::Stable, &mut |_| {})
            .unwrap();
        engine
            .change(
                InstallOption::Client,
                InstallOption::Full,
                Track::Stable,
                &mut |_| true,
                &mut |_| {},
            )
            .unwrap();
        engine
            .change(
                InstallOption::Full,
                InstallOption::Client,
                Track::Stable,
                &mut |_| true,
                &mut |_| {},
            )
            .unwrap();
        engine.uninstall(false, &mut |_| {}).unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), definition);
        assert_eq!(fs::read_to_string(engine.paths.wrapper()).unwrap(), wrapper);
        let error = engine
            .apply(InstallOption::Headless, Track::Stable, &mut |_| {})
            .unwrap_err();
        assert!(error.to_string().contains("service"));
        fs::remove_file(&file).unwrap();
        assert!(
            engine
                .apply(InstallOption::Headless, Track::Stable, &mut |_| {})
                .unwrap_err()
                .to_string()
                .contains("CLI")
        );
    }
}

#[test]
fn only_owned_service_or_wrapper_infers_headless_without_receipt() {
    let root = tempfile::tempdir().unwrap();
    let engine = engine(root.path());
    fs::create_dir_all(engine.paths.executable().parent().unwrap()).unwrap();
    fs::write(engine.paths.executable(), "runtime").unwrap();
    assert_eq!(engine.detect().unwrap().option(), None);
    service(&engine, &engine.paths.hexbot_home);
    assert_eq!(
        engine.detect().unwrap().option(),
        Some(InstallOption::Headless)
    );
    fs::remove_file(engine.paths.service_file(engine.target)).unwrap();
    fs::create_dir_all(engine.paths.wrapper().parent().unwrap()).unwrap();
    fs::write(
        engine.paths.wrapper(),
        format!(
            "#!/bin/sh\n# Hexbot CLI, written by hexbot setup\nexport HEXBOT_HOME='{}'\n",
            engine.paths.hexbot_home.display()
        ),
    )
    .unwrap();
    assert_eq!(
        engine.detect().unwrap().option(),
        Some(InstallOption::Headless)
    );
}

#[test]
fn headless_preserves_lan_without_receipt_and_status_is_best_effort() {
    let root = tempfile::tempdir().unwrap();
    let mut engine = engine(root.path());
    engine.target = Target::detect().unwrap();
    let server = Server::new(root.path());
    engine.base_url = server.base.clone();
    publish_options(root.path(), &engine);
    engine
        .apply(InstallOption::Headless, Track::Stable, &mut |_| {})
        .unwrap();
    fs::remove_file(engine.paths.receipt()).unwrap();
    fs::remove_file(engine.paths.hexbot_home.join("lan-on")).unwrap();
    for failure in ["status-error", "status-invalid"] {
        fs::write(engine.paths.home.join(failure), "1").unwrap();
        let result = engine
            .apply(InstallOption::Headless, Track::Stable, &mut |_| {})
            .unwrap();
        assert!(result.status.is_none());
        assert!(engine.paths.receipt().exists());
        assert!(!engine.paths.hexbot_home.join("lan-on").exists());
        let result = engine
            .change(
                InstallOption::Headless,
                InstallOption::Full,
                Track::Stable,
                &mut |_| true,
                &mut |_| {},
            )
            .unwrap();
        assert!(result.status.is_none());
        assert_eq!(engine.detect().unwrap().option(), Some(InstallOption::Full));
        engine
            .change(
                InstallOption::Full,
                InstallOption::Headless,
                Track::Stable,
                &mut |_| true,
                &mut |_| {},
            )
            .unwrap();
        assert!(engine.paths.hexbot_home.join("lan-on").exists());
        fs::remove_file(engine.paths.hexbot_home.join("lan-on")).unwrap();
        fs::remove_file(engine.paths.home.join(failure)).unwrap();
    }
}

#[test]
fn setup_json_error_is_returned_even_without_a_progress_listener() {
    let root = tempfile::tempdir().unwrap();
    let mut engine = engine(root.path());
    engine.target = Target::detect().unwrap();
    let server = Server::new(root.path());
    engine.base_url = server.base.clone();
    publish_options(root.path(), &engine);
    fs::write(engine.paths.home.join("setup-error"), "1").unwrap();
    assert_eq!(
        engine
            .apply(InstallOption::Headless, Track::Stable, &mut |_| {})
            .unwrap_err()
            .to_string(),
        "hexbot setup --activate --json failed: Python could not be installed"
    );
    assert!(!engine.paths.receipt().exists());
}

#[test]
fn track_fallback_requires_a_404() {
    let root = tempfile::tempdir().unwrap();
    fs::create_dir(root.path().join("install")).unwrap();
    let server = Server::new(root.path());
    assert_eq!(
        hexbot_installer::default_track(&server.base).unwrap(),
        Track::Nightly
    );
    for status in [
        "403 Forbidden",
        "500 Internal Server Error",
        "503 Service Unavailable",
    ] {
        fs::write(root.path().join("install/stable.json.status"), status).unwrap();
        assert_eq!(
            hexbot_installer::default_track(&server.base)
                .unwrap_err()
                .to_string(),
            "Could not reach the update server. Check your connection and try again."
        );
    }
    let base = server.base.clone();
    drop(server);
    assert!(
        hexbot_installer::default_track(&base)
            .unwrap_err()
            .to_string()
            .contains("Check your connection")
    );
}

#[test]
fn app_ids_must_match_the_manifest_track_before_installing() {
    let root = tempfile::tempdir().unwrap();
    let server = Server::new(root.path());
    let mut engine = engine(root.path());
    engine.base_url = server.base.clone();
    publish_options(root.path(), &engine);
    let original = fs::read(root.path().join("install/stable.json")).unwrap();
    for track in [Track::Stable, Track::Nightly] {
        for option in [InstallOption::Client, InstallOption::Full] {
            for suffix in ["", ".nightly", ".dev"] {
                if (track == Track::Stable && suffix.is_empty())
                    || (track == Track::Nightly && suffix == ".nightly")
                {
                    continue;
                }
                let mut manifest: Manifest = serde_json::from_slice(&original).unwrap();
                manifest.channel = track;
                let artifacts = manifest
                    .targets
                    .get_mut(&engine.target.to_string())
                    .unwrap();
                let artifact = if option == InstallOption::Client {
                    artifacts.client.as_mut().unwrap()
                } else {
                    artifacts.full.as_mut().unwrap()
                };
                artifact.app_id = Some(format!(
                    "{}{}",
                    if option == InstallOption::Client {
                        "app.hexbot.client"
                    } else {
                        "app.hexbot.desktop"
                    },
                    suffix
                ));
                publish(root.path(), track, &manifest);
                let error = engine.apply(option, track, &mut |_| {}).unwrap_err();
                assert!(error.to_string().contains("selected track"), "{error}");
                assert!(!engine.paths.receipt().exists());
            }
        }
    }
}

#[test]
fn remove_data_refuses_linked_home_before_changing_anything() {
    for custom in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let mut engine = engine(root.path());
        if custom {
            engine.paths.hexbot_home = root.path().join("custom-home");
        }
        let target = root.path().join("data");
        fs::create_dir_all(target.join("runtime/native/one")).unwrap();
        fs::write(target.join("runtime/native/one/hexbot"), "runtime").unwrap();
        fs::write(target.join("memory.txt"), "keep").unwrap();
        symlink(&target, &engine.paths.hexbot_home).unwrap();
        service(&engine, &engine.paths.hexbot_home);
        let file = engine.paths.service_file(engine.target);
        let before = fs::read(&file).unwrap();
        let error = engine
            .uninstall(true, &mut |_| panic!("no changes before refusal"))
            .unwrap_err();
        assert_eq!(
            error.to_string(),
            format!(
                "~/.hexbot is a link to {}. Delete that folder yourself if you want the data gone.",
                target.display()
            )
        );
        assert_eq!(fs::read(&file).unwrap(), before);
        assert!(target.join("runtime/native/one/hexbot").exists());
        assert!(!target.join("native-daemon.lock").exists());
        engine.uninstall(false, &mut |_| {}).unwrap();
        assert!(!file.exists());
        assert!(!target.join("runtime/native").exists());
        assert_eq!(
            fs::read_to_string(target.join("memory.txt")).unwrap(),
            "keep"
        );
        assert!(
            fs::symlink_metadata(&engine.paths.hexbot_home)
                .unwrap()
                .file_type()
                .is_symlink()
        );
    }
}

#[test]
fn free_daemon_lock_ignores_stale_record_with_an_unrelated_live_pid() {
    let root = tempfile::tempdir().unwrap();
    let engine = engine(root.path());
    fs::create_dir_all(engine.paths.hexbot_home.join("runtime/native/one")).unwrap();
    fs::write(
        engine.paths.hexbot_home.join("runtime/native/one/hexbot"),
        "runtime",
    )
    .unwrap();
    fs::write(
        engine.paths.hexbot_home.join("native-daemon.lock"),
        std::process::id().to_string(),
    )
    .unwrap();
    fs::write(engine.paths.hexbot_home.join("runtime/native-running.json"),
        serde_json::json!({"pid":std::process::id(), "executable":std::env::current_exe().unwrap()}).to_string()
    ).unwrap();
    engine.uninstall(false, &mut |_| {}).unwrap();
    assert!(!engine.paths.hexbot_home.join("runtime/native").exists());
}

#[test]
#[ignore = "subprocess fixture with an isolated PATH"]
fn failing_systemctl_fixture() {
    let root = std::env::var_os("HEXBOT_TEST_SYSTEMCTL_ROOT").unwrap();
    let root = Path::new(&root);
    for locked in [false, true] {
        let mut engine = engine(root);
        engine.paths.service_no_load = false;
        fs::create_dir_all(engine.paths.hexbot_home.join("runtime/native/one")).unwrap();
        fs::write(
            engine.paths.hexbot_home.join("runtime/native/one/hexbot"),
            "runtime",
        )
        .unwrap();
        service(&engine, &engine.paths.hexbot_home);
        let lock = fs::File::create(engine.paths.hexbot_home.join("native-daemon.lock")).unwrap();
        if locked {
            assert_eq!(unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX) }, 0);
        }
        let result = engine.uninstall(false, &mut |_| {});
        if locked {
            assert_eq!(
                result.unwrap_err().to_string(),
                "Stop the Hexbot daemon, then run the installer again."
            );
        } else {
            result.unwrap();
        }
        assert!(!engine.paths.service_file(engine.target).exists());
        assert_eq!(
            engine.paths.hexbot_home.join("runtime/native").exists(),
            locked
        );
    }
}

#[test]
fn failed_systemctl_removal_still_removes_unit_and_checks_daemon_lock() {
    let root = tempfile::tempdir().unwrap();
    let bin = root.path().join("bin");
    fs::create_dir(&bin).unwrap();
    executable(
        &bin.join("systemctl"),
        br#"#!/bin/sh
printf '%s\n' "$*" >> "$HOME/systemctl-calls"
exit 1
"#,
    );
    let path = std::env::join_paths(std::iter::once(bin).chain(std::env::split_paths(
        &std::env::var_os("PATH").unwrap_or_default(),
    )))
    .unwrap();
    let output = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "failing_systemctl_fixture",
            "--ignored",
            "--nocapture",
        ])
        .env("HEXBOT_TEST_SYSTEMCTL_ROOT", root.path())
        .env("PATH", path)
        .output()
        .unwrap();
    success(output);
    assert_eq!(
        fs::read_to_string(root.path().join("home/systemctl-calls")).unwrap(),
        "--user disable --now hexbot\n--user daemon-reload\n--user disable --now hexbot\n--user daemon-reload\n"
    );
}

/// Whoever controls the update origin, its TLS, or HEXBOT_UPDATE_URL cannot
/// ship a build: the manifest needs the release key's signature, and its
/// checksums then pin every package.
#[test]
fn unsigned_or_altered_manifests_and_plain_http_are_refused() {
    let temp = tempfile::tempdir().unwrap();
    fs::create_dir(temp.path().join("install")).unwrap();
    let server = Server::new(temp.path());
    let artifact = app_artifact(
        temp.path(),
        &server.base,
        InstallOption::Client,
        Target::LinuxX86_64,
    );
    let manifest = Manifest {
        schema: 1,
        channel: Track::Stable,
        version: "0.0.1".into(),
        min_installer: "0.0.1".into(),
        targets: std::collections::BTreeMap::from([(
            "linux-x86_64".into(),
            Artifacts {
                client: Some(artifact),
                ..Default::default()
            },
        )]),
    };
    let signature = temp.path().join("install/0.0.1/stable.json.sig");
    fs::write(
        temp.path().join("install/stable.json"),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();
    assert!(fetch_manifest(&server.base, Track::Stable).is_err());
    publish(temp.path(), "stable", &manifest);
    fetch_manifest(&server.base, Track::Stable).unwrap();
    let mut altered = manifest.clone();
    altered.min_installer = "0.0.0".into();
    let signed = fs::read(&signature).unwrap();
    fs::write(
        temp.path().join("install/stable.json"),
        serde_json::to_vec(&altered).unwrap(),
    )
    .unwrap();
    fs::write(&signature, &signed).unwrap();
    let error = fetch_manifest(&server.base, Track::Stable).unwrap_err();
    assert_eq!(
        error.to_string(),
        hexbot_installer::update_signature::INVALID
    );
    let mut engine = engine(temp.path());
    engine.base_url = server.base.clone();
    assert!(
        engine
            .apply(InstallOption::Client, Track::Stable, &mut |_| {})
            .is_err()
    );
    assert!(!engine.paths.receipt().exists());
    for base in ["http://updates.example", "https://user@updates.example"] {
        assert_eq!(
            fetch_manifest(base, Track::Stable).unwrap_err().to_string(),
            "The update URL must use HTTPS."
        );
    }
}
