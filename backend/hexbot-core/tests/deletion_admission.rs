use hexbot_core::{catalog, db, rooms, runtime_store as store, server::App};
use rusqlite::ffi;
use serde_json::{Value, json};
use std::{fs, path::Path, sync::Arc, time::Duration};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

mod support;

struct Fixture {
    home: support::TestHome,
    app: Arc<App>,
    listener: tokio::net::TcpListener,
    room: String,
}
impl Fixture {
    async fn new(last: bool) -> Self {
        let home = support::TestHome::new();
        let h = home.path();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let pi = h.join("pi.cjs");
        fs::write(&pi, r#"#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),net=require('node:net');
const home=__dirname,stored=process.env.HEXBOT_SESSION_CONFIG?path.basename(path.dirname(process.env.HEXBOT_SESSION_CONFIG)):'description';
const emit=v=>process.stdout.write(JSON.stringify(v)+'\n');
const finish=()=>{emit({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'done'}]}});emit({type:'agent_settled'});};
fs.appendFileSync(path.join(home,'processes.jsonl'),JSON.stringify({pid:process.pid,stored})+'\n');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const c=JSON.parse(line);if(c.type==='extension_ui_response'){if(c.id==='ask-owl'){fs.appendFileSync(path.join(home,'tool-responses.jsonl'),JSON.stringify(c)+'\n');finish();}return;}
 const reply=()=>{emit({type:'response',id:c.id,command:c.type,success:true,data:['prompt','steer'].includes(c.type)?{disposition:'started'}:{}});
 if(c.type==='prompt'){emit({type:'agent_start'});emit({type:'message_end',message:{role:'user',content:c.message}});if(stored==='sender'&&c.message.includes('ask-owl'))emit({type:'extension_ui_request',id:'ask-owl',method:'input',title:'__HEXBOT_TOOL__'+JSON.stringify({name:'message_bot',args:{to:'owl',text:'help',wait:true}})});else if(fs.existsSync(path.join(home,'hold-turn'))&&stored==='opening'){const s=net.connect(__PORT__,'127.0.0.1',()=>s.write('working\n'));s.once('data',()=>{finish();s.end();});}else finish();}};
 if(c.type==='prompt'&&stored==='description'&&fs.existsSync(path.join(home,'hold-description'))){const s=net.connect(__PORT__,'127.0.0.1',()=>s.write('one-shot'));s.once('data',()=>{reply();s.end();});}else if(c.type==='get_state'&&fs.existsSync(path.join(home,'hold-opening'))&&!fs.existsSync(path.join(home,'opening-held'))){fs.writeFileSync(path.join(home,'opening-held'),stored);const s=net.connect(__PORT__,'127.0.0.1',()=>s.write('opening\n'));s.once('data',()=>{reply();s.end();});}else reply();
});
process.on('SIGTERM',()=>{const marker=path.join(home,'stopped-once');if(fs.existsSync(marker))process.exit(0);fs.writeFileSync(marker,'yes');const s=net.connect(__PORT__,'127.0.0.1',()=>s.write('closing\n'));s.on('data',()=>process.exit(0));});
"#.replace("__PORT__", &listener.local_addr().unwrap().port().to_string())).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&pi, fs::Permissions::from_mode(0o755)).unwrap();
        }
        let app = App::new(h.into(), "127.0.0.1:0".parse().unwrap(), pi, None).unwrap();
        for bot in ["owl", "fox", "hare"] {
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
        let room = rooms::call(h, "local", "hexbot.rooms.create", &json!({"name":"Race","members":if last {vec!["owl"]} else {vec!["owl","fox"]},"main_bot":if last {"owl"} else {"fox"}})).unwrap().unwrap()["room"]["id"].as_str().unwrap().to_owned();
        db::open(h)
            .unwrap()
            .execute(
                "INSERT INTO room_sessions(room_id,bot,stored_session_id) VALUES(?,'owl','root')",
                [&room],
            )
            .unwrap();
        Self {
            home,
            app,
            listener,
            room,
        }
    }
    fn h(&self) -> &Path {
        self.home.path()
    }
    async fn barrier(&self, expected: &[u8; 8]) -> tokio::net::TcpStream {
        let (mut stream, _) = tokio::time::timeout(Duration::from_secs(5), self.listener.accept())
            .await
            .unwrap()
            .unwrap();
        let mut message = [0; 8];
        stream.read_exact(&mut message).await.unwrap();
        assert_eq!(&message, expected);
        stream
    }
    fn processes(&self) -> Vec<Value> {
        fs::read_to_string(self.h().join("processes.jsonl"))
            .unwrap_or_default()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }
    fn pid(&self, stored: &str) -> i64 {
        self.processes()
            .iter()
            .find(|p| p["stored"] == stored)
            .unwrap()["pid"]
            .as_i64()
            .unwrap()
    }
    async fn roots(&self) -> (String, String) {
        let root = self
            .app
            .runtime
            .ensure_hidden("local", "owl", "root")
            .await
            .unwrap();
        store::open(self.h()).unwrap().execute("INSERT INTO native_sessions SELECT 'child',owner,bot,prompt,json_set(options,'$.parent_session','root') FROM native_sessions WHERE stored_id='root'", []).unwrap();
        let child = self
            .app
            .runtime
            .ensure_hidden("local", "owl", "child")
            .await
            .unwrap();
        for id in ["root", "child"] {
            store::append(self.h(), id, json!({"role":"user","text":"original"})).unwrap();
            fs::write(
                store::session_dir(self.h(), id)
                    .unwrap()
                    .join("conversation-original.jsonl"),
                "original bytes\n",
            )
            .unwrap();
        }
        (root, child)
    }
    async fn sender(&self) {
        fs::write(self.h().join("profiles/fox/config.yaml"), "model:\n  provider: openai\n  default: fixture\ntools:\n  enabled_toolsets: [hexbot]\n").unwrap();
        self.app
            .runtime
            .ensure_hidden("local", "fox", "sender")
            .await
            .unwrap();
    }
    async fn unrelated(&self) {
        let id = rooms::call(
            self.h(),
            "local",
            "hexbot.rooms.create",
            &json!({"name":"Other","members":["hare"],"main_bot":"hare"}),
        )
        .unwrap()
        .unwrap()["room"]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        self.post(&id, "Keep working").await;
        assert!(
            self.processes()
                .iter()
                .any(|p| p["stored"] != "root" && p["stored"] != "child")
        );
    }
    async fn post(&self, room: &str, text: &str) {
        let mut events = self.app.events.subscribe();
        self.app
            .call(
                "local",
                "hexbot.rooms.send",
                &json!({"id":room,"text":text}),
            )
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
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
    async fn finish(&self) {
        self.app.shutdown().await;
        for p in self.processes() {
            assert!(
                !alive(p["pid"].as_i64().unwrap()),
                "owned test PID survived teardown: {p}"
            );
        }
    }
}
fn alive(pid: i64) -> bool {
    // Only PIDs recorded by this fixture's actual child processes are inspected.
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

#[cfg(unix)]
fn fifo(path: &Path) {
    use std::os::unix::ffi::OsStrExt;
    let path = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
}

// Install only in this test process. The trace fires before SQLite starts
// executing the actual INSERT, without holding either database's writer.
static INSERT_BARRIER: std::sync::Mutex<Option<(std::path::PathBuf, std::net::SocketAddr)>> =
    std::sync::Mutex::new(None);
struct NativeInsertBarrier;
impl NativeInsertBarrier {
    fn new(home: &Path, address: std::net::SocketAddr) -> Self {
        *INSERT_BARRIER.lock().unwrap() = Some((
            fs::canonicalize(home).unwrap().join("hexbot-runtime.db"),
            address,
        ));
        assert_eq!(
            unsafe { ffi::sqlite3_auto_extension(Some(trace_connection)) },
            ffi::SQLITE_OK
        );
        Self
    }
}
impl Drop for NativeInsertBarrier {
    fn drop(&mut self) {
        unsafe {
            ffi::sqlite3_cancel_auto_extension(Some(trace_connection));
        }
        INSERT_BARRIER.lock().unwrap().take();
    }
}
unsafe extern "C" fn trace_connection(
    db: *mut ffi::sqlite3,
    _: *mut *mut std::ffi::c_char,
    _: *const ffi::sqlite3_api_routines,
) -> std::ffi::c_int {
    unsafe { ffi::sqlite3_trace_v2(db, ffi::SQLITE_TRACE_STMT, Some(trace_insert), db.cast()) }
}
unsafe extern "C" fn trace_insert(
    _: u32,
    context: *mut std::ffi::c_void,
    statement: *mut std::ffi::c_void,
    _: *mut std::ffi::c_void,
) -> std::ffi::c_int {
    use std::{
        ffi::CStr,
        io::{Read, Write},
    };
    let target = INSERT_BARRIER.lock().unwrap().clone();
    let Some((database, address)) = target else {
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
    let matches = unsafe { CStr::from_ptr(sql) }.to_bytes().starts_with(
        b"INSERT INTO native_sessions(stored_id,owner,bot,prompt,options) VALUES('before-native',",
    );
    unsafe {
        ffi::sqlite3_free(sql.cast());
    }
    if matches {
        INSERT_BARRIER.lock().unwrap().take();
        if let Ok(mut stream) = std::net::TcpStream::connect(address) {
            let _ = stream.write_all(b"insert!\n");
            let _ = stream.read_exact(&mut [0]);
        }
    }
    0
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn deletion_waits_after_authoritative_owner_check_before_native_insert() {
    let f = Fixture::new(false).await;
    let _trace = NativeInsertBarrier::new(f.h(), f.listener.local_addr().unwrap());
    let a = f.app.clone();
    let opening = tokio::spawn(async move {
        a.runtime
            .ensure_hidden("local", "owl", "before-native")
            .await
    });
    let mut insert = f.barrier(b"insert!\n").await;
    assert_eq!(
        store::open(f.h())
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM native_sessions WHERE stored_id='before-native'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
    let a = f.app.clone();
    let deleting = tokio::spawn(async move {
        a.call("local", "hexbot.bots.delete", &json!({"name":"owl"}))
            .await
    });
    f.unrelated().await;
    let waited = !deleting.is_finished();
    let late = f
        .app
        .runtime
        .ensure_hidden("local", "owl", "late-hidden")
        .await;
    // Release the real INSERT before asserting the contract so a red base
    // run can also close all of its owned processes.
    insert.write_all(b"release").await.unwrap();
    let result = if waited {
        let mut closing = f.barrier(b"closing\n").await;
        closing.write_all(b"release").await.unwrap();
        deleting.await.unwrap()
    } else {
        fs::write(f.h().join("stopped-once"), "release closes").unwrap();
        deleting.await.unwrap()
    };
    let opened = opening.await.unwrap();
    let native: bool = store::open(f.h())
        .unwrap()
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM native_sessions WHERE stored_id='before-native')",
            [],
            |r| r.get(0),
        )
        .unwrap();
    eprintln!(
        "OWNER_WINDOW_OBSERVATION {}",
        json!({"waited":waited,"opened":format!("{opened:?}"),"native_after_delete":native,"bot_after_delete":catalog::bot(f.h(),"local","owl").is_ok(),"processes_before_teardown":f.processes()})
    );
    f.finish().await;
    assert!(
        waited,
        "deletion passed the owner check/native insertion window"
    );
    assert_eq!(late.unwrap_err().code, 4211);
    assert!(opened.is_ok(), "admitted open must drain: {opened:?}");
    assert_eq!(result.unwrap()["deleted"], true);
    assert!(!native);
    assert!(!f.h().join("runtime/sessions/before-native").exists());
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelled_open_retains_admission_until_actual_blocking_recovery_finishes() {
    use std::io::Write;
    let f = Fixture::new(false).await;
    let raw = store::session_dir(f.h(), "recovering")
        .unwrap()
        .join("conversation.jsonl");
    fifo(&raw);
    let a = f.app.clone();
    let opening =
        tokio::spawn(async move { a.runtime.ensure_hidden("local", "owl", "recovering").await });
    let mut writer =
        tokio::task::spawn_blocking(move || fs::OpenOptions::new().write(true).open(raw).unwrap())
            .await
            .unwrap();
    opening.abort();
    assert!(opening.await.unwrap_err().is_cancelled());
    let a = f.app.clone();
    let deleting = tokio::spawn(async move {
        a.call("local", "hexbot.bots.delete", &json!({"name":"owl"}))
            .await
    });
    f.unrelated().await;
    let waited = !deleting.is_finished();
    let late = f
        .app
        .runtime
        .ensure_hidden("local", "owl", "late-hidden")
        .await;
    writer.write_all(b"{\"type\":\"session\",\"version\":3,\"id\":\"recovering\",\"timestamp\":\"2026-10-16T00:00:00Z\",\"cwd\":\"/tmp\"}\n").unwrap();
    drop(writer);
    let result = deleting.await.unwrap();
    f.finish().await;
    assert!(
        waited,
        "caller cancellation released actual recovery admission"
    );
    assert_eq!(late.unwrap_err().code, 4211);
    assert_eq!(result.unwrap()["deleted"], true);
    assert!(f.processes().iter().all(|p| p["stored"] != "recovering"));
    assert!(!f.h().join("runtime/sessions/recovering").exists());
}

#[tokio::test]
async fn final_busy_check_refuses_an_admitted_turn_after_draining_its_open() {
    let f = Fixture::new(false).await;
    fs::write(f.h().join("hold-opening"), "hold registration").unwrap();
    fs::write(f.h().join("hold-turn"), "hold accepted work").unwrap();
    let a = f.app.clone();
    let running = tokio::spawn(async move {
        a.runtime
            .run_hidden("local", "owl", "opening", "work")
            .await
    });
    let mut opening = f.barrier(b"opening\n").await;
    let a = f.app.clone();
    let deleting = tokio::spawn(async move {
        a.call("local", "hexbot.bots.delete", &json!({"name":"owl"}))
            .await
    });
    f.unrelated().await;
    assert!(!deleting.is_finished());
    assert_eq!(
        f.app
            .runtime
            .ensure_hidden("local", "owl", "late-hidden")
            .await
            .unwrap_err()
            .code,
        4211
    );
    opening.write_all(b"release").await.unwrap();
    let mut working = f.barrier(b"working\n").await;
    let refusal = deleting.await.unwrap().unwrap_err();
    assert_eq!(refusal.code, 4211);
    assert!(
        refusal.data.unwrap()["sections"]
            .as_array()
            .unwrap()
            .iter()
            .any(|s| s["id"] == "opening")
    );
    assert!(alive(f.pid("opening")));
    assert!(catalog::bot(f.h(), "local", "owl").is_ok());
    working.write_all(b"release").await.unwrap();
    assert_eq!(running.await.unwrap().unwrap(), "done");
    fs::write(f.h().join("stopped-once"), "release closes").unwrap();
    assert_eq!(
        f.app
            .runtime
            .run_hidden_job("local", "owl", "next-job", "healthy", &json!({}))
            .await
            .unwrap(),
        "done"
    );
    assert_eq!(
        f.app
            .call("local", "hexbot.bots.delete", &json!({"name":"owl"}))
            .await
            .unwrap()["deleted"],
        true
    );
    f.finish().await;
}

#[tokio::test]
async fn wrong_owner_cannot_open_or_delete_while_healthy_owned_work_survives() {
    let f = Fixture::new(false).await;
    f.roots().await;
    db::open(f.h()).unwrap().execute_batch(
        "INSERT INTO users(id,display_name,role,created_at) VALUES('stranger','Stranger','member',0)"
    ).unwrap();
    assert_eq!(
        f.app
            .runtime
            .ensure_hidden("stranger", "owl", "foreign")
            .await
            .unwrap_err()
            .code,
        4302
    );
    assert_eq!(
        f.app
            .runtime
            .run_hidden_job("stranger", "owl", "foreign-job", "work", &json!({}))
            .await
            .unwrap_err()
            .code,
        4302
    );
    for method in [
        "hexbot.bots.delete",
        "hexbot.rooms.delete",
        "hexbot.rooms.remove_member",
    ] {
        assert_eq!(
            f.app
                .call(
                    "stranger",
                    method,
                    &json!({"name":"owl","id":f.room,"bot":"owl"})
                )
                .await
                .unwrap_err()
                .code,
            4302
        );
    }
    assert_eq!(f.processes().len(), 2);
    for id in ["root", "child"] {
        assert!(alive(f.pid(id)));
        assert_eq!(store::history(f.h(), id).unwrap()[0]["text"], "original");
    }
    fs::write(f.h().join("stopped-once"), "release closes").unwrap();
    f.post(&f.room, "healthy owned post").await;
    f.finish().await;
}

#[tokio::test]
async fn deletion_blocks_late_hidden_cli_job_and_room_workers_before_purge() {
    for mode in ["bot", "room", "last"] {
        let f = Fixture::new(mode == "last").await;
        if mode == "room" {
            db::open(f.h()).unwrap().execute("INSERT INTO room_sessions(room_id,bot,stored_session_id) VALUES(?,'fox','unopened')", [&f.room]).unwrap();
        }
        if mode == "bot" {
            f.sender().await;
        }
        let live = f.roots().await;
        let pids = [f.pid("root"), f.pid("child")];
        let rebound = f.app.rebind("127.0.0.1:0".parse().unwrap()).unwrap();
        let a = rebound.clone();
        let room = f.room.clone();
        let deleting = tokio::spawn(async move {
            a.call(
                "local",
                match mode {
                    "bot" => "hexbot.bots.delete",
                    "last" => "hexbot.rooms.remove_member",
                    _ => "hexbot.rooms.delete",
                },
                &json!({"id":room,"name":"owl","bot":"owl"}),
            )
            .await
        });
        let mut closing = f.barrier(b"closing\n").await;
        assert!(pids.iter().any(|p| alive(*p)));
        if mode == "bot" {
            assert_eq!(
                f.app
                    .runtime
                    .ensure_hidden("local", "owl", "late-hidden")
                    .await
                    .unwrap_err()
                    .code,
                4211
            );
            assert_eq!(
                f.app
                    .runtime
                    .run_hidden_job("local", "owl", "late-job", "go", &json!({}))
                    .await
                    .unwrap_err()
                    .code,
                4211
            );
            assert_eq!(
                f.app
                    .call(
                        "local",
                        "hexbot.cli.send",
                        &json!({"bot":"owl","text":"go"})
                    )
                    .await
                    .unwrap_err()
                    .code,
                4211
            );
            let catalog_before = db::open(f.h())
                .unwrap()
                .query_row("SELECT COUNT(*) FROM sections WHERE bot='owl'", [], |r| {
                    r.get::<_, i64>(0)
                })
                .unwrap();
            f.app
                .runtime
                .run_hidden("local", "fox", "sender", "ask-owl")
                .await
                .unwrap();
            let response: Value = serde_json::from_str(
                fs::read_to_string(f.h().join("tool-responses.jsonl"))
                    .unwrap()
                    .lines()
                    .last()
                    .unwrap(),
            )
            .unwrap();
            assert!(
                response["value"]
                    .as_str()
                    .unwrap()
                    .contains("Deletion is in progress"),
                "{response}"
            );
            assert_eq!(
                db::open(f.h())
                    .unwrap()
                    .query_row("SELECT COUNT(*) FROM sections WHERE bot='owl'", [], |r| r
                        .get::<_, i64>(
                        0
                    ))
                    .unwrap(),
                catalog_before
            );
            let late_room = rooms::call(
                f.h(),
                "local",
                "hexbot.rooms.create",
                &json!({"name":"Late room","members":["fox","owl"],"main_bot":"owl"}),
            )
            .unwrap()
            .unwrap()["room"]["id"]
                .as_str()
                .unwrap()
                .to_owned();
            let mut events = f.app.events.subscribe();
            f.app
                .call(
                    "local",
                    "hexbot.rooms.send",
                    &json!({"id":late_room,"text":"@fox @owl Try new room mappings"}),
                )
                .await
                .unwrap();
            tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    let frame = events.recv().await.unwrap().frame;
                    if frame["params"]["type"] == "hexbot.rooms.event"
                        && frame["params"]["payload"]["room_id"] == late_room
                        && frame["params"]["payload"]["event"]["kind"] == "turn.failed"
                    {
                        break;
                    }
                }
            })
            .await
            .unwrap();
            assert_eq!(
                db::open(f.h())
                    .unwrap()
                    .query_row(
                        "SELECT COUNT(*) FROM room_sessions WHERE room_id=?",
                        [&late_room],
                        |r| r.get::<_, i64>(0)
                    )
                    .unwrap(),
                0
            );
            assert_eq!(
                db::open(f.h())
                    .unwrap()
                    .query_row(
                        "SELECT COUNT(*) FROM room_turns WHERE room_id=? AND status='running'",
                        [&late_room],
                        |r| r.get::<_, i64>(0)
                    )
                    .unwrap(),
                0
            );
        } else {
            assert_eq!(
                f.app
                    .call(
                        "local",
                        "hexbot.rooms.send",
                        &json!({"id":f.room,"text":"Restart the main bot"})
                    )
                    .await
                    .unwrap_err()
                    .code,
                4211
            );
            assert_eq!(
                f.app.rooms.notify("local", &f.room).await.unwrap_err().code,
                4211
            );
            // A mapped bot without a process cannot bypass room admission by
            // opening directly through the runtime, nor can a saved child.
            if mode == "room" {
                assert_eq!(
                    f.app
                        .runtime
                        .ensure_hidden("local", "fox", "unopened")
                        .await
                        .unwrap_err()
                        .code,
                    4211
                );
            }
            assert_eq!(
                f.app
                    .runtime
                    .ensure_hidden("local", "owl", "child")
                    .await
                    .unwrap_err()
                    .code,
                4211
            );
            assert_eq!(
                f.app
                    .runtime
                    .run_hidden_job(
                        "local",
                        "owl",
                        "fresh-child",
                        "work",
                        &json!({"parent_session":"child"}),
                    )
                    .await
                    .unwrap_err()
                    .code,
                4211
            );
        }
        assert_eq!(
            f.processes().len(),
            if mode == "bot" { 3 } else { 2 },
            "refused work spawned a process"
        );
        f.unrelated().await;
        closing.write_all(b"release").await.unwrap();
        let result = deleting.await.unwrap().unwrap();
        assert!(result["deleted"] == true || result["room"]["deleted"] == true);
        for ((id, live), pid) in ["root", "child"]
            .into_iter()
            .zip([live.0, live.1])
            .zip(pids)
        {
            assert!(
                !alive(pid),
                "{mode}: deleted {id} still owns live PID {pid}"
            );
            assert!(store::history(f.h(), id).unwrap().is_empty());
            assert!(
                !store::open(f.h())
                    .unwrap()
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM native_sessions WHERE stored_id=?)",
                        [id],
                        |r| r.get::<_, bool>(0)
                    )
                    .unwrap()
            );
            assert!(!f.h().join("runtime/sessions").join(id).exists());
            assert_eq!(
                store::append(f.h(), id, json!({"role":"user","text":"late"}))
                    .unwrap_err()
                    .code,
                4001
            );
            assert!(
                f.app
                    .call("local", "session.get_state", &json!({"session_id":live}))
                    .await
                    .is_err()
            );
        }
        let active = f
            .app
            .call("local", "session.active_list", &json!({}))
            .await
            .unwrap();
        if mode == "bot" {
            assert!(!f.h().join("profiles/owl").exists());
        } else {
            assert!(rooms::get(f.h(), "local", &f.room).is_err());
        }
        assert!(
            active["sessions"]
                .as_array()
                .unwrap()
                .iter()
                .all(|s| s["session_key"] != "root" && s["session_key"] != "child")
        );
        f.finish().await;
    }
}

