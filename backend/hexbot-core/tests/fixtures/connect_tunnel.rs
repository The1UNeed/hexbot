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

/// Timings that make the supervisor act within a test, not within minutes.
fn fast() -> super::TunnelTiming {
    super::TunnelTiming {
        poll: Duration::from_millis(50),
        // Exits drive these tests; readiness must never run out first, however slowly a
        // loaded machine starts the node stand-in (the not-ready test sets its own).
        ready_timeout: Duration::from_secs(60),
        exit_window: Duration::from_secs(300),
        repair_interval: Duration::from_secs(1),
        repair_interval_max: Duration::from_secs(4),
        failures_before_repair: 3,
    }
}

/// JavaScript for a stand-in: the metrics server cloudflared would run, answering `/ready`
/// with 200 (an edge connection) or 503 (none).
fn ready_server(ready: bool) -> String {
    format!(
        "const m=process.argv[process.argv.indexOf('--metrics')+1];require('http').createServer((q,s)=>{{s.statusCode=(q.url==='/ready'&&{ready})?200:503;s.end();}}).listen(Number(m.split(':')[1]),'127.0.0.1');\n"
    )
}

/// Waits, without sleeping, until the service's data satisfies `done`.
async fn wait_until(
    service: &super::Service,
    changes: &mut tokio::sync::watch::Receiver<u64>,
    what: &str,
    done: impl Fn(&super::Data) -> bool,
) {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if done(&*service.data.lock().await) {
                return;
            }
            changes.changed().await.unwrap();
        }
    })
    .await
    .unwrap_or_else(|_| panic!("service never reached: {what}"));
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
    fs::write(&binary,format!("#!/usr/bin/env node\n{}const fs=require('fs');const marker=__filename+'.count';const count=fs.existsSync(marker)?2:1;fs.writeFileSync(marker,'1');\nprocess.on('SIGTERM',()=>process.exit(0));\nsetTimeout(()=>process.exit(0),20000);\nfetch({}+'/tunnel_started',{{method:'POST',body:JSON.stringify({{pid:process.pid,count,token:process.env.TUNNEL_TOKEN,args:process.argv.slice(2)}})}}).then(()=>{{if(count===1){{fs.writeFileSync(process.argv[4],JSON.stringify({{ingress:[{{service:'https://evil.test'}}]}}));process.exit(17);}}}});\n",ready_server(true),serde_json::to_string(&mock.base).unwrap())).unwrap();
    fs::set_permissions(&binary, fs::Permissions::from_mode(0o700)).unwrap();
    *mock.data.response.lock().await = json!({"status":"approved","daemon_id":"daemon-1","daemon_token":"daemon-secret","slug":"kitchen","tunnel_hostname":"kitchen.connect.example","tunnel_token":"tunnel-secret","owner_id":"cloud-user","issuer":"https://connect.hexbot.app","keys":jwks()["keys"]});
    let reply = services::register_poll(home.path(), "code", false)
        .await
        .unwrap();
    assert_eq!(reply, json!({"status":"approved"}));
    let service = super::service(home.path()).await.unwrap();
    let mut changes = service.changed.subscribe();
    super::run_tunnel(
        home.path(),
        9119,
        service.clone(),
        services::ConnectConfig::load(home.path()).unwrap().unwrap(),
        binary,
        fast(),
    )
    .await
    .unwrap();
    let (heartbeat, authorization) = mock.event("/api/daemons/daemon-1/heartbeat").await;
    assert_eq!(heartbeat["port"], 9119);
    assert_eq!(authorization, "Bearer daemon-secret");
    let (tunnel, _) = mock.event("/tunnel_started").await;
    assert_eq!(tunnel["count"], 1);
    assert_eq!(tunnel["token"], "tunnel-secret");
    let args = tunnel["args"].as_array().unwrap();
    assert_eq!(
        args[..4],
        [
            json!("tunnel"),
            json!("--config"),
            json!(home.path().join("cloudflared.yml")),
            json!("--no-autoupdate")
        ]
    );
    assert_eq!(args[4], "--metrics");
    assert!(args[5].as_str().unwrap().starts_with("127.0.0.1:"));
    assert_eq!(args[6], "run");
    assert_eq!(args.len(), 7);
    let (restarted, _) = mock.event("/tunnel_started").await;
    assert_eq!(restarted["count"], 2);
    let restarted_args = restarted["args"].as_array().unwrap();
    assert_eq!(restarted_args[..5], args[..5]);
    assert!(
        restarted_args[5]
            .as_str()
            .unwrap()
            .starts_with("127.0.0.1:")
    );
    assert_eq!(restarted_args[6..], args[6..]);
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
    // Running means ready: the stand-in answers /ready once it is up.
    wait_until(&service, &mut changes, "tunnel ready", |data| data.running).await;
    let state = services::call(home.path(), "local", "hexbot.connect.status", &json!({}))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(state["tunnel_running"], true);
    assert_eq!(state["last_error"], Value::Null);
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

