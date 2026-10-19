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
// Only the two launchers used by the real-Pi suites are supported. Resolve the
// lexical launcher before following npm's .bin symlink, and never borrow modules
// from another installation when the selected runtime is incomplete.
fn instrumented_pi_modules(executable: &Path) -> Result<(PathBuf, bool), String> {
    let parent = executable.parent().ok_or("Pi launcher has no parent")?;
    let staged = executable.ends_with("pi/hexbot-pi");
    let modules = if staged {
        parent.join("node_modules/@earendil-works")
    } else if executable.ends_with("node_modules/.bin/pi") {
        parent.parent().unwrap().join("@earendil-works")
    } else {
        return Err(format!("unsupported Pi launcher: {}", executable.display()));
    };
    let mut required = vec![
        executable.to_path_buf(),
        modules.join("pi-coding-agent/dist/core/agent-session.js"),
        modules.join("pi-agent-core/dist/agent.js"),
        modules.join("pi-coding-agent/dist/cli.js"),
    ];
    if staged {
        required.push(parent.parent().unwrap().join("node"));
        required.push(parent.join("search-tools.mjs"));
    }
    for file in required {
        if !file.is_file() {
            return Err(format!(
                "selected Pi installation is missing {}",
                file.display()
            ));
        }
    }
    Ok((
        fs::canonicalize(modules).map_err(|error| error.to_string())?,
        staged,
    ))
}

#[test]
fn instrumented_pi_layout_selection_stays_with_the_selected_runtime() {
    let root = tempfile::tempdir().unwrap();
    let repo = root.path().join("repository/node_modules");
    let bundle = root.path().join("bundle");
    for (launcher, modules, staged) in [
        (repo.join(".bin/pi"), repo.join("@earendil-works"), false),
        (
            bundle.join("pi/hexbot-pi"),
            bundle.join("pi/node_modules/@earendil-works"),
            true,
        ),
    ] {
        let cli = modules.join("pi-coding-agent/dist/cli.js");
        let mut files = vec![
            launcher.clone(),
            cli.clone(),
            modules.join("pi-coding-agent/dist/core/agent-session.js"),
            modules.join("pi-agent-core/dist/agent.js"),
        ];
        if staged {
            files.extend([bundle.join("node"), bundle.join("pi/search-tools.mjs")]);
        }
        for file in files {
            fs::create_dir_all(file.parent().unwrap()).unwrap();
            fs::write(file, "fixture").unwrap();
        }
        assert_eq!(
            instrumented_pi_modules(&launcher).unwrap(),
            (fs::canonicalize(&modules).unwrap(), staged)
        );
        if staged {
            // A complete installation at the old, wrong location is no fallback.
            fs::create_dir_all(bundle.join("@earendil-works")).unwrap();
            for package in ["pi-coding-agent", "pi-agent-core"] {
                fs::rename(
                    modules.join(package),
                    bundle.join("@earendil-works").join(package),
                )
                .unwrap();
            }
        } else {
            fs::remove_file(&cli).unwrap();
        }
        assert!(
            instrumented_pi_modules(&launcher)
                .unwrap_err()
                .contains(&modules.display().to_string())
        );
    }
    assert!(instrumented_pi_modules(&bundle.join("other-pi")).is_err());
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
        if !instrument.is_empty() && instrument != "nested" {
            // Only the owned launcher is instrumented. All dependency files and
            // the private extension remain unchanged. Holds await HTTP barriers.
            let (modules, staged) = instrumented_pi_modules(&executable).unwrap();
            let session = modules.join("pi-coding-agent/dist/core/agent-session.js");
            let agent = modules.join("pi-agent-core/dist/agent.js");
            let cli = modules.join("pi-coding-agent/dist/cli.js");
            let wrapper = home.path().join("identity-pi.mjs");
            let source = format!(
                r#"#!/usr/bin/env node
import {{realpathSync}} from 'node:fs';
// The staged launcher also runs search-tools.mjs. Instrument only its Pi CLI.
if (!{staged} || realpathSync(process.argv[1]) === {cli}) {{
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
if (!{staged}) await import({cli});
}}
"#,
                session = json!(session.to_string_lossy()),
                agent = json!(agent.to_string_lossy()),
                cli = json!(cli.to_string_lossy()),
                mode = json!(instrument),
                staged = staged,
            );
            fs::write(&wrapper, source).unwrap();
            executable = if staged {
                // Keep the packaged Node and search-tool setup in the selected
                // launcher. The preload changes only this owned test process.
                let launcher = home.path().join("identity-pi");
                let quote = |text: &str| format!("'{}'", text.replace('\'', "'\"'\"'"));
                let preload = format!("--import={}", json!(wrapper.to_string_lossy()));
                fs::write(&launcher, format!(
                    "#!/bin/sh\nset -eu\nexport NODE_OPTIONS=\"${{NODE_OPTIONS:+$NODE_OPTIONS }}\"{}\nexec {} \"$@\"\n",
                    quote(&preload), quote(&executable.to_string_lossy())
                )).unwrap();
                launcher
            } else {
                wrapper
            };
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
            }
        }
        if instrument == "nested" {
            let script =
                Path::new(env!("CARGO_MANIFEST_DIR")).join("../pi-runtime/fixtures/mcp-server.mjs");
            fs::write(
                home.path().join("config.yaml"),
                format!(
                    "mcp_servers:\n  fixture:\n    command: node\n    args: [{}]\n",
                    json!(script.to_string_lossy())
                ),
            )
            .unwrap();
            db::open(home.path())
                .unwrap()
                .execute_batch("UPDATE bots SET approval_mode='off'")
                .unwrap();
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
            // Only the control row the daemon stored for this request carries
            // its key. The summary notice is no assistant fragment.
            let rows = runtime_store::history(home.path(), "section-a").unwrap();
            assert_eq!(
                rows.iter()
                    .map(|row| (row["role"].clone(), row.get("input_id").cloned()))
                    .collect::<Vec<_>>(),
                [
                    (json!("user"), Some(json!(INPUT))),
                    (json!("assistant"), None)
                ]
            );
            assert!(rows.iter().all(|row| row.get("turn_id").is_none()));
        }
        runtime.shutdown().await;
    }
}