#[tokio::test]
async fn failed_decisions_release_admission_and_allow_actual_next_jobs_and_room_posts() {
    for mode in ["bot", "room", "last"] {
        // This prefix purges room history before its catalog decision. Its
        // later catalog faults cannot promise history rollback. Last-member
        // removal also changes membership before purging. Exercise those room
        // failures before mutation, and bot rollback at each existing boundary.
        let faults: &[&str] = if mode == "bot" {
            &["delete", "commit", "retirement"]
        } else if mode == "last" {
            &["stop"]
        } else {
            &["retirement"]
        };
        for &fault in faults {
            let f = Fixture::new(mode == "last").await;
            f.roots().await;
            let catalog = db::open(f.h()).unwrap();
            let native = store::open(f.h()).unwrap();
            match fault {
                "delete"=>catalog.execute_batch(&format!("CREATE TRIGGER refuse_decision BEFORE DELETE ON {} BEGIN SELECT RAISE(ABORT,'decision fault'); END",if mode=="bot" {"bots"}else{"rooms"})).unwrap(),
                "commit"=>{let table=if mode=="bot" {"bots(name)"}else{"rooms(id)"};catalog.execute_batch(&format!("CREATE TABLE refuse_commit(id TEXT REFERENCES {table} DEFERRABLE INITIALLY DEFERRED)")).unwrap();catalog.execute("INSERT INTO refuse_commit VALUES(?)",[if mode=="bot" {"owl"}else{&f.room}]).unwrap();},
                "stop"=>{
                    catalog.execute("INSERT INTO room_turns(id,room_id,bot,trigger_seq,status,started_at) VALUES('stop-fault',?,'owl',0,'running',0)", [&f.room]).unwrap();
                    catalog.execute_batch("CREATE TRIGGER refuse_stop BEFORE UPDATE ON room_turns BEGIN SELECT RAISE(ABORT,'stop fault'); END").unwrap();
                },
                _=>native.execute_batch("CREATE TRIGGER refuse_retirement BEFORE INSERT ON native_deleted BEGIN SELECT RAISE(ABORT,'retirement fault'); END").unwrap(),
            }
            // Metadata failures can happen before any close. Do not hold a
            // shutdown barrier in that case.
            fs::write(f.h().join("stopped-once"), "release all closes").unwrap();
            let result = f
                .app
                .call(
                    "local",
                    match mode {
                        "bot" => "hexbot.bots.delete",
                        "last" => "hexbot.rooms.remove_member",
                        _ => "hexbot.rooms.delete",
                    },
                    &json!({"id":f.room,"name":"owl","bot":"owl"}),
                )
                .await;
            assert!(result.is_err(), "{mode}/{fault}: {result:?}");
            if fault == "stop" {
                catalog
                    .execute_batch(
                        "DROP TRIGGER refuse_stop; DELETE FROM room_turns WHERE id='stop-fault'",
                    )
                    .unwrap();
            }
            for id in ["root", "child"] {
                assert_eq!(store::history(f.h(), id).unwrap()[0]["text"], "original");
                assert_eq!(
                    fs::read_to_string(
                        f.h()
                            .join("runtime/sessions")
                            .join(id)
                            .join("conversation-original.jsonl")
                    )
                    .unwrap(),
                    "original bytes\n"
                );
                store::append(f.h(), id, json!({"role":"user","text":"writable"})).unwrap();
            }
            assert_eq!(
                f.app
                    .runtime
                    .run_hidden_job("local", "owl", "next-job", "still work", &json!({}))
                    .await
                    .unwrap(),
                "done"
            );
            assert!(!alive(f.pid("next-job")));
            f.post(&f.room, "still usable").await;
            f.finish().await;
        }
    }
}

