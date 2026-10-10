use hexbot_core::{db, events::EventHub, runtime::Runtime, runtime_store};
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
    time::Duration,
};
mod support;

fn setup() -> support::TestHome {
    let home = support::TestHome::new();
    db::migrate(home.path()).unwrap();
    let conn = db::open(home.path()).unwrap();
    conn.execute_batch("INSERT INTO users(id,display_name,role,created_at) VALUES('alice','Alice','admin',0),('bob','Bob','member',0); INSERT INTO bots(name,owner_id) VALUES('owl','alice'); INSERT INTO sections(id,bot,owner_id,title,created_at,updated_at) VALUES('section-a','owl','alice','Conversation',0,0);").unwrap();
    let workspace = home.workspace();
    conn.execute(
        "INSERT INTO settings(key,value) VALUES('workspace_dir',?)",
        [json!(workspace).to_string()],
    )
    .unwrap();
    fs::create_dir_all(home.path().join("profiles/owl")).unwrap();
    fs::write(
        home.path().join("profiles/owl/config.yaml"),
        "model:\n  provider: openai\n  default: test-model\ntools:\n  enabled_toolsets: []\n",
    )
    .unwrap();
    home
}
fn fake_pi(home: &Path) -> PathBuf {
    let path = home.join("fake-pi.cjs");
    fs::write(&path,r##"#!/usr/bin/env node
const rl=require('node:readline').createInterface({input:process.stdin});
const emit=v=>process.stdout.write(JSON.stringify(v)+'\n');
let pending;
function complete(text){emit({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:text}});emit({type:'message_end',message:{role:'assistant',content:[{type:'text',text}],model:'test-model',provider:'test',usage:{input:11,output:4,cacheRead:2,cacheWrite:0,cost:{total:.01}},stopReason:'stop'}});emit({type:'agent_end'});emit({type:'agent_settled'});}
rl.on('line',line=>{const c=JSON.parse(line);if(c.type==='extension_ui_response'){complete(c.value==='deny'?'Denied':'Approved');return;}emit({type:'response',id:c.id,command:c.type,success:true,data:c.type==='get_available_models'?{models:[{id:'test-model',provider:'test'},{id:'costly',provider:'test',cost:{input:21,output:101}}]}:{}});
if(c.type==='prompt'){emit({type:'agent_start'});emit({type:'message_end',message:{role:'user',content:c.message}});if(c.message==='approval'){emit({type:'extension_ui_request',id:'approval-1',method:'select',title:'__HEXBOT_APPROVAL__'+JSON.stringify({tool:'bash',command:'pwd',reason:'Run command'}),options:['once','session','deny']});}else if(c.message==='batch'){emit({type:'extension_ui_request',id:'batch-1',method:'input',title:'__HEXBOT_CLARIFY__'+JSON.stringify({questions:[{qid:'color',question:'Color?',choices:['red','blue']},{qid:'shape',question:'Shape?'}]})});}else if(c.message==='waiting'){}else complete('Reply: '+c.message);}
if(c.type==='abort'){emit({type:'agent_settled'});}
});
"##).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
    }
    path
}
async fn open(runtime: &Runtime, owner: &str) -> Value {
    runtime
        .call(owner, "hexbot.sections.open", &json!({"id":"section-a"}))
        .await
        .unwrap()
        .unwrap()
}
async fn next_kind(
    events: &mut tokio::sync::broadcast::Receiver<hexbot_core::events::Event>,
    kind: &str,
) -> Value {
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
#[tokio::test]
async fn chat_stream_history_restart_and_owner_isolation() {
    let home = setup();
    let executable = fake_pi(home.path());
    let hub = EventHub::new();
    let mut events = hub.subscribe();
    let runtime = Runtime::new(home.path().into(), hub, executable.clone()).unwrap();
    assert!(
        runtime
            .call("bob", "hexbot.sections.open", &json!({"id":"section-a"}))
            .await
            .unwrap()
            .is_err()
    );
    let opened = open(&runtime, "alice").await;
    let live = opened["section"]["live_session_id"].as_str().unwrap();
    assert_ne!(live, "section-a");
    assert!(
        runtime
            .call(
                "alice",
                "session.history",
                &json!({"session_id":"section-a"})
            )
            .await
            .unwrap()
            .is_err()
    );
    assert!(
        runtime
            .call("bob", "session.history", &json!({"session_id":live}))
            .await
            .unwrap()
            .is_err()
    );
    runtime
        .call(
            "alice",
            "prompt.submit",
            &json!({"session_id":live,"text":"Hello"}),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        next_kind(&mut events, "message.complete").await["payload"]["text"],
        "Reply: Hello"
    );
    let history = runtime
        .call("alice", "session.history", &json!({"session_id":live}))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(history["messages"].as_array().unwrap().len(), 2);
    assert!(history["messages"][0]["timestamp"].as_f64().unwrap() > 0.);
    assert_eq!(
        runtime
            .call("alice", "session.usage", &json!({"session_id":live}))
            .await
            .unwrap()
            .unwrap()["usage"]["total_tokens"],
        17
    );
    runtime.shutdown().await;
    drop(runtime);
    let restarted = Runtime::new(home.path().into(), EventHub::new(), executable).unwrap();
    let restored = open(&restarted, "alice").await;
    assert_eq!(restored["messages"], history["messages"]);
    assert_ne!(restored["section"]["live_session_id"], live);
    restarted.shutdown().await;
}
#[tokio::test]
async fn approval_interrupt_hidden_and_frozen_prompt() {
    let home = setup();
    fs::write(home.path().join("profiles/owl/SOUL.md"), "Initial soul").unwrap();
    let hub = EventHub::new();
    let mut events = hub.subscribe();
    let runtime = Runtime::new(home.path().into(), hub, fake_pi(home.path())).unwrap();
    let opened = open(&runtime, "alice").await;
    let live = &opened["section"]["live_session_id"];
    runtime
        .call(
            "alice",
            "prompt.submit",
            &json!({"session_id":live,"text":"approval","display_kind":"hidden"}),
        )
        .await
        .unwrap()
        .unwrap();
    let approval = next_kind(&mut events, "approval.request").await;
    assert_eq!(approval["payload"]["request_id"], "approval-1");
    // Cards name their bot and section, for clients that do not list it (private threads).
    assert_eq!(approval["payload"]["bot"], "owl");
    assert_eq!(approval["payload"]["section_id"], opened["section"]["id"]);
    assert!(
        runtime
            .call(
                "bob",
                "approval.respond",
                &json!({"session_id":live,"request_id":"approval-1","choice":"once"})
            )
            .await
            .unwrap()
            .is_err()
    );
    runtime
        .call(
            "alice",
            "approval.respond",
            &json!({"session_id":live,"request_id":"approval-1","choice":"deny"}),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        next_kind(&mut events, "message.complete").await["payload"]["text"],
        "Denied"
    );
    assert_eq!(
        runtime_store::history(home.path(), "section-a").unwrap()[0]["display_kind"],
        "hidden"
    );
    fs::write(home.path().join("profiles/owl/SOUL.md"), "Changed soul").unwrap();
    runtime.close_stored("alice", "section-a").await.unwrap();
    open(&runtime, "alice").await;
    let config: Value = serde_json::from_str(
        &fs::read_to_string(home.path().join("runtime/sessions/section-a/config.json")).unwrap(),
    )
    .unwrap();
    assert!(config["prompt"].as_str().unwrap().contains("Initial soul"));
    assert!(!config["prompt"].as_str().unwrap().contains("Changed soul"));
    runtime.shutdown().await;
}
#[test]
fn imports_legacy_messages_once_and_preserves_hidden_and_tool_rows() {
    let home = setup();
    let conn = rusqlite::Connection::open(home.path().join("profiles/owl/state.db")).unwrap();
    conn.execute_batch("CREATE TABLE sessions(id TEXT,session_key TEXT);CREATE TABLE messages(id INTEGER,session_id TEXT,role TEXT,content TEXT,tool_call_id TEXT,tool_calls TEXT,tool_name TEXT,timestamp REAL,active INTEGER,display_kind TEXT);INSERT INTO sessions VALUES('legacy','section-a');INSERT INTO messages VALUES(1,'legacy','user','secret kickoff',NULL,NULL,NULL,100,1,'hidden');INSERT INTO messages VALUES(2,'legacy','assistant','Calling',NULL,'[{\"id\":\"t1\",\"function\":{\"name\":\"read\",\"arguments\":\"{}\"}}]',NULL,101,1,NULL);INSERT INTO messages VALUES(3,'legacy','tool','Contents','t1',NULL,'read',102,1,NULL);").unwrap();
    runtime_store::import_hermes(home.path(), "owl", "section-a", home.path()).unwrap();
    runtime_store::import_hermes(home.path(), "owl", "section-a", home.path()).unwrap();
    let messages = runtime_store::history(home.path(), "section-a").unwrap();
    assert_eq!(messages.len(), 3);
    assert_eq!(messages[0]["display_kind"], "hidden");
    assert_eq!(messages[0]["timestamp"], 100.);
    assert_eq!(messages[2]["name"], "read");
    let log = fs::read_to_string(
        home.path()
            .join("runtime/sessions/section-a/conversation.jsonl"),
    )
    .unwrap();
    assert!(log.contains("toolCallId"));
    assert!(log.contains("toolCall"));
}
#[tokio::test]
#[ignore = "requires HEXBOT_TEST_PI to the pinned Pi executable"]
async fn actual_pi_loads_hexbot_extension_and_private_session() {
    let home = setup();
    let executable = PathBuf::from(std::env::var_os("HEXBOT_TEST_PI").unwrap());
    let runtime = Runtime::new(home.path().into(), EventHub::new(), executable).unwrap();
    let opened = open(&runtime, "alice").await;
    assert!(
        opened["section"]["live_session_id"]
            .as_str()
            .unwrap()
            .starts_with("live-")
    );
    runtime.shutdown().await;
}

#[tokio::test]
#[ignore = "requires HEXBOT_TEST_PI to the pinned Pi executable"]
async fn actual_pi_streams_and_executes_native_memory_tool() {
    use axum::{Json, Router, extract::State, routing::post};
    use std::sync::{Arc, Mutex};
    async fn complete(
        State(requests): State<Arc<Mutex<Vec<Value>>>>,
        Json(body): Json<Value>,
    ) -> ([(&'static str, &'static str); 1], String) {
        let mut requests = requests.lock().unwrap();
        let number = requests.len();
        requests.push(body);
        let delta = if number == 0 {
            json!({"role":"assistant","tool_calls":[{"index":0,"id":"memory-1","type":"function","function":{"name":"memory","arguments":"{\"action\":\"add\",\"text\":\"The user likes tea.\"}"}}]})
        } else {
            json!({"role":"assistant","content":"I will remember your tea preference."})
        };
        let first = json!({"id":"completion-test","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":delta,"finish_reason":null}]});
        let end = json!({"id":"completion-test","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{},"finish_reason":if number==0{"tool_calls"}else{"stop"}}],"usage":{"prompt_tokens":30,"completion_tokens":10,"total_tokens":40}});
        (
            [("content-type", "text/event-stream")],
            format!("data: {first}\n\ndata: {end}\n\ndata: [DONE]\n\n"),
        )
    }
    let requests = Arc::new(Mutex::new(vec![]));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = Router::new()
        .route("/v1/chat/completions", post(complete))
        .with_state(requests.clone());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let home = setup();
    fs::write(home.path().join("profiles/owl/config.yaml"),format!("model:\n  provider: lmstudio\n  default: test-model\n  api_key: test-key\n  base_url: http://{address}/v1\ntools:\n  enabled_toolsets: []\n")).unwrap();
    let executable = PathBuf::from(std::env::var_os("HEXBOT_TEST_PI").unwrap());
    let runtime = Runtime::new(home.path().into(), EventHub::new(), executable).unwrap();
    let reply = tokio::time::timeout(
        Duration::from_secs(20),
        runtime.run_hidden("alice", "owl", "section-a", "Remember that I like tea."),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(reply, "I will remember your tea preference.");
    assert!(
        fs::read_to_string(home.path().join("profiles/owl/memories/MEMORY.md"))
            .unwrap()
            .contains("tea")
    );
    {
        let requests = requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        let names = requests[0]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["function"]["name"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert!(names.contains(&"memory"));
        assert!(!names.contains(&"bash"));
        assert!(!names.contains(&"write"));
    }
    runtime.shutdown().await;
    server.abort();
}

#[tokio::test]
#[ignore = "requires HEXBOT_TEST_PI to the pinned Pi executable"]
async fn actual_pi_falls_back_without_repeating_user_message() {
    use axum::{
        Json, Router,
        extract::State,
        response::{IntoResponse, Response},
        routing::post,
    };
    use std::sync::{Arc, Mutex};
    async fn complete(
        State(requests): State<Arc<Mutex<Vec<Value>>>>,
        Json(body): Json<Value>,
    ) -> Response {
        let model = body["model"].as_str().unwrap_or("").to_owned();
        requests.lock().unwrap().push(body);
        if model == "primary" {
            return (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error":{"message":"primary is unavailable","type":"server_error"}})),
            )
                .into_response();
        }
        let data = json!({"id":"fallback-test","object":"chat.completion.chunk","created":1,"model":"fallback","choices":[{"index":0,"delta":{"role":"assistant","content":"Fallback completed the task."},"finish_reason":null}]});
        let end = json!({"id":"fallback-test","object":"chat.completion.chunk","created":1,"model":"fallback","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":30,"completion_tokens":8,"total_tokens":38}});
        (
            [("content-type", "text/event-stream")],
            format!("data: {data}\n\ndata: {end}\n\ndata: [DONE]\n\n"),
        )
            .into_response()
    }
    let requests = Arc::new(Mutex::new(vec![]));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = Router::new()
        .route("/v1/chat/completions", post(complete))
        .with_state(requests.clone());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let home = setup();
    fs::write(home.path().join("profiles/owl/config.yaml"),format!("model:\n  provider: lmstudio\n  default: primary\n  api_key: test-key\n  base_url: http://{address}/v1\ntools:\n  enabled_toolsets: []\n")).unwrap();
    db::open(home.path())
        .unwrap()
        .execute(
            "INSERT INTO settings(key,value) VALUES('fallback_model',?)",
            [json!("lmstudio/fallback").to_string()],
        )
        .unwrap();
    fs::create_dir_all(home.path().join("profiles/owl/pi")).unwrap();
    fs::write(
        home.path().join("profiles/owl/pi/settings.json"),
        "{\"retry\":{\"enabled\":false}}",
    )
    .unwrap();
    let executable = PathBuf::from(std::env::var_os("HEXBOT_TEST_PI").unwrap());
    let runtime = Runtime::new(home.path().into(), EventHub::new(), executable).unwrap();
    let reply = tokio::time::timeout(
        Duration::from_secs(25),
        runtime.run_hidden("alice", "owl", "section-a", "Complete my task."),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(reply, "Fallback completed the task.");
    let history = runtime_store::history(home.path(), "section-a").unwrap();
    assert_eq!(history.iter().filter(|m| m["role"] == "user").count(), 1);
    assert_eq!(
        history.iter().filter(|m| m["role"] == "assistant").count(),
        1
    );
    assert_eq!(
        requests.lock().unwrap().first().unwrap()["model"],
        "primary"
    );
    assert_eq!(
        requests.lock().unwrap().last().unwrap()["model"],
        "fallback"
    );
    runtime.shutdown().await;
    server.abort();
}

#[tokio::test]
#[ignore = "requires HEXBOT_TEST_PI to the pinned Pi executable"]
async fn actual_pi_delegates_and_returns_child_results() {
    use axum::{Json, Router, extract::State, routing::post};
    use std::sync::{Arc, Mutex};
    async fn complete(
        State(requests): State<Arc<Mutex<Vec<Value>>>>,
        Json(body): Json<Value>,
    ) -> ([(&'static str, &'static str); 1], String) {
        let messages = body["messages"].as_array().unwrap();
        let latest_user = messages
            .iter()
            .rev()
            .find(|m| m["role"] == "user")
            .map(|m| m["content"].to_string())
            .unwrap_or_default();
        let is_child = latest_user.contains("Complete this delegated task independently");
        let is_report = latest_user.contains("Delegated tasks completed");
        let has_tool = messages.iter().any(|m| m["role"] == "tool");
        let text = if is_child {
            Some("Child result.")
        } else if is_report {
            Some("All delegated work completed.")
        } else if has_tool {
            Some("The child is working.")
        } else {
            None
        };
        let delta = if let Some(text) = text {
            json!({"role":"assistant","content":text})
        } else {
            json!({"role":"assistant","tool_calls":[{"index":0,"id":"delegate-1","type":"function","function":{"name":"delegate_task","arguments":"{\"tasks\":[{\"goal\":\"Return a short result\"}]}"}}]})
        };
        requests.lock().unwrap().push(body);
        let data = json!({"id":"delegate-test","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":delta,"finish_reason":null}]});
        let end = json!({"id":"delegate-test","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{},"finish_reason":if text.is_some(){"stop"}else{"tool_calls"}}],"usage":{"prompt_tokens":30,"completion_tokens":10,"total_tokens":40}});
        (
            [("content-type", "text/event-stream")],
            format!("data: {data}\n\ndata: {end}\n\ndata: [DONE]\n\n"),
        )
    }
    let requests = Arc::new(Mutex::new(vec![]));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = Router::new()
        .route("/v1/chat/completions", post(complete))
        .with_state(requests.clone());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let home = setup();
    fs::write(home.path().join("profiles/owl/config.yaml"),format!("model:\n  provider: lmstudio\n  default: test-model\n  api_key: test-key\n  base_url: http://{address}/v1\ntools:\n  enabled_toolsets: [delegation]\n")).unwrap();
    db::open(home.path())
        .unwrap()
        .execute(
            "INSERT INTO settings(key,value) VALUES('approval_mode',?)",
            [json!("off").to_string()],
        )
        .unwrap();
    let hub = EventHub::new();
    let mut events = hub.subscribe();
    let executable = PathBuf::from(std::env::var_os("HEXBOT_TEST_PI").unwrap());
    let runtime = Runtime::new(home.path().into(), hub, executable).unwrap();
    let opened = open(&runtime, "alice").await;
    let live = &opened["section"]["live_session_id"];
    // Raising the bot's level now must not reach the open section's delegates.
    fs::write(home.path().join("profiles/owl/config.yaml"),format!("model:\n  provider: lmstudio\n  default: test-model\n  api_key: test-key\n  base_url: http://{address}/v1\n  reasoning_effort: high\ntools:\n  enabled_toolsets: [delegation]\n")).unwrap();
    runtime
        .call(
            "alice",
            "prompt.submit",
            &json!({"session_id":live,"text":"Delegate a short task."}),
        )
        .await
        .unwrap()
        .unwrap();
    tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            let event = events.recv().await.unwrap();
            if event.frame["params"]["type"] == "message.complete"
                && event.frame["params"]["payload"]["text"] == "All delegated work completed."
            {
                break;
            }
        }
    })
    .await
    .unwrap();
    let history = runtime_store::history(home.path(), "section-a").unwrap();
    assert!(
        history
            .iter()
            .any(|m| m["text"].as_str().unwrap_or("").contains("Child result."))
    );
    assert!(requests.lock().unwrap().len() >= 4);
    let child: String = runtime_store::open(home.path())
        .unwrap()
        .query_row(
            "SELECT options FROM native_sessions WHERE json_extract(options,'$.parent_session')='section-a'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let child: Value = serde_json::from_str(&child).unwrap();
    assert_eq!(child["reasoning_effort"], Value::Null);
    runtime.shutdown().await;
    server.abort();
}

#[tokio::test]
async fn batched_clarification_preserves_remaining_answers_and_model_guard() {
    let home = setup();
    let hub = EventHub::new();
    let mut events = hub.subscribe();
    let runtime = Runtime::new(home.path().into(), hub, fake_pi(home.path())).unwrap();
    let opened = open(&runtime, "alice").await;
    let live = opened["section"]["live_session_id"].clone();
    let guard = runtime
        .call(
            "alice",
            "config.set",
            &json!({"session_id":live,"key":"model","value":"costly"}),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(guard["confirm_required"], true);
    let accepted=runtime.call("alice","config.set",&json!({"session_id":live,"key":"model","value":"costly","confirm_expensive_model":true})).await.unwrap().unwrap();
    assert_eq!(accepted["confirm_required"], false);
    runtime
        .call(
            "alice",
            "prompt.submit",
            &json!({"session_id":live,"text":"batch"}),
        )
        .await
        .unwrap()
        .unwrap();
    let question = next_kind(&mut events, "clarify.request").await;
    assert_eq!(
        question["payload"]["questions"].as_array().unwrap().len(),
        2
    );
    let first=runtime.call("alice","clarify.respond",&json!({"session_id":live,"request_id":"batch-1","question_id":"color","answer":"blue"})).await.unwrap().unwrap();
    assert_eq!(first["remaining"], json!(["shape"]));
    assert!(runtime.call("alice","clarify.respond",&json!({"session_id":live,"request_id":"batch-1","question_id":"color","answer":"red"})).await.unwrap().is_err());
    let reopened = open(&runtime, "alice").await;
    assert_eq!(reopened["pending_clarify"]["answers"]["color"], "blue");
    assert_eq!(
        reopened["pending_clarify"]["questions"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    let final_answer=runtime.call("alice","clarify.respond",&json!({"session_id":live,"request_id":"batch-1","question_id":"shape","answer":"circle"})).await.unwrap().unwrap();
    assert_eq!(final_answer["status"], "answered");
    next_kind(&mut events, "message.complete").await;
    runtime.shutdown().await;
}

fn one_page_pdf() -> Vec<u8> {
    let objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R >>",
        "<< /Length 0 >>\nstream\n\nendstream",
    ];
    let mut pdf = b"%PDF-1.4\n".to_vec();
    let mut offsets = vec![];
    for (i, object) in objects.iter().enumerate() {
        offsets.push(pdf.len());
        pdf.extend_from_slice(format!("{} 0 obj\n{object}\nendobj\n", i + 1).as_bytes());
    }
    let xref = pdf.len();
    pdf.extend_from_slice(b"xref\n0 5\n0000000000 65535 f \n");
    for offset in offsets {
        pdf.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
    }
    pdf.extend_from_slice(
        format!("trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n").as_bytes(),
    );
    pdf
}
#[tokio::test]
async fn pdf_renderer_preserves_images_page_ranges_and_errors() {
    use base64::Engine;
    let home = setup();
    let renderer = home.path().join("pdftoppm.cjs");
    fs::write(&renderer,r#"#!/usr/bin/env node
const fs=require('node:fs');const a=process.argv.slice(2);fs.writeFileSync(__dirname+'/render-args.json',JSON.stringify(a));if(!fs.readFileSync(a[7],'utf8').includes('startxref'))process.exit(1);fs.writeFileSync(a[8]+'-2.png',Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=','base64'));
"#).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&renderer, fs::Permissions::from_mode(0o755)).unwrap();
    }
    fs::write(
        home.path().join("config.yaml"),
        format!("attachments:\n  pdf_renderer: {}\n", renderer.display()),
    )
    .unwrap();
    let runtime = Runtime::new(home.path().into(), EventHub::new(), fake_pi(home.path())).unwrap();
    let opened = open(&runtime, "alice").await;
    let live = opened["section"]["live_session_id"].as_str().unwrap();
    let mut p = json!({"session_id":live,"filename":"paper.pdf","content_base64":base64::engine::general_purpose::STANDARD.encode(one_page_pdf()),"first_page":2,"last_page":2});
    let result = runtime
        .call("alice", "pdf.attach", &p)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(result["pages_attached"], 1);
    assert_eq!(result["pages"][0]["page"], 2);
    let args: Value =
        serde_json::from_slice(&fs::read(home.path().join("render-args.json")).unwrap()).unwrap();
    assert_eq!(
        &args.as_array().unwrap()[..7],
        &json!(["-png", "-r", "150", "-f", "2", "-l", "2"])
            .as_array()
            .unwrap()[..]
    );
    for (first, last, code) in [(0, 1, 4015), (2, 1, 4015), (1, 26, 4019)] {
        p["first_page"] = json!(first);
        p["last_page"] = json!(last);
        assert_eq!(
            runtime
                .call("alice", "pdf.attach", &p)
                .await
                .unwrap()
                .unwrap_err()
                .code,
            code
        );
    }
    fs::write(
        home.path().join("config.yaml"),
        format!(
            "attachments:\n  pdf_renderer: {}\n",
            home.path().join("missing-renderer").display()
        ),
    )
    .unwrap();
    p["first_page"] = json!(1);
    p["last_page"] = json!(1);
    assert_eq!(
        runtime
            .call("alice", "pdf.attach", &p)
            .await
            .unwrap()
            .unwrap_err()
            .code,
        5028
    );
    runtime.shutdown().await;
}

#[tokio::test]
#[ignore = "requires HEXBOT_TEST_PI to the pinned Pi executable"]
async fn actual_pi_acp_stream_cancels_native_permissions() {
    let home = setup();
    fs::write(
        home.path().join("profiles/owl/config.yaml"),
        "model:\n  provider: copilot-acp\n  default: copilot-acp\ntools:\n  enabled_toolsets: []\n",
    )
    .unwrap();
    let server = home.path().join("acp.cjs");
    fs::write(&server,r#"const rl=require('node:readline').createInterface({input:process.stdin});const send=v=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...v})+'\n');let prompt;rl.on('line',line=>{const r=JSON.parse(line);if(r.method==='initialize')send({id:r.id,result:{protocolVersion:1,agentCapabilities:{}}});else if(r.method==='session/new')send({id:r.id,result:{sessionId:'acp'}});else if(r.method==='session/prompt'){prompt=r.id;send({id:77,method:'session/request_permission',params:{sessionId:'acp',toolCall:{title:'Inspect workspace'},options:[{optionId:'yes',kind:'allow_once'},{optionId:'no',kind:'reject_once'}]}});}else if(r.id===77){require('node:fs').writeFileSync(process.cwd()+'/permission.json',JSON.stringify(r.result));send({method:'session/update',params:{sessionId:'acp',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'ACP replied after cancellation'}}}});send({id:prompt,result:{stopReason:'end_turn'}});}});"#).unwrap();
    fs::write(
        home.path().join(".env"),
        format!(
            "HERMES_COPILOT_ACP_COMMAND=node\nHERMES_COPILOT_ACP_ARGS={}\n",
            serde_json::to_string(&format!("'{}'", server.display())).unwrap()
        ),
    )
    .unwrap();
    let hub = EventHub::new();
    let mut events = hub.subscribe();
    let runtime = Runtime::new(
        home.path().into(),
        hub,
        std::env::var_os("HEXBOT_TEST_PI").unwrap().into(),
    )
    .unwrap();
    let opened = open(&runtime, "alice").await;
    let live = opened["section"]["live_session_id"].as_str().unwrap();
    runtime
        .call(
            "alice",
            "prompt.submit",
            &json!({"session_id":live,"text":"Hello ACP"}),
        )
        .await
        .unwrap()
        .unwrap();
    let response = tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            let event = events.recv().await.unwrap();
            let params = &event.frame["params"];
            assert_ne!(params["type"], "approval.request");
            if params["type"] == "message.complete" {
                break params.clone();
            }
        }
    })
    .await
    .unwrap();
    let permission: Value =
        serde_json::from_slice(&fs::read(home.workspace().join("permission.json")).unwrap())
            .unwrap();
    assert!(!home.path().join("permission.json").exists());
    assert_eq!(permission, json!({"outcome":{"outcome":"cancelled"}}));
    assert_eq!(
        response["payload"]["text"],
        "ACP replied after cancellation"
    );
    assert_eq!(response["payload"]["status"], "complete");
    runtime.shutdown().await;
}

#[tokio::test]
async fn rejected_prompt_retains_staged_images_and_file_references() {
    use base64::Engine;
    let home = setup();
    let executable = fake_pi(home.path());
    let source=fs::read_to_string(&executable).unwrap().replace("const c=JSON.parse(line);", "const c=JSON.parse(line);if(c.type==='prompt'&&c.message.startsWith('reject')){emit({type:'response',id:c.id,command:c.type,success:false,error:'Rejected for test'});return;}if(c.type==='prompt')require('node:fs').writeFileSync(__dirname+'/accepted.json',JSON.stringify(c));");
    fs::write(&executable, source).unwrap();
    let hub = EventHub::new();
    let mut events = hub.subscribe();
    let runtime = Runtime::new(home.path().into(), hub, executable).unwrap();
    let opened = open(&runtime, "alice").await;
    let live = opened["section"]["live_session_id"].as_str().unwrap();
    runtime.call("alice","image.attach_bytes",&json!({"session_id":live,"content_base64":base64::engine::general_purpose::STANDARD.encode(b"\x89PNG\r\n\x1a\nfixture"),"filename":"a.png"})).await.unwrap().unwrap();
    let file=runtime.call("alice","file.attach",&json!({"session_id":live,"data_url":"data:text/plain;base64,bm90ZXM=","filename":"notes.txt"})).await.unwrap().unwrap();
    assert!(
        runtime
            .call(
                "alice",
                "prompt.submit",
                &json!({"session_id":live,"text":"reject"})
            )
            .await
            .unwrap()
            .is_err()
    );
    runtime
        .call(
            "alice",
            "prompt.submit",
            &json!({"session_id":live,"text":"accept"}),
        )
        .await
        .unwrap()
        .unwrap();
    next_kind(&mut events, "message.complete").await;
    let accepted: Value =
        serde_json::from_slice(&fs::read(home.path().join("accepted.json")).unwrap()).unwrap();
    assert_eq!(accepted["images"].as_array().unwrap().len(), 1);
    assert!(
        accepted["message"]
            .as_str()
            .unwrap()
            .contains(file["path"].as_str().unwrap())
    );
    assert_eq!(
        runtime_store::history(home.path(), "section-a")
            .unwrap()
            .iter()
            .filter(|r| r["role"] == "user")
            .count(),
        1
    );
    runtime.shutdown().await;
}

#[tokio::test]
#[ignore = "requires HEXBOT_TEST_PI to the pinned Pi executable"]
async fn actual_pi_configured_turn_limit_stops_further_requests() {
    use axum::{Json, Router, extract::State, routing::post};
    use std::sync::{Arc, Mutex};
    async fn complete(
        State(requests): State<Arc<Mutex<Vec<Value>>>>,
        Json(body): Json<Value>,
    ) -> ([(&'static str, &'static str); 1], String) {
        let mut requests = requests.lock().unwrap();
        let number = requests.len();
        requests.push(body);
        let delta = if number == 0 {
            json!({"role":"assistant","tool_calls":[{"index":0,"id":"memory-1","type":"function","function":{"name":"memory","arguments":"{\"action\":\"add\",\"text\":\"The user likes tea.\"}"}}]})
        } else {
            json!({"role":"assistant","content":"I will remember your tea preference."})
        };
        let first = json!({"id":"completion-test","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":delta,"finish_reason":null}]});
        let end = json!({"id":"completion-test","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{},"finish_reason":if number==0{"tool_calls"}else{"stop"}}],"usage":{"prompt_tokens":30,"completion_tokens":10,"total_tokens":40}});
        (
            [("content-type", "text/event-stream")],
            format!("data: {first}\n\ndata: {end}\n\ndata: [DONE]\n\n"),
        )
    }
    let requests = Arc::new(Mutex::new(vec![]));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = Router::new()
        .route("/v1/chat/completions", post(complete))
        .with_state(requests.clone());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let home = setup();
    fs::write(home.path().join("profiles/owl/config.yaml"),format!("model:\n  provider: lmstudio\n  default: test-model\n  api_key: test-key\n  base_url: http://{address}/v1\ntools:\n  enabled_toolsets: []\nagent:\n  max_turns: 1\n")).unwrap();
    let executable = PathBuf::from(std::env::var_os("HEXBOT_TEST_PI").unwrap());
    let runtime = Runtime::new(home.path().into(), EventHub::new(), executable).unwrap();
    let reply = tokio::time::timeout(
        Duration::from_secs(20),
        runtime.run_hidden("alice", "owl", "section-a", "Remember that I like tea."),
    )
    .await
    .unwrap()
    .unwrap_err();
    assert!(
        reply.message.contains("Configured turn limit"),
        "{}",
        reply.message
    );
    assert!(
        fs::read_to_string(home.path().join("profiles/owl/memories/MEMORY.md"))
            .unwrap()
            .contains("tea")
    );
    {
        let requests = requests.lock().unwrap();
        assert_eq!(requests.len(), 1);
        let names = requests[0]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["function"]["name"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert!(names.contains(&"memory"));
        assert!(!names.contains(&"bash"));
        assert!(!names.contains(&"write"));
    }
    runtime.shutdown().await;
    server.abort();
}

#[test]
fn legacy_multi_compaction_deduplicates_display_and_uses_only_tip_context() {
    let home = setup();
    let legacy = rusqlite::Connection::open(home.path().join("profiles/owl/state.db")).unwrap();
    legacy.execute_batch("CREATE TABLE sessions(id TEXT PRIMARY KEY,session_key TEXT,parent_session_id TEXT,end_reason TEXT,model_config TEXT,source TEXT,ended_at REAL,started_at REAL); CREATE TABLE messages(id INTEGER,session_id TEXT,role TEXT,content TEXT,timestamp REAL,active INTEGER,compacted INTEGER,display_kind TEXT);
    INSERT INTO sessions VALUES('root','section-a',NULL,'compression','{}','chat',2,0),('middle','section-a','root','compression','{}','chat',4,2),('tip','section-a','middle',NULL,'{}','chat',NULL,4),('fork','section-b','root',NULL,'{\"_branched_from\":\"root\"}','chat',NULL,8);
    INSERT INTO messages VALUES(1,'root','user','First',1,1,0,'normal'),(2,'middle','user','First',1,1,0,'normal'),(3,'middle','assistant','Middle',3,1,0,'normal'),(4,'tip','user','Latest',5,1,0,'normal'),(5,'fork','user','Private branch',8,1,0,'normal'),(6,'tip','assistant','Compacted in place',4,0,1,'normal'),(7,'tip','user','Rewound',7,0,0,'normal');").unwrap();
    runtime_store::import_hermes(home.path(), "owl", "section-a", home.path()).unwrap();
    let history = runtime_store::history(home.path(), "section-a").unwrap();
    assert_eq!(
        history
            .iter()
            .map(|m| m["text"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["First", "Middle", "Latest", "Compacted in place"]
    );
    let log = fs::read_to_string(
        home.path()
            .join("runtime/sessions/section-a/conversation.jsonl"),
    )
    .unwrap();
    let entries = log
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[1]["message"]["content"], "Latest");
    assert_eq!(
        hexbot_core::catalog::section(home.path(), "alice", "section-a").unwrap()["message_count"],
        history.len()
    );
    runtime_store::import_hermes(home.path(), "owl", "section-b", home.path()).unwrap();
    let branch = runtime_store::history(home.path(), "section-b").unwrap();
    assert_eq!(branch.len(), 1);
    assert_eq!(branch[0]["text"], "Private branch");
}

#[test]
fn summary_uses_first_visible_user_and_invalidates_on_history_changes() {
    let home = setup();
    let text = "界".repeat(61);
    for message in [
        json!({"role":"user","text":"internal","display_kind":"hidden"}),
        json!({"role":"user","text":text}),
        json!({"role":"user","text":"later"}),
    ] {
        runtime_store::append(home.path(), "section-a", message).unwrap();
    }
    let summary = runtime_store::summary(home.path(), "section-a").unwrap();
    assert_eq!(summary["preview"], format!("{}...", "界".repeat(60)));
    assert_eq!(summary["message_count"], 3);
    runtime_store::append(
        home.path(),
        "section-a",
        json!({"role":"assistant","text":"reply"}),
    )
    .unwrap();
    assert_eq!(
        runtime_store::summary(home.path(), "section-a").unwrap()["message_count"],
        4
    );
}

#[tokio::test]
async fn damaged_conversation_is_quarantined_without_blocking_other_sections() {
    let home = setup();
    let conn = runtime_store::open(home.path()).unwrap();
    conn.execute("INSERT INTO native_sessions(stored_id,owner,bot,prompt) VALUES('damaged','alice','owl','')",[]).unwrap();
    let dir = runtime_store::session_dir(home.path(), "damaged").unwrap();
    fs::write(dir.join("conversation.jsonl"), "not a conversation\n").unwrap();
    let runtime = Runtime::new(home.path().into(), EventHub::new(), fake_pi(home.path())).unwrap();
    open(&runtime, "alice").await;
    assert!(!dir.join("conversation.jsonl").exists());
    let backup = fs::read_dir(&dir).unwrap().next().unwrap().unwrap().path();
    assert_eq!(fs::read_to_string(backup).unwrap(), "not a conversation\n");
    assert!(runtime_store::import_hermes(home.path(), "owl", "damaged", home.path()).is_err());
    runtime.shutdown().await;
}

#[tokio::test]
async fn deleting_bot_closes_idle_hidden_processes_too() {
    let home = setup();
    let app = hexbot_core::server::App::new(
        home.path().into(),
        "127.0.0.1:0".parse().unwrap(),
        fake_pi(home.path()),
        None,
    )
    .unwrap();
    app.runtime
        .ensure_hidden("alice", "owl", "hidden-job")
        .await
        .unwrap();
    app.call("alice", "hexbot.bots.delete", &json!({"name":"owl"}))
        .await
        .unwrap();
    let active = app
        .call("alice", "session.active_list", &json!({}))
        .await
        .unwrap();
    assert!(active["sessions"].as_array().unwrap().is_empty());
    assert!(!home.path().join("runtime/sessions/hidden-job").exists());
    app.shutdown().await;
}

#[tokio::test]
async fn a_clean_turn_clears_the_sections_failed_turn() {
    let home = setup();
    hexbot_core::settings::record_incident(
        home.path(),
        "owl",
        "turn_failed",
        "Provider timed out",
        &json!({"section_id":"section-a"}),
    )
    .unwrap();
    let hub = EventHub::new();
    let mut events = hub.subscribe();
    let runtime = Runtime::new(home.path().into(), hub, fake_pi(home.path())).unwrap();
    let live = open(&runtime, "alice").await["section"]["live_session_id"]
        .as_str()
        .unwrap()
        .to_owned();
    runtime
        .call(
            "alice",
            "prompt.submit",
            &json!({"session_id":live,"text":"Hello"}),
        )
        .await
        .unwrap()
        .unwrap();
    // The incident is resolved before the turn reports completion.
    next_kind(&mut events, "message.complete").await;
    let bot = hexbot_core::catalog::call(
        home.path(),
        "alice",
        "hexbot.bots.get",
        &json!({"name":"owl"}),
    )
    .unwrap()
    .unwrap();
    assert_ne!(bot["bot"]["status"], "stopped");
    runtime.shutdown().await;
}

#[tokio::test]
async fn disabled_messaging_and_scheduling_are_not_advertised() {
    let home = setup();
    let runtime = Runtime::new(home.path().into(), EventHub::new(), fake_pi(home.path())).unwrap();
    open(&runtime, "alice").await;
    let options: Value = serde_json::from_slice(
        &fs::read(home.path().join("runtime/sessions/section-a/config.json")).unwrap(),
    )
    .unwrap();
    runtime.shutdown().await;
    let names: Vec<_> = options["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    assert!(
        !names.contains(&"message_bot") && !names.contains(&"cronjob_manage"),
        "Disabled tools remain available: {names:?}"
    );
}

#[tokio::test]
async fn python_uses_the_section_working_directory() {
    let home = setup();
    fs::write(
        home.path().join("profiles/owl/config.yaml"),
        "tools:\n  enabled_toolsets: [code_execution]\n",
    )
    .unwrap();
    let workspace = home.workspace();
    fs::create_dir_all(&workspace).unwrap();
    let executable = fake_pi(home.path());
    let source = fs::read_to_string(&executable).unwrap().replace(
        "const rl=",
        "require('node:fs').writeFileSync('shared.txt', 'same directory');\nconst rl=",
    );
    fs::write(&executable, source).unwrap();
    let runtime = Runtime::new(home.path().into(), EventHub::new(), executable).unwrap();
    open(&runtime, "alice").await;
    let options: Value = serde_json::from_slice(
        &fs::read(home.path().join("runtime/sessions/section-a/config.json")).unwrap(),
    )
    .unwrap();
    let pi_cwd = std::path::Path::new(options["cwd"].as_str().unwrap());
    assert_eq!(
        fs::read_to_string(pi_cwd.join("shared.txt")).unwrap(),
        "same directory"
    );
    let result = hexbot_core::native_tools::call(home.path(), "alice", "owl", "section-a", "execute_code", &json!({"code":"import os\nassert open('shared.txt').read() == 'same directory'\nprint(os.getcwd())"})).await.unwrap();
    runtime.shutdown().await;
    hexbot_core::native_tools::close_session(home.path(), "section-a").await;
    assert_eq!(
        result["output"].as_str().unwrap().trim(),
        workspace.canonicalize().unwrap().to_str().unwrap(),
        "Python tools ignored the configured section workspace"
    );
}

#[test]
fn legacy_compression_chain_keeps_all_display_history() {
    let home = setup();
    let legacy = rusqlite::Connection::open(home.path().join("profiles/owl/state.db")).unwrap();
    legacy.execute_batch("CREATE TABLE sessions(id TEXT PRIMARY KEY,session_key TEXT,parent_session_id TEXT); CREATE TABLE messages(id INTEGER,session_id TEXT,role TEXT,content TEXT,timestamp REAL,active INTEGER,display_kind TEXT); INSERT INTO sessions VALUES('old-root','section-a',NULL),('new-tip','section-a','old-root'); INSERT INTO messages VALUES(1,'old-root','user','Before compaction',100,1,'normal'),(2,'new-tip','user','After compaction',200,1,'normal');").unwrap();
    runtime_store::import_hermes(home.path(), "owl", "section-a", home.path()).unwrap();
    let history = runtime_store::history(home.path(), "section-a").unwrap();
    assert_eq!(
        history.len(),
        2,
        "Migration lost one compression segment: {history:?}"
    );
}

#[tokio::test]
async fn section_close_releases_the_live_session() {
    let home = setup();
    let app = hexbot_core::server::App::new(
        home.path().into(),
        "127.0.0.1:0".parse().unwrap(),
        fake_pi(home.path()),
        None,
    )
    .unwrap();
    app.call("alice", "hexbot.sections.open", &json!({"id":"section-a"}))
        .await
        .unwrap();
    app.call("alice", "hexbot.sections.close", &json!({"id":"section-a"}))
        .await
        .unwrap();
    let remaining = app
        .call("alice", "session.active_list", &json!({}))
        .await
        .unwrap();
    app.shutdown().await;
    assert_eq!(
        remaining["sessions"].as_array().unwrap().len(),
        0,
        "Closed section kept a live Pi session"
    );
}

#[tokio::test]
async fn deleting_section_removes_delegated_transcripts() {
    let home = setup();
    let app = hexbot_core::server::App::new(
        home.path().into(),
        "127.0.0.1:0".parse().unwrap(),
        fake_pi(home.path()),
        None,
    )
    .unwrap();
    let dir = runtime_store::session_dir(home.path(), "child-a").unwrap();
    fs::write(dir.join("conversation.jsonl"), "private delegated work").unwrap();
    runtime_store::open(home.path()).unwrap().execute("INSERT INTO native_sessions(stored_id,owner,bot,prompt,options) VALUES('child-a','alice','owl','private prompt',?)", [json!({"parent_session":"section-a"}).to_string()]).unwrap();
    app.call(
        "alice",
        "hexbot.sections.delete",
        &json!({"id":"section-a"}),
    )
    .await
    .unwrap();
    app.shutdown().await;
    assert!(
        !dir.exists(),
        "Deleting a section retained its delegated transcript"
    );
}

#[tokio::test]
#[ignore = "requires HEXBOT_TEST_PI to the pinned Pi executable"]
async fn actual_pi_generates_descriptions_and_messages_a_private_teammate() {
    use axum::{Json, Router, extract::State, routing::post};
    use std::sync::{Arc, Mutex};
    async fn complete(
        State(requests): State<Arc<Mutex<Vec<Value>>>>,
        Json(body): Json<Value>,
    ) -> ([(&'static str, &'static str); 1], String) {
        let messages = body["messages"].as_array().unwrap();
        let description = messages.iter().any(|m| {
            m.to_string()
                .contains(hexbot_core::team::DESCRIPTION_PROMPT)
        });
        let receiver = messages
            .iter()
            .any(|m| m["role"] == "user" && m.to_string().contains("@owl:"));
        let has_tool = messages.iter().any(|m| m["role"] == "tool");
        let text = if description {
            Some("Cat reviews code and checks plans.")
        } else if receiver {
            Some("Add a rollback to the plan.")
        } else if has_tool {
            Some("Cat helped review the plan. Add a rollback.")
        } else {
            None
        };
        let delta = if let Some(text) = text {
            json!({"role":"assistant","content":text})
        } else {
            json!({"role":"assistant","tool_calls":[{"index":0,"id":"team-1","type":"function","function":{"name":"message_bot","arguments":"{\"to\":\"cat\",\"text\":\"Review the plan\"}"}}]})
        };
        requests.lock().unwrap().push(body);
        let data = json!({"id":"team-test","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":delta,"finish_reason":null}]});
        let end = json!({"id":"team-test","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{},"finish_reason":if text.is_some(){"stop"}else{"tool_calls"}}],"usage":{"prompt_tokens":30,"completion_tokens":10,"total_tokens":40}});
        (
            [("content-type", "text/event-stream")],
            format!("data: {data}\n\ndata: {end}\n\ndata: [DONE]\n\n"),
        )
    }
    let requests = Arc::new(Mutex::new(vec![]));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = Router::new()
        .route("/v1/chat/completions", post(complete))
        .with_state(requests.clone());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let home = setup();
    let h = home.path();
    db::open(h).unwrap().execute_batch("UPDATE bots SET description='Owl implements plans'; INSERT INTO bots(name,owner_id,display_name,title) VALUES('cat','alice','Cat','Reviewer');").unwrap();
    fs::create_dir_all(h.join("profiles/cat")).unwrap();
    for (bot, tools) in [("owl", "hexbot"), ("cat", "")] {
        fs::write(h.join("profiles").join(bot).join("config.yaml"), format!("model:\n  provider: lmstudio\n  default: test-model\n  api_key: test-key\n  base_url: http://{address}/v1\ntools:\n  enabled_toolsets: [{tools}]\n")).unwrap();
    }
    let runtime = Runtime::new(
        h.into(),
        EventHub::new(),
        PathBuf::from(std::env::var_os("HEXBOT_TEST_PI").unwrap()),
    )
    .unwrap();
    tokio::time::timeout(Duration::from_secs(20), runtime.refresh_description("cat"))
        .await
        .unwrap();
    assert_eq!(
        db::open(h)
            .unwrap()
            .query_row(
                "SELECT auto_description FROM bots WHERE name='cat'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
        "Cat reviews code and checks plans."
    );
    let reply = tokio::time::timeout(
        Duration::from_secs(30),
        runtime.run_hidden("alice", "owl", "section-a", "Ask cat to review the plan."),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(reply, "Cat helped review the plan. Add a rollback.");
    let thread = hexbot_core::catalog::call(
        h,
        "alice",
        "hexbot.sections.thread",
        &json!({"bot":"cat","peer":"owl"}),
    )
    .unwrap()
    .unwrap();
    let id = thread["section"]["id"].as_str().unwrap();
    let rows = runtime_store::history(h, "section-a").unwrap();
    let tool = rows.iter().find(|m| m["role"] == "tool").unwrap();
    assert!(tool["text"].as_str().unwrap().contains(id));
    assert!(tool["text"].as_str().unwrap().contains("section_id"));
    let opened = runtime
        .call("alice", "hexbot.sections.open", &json!({"id":id}))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(opened["messages"][0]["text"], "@owl: Review the plan");
    assert_eq!(opened["messages"][0]["display_kind"], "hidden");
    assert!(
        hexbot_core::dreaming::build_digest(h, "owl", 0., f64::MAX, None)
            .unwrap()
            .to_string()
            .contains("tool: ")
    );
    assert!(
        hexbot_core::dreaming::build_digest(h, "cat", 0., f64::MAX, None)
            .unwrap()
            .to_string()
            .contains("@owl: Review the plan")
    );
    {
        let requests = requests.lock().unwrap();
        assert!(requests[0]["tools"].as_array().is_none_or(Vec::is_empty));
        assert!(
            requests[1]["messages"]
                .to_string()
                .contains("Cat reviews code and checks plans.")
        );
    }
    runtime.shutdown().await;
    server.abort();
}

#[tokio::test]
async fn deleting_a_bot_stops_the_threads_where_it_asked_others() {
    let home = setup();
    let h = home.path();
    db::open(h).unwrap().execute_batch("INSERT INTO bots(name,owner_id) VALUES('cat','alice'); INSERT INTO sections(id,bot,owner_id,title,peer_bot,created_at,updated_at) VALUES('asked','cat','alice','From Owl','owl',0,0);").unwrap();
    fs::create_dir_all(h.join("profiles/cat")).unwrap();
    fs::write(
        h.join("profiles/cat/config.yaml"),
        "model:\n  provider: openai\n  default: test-model\ntools:\n  enabled_toolsets: []\n",
    )
    .unwrap();
    let app =
        hexbot_core::server::App::new(h.into(), "127.0.0.1:0".parse().unwrap(), fake_pi(h), None)
            .unwrap();
    // Cat is still answering Owl, which asked without waiting.
    app.runtime
        .ensure_hidden("alice", "cat", "asked")
        .await
        .unwrap();
    app.call("alice", "hexbot.bots.delete", &json!({"name":"owl"}))
        .await
        .unwrap();
    let active = app
        .call("alice", "session.active_list", &json!({}))
        .await
        .unwrap();
    assert!(active["sessions"].as_array().unwrap().is_empty());
    let archived: Option<f64> = db::open(h)
        .unwrap()
        .query_row(
            "SELECT archived_at FROM sections WHERE id='asked'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(archived.is_some());
    app.shutdown().await;
}
