//! Catalog decisions must precede irreversible room transcript cleanup.
use hexbot_core::{catalog, common, db, rooms, runtime_store as store, server::App, settings};
use rusqlite::params;
use serde_json::{Value, json};
use std::{fs, future::Future, path::Path, sync::Arc};
mod support;
fn run<T>(f: impl Future<Output = T>) -> T {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(f)
}
fn app(h: &Path) -> Arc<App> {
    App::new(
        h.into(),
        "127.0.0.1:0".parse().unwrap(),
        h.join("unused-pi"),
        None,
    )
    .unwrap()
}
struct Fixture {
    home: support::TestHome,
    app: Arc<App>,
    room: String,
    frozen: Vec<Value>,
    catalog: Vec<Vec<Value>>,
}
impl Fixture {
    fn new() -> Self {
        let home = support::TestHome::new();
        let h = home.path();
        let app = app(h);
        for name in ["owl", "fox"] {
            catalog::call(h, "local", "hexbot.bots.create", &json!({"name":name}))
                .unwrap()
                .unwrap();
        }
        let room = rooms::call(
            h,
            "local",
            "hexbot.rooms.create",
            &json!({"name":"Room","members":["owl"]}),
        )
        .unwrap()
        .unwrap()["room"]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let c = db::open(h).unwrap();
        let n = store::open(h).unwrap();
        c.execute(
            "INSERT INTO room_sessions(room_id,bot,stored_session_id) VALUES(?,'owl','room-root')",
            [&room],
        )
        .unwrap();
        c.execute_batch("INSERT INTO users(id,display_name,role,created_at) VALUES('bob','Bob','member',0); INSERT INTO bots(name,owner_id) VALUES('remote','bob'); INSERT INTO sections(id,bot,owner_id,peer_bot) VALUES('retained','owl','local','owl');").unwrap();
        for (id, bot, owner, parent) in [
            ("room-root", "owl", "local", None),
            ("retained", "owl", "local", Some("room-root")),
            ("grandchild", "owl", "local", Some("retained")),
            ("other-history", "fox", "local", None),
            ("foreign-history", "remote", "bob", None),
        ] {
            let options = format!(
                "{{ \"model\": \"frozen\", \"parent_session\": {}, \"extra\": [1, 2] }}",
                json!(parent)
            );
            n.execute(
                "INSERT INTO native_sessions VALUES(?,?,?,'original prompt',?)",
                params![id, owner, bot, options],
            )
            .unwrap();
            store::append(
                h,
                id,
                json!({"role":"user","text":format!("original {id}")}),
            )
            .unwrap();
            fs::write(
                store::session_dir(h, id)
                    .unwrap()
                    .join("conversation-original.jsonl"),
                format!("raw {id}\n"),
            )
            .unwrap();
        }
        let legacy = rusqlite::Connection::open(h.join("profiles/owl/state.db")).unwrap();
        legacy.execute_batch("CREATE TABLE sessions(id TEXT PRIMARY KEY,session_key TEXT,parent_session_id TEXT); CREATE TABLE messages(id INTEGER PRIMARY KEY,session_id TEXT,role TEXT,content TEXT);").unwrap();
        for (id, alias, parent) in [
            ("old-root", "room-root", None),
            ("old-child", "retained", Some("old-root")),
            ("old-grandchild", "grandchild", Some("old-child")),
        ] {
            legacy
                .execute(
                    "INSERT INTO sessions VALUES(?,?,?)",
                    params![id, alias, parent],
                )
                .unwrap();
            legacy.execute("INSERT INTO messages(session_id,role,content) VALUES(?,'user','original legacy')",[id]).unwrap();
        }
        catalog::call(
            h,
            "local",
            "hexbot.sections.delete",
            &json!({"id":"retained","purge_memory":false}),
        )
        .unwrap()
        .unwrap();
        fs::create_dir_all(h.join("profiles/owl/memories/notes")).unwrap();
        fs::write(h.join("profiles/owl/memories/MEMORY.md"), "MEMORY").unwrap();
        fs::write(h.join("profiles/owl/memories/notes/2026-10-15.md"), "NOTES").unwrap();
        settings::record_incident(
            h,
            "owl",
            "turn_failed",
            "room failure",
            &json!({"section_id":"room-root","room_id":room}),
        )
        .unwrap();
        for (name, kind) in [
            ("fox", "turn_failed"),
            ("remote", "turn_failed"),
            ("owl", "connector_error"),
        ] {
            settings::record_incident(
                h,
                name,
                kind,
                "keep failure",
                &if name == "fox" {
                    json!({"section_id":"room-root"})
                } else {
                    json!({"section_id":"room-root","room_id":room,"connector":"github"})
                },
            )
            .unwrap();
        }
        let frozen =
            common::rows(&n, "SELECT * FROM native_sessions ORDER BY stored_id", &[]).unwrap();
        let catalog = catalog_snapshot(h);
        Self {
            home,
            app,
            room,
            frozen,
            catalog,
        }
    }
    fn restart(&mut self) {
        run(self.app.shutdown());
        self.app = app(self.home.path());
    }
    fn delete(&self, public: bool, last: bool) -> hexbot_core::Result<Value> {
        if public {
            run(self.app.call(
                "local",
                if last {
                    "hexbot.rooms.remove_member"
                } else {
                    "hexbot.rooms.delete"
                },
                &json!({"id":self.room,"bot":"owl"}),
            ))
        } else if last {
            rooms::remove_bot(self.home.path(), "local", &self.room, "owl", false)
        } else {
            rooms::delete(self.home.path(), &self.room)
        }
    }
    fn intact(&self) {
        let h = self.home.path();
        assert_eq!(catalog_snapshot(h), self.catalog);
        assert_eq!(
            common::rows(
                &store::open(h).unwrap(),
                "SELECT * FROM native_sessions ORDER BY stored_id",
                &[]
            )
            .unwrap(),
            self.frozen
        );
        for id in ["room-root", "retained", "grandchild"] {
            assert_eq!(
                store::history(h, id).unwrap()[0]["text"],
                format!("original {id}")
            );
            assert_eq!(
                fs::read_to_string(
                    h.join("runtime/sessions")
                        .join(id)
                        .join("conversation-original.jsonl")
                )
                .unwrap(),
                format!("raw {id}\n")
            );
        }
        let legacy = rusqlite::Connection::open(h.join("profiles/owl/state.db")).unwrap();
        assert_eq!(
            legacy
                .query_row("SELECT COUNT(*) FROM messages", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            3
        );
        let n = store::open(h).unwrap();
        assert_eq!(
            n.query_row(
                "SELECT purge FROM native_delete_options WHERE session_id='retained'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
        assert_eq!(
            store::append(h, "retained", json!({"role":"user","text":"late"}))
                .unwrap_err()
                .code,
            4001
        );
        self.other();
    }
    fn other(&self) {
        let h = self.home.path();
        for id in ["other-history", "foreign-history"] {
            assert_eq!(
                store::history(h, id).unwrap()[0]["text"],
                format!("original {id}")
            );
        }
        assert_eq!(
            fs::read_to_string(h.join("profiles/owl/memories/MEMORY.md")).unwrap(),
            "MEMORY"
        );
        assert_eq!(
            fs::read_to_string(h.join("profiles/owl/memories/notes/2026-10-15.md")).unwrap(),
            "NOTES"
        );
        let kept = common::rows(
            &db::open(h).unwrap(),
            "SELECT * FROM bot_incidents WHERE text='keep failure' ORDER BY bot",
            &[],
        )
        .unwrap();
        assert_eq!(
            kept.iter().filter(|r| r["resolved_at"].is_null()).count(),
            3,
            "{kept:?}"
        );
    }
    fn purged(&self) {
        let h = self.home.path();
        assert!(rooms::get(h, "local", &self.room).is_err());
        for id in ["room-root", "retained", "grandchild"] {
            assert!(store::history(h, id).unwrap().is_empty());
            assert!(!h.join("runtime/sessions").join(id).exists());
            assert_eq!(
                store::append(h, id, json!({"role":"user","text":"late"}))
                    .unwrap_err()
                    .code,
                4001
            );
        }
        let legacy = rusqlite::Connection::open(h.join("profiles/owl/state.db")).unwrap();
        assert_eq!(
            legacy
                .query_row("SELECT COUNT(*) FROM messages", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(db::open(h).unwrap().query_row("SELECT COUNT(*) FROM bot_incidents WHERE text='room failure' AND resolved_at IS NOT NULL",[],|r|r.get::<_,i64>(0)).unwrap(),1);
        self.other();
    }
}
fn catalog_snapshot(h: &Path) -> Vec<Vec<Value>> {
    let c = db::open(h).unwrap();
    [
        "rooms",
        "room_members",
        "room_sessions",
        "room_events",
        "bot_incidents",
    ]
    .into_iter()
    .map(|table| common::rows(&c, &format!("SELECT * FROM {table} ORDER BY rowid"), &[]).unwrap())
    .collect()
}

#[test]
fn failed_room_decision_preserves_history_options_incidents_and_membership() {
    for public in [false, true] {
        for last in [false, true] {
            for fault in ["delete", "commit", "options"] {
                eprintln!("room precommit public={public} last={last} fault={fault}");
                let mut f = Fixture::new();
                let h = f.home.path().to_owned();
                let c = db::open(&h).unwrap();
                let n = store::open(&h).unwrap();
                match fault {"delete"=>c.execute_batch("CREATE TRIGGER refuse_decision BEFORE DELETE ON rooms BEGIN SELECT RAISE(ABORT,'room delete fault'); END").unwrap(),"commit"=>{c.execute_batch("CREATE TABLE refuse_commit(room TEXT REFERENCES rooms(id) DEFERRABLE INITIALLY DEFERRED)").unwrap(); c.execute("INSERT INTO refuse_commit VALUES(?)",[&f.room]).unwrap();},"options"=>n.execute_batch("CREATE TRIGGER refuse_options BEFORE INSERT ON native_delete_options WHEN NEW.session_id='room-root' BEGIN SELECT RAISE(ABORT,'room metadata fault'); END").unwrap(),_=>unreachable!()}
                assert!(f.delete(public, last).is_err());
                f.intact();
                f.restart();
                f.intact();
                store::append(&h, "room-root", json!({"role":"user","text":"still live"})).unwrap();
                match fault {
                    "delete" => c.execute_batch("DROP TRIGGER refuse_decision").unwrap(),
                    "commit" => c.execute_batch("DROP TABLE refuse_commit").unwrap(),
                    "options" => n.execute_batch("DROP TRIGGER refuse_options").unwrap(),
                    _ => unreachable!(),
                }
                let result = f.delete(public, last).unwrap();
                assert_ne!(
                    if last {
                        &result["room"]["history_pending"]
                    } else {
                        &result["history_pending"]
                    },
                    &json!(true)
                );
                f.purged();
                run(f.app.shutdown());
            }
        }
    }
}
#[test]
fn committed_room_cleanup_faults_remain_terminal_and_retry_exact_owned_targets() {
    for public in [false, true] {
        for last in [false, true] {
            for fault in ["native", "legacy", "marker", "completion"] {
                eprintln!("room postcommit public={public} last={last} fault={fault}");
                let mut f = Fixture::new();
                let h = f.home.path().to_owned();
                let n = store::open(&h).unwrap();
                let legacy = rusqlite::Connection::open(h.join("profiles/owl/state.db")).unwrap();
                match fault {"native"=>n.execute_batch("CREATE TRIGGER refuse_cleanup BEFORE DELETE ON native_messages WHEN OLD.session_id='room-root' BEGIN SELECT RAISE(ABORT,'room native fault'); END").unwrap(),"legacy"=>legacy.execute_batch("CREATE TRIGGER refuse_cleanup BEFORE DELETE ON messages BEGIN SELECT RAISE(ABORT,'room legacy fault'); END").unwrap(),"marker"=>n.execute_batch("CREATE TRIGGER refuse_cleanup BEFORE DELETE ON native_delete_pending WHEN OLD.session_id='room-root' BEGIN SELECT RAISE(ABORT,'room marker fault'); END").unwrap(),"completion"=>n.execute_batch("CREATE TRIGGER refuse_cleanup BEFORE INSERT ON native_delete_completed WHEN NEW.session_id='room-root' BEGIN SELECT RAISE(ABORT,'room completion fault'); END").unwrap(),_=>unreachable!()}
                let result = f.delete(public, last).unwrap();
                assert_eq!(
                    if last {
                        &result["room"]["history_pending"]
                    } else {
                        &result["history_pending"]
                    },
                    &json!(true)
                );
                assert!(rooms::get(&h, "local", &f.room).is_err());
                f.restart();
                for id in ["room-root", "retained", "grandchild"] {
                    assert_eq!(
                        store::append(&h, id, json!({"role":"user","text":"late"}))
                            .unwrap_err()
                            .code,
                        4001
                    );
                }
                f.other();
                if fault == "legacy" {
                    legacy.execute_batch("DROP TRIGGER refuse_cleanup").unwrap();
                } else {
                    n.execute_batch("DROP TRIGGER refuse_cleanup").unwrap();
                }
                f.restart();
                f.purged();
                store::finish_deletes(&h).unwrap();
                f.purged();
                run(f.app.shutdown());
            }
        }
    }
}
#[test]
fn room_delete_rejects_foreign_callers_and_foreign_descendant_ownership() {
    let f = Fixture::new();
    let h = f.home.path();
    for method in ["hexbot.rooms.delete", "hexbot.rooms.remove_member"] {
        assert_eq!(
            run(f.app.call("bob", method, &json!({"id":f.room,"bot":"owl"})))
                .unwrap_err()
                .code,
            4302
        );
    }
    assert_eq!(
        rooms::remove_bot(h, "bob", &f.room, "owl", false)
            .unwrap_err()
            .code,
        4302
    );
    f.intact();
    store::open(h).unwrap().execute("UPDATE native_sessions SET options=json_set(options,'$.parent_session','room-root') WHERE stored_id='foreign-history'",[]).unwrap();
    assert_eq!(f.delete(false, false).unwrap_err().code, 4302);
    assert!(rooms::get(h, "local", &f.room).is_ok());
    f.other();
    run(f.app.shutdown());
}

#[test]
fn room_catalog_abort_preserves_mapped_native_history() {
    for public in [true, false] {
        for last in [false, true] {
            check_catalog_decision(public, last, true);
        }
    }
}
#[test]
fn room_catalog_healthy_delete_cleans_mapped_native_history() {
    for public in [true, false] {
        for last in [false, true] {
            check_catalog_decision(public, last, false);
        }
    }
}
fn check_catalog_decision(public: bool, last: bool, fault: bool) {
    let home = support::TestHome::new();
    let h = home.path();
    let running = app(h);
    catalog::call(h, "local", "hexbot.bots.create", &json!({"name":"owl"}))
        .unwrap()
        .unwrap();
    let room = rooms::call(
        h,
        "local",
        "hexbot.rooms.create",
        &json!({"name":"Room","members":["owl"]}),
    )
    .unwrap()
    .unwrap()["room"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let c = db::open(h).unwrap();
    c.execute(
        "INSERT INTO room_sessions(room_id,bot,stored_session_id) VALUES(?,'owl','mapped-root')",
        [&room],
    )
    .unwrap();
    let n = store::open(h).unwrap();
    for (id, parent) in [("mapped-root", None), ("mapped-child", Some("mapped-root"))] {
        n.execute(
            "INSERT INTO native_sessions VALUES(?,'local','owl','FROZEN',?)",
            params![
                id,
                json!({"parent_session":parent,"extra":[1,2]}).to_string()
            ],
        )
        .unwrap();
        store::append(h, id, json!({"role":"user","text":format!("KEEP {id}")})).unwrap();
        fs::write(
            store::session_dir(h, id).unwrap().join("original"),
            b"RAW PI BYTES",
        )
        .unwrap();
    }
    settings::record_incident(
        h,
        "owl",
        "turn_failed",
        "owned failure",
        &json!({"section_id":"mapped-root","room_id":room}),
    )
    .unwrap();
    let original =
        common::rows(&n, "SELECT * FROM native_sessions ORDER BY stored_id", &[]).unwrap();
    let catalog = catalog_snapshot(h);
    if fault {
        c.execute_batch("CREATE TRIGGER refuse_room BEFORE DELETE ON rooms BEGIN SELECT RAISE(ABORT,'controlled room decision failure'); END").unwrap();
    }
    let result = if public {
        run(running.call(
            "local",
            if last {
                "hexbot.rooms.remove_member"
            } else {
                "hexbot.rooms.delete"
            },
            &json!({"id":room,"bot":"owl"}),
        ))
    } else if last {
        rooms::remove_bot(h, "local", &room, "owl", false)
    } else {
        rooms::delete(h, &room)
    };
    assert_eq!(result.is_err(), fault);
    if fault {
        assert_eq!(catalog_snapshot(h), catalog);
        assert_eq!(
            common::rows(&n, "SELECT * FROM native_sessions ORDER BY stored_id", &[]).unwrap(),
            original
        );
    }
    for id in ["mapped-root", "mapped-child"] {
        assert_eq!(
            store::history(h, id).unwrap().len(),
            usize::from(fault),
            "public={public}, last={last}, fault={fault}, id={id}"
        );
        if fault {
            assert_eq!(
                fs::read(h.join("runtime/sessions").join(id).join("original")).unwrap(),
                b"RAW PI BYTES"
            );
        }
    }
    run(running.shutdown());
    drop(running);
    let again = app(h);
    for id in ["mapped-root", "mapped-child"] {
        assert_eq!(store::history(h, id).unwrap().len(), usize::from(fault));
        if fault {
            store::append(h, id, json!({"role":"user","text":"still writable"})).unwrap();
        }
    }
    run(again.shutdown());
}

#[test]
fn last_member_race_releases_retirement_when_a_new_member_keeps_the_room() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let home = support::TestHome::new();
    let h = home.path();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let port = listener.local_addr().unwrap().port();
    let pi = h.join("pi.cjs");
    let marker = h.join("stopped-once");
    fs::write(&pi,format!(r#"#!/usr/bin/env node
const fs=require('node:fs'),net=require('node:net');
require('node:readline').createInterface({{input:process.stdin}}).on('line',line=>{{const c=JSON.parse(line);if(c.type!=='extension_ui_response')process.stdout.write(JSON.stringify({{type:'response',id:c.id,command:c.type,success:true,data:{{}}}})+'\n');}});
process.on('SIGTERM',()=>{{if(fs.existsSync({marker}))process.exit(0);fs.writeFileSync({marker},'stopped');const s=net.connect({port},'127.0.0.1',()=>s.write('closing\n'));s.on('data',()=>process.exit(0));}});
"#,marker=json!(marker))).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&pi, fs::Permissions::from_mode(0o755)).unwrap();
    }
    let running = App::new(h.into(), "127.0.0.1:0".parse().unwrap(), pi, None).unwrap();
    for bot in ["owl", "fox"] {
        catalog::call(
            h,
            "local",
            "hexbot.bots.create",
            &json!({"name":bot,"description":"Fixture"}),
        )
        .unwrap()
        .unwrap();
    }
    fs::write(
        h.join("profiles/owl/config.yaml"),
        "model:\n  provider: openai\n  default: fixture\ntools:\n  enabled_toolsets: []\n",
    )
    .unwrap();
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
        &json!({"name":"Room","members":["owl"]}),
    )
    .unwrap()
    .unwrap()["room"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    db::open(h)
        .unwrap()
        .execute(
            "INSERT INTO room_sessions(room_id,bot,stored_session_id) VALUES(?,'owl','room-root')",
            [&room],
        )
        .unwrap();
    run(async {
        running
            .runtime
            .ensure_hidden("local", "owl", "room-root")
            .await
            .unwrap();
        let frozen = common::rows(
            &store::open(h).unwrap(),
            "SELECT prompt,options FROM native_sessions WHERE stored_id='room-root'",
            &[],
        )
        .unwrap();
        let a = running.clone();
        let id = room.clone();
        let deleting = tokio::spawn(async move {
            a.call(
                "local",
                "hexbot.rooms.remove_member",
                &json!({"id":id,"bot":"owl"}),
            )
            .await
        });
        let listener = tokio::net::TcpListener::from_std(listener).unwrap();
        let (mut closing, _) =
            tokio::time::timeout(std::time::Duration::from_secs(5), listener.accept())
                .await
                .unwrap()
                .unwrap();
        let mut ready = [0; 8];
        closing.read_exact(&mut ready).await.unwrap();
        assert_eq!(&ready, b"closing\n");
        running
            .call(
                "local",
                "hexbot.rooms.add_member",
                &json!({"id":room,"bot":"fox"}),
            )
            .await
            .unwrap();
        closing.write_all(b"release").await.unwrap();
        let result = deleting.await.unwrap().unwrap();
        assert_ne!(result["room"]["deleted"], true);
        assert!(rooms::get(h, "local", &room).is_ok());
        store::append(
            h,
            "room-root",
            json!({"role":"user","text":"surviving room history"}),
        )
        .unwrap();
        assert_eq!(
            common::rows(
                &store::open(h).unwrap(),
                "SELECT prompt,options FROM native_sessions WHERE stored_id='room-root'",
                &[]
            )
            .unwrap(),
            frozen
        );
        running.shutdown().await;
    });
}

#[test]
fn old_build_room_cleanup_stop_reopens_owned_sessions_of_the_surviving_room() {
    let mut f = Fixture::new();
    let h = f.home.path().to_owned();
    // Owned and foreign mappings in the room that the earlier build failed to delete.
    db::open(&h).unwrap().execute_batch(&format!("INSERT INTO room_members(room_id,member_kind,member_id) VALUES('{0}','bot','fox'); INSERT INTO room_sessions(room_id,bot,stored_session_id) VALUES('{0}','fox','fox-room'),('{0}','remote','foreign-room');", f.room)).unwrap();
    let legacy = rusqlite::Connection::open(h.join("profiles/fox/state.db")).unwrap();
    legacy.execute_batch("CREATE TABLE sessions(id TEXT PRIMARY KEY,session_key TEXT,parent_session_id TEXT); CREATE TABLE messages(id INTEGER PRIMARY KEY,session_id TEXT,role TEXT,content TEXT); INSERT INTO sessions VALUES('legacy-fox-room','fox-room',NULL); INSERT INTO messages(session_id,role,content) VALUES('legacy-fox-room','user','legacy fox room');").unwrap();
    // Its room deletion tombstoned and purged these native transcripts in one
    // transaction each, left legacy rows alone, and stopped before DELETE rooms.
    store::open(&h)
        .unwrap()
        .execute_batch("INSERT INTO native_deleted VALUES('fox-room'),('foreign-room')")
        .unwrap();
    f.catalog = catalog_snapshot(&h);
    for _ in 0..2 {
        f.restart();
        f.intact();
        assert!(store::session_dir(&h, "fox-room").is_ok());
        // A room cannot reopen a session for a bot its owner does not own.
        assert_eq!(
            store::session_dir(&h, "foreign-room").unwrap_err().code,
            4001
        );
        assert_eq!(
            legacy
                .query_row("SELECT COUNT(*) FROM messages", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
    }
    store::append(
        &h,
        "fox-room",
        json!({"role":"user","text":"room continues"}),
    )
    .unwrap();
    assert_eq!(store::history(&h, "fox-room").unwrap().len(), 1);
    run(f.app.shutdown());
}

#[test]
fn old_build_room_marker_reopens_its_owned_native_delegates() {
    let mut f = Fixture::new();
    let h = f.home.path().to_owned();
    let native = store::open(&h).unwrap();
    let options = "{ \"parent_session\": \"room-root\", \"model\": \"frozen\" }";
    native
        .execute(
            "INSERT INTO native_sessions VALUES('room-delegate','local','owl','frozen prompt',?)",
            [options],
        )
        .unwrap();
    store::append(
        &h,
        "room-delegate",
        json!({"role":"user","text":"owned delegate"}),
    )
    .unwrap();
    let raw = store::session_dir(&h, "room-delegate")
        .unwrap()
        .join("conversation-original.jsonl");
    fs::write(&raw, "original raw delegate\n").unwrap();
    f.frozen = common::rows(
        &native,
        "SELECT * FROM native_sessions ORDER BY stored_id",
        &[],
    )
    .unwrap();
    // Old mark_deleted had no request metadata. Its recursively marked retained
    // child keeps that child's modern recorded decision and exact frozen bytes.
    native.execute_batch("INSERT OR IGNORE INTO native_deleted WITH RECURSIVE tree(id) AS (SELECT 'room-root' UNION SELECT s.stored_id FROM native_sessions s JOIN tree t ON json_extract(s.options,'$.parent_session')=t.id) SELECT id FROM tree").unwrap();
    for _ in 0..2 {
        f.restart();
        f.intact();
        for stored in ["room-root", "room-delegate"] {
            assert!(store::session_dir(&h, stored).is_ok());
        }
        assert_eq!(
            store::history(&h, "room-delegate").unwrap()[0]["text"],
            "owned delegate"
        );
        assert_eq!(fs::read_to_string(&raw).unwrap(), "original raw delegate\n");
    }
    for stored in ["room-root", "room-delegate"] {
        store::append(&h, stored, json!({"role":"user","text":"after restart"})).unwrap();
        assert_eq!(store::history(&h, stored).unwrap().len(), 2);
    }
    run(f.app.shutdown());
}
