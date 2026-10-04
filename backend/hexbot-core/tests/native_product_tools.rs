use hexbot_core::{common, db, native_product_tools as product, runtime_store};
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
