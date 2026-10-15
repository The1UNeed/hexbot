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
    if (command.type === 'release_abort') { released = true; finishAbort(); }
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
    Runtime::command(&s, json!({"type":"release_abort"}))
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

// Pi 1.0.1 queues follow-ups while streaming, retains them on abort, and
// starts a fresh run for a prompt received while idle. stop-queue.test.mjs
// checks this contract against the pinned package with a local provider.
fn install_queue_pi(home: &Path, idle_before_settled: bool) {
    fs::write(
        home.join("idle-before-settled"),
        json!(idle_before_settled).to_string(),
    )
    .unwrap();
    fs::write(home.join("pi.cjs"), r#"#!/usr/bin/env node
const fs = require('node:fs');
const emit = event => process.stdout.write(JSON.stringify(event) + '\n');
const status = text => emit({type:'extension_ui_request', method:'setStatus', statusText:text});
const response = (c, data = {}) => emit({type:'response', id:c.id, command:c.type, success:true, data});
const idleBeforeSettled = JSON.parse(fs.readFileSync(__dirname + '/idle-before-settled'));
let active = false, abort;
const queue = [];
const delivered = text => emit({type:'message_end', message:{role:'user', content:text}});
const finishAbort = () => {
  active = false;
  emit({type:'message_end', message:{role:'assistant', content:[], stopReason:'aborted'}});
  if (!idleBeforeSettled) emit({type:'agent_settled'});
  response(abort);
  abort = undefined;
  status('abort idle');
};
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const c = JSON.parse(line);
  fs.appendFileSync(__dirname + '/commands.jsonl', JSON.stringify({active, c}) + '\n');
  if (c.type === 'extension_ui_response') {
    fs.appendFileSync(__dirname + '/dialogs.jsonl', JSON.stringify(c) + '\n');
    return;
  }
  if (c.type === 'abort') {
    abort = c;
    if (idleBeforeSettled) finishAbort();
    else status('abort waiting');
    return;
  }
  response(c, c.type === 'get_state' ? {isStreaming:active, pendingMessageCount:queue.length} : {});
  if (c.type === 'release_abort') finishAbort();
  if (c.type === 'release_settled') emit({type:'agent_settled'});
  if (c.type === 'prompt') {
    if (active && c.streamingBehavior === 'followUp') { queue.push(c.message); return; }
    active = true;
    emit({type:'agent_start'});
    delivered(c.message);
    status('projected ' + c.message);
    if (c.message === 'background result') emit({type:'extension_ui_request', id:'fresh-question', method:'input', title:'Which file?'});
  }
  if (c.type === 'finish_run') {
    for (const text of queue.splice(0)) delivered(text);
    active = false;
    emit({type:'message_end', message:{role:'assistant', content:[{type:'text', text:'finished'}], stopReason:'stop'}});
    emit({type:'agent_settled'});
  }
});
"#).unwrap();
}

