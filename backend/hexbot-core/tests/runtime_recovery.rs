use hexbot_core::{db, runtime_store as store};
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
};

fn setup() -> tempfile::TempDir {
    let home = tempfile::tempdir().unwrap();
    db::migrate(home.path()).unwrap();
    db::open(home.path()).unwrap().execute_batch("INSERT INTO users(id,display_name,role,created_at) VALUES ('alice','Alice','admin',0),('bob','Bob','member',0); INSERT INTO bots(name,owner_id) VALUES ('owl','alice'); INSERT INTO sections(id,bot,title,owner_id) VALUES ('chat','owl','Chat','alice');").unwrap();
    store::open(home.path()).unwrap().execute("INSERT INTO native_sessions(stored_id,owner,bot,prompt) VALUES ('chat','alice','owl','Stable prompt')",[]).unwrap();
    home
}
fn user(text: &str, ts: i64) -> Value {
    json!({"role":"user","content":[{"type":"text","text":text}],"timestamp":ts})
}
fn assistant(text: &str, ts: i64) -> Value {
    json!({"role":"assistant","content":[{"type":"text","text":text}],"timestamp":ts,"provider":"test","model":"model","api":"openai-completions","stopReason":"stop","usage":{"input":10,"output":2,"cacheRead":3,"cacheWrite":4,"totalTokens":19,"cost":{"input":0.1,"output":0.2,"cacheRead":0.03,"cacheWrite":0.04,"total":0.37}}})
}
fn entry(id: &str, parent: Option<&str>, message: Value) -> Value {
    json!({"type":"message","id":id,"parentId":parent,"timestamp":"2026-09-24T00:00:00.000Z","message":message})
}
fn file(home: &Path, entries: &[Value]) -> PathBuf {
    let path = store::session_dir(home, "chat")
        .unwrap()
        .join("conversation.jsonl");
    let mut lines=vec![json!({"type":"session","version":3,"id":"session-id","timestamp":"2026-09-24T00:00:00.000Z","cwd":home}).to_string()];
    lines.extend(entries.iter().map(Value::to_string));
    fs::write(&path, format!("{}\n", lines.join("\n"))).unwrap();
    path
}
fn reconcile(home: &Path) {
    store::reconcile(home, "owl", "chat", "alice").unwrap();
}
fn texts(home: &Path) -> Vec<String> {
    store::history(home, "chat")
        .unwrap()
        .into_iter()
        .map(|m| m["text"].as_str().unwrap_or("").into())
        .collect()
}

#[test]
fn recovers_missing_projection_and_usage_once_with_tool_and_hidden_metadata() {
    let home = setup();
    store::stage_prompt(home.path(), "chat", "Hidden instruction", "hidden").unwrap();
    let mut tool_assistant = assistant("Calling tool", 2000);
    tool_assistant["content"].as_array_mut().unwrap().push(
        json!({"type":"toolCall","id":"call-id","name":"read","arguments":{"path":"note.txt"}}),
    );
    let tool = json!({"role":"toolResult","toolCallId":"call-id","toolName":"read","content":[{"type":"text","text":"File contents"}],"isError":false,"timestamp":3000});
    let entries = vec![
        entry("u", None, user("Hidden instruction", 1000)),
        entry("a", Some("u"), tool_assistant),
        entry("t", Some("a"), tool),
        entry("last", Some("t"), assistant("Final answer", 4000)),
    ];
    file(home.path(), &entries);
    reconcile(home.path());
    let first = store::history(home.path(), "chat").unwrap();
    assert_eq!(first.len(), 4);
    assert_eq!(first[0]["display_kind"], "hidden");
    assert_eq!(first[1]["tool_calls"][0]["id"], "call-id");
    assert_eq!(first[2]["tool_call_id"], "call-id");
    assert_eq!(first[2]["name"], "read");
    assert_eq!(first[3]["timestamp"], 4.0);
    assert_eq!(
        store::usage(home.path(), "chat").unwrap()["total_tokens"],
        38
    );
    reconcile(home.path());
    assert_eq!(store::history(home.path(), "chat").unwrap(), first);
    assert_eq!(
        store::usage(home.path(), "chat").unwrap()["total_tokens"],
        38
    );
}

#[test]
fn live_journal_is_bound_to_pi_entry_ids_without_duplicate_billing() {
    let home = setup();
    let messages = [user("Question", 1000), assistant("Answer", 2000)];
    store::stage_prompt(home.path(), "chat", "Question", "normal").unwrap();
    for message in &messages {
        store::project_message(home.path(), "chat", "alice", "owl", message, None).unwrap();
    }
    let old = store::history(home.path(), "chat").unwrap();
    file(
        home.path(),
        &[
            entry("u", None, messages[0].clone()),
            entry("a", Some("u"), messages[1].clone()),
        ],
    );
    reconcile(home.path());
    assert_eq!(store::history(home.path(), "chat").unwrap(), old);
    assert_eq!(store::usage_rows(home.path()).unwrap().len(), 1);
    let bound: i64 = store::open(home.path())
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM native_pi_journal WHERE entry_id IS NOT NULL",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(bound, 2);
}

