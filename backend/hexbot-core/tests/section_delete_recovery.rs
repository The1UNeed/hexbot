//! Public peer-thread deletion effects across the two SQLite commits and restart.
use hexbot_core::{catalog, db, runtime_store as store, server::App};
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use std::{fs, path::Path, sync::Arc};

mod support;

fn setup() -> support::TestHome {
    let home = support::TestHome::new();
    db::migrate(home.path()).unwrap();
    db::open(home.path()).unwrap().execute_batch(
        "INSERT INTO users(id,display_name,role,created_at) VALUES('alice','Alice','admin',0),('bob','Bob','member',0);
         INSERT INTO bots(name,owner_id) VALUES('owl','alice'),('cat','alice'),('fox','bob');
         INSERT INTO sections(id,bot,owner_id,title,peer_bot) VALUES('chat','owl','alice','General','cat'),('other','owl','alice','Other',NULL),('cat-chat','cat','alice','General','owl'),('bob-chat','fox','bob','General',NULL);
         INSERT INTO settings VALUES('one_chat_per_bot','true');"
    ).unwrap();
    home
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
fn native(home: &Path, id: &str, bot: &str, owner: &str, parent: Option<&str>) {
    let options = json!({"parent_session":parent,"provider":"test","model":"frozen","tools":["read"],"chain":{"requester":"original"}}).to_string();
    store::open(home).unwrap().execute("INSERT INTO native_sessions(stored_id,bot,owner,prompt,options) VALUES(?,?,?,'FROZEN PREFIX',?)", params![id,bot,owner,options]).unwrap();
    let raw = format!(
        "{}\n{}\n",
        json!({"type":"session","version":3,"id":id,"timestamp":"2026-10-16T00:00:00Z","cwd":home}),
        json!({"type":"message","id":format!("msg-{id}"),"parentId":null,"message":{"role":"user","content":[{"type":"text","text":format!("native {id}")}],"timestamp":1000}})
    );
    fs::write(
        store::session_dir(home, id)
            .unwrap()
            .join("conversation.jsonl"),
        raw,
    )
    .unwrap();
    store::reconcile(home, bot, id, owner).unwrap();
}
fn fixture(home: &Path) {
    for (id, bot, owner, parent) in [
        ("chat", "owl", "alice", None),
        ("delegate", "owl", "alice", Some("chat")),
        ("grandchild", "owl", "alice", Some("delegate")),
        ("other", "owl", "alice", None),
        ("cat-chat", "cat", "alice", None),
        ("bob-chat", "fox", "bob", None),
    ] {
        native(home, id, bot, owner, parent);
    }
    for bot in ["owl", "cat", "fox"] {
        let dir = home.join("profiles").join(bot).join("memories/notes");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.parent().unwrap().join("MEMORY.md"),
            format!("memory {bot}"),
        )
        .unwrap();
        fs::write(dir.join("2026-10-16.md"), format!("notes {bot}")).unwrap();
    }
    legacy(home).execute_batch(
        "CREATE TABLE sessions(id TEXT PRIMARY KEY,session_key TEXT,parent_session_id TEXT,owner_id TEXT,bot TEXT);
         CREATE TABLE messages(id INTEGER PRIMARY KEY,session_id TEXT,role TEXT,content TEXT);
         INSERT INTO sessions VALUES('old-root','chat',NULL,'alice','owl'),('old-cont','chat','old-root','alice','owl'),('old-child','delegate','old-cont','alice','owl'),('legacy-leaf','legacy-leaf-key','old-child','alice','owl'),('unrelated','other',NULL,'alice','owl'),('foreign','bob-chat','old-root','bob','fox'),('foreign-child','foreign-child-key','foreign','bob','fox');
         INSERT INTO messages(session_id,role,content) SELECT id,'user','legacy '||id FROM sessions;"
    ).unwrap();
    store::open(home).unwrap().execute_batch("INSERT INTO native_usage(session_id,owner_id,bot,model,provider,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cost,timestamp) VALUES('chat','alice','owl','m','p',1,2,3,4,0.1,1);").unwrap();
}
fn legacy(home: &Path) -> Connection {
    let dir = home.join("profiles/owl");
    fs::create_dir_all(&dir).unwrap();
    Connection::open(dir.join("state.db")).unwrap()
}
fn delete(home: &Path, id: &str, purge: bool) -> hexbot_core::Result<Value> {
    catalog::call(
        home,
        "alice",
        "hexbot.sections.delete",
        &json!({"id":id,"purge_memory":purge}),
    )
    .unwrap()
}
fn legacy_texts(home: &Path) -> Vec<String> {
    legacy(home)
        .prepare("SELECT content FROM messages ORDER BY content")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
}
fn preserved(home: &Path) {
    for (id, bot) in [("other", "owl"), ("cat-chat", "cat"), ("bob-chat", "fox")] {
        assert_eq!(
            store::history(home, id).unwrap()[0]["text"],
            format!("native {id}")
        );
        assert!(
            home.join("runtime/sessions")
                .join(id)
                .join("conversation.jsonl")
                .is_file()
        );
        assert_eq!(
            fs::read_to_string(home.join("profiles").join(bot).join("memories/MEMORY.md")).unwrap(),
            format!("memory {bot}")
        );
        assert_eq!(
            fs::read_to_string(
                home.join("profiles")
                    .join(bot)
                    .join("memories/notes/2026-10-16.md")
            )
            .unwrap(),
            format!("notes {bot}")
        );
    }
    assert_eq!(store::usage(home, "chat").unwrap()["total_tokens"], 10);
}
fn erased(home: &Path) {
    assert!(catalog::section(home, "alice", "chat").is_err());
    for id in ["chat", "delegate", "grandchild"] {
        assert!(store::history(home, id).unwrap().is_empty(), "native {id}");
        assert!(!home.join("runtime/sessions").join(id).try_exists().unwrap());
        assert!(store::append(home, id, json!({"role":"user","text":"late"})).is_err());
    }
    assert_eq!(
        legacy_texts(home),
        ["legacy foreign", "legacy foreign-child", "legacy unrelated"]
    );
    preserved(home);
}