#[tokio::test]
async fn cancelled_delete_rpc_still_closes_before_committing_and_releases_the_guard() {
    for mode in ["bot", "room", "last"] {
        let f = Fixture::new(mode == "last").await;
        f.roots().await;
        let a = f.app.clone();
        let room = f.room.clone();
        let deleting = tokio::spawn(async move {
            a.call(
                "local",
                match mode {
                    "bot" => "hexbot.bots.delete",
                    "last" => "hexbot.rooms.remove_member",
                    _ => "hexbot.rooms.delete",
                },
                &json!({"id":room,"name":"owl","bot":"owl"}),
            )
            .await
        });
        let mut closing = f.barrier(b"closing\n").await;
        deleting.abort();
        assert!(deleting.await.unwrap_err().is_cancelled());
        let mut events = f.app.events.subscribe();
        closing.write_all(b"release").await.unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let frame = events.recv().await.unwrap().frame;
                if frame["params"]["type"]
                    == if mode == "bot" {
                        "hexbot.bots.changed"
                    } else {
                        "hexbot.rooms.changed"
                    }
                {
                    break;
                }
            }
        })
        .await
        .unwrap();
        for id in ["root", "child"] {
            assert!(!alive(f.pid(id)));
            assert!(store::history(f.h(), id).unwrap().is_empty());
        }
        if mode == "bot" {
            f.app
                .call(
                    "local",
                    "hexbot.bots.create",
                    &json!({"name":"owl","description":"Recreated"}),
                )
                .await
                .unwrap();
            f.app
                .runtime
                .ensure_hidden("local", "owl", "new-generation")
                .await
                .unwrap();
        }
        f.finish().await;
    }
}