#[test]
fn restores_source_order_and_preserves_unlogged_synthetic_messages() {
    let home = setup();
    let first = user("first", 1000);
    let middle = assistant("middle", 2000);
    let last = user("last", 3000);
    store::project_message(home.path(), "chat", "alice", "owl", &first, None).unwrap();
    store::append(
        home.path(),
        "chat",
        json!({"role":"assistant","text":"Local status"}),
    )
    .unwrap();
    store::project_message(home.path(), "chat", "alice", "owl", &last, None).unwrap();
    file(
        home.path(),
        &[
            entry("u", None, first),
            entry("a", Some("u"), middle),
            entry("u2", Some("a"), last),
        ],
    );
    reconcile(home.path());
    assert_eq!(
        texts(home.path()),
        ["first", "Local status", "middle", "last"]
    );
    reconcile(home.path());
    assert_eq!(
        texts(home.path()),
        ["first", "Local status", "middle", "last"]
    );
}

#[test]
fn identical_messages_are_distinct_when_pi_entry_ids_differ() {
    let home = setup();
    let answer = assistant("same", 2000);
    store::project_message(home.path(), "chat", "alice", "owl", &answer, None).unwrap();
    file(
        home.path(),
        &[
            entry("a", None, answer.clone()),
            entry("b", Some("a"), answer),
        ],
    );
    reconcile(home.path());
    assert_eq!(texts(home.path()), ["same", "same"]);
    assert_eq!(
        store::usage(home.path(), "chat").unwrap()["output_tokens"],
        4
    );
    reconcile(home.path());
    assert_eq!(store::usage_rows(home.path()).unwrap().len(), 2);
}

#[test]
fn latest_leaf_selects_branch_without_erasing_compacted_history_or_billed_calls() {
    let home = setup();
    let mut entries = vec![
        entry("root", None, user("root", 1000)),
        entry("a", Some("root"), assistant("shared", 2000)),
        entry("old-u", Some("a"), user("abandoned question", 3000)),
        entry("old-a", Some("old-u"), assistant("abandoned answer", 4000)),
    ];
    file(home.path(), &entries);
    reconcile(home.path());
    assert_eq!(texts(home.path()).len(), 4);
    entries.push(entry("new-u", Some("a"), user("new question", 5000)));
    entries.push(entry("new-a", Some("new-u"), assistant("new answer", 6000)));
    entries.push(json!({"type":"compaction","id":"compact","parentId":"new-a","timestamp":"2026-09-24T00:00:00.000Z","summary":"Context summary","firstKeptEntryId":"new-u","tokensBefore":200}));
    entries.push(json!({"type":"context_edit","id":"edit","parentId":"compact","timestamp":"2026-09-24T00:00:01.000Z","targetId":"new-u","replacement":{"content":"Edited model context"}}));
    file(home.path(), &entries);
    reconcile(home.path());
    assert_eq!(
        texts(home.path()),
        ["root", "shared", "new question", "new answer"]
    );
    assert_eq!(store::usage_rows(home.path()).unwrap().len(), 3);
    let all: i64 = store::open(home.path())
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM native_messages WHERE session_id='chat'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(all, 6);
    entries.push(entry(
        "back",
        Some("old-a"),
        assistant("returned to old branch", 7000),
    ));
    file(home.path(), &entries);
    reconcile(home.path());
    assert_eq!(
        texts(home.path()),
        [
            "root",
            "shared",
            "abandoned question",
            "abandoned answer",
            "returned to old branch"
        ]
    );
}

#[test]
fn recovers_compaction_and_noncontext_usage_once_without_displaying_synthetic_messages() {
    let home = setup();
    let usage = assistant("", 1000)["usage"].clone();
    let entries = vec![
        entry("a", None, assistant("answer", 1000)),
        json!({"type":"compaction","id":"c","parentId":"a","timestamp":"2026-09-24T00:00:00Z","summary":"summary","firstKeptEntryId":null,"tokensBefore":10,"usage":usage}),
        json!({"type":"usage","id":"u","parentId":"c","timestamp":"2026-09-24T00:00:01Z","kind":"cache_warm","provider":"test","model":"model","usage":usage}),
    ];
    file(home.path(), &entries);
    reconcile(home.path());
    reconcile(home.path());
    assert_eq!(texts(home.path()), ["answer"]);
    assert_eq!(store::usage_rows(home.path()).unwrap().len(), 3);
}

