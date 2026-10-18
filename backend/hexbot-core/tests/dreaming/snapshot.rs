use super::*;
use crate::{events::Event, runtime::Runtime};
use std::{
    path::PathBuf,
    sync::{Mutex, OnceLock},
    time::Duration,
};

type Hook = Box<dyn FnOnce() + Send>;
fn hooks() -> &'static Mutex<HashMap<PathBuf, Hook>> {
    static HOOKS: OnceLock<Mutex<HashMap<PathBuf, Hook>>> = OnceLock::new();
    HOOKS.get_or_init(Mutex::default)
}
pub(super) fn after_readiness(home: &Path, stored: &str) {
    if stored == "chat" {
        let hook = hooks().lock().unwrap().remove(home);
        if let Some(hook) = hook {
            hook();
        }
    }
}
fn setup() -> common::TestHome {
    let home = common::TestHome::new();
    db::migrate(home.path()).unwrap();
    let conn = db::open(home.path()).unwrap();
    conn.execute_batch("INSERT INTO users(id,display_name,role,created_at) VALUES ('alice','Alice','admin',0),('bob','Bob','member',0); INSERT INTO bots(name,owner_id) VALUES ('owl','alice'); INSERT INTO sections(id,bot,owner_id,title,created_at,updated_at) VALUES ('chat','owl','alice','Chat',0,0);").unwrap();
    conn.execute(
        "INSERT INTO settings(key,value) VALUES ('workspace_dir',?)",
        [json!(home.workspace()).to_string()],
    )
    .unwrap();
    fs::create_dir_all(home.path().join("profiles/owl/memories")).unwrap();
    fs::write(
        home.path().join("profiles/owl/memories/MEMORY.md"),
        "before",
    )
    .unwrap();
    fs::write(
        home.path().join("profiles/owl/config.yaml"),
        "model:\n  provider: openai\n  default: test-model\n",
    )
    .unwrap();
    home
}
fn fake_pi(home: &Path, waiting: bool) -> PathBuf {
    let path = home.join("pi.cjs");
    let script=r##"#!/usr/bin/env node
const fs=require('node:fs');const rl=require('node:readline').createInterface({input:process.stdin});const emit=v=>process.stdout.write(JSON.stringify(v)+'\n');
rl.on('line',l=>{const c=JSON.parse(l);emit({type:'response',id:c.id,command:c.type,success:true,data:{}});if(c.type==='prompt'){fs.appendFileSync(PROMPTS,c.message+'\n');emit({type:'agent_start'});emit({type:'message_end',message:{role:'user',content:c.message}});if(WAIT)return;const config=JSON.parse(fs.readFileSync(process.env.HEXBOT_SESSION_CONFIG));if(c.message.includes('daily Hexbot dream') && (config.tools.length!==1 || config.tools[0].name!=='memory')){emit({type:'error',message:'unrestricted dream'});return;}emit({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'Dream summary'}});emit({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'Dream summary'}],usage:{input:1,output:2,cost:{total:0}},stopReason:'stop'}});emit({type:'agent_end'});emit({type:'agent_settled'});}if(c.type==='abort')emit({type:'agent_settled'});});
"##.replace("WAIT",if waiting{"true"}else{"false"}).replace("PROMPTS",&json!(home.join("prompts.log")).to_string());
    fs::write(&path, script).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
    }
    path
}
async fn event(receiver: &mut tokio::sync::broadcast::Receiver<Event>, kind: &str) -> Value {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let e = receiver.recv().await.unwrap();
            if e.frame["params"]["type"] == kind {
                return e.frame["params"]["payload"].clone();
            }
        }
    })
    .await
    .unwrap()
}

