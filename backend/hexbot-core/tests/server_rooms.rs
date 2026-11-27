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
    tokio::time::timeout(support::EVENT_WAIT, async {
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
    tokio::time::timeout(support::EVENT_WAIT, async {
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
    tokio::time::timeout(support::EVENT_WAIT, async {
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
    tokio::time::timeout(support::EVENT_WAIT, async {
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
        let got = app
            .call("alice", "hexbot.rooms.get", &json!({"id":room}))
            .await
            .unwrap();
        assert!(got.get("rooms").is_none());
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
        // The running turn lists what it waits on, so a client that missed
        // an answer drops that card.
        let listed = app
            .call("alice", "hexbot.rooms.list", &json!({}))
            .await
            .unwrap();
        let turn = &listed["rooms"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["id"] == room)
            .unwrap()["turns"][0];
        assert_eq!(turn["live_session_id"], live);
        assert_eq!(
            turn["pending_requests"],
            json!([card["payload"]["request_id"]])
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

#[tokio::test]
async fn running_room_turn_snapshot_includes_active_message_bot_asks_for_cold_clients() {
    let ask_pi = r#"#!/usr/bin/env node
const rl=require('node:readline').createInterface({input:process.stdin});const emit=x=>process.stdout.write(JSON.stringify(x)+'\n');
rl.on('line',l=>{
  const c=JSON.parse(l);
  emit({type:'response',id:c.id,command:c.type,success:true,data:{}});
  if(c.type==='prompt'){
    emit({type:'agent_start'});
    emit({type:'message_start',message:{role:'user'}});
    emit({type:'message_end',message:{role:'user',content:c.message}});
    emit({type:'message_start',message:{role:'assistant'}});
    emit({type:'message_end',message:{role:'assistant',content:[{type:'toolCall',id:'call_0',name:'message_bot',arguments:{to:'fox',text:'Check status',wait:true}}]}});
    emit({type:'tool_execution_start',toolCallId:'call_0',toolName:'message_bot',args:{to:'fox',text:'Check status',wait:true}});
  }
  if(c.type==='abort'){
    emit({type:'tool_execution_end',toolCallId:'call_0',toolName:'message_bot',result:{details:{reply:'All good',section_id:'th-fox'},content:[{type:'text',text:'{"reply":"All good","section_id":"th-fox"}'}]},isError:false});
    emit({type:'agent_settled'});
  }
});
"#;
    let (_h, app) = setup_with(ask_pi);
    let room = room(&app, "alice", json!(["owl", "fox"])).await;
    let mut events = app.events.subscribe();
    app.call(
        "alice",
        "hexbot.rooms.send",
        &json!({"id":room,"text":"@owl ask fox"}),
    )
    .await
    .unwrap();
    let started = tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let event = events.recv().await.unwrap();
            if event.frame["params"]["type"] == "tool.start"
                && event.frame["params"]["payload"]["name"] == "message_bot"
            {
                break event;
            }
        }
    })
    .await
    .unwrap();
    let live_id = started.frame["params"]["session_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let started_occ = started.frame["params"]["payload"]["occurrence_id"]
        .as_str()
        .expect("occurrence_id on tool.start")
        .to_owned();

    let got = app
        .call("alice", "hexbot.rooms.get", &json!({"id":room}))
        .await
        .unwrap();
    let listed = app
        .call("alice", "hexbot.rooms.list", &json!({}))
        .await
        .unwrap();
    for turns in [
        got["room"]["turns"].as_array().unwrap(),
        listed["rooms"][0]["turns"].as_array().unwrap(),
    ] {
        let turn = turns
            .iter()
            .find(|t| t["bot"] == "owl" && t["live_session_id"] == live_id)
            .expect("running owl turn");
        assert!(turn["id"].as_str().is_some_and(|s| !s.is_empty()));
        assert!(turn["turn_id"].as_str().is_some_and(|s| !s.is_empty()));
        let asks = turn["asks"]
            .as_array()
            .expect("active asks on running turn");
        assert_eq!(asks.len(), 1);
        assert_eq!(asks[0]["occurrence_id"], started_occ);
        assert_eq!(asks[0]["tool_id"], "call_0");
        assert_eq!(asks[0]["context"], "fox");
        assert_eq!(asks[0]["status"], "running");
        assert_eq!(asks[0]["args"]["to"], "fox");
        assert_eq!(asks[0]["args"]["wait"], true);
    }
    app.call("alice", "hexbot.rooms.stop", &json!({"id":room}))
        .await
        .unwrap();
    let completed = tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let event = events.recv().await.unwrap();
            if event.frame["params"]["type"] == "tool.complete"
                && event.frame["params"]["payload"]["name"] == "message_bot"
            {
                break event;
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(
        completed.frame["params"]["payload"]["args"]["text"],
        "Check status"
    );
    assert_eq!(
        completed.frame["params"]["payload"]["occurrence_id"],
        started_occ
    );
    app.shutdown().await;
}

#[tokio::test]
async fn repeated_reused_tool_ids_share_distinct_occurrence_ids_across_events_and_history() {
    let reuse_pi = r#"#!/usr/bin/env node
const rl=require('node:readline').createInterface({input:process.stdin});const emit=x=>process.stdout.write(JSON.stringify(x)+'\n');
rl.on('line',l=>{
  const c=JSON.parse(l);
  emit({type:'response',id:c.id,command:c.type,success:true,data:{}});
  if(c.type==='prompt'){
    emit({type:'agent_start'});
    emit({type:'message_start',message:{role:'user'}});
    emit({type:'message_end',message:{role:'user',content:c.message}});
    for(const n of [1,2]){
      emit({type:'message_start',message:{role:'assistant'}});
      emit({type:'message_end',message:{role:'assistant',content:[{type:'toolCall',id:'call_0',name:'message_bot',arguments:{to:'fox',text:'Ping',wait:true}}]}});
      emit({type:'tool_execution_start',toolCallId:'call_0',toolName:'message_bot',args:{to:'fox',text:'Ping',wait:true}});
      emit({type:'tool_execution_end',toolCallId:'call_0',toolName:'message_bot',result:{details:{reply:'OK',section_id:'th-fox'},content:[{type:'text',text:'{"reply":"OK","section_id":"th-fox"}'}]},isError:false});
      emit({type:'message_end',message:{role:'toolResult',toolCallId:'call_0',toolName:'message_bot',content:[{type:'text',text:'{"reply":"OK","section_id":"th-fox"}'}],isError:false}});
    }
    emit({type:'message_start',message:{role:'assistant'}});
    emit({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'Done.'}]}});
    emit({type:'agent_end',willRetry:false});
    emit({type:'agent_settled'});
  }
});
"#;
    let (_h, app) = setup_with(reuse_pi);
    let mut events = app.events.subscribe();
    let opened = app
        .call("alice", "hexbot.sections.open", &json!({"id":"section"}))
        .await
        .unwrap();
    let live = opened["section"]["live_session_id"]
        .as_str()
        .unwrap()
        .to_owned();
    app.call(
        "alice",
        "prompt.submit",
        &json!({"session_id":live,"text":"Ask fox twice"}),
    )
    .await
    .unwrap();
    let mut start_occs = Vec::new();
    let mut complete_occs = Vec::new();
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let event = events.recv().await.unwrap();
            let kind = event.frame["params"]["type"].as_str().unwrap_or("");
            if kind == "tool.start" {
                start_occs.push(
                    event.frame["params"]["payload"]["occurrence_id"]
                        .as_str()
                        .unwrap()
                        .to_owned(),
                );
            } else if kind == "tool.complete" {
                complete_occs.push(
                    event.frame["params"]["payload"]["occurrence_id"]
                        .as_str()
                        .unwrap()
                        .to_owned(),
                );
            } else if kind == "message.complete" {
                break;
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(start_occs.len(), 2);
    assert_eq!(complete_occs, start_occs);
    assert_ne!(start_occs[0], start_occs[1]);

    let history = app
        .call("alice", "hexbot.sections.open", &json!({"id":"section"}))
        .await
        .unwrap();
    let rows = history["messages"].as_array().unwrap();
    let decl_occs: Vec<String> = rows
        .iter()
        .filter(|r| r["role"] == "assistant")
        .flat_map(|r| r["tool_calls"].as_array().into_iter().flatten())
        .filter_map(|c| c["occurrence_id"].as_str().map(str::to_owned))
        .collect();
    let result_occs: Vec<String> = rows
        .iter()
        .filter(|r| r["role"] == "tool")
        .filter_map(|r| r["occurrence_id"].as_str().map(str::to_owned))
        .collect();
    assert_eq!(decl_occs, start_occs);
    assert_eq!(result_occs, start_occs);
    app.shutdown().await;
}

#[tokio::test]
async fn parallel_same_id_nested_and_fallback_asks_keep_exact_identities() {
    let script = r#"#!/usr/bin/env node
const rl = require('node:readline').createInterface({input: process.stdin});
const emit = o => process.stdout.write(JSON.stringify(o) + '\n');
let mode = 0;
rl.on('line', line => {
  const c = JSON.parse(line);
  emit({type:'response',id:c.id,command:c.type,success:true,data:{}});
  if(c.type==='prompt'){
    mode += 1;
    if(mode === 1){
      // 1) Parallel same-ID calls in one assistant message: Chemistry finishes before Biology,
      //    while toolResult messages land in declaration order (Biology, then Chemistry).
      emit({type:'agent_start'});
      emit({type:'message_start',message:{role:'user'}});
      emit({type:'message_end',message:{role:'user',content:c.message}});
      emit({type:'message_start',message:{role:'assistant'}});
      emit({type:'message_end',message:{role:'assistant',content:[
        {type:'toolCall',id:'call_0',name:'message_bot',arguments:{to:'biology',text:'Q1',wait:true}},
        {type:'toolCall',id:'call_0',name:'message_bot',arguments:{to:'chemistry',text:'Q2',wait:true}}
      ]}});
      emit({type:'tool_execution_start',toolCallId:'call_0',toolName:'message_bot',args:{to:'biology',text:'Q1',wait:true}});
      emit({type:'tool_execution_start',toolCallId:'call_0',toolName:'message_bot',args:{to:'chemistry',text:'Q2',wait:true}});
      emit({type:'tool_execution_end',toolCallId:'call_0',toolName:'message_bot',result:{details:{reply:'Chem reply',section_id:'th-chem',from:'chemistry'},content:[{type:'text',text:'{"reply":"Chem reply","section_id":"th-chem"}'}]},isError:false});
      emit({type:'tool_execution_end',toolCallId:'call_0',toolName:'message_bot',result:{details:{reply:'Bio reply',section_id:'th-bio',from:'biology'},content:[{type:'text',text:'{"reply":"Bio reply","section_id":"th-bio"}'}]},isError:false});
      emit({type:'message_end',message:{role:'toolResult',toolCallId:'call_0',toolName:'message_bot',content:[{type:'text',text:'{"reply":"Bio reply","section_id":"th-bio"}'}],isError:false}});
      emit({type:'message_end',message:{role:'toolResult',toolCallId:'call_0',toolName:'message_bot',content:[{type:'text',text:'{"reply":"Chem reply","section_id":"th-chem"}'}],isError:false}});
      // 2) Nested codemode message_bot call + fallback continuation before agent_settled.
      emit({type:'tool_execution_start',toolCallId:'code',toolName:'codemode',args:{code:'ask()'}});
      emit({type:'tool_execution_start',toolCallId:'code/1',parentToolCallId:'code',toolName:'message_bot',args:{to:'biology',text:'FYI',wait:false}});
      emit({type:'tool_execution_end',toolCallId:'code/1',parentToolCallId:'code',toolName:'message_bot',result:{details:{status:'sent',section_id:'th-bio'},content:[{type:'text',text:'{"status":"sent","section_id":"th-bio"}'}]},isError:false});
      emit({type:'tool_execution_end',toolCallId:'code',toolName:'codemode',result:{content:[{type:'text',text:'ok'}]},isError:false});
      emit({type:'message_end',message:{role:'toolResult',toolCallId:'code',toolName:'codemode',content:[{type:'text',text:'ok'}],isError:false,nestedCalls:{calls:[{id:'code/1',name:'message_bot',arguments:{to:'biology',text:'FYI',wait:false},status:'ok',durationMs:10}]}}});
      // Fallback continuation starts a new agent_start without agent_settled.
      emit({type:'agent_start'});
      setTimeout(() => {
        emit({type:'message_start',message:{role:'assistant'}});
        emit({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'All done.'}]}});
        emit({type:'agent_end',willRetry:false});
        emit({type:'agent_settled'});
      }, 250);
    }
  }
});
"#;
    let (h, app) = setup_with(script);
    fs::write(
        h.path().join("profiles").join("owl").join("config.yaml"),
        "model:\n  provider: openai\n  default: test-model\ntools:\n  enabled_toolsets: [hexbot]\n",
    )
    .unwrap();
    let mut events = app.events.subscribe();
    let opened = app
        .call("alice", "hexbot.sections.open", &json!({"id":"section"}))
        .await
        .unwrap();
    let live = opened["section"]["live_session_id"]
        .as_str()
        .unwrap()
        .to_owned();
    app.call(
        "alice",
        "prompt.submit",
        &json!({"session_id":live,"text":"Run parallel + nested + fallback"}),
    )
    .await
    .unwrap();

    let mut starts = Vec::new();
    let mut completes = Vec::new();
    let mut start_count = 0;
    let mut asks_after_fallback = None;
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let event = events.recv().await.unwrap();
            let kind = event.frame["params"]["type"].as_str().unwrap_or("");
            if kind == "message.start" {
                start_count += 1;
                if start_count == 2 {
                    asks_after_fallback = app.runtime.turn_asks("alice", &live);
                }
            } else if kind == "tool.start"
                && event.frame["params"]["payload"]["name"] == "message_bot"
            {
                starts.push(event.frame["params"]["payload"].clone());
            } else if kind == "tool.complete"
                && event.frame["params"]["payload"]["name"] == "message_bot"
            {
                completes.push(event.frame["params"]["payload"].clone());
            } else if kind == "message.complete" {
                break;
            }
        }
    })
    .await
    .unwrap();

    // Parallel completions keep exact targets AND exact non-swapped occurrence_ids
    // (Chemistry finishes first with starts[1]'s occurrence_id, Biology second with starts[0]'s).
    assert_eq!(starts.len(), 3);
    assert_eq!(completes.len(), 3);
    let bio_occ = starts[0]["occurrence_id"].as_str().unwrap();
    let chem_occ = starts[1]["occurrence_id"].as_str().unwrap();
    assert_ne!(bio_occ, chem_occ);
    assert_eq!(completes[0]["occurrence_id"], chem_occ);
    assert_eq!(completes[0]["context"], "chemistry");
    assert_eq!(completes[0]["args"]["to"], "chemistry");
    assert_eq!(completes[1]["occurrence_id"], bio_occ);
    assert_eq!(completes[1]["context"], "biology");
    assert_eq!(completes[1]["args"]["to"], "biology");

    // Fallback continuation preserves earlier asks (including nested parent_tool_call_id).
    let asks = asks_after_fallback.expect("asks snapshot after fallback");
    assert_eq!(asks.len(), 3);
    assert_eq!(asks[0]["occurrence_id"], bio_occ);
    assert_eq!(asks[0]["context"], "biology");
    assert_eq!(asks[0]["section_id"], "th-bio");
    assert_eq!(asks[1]["occurrence_id"], chem_occ);
    assert_eq!(asks[1]["context"], "chemistry");
    assert_eq!(asks[1]["section_id"], "th-chem");
    assert_eq!(asks[2]["tool_id"], "code/1");
    assert_eq!(asks[2]["parent_tool_call_id"], "code");
    assert_eq!(asks[2]["section_id"], "th-bio");

    // Persisted history preserves declaration-ordered contexts & occurrence_ids for parallel tool
    // rows AND enriches nested codemode message_bot calls with section_id + result.
    let history = app
        .call("alice", "hexbot.sections.open", &json!({"id":"section"}))
        .await
        .unwrap();
    let rows = history["messages"].as_array().unwrap();
    let parallel_rows: Vec<&Value> = rows
        .iter()
        .filter(|r| r["role"] == "tool" && r["name"] == "message_bot")
        .collect();
    assert_eq!(parallel_rows.len(), 2);
    assert_eq!(parallel_rows[0]["context"], "biology");
    assert_eq!(parallel_rows[0]["occurrence_id"], bio_occ);
    assert_eq!(parallel_rows[1]["context"], "chemistry");
    assert_eq!(parallel_rows[1]["occurrence_id"], chem_occ);

    let codemode_row = rows
        .iter()
        .find(|r| r["role"] == "tool" && r["name"] == "codemode")
        .unwrap();
    assert_eq!(
        codemode_row["nested_calls"]["calls"][0]["section_id"],
        "th-bio"
    );
    assert_eq!(
        codemode_row["nested_calls"]["calls"][0]["result"]["status"],
        "sent"
    );
    app.shutdown().await;
}

