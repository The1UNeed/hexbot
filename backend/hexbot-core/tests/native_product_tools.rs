use hexbot_core::{catalog, common, db, native_product_tools as product, runtime_store};
use serde_json::{Value, json};
use std::{fs, path::Path};

fn setup() -> tempfile::TempDir {
    let home = tempfile::tempdir().unwrap();
    db::migrate(home.path()).unwrap();
    db::open(home.path()).unwrap().execute_batch("INSERT INTO users(id,display_name,role,created_at) VALUES('other','Other','member',0); INSERT INTO bots(name,owner_id) VALUES('owl','local'),('fox','other'); INSERT INTO sections(id,bot,owner_id,title,created_at,updated_at) VALUES('current','owl','local','Current',1,3),('past','owl','local','Old plan',1,2),('foreign','fox','other','Private',1,2);").unwrap();
    runtime_store::open(home.path()).unwrap().execute_batch("INSERT INTO native_sessions(stored_id,owner,bot,prompt) VALUES('current','local','owl',''),('past','local','owl',''),('foreign','other','fox','');").unwrap();
    fs::create_dir_all(home.path().join("profiles/owl")).unwrap();
    home
}
async fn call(home: &Path, name: &str, args: Value) -> hexbot_core::Result<Value> {
    product::call(home, "local", "owl", "current", name, &args)
        .await
        .unwrap()
}
const SKILL: &str = "---\nname: plan\ndescription: Use when planning a project.\n---\n# Plan\nKeep the steps small.\n";
#[tokio::test]
async fn todo_revisions_merges_and_hierarchy_survive_restarts() {
    let home = setup();
    let initial = call(home.path(), "todo_list", json!({})).await.unwrap();
    assert_eq!(initial["revision"], 0);
    let items = json!([{"id":"later","content":"Later","status":"pending"},{"id":"active","content":"Active","status":"in_progress"},{"id":"bad","content":"Bad parent"}]);
    let first = call(home.path(), "todo_list", json!({"todos":items}))
        .await
        .unwrap();
    assert_eq!(first["todos"][0]["id"], "active");
    assert_eq!(first["revision"], 1);
    assert!(first["todos"][2].get("parent").is_none());
    let same = call(home.path(), "todo_list", json!({"todos":first["todos"]}))
        .await
        .unwrap();
    assert_eq!(same["revision"], 1);
    let update=call(home.path(),"todo_list",json!({"merge":true,"todos":[{"id":"active","status":"completed"},{"id":"child","content":"Child task","parent":"active","status":"pending"}]})).await.unwrap();
    assert_eq!(update["revision"], 2);
    assert_eq!(update["summary"]["completed"], 1);
    let injection = product::todo_context(home.path(), "current")
        .unwrap()
        .unwrap();
    assert!(injection.contains("Child task"));
    assert!(injection.contains("Active"));
    assert_eq!(
        call(home.path(), "todo", json!({})).await.unwrap()["todos"],
        update["todos"]
    );
    let cycles = call(
        home.path(),
        "todo_list",
        json!({"todos":[{"id":"a","parent":"b"},{"id":"b","parent":"a"}]}),
    )
    .await
    .unwrap();
    assert!(
        cycles["todos"]
            .as_array()
            .unwrap()
            .iter()
            .all(|v| v.get("parent").is_none())
    );
}
#[tokio::test]
async fn todo_bounds_and_access_are_enforced() {
    let home = setup();
    let big = "界".repeat(5000);
    let todos = (0..300)
        .map(|i| json!({"id":i.to_string(),"content":big,"status":"pending"}))
        .collect::<Vec<_>>();
    let out = call(home.path(), "todo_list", json!({"todos":todos}))
        .await
        .unwrap();
    assert_eq!(out["todos"].as_array().unwrap().len(), 256);
    assert!(out["todos"][0]["content"].as_str().unwrap().chars().count() <= 4000);
    assert_eq!(
        product::call(
            home.path(),
            "other",
            "owl",
            "current",
            "todo_list",
            &json!({})
        )
        .await
        .unwrap()
        .unwrap_err()
        .code,
        4302
    );
    assert_eq!(
        product::call(
            home.path(),
            "local",
            "owl",
            "foreign",
            "todo_list",
            &json!({})
        )
        .await
        .unwrap()
        .unwrap_err()
        .code,
        4302
    );
    common::write_config(
        &home.path().join("profiles/owl"),
        &json!({"tools":{"enabled_toolsets":[]}}),
    )
    .unwrap();
    assert_eq!(
        product::descriptors(home.path(), "owl")
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["skills_list", "skill_view"]
    );
    assert_eq!(
        call(home.path(), "todo_list", json!({}))
            .await
            .unwrap_err()
            .code,
        4302
    );
}
#[tokio::test]
async fn session_search_supports_browse_boolean_discovery_read_and_scroll() {
    let _serial = SEARCH.lock().await;
    let home = setup();
    for (role, text) in [
        ("user", "alpha deployment"),
        ("assistant", "beta plan"),
        ("tool", "private trace"),
    ] {
        runtime_store::append(home.path(), "past", json!({"role":role,"text":text})).unwrap();
    }
    runtime_store::append(
        home.path(),
        "past",
        json!({"role":"user","text":"Discarded branch secret"}),
    )
    .unwrap();
    runtime_store::open(home.path()).unwrap().execute("INSERT INTO native_pi_journal(journal_id,session_id,raw_json,projection_seq,active) VALUES('inactive','past','{}',4,0)",[]).unwrap();
    let inactive = call(home.path(), "session_search", json!({"query":"Discarded"}))
        .await
        .unwrap();
    assert_eq!(inactive["count"], 0);
    runtime_store::append(
        home.path(),
        "foreign",
        json!({"role":"user","text":"alpha secret"}),
    )
    .unwrap();
    runtime_store::append(
        home.path(),
        "current",
        json!({"role":"user","text":"alpha current"}),
    )
    .unwrap();
    let browse = call(home.path(), "session_search", json!({}))
        .await
        .unwrap();
    assert_eq!(browse["mode"], "browse");
    assert_eq!(browse["count"], 1);
    assert_eq!(browse["results"][0]["session_id"], "past");
    let found = call(
        home.path(),
        "session_search",
        json!({"query":"alpha OR beta"}),
    )
    .await
    .unwrap();
    assert_eq!(found["count"], 1);
    assert_eq!(found["results"][0]["link"], "@session:owl/past");
    assert!(!found.to_string().contains("alpha secret"));
    let read = call(home.path(), "session_search", json!({"session_id":"past"}))
        .await
        .unwrap();
    assert_eq!(read["message_count"], 3);
    let scroll = call(
        home.path(),
        "session_search",
        json!({"session_id":"past","around_message_id":2,"window":1}),
    )
    .await
    .unwrap();
    assert_eq!(scroll["messages"].as_array().unwrap().len(), 3);
    assert_eq!(scroll["messages"][1]["anchor"], true);
    assert_eq!(
        call(
            home.path(),
            "session_search",
            json!({"query":"alpha","profile":"fox"})
        )
        .await
        .unwrap_err()
        .code,
        4302
    );
    assert!(
        call(
            home.path(),
            "session_search",
            json!({"query":"\"unterminated"})
        )
        .await
        .is_err()
    );
    assert_eq!(
        call(home.path(), "session_search", json!({"query":"trace"}))
            .await
            .unwrap()["count"],
        0
    );
    assert_eq!(
        call(
            home.path(),
            "session_search",
            json!({"query":"trace","role_filter":"tool"})
        )
        .await
        .unwrap()["count"],
        1
    );
}
#[tokio::test]
async fn old_hermes_history_is_read_without_mutating_its_database() {
    let _serial = SEARCH.lock().await;
    let home = setup();
    let path = home.path().join("profiles/owl/state.db");
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch("CREATE TABLE sessions(id TEXT PRIMARY KEY,session_key TEXT);CREATE TABLE messages(id INTEGER,session_id TEXT,role TEXT,content TEXT,timestamp REAL);INSERT INTO sessions VALUES('old-id','past');INSERT INTO messages VALUES(7,'old-id','user','legacy recall',5);").unwrap();
    drop(conn);
    let before = fs::read(&path).unwrap();
    let found = call(home.path(), "session_search", json!({"query":"legacy"}))
        .await
        .unwrap();
    assert_eq!(found["results"][0]["match_message_id"], 7);
    assert_eq!(fs::read(path).unwrap(), before);
}
async fn search(home: &Path, owner: &str, bot: &str, session: &str, args: &Value) -> Value {
    product::call(home, owner, bot, session, "session_search", args)
        .await
        .unwrap()
        .unwrap()
}
/// The answer the kept index gives, how many sections it had to read again for
/// it, and a fresh index that never inserts the asking section.
async fn cached_then_without_asking(
    home: &Path,
    owner: &str,
    bot: &str,
    session: &str,
    args: &Value,
) -> (Value, u64, Value) {
    let before = product::sections_read();
    let cached = search(home, owner, bot, session, args).await;
    let read = product::sections_read() - before;
    product::forget_history_indexes();
    (cached, read, search(home, owner, bot, session, args).await)
}
#[tokio::test]
async fn session_search_reuses_its_index_and_follows_every_history_change() {
    let _serial = SEARCH.lock().await;
    let home = setup();
    let h = home.path();
    seed_history(h, 500);
    // Keep the cache-removal probe on a deletable peer thread.
    db::open(h).unwrap().execute_batch("INSERT INTO bots(name,owner_id) VALUES('teammate','local'); UPDATE sections SET peer_bot='teammate' WHERE id='s7';").unwrap();
    let section = |method: &str, args: Value| {
        catalog::call(h, "local", method, &args).unwrap().unwrap();
    };
    let query = json!({"query":"harbor OR ledger","limit":10,"detail":"full"});
    let before = product::sections_read();
    let first = search(h, "local", "owl", "current", &query).await;
    assert_eq!(first["count"], 10);
    // Fifty seeded sections and "past"; the asking section is never read.
    assert_eq!(product::sections_read() - before, 51);
    assert!(!first.to_string().contains("\"current\""));
    assert_eq!(search(h, "local", "owl", "current", &query).await, first);
    assert_eq!(product::sections_read() - before, 51);
    for sort in ["newest", "oldest"] {
        let sorted = json!({"query":"harbor OR ledger","limit":10,"sort":sort});
        let (cached, read, fresh) =
            cached_then_without_asking(h, "local", "owl", "current", &sorted).await;
        assert_eq!(read, 0);
        assert_eq!(cached, fresh);
    }

    // A new message: only its section is read again.
    runtime_store::append(h, "s3", json!({"role":"user","text":"fresh harbor update"})).unwrap();
    let (cached, read, fresh) =
        cached_then_without_asking(h, "local", "owl", "current", &query).await;
    assert_eq!(read, 1);
    assert_eq!(cached, fresh);
    let only_new = json!({"query":"fresh"});
    let (cached, read, fresh) =
        cached_then_without_asking(h, "local", "owl", "current", &only_new).await;
    assert_eq!(read, 0);
    assert_eq!(cached["count"], 1);
    assert_eq!(cached["results"][0]["session_id"], "s3");
    assert_eq!(cached, fresh);

    // A deleted section is gone at the next search, without reading anything,
    // and its version row goes with its history.
    let only_s7 = json!({"query":"57"});
    assert_eq!(
        search(h, "local", "owl", "current", &only_s7).await["count"],
        1
    );
    assert!(runtime_store::history_version(&runtime_store::open(h).unwrap(), "s7").unwrap() > 0);
    section("hexbot.sections.delete", json!({"id":"s7"}));
    assert_eq!(
        runtime_store::history_version(&runtime_store::open(h).unwrap(), "s7").unwrap(),
        0
    );
    let (cached, read, fresh) =
        cached_then_without_asking(h, "local", "owl", "current", &only_s7).await;
    assert_eq!(read, 0);
    assert_eq!(cached["count"], 0);
    assert_eq!(cached, fresh);
    let (cached, _, fresh) = cached_then_without_asking(h, "local", "owl", "current", &query).await;
    assert_eq!(cached, fresh);
    assert!(!cached.to_string().contains("\"s7\""));

    // Archiving and unarchiving reorder the sections; renaming changes an indexed title.
    for method in ["hexbot.sections.archive", "hexbot.sections.unarchive"] {
        section(method, json!({"id":"s5"}));
        let (cached, read, fresh) =
            cached_then_without_asking(h, "local", "owl", "current", &query).await;
        assert_eq!(read, 1);
        assert_eq!(cached, fresh);
    }
    section(
        "hexbot.sections.rename",
        json!({"id":"s11","title":"Lighthouse"}),
    );
    let title = json!({"query":"lighthouse"});
    let (cached, read, fresh) =
        cached_then_without_asking(h, "local", "owl", "current", &title).await;
    assert_eq!(read, 1);
    assert_eq!(cached["results"][0]["matched_role"], "session_title");
    assert_eq!(cached, fresh);

    // A branch change hides a message and can bring it back.
    let only_s9 = json!({"query":"59"});
    assert_eq!(
        search(h, "local", "owl", "current", &only_s9).await["count"],
        1
    );
    let runtime = runtime_store::open(h).unwrap();
    runtime.execute("INSERT INTO native_pi_journal(journal_id,session_id,raw_json,projection_seq,active) VALUES('branch','s9','{}',2,0)",[]).unwrap();
    let (cached, read, fresh) =
        cached_then_without_asking(h, "local", "owl", "current", &only_s9).await;
    assert_eq!(read, 1);
    assert_eq!(cached["count"], 0);
    assert_eq!(cached, fresh);
    runtime
        .execute(
            "UPDATE native_pi_journal SET active=1 WHERE journal_id='branch'",
            [],
        )
        .unwrap();
    let (cached, read, fresh) =
        cached_then_without_asking(h, "local", "owl", "current", &only_s9).await;
    assert_eq!(read, 1);
    assert_eq!(cached["count"], 1);
    assert_eq!(cached, fresh);

    // Another section shares the index and loads the former asking section; its
    // answer leaves itself out and is what a rebuild without it would give.
    runtime_store::append(
        h,
        "current",
        json!({"role":"user","text":"harbor from the current section"}),
    )
    .unwrap();
    let (cached, read, fresh) = cached_then_without_asking(h, "local", "owl", "s3", &query).await;
    assert_eq!(read, 1);
    assert_eq!(cached, fresh);
    assert!(!cached.to_string().contains("\"session_id\":\"s3\""));
    assert_eq!(search(h, "local", "owl", "s3", &only_new).await["count"], 0);
    let only_current = json!({"query":"\"from the current section\""});
    let (cached, read, fresh) =
        cached_then_without_asking(h, "local", "owl", "s3", &only_current).await;
    assert_eq!(read, 0);
    assert_eq!(cached["count"], 1);
    assert_eq!(cached["results"][0]["session_id"], "current");
    assert_eq!(cached, fresh);
    let (cached, read, fresh) =
        cached_then_without_asking(h, "local", "owl", "current", &query).await;
    assert_eq!(read, 1); // The preceding fresh index never inserted s3.
    assert_eq!(cached, fresh);
    assert!(!cached.to_string().contains("\"session_id\":\"current\""));
    let (cached, read, fresh) =
        cached_then_without_asking(h, "local", "owl", "current", &only_current).await;
    assert_eq!(read, 0);
    assert_eq!(cached["count"], 0);
    assert_eq!(cached, fresh);
    // Browse and read modes leave the asking section out too.
    for (asking, other) in [("current", "s3"), ("s3", "current")] {
        let browse = search(h, "local", "owl", asking, &json!({"limit":10})).await;
        assert!(
            !browse
                .to_string()
                .contains(&format!("\"session_id\":\"{asking}\""))
        );
        assert_eq!(
            product::call(
                h,
                "local",
                "owl",
                asking,
                "session_search",
                &json!({"session_id":asking})
            )
            .await
            .unwrap()
            .unwrap_err()
            .code,
            4205
        );
        assert_eq!(
            search(h, "local", "owl", asking, &json!({"session_id":other})).await["session_id"],
            other
        );
    }
    db::open(h).unwrap().execute("INSERT INTO sections(id,bot,owner_id,title,created_at,updated_at) VALUES('den','fox','other','Den',1,2)",[]).unwrap();
    runtime_store::append(h, "den", json!({"role":"user","text":"harbor of the fox"})).unwrap();
    let (cached, read, fresh) =
        cached_then_without_asking(h, "other", "fox", "foreign", &query).await;
    // The other owner's index reads only the fox's non-asking section.
    assert_eq!(read, 1);
    assert_eq!(cached["count"], 1);
    assert_eq!(cached["results"][0]["session_id"], "den");
    assert_eq!(cached, fresh);
    let owl = search(h, "local", "owl", "current", &query).await;
    assert!(!owl.to_string().contains("harbor of the fox"));
}
#[tokio::test]
async fn session_search_defers_asking_history_and_restores_it_after_invalid_match() {
    let _serial = SEARCH.lock().await;
    let home = setup();
    let h = home.path();
    runtime_store::append(h, "current", json!({"role":"user","text":"alpha alpha"})).unwrap();
    runtime_store::append(h, "past", json!({"role":"user","text":"beta"})).unwrap();
    let query = json!({"query":"alpha OR beta"});
    // Warm the shared index with current present, then search from current.
    assert_eq!(search(h, "local", "owl", "past", &query).await["count"], 1);
    let before = product::sections_read();
    runtime_store::append(h, "current", json!({"role":"user","text":"gamma"})).unwrap();
    assert_eq!(
        search(h, "local", "owl", "current", &query).await["count"],
        1
    );
    assert_eq!(product::sections_read() - before, 1); // Only past was missing.
    let before = product::sections_read();
    let error = call(h, "session_search", json!({"query":"\"unterminated"}))
        .await
        .unwrap_err();
    assert_eq!(error.code, 4200);
    assert_eq!(product::sections_read(), before);
    assert_eq!(
        search(h, "local", "owl", "past", &json!({"query":"gamma"})).await["count"],
        1
    );
    assert_eq!(product::sections_read() - before, 1); // Current refreshes for another caller.
    let before = product::sections_read();
    assert_eq!(
        call(h, "session_search", json!({"query":"\"unterminated"}))
            .await
            .unwrap_err()
            .code,
        4200
    );
    assert_eq!(
        search(h, "local", "owl", "past", &json!({"query":"alpha"})).await["count"],
        1
    );
    assert_eq!(product::sections_read(), before); // Rollback restored current's rows.
}

