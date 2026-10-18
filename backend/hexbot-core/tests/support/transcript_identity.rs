use super::*;

const INPUT: &str = "a0117bc9-546e-4279-8829-c52674176836";

fn identity_pi(home: &Path) -> PathBuf {
    let path = fake_pi(home);
    let script = fs::read_to_string(&path).unwrap()
        .replace(":{}});", ":{disposition:c.type==='prompt'?'started':'queued'}});")
        .replace("function complete(text){", "function complete(text){emit({type:'message_start',message:{role:'assistant',content:[]}});")
        .replace("emit({type:'message_end',message:{role:'user',content:c.message}});", "emit({type:'message_start',message:{role:'user',content:c.message}});emit({type:'message_end',message:{role:'user',content:c.message}});");
    fs::write(&path, script).unwrap();
    path
}

struct ProviderRequest {
    body: Value,
    reply: tokio::sync::oneshot::Sender<(u16, String)>,
}
struct Barrier {
    kind: String,
    release: tokio::sync::oneshot::Sender<()>,
}
struct PiFixture {
    home: support::TestHome,
    runtime: std::sync::Arc<Runtime>,
    live: Value,
    events: tokio::sync::broadcast::Receiver<hexbot_core::events::Event>,
    requests: tokio::sync::mpsc::UnboundedReceiver<ProviderRequest>,
    barriers: tokio::sync::mpsc::UnboundedReceiver<Barrier>,
    server: tokio::task::JoinHandle<()>,
}
const LIMIT: Duration = Duration::from_secs(10);
const SECOND: &str = "f4a8b62b-ad7a-4dab-bd53-beb95447cc9f";
const THIRD: &str = "a2361d7c-cebe-4e42-a51a-643a672e4092";
async fn receive<T>(rx: &mut tokio::sync::mpsc::UnboundedReceiver<T>) -> T {
    tokio::time::timeout(LIMIT, rx.recv())
        .await
        .unwrap()
        .unwrap()
}
fn sse(delta: Value, tools: bool) -> String {
    let first = json!({"id":"fixture","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":delta,"finish_reason":null}]});
    let last = json!({"id":"fixture","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{},"finish_reason":if tools{"tool_calls"}else{"stop"}}],"usage":{"prompt_tokens":13,"completion_tokens":3,"total_tokens":16}});
    format!("data: {first}\n\ndata: {last}\n\ndata: [DONE]\n\n")
}
impl ProviderRequest {
    fn answer(self, text: &str) {
        self.reply
            .send((200, sse(json!({"role":"assistant","content":text}), false)))
            .unwrap();
    }
}
impl PiFixture {
    async fn new(instrument: &str) -> Self {
        let home = setup();
        let (tx, requests) = tokio::sync::mpsc::unbounded_channel();
        let (barrier_tx, barriers) = tokio::sync::mpsc::unbounded_channel();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let router = axum::Router::new()
            .route(
                "/v1/chat/completions",
                axum::routing::post(move |axum::Json(body): axum::Json<Value>| {
                    let tx = tx.clone();
                    async move {
                        let (reply, response) = tokio::sync::oneshot::channel();
                        tx.send(ProviderRequest { body, reply }).unwrap();
                        let (status, body) = response.await.unwrap();
                        (
                            axum::http::StatusCode::from_u16(status).unwrap(),
                            [("content-type", "text/event-stream")],
                            body,
                        )
                    }
                }),
            )
            .route(
                "/hold/{kind}",
                axum::routing::get(
                    move |axum::extract::Path(kind): axum::extract::Path<String>| {
                        let tx = barrier_tx.clone();
                        async move {
                            let (release, held) = tokio::sync::oneshot::channel();
                            tx.send(Barrier { kind, release }).unwrap();
                            held.await.unwrap();
                            "released"
                        }
                    },
                ),
            );
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        fs::write(home.path().join("profiles/owl/config.yaml"), format!("model:\n  provider: lmstudio\n  default: test-model\n  api_key: fixture\n  base_url: http://{address}/v1\ntools:\n  enabled_toolsets: []\nmodel_overrides:\n  lmstudio:\n    _default:\n      supports_vision: true\n")).unwrap();
        if instrument == "fallback" {
            db::open(home.path())
                .unwrap()
                .execute(
                    "INSERT INTO settings(key,value) VALUES('fallback_model',?)",
                    [json!("lmstudio/secondary").to_string()],
                )
                .unwrap();
            fs::create_dir_all(home.path().join("profiles/owl/pi")).unwrap();
            fs::write(
                home.path().join("profiles/owl/pi/settings.json"),
                r#"{"retry":{"enabled":false}}"#,
            )
            .unwrap();
        }
        let mut executable = PathBuf::from(std::env::var_os("HEXBOT_TEST_PI").unwrap());
        if !instrument.is_empty() {
            // Only the owned launcher is instrumented. All dependency files and
            // the private extension remain unchanged. Holds await HTTP barriers.
            let modules = executable
                .parent()
                .unwrap()
                .parent()
                .unwrap()
                .join("@earendil-works");
            let session = modules.join("pi-coding-agent/dist/core/agent-session.js");
            let agent = modules.join("pi-agent-core/dist/agent.js");
            let cli = modules.join("pi-coding-agent/dist/cli.js");
            let wrapper = home.path().join("identity-pi.mjs");
            let source = format!(
                r#"#!/usr/bin/env node
const {{AgentSession}} = await import({session});
const {{Agent}} = await import({agent});
const mode = {mode};
const hold = async kind => {{ const r = await fetch('http://{address}/hold/'+kind); if(!r.ok) throw new Error('barrier'); }};
if (mode === 'dequeue') {{
  const prompt = Agent.prototype.prompt;
  Agent.prototype.prompt = async function(...args) {{
    if (!this.identityObserved) {{
      this.identityObserved = true;
      const queue = this.followUpQueue;
      const drain = queue.drain.bind(queue);
      let held = false;
      queue.drain = async () => {{ const messages = drain(); if (messages.length && !held) {{ held = true; await hold('dequeued'); }} return messages; }};
    }}
    return prompt.apply(this,args);
  }};
}}
if (mode === 'settlement') {{
  const normalize = AgentSession.prototype._normalizePromptImages;
  let first = true;
  AgentSession.prototype._normalizePromptImages = async function(...args) {{ if(first) {{ first = false; await hold('old-preflight'); }} return normalize.apply(this,args); }};
  const settled = AgentSession.prototype._emitAgentSettled;
  AgentSession.prototype._emitAgentSettled = async function(...args) {{ const result = await settled.apply(this,args); this._emit({{type:'extension_ui_request',method:'notify',message:'identity settlement barrier'}}); return result; }};
}}
if (mode === 'late-settlement') {{
  const normalize = AgentSession.prototype._normalizePromptImages;
  let firstInput = true;
  AgentSession.prototype._normalizePromptImages = async function(...args) {{ if(firstInput) {{ firstInput = false; await hold('prepared-input'); }} return normalize.apply(this,args); }};
  const settled = AgentSession.prototype._emitAgentSettled;
  let firstEnd = true;
  AgentSession.prototype._emitAgentSettled = async function(...args) {{ if(firstEnd) {{ firstEnd = false; await hold('old-settlement'); }} const result = await settled.apply(this,args); this._emit({{type:'extension_ui_request',method:'notify',message:'identity late settlement boundary'}}); return result; }};
}}
if (mode === 'transform') {{
  const input = AgentSession.prototype._runInputHandlers;
  AgentSession.prototype._runInputHandlers = async function(text,...args) {{ if(text === '/handled-fixture') return undefined; const result = await input.call(this,text,...args); if(result) result.text = 'transformed input'; return result; }};
  const prompt = AgentSession.prototype.prompt;
  AgentSession.prototype.prompt = async function(text,...args) {{ const result = await prompt.call(this,text,...args); if(text === '/handled-fixture') this._emit({{type:'extension_ui_request',method:'notify',message:'identity handled boundary'}}); return result; }};
}}
await import({cli});
"#,
                session = json!(session.to_string_lossy()),
                agent = json!(agent.to_string_lossy()),
                cli = json!(cli.to_string_lossy()),
                mode = json!(instrument)
            );
            fs::write(&wrapper, source).unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&wrapper, fs::Permissions::from_mode(0o755)).unwrap();
            }
            executable = wrapper;
        }
        let hub = EventHub::new();
        let events = hub.subscribe();
        let runtime = Runtime::new(home.path().into(), hub, executable).unwrap();
        let live = open(&runtime, "alice").await["section"]["live_session_id"].clone();
        Self {
            home,
            runtime,
            live,
            events,
            requests,
            barriers,
            server,
        }
    }
    async fn submit(&self, input: &str, hidden: bool, queued: bool) -> Value {
        tokio::time::timeout(LIMIT, self.runtime.call("alice", "prompt.submit", &json!({"session_id":self.live,"text":"same","input_id":input,"display_kind":if hidden{"hidden"}else{"normal"},"queued":queued}))).await.unwrap().unwrap().unwrap()
    }
    async fn until(&mut self, kind: &str) -> Vec<Value> {
        self.until_event(|event| event["type"] == kind).await
    }
    async fn until_event(&mut self, done: impl Fn(&Value) -> bool) -> Vec<Value> {
        tokio::time::timeout(LIMIT, async {
            let mut seen = vec![];
            loop {
                let event = self.events.recv().await.unwrap().frame["params"].clone();
                if event["session_id"] == self.live {
                    let done = done(&event);
                    seen.push(event);
                    if done {
                        return seen;
                    }
                }
            }
        })
        .await
        .unwrap()
    }
    fn rows(&self) -> Vec<Value> {
        runtime_store::history(self.home.path(), "section-a").unwrap()
    }
    async fn close(self) {
        self.runtime.shutdown().await;
        self.server.abort();
    }
}