#[tokio::test]
async fn non_chat_public_purge_retries_native_legacy_and_final_metadata_failures_after_restart() {
    for (table, event, condition, expect_native) in [
        (
            "native_messages",
            "DELETE",
            " WHEN OLD.session_id='chat'",
            true,
        ),
        ("messages", "DELETE", "", false),
        (
            "native_delete_legacy",
            "INSERT",
            " WHEN NEW.session_id='chat'",
            true,
        ),
        (
            "native_delete_completed",
            "INSERT",
            " WHEN NEW.session_id='chat'",
            false,
        ),
        (
            "native_delete_legacy",
            "DELETE",
            " WHEN OLD.session_id='chat'",
            false,
        ),
        (
            "native_delete_pending",
            "DELETE",
            " WHEN OLD.session_id='chat' AND NOT EXISTS(SELECT 1 FROM native_sessions WHERE stored_id='chat')",
            false,
        ),
    ] {
        let home = setup();
        let h = home.path();
        let running = app(h);
        fixture(h);
        let before_native = ["chat", "delegate", "grandchild"].map(|id| {
            (
                store::history(h, id).unwrap(),
                fs::read(
                    h.join("runtime/sessions")
                        .join(id)
                        .join("conversation.jsonl"),
                )
                .unwrap(),
                hexbot_core::common::rows(
                    &store::open(h).unwrap(),
                    "SELECT * FROM native_sessions WHERE stored_id=?",
                    &[&id],
                )
                .unwrap(),
            )
        });
        let fault = if table == "messages" {
            legacy(h)
        } else {
            store::open(h).unwrap()
        };
        fault.execute_batch(&format!("CREATE TRIGGER stop_cleanup BEFORE {event} ON {table}{condition} BEGIN SELECT RAISE(ABORT,'controlled {table} failure'); END;")).unwrap();
        assert_eq!(
            running
                .call(
                    "alice",
                    "hexbot.sections.delete",
                    &json!({"id":"chat","purge_memory":true})
                )
                .await
                .unwrap(),
            json!({"deleted":true,"history_pending":true})
        );
        assert!(catalog::section(h, "alice", "chat").is_err());
        assert_eq!(
            !store::history(h, "chat").unwrap().is_empty(),
            expect_native
        );
        assert!(store::session_dir(h, "chat").is_err());
        if table == "native_delete_legacy" && event == "INSERT" {
            for (id, before) in ["chat", "delegate", "grandchild"]
                .into_iter()
                .zip(before_native)
            {
                assert_eq!(store::history(h, id).unwrap(), before.0);
                assert_eq!(
                    fs::read(
                        h.join("runtime/sessions")
                            .join(id)
                            .join("conversation.jsonl")
                    )
                    .unwrap(),
                    before.1
                );
                assert_eq!(
                    hexbot_core::common::rows(
                        &store::open(h).unwrap(),
                        "SELECT * FROM native_sessions WHERE stored_id=?",
                        &[&id]
                    )
                    .unwrap(),
                    before.2
                );
            }
        }
        if table == "messages" {
            assert!(legacy_texts(h).contains(&"legacy old-root".to_owned()));
        }
        // Actual restart while the fault remains keeps the request and the
        // decision terminal, even with no native rows/files left.
        running.shutdown().await;
        drop(running);
        let failed_restart = app(h);
        assert!(catalog::section(h, "alice", "chat").is_err());
        failed_restart.shutdown().await;
        drop(failed_restart);
        fault.execute_batch("DROP TRIGGER stop_cleanup").unwrap();
        let restarted = app(h);
        erased(h);
        store::finish_deletes(h).unwrap();
        erased(h);
        restarted.shutdown().await;
    }
}

