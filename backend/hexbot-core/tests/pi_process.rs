use std::{fs, path::PathBuf, time::Duration};

use hexbot_core::pi::{PiError, PiEvents, PiOptions, PiProcess};
use serde_json::json;
use tempfile::TempDir;

const DEADLINE: Duration = Duration::from_secs(5);

struct Fixture {
    _home: TempDir,
    options: PiOptions,
}
impl Fixture {
    fn new(script: &str) -> Self {
        let home = tempfile::tempdir().unwrap();
        let working = home.path().join("working");
        let agent = home.path().join("agent");
        fs::create_dir(&working).unwrap();
        fs::create_dir(&agent).unwrap();
        let source = home.path().join("fixture.cjs");
        // Read stdin bytes and split on LF only, like the actual Pi protocol.
        fs::write(&source, format!(r#"
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const reply = (request, data) => send({{type:'response', id:request.id, command:request.type, success:true, data}});
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {{
  input += chunk;
  let index;
  while ((index = input.indexOf('\n')) >= 0) {{
    const request = JSON.parse(input.slice(0,index));
    input = input.slice(index+1);
    receive(request);
  }}
}});
{script}
"#)).unwrap();
        let mut options = PiOptions::new(PathBuf::from("node"), working, agent);
        options.args = vec![source.to_string_lossy().into_owned()];
        Self {
            _home: home,
            options,
        }
    }
    fn spawn(&self) -> (PiProcess, PiEvents) {
        PiProcess::spawn(self.options.clone()).unwrap()
    }
}

#[tokio::test]
async fn correlates_out_of_order_responses_and_preserves_unicode_events() {
    let fixture = Fixture::new(
        r#"
const waiting = [];
function receive(request) {
  waiting.push(request);
  if (waiting.length !== 2) return;
  send({type:'message_update', text:'hello\u2028世界\u2029end'});
  reply(waiting[1], {message:waiting[1].message});
  reply(waiting[0], {message:waiting[0].message});
}
"#,
    );
    let (process, mut events) = fixture.spawn();
    let (first, second) = tokio::join!(
        process.request(json!({"type":"first", "message":"one"}), DEADLINE),
        process.request(json!({"type":"second", "message":"two"}), DEADLINE)
    );
    assert_eq!(first.unwrap().data.unwrap()["message"], "one");
    assert_eq!(second.unwrap().data.unwrap()["message"], "two");
    assert_eq!(
        events.recv().await.unwrap()["text"],
        "hello\u{2028}世界\u{2029}end"
    );
    process.shutdown().await.unwrap();
    assert_eq!(events.recv().await.unwrap_err(), PiError::Shutdown);
}

#[tokio::test]
async fn explicit_working_directory_and_agent_home_reach_child() {
    let fixture = Fixture::new(
        r#"
function receive(request) { reply(request, {cwd:process.cwd(), agent:process.env.PI_CODING_AGENT_DIR}); }
"#,
    );
    let (process, _events) = fixture.spawn();
    let data = process
        .request(json!({"type":"get_state"}), DEADLINE)
        .await
        .unwrap()
        .data
        .unwrap();
    assert_eq!(
        fs::canonicalize(data["cwd"].as_str().unwrap()).unwrap(),
        fs::canonicalize(&fixture.options.working_dir).unwrap()
    );
    assert_eq!(
        data["agent"].as_str().unwrap(),
        fixture.options.agent_dir.to_str().unwrap()
    );
    process.shutdown().await.unwrap();
}

#[tokio::test]
async fn malformed_stdout_fails_all_pending_requests_without_stderr_leak() {
    let fixture = Fixture::new(
        r#"
let count = 0;
function receive(request) {
  if (++count === 2) {
    process.stderr.write('SECRET-TOKEN-DO-NOT-RETURN');
    process.stdout.write('not json\n');
  }
}
"#,
    );
    let (process, mut events) = fixture.spawn();
    let (first, second) = tokio::join!(
        process.request(json!({"type":"first"}), DEADLINE),
        process.request(json!({"type":"second"}), DEADLINE)
    );
    for result in [first, second] {
        let error = result.unwrap_err();
        assert_eq!(error, PiError::Protocol("invalid JSON"));
        assert!(!error.to_string().contains("SECRET"));
    }
    assert_eq!(
        events.recv().await.unwrap_err(),
        PiError::Protocol("invalid JSON")
    );
}

#[tokio::test]
async fn early_exit_and_partial_record_fail_pending_callers() {
    for (output, expected) in [
        ("", PiError::Exited),
        ("{", PiError::Protocol("unterminated record")),
    ] {
        let fixture = Fixture::new(&format!(
            "function receive(request) {{ process.stdout.write({}); process.exit(0); }}",
            serde_json::to_string(output).unwrap()
        ));
        let (process, mut events) = fixture.spawn();
        assert_eq!(
            process
                .request(json!({"type":"get_state"}), DEADLINE)
                .await
                .unwrap_err(),
            expected
        );
        assert_eq!(events.recv().await.unwrap_err(), expected);
    }
}

#[tokio::test]
async fn record_and_event_bounds_fail_explicitly() {
    let mut fixture =
        Fixture::new("function receive(request) { process.stdout.write('x'.repeat(129)); }");
    fixture.options.max_record_bytes = 128;
    let (process, _events) = fixture.spawn();
    assert_eq!(
        process
            .request(json!({"type":"get_state"}), DEADLINE)
            .await
            .unwrap_err(),
        PiError::Protocol("record exceeds byte limit")
    );
}

#[tokio::test]
async fn slow_consumer_pauses_reads_and_loses_no_events() {
    // Pi writes 500 events and then the reply, all before the consumer reads
    // anything. A one-slot queue must hold Pi back rather than end the session.
    let mut fixture = Fixture::new(
        "function receive(request) { for (let i = 0; i < 500; i++) send({type:'tick', i}); reply(request, {}); }",
    );
    fixture.options.event_capacity = 1;
    let (process, mut events) = fixture.spawn();
    let caller = process.clone();
    let request =
        tokio::spawn(async move { caller.request(json!({"type":"get_state"}), DEADLINE).await });
    assert_eq!(events.recv().await.unwrap()["i"], 0);
    // The reply follows the events on stdout, so it cannot arrive until the
    // consumer has drained the queue: the transport is waiting on us.
    assert!(!request.is_finished());
    for expected in 1..500 {
        assert_eq!(events.recv().await.unwrap()["i"], expected);
    }
    assert!(request.await.unwrap().unwrap().success);
    process.shutdown().await.unwrap();
    assert_eq!(events.recv().await.unwrap_err(), PiError::Shutdown);
}

#[tokio::test]
async fn shutdown_interrupts_a_supervisor_waiting_on_the_consumer() {
    let mut fixture = Fixture::new(
        "function receive(request) { for (let i = 0; i < 50; i++) send({type:'tick', i}); reply(request, {}); }",
    );
    fixture.options.event_capacity = 1;
    let (process, mut events) = fixture.spawn();
    let caller = process.clone();
    let request =
        tokio::spawn(async move { caller.request(json!({"type":"get_state"}), DEADLINE).await });
    assert_eq!(events.recv().await.unwrap()["i"], 0);
    // Nobody drains the queue; shutdown must still stop and reap the child.
    process.shutdown().await.unwrap();
    assert_eq!(request.await.unwrap().unwrap_err(), PiError::Shutdown);
}

#[tokio::test]
async fn timeout_terminates_and_reaps_child() {
    let fixture = Fixture::new(
        "function receive(request) { if(request.type === 'ready') reply(request, {pid:process.pid}); }",
    );
    let (process, mut events) = fixture.spawn();
    let pid = process
        .request_cancellable(json!({"type":"ready"}), DEADLINE)
        .await
        .unwrap()
        .data
        .unwrap()["pid"]
        .as_u64()
        .unwrap();
    assert_eq!(
        process
            .request_cancellable(json!({"type":"never"}), Duration::from_millis(30))
            .await
            .unwrap_err(),
        PiError::Timeout
    );
    assert_eq!(events.recv().await.unwrap_err(), PiError::Timeout);
    assert_dead(pid).await;
}

#[tokio::test]
async fn shutdown_fails_pending_request_and_reaps_child() {
    let fixture = Fixture::new(
        "function receive(request) { if(request.type === 'ready') reply(request, {pid:process.pid}); else send({type:'received'}); }",
    );
    let (process, mut events) = fixture.spawn();
    let pid = process
        .request(json!({"type":"ready"}), DEADLINE)
        .await
        .unwrap()
        .data
        .unwrap()["pid"]
        .as_u64()
        .unwrap();
    let caller = process.clone();
    let request =
        tokio::spawn(async move { caller.request(json!({"type":"never"}), DEADLINE).await });
    assert_eq!(events.recv().await.unwrap()["type"], "received");
    process.shutdown().await.unwrap();
    assert_eq!(request.await.unwrap().unwrap_err(), PiError::Shutdown);
    assert_dead(pid).await;
}

#[tokio::test]
async fn cancelling_a_request_terminates_the_owned_child() {
    let fixture =
        Fixture::new("function receive(request) { send({type:'received', pid:process.pid}); }");
    let (process, mut events) = fixture.spawn();
    let caller = process.clone();
    let request = tokio::spawn(async move {
        caller
            .request_cancellable(json!({"type":"never"}), DEADLINE)
            .await
    });
    let pid = events.recv().await.unwrap()["pid"].as_u64().unwrap();
    request.abort();
    let _ = request.await;
    assert_eq!(events.recv().await.unwrap_err(), PiError::Cancelled);
    assert_dead(pid).await;
}

#[tokio::test]
async fn bad_response_envelopes_do_not_become_events() {
    for record in [
        "{type:'response',id:'unknown',command:request.type,success:true}",
        "{type:'response',id:request.id,command:'wrong',success:true}",
        "{type:'response',id:request.id,command:request.type,success:false}",
        "{type:'response',command:'parse',success:false,error:'bad command'}",
        "[]",
    ] {
        let fixture = Fixture::new(&format!("function receive(request) {{ send({record}); }}"));
        let (process, _events) = fixture.spawn();
        assert!(matches!(
            process.request(json!({"type":"get_state"}), DEADLINE).await,
            Err(PiError::Protocol(_))
        ));
    }
}

#[tokio::test]
async fn accepts_crlf_split_records_and_command_failures() {
    let fixture = Fixture::new(
        r#"
function receive(request) {
  const text = JSON.stringify({type:'response', id:request.id, command:request.type, success:false, error:'Unknown model'});
  process.stdout.write(text.slice(0,3));
  setImmediate(() => process.stdout.write(text.slice(3)+'\r\n'));
}
"#,
    );
    let (process, _events) = fixture.spawn();
    let response = process
        .request(json!({"type":"set_model"}), DEADLINE)
        .await
        .unwrap();
    assert!(!response.success);
    assert_eq!(response.error.as_deref(), Some("Unknown model"));
    process.shutdown().await.unwrap();
}

async fn assert_dead(pid: u64) {
    // Node's signal 0 probe verifies the OS no longer has this child, including
    // an unreaped zombie. No signals are sent to unrelated processes.
    let result = tokio::process::Command::new("node").args(["-e", &format!("try {{ process.kill({pid}, 0); process.exit(1); }} catch(e) {{ process.exit(e.code === 'ESRCH' ? 0 : 2); }}")]).status().await.unwrap();
    assert!(result.success(), "owned child {pid} still exists");
}

#[tokio::test]
async fn blocked_stdin_does_not_block_deadline_or_cleanup() {
    let fixture = Fixture::new(
        "function receive(request) { reply(request, {pid:process.pid}); process.stdin.pause(); setInterval(() => {}, 1000); }",
    );
    let (process, mut events) = fixture.spawn();
    let pid = process
        .request_cancellable(json!({"type":"ready"}), DEADLINE)
        .await
        .unwrap()
        .data
        .unwrap()["pid"]
        .as_u64()
        .unwrap();
    let result = process
        .request_cancellable(
            json!({"type":"prompt", "message":"x".repeat(900_000)}),
            Duration::from_millis(50),
        )
        .await;
    assert_eq!(result.unwrap_err(), PiError::Timeout);
    assert_eq!(events.recv().await.unwrap_err(), PiError::Timeout);
    assert_dead(pid).await;
}

#[tokio::test]
async fn request_capacity_rejects_excess_without_sending_it() {
    let mut fixture = Fixture::new(
        "function receive(request) { send({type:'received', command:request.type}); }",
    );
    fixture.options.request_capacity = 1;
    let (process, mut events) = fixture.spawn();
    let caller = process.clone();
    let request =
        tokio::spawn(async move { caller.request(json!({"type":"first"}), DEADLINE).await });
    assert_eq!(events.recv().await.unwrap()["command"], "first");
    assert_eq!(
        process
            .request(json!({"type":"second"}), DEADLINE)
            .await
            .unwrap_err(),
        PiError::Capacity
    );
    process.shutdown().await.unwrap();
    assert_eq!(request.await.unwrap().unwrap_err(), PiError::Shutdown);
    assert_eq!(events.recv().await.unwrap_err(), PiError::Shutdown);
}

#[tokio::test]
async fn dropping_last_process_handle_reaps_owned_child() {
    let fixture = Fixture::new("function receive(request) { reply(request, {pid:process.pid}); }");
    let (process, mut events) = fixture.spawn();
    let pid = process
        .request(json!({"type":"ready"}), DEADLINE)
        .await
        .unwrap()
        .data
        .unwrap()["pid"]
        .as_u64()
        .unwrap();
    drop(process);
    assert_eq!(events.recv().await.unwrap_err(), PiError::Shutdown);
    assert_dead(pid).await;
}

#[tokio::test]
async fn invalid_commands_fail_locally_and_leave_process_usable() {
    let mut fixture = Fixture::new("function receive(request) { reply(request, {}); }");
    fixture.options.max_record_bytes = 128;
    let (process, _events) = fixture.spawn();
    for command in [
        json!([]),
        json!({"type":"ok","id":"caller"}),
        json!({"type":23}),
        json!({"type":"prompt","message":"x".repeat(200)}),
    ] {
        assert!(matches!(
            process.request(command, DEADLINE).await,
            Err(PiError::InvalidCommand(_))
        ));
    }
    assert!(
        process
            .request(json!({"type":"get_state"}), DEADLINE)
            .await
            .unwrap()
            .success
    );
    process.shutdown().await.unwrap();
}

#[tokio::test]
async fn startup_failure_and_invalid_utf8_are_explicit() {
    let mut fixture =
        Fixture::new("function receive(request) { process.stdout.write(Buffer.from([255,10])); }");
    let (process, _events) = fixture.spawn();
    assert_eq!(
        process
            .request(json!({"type":"get_state"}), DEADLINE)
            .await
            .unwrap_err(),
        PiError::Protocol("invalid JSON")
    );
    fixture.options.executable = fixture.options.working_dir.join("does-not-exist");
    assert!(matches!(
        PiProcess::spawn(fixture.options),
        Err(PiError::Io("spawn"))
    ));
}

#[tokio::test]
async fn extension_dialog_can_resume_a_command_when_request_capacity_is_full() {
    let mut fixture = Fixture::new(
        r#"
let pending;
function receive(request) {
  if(request.type === 'prompt') {
    pending = request;
    send({type:'extension_ui_request', id:'pi-dialog-1', method:'confirm', title:'Continue?'});
  } else if(request.type === 'extension_ui_response') {
    if(request.id !== 'pi-dialog-1' || request.confirmed !== true) process.exit(7);
    reply(pending, {continued:true});
    send({type:'agent_settled'});
  }
}
"#,
    );
    fixture.options.request_capacity = 1;
    let (process, mut events) = fixture.spawn();
    let caller = process.clone();
    let prompt =
        tokio::spawn(async move { caller.request(json!({"type":"prompt"}), DEADLINE).await });
    let dialog = events.recv().await.unwrap();
    process
        .respond_extension(
            dialog["id"].as_str().unwrap(),
            json!({"confirmed":true}),
            DEADLINE,
        )
        .await
        .unwrap();
    assert_eq!(
        prompt.await.unwrap().unwrap().data.unwrap()["continued"],
        true
    );
    assert_eq!(events.recv().await.unwrap()["type"], "agent_settled");
    process.shutdown().await.unwrap();
}

#[tokio::test]
async fn admission_rejects_excess_callers_before_serializing_their_commands() {
    let mut fixture = Fixture::new("function receive(request) { send({type:'received'}); }");
    fixture.options.request_capacity = 1;
    fixture.options.max_record_bytes = 128;
    let (process, mut events) = fixture.spawn();
    let caller = process.clone();
    let first = tokio::spawn(async move { caller.request(json!({"type":"hold"}), DEADLINE).await });
    events.recv().await.unwrap();
    let commands = (0..100)
        .map(|_| {
            let caller = process.clone();
            tokio::spawn(async move {
                caller
                    .request(
                        json!({"type":"prompt", "message":"x".repeat(1024)}),
                        DEADLINE,
                    )
                    .await
            })
        })
        .collect::<Vec<_>>();
    for command in commands {
        // InvalidCommand would mean serialization happened before admission.
        assert_eq!(command.await.unwrap().unwrap_err(), PiError::Capacity);
    }
    process.shutdown().await.unwrap();
    assert_eq!(first.await.unwrap().unwrap_err(), PiError::Shutdown);
}

#[cfg(unix)]
struct DescendantCleanup(Option<u64>);
#[cfg(unix)]
impl Drop for DescendantCleanup {
    fn drop(&mut self) {
        if let Some(pid) = self.0 {
            // This PID was reported by our fixture immediately after spawn.
            // The fixture also bounds the child's lifetime as a failure fallback.
            unsafe {
                libc::kill(pid as libc::pid_t, libc::SIGKILL);
            }
        }
    }
}

#[cfg(unix)]
#[tokio::test]
async fn sigterm_allows_pi_style_cleanup_of_detached_tool_children() {
    let fixture = Fixture::new(
        r#"
const child = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 20000)'], {detached:true, stdio:['ignore','inherit','ignore']});
process.on('SIGTERM', () => {
  child.once('exit', () => process.exit(0));
  child.kill('SIGTERM');
});
function receive(request) { reply(request, {pid:process.pid, child:child.pid}); }
"#,
    );
    let (process, _events) = fixture.spawn();
    let data = process
        .request(json!({"type":"ready"}), DEADLINE)
        .await
        .unwrap()
        .data
        .unwrap();
    let pid = data["pid"].as_u64().unwrap();
    let child = data["child"].as_u64().unwrap();
    let mut cleanup = DescendantCleanup(Some(child));
    process.shutdown().await.unwrap();
    assert_dead(pid).await;
    assert_dead(child).await;
    cleanup.0 = None;
}

