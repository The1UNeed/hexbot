use hexbot_core::{catalog, common, db, runtime_store as store, server::App};
use rusqlite::params;
use serde_json::{Value, json};
use std::{fs, path::Path, time::Duration};
use tokio::io::AsyncWriteExt;

#[derive(Clone, Copy, PartialEq)]
enum AfterResponse {
    Retain,
    Purge,
    Healthy,
    Unchanged,
    FailedDelete,
    Closed,
    Missing,
    FailedUpdate,
}

fn frozen(home: &Path, id: &str) -> Vec<Value> {
    common::rows(
        &store::open(home).unwrap(),
        "SELECT prompt,options FROM native_sessions WHERE stored_id=?",
        &[&id],
    )
    .unwrap()
}

// The current-thread executor owns config.set. Once Pi's transport on the
// other executor has recorded the successful response, leave config.set
// unpolled until the public delete/close has completed. No scheduling sleeps.
fn model_response_race(action: AfterResponse) {
    let home = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let h = home.path();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let port = listener.local_addr().unwrap().port();
    let script = h.join("pi.cjs");
    fs::write(&script, format!(r#"#!/usr/bin/env node
const net=require('node:net'),rl=require('node:readline').createInterface({{input:process.stdin}});
const emit=x=>process.stdout.write(JSON.stringify(x)+'\n');
rl.on('line',line=>{{
  const c=JSON.parse(line);if(c.type==='extension_ui_response')return;
  const respond=()=>emit({{type:'response',id:c.id,command:c.type,success:true,data:c.type==='get_available_models'?{{models:[{{id:'original',provider:'openai'}},{{id:'picked',provider:'openai'}}]}}:{{}}}});
  if(c.type==='set_model'){{
    const s=net.connect({port},'127.0.0.1');
    s.on('data',()=>{{respond();emit({{type:'agent_start'}});s.end();}});
  }}else respond();
}});
"#)).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
    }
    let app = App::new(
        h.into(),
        "127.0.0.1:0".parse().unwrap(),
        script.clone(),
        None,
    )
    .unwrap();
    let made = catalog::call(
        h,
        "local",
        "hexbot.bots.create",
        &json!({"name":"owl","description":"Model response fixture"}),
    )
    .unwrap()
    .unwrap();
    let id = made["section"]["id"].as_str().unwrap();
    fs::write(
        h.join("profiles/owl/config.yaml"),
        "model:\n  provider: openai\n  default: original\ntools:\n  enabled_toolsets: []\n",
    )
    .unwrap();
    db::open(h)
        .unwrap()
        .execute(
            "INSERT OR REPLACE INTO settings VALUES('workspace_dir',?)",
            [json!(workspace.path()).to_string()],
        )
        .unwrap();
    let transport = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    let caller = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let opened = transport
        .block_on(app.call("local", "hexbot.sections.open", &json!({"id":id})))
        .unwrap();
    let live = opened["section"]["live_session_id"].as_str().unwrap();
    store::append(h, id, json!({"role":"user","text":"Retained transcript"})).unwrap();
    let history = store::history(h, id).unwrap();
    let dir = store::session_dir(h, id).unwrap();
    // A real Pi log remains byte-for-byte frozen on retained deletion.
    let log = format!(
        "{}\n{}\n",
        json!({"type":"session","version":3,"id":id,"cwd":workspace.path()}),
        json!({"type":"message","id":"message-1","parentId":null,"message":{"role":"user","content":[{"type":"text","text":"Retained transcript"}]}})
    );
    fs::write(dir.join("conversation.jsonl"), &log).unwrap();
    let config_file = fs::read(dir.join("config.json")).unwrap();
    let legacy = rusqlite::Connection::open(h.join("profiles/owl/state.db")).unwrap();
    legacy.execute_batch("CREATE TABLE sessions(id TEXT PRIMARY KEY); CREATE TABLE messages(id INTEGER,session_id TEXT,role TEXT,content TEXT)").unwrap();
    legacy
        .execute("INSERT INTO sessions VALUES(?)", [id])
        .unwrap();
    legacy
        .execute(
            "INSERT INTO messages VALUES(1,?,'user','Legacy transcript')",
            [id],
        )
        .unwrap();
    let memory_dir = h.join("profiles/owl/memories");
    fs::create_dir_all(memory_dir.join("notes")).unwrap();
    fs::write(memory_dir.join("MEMORY.md"), "Durable memory").unwrap();
    fs::write(memory_dir.join("notes/2026-10-15.md"), "Daily notes").unwrap();
    if action == AfterResponse::FailedDelete {
        // The catalog DELETE succeeds, but COMMIT fails. Runtime must restore
        // the provisional tombstone before the already completed model reply.
        let conn = db::open(h).unwrap();
        conn.execute_batch("CREATE TABLE commit_fault(section_id TEXT REFERENCES sections(id) DEFERRABLE INITIALLY DEFERRED)").unwrap();
        conn.execute("INSERT INTO commit_fault VALUES(?)", [id])
            .unwrap();
    }
    let target = if action == AfterResponse::Unchanged {
        "original"
    } else {
        "picked"
    };
    let args = json!({"session_id":live,"key":"model","value":target});
    let mut config = Box::pin(app.call("local", "config.set", &args));
    let (remote, _) = caller.block_on(async {
        let listener = tokio::net::TcpListener::from_std(listener).unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            tokio::select! {
                biased;
                accept = listener.accept() => accept.unwrap(),
                result = &mut config => panic!("config completed before set_model barrier: {result:?}"),
            }
        }).await.unwrap()
    });
    let remote = remote.into_std().unwrap();
    let mut events = app.events.subscribe();
    let before = transport.block_on(async {
        let mut remote = tokio::net::TcpStream::from_std(remote).unwrap();
        remote.write_all(b"release").await.unwrap();
        // The Pi transport records the response before dispatching agent_start.
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if events.recv().await.unwrap().frame["params"]["type"] == "message.start" {
                    break;
                }
            }
        }).await.unwrap();
        // Another writer's current fields must survive the per-field patch.
        store::open(h).unwrap().execute(
            "UPDATE native_sessions SET options=json_set(options,'$.concurrent',json(?)) WHERE stored_id=?",
            params![json!({"owner":"local","grants":["frozen"]}).to_string(), id],
        ).unwrap();
        let before = frozen(h, id);
        match action {
            AfterResponse::Retain | AfterResponse::Purge | AfterResponse::FailedDelete => {
                let result = app.call("local", "hexbot.sections.delete", &json!({"id":id,"purge_memory":action == AfterResponse::Purge})).await;
                if action == AfterResponse::FailedDelete {
                    assert!(result.is_err());
                } else {
                    assert_eq!(result.unwrap(), json!({"deleted":true}));
                }
            }
            AfterResponse::Closed => {
                assert_eq!(app.call("local", "session.close", &json!({"session_id":live})).await.unwrap(), json!({"closed":true}));
            }
            AfterResponse::Missing => {
                store::open(h).unwrap().execute("DELETE FROM native_sessions WHERE stored_id=?", [id]).unwrap();
            }
            AfterResponse::FailedUpdate => {
                store::open(h).unwrap().execute_batch("CREATE TRIGGER fail_model BEFORE UPDATE ON native_sessions BEGIN SELECT RAISE(ABORT,'model write fault'); END").unwrap();
            }
            AfterResponse::Healthy | AfterResponse::Unchanged => {}
        }
        before
    });
    assert_eq!(
        serde_json::from_str::<Value>(before[0]["options"].as_str().unwrap()).unwrap()["model"],
        "original"
    );
    let at_delete = frozen(h, id);
    if action == AfterResponse::Retain {
        assert_eq!(at_delete, before);
    }
    // Observe only notifications emitted after the completed delete/close.
    let mut late_events = app.events.subscribe();
    let result = caller.block_on(&mut config);
    drop(config);
    let rejected = matches!(
        action,
        AfterResponse::Retain
            | AfterResponse::Purge
            | AfterResponse::Missing
            | AfterResponse::FailedUpdate
    );
    if rejected {
        let error = result.expect_err("a late model reply must not report success");
        assert_eq!(
            error.code,
            if action == AfterResponse::FailedUpdate {
                5200
            } else {
                4001
            }
        );
        assert_eq!(
            frozen(h, id),
            at_delete,
            "late reply changed frozen prompt/options"
        );
        while let Ok(event) = late_events.try_recv() {
            assert!(
                !matches!(
                    event.frame["params"]["type"].as_str(),
                    Some("session.info" | "session.usage")
                ),
                "false model success: {:?}",
                event.frame
            );
        }
    } else {
        assert_eq!(result.unwrap(), json!({"confirm_required":false}));
        let mut options: Value =
            serde_json::from_str(before[0]["options"].as_str().unwrap()).unwrap();
        options["model"] = json!(target);
        let saved = frozen(h, id);
        assert_eq!(saved[0]["prompt"], before[0]["prompt"]);
        assert_eq!(
            serde_json::from_str::<Value>(saved[0]["options"].as_str().unwrap()).unwrap(),
            options
        );
        assert_eq!(
            late_events.try_recv().unwrap().frame["params"]["type"],
            "session.info"
        );
    }
    let after = frozen(h, id);
    let deleted = matches!(action, AfterResponse::Retain | AfterResponse::Purge);
    assert_eq!(catalog::section(h, "local", id).is_err(), deleted);
    assert_eq!(
        store::open(h)
            .unwrap()
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM native_deleted WHERE session_id=?)",
                [id],
                |r| r.get::<_, bool>(0)
            )
            .unwrap(),
        deleted
    );
    for file in ["MEMORY.md", "notes/2026-10-15.md"] {
        assert_eq!(
            fs::read_to_string(memory_dir.join(file)).unwrap(),
            if file == "MEMORY.md" {
                "Durable memory"
            } else {
                "Daily notes"
            }
        );
    }
    if action == AfterResponse::FailedUpdate {
        store::open(h)
            .unwrap()
            .execute_batch("DROP TRIGGER fail_model")
            .unwrap();
    }
    transport.block_on(app.shutdown());
    drop(app);
    drop(transport);
    let restarted = App::new(h.into(), "127.0.0.1:0".parse().unwrap(), script, None).unwrap();
    assert_eq!(
        frozen(h, id),
        after,
        "restart changed frozen prompt/options"
    );
    if deleted {
        assert_eq!(catalog::section(h, "local", id).unwrap_err().code, 4204);
        assert_eq!(
            caller
                .block_on(restarted.call("local", "hexbot.sections.open", &json!({"id":id})))
                .unwrap_err()
                .code,
            4204
        );
        if action == AfterResponse::Retain {
            assert_eq!(store::history(h, id).unwrap(), history);
            assert_eq!(
                fs::read_to_string(dir.join("conversation.jsonl")).unwrap(),
                log
            );
            assert_eq!(fs::read(dir.join("config.json")).unwrap(), config_file);
            assert_eq!(
                legacy
                    .query_row(
                        "SELECT content FROM messages WHERE session_id=?",
                        [id],
                        |r| r.get::<_, String>(0)
                    )
                    .unwrap(),
                "Legacy transcript"
            );
        } else {
            assert!(after.is_empty());
            assert!(store::history(h, id).unwrap().is_empty());
            assert!(!dir.exists());
            assert_eq!(
                legacy
                    .query_row(
                        "SELECT count(*) FROM messages WHERE session_id=?",
                        [id],
                        |r| r.get::<_, i64>(0)
                    )
                    .unwrap(),
                0
            );
        }
    }
    caller.block_on(restarted.shutdown());
}

#[test]
fn retained_delete_rejects_already_received_model_reply() {
    model_response_race(AfterResponse::Retain);
}
#[test]
fn purged_delete_rejects_already_received_model_reply() {
    model_response_race(AfterResponse::Purge);
}
#[test]
fn healthy_model_reply_patches_only_its_fields() {
    model_response_race(AfterResponse::Healthy);
}
#[test]
fn unchanged_model_selection_still_succeeds() {
    model_response_race(AfterResponse::Unchanged);
}
#[test]
fn failed_delete_allows_already_received_model_reply() {
    model_response_race(AfterResponse::FailedDelete);
}
#[test]
fn ordinary_close_allows_already_received_model_reply() {
    model_response_race(AfterResponse::Closed);
}
#[test]
fn missing_row_rejects_already_received_model_reply() {
    model_response_race(AfterResponse::Missing);
}
#[test]
fn failed_model_write_never_reports_success() {
    model_response_race(AfterResponse::FailedUpdate);
}
