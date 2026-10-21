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
    let trigger = app
        .call(
            "local",
            "hexbot.rooms.send",
            &json!({"id":room,"text":format!("@{bot} fail this turn")}),
        )
        .await
        .unwrap()["event"]["seq"]
        .clone();
    let incident = event(&mut events, "hexbot.bots.incident").await;
    // The terminal room turn can precede the asynchronous context report.
    // Finish this turn's notifications before asserting what a later RPC emits.
    tokio::time::timeout(Duration::from_secs(8), async {
        let (mut terminal, mut failure, mut changed, mut usage) = (false, false, false, false);
        loop {
            let frame = events.recv().await.unwrap().frame;
            let event = &frame["params"];
            let payload = &event["payload"];
            match event["type"].as_str() {
                Some("hexbot.rooms.turn")
                    if payload["room_id"] == room
                        && payload["bot"] == bot
                        && payload["live_session_id"] == incident["session_id"]
                        && payload["status"] != "running" =>
                {
                    terminal = true
                }
                Some("hexbot.rooms.event")
                    if payload["room_id"] == room
                        && payload["event"]["kind"] == "turn.failed"
                        && payload["event"]["actor_id"] == bot
                        && payload["event"]["payload"]["trigger_seq"] == trigger =>
                {
                    failure = true
                }
                Some("hexbot.sections.changed") if payload["id"] == incident["section_id"] => {
                    changed = true
                }
                Some("session.usage") if event["session_id"] == incident["session_id"] => {
                    usage = true
                }
                _ => {}
            }
            if terminal && failure && changed && usage {
                break;
            }
        }
    })
    .await
    .unwrap();
    incident
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

