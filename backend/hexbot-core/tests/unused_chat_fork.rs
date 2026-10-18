//! Unused fork reservations and provisional bot journals are not purge authority.
use hexbot_core::{catalog, common, db, runtime_store as store, server::App};
use serde_json::{Value, json};
use std::{fs, path::Path};

fn fixture(h: &Path) {
    db::migrate(h).unwrap();
    db::open(h)
        .unwrap()
        .execute_batch(
            "INSERT INTO bots(name,owner_id) VALUES('owl','local');
         INSERT INTO sections(id,bot,owner_id,title) VALUES('chat','owl','local','General');
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

#[test]
fn unused_dream_forks_leave_no_reservations_or_permanent_empty_tombstones() {
    for public in [false, true] {
        for missing_raw in [true, false] {
            let home = tempfile::tempdir().unwrap();
            let h = home.path();
            let app = App::new(
                h.into(),
                "127.0.0.1:0".parse().unwrap(),
                h.join("unused-pi"),
                None,
            )
            .unwrap();
            fixture(h);
            db::open(h).unwrap().execute_batch(
            "UPDATE sections SET title='Dreams' WHERE id='chat';
             INSERT INTO dreams(id,bot,started_at,status,summary) VALUES('dream','owl',1,'complete','REPORT');"
        ).unwrap();
            store::append(
                h,
                "chat",
                json!({"role":"assistant","text":"REPORT","dream":true,"timestamp":1}),
            )
            .unwrap();
            store::append(
                h,
                "chat",
                json!({"role":"user","text":"KEEP","timestamp":2}),
            )
            .unwrap();
            let dir = store::session_dir(h, "chat").unwrap();
            if !missing_raw {
                let lines = [
                    json!({"type":"session","version":3,"id":"chat","cwd":h}),
                    json!({"type":"message","id":"human","parentId":null,"message":{"role":"user","content":[{"type":"text","text":"KEEP"}],"timestamp":2000}}),
                ];
                fs::write(
                    dir.join("conversation.jsonl"),
                    format!("{}\n{}\n", lines[0], lines[1]),
                )
                .unwrap();
            }
            let before = source(h);
            let state = deletion_state(h);
            for attempt in 0..3 {
                let selected = if public {
                    tokio::runtime::Builder::new_current_thread()
                        .enable_all()
                        .build()
                        .unwrap()
                        .block_on(app.call(
                            "local",
                            "hexbot.sections.create",
                            &json!({"bot":"owl"}),
                        ))
                        .unwrap()["section"]
                        .clone()
                } else {
                    catalog::chat_section(h, "local", "owl").unwrap()
                };
                assert_eq!(selected["id"], "chat");
                assert_eq!(source(h), before);
                assert_eq!(
                    deletion_state(h),
                    state,
                    "missing_raw={missing_raw}, attempt={attempt}"
                );
            }
            for _ in 0..2 {
                store::finish_deletes(h).unwrap();
                assert_eq!(source(h), before);
                assert_eq!(deletion_state(h), state);
            }
            let app = App::new(
                h.into(),
                "127.0.0.1:0".parse().unwrap(),
                h.join("unused-pi"),
                None,
            )
            .unwrap();
            assert_eq!(deletion_state(h), state);
            drop(app);
        }
    }
}

#[test]
fn unused_reservation_removal_failure_keeps_identity_without_creating_tombstones() {
    let home = tempfile::tempdir().unwrap();
    let h = home.path();
    fixture(h);
    db::open(h).unwrap().execute_batch("UPDATE sections SET title='Dreams' WHERE id='chat'; INSERT INTO dreams(id,bot,started_at,status,summary) VALUES('dream','owl',1,'complete','REPORT');").unwrap();
    store::append(
        h,
        "chat",
        json!({"role":"assistant","text":"REPORT","dream":true,"timestamp":1}),
    )
    .unwrap();
    store::append(
        h,
        "chat",
        json!({"role":"user","text":"KEEP","timestamp":2}),
    )
    .unwrap();
    let before = source(h);
    store::open(h).unwrap().execute_batch("CREATE TRIGGER keep_reservation BEFORE DELETE ON native_pending_chat_forks BEGIN SELECT RAISE(ABORT,'reservation removal failure'); END;").unwrap();
    assert_eq!(
        catalog::chat_section(h, "local", "owl").unwrap()["id"],
        "chat"
    );
    let pending = deletion_state(h);
    assert_eq!(pending["pending"].as_array().unwrap().len(), 1);
    assert_eq!(pending["deleted"], json!([]));
    assert_eq!(pending["completed"], json!([]));
    assert!(store::finish_deletes(h).is_err());
    assert_eq!(deletion_state(h), pending);
    store::open(h)
        .unwrap()
        .execute_batch("DROP TRIGGER keep_reservation")
        .unwrap();
    for _ in 0..2 {
        store::finish_deletes(h).unwrap();
        assert_eq!(source(h), before);
        assert_eq!(deletion_state(h)["pending"], json!([]));
        assert_eq!(deletion_state(h)["deleted"], json!([]));
        assert_eq!(deletion_state(h)["completed"], json!([]));
    }
}
