use super::*;

#[tokio::test]
async fn accepted_follow_up_before_stop_is_resumed_before_new_owner_input() {
    let (home, runtime, hub) = setup();
    install_queue_pi(home.path(), false);
    open(&runtime).await;
    let s = runtime.sessions.lock().unwrap()["first"].clone();
    let mut events = hub.subscribe();
    runtime
        .submit(&s, "wait", false, false, None, None)
        .await
        .unwrap();
    stop_event(&mut events, |e| e["payload"]["text"] == "projected wait").await;
    runtime
        .submit(&s, "background result", true, true, None, None)
        .await
        .unwrap();
    assert_eq!(
        Runtime::command(&s, json!({"type":"get_state"}))
            .await
            .unwrap()["pendingMessageCount"],
        1
    );
    let stop = start_stop(&runtime, &s.id);
    stop_event(&mut events, |e| e["payload"]["text"] == "abort waiting").await;
    Runtime::command(&s, json!({"type":"release_abort"}))
        .await
        .unwrap();
    stop.await.unwrap().unwrap();
    // No owner prompt is needed to kick Pi's retained queue.
    stop_event(&mut events, |e| {
        e["payload"]["text"] == "projected background result"
    })
    .await;
    assert_eq!(
        runtime
            .submit(&s, "new owner input", false, false, None, None)
            .await
            .unwrap_err()
            .code,
        4002
    );
    assert_eq!(
        Runtime::command(&s, json!({"type":"get_state"}))
            .await
            .unwrap()["pendingMessageCount"],
        0
    );
    Runtime::command(&s, json!({"type":"finish_run"}))
        .await
        .unwrap();
    stop_event(&mut events, |e| {
        e["type"] == "message.complete" && e["payload"]["text"] == "finished"
    })
    .await;
    let history = store::history(home.path(), "first").unwrap();
    let results = history
        .iter()
        .filter(|r| r["role"] == "user" && r["text"] == "background result")
        .collect::<Vec<_>>();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0]["display_kind"], "hidden");
    assert!(s.state.lock().unwrap().display.is_empty());
    runtime.shutdown().await;
}

#[tokio::test]
async fn accepted_follow_up_keeps_its_uploads_intent_and_caller_chain_until_old_settlement() {
    let (home, runtime, hub) = setup();
    install_queue_pi(home.path(), true);
    open(&runtime).await;
    let s = runtime.sessions.lock().unwrap()["first"].clone();
    let mut events = hub.subscribe();
    runtime
        .submit(&s, "wait", false, false, None, None)
        .await
        .unwrap();
    stop_event(&mut events, |e| e["payload"]["text"] == "projected wait").await;
    let path = home.path().join("owned.txt");
    fs::write(&path, "owned attachment").unwrap();
    let image = json!({"type":"image","mimeType":"image/png","data":"fixture-image"});
    s.state.lock().unwrap().staged.push(Staged {
        id: "owned".into(),
        images: vec![image.clone()],
        refs: vec![path.to_string_lossy().into_owned()],
        files: vec![path.clone()],
    });
    let chain = Chain {
        hops: Arc::new(AtomicUsize::new(3)),
        askers: vec!["caller".into()],
    };
    runtime
        .submit(
            &s,
            "with attachment",
            true,
            true,
            Some(chain.clone()),
            Some(&["owned".into()]),
        )
        .await
        .unwrap();
    let original = s.state.lock().unwrap().inputs.front().unwrap().clone();
    let stop = start_stop(&runtime, &s.id);
    stop_event(&mut events, |e| e["payload"]["text"] == "abort idle").await;
    stop.await.unwrap().unwrap();
    assert!(s.state.lock().unwrap().display.is_empty());
    assert_eq!(
        s.state.lock().unwrap().inputs.front().unwrap().intent,
        original.intent
    );
    Runtime::command(&s, json!({"type":"release_settled"}))
        .await
        .unwrap();
    stop_event(&mut events, |e| {
        e["payload"]["text"]
            == format!(
                "projected {}",
                original.command["message"].as_str().unwrap()
            )
    })
    .await;
    {
        let state = s.state.lock().unwrap();
        assert!(Arc::ptr_eq(&state.chain.hops, &chain.hops));
        assert_eq!(state.chain.askers, chain.askers);
    }
    assert!(path.exists());
    let commands = fs::read_to_string(home.path().join("commands.jsonl"))
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str::<Value>(l).unwrap())
        .filter(|c| c["c"]["message"] == original.command["message"])
        .collect::<Vec<_>>();
    assert_eq!(commands.len(), 2);
    assert_eq!(commands[0]["c"]["images"], json!([image]));
    assert_eq!(commands[0]["c"]["images"], commands[1]["c"]["images"]);
    let conn = store::open(home.path()).unwrap();
    let (count, consumed): (i64, i64) = conn
        .query_row(
            "SELECT COUNT(*),COUNT(consumed_by) FROM native_prompt_intents WHERE id=?",
            [original.intent],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!((count, consumed), (1, 1));
    runtime.shutdown().await;
}

