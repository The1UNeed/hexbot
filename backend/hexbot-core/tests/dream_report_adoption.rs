use hexbot_core::{catalog, db, dreaming, native_product_tools as product, runtime_store as store};
use rusqlite::params;
use serde_json::{Value, json};
use std::{fs, path::Path};

fn setup() -> tempfile::TempDir {
    let home = tempfile::tempdir().unwrap();
    db::migrate(home.path()).unwrap();
    db::open(home.path()).unwrap().execute_batch("INSERT INTO users(id,display_name,role,created_at) VALUES('alice','Alice','admin',0); INSERT INTO bots(name,owner_id) VALUES('owl','alice'); INSERT INTO sections(id,bot,title,owner_id) VALUES('log','owl','Dreams','alice'); INSERT INTO dreams(id,bot,started_at,status,summary) VALUES('dream','owl',1,'complete','REPORT_TEXT'); INSERT INTO settings VALUES('one_chat_per_bot','true');").unwrap();
    home
}
fn assistant(content: Value, timestamp: i64) -> Value {
    json!({"role":"assistant","content":content,"timestamp":timestamp,"provider":"test","model":"model","api":"openai-completions","stopReason":"stop","usage":{"input":10,"output":2,"cacheRead":3,"cacheWrite":4,"totalTokens":19,"cost":{"total":0.37}}})
}
fn block(text: &str) -> Value {
    json!({"type":"text","text":text})
}
fn messages(stop: &str) -> Vec<Value> {
    let mut tool = assistant(
        json!([block("REPORT_TEXT"),{"type":"toolCall","id":"call-1","name":"read","arguments":{"path":"notes.txt"}}]),
        3000,
    );
    if stop.is_empty() {
        tool.as_object_mut().unwrap().remove("stopReason");
    } else {
        tool["stopReason"] = json!(stop);
    }
    vec![
        assistant(json!([block("REPORT_TEXT")]), 1000),
        json!({"role":"user","content":[block("Keep human dialogue")],"timestamp":2000}),
        tool,
        json!({"role":"toolResult","toolCallId":"call-1","toolName":"read","content":[block("UNIQUE_FILE_CONTENT")],"isError":false,"timestamp":4000}),
        assistant(
            json!([block("REPORT_TEXT"),{"type":"thinking","thinking":"Real reasoning"}]),
            5000,
        ),
        assistant(
            json!([block("REPORT_TEXT"),{"type":"future-block","payload":"KEEP_UNKNOWN"}]),
            6000,
        ),
        assistant(json!([block("Ordinary answer")]), 7000),
    ]
}
fn write_log(home: &Path, entries: &[Value]) -> std::path::PathBuf {
    let path = store::session_dir(home, "log")
        .unwrap()
        .join("conversation.jsonl");
    let mut lines = vec![json!({"type":"session","version":3,"id":"log","timestamp":"2026-10-15T00:00:00Z","cwd":home}).to_string()];
    lines.extend(entries.iter().map(Value::to_string));
    fs::write(&path, format!("{}\n", lines.join("\n"))).unwrap();
    path
}
fn entries(messages: Vec<Value>) -> Vec<Value> {
    messages.into_iter().enumerate().map(|(i, message)| json!({"type":"message","id":format!("e-{i}"),"parentId":if i==0 {Value::Null} else {json!(format!("e-{}",i-1))},"timestamp":"2026-10-15T00:00:00Z","message":message})).collect()
}
fn canonical(home: &Path) -> String {
    catalog::call(
        home,
        "alice",
        "hexbot.sections.create",
        &json!({"bot":"owl"}),
    )
    .unwrap()
    .unwrap()["section"]["id"]
        .as_str()
        .unwrap()
        .to_owned()
}
fn assert_display(home: &Path, id: &str, reports: usize) {
    let history = store::history(home, id).unwrap();
    assert_eq!(history.len(), 6 + reports, "{history:?}");
    assert_eq!(
        history.iter().filter(|m| m["dream"] == true).count(),
        reports
    );
    assert!(
        history
            .iter()
            .any(|m| m["dream"] == true && m["text"] == "REPORT_TEXT")
    );
    assert_eq!(
        history
            .iter()
            .filter(|m| m["role"] == "assistant"
                && m["text"] == "REPORT_TEXT"
                && m["dream"] != true)
            .count(),
        3
    );
    let call = history
        .iter()
        .find(|m| m["tool_calls"][0]["id"] == "call-1")
        .unwrap();
    assert_ne!(call["dream"], true);
    assert_eq!(
        call["tool_calls"][0]["function"]["arguments"],
        r#"{"path":"notes.txt"}"#
    );
    assert!(
        history
            .iter()
            .any(|m| m["tool_call_id"] == "call-1" && m["text"] == "UNIQUE_FILE_CONTENT")
    );
    assert!(
        history
            .iter()
            .any(|m| m["reasoning"] == "Real reasoning" && m["dream"] != true)
    );
}
fn assert_digest(home: &Path, id: &str) {
    let digest = dreaming::build_digest(home, "owl", 0., f64::MAX, None).unwrap();
    let sections = digest["sections"].as_array().unwrap();
    assert_eq!(sections.len(), 1, "{digest}");
    assert_eq!(sections[0]["id"], id);
    let transcript = sections[0]["transcript"].as_str().unwrap();
    assert_eq!(transcript.matches("REPORT_TEXT").count(), 3, "{digest}");
    assert!(transcript.contains("Keep human dialogue") && transcript.contains("Ordinary answer"));
}
fn inspect_pi(source: Option<&Path>, target: &Path) {
    if let Ok(pi) = std::env::var("HEXBOT_TEST_PI") {
        let modules = Path::new(&pi).parent().unwrap().parent().unwrap();
        let mut command = std::process::Command::new("node");
        command
            .arg("--input-type=module")
            .arg("-e")
            .arg(include_str!("fixtures/dream-report-context.mjs"))
            .env("PI_MODULES", modules)
            .env("CHAT_FILE", target);
        if let Some(source) = source {
            command.env("SOURCE_FILE", source);
        }
        let output = command.output().unwrap();
        println!("{}", String::from_utf8_lossy(&output.stdout));
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

#[test]
fn canonical_adoption_preserves_structural_replies_and_pairing() {
    // Full import, no projection yet, old incorrect markers, and summaries that
    // force expansion of original paths all enter through the public API.
    for (partial, marked, summarized, stop) in [
        (false, false, "none", "stop"),
        (true, false, "none", "toolUse"),
        (false, true, "compaction", ""),
        (false, true, "branch", "stop"),
    ] {
        let home = setup();
        let h = home.path();
        store::open(h).unwrap().execute("INSERT INTO native_sessions(stored_id,owner,bot,prompt,options) VALUES('log','alice','owl','FROZEN PREFIX','{\"tools\":[\"original-tool\"],\"model\":\"original-model\"}')",[]).unwrap();
        let mut raw = entries(messages(stop));
        if summarized == "compaction" {
            raw.push(json!({"type":"compaction","id":"compact","parentId":"e-6","timestamp":"2026-10-15T00:00:08Z","summary":"Contaminated summary REPORT_TEXT","firstKeptEntryId":"e-1","tokensBefore":100}));
        } else if summarized == "branch" {
            // An inactive tool reply is represented only by a nested summary on
            // the selected path. Its original blocks must be expanded together.
            raw[4]["parentId"] = json!("e-1");
            raw.push(json!({"type":"branch_summary","id":"nested","parentId":"e-3","fromId":"e-3","timestamp":"2026-10-15T00:00:08Z","summary":"Contaminated summary REPORT_TEXT"}));
            raw.push(json!({"type":"branch_summary","id":"branch","parentId":"e-6","fromId":"nested","timestamp":"2026-10-15T00:00:09Z","summary":"Contaminated summary REPORT_TEXT"}));
        }
        let source = write_log(h, &raw);
        let original = fs::read(&source).unwrap();
        if !partial {
            store::reconcile(h, "owl", "log", "alice").unwrap();
        } else {
            // Startup recovers interrupted imports before serving the API.
            assert!(store::reconcile_all(h).unwrap().is_empty());
        }
        if marked {
            // Model the exact old classifier, including an unknown block whose
            // old projection had no structural flag. The linked journal proves it.
            store::open(h).unwrap().execute("UPDATE native_messages SET message_json=json_remove(json_set(message_json,'$.dream',json('true')),'$.dream_report_eligible') WHERE session_id='log' AND json_extract(message_json,'$.text')='REPORT_TEXT'",[]).unwrap();
        }
        let frozen: (String, String) = store::open(h)
            .unwrap()
            .query_row(
                "SELECT prompt,options FROM native_sessions WHERE stored_id='log'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        let billing = store::usage(h, "log").unwrap();
        let selected = canonical(h);
        assert_ne!(selected, "log");
        let target = store::session_dir(h, &selected)
            .unwrap()
            .join("conversation.jsonl");
        let copied = fs::read_to_string(&target).unwrap();
        assert!(copied.contains("KEEP_UNKNOWN") && copied.contains("Real reasoning"));
        assert_display(h, &selected, 1);
        assert_digest(h, &selected);
        inspect_pi(Some(&source), &target);
        // Reopen/recovery, a clean new compaction, repeated lookup and digest
        // classification must keep the same identities and snapshot version.
        store::reconcile(h, "owl", &selected, "alice").unwrap();
        assert_eq!(canonical(h), selected);
        assert_eq!(canonical(h), selected);
        assert_display(h, &selected, 1);
        assert_digest(h, &selected);
        assert_eq!(fs::read(&source).unwrap(), original);
        assert_eq!(
            store::open(h)
                .unwrap()
                .query_row(
                    "SELECT prompt,options FROM native_sessions WHERE stored_id='log'",
                    [],
                    |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
                )
                .unwrap(),
            frozen
        );
        assert_eq!(store::usage(h, "log").unwrap(), billing);
        assert_eq!(store::usage(h, &selected).unwrap()["total_tokens"], 0);
        let conn = store::open(h).unwrap();
        let version = store::history_version(&conn, "log").unwrap();
        canonical(h);
        assert_eq!(store::history_version(&conn, "log").unwrap(), version);
        store::append(
            h,
            "log",
            json!({"role":"user","text":"Later old-client write","timestamp":10}),
        )
        .unwrap();
        let later = dreaming::build_digest(h, "owl", 0., f64::MAX, None).unwrap();
        assert!(later.to_string().contains("Later old-client write"));
        let old = later["sections"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["id"] == "log")
            .unwrap();
        // The generated report stays excluded when that source becomes eligible.
        assert_eq!(
            old["transcript"]
                .as_str()
                .unwrap()
                .matches("assistant: REPORT_TEXT")
                .count(),
            if summarized == "branch" { 2 } else { 3 }
        );
    }
}

#[test]
fn legacy_import_and_digest_keep_tool_and_unknown_report_text_collisions() {
    for partial in [false, true] {
        let home = setup();
        let h = home.path();
        let path = catalog::profile(h, "owl").unwrap();
        fs::create_dir_all(&path).unwrap();
        let legacy = rusqlite::Connection::open(path.join("state.db")).unwrap();
        legacy.execute_batch("CREATE TABLE sessions(id TEXT PRIMARY KEY,session_key TEXT,parent_session_id TEXT,model_config TEXT,source TEXT); CREATE TABLE messages(id INTEGER PRIMARY KEY,session_id TEXT,role TEXT,content TEXT,tool_calls TEXT,tool_call_id TEXT,tool_name TEXT,timestamp REAL,active INTEGER); INSERT INTO sessions VALUES('old','log',NULL,NULL,NULL);").unwrap();
        for (i, m) in messages("stop").iter().enumerate() {
            let content = if i == 0 || i == 2 || i == 6 {
                store::text(&m["content"])
            } else {
                m["content"].to_string()
            };
            let calls=(i==2).then(||json!([{"id":"call-1","type":"function","function":{"name":"read","arguments":"{\"path\":\"notes.txt\"}"}}]).to_string());
            legacy
                .execute(
                    "INSERT INTO messages VALUES(?,'old',?,?,?,?,?,?,1)",
                    params![
                        i + 1,
                        if m["role"] == "toolResult" {
                            "tool"
                        } else {
                            m["role"].as_str().unwrap()
                        },
                        content,
                        calls,
                        m["toolCallId"].as_str(),
                        m["toolName"].as_str(),
                        (i + 1) as f64
                    ],
                )
                .unwrap();
        }
        if partial {
            store::append(
                h,
                "log",
                json!({"role":"assistant","text":"REPORT_TEXT","dream":true,"timestamp":1}),
            )
            .unwrap();
        } else {
            assert_digest(h, "log");
        }
        assert_eq!(canonical(h), "log");
        store::import_hermes(h, "owl", "log", h).unwrap();
        let target = store::session_dir(h, "log")
            .unwrap()
            .join("conversation.jsonl");
        assert_display(h, "log", if partial { 2 } else { 1 });
        assert_digest(h, "log");
        inspect_pi(None, &target);
        store::reconcile(h, "owl", "log", "alice").unwrap();
        assert_eq!(canonical(h), "log");
        assert_display(h, "log", if partial { 2 } else { 1 });
        assert_digest(h, "log");
        let before = fs::read(&target).unwrap();
        store::import_hermes(h, "owl", "log", h).unwrap();
        assert_eq!(fs::read(&target).unwrap(), before);
    }
}

#[test]
fn structural_first_reply_does_not_identify_a_renamed_chat_as_a_dream_log() {
    for blocks in [
        json!([block("REPORT_TEXT"),{"type":"toolCall","id":"call-1","name":"read","arguments":{}}]),
        json!([block("REPORT_TEXT"),{"type":"thinking","thinking":""}]),
        json!([block("REPORT_TEXT"),{"type":"future-block","payload":true}]),
        json!([block("REPORT_TEXT"), block("")]),
        json!([{ "type":"text", "text":"REPORT_TEXT", "textSignature":"legitimate-provider-metadata" }]),
    ] {
        let home = setup();
        let h = home.path();
        db::open(h)
            .unwrap()
            .execute("UPDATE sections SET title='Renamed'", [])
            .unwrap();
        let source = write_log(h, &entries(vec![assistant(blocks, 1000)]));
        let before = fs::read(&source).unwrap();
        store::reconcile(h, "owl", "log", "alice").unwrap();
        assert_eq!(canonical(h), "log");
        assert!(store::dream_logs(h).unwrap().is_empty());
        assert_ne!(store::history(h, "log").unwrap()[0]["dream"], true);
        assert_eq!(fs::read(&source).unwrap(), before);
    }
}

#[test]
fn recreated_log_repairs_only_proven_structural_projection_markers_once() {
    let home = setup();
    let h = home.path();
    // Identity remains sticky when an old build recreates its log. These old
    // projections have no journal or raw content from which to guess provenance.
    db::open(h)
        .unwrap()
        .execute("INSERT INTO settings VALUES('dream_logs','[\"log\"]')", [])
        .unwrap();
    for message in [
        json!({"role":"assistant","text":"REPORT_TEXT","dream":true,"tool_calls":" [ ] ","timestamp":1}),
        json!({"role":"user","text":"Keep human dialogue","timestamp":2}),
        json!({"role":"assistant","text":"REPORT_TEXT","dream":true,"timestamp":3,"tool_calls":[{"id":"call-1","type":"function","function":{"name":"read_file","arguments":"{\"path\":\"notes.txt\"}"}}]}),
        json!({"role":"tool","text":"UNIQUE_FILE_CONTENT","tool_call_id":"call-1","timestamp":4}),
        json!({"role":"assistant","text":"REPORT_TEXT","dream":true,"timestamp":5,"reasoning":"[]"}),
        json!({"role":"assistant","text":"REPORT_TEXT","dream_report_eligible":false,"dream":true,"timestamp":6}),
        // A separately marked report need not have a surviving dreams-table row.
        json!({"role":"assistant","text":"Another generated report","dream":true,"tool_calls":"null","timestamp":7}),
    ] {
        store::append(h, "log", message).unwrap();
    }
    assert_eq!(canonical(h), "log");
    let history = store::history(h, "log").unwrap();
    assert_eq!(history.iter().filter(|m| m["dream"] == true).count(), 2);
    for message in &history[2..6] {
        assert_ne!(message["dream"], true);
    }
    let digest = dreaming::build_digest(h, "owl", 0., f64::MAX, None).unwrap();
    assert_eq!(
        digest["sections"][0]["transcript"]
            .as_str()
            .unwrap()
            .matches("REPORT_TEXT")
            .count(),
        3
    );
    assert!(!digest.to_string().contains("Another generated report"));
    let conn = store::open(h).unwrap();
    let version = store::history_version(&conn, "log").unwrap();
    for _ in 0..3 {
        assert!(store::reconcile_all(h).unwrap().is_empty());
        assert_eq!(canonical(h), "log");
        dreaming::build_digest(h, "owl", 0., f64::MAX, None).unwrap();
        assert_eq!(store::history_version(&conn, "log").unwrap(), version);
        assert_eq!(store::history(h, "log").unwrap(), history);
    }
}

async fn search(home: &Path, args: Value) -> Value {
    product::call(home, "alice", "owl", "current", "session_search", &args)
        .await
        .unwrap()
        .unwrap()
}
fn tool_calls(message: &Value) -> Value {
    match &message["tool_calls"] {
        Value::String(calls) => serde_json::from_str(calls).unwrap(),
        calls => calls.clone(),
    }
}
/// The structural legacy replies a search returns, all but the plain reports.
fn recalled(messages: &Value) -> Vec<(Value, Value, Value, Value)> {
    let shown = messages.as_array().unwrap();
    let ids = shown.iter().map(|m| m["id"].clone()).collect::<Vec<_>>();
    assert_eq!(ids, [2, 3, 4, 5, 6, 7, 8, 9], "{messages}");
    let call = &shown[1];
    assert_eq!(call["content"], "REPORT_TEXT");
    assert_eq!(tool_calls(call)[0]["id"], "call-1");
    assert_eq!(
        tool_calls(call)[0]["function"]["arguments"],
        r#"{"path":"notes.txt"}"#
    );
    assert_eq!(shown[2]["tool_call_id"], "call-1");
    assert_eq!(shown[2]["content"], "UNIQUE_FILE_CONTENT");
    // Every returned tool result has its call.
    for result in shown.iter().filter(|m| !m["tool_call_id"].is_null()) {
        let called = |m: &Value| {
            tool_calls(m)
                .as_array()
                .is_some_and(|calls| calls.iter().any(|c| c["id"] == result["tool_call_id"]))
        };
        assert!(shown.iter().any(|m| m["role"] == "assistant" && called(m)));
    }
    assert_eq!(shown[5]["content"], "Ordinary answer");
    shown
        .iter()
        .map(|m| {
            let [id, role, content, result] =
                ["id", "role", "content", "tool_call_id"].map(|key| m[key].clone());
            (id, role, content, result)
        })
        .collect()
}

#[tokio::test]
async fn legacy_search_before_import_keeps_structural_replies_beside_the_current_chat() {
    let home = setup();
    let h = home.path();
    db::open(h).unwrap().execute_batch("UPDATE sections SET updated_at=10 WHERE id='log'; INSERT INTO sections(id,bot,title,owner_id,created_at,updated_at) VALUES('current','owl','General','alice',20,20);").unwrap();
    store::open(h)
        .unwrap()
        .execute(
            "INSERT INTO native_sessions(stored_id,owner,bot,prompt) VALUES('current','alice','owl','')",
            [],
        )
        .unwrap();
    store::append(
        h,
        "current",
        json!({"role":"user","text":"Current owner conversation","timestamp":20}),
    )
    .unwrap();
    let path = catalog::profile(h, "owl").unwrap();
    fs::create_dir_all(&path).unwrap();
    let legacy = rusqlite::Connection::open(path.join("state.db")).unwrap();
    legacy.execute_batch("CREATE TABLE sessions(id TEXT PRIMARY KEY,session_key TEXT,parent_session_id TEXT,model_config TEXT,source TEXT); CREATE TABLE messages(id INTEGER PRIMARY KEY,session_id TEXT,role TEXT,content TEXT,tool_calls TEXT,tool_call_id TEXT,tool_name TEXT,timestamp REAL,active INTEGER,reasoning TEXT); INSERT INTO sessions VALUES('old','log',NULL,NULL,NULL);").unwrap();
    let mut rows = messages("stop");
    // A signed text block, a reasoning column and a serialized plain report
    // with an encoded empty call list, then the report posted after them.
    rows.push(assistant(
        json!([{"type":"text","text":"REPORT_TEXT","textSignature":"sig"}]),
        8000,
    ));
    rows.push(assistant(json!("REPORT_TEXT"), 9000));
    rows.push(assistant(json!([block("REPORT_TEXT")]), 10000));
    rows.push(assistant(json!("REPORT_TEXT"), 11000));
    for (i, m) in rows.iter().enumerate() {
        let content = if matches!(i, 0 | 2 | 6 | 8 | 10) {
            store::text(&m["content"])
        } else {
            m["content"].to_string()
        };
        let calls = match i {
            2 => Some(json!([{"id":"call-1","type":"function","function":{"name":"read","arguments":"{\"path\":\"notes.txt\"}"}}]).to_string()),
            9 => Some("[]".to_owned()),
            _ => None,
        };
        legacy
            .execute(
                "INSERT INTO messages VALUES(?,'old',?,?,?,?,?,?,1,?)",
                params![
                    i + 1,
                    if m["role"] == "toolResult" {
                        "tool"
                    } else {
                        m["role"].as_str().unwrap()
                    },
                    content,
                    calls,
                    m["toolCallId"].as_str(),
                    m["toolName"].as_str(),
                    (i + 1) as f64,
                    (i == 8).then_some("Legacy reasoning")
                ],
            )
            .unwrap();
    }
    drop(legacy);
    let stored = fs::read(path.join("state.db")).unwrap();
    // The old mixed log stays a separate history; the newer chat is the bot's.
    assert_eq!(canonical(h), "current");
    let chat = store::session_dir(h, "log")
        .unwrap()
        .join("conversation.jsonl");
    assert!(!chat.exists());
    let read = search(h, json!({"session_id":"log","detail":"full","window":20})).await;
    let before = recalled(&read["messages"]);
    // Read from the old store itself: its call list is still serialized.
    assert!(read["messages"][1]["tool_calls"].is_string());
    let found = search(
        h,
        json!({"query":"REPORT_TEXT","role_filter":"assistant","detail":"full","window":20}),
    )
    .await;
    assert_eq!(found["results"].as_array().unwrap().len(), 1, "{found}");
    assert_eq!(found["results"][0]["session_id"], "log");
    let matched = found["results"][0]["match_message_id"].as_i64().unwrap();
    assert!([3, 5, 6, 8, 9].contains(&matched), "{found}");
    assert_eq!(recalled(&found["results"][0]["messages"]), before);
    assert_eq!(fs::read(path.join("state.db")).unwrap(), stored);
    assert!(!chat.exists());

    // Importing the log changes where it is read from, not what it holds.
    store::import_hermes(h, "owl", "log", h).unwrap();
    product::forget_history_indexes();
    let imported = search(h, json!({"session_id":"log","detail":"full","window":20})).await;
    assert!(imported["messages"][1]["tool_calls"].is_array());
    assert_eq!(recalled(&imported["messages"]), before);
    assert_eq!(canonical(h), "current");
}
