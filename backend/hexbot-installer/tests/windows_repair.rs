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
        Self::with_request(files, |_| {})
    }
    fn with_request(
        files: impl FnOnce(&str) -> BTreeMap<String, Vec<u8>>,
        mut on_request: impl FnMut(&str) + Send + 'static,
    ) -> Self {
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
                on_request(&path);
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
                let detected = engine.detect().unwrap();
                assert_eq!(detected.apps[0].version.as_deref(), Some(version));
                let identity_track = if original_nightly {
                    Track::Nightly
                } else {
                    Track::Stable
                };
                assert_eq!(detected.track(), (identity_track == track).then_some(track));
                let server = Server::new(|_| BTreeMap::new());
                engine.base_url = server.base.clone();
                // A deliberately unpublished update stops before NSIS. Getting
                // this exact request proves the public Repair action recovered
                // the installed track directly, without a preceding apply().
                assert!(engine.repair(&mut |_| {}).is_err());
                if identity_track == track {
                    assert_eq!(
                        *server.requests.lock().unwrap(),
                        [format!("/install/{track}.json")]
                    );
                } else {
                    assert!(
                        server.requests.lock().unwrap().is_empty(),
                        "Mixed identity must not download or create a sibling"
                    );
                }
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
fn repair_uses_owned_marker_track_despite_a_stale_receipt() {
    for option in [InstallOption::Client, InstallOption::Full] {
        for (id_suffix, version, stale, expected) in [
            ("", "1.2.3", Track::Nightly, Track::Stable),
            (
                ".nightly",
                "1.2.3-nightly.20261023.1",
                Track::Stable,
                Track::Nightly,
            ),
        ] {
            let root = tempfile::tempdir().unwrap();
            let mut engine = engine(root.path());
            let id = format!(
                "app.hexbot.{}{id_suffix}",
                if option == InstallOption::Client {
                    "client"
                } else {
                    "desktop"
                }
            );
            let app = owned_app(&engine, &id, version);
            owned_app(
                &engine,
                if option == InstallOption::Client {
                    "app.hexbot.desktop"
                } else {
                    "app.hexbot.client"
                },
                "1.0.0",
            );
            let receipt = Receipt {
                option,
                channel: stale,
                version: "1.0.0".into(),
                paths: vec![app.clone()],
                installed_at: "fixture".into(),
            };
            fs::create_dir_all(engine.paths.receipt().parent().unwrap()).unwrap();
            let bytes = serde_json::to_vec(&receipt).unwrap();
            fs::write(engine.paths.receipt(), &bytes).unwrap();
            let server = Server::new(|_| BTreeMap::new());
            engine.base_url = server.base.clone();
            assert!(engine.repair(&mut |_| {}).is_err());
            assert_eq!(
                *server.requests.lock().unwrap(),
                [format!("/install/{expected}.json")]
            );
            assert_eq!(engine.detect().unwrap().track(), Some(expected));
            assert_eq!(fs::read(engine.paths.receipt()).unwrap(), bytes);
        }
    }
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

#[test]
fn damaged_payload_repair_requires_matching_receipt_marker_and_exact_path() {
    use base64::{Engine, engine::general_purpose::STANDARD};
    use sha2::{Digest, Sha512};
    for option in [InstallOption::Client, InstallOption::Full] {
        for (track, version, suffix) in [
            (Track::Stable, "1.2.3", ""),
            (Track::Nightly, "1.2.3-nightly.20261023.1", ".nightly"),
        ] {
            for missing in ["exe", "asar"] {
                let controls = [
                    "matching",
                    "no-receipt",
                    "wrong-option",
                    "wrong-track",
                    "wrong-path",
                    "foreign-marker",
                    "missing-marker",
                    "swapped-marker",
                    "payload-directory",
                ];
                #[cfg(unix)]
                let controls = [controls.as_slice(), &["payload-link"]].concat();
                for control in controls {
                    let root = tempfile::tempdir().unwrap();
                    let mut engine = engine(root.path());
                    let id = format!(
                        "app.hexbot.{}{suffix}",
                        if option == InstallOption::Client {
                            "client"
                        } else {
                            "desktop"
                        }
                    );
                    let app = owned_app(&engine, &id, version);
                    let payload = if missing == "asar" {
                        "resources/app.asar"
                    } else if option == InstallOption::Client {
                        "HexbotClient.exe"
                    } else {
                        "Hexbot.exe"
                    };
                    fs::remove_file(app.join(payload)).unwrap();
                    if control == "payload-directory" {
                        fs::create_dir(app.join(payload)).unwrap();
                    }
                    #[cfg(unix)]
                    if control == "payload-link" {
                        let outside = root.path().join("outside-payload");
                        fs::write(&outside, "foreign bytes").unwrap();
                        std::os::unix::fs::symlink(&outside, app.join(payload)).unwrap();
                    }
                    let receipt = Receipt {
                        option: if control == "wrong-option" {
                            InstallOption::Headless
                        } else {
                            option
                        },
                        channel: if control == "wrong-track" {
                            if track == Track::Stable {
                                Track::Nightly
                            } else {
                                Track::Stable
                            }
                        } else {
                            track
                        },
                        version: version.into(),
                        paths: vec![if control == "wrong-path" {
                            root.path().join("foreign")
                        } else {
                            app.clone()
                        }],
                        installed_at: "fixture".into(),
                    };
                    if control != "no-receipt" {
                        fs::create_dir_all(engine.paths.receipt().parent().unwrap()).unwrap();
                        fs::write(
                            engine.paths.receipt(),
                            serde_json::to_vec(&receipt).unwrap(),
                        )
                        .unwrap();
                    }
                    if control == "foreign-marker" {
                        fs::write(
                            app.join(".hexbot-app.json"),
                            br#"{"appId":"org.example.foreign"}"#,
                        )
                        .unwrap();
                    }
                    if control == "missing-marker" {
                        fs::remove_file(app.join(".hexbot-app.json")).unwrap();
                    }
                    let server = Server::new(|base| {
                        let bytes = b"deliberately invalid NSIS fixture".to_vec();
                        let key = if option == InstallOption::Client {
                            "client"
                        } else {
                            "full"
                        };
                        let manifest = serde_json::to_vec(&json!({"schema":1,"channel":track,"version":version,"minInstaller":"0.0.1","targets":{"windows-x86_64":{key:{"url":format!("{base}/app.exe"),"size":bytes.len(),"sha512":STANDARD.encode(Sha512::digest(&bytes)),"format":"exe","appId":id,"productName":"Hexbot"}}}})).unwrap();
                        BTreeMap::from([
                            (format!("/install/{track}.json"), manifest.clone()),
                            (
                                format!("/install/{version}/{track}.json.sig"),
                                hexbot_installer::update_signature::test_signature(&manifest)
                                    .into_bytes(),
                            ),
                            ("/app.exe".into(), bytes),
                        ])
                    });
                    engine.base_url = server.base.clone();
                    assert_eq!(
                        engine.detect().unwrap().apps.len(),
                        usize::from(matches!(
                            control,
                            "matching" | "wrong-track" | "swapped-marker"
                        )),
                        "damaged discovery {option:?}/{missing}/{control}"
                    );
                    let mut admitted = false;
                    // Explicit apply selects the same app/track; valid-receipt
                    // repair follows this exact install path. Invalid fixtures
                    // stop at the OS boundary and never simulate NSIS success.
                    let result = engine.apply(option, track, &mut |event| {
                        if control == "swapped-marker" && event.stage == "verify" {
                            fs::write(app.join(".hexbot-app.json"), br#"{"appId":"foreign"}"#)
                                .unwrap();
                        }
                        if event.stage == "install" {
                            admitted = true;
                        }
                    });
                    assert!(result.is_err());
                    assert_eq!(
                        admitted,
                        matches!(control, "matching" | "wrong-track"),
                        "{option:?} missing {missing} control {control}"
                    );
                    assert_eq!(app.join(payload).is_dir(), control == "payload-directory");
                }
            }
        }
    }
}

#[test]
fn damaged_receipted_app_is_detected_for_uninstall() {
    for option in [InstallOption::Client, InstallOption::Full] {
        for payload in ["exe", "resources/app.asar"] {
            let root = tempfile::tempdir().unwrap();
            let engine = engine(root.path());
            let id = if option == InstallOption::Client {
                "app.hexbot.client"
            } else {
                "app.hexbot.desktop"
            };
            let app = owned_app(&engine, id, "1.2.3");
            fs::remove_file(app.join(if payload == "exe" {
                if option == InstallOption::Client {
                    "HexbotClient.exe"
                } else {
                    "Hexbot.exe"
                }
            } else {
                payload
            }))
            .unwrap();
            let receipt = Receipt {
                option,
                channel: Track::Stable,
                version: "1.2.3".into(),
                paths: vec![app.clone()],
                installed_at: "fixture".into(),
            };
            fs::create_dir_all(engine.paths.receipt().parent().unwrap()).unwrap();
            fs::write(
                engine.paths.receipt(),
                serde_json::to_vec(&receipt).unwrap(),
            )
            .unwrap();
            assert_eq!(
                engine.detect().unwrap().apps.len(),
                1,
                "{option:?}/{payload}"
            );
            fs::remove_file(engine.paths.receipt()).unwrap();
            assert!(engine.detect().unwrap().apps.is_empty());
        }
    }
}

#[test]
fn uninstall_refuses_windows_ownership_errors_before_removing_receipt_or_runtime() {
    for case in ["unrecognized-script", "other-home", "absent"] {
        let foreign = case != "absent";
        let root = tempfile::tempdir().unwrap();
        let engine = engine(root.path());
        let native = engine
            .paths
            .hexbot_home
            .join("runtime/native/build/hexbot.exe");
        fs::create_dir_all(native.parent().unwrap()).unwrap();
        fs::write(&native, "owned runtime sentinel").unwrap();
        let receipt = Receipt {
            option: InstallOption::Headless,
            channel: Track::Stable,
            version: "1.2.3".into(),
            paths: vec![native.clone()],
            installed_at: "fixture".into(),
        };
        let receipt_bytes = serde_json::to_vec(&receipt).unwrap();
        fs::write(engine.paths.receipt(), &receipt_bytes).unwrap();
        let file = engine.paths.service_file(engine.target);
        if foreign {
            fs::create_dir_all(file.parent().unwrap()).unwrap();
            let text = if case == "other-home" {
                format!(
                    "# Hexbot owned home: {}\n",
                    serde_json::to_string(&root.path().join("another home")).unwrap()
                )
            } else {
                "unrelated service script".into()
            };
            fs::write(&file, text).unwrap();
        }
        let script = fs::read(&file).ok();
        let mut done = false;
        let result = engine.uninstall(false, &mut |p| done |= p.stage == "done");
        if foreign {
            assert!(
                result.is_err(),
                "Uninstall reported success after an ownership error"
            );
            assert!(!done);
            assert_eq!(fs::read(engine.paths.receipt()).unwrap(), receipt_bytes);
            assert_eq!(
                fs::read_to_string(&native).unwrap(),
                "owned runtime sentinel"
            );
            assert_eq!(fs::read(file).ok(), script);
        } else {
            result.unwrap();
            assert!(done);
            assert!(!engine.paths.receipt().exists());
            assert!(!native.exists());
        }
    }
}

#[test]
fn change_to_client_refuses_hidden_service_ownership_errors_before_download() {
    for from in [InstallOption::Full, InstallOption::Headless] {
        for case in ["unrecognized-script", "other-home", "absent", "owned"] {
            let root = tempfile::tempdir().unwrap();
            let mut engine = engine(root.path());
            let app = owned_app(&engine, "app.hexbot.desktop", "1.2.3");
            let native = engine
                .paths
                .hexbot_home
                .join("runtime/native/build/hexbot.exe");
            fs::create_dir_all(native.parent().unwrap()).unwrap();
            fs::write(&native, "runtime sentinel").unwrap();
            let receipt = Receipt {
                option: from,
                channel: Track::Stable,
                version: "1.2.3".into(),
                paths: vec![if from == InstallOption::Full {
                    app.clone()
                } else {
                    native.clone()
                }],
                installed_at: "fixture".into(),
            };
            fs::write(
                engine.paths.receipt(),
                serde_json::to_vec(&receipt).unwrap(),
            )
            .unwrap();
            let file = engine.paths.service_file(engine.target);
            fs::create_dir_all(file.parent().unwrap()).unwrap();
            if case != "absent" {
                let owner = if case == "other-home" {
                    root.path().join("other home")
                } else {
                    engine.paths.hexbot_home.clone()
                };
                fs::write(
                    &file,
                    if case == "unrecognized-script" {
                        "unrelated script".into()
                    } else {
                        format!(
                            "# Hexbot owned home: {}\n",
                            serde_json::to_string(&owner).unwrap()
                        )
                    },
                )
                .unwrap();
            }
            let xml = file.with_extension("xml");
            fs::write(&xml, "XML sentinel").unwrap();
            let before: Vec<_> = [
                engine.paths.receipt(),
                native,
                app.join("Hexbot.exe"),
                app.join("resources/app.asar"),
                app.join(".hexbot-app.json"),
                file,
                xml,
            ]
            .into_iter()
            .map(|p| {
                let bytes = fs::read(&p).ok();
                (p, bytes)
            })
            .collect();
            let server = Server::new(|_| BTreeMap::new());
            engine.base_url = server.base.clone();
            let mut stages = Vec::new();
            let error = engine
                .change(
                    from,
                    InstallOption::Client,
                    Track::Stable,
                    &mut |_| true,
                    &mut |p| stages.push(p.stage),
                )
                .unwrap_err();
            if matches!(case, "unrecognized-script" | "other-home") {
                assert!(
                    error.to_string().contains("another installation"),
                    "{from:?}/{case}: {error}"
                );
                assert!(
                    server.requests.lock().unwrap().is_empty(),
                    "{from:?}/{case}"
                );
            } else {
                // An unpublished manifest stops the valid/absent controls before NSIS.
                assert_eq!(*server.requests.lock().unwrap(), ["/install/stable.json"]);
            }
            assert!(stages.is_empty());
            for (p, bytes) in before {
                assert_eq!(fs::read(&p).ok(), bytes, "{} changed", p.display());
            }
        }
    }
}

#[test]
fn change_rechecks_service_ownership_after_download_under_the_install_lock() {
    use base64::{Engine, engine::general_purpose::STANDARD};
    use sha2::{Digest, Sha512};
    for from in [InstallOption::Full, InstallOption::Headless] {
        let root = tempfile::tempdir().unwrap();
        let mut engine = engine(root.path());
        let app = owned_app(&engine, "app.hexbot.desktop", "1.2.3");
        let native = engine
            .paths
            .hexbot_home
            .join("runtime/native/build/hexbot.exe");
        fs::create_dir_all(native.parent().unwrap()).unwrap();
        fs::write(&native, "runtime sentinel").unwrap();
        let receipt = Receipt {
            option: from,
            channel: Track::Stable,
            version: "1.2.3".into(),
            paths: vec![if from == InstallOption::Full {
                app.clone()
            } else {
                native.clone()
            }],
            installed_at: "fixture".into(),
        };
        let receipt_bytes = serde_json::to_vec(&receipt).unwrap();
        fs::write(engine.paths.receipt(), &receipt_bytes).unwrap();
        let file = engine.paths.service_file(engine.target);
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        let marker = format!(
            "# Hexbot owned home: {}\n",
            serde_json::to_string(&engine.paths.hexbot_home).unwrap()
        );
        fs::write(&file, marker).unwrap();
        let xml = file.with_extension("xml");
        fs::write(&xml, "XML sentinel").unwrap();
        let before: Vec<_> = [
            engine.paths.receipt(),
            native,
            app.join("Hexbot.exe"),
            app.join("resources/app.asar"),
            app.join(".hexbot-app.json"),
            xml,
        ]
        .into_iter()
        .map(|p| {
            let b = fs::read(&p).unwrap();
            (p, b)
        })
        .collect();
        let changed = file.clone();
        let server = Server::with_request(
            |url| {
                let bytes = b"verified NSIS boundary fixture".to_vec();
                let manifest=serde_json::to_vec(&json!({"schema":1,"channel":"stable","version":"1.2.3","minInstaller":"0.0.1","targets":{"windows-x86_64":{"client":{"url":format!("{url}/app.exe"),"size":bytes.len(),"sha512":STANDARD.encode(Sha512::digest(&bytes)),"format":"exe","appId":"app.hexbot.client","productName":"Hexbot Client"}}}})).unwrap();
                BTreeMap::from([
                    ("/install/stable.json".into(), manifest.clone()),
                    (
                        "/install/1.2.3/stable.json.sig".into(),
                        hexbot_installer::update_signature::test_signature(&manifest).into_bytes(),
                    ),
                    ("/app.exe".into(), bytes),
                ])
            },
            move |path| {
                // The response body cannot finish before this ownership swap. The
                // installer must reacquire/validate ownership after that boundary.
                if path == "/app.exe" {
                    fs::write(&changed, "foreign service inserted during download").unwrap();
                }
            },
        );
        engine.base_url = server.base.clone();
        let mut stages = Vec::new();
        let error = engine
            .change(
                from,
                InstallOption::Client,
                Track::Stable,
                &mut |_| true,
                &mut |p| stages.push(p.stage),
            )
            .unwrap_err();
        assert!(
            error.to_string().contains("another installation"),
            "{from:?}: {error}"
        );
        assert!(
            server
                .requests
                .lock()
                .unwrap()
                .iter()
                .any(|p| p == "/app.exe")
        );
        assert!(stages.iter().any(|s| s == "verify"));
        assert!(
            !stages
                .iter()
                .any(|s| matches!(s.as_str(), "install" | "remove" | "done")),
            "{stages:?}"
        );
        assert_eq!(
            fs::read_to_string(&file).unwrap(),
            "foreign service inserted during download"
        );
        for (p, b) in before {
            assert_eq!(fs::read(&p).unwrap(), b, "{} changed", p.display());
        }
        assert!(
            !engine
                .paths
                .apps_override
                .as_ref()
                .unwrap()
                .join("app.hexbot.client")
                .exists()
        );
    }
}

#[test]
fn receipted_repair_falls_back_for_missing_or_corrupt_ordinary_package_metadata() {
    for option in [InstallOption::Client, InstallOption::Full] {
        for track in [Track::Stable, Track::Nightly] {
            for case in [
                "missing",
                "corrupt-header",
                "corrupt-json",
                "invalid-version",
                "foreign",
                "wrong-path",
                "ambiguous",
                "directory",
                "no-receipt",
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
                    if track == Track::Nightly {
                        ".nightly"
                    } else {
                        ""
                    }
                );
                let app = owned_app(&engine, &id, "invalid");
                let receipt = Receipt {
                    option,
                    channel: track,
                    version: "1.0.0".into(),
                    paths: vec![app.clone()],
                    installed_at: "fixture".into(),
                };
                fs::create_dir_all(engine.paths.receipt().parent().unwrap()).unwrap();
                let mut receipt_json = serde_json::to_value(&receipt).unwrap();
                let asar = app.join("resources/app.asar");
                match case {
                    "missing" => fs::remove_file(&asar).unwrap(),
                    "corrupt-header" => fs::write(&asar, b"unknown bytes").unwrap(),
                    "corrupt-json" => {
                        let mut bytes = fs::read(&asar).unwrap();
                        *bytes.last_mut().unwrap() = b'!';
                        fs::write(&asar, bytes).unwrap();
                    }
                    "invalid-version" | "no-receipt" => {}
                    "foreign" => {
                        fs::write(app.join(".hexbot-app.json"), br#"{"appId":"org.foreign"}"#)
                            .unwrap()
                    }
                    "wrong-path" => receipt_json["paths"] = json!([root.path().join("unrelated")]),
                    "ambiguous" => {
                        let second_id = if let Some(base) = id.strip_suffix(".nightly") {
                            base.to_owned()
                        } else {
                            format!("{id}.nightly")
                        };
                        let second = owned_app(&engine, &second_id, "invalid");
                        receipt_json["paths"] = json!([app, second]);
                    }
                    "directory" => {
                        fs::remove_file(&asar).unwrap();
                        fs::create_dir(&asar).unwrap();
                    }
                    _ => unreachable!(),
                }
                if case != "no-receipt" {
                    fs::write(
                        engine.paths.receipt(),
                        serde_json::to_vec(&receipt_json).unwrap(),
                    )
                    .unwrap();
                }
                let server = Server::new(|_| BTreeMap::new());
                engine.base_url = server.base.clone();
                let mut messages = Vec::new();
                let error = engine
                    .repair(&mut |p| messages.push(p.message.clone()))
                    .unwrap_err();
                if matches!(
                    case,
                    "missing" | "corrupt-header" | "corrupt-json" | "invalid-version"
                ) {
                    assert_eq!(
                        *server.requests.lock().unwrap(),
                        [format!("/install/{track}.json")],
                        "{option:?}/{track:?}/{case}: {error}"
                    );
                    assert!(
                        messages
                            .iter()
                            .any(|m| m.contains("The app version could not be read")
                                && m.contains("Repairing this app's"))
                    );
                } else {
                    assert!(
                        server.requests.lock().unwrap().is_empty(),
                        "{option:?}/{track:?}/{case}"
                    );
                }
            }
        }
    }
}

#[test]
fn receipted_repair_does_not_mask_package_access_errors() {
    let root = tempfile::tempdir().unwrap();
    let mut engine = engine(root.path());
    let server = Server::new(|_| BTreeMap::new());
    engine.base_url = server.base.clone();
    let app = owned_app(&engine, "app.hexbot.client", "1.2.3");
    let asar = app.join("resources/app.asar");
    let receipt = Receipt {
        option: InstallOption::Client,
        channel: Track::Stable,
        version: "1.2.3".into(),
        paths: vec![app.clone()],
        installed_at: "fixture".into(),
    };
    fs::create_dir_all(engine.paths.receipt().parent().unwrap()).unwrap();
    fs::write(
        engine.paths.receipt(),
        serde_json::to_vec(&receipt).unwrap(),
    )
    .unwrap();
    let unchanged: Vec<_> = [
        engine.paths.receipt(),
        asar.clone(),
        app.join(".hexbot-app.json"),
        app.join("HexbotClient.exe"),
    ]
    .into_iter()
    .map(|path| {
        let bytes = fs::read(&path).unwrap();
        (path, bytes)
    })
    .collect();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if unsafe { libc::geteuid() } == 0 {
            eprintln!("Access-denial control requires non-root file semantics");
            return;
        }
        fs::set_permissions(&asar, fs::Permissions::from_mode(0o000)).unwrap();
    }
    #[cfg(windows)]
    let exclusive = {
        use std::os::windows::fs::OpenOptionsExt;
        fs::OpenOptions::new()
            .read(true)
            .write(true)
            .share_mode(0)
            .open(&asar)
            .unwrap()
    };
    let direct = fs::File::open(&asar).unwrap_err();
    #[cfg(windows)]
    {
        // Rust 1.97.1 leaves ERROR_SHARING_VIOLATION uncategorized; this
        // exclusive-handle fixture must produce that exact error, not EACCES.
        assert_eq!(direct.raw_os_error(), Some(32), "{direct:?}");
        assert_eq!(direct.kind(), std::io::Error::from_raw_os_error(32).kind());
    }
    #[cfg(unix)]
    assert_eq!(direct.kind(), std::io::ErrorKind::PermissionDenied);
    let mut stages = Vec::new();
    let error = engine.repair(&mut |p| stages.push(p.stage)).unwrap_err();
    let repair = error
        .downcast_ref::<std::io::Error>()
        .expect("Filesystem error must remain distinguishable");
    eprintln!(
        "Package access refusal: direct raw={:?} kind={:?}; repair raw={:?} kind={:?}",
        direct.raw_os_error(),
        direct.kind(),
        repair.raw_os_error(),
        repair.kind()
    );
    assert_eq!(repair.raw_os_error(), direct.raw_os_error());
    assert_eq!(repair.kind(), direct.kind());
    assert!(
        stages.is_empty(),
        "Repair must refuse before fallback/NSIS: {stages:?}"
    );
    assert!(server.requests.lock().unwrap().is_empty());
    #[cfg(windows)]
    drop(exclusive);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&asar, fs::Permissions::from_mode(0o600)).unwrap();
    }
    // Releasing the fixture restores access without a repair or any file writes.
    for (path, bytes) in unchanged {
        assert_eq!(
            fs::read(&path).unwrap(),
            bytes,
            "{} changed",
            path.display()
        );
    }
}

