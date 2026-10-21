use super::*;

async fn background_recovery(change_tools: bool) {
    let (home, runtime, hub) = setup();
    old_configuration(home.path());
    idle_stop_pi(home.path());
    let id = open(&runtime).await;
    let original = runtime.sessions.lock().unwrap()["first"].clone();
    let recovery = original.recovery_gate.lock().await;
    runtime
        .call_inner("alice", "session.interrupt", &json!({"session_id":id}))
        .await
        .unwrap();
    let result = runtime.return_result("alice", "owl", "first", "actual background result", None);
    tokio::pin!(result);
    assert!(futures_util::poll!(result.as_mut()).is_pending());
    if change_tools {
        fs::write(
            home.path().join("profiles/owl/config.yaml"),
            "model:\n  provider: openai\n  default: fixture\ntools:\n  enabled_toolsets: []\n",
        )
        .unwrap();
        common::write_config(home.path(), &json!({"mcp_servers":{}})).unwrap();
    }
    let mut events = hub.subscribe();
    drop(recovery);
    tokio::time::timeout(Duration::from_secs(5), result)
        .await
        .unwrap();
    let _terminal = stop_tests::stop_event(&mut events, |e| {
        e["type"] == "warning" || e["type"] == "message.complete"
    })
    .await;
    let history = store::history(home.path(), "first").unwrap();
    let rows = history
        .iter()
        .filter(|r| r["text"] == "actual background result")
        .collect::<Vec<_>>();
    let intents: (usize, usize) = store::open(home.path()).unwrap().query_row("SELECT COUNT(*),COUNT(consumed_by) FROM native_prompt_intents WHERE session_id='first'", [], |r| Ok((r.get(0)?,r.get(1)?))).unwrap();
    runtime.shutdown().await;
    assert_eq!(
        rows.len(),
        1,
        "a completed background reply must survive configuration refresh after Stop"
    );
    assert_eq!(intents, (1, 1));
}

#[tokio::test]
async fn background_recovery_healthy_control() {
    background_recovery(false).await;
}

#[tokio::test]
async fn background_recovery_tool_change() {
    background_recovery(true).await;
}

pub(super) async fn actual_background_recovery(change_tools: bool) {
    let (home, runtime, hub, mut received, server, _) = actual_fixture().await;
    let id = open(&runtime).await;
    let original = runtime.sessions.lock().unwrap()["first"].clone();
    let recovery = original.recovery_gate.lock().await;
    runtime
        .call_inner("alice", "session.interrupt", &json!({"session_id":id}))
        .await
        .unwrap();
    let result = runtime.return_result(
        "alice",
        "owl",
        "first",
        "actual pinned Pi background result",
        None,
    );
    tokio::pin!(result);
    assert!(futures_util::poll!(result.as_mut()).is_pending());
    if change_tools {
        let path = home.path().join("profiles/owl/config.yaml");
        let config = fs::read_to_string(&path).unwrap();
        fs::write(path, config.replace("[hexbot, terminal]", "[]")).unwrap();
        common::write_config(home.path(), &json!({"mcp_servers":{}})).unwrap();
    }
    let mut events = hub.subscribe();
    drop(recovery);
    tokio::time::timeout(Duration::from_secs(5), result)
        .await
        .unwrap();
    let _terminal = stop_tests::stop_event(&mut events, |e| {
        e["type"] == "warning" || e["type"] == "message.complete"
    })
    .await;
    let history = store::history(home.path(), "first").unwrap();
    let rows = history
        .iter()
        .filter(|r| r["text"] == "actual pinned Pi background result")
        .collect::<Vec<_>>();
    let intents: (usize, usize) = store::open(home.path()).unwrap().query_row("SELECT COUNT(*),COUNT(consumed_by) FROM native_prompt_intents WHERE session_id='first'", [], |r| Ok((r.get(0)?,r.get(1)?))).unwrap();
    let request = received.try_recv().ok();
    runtime.shutdown().await;
    server.abort();
    assert_eq!(
        rows.len(),
        1,
        "a completed background reply must survive configuration refresh after Stop with real Pi"
    );
    assert_eq!(intents, (1, 1));
    assert!(
        request.is_some(),
        "actual Pi must deliver the reply to the local provider"
    );
}

