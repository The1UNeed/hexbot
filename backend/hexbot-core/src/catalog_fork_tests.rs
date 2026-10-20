//! Crash and I/O recovery through the actual catalog publisher and App startup.
use super::*;
use crate::{runtime_store as store, server::App};
use std::process::Command;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn fixture() -> tempfile::TempDir {
    let home = tempfile::tempdir().unwrap();
    let h = home.path();
    db::migrate(h).unwrap();
    db::open(h).unwrap().execute_batch("INSERT INTO users(id,display_name,role,created_at) VALUES('alice','Alice','admin',0); INSERT INTO bots(name,owner_id) VALUES('owl','alice'); INSERT INTO sections(id,bot,title,owner_id) VALUES('log','owl','Dreams','alice'); INSERT INTO dreams(id,bot,started_at,status,summary) VALUES('dream','owl',1,'complete','REPORT'); INSERT INTO settings VALUES('one_chat_per_bot','true');").unwrap();
    let conn = store::open(h).unwrap();
    conn.execute("INSERT INTO native_sessions VALUES('log','alice','owl','FROZEN PREFIX',?)", [json!({"provider":"test","model":"frozen","tools":["read"],"chain":{"requester":"original"}}).to_string()]).unwrap();
    let assistant = |content: Value| json!({"role":"assistant","content":content,"timestamp":3000,"provider":"test","model":"frozen","api":"openai-completions","stopReason":"stop","usage":{"input":10,"output":2,"cacheRead":3,"cacheWrite":4,"totalTokens":19,"cost":{"total":0.37}}});
    let messages = [
        assistant(json!([{"type":"text","text":"REPORT"}])),
        json!({"role":"user","content":[{"type":"text","text":"Keep human"}],"timestamp":2000}),
        assistant(
            json!([{"type":"text","text":"REPORT"},{"type":"toolCall","id":"call-1","name":"read","arguments":{"path":"notes"}}]),
        ),
        json!({"role":"toolResult","toolCallId":"call-1","toolName":"read","content":[{"type":"text","text":"FILE"}],"timestamp":4000}),
        assistant(json!([{"type":"text","text":"Answer"}])),
    ];
    let mut lines = vec![
        json!({"type":"session","version":3,"id":"log","timestamp":"2026-10-16T00:00:00Z","cwd":h})
            .to_string(),
    ];
    for (i, message) in messages.into_iter().enumerate() {
        lines.push(json!({"type":"message","id":format!("e{i}"),"parentId":if i==0 {Value::Null} else {json!(format!("e{}",i-1))},"message":message}).to_string());
    }
    fs::write(
        store::session_dir(h, "log")
            .unwrap()
            .join("conversation.jsonl"),
        format!("{}\n", lines.join("\n")),
    )
    .unwrap();
    store::reconcile(h, "owl", "log", "alice").unwrap();
    dream_logs(h, "owl").unwrap();
    db::open(h).unwrap().execute_batch("INSERT INTO sections(id,bot,owner_id,peer_bot) VALUES('peer','owl','alice','fox'); INSERT INTO rooms(id,name,owner_id) VALUES('room','Room','alice'); INSERT INTO room_sessions(room_id,bot,stored_session_id) VALUES('room','owl','room-run');").unwrap();
    for (id, parent) in [
        ("peer", None),
        ("room-run", None),
        ("delegate", Some("log")),
    ] {
        conn.execute(
            "INSERT INTO native_sessions VALUES(?,'alice','owl','INDEPENDENT PREFIX',?)",
            params![
                id,
                json!({"parent_session":parent,"model":"independent","tools":["read"]}).to_string()
            ],
        )
        .unwrap();
        let raw = format!(
            "{}\n{}\n",
            json!({"type":"session","version":3,"id":id,"timestamp":"2026-10-16T00:00:00Z","cwd":h}),
            json!({"type":"message","id":format!("msg-{id}"),"parentId":null,"message":{"role":"user","content":[{"type":"text","text":format!("Keep {id}")}],"timestamp":1000}})
        );
        fs::write(
            store::session_dir(h, id)
                .unwrap()
                .join("conversation.jsonl"),
            raw,
        )
        .unwrap();
        store::reconcile(h, "owl", id, "alice").unwrap();
    }
    home
}
fn source(h: &Path) -> Value {
    let conn = store::open(h).unwrap();
    let independent=["peer","room-run","delegate"].map(|id|json!({"id":id,"raw":fs::read(h.join("runtime/sessions").join(id).join("conversation.jsonl")).unwrap(),"rows":store::history(h,id).unwrap(),"version":store::history_version(&conn,id).unwrap(),"usage":store::usage(h,id).unwrap(),"frozen":rows(&conn,"SELECT * FROM native_sessions WHERE stored_id=?",&[&id]).unwrap()}));
    json!({"raw":fs::read(h.join("runtime/sessions/log/conversation.jsonl")).unwrap(),"rows":store::history(h,"log").unwrap(),"version":store::history_version(&conn,"log").unwrap(),"usage":store::usage(h,"log").unwrap(),"frozen":rows(&conn,"SELECT * FROM native_sessions WHERE stored_id='log'",&[]).unwrap(),"independent":independent})
}
fn count(h: &Path, table: &str, column: &str, target: &str) -> i64 {
    store::open(h)
        .unwrap()
        .query_row(
            &format!("SELECT count(*) FROM {table} WHERE {column}=?"),
            [target],
            |r| r.get(0),
        )
        .unwrap()
}
fn gone(h: &Path, target: &str) {
    for (table, column) in [
        ("native_sessions", "stored_id"),
        ("native_messages", "session_id"),
        ("native_pi_journal", "session_id"),
        ("native_usage", "session_id"),
        ("native_fresh", "session_id"),
        ("native_prompt_intents", "session_id"),
        ("native_summaries", "session_id"),
        ("native_history_versions", "session_id"),
        ("native_quarantine", "session_id"),
        ("native_unrecovered", "session_id"),
        ("native_pending_chat_forks", "target"),
    ] {
        assert_eq!(count(h, table, column, target), 0, "{table}: {target}");
    }
    assert!(
        !h.join("runtime/sessions")
            .join(target)
            .try_exists()
            .unwrap()
    );
    assert!(store::append(h, target, json!({"role":"user","text":"late"})).is_err());
}
async fn restart(h: &Path) {
    // Startup itself is synchronous. Do not start unrelated description tasks
    // that could outlive this disposable home on the surrounding test runtime.
    let h = h.to_path_buf();
    let app = std::thread::spawn(move || {
        App::new(
            h.clone(),
            "127.0.0.1:0".parse().unwrap(),
            h.join("unused-pi"),
            None,
        )
        .unwrap()
    })
    .join()
    .unwrap();
    app.shutdown().await;
}
fn child_if_requested(test: &str) -> bool {
    if let Some(home) = std::env::var_os("HEXBOT_TEST_CHAT_FORK_HOME") {
        assert_eq!(std::env::var("HEXBOT_TEST_CHAT_FORK_CASE").unwrap(), test);
        chat_section(Path::new(&home), "alice", "owl").unwrap();
        return true;
    }
    false
}
async fn killed_copy(h: &Path, test: &str, cut: &str) -> String {
    let socket = h.join("fork-barrier.sock");
    let listener = tokio::net::UnixListener::bind(&socket).unwrap();
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            &format!("catalog::fork_tests::{test}"),
            "--nocapture",
        ])
        .env("HEXBOT_TEST_CHAT_FORK_HOME", h)
        .env("HEXBOT_TEST_CHAT_FORK_CASE", test)
        .spawn()
        .unwrap();
    let barrier = loop {
        let (mut stream, _) =
            tokio::time::timeout(std::time::Duration::from_secs(10), listener.accept())
                .await
                .unwrap()
                .unwrap();
        let mut phase = [0; 32];
        let n = stream.read(&mut phase).await.unwrap();
        if &phase[..n] == cut.as_bytes() {
            break stream;
        }
        stream.write_all(&[1]).await.unwrap();
    };
    let target = store::open(h)
        .unwrap()
        .query_row("SELECT target FROM native_pending_chat_forks", [], |r| {
            r.get::<_, String>(0)
        })
        .unwrap();
    assert_eq!(count(h, "native_sessions", "stored_id", &target), 0);
    child.kill().unwrap();
    let status = child.wait().unwrap();
    use std::os::unix::process::ExitStatusExt;
    assert_eq!(status.signal(), Some(9));
    drop(barrier);
    fs::remove_file(socket).unwrap();
    target
}