#[test]
fn non_chat_legacy_only_aliases_and_saved_descendants_survive_missing_parent_metadata() {
    for native_present in [false, true] {
        let home = setup();
        let h = home.path();
        fixture(h);
        if !native_present {
            store::open(h).unwrap().execute_batch("DELETE FROM native_sessions WHERE stored_id IN ('chat','delegate','grandchild'); DELETE FROM native_messages WHERE session_id IN ('chat','delegate','grandchild'); DELETE FROM native_pi_journal WHERE session_id IN ('chat','delegate','grandchild');").unwrap();
            fs::remove_dir_all(h.join("runtime/sessions/chat")).unwrap();
        }
        let old = legacy(h);
        old.execute_batch("CREATE TRIGGER stop_cleanup BEFORE DELETE ON messages BEGIN SELECT RAISE(ABORT,'legacy transaction failed'); END;").unwrap();
        assert_eq!(
            delete(h, "chat", true).unwrap(),
            json!({"deleted":true,"history_pending":true})
        );
        assert!(store::history(h, "chat").unwrap().is_empty());
        // Remove legacy relationship rows too. The durable authorized snapshot
        // must still find the orphaned message keys after native links are gone.
        old.execute_batch("DELETE FROM sessions WHERE id IN ('old-root','old-cont','old-child','legacy-leaf'); DROP TRIGGER stop_cleanup;").unwrap();
        store::finish_deletes(h).unwrap();
        assert_eq!(
            legacy_texts(h),
            ["legacy foreign", "legacy foreign-child", "legacy unrelated"]
        );
        preserved(h);
    }
}