pub(super) async fn public_delegate_reply_after_recovery() {
    use axum::{Json, Router, extract::State as HttpState, routing::post};
    use futures_util::FutureExt;
    #[derive(Clone)]
    struct Provider {
        sent: tokio::sync::mpsc::UnboundedSender<Value>,
        child_release: Arc<tokio::sync::Semaphore>,
        dispatched: Arc<AtomicBool>,
    }
    async fn complete(
        HttpState(p): HttpState<Provider>,
        Json(body): Json<Value>,
    ) -> ([(&'static str, &'static str); 1], String) {
        let last_user = body["messages"]
            .as_array()
            .unwrap()
            .iter()
            .rev()
            .find(|m| m["role"] == "user")
            .map(|m| store::text(&m["content"]))
            .unwrap_or_default();
        let child = last_user.starts_with("Complete this delegated task independently.");
        let background = last_user.starts_with("[Delegated tasks completed]");
        let first =
            last_user == "public owner dispatch" && !p.dispatched.swap(true, Ordering::AcqRel);
        p.sent.send(json!({"kind":if child {"child"} else if background {"background"} else {"owner"},"last_user":last_user,"first":first})).unwrap();
        if child {
            p.child_release.acquire().await.unwrap().forget();
        }
        let delta = if first {
            json!({"role":"assistant","tool_calls":[{"index":0,"id":"call-public-review","type":"function","function":{"name":"delegate_task","arguments":"{\"goal\":\"public child marker\"}"}}]})
        } else {
            json!({"role":"assistant","content":if child {"public child completed value"} else if background {"background received"} else {"parent finished"}})
        };
        let chunk = json!({"id":"public-review","object":"chat.completion.chunk","created":1,"model":"fixture","choices":[{"index":0,"delta":delta,"finish_reason":null}]});
        let end = json!({"id":"public-review","object":"chat.completion.chunk","created":1,"model":"fixture","choices":[{"index":0,"delta":{},"finish_reason":if first {"tool_calls"} else {"stop"}}]});
        (
            [("content-type", "text/event-stream")],
            format!("data: {chunk}\n\ndata: {end}\n\ndata: [DONE]\n\n"),
        )
    }
    let (home, unused, hub) = setup();
    drop(unused);
    let (sent, mut received) = tokio::sync::mpsc::unbounded_channel();
    let child_release = Arc::new(tokio::sync::Semaphore::new(0));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let api = Router::new()
        .route("/v1/chat/completions", post(complete))
        .with_state(Provider {
            sent,
            child_release: child_release.clone(),
            dispatched: Arc::new(AtomicBool::new(false)),
        });
    let server = tokio::spawn(async move { axum::serve(listener, api).await.unwrap() });
    fs::write(home.path().join("profiles/owl/config.yaml"),format!("model:\n  provider: lmstudio\n  default: fixture\n  api_key: local-only\n  base_url: http://{address}/v1\ntools:\n  enabled_toolsets: [hexbot, delegation]\n")).unwrap();
    let runtime = Runtime::new(
        home.path().into(),
        hub.clone(),
        PathBuf::from(std::env::var_os("HEXBOT_TEST_PI").unwrap()),
    )
    .unwrap();
    let id = open(&runtime).await;
    let original = runtime.sessions.lock().unwrap()["first"].clone();
    let mut events = hub.subscribe();
    runtime
        .call(
            "alice",
            "prompt.submit",
            &json!({"session_id":id,"text":"public owner dispatch"}),
        )
        .await
        .unwrap()
        .unwrap();
    stop_tests::stop_event(&mut events, |e| {
        e["session_id"] == id
            && e["type"] == "message.complete"
            && e["payload"]["text"] == "parent finished"
    })
    .await;
    let mut requests = vec![];
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let request = received.recv().await.unwrap();
            let child = request["kind"] == "child";
            requests.push(request);
            if child {
                break;
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(
        runtime.children.lock().unwrap().len(),
        1,
        "the public native tool must have a real running child"
    );
    let recovery = original.recovery_gate.lock().await;
    runtime
        .call("alice", "session.interrupt", &json!({"session_id":id}))
        .await
        .unwrap()
        .unwrap();
    while original.landed.notified().now_or_never().is_some() {}
    let landed = original.landed.notified();
    tokio::pin!(landed);
    assert!(futures_util::poll!(landed.as_mut()).is_pending());
    child_release.add_permits(1);
    tokio::time::timeout(Duration::from_secs(10), landed)
        .await
        .unwrap();
    assert_eq!(original.input_waiters.load(Ordering::Acquire), 1);
    assert_eq!(original.state.lock().unwrap().landing, 0);
    let path = home.path().join("profiles/owl/config.yaml");
    let config = fs::read_to_string(&path).unwrap();
    fs::write(path, config.replace("[hexbot, delegation]", "[]")).unwrap();
    drop(recovery);
    let _terminal = stop_tests::stop_event(&mut events, |e| {
        (e["type"] == "warning" && e["payload"]["section_id"] == "first")
            || (e["type"] == "message.complete" && e["session_id"] == id)
    })
    .await;
    let history = store::history(home.path(), "first").unwrap();
    let rows = history
        .iter()
        .filter(|r| {
            r["role"] == "user"
                && r["text"]
                    .as_str()
                    .is_some_and(|t| t.starts_with("[Delegated tasks completed]"))
        })
        .collect::<Vec<_>>();
    while let Ok(r) = received.try_recv() {
        requests.push(r);
    }
    let intents: (usize,usize) = store::open(home.path()).unwrap().query_row("SELECT COUNT(*),COUNT(consumed_by) FROM native_prompt_intents WHERE session_id='first'",[],|r| Ok((r.get(0)?,r.get(1)?))).unwrap();
    let children = runtime.children.lock().unwrap().len();
    let current = runtime.sessions.lock().unwrap()["first"].clone();
    assert!(!Arc::ptr_eq(&current, &original));
    assert!(
        !current
            .tools
            .iter()
            .any(|tool| tool["name"] == "message_bot")
    );
    runtime.shutdown().await;
    server.abort();
    assert_eq!(
        rows.len(),
        1,
        "the completed child result must reach its chat through the production background path"
    );
    assert_eq!(rows[0]["display_kind"], "hidden");
    assert_eq!(intents, (2, 2));
    assert_eq!(children, 0);
    assert_eq!(
        requests
            .iter()
            .filter(|r| r["kind"] == "background")
            .count(),
        1
    );
}

async fn peer_event(
    events: &mut tokio::sync::broadcast::Receiver<crate::events::Event>,
    matches: impl Fn(&Value) -> bool,
) -> Value {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let e = events.recv().await.unwrap().frame["params"].clone();
            if matches(&e) {
                break e;
            }
        }
    })
    .await
    .unwrap()
}