async fn submit_compact(
    runtime: &Runtime,
    live: &Value,
    text: &str,
    input_id: Option<Value>,
    upload: &Value,
) -> hexbot_core::Result<Value> {
    let mut params = json!({"session_id":live,"text":text,"attachments":[upload]});
    if let Some(id) = input_id {
        params["input_id"] = id;
    }
    runtime
        .call("alice", "prompt.submit", &params)
        .await
        .unwrap()
}

/// Manual `/compact` is the daemon's own command, not a Pi user. The caller's
/// key is reserved before Pi compacts and kept on the one control row stored
/// for that request, so a client can adopt it without guessing.
#[tokio::test]
async fn transcript_identity_manual_compact_binds_only_its_stored_control_row() {
    let home = setup();
    let path = identity_pi(home.path());
    let log = home.path().join("pi-commands.log");
    let source = fs::read_to_string(&path).unwrap();
    let script = source.replace(
        "rl.on('line',line=>{const c=JSON.parse(line);",
        &format!(
            "rl.on('line',line=>{{const c=JSON.parse(line);require('node:fs').appendFileSync({},c.type+'\\n');if(c.type==='compact'&&c.customInstructions==='fail'){{emit({{type:'response',id:c.id,command:c.type,success:false,error:'Summarising failed'}});return;}}",
            json!(log.to_string_lossy())
        ),
    );
    assert_ne!(script, source);
    fs::write(&path, script).unwrap();
    let compactions = || {
        fs::read_to_string(&log)
            .unwrap_or_default()
            .lines()
            .filter(|line| *line == "compact")
            .count()
    };
    let reserved = |id: &str| {
        use rusqlite::OptionalExtension;
        runtime_store::open(home.path())
            .unwrap()
            .query_row(
                "SELECT session_id,consumed_by FROM native_prompt_intents WHERE id=?",
                [id],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?)),
            )
            .optional()
            .unwrap()
    };
    let runtime = Runtime::new(home.path().into(), EventHub::new(), path).unwrap();
    let live = open(&runtime, "alice").await["section"]["live_session_id"].clone();
    let upload = runtime.call("alice","file.attach",&json!({"session_id":live,"name":"kept.txt","data_url":"data:text/plain;base64,a2VwdA=="})).await.unwrap().unwrap()["id"].clone();
    // A key another conversation already reserved cannot be taken over.
    runtime_store::open(home.path()).unwrap().execute("INSERT INTO native_prompt_intents(id,session_id,text,display_kind,created_at) VALUES (?,'other-session','/compact','normal',0)",[THIRD]).unwrap();
    for id in [
        json!("invalid"),
        json!(17),
        json!("00000000-0000-0000-0000-000000000000"),
        json!(INPUT.to_uppercase()),
        json!(format!("{{{INPUT}}}")),
        json!(INPUT.replace('-', "")),
        json!(THIRD),
    ] {
        let error = submit_compact(&runtime, &live, "/compact", Some(id), &upload)
            .await
            .unwrap_err();
        assert_eq!(error.code, 4202);
    }
    assert_eq!(compactions(), 0);
    assert!(
        runtime_store::history(home.path(), "section-a")
            .unwrap()
            .is_empty()
    );

    // A failed compaction stores nothing and leaves the key free.
    let failed = submit_compact(
        &runtime,
        &live,
        "/compact fail",
        Some(json!(SECOND)),
        &upload,
    )
    .await
    .unwrap_err();
    assert_eq!(failed.code, 5201);
    assert_eq!(compactions(), 1);
    assert!(
        runtime_store::history(home.path(), "section-a")
            .unwrap()
            .is_empty()
    );
    assert_eq!(reserved(SECOND), None);

    let accepted = submit_compact(&runtime, &live, "/compact", Some(json!(INPUT)), &upload)
        .await
        .unwrap();
    assert_eq!(accepted, json!({"status":"completed","input_id":INPUT}));
    assert_eq!(compactions(), 2);
    let rows = runtime_store::history(home.path(), "section-a").unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0]["role"], "user");
    assert_eq!(rows[0]["text"], "/compact");
    assert_eq!(rows[0]["input_id"], INPUT);
    assert_eq!(rows[1]["text"], "Older messages summarised.");
    assert!(rows[1].get("input_id").is_none());
    assert!(rows.iter().all(|row| row.get("turn_id").is_none()));
    // The reservation names the row it was kept on, and nothing else can take it.
    assert_eq!(
        reserved(INPUT),
        Some((
            "section-a".into(),
            rows[0]["row_id"].as_str().map(str::to_owned)
        ))
    );
    for text in ["/compact", "same"] {
        let error = submit_compact(&runtime, &live, text, Some(json!(INPUT)), &upload)
            .await
            .unwrap_err();
        assert_eq!(error.code, 4202);
    }
    assert_eq!(compactions(), 2);
    assert_eq!(
        runtime_store::history(home.path(), "section-a").unwrap(),
        rows
    );

    // Callers that omit the key keep the original response and row shape.
    let legacy = submit_compact(&runtime, &live, "/compact", None, &upload)
        .await
        .unwrap();
    assert_eq!(legacy, json!({"status":"completed"}));
    let rows = runtime_store::history(home.path(), "section-a").unwrap();
    assert_eq!(rows.len(), 4);
    assert!(rows[2].get("input_id").is_none());
    // Compaction never sent or consumed the selected upload.
    runtime
        .call(
            "alice",
            "prompt.submit",
            &json!({"session_id":live,"text":"healthy","attachments":[upload]}),
        )
        .await
        .unwrap()
        .unwrap();
    runtime.shutdown().await;
}

