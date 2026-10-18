//! Catalog authority also applies before a legacy chat has a native root.
use hexbot_core::{catalog, common, db, runtime_store as store, server::App};
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use std::{fs, path::Path, sync::Arc};

mod support;

fn fixture(h: &Path, root_native: bool, foreign_bot: &str, foreign_owner: &str) -> Arc<App> {
    let app_home = h.to_path_buf();
    let app = std::thread::spawn(move || {
        App::new(
            app_home.clone(),
            "127.0.0.1:0".parse().unwrap(),
            app_home.join("unused-pi"),
            None,
        )
        .unwrap()
    })
    .join()
    .unwrap();
    db::open(h).unwrap().execute_batch(
        "INSERT INTO users(id,display_name,role,created_at) VALUES('alice','Alice','admin',0),('bob','Bob','member',0);
         INSERT INTO bots(name,owner_id) VALUES('owl','alice'),('cat','alice'),('fox','bob');
         INSERT INTO sections(id,bot,owner_id,title) VALUES('chat','owl','alice','General');
         INSERT INTO settings(key,value) VALUES('one_chat_per_bot','true') ON CONFLICT(key) DO UPDATE SET value='true';"
    ).unwrap();
    fs::create_dir_all(h.join("profiles/owl")).unwrap();
    Connection::open(h.join("profiles/owl/state.db")).unwrap().execute_batch(
        "CREATE TABLE sessions(id TEXT PRIMARY KEY,session_key TEXT,parent_session_id TEXT,owner_id TEXT,bot TEXT);
         CREATE TABLE messages(id INTEGER PRIMARY KEY,session_id TEXT,role TEXT,content TEXT);
         INSERT INTO sessions VALUES('old-root','chat',NULL,'alice','owl');
         INSERT INTO messages VALUES(1,'old-root','user','LEGACY ROOT');"
    ).unwrap();
    for (id, bot, owner, parent) in [
        ("chat", "owl", "alice", None),
        ("owned", "owl", "alice", Some("chat")),
        ("owned-grandchild", "owl", "alice", Some("owned")),
        ("foreign", foreign_bot, foreign_owner, Some("chat")),
        ("behind-foreign", "owl", "alice", Some("foreign")),
    ] {
        if id == "chat" && !root_native {
            continue;
        }
        let options = format!(
            "{{ \"parent_session\": {}, \"model\": \"frozen\", \"extra\": [3,2,1] }}",
            json!(parent)
        );
        store::open(h).unwrap().execute(
            "INSERT INTO native_sessions(stored_id,bot,owner,prompt,options) VALUES(?,?,?,'FROZEN',?)",
            params![id, bot, owner, options],
        ).unwrap();
        store::append(h, id, json!({"role":"user","text":format!("KEEP {id}")})).unwrap();
        fs::write(
            store::session_dir(h, id)
                .unwrap()
                .join("conversation.jsonl"),
            format!("RAW {id}\n"),
        )
        .unwrap();
    }
    // A deletion must not even close a foreign conversation's live alias.
    store::open(h).unwrap().execute_batch(
        "INSERT INTO native_live_sessions VALUES('foreign','live-foreign'),('behind-foreign','live-behind');"
    ).unwrap();
    // Public preflight reads this same lazy summary before retirement.
    catalog::section(h, "alice", "chat").unwrap();
    app
}

fn snapshot(h: &Path, id: &str) -> Value {
    let conn = store::open(h).unwrap();
    let mut rows = serde_json::Map::new();
    for (table, key) in [
        ("native_sessions", "stored_id"),
        ("native_live_sessions", "stored_id"),
        ("native_messages", "session_id"),
        ("native_usage", "session_id"),
        ("native_pi_journal", "session_id"),
        ("native_prompt_intents", "session_id"),
        ("native_summaries", "session_id"),
        ("native_deleted", "session_id"),
        ("native_delete_options", "session_id"),
        ("native_delete_pending", "session_id"),
        ("native_delete_claims", "session_id"),
        ("native_delete_completed", "session_id"),
        ("native_delete_legacy", "session_id"),
    ] {
        rows.insert(
            table.into(),
            json!(
                common::rows(
                    &conn,
                    &format!("SELECT * FROM {table} WHERE {key}=? ORDER BY rowid"),
                    &[&id]
                )
                .unwrap()
            ),
        );
    }
    json!({"rows":rows,"history":store::history(h,id).unwrap(),"raw":fs::read(h.join("runtime/sessions").join(id).join("conversation.jsonl")).ok()})
}

async fn delete(app: &Arc<App>, h: &Path, public: bool, purge: bool) -> hexbot_core::Result<Value> {
    let p = json!({"id":"chat","purge_memory":purge});
    if public {
        app.call("alice", "hexbot.sections.delete", &p).await
    } else {
        catalog::call(h, "alice", "hexbot.sections.delete", &p).unwrap()
    }
}