#[tokio::test]
async fn bot_delete_drains_hidden_job_cli_and_incoming_teammate_registration() {
    for mode in ["hidden", "job", "cli", "teammate"] {
        let f = Fixture::new(false).await;
        eprintln!("registration path: {mode}");
        if mode == "teammate" {
            f.sender().await;
        }
        fs::write(
            f.h().join("hold-opening"),
            "hold first get_state before live registration",
        )
        .unwrap();
        let a = f.app.clone();
        let opening = tokio::spawn(async move {
            match mode {
                "cli" => {
                    a.call(
                        "local",
                        "hexbot.cli.send",
                        &json!({"bot":"owl","text":"work"}),
                    )
                    .await
                }
                "job" => a
                    .runtime
                    .run_hidden_job("local", "owl", "opening", "work", &json!({}))
                    .await
                    .map(|v| json!(v)),
                "teammate" => a
                    .runtime
                    .run_hidden("local", "fox", "sender", "ask-owl")
                    .await
                    .map(|v| json!(v)),
                _ => a
                    .runtime
                    .ensure_hidden("local", "owl", "opening")
                    .await
                    .map(|v| json!(v)),
            }
        });
        let mut admitted = f.barrier(b"opening\n").await;
        let stored = fs::read_to_string(f.h().join("opening-held")).unwrap();
        let pid = f.pid(&stored);
        assert!(alive(pid));
        assert_eq!(
            store::open(f.h())
                .unwrap()
                .query_row(
                    "SELECT COUNT(*) FROM native_live_sessions WHERE stored_id=?",
                    [&stored],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            0,
            "startup must still precede registration"
        );
        store::append(
            f.h(),
            &stored,
            json!({"role":"user","text":"before snapshot"}),
        )
        .unwrap();
        let raw = store::session_dir(f.h(), &stored)
            .unwrap()
            .join("conversation-original.jsonl");
        fs::write(&raw, "original before registration").unwrap();
        let a = f.app.clone();
        let deleting = tokio::spawn(async move {
            a.call("local", "hexbot.bots.delete", &json!({"name":"owl"}))
                .await
        });
        f.unrelated().await;
        assert!(
            !deleting.is_finished(),
            "{mode}: deletion passed an in-flight opener"
        );
        assert!(raw.exists());
        assert_eq!(
            store::history(f.h(), &stored).unwrap()[0]["text"],
            "before snapshot"
        );
        assert_eq!(
            f.app
                .runtime
                .ensure_hidden("local", "owl", "late-hidden")
                .await
                .unwrap_err()
                .code,
            4211
        );
        admitted.write_all(b"release").await.unwrap();
        let mut deleting = deleting;
        let result = tokio::select! {
            result = &mut deleting => {
                let _ = opening.await.unwrap();
                match result.unwrap() {
                    Ok(result) => result,
                    Err(error) => {
                        // An already-admitted input may land before the final
                        // busy check. Honest busy refusal preserves it; retry
                        // only after that actual operation has finished.
                        assert_eq!(error.code,4211);
                        let a=f.app.clone();
                        let retry=tokio::spawn(async move {a.call("local", "hexbot.bots.delete", &json!({"name":"owl"})).await});
                        let mut closing=f.barrier(b"closing\n").await;
                        assert!(alive(pid)); assert!(raw.exists());
                        closing.write_all(b"release").await.unwrap();
                        retry.await.unwrap().unwrap()
                    }
                }
            },
            mut closing = f.barrier(b"closing\n") => {
                assert!(alive(pid)); assert!(raw.exists());
                closing.write_all(b"release").await.unwrap();
                let _ = opening.await.unwrap();
                deleting.await.unwrap().unwrap()
            }
        };
        assert_eq!(result["deleted"], true);
        assert!(!alive(pid));
        assert!(store::history(f.h(), &stored).unwrap().is_empty());
        assert!(!raw.exists());
        assert!(
            !store::open(f.h())
                .unwrap()
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM native_sessions WHERE stored_id=?)",
                    [&stored],
                    |r| r.get::<_, bool>(0)
                )
                .unwrap()
        );
        assert_eq!(
            db::open(f.h())
                .unwrap()
                .query_row("SELECT COUNT(*) FROM sections WHERE bot='owl'", [], |r| r
                    .get::<_, i64>(
                    0
                ))
                .unwrap(),
            0
        );
        f.finish().await;
    }
}

