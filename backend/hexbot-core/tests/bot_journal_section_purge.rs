//! Unused fork reservations and provisional bot journals are not purge authority.
use hexbot_core::{catalog, common, db, runtime_store as store, server::App};
use rusqlite::Connection;
use serde_json::{Value, json};
use std::{fs, path::Path};

fn fixture(h: &Path) {
    db::migrate(h).unwrap();
    db::open(h)
        .unwrap()
        .execute_batch(
            "INSERT INTO bots(name,owner_id) VALUES('owl','local'),('teammate','local');
         INSERT INTO sections(id,bot,owner_id,title,peer_bot) VALUES('chat','owl','local','General','teammate');
         INSERT OR REPLACE INTO settings VALUES('one_chat_per_bot','true');",
        )
        .unwrap();
    store::open(h).unwrap().execute_batch(
        "INSERT INTO native_sessions VALUES('chat','local','owl','FROZEN','{ \"model\": \"frozen\", \"extra\": [3,2,1] }');"
    ).unwrap();
    fs::create_dir_all(h.join("profiles/owl/memories")).unwrap();
    fs::write(h.join("profiles/owl/memories/MEMORY.md"), "KEEP MEMORY").unwrap();
}

fn rows(h: &Path, sql: &str) -> Vec<Value> {
    common::rows(&store::open(h).unwrap(), sql, &[]).unwrap()
}

fn deletion_state(h: &Path) -> Value {
    json!({
        "pending":rows(h,"SELECT * FROM native_pending_chat_forks ORDER BY target"),
        "deleted":rows(h,"SELECT * FROM native_deleted ORDER BY session_id"),
        "options":rows(h,"SELECT * FROM native_delete_options ORDER BY session_id"),
        "completed":rows(h,"SELECT * FROM native_delete_completed ORDER BY session_id"),
        "requests":rows(h,"SELECT * FROM native_delete_pending ORDER BY session_id"),
        "legacy":rows(h,"SELECT * FROM native_delete_legacy ORDER BY session_id,legacy_id")
    })
}

fn source(h: &Path) -> Value {
    json!({
        "history":store::history(h,"chat").unwrap(),
        "native":rows(h,"SELECT * FROM native_sessions WHERE stored_id='chat'"),
        "messages":rows(h,"SELECT * FROM native_messages WHERE session_id='chat' ORDER BY seq"),
        "raw":fs::read(h.join("runtime/sessions/chat/conversation.jsonl")).ok(),
        "memory":fs::read(h.join("profiles/owl/memories/MEMORY.md")).unwrap()
    })
}

fn legacy(h: &Path) -> Connection {
    Connection::open(h.join("profiles/owl/state.db")).unwrap()
}

fn legacy_fixture(h: &Path) {
    fixture(h);
    legacy(h).execute_batch(
        "CREATE TABLE sessions(id TEXT PRIMARY KEY,session_key TEXT,parent_session_id TEXT,owner_id TEXT,bot TEXT);
         CREATE TABLE messages(id INTEGER PRIMARY KEY,session_id TEXT,role TEXT,content TEXT);
         INSERT INTO sessions VALUES('legacy-chat','chat',NULL,'local','owl'),('unrelated','other',NULL,'local','owl');
         INSERT INTO messages VALUES(1,'legacy-chat','user','PURGE CHAT'),(2,'unrelated','user','KEEP OTHER');"
    ).unwrap();
    store::append(h, "chat", json!({"role":"user","text":"NATIVE CHAT"})).unwrap();
    fs::write(
        store::session_dir(h, "chat")
            .unwrap()
            .join("conversation.jsonl"),
        "RAW CHAT\n",
    )
    .unwrap();
}

fn legacy_rows(h: &Path) -> Value {
    let conn = legacy(h);
    json!({"sessions":common::rows(&conn,"SELECT * FROM sessions ORDER BY id",&[]).unwrap(),"messages":common::rows(&conn,"SELECT * FROM messages ORDER BY id",&[]).unwrap()})
}