#[tokio::test]
async fn parallel_same_id_rejections_settle_both_snapshot_asks_with_distinct_contexts() {
    let script = r#"#!/usr/bin/env node
const rl = require('node:readline').createInterface({input: process.stdin});
const emit = o => process.stdout.write(JSON.stringify(o) + '\n');
rl.on('line', line => {
  const c = JSON.parse(line);
  emit({type:'response',id:c.id,command:c.type,success:true,data:{}});
  if(c.type==='prompt'){
    emit({type:'agent_start'});
    emit({type:'message_start',message:{role:'user'}});
    emit({type:'message_end',message:{role:'user',content:c.message}});
    emit({type:'message_start',message:{role:'assistant'}});
    emit({type:'message_end',message:{role:'assistant',content:[
      {type:'toolCall',id:'call_0',name:'message_bot',arguments:{to:'ghost-a',text:'Hi',wait:true}},
      {type:'toolCall',id:'call_0',name:'message_bot',arguments:{to:'ghost-b',text:'Hi',wait:true}}
    ]}});
    emit({type:'tool_execution_start',toolCallId:'call_0',toolName:'message_bot',args:{to:'ghost-a',text:'Hi',wait:true}});
    emit({type:'tool_execution_start',toolCallId:'call_0',toolName:'message_bot',args:{to:'ghost-b',text:'Hi',wait:true}});
    emit({type:'tool_execution_end',toolCallId:'call_0',toolName:'message_bot',result:{content:[{type:'text',text:'Bridge rejected call'}]},isError:true});
    emit({type:'tool_execution_end',toolCallId:'call_0',toolName:'message_bot',result:{content:[{type:'text',text:'Bridge rejected call'}]},isError:true});
    setTimeout(() => {
      emit({type:'message_start',message:{role:'assistant'}});
      emit({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'Both failed.'}]}});
      emit({type:'agent_end',willRetry:false});
      emit({type:'agent_settled'});
    }, 250);
  }
});
"#;
    let (h, app) = setup_with(script);
    fs::write(
        h.path().join("profiles").join("owl").join("config.yaml"),
        "model:\n  provider: openai\n  default: test-model\ntools:\n  enabled_toolsets: [hexbot]\n",
    )
    .unwrap();
    let mut events = app.events.subscribe();
    let opened = app
        .call("alice", "hexbot.sections.open", &json!({"id":"section"}))
        .await
        .unwrap();
    let live = opened["section"]["live_session_id"]
        .as_str()
        .unwrap()
        .to_owned();
    app.call(
        "alice",
        "prompt.submit",
        &json!({"session_id":live,"text":"Reject both"}),
    )
    .await
    .unwrap();

    let mut completes = Vec::new();
    let mut asks_mid_turn = None;
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let event = events.recv().await.unwrap();
            let kind = event.frame["params"]["type"].as_str().unwrap_or("");
            if kind == "tool.complete" && event.frame["params"]["payload"]["name"] == "message_bot"
            {
                completes.push(event.frame["params"]["payload"].clone());
                if completes.len() == 2 {
                    asks_mid_turn = app.runtime.turn_asks("alice", &live);
                }
            } else if kind == "message.complete" {
                break;
            }
        }
    })
    .await
    .unwrap();

    assert_eq!(completes.len(), 2);
    assert_eq!(completes[0]["context"], "ghost-a");
    assert_eq!(completes[0]["args"]["to"], "ghost-a");
    assert_eq!(completes[1]["context"], "ghost-b");
    assert_eq!(completes[1]["args"]["to"], "ghost-b");

    let asks = asks_mid_turn.expect("turn asks snapshot after both failures");
    assert_eq!(asks.len(), 2);
    assert_eq!(asks[0]["context"], "ghost-a");
    assert_eq!(asks[0]["status"], "error");
    assert_eq!(asks[1]["context"], "ghost-b");
    assert_eq!(asks[1]["status"], "error");
    app.shutdown().await;
}

