use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};
fn event(args: &Value) -> Value {
    json!({"type":"extension_ui_request","id":"probe:pi-file","method":"input","title":format!("__HEXBOT_TOOL__{}",json!({"name":"hexbot_pi_file","args":args}))})
}
fn args(runtime: &Runtime, s: &Live, path: &Path, operation: &str) -> Value {
    let live = runtime.session_settings(s).unwrap();
    json!({"operation":operation,"path":path,"callId":"file","content":STANDARD.encode("ordinary"),"snapshot":{
        "approvalMode":live["approvalMode"],"cwd":live["cwd"],"outputDirs":live["outputDirs"],"fileWorkdir":live["fileWorkdir"],"fileEpoch":live["fileEpoch"]
    }})
}
fn start(runtime: &Runtime, s: &Arc<Live>, tool: &str) {
    runtime
        .event(
            s,
            json!({"type":"tool_execution_start","toolName":tool,"toolCallId":"file","args":{}}),
        )
        .unwrap();
}
async fn reply(runtime: &Runtime, s: &Arc<Live>, hub: &EventHub, args: &Value) -> Value {
    let mut events = hub.subscribe();
    runtime.event(s, event(args)).unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let message = events.recv().await.unwrap();
            if let Some(text) = message.frame["params"]["payload"]["text"].as_str()
                && let Ok(response) = serde_json::from_str::<Value>(text)
                && response["id"] == "probe:pi-file"
            {
                return response;
            }
        }
    })
    .await
    .unwrap()
}
#[tokio::test]
async fn private_pi_file_route_is_anchored_and_not_a_public_tool() {
    let (home, runtime, hub) = setup();
    fs::write(
        home.path().join("profiles/owl/config.yaml"),
        "tools:\n  enabled_toolsets: [file]\n",
    )
    .unwrap();
    let s = runtime.open_session("alice", "owl", "first").await.unwrap();
    let path = home
        .workspace()
        .canonicalize()
        .unwrap()
        .join("new/nested/file");
    let request = args(&runtime, &s, &path, "write");
    start(&runtime, &s, "write");
    let response = reply(&runtime, &s, &hub, &request).await;
    let answer: Value = serde_json::from_str(response["value"].as_str().unwrap()).unwrap();
    assert_eq!(answer, json!({"result":{"success":true}}));
    assert_eq!(fs::read_to_string(&path).unwrap(), "ordinary");
    let artifact = home
        .path()
        .canonicalize()
        .unwrap()
        .join("profiles/owl/artifacts/new/file");
    let artifact_request = args(&runtime, &s, &artifact, "write");
    assert!(
        runtime
            .pi_file(&s, &event(&artifact_request), &artifact_request)
            .is_ok()
    );
    assert_eq!(fs::read_to_string(artifact).unwrap(), "ordinary");
    assert!(runtime.tool(&s, "hexbot_pi_file", &request).await.is_err());
    runtime.register_worker_bridge(&s);
    let dispatch = crate::native_tools::dispatcher(home.path(), &s.stored).unwrap();
    assert!(
        dispatch("hexbot_pi_file".into(), request.clone())
            .await
            .is_err()
    );
    start(&runtime, &s, "edit");
    let mut edit = args(&runtime, &s, &path, "edit_open");
    let opened = runtime.pi_file(&s, &event(&edit), &edit).unwrap();
    edit["operation"] = json!("edit_commit");
    edit["parent"] = opened["parent"].clone();
    let folder = path.parent().unwrap();
    let moved = folder.with_file_name("moved");
    fs::rename(folder, &moved).unwrap();
    fs::create_dir(folder).unwrap();
    fs::write(&path, "replacement").unwrap();
    assert!(
        runtime
            .pi_file(&s, &event(&edit), &edit)
            .unwrap_err()
            .message
            .contains("folder changed")
    );
    assert_eq!(fs::read_to_string(path).unwrap(), "replacement");
    assert_eq!(fs::read_to_string(moved.join("file")).unwrap(), "ordinary");
    runtime.shutdown().await;
}
#[tokio::test]
async fn private_pi_file_policy_errors_and_invalid_payloads_never_create_destinations() {
    let (home, runtime, _) = setup();
    fs::write(
        home.path().join("profiles/owl/config.yaml"),
        "tools:\n  enabled_toolsets: [file]\n",
    )
    .unwrap();
    let s = runtime.open_session("alice", "owl", "first").await.unwrap();
    let path = home
        .workspace()
        .canonicalize()
        .unwrap()
        .join("missing/file");
    let original = args(&runtime, &s, &path, "write");
    start(&runtime, &s, "write");
    for key in [
        "approvalMode",
        "cwd",
        "outputDirs",
        "fileWorkdir",
        "fileEpoch",
    ] {
        let mut request = original.clone();
        request["snapshot"][key] = json!("changed");
        assert!(runtime.pi_file(&s, &event(&request), &request).is_err());
        assert!(!path.parent().unwrap().exists());
    }
    for content in ["!".into(), "A".repeat(pi_files::LIMIT)] {
        let mut request = original.clone();
        request["content"] = json!(content);
        assert!(runtime.pi_file(&s, &event(&request), &request).is_err());
        assert!(!path.parent().unwrap().exists());
    }
    let conn = store::open(home.path()).unwrap();
    let saved: String = conn
        .query_row(
            "SELECT options FROM native_sessions WHERE stored_id='first'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    conn.execute("UPDATE native_sessions SET options=json_set(options,'$.enabledToolsets',json('[]')) WHERE stored_id='first'",[]).unwrap();
    assert!(
        runtime
            .pi_file(&s, &event(&original), &original)
            .unwrap_err()
            .message
            .contains("disabled")
    );
    conn.execute(
        "UPDATE native_sessions SET options=? WHERE stored_id='first'",
        [saved],
    )
    .unwrap();
    s.state.lock().unwrap().tool_started.clear();
    assert!(
        runtime
            .pi_file(&s, &event(&original), &original)
            .unwrap_err()
            .message
            .contains("no longer running")
    );
    start(&runtime, &s, "write");
    s.replaced.store(true, Ordering::Release);
    assert!(runtime.pi_file(&s, &event(&original), &original).is_err());
    s.replaced.store(false, Ordering::Release);
    conn.execute("INSERT INTO native_deleted VALUES('first')", [])
        .unwrap();
    assert!(
        runtime
            .pi_file(&s, &event(&original), &original)
            .unwrap_err()
            .message
            .contains("deleted")
    );
    conn.execute("DELETE FROM native_deleted WHERE session_id='first'", [])
        .unwrap();
    assert!(!path.parent().unwrap().exists());
    runtime.shutdown().await;
}
#[tokio::test]
async fn private_pi_file_requests_after_stop_do_not_write_or_create_approval_cards() {
    let (home, runtime, hub) = setup();
    fs::write(
        home.path().join("profiles/owl/config.yaml"),
        "tools:\n  enabled_toolsets: [file]\n",
    )
    .unwrap();
    let s = runtime.open_session("alice", "owl", "first").await.unwrap();
    let path = home
        .workspace()
        .canonicalize()
        .unwrap()
        .join("missing/file");
    let request = args(&runtime, &s, &path, "write");
    start(&runtime, &s, "write");
    // A request queued before Stop may only run after Stop has claimed the gate.
    let guard = StopGuard::start(&s).unwrap();
    let response = reply(&runtime, &s, &hub, &request).await;
    assert_eq!(response["cancelled"], true);
    assert!(!path.parent().unwrap().exists());
    assert!(s.state.lock().unwrap().pending.is_empty());
    assert!(runtime.pi_file(&s, &event(&request), &request).is_err());
    drop(guard);
    // This single-threaded test queues the task, then claims Stop before its
    // first poll. Cancellation joins it before the actual Stop acknowledgement.
    runtime.event(&s, event(&request)).unwrap();
    assert!(runtime.interrupt_stored("alice", "first").await.unwrap());
    assert!(!path.parent().unwrap().exists());
    assert!(s.state.lock().unwrap().pending.is_empty());
    // A later run can reuse a provider's call id, but not its pre-Stop snapshot.
    s.state.lock().unwrap().interrupted = false;
    start(&runtime, &s, "write");
    assert!(
        runtime
            .pi_file(&s, &event(&request), &request)
            .unwrap_err()
            .message
            .contains("earlier run")
    );
    runtime.shutdown().await;
}

#[tokio::test]
async fn private_pi_edit_commit_rechecks_live_mode_and_workdir_without_creating_it() {
    let (home, runtime, _) = setup();
    fs::write(
        home.path().join("profiles/owl/config.yaml"),
        "tools:\n  enabled_toolsets: [file]\n",
    )
    .unwrap();
    let s = runtime.open_session("alice", "owl", "first").await.unwrap();
    let path = home.workspace().canonicalize().unwrap().join("file");
    fs::write(&path, "keep").unwrap();
    start(&runtime, &s, "edit");
    let mut request = args(&runtime, &s, &path, "edit_open");
    let opened = runtime.pi_file(&s, &event(&request), &request).unwrap();
    request["operation"] = json!("edit_commit");
    request["parent"] = opened["parent"].clone();
    db::open(home.path())
        .unwrap()
        .execute(
            "UPDATE bots SET approval_mode='manual' WHERE name='owl'",
            [],
        )
        .unwrap();
    assert!(
        runtime
            .pi_file(&s, &event(&request), &request)
            .unwrap_err()
            .message
            .contains("policy changed")
    );
    db::open(home.path())
        .unwrap()
        .execute("UPDATE bots SET approval_mode='smart' WHERE name='owl'", [])
        .unwrap();
    let missing = home.workspace().join("must-not-create");
    db::open(home.path())
        .unwrap()
        .execute(
            "UPDATE bots SET workdir=? WHERE name='owl'",
            [missing.to_str().unwrap()],
        )
        .unwrap();
    assert!(
        runtime
            .pi_file(&s, &event(&request), &request)
            .unwrap_err()
            .message
            .contains("policy changed")
    );
    assert!(!missing.exists());
    assert_eq!(fs::read_to_string(path).unwrap(), "keep");
    runtime.shutdown().await;
}