#[tokio::test]
async fn retained_steer_and_identical_hidden_follow_up_keep_their_own_display_intents() {
    let (home, runtime, hub) = setup();
    install_queue_pi(home.path(), false);
    open(&runtime).await;
    let s = runtime.sessions.lock().unwrap()["first"].clone();
    let mut events = hub.subscribe();
    runtime
        .submit(&s, "wait", false, false, None, None)
        .await
        .unwrap();
    stop_event(&mut events, |e| e["payload"]["text"] == "projected wait").await;
    runtime
        .submit(&s, "same text", true, true, None, None)
        .await
        .unwrap();
    runtime.steer(&s, "same text").await.unwrap();
    let stop = start_stop(&runtime, &s.id);
    stop_event(&mut events, |e| e["payload"]["text"] == "abort waiting").await;
    Runtime::command(&s, json!({"type":"release_abort"}))
        .await
        .unwrap();
    stop.await.unwrap().unwrap();
    stop_event(&mut events, |e| {
        e["payload"]["text"] == "projected same text"
    })
    .await;
    // The second recovered input must be accepted before the fixture finishes.
    let mut ended = s.run_ended.subscribe();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if !s.state.lock().unwrap().recovering {
                break;
            }
            ended.changed().await.unwrap();
        }
    })
    .await
    .unwrap();
    Runtime::command(&s, json!({"type":"finish_run"}))
        .await
        .unwrap();
    stop_event(&mut events, |e| {
        e["type"] == "message.complete" && e["payload"]["text"] == "finished"
    })
    .await;
    let rows = store::history(home.path(), "first")
        .unwrap()
        .into_iter()
        .filter(|r| r["text"] == "same text")
        .collect::<Vec<_>>();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0]["display_kind"], "normal");
    assert_eq!(rows[1]["display_kind"], "hidden");
    assert!(rows.iter().all(|r| r.get("_input_intent").is_none()));
    assert!(s.state.lock().unwrap().inputs.is_empty());
    assert!(s.state.lock().unwrap().display.is_empty());
    runtime.shutdown().await;
}