#[cfg(unix)]
#[tokio::test]
async fn parent_exit_is_detected_even_when_descendant_keeps_stdout_open() {
    let fixture = Fixture::new(
        r#"
const child = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 20000)'], {detached:true, stdio:['ignore','inherit','ignore']});
function receive(request) {
  if(request.type === 'ready') reply(request, {pid:process.pid, child:child.pid});
  else process.exit(0);
}
"#,
    );
    let (process, mut events) = fixture.spawn();
    let data = process
        .request(json!({"type":"ready"}), DEADLINE)
        .await
        .unwrap()
        .data
        .unwrap();
    let _cleanup = DescendantCleanup(Some(data["child"].as_u64().unwrap()));
    let failure = tokio::time::timeout(
        Duration::from_secs(2),
        process.request(json!({"type":"die"}), DEADLINE),
    )
    .await
    .unwrap()
    .unwrap_err();
    assert_eq!(failure, PiError::Exited);
    assert_eq!(events.recv().await.unwrap_err(), PiError::Exited);
    assert_dead(data["pid"].as_u64().unwrap()).await;
}

#[cfg(unix)]
#[tokio::test]
async fn ignored_sigterm_is_forced_and_reaped_after_bounded_grace() {
    let fixture = Fixture::new(
        "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); function receive(request) { reply(request, {pid:process.pid}); }",
    );
    let (process, _events) = fixture.spawn();
    let pid = process
        .request(json!({"type":"ready"}), DEADLINE)
        .await
        .unwrap()
        .data
        .unwrap()["pid"]
        .as_u64()
        .unwrap();
    tokio::time::timeout(Duration::from_secs(3), process.shutdown())
        .await
        .unwrap()
        .unwrap();
    assert_dead(pid).await;
}