#[tokio::test]
async fn killed_fork_recovers_each_copy_and_catalog_boundary() {
    let test = "killed_fork_recovers_each_copy_and_catalog_boundary";
    if child_if_requested(test) {
        return;
    }
    for cut in [
        "before_copy",
        "during_copy",
        "after_copy",
        "before_commit",
        "after_commit",
    ] {
        let home = fixture();
        let h = home.path();
        let before = source(h);
        let target = killed_copy(h, test, cut).await;
        let published = cut == "after_commit";
        assert_eq!(section(h, "alice", &target).is_ok(), published);
        if cut == "before_copy" {
            assert_eq!(count(h, "native_fresh", "session_id", &target), 0);
            assert!(store::history(h, &target).unwrap().is_empty());
        } else if cut == "during_copy" {
            assert_eq!(count(h, "native_fresh", "session_id", &target), 1);
            assert_eq!(store::history(h, &target).unwrap().len(), 1);
        }
        if ["after_copy", "before_commit", "after_commit"].contains(&cut) {
            assert!(
                h.join("runtime/sessions")
                    .join(&target)
                    .join("conversation.jsonl")
                    .is_file()
            );
            assert!(count(h, "native_usage", "session_id", &target) > 0);
        }
        let copied = store::history(h, &target).unwrap();
        let raw = fs::read(
            h.join("runtime/sessions")
                .join(&target)
                .join("conversation.jsonl"),
        )
        .ok();
        for _ in 0..2 {
            restart(h).await;
            assert_eq!(source(h), before, "{cut}");
            if published {
                assert_eq!(chat_section(h, "alice", "owl").unwrap()["id"], target);
                assert_eq!(store::history(h, &target).unwrap(), copied);
                assert_eq!(
                    fs::read(
                        h.join("runtime/sessions")
                            .join(&target)
                            .join("conversation.jsonl")
                    )
                    .ok(),
                    raw
                );
                assert_eq!(
                    setting(&db::open(h).unwrap(), "dream_chat_adoptions").unwrap()["log"]["version"],
                    before["version"]
                );
                assert_eq!(store::usage(h, &target).unwrap()["total_tokens"], 0);
                assert_eq!(count(h, "native_pending_chat_forks", "target", &target), 0);
            } else {
                gone(h, &target);
            }
        }
    }
}

