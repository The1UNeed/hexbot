mod common;
use common::*;
use hexbot_installer::{
    Artifacts, InstallOption, Installer, Manifest, Target, Track, default_track, fetch_manifest,
    read_receipt,
};
use std::{collections::BTreeMap, fs};

#[test]
fn install_change_repair_and_uninstall_use_only_isolated_paths() {
    let root = tempfile::tempdir().unwrap();
    let paths = paths(root.path());
    let tree = root.path().join("server");
    fs::create_dir_all(tree.join("install")).unwrap();
    let server = Server::new(&tree);
    let target = Target::detect().unwrap();
    let native = native_artifact(&tree, &server.base);
    let client = app_artifact_for_track(&tree, &server.base, InstallOption::Client, target, true);
    let full = app_artifact_for_track(&tree, &server.base, InstallOption::Full, target, true);
    let mut manifest = Manifest {
        schema: 1,
        channel: Track::Nightly,
        version: "0.0.1".into(),
        min_installer: "0.0.1".into(),
        targets: BTreeMap::from([(
            target.to_string(),
            Artifacts {
                headless: Some(native),
                client: Some(client),
                full: Some(full),
                ..Artifacts::default()
            },
        )]),
    };
    let publish = |m: &Manifest| {
        fs::write(
            tree.join(format!("install/{}.json", m.channel)),
            serde_json::to_vec(m).unwrap(),
        )
        .unwrap()
    };
    publish(&manifest);
    assert_eq!(default_track(&server.base).unwrap(), Track::Nightly);
    let engine = Installer {
        paths: paths.clone(),
        target,
        base_url: server.base.clone(),
    };
    let output = success(cli(&paths, &server.base, &["--headless", "--json"]));
    let events: Vec<serde_json::Value> = output
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    assert!(events.iter().any(|e| e["stage"] == "activate"));
    assert!(events.iter().any(|e| {
        e["stage"] == "lan"
            && e["message"]
                .as_str()
                .unwrap()
                .contains("LAN access is on. Turn it off with: hexbot lan off")
    }));
    assert!(
        events
            .iter()
            .any(|e| e["stage"] == "result" && e["result"]["status"]["port"] == 9119)
    );
    assert!(paths.service_file(target).exists());
    assert!(paths.wrapper().exists());
    let staged = std::path::PathBuf::from(
        fs::read_to_string(paths.home.join("staged-binary"))
            .unwrap()
            .trim(),
    );
    assert!(staged.starts_with(paths.hexbot_home.join("runtime")));
    assert!(!staged.parent().unwrap().parent().unwrap().exists());
    assert!(
        server
            .requests
            .lock()
            .unwrap()
            .iter()
            .all(|p| !p.contains("client.") && !p.contains("full."))
    );
    assert_eq!(
        read_receipt(&paths.receipt()).unwrap().unwrap().option,
        InstallOption::Headless
    );
    fs::write(paths.hexbot_home.join("memory.txt"), "keep this").unwrap();

    // A failed Client download leaves the Headless service and receipt intact.
    let before_service = fs::read(paths.service_file(target)).unwrap();
    let before_receipt = fs::read(paths.receipt()).unwrap();
    let before_calls = fs::read(paths.home.join("calls")).unwrap();
    let client = manifest
        .targets
        .get_mut(&target.to_string())
        .unwrap()
        .client
        .as_mut()
        .unwrap();
    let url = client.url.clone();
    client.url = format!("{}/missing-client", server.base);
    publish(&manifest);
    let error = engine
        .change(
            InstallOption::Headless,
            InstallOption::Client,
            Track::Nightly,
            &mut |_| true,
            &mut |_| {},
        )
        .unwrap_err();
    assert!(error.to_string().contains("404"), "{error}");
    assert_eq!(
        fs::read(paths.service_file(target)).unwrap(),
        before_service
    );
    assert_eq!(fs::read(paths.receipt()).unwrap(), before_receipt);
    assert_eq!(fs::read(paths.home.join("calls")).unwrap(), before_calls);
    manifest
        .targets
        .get_mut(&target.to_string())
        .unwrap()
        .client
        .as_mut()
        .unwrap()
        .url = url;
    publish(&manifest);

    // Every directed change between the three options, including keeping the service.
    for (from, to) in [
        (InstallOption::Headless, InstallOption::Full),
        (InstallOption::Full, InstallOption::Client),
        (InstallOption::Client, InstallOption::Full),
        (InstallOption::Full, InstallOption::Headless),
        (InstallOption::Headless, InstallOption::Client),
        (InstallOption::Client, InstallOption::Headless),
    ] {
        let mut confirmations = 0;
        let result = engine
            .change(
                from,
                to,
                Track::Nightly,
                &mut |_| {
                    confirmations += 1;
                    true
                },
                &mut |_| {},
            )
            .unwrap();
        assert_eq!(confirmations, 1);
        assert_eq!(result.receipt.option, to);
        assert_eq!(
            fs::read_to_string(paths.hexbot_home.join("memory.txt")).unwrap(),
            "keep this"
        );
        let installed = engine.detect().unwrap();
        if to == InstallOption::Client {
            assert!(!installed.service);
        }
        if from == InstallOption::Headless && to == InstallOption::Full {
            assert!(installed.service);
        }
        if from != InstallOption::Headless {
            assert!(!installed.apps.iter().any(|a| a.option == from));
        }
        assert_eq!(read_receipt(&paths.receipt()).unwrap().unwrap().option, to);
    }
    let count = server.requests.lock().unwrap().len();
    assert!(
        engine
            .change(
                InstallOption::Headless,
                InstallOption::Full,
                Track::Nightly,
                &mut |_| false,
                &mut |_| {}
            )
            .is_err()
    );
    assert_eq!(server.requests.lock().unwrap().len(), count);
    manifest.version = "0.0.2".into();
    publish(&manifest);
    fs::write(paths.home.join("calls"), "").unwrap();
    fs::remove_file(paths.hexbot_home.join("lan-on")).unwrap();
    let repair = success(cli(&paths, &server.base, &["--repair", "--json"]));
    assert!(!repair.contains("LAN access is on"));
    assert!(!paths.hexbot_home.join("lan-on").exists());
    assert_eq!(
        read_receipt(&paths.receipt()).unwrap().unwrap().version,
        "0.0.2"
    );
    let calls = fs::read_to_string(paths.home.join("calls")).unwrap();
    assert_eq!(
        calls,
        "setup --activate --json\nservice install\nstatus --json\n"
    );

    success(cli(
        &paths,
        &server.base,
        &["--uninstall", "--yes", "--json"],
    ));
    assert!(!paths.receipt().exists());
    assert!(!paths.wrapper().exists());
    assert!(!paths.service_file(target).exists());
    assert!(paths.hexbot_home.join("memory.txt").exists());
    success(cli(
        &paths,
        &server.base,
        &["--uninstall", "--remove-data", "--yes", "--json"],
    ));
    assert!(!paths.hexbot_home.exists());

    // Stable is preferred once published. A checksum failure never replaces an app.
    manifest.channel = Track::Stable;
    manifest
        .targets
        .get_mut(&target.to_string())
        .unwrap()
        .client = Some(app_artifact(
        &tree,
        &server.base,
        InstallOption::Client,
        target,
    ));
    publish(&manifest);
    assert_eq!(default_track(&server.base).unwrap(), Track::Stable);
    success(cli(
        &paths,
        &server.base,
        &["--client", "--stable", "--json"],
    ));
    let before = fs::read(paths.receipt()).unwrap();
    manifest
        .targets
        .get_mut(&target.to_string())
        .unwrap()
        .client
        .as_mut()
        .unwrap()
        .sha512 = Some("bad".into());
    publish(&manifest);
    let failed = cli(&paths, &server.base, &["--client", "--stable", "--json"]);
    assert!(!failed.status.success());
    assert!(String::from_utf8_lossy(&failed.stdout).contains("checksum"));
    assert_eq!(before, fs::read(paths.receipt()).unwrap());
    assert_eq!(engine.detect().unwrap().apps.len(), 1);
    success(cli(
        &paths,
        &server.base,
        &["--uninstall", "--yes", "--json"],
    ));
    assert!(engine.detect().unwrap().apps.is_empty());

    manifest.min_installer = "9999.0.0".into();
    publish(&manifest);
    assert!(
        fetch_manifest(&server.base, Track::Stable)
            .unwrap_err()
            .to_string()
            .starts_with("This installer is too old.")
    );
}