async fn queued_result_after_stop(idle_before_settled: bool) {
    let (home, runtime, hub) = setup();
    install_queue_pi(home.path(), idle_before_settled);
    let id = open(&runtime).await;
    let s = runtime.sessions.lock().unwrap()["first"].clone();
    let mut events = hub.subscribe();
    runtime
        .submit(&s, "wait", false, false, None, None)
        .await
        .unwrap();
    stop_event(&mut events, |event| {
        event["payload"]["text"] == "projected wait"
    })
    .await;
    let stop = {
        let (runtime, id) = (runtime.clone(), id.clone());
        tokio::spawn(async move {
            runtime
                .call_inner("alice", "session.interrupt", &json!({"session_id":id}))
                .await
                .unwrap()
        })
    };
    stop_event(&mut events, |event| {
        event["payload"]["text"]
            == if idle_before_settled {
                "abort idle"
            } else {
                "abort waiting"
            }
    })
    .await;
    assert!(s.state.lock().unwrap().busy);
    assert!(s.state.lock().unwrap().interrupted);
    let before = hub.since("alice", &id, 0)["latest_seq"].as_u64().unwrap();
    let result = runtime.return_result("alice", "owl", "first", "background result", None);
    tokio::pin!(result);
    assert!(futures_util::poll!(result.as_mut()).is_pending());

    // A continuation's agent_start may have been in flight when Stop arrived.
    runtime.event(&s, json!({"type":"agent_start"})).unwrap();
    runtime.event(&s, json!({"type":"extension_ui_request","id":"late-question","method":"input","title":"Continue?"})).unwrap();
    let mut replies = std::mem::take(&mut *s.requests.lock().unwrap());
    tokio::time::timeout(Duration::from_secs(5), async {
        while replies.join_next().await.is_some() {}
    })
    .await
    .unwrap();
    assert!(published_cards(&hub, &id, before).is_empty());
    assert!(s.state.lock().unwrap().interrupted);
    Runtime::command(&s, json!({"type":"get_state"}))
        .await
        .unwrap();
    let commands = fs::read_to_string(home.path().join("commands.jsonl")).unwrap();
    assert!(!commands.contains("background result"), "{commands}");

    Runtime::command(
        &s,
        json!({"type":if idle_before_settled { "release_settled" } else { "release_abort" }}),
    )
    .await
    .unwrap();
    tokio::time::timeout(Duration::from_secs(5), result)
        .await
        .unwrap();
    stop.await.unwrap();
    let card = stop_event(&mut events, |event| event["type"] == "clarify.request").await;
    assert_eq!(card["payload"]["request_id"], "fresh-question");
    assert!(!s.state.lock().unwrap().interrupted);
    assert!(s.state.lock().unwrap().busy);
    let commands = fs::read_to_string(home.path().join("commands.jsonl"))
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    let delivered = commands
        .iter()
        .filter(|command| command["c"]["message"] == "background result")
        .collect::<Vec<_>>();
    assert_eq!(delivered.len(), 1);
    assert_eq!(
        delivered[0]["active"], false,
        "result must start a new Pi run"
    );
    runtime
        .call_inner(
            "alice",
            "clarify.respond",
            &json!({"session_id":id,"request_id":"fresh-question","answer":"file.txt"}),
        )
        .await
        .unwrap();
    Runtime::command(&s, json!({"type":"finish_run"}))
        .await
        .unwrap();
    stop_event(&mut events, |event| {
        event["type"] == "message.complete" && event["payload"]["text"] == "finished"
    })
    .await;
    assert!(!s.state.lock().unwrap().busy);
    assert!(s.state.lock().unwrap().display.is_empty());
    let history = store::history(home.path(), "first").unwrap();
    let delivered = history
        .iter()
        .filter(|row| row["role"] == "user" && row["text"] == "background result")
        .collect::<Vec<_>>();
    assert_eq!(delivered.len(), 1);
    assert_eq!(delivered[0]["display_kind"], "hidden");
    runtime
        .submit(&s, "next user turn", false, false, None, None)
        .await
        .unwrap();
    runtime.shutdown().await;
}

#[tokio::test]
async fn a_result_arriving_while_pi_aborts_waits_and_starts_a_fresh_run() {
    queued_result_after_stop(false).await;
}

#[tokio::test]
async fn a_result_arriving_after_pi_is_idle_waits_for_daemon_settlement() {
    queued_result_after_stop(true).await;
}