#[tokio::test]
async fn valid_ask_and_empty_text_rejection_on_same_call_id_never_swap() {
    let script = r#"#!/usr/bin/env node
const rl = require('node:readline').createInterface({input: process.stdin});
const emit = o => process.stdout.write(JSON.stringify(o) + '\n');
const pending = new Map();
let done = 0;
rl.on('line', line => {
  const c = JSON.parse(line);
  if(c.type==='extension_ui_response'){
    const reply = JSON.parse(c.value);
    if(reply.error){
      emit({type:'tool_execution_end',toolCallId:'call_0',toolName:'message_bot',result:{content:[{type:'text',text:reply.error}]},isError:true});
    } else {
      emit({type:'tool_execution_end',toolCallId:'call_0',toolName:'message_bot',result:{details:reply.result,content:[{type:'text',text:JSON.stringify(reply.result)}]},isError:false});
    }
    pending.delete(c.id);
    done += 1;
    if(done === 2){
      emit({type:'message_start',message:{role:'assistant'}});
      emit({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'Done.'}]}});
      emit({type:'agent_end',willRetry:false});
      emit({type:'agent_settled'});
    }
    return;
  }
  emit({type:'response',id:c.id,command:c.type,success:true,data:{}});
  if(c.type==='prompt'){
    emit({type:'agent_start'});
    emit({type:'message_start',message:{role:'user'}});
    emit({type:'message_end',message:{role:'user',content:c.message}});
    if(typeof c.message === 'string' && (c.message.startsWith('@owl:') || c.message.startsWith('[reply from') || c.message.startsWith('[delivery to'))){
      setTimeout(() => {
        emit({type:'message_start',message:{role:'assistant'}});
        emit({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'Fox answered.'}]}});
        emit({type:'agent_end',willRetry:false});
        emit({type:'agent_settled'});
      }, 220);
      return;
    }
    emit({type:'message_start',message:{role:'assistant'}});
    emit({type:'message_end',message:{role:'assistant',content:[
      {type:'toolCall',id:'call_0',name:'message_bot',arguments:{to:'fox',text:'Hello',wait:true}},
      {type:'toolCall',id:'call_0',name:'message_bot',arguments:{to:'fox',text:'',wait:true}}
    ]}});
    emit({type:'tool_execution_start',toolCallId:'call_0',toolName:'message_bot',args:{to:'fox',text:'Hello',wait:true}});
    emit({type:'tool_execution_start',toolCallId:'call_0',toolName:'message_bot',args:{to:'fox',text:'',wait:true}});
    pending.set('req-valid', 'valid');
    emit({type:'extension_ui_request',id:'req-valid',method:'input',title:'__HEXBOT_TOOL__'+JSON.stringify({name:'message_bot',id:'call_0',args:{to:'fox',text:'Hello',wait:true}})});
    setTimeout(() => {
      pending.set('req-empty', 'empty');
      emit({type:'extension_ui_request',id:'req-empty',method:'input',title:'__HEXBOT_TOOL__'+JSON.stringify({name:'message_bot',id:'call_0',args:{to:'fox',text:'',wait:true}})});
    }, 40);
  }
});
"#;
    let (h, app) = setup_with(script);
    fs::write(
        h.path().join("profiles").join("owl").join("config.yaml"),
        "model:\n  provider: openai\n  default: test-model\ntools:\n  enabled_toolsets: [hexbot]\n",
    )
    .unwrap();
    let mut events = app.events.subscribe();
    let opened = app
        .call("alice", "hexbot.sections.open", &json!({"id":"section"}))
        .await
        .unwrap();
    let live = opened["section"]["live_session_id"]
        .as_str()
        .unwrap()
        .to_owned();
    app.call(
        "alice",
        "prompt.submit",
        &json!({"session_id":live,"text":"Send valid and empty"}),
    )
    .await
    .unwrap();

    let mut completes = Vec::new();
    let mut asks_after_rejection = None;
    let mut opened_mid_turn_asks = None;
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let event = events.recv().await.unwrap();
            let kind = event.frame["params"]["type"].as_str().unwrap_or("");
            if kind == "tool.complete" && event.frame["params"]["payload"]["name"] == "message_bot"
            {
                completes.push(event.frame["params"]["payload"].clone());
                if completes.len() == 1 {
                    asks_after_rejection = app.runtime.turn_asks("alice", &live);
                    let reopen = app
                        .call("alice", "hexbot.sections.open", &json!({"id":"section"}))
                        .await
                        .unwrap();
                    opened_mid_turn_asks = reopen["asks"].as_array().cloned();
                }
            } else if kind == "message.complete"
                && event.frame["params"]["session_id"].as_str() == Some(live.as_str())
            {
                break;
            }
        }
    })
    .await
    .unwrap();

    assert_eq!(completes.len(), 2);
    // First completion is the empty-text rejection; it carries text: "" and an error.
    assert_eq!(completes[0]["args"]["text"], "");
    assert!(completes[0]["result"]["error"].is_string());
    // Mid-turn snapshot (both runtime.turn_asks and hexbot.sections.open) keeps the valid ask
    // running and reports the empty ask as error.
    let mid = asks_after_rejection.expect("snapshot after rejection");
    assert_eq!(mid.len(), 2);
    assert_eq!(mid[0]["args"]["text"], "Hello");
    assert_eq!(mid[0]["status"], "running");
    assert!(mid[0]["section_id"].is_string());
    assert_eq!(mid[1]["args"]["text"], "");
    assert_eq!(mid[1]["status"], "error");
    let open_asks =
        opened_mid_turn_asks.expect("hexbot.sections.open includes live asks while busy");
    assert_eq!(open_asks.len(), 2);
    assert_eq!(open_asks[0]["args"]["text"], "Hello");
    assert_eq!(open_asks[0]["status"], "running");
    assert_eq!(open_asks[1]["args"]["text"], "");
    assert_eq!(open_asks[1]["status"], "error");
    // Second completion is the valid reply; it carries text: "Hello" and the real section_id.
    assert_eq!(completes[1]["args"]["text"], "Hello");
    assert_eq!(completes[1]["result"]["details"]["reply"], "Fox answered.");
    assert!(completes[1]["result"]["details"]["section_id"].is_string());
    app.shutdown().await;
}