#[tokio::test]
#[ignore = "requires HEXBOT_TEST_PI pointing to the pinned Pi executable"]
async fn actual_pi_room_failure_survives_restart_and_deletion_keeps_connector_failure() {
    use axum::{Json, Router, http::StatusCode, routing::post};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let model = Router::new().route(
        "/v1/chat/completions",
        post(|| async {
            (
                StatusCode::UNAUTHORIZED,
                Json(json!({"error":{"message":"Fixture provider failed","type":"fixture_error"}})),
            )
        }),
    );
    let server = tokio::spawn(async move { axum::serve(listener, model).await.unwrap() });
    let (home, app) = fixture().await;
    let chat = app
        .call("local", "hexbot.sections.create", &json!({"bot":"owl"}))
        .await
        .unwrap()["section"]["id"]
        .clone();
    app.shutdown().await;
    fs::write(home.path().join("profiles/owl/config.yaml"), format!(
        "model:\n  provider: lmstudio\n  default: fixture\n  api_key: test-key\n  base_url: http://{address}/v1\ntools:\n  enabled_toolsets: []\n"
    )).unwrap();
    fs::create_dir_all(home.path().join("profiles/owl/pi")).unwrap();
    fs::write(
        home.path().join("profiles/owl/pi/settings.json"),
        "{\"retry\":{\"enabled\":false}}",
    )
    .unwrap();
    let pi = std::path::PathBuf::from(std::env::var_os("HEXBOT_TEST_PI").unwrap());
    let app = App::new(
        home.path().into(),
        "127.0.0.1:0".parse().unwrap(),
        pi.clone(),
        None,
    )
    .unwrap();
    let (room, failure) = failed_room(&app).await;
    assert!(
        failure["incident"]["text"]
            .as_str()
            .unwrap()
            .contains("Fixture provider failed")
    );
    assert_eq!(failure["room_id"], room);
    assert_eq!(failure["incident"]["room_id"], room);
    let connector = settings::record_incident(
        home.path(),
        "owl",
        "connector_error",
        "Connector remains",
        &json!({"connector":"github","section_id":failure["section_id"],"room_id":room}),
    )
    .unwrap();
    db::open(home.path())
        .unwrap()
        .execute(
            "UPDATE bot_incidents SET created_at=0 WHERE id=?",
            [connector["id"].as_str().unwrap()],
        )
        .unwrap();
    app.shutdown().await;
    let reopened = App::new(home.path().into(), "127.0.0.1:0".parse().unwrap(), pi, None).unwrap();
    for bot in bots(&reopened, "owl").await {
        assert_eq!(bot["status"], "stopped");
        assert_eq!(bot["status_detail"]["room_id"], room);
        assert_eq!(bot["status_detail"]["section_id"], failure["section_id"]);
        assert_eq!(bot["status_detail"]["session_id"], failure["session_id"]);
    }
    assert_eq!(
        reopened
            .call("local", "hexbot.sections.create", &json!({"bot":"owl"}))
            .await
            .unwrap()["section"]["id"],
        chat
    );
    reopened
        .call("local", "hexbot.rooms.delete", &json!({"id":room}))
        .await
        .unwrap();
    for bot in bots(&reopened, "owl").await {
        assert_eq!(bot["status"], "stopped");
        assert_eq!(bot["status_detail"]["text"], "Connector remains");
    }
    reopened.shutdown().await;
    server.abort();
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

async fn hold_usage(home: &std::path::Path) -> tokio::net::TcpListener {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let path = home.join("fake-pi.cjs");
    let script = fs::read_to_string(&path).unwrap();
    let marker = "const c=JSON.parse(line);emit(";
    assert_eq!(script.matches(marker).count(), 1);
    let held = format!(
        r#"const c=JSON.parse(line);
if(c.type==='get_session_stats'){{
 const socket=require('node:net').connect({{host:'127.0.0.1',port:{}}},()=>socket.write('usage-held\n'));
 socket.once('data',()=>{{emit({{type:'response',id:c.id,command:c.type,success:true,data:{{}}}});socket.end();}});
 return;
}}
emit("#,
        listener.local_addr().unwrap().port()
    );
    fs::write(path, script.replace(marker, &held)).unwrap();
    listener
}

#[tokio::test]
async fn failed_room_waits_for_its_usage_notification_before_returning() {
    use tokio::io::AsyncWriteExt;
    let (home, app) = fixture().await;
    let held_usage = hold_usage(home.path()).await;
    let mut events = app.events.subscribe();
    let waiting = failed_room(&app);
    tokio::pin!(waiting);
    let (mut control, _) = tokio::time::timeout(Duration::from_secs(8), async {
        tokio::select! {
            result = &mut waiting => panic!("failed_room returned before its held usage report: {result:?}"),
            connection = held_usage.accept() => connection.unwrap(),
        }
    }).await.unwrap();
    tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            tokio::select! {
                biased;
                result = &mut waiting => panic!("failed_room returned before its held usage report: {result:?}"),
                event = events.recv() => {
                    let event = event.unwrap();
                    if event.frame["params"]["type"] == "hexbot.rooms.turn"
                        && event.frame["params"]["payload"]["status"] == "failed" {
                        break;
                    }
                }
            }
        }
    }).await.unwrap();
    assert!(futures_util::poll!(waiting.as_mut()).is_pending());
    control.write_all(b"release\n").await.unwrap();
    let (room, failure) = tokio::time::timeout(Duration::from_secs(8), waiting)
        .await
        .unwrap();
    assert_eq!(failure["room_id"], room);
    db::open(home.path())
        .unwrap()
        .execute(
            "INSERT INTO users(id,display_name,role,created_at) VALUES('bob','Bob','member',0)",
            [],
        )
        .unwrap();
    let mut after = app.events.subscribe();
    assert_eq!(
        app.call(
            "bob",
            "hexbot.rooms.remove_member",
            &json!({"id":room,"bot":"owl"})
        )
        .await
        .unwrap_err()
        .code,
        4302
    );
    let unexpected = notifications(&mut after);
    assert!(
        unexpected.is_empty(),
        "notifications after unauthorized removal: {unexpected:#?}"
    );
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
    let unexpected = notifications(&mut events);
    assert!(
        unexpected.is_empty(),
        "notifications after unauthorized {method}: {unexpected:#?}"
    );
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

// Observe connections opened inside the public RPC without production test hooks.
// The callback runs synchronously at each SQL boundary, so the interleaving needs
// no timing assumptions. Its state is local to each test's current-thread runtime.
mod deletion_write_race {
    use rusqlite::{Connection, Error, ffi};
    use std::{
        cell::RefCell,
        ffi::{CStr, c_char, c_int, c_uint, c_void},
        sync::Once,
        time::Duration,
    };

    #[derive(Default)]
    pub struct Attempts {
        pub purge: Option<Result<usize, Error>>,
        pub incident: Option<Result<usize, Error>>,
    }