#[test]
fn adopts_old_projection_and_usage_without_rebilling_and_preserves_row_identity() {
    let home = setup();
    let message = assistant("existing", 2000);
    store::append(
        home.path(),
        "chat",
        json!({"role":"assistant","text":"existing","row_id":"existing-row","timestamp":2}),
    )
    .unwrap();
    store::record_usage(home.path(), "chat", "alice", "owl", &message).unwrap();
    file(home.path(), &[entry("a", None, message)]);
    reconcile(home.path());
    assert_eq!(
        store::history(home.path(), "chat").unwrap()[0]["row_id"],
        "existing-row"
    );
    assert_eq!(store::usage_rows(home.path()).unwrap().len(), 1);
}

#[test]
fn rejected_prompts_do_not_hide_later_visible_messages_and_failed_assistants_still_bill() {
    let home = setup();
    let intent = store::stage_prompt(home.path(), "chat", "same", "hidden").unwrap();
    store::reject_prompt(home.path(), "chat", &intent).unwrap();
    let mut failed = assistant("provider detail", 2000);
    failed["stopReason"] = json!("error");
    failed["errorMessage"] = json!("Provider failed");
    file(
        home.path(),
        &[
            entry("u", None, user("same", 1000)),
            entry("a", Some("u"), failed),
        ],
    );
    reconcile(home.path());
    let history = store::history(home.path(), "chat").unwrap();
    assert_eq!(history.len(), 1);
    assert_eq!(history[0]["display_kind"], "normal");
    assert_eq!(store::usage_rows(home.path()).unwrap().len(), 1);
}

#[test]
fn torn_last_record_is_backed_up_before_repair_and_invalid_middle_never_changes_projection() {
    let home = setup();
    let path = file(home.path(), &[entry("u", None, user("durable", 1000))]);
    let valid = fs::read(&path).unwrap();
    let mut torn = valid.clone();
    torn.extend_from_slice(b"{\"type\":\"message\",\"id\":");
    fs::write(&path, &torn).unwrap();
    reconcile(home.path());
    assert_eq!(fs::read(&path).unwrap(), valid);
    let backup = fs::read_dir(path.parent().unwrap())
        .unwrap()
        .map(|e| e.unwrap().path())
        .find(|p| {
            p.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("conversation.recovery-")
        })
        .unwrap();
    assert_eq!(fs::read(backup).unwrap(), torn);
    let before = store::history(home.path(), "chat").unwrap();
    let mut invalid = valid.clone();
    invalid.extend_from_slice(b"invalid middle\n");
    invalid.extend_from_slice(
        entry("a", Some("u"), assistant("not committed", 2000))
            .to_string()
            .as_bytes(),
    );
    fs::write(&path, &invalid).unwrap();
    assert!(store::reconcile(home.path(), "owl", "chat", "alice").is_err());
    assert_eq!(store::history(home.path(), "chat").unwrap(), before);
    assert_eq!(fs::read(&path).unwrap(), invalid);
}

#[test]
fn rejects_wrong_owner_and_broken_parent_graph_without_projection_changes() {
    let home = setup();
    file(home.path(), &[entry("u", None, user("private", 1000))]);
    assert_eq!(
        store::reconcile(home.path(), "owl", "chat", "bob")
            .unwrap_err()
            .code,
        4302
    );
    assert!(store::history(home.path(), "chat").unwrap().is_empty());
    file(
        home.path(),
        &[entry("u", Some("missing"), user("invalid", 1000))],
    );
    assert!(store::reconcile(home.path(), "owl", "chat", "alice").is_err());
    assert!(store::history(home.path(), "chat").unwrap().is_empty());
}