#[tokio::test]
async fn validation_error_on_parallel_same_call_id_never_swaps_occurrences() {
    let script = r#"#!/usr/bin/env node
const rl = require('node:readline').createInterface({input: process.stdin});
const emit = o => process.stdout.write(JSON.stringify(o) + '\n');
let validResult = null;
rl.on('line', line => {
  const c = JSON.parse(line);
  if(c.type==='extension_ui_response'){
    const reply = JSON.parse(c.value);
    validResult = reply.result;
    emit({type:'tool_execution_end',toolCallId:'call_0',toolName:'message_bot',result:{details:reply.result,content:[{type:'text',text:JSON.stringify(reply.result)}]},isError:false});
    emit({type:'message_start',message:{role:'toolResult',toolCallId:'call_0',toolName:'message_bot'}});
    emit({type:'message_end',message:{role:'toolResult',toolCallId:'call_0',toolName:'message_bot',details:validResult,content:[{type:'text',text:JSON.stringify(validResult)}],isError:false}});
    emit({type:'message_start',message:{role:'toolResult',toolCallId:'call_0',toolName:'message_bot'}});
    emit({type:'message_end',message:{role:'toolResult',toolCallId:'call_0',toolName:'message_bot',details:{},content:[{type:'text',text:'Validation failed for tool "message_bot":\n  - root: must have required property \'text\''}],isError:true}});
    emit({type:'message_start',message:{role:'assistant'}});
    emit({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'Done.'}]}});
    emit({type:'agent_end',willRetry:false});
    emit({type:'agent_settled'});
    return;
  }
  emit({type:'response',id:c.id,command:c.type,success:true,data:{}});
  if(c.type==='prompt'){
    emit({type:'agent_start'});
    emit({type:'message_start',message:{role:'user'}});
    emit({type:'message_end',message:{role:'user',content:c.message}});
    if(typeof c.message === 'string' && (c.message.startsWith('@owl:') || c.message.startsWith('[reply from') || c.message.startsWith('[delivery to'))){
      setTimeout(() => {
        emit({type:'message_start',message:{role:'assistant'}});
        emit({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'Fox answered Q1.'}]}});
        emit({type:'agent_end',willRetry:false});
        emit({type:'agent_settled'});
      }, 150);
      return;
    }
    emit({type:'message_start',message:{role:'assistant'}});
    emit({type:'message_end',message:{role:'assistant',content:[
      {type:'toolCall',id:'call_0',name:'message_bot',arguments:{to:'fox',text:'Q1',wait:true}},
      {type:'toolCall',id:'call_0',name:'message_bot',arguments:{to:'fox'}}
    ]}});
    emit({type:'tool_execution_start',toolCallId:'call_0',toolName:'message_bot',args:{to:'fox',text:'Q1',wait:true}});
    emit({type:'tool_execution_start',toolCallId:'call_0',toolName:'message_bot',args:{to:'fox'}});
    // Pi rejects the malformed second call during validation BEFORE the first call reaches Rust.
    emit({type:'tool_execution_end',toolCallId:'call_0',toolName:'message_bot',result:{content:[{type:'text',text:'Validation failed for tool "message_bot":\n  - root: must have required property \'text\''}]},isError:true});
    setTimeout(() => {
      emit({type:'extension_ui_request',id:'req-valid',method:'input',title:'__HEXBOT_TOOL__'+JSON.stringify({name:'message_bot',id:'call_0',args:{to:'fox',text:'Q1',wait:true}})});
    }, 80);
  }
});
"#;
    let (h, app) = setup_with(script);
    fs::write(
        h.path().join("profiles").join("owl").join("config.yaml"),
        "model:\n  provider: openai\n  default: test-model\ntools:\n  enabled_toolsets: [hexbot]\n",
    )
    .unwrap();
    let mut events = app.events.subscribe();
    let opened = app
        .call("alice", "hexbot.sections.open", &json!({"id":"section"}))
        .await
        .unwrap();
    let live = opened["section"]["live_session_id"]
        .as_str()
        .unwrap()
        .to_owned();
    app.call(
        "alice",
        "prompt.submit",
        &json!({"session_id":live,"text":"Send valid and malformed"}),
    )
    .await
    .unwrap();

    let mut starts = Vec::new();
    let mut completes = Vec::new();
    let mut asks_after_validation = None;
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let event = events.recv().await.unwrap();
            let kind = event.frame["params"]["type"].as_str().unwrap_or("");
            if kind == "tool.start" && event.frame["params"]["payload"]["name"] == "message_bot" {
                starts.push(event.frame["params"]["payload"].clone());
            } else if kind == "tool.complete"
                && event.frame["params"]["payload"]["name"] == "message_bot"
            {
                completes.push(event.frame["params"]["payload"].clone());
                if completes.len() == 1 {
                    asks_after_validation = app.runtime.turn_asks("alice", &live);
                }
            } else if kind == "message.complete"
                && event.frame["params"]["session_id"].as_str() == Some(live.as_str())
            {
                break;
            }
        }
    })
    .await
    .unwrap();

    assert_eq!(starts.len(), 2);
    assert_eq!(completes.len(), 2);
    let occ_valid = starts[0]["occurrence_id"].as_str().expect("occ for Q1");
    let occ_invalid = starts[1]["occurrence_id"]
        .as_str()
        .expect("occ for malformed ask");
    assert_ne!(occ_valid, occ_invalid);

    // First completion is the validation error; it must carry occ_invalid, NOT occ_valid.
    assert_eq!(completes[0]["occurrence_id"].as_str(), Some(occ_invalid));
    assert!(completes[0]["args"].get("text").is_none());
    assert!(completes[0]["result"]["error"].is_string());

    // Mid-turn snapshot keeps Q1 running on occ_valid and marks malformed occ_invalid as error.
    let mid = asks_after_validation.expect("snapshot after validation error");
    assert_eq!(mid.len(), 2);
    assert_eq!(mid[0]["occurrence_id"].as_str(), Some(occ_valid));
    assert_eq!(mid[0]["status"], "running");
    assert_eq!(mid[1]["occurrence_id"].as_str(), Some(occ_invalid));
    assert_eq!(mid[1]["status"], "error");

    // Second completion is the valid reply; it must carry occ_valid.
    assert_eq!(completes[1]["occurrence_id"].as_str(), Some(occ_valid));
    assert_eq!(completes[1]["args"]["text"], "Q1");
    assert_eq!(
        completes[1]["result"]["details"]["reply"],
        "Fox answered Q1."
    );

    // Persisted history matches the exact same occurrence IDs in declaration order.
    let final_open = app
        .call("alice", "hexbot.sections.open", &json!({"id":"section"}))
        .await
        .unwrap();
    let messages = final_open["messages"].as_array().unwrap();
    let tool_rows: Vec<&serde_json::Value> = messages
        .iter()
        .filter(|m| m["role"] == "tool" && m["name"] == "message_bot")
        .collect();
    assert_eq!(tool_rows.len(), 2);
    assert_eq!(tool_rows[0]["occurrence_id"].as_str(), Some(occ_valid));
    assert_ne!(tool_rows[0]["is_error"], true);
    assert_eq!(tool_rows[1]["occurrence_id"].as_str(), Some(occ_invalid));
    assert_eq!(tool_rows[1]["is_error"], true);

    app.shutdown().await;
}

#[tokio::test]
async fn parallel_async_sends_to_same_bot_finishing_out_of_order_never_swap() {
    let script = r#"#!/usr/bin/env node
const rl = require('node:readline').createInterface({input: process.stdin});
const emit = o => process.stdout.write(JSON.stringify(o) + '\n');
const replies = new Map();
rl.on('line', line => {
  const c = JSON.parse(line);
  if(c.type==='extension_ui_response'){
    replies.set(c.id, JSON.parse(c.value).result);
    if(replies.size === 2){
      const first = replies.get('req-1');
      const second = replies.get('req-2');
      // Deliver the second send's live completion FIRST, then the first send's completion.
      emit({type:'tool_execution_end',toolCallId:'call_0',toolName:'message_bot',result:{details:second,content:[{type:'text',text:JSON.stringify(second)}]},isError:false});
      emit({type:'tool_execution_end',toolCallId:'call_0',toolName:'message_bot',result:{details:first,content:[{type:'text',text:JSON.stringify(first)}]},isError:false});
      // Persist toolResults in declaration order [first, second].
      emit({type:'message_start',message:{role:'toolResult',toolCallId:'call_0',toolName:'message_bot'}});
      emit({type:'message_end',message:{role:'toolResult',toolCallId:'call_0',toolName:'message_bot',details:first,content:[{type:'text',text:JSON.stringify(first)}],isError:false}});
      emit({type:'message_start',message:{role:'toolResult',toolCallId:'call_0',toolName:'message_bot'}});
      emit({type:'message_end',message:{role:'toolResult',toolCallId:'call_0',toolName:'message_bot',details:second,content:[{type:'text',text:JSON.stringify(second)}],isError:false}});
      emit({type:'message_start',message:{role:'assistant'}});
      emit({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'Sent both.'}]}});
      emit({type:'agent_end',willRetry:false});
      emit({type:'agent_settled'});
    }
    return;
  }
  emit({type:'response',id:c.id,command:c.type,success:true,data:{}});
  if(c.type==='prompt'){
    emit({type:'agent_start'});
    emit({type:'message_start',message:{role:'user'}});
    emit({type:'message_end',message:{role:'user',content:c.message}});
    if(typeof c.message === 'string' && (c.message.startsWith('@owl:') || c.message.startsWith('[reply from') || c.message.startsWith('[delivery to'))){
      emit({type:'message_start',message:{role:'assistant'}});
      emit({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'Noted.'}]}});
      emit({type:'agent_end',willRetry:false});
      emit({type:'agent_settled'});
      return;
    }
    emit({type:'message_start',message:{role:'assistant'}});
    emit({type:'message_end',message:{role:'assistant',content:[
      {type:'toolCall',id:'call_0',name:'message_bot',arguments:{to:'fox',text:'First async',wait:false}},
      {type:'toolCall',id:'call_0',name:'message_bot',arguments:{to:'fox',text:'Second async',wait:false}}
    ]}});
    emit({type:'tool_execution_start',toolCallId:'call_0',toolName:'message_bot',args:{to:'fox',text:'First async',wait:false}});
    emit({type:'tool_execution_start',toolCallId:'call_0',toolName:'message_bot',args:{to:'fox',text:'Second async',wait:false}});
    emit({type:'extension_ui_request',id:'req-1',method:'input',title:'__HEXBOT_TOOL__'+JSON.stringify({name:'message_bot',id:'call_0',args:{to:'fox',text:'First async',wait:false}})});
    emit({type:'extension_ui_request',id:'req-2',method:'input',title:'__HEXBOT_TOOL__'+JSON.stringify({name:'message_bot',id:'call_0',args:{to:'fox',text:'Second async',wait:false}})});
  }
});
"#;
    let (h, app) = setup_with(script);
    fs::write(
        h.path().join("profiles").join("owl").join("config.yaml"),
        "model:\n  provider: openai\n  default: test-model\ntools:\n  enabled_toolsets: [hexbot]\n",
    )
    .unwrap();
    let mut events = app.events.subscribe();
    let opened = app
        .call("alice", "hexbot.sections.open", &json!({"id":"section"}))
        .await
        .unwrap();
    let live = opened["section"]["live_session_id"]
        .as_str()
        .unwrap()
        .to_owned();
    app.call(
        "alice",
        "prompt.submit",
        &json!({"session_id":live,"text":"Send two async"}),
    )
    .await
    .unwrap();

    let mut starts = Vec::new();
    let mut completes = Vec::new();
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let event = events.recv().await.unwrap();
            let kind = event.frame["params"]["type"].as_str().unwrap_or("");
            if event.frame["params"]["session_id"].as_str() != Some(live.as_str()) {
                continue;
            }
            if kind == "tool.start" && event.frame["params"]["payload"]["name"] == "message_bot" {
                starts.push(event.frame["params"]["payload"].clone());
            } else if kind == "tool.complete"
                && event.frame["params"]["payload"]["name"] == "message_bot"
            {
                completes.push(event.frame["params"]["payload"].clone());
            } else if kind == "message.complete" {
                break;
            }
        }
    })
    .await
    .unwrap();

    assert_eq!(starts.len(), 2);
    assert_eq!(completes.len(), 2);
    let occ_first = starts[0]["occurrence_id"].as_str().unwrap();
    let occ_second = starts[1]["occurrence_id"].as_str().unwrap();
    assert_ne!(occ_first, occ_second);
    // Second completion arrived first and must carry occ_second + "Second async".
    assert_eq!(completes[0]["occurrence_id"].as_str(), Some(occ_second));
    assert_eq!(completes[0]["args"]["text"], "Second async");
    assert_eq!(completes[1]["occurrence_id"].as_str(), Some(occ_first));
    assert_eq!(completes[1]["args"]["text"], "First async");

    let final_open = app
        .call("alice", "hexbot.sections.open", &json!({"id":"section"}))
        .await
        .unwrap();
    let tool_rows: Vec<&serde_json::Value> = final_open["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|m| m["role"] == "tool" && m["name"] == "message_bot")
        .collect();
    assert_eq!(tool_rows.len(), 2);
    assert_eq!(tool_rows[0]["occurrence_id"].as_str(), Some(occ_first));
    assert_eq!(tool_rows[1]["occurrence_id"].as_str(), Some(occ_second));

    app.shutdown().await;
}