pub(super) async fn public_peer_reply_after_refresh() {
    use axum::{Json, Router, extract::State as HttpState, routing::post};
    #[derive(Clone)]
    struct Provider {
        sent: tokio::sync::mpsc::UnboundedSender<Value>,
        child_release: Arc<tokio::sync::Semaphore>,
        dispatched: Arc<AtomicBool>,
    }
    async fn complete(
        HttpState(p): HttpState<Provider>,
        Json(body): Json<Value>,
    ) -> ([(&'static str, &'static str); 1], String) {
        let last_user = body["messages"]
            .as_array()
            .unwrap()
            .iter()
            .rev()
            .find(|m| m["role"] == "user")
            .map(|m| store::text(&m["content"]))
            .unwrap_or_default();
        let child = last_user.starts_with("@owl: public peer task");
        let background = last_user.starts_with("[reply from cat]");
        let first =
            last_user == "public owner dispatch" && !p.dispatched.swap(true, Ordering::AcqRel);
        p.sent.send(json!({"kind":if child {"child"} else if background {"background"} else {"owner"},"last_user":last_user,"first":first})).unwrap();
        if child {
            p.child_release.acquire().await.unwrap().forget();
        }
        let delta = if first {
            json!({"role":"assistant","tool_calls":[{"index":0,"id":"call-public-review","type":"function","function":{"name":"message_bot","arguments":"{\"to\":\"cat\",\"text\":\"public peer task\",\"wait\":false}"}}]})
        } else {
            json!({"role":"assistant","content":if child {"public child completed value"} else if background {"background received"} else {"parent finished"}})
        };
        let chunk = json!({"id":"public-review","object":"chat.completion.chunk","created":1,"model":"fixture","choices":[{"index":0,"delta":delta,"finish_reason":null}]});
        let end = json!({"id":"public-review","object":"chat.completion.chunk","created":1,"model":"fixture","choices":[{"index":0,"delta":{},"finish_reason":if first {"tool_calls"} else {"stop"}}]});
        (
            [("content-type", "text/event-stream")],
            format!("data: {chunk}\n\ndata: {end}\n\ndata: [DONE]\n\n"),
        )
    }
    let (home, unused, hub) = setup();
    drop(unused);
    db::open(home.path())
        .unwrap()
        .execute("INSERT INTO bots(name,owner_id) VALUES('cat','alice')", [])
        .unwrap();
    fs::create_dir_all(home.path().join("profiles/cat")).unwrap();
    let (sent, mut received) = tokio::sync::mpsc::unbounded_channel();
    let child_release = Arc::new(tokio::sync::Semaphore::new(0));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let api = Router::new()
        .route("/v1/chat/completions", post(complete))
        .with_state(Provider {
            sent,
            child_release: child_release.clone(),
            dispatched: Arc::new(AtomicBool::new(false)),
        });
    let server = tokio::spawn(async move { axum::serve(listener, api).await.unwrap() });
    fs::write(home.path().join("profiles/owl/config.yaml"),format!("model:\n  provider: lmstudio\n  default: fixture\n  api_key: local-only\n  base_url: http://{address}/v1\ntools:\n  enabled_toolsets: [hexbot]\n")).unwrap();
    fs::copy(
        home.path().join("profiles/owl/config.yaml"),
        home.path().join("profiles/cat/config.yaml"),
    )
    .unwrap();
    let runtime = Runtime::new(
        home.path().into(),
        hub.clone(),
        PathBuf::from(std::env::var_os("HEXBOT_TEST_PI").unwrap()),
    )
    .unwrap();
    let id = open(&runtime).await;
    let original = runtime.sessions.lock().unwrap()["first"].clone();
    let mut events = hub.subscribe();
    runtime
        .call(
            "alice",
            "prompt.submit",
            &json!({"session_id":id,"text":"public owner dispatch"}),
        )
        .await
        .unwrap()
        .unwrap();
    peer_event(&mut events, |e| {
        e["session_id"] == id
            && e["type"] == "message.complete"
            && e["payload"]["text"] == "parent finished"
    })
    .await;
    let mut requests = vec![];
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let request = received.recv().await.unwrap();
            let child = request["kind"] == "child";
            requests.push(request);
            if child {
                break;
            }
        }
    })
    .await
    .unwrap();
    assert!(
        !original.requests.lock().unwrap().is_empty(),
        "the native asynchronous peer delivery must own a source request task"
    );
    let path = home.path().join("profiles/owl/config.yaml");
    let config = fs::read_to_string(&path).unwrap();
    fs::write(path, config.replace("[hexbot]", "[]")).unwrap();
    child_release.add_permits(1);
    let _terminal = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let e = events.recv().await.unwrap().frame["params"].clone();
            if (e["type"] == "warning" && e["payload"]["section_id"] == "first")
                || (e["type"] == "message.complete" && e["session_id"] == id)
            {
                break e;
            }
        }
    })
    .await
    .ok();
    let history = store::history(home.path(), "first").unwrap();
    let rows = history
        .iter()
        .filter(|r| {
            r["role"] == "user"
                && r["text"]
                    .as_str()
                    .is_some_and(|t| t.starts_with("[reply from cat]"))
        })
        .collect::<Vec<_>>();
    while let Ok(r) = received.try_recv() {
        requests.push(r);
    }
    let intents: (usize,usize) = store::open(home.path()).unwrap().query_row("SELECT COUNT(*),COUNT(consumed_by) FROM native_prompt_intents WHERE session_id='first'",[],|r| Ok((r.get(0)?,r.get(1)?))).unwrap();
    let current = runtime.sessions.lock().unwrap()["first"].clone();
    assert!(!Arc::ptr_eq(&current, &original));
    assert!(
        !current
            .tools
            .iter()
            .any(|tool| tool["name"] == "message_bot")
    );
    runtime.shutdown().await;
    server.abort();
    assert_eq!(
        rows.len(),
        1,
        "the completed child result must reach its chat through the production background path"
    );
    assert_eq!(rows[0]["display_kind"], "hidden");
    assert_eq!(intents, (2, 2));
    assert_eq!(
        requests
            .iter()
            .filter(|r| r["kind"] == "background")
            .count(),
        1
    );
}

