use super::*;

fn install_stop_pi(home: &Path) {
    fs::write(
        home.join("pi.cjs"),
        r#"#!/usr/bin/env node
const fs = require('node:fs');
const emit = event => process.stdout.write(JSON.stringify(event) + '\n');
const lines = require('node:readline').createInterface({input: process.stdin});
if (process.argv.includes('--no-session')) {
  lines.on('line', line => {
    const command = JSON.parse(line);
    emit({type: 'response', id: command.id, command: command.type, success: true, data: {}});
    if (command.type !== 'prompt') return;
    const socket = require('node:net').connect(Number(fs.readFileSync(__dirname + '/review-port', 'utf8')), '127.0.0.1', () => socket.write('reviewing\n'));
    socket.once('data', () => {
      emit({type: 'message_end', message: {role: 'assistant', content: [{type: 'text', text: '{"decision":"ask","risk":"high"}'}], stopReason: 'stop'}});
      emit({type: 'agent_settled'});
      socket.end();
    });
  });
} else {
  let late = null, abort = null, released = false;
  const approval = (id, review = false) => ({type: 'extension_ui_request', id, method: 'select', title: '__HEXBOT_APPROVAL__' + JSON.stringify({tool: 'bash', command: 'pwd', input: {command: 'pwd', full_access: true}, cwd: '/work', review}), options: ['once', 'session', 'deny']});
  const finishAbort = () => {
    if (!abort || late.size || !released) return;
    emit({type: 'response', id: abort.id, command: 'abort', success: true, data: {}});
    abort = null;
    emit({type: 'message_end', message: {role: 'assistant', content: [], stopReason: 'aborted'}});
    emit({type: 'agent_settled'});
  };
  lines.on('line', line => {
    const command = JSON.parse(line);
    if (command.type === 'extension_ui_response') {
      fs.appendFileSync(__dirname + '/dialogs.jsonl', JSON.stringify(command) + '\n');
      if (command.id === 'first' && command.cancelled) {
        const dialogs = [
          approval('late-approval'),
          approval('late-reviewed', true),
          {id: 'late-batch', method: 'input', title: '__HEXBOT_CLARIFY__' + JSON.stringify({questions: [{qid: 'why', question: 'Why?'}]})},
          {id: 'late-question', method: 'input', title: 'Another question?'},
          {id: 'late-confirm', method: 'confirm', title: 'Continue?'},
          {id: 'late-select', method: 'select', title: 'Choose', options: ['a', 'b']},
          {id: 'late-editor', method: 'editor', title: 'Edit this'},
          {id: 'late-tool', method: 'input', title: '__HEXBOT_TOOL__' + JSON.stringify({name: 'hexbot_todo_context', args: {}})},
        ];
        late = new Set(dialogs.map(dialog => dialog.id));
        for (const dialog of dialogs) emit({type: 'extension_ui_request', ...dialog});
      } else if (late && late.delete(command.id)) finishAbort();
      return;
    }
    if (command.type === 'abort' && late) {
      abort = command;
      emit({type: 'extension_ui_request', method: 'setStatus', statusText: 'abort waiting'});
      finishAbort();
      return;
    }
    emit({type: 'response', id: command.id, command: command.type, success: true, data: {}});
    if (command.type === 'get_state') { released = true; finishAbort(); }
    if (command.type === 'prompt') {
      emit({type: 'agent_start'});
      emit({type: 'message_end', message: {role: 'user', content: command.message}});
      emit({type: 'extension_ui_request', method: 'setStatus', statusText: 'prompt ready'});
      if (command.message === 'late-dialogs') emit(approval('first'));
      else if (command.message !== 'wait') emit({type: 'agent_settled'});
    }
    if (command.type === 'abort') emit({type: 'agent_settled'});
  });
}
"#,
    )
    .unwrap();
}

async fn stop_event(
    events: &mut tokio::sync::broadcast::Receiver<crate::events::Event>,
    matches: impl Fn(&Value) -> bool,
) -> Value {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let params = events.recv().await.unwrap().frame["params"].clone();
            if matches(&params) {
                return params;
            }
        }
    })
    .await
    .unwrap()
}

