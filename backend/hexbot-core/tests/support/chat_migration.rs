//! Public older-client migration paths through pinned Pi and a local provider.
use hexbot_core::{db, runtime_store as store, server::App};
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::Semaphore;
const LIMIT: Duration = Duration::from_secs(10);
fn snapshot(h: &Path, id: &str) -> Value {
    let c = store::open(h).unwrap();
    let raw = fs::read_to_string(
        h.join("runtime/sessions")
            .join(id)
            .join("conversation.jsonl"),
    )
    .unwrap_or_default();
    let frozen: Option<(String, String)> = c
        .query_row(
            "SELECT prompt,options FROM native_sessions WHERE stored_id=?",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .ok();
    let journal: Vec<Value> = {
        let mut s=c.prepare("SELECT entry_id,projection_seq,raw_json,active FROM native_pi_journal WHERE session_id=? ORDER BY projection_seq,entry_id").unwrap();
        s.query_map([id],|r|Ok(json!({"entry_id":r.get::<_,Option<String>>(0)?,"seq":r.get::<_,Option<i64>>(1)?,"raw":serde_json::from_str::<Value>(&r.get::<_,String>(2)?).unwrap(),"active":r.get::<_,i64>(3)?}))).unwrap().map(Result::unwrap).collect()
    };
    json!({"id":id,"raw":raw,"history":store::history(h,id).unwrap(),"version":store::history_version(&c,id).unwrap(),"usage":store::usage(h,id).unwrap(),"frozen":frozen,"journal":journal})
}
fn adoption(h: &Path) -> Value {
    let s: String = db::open(h)
        .unwrap()
        .query_row(
            "SELECT value FROM settings WHERE key='dream_chat_adoptions'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    serde_json::from_str(&s).unwrap()
}
struct Fixture {
    app: Arc<App>,
    requests: Arc<Mutex<Vec<Value>>>,
    rx: tokio::sync::mpsc::UnboundedReceiver<Value>,
    permit: Arc<Semaphore>,
    server: tokio::task::JoinHandle<()>,
}
async fn fixture(h: &Path) -> Fixture {
    fs::create_dir_all(h).unwrap();
    let pi =
        PathBuf::from(std::env::var_os("HEXBOT_TEST_PI").expect("set HEXBOT_TEST_PI to pinned Pi"));
    // Construct outside Tokio so unrelated description refresh work cannot race fixture seeding.
    let hh = h.to_path_buf();
    let app =
        std::thread::spawn(move || App::new(hh, "127.0.0.1:0".parse().unwrap(), pi, None).unwrap())
            .join()
            .unwrap();
    let c = db::open(h).unwrap();
    c.execute_batch("INSERT INTO bots(name,owner_id,description) VALUES('owl','local','Manual fixture'); INSERT INTO sections(id,bot,title,owner_id,created_at,updated_at) VALUES('log','owl','Dreams','local',1,1); INSERT INTO dreams(id,bot,started_at,status,summary) VALUES('dream','owl',1,'complete','REPORT');").unwrap();
    let workspace = h.parent().unwrap().join("workspace");
    fs::create_dir_all(&workspace).unwrap();
    c.execute(
        "INSERT INTO settings(key,value) VALUES('workspace_dir',?)",
        [json!(workspace).to_string()],
    )
    .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let requests = Arc::new(Mutex::new(Vec::<Value>::new()));
    let permit = Arc::new(Semaphore::new(0));
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    let record = requests.clone();
    let response = permit.clone();
    let router=axum::Router::new().route("/v1/chat/completions",axum::routing::post(move|axum::Json(body):axum::Json<Value>|{let(record,response,tx)=(record.clone(),response.clone(),tx.clone());async move{
  let index={let mut r=record.lock().unwrap();let i=r.len();r.push(body.clone());i};tx.send(body).unwrap();if index==0{response.acquire().await.unwrap().forget();}
  let chunk=json!({"id":format!("reply-{index}"),"object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{"role":"assistant","content":format!("fixture answer {index}")},"finish_reason":"stop"}],"usage":{"prompt_tokens":13,"completion_tokens":3,"total_tokens":16}});
  ([("content-type","text/event-stream")],format!("data: {chunk}\n\ndata: [DONE]\n\n"))
 }}));
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    fs::create_dir_all(h.join("profiles/owl")).unwrap();
    fs::write(h.join("profiles/owl/config.yaml"),format!("model:\n  provider: lmstudio\n  default: test-model\n  api_key: local-fixture\n  base_url: http://{address}/v1\ntools:\n  enabled_toolsets: []\n")).unwrap();
    let assistant = |text: &str, t: i64| json!({"role":"assistant","content":[{"type":"text","text":text}],"timestamp":t,"provider":"lmstudio","model":"test-model","api":"openai-completions","stopReason":"stop","usage":{"input":10,"output":2,"cacheRead":3,"cacheWrite":4,"totalTokens":19,"cost":{"total":0.37}}});
    let msgs = [
        assistant("REPORT", 1000),
        json!({"role":"user","content":[{"type":"text","text":"seed owner sentence"}],"timestamp":2000}),
        json!({"role":"assistant","content":[{"type":"text","text":"STRUCTURED_SPEECH"},{"type":"toolCall","id":"seed-tool","name":"read","arguments":{"path":"seed.txt"}}],"timestamp":2500,"provider":"lmstudio","model":"test-model","api":"openai-completions","stopReason":"toolUse","usage":{"input":10,"output":2,"cacheRead":3,"cacheWrite":4,"totalTokens":19,"cost":{"total":0.37}}}),
        json!({"role":"toolResult","toolCallId":"seed-tool","toolName":"read","content":[{"type":"text","text":"STRUCTURED_TOOL_OUTPUT"}],"timestamp":2750}),
        assistant("seed answer", 3000),
    ];
    let mut lines=vec![json!({"type":"session","version":3,"id":"log","timestamp":"2026-10-15T00:00:00Z","cwd":workspace}).to_string()];
    for (i, m) in msgs.into_iter().enumerate() {
        lines.push(json!({"type":"message","id":format!("seed{i}"),"parentId":if i==0{Value::Null}else{json!(format!("seed{}",i-1))},"timestamp":"2026-10-15T00:00:00Z","message":m}).to_string());
    }
    fs::write(
        store::session_dir(h, "log")
            .unwrap()
            .join("conversation.jsonl"),
        format!("{}\n", lines.join("\n")),
    )
    .unwrap();
    store::reconcile(h, "owl", "log", "local").unwrap();
    Fixture {
        app,
        requests,
        rx,
        permit,
        server,
    }
}
async fn idle(
    rx: &mut tokio::sync::broadcast::Receiver<hexbot_core::events::Event>,
    live: &str,
) -> Value {
    tokio::time::timeout(LIMIT, async {
        loop {
            let e = rx.recv().await.unwrap();
            let p = &e.frame["params"];
            if p["session_id"] == live
                && p["type"] == "status.update"
                && p["payload"]["kind"] == "idle"
            {
                return p.clone();
            }
        }
    })
    .await
    .unwrap()
}
async fn request(f: &mut Fixture) -> Value {
    tokio::time::timeout(LIMIT, f.rx.recv())
        .await
        .unwrap()
        .unwrap()
}
async fn call(app: &Arc<App>, method: &str, p: Value) -> Value {
    app.call("local", method, &p).await.unwrap()
}
async fn canonical(app: &Arc<App>) -> String {
    call(app, "hexbot.sections.create", json!({"bot":"owl"})).await["section"]["id"]
        .as_str()
        .unwrap()
        .into()
}
fn contains(h: &Value, text: &str) -> bool {
    h["history"]
        .as_array()
        .unwrap()
        .iter()
        .any(|m| m["text"].as_str().is_some_and(|s| s.contains(text)))
}

async fn rejects(app: &Arc<App>, method: &str, p: Value, code: i64) {
    let error = app.call("local", method, &p).await.unwrap_err();
    assert_eq!(error.code, code, "{method}: {error}");
}
fn evidence(name: &str, value: Value) {
    if let Some(dir) = std::env::var_os("HEXBOT_TEST_MIGRATION_EVIDENCE") {
        let dir = PathBuf::from(dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join(format!("{name}.json")),
            serde_json::to_vec_pretty(&value).unwrap(),
        )
        .unwrap();
    }
}
fn occurrences(snapshot: &Value, text: &str) -> usize {
    snapshot["history"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|m| m["text"].as_str() == Some(text))
        .count()
}
async fn restart(h: &Path) -> Arc<App> {
    let home = h.to_path_buf();
    let pi = PathBuf::from(std::env::var_os("HEXBOT_TEST_PI").unwrap());
    std::thread::spawn(move || App::new(home, "127.0.0.1:0".parse().unwrap(), pi, None).unwrap())
        .join()
        .unwrap()
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires HEXBOT_TEST_PI; local provider, no paid requests"]
async fn actual_pi_chat_migration_keeps_accepted_source_work_until_closed() {
    let root = tempfile::tempdir().unwrap();
    let h = root.path().join("home");
    let mut f = fixture(&h).await;
    let mut events = f.app.events.subscribe();
    let opened = call(&f.app, "hexbot.sections.open", json!({"id":"log"})).await;
    let live = opened["section"]["live_session_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let initial = snapshot(&h, "log");
    // Merely opening the source is enough: its future input is still admitted.
    assert_eq!(canonical(&f.app).await, "log");
    let upload=call(&f.app,"file.attach",json!({"session_id":live,"name":"OWNER_ATTACHMENT.txt","data_url":"data:text/plain;base64,T1dORVJfQVRUQUNITUVOVA=="})).await;
    assert_eq!(upload["attached"], true);
    assert_eq!(
        fs::read_to_string(upload["path"].as_str().unwrap()).unwrap(),
        "OWNER_ATTACHMENT"
    );
    assert_eq!(canonical(&f.app).await, "log");
    let first = call(
        &f.app,
        "prompt.submit",
        json!({"session_id":live,"text":"ACCEPTED_ORIGINAL_INPUT","attachments":[upload["id"]]}),
    )
    .await;
    assert_eq!(first["status"], "submitted");
    request(&mut f).await;
    let queued = call(
        &f.app,
        "prompt.submit",
        json!({"session_id":live,"text":"ACCEPTED_EQUAL_TEXT","queued":true}),
    )
    .await;
    assert_eq!(queued["status"], "submitted");
    let steer = call(
        &f.app,
        "session.steer",
        json!({"session_id":live,"text":"ACCEPTED_STEER"}),
    )
    .await;
    assert_eq!(steer["status"], "queued");
    assert_eq!(canonical(&f.app).await, "log");
    assert_eq!(snapshot(&h, "log")["frozen"], initial["frozen"]);
    f.permit.add_permits(1);
    idle(&mut events, &live).await;
    assert_eq!(canonical(&f.app).await, "log");
    // Equal text is another accepted occurrence, not a duplicate to discard.
    call(
        &f.app,
        "prompt.submit",
        json!({"session_id":live,"text":"ACCEPTED_EQUAL_TEXT"}),
    )
    .await;
    idle(&mut events, &live).await;
    // Observe the same recovered projection startup uses, including Pi's
    // empty internal catalog row, before checking migration preservation.
    store::reconcile(&h, "owl", "log", "local").unwrap();
    let settled = snapshot(&h, "log");
    assert_eq!(occurrences(&settled, "ACCEPTED_EQUAL_TEXT"), 2);
    assert!(settled["raw"].as_str().unwrap().contains("ACCEPTED_STEER"));
    assert!(
        settled["raw"]
            .as_str()
            .unwrap()
            .contains("OWNER_ATTACHMENT")
    );
    assert_eq!(settled["frozen"], initial["frozen"]);
    assert_eq!(canonical(&f.app).await, "log");
    call(&f.app, "hexbot.sections.close", json!({"id":"log"})).await;
    store::reconcile(&h, "owl", "log", "local").unwrap();
    let recovered = snapshot(&h, "log");
    for field in ["raw", "history", "usage", "frozen"] {
        assert_eq!(recovered[field], settled[field], "{field}");
    }
    let settled = recovered;
    // Shutdown/close has joined the actual process; adoption now has a stable source.
    let target = canonical(&f.app).await;
    assert_ne!(target, "log");
    let copied = snapshot(&h, &target);
    let retained = snapshot(&h, "log");
    assert_eq!(retained, settled);
    assert_eq!(occurrences(&copied, "ACCEPTED_EQUAL_TEXT"), 2);
    for text in [
        "ACCEPTED_ORIGINAL_INPUT",
        "ACCEPTED_EQUAL_TEXT",
        "ACCEPTED_STEER",
    ] {
        assert!(contains(&copied, text));
        assert!(copied["raw"].as_str().unwrap().contains(text));
    }
    assert!(!copied["raw"].as_str().unwrap().contains("REPORT"));
    assert_eq!(copied["usage"]["total_tokens"], 0);
    assert_eq!(occurrences(&copied, "STRUCTURED_SPEECH"), 1);
    assert_eq!(occurrences(&copied, "STRUCTURED_TOOL_OUTPUT"), 1);
    assert_eq!(adoption(&h)["log"]["version"], settled["version"]);
    // The old stored ID and the retired live ID never acknowledge new input.
    rejects(&f.app, "hexbot.sections.open", json!({"id":"log"}), 4002).await;
    rejects(
        &f.app,
        "hexbot.bots.introduce",
        json!({"section":"log","name":"owl"}),
        4002,
    )
    .await;
    for method in [
        "prompt.submit",
        "session.steer",
        "file.attach",
        "pdf.attach",
        "image.attach_bytes",
    ] {
        rejects(
            &f.app,
            method,
            json!({"session_id":live,"text":"REJECTED_OLD_INPUT"}),
            4001,
        )
        .await;
    }
    let modern = call(&f.app, "hexbot.sections.open", json!({"id":target})).await;
    let modern_live = modern["section"]["live_session_id"]
        .as_str()
        .unwrap()
        .to_owned();
    call(
        &f.app,
        "prompt.submit",
        json!({"session_id":modern_live,"text":"CANONICAL_CONTEXT_CHECK"}),
    )
    .await;
    idle(&mut events, &modern_live).await;
    let requests = f.requests.lock().unwrap().clone();
    let actual = requests.last().unwrap().to_string();
    for text in [
        "CANONICAL_CONTEXT_CHECK",
        "ACCEPTED_ORIGINAL_INPUT",
        "ACCEPTED_EQUAL_TEXT",
        "ACCEPTED_STEER",
    ] {
        assert!(actual.contains(text), "{text}");
    }
    assert_eq!(actual.matches("STRUCTURED_SPEECH").count(), 1);
    assert_eq!(actual.matches("STRUCTURED_TOOL_OUTPUT").count(), 1);
    assert!(!actual.contains("REJECTED_OLD_INPUT"));
    assert!(!actual.contains("REPORT"));
    assert_eq!(snapshot(&h, "log"), retained);
    let final_target = snapshot(&h, &target);
    f.app.shutdown().await;
    drop(f.app);
    let app = restart(&h).await;
    assert_eq!(canonical(&app).await, target);
    rejects(&app, "hexbot.sections.open", json!({"id":"log"}), 4002).await;
    let reopened = call(&app, "hexbot.sections.open", json!({"id":target})).await;
    assert!(
        reopened["messages"]
            .to_string()
            .contains("CANONICAL_CONTEXT_CHECK")
    );
    assert_eq!(snapshot(&h, "log"), retained);
    assert_eq!(snapshot(&h, &target)["usage"], final_target["usage"]);
    assert_eq!(
        occurrences(&snapshot(&h, &target), "ACCEPTED_EQUAL_TEXT"),
        2
    );
    evidence(
        "accepted-work",
        json!({"source":retained,"copied":copied,"requests":requests,"after_restart":snapshot(&h,&target),"target":target}),
    );
    app.shutdown().await;
    f.server.abort();
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires HEXBOT_TEST_PI; local provider, no paid requests"]
async fn actual_pi_adopted_source_refuses_reopen_before_any_new_input() {
    let root = tempfile::tempdir().unwrap();
    let h = root.path().join("home");
    let mut f = fixture(&h).await;
    f.permit.add_permits(1);
    let target = canonical(&f.app).await;
    assert_ne!(target, "log");
    let original = snapshot(&h, "log");
    let copied = snapshot(&h, &target);
    rejects(&f.app, "hexbot.sections.open", json!({"id":"log"}), 4002).await;
    rejects(
        &f.app,
        "hexbot.bots.introduce",
        json!({"section":"log","name":"owl"}),
        4002,
    )
    .await;
    assert_eq!(snapshot(&h, "log"), original);
    assert_eq!(snapshot(&h, &target), copied);
    assert!(f.requests.lock().unwrap().is_empty());
    let mut events = f.app.events.subscribe();
    let opened = call(&f.app, "hexbot.sections.open", json!({"id":target})).await;
    let live = opened["section"]["live_session_id"].as_str().unwrap();
    call(
        &f.app,
        "prompt.submit",
        json!({"session_id":live,"text":"MODERN_HEALTHY_INPUT"}),
    )
    .await;
    request(&mut f).await;
    idle(&mut events, live).await;
    assert!(contains(&snapshot(&h, &target), "MODERN_HEALTHY_INPUT"));
    assert_eq!(snapshot(&h, "log"), original);
    f.app.shutdown().await;
    drop(f.app);
    let app = restart(&h).await;
    assert_eq!(canonical(&app).await, target);
    rejects(&app, "hexbot.sections.open", json!({"id":"log"}), 4002).await;
    assert_eq!(snapshot(&h, "log"), original);
    evidence(
        "adopted-source",
        json!({"source":original,"copied":copied,"target":target,"requests":f.requests.lock().unwrap().clone(),"after_restart":snapshot(&h,&target)}),
    );
    app.shutdown().await;
    f.server.abort();
}