#[tokio::test]
async fn cleanup_fault_keeps_identity_until_files_and_usage_are_removed() {
    let test = "cleanup_fault_keeps_identity_until_files_and_usage_are_removed";
    if child_if_requested(test) {
        return;
    }
    for fault in ["native", "files", "usage", "identity"] {
        let home = fixture();
        let h = home.path();
        let before = source(h);
        let target = killed_copy(h, test, "after_copy").await;
        let runtime = h.join("runtime");
        let saved = h.join("runtime-saved");
        if fault == "files" {
            fs::rename(&runtime, &saved).unwrap();
            std::os::unix::fs::symlink(&saved, &runtime).unwrap();
        } else {
            let (table, column) = match fault {
                "native" => ("native_messages", "session_id"),
                "usage" => ("native_usage", "session_id"),
                _ => ("native_pending_chat_forks", "target"),
            };
            store::open(h).unwrap().execute_batch(&format!("CREATE TRIGGER block_cleanup BEFORE DELETE ON {table} WHEN OLD.{column}='{target}' BEGIN SELECT RAISE(ABORT,'real cleanup fault'); END;")).unwrap();
        }
        for _ in 0..2 {
            assert!(store::finish_deletes(h).is_err());
            restart(h).await;
            assert_eq!(
                count(h, "native_pending_chat_forks", "target", &target),
                1,
                "{fault}"
            );
            assert_eq!(source(h), before, "{fault}");
            if fault == "files" {
                assert!(runtime.join("sessions").join(&target).is_dir());
            }
        }
        if fault == "files" {
            fs::remove_file(&runtime).unwrap();
            fs::rename(saved, runtime).unwrap();
        } else {
            store::open(h)
                .unwrap()
                .execute_batch("DROP TRIGGER block_cleanup")
                .unwrap();
        }
        for _ in 0..2 {
            restart(h).await;
            gone(h, &target);
            assert_eq!(source(h), before);
        }
        let next = chat_section(h, "alice", "owl").unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        assert_ne!(next, target);
        assert_eq!(store::usage(h, &next).unwrap()["total_tokens"], 0);
    }
}

