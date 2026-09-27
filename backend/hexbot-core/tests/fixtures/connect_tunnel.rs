use crate::{common, db, services};
use axum::{
    Json, Router,
    extract::{Request, State},
    http::StatusCode,
    response::IntoResponse,
    routing::any,
};
use serde_json::{Value, json};
use std::{fs, sync::Arc, time::Duration};
use tokio::sync::{Mutex, mpsc};

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
}
fn home() -> tempfile::TempDir {
    let home = tempfile::tempdir().unwrap();
    db::migrate(home.path()).unwrap();
    home
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
    fs::write(&binary,format!("#!/usr/bin/env node\nconst fs=require('fs');const marker=__filename+'.count';const count=fs.existsSync(marker)?2:1;fs.writeFileSync(marker,'1');\nprocess.on('SIGTERM',()=>process.exit(0));\nsetTimeout(()=>process.exit(0),20000);\nfetch({}+'/tunnel_started',{{method:'POST',body:JSON.stringify({{pid:process.pid,count,token:process.env.TUNNEL_TOKEN,args:process.argv.slice(2)}})}}).then(()=>{{if(count===1){{fs.writeFileSync(process.argv[4],JSON.stringify({{ingress:[{{service:'https://evil.test'}}]}}));process.exit(17);}}}});\n",serde_json::to_string(&mock.base).unwrap())).unwrap();
    fs::set_permissions(&binary, fs::Permissions::from_mode(0o700)).unwrap();
    *mock.data.response.lock().await = json!({"status":"approved","daemon_id":"daemon-1","daemon_token":"daemon-secret","slug":"kitchen","tunnel_hostname":"kitchen.connect.example","tunnel_token":"tunnel-secret","owner_id":"cloud-user","issuer":"https://connect.hexbot.app","keys":jwks()["keys"]});
    let reply = services::register_poll(home.path(), "code", false)
        .await
        .unwrap();
    assert_eq!(reply, json!({"status":"approved"}));
    super::run_tunnel(
        home.path(),
        9119,
        super::service(home.path()).await.unwrap(),
        services::ConnectConfig::load(home.path()).unwrap().unwrap(),
        binary,
    )
    .await
    .unwrap();
    let (heartbeat, authorization) = mock.event("/api/daemons/daemon-1/heartbeat").await;
    assert_eq!(heartbeat["port"], 9119);
    assert_eq!(authorization, "Bearer daemon-secret");
    let (tunnel, _) = mock.event("/tunnel_started").await;
    assert_eq!(tunnel["count"], 1);
    assert_eq!(tunnel["token"], "tunnel-secret");
    assert_eq!(
        tunnel["args"],
        json!([
            "tunnel",
            "--config",
            home.path().join("cloudflared.yml"),
            "--no-autoupdate",
            "run"
        ])
    );
    let (restarted, _) = mock.event("/tunnel_started").await;
    assert_eq!(restarted["count"], 2);
    assert_eq!(restarted["args"], tunnel["args"]);
    assert_eq!(
        serde_json::from_slice::<Value>(&fs::read(home.path().join("cloudflared.yml")).unwrap())
            .unwrap(),
        json!({"ingress":[{"service":"http://127.0.0.1:9119"}]})
    );
    assert_eq!(
        fs::metadata(home.path().join("cloudflared.yml"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
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
async fn pinned_download_replaces_unversioned_and_tampered_cache() {
    use sha2::{Digest, Sha256};
    let mock = Mock::new().await;
    for compressed in [false, true] {
        let home = home();
        fs::create_dir_all(home.path().join("bin")).unwrap();
        fs::write(
            home.path().join("bin/cloudflared"),
            b"stale unverified executable",
        )
        .unwrap();
        let binary = b"local fixture binary";
        let asset = if compressed {
            let gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
            let mut tar = tar::Builder::new(gzip);
            let mut header = tar::Header::new_gnu();
            header.set_size(binary.len() as u64);
            header.set_mode(0o700);
            header.set_cksum();
            tar.append_data(&mut header, "cloudflared", binary.as_slice())
                .unwrap();
            tar.into_inner().unwrap().finish().unwrap()
        } else {
            binary.to_vec()
        };
        let name = if compressed { "fixture.tgz" } else { "fixture" };
        let url = format!("{}/binary", mock.base);
        *mock.data.binary.lock().await = asset.clone();
        let digest = format!("{:x}", Sha256::digest(&asset));
        assert!(
            super::ensure_cloudflared_asset(home.path(), name, "wrong", &url)
                .await
                .is_err()
        );
        let installed = super::ensure_cloudflared_asset(home.path(), name, &digest, &url)
            .await
            .unwrap();
        assert!(!home.path().join("bin/cloudflared").exists());
        assert_eq!(fs::read(&installed).unwrap(), binary);
        fs::write(&installed, b"tampered binary").unwrap();
        *mock.data.bad.lock().await = true;
        assert_eq!(
            super::ensure_cloudflared_asset(home.path(), name, &digest, &url)
                .await
                .unwrap(),
            installed
        );
        assert_eq!(fs::read(&installed).unwrap(), binary);
        // A damaged archive cannot authenticate a cached executable while offline.
        fs::write(
            home.path()
                .join(format!("bin/{name}-{}.asset", super::CLOUDFLARED_VERSION)),
            b"tampered archive",
        )
        .unwrap();
        assert!(
            super::ensure_cloudflared_asset(home.path(), name, &digest, &url)
                .await
                .is_err()
        );
        *mock.data.bad.lock().await = false;
    }
}

#[tokio::test]
async fn jwks_refreshes_after_ten_minutes_and_throttles_unknown_keys_and_outages() {
    let mut mock = Mock::new().await;
    let home = home();
    fs::write(home.path().join("connect.json"),json!({"api_base":mock.base,"daemon_id":"daemon","owner_id":"owner","issuer":"https://connect.hexbot.app","keys":jwks()["keys"]}).to_string()).unwrap();
    let config = services::ConnectConfig::load(home.path()).unwrap().unwrap();
    assert_eq!(
        super::published_keys(home.path(), &config, "fixture")
            .await
            .unwrap()
            .len(),
        1
    );
    mock.event("/.well-known/jwks.json").await;
    let service = super::service(home.path()).await.unwrap();
    for _ in 0..10 {
        super::published_keys(home.path(), &config, "unknown")
            .await
            .unwrap();
    }
    assert!(mock.events.try_recv().is_err());
    service.jwks.lock().await.at = Some(common::now() - 61.);
    super::published_keys(home.path(), &config, "unknown")
        .await
        .unwrap();
    mock.event("/.well-known/jwks.json").await;
    service.jwks.lock().await.at = Some(common::now() - 599.);
    super::published_keys(home.path(), &config, "fixture")
        .await
        .unwrap();
    assert!(mock.events.try_recv().is_err());
    service.jwks.lock().await.at = Some(common::now() - 601.);
    *mock.data.bad.lock().await = true;
    assert!(
        super::published_keys(home.path(), &config, "fixture")
            .await
            .is_err()
    );
    mock.event("/.well-known/jwks.json").await;
    for _ in 0..10 {
        assert!(
            super::published_keys(home.path(), &config, "fixture")
                .await
                .unwrap()
                .is_empty()
        );
    }
    assert!(mock.events.try_recv().is_err());
}