#[tokio::test]
async fn last_member_join_releases_admission_for_the_surviving_room() {
    let f = Fixture::new(true).await;
    f.roots().await;
    let a = f.app.clone();
    let room = f.room.clone();
    let deleting = tokio::spawn(async move {
        a.call(
            "local",
            "hexbot.rooms.remove_member",
            &json!({"id":room,"bot":"owl"}),
        )
        .await
    });
    let mut closing = f.barrier(b"closing\n").await;
    f.app
        .call(
            "local",
            "hexbot.rooms.add_member",
            &json!({"id":f.room,"bot":"fox"}),
        )
        .await
        .unwrap();
    closing.write_all(b"release").await.unwrap();
    assert_ne!(deleting.await.unwrap().unwrap()["room"]["deleted"], true);
    for id in ["root", "child"] {
        assert!(!alive(f.pid(id)));
        store::append(f.h(), id, json!({"role":"user","text":"survived"})).unwrap();
    }
    f.post(&f.room, "@fox Continue").await;
    f.finish().await;
}

#[tokio::test]
async fn concurrent_member_removals_close_both_processes_before_deleting_the_room() {
    let f = Fixture::new(false).await;
    f.roots().await;
    db::open(f.h())
        .unwrap()
        .execute(
            "INSERT INTO room_sessions(room_id,bot,stored_session_id) VALUES(?,'fox','fox-root')",
            [&f.room],
        )
        .unwrap();
    f.app
        .runtime
        .ensure_hidden("local", "fox", "fox-root")
        .await
        .unwrap();
    store::append(
        f.h(),
        "fox-root",
        json!({"role":"user","text":"fox history"}),
    )
    .unwrap();
    let a = f.app.clone();
    let room = f.room.clone();
    let first = tokio::spawn(async move {
        a.call(
            "local",
            "hexbot.rooms.remove_member",
            &json!({"id":room,"bot":"owl"}),
        )
        .await
    });
    let mut closing = f.barrier(b"closing\n").await;
    let a = f.app.clone();
    let room = f.room.clone();
    let last = tokio::spawn(async move {
        a.call(
            "local",
            "hexbot.rooms.remove_member",
            &json!({"id":room,"bot":"fox"}),
        )
        .await
    });
    f.unrelated().await;
    assert!(!last.is_finished());
    assert!(rooms::get(f.h(), "local", &f.room).is_ok());
    assert!(!store::history(f.h(), "fox-root").unwrap().is_empty());
    closing.write_all(b"release").await.unwrap();
    assert_ne!(first.await.unwrap().unwrap()["room"]["deleted"], true);
    assert_eq!(last.await.unwrap().unwrap()["room"]["deleted"], true);
    for id in ["root", "child", "fox-root"] {
        assert!(!alive(f.pid(id)));
        assert!(store::history(f.h(), id).unwrap().is_empty());
    }
    f.finish().await;
}

