//! A post admitted before member removal must finish saving and scheduling with
//! that admission. Later posts must still be refused while removal is queued.
use hexbot_core::{catalog, db, rooms, server::App};
use rusqlite::ffi;
use serde_json::json;
use std::{fs, path::Path, sync::Arc, time::Duration};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

mod support;

static BARRIER: std::sync::Mutex<Option<(std::path::PathBuf, std::net::SocketAddr)>> =
    std::sync::Mutex::new(None);
unsafe extern "C" fn trace_connection(
    db: *mut ffi::sqlite3,
    _: *mut *mut std::ffi::c_char,
    _: *const ffi::sqlite3_api_routines,
) -> std::ffi::c_int {
    unsafe { ffi::sqlite3_trace_v2(db, ffi::SQLITE_TRACE_STMT, Some(trace_stmt), db.cast()) }
}
unsafe extern "C" fn trace_stmt(
    _: u32,
    context: *mut std::ffi::c_void,
    statement: *mut std::ffi::c_void,
    _: *mut std::ffi::c_void,
) -> std::ffi::c_int {
    use std::{
        ffi::CStr,
        io::{Read, Write},
    };
    let Some((database, address)) = BARRIER.lock().unwrap().clone() else {
        return 0;
    };
    let file = unsafe { ffi::sqlite3_db_filename(context.cast(), c"main".as_ptr()) };
    if file.is_null() || Path::new(unsafe { CStr::from_ptr(file) }.to_str().unwrap()) != database {
        return 0;
    }
    let sql = unsafe { ffi::sqlite3_expanded_sql(statement.cast()) };
    if sql.is_null() {
        return 0;
    }
    let text = unsafe { CStr::from_ptr(sql) }
        .to_string_lossy()
        .into_owned();
    unsafe { ffi::sqlite3_free(sql.cast()) };
    if text.starts_with("INSERT INTO room_events(") && text.contains("Hello during removal") {
        BARRIER.lock().unwrap().take();
        if let Ok(mut stream) = std::net::TcpStream::connect(address) {
            let _ = stream.write_all(b"insert!\n");
            let _ = stream.read_exact(&mut [0]);
        }
    }
    0
}

const PI: &str = r#"#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path');
const home=__dirname,stored=process.env.HEXBOT_SESSION_CONFIG?path.basename(path.dirname(process.env.HEXBOT_SESSION_CONFIG)):'description';
const emit=v=>process.stdout.write(JSON.stringify(v)+'\n');
fs.appendFileSync(path.join(home,'processes.jsonl'),JSON.stringify({pid:process.pid,stored})+'\n');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const c=JSON.parse(line);if(c.type==='extension_ui_response')return;
 emit({type:'response',id:c.id,command:c.type,success:true,data:['prompt','steer'].includes(c.type)?{disposition:'started'}:{}});
 if(c.type==='prompt'){emit({type:'agent_start'});emit({type:'message_end',message:{role:'user',content:c.message}});emit({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'done'}]}});emit({type:'agent_settled'});}
});
process.on('SIGTERM',()=>process.exit(0));
"#;

