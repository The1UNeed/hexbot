use hexbot_core::{db, server::App};
use serde_json::{Value, json};
use std::{fs, sync::Arc, time::Duration};

mod support;

async fn fixture() -> (support::TestHome, Arc<App>) {
    let home = support::TestHome::new();
    let pi = home.path().join("fake-pi.cjs");
    fs::write(&pi, r#"#!/usr/bin/env node
const emit=v=>process.stdout.write(JSON.stringify(v)+'\n');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
const c=JSON.parse(line);emit({type:'response',id:c.id,command:c.type,success:true,data:{}});
if(c.type==='prompt'){emit({type:'agent_start'});emit({type:'message_end',message:{role:'user',content:c.message}});emit({type:'message_end',message:{role:'assistant',content:[],stopReason:'error',errorMessage:'Fixture provider failed'}});emit({type:'agent_end'});emit({type:'agent_settled'});}
});
"#).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&pi, fs::Permissions::from_mode(0o700)).unwrap();
    }
    let app = App::new(home.path().into(), "127.0.0.1:0".parse().unwrap(), pi, None).unwrap();
    db::open(home.path())
        .unwrap()
        .execute(
            "INSERT OR REPLACE INTO settings(key,value) VALUES('workspace_dir',?)",
            [json!(home.workspace()).to_string()],
        )
        .unwrap();
    app.call(
        "local",
        "hexbot.bots.create",
        &json!({"name":"owl","provider":"openai","model":"fixture","tools":[]}),
    )
    .await
    .unwrap();
    (home, app)
}

// Public deletion is only for peer threads; owner chats stay until their bot goes.
fn peer_thread(home: &std::path::Path, id: &Value) {
    let conn = db::open(home).unwrap();
    conn.execute(
        "INSERT INTO bots(name,owner_id) VALUES('teammate','local')",
        [],
    )
    .unwrap();
    conn.execute(
        "UPDATE sections SET peer_bot='teammate' WHERE id=?",
        [id.as_str().unwrap()],
    )
    .unwrap();
}

async fn event(
    events: &mut tokio::sync::broadcast::Receiver<hexbot_core::events::Event>,
    kind: &str,
) -> Value {
    tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            let event = events.recv().await.unwrap().frame;
            if event["params"]["type"] == kind {
                return event["params"]["payload"].clone();
            }
        }
    })
    .await
    .unwrap_or_else(|_| panic!("missing {kind}"))
}

async fn assert_stopped(app: &Arc<App>, failure: &Value) {
    for method in ["hexbot.bots.get", "hexbot.bots.list"] {
        let response = app
            .call("local", method, &json!({"name":"owl"}))
            .await
            .unwrap();
        let bot = if method.ends_with("get") {
            &response["bot"]
        } else {
            &response["bots"][0]
        };
        assert_eq!(bot["status"], "stopped", "{method}: {bot}");
        assert_eq!(bot["status_detail"]["text"], "Fixture provider failed");
        assert_eq!(bot["status_detail"]["section_id"], failure["section_id"]);
        assert_eq!(bot["status_detail"]["session_id"], failure["session_id"]);
        assert_eq!(bot["status_detail"]["action"]["kind"], "retry");
        assert!(bot["status_detail"]["room_id"].is_null());
    }
}

#[tokio::test]
async fn hidden_job_failure_keeps_stopped_status_and_notification_after_restart() {
    let (home, app) = fixture().await;
    let mut events = app.events.subscribe();
    // Deliberately use an ID without a cron/dream/CLI prefix.
    let error = app
        .runtime
        .run_hidden_job(
            "local",
            "owl",
            "background-review",
            "Fail",
            &json!({"job":"review"}),
        )
        .await
        .unwrap_err();
    assert_eq!(error.message, "Fixture provider failed");
    let failure = event(&mut events, "hexbot.bots.incident").await;
    assert_eq!(failure["section_id"], "background-review");
    assert_stopped(&app, &failure).await;
    app.shutdown().await;
    let reopened = App::new(
        home.path().into(),
        "127.0.0.1:0".parse().unwrap(),
        home.path().join("fake-pi.cjs"),
        None,
    )
    .unwrap();
    assert_stopped(&reopened, &failure).await;
    reopened.shutdown().await;
}