fn published_cards(hub: &EventHub, id: &str, since: u64) -> Vec<Value> {
    hub.since("alice", id, since)["events"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|event| {
            matches!(
                event["type"].as_str(),
                Some("approval.request" | "clarify.request")
            )
        })
        .cloned()
        .collect()
}

fn reviewed_request(id: &str) -> Value {
    json!({
        "type":"extension_ui_request", "id":id, "method":"select",
        "title":format!("__HEXBOT_APPROVAL__{}",json!({
            "tool":"bash", "command":"pwd", "input":{"command":"pwd","full_access":true},
            "cwd":"/work", "review":true
        })),
        "options":["once","session","deny"]
    })
}

#[tokio::test]
async fn stopping_cancels_late_approvals_and_questions_before_abort_finishes() {
    let (home, runtime, hub) = setup();
    install_stop_pi(home.path());
    db::open(home.path())
        .unwrap()
        .execute_batch("UPDATE bots SET approval_mode='manual'")
        .unwrap();
    let id = open(&runtime).await;
    let s = runtime.sessions.lock().unwrap()["first"].clone();
    let mut events = hub.subscribe();
    runtime
        .call_inner(
            "alice",
            "prompt.submit",
            &json!({"session_id":id,"text":"late-dialogs"}),
        )
        .await
        .unwrap();
    let first = stop_event(&mut events, |event| event["type"] == "approval.request").await;
    assert_eq!(first["payload"]["request_id"], "first");
    let native = {
        let (runtime, s) = (runtime.clone(), s.clone());
        tokio::spawn(async move {
            runtime
                .native_approval(&s, json!({"tool":"execute_code"}))
                .await
                .unwrap()
        })
    };
    stop_event(&mut events, |event| event["type"] == "approval.request").await;
    assert_eq!(
        runtime.status_for_bot("alice", "owl").unwrap()["status"],
        "needs_you"
    );
    let before = hub.since("alice", &id, 0)["latest_seq"].as_u64().unwrap();
    let stop = {
        let (runtime, id) = (runtime.clone(), id.clone());
        tokio::spawn(async move {
            runtime
                .call_inner("alice", "session.interrupt", &json!({"session_id":id}))
                .await
        })
    };
    stop_event(&mut events, |event| {
        event["type"] == "status.update" && event["payload"]["text"] == "abort waiting"
    })
    .await;
    assert!(!stop.is_finished());
    assert!(!native.await.unwrap());
    // A native RPC can reach approval independently of the cancelled bridge tasks.
    assert!(
        !tokio::time::timeout(
            Duration::from_secs(5),
            runtime.native_approval(&s, json!({"tool":"execute_code"}))
        )
        .await
        .unwrap()
        .unwrap()
    );
    Runtime::command(&s, json!({"type":"get_state"}))
        .await
        .unwrap();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(5), stop)
            .await
            .unwrap()
            .unwrap()
            .unwrap()["status"],
        "interrupted"
    );
    stop_event(&mut events, |event| event["type"] == "message.complete").await;
    assert!(s.state.lock().unwrap().pending.is_empty());
    assert!(s.state.lock().unwrap().native_approvals.is_empty());
    assert!(!s.state.lock().unwrap().busy);
    assert!(runtime.status_for_bot("alice", "owl").is_none());
    let replies = fs::read_to_string(home.path().join("dialogs.jsonl"))
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(replies.len(), 9);
    assert!(replies.iter().all(|reply| reply["cancelled"] == true));
    assert!(published_cards(&hub, &id, before).is_empty());

    // Stop applies to this turn. The next turn can ask through every path again.
    runtime
        .call_inner(
            "alice",
            "prompt.submit",
            &json!({"session_id":id,"text":"wait"}),
        )
        .await
        .unwrap();
    assert!(!s.state.lock().unwrap().interrupted);
    let mut events = hub.subscribe();
    runtime.event(&s, json!({"type":"extension_ui_request","id":"fresh-approval","method":"confirm","title":"Continue?"})).unwrap();
    stop_event(&mut events, |event| event["type"] == "approval.request").await;
    runtime
        .call_inner(
            "alice",
            "approval.respond",
            &json!({"session_id":id,"request_id":"fresh-approval","choice":"once"}),
        )
        .await
        .unwrap();
    runtime.event(&s, json!({"type":"extension_ui_request","id":"fresh-question","method":"input","title":format!("__HEXBOT_CLARIFY__{}",json!({"questions":[{"qid":"why","question":"Why?"}]}))})).unwrap();
    stop_event(&mut events, |event| event["type"] == "clarify.request").await;
    runtime
        .call_inner("alice", "clarify.respond", &json!({"session_id":id,"request_id":"fresh-question","question_id":"why","answer":"Continue"}))
        .await
        .unwrap();
    let native = {
        let (runtime, s) = (runtime.clone(), s.clone());
        tokio::spawn(async move {
            runtime
                .native_approval(&s, json!({"tool":"execute_code"}))
                .await
                .unwrap()
        })
    };
    let card = stop_event(&mut events, |event| event["type"] == "approval.request").await;
    runtime
        .call_inner(
            "alice",
            "approval.respond",
            &json!({"session_id":id,"request_id":card["payload"]["request_id"],"choice":"once"}),
        )
        .await
        .unwrap();
    assert!(native.await.unwrap());
    assert!(s.state.lock().unwrap().pending.is_empty());
    runtime.shutdown().await;
}