#[tokio::test]
async fn description_process_admission_survives_caller_cancellation_until_actual_shutdown() {
    for cancel in [false, true] {
        let f = Fixture::new(false).await;
        // Let startup's automatic description scan finish while every bot has
        // its explicit description, before starting the refresh we will cancel.
        f.app
            .runtime
            .ensure_hidden("local", "hare", "bootstrap")
            .await
            .unwrap();
        fs::write(f.h().join("hold-description"), "hold provider result").unwrap();
        db::open(f.h())
            .unwrap()
            .execute("UPDATE bots SET description='' WHERE name='owl'", [])
            .unwrap();
        let a = f.app.clone();
        let describing = tokio::spawn(async move { a.runtime.refresh_description("owl").await });
        let mut prompt = f.barrier(b"one-shot").await;
        let pid = f.pid("description");
        assert!(
            !describing.is_finished(),
            "the owned refresh must have started this process"
        );
        if cancel {
            describing.abort();
        }
        let a = f.app.clone();
        let deleting = tokio::spawn(async move {
            a.call("local", "hexbot.bots.delete", &json!({"name":"owl"}))
                .await
        });
        f.unrelated().await;
        assert!(!deleting.is_finished());
        assert!(alive(pid));
        assert!(f.h().join("profiles/owl").exists());
        assert_eq!(
            f.app
                .runtime
                .ensure_hidden("local", "owl", "late-hidden")
                .await
                .unwrap_err()
                .code,
            4211
        );
        if !cancel {
            prompt.write_all(b"release").await.unwrap();
        }
        let mut closing = f.barrier(b"closing\n").await;
        assert!(alive(pid));
        assert!(f.h().join("profiles/owl").exists());
        closing.write_all(b"release").await.unwrap();
        let refresh = describing.await;
        if cancel {
            assert!(refresh.unwrap_err().is_cancelled());
        } else {
            refresh.unwrap();
        }
        assert_eq!(deleting.await.unwrap().unwrap()["deleted"], true);
        assert!(!alive(pid));
        assert!(!f.h().join("profiles/owl").exists());
        f.finish().await;
    }
}

