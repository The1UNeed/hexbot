use hexbot_core::{db, settings};
use serde_json::json;
use std::fs;

fn setup() -> tempfile::TempDir {
    let home = tempfile::tempdir().unwrap();
    db::migrate(home.path()).unwrap();
    db::open(home.path()).unwrap().execute_batch(
        "INSERT INTO users(id,display_name,role,created_at) VALUES ('alice','Alice','admin',0),('bob','Bob','member',0); INSERT INTO bots(name,owner_id,approval_mode,workdir) VALUES ('owl','alice','off',''),('fox','bob','',''); INSERT INTO sections(id,bot,owner_id) VALUES ('a','owl','alice'),('b','owl','bob'),('c','fox','bob');"
    ).unwrap();
    // Keep all test workspace writes inside the test home.
    db::open(home.path())
        .unwrap()
        .execute(
            "INSERT INTO settings(key,value) VALUES ('workspace_dir',?)",
            [json!(home.path().join("workspace")).to_string()],
        )
        .unwrap();
    home
}

#[test]
fn defaults_and_settings_are_persisted_and_access_controlled() {
    let home = setup();
    let settings = settings::get(home.path()).unwrap();
    assert_eq!(settings["dream_time"], "03:00");
    assert_eq!(settings["room_bot_turns_per_human_turn"], 8);
    assert_eq!(settings["approval_mode"], "smart");
    assert!(settings.get("auto_approver_model").is_none());
    // An older app's approver model picker is accepted and ignored.
    let accepted = settings::update(
        home.path(),
        "alice",
        &json!({"auto_approver_model":"openai/small"}),
    )
    .unwrap();
    assert!(accepted.get("auto_approver_model").is_none());
    assert!(
        settings::get(home.path())
            .unwrap()
            .get("auto_approver_model")
            .is_none()
    );
    assert_eq!(
        settings::update(home.path(), "missing", &json!({}))
            .unwrap_err()
            .code,
        4302
    );
    let result = settings::update(
        home.path(),
        "alice",
        &json!({"dream_time":"23:59","default_model":"openai/gpt-4","bot_daily_token_budget":0}),
    )
    .unwrap();
    assert_eq!(settings::get(home.path()).unwrap(), result);
    assert_eq!(
        settings::call(home.path(), "missing", "hexbot.settings.get", &json!({}))
            .unwrap()
            .unwrap_err()
            .code,
        4302
    );
}

#[test]
fn invalid_patches_never_partially_change_settings_or_profiles() {
    let home = setup();
    let initial = settings::get(home.path()).unwrap();
    for patch in [
        json!(null),
        json!([]),
        json!({"unknown":1}),
        json!({"approval_mode":"manual","dream_time":"24:00"}),
        json!({"dream_time":"0:00"}),
        json!({"dream_enabled":1}),
        json!({"room_bot_turns_per_human_turn":true}),
        json!({"bot_daily_token_budget":-1}),
        json!({"room_budget_tokens_per_human_turn":1.2}),
        json!({"default_model":"bad"}),
        json!({"workspace_dir":[]}),
    ] {
        assert!(
            settings::update(home.path(), "alice", &patch).is_err(),
            "accepted {patch}"
        );
        assert_eq!(settings::get(home.path()).unwrap(), initial);
        assert!(!home.path().join("config.yaml").exists());
    }
}

