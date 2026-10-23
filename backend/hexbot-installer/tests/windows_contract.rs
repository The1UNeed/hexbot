#![cfg(windows)]
//! Real NSIS, signed local manifest, isolated directories. No release credentials.
use base64::{Engine, engine::general_purpose::STANDARD};
use hexbot_installer::{InstallOption, Installer, Paths, Target, Track};
use serde_json::json;
use sha2::{Digest, Sha512};
#[path = "support/nsis_registration.rs"]
mod nsis_registration;
#[path = "../../hexbot-core/src/windows_node_path.rs"]
mod windows_node_path;
use std::{
    fs,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread,
};

fn regular_file(path: &std::path::Path) -> std::io::Result<std::path::PathBuf> {
    if !path.is_absolute() {
        return Err(std::io::Error::other("Expected an absolute path"));
    }
    let canonical = path.canonicalize()?;
    if !fs::symlink_metadata(&canonical)?.is_file() {
        return Err(std::io::Error::other("Expected a regular file"));
    }
    Ok(canonical)
}
fn path_diagnostic(label: &str, path: &std::path::Path) -> serde_json::Value {
    use std::os::windows::ffi::OsStrExt;
    let metadata = fs::symlink_metadata(path);
    json!({"label":label,"type":"Windows OsString path","value":path.to_string_lossy().chars().take(1024).collect::<String>(),
        "utf16Units":path.as_os_str().encode_wide().count(),"absolute":path.is_absolute(),
        "regularFile":metadata.as_ref().is_ok_and(|m|m.is_file()),"metadataError":metadata.err().and_then(|e|e.raw_os_error())})
}
// Keep canonical paths for containment/identity checks. Only the Node CLI's
// script operand uses DOS/UNC spelling, as in the production PiProcess.
fn node_script(path: &std::path::Path, root: &std::path::Path) -> std::path::PathBuf {
    let canonical = regular_file(path).expect("trusted absolute regular Node script");
    assert!(
        canonical.starts_with(root.canonicalize().unwrap()),
        "Node script escaped its trusted root"
    );
    let operand = windows_node_path::node_path(&canonical).expect("supported Node script path");
    assert_eq!(
        regular_file(&operand).unwrap(),
        canonical,
        "Node script identity changed after normalization"
    );
    eprintln!(
        "Native Node script: {}",
        json!({"input":path_diagnostic("script input",path),"operand":path_diagnostic("Node operand",&operand)})
    );
    operand
}
fn spawn_gui_probe(node: &std::path::Path, args: &[std::ffi::OsString]) -> std::process::Output {
    use std::os::windows::process::CommandExt;
    eprintln!(
        "Native GUI spawn: {}",
        json!({"program":path_diagnostic("Node",node),
        "argv":args.iter().map(|a|a.to_string_lossy().chars().take(1024).collect::<String>()).collect::<Vec<_>>() })
    );
    std::process::Command::new(node)
        .args(args)
        .creation_flags(0x08000000)
        .output()
        .unwrap_or_else(|error| panic!("Native GUI spawn failed after path validation: {error}"))
}
fn node_preflight(node: &std::path::Path, root: &std::path::Path) {
    let canonical = regular_file(node).expect("trusted absolute regular Node executable");
    assert!(regular_file(std::path::Path::new("node.exe")).is_err());
    assert!(regular_file(root).is_err());
    let joined = format!("{} {}", node.display(), node.display());
    assert!(
        regular_file(std::path::Path::new(&joined)).is_err(),
        "A joined discovery list is not one program"
    );
    let fixture = root.join("Node argv \u{3c0} check.mjs");
    fs::write(&fixture,"process.stdout.write(JSON.stringify({execPath:process.execPath,argv:process.argv.slice(2)}))").unwrap();
    let values = ["with spaces", "a&b", "literal\"quote", "\u{3c0}"];
    let canonical_fixture = fixture.canonicalize().unwrap();
    for (program, script) in [node, canonical.as_path()].into_iter().flat_map(|program| {
        [fixture.as_path(), canonical_fixture.as_path()].map(|script| (program, script))
    }) {
        let mut args = vec![node_script(script, root).into_os_string()];
        args.extend(values.iter().map(std::ffi::OsString::from));
        let output = spawn_gui_probe(program, &args);
        assert!(
            output.status.success(),
            "Node preflight status={} stderr={}",
            output.status,
            String::from_utf8_lossy(&output.stderr)
        );
        let result: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(result["argv"], json!(values));
        assert_eq!(
            std::path::Path::new(result["execPath"].as_str().unwrap())
                .canonicalize()
                .unwrap(),
            canonical
        );
    }
}