#[tokio::test]
async fn committed_publication_survives_identity_cleanup_failure() {
    let test = "committed_publication_survives_identity_cleanup_failure";
    if child_if_requested(test) {
        return;
    }
    let home = fixture();
    let h = home.path();
    let before = source(h);
    let target = killed_copy(h, test, "after_commit").await;
    // A committed target can acquire its own frozen session and bill new work
    // before a failed identity cleanup is retried. These are never copy costs.
    let frozen = json!({"model":"running","tools":["read"]}).to_string();
    store::open(h)
        .unwrap()
        .execute(
            "INSERT INTO native_sessions VALUES(?,'alice','owl','COMMITTED PREFIX',?)",
            params![target, frozen],
        )
        .unwrap();
    let path = h
        .join("runtime/sessions")
        .join(&target)
        .join("conversation.jsonl");
    let mut log = fs::read_to_string(&path).unwrap();
    let parent: Value = serde_json::from_str(log.lines().last().unwrap()).unwrap();
    log.push_str(&format!("{}\n",json!({"type":"message","id":"new-answer","parentId":parent["id"],"message":{"role":"assistant","content":[{"type":"text","text":"New committed work"}],"timestamp":9000,"provider":"test","model":"running","api":"openai-completions","stopReason":"stop","usage":{"input":5,"output":2,"cost":{"total":0.19}}}})));
    fs::write(&path, &log).unwrap();
    store::reconcile(h, "owl", &target, "alice").unwrap();
    let usage = store::usage(h, &target).unwrap();
    assert_eq!(usage["total_tokens"], 7);
    store::open(h).unwrap().execute_batch("CREATE TRIGGER block_cleanup BEFORE DELETE ON native_pending_chat_forks BEGIN SELECT RAISE(ABORT,'identity cleanup failed'); END;").unwrap();
    let copied = store::history(h, &target).unwrap();
    for _ in 0..2 {
        restart(h).await;
        assert_eq!(store::history(h, &target).unwrap(), copied);
        assert_eq!(store::usage(h, &target).unwrap(), usage);
        assert_eq!(fs::read_to_string(&path).unwrap(), log);
        assert_eq!(
            store::open(h)
                .unwrap()
                .query_row(
                    "SELECT prompt,options FROM native_sessions WHERE stored_id=?",
                    [&target],
                    |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
                )
                .unwrap(),
            ("COMMITTED PREFIX".into(), frozen.clone())
        );
        assert_eq!(chat_section(h, "alice", "owl").unwrap()["id"], target);
        assert_eq!(source(h), before);
    }
    store::open(h)
        .unwrap()
        .execute_batch("DROP TRIGGER block_cleanup")
        .unwrap();
    restart(h).await;
    assert_eq!(count(h, "native_pending_chat_forks", "target", &target), 0);
    assert_eq!(store::history(h, &target).unwrap(), copied);
}