#[test]
#[ignore = "requires HEXBOT_TEST_PI pointing to the pinned Pi 0.87.1 executable"]
fn actual_pi_tree_and_compaction_fixture_reconciles_without_a_provider_call() {
    let executable =
        fs::canonicalize(std::env::var_os("HEXBOT_TEST_PI").expect("set HEXBOT_TEST_PI")).unwrap();
    let module = executable
        .ancestors()
        .skip(1)
        .map(|parent| parent.join("core/session-manager.js"))
        .find(|path| path.is_file())
        .expect("Pi package includes core/session-manager.js");
    let home = setup();
    let script = r#"import {pathToFileURL} from 'node:url';const {SessionManager}=await import(pathToFileURL(process.argv[1]));const cwd=process.argv[2];const s=SessionManager.create(cwd,cwd+'/source');const usage={input:10,output:2,cacheRead:0,cacheWrite:0,totalTokens:12,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};const user=text=>({role:'user',content:[{type:'text',text}],timestamp:Date.now()});const answer=text=>({role:'assistant',content:[{type:'text',text}],api:'openai-completions',provider:'test',model:'test',usage,stopReason:'stop',timestamp:Date.now()});s.appendMessage(user('root'));const shared=s.appendMessage(answer('shared'));s.appendMessage(user('abandoned'));s.appendMessage(answer('old branch'));s.branch(shared);const keep=s.appendMessage(user('new branch'));s.appendMessage(answer('new answer'));s.appendCompaction('summary',keep,100);s.appendContextEdit(keep,{content:'model-only rewrite'});console.log(JSON.stringify({file:s.getSessionFile(),context:s.buildSessionContext().messages}));"#;
    let result = std::process::Command::new("node")
        .args(["--input-type=module", "-e", script])
        .arg(&module)
        .arg(home.path())
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let generated: Value = serde_json::from_slice(&result.stdout).unwrap();
    let target = store::session_dir(home.path(), "chat")
        .unwrap()
        .join("conversation.jsonl");
    fs::copy(generated["file"].as_str().unwrap(), target).unwrap();
    reconcile(home.path());
    assert_eq!(
        texts(home.path()),
        ["root", "shared", "new branch", "new answer"]
    );
    assert_eq!(store::usage_rows(home.path()).unwrap().len(), 3);
    let context = generated["context"].to_string();
    assert!(context.contains("model-only rewrite"));
    assert!(!context.contains("old branch"));
    reconcile(home.path());
    assert_eq!(texts(home.path()).len(), 4);
}

#[test]
fn startup_recovery_counts_unread_history_and_usage_before_any_session_open() {
    let home = setup();
    file(
        home.path(),
        &[
            entry("u", None, user("unread request", 1000)),
            entry("a", Some("u"), assistant("unread response", 2000)),
        ],
    );
    assert_eq!(
        hexbot_core::settings::summary(home.path(), "alice", None, 0.0).unwrap()["input_tokens"],
        0
    );
    store::reconcile_all(home.path()).unwrap();
    let usage = hexbot_core::settings::summary(home.path(), "alice", None, 0.0).unwrap();
    assert_eq!(usage["input_tokens"], 17);
    assert_eq!(usage["output_tokens"], 2);
    assert_eq!(
        store::summary(home.path(), "chat").unwrap()["message_count"],
        2
    );
    assert_eq!(
        store::summary(home.path(), "chat").unwrap()["preview"],
        "unread request"
    );
    let digest = hexbot_core::dreaming::build_digest(home.path(), "owl", 0.0, None).unwrap();
    assert_eq!(
        digest["sections"][0]["transcript"],
        "user: unread request\nassistant: unread response"
    );
    store::reconcile_all(home.path()).unwrap();
    assert_eq!(store::usage_rows(home.path()).unwrap().len(), 1);
}

#[test]
fn stale_unsent_intents_do_not_hide_future_equal_text_and_timestampless_events_stay_distinct() {
    let home = setup();
    store::stage_prompt(home.path(), "chat", "same", "hidden").unwrap();
    file(home.path(), &[]);
    reconcile(home.path());
    for _ in 0..2 {
        store::stage_prompt(home.path(), "chat", "same", "normal").unwrap();
        store::project_message(
            home.path(),
            "chat",
            "alice",
            "owl",
            &json!({"role":"user","content":"same"}),
            None,
        )
        .unwrap();
        store::project_message(home.path(),"chat","alice","owl",&json!({"role":"assistant","content":[{"type":"text","text":"repeat"}],"usage":{"input":1,"output":1},"stopReason":"stop"}),None).unwrap();
    }
    let history = store::history(home.path(), "chat").unwrap();
    assert_eq!(history.len(), 4);
    assert_eq!(history[0]["display_kind"], "normal");
    assert_eq!(history[2]["display_kind"], "normal");
    assert_eq!(
        store::usage(home.path(), "chat").unwrap()["input_tokens"],
        2
    );
}

#[test]
fn startup_leaves_io_failures_in_place_but_quarantines_bad_data() {
    let home = setup();
    let path = store::session_dir(home.path(), "chat")
        .unwrap()
        .join("conversation.jsonl");
    fs::create_dir(&path).unwrap();
    store::reconcile_all(home.path()).unwrap();
    assert!(path.is_dir());
    let quarantined: i64 = store::open(home.path())
        .unwrap()
        .query_row("SELECT count(*) FROM native_quarantine", [], |r| r.get(0))
        .unwrap();
    assert_eq!(quarantined, 0);
    fs::remove_dir(&path).unwrap();
    fs::write(&path, "{bad json}\n").unwrap();
    store::reconcile_all(home.path()).unwrap();
    assert!(!path.exists());
    let quarantined: i64 = store::open(home.path())
        .unwrap()
        .query_row("SELECT count(*) FROM native_quarantine", [], |r| r.get(0))
        .unwrap();
    assert_eq!(quarantined, 1);
}