#[test]
fn mirrors_overrides_and_preserves_unmanaged_config_values() {
    let home = setup();
    let profile = home.path().join("profiles/owl");
    fs::create_dir_all(&profile).unwrap();
    fs::write(profile.join("config.yaml"),"model: custom/model\nterminal:\n  timeout: 120\nmemory:\n  memory_char_limit: 9000\nauxiliary:\n  approval:\n    timeout: 15\n").unwrap();
    let workdir = home.path().join("owl-workspace");
    db::open(home.path())
        .unwrap()
        .execute(
            "UPDATE bots SET workdir=? WHERE name='owl'",
            [workdir.to_str().unwrap()],
        )
        .unwrap();
    settings::update(
        home.path(),
        "alice",
        &json!({"approval_mode":"smart","fallback_model":"anthropic/backup"}),
    )
    .unwrap();
    let read = |path: &std::path::Path| -> serde_json::Value {
        serde_yaml::from_str(&fs::read_to_string(path.join("config.yaml")).unwrap()).unwrap()
    };
    let config = read(&profile);
    assert_eq!(config["model"], "custom/model");
    assert_eq!(config["approvals"]["mode"], "off");
    assert_eq!(config["terminal"]["timeout"], 120);
    assert_eq!(config["terminal"]["cwd"], json!(workdir));
    assert_eq!(config["memory"]["memory_char_limit"], 9000);
    assert_eq!(config["memory"]["user_profile_enabled"], false);
    assert_eq!(config["auxiliary"]["approval"]["timeout"], 15);
    assert_eq!(
        config["fallback_providers"],
        json!([{"provider":"anthropic","model":"backup"}])
    );
    assert_eq!(read(home.path())["approvals"]["mode"], "smart");
    settings::update(home.path(), "alice", &json!({"fallback_model":null})).unwrap();
    assert!(read(&profile).get("fallback_providers").is_none());
}

fn usage(home: &std::path::Path) {
    let profile = home.join("profiles/owl");
    fs::create_dir_all(&profile).unwrap();
    let conn = rusqlite::Connection::open(profile.join("state.db")).unwrap();
    conn.execute_batch("CREATE TABLE session_model_usage(session_id TEXT,input_tokens INTEGER,output_tokens INTEGER,estimated_cost_usd REAL,last_seen REAL); INSERT INTO session_model_usage VALUES ('a',100,10,0.1,100),('a',200,20,0.2,200),('b',999,99,9.0,200),('room-a',30,3,0.03,200);").unwrap();
    db::open(home).unwrap().execute_batch("INSERT INTO rooms(id,name,owner_id) VALUES ('room','Room','bob'); INSERT INTO room_members(room_id,member_kind,member_id,added_by) VALUES ('room','bot','owl','alice'); INSERT INTO room_sessions(room_id,bot,stored_session_id) VALUES ('room','owl','room-a');").unwrap();
}

#[test]
fn usage_is_owned_inclusive_at_since_and_attributes_room_bots_to_adder() {
    let home = setup();
    usage(home.path());
    let data = settings::summary(home.path(), "alice", 200.0).unwrap();
    assert_eq!(data["input_tokens"], 230);
    assert_eq!(data["output_tokens"], 23);
    assert!((data["estimated_cost_usd"].as_f64().unwrap() - 0.23).abs() < 0.000001);
    assert_eq!(data["by_bot"].as_array().unwrap().len(), 1);
    assert_eq!(
        settings::summary(home.path(), "alice", 200.1).unwrap()["input_tokens"],
        0
    );
    assert_eq!(
        settings::summary(home.path(), "bob", 0.0).unwrap()["input_tokens"],
        999
    );
}