#[test]
fn provisional_bot_journal_cannot_complete_an_independent_purge_without_legacy_cleanup() {
    for public in [false, true] {
        for explicit_rollback in [false, true] {
            for prepared in [false, true] {
                let home = tempfile::tempdir().unwrap();
                let h = home.path();
                let app = App::new(
                    h.into(),
                    "127.0.0.1:0".parse().unwrap(),
                    h.join("unused-pi"),
                    None,
                )
                .unwrap();
                legacy_fixture(h);
                if prepared {
                    let targets = catalog::prepare_bot_delete(h, "local", "owl").unwrap();
                    assert!(targets.iter().any(|t| t["id"] == "chat"));
                }
                let p = json!({"id":"chat","purge_memory":true});
                let result = if public {
                    tokio::runtime::Builder::new_current_thread()
                        .enable_all()
                        .build()
                        .unwrap()
                        .block_on(app.call("local", "hexbot.sections.delete", &p))
                        .unwrap()
                } else {
                    catalog::call(h, "local", "hexbot.sections.delete", &p)
                        .unwrap()
                        .unwrap()
                };
                assert_eq!(result, json!({"deleted":true}));
                assert!(store::history(h, "chat").unwrap().is_empty());
                assert!(rows(h, "SELECT * FROM native_sessions WHERE stored_id='chat'").is_empty());
                assert!(!h.join("runtime/sessions/chat").exists());
                assert_eq!(
                    legacy_rows(h)["messages"],
                    json!([{"id":2,"session_id":"unrelated","role":"user","content":"KEEP OTHER"}])
                );
                let complete = deletion_state(h);
                assert_eq!(
                    complete["options"],
                    json!([{"session_id":"chat","bot":"owl","owner":"local","purge":1}])
                );
                assert_eq!(complete["completed"], json!([{"session_id":"chat"}]));
                if prepared && explicit_rollback {
                    catalog::rollback_bot_delete(h, "owl").unwrap();
                }
                for _ in 0..2 {
                    catalog::finish_bot_deletes(h).unwrap();
                    store::finish_deletes(h).unwrap();
                    assert_eq!(deletion_state(h), complete);
                    assert_eq!(legacy_rows(h)["messages"].as_array().unwrap().len(), 1);
                    assert_eq!(
                        fs::read(h.join("profiles/owl/memories/MEMORY.md")).unwrap(),
                        b"KEEP MEMORY"
                    );
                    assert!(catalog::bot(h, "local", "owl").is_ok());
                }
            }
        }
    }
}

#[test]
fn provisional_bot_rollback_alone_preserves_exact_native_legacy_and_profile() {
    let home = tempfile::tempdir().unwrap();
    let h = home.path();
    legacy_fixture(h);
    let before = source(h);
    let old = legacy_rows(h);
    let state = deletion_state(h);
    catalog::prepare_bot_delete(h, "local", "owl").unwrap();
    for _ in 0..2 {
        catalog::finish_bot_deletes(h).unwrap();
        store::finish_deletes(h).unwrap();
        assert_eq!(source(h), before);
        assert_eq!(legacy_rows(h), old);
        assert_eq!(deletion_state(h), state);
    }
}

#[test]
fn committed_bot_cleanup_can_remove_legacy_with_its_profile() {
    let home = tempfile::tempdir().unwrap();
    let h = home.path();
    legacy_fixture(h);
    catalog::prepare_bot_delete(h, "local", "owl").unwrap();
    let result = catalog::call(h, "local", "hexbot.bots.delete", &json!({"name":"owl"}))
        .unwrap()
        .unwrap();
    assert_eq!(result["deleted"], true);
    assert!(!h.join("profiles/owl").exists());
    assert!(store::history(h, "chat").unwrap().is_empty());
    let complete = deletion_state(h);
    for _ in 0..2 {
        store::finish_deletes(h).unwrap();
        assert_eq!(deletion_state(h), complete);
        assert!(!h.join("profiles/owl").exists());
    }
}
