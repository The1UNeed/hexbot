use super::*;

fn fixture() -> tempfile::TempDir {
    let home = tempfile::tempdir().unwrap();
    db::migrate(home.path()).unwrap();
    db::open(home.path())
        .unwrap()
        .execute_batch(
            "INSERT INTO users(id,display_name,role,created_at) VALUES('alice','Alice','admin',0);
         INSERT INTO bots(name,owner_id) VALUES('owl','alice');
         INSERT INTO sections(id,bot,owner_id,title) VALUES('first','owl','alice','Older chat');",
        )
        .unwrap();
    runtime_store::open(home.path()).unwrap().execute(
        "INSERT INTO native_sessions(stored_id,owner,bot,prompt) VALUES('first','alice','owl','frozen')",
        [],
    ).unwrap();
    let dir = profile(home.path(), "owl").unwrap();
    fs::create_dir_all(&dir).unwrap();
    // Keep the Python-era constraints, including its non-cascading parent link
    // and the usage table's cascading link, without unrelated schema columns.
    Connection::open(dir.join("state.db")).unwrap().execute_batch(
        "CREATE TABLE sessions(id TEXT PRIMARY KEY,session_key TEXT,user_id TEXT,parent_session_id TEXT REFERENCES sessions(id));
         CREATE TABLE messages(id INTEGER PRIMARY KEY,session_id TEXT NOT NULL REFERENCES sessions(id),role TEXT,content TEXT);
         CREATE TABLE session_model_usage(session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,model TEXT);
         INSERT INTO sessions VALUES('a-root','first','alice',NULL),('b-child','first','alice','a-root'),('unrelated','other','alice',NULL);
         INSERT INTO messages SELECT rowid,id,'user',id FROM sessions;
         INSERT INTO session_model_usage VALUES('a-root','fixture'),('b-child','fixture');",
    ).unwrap();
    home
}

fn legacy(home: &Path) -> Connection {
    Connection::open(profile(home, "owl").unwrap().join("state.db")).unwrap()
}

#[test]
fn legacy_purge_removes_compression_parents_and_children_in_one_transaction() {
    let home = fixture();
    let h = home.path();
    assert!(delete_section(h, "alice", "first", true).unwrap().is_none());
    for _ in 0..2 {
        runtime_store::finish_deletes(h).unwrap();
    }
    let conn = legacy(h);
    assert_eq!(
        rows(&conn, "SELECT id FROM sessions", &[]).unwrap(),
        vec![json!({"id":"unrelated"})]
    );
    assert_eq!(
        rows(&conn, "SELECT content FROM messages", &[]).unwrap(),
        vec![json!({"content":"unrelated"})]
    );
    assert!(
        rows(&conn, "SELECT * FROM session_model_usage", &[])
            .unwrap()
            .is_empty()
    );
    assert!(
        rows(&conn, "PRAGMA foreign_key_check", &[])
            .unwrap()
            .is_empty()
    );
    assert!(
        rows(
            &runtime_store::open(h).unwrap(),
            "SELECT * FROM native_delete_options",
            &[]
        )
        .unwrap()
            == vec![json!({"session_id":"first","bot":"owl","owner":"alice","purge":1})]
            && rows(
                &runtime_store::open(h).unwrap(),
                "SELECT * FROM native_delete_completed",
                &[]
            )
            .unwrap()
                == vec![json!({"session_id":"first"})]
    );
    assert!(
        rows(
            &runtime_store::open(h).unwrap(),
            "SELECT * FROM native_deleted WHERE session_id='unrelated'",
            &[]
        )
        .unwrap()
        .is_empty()
    );
}

#[test]
fn legacy_purge_rolls_back_when_a_foreign_continuation_still_needs_its_parent() {
    let home = fixture();
    let h = home.path();
    let conn = legacy(h);
    conn.execute_batch(
        "INSERT INTO sessions VALUES('foreign','foreign-chat','bob','a-root');
         INSERT INTO messages VALUES(4,'foreign','user','foreign transcript');",
    )
    .unwrap();
    let before_sessions = rows(&conn, "SELECT * FROM sessions ORDER BY id", &[]).unwrap();
    let before_messages = rows(&conn, "SELECT * FROM messages ORDER BY id", &[]).unwrap();
    let before_usage = rows(
        &conn,
        "SELECT * FROM session_model_usage ORDER BY session_id",
        &[],
    )
    .unwrap();
    assert!(delete_section(h, "alice", "first", true).unwrap().is_some());
    for _ in 0..2 {
        assert!(runtime_store::finish_deletes(h).is_err());
        assert_eq!(
            rows(&conn, "SELECT * FROM sessions ORDER BY id", &[]).unwrap(),
            before_sessions
        );
        assert_eq!(
            rows(&conn, "SELECT * FROM messages ORDER BY id", &[]).unwrap(),
            before_messages
        );
        assert_eq!(
            rows(
                &conn,
                "SELECT * FROM session_model_usage ORDER BY session_id",
                &[]
            )
            .unwrap(),
            before_usage
        );
        assert!(
            rows(&conn, "PRAGMA foreign_key_check", &[])
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            rows(
                &runtime_store::open(h).unwrap(),
                "SELECT session_id FROM native_delete_options",
                &[]
            )
            .unwrap(),
            vec![json!({"session_id":"first"})]
        );
    }
}

#[test]
fn legacy_delete_selection_stops_at_foreign_parents_and_handles_owned_cycles() {
    let home = fixture();
    let h = home.path();
    let conn = legacy(h);
    conn.execute_batch(
        "INSERT INTO sessions VALUES('foreign','other-chat','bob','a-root');
         INSERT INTO sessions VALUES('grandchild',NULL,'alice','foreign');
         PRAGMA defer_foreign_keys=ON;
         BEGIN;
         INSERT INTO sessions VALUES('cycle-a','first','alice','cycle-b'),('cycle-b',NULL,'alice','cycle-a');
         COMMIT;",
    ).unwrap();
    assert_eq!(
        legacy_delete_ids(h, "owl", "alice", "first").unwrap(),
        ["a-root", "b-child", "cycle-a", "cycle-b", "first"]
    );
    // An alias independently identifies a root, even below a foreign branch.
    conn.execute(
        "UPDATE sessions SET session_key='first' WHERE id='grandchild'",
        [],
    )
    .unwrap();
    assert_eq!(
        legacy_delete_ids(h, "owl", "alice", "first").unwrap(),
        [
            "a-root",
            "b-child",
            "cycle-a",
            "cycle-b",
            "first",
            "grandchild"
        ]
    );
    conn.execute(
        "UPDATE sessions SET user_id='bob' WHERE id='grandchild'",
        [],
    )
    .unwrap();
    assert_eq!(
        legacy_delete_ids(h, "owl", "alice", "first")
            .unwrap_err()
            .code,
        4302
    );
}
