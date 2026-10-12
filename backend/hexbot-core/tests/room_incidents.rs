use hexbot_core::{catalog, db, server::App, settings};
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
        app.call("local","hexbot.bots.create",&json!({"name":name,"description":"Manual fixture","provider":"openai","model":"fixture","tools":[]})).await.unwrap();
    }
    (home, app)
}
async fn event(
    events: &mut tokio::sync::broadcast::Receiver<hexbot_core::events::Event>,
    kind: &str,
) -> Value {
    let mut seen = Vec::new();
    tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            let event = events.recv().await.unwrap().frame;
            seen.push(event["params"].clone());
            if event["params"]["type"] == kind {
                return event["params"]["payload"].clone();
            }
        }
    })
    .await
    .unwrap_or_else(|_| panic!("missing {kind}; received {seen:?}"))
}
async fn failed_room(app: &Arc<App>) -> (String, Value) {
    let room = app
        .call(
            "local",
            "hexbot.rooms.create",
            &json!({"name":"Room","members":["owl"],"main_bot":"owl"}),
        )
        .await
        .unwrap();
    let id = room["room"]["id"].as_str().unwrap().to_owned();
    let mut events = app.events.subscribe();
    app.call(
        "local",
        "hexbot.rooms.send",
        &json!({"id":id,"text":"Fail this turn"}),
    )
    .await
    .unwrap();
    let incident = event(&mut events, "hexbot.bots.incident").await;
    loop {
        let turn = event(&mut events, "hexbot.rooms.turn").await;
        if turn["room_id"] == id && turn["status"] != "running" {
            break;
        }
    }
    (id, incident)
}
async fn status(app: &Arc<App>, name: &str, room: Value, sid: Value, action: Value) {
    let get = app
        .call("local", "hexbot.bots.get", &json!({"name":name}))
        .await
        .unwrap();
    let list = app
        .call("local", "hexbot.bots.list", &json!({}))
        .await
        .unwrap();
    let listed = list["bots"]
        .as_array()
        .unwrap()
        .iter()
        .find(|bot| bot["name"] == name)
        .unwrap();
    for bot in [&get["bot"], listed] {
        assert_eq!(bot["status"], "stopped");
        assert_eq!(bot["status_detail"]["room_id"], room);
        assert_eq!(bot["status_detail"]["session_id"], sid);
        assert_eq!(bot["status_detail"]["action"], action);
    }
}