#[tokio::test]
async fn cli_provider_failure_keeps_stopped_status_and_notification() {
    let (_home, app) = fixture().await;
    let mut events = app.events.subscribe();
    assert_eq!(
        app.call(
            "local",
            "hexbot.cli.send",
            &json!({"bot":"owl","text":"Fail"})
        )
        .await
        .unwrap_err()
        .message,
        "Fixture provider failed"
    );
    let failure = event(&mut events, "hexbot.bots.incident").await;
    assert_stopped(&app, &failure).await;
    app.shutdown().await;
}

#[tokio::test]
async fn dream_provider_failure_keeps_stopped_status_and_notification() {
    let (_home, app) = fixture().await;
    let mut events = app.events.subscribe();
    app.call("local", "hexbot.dreaming.run_now", &json!({"bot":"owl"}))
        .await
        .unwrap();
    let failure = event(&mut events, "hexbot.bots.incident").await;
    let finished = event(&mut events, "hexbot.dreaming.changed").await;
    assert_eq!(finished["dream"]["status"], "failed");
    assert_stopped(&app, &failure).await;
    app.shutdown().await;
}

#[tokio::test]
async fn archived_and_deleted_private_failures_do_not_become_hidden_run_failures() {
    let (home, app) = fixture().await;
    let stored = app
        .call("local", "hexbot.sections.list", &json!({"bot":"owl"}))
        .await
        .unwrap()["sections"][0]["id"]
        .clone();
    peer_thread(home.path(), &stored);
    let opened = app
        .call("local", "hexbot.sections.open", &json!({"id":stored}))
        .await
        .unwrap();
    let mut events = app.events.subscribe();
    app.call(
        "local",
        "prompt.submit",
        &json!({"session_id":opened["section"]["live_session_id"],"text":"Fail"}),
    )
    .await
    .unwrap();
    let failure = event(&mut events, "hexbot.bots.incident").await;
    event(&mut events, "message.complete").await;
    assert_stopped(&app, &failure).await;
    app.call("local", "hexbot.sections.archive", &json!({"id":stored}))
        .await
        .unwrap();
    assert_eq!(
        app.call("local", "hexbot.bots.get", &json!({"name":"owl"}))
            .await
            .unwrap()["bot"]["status"],
        "idle"
    );
    app.call("local", "hexbot.sections.unarchive", &json!({"id":stored}))
        .await
        .unwrap();
    assert_stopped(&app, &failure).await;
    app.call("local", "hexbot.sections.delete", &json!({"id":stored}))
        .await
        .unwrap();
    // An older daemon could leave the incident unresolved. The deleted native
    // conversation still must not be mistaken for a hidden run on reads.
    db::open(home.path())
        .unwrap()
        .execute(
            "UPDATE bot_incidents SET resolved_at=NULL WHERE id=?",
            [failure["incident"]["id"].as_str().unwrap()],
        )
        .unwrap();
    assert_eq!(
        app.call("local", "hexbot.bots.get", &json!({"name":"owl"}))
            .await
            .unwrap()["bot"]["status"],
        "idle"
    );
    app.shutdown().await;
}