#[cfg(unix)]
#[tokio::test]
async fn parent_exit_preserves_final_response_before_inherited_pipe_closes() {
    let fixture = Fixture::new(
        r#"
const child = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 20000)'], {detached:true, stdio:['ignore','inherit','ignore']});
function receive(request) {
  if(request.type === 'ready') reply(request, {child:child.pid});
  else {
    const record = {type:'response', id:request.id, command:request.type, success:true, data:{final:true}};
    process.stdout.write(JSON.stringify(record)+'\n', () => process.exit(0));
  }
}
"#,
    );
    let (process, mut events) = fixture.spawn();
    let data = process
        .request(json!({"type":"ready"}), DEADLINE)
        .await
        .unwrap()
        .data
        .unwrap();
    let _cleanup = DescendantCleanup(Some(data["child"].as_u64().unwrap()));
    let response = process
        .request(json!({"type":"final"}), DEADLINE)
        .await
        .unwrap();
    assert_eq!(response.data.unwrap()["final"], true);
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(2), events.recv())
            .await
            .unwrap()
            .unwrap_err(),
        PiError::Exited
    );
}

#[tokio::test]
async fn ordinary_request_cancellation_preserves_the_shared_bot() {
    let fixture = Fixture::new(
        "let pending; function receive(request) { if(request.type==='prompt') {pending=request; send({type:'agent_start'});} else {reply(pending,{}); reply(request,{}); send({type:'agent_settled'});} }",
    );
    let (process, mut events) = fixture.spawn();
    let caller = process.clone();
    let request =
        tokio::spawn(async move { caller.request(json!({"type":"prompt"}), DEADLINE).await });
    assert_eq!(events.recv().await.unwrap()["type"], "agent_start");
    request.abort();
    assert!(request.await.unwrap_err().is_cancelled());
    assert!(
        process
            .request(json!({"type":"finish"}), DEADLINE)
            .await
            .unwrap()
            .success
    );
    assert_eq!(events.recv().await.unwrap()["type"], "agent_settled");
    process.shutdown().await.unwrap();
}
#[tokio::test]
async fn prompt_waits_for_ack_after_compaction_and_other_commands_still_work() {
    let fixture = Fixture::new(
        "let pending; function receive(request) { if(request.type==='prompt') {pending=request; send({type:'auto_compaction_start'});} else {reply(request,{}); reply(pending,{}); send({type:'agent_settled'});} }",
    );
    let (process, mut events) = fixture.spawn();
    let caller = process.clone();
    let request = tokio::spawn(async move { caller.prompt(&mut json!({"type":"prompt"})).await });
    assert_eq!(
        events.recv().await.unwrap()["type"],
        "auto_compaction_start"
    );
    assert!(!request.is_finished());
    process
        .request(json!({"type":"finish_compaction"}), DEADLINE)
        .await
        .unwrap();
    assert!(request.await.unwrap().unwrap().success);
    process.shutdown().await.unwrap();
}
#[test]
fn transport_errors_use_product_words() {
    for error in [
        PiError::Exited,
        PiError::Timeout,
        PiError::Cancelled,
        PiError::Shutdown,
        PiError::Capacity,
        PiError::Cleanup,
        PiError::Io("read"),
        PiError::Protocol("bad record"),
    ] {
        assert!(!error.to_string().contains("Pi"));
    }
}
