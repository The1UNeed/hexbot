use super::*;

#[test]
fn history_cursor_is_scoped_to_its_conversation_and_rejects_bad_positions() {
    let home = common::TestHome::new();
    let h = home.path();
    for stored in ["old", "replacement"] {
        append(h, stored, json!({"role":"user","text":stored})).unwrap();
    }
    let (_, cursor, _) = history_since(h, "old", None).unwrap();
    let (rows, _, delta) = history_since(h, "replacement", Some(&cursor)).unwrap();
    assert!(!delta);
    assert_eq!(rows[0]["text"], "replacement");
    let prefix = cursor.rsplit_once(':').unwrap().0;
    for bad in [
        format!("{prefix}:-1"),
        format!("{prefix}:2"),
        format!("{prefix}:9223372036854775808"),
        format!("{cursor}:extra"),
        String::new(),
    ] {
        let (rows, _, delta) = history_since(h, "old", Some(&bad)).unwrap();
        assert!(!delta, "{bad}");
        assert_eq!(rows[0]["text"], "old");
    }
    let (rows, cursor, delta) = history_since(h, "empty", None).unwrap();
    assert!(!delta);
    assert!(rows.is_empty());
    append(h, "empty", json!({"role":"user","text":"first"})).unwrap();
    let (rows, _, delta) = history_since(h, "empty", Some(&cursor)).unwrap();
    assert!(delta);
    assert_eq!(rows[0]["text"], "first");
}

#[test]
fn history_cursor_resets_for_backfills_reordering_and_journal_visibility_changes() {
    for case in [
        "backfill",
        "reorder",
        "hide",
        "reveal",
        "hidden_link",
        "unlink",
        "duplicate_link",
        "move_link",
    ] {
        let home = common::TestHome::new();
        let h = home.path();
        for text in ["one", "two", "three"] {
            append(h, "chat", json!({"role":"user","text":text})).unwrap();
        }
        let conn = open(h).unwrap();
        if case == "backfill" {
            conn.execute(
                "DELETE FROM native_messages WHERE session_id='chat' AND seq=2",
                [],
            )
            .unwrap();
        }
        if matches!(
            case,
            "hide" | "reveal" | "unlink" | "duplicate_link" | "move_link"
        ) {
            conn.execute("INSERT INTO native_pi_journal(journal_id,session_id,raw_json,projection_seq,active) VALUES('j','chat','{}',1,?)", [i64::from(!matches!(case, "reveal" | "unlink"))]).unwrap();
        }
        let (before, cursor, _) = history_since(h, "chat", None).unwrap();
        match case {
            "backfill" => {
                conn.execute("INSERT INTO native_messages VALUES('chat',2,'{\"role\":\"user\",\"text\":\"middle\"}')", []).unwrap();
            }
            "reorder" => reorder_projection(&conn, "chat", &[3, 1, 2]).unwrap(),
            "hide" => {
                conn.execute(
                    "UPDATE native_pi_journal SET active=0 WHERE journal_id='j'",
                    [],
                )
                .unwrap();
            }
            "reveal" => {
                conn.execute(
                    "UPDATE native_pi_journal SET active=1 WHERE journal_id='j'",
                    [],
                )
                .unwrap();
            }
            "hidden_link" => {
                conn.execute("INSERT INTO native_pi_journal(journal_id,session_id,raw_json,projection_seq,active) VALUES('j','chat','{}',1,0)", []).unwrap();
            }
            "unlink" => {
                conn.execute("DELETE FROM native_pi_journal WHERE journal_id='j'", [])
                    .unwrap();
            }
            "duplicate_link" => {
                conn.execute("INSERT INTO native_pi_journal(journal_id,session_id,raw_json,projection_seq) VALUES('j2','chat','{}',1)", []).unwrap();
            }
            "move_link" => {
                conn.execute(
                    "UPDATE native_pi_journal SET projection_seq=2,active=0 WHERE journal_id='j'",
                    [],
                )
                .unwrap();
            }
            _ => unreachable!(),
        }
        let (after, next, delta) = history_since(h, "chat", Some(&cursor)).unwrap();
        assert!(!delta, "{case}");
        assert_ne!(after, before, "{case}");
        assert_eq!(after, history(h, "chat").unwrap(), "{case}");
        let (rows, _, delta) = history_since(h, "chat", Some(&next)).unwrap();
        assert!(delta, "{case}");
        assert!(rows.is_empty(), "{case}");
    }
}

#[test]
fn purge_removes_history_rewrite_counters_for_the_whole_owned_tree() {
    let home = common::TestHome::new();
    let h = home.path();
    crate::db::migrate(h).unwrap();
    let conn = open(h).unwrap();
    conn.execute_batch("INSERT INTO native_sessions VALUES('parent','alice','owl','','{}'),('child','alice','owl','','{\"parent_session\":\"parent\"}');").unwrap();
    for stored in ["parent", "child"] {
        append(h, stored, json!({"role":"user","text":"gone"})).unwrap();
        conn.execute("UPDATE native_messages SET message_json=json_set(message_json,'$.text','edited') WHERE session_id=?", [stored]).unwrap();
        let rewrites: i64 = conn
            .query_row(
                "SELECT count FROM native_history_rewrites WHERE session_id=?",
                [stored],
                |r| r.get(0),
            )
            .unwrap();
        assert!(rewrites > 0);
    }
    delete(h, "parent").unwrap();
    for stored in ["parent", "child"] {
        for table in [
            "native_history_versions",
            "native_history_rewrites",
            "native_messages",
            "native_pi_journal",
        ] {
            let count: i64 = conn
                .query_row(
                    &format!("SELECT count(*) FROM {table} WHERE session_id=?"),
                    [stored],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(count, 0, "{stored}: {table}");
        }
        assert!(append(h, stored, json!({"role":"user","text":"late"})).is_err());
    }
}

#[test]
fn chat_fork_refuses_a_target_with_a_history_rewrite_counter() {
    let home = common::TestHome::new();
    let h = home.path();
    let conn = open(h).unwrap();
    conn.execute("INSERT INTO native_history_rewrites VALUES('target',1)", [])
        .unwrap();
    assert!(prepare_chat_fork(h, "source", "target", "owl", "alice").is_err());
    let count: i64 = conn
        .query_row("SELECT count(*) FROM native_pending_chat_forks", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(count, 0);
}