#[test]
fn non_chat_failed_catalog_delete_and_commit_preserve_every_original_and_never_retry_purge() {
    for commit in [false, true] {
        let home = setup();
        let h = home.path();
        fixture(h);
        let raw = fs::read(h.join("runtime/sessions/chat/conversation.jsonl")).unwrap();
        let rows = store::history(h, "chat").unwrap();
        let version = store::history_version(&store::open(h).unwrap(), "chat").unwrap();
        let options: String = store::open(h)
            .unwrap()
            .query_row(
                "SELECT prompt||options FROM native_sessions WHERE stored_id='chat'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let old = legacy_texts(h);
        let conn = db::open(h).unwrap();
        if commit {
            conn.execute_batch("CREATE TABLE commit_parent(id PRIMARY KEY); CREATE TABLE commit_child(parent REFERENCES commit_parent(id) DEFERRABLE INITIALLY DEFERRED); CREATE TRIGGER stop_commit AFTER DELETE ON sections BEGIN INSERT INTO commit_child VALUES('missing'); END;").unwrap();
        } else {
            conn.execute_batch("CREATE TRIGGER stop_commit BEFORE DELETE ON sections BEGIN SELECT RAISE(ABORT,'controlled catalog DELETE'); END;").unwrap();
        }
        assert!(delete(h, "chat", true).is_err());
        store::finish_deletes(h).unwrap();
        assert!(catalog::section(h, "alice", "chat").is_ok());
        assert_eq!(
            fs::read(h.join("runtime/sessions/chat/conversation.jsonl")).unwrap(),
            raw
        );
        assert_eq!(store::history(h, "chat").unwrap(), rows);
        assert_eq!(
            store::history_version(&store::open(h).unwrap(), "chat").unwrap(),
            version
        );
        assert_eq!(
            store::open(h)
                .unwrap()
                .query_row(
                    "SELECT prompt||options FROM native_sessions WHERE stored_id='chat'",
                    [],
                    |r| r.get::<_, String>(0)
                )
                .unwrap(),
            options
        );
        assert_eq!(legacy_texts(h), old);
        preserved(h);
        assert!(store::session_dir(h, "chat").is_ok());
        assert_eq!(
            store::open(h)
                .unwrap()
                .query_row("SELECT count(*) FROM native_delete_options", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
}

#[test]
fn non_chat_healthy_and_false_purge_controls_keep_the_existing_disposition() {
    for purge in [false, true] {
        let home = setup();
        let h = home.path();
        fixture(h);
        let old = legacy_texts(h);
        let retained = ["chat", "delegate", "grandchild"].map(|id| {
            (
                store::history(h, id).unwrap(),
                fs::read(
                    h.join("runtime/sessions")
                        .join(id)
                        .join("conversation.jsonl"),
                )
                .unwrap(),
                hexbot_core::common::rows(
                    &store::open(h).unwrap(),
                    "SELECT * FROM native_sessions WHERE stored_id=?",
                    &[&id],
                )
                .unwrap(),
            )
        });
        assert_eq!(delete(h, "chat", purge).unwrap(), json!({"deleted":true}));
        store::finish_deletes(h).unwrap();
        if purge {
            erased(h);
        } else {
            assert_eq!(legacy_texts(h), old);
            for (id, before) in ["chat", "delegate", "grandchild"].into_iter().zip(retained) {
                assert_eq!(store::history(h, id).unwrap(), before.0);
                assert_eq!(
                    fs::read(
                        h.join("runtime/sessions")
                            .join(id)
                            .join("conversation.jsonl")
                    )
                    .unwrap(),
                    before.1
                );
                assert_eq!(
                    hexbot_core::common::rows(
                        &store::open(h).unwrap(),
                        "SELECT * FROM native_sessions WHERE stored_id=?",
                        &[&id]
                    )
                    .unwrap(),
                    before.2
                );
                assert!(store::session_dir(h, id).is_err());
            }
            preserved(h);
        }
    }
}

#[test]
fn non_chat_unavailable_legacy_database_keeps_request_without_blocking_independent_cleanup() {
    let home = setup();
    let h = home.path();
    fixture(h);
    let path = h.join("profiles/owl/state.db");
    fs::rename(&path, path.with_extension("saved")).unwrap();
    fs::create_dir(&path).unwrap();
    assert_eq!(
        delete(h, "chat", true).unwrap(),
        json!({"deleted":true,"history_pending":true})
    );
    store::open(h).unwrap().execute_batch("CREATE TRIGGER cat_stuck BEFORE DELETE ON native_messages WHEN OLD.session_id='cat-chat' BEGIN SELECT RAISE(ABORT,'independent native failure'); END;").unwrap();
    assert_eq!(
        delete(h, "cat-chat", true).unwrap(),
        json!({"deleted":true,"history_pending":true})
    );
    store::open(h)
        .unwrap()
        .execute_batch("DROP TRIGGER cat_stuck")
        .unwrap();
    assert!(store::finish_deletes(h).is_err());
    assert!(store::history(h, "cat-chat").unwrap().is_empty());
    assert!(!store::history(h, "chat").unwrap().is_empty());
    fs::remove_dir(&path).unwrap();
    fs::rename(path.with_extension("saved"), &path).unwrap();
    store::finish_deletes(h).unwrap();
    assert!(store::history(h, "chat").unwrap().is_empty());
    assert_eq!(
        legacy_texts(h),
        ["legacy foreign", "legacy foreign-child", "legacy unrelated"]
    );
}

#[tokio::test]
async fn non_chat_preparation_failure_reopens_the_actual_app_retirement_without_changing_options() {
    let home = setup();
    let h = home.path();
    let running = app(h);
    fixture(h);
    store::open(h).unwrap().execute_batch("CREATE TRIGGER stop_prepare BEFORE INSERT ON native_delete_options BEGIN SELECT RAISE(ABORT,'request metadata failed'); END;").unwrap();
    assert!(
        running
            .call("alice", "hexbot.sections.delete", &json!({"id":"chat"}))
            .await
            .unwrap_err()
            .message
            .contains("request metadata failed")
    );
    assert!(catalog::section(h, "alice", "chat").is_ok());
    assert!(store::session_dir(h, "chat").is_ok());
    assert!(store::session_dir(h, "delegate").is_ok());
    assert_eq!(store::history(h, "chat").unwrap()[0]["text"], "native chat");
    assert_eq!(legacy_texts(h).len(), 7);
    preserved(h);
    running.shutdown().await;
}

#[test]
fn non_chat_committed_descendant_request_survives_a_parent_rollback_and_missing_links() {
    let home = setup();
    let h = home.path();
    fixture(h);
    db::open(h).unwrap().execute_batch("INSERT INTO sections(id,bot,owner_id,title,peer_bot) VALUES('delegate','owl','alice','independent child','cat');").unwrap();
    legacy(h).execute_batch("CREATE TRIGGER stop_legacy BEFORE DELETE ON messages BEGIN SELECT RAISE(ABORT,'legacy failure'); END;").unwrap();
    assert_eq!(
        delete(h, "delegate", true).unwrap()["history_pending"],
        true
    );
    assert!(store::history(h, "delegate").unwrap().is_empty());
    db::open(h).unwrap().execute_batch("CREATE TRIGGER stop_parent BEFORE DELETE ON sections BEGIN SELECT RAISE(ABORT,'parent failed'); END;").unwrap();
    assert!(delete(h, "chat", true).is_err());
    assert!(store::session_dir(h, "chat").is_ok());
    assert!(store::session_dir(h, "delegate").is_err());
    legacy(h).execute_batch("DROP TRIGGER stop_legacy").unwrap();
    store::finish_deletes(h).unwrap();
    assert!(store::history(h, "delegate").unwrap().is_empty());
    assert!(!legacy_texts(h).contains(&"legacy old-child".to_owned()));
    assert!(legacy_texts(h).contains(&"legacy old-root".to_owned()));
    assert!(!store::history(h, "chat").unwrap().is_empty());
}

#[tokio::test]
async fn non_chat_bot_cleanup_absorbs_pending_catalogless_requests_before_releasing_its_name() {
    let home = setup();
    let h = home.path();
    let running = app(h);
    fixture(h);
    legacy(h).execute_batch("CREATE TRIGGER stop_legacy BEFORE DELETE ON messages BEGIN SELECT RAISE(ABORT,'legacy failure'); END;").unwrap();
    assert_eq!(delete(h, "chat", true).unwrap()["history_pending"], true);
    let native = store::open(h).unwrap();
    native.execute_batch("CREATE TRIGGER stop_final BEFORE DELETE ON native_delete_legacy BEGIN SELECT RAISE(ABORT,'final request failure'); END;").unwrap();
    assert_eq!(
        running
            .call("alice", "hexbot.bots.delete", &json!({"name":"owl"}))
            .await
            .unwrap(),
        json!({"deleted":true,"history_pending":true})
    );
    assert!(!h.join("profiles/owl").try_exists().unwrap());
    assert_eq!(
        running
            .call("alice", "hexbot.bots.create", &json!({"name":"owl"}))
            .await
            .unwrap_err()
            .code,
        4208
    );
    native.execute_batch("DROP TRIGGER stop_final").unwrap();
    store::finish_deletes(h).unwrap();
    let replacement = running
        .call("alice", "hexbot.bots.create", &json!({"name":"owl"}))
        .await
        .unwrap();
    fs::create_dir_all(h.join("profiles/owl/memories")).unwrap();
    fs::write(h.join("profiles/owl/memories/MEMORY.md"), "NEW GENERATION").unwrap();
    store::finish_deletes(h).unwrap();
    assert!(catalog::section(h, "alice", replacement["section"]["id"].as_str().unwrap()).is_ok());
    assert_eq!(
        fs::read_to_string(h.join("profiles/owl/memories/MEMORY.md")).unwrap(),
        "NEW GENERATION"
    );
    running.shutdown().await;
}

#[cfg(unix)]
#[test]
fn non_chat_denied_and_symlinked_legacy_paths_keep_requests_and_foreign_data() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    for link in [false, true] {
        let home = setup();
        let h = home.path();
        fixture(h);
        let path = h.join("profiles/owl/state.db");
        let saved = path.with_extension("saved");
        fs::rename(&path, &saved).unwrap();
        if link {
            symlink(&saved, &path).unwrap();
        } else {
            fs::rename(&saved, &path).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o0)).unwrap();
        }
        assert_eq!(delete(h, "chat", true).unwrap()["history_pending"], true);
        assert!(store::finish_deletes(h).is_err());
        assert!(catalog::section(h, "alice", "chat").is_err());
        if link {
            fs::remove_file(&path).unwrap();
            fs::rename(&saved, &path).unwrap();
        } else {
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        }
        assert_eq!(legacy_texts(h).len(), 7);
        store::finish_deletes(h).unwrap();
        erased(h);
    }
}

#[cfg(unix)]
#[test]
fn non_chat_failed_file_cleanup_keeps_the_request_after_native_rows_disappear() {
    use std::os::unix::fs::symlink;
    let home = setup();
    let h = home.path();
    fixture(h);
    let original = h.join("runtime/sessions");
    let saved = h.join("runtime/sessions-saved");
    fs::rename(&original, &saved).unwrap();
    symlink(&saved, &original).unwrap();
    assert_eq!(delete(h, "chat", true).unwrap()["history_pending"], true);
    assert!(store::history(h, "chat").unwrap().is_empty());
    assert!(saved.join("chat/conversation.jsonl").is_file());
    assert!(store::finish_deletes(h).is_err());
    assert_eq!(legacy_texts(h).len(), 7);
    fs::remove_file(&original).unwrap();
    fs::rename(&saved, &original).unwrap();
    store::finish_deletes(h).unwrap();
    erased(h);
}

#[test]
fn non_chat_foreign_native_descendants_and_untagged_old_tombstones_keep_their_boundaries() {
    let home = setup();
    let h = home.path();
    fixture(h);
    native(h, "foreign-native", "fox", "bob", Some("chat"));
    native(h, "behind-foreign", "owl", "alice", Some("foreign-native"));
    assert_eq!(delete(h, "chat", true).unwrap(), json!({"deleted":true}));
    store::finish_deletes(h).unwrap();
    for id in ["foreign-native", "behind-foreign"] {
        assert_eq!(
            store::history(h, id).unwrap()[0]["text"],
            format!("native {id}")
        );
        assert!(store::session_dir(h, id).is_ok());
    }
    // Old builds left no bot/owner/purge proof. Keep that legacy compatibility
    // instead of guessing which profile an arbitrary orphan ID belongs to.
    // Reproduce the actual unowned old format, not today's owned retirement.
    store::open(h).unwrap().execute_batch("DELETE FROM native_sessions WHERE stored_id='other'; INSERT INTO native_deleted VALUES('other');").unwrap();
    assert_eq!(
        store::open(h)
            .unwrap()
            .query_row(
                "SELECT count(*) FROM native_delete_options WHERE session_id='other'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
    db::open(h)
        .unwrap()
        .execute("DELETE FROM sections WHERE id='other'", [])
        .unwrap();
    store::finish_deletes(h).unwrap();
    assert!(store::history(h, "other").unwrap().is_empty());
    assert!(legacy_texts(h).contains(&"legacy unrelated".to_owned()));
}

#[test]
fn non_chat_failed_section_attempt_preserves_the_preexisting_bot_journal_retirement() {
    let home = setup();
    let h = home.path();
    fixture(h);
    let original = catalog::prepare_bot_delete(h, "alice", "owl").unwrap();
    store::mark_deleted(h, "chat").unwrap();
    db::open(h).unwrap().execute_batch("CREATE TRIGGER stop_section BEFORE DELETE ON sections BEGIN SELECT RAISE(ABORT,'section decision failed'); END;").unwrap();
    assert!(delete(h, "chat", true).is_err());
    assert!(store::session_dir(h, "chat").is_err());
    assert!(store::session_dir(h, "delegate").is_err());
    assert_eq!(
        catalog::prepare_bot_delete(h, "alice", "owl").unwrap(),
        original
    );
    assert_eq!(legacy_texts(h).len(), 7);
    store::finish_deletes(h).unwrap();
    assert!(store::session_dir(h, "chat").is_ok());
    assert_eq!(store::history(h, "chat").unwrap()[0]["text"], "native chat");
}

#[test]
fn non_chat_completed_owned_descendants_stay_terminal_even_with_a_catalog_row() {
    let home = setup();
    let h = home.path();
    fixture(h);
    db::open(h).unwrap().execute_batch("INSERT INTO sections(id,bot,owner_id,title,peer_bot) VALUES('delegate','owl','alice','delegated row','cat');").unwrap();
    assert_eq!(delete(h, "chat", true).unwrap(), json!({"deleted":true}));
    store::finish_deletes(h).unwrap();
    store::finish_deletes(h).unwrap();
    assert!(store::session_dir(h, "delegate").is_err());
    assert!(store::append(h, "delegate", json!({"role":"user","text":"late"})).is_err());
}

#[test]
fn non_chat_a_failed_decision_does_not_unmark_a_foreign_descendants_existing_retirement() {
    let home = setup();
    let h = home.path();
    fixture(h);
    native(h, "foreign-native", "fox", "bob", Some("chat"));
    store::mark_deleted(h, "foreign-native").unwrap();
    db::open(h).unwrap().execute_batch("CREATE TRIGGER stop_section BEFORE DELETE ON sections BEGIN SELECT RAISE(ABORT,'section failed'); END;").unwrap();
    assert!(delete(h, "chat", true).is_err());
    assert!(store::session_dir(h, "chat").is_ok());
    assert!(store::session_dir(h, "foreign-native").is_err());
    assert_eq!(
        store::history(h, "foreign-native").unwrap()[0]["text"],
        "native foreign-native"
    );
}

#[test]
fn non_chat_failed_rollback_metadata_never_turns_an_uncommitted_request_into_a_purge() {
    let home = setup();
    let h = home.path();
    fixture(h);
    let catalog = db::open(h).unwrap();
    let native = store::open(h).unwrap();
    catalog.execute_batch("CREATE TRIGGER stop_catalog BEFORE DELETE ON sections WHEN OLD.id='chat' BEGIN SELECT RAISE(ABORT,'catalog failed'); END;").unwrap();
    native.execute_batch("CREATE TRIGGER stop_rollback BEFORE DELETE ON native_delete_options WHEN OLD.session_id='chat' BEGIN SELECT RAISE(ABORT,'rollback metadata failed'); END; CREATE TRIGGER stop_independent BEFORE DELETE ON native_messages WHEN OLD.session_id='cat-chat' BEGIN SELECT RAISE(ABORT,'independent fault'); END;").unwrap();
    let raw = fs::read(h.join("runtime/sessions/chat/conversation.jsonl")).unwrap();
    assert!(delete(h, "chat", true).is_err());
    assert_eq!(
        delete(h, "cat-chat", true).unwrap()["history_pending"],
        true
    );
    native
        .execute_batch("DROP TRIGGER stop_independent")
        .unwrap();
    assert!(store::finish_deletes(h).is_err());
    assert!(catalog::section(h, "alice", "chat").is_ok());
    assert_eq!(store::history(h, "chat").unwrap()[0]["text"], "native chat");
    assert_eq!(
        fs::read(h.join("runtime/sessions/chat/conversation.jsonl")).unwrap(),
        raw
    );
    assert_eq!(legacy_texts(h).len(), 7);
    assert!(store::history(h, "cat-chat").unwrap().is_empty());
    native.execute_batch("DROP TRIGGER stop_rollback").unwrap();
    store::finish_deletes(h).unwrap();
    assert!(store::session_dir(h, "chat").is_ok());
    assert_eq!(legacy_texts(h).len(), 7);
}

#[test]
fn non_chat_independent_child_commit_outlives_a_parents_failed_rollback_metadata() {
    let home = setup();
    let h = home.path();
    fixture(h);
    let catalog = db::open(h).unwrap();
    let native = store::open(h).unwrap();
    catalog.execute_batch("INSERT INTO sections(id,bot,owner_id,title,peer_bot) VALUES('delegate','owl','alice','child','cat'); CREATE TRIGGER stop_parent BEFORE DELETE ON sections WHEN OLD.id='chat' BEGIN SELECT RAISE(ABORT,'parent failed'); END;").unwrap();
    native.execute_batch("CREATE TRIGGER stop_rollback BEFORE DELETE ON native_delete_options WHEN OLD.session_id='chat' BEGIN SELECT RAISE(ABORT,'rollback metadata failed'); END;").unwrap();
    assert!(delete(h, "chat", true).is_err());
    catalog.execute_batch("CREATE TRIGGER stop_child BEFORE DELETE ON sections WHEN OLD.id='delegate' BEGIN SELECT RAISE(ABORT,'child failed'); END;").unwrap();
    assert!(delete(h, "delegate", true).is_err());
    assert!(catalog::section(h, "alice", "delegate").is_ok());
    assert_eq!(
        store::history(h, "delegate").unwrap()[0]["text"],
        "native delegate"
    );
    assert_eq!(
        native
            .query_row(
                "SELECT root_id FROM native_delete_pending WHERE session_id='delegate'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
        "chat"
    );
    catalog.execute_batch("DROP TRIGGER stop_child").unwrap();
    legacy(h).execute_batch("CREATE TRIGGER stop_legacy BEFORE DELETE ON messages BEGIN SELECT RAISE(ABORT,'legacy failed'); END;").unwrap();
    assert_eq!(
        delete(h, "delegate", true).unwrap()["history_pending"],
        true
    );
    assert!(catalog::section(h, "alice", "delegate").is_err());
    assert!(store::history(h, "delegate").unwrap().is_empty());
    native.execute_batch("DROP TRIGGER stop_rollback").unwrap();
    legacy(h).execute_batch("DROP TRIGGER stop_legacy").unwrap();
    store::finish_deletes(h).unwrap();
    store::finish_deletes(h).unwrap();
    assert!(store::session_dir(h, "delegate").is_err());
    assert!(store::session_dir(h, "grandchild").is_err());
    assert!(store::session_dir(h, "chat").is_ok());
    assert_eq!(store::history(h, "chat").unwrap()[0]["text"], "native chat");
    assert!(!legacy_texts(h).contains(&"legacy old-child".to_owned()));
    assert!(legacy_texts(h).contains(&"legacy old-root".to_owned()));
}
