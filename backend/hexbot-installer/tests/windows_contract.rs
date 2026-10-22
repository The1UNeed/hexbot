#![cfg(windows)]
//! Real NSIS, signed local manifest, isolated directories. No release credentials.
use base64::{Engine, engine::general_purpose::STANDARD};
use hexbot_installer::{InstallOption, Installer, Paths, Target, Track};
use serde_json::json;
use sha2::{Digest, Sha512};
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

#[test]
#[ignore = "requires HEXBOT_WINDOWS_NSIS pointing to a real locally built package"]
fn real_nsis_install_repair_and_uninstall() {
    let package = std::env::var("HEXBOT_WINDOWS_NSIS").expect("NSIS package required");
    let client = std::env::var("HEXBOT_WINDOWS_EDITION").as_deref() != Ok("full");
    let option = if client {
        InstallOption::Client
    } else {
        InstallOption::Full
    };
    let id = if client {
        "app.hexbot.client"
    } else {
        "app.hexbot.desktop"
    };
    let name = if client {
        "Hexbot Client [alpha]"
    } else {
        "Hexbot [alpha]"
    };
    let bytes = fs::read(package).unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let base = format!("http://{address}");
    let artifact = json!({"url":format!("{base}/app.exe"),"path":"app.exe","size":bytes.len(),"sha512":STANDARD.encode(Sha512::digest(&bytes)),"format":"exe","appId":id,"productName":name});
    let mut artifacts = serde_json::Map::new();
    artifacts.insert(if client { "client" } else { "full" }.into(), artifact);
    let manifest = serde_json::to_vec(&json!({"schema":1,"channel":"stable","version":hexbot_installer::version(),"minInstaller":"0.1.5-0","targets":{"windows-x86_64":artifacts}})).unwrap();
    let signature = hexbot_installer::update_signature::test_signature(&manifest).into_bytes();
    let stopped = Arc::new(AtomicBool::new(false));
    let stop = stopped.clone();
    let server = thread::spawn(move || {
        for stream in listener.incoming() {
            let mut stream = stream.unwrap();
            if stop.load(Ordering::SeqCst) {
                break;
            }
            let mut request = [0; 8192];
            let count = stream.read(&mut request).unwrap();
            let request = String::from_utf8_lossy(&request[..count]);
            let body = if request.starts_with("GET /app.exe ") {
                &bytes
            } else if request.lines().next().unwrap_or("").contains(".sig ") {
                &signature
            } else {
                &manifest
            };
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )
            .unwrap();
            stream.write_all(body).unwrap();
        }
    });
    let root = tempfile::tempdir().unwrap();
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
    let result = installer.apply(option, Track::Stable, &mut |event| {
        println!("{}", event.message)
    });
    // Stop the server even on a failed install, before reporting the failure.
    if let Err(error) = &result {
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
    if let Some(probe) = std::env::var_os("HEXBOT_WINDOWS_GUI_PROBE") {
        let output = std::process::Command::new(
            std::env::var_os("HEXBOT_WINDOWS_GUI_NODE").expect("trusted absolute CI Node"),
        )
        .arg(probe)
        .arg(app.join(if client {
            "HexbotClient.exe"
        } else {
            "Hexbot.exe"
        }))
        .arg(if client { "client" } else { "full" })
        .arg(root.path().join("isolated app session"))
        .output()
        .unwrap();
        assert!(
            output.status.success(),
            "Installed app probe failed:\n{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        println!("{}", String::from_utf8_lossy(&output.stdout));
    }
    // Simulate interruption after NSIS succeeded but before the outer receipt
    // commit. Ownership is already in the signed NSIS payload, so discovery,
    // reinstall and uninstall remain available without trusting arbitrary exes.
    fs::remove_file(installer.paths.receipt()).unwrap();
    assert_eq!(installer.detect().unwrap().apps[0].app_id, id);
    installer.apply(option, Track::Stable, &mut |_| {}).unwrap();
    installer.repair(&mut |_| {}).unwrap();
    installer.uninstall(false, &mut |_| {}).unwrap();
    assert!(!app.exists());
    stopped.store(true, Ordering::SeqCst);
    let _ = TcpStream::connect(address);
    server.join().unwrap();
}
