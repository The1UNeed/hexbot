use crate::{common, db, services};
use serde_json::{Value, json};
use std::{fs, time::Duration};
#[path = "connect_mock.rs"]
mod connect_mock;
use connect_mock::{Mock, jwks};

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

/// A cloudflared stand-in: reports its start (pid and token) to the mock, then runs
/// `after_start` (JavaScript), and otherwise waits for SIGTERM.
#[cfg(unix)]
fn stand_in_cloudflared(
    home: &std::path::Path,
    base: &str,
    after_start: &str,
) -> std::path::PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let binary = home.join("bin/cloudflared");
    fs::create_dir_all(binary.parent().unwrap()).unwrap();
    fs::write(
        &binary,
        format!(
            "#!/usr/bin/env node\nprocess.on('SIGTERM',()=>process.exit(0));\nsetTimeout(()=>process.exit(0),20000);\nfetch({}+'/tunnel_started',{{method:'POST',body:JSON.stringify({{pid:process.pid,token:process.env.TUNNEL_TOKEN}})}}).then(()=>{{{after_start}}});\n",
            serde_json::to_string(base).unwrap()
        ),
    )
    .unwrap();
    fs::set_permissions(&binary, fs::Permissions::from_mode(0o700)).unwrap();
    binary
}

/// Waits, without sleeping, until the service reports `error`.
async fn wait_for_error(
    service: &super::Service,
    changes: &mut tokio::sync::watch::Receiver<u64>,
    error: &str,
) {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if service.data.lock().await.error.as_deref() == Some(error) {
                return;
            }
            changes.changed().await.unwrap();
        }
    })
    .await
    .unwrap_or_else(|_| panic!("service never reported {error:?}"));
}

#[cfg(unix)]
#[tokio::test]
async fn revoked_in_connect_drops_the_registration_and_stops_the_tunnel() {
    let mut mock = Mock::new().await;
    let home = home();
    mock.persist_registration(home.path());
    services::apply_public_url(home.path(), Some("kitchen.connect.example")).unwrap();
    mock.data.overrides.lock().await.insert(
        "/api/daemons/daemon-1/heartbeat".into(),
        (410, json!({"error":"daemon_revoked","message":"revoked"})),
    );
    let binary = stand_in_cloudflared(home.path(), &mock.base, "");
    let service = super::service(home.path()).await.unwrap();
    let mut changes = service.changed.subscribe();
    super::run_tunnel(
        home.path(),
        9119,
        service.clone(),
        services::ConnectConfig::load(home.path()).unwrap().unwrap(),
        binary,
    )
    .await
    .unwrap();
    // The first heartbeat goes out at once, before the stand-in has even started, so the
    // tunnel is checked through the workers it belongs to (the disconnect test checks the pid).
    let (_, authorization) = mock.event("/api/daemons/daemon-1/heartbeat").await;
    assert_eq!(authorization, "Bearer daemon-secret");
    wait_for_error(&service, &mut changes, super::REVOKED_REASON).await;
    assert!(!home.path().join("connect.json").exists());
    assert!(service.workers.lock().await.is_none());
    assert!(
        common::read_config(home.path())
            .unwrap()
            .get("dashboard")
            .is_none()
    );
    let state = services::call(home.path(), "local", "hexbot.connect.status", &json!({}))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(state["registered"], false);
    assert_eq!(state["tunnel_running"], false);
    assert_eq!(state["last_heartbeat_at"], Value::Null);
    assert_eq!(state["last_error"], "Removed in Hex Connect");
    // Dropping after a revoke never calls DELETE: Connect already forgot the daemon.
    while let Ok((path, _, _)) = mock.events.try_recv() {
        assert_ne!(path, "/api/daemons/daemon-1");
    }
    services::shutdown(home.path()).await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn connect_errors_other_than_revoked_keep_the_registration() {
    let mut mock = Mock::new().await;
    let home = home();
    mock.persist_registration(home.path());
    let binary = stand_in_cloudflared(home.path(), &mock.base, "");
    let service = super::service(home.path()).await.unwrap();
    for (status, body) in [
        (401, json!({"error":"unauthorized"})),
        (500, json!({"error":"daemon_revoked"})),
        (410, json!({"error":"expired"})),
        (410, json!("not an object")),
    ] {
        mock.data
            .overrides
            .lock()
            .await
            .insert("/api/daemons/daemon-1/heartbeat".into(), (status, body));
        let mut changes = service.changed.subscribe();
        super::run_tunnel(
            home.path(),
            9119,
            service.clone(),
            services::ConnectConfig::load(home.path()).unwrap().unwrap(),
            binary.clone(),
        )
        .await
        .unwrap();
        mock.event("/tunnel_started").await;
        mock.event("/api/daemons/daemon-1/heartbeat").await;
        wait_for_error(
            &service,
            &mut changes,
            &format!("Hex Connect service returned HTTP {status}"),
        )
        .await;
        assert!(home.path().join("connect.json").exists());
        let state = services::call(home.path(), "local", "hexbot.connect.status", &json!({}))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(state["registered"], true);
        assert_eq!(state["tunnel_running"], true);
        super::stop_workers(&service).await;
    }
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
    mock.persist_registration(home.path());
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