#[test]
fn mixed_identity_repair_never_downloads_or_reaches_a_sibling_nsis_destination() {
    use base64::{Engine, engine::general_purpose::STANDARD};
    use sha2::{Digest, Sha512};
    for option in [InstallOption::Client, InstallOption::Full] {
        for original_nightly in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let mut engine = engine(root.path());
            let base = if option == InstallOption::Client {
                "app.hexbot.client"
            } else {
                "app.hexbot.desktop"
            };
            let original = format!("{base}{}", if original_nightly { ".nightly" } else { "" });
            let offered = format!("{base}{}", if original_nightly { "" } else { ".nightly" });
            let (track, version) = if original_nightly {
                (Track::Stable, "1.2.3")
            } else {
                (Track::Nightly, "1.2.3-nightly.20261023.1")
            };
            let app = owned_app(&engine, &original, version);
            let server = Server::new(|url| {
                let bytes = b"verified but must never execute".to_vec();
                let key = if option == InstallOption::Client {
                    "client"
                } else {
                    "full"
                };
                let manifest=serde_json::to_vec(&json!({"schema":1,"channel":track,"version":version,"minInstaller":"0.0.1","targets":{"windows-x86_64":{key:{"url":format!("{url}/app.exe"),"size":bytes.len(),"sha512":STANDARD.encode(Sha512::digest(&bytes)),"format":"exe","appId":offered,"productName":"Hexbot"}}}})).unwrap();
                BTreeMap::from([
                    (format!("/install/{track}.json"), manifest.clone()),
                    (
                        format!("/install/{version}/{track}.json.sig"),
                        hexbot_installer::update_signature::test_signature(&manifest).into_bytes(),
                    ),
                    ("/app.exe".into(), bytes),
                ])
            });
            engine.base_url = server.base.clone();
            let mut invoked = false;
            let error = engine
                .repair(&mut |p| invoked |= p.stage == "install")
                .unwrap_err();
            eprintln!(
                "Mixed fixture original={original}, offered={offered}, nsisReached={invoked}, requests={:?}, error={error}",
                server.requests.lock().unwrap()
            );
            assert!(!invoked);
            assert!(server.requests.lock().unwrap().is_empty());
            assert!(
                error
                    .to_string()
                    .contains("identity and packaged track disagree")
            );
            assert!(app.is_dir());
            assert!(
                !engine
                    .paths
                    .apps_override
                    .as_ref()
                    .unwrap()
                    .join(offered)
                    .exists()
            );
            assert!(!engine.paths.receipt().exists());
        }
    }
}