#[tokio::test]
async fn settlement_reopens_every_dialog_path_even_with_undelivered_input() {
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
        .submit(&s, "wait", false, false, None, None)
        .await
        .unwrap();
    stop_event(&mut events, |event| {
        event["payload"]["text"] == "prompt ready"
    })
    .await;
    Runtime::cancel_dialogs(&s).await;
    // Model a new prompt already admitted before the old settlement was
    // projected. A generic agent_start must not clear Stop; this boundary must.
    s.state.lock().unwrap().display.push_back("hidden".into());
    runtime.event(&s, json!({"type":"agent_settled"})).unwrap();
    assert!(s.state.lock().unwrap().busy);
    assert!(!s.state.lock().unwrap().interrupted);
    runtime.event(&s, json!({"type":"agent_start"})).unwrap();
    runtime.event(&s, json!({"type":"extension_ui_request","id":"fresh-approval","method":"confirm","title":"Continue?"})).unwrap();
    let card = stop_event(&mut events, |event| event["type"] == "approval.request").await;
    assert_eq!(card["payload"]["request_id"], "fresh-approval");
    runtime
        .call_inner(
            "alice",
            "approval.respond",
            &json!({"session_id":id,"request_id":"fresh-approval","choice":"once"}),
        )
        .await
        .unwrap();
    runtime.event(&s, json!({"type":"extension_ui_request","id":"fresh-batch","method":"input","title":format!("__HEXBOT_CLARIFY__{}",json!({"questions":[{"qid":"file","question":"Which file?"}]}))})).unwrap();
    let card = stop_event(&mut events, |event| event["type"] == "clarify.request").await;
    assert_eq!(card["payload"]["request_id"], "fresh-batch");
    runtime.call_inner("alice", "clarify.respond", &json!({"session_id":id,"request_id":"fresh-batch","question_id":"file","answer":"file.txt"})).await.unwrap();
    for name in ["hexbot_session_settings", "hexbot_todo_context"] {
        runtime.event(&s, json!({"type":"extension_ui_request","id":name,"method":"input","title":format!("__HEXBOT_TOOL__{}",json!({"name":name,"args":{}}))})).unwrap();
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
    let replies = fs::read_to_string(home.path().join("dialogs.jsonl"))
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    for name in ["hexbot_session_settings", "hexbot_todo_context"] {
        let response = replies.iter().find(|reply| reply["id"] == name).unwrap();
        assert_ne!(response["cancelled"], true);
        let value: Value = serde_json::from_str(response["value"].as_str().unwrap()).unwrap();
        assert!(value.get("result").is_some(), "{response}");
        assert!(value.get("error").is_none(), "{response}");
    }
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
    let backpressure = s.process.hold_extension_admission();
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

// Control command replies independently of run events. Idle abort and manual
// compaction do not produce agent_settled in Pi 1.0.1.
fn install_stop_lifecycle_pi(home: &Path) {
    fs::write(home.join("pi.cjs"), r#"#!/usr/bin/env node
const fs = require('node:fs');
const emit = event => process.stdout.write(JSON.stringify(event) + '\n');
const status = text => emit({type:'extension_ui_request', method:'setStatus', statusText:text});
const reply = (c, success = true) => emit({type:'response', id:c.id, command:c.type, success, data:{}, error:success ? undefined : 'fixture rejection'});
let compact, prompt;
const stops = [];
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const c = JSON.parse(line);
  fs.appendFileSync(__dirname + '/commands.jsonl', JSON.stringify(c) + '\n');
  if (c.type === 'extension_ui_response') {
    fs.appendFileSync(__dirname + '/dialogs.jsonl', JSON.stringify(c) + '\n');
    return;
  }
  if (c.type === 'compact') { compact = c; status('compact waiting'); return; }
  if (c.type === 'prompt' && c.message === 'reject') { prompt = c; status('prompt waiting'); return; }
  if (c.type === 'hold') { status('command held'); return; }
  if (c.type === 'abort') { stops.push(c); status('abort waiting'); return; }
  if (c.type === 'exit_pi') process.exit(0);
  if (c.type === 'release_compact' || c.type === 'fail_compact') { reply(compact, c.type === 'release_compact'); compact = undefined; }
  if (c.type === 'fail_prompt') { reply(prompt, false); prompt = undefined; }
  if (c.type === 'release_abort' || c.type === 'fail_abort') reply(stops.shift(), c.type === 'release_abort');
  if (c.type === 'release_settled') emit({type:'agent_settled'});
  reply(c);
  if (c.type === 'prompt') {
    emit({type:'agent_start'});
    emit({type:'message_end', message:{role:'user', content:c.message}});
    status('projected ' + c.message);
  }
});
"#).unwrap();
}

fn start_stop(runtime: &Arc<Runtime>, id: &str) -> tokio::task::JoinHandle<Result<Value>> {
    let (runtime, id) = (runtime.clone(), id.to_owned());
    tokio::spawn(async move {
        runtime
            .call_inner("alice", "session.interrupt", &json!({"session_id":id}))
            .await
    })
}

async fn assert_fresh_dialog_paths(runtime: &Arc<Runtime>, s: &Arc<Live>, hub: &EventHub) {
    let mut events = hub.subscribe();
    runtime.event(s, json!({"type":"extension_ui_request","id":"fresh-confirm","method":"confirm","title":"Continue?"})).unwrap();
    let card = stop_event(&mut events, |event| event["type"] == "approval.request").await;
    assert_eq!(card["payload"]["request_id"], "fresh-confirm");
    runtime
        .call_inner(
            "alice",
            "approval.respond",
            &json!({"session_id":s.id,"request_id":"fresh-confirm","choice":"once"}),
        )
        .await
        .unwrap();
    runtime.event(s, json!({"type":"extension_ui_request","id":"fresh-clarify","method":"input","title":format!("__HEXBOT_CLARIFY__{}",json!({"questions":[{"qid":"file","question":"Which file?"}]}))})).unwrap();
    stop_event(&mut events, |event| event["type"] == "clarify.request").await;
    runtime.call_inner("alice", "clarify.respond", &json!({"session_id":s.id,"request_id":"fresh-clarify","question_id":"file","answer":"file.txt"})).await.unwrap();
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
            &json!({"session_id":s.id,"request_id":card["payload"]["request_id"],"choice":"once"}),
        )
        .await
        .unwrap();
    assert!(native.await.unwrap());
    for name in ["hexbot_session_settings", "hexbot_todo_context"] {
        runtime.event(s, json!({"type":"extension_ui_request","id":name,"method":"input","title":format!("__HEXBOT_TOOL__{}",json!({"name":name,"args":{}}))})).unwrap();
    }
    let mut replies = std::mem::take(&mut *s.requests.lock().unwrap());
    tokio::time::timeout(Duration::from_secs(5), async {
        while replies.join_next().await.is_some() {}
    })
    .await
    .unwrap();
    Runtime::command(s, json!({"type":"get_state"}))
        .await
        .unwrap();
    let replies = fs::read_to_string(runtime.home.join("dialogs.jsonl"))
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    for name in ["hexbot_session_settings", "hexbot_todo_context"] {
        let reply = replies.iter().find(|reply| reply["id"] == name).unwrap();
        assert_ne!(reply["cancelled"], true);
        let value: Value = serde_json::from_str(reply["value"].as_str().unwrap()).unwrap();
        assert!(value.get("result").is_some(), "{reply}");
        assert!(value.get("error").is_none(), "{reply}");
    }
}

