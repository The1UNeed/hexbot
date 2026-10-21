use hexbot_core::{catalog, db, runtime_store as store, server::App};
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};
use std::{
    fs, thread,
    time::{Duration, Instant},
};

struct Fixture {
    home: tempfile::TempDir,
    app: std::sync::Arc<App>,
    source: String,
    other: String,
    bytes: Vec<u8>,
    history: Vec<Value>,
    usage: Value,
    version: i64,
    frozen: (String, String),
}

impl Fixture {
    fn new() -> Self {
        let home = tempfile::tempdir().unwrap();
        let h = home.path();
        let app = App::new(
            h.into(),
            "127.0.0.1:0".parse().unwrap(),
            h.join("unused-pi"),
            None,
        )
        .unwrap();
        for bot in ["owl", "fox"] {
            catalog::call(h, "local", "hexbot.bots.create", &json!({"name":bot}))
                .unwrap()
                .unwrap();
        }
        let cat = db::open(h).unwrap();
        let section = |bot| {
            cat.query_row("SELECT id FROM sections WHERE bot=?", [bot], |r| r.get(0))
                .unwrap()
        };
        let source: String = section("owl");
        let other: String = section("fox");
        cat.execute("UPDATE sections SET title='Dreams' WHERE id=?", [&source])
            .unwrap();
        // Public deletion is only for peer threads; the deleted section is one.
        cat.execute("UPDATE sections SET peer_bot='owl' WHERE id=?", [&other])
            .unwrap();
        cat.execute_batch("INSERT INTO dreams(id,bot,started_at,status,summary) VALUES('dream','owl',1,'completed','REPORT')").unwrap();
        let native = store::open(h).unwrap();
        for (id, bot) in [(&source, "owl"), (&other, "fox")] {
            native.execute("INSERT INTO native_sessions VALUES(?,'local',?,'Frozen prompt','{\"model\":\"original\",\"input_chain\":{\"requester\":\"local\"}}')", params![id, bot]).unwrap();
        }
        store::append(h, &other, json!({"role":"user","text":"Unrelated history"})).unwrap();
        let mut lines = vec![json!({"type":"session","version":3,"id":source,"cwd":h}).to_string()];
        let mut parent = Value::Null;
        let mut add = |id: String, message: Value| {
            lines.push(
                json!({"type":"message","id":id,"parentId":parent,"message":message}).to_string(),
            );
            parent = json!(id);
        };
        add(
            "report".into(),
            json!({"role":"assistant","content":[{"type":"text","text":"REPORT"}],"timestamp":1000}),
        );
        // Real copied rows provide the same SQLite scheduling window as the
        // independent probe. No sleeps, synthetic state flags or fake log files.
        for i in 0..400 {
            add(
                format!("owner-{i}"),
                json!({"role":"user","content":[{"type":"text","text":format!("Keep conversation {i}")}],"timestamp":2000}),
            );
        }
        add(
            "reply".into(),
            json!({"role":"assistant","content":[{"type":"text","text":"Keep answer"}],"provider":"test","model":"original","timestamp":3000,"usage":{"input":10,"output":2,"cacheRead":3,"cacheWrite":4,"cost":{"total":0.37}}}),
        );
        let path = store::session_dir(h, &source)
            .unwrap()
            .join("conversation.jsonl");
        fs::write(&path, format!("{}\n", lines.join("\n"))).unwrap();
        store::reconcile(h, "owl", &source, "local").unwrap();
        // This is an already imported Dream report, as produced by dreaming.
        native.execute("UPDATE native_messages SET message_json=json_set(message_json,'$.dream',json('true')) WHERE session_id=? AND seq=1", [&source]).unwrap();
        let bytes = fs::read(path).unwrap();
        let history = store::history(h, &source).unwrap();
        let usage = store::usage(h, &source).unwrap();
        let version = native
            .query_row(
                "SELECT version FROM native_history_versions WHERE session_id=?",
                [&source],
                |r| r.get(0),
            )
            .unwrap();
        let frozen = native
            .query_row(
                "SELECT prompt,options FROM native_sessions WHERE stored_id=?",
                [&source],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        Self {
            home,
            app,
            source,
            other,
            bytes,
            history,
            usage,
            version,
            frozen,
        }
    }

    fn unchanged(&self) {
        let h = self.home.path();
        assert_eq!(
            fs::read(
                h.join("runtime/sessions")
                    .join(&self.source)
                    .join("conversation.jsonl")
            )
            .unwrap(),
            self.bytes
        );
        let history = store::history(h, &self.source).unwrap();
        assert_eq!(history.len(), self.history.len());
        for (before, after) in self.history.iter().zip(history) {
            assert_eq!(*before, after);
        }
        assert_eq!(store::usage(h, &self.source).unwrap(), self.usage);
        let native = store::open(h).unwrap();
        assert_eq!(
            native
                .query_row(
                    "SELECT version FROM native_history_versions WHERE session_id=?",
                    [&self.source],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            self.version
        );
        assert_eq!(
            native
                .query_row(
                    "SELECT prompt,options FROM native_sessions WHERE stored_id=?",
                    [&self.source],
                    |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
                )
                .unwrap(),
            self.frozen
        );
    }

    fn no_orphan(&self) {
        let h = self.home.path();
        let native = store::open(h).unwrap();
        for table in [
            "native_messages",
            "native_pi_journal",
            "native_usage",
            "native_fresh",
            "native_prompt_intents",
            "native_history_versions",
            "native_summaries",
            "native_quarantine",
            "native_unrecovered",
        ] {
            let count: i64 = native
                .query_row(
                    &format!("SELECT count(*) FROM {table} WHERE session_id NOT IN (?1,?2)"),
                    params![self.source, self.other],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(count, 0, "orphan in {table}");
        }
        for dir in fs::read_dir(h.join("runtime/sessions")).unwrap() {
            let id = dir.unwrap().file_name();
            assert!(
                id == self.source.as_str() || id == self.other.as_str(),
                "orphan directory {id:?}"
            );
        }
        assert_eq!(
            db::open(h)
                .unwrap()
                .query_row(
                    "SELECT count(*) FROM settings WHERE key='dream_chat_adoptions'",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
    }
}

#[derive(Clone, Copy, Debug)]
enum Fault {
    None,
    Fresh,
    Copy,
    Reconcile,
    Catalog,
    Adoption,
    Commit,
}

fn install(f: &Fixture, fault: Fault) {
    let cat = db::open(f.home.path()).unwrap();
    let native = store::open(f.home.path()).unwrap();
    let target = format!("NEW.session_id NOT IN ('{}','{}')", f.source, f.other);
    match fault {
        Fault::None => (),
        Fault::Fresh => native.execute_batch(&format!("CREATE TRIGGER fault BEFORE INSERT ON native_fresh WHEN {target} BEGIN SELECT RAISE(ABORT,'fresh fault'); END")).unwrap(),
        Fault::Copy => native.execute_batch(&format!("CREATE TRIGGER fault BEFORE INSERT ON native_messages WHEN {target} AND NEW.seq=350 BEGIN SELECT RAISE(ABORT,'copy fault'); END")).unwrap(),
        Fault::Reconcile => native.execute_batch(&format!("CREATE TRIGGER fault BEFORE INSERT ON native_pi_journal WHEN {target} BEGIN SELECT RAISE(ABORT,'reconcile fault'); END")).unwrap(),
        Fault::Catalog => cat.execute_batch("CREATE TRIGGER fault BEFORE INSERT ON sections WHEN NEW.bot='owl' BEGIN SELECT RAISE(ABORT,'catalog fault'); END").unwrap(),
        Fault::Adoption => cat.execute_batch("CREATE TRIGGER fault BEFORE INSERT ON settings WHEN NEW.key='dream_chat_adoptions' BEGIN SELECT RAISE(ABORT,'adoption fault'); END").unwrap(),
        Fault::Commit => cat.execute_batch("CREATE TABLE commit_parent(id TEXT PRIMARY KEY); CREATE TABLE commit_fault(id TEXT REFERENCES commit_parent(id) DEFERRABLE INITIALLY DEFERRED); CREATE TRIGGER fault AFTER INSERT ON sections WHEN NEW.bot='owl' BEGIN INSERT INTO commit_fault VALUES(NEW.id); END").unwrap(),
    }
}

fn wait_for<T>(mut read: impl FnMut() -> Option<T>, message: &str) -> T {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(value) = read() {
            return value;
        }
        assert!(Instant::now() < deadline, "{message}");
        thread::yield_now();
    }
}

fn race(public: bool, purge: bool, fault: Fault) {
    let f = Fixture::new();
    install(&f, fault);
    let h = f.home.path();
    let native = store::open(h).unwrap();
    native.execute_batch(&format!("CREATE TABLE disposition_barrier(n INTEGER); INSERT INTO disposition_barrier VALUES(0); CREATE TRIGGER observe_disposition AFTER UPDATE ON native_delete_options WHEN NEW.session_id='{}' BEGIN UPDATE disposition_barrier SET n=n+1; END", f.other)).unwrap();
    let ah = h.to_owned();
    let fork = thread::spawn(move || catalog::chat_section(&ah, "local", "owl"));
    let target: String = wait_for(
        || {
            native.query_row("SELECT session_id FROM native_messages WHERE session_id NOT IN (?1,?2) LIMIT 1", params![f.source,f.other], |r| r.get(0)).optional().unwrap()
        },
        "fork did not copy a target row",
    );
    assert!(
        store::owned_sessions(h, "owl")
            .unwrap()
            .iter()
            .all(|row| row["stored_id"] != target)
    );
    assert!(!store::descendants(h, &f.source).unwrap().contains(&target));
    let bh = h.to_owned();
    let app = f.app.clone();
    let id = f.other.clone();
    let delete = thread::spawn(move || {
        let args = json!({"id":id,"purge_memory":purge});
        let start = Instant::now();
        let result = if public {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap()
                .block_on(app.call("local", "hexbot.sections.delete", &args))
        } else {
            catalog::call(&bh, "local", "hexbot.sections.delete", &args).unwrap()
        };
        (result, start.elapsed())
    });
    wait_for(
        || {
            (native
                .query_row("SELECT n FROM disposition_barrier", [], |r| {
                    r.get::<_, i64>(0)
                })
                .unwrap()
                > 0)
            .then_some(())
        },
        "delete did not persist its exact-ID disposition",
    );
    let adopted = fork.join().unwrap();
    let (deleted, elapsed) = delete.join().unwrap();
    // The deletion waits for the fork's catalog writer, so it takes as long as
    // the copy. A deadlock would show as an error: the fork's cleanup waits on
    // the product boundary with no timeout, and the deletion holding it gives
    // up on the catalog writer with SQLite's busy error.
    assert!(
        deleted.is_ok(),
        "public={public} purge={purge} {fault:?} unrelated delete failed after {elapsed:?}: {deleted:?}"
    );
    assert!(catalog::section(h, "local", &f.other).is_err());
    if purge {
        assert!(store::history(h, &f.other).unwrap().is_empty());
    } else {
        assert_eq!(
            store::history(h, &f.other).unwrap()[0]["text"],
            "Unrelated history"
        );
    }
    assert!(store::append(h, &f.other, json!({"role":"user","text":"late"})).is_err());
    f.unchanged();
    assert_eq!(
        db::open(h)
            .unwrap()
            .query_row("SELECT count(*) FROM bot_incidents", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    if matches!(fault, Fault::None) {
        assert_eq!(adopted.unwrap()["id"], target);
        assert!(
            h.join("runtime/sessions")
                .join(&target)
                .join("conversation.jsonl")
                .is_file()
        );
        assert_eq!(store::usage(h, &target).unwrap()["total_tokens"], 0);
    } else {
        assert!(adopted.is_err());
        f.no_orphan();
        // Rollback leaves the original source usable with its frozen config.
        store::append(
            h,
            &f.source,
            json!({"role":"user","text":"usable after rollback"}),
        )
        .unwrap();
    }
    eprintln!(
        "public={public} purge={purge} fault={fault:?} target={target} deletion_ms={}",
        elapsed.as_millis()
    );
}

#[test]
fn public_delete_during_failed_catalog_fork() {
    race(true, false, Fault::Catalog);
}
#[test]
fn direct_delete_during_failed_catalog_fork() {
    race(false, false, Fault::Catalog);
}
#[test]
fn public_delete_during_failed_copy_fork() {
    race(true, false, Fault::Copy);
}
#[test]
fn direct_delete_during_failed_copy_fork() {
    race(false, false, Fault::Copy);
}
#[test]
fn public_delete_during_failed_reconciliation_fork() {
    race(true, false, Fault::Reconcile);
}
#[test]
fn direct_delete_during_failed_reconciliation_fork() {
    race(false, false, Fault::Reconcile);
}
#[test]
fn healthy_fork_allows_public_and_direct_retention_and_purge() {
    for public in [true, false] {
        for purge in [false, true] {
            race(public, purge, Fault::None);
        }
    }
}

#[test]
fn every_failed_fork_boundary_cleans_artifacts_and_allows_retry() {
    for fault in [
        Fault::Fresh,
        Fault::Copy,
        Fault::Reconcile,
        Fault::Catalog,
        Fault::Adoption,
        Fault::Commit,
    ] {
        let f = Fixture::new();
        install(&f, fault);
        let h = f.home.path();
        assert!(
            catalog::chat_section(h, "local", "owl").is_err(),
            "{fault:?}"
        );
        f.no_orphan();
        f.unchanged();
        for conn in [db::open(h).unwrap(), store::open(h).unwrap()] {
            conn.execute_batch("DROP TRIGGER IF EXISTS fault").unwrap();
        }
        let chosen = catalog::chat_section(h, "local", "owl").unwrap();
        assert_ne!(chosen["id"], f.source);
        assert_eq!(
            catalog::chat_section(h, "local", "owl").unwrap()["id"],
            chosen["id"]
        );
        assert_eq!(
            store::usage(h, chosen["id"].as_str().unwrap()).unwrap()["total_tokens"],
            0
        );
        f.unchanged();
    }
}

#[test]
fn failed_context_write_cleans_the_partially_copied_target() {
    let f = Fixture::new();
    let h = f.home.path();
    let native = store::open(h).unwrap();
    let ah = h.to_owned();
    let fork = thread::spawn(move || catalog::chat_section(&ah, "local", "owl"));
    let target: String = wait_for(
        || {
            native.query_row("SELECT session_id FROM native_messages WHERE session_id NOT IN (?1,?2) LIMIT 1", params![f.source,f.other], |r| r.get(0)).optional().unwrap()
        },
        "fork did not begin copying",
    );
    // A regular source log, with a directory obstructing only the new target's
    // atomic rename. The original source and its path remain untouched.
    fs::create_dir_all(
        h.join("runtime/sessions")
            .join(&target)
            .join("conversation.jsonl"),
    )
    .unwrap();
    let error = fork.join().unwrap().unwrap_err();
    assert!(error.message.contains("directory"), "{error:?}");
    f.no_orphan();
    f.unchanged();
    assert_ne!(
        catalog::chat_section(h, "local", "owl").unwrap()["id"],
        f.source
    );
}

#[test]
fn no_fork_and_parse_errors_leave_no_derived_artifacts() {
    for mode in ["missing", "no_report", "invalid"] {
        let f = Fixture::new();
        let h = f.home.path();
        let path = h
            .join("runtime/sessions")
            .join(&f.source)
            .join("conversation.jsonl");
        match mode {
            "missing" => fs::remove_file(&path).unwrap(),
            "no_report" => fs::write(
                &path,
                String::from_utf8(f.bytes.clone())
                    .unwrap()
                    .replace("REPORT", "Other text"),
            )
            .unwrap(),
            _ => fs::write(&path, b"invalid json\n").unwrap(),
        }
        let before = fs::read(&path).ok();
        let result = catalog::chat_section(h, "local", "owl");
        if mode == "invalid" {
            assert!(result.is_err());
        } else {
            assert_eq!(result.unwrap()["id"], f.source);
            assert_eq!(
                store::open(h)
                    .unwrap()
                    .query_row("SELECT count(*) FROM native_deleted", [], |r| r
                        .get::<_, i64>(0))
                    .unwrap(),
                0
            );
        }
        f.no_orphan();
        assert_eq!(fs::read(&path).ok(), before);
        assert_eq!(store::history(h, &f.source).unwrap(), f.history);
        assert_eq!(store::usage(h, &f.source).unwrap(), f.usage);
    }
}