#[tokio::test]
async fn early_validation_result_and_reversed_content_only_results_keep_occurrences() {
    let script = r#"#!/usr/bin/env node
const rl = require('node:readline').createInterface({input: process.stdin});
const emit = o => process.stdout.write(JSON.stringify(o) + '\n');
let turn = 0;
rl.on('line', line => {
  const c = JSON.parse(line);
  emit({type:'response',id:c.id,command:c.type,success:true,data:{}});
  if(c.type!=='prompt') return;
  turn += 1;
  emit({type:'agent_start'});
  emit({type:'message_start',message:{role:'user'}});
  emit({type:'message_end',message:{role:'user',content:c.message}});
  if(turn === 1){
    // Early validation toolResult emitted immediately while the valid ask is still running.
    emit({type:'message_start',message:{role:'assistant'}});
    emit({type:'message_end',message:{role:'assistant',content:[
      {type:'toolCall',id:'call_0',name:'message_bot',arguments:{to:'fox',text:'Q1',wait:true}},
      {type:'toolCall',id:'call_0',name:'message_bot',arguments:{to:'fox'}}
    ]}});
    emit({type:'tool_execution_start',toolCallId:'call_0',toolName:'message_bot',args:{to:'fox',text:'Q1',wait:true}});
    emit({type:'tool_execution_start',toolCallId:'call_0',toolName:'message_bot',args:{to:'fox'}});
    emit({type:'tool_execution_end',toolCallId:'call_0',toolName:'message_bot',result:{content:[{type:'text',text:'Validation failed for tool "message_bot": missing text'}]},isError:true});
    emit({type:'message_start',message:{role:'toolResult',toolCallId:'call_0',toolName:'message_bot'}});
    emit({type:'message_end',message:{role:'toolResult',toolCallId:'call_0',toolName:'message_bot',details:{},content:[{type:'text',text:'Validation failed for tool "message_bot": missing text'}],isError:true}});
    emit({type:'tool_execution_end',toolCallId:'call_0',toolName:'message_bot',result:{details:{reply:'Fox ok',section_id:'th-fox'},content:[{type:'text',text:'{"reply":"Fox ok","section_id":"th-fox"}'}]},isError:false});
    emit({type:'message_start',message:{role:'toolResult',toolCallId:'call_0',toolName:'message_bot'}});
    emit({type:'message_end',message:{role:'toolResult',toolCallId:'call_0',toolName:'message_bot',details:{reply:'Fox ok',section_id:'th-fox'},content:[{type:'text',text:'{"reply":"Fox ok","section_id":"th-fox"}'}],isError:false}});
    emit({type:'message_start',message:{role:'assistant'}});
    emit({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'Turn 1 done.'}]}});
  } else {
    // Reversed content-only toolResults (no `details` object) for Biology and Chemistry.
    emit({type:'message_start',message:{role:'assistant'}});
    emit({type:'message_end',message:{role:'assistant',content:[
      {type:'toolCall',id:'call_0',name:'message_bot',arguments:{to:'biology',text:'Bio?',wait:true}},
      {type:'toolCall',id:'call_0',name:'message_bot',arguments:{to:'chemistry',text:'Chem?',wait:true}}
    ]}});
    emit({type:'tool_execution_start',toolCallId:'call_0',toolName:'message_bot',args:{to:'biology',text:'Bio?',wait:true}});
    emit({type:'tool_execution_start',toolCallId:'call_0',toolName:'message_bot',args:{to:'chemistry',text:'Chem?',wait:true}});
    emit({type:'tool_execution_end',toolCallId:'call_0',toolName:'message_bot',result:{details:{to:'chemistry',reply:'Chem reply',section_id:'th-chem'},content:[{type:'text',text:'{"reply":"Chem reply","section_id":"th-chem"}'}]},isError:false});
    emit({type:'tool_execution_end',toolCallId:'call_0',toolName:'message_bot',result:{details:{to:'biology',reply:'Bio reply',section_id:'th-bio'},content:[{type:'text',text:'{"reply":"Bio reply","section_id":"th-bio"}'}]},isError:false});
    emit({type:'message_start',message:{role:'toolResult',toolCallId:'call_0',toolName:'message_bot'}});
    emit({type:'message_end',message:{role:'toolResult',toolCallId:'call_0',toolName:'message_bot',content:[{type:'text',text:'{"reply":"Chem reply","section_id":"th-chem"}'}],isError:false}});
    emit({type:'message_start',message:{role:'toolResult',toolCallId:'call_0',toolName:'message_bot'}});
    emit({type:'message_end',message:{role:'toolResult',toolCallId:'call_0',toolName:'message_bot',content:[{type:'text',text:'{"reply":"Bio reply","section_id":"th-bio"}'}],isError:false}});
    emit({type:'message_start',message:{role:'assistant'}});
    emit({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'Turn 2 done.'}]}});
  }
  emit({type:'agent_end',willRetry:false});
  emit({type:'agent_settled'});
});
"#;
    let (_h, app) = setup_with(script);
    let mut events = app.events.subscribe();
    let opened = app
        .call("alice", "hexbot.sections.open", &json!({"id":"section"}))
        .await
        .unwrap();
    let live = opened["section"]["live_session_id"]
        .as_str()
        .unwrap()
        .to_owned();

    let mut turn1_starts = Vec::new();
    app.call(
        "alice",
        "prompt.submit",
        &json!({"session_id":live,"text":"Turn 1"}),
    )
    .await
    .unwrap();
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let event = events.recv().await.unwrap();
            let kind = event.frame["params"]["type"].as_str().unwrap_or("");
            if kind == "tool.start" && event.frame["params"]["payload"]["name"] == "message_bot" {
                turn1_starts.push(event.frame["params"]["payload"].clone());
            } else if kind == "message.complete" {
                break;
            }
        }
    })
    .await
    .unwrap();

    let mut turn2_starts = Vec::new();
    app.call(
        "alice",
        "prompt.submit",
        &json!({"session_id":live,"text":"Turn 2"}),
    )
    .await
    .unwrap();
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let event = events.recv().await.unwrap();
            let kind = event.frame["params"]["type"].as_str().unwrap_or("");
            if kind == "tool.start" && event.frame["params"]["payload"]["name"] == "message_bot" {
                turn2_starts.push(event.frame["params"]["payload"].clone());
            } else if kind == "message.complete" {
                break;
            }
        }
    })
    .await
    .unwrap();

    let final_open = app
        .call("alice", "hexbot.sections.open", &json!({"id":"section"}))
        .await
        .unwrap();
    let tool_rows: Vec<&serde_json::Value> = final_open["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|m| m["role"] == "tool" && m["name"] == "message_bot")
        .collect();
    assert_eq!(tool_rows.len(), 4);

    // Turn 1: early error toolResult persisted under invalid ask's occurrence ID, NOT valid ask's.
    let occ_valid = turn1_starts[0]["occurrence_id"].as_str().unwrap();
    let occ_invalid = turn1_starts[1]["occurrence_id"].as_str().unwrap();
    assert_eq!(tool_rows[0]["is_error"], true);
    assert_eq!(tool_rows[0]["occurrence_id"].as_str(), Some(occ_invalid));
    assert_ne!(tool_rows[1]["is_error"], true);
    assert_eq!(tool_rows[1]["occurrence_id"].as_str(), Some(occ_valid));

    // Turn 2: reversed content-only toolResults keep matching context + occurrence_id.
    let occ_bio = turn2_starts[0]["occurrence_id"].as_str().unwrap();
    let occ_chem = turn2_starts[1]["occurrence_id"].as_str().unwrap();
    assert_eq!(tool_rows[2]["context"], "chemistry");
    assert_eq!(tool_rows[2]["occurrence_id"].as_str(), Some(occ_chem));
    assert_eq!(tool_rows[3]["context"], "biology");
    assert_eq!(tool_rows[3]["occurrence_id"].as_str(), Some(occ_bio));

    app.shutdown().await;
}

