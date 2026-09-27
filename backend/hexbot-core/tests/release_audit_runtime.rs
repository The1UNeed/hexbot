// Review-only reproductions using the PR's runtime fixture.
include!("runtime.rs");

#[tokio::test]
async fn audit_disabled_messaging_and_scheduling_are_not_advertised() {
    let home = setup();
    let runtime = Runtime::new(home.path().into(), EventHub::new(), fake_pi(home.path())).unwrap();
    open(&runtime, "alice").await;
    let options: Value = serde_json::from_slice(
        &fs::read(home.path().join("runtime/sessions/section-a/config.json")).unwrap(),
    )
    .unwrap();
    runtime.shutdown().await;
    let names: Vec<_> = options["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    assert!(
        !names.contains(&"message_bot") && !names.contains(&"cronjob_manage"),
        "Disabled tools remain available: {names:?}"
    );
}

#[tokio::test]
async fn audit_python_uses_the_section_working_directory() {
    let home = setup();
    fs::write(
        home.path().join("profiles/owl/config.yaml"),
        "tools:\n  enabled_toolsets: [code_execution]\n",
    )
    .unwrap();
    let workspace = home.path().join("workspace");
    fs::create_dir_all(&workspace).unwrap();
    let executable = fake_pi(home.path());
    let source = fs::read_to_string(&executable).unwrap().replace(
        "const rl=",
        "require('node:fs').writeFileSync('shared.txt', 'same directory');\nconst rl=",
    );
    fs::write(&executable, source).unwrap();
    let runtime = Runtime::new(home.path().into(), EventHub::new(), executable).unwrap();
    open(&runtime, "alice").await;
    let options: Value = serde_json::from_slice(
        &fs::read(home.path().join("runtime/sessions/section-a/config.json")).unwrap(),
    )
    .unwrap();
    let pi_cwd = std::path::Path::new(options["cwd"].as_str().unwrap());
    assert_eq!(
        fs::read_to_string(pi_cwd.join("shared.txt")).unwrap(),
        "same directory"
    );
    let result = hexbot_core::native_tools::call(home.path(), "alice", "owl", "section-a", "execute_code", &json!({"code":"import os\nassert open('shared.txt').read() == 'same directory'\nprint(os.getcwd())"})).await.unwrap();
    runtime.shutdown().await;
    hexbot_core::native_tools::close_session(home.path(), "section-a").await;
    assert_eq!(
        result["output"].as_str().unwrap().trim(),
        workspace.canonicalize().unwrap().to_str().unwrap(),
        "Python tools ignored the configured section workspace"
    );
}

#[test]
fn audit_legacy_compression_chain_keeps_all_display_history() {
    let home = setup();
    let legacy = rusqlite::Connection::open(home.path().join("profiles/owl/state.db")).unwrap();
    legacy.execute_batch("CREATE TABLE sessions(id TEXT PRIMARY KEY,session_key TEXT,parent_session_id TEXT); CREATE TABLE messages(id INTEGER,session_id TEXT,role TEXT,content TEXT,timestamp REAL,active INTEGER,display_kind TEXT); INSERT INTO sessions VALUES('old-root','section-a',NULL),('new-tip','section-a','old-root'); INSERT INTO messages VALUES(1,'old-root','user','Before compaction',100,1,'normal'),(2,'new-tip','user','After compaction',200,1,'normal');").unwrap();
    runtime_store::import_hermes(home.path(), "owl", "section-a", home.path()).unwrap();
    let history = runtime_store::history(home.path(), "section-a").unwrap();
    assert_eq!(
        history.len(),
        2,
        "Migration lost one compression segment: {history:?}"
    );
}

#[tokio::test]
async fn audit_section_close_releases_the_live_session() {
    let home = setup();
    let app = hexbot_core::server::App::new(
        home.path().into(),
        "127.0.0.1:0".parse().unwrap(),
        fake_pi(home.path()),
        None,
    )
    .unwrap();
    app.call("alice", "hexbot.sections.open", &json!({"id":"section-a"}))
        .await
        .unwrap();
    app.call("alice", "hexbot.sections.close", &json!({"id":"section-a"}))
        .await
        .unwrap();
    let remaining = app
        .call("alice", "session.active_list", &json!({}))
        .await
        .unwrap();
    app.shutdown().await;
    assert_eq!(
        remaining["sessions"].as_array().unwrap().len(),
        0,
        "Closed section kept a live Pi session"
    );
}

#[tokio::test]
async fn audit_deleting_section_removes_delegated_transcripts() {
    let home = setup();
    let app = hexbot_core::server::App::new(
        home.path().into(),
        "127.0.0.1:0".parse().unwrap(),
        fake_pi(home.path()),
        None,
    )
    .unwrap();
    let dir = runtime_store::session_dir(home.path(), "child-a").unwrap();
    fs::write(dir.join("conversation.jsonl"), "private delegated work").unwrap();
    runtime_store::open(home.path()).unwrap().execute("INSERT INTO native_sessions(stored_id,owner,bot,prompt,options) VALUES('child-a','alice','owl','private prompt',?)", [json!({"parent_session":"section-a"}).to_string()]).unwrap();
    app.call(
        "alice",
        "hexbot.sections.delete",
        &json!({"id":"section-a"}),
    )
    .await
    .unwrap();
    app.shutdown().await;
    assert!(
        !dir.exists(),
        "Deleting a section retained its delegated transcript"
    );
}