#[test]
fn no_load_owned_script_is_recoverable_without_claiming_scheduler_installation() {
    let root = tempfile::tempdir().unwrap();
    let engine = engine(root.path());
    fs::create_dir_all(&engine.paths.hexbot_home).unwrap();
    let script = engine.paths.service_file(engine.target);
    fs::create_dir_all(script.parent().unwrap()).unwrap();
    fs::write(
        &script,
        format!(
            "# Hexbot owned home: {}\n",
            serde_json::to_string(&engine.paths.hexbot_home).unwrap()
        ),
    )
    .unwrap();
    let installed = engine.detect().unwrap();
    assert!(
        !installed.service,
        "Owned metadata alone is not a registered scheduler task"
    );
    assert_eq!(installed.option(), Some(InstallOption::Headless));
}

#[test]
fn missing_directory_repair_keeps_the_exact_receipt_identity_and_track() {
    for option in [InstallOption::Full, InstallOption::Client] {
        for track in [Track::Stable, Track::Nightly] {
            let root = tempfile::tempdir().unwrap();
            let mut installer = engine(root.path());
            let id = format!(
                "app.hexbot.{}{}",
                if option == InstallOption::Full {
                    "desktop"
                } else {
                    "client"
                },
                if track == Track::Nightly {
                    ".nightly"
                } else {
                    ""
                }
            );
            let path = installer.paths.apps_override.as_ref().unwrap().join(id);
            fs::create_dir_all(&installer.paths.hexbot_home).unwrap();
            let receipt = Receipt {
                option,
                channel: track,
                version: if track == Track::Nightly {
                    "1.2.3-nightly.1"
                } else {
                    "1.2.3"
                }
                .into(),
                paths: vec![path],
                installed_at: "fixture".into(),
            };
            let bytes = serde_json::to_vec(&receipt).unwrap();
            fs::write(installer.paths.receipt(), &bytes).unwrap();
            let server = Server::new(|_| BTreeMap::new());
            installer.base_url = server.base.clone();
            assert_eq!(installer.detect().unwrap().track(), Some(track));
            let error = installer.repair(&mut |_| {}).unwrap_err();
            assert!(error.to_string().contains("404"), "{error}");
            assert_eq!(
                *server.requests.lock().unwrap(),
                vec![format!("/install/{track}.json")]
            );
            assert_eq!(fs::read(installer.paths.receipt()).unwrap(), bytes);
            assert!(!installer.paths.apps_override.as_ref().unwrap().exists());
        }
    }
}