    struct Race {
        writer: Connection,
        attempts: Attempts,
    }

    thread_local! {
        static RACE: RefCell<Option<Race>> = const { RefCell::new(None) };
    }

    pub struct Guard;
    impl Guard {
        pub fn start(writer: Connection) -> Self {
            static REGISTER: Once = Once::new();
            REGISTER.call_once(|| {
                // SQLite keeps this static callback for future connections.
                assert_eq!(
                    unsafe { ffi::sqlite3_auto_extension(Some(install)) },
                    ffi::SQLITE_OK
                );
            });
            writer.busy_timeout(Duration::ZERO).unwrap();
            RACE.with_borrow_mut(|race| {
                assert!(race.is_none());
                *race = Some(Race {
                    writer,
                    attempts: Attempts::default(),
                });
            });
            Self
        }

        pub fn finish(self) -> Attempts {
            RACE.with_borrow_mut(|race| race.take().unwrap().attempts)
        }
    }

    impl Drop for Guard {
        fn drop(&mut self) {
            RACE.with_borrow_mut(|race| *race = None);
        }
    }

    unsafe extern "C" fn install(
        db: *mut ffi::sqlite3,
        _: *mut *mut c_char,
        _: *const ffi::sqlite3_api_routines,
    ) -> c_int {
        // The trace owns no pointers or callback data beyond SQLite's call.
        unsafe {
            ffi::sqlite3_trace_v2(
                db,
                ffi::SQLITE_TRACE_STMT,
                Some(trace),
                std::ptr::null_mut(),
            )
        }
    }

    unsafe extern "C" fn trace(
        _: c_uint,
        _: *mut c_void,
        statement: *mut c_void,
        _: *mut c_void,
    ) -> c_int {
        let sql = unsafe { ffi::sqlite3_sql(statement.cast()) };
        if sql.is_null() {
            return 0;
        }
        let sql = unsafe { CStr::from_ptr(sql) }.to_bytes();
        let purge = sql.starts_with(b"INSERT OR IGNORE INTO native_deleted");
        let incident = sql.starts_with(b"UPDATE bot_incidents SET room_id=?,resolved_at=?");
        if purge || incident {
            RACE.with_borrow_mut(|race| {
                if let Some(race) = race {
                    let attempt = if purge {
                        &mut race.attempts.purge
                    } else {
                        &mut race.attempts.incident
                    };
                    if attempt.is_none() {
                        *attempt = Some(race.writer.execute(
                            "UPDATE rooms SET name=name||' renamed' WHERE id='concurrent-room'",
                            [],
                        ));
                    }
                }
            });
        }
        0
    }
}

async fn delete_during_unrelated_write(last_member: bool) {
    let (home, app) = fixture().await;
    let (room, failure) = failed_room(&app).await;
    let stored = failure["section_id"].as_str().unwrap();
    let id = failure["incident"]["id"].as_str().unwrap();
    let conn = db::open(home.path()).unwrap();
    conn.execute(
        "INSERT INTO rooms(id,name,owner_id) VALUES('concurrent-room','Other','local')",
        [],
    )
    .unwrap();
    // Exercise legacy attribution's reads as well as native descendant cleanup.
    conn.execute("UPDATE bot_incidents SET room_id=NULL WHERE id=?", [id])
        .unwrap();
    let native = hexbot_core::runtime_store::open(home.path()).unwrap();
    native.execute("INSERT INTO native_sessions(stored_id,owner,bot,prompt,options) VALUES('child','local','owl','',?)", [json!({"parent_session":stored}).to_string()]).unwrap();
    hexbot_core::runtime_store::append(
        home.path(),
        "child",
        json!({"role":"user","text":"Child history"}),
    )
    .unwrap();
    for session in [stored, "child"] {
        assert!(
            !hexbot_core::runtime_store::history(home.path(), session)
                .unwrap()
                .is_empty()
        );
        let dir = hexbot_core::runtime_store::session_dir(home.path(), session).unwrap();
        fs::write(dir.join("cleanup-fixture"), "fixture").unwrap();
    }
    let race = deletion_write_race::Guard::start(db::open(home.path()).unwrap());
    let method = if last_member {
        "hexbot.rooms.remove_member"
    } else {
        "hexbot.rooms.delete"
    };
    let result = app
        .call("local", method, &json!({"id":room,"bot":"owl"}))
        .await;
    let attempts = race.finish();
    assert!(result.is_ok(), "{method}: {result:?}");
    for (stage, attempt) in [
        ("transcript purge", attempts.purge),
        ("incident retirement", attempts.incident),
    ] {
        assert!(
            matches!(attempt, Some(Err(rusqlite::Error::SqliteFailure(error, _))) if error.code == rusqlite::ErrorCode::DatabaseBusy),
            "room deletion must reserve the metadata write before {stage}: {attempt:?}"
        );
    }
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM rooms WHERE id=?", [&room], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(incident(&conn, id).0.as_deref(), Some(room.as_str()));
    assert!(incident(&conn, id).1.is_some());
    for session in [stored, "child"] {
        assert!(
            hexbot_core::runtime_store::history(home.path(), session)
                .unwrap()
                .is_empty()
        );
        assert!(
            native
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM native_deleted WHERE session_id=?)",
                    [session],
                    |r| r.get::<_, bool>(0)
                )
                .unwrap()
        );
        assert!(!home.path().join("runtime/sessions").join(session).exists());
    }
    // The competing operation can proceed as soon as deletion commits.
    assert_eq!(
        conn.execute(
            "UPDATE rooms SET name='Renamed' WHERE id='concurrent-room'",
            []
        )
        .unwrap(),
        1
    );
    app.shutdown().await;
}