/// Live message_end projection precedes Pi's append, and there is no recovery
/// pass between these searches. Exercise read, browse, scroll and FTS through
/// the public tool, including a shared index warmed by another conversation.
#[tokio::test]
async fn session_search_live_compaction_excludes_verbatim_context_without_reopen() {
    let _serial = SEARCH.lock().await;
    for already_bound in [false, true] {
        let home = setup();
        let h = home.path();
        let path = runtime_store::session_dir(h, "current")
            .unwrap()
            .join("conversation.jsonl");
        let user =
            |text| json!({"role":"user","content":[{"type":"text","text":text}],"timestamp":1000});
        let messages = [
            user("summarized archive"),
            user("still verbatim"),
            user("still verbatim"),
        ];
        let mut entries = vec![json!({"type":"session","version":3,"id":"current"})];
        for (i, message) in messages.iter().enumerate() {
            runtime_store::project_seeded(h, "current", "local", "owl", message, None, None)
                .unwrap();
            entries.push(json!({"type":"message","id":format!("m{i}"),"parentId":if i==0 {Value::Null} else {json!(format!("m{}", i-1))},"message":message}));
        }
        let write = |entries: &[Value]| {
            fs::write(
                &path,
                entries.iter().map(|v| format!("{v}\n")).collect::<String>(),
            )
            .unwrap()
        };
        write(&entries);
        if already_bound {
            runtime_store::reconcile(h, "owl", "current", "local").unwrap();
        }
        let original = runtime_store::history(h, "current").unwrap();
        assert_eq!(
            search(h, "local", "owl", "current", &json!({"query":"verbatim"})).await["count"],
            0
        );
        // The other caller has already indexed the full asking conversation.
        assert_eq!(
            search(h, "local", "owl", "past", &json!({"query":"verbatim"})).await["count"],
            1
        );
        entries.push(json!({"type":"compaction","id":"c","parentId":"m2","firstKeptEntryId":"m1","summary":"An archive summary"}));
        write(&entries);
        let read = search(
            h,
            "local",
            "owl",
            "current",
            &json!({"session_id":"current"}),
        )
        .await;
        assert_eq!(read["messages"].as_array().unwrap().len(), 1, "{read}");
        assert_eq!(read["messages"][0]["content"], "summarized archive");
        let scroll = search(
            h,
            "local",
            "owl",
            "current",
            &json!({"session_id":"current","around_message_id":1}),
        )
        .await;
        assert_eq!(scroll["messages"].as_array().unwrap().len(), 1);
        let browse = search(h, "local", "owl", "current", &json!({})).await;
        assert_eq!(browse["results"][0]["message_count"], 1);
        assert_eq!(
            search(h, "local", "owl", "current", &json!({"query":"archive"})).await["count"],
            1
        );
        assert_eq!(
            search(h, "local", "owl", "current", &json!({"query":"verbatim"})).await["count"],
            0
        );
        // Projection of the next event is visible before its durable append.
        let next = user("new context pending append");
        runtime_store::project_seeded(h, "current", "local", "owl", &next, None, None).unwrap();
        assert_eq!(
            search(h, "local", "owl", "current", &json!({"query":"pending"})).await["count"],
            0
        );
        entries.push(json!({"type":"message","id":"next","parentId":"c","message":next}));
        write(&entries);
        assert_eq!(
            search(
                h,
                "local",
                "owl",
                "current",
                &json!({"session_id":"current"})
            )
            .await["message_count"],
            1
        );
        assert_eq!(
            &runtime_store::history(h, "current").unwrap()[..3],
            original
        );
        // A branch abandons a formerly summarized message; cached search must
        // follow Pi's active path before any reopen/reconcile can update it.
        let branch = user("branch context");
        runtime_store::project_seeded(h, "current", "local", "owl", &branch, None, None).unwrap();
        entries.push(json!({"type":"message","id":"branch","parentId":"m0","message":branch}));
        entries.push(json!({"type":"compaction","id":"c2","parentId":"branch","firstKeptEntryId":"branch","summary":"Branch summary"}));
        write(&entries);
        assert_eq!(
            search(
                h,
                "local",
                "owl",
                "current",
                &json!({"session_id":"current"})
            )
            .await["message_count"],
            1
        );
        assert_eq!(
            search(h, "local", "owl", "past", &json!({"query":"verbatim"})).await["count"],
            0
        );
        let before = fs::read(&path).unwrap();
        let version =
            runtime_store::history_version(&runtime_store::open(h).unwrap(), "current").unwrap();
        // Unknown firstKept is uncertainty, never permission to return all rows.
        entries.last_mut().unwrap()["firstKeptEntryId"] = json!("unknown");
        write(&entries);
        let error = call(h, "session_search", json!({"session_id":"current"}))
            .await
            .unwrap_err();
        assert_eq!(error.code, 5200);
        assert_eq!(
            runtime_store::history_version(&runtime_store::open(h).unwrap(), "current").unwrap(),
            version
        );
        fs::write(&path, &before).unwrap();
        assert_eq!(
            search(h, "local", "owl", "current", &json!({"query":"archive"})).await["count"],
            1
        );
        for suffix in ["{\"type\":", "invalid\n"] {
            let mut bytes = before.clone();
            bytes.extend_from_slice(suffix.as_bytes());
            fs::write(&path, &bytes).unwrap();
            assert_eq!(
                call(h, "session_search", json!({"query":"archive"}))
                    .await
                    .unwrap_err()
                    .code,
                5200
            );
            assert_eq!(
                fs::read(&path).unwrap(),
                bytes,
                "live search rewrote Pi's file"
            );
        }
        fs::write(&path, &before).unwrap();
        assert_eq!(
            search(h, "local", "owl", "current", &json!({"query":"archive"})).await["count"],
            1
        );
    }
}