#[test]
fn absent_receipt_never_claims_existing_foreign_paths_or_a_swapped_download_destination() {
    use base64::{Engine, engine::general_purpose::STANDARD};
    use sha2::{Digest, Sha512};
    for case in [
        "directory",
        "file",
        "wrong-path",
        "wrong-version-track",
        "extra-path",
        "during-download",
    ] {
        let root = tempfile::tempdir().unwrap();
        let mut installer = engine(root.path());
        let app = installer
            .paths
            .apps_override
            .as_ref()
            .unwrap()
            .join("app.hexbot.client.nightly");
        let receipt = Receipt {
            option: InstallOption::Client,
            channel: Track::Nightly,
            version: "1.2.3-nightly.1".into(),
            paths: vec![app.clone()],
            installed_at: "fixture".into(),
        };
        let mut receipt = serde_json::to_value(receipt).unwrap();
        fs::create_dir_all(&installer.paths.hexbot_home).unwrap();
        match case {
            "directory" => {
                fs::create_dir_all(&app).unwrap();
                fs::write(app.join("foreign"), "retain").unwrap();
            }
            "file" => {
                fs::create_dir_all(app.parent().unwrap()).unwrap();
                fs::write(&app, "retain").unwrap();
            }
            "wrong-path" => receipt["paths"] = json!([root.path().join("foreign")]),
            "wrong-version-track" => receipt["version"] = json!("1.2.3"),
            "extra-path" => receipt["paths"] = json!([app, root.path().join("other")]),
            _ => {}
        }
        let receipt_bytes = serde_json::to_vec(&receipt).unwrap();
        fs::write(installer.paths.receipt(), &receipt_bytes).unwrap();
        let changed = app.clone();
        let server = Server::with_request(
            |base| {
                let bytes = b"never executed".to_vec();
                let manifest=serde_json::to_vec(&json!({"schema":1,"channel":"nightly","version":"1.2.3-nightly.1","minInstaller":"0.0.1","targets":{"windows-x86_64":{"client":{"url":format!("{base}/client.exe"),"size":bytes.len(),"sha512":STANDARD.encode(Sha512::digest(&bytes)),"format":"exe","appId":"app.hexbot.client.nightly","productName":"Hexbot Client Nightly"}}}})).unwrap();
                BTreeMap::from([
                    ("/install/nightly.json".into(), manifest.clone()),
                    (
                        "/install/1.2.3-nightly.1/nightly.json.sig".into(),
                        hexbot_installer::update_signature::test_signature(&manifest).into_bytes(),
                    ),
                    ("/client.exe".into(), bytes),
                ])
            },
            move |path| {
                if case == "during-download" && path == "/client.exe" {
                    fs::create_dir_all(&changed).unwrap();
                    fs::write(changed.join("foreign"), "inserted during download").unwrap();
                }
            },
        );
        installer.base_url = server.base.clone();
        let mut stages = Vec::new();
        assert!(installer.repair(&mut |p| stages.push(p.stage)).is_err());
        assert!(
            !stages
                .iter()
                .any(|s| matches!(s.as_str(), "install" | "done"))
        );
        assert_eq!(fs::read(installer.paths.receipt()).unwrap(), receipt_bytes);
        if case == "during-download" {
            assert!(
                server
                    .requests
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|p| p == "/client.exe")
            );
            assert_eq!(
                fs::read_to_string(app.join("foreign")).unwrap(),
                "inserted during download"
            );
        } else {
            assert!(server.requests.lock().unwrap().is_empty(), "{case}");
        }
    }
}