#[tokio::test]
async fn unknown_ownership_and_independent_decisions_never_authorize_fork_cleanup() {
    for case in [
        "section",
        "room",
        "native",
        "descendant",
        "retained",
        "completed",
        "billed",
        "journal",
    ] {
        let home = fixture();
        let h = home.path();
        let before = source(h);
        store::prepare_chat_fork(h, "log", "private", "owl", "alice").unwrap();
        store::append(h, "private", json!({"role":"user","text":"KEEP"})).unwrap();
        let conn = store::open(h).unwrap();
        let catalog = db::open(h).unwrap();
        match case {
            "section" => {
                catalog
                    .execute_batch(
                        "INSERT INTO sections(id,bot,owner_id) VALUES('private','owl','alice');",
                    )
                    .unwrap();
            }
            "room" => {
                catalog.execute_batch("INSERT INTO rooms(id,name,owner_id) VALUES('r','Room','alice'); INSERT INTO room_sessions(room_id,bot,stored_session_id) VALUES('r','owl','private');").unwrap();
            }
            "native" => {
                conn.execute_batch("INSERT INTO native_sessions VALUES('private','other','foreign','UNKNOWN','{}');").unwrap();
            }
            "descendant" => {
                conn.execute_batch("INSERT INTO native_sessions VALUES('child','alice','owl','CHILD','{\"parent_session\":\"private\"}');").unwrap();
            }
            "retained" => {
                conn.execute_batch("INSERT INTO native_deleted VALUES('private'); INSERT INTO native_delete_options VALUES('private','owl','alice',0);").unwrap();
            }
            "completed" => {
                conn.execute_batch("INSERT INTO native_deleted VALUES('private'); INSERT INTO native_delete_completed VALUES('private');").unwrap();
            }
            "billed" => {
                conn.execute_batch("INSERT INTO native_usage(session_id,owner_id,bot,model,provider,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cost,timestamp) VALUES('private','alice','owl','m','p',1,0,0,0,0.1,1);").unwrap();
            }
            "journal" => {
                catalog.execute("INSERT INTO settings VALUES('pending_bot_delete:owl',?)",[json!({"bot":"owl","owner":"alice","committed":true,"targets":[{"id":"private","bot":"owl","owner":"alice"}]}).to_string()]).unwrap();
            }
            _ => unreachable!(),
        }
        assert!(finish_chat_forks(h).is_err(), "{case}");
        assert_eq!(
            store::history(h, "private").unwrap()[0]["text"],
            "KEEP",
            "{case}"
        );
        assert_eq!(
            count(h, "native_pending_chat_forks", "target", "private"),
            1,
            "{case}"
        );
        assert_eq!(source(h), before, "{case}");
        for _ in 0..2 {
            restart(h).await;
            assert_eq!(
                store::history(h, "private").unwrap()[0]["text"],
                "KEEP",
                "{case}"
            );
            assert_eq!(
                count(h, "native_pending_chat_forks", "target", "private"),
                1,
                "{case}"
            );
            assert_eq!(source(h), before, "{case}");
        }
    }
}

