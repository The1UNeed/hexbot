use hexbot_core::{catalog, db, memory::MemoryStore, runtime_store, server::App};
use serde_json::{Value, json};
use std::{fs, path::PathBuf, sync::Arc};

struct Fixture {
    home: tempfile::TempDir,
    app: Arc<App>,
    id: String,
    child: String,
}
impl Fixture {
    fn new() -> Self {
        let home = tempfile::tempdir().unwrap();
        let h = home.path();
        // Construct outside Tokio so neither background ticker nor description task starts.
        let app = App::new(
            h.into(),
            "127.0.0.1:0".parse().unwrap(),
            h.join("never-run-pi"),
            None,
        )
        .unwrap();
        db::open(h)
            .unwrap()
            .execute(
                "INSERT INTO users(id,display_name,role,created_at) VALUES('bob','Bob','member',0)",
                [],
            )
            .unwrap();
        let created = catalog::call(
            h,
            "local",
            "hexbot.bots.create",
            &json!({"name":"owl","description":"Manual fixture"}),
        )
        .unwrap()
        .unwrap();
        let id = created["section"]["id"].as_str().unwrap().to_owned();
        let child = format!("child-{id}");
        let conn = runtime_store::open(h).unwrap();
        for (stored, live, options) in [
            (&id, "live-parent", json!({})),
            (&child, "live-child", json!({"parent_session":id})),
        ] {
            conn.execute("INSERT INTO native_sessions(stored_id,owner,bot,prompt,options) VALUES(?,'local','owl','fixture',?)", rusqlite::params![stored, options.to_string()]).unwrap();
            conn.execute(
                "INSERT INTO native_live_sessions(stored_id,live_id) VALUES(?,?)",
                rusqlite::params![stored, live],
            )
            .unwrap();
            runtime_store::append(
                h,
                stored,
                json!({"role":"user","text":"Retained transcript"}),
            )
            .unwrap();
            let dir = runtime_store::session_dir(h, stored).unwrap();
            let entries = [
                json!({"type":"session","version":3,"id":stored,"timestamp":"2026-10-12T00:00:00.000Z","cwd":h}),
                json!({"type":"message","id":"message-1","parentId":null,"timestamp":"2026-10-12T00:00:01.000Z","message":{"role":"user","content":[{"type":"text","text":"Retained transcript"}]}}),
            ];
            fs::write(
                dir.join("conversation.jsonl"),
                entries
                    .iter()
                    .map(|entry| format!("{entry}\n"))
                    .collect::<String>(),
            )
            .unwrap();
        }
        let legacy = rusqlite::Connection::open(h.join("profiles/owl/state.db")).unwrap();
        legacy.execute_batch("CREATE TABLE sessions(id TEXT PRIMARY KEY); CREATE TABLE messages(id INTEGER,session_id TEXT,role TEXT,content TEXT);").unwrap();
        legacy
            .execute("INSERT INTO sessions VALUES(?)", [&id])
            .unwrap();
        legacy
            .execute(
                "INSERT INTO messages VALUES(1,?,'user','Legacy transcript')",
                [&id],
            )
            .unwrap();
        MemoryStore::new(h.into())
            .set_bot("local", "owl", "Durable memory")
            .unwrap();
        Self {
            home,
            app,
            id,
            child,
        }
    }
    fn pi_path(&self, stored: &str) -> PathBuf {
        self.home
            .path()
            .join("runtime/sessions")
            .join(stored)
            .join("conversation.jsonl")
    }
    fn snapshot(&self) -> Value {
        let h = self.home.path();
        let conn = runtime_store::open(h).unwrap();
        let legacy = rusqlite::Connection::open(h.join("profiles/owl/state.db")).unwrap();
        json!({
            "parent_messages":runtime_store::history(h,&self.id).unwrap().len(),
            "child_messages":runtime_store::history(h,&self.child).unwrap().len(),
            "parent_pi":self.pi_path(&self.id).exists(),
            "child_pi":self.pi_path(&self.child).exists(),
            "sessions":conn.query_row("SELECT COUNT(*) FROM native_sessions",[],|r|r.get::<_,i64>(0)).unwrap(),
            "live_aliases":conn.query_row("SELECT COUNT(*) FROM native_live_sessions",[],|r|r.get::<_,i64>(0)).unwrap(),
            "tombstones":conn.query_row("SELECT COUNT(*) FROM native_deleted",[],|r|r.get::<_,i64>(0)).unwrap(),
            "legacy_messages":legacy.query_row("SELECT COUNT(*) FROM messages",[],|r|r.get::<_,i64>(0)).unwrap(),
            "memory":MemoryStore::new(h.into()).get_bot("local","owl").unwrap()["memory_md"],
        })
    }
    fn dispatch_delete(&self, caller: &str, purge: Option<bool>) -> hexbot_core::Result<Value> {
        let mut params = json!({"id":self.id});
        if let Some(purge) = purge {
            params["purge_memory"] = json!(purge);
        }
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let result = self
                    .app
                    .call(caller, "hexbot.sections.delete", &params)
                    .await;
                if result.is_ok() {
                    assert_eq!(
                        self.app
                            .call("local", "hexbot.sections.delete", &json!({"id":self.id}))
                            .await
                            .unwrap_err()
                            .code,
                        4204
                    );
                    assert_eq!(
                        self.app
                            .call("local", "hexbot.sections.open", &json!({"id":self.id}))
                            .await
                            .unwrap_err()
                            .code,
                        4204
                    );
                    assert_eq!(
                        self.app
                            .call(
                                "local",
                                "session.history",
                                &json!({"session_id":"live-parent"})
                            )
                            .await
                            .unwrap_err()
                            .code,
                        4001
                    );
                    assert_eq!(
                        self.app
                            .call(
                                "local",
                                "session.history",
                                &json!({"session_id":"live-child"})
                            )
                            .await
                            .unwrap_err()
                            .code,
                        4001
                    );
                    assert_eq!(
                        self.app
                            .runtime
                            .ensure_hidden("local", "owl", &self.id)
                            .await
                            .unwrap_err()
                            .code,
                        4001
                    );
                    assert_eq!(
                        self.app
                            .runtime
                            .ensure_hidden("local", "owl", &self.child)
                            .await
                            .unwrap_err()
                            .code,
                        4001
                    );
                }
                self.app.shutdown().await;
                result
            })
    }
}