/// Actual Pi summarises through the local provider. Only the daemon's control
/// row carries the key; Pi's log, the provider request, the journal and the
/// frozen session never see it, and the row survives a restart unchanged.
#[tokio::test]
#[ignore = "requires HEXBOT_TEST_PI to the pinned Pi executable"]
async fn actual_pi_manual_compact_keeps_its_input_id_on_the_control_row_only() {
    let mut f = PiFixture::new("").await;
    let earlier = "an earlier turn for Pi to summarize".to_owned();
    let long = format!("a long turn Pi keeps {}", "long context ".repeat(12000));
    for (id, text) in [(SECOND, earlier), (THIRD, long)] {
        let ack = tokio::time::timeout(
            LIMIT,
            f.runtime.call(
                "alice",
                "prompt.submit",
                &json!({"session_id":f.live,"text":text,"input_id":id}),
            ),
        )
        .await
        .unwrap()
        .unwrap()
        .unwrap();
        assert_eq!(ack["input_id"], id);
        receive(&mut f.requests).await.answer("noted");
        f.until_event(|event| {
            event["type"] == "status.update" && event["payload"]["kind"] == "idle"
        })
        .await;
    }
    let compact = {
        let (runtime, live) = (f.runtime.clone(), f.live.clone());
        tokio::spawn(async move {
            runtime
                .call(
                    "alice",
                    "prompt.submit",
                    &json!({"session_id":live,"text":"/compact","input_id":INPUT}),
                )
                .await
                .unwrap()
        })
    };
    let summary = receive(&mut f.requests).await;
    assert!(
        summary
            .body
            .to_string()
            .contains("an earlier turn for Pi to summarize")
    );
    assert!(!summary.body.to_string().contains(INPUT));
    summary.answer("Summary of the earlier turn");
    let result = tokio::time::timeout(LIMIT, compact)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(result, json!({"status":"completed","input_id":INPUT}));
    let rows = f.rows();
    let users = rows
        .iter()
        .filter(|row| row["role"] == "user")
        .collect::<Vec<_>>();
    assert_eq!(users.len(), 3);
    assert_eq!(users[0]["input_id"], SECOND);
    assert_eq!(users[1]["input_id"], THIRD);
    assert_eq!(users[2]["text"], "/compact");
    assert_eq!(users[2]["input_id"], INPUT);
    let control = users[2].clone();
    let notice = rows.last().unwrap();
    assert_eq!(notice["text"], "Older messages summarised.");
    assert!(notice.get("input_id").is_none() && notice.get("turn_id").is_none());
    let dir = runtime_store::session_dir(f.home.path(), "section-a").unwrap();
    let raw = fs::read_to_string(dir.join("conversation.jsonl")).unwrap();
    assert!(raw.contains("\"type\":\"compaction\""));
    assert!(!raw.contains(INPUT));
    let native = runtime_store::open(f.home.path()).unwrap();
    let leaked: i64 = native
        .query_row(
            "SELECT (SELECT count(*) FROM native_pi_journal WHERE session_id='section-a' AND instr(raw_json,?1)>0)
                  + (SELECT count(*) FROM native_sessions WHERE stored_id='section-a' AND (instr(prompt,?1)>0 OR instr(options,?1)>0))",
            [INPUT],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(leaked, 0);
    let usage = runtime_store::usage(f.home.path(), "section-a").unwrap();
    assert!(!usage.to_string().contains(INPUT));
    // A restart reconciles Pi's log and keeps the control row as stored.
    let home = f.home.path().to_path_buf();
    f.runtime.shutdown().await;
    let runtime = Runtime::new(
        home.clone(),
        EventHub::new(),
        PathBuf::from(std::env::var_os("HEXBOT_TEST_PI").unwrap()),
    )
    .unwrap();
    let reopened = open(&runtime, "alice").await;
    let live = reopened["section"]["live_session_id"].clone();
    let history = runtime
        .call("alice", "session.history", &json!({"session_id":live}))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        history["messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|row| row["input_id"] == INPUT)
            .cloned()
            .collect::<Vec<_>>(),
        [control]
    );
    runtime.shutdown().await;
    f.server.abort();
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
async fn transcript_identity_explicit_attachment_selection_retains_paired_uploads() {
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
        // Exact selection leaves the other paired upload available, with or
        // without the optional input identity.
        runtime
            .call(
                "alice",
                "prompt.submit",
                &json!({"session_id":live,"text":"same","queued":true,"attachments":[ids[1]]}),
            )
            .await
            .unwrap()
            .unwrap();
        runtime.shutdown().await;
    }
}

#[tokio::test]
#[ignore = "requires HEXBOT_TEST_PI to the pinned Pi executable"]
async fn actual_pi_transcript_identity_nested_collision_must_not_use_prior_fragment() {
    let mut f = PiFixture::new("nested").await;
    f.submit(INPUT, false, false).await;
    let first = receive(&mut f.requests).await;
    let mut bodies = vec![first.body.clone()];
    first.reply.send((200,sse(json!({"role":"assistant","content":"first","tool_calls":[{"index":0,"id":"outer/1","type":"function","function":{"name":"memory","arguments":"{\"action\":\"read\"}"}}]}),true))).unwrap();
    let second = receive(&mut f.requests).await;
    bodies.push(second.body.clone());
    second.reply.send((200,sse(json!({"role":"assistant","content":"second","tool_calls":[{"index":0,"id":"outer","type":"function","function":{"name":"codemode","arguments":json!({"code":"text(await tools.memory({action:'read'}));"}).to_string()}}]}),true))).unwrap();
    let third = receive(&mut f.requests).await;
    bodies.push(third.body.clone());
    third.answer("done");
    let events = f.until("message.complete").await;
    let rows = f.rows();
    let nested = events
        .iter()
        .filter(|e| {
            matches!(e["type"].as_str(), Some("tool.start" | "tool.complete"))
                && e["payload"]["parent_tool_call_id"] == "outer"
        })
        .collect::<Vec<_>>();
    let raw = fs::read_to_string(
        runtime_store::session_dir(f.home.path(), "section-a")
            .unwrap()
            .join("conversation.jsonl"),
    )
    .unwrap();

    let sufficient = nested.len() == 2;
    let assistants = rows
        .iter()
        .filter(|r| r["role"] == "assistant")
        .collect::<Vec<_>>();
    assert_eq!(assistants.len(), 3);
    assert_ne!(assistants[0]["row_id"], assistants[1]["row_id"]);
    for (tool, owner) in [("outer/1", assistants[0]), ("outer", assistants[1])] {
        let direct = events
            .iter()
            .filter(|e| {
                matches!(e["type"].as_str(), Some("tool.start" | "tool.complete"))
                    && e["payload"]["tool_id"] == tool
                    && e["payload"]["parent_tool_call_id"].is_null()
            })
            .collect::<Vec<_>>();
        assert_eq!(direct.len(), 2);
        assert!(
            direct
                .iter()
                .all(|e| e["payload"]["message_id"] == owner["row_id"])
        );
    }
    assert_eq!(
        events
            .iter()
            .filter(|e| e["type"] == "message.start")
            .count(),
        1
    );
    for text in [raw, serde_json::to_string(&bodies).unwrap()] {
        for key in ["input_id", "turn_id", "message_id"] {
            assert!(!text.contains(key));
        }
    }
    let correct = nested
        .iter()
        .all(|e| e["payload"].get("message_id").is_none());
    f.close().await;
    assert!(sufficient, "actual nested start and complete required");
    assert!(
        correct,
        "nested call inherited an unrelated earlier assistant fragment"
    );
}

#[tokio::test]
#[ignore = "requires HEXBOT_TEST_PI to the pinned Pi executable"]
async fn actual_pi_explicit_upload_selection_retains_the_other_clients_file() {
    for capable in [false, true] {
        let mut f = PiFixture::new("").await;
        let attach = async |name: &str| {
            f.runtime.call("alice", "file.attach", &json!({"session_id":f.live,"name":name,"data_url":"data:text/plain;base64,cGFpcmVk"})).await.unwrap().unwrap()
        };
        let (a, b) = tokio::join!(attach("client-a.txt"), attach("client-b-private.txt"));
        let mut bodies = vec![];
        let mut replies = vec![];
        // The ordinary legacy client omits the list and consumes all staging.
        // The capable client sends an exact list and leaves B selectable.
        for (index, text) in ["first client", "second client"].into_iter().enumerate() {
            let mut p = json!({"session_id":f.live,"text":text});
            if capable {
                p["attachments"] = json!([if index == 0 { &a["id"] } else { &b["id"] }]);
                p["input_id"] = json!(if index == 0 { INPUT } else { SECOND });
            }
            let reply = f.runtime.call("alice", "prompt.submit", &p).await.unwrap();
            if reply.is_err() {
                f.close().await;
                panic!("the other client's pending upload must remain selectable: {reply:?}");
            }
            replies.push(reply.unwrap());
            let request = receive(&mut f.requests).await;
            bodies.push(request.body.clone());
            request.answer("done");
            f.until("message.complete").await;
        }
        let users = f
            .rows()
            .into_iter()
            .filter(|r| r["role"] == "user")
            .collect::<Vec<_>>();
        assert_eq!(users.len(), 2);
        assert!(
            users[0]["text"]
                .as_str()
                .unwrap()
                .contains(a["path"].as_str().unwrap())
        );
        if capable {
            assert!(
                !users[0]["text"]
                    .as_str()
                    .unwrap()
                    .contains(b["path"].as_str().unwrap())
            );
            assert!(
                users[1]["text"]
                    .as_str()
                    .unwrap()
                    .contains(b["path"].as_str().unwrap())
            );
            assert!(
                !users[1]["text"]
                    .as_str()
                    .unwrap()
                    .contains(a["path"].as_str().unwrap())
            );
            assert_eq!(users[0]["input_id"], replies[0]["input_id"]);
            assert_eq!(users[1]["input_id"], replies[1]["input_id"]);
        } else {
            assert!(
                users[0]["text"]
                    .as_str()
                    .unwrap()
                    .contains(b["path"].as_str().unwrap())
            );
            assert_eq!(users[1]["text"], "second client");
        }
        for (body, row) in bodies.iter().zip(&users) {
            assert_eq!(
                body["messages"].as_array().unwrap().last().unwrap()["content"][0]["text"],
                row["text"]
            );
            for key in ["input_id", "turn_id", "message_id"] {
                assert!(!body.to_string().contains(key));
            }
        }
        f.close().await;
    }
}

#[tokio::test]
async fn explicit_upload_selection_restores_rejected_files_with_concurrent_attaches() {
    let home = setup();
    let (entered, mut calls) = tokio::sync::mpsc::unbounded_channel();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let router = axum::Router::new().route(
        "/reject",
        axum::routing::get(move || {
            let entered = entered.clone();
            async move {
                let (release, held) = tokio::sync::oneshot::channel::<()>();
                entered.send(release).unwrap();
                held.await.unwrap();
                "rejected"
            }
        }),
    );
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let executable = identity_pi(home.path());
    let source = fs::read_to_string(&executable).unwrap().replace("const c=JSON.parse(line);", &format!("const c=JSON.parse(line);if(c.type==='prompt'&&c.message.startsWith('reject')){{fetch('http://{address}/reject').then(()=>emit({{type:'response',id:c.id,command:c.type,success:false,error:'Rejected for test'}}));return;}}"));
    fs::write(&executable, source).unwrap();
    let hub = EventHub::new();
    let mut events = hub.subscribe();
    let runtime = Runtime::new(home.path().into(), hub, executable).unwrap();
    let live = open(&runtime, "alice").await["section"]["live_session_id"].clone();
    let attach = async |name: &str| {
        runtime.call("alice", "file.attach", &json!({"session_id":live,"name":name,"data_url":"data:text/plain;base64,cGFpcmVk"})).await.unwrap().unwrap()
    };
    let (a, b) = tokio::join!(attach("selected.txt"), attach("pending.txt"));
    let params =
        json!({"session_id":live,"text":"reject","attachments":[a["id"]],"input_id":INPUT});
    let submit = runtime.call("alice", "prompt.submit", &params);
    tokio::pin!(submit);
    let release = tokio::select! {
        release = receive(&mut calls) => release,
        result = &mut submit => panic!("rejection must remain held: {result:?}"),
    };
    let (c, d) = tokio::join!(attach("later-c.txt"), attach("later-d.txt"));
    release.send(()).unwrap();
    assert_eq!(submit.await.unwrap().unwrap_err().code, 5201);
    assert!(
        runtime_store::history(home.path(), "section-a")
            .unwrap()
            .is_empty()
    );
    for file in [&a, &b, &c, &d] {
        assert!(Path::new(file["path"].as_str().unwrap()).exists());
    }
    // Empty is an exact text-only selection, including after restoration.
    runtime
        .call(
            "alice",
            "prompt.submit",
            &json!({"session_id":live,"text":"text only","attachments":[]}),
        )
        .await
        .unwrap()
        .unwrap();
    next_kind(&mut events, "message.complete").await;
    let row = runtime_store::history(home.path(), "section-a")
        .unwrap()
        .remove(0);
    assert_eq!(row["text"], "text only");
    runtime.call("alice", "prompt.submit", &json!({"session_id":live,"text":"all selected","attachments":[a["id"],b["id"],c["id"],d["id"]],"input_id":SECOND})).await.unwrap().unwrap();
    next_kind(&mut events, "message.complete").await;
    let rows = runtime_store::history(home.path(), "section-a").unwrap();
    let row = rows.iter().find(|r| r["input_id"] == SECOND).unwrap();
    for file in [&a, &b, &c, &d] {
        assert!(
            row["text"]
                .as_str()
                .unwrap()
                .contains(file["path"].as_str().unwrap())
        );
    }
    runtime.shutdown().await;
    server.abort();
}

#[tokio::test]
async fn retained_uploads_survive_refresh_and_obey_quota_and_explicit_cleanup() {
    for cleanup in ["attachments.clear", "session.close"] {
        let home = setup();
        let hub = EventHub::new();
        let mut events = hub.subscribe();
        let executable = identity_pi(home.path());
        let runtime = Runtime::new(home.path().into(), hub, executable.clone()).unwrap();
        let live = open(&runtime, "alice").await["section"]["live_session_id"].clone();
        let attach = async |name: &str| {
            runtime.call("alice", "file.attach", &json!({"session_id":live,"name":name,"data_url":"data:text/plain;base64,cGFpcmVk"})).await.unwrap().unwrap()
        };
        let a = attach("selected.txt").await;
        let b = attach("pending.txt").await;
        runtime
            .call(
                "alice",
                "prompt.submit",
                &json!({"session_id":live,"text":"first","attachments":[a["id"]]}),
            )
            .await
            .unwrap()
            .unwrap();
        next_kind(&mut events, "message.complete").await;
        // Retirement also waits for the turn's usage RPCs to finish.
        next_kind(&mut events, "session.usage").await;
        // Pending files still count against the existing disk quota.
        let pad = Path::new(b["path"].as_str().unwrap()).with_file_name("quota-padding");
        let file = fs::File::create(&pad).unwrap();
        file.set_len(512 * 1024 * 1024 - 12).unwrap();
        assert_eq!(runtime.call("alice", "file.attach", &json!({"session_id":live,"name":"over.txt","data_url":"data:text/plain;base64,eA=="})).await.unwrap().unwrap_err().code, 4018);
        fs::remove_file(pad).unwrap();
        // Both model and tool refresh transfer retained staging to the new Pi.
        fs::write(
            home.path().join("profiles/owl/config.yaml"),
            "model:\n  provider: openai\n  default: test-model\ntools:\n  enabled_toolsets: [hexbot]\n",
        )
        .unwrap();
        hexbot_core::catalog::call(
            home.path(),
            "alice",
            "hexbot.bots.update",
            &json!({"name":"owl","provider":"anthropic","model":"claude-fable-5-1"}),
        )
        .unwrap()
        .unwrap();
        let working = fs::read_to_string(&executable).unwrap();
        fs::write(&executable, "#!/usr/bin/env node\nprocess.exit(1)\n").unwrap();
        assert!(runtime.call("alice", "file.attach", &json!({"session_id":live,"name":"failed-refresh.txt","data_url":"data:text/plain;base64,eA=="})).await.unwrap().is_err());
        assert!(Path::new(b["path"].as_str().unwrap()).exists());
        fs::write(&executable, working).unwrap();
        let c = attach("after-refresh.txt").await;
        let saved: String = runtime_store::open(home.path())
            .unwrap()
            .query_row(
                "SELECT options FROM native_sessions WHERE stored_id='section-a'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let saved: Value = serde_json::from_str(&saved).unwrap();
        assert_eq!(saved["model"], "claude-fable-5-1");
        assert_eq!(saved["enabledToolsets"], json!(["hexbot"]));
        runtime
            .call(
                "alice",
                "prompt.submit",
                &json!({"session_id":live,"text":"second","attachments":[b["id"]]}),
            )
            .await
            .unwrap()
            .unwrap();
        next_kind(&mut events, "message.complete").await;
        let rows = runtime_store::history(home.path(), "section-a").unwrap();
        assert!(rows.iter().any(|r| {
            r["role"] == "user"
                && r["text"]
                    .as_str()
                    .unwrap_or("")
                    .contains(b["path"].as_str().unwrap())
        }));
        assert!(Path::new(c["path"].as_str().unwrap()).exists());
        runtime
            .call("alice", cleanup, &json!({"session_id":live}))
            .await
            .unwrap()
            .unwrap();
        assert!(!Path::new(c["path"].as_str().unwrap()).exists());
        // Submitted files remain available to the conversation.
        for file in [&a, &b] {
            assert!(Path::new(file["path"].as_str().unwrap()).exists());
        }
        runtime.shutdown().await;
    }
}