#[tokio::test]
async fn pre_stop_input_precedes_waiting_results_and_healthy_steering_keeps_pi_priority() {
    let (home, runtime, hub) = setup();
    install_queue_pi(home.path(), false);
    open(&runtime).await;
    let s = runtime.sessions.lock().unwrap()["first"].clone();
    let mut events = hub.subscribe();
    runtime
        .submit(&s, "wait", false, false, None, None)
        .await
        .unwrap();
    stop_event(&mut events, |e| e["payload"]["text"] == "projected wait").await;
    runtime
        .submit(&s, "before Stop", true, true, None, None)
        .await
        .unwrap();
    let stop = start_stop(&runtime, &s.id);
    stop_event(&mut events, |e| e["payload"]["text"] == "abort waiting").await;
    let result = runtime.submit(&s, "during Stop", true, true, None, None);
    let steer = runtime.steer(&s, "owner steer");
    tokio::pin!(result, steer);
    assert!(futures_util::poll!(result.as_mut()).is_pending());
    assert!(futures_util::poll!(steer.as_mut()).is_pending());
    assert!(s.state.lock().unwrap().display.is_empty());
    Runtime::command(&s, json!({"type":"release_abort"}))
        .await
        .unwrap();
    stop.await.unwrap().unwrap();
    let (result, steer) = tokio::time::timeout(Duration::from_secs(5), async {
        tokio::join!(result, steer)
    })
    .await
    .unwrap();
    result.unwrap();
    steer.unwrap();
    Runtime::command(&s, json!({"type":"finish_run"}))
        .await
        .unwrap();
    stop_event(&mut events, |e| {
        e["type"] == "message.complete" && e["payload"]["text"] == "finished"
    })
    .await;
    let rows = store::history(home.path(), "first")
        .unwrap()
        .into_iter()
        .filter(|r| r["role"] == "user")
        .collect::<Vec<_>>();
    assert_eq!(
        rows.iter()
            .map(|r| r["text"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["wait", "before Stop", "owner steer", "during Stop"]
    );
    assert_eq!(
        rows.iter()
            .map(|r| r["display_kind"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["normal", "hidden", "normal", "hidden"]
    );
    runtime.shutdown().await;
}

#[tokio::test]
async fn rejected_busy_steer_removes_only_its_own_staging_and_keeps_the_run_working() {
    let (home, runtime, hub) = setup();
    install_queue_pi(home.path(), false);
    let script = home.path().join("pi.cjs");
    let source = fs::read_to_string(&script).unwrap().replace("  const c = JSON.parse(line);", "  const c = JSON.parse(line); if(c.type === 'steer') { emit({type:'response',id:c.id,command:c.type,success:false,error:'steer rejected'}); return; }");
    fs::write(script, source).unwrap();
    open(&runtime).await;
    let s = runtime.sessions.lock().unwrap()["first"].clone();
    let mut events = hub.subscribe();
    runtime
        .submit(&s, "wait", false, false, None, None)
        .await
        .unwrap();
    stop_event(&mut events, |e| e["payload"]["text"] == "projected wait").await;
    assert!(runtime.steer(&s, "rejected steer").await.is_err());
    assert!(s.state.lock().unwrap().busy);
    assert!(s.state.lock().unwrap().display.is_empty());
    assert!(s.state.lock().unwrap().inputs.is_empty());
    let count: i64 = store::open(home.path())
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM native_prompt_intents WHERE text='rejected steer'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 0);
    Runtime::command(&s, json!({"type":"finish_run"}))
        .await
        .unwrap();
    stop_event(&mut events, |e| e["type"] == "message.complete").await;
    assert!(!s.state.lock().unwrap().busy);
    runtime.shutdown().await;
}

#[tokio::test]
async fn another_stop_during_recovered_preflight_keeps_the_original_input_retryable() {
    let (home, runtime, hub) = setup();
    install_queue_pi(home.path(), false);
    let script = home.path().join("pi.cjs");
    let source = fs::read_to_string(&script).unwrap()
        .replace("let active = false, abort;", "let active = false, abort, heldReplay; let holdReplay = true;")
        .replace("  if (c.type === 'abort') {", "  if(c.type === 'prompt' && c.message === 'recover twice' && !active && holdReplay) {holdReplay=false; heldReplay=c; status('replay preflight waiting'); return;}\n  if (c.type === 'abort') {if(heldReplay) {emit({type:'response',id:heldReplay.id,command:'prompt',success:false,error:'Prompt interrupted'}); heldReplay=undefined;}");
    fs::write(script, source).unwrap();
    open(&runtime).await;
    let s = runtime.sessions.lock().unwrap()["first"].clone();
    let mut events = hub.subscribe();
    runtime
        .submit(&s, "wait", false, false, None, None)
        .await
        .unwrap();
    stop_event(&mut events, |e| e["payload"]["text"] == "projected wait").await;
    runtime
        .submit(&s, "recover twice", true, true, None, None)
        .await
        .unwrap();
    let first = start_stop(&runtime, &s.id);
    stop_event(&mut events, |e| e["payload"]["text"] == "abort waiting").await;
    Runtime::command(&s, json!({"type":"release_abort"}))
        .await
        .unwrap();
    first.await.unwrap().unwrap();
    stop_event(&mut events, |e| {
        e["payload"]["text"] == "replay preflight waiting"
    })
    .await;
    let second = start_stop(&runtime, &s.id);
    stop_event(&mut events, |e| e["payload"]["text"] == "abort waiting").await;
    Runtime::command(&s, json!({"type":"release_abort"}))
        .await
        .unwrap();
    second.await.unwrap().unwrap();
    stop_event(&mut events, |e| {
        e["payload"]["text"] == "projected recover twice"
    })
    .await;
    assert!(!s.state.lock().unwrap().interrupted);
    assert!(!s.state.lock().unwrap().closed);
    let rows = store::history(home.path(), "first")
        .unwrap()
        .into_iter()
        .filter(|r| r["text"] == "recover twice")
        .collect::<Vec<_>>();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["display_kind"], "hidden");
    runtime.shutdown().await;
}

#[tokio::test]
async fn replay_preflight_that_starts_after_idle_abort_gets_its_own_abort_boundary() {
    let (home, runtime, hub) = setup();
    install_queue_pi(home.path(), false);
    let script = home.path().join("pi.cjs");
    let source = fs::read_to_string(&script).unwrap()
        .replace("let active = false, abort;", "let active = false, abort, heldReplay; let holdReplay = true;")
        .replace("require('node:readline').createInterface({input:process.stdin}).on('line', line => {\n  const c = JSON.parse(line);", "const handle = c => {\n  if(c.type === 'release_preflight') {response(c); handle(heldReplay); heldReplay=undefined; return;}\n  if(c.type === 'prompt' && c.message === 'late preflight' && !active && holdReplay) {holdReplay=false; heldReplay=c; status('replay preflight waiting'); return;}")
        .replace("\n});", "\n}; require('node:readline').createInterface({input:process.stdin}).on('line', line => handle(JSON.parse(line)));");
    fs::write(script, source).unwrap();
    open(&runtime).await;
    let s = runtime.sessions.lock().unwrap()["first"].clone();
    let mut events = hub.subscribe();
    runtime
        .submit(&s, "wait", false, false, None, None)
        .await
        .unwrap();
    stop_event(&mut events, |e| e["payload"]["text"] == "projected wait").await;
    runtime
        .submit(&s, "late preflight", true, true, None, None)
        .await
        .unwrap();
    let first = start_stop(&runtime, &s.id);
    stop_event(&mut events, |e| e["payload"]["text"] == "abort waiting").await;
    Runtime::command(&s, json!({"type":"release_abort"}))
        .await
        .unwrap();
    first.await.unwrap().unwrap();
    stop_event(&mut events, |e| {
        e["payload"]["text"] == "replay preflight waiting"
    })
    .await;
    let second = start_stop(&runtime, &s.id);
    stop_event(&mut events, |e| e["payload"]["text"] == "abort waiting").await;
    Runtime::command(&s, json!({"type":"release_abort"}))
        .await
        .unwrap();
    second.await.unwrap().unwrap();
    // An idle Pi abort need not cancel preflight. Its late acceptance starts
    // after the abort; it must be stopped before new input can be admitted.
    Runtime::command(&s, json!({"type":"release_preflight"}))
        .await
        .unwrap();
    stop_event(&mut events, |e| e["payload"]["text"] == "abort waiting").await;
    Runtime::command(&s, json!({"type":"release_abort"}))
        .await
        .unwrap();
    let mut ended = s.run_ended.subscribe();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if !s.state.lock().unwrap().recovering {
                break;
            }
            ended.changed().await.unwrap();
        }
    })
    .await
    .unwrap();
    assert!(!s.state.lock().unwrap().busy);
    assert!(!s.state.lock().unwrap().closed);
    let rows = store::history(home.path(), "first")
        .unwrap()
        .into_iter()
        .filter(|r| r["text"] == "late preflight")
        .collect::<Vec<_>>();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["display_kind"], "hidden");
    runtime
        .submit(&s, "next usable run", false, false, None, None)
        .await
        .unwrap();
    assert_fresh_dialog_paths(&runtime, &s, &hub).await;
    runtime.shutdown().await;
}