#[tokio::test]
async fn real_room_failure_persists_and_broadcasts_canonical_room() {
    let (home, app) = fixture().await;
    let (room, incident) = failed_room(&app).await;
    let conn = db::open(home.path()).unwrap();
    let (stored,live): (String,String) = conn.query_row("SELECT stored_session_id,live_session_id FROM room_sessions WHERE room_id=? AND bot='owl'",[&room],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();
    assert_eq!(incident["section_id"], stored);
    assert_eq!(incident["session_id"], live);
    assert_eq!(incident["room_id"], room);
    assert_eq!(incident["incident"]["room_id"], room);
    let saved: Option<String> = conn
        .query_row(
            "SELECT room_id FROM bot_incidents WHERE id=?",
            [incident["incident"]["id"].as_str().unwrap()],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(saved, Some(room.clone()));
    status(
        &app,
        "owl",
        json!(room),
        json!(live),
        json!({"kind":"retry"}),
    )
    .await;
    app.shutdown().await;
}

#[tokio::test]
async fn legacy_room_failure_normalizes_after_live_session_rollover_without_writes() {
    let (home, app) = fixture().await;
    let (room, incident) = failed_room(&app).await;
    let stored = incident["section_id"].as_str().unwrap();
    let old = incident["session_id"].clone();
    let conn = db::open(home.path()).unwrap();
    // Persist the pre-upgrade producer shape, preserving its real stored session.
    conn.execute(
        "UPDATE bot_incidents SET room_id=NULL WHERE id=?",
        [incident["incident"]["id"].as_str().unwrap()],
    )
    .unwrap();
    app.runtime.close_stored("local", stored).await.unwrap();
    let new = app
        .runtime
        .ensure_hidden("local", "owl", stored)
        .await
        .unwrap();
    assert_ne!(json!(new), old);
    conn.execute(
        "UPDATE room_sessions SET live_session_id=? WHERE room_id=? AND bot='owl'",
        rusqlite::params![new, room],
    )
    .unwrap();
    status(&app, "owl", json!(room), old, json!({"kind":"retry"})).await;
    let room_after: Option<String> = conn
        .query_row(
            "SELECT room_id FROM bot_incidents WHERE id=?",
            [incident["incident"]["id"].as_str().unwrap()],
            |r| r.get(0),
        )
        .unwrap();
    assert!(room_after.is_none());
    conn.execute(
        "DELETE FROM room_sessions WHERE room_id=? AND bot='owl'",
        [&room],
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
async fn incident_dedup_normalizes_only_canonical_turn_failures() {
    let (home, app) = fixture().await;
    let h = home.path();
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
    let original = settings::record_incident(
        h,
        "owl",
        "turn_failed",
        "Old failure",
        &json!({"section_id":"room-stored","session_id":"old-live"}),
    )
    .unwrap();
    db::open(h).unwrap().execute("INSERT INTO room_sessions(room_id,bot,stored_session_id) VALUES(?,'owl','room-stored')",[&room]).unwrap();
    let repeated = settings::record_incident(
        h,
        "owl",
        "turn_failed",
        "New failure",
        &json!({"section_id":"room-stored","session_id":"new-live"}),
    )
    .unwrap();
    assert_eq!(repeated["id"], original["id"]);
    assert_eq!(repeated["room_id"], room);
    assert_eq!(repeated["session_id"], "new-live");
    status(
        &app,
        "owl",
        json!(room),
        json!("new-live"),
        json!({"kind":"retry"}),
    )
    .await;
    let connector = settings::record_incident(
        h,
        "owl",
        "connector_error",
        "Connector failed",
        &json!({"section_id":"room-stored","connector":"github"}),
    )
    .unwrap();
    assert!(connector["room_id"].is_null());
    status(
        &app,
        "owl",
        Value::Null,
        Value::Null,
        json!({"kind":"fix_connector","connector":"github"}),
    )
    .await;
    let private = catalog::call(h, "local", "hexbot.sections.create", &json!({"bot":"fox"}))
        .unwrap()
        .unwrap()["section"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    db::open(h)
        .unwrap()
        .execute(
            "UPDATE room_sessions SET stored_session_id=? WHERE room_id=? AND bot='owl'",
            rusqlite::params![private, room],
        )
        .unwrap();
    let other_bot = settings::record_incident(
        h,
        "fox",
        "turn_failed",
        "Private failure",
        &json!({"section_id":private,"session_id":"private-live","room_id":null}),
    )
    .unwrap();
    assert!(other_bot["room_id"].is_null());
    status(
        &app,
        "fox",
        Value::Null,
        json!("private-live"),
        json!({"kind":"retry"}),
    )
    .await;
    let explicit = settings::record_incident(
        h,
        "fox",
        "turn_failed",
        "Explicit room",
        &json!({"section_id":"different-stored","room_id":"different-room"}),
    )
    .unwrap();
    assert_eq!(explicit["room_id"], "different-room");
    app.shutdown().await;
}

#[tokio::test]
async fn room_inference_requires_one_owned_mapping() {
    for conflicting in [true, false] {
        let (home, app) = fixture().await;
        let h = home.path();
        let conn = db::open(h).unwrap();
        let count = if conflicting { 2 } else { 1 };
        for index in 0..count {
            let room = app
                .call(
                    "local",
                    "hexbot.rooms.create",
                    &json!({"name":format!("Room {index}"),"members":["owl"]}),
                )
                .await
                .unwrap()["room"]["id"]
                .as_str()
                .unwrap()
                .to_owned();
            conn.execute("INSERT INTO room_sessions(room_id,bot,stored_session_id) VALUES(?,'owl','ambiguous')",[&room]).unwrap();
            if !conflicting {
                conn.execute(
                    "UPDATE rooms SET owner_id='another-owner' WHERE id=?",
                    [&room],
                )
                .unwrap();
            }
        }
        let incident = settings::record_incident(
            h,
            "owl",
            "turn_failed",
            "Ambiguous ownership",
            &json!({"section_id":"ambiguous","session_id":"old-live"}),
        )
        .unwrap();
        assert!(incident["room_id"].is_null());
        status(
            &app,
            "owl",
            Value::Null,
            json!("old-live"),
            json!({"kind":"retry"}),
        )
        .await;
        let room: Option<String> = conn
            .query_row(
                "SELECT room_id FROM bot_incidents WHERE id=?",
                [incident["id"].as_str().unwrap()],
                |r| r.get(0),
            )
            .unwrap();
        assert!(room.is_none());
        app.shutdown().await;
    }
}
