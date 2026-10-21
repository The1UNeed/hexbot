use hexbot_core::{catalog, db, runtime_store, server::App};
use serde_json::{Value, json};
use std::{fs, path::Path, sync::Arc};

mod support;

const JOURNAL: &str = "pending_bot_delete:owl";

fn setup() -> support::TestHome {
    let home = support::TestHome::new();
    db::migrate(home.path()).unwrap();
    let conn = db::open(home.path()).unwrap();
    conn.execute_batch(
        "INSERT INTO users(id,display_name,role,created_at) VALUES('alice','Alice','admin',0)",
    )
    .unwrap();
    conn.execute(
        "INSERT INTO settings(key,value) VALUES('workspace_dir',?)",
        [json!(home.workspace()).to_string()],
    )
    .unwrap();
    home
}

fn call(home: &Path, method: &str) -> hexbot_core::Result<Value> {
    catalog::call(home, "alice", method, &json!({"name":"owl"})).unwrap()
}

fn app(home: &Path) -> Arc<App> {
    App::new(
        home.into(),
        "127.0.0.1:0".parse().unwrap(),
        home.join("unused-pi"),
        None,
    )
    .unwrap()
}

fn journal(home: &Path) -> String {
    db::open(home)
        .unwrap()
        .query_row("SELECT value FROM settings WHERE key=?", [JOURNAL], |r| {
            r.get(0)
        })
        .unwrap()
}

fn save_new_data(home: &Path, section: &str) {
    let dir = home.join("profiles/owl/memories");
    fs::create_dir_all(dir.join("notes")).unwrap();
    fs::write(dir.join("MEMORY.md"), "NEW BOT MEMORY").unwrap();
    fs::write(dir.join("notes/2026-10-15.md"), "NEW BOT NOTES").unwrap();
    runtime_store::append(home, section, json!({"role":"user","text":"new dialogue"})).unwrap();
    runtime_store::open(home).unwrap().execute_batch("INSERT INTO native_jobs VALUES('new-job','alice','owl','{}'); INSERT INTO native_job_imports VALUES('owl');").unwrap();
}

