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
            json!({"deleted":true})
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