async fn result_waits_for_stop_and_command(command: &str, completion: &str, stop_first: bool) {
    let (home, runtime, hub) = setup();
    install_stop_lifecycle_pi(home.path());
    db::open(home.path())
        .unwrap()
        .execute_batch("UPDATE bots SET approval_mode='manual'")
        .unwrap();
    let id = open(&runtime).await;
    let s = runtime.sessions.lock().unwrap()["first"].clone();
    let mut events = hub.subscribe();
    let pending_command = {
        let (runtime, s, command) = (runtime.clone(), s.clone(), command.to_owned());
        tokio::spawn(async move { runtime.submit(&s, &command, false, false, None, None).await })
    };
    stop_event(&mut events, |event| {
        event["payload"]["text"]
            == if command == "reject" {
                "prompt waiting"
            } else {
                "compact waiting"
            }
    })
    .await;
    let mut stop = start_stop(&runtime, &id);
    stop_event(&mut events, |event| {
        event["payload"]["text"] == "abort waiting"
    })
    .await;
    let result = runtime.return_result("alice", "owl", "first", "background result", None);
    tokio::pin!(result);
    if stop_first {
        assert!(futures_util::poll!(result.as_mut()).is_pending());
        Runtime::command(&s, json!({"type":"release_abort"}))
            .await
            .unwrap();
        (&mut stop).await.unwrap().unwrap();
        // No agent_settled will follow. The command completion must wake us.
        assert!(futures_util::poll!(result.as_mut()).is_pending());
        Runtime::command(&s, json!({"type":completion}))
            .await
            .unwrap();
    } else {
        Runtime::command(&s, json!({"type":completion}))
            .await
            .unwrap();
    }
    let response = pending_command.await.unwrap();
    assert_eq!(response.is_ok(), completion == "release_compact");
    if !stop_first {
        assert!(!s.state.lock().unwrap().busy);
        assert!(
            futures_util::poll!(result.as_mut()).is_pending(),
            "result bypassed the outstanding Stop after {completion}"
        );
        assert!(s.state.lock().unwrap().display.is_empty());
        let conn = store::open(home.path()).unwrap();
        let intents: i64 = conn.query_row("SELECT COUNT(*) FROM native_prompt_intents WHERE session_id='first' AND text='background result'", [], |row| row.get(0)).unwrap();
        assert_eq!(intents, 0);
        Runtime::command(&s, json!({"type":"release_abort"}))
            .await
            .unwrap();
        (&mut stop).await.unwrap().unwrap();
    }
    tokio::time::timeout(Duration::from_secs(5), result)
        .await
        .unwrap();
    stop_event(&mut events, |event| {
        event["payload"]["text"] == "projected background result"
    })
    .await;
    assert!(!s.state.lock().unwrap().interrupted);
    assert_fresh_dialog_paths(&runtime, &s, &hub).await;
    runtime.shutdown().await;
}