#[tokio::test]
async fn steer_waits_before_staging_during_idle_stop() {
    let (home, runtime, hub) = setup();
    install_stop_lifecycle_pi(home.path());
    open(&runtime).await;
    let s = runtime.sessions.lock().unwrap()["first"].clone();
    let mut events = hub.subscribe();
    let stop = start_stop(&runtime, &s.id);
    stop_event(&mut events, |e| e["payload"]["text"] == "abort waiting").await;
    let params = json!({"session_id":s.id,"text":"owner steer"});
    let steer = runtime.call_inner("alice", "session.steer", &params);
    tokio::pin!(steer);
    assert!(futures_util::poll!(steer.as_mut()).is_pending());
    assert!(s.state.lock().unwrap().display.is_empty());
    let count: i64 = store::open(home.path())
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM native_prompt_intents WHERE session_id='first'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 0);
    Runtime::command(&s, json!({"type":"release_abort"}))
        .await
        .unwrap();
    stop.await.unwrap().unwrap();
    tokio::time::timeout(Duration::from_secs(5), steer)
        .await
        .unwrap()
        .unwrap();
    stop_event(&mut events, |e| {
        e["payload"]["text"] == "projected owner steer"
    })
    .await;
    assert!(!s.state.lock().unwrap().interrupted);
    runtime.shutdown().await;
}

#[tokio::test]
async fn stop_claim_rejects_client_answer_before_dialog_cleanup() {
    for (method, event, answer) in [
        (
            "approval.respond",
            json!({"method":"confirm","title":"Continue?"}),
            json!({"choice":"once"}),
        ),
        (
            "approval.respond",
            json!({"method":"confirm","title":"Continue?"}),
            json!({"choice":"deny"}),
        ),
        (
            "clarify.respond",
            json!({"method":"input","title":"Which file?"}),
            json!({"answer":"file.txt"}),
        ),
    ] {
        let (home, runtime, _) = setup();
        open(&runtime).await;
        let s = runtime.sessions.lock().unwrap()["first"].clone();
        let mut event = event;
        event["id"] = json!("owned");
        event["type"] = json!("extension_ui_request");
        runtime.event(&s, event).unwrap();
        let stop = StopGuard::start(&s).unwrap();
        let mut p = answer;
        p["session_id"] = json!(s.id);
        p["request_id"] = json!("owned");
        assert_eq!(
            runtime
                .call_inner("alice", method, &p)
                .await
                .err()
                .unwrap()
                .code,
            4204
        );
        Runtime::cancel_dialogs(&s).await;
        Runtime::command(&s, json!({"type":"get_state"}))
            .await
            .unwrap();
        let replies = fs::read_to_string(home.path().join("dialogs.jsonl")).unwrap();
        assert_eq!(replies.lines().count(), 1);
        assert_eq!(
            serde_json::from_str::<Value>(replies.trim()).unwrap()["cancelled"],
            true
        );
        drop(stop);
        runtime.shutdown().await;
    }
}

#[tokio::test]
async fn client_response_waiting_for_capacity_loses_to_stop_once() {
    let (home, runtime, _) = setup();
    open(&runtime).await;
    let s = runtime.sessions.lock().unwrap()["first"].clone();
    runtime.event(&s, json!({"type":"extension_ui_request","id":"blocked","method":"confirm","title":"Continue?"})).unwrap();
    let held = s.process.hold_extension_admission();
    let p = json!({"session_id":s.id,"request_id":"blocked","choice":"once"});
    let answer = runtime.call_inner("alice", "approval.respond", &p);
    tokio::pin!(answer);
    assert!(futures_util::poll!(answer.as_mut()).is_pending());
    let stop = StopGuard::start(&s).unwrap();
    let cancel = Runtime::cancel_dialogs(&s);
    tokio::pin!(cancel);
    assert!(futures_util::poll!(cancel.as_mut()).is_pending());
    drop(held);
    assert_eq!(answer.await.unwrap_err().code, 4204);
    cancel.await;
    Runtime::command(&s, json!({"type":"get_state"}))
        .await
        .unwrap();
    let replies = fs::read_to_string(home.path().join("dialogs.jsonl")).unwrap();
    assert_eq!(replies.lines().count(), 1);
    assert_eq!(
        serde_json::from_str::<Value>(replies.trim()).unwrap()["cancelled"],
        true
    );
    drop(stop);
    runtime.shutdown().await;
}

#[tokio::test]
async fn committed_client_answers_survive_stop_and_cannot_be_claimed_twice() {
    for choice in ["once", "deny"] {
        let (home, runtime, _) = setup();
        open(&runtime).await;
        let s = runtime.sessions.lock().unwrap()["first"].clone();
        runtime.event(&s, json!({"type":"extension_ui_request","id":"committed","method":"confirm","title":"Continue?"})).unwrap();
        let p = json!({"request_id":"committed","choice":choice});
        let (_, write) = runtime.claim_answer(&s, "approval.respond", &p).unwrap();
        assert_eq!(
            runtime
                .claim_answer(&s, "approval.respond", &p)
                .err()
                .unwrap()
                .code,
            4204
        );
        let stop = StopGuard::start(&s).unwrap();
        Runtime::cancel_dialogs(&s).await;
        write.unwrap().wait().await.unwrap();
        Runtime::command(&s, json!({"type":"get_state"}))
            .await
            .unwrap();
        let replies = fs::read_to_string(home.path().join("dialogs.jsonl")).unwrap();
        assert_eq!(replies.lines().count(), 1);
        assert_eq!(
            serde_json::from_str::<Value>(replies.trim()).unwrap()["confirmed"],
            choice == "once"
        );
        drop(stop);
        runtime.shutdown().await;
    }
}

