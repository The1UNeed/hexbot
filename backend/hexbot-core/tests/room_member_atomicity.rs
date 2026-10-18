//! Exercise membership decisions at real SQLite boundaries through the public
//! App. The hook is confined to this test binary and each fixture's catalog.
use hexbot_core::{Result, db, rooms, runtime_store as store, server::App, settings};
use rusqlite::ffi;
use serde_json::{Value, json};
use std::{
    cell::Cell,
    ffi::{CStr, c_int, c_void},
    io::{Read, Write},
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

mod support;

static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static PAUSE: Mutex<Option<Pause>> = Mutex::new(None);
thread_local! {
    static JOIN_BUSY: Cell<Option<SocketAddr>> = const { Cell::new(None) };
}

struct Pause {
    database: PathBuf,
    address: SocketAddr,
    before_decision: bool,
    removed: bool,
    snapshots: usize,
}

unsafe extern "C" fn install_trace(
    db: *mut ffi::sqlite3,
    _: *mut *mut std::ffi::c_char,
    _: *const ffi::sqlite3_api_routines,
) -> c_int {
    unsafe { ffi::sqlite3_trace_v2(db, ffi::SQLITE_TRACE_STMT, Some(trace), db.cast()) }
}

// Never panic across SQLite's C boundary. A broken barrier makes the surrounding
// test fail its ordinary assertions or bounded event wait instead.
fn signal(address: SocketAddr, tag: &[u8]) -> bool {
    (|| -> std::io::Result<()> {
        let mut stream = std::net::TcpStream::connect(address)?;
        stream.set_read_timeout(Some(Duration::from_secs(10)))?;
        stream.write_all(tag)?;
        stream.read_exact(&mut [0])
    })()
    .is_ok()
}

unsafe extern "C" fn join_busy(_: *mut c_void, _: c_int) -> c_int {
    JOIN_BUSY
        .with(|address| address.take())
        .is_some_and(|address| signal(address, b"blocked\n")) as c_int
}

unsafe extern "C" fn trace(
    _: u32,
    db: *mut c_void,
    statement: *mut c_void,
    _: *mut c_void,
) -> c_int {
    let sql = unsafe { ffi::sqlite3_sql(statement.cast()) };
    if sql.is_null() {
        return 0;
    }
    let sql = unsafe { CStr::from_ptr(sql) }.to_bytes();
    // Install after db::open's busy_timeout, only on the joining thread's actual
    // write. This proves lock contention rather than inferring it from timing.
    if JOIN_BUSY.with(|address| address.get().is_some())
        && (sql == b"BEGIN IMMEDIATE" || sql.starts_with(b"INSERT INTO room_members"))
    {
        unsafe { ffi::sqlite3_busy_handler(db.cast(), Some(join_busy), std::ptr::null_mut()) };
    }
    let address = {
        let mut pause = PAUSE.lock().unwrap();
        let Some(p) = pause.as_mut() else { return 0 };
        let file = unsafe { ffi::sqlite3_db_filename(db.cast(), c"main".as_ptr()) };
        if file.is_null()
            || Path::new(unsafe { CStr::from_ptr(file) }.to_str().unwrap()) != p.database
        {
            return 0;
        }
        let update = sql.starts_with(b"UPDATE room_members SET left_at=?");
        if update {
            p.removed = true;
        }
        if p.removed && sql.starts_with(b"SELECT t.bot,s.live_session_id FROM room_turns") {
            p.snapshots += 1;
        }
        let hit = if p.before_decision {
            // Old code starts at UPDATE; fixed code reserves BEGIN first.
            sql == b"BEGIN IMMEDIATE" || update
        } else {
            // After append's ownership read and the final membership snapshot.
            p.snapshots == 2
        };
        if !hit {
            return 0;
        }
        pause.take().unwrap().address
    };
    signal(address, b"removal\n");
    0
}

struct Trace;
impl Trace {
    fn arm(home: &Path, listener: &tokio::net::TcpListener, before_decision: bool) -> Self {
        *PAUSE.lock().unwrap() = Some(Pause {
            database: std::fs::canonicalize(home).unwrap().join("hexbot.db"),
            address: listener.local_addr().unwrap(),
            before_decision,
            removed: false,
            snapshots: 0,
        });
        assert_eq!(
            unsafe { ffi::sqlite3_auto_extension(Some(install_trace)) },
            ffi::SQLITE_OK
        );
        Self
    }
}
impl Drop for Trace {
    fn drop(&mut self) {
        PAUSE.lock().unwrap().take();
        unsafe { ffi::sqlite3_cancel_auto_extension(Some(install_trace)) };
    }
}

async fn barrier(listener: &tokio::net::TcpListener, tag: &[u8]) -> tokio::net::TcpStream {
    tokio::time::timeout(Duration::from_secs(10), async {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut bytes = vec![0; tag.len()];
        stream.read_exact(&mut bytes).await.unwrap();
        assert_eq!(bytes, tag);
        stream
    })
    .await
    .unwrap()
}

struct Fixture {
    home: support::TestHome,
    app: Arc<App>,
    incident: Value,
}
impl Fixture {
    fn new(two_members: bool) -> Self {
        let home = support::TestHome::new();
        let h = home.path();
        let app = App::new(
            h.into(),
            "127.0.0.1:0".parse().unwrap(),
            "/usr/bin/false".into(),
            None,
        )
        .unwrap();
        let conn = db::open(h).unwrap();
        conn.execute_batch("INSERT INTO bots(name,owner_id,description) VALUES('owl','local','Manual fixture'),('fox','local','Manual fixture'),('lynx','local','Manual fixture');
            INSERT INTO rooms(id,name,owner_id,main_bot) VALUES('room','Room','local','owl');
            INSERT INTO room_members(room_id,member_kind,member_id,added_by,added_at) VALUES('room','bot','owl','local',0);
            INSERT INTO room_sessions(room_id,bot,stored_session_id) VALUES('room','owl','stored');").unwrap();
        if two_members {
            conn.execute_batch("INSERT INTO room_members(room_id,member_kind,member_id,added_by,added_at) VALUES('room','bot','fox','local',1);").unwrap();
        }
        store::open(h).unwrap().execute("INSERT INTO native_sessions(stored_id,owner,bot,prompt) VALUES('stored','local','owl','')", []).unwrap();
        store::append(h, "stored", json!({"role":"user","text":"KEEP HISTORY"})).unwrap();
        rooms::append(
            h,
            "local",
            "room",
            "message.user",
            "human",
            Some("local"),
            json!({"text":"KEEP ROOM EVENT"}),
        )
        .unwrap();
        let incident = settings::record_incident(
            h,
            "owl",
            "turn_failed",
            "Fixture failure",
            &json!({"section_id":"stored","room_id":"room"}),
        )
        .unwrap();
        Self {
            home,
            app,
            incident,
        }
    }
    fn active(&self) -> Vec<String> {
        let conn = db::open(self.home.path()).unwrap();
        conn.prepare("SELECT member_id FROM room_members WHERE room_id='room' AND member_kind='bot' AND left_at IS NULL ORDER BY member_id").unwrap()
            .query_map([], |r| r.get(0)).unwrap().collect::<std::result::Result<_, _>>().unwrap()
    }
    fn resolved(&self) -> bool {
        db::open(self.home.path())
            .unwrap()
            .query_row(
                "SELECT resolved_at IS NOT NULL FROM bot_incidents WHERE id=?",
                [self.incident["id"].as_str().unwrap()],
                |r| r.get(0),
            )
            .unwrap()
    }
    fn remove(&self, bot: &str) -> tokio::task::JoinHandle<Result<Value>> {
        let (app, bot) = (self.app.clone(), bot.to_owned());
        tokio::spawn(async move {
            app.call(
                "local",
                "hexbot.rooms.remove_member",
                &json!({"id":"room","bot":bot}),
            )
            .await
        })
    }
    fn join(
        &self,
        bot: &str,
        busy: SocketAddr,
    ) -> (
        tokio::sync::oneshot::Receiver<Result<Value>>,
        std::thread::JoinHandle<()>,
    ) {
        let (app, bot, handle) = (
            self.app.clone(),
            bot.to_owned(),
            tokio::runtime::Handle::current(),
        );
        let (send, recv) = tokio::sync::oneshot::channel();
        let thread = std::thread::spawn(move || {
            JOIN_BUSY.with(|address| address.set(Some(busy)));
            let result = handle.block_on(app.call(
                "local",
                "hexbot.rooms.add_member",
                &json!({"id":"room","bot":bot}),
            ));
            JOIN_BUSY.with(|address| address.take());
            let _ = send.send(result);
        });
        (recv, thread)
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn join_committed_before_removal_decision_keeps_room_history_and_incident() {
    let _serial = SERIAL.lock().await;
    let f = Fixture::new(false);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let trace = Trace::arm(f.home.path(), &listener, true);
    let removing = f.remove("owl");
    let mut held = barrier(&listener, b"removal\n").await;
    let joined = f
        .app
        .call(
            "local",
            "hexbot.rooms.add_member",
            &json!({"id":"room","bot":"fox"}),
        )
        .await
        .unwrap();
    held.write_all(&[1]).await.unwrap();
    let removed = removing.await.unwrap().unwrap();
    drop(trace);
    assert_ne!(joined["room"]["deleted"], true);
    assert_ne!(removed["room"]["deleted"], true);
    assert!(removed["room"]["main_bot"].is_null());
    assert_eq!(f.active(), ["fox"]);
    assert!(!store::history(f.home.path(), "stored").unwrap().is_empty());
    assert!(!f.resolved());
    let log = rooms::log(f.home.path(), "local", "room", 0, None, 100).unwrap();
    assert_eq!(
        log.iter()
            .map(|e| (e["seq"].as_i64().unwrap(), e["kind"].as_str().unwrap()))
            .collect::<Vec<_>>(),
        [(1, "message.user"), (2, "member.added"), (3, "member.left")]
    );
    println!("join first: accepted fox, room/history/incident retained, event sequences 1/2/3");
    f.app.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn join_at_final_member_snapshot_waits_and_reports_room_not_found() {
    let _serial = SERIAL.lock().await;
    // A new member and a rejoining last member must obey the same decision.
    for bot in ["fox", "owl"] {
        let f = Fixture::new(false);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let busy = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let trace = Trace::arm(f.home.path(), &listener, false);
        let removing = f.remove("owl");
        let mut held = barrier(&listener, b"removal\n").await;
        let (mut joining, thread) = f.join(bot, busy.local_addr().unwrap());
        // Old code accepts here because the snapshot and deletion have separate
        // transactions. Always release and observe the actual deletion before
        // asserting, so the red control records the lost accepted join.
        let mut blocked = None;
        let early = tokio::select! {
            result = &mut joining => Some(result.unwrap()),
            stream = barrier(&busy, b"blocked\n") => { blocked = Some(stream); None }
        };
        held.write_all(&[1]).await.unwrap();
        let removed = removing.await.unwrap().unwrap();
        if let Some(stream) = blocked.as_mut() {
            stream.write_all(&[1]).await.unwrap();
        }
        let joined = match early {
            Some(result) => result,
            None => joining.await.unwrap(),
        };
        thread.join().unwrap();
        drop(trace);
        println!(
            "snapshot race {bot}: removal={removed:?}; join={joined:?}; actual writer contention={}",
            blocked.is_some()
        );
        assert_eq!(removed["room"]["deleted"], true);
        assert_eq!(
            rooms::get(f.home.path(), "local", "room").unwrap_err().code,
            4230
        );
        assert!(store::history(f.home.path(), "stored").unwrap().is_empty());
        assert!(f.resolved());
        f.app.shutdown().await;
        assert_eq!(
            joined.unwrap_err().code,
            4230,
            "a losing join must honestly report room not found"
        );
        assert!(
            blocked.is_some(),
            "join must contend on the removal's catalog writer"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn concurrent_member_removals_and_join_have_one_catalog_order() {
    let _serial = SERIAL.lock().await;
    let f = Fixture::new(true);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let busy = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let trace = Trace::arm(f.home.path(), &listener, false);
    let first = f.remove("owl");
    let mut held = barrier(&listener, b"removal\n").await;
    let last = f.remove("fox");
    let (mut joining, thread) = f.join("lynx", busy.local_addr().unwrap());
    let mut blocked = None;
    let early = tokio::select! {
        result = &mut joining => Some(result.unwrap()),
        stream = barrier(&busy, b"blocked\n") => { blocked = Some(stream); None }
    };
    held.write_all(&[1]).await.unwrap();
    let first = first.await.unwrap().unwrap();
    let last = last.await.unwrap().unwrap();
    if let Some(stream) = blocked.as_mut() {
        stream.write_all(&[1]).await.unwrap();
    }
    let joined = match early {
        Some(result) => result,
        None => joining.await.unwrap(),
    };
    thread.join().unwrap();
    drop(trace);
    assert_ne!(first["room"]["deleted"], true);
    match joined {
        Ok(joined) => {
            assert_ne!(joined["room"]["deleted"], true);
            assert_ne!(last["room"]["deleted"], true);
            assert_eq!(f.active(), ["lynx"]);
            assert!(!store::history(f.home.path(), "stored").unwrap().is_empty());
            assert!(!f.resolved());
        }
        Err(error) => {
            assert_eq!(error.code, 4230);
            assert_eq!(last["room"]["deleted"], true);
            assert_eq!(
                rooms::get(f.home.path(), "local", "room").unwrap_err().code,
                4230
            );
            assert!(store::history(f.home.path(), "stored").unwrap().is_empty());
            assert!(f.resolved());
        }
    }
    println!(
        "two removals and a join completed with one catalog order; contention={}",
        blocked.is_some()
    );
    f.app.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn direct_nonlast_removal_serializes_join_and_keeps_other_members() {
    let _serial = SERIAL.lock().await;
    let f = Fixture::new(true);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let busy = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let trace = Trace::arm(f.home.path(), &listener, false);
    let home = f.home.path().to_owned();
    let removing =
        tokio::task::spawn_blocking(move || rooms::remove_bot(&home, "local", "room", "owl"));
    let mut held = barrier(&listener, b"removal\n").await;
    let (mut joining, thread) = f.join("lynx", busy.local_addr().unwrap());
    let mut blocked = None;
    let early = tokio::select! {
        result = &mut joining => Some(result.unwrap()),
        stream = barrier(&busy, b"blocked\n") => { blocked = Some(stream); None }
    };
    held.write_all(&[1]).await.unwrap();
    let removed = removing.await.unwrap().unwrap();
    if let Some(stream) = blocked.as_mut() {
        stream.write_all(&[1]).await.unwrap();
    }
    let joined = match early {
        Some(result) => result,
        None => joining.await.unwrap(),
    }
    .unwrap();
    thread.join().unwrap();
    drop(trace);
    assert_ne!(removed["room"]["deleted"], true);
    assert_eq!(removed["event"]["kind"], "member.left");
    assert_eq!(removed["event"]["actor_kind"], "human");
    assert_eq!(removed["event"]["actor_id"], "local");
    assert_eq!(removed["event"]["payload"], json!({"bot":"owl"}));
    assert!(removed["room"]["main_bot"].is_null());
    assert!(
        joined["room"]["members"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["member_id"] == "lynx" && m["left_at"].is_null())
    );
    assert_eq!(f.active(), ["fox", "lynx"]);
    assert!(!store::history(f.home.path(), "stored").unwrap().is_empty());
    assert!(!f.resolved());
    let log = rooms::log(f.home.path(), "local", "room", 0, None, 100).unwrap();
    assert_eq!(
        log.iter()
            .map(|e| (e["seq"].as_i64().unwrap(), e["kind"].as_str().unwrap()))
            .collect::<Vec<_>>(),
        [(1, "message.user"), (2, "member.left"), (3, "member.added")]
    );
    println!(
        "direct nonlast removal: only owl removed, queued lynx accepted, fox/history/incident retained"
    );
    f.app.shutdown().await;
    assert!(
        blocked.is_some(),
        "join must contend on the direct removal's catalog writer"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn member_event_failure_and_owner_checks_leave_membership_unchanged() {
    let _serial = SERIAL.lock().await;
    for kind in ["member.left", "member.added"] {
        let f = Fixture::new(false);
        let conn = db::open(f.home.path()).unwrap();
        conn.execute_batch("INSERT INTO users(id,display_name,role,created_at) VALUES('other','Other','member',0);").unwrap();
        assert_eq!(
            rooms::remove_bot(f.home.path(), "other", "room", "owl")
                .unwrap_err()
                .code,
            4302
        );
        assert_eq!(f.active(), ["owl"]);
        assert_eq!(
            rooms::remove_bot(f.home.path(), "local", "room", "missing")
                .unwrap_err()
                .code,
            4232
        );
        conn.execute_batch(&format!("CREATE TRIGGER refuse_member_event BEFORE INSERT ON room_events WHEN NEW.kind='{kind}' BEGIN SELECT RAISE(ABORT,'controlled member event fault'); END;")).unwrap();
        let result = if kind == "member.left" {
            f.remove("owl").await.unwrap()
        } else {
            f.app
                .call(
                    "local",
                    "hexbot.rooms.add_member",
                    &json!({"id":"room","bot":"fox"}),
                )
                .await
        };
        assert!(
            result
                .unwrap_err()
                .message
                .contains("controlled member event fault")
        );
        assert_eq!(f.active(), ["owl"]);
        assert_eq!(
            rooms::log(f.home.path(), "local", "room", 0, None, 100)
                .unwrap()
                .len(),
            1
        );
        assert!(!store::history(f.home.path(), "stored").unwrap().is_empty());
        assert!(!f.resolved());
        println!(
            "{kind} fault: membership/event/history/incident unchanged; owner and missing-member checks retained"
        );
        f.app.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn catalog_failure_rolls_back_member_event_and_incident_in_public_and_direct_removal() {
    let _serial = SERIAL.lock().await;
    for direct in [false, true] {
        let f = Fixture::new(false);
        let mut events = f.app.events.subscribe();
        let conn = db::open(f.home.path()).unwrap();
        conn.execute_batch("CREATE TRIGGER refuse_room_delete BEFORE DELETE ON rooms BEGIN SELECT RAISE(ABORT,'controlled room delete fault'); END;").unwrap();
        let result = if direct {
            rooms::remove_bot(f.home.path(), "local", "room", "owl")
        } else {
            f.remove("owl").await.unwrap()
        };
        assert!(
            result
                .unwrap_err()
                .message
                .contains("controlled room delete fault")
        );
        assert_eq!(f.active(), ["owl"]);
        assert_eq!(
            rooms::get(f.home.path(), "local", "room").unwrap()["main_bot"],
            "owl"
        );
        assert_eq!(
            rooms::log(f.home.path(), "local", "room", 0, None, 100)
                .unwrap()
                .len(),
            1
        );
        assert!(!f.resolved());
        while let Ok(event) = events.try_recv() {
            assert_ne!(
                event.frame["params"]["payload"]["event"]["kind"],
                "member.left"
            );
        }
        // Retain the inherited cross-store negative control. Catalog rollback
        // cannot undo native file/history purge; future retention policy owns it.
        assert!(store::history(f.home.path(), "stored").unwrap().is_empty());
        conn.execute_batch("DROP TRIGGER refuse_room_delete;")
            .unwrap();
        let removed = rooms::remove_bot(f.home.path(), "local", "room", "owl").unwrap();
        assert_eq!(removed["room"]["deleted"], true);
        assert_eq!(removed["event"]["seq"], 2);
        assert!(f.resolved());
        println!(
            "catalog fault direct={direct}: membership/event/incident rolled back; inherited native history loss retained; retry succeeds"
        );
        f.app.shutdown().await;
    }
}
