#![allow(dead_code)]
use base64::{Engine, engine::general_purpose::STANDARD};
use hexbot_installer::{Artifact, InstallOption, Manifest, Paths, Target};
use sha2::{Digest, Sha256, Sha512};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    path::Path,
    process::{Command, Output},
    sync::{Arc, Mutex},
    thread,
};

/// Writes `install/<track>.json` and its release signature at
/// `install/<version>/<track>.json.sig`, as release.yml publishes them, signed
/// with the test key that debug builds trust.
pub fn publish(root: &Path, track: impl std::fmt::Display, manifest: &Manifest) {
    let bytes = serde_json::to_vec(manifest).unwrap();
    fs::write(root.join(format!("install/{track}.json")), &bytes).unwrap();
    let signatures = root.join(format!("install/{}", manifest.version));
    fs::create_dir_all(&signatures).unwrap();
    fs::write(
        signatures.join(format!("{track}.json.sig")),
        hexbot_installer::update_signature::test_signature(&bytes),
    )
    .unwrap();
}

pub fn paths(root: &Path) -> Paths {
    let home = root.join("home");
    fs::create_dir_all(&home).unwrap();
    Paths {
        opt_override: None,
        hexbot_home: home.join(".hexbot"),
        apps_override: Some(root.join("apps")),
        service_root: root.join("services"),
        service_no_load: true,
        home,
    }
}

pub fn executable(path: &Path, bytes: &[u8]) {
    use std::os::unix::fs::PermissionsExt;
    fs::write(path, bytes).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
}