#[test]
#[ignore = "requires real NSIS and the mandatory trusted Node/installed GUI probe"]
fn real_nsis_install_repair_and_uninstall() {
    let package = std::env::var("HEXBOT_WINDOWS_NSIS").expect("NSIS package required");
    let track = match std::env::var("HEXBOT_WINDOWS_TRACK").as_deref() {
        Ok("nightly") => Track::Nightly,
        Ok("stable") | Err(_) => Track::Stable,
        other => panic!("Unexpected test track: {other:?}"),
    };
    let package_version = std::env::var("HEXBOT_WINDOWS_PACKAGE_VERSION")
        .unwrap_or_else(|_| hexbot_installer::version());
    let client = std::env::var("HEXBOT_WINDOWS_EDITION").as_deref() != Ok("full");
    let option = if client {
        InstallOption::Client
    } else {
        InstallOption::Full
    };
    let identity = format!(
        "app.hexbot.{}{}",
        if client { "client" } else { "desktop" },
        if track == Track::Nightly {
            ".nightly"
        } else {
            ""
        }
    );
    let id = identity.as_str();
    let registration = nsis_registration::Registration::new(id);
    let name = match (client, track) {
        (true, Track::Nightly) => "Hexbot Client Nightly",
        (false, Track::Nightly) => "Hexbot Nightly",
        (true, _) => "Hexbot Client [alpha]",
        (false, _) => "Hexbot [alpha]",
    };
    let bytes = fs::read(package).unwrap();
    let client_id = format!(
        "app.hexbot.client{}",
        if track == Track::Nightly {
            ".nightly"
        } else {
            ""
        }
    );
    let client_bytes = (!client).then(|| {
        fs::read(
            std::env::var_os("HEXBOT_WINDOWS_CLIENT_NSIS")
                .expect("Full Change control requires real same-track Client NSIS"),
        )
        .unwrap()
    });
    let client_registration = (!client).then(|| nsis_registration::Registration::new(&client_id));
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let base = format!("http://{address}");
    let artifact = json!({"url":format!("{base}/app.exe"),"path":"app.exe","size":bytes.len(),"sha512":STANDARD.encode(Sha512::digest(&bytes)),"format":"exe","appId":id,"productName":name});
    let mut artifacts = serde_json::Map::new();
    artifacts.insert(if client { "client" } else { "full" }.into(), artifact);
    if let Some(bytes) = &client_bytes {
        artifacts.insert("client".into(), json!({"url":format!("{base}/client.exe"),"size":bytes.len(),"sha512":STANDARD.encode(Sha512::digest(bytes)),"format":"exe","appId":client_id,"productName":"Hexbot Client"}));
    }
    let manifest = serde_json::to_vec(&json!({"schema":1,"channel":track,"version":package_version,"minInstaller":"0.1.5-0","targets":{"windows-x86_64":artifacts}})).unwrap();
    let signature = hexbot_installer::update_signature::test_signature(&manifest).into_bytes();
    let stopped = Arc::new(AtomicBool::new(false));
    let stop = stopped.clone();
    let served_version = package_version.clone();
    let server = thread::spawn(move || {
        for stream in listener.incoming() {
            let mut stream = stream.unwrap();
            if stop.load(Ordering::SeqCst) {
                break;
            }
            let mut request = [0; 8192];
            let count = stream.read(&mut request).unwrap();
            let request = String::from_utf8_lossy(&request[..count]);
            let path = request.split_whitespace().nth(1).unwrap();
            let body = if path == "/app.exe" {
                Some(&bytes)
            } else if path == "/client.exe" {
                client_bytes.as_ref()
            } else if path == format!("/install/{served_version}/{track}.json.sig") {
                Some(&signature)
            } else if path == format!("/install/{track}.json") {
                Some(&manifest)
            } else {
                None
            };
            let status = if body.is_some() {
                "200 OK"
            } else {
                "404 Not Found"
            };
            let body = body.map(Vec::as_slice).unwrap_or_default();
            write!(
                stream,
                "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )
            .unwrap();
            stream.write_all(body).unwrap();
        }
    });
    let root = tempfile::tempdir().unwrap();
    let node = std::path::PathBuf::from(
        std::env::var_os("HEXBOT_WINDOWS_GUI_NODE").expect("mandatory trusted CI Node"),
    );
    let probe = std::path::PathBuf::from(
        std::env::var_os("HEXBOT_WINDOWS_GUI_PROBE").expect("mandatory installed GUI probe"),
    );
    eprintln!(
        "Native GUI inputs: {}",
        json!([
            path_diagnostic("Node env", &node),
            path_diagnostic("probe env", &probe)
        ])
    );
    regular_file(&node).expect("GUI Node must name one absolute regular executable");
    regular_file(&probe).expect("GUI probe must name one absolute regular source file");
    node_preflight(&node, root.path());
    let user = root.path().join("user with spaces");
    fs::create_dir_all(&user).unwrap();
    let installer = Installer {
        paths: Paths {
            home: user.clone(),
            hexbot_home: user.join(".hexbot"),
            apps_override: Some(root.path().join("apps with spaces")),
            opt_override: None,
            service_root: root.path().join("services"),
            service_no_load: true,
        },
        target: Target::WindowsX86_64,
        base_url: base,
    };
    let foreign = root.path().join("foreign NSIS sibling");
    fs::create_dir(&foreign).unwrap();
    let foreign_uninstaller = foreign.join(if client {
        "Uninstall HexbotClient.exe"
    } else {
        "Uninstall Hexbot.exe"
    });
    fs::write(&foreign_uninstaller, "foreign bytes: never execute").unwrap();
    let absent = registration.snapshot();
    registration.edit(
        "LocalMachine",
        &foreign,
        &format!("\"{}\" /allusers", foreign_uninstaller.display()),
    );
    let before = registration.snapshot();
    let mut invoked = false;
    assert!(
        installer
            .apply(option, track, &mut |p| invoked |= p.stage == "install")
            .is_err()
    );
    assert!(!invoked, "HKLM-only collision reached NSIS/UAC");
    assert_eq!(registration.snapshot(), before);
    assert!(!installer.paths.receipt().exists());
    assert_eq!(
        fs::read_to_string(&foreign_uninstaller).unwrap(),
        "foreign bytes: never execute"
    );
    registration.restore(&absent);
    assert_eq!(
        registration.snapshot(),
        absent,
        "Foreign collision fixture must be fully restored before real NSIS"
    );
    let result = installer.apply(option, track, &mut |event| println!("{}", event.message));
    // Stop the server even on a failed install, before reporting the failure.
    if let Err(error) = &result {
        eprintln!(
            "Actual NSIS failure registration: {}",
            registration.snapshot()
        );
        stopped.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect(address);
        server.join().unwrap();
        panic!("{error}");
    }
    let app = installer.paths.apps_override.as_ref().unwrap().join(id);
    assert!(
        app.join(if client {
            "HexbotClient.exe"
        } else {
            "Hexbot.exe"
        })
        .is_file()
    );
    assert!(app.join("resources/app.asar").is_file());
    if !client {
        assert!(app.join("resources/hexbot-native/hexbot.exe").is_file());
    }
    assert_eq!(installer.detect().unwrap().apps.len(), 1);
    assert_eq!(
        hexbot_installer::read_receipt(&installer.paths.receipt())
            .unwrap()
            .unwrap()
            .paths,
        vec![app.clone()]
    );
    let registered = registration.snapshot();
    let other_id = if let Some(base) = id.strip_suffix(".nightly") {
        base.to_owned()
    } else {
        format!("{id}.nightly")
    };
    let other_registration = nsis_registration::Registration::new(&other_id);
    let other_directory = root.path().join("Programs").join(&other_id);
    fs::create_dir_all(&other_directory).unwrap();
    let other_name = if client {
        "Uninstall HexbotClient.exe"
    } else {
        "Uninstall Hexbot.exe"
    };
    let other_uninstaller = other_directory.join(other_name);
    fs::write(
        &other_uninstaller,
        "unrelated other-track registration fixture",
    )
    .unwrap();
    other_registration.edit(
        "CurrentUser",
        &other_directory,
        &format!("\"{}\" /currentuser", other_uninstaller.display()),
    );
    let other_before = other_registration.snapshot();
    let uninstall_name = registered[0]["command"]
        .as_str()
        .unwrap()
        .split('"')
        .nth(1)
        .unwrap()
        .rsplit(['\\', '/'])
        .next()
        .unwrap();
    assert_eq!(
        foreign_uninstaller.file_name(),
        Some(std::ffi::OsStr::new(uninstall_name))
    );
    for case in [
        "foreign-location",
        "foreign-command",
        "unquoted-command",
        "allusers-command",
        "machine-foreign",
    ] {
        let scope = if case == "machine-foreign" {
            "LocalMachine"
        } else {
            "CurrentUser"
        };
        let location = if matches!(case, "foreign-location" | "machine-foreign") {
            foreign.as_path()
        } else {
            app.as_path()
        };
        let command = match case {
            "unquoted-command" => format!("{} /currentuser", app.join(uninstall_name).display()),
            "allusers-command" => format!("\"{}\" /allusers", app.join(uninstall_name).display()),
            _ => format!("\"{}\" /currentuser", foreign_uninstaller.display()),
        };
        registration.edit(scope, location, &command);
        let before = registration.snapshot();
        let receipt = fs::read(installer.paths.receipt()).unwrap();
        let mut invoked = false;
        let error = installer
            .repair(&mut |p| invoked |= p.stage == "install")
            .unwrap_err();
        eprintln!("Real NSIS {case} refused before invocation: {error}; registration={before}");
        assert!(!invoked);
        assert_eq!(registration.snapshot(), before);
        assert_eq!(fs::read(installer.paths.receipt()).unwrap(), receipt);
        assert_eq!(
            fs::read_to_string(&foreign_uninstaller).unwrap(),
            "foreign bytes: never execute"
        );
        // Uninstall may not delete the same conflicting GUID's foreign keys.
        assert!(installer.uninstall(false, &mut |_| {}).is_err());
        assert_eq!(registration.snapshot(), before);
        assert!(app.exists());
        registration.restore(&registered);
    }
    // A deliberately mixed payload is not a normal updater transition.
    let original = fs::read(app.join("resources/app.asar")).unwrap();
    let opposite = if track == Track::Stable {
        "9.0.0-nightly.20990101.1"
    } else {
        "9.0.0"
    };
    let package = serde_json::to_vec(&json!({"version":opposite})).unwrap();
    let header =
        serde_json::to_vec(&json!({"files":{"package.json":{"offset":"0","size":package.len()}}}))
            .unwrap();
    let size = (header.len() + 11) & !3;
    let mut mixed = Vec::new();
    for word in [4, size as u32, (size - 4) as u32, header.len() as u32] {
        mixed.extend(word.to_le_bytes())
    }
    mixed.extend(header);
    mixed.resize(size + 8, 0);
    mixed.extend(package);
    fs::write(app.join("resources/app.asar"), mixed).unwrap();
    let before = fs::read(installer.paths.receipt()).unwrap();
    let mut invoked = false;
    let error = installer
        .repair(&mut |p| invoked |= p.stage == "install")
        .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("identity and packaged track disagree")
    );
    assert!(!invoked);
    assert_eq!(installer.detect().unwrap().track(), None);
    assert_eq!(fs::read(installer.paths.receipt()).unwrap(), before);
    assert_eq!(
        fs::read_dir(installer.paths.apps_override.as_ref().unwrap())
            .unwrap()
            .count(),
        1
    );
    fs::write(app.join("resources/app.asar"), original).unwrap();
    let args = [
        node_script(
            &probe,
            &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../scripts/desktop"),
        )
        .into_os_string(),
        app.join(if client {
            "HexbotClient.exe"
        } else {
            "Hexbot.exe"
        })
        .into_os_string(),
        std::ffi::OsString::from(if client { "client" } else { "full" }),
        root.path().join("isolated app session").into_os_string(),
        json!({"program":env!("CARGO_BIN_EXE_hexbot-install"),"env":{
            "HEXBOT_UPDATE_URL":installer.base_url,"HEXBOT_HOME":installer.paths.hexbot_home,
            "HOME":installer.paths.home,"USERPROFILE":installer.paths.home,"HEXBOT_SERVICE_ROOT":installer.paths.service_root,
            "HEXBOT_INSTALL_APPS_DIR":installer.paths.apps_override,"HEXBOT_SERVICE_NO_LOAD":"1","HEXBOT_CLI_NO_PATH":"1"
        }}).to_string().into(),
    ];
    let output = spawn_gui_probe(&node, &args);
    assert!(
        output.status.success(),
        "Installed app probe status={}:\n{}\n{}",
        output.status,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    println!("{}", String::from_utf8_lossy(&output.stdout));
    // A stale outer receipt cannot override this actual NSIS identity.
    // The server publishes only the marker identity track.
    let mut stale = hexbot_installer::read_receipt(&installer.paths.receipt())
        .unwrap()
        .unwrap();
    stale.channel = if track == Track::Stable {
        Track::Nightly
    } else {
        Track::Stable
    };
    fs::write(
        installer.paths.receipt(),
        serde_json::to_vec(&stale).unwrap(),
    )
    .unwrap();
    assert_eq!(installer.detect().unwrap().track(), Some(track));
    let repaired = installer.repair(&mut |_| {}).unwrap();
    assert_eq!(repaired.receipt.option, option);
    assert_eq!(repaired.receipt.channel, track);
    eprintln!("Real NSIS repair retained {track} identity despite stale receipt");
    for payload in [
        if client {
            "HexbotClient.exe"
        } else {
            "Hexbot.exe"
        },
        "resources/app.asar",
    ] {
        fs::remove_file(app.join(payload)).unwrap();
        let repaired = installer.repair(&mut |_| {}).unwrap();
        assert_eq!(repaired.receipt.option, option);
        assert_eq!(repaired.receipt.channel, track);
        assert!(
            app.join(payload).is_file(),
            "NSIS did not restore {payload}"
        );
        assert_eq!(installer.detect().unwrap().apps[0].app_id, id);
    }
    for damage in ["header", "version"] {
        let asar = app.join("resources/app.asar");
        let mut bytes = fs::read(&asar).unwrap();
        if damage == "header" {
            bytes[0] = 0;
        } else {
            // Change only the top-level package version, preserving its length
            // and the real ASAR offsets. The archive remains an ordinary file.
            let from = format!("\"version\":\"{}\"", package_version).into_bytes();
            let word = |at| u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap()) as usize;
            let header: serde_json::Value =
                serde_json::from_slice(&bytes[16..16 + word(12)]).unwrap();
            let entry = &header["files"]["package.json"];
            let start = 8 + word(4) + entry["offset"].as_str().unwrap().parse::<usize>().unwrap();
            let end = start + entry["size"].as_u64().unwrap() as usize;
            let at = bytes[start..end]
                .windows(from.len())
                .position(|b| b == from)
                .expect("top-level packaged version");
            bytes[start + at + 11] = b'!';
        }
        fs::write(&asar, &bytes).unwrap();
        let mut messages = Vec::new();
        let repaired = installer
            .repair(&mut |p| messages.push(p.message.clone()))
            .unwrap();
        assert_eq!(repaired.receipt.option, option);
        assert_eq!(repaired.receipt.channel, track);
        assert!(
            messages
                .iter()
                .any(|m| m.contains("version could not be read")),
            "{damage}: {messages:?}"
        );
        assert_ne!(
            fs::read(&asar).unwrap(),
            bytes,
            "NSIS did not restore corrupt {damage}"
        );
        assert_eq!(
            installer.detect().unwrap().apps[0].version.as_deref(),
            Some(package_version.as_str())
        );
    }
    // Simulate interruption after NSIS succeeded but before the outer receipt
    // commit. Ownership is already in the signed NSIS payload, so discovery,
    // reinstall and uninstall remain available without trusting arbitrary exes.
    fs::remove_file(installer.paths.receipt()).unwrap();
    assert_eq!(installer.detect().unwrap().apps[0].app_id, id);
    let repaired = installer.repair(&mut |_| {}).unwrap();
    assert_eq!(repaired.receipt.option, option);
    assert_eq!(repaired.receipt.channel, track);
    let recorded = hexbot_installer::read_receipt(&installer.paths.receipt())
        .unwrap()
        .unwrap();
    assert_eq!(recorded.option, option);
    assert_eq!(recorded.channel, track);
    installer.repair(&mut |_| {}).unwrap(); // The normal receipt path still works.
    let original_asar = fs::read(app.join("resources/app.asar")).unwrap();
    let original_receipt = fs::read(installer.paths.receipt()).unwrap();
    fs::remove_file(installer.paths.receipt()).unwrap();
    fs::write(app.join("resources/app.asar"), "corrupt ordinary bytes").unwrap();
    assert!(
        installer.repair(&mut |_| {}).is_err(),
        "Receiptless corrupt payload was treated as repair authority"
    );
    fs::write(app.join("resources/app.asar"), original_asar).unwrap();
    fs::write(installer.paths.receipt(), original_receipt).unwrap();
    // Detect -> Uninstall must retain exact receipt-backed ownership even
    // after damage, rather than dropping the receipt and stranding NSIS files.
    for payload in [
        if client {
            "HexbotClient.exe"
        } else {
            "Hexbot.exe"
        },
        "resources/app.asar",
    ] {
        fs::remove_file(app.join(payload)).unwrap();
        assert_eq!(installer.detect().unwrap().apps.len(), 1);
        installer.uninstall(false, &mut |_| {}).unwrap();
        assert!(!app.exists());
        assert!(!installer.paths.receipt().exists());
        installer.apply(option, track, &mut |_| {}).unwrap();
    }
    // The packaged ownership also supports a partial uninstall without a receipt.
    fs::remove_file(installer.paths.receipt()).unwrap();
    installer.uninstall(false, &mut |_| {}).unwrap();
    assert!(!app.exists());
    registration.assert_absent();
    assert_eq!(
        other_registration.snapshot(),
        other_before,
        "Another track's Programs registration was changed"
    );
    assert_eq!(
        fs::read_to_string(other_uninstaller).unwrap(),
        "unrelated other-track registration fixture"
    );
    assert_eq!(
        fs::read_to_string(&foreign_uninstaller).unwrap(),
        "foreign bytes: never execute"
    );
    // Successful Change uses the same public engine route, real same-track
    // Client NSIS, and an owned service marker. Scheduler load is disabled only
    // in this isolated NSIS fixture; the native task fixture tests live refusal.
    for from in if client {
        vec![InstallOption::Headless]
    } else {
        vec![InstallOption::Full, InstallOption::Headless]
    } {
        if from == InstallOption::Full {
            installer
                .apply(InstallOption::Full, track, &mut |_| {})
                .unwrap();
        } else {
            let receipt = hexbot_installer::Receipt {
                option: from,
                channel: track,
                version: package_version.clone(),
                paths: vec![],
                installed_at: "Headless Change fixture".into(),
            };
            fs::write(
                installer.paths.receipt(),
                serde_json::to_vec(&receipt).unwrap(),
            )
            .unwrap();
        }
        let script = installer.paths.service_file(installer.target);
        fs::create_dir_all(script.parent().unwrap()).unwrap();
        fs::write(
            &script,
            format!(
                "# Hexbot owned home: {}\n",
                serde_json::to_string(&installer.paths.hexbot_home.canonicalize().unwrap())
                    .unwrap()
            ),
        )
        .unwrap();
        fs::write(script.with_extension("xml"), "owned XML fixture").unwrap();
        assert!(installer.detect().unwrap().service);
        let changed = installer
            .change(
                from,
                InstallOption::Client,
                track,
                &mut |_| true,
                &mut |_| {},
            )
            .unwrap();
        eprintln!(
            "Real same-track NSIS Change {from:?}->Client completed: {}",
            serde_json::to_string(&changed.receipt).unwrap()
        );
        let destination = installer
            .paths
            .apps_override
            .as_ref()
            .unwrap()
            .join(&client_id);
        assert_eq!(changed.receipt.option, InstallOption::Client);
        assert_eq!(changed.receipt.channel, track);
        assert_eq!(changed.receipt.paths, vec![destination.clone()]);
        assert!(destination.join("HexbotClient.exe").is_file());
        assert!(!script.exists());
        assert!(!script.with_extension("xml").exists());
        assert_eq!(installer.detect().unwrap().apps.len(), 1);
        if !client {
            assert!(!app.exists());
            registration.assert_absent();
        }
        installer.uninstall(false, &mut |_| {}).unwrap();
        assert!(!destination.exists());
        if let Some(reg) = &client_registration {
            reg.assert_absent();
        } else {
            registration.assert_absent();
        }
        assert_eq!(other_registration.snapshot(), other_before);
    }
    stopped.store(true, Ordering::SeqCst);
    let _ = TcpStream::connect(address);
    server.join().unwrap();
}