#[test]
fn returned_builder_and_catalog_errors_share_durable_caller_cleanup() {
    for stage in [
        "prepare",
        "fresh",
        "copy",
        "reconcile",
        "section",
        "adoption",
        "commit",
    ] {
        let home = fixture();
        let h = home.path();
        let before = source(h);
        let listed = rows(
            &db::open(h).unwrap(),
            "SELECT * FROM sections ORDER BY id",
            &[],
        )
        .unwrap();
        let (conn, sql) = match stage {
            "prepare" => (
                store::open(h).unwrap(),
                "CREATE TRIGGER fail_fork BEFORE INSERT ON native_pending_chat_forks BEGIN SELECT RAISE(ABORT,'fork fault'); END;",
            ),
            "fresh" => (
                store::open(h).unwrap(),
                "CREATE TRIGGER fail_fork BEFORE INSERT ON native_fresh WHEN NEW.session_id<>'log' BEGIN SELECT RAISE(ABORT,'fork fault'); END;",
            ),
            "copy" => (
                store::open(h).unwrap(),
                "CREATE TRIGGER fail_fork BEFORE INSERT ON native_messages WHEN NEW.session_id<>'log' AND NEW.seq=3 BEGIN SELECT RAISE(ABORT,'fork fault'); END;",
            ),
            "reconcile" => (
                store::open(h).unwrap(),
                "CREATE TRIGGER fail_fork BEFORE INSERT ON native_pi_journal WHEN NEW.session_id<>'log' BEGIN SELECT RAISE(ABORT,'fork fault'); END;",
            ),
            "section" => (
                db::open(h).unwrap(),
                "CREATE TRIGGER fail_fork BEFORE INSERT ON sections BEGIN SELECT RAISE(ABORT,'fork fault'); END;",
            ),
            "adoption" => (
                db::open(h).unwrap(),
                "CREATE TRIGGER fail_fork BEFORE INSERT ON settings WHEN NEW.key='dream_chat_adoptions' BEGIN SELECT RAISE(ABORT,'fork fault'); END;",
            ),
            _ => (
                db::open(h).unwrap(),
                "CREATE TABLE commit_fault(id TEXT REFERENCES sections(id) DEFERRABLE INITIALLY DEFERRED); CREATE TRIGGER fail_fork AFTER INSERT ON sections BEGIN INSERT INTO commit_fault VALUES('missing'); END;",
            ),
        };
        conn.execute_batch(sql).unwrap();
        assert!(chat_section(h, "alice", "owl").is_err(), "{stage}");
        assert_eq!(source(h), before, "{stage}");
        assert_eq!(
            rows(
                &db::open(h).unwrap(),
                "SELECT * FROM sections ORDER BY id",
                &[]
            )
            .unwrap(),
            listed,
            "{stage}"
        );
        for (table, column) in [
            ("native_messages", "session_id"),
            ("native_pi_journal", "session_id"),
            ("native_usage", "session_id"),
            ("native_fresh", "session_id"),
            ("native_history_versions", "session_id"),
        ] {
            assert_eq!(
                store::open(h)
                    .unwrap()
                    .query_row(
                        &format!("SELECT count(*) FROM {table} WHERE {column} NOT IN ('log','peer','room-run','delegate')"),
                        [],
                        |r| r.get::<_, i64>(0)
                    )
                    .unwrap(),
                0,
                "{stage}: {table}"
            );
        }
        assert!(
            rows(
                &store::open(h).unwrap(),
                "SELECT * FROM native_pending_chat_forks",
                &[]
            )
            .unwrap()
            .is_empty(),
            "{stage}"
        );
        assert_eq!(
            fs::read_dir(h.join("runtime/sessions")).unwrap().count(),
            4,
            "{stage}"
        );
        conn.execute_batch("DROP TRIGGER fail_fork").unwrap();
        let target = chat_section(h, "alice", "owl").unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        assert_ne!(target, "log");
        assert_eq!(chat_section(h, "alice", "owl").unwrap()["id"], target);
        assert_eq!(store::usage(h, &target).unwrap()["total_tokens"], 0);
        assert_eq!(source(h), before);
    }
}

