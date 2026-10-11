use hexbot_core::{db, memory::MemoryStore, rpc};
use serde_json::json;

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