/// A cloudflared stand-in: serves `/ready` as a tunnel with (`ready`) or without an edge
/// connection would, reports its start (pid and token) to the mock, then runs
/// `after_start` (JavaScript), and otherwise waits for SIGTERM.
#[cfg(unix)]
fn stand_in_cloudflared(
    home: &std::path::Path,
    base: &str,
    ready: bool,
    after_start: &str,
) -> std::path::PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let binary = home.join("bin/cloudflared");
    fs::create_dir_all(binary.parent().unwrap()).unwrap();
    fs::write(
        &binary,
        format!(
            "#!/usr/bin/env node\n{}process.on('SIGTERM',()=>process.exit(0));\nsetTimeout(()=>process.exit(0),20000);\nfetch({}+'/tunnel_started',{{method:'POST',body:JSON.stringify({{pid:process.pid,token:process.env.TUNNEL_TOKEN}})}}).then(()=>{{{after_start}}});\n",
            ready_server(ready),
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
    wait_until(service, changes, error, |data| {
        data.error.as_deref() == Some(error)
    })
    .await;
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
    let binary = stand_in_cloudflared(home.path(), &mock.base, true, "");
    let service = super::service(home.path()).await.unwrap();
    let mut changes = service.changed.subscribe();
    super::run_tunnel(
        home.path(),
        9119,
        service.clone(),
        services::ConnectConfig::load(home.path()).unwrap().unwrap(),
        binary,
        super::TunnelTiming::default(),
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
    // Never ready, so a ready transition cannot clear the error these cases wait for.
    let binary = stand_in_cloudflared(home.path(), &mock.base, false, "");
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
        service.data.lock().await.error = None;
        let mut changes = service.changed.subscribe();
        super::run_tunnel(
            home.path(),
            9119,
            service.clone(),
            services::ConnectConfig::load(home.path()).unwrap().unwrap(),
            binary.clone(),
            super::TunnelTiming::default(),
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
        assert!(service.workers.lock().await.is_some());
        super::stop_workers(&service).await;
    }
    services::shutdown(home.path()).await.unwrap();
}

/// Three starts with the registered token, then the repair call, with the stand-in exiting at once.
#[cfg(unix)]
async fn failing_tunnel_until_repair(
    mock: &mut Mock,
    home: &std::path::Path,
) -> std::sync::Arc<super::Service> {
    let binary = stand_in_cloudflared(home, &mock.base, false, "process.exit(1)");
    let service = super::service(home).await.unwrap();
    super::run_tunnel(
        home,
        9119,
        service.clone(),
        services::ConnectConfig::load(home).unwrap().unwrap(),
        binary,
        fast(),
    )
    .await
    .unwrap();
    for _ in 0..3 {
        let (started, _) = mock.event("/tunnel_started").await;
        assert_eq!(started["token"], "tunnel-secret");
    }
    let (proof, authorization) = mock.event("/api/daemons/daemon-1/tunnel").await;
    assert_eq!(proof, json!({"tunnel_token": "tunnel-secret"}));
    assert_eq!(authorization, "Bearer daemon-secret");
    service
}

#[cfg(unix)]
#[tokio::test]
async fn failing_cloudflared_repairs_the_tunnel_and_keeps_the_address() {
    use std::os::unix::fs::PermissionsExt;
    let mut mock = Mock::new().await;
    let home = home();
    mock.persist_registration(home.path());
    services::apply_public_url(home.path(), Some("kitchen.connect.example")).unwrap();
    mock.data.overrides.lock().await.insert(
        "/api/daemons/daemon-1/tunnel".into(),
        (200, json!({"tunnel_token":"repaired-secret","tunnel_hostname":"kitchen.connect.example","replaced":true})),
    );
    failing_tunnel_until_repair(&mut mock, home.path()).await;
    let (restarted, _) = mock.event("/tunnel_started").await;
    assert_eq!(restarted["token"], "repaired-secret");
    let config = services::ConnectConfig::load(home.path()).unwrap().unwrap();
    assert_eq!(config.tunnel_token, "repaired-secret");
    assert_eq!(config.tunnel_hostname, "kitchen.connect.example");
    assert_eq!(config.daemon_token, "daemon-secret");
    assert_eq!(
        fs::metadata(home.path().join("connect.json"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    assert_eq!(
        common::read_config(home.path()).unwrap()["dashboard"]["public_url"],
        "https://kitchen.connect.example"
    );
    services::shutdown(home.path()).await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn older_connect_without_repair_keeps_the_backoff_and_the_token() {
    let mut mock = Mock::new().await;
    let home = home();
    mock.persist_registration(home.path());
    mock.data.overrides.lock().await.insert(
        "/api/daemons/daemon-1/tunnel".into(),
        (404, json!({"error":"not_found"})),
    );
    failing_tunnel_until_repair(&mut mock, home.path()).await;
    let (restarted, _) = mock.event("/tunnel_started").await;
    assert_eq!(restarted["token"], "tunnel-secret");
    assert_eq!(
        services::ConnectConfig::load(home.path())
            .unwrap()
            .unwrap()
            .tunnel_token,
        "tunnel-secret"
    );
    let state = services::call(home.path(), "local", "hexbot.connect.status", &json!({}))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(state["registered"], true);
    services::shutdown(home.path()).await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn revoked_answer_to_repair_drops_the_registration() {
    let mut mock = Mock::new().await;
    let home = home();
    mock.persist_registration(home.path());
    mock.data.overrides.lock().await.insert(
        "/api/daemons/daemon-1/tunnel".into(),
        (410, json!({"error":"daemon_revoked"})),
    );
    let service = super::service(home.path()).await.unwrap();
    let mut changes = service.changed.subscribe();
    failing_tunnel_until_repair(&mut mock, home.path()).await;
    wait_for_error(&service, &mut changes, super::REVOKED_REASON).await;
    assert!(!home.path().join("connect.json").exists());
    assert!(service.workers.lock().await.is_none());
    services::shutdown(home.path()).await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn an_unchanged_tunnel_rewrites_nothing_and_keeps_counting_failures() {
    let mut mock = Mock::new().await;
    let home = home();
    mock.persist_registration(home.path());
    let before = fs::read(home.path().join("connect.json")).unwrap();
    mock.data.overrides.lock().await.insert(
        "/api/daemons/daemon-1/tunnel".into(),
        (
            200,
            json!({"tunnel_hostname":"kitchen.connect.example","replaced":false}),
        ),
    );
    let service = failing_tunnel_until_repair(&mut mock, home.path()).await;
    let (restarted, _) = mock.event("/tunnel_started").await;
    assert_eq!(restarted["token"], "tunnel-secret");
    assert_eq!(fs::read(home.path().join("connect.json")).unwrap(), before);
    assert!(service.workers.lock().await.is_some());
    services::shutdown(home.path()).await.unwrap();
}

/// Readiness loss is visible on the next probe, before the restart deadline. The same
/// process can recover, then a restart must use a new metrics port if the old one is busy.
#[cfg(unix)]
#[tokio::test]
async fn readiness_loss_is_published_and_restart_chooses_a_free_metrics_port() {
    let mut mock = Mock::new().await;
    let home = home();
    mock.persist_registration(home.path());
    let binary = stand_in_cloudflared(home.path(), &mock.base, true, "");
    let script = fs::read_to_string(&binary)
        .unwrap()
        .replace(
            "q.url==='/ready'&&true",
            "q.url==='/ready'&&!require('fs').existsSync(__filename+'.unready')",
        )
        .replace(
            "{pid:process.pid,token:",
            "{metrics:m,pid:process.pid,token:",
        );
    fs::write(&binary, script).unwrap();
    let service = super::service(home.path()).await.unwrap();
    let mut changes = service.changed.subscribe();
    super::run_tunnel(
        home.path(),
        9119,
        service.clone(),
        services::ConnectConfig::load(home.path()).unwrap().unwrap(),
        binary.clone(),
        fast(),
    )
    .await
    .unwrap();
    let (started, _) = mock.event("/tunnel_started").await;
    let pid = started["pid"].as_i64().unwrap() as i32;
    wait_until(&service, &mut changes, "ready", |data| data.running).await;
    let marker = binary.with_file_name("cloudflared.unready");
    fs::write(&marker, "").unwrap();
    wait_until(&service, &mut changes, "readiness lost", |data| {
        !data.running
    })
    .await;
    assert_eq!(unsafe { libc::kill(pid, 0) }, 0);
    fs::remove_file(marker).unwrap();
    wait_until(&service, &mut changes, "ready again", |data| data.running).await;
    // Only this test's child is killed. Wait for the supervisor's exit event, then reserve
    // its old port during the backoff. Reusing it would make the next stand-in fail to bind.
    assert_eq!(unsafe { libc::kill(pid, libc::SIGTERM) }, 0);
    wait_until(&service, &mut changes, "child exit", |data| !data.running).await;
    let _occupied = std::net::TcpListener::bind(started["metrics"].as_str().unwrap()).unwrap();
    let (restarted, _) = mock.event("/tunnel_started").await;
    assert_ne!(restarted["metrics"], started["metrics"]);
    wait_until(&service, &mut changes, "replacement ready", |data| {
        data.running
    })
    .await;
    services::shutdown(home.path()).await.unwrap();
}

/// A tunnel that is gone does not make cloudflared exit; it just never gets an edge connection.
#[cfg(unix)]
#[tokio::test]
async fn cloudflared_without_an_edge_connection_counts_as_failed() {
    let mut mock = Mock::new().await;
    let home = home();
    mock.persist_registration(home.path());
    mock.data.overrides.lock().await.insert(
        "/api/daemons/daemon-1/tunnel".into(),
        (200, json!({"tunnel_token":"repaired-secret","tunnel_hostname":"kitchen.connect.example","replaced":true})),
    );
    let binary = stand_in_cloudflared(home.path(), &mock.base, false, "");
    let service = super::service(home.path()).await.unwrap();
    let mut changes = service.changed.subscribe();
    // One failure is enough here; the readiness window is long enough for the stand-in to
    // start and report in even on a loaded machine, so the failure is a verdict, not a kill
    // during startup.
    let timing = super::TunnelTiming {
        ready_timeout: Duration::from_secs(6),
        failures_before_repair: 1,
        ..fast()
    };
    super::run_tunnel(
        home.path(),
        9119,
        service.clone(),
        services::ConnectConfig::load(home.path()).unwrap().unwrap(),
        binary,
        timing,
    )
    .await
    .unwrap();
    let (started, _) = mock.event("/tunnel_started").await;
    assert_eq!(started["token"], "tunnel-secret");
    let pid = started["pid"].as_i64().unwrap() as i32;
    let (proof, authorization) = mock.event("/api/daemons/daemon-1/tunnel").await;
    assert_eq!(proof, json!({"tunnel_token": "tunnel-secret"}));
    assert_eq!(authorization, "Bearer daemon-secret");
    let (restarted, _) = mock.event("/tunnel_started").await;
    assert_eq!(restarted["token"], "repaired-secret");
    // The stand-in that never became ready was stopped by the supervisor, not by itself.
    wait_until(
        &service,
        &mut changes,
        "stale stand-in reaped",
        |_| unsafe { libc::kill(pid, 0) == -1 },
    )
    .await;
    let state = services::call(home.path(), "local", "hexbot.connect.status", &json!({}))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(state["tunnel_running"], false);
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

async fn prepare_identity(home: &std::path::Path, service: &std::sync::Arc<super::Service>) {
    let config = services::ConnectConfig::load(home).unwrap().unwrap();
    let _operation = service.lifecycle.lock().await;
    super::start_identity(home, service, &config).await;
}
async fn identity_finished(service: &super::Service) {
    if let Some(task) = service.identity_task.lock().await.take() {
        tokio::time::timeout(Duration::from_secs(5), task)
            .await
            .unwrap()
            .unwrap();
    }
}

#[tokio::test]
async fn startup_enrolls_a_persisted_key_once_and_keeps_it_on_conflict_or_old_connect() {
    for status in [200, 409, 404, 503] {
        let mut mock = Mock::new().await;
        let home = home();
        mock.persist_registration(home.path());
        mock.data.overrides.lock().await.insert(
            "/api/daemons/daemon-1/identity".into(),
            (status, json!({"ok": status == 200})),
        );
        let service = super::service(home.path()).await.unwrap();
        prepare_identity(home.path(), &service).await;
        let (body, authorization) = mock.event("/api/daemons/daemon-1/identity").await;
        identity_finished(&service).await;
        assert_eq!(authorization, "Bearer daemon-secret");
        assert_eq!(body["tunnel_token"], "tunnel-secret");
        let response = services::identity_response(home.path(), "host", "nonce")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(body["public_key"], response["public_key"]);
        let saved = fs::read(home.path().join(super::IDENTITY_FILE)).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(home.path().join(super::IDENTITY_FILE))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        if status == 409 {
            assert_eq!(
                service.data.lock().await.error.as_deref(),
                Some(super::IDENTITY_CONFLICT)
            );
            assert_eq!(
                super::connect_status(home.path()).await.unwrap()["last_error"],
                super::IDENTITY_CONFLICT
            );
        }
        prepare_identity(home.path(), &service).await;
        assert!(mock.events.try_recv().is_err());
        assert_eq!(
            saved,
            fs::read(home.path().join(super::IDENTITY_FILE)).unwrap()
        );
        // A fresh process retries with the same key, including after an old service or conflict.
        let restarted = std::sync::Arc::new(super::Service::default());
        prepare_identity(home.path(), &restarted).await;
        let (again, _) = mock.event("/api/daemons/daemon-1/identity").await;
        identity_finished(&restarted).await;
        assert_eq!(body, again);
        services::shutdown(home.path()).await.unwrap();
    }
}

#[tokio::test]
async fn identity_migration_survives_an_older_daemon_rewriting_connect_json() {
    let mut mock = Mock::new().await;
    let home = home();
    mock.persist_registration(home.path());
    let encoded = super::new_identity_key().unwrap();
    let path = home.path().join("connect.json");
    let mut legacy: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    legacy["identity_private_key"] = json!(encoded);
    fs::write(&path, legacy.to_string()).unwrap();
    let service = super::service(home.path()).await.unwrap();
    prepare_identity(home.path(), &service).await;
    identity_finished(&service).await;
    let (first, _) = mock.event("/api/daemons/daemon-1/identity").await;
    assert_eq!(
        fs::read_to_string(home.path().join(super::IDENTITY_FILE)).unwrap(),
        encoded
    );
    // This is what the pre-identity struct's save during repair does.
    legacy
        .as_object_mut()
        .unwrap()
        .remove("identity_private_key");
    legacy["tunnel_token"] = json!("repaired-token");
    fs::write(&path, legacy.to_string()).unwrap();
    let restarted = std::sync::Arc::new(super::Service::default());
    prepare_identity(home.path(), &restarted).await;
    identity_finished(&restarted).await;
    let (second, _) = mock.event("/api/daemons/daemon-1/identity").await;
    assert_eq!(first["public_key"], second["public_key"]);
    assert_eq!(second["tunnel_token"], "repaired-token");
    assert_eq!(
        fs::read_to_string(home.path().join(super::IDENTITY_FILE)).unwrap(),
        encoded
    );
    services::shutdown(home.path()).await.unwrap();
}

#[tokio::test]
async fn corrupt_identity_is_replaced_only_after_connect_accepts_the_first_key() {
    for status in [200, 409, 404] {
        let mut mock = Mock::new().await;
        let home = home();
        mock.persist_registration(home.path());
        fs::write(home.path().join(super::IDENTITY_FILE), "corrupt").unwrap();
        mock.data.overrides.lock().await.insert(
            "/api/daemons/daemon-1/identity".into(),
            (status, json!({"ok":true})),
        );
        let service = super::service(home.path()).await.unwrap();
        prepare_identity(home.path(), &service).await;
        let (body, _) = mock.event("/api/daemons/daemon-1/identity").await;
        identity_finished(&service).await;
        if status == 200 {
            let response = services::identity_response(home.path(), "host", "nonce")
                .await
                .unwrap()
                .unwrap();
            assert_eq!(response["public_key"], body["public_key"]);
            assert!(
                super::parse_identity_key(
                    &fs::read(home.path().join(super::IDENTITY_FILE)).unwrap()
                )
                .is_ok()
            );
            assert!(service.data.lock().await.identity_error.is_none());
        } else {
            assert_eq!(
                fs::read_to_string(home.path().join(super::IDENTITY_FILE)).unwrap(),
                "corrupt"
            );
            assert!(
                services::identity_response(home.path(), "host", "nonce")
                    .await
                    .is_err()
            );
            if status == 409 {
                assert_eq!(
                    service.data.lock().await.error.as_deref(),
                    Some(super::IDENTITY_CONFLICT)
                );
            }
        }
        services::shutdown(home.path()).await.unwrap();
    }
}

#[tokio::test]
async fn unreadable_identity_is_reported_without_blocking_or_overwriting() {
    let mock = Mock::new().await;
    let home = home();
    mock.persist_registration(home.path());
    fs::create_dir(home.path().join(super::IDENTITY_FILE)).unwrap();
    let service = super::service(home.path()).await.unwrap();
    prepare_identity(home.path(), &service).await;
    assert!(service.identity_task.lock().await.is_none());
    assert_eq!(
        service.data.lock().await.error.as_deref(),
        Some(super::IDENTITY_UNAVAILABLE)
    );
    assert!(home.path().join(super::IDENTITY_FILE).is_dir());
    services::shutdown(home.path()).await.unwrap();
}

#[tokio::test]
async fn enrollment_does_not_hold_startup_or_signing_and_disconnect_cancels_it() {
    let mut mock = Mock::new().await;
    let home = home();
    mock.persist_registration(home.path());
    let gate = std::sync::Arc::new(tokio::sync::Notify::new());
    *mock.data.identity_gate.lock().await = Some(gate.clone());
    let service = super::service(home.path()).await.unwrap();
    tokio::time::timeout(
        Duration::from_secs(2),
        prepare_identity(home.path(), &service),
    )
    .await
    .unwrap();
    mock.event("/api/daemons/daemon-1/identity").await;
    assert!(
        !service
            .identity_task
            .lock()
            .await
            .as_ref()
            .unwrap()
            .is_finished()
    );
    let response = tokio::time::timeout(
        Duration::from_secs(2),
        services::identity_response(home.path(), "host", "nonce"),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(response.is_some());
    tokio::time::timeout(
        Duration::from_secs(2),
        super::drop_registration(home.path(), &service, None, None, false),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(!home.path().join(super::IDENTITY_FILE).exists());
    assert!(!home.path().join("connect.json").exists());
    gate.notify_one();
    assert!(
        services::identity_response(home.path(), "host", "nonce")
            .await
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn startup_enrollment_revocation_forgets_both_credentials_and_the_identity() {
    let mut mock = Mock::new().await;
    let home = home();
    mock.persist_registration(home.path());
    mock.data.overrides.lock().await.insert(
        "/api/daemons/daemon-1/identity".into(),
        (410, json!({"error":"daemon_revoked"})),
    );
    let service = super::service(home.path()).await.unwrap();
    let mut changes = service.changed.subscribe();
    prepare_identity(home.path(), &service).await;
    mock.event("/api/daemons/daemon-1/identity").await;
    wait_until(&service, &mut changes, "identity revocation", |data| {
        data.error.as_deref() == Some(super::REVOKED_REASON)
    })
    .await;
    assert!(!home.path().join("connect.json").exists());
    assert!(!home.path().join(super::IDENTITY_FILE).exists());
    assert!(
        services::identity_response(home.path(), "host", "nonce")
            .await
            .unwrap()
            .is_none()
    );
    services::shutdown(home.path()).await.unwrap();
}

#[tokio::test]
async fn poll_caches_the_key_and_does_not_immediately_enroll_again() {
    let mut mock = Mock::new().await;
    let home = home();
    mock.configure(home.path());
    *mock.data.response.lock().await = json!({"status":"approved","daemon_id":"daemon-1","daemon_token":"daemon-secret","slug":"kitchen","tunnel_hostname":"kitchen.connect.example","tunnel_token":"tunnel-secret","owner_id":"cloud-user","issuer":"https://connect.hexbot.app","keys":jwks()["keys"]});
    services::register_poll(home.path(), "code", false)
        .await
        .unwrap();
    let (body, _) = mock.event("/api/register/poll").await;
    let service = super::service(home.path()).await.unwrap();
    prepare_identity(home.path(), &service).await;
    assert!(service.identity_task.lock().await.is_none());
    assert!(mock.events.try_recv().is_err());
    // A signing request uses the cached registration and parsed key, not either file.
    let config = fs::read(home.path().join("connect.json")).unwrap();
    fs::write(home.path().join(super::IDENTITY_FILE), "corrupt").unwrap();
    fs::write(home.path().join("connect.json"), "corrupt").unwrap();
    assert_eq!(
        services::identity_response(home.path(), "host", "nonce")
            .await
            .unwrap()
            .unwrap()["public_key"],
        body["public_key"]
    );
    fs::write(home.path().join("connect.json"), config).unwrap();
    // A new registration invalidates the cached parsed key.
    services::register_poll(home.path(), "other-code", false)
        .await
        .unwrap();
    let (next, _) = mock.event("/api/register/poll").await;
    assert_ne!(body["public_key"], next["public_key"]);
    assert_eq!(
        services::identity_response(home.path(), "host", "nonce")
            .await
            .unwrap()
            .unwrap()["public_key"],
        next["public_key"]
    );
    services::shutdown(home.path()).await.unwrap();
}
