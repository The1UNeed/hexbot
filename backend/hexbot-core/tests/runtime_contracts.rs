use hexbot_core::{
    db,
    events::{Event, EventHub},
    runtime::Runtime,
};
use serde_json::{Value, json};
use std::{fs, time::Duration};

async fn next(events: &mut tokio::sync::broadcast::Receiver<Event>, kind: &str) -> Value {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let event = events.recv().await.unwrap();
            if event.frame["params"]["type"] == kind {
                return event.frame["params"].clone();
            }
        }
    })
    .await
    .unwrap()
}
fn setup() -> (
    tempfile::TempDir,
    std::sync::Arc<Runtime>,
    tokio::sync::broadcast::Receiver<Event>,
) {
    let home = tempfile::tempdir().unwrap();
    db::migrate(home.path()).unwrap();
    db::open(home.path()).unwrap().execute_batch("INSERT INTO users(id,display_name,role,created_at) VALUES('alice','Alice','admin',0);INSERT INTO bots(name,owner_id) VALUES('owl','alice');INSERT INTO sections(id,bot,owner_id,title) VALUES('first','owl','alice','First'),('second','owl','alice','Second');").unwrap();
    let profile = home.path().join("profiles/owl");
    fs::create_dir_all(&profile).unwrap();
    fs::write(
        profile.join("config.yaml"),
        "model:\n  provider: openai\n  default: fixture\ntools:\n  enabled_toolsets: []\n",
    )
    .unwrap();
    db::open(home.path())
        .unwrap()
        .execute(
            "INSERT OR REPLACE INTO settings(key,value) VALUES('workspace_dir',?)",
            [json!(home.path().join("workspace")).to_string()],
        )
        .unwrap();
    let script = home.path().join("pi.cjs");
    fs::write(&script,r#"#!/usr/bin/env node
const rl=require('node:readline').createInterface({input:process.stdin});
const emit=v=>process.stdout.write(JSON.stringify(v)+'\n');
rl.on('line',line=>{const c=JSON.parse(line);emit({type:'response',id:c.id,command:c.type,success:true,data:{}});if(c.type==='prompt'){emit({type:'agent_start'});if(c.message==='wait'){emit({type:'extension_ui_request',id:'a',method:'select',title:'__HEXBOT_APPROVAL__'+JSON.stringify({tool:'bash',command:'pwd'}),options:['once','deny']});}else if(c.message==='fail'){emit({type:'tool_execution_start',toolCallId:'t',toolName:'web_search',args:{query:'x'}});emit({type:'tool_execution_end',toolCallId:'t',toolName:'web_search',isError:true,result:{content:[{type:'text',text:'Token refused'}]}});emit({type:'agent_settled'});}}if(c.type==='abort'){emit({type:'agent_settled'});}});
"#).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
    }
    let hub = EventHub::new();
    let events = hub.subscribe();
    let runtime = Runtime::new(home.path().into(), hub, script).unwrap();
    (home, runtime, events)
}
async fn open(runtime: &Runtime, id: &str) -> String {
    runtime
        .call("alice", "hexbot.sections.open", &json!({"id":id}))
        .await
        .unwrap()
        .unwrap()["section"]["live_session_id"]
        .as_str()
        .unwrap()
        .to_string()
}
#[tokio::test]
async fn active_bot_status_uses_wire_detail_and_prioritizes_waiting_section() {
    let (_home, runtime, mut events) = setup();
    let first = open(&runtime, "first").await;
    runtime
        .call(
            "alice",
            "prompt.submit",
            &json!({"session_id":first,"text":"wait"}),
        )
        .await
        .unwrap()
        .unwrap();
    next(&mut events, "approval.request").await;
    let second = open(&runtime, "second").await;
    runtime
        .call(
            "alice",
            "prompt.submit",
            &json!({"session_id":second,"text":"working"}),
        )
        .await
        .unwrap()
        .unwrap();
    let status = runtime.status_for_bot("alice", "owl").unwrap();
    assert_eq!(status["status"], "needs_you");
    let detail = &status["status_detail"];
    assert_eq!(detail["section_id"], "first");
    assert_eq!(detail["session_id"], first);
    assert_eq!(detail["text"], "Waiting for you");
    assert!(detail["room_id"].is_null());
    assert!(detail["since"].as_f64().unwrap() > 0.0);
    assert!(detail["action"].is_null());
    assert!(runtime.status_for_bot("other", "owl").is_none());
    runtime.shutdown().await;
}
#[tokio::test]
async fn failed_tool_events_include_error_property_expected_by_unchanged_ui() {
    let (_home, runtime, mut events) = setup();
    let session = open(&runtime, "first").await;
    runtime
        .call(
            "alice",
            "prompt.submit",
            &json!({"session_id":session,"text":"fail"}),
        )
        .await
        .unwrap()
        .unwrap();
    let event = next(&mut events, "tool.complete").await;
    assert_eq!(event["payload"]["result"]["error"], "Token refused");
    assert_eq!(event["payload"]["result_text"], "Token refused");
    assert_eq!(event["payload"]["tool_id"], "t");
    assert_eq!(event["payload"]["summary"], "Tool failed");
    runtime.shutdown().await;
}