fn assert_new_data(home: &Path, section: &str) {
    assert!(catalog::bot(home, "alice", "owl").is_ok());
    assert!(catalog::section(home, "alice", section).is_ok());
    assert_eq!(
        fs::read_to_string(home.join("profiles/owl/memories/MEMORY.md")).unwrap(),
        "NEW BOT MEMORY"
    );
    assert_eq!(
        fs::read_to_string(home.join("profiles/owl/memories/notes/2026-10-15.md")).unwrap(),
        "NEW BOT NOTES"
    );
    assert_eq!(
        runtime_store::history(home, section).unwrap()[0]["text"],
        "new dialogue"
    );
    let native = runtime_store::open(home).unwrap();
    for table in ["native_jobs", "native_job_imports"] {
        assert_eq!(
            native
                .query_row(
                    &format!("SELECT COUNT(*) FROM {table} WHERE bot='owl'"),
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
    }
}

#[tokio::test]
async fn bot_delete_pending_cleanup_blocks_reuse_until_restart_finishes_it() {
    for table in ["settings", "native_jobs", "native_job_imports"] {
        let home = setup();
        let h = home.path();
        let running = app(h);
        running
            .call("alice", "hexbot.bots.create", &json!({"name":"owl"}))
            .await
            .unwrap();
        runtime_store::open(h).unwrap().execute_batch("INSERT INTO native_jobs VALUES('old-job','alice','owl','{}'); INSERT INTO native_job_imports VALUES('owl');").unwrap();
        let fault_db = if table == "settings" {
            db::open(h).unwrap()
        } else {
            runtime_store::open(h).unwrap()
        };
        let condition = if table == "settings" {
            " WHEN OLD.key='pending_bot_delete:owl'"
        } else {
            ""
        };
        fault_db.execute_batch(&format!("CREATE TRIGGER stop_cleanup BEFORE DELETE ON {table}{condition} BEGIN SELECT RAISE(ABORT,'controlled cleanup failure'); END;")).unwrap();
        assert_eq!(
            running
                .call("alice", "hexbot.bots.delete", &json!({"name":"owl"}))
                .await
                .unwrap(),
            json!({"deleted":true,"history_pending":true})
        );
        if table == "settings" {
            assert!(!h.join("profiles/owl").try_exists().unwrap());
        }
        let error = running
            .call("alice", "hexbot.bots.create", &json!({"name":"owl"}))
            .await
            .expect_err("a pending delete must reserve its bot name");
        assert_eq!(error.code, 4208);
        assert!(
            error.message.contains("deletion is still pending"),
            "{error}"
        );
        assert!(serde_json::from_str::<Value>(&journal(h)).unwrap()["committed"] == true);
        assert!(runtime_store::finish_deletes(h).is_err());
        fault_db.execute_batch("DROP TRIGGER stop_cleanup").unwrap();
        running.shutdown().await;
        drop(running);
        let restarted = app(h);
        let created = restarted
            .call("alice", "hexbot.bots.create", &json!({"name":"owl"}))
            .await
            .unwrap();
        let section = created["section"]["id"].as_str().unwrap();
        save_new_data(h, section);
        runtime_store::finish_deletes(h).unwrap();
        runtime_store::finish_deletes(h).unwrap();
        assert_new_data(h, section);
        restarted.shutdown().await;
        drop(restarted);
        let again = app(h);
        assert_new_data(h, section);
        again.shutdown().await;
    }
}

#[tokio::test]
async fn bot_delete_old_committed_journal_preserves_a_recreated_bot() {
    let home = setup();
    let h = home.path();
    call(h, "hexbot.bots.create").unwrap();
    let conn = db::open(h).unwrap();
    conn.execute_batch("CREATE TRIGGER stop_cleanup BEFORE DELETE ON settings WHEN OLD.key='pending_bot_delete:owl' BEGIN SELECT RAISE(ABORT,'controlled cleanup failure'); END;").unwrap();
    assert_eq!(
        call(h, "hexbot.bots.delete").unwrap()["history_pending"],
        true
    );
    let mut old_journal: Value = serde_json::from_str(&journal(h)).unwrap();
    old_journal.as_object_mut().unwrap().remove("name_reserved");
    let old_journal = old_journal.to_string();
    conn.execute_batch("DROP TRIGGER stop_cleanup").unwrap();
    // Reproduce the old build's allowed reuse, then restore its stale journal.
    conn.execute("DELETE FROM settings WHERE key=?", [JOURNAL])
        .unwrap();
    let created = call(h, "hexbot.bots.create").unwrap();
    let section = created["section"]["id"].as_str().unwrap();
    save_new_data(h, section);
    conn.execute("INSERT INTO settings VALUES(?,?)", [JOURNAL, &old_journal])
        .unwrap();
    let error = runtime_store::finish_deletes(h)
        .expect_err("a stale journal must not purge a new generation");
    assert!(error.message.contains("catalog bot exists"), "{error}");
    assert_new_data(h, section);
    assert_eq!(journal(h), old_journal);
    assert!(call(h, "hexbot.bots.delete").is_err());
    catalog::rollback_bot_delete(h, "owl").unwrap();
    assert_eq!(journal(h), old_journal);
    let restarted = app(h);
    assert_new_data(h, section);
    assert_eq!(journal(h), old_journal);
    // The recreated bot's chat still resolves while that journal stays.
    let chat = restarted
        .call("alice", "hexbot.sections.create", &json!({"bot":"owl"}))
        .await
        .unwrap();
    assert_eq!(chat["section"]["id"], section);
    restarted.shutdown().await;
    // After the old decision is explicitly resolved, ordinary cleanup is harmless.
    conn.execute("DELETE FROM settings WHERE key=?", [JOURNAL])
        .unwrap();
    runtime_store::finish_deletes(h).unwrap();
    assert_new_data(h, section);
}

#[test]
fn bot_delete_prepare_is_idempotent_and_failed_commit_keeps_the_original() {
    let home = setup();
    let h = home.path();
    let created = call(h, "hexbot.bots.create").unwrap();
    let section = created["section"]["id"].as_str().unwrap();
    save_new_data(h, section);
    let targets = catalog::prepare_bot_delete(h, "alice", "owl").unwrap();
    assert_eq!(
        catalog::prepare_bot_delete(h, "alice", "owl").unwrap(),
        targets
    );
    runtime_store::mark_deleted(h, section).unwrap();
    let conn = db::open(h).unwrap();
    conn.execute_batch("CREATE TRIGGER stop_commit BEFORE DELETE ON bots BEGIN SELECT RAISE(ABORT,'controlled catalog failure'); END;").unwrap();
    assert!(
        call(h, "hexbot.bots.delete")
            .unwrap_err()
            .message
            .contains("controlled catalog failure")
    );
    runtime_store::finish_deletes(h).unwrap();
    assert_new_data(h, section);
    assert!(runtime_store::session_dir(h, section).is_ok());
    conn.execute_batch("DROP TRIGGER stop_commit").unwrap();
    assert_eq!(
        call(h, "hexbot.bots.delete").unwrap(),
        json!({"deleted":true})
    );
    let replacement = call(h, "hexbot.bots.create").unwrap();
    assert_ne!(replacement["section"]["id"], section);
    runtime_store::finish_deletes(h).unwrap();
    assert!(catalog::bot(h, "alice", "owl").is_ok());
}

#[test]
fn bot_delete_repeated_preparation_keeps_original_targets_and_adds_new_sessions() {
    let home = setup();
    let h = home.path();
    call(h, "hexbot.bots.create").unwrap();
    let native = runtime_store::open(h).unwrap();
    native.execute("INSERT INTO native_sessions(stored_id,owner,bot,prompt) VALUES('original-hidden','alice','owl','')", []).unwrap();
    let first = catalog::prepare_bot_delete(h, "alice", "owl").unwrap();
    assert!(first.iter().any(|target| target["id"] == "original-hidden"));
    native.execute_batch("DELETE FROM native_sessions WHERE stored_id='original-hidden'; INSERT INTO native_sessions(stored_id,owner,bot,prompt) VALUES('late-hidden','alice','owl','');").unwrap();
    runtime_store::append(
        h,
        "original-hidden",
        json!({"role":"user","text":"original history"}),
    )
    .unwrap();
    let next = catalog::prepare_bot_delete(h, "alice", "owl").unwrap();
    for id in ["original-hidden", "late-hidden"] {
        assert!(
            next.iter().any(|target| target["id"] == id),
            "lost target {id}"
        );
    }
    assert_eq!(
        call(h, "hexbot.bots.delete").unwrap(),
        json!({"deleted":true})
    );
    assert!(
        runtime_store::history(h, "original-hidden")
            .unwrap()
            .is_empty()
    );
}

#[test]
fn bot_delete_recovery_and_create_can_run_concurrently_without_losing_the_new_profile() {
    for _ in 0..16 {
        let home = setup();
        let h = home.path();
        call(h, "hexbot.bots.create").unwrap();
        let conn = db::open(h).unwrap();
        conn.execute_batch("CREATE TRIGGER stop_cleanup BEFORE DELETE ON settings WHEN OLD.key='pending_bot_delete:owl' BEGIN SELECT RAISE(ABORT,'controlled cleanup failure'); END;").unwrap();
        call(h, "hexbot.bots.delete").unwrap();
        conn.execute_batch("DROP TRIGGER stop_cleanup").unwrap();
        let barrier = std::sync::Barrier::new(4);
        let created = std::thread::scope(|scope| {
            let first = scope.spawn(|| {
                barrier.wait();
                runtime_store::finish_deletes(h)
            });
            let second = scope.spawn(|| {
                barrier.wait();
                runtime_store::finish_deletes(h)
            });
            let create = scope.spawn(|| {
                barrier.wait();
                let result = call(h, "hexbot.bots.create");
                if let Ok(ref value) = result {
                    save_new_data(h, value["section"]["id"].as_str().unwrap());
                }
                result
            });
            barrier.wait();
            first.join().unwrap().unwrap();
            second.join().unwrap().unwrap();
            create.join().unwrap()
        });
        let created = match created {
            Ok(value) => value,
            Err(error) => {
                assert_eq!(error.code, 4208);
                let value = call(h, "hexbot.bots.create").unwrap();
                save_new_data(h, value["section"]["id"].as_str().unwrap());
                value
            }
        };
        runtime_store::finish_deletes(h).unwrap();
        assert_new_data(h, created["section"]["id"].as_str().unwrap());
    }
}

#[test]
fn bot_delete_guard_keeps_name_profile_validation_and_real_db_errors() {
    let home = setup();
    let h = home.path();
    for name in ["root", "Owl", "../owl", "-owl"] {
        assert_eq!(
            catalog::call(h, "alice", "hexbot.bots.create", &json!({"name":name}))
                .unwrap()
                .unwrap_err()
                .code,
            4202
        );
    }
    assert_eq!(
        catalog::call(h, "alice", "hexbot.bots.create", &json!({"name":""}))
            .unwrap()
            .unwrap_err()
            .code,
        4200
    );
    fs::create_dir_all(h.join("profiles/owl")).unwrap();
    fs::write(h.join("profiles/owl/keep"), "existing profile").unwrap();
    assert!(
        call(h, "hexbot.bots.create")
            .unwrap_err()
            .message
            .contains("profile already exists")
    );
    assert_eq!(
        fs::read_to_string(h.join("profiles/owl/keep")).unwrap(),
        "existing profile"
    );
    fs::remove_dir_all(h.join("profiles/owl")).unwrap();
    db::open(h)
        .unwrap()
        .execute_batch("ALTER TABLE settings RENAME TO unavailable_settings")
        .unwrap();
    assert!(call(h, "hexbot.bots.create").is_err());
    assert!(!h.join("profiles/owl").try_exists().unwrap());
}

#[test]
fn bot_delete_legacy_journal_preserves_a_profile_of_unknown_generation() {
    let home = setup();
    let h = home.path();
    fs::create_dir_all(h.join("profiles/owl/memories")).unwrap();
    fs::write(
        h.join("profiles/owl/memories/MEMORY.md"),
        "unknown new memory",
    )
    .unwrap();
    db::open(h)
        .unwrap()
        .execute(
            "INSERT INTO settings VALUES(?,?)",
            [
                JOURNAL,
                r#"{"committed":true,"targets":[{"id":"unknown-history","owner":"alice"}]}"#,
            ],
        )
        .unwrap();
    runtime_store::open(h)
        .unwrap()
        .execute(
            "INSERT INTO native_jobs VALUES('unknown-job','alice','owl','{}')",
            [],
        )
        .unwrap();
    runtime_store::append(
        h,
        "unknown-history",
        json!({"role":"user","text":"unknown new history"}),
    )
    .unwrap();
    runtime_store::mark_deleted(h, "unknown-history").unwrap();
    let other = catalog::call(h, "alice", "hexbot.bots.create", &json!({"name":"fox"}))
        .unwrap()
        .unwrap();
    let other_section = other["section"]["id"].as_str().unwrap();
    runtime_store::append(
        h,
        other_section,
        json!({"role":"user","text":"other history"}),
    )
    .unwrap();
    runtime_store::mark_deleted(h, other_section).unwrap();
    // An unrelated bot retirement and an orphaned section must recover even
    // while the ambiguous journal above remains unresolved.
    catalog::prepare_bot_delete(h, "alice", "fox").unwrap();
    runtime_store::append(h, "gone", json!({"role":"user","text":"orphaned history"})).unwrap();
    runtime_store::mark_deleted(h, "gone").unwrap();
    let error = runtime_store::finish_deletes(h).unwrap_err();
    assert!(
        error.message.contains("profile ownership is unknown"),
        "{error}"
    );
    assert_eq!(
        runtime_store::history(h, "unknown-history").unwrap()[0]["text"],
        "unknown new history"
    );
    assert_eq!(
        runtime_store::history(h, other_section).unwrap()[0]["text"],
        "other history"
    );
    assert!(runtime_store::session_dir(h, other_section).is_ok());
    assert!(runtime_store::history(h, "gone").unwrap().is_empty());
    assert_eq!(
        fs::read_to_string(h.join("profiles/owl/memories/MEMORY.md")).unwrap(),
        "unknown new memory"
    );
    assert_eq!(
        runtime_store::open(h)
            .unwrap()
            .query_row("SELECT COUNT(*) FROM native_jobs", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert!(call(h, "hexbot.bots.create").is_err());
    assert_eq!(
        serde_json::from_str::<Value>(&journal(h)).unwrap()["committed"],
        true
    );
}
