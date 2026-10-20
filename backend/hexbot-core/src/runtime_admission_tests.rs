use super::*;

fn idle_stop_pi(home: &Path) {
    let path = home.join("pi.cjs");
    let script = fs::read_to_string(&path).unwrap();
    fs::write(
        path,
        script.replace("if(c.type==='abort')emit({type:'agent_settled'});", ""),
    )
    .unwrap();
}

fn change_configuration(home: &Path) {
    fs::write(
        home.join("profiles/owl/config.yaml"),
        "model:\n  provider: openai\n  default: fixture\ntools:\n  enabled_toolsets: []\n",
    )
    .unwrap();
    common::write_config(home, &json!({"mcp_servers":{}})).unwrap();
    store::open(home).unwrap().execute("UPDATE native_sessions SET options=json_set(options,'$.model','replacement') WHERE stored_id='first'", []).unwrap();
}

fn old_configuration(home: &Path) {
    fs::write(
        home.join("profiles/owl/config.yaml"),
        "model:\n  provider: openai\n  default: fixture\ntools:\n  enabled_toolsets: [hexbot]\n",
    )
    .unwrap();
    common::write_config(home, &json!({"mcp_servers":{"removed":{"command":"node"}}})).unwrap();
}

fn assert_current(home: &Path) {
    let runs = processes(home);
    assert_eq!(runs.len(), 2, "fresh input must replace stale Pi");
    let config = &runs[1]["config"];
    assert_eq!(config["model"], "replacement");
    assert_eq!(config["mcpServers"], json!([]));
    assert!(
        !config["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|tool| tool["name"] == "message_bot")
    );
}

#[tokio::test]
async fn idle_steer_revalidates_configuration_on_the_original_live_id() {
    let (home, runtime, hub) = setup();
    old_configuration(home.path());
    let id = open(&runtime).await;
    let original = runtime.sessions.lock().unwrap()["first"].clone();
    let mut events = hub.subscribe();
    runtime
        .call(
            "alice",
            "prompt.submit",
            &json!({"session_id":id,"text":"history"}),
        )
        .await
        .unwrap()
        .unwrap();
    stop_tests::stop_event(&mut events, |e| e["type"] == "message.complete").await;
    let before = store::history(home.path(), "first").unwrap();
    change_configuration(home.path());
    runtime
        .call(
            "alice",
            "session.steer",
            &json!({"session_id":id,"text":"current configuration"}),
        )
        .await
        .unwrap()
        .unwrap();
    stop_tests::stop_event(&mut events, |e| e["type"] == "message.complete").await;
    assert_current(home.path());
    let current = runtime.sessions.lock().unwrap()["first"].clone();
    assert_eq!(current.id, original.id);
    assert!(!Arc::ptr_eq(&original, &current));
    let history = store::history(home.path(), "first").unwrap();
    assert_eq!(&history[..before.len()], before);
    assert_eq!(
        history
            .iter()
            .filter(|m| m["text"] == "current configuration")
            .count(),
        1
    );
    runtime.shutdown().await;
}

#[tokio::test]
async fn fresh_prompt_revalidates_configuration_after_idle_stop_recovery() {
    for change_while_waiting in [false, true] {
        let (home, runtime, hub) = setup();
        old_configuration(home.path());
        idle_stop_pi(home.path());
        let id = open(&runtime).await;
        let original = runtime.sessions.lock().unwrap()["first"].clone();
        let file = runtime.call("alice", "file.attach", &json!({"session_id":id,"name":"keep.txt","data_url":"data:text/plain;base64,a2VlcA=="})).await.unwrap().unwrap();
        let recovery = original.recovery_gate.lock().await;
        runtime
            .call("alice", "session.interrupt", &json!({"session_id":id}))
            .await
            .unwrap()
            .unwrap();
        if !change_while_waiting {
            change_configuration(home.path());
        }
        let request = json!({"session_id":id,"text":"after recovery","attachments":[file["id"]]});
        let mut pending = std::pin::pin!(runtime.call_inner("alice", "prompt.submit", &request));
        // Drive this request to its recovery barrier without letting recovery run.
        assert!(
            std::future::Future::poll(
                pending.as_mut(),
                &mut std::task::Context::from_waker(std::task::Waker::noop())
            )
            .is_pending()
        );
        if change_while_waiting {
            change_configuration(home.path());
        }
        let mut events = hub.subscribe();
        drop(recovery);
        pending.await.unwrap();
        stop_tests::stop_event(&mut events, |e| e["type"] == "message.complete").await;
        assert_current(home.path());
        let history = store::history(home.path(), "first").unwrap();
        let rows = history
            .iter()
            .filter(|m| m["role"] == "user")
            .collect::<Vec<_>>();
        assert_eq!(rows.len(), 1);
        assert!(
            rows[0]["text"]
                .as_str()
                .unwrap()
                .contains(file["path"].as_str().unwrap())
        );
        assert!(Path::new(file["path"].as_str().unwrap()).exists());
        assert_eq!(runtime.sessions.lock().unwrap()["first"].id, id);
        runtime.shutdown().await;
    }
}

#[tokio::test]
async fn fresh_compaction_after_idle_stop_can_offer_and_adopt_a_prompt() {
    let (home, runtime, hub) = setup();
    idle_stop_pi(home.path());
    let path = home.path().join("pi.cjs");
    let script = fs::read_to_string(&path).unwrap();
    fs::write(path, script.replace("if(c.type==='extension_ui_response'){", "if(c.type==='compact'){global.compact=c;emit({type:'extension_ui_request',id:'probe:compact-refresh',method:'input',title:'__HEXBOT_TOOL__'+JSON.stringify({name:'hexbot_session_prompt',args:{current:require('node:crypto').createHash('sha256').update(JSON.parse(fs.readFileSync(process.env.HEXBOT_SESSION_CONFIG)).prompt).digest('hex')}})});return;}\nif(c.type==='extension_ui_response'&&c.id==='probe:compact-refresh'){fs.appendFileSync(__dirname+'/dialogs.jsonl',JSON.stringify(c)+'\\n');emit({type:'response',id:global.compact.id,command:'compact',success:true,data:{}});return;}\nif(c.type==='extension_ui_response'){ ")).unwrap();
    let id = open(&runtime).await;
    let s = runtime.sessions.lock().unwrap()["first"].clone();
    let original = processes(home.path())[0]["config"]["prompt"]
        .as_str()
        .unwrap()
        .to_owned();
    fs::write(
        home.path().join("profiles/owl/SOUL.md"),
        "new soul after idle Stop",
    )
    .unwrap();
    runtime
        .call("alice", "session.interrupt", &json!({"session_id":id}))
        .await
        .unwrap()
        .unwrap();
    let mut events = hub.subscribe();
    runtime
        .call(
            "alice",
            "prompt.submit",
            &json!({"session_id":id,"text":"/compact"}),
        )
        .await
        .unwrap()
        .unwrap();
    let reply: Value = serde_json::from_str(
        fs::read_to_string(home.path().join("dialogs.jsonl"))
            .unwrap()
            .lines()
            .last()
            .unwrap(),
    )
    .unwrap();
    assert_ne!(
        reply["cancelled"], true,
        "a fresh compaction's bridge request must be live"
    );
    let offer: Value = serde_json::from_str(reply["value"].as_str().unwrap()).unwrap();
    let prompt = offer["result"]["text"].as_str().unwrap();
    assert!(prompt.contains("new soul after idle Stop"));
    runtime.event(&s, json!({"type":"extension_ui_request","id":"probe:adopt","method":"input","title":format!("__HEXBOT_TOOL__{}",json!({"name":"hexbot_session_prompt","args":{"adopt":adopt(prompt)}}))})).unwrap();
    stop_tests::stop_event(&mut events, |e| {
        e["payload"]["text"]
            .as_str()
            .is_some_and(|text| text.contains("probe:adopt"))
    })
    .await;
    let saved: String = store::open(home.path())
        .unwrap()
        .query_row(
            "SELECT prompt FROM native_sessions WHERE stored_id='first'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_ne!(saved, original);
    assert_eq!(saved, prompt);
    assert_eq!(processes(home.path()).len(), 1);
    runtime.shutdown().await;
}

async fn actual_fixture() -> (
    common::TestHome,
    Arc<Runtime>,
    EventHub,
    tokio::sync::mpsc::UnboundedReceiver<Value>,
    tokio::task::JoinHandle<()>,
    Arc<tokio::sync::Semaphore>,
) {
    use axum::{Json, Router, extract::State, routing::post};
    async fn complete(
        State((tx, release)): State<(
            tokio::sync::mpsc::UnboundedSender<Value>,
            Arc<tokio::sync::Semaphore>,
        )>,
        Json(body): Json<Value>,
    ) -> ([(&'static str, &'static str); 1], String) {
        let hold = body["messages"]
            .as_array()
            .unwrap()
            .iter()
            .rev()
            .find(|m| m["role"] == "user")
            .is_some_and(|m| store::text(&m["content"]) == "hold");
        tx.send(body).unwrap();
        if hold {
            release.acquire().await.unwrap().forget();
        }
        let chunk = json!({"id":"admission","object":"chat.completion.chunk","created":1,"model":"fixture","choices":[{"index":0,"delta":{"role":"assistant","content":"finished"},"finish_reason":null}]});
        let end = json!({"id":"admission","object":"chat.completion.chunk","created":1,"model":"fixture","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]});
        (
            [("content-type", "text/event-stream")],
            format!("data: {chunk}\n\ndata: {end}\n\ndata: [DONE]\n\n"),
        )
    }
    let (home, unused, hub) = setup();
    drop(unused);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    let release = Arc::new(tokio::sync::Semaphore::new(0));
    let app = Router::new()
        .route("/v1/chat/completions", post(complete))
        .with_state((tx, release.clone()));
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    fs::write(home.path().join("profiles/owl/config.yaml"), format!("model:\n  provider: lmstudio\n  default: fixture\n  api_key: local-only\n  base_url: http://{address}/v1\nmodel_overrides:\n  lmstudio:\n    fixture:\n      context_window: 2000000\n      supports_vision: true\n    replacement:\n      context_window: 2000000\n      supports_vision: true\ntools:\n  enabled_toolsets: [hexbot, terminal]\n")).unwrap();
    fs::create_dir_all(home.path().join("profiles/owl/pi")).unwrap();
    fs::write(
        home.path().join("profiles/owl/pi/settings.json"),
        r#"{"images":{"autoResize":false}}"#,
    )
    .unwrap();
    let mcp = home.path().join("mcp.cjs");
    fs::write(&mcp, r#"require('node:readline').createInterface({input:process.stdin}).on('line',line=>{let r=JSON.parse(line);if(r.id!==undefined)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result:r.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:{tools:[]}})+'\n');});"#).unwrap();
    common::write_config(
        home.path(),
        &json!({"mcp_servers":{"removed":{"command":"node","args":[mcp]}}}),
    )
    .unwrap();
    let extension = home.path().join("admission.mjs");
    fs::write(&extension, format!(r#"import fs from 'node:fs';
export default function(pi) {{
fs.appendFileSync({},JSON.stringify({{pid:process.pid,config:JSON.parse(fs.readFileSync(process.env.HEXBOT_SESSION_CONFIG))}})+'\n');
}}
"#,json!(home.path().join("processes.jsonl")))).unwrap();
    let executable = home.path().join("actual-pi.sh");
    let quote = |path: &Path| format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"));
    fs::write(
        &executable,
        format!(
            "#!/bin/sh\nexec {} \"$@\" --extension {}\n",
            quote(Path::new(&std::env::var_os("HEXBOT_TEST_PI").unwrap())),
            quote(&extension)
        ),
    )
    .unwrap();
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
    let runtime = Runtime::new(home.path().into(), hub.clone(), executable).unwrap();
    (home, runtime, hub, rx, server, release)
}

fn remove_actual_capabilities(home: &Path) {
    let path = home.join("profiles/owl/config.yaml");
    let config = fs::read_to_string(&path).unwrap();
    fs::write(path, config.replace("[hexbot, terminal]", "[]")).unwrap();
    common::write_config(home, &json!({"mcp_servers":{}})).unwrap();
    store::open(home).unwrap().execute("UPDATE native_sessions SET options=json_set(options,'$.model','replacement') WHERE stored_id='first'", []).unwrap();
}
async fn provider_request(rx: &mut tokio::sync::mpsc::UnboundedReceiver<Value>) -> Value {
    tokio::time::timeout(Duration::from_secs(10), rx.recv())
        .await
        .unwrap()
        .unwrap()
}

#[tokio::test]
#[ignore = "requires HEXBOT_TEST_PI to the pinned Pi executable; uses a local provider"]
async fn actual_pi_idle_steer_refreshes_removed_capabilities_and_model() {
    let (home, runtime, hub, mut rx, server, release) = actual_fixture().await;
    let id = open(&runtime).await;
    let mut events = hub.subscribe();
    runtime
        .call_inner(
            "alice",
            "prompt.submit",
            &json!({"session_id":id,"text":"original history"}),
        )
        .await
        .unwrap();
    let first = provider_request(&mut rx).await;
    stop_tests::stop_event(&mut events, |e| e["type"] == "message.complete").await;
    let raw_path = store::session_dir(home.path(), "first")
        .unwrap()
        .join("conversation.jsonl");
    let raw = fs::read(&raw_path).unwrap();
    runtime
        .call_inner(
            "alice",
            "prompt.submit",
            &json!({"session_id":id,"text":"hold"}),
        )
        .await
        .unwrap();
    let held = provider_request(&mut rx).await;
    remove_actual_capabilities(home.path());
    runtime
        .call_inner(
            "alice",
            "session.steer",
            &json!({"session_id":id,"text":"busy steer"}),
        )
        .await
        .unwrap();
    assert_eq!(processes(home.path()).len(), 1);
    release.add_permits(1);
    let busy = provider_request(&mut rx).await;
    assert_eq!(busy["model"], "fixture");
    assert_eq!(busy["messages"][0], held["messages"][0]);
    assert_eq!(busy["tools"], held["tools"]);
    stop_tests::stop_event(&mut events, |e| e["type"] == "message.complete").await;
    runtime
        .call_inner(
            "alice",
            "session.steer",
            &json!({"session_id":id,"text":"steer with current configuration"}),
        )
        .await
        .unwrap();
    let next = provider_request(&mut rx).await;
    stop_tests::stop_event(&mut events, |e| e["type"] == "message.complete").await;
    assert_current(home.path());
    assert_ne!(
        processes(home.path())[0]["pid"],
        processes(home.path())[1]["pid"]
    );
    assert_eq!(next["model"], "replacement");
    let tools = |body: &Value| {
        body["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["function"]["name"].clone())
            .collect::<Vec<_>>()
    };
    assert!(tools(&first).contains(&json!("bash")));
    assert!(!tools(&next).contains(&json!("bash")));
    assert!(!next["messages"][0].to_string().contains("mcp__removed"));
    assert!(next["messages"].to_string().contains("original history"));
    assert!(fs::read(raw_path).unwrap().starts_with(&raw));
    assert_eq!(runtime.sessions.lock().unwrap()["first"].id, id);
    runtime.shutdown().await;
    server.abort();
}

#[tokio::test]
#[ignore = "requires HEXBOT_TEST_PI to the pinned Pi executable; uses a local provider"]
async fn actual_pi_prompt_after_recovery_refreshes_configuration_and_transfers_uploads_once() {
    let (home, runtime, hub, mut rx, server, _release) = actual_fixture().await;
    let id = open(&runtime).await;
    let original = runtime.sessions.lock().unwrap()["first"].clone();
    let image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
    let attached = runtime
        .call_inner(
            "alice",
            "image.attach_bytes",
            &json!({"session_id":id,"content_base64":image,"filename":"pixel.png"}),
        )
        .await
        .unwrap();
    let file = runtime.call_inner("alice", "file.attach", &json!({"session_id":id,"name":"keep.txt","data_url":"data:text/plain;base64,a2VlcA=="})).await.unwrap();
    let recovery = original.recovery_gate.lock().await;
    runtime
        .call_inner("alice", "session.interrupt", &json!({"session_id":id}))
        .await
        .unwrap();
    let request =
        json!({"session_id":id,"text":"after recovery","attachments":[file["id"],attached["id"]]});
    let mut pending = std::pin::pin!(runtime.call_inner("alice", "prompt.submit", &request));
    assert!(
        std::future::Future::poll(
            pending.as_mut(),
            &mut std::task::Context::from_waker(std::task::Waker::noop())
        )
        .is_pending()
    );
    // The actual handler now waits behind recovery; change all configuration then.
    remove_actual_capabilities(home.path());
    let mut events = hub.subscribe();
    drop(recovery);
    pending.await.unwrap();
    let next = provider_request(&mut rx).await;
    stop_tests::stop_event(&mut events, |e| e["type"] == "message.complete").await;
    assert_current(home.path());
    assert_eq!(next["model"], "replacement");
    let users = next["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|m| m["role"] == "user")
        .collect::<Vec<_>>();
    assert_eq!(users.len(), 1);
    let text = store::text(&users[0]["content"]);
    assert_eq!(text.matches("after recovery").count(), 1);
    assert_eq!(text.matches(file["path"].as_str().unwrap()).count(), 1);
    assert!(users[0]["content"].to_string().contains(image));
    assert!(!next["tools"].to_string().contains("\"bash\""));
    let intents: (usize, usize) = store::open(home.path())
        .unwrap()
        .query_row(
            "SELECT COUNT(*),SUM(consumed_by IS NOT NULL) FROM native_prompt_intents WHERE session_id='first'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(intents, (1, 1));
    assert_eq!(
        store::history(home.path(), "first")
            .unwrap()
            .iter()
            .filter(|m| m["role"] == "user")
            .count(),
        1
    );
    runtime.shutdown().await;
    server.abort();
    background_tests::actual_background_recovery(false).await;
    background_tests::actual_background_recovery(true).await;
    background_tests::public_delegate_reply_after_recovery().await;
    background_tests::public_peer_reply_after_refresh().await;
}

#[tokio::test]
#[ignore = "requires HEXBOT_TEST_PI to the pinned Pi executable; uses a local provider"]
async fn actual_pi_compaction_after_idle_stop_adopts_latest_prompt_without_rewriting_history() {
    let (home, runtime, hub, mut rx, server, _release) = actual_fixture().await;
    let id = open(&runtime).await;
    let mut events = hub.subscribe();
    runtime
        .call_inner(
            "alice",
            "prompt.submit",
            &json!({"session_id":id,"text":(0..12000).map(|i| format!("KEEP_PAST_CONTEXT_{i} ")).collect::<String>()}),
        )
        .await
        .unwrap();
    let first = provider_request(&mut rx).await;
    stop_tests::stop_event(&mut events, |e| e["type"] == "message.complete").await;
    runtime
        .call_inner(
            "alice",
            "prompt.submit",
            &json!({"session_id":id,"text":(0..12000).map(|i| format!("RECENT_CONTEXT_{i} ")).collect::<String>()}),
        )
        .await
        .unwrap();
    provider_request(&mut rx).await;
    stop_tests::stop_event(&mut events, |e| e["type"] == "message.complete").await;
    let dir = store::session_dir(home.path(), "first").unwrap();
    let raw = fs::read(dir.join("conversation.jsonl")).unwrap();
    let saved_before: String = store::open(home.path())
        .unwrap()
        .query_row(
            "SELECT prompt FROM native_sessions WHERE stored_id='first'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    for (path, value) in [
        ("profiles/owl/SOUL.md", "FRESH_SOUL"),
        ("profiles/owl/memories/MEMORY.md", "FRESH_MEMORY"),
        ("users/alice/user.md", "FRESH_ABOUT"),
        (
            "skills/admission/SKILL.md",
            "---\nname: admission\ndescription: FRESH_SKILL\n---\nBody",
        ),
    ] {
        let path = home.path().join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, value).unwrap();
    }
    db::open(home.path()).unwrap().execute_batch("INSERT INTO bots(name,owner_id,display_name,description) VALUES('fox','alice','FRESH_TEAM','new teammate')").unwrap();
    runtime
        .call_inner("alice", "session.interrupt", &json!({"session_id":id}))
        .await
        .unwrap();
    runtime
        .call_inner(
            "alice",
            "prompt.submit",
            &json!({"session_id":id,"text":"/compact"}),
        )
        .await
        .unwrap();
    // Real Pi requests its summary from the local provider too.
    let summary = provider_request(&mut rx).await;
    assert!(
        summary["messages"]
            .to_string()
            .contains("KEEP_PAST_CONTEXT")
    );
    stop_tests::stop_event(&mut events, |e| {
        e["type"] == "message.complete" && e["payload"]["text"] == "Older messages summarised."
    })
    .await;
    // An offer alone does not change the durable prompt.
    let saved = || {
        store::open(home.path())
            .unwrap()
            .query_row::<String, _, _>(
                "SELECT prompt FROM native_sessions WHERE stored_id='first'",
                [],
                |r| r.get(0),
            )
            .unwrap()
    };
    assert_eq!(saved(), saved_before);
    runtime
        .call_inner(
            "alice",
            "prompt.submit",
            &json!({"session_id":id,"text":"use refreshed prompt"}),
        )
        .await
        .unwrap();
    let next = provider_request(&mut rx).await;
    stop_tests::stop_event(&mut events, |e| e["type"] == "message.complete").await;
    let prefix = next["messages"][0].to_string();
    for marker in [
        "FRESH_SOUL",
        "FRESH_MEMORY",
        "FRESH_ABOUT",
        "FRESH_TEAM",
        "FRESH_SKILL",
    ] {
        assert!(prefix.contains(marker), "missing {marker}");
        assert!(saved().contains(marker));
    }
    assert_eq!(first["tools"], next["tools"]);
    assert_eq!(processes(home.path()).len(), 1);
    assert!(
        fs::read(dir.join("conversation.jsonl"))
            .unwrap()
            .starts_with(&raw)
    );
    runtime.shutdown().await;
    server.abort();
}

#[tokio::test]
#[ignore = "requires HEXBOT_TEST_PI to the pinned Pi executable; uses a local provider and MCP server"]
async fn actual_pi_handled_mcp_command_finishes_its_input_before_stop_and_fresh_work() {
    for steer in [false, true] {
        let (home, runtime, hub, mut rx, server, _release) = actual_fixture().await;
        let id = open(&runtime).await;
        let mut events = hub.subscribe();
        runtime
            .call_inner(
                "alice",
                if steer {
                    "session.steer"
                } else {
                    "prompt.submit"
                },
                &json!({"session_id":id,"text":"/mcp"}),
            )
            .await
            .unwrap();
        assert!(
            rx.try_recv().is_err(),
            "a handled command never calls the model"
        );
        let s = runtime.sessions.lock().unwrap()["first"].clone();
        {
            let state = s.state.lock().unwrap();
            assert!(!state.busy);
            assert!(state.inputs.is_empty());
            assert!(state.display.is_empty());
        }
        let intents: usize = store::open(home.path())
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM native_prompt_intents WHERE text='/mcp'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(intents, 0);
        if !steer {
            runtime
                .call_inner("alice", "session.interrupt", &json!({"session_id":id}))
                .await
                .unwrap();
            runtime.call_inner("alice", "prompt.submit", &json!({"session_id":id,"text":"late result","queued":true,"display_kind":"hidden"})).await.unwrap();
            let request = provider_request(&mut rx).await;
            assert_eq!(
                request["messages"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter(|m| m["role"] == "user" && store::text(&m["content"]) == "late result")
                    .count(),
                1
            );
            stop_tests::stop_event(&mut events, |e| e["type"] == "message.complete").await;
            let history = store::history(home.path(), "first").unwrap();
            let rows = history
                .iter()
                .filter(|m| m["text"] == "late result")
                .collect::<Vec<_>>();
            assert_eq!(rows.len(), 1);
            assert_eq!(rows[0]["display_kind"], "hidden");
        }
        runtime
            .call_inner(
                "alice",
                "prompt.submit",
                &json!({"session_id":id,"text":"fresh owner"}),
            )
            .await
            .unwrap();
        provider_request(&mut rx).await;
        stop_tests::stop_event(&mut events, |e| e["type"] == "message.complete").await;
        assert_eq!(processes(home.path()).len(), 1);
        runtime.shutdown().await;
        server.abort();
    }
}

#[tokio::test]
#[ignore = "requires HEXBOT_TEST_PI to the pinned Pi executable; uses a local provider and MCP server"]
async fn actual_pi_handled_command_during_a_run_preserves_that_run_and_caller_chain() {
    let (home, runtime, hub, mut rx, server, release) = actual_fixture().await;
    let id = open(&runtime).await;
    let s = runtime.sessions.lock().unwrap()["first"].clone();
    let chain = Chain {
        hops: Arc::new(AtomicUsize::new(3)),
        askers: vec!["requester".into()],
    };
    let mut events = hub.subscribe();
    runtime
        .submit(&s, "hold", false, false, Some(chain.clone()), None)
        .await
        .unwrap();
    let first = provider_request(&mut rx).await;
    runtime
        .call_inner(
            "alice",
            "prompt.submit",
            &json!({"session_id":id,"text":"/mcp","queued":true}),
        )
        .await
        .unwrap();
    {
        let state = s.state.lock().unwrap();
        assert!(state.busy);
        assert!(state.inputs.is_empty());
        assert!(state.display.is_empty());
        assert!(Arc::ptr_eq(&state.chain.hops, &chain.hops));
        assert_eq!(state.chain.askers, chain.askers);
    }
    // Pi rejects queued extension commands in the steering lane. That refusal
    // must also leave the active operation and its chain untouched.
    assert!(
        runtime
            .call_inner(
                "alice",
                "session.steer",
                &json!({"session_id":id,"text":"/mcp"})
            )
            .await
            .is_err()
    );
    assert!(s.state.lock().unwrap().busy);
    runtime
        .append_outside_turn(
            "first",
            json!({"role":"assistant","text":"external report","dream":true}),
        )
        .unwrap();
    release.add_permits(1);
    stop_tests::stop_event(&mut events, |e| e["type"] == "message.complete").await;
    let reloads = hub.since("alice", "", 0)["events"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|e| e["type"] == "hexbot.sections.changed" && e["payload"]["reload"] == true)
        .count();
    assert_eq!(reloads, 1);
    let history = store::history(home.path(), "first").unwrap();
    assert_eq!(
        history
            .iter()
            .filter(|m| m["text"] == "external report")
            .count(),
        1
    );
    runtime
        .call_inner(
            "alice",
            "prompt.submit",
            &json!({"session_id":id,"text":"next owner"}),
        )
        .await
        .unwrap();
    let next = provider_request(&mut rx).await;
    stop_tests::stop_event(&mut events, |e| e["type"] == "message.complete").await;
    assert_eq!(first["tools"], next["tools"]);
    assert_eq!(first["messages"][0], next["messages"][0]);
    assert_eq!(processes(home.path()).len(), 1);
    runtime.shutdown().await;
    server.abort();
}

#[tokio::test]
async fn recovery_waiters_keep_fifo_uploads_and_chain_across_configuration_restart() {
    let (home, runtime, hub) = setup();
    old_configuration(home.path());
    // A protocol fixture that keeps a run active and projects queued steering
    // only when asked to finish, matching Pi's lane order.
    let path = home.path().join("pi.cjs");
    let script = fs::read_to_string(&path).unwrap();
    let start = script.find("rl.on('line'").unwrap();
    let log = json!(home.path().join("commands.jsonl"));
    fs::write(&path, format!("{}\nlet active=false,queued=[];\nrl.on('line',line=>{{const c=JSON.parse(line);fs.appendFileSync({log},JSON.stringify(c)+'\\n');emit({{type:'response',id:c.id,command:c.type,success:true,data:c.type==='clear_queue'?{{steering:[],followUp:[]}}:['prompt','steer'].includes(c.type)?{{disposition:active?'queued':'started'}}:{{}}}});if(c.type==='prompt'){{active=true;emit({{type:'agent_start'}});emit({{type:'message_end',message:{{role:'user',content:c.message}}}});}}if(c.type==='steer')queued.push(c.message);if(c.type==='finish_run'){{for(const text of queued)emit({{type:'message_end',message:{{role:'user',content:text}}}});queued=[];active=false;emit({{type:'agent_settled'}});}}}});", &script[..start])).unwrap();
    let id = open(&runtime).await;
    let old = runtime.sessions.lock().unwrap()["first"].clone();
    let file = home.path().join("queued.txt");
    fs::write(&file, "original body").unwrap();
    let image = json!({"type":"image","mimeType":"image/png","data":"exact-original-image"});
    old.state.lock().unwrap().staged.push(Staged {
        id: "original".into(),
        images: vec![image.clone()],
        refs: vec![file.display().to_string()],
        files: vec![file.clone()],
    });
    let recovery = old.recovery_gate.lock().await;
    runtime
        .call_inner("alice", "session.interrupt", &json!({"session_id":id}))
        .await
        .unwrap();
    let chain = Chain {
        hops: Arc::new(AtomicUsize::new(3)),
        askers: vec!["earlier requester".into()],
    };
    let uploads = ["original".into()];
    let first = runtime.submit(
        &old,
        "first result",
        true,
        true,
        Some(chain.clone()),
        Some(&uploads),
    );
    let second = runtime.steer(&old, "second steer", None);
    tokio::pin!(first, second);
    assert!(futures_util::poll!(first.as_mut()).is_pending());
    assert!(futures_util::poll!(second.as_mut()).is_pending());
    assert_eq!(
        runtime
            .call_inner(
                "alice",
                "prompt.submit",
                &json!({"session_id":id,"text":"cannot overtake"})
            )
            .await
            .unwrap_err()
            .code,
        4002
    );
    change_configuration(home.path());
    drop(recovery);
    first.await.unwrap();
    second.await.unwrap();
    assert_current(home.path());
    let current = runtime.sessions.lock().unwrap()["first"].clone();
    assert!(Arc::ptr_eq(&old.input_gate, &current.input_gate));
    {
        let state = current.state.lock().unwrap();
        assert!(Arc::ptr_eq(&state.chain.hops, &chain.hops));
        assert!(state.chain.askers.is_empty());
        assert_eq!(state.inputs.len(), 1);
        assert!(Arc::ptr_eq(&state.inputs[0].chain.hops, &chain.hops));
    }
    let mut events = hub.subscribe();
    Runtime::command(&current, json!({"type":"finish_run"}))
        .await
        .unwrap();
    stop_tests::stop_event(&mut events, |e| e["type"] == "message.complete").await;
    let commands: Vec<Value> = fs::read_to_string(home.path().join("commands.jsonl"))
        .unwrap()
        .lines()
        .map(|s| serde_json::from_str(s).unwrap())
        .filter(|c: &Value| c["type"] == "prompt" || c["type"] == "steer")
        .collect();
    assert_eq!(commands.len(), 2);
    assert_eq!(commands[0]["images"], json!([image]));
    assert_eq!(
        commands[0]["message"],
        format!("first result\n\nAttached files:\n{}", file.display())
    );
    assert_eq!(commands[1]["message"], "second steer");
    let history = store::history(home.path(), "first").unwrap();
    let users = history
        .iter()
        .filter(|m| m["role"] == "user")
        .collect::<Vec<_>>();
    assert_eq!(users.len(), 2);
    assert_eq!(users[0]["display_kind"], "hidden");
    assert_eq!(users[1]["text"], "second steer");
    assert_eq!(users[1]["display_kind"], "normal");
    assert!(file.exists());
    runtime.shutdown().await;
}

#[tokio::test]
async fn a_closed_alias_cannot_redirect_a_waiter_into_a_reopened_session() {
    let (home, runtime, _) = setup();
    let id = open(&runtime).await;
    let old = runtime.sessions.lock().unwrap()["first"].clone();
    let slot = old.input_gate.lock().await;
    let waiting = runtime.steer(&old, "obsolete request", None);
    tokio::pin!(waiting);
    assert!(futures_util::poll!(waiting.as_mut()).is_pending());
    runtime.close_stored("alice", "first").await.unwrap();
    let next = open(&runtime).await;
    assert_ne!(next, id);
    drop(slot);
    assert_eq!(waiting.await.unwrap_err().code, 4001);
    assert!(store::history(home.path(), "first").unwrap().is_empty());
    assert_eq!(processes(home.path()).len(), 2);
    runtime.shutdown().await;
}

#[tokio::test]
async fn failed_configuration_restart_preserves_uploads_and_the_waiting_fifo() {
    let (home, runtime, hub) = setup();
    old_configuration(home.path());
    idle_stop_pi(home.path());
    let id = open(&runtime).await;
    let old = runtime.sessions.lock().unwrap()["first"].clone();
    let file = runtime.call_inner("alice", "file.attach", &json!({"session_id":id,"name":"kept.txt","data_url":"data:text/plain;base64,a2VlcA=="})).await.unwrap();
    let recovery = old.recovery_gate.lock().await;
    runtime
        .call_inner("alice", "session.interrupt", &json!({"session_id":id}))
        .await
        .unwrap();
    let ids = [file["id"].as_str().unwrap().to_owned()];
    let first = runtime.submit(&old, "failed attempt", true, true, None, Some(&ids));
    let second = runtime.steer(&old, "waiting steer", None);
    tokio::pin!(first, second);
    assert!(futures_util::poll!(first.as_mut()).is_pending());
    assert!(futures_util::poll!(second.as_mut()).is_pending());
    let executable = home.path().join("pi.cjs");
    let script = fs::read(&executable).unwrap();
    let permissions = fs::metadata(&executable).unwrap().permissions();
    change_configuration(home.path());
    fs::remove_file(&executable).unwrap();
    drop(recovery);
    assert!(first.await.is_err());
    assert!(Path::new(file["path"].as_str().unwrap()).exists());
    fs::write(&executable, script).unwrap();
    fs::set_permissions(executable, permissions).unwrap();
    let current = runtime.open_session("alice", "owl", "first").await.unwrap();
    assert!(Arc::ptr_eq(&old.input_gate, &current.input_gate));
    assert_eq!(
        runtime
            .submit(&current, "cannot overtake", false, false, None, None)
            .await
            .unwrap_err()
            .code,
        4002
    );
    let mut events = hub.subscribe();
    second.await.unwrap();
    stop_tests::stop_event(&mut events, |e| e["type"] == "message.complete").await;
    runtime
        .call_inner(
            "alice",
            "prompt.submit",
            &json!({"session_id":id,"text":"retry with upload","attachments":ids}),
        )
        .await
        .unwrap();
    stop_tests::stop_event(&mut events, |e| e["type"] == "message.complete").await;
    let history = store::history(home.path(), "first").unwrap();
    assert_eq!(
        history
            .iter()
            .filter(|m| m["text"]
                .as_str()
                .is_some_and(|t| t.contains(file["path"].as_str().unwrap())))
            .count(),
        1
    );
    assert!(!history.iter().any(|m| m["text"] == "failed attempt"));
    runtime.shutdown().await;
}

fn handled_command_pi(home: &Path) {
    idle_stop_pi(home);
    let path = home.join("pi.cjs");
    let script = fs::read_to_string(&path).unwrap();
    fs::write(path, script.replace("const c=JSON.parse(line);", "const c=JSON.parse(line);if(c.type==='prompt'&&c.message==='/handled'){emit({type:'response',id:c.id,command:'prompt',success:true,data:{disposition:'handled'}});return;}if(c.type==='finish_run')emit({type:'agent_settled'});")).unwrap();
}

#[tokio::test]
async fn handled_preflight_finishes_only_its_input_and_keeps_stop_recovery_usable() {
    for busy in [false, true] {
        let (home, runtime, hub) = setup();
        handled_command_pi(home.path());
        let id = open(&runtime).await;
        let mut events = hub.subscribe();
        if busy {
            runtime
                .call_inner(
                    "alice",
                    "prompt.submit",
                    &json!({"session_id":id,"text":"wait"}),
                )
                .await
                .unwrap();
        }
        runtime
            .call_inner(
                "alice",
                "prompt.submit",
                &json!({"session_id":id,"text":"/handled","queued":busy}),
            )
            .await
            .unwrap();
        let status = runtime
            .call_inner("alice", "session.status", &json!({"session_id":id}))
            .await
            .unwrap();
        assert_eq!(status["status"], if busy { "working" } else { "idle" });
        if busy {
            let s = runtime.sessions.lock().unwrap()["first"].clone();
            Runtime::command(&s, json!({"type":"finish_run"}))
                .await
                .unwrap();
            stop_tests::stop_event(&mut events, |e| e["type"] == "message.complete").await;
        }
        runtime
            .call_inner("alice", "session.interrupt", &json!({"session_id":id}))
            .await
            .unwrap();
        runtime.call_inner("alice", "prompt.submit", &json!({"session_id":id,"text":"background after command","queued":true,"display_kind":"hidden"})).await.unwrap();
        stop_tests::stop_event(&mut events, |e| e["type"] == "message.complete").await;
        runtime
            .call_inner(
                "alice",
                "prompt.submit",
                &json!({"session_id":id,"text":"fresh owner"}),
            )
            .await
            .unwrap();
        stop_tests::stop_event(&mut events, |e| e["type"] == "message.complete").await;
        let history = store::history(home.path(), "first").unwrap();
        assert!(!history.iter().any(|m| m["text"] == "/handled"));
        let rows = history
            .iter()
            .filter(|m| m["text"] == "background after command")
            .collect::<Vec<_>>();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["display_kind"], "hidden");
        assert_eq!(processes(home.path()).len(), 1);
        runtime.shutdown().await;
    }
}

#[tokio::test]
async fn handled_intent_write_failure_rejects_the_ack_and_preserves_the_intent() {
    let (home, runtime, _) = setup();
    handled_command_pi(home.path());
    let id = open(&runtime).await;
    let s = runtime.sessions.lock().unwrap()["first"].clone();
    let mut settled = s.settled.subscribe();
    store::open(home.path()).unwrap().execute_batch("CREATE TRIGGER refuse_handled_intent BEFORE DELETE ON native_prompt_intents WHEN OLD.text='/handled' BEGIN SELECT RAISE(ABORT,'intent write fault'); END;").unwrap();
    assert!(
        runtime
            .call_inner(
                "alice",
                "prompt.submit",
                &json!({"session_id":id,"text":"/handled"})
            )
            .await
            .is_err()
    );
    tokio::time::timeout(Duration::from_secs(5), settled.changed())
        .await
        .unwrap()
        .unwrap();
    let unconsumed:usize=store::open(home.path()).unwrap().query_row("SELECT COUNT(*) FROM native_prompt_intents WHERE text='/handled' AND consumed_by IS NULL",[],|r|r.get(0)).unwrap();
    assert_eq!(unconsumed, 1);
    assert!(s.state.lock().unwrap().closed);
    assert_exited(&processes(home.path())[0]);
    runtime.shutdown().await;
}

#[tokio::test]
async fn non_chat_input_keeps_the_room_job_delegate_and_restricted_configuration_frozen() {
    for surface in ["room", "job", "delegate", "restricted"] {
        let (home, runtime, hub) = setup();
        old_configuration(home.path());
        if surface == "room" {
            db::open(home.path()).unwrap().execute_batch("DELETE FROM sections WHERE id='first';INSERT INTO rooms(id,name,owner_id) VALUES('room','Room','alice');INSERT INTO room_sessions(room_id,bot,stored_session_id) VALUES('room','owl','first');").unwrap();
        }
        let overrides = match surface {
            "job" => Some(json!({"job":"job-one"})),
            "delegate" => {
                runtime
                    .open_session("alice", "owl", "parent")
                    .await
                    .unwrap();
                Some(json!({"parent_session":"parent"}))
            }
            _ => None,
        };
        let tools = ["message_bot"];
        let original = runtime
            .open_session_with_tools(
                "alice",
                "owl",
                "first",
                (surface == "restricted").then_some(tools.as_slice()),
                overrides.as_ref(),
                false,
            )
            .await
            .unwrap();
        assert!(
            original
                .tools
                .iter()
                .any(|tool| tool["name"] == "message_bot")
        );
        let mut events = hub.subscribe();
        runtime
            .call_inner(
                "alice",
                "prompt.submit",
                &json!({"session_id":original.id,"text":"original history"}),
            )
            .await
            .unwrap();
        stop_tests::stop_event(&mut events, |e| e["type"] == "message.complete").await;
        let before = processes(home.path());
        fs::write(
            home.path().join("profiles/owl/config.yaml"),
            "model:\n  provider: openai\n  default: replacement\ntools:\n  enabled_toolsets: []\n",
        )
        .unwrap();
        common::write_config(home.path(), &json!({"mcp_servers":{}})).unwrap();
        runtime
            .call_inner(
                "alice",
                "session.steer",
                &json!({"session_id":original.id,"text":"frozen next run"}),
            )
            .await
            .unwrap();
        stop_tests::stop_event(&mut events, |e| e["type"] == "message.complete").await;
        assert_eq!(processes(home.path()), before, "{surface}");
        assert!(Arc::ptr_eq(
            &original,
            &runtime.sessions.lock().unwrap()["first"]
        ));
        let history = store::history(home.path(), "first").unwrap();
        assert_eq!(
            history
                .iter()
                .filter(|m| m["text"] == "frozen next run")
                .count(),
            1
        );
        runtime.shutdown().await;
    }
}

#[tokio::test]
async fn a_waiter_on_the_previous_live_wakes_when_its_replacement_closes_before_cleanup() {
    let (home, runtime, hub) = setup();
    old_configuration(home.path());
    let path = home.path().join("pi.cjs");
    let script = fs::read_to_string(&path).unwrap();
    fs::write(path,script.replace("const c=JSON.parse(line);","const c=JSON.parse(line);if(c.type==='prompt'&&c.message==='hold new acknowledgement'){emit({type:'extension_ui_request',method:'setStatus',statusText:'new acknowledgement waiting'});return;}")).unwrap();
    let id = open(&runtime).await;
    let previous = runtime.sessions.lock().unwrap()["first"].clone();
    change_configuration(home.path());
    let mut events = hub.subscribe();
    let first = {
        let runtime = runtime.clone();
        let id = id.clone();
        tokio::spawn(async move {
            runtime
                .call_inner(
                    "alice",
                    "prompt.submit",
                    &json!({"session_id":id,"text":"hold new acknowledgement"}),
                )
                .await
        })
    };
    stop_tests::stop_event(&mut events, |e| {
        e["payload"]["text"] == "new acknowledgement waiting"
    })
    .await;
    let current = runtime.sessions.lock().unwrap()["first"].clone();
    assert!(!Arc::ptr_eq(&previous, &current));
    let waiting = runtime.steer(&previous, "waiting on the previous live", None);
    tokio::pin!(waiting);
    assert!(futures_util::poll!(waiting.as_mut()).is_pending());
    let attachment = current.attachment_gate.lock().await;
    let close = runtime.close_stored("alice", "first");
    tokio::pin!(close);
    assert!(futures_util::poll!(close.as_mut()).is_pending());
    // Neither the first input's ACK nor process cleanup can release its gate.
    // Closing the current Live must directly wake a waiter using the old Live.
    let rejected = tokio::time::timeout(Duration::from_secs(5), waiting.as_mut()).await;
    drop(attachment);
    assert!(close.await.unwrap());
    assert!(first.await.unwrap().is_err());
    assert!(
        matches!(rejected, Ok(Err(Error { code: 4001, .. }))),
        "{rejected:?}"
    );
    assert!(
        !store::history(home.path(), "first")
            .unwrap()
            .iter()
            .any(|m| m["text"] == "waiting on the previous live")
    );
    runtime.shutdown().await;
}

// Unlike the archived independent probe, this barrier observes the actual
// process/pump lifetime, not the admission registry's representation.
async fn pump_released(session: Weak<Live>) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while session.upgrade().is_some() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn failed_readiness_keeps_fifo_uploads_until_the_older_waiter_is_served() {
    for reopen in [false, true] {
        for exit in [false, true] {
            let (home, runtime, hub) = setup();
            old_configuration(home.path());
            idle_stop_pi(home.path());
            let id = open(&runtime).await;
            let old = runtime.sessions.lock().unwrap()["first"].clone();
            let file = runtime.call_inner("alice", "file.attach", &json!({"session_id":id,"name":"earlier.txt","data_url":"data:text/plain;base64,ZWFybGllcg=="})).await.unwrap();
            let ids = [file["id"].as_str().unwrap().to_owned()];
            let recovery = old.recovery_gate.lock().await;
            runtime
                .call_inner("alice", "session.interrupt", &json!({"session_id":id}))
                .await
                .unwrap();
            let first = runtime.submit(&old, "failed replacement", true, true, None, None);
            let second =
                runtime.submit(&old, "earlier hidden result", true, true, None, Some(&ids));
            tokio::pin!(first, second);
            assert!(futures_util::poll!(first.as_mut()).is_pending());
            assert!(futures_util::poll!(second.as_mut()).is_pending());
            let path = home.path().join("pi.cjs");
            let good = fs::read_to_string(&path).unwrap();
            fs::write(&path, good.replace("const c=JSON.parse(line);", "const c=JSON.parse(line);if(c.type==='get_state'){global.readiness=c;emit({type:'extension_ui_request',method:'setStatus',statusText:'readiness waiting'});return;}if(c.type==='release_readiness'){if(c.exit)process.exit(1);emit({type:'response',id:global.readiness.id,command:'get_state',success:false,error:'readiness fixture failure'});}")).unwrap();
            change_configuration(home.path());
            let mut events = hub.subscribe();
            drop(recovery);
            tokio::select! {
                result = &mut first => panic!("startup did not reach readiness: {result:?}"),
                _ = stop_tests::stop_event(&mut events, |e| e["payload"]["text"] == "readiness waiting") => {},
            }
            let starting = runtime.sessions.lock().unwrap()["first"].clone();
            assert_eq!(processes(home.path()).len(), 2);
            let failed = Arc::downgrade(&starting);
            let release =
                Runtime::command(&starting, json!({"type":"release_readiness","exit":exit})).await;
            if exit {
                assert!(release.is_err());
            } else {
                release.unwrap();
            }
            drop(starting);
            let error = first.await.unwrap_err();
            assert_eq!(error.code, 5201);
            if !exit {
                assert!(error.message.contains("readiness fixture failure"));
            }
            pump_released(failed).await;
            assert_eq!(old.input_waiters.load(Ordering::Acquire), 1);
            fs::write(&path, good).unwrap();
            let later = json!({"session_id":id,"text":"later owner prompt","attachments":[]});
            if reopen {
                runtime.open_session("alice", "owl", "first").await.unwrap();
                assert_eq!(
                    runtime
                        .call_inner("alice", "prompt.submit", &later)
                        .await
                        .unwrap_err()
                        .code,
                    4002
                );
            }
            assert!(Path::new(file["path"].as_str().unwrap()).exists());
            assert!(store::history(home.path(), "first").unwrap().is_empty());
            second.await.unwrap();
            let current = runtime.sessions.lock().unwrap()["first"].clone();
            assert!(Arc::ptr_eq(&old.input_gate, &current.input_gate));
            stop_tests::stop_event(&mut events, |e| e["type"] == "message.complete").await;
            runtime
                .call_inner("alice", "prompt.submit", &later)
                .await
                .unwrap();
            stop_tests::stop_event(&mut events, |e| e["type"] == "message.complete").await;
            let history = store::history(home.path(), "first").unwrap();
            let users = history
                .iter()
                .filter(|m| m["role"] == "user")
                .collect::<Vec<_>>();
            assert_eq!(users.len(), 2);
            assert_eq!(
                users[0]["text"],
                format!(
                    "earlier hidden result\n\nAttached files:\n{}",
                    file["path"].as_str().unwrap()
                )
            );
            assert_eq!(users[0]["display_kind"], "hidden");
            assert_eq!(users[1]["text"], "later owner prompt");
            assert_eq!(users[1]["display_kind"], "normal");
            assert!(Path::new(file["path"].as_str().unwrap()).exists());
            let intents: (usize, usize) = store::open(home.path()).unwrap().query_row("SELECT count(*),count(consumed_by) FROM native_prompt_intents WHERE session_id='first'", [], |r| Ok((r.get(0)?,r.get(1)?))).unwrap();
            assert_eq!(intents, (2, 2));
            runtime.shutdown().await;
        }
    }
}

#[tokio::test]
async fn an_exited_replacement_rejects_older_waiters_even_after_the_same_alias_reopens() {
    let (home, runtime, _) = setup();
    old_configuration(home.path());
    let id = open(&runtime).await;
    let old = runtime.sessions.lock().unwrap()["first"].clone();
    change_configuration(home.path());
    let current = runtime
        .open_for_input("alice", "owl", "first")
        .await
        .unwrap();
    assert_eq!(current.id, id);
    let slot = current.input_gate.lock().await;
    let waiting = runtime.submit(&old, "obsolete hidden result", true, true, None, None);
    tokio::pin!(waiting);
    assert!(futures_util::poll!(waiting.as_mut()).is_pending());
    let exited = Arc::downgrade(&current);
    current.process.shutdown().await.unwrap();
    drop(slot);
    drop(current);
    pump_released(exited).await;
    let reopened = runtime.open_session("alice", "owl", "first").await.unwrap();
    assert_eq!(reopened.id, id);
    assert_eq!(waiting.await.unwrap_err().code, 4001);
    assert!(store::history(home.path(), "first").unwrap().is_empty());
    runtime
        .submit(&reopened, "usable reopened owner", false, false, None, None)
        .await
        .unwrap();
    runtime.shutdown().await;
}

#[tokio::test]
async fn closing_a_failed_start_rejects_older_waiters_before_alias_reopen() {
    let (home, runtime, hub) = setup();
    old_configuration(home.path());
    idle_stop_pi(home.path());
    let id = open(&runtime).await;
    let old = runtime.sessions.lock().unwrap()["first"].clone();
    let recovery = old.recovery_gate.lock().await;
    runtime
        .call_inner("alice", "session.interrupt", &json!({"session_id":id}))
        .await
        .unwrap();
    let first = runtime.submit(&old, "failed replacement", true, true, None, None);
    let second = runtime.submit(&old, "obsolete result", true, true, None, None);
    tokio::pin!(first, second);
    assert!(futures_util::poll!(first.as_mut()).is_pending());
    assert!(futures_util::poll!(second.as_mut()).is_pending());
    let path = home.path().join("pi.cjs");
    let good = fs::read_to_string(&path).unwrap();
    fs::write(&path, good.replace("const c=JSON.parse(line);", "const c=JSON.parse(line);if(c.type==='get_state'){global.readiness=c;emit({type:'extension_ui_request',method:'setStatus',statusText:'readiness waiting'});return;}if(c.type==='release_readiness'){emit({type:'response',id:global.readiness.id,command:'get_state',success:false,error:'readiness fixture failure'});}")).unwrap();
    change_configuration(home.path());
    let mut events = hub.subscribe();
    drop(recovery);
    tokio::select! {
        result = &mut first => panic!("startup did not reach readiness: {result:?}"),
        _ = stop_tests::stop_event(&mut events, |e| e["payload"]["text"] == "readiness waiting") => {},
    }
    let starting = runtime.sessions.lock().unwrap()["first"].clone();
    let failed = Arc::downgrade(&starting);
    let closing = runtime.close_stored("alice", "first");
    tokio::pin!(closing);
    assert!(futures_util::poll!(closing.as_mut()).is_pending());
    Runtime::command(&starting, json!({"type":"release_readiness"}))
        .await
        .unwrap();
    drop(starting);
    assert_eq!(first.await.unwrap_err().code, 5201);
    assert!(closing.await.unwrap());
    pump_released(failed).await;
    fs::write(path, good).unwrap();
    let reopened = open(&runtime).await;
    assert_ne!(id, reopened);
    assert_eq!(second.await.unwrap_err().code, 4001);
    assert!(store::history(home.path(), "first").unwrap().is_empty());
    runtime
        .call_inner(
            "alice",
            "prompt.submit",
            &json!({"session_id":reopened,"text":"new owner"}),
        )
        .await
        .unwrap();
    stop_tests::stop_event(&mut events, |e| e["type"] == "message.complete").await;
    let history = store::history(home.path(), "first").unwrap();
    assert_eq!(history.len(), 1);
    assert_eq!(history[0]["text"], "new owner");
    runtime.shutdown().await;
}

#[tokio::test]
async fn bot_deletion_waits_for_stop_recovery_and_the_input_it_admits() {
    let (home, runtime, _) = setup();
    drop(runtime);
    idle_stop_pi(home.path());
    let room = crate::rooms::call(
        home.path(),
        "alice",
        "hexbot.rooms.create",
        &json!({"name":"Race","members":["owl"],"main_bot":"owl"}),
    )
    .unwrap()
    .unwrap()["room"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    db::open(home.path())
        .unwrap()
        .execute(
            "INSERT INTO room_sessions(room_id,bot,stored_session_id) VALUES(?,'owl','room-owl')",
            [&room],
        )
        .unwrap();
    // No ambient runtime: App startup must not start description work here.
    let h = home.path().to_path_buf();
    let app = std::thread::spawn(move || {
        crate::server::App::new(
            h.clone(),
            "127.0.0.1:0".parse().unwrap(),
            h.join("pi.cjs"),
            None,
        )
        .unwrap()
    })
    .join()
    .unwrap();
    let runtime = app.runtime.clone();
    let mut events = app.events.subscribe();
    let id = open(&runtime).await;
    runtime
        .ensure_hidden("alice", "owl", "room-owl")
        .await
        .unwrap();
    let chat = runtime.sessions.lock().unwrap()["first"].clone();
    let room_live = runtime.sessions.lock().unwrap()["room-owl"].clone();
    // Idle Stop leaves only queue recovery. A background result reserves its
    // place behind it before deletion starts.
    let recovery = chat.recovery_gate.lock().await;
    runtime
        .call_inner("alice", "session.interrupt", &json!({"session_id":id}))
        .await
        .unwrap();
    let waiting = runtime.submit(&chat, "background result", true, true, None, None);
    tokio::pin!(waiting);
    assert!(futures_util::poll!(waiting.as_mut()).is_pending());
    // Past its final busy check, deletion would stop the bot's room next.
    fs::write(home.path().join("hold-abort"), "hold room Stop").unwrap();
    let mut deleting = {
        let app = app.clone();
        tokio::spawn(async move {
            app.call("alice", "hexbot.bots.delete", &json!({"name":"owl"}))
                .await
        })
    };
    let refusal = tokio::select! {
        result = &mut deleting => result.unwrap().unwrap_err(),
        _ = stop_tests::stop_event(&mut events, |e| e["payload"]["text"] == "abort waiting") => {
            drop(recovery);
            let started = waiting.await;
            Runtime::command(&room_live, json!({"type":"release_abort"})).await.unwrap();
            panic!(
                "deletion passed its final busy check during Stop recovery; the waiting result then returned {started:?} and deletion {:?}",
                deleting.await.unwrap()
            );
        }
    };
    assert_eq!(refusal.code, 4211);
    assert!(refusal.message.contains("unfinished work"));
    assert!(
        refusal.data.unwrap()["sections"]
            .as_array()
            .unwrap()
            .iter()
            .any(|s| s["id"] == "first")
    );
    assert!(crate::catalog::bot(home.path(), "alice", "owl").is_ok());
    // The admitted result keeps its place and runs once recovery finishes.
    fs::remove_file(home.path().join("hold-abort")).unwrap();
    let mut settled = chat.settled.subscribe();
    drop(recovery);
    assert_eq!(waiting.await.unwrap()["status"], "submitted");
    settled.changed().await.unwrap();
    let results = store::history(home.path(), "first")
        .unwrap()
        .into_iter()
        .filter(|r| r["text"] == "background result")
        .collect::<Vec<_>>();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0]["display_kind"], "hidden");
    let intents: (usize, usize) = store::open(home.path()).unwrap().query_row(
        "SELECT count(*),count(consumed_by) FROM native_prompt_intents WHERE session_id='first' AND text='background result'",
        [], |r| Ok((r.get(0)?, r.get(1)?)),
    ).unwrap();
    assert_eq!(intents, (1, 1));
    // Once the bot is idle again, the same deletion goes ahead.
    assert_eq!(
        app.call("alice", "hexbot.bots.delete", &json!({"name":"owl"}))
            .await
            .unwrap()["deleted"],
        true
    );
    assert!(crate::catalog::bot(home.path(), "alice", "owl").is_err());
    app.shutdown().await;
}

#[tokio::test]
async fn reserved_input_is_busy_before_it_starts_a_run() {
    let (home, runtime, hub) = setup();
    let id = open(&runtime).await;
    let s = runtime.sessions.lock().unwrap()["first"].clone();
    let gate = s.input_gate.lock().await;
    let waiting = runtime.steer(&s, "reserved steer", None);
    tokio::pin!(waiting);
    assert!(futures_util::poll!(waiting.as_mut()).is_pending());
    assert!(!s.state.lock().unwrap().busy);
    assert_eq!(
        runtime.busy_sections("owl"),
        vec![json!({"id":"first","status":"working","owner_id":"alice"})]
    );
    let mut events = hub.subscribe();
    drop(gate);
    assert_eq!(waiting.await.unwrap()["status"], "queued");
    stop_tests::stop_event(&mut events, |e| e["type"] == "message.complete").await;
    assert!(runtime.busy_sections("owl").is_empty());
    assert_eq!(
        store::history(home.path(), "first")
            .unwrap()
            .iter()
            .filter(|r| r["text"] == "reserved steer")
            .count(),
        1
    );
    runtime
        .call_inner("alice", "session.close", &json!({"session_id":id}))
        .await
        .unwrap();
    assert!(runtime.busy_sections("owl").is_empty());
    runtime.shutdown().await;
}

#[tokio::test]
async fn existing_process_input_obeys_bot_and_room_deletion_admission() {
    for room_scope in [false, true] {
        let (home, runtime, hub) = setup();
        let id = open(&runtime).await;
        let s = runtime.sessions.lock().unwrap()["first"].clone();
        let scope = if room_scope {
            let room = crate::rooms::call(
                home.path(),
                "alice",
                "hexbot.rooms.create",
                &json!({"name":"Admission","members":["owl"],"main_bot":"owl"}),
            )
            .unwrap()
            .unwrap()["room"]["id"]
                .as_str()
                .unwrap()
                .to_owned();
            db::open(home.path()).unwrap().execute("INSERT INTO room_sessions(room_id,bot,stored_session_id) VALUES(?,'owl','first')", [&room]).unwrap();
            crate::admission::Scope::Room(room)
        } else {
            crate::admission::Scope::Bot("owl".into())
        };
        let deletion = runtime.admission.pause(scope).await;
        // These callers already own a Live, so they bypass a new process open.
        for queued in [false, true] {
            assert_eq!(
                runtime
                    .submit(&s, "late prompt", queued, queued, None, None)
                    .await
                    .unwrap_err()
                    .code,
                4211
            );
        }
        assert_eq!(
            runtime
                .steer(&s, "late steer", None)
                .await
                .unwrap_err()
                .code,
            4211
        );
        assert!(runtime.busy_sections("owl").is_empty());
        assert!(store::history(home.path(), "first").unwrap().is_empty());
        let intents: usize = store::open(home.path())
            .unwrap()
            .query_row(
                "SELECT count(*) FROM native_prompt_intents WHERE session_id='first'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(intents, 0);
        drop(deletion);
        let mut events = hub.subscribe();
        runtime
            .call_inner(
                "alice",
                "session.steer",
                &json!({"session_id":id,"text":"after deletion boundary"}),
            )
            .await
            .unwrap();
        stop_tests::stop_event(&mut events, |e| e["type"] == "message.complete").await;
        assert_eq!(
            store::history(home.path(), "first")
                .unwrap()
                .iter()
                .filter(|r| r["text"] == "after deletion boundary")
                .count(),
            1
        );
        runtime.shutdown().await;
    }
}

#[path = "runtime_background_tests.rs"]
mod background_tests;