#[tokio::test]
async fn concurrent_bot_deletion_can_make_a_member_removal_last_only_after_processes_close() {
    let f = Fixture::new(false).await;
    f.roots().await;
    db::open(f.h())
        .unwrap()
        .execute(
            "INSERT INTO room_sessions(room_id,bot,stored_session_id) VALUES(?,'fox','fox-root')",
            [&f.room],
        )
        .unwrap();
    f.app
        .runtime
        .ensure_hidden("local", "fox", "fox-root")
        .await
        .unwrap();
    let a = f.app.clone();
    let room = f.room.clone();
    let removing = tokio::spawn(async move {
        a.call(
            "local",
            "hexbot.rooms.remove_member",
            &json!({"id":room,"bot":"owl"}),
        )
        .await
    });
    let mut closing = f.barrier(b"closing\n").await;
    assert_eq!(
        f.app
            .call("local", "hexbot.bots.delete", &json!({"name":"fox"}))
            .await
            .unwrap()["deleted"],
        true
    );
    assert!(!alive(f.pid("fox-root")));
    assert!(alive(f.pid("root")));
    assert!(rooms::get(f.h(), "local", &f.room).is_ok());
    assert_eq!(
        store::history(f.h(), "root").unwrap()[0]["text"],
        "original"
    );
    closing.write_all(b"release").await.unwrap();
    assert_eq!(removing.await.unwrap().unwrap()["room"]["deleted"], true);
    for id in ["root", "child"] {
        assert!(!alive(f.pid(id)));
        assert!(store::history(f.h(), id).unwrap().is_empty());
        assert!(!f.h().join("runtime/sessions").join(id).exists());
    }
    f.finish().await;
}
