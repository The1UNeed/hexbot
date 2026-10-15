use hexbot_core::{db, server::App, settings};
use serde_json::{Value, json};
use std::{fs, sync::Arc, time::Duration};

mod support;

async fn fixture() -> (support::TestHome, Arc<App>) {
    let home = support::TestHome::new();
    let pi = home.path().join("fake-pi.cjs");
    fs::write(&pi, r#"#!/usr/bin/env node
const emit=v=>process.stdout.write(JSON.stringify(v)+'\n');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
const c=JSON.parse(line);emit({type:'response',id:c.id,command:c.type,success:true,data:c.type==='get_available_models'?{models:[{id:'fixture',provider:'test'}]}:{}});
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
    for name in ["owl", "fox"] {
        app.call("local", "hexbot.bots.create", &json!({"name":name,"description":"Manual fixture","provider":"openai","model":"fixture","tools":[]})).await.unwrap();
    }
    (home, app)
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

async fn fail_turn(app: &Arc<App>, room: &str, bot: &str) -> Value {
    let mut events = app.events.subscribe();
    app.call(
        "local",
        "hexbot.rooms.send",
        &json!({"id":room,"text":format!("@{bot} fail this turn")}),
    )
    .await
    .unwrap();
    let incident = event(&mut events, "hexbot.bots.incident").await;
    loop {
        let turn = event(&mut events, "hexbot.rooms.turn").await;
        if turn["room_id"] == room && turn["status"] != "running" {
            return incident;
        }
    }
}

async fn failed_room(app: &Arc<App>) -> (String, Value) {
    let room = app
        .call(
            "local",
            "hexbot.rooms.create",
            &json!({"name":"Room","members":["owl"],"main_bot":"owl"}),
        )
        .await
        .unwrap()["room"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let incident = fail_turn(app, &room, "owl").await;
    (room, incident)
}

async fn bots(app: &Arc<App>, name: &str) -> Vec<Value> {
    let get = app
        .call("local", "hexbot.bots.get", &json!({"name":name}))
        .await
        .unwrap();
    let list = app
        .call("local", "hexbot.bots.list", &json!({}))
        .await
        .unwrap();
    vec![
        get["bot"].clone(),
        list["bots"]
            .as_array()
            .unwrap()
            .iter()
            .find(|bot| bot["name"] == name)
            .unwrap()
            .clone(),
    ]
}

fn incident(conn: &rusqlite::Connection, id: &str) -> (Option<String>, Option<f64>) {
    conn.query_row(
        "SELECT room_id,resolved_at FROM bot_incidents WHERE id=?",
        [id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .unwrap()
}

fn notifications(
    events: &mut tokio::sync::broadcast::Receiver<hexbot_core::events::Event>,
) -> Vec<hexbot_core::events::Event> {
    let mut received = Vec::new();
    loop {
        match events.try_recv() {
            Ok(event) => received.push(event),
            Err(tokio::sync::broadcast::error::TryRecvError::Empty) => return received,
            Err(error) => panic!("notification stream failed: {error}"),
        }
    }
}

#[tokio::test]
async fn room_failure_producer_persists_and_broadcasts_owned_stored_context() {
    let (home, app) = fixture().await;
    let (room, failure) = failed_room(&app).await;
    let conn = db::open(home.path()).unwrap();
    let (stored, live): (String, String) = conn.query_row(
        "SELECT stored_session_id,live_session_id FROM room_sessions WHERE room_id=? AND bot='owl'", [&room], |r| Ok((r.get(0)?, r.get(1)?)),
    ).unwrap();
    assert_ne!(stored, live);
    assert_eq!(failure["section_id"], stored);
    assert_eq!(failure["session_id"], live);
    assert_eq!(failure["room_id"], room);
    assert_eq!(failure["incident"]["room_id"], room);
    assert_eq!(
        incident(&conn, failure["incident"]["id"].as_str().unwrap()).0,
        Some(room.clone())
    );
    for bot in bots(&app, "owl").await {
        assert_eq!(bot["status"], "stopped");
        assert_eq!(bot["status_detail"]["room_id"], room);
        assert_eq!(bot["status_detail"]["session_id"], live);
    }
    app.shutdown().await;
}

#[tokio::test]
async fn legacy_room_read_survives_live_rollover_and_dedup_persists_attribution() {
    let (home, app) = fixture().await;
    let (room, failure) = failed_room(&app).await;
    let stored = failure["section_id"].as_str().unwrap();
    let id = failure["incident"]["id"].as_str().unwrap();
    let conn = db::open(home.path()).unwrap();
    conn.execute("UPDATE bot_incidents SET room_id=NULL WHERE id=?", [id])
        .unwrap();
    app.runtime.close_stored("local", stored).await.unwrap();
    let live = app
        .runtime
        .ensure_hidden("local", "owl", stored)
        .await
        .unwrap();
    assert_ne!(json!(live), failure["session_id"]);
    conn.execute(
        "UPDATE room_sessions SET live_session_id=? WHERE room_id=?",
        rusqlite::params![live, room],
    )
    .unwrap();
    for bot in bots(&app, "owl").await {
        assert_eq!(bot["status_detail"]["room_id"], room);
        assert_eq!(bot["status_detail"]["session_id"], failure["session_id"]);
    }
    assert!(
        incident(&conn, id).0.is_none(),
        "legacy reads need no writes"
    );
    let repeated = settings::record_incident(
        home.path(),
        "owl",
        "turn_failed",
        "Retry failed",
        &json!({"section_id":stored,"session_id":live}),
    )
    .unwrap();
    assert_eq!(repeated["id"], id);
    assert_eq!(repeated["room_id"], room);
    assert_eq!(repeated["session_id"], live);
    assert_eq!(incident(&conn, id).0, Some(room));
    app.shutdown().await;
}

async fn delete_room(last_member: bool) {
    let (home, app) = fixture().await;
    let (room, failure) = failed_room(&app).await;
    let conn = db::open(home.path()).unwrap();
    let legacy_id = failure["incident"]["id"].as_str().unwrap();
    conn.execute(
        "UPDATE bot_incidents SET room_id=NULL WHERE id=?",
        [legacy_id],
    )
    .unwrap();
    // Explicit deletion must clear every member. Last-member removal follows
    // the same deletion path with a single member.
    let mut retired = vec![legacy_id.to_owned()];
    if !last_member {
        app.call(
            "local",
            "hexbot.rooms.add_member",
            &json!({"id":room,"bot":"fox"}),
        )
        .await
        .unwrap();
        let fox = fail_turn(&app, &room, "fox").await;
        retired.push(fox["incident"]["id"].as_str().unwrap().to_owned());
    }
    let named = settings::record_incident(
        home.path(),
        "owl",
        "turn_failed",
        "Named room failure",
        &json!({"room_id":room}),
    )
    .unwrap();
    retired.push(named["id"].as_str().unwrap().to_owned());
    let sibling = app
        .call(
            "local",
            "hexbot.rooms.create",
            &json!({"name":"Sibling","members":["owl"]}),
        )
        .await
        .unwrap()["room"]["id"]
        .clone();
    let section: String = conn
        .query_row("SELECT id FROM sections WHERE bot='owl' LIMIT 1", [], |r| {
            r.get(0)
        })
        .unwrap();
    conn.execute_batch("INSERT INTO users(id,display_name,role,created_at) VALUES('bob','Bob','member',0); INSERT INTO bots(name,owner_id) VALUES('remote','bob');").unwrap();
    let mut kept = Vec::new();
    for (bot, kind, text, context) in [
        ("owl", "turn_failed", "Global", json!({})),
        ("owl", "turn_failed", "Sibling", json!({"room_id":sibling})),
        (
            "owl",
            "turn_failed",
            "Private",
            json!({"section_id":section}),
        ),
        (
            "remote",
            "turn_failed",
            "Other owner",
            json!({"room_id":room,"section_id":failure["section_id"]}),
        ),
        (
            "remote",
            "turn_failed",
            "Other owner's legacy",
            json!({"section_id":failure["section_id"]}),
        ),
        (
            "owl",
            "connector_error",
            "Older connector failure",
            json!({"room_id":room,"section_id":failure["section_id"],"connector":"github"}),
        ),
    ] {
        let row = settings::record_incident(home.path(), bot, kind, text, &context).unwrap();
        conn.execute(
            "UPDATE bot_incidents SET created_at=? WHERE id=?",
            rusqlite::params![kept.len() + 1, row["id"].as_str()],
        )
        .unwrap();
        kept.push(row["id"].as_str().unwrap().to_owned());
    }
    let method = if last_member {
        "hexbot.rooms.remove_member"
    } else {
        "hexbot.rooms.delete"
    };
    let params = json!({"id":room,"bot":"owl"});
    let mut events = app.events.subscribe();
    assert_eq!(
        app.call("bob", method, &params).await.unwrap_err().code,
        4302
    );
    assert!(notifications(&mut events).is_empty());
    app.call("local", method, &params).await.unwrap();
    let emitted = notifications(&mut events);
    let changed = emitted
        .iter()
        .find(|e| e.frame["params"]["type"] == "hexbot.rooms.changed")
        .unwrap();
    assert_eq!(
        changed.frame["params"]["payload"],
        json!({"id":room,"bot":"owl","name":"owl","deleted":true})
    );
    let refreshes = emitted
        .iter()
        .filter(|e| e.frame["params"]["type"] == "hexbot.bots.changed")
        .collect::<Vec<_>>();
    assert_eq!(refreshes.len(), 1);
    assert_eq!(refreshes[0].frame["params"]["payload"], json!({}));
    assert!(refreshes[0].frame["params"]["seq"].as_u64() > changed.frame["params"]["seq"].as_u64());
    for event in [changed, refreshes[0]] {
        assert_eq!(event.owner, "local");
        assert!(!event.visible_to("bob"));
    }
    for id in retired {
        let (attributed, resolved) = incident(&conn, &id);
        assert_eq!(attributed, Some(room.clone()));
        assert!(resolved.is_some(), "{id}");
    }
    for id in kept {
        assert!(incident(&conn, &id).1.is_none(), "{id}");
    }
    assert_eq!(
        conn.query_row(
            "SELECT COUNT(*) FROM room_sessions WHERE room_id=?",
            [&room],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    for bot in bots(&app, "owl").await {
        assert_eq!(bot["status"], "stopped");
        assert_eq!(bot["status_detail"]["text"], "Older connector failure");
        assert_eq!(
            bot["status_detail"]["action"],
            json!({"kind":"fix_connector","connector":"github"})
        );
    }
    for bot in bots(&app, "fox").await {
        assert_eq!(bot["status"], "idle");
    }
    assert!(app.call("local", method, &params).await.is_err());
    assert!(notifications(&mut events).is_empty());
    app.shutdown().await;
}

#[tokio::test]
async fn explicit_room_deletion_retires_only_owned_room_failures_and_refreshes_bots() {
    delete_room(false).await;
}

#[tokio::test]
async fn last_member_removal_retires_only_owned_room_failures_and_refreshes_bots() {
    delete_room(true).await;
}

#[test]
fn room_deletion_does_not_claim_ambiguous_foreign_or_other_bot_legacy_mappings() {
    for mapping in ["unique", "ambiguous", "foreign", "other-bot", "live-only"] {
        let home = support::TestHome::new();
        db::migrate(home.path()).unwrap();
        let conn = db::open(home.path()).unwrap();
        conn.execute_batch("INSERT INTO bots(name,owner_id) VALUES('owl','local'),('fox','local');
            INSERT INTO rooms(id,name,owner_id) VALUES('one','One','local'),('two','Two','local');
            INSERT INTO bot_incidents(id,bot,section_id,kind,text,created_at) VALUES('legacy','owl','stored','turn_failed','Failure',1);").unwrap();
        let bot = if mapping == "other-bot" { "fox" } else { "owl" };
        let stored = if mapping == "live-only" {
            "different-stored"
        } else {
            "stored"
        };
        conn.execute("INSERT INTO room_sessions(room_id,bot,stored_session_id,live_session_id) VALUES('one',?,?,'stored')", rusqlite::params![bot, stored]).unwrap();
        if mapping == "ambiguous" {
            conn.execute("INSERT INTO room_sessions(room_id,bot,stored_session_id) VALUES('two','owl','stored')", []).unwrap();
        } else if mapping == "foreign" {
            conn.execute("UPDATE rooms SET owner_id='other-owner' WHERE id='one'", [])
                .unwrap();
        }
        hexbot_core::rooms::delete(home.path(), "one").unwrap();
        let (room, resolved) = incident(&conn, "legacy");
        assert_eq!(resolved.is_some(), mapping == "unique", "{mapping}");
        assert_eq!(
            room.as_deref(),
            if mapping == "unique" {
                Some("one")
            } else {
                None
            },
            "{mapping}"
        );
    }
}

#[tokio::test]
async fn surviving_archived_or_failed_room_deletion_keeps_retry_without_deletion_refresh() {
    for action in [
        "archive",
        "remove-one",
        "failed-delete",
        "failed-last-remove",
    ] {
        let (home, app) = fixture().await;
        let (room, failure) = failed_room(&app).await;
        let conn = db::open(home.path()).unwrap();
        let mut events = app.events.subscribe();
        match action {
            "archive" => {
                app.call("local", "hexbot.rooms.archive", &json!({"id":room}))
                    .await
                    .unwrap();
            }
            "remove-one" => {
                app.call(
                    "local",
                    "hexbot.rooms.add_member",
                    &json!({"id":room,"bot":"fox"}),
                )
                .await
                .unwrap();
                let result = app
                    .call(
                        "local",
                        "hexbot.rooms.remove_member",
                        &json!({"id":room,"bot":"owl","deleted":true}),
                    )
                    .await
                    .unwrap();
                assert_ne!(result["room"]["deleted"], true);
            }
            _ => {
                conn.execute_batch("CREATE TRIGGER refuse_room_delete BEFORE DELETE ON rooms BEGIN SELECT RAISE(FAIL,'fixture'); END;").unwrap();
                let method = if action == "failed-delete" {
                    "hexbot.rooms.delete"
                } else {
                    "hexbot.rooms.remove_member"
                };
                assert!(
                    app.call("local", method, &json!({"id":room,"bot":"owl"}))
                        .await
                        .is_err()
                );
            }
        }
        assert!(
            incident(&conn, failure["incident"]["id"].as_str().unwrap())
                .1
                .is_none()
        );
        for bot in bots(&app, "owl").await {
            assert_eq!(bot["status"], "stopped", "{action}");
            assert_eq!(bot["status_detail"]["room_id"], room);
        }
        let emitted = notifications(&mut events);
        assert!(
            emitted
                .iter()
                .all(|e| e.frame["params"]["type"] != "hexbot.bots.changed"),
            "{action}"
        );
        if action.starts_with("failed-") {
            assert!(
                emitted
                    .iter()
                    .all(|e| e.frame["params"]["type"] != "hexbot.rooms.changed")
            );
        }
        app.shutdown().await;
    }
}
