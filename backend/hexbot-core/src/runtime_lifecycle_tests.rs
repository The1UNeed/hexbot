use super::*;

fn setup() -> (tempfile::TempDir, Arc<Runtime>, EventHub) {
    let home = tempfile::tempdir().unwrap();
    db::migrate(home.path()).unwrap();
    db::open(home.path()).unwrap().execute_batch("INSERT INTO users(id,display_name,role,created_at) VALUES('alice','Alice','admin',0),('bob','Bob','member',0);INSERT INTO bots(name,owner_id) VALUES('owl','alice');INSERT INTO sections(id,bot,owner_id,title) VALUES('first','owl','alice','First');").unwrap();
    let profile = home.path().join("profiles/owl");
    fs::create_dir_all(&profile).unwrap();
    fs::write(
        profile.join("config.yaml"),
        "model:\n  provider: openai\n  default: fixture\ntools:\n  enabled_toolsets: []\n",
    )
    .unwrap();
    db::open(home.path())
        .unwrap()
        .execute(
            "INSERT OR REPLACE INTO settings(key,value) VALUES('workspace_dir',?)",
            [json!(home.path().join("workspace")).to_string()],
        )
        .unwrap();
    let script = home.path().join("pi.cjs");
    let logfile = json!(home.path().join("processes.jsonl")).to_string();
    fs::write(&script, format!(r#"#!/usr/bin/env node
const fs=require('node:fs'),rl=require('node:readline').createInterface({{input:process.stdin}});
const emit=v=>process.stdout.write(JSON.stringify(v)+'\n');
fs.appendFileSync({logfile},JSON.stringify({{pid:process.pid,args:process.argv.slice(2),config:JSON.parse(fs.readFileSync(process.env.HEXBOT_SESSION_CONFIG))}})+'\n');
rl.on('line',line=>{{const c=JSON.parse(line);emit({{type:'response',id:c.id,command:c.type,success:true,data:{{}}}});if(c.type==='prompt'){{emit({{type:'agent_start'}});if(c.message!=='wait')emit({{type:'agent_settled'}});}}if(c.type==='abort')emit({{type:'agent_settled'}});}});
"#)).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
    }
    let hub = EventHub::new();
    let runtime = Runtime::new(home.path().into(), hub.clone(), script).unwrap();
    (home, runtime, hub)
}
async fn open(runtime: &Runtime) -> String {
    runtime
        .call("alice", "hexbot.sections.open", &json!({"id":"first"}))
        .await
        .unwrap()
        .unwrap()["section"]["live_session_id"]
        .as_str()
        .unwrap()
        .to_owned()
}
fn processes(home: &Path) -> Vec<Value> {
    fs::read_to_string(home.join("processes.jsonl"))
        .unwrap()
        .lines()
        .map(|s| serde_json::from_str(s).unwrap())
        .collect()
}
fn age(runtime: &Runtime) {
    for s in runtime.sessions.lock().unwrap().values() {
        s.state.lock().unwrap().last_activity = 0.;
    }
}
#[cfg(unix)]
fn assert_exited(process: &Value) {
    let pid = process["pid"].as_i64().unwrap() as libc::pid_t;
    // shutdown waits for the owned child to be reaped, so no timing sleeps are needed.
    assert_eq!(
        unsafe { libc::kill(pid, 0) },
        -1,
        "child {pid} survived shutdown"
    );
    assert_eq!(
        std::io::Error::last_os_error().raw_os_error(),
        Some(libc::ESRCH)
    );
}
#[tokio::test]
async fn idle_restart_preserves_live_id_prompt_tools_and_client_watermarks() {
    let (home, runtime, hub) = setup();
    let id = open(&runtime).await;
    let before = processes(home.path());
    let old_seq = hub.since("alice", &id, 0)["latest_seq"].as_u64().unwrap();
    age(&runtime);
    assert_eq!(runtime.retire_idle(common::now() - 900.).await.unwrap(), 1);
    assert!(runtime.sessions.lock().unwrap().is_empty());
    #[cfg(unix)]
    assert_exited(&before[0]);
    assert_eq!(
        db::open(home.path())
            .unwrap()
            .query_row(
                "SELECT last_live_session_id FROM sections WHERE id='first'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
        id
    );
    fs::write(
        home.path().join("profiles/owl/SOUL.md"),
        "Changed after the session began",
    )
    .unwrap();
    fs::write(
        home.path().join("profiles/owl/config.yaml"),
        "model: changed\ntools:\n  enabled_toolsets: [terminal]\n",
    )
    .unwrap();
    // The unchanged app stages attachments before submitting, and has no retry
    // for this RPC. It must work directly with the original ID after retirement.
    let response=runtime.call("alice","file.attach",&json!({"session_id":id,"name":"note.txt","data_url":"data:text/plain;base64,aGVsbG8="})).await.unwrap().unwrap();
    assert!(response.is_object());
    let after = processes(home.path());
    assert_eq!(after.len(), 2);
    assert_eq!(after[0]["config"], after[1]["config"]);
    assert_eq!(after[0]["args"], after[1]["args"]);
    assert_eq!(open(&runtime).await, id);
    assert_eq!(processes(home.path()).len(), 2);
    assert!(
        hub.since("alice", &id, old_seq)["latest_seq"]
            .as_u64()
            .unwrap()
            > old_seq
    );
    assert_eq!(
        runtime.sessions.lock().unwrap()["first"]
            .state
            .lock()
            .unwrap()
            .refs
            .len(),
        1
    );
    runtime.shutdown().await;
    #[cfg(unix)]
    assert_exited(&after[1]);
}
#[tokio::test]
async fn retire_skips_staged_attachments_busy_turns_and_pending_dialogs() {
    let (_home, runtime, _) = setup();
    let id = open(&runtime).await;
    let s = runtime.sessions.lock().unwrap()["first"].clone();
    for kind in ["busy", "pending", "image", "file"] {
        {
            let mut state = s.state.lock().unwrap();
            state.last_activity = 0.;
            state.busy = kind == "busy";
            if kind == "pending" {
                state.pending.insert("question".into(), json!({}));
            }
            if kind == "image" {
                state.attachments.push(json!({"type":"image"}));
            }
            if kind == "file" {
                state.refs.push("note.txt".into());
            }
        }
        assert_eq!(
            runtime.retire_idle(common::now() - 900.).await.unwrap(),
            0,
            "{kind}"
        );
        let mut state = s.state.lock().unwrap();
        state.busy = false;
        state.pending.clear();
        state.attachments.clear();
        state.refs.clear();
    }
    age(&runtime);
    runtime
        .call("alice", "session.usage", &json!({"session_id":id}))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(runtime.retire_idle(common::now() - 900.).await.unwrap(), 0);
    age(&runtime);
    assert_eq!(runtime.retire_idle(common::now() - 900.).await.unwrap(), 1);
    runtime.shutdown().await;
}
#[tokio::test]
async fn concurrent_lazy_reopen_starts_one_child_and_explicit_close_invalidates_id() {
    let (home, runtime, _) = setup();
    let id = open(&runtime).await;
    age(&runtime);
    runtime.retire_idle(common::now() - 900.).await.unwrap();
    let p = json!({"session_id":id});
    let (a, b) = tokio::join!(
        runtime.call("alice", "session.usage", &p),
        runtime.call("alice", "session.status", &p)
    );
    a.unwrap().unwrap();
    b.unwrap().unwrap();
    assert_eq!(processes(home.path()).len(), 2);
    let error = runtime
        .call("bob", "session.usage", &p)
        .await
        .unwrap()
        .unwrap_err();
    assert_eq!(error.code, 4001);
    for _ in 0..3 {
        let current = open(&runtime).await;
        assert!(runtime.close_stored("alice", "first").await.unwrap());
        let error = runtime
            .call("alice", "session.usage", &json!({"session_id":current}))
            .await
            .unwrap()
            .unwrap_err();
        assert_eq!(error.code, 4001);
        assert!(runtime.sessions.lock().unwrap().is_empty());
    }
    let current = open(&runtime).await;
    assert_ne!(current, id);
    age(&runtime);
    runtime.retire_idle(common::now() - 900.).await.unwrap();
    assert!(runtime.close_stored("alice", "first").await.unwrap());
    assert_eq!(
        runtime
            .call("alice", "session.usage", &json!({"session_id":current}))
            .await
            .unwrap()
            .unwrap_err()
            .code,
        4001
    );
    assert_eq!(
        store::open(home.path())
            .unwrap()
            .query_row("SELECT COUNT(*) FROM native_live_sessions", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    for process in processes(home.path()) {
        #[cfg(unix)]
        assert_exited(&process);
    }
    runtime.shutdown().await;
}
#[tokio::test]
async fn idle_alias_cannot_bypass_revoked_bot_access_or_restart_epoch() {
    let (home, runtime, hub) = setup();
    let id = open(&runtime).await;
    age(&runtime);
    runtime.retire_idle(common::now() - 900.).await.unwrap();
    db::open(home.path())
        .unwrap()
        .execute("UPDATE bots SET owner_id='bob' WHERE name='owl'", [])
        .unwrap();
    assert_eq!(
        runtime
            .call("alice", "session.usage", &json!({"session_id":id}))
            .await
            .unwrap()
            .unwrap_err()
            .code,
        4302
    );
    assert_eq!(processes(home.path()).len(), 1);
    runtime.shutdown().await;
    let restarted = Runtime::new(home.path().into(), hub, home.path().join("pi.cjs")).unwrap();
    assert_eq!(
        restarted
            .call("alice", "session.usage", &json!({"session_id":id}))
            .await
            .unwrap()
            .unwrap_err()
            .code,
        4001
    );
    assert_eq!(
        store::open(home.path())
            .unwrap()
            .query_row("SELECT COUNT(*) FROM native_live_sessions", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    restarted.shutdown().await;
}
#[tokio::test]
async fn intentional_close_of_busy_turn_does_not_report_failure_incident() {
    let (home, runtime, hub) = setup();
    let id = open(&runtime).await;
    runtime
        .call(
            "alice",
            "prompt.submit",
            &json!({"session_id":id,"text":"wait"}),
        )
        .await
        .unwrap()
        .unwrap();
    let mut events = hub.subscribe();
    assert!(runtime.close_stored("alice", "first").await.unwrap());
    for process in processes(home.path()) {
        #[cfg(unix)]
        assert_exited(&process);
    }
    while let Ok(event) = events.try_recv() {
        assert_ne!(event.frame["params"]["type"], "hexbot.bots.incident");
        assert_ne!(event.frame["params"]["type"], "error");
    }
    runtime.shutdown().await;
}