#[tokio::test]
async fn sibling_tool_result_sharing_call_id_never_steals_message_bot_occurrence_or_context() {
    let script = r#"#!/usr/bin/env node
const rl = require('node:readline').createInterface({input: process.stdin});
const emit = o => process.stdout.write(JSON.stringify(o) + '\n');
let turn = 0;
rl.on('line', line => {
  const c = JSON.parse(line);
  emit({type:'response',id:c.id,command:c.type,success:true,data:{}});
  if(c.type!=='prompt') return;
  turn += 1;
  emit({type:'agent_start'});
  emit({type:'message_start',message:{role:'user'}});
  emit({type:'message_end',message:{role:'user',content:c.message}});
  if(turn === 1){
    // Turn 1: Start web_search("mitosis") FIRST and message_bot("biology") SECOND on call_0;
    // finish web_search first and assert its live tool.complete keeps context "mitosis"
    // and its own distinct occurrence_id while message_bot keeps "biology" and its own occurrence_id.
    emit({type:'message_start',message:{role:'assistant'}});
    emit({type:'message_end',message:{role:'assistant',content:[
      {type:'toolCall',id:'call_0',name:'web_search',arguments:{query:'mitosis'}},
      {type:'toolCall',id:'call_0',name:'message_bot',arguments:{to:'biology',text:'Check cells',wait:true}}
    ]}});
    emit({type:'tool_execution_start',toolCallId:'call_0',toolName:'web_search',args:{query:'mitosis'}});
    emit({type:'tool_execution_start',toolCallId:'call_0',toolName:'message_bot',args:{to:'biology',text:'Check cells',wait:true}});
    setTimeout(() => {
      emit({type:'tool_execution_end',toolCallId:'call_0',toolName:'web_search',result:{content:[{type:'text',text:'search hits'}]},isError:false});
      emit({type:'message_start',message:{role:'toolResult',toolCallId:'call_0',toolName:'web_search'}});
      emit({type:'message_end',message:{role:'toolResult',toolCallId:'call_0',toolName:'web_search',content:[{type:'text',text:'search hits'}],isError:false}});
      setTimeout(() => {
        emit({type:'tool_execution_end',toolCallId:'call_0',toolName:'message_bot',result:{details:{to:'biology',reply:'Cells ok',section_id:'th-bio'},content:[{type:'text',text:'{"reply":"Cells ok","section_id":"th-bio"}'}]},isError:false});
        emit({type:'message_start',message:{role:'toolResult',toolCallId:'call_0',toolName:'message_bot'}});
        emit({type:'message_end',message:{role:'toolResult',toolCallId:'call_0',toolName:'message_bot',details:{reply:'Cells ok',section_id:'th-bio'},content:[{type:'text',text:'{"reply":"Cells ok","section_id":"th-bio"}'}],isError:false}});
        emit({type:'message_start',message:{role:'assistant'}});
        emit({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'Turn 1 done.'}]}});
        emit({type:'agent_end',willRetry:false});
        emit({type:'agent_settled'});
      }, 20);
    }, 20);
    return;
  } else {
    // Turn 2: Declare message_bot first and TWO web_search calls on call_0; finish both
    // web_search calls in reverse order first — neither steals message_bot's occurrence_id
    // or misattributes "meiosis" onto the second search's live tool.complete.
    emit({type:'message_start',message:{role:'assistant'}});
    emit({type:'message_end',message:{role:'assistant',content:[
      {type:'toolCall',id:'call_0',name:'message_bot',arguments:{to:'biology',text:'Second check',wait:true}},
      {type:'toolCall',id:'call_0',name:'web_search',arguments:{query:'meiosis'}},
      {type:'toolCall',id:'call_0',name:'web_search',arguments:{query:'cytokinesis'}}
    ]}});
    emit({type:'tool_execution_start',toolCallId:'call_0',toolName:'message_bot',args:{to:'biology',text:'Second check',wait:true}});
    emit({type:'tool_execution_start',toolCallId:'call_0',toolName:'web_search',args:{query:'meiosis'}});
    emit({type:'tool_execution_start',toolCallId:'call_0',toolName:'web_search',args:{query:'cytokinesis'}});
    emit({type:'tool_execution_end',toolCallId:'call_0',toolName:'web_search',result:{content:[{type:'text',text:'cytokinesis hits'}]},isError:false});
    emit({type:'tool_execution_end',toolCallId:'call_0',toolName:'web_search',result:{content:[{type:'text',text:'meiosis hits'}]},isError:false});
    emit({type:'message_start',message:{role:'toolResult',toolCallId:'call_0',toolName:'web_search'}});
    emit({type:'message_end',message:{role:'toolResult',toolCallId:'call_0',toolName:'web_search',content:[{type:'text',text:'meiosis hits'}],isError:false}});
    emit({type:'message_start',message:{role:'toolResult',toolCallId:'call_0',toolName:'web_search'}});
    emit({type:'message_end',message:{role:'toolResult',toolCallId:'call_0',toolName:'web_search',content:[{type:'text',text:'cytokinesis hits'}],isError:false}});
    emit({type:'tool_execution_end',toolCallId:'call_0',toolName:'message_bot',result:{details:{to:'biology',reply:'Still ok',section_id:'th-bio'},content:[{type:'text',text:'{"reply":"Still ok","section_id":"th-bio"}'}]},isError:false});
    emit({type:'message_start',message:{role:'toolResult',toolCallId:'call_0',toolName:'message_bot'}});
    emit({type:'message_end',message:{role:'toolResult',toolCallId:'call_0',toolName:'message_bot',details:{reply:'Still ok',section_id:'th-bio'},content:[{type:'text',text:'{"reply":"Still ok","section_id":"th-bio"}'}],isError:false}});
    emit({type:'message_start',message:{role:'assistant'}});
    emit({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'Turn 2 done.'}]}});
  }
  emit({type:'agent_end',willRetry:false});
  emit({type:'agent_settled'});
});
"#;
    let (_h, app) = setup_with(script);
    let mut events = app.events.subscribe();
    let opened = app
        .call("alice", "hexbot.sections.open", &json!({"id":"section"}))
        .await
        .unwrap();
    let live = opened["section"]["live_session_id"]
        .as_str()
        .unwrap()
        .to_owned();

    // Turn 1
    app.call(
        "alice",
        "prompt.submit",
        &json!({"session_id":live,"text":"Search and ask"}),
    )
    .await
    .unwrap();
    let mut t1_starts = Vec::new();
    let mut t1_completes = Vec::new();
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let event = events.recv().await.unwrap();
            let kind = event.frame["params"]["type"].as_str().unwrap_or("");
            if kind == "tool.start" {
                t1_starts.push(event.frame["params"]["payload"].clone());
            } else if kind == "tool.complete" {
                t1_completes.push(event.frame["params"]["payload"].clone());
            } else if kind == "message.complete" {
                break;
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(t1_starts.len(), 2);
    assert_eq!(t1_completes.len(), 2);
    let search_occ = t1_starts[0]["occurrence_id"]
        .as_str()
        .expect("unique web_search occurrence_id");
    let ask1_occ = t1_starts[1]["occurrence_id"]
        .as_str()
        .expect("message_bot occurrence_id");
    assert_ne!(search_occ, ask1_occ);
    // Live web_search completion keeps "mitosis" (never overwritten by "biology"), its own occ,
    // and a positive duration; message_bot keeps "biology", its own occ, and a positive duration.
    assert_eq!(t1_completes[0]["name"], "web_search");
    assert_eq!(t1_completes[0]["context"], "mitosis");
    assert_eq!(t1_completes[0]["occurrence_id"].as_str(), Some(search_occ));
    assert!(t1_completes[0]["duration_s"].as_f64().unwrap_or(0.0) > 0.0);
    assert_eq!(t1_completes[1]["name"], "message_bot");
    assert_eq!(t1_completes[1]["context"], "biology");
    assert_eq!(t1_completes[1]["occurrence_id"].as_str(), Some(ask1_occ));
    assert!(t1_completes[1]["duration_s"].as_f64().unwrap_or(0.0) > 0.0);

    // Turn 2
    app.call(
        "alice",
        "prompt.submit",
        &json!({"session_id":live,"text":"Ask and search twice"}),
    )
    .await
    .unwrap();
    let mut ask2_occ = None;
    let mut t2_search_completes = Vec::new();
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let event = events.recv().await.unwrap();
            let kind = event.frame["params"]["type"].as_str().unwrap_or("");
            if kind == "tool.start" && event.frame["params"]["payload"]["name"] == "message_bot" {
                ask2_occ = event.frame["params"]["payload"]["occurrence_id"]
                    .as_str()
                    .map(str::to_owned);
            } else if kind == "tool.complete"
                && event.frame["params"]["payload"]["name"] == "web_search"
            {
                t2_search_completes.push(event.frame["params"]["payload"].clone());
            } else if kind == "message.complete" {
                break;
            }
        }
    })
    .await
    .unwrap();
    let ask2_occ = ask2_occ.expect("turn 2 message_bot occurrence_id");
    // Ambiguous parallel web_search completions emit empty context rather than misattributing "meiosis".
    assert_eq!(t2_search_completes.len(), 2);
    assert_eq!(t2_search_completes[0]["context"], "");
    assert_eq!(t2_search_completes[1]["context"], "");

    let final_open = app
        .call("alice", "hexbot.sections.open", &json!({"id":"section"}))
        .await
        .unwrap();
    let tool_rows: Vec<&serde_json::Value> = final_open["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|m| m["role"] == "tool")
        .collect();
    assert_eq!(tool_rows.len(), 5);
    // Turn 1 persisted rows
    assert_eq!(tool_rows[0]["name"], "web_search");
    assert_eq!(tool_rows[0]["occurrence_id"].as_str(), Some(search_occ));
    assert_eq!(tool_rows[0]["context"], "mitosis");
    assert_eq!(tool_rows[1]["name"], "message_bot");
    assert_eq!(tool_rows[1]["occurrence_id"].as_str(), Some(ask1_occ));
    assert_eq!(tool_rows[1]["context"], "biology");
    // Turn 2 persisted rows: duplicate web_search calls get no occurrence_id and never steal ask2_occ.
    assert_eq!(tool_rows[2]["name"], "web_search");
    assert!(tool_rows[2].get("occurrence_id").is_none() || tool_rows[2]["occurrence_id"].is_null());
    assert_eq!(tool_rows[2]["context"], "meiosis");
    assert_eq!(tool_rows[3]["name"], "web_search");
    assert!(tool_rows[3].get("occurrence_id").is_none() || tool_rows[3]["occurrence_id"].is_null());
    assert_eq!(tool_rows[3]["context"], "cytokinesis");
    assert_eq!(tool_rows[4]["name"], "message_bot");
    assert_eq!(
        tool_rows[4]["occurrence_id"].as_str(),
        Some(ask2_occ.as_str())
    );
    assert_eq!(tool_rows[4]["context"], "biology");

    app.shutdown().await;
}

