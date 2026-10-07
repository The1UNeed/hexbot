use hexbot_core::{db, memory::MemoryStore, rpc};
use serde_json::json;
use std::fs;

fn setup() -> (tempfile::TempDir, MemoryStore) {
    let dir = tempfile::tempdir().unwrap();
    db::migrate(dir.path()).unwrap();
    let store = MemoryStore::new(dir.path().to_path_buf());
    (dir, store)
}

#[test]
fn memory_methods_return_results_and_error_codes() {
    let (_dir, store) = setup();
    assert_eq!(
        rpc::call(&store, "local", "hexbot.memory.user.get", &json!(null)).unwrap(),
        json!({"text":"", "cap":2000, "updated_at":null})
    );
    let missing = rpc::call(&store, "local", "hexbot.memory.bot.get", &json!({})).unwrap_err();
    assert_eq!(missing.code, 4200);
    let unknown = rpc::call(&store, "local", "prompt.submit", &json!({})).unwrap_err();
    assert_eq!(unknown.code, -32601);
    assert_eq!(rpc::parse_error()["error"]["code"], -32700);
}

#[test]
fn invalid_text_does_not_write_memory() {
    let (_dir, store) = setup();
    rpc::call(
        &store,
        "local",
        "hexbot.memory.user.set",
        &json!({"text":"Alex"}),
    )
    .unwrap();
    let invalid = rpc::call(
        &store,
        "local",
        "hexbot.memory.user.set",
        &json!({"text":42}),
    )
    .unwrap_err();
    assert_eq!(invalid.code, 4201);
    assert_eq!(store.get_user("local").unwrap()["text"], "Alex");
}

/// The app lists, edits and deletes a bot's notes by day through the memory RPCs.
#[test]
fn notes_methods_list_set_and_delete_a_day() {
    let (dir, store) = setup();
    db::open(dir.path())
        .unwrap()
        .execute("INSERT INTO bots(name,owner_id) VALUES('owl','local')", [])
        .unwrap();
    let call =
        |method: &str, params: serde_json::Value| rpc::call(&store, "local", method, &params);
    hexbot_core::memory::fix_today(chrono::NaiveDate::from_ymd_opt(2026, 10, 7).unwrap());
    let today = "2026-10-07";
    assert_eq!(
        call("hexbot.memory.notes.list", json!({"bot":"owl"})).unwrap(),
        json!({"days":[], "today":today, "cap":4000, "retention_days":30})
    );
    assert_eq!(
        call(
            "hexbot.memory.notes.set",
            json!({"bot":"owl","date":"2026-10-06","text":"Set up the export."})
        )
        .unwrap(),
        json!({"date":"2026-10-06", "text":"Set up the export.", "cap":4000})
    );
    call(
        "hexbot.memory.notes.set",
        json!({"bot":"owl","date":"2026-10-07","text":"Vendor column is stale."}),
    )
    .unwrap();
    assert_eq!(
        fs::read_to_string(dir.path().join("profiles/owl/memories/notes/2026-10-06.md")).unwrap(),
        "Set up the export."
    );
    let listed = call("hexbot.memory.notes.list", json!({"bot":"owl"})).unwrap();
    assert_eq!(listed["days"][0]["date"], "2026-10-07");
    assert_eq!(listed["days"][1]["text"], "Set up the export.");
    // An edit names the text it loaded; a day the bot has added to since is kept.
    assert_eq!(
        call(
            "hexbot.memory.notes.set",
            json!({"bot":"owl","date":"2026-10-06","text":"Set up the export, twice.","expected":"Set up the export"})
        )
        .unwrap_err()
        .code,
        4209
    );
    assert_eq!(
        call(
            "hexbot.memory.notes.set",
            json!({"bot":"owl","date":"2026-10-06","text":"Set up the export, twice.","expected":"Set up the export."})
        )
        .unwrap()["text"],
        "Set up the export, twice."
    );
    assert_eq!(
        call(
            "hexbot.memory.notes.set",
            json!({"bot":"owl","date":"6 Oct","text":"x"})
        )
        .unwrap_err()
        .code,
        4202
    );
    assert_eq!(
        call("hexbot.memory.notes.delete", json!({"bot":"owl"}))
            .unwrap_err()
            .code,
        4200
    );
    assert_eq!(
        call(
            "hexbot.memory.notes.delete",
            json!({"bot":"owl","date":"2026-10-06"})
        )
        .unwrap(),
        json!({"date":"2026-10-06", "deleted":true})
    );
    assert_eq!(
        call("hexbot.memory.notes.list", json!({"bot":"owl"})).unwrap()["days"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        rpc::call(
            &store,
            "someone",
            "hexbot.memory.notes.list",
            &json!({"bot":"owl"})
        )
        .unwrap_err()
        .code,
        4302
    );
}