#[tokio::test]
async fn unpublished_cleanup_never_touches_a_reused_bot_name_or_new_chat() {
    let home = fixture();
    let h = home.path();
    store::prepare_chat_fork(h, "log", "private", "owl", "alice").unwrap();
    assert!(
        store::fork_dream_chat(
            h,
            "owl",
            "alice",
            "log",
            "private",
            &["REPORT".to_owned()].into()
        )
        .unwrap()
    );
    let original_usage = store::usage(h, "log").unwrap();
    call(h, "alice", "hexbot.bots.delete", &json!({"name":"owl"}))
        .unwrap()
        .unwrap();
    let new = call(h, "alice", "hexbot.bots.create", &json!({"name":"owl"}))
        .unwrap()
        .unwrap();
    let id = new["section"]["id"].as_str().unwrap();
    let dir = h.join("profiles/owl/memories");
    fs::create_dir_all(dir.join("notes")).unwrap();
    fs::write(dir.join("MEMORY.md"), "NEW GENERATION").unwrap();
    fs::write(dir.join("notes/2026-10-16.md"), "NEW NOTES").unwrap();
    for _ in 0..2 {
        restart(h).await;
        gone(h, "private");
        assert!(section(h, "alice", id).is_ok());
        assert_eq!(
            fs::read_to_string(dir.join("MEMORY.md")).unwrap(),
            "NEW GENERATION"
        );
        assert_eq!(
            fs::read_to_string(dir.join("notes/2026-10-16.md")).unwrap(),
            "NEW NOTES"
        );
        assert_eq!(store::usage(h, "log").unwrap(), original_usage);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn publication_keeps_source_closed_to_writes_until_commit() {
    let home = fixture();
    let h = home.path();
    let before = source(h);
    let runtime = crate::runtime::Runtime::new(
        h.into(),
        crate::events::EventHub::new(),
        h.join("unused-pi"),
    )
    .unwrap();
    let socket = h.join("fork-barrier.sock");
    let listener = tokio::net::UnixListener::bind(&socket).unwrap();
    let path = h.to_path_buf();
    let mut publisher = tokio::task::spawn_blocking(move || chat_section(&path, "alice", "owl"));
    let mut barrier = loop {
        let (mut stream, _) =
            tokio::time::timeout(std::time::Duration::from_secs(10), listener.accept())
                .await
                .unwrap()
                .unwrap();
        let mut phase = [0; 32];
        let n = stream.read(&mut phase).await.unwrap();
        if &phase[..n] == b"after_copy" {
            break stream;
        }
        stream.write_all(&[1]).await.unwrap();
    };
    let append = store::append(
        h,
        "log",
        json!({"role":"user","text":"Must not slip into the source"}),
    );
    let projection = store::project_seeded(
        h,
        "log",
        "alice",
        "owl",
        &json!({"role":"assistant","content":"Must not be billed","usage":{"input":9}}),
        None,
        None,
    );
    let recovery = store::reconcile(h, "owl", "log", "alice");
    let opener = runtime
        .call("alice", "hexbot.sections.open", &json!({"id":"log"}))
        .await
        .unwrap();
    barrier.write_all(&[1]).await.unwrap();
    let target = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            tokio::select! {
                result = listener.accept() => {
                    let (mut stream, _) = result.unwrap();
                    let mut phase=[0;32]; let n=stream.read(&mut phase).await.unwrap(); assert!(n>0);
                    stream.write_all(&[1]).await.unwrap();
                }
                result = &mut publisher => break result.unwrap().unwrap()["id"].as_str().unwrap().to_owned(),
            }
        }
    }).await.unwrap();
    fs::remove_file(socket).unwrap();
    for result in [append, projection, recovery] {
        assert_eq!(result.unwrap_err().code, 4002);
    }
    assert_eq!(opener.unwrap_err().code, 4002);
    assert_eq!(source(h), before);
    assert_ne!(target, "log");
    assert_eq!(chat_section(h, "alice", "owl").unwrap()["id"], target);
    let rejected = runtime
        .call("alice", "hexbot.sections.open", &json!({"id":"log"}))
        .await
        .unwrap()
        .unwrap_err();
    assert_eq!(rejected.code, 4002);
    assert!(rejected.message.contains(&target));
    // An older client's list shows the chat, not the log it replaced.
    let listed = list_sections(h, "alice", &json!({"bot":"owl","include_archived":true}))
        .unwrap()
        .into_iter()
        .map(|s| s["id"].as_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    assert_eq!(listed, vec![target]);
    runtime.shutdown().await;
}
