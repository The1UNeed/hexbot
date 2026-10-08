//! Native RPC regression tests for the unchanged room and section client contracts.
use hexbot_core::{db, server::App};
use serde_json::{Value, json};
use std::{fs, sync::Arc, time::Duration};
mod support;
const FAKE_PI: &str = r#"#!/usr/bin/env node
const rl=require('node:readline').createInterface({input:process.stdin});const emit=x=>process.stdout.write(JSON.stringify(x)+'\n');
rl.on('line',l=>{const c=JSON.parse(l);emit({type:'response',id:c.id,command:c.type,success:true,data:{}});if(c.type==='prompt'){emit({type:'agent_start'});emit({type:'message_end',message:{role:'user',content:c.message}});emit({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'Working.'}});}if(c.type==='abort')emit({type:'agent_settled'});});
"#;
fn setup() -> (support::TestHome, Arc<App>) {
    setup_with(FAKE_PI)
}
fn setup_with(script: &str) -> (support::TestHome, Arc<App>) {
    let h = support::TestHome::new();
    db::migrate(h.path()).unwrap();
    db::open(h.path()).unwrap().execute_batch("INSERT INTO users(id,display_name,role,created_at) VALUES ('alice','Alice','admin',0); INSERT INTO bots(name,owner_id) VALUES ('owl','alice'),('fox','alice'); INSERT INTO sections(id,bot,owner_id,title,created_at,updated_at) VALUES ('section','owl','alice','Conversation',0,0);").unwrap();
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
            [json!(h.workspace()).to_string()],
        )
        .unwrap();
    let pi = h.path().join("fake-pi.cjs");
    fs::write(&pi, script).unwrap();
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
    let (h, app) = setup();
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
    let removed = app
        .call(
            "alice",
            "hexbot.rooms.remove_member",
            &json!({"id":room,"bot":"owl"}),
        )
        .await
        .unwrap();
    assert!(removed["room"]["main_bot"].is_null());
    let last = app
        .call(
            "alice",
            "hexbot.rooms.remove_member",
            &json!({"id":room,"bot":"fox"}),
        )
        .await
        .unwrap();
    assert_eq!(last["room"]["deleted"], true);
    assert_eq!(
        db::open(h.path())
            .unwrap()
            .query_row("SELECT COUNT(*) FROM room_events", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
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
async fn deleting_a_bot_closes_its_room_session() {
    let (h, app) = setup();
    let room = room(&app, "alice", json!(["owl"])).await;
    db::open(h.path())
        .unwrap()
        .execute(
            "INSERT INTO room_sessions VALUES (?,'owl','hidden',NULL)",
            [&room],
        )
        .unwrap();
    let live = app
        .runtime
        .ensure_hidden("alice", "owl", "hidden")
        .await
        .unwrap();
    let mut events = app.events.subscribe();
    app.call("alice", "hexbot.bots.delete", &json!({"name":"owl"}))
        .await
        .unwrap();
    assert!(
        app.runtime
            .call("alice", "session.history", &json!({"session_id":live}))
            .await
            .unwrap()
            .is_err()
    );
    assert!(!h.path().join("runtime/sessions/hidden").exists());
    let changed = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let event = events.recv().await.unwrap();
            if event.owner == "alice" && event.frame["params"]["type"] == "hexbot.rooms.changed" {
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
        "alice",
        "hexbot.rooms.send",
        &json!({"id":room,"text":"Keep working until stopped"}),
    )
    .await
    .unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let event = events.recv().await.unwrap();
            if event.visible_to("alice") && event.frame["params"]["type"] == "message.delta" {
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
#[tokio::test]
async fn removing_the_last_bot_closes_process_and_purges_room_transcript() {
    let (h, app) = setup();
    let room = room(&app, "alice", json!(["owl"])).await;
    let live = running_room(&app, &room).await;
    let stored = stored_room_session(h.path(), &room);
    let history = hexbot_core::runtime_store::history(h.path(), &stored).unwrap();
    assert!(!history.is_empty());
    assert_eq!(
        app.call("alice", "session.status", &json!({"session_id":live}))
            .await
            .unwrap()["status"],
        "working"
    );
    let removed = app
        .call(
            "alice",
            "hexbot.rooms.remove_member",
            &json!({"id":room,"bot":"owl"}),
        )
        .await
        .unwrap();
    assert_eq!(removed["room"]["deleted"], true);
    assert!(
        app.runtime
            .call("alice", "session.history", &json!({"session_id":live}))
            .await
            .unwrap()
            .is_err()
    );
    assert!(
        hexbot_core::runtime_store::history(h.path(), &stored)
            .unwrap()
            .is_empty()
    );
    assert!(!h.path().join("runtime/sessions").join(&stored).exists());
    let count: i64 = hexbot_core::runtime_store::open(h.path())
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM native_sessions WHERE stored_id=?",
            [&stored],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 0);
    app.shutdown().await;
}
fn turn_status(home: &std::path::Path, room: &str, bot: &str) -> String {
    db::open(home)
        .unwrap()
        .query_row(
            "SELECT status FROM room_turns WHERE room_id=? AND bot=? ORDER BY started_at DESC LIMIT 1",
            [room, bot],
            |r| r.get(0),
        )
        .unwrap()
}
#[tokio::test]
async fn removing_one_bot_leaves_the_other_bots_running() {
    let (h, app) = setup();
    let room = room(&app, "alice", json!(["owl", "fox"])).await;
    let mut events = app.events.subscribe();
    app.call(
        "alice",
        "hexbot.rooms.send",
        &json!({"id":room,"text":"@owl @fox keep working"}),
    )
    .await
    .unwrap();
    let mut live = std::collections::HashSet::new();
    tokio::time::timeout(Duration::from_secs(5), async {
        while live.len() < 2 {
            let event = events.recv().await.unwrap();
            if event.frame["params"]["type"] == "message.delta" {
                live.insert(
                    event.frame["params"]["session_id"]
                        .as_str()
                        .unwrap()
                        .to_string(),
                );
            }
        }
    })
    .await
    .unwrap();
    let owl: String = db::open(h.path())
        .unwrap()
        .query_row(
            "SELECT live_session_id FROM room_sessions WHERE room_id=? AND bot='owl'",
            [&room],
            |r| r.get(0),
        )
        .unwrap();
    app.call(
        "alice",
        "hexbot.rooms.remove_member",
        &json!({"id":room,"bot":"fox"}),
    )
    .await
    .unwrap();
    assert_eq!(turn_status(h.path(), &room, "owl"), "running");
    assert_eq!(
        app.call("alice", "session.status", &json!({"session_id":owl}))
            .await
            .unwrap()["status"],
        "working"
    );
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let event = events.recv().await.unwrap();
            let room_event = &event.frame["params"]["payload"]["event"];
            if room_event["kind"] == "turn.failed" && room_event["actor_id"] == "fox" {
                break;
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(turn_status(h.path(), &room, "owl"), "running");
    app.shutdown().await;
}

#[tokio::test]
async fn rebinding_keeps_running_turns_and_closes_old_connections() {
    let (_h, app) = setup();
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
    app.disconnect();
    assert_eq!(
        app.call("alice", "gateway.ping", &json!({}))
            .await
            .unwrap_err()
            .code,
        5200
    );
    let next = app.rebind("127.0.0.1:0".parse().unwrap()).unwrap();
    assert_eq!(next.events.epoch(), app.events.epoch());
    assert_eq!(
        next.call("alice", "session.status", &json!({"session_id":live}))
            .await
            .unwrap()["status"],
        "working"
    );
    next.shutdown().await;
}

/// A bot that asks before every reply: a question when told "ask me", else an
/// approval. It replies with the answer it got.
const ASKING_PI: &str = r#"#!/usr/bin/env node
const rl=require('node:readline').createInterface({input:process.stdin});const emit=x=>process.stdout.write(JSON.stringify(x)+'\n');
function finish(text){emit({type:'message_end',message:{role:'assistant',content:[{type:'text',text}],model:'test-model',provider:'test',usage:{input:1,output:1},stopReason:'stop'}});emit({type:'agent_settled'});}
rl.on('line',l=>{const c=JSON.parse(l);if(c.type==='extension_ui_response'){finish(String(c.value));return;}emit({type:'response',id:c.id,command:c.type,success:true,data:{}});if(c.type==='prompt'){emit({type:'agent_start'});emit({type:'message_end',message:{role:'user',content:c.message}});if(c.message.includes('ask me')){emit({type:'extension_ui_request',id:'ask-'+c.id,method:'input',title:'__HEXBOT_CLARIFY__'+JSON.stringify({questions:[{qid:'q1',question:'Which color?'}]})});}else{emit({type:'extension_ui_request',id:'approve-'+c.id,method:'select',title:'__HEXBOT_APPROVAL__'+JSON.stringify({tool:'terminal',command:'rm -rf build',reason:'Run command'}),options:['once','session','deny']});}}if(c.type==='abort')emit({type:'agent_settled'});});
"#;
type Events = tokio::sync::broadcast::Receiver<hexbot_core::events::Event>;
async fn wait_for(
    events: &mut Events,
    found: impl Fn(&Value) -> bool,
) -> hexbot_core::events::Event {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let event = events.recv().await.unwrap();
            if found(&event.frame["params"]) {
                break event;
            }
        }
    })
    .await
    .unwrap()
}
/// Events already sent; RPC handlers emit before they reply.
fn sent(events: &mut Events) -> Vec<hexbot_core::events::Event> {
    std::iter::from_fn(|| events.try_recv().ok()).collect()
}
fn cards(events: &mut Events) -> Vec<Value> {
    sent(events)
        .into_iter()
        .map(|e| e.frame["params"].clone())
        .filter(|p| {
            matches!(
                p["type"].as_str(),
                Some("approval.request" | "clarify.request")
            )
        })
        .collect()
}
#[tokio::test]
async fn the_owner_answers_room_approvals_and_questions_and_opening_the_room_resends_them() {
    let (_h, app) = setup_with(ASKING_PI);
    let room = room(&app, "alice", json!(["owl"])).await;
    let open = async |events: &mut Events| {
        app.call("alice", "hexbot.rooms.get", &json!({"id":room}))
            .await
            .unwrap();
        cards(events)
    };
    for choice in ["once", "session", "deny"] {
        let mut events = app.events.subscribe();
        app.call(
            "alice",
            "hexbot.rooms.send",
            &json!({"id":room,"text":format!("Clean up ({choice})")}),
        )
        .await
        .unwrap();
        let asked = wait_for(&mut events, |p| p["type"] == "approval.request").await;
        assert_eq!(asked.owner, "alice");
        let card = asked.frame["params"].clone();
        let live = card["session_id"].as_str().unwrap().to_owned();
        // Reopening the room restores the card.
        sent(&mut events);
        let again = open(&mut events).await;
        assert_eq!(again.len(), 1);
        assert_eq!(
            (&again[0]["session_id"], &again[0]["payload"]),
            (&card["session_id"], &card["payload"])
        );
        let answer =
            json!({"session_id":live,"request_id":card["payload"]["request_id"],"choice":choice});
        app.call("alice", "approval.respond", &answer)
            .await
            .unwrap();
        let reply = wait_for(&mut events, |p| {
            p["payload"]["event"]["kind"] == "message.bot"
        })
        .await;
        assert_eq!(
            reply.frame["params"]["payload"]["event"]["payload"]["text"],
            choice
        );
        // Answered: nothing is waiting, so nothing goes out again.
        sent(&mut events);
        assert_eq!(open(&mut events).await, Vec::<Value>::new());
    }
    let mut events = app.events.subscribe();
    app.call(
        "alice",
        "hexbot.rooms.send",
        &json!({"id":room,"text":"Please ask me something"}),
    )
    .await
    .unwrap();
    let asked = wait_for(&mut events, |p| p["type"] == "clarify.request").await;
    assert_eq!(asked.owner, "alice");
    let card = asked.frame["params"].clone();
    sent(&mut events);
    let again = open(&mut events).await;
    assert_eq!(again.len(), 1);
    assert_eq!(again[0]["type"], "clarify.request");
    assert_eq!(
        again[0]["payload"]["questions"],
        card["payload"]["questions"]
    );
    app.call(
        "alice",
        "clarify.respond",
        &json!({"session_id":card["session_id"],"request_id":card["payload"]["request_id"],"question_id":"q1","answer":"Blue"}),
    )
    .await
    .unwrap();
    let reply = wait_for(&mut events, |p| {
        p["payload"]["event"]["kind"] == "message.bot"
    })
    .await;
    assert_eq!(
        reply.frame["params"]["payload"]["event"]["payload"]["text"],
        r#"{"q1":"Blue"}"#
    );
    sent(&mut events);
    assert_eq!(open(&mut events).await, Vec::<Value>::new());
    app.shutdown().await;
}

#[tokio::test]
async fn rooms_name_their_members_in_get_and_list() {
    let (h, app) = setup();
    db::open(h.path()).unwrap().execute_batch(
        "UPDATE bots SET display_name='Owl' WHERE name='owl'; UPDATE bots SET display_name='Fox' WHERE name='fox';"
    ).unwrap();
    let room = room(&app, "alice", json!(["owl", "fox"])).await;
    let got = app
        .call("alice", "hexbot.rooms.get", &json!({"id":room}))
        .await
        .unwrap();
    let listed = app
        .call("alice", "hexbot.rooms.list", &json!({}))
        .await
        .unwrap();
    assert_eq!(got["room"]["members"], listed["rooms"][0]["members"]);
    for (id, name) in [("owl", "Owl"), ("fox", "Fox"), ("alice", "Alice")] {
        let member = got["room"]["members"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["member_id"] == id)
            .unwrap();
        assert_eq!(member["display_name"], name);
    }
    db::open(h.path())
        .unwrap()
        .execute("UPDATE bots SET display_name='' WHERE name='fox'", [])
        .unwrap();
    let got = app
        .call("alice", "hexbot.rooms.get", &json!({"id":room}))
        .await
        .unwrap();
    assert!(
        got["room"]["members"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["member_id"] == "fox")
            .unwrap()["display_name"]
            .is_null()
    );
    app.shutdown().await;
}
