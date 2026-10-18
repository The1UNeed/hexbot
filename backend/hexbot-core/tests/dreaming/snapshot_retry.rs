use super::*;

fn durable_chat(home: &Path, stored: &str) {
    runtime_store::mark_fresh(home, stored).unwrap();
    let path = home
        .join("runtime/sessions")
        .join(stored)
        .join("conversation.jsonl");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(
        &path,
        format!("{}\n", json!({"type":"session","version":3,"id":stored})),
    )
    .unwrap();
    let message = json!({"role":"user","content":"durable speech","timestamp":100000});
    runtime_store::project_seeded(home, stored, "alice", "owl", &message, None, None).unwrap();
    use std::io::Write;
    writeln!(
        fs::OpenOptions::new().append(true).open(path).unwrap(),
        "{}",
        json!({"type":"message","id":common::id(),"parentId":null,"message":message})
    )
    .unwrap();
}

fn evidence(home: &Path) -> Value {
    let native = runtime_store::open(home).unwrap();
    json!({
        "raw":fs::read_to_string(log_path(home)).unwrap(),
        "journal":common::rows(&native,"SELECT * FROM native_pi_journal WHERE session_id='chat' ORDER BY rowid",&[]).unwrap(),
        "options":common::rows(&native,"SELECT * FROM native_sessions WHERE stored_id='chat'",&[]).unwrap(),
        "usage":runtime_store::usage(home,"chat").unwrap(),
        "usage_rows":common::rows(&native,"SELECT * FROM native_usage WHERE session_id='chat' ORDER BY id",&[]).unwrap(),
    })
}
fn progress(home: &Path) -> Value {
    let conn = db::open(home).unwrap();
    json!({
        "cutoff":last_successful_start(home,"owl",None).unwrap(),
        "pending":common::rows(&conn,"SELECT * FROM memory_proposals WHERE consumed_at IS NULL ORDER BY id",&[]).unwrap(),
        "memory":read_memory(home,"owl").unwrap(),
    })
}
async fn run_rpc(
    dreams: &Arc<Dreaming>,
    receiver: &mut tokio::sync::broadcast::Receiver<Event>,
) -> Value {
    dreams
        .call("alice", "hexbot.dreaming.run_now", &json!({"bot":"owl"}))
        .await
        .unwrap()
        .unwrap();
    event(receiver, "hexbot.dreaming.changed").await["dream"].clone()
}