#[tokio::test]
async fn stopping_cancels_an_inflight_auto_review_without_a_fallback_card() {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    let (home, runtime, hub) = setup();
    install_stop_pi(home.path());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    fs::write(
        home.path().join("review-port"),
        listener.local_addr().unwrap().port().to_string(),
    )
    .unwrap();
    let id = open(&runtime).await;
    let s = runtime.sessions.lock().unwrap()["first"].clone();
    let mut events = hub.subscribe();
    runtime
        .call_inner(
            "alice",
            "prompt.submit",
            &json!({"session_id":id,"text":"wait"}),
        )
        .await
        .unwrap();
    stop_event(&mut events, |event| {
        event["payload"]["text"] == "prompt ready"
    })
    .await;
    let before = hub.since("alice", &id, 0)["latest_seq"].as_u64().unwrap();
    runtime.event(&s, reviewed_request("reviewing")).unwrap();
    let (socket, _) = tokio::time::timeout(Duration::from_secs(5), listener.accept())
        .await
        .unwrap()
        .unwrap();
    let mut socket = BufReader::new(socket);
    let mut line = String::new();
    tokio::time::timeout(Duration::from_secs(5), socket.read_line(&mut line))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(line, "reviewing\n");
    assert!(s.state.lock().unwrap().tool_dialogs.contains("reviewing"));
    runtime
        .call_inner("alice", "session.interrupt", &json!({"session_id":id}))
        .await
        .unwrap();
    stop_event(&mut events, |event| event["type"] == "message.complete").await;
    // The reviewer was terminated while blocked at its decision barrier.
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(5), socket.read_line(&mut line))
            .await
            .unwrap()
            .unwrap(),
        0
    );
    assert!(s.state.lock().unwrap().tool_dialogs.is_empty());
    assert!(s.state.lock().unwrap().pending.is_empty());
    assert_eq!(*s.reviewing.lock().unwrap(), 0);
    assert!(published_cards(&hub, &id, before).is_empty());
    let replies = fs::read_to_string(home.path().join("dialogs.jsonl")).unwrap();
    let reply: Value = serde_json::from_str(replies.trim()).unwrap();
    assert_eq!(reply["id"], "reviewing");
    assert_eq!(reply["cancelled"], true);

    // A fresh turn still reviews and can publish a card when the reviewer asks.
    runtime
        .call_inner(
            "alice",
            "prompt.submit",
            &json!({"session_id":id,"text":"wait"}),
        )
        .await
        .unwrap();
    stop_event(&mut events, |event| {
        event["payload"]["text"] == "prompt ready"
    })
    .await;
    runtime.event(&s, reviewed_request("fresh-review")).unwrap();
    let (mut socket, _) = tokio::time::timeout(Duration::from_secs(5), listener.accept())
        .await
        .unwrap()
        .unwrap();
    socket.write_all(b"finish\n").await.unwrap();
    let card = stop_event(&mut events, |event| event["type"] == "approval.request").await;
    assert_eq!(card["payload"]["request_id"], "fresh-review");
    assert_eq!(card["payload"]["choices"], json!(["once", "deny"]));
    runtime.shutdown().await;
}