#[test]
fn incidents_deduplicate_truncate_unicode_and_resolve_only_matching_causes() {
    let home = setup();
    let first = settings::record_incident(
        home.path(),
        "owl",
        "turn_failed",
        &"界".repeat(600),
        &json!({"section_id":"a","session_id":"live"}),
    )
    .unwrap();
    assert_eq!(first["text"].as_str().unwrap().chars().count(), 500);
    let repeat = settings::record_incident(
        home.path(),
        "owl",
        "turn_failed",
        "again",
        &json!({"section_id":"a"}),
    )
    .unwrap();
    assert_eq!(first["id"], repeat["id"]);
    assert_eq!(repeat["session_id"], "live");
    settings::record_incident(
        home.path(),
        "owl",
        "connector_error",
        "expired",
        &json!({"connector":"github"}),
    )
    .unwrap();
    assert!(settings::resolve_incidents(home.path(), &json!({"kind":"turn_failed"})).is_err());
    let resolved =
        settings::resolve_incidents(home.path(), &json!({"section_id":"a","kind":"turn_failed"}))
            .unwrap();
    assert_eq!(resolved.len(), 1);
    assert!(resolved[0]["resolved_at"].is_number());
    assert!(
        settings::resolve_incidents(home.path(), &json!({"section_id":"a"}))
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        settings::resolve_incidents(home.path(), &json!({"connector":"github"}))
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn native_usage_merges_legacy_and_counts_cached_input_without_cross_user_leaks() {
    let home = setup();
    usage(home.path());
    let conn = hexbot_core::runtime_store::open(home.path()).unwrap();
    conn.execute_batch("INSERT INTO native_usage(session_id,owner_id,bot,model,provider,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cost,timestamp) VALUES ('a','alice','owl','m','p',10,2,20,30,0.1,200),('a','alice','owl','m','p',1000,2,0,0,0.1,199),('b','bob','owl','m','p',1000,2,0,0,0.1,200);").unwrap();
    let data = settings::summary(home.path(), "alice", 200.0).unwrap();
    assert_eq!(data["input_tokens"], 290);
    assert_eq!(data["output_tokens"], 25);
    assert!((data["estimated_cost_usd"].as_f64().unwrap() - 0.33).abs() < 0.000001);
}

#[test]
fn yaml_updates_preserve_comments_order_unknown_blocks_and_scalar_types() {
    let home = setup();
    let path = home.path().join("config.yaml");
    let source = "# deployment notes\ncustom: &custom\n  quoted: 'yes' # a string, not a boolean\n  message: |\n    first\n    # literal text\ncopy: *custom\napprovals:\n  # Keep manual for guests\n  mode: manual # chosen mode\nterminal:\n  timeout: 90 # seconds\n";
    fs::write(&path, source).unwrap();
    settings::update(home.path(), "alice", &json!({"approval_mode":"smart"})).unwrap();
    let after = fs::read_to_string(&path).unwrap();
    assert!(after.contains("# deployment notes"));
    assert!(after.contains("# Keep manual for guests"));
    assert!(after.contains("# chosen mode"));
    assert!(after.contains("timeout: 90 # seconds"));
    assert!(after.contains("custom: &custom\n  quoted: 'yes' # a string, not a boolean\n  message: |\n    first\n    # literal text\ncopy: *custom\n"));
    let parsed: serde_json::Value = serde_yaml::from_str(&after).unwrap();
    assert_eq!(parsed["custom"]["quoted"], "yes");
    assert_eq!(parsed["approvals"]["mode"], "smart");
    let before = after;
    hexbot_core::common::write_config(home.path(), &parsed).unwrap();
    assert_eq!(fs::read_to_string(&path).unwrap(), before);
}

#[test]
fn yaml_deletion_and_type_changes_remain_semantically_exact() {
    let home = setup();
    let path = home.path().join("profile.yaml");
    fs::write(
        &path,
        "# header\nkeep: 'true' # note\nremove: obsolete\nmodel: old\n",
    )
    .unwrap();
    let desired = json!({"keep":"true","model":{"provider":"custom","default":"a/model"},"list":[{"value":true},null,42]});
    hexbot_core::common::write_yaml(&path, &desired).unwrap();
    let text = fs::read_to_string(&path).unwrap();
    assert!(text.contains("# header"));
    assert!(text.contains("keep: 'true' # note"));
    assert!(!text.contains("remove:"));
    assert_eq!(
        serde_yaml::from_str::<serde_json::Value>(&text).unwrap(),
        desired
    );
    fs::write(&path, "# Only a comment\n").unwrap();
    hexbot_core::common::write_yaml(&path, &json!({"enabled":true})).unwrap();
    assert!(
        fs::read_to_string(&path)
            .unwrap()
            .contains("# Only a comment")
    );
    // Removing the last key (what disconnecting Connect does to a config holding only the
    // public URL) leaves a comment-only file, which reads back as the empty mapping.
    hexbot_core::common::write_yaml(&path, &json!({})).unwrap();
    let text = fs::read_to_string(&path).unwrap();
    assert!(text.contains("# Only a comment"));
    assert!(!text.contains("enabled"));
    fs::write(home.path().join("config.yaml"), &text).unwrap();
    assert_eq!(
        hexbot_core::common::read_config(home.path()).unwrap(),
        json!({})
    );
}
