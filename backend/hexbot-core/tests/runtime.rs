use hexbot_core::{db, events::EventHub, runtime::Runtime, runtime_store};
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
    time::Duration,
};
#[path = "support/chat_migration.rs"]
mod chat_migration;
#[path = "support/preflight_pi.rs"]
mod preflight_pi;
#[path = "support/stop_pi.rs"]
mod stop_pi;
mod support;
#[path = "support/transcript_identity.rs"]
mod transcript_identity;

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
if(c.type==='prompt'){emit({type:'agent_start'});emit({type:'message_end',message:{role:'user',content:c.message}});if(c.message==='approval'){emit({type:'extension_ui_request',id:'approval-1',method:'select',title:'__HEXBOT_APPROVAL__'+JSON.stringify({tool:'bash',command:'pwd',reason:'Run command'}),options:['once','session','deny']});}else if(c.message==='batch'){emit({type:'extension_ui_request',id:'batch-1',method:'input',title:'__HEXBOT_CLARIFY__'+JSON.stringify({questions:[{qid:'color',question:'Color?',choices:['red','blue']},{qid:'shape',question:'Shape?'}]})});}else if(c.message==='waiting'){}else if(c.message==='streaming'){pending='streaming';}else if(c.message==='fail'){emit({type:'message_end',message:{role:'assistant',content:[],model:'test-model',provider:'test',stopReason:'error',errorMessage:'Provider down'}});emit({type:'agent_end'});emit({type:'agent_settled'});}else complete('Reply: '+c.message);}
if(c.type==='abort'){if(pending==='streaming'){pending=undefined;emit({type:'message_end',message:{role:'assistant',content:[],model:'test-model',provider:'test',stopReason:'aborted'}});}emit({type:'agent_settled'});}
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
/// Every client of the owner learns that a card was answered or that the bot
/// stopped waiting on it, and a read lists only the cards still waiting.
#[tokio::test]
async fn cards_settle_for_every_client_and_reads_list_what_still_waits() {
    let home = setup();
    let hub = EventHub::new();
    let mut events = hub.subscribe();
    let runtime = Runtime::new(home.path().into(), hub, fake_pi(home.path())).unwrap();
    let live = open(&runtime, "alice").await["section"]["live_session_id"].clone();
    let call = async |method: &str, params: Value| {
        let mut params = params;
        params["session_id"] = live.clone();
        runtime
            .call("alice", method, &params)
            .await
            .unwrap()
            .unwrap()
    };

    call("prompt.submit", json!({"text":"approval"})).await;
    next_kind(&mut events, "approval.request").await;
    let opened = open(&runtime, "alice").await;
    assert_eq!(opened["busy"], true);
    assert_eq!(opened["pending_requests"], json!(["approval-1"]));
    let delta = runtime
        .call(
            "alice",
            "hexbot.sections.open",
            &json!({"id":"section-a","history_cursor":opened["history_cursor"]}),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(delta["history_delta"], true);
    assert_eq!(delta["messages"], json!([]));
    assert_eq!(delta["busy"], true);
    assert_eq!(delta["pending_requests"], json!(["approval-1"]));
    call(
        "approval.respond",
        json!({"request_id":"approval-1","choice":"once"}),
    )
    .await;
    let resolved = next_kind(&mut events, "approval.resolved").await;
    assert_eq!(resolved["session_id"], live);
    assert_eq!(resolved["payload"]["request_id"], "approval-1");
    assert_eq!(resolved["payload"]["choice"], "once");
    assert_eq!(resolved["payload"]["section_id"], "section-a");
    assert_eq!(
        next_kind(&mut events, "hexbot.bots.changed").await["payload"]["name"],
        "owl"
    );
    next_kind(&mut events, "message.complete").await;

    // A batch settles once its last question is answered, with every answer.
    call("prompt.submit", json!({"text":"batch"})).await;
    next_kind(&mut events, "clarify.request").await;
    let answer = async |question: &str, answer: &str| {
        call(
            "clarify.respond",
            json!({"request_id":"batch-1","question_id":question,"answer":answer}),
        )
        .await
    };
    assert_eq!(answer("color", "blue").await["status"], "waiting");
    assert_eq!(answer("shape", "circle").await["status"], "answered");
    let resolved = next_kind(&mut events, "clarify.resolved").await;
    assert_eq!(resolved["payload"]["request_id"], "batch-1");
    assert_eq!(
        resolved["payload"]["answers"],
        json!({"color":"blue","shape":"circle"})
    );
    next_kind(&mut events, "message.complete").await;

    // Stop ends the wait without an answer.
    call("prompt.submit", json!({"text":"approval"})).await;
    next_kind(&mut events, "approval.request").await;
    call("session.interrupt", json!({})).await;
    // Settled once, even when the turn ends while Stop runs.
    let expired = tokio::time::timeout(Duration::from_secs(5), async {
        let mut expired = vec![];
        loop {
            let params = events.recv().await.unwrap().frame["params"].clone();
            match params["type"].as_str() {
                Some("approval.expire") => expired.push(params["payload"]["request_id"].clone()),
                Some("message.complete") => break expired,
                _ => {}
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(expired, ["approval-1"]);
    let opened = open(&runtime, "alice").await;
    assert_eq!(opened["busy"], false);
    assert_eq!(opened["pending_requests"], json!([]));
    runtime.shutdown().await;
}
#[test]
fn imports_legacy_messages_once_and_preserves_hidden_and_tool_rows() {
    let home = setup();
    let conn = rusqlite::Connection::open(home.path().join("profiles/owl/state.db")).unwrap();
    conn.execute_batch("CREATE TABLE sessions(id TEXT,session_key TEXT);CREATE TABLE messages(id INTEGER,session_id TEXT,role TEXT,content TEXT,tool_call_id TEXT,tool_calls TEXT,tool_name TEXT,timestamp REAL,active INTEGER,display_kind TEXT);INSERT INTO sessions VALUES('legacy','section-a');INSERT INTO messages VALUES(1,'legacy','user','secret kickoff',NULL,NULL,NULL,100,1,'hidden');INSERT INTO messages VALUES(2,'legacy','assistant','Calling',NULL,'[{\"id\":\"t1\",\"function\":{\"name\":\"read\",\"arguments\":\"{}\"}}]',NULL,101,1,NULL);INSERT INTO messages VALUES(3,'legacy','tool','Contents','t1',NULL,'read',102,1,NULL);").unwrap();
    // A dream report posted before the chat was first opened follows its history.
    runtime_store::append(
        home.path(),
        "section-a",
        json!({"role":"assistant","text":"Last night","dream":true,"timestamp":200}),
    )
    .unwrap();
    runtime_store::import_hermes(home.path(), "owl", "section-a", home.path()).unwrap();
    runtime_store::import_hermes(home.path(), "owl", "section-a", home.path()).unwrap();
    let messages = runtime_store::history(home.path(), "section-a").unwrap();
    assert_eq!(messages.len(), 4);
    assert_eq!(messages[3]["dream"], true);
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
async fn actual_pi_resumes_accepted_input_after_stop_before_new_owner_input() {
    use axum::{Json, Router, extract::State, routing::post};
    use std::sync::Arc;
    #[derive(Clone)]
    struct Provider {
        requests: tokio::sync::mpsc::UnboundedSender<Value>,
        release: Arc<tokio::sync::Semaphore>,
    }
    async fn complete(
        State(provider): State<Provider>,
        Json(body): Json<Value>,
    ) -> ([(&'static str, &'static str); 1], String) {
        provider.requests.send(body.clone()).unwrap();
        let content = body["messages"]
            .as_array()
            .unwrap()
            .iter()
            .rev()
            .find(|m| m["role"] == "user")
            .unwrap()["content"]
            .clone();
        if runtime_store::text(&content) == "block" {
            let _permit = provider.release.acquire().await.unwrap();
        }
        let chunk = json!({"id":"stop-fixture","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{"role":"assistant","content":"finished"},"finish_reason":null}]});
        let end = json!({"id":"stop-fixture","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]});
        (
            [("content-type", "text/event-stream")],
            format!("data: {chunk}\n\ndata: {end}\n\ndata: [DONE]\n\n"),
        )
    }
    let (requests, mut received) = tokio::sync::mpsc::unbounded_channel();
    let release = Arc::new(tokio::sync::Semaphore::new(0));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = Router::new()
        .route("/v1/chat/completions", post(complete))
        .with_state(Provider {
            requests,
            release: release.clone(),
        });
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let home = setup();
    fs::write(home.path().join("profiles/owl/config.yaml"), format!("model:\n  provider: lmstudio\n  default: test-model\n  api_key: test-key\n  base_url: http://{address}/v1\ntools:\n  enabled_toolsets: []\n")).unwrap();
    let hub = EventHub::new();
    let mut events = hub.subscribe();
    let runtime = Runtime::new(
        home.path().into(),
        hub,
        PathBuf::from(std::env::var_os("HEXBOT_TEST_PI").unwrap()),
    )
    .unwrap();
    let opened = open(&runtime, "alice").await;
    let live = &opened["section"]["live_session_id"];
    // Idle Pi emits no agent_settled on abort. The next owner prompt must
    // wait for the empty recovery handoff rather than fail as busy.
    runtime
        .call("alice", "session.interrupt", &json!({"session_id":live}))
        .await
        .unwrap()
        .unwrap();
    runtime
        .call(
            "alice",
            "prompt.submit",
            &json!({"session_id":live,"text":"block"}),
        )
        .await
        .unwrap()
        .unwrap();
    let first = tokio::time::timeout(Duration::from_secs(20), received.recv())
        .await
        .unwrap()
        .unwrap();
    runtime.call("alice", "prompt.submit", &json!({"session_id":live,"text":"accepted result","queued":true,"display_kind":"hidden"})).await.unwrap().unwrap();
    runtime
        .call("alice", "session.interrupt", &json!({"session_id":live}))
        .await
        .unwrap()
        .unwrap();
    let second = tokio::time::timeout(Duration::from_secs(20), received.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        runtime_store::text(&second["messages"].as_array().unwrap().last().unwrap()["content"]),
        "accepted result"
    );
    // The cached prefix and frozen tool declarations survive recovery.
    assert_eq!(first["messages"][0], second["messages"][0]);
    assert_eq!(first["tools"], second["tools"]);
    tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            let event = events.recv().await.unwrap();
            if event.frame["params"]["type"] == "message.complete"
                && event.frame["params"]["payload"]["text"] == "finished"
            {
                break;
            }
        }
    })
    .await
    .unwrap();
    let history = runtime_store::history(home.path(), "section-a").unwrap();
    let rows = history
        .iter()
        .filter(|r| r["role"] == "user" && r["text"] == "accepted result")
        .collect::<Vec<_>>();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["display_kind"], "hidden");
    runtime
        .call(
            "alice",
            "prompt.submit",
            &json!({"session_id":live,"text":"new owner input"}),
        )
        .await
        .unwrap()
        .unwrap();
    let third = tokio::time::timeout(Duration::from_secs(20), received.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        runtime_store::text(&third["messages"].as_array().unwrap().last().unwrap()["content"]),
        "new owner input"
    );
    assert_eq!(
        third["messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter(
                |m| m["role"] == "user" && runtime_store::text(&m["content"]) == "accepted result"
            )
            .count(),
        1
    );
    release.add_permits(1);
    runtime.shutdown().await;
    server.abort();
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
async fn actual_pi_todo_and_fallback_reminders_do_not_block_dreams() {
    use axum::{
        Json, Router,
        extract::State,
        response::{IntoResponse, Response},
        routing::post,
    };
    use hexbot_core::{
        catalog, common,
        dreaming::{self, Dreaming},
    };
    use std::sync::{Arc, Mutex};
    const SPEECH: &str = "native dialogue the dream must learn";
    type Requests = Arc<Mutex<Vec<Value>>>;
    // The primary model fails the turn that carries SPEECH once, so Hexbot's
    // extension hands that chat to the fallback model.
    async fn complete(State(requests): State<Requests>, Json(body): Json<Value>) -> Response {
        let fail = {
            let mut requests = requests.lock().unwrap();
            let fail = body["model"] == "primary"
                && body.to_string().contains(SPEECH)
                && !requests.iter().any(|r| r.to_string().contains(SPEECH));
            requests.push(body.clone());
            fail
        };
        if fail {
            return (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error":{"message":"primary is unavailable","type":"server_error"}})),
            )
                .into_response();
        }
        let data = json!({"id":"r","object":"chat.completion.chunk","created":1,"model":body["model"],"choices":[{"index":0,"delta":{"role":"assistant","content":"Reply from the fixture"},"finish_reason":"stop"}]});
        (
            [("content-type", "text/event-stream")],
            format!("data: {data}\n\ndata: [DONE]\n\n"),
        )
            .into_response()
    }
    async fn wait(
        events: &mut tokio::sync::broadcast::Receiver<hexbot_core::events::Event>,
        kind: &str,
        payload: impl Fn(&Value) -> bool,
    ) -> Value {
        tokio::time::timeout(Duration::from_secs(25), async {
            loop {
                let event = events.recv().await.unwrap();
                if event.frame["params"]["type"] == kind
                    && payload(&event.frame["params"]["payload"])
                {
                    return event.frame["params"]["payload"].clone();
                }
            }
        })
        .await
        .unwrap()
    }
    let executable = PathBuf::from(std::env::var_os("HEXBOT_TEST_PI").unwrap());
    // A manual dream while the chat runs, and a scheduled dream after its
    // process retired without recovery.
    for scheduled in [false, true] {
        let requests = Requests::default();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = Router::new()
            .route("/v1/chat/completions", post(complete))
            .with_state(requests.clone());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let home = setup();
        let h = home.path();
        fs::write(h.join("profiles/owl/config.yaml"),format!("model:\n  provider: lmstudio\n  default: primary\n  api_key: test-key\n  base_url: http://{address}/v1\ntools:\n  enabled_toolsets: []\n")).unwrap();
        let conn = db::open(h).unwrap();
        for (key, value) in [
            ("fallback_model", json!("lmstudio/fallback")),
            (
                "dream_time",
                json!(chrono::Local::now().format("%H:%M").to_string()),
            ),
        ] {
            conn.execute(
                "INSERT INTO settings(key,value) VALUES(?,?)",
                [key.to_owned(), value.to_string()],
            )
            .unwrap();
        }
        fs::create_dir_all(h.join("profiles/owl/pi")).unwrap();
        fs::write(
            h.join("profiles/owl/pi/settings.json"),
            "{\"retry\":{\"enabled\":false}}",
        )
        .unwrap();
        fs::create_dir_all(h.join("profiles/owl/memories/notes")).unwrap();
        fs::write(
            h.join("profiles/owl/memories/notes")
                .join(format!("{}.md", chrono::Local::now().format("%Y-%m-%d"))),
            "daily note",
        )
        .unwrap();
        dreaming::propose_memory(
            h,
            "alice",
            "owl",
            "job",
            "add",
            &json!({"text":"pending proposal"}),
        )
        .unwrap();
        let hub = EventHub::new();
        let mut events = hub.subscribe();
        let runtime = Runtime::new(h.into(), hub.clone(), executable.clone()).unwrap();
        let chat = catalog::chat_section(h, "alice", "owl").unwrap();
        let id = chat["id"].as_str().unwrap().to_owned();
        let opened = runtime
            .call("alice", "hexbot.sections.open", &json!({"id":id}))
            .await
            .unwrap()
            .unwrap();
        let live = opened["section"]["live_session_id"].clone();
        let dir = runtime_store::session_dir(h, &id).unwrap();
        // A pending todo makes the extension restate the list after Pi's
        // automatic compaction. The large turn crosses the default window, so
        // Pi summarizes the turn before it.
        fs::write(dir.join("todo.json"),json!({"todos":[{"id":"1","content":"finish the quarterly report","status":"pending"}],"revision":1}).to_string()).unwrap();
        for text in [
            "an earlier turn for Pi to summarize".to_owned(),
            format!(
                "a long turn before compaction {}",
                "long context ".repeat(12000)
            ),
            SPEECH.to_owned(),
        ] {
            runtime
                .call(
                    "alice",
                    "prompt.submit",
                    &json!({"session_id":live,"text":text}),
                )
                .await
                .unwrap()
                .unwrap();
            wait(&mut events, "status.update", |p| p["kind"] == "idle").await;
        }
        if scheduled {
            runtime.close_stored("alice", &id).await.unwrap();
        }
        let raw = dir.join("conversation.jsonl");
        let original = fs::read(&raw).unwrap();
        let entries = String::from_utf8_lossy(&original)
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .collect::<Vec<_>>();
        let reminders = |entries: &[Value]| {
            entries
                .iter()
                .filter(|e| e["type"] == "custom_message" && e["display"] == false)
                .map(|e| e["customType"].as_str().unwrap().to_owned())
                .collect::<Vec<_>>()
        };
        assert!(entries.iter().any(|e| e["type"] == "compaction"));
        assert_eq!(reminders(&entries), ["hexbot_todo", "hexbot_fallback"]);
        let native = runtime_store::open(h).unwrap();
        let journaled = || {
            native
                .query_row(
                    "SELECT count(*) FROM native_pi_journal WHERE session_id=? AND json_extract(raw_json,'$.role')='custom'",
                    [&id],
                    |r| r.get::<_, i64>(0),
                )
                .unwrap()
        };
        // The runtime journals Pi's custom messages only when it recovers a log.
        assert_eq!(journaled(), 0);
        let frozen = native
            .query_row(
                "SELECT prompt,options FROM native_sessions WHERE stored_id=?",
                [&id],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
            )
            .unwrap();
        let usage = runtime_store::usage(h, &id).unwrap();
        let sent = requests.lock().unwrap().len();
        let dreams = Dreaming::new(h.into(), runtime.clone(), hub);
        if scheduled {
            dreams.tick_at(common::now()).await.unwrap();
        } else {
            dreams
                .call("alice", "hexbot.dreaming.run_now", &json!({"bot":"owl"}))
                .await
                .unwrap()
                .unwrap();
        }
        let changed = wait(&mut events, "hexbot.dreaming.changed", |p| {
            !p["dream"].is_null()
        })
        .await;
        assert_eq!(changed["dream"]["status"], "complete", "{changed}");
        let dream = requests.lock().unwrap()[sent..]
            .iter()
            .map(Value::to_string)
            .filter(|r| r.contains("pending proposal"))
            .collect::<Vec<_>>();
        assert_eq!(dream.len(), 1);
        assert!(dream[0].contains(SPEECH), "{}", dream[0]);
        assert_eq!(
            conn.query_row(
                "SELECT count(*) FROM memory_proposals WHERE consumed_at IS NULL",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
        assert_eq!(fs::read(&raw).unwrap(), original);
        assert_eq!(runtime_store::usage(h, &id).unwrap(), usage);
        assert_eq!(
            native
                .query_row(
                    "SELECT prompt,options FROM native_sessions WHERE stored_id=?",
                    [&id],
                    |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
                )
                .unwrap(),
            frozen
        );
        // Recovery journals both reminders. Neither the user nor the bot said
        // them, so the digest leaves them out as it did while the chat was live.
        runtime.close_stored("alice", &id).await.unwrap();
        runtime
            .call("alice", "hexbot.sections.open", &json!({"id":id}))
            .await
            .unwrap()
            .unwrap();
        runtime.close_stored("alice", &id).await.unwrap();
        assert_eq!(journaled(), 2);
        let digest = dreaming::build_digest(h, "owl", 0., f64::MAX, None)
            .unwrap()
            .to_string();
        assert!(digest.contains(SPEECH), "{digest}");
        assert!(!digest.contains("finish the quarterly report"), "{digest}");
        assert!(!digest.contains("The model service failed"), "{digest}");
        dreams.shutdown().await;
        runtime.shutdown().await;
        server.abort();
    }
}

#[tokio::test]
#[ignore = "requires HEXBOT_TEST_PI to the pinned Pi executable"]
async fn actual_pi_session_search_reads_history_after_normal_compaction() {
    use axum::{Json, Router, routing::post};
    use hexbot_core::{catalog, native_product_tools};
    const EARLIER: &str = "an earlier turn about the zephyr harbor";
    const LATER: &str = "a follow-up about the quokka garden";
    async fn complete(Json(body): Json<Value>) -> ([(&'static str, &'static str); 1], String) {
        let data = json!({"id":"r","object":"chat.completion.chunk","created":1,"model":body["model"],"choices":[{"index":0,"delta":{"role":"assistant","content":"Reply from the fixture"},"finish_reason":"stop"}]});
        (
            [("content-type", "text/event-stream")],
            format!("data: {data}\n\ndata: [DONE]\n\n"),
        )
    }
    async fn recall(h: &Path, id: &str, args: Value) -> Value {
        native_product_tools::call(h, "alice", "owl", id, "session_search", &args)
            .await
            .unwrap()
            .unwrap()
    }
    // Search from the chat itself finds only what Pi summarized; the kept
    // turn and everything after it are already in the bot's context.
    async fn summarized_turn_only(h: &Path, id: &str) {
        let found = recall(h, id, json!({"query":"zephyr"})).await;
        assert_eq!(found["count"], 1, "{found}");
        assert_eq!(found["results"][0]["session_id"], id);
        for current in ["quokka", "long"] {
            assert_eq!(
                recall(h, id, json!({"query":current})).await["count"],
                0,
                "{current}"
            );
        }
        let read = recall(h, id, json!({"session_id":id})).await;
        let said = read["messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|m| m["role"] == "user" || m["role"] == "assistant")
            .map(|m| m["content"].as_str().unwrap().to_owned())
            .collect::<Vec<_>>();
        assert_eq!(said, [EARLIER, "Reply from the fixture"], "{read}");
    }
    let executable = PathBuf::from(std::env::var_os("HEXBOT_TEST_PI").unwrap());
    // Pi's own tool catalog record is enough; a pending todo adds the hidden
    // list the extension restates after compaction.
    for todo in [false, true] {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = Router::new().route("/v1/chat/completions", post(complete));
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let home = setup();
        let h = home.path();
        fs::write(h.join("profiles/owl/config.yaml"),format!("model:\n  provider: lmstudio\n  default: primary\n  api_key: test-key\n  base_url: http://{address}/v1\ntools:\n  enabled_toolsets: [session_search]\n")).unwrap();
        fs::create_dir_all(h.join("profiles/owl/pi")).unwrap();
        fs::write(
            h.join("profiles/owl/pi/settings.json"),
            "{\"retry\":{\"enabled\":false}}",
        )
        .unwrap();
        let hub = EventHub::new();
        let mut events = hub.subscribe();
        let runtime = Runtime::new(h.into(), hub, executable.clone()).unwrap();
        let id = catalog::chat_section(h, "alice", "owl").unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let opened = runtime
            .call("alice", "hexbot.sections.open", &json!({"id":id}))
            .await
            .unwrap()
            .unwrap();
        let live = opened["section"]["live_session_id"].clone();
        let dir = runtime_store::session_dir(h, &id).unwrap();
        if todo {
            fs::write(dir.join("todo.json"),json!({"todos":[{"id":"1","content":"finish the quarterly report","status":"pending"}],"revision":1}).to_string()).unwrap();
        }
        // The large turn crosses the default window, so Pi automatically
        // summarizes the turn before it.
        for text in [
            EARLIER.to_owned(),
            format!(
                "a long turn before compaction {}",
                "long context ".repeat(12000)
            ),
            LATER.to_owned(),
        ] {
            runtime
                .call(
                    "alice",
                    "prompt.submit",
                    &json!({"session_id":live,"text":text}),
                )
                .await
                .unwrap()
                .unwrap();
            tokio::time::timeout(Duration::from_secs(25), async {
                loop {
                    let event = events.recv().await.unwrap();
                    if event.frame["params"]["type"] == "status.update"
                        && event.frame["params"]["payload"]["kind"] == "idle"
                    {
                        break;
                    }
                }
            })
            .await
            .unwrap();
        }
        let raw = dir.join("conversation.jsonl");
        let original = fs::read(&raw).unwrap();
        let entries = String::from_utf8_lossy(&original)
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .collect::<Vec<_>>();
        let compactions = entries
            .iter()
            .filter(|e| e["type"] == "compaction")
            .collect::<Vec<_>>();
        assert_eq!(compactions.len(), 1);
        let kept = entries
            .iter()
            .find(|e| e["id"] == compactions[0]["firstKeptEntryId"])
            .unwrap();
        assert!(runtime_store::text(&kept["message"]["content"]).starts_with("a long turn"));
        assert!(
            entries
                .iter()
                .any(|e| e["type"] == "message" && e["message"]["role"] == "system")
        );
        let notices = entries
            .iter()
            .filter(|e| e["type"] == "custom_message")
            .map(|e| (e["customType"].as_str().unwrap(), e["display"].clone()))
            .collect::<Vec<_>>();
        assert_eq!(
            notices,
            if todo {
                vec![("hexbot_todo", json!(false))]
            } else {
                vec![]
            }
        );
        let native = runtime_store::open(h).unwrap();
        let internal = |role: &str| {
            native
                .query_row(
                    "SELECT count(*) FROM native_pi_journal WHERE session_id=? AND json_extract(raw_json,'$.role')=?",
                    [id.as_str(), role],
                    |r| r.get::<_, i64>(0),
                )
                .unwrap()
        };
        // The live runtime journals neither record.
        assert_eq!((internal("system"), internal("custom")), (0, 0));
        let frozen = || {
            native
                .query_row(
                    "SELECT prompt,options FROM native_sessions WHERE stored_id=?",
                    [&id],
                    |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
                )
                .unwrap()
        };
        let saved = frozen();
        let usage = runtime_store::usage(h, &id).unwrap();
        let history = runtime_store::history(h, &id).unwrap();
        // While Pi still runs the chat, and after its process retires without
        // recovery, search reads the log without changing it or billing.
        summarized_turn_only(h, &id).await;
        runtime.close_stored("alice", &id).await.unwrap();
        summarized_turn_only(h, &id).await;
        assert_eq!(fs::read(&raw).unwrap(), original);
        assert_eq!(frozen(), saved);
        assert_eq!(runtime_store::usage(h, &id).unwrap(), usage);
        assert_eq!(runtime_store::history(h, &id).unwrap(), history);
        assert_eq!((internal("system"), internal("custom")), (0, 0));
        // Recovery journals both as hidden rows; search answers the same.
        runtime
            .call("alice", "hexbot.sections.open", &json!({"id":id}))
            .await
            .unwrap()
            .unwrap();
        runtime.close_stored("alice", &id).await.unwrap();
        assert!(internal("system") > 0);
        assert_eq!(internal("custom"), i64::from(todo));
        summarized_turn_only(h, &id).await;
        assert_eq!(frozen(), saved);
        runtime.shutdown().await;
        server.abort();
    }
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
async fn named_attachments_send_only_those_and_retain_unselected_uploads() {
    let home = setup();
    let executable = fake_pi(home.path());
    let source = fs::read_to_string(&executable).unwrap().replace("const c=JSON.parse(line);", "const c=JSON.parse(line);if(c.type==='prompt')require('node:fs').appendFileSync(__dirname+'/prompts.jsonl',JSON.stringify(c)+'\\n');");
    fs::write(&executable, source).unwrap();
    let hub = EventHub::new();
    let mut events = hub.subscribe();
    let runtime = Runtime::new(home.path().into(), hub, executable).unwrap();
    let opened = open(&runtime, "alice").await;
    let live = opened["section"]["live_session_id"].as_str().unwrap();
    let attach = async |name: &str| {
        runtime
            .call(
                "alice",
                "file.attach",
                &json!({"session_id":live,"data_url":"data:text/plain;base64,bm90ZXM=","name":name}),
            )
            .await
            .unwrap()
            .unwrap()
    };
    let stale = attach("secret.txt").await;
    let kept = attach("report.txt").await;
    assert_ne!(stale["id"], kept["id"]);
    let submit = async |params: Value| {
        runtime
            .call("alice", "prompt.submit", &params)
            .await
            .unwrap()
    };
    // An id that is not staged is refused before anything is sent or dropped.
    assert_eq!(
        submit(json!({"session_id":live,"text":"hi","attachments":["gone"]}))
            .await
            .unwrap_err()
            .code,
        4204
    );
    assert!(Path::new(stale["path"].as_str().unwrap()).exists());
    submit(json!({"session_id":live,"text":"named","attachments":[kept["id"]]}))
        .await
        .unwrap();
    next_kind(&mut events, "message.complete").await;
    assert!(Path::new(stale["path"].as_str().unwrap()).exists());
    assert!(Path::new(kept["path"].as_str().unwrap()).exists());
    // Without a list, every staged upload rides the next prompt as before.
    let later = attach("later.txt").await;
    submit(json!({"session_id":live,"text":"unnamed"}))
        .await
        .unwrap();
    next_kind(&mut events, "message.complete").await;
    let prompts = fs::read_to_string(home.path().join("prompts.jsonl")).unwrap();
    let prompts: Vec<Value> = prompts
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(prompts.len(), 2);
    let named = prompts[0]["message"].as_str().unwrap();
    assert!(named.contains(kept["path"].as_str().unwrap()));
    assert!(!named.contains(stale["path"].as_str().unwrap()));
    assert!(
        prompts[1]["message"]
            .as_str()
            .unwrap()
            .contains(stale["path"].as_str().unwrap())
    );
    assert!(
        !prompts[1]["message"]
            .as_str()
            .unwrap()
            .contains(kept["path"].as_str().unwrap())
    );
    assert!(
        prompts[1]["message"]
            .as_str()
            .unwrap()
            .contains(later["path"].as_str().unwrap())
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
fn summary_previews_the_latest_visible_message_and_follows_history_changes() {
    let home = setup();
    let text = "界".repeat(61);
    for message in [
        json!({"role":"user","text":"earlier"}),
        json!({"role":"user","text":text}),
        json!({"role":"user","text":"internal","display_kind":"hidden"}),
        json!({"role":"assistant","text":"","tool_calls":[{"id":"t1"}]}),
    ] {
        runtime_store::append(home.path(), "section-a", message).unwrap();
    }
    let summary = runtime_store::summary(home.path(), "section-a").unwrap();
    assert_eq!(summary["preview"], format!("{}...", "界".repeat(60)));
    assert_eq!(summary["message_count"], 4);
    runtime_store::append(
        home.path(),
        "section-a",
        json!({"role":"assistant","text":"reply"}),
    )
    .unwrap();
    let summary = runtime_store::summary(home.path(), "section-a").unwrap();
    assert_eq!(summary["message_count"], 5);
    assert_eq!(summary["preview"], "reply");
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
async fn a_retry_clears_stopped_as_soon_as_its_turn_starts() {
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
    let live = open(&runtime, "alice").await["section"]["live_session_id"].clone();
    runtime
        .call(
            "alice",
            "prompt.submit",
            &json!({"session_id":live,"text":"waiting"}),
        )
        .await
        .unwrap()
        .unwrap();
    // The turn is still running; every client reads the bot again.
    next_kind(&mut events, "message.start").await;
    assert_eq!(
        next_kind(&mut events, "hexbot.bots.changed").await["payload"]["name"],
        "owl"
    );
    let bot = hexbot_core::catalog::call(
        home.path(),
        "alice",
        "hexbot.bots.get",
        &json!({"name":"owl"}),
    )
    .unwrap()
    .unwrap();
    assert_ne!(bot["bot"]["status"], "stopped");
    assert_eq!(
        runtime.status_for_bot("alice", "owl").unwrap()["status"],
        "working"
    );
    runtime.shutdown().await;
}
/// Check-ins, jobs, dreams and delegates run where the user cannot see them,
/// so they never make the bot look busy. A background run that asks the user
/// still says so.
#[tokio::test]
async fn background_runs_do_not_mark_the_bot_working() {
    let home = setup();
    let hub = EventHub::new();
    let mut events = hub.subscribe();
    let runtime = Runtime::new(home.path().into(), hub, fake_pi(home.path())).unwrap();
    let job = {
        let runtime = runtime.clone();
        tokio::spawn(async move {
            runtime
                .run_hidden_job("alice", "owl", "heartbeat-1", "waiting", &json!({}))
                .await
        })
    };
    next_kind(&mut events, "message.start").await;
    assert!(
        runtime
            .busy_sections("owl")
            .iter()
            .any(|s| s["id"] == "heartbeat-1")
    );
    assert!(runtime.status_for_bot("alice", "owl").is_none());
    let asking = {
        let runtime = runtime.clone();
        tokio::spawn(async move {
            runtime
                .run_hidden_job("alice", "owl", "cron-1", "approval", &json!({}))
                .await
        })
    };
    next_kind(&mut events, "approval.request").await;
    assert_eq!(
        runtime.status_for_bot("alice", "owl").unwrap()["status"],
        "needs_you"
    );
    runtime.shutdown().await;
    let _ = (job.await, asking.await);
}
/// Only a message from the owner answers a failed turn when it starts, and only
/// that section's private failure. A hidden run (background results, rooms,
/// check-ins) leaves it, and so do room, connector, other-section and other
/// owners' failures. A retry that fails again records a new one.
#[tokio::test]
async fn only_an_owner_message_clears_its_sections_own_failed_turn() {
    let home = setup();
    db::open(home.path())
        .unwrap()
        .execute_batch(
            "INSERT INTO bots(name,owner_id) VALUES('fox','bob');
         INSERT INTO bot_incidents(id,bot,section_id,room_id,kind,connector,text,created_at) VALUES
         ('private','owl','section-a',NULL,'turn_failed',NULL,'Timed out',1),
         ('room','owl','section-a','garden','turn_failed',NULL,'Room failed',1),
         ('connector','owl','section-a',NULL,'connector_error','notion','Token expired',1),
         ('other-section','owl','section-b',NULL,'turn_failed',NULL,'Other',1),
         ('other-owner','fox','section-a',NULL,'turn_failed',NULL,'Not yours',1);",
        )
        .unwrap();
    let open_incidents = || {
        let conn = db::open(home.path()).unwrap();
        let mut query = conn
            .prepare("SELECT id FROM bot_incidents WHERE resolved_at IS NULL ORDER BY id")
            .unwrap();
        query
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .map(Result::unwrap)
            .collect::<Vec<_>>()
    };
    let hub = EventHub::new();
    let mut events = hub.subscribe();
    let runtime = Runtime::new(home.path().into(), hub, fake_pi(home.path())).unwrap();
    let live = open(&runtime, "alice").await["section"]["live_session_id"].clone();
    let call = async |method: &str, params: Value| {
        let mut params = params;
        params["session_id"] = live.clone();
        runtime
            .call("alice", method, &params)
            .await
            .unwrap()
            .unwrap()
    };
    let everything = [
        "connector",
        "other-owner",
        "other-section",
        "private",
        "room",
    ];

    call(
        "prompt.submit",
        json!({"text":"streaming","display_kind":"hidden"}),
    )
    .await;
    next_kind(&mut events, "message.start").await;
    call("session.interrupt", json!({})).await;
    next_kind(&mut events, "message.complete").await;
    assert_eq!(open_incidents(), everything);

    call("prompt.submit", json!({"text":"streaming"})).await;
    next_kind(&mut events, "message.start").await;
    assert_eq!(
        open_incidents(),
        ["connector", "other-owner", "other-section", "room"]
    );
    call("session.interrupt", json!({})).await;
    next_kind(&mut events, "message.complete").await;

    call("prompt.submit", json!({"text":"fail"})).await;
    next_kind(&mut events, "message.complete").await;
    let failed = db::open(home.path())
        .unwrap()
        .query_row(
            "SELECT count(*) FROM bot_incidents WHERE bot='owl' AND section_id='section-a'
             AND kind='turn_failed' AND room_id IS NULL AND resolved_at IS NULL",
            [],
            |row| row.get::<_, i64>(0),
        )
        .unwrap();
    assert_eq!(failed, 1);
    runtime.shutdown().await;
}
/// Pi decides when an owner's input starts a run: an idle steer becomes a
/// prompt, and a queued message can start its own run while an older hidden
/// run settles. Each such start clears Stopped and tells every client.
#[tokio::test]
#[ignore = "requires HEXBOT_TEST_PI to the pinned Pi executable"]
async fn actual_pi_owner_input_clears_stopped_where_pi_starts_it() {
    use axum::{Json, Router, extract::State, routing::post};
    use std::sync::Arc;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    #[derive(Clone)]
    struct Provider {
        requests: tokio::sync::mpsc::UnboundedSender<String>,
        release: Arc<tokio::sync::Semaphore>,
    }
    async fn complete(
        State(provider): State<Provider>,
        Json(body): Json<Value>,
    ) -> axum::response::Response {
        use axum::response::IntoResponse;
        let text = runtime_store::text(
            &body["messages"]
                .as_array()
                .unwrap()
                .iter()
                .rev()
                .find(|m| m["role"] == "user")
                .unwrap()["content"],
        );
        provider.requests.send(text.clone()).unwrap();
        // The background run fails, so its end clears nothing either.
        if text == "background result" {
            let error = json!({"error":{"message":"Bad request","type":"invalid_request_error"}});
            return (axum::http::StatusCode::BAD_REQUEST, Json(error)).into_response();
        }
        if text == "block" {
            provider.release.acquire().await.unwrap().forget();
        }
        let chunk = json!({"id":"owner","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{"role":"assistant","content":"finished"},"finish_reason":null}]});
        let end = json!({"id":"owner","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]});
        (
            [("content-type", "text/event-stream")],
            format!("data: {chunk}\n\ndata: {end}\n\ndata: [DONE]\n\n"),
        )
            .into_response()
    }
    async fn wait<T>(future: impl std::future::Future<Output = T>) -> T {
        tokio::time::timeout(Duration::from_secs(20), future)
            .await
            .unwrap()
    }
    let (requests, mut received) = tokio::sync::mpsc::unbounded_channel();
    let release = Arc::new(tokio::sync::Semaphore::new(0));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = Router::new()
        .route("/v1/chat/completions", post(complete))
        .with_state(Provider {
            requests,
            release: release.clone(),
        });
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let home = setup();
    fs::write(home.path().join("profiles/owl/config.yaml"), format!("model:\n  provider: lmstudio\n  default: test-model\n  api_key: test-key\n  base_url: http://{address}/v1\ntools:\n  enabled_toolsets: []\n")).unwrap();
    // Holds the first run's settlement, so the next input starts while it settles.
    let settled = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let extension = home.path().join("hold-settled.mjs");
    fs::write(
        &extension,
        format!(
            r#"import net from 'node:net';
export default function(pi) {{
  let settlements = 0;
  pi.on('agent_settled', async () => {{
    if (++settlements !== 1) return;
    await new Promise(resolve => {{
      const socket = net.connect({}, '127.0.0.1', () => socket.write('held\n'));
      socket.once('data', () => {{socket.end(); resolve();}});
    }});
  }});
}}
"#,
            settled.local_addr().unwrap().port()
        ),
    )
    .unwrap();
    let executable = home.path().join("owner-pi.sh");
    fs::write(
        &executable,
        format!(
            "#!/bin/sh\nexec '{}' \"$@\" --extension '{}'\n",
            Path::new(&std::env::var_os("HEXBOT_TEST_PI").unwrap()).display(),
            extension.display()
        ),
    )
    .unwrap();
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
    let hub = EventHub::new();
    let mut events = hub.subscribe();
    let runtime = Runtime::new(home.path().into(), hub, executable).unwrap();
    let live = open(&runtime, "alice").await["section"]["live_session_id"].clone();
    let failed = || {
        hexbot_core::settings::record_incident(
            home.path(),
            "owl",
            "turn_failed",
            "Provider timed out",
            &json!({"section_id":"section-a"}),
        )
        .unwrap();
    };
    let stopped = || {
        db::open(home.path())
            .unwrap()
            .query_row(
                "SELECT count(*) FROM bot_incidents WHERE section_id='section-a' AND resolved_at IS NULL",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap()
    };
    // The run's start is announced after its message.start.
    async fn started(
        events: &mut tokio::sync::broadcast::Receiver<hexbot_core::events::Event>,
    ) -> Value {
        next_kind(events, "message.start").await;
        next_kind(events, "hexbot.bots.changed").await
    }

    // A queued owner message that Pi starts while an older hidden run settles.
    failed();
    runtime
        .call(
            "alice",
            "prompt.submit",
            &json!({"session_id":live,"text":"background result","display_kind":"hidden"}),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(started(&mut events).await["payload"]["name"], "owl");
    assert_eq!(wait(received.recv()).await.unwrap(), "background result");
    let (mut hold, _) = wait(settled.accept()).await.unwrap();
    let mut marker = [0; 5];
    hold.read_exact(&mut marker).await.unwrap();
    assert_eq!(stopped(), 1);
    let queued = {
        let (runtime, live) = (runtime.clone(), live.clone());
        tokio::spawn(async move {
            runtime
                .call(
                    "alice",
                    "prompt.submit",
                    &json!({"session_id":live,"text":"block","queued":true}),
                )
                .await
                .unwrap()
                .unwrap()
        })
    };
    hold.write_all(b"release").await.unwrap();
    assert_eq!(wait(received.recv()).await.unwrap(), "block");
    assert_eq!(started(&mut events).await["payload"]["name"], "owl");
    assert_eq!(stopped(), 0);
    wait(queued).await.unwrap();
    release.add_permits(1);
    next_kind(&mut events, "message.complete").await;

    // An owner steer while the bot is idle becomes a prompt of its own.
    failed();
    assert_eq!(stopped(), 1);
    runtime
        .call(
            "alice",
            "session.steer",
            &json!({"session_id":live,"text":"block"}),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(wait(received.recv()).await.unwrap(), "block");
    assert_eq!(started(&mut events).await["payload"]["name"], "owl");
    assert_eq!(stopped(), 0);
    release.add_permits(1);
    runtime.shutdown().await;
    server.abort();
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
async fn a_bot_whose_older_store_cannot_be_read_gets_a_chat_that_opens() {
    let home = setup();
    // Section A was never opened since the native daemon; its history is here.
    let store = home.path().join("profiles/owl/state.db");
    fs::write(&store, "not a database").unwrap();
    let app = hexbot_core::server::App::new(
        home.path().into(),
        "127.0.0.1:0".parse().unwrap(),
        fake_pi(home.path()),
        None,
    )
    .unwrap();
    let open = |id: String| {
        let app = app.clone();
        async move {
            app.call("alice", "hexbot.sections.open", &json!({"id":id}))
                .await
        }
    };
    assert_eq!(open("section-a".into()).await.unwrap_err().code, 5200);
    let chat = app
        .call("alice", "hexbot.sections.create", &json!({"bot":"owl"}))
        .await
        .unwrap()["section"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_ne!(chat, "section-a");
    open(chat.clone()).await.unwrap();
    let again = app
        .call("alice", "hexbot.sections.create", &json!({"bot":"owl"}))
        .await
        .unwrap();
    assert_eq!(again["section"]["id"], chat);
    // Section A stays and opens with its history once the store is repaired.
    fs::remove_file(&store).unwrap();
    rusqlite::Connection::open(&store)
        .unwrap()
        .execute_batch(
            "CREATE TABLE sessions(id TEXT,session_key TEXT);
             CREATE TABLE messages(id INTEGER,session_id TEXT,role TEXT,content TEXT,timestamp REAL);
             INSERT INTO sessions VALUES('section-a','section-a');
             INSERT INTO messages VALUES(1,'section-a','user','Before the upgrade',1);",
        )
        .unwrap();
    let opened = open("section-a".into()).await.unwrap();
    app.shutdown().await;
    assert_eq!(opened["messages"][0]["text"], "Before the upgrade");
}

#[tokio::test]
async fn a_bot_whose_chat_recovery_set_aside_gets_a_new_chat_that_opens() {
    let home = setup();
    // Section A's conversation is damaged; startup recovery sets it aside.
    runtime_store::open(home.path())
        .unwrap()
        .execute(
            "INSERT INTO native_sessions(stored_id,owner,bot,prompt) VALUES('section-a','alice','owl','')",
            [],
        )
        .unwrap();
    let dir = runtime_store::session_dir(home.path(), "section-a").unwrap();
    fs::write(dir.join("conversation.jsonl"), "not a conversation\n").unwrap();
    let app = hexbot_core::server::App::new(
        home.path().into(),
        "127.0.0.1:0".parse().unwrap(),
        fake_pi(home.path()),
        None,
    )
    .unwrap();
    let call = |method: &'static str, params: Value| {
        let app = app.clone();
        async move { app.call("alice", method, &params).await }
    };
    let open = |id: &str| call("hexbot.sections.open", json!({"id":id}));
    assert_eq!(open("section-a").await.unwrap_err().code, 5200);
    let chat = call("hexbot.sections.create", json!({"bot":"owl"}))
        .await
        .unwrap()["section"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_ne!(chat, "section-a");
    // The new chat opens, takes a message and stays the chat.
    let live = open(&chat).await.unwrap()["section"]["live_session_id"].clone();
    call(
        "prompt.submit",
        json!({"session_id":live,"text":"Hello again"}),
    )
    .await
    .unwrap();
    for _ in 0..2 {
        let again = call("hexbot.sections.create", json!({"bot":"owl"}))
            .await
            .unwrap();
        assert_eq!(again["section"]["id"], chat);
        open(&chat).await.unwrap();
    }
    // The damaged conversation stays, set aside for repair.
    assert_eq!(open("section-a").await.unwrap_err().code, 5200);
    let kept = fs::read_dir(&dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect::<Vec<_>>();
    app.shutdown().await;
    assert!(
        kept.iter()
            .any(|name| name.starts_with("conversation.quarantine-")),
        "{kept:?}"
    );
}

#[tokio::test]
async fn unreadable_native_history_falls_back_to_a_chat_that_actually_opens() {
    for healthy in [false, true] {
        let home = setup();
        let conn = db::open(home.path()).unwrap();
        conn.execute("UPDATE sections SET updated_at=9 WHERE id='section-a'", [])
            .unwrap();
        let runtime = runtime_store::open(home.path()).unwrap();
        runtime.execute("INSERT INTO native_sessions(stored_id,owner,bot,prompt) VALUES('section-a','alice','owl','')", []).unwrap();
        runtime_store::append(
            home.path(),
            "section-a",
            json!({"role":"user","text":"Unrecoverable for now","timestamp":9}),
        )
        .unwrap();
        let path = home
            .path()
            .join("runtime/sessions/section-a/conversation.jsonl");
        fs::create_dir_all(&path).unwrap();
        fs::write(path.join("kept"), "repair me").unwrap();
        if healthy {
            conn.execute("INSERT INTO sections(id,bot,owner_id,title,updated_at) VALUES('healthy','owl','alice','Healthy',2)", []).unwrap();
            runtime_store::append(
                home.path(),
                "healthy",
                json!({"role":"user","text":"Healthy conversation","timestamp":2}),
            )
            .unwrap();
        }
        let memories = home.path().join("profiles/owl/memories");
        fs::create_dir_all(memories.join("notes")).unwrap();
        fs::write(memories.join("MEMORY.md"), "Keep my memory").unwrap();
        fs::write(memories.join("notes/2026-10-15.md"), "Keep my notes").unwrap();
        let app = hexbot_core::server::App::new(
            home.path().into(),
            "127.0.0.1:0".parse().unwrap(),
            fake_pi(home.path()),
            None,
        )
        .unwrap();
        let chosen = app
            .call("alice", "hexbot.sections.create", &json!({"bot":"owl"}))
            .await
            .unwrap();
        let id = chosen["section"]["id"].as_str().unwrap();
        assert_ne!(id, "section-a");
        if healthy {
            assert_eq!(id, "healthy");
        }
        let opened = app
            .call("alice", "hexbot.sections.open", &json!({"id":id}))
            .await
            .unwrap();
        assert!(opened["section"]["live_session_id"].is_string());
        assert_eq!(
            app.call("alice", "hexbot.sections.create", &json!({"bot":"owl"}))
                .await
                .unwrap()["section"]["id"],
            id
        );
        assert!(hexbot_core::catalog::section(home.path(), "alice", "section-a").is_ok());
        assert_eq!(fs::read_to_string(path.join("kept")).unwrap(), "repair me");
        assert_eq!(
            fs::read_to_string(memories.join("MEMORY.md")).unwrap(),
            "Keep my memory"
        );
        assert_eq!(
            fs::read_to_string(memories.join("notes/2026-10-15.md")).unwrap(),
            "Keep my notes"
        );
        app.shutdown().await;
    }
}

#[tokio::test]
async fn deleting_peer_thread_removes_delegated_transcripts() {
    let home = setup();
    db::open(home.path()).unwrap().execute_batch("INSERT INTO bots(name,owner_id) VALUES('teammate','alice'); UPDATE sections SET peer_bot='teammate' WHERE id='section-a';").unwrap();
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

/// The real App used to purge native history before attempting its first catalog write.
#[tokio::test]
async fn failed_bot_delete_preserves_native_history_and_profile_across_startup() {
    for table in ["sections", "bots"] {
        let home = setup();
        let h = home.path();
        let pi = fake_pi(h);
        let app = hexbot_core::server::App::new(
            h.into(),
            "127.0.0.1:0".parse().unwrap(),
            pi.clone(),
            None,
        )
        .unwrap();
        open(&app.runtime, "alice").await;
        app.runtime
            .ensure_hidden("alice", "owl", "hidden-job")
            .await
            .unwrap();
        for id in ["section-a", "hidden-job"] {
            runtime_store::append(
                h,
                id,
                json!({"role":"user","text":format!("history of {id}")}),
            )
            .unwrap();
        }
        fs::create_dir_all(h.join("profiles/owl/memories/notes")).unwrap();
        fs::write(h.join("profiles/owl/memories/MEMORY.md"), "memory").unwrap();
        fs::write(h.join("profiles/owl/memories/notes/2026-10-15.md"), "notes").unwrap();
        db::open(h).unwrap().execute_batch(&format!("CREATE TRIGGER stop_delete BEFORE DELETE ON {table} BEGIN SELECT RAISE(ABORT,'controlled catalog stop'); END;")).unwrap();
        let error = app
            .call("alice", "hexbot.bots.delete", &json!({"name":"owl"}))
            .await
            .unwrap_err();
        assert!(error.message.contains("controlled catalog stop"));
        for id in ["section-a", "hidden-job"] {
            assert_eq!(
                runtime_store::history(h, id).unwrap().len(),
                1,
                "history erased before catalog {table} commit: {id}"
            );
        }
        assert_eq!(
            fs::read_to_string(h.join("profiles/owl/memories/MEMORY.md")).unwrap(),
            "memory"
        );
        assert_eq!(
            fs::read_to_string(h.join("profiles/owl/memories/notes/2026-10-15.md")).unwrap(),
            "notes"
        );
        app.shutdown().await;
        db::open(h)
            .unwrap()
            .execute_batch("DROP TRIGGER stop_delete")
            .unwrap();
        let restarted =
            hexbot_core::server::App::new(h.into(), "127.0.0.1:0".parse().unwrap(), pi, None)
                .unwrap();
        assert_eq!(
            open(&restarted.runtime, "alice").await["messages"][0]["text"],
            "history of section-a"
        );
        assert_eq!(runtime_store::history(h, "hidden-job").unwrap().len(), 1);
        restarted.shutdown().await;
    }
}

#[tokio::test]
async fn bot_delete_startup_distinguishes_retirement_from_committed_partial_cleanup() {
    use hexbot_core::catalog;
    for committed in [false, true] {
        let home = setup();
        let h = home.path();
        let pi = fake_pi(h);
        let app = hexbot_core::server::App::new(
            h.into(),
            "127.0.0.1:0".parse().unwrap(),
            pi.clone(),
            None,
        )
        .unwrap();
        open(&app.runtime, "alice").await;
        app.runtime
            .ensure_hidden("alice", "owl", "hidden")
            .await
            .unwrap();
        runtime_store::open(h).unwrap().execute("INSERT INTO native_sessions(stored_id,owner,bot,prompt,options) VALUES('delegate','alice','owl','',?)", [json!({"parent_session":"hidden"}).to_string()]).unwrap();
        db::open(h).unwrap().execute_batch("INSERT INTO rooms(id,owner_id,name) VALUES('room','alice','Room'); INSERT INTO room_sessions VALUES('room','owl','room-history',NULL); INSERT INTO sections(id,bot,owner_id,title) VALUES('legacy-only','owl','alice','Legacy');").unwrap();
        for id in ["section-a", "hidden", "delegate", "room-history"] {
            runtime_store::append(
                h,
                id,
                json!({"role":"user","text":format!("original {id}")}),
            )
            .unwrap();
        }
        let targets = catalog::prepare_bot_delete(h, "alice", "owl").unwrap();
        for target in targets {
            app.runtime
                .retire_stored(
                    target["owner"].as_str().unwrap(),
                    target["id"].as_str().unwrap(),
                )
                .await
                .unwrap();
        }
        if committed {
            // Abort native cleanup after the real atomic catalog commit.
            runtime_store::open(h).unwrap().execute_batch("CREATE TRIGGER stop_purge BEFORE DELETE ON native_messages WHEN OLD.session_id='hidden' BEGIN SELECT RAISE(ABORT,'controlled cleanup stop'); END;").unwrap();
            let result = catalog::call(h, "alice", "hexbot.bots.delete", &json!({"name":"owl"}))
                .unwrap()
                .unwrap();
            assert_eq!(result, json!({"deleted":true,"history_pending":true}));
            assert!(catalog::bot(h, "alice", "owl").is_err());
            assert!(runtime_store::session_dir(h, "hidden").is_err());
            runtime_store::open(h)
                .unwrap()
                .execute_batch("DROP TRIGGER stop_purge")
                .unwrap();
        }
        app.shutdown().await;
        let restarted =
            hexbot_core::server::App::new(h.into(), "127.0.0.1:0".parse().unwrap(), pi, None)
                .unwrap();
        for id in ["section-a", "hidden", "delegate", "room-history"] {
            if committed {
                assert!(
                    runtime_store::history(h, id).unwrap().is_empty(),
                    "orphaned {id}"
                );
                assert!(
                    runtime_store::session_dir(h, id).is_err(),
                    "resurrected {id}"
                );
            } else {
                assert_eq!(
                    runtime_store::history(h, id).unwrap()[0]["text"],
                    format!("original {id}")
                );
                assert!(runtime_store::session_dir(h, id).is_ok());
            }
        }
        if !committed {
            assert!(catalog::section(h, "alice", "legacy-only").is_ok());
        }
        assert_eq!(
            db::open(h)
                .unwrap()
                .query_row(
                    "SELECT COUNT(*) FROM settings WHERE key LIKE 'pending_bot_delete:%'",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
        restarted.shutdown().await;
    }
}

#[tokio::test]
async fn never_opened_section_retirement_recovers_without_inventing_history() {
    let home = setup();
    runtime_store::mark_deleted(home.path(), "section-a").unwrap();
    let app = hexbot_core::server::App::new(
        home.path().into(),
        "127.0.0.1:0".parse().unwrap(),
        fake_pi(home.path()),
        None,
    )
    .unwrap();
    assert!(
        open(&app.runtime, "alice").await["messages"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    app.shutdown().await;
}

#[tokio::test]
async fn overlapping_bot_deletes_and_recreation_are_ordered_across_rebind() {
    let home = setup();
    let h = home.path();
    let app =
        hexbot_core::server::App::new(h.into(), "127.0.0.1:0".parse().unwrap(), fake_pi(h), None)
            .unwrap();
    open(&app.runtime, "alice").await;
    let rebound = app.rebind("127.0.0.1:0".parse().unwrap()).unwrap();
    let params = json!({"name":"owl"});
    // Retirement awaits a real fixture process. Both later requests overlap
    // that await and must keep their order across the two App instances.
    let (first, second, created) = tokio::join!(
        app.call("alice", "hexbot.bots.delete", &params),
        rebound.call("alice", "hexbot.bots.delete", &params),
        app.call("alice", "hexbot.bots.create", &params),
    );
    assert_eq!(first.unwrap(), json!({"deleted":true}));
    assert_eq!(second.unwrap_err().code, 4205);
    let created = created.unwrap();
    let section = created["section"]["id"].as_str().unwrap();
    fs::create_dir_all(h.join("profiles/owl/memories")).unwrap();
    fs::write(h.join("profiles/owl/memories/MEMORY.md"), "new memory").unwrap();
    runtime_store::finish_deletes(h).unwrap();
    assert!(hexbot_core::catalog::section(h, "alice", section).is_ok());
    assert_eq!(
        fs::read_to_string(h.join("profiles/owl/memories/MEMORY.md")).unwrap(),
        "new memory"
    );
    app.shutdown().await;
}

#[cfg(unix)]
#[tokio::test]
async fn bot_delete_refuses_memory_symlinks_before_catalog_commit() {
    let home = setup();
    let h = home.path();
    let app =
        hexbot_core::server::App::new(h.into(), "127.0.0.1:0".parse().unwrap(), fake_pi(h), None)
            .unwrap();
    open(&app.runtime, "alice").await;
    runtime_store::append(h, "section-a", json!({"role":"user","text":"Keep history"})).unwrap();
    let outside = home.workspace().join("outside-memory");
    fs::create_dir_all(home.workspace()).unwrap();
    fs::write(&outside, "Do not touch").unwrap();
    fs::create_dir_all(h.join("profiles/owl/memories")).unwrap();
    std::os::unix::fs::symlink(&outside, h.join("profiles/owl/memories/MEMORY.md")).unwrap();
    assert!(
        app.call("alice", "hexbot.bots.delete", &json!({"name":"owl"}))
            .await
            .is_err()
    );
    assert!(hexbot_core::catalog::bot(h, "alice", "owl").is_ok());
    assert_eq!(
        runtime_store::history(h, "section-a").unwrap()[0]["text"],
        "Keep history"
    );
    assert_eq!(fs::read_to_string(outside).unwrap(), "Do not touch");
    app.shutdown().await;
}

#[cfg(unix)]
#[tokio::test]
async fn bot_delete_removes_owned_session_links_without_touching_their_targets() {
    let home = setup();
    let h = home.path();
    let app =
        hexbot_core::server::App::new(h.into(), "127.0.0.1:0".parse().unwrap(), fake_pi(h), None)
            .unwrap();
    let outside = home.workspace();
    fs::create_dir_all(&outside).unwrap();
    fs::write(outside.join("keep.txt"), "unrelated data").unwrap();
    runtime_store::open(h).unwrap().execute("INSERT INTO native_sessions(stored_id,owner,bot,prompt) VALUES('link-session','alice','owl','')", []).unwrap();
    fs::create_dir_all(h.join("runtime/sessions")).unwrap();
    let link = h.join("runtime/sessions/link-session");
    std::os::unix::fs::symlink(&outside, &link).unwrap();
    let result = app
        .call("alice", "hexbot.bots.delete", &json!({"name":"owl"}))
        .await
        .unwrap();
    assert_eq!(result["deleted"], true);
    assert!(!result["history_pending"].as_bool().unwrap_or(false));
    assert!(fs::symlink_metadata(link).is_err());
    assert_eq!(
        fs::read_to_string(outside.join("keep.txt")).unwrap(),
        "unrelated data"
    );
    app.shutdown().await;
}

#[cfg(unix)]
#[tokio::test]
#[ignore = "requires HEXBOT_TEST_PI to the pinned Pi executable"]
async fn actual_pi_write_and_edit_use_the_private_anchored_bridge() {
    use axum::{Json, Router, extract::State, routing::post};
    use std::sync::{Arc, Mutex};
    #[derive(Clone)]
    struct Model {
        requests: Arc<Mutex<Vec<Value>>>,
        path: PathBuf,
    }
    async fn complete(
        State(model): State<Model>,
        Json(body): Json<Value>,
    ) -> ([(&'static str, &'static str); 1], String) {
        let mut requests = model.requests.lock().unwrap();
        let number = requests.len();
        requests.push(body);
        let operation = match number {
            0 => Some(("write", json!({"path":model.path,"content":"hello\r\n"}))),
            1 => Some((
                "edit",
                json!({"path":model.path,"edits":[{"oldText":"hello","newText":"changed"}]}),
            )),
            _ => None,
        };
        let delta = if let Some((name, args)) = operation {
            json!({"role":"assistant","tool_calls":[{"index":0,"id":format!("file-{number}"),"type":"function","function":{"name":name,"arguments":args.to_string()}}]})
        } else {
            json!({"role":"assistant","content":"Finished."})
        };
        let first = json!({"id":"files","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":delta,"finish_reason":null}]});
        let end = json!({"id":"files","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{},"finish_reason":if number<2{"tool_calls"}else{"stop"}}]});
        (
            [("content-type", "text/event-stream")],
            format!("data: {first}\n\ndata: {end}\n\ndata: [DONE]\n\n"),
        )
    }
    let home = setup();
    let requests = Arc::new(Mutex::new(vec![]));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let path = home.workspace().join("nested/file.txt");
    let app = Router::new()
        .route("/v1/chat/completions", post(complete))
        .with_state(Model {
            requests: requests.clone(),
            path: path.clone(),
        });
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    fs::write(home.path().join("profiles/owl/config.yaml"),format!("model:\n  provider: lmstudio\n  default: test-model\n  api_key: test-key\n  base_url: http://{address}/v1\ntools:\n  enabled_toolsets: [file]\n")).unwrap();
    let executable = PathBuf::from(std::env::var_os("HEXBOT_TEST_PI").unwrap());
    let runtime = Runtime::new(home.path().into(), EventHub::new(), executable).unwrap();
    let result = tokio::time::timeout(
        Duration::from_secs(30),
        runtime.run_hidden(
            "alice",
            "owl",
            "section-a",
            "Write and then edit the fixture file.",
        ),
    )
    .await;
    runtime.shutdown().await;
    server.abort();
    assert_eq!(result.unwrap().unwrap(), "Finished.");
    assert_eq!(fs::read(&path).unwrap(), b"changed\r\n");
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(fs::metadata(path).unwrap().permissions().mode() & 0o077, 0);
    let requests = requests.lock().unwrap();
    assert_eq!(requests.len(), 3);
    for request in requests.iter() {
        assert_eq!(
            request["tools"], requests[0]["tools"],
            "frozen tool definitions are unchanged"
        );
        assert_eq!(
            request["messages"][0], requests[0]["messages"][0],
            "cached system prefix is unchanged"
        );
        assert!(
            !request["tools"]
                .as_array()
                .unwrap()
                .iter()
                .any(|tool| tool["function"]["name"] == "hexbot_pi_file")
        );
    }
    assert!(
        requests[2]["messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|m| m["role"] == "tool")
            .all(|m| m["content"]
                .as_str()
                .is_some_and(|s| s.contains("Successfully")))
    );
}