fn log_path(home: &Path) -> PathBuf {
    home.join("runtime/sessions/chat/conversation.jsonl")
}
fn append_raw(home: &Path, message: &Value) {
    use std::io::Write;
    writeln!(
        fs::OpenOptions::new()
            .append(true)
            .open(log_path(home))
            .unwrap(),
        "{}",
        json!({"type":"message","id":common::id(),"parentId":null,"message":message})
    )
    .unwrap();
}
fn raw_message(at: f64) -> Value {
    json!({"role":"assistant","content":[{"type":"text","text":"snapshot speech"}],"timestamp":at*1000.,"stopReason":"stop","usage":{"input":2,"output":3,"cost":{"total":0}}})
}
async fn effects(case: &str) {
    let home = setup();
    let h = home.path();
    runtime_store::mark_fresh(h, "chat").unwrap();
    let raw = log_path(h);
    fs::create_dir_all(raw.parent().unwrap()).unwrap();
    fs::write(
        &raw,
        format!("{}\n", json!({"type":"session","version":3,"id":"chat"})),
    )
    .unwrap();
    let user = json!({"role":"user","content":"durable speech","timestamp":100000});
    runtime_store::project_seeded(h, "chat", "alice", "owl", &user, None, None).unwrap();
    append_raw(h, &user);
    db::open(h).unwrap().execute_batch("INSERT INTO dreams(id,bot,started_at,status,summary) VALUES('previous','owl',1,'complete','previous report');").unwrap();
    propose_memory(
        h,
        "alice",
        "owl",
        "job",
        "add",
        &json!({"text":"pending proposal"}),
    )
    .unwrap();
    let message = raw_message(200.);
    if case == "healthy" {
        runtime_store::project_seeded(h, "chat", "alice", "owl", &message, None, None).unwrap();
        append_raw(h, &message);
    } else {
        let owned = h.to_path_buf();
        let out_of_window = case == "outside";
        hooks().lock().unwrap().insert(owned.clone(),Box::new(move || {
            let until: f64 = db::open(&owned).unwrap().query_row("SELECT started_at FROM dreams WHERE status='running'",[],|r|r.get(0)).unwrap();
            let at = if out_of_window {(until*1000.).floor()/1000.} else {200.};
            assert!(out_of_window || at >= 1. && at < (until*1000.).floor()/1000.);
            runtime_store::project_seeded(&owned,"chat","alice","owl",&raw_message(at),None,None).unwrap();
            eprintln!("snapshot-commit {}",json!({"case":if out_of_window {"outside"}else{"race"},"since":1.,"until":(until*1000.).floor()/1000.,"assistant_at":at,"file":fs::read_to_string(log_path(&owned)).unwrap(),"journal":common::rows(&runtime_store::open(&owned).unwrap(),"SELECT journal_id,entry_id,projection_seq,raw_json FROM native_pi_journal WHERE session_id='chat'",&[]).unwrap()}));
        }));
    }
    let before = fs::read(&raw).unwrap();
    let hub = EventHub::new();
    let mut receiver = hub.subscribe();
    let runtime = Runtime::new(h.into(), hub.clone(), fake_pi(h, false)).unwrap();
    let dreams = Dreaming::new(h.into(), runtime.clone(), hub);
    dreams
        .call("alice", "hexbot.dreaming.run_now", &json!({"bot":"owl"}))
        .await
        .unwrap()
        .unwrap();
    let changed = event(&mut receiver, "hexbot.dreaming.changed").await;
    let prompts = fs::read_to_string(h.join("prompts.log")).unwrap_or_default();
    let learned = prompts.contains("assistant: snapshot speech");
    let pending: i64 = db::open(h)
        .unwrap()
        .query_row(
            "SELECT count(*) FROM memory_proposals WHERE consumed_at IS NULL",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let cutoff: f64 = db::open(h)
        .unwrap()
        .query_row(
            "SELECT MAX(started_at) FROM dreams WHERE status='complete'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    eprintln!(
        "snapshot-effects {}",
        json!({"case":case,"dream":changed["dream"],"provider_admitted":!prompts.is_empty(),"provider_learned":learned,"pending":pending,"cutoff":cutoff,"file_unchanged":fs::read(&raw).unwrap()==before,"provider_input":prompts})
    );
    dreams.shutdown().await;
    runtime.shutdown().await;
    if case == "race" {
        assert_eq!(changed["dream"]["status"], "failed");
        assert_eq!(pending, 1);
        assert_eq!(cutoff, 1.);
        assert!(prompts.is_empty());
    } else {
        assert_eq!(changed["dream"]["status"], "complete");
        assert_eq!(pending, 0);
        assert!(cutoff > 1.);
    }
    assert_eq!(fs::read(&raw).unwrap(), before);
    assert_eq!(
        learned,
        case == "healthy",
        "unvalidated projection entered Dream"
    );
    if case == "race" {
        let until = changed["dream"]["started_at"].as_f64().unwrap();
        let usage = runtime_store::usage(h, "chat").unwrap();
        let journal = common::rows(
            &runtime_store::open(h).unwrap(),
            "SELECT * FROM native_pi_journal WHERE session_id='chat'",
            &[],
        )
        .unwrap();
        // A fresh attempt sees the missing relevant record and refuses it.
        assert!(build_digest(h, "owl", 1., until, None).is_err());
        assert_eq!(fs::read(&raw).unwrap(), before);
        append_raw(h, &message);
        let repaired = fs::read(&raw).unwrap();
        let retry = build_digest(h, "owl", 1., until, None).unwrap();
        assert_eq!(
            retry["sections"][0]["transcript"]
                .as_str()
                .unwrap()
                .matches("assistant: snapshot speech")
                .count(),
            1
        );
        assert_eq!(fs::read(&raw).unwrap(), repaired);
        assert_eq!(runtime_store::usage(h, "chat").unwrap(), usage);
        assert_eq!(
            common::rows(
                &runtime_store::open(h).unwrap(),
                "SELECT * FROM native_pi_journal WHERE session_id='chat'",
                &[]
            )
            .unwrap(),
            journal
        );
        eprintln!(
            "snapshot-repair {}",
            json!({"blocked_before_repair":true,"retry":retry,"usage_unchanged":true,"journal_unchanged":true})
        );
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn snapshot_race_excludes_unvalidated_projection() {
    effects("race").await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn snapshot_healthy_learns_durable_projection() {
    effects("healthy").await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn snapshot_outside_window_projection_is_excluded() {
    effects("outside").await;
}

#[test]
fn snapshot_defers_legacy_selection_when_native_input_commits_after_readiness() {
    let home = setup();
    let h = home.path();
    let legacy = rusqlite::Connection::open(h.join("profiles/owl/state.db")).unwrap();
    legacy.execute_batch("CREATE TABLE sessions(id TEXT,session_key TEXT); CREATE TABLE messages(id INTEGER PRIMARY KEY,session_id TEXT,role TEXT,content TEXT,timestamp REAL,active INTEGER); INSERT INTO sessions VALUES('physical','chat'); INSERT INTO messages VALUES(1,'physical','user','old legacy speech',100,1);").unwrap();
    let digest = build_digest(h, "owl", 0., 200., None).unwrap();
    assert_eq!(
        digest["sections"][0]["transcript"],
        "user: old legacy speech"
    );
    assert_eq!(digest["omitted_conversations"], 0);
    let owned = h.to_path_buf();
    hooks().lock().unwrap().insert(
        owned.clone(),
        Box::new(move || {
            runtime_store::mark_fresh(&owned, "chat").unwrap();
            runtime_store::project_seeded(
                &owned,
                "chat",
                "alice",
                "owl",
                &raw_message(150.),
                None,
                None,
            )
            .unwrap();
        }),
    );
    assert!(build_digest(h, "owl", 0., 200., None).is_err());
    assert_eq!(
        legacy
            .query_row("SELECT content FROM messages WHERE id=1", [], |r| r
                .get::<_, String>(0))
            .unwrap(),
        "old legacy speech"
    );
    assert!(runtime_store::fresh(h, "chat").unwrap());
    assert_eq!(runtime_store::history(h, "chat").unwrap().len(), 1);
    assert!(!log_path(h).exists());
}

#[path = "snapshot_retry.rs"]
mod retry;

#[test]
fn snapshot_sees_completed_fallback_classification_and_preserves_raw_evidence() {
    let home = setup();
    let h = home.path();
    fs::write(h.join("profiles/owl/state.db"), b"obsolete database").unwrap();
    db::open(h).unwrap().execute_batch("UPDATE sections SET title='Dreams' WHERE id='chat'; INSERT INTO dreams(id,bot,started_at,status,summary) VALUES('old','owl',1,'complete','REPORT');").unwrap();
    runtime_store::mark_fresh(h, "chat").unwrap();
    fs::create_dir_all(log_path(h).parent().unwrap()).unwrap();
    fs::write(
        log_path(h),
        format!("{}\n", json!({"type":"session","version":3,"id":"chat"})),
    )
    .unwrap();
    let mut report = raw_message(100.);
    report["content"] = json!([{"type":"text","text":"REPORT"}]);
    let mut structured = report.clone();
    structured["content"]
        .as_array_mut()
        .unwrap()
        .push(json!({"type":"toolCall","id":"call","name":"read","arguments":{}}));
    for message in [&report, &structured] {
        runtime_store::project_seeded(h, "chat", "alice", "owl", message, None, None).unwrap();
        append_raw(h, message);
    }
    let before = fs::read(log_path(h)).unwrap();
    let usage = runtime_store::usage(h, "chat").unwrap();
    let digest = build_digest(h, "owl", 0., 200., None).unwrap();
    assert_eq!(digest["sections"][0]["transcript"], "assistant: REPORT");
    let history = runtime_store::history(h, "chat").unwrap();
    assert_eq!(history[0]["dream"], true);
    assert_ne!(history[1]["dream"], true);
    assert_eq!(fs::read(log_path(h)).unwrap(), before);
    assert_eq!(runtime_store::usage(h, "chat").unwrap(), usage);
    assert_eq!(
        build_digest(h, "owl", 0., 200., None).unwrap()["sections"],
        digest["sections"]
    );
}