#[tokio::test]
async fn repeated_codemode_nested_asks_and_failed_direct_ask_preserve_exact_sections() {
    let script = r#"#!/usr/bin/env node
const rl = require('node:readline').createInterface({input: process.stdin});
const emit = o => process.stdout.write(JSON.stringify(o) + '\n');
let turn = 0;
rl.on('line', line => {
  const c = JSON.parse(line);
  if(c.type === 'extension_ui_response'){
    const parsed = JSON.parse(c.value || '{}');
    const errText = parsed.error || 'Peer failed';
    emit({type:'tool_execution_end',toolCallId:'call_fail',toolName:'message_bot',result:{content:[{type:'text',text:errText}]},isError:true});
    emit({type:'message_start',message:{role:'toolResult',toolCallId:'call_fail',toolName:'message_bot'}});
    emit({type:'message_end',message:{role:'toolResult',toolCallId:'call_fail',toolName:'message_bot',content:[{type:'text',text:errText}],isError:true}});
    emit({type:'message_start',message:{role:'assistant'}});
    emit({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'Fox failed.'}]}});
    emit({type:'agent_end',willRetry:false});
    emit({type:'agent_settled'});
    return;
  }
  emit({type:'response',id:c.id,command:c.type,success:true,data:{}});
  if(c.type !== 'prompt') return;
  emit({type:'agent_start'});
  emit({type:'message_start',message:{role:'user'}});
  emit({type:'message_end',message:{role:'user',content:c.message}});
  // Recipient bot (`fox`) fails its peer run after delivery created the thread.
  if(c.message.includes('Trigger failure')){
    emit({type:'message_start',message:{role:'assistant'}});
    emit({type:'message_end',message:{role:'assistant',content:[],model:'test-model',provider:'test',stopReason:'error',errorMessage:'Fox crashed'}});
    emit({type:'agent_end',willRetry:false});
    emit({type:'agent_settled'});
    return;
  }
  turn += 1;
  if(turn === 1){
    // Two codemode calls reuse `code` and `code/1`; both finish BEFORE Pi emits the two
    // parent toolResult rows. Each row must keep its own peer section (`th-bio` vs `th-chem`).
    emit({type:'message_start',message:{role:'assistant'}});
    emit({type:'message_end',message:{role:'assistant',content:[
      {type:'toolCall',id:'code',name:'codemode',arguments:{code:'askBio()'}},
      {type:'toolCall',id:'code',name:'codemode',arguments:{code:'askChem()'}}
    ]}});
    emit({type:'tool_execution_start',toolCallId:'code',toolName:'codemode',args:{code:'askBio()'}});
    emit({type:'tool_execution_start',toolCallId:'code/1',parentToolCallId:'code',toolName:'message_bot',args:{to:'biology',text:'Check bio',wait:true}});
    emit({type:'tool_execution_end',toolCallId:'code/1',parentToolCallId:'code',toolName:'message_bot',result:{details:{reply:'Bio ok',section_id:'th-bio'},content:[{type:'text',text:'{"reply":"Bio ok","section_id":"th-bio"}'}]},isError:false});
    emit({type:'tool_execution_end',toolCallId:'code',toolName:'codemode',result:{content:[{type:'text',text:'bio done'}]},isError:false});
    emit({type:'tool_execution_start',toolCallId:'code',toolName:'codemode',args:{code:'askChem()'}});
    emit({type:'tool_execution_start',toolCallId:'code/1',parentToolCallId:'code',toolName:'message_bot',args:{to:'chemistry',text:'Check chem',wait:true}});
    emit({type:'tool_execution_end',toolCallId:'code/1',parentToolCallId:'code',toolName:'message_bot',result:{details:{reply:'Chem ok',section_id:'th-chem'},content:[{type:'text',text:'{"reply":"Chem ok","section_id":"th-chem"}'}]},isError:false});
    emit({type:'tool_execution_end',toolCallId:'code',toolName:'codemode',result:{content:[{type:'text',text:'chem done'}]},isError:false});
    emit({type:'message_end',message:{role:'toolResult',toolCallId:'code',toolName:'codemode',content:[{type:'text',text:'bio done'}],isError:false,nestedCalls:{calls:[{id:'code/1',name:'message_bot',arguments:{to:'biology',text:'Check bio',wait:true},status:'ok',durationMs:10}]}}});
    emit({type:'message_end',message:{role:'toolResult',toolCallId:'code',toolName:'codemode',content:[{type:'text',text:'chem done'}],isError:false,nestedCalls:{calls:[{id:'code/1',name:'message_bot',arguments:{to:'chemistry',text:'Check chem',wait:true},status:'ok',durationMs:12}]}}});
    emit({type:'message_start',message:{role:'assistant'}});
    emit({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'Both done.'}]}});
    emit({type:'agent_end',willRetry:false});
    emit({type:'agent_settled'});
    return;
  }
  // Turn 2: Direct waited message_bot delivery to fox where fox fails after thread creation.
  emit({type:'message_start',message:{role:'assistant'}});
  emit({type:'message_end',message:{role:'assistant',content:[
    {type:'toolCall',id:'call_fail',name:'message_bot',arguments:{to:'fox',text:'Trigger failure',wait:true}}
  ]}});
  emit({type:'tool_execution_start',toolCallId:'call_fail',toolName:'message_bot',args:{to:'fox',text:'Trigger failure',wait:true}});
  emit({type:'extension_ui_request',id:'req-fail',method:'input',title:'__HEXBOT_TOOL__'+JSON.stringify({name:'message_bot',id:'call_fail',args:{to:'fox',text:'Trigger failure',wait:true}})});
});
"#;
    let (h, app) = setup_with(script);
    fs::write(
        h.path().join("profiles").join("owl").join("config.yaml"),
        "model:\n  provider: openai\n  default: test-model\ntools:\n  enabled_toolsets: [hexbot]\n",
    )
    .unwrap();
    let mut events = app.events.subscribe();
    let opened = app
        .call("alice", "hexbot.sections.open", &json!({"id":"section"}))
        .await
        .unwrap();
    let live = opened["section"]["live_session_id"]
        .as_str()
        .unwrap()
        .to_owned();

    // Turn 1: Repeated codemode nested calls keep distinct peer sections.
    app.call(
        "alice",
        "prompt.submit",
        &json!({"session_id":live,"text":"Run two codemode asks"}),
    )
    .await
    .unwrap();
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let event = events.recv().await.unwrap();
            if event.frame["params"]["type"] == "message.complete"
                && event.frame["params"]["session_id"].as_str() == Some(live.as_str())
            {
                break;
            }
        }
    })
    .await
    .unwrap();

    // Turn 2: Failed direct ask retains its created peer thread section_id live and persisted.
    app.call(
        "alice",
        "prompt.submit",
        &json!({"session_id":live,"text":"Ask fox and fail"}),
    )
    .await
    .unwrap();
    let mut failed_live_complete = None;
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let event = events.recv().await.unwrap();
            let kind = event.frame["params"]["type"].as_str().unwrap_or("");
            if kind == "tool.complete"
                && event.frame["params"]["session_id"].as_str() == Some(live.as_str())
                && event.frame["params"]["payload"]["name"] == "message_bot"
            {
                failed_live_complete = Some(event.frame["params"]["payload"].clone());
            } else if kind == "message.complete"
                && event.frame["params"]["session_id"].as_str() == Some(live.as_str())
            {
                break;
            }
        }
    })
    .await
    .unwrap();

    let failed_complete = failed_live_complete.expect("failed direct message_bot completion");
    let live_section = failed_complete["result"]["section_id"]
        .as_str()
        .filter(|s| !s.is_empty())
        .expect("live failed completion preserves section_id");

    let final_open = app
        .call("alice", "hexbot.sections.open", &json!({"id":"section"}))
        .await
        .unwrap();
    let msgs = final_open["messages"].as_array().unwrap();
    let codemode_rows: Vec<&serde_json::Value> = msgs
        .iter()
        .filter(|m| m["role"] == "tool" && m["name"] == "codemode")
        .collect();
    assert_eq!(codemode_rows.len(), 2);
    assert_eq!(
        codemode_rows[0]["nested_calls"]["calls"][0]["arguments"]["to"],
        "biology"
    );
    assert_eq!(
        codemode_rows[0]["nested_calls"]["calls"][0]["section_id"],
        "th-bio"
    );
    assert_eq!(
        codemode_rows[1]["nested_calls"]["calls"][0]["arguments"]["to"],
        "chemistry"
    );
    assert_eq!(
        codemode_rows[1]["nested_calls"]["calls"][0]["section_id"],
        "th-chem"
    );

    let failed_row = msgs
        .iter()
        .find(|m| m["role"] == "tool" && m["name"] == "message_bot" && m["is_error"] == true)
        .expect("persisted failed direct message_bot row");
    assert_eq!(failed_row["section_id"].as_str(), Some(live_section));

    app.shutdown().await;
}