// This companion corrects the old must-complete contract. Retries use the same
// public RPC as the first attempt, with its ordinary successful-start watermark.
async fn ordinary_retry(missing_raw: bool) {
    let home = setup();
    let h = home.path();
    // An earlier conversation must not turn a later refusal into partial success.
    db::open(h).unwrap().execute_batch("INSERT INTO sections(id,bot,owner_id,title,created_at,updated_at) VALUES('aaa','owl','alice','Earlier',0,0); INSERT INTO dreams(id,bot,started_at,status,summary) VALUES('previous','owl',1,'complete','previous report');").unwrap();
    durable_chat(h, "aaa");
    durable_chat(h, "chat");
    let assistant_at = (common::now() * 1000.).floor() / 1000.;
    let assistant = raw_message(assistant_at);
    propose_memory(
        h,
        "alice",
        "owl",
        "job",
        "add",
        &json!({"text":"pending proposal"}),
    )
    .unwrap();
    let before = progress(h);
    let committed = Arc::new(Mutex::new(Value::Null));
    let capture = committed.clone();
    let owned = h.to_path_buf();
    let message = assistant.clone();
    hooks().lock().unwrap().insert(
        owned.clone(),
        Box::new(move || {
            let until: f64 = db::open(&owned)
                .unwrap()
                .query_row(
                    "SELECT started_at FROM dreams WHERE status='running'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert!(assistant_at >= 1. && assistant_at < (until * 1000.).floor() / 1000.);
            runtime_store::project_seeded(&owned, "chat", "alice", "owl", &message, None, None)
                .unwrap();
            if !missing_raw {
                append_raw(&owned, &message);
            }
            *capture.lock().unwrap() = evidence(&owned);
        }),
    );
    let hub = EventHub::new();
    let mut receiver = hub.subscribe();
    let runtime = Runtime::new(h.into(), hub.clone(), fake_pi(h, false)).unwrap();
    let dreams = Dreaming::new(h.into(), runtime.clone(), hub);
    let first = run_rpc(&dreams, &mut receiver).await;
    let initial_progress = progress(h);
    let prompts = fs::read_to_string(h.join("prompts.log")).unwrap_or_default();
    eprintln!(
        "retry-first-effects {}",
        json!({"missing_raw":missing_raw,"dream":first,"progress_before":before,"progress_after":initial_progress,"prompts":prompts,"committed":*committed.lock().unwrap(),"after":evidence(h)})
    );
    assert_eq!(first["status"], "failed");
    assert!(prompts.is_empty());
    assert_eq!(initial_progress, before);
    assert_eq!(evidence(h), *committed.lock().unwrap());
    assert_eq!(runtime_store::usage(h, "chat").unwrap()["total_tokens"], 5);
    if missing_raw {
        let second = run_rpc(&dreams, &mut receiver).await;
        assert_eq!(second["status"], "failed");
        assert!(
            fs::read_to_string(h.join("prompts.log"))
                .unwrap_or_default()
                .is_empty()
        );
        assert_eq!(progress(h), before);
        assert_eq!(evidence(h), *committed.lock().unwrap());
        eprintln!(
            "retry-missing-effects {}",
            json!({"dream":second,"progress":progress(h),"storage":evidence(h)})
        );
        append_raw(h, &assistant);
    }
    let restored = evidence(h);
    let retry = run_rpc(&dreams, &mut receiver).await;
    assert_eq!(retry["status"], "complete");
    let prompts = fs::read_to_string(h.join("prompts.log")).unwrap();
    assert_eq!(prompts.matches("assistant: snapshot speech").count(), 1);
    assert!(prompts.contains("pending proposal"));
    assert!(last_successful_start(h, "owl", None).unwrap() > assistant_at);
    assert_eq!(progress(h)["pending"], json!([]));
    assert_eq!(evidence(h), restored);
    let next = run_rpc(&dreams, &mut receiver).await;
    assert_eq!(next["status"], "complete");
    let prompts = fs::read_to_string(h.join("prompts.log")).unwrap();
    assert_eq!(prompts.matches("daily Hexbot dream").count(), 2);
    assert_eq!(prompts.matches("assistant: snapshot speech").count(), 1);
    assert_eq!(evidence(h), restored);
    eprintln!(
        "retry-complete-effects {}",
        json!({"missing_raw":missing_raw,"retry":retry,"next":next,"prompts":prompts,"progress":progress(h),"storage":restored})
    );
    dreams.shutdown().await;
    runtime.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn healthy_late_append_defers_then_ordinary_rpc_retry_learns_once() {
    ordinary_retry(false).await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn missing_raw_refuses_both_rpc_attempts_until_restored_then_learns_once() {
    ordinary_retry(true).await;
}

fn control(case: &'static str, refuses: bool) {
    let home = setup();
    let h = home.path();
    durable_chat(h, "chat");
    let before = evidence(h);
    let owned = h.to_path_buf();
    hooks().lock().unwrap().insert(owned.clone(),Box::new(move || {
        let native=runtime_store::open(&owned).unwrap();
        match case {
            "unchanged" => {},
            "unavailable" => {native.execute("INSERT INTO native_unrecovered VALUES('chat')",[]).unwrap();},
            "quarantine" => {native.execute("INSERT INTO native_quarantine VALUES('chat','fixture')",[]).unwrap();},
            "fresh" => {native.execute("DELETE FROM native_fresh WHERE session_id='chat'",[]).unwrap();},
            "inactive" => {
                runtime_store::project_seeded(&owned,"chat","alice","owl",&raw_message(150.),None,None).unwrap();
                native.execute("UPDATE native_pi_journal SET active=0 WHERE session_id='chat' AND projection_seq=2",[]).unwrap();
            },
            "outside" | "until" => {
                let at=if case=="until" {200.} else {50.};
                runtime_store::project_seeded(&owned,"chat","alice","owl",&raw_message(at),None,None).unwrap();
            },
            "internal" => {
                runtime_store::append(&owned,"chat",json!({"role":"custom","text":"private instruction","timestamp":150.,"custom_type":"hexbot_todo","display_kind":"hidden"})).unwrap();
            },
            "branch" => {native.execute("UPDATE native_pi_journal SET active=0 WHERE session_id='chat'",[]).unwrap();},
            "multiplicity" => {
                runtime_store::append(&owned,"chat",json!({"role":"user","text":"durable speech","timestamp":100.})).unwrap();
            },
            "other" => {
                runtime_store::project_seeded(&owned,"unrelated","alice","owl",&raw_message(150.),None,None).unwrap();
            },
            _ => panic!("unknown control"),
        }
    }));
    let result = build_digest(h, "owl", 100., 200., None);
    eprintln!(
        "retry-control {}",
        json!({"case":case,"refused":result.is_err(),"result":result.as_ref().ok(),"before":before,"after":evidence(h)})
    );
    assert_eq!(result.is_err(), refuses, "{case}");
    if let Ok(digest) = result {
        assert_eq!(digest["sections"][0]["transcript"], "user: durable speech");
    }
    assert_eq!(evidence(h)["raw"], before["raw"]);
    assert_eq!(evidence(h)["options"], before["options"]);
}

#[test]
fn unchanged_snapshot_proceeds() {
    control("unchanged", false);
}
#[test]
fn exact_until_append_does_not_defer() {
    control("until", false);
}
#[test]
fn before_since_append_does_not_defer() {
    control("outside", false);
}
#[test]
fn inactive_append_does_not_defer() {
    control("inactive", false);
}
#[test]
fn hidden_instruction_append_does_not_defer() {
    control("internal", false);
}
#[test]
fn unrelated_conversation_does_not_defer() {
    control("other", false);
}
#[test]
fn active_branch_change_defers() {
    control("branch", true);
}
#[test]
fn duplicate_relevant_speech_defers() {
    control("multiplicity", true);
}
#[test]
fn unavailable_state_without_history_change_defers() {
    control("unavailable", true);
}
#[test]
fn quarantine_without_history_change_defers() {
    control("quarantine", true);
}
#[test]
fn fresh_state_without_history_change_defers() {
    control("fresh", true);
}

#[test]
fn adopted_source_requires_its_exact_version_even_for_outside_writes() {
    let home = setup();
    let h = home.path();
    durable_chat(h, "chat");
    let version = runtime_store::history_version(&runtime_store::open(h).unwrap(), "chat").unwrap();
    db::open(h).unwrap().execute_batch("INSERT INTO sections(id,bot,owner_id,title,created_at,updated_at) VALUES('target','owl','alice','Chat',0,0);").unwrap();
    db::open(h)
        .unwrap()
        .execute(
            "INSERT INTO settings VALUES('dream_chat_adoptions',?)",
            [json!({"chat":{"target":"target","version":version}}).to_string()],
        )
        .unwrap();
    assert_eq!(
        build_digest(h, "owl", 100., 200., None).unwrap()["sections"],
        json!([])
    );
    let owned = h.to_path_buf();
    hooks().lock().unwrap().insert(
        owned.clone(),
        Box::new(move || {
            runtime_store::project_seeded(
                &owned,
                "chat",
                "alice",
                "owl",
                &raw_message(200.),
                None,
                None,
            )
            .unwrap();
        }),
    );
    assert!(build_digest(h, "owl", 100., 200., None).is_err());
    assert_eq!(
        build_digest(h, "owl", 100., 200., None).unwrap()["sections"][0]["transcript"],
        "user: durable speech"
    );
}

#[test]
fn late_report_classification_defers_and_retry_keeps_structured_same_text() {
    let home = setup();
    let h = home.path();
    durable_chat(h, "chat");
    let mut report = raw_message(150.);
    let mut structured = report.clone();
    structured["content"]
        .as_array_mut()
        .unwrap()
        .push(json!({"type":"toolCall","id":"call","name":"read","arguments":{}}));
    for message in [&mut report, &mut structured] {
        runtime_store::project_seeded(h, "chat", "alice", "owl", message, None, None).unwrap();
        append_raw(h, message);
    }
    let before = evidence(h);
    let owned = h.to_path_buf();
    hooks().lock().unwrap().insert(
        owned.clone(),
        Box::new(move || {
            runtime_store::classify_dream_reports(
                &owned,
                "chat",
                &BTreeSet::from(["snapshot speech".to_owned()]),
            )
            .unwrap();
        }),
    );
    assert!(build_digest(h, "owl", 100., 200., None).is_err());
    let digest = build_digest(h, "owl", 100., 200., None).unwrap();
    assert_eq!(
        digest["sections"][0]["transcript"],
        "user: durable speech\nassistant: snapshot speech"
    );
    assert_eq!(evidence(h), before);
}
