//! Sharing a bot grants tools only inside a room authorized for that bot.
use hexbot_core::{
    common, db, events::EventHub, memory::MemoryStore, native_tools, runtime::Runtime,
    runtime_store,
};
use serde_json::json;
use std::{fs, path::Path, time::Duration};
mod support;
fn setup() -> support::TestHome {
    let h = support::TestHome::new();
    db::migrate(h.path()).unwrap();
    let c = db::open(h.path()).unwrap();
    c.execute_batch("INSERT INTO users(id,display_name,role,created_at) VALUES ('alice','Alice','member',0),('bob','Bob','member',0),('carol','Carol','member',0); INSERT INTO bots(name,owner_id,shareable) VALUES ('shared','alice',1),('private','alice',0),('own','bob',0); INSERT INTO rooms VALUES ('room-bob','Bob room','bob','shared',NULL,'{}',0,0,0,NULL),('room-carol','Carol room','carol','shared',NULL,'{}',0,0,0,NULL); INSERT INTO room_members VALUES ('room-bob','bot','shared','bob',0,NULL,0),('room-carol','bot','shared','carol',0,NULL,0),('room-bob','bot','private','bob',0,NULL,0); INSERT INTO room_sessions VALUES ('room-bob','shared','root-bob',NULL),('room-carol','shared','root-carol',NULL),('room-bob','private','root-private',NULL);").unwrap();
    common::write_config(
        h.path(),
        &json!({"tools":{"enabled_toolsets":["code_execution"]}}),
    )
    .unwrap();
    c.execute(
        "INSERT INTO settings(key,value) VALUES ('workspace_dir',?)",
        [json!(h.workspace()).to_string()],
    )
    .unwrap();
    for bot in ["shared", "private", "own"] {
        fs::create_dir_all(h.path().join("profiles").join(bot)).unwrap();
        common::write_config(&h.path().join("profiles").join(bot),&json!({"model":{"provider":"openai","default":"test-model"},"tools":{"enabled_toolsets":["code_execution"]}})).unwrap();
    }
    h
}
fn child(home: &Path, id: &str, owner: &str, bot: &str, parent: Option<&str>) {
    runtime_store::open(home)
        .unwrap()
        .execute(
            "INSERT INTO native_sessions VALUES (?,?,?,'',?)",
            rusqlite::params![id, owner, bot, json!({"parent_session":parent}).to_string()],
        )
        .unwrap();
}
#[test]
fn access_requires_matching_active_room_or_own_bot_and_valid_delegate_chain() {
    let h = setup();
    let home = h.path();
    assert!(common::bot_session_access(home, "bob", "shared", "root-bob").is_ok());
    assert!(common::bot_session_access(home, "bob", "own", "any-own-session").is_ok());
    for (owner, bot, session) in [
        ("bob", "shared", "unknown"),
        ("carol", "shared", "root-bob"),
        ("bob", "shared", "root-carol"),
        ("bob", "private", "root-private"),
    ] {
        assert_eq!(
            common::bot_session_access(home, owner, bot, session)
                .unwrap_err()
                .code,
            4302
        );
    }
    child(home, "child", "bob", "shared", Some("root-bob"));
    child(home, "grandchild", "bob", "shared", Some("child"));
    assert!(common::bot_session_access(home, "bob", "shared", "grandchild").is_ok());
    child(home, "forged-owner", "carol", "shared", Some("root-bob"));
    child(home, "forged-bot", "bob", "private", Some("root-bob"));
    child(home, "orphan", "bob", "shared", None);
    child(home, "cycle-a", "bob", "shared", Some("cycle-b"));
    child(home, "cycle-b", "bob", "shared", Some("cycle-a"));
    for session in ["forged-owner", "forged-bot", "orphan", "cycle-a"] {
        assert_eq!(
            common::bot_session_access(home, "bob", "shared", session)
                .unwrap_err()
                .code,
            4302
        );
    }
    let c = db::open(home).unwrap();
    for (deny, restore) in [
        (
            "UPDATE room_members SET left_at=1 WHERE room_id='room-bob' AND member_id='shared'",
            "UPDATE room_members SET left_at=NULL",
        ),
        (
            "UPDATE rooms SET archived_at=1 WHERE id='room-bob'",
            "UPDATE rooms SET archived_at=NULL",
        ),
        (
            "UPDATE bots SET shareable=0 WHERE name='shared'",
            "UPDATE bots SET shareable=1 WHERE name='shared'",
        ),
        (
            "UPDATE users SET disabled_at=1 WHERE id='bob'",
            "UPDATE users SET disabled_at=NULL",
        ),
    ] {
        c.execute_batch(deny).unwrap();
        for session in ["root-bob", "grandchild"] {
            assert_eq!(
                common::bot_session_access(home, "bob", "shared", session)
                    .unwrap_err()
                    .code,
                4302
            );
        }
        c.execute_batch(restore).unwrap();
    }
}
#[tokio::test]
async fn shared_room_native_tool_works_and_private_or_unrelated_sessions_cannot_execute() {
    let h = setup();
    let args = json!({"code":"print('shared allowed')"});
    let result = native_tools::call(h.path(), "bob", "shared", "root-bob", "execute_code", &args)
        .await
        .unwrap();
    assert_eq!(result["output"], "shared allowed\n");
    for (owner, bot, session) in [
        ("carol", "shared", "root-bob"),
        ("bob", "shared", "root-carol"),
        ("bob", "private", "root-private"),
        ("bob", "shared", "forged"),
    ] {
        assert_eq!(
            native_tools::call(h.path(), owner, bot, session, "execute_code", &args)
                .await
                .unwrap_err()
                .code,
            4302
        );
    }
    db::open(h.path())
        .unwrap()
        .execute(
            "UPDATE room_members SET left_at=1 WHERE room_id='room-bob' AND member_id='shared'",
            [],
        )
        .unwrap();
    assert_eq!(
        native_tools::call(h.path(), "bob", "shared", "root-bob", "execute_code", &args)
            .await
            .unwrap_err()
            .code,
        4302
    );
    native_tools::close_session(h.path(), "root-bob").await;
}
fn fake_pi(home: &Path) -> std::path::PathBuf {
    let path = home.join("fake-pi.cjs");
    fs::write(&path,r#"#!/usr/bin/env node
const rl=require('node:readline').createInterface({input:process.stdin});const emit=x=>process.stdout.write(JSON.stringify(x)+'\n');
function finish(text){emit({type:'message_end',message:{role:'assistant',content:[{type:'text',text}],model:'test-model',provider:'test',usage:{input:1,output:1},stopReason:'stop'}});emit({type:'agent_settled'});}
rl.on('line',line=>{const c=JSON.parse(line);if(c.type==='extension_ui_response'){finish(c.value||'resolved');return;}emit({type:'response',id:c.id,command:c.type,success:true,data:{}});if(c.type==='prompt'){emit({type:'agent_start'});emit({type:'message_end',message:{role:'user',content:c.message}});if(c.message==='approval'){emit({type:'extension_ui_request',id:'approval-1',method:'select',title:'__HEXBOT_APPROVAL__'+JSON.stringify({tool:'execute_code',command:'print(42)',reason:'Run code'}),options:['once','deny']});}else{const tool=c.message==='soul'?{name:'hexbot_soul',args:{text:'A shared bot soul.'}}:{name:'memory',args:{action:'set',text:'Shared room memory.'}};emit({type:'extension_ui_request',id:'tool-1',method:'input',title:'__HEXBOT_TOOL__'+JSON.stringify(tool)});}}if(c.type==='abort')emit({type:'agent_settled'});});
"#).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
    }
    path
}
#[tokio::test]
async fn shared_room_memory_soul_and_approvals_keep_bot_and_conversation_owners_distinct() {
    let h = setup();
    let hub = EventHub::new();
    let mut events = hub.subscribe();
    let runtime = Runtime::new(h.path().into(), hub.clone(), fake_pi(h.path())).unwrap();
    let reply = runtime
        .run_hidden("bob", "shared", "root-bob", "memory")
        .await
        .unwrap();
    assert!(reply.contains("Shared room memory."));
    let memory = MemoryStore::new(h.path().into());
    assert_eq!(
        memory.get_bot("alice", "shared").unwrap()["memory_md"],
        "Shared room memory."
    );
    assert_eq!(memory.get_bot("bob", "own").unwrap()["memory_md"], "");
    assert_eq!(memory.get_bot("bob", "shared").unwrap_err().code, 4302);
    runtime
        .run_hidden("bob", "shared", "root-bob", "soul")
        .await
        .unwrap();
    assert_eq!(
        fs::read_to_string(h.path().join("profiles/shared/SOUL.md")).unwrap(),
        "A shared bot soul."
    );
    let live = runtime
        .ensure_hidden("bob", "shared", "root-bob")
        .await
        .unwrap();
    runtime
        .call(
            "bob",
            "prompt.submit",
            &json!({"session_id":live,"text":"approval","display_kind":"hidden"}),
        )
        .await
        .unwrap()
        .unwrap();
    let approval = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let event = events.recv().await.unwrap();
            if event.frame["params"]["type"] == "approval.request" {
                break event;
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(approval.owner, "bob");
    assert_eq!(approval.frame["params"]["session_id"], live);
    assert_eq!(hub.since("alice", &live, 0)["count"], 0);
    let p = json!({"session_id":live,"request_id":"approval-1","choice":"once"});
    assert!(
        runtime
            .call("alice", "approval.respond", &p)
            .await
            .unwrap()
            .is_err()
    );
    runtime
        .call("bob", "approval.respond", &p)
        .await
        .unwrap()
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if events.recv().await.unwrap().frame["params"]["type"] == "message.complete" {
                break;
            }
        }
    })
    .await
    .unwrap();
    db::open(h.path())
        .unwrap()
        .execute(
            "UPDATE room_members SET left_at=1 WHERE room_id='room-bob' AND member_id='shared'",
            [],
        )
        .unwrap();
    // The already-open process must also lose permission when membership is revoked.
    let result = runtime
        .run_hidden("bob", "shared", "root-bob", "memory")
        .await;
    assert!(result.is_err() || result.unwrap().contains("not the owner"));
    assert_eq!(
        memory.get_bot("alice", "shared").unwrap()["memory_md"],
        "Shared room memory."
    );
    runtime.shutdown().await;
}