pub fn bundle(path: &Path, id: &str) {
    fs::create_dir_all(path.join("Contents/MacOS")).unwrap();
    fs::write(path.join("Contents/Info.plist"), format!(r#"<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>{id}</string><key>CFBundleShortVersionString</key><string>0.0.1</string></dict></plist>"#)).unwrap();
    executable(&path.join("Contents/MacOS/Hexbot"), b"#!/bin/sh\nexit 0\n");
}

pub fn app_artifact(root: &Path, base: &str, option: InstallOption, target: Target) -> Artifact {
    app_artifact_for_track(root, base, option, target, false)
}

pub fn app_artifact_for_track(
    root: &Path,
    base: &str,
    option: InstallOption,
    target: Target,
    nightly: bool,
) -> Artifact {
    let (name, id, file) = if option == InstallOption::Full {
        ("Hexbot [alpha]", "app.hexbot.desktop", "full")
    } else {
        ("Hexbot Client [alpha]", "app.hexbot.client", "client")
    };
    let name = if nightly {
        name.replace(" [alpha]", " Nightly")
    } else {
        name.into()
    };
    let id = format!("{id}{}", if nightly { ".nightly" } else { "" });
    let extension = if target.is_macos() { "zip" } else { "AppImage" };
    let path = root.join(format!("{file}.{extension}"));
    if target.is_macos() {
        let source = root.join(format!("{name}.app"));
        bundle(&source, &id);
        assert!(
            Command::new("/usr/bin/ditto")
                .args(["-c", "-k", "--keepParent"])
                .arg(source)
                .arg(&path)
                .status()
                .unwrap()
                .success()
        );
    } else {
        executable(&path, b"#!/bin/sh\nexit 0\n");
    }
    let bytes = fs::read(&path).unwrap();
    Artifact {
        path: None,
        url: format!("{base}/{file}.{extension}"),
        sha256: None,
        sha512: Some(STANDARD.encode(Sha512::digest(&bytes))),
        size: bytes.len() as u64,
        format: Some(extension.into()),
        product_name: Some(name),
        app_id: Some(id),
    }
}

pub fn native_artifact(root: &Path, base: &str) -> Artifact {
    let bytes = br##"#!/bin/sh
set -eu
[ "$HEXBOT_SERVICE_NO_LOAD" = 1 ]
printf '%s\n' "$*" >> "$HOME/calls"
case "$(uname -s)" in
    Darwin) service="$HEXBOT_SERVICE_ROOT/Library/LaunchAgents/app.hexbot.daemon.plist" ;;
    *) service="$HEXBOT_SERVICE_ROOT/.config/systemd/user/hexbot.service" ;;
esac
case "$1" in
    setup)
        case "$0" in "$HEXBOT_HOME"/runtime/*/native/hexbot) ;; *) exit 73 ;; esac
        printf '%s\n' "$0" > "$HOME/staged-binary"
        if [ -f "$HOME/setup-error" ]; then
            printf '%s\n' '{"stage":"error","message":"Earlier error"}' '{"stage":"error","message":"Python could not be installed"}'
            exit 1
        fi
        [ "$*" = 'setup --activate --json' ]
        mkdir -p "$HEXBOT_HOME/runtime" "$HOME/.local/bin"
        cp "$0" "$HEXBOT_HOME/runtime/native-executable"
        chmod +x "$HEXBOT_HOME/runtime/native-executable"
        printf "#!/bin/sh\n# Hexbot CLI, written by hexbot setup\nexport HEXBOT_HOME='%s'\n" "$HEXBOT_HOME" > "$HOME/.local/bin/hexbot"
        printf '%s\n' '{"stage":"activate","message":"Activated the test daemon.","percent":100}'
        ;;
    lan) [ "$2" = on ]; touch "$HEXBOT_HOME/lan-on" ;;
    service)
        case "$2" in
            install)
                mkdir -p "$(dirname "$service")"
                case "$(uname -s)" in
                    Darwin) printf '<key>HEXBOT_HOME</key><string>%s</string><key>ProgramArguments</key><array><string>%s/runtime/native-executable</string></array>' "$HEXBOT_HOME" "$HEXBOT_HOME" > "$service" ;;
                    *) printf 'Environment=HEXBOT_HOME="%s"\nExecStart="%s/runtime/native-executable" serve\n' "$HEXBOT_HOME" "$HEXBOT_HOME" > "$service" ;;
                esac ;;
            stop) : ;;
            uninstall) rm -f "$service" ;;
            *) exit 1 ;;
        esac ;;
    status)
        if [ -f "$HOME/status-error" ]; then exit 1; fi
        if [ -f "$HOME/status-invalid" ]; then printf 'invalid'; exit 0; fi
        printf '%s\n' '{"running":false,"port":9119,"lan_enabled":true,"lan_addresses":["192.0.2.1"],"service":{"installed":true},"sandbox_available":false}' ;;
    *) exit 1 ;;
esac
"##;
    let archive = root.join("native.tar.gz");
    let encoder = flate2::write::GzEncoder::new(
        fs::File::create(&archive).unwrap(),
        flate2::Compression::default(),
    );
    let mut tar = tar::Builder::new(encoder);
    let mut header = tar::Header::new_gnu();
    header.set_size(bytes.len() as u64);
    header.set_mode(0o755);
    header.set_cksum();
    tar.append_data(&mut header, "hexbot", &bytes[..]).unwrap();
    tar.into_inner().unwrap().finish().unwrap();
    let bytes = fs::read(&archive).unwrap();
    Artifact {
        path: None,
        url: format!("{base}/native.tar.gz"),
        sha256: Some(format!("{:x}", Sha256::digest(&bytes))),
        sha512: None,
        size: bytes.len() as u64,
        format: Some("tar.gz".into()),
        product_name: None,
        app_id: None,
    }
}

pub struct Server {
    pub base: String,
    address: SocketAddr,
    thread: Option<thread::JoinHandle<()>>,
    pub requests: Arc<Mutex<Vec<String>>>,
}

impl Server {
    pub fn new(root: &Path) -> Self {
        let root = root.to_path_buf();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let recorded = requests.clone();
        let thread = thread::spawn(move || {
            for stream in listener.incoming() {
                let mut stream = stream.unwrap();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut first = String::new();
                reader.read_line(&mut first).unwrap();
                let path = first.split_whitespace().nth(1).unwrap_or("/").to_string();
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap() == 0 || line == "\r\n" {
                        break;
                    }
                }
                if path == "/__stop" {
                    break;
                }
                recorded.lock().unwrap().push(path.clone());
                if let Ok(location) = fs::read_to_string(
                    root.join(format!("{}.redirect", path.trim_start_matches('/'))),
                ) {
                    let _ = write!(
                        stream,
                        "HTTP/1.1 302 Found\r\nLocation: {}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                        location.trim()
                    );
                    continue;
                }
                let (mut status, body) = match fs::read(root.join(path.trim_start_matches('/'))) {
                    Ok(bytes) => ("200 OK", bytes),
                    Err(_) => ("404 Not Found", Vec::new()),
                };
                let override_status = fs::read_to_string(
                    root.join(format!("{}.status", path.trim_start_matches('/'))),
                )
                .ok();
                if let Some(value) = &override_status {
                    status = value.trim();
                }
                let _ = write!(
                    stream,
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(&body);
            }
        });
        Self {
            base: format!("http://{address}"),
            address,
            thread: Some(thread),
            requests,
        }
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        let mut stream = TcpStream::connect(self.address).unwrap();
        stream.write_all(b"GET /__stop HTTP/1.1\r\n\r\n").unwrap();
        self.thread.take().unwrap().join().unwrap();
    }
}

pub fn cli(paths: &Paths, base: &str, arguments: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_hexbot-install"))
        .args(arguments)
        .env("HOME", &paths.home)
        .env("HEXBOT_HOME", &paths.hexbot_home)
        .env(
            "HEXBOT_INSTALL_APPS_DIR",
            paths.apps_override.as_ref().unwrap(),
        )
        .env("HEXBOT_SERVICE_ROOT", &paths.service_root)
        .env("HEXBOT_SERVICE_NO_LOAD", "1")
        .env("HEXBOT_UPDATE_URL", base)
        .env_remove("HEXBOT_TRACK")
        .stdin(std::process::Stdio::null())
        .output()
        .unwrap()
}

pub fn success(output: Output) -> String {
    assert!(
        output.status.success(),
        "stdout: {}\nstderr: {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}