#[test]
fn linux_appimage_writes_a_desktop_entry_and_replaces_the_previous_app() {
    let root = tempfile::tempdir().unwrap();
    let paths = paths(root.path());
    let server = Server::new(root.path());
    fs::create_dir(root.path().join("install")).unwrap();
    let client = app_artifact(
        root.path(),
        &server.base,
        InstallOption::Client,
        Target::LinuxX86_64,
    );
    let manifest = Manifest {
        schema: 1,
        channel: Track::Stable,
        version: "0.0.1".into(),
        min_installer: "0.0.1".into(),
        targets: BTreeMap::from([(
            "linux-x86_64".into(),
            Artifacts {
                client: Some(client),
                ..Artifacts::default()
            },
        )]),
    };
    fs::write(
        root.path().join("install/stable.json"),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();
    let engine = Installer {
        paths: paths.clone(),
        target: Target::LinuxX86_64,
        base_url: server.base.clone(),
    };
    let result = engine
        .apply(InstallOption::Client, Track::Stable, &mut |_| {})
        .unwrap();
    assert!(result.warnings.is_empty());
    let desktop = paths.desktop_dir().join("app.hexbot.client.desktop");
    let entry = fs::read_to_string(&desktop).unwrap();
    assert!(entry.contains("Exec=\""));
    assert!(entry.contains("MimeType=x-scheme-handler/hexbot;"));
    let icon = result.receipt.paths[0].with_extension("png");
    assert!(entry.contains(&format!("Icon={}\n", icon.display())));
    assert!(icon.is_file());
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(
        fs::metadata(&result.receipt.paths[0])
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o755
    );
    engine.repair(&mut |_| {}).unwrap();
    // A `hexbot` the user put in ~/.local/bin themselves survives uninstall.
    fs::create_dir_all(paths.wrapper().parent().unwrap()).unwrap();
    fs::write(paths.wrapper(), "#!/bin/sh\necho mine\n").unwrap();
    engine.uninstall(false, &mut |_| {}).unwrap();
    assert!(!desktop.exists());
    assert!(!icon.exists());
    assert_eq!(
        fs::read_to_string(paths.wrapper()).unwrap(),
        "#!/bin/sh\necho mine\n"
    );
}
