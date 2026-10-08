use hexbot_core::{auth, common, db, services};
use serde_json::{Value, json};
use std::{fs, time::Duration};
#[path = "fixtures/connect_mock.rs"]
mod connect_mock;
use connect_mock::{Mock, jwks};

const TEST_KEY:&[u8]=b"-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg/h5RZbRebJ4W8wDj\n0zi0DKNjL3NKu4LSLTr3GDLW1AuhRANCAATxLUB7ibYZJBU9qYp7mPjCc/fQfWet\nd1HBTxun6HHLoMilyIfHMI8E9KdpMIfgyZ8cQ6tCl8+s34X5gbiue9D9\n-----END PRIVATE KEY-----\n";
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
    header.typ = Some("hexbot-grant+jwt".into());
    let claims = json!({"sub":"cloud-user","iss":"https://connect.hexbot.app","aud":"daemon-1","jti":"test-grant","daemon_id":"daemon-1","device_name":"Alice laptop","iat":common::now() as u64,"exp":common::now() as u64+300});
    let grant = encode(&header, &claims, &key).unwrap();
    let device = services::redeem_grant(home.path(), &grant, "untrusted-name", "connect", None)
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
        bad["jti"] = json!(format!("bad-{field}"));
        assert_eq!(
            services::redeem_grant(
                home.path(),
                &encode(&header, &bad, &key).unwrap(),
                "",
                "connect",
                None
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
            "connect",
            None
        )
        .await
        .is_err()
    );
    assert!(
        services::redeem_grant(home.path(), "not-a-token", "", "connect", None)
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
        let files = json!({
            "hexbot": format!("{:x}", Sha256::digest(binary)),
            "node": format!("{:x}", Sha256::digest(b"signed node")),
            "hexbot-core": format!("{:x}", Sha256::digest(b"signed daemon"))
        });
        let metadata =
            serde_json::to_vec(&json!({"version":"9.8.7","builtAt":1,"files":files})).unwrap();
        for (name, bytes) in [
            ("manifest.json", metadata.as_slice()),
            ("node", b"signed node".as_slice()),
            ("hexbot-core", b"signed daemon".as_slice()),
        ] {
            let mut header = tar::Header::new_gnu();
            header.set_mode(0o700);
            header.set_size(bytes.len() as u64);
            header.set_cksum();
            archive.append_data(&mut header, name, bytes).unwrap();
        }
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
        *mock.data.manifest.lock().await = json!({"version":"9.8.7","builtAt":1,"target":format!("{}-{}",std::env::consts::OS,std::env::consts::ARCH),"url":format!("{}/binary",mock.base),"format":"tar.gz","entrypoint":"hexbot","sha256":format!("{:x}",Sha256::digest(&archive))});
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
            let selected: Value = serde_json::from_slice(
                &fs::read(home.path().join("runtime/native-current.json")).unwrap(),
            )
            .unwrap();
            assert_eq!(selected["files"], files);
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
    let error = services::call(
        home.path(),
        "local",
        "hexbot.update.request",
        &json!({"version":hexbot_core::version()}),
    )
    .await
    .unwrap()
    .unwrap_err();
    assert_eq!(error.code, 4212);
    // An older source build is refused after reading its chronology, before download.
    *mock.data.manifest.lock().await = json!({"version":"0.0.1","builtAt":0,"target":format!("{}-{}",std::env::consts::OS,std::env::consts::ARCH)});
    services::call(
        home.path(),
        "local",
        "hexbot.update.request",
        &json!({"version":"0.0.1"}),
    )
    .await
    .unwrap()
    .unwrap();
    let status = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let status = services::call(home.path(), "local", "hexbot.update.status", &json!({}))
                .await
                .unwrap()
                .unwrap();
            if status["status"] == "failed" {
                break status;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        status["message"],
        "The daemon already runs this build or a newer one."
    );
    assert!(!home.path().join("runtime/native-current.json").exists());
    let binary = b"#!/bin/sh\nprintf '9.8.7\\n'\n";
    *mock.data.binary.lock().await = binary.to_vec();
    *mock.data.manifest.lock().await = json!({"version":"9.8.7","builtAt":1,"target":format!("{}-{}",std::env::consts::OS,std::env::consts::ARCH),"url":format!("{}/binary",mock.base),"sha256":format!("{:x}",Sha256::digest(binary))});
    // Whoever controls the update origin cannot publish without the release key.
    *mock.data.unsigned.lock().await = true;
    services::call(
        home.path(),
        "local",
        "hexbot.update.request",
        &json!({"version":"9.8.7"}),
    )
    .await
    .unwrap()
    .unwrap();
    let status = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let status = services::call(home.path(), "local", "hexbot.update.status", &json!({}))
                .await
                .unwrap()
                .unwrap();
            if status["status"] == "failed" {
                break status;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(status["message"], hexbot_core::update_signature::INVALID);
    assert!(!home.path().join("runtime/native-current.json").exists());
    *mock.data.unsigned.lock().await = false;
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

#[tokio::test]
async fn registration_persists_pins_and_returns_only_status() {
    let mut mock = Mock::new().await;
    let home = home();
    mock.configure(home.path());
    *mock.data.response.lock().await = json!({"status":"approved","daemon_id":"daemon-1","daemon_token":"daemon-secret","slug":"kitchen","tunnel_hostname":"kitchen.connect.example","tunnel_token":"tunnel-secret","owner_id":"cloud-user","issuer":"https://connect.hexbot.app","keys":jwks()["keys"]});
    let response = services::register_poll(home.path(), "device-code", false)
        .await
        .unwrap();
    assert_eq!(response, json!({"status":"approved"}));
    let (body, _) = mock.event("/api/register/poll").await;
    assert_eq!(body["device_code"], "device-code");
    let config = services::ConnectConfig::load(home.path()).unwrap().unwrap();
    assert_eq!(
        body["public_key"],
        services::identity_response(home.path(), "host", "nonce")
            .await
            .unwrap()
            .unwrap()["public_key"]
    );
    assert!(
        !fs::read(home.path().join("connect-identity.key"))
            .unwrap()
            .is_empty()
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(home.path().join("connect-identity.key"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
    assert_eq!(config.owner_id, "cloud-user");
    assert_eq!(config.issuer, "https://connect.hexbot.app");
    assert_eq!(config.keys, jwks()["keys"].as_array().unwrap().to_vec());
    assert_eq!(config.daemon_token, "daemon-secret");
    assert_eq!(config.tunnel_token, "tunnel-secret");
}

fn pinned_registration(mock: &Mock, home: &std::path::Path) {
    mock.persist_registration(home);
    let path = home.join("connect.json");
    let mut config: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    config["owner_id"] = json!("actual-owner");
    config["issuer"] = json!("https://connect.hexbot.app");
    config["keys"] = jwks()["keys"].clone();
    fs::write(path, config.to_string()).unwrap();
}
fn signed_grant(claims: &Value) -> String {
    let mut header = jsonwebtoken::Header::new(jsonwebtoken::Algorithm::ES256);
    header.kid = Some("fixture".into());
    header.typ = Some("hexbot-grant+jwt".into());
    jsonwebtoken::encode(
        &header,
        claims,
        &jsonwebtoken::EncodingKey::from_ec_pem(TEST_KEY).unwrap(),
    )
    .unwrap()
}
fn grant_claims() -> Value {
    json!({"aud":"daemon-1","sub":"actual-owner","iss":"https://connect.hexbot.app","daemon_id":"daemon-1","device_name":"Grant fixture","jti":"grant-1","iat":common::now() as u64,"exp":common::now() as u64+300})
}

#[tokio::test]
async fn current_connect_grant_is_accepted() {
    let mock = Mock::new().await;
    let home = home();
    pinned_registration(&mock, home.path());
    let mut claims = grant_claims();
    claims["aud"] = json!("daemon-1");
    let result =
        services::redeem_grant(home.path(), &signed_grant(&claims), "", "connect", None).await;
    assert!(
        result.is_ok(),
        "Current Connect grants must work: {result:?}"
    );
}

#[tokio::test]
async fn wrong_pinned_owner_is_rejected() {
    let mock = Mock::new().await;
    let home = home();
    pinned_registration(&mock, home.path());
    let mut claims = grant_claims();
    claims["sub"] = json!("different-owner");
    let result =
        services::redeem_grant(home.path(), &signed_grant(&claims), "", "connect", None).await;
    assert!(
        result.is_err(),
        "Grant for another owner minted a local credential"
    );
}

#[tokio::test]
async fn unpinned_signing_key_is_rejected() {
    let mock = Mock::new().await;
    let home = home();
    pinned_registration(&mock, home.path());
    let path = home.path().join("connect.json");
    let mut config: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    config["keys"][0]["kid"] = json!("different-pinned-key");
    fs::write(path, config.to_string()).unwrap();
    let result = services::redeem_grant(
        home.path(),
        &signed_grant(&grant_claims()),
        "",
        "connect",
        None,
    )
    .await;
    assert!(
        result.is_err(),
        "Unpinned signing key minted a local credential"
    );
}

#[tokio::test]
async fn redeemed_grant_cannot_restore_revoked_access() {
    let mock = Mock::new().await;
    let home = home();
    pinned_registration(&mock, home.path());
    let grant = signed_grant(&grant_claims());
    let first = services::redeem_grant(home.path(), &grant, "", "connect", None)
        .await
        .unwrap();
    db::open(home.path())
        .unwrap()
        .execute(
            "UPDATE devices SET revoked_at=1 WHERE id=?",
            [first["device_id"].as_str().unwrap()],
        )
        .unwrap();
    let second = services::redeem_grant(home.path(), &grant, "", "connect", None).await;
    assert!(second.is_err(), "A spent grant restored revoked access");
}

#[test]
fn current_main_database_can_be_opened() {
    let home = home();
    db::open(home.path()).unwrap().execute_batch("UPDATE sections SET title_by='user'; INSERT INTO spent_grants VALUES ('existing',9999999999); UPDATE schema_version SET version=11;").unwrap();
    assert!(
        db::migrate(home.path()).is_ok(),
        "Current main's schema 11 is rejected"
    );
}

#[tokio::test]
async fn deleted_room_removes_native_transcripts() {
    let home = home();
    let app = hexbot_core::server::App::new(
        home.path().to_path_buf(),
        "127.0.0.1:0".parse().unwrap(),
        "/unused/pi".into(),
        None,
    )
    .unwrap();
    db::open(home.path()).unwrap().execute_batch("INSERT INTO bots(name,owner_id) VALUES('owl','local'); INSERT INTO rooms(id,name,owner_id) VALUES('room-a','Shared room','local'); INSERT INTO room_members(room_id,member_kind,member_id) VALUES('room-a','bot','owl'); INSERT INTO room_sessions(room_id,bot,stored_session_id) VALUES('room-a','owl','room-session-a');").unwrap();
    let dir = hexbot_core::runtime_store::session_dir(home.path(), "room-session-a").unwrap();
    fs::write(dir.join("conversation.jsonl"), "private room history").unwrap();
    hexbot_core::runtime_store::open(home.path()).unwrap().execute("INSERT INTO native_sessions(stored_id,owner,bot,prompt) VALUES('room-session-a','local','owl','private prompt')", []).unwrap();
    app.call("local", "hexbot.rooms.delete", &json!({"id":"room-a"}))
        .await
        .unwrap();
    app.shutdown().await;
    assert!(
        !dir.exists(),
        "Deleted room left its private native transcript on disk"
    );
}

#[tokio::test]
async fn grants_require_pinned_claims_header_and_published_key_material() {
    let mock = Mock::new().await;
    let home = home();
    pinned_registration(&mock, home.path());
    for (field, value) in [
        ("iss", json!("https://evil.example")),
        ("aud", json!("another-daemon")),
        ("aud", json!(["daemon-1"])),
        ("sub", json!("another-owner")),
        ("jti", json!(null)),
        ("iat", json!(common::now() + 61.)),
        ("exp", json!(common::now() - 61.)),
    ] {
        let mut claims = grant_claims();
        claims[field] = value;
        assert!(
            services::redeem_grant(home.path(), &signed_grant(&claims), "", "connect", None)
                .await
                .is_err(),
            "accepted {claims}"
        );
    }
    let mut header = jsonwebtoken::Header::new(jsonwebtoken::Algorithm::ES256);
    header.kid = Some("fixture".into());
    header.typ = Some("JWT".into());
    let grant = jsonwebtoken::encode(
        &header,
        &grant_claims(),
        &jsonwebtoken::EncodingKey::from_ec_pem(TEST_KEY).unwrap(),
    )
    .unwrap();
    assert!(
        services::redeem_grant(home.path(), &grant, "", "connect", None)
            .await
            .is_err()
    );
    let path = home.path().join("connect.json");
    let mut config: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    config["keys"][0]["x"] = json!("different-material");
    fs::write(&path, config.to_string()).unwrap();
    assert!(
        services::redeem_grant(
            home.path(),
            &signed_grant(&grant_claims()),
            "",
            "connect",
            None
        )
        .await
        .is_err()
    );
}

#[tokio::test]
async fn revoked_published_key_and_missing_registration_pins_fail_closed() {
    let mock = Mock::new().await;
    let home = home();
    pinned_registration(&mock, home.path());
    *mock.data.keys.lock().await = json!({"keys":[]});
    assert!(
        services::redeem_grant(
            home.path(),
            &signed_grant(&grant_claims()),
            "",
            "connect",
            None
        )
        .await
        .is_err()
    );
    let path = home.path().join("connect.json");
    let mut config: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    config.as_object_mut().unwrap().remove("owner_id");
    fs::write(&path, config.to_string()).unwrap();
    assert!(
        services::ConnectConfig::load(home.path())
            .unwrap()
            .is_none()
    );
    assert!(!services::start_daemon(home.path(), 12345).await.unwrap());
}

#[tokio::test]
async fn parallel_grant_redemption_and_jwks_cache() {
    let mut mock = Mock::new().await;
    let home = home();
    pinned_registration(&mock, home.path());
    let grant = signed_grant(&grant_claims());
    let (a, b) = tokio::join!(
        services::redeem_grant(home.path(), &grant, "", "connect", None),
        services::redeem_grant(home.path(), &grant, "", "connect", None)
    );
    assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
    mock.event("/.well-known/jwks.json").await;
    assert!(
        mock.events.try_recv().is_err(),
        "parallel requests fetched keys twice"
    );
    *mock.data.bad.lock().await = true;
    let mut claims = grant_claims();
    claims["jti"] = json!("cached-key");
    assert!(
        services::redeem_grant(home.path(), &signed_grant(&claims), "", "connect", None)
            .await
            .is_ok()
    );
    assert!(mock.events.try_recv().is_err());
    // A fresh verification call still consults the durable spent-grant table.
    assert!(
        services::redeem_grant(home.path(), &grant, "", "connect", None)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn grant_confirmation_requires_matching_verified_proof_before_spending() {
    let mock = Mock::new().await;
    let home = home();
    pinned_registration(&mock, home.path());
    let mut claims = grant_claims();
    claims["cnf"] = json!({"jkt":"client-thumbprint"});
    let grant = signed_grant(&claims);
    for key in [None, Some("wrong-key")] {
        assert!(
            services::redeem_grant(home.path(), &grant, "", "connect", key)
                .await
                .is_err()
        );
    }
    let device = services::redeem_grant(
        home.path(),
        &grant,
        "",
        "connect",
        Some("client-thumbprint"),
    )
    .await
    .unwrap();
    assert_eq!(
        auth::verify_token(home.path(), device["device_token"].as_str().unwrap())
            .unwrap()
            .unwrap()["jkt"],
        "client-thumbprint"
    );
    assert!(
        services::redeem_grant(
            home.path(),
            &grant,
            "",
            "connect",
            Some("client-thumbprint")
        )
        .await
        .is_err()
    );
}

#[tokio::test]
async fn registration_with_old_connect_retries_its_strict_poll_schema() {
    let mut mock = Mock::new().await;
    let home = home();
    mock.configure(home.path());
    *mock.data.legacy_poll.lock().await = true;
    *mock.data.response.lock().await = json!({"status":"approved","daemon_id":"daemon-1","daemon_token":"daemon-secret","slug":"kitchen","tunnel_hostname":"kitchen.connect.example","tunnel_token":"tunnel-secret","owner_id":"cloud-user","issuer":"https://connect.hexbot.app","keys":jwks()["keys"]});
    assert_eq!(
        services::register_poll(home.path(), "device-code", false)
            .await
            .unwrap(),
        json!({"status":"approved"})
    );
    let (first, _) = mock.event("/api/register/poll").await;
    let (second, _) = mock.event("/api/register/poll").await;
    assert_eq!(second, json!({"device_code":"device-code"}));
    assert_eq!(
        first["public_key"],
        services::identity_response(home.path(), "host", "nonce")
            .await
            .unwrap()
            .unwrap()["public_key"]
    );
    services::shutdown(home.path()).await.unwrap();
}