fn assert_purged(h: &Path, id: &str) {
    let state = snapshot(h, id);
    assert_eq!(state["rows"]["native_sessions"], json!([]), "{id}");
    assert_eq!(state["history"], json!([]), "{id}");
    assert_eq!(state["raw"], Value::Null, "{id}");
    assert_eq!(state["rows"]["native_deleted"], json!([{"session_id":id}]));
    assert_eq!(
        state["rows"]["native_delete_options"],
        json!([{"session_id":id,"bot":"owl","owner":"alice","purge":1}])
    );
    assert_eq!(
        state["rows"]["native_delete_completed"],
        json!([{"session_id":id}])
    );
}

#[tokio::test]
async fn catalog_and_public_deletes_stop_at_each_foreign_ancestor_without_a_native_root() {
    for public in [false, true] {
        for root_native in [false, true] {
            for (bot, owner) in [("cat", "alice"), ("fox", "bob"), ("owl", "bob")] {
                let home = support::TestHome::new();
                let h = home.path();
                let app = fixture(h, root_native, bot, owner);
                let foreign = snapshot(h, "foreign");
                let behind = snapshot(h, "behind-foreign");
                assert_eq!(
                    delete(&app, h, public, true).await.unwrap(),
                    json!({"deleted":true})
                );
                for _ in 0..2 {
                    assert_eq!(
                        snapshot(h, "foreign"),
                        foreign,
                        "public={public}, native={root_native}, {bot}/{owner}"
                    );
                    assert_eq!(snapshot(h, "behind-foreign"), behind);
                    for id in ["chat", "owned", "owned-grandchild"] {
                        assert_purged(h, id);
                    }
                    store::finish_deletes(h).unwrap();
                }
                assert_eq!(snapshot(h, "foreign"), foreign);
                assert_eq!(snapshot(h, "behind-foreign"), behind);
            }
        }
    }
}

#[tokio::test]
async fn failed_catalog_commit_keeps_owned_and_foreign_history_and_disposition_exact() {
    for public in [false, true] {
        for root_native in [false, true] {
            let home = support::TestHome::new();
            let h = home.path();
            let app = fixture(h, root_native, "cat", "alice");
            let ids = [
                "chat",
                "owned",
                "owned-grandchild",
                "foreign",
                "behind-foreign",
            ];
            let before = ids.map(|id| snapshot(h, id));
            db::open(h).unwrap().execute_batch("CREATE TRIGGER stop_catalog BEFORE DELETE ON sections BEGIN SELECT RAISE(ABORT,'catalog failure'); END;").unwrap();
            assert!(delete(&app, h, public, true).await.is_err());
            for _ in 0..2 {
                for (id, state) in ids.iter().zip(&before) {
                    assert_eq!(&snapshot(h, id), state, "{id}");
                }
                store::finish_deletes(h).unwrap();
            }
            db::open(h)
                .unwrap()
                .execute_batch("DROP TRIGGER stop_catalog")
                .unwrap();
            assert_eq!(
                delete(&app, h, public, true).await.unwrap(),
                json!({"deleted":true})
            );
            store::finish_deletes(h).unwrap();
            assert_eq!(snapshot(h, "foreign"), before[3]);
            assert_eq!(snapshot(h, "behind-foreign"), before[4]);
            for id in ["chat", "owned", "owned-grandchild"] {
                assert_purged(h, id);
            }
        }
    }
}

#[tokio::test]
async fn retained_and_completed_descendants_keep_their_independent_decisions() {
    for public in [false, true] {
        for root_native in [false, true] {
            let home = support::TestHome::new();
            let h = home.path();
            let app = fixture(h, root_native, "cat", "alice");
            db::open(h).unwrap().execute_batch("INSERT INTO sections(id,bot,owner_id,title) VALUES('owned','owl','alice','child');").unwrap();
            catalog::call(
                h,
                "alice",
                "hexbot.sections.delete",
                &json!({"id":"owned","purge_memory":false}),
            )
            .unwrap()
            .unwrap();
            // Keep a completed child linked to a retained parent, as after a
            // partial cleanup. Completion must prevent a second native purge.
            store::delete(h, "owned-grandchild").unwrap();
            store::open(h).unwrap().execute("INSERT INTO native_sessions VALUES('owned-grandchild','alice','owl','FROZEN','{\"parent_session\":\"owned\"}')", []).unwrap();
            let retained = snapshot(h, "owned");
            let completed = snapshot(h, "owned-grandchild");
            let foreign = snapshot(h, "foreign");
            let behind = snapshot(h, "behind-foreign");
            assert_eq!(
                delete(&app, h, public, false).await.unwrap(),
                json!({"deleted":true})
            );
            for _ in 0..2 {
                assert_eq!(snapshot(h, "owned"), retained);
                assert_eq!(snapshot(h, "owned-grandchild"), completed);
                assert_eq!(snapshot(h, "foreign"), foreign);
                assert_eq!(snapshot(h, "behind-foreign"), behind);
                store::finish_deletes(h).unwrap();
            }
            assert_eq!(snapshot(h, "owned"), retained);
            assert_eq!(snapshot(h, "owned-grandchild"), completed);
        }
    }
}