#[test]
fn another_complete_identity_is_not_ambiguity_for_a_valid_absent_receipt() {
    let root = tempfile::tempdir().unwrap();
    let mut installer = engine(root.path());
    let other = owned_app(&installer, "app.hexbot.desktop", "1.2.3");
    fs::create_dir_all(&installer.paths.hexbot_home).unwrap();
    let expected = installer
        .paths
        .apps_override
        .as_ref()
        .unwrap()
        .join("app.hexbot.client.nightly");
    let receipt = Receipt {
        option: InstallOption::Client,
        channel: Track::Nightly,
        version: "1.2.3-nightly.1".into(),
        paths: vec![expected],
        installed_at: "fixture".into(),
    };
    fs::write(
        installer.paths.receipt(),
        serde_json::to_vec(&receipt).unwrap(),
    )
    .unwrap();
    let server = Server::new(|_| BTreeMap::new());
    installer.base_url = server.base.clone();
    assert_eq!(installer.detect().unwrap().track(), Some(Track::Nightly));
    assert!(
        installer
            .repair(&mut |_| {})
            .unwrap_err()
            .to_string()
            .contains("404")
    );
    assert_eq!(*server.requests.lock().unwrap(), ["/install/nightly.json"]);
    assert!(other.is_dir());
}

#[cfg(unix)]
#[test]
fn missing_receipt_repair_refuses_linked_root_and_leaf_without_network() {
    for linked_root in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let mut installer = engine(root.path());
        let apps = installer.paths.apps_override.as_ref().unwrap();
        let app = apps.join("app.hexbot.client.nightly");
        let outside = root.path().join("unrelated");
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("retain"), "unchanged").unwrap();
        if linked_root {
            std::os::unix::fs::symlink(&outside, apps).unwrap();
        } else {
            fs::create_dir_all(apps).unwrap();
            std::os::unix::fs::symlink(&outside, &app).unwrap();
        }
        fs::create_dir_all(&installer.paths.hexbot_home).unwrap();
        let receipt = serde_json::to_vec(&Receipt {
            option: InstallOption::Client,
            channel: Track::Nightly,
            version: "1.2.3-nightly.1".into(),
            paths: vec![app],
            installed_at: "fixture".into(),
        })
        .unwrap();
        fs::write(installer.paths.receipt(), &receipt).unwrap();
        let server = Server::new(|_| BTreeMap::new());
        installer.base_url = server.base.clone();
        assert!(installer.repair(&mut |_| {}).is_err());
        assert!(server.requests.lock().unwrap().is_empty());
        assert_eq!(fs::read(installer.paths.receipt()).unwrap(), receipt);
        assert_eq!(
            fs::read_to_string(outside.join("retain")).unwrap(),
            "unchanged"
        );
    }
}
