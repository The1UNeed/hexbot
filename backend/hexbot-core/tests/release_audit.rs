// Review-only reproductions, not a proposed implementation change.
include!("services.rs");

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
    jsonwebtoken::encode(&header, claims, &jsonwebtoken::EncodingKey::from_ec_pem(TEST_KEY).unwrap()).unwrap()
}
fn grant_claims() -> Value {
    json!({"sub":"actual-owner","iss":"https://connect.hexbot.app","daemon_id":"daemon-1","device_name":"Review fixture","jti":"review-grant-1","iat":common::now() as u64,"exp":common::now() as u64+300})
}

#[tokio::test]
async fn audit_current_connect_grant_is_accepted() {
    let mock = Mock::new().await;
    let home = home();
    pinned_registration(&mock, home.path());
    let mut claims = grant_claims();
    claims["aud"] = json!("daemon-1");
    let result = services::redeem_grant(home.path(), &signed_grant(&claims), "", "connect").await;
    assert!(result.is_ok(), "Current Connect grants must work: {result:?}");
}

#[tokio::test]
async fn audit_wrong_pinned_owner_is_rejected() {
    let mock = Mock::new().await;
    let home = home();
    pinned_registration(&mock, home.path());
    let mut claims = grant_claims();
    claims["sub"] = json!("different-owner");
    let result = services::redeem_grant(home.path(), &signed_grant(&claims), "", "connect").await;
    assert!(result.is_err(), "Grant for another owner minted a local credential");
}

#[tokio::test]
async fn audit_unpinned_signing_key_is_rejected() {
    let mock = Mock::new().await;
    let home = home();
    pinned_registration(&mock, home.path());
    let path = home.path().join("connect.json");
    let mut config: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    config["keys"][0]["kid"] = json!("different-pinned-key");
    fs::write(path, config.to_string()).unwrap();
    let result = services::redeem_grant(home.path(), &signed_grant(&grant_claims()), "", "connect").await;
    assert!(result.is_err(), "Unpinned signing key minted a local credential");
}

#[tokio::test]
async fn audit_redeemed_grant_cannot_restore_revoked_access() {
    let mock = Mock::new().await;
    let home = home();
    pinned_registration(&mock, home.path());
    let grant = signed_grant(&grant_claims());
    let first = services::redeem_grant(home.path(), &grant, "", "connect").await.unwrap();
    db::open(home.path()).unwrap().execute("UPDATE devices SET revoked_at=1 WHERE id=?", [first["device_id"].as_str().unwrap()]).unwrap();
    let second = services::redeem_grant(home.path(), &grant, "", "connect").await;
    assert!(second.is_err(), "A spent grant restored revoked access");
}

#[test]
fn audit_current_main_database_can_be_opened() {
    let home = home();
    db::open(home.path()).unwrap().execute_batch("ALTER TABLE sections ADD COLUMN title_by TEXT; CREATE TABLE spent_grants(jti TEXT PRIMARY KEY, exp REAL NOT NULL); UPDATE schema_version SET version=11;").unwrap();
    assert!(db::migrate(home.path()).is_ok(), "Current main's schema 11 is rejected");
}

#[tokio::test]
async fn audit_deleted_room_removes_native_transcripts() {
    let home = home();
    let app = hexbot_core::server::App::new(home.path().to_path_buf(), "127.0.0.1:0".parse().unwrap(), "/unused/pi".into(), None).unwrap();
    db::open(home.path()).unwrap().execute_batch("INSERT INTO bots(name,owner_id) VALUES('owl','local'); INSERT INTO rooms(id,name,owner_id) VALUES('room-a','Audit room','local'); INSERT INTO room_members(room_id,member_kind,member_id) VALUES('room-a','bot','owl'); INSERT INTO room_sessions(room_id,bot,stored_session_id) VALUES('room-a','owl','room-session-a');").unwrap();
    let dir = hexbot_core::runtime_store::session_dir(home.path(), "room-session-a").unwrap();
    fs::write(dir.join("conversation.jsonl"), "private room history").unwrap();
    hexbot_core::runtime_store::open(home.path()).unwrap().execute("INSERT INTO native_sessions(stored_id,owner,bot,prompt) VALUES('room-session-a','local','owl','private prompt')", []).unwrap();
    app.call("local", "hexbot.rooms.delete", &json!({"id":"room-a"})).await.unwrap();
    app.shutdown().await;
    assert!(!dir.exists(), "Deleted room left its private native transcript on disk");
}
