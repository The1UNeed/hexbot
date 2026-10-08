use hexbot_core::{auth, db};
use serde_json::{Value, json};
use std::sync::{Arc, Barrier};
fn rpc(
    home: &std::path::Path,
    caller: &str,
    method: &str,
    params: Value,
) -> hexbot_core::Result<Value> {
    auth::call(home, caller, method, &params).expect("auth method")
}
#[test]
fn devices_belong_to_the_owner_and_invites_are_gone() {
    let home = tempfile::tempdir().unwrap();
    let h = home.path();
    let code = auth::new_code(h, "local").unwrap();
    let device = auth::redeem_code_from(
        h,
        code["code"].as_str().unwrap(),
        "Phone",
        "browser",
        "local",
        None,
    )
    .unwrap();
    let token = device["device_token"].as_str().unwrap();
    assert_eq!(
        auth::verify_token(h, token).unwrap().unwrap()["owner_id"],
        "local"
    );
    for method in ["hexbot.users.invite", "hexbot.users.update"] {
        assert!(
            auth::call(h, "local", method, &json!({})).is_none(),
            "{method}"
        );
    }
    assert_eq!(
        rpc(h, "local", "hexbot.devices.list", json!({})).unwrap()["devices"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    rpc(
        h,
        "local",
        "hexbot.devices.revoke",
        json!({"id":device["device_id"]}),
    )
    .unwrap();
    assert!(auth::verify_token(h, token).unwrap().is_none());
    assert_eq!(
        rpc(
            h,
            "local",
            "hexbot.devices.revoke",
            json!({"id":device["device_id"]})
        )
        .unwrap_err()
        .code,
        4204
    );
}
#[test]
fn concurrent_pairing_has_exactly_one_winner() {
    let home = tempfile::tempdir().unwrap();
    let code = auth::new_code(home.path(), "local").unwrap()["code"]
        .as_str()
        .unwrap()
        .to_lowercase()
        .replace('-', " ");
    let barrier = Arc::new(Barrier::new(8));
    let threads: Vec<_> = (0..8)
        .map(|_| {
            let h = home.path().to_owned();
            let c = code.clone();
            let b = barrier.clone();
            std::thread::spawn(move || {
                b.wait();
                auth::redeem_code_from(&h, &c, "Phone", "browser", "local", None)
            })
        })
        .collect();
    let results: Vec<_> = threads.into_iter().map(|t| t.join().unwrap()).collect();
    assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
    assert!(
        results
            .iter()
            .filter_map(|r| r.as_ref().err())
            .all(|e| e.code == 4231)
    );
    assert_eq!(
        db::open(home.path())
            .unwrap()
            .query_row("SELECT COUNT(*) FROM devices", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
}
#[test]
fn replacement_expiry_hashes_and_rate_limits() {
    let home = tempfile::tempdir().unwrap();
    let h = home.path();
    let first = auth::new_code(h, "local").unwrap();
    let second = auth::new_code(h, "local").unwrap();
    assert_eq!(
        auth::redeem_code_from(
            h,
            first["code"].as_str().unwrap(),
            "Phone",
            "browser",
            "local",
            None
        )
        .unwrap_err()
        .code,
        4231
    );
    let device = auth::redeem_code_from(
        h,
        second["code"].as_str().unwrap(),
        "Phone",
        "browser",
        "local",
        None,
    )
    .unwrap();
    let token = device["device_token"].as_str().unwrap();
    let conn = db::open(h).unwrap();
    let hash: String = conn
        .query_row("SELECT token_hash FROM devices", [], |r| r.get(0))
        .unwrap();
    assert_eq!(hash.len(), 64);
    assert_ne!(hash, token);
    let row = auth::verify_token(h, token).unwrap().unwrap();
    assert!(row.get("token_hash").is_none());
    assert!(auth::verify_token(h, &hash).unwrap().is_none());
    assert!(auth::verify_token(h, "").unwrap().is_none());
    let expired = auth::new_code(h, "local").unwrap();
    conn.execute("UPDATE pairing_codes SET expires_at=0", [])
        .unwrap();
    assert_eq!(
        auth::redeem_code_from(
            h,
            expired["code"].as_str().unwrap(),
            "Phone",
            "browser",
            "local",
            None
        )
        .unwrap_err()
        .code,
        4231
    );
    for _ in 0..7 {
        assert_eq!(
            auth::redeem_code_from(h, "invalid", "Phone", "browser", "local", None)
                .unwrap_err()
                .code,
            4231
        );
    }
    assert_eq!(
        auth::redeem_code_from(h, "invalid", "Phone", "browser", "local", None)
            .unwrap_err()
            .code,
        4232
    );
}
#[test]
fn local_token_is_private_persistent_and_recovers() {
    let home = tempfile::tempdir().unwrap();
    let h = home.path();
    let token = auth::local_token(h).unwrap();
    assert_eq!(token, auth::local_token(h).unwrap());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(h.join("local-device.token"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
    std::fs::remove_file(h.join("local-device.token")).unwrap();
    let new = auth::local_token(h).unwrap();
    assert_ne!(new, token);
    assert!(auth::verify_token(h, &token).unwrap().is_none());
    let barrier = Arc::new(Barrier::new(5));
    let threads: Vec<_> = (0..5)
        .map(|_| {
            let h = h.to_owned();
            let b = barrier.clone();
            std::thread::spawn(move || {
                b.wait();
                auth::local_token(&h).unwrap()
            })
        })
        .collect();
    for t in threads {
        assert_eq!(t.join().unwrap(), new);
    }
    assert_eq!(
        db::open(h)
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM devices WHERE revoked_at IS NULL",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        1
    );
}
#[test]
fn renaming_yourself_and_last_seen() {
    let home = tempfile::tempdir().unwrap();
    let h = home.path();
    let token = auth::local_token(h).unwrap();
    assert_eq!(
        rpc(h, "local", "hexbot.users.me", json!({})).unwrap(),
        json!({"id":"local","display_name":"Admin","role":"admin"})
    );
    // Apps older than 0.1.6 list users when the role is admin.
    assert_eq!(
        rpc(h, "local", "hexbot.users.list", json!({})).unwrap(),
        json!({"users":[{"id":"local","display_name":"Admin","role":"admin"}]})
    );
    for (bad, code) in [
        (json!({}), 4200),
        (json!({"display_name":"   "}), 4200),
        (json!({"display_name":"x".repeat(65)}), 4202),
        (json!({"display_name":"Alex","role":"member"}), 4201),
    ] {
        assert_eq!(
            rpc(h, "local", "hexbot.users.me.set", bad)
                .unwrap_err()
                .code,
            code
        );
    }
    assert_eq!(
        rpc(
            h,
            "local",
            "hexbot.users.me.set",
            json!({"display_name":"  Alex  "})
        )
        .unwrap(),
        json!({"id":"local","display_name":"Alex"})
    );
    assert_eq!(
        rpc(h, "local", "hexbot.users.me", json!({})).unwrap()["display_name"],
        "Alex"
    );
    db::open(h)
        .unwrap()
        .execute("UPDATE devices SET last_seen_at=0", [])
        .unwrap();
    let seen = auth::verify_token(h, &token).unwrap().unwrap()["last_seen_at"]
        .as_f64()
        .unwrap();
    assert!(seen > 0.);
    assert_eq!(
        auth::verify_token(h, &token).unwrap().unwrap()["last_seen_at"],
        seen
    );
}

#[test]
fn exhausted_client_cannot_redeem_valid_code_but_another_client_can() {
    let home = tempfile::tempdir().unwrap();
    let code = auth::new_code(home.path(), "local").unwrap();
    for _ in 0..10 {
        assert_eq!(
            auth::redeem_code_from(
                home.path(),
                "wrong",
                "Phone",
                "browser",
                "192.168.1.2",
                None
            )
            .unwrap_err()
            .code,
            4231
        );
    }
    assert_eq!(
        auth::redeem_code_from(
            home.path(),
            code["code"].as_str().unwrap(),
            "Phone",
            "browser",
            "192.168.1.2",
            None
        )
        .unwrap_err()
        .code,
        4232
    );
    assert!(
        auth::redeem_code_from(
            home.path(),
            code["code"].as_str().unwrap(),
            "Laptop",
            "browser",
            "192.168.1.3",
            None
        )
        .is_ok()
    );
}

#[test]
fn concurrent_grants_spend_once_and_disabled_owner_rolls_back() {
    let home = tempfile::tempdir().unwrap();
    db::migrate(home.path()).unwrap();
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(8));
    let results: Vec<_> = (0..8)
        .map(|_| {
            let home = home.path().to_owned();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                auth::redeem_verified_grant(
                    &home,
                    "Browser",
                    "connect",
                    "one-grant",
                    hexbot_core::common::now() + 300.,
                    None,
                )
            })
        })
        .collect();
    assert_eq!(
        results
            .into_iter()
            .filter_map(|t| t.join().unwrap().ok())
            .count(),
        1
    );
    let db = db::open(home.path()).unwrap();
    assert_eq!(
        db.query_row("SELECT COUNT(*) FROM devices", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
    db.execute("UPDATE users SET disabled_at=1 WHERE id='local'", [])
        .unwrap();
    assert!(
        auth::redeem_verified_grant(
            home.path(),
            "Browser",
            "connect",
            "disabled",
            hexbot_core::common::now() + 300.,
            None
        )
        .is_err()
    );
    assert_eq!(
        db.query_row(
            "SELECT COUNT(*) FROM spent_grants WHERE jti='disabled'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
}

#[test]
fn startup_sign_in_code_preserves_outstanding_pairing_codes() {
    let home = tempfile::tempdir().unwrap();
    let pair = auth::new_code(home.path(), "local").unwrap();
    let link = auth::new_sign_in_code(home.path()).unwrap();
    for code in [pair, link] {
        assert!(
            auth::redeem_code_from(
                home.path(),
                code["code"].as_str().unwrap(),
                "Browser",
                "browser",
                "local",
                None
            )
            .is_ok()
        );
        assert_eq!(
            auth::redeem_code_from(
                home.path(),
                code["code"].as_str().unwrap(),
                "Browser",
                "browser",
                "local",
                None
            )
            .unwrap_err()
            .code,
            4231
        );
    }
}
