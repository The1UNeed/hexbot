use hexbot_core::{db, memory::MemoryStore, rpc};
use serde_json::{Value, json};

fn setup() -> (tempfile::TempDir, MemoryStore) {
    let dir = tempfile::tempdir().unwrap();
    db::migrate(dir.path()).unwrap();
    let store = MemoryStore::new(dir.path().to_path_buf());
    (dir, store)
}

#[test]
fn rpc_matches_memory_response_and_errors() {
    let (_dir, store) = setup();
    let get = rpc::dispatch(
        &store,
        "local",
        json!({
            "jsonrpc":"2.0","id":"r1","method":"hexbot.memory.user.get"
        }),
    )
    .unwrap();
    assert_eq!(
        get,
        json!({"jsonrpc":"2.0","id":"r1","result":{
            "text":"","cap":2000,"updated_at":null
        }})
    );
    let missing = rpc::dispatch(
        &store,
        "local",
        json!({
            "jsonrpc":"2.0","id":2,"method":"hexbot.memory.bot.get","params":{}
        }),
    )
    .unwrap();
    assert_eq!(missing["error"]["code"], 4200);
    let unknown = rpc::dispatch(
        &store,
        "local",
        json!({
            "jsonrpc":"2.0","id":null,"method":"prompt.submit"
        }),
    )
    .unwrap();
    assert_eq!(unknown["error"]["code"], -32601);
    assert_eq!(unknown["id"], Value::Null);
}

#[test]
fn invalid_requests_do_not_write_memory() {
    let (_dir, store) = setup();
    for request in [
        json!({"id":1,"method":"hexbot.memory.user.set","params":{"text":"bad"}}),
        json!({"jsonrpc":"2.0","id":{},"method":"hexbot.memory.user.set","params":{"text":"bad"}}),
        json!([{"jsonrpc":"2.0","id":1,"method":"hexbot.memory.user.set"}]),
    ] {
        assert_eq!(
            rpc::dispatch(&store, "local", request).unwrap()["error"]["code"],
            -32600
        );
    }
    assert_eq!(store.get_user("local").unwrap()["text"], "");
    let invalid_params = rpc::dispatch(
        &store,
        "local",
        json!({
            "jsonrpc":"2.0","id":2,"method":"hexbot.memory.user.set","params":[]
        }),
    )
    .unwrap();
    assert_eq!(invalid_params["error"]["code"], -32602);
}

#[test]
fn notifications_execute_without_a_reply_and_validate_text() {
    let (_dir, store) = setup();
    assert!(
        rpc::dispatch(
            &store,
            "local",
            json!({
                "jsonrpc":"2.0","method":"hexbot.memory.user.set","params":{"text":"Alex"}
            })
        )
        .is_none()
    );
    assert_eq!(store.get_user("local").unwrap()["text"], "Alex");
    let invalid = rpc::dispatch(
        &store,
        "local",
        json!({
            "jsonrpc":"2.0","id":3,"method":"hexbot.memory.user.set","params":{"text":42}
        }),
    )
    .unwrap();
    assert_eq!(invalid["error"]["code"], 4201);
    assert_eq!(store.get_user("local").unwrap()["text"], "Alex");
}
