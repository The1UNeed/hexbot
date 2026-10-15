//! Bot catalog decisions composed with already committed retained deletions.
use hexbot_core::{catalog, common, db, rooms, runtime_store as store, server::App};
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
fn bot(h: &Path, method: &str) -> hexbot_core::Result<Value> {
    catalog::call(h, "local", method, &json!({"name":"owl"})).unwrap()
}
fn rows(h: &Path, sql: &str) -> Vec<Value> {
    common::rows(&store::open(h).unwrap(), sql, &[]).unwrap()
}
fn journal(h: &Path) -> Option<Value> {
    common::rows(
        &db::open(h).unwrap(),
        "SELECT value FROM settings WHERE key='pending_bot_delete:owl'",
        &[],
    )
    .unwrap()
    .first()
    .map(|r| serde_json::from_str(r["value"].as_str().unwrap()).unwrap())
}
struct Fixture {
    home: support::TestHome,
    app: Arc<App>,
    root: String,
    fox: String,
    frozen: Vec<Value>,
    legacy: rusqlite::Connection,
}
impl Fixture {
    fn new() -> Self {
        let home = support::TestHome::new();
        let h = home.path();
        let app = app(h);
        let root = bot(h, "hexbot.bots.create").unwrap()["section"]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let fox = catalog::call(h, "local", "hexbot.bots.create", &json!({"name":"fox"}))
            .unwrap()
            .unwrap()["section"]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let native = store::open(h).unwrap();
        for (id, parent, name) in [
            (&root[..], None, "owl"),
            ("retained", Some(root.as_str()), "owl"),
            ("grandchild", Some("retained"), "owl"),
            ("completed", Some(root.as_str()), "owl"),
            (&fox[..], None, "fox"),
        ] {
            // Deliberately noncanonical whitespace/key order. Rollback must not
            // reserialize the native prompt/options of the retained section.
            let options = format!(
                "{{ \"parent_session\":{}, \"model\":\"frozen\", \"unrelated\": [3, 2, 1] }}",
                json!(parent)
            );
            native
                .execute(
                    "INSERT INTO native_sessions VALUES(?,'local',?,'frozen prompt',?)",
                    params![id, name, options],
                )
                .unwrap();
            store::append(h, id, json!({"role":"user","text":format!("history {id}")})).unwrap();
            fs::write(
                store::session_dir(h, id)
                    .unwrap()
                    .join("conversation-original.jsonl"),
                format!("raw {id}\n"),
            )
            .unwrap();
        }
        let conn = db::open(h).unwrap();
        for id in ["retained", "legacy-retained"] {
            conn.execute(
                "INSERT INTO sections(id,bot,owner_id,peer_bot) VALUES(?,'owl','local','owl')",
                [id],
            )
            .unwrap();
        }
        let legacy = rusqlite::Connection::open(h.join("profiles/owl/state.db")).unwrap();
        legacy.execute_batch("CREATE TABLE sessions(id TEXT PRIMARY KEY,session_key TEXT,parent_session_id TEXT); CREATE TABLE messages(id INTEGER PRIMARY KEY,session_id TEXT,role TEXT,content TEXT); CREATE TABLE repeated_cleanup(id TEXT); CREATE TRIGGER count_completed BEFORE DELETE ON sessions WHEN OLD.id='legacy-completed' BEGIN INSERT INTO repeated_cleanup VALUES(OLD.id); END;").unwrap();
        for (id, alias, parent) in [
            ("legacy-root", root.as_str(), None),
            ("legacy-retained-alias", "retained", Some("legacy-root")),
            ("legacy-only", "legacy-retained", None),
            ("legacy-completed", "completed", Some("legacy-root")),
        ] {
            legacy
                .execute(
                    "INSERT INTO sessions VALUES(?,?,?)",
                    params![id, alias, parent],
                )
                .unwrap();
            legacy
                .execute(
                    "INSERT INTO messages(session_id,role,content) VALUES(?,'user',?)",
                    params![id, format!("legacy {id}")],
                )
                .unwrap();
        }
        for id in ["retained", "legacy-retained"] {
            assert_eq!(
                run(app.call(
                    "local",
                    "hexbot.sections.delete",
                    &json!({"id":id,"purge_memory":false})
                ))
                .unwrap(),
                json!({"deleted":true})
            );
        }
        store::delete(h, "completed").unwrap();
        legacy.execute_batch("DELETE FROM repeated_cleanup; INSERT INTO sessions VALUES('legacy-completed','completed','legacy-root'); INSERT INTO messages(session_id,role,content) VALUES('legacy-completed','user','replacement completed legacy');").unwrap();
        fs::write(
            h.join("runtime/sessions/completed"),
            "replacement completed leaf",
        )
        .unwrap();
        let memory = h.join("profiles/owl/memories");
        fs::create_dir_all(memory.join("notes")).unwrap();
        fs::write(memory.join("MEMORY.md"), "ORIGINAL MEMORY").unwrap();
        fs::write(memory.join("notes/2026-10-15.md"), "ORIGINAL NOTES").unwrap();
        native.execute_batch("INSERT INTO native_jobs VALUES('owl-job','local','owl','{}'); INSERT INTO native_jobs VALUES('fox-job','local','fox','{}'); INSERT INTO native_job_imports VALUES('owl'); INSERT INTO native_job_imports VALUES('fox');").unwrap();
        let frozen = rows(
            h,
            "SELECT * FROM native_sessions WHERE stored_id IN ('retained','grandchild') ORDER BY stored_id",
        );
        Self {
            home,
            app,
            root,
            fox,
            frozen,
            legacy,
        }
    }
    fn restart(&mut self) {
        run(self.app.shutdown());
        self.app = app(self.home.path());
    }
    fn assert_retained(&self) {
        let h = self.home.path();
        assert_eq!(
            rows(
                h,
                "SELECT * FROM native_sessions WHERE stored_id IN ('retained','grandchild') ORDER BY stored_id"
            ),
            self.frozen
        );
        for id in ["retained", "grandchild"] {
            assert_eq!(
                store::history(h, id).unwrap()[0]["text"],
                format!("history {id}")
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
            assert_eq!(
                store::append(h, id, json!({"role":"user","text":"late"}))
                    .unwrap_err()
                    .code,
                4001
            );
        }
        let options = rows(
            h,
            "SELECT * FROM native_delete_options WHERE session_id IN ('retained','grandchild','legacy-retained')",
        );
        assert_eq!(options.len(), 3);
        assert!(
            options
                .iter()
                .all(|r| r["purge"] == 0 && r["bot"] == "owl" && r["owner"] == "local")
        );
        assert_eq!(
            self.legacy
                .query_row(
                    "SELECT COUNT(*) FROM messages WHERE session_id<>'legacy-completed'",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            3
        );
    }
    fn assert_other_and_completed(&self) {
        let h = self.home.path();
        assert!(catalog::bot(h, "local", "fox").is_ok());
        assert_eq!(
            store::history(h, &self.fox).unwrap()[0]["text"],
            format!("history {}", self.fox)
        );
        assert_eq!(
            rows(h, "SELECT * FROM native_jobs WHERE bot='fox'").len(),
            1
        );
        assert_eq!(
            rows(h, "SELECT * FROM native_job_imports WHERE bot='fox'").len(),
            1
        );
        assert_eq!(
            rows(
                h,
                "SELECT * FROM native_delete_completed WHERE session_id='completed'"
            )
            .len(),
            1
        );
        assert_eq!(
            fs::read_to_string(h.join("runtime/sessions/completed")).unwrap(),
            "replacement completed leaf"
        );
        assert_eq!(
            self.legacy
                .query_row("SELECT COUNT(*) FROM repeated_cleanup", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
    fn assert_purged(&self) {
        let h = self.home.path();
        assert!(catalog::bot(h, "local", "owl").is_err());
        assert!(!h.join("profiles/owl").exists());
        assert!(journal(h).is_none());
        for id in [&self.root[..], "retained", "grandchild", "legacy-retained"] {
            assert!(store::history(h, id).unwrap().is_empty());
            assert_eq!(
                store::append(h, id, json!({"role":"user","text":"late"}))
                    .unwrap_err()
                    .code,
                4001
            );
            assert!(!h.join("runtime/sessions").join(id).exists());
            assert_eq!(
                rows(
                    h,
                    &format!("SELECT * FROM native_delete_completed WHERE session_id='{id}'")
                )
                .len(),
                1
            );
        }
        assert!(rows(h, "SELECT * FROM native_delete_pending").is_empty());
        assert!(rows(h, "SELECT * FROM native_delete_claims").is_empty());
        assert!(rows(h, "SELECT * FROM native_jobs WHERE bot='owl'").is_empty());
        assert!(rows(h, "SELECT * FROM native_job_imports WHERE bot='owl'").is_empty());
        self.assert_other_and_completed();
    }
}

#[test]
fn failed_bot_catalog_commit_keeps_prior_retention_and_its_exact_options() {
    for public in [false, true] {
        let mut f = Fixture::new();
        let h = f.home.path().to_owned();
        let conn = db::open(&h).unwrap();
        conn.execute_batch("CREATE TABLE refuse_bot_commit(name TEXT REFERENCES bots(name) DEFERRABLE INITIALLY DEFERRED); INSERT INTO refuse_bot_commit VALUES('owl');").unwrap();
        let result = if public {
            run(f
                .app
                .call("local", "hexbot.bots.delete", &json!({"name":"owl"})))
        } else {
            bot(&h, "hexbot.bots.delete")
        };
        assert!(result.is_err());
        assert!(journal(&h).is_none());
        f.assert_retained();
        f.assert_other_and_completed();
        assert_eq!(
            fs::read_to_string(h.join("profiles/owl/memories/MEMORY.md")).unwrap(),
            "ORIGINAL MEMORY"
        );
        assert_eq!(
            fs::read_to_string(h.join("profiles/owl/memories/notes/2026-10-15.md")).unwrap(),
            "ORIGINAL NOTES"
        );
        store::append(
            &h,
            &f.root,
            json!({"role":"user","text":"root still usable"}),
        )
        .unwrap();
        f.restart();
        f.assert_retained();
        store::append(
            &h,
            &f.root,
            json!({"role":"user","text":"root after restart"}),
        )
        .unwrap();
        conn.execute_batch("DROP TABLE refuse_bot_commit").unwrap();
        assert_eq!(
            run(f
                .app
                .call("local", "hexbot.bots.delete", &json!({"name":"owl"})))
            .unwrap(),
            json!({"deleted":true})
        );
        f.assert_purged();
        run(f.app.shutdown());
    }
}

#[test]
fn committed_bot_cleanup_faults_keep_exact_retained_targets_until_restart() {
    for fault in [
        "options",
        "native",
        "marker",
        "completion",
        "journal",
        "jobs",
        "job-imports",
        "profile",
    ] {
        eprintln!("composed bot retained cleanup fault={fault}");
        let mut f = Fixture::new();
        let h = f.home.path().to_owned();
        let native = store::open(&h).unwrap();
        let cat = db::open(&h).unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("keep"), "OUTSIDE").unwrap();
        match fault {
            "options"=>native.execute_batch("CREATE TRIGGER refuse_cleanup BEFORE UPDATE ON native_delete_options WHEN OLD.purge=0 AND NEW.purge=1 BEGIN SELECT RAISE(ABORT,'options promotion fault'); END").unwrap(),
            "native"=>native.execute_batch("CREATE TRIGGER refuse_cleanup BEFORE DELETE ON native_messages WHEN OLD.session_id='retained' BEGIN SELECT RAISE(ABORT,'native purge fault'); END").unwrap(),
            "marker"=>native.execute_batch(&format!("CREATE TRIGGER refuse_cleanup BEFORE DELETE ON native_delete_pending WHEN OLD.session_id='{}' BEGIN SELECT RAISE(ABORT,'final marker fault'); END",f.root)).unwrap(),
            "completion"=>native.execute_batch("CREATE TRIGGER refuse_cleanup BEFORE INSERT ON native_delete_completed WHEN NEW.session_id='retained' BEGIN SELECT RAISE(ABORT,'completion fault'); END").unwrap(),
            "journal"=>cat.execute_batch("CREATE TRIGGER refuse_cleanup BEFORE DELETE ON settings WHEN OLD.key='pending_bot_delete:owl' BEGIN SELECT RAISE(ABORT,'journal fault'); END").unwrap(),
            "jobs"=>native.execute_batch("CREATE TRIGGER refuse_cleanup BEFORE DELETE ON native_jobs WHEN OLD.bot='owl' BEGIN SELECT RAISE(ABORT,'jobs fault'); END").unwrap(),
            "job-imports"=>native.execute_batch("CREATE TRIGGER refuse_cleanup BEFORE DELETE ON native_job_imports WHEN OLD.bot='owl' BEGIN SELECT RAISE(ABORT,'imports fault'); END").unwrap(),
            "profile"=>std::os::unix::fs::symlink(outside.path(),h.join("runtime/deleted-bots")).unwrap(),
            _=>unreachable!(),
        }
        assert_eq!(
            run(f
                .app
                .call("local", "hexbot.bots.delete", &json!({"name":"owl"})))
            .unwrap(),
            json!({"deleted":true,"history_pending":true})
        );
        let decision = journal(&h).unwrap();
        assert_eq!(decision["committed"], true);
        for id in ["retained", "grandchild", "legacy-retained"] {
            assert!(
                decision["targets"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|t| t["id"] == id)
            );
        }
        assert_eq!(bot(&h, "hexbot.bots.create").unwrap_err().code, 4208);
        // Independent orphan cleanup still runs while this journal is pending.
        store::append(
            &h,
            "unrelated-orphan",
            json!({"role":"user","text":"orphan"}),
        )
        .unwrap();
        store::mark_deleted(&h, "unrelated-orphan").unwrap();
        f.restart();
        assert!(store::history(&h, "unrelated-orphan").unwrap().is_empty());
        assert_eq!(journal(&h).unwrap(), decision);
        for id in [&f.root[..], "retained", "grandchild", "legacy-retained"] {
            assert_eq!(
                store::append(&h, id, json!({"role":"user","text":"late"}))
                    .unwrap_err()
                    .code,
                4001
            );
        }
        if matches!(fault, "options" | "marker") {
            f.assert_retained();
        }
        f.assert_other_and_completed();
        assert_eq!(
            fs::read_to_string(outside.path().join("keep")).unwrap(),
            "OUTSIDE"
        );
        match fault {
            "journal" => cat.execute_batch("DROP TRIGGER refuse_cleanup").unwrap(),
            "profile" => fs::remove_file(h.join("runtime/deleted-bots")).unwrap(),
            _ => native.execute_batch("DROP TRIGGER refuse_cleanup").unwrap(),
        }
        f.restart();
        f.assert_purged();
        let made = bot(&h, "hexbot.bots.create").unwrap();
        let new = made["section"]["id"].as_str().unwrap();
        fs::create_dir_all(h.join("profiles/owl/memories")).unwrap();
        fs::write(h.join("profiles/owl/memories/MEMORY.md"), "NEW MEMORY").unwrap();
        store::append(&h, new, json!({"role":"user","text":"NEW HISTORY"})).unwrap();
        store::finish_deletes(&h).unwrap();
        store::finish_deletes(&h).unwrap();
        assert_eq!(
            fs::read_to_string(h.join("profiles/owl/memories/MEMORY.md")).unwrap(),
            "NEW MEMORY"
        );
        assert_eq!(store::history(&h, new).unwrap()[0]["text"], "NEW HISTORY");
        run(f.app.shutdown());
    }
}

#[test]
fn uncommitted_bot_journal_rolls_back_only_its_own_claims() {
    let mut f = Fixture::new();
    let h = f.home.path().to_owned();
    // Actual App retirement persists the journal and claim before Pi close. A
    // native INSERT fault aborts that phase without changing prior retention.
    store::open(&h).unwrap().execute_batch("CREATE TRIGGER refuse_retirement BEFORE INSERT ON native_delete_options WHEN NEW.session_id NOT IN ('retained','grandchild','legacy-retained') BEGIN SELECT RAISE(ABORT,'retirement metadata fault'); END").unwrap();
    assert!(
        run(f
            .app
            .call("local", "hexbot.bots.delete", &json!({"name":"owl"})))
        .is_err()
    );
    assert!(journal(&h).is_none());
    f.assert_retained();
    store::open(&h)
        .unwrap()
        .execute_batch("DROP TRIGGER refuse_retirement")
        .unwrap();
    // Simulate the persisted pre-close journal with a real runtime retirement,
    // then let startup resolve it. An independent committed child is terminal.
    catalog::prepare_bot_delete(&h, "local", "owl").unwrap();
    run(f.app.runtime.retire_stored("local", &f.root)).unwrap();
    f.restart();
    f.assert_retained();
    store::append(&h, &f.root, json!({"role":"user","text":"after rollback"})).unwrap();
    assert!(journal(&h).is_none());
    f.assert_other_and_completed();
    run(f.app.shutdown());
}

#[test]
fn successful_bot_delete_purges_owned_retention_and_preserves_other_data() {
    for public in [false, true] {
        let f = Fixture::new();
        f.assert_retained();
        let h = f.home.path();
        let result = if public {
            run(f
                .app
                .call("local", "hexbot.bots.delete", &json!({"name":"owl"})))
        } else {
            bot(h, "hexbot.bots.delete")
        };
        assert_eq!(result.unwrap(), json!({"deleted":true}));
        f.assert_purged();
        run(f.app.shutdown());
    }
}

/// The whole tombstone format of builds before retention (67e895d
/// `mark_deleted`): native_deleted rows for a root and its delegated tasks.
fn old_build_mark_deleted(h: &Path, stored: &str) {
    store::open(h).unwrap().execute("INSERT OR IGNORE INTO native_deleted WITH RECURSIVE tree(id) AS (SELECT ?1 UNION SELECT s.stored_id FROM native_sessions s JOIN tree t ON json_extract(s.options,'$.parent_session')=t.id) SELECT id FROM tree", [stored]).unwrap();
}

#[test]
fn old_build_bot_journal_reopens_every_unrecorded_target() {
    let mut f = Fixture::new();
    let h = f.home.path().to_owned();
    // Room, hidden and delegated sessions the earlier build also retired.
    let room = rooms::call(
        &h,
        "local",
        "hexbot.rooms.create",
        &json!({"name":"Room","members":["owl"]}),
    )
    .unwrap()
    .unwrap()["room"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    db::open(&h)
        .unwrap()
        .execute(
            "INSERT INTO room_sessions(room_id,bot,stored_session_id) VALUES(?,'owl','room-owl')",
            [&room],
        )
        .unwrap();
    let live = [
        f.root.clone(),
        "chat-delegate".into(),
        "hidden-run".into(),
        "room-owl".into(),
        "room-delegate".into(),
    ];
    let native = store::open(&h).unwrap();
    for (id, parent) in [
        ("chat-delegate", Some(f.root.as_str())),
        ("hidden-run", None),
        ("room-owl", None),
        ("room-delegate", Some("room-owl")),
    ] {
        let options = format!(
            "{{ \"parent_session\":{}, \"model\":\"frozen\", \"unrelated\": [3, 2, 1] }}",
            json!(parent)
        );
        native
            .execute(
                "INSERT INTO native_sessions VALUES(?,'local','owl','frozen prompt',?)",
                params![id, options],
            )
            .unwrap();
        store::append(
            &h,
            id,
            json!({"role":"user","text":format!("history {id}")}),
        )
        .unwrap();
        fs::write(
            store::session_dir(&h, id)
                .unwrap()
                .join("conversation-original.jsonl"),
            format!("raw {id}\n"),
        )
        .unwrap();
    }
    f.legacy.execute_batch("INSERT INTO sessions VALUES('legacy-room','room-owl',NULL); INSERT INTO messages(session_id,role,content) VALUES('legacy-room','user','legacy room');").unwrap();
    f.restart();
    let snapshot = |h: &Path, legacy: &rusqlite::Connection| {
        let read = |conn: &rusqlite::Connection, sql: &str| common::rows(conn, sql, &[]).unwrap();
        let native = store::open(h).unwrap();
        json!([
            read(&native, "SELECT * FROM native_sessions ORDER BY stored_id"),
            read(&native, "SELECT * FROM native_deleted ORDER BY session_id"),
            read(
                &native,
                "SELECT * FROM native_delete_options ORDER BY session_id"
            ),
            read(
                &native,
                "SELECT * FROM native_delete_completed ORDER BY session_id"
            ),
            read(legacy, "SELECT * FROM sessions ORDER BY id"),
            read(legacy, "SELECT * FROM messages ORDER BY id"),
            read(
                &db::open(h).unwrap(),
                "SELECT * FROM room_sessions ORDER BY room_id"
            ),
        ])
    };
    let before = snapshot(&h, &f.legacy);
    // The earlier build journaled exact targets without a claim ID, retired
    // each with Runtime.retire_stored, then stopped before the catalog COMMIT.
    // Captured from actual 67e895d preparation, with only its generated chat
    // UUID normalized. Do not manufacture an old journal with today's writer.
    let old = include_str!("fixtures/deletion/67e895d-bot-journal.json").replace("@chat@", &f.root);
    let decision: Value = serde_json::from_str(&old).unwrap();
    db::open(&h)
        .unwrap()
        .execute(
            "INSERT INTO settings(key,value) VALUES('pending_bot_delete:owl',?)",
            [&old],
        )
        .unwrap();
    for target in decision["targets"].as_array().unwrap() {
        old_build_mark_deleted(&h, target["id"].as_str().unwrap());
    }
    for id in &live {
        assert_eq!(store::session_dir(&h, id).unwrap_err().code, 4001);
    }
    for _ in 0..2 {
        f.restart();
        assert!(journal(&h).is_none());
        assert_eq!(snapshot(&h, &f.legacy), before);
        assert!(catalog::bot(&h, "local", "owl").is_ok());
        for id in &live {
            assert_eq!(
                store::history(&h, id).unwrap()[0]["text"],
                format!("history {id}")
            );
            assert_eq!(
                fs::read_to_string(
                    store::session_dir(&h, id)
                        .unwrap()
                        .join("conversation-original.jsonl")
                )
                .unwrap(),
                format!("raw {id}\n")
            );
        }
        // Recorded retention and completion stay closed.
        for id in ["retained", "grandchild", "legacy-retained", "completed"] {
            assert_eq!(store::session_dir(&h, id).unwrap_err().code, 4001);
        }
        f.assert_other_and_completed();
    }
    for id in &live {
        store::append(&h, id, json!({"role":"user","text":"after restart"})).unwrap();
        assert_eq!(store::history(&h, id).unwrap().len(), 2);
    }
    run(f.app.shutdown());
}