#[tokio::test]
async fn final_clarification_enqueue_error_keeps_partial_answers_retryable() {
    let (home, runtime, _) = setup();
    open(&runtime).await;
    let s = runtime.sessions.lock().unwrap()["first"].clone();
    runtime.event(&s, json!({"type":"extension_ui_request","id":"batch","method":"input","title":format!("__HEXBOT_CLARIFY__{}", json!({"questions":[{"qid":"a","question":"A?"},{"qid":"b","question":"B?"}]}))})).unwrap();
    let a = json!({"request_id":"batch","question_id":"a","answer":"first"});
    assert_eq!(
        runtime.claim_answer(&s, "clarify.respond", &a).unwrap().0["remaining"],
        json!(["b"])
    );
    assert_eq!(
        runtime
            .claim_answer(&s, "clarify.respond", &a)
            .err()
            .unwrap()
            .code,
        4202
    );
    let b = json!({"request_id":"batch","question_id":"b","answer":"second"});
    let held = s.process.hold_extension_admission();
    assert!(runtime.claim_answer(&s, "clarify.respond", &b).is_err());
    assert_eq!(
        s.state.lock().unwrap().pending["batch"]["answers"],
        json!({"a":"first"})
    );
    drop(held);
    let (_, write) = runtime.claim_answer(&s, "clarify.respond", &b).unwrap();
    write.unwrap().wait().await.unwrap();
    Runtime::command(&s, json!({"type":"get_state"}))
        .await
        .unwrap();
    let replies = fs::read_to_string(home.path().join("dialogs.jsonl")).unwrap();
    assert_eq!(replies.lines().count(), 1);
    let reply: Value = serde_json::from_str(replies.trim()).unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(reply["value"].as_str().unwrap()).unwrap(),
        json!({"a":"first","b":"second"})
    );
    runtime.shutdown().await;
}

#[tokio::test]
async fn native_response_claim_is_atomic_with_stop() {
    for committed in [false, true] {
        let (_home, runtime, hub) = setup();
        open(&runtime).await;
        let s = runtime.sessions.lock().unwrap()["first"].clone();
        let mut events = hub.subscribe();
        let native = {
            let (runtime, s) = (runtime.clone(), s.clone());
            tokio::spawn(async move {
                runtime
                    .native_approval(&s, json!({"tool":"execute_code"}))
                    .await
                    .unwrap()
            })
        };
        let card = stop_event(&mut events, |e| e["type"] == "approval.request").await;
        let p = json!({"request_id":card["payload"]["request_id"],"choice":"once"});
        if committed {
            assert!(
                runtime
                    .claim_answer(&s, "approval.respond", &p)
                    .unwrap()
                    .1
                    .is_none()
            );
        }
        let stop = StopGuard::start(&s).unwrap();
        if !committed {
            assert_eq!(
                runtime
                    .claim_answer(&s, "approval.respond", &p)
                    .err()
                    .unwrap()
                    .code,
                4204
            );
        }
        Runtime::cancel_dialogs(&s).await;
        assert_eq!(native.await.unwrap(), committed);
        drop(stop);
        runtime.shutdown().await;
    }
}

#[tokio::test]
async fn steering_waits_for_compaction_and_close_wakes_it_without_staging() {
    for close in [false, true] {
        let (home, runtime, hub) = setup();
        install_stop_lifecycle_pi(home.path());
        open(&runtime).await;
        let s = runtime.sessions.lock().unwrap()["first"].clone();
        let mut events = hub.subscribe();
        let compact = {
            let (runtime, s) = (runtime.clone(), s.clone());
            tokio::spawn(async move {
                runtime
                    .submit(&s, "/compact", false, false, None, None)
                    .await
            })
        };
        stop_event(&mut events, |e| e["payload"]["text"] == "compact waiting").await;
        let steer = runtime.steer(&s, "after compact");
        tokio::pin!(steer);
        assert!(futures_util::poll!(steer.as_mut()).is_pending());
        assert!(s.state.lock().unwrap().display.is_empty());
        if close {
            runtime.close_stored("alice", "first").await.unwrap();
            assert_eq!(steer.await.unwrap_err().code, 4001);
            assert!(compact.await.unwrap().is_err());
        } else {
            Runtime::command(&s, json!({"type":"release_compact"}))
                .await
                .unwrap();
            compact.await.unwrap().unwrap();
            steer.await.unwrap();
            stop_event(&mut events, |e| {
                e["payload"]["text"] == "projected after compact"
            })
            .await;
        }
        runtime.shutdown().await;
    }
}

#[tokio::test]
async fn close_rejects_input_waiting_for_admission_before_cleanup_or_a_prior_input() {
    for steer in [false, true] {
        let (home, runtime, _) = setup();
        open(&runtime).await;
        let s = runtime.sessions.lock().unwrap()["first"].clone();
        let input = s.input_gate.lock().await;
        let attachments = s.attachment_gate.lock().await;
        let pending = async {
            if steer {
                runtime.steer(&s, "waiting owner input").await
            } else {
                runtime
                    .submit(&s, "waiting result", true, true, None, None)
                    .await
            }
        };
        tokio::pin!(pending);
        assert!(futures_util::poll!(pending.as_mut()).is_pending());
        let close = runtime.close_stored("alice", "first");
        tokio::pin!(close);
        assert!(futures_util::poll!(close.as_mut()).is_pending());
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(5), pending)
                .await
                .unwrap()
                .unwrap_err()
                .code,
            4001
        );
        assert!(s.state.lock().unwrap().display.is_empty());
        let count: i64 = store::open(home.path())
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM native_prompt_intents WHERE session_id='first'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 0);
        drop(input);
        drop(attachments);
        assert!(close.await.unwrap());
        runtime.shutdown().await;
    }
}

