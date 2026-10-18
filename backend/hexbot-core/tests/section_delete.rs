use hexbot_core::{
    catalog, db, memory::MemoryStore, native_product_tools as product, runtime_store, server::App,
};
use serde_json::{Value, json};
use std::{fs, future::Future, path::PathBuf, sync::Arc};

fn run<T>(future: impl Future<Output = T>) -> T {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(future)
}

struct Fixture {
    home: tempfile::TempDir,
    app: Arc<App>,
    id: String,
    child: String,
}
impl Fixture {
    fn new() -> Self {
        Self::with_root(None)
    }
    fn with_root(root: Option<&str>) -> Self {
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
        let mut id = created["section"]["id"].as_str().unwrap().to_owned();
        if let Some(root) = root {
            db::open(h)
                .unwrap()
                .execute(
                    "UPDATE sections SET id=? WHERE id=?",
                    rusqlite::params![root, id],
                )
                .unwrap();
            id = root.to_owned();
        }
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
        fs::create_dir_all(h.join("profiles/owl/memories/notes")).unwrap();
        fs::write(
            h.join("profiles/owl/memories/notes/2026-10-15.md"),
            "Daily notes fixture",
        )
        .unwrap();
        Self {
            home,
            app,
            id,
            child,
        }
    }
    fn restart(&mut self) {
        // App::new runs actual deletion cleanup and native recovery. Build it
        // outside Tokio so the scheduler cannot add unrelated background work.
        let h = self.home.path();
        self.app = App::new(
            h.into(),
            "127.0.0.1:0".parse().unwrap(),
            h.join("never-run-pi"),
            None,
        )
        .unwrap();
    }
    fn pi_path(&self, stored: &str) -> PathBuf {
        self.home
            .path()
            .join("runtime/sessions")
            .join(stored)
            .join("conversation.jsonl")
    }
    fn completed(&self, stored: &str) -> bool {
        runtime_store::open(self.home.path())
            .unwrap()
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM native_delete_completed WHERE session_id=?)",
                [stored],
                |r| r.get(0),
            )
            .unwrap()
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
            "notes":fs::read_to_string(h.join("profiles/owl/memories/notes/2026-10-15.md")).unwrap(),
        })
    }
    fn dispatch_delete(&self, caller: &str, purge: Option<bool>) -> hexbot_core::Result<Value> {
        let mut params = json!({"id":self.id});
        if let Some(purge) = purge {
            params["purge_memory"] = json!(purge);
        }
        run(async {
            let result = self
                .app
                .call(caller, "hexbot.sections.delete", &params)
                .await;
            if result.is_ok() {
                self.assert_closed().await;
            }
            self.app.shutdown().await;
            result
        })
    }
    async fn assert_closed(&self) {
        for method in ["hexbot.sections.open", "hexbot.sections.delete"] {
            assert_eq!(
                self.app
                    .call("local", method, &json!({"id":self.id}))
                    .await
                    .unwrap_err()
                    .code,
                4204
            );
        }
        for (stored, live) in [(&self.id, "live-parent"), (&self.child, "live-child")] {
            assert_eq!(
                self.app
                    .call("local", "session.history", &json!({"session_id":live}))
                    .await
                    .unwrap_err()
                    .code,
                4001
            );
            assert_eq!(
                self.app
                    .runtime
                    .ensure_hidden("local", "owl", stored)
                    .await
                    .unwrap_err()
                    .code,
                4001
            );
        }
    }
}