#[tokio::test]
async fn background_recovery_keeps_its_readers_and_fifo_across_refresh() {
    for (tools, model) in [(true, false), (false, true), (true, true)] {
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
        let chain = Chain {
            askers: vec!["cat".into()],
            hops: Arc::new(AtomicUsize::new(3)),
        };
        let first = runtime.return_result(
            "alice",
            "owl",
            "first",
            "first background",
            Some(chain.clone()),
        );
        let second = runtime.return_result(
            "alice",
            "owl",
            "first",
            "second background",
            Some(chain.clone()),
        );
        tokio::pin!(first, second);
        assert!(futures_util::poll!(first.as_mut()).is_pending());
        assert!(futures_util::poll!(second.as_mut()).is_pending());
        assert_eq!(old.input_waiters.load(Ordering::Acquire), 2);
        let landing = old.state.lock().unwrap().landing;
        assert_eq!(landing, 0, "recovery must release process guards");
        assert!(old.event_gate.try_lock().is_ok());
        assert!(runtime.open_lock("first").try_lock().is_ok());
        let deleting = runtime
            .admission
            .pause(crate::admission::Scope::Bot("owl".into()));
        tokio::pin!(deleting);
        assert!(futures_util::poll!(deleting.as_mut()).is_pending());
        if tools {
            fs::write(
                home.path().join("profiles/owl/config.yaml"),
                "model:\n  provider: openai\n  default: fixture\ntools:\n  enabled_toolsets: []\n",
            )
            .unwrap();
            common::write_config(home.path(), &json!({"mcp_servers":{}})).unwrap();
        }
        if model {
            store::open(home.path()).unwrap().execute("UPDATE native_sessions SET options=json_set(options,'$.model','replacement') WHERE stored_id='first'", []).unwrap();
        }
        let mut events = hub.subscribe();
        drop(recovery);
        tokio::time::timeout(Duration::from_secs(5), first)
            .await
            .unwrap();
        stop_tests::stop_event(&mut events, |e| e["type"] == "message.complete").await;
        assert!(
            futures_util::poll!(deleting.as_mut()).is_pending(),
            "the second admitted reply still owns its reader"
        );
        let current = runtime.sessions.lock().unwrap()["first"].clone();
        assert!(!Arc::ptr_eq(&old, &current));
        {
            let state = current.state.lock().unwrap();
            assert!(Arc::ptr_eq(&state.chain.hops, &chain.hops));
            assert!(state.chain.askers.is_empty());
        }
        tokio::time::timeout(Duration::from_secs(5), second)
            .await
            .unwrap();
        stop_tests::stop_event(&mut events, |e| e["type"] == "message.complete").await;
        drop(
            tokio::time::timeout(Duration::from_secs(5), deleting)
                .await
                .unwrap(),
        );
        assert_eq!(processes(home.path()).len(), 2);
        let config = &processes(home.path())[1]["config"];
        assert_eq!(
            config["model"],
            if model { "replacement" } else { "fixture" }
        );
        assert_eq!(
            config["mcpServers"],
            if tools { json!([]) } else { json!(["removed"]) }
        );
        assert_eq!(
            current.tools.iter().any(|t| t["name"] == "message_bot"),
            !tools
        );
        runtime
            .call_inner(
                "alice",
                "prompt.submit",
                &json!({"session_id":id,"text":"later owner"}),
            )
            .await
            .unwrap();
        stop_tests::stop_event(&mut events, |e| e["type"] == "message.complete").await;
        let history = store::history(home.path(), "first").unwrap();
        let rows = history
            .iter()
            .filter(|r| r["role"] == "user")
            .collect::<Vec<_>>();
        assert_eq!(
            rows.iter()
                .map(|r| r["text"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["first background", "second background", "later owner"]
        );
        assert_eq!(
            rows.iter().map(|r| &r["display_kind"]).collect::<Vec<_>>(),
            [&json!("hidden"), &json!("hidden"), &json!("normal")]
        );
        let intents: (usize, usize) = store::open(home.path()).unwrap().query_row("SELECT COUNT(*),COUNT(consumed_by) FROM native_prompt_intents WHERE session_id='first'", [], |r| Ok((r.get(0)?,r.get(1)?))).unwrap();
        assert_eq!(intents, (3, 3));
        assert_eq!(chain.hops.load(Ordering::Acquire), 3);
        runtime.shutdown().await;
    }
}

#[tokio::test]
async fn cancelled_or_closed_background_waiters_leave_no_input_or_reader() {
    for close in [false, true] {
        let (home, runtime, hub) = setup();
        idle_stop_pi(home.path());
        let id = open(&runtime).await;
        let old = runtime.sessions.lock().unwrap()["first"].clone();
        let recovery = old.recovery_gate.lock().await;
        runtime
            .call_inner("alice", "session.interrupt", &json!({"session_id":id}))
            .await
            .unwrap();
        let mut pending =
            Box::pin(runtime.return_result("alice", "owl", "first", "cancelled background", None));
        assert!(futures_util::poll!(pending.as_mut()).is_pending());
        assert_eq!(old.input_waiters.load(Ordering::Acquire), 1);
        let landing = old.state.lock().unwrap().landing;
        assert_eq!(landing, 0);
        assert!(!runtime.busy_sections("owl").is_empty());
        if close {
            let mut events = hub.subscribe();
            assert!(runtime.close_stored("alice", "first").await.unwrap());
            tokio::time::timeout(Duration::from_secs(5), pending)
                .await
                .unwrap();
            let warning = stop_tests::stop_event(&mut events, |e| e["type"] == "warning").await;
            assert_eq!(warning["payload"]["error"], "session not found");
        } else {
            drop(pending);
        }
        assert_eq!(old.input_waiters.load(Ordering::Acquire), 0);
        let deleting = tokio::time::timeout(
            Duration::from_secs(5),
            runtime
                .admission
                .pause(crate::admission::Scope::Bot("owl".into())),
        )
        .await
        .unwrap();
        assert!(store::history(home.path(), "first").unwrap().is_empty());
        let intents: usize = store::open(home.path())
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM native_prompt_intents WHERE session_id='first'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(intents, 0);
        drop(deleting);
        drop(recovery);
        runtime.shutdown().await;
    }
}

#[tokio::test]
async fn background_reply_retries_after_an_earlier_replacement_fails() {
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
    let first = runtime.submit(&old, "failed startup", true, true, None, None);
    let background = runtime.return_result("alice", "owl", "first", "retained background", None);
    tokio::pin!(first, background);
    assert!(futures_util::poll!(first.as_mut()).is_pending());
    assert!(futures_util::poll!(background.as_mut()).is_pending());
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
    Runtime::command(&starting, json!({"type":"release_readiness"}))
        .await
        .unwrap();
    drop(starting);
    assert_eq!(first.await.unwrap_err().code, 5201);
    pump_released(failed).await;
    assert_eq!(old.input_waiters.load(Ordering::Acquire), 1);
    assert!(store::history(home.path(), "first").unwrap().is_empty());
    let intents: usize = store::open(home.path())
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM native_prompt_intents WHERE session_id='first'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        intents, 0,
        "startup failure has not created a durable intent to reconstruct"
    );
    fs::write(path, good).unwrap();
    tokio::time::timeout(Duration::from_secs(5), background)
        .await
        .unwrap();
    stop_tests::stop_event(&mut events, |e| e["type"] == "message.complete").await;
    let rows = store::history(home.path(), "first").unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["text"], "retained background");
    assert_eq!(rows[0]["display_kind"], "hidden");
    let intents: (usize, usize) = store::open(home.path()).unwrap().query_row("SELECT COUNT(*),COUNT(consumed_by) FROM native_prompt_intents WHERE session_id='first'", [], |r| Ok((r.get(0)?,r.get(1)?))).unwrap();
    assert_eq!(intents, (1, 1));
    assert_eq!(processes(home.path()).len(), 3);
    runtime.shutdown().await;
}