#[tokio::test]
async fn compact_success_keeps_results_waiting_for_stop() {
    result_waits_for_stop_and_command("/compact", "release_compact", false).await;
}
#[tokio::test]
async fn compact_failure_keeps_results_waiting_for_stop() {
    result_waits_for_stop_and_command("/compact", "fail_compact", false).await;
}
#[tokio::test]
async fn prompt_failure_keeps_results_waiting_for_stop() {
    result_waits_for_stop_and_command("reject", "fail_prompt", false).await;
}
#[tokio::test]
async fn compact_success_wakes_results_after_stop_has_finished() {
    result_waits_for_stop_and_command("/compact", "release_compact", true).await;
}
#[tokio::test]
async fn compact_failure_wakes_results_after_stop_has_finished() {
    result_waits_for_stop_and_command("/compact", "fail_compact", true).await;
}
#[tokio::test]
async fn prompt_failure_wakes_results_after_stop_has_finished() {
    result_waits_for_stop_and_command("reject", "fail_prompt", true).await;
}

async fn idle_stop_result(concurrent: bool, detach_caller: bool) {
    let (home, runtime, hub) = setup();
    install_stop_lifecycle_pi(home.path());
    let id = open(&runtime).await;
    let s = runtime.sessions.lock().unwrap()["first"].clone();
    let mut events = hub.subscribe();
    let mut first = start_stop(&runtime, &id);
    stop_event(&mut events, |event| {
        event["payload"]["text"] == "abort waiting"
    })
    .await;
    let second = if concurrent {
        let stop = {
            let runtime = runtime.clone();
            tokio::spawn(async move { runtime.interrupt_stored("alice", "first").await })
        };
        stop_event(&mut events, |event| {
            event["payload"]["text"] == "abort waiting"
        })
        .await;
        Some(stop)
    } else {
        None
    };
    if detach_caller {
        first.abort();
        assert!((&mut first).await.unwrap_err().is_cancelled());
    }
    let result = runtime.return_result("alice", "owl", "first", "background result", None);
    tokio::pin!(result);
    assert!(futures_util::poll!(result.as_mut()).is_pending());
    assert!(s.state.lock().unwrap().display.is_empty());
    for text in ["fresh prompt", "/compact"] {
        assert_eq!(
            runtime
                .submit(&s, text, false, false, None, None)
                .await
                .unwrap_err()
                .code,
            4002
        );
    }
    Runtime::command(&s, json!({"type":"release_abort"}))
        .await
        .unwrap();
    if let Some(second) = second {
        // Completion of the first idle Stop cannot release the second's waiters.
        assert!(!second.is_finished());
        // A get_state reply orders us after the first abort reply, but its
        // request task may still be completing. Wait for that first guard too.
        let mut ended = s.run_ended.subscribe();
        loop {
            if s.state.lock().unwrap().stops == 1 {
                break;
            }
            ended.changed().await.unwrap();
        }
        assert!(futures_util::poll!(result.as_mut()).is_pending());
        Runtime::command(&s, json!({"type":"release_abort"}))
            .await
            .unwrap();
        assert!(second.await.unwrap().unwrap());
    }
    tokio::time::timeout(Duration::from_secs(5), result)
        .await
        .unwrap();
    stop_event(&mut events, |event| {
        event["payload"]["text"] == "projected background result"
    })
    .await;
    if !detach_caller {
        first.await.unwrap().unwrap();
    }
    assert_eq!(s.state.lock().unwrap().stops, 0);
    assert!(!s.state.lock().unwrap().interrupted);
    runtime.shutdown().await;
}