#[test]
fn public_section_delete_respects_purge_and_closes_descendants() {
    for purge in [None, Some(true), Some(false)] {
        let fixture = Fixture::new();
        let parent = fs::read(fixture.pi_path(&fixture.id)).unwrap();
        let child = fs::read(fixture.pi_path(&fixture.child)).unwrap();
        assert_eq!(
            fixture.dispatch_delete("local", purge).unwrap(),
            json!({"deleted":true})
        );
        let state = fixture.snapshot();
        let keep = purge == Some(false);
        assert_eq!(state["parent_messages"], usize::from(keep));
        assert_eq!(state["child_messages"], usize::from(keep));
        assert_eq!(state["parent_pi"], keep);
        assert_eq!(state["child_pi"], keep);
        assert_eq!(state["sessions"], if keep { 2 } else { 0 });
        assert_eq!(state["live_aliases"], 0);
        assert_eq!(state["tombstones"], 2);
        assert_eq!(state["legacy_messages"], usize::from(keep));
        assert_eq!(state["memory"], "Durable memory");
        if keep {
            assert_eq!(fs::read(fixture.pi_path(&fixture.id)).unwrap(), parent);
            assert_eq!(fs::read(fixture.pi_path(&fixture.child)).unwrap(), child);
        }
        for stored in [&fixture.id, &fixture.child] {
            assert_eq!(
                runtime_store::session_dir(fixture.home.path(), stored)
                    .unwrap_err()
                    .code,
                4001
            );
            assert_eq!(
                runtime_store::append(
                    fixture.home.path(),
                    stored,
                    json!({"role":"user","text":"Late write"})
                )
                .unwrap_err()
                .code,
                4001
            );
        }
    }
}

#[test]
fn public_section_delete_checks_ownership_before_storage() {
    let fixture = Fixture::new();
    let before = fixture.snapshot();
    assert_eq!(
        fixture
            .dispatch_delete("bob", Some(false))
            .unwrap_err()
            .code,
        4302
    );
    assert_eq!(fixture.snapshot(), before);
}

#[test]
fn bot_delete_purges_retained_native_conversations() {
    let fixture = Fixture::new();
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            fixture
                .app
                .call(
                    "local",
                    "hexbot.sections.delete",
                    &json!({"id":fixture.id,"purge_memory":false}),
                )
                .await
                .unwrap();
            assert_eq!(fixture.snapshot()["parent_messages"], 1);
            assert_eq!(fixture.snapshot()["child_messages"], 1);
            assert!(catalog::section(fixture.home.path(), "local", &fixture.id).is_err());
            let denied = fixture
                .app
                .call("bob", "hexbot.bots.delete", &json!({"name":"owl"}))
                .await
                .unwrap_err();
            assert_eq!(denied.code, 4302);
            assert_eq!(fixture.snapshot()["parent_messages"], 1);
            fixture
                .app
                .call("local", "hexbot.bots.delete", &json!({"name":"owl"}))
                .await
                .unwrap();
            for stored in [&fixture.id, &fixture.child] {
                assert!(
                    runtime_store::history(fixture.home.path(), stored)
                        .unwrap()
                        .is_empty()
                );
                assert!(!fixture.pi_path(stored).exists());
            }
            let count = runtime_store::open(fixture.home.path())
                .unwrap()
                .query_row("SELECT COUNT(*) FROM native_sessions", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap();
            assert_eq!(count, 0);
            fixture.app.shutdown().await;
        });
}

#[test]
fn failed_public_section_delete_keeps_data_and_unmarks_descendants() {
    for close_failure in [true, false] {
        let fixture = Fixture::new();
        if close_failure {
            runtime_store::open(fixture.home.path())
                .unwrap()
                .execute(
                    "UPDATE native_sessions SET owner='bob' WHERE stored_id=?",
                    [&fixture.id],
                )
                .unwrap();
        } else {
            db::open(fixture.home.path()).unwrap().execute_batch("CREATE TRIGGER refuse_delete BEFORE DELETE ON sections BEGIN SELECT RAISE(FAIL,'fixture'); END;").unwrap();
        }
        assert!(fixture.dispatch_delete("local", Some(false)).is_err());
        let state = fixture.snapshot();
        assert_eq!(state["parent_messages"], 1);
        assert_eq!(state["child_messages"], 1);
        assert_eq!(state["parent_pi"], true);
        assert_eq!(state["child_pi"], true);
        assert_eq!(state["sessions"], 2);
        assert_eq!(state["tombstones"], 0);
        assert_eq!(state["live_aliases"], if close_failure { 2 } else { 0 });
        assert_eq!(state["legacy_messages"], 1);
        assert_eq!(state["memory"], "Durable memory");
        assert!(catalog::section(fixture.home.path(), "local", &fixture.id).is_ok());
    }
}
