use axum::{
    Json, Router,
    extract::{Request, State},
    http::StatusCode,
    response::IntoResponse,
    routing::any,
};
use hexbot_core::{auth, common, db, services};
use serde_json::{Value, json};
use std::{fs, sync::Arc, time::Duration};
use tokio::sync::{Mutex, mpsc};

const TEST_KEY:&[u8]=b"-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg/h5RZbRebJ4W8wDj\n0zi0DKNjL3NKu4LSLTr3GDLW1AuhRANCAATxLUB7ibYZJBU9qYp7mPjCc/fQfWet\nd1HBTxun6HHLoMilyIfHMI8E9KdpMIfgyZ8cQ6tCl8+s34X5gbiue9D9\n-----END PRIVATE KEY-----\n";
fn jwks() -> Value {
    json!({"keys":[{"kty":"EC","crv":"P-256","alg":"ES256","use":"sig","kid":"fixture","x":"8S1Ae4m2GSQVPamKe5j4wnP30H1nrXdRwU8bp-hxy6A","y":"yKXIh8cwjwT0p2kwh-DJnxxDq0KXz6zfhfmBuK570P0"}]})
}
struct StateData {
    response: Mutex<Value>,
    observed: mpsc::UnboundedSender<(String, Value, String)>,
    bad: Mutex<bool>,
    binary: Mutex<Vec<u8>>,
    manifest: Mutex<Value>,
}
struct Mock {
    base: String,
    data: Arc<StateData>,
    events: mpsc::UnboundedReceiver<(String, Value, String)>,
    pending: Vec<(String, Value, String)>,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Mock {
    fn drop(&mut self) {
        self.task.abort();
    }
}
async fn handler(
    State(state): State<Arc<StateData>>,
    request: Request,
) -> axum::response::Response {
    let path = request.uri().path().to_owned();
    let auth = request
        .headers()
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_owned();
    let body = axum::body::to_bytes(request.into_body(), 1024 * 1024)
        .await
        .unwrap();
    let body = serde_json::from_slice(&body).unwrap_or(Value::Null);
    let _ = state.observed.send((path.clone(), body, auth));
    if *state.bad.lock().await {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    let value = match path.as_str() {
        "/api/register/start" => {
            json!({"device_code":"device-code","user_code":"ABCD1234","verify_url":"https://connect.example/approve","interval":1})
        }
        "/api/register/poll" => state.response.lock().await.clone(),
        "/.well-known/jwks.json" => jwks(),
        "/binary" => return state.binary.lock().await.clone().into_response(),
        path if path.ends_with("/manifest.json") => state.manifest.lock().await.clone(),
        _ => json!({"ok":true}),
    };
    Json(value).into_response()
}
impl Mock {
    async fn new() -> Self {
        let (sender, events) = mpsc::unbounded_channel();
        let data = Arc::new(StateData {
            response: Mutex::new(json!({"status":"pending"})),
            observed: sender,
            bad: Mutex::new(false),
            binary: Mutex::new(vec![]),
            manifest: Mutex::new(Value::Null),
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let app = Router::new()
            .fallback(any(handler))
            .with_state(data.clone());
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        Self {
            base,
            data,
            events,
            pending: vec![],
            task,
        }
    }
    async fn event(&mut self, path: &str) -> (Value, String) {
        if let Some(index) = self.pending.iter().position(|item| item.0 == path) {
            let (_, body, auth) = self.pending.remove(index);
            return (body, auth);
        }
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let (seen, body, auth) = self.events.recv().await.unwrap();
                if seen == path {
                    return (body, auth);
                }
                self.pending.push((seen, body, auth));
            }
        })
        .await
        .unwrap()
    }
    fn configure(&self, home: &std::path::Path) {
        common::write_config(home,&json!({"connect":{"api_base":self.base},"updates":{"base_url":self.base},"model":"keep"})).unwrap();
    }
    fn persist_registration(&self, home: &std::path::Path) {
        fs::write(home.join("connect.json"),serde_json::to_vec(&json!({"api_base":self.base,"daemon_id":"daemon-1","daemon_token":"daemon-secret","slug":"kitchen","tunnel_hostname":"kitchen.connect.example","tunnel_token":"tunnel-secret"})).unwrap()).unwrap();
    }
}
fn home() -> tempfile::TempDir {
    let home = tempfile::tempdir().unwrap();
    db::migrate(home.path()).unwrap();
    home
}

#[tokio::test]
async fn registration_errors_and_admin_authorization_are_real() {
    let mock = Mock::new().await;
    let home = home();
    mock.configure(home.path());
    db::open(home.path())
        .unwrap()
        .execute(
            "INSERT INTO users VALUES ('member','Member','member','{}',0,NULL)",
            [],
        )
        .unwrap();
    assert_eq!(
        services::call(
            home.path(),
            "member",
            "hexbot.connect.register_start",
            &json!({})
        )
        .await
        .unwrap()
        .unwrap_err()
        .code,
        4301
    );
    let started = services::call(
        home.path(),
        "local",
        "hexbot.connect.register_start",
        &json!({"daemon_name":"Kitchen"}),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(started["device_code"], "device-code");
    for status in ["pending", "denied", "expired"] {
        *mock.data.response.lock().await = json!({"status":status});
        let result = services::call(
            home.path(),
            "local",
            "hexbot.connect.register_poll",
            &json!({"device_code":"device-code"}),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(result["status"], status);
        assert!(!home.path().join("connect.json").exists());
    }
    *mock.data.bad.lock().await = true;
    assert_eq!(
        services::call(
            home.path(),
            "local",
            "hexbot.connect.register_start",
            &json!({})
        )
        .await
        .unwrap()
        .unwrap_err()
        .code,
        5241
    );
    assert!(
        services::call(home.path(), "local", "other", &json!({}))
            .await
            .is_none()
    );
}

#[test]
fn public_url_preserves_unrelated_configuration_and_reverses() {
    let home = home();
    let profile = home.path().join("profiles/scout");
    fs::create_dir_all(&profile).unwrap();
    for path in [home.path(), profile.as_path()] {
        common::write_config(path, &json!({"model":"keep","dashboard":{"theme":"dark"}})).unwrap();
    }
    services::apply_public_url(home.path(), Some("kitchen.connect.example")).unwrap();
    for path in [home.path(), profile.as_path()] {
        assert_eq!(
            common::read_config(path).unwrap()["dashboard"]["public_url"],
            "https://kitchen.connect.example"
        );
    }
    services::apply_public_url(home.path(), None).unwrap();
    for path in [home.path(), profile.as_path()] {
        assert_eq!(
            common::read_config(path).unwrap(),
            json!({"model":"keep","dashboard":{"theme":"dark"}})
        );
    }
    assert!(services::apply_public_url(home.path(), Some("evil.example/path")).is_err());
}

#[tokio::test]
async fn connect_grants_verify_signature_claims_and_mint_revocable_devices() {
    use jsonwebtoken::{Algorithm, EncodingKey, Header, encode};
    let mock = Mock::new().await;
    let home = home();
    mock.persist_registration(home.path());
    let key = EncodingKey::from_ec_pem(TEST_KEY).unwrap();
    let mut header = Header::new(Algorithm::ES256);
    header.kid = Some("fixture".into());
    let claims = json!({"sub":"cloud-user","daemon_id":"daemon-1","device_name":"Alice laptop","iat":common::now() as u64,"exp":common::now() as u64+300});
    let grant = encode(&header, &claims, &key).unwrap();
    let device = services::redeem_grant(home.path(), &grant, "untrusted-name", "connect")
        .await
        .unwrap();
    let token = device["device_token"].as_str().unwrap();
    let id = device["device_id"].as_str().unwrap();
    assert_eq!(
        auth::verify_token(home.path(), token).unwrap().unwrap()["name"],
        "Alice laptop"
    );
    db::open(home.path())
        .unwrap()
        .execute("UPDATE devices SET revoked_at=1 WHERE id=?", [id])
        .unwrap();
    assert!(auth::verify_token(home.path(), token).unwrap().is_none());
    for (field, value) in [
        ("daemon_id", json!("other")),
        ("exp", json!(1)),
        ("iat", json!(common::now() + 500.0)),
        ("device_name", json!(" ")),
    ] {
        let mut bad = claims.clone();
        bad[field] = value;
        assert_eq!(
            services::redeem_grant(
                home.path(),
                &encode(&header, &bad, &key).unwrap(),
                "",
                "connect"
            )
            .await
            .unwrap_err()
            .code,
            4231
        );
    }
    header.kid = Some("rotated-away".into());
    assert!(
        services::redeem_grant(
            home.path(),
            &encode(&header, &claims, &key).unwrap(),
            "",
            "connect"
        )
        .await
        .is_err()
    );
    assert!(
        services::redeem_grant(home.path(), "not-a-token", "", "connect")
            .await
            .is_err()
    );
}

#[tokio::test]
async fn configured_jwks_cannot_redirect_credentials_or_trust_to_another_origin() {
    let home = home();
    fs::write(
        home.path().join("connect.json"),
        br#"{"api_base":"https://connect.hexbot.app","jwks_url":"https://attacker.example/keys"}"#,
    )
    .unwrap();
    assert!(services::ConnectConfig::load(home.path()).is_err());
    common::write_config(
        home.path(),
        &json!({"connect":{"api_base":"http://outside.example"}}),
    )
    .unwrap();
    assert!(
        services::call(
            home.path(),
            "local",
            "hexbot.connect.register_start",
            &json!({})
        )
        .await
        .unwrap()
        .is_err()
    );
}

#[cfg(unix)]
#[tokio::test]
async fn approved_registration_starts_tunnel_heartbeats_and_disconnect_reaps() {
    use std::os::unix::fs::PermissionsExt;
    let mut mock = Mock::new().await;
    let home = home();
    mock.configure(home.path());
    let binary = home.path().join("bin/cloudflared");
    fs::create_dir_all(binary.parent().unwrap()).unwrap();
    fs::write(&binary,format!("#!/usr/bin/env node\nconst fs=require('fs');const marker=__filename+'.count';const count=fs.existsSync(marker)?2:1;fs.writeFileSync(marker,'1');\nprocess.on('SIGTERM',()=>process.exit(0));\nsetTimeout(()=>process.exit(0),20000);\nfetch({}+'/tunnel_started',{{method:'POST',body:JSON.stringify({{pid:process.pid,count,token:process.env.TUNNEL_TOKEN,args:process.argv.slice(2)}})}}).then(()=>{{if(count===1)process.exit(17);}});\n",serde_json::to_string(&mock.base).unwrap())).unwrap();
    fs::set_permissions(&binary, fs::Permissions::from_mode(0o700)).unwrap();
    *mock.data.response.lock().await = json!({"status":"approved","daemon_id":"daemon-1","daemon_token":"daemon-secret","slug":"kitchen","tunnel_hostname":"kitchen.connect.example","tunnel_token":"tunnel-secret"});
    services::call(
        home.path(),
        "local",
        "hexbot.connect.register_poll",
        &json!({"device_code":"code"}),
    )
    .await
    .unwrap()
    .unwrap();
    let (heartbeat, authorization) = mock.event("/api/daemons/daemon-1/heartbeat").await;
    assert_eq!(heartbeat["port"], 9119);
    assert_eq!(authorization, "Bearer daemon-secret");
    let (tunnel, _) = mock.event("/tunnel_started").await;
    assert_eq!(tunnel["count"], 1);
    assert_eq!(tunnel["token"], "tunnel-secret");
    assert_eq!(tunnel["args"], json!(["tunnel", "run"]));
    let (restarted, _) = mock.event("/tunnel_started").await;
    assert_eq!(restarted["count"], 2);
    let pid = restarted["pid"].as_i64().unwrap() as i32;
    assert_eq!(
        fs::metadata(home.path().join("connect.json"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    let state = services::call(home.path(), "local", "hexbot.connect.status", &json!({}))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(state["tunnel_running"], true);
    assert!(!state.to_string().contains("secret"));
    let disconnected = services::call(
        home.path(),
        "local",
        "hexbot.connect.disconnect",
        &json!({}),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(disconnected["registered"], false);
    assert_eq!(disconnected["tunnel_running"], false);
    assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
    assert!(!home.path().join("connect.json").exists());
    assert!(
        common::read_config(home.path())
            .unwrap()
            .get("dashboard")
            .is_none()
    );
    services::shutdown(home.path()).await.unwrap();
}

#[tokio::test]
async fn disconnect_forgets_credentials_when_connect_is_offline() {
    let mock = Mock::new().await;
    let home = home();
    mock.persist_registration(home.path());
    *mock.data.bad.lock().await = true;
    let result = services::call(
        home.path(),
        "local",
        "hexbot.connect.disconnect",
        &json!({}),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(result["registered"], false);
}

// Supervisor selection is process-scoped. Run its tests in child test processes
// instead of changing environment variables concurrently in this test runner.
#[cfg(unix)]
#[test]
fn native_update_executes_verified_binary_and_reports_download_failure() {
    for test in ["native_update_child", "native_archive_child"] {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", test, "--ignored", "--nocapture"])
            .env("HEXBOT_SUPERVISOR", "service")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stdout)
        );
    }
}

#[cfg(unix)]
#[tokio::test]
#[ignore = "executed by the environment-isolated parent test"]
async fn native_archive_child() {
    use sha2::{Digest, Sha256};
    let mock = Mock::new().await;
    for unsafe_link in [false, true] {
        let home = home();
        mock.configure(home.path());
        let binary = b"#!/bin/sh\nprintf '9.8.7\\n'\n";
        let encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        let mut archive = tar::Builder::new(encoder);
        let mut header = tar::Header::new_gnu();
        header.set_mode(0o700);
        header.set_size(binary.len() as u64);
        header.set_cksum();
        archive
            .append_data(&mut header, "./hexbot", binary.as_slice())
            .unwrap();
        if unsafe_link {
            let mut header = tar::Header::new_gnu();
            header.set_entry_type(tar::EntryType::Symlink);
            header.set_size(0);
            header.set_link_name("../outside").unwrap();
            header.set_cksum();
            archive
                .append_data(&mut header, "unsafe", std::io::empty())
                .unwrap();
        }
        let archive = archive.into_inner().unwrap().finish().unwrap();
        *mock.data.manifest.lock().await = json!({"version":"9.8.7","target":format!("{}-{}",std::env::consts::OS,std::env::consts::ARCH),"url":format!("{}/binary",mock.base),"format":"tar.gz","entrypoint":"hexbot","sha256":format!("{:x}",Sha256::digest(&archive))});
        *mock.data.binary.lock().await = archive;
        services::call(
            home.path(),
            "local",
            "hexbot.update.request",
            &json!({"version":"9.8.7"}),
        )
        .await
        .unwrap()
        .unwrap();
        let result = tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let result =
                    services::call(home.path(), "local", "hexbot.update.status", &json!({}))
                        .await
                        .unwrap()
                        .unwrap();
                if matches!(result["status"].as_str(), Some("failed" | "restarting")) {
                    break result;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        if unsafe_link {
            assert_eq!(result["status"], "failed");
            assert!(result["message"].as_str().unwrap().contains("unsafe"));
            assert!(!home.path().join("runtime/native-current.json").exists());
        } else {
            assert_eq!(result["status"], "restarting");
            let path = services::take_restart(home.path()).await.unwrap().unwrap();
            assert_eq!(fs::read(path).unwrap(), binary);
        }
        services::shutdown(home.path()).await.unwrap();
    }
}

#[test]
fn desktop_update_preserves_stdout_marker_and_ignores_stale_status() {
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "desktop_update_child",
            "--ignored",
            "--nocapture",
        ])
        .env("HEXBOT_SUPERVISOR", "desktop")
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(output.status.success(), "{stdout}");
    assert!(stdout.contains("HEXBOT_UPDATE_REQUESTED version=9.8.7"));
}

#[tokio::test]
#[ignore = "executed by the environment-isolated parent test"]
async fn desktop_update_child() {
    let home = home();
    services::call(
        home.path(),
        "local",
        "hexbot.update.request",
        &json!({"version":"9.8.7"}),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(
        services::call(
            home.path(),
            "local",
            "hexbot.update.request",
            &json!({"version":"9.8.8"})
        )
        .await
        .unwrap()
        .unwrap_err()
        .code,
        4211
    );
    fs::create_dir(home.path().join("runtime")).unwrap();
    fs::write(
        home.path().join("runtime/update-status.json"),
        br#"{"status":"complete","at":"2000-01-01T00:00:00Z"}"#,
    )
    .unwrap();
    assert_eq!(
        services::call(home.path(), "local", "hexbot.update.status", &json!({}))
            .await
            .unwrap()
            .unwrap()["status"],
        "requested"
    );
    fs::write(
        home.path().join("runtime/update-status.json"),
        serde_json::to_vec(
            &json!({"status":"downloading","percent":55,"at":chrono::Utc::now().to_rfc3339()}),
        )
        .unwrap(),
    )
    .unwrap();
    let result = services::call(home.path(), "local", "hexbot.update.status", &json!({}))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(result["status"], "downloading");
    assert_eq!(result["percent"], 55);
    services::shutdown(home.path()).await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
#[ignore = "executed by the environment-isolated parent test"]
async fn native_update_child() {
    use sha2::{Digest, Sha256};
    let mock = Mock::new().await;
    let home = home();
    mock.configure(home.path());
    let binary = b"#!/bin/sh\nprintf '9.8.7\\n'\n";
    *mock.data.binary.lock().await = binary.to_vec();
    *mock.data.manifest.lock().await = json!({"version":"9.8.7","target":format!("{}-{}",std::env::consts::OS,std::env::consts::ARCH),"url":format!("{}/binary",mock.base),"sha256":format!("{:x}",Sha256::digest(binary))});
    let result = services::call(
        home.path(),
        "local",
        "hexbot.update.request",
        &json!({"version":"9.8.7"}),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(result["accepted"], true);
    let path = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if let Some(path) = services::take_restart(home.path()).await.unwrap() {
                break path;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(fs::read(&path).unwrap(), binary);
    assert!(home.path().join("runtime/native-current.json").is_file());
    let stable = home.path().join("runtime/native-executable");
    assert_eq!(stable.canonicalize().unwrap(), path);
    let reboot = std::process::Command::new(&stable)
        .arg("version")
        .output()
        .unwrap();
    assert!(reboot.status.success());
    assert_eq!(String::from_utf8(reboot.stdout).unwrap().trim(), "9.8.7");
    services::shutdown(home.path()).await.unwrap();
    let other = tempfile::tempdir().unwrap();
    db::migrate(other.path()).unwrap();
    mock.configure(other.path());
    *mock.data.bad.lock().await = true;
    services::call(
        other.path(),
        "local",
        "hexbot.update.request",
        &json!({"version":"9.8.8"}),
    )
    .await
    .unwrap()
    .unwrap();
    let result = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let result = services::call(other.path(), "local", "hexbot.update.status", &json!({}))
                .await
                .unwrap()
                .unwrap();
            if result["status"] == "failed" {
                break result;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(result["message"].as_str().unwrap().contains("503"));
    assert!(!other.path().join("runtime/native-current.json").exists());
    services::shutdown(other.path()).await.unwrap();
}
