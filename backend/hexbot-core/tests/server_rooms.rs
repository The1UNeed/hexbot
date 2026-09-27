//! Native RPC regression tests for the unchanged room and section client contracts.
use hexbot_core::{db, server::App};
use serde_json::{Value, json};
use std::{fs, sync::Arc, time::Duration};
fn setup() -> (tempfile::TempDir, Arc<App>) {
    let h = tempfile::tempdir().unwrap();
    db::migrate(h.path()).unwrap();
    db::open(h.path()).unwrap().execute_batch("INSERT INTO users(id,display_name,role,created_at) VALUES ('alice','Alice','admin',0),('bob','Bob','member',0); INSERT INTO bots(name,owner_id,shareable) VALUES ('owl','alice',1),('fox','alice',0); INSERT INTO sections(id,bot,owner_id,title,created_at,updated_at) VALUES ('section','owl','alice','Conversation',0,0);").unwrap();
    for bot in ["owl", "fox"] {
        fs::create_dir_all(h.path().join("profiles").join(bot)).unwrap();
        fs::write(
            h.path().join("profiles").join(bot).join("config.yaml"),
            "model:\n  provider: openai\n  default: test-model\ntools:\n  enabled_toolsets: []\n",
        )
        .unwrap();
    }
    db::open(h.path())
        .unwrap()
        .execute(
            "INSERT INTO settings(key,value) VALUES('workspace_dir',?)",
            [json!(h.path().join("workspace")).to_string()],
        )
        .unwrap();
    let pi = h.path().join("fake-pi.cjs");
    fs::write(&pi,r#"#!/usr/bin/env node
const rl=require('node:readline').createInterface({input:process.stdin});const emit=x=>process.stdout.write(JSON.stringify(x)+'\n');
rl.on('line',l=>{const c=JSON.parse(l);emit({type:'response',id:c.id,command:c.type,success:true,data:{}});if(c.type==='prompt'){emit({type:'agent_start'});emit({type:'message_end',message:{role:'user',content:c.message}});emit({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'Working.'}});}if(c.type==='abort')emit({type:'agent_settled'});});
"#).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&pi, fs::Permissions::from_mode(0o755)).unwrap();
    }
    let app = App::new(h.path().into(), "127.0.0.1:0".parse().unwrap(), pi, None).unwrap();
    (h, app)
}
async fn room(app: &Arc<App>, owner: &str, members: Value) -> String {
    app.call(
        owner,
        "hexbot.rooms.create",
        &json!({"name":"Lab","members":members,"main_bot":"owl"}),
    )
    .await
    .unwrap()["room"]["id"]
        .as_str()
        .unwrap()
        .into()
}
#[tokio::test]
async fn membership_changes_deliver_exact_events_and_last_member_deletion() {
    let (_h, app) = setup();
    let room = room(&app, "alice", json!(["owl"])).await;
    let mut events = app.events.subscribe();
    let result = app
        .call(
            "alice",
            "hexbot.rooms.add_member",
            &json!({"id":room,"bot":"fox"}),
        )
        .await
        .unwrap();
    assert!(result.get("event").is_none());
    let added = events.recv().await.unwrap();
    assert_eq!(added.owner, "alice");
    assert_eq!(added.frame["params"]["type"], "hexbot.rooms.event");
    assert_eq!(
        added.frame["params"]["payload"]["event"]["kind"],
        "member.added"
    );
    assert_eq!(
        added.frame["params"]["payload"]["event"]["payload"]["bot"],
        "fox"
    );
    app.call(
        "alice",
        "hexbot.rooms.remove_member",
        &json!({"id":room,"bot":"owl"}),
    )
    .await
    .unwrap();
    app.call(
        "alice",
        "hexbot.rooms.remove_member",
        &json!({"id":room,"bot":"fox"}),
    )
    .await
    .unwrap();
    let deleted = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let event = events.recv().await.unwrap();
            if event.frame["params"]["type"] == "hexbot.rooms.changed"
                && event.frame["params"]["payload"]["deleted"] == true
            {
                break event;
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(deleted.frame["params"]["payload"]["id"], room);
    app.shutdown().await;
}
#[tokio::test]
async fn deleting_shared_bot_closes_room_session_using_room_owner() {
    let (h, app) = setup();
    let room = room(&app, "bob", json!(["owl"])).await;
    db::open(h.path())
        .unwrap()
        .execute(
            "INSERT INTO room_sessions VALUES (?,'owl','hidden',NULL)",
            [&room],
        )
        .unwrap();
    let live = app
        .runtime
        .ensure_hidden("bob", "owl", "hidden")
        .await
        .unwrap();
    let mut events = app.events.subscribe();
    app.call("alice", "hexbot.bots.delete", &json!({"name":"owl"}))
        .await
        .unwrap();
    assert!(
        app.runtime
            .call("bob", "session.history", &json!({"session_id":live}))
            .await
            .unwrap()
            .is_err()
    );
    assert!(!h.path().join("runtime/sessions/hidden").exists());
    let changed = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let event = events.recv().await.unwrap();
            if event.owner == "bob" && event.frame["params"]["type"] == "hexbot.rooms.changed" {
                break event;
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(changed.frame["params"]["payload"]["id"], room);
    app.shutdown().await;
}
#[tokio::test]
async fn busy_bot_deletion_refuses_without_interrupting_or_deleting() {
    let (h, app) = setup();
    let opened = app
        .call("alice", "hexbot.sections.open", &json!({"id":"section"}))
        .await
        .unwrap();
    let live = opened["section"]["live_session_id"].as_str().unwrap();
    app.call(
        "alice",
        "prompt.submit",
        &json!({"session_id":live,"text":"wait"}),
    )
    .await
    .unwrap();
    let error = app
        .call("alice", "hexbot.bots.delete", &json!({"name":"owl"}))
        .await
        .unwrap_err();
    assert_eq!(error.code, 4211);
    assert_eq!(error.data.as_ref().unwrap()["sections"][0]["id"], "section");
    assert_eq!(
        error.data.as_ref().unwrap()["sections"][0]["status"],
        "working"
    );
    assert!(h.path().join("profiles/owl").exists());
    assert_eq!(
        app.call("alice", "session.status", &json!({"session_id":live}))
            .await
            .unwrap()["status"],
        "working"
    );
    app.shutdown().await;
}
#[tokio::test]
async fn archive_retains_live_section_and_unarchive_reuses_it() {
    let (_h, app) = setup();
    let opened = app
        .call("alice", "hexbot.sections.open", &json!({"id":"section"}))
        .await
        .unwrap();
    let live = opened["section"]["live_session_id"].as_str().unwrap();
    app.call("alice", "hexbot.sections.archive", &json!({"id":"section"}))
        .await
        .unwrap();
    assert!(
        app.call("alice", "session.history", &json!({"session_id":live}))
            .await
            .is_ok()
    );
    app.call(
        "alice",
        "hexbot.sections.unarchive",
        &json!({"id":"section"}),
    )
    .await
    .unwrap();
    assert_eq!(
        app.call("alice", "hexbot.sections.open", &json!({"id":"section"}))
            .await
            .unwrap()["section"]["live_session_id"],
        live
    );
    app.shutdown().await;
}

async fn running_room(app: &Arc<App>, room: &str) -> String {
    let mut events = app.events.subscribe();
    app.call(
        "bob",
        "hexbot.rooms.send",
        &json!({"id":room,"text":"Keep working until stopped"}),
    )
    .await
    .unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let event = events.recv().await.unwrap();
            if event.owner == "bob" && event.frame["params"]["type"] == "message.delta" {
                break event.frame["params"]["session_id"]
                    .as_str()
                    .unwrap()
                    .to_string();
            }
        }
    })
    .await
    .unwrap()
}
fn stored_room_session(home: &std::path::Path, room: &str) -> String {
    db::open(home)
        .unwrap()
        .query_row(
            "SELECT stored_session_id FROM room_sessions WHERE room_id=? AND bot='owl'",
            [room],
            |r| r.get(0),
        )
        .unwrap()
}
fn frozen_session(home: &std::path::Path, stored: &str) -> (String, String) {
    hexbot_core::runtime_store::open(home)
        .unwrap()
        .query_row(
            "SELECT prompt,options FROM native_sessions WHERE stored_id=?",
            [stored],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap()
}
#[tokio::test]
async fn removing_running_shared_member_closes_process_but_preserves_private_session_history() {
    let (h, app) = setup();
    let room = room(&app, "bob", json!(["owl"])).await;
    let live = running_room(&app, &room).await;
    let stored = stored_room_session(h.path(), &room);
    let frozen = frozen_session(h.path(), &stored);
    let history = hexbot_core::runtime_store::history(h.path(), &stored).unwrap();
    assert!(!history.is_empty());
    // Owning the bot does not permit its owner to remove it from someone else's room.
    assert_eq!(
        app.call(
            "alice",
            "hexbot.rooms.remove_member",
            &json!({"id":room,"bot":"owl"})
        )
        .await
        .unwrap_err()
        .code,
        4302
    );
    assert_eq!(
        app.call("bob", "session.status", &json!({"session_id":live}))
            .await
            .unwrap()["status"],
        "working"
    );
    let removed = app
        .call(
            "bob",
            "hexbot.rooms.remove_member",
            &json!({"id":room,"bot":"owl"}),
        )
        .await
        .unwrap();
    assert_eq!(removed["room"]["deleted"], true);
    assert!(
        app.runtime
            .call("bob", "session.history", &json!({"session_id":live}))
            .await
            .unwrap()
            .is_err()
    );
    assert_eq!(
        hexbot_core::runtime_store::history(h.path(), &stored).unwrap(),
        history
    );
    assert_eq!(frozen_session(h.path(), &stored), frozen);
    app.shutdown().await;
}
#[tokio::test]
async fn unsharing_stops_foreign_room_execution_preserves_membership_and_can_be_reversed() {
    let (h, app) = setup();
    let foreign = room(&app, "bob", json!(["owl"])).await;
    let own = room(&app, "alice", json!(["owl"])).await;
    db::open(h.path())
        .unwrap()
        .execute(
            "INSERT INTO room_sessions VALUES (?,'owl','owners-room-session',NULL)",
            [&own],
        )
        .unwrap();
    let owner_live = app
        .runtime
        .ensure_hidden("alice", "owl", "owners-room-session")
        .await
        .unwrap();
    let foreign_live = running_room(&app, &foreign).await;
    let stored = stored_room_session(h.path(), &foreign);
    let frozen = frozen_session(h.path(), &stored);
    let history = hexbot_core::runtime_store::history(h.path(), &stored).unwrap();
    app.call(
        "alice",
        "hexbot.bots.update",
        &json!({"name":"owl","shareable":false}),
    )
    .await
    .unwrap();
    assert!(
        app.runtime
            .call(
                "bob",
                "session.history",
                &json!({"session_id":foreign_live})
            )
            .await
            .unwrap()
            .is_err()
    );
    assert!(
        app.runtime
            .call(
                "alice",
                "session.history",
                &json!({"session_id":owner_live})
            )
            .await
            .unwrap()
            .is_ok()
    );
    assert!(
        app.runtime
            .ensure_hidden("bob", "owl", &stored)
            .await
            .is_err()
    );
    assert_eq!(
        hexbot_core::runtime_store::history(h.path(), &stored).unwrap(),
        history
    );
    assert_eq!(frozen_session(h.path(), &stored), frozen);
    let c = db::open(h.path()).unwrap();
    assert!(
        c.query_row(
            "SELECT left_at FROM room_members WHERE room_id=? AND member_id='owl'",
            [&foreign],
            |r| r.get::<_, Option<f64>>(0)
        )
        .unwrap()
        .is_none()
    );
    assert!(
        c.query_row(
            "SELECT live_session_id FROM room_sessions WHERE room_id=? AND bot='owl'",
            [&foreign],
            |r| r.get::<_, Option<String>>(0)
        )
        .unwrap()
        .is_none()
    );
    assert_eq!(
        c.query_row(
            "SELECT COUNT(*) FROM room_turns WHERE room_id=? AND status='running'",
            [&foreign],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    app.call(
        "alice",
        "hexbot.bots.update",
        &json!({"name":"owl","shareable":true}),
    )
    .await
    .unwrap();
    let reopened = app
        .runtime
        .ensure_hidden("bob", "owl", &stored)
        .await
        .unwrap();
    assert_ne!(reopened, foreign_live);
    assert_eq!(frozen_session(h.path(), &stored), frozen);
    assert_eq!(
        hexbot_core::runtime_store::history(h.path(), &stored).unwrap(),
        history
    );
    app.shutdown().await;
}