#[tokio::test]
async fn room_turn_event_carries_id_and_unwaited_delivery_failure_marks_bot_message_failed() {
    let script = r#"#!/usr/bin/env node
const rl = require('node:readline').createInterface({input: process.stdin});
const emit = o => process.stdout.write(JSON.stringify(o) + '\n');
rl.on('line', line => {
  const c = JSON.parse(line);
  if(c.type==='extension_ui_response'){
    const reply = JSON.parse(c.value);
    emit({type:'tool_execution_end',toolCallId:'call_bg',toolName:'message_bot',result:{details:reply.result,content:[{type:'text',text:JSON.stringify(reply.result)}]},isError:false});
    emit({type:'message_start',message:{role:'assistant'}});
    emit({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'Sent to fox.'}]}});
    emit({type:'agent_end',willRetry:false});
    emit({type:'agent_settled'});
    return;
  }
  emit({type:'response',id:c.id,command:c.type,success:true,data:{}});
  if(c.type==='prompt'){
    emit({type:'agent_start'});
    emit({type:'message_start',message:{role:'user'}});
    emit({type:'message_end',message:{role:'user',content:c.message}});
    if(typeof c.message === 'string' && c.message.startsWith('@owl:')){
      emit({type:'message_start',message:{role:'assistant'}});
      emit({type:'message_end',message:{role:'assistant',content:[],stopReason:'error',errorMessage:'Fox crashed'}});
      emit({type:'agent_end',willRetry:false});
      emit({type:'agent_settled'});
      return;
    }
    if(typeof c.message === 'string' && c.message.startsWith('[delivery to fox failed]')){
      emit({type:'message_start',message:{role:'assistant'}});
      emit({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'Noted failure.'}]}});
      emit({type:'agent_end',willRetry:false});
      emit({type:'agent_settled'});
      return;
    }
    emit({type:'message_start',message:{role:'assistant'}});
    emit({type:'message_end',message:{role:'assistant',content:[
      {type:'toolCall',id:'call_bg',name:'message_bot',arguments:{to:'fox',text:'Async ping',wait:false}}
    ]}});
    emit({type:'tool_execution_start',toolCallId:'call_bg',toolName:'message_bot',args:{to:'fox',text:'Async ping',wait:false}});
    emit({type:'extension_ui_request',id:'req-bg',method:'input',title:'__HEXBOT_TOOL__'+JSON.stringify({name:'message_bot',id:'call_bg',args:{to:'fox',text:'Async ping',wait:false}})});
  }
});
"#;
    let (h, app) = setup_with(script);
    fs::write(
        h.path().join("profiles").join("owl").join("config.yaml"),
        "model:\n  provider: openai\n  default: test-model\ntools:\n  enabled_toolsets: [hexbot]\n",
    )
    .unwrap();
    let rid = room(&app, "alice", json!(["owl"])).await;
    let mut events = app.events.subscribe();
    app.call(
        "alice",
        "hexbot.rooms.send",
        &json!({"id":rid,"text":"@owl ping fox async"}),
    )
    .await
    .unwrap();

    let mut running_id: Option<String> = None;
    let mut complete_id: Option<String> = None;
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let ev = events.recv().await.unwrap();
            if ev.frame["params"]["type"] == "hexbot.rooms.turn" {
                let p = &ev.frame["params"]["payload"];
                if p["room_id"] == rid && p["bot"] == "owl" {
                    let id = p["id"].as_str().map(str::to_owned);
                    if p["status"] == "running" {
                        running_id = id;
                    } else if p["status"] == "complete" {
                        complete_id = id;
                        break;
                    }
                }
            }
        }
    })
    .await
    .unwrap();

    let running_id = running_id.expect("running hexbot.rooms.turn must carry id");
    let complete_id = complete_id.expect("complete hexbot.rooms.turn must carry id");
    assert_eq!(running_id, complete_id);
    let stored_turn_id: String = db::open(h.path())
        .unwrap()
        .query_row(
            "SELECT id FROM room_turns WHERE room_id=? AND bot='owl'",
            [&rid],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(running_id, stored_turn_id);

    // Wait for the background wait:false delivery to fail and flip bot_messages.failed = 1.
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let failed: Option<i64> = db::open(h.path())
                .unwrap()
                .query_row(
                    "SELECT failed FROM bot_messages WHERE to_bot='fox' ORDER BY created_at DESC LIMIT 1",
                    [],
                    |r| r.get(0),
                )
                .ok();
            if failed == Some(1) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .unwrap();

    app.shutdown().await;
}

#[tokio::test]
async fn nested_live_tool_events_emit_distinct_parent_occurrence_ids() {
    let script = r#"#!/usr/bin/env node
const rl = require('node:readline').createInterface({input: process.stdin});
const emit = o => process.stdout.write(JSON.stringify(o) + '\n');
rl.on('line', line => {
  const c = JSON.parse(line);
  emit({type:'response',id:c.id,command:c.type,success:true,data:{}});
  if(c.type==='prompt'){
    emit({type:'agent_start'});
    emit({type:'message_start',message:{role:'user'}});
    emit({type:'message_end',message:{role:'user',content:c.message}});
    // Two sequential codemode calls in separate assistant fragments reusing toolCallId `code_0`
    // and nested `code_0/1` on the same peer thread `th-bio`.
    emit({type:'message_start',message:{role:'assistant'}});
    emit({type:'message_end',message:{role:'assistant',content:[
      {type:'toolCall',id:'code_0',name:'codemode',arguments:{code:'askBio(1)'}}
    ]}});
    emit({type:'tool_execution_start',toolCallId:'code_0',toolName:'codemode',args:{code:'askBio(1)'}});
    emit({type:'tool_execution_start',toolCallId:'code_0/1',parentToolCallId:'code_0',toolName:'message_bot',args:{to:'biology',text:'Check',wait:true}});
    emit({type:'tool_execution_end',toolCallId:'code_0/1',parentToolCallId:'code_0',toolName:'message_bot',result:{details:{reply:'Ok',section_id:'th-bio'},content:[{type:'text',text:'{"reply":"Ok","section_id":"th-bio"}'}]},isError:false});
    emit({type:'tool_execution_end',toolCallId:'code_0',toolName:'codemode',result:{content:[{type:'text',text:'first done'}]},isError:false});
    emit({type:'message_end',message:{role:'toolResult',toolCallId:'code_0',toolName:'codemode',content:[{type:'text',text:'first done'}],isError:false,nestedCalls:{calls:[{id:'code_0/1',name:'message_bot',arguments:{to:'biology',text:'Check',wait:true},status:'ok',durationMs:5}]}}});
    emit({type:'message_start',message:{role:'assistant'}});
    emit({type:'message_end',message:{role:'assistant',content:[
      {type:'toolCall',id:'code_0',name:'codemode',arguments:{code:'askBio(2)'}}
    ]}});
    emit({type:'tool_execution_start',toolCallId:'code_0',toolName:'codemode',args:{code:'askBio(2)'}});
    emit({type:'tool_execution_start',toolCallId:'code_0/1',parentToolCallId:'code_0',toolName:'message_bot',args:{to:'biology',text:'Check',wait:true}});
    emit({type:'tool_execution_end',toolCallId:'code_0/1',parentToolCallId:'code_0',toolName:'message_bot',result:{details:{reply:'Ok',section_id:'th-bio'},content:[{type:'text',text:'{"reply":"Ok","section_id":"th-bio"}'}]},isError:false});
    emit({type:'tool_execution_end',toolCallId:'code_0',toolName:'codemode',result:{content:[{type:'text',text:'second done'}]},isError:false});
    emit({type:'message_end',message:{role:'toolResult',toolCallId:'code_0',toolName:'codemode',content:[{type:'text',text:'second done'}],isError:false,nestedCalls:{calls:[{id:'code_0/1',name:'message_bot',arguments:{to:'biology',text:'Check',wait:true},status:'ok',durationMs:5}]}}});
    emit({type:'message_start',message:{role:'assistant'}});
    emit({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'All done.'}]}});
    emit({type:'agent_end',willRetry:false});
    emit({type:'agent_settled'});
  }
});
"#;
    let (_h, app) = setup_with(script);
    let mut events = app.events.subscribe();
    let opened = app
        .call("alice", "hexbot.sections.open", &json!({"id":"section"}))
        .await
        .unwrap();
    let live = opened["section"]["live_session_id"]
        .as_str()
        .unwrap()
        .to_owned();
    app.call(
        "alice",
        "prompt.submit",
        &json!({"session_id":live,"text":"Run two sequential codemode asks"}),
    )
    .await
    .unwrap();

    let mut parent_starts = Vec::new();
    let mut nested_starts = Vec::new();
    let mut nested_completes = Vec::new();
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let ev = events.recv().await.unwrap();
            let kind = ev.frame["params"]["type"].as_str().unwrap_or("");
            if ev.frame["params"]["session_id"].as_str() != Some(live.as_str()) {
                continue;
            }
            let p = &ev.frame["params"]["payload"];
            if kind == "tool.start" && p["name"] == "codemode" {
                parent_starts.push(p["occurrence_id"].as_str().map(str::to_owned));
            } else if kind == "tool.start" && p["name"] == "message_bot" {
                nested_starts.push(p["parent_occurrence_id"].as_str().map(str::to_owned));
            } else if kind == "tool.complete" && p["name"] == "message_bot" {
                nested_completes.push(p["parent_occurrence_id"].as_str().map(str::to_owned));
            } else if kind == "message.complete" {
                break;
            }
        }
    })
    .await
    .unwrap();

    assert_eq!(parent_starts.len(), 2);
    let p1 = parent_starts[0]
        .as_deref()
        .expect("first codemode occurrence_id");
    let p2 = parent_starts[1]
        .as_deref()
        .expect("second codemode occurrence_id");
    assert_ne!(p1, p2);
    assert_eq!(
        nested_starts,
        vec![Some(p1.to_owned()), Some(p2.to_owned())]
    );
    assert_eq!(
        nested_completes,
        vec![Some(p1.to_owned()), Some(p2.to_owned())]
    );

    app.shutdown().await;
}