#[test]
#[ignore = "changes PATH only on an explicitly disposable native CI user"]
fn interrupted_cli_install_and_uninstall_clean_only_owned_metadata_and_path() {
    use hexbot_installer::windows_cli;
    use sha2::Sha256;
    assert_eq!(
        std::env::var("HEXBOT_WINDOWS_PATH_PROBE").as_deref(),
        Ok("1")
    );
    assert_ne!(std::env::var("HEXBOT_CLI_NO_PATH").as_deref(), Ok("1"));
    fn ps(script: &str) -> std::process::Output {
        let output = std::process::Command::new(
            std::path::Path::new(&std::env::var_os("SystemRoot").unwrap())
                .join("System32/WindowsPowerShell/v1.0/powershell.exe"),
        )
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .output()
        .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        output
    }
    let query = r#"[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$k=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment');try{@{value=[string]$k.GetValue('Path','',[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames);exists=($k.GetValueNames() -contains 'Path');kind=$(if($k.GetValueNames() -contains 'Path'){[int]$k.GetValueKind('Path')}else{2})}|ConvertTo-Json -Compress}finally{$k.Dispose()}"#;
    let before: serde_json::Value = serde_json::from_slice(&ps(query).stdout).unwrap();
    struct Restore(serde_json::Value);
    impl Drop for Restore {
        fn drop(&mut self) {
            let value = self.0.to_string().replace('\'', "''");
            ps(&format!(
                "$v='{value}'|ConvertFrom-Json;$k=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment');try{{if($v.exists){{$k.SetValue('Path',[string]$v.value,[Microsoft.Win32.RegistryValueKind][int]$v.kind)}}else{{$k.DeleteValue('Path',$false)}}}}finally{{$k.Dispose()}}"
            ));
        }
    }
    let _restore = Restore(before.clone());
    let root = tempfile::tempdir().unwrap();
    let user = root.path().join("Jos\u{e9} CLI owner");
    let home = user.join("state");
    fs::create_dir_all(&home).unwrap();
    let installer = Installer {
        paths: Paths {
            home: user.clone(),
            hexbot_home: home.clone(),
            apps_override: Some(root.path().join("apps")),
            opt_override: None,
            service_root: user.clone(),
            service_no_load: true,
        },
        target: Target::WindowsX86_64,
        base_url: "http://127.0.0.1:1".into(),
    };
    let cli = installer.paths.cli_wrapper(Target::WindowsX86_64);
    fs::create_dir_all(cli.parent().unwrap()).unwrap();
    let record = cli.with_extension("json");
    let valid = json!({"schema":1,"home":home.canonicalize().unwrap(),"hashes":[format!("{:x}",Sha256::digest(b"trusted forwarder"))],"pathAdded":false});
    // First install interrupted after ownership commit, before EXE/PATH.
    fs::write(&record, valid.to_string()).unwrap();
    installer.uninstall(false, &mut |_| {}).unwrap();
    assert!(!record.exists());
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&ps(query).stdout).unwrap()["value"],
        before["value"]
    );
    // Partial uninstall after EXE removal must still remove its recorded PATH.
    let source = root.path().join("forwarder fixture");
    fs::write(&source, b"trusted forwarder").unwrap();
    windows_cli::install(&source, &home, cli.parent().unwrap()).unwrap();
    windows_cli::register_path(&cli).unwrap();
    fs::remove_file(&cli).unwrap();
    assert!(windows_cli::removable(&cli, &home));
    installer.uninstall(false, &mut |_| {}).unwrap();
    assert!(!record.exists());
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&ps(query).stdout).unwrap()["value"],
        before["value"]
    );
    // Another home can now install. It cannot be removed by the previous home.
    let other_home = user.join("other state");
    fs::create_dir(&other_home).unwrap();
    windows_cli::install(&source, &other_home, cli.parent().unwrap()).unwrap();
    fs::remove_file(&cli).unwrap();
    let foreign = fs::read(&record).unwrap();
    installer.uninstall(false, &mut |_| {}).unwrap();
    assert_eq!(fs::read(&record).unwrap(), foreign);
    windows_cli::remove(&cli, &other_home).unwrap();
    for bad in [
        b"not JSON".to_vec(),
        json!({"schema":1,"home":home,"hashes":[],"pathAdded":true})
            .to_string()
            .into_bytes(),
    ] {
        fs::write(&record, &bad).unwrap();
        installer.uninstall(false, &mut |_| {}).unwrap();
        assert_eq!(fs::read(&record).unwrap(), bad);
        assert!(!cli.exists());
    }
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&ps(query).stdout).unwrap()["value"],
        before["value"]
    );
}