#[tokio::test]
async fn archived_parent_keeps_child_failure_until_deletion_even_after_restart() {
    let (home, app) = fixture().await;
    let stored = app
        .call("local", "hexbot.sections.create", &json!({"bot":"owl"}))
        .await
        .unwrap()["section"]["id"]
        .clone();
    peer_thread(home.path(), &stored);
    app.call("local", "hexbot.sections.open", &json!({"id":stored}))
        .await
        .unwrap();
    let mut events = app.events.subscribe();
    app.runtime
        .run_hidden_job(
            "local",
            "owl",
            "child-review",
            "Fail",
            &json!({"parent_session":stored}),
        )
        .await
        .unwrap_err();
    let failure = event(&mut events, "hexbot.bots.incident").await;
    assert_stopped(&app, &failure).await;
    app.call("local", "hexbot.sections.archive", &json!({"id":stored}))
        .await
        .unwrap();
    assert_stopped(&app, &failure).await;
    app.shutdown().await;
    let reopened = App::new(
        home.path().into(),
        "127.0.0.1:0".parse().unwrap(),
        home.path().join("fake-pi.cjs"),
        None,
    )
    .unwrap();
    assert_stopped(&reopened, &failure).await;
    reopened
        .call("local", "hexbot.sections.delete", &json!({"id":stored}))
        .await
        .unwrap();
    assert_eq!(
        reopened
            .call("local", "hexbot.bots.get", &json!({"name":"owl"}))
            .await
            .unwrap()["bot"]["status"],
        "idle"
    );
    let native = hexbot_core::runtime_store::open(home.path()).unwrap();
    assert!(
        !native
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM native_sessions WHERE stored_id='child-review')",
                [],
                |r| r.get::<_, bool>(0)
            )
            .unwrap()
    );
    assert!(hexbot_core::runtime_store::session_dir(home.path(), "child-review").is_err());
    reopened.shutdown().await;
    let restarted = App::new(
        home.path().into(),
        "127.0.0.1:0".parse().unwrap(),
        home.path().join("fake-pi.cjs"),
        None,
    )
    .unwrap();
    assert_eq!(
        restarted
            .call("local", "hexbot.bots.get", &json!({"name":"owl"}))
            .await
            .unwrap()["bot"]["status"],
        "idle"
    );
    restarted.shutdown().await;
}