async fn complete_turn(
    app: &App,
    room: &str,
    events: &mut tokio::sync::broadcast::Receiver<hexbot_core::events::Event>,
) {
    let _ = app;
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let frame = events.recv().await.unwrap().frame;
            if frame["params"]["type"] == "hexbot.rooms.turn"
                && frame["params"]["payload"]["room_id"] == room
                && frame["params"]["payload"]["status"] == "complete"
            {
                break;
            }
        }
    })
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn admitted_room_post_succeeds_when_member_removal_queues() {
    let home = support::TestHome::new();
    let h = home.path();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let pi = h.join("pi.cjs");
    fs::write(&pi, PI).unwrap();
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&pi, fs::Permissions::from_mode(0o755)).unwrap();
    }
    let app: Arc<App> = App::new(h.into(), "127.0.0.1:0".parse().unwrap(), pi, None).unwrap();
    for bot in ["owl", "fox"] {
        catalog::call(
            h,
            "local",
            "hexbot.bots.create",
            &json!({"name":bot,"description":"Fixture"}),
        )
        .unwrap()
        .unwrap();
        fs::write(
            h.join(format!("profiles/{bot}/config.yaml")),
            "model:\n  provider: openai\n  default: fixture\ntools:\n  enabled_toolsets: []\n",
        )
        .unwrap();
    }
    db::open(h)
        .unwrap()
        .execute(
            "INSERT OR REPLACE INTO settings VALUES('workspace_dir',?)",
            [json!(home.workspace()).to_string()],
        )
        .unwrap();
    let room = rooms::call(
        h,
        "local",
        "hexbot.rooms.create",
        &json!({"name":"Race","members":["owl","fox"],"main_bot":"fox"}),
    )
    .unwrap()
    .unwrap()["room"]["id"]
        .as_str()
        .unwrap()
        .to_owned();

    // Positive control: without a concurrent removal the same post succeeds and gets a turn.
    let mut events = app.events.subscribe();
    app.call(
        "local",
        "hexbot.rooms.send",
        &json!({"id":room,"text":"Control post"}),
    )
    .await
    .unwrap();
    complete_turn(&app, &room, &mut events).await;
    println!("control: post ok and its turn completed");

    *BARRIER.lock().unwrap() = Some((
        fs::canonicalize(h).unwrap().join("hexbot.db"),
        listener.local_addr().unwrap(),
    ));
    assert_eq!(
        unsafe { ffi::sqlite3_auto_extension(Some(trace_connection)) },
        ffi::SQLITE_OK
    );
    let sender = {
        let (app, room) = (app.clone(), room.clone());
        tokio::spawn(async move {
            app.call(
                "local",
                "hexbot.rooms.send",
                &json!({"id":room,"text":"Hello during removal"}),
            )
            .await
        })
    };
    // The post has passed admission and is at its actual INSERT.
    let (mut held, _) = tokio::time::timeout(Duration::from_secs(10), listener.accept())
        .await
        .unwrap()
        .unwrap();
    let mut tag = [0; 8];
    held.read_exact(&mut tag).await.unwrap();
    assert_eq!(&tag, b"insert!\n");
    let remover = {
        let (app, room) = (app.clone(), room.clone());
        tokio::spawn(async move {
            app.call(
                "local",
                "hexbot.rooms.remove_member",
                &json!({"id":room,"bot":"owl"}),
            )
            .await
        })
    };
    // RPC barrier: a text-less post enters room admission before validation and
    // stores nothing. It reports 4211 only once the removal writer is queued.
    let mut probes = 0;
    loop {
        probes += 1;
        assert!(probes < 100_000, "removal never queued");
        let probe = app
            .call("local", "hexbot.rooms.send", &json!({"id":room}))
            .await
            .unwrap_err();
        if probe.code == 4211 {
            break;
        }
        tokio::task::yield_now().await;
    }
    println!("removal writer queued after {probes} admission probes");
    let refused = app
        .call(
            "local",
            "hexbot.rooms.send",
            &json!({"id":room,"text":"Refused after removal queued"}),
        )
        .await;
    held.write_all(&[1]).await.unwrap();
    let sent = sender.await.unwrap();
    let removed = remover.await.unwrap();
    unsafe {
        ffi::sqlite3_cancel_auto_extension(Some(trace_connection));
    }
    println!("send result: {sent:?}");
    println!("remove result ok: {}", removed.is_ok());
    let conn = db::open(h).unwrap();
    let stored: Vec<i64> = conn.prepare("SELECT seq FROM room_events WHERE room_id=? AND kind='message.user' AND json_extract(payload_json,'$.text')='Hello during removal'").unwrap()
        .query_map([&room], |r| r.get(0)).unwrap().collect::<Result<_, _>>().unwrap();
    let turns: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM room_turns WHERE room_id=? AND trigger_seq=?",
            rusqlite::params![room, stored[0]],
            |r| r.get(0),
        )
        .unwrap();
    println!("stored seqs for the failed post: {stored:?}; turns for it: {turns}");
    let refused_stored: i64 = conn.query_row("SELECT COUNT(*) FROM room_events WHERE room_id=? AND kind='message.user' AND json_extract(payload_json,'$.text')='Refused after removal queued'", [&room], |r| r.get(0)).unwrap();
    let active: Vec<String> = conn.prepare("SELECT member_id FROM room_members WHERE room_id=? AND member_kind='bot' AND left_at IS NULL ORDER BY member_id").unwrap()
        .query_map([&room], |r| r.get(0)).unwrap().collect::<Result<_, _>>().unwrap();
    app.shutdown().await;
    assert!(
        sent.is_ok(),
        "an admitted saved post must succeed: {sent:?}"
    );
    assert_eq!(
        stored.len(),
        1,
        "the admitted post must be saved exactly once"
    );
    assert_eq!(sent.unwrap()["event"]["seq"].as_i64(), Some(stored[0]));
    assert_eq!(refused.unwrap_err().code, 4211);
    assert_eq!(refused_stored, 0, "a refused later post must not be saved");
    assert!(removed.is_ok(), "{removed:?}");
    assert_eq!(
        active,
        ["fox"],
        "non-last removal must preserve the other bot"
    );
}
