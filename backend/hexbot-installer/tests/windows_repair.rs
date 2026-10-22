//! Portable ownership/track regressions; real NSIS recovery runs on Windows.
use hexbot_installer::{InstallOption, Installer, Paths, Receipt, Target, Track};
use serde_json::json;
use std::{
    collections::BTreeMap,
    fs,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread,
};

struct Server {
    base: String,
    requests: Arc<Mutex<Vec<String>>>,
    stop: Arc<AtomicBool>,
    task: Option<thread::JoinHandle<()>>,
}
impl Server {
    fn new(files: impl FnOnce(&str) -> BTreeMap<String, Vec<u8>>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let files = files(&base);
        let requests = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let (record, stopped) = (requests.clone(), stop.clone());
        let task = thread::spawn(move || {
            for stream in listener.incoming() {
                let mut stream = stream.unwrap();
                if stopped.load(Ordering::SeqCst) {
                    break;
                }
                let mut bytes = [0; 8192];
                let size = stream.read(&mut bytes).unwrap();
                let request = String::from_utf8_lossy(&bytes[..size]);
                let path = request.split_whitespace().nth(1).unwrap().to_owned();
                record.lock().unwrap().push(path.clone());
                let body = files.get(&path);
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
        Self {
            base,
            requests,
            stop,
            task: Some(task),
        }
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect(self.base.trim_start_matches("http://"));
        self.task.take().unwrap().join().unwrap();
    }
}
fn engine(root: &Path) -> Installer {
    let home = root.join("user");
    fs::create_dir_all(&home).unwrap();
    Installer {
        paths: Paths {
            hexbot_home: home.join(".hexbot"),
            home,
            apps_override: Some(root.join("apps")),
            opt_override: None,
            service_root: root.join("services"),
            service_no_load: true,
        },
        target: Target::WindowsX86_64,
        base_url: "file:///never-contact-a-server".into(),
    }
}
fn owned_app(engine: &Installer, id: &str, version: &str) -> PathBuf {
    let path = engine.paths.apps_override.as_ref().unwrap().join(id);
    fs::create_dir_all(path.join("resources")).unwrap();
    fs::write(
        path.join(if id.starts_with("app.hexbot.client") {
            "HexbotClient.exe"
        } else {
            "Hexbot.exe"
        }),
        "managed fixture",
    )
    .unwrap();
    fs::write(
        path.join(".hexbot-app.json"),
        json!({"appId":id}).to_string(),
    )
    .unwrap();
    let package = serde_json::to_vec(&json!({"version":version})).unwrap();
    let header =
        serde_json::to_vec(&json!({"files":{"package.json":{"offset":"0","size":package.len()}}}))
            .unwrap();
    let size = (header.len() + 11) & !3;
    let mut bytes = Vec::new();
    for word in [4, size as u32, (size - 4) as u32, header.len() as u32] {
        bytes.extend(word.to_le_bytes());
    }
    bytes.extend(header);
    bytes.resize(size + 8, 0);
    bytes.extend(package);
    fs::write(path.join("resources/app.asar"), bytes).unwrap();
    path
}

#[test]
fn direct_receiptless_repair_uses_the_owned_edition_and_current_packaged_track() {
    for option in [InstallOption::Client, InstallOption::Full] {
        for original_nightly in [false, true] {
            for (version, track) in [
                ("1.2.3", Track::Stable),
                ("1.2.3-nightly.20261023.1", Track::Nightly),
            ] {
                let root = tempfile::tempdir().unwrap();
                let mut engine = engine(root.path());
                let id = format!(
                    "app.hexbot.{}{}",
                    if option == InstallOption::Client {
                        "client"
                    } else {
                        "desktop"
                    },
                    if original_nightly { ".nightly" } else { "" }
                );
                let app = owned_app(&engine, &id, version);
                let server = Server::new(|_| BTreeMap::new());
                engine.base_url = server.base.clone();
                // A deliberately unpublished update stops before NSIS. Getting
                // this exact request proves the public Repair action recovered
                // the installed track directly, without a preceding apply().
                assert!(engine.repair(&mut |_| {}).is_err());
                assert_eq!(
                    *server.requests.lock().unwrap(),
                    [format!("/install/{track}.json")]
                );
                assert_eq!(engine.detect().unwrap().apps[0].option, option);
                assert!(app.is_dir());
                assert!(!engine.paths.receipt().exists());
            }
        }
    }
}

#[test]
fn receiptless_repair_refuses_ambiguous_foreign_incomplete_and_unrecognized_apps() {
    for case in [
        "none",
        "foreign",
        "malformed",
        "partial-uninstall",
        "bad-version",
        "unexpected-folder",
        "dev",
        "multiple",
    ] {
        let root = tempfile::tempdir().unwrap();
        let engine = engine(root.path());
        if case != "none" {
            let app = owned_app(
                &engine,
                if case == "dev" {
                    "app.hexbot.client.dev"
                } else {
                    "app.hexbot.client"
                },
                "1.2.3",
            );
            match case {
                "foreign" => fs::write(
                    app.join(".hexbot-app.json"),
                    br#"{"appId":"org.example.foreign"}"#,
                )
                .unwrap(),
                "malformed" => fs::write(app.join(".hexbot-app.json"), "not json").unwrap(),
                "partial-uninstall" => fs::remove_file(app.join("HexbotClient.exe")).unwrap(),
                "bad-version" => {
                    fs::write(app.join("resources/app.asar"), "unknown bytes").unwrap()
                }
                "unexpected-folder" => {
                    fs::rename(&app, app.with_file_name("unrelated-folder")).unwrap()
                }
                "multiple" => {
                    owned_app(&engine, "app.hexbot.desktop", "1.2.3");
                }
                _ => {}
            }
        }
        let error = engine.repair(&mut |_| {}).unwrap_err().to_string();
        assert!(
            error.contains("Choose the option and track"),
            "{case}: {error}"
        );
        assert!(!engine.paths.receipt().exists());
    }
}

#[test]
fn an_existing_receipt_keeps_its_option_and_track_even_with_multiple_apps() {
    let root = tempfile::tempdir().unwrap();
    let mut engine = engine(root.path());
    owned_app(&engine, "app.hexbot.client", "1.2.3");
    owned_app(&engine, "app.hexbot.desktop", "1.2.3");
    let receipt = Receipt {
        option: InstallOption::Client,
        channel: Track::Nightly,
        version: "1.2.3".into(),
        paths: Vec::new(),
        installed_at: "fixture".into(),
    };
    fs::create_dir_all(engine.paths.receipt().parent().unwrap()).unwrap();
    fs::write(
        engine.paths.receipt(),
        serde_json::to_vec(&receipt).unwrap(),
    )
    .unwrap();
    let server = Server::new(|_| BTreeMap::new());
    engine.base_url = server.base.clone();
    assert!(engine.repair(&mut |_| {}).is_err());
    assert_eq!(*server.requests.lock().unwrap(), ["/install/nightly.json"]);
    let unchanged = hexbot_installer::read_receipt(&engine.paths.receipt())
        .unwrap()
        .unwrap();
    assert_eq!(unchanged.option, InstallOption::Client);
    assert_eq!(unchanged.channel, Track::Nightly);
}

#[test]
fn receiptless_repair_rechecks_ownership_under_the_install_lock() {
    use base64::{Engine, engine::general_purpose::STANDARD};
    use sha2::{Digest, Sha512};
    let root = tempfile::tempdir().unwrap();
    let mut engine = engine(root.path());
    let app = owned_app(&engine, "app.hexbot.client", "1.2.3");
    let server = Server::new(|base| {
        let bytes = b"not executed".to_vec();
        let manifest = serde_json::to_vec(&json!({"schema":1,"channel":"stable","version":"1.2.3","minInstaller":"0.0.1","targets":{"windows-x86_64":{"client":{"url":format!("{base}/client.exe"),"size":bytes.len(),"sha512":STANDARD.encode(Sha512::digest(&bytes)),"format":"exe","appId":"app.hexbot.client","productName":"Hexbot Client [alpha]"}}}})).unwrap();
        BTreeMap::from([
            ("/install/stable.json".into(), manifest.clone()),
            (
                "/install/1.2.3/stable.json.sig".into(),
                hexbot_installer::update_signature::test_signature(&manifest).into_bytes(),
            ),
            ("/client.exe".into(), bytes),
        ])
    });
    engine.base_url = server.base.clone();
    let result = engine.repair(&mut |event| {
        if event.stage == "verify" {
            fs::remove_file(app.join(".hexbot-app.json")).unwrap();
        }
    });
    assert!(
        result
            .unwrap_err()
            .to_string()
            .contains("Choose the option and track")
    );
    assert_eq!(
        fs::read_to_string(app.join("HexbotClient.exe")).unwrap(),
        "managed fixture"
    );
    assert!(
        server
            .requests
            .lock()
            .unwrap()
            .iter()
            .any(|path| path == "/client.exe")
    );
    assert!(!engine.paths.receipt().exists());
}