#[tokio::test]
async fn bot_incident_cleanup_shares_the_catalog_commit_and_preserves_other_bots() {
    use hexbot_core::{common::rows, runtime_store, settings};

    for fault in ["incident", "purge"] {
        let (home, app) = fixture().await;
        let h = home.path();
        app.call(
            "local",
            "hexbot.bots.create",
            &json!({"name":"fox","tools":[]}),
        )
        .await
        .unwrap();
        let stored = app
            .call("local", "hexbot.sections.create", &json!({"bot":"owl"}))
            .await
            .unwrap()["section"]["id"]
            .clone();
        let conn = db::open(h).unwrap();
        conn.execute_batch("INSERT INTO rooms(id,name,owner_id) VALUES('room','Room','local');
            INSERT INTO room_sessions(room_id,bot,stored_session_id) VALUES('room','owl','room-history');
            INSERT INTO users(id,display_name,role,created_at) VALUES('bob','Bob','member',0);
            INSERT INTO bots(name,owner_id) VALUES('remote','bob');").unwrap();
        let mut events = app.events.subscribe();
        app.runtime
            .run_hidden_job("local", "owl", "hidden-review", "Fail", &json!({}))
            .await
            .unwrap_err();
        event(&mut events, "hexbot.bots.incident").await;
        for (bot, kind, context) in [
            ("owl", "turn_failed", json!({"section_id":stored})),
            ("owl", "turn_failed", json!({"section_id":"room-history"})),
            ("owl", "connector_error", json!({"connector":"github"})),
            (
                "fox",
                "turn_failed",
                json!({"section_id":"room-history","room_id":"room"}),
            ),
            ("remote", "turn_failed", json!({"section_id":stored})),
        ] {
            settings::record_incident(h, bot, kind, "Saved failure", &context).unwrap();
        }
        let incidents = || rows(&conn, "SELECT * FROM bot_incidents ORDER BY id", &[]).unwrap();
        let before = incidents();
        assert_eq!(before.len(), 6);
        assert!(before.iter().all(|i| i["resolved_at"].is_null()));
        runtime_store::append(
            h,
            "room-history",
            json!({"role":"user","text":"Room history"}),
        )
        .unwrap();
        fs::create_dir_all(h.join("profiles/owl/memories")).unwrap();
        fs::write(h.join("profiles/owl/memories/MEMORY.md"), "Saved memory").unwrap();
        let native = runtime_store::open(h).unwrap();
        if fault == "incident" {
            conn.execute_batch(
                "CREATE TRIGGER stop_incident_delete BEFORE DELETE ON bot_incidents
                WHEN OLD.bot='owl' BEGIN SELECT RAISE(ABORT,'incident cleanup failed'); END;",
            )
            .unwrap();
        } else {
            native.execute_batch("CREATE TRIGGER stop_history_delete BEFORE DELETE ON native_messages
                WHEN OLD.session_id='hidden-review' BEGIN SELECT RAISE(ABORT,'history cleanup failed'); END;").unwrap();
        }
        let result = app
            .call("local", "hexbot.bots.delete", &json!({"name":"owl"}))
            .await;
        let expected = if fault == "incident" {
            assert!(
                result
                    .unwrap_err()
                    .message
                    .contains("incident cleanup failed")
            );
            assert_eq!(incidents(), before);
            assert!(hexbot_core::catalog::section(h, "local", stored.as_str().unwrap()).is_ok());
            assert_eq!(
                rows(&conn, "SELECT * FROM room_sessions WHERE bot='owl'", &[])
                    .unwrap()
                    .len(),
                1
            );
            assert_eq!(
                runtime_store::history(h, "room-history").unwrap()[0]["text"],
                "Room history"
            );
            assert_eq!(
                fs::read_to_string(h.join("profiles/owl/memories/MEMORY.md")).unwrap(),
                "Saved memory"
            );
            assert!(!native.query_row("SELECT EXISTS(SELECT 1 FROM native_deleted WHERE session_id='hidden-review')", [], |r| r.get::<_, bool>(0)).unwrap());
            before.clone()
        } else {
            assert_eq!(
                result.unwrap(),
                json!({"deleted":true,"history_pending":true})
            );
            assert!(hexbot_core::catalog::bot(h, "local", "owl").is_err());
            assert!(
                rows(&conn, "SELECT * FROM sections WHERE bot='owl'", &[])
                    .unwrap()
                    .is_empty()
            );
            assert!(
                rows(&conn, "SELECT * FROM room_sessions WHERE bot='owl'", &[])
                    .unwrap()
                    .is_empty()
            );
            assert!(native.query_row("SELECT EXISTS(SELECT 1 FROM native_deleted WHERE session_id='hidden-review')", [], |r| r.get::<_, bool>(0)).unwrap());
            before
                .iter()
                .filter(|i| i["bot"] != "owl")
                .cloned()
                .collect()
        };
        assert_eq!(incidents(), expected);
        assert_eq!(
            runtime_store::history(h, "hidden-review").unwrap()[0]["text"],
            "Fail"
        );
        app.shutdown().await;
        conn.execute_batch("DROP TRIGGER IF EXISTS stop_incident_delete;")
            .unwrap();
        native
            .execute_batch("DROP TRIGGER IF EXISTS stop_history_delete;")
            .unwrap();
        let restarted = App::new(
            h.into(),
            "127.0.0.1:0".parse().unwrap(),
            h.join("fake-pi.cjs"),
            None,
        )
        .unwrap();
        assert_eq!(incidents(), expected);
        assert_eq!(
            runtime_store::history(h, "hidden-review")
                .unwrap()
                .is_empty(),
            fault == "purge"
        );
        assert!(
            rows(
                &conn,
                "SELECT * FROM settings WHERE key LIKE 'pending_bot_delete:%'",
                &[]
            )
            .unwrap()
            .is_empty()
        );
        restarted.shutdown().await;
    }
}