// Hold the recovery worker independently of Stop and Pi settlement. A public
// owner request after idle must await this handoff, never fail as busy solely
// because the detached worker has not been scheduled yet.
#[tokio::test]
async fn owner_prompt_after_idle_stop_waits_for_empty_recovery_without_a_busy_error() {
    for mode in ["idle", "settled", "delayed settlement", "repeated"] {
        let (home, runtime, hub) = setup();
        install_stop_lifecycle_pi(home.path());
        let id = open(&runtime).await;
        let s = runtime.sessions.lock().unwrap()["first"].clone();
        let mut events = hub.subscribe();
        let recovery = s.recovery_gate.lock().await;
        if matches!(mode, "settled" | "delayed settlement") {
            runtime
                .call_inner(
                    "alice",
                    "prompt.submit",
                    &json!({"session_id":id,"text":"old run"}),
                )
                .await
                .unwrap();
            stop_event(&mut events, |e| e["payload"]["text"] == "projected old run").await;
        }
        let first = start_stop(&runtime, &id);
        stop_event(&mut events, |e| e["payload"]["text"] == "abort waiting").await;
        let second = if mode == "repeated" {
            let second = start_stop(&runtime, &id);
            stop_event(&mut events, |e| e["payload"]["text"] == "abort waiting").await;
            Some(second)
        } else {
            None
        };
        if mode == "settled" {
            Runtime::command(&s, json!({"type":"release_settled"}))
                .await
                .unwrap();
            stop_event(&mut events, |e| {
                e["type"] == "status.update" && e["payload"]["kind"] == "idle"
            })
            .await;
        }
        Runtime::command(&s, json!({"type":"release_abort"}))
            .await
            .unwrap();
        first.await.unwrap().unwrap();
        let params = json!({"session_id":id,"text":"fresh owner"});
        if let Some(second) = second {
            assert_eq!(
                runtime
                    .call_inner("alice", "prompt.submit", &params)
                    .await
                    .unwrap_err()
                    .code,
                4002
            );
            Runtime::command(&s, json!({"type":"release_abort"}))
                .await
                .unwrap();
            second.await.unwrap().unwrap();
        }
        if mode == "delayed settlement" {
            // An abort acknowledgement alone does not end the old operation.
            assert_eq!(
                runtime
                    .call_inner("alice", "prompt.submit", &params)
                    .await
                    .unwrap_err()
                    .code,
                4002
            );
            Runtime::command(&s, json!({"type":"release_settled"}))
                .await
                .unwrap();
            stop_event(&mut events, |e| {
                e["type"] == "status.update" && e["payload"]["kind"] == "idle"
            })
            .await;
        }
        assert!(runtime.status_for_bot("alice", "owl").is_none());
        let owner = runtime.call_inner("alice", "prompt.submit", &params);
        tokio::pin!(owner);
        let admission = futures_util::poll!(owner.as_mut());
        assert!(
            admission.is_pending(),
            "{mode}: empty recovery must not return a busy error: {admission:?}"
        );
        assert!(s.state.lock().unwrap().display.is_empty());
        drop(recovery);
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(5), owner)
                .await
                .unwrap()
                .unwrap()["status"],
            "submitted"
        );
        stop_event(&mut events, |e| {
            e["payload"]["text"] == "projected fresh owner"
        })
        .await;
        let rows = store::history(home.path(), "first").unwrap();
        let owners = rows
            .iter()
            .filter(|r| r["role"] == "user" && r["text"] == "fresh owner")
            .collect::<Vec<_>>();
        assert_eq!(owners.len(), 1);
        assert_eq!(owners[0]["display_kind"], "normal");
        assert!(!s.state.lock().unwrap().interrupted);
        assert!(s.state.lock().unwrap().display.is_empty());
        runtime.shutdown().await;
    }
}

#[tokio::test]
async fn manual_compaction_after_idle_stop_waits_for_empty_recovery() {
    let (home, runtime, hub) = setup();
    install_stop_lifecycle_pi(home.path());
    let id = open(&runtime).await;
    let s = runtime.sessions.lock().unwrap()["first"].clone();
    let recovery = s.recovery_gate.lock().await;
    let mut events = hub.subscribe();
    let stop = start_stop(&runtime, &id);
    stop_event(&mut events, |e| e["payload"]["text"] == "abort waiting").await;
    Runtime::command(&s, json!({"type":"release_abort"}))
        .await
        .unwrap();
    stop.await.unwrap().unwrap();
    let params = json!({"session_id":id,"text":"/compact"});
    let compact = runtime.call_inner("alice", "prompt.submit", &params);
    tokio::pin!(compact);
    let admission = futures_util::poll!(compact.as_mut());
    assert!(
        admission.is_pending(),
        "empty recovery must not reject compaction: {admission:?}"
    );
    assert!(!s.state.lock().unwrap().compacting);
    drop(recovery);
    let release = async {
        stop_event(&mut events, |e| e["payload"]["text"] == "compact waiting").await;
        Runtime::command(&s, json!({"type":"release_compact"}))
            .await
            .unwrap();
    };
    let (result, ()) = tokio::time::timeout(Duration::from_secs(5), async {
        tokio::join!(compact, release)
    })
    .await
    .unwrap();
    assert_eq!(result.unwrap()["status"], "completed");
    assert!(!s.state.lock().unwrap().busy);
    assert!(runtime.status_for_bot("alice", "owl").is_none());
    runtime.shutdown().await;
}