#[tokio::test]
async fn a_queued_background_result_keeps_an_unsettled_turn_interrupted() {
    let (home, runtime, hub) = setup();
    install_stop_pi(home.path());
    let id = open(&runtime).await;
    let s = runtime.sessions.lock().unwrap()["first"].clone();
    runtime
        .submit(&s, "wait", false, false, None, None)
        .await
        .unwrap();
    Runtime::cancel_dialogs(&s).await;
    let before = hub.since("alice", &id, 0)["latest_seq"].as_u64().unwrap();

    // A delegate can finish after cancellation but before Pi settles the turn.
    runtime
        .return_result("alice", "owl", "first", "wait", None)
        .await;
    assert!(s.state.lock().unwrap().interrupted);
    runtime
        .event(
            &s,
            json!({"type":"extension_ui_request","id":"late-after-result","method":"input","title":"Continue?"}),
        )
        .unwrap();
    let mut replies = std::mem::take(&mut *s.requests.lock().unwrap());
    tokio::time::timeout(Duration::from_secs(5), async {
        while replies.join_next().await.is_some() {}
    })
    .await
    .unwrap();
    assert!(published_cards(&hub, &id, before).is_empty());
    assert!(s.state.lock().unwrap().pending.is_empty());

    Runtime::command(&s, json!({"type":"get_state"}))
        .await
        .unwrap();
    runtime.event(&s, json!({"type":"agent_settled"})).unwrap();
    runtime
        .submit(&s, "wait", false, false, None, None)
        .await
        .unwrap();
    assert!(!s.state.lock().unwrap().interrupted);
    runtime.shutdown().await;
}

#[tokio::test]
async fn cancellation_does_not_take_a_late_dialog_from_its_response_task() {
    struct LateDialog {
        runtime: Arc<Runtime>,
        session: Arc<Live>,
        arrived: Option<tokio::sync::oneshot::Sender<()>>,
    }
    impl Drop for LateDialog {
        fn drop(&mut self) {
            self.runtime
                .event(
                    &self.session,
                    json!({"type":"extension_ui_request","id":"arrived-during-cancel","method":"input","title":"Continue?"}),
                )
                .unwrap();
            let _ = self.arrived.take().unwrap().send(());
        }
    }

    let (home, runtime, _) = setup();
    install_stop_pi(home.path());
    open(&runtime).await;
    let s = runtime.sessions.lock().unwrap()["first"].clone();
    let backpressure = s.process.hold_extension_response().await;
    let (started, ready) = tokio::sync::oneshot::channel();
    let (arrived, delivered) = tokio::sync::oneshot::channel();
    let late = LateDialog {
        runtime: runtime.clone(),
        session: s.clone(),
        arrived: Some(arrived),
    };
    s.requests.lock().unwrap().spawn(async move {
        let _late = late;
        started.send(()).unwrap();
        std::future::pending::<()>().await;
    });
    ready.await.unwrap();

    // Aborting the old task delivers an actual extension event after Stop has
    // taken the old JoinSet, while its replacement owns the new response task.
    let cancel = Runtime::cancel_dialogs(&s);
    tokio::pin!(cancel);
    let mut finished = futures_util::poll!(cancel.as_mut()).is_ready();
    delivered.await.unwrap();
    if !finished {
        // Drive Stop past joining its old tasks, while the late dialog's own
        // response cannot finish. Any second cancellation now waits on the slot.
        finished = futures_util::poll!(cancel.as_mut()).is_ready();
    }
    drop(backpressure);
    if !finished {
        tokio::time::timeout(Duration::from_secs(5), cancel)
            .await
            .unwrap();
    }
    let mut replies = std::mem::take(&mut *s.requests.lock().unwrap());
    tokio::time::timeout(Duration::from_secs(5), async {
        while replies.join_next().await.is_some() {}
    })
    .await
    .unwrap();
    Runtime::command(&s, json!({"type":"get_state"}))
        .await
        .unwrap();
    let replies = fs::read_to_string(home.path().join("dialogs.jsonl")).unwrap();
    assert_eq!(replies.lines().count(), 1, "{replies}");
    let reply: Value = serde_json::from_str(replies.trim()).unwrap();
    assert_eq!(reply["id"], "arrived-during-cancel");
    assert_eq!(reply["cancelled"], true);
    runtime.shutdown().await;
}