#[tokio::test]
async fn idle_stop_releases_results_without_agent_settled() {
    idle_stop_result(false, false).await;
}
#[tokio::test]
async fn concurrent_idle_stops_release_results_only_after_both_finish() {
    idle_stop_result(true, false).await;
}
#[tokio::test]
async fn disconnected_stop_caller_does_not_strand_results() {
    idle_stop_result(false, true).await;
}

#[tokio::test]
async fn settlement_during_stop_keeps_dialogs_and_results_cancelled_until_stop_finishes() {
    let (home, runtime, hub) = setup();
    install_stop_lifecycle_pi(home.path());
    let id = open(&runtime).await;
    let s = runtime.sessions.lock().unwrap()["first"].clone();
    let mut events = hub.subscribe();
    runtime
        .submit(&s, "wait", false, false, None, None)
        .await
        .unwrap();
    stop_event(&mut events, |event| {
        event["payload"]["text"] == "projected wait"
    })
    .await;
    let stop = start_stop(&runtime, &id);
    stop_event(&mut events, |event| {
        event["payload"]["text"] == "abort waiting"
    })
    .await;
    Runtime::command(&s, json!({"type":"release_settled"}))
        .await
        .unwrap();
    stop_event(&mut events, |event| event["type"] == "message.complete").await;
    assert!(!s.state.lock().unwrap().interrupted);
    assert!(!s.state.lock().unwrap().busy);
    let before = hub.since("alice", &id, 0)["latest_seq"].as_u64().unwrap();
    for (id, method, title) in [
        ("late-confirm", "confirm", "Continue?".to_owned()),
        (
            "late-review",
            "select",
            reviewed_request("late-review")["title"]
                .as_str()
                .unwrap()
                .to_owned(),
        ),
        (
            "late-tool",
            "input",
            format!(
                "__HEXBOT_TOOL__{}",
                json!({"name":"hexbot_session_settings","args":{}})
            ),
        ),
    ] {
        runtime
            .event(
                &s,
                json!({"type":"extension_ui_request","id":id,"method":method,"title":title}),
            )
            .unwrap();
    }
    assert!(
        !runtime
            .native_approval(&s, json!({"tool":"execute_code"}))
            .await
            .unwrap()
    );
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
    assert_eq!(replies.lines().count(), 3, "{replies}");
    assert!(
        replies
            .lines()
            .all(|line| serde_json::from_str::<Value>(line).unwrap()["cancelled"] == true)
    );
    assert!(published_cards(&hub, &id, before).is_empty());
    let result = runtime.return_result("alice", "owl", "first", "background result", None);
    tokio::pin!(result);
    assert!(futures_util::poll!(result.as_mut()).is_pending());
    assert!(s.state.lock().unwrap().display.is_empty());
    Runtime::command(&s, json!({"type":"release_abort"}))
        .await
        .unwrap();
    stop.await.unwrap().unwrap();
    tokio::time::timeout(Duration::from_secs(5), result)
        .await
        .unwrap();
    assert_fresh_dialog_paths(&runtime, &s, &hub).await;
    runtime.shutdown().await;
}