#[tokio::test]
async fn idle_owner_admission_cannot_overtake_retained_stop_input() {
    let (home, runtime, hub) = setup();
    install_queue_pi(home.path(), false);
    let id = open(&runtime).await;
    let s = runtime.sessions.lock().unwrap()["first"].clone();
    let mut events = hub.subscribe();
    runtime
        .submit(&s, "wait", false, false, None, None)
        .await
        .unwrap();
    stop_event(&mut events, |e| e["payload"]["text"] == "projected wait").await;
    runtime
        .submit(&s, "retained result", true, true, None, None)
        .await
        .unwrap();
    let recovery = s.recovery_gate.lock().await;
    let stop = start_stop(&runtime, &id);
    stop_event(&mut events, |e| e["payload"]["text"] == "abort waiting").await;
    Runtime::command(&s, json!({"type":"release_abort"}))
        .await
        .unwrap();
    stop.await.unwrap().unwrap();
    stop_event(&mut events, |e| {
        e["type"] == "status.update" && e["payload"]["kind"] == "idle"
    })
    .await;
    let params = json!({"session_id":id,"text":"fresh owner"});
    let owner = runtime.call_inner("alice", "prompt.submit", &params);
    tokio::pin!(owner);
    assert!(futures_util::poll!(owner.as_mut()).is_pending());
    drop(recovery);
    // Recovery starts a real busy run; the waiting owner still cannot replace it.
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(5), owner)
            .await
            .unwrap()
            .unwrap_err()
            .code,
        4002
    );
    stop_event(&mut events, |e| {
        e["payload"]["text"] == "projected retained result"
    })
    .await;
    Runtime::command(&s, json!({"type":"finish_run"}))
        .await
        .unwrap();
    stop_event(&mut events, |e| {
        e["type"] == "status.update" && e["payload"]["kind"] == "idle"
    })
    .await;
    runtime
        .call_inner("alice", "prompt.submit", &params)
        .await
        .unwrap();
    stop_event(&mut events, |e| {
        e["payload"]["text"] == "projected fresh owner"
    })
    .await;
    let users = store::history(home.path(), "first")
        .unwrap()
        .into_iter()
        .filter(|r| r["role"] == "user")
        .collect::<Vec<_>>();
    assert_eq!(
        users
            .iter()
            .map(|r| r["text"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["wait", "retained result", "fresh owner"]
    );
    assert_eq!(users[1]["display_kind"], "hidden");
    assert_eq!(users[2]["display_kind"], "normal");
    runtime.shutdown().await;
}

#[tokio::test]
async fn close_rejects_owner_input_waiting_for_empty_stop_recovery() {
    for text in ["fresh owner", "/compact"] {
        let (home, runtime, hub) = setup();
        install_stop_lifecycle_pi(home.path());
        let id = open(&runtime).await;
        let s = runtime.sessions.lock().unwrap()["first"].clone();
        let recovery = s.recovery_gate.lock().await;
        let mut events = hub.subscribe();
        let stop = start_stop(&runtime, &id);
        stop_event(&mut events, |e| e["payload"]["text"] == "abort waiting").await;
        Runtime::command(&s, json!({"type":"release_abort"}))
            .await
            .unwrap();
        stop.await.unwrap().unwrap();
        let params = json!({"session_id":id,"text":text});
        let owner = runtime.call_inner("alice", "prompt.submit", &params);
        tokio::pin!(owner);
        assert!(futures_util::poll!(owner.as_mut()).is_pending());
        runtime.close_stored("alice", "first").await.unwrap();
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(5), owner)
                .await
                .unwrap()
                .unwrap_err()
                .code,
            4001
        );
        assert!(s.state.lock().unwrap().display.is_empty());
        let intents: i64 = store::open(home.path())
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM native_prompt_intents WHERE session_id='first'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(intents, 0);
        drop(recovery);
        runtime.shutdown().await;
    }
}