#[test]
fn public_section_delete_respects_purge_and_closes_descendants() {
    for purge in [None, Some(true), Some(false)] {
        let mut fixture = Fixture::new();
        let parent = fs::read(fixture.pi_path(&fixture.id)).unwrap();
        let child = fs::read(fixture.pi_path(&fixture.child)).unwrap();
        assert_eq!(
            fixture.dispatch_delete("local", purge).unwrap(),
            json!({"deleted":true})
        );
        let state = fixture.snapshot();
        fixture.restart();
        // This assertion fails with the old startup cleaner even if deletion
        // itself was taught to skip a nonpurging request.
        assert_eq!(fixture.snapshot(), state, "purge={purge:?} after restart");
        run(fixture.assert_closed());
        let keep = purge == Some(false);
        assert_eq!(fixture.completed(&fixture.id), !keep);
        assert_eq!(fixture.completed(&fixture.child), !keep);
        assert_eq!(state["parent_messages"], usize::from(keep));
        assert_eq!(state["child_messages"], usize::from(keep));
        assert_eq!(state["parent_pi"], keep);
        assert_eq!(state["child_pi"], keep);
        assert_eq!(state["sessions"], if keep { 2 } else { 0 });
        assert_eq!(state["live_aliases"], 0);
        assert_eq!(state["tombstones"], 2);
        assert_eq!(state["legacy_messages"], usize::from(keep));
        assert_eq!(state["memory"], "Durable memory");
        assert_eq!(state["notes"], "Daily notes fixture");
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
                runtime_store::stage_prompt(fixture.home.path(), stored, "Late prompt", "normal")
                    .unwrap_err()
                    .code,
                4001
            );
            assert_eq!(
                runtime_store::project_seeded(
                    fixture.home.path(),
                    stored,
                    "local",
                    "owl",
                    &json!({"role":"assistant","content":"Late result"}),
                    None,
                    None
                )
                .unwrap_err()
                .code,
                4001
            );
            assert_eq!(
                runtime_store::reconcile(fixture.home.path(), "owl", stored, "local")
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
fn product_tools_reject_deleted_sources_without_changing_retained_files() {
    for purge in [Some(false), Some(true), None] {
        let mut fixture = Fixture::new();
        let h = fixture.home.path();
        fs::write(
            h.join("profiles/owl/config.yaml"),
            "tools:\n  enabled_toolsets: [todo, skills]\n",
        )
        .unwrap();
        let skill = h.join("profiles/owl/skills/plan/SKILL.md");
        let original = "---\nname: plan\ndescription: Use for planning.\n---\nKeep this skill.\n";
        fs::create_dir_all(skill.parent().unwrap()).unwrap();
        fs::write(&skill, original).unwrap();
        // The child has native metadata but no catalog entry. It must remain
        // a valid product-tool source until the actual public delete.
        for stored in [&fixture.id, &fixture.child] {
            run(product::call(
                h,
                "local",
                "owl",
                stored,
                "todo_list",
                &json!({"todos":[{"id":"keep","content":"Original task","status":"pending"}]}),
            ))
            .unwrap()
            .unwrap();
        }
        run(product::call(
            h,
            "local",
            "owl",
            &fixture.child,
            "skill_manage",
            &json!({"operations":[{"name":"plan","action":"patch","old_string":"Keep this skill.","new_string":"Keep this skill."}]}),
        ))
        .unwrap()
        .unwrap();
        let todo = h
            .join("runtime/sessions")
            .join(&fixture.id)
            .join("todo.json");
        let before = fs::read(&todo).unwrap();
        fixture.dispatch_delete("local", purge).unwrap();
        for restart in [false, true] {
            if restart {
                fixture.restart();
            }
            for stored in [&fixture.id, &fixture.child] {
                for (name, args) in [
                    ("todo_list", json!({"todos":[]})),
                    (
                        "skill_manage",
                        json!({"operations":[{"name":"plan","action":"delete"}]}),
                    ),
                ] {
                    assert_eq!(
                        run(product::call(
                            fixture.home.path(),
                            "local",
                            "owl",
                            stored,
                            name,
                            &args
                        ))
                        .unwrap()
                        .unwrap_err()
                        .code,
                        4001,
                        "purge={purge:?}, restart={restart}, tool={name}"
                    );
                }
            }
            assert_eq!(fs::read_to_string(&skill).unwrap(), original);
            if purge == Some(false) {
                assert_eq!(fs::read(&todo).unwrap(), before);
            } else {
                assert!(!todo.exists());
            }
        }
    }
}

#[test]
fn completed_purges_skip_native_legacy_and_file_cleanup_on_restarts() {
    let mut fixture = Fixture::new();
    fixture.dispatch_delete("local", Some(true)).unwrap();
    let h = fixture.home.path();
    let native = runtime_store::open(h).unwrap();
    native.execute_batch("CREATE TABLE cleanup_attempts(kind TEXT); CREATE TRIGGER observe_delete BEFORE INSERT ON native_deleted BEGIN INSERT INTO cleanup_attempts VALUES('tombstone'); END; CREATE TRIGGER observe_policy BEFORE UPDATE ON native_delete_options BEGIN INSERT INTO cleanup_attempts VALUES('policy'); END;").unwrap();
    // Observable barriers: cleanup must never touch these paths or issue
    // destructive SQL again after the original purge succeeded.
    let legacy = rusqlite::Connection::open(h.join("profiles/owl/state.db")).unwrap();
    legacy
        .execute("INSERT INTO sessions VALUES(?)", [&fixture.id])
        .unwrap();
    legacy
        .execute(
            "INSERT INTO messages VALUES(9,?,'user','Barrier')",
            [&fixture.id],
        )
        .unwrap();
    native
        .execute(
            "INSERT INTO native_messages VALUES(?,9,'{}')",
            [&fixture.id],
        )
        .unwrap();
    let dir = fixture.pi_path(&fixture.id).parent().unwrap().to_path_buf();
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("barrier"), "Keep").unwrap();
    for _ in 0..2 {
        fixture.restart();
        runtime_store::finish_deletes(fixture.home.path()).unwrap();
        assert_eq!(
            native
                .query_row("SELECT COUNT(*) FROM cleanup_attempts", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            native
                .query_row("SELECT COUNT(*) FROM native_messages", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            legacy
                .query_row("SELECT COUNT(*) FROM messages", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(fs::read_to_string(dir.join("barrier")).unwrap(), "Keep");
        assert!(
            runtime_store::owned_sessions(fixture.home.path(), "owl")
                .unwrap()
                .is_empty()
        );
        run(fixture.assert_closed());
    }
}

#[test]
fn bot_delete_purges_retained_native_conversations_after_restart() {
    let mut fixture = Fixture::new();
    runtime_store::open(fixture.home.path())
        .unwrap()
        .execute(
            "INSERT INTO native_sessions VALUES('hidden-job','local','owl','','{}')",
            [],
        )
        .unwrap();
    runtime_store::append(
        fixture.home.path(),
        "hidden-job",
        json!({"role":"assistant","text":"Hidden job"}),
    )
    .unwrap();
    let hidden = runtime_store::session_dir(fixture.home.path(), "hidden-job").unwrap();
    fs::write(hidden.join("conversation.jsonl"), "").unwrap();
    fixture.dispatch_delete("local", Some(false)).unwrap();
    fixture.restart();
    run(async {
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
        assert!(!hidden.exists());
        assert!(
            runtime_store::history(fixture.home.path(), "hidden-job")
                .unwrap()
                .is_empty()
        );
        for stored in [fixture.id.as_str(), fixture.child.as_str(), "hidden-job"] {
            assert!(fixture.completed(stored));
        }
        assert!(
            runtime_store::owned_sessions(fixture.home.path(), "owl")
                .unwrap()
                .is_empty()
        );
        fixture.app.shutdown().await;
    });
}

#[test]
fn failed_public_section_delete_keeps_data_and_unmarks_descendants() {
    for failure in ["close", "catalog", "disposition"] {
        let close_failure = failure == "close";
        let fixture = Fixture::new();
        if close_failure {
            runtime_store::open(fixture.home.path())
                .unwrap()
                .execute(
                    "UPDATE native_sessions SET owner='bob' WHERE stored_id=?",
                    [&fixture.id],
                )
                .unwrap();
        } else if failure == "disposition" {
            runtime_store::open(fixture.home.path()).unwrap().execute_batch("CREATE TRIGGER refuse_policy BEFORE UPDATE ON native_delete_options BEGIN SELECT RAISE(ABORT,'fixture'); END;").unwrap();
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
        assert!(
            runtime_store::open(fixture.home.path())
                .unwrap()
                .query_row("SELECT count(*) FROM native_delete_options", [], |r| r
                    .get::<_, i64>(0))
                .unwrap()
                == 0
        );
        assert_eq!(state["live_aliases"], if close_failure { 2 } else { 0 });
        assert_eq!(state["legacy_messages"], 1);
        assert_eq!(state["memory"], "Durable memory");
        assert!(catalog::section(fixture.home.path(), "local", &fixture.id).is_ok());
    }
}

#[test]
fn failed_close_preserves_prior_retained_tombstones_and_legacy_only_ownership() {
    for legacy_only in [true, false] {
        let mut fixture = Fixture::new();
        let h = fixture.home.path();
        let conn = runtime_store::open(h).unwrap();
        if legacy_only {
            conn.execute(
                "DELETE FROM native_sessions WHERE stored_id=?",
                [&fixture.id],
            )
            .unwrap();
            fixture.dispatch_delete("local", Some(false)).unwrap();
        } else {
            // The child was already retained before a fresh parent deletion.
            conn.execute("INSERT INTO native_deleted VALUES(?)", [&fixture.child])
                .unwrap();
            conn.execute(
                "INSERT INTO native_delete_options VALUES(?,'owl','local',0)",
                [&fixture.child],
            )
            .unwrap();
        }
        let before = hexbot_core::common::rows(
            &conn,
            "SELECT * FROM native_delete_options ORDER BY session_id",
            &[],
        )
        .unwrap();
        // A concrete close failure after tombstoning: the child's live alias
        // belongs to a different owner. No process or provider is needed.
        conn.execute(
            "UPDATE native_sessions SET owner='bob' WHERE stored_id=?",
            [&fixture.child],
        )
        .unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO native_live_sessions VALUES(?,'fault-alias')",
            [&fixture.child],
        )
        .unwrap();
        assert_eq!(
            run(fixture.app.runtime.retire_stored("local", &fixture.id))
                .unwrap_err()
                .code,
            4302
        );
        assert_eq!(
            hexbot_core::common::rows(
                &conn,
                "SELECT * FROM native_delete_options ORDER BY session_id",
                &[]
            )
            .unwrap(),
            before
        );
        let tombstones: Vec<String> = conn
            .prepare("SELECT session_id FROM native_deleted ORDER BY session_id")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        let mut expected = if legacy_only {
            vec![fixture.id.clone(), fixture.child.clone()]
        } else {
            vec![fixture.child.clone()]
        };
        expected.sort();
        assert_eq!(tombstones, expected);
        let source = if legacy_only {
            fixture.id.clone()
        } else {
            fixture.child.clone()
        };
        assert_eq!(
            run(product::call(
                h,
                "local",
                "owl",
                &source,
                "todo_list",
                &json!({"todos":[]})
            ))
            .unwrap()
            .unwrap_err()
            .code,
            4001
        );
        assert!(
            runtime_store::owned_sessions(h, "owl")
                .unwrap()
                .iter()
                .any(|r| r["stored_id"] == source.as_str())
        );
        conn.execute(
            "UPDATE native_sessions SET owner='local' WHERE stored_id=?",
            [&fixture.child],
        )
        .unwrap();
        drop(conn);
        fixture.restart();
        run(fixture
            .app
            .call("local", "hexbot.bots.delete", &json!({"name":"owl"})))
        .unwrap();
        assert!(fixture.completed(&source));
        run(fixture.app.shutdown());
    }
}

#[test]
fn model_changes_preserve_retained_options_and_follow_live_and_hidden_sources() {
    let fixture = Fixture::new();
    let h = fixture.home.path();
    fs::write(
        h.join("profiles/owl/config.yaml"),
        "model:\n  provider: openai\n  default: old\n  reasoning_effort: high\n",
    )
    .unwrap();
    let options = json!({"provider":"openai","model":"old","reasoning_effort":"high","frozen":"keep","skill_catalog":["plan"]}).to_string();
    let conn = runtime_store::open(h).unwrap();
    conn.execute(
        "UPDATE native_sessions SET options=? WHERE stored_id=?",
        rusqlite::params![options, fixture.id],
    )
    .unwrap();
    for id in ["live-control", "hidden-control"] {
        conn.execute(
            "INSERT INTO native_sessions VALUES(?,'local','owl','frozen',?)",
            rusqlite::params![id, options],
        )
        .unwrap();
    }
    db::open(h).unwrap().execute("INSERT INTO sections(id,bot,owner_id,title) VALUES('live-control','owl','local','Control')",[]).unwrap();
    conn.execute(
        "INSERT INTO native_live_sessions VALUES('live-control','live-control-alias')",
        [],
    )
    .unwrap();
    fixture.dispatch_delete("local", Some(false)).unwrap();
    let before = hexbot_core::common::rows(
        &conn,
        "SELECT * FROM native_sessions WHERE stored_id=?",
        &[&fixture.id],
    )
    .unwrap();
    let pi = fs::read(fixture.pi_path(&fixture.id)).unwrap();
    catalog::call(
        h,
        "local",
        "hexbot.bots.update",
        &json!({"name":"owl","provider":"anthropic","model":"new","reasoning_effort":"low"}),
    )
    .unwrap()
    .unwrap();
    assert_eq!(
        hexbot_core::common::rows(
            &conn,
            "SELECT * FROM native_sessions WHERE stored_id=?",
            &[&fixture.id]
        )
        .unwrap(),
        before
    );
    assert_eq!(fs::read(fixture.pi_path(&fixture.id)).unwrap(), pi);
    for id in ["live-control", "hidden-control"] {
        let raw: String = conn
            .query_row(
                "SELECT options FROM native_sessions WHERE stored_id=?",
                [id],
                |r| r.get(0),
            )
            .unwrap();
        let mut expected: Value = serde_json::from_str(&options).unwrap();
        expected["provider"] = json!("anthropic");
        expected["model"] = json!("new");
        expected["reasoning_effort"] = json!("low");
        assert_eq!(serde_json::from_str::<Value>(&raw).unwrap(), expected);
    }
    run(fixture.app.shutdown());
}

#[test]
fn bot_delete_waits_for_catalog_commit_before_purging_or_completing_history() {
    let fixture = Fixture::new();
    db::open(fixture.home.path()).unwrap().execute_batch("CREATE TRIGGER refuse_delete BEFORE DELETE ON sections BEGIN SELECT RAISE(ABORT,'fixture'); END;").unwrap();
    run(async {
        assert!(
            fixture
                .app
                .call("local", "hexbot.bots.delete", &json!({"name":"owl"}))
                .await
                .is_err()
        );
        fixture.app.shutdown().await;
    });
    let state = fixture.snapshot();
    for key in ["parent_messages", "child_messages", "legacy_messages"] {
        assert_eq!(state[key], 1, "{key}");
    }
    assert_eq!(state["parent_pi"], true);
    assert_eq!(state["child_pi"], true);
    assert!(!fixture.completed(&fixture.id));
    assert!(!fixture.completed(&fixture.child));
    assert!(catalog::section(fixture.home.path(), "local", &fixture.id).is_ok());
}

#[test]
fn startup_obeys_disposition_at_each_catalog_commit_boundary() {
    for keep_catalog in [true, false] {
        for purge in [None, Some(true), Some(false)] {
            let mut fixture = Fixture::new();
            let h = fixture.home.path();
            // Model a process exit after durable tombstoning, optionally after
            // the catalog transaction, before any history removal.
            runtime_store::mark_deleted(h, &fixture.id).unwrap();
            let native = runtime_store::open(h).unwrap();
            if let Some(purge) = purge {
                native
                    .execute("UPDATE native_delete_options SET purge=?", [purge])
                    .unwrap();
            } else {
                // Tombstones written by builds before retention disposition.
                native
                    .execute("DELETE FROM native_delete_options", [])
                    .unwrap();
            }
            if !keep_catalog {
                db::open(h)
                    .unwrap()
                    .execute("DELETE FROM sections WHERE id=?", [&fixture.id])
                    .unwrap();
            }
            fixture.restart();
            let state = fixture.snapshot();
            let keep_history = keep_catalog || purge == Some(false);
            assert_eq!(state["parent_messages"], usize::from(keep_history));
            assert_eq!(state["child_messages"], usize::from(keep_history));
            assert_eq!(state["parent_pi"], keep_history);
            assert_eq!(state["child_pi"], keep_history);
            assert_eq!(state["tombstones"], if keep_catalog { 0 } else { 2 });
            // Native ownership can still recover the bot for old tombstones.
            assert_eq!(state["legacy_messages"], usize::from(keep_history));
            for stored in [&fixture.id, &fixture.child] {
                assert_eq!(
                    runtime_store::session_dir(fixture.home.path(), stored).is_ok(),
                    keep_catalog
                );
            }
        }
    }
}

#[test]
fn startup_finishes_failed_native_or_legacy_purge_after_catalog_removal() {
    for native_failure in [true, false] {
        let mut fixture = Fixture::new();
        let h = fixture.home.path();
        let conn = if native_failure {
            runtime_store::open(h).unwrap()
        } else {
            rusqlite::Connection::open(h.join("profiles/owl/state.db")).unwrap()
        };
        let trigger = if native_failure {
            format!(
                "CREATE TRIGGER fail_purge BEFORE DELETE ON native_sessions WHEN OLD.stored_id='{}' BEGIN SELECT RAISE(ABORT,'fixture'); END;",
                fixture.id
            )
        } else {
            "CREATE TRIGGER fail_purge BEFORE DELETE ON messages BEGIN SELECT RAISE(ABORT,'fixture'); END;".into()
        };
        conn.execute_batch(&trigger).unwrap();
        assert_eq!(
            fixture.dispatch_delete("local", Some(true)).unwrap(),
            json!({"deleted":true,"history_pending":true})
        );
        assert!(catalog::section(h, "local", &fixture.id).is_err());
        let partial = fixture.snapshot();
        assert_eq!(partial["parent_messages"], usize::from(native_failure));
        assert_eq!(partial["child_messages"], 0);
        assert_eq!(partial["legacy_messages"], 1);
        assert!(!fixture.completed(&fixture.id));
        assert!(fixture.completed(&fixture.child));
        fixture.restart();
        assert!(!fixture.completed(&fixture.id));
        conn.execute_batch("DROP TRIGGER fail_purge").unwrap();
        fixture.restart();
        let state = fixture.snapshot();
        for key in [
            "parent_messages",
            "child_messages",
            "sessions",
            "legacy_messages",
        ] {
            assert_eq!(state[key], 0, "{key}");
        }
        assert_eq!(state["parent_pi"], false);
        assert_eq!(state["child_pi"], false);
        assert_eq!(state["tombstones"], 2);
        assert_eq!(state["memory"], "Durable memory");
        assert!(fixture.completed(&fixture.id));
        assert!(fixture.completed(&fixture.child));
        assert!(
            runtime_store::owned_sessions(fixture.home.path(), "owl")
                .unwrap()
                .is_empty()
        );
    }
}

#[test]
fn bot_delete_finds_retained_root_without_native_or_catalog_row() {
    let mut fixture = Fixture::new();
    let h = fixture.home.path();
    // A legacy-only conversation has no native ownership row. Its retained
    // tombstone must carry ownership until the bot is deleted.
    runtime_store::open(h)
        .unwrap()
        .execute(
            "DELETE FROM native_sessions WHERE stored_id=?",
            [&fixture.id],
        )
        .unwrap();
    fixture.dispatch_delete("local", Some(false)).unwrap();
    fixture.restart();
    assert_eq!(fixture.snapshot()["sessions"], 1);
    assert_eq!(fixture.snapshot()["parent_messages"], 1);
    run(async {
        fixture
            .app
            .call("local", "hexbot.bots.delete", &json!({"name":"owl"}))
            .await
            .unwrap();
        fixture.app.shutdown().await;
    });
    assert!(
        runtime_store::history(fixture.home.path(), &fixture.id)
            .unwrap()
            .is_empty()
    );
    assert!(!fixture.pi_path(&fixture.id).exists());
    assert!(!fixture.pi_path(&fixture.child).exists());
    assert!(!fixture.home.path().join("profiles/owl/state.db").exists());
}

#[cfg(unix)]
#[test]
fn inaccessible_legacy_directory_never_counts_as_completed_cleanup() {
    use std::os::unix::fs::PermissionsExt;
    let mut fixture = Fixture::new();
    let profile = fixture.home.path().join("profiles/owl");
    let permissions = fs::metadata(&profile).unwrap().permissions();
    fs::set_permissions(&profile, fs::Permissions::from_mode(0o000)).unwrap();
    if profile.join("state.db").try_exists().is_ok() {
        // Root and filesystems that ignore directory permissions cannot model
        // an unreadable legacy database. Restore access before returning.
        fs::set_permissions(&profile, permissions).unwrap();
        return;
    }
    let deleted = fixture.dispatch_delete("local", Some(true));
    fs::set_permissions(&profile, permissions).unwrap();
    deleted.unwrap();
    assert!(!fixture.completed(&fixture.id));
    assert!(!fixture.completed(&fixture.child));
    assert_eq!(fixture.snapshot()["legacy_messages"], 1);
    fixture.restart();
    assert!(fixture.completed(&fixture.id));
    assert!(fixture.completed(&fixture.child));
    assert_eq!(fixture.snapshot()["legacy_messages"], 0);
}

#[cfg(unix)]
#[test]
fn deletion_never_follows_session_symlinks_and_bot_cleanup_retries_files() {
    use std::os::unix::fs::symlink;
    let mut fixture = Fixture::new();
    let outside = tempfile::tempdir().unwrap();
    fs::write(outside.path().join("keep.txt"), "Outside").unwrap();
    let sessions = fixture.home.path().join("runtime/sessions");
    let held = fixture.home.path().join("runtime/sessions-held");
    fs::rename(&sessions, &held).unwrap();
    symlink(outside.path(), &sessions).unwrap();
    fixture.dispatch_delete("local", Some(true)).unwrap();
    assert_eq!(
        fs::read_to_string(outside.path().join("keep.txt")).unwrap(),
        "Outside"
    );
    // Simulate a crash with metadata already gone, then repair the path. The
    // persisted ownership must let bot.delete find the remaining directory.
    fixture.restart();
    fs::remove_file(&sessions).unwrap();
    fs::rename(&held, &sessions).unwrap();
    run(async {
        fixture
            .app
            .call("local", "hexbot.bots.delete", &json!({"name":"owl"}))
            .await
            .unwrap();
        fixture.app.shutdown().await;
    });
    assert!(!fixture.pi_path(&fixture.id).exists());
    assert!(!fixture.pi_path(&fixture.child).exists());
    // Leaf symlinks, including broken ones, are removed without touching targets.
    assert!(fixture.completed(&fixture.id));
    assert!(fixture.completed(&fixture.child));
    for target in [outside.path().to_path_buf(), outside.path().join("missing")] {
        symlink(&target, sessions.join("leaf")).unwrap();
        runtime_store::delete(fixture.home.path(), "leaf").unwrap();
        assert!(fs::symlink_metadata(sessions.join("leaf")).is_err());
    }
    assert_eq!(
        fs::read_to_string(outside.path().join("keep.txt")).unwrap(),
        "Outside"
    );
}

#[test]
fn old_tombstone_without_ownership_purges_native_files_and_leaves_legacy_unread() {
    let mut fixture = Fixture::new();
    let h = fixture.home.path();
    runtime_store::mark_deleted(h, &fixture.id).unwrap();
    let native = runtime_store::open(h).unwrap();
    native.execute("DELETE FROM native_sessions", []).unwrap();
    native
        .execute("DELETE FROM native_delete_options", [])
        .unwrap();
    db::open(h)
        .unwrap()
        .execute("DELETE FROM sections WHERE id=?", [&fixture.id])
        .unwrap();
    fixture.restart();
    let state = fixture.snapshot();
    assert_eq!(state["parent_messages"], 0);
    assert_eq!(state["child_messages"], 0);
    assert_eq!(state["parent_pi"], false);
    assert_eq!(state["child_pi"], false);
    assert_eq!(state["legacy_messages"], 1);
    run(fixture.assert_closed());
}

#[test]
fn startup_upgrades_old_cleanup_schema_and_completes_each_orphaned_child() {
    let mut fixture = Fixture::new();
    let h = fixture.home.path();
    runtime_store::mark_deleted(h, &fixture.id).unwrap();
    let native = runtime_store::open(h).unwrap();
    // Old builds persisted tombstones and disposition but no completion table.
    native
        .execute_batch("DROP TABLE native_delete_completed; DELETE FROM native_sessions;")
        .unwrap();
    db::open(h)
        .unwrap()
        .execute("DELETE FROM sections WHERE id=?", [&fixture.id])
        .unwrap();
    fixture.restart();
    assert!(fixture.completed(&fixture.id));
    assert!(fixture.completed(&fixture.child));
    assert_eq!(fixture.snapshot()["legacy_messages"], 0);
    assert!(!fixture.pi_path(&fixture.id).exists());
    assert!(!fixture.pi_path(&fixture.child).exists());
    assert!(
        runtime_store::owned_sessions(fixture.home.path(), "owl")
            .unwrap()
            .is_empty()
    );
    run(fixture.assert_closed());
}

fn policies(home: &std::path::Path) -> Vec<Value> {
    hexbot_core::common::rows(
        &runtime_store::open(home).unwrap(),
        "SELECT * FROM native_delete_options ORDER BY session_id",
        &[],
    )
    .unwrap()
}

fn retain_child(fixture: &Fixture) {
    let h = fixture.home.path();
    db::open(h)
        .unwrap()
        .execute(
            "INSERT INTO sections(id,bot,owner_id) VALUES(?,'owl','local')",
            [&fixture.child],
        )
        .unwrap();
    catalog::call(
        h,
        "local",
        "hexbot.sections.delete",
        &json!({"id":fixture.child,"purge_memory":false}),
    )
    .unwrap()
    .unwrap();
}

fn assert_blocked(fixture: &Fixture, id: &str) {
    let h = fixture.home.path();
    assert_eq!(
        runtime_store::append(h, id, json!({"role":"user","text":"late"}))
            .unwrap_err()
            .code,
        4001
    );
    assert_eq!(
        run(product::call(
            h,
            "local",
            "owl",
            id,
            "todo_list",
            &json!({"todos":[]})
        ))
        .unwrap()
        .unwrap_err()
        .code,
        4001
    );
}

#[test]
fn failed_parent_delete_preserves_committed_child_disposition() {
    for public in [false, true] {
        for fault in ["disposition", "catalog"] {
            for legacy_only in [false, true] {
                let mut fixture = Fixture::new();
                retain_child(&fixture);
                let h = fixture.home.path();
                fs::write(
                    h.join("profiles/owl/config.yaml"),
                    "tools:\n  enabled_toolsets: [todo, skills]\n",
                )
                .unwrap();
                if legacy_only {
                    runtime_store::open(h)
                        .unwrap()
                        .execute(
                            "DELETE FROM native_sessions WHERE stored_id=?",
                            [&fixture.id],
                        )
                        .unwrap();
                }
                let before = policies(h);
                let native = runtime_store::open(h).unwrap();
                let catalog = db::open(h).unwrap();
                if fault == "disposition" {
                    for (trigger, event) in
                        [("refuse_insert", "INSERT"), ("refuse_policy", "UPDATE")]
                    {
                        native.execute_batch(&format!("CREATE TRIGGER {trigger} BEFORE {event} ON native_delete_options WHEN NEW.session_id='{}' AND NEW.purge=0 BEGIN SELECT RAISE(ABORT,'disposition fault'); END;", fixture.id)).unwrap();
                    }
                } else {
                    // Deferred FK checks fail at COMMIT, after the DELETE succeeded.
                    catalog.execute_batch("CREATE TABLE commit_fault(section_id TEXT REFERENCES sections(id) DEFERRABLE INITIALLY DEFERRED);").unwrap();
                    catalog
                        .execute("INSERT INTO commit_fault VALUES(?)", [&fixture.id])
                        .unwrap();
                }
                let result = if public {
                    fixture.dispatch_delete("local", Some(fault != "disposition"))
                } else {
                    catalog::call(
                        h,
                        "local",
                        "hexbot.sections.delete",
                        &json!({"id":fixture.id,"purge_memory":fault != "disposition"}),
                    )
                    .unwrap()
                };
                assert!(result.is_err(), "public={public}, fault={fault}");
                assert_eq!(
                    policies(h),
                    before,
                    "public={public}, fault={fault}, legacy={legacy_only}"
                );
                assert_blocked(&fixture, &fixture.child);
                assert!(runtime_store::session_dir(h, &fixture.id).is_ok());
                assert!(catalog::section(h, "local", &fixture.id).is_ok());
                run(product::call(
                    h,
                    "local",
                    "owl",
                    &fixture.id,
                    "todo_list",
                    &json!({"todos":[]}),
                ))
                .unwrap()
                .unwrap();
                if fault == "disposition" {
                    native
                        .execute_batch("DROP TRIGGER refuse_policy; DROP TRIGGER refuse_insert")
                        .unwrap();
                } else {
                    catalog.execute_batch("DROP TABLE commit_fault").unwrap();
                }
                fixture.restart();
                assert_eq!(policies(fixture.home.path()), before);
                assert_blocked(&fixture, &fixture.child);
                assert!(runtime_store::session_dir(fixture.home.path(), &fixture.id).is_ok());
                run(fixture.app.shutdown());
            }
        }
    }
}

#[test]
fn startup_parent_rollback_preserves_committed_retained_child() {
    for old_markers in [false, true] {
        for completed in [false, true] {
            let mut fixture = Fixture::new();
            retain_child(&fixture);
            let h = fixture.home.path();
            let native = runtime_store::open(h).unwrap();
            if completed {
                native
                    .execute(
                        "INSERT INTO native_delete_completed VALUES(?)",
                        [&fixture.child],
                    )
                    .unwrap();
            }
            let before = policies(h);
            if old_markers {
                // Tombstones already on disk when upgrading from 673 carry
                // no provisional provenance. Never infer that an unlisted
                // descendant belongs to this parent's interrupted attempt.
                native
                    .execute("INSERT INTO native_deleted VALUES(?)", [&fixture.id])
                    .unwrap();
                native
                    .execute(
                        "INSERT INTO native_delete_options VALUES(?,'owl','local',1)",
                        [&fixture.id],
                    )
                    .unwrap();
            } else {
                runtime_store::mark_deleted(h, &fixture.id).unwrap();
            }
            fixture.restart();
            assert_eq!(policies(fixture.home.path()), before);
            assert_blocked(&fixture, &fixture.child);
            assert_eq!(fixture.completed(&fixture.child), completed);
            assert!(runtime_store::session_dir(fixture.home.path(), &fixture.id).is_ok());
            run(fixture.app.shutdown());
        }
    }
}

#[test]
fn bot_cleanup_never_repeats_completed_descendants_in_either_order() {
    for root in ["a-parent", "z-parent"] {
        let mut fixture = Fixture::with_root(Some(root));
        fixture.dispatch_delete("local", Some(false)).unwrap();
        fixture.restart();
        let h = fixture.home.path();
        runtime_store::open(h).unwrap().execute_batch(
            "CREATE TRIGGER refuse_repeat BEFORE DELETE ON native_delete_completed BEGIN SELECT RAISE(ABORT,'completed cleanup repeated'); END;").unwrap();
        run(fixture
            .app
            .call("local", "hexbot.bots.delete", &json!({"name":"owl"})))
        .unwrap();
        assert!(fixture.completed(&fixture.id));
        assert!(fixture.completed(&fixture.child));
        run(fixture.app.shutdown());
    }
}

#[test]
fn overlapping_public_deletes_cannot_undo_a_successful_retention() {
    check_overlapping_deletes(true);
}

#[test]
fn overlapping_catalog_deletes_cannot_undo_a_successful_retention() {
    check_overlapping_deletes(false);
}

fn check_overlapping_deletes(public: bool) {
    use std::{
        sync::mpsc,
        thread,
        time::{Duration, Instant},
    };
    let mut fixture = Fixture::new();
    let h = fixture.home.path();
    fs::write(
        h.join("profiles/owl/config.yaml"),
        "tools:\n  enabled_toolsets: [todo, skills]\n",
    )
    .unwrap();
    let native = runtime_store::open(h).unwrap();
    native
        .execute("DELETE FROM native_live_sessions", [])
        .unwrap();
    native.execute_batch("CREATE TABLE policy_commits(n INTEGER); INSERT INTO policy_commits VALUES(0); CREATE TRIGGER observe_policy AFTER UPDATE ON native_delete_options WHEN NEW.session_id NOT LIKE 'child-%' BEGIN UPDATE policy_commits SET n=n+1; END;").unwrap();
    let mut catalog_writer = db::open(h).unwrap();
    let writer = catalog_writer
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .unwrap();
    let delete = move |app: Arc<App>, id: String, purge: bool| {
        let args = json!({"id":id,"purge_memory":purge});
        if public {
            run(app.call("local", "hexbot.sections.delete", &args))
        } else {
            catalog::call(&app.home, "local", "hexbot.sections.delete", &args).unwrap()
        }
    };
    let (finished, first) = mpsc::channel();
    let app = fixture.app.clone();
    let root = fixture.id.clone();
    let a = thread::spawn(move || finished.send(delete(app, root, true)).unwrap());
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let n: i64 = native
            .query_row("SELECT n FROM policy_commits", [], |r| r.get(0))
            .unwrap();
        if n >= 1 {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "first disposition did not commit"
        );
        thread::yield_now();
    }
    // Reproduce the independent review's SQLite barrier. This reserves
    // only the native writer and forces its ordinary five-second timeout,
    // leaving reads free and separating the two catalog waiters.
    let mut native_writer = runtime_store::open(h).unwrap();
    let native_tx = native_writer
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .unwrap();
    let path = h.to_path_buf();
    assert!(
        thread::spawn(move || runtime_store::append(
            &path,
            "timeout-probe",
            json!({"role":"user","text":"blocked"})
        ))
        .join()
        .unwrap()
        .is_err()
    );
    native_tx.rollback().unwrap();
    let app = fixture.app.clone();
    let root = fixture.id.clone();
    let (started, second_started) = mpsc::channel();
    let b = thread::spawn(move || {
        started.send(()).unwrap();
        delete(app, root, false)
    });
    second_started.recv().unwrap();
    // On 673 both disposition commits precede A's failure. With the
    // serialized boundary B waits there instead. In either case A must
    // return its real catalog error before the reserved writer is released.
    assert!(
        first
            .recv_timeout(Duration::from_secs(20))
            .unwrap()
            .is_err()
    );
    writer.rollback().unwrap();
    a.join().unwrap();
    assert_eq!(b.join().unwrap().unwrap(), json!({"deleted":true}));
    assert_eq!(policies(h).len(), 2);
    assert!(policies(h).iter().all(|r| r["purge"] == 0));
    assert_blocked(&fixture, &fixture.id);
    assert_blocked(&fixture, &fixture.child);
    assert!(!fixture.completed(&fixture.id));
    fixture.restart();
    assert_blocked(&fixture, &fixture.id);
    assert_blocked(&fixture, &fixture.child);
    run(fixture.app.shutdown());
}

#[test]
fn completed_descendants_stay_skipped_until_an_explicit_retry() {
    let mut fixture = Fixture::new();
    let h = fixture.home.path();
    let native = runtime_store::open(h).unwrap();
    native.execute_batch(&format!("CREATE TRIGGER fail_parent BEFORE DELETE ON native_sessions WHEN OLD.stored_id='{}' BEGIN SELECT RAISE(ABORT,'parent fault'); END;", fixture.id)).unwrap();
    fixture.dispatch_delete("local", Some(true)).unwrap();
    assert!(fixture.completed(&fixture.child));
    assert!(!fixture.completed(&fixture.id));
    // Replacement artifacts make any repeated cleanup observable on all three
    // stores, even while the unfinished parent still has a relationship row.
    native
        .execute(
            "INSERT INTO native_sessions VALUES(?,'local','owl','replacement',?)",
            rusqlite::params![
                fixture.child,
                json!({"parent_session":fixture.id}).to_string()
            ],
        )
        .unwrap();
    native
        .execute(
            "INSERT INTO native_messages VALUES(?,1,'{}')",
            [&fixture.child],
        )
        .unwrap();
    let dir = fixture
        .pi_path(&fixture.child)
        .parent()
        .unwrap()
        .to_path_buf();
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("barrier"), "replacement").unwrap();
    let legacy = rusqlite::Connection::open(h.join("profiles/owl/state.db")).unwrap();
    legacy
        .execute("INSERT INTO sessions VALUES(?)", [&fixture.child])
        .unwrap();
    legacy
        .execute(
            "INSERT INTO messages VALUES(2,?,'user','replacement')",
            [&fixture.child],
        )
        .unwrap();
    native.execute_batch("DROP TRIGGER fail_parent; CREATE TRIGGER refuse_repeat BEFORE DELETE ON native_delete_completed BEGIN SELECT RAISE(ABORT,'repeated completed cleanup'); END;").unwrap();
    runtime_store::finish_deletes(h).unwrap();
    assert!(fixture.completed(&fixture.id));
    assert!(fixture.completed(&fixture.child));
    assert_eq!(runtime_store::history(h, &fixture.child).unwrap().len(), 1);
    assert_eq!(
        fs::read_to_string(dir.join("barrier")).unwrap(),
        "replacement"
    );
    assert_eq!(
        legacy
            .query_row("SELECT count(*) FROM messages", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
    fixture.restart();
    let h = fixture.home.path();
    assert_eq!(runtime_store::history(h, &fixture.child).unwrap().len(), 1);
    native.execute_batch("DROP TRIGGER refuse_repeat").unwrap();
    runtime_store::delete(h, &fixture.child).unwrap();
    assert!(
        runtime_store::history(h, &fixture.child)
            .unwrap()
            .is_empty()
    );
    assert!(!dir.exists());
    assert_eq!(
        legacy
            .query_row("SELECT count(*) FROM messages", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert!(fixture.completed(&fixture.child));
    run(fixture.app.shutdown());
}

#[test]
fn postcommit_marker_failure_never_rolls_back_a_delete() {
    for purge in [false, true] {
        let mut fixture = Fixture::new();
        let h = fixture.home.path();
        let native = runtime_store::open(h).unwrap();
        native.execute_batch("CREATE TRIGGER fail_finalize BEFORE DELETE ON native_delete_pending BEGIN SELECT RAISE(ABORT,'finalization fault'); END;").unwrap();
        fixture.dispatch_delete("local", Some(purge)).unwrap();
        assert!(catalog::section(h, "local", &fixture.id).is_err());
        assert_blocked(&fixture, &fixture.id);
        assert_blocked(&fixture, &fixture.child);
        assert!(!fixture.completed(&fixture.id));
        assert_eq!(runtime_store::history(h, &fixture.id).unwrap().len(), 1);
        native.execute_batch("DROP TRIGGER fail_finalize").unwrap();
        fixture.restart();
        assert_blocked(&fixture, &fixture.id);
        assert_blocked(&fixture, &fixture.child);
        assert_eq!(
            runtime_store::history(fixture.home.path(), &fixture.id)
                .unwrap()
                .len(),
            usize::from(!purge)
        );
        assert_eq!(fixture.completed(&fixture.id), purge);
        run(fixture.app.shutdown());
    }
}

#[test]
fn failed_parent_commit_preserves_completed_child_and_frozen_options() {
    for public in [false, true] {
        let mut fixture = Fixture::new();
        retain_child(&fixture);
        let h = fixture.home.path();
        let native = runtime_store::open(h).unwrap();
        native
            .execute(
                "INSERT INTO native_delete_completed VALUES(?)",
                [&fixture.child],
            )
            .unwrap();
        native.execute("UPDATE native_sessions SET prompt='original prompt',options=? WHERE stored_id=?",rusqlite::params![json!({"parent_session":fixture.id,"provider":"openai","model":"frozen","skill_catalog":["keep"]}).to_string(),fixture.child]).unwrap();
        let before = policies(h);
        let settings = hexbot_core::common::rows(
            &native,
            "SELECT * FROM native_sessions ORDER BY stored_id",
            &[],
        )
        .unwrap();
        let conn = db::open(h).unwrap();
        conn.execute_batch("CREATE TABLE commit_fault(section_id TEXT REFERENCES sections(id) DEFERRABLE INITIALLY DEFERRED);").unwrap();
        conn.execute("INSERT INTO commit_fault VALUES(?)", [&fixture.id])
            .unwrap();
        let args = json!({"id":fixture.id,"purge_memory":true});
        let result = if public {
            run(fixture.app.call("local", "hexbot.sections.delete", &args))
        } else {
            catalog::call(h, "local", "hexbot.sections.delete", &args).unwrap()
        };
        assert!(result.is_err());
        assert_eq!(policies(h), before);
        assert!(fixture.completed(&fixture.child));
        assert_eq!(
            hexbot_core::common::rows(
                &native,
                "SELECT * FROM native_sessions ORDER BY stored_id",
                &[]
            )
            .unwrap(),
            settings
        );
        assert_blocked(&fixture, &fixture.child);
        conn.execute_batch("DROP TABLE commit_fault").unwrap();
        fixture.restart();
        assert_eq!(policies(fixture.home.path()), before);
        assert!(fixture.completed(&fixture.child));
        assert_blocked(&fixture, &fixture.child);
        assert!(runtime_store::session_dir(fixture.home.path(), &fixture.id).is_ok());
        run(fixture.app.shutdown());
    }
}

#[test]
fn migration_failures_preserve_retention_and_skip_unreadable_canonical_chats() {
    for catalog_failure in [false, true] {
        for purge_unreadable in [false, true] {
            let mut fixture = Fixture::new();
            let h = fixture.home.path();
            let native = runtime_store::open(h).unwrap();
            // An independent retained section must never be ranked, rewritten
            // by recovery, or swept up by the one-chat migration.
            native.execute("UPDATE native_sessions SET options='{\"frozen\":\"retained\"}' WHERE stored_id=?", [&fixture.child]).unwrap();
            retain_child(&fixture);
            let retained_pi = fs::read(fixture.pi_path(&fixture.child)).unwrap();
            let retained_policy = policies(h);
            let catalog = db::open(h).unwrap();
            catalog.execute_batch("DELETE FROM settings WHERE key='one_chat_per_bot'; INSERT INTO sections(id,bot,owner_id,title,updated_at) VALUES('keeper','owl','local','Keeper',4000000000),('later','owl','local','Later',1);").unwrap();
            catalog
                .execute("UPDATE sections SET updated_at=2 WHERE id=?", [&fixture.id])
                .unwrap();
            for (id, time) in [("keeper", 4000000000_i64), ("later", 1)] {
                runtime_store::append(h, id, json!({"role":"user","text":id,"timestamp":time}))
                    .unwrap();
            }
            if catalog_failure {
                catalog.execute_batch("CREATE TABLE commit_fault(section_id TEXT REFERENCES sections(id) DEFERRABLE INITIALLY DEFERRED);").unwrap();
                catalog
                    .execute("INSERT INTO commit_fault VALUES(?)", [&fixture.id])
                    .unwrap();
            } else {
                native.execute_batch(&format!("CREATE TRIGGER fail_purge BEFORE DELETE ON native_messages WHEN OLD.session_id='{}' BEGIN SELECT RAISE(ABORT,'migration cleanup fault'); END;",fixture.id)).unwrap();
            }
            catalog::one_chat_per_bot(h).unwrap();
            assert_eq!(
                catalog::section(h, "local", &fixture.id).is_ok(),
                catalog_failure
            );
            assert!(catalog::section(h, "local", "later").is_ok());
            assert_eq!(runtime_store::history(h, &fixture.child).unwrap().len(), 1);
            assert_eq!(
                policies(h)
                    .iter()
                    .find(|r| r["session_id"] == fixture.child)
                    .unwrap(),
                &retained_policy[0]
            );
            if catalog_failure {
                catalog.execute_batch("DROP TABLE commit_fault").unwrap();
            } else {
                native.execute_batch("DROP TRIGGER fail_purge").unwrap();
            }
            runtime_store::finish_deletes(h).unwrap();
            catalog::one_chat_per_bot(h).unwrap();
            // The one-shot migration never retries catalog deletes or reaches
            // the later section after either kind of failure.
            assert!(catalog::section(h, "local", "later").is_ok());
            assert_eq!(
                catalog::section(h, "local", &fixture.id).is_ok(),
                catalog_failure
            );
            catalog.execute_batch("INSERT INTO sections(id,bot,owner_id,title,updated_at) VALUES('unreadable','owl','local','Unreadable',5000000000);").unwrap();
            native
                .execute(
                    "INSERT INTO native_sessions VALUES('unreadable','local','owl','frozen','{}')",
                    [],
                )
                .unwrap();
            let unreadable = runtime_store::session_dir(h, "unreadable")
                .unwrap()
                .join("conversation.jsonl");
            fs::create_dir_all(&unreadable).unwrap();
            fs::write(unreadable.join("kept"), "repair me").unwrap();
            fixture.restart();
            let h = fixture.home.path();
            let selected =
                catalog::call(h, "local", "hexbot.sections.create", &json!({"bot":"owl"}))
                    .unwrap()
                    .unwrap();
            assert_eq!(selected["section"]["id"], "keeper");
            assert_eq!(
                fs::read(fixture.pi_path(&fixture.child)).unwrap(),
                retained_pi
            );
            assert_blocked(&fixture, &fixture.child);
            assert_eq!(
                policies(h)
                    .iter()
                    .find(|r| r["session_id"] == fixture.child)
                    .unwrap(),
                &retained_policy[0]
            );
            catalog::call(
                h,
                "local",
                "hexbot.sections.delete",
                &json!({"id":"unreadable","purge_memory":purge_unreadable}),
            )
            .unwrap()
            .unwrap();
            let marked: bool = native
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM native_unrecovered WHERE session_id='unreadable')",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(marked, !purge_unreadable);
            assert_eq!(unreadable.exists(), !purge_unreadable);
            assert_eq!(
                runtime_store::session_dir(h, "unreadable")
                    .unwrap_err()
                    .code,
                4001
            );
            run(fixture.app.shutdown());
        }
    }
}

#[test]
fn retained_nested_delete_survives_failed_parent_and_restart() {
    check_committed_nested_delete(false);
}
#[test]
fn purged_nested_delete_survives_failed_parent_and_restart() {
    check_committed_nested_delete(true);
}
fn check_committed_nested_delete(purge: bool) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    for marker_fault in [false, true] {
        let home = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let h = home.path();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let pi = h.join("pi.cjs");
        fs::write(&pi, format!(r#"#!/usr/bin/env node
const net = require('node:net');
const rl = require('node:readline').createInterface({{input: process.stdin}});
rl.on('line', line => {{
  const c = JSON.parse(line);
  if (c.type !== 'extension_ui_response') process.stdout.write(JSON.stringify({{type:'response',id:c.id,command:c.type,success:true,data:{{}}}})+'\n');
}});
process.on('SIGTERM', () => {{
  const s = net.connect({port}, '127.0.0.1', () => s.write('stopping\n'));
  s.on('data', () => process.exit(0));
}});
"#)).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&pi, fs::Permissions::from_mode(0o755)).unwrap();
        }
        let app = App::new(h.into(), "127.0.0.1:0".parse().unwrap(), pi.clone(), None).unwrap();
        let made = catalog::call(
            h,
            "local",
            "hexbot.bots.create",
            &json!({"name":"owl","description":"Fixture"}),
        )
        .unwrap()
        .unwrap();
        let root = made["section"]["id"].as_str().unwrap().to_owned();
        fs::write(h.join("profiles/owl/config.yaml"), "model:\n  provider: openai\n  default: fixture\ntools:\n  enabled_toolsets: [todo, skills]\n").unwrap();
        db::open(h)
            .unwrap()
            .execute(
                "INSERT OR REPLACE INTO settings VALUES('workspace_dir',?)",
                [json!(workspace.path()).to_string()],
            )
            .unwrap();
        run(async {
            let listener = tokio::net::TcpListener::from_std(listener).unwrap();
            app.call("local", "hexbot.sections.open", &json!({"id":root}))
                .await
                .unwrap();
            let catalog_db = db::open(h).unwrap();
            catalog_db
                .execute(
                    "INSERT INTO sections(id,bot,owner_id) VALUES('child','owl','local')",
                    [],
                )
                .unwrap();
            // Fail at COMMIT after the parent's DELETE has succeeded.
            catalog_db.execute_batch("CREATE TABLE parent_commit_fault(section_id TEXT REFERENCES sections(id) DEFERRABLE INITIALLY DEFERRED)").unwrap();
            catalog_db
                .execute("INSERT INTO parent_commit_fault VALUES(?)", [&root])
                .unwrap();
            let native = runtime_store::open(h).unwrap();
            for (stored, parent) in [("child", root.as_str()), ("grandchild", "child")] {
                native.execute("INSERT INTO native_sessions VALUES(?,'local','owl','frozen',?)", rusqlite::params![stored, json!({"parent_session":parent,"cwd":workspace.path(),"skill_catalog":["keep"]}).to_string()]).unwrap();
                runtime_store::append(h, stored, json!({"role":"user","text":"original"})).unwrap();
                fs::write(
                    runtime_store::session_dir(h, stored)
                        .unwrap()
                        .join("retained"),
                    "original",
                )
                .unwrap();
            }
            if marker_fault {
                native.execute_batch("CREATE TRIGGER fail_child_finalize BEFORE DELETE ON native_delete_pending WHEN OLD.session_id='child' BEGIN SELECT RAISE(ABORT,'child final marker fault'); END").unwrap();
            }
            let parent_app = app.clone();
            let parent_root = root.clone();
            let parent = tokio::spawn(async move {
                parent_app
                    .call(
                        "local",
                        "hexbot.sections.delete",
                        &json!({"id":parent_root,"purge_memory":false}),
                    )
                    .await
            });
            let (mut stopped, _) =
                tokio::time::timeout(std::time::Duration::from_secs(5), listener.accept())
                    .await
                    .unwrap()
                    .unwrap();
            let mut signal = [0; 9];
            stopped.read_exact(&mut signal).await.unwrap();
            assert_eq!(&signal, b"stopping\n");
            let child = app
                .call(
                    "local",
                    "hexbot.sections.delete",
                    &json!({"id":"child","purge_memory":purge}),
                )
                .await
                .unwrap();
            assert_eq!(child["deleted"], true);
            assert_eq!(child.get("history_pending").is_some(), marker_fault);
            assert!(!parent.is_finished(), "lost the real shutdown barrier");
            if marker_fault {
                native
                    .execute_batch("DROP TRIGGER fail_child_finalize")
                    .unwrap();
            }
            stopped.write_all(b"release\n").await.unwrap();
            assert!(parent.await.unwrap().is_err());
            assert!(catalog::section(h, "local", &root).is_ok());
            assert!(catalog::section(h, "local", "child").is_err());
            assert_eq!(
                runtime_store::append(h, "child", json!({"role":"user","text":"late"}))
                    .unwrap_err()
                    .code,
                4001
            );
            app.shutdown().await;
        });
        drop(app);
        // Actual App startup runs provisional rollback and purge recovery.
        let app = App::new(h.into(), "127.0.0.1:0".parse().unwrap(), pi, None).unwrap();
        let skill = h.join("profiles/owl/skills/plan/SKILL.md");
        fs::create_dir_all(skill.parent().unwrap()).unwrap();
        let original = "---\nname: plan\ndescription: Use for planning.\n---\nOriginal skill.\n";
        fs::write(&skill, original).unwrap();
        for stored in ["child", "grandchild"] {
            for (tool, args) in [
                (
                    "todo_list",
                    json!({"todos":[{"id":"late","content":"after delete","status":"pending"}]}),
                ),
                (
                    "skill_manage",
                    json!({"operations":[{"name":"plan","action":"patch","old_string":"Original skill.","new_string":"Written after deletion."}]}),
                ),
            ] {
                assert_eq!(
                    run(product::call(h, "local", "owl", stored, tool, &args))
                        .unwrap()
                        .unwrap_err()
                        .code,
                    4001,
                    "purge={purge}, marker_fault={marker_fault}, {stored}, {tool}"
                );
            }
            assert_eq!(
                runtime_store::append(h, stored, json!({"role":"user","text":"late"}))
                    .unwrap_err()
                    .code,
                4001
            );
            assert_eq!(
                runtime_store::history(h, stored).unwrap().len(),
                usize::from(!purge)
            );
            let native = runtime_store::open(h).unwrap();
            let policy: (String, String, bool) = native
                .query_row(
                    "SELECT bot,owner,purge FROM native_delete_options WHERE session_id=?",
                    [stored],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .unwrap();
            assert_eq!(policy, ("owl".into(), "local".into(), purge));
            assert_eq!(
                native
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM native_delete_completed WHERE session_id=?)",
                        [stored],
                        |r| r.get::<_, bool>(0)
                    )
                    .unwrap(),
                purge
            );
            if !purge {
                let (prompt, options): (String, String) = native
                    .query_row(
                        "SELECT prompt,options FROM native_sessions WHERE stored_id=?",
                        [stored],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    )
                    .unwrap();
                assert_eq!(prompt, "frozen");
                assert_eq!(
                    serde_json::from_str::<Value>(&options).unwrap()["skill_catalog"],
                    json!(["keep"])
                );
            }
            assert_eq!(
                h.join("runtime/sessions")
                    .join(stored)
                    .join("retained")
                    .exists(),
                !purge
            );
        }
        assert_eq!(fs::read_to_string(skill).unwrap(), original);
        assert!(runtime_store::session_dir(h, &root).is_ok());
        run(app.shutdown());
    }
}

#[test]
fn failed_nested_catalog_commit_restores_provisional_provenance() {
    let mut fixture = Fixture::new();
    let h = fixture.home.path();
    let catalog_db = db::open(h).unwrap();
    catalog_db
        .execute(
            "INSERT INTO sections(id,bot,owner_id) VALUES(?,'owl','local')",
            [&fixture.child],
        )
        .unwrap();
    run(fixture.app.runtime.retire_stored("local", &fixture.id)).unwrap();
    let native = runtime_store::open(h).unwrap();
    let before = hexbot_core::common::rows(
        &native,
        "SELECT * FROM native_delete_pending ORDER BY session_id",
        &[],
    )
    .unwrap();
    let options = policies(h);
    catalog_db.execute_batch("CREATE TABLE child_commit_fault(section_id TEXT REFERENCES sections(id) DEFERRABLE INITIALLY DEFERRED)").unwrap();
    catalog_db
        .execute("INSERT INTO child_commit_fault VALUES(?)", [&fixture.child])
        .unwrap();
    assert!(
        catalog::call(
            h,
            "local",
            "hexbot.sections.delete",
            &json!({"id":fixture.child,"purge_memory":false})
        )
        .unwrap()
        .is_err()
    );
    assert_eq!(
        hexbot_core::common::rows(
            &native,
            "SELECT * FROM native_delete_pending ORDER BY session_id",
            &[]
        )
        .unwrap(),
        before
    );
    assert_eq!(policies(h), options);
    fixture.restart();
    for stored in [&fixture.id, &fixture.child] {
        assert!(runtime_store::session_dir(fixture.home.path(), stored).is_ok());
        runtime_store::append(
            fixture.home.path(),
            stored,
            json!({"role":"user","text":"still live"}),
        )
        .unwrap();
    }
    run(fixture.app.shutdown());
}

#[test]
fn legacy_recursion_skips_completed_aliases_and_visits_unfinished_descendants() {
    for alias in [false, true] {
        check_completed_legacy_descendant(alias);
    }
}
fn check_completed_legacy_descendant(alias: bool) {
    let mut fixture = Fixture::new();
    let legacy_child = if alias {
        "legacy-child".to_owned()
    } else {
        fixture.child.clone()
    };
    let session_key = alias.then_some(fixture.child.clone());
    let path = fixture.home.path().to_owned();
    let h = path.as_path();
    let legacy = rusqlite::Connection::open(h.join("profiles/owl/state.db")).unwrap();
    legacy.execute_batch("ALTER TABLE sessions ADD COLUMN parent_session_id TEXT; ALTER TABLE sessions ADD COLUMN session_key TEXT").unwrap();
    legacy
        .execute(
            "INSERT INTO sessions VALUES(?,?,?)",
            rusqlite::params![legacy_child, fixture.id, session_key],
        )
        .unwrap();
    legacy
        .execute(
            "INSERT INTO messages VALUES(2,?,'user','original')",
            [&legacy_child],
        )
        .unwrap();
    let native = runtime_store::open(h).unwrap();
    native.execute_batch(&format!("CREATE TRIGGER fail_parent_cleanup BEFORE DELETE ON native_sessions WHEN OLD.stored_id='{}' BEGIN SELECT RAISE(ABORT,'parent cleanup fault'); END", fixture.id)).unwrap();
    assert_eq!(
        fixture.dispatch_delete("local", Some(true)).unwrap(),
        json!({"deleted":true,"history_pending":true})
    );
    assert!(fixture.completed(&fixture.child));
    legacy
        .execute(
            "INSERT INTO sessions VALUES(?,?,?)",
            rusqlite::params![legacy_child, fixture.id, session_key],
        )
        .unwrap();
    legacy
        .execute(
            "INSERT INTO messages VALUES(2,?,'user','replacement')",
            [&legacy_child],
        )
        .unwrap();
    legacy
        .execute(
            "INSERT INTO sessions VALUES('unfinished-leaf',?,NULL)",
            [&legacy_child],
        )
        .unwrap();
    legacy.execute_batch(&format!("INSERT INTO messages VALUES(3,'unfinished-leaf','user','unfinished'); CREATE TABLE repeated_cleanup(id TEXT); CREATE TRIGGER observe_repeat BEFORE DELETE ON sessions WHEN OLD.id='{legacy_child}' BEGIN INSERT INTO repeated_cleanup VALUES(OLD.id); END")).unwrap();
    native
        .execute_batch("DROP TRIGGER fail_parent_cleanup")
        .unwrap();
    fixture.restart();
    assert!(fixture.completed(&fixture.id));
    assert!(fixture.completed(&fixture.child));
    assert_eq!(
        legacy
            .query_row("SELECT count(*) FROM repeated_cleanup", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        legacy
            .query_row(
                "SELECT count(*) FROM messages WHERE session_id=?",
                [&legacy_child],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        1
    );
    assert_eq!(
        legacy
            .query_row(
                "SELECT count(*) FROM messages WHERE session_id='unfinished-leaf'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
    // Bot bulk cleanup must not revisit completed targets either.
    run(fixture
        .app
        .call("local", "hexbot.bots.delete", &json!({"name":"owl"})))
    .unwrap();
    assert_eq!(
        legacy
            .query_row("SELECT count(*) FROM repeated_cleanup", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    // Explicit storage retry still removes replaced legacy artifacts. Restore
    // the profile that bot deletion removed, then use the completed child's ID.
    fs::create_dir_all(h.join("profiles/owl")).unwrap();
    drop(legacy);
    let legacy = rusqlite::Connection::open(h.join("profiles/owl/state.db")).unwrap();
    legacy.execute_batch("CREATE TABLE sessions(id TEXT PRIMARY KEY,parent_session_id TEXT,session_key TEXT); CREATE TABLE messages(session_id TEXT)").unwrap();
    legacy
        .execute(
            "INSERT INTO sessions VALUES(?,NULL,?)",
            rusqlite::params![legacy_child, session_key],
        )
        .unwrap();
    legacy
        .execute("INSERT INTO messages VALUES(?)", [&legacy_child])
        .unwrap();
    assert!(runtime_store::delete(h, &fixture.child).is_err());
    db::open(h)
        .unwrap()
        .execute("INSERT INTO bots(name,owner_id) VALUES('owl','local')", [])
        .unwrap();
    runtime_store::delete(h, &fixture.child).unwrap();
    assert_eq!(
        legacy
            .query_row("SELECT count(*) FROM messages", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
    run(fixture.app.shutdown());
}

/// The whole tombstone format of builds before retention (67e895d
/// `mark_deleted`): native_deleted rows for a root and its delegated tasks.
fn old_build_mark_deleted(h: &std::path::Path, stored: &str) {
    runtime_store::open(h).unwrap().execute("INSERT OR IGNORE INTO native_deleted WITH RECURSIVE tree(id) AS (SELECT ?1 UNION SELECT s.stored_id FROM native_sessions s JOIN tree t ON json_extract(s.options,'$.parent_session')=t.id) SELECT id FROM tree", [stored]).unwrap();
}

fn native_rows(h: &std::path::Path) -> Vec<Value> {
    hexbot_core::common::rows(
        &runtime_store::open(h).unwrap(),
        "SELECT * FROM native_sessions ORDER BY stored_id",
        &[],
    )
    .unwrap()
}

#[test]
fn old_build_section_stop_reopens_the_listed_root_with_its_delegates() {
    for retained_child in [false, true] {
        let mut fixture = Fixture::new();
        if retained_child {
            retain_child(&fixture);
        }
        fixture.restart();
        let path = fixture.home.path().to_owned();
        let h = path.as_path();
        let before = (
            fixture.snapshot(),
            native_rows(h),
            policies(h),
            fs::read(fixture.pi_path(&fixture.id)).unwrap(),
            fs::read(fixture.pi_path(&fixture.child)).unwrap(),
        );
        // An earlier build stopped after Runtime retirement, before the
        // catalog delete. Restart twice: recovery must be idempotent.
        old_build_mark_deleted(h, &fixture.id);
        for _ in 0..2 {
            fixture.restart();
            assert_eq!(fixture.snapshot(), before.0, "retained={retained_child}");
            assert_eq!(native_rows(h), before.1);
            assert_eq!(policies(h), before.2);
            assert_eq!(fs::read(fixture.pi_path(&fixture.id)).unwrap(), before.3);
            assert_eq!(fs::read(fixture.pi_path(&fixture.child)).unwrap(), before.4);
            assert!(catalog::section(h, "local", &fixture.id).is_ok());
            assert!(runtime_store::session_dir(h, &fixture.id).is_ok());
            if retained_child {
                assert_blocked(&fixture, &fixture.child);
            } else {
                assert!(runtime_store::session_dir(h, &fixture.child).is_ok());
            }
        }
        fs::write(
            h.join("profiles/owl/config.yaml"),
            "tools:\n  enabled_toolsets: [todo, skills]\n",
        )
        .unwrap();
        let mut live = vec![fixture.id.clone()];
        if !retained_child {
            live.push(fixture.child.clone());
        }
        for stored in &live {
            runtime_store::append(h, stored, json!({"role":"user","text":"after restart"}))
                .unwrap();
            run(product::call(
                h,
                "local",
                "owl",
                stored,
                "todo_list",
                &json!({"todos":[]}),
            ))
            .unwrap()
            .unwrap();
            assert_eq!(runtime_store::history(h, stored).unwrap().len(), 2);
        }
        run(fixture.app.shutdown());
    }
}

#[test]
fn old_build_committed_section_stays_deleted_and_retries_cleanup() {
    let mut fixture = Fixture::new();
    let path = fixture.home.path().to_owned();
    let h = path.as_path();
    // The earlier build committed the catalog delete, then stopped. A native
    // cleanup fault on the delegated task keeps it for the next startup.
    old_build_mark_deleted(h, &fixture.id);
    db::open(h)
        .unwrap()
        .execute("DELETE FROM sections WHERE id=?", [&fixture.id])
        .unwrap();
    let native = runtime_store::open(h).unwrap();
    native.execute_batch(&format!("CREATE TRIGGER fail_child_cleanup BEFORE DELETE ON native_sessions WHEN OLD.stored_id='{}' BEGIN SELECT RAISE(ABORT,'child cleanup fault'); END", fixture.child)).unwrap();
    fixture.restart();
    assert!(!fixture.completed(&fixture.child));
    for stored in [&fixture.id, &fixture.child] {
        assert_eq!(
            runtime_store::session_dir(h, stored).unwrap_err().code,
            4001
        );
    }
    native
        .execute_batch("DROP TRIGGER fail_child_cleanup")
        .unwrap();
    fixture.restart();
    let state = fixture.snapshot();
    assert_eq!(state["parent_messages"], 0);
    assert_eq!(state["child_messages"], 0);
    assert_eq!(state["parent_pi"], false);
    assert_eq!(state["child_pi"], false);
    assert_eq!(state["tombstones"], 2);
    assert_eq!(state["memory"], "Durable memory");
    assert!(fixture.completed(&fixture.id));
    assert!(fixture.completed(&fixture.child));
    run(fixture.assert_closed());
}
