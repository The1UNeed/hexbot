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
            if event.visible_to("bob") && event.frame["params"]["type"] == "message.delta" {
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
async fn removing_last_shared_member_closes_process_and_purges_room_transcript() {
    let (h, app) = setup();
    let room = room(&app, "bob", json!(["owl"])).await;
    let live = running_room(&app, &room).await;
    let stored = stored_room_session(h.path(), &room);
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
async fn human_members_post_while_the_room_runs_as_its_owner() {
    let (h, app) = setup();
    let room = room(&app, "alice", json!(["owl", "bob"])).await;
    let listed = app
        .call("bob", "hexbot.rooms.list", &json!({}))
        .await
        .unwrap();
    assert_eq!(listed["rooms"][0]["id"], room);
    let mut events = app.events.subscribe();
    app.call(
        "bob",
        "hexbot.rooms.send",
        &json!({"id":room,"text":"Keep working until stopped"}),
    )
    .await
    .unwrap();
    let (mut heard, mut delta_owner) = (std::collections::HashSet::new(), None);
    tokio::time::timeout(Duration::from_secs(5), async {
        while heard.len() < 2 || delta_owner.is_none() {
            let event = events.recv().await.unwrap();
            if event.frame["params"]["payload"]["event"]["kind"] == "message.user" {
                heard.insert(event.owner.clone());
            }
            if event.frame["params"]["type"] == "message.delta" {
                // Members watch the bot write, though it runs as the owner.
                assert!(event.visible_to("bob"));
                delta_owner = Some(event.owner.clone());
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(delta_owner.as_deref(), Some("alice"));
    for (method, p) in [
        ("hexbot.rooms.archive", json!({"id":room})),
        ("hexbot.rooms.delete", json!({"id":room})),
        ("hexbot.rooms.remove_member", json!({"id":room,"bot":"owl"})),
    ] {
        assert_eq!(app.call("bob", method, &p).await.unwrap_err().code, 4302);
    }
    assert_eq!(turn_status(h.path(), &room, "owl"), "running");
    app.shutdown().await;
}
#[tokio::test]
async fn room_owners_add_people_even_when_the_owner_is_not_an_admin() {
    let (h, app) = setup();
    let room = room(&app, "bob", json!(["owl"])).await;
    for method in ["hexbot.rooms.people", "hexbot.rooms.add_member"] {
        assert_eq!(
            app.call("alice", method, &json!({"id":room,"user":"alice"}))
                .await
                .unwrap_err()
                .code,
            4302
        );
    }
    let directory = app
        .call("bob", "hexbot.rooms.people", &json!({"id":room}))
        .await
        .unwrap();
    assert!(
        directory["users"]
            .as_array()
            .unwrap()
            .contains(&json!({"id":"alice","display_name":"Alice"}))
    );
    assert!(
        directory["users"]
            .as_array()
            .unwrap()
            .iter()
            .all(|u| u.as_object().unwrap().len() == 2)
    );
    db::open(h.path())
        .unwrap()
        .execute("UPDATE users SET disabled_at=1 WHERE id='local'", [])
        .unwrap();
    assert!(
        !app.call("bob", "hexbot.rooms.people", &json!({"id":room}))
            .await
            .unwrap()["users"]
            .as_array()
            .unwrap()
            .iter()
            .any(|u| u["id"] == "local")
    );
    let disabled = app
        .call(
            "bob",
            "hexbot.rooms.add_member",
            &json!({"id":room,"user":"local"}),
        )
        .await
        .unwrap_err();
    assert_eq!(
        (disabled.code, disabled.message.as_str()),
        (4202, "That person's account is disabled.")
    );
    let added = app
        .call(
            "bob",
            "hexbot.rooms.add_member",
            &json!({"id":room,"user":"alice"}),
        )
        .await
        .unwrap();
    assert!(
        added["room"]["members"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["member_kind"] == "human"
                && m["member_id"] == "alice"
                && m["left_at"].is_null())
    );
    // Every member reads everyone's name, not only admins and the owner.
    let seen = app
        .call("alice", "hexbot.rooms.get", &json!({"id":room}))
        .await
        .unwrap();
    let names = seen["room"]["members"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| (m["member_id"].clone(), m["display_name"].clone()))
        .collect::<Vec<_>>();
    assert!(names.contains(&(json!("bob"), json!("Bob"))));
    assert!(names.contains(&(json!("alice"), json!("Alice"))));
    assert!(names.contains(&(json!("owl"), Value::Null)));
    // An empty name is no name, so clients fall back to the user id.
    db::open(h.path())
        .unwrap()
        .execute("UPDATE users SET display_name='' WHERE id='bob'", [])
        .unwrap();
    let unnamed = app
        .call("alice", "hexbot.rooms.get", &json!({"id":room}))
        .await
        .unwrap();
    assert!(
        unnamed["room"]["members"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["member_id"] == "bob" && m["display_name"].is_null())
    );
    // Active membership grants reading, but never permission to add someone.
    assert_eq!(
        app.call(
            "alice",
            "hexbot.rooms.add_member",
            &json!({"id":room,"user":"bob"})
        )
        .await
        .unwrap_err()
        .code,
        4302
    );
    app.shutdown().await;
}

#[tokio::test]
async fn the_owner_removes_people_and_members_leave() {
    let (h, app) = setup();
    db::open(h.path())
        .unwrap()
        .execute("INSERT INTO users(id,display_name,role,created_at) VALUES ('carol','Carol','member',0)", [])
        .unwrap();
    let room = room(&app, "alice", json!(["owl", "bob", "carol"])).await;
    let remove = |caller: &'static str, user: &'static str| {
        let app = app.clone();
        let room = room.clone();
        async move {
            app.call(
                caller,
                "hexbot.rooms.remove_member",
                &json!({"id":room,"user":user}),
            )
            .await
        }
    };
    assert_eq!(remove("alice", "alice").await.unwrap_err().code, 4202);
    assert_eq!(remove("bob", "carol").await.unwrap_err().code, 4302);
    // Bob watches a running turn until the owner removes him.
    let live = running_room(&app, &room).await;
    // A reconnecting client rebuilds the running turn from the room row.
    let turns = app
        .call("bob", "hexbot.rooms.get", &json!({"id":room}))
        .await
        .unwrap()["room"]["turns"]
        .clone();
    assert_eq!(turns, json!([{"bot":"owl","live_session_id":live}]));
    let mut events = app.events.subscribe();
    let removed = remove("alice", "bob").await.unwrap();
    assert!(
        !removed["room"]["members"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["member_id"] == "bob" && m["left_at"].is_null())
    );
    let left = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let event = events.recv().await.unwrap();
            if event.owner == "bob" && event.frame["params"]["type"] == "hexbot.rooms.event" {
                break event;
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(
        left.frame["params"]["payload"]["event"]["kind"],
        "member.left"
    );
    assert_eq!(
        left.frame["params"]["payload"]["event"]["payload"]["user"],
        "bob"
    );
    // Bob drops the room; the owner only refreshes it.
    let mut changed = std::collections::HashMap::new();
    tokio::time::timeout(Duration::from_secs(3), async {
        while !(changed.contains_key("alice") && changed.contains_key("bob")) {
            let event = events.recv().await.unwrap();
            if event.frame["params"]["type"] == "hexbot.rooms.changed" {
                changed.insert(
                    event.owner.clone(),
                    event.frame["params"]["payload"].clone(),
                );
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(changed["bob"], json!({"id":room,"removed":true}));
    assert_eq!(changed["alice"], json!({"id":room}));
    for (method, p) in [
        ("hexbot.rooms.get", json!({"id":room})),
        ("hexbot.rooms.log", json!({"id":room})),
        ("hexbot.rooms.send", json!({"id":room,"text":"still here?"})),
    ] {
        assert_eq!(app.call("bob", method, &p).await.unwrap_err().code, 4302);
    }
    assert_eq!(
        app.call("bob", "hexbot.rooms.list", &json!({}))
            .await
            .unwrap()["rooms"],
        json!([])
    );
    let mut events = app.events.subscribe();
    app.events.emit(
        "alice",
        Some(&live),
        "message.delta",
        json!({"text":"more"}),
    );
    app.call(
        "alice",
        "hexbot.rooms.send",
        &json!({"id":room,"text":"Bob is gone"}),
    )
    .await
    .unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        for _ in 0..3 {
            let event = events.recv().await.unwrap();
            assert!(!event.visible_to("bob"), "{}", event.frame);
        }
    })
    .await
    .unwrap();
    // Carol leaves on her own; Alice stays the owner.
    remove("carol", "carol").await.unwrap();
    assert_eq!(
        app.call("carol", "hexbot.rooms.get", &json!({"id":room}))
            .await
            .unwrap_err()
            .code,
        4302
    );
    assert_eq!(
        hexbot_core::rooms::audience(h.path(), &room).unwrap(),
        ["alice"]
    );
    let mut events = app.events.subscribe();
    let added = app
        .call(
            "alice",
            "hexbot.rooms.add_member",
            &json!({"id":room,"user":"bob"}),
        )
        .await
        .unwrap();
    assert!(
        added["room"]["members"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["member_id"] == "bob" && m["left_at"].is_null())
    );
    let joined = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let event = events.recv().await.unwrap();
            if event.owner == "bob" && event.frame["params"]["type"] == "hexbot.rooms.event" {
                break event;
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(
        joined.frame["params"]["payload"]["event"]["kind"],
        "member.added"
    );
    assert_eq!(
        joined.frame["params"]["payload"]["event"]["payload"]["user"],
        "bob"
    );
    assert_eq!(
        app.call("bob", "hexbot.rooms.list", &json!({}))
            .await
            .unwrap()["rooms"][0]["id"],
        room
    );
    app.call("bob", "hexbot.rooms.log", &json!({"id":room}))
        .await
        .unwrap();
    let mut events = app.events.subscribe();
    app.events.emit(
        "alice",
        Some(&live),
        "message.delta",
        json!({"text":"welcome back"}),
    );
    let delta = events.recv().await.unwrap();
    assert!(delta.visible_to("bob"));
    app.call(
        "bob",
        "hexbot.rooms.send",
        &json!({"id":room,"text":"Back"}),
    )
    .await
    .unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let event = events.recv().await.unwrap();
            if event.owner == "bob"
                && event.frame["params"]["payload"]["event"]["kind"] == "message.user"
            {
                break;
            }
        }
    })
    .await
    .unwrap();
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
rl.on('line',l=>{const c=JSON.parse(l);if(c.type==='extension_ui_response'){finish(String(c.value));return;}emit({type:'response',id:c.id,command:c.type,success:true,data:{}});if(c.type==='prompt'){emit({type:'agent_start'});emit({type:'message_end',message:{role:'user',content:c.message}});if(c.message.includes('ask me')){emit({type:'extension_ui_request',id:'ask-'+c.id,method:'input',title:'__HEXBOT_CLARIFY__'+JSON.stringify({questions:[{qid:'q1',question:'Which color?'}]})});}else{emit({type:'extension_ui_request',id:'approve-'+c.id,method:'select',title:'__HEXBOT_APPROVAL__'+JSON.stringify({tool:'terminal',command:'rm -rf build',reason:'Run command'}),options:['once','session','always','deny']});}}if(c.type==='abort')emit({type:'agent_settled'});});
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
    let room = room(&app, "alice", json!(["owl", "bob"])).await;
    let open = async |who: &str, events: &mut Events| {
        app.call(who, "hexbot.rooms.get", &json!({"id":room}))
            .await
            .unwrap();
        cards(events)
    };
    let member_status = async |events: &mut Events, live: &str| {
        app.call("bob", "hexbot.rooms.get", &json!({"id":room}))
            .await
            .unwrap();
        // The turn keeps emitting its own room events, so count only status updates bob sees.
        let replayed: Vec<_> = sent(events)
            .into_iter()
            .filter(|e| {
                e.frame_for("bob")
                    .is_some_and(|f| f["params"]["type"] == "status.update")
            })
            .collect();
        assert_eq!(replayed.len(), 1);
        let status = &replayed[0];
        assert!(status.frame_for("alice").is_none());
        assert!(status.frame_for("local").is_none());
        let frame = status.frame_for("bob").unwrap();
        assert_eq!(frame["params"]["session_id"], live);
        assert_eq!(frame["params"]["type"], "status.update");
        assert_eq!(
            frame["params"]["payload"],
            json!({"kind":"waiting","text":"Waiting for Alice"})
        );
    };
    for choice in ["once", "session", "always", "deny"] {
        let mut events = app.events.subscribe();
        app.call(
            "bob",
            "hexbot.rooms.send",
            &json!({"id":room,"text":format!("Clean up ({choice})")}),
        )
        .await
        .unwrap();
        let asked = wait_for(&mut events, |p| p["type"] == "approval.request").await;
        assert_eq!(asked.owner, "alice");
        // Members see whom the bot waits for, never the card.
        assert_eq!(
            asked.frame_for("bob").unwrap()["params"]["payload"],
            json!({"kind":"waiting","text":"Waiting for Alice"})
        );
        let card = asked.frame["params"].clone();
        let live = card["session_id"].as_str().unwrap().to_owned();
        // Reload restores only the member's wait notice and only the owner's card.
        sent(&mut events);
        member_status(&mut events, &live).await;
        let again = open("alice", &mut events).await;
        assert_eq!(again.len(), 1);
        assert_eq!(
            (&again[0]["session_id"], &again[0]["payload"]),
            (&card["session_id"], &card["payload"])
        );
        let answer =
            json!({"session_id":live,"request_id":card["payload"]["request_id"],"choice":choice});
        assert!(app.call("bob", "approval.respond", &answer).await.is_err());
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
        assert_eq!(open("alice", &mut events).await, Vec::<Value>::new());
    }
    let mut events = app.events.subscribe();
    app.call(
        "bob",
        "hexbot.rooms.send",
        &json!({"id":room,"text":"Please ask me something"}),
    )
    .await
    .unwrap();
    let asked = wait_for(&mut events, |p| p["type"] == "clarify.request").await;
    assert_eq!(asked.owner, "alice");
    assert_eq!(
        asked.frame_for("bob").unwrap()["params"]["payload"]["kind"],
        "waiting"
    );
    let card = asked.frame["params"].clone();
    sent(&mut events);
    member_status(&mut events, card["session_id"].as_str().unwrap()).await;
    let again = open("alice", &mut events).await;
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
    assert_eq!(open("alice", &mut events).await, Vec::<Value>::new());
    app.shutdown().await;
}
#[tokio::test]
async fn opening_a_room_replays_each_running_bots_working_status_only_to_the_member() {
    let (_h, app) = setup();
    let room = room(&app, "alice", json!(["owl", "fox", "bob"])).await;
    let mut events = app.events.subscribe();
    app.call(
        "bob",
        "hexbot.rooms.send",
        &json!({"id":room,"text":"@owl @fox work"}),
    )
    .await
    .unwrap();
    let mut lives = std::collections::HashSet::new();
    while lives.len() < 2 {
        let started = wait_for(&mut events, |p| p["type"] == "message.delta").await;
        lives.insert(
            started.frame["params"]["session_id"]
                .clone()
                .as_str()
                .unwrap()
                .to_owned(),
        );
    }
    sent(&mut events);
    let opened = app
        .call("bob", "hexbot.rooms.get", &json!({"id":room}))
        .await
        .unwrap();
    assert_eq!(opened["room"]["turns"].as_array().unwrap().len(), 2);
    let replayed = sent(&mut events);
    assert_eq!(replayed.len(), 2);
    for status in replayed {
        assert!(status.frame_for("alice").is_none());
        let frame = status.frame_for("bob").unwrap();
        assert_eq!(frame["params"]["type"], "status.update");
        assert_eq!(
            frame["params"]["payload"],
            json!({"kind":"working","text":"Working"})
        );
        assert!(lives.remove(frame["params"]["session_id"].as_str().unwrap()));
    }
    assert!(lives.is_empty());
    assert!(
        app.call("local", "hexbot.rooms.get", &json!({"id":room}))
            .await
            .is_err()
    );
    assert!(sent(&mut events).is_empty());
    app.call("bob", "hexbot.rooms.stop", &json!({"id":room}))
        .await
        .unwrap();
    sent(&mut events);
    app.call("bob", "hexbot.rooms.get", &json!({"id":room}))
        .await
        .unwrap();
    assert!(
        !sent(&mut events).iter().any(|event| {
            event.owner == "bob" && event.frame["params"]["type"] == "status.update"
        })
    );
    app.shutdown().await;
}

#[tokio::test]
async fn members_get_bot_display_names_in_get_and_list_without_the_owners_profiles() {
    let (h, app) = setup();
    db::open(h.path()).unwrap().execute_batch(
        "UPDATE bots SET display_name='Owl' WHERE name='owl'; UPDATE bots SET display_name='Fox' WHERE name='fox';"
    ).unwrap();
    let room = room(&app, "alice", json!(["owl", "fox", "bob"])).await;
    for caller in ["alice", "bob"] {
        let got = app
            .call(caller, "hexbot.rooms.get", &json!({"id":room}))
            .await
            .unwrap();
        let listed = app
            .call(caller, "hexbot.rooms.list", &json!({}))
            .await
            .unwrap();
        assert_eq!(got["room"]["members"], listed["rooms"][0]["members"]);
        for (id, name) in [
            ("owl", "Owl"),
            ("fox", "Fox"),
            ("alice", "Alice"),
            ("bob", "Bob"),
        ] {
            let member = got["room"]["members"]
                .as_array()
                .unwrap()
                .iter()
                .find(|m| m["member_id"] == id)
                .unwrap();
            assert_eq!(member["display_name"], name);
        }
    }
    assert!(
        app.call("bob", "hexbot.bots.get", &json!({"name":"fox"}))
            .await
            .is_err()
    );
    db::open(h.path())
        .unwrap()
        .execute("UPDATE bots SET display_name='' WHERE name='fox'", [])
        .unwrap();
    let got = app
        .call("bob", "hexbot.rooms.get", &json!({"id":room}))
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
async fn rooms_are_created_only_with_people_who_can_join() {
    let (h, app) = setup();
    let create = async |humans: Value| {
        app.call(
            "alice",
            "hexbot.rooms.create",
            &json!({"name":"Lab","members":["owl"],"humans":humans}),
        )
        .await
    };
    let unknown = create(json!(["nobody"])).await.unwrap_err();
    assert_eq!(
        (unknown.code, unknown.message.as_str()),
        (4232, "That person is not on this daemon.")
    );
    db::open(h.path())
        .unwrap()
        .execute("UPDATE users SET disabled_at=1 WHERE id='bob'", [])
        .unwrap();
    let disabled = create(json!(["bob"])).await.unwrap_err();
    assert_eq!(
        (disabled.code, disabled.message.as_str()),
        (4202, "That person's account is disabled.")
    );
    let listed = app
        .call("alice", "hexbot.rooms.list", &json!({}))
        .await
        .unwrap();
    assert_eq!(listed["rooms"], json!([]));
    db::open(h.path())
        .unwrap()
        .execute("UPDATE users SET disabled_at=NULL WHERE id='bob'", [])
        .unwrap();
    let created = create(json!(["bob"])).await.unwrap();
    assert!(
        created["room"]["members"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["member_kind"] == "human" && m["member_id"] == "bob")
    );
    app.shutdown().await;
}