#[tokio::test]
async fn explicit_room_deletion_reserves_write_before_purge_and_incident_reads() {
    delete_during_unrelated_write(false).await;
}

#[tokio::test]
async fn last_member_removal_reserves_write_before_purge_and_incident_reads() {
    delete_during_unrelated_write(true).await;
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
    for action in ["archive", "failed-delete", "failed-last-remove"] {
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
            // The catalog rolled back, so the surviving room keeps its history.
            let stored = failure["section_id"].as_str().unwrap();
            assert!(
                !hexbot_core::runtime_store::history(home.path(), stored)
                    .unwrap()
                    .is_empty(),
                "{action}"
            );
        }
        app.shutdown().await;
    }
}

#[tokio::test]
async fn a_bot_removed_from_a_surviving_room_shows_its_room_failure_only_while_a_member() {
    for legacy in [false, true] {
        let (home, app) = fixture().await;
        let (room, failure) = failed_room(&app).await;
        let id = failure["incident"]["id"].as_str().unwrap();
        let conn = db::open(home.path()).unwrap();
        if legacy {
            // Older failures find their room through the stored transcript.
            conn.execute("UPDATE bot_incidents SET room_id=NULL WHERE id=?", [id])
                .unwrap();
        }
        let member = |action: &'static str, bot: &'static str| {
            let (app, room) = (app.clone(), room.clone());
            async move {
                let mut events = app.events.subscribe();
                // A client cannot mark a surviving room deleted.
                let result = app
                    .call(
                        "local",
                        &format!("hexbot.rooms.{action}"),
                        &json!({"id":room,"bot":bot,"deleted":true}),
                    )
                    .await
                    .unwrap();
                assert_ne!(result["room"]["deleted"], true);
                let emitted = notifications(&mut events);
                assert!(
                    emitted
                        .iter()
                        .any(|e| e.frame["params"]["type"] == "hexbot.bots.changed"),
                    "{action} {bot}"
                );
                let changed = emitted
                    .iter()
                    .find(|e| e.frame["params"]["type"] == "hexbot.rooms.changed")
                    .unwrap();
                assert_ne!(changed.frame["params"]["payload"]["deleted"], true);
            }
        };
        member("add_member", "fox").await;
        member("remove_member", "owl").await;
        for bot in bots(&app, "owl").await {
            assert_eq!(bot["status"], "idle", "legacy={legacy}");
        }
        assert!(incident(&conn, id).1.is_none());
        member("add_member", "owl").await;
        for bot in bots(&app, "owl").await {
            assert_eq!(bot["status"], "stopped", "legacy={legacy}");
            assert_eq!(bot["status_detail"]["room_id"], room);
            assert_eq!(bot["status_detail"]["action"]["kind"], "retry");
        }
        app.shutdown().await;
    }
}