async fn stop_failure_rejects_waiting_result(reason: &str) {
    let (home, runtime, hub) = setup();
    install_stop_lifecycle_pi(home.path());
    open(&runtime).await;
    let s = runtime.sessions.lock().unwrap()["first"].clone();
    let mut events = hub.subscribe();
    runtime
        .submit(&s, "wait", false, false, None, None)
        .await
        .unwrap();
    stop_event(&mut events, |event| {
        event["payload"]["text"] == "projected wait"
    })
    .await;
    let stop = {
        let (runtime, s, deadline) = (
            runtime.clone(),
            s.clone(),
            if reason == "deadline" {
                Duration::from_secs(1)
            } else {
                DEADLINE
            },
        );
        tokio::spawn(async move { runtime.interrupt(&s, deadline).await })
    };
    stop_event(&mut events, |event| {
        event["payload"]["text"] == "abort waiting"
    })
    .await;
    let result = runtime.return_result("alice", "owl", "first", "background result", None);
    tokio::pin!(result);
    assert!(futures_util::poll!(result.as_mut()).is_pending());
    match reason {
        "close" => {
            // Block process cleanup: explicit close must wake at the closed
            // state transition, before shutdown or process-exit projection.
            let attachment = s.attachment_gate.lock().await;
            let close = runtime.close_stored("alice", "first");
            tokio::pin!(close);
            assert!(futures_util::poll!(close.as_mut()).is_pending());
            tokio::time::timeout(Duration::from_secs(5), result.as_mut())
                .await
                .unwrap();
            drop(attachment);
            assert!(close.await.unwrap());
        }
        "exit" => {
            assert!(
                Runtime::command(&s, json!({"type":"exit_pi"}))
                    .await
                    .is_err()
            );
        }
        "abort error" => {
            // Shutdown may overtake this control command's own reply.
            let _ = Runtime::command(&s, json!({"type":"fail_abort"})).await;
        }
        "deadline" => {}
        _ => unreachable!(),
    }
    if reason != "close" {
        tokio::time::timeout(Duration::from_secs(5), result)
            .await
            .unwrap();
    }
    assert!(
        tokio::time::timeout(Duration::from_secs(5), stop)
            .await
            .unwrap()
            .unwrap()
            .is_err()
    );
    let warning = stop_event(&mut events, |event| {
        event["type"] == "warning"
            && event["payload"]["message"] == "A background result could not be delivered"
    })
    .await;
    assert!(
        warning["payload"]["error"]
            .as_str()
            .unwrap()
            .contains("session")
    );
    assert!(s.state.lock().unwrap().closed);
    assert_eq!(s.state.lock().unwrap().stops, 0);
    assert!(
        !fs::read_to_string(home.path().join("commands.jsonl"))
            .unwrap()
            .contains("background result")
    );
    assert_eq!(
        runtime
            .submit(&s, "later", true, true, None, None)
            .await
            .unwrap_err()
            .code,
        4001
    );
    runtime.shutdown().await;
}

#[tokio::test]
async fn explicit_close_rejects_results_before_process_cleanup() {
    stop_failure_rejects_waiting_result("close").await;
}
#[tokio::test]
async fn pi_exit_rejects_results_waiting_on_stop() {
    stop_failure_rejects_waiting_result("exit").await;
}
#[tokio::test]
async fn abort_error_closes_instead_of_stranding_results() {
    stop_failure_rejects_waiting_result("abort error").await;
}
#[tokio::test]
async fn abort_deadline_closes_instead_of_stranding_results() {
    stop_failure_rejects_waiting_result("deadline").await;
}

#[tokio::test]
async fn abort_admission_error_releases_stop_and_rejects_waiting_results() {
    let (home, runtime, hub) = setup();
    install_stop_lifecycle_pi(home.path());
    open(&runtime).await;
    let s = runtime.sessions.lock().unwrap()["first"].clone();
    let mut events = hub.subscribe();
    let mut commands = tokio::task::JoinSet::new();
    // Exhaust the real transport admission slots, before any abort is sent.
    for _ in 0..PiOptions::new("", "", "").request_capacity {
        let s = s.clone();
        commands.spawn(async move { Runtime::command(&s, json!({"type":"hold"})).await });
        stop_event(&mut events, |event| {
            event["payload"]["text"] == "command held"
        })
        .await;
    }
    let stop = runtime.interrupt(&s, DEADLINE);
    tokio::pin!(stop);
    assert!(futures_util::poll!(stop.as_mut()).is_pending());
    let result = runtime.return_result("alice", "owl", "first", "background result", None);
    tokio::pin!(result);
    assert!(futures_util::poll!(result.as_mut()).is_pending());
    let error = tokio::time::timeout(Duration::from_secs(5), stop)
        .await
        .unwrap()
        .unwrap_err();
    assert!(error.message.contains("Too many pending"), "{error:?}");
    tokio::time::timeout(Duration::from_secs(5), result)
        .await
        .unwrap();
    stop_event(&mut events, |event| {
        event["type"] == "warning"
            && event["payload"]["message"] == "A background result could not be delivered"
    })
    .await;
    assert!(s.state.lock().unwrap().closed);
    assert_eq!(s.state.lock().unwrap().stops, 0);
    while let Some(result) = commands.join_next().await {
        assert!(result.unwrap().is_err());
    }
    assert!(
        !fs::read_to_string(home.path().join("commands.jsonl"))
            .unwrap()
            .contains("background result")
    );
    assert_eq!(
        runtime.interrupt(&s, DEADLINE).await.unwrap_err().code,
        4001
    );
    runtime.shutdown().await;
}