/// An older store's history that only a read can find, beside newer native
/// history, and a way to stop that read without touching its time or length:
/// mode 000 for an unprivileged process, or a damaged header written back
/// with the original time, which no process can read.
struct LegacyFault {
    path: std::path::PathBuf,
    healthy: Vec<u8>,
    stamp: (std::time::SystemTime, u64),
}
impl LegacyFault {
    fn new(h: &Path) -> Self {
        let path = h.join("profiles/owl/state.db");
        rusqlite::Connection::open(&path).unwrap().execute_batch("CREATE TABLE sessions(id TEXT PRIMARY KEY,session_key TEXT);CREATE TABLE messages(id INTEGER,session_id TEXT,role TEXT,content TEXT,timestamp REAL);INSERT INTO sessions VALUES('old-id','past');INSERT INTO messages VALUES(7,'old-id','user','legacy lantern',5);").unwrap();
        db::open(h).unwrap().execute("INSERT INTO sections(id,bot,owner_id,title,created_at,updated_at) VALUES('newer','owl','local','Newer',1,4)", []).unwrap();
        runtime_store::append(h, "newer", json!({"role":"user","text":"native lantern"})).unwrap();
        let stamp = Self::stamp_of(&path);
        Self {
            healthy: fs::read(&path).unwrap(),
            path,
            stamp,
        }
    }
    fn stamp_of(path: &Path) -> (std::time::SystemTime, u64) {
        let meta = fs::metadata(path).unwrap();
        (meta.modified().unwrap(), meta.len())
    }
    /// False when this process reads the file anyway: root ignores mode 000.
    fn break_it(&self, fault: &str) -> bool {
        if fault == "header" {
            let mut bytes = self.healthy.clone();
            bytes[..16].copy_from_slice(b"not a database\0\0");
            self.write(&bytes);
        } else {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&self.path, fs::Permissions::from_mode(0o000)).unwrap();
            }
            if fs::File::open(&self.path).is_ok() {
                self.repair(fault);
                return false;
            }
        }
        assert_eq!(Self::stamp_of(&self.path), self.stamp);
        true
    }
    fn repair(&self, fault: &str) {
        if fault == "header" {
            self.write(&self.healthy);
        } else {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&self.path, fs::Permissions::from_mode(0o644)).unwrap();
            }
        }
        assert_eq!(Self::stamp_of(&self.path), self.stamp);
        assert_eq!(fs::read(&self.path).unwrap(), self.healthy);
    }
    fn write(&self, bytes: &[u8]) {
        fs::write(&self.path, bytes).unwrap();
        fs::File::options()
            .write(true)
            .open(&self.path)
            .unwrap()
            .set_modified(self.stamp.0)
            .unwrap();
    }
}
/// Which sections a search found, and how many it had to read again.
async fn lantern(h: &Path) -> (Vec<String>, u64) {
    let before = product::sections_read();
    let found = search(h, "local", "owl", "current", &json!({"query":"lantern"})).await;
    let mut ids = found["results"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["session_id"].as_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    ids.sort();
    (ids, product::sections_read() - before)
}
// The header fault runs everywhere; mode 000 also runs wherever it denies the read.
const LEGACY_FAULTS: [&str; 2] = ["header", "permissions"];
#[tokio::test]
async fn session_search_reads_a_repaired_legacy_store_with_unchanged_metadata() {
    let _serial = SEARCH.lock().await;
    for fault in LEGACY_FAULTS {
        let home = setup();
        let h = home.path();
        let legacy = LegacyFault::new(h);
        product::forget_history_indexes();
        if !legacy.break_it(fault) {
            eprintln!("{fault}: this process reads mode 000 files; the header fault covers it");
            continue;
        }
        // The unreadable store is searched around, and the index is kept.
        assert_eq!(lantern(h).await, (vec!["newer".to_owned()], 2), "{fault}");
        assert_eq!(lantern(h).await, (vec!["newer".to_owned()], 0), "{fault}");
        legacy.repair(fault);
        // The next search reads the repaired store, without a restart or cache reset.
        assert_eq!(
            lantern(h).await,
            (vec!["newer".to_owned(), "past".to_owned()], 2),
            "{fault}"
        );
        assert_eq!(
            lantern(h).await,
            (vec!["newer".to_owned(), "past".to_owned()], 0),
            "{fault}"
        );
    }
}
#[tokio::test]
async fn session_search_stops_answering_from_a_legacy_store_it_can_no_longer_read() {
    let _serial = SEARCH.lock().await;
    for fault in LEGACY_FAULTS {
        let home = setup();
        let h = home.path();
        let legacy = LegacyFault::new(h);
        product::forget_history_indexes();
        let both = vec!["newer".to_owned(), "past".to_owned()];
        assert_eq!(lantern(h).await, (both.clone(), 2), "{fault}");
        assert_eq!(lantern(h).await, (both.clone(), 0), "{fault}");
        if !legacy.break_it(fault) {
            eprintln!("{fault}: this process reads mode 000 files; the header fault covers it");
            continue;
        }
        // Rows read while the store was healthy are not served from the kept index.
        assert_eq!(lantern(h).await, (vec!["newer".to_owned()], 2), "{fault}");
        assert_eq!(lantern(h).await, (vec!["newer".to_owned()], 0), "{fault}");
        legacy.repair(fault);
        assert_eq!(lantern(h).await, (both, 2), "{fault}");
    }
}

/// Search tests share one process-wide index and read counter.
static SEARCH: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
/// Seeds `count` messages over fifty sections of the bot, in one transaction.
fn seed_history(home: &Path, count: usize) {
    let words = [
        "deploy", "budget", "garden", "launch", "invoice", "sprint", "harbor", "recipe", "ledger",
        "orbit", "quartz", "violin", "meadow", "cipher", "lantern", "summit", "tundra",
    ];
    let mut db = db::open(home).unwrap();
    let tx = db.transaction().unwrap();
    for s in 0..50 {
        tx.execute(
            "INSERT INTO sections(id,bot,owner_id,title,created_at,updated_at) VALUES(?,'owl','local',?,?,?)",
            rusqlite::params![format!("s{s}"), format!("Section {s}"), 10 + s, 100 + s],
        )
        .unwrap();
    }
    tx.commit().unwrap();
    let mut runtime = runtime_store::open(home).unwrap();
    let tx = runtime.transaction().unwrap();
    for i in 0..count {
        let text = format!(
            "note {i} about the {} {} and the {} {}",
            words[i % 17],
            words[(i * 7) % 17],
            words[(i * 11) % 17],
            words[(i * 13) % 17]
        );
        tx.execute(
            "INSERT INTO native_messages(session_id,seq,message_json) VALUES(?,?,?)",
            rusqlite::params![
                format!("s{}", i % 50),
                (i / 50) as i64 + 1,
                json!({"role": if i % 2 == 0 { "user" } else { "assistant" }, "text": text, "timestamp": i})
                    .to_string()
            ],
        )
        .unwrap();
    }
    tx.commit().unwrap();
}
/// One-off measurement, not a CI check. Run with
/// `cargo test --release --locked --manifest-path backend/hexbot-core/Cargo.toml --test native_product_tools search_index_timing -- --ignored --nocapture`.
#[tokio::test]
#[ignore]
async fn search_index_timing() {
    let _serial = SEARCH.lock().await;
    for count in [5_000usize, 50_000] {
        let home = setup();
        seed_history(home.path(), count);
        let path = home.path();
        let time = |query: &'static str| async move {
            let started = std::time::Instant::now();
            let found = call(path, "session_search", json!({"query":query}))
                .await
                .unwrap();
            assert!(found["count"].as_u64().unwrap() > 0);
            started.elapsed()
        };
        let first = time("harbor OR ledger").await;
        let second = time("harbor OR ledger").await;
        let third = time("quartz violin").await;
        runtime_store::append(
            home.path(),
            "s7",
            json!({"role":"user","text":"one more harbor note"}),
        )
        .unwrap();
        let after_append = time("harbor OR ledger").await;
        // Populate the asking section and warm it from another caller, so this
        // also measures temporary deletion of a previously indexed rowid range.
        runtime_store::open(path).unwrap().execute(
            "INSERT INTO native_messages(session_id,seq,message_json) SELECT 'current',seq,message_json FROM native_messages WHERE session_id='s0'",
            [],
        ).unwrap();
        search(
            path,
            "local",
            "owl",
            "past",
            &json!({"query":"harbor OR ledger"}),
        )
        .await;
        let excluding = time("harbor OR ledger").await;
        let asking_messages = count / 50;
        println!(
            "{count} messages: first query {first:.3?}, repeat {second:.3?}, other query {third:.3?}, after one new message {after_append:.3?}, excluding {asking_messages} indexed asking messages {excluding:.3?}"
        );
    }
}
#[tokio::test]
async fn skills_create_view_patch_supporting_files_and_delete() {
    let home = setup();
    let create=call(home.path(),"skill_manage",json!({"operations":[{"name":"plan","action":"create","content":SKILL},{"name":"plan","action":"write_file","file_path":"references/guide.md","file_content":"Reference notes"}]})).await.unwrap();
    assert_eq!(create["success"], true);
    assert_eq!(create["operations_applied"], 2);
    let listed = call(home.path(), "skills_list", json!({})).await.unwrap();
    assert!(
        listed["skills"]
            .as_array()
            .unwrap()
            .iter()
            .any(|s| s["name"] == "plan")
    );
    let view = call(home.path(), "skill_view", json!({"name":"plan"}))
        .await
        .unwrap();
    assert_eq!(view["content"], SKILL);
    assert_eq!(
        view["linked_files"]["references"],
        json!(["references/guide.md"])
    );
    assert_eq!(
        call(
            home.path(),
            "skill_view",
            json!({"name":"plan","file_path":"references/guide.md"})
        )
        .await
        .unwrap()["content"],
        "Reference notes"
    );
    let patched=call(home.path(),"skill_manage",json!({"operations":[{"name":"plan","action":"patch","old_string":"small","new_string":"focused"}]})).await.unwrap();
    assert_eq!(patched["success"], true);
    assert!(
        call(home.path(), "skill_view", json!({"name":"plan"}))
            .await
            .unwrap()["content"]
            .as_str()
            .unwrap()
            .contains("focused")
    );
    call(
        home.path(),
        "skill_manage",
        json!({"operations":[{"name":"plan","action":"delete"}]}),
    )
    .await
    .unwrap();
    assert!(
        !call(home.path(), "skills_list", json!({})).await.unwrap()["skills"]
            .as_array()
            .unwrap()
            .iter()
            .any(|s| s["name"] == "plan")
    );
}
#[tokio::test]
async fn skill_batches_rollback_and_inherited_edits_are_private() {
    let home = setup();
    let shared = home.path().join("skills/plan");
    fs::create_dir_all(&shared).unwrap();
    fs::write(shared.join("SKILL.md"), SKILL).unwrap();
    let failed=call(home.path(),"skill_manage",json!({"operations":[{"name":"plan","action":"patch","old_string":"small","new_string":"private"},{"name":"plan","action":"patch","old_string":"does not exist","new_string":"bad"}]})).await.unwrap();
    assert_eq!(failed["success"], false);
    assert_eq!(failed["failed_index"], 1);
    assert_eq!(fs::read_to_string(shared.join("SKILL.md")).unwrap(), SKILL);
    assert!(!home.path().join("profiles/owl/skills/plan").exists());
    call(home.path(),"skill_manage",json!({"operations":[{"name":"plan","action":"patch","old_string":"small","new_string":"private"}]})).await.unwrap();
    assert_eq!(fs::read_to_string(shared.join("SKILL.md")).unwrap(), SKILL);
    assert!(
        fs::read_to_string(home.path().join("profiles/owl/skills/plan/SKILL.md"))
            .unwrap()
            .contains("private")
    );
    let escaped=call(home.path(),"skill_manage",json!({"operations":[{"name":"plan","action":"write_file","file_path":"../escape","file_content":"secret"}]})).await.unwrap();
    assert_eq!(escaped["success"], false);
    assert!(
        call(
            home.path(),
            "skill_view",
            json!({"name":"plan","file_path":"../../../../.env"})
        )
        .await
        .is_err()
    );
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(
            home.path(),
            home.path().join("profiles/owl/skills/plan/escape"),
        )
        .unwrap();
        assert!(
            call(
                home.path(),
                "skill_view",
                json!({"name":"plan","file_path":"escape/hexbot.db"})
            )
            .await
            .is_err()
        );
    }
}
