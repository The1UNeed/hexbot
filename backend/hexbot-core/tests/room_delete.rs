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
            rooms::remove_bot(self.home.path(), "local", &self.room, "owl")
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
        rooms::remove_bot(h, "bob", &f.room, "owl")
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
        rooms::remove_bot(h, "local", &room, "owl")
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