#[tokio::test]
async fn omitted_queue_metadata_replays_ordered_original_envelopes() {
    let (home, runtime, hub) = setup();
    install_queue_pi(home.path(), false);
    let script = home.path().join("pi.cjs");
    let source = fs::read_to_string(&script).unwrap().replace(
        "response(c, {steering:steering.splice(0), followUp:queue.splice(0)})",
        "steering.splice(0); queue.splice(0); response(c, {steering:[], followUp:[]})",
    );
    fs::write(script, source).unwrap();
    open(&runtime).await;
    let s = runtime.sessions.lock().unwrap()["first"].clone();
    let mut events = hub.subscribe();
    runtime
        .submit(&s, "wait", false, false, None, None)
        .await
        .unwrap();
    stop_event(&mut events, |e| e["payload"]["text"] == "projected wait").await;
    let chain = Chain {
        hops: Arc::new(AtomicUsize::new(3)),
        askers: vec!["caller".into()],
    };
    let path = home.path().join("owned.txt");
    fs::write(&path, "owned").unwrap();
    let image = json!({"type":"image","mimeType":"image/png","data":"fixture-image"});
    for _ in 0..2 {
        s.state.lock().unwrap().staged.push(Staged {
            id: "owned".into(),
            images: vec![image.clone()],
            refs: vec![path.to_string_lossy().into_owned()],
            files: vec![path.clone()],
        });
        runtime
            .submit(
                &s,
                "same text",
                true,
                true,
                Some(chain.clone()),
                Some(&["owned".into()]),
            )
            .await
            .unwrap();
    }
    runtime.steer(&s, "same text").await.unwrap();
    let originals = s
        .state
        .lock()
        .unwrap()
        .inputs
        .iter()
        .filter(|i| i.display == "hidden")
        .cloned()
        .collect::<Vec<_>>();
    let stop = start_stop(&runtime, &s.id);
    stop_event(&mut events, |e| e["payload"]["text"] == "abort waiting").await;
    Runtime::command(&s, json!({"type":"release_abort"}))
        .await
        .unwrap();
    stop.await.unwrap().unwrap();
    stop_event(&mut events, |e| {
        e["payload"]["text"] == "projected same text"
    })
    .await;
    let mut ended = s.run_ended.subscribe();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if !s.state.lock().unwrap().recovering {
                break;
            }
            ended.changed().await.unwrap();
        }
    })
    .await
    .unwrap();
    {
        let state = s.state.lock().unwrap();
        assert_eq!(state.inputs.len(), 2);
        for (input, original) in state.inputs.iter().zip(&originals) {
            assert_eq!(input.intent, original.intent);
            assert_eq!(input.command, original.command);
            assert_eq!(input.display, "hidden");
            assert!(Arc::ptr_eq(&input.chain.hops, &chain.hops));
            assert_eq!(input.chain.askers, chain.askers);
            assert_eq!(input.chain.hops.load(Ordering::Relaxed), 3);
        }
    }
    assert!(path.exists());
    Runtime::command(&s, json!({"type":"finish_run"}))
        .await
        .unwrap();
    stop_event(&mut events, |e| {
        e["type"] == "message.complete" && e["payload"]["text"] == "finished"
    })
    .await;
    let users = store::history(home.path(), "first")
        .unwrap()
        .into_iter()
        .filter(|r| r["role"] == "user")
        .collect::<Vec<_>>();
    assert_eq!(users.len(), 4);
    assert_eq!(users[1]["text"], "same text");
    assert_eq!(users[1]["display_kind"], "normal");
    for (row, original) in users[2..].iter().zip(originals) {
        assert_eq!(row["text"], original.command["message"]);
        assert_eq!(row["display_kind"], "hidden");
        let consumed: i64 = store::open(home.path())
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM native_prompt_intents WHERE id=? AND consumed_by IS NOT NULL",
                [original.intent],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(consumed, 1);
    }
    assert!(s.state.lock().unwrap().inputs.is_empty());
    assert!(s.state.lock().unwrap().display.is_empty());
    runtime.shutdown().await;
}

#[tokio::test]
async fn unexplained_pi_queue_metadata_and_unconfirmed_omissions_fail_closed() {
    for unknown_text in [true, false] {
        let (home, runtime, hub) = setup();
        install_queue_pi(home.path(), false);
        let script = home.path().join("pi.cjs");
        let replacement = if unknown_text {
            "steering.splice(0); queue.splice(0); response(c, {steering:[], followUp:['unowned input']})"
        } else {
            "steering.splice(0); queue.splice(0); response(c, {steering:[], followUp:[]})"
        };
        let mut source = fs::read_to_string(&script).unwrap().replace(
            "response(c, {steering:steering.splice(0), followUp:queue.splice(0)})",
            replacement,
        );
        if !unknown_text {
            // A successful response without a queued disposition cannot prove
            // that an omitted input remains in Pi's queue.
            source = source.replace(
                "['prompt','steer'].includes(c.type)",
                "(['prompt','steer'].includes(c.type) && c.message !== 'known input')",
            );
        }
        fs::write(&script, source).unwrap();
        open(&runtime).await;
        let s = runtime.sessions.lock().unwrap()["first"].clone();
        let mut events = hub.subscribe();
        runtime
            .submit(&s, "wait", false, false, None, None)
            .await
            .unwrap();
        stop_event(&mut events, |e| e["payload"]["text"] == "projected wait").await;
        runtime
            .submit(&s, "known input", true, true, None, None)
            .await
            .unwrap();
        let stop = start_stop(&runtime, &s.id);
        stop_event(&mut events, |e| e["payload"]["text"] == "abort waiting").await;
        Runtime::command(&s, json!({"type":"release_abort"}))
            .await
            .unwrap();
        stop.await.unwrap().unwrap();
        let warning = stop_event(&mut events, |e| e["type"] == "warning").await;
        assert_eq!(
            warning["payload"]["error"],
            if unknown_text {
                "Pi queued input has no matching original intent"
            } else {
                "Pi omitted an unprojected input"
            }
        );
        let mut ended = s.run_ended.subscribe();
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if s.state.lock().unwrap().closed {
                    break;
                }
                ended.changed().await.unwrap();
            }
        })
        .await
        .unwrap();
        let users = store::history(home.path(), "first")
            .unwrap()
            .into_iter()
            .filter(|r| r["role"] == "user")
            .collect::<Vec<_>>();
        assert_eq!(users.len(), 1);
        assert_eq!(users[0]["text"], "wait");
        runtime.shutdown().await;
    }
}