#[tokio::test]
#[ignore = "requires HEXBOT_TEST_PI to the pinned Pi executable"]
async fn actual_pi_transcript_identity_fragments_tools_hidden_and_reconcile() {
    let mut f = PiFixture::new("").await;
    let conn = runtime_store::open(f.home.path()).unwrap();
    let frozen: (String, String) = conn
        .query_row(
            "SELECT prompt,options FROM native_sessions WHERE stored_id='section-a'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    let mut image_bytes = std::io::Cursor::new(vec![]);
    image::DynamicImage::new_rgb8(1, 1)
        .write_to(&mut image_bytes, image::ImageFormat::Png)
        .unwrap();
    use base64::Engine;
    f.runtime.call("alice","image.attach_bytes",&json!({"session_id":f.live,"filename":"pixel.png","content_base64":base64::engine::general_purpose::STANDARD.encode(image_bytes.into_inner())})).await.unwrap().unwrap();
    assert_eq!(f.submit(INPUT, true, false).await["input_id"], INPUT);
    let first = receive(&mut f.requests).await;
    assert!(first.body.to_string().contains("image_url"));
    let mut bodies = vec![first.body.clone()];
    first.reply.send((200, sse(json!({"role":"assistant","reasoning_content":"consider","content":"interim","tool_calls":[{"index":0,"id":"memory-call","type":"function","function":{"name":"memory","arguments":"{\"action\":\"read\"}"}},{"index":1,"id":"clarify-call","type":"function","function":{"name":"clarify","arguments":"{\"question\":\"Which one?\"}"}}]}), true))).unwrap();
    let mut events = f.until("clarify.request").await;
    let card = &events.last().unwrap()["payload"];
    assert!(card["turn_id"].is_string());
    assert!(card.get("message_id").is_none());
    f.runtime
        .call(
            "alice",
            "clarify.respond",
            &json!({"session_id":f.live,"request_id":card["request_id"],"answer":"first"}),
        )
        .await
        .unwrap()
        .unwrap();
    let second = receive(&mut f.requests).await;
    bodies.push(second.body.clone());
    let before_terminal = f.rows();
    assert_eq!(
        before_terminal
            .iter()
            .filter(|row| row["role"] == "assistant")
            .count(),
        1
    );
    assert_eq!(
        before_terminal
            .iter()
            .find(|row| row["role"] == "user")
            .unwrap()["input_id"],
        INPUT
    );
    second.answer("final");
    events.extend(f.until("message.complete").await);
    let starts = events
        .iter()
        .filter(|e| e["type"] == "message.start")
        .collect::<Vec<_>>();
    assert_eq!(starts.len(), 1);
    let turn = &starts[0]["payload"]["turn_id"];
    assert!(turn.is_string());
    assert!(starts[0]["payload"].get("message_id").is_none());
    let rows = f.rows();
    let user = rows.iter().find(|r| r["role"] == "user").unwrap();
    assert_eq!(user["input_id"], INPUT);
    assert_eq!(user["display_kind"], "hidden");
    assert_eq!(user["turn_id"], *turn);
    let assistants = rows
        .iter()
        .filter(|r| r["role"] == "assistant")
        .collect::<Vec<_>>();
    assert_eq!(assistants.len(), 2);
    assert_eq!(assistants[0]["reasoning"], "consider");
    assert_ne!(assistants[0]["row_id"], assistants[1]["row_id"]);
    for row in &assistants {
        assert_eq!(row["turn_id"], *turn);
    }
    for event in events.iter().filter(|e| {
        matches!(
            e["type"].as_str(),
            Some(
                "message.delta"
                    | "reasoning.delta"
                    | "message.interim"
                    | "tool.start"
                    | "tool.complete"
                    | "message.complete"
            )
        )
    }) {
        assert_eq!(event["payload"]["turn_id"], *turn, "{event}");
        let final_fragment =
            event["type"] == "message.complete" || event["payload"]["text"] == "final";
        assert_eq!(
            event["payload"]["message_id"],
            assistants[usize::from(final_fragment)]["row_id"],
            "{event}"
        );
    }
    assert!(events.iter().any(|e| e["type"] == "message.interim"));
    assert!(events.iter().any(|e| e["type"] == "reasoning.delta"));
    assert!(events.iter().any(|e| e["type"] == "tool.start"));
    assert!(events.iter().any(|e| e["type"] == "tool.complete"));
    let tool = rows.iter().find(|r| r["role"] == "tool").unwrap();
    assert_eq!(tool["tool_call_id"], "memory-call");
    assert_ne!(tool["row_id"], assistants[0]["row_id"]);
    assert!(tool.get("message_id").is_none());
    let usage = runtime_store::usage(f.home.path(), "section-a").unwrap();
    let frozen_after: (String, String) = conn
        .query_row(
            "SELECT prompt,options FROM native_sessions WHERE stored_id='section-a'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(frozen_after, frozen);
    f.runtime.shutdown().await;
    let path = runtime_store::session_dir(f.home.path(), "section-a")
        .unwrap()
        .join("conversation.jsonl");
    let raw = fs::read(&path).unwrap();
    for forbidden in ["input_id", "turn_id", "message_id", "_input_intent", INPUT] {
        assert!(!String::from_utf8_lossy(&raw).contains(forbidden));
        assert!(!json!(bodies).to_string().contains(forbidden));
    }
    let entries = String::from_utf8(raw.clone())
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    let mut stmt = conn
        .prepare("SELECT raw_json FROM native_pi_journal WHERE session_id='section-a'")
        .unwrap();
    for journal in stmt.query_map([], |r| r.get::<_, String>(0)).unwrap() {
        let message: Value = serde_json::from_str(&journal.unwrap()).unwrap();
        assert!(entries.iter().any(|entry| entry["message"] == message));
    }
    runtime_store::reconcile(f.home.path(), "owl", "section-a", "alice").unwrap();
    assert_eq!(fs::read(&path).unwrap(), raw);
    for row in &rows {
        assert!(f.rows().contains(row));
    }
    assert_eq!(
        runtime_store::usage(f.home.path(), "section-a").unwrap(),
        usage
    );
    let restarted = Runtime::new(
        f.home.path().into(),
        EventHub::new(),
        PathBuf::from(std::env::var_os("HEXBOT_TEST_PI").unwrap()),
    )
    .unwrap();
    let reopened = open(&restarted, "alice").await;
    for row in &rows {
        assert!(reopened["messages"].as_array().unwrap().contains(row));
    }
    restarted.shutdown().await;
    f.server.abort();
}

#[tokio::test]
#[ignore = "requires HEXBOT_TEST_PI to the pinned Pi executable"]
async fn actual_pi_transcript_identity_held_dequeue_late_identical_steer_omits_ids() {
    let mut f = PiFixture::new("dequeue").await;
    f.submit(INPUT, false, false).await;
    let first = receive(&mut f.requests).await;
    assert_eq!(f.submit(SECOND, false, true).await["input_id"], SECOND);
    first.answer("first");
    let held = receive(&mut f.barriers).await;
    assert_eq!(held.kind, "dequeued");
    let ack = f
        .runtime
        .call(
            "alice",
            "session.steer",
            &json!({"session_id":f.live,"text":"same","input_id":THIRD}),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(ack["input_id"], THIRD);
    held.release.send(()).unwrap();
    let second = receive(&mut f.requests).await;
    assert_eq!(
        second.body["messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|m| m["role"] == "user")
            .count(),
        2
    );
    second.answer("second");
    let third = receive(&mut f.requests).await;
    assert_eq!(
        third.body["messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|m| m["role"] == "user")
            .count(),
        3
    );
    third.answer("third");
    let events = f.until("message.complete").await;
    assert_eq!(
        events
            .iter()
            .filter(|e| e["type"] == "message.start")
            .count(),
        1
    );
    let rows = f.rows();
    let users = rows
        .iter()
        .filter(|r| r["role"] == "user")
        .collect::<Vec<_>>();
    assert_eq!(users.len(), 3);
    assert_eq!(users[0]["input_id"], INPUT);
    assert!(users[1].get("input_id").is_none());
    assert!(users[2].get("input_id").is_none());
    let turn = &users[0]["turn_id"];
    assert!(turn.is_string());
    for row in rows
        .iter()
        .filter(|r| matches!(r["role"].as_str(), Some("user" | "assistant")))
    {
        assert_eq!(row["turn_id"], *turn);
    }
    let assistant_ids = rows
        .iter()
        .filter(|r| r["role"] == "assistant")
        .map(|r| r["row_id"].as_str().unwrap())
        .collect::<std::collections::HashSet<_>>();
    assert_eq!(assistant_ids.len(), 3);
    f.close().await;
}

#[tokio::test]
#[ignore = "requires HEXBOT_TEST_PI to the pinned Pi executable"]
async fn actual_pi_transcript_identity_unstarted_old_settlement_omits_association() {
    let mut f = PiFixture::new("settlement").await;
    let runtime = f.runtime.clone();
    let live = f.live.clone();
    let older = tokio::spawn(async move {
        runtime
            .call(
                "alice",
                "prompt.submit",
                &json!({"session_id":live,"text":"same","input_id":INPUT}),
            )
            .await
            .unwrap()
            .unwrap()
    });
    let held = receive(&mut f.barriers).await;
    assert_eq!(held.kind, "old-preflight");
    f.submit(SECOND, false, true).await;
    let next = receive(&mut f.requests).await;
    let starts = f.until("message.start").await;
    let new_turn = starts.last().unwrap()["payload"]["turn_id"].clone();
    held.release.send(()).unwrap();
    assert_eq!(
        tokio::time::timeout(LIMIT, older).await.unwrap().unwrap()["input_id"],
        INPUT
    );
    let observed = f
        .until_event(|event| {
            event["type"] == "status.update"
                && event["payload"]["text"] == "identity settlement barrier"
        })
        .await;
    assert_eq!(
        observed.last().unwrap()["payload"]["text"],
        "identity settlement barrier"
    );
    assert!(observed.iter().all(|e| e["type"] != "message.complete"));
    assert_eq!(
        f.runtime
            .call("alice", "session.status", &json!({"session_id":f.live}))
            .await
            .unwrap()
            .unwrap()["status"],
        "working"
    );
    next.answer("new");
    // Preserve the stronger completion probe in evidence. On this base, the
    // older accepted-but-unstarted input leaves a display entry pending. That
    // PR111 admission policy is separate: this observer must not clear it.
    let ended = f
        .until_event(|event| {
            event["type"] == "status.update"
                && event["payload"]["text"] == "identity settlement barrier"
        })
        .await;
    assert!(
        ended
            .iter()
            .all(|event| event["type"] != "message.complete")
    );
    assert_eq!(
        f.runtime
            .call("alice", "session.status", &json!({"session_id":f.live}))
            .await
            .unwrap()
            .unwrap()["status"],
        "working"
    );
    let rows = f.rows();
    let users = rows
        .iter()
        .filter(|r| r["role"] == "user")
        .collect::<Vec<_>>();
    assert_eq!(users.len(), 1);
    assert_eq!(users[0]["input_id"], SECOND);
    assert_eq!(users[0]["turn_id"], new_turn);
    assert!(rows.iter().all(|row| row["input_id"] != INPUT));
    f.close().await;
}

#[tokio::test]
#[ignore = "requires HEXBOT_TEST_PI to the pinned Pi executable"]
async fn actual_pi_transcript_identity_real_old_end_settles_after_new_start() {
    let mut f = PiFixture::new("late-settlement").await;
    let runtime = f.runtime.clone();
    let live = f.live.clone();
    let prepared = tokio::spawn(async move {
        runtime
            .call(
                "alice",
                "prompt.submit",
                &json!({"session_id":live,"text":"same","input_id":INPUT}),
            )
            .await
            .unwrap()
            .unwrap()
    });
    let input = receive(&mut f.barriers).await;
    assert_eq!(input.kind, "prepared-input");
    f.submit(SECOND, false, true).await;
    receive(&mut f.requests).await.answer("old");
    let old_settle = receive(&mut f.barriers).await;
    assert_eq!(old_settle.kind, "old-settlement");
    let old_start = f.until("message.start").await;
    let old_turn = old_start.last().unwrap()["payload"]["turn_id"].clone();
    input.release.send(()).unwrap();
    assert_eq!(
        tokio::time::timeout(LIMIT, prepared)
            .await
            .unwrap()
            .unwrap()["input_id"],
        INPUT
    );
    let next = receive(&mut f.requests).await;
    let new_start = f.until("message.start").await;
    let new_turn = new_start.last().unwrap()["payload"]["turn_id"].clone();
    assert_ne!(new_turn, old_turn);
    old_settle.release.send(()).unwrap();
    let old_terminal = f.until("message.complete").await;
    let old = &old_terminal.last().unwrap()["payload"];
    assert_eq!(old["turn_id"], old_turn);
    assert_eq!(old["text"], "old");
    assert!(
        old_terminal
            .iter()
            .all(|e| !(e["type"] == "status.update" && e["payload"]["kind"] == "idle"))
    );
    assert_eq!(
        f.runtime
            .call("alice", "session.status", &json!({"session_id":f.live}))
            .await
            .unwrap()
            .unwrap()["status"],
        "working"
    );
    next.answer("new");
    let new_terminal = f.until("message.complete").await;
    let new = &new_terminal.last().unwrap()["payload"];
    assert_eq!(new["turn_id"], new_turn);
    assert_eq!(new["text"], "new");
    let rows = f.rows();
    let users = rows
        .iter()
        .filter(|r| r["role"] == "user")
        .collect::<Vec<_>>();
    assert_eq!(users.len(), 2);
    // Submission order differs from actual Pi user order. Only the explicit
    // started slot can bind these equal-text messages to their correct keys.
    assert_eq!(users[0]["input_id"], SECOND);
    assert_eq!(users[0]["turn_id"], old_turn);
    assert_eq!(users[1]["input_id"], INPUT);
    assert_eq!(users[1]["turn_id"], new_turn);
    let assistants = rows
        .iter()
        .filter(|r| r["role"] == "assistant")
        .collect::<Vec<_>>();
    assert_eq!(assistants.len(), 2);
    assert_eq!(old["message_id"], assistants[0]["row_id"]);
    assert_eq!(new["message_id"], assistants[1]["row_id"]);
    assert_ne!(assistants[0]["row_id"], assistants[1]["row_id"]);
    f.close().await;
}

#[tokio::test]
#[ignore = "requires HEXBOT_TEST_PI to the pinned Pi executable"]
async fn actual_pi_transcript_identity_reversed_settlements_omit_terminal_ids() {
    let mut f = PiFixture::new("late-settlement").await;
    let runtime = f.runtime.clone();
    let live = f.live.clone();
    let prepared = tokio::spawn(async move {
        runtime
            .call(
                "alice",
                "prompt.submit",
                &json!({"session_id":live,"text":"same","input_id":INPUT}),
            )
            .await
            .unwrap()
            .unwrap()
    });
    let input = receive(&mut f.barriers).await;
    assert_eq!(input.kind, "prepared-input");
    f.submit(SECOND, false, true).await;
    receive(&mut f.requests).await.answer("old");
    let old_settle = receive(&mut f.barriers).await;
    assert_eq!(old_settle.kind, "old-settlement");
    input.release.send(()).unwrap();
    assert_eq!(
        tokio::time::timeout(LIMIT, prepared)
            .await
            .unwrap()
            .unwrap()["input_id"],
        INPUT
    );
    receive(&mut f.requests).await.answer("new");
    let early = f
        .until_event(|e| {
            e["type"] == "status.update"
                && e["payload"]["text"] == "identity late settlement boundary"
        })
        .await;
    assert!(early.iter().all(|e| e["type"] != "message.complete"));
    assert_eq!(
        f.runtime
            .call("alice", "session.status", &json!({"session_id":f.live}))
            .await
            .unwrap()
            .unwrap()["status"],
        "working"
    );
    let before = f.rows();
    old_settle.release.send(()).unwrap();
    let ended = f.until("message.complete").await;
    let terminal = &ended.last().unwrap()["payload"];
    assert_eq!(terminal["text"], "new");
    assert!(terminal.get("turn_id").is_none());
    assert!(terminal.get("message_id").is_none());
    let rows = f.rows();
    assert_eq!(rows, before);
    let assistants = rows
        .iter()
        .filter(|r| r["role"] == "assistant")
        .collect::<Vec<_>>();
    assert_eq!(assistants.len(), 2);
    assert!(assistants.iter().all(|r| r["turn_id"].is_string()));
    assert_ne!(assistants[0]["turn_id"], assistants[1]["turn_id"]);
    assert_ne!(assistants[0]["row_id"], assistants[1]["row_id"]);
    let users = rows
        .iter()
        .filter(|r| r["role"] == "user")
        .collect::<Vec<_>>();
    assert_eq!(users.len(), 2);
    assert_eq!(users[0]["input_id"], SECOND);
    assert_eq!(users[1]["input_id"], INPUT);
    f.close().await;
}

#[tokio::test]
#[ignore = "requires HEXBOT_TEST_PI to the pinned Pi executable"]
async fn actual_pi_transcript_identity_transform_and_handled_omit_unproven_rows() {
    let mut f = PiFixture::new("transform").await;
    f.submit(INPUT, false, false).await;
    let request = receive(&mut f.requests).await;
    assert!(request.body.to_string().contains("transformed input"));
    assert!(!request.body.to_string().contains(INPUT));
    request.answer("done");
    f.until("message.complete").await;
    let rows = f.rows();
    let user = rows.iter().find(|r| r["role"] == "user").unwrap();
    assert_eq!(user["text"], "transformed input");
    assert_eq!(user["input_id"], INPUT);
    let ack = f
        .runtime
        .call(
            "alice",
            "prompt.submit",
            &json!({"session_id":f.live,"text":"/handled-fixture","input_id":SECOND}),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(ack["input_id"], SECOND);
    // The marker follows preflight in the same event stream. An unrelated RPC
    // response cannot order the separate runtime event pump before this read.
    f.until_event(|e| {
        e["type"] == "status.update" && e["payload"]["text"] == "identity handled boundary"
    })
    .await;
    assert_eq!(f.rows(), rows);
    assert_eq!(
        runtime_store::open(f.home.path())
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM native_prompt_intents WHERE id=?",
                [SECOND],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
    assert!(f.requests.try_recv().is_err());
    f.close().await;
}

#[tokio::test]
#[ignore = "requires HEXBOT_TEST_PI to the pinned Pi executable"]
async fn actual_pi_transcript_identity_userless_fallback_is_a_new_operation() {
    let mut f = PiFixture::new("fallback").await;
    f.submit(INPUT, true, false).await;
    let first = receive(&mut f.requests).await;
    assert_eq!(first.body["model"], "test-model");
    first
        .reply
        .send((
            400,
            json!({"error":{"message":"invalid request fixture","type":"invalid_request_error"}})
                .to_string(),
        ))
        .unwrap();
    let second = receive(&mut f.requests).await;
    assert_eq!(second.body["model"], "secondary");
    let user_contents = second.body["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|m| m["role"] == "user")
        .map(|m| runtime_store::text(&m["content"]))
        .collect::<Vec<_>>();
    assert_eq!(
        user_contents,
        [
            "same",
            "The model service failed. Continue the current task from the existing conversation and tool results. Do not repeat completed actions."
        ]
    );
    second.answer("fallback");
    let events = f.until("message.complete").await;
    let turns = events
        .iter()
        .filter(|event| event["type"] == "message.start")
        .map(|event| event["payload"]["turn_id"].clone())
        .collect::<Vec<_>>();
    assert_eq!(turns.len(), 2);
    assert!(turns.iter().all(Value::is_string));
    assert_ne!(turns[0], turns[1]);
    let rows = f.rows();
    let users = rows
        .iter()
        .filter(|row| row["role"] == "user")
        .collect::<Vec<_>>();
    assert_eq!(users.len(), 1);
    assert_eq!(users[0]["input_id"], INPUT);
    assert_eq!(users[0]["turn_id"], turns[0]);
    let assistants = rows
        .iter()
        .filter(|row| row["role"] == "assistant")
        .collect::<Vec<_>>();
    assert_eq!(assistants.len(), 1);
    assert_eq!(assistants[0]["turn_id"], turns[1]);
    let terminal = &events.last().unwrap()["payload"];
    assert_eq!(terminal["turn_id"], turns[1]);
    assert_eq!(terminal["message_id"], assistants[0]["row_id"]);
    assert_eq!(terminal["text"], "fallback");
    f.close().await;
}

#[tokio::test]
async fn transcript_identity_compact_and_eof_do_not_invent_durable_fragments() {
    for eof in [false, true] {
        let home = setup();
        let path = identity_pi(home.path());
        if eof {
            let script = fs::read_to_string(&path).unwrap().replace(
                "function complete(text){",
                "function complete(text){process.exit(0);",
            );
            fs::write(&path, script).unwrap();
        }
        let hub = EventHub::new();
        let mut events = hub.subscribe();
        let runtime = Runtime::new(home.path().into(), hub, path).unwrap();
        let live = open(&runtime, "alice").await["section"]["live_session_id"].clone();
        runtime
            .call(
                "alice",
                "prompt.submit",
                &json!({"session_id":live,"text":if eof{"same"}else{"/compact"},"input_id":INPUT}),
            )
            .await
            .unwrap()
            .unwrap();
        let start = next_kind(&mut events, "message.start").await;
        let end = next_kind(&mut events, "message.complete").await;
        assert!(start["payload"].get("message_id").is_none());
        assert!(end["payload"].get("message_id").is_none());
        if eof {
            assert!(start["payload"]["turn_id"].is_string());
            assert_eq!(end["payload"]["turn_id"], start["payload"]["turn_id"]);
            assert_eq!(end["payload"]["status"], "error");
            assert!(
                runtime_store::history(home.path(), "section-a")
                    .unwrap()
                    .iter()
                    .all(|row| row["role"] != "assistant")
            );
        } else {
            assert!(end["payload"].get("turn_id").is_none());
            assert!(
                runtime_store::history(home.path(), "section-a")
                    .unwrap()
                    .iter()
                    .all(|row| row.get("input_id").is_none())
            );
        }
        runtime.shutdown().await;
    }
}

#[tokio::test]
async fn transcript_identity_capability_is_on_the_existing_hexbot_info_rpc() {
    let home = support::TestHome::new();
    let executable = fake_pi(home.path());
    let app = hexbot_core::server::App::new(
        home.path().into(),
        "127.0.0.1:0".parse().unwrap(),
        executable,
        None,
    )
    .unwrap();
    assert_eq!(
        app.call("local", "hexbot.info", &json!({})).await.unwrap()["transcript_identity"],
        true
    );
    assert!(app.call("local", "daemon.info", &json!({})).await.is_err());
    app.runtime.shutdown().await;
}

#[tokio::test]
async fn transcript_identity_binds_only_the_started_user_and_real_fragment() {
    let home = setup();
    let hub = EventHub::new();
    let mut events = hub.subscribe();
    let runtime = Runtime::new(home.path().into(), hub, identity_pi(home.path())).unwrap();
    let opened = open(&runtime, "alice").await;
    let live = &opened["section"]["live_session_id"];
    let ack = runtime
        .call(
            "alice",
            "prompt.submit",
            &json!({"session_id":live,"text":"same","input_id":INPUT}),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(ack["input_id"], INPUT);
    let start = next_kind(&mut events, "message.start").await;
    assert!(start["payload"]["turn_id"].is_string());
    assert!(start["payload"].get("message_id").is_none());
    let delta = next_kind(&mut events, "message.delta").await;
    let end = next_kind(&mut events, "message.complete").await;
    let rows = runtime_store::history(home.path(), "section-a").unwrap();
    assert_eq!(rows[0]["input_id"], INPUT);
    assert_eq!(rows[0]["turn_id"], start["payload"]["turn_id"]);
    assert_eq!(rows[1]["row_id"], delta["payload"]["message_id"]);
    assert_eq!(rows[1]["turn_id"], start["payload"]["turn_id"]);
    assert_eq!(end["payload"]["message_id"], rows[1]["row_id"]);
    assert_eq!(end["payload"]["turn_id"], rows[1]["turn_id"]);
    runtime.shutdown().await;
}

#[tokio::test]
async fn transcript_identity_rejects_ids_before_taking_paired_uploads() {
    let home = setup();
    let runtime = Runtime::new(
        home.path().into(),
        EventHub::new(),
        identity_pi(home.path()),
    )
    .unwrap();
    let opened = open(&runtime, "alice").await;
    let live = &opened["section"]["live_session_id"];
    let attach = runtime.call("alice", "file.attach", &json!({"session_id":live,"name":"paired.txt","data_url":"data:text/plain;base64,cGFpcmVk"})).await.unwrap().unwrap();
    runtime_store::stage_prompt(home.path(), "other-session", "other", "normal").unwrap();
    // A valid key already reserved by a different conversation cannot be taken over.
    runtime_store::open(home.path()).unwrap().execute("INSERT INTO native_prompt_intents(id,session_id,text,display_kind,created_at) VALUES (?,'other-session','same','normal',0)",[INPUT]).unwrap();
    for id in [json!("invalid"), json!(17), json!(INPUT)] {
        for method in ["prompt.submit", "session.steer"] {
            let result = runtime
                .call(
                    "alice",
                    method,
                    &json!({"session_id":live,"text":"same","input_id":id,"attachments":[]}),
                )
                .await
                .unwrap();
            assert_eq!(result.unwrap_err().code, 4202);
        }
    }
    assert!(
        runtime_store::history(home.path(), "section-a")
            .unwrap()
            .is_empty()
    );
    // The upload is still selectable after every rejected request.
    runtime
        .call(
            "alice",
            "prompt.submit",
            &json!({"session_id":live,"text":"healthy","attachments":[attach["id"]]}),
        )
        .await
        .unwrap()
        .unwrap();
    runtime.shutdown().await;
}

#[test]
fn transcript_identity_explicit_seed_never_falls_back_to_equal_text() {
    let home = setup();
    runtime_store::stage_prompt(home.path(), "section-a", "same", "hidden").unwrap();
    let raw = json!({"role":"user","content":"same","timestamp":1234});
    assert!(
        runtime_store::project_seeded(
            home.path(),
            "section-a",
            "alice",
            "owl",
            &raw,
            None,
            Some(&json!({"_input_intent":INPUT,"input_id":INPUT}))
        )
        .is_err()
    );
    assert!(
        runtime_store::history(home.path(), "section-a")
            .unwrap()
            .is_empty()
    );
    runtime_store::project_seeded(home.path(), "section-a", "alice", "owl", &raw, None, None)
        .unwrap();
    let rows = runtime_store::history(home.path(), "section-a").unwrap();
    assert_eq!(rows[0]["display_kind"], "hidden");
    assert!(rows[0].get("input_id").is_none());
}

#[tokio::test]
async fn transcript_identity_reconcile_preserves_committed_seeds_and_omits_raw_only_input() {
    let home = setup();
    let runtime = Runtime::new(
        home.path().into(),
        EventHub::new(),
        identity_pi(home.path()),
    )
    .unwrap();
    open(&runtime, "alice").await;
    runtime.shutdown().await;
    let raw_user =
        json!({"role":"user","content":[{"type":"text","text":"same"}],"timestamp":1000});
    let raw_assistant = json!({"role":"assistant","content":[{"type":"text","text":"same"}],"timestamp":1001,"stopReason":"stop","model":"fixture","provider":"test","usage":{"input":2,"output":1,"cost":{"total":0.1}}});
    runtime_store::stage_prompt_with_id(home.path(), "section-a", "same", "normal", Some(INPUT))
        .unwrap();
    let seed =
        json!({"_input_intent":INPUT,"row_id":"user-row","turn_id":"turn-a","input_id":INPUT});
    assert!(
        runtime_store::project_seeded(
            home.path(),
            "section-a",
            "bob",
            "owl",
            &raw_user,
            None,
            Some(&seed)
        )
        .is_err()
    );
    runtime_store::project_seeded(
        home.path(),
        "section-a",
        "alice",
        "owl",
        &raw_user,
        None,
        Some(&seed),
    )
    .unwrap();
    for row_id in ["fragment-one", "fragment-two"] {
        runtime_store::project_seeded(
            home.path(),
            "section-a",
            "alice",
            "owl",
            &raw_assistant,
            None,
            Some(&json!({"row_id":row_id,"turn_id":"turn-a"})),
        )
        .unwrap();
    }
    let committed = runtime_store::history(home.path(), "section-a").unwrap();
    let usage = runtime_store::usage(home.path(), "section-a").unwrap();
    runtime_store::stage_prompt_with_id(home.path(), "section-a", "same", "normal", Some(SECOND))
        .unwrap();
    let dir = runtime_store::session_dir(home.path(), "section-a").unwrap();
    let path = dir.join("conversation.jsonl");
    let mut lines = vec![
        json!({"type":"session","version":3,"id":"section-a","timestamp":"2026-10-18T00:00:00Z","cwd":home.workspace()}),
    ];
    let mut parent = Value::Null;
    for (index, message) in [&raw_user, &raw_assistant, &raw_assistant, &raw_user]
        .into_iter()
        .enumerate()
    {
        let id = format!("entry-{index}");
        lines.push(json!({"type":"message","id":id,"parentId":parent,"timestamp":"2026-10-18T00:00:00Z","message":message}));
        parent = json!(id);
    }
    let bytes = lines
        .iter()
        .map(Value::to_string)
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    fs::write(&path, &bytes).unwrap();
    for _ in 0..2 {
        runtime_store::reconcile(home.path(), "owl", "section-a", "alice").unwrap();
    }
    let recovered = runtime_store::history(home.path(), "section-a").unwrap();
    assert_eq!(&recovered[..3], committed.as_slice());
    assert_eq!(recovered.len(), 4);
    assert_eq!(recovered[3]["text"], "same");
    assert!(recovered[3].get("input_id").is_none());
    assert!(recovered[3].get("turn_id").is_none());
    assert_eq!(
        runtime_store::usage(home.path(), "section-a").unwrap(),
        usage
    );
    assert_eq!(fs::read_to_string(&path).unwrap(), bytes);
    assert!(
        runtime_store::stage_prompt_with_id(
            home.path(),
            "section-a",
            "same",
            "normal",
            Some(INPUT)
        )
        .is_err()
    );
    let conn = runtime_store::open(home.path()).unwrap();
    assert_eq!(
        conn.query_row(
            "SELECT COUNT(*) FROM native_prompt_intents WHERE id=?",
            [SECOND],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
    let projected: String = conn
        .query_row(
            "SELECT message_json FROM native_messages WHERE session_id='section-a' AND seq=1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(!projected.contains("_input_intent"));
    // An exact seed selected for display policy, such as PR111's matcher,
    // cannot silently become a client identity binding.
    runtime_store::stage_prompt_with_id(
        home.path(),
        "section-a",
        "different",
        "hidden",
        Some(THIRD),
    )
    .unwrap();
    runtime_store::project_seeded(
        home.path(),
        "section-a",
        "alice",
        "owl",
        &raw_user,
        None,
        Some(&json!({"_input_intent":THIRD})),
    )
    .unwrap();
    let legacy_bound = runtime_store::history(home.path(), "section-a").unwrap();
    assert_eq!(legacy_bound.last().unwrap()["display_kind"], "hidden");
    assert!(legacy_bound.last().unwrap().get("input_id").is_none());
}

#[tokio::test]
async fn transcript_identity_valid_attachment_selection_keeps_legacy_paired_client_policy() {
    for capable in [false, true] {
        let home = setup();
        let runtime = Runtime::new(
            home.path().into(),
            EventHub::new(),
            identity_pi(home.path()),
        )
        .unwrap();
        let live = open(&runtime, "alice").await["section"]["live_session_id"].clone();
        let mut ids = vec![];
        for name in ["own.txt", "other-client.txt"] {
            ids.push(runtime.call("alice","file.attach",&json!({"session_id":live,"name":name,"data_url":"data:text/plain;base64,cGFpcmVk"})).await.unwrap().unwrap()["id"].clone());
        }
        let mut params = json!({"session_id":live,"text":"waiting","attachments":[ids[0]]});
        if capable {
            params["input_id"] = json!(INPUT);
        }
        runtime
            .call("alice", "prompt.submit", &params)
            .await
            .unwrap()
            .unwrap();
        runtime
            .call("alice", "session.interrupt", &json!({"session_id":live}))
            .await
            .unwrap()
            .unwrap();
        // Existing explicit-list behavior discards the other paired upload in
        // both paths. This candidate does not change that separate policy.
        let rejected = runtime
            .call(
                "alice",
                "prompt.submit",
                &json!({"session_id":live,"text":"same","queued":true,"attachments":[ids[1]]}),
            )
            .await
            .unwrap()
            .unwrap_err();
        assert_eq!(rejected.code, 4204);
        runtime.shutdown().await;
    }
}
