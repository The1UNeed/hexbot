use chrono::{Local, TimeZone, Timelike};
use hexbot_core::{
    common, db,
    dreaming::{self, Dreaming},
    events::{Event, EventHub},
    runtime::Runtime,
    runtime_store,
};
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
    time::Duration,
};
mod support;

fn setup() -> support::TestHome {
    let home = support::TestHome::new();
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
rl.on('line',l=>{const c=JSON.parse(l);emit({type:'response',id:c.id,command:c.type,success:true,data:{}});if(c.type==='prompt'){emit({type:'agent_start'});emit({type:'message_end',message:{role:'user',content:c.message}});if(WAIT)return;const config=JSON.parse(fs.readFileSync(process.env.HEXBOT_SESSION_CONFIG));if(c.message.includes('daily Hexbot dream') && (config.tools.length!==1 || config.tools[0].name!=='memory')){emit({type:'error',message:'unrestricted dream'});return;}emit({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'Dream summary'}});emit({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'Dream summary'}],usage:{input:1,output:2,cost:{total:0}},stopReason:'stop'}});emit({type:'agent_end'});emit({type:'agent_settled'});}if(c.type==='abort')emit({type:'agent_settled'});});
"##.replace("WAIT",if waiting{"true"}else{"false"});
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
#[test]
fn schedules_parse_natural_intervals_oneshots_names_steps_and_cron_or_semantics() {
    let now = Local
        .with_ymd_and_hms(2026, 9, 24, 8, 0, 0)
        .single()
        .unwrap()
        .timestamp() as f64;
    for (text, minutes) in [
        ("30m", 30),
        ("every 2h", 120),
        ("every hour", 60),
        ("1d", 1440),
    ] {
        let s = dreaming::parse_schedule(text, now).unwrap();
        assert_eq!(
            dreaming::next_run(&s, now).unwrap(),
            Some(now + minutes as f64 * 60.0)
        );
    }
    let once = dreaming::parse_schedule("in 30m", now).unwrap();
    assert_eq!(once["kind"], "once");
    assert_eq!(dreaming::next_run(&once, now).unwrap(), Some(now + 1800.0));
    assert_eq!(dreaming::next_run(&once, now + 1800.0).unwrap(), None);
    let daily = dreaming::parse_schedule("every day at 9am", now).unwrap();
    assert_eq!(dreaming::next_run(&daily, now).unwrap(), Some(now + 3600.0));
    let named = dreaming::parse_schedule("*/15 9 * SEP MON-FRI", now).unwrap();
    assert_eq!(
        dreaming::next_run(&named, now + 3600.0).unwrap(),
        Some(now + 4500.0)
    );
    assert!(dreaming::parse_schedule("*/0 * * * *", now).is_err());
    assert!(dreaming::parse_schedule("90 * * * *", now).is_err());
    assert!(dreaming::parse_schedule("every 0m", now).is_err());
    let or = dreaming::parse_schedule("0 9 25 * THU", now).unwrap();
    assert_eq!(dreaming::next_run(&or, now).unwrap(), Some(now + 3600.0));
}
#[test]
fn digest_preserves_archived_sources_filters_time_and_caps_unicode() {
    let home = setup();
    db::open(home.path())
        .unwrap()
        .execute("UPDATE sections SET archived_at=1 WHERE id='chat'", [])
        .unwrap();
    runtime_store::append(
        home.path(),
        "chat",
        json!({"role":"user","text":"old","timestamp":99}),
    )
    .unwrap();
    runtime_store::append(
        home.path(),
        "chat",
        json!({"role":"user","text":"界".repeat(13000),"timestamp":100}),
    )
    .unwrap();
    let digest = dreaming::build_digest(home.path(), "owl", 100.0, None).unwrap();
    let text = digest["sections"][0]["transcript"].as_str().unwrap();
    assert_eq!(text.chars().count(), 12000);
    assert!(text.starts_with("[earlier messages omitted]"));
    assert!(
        dreaming::build_digest(home.path(), "owl", 101.0, None).unwrap()["sections"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}
#[tokio::test]
async fn dreams_use_restricted_tools_persist_snapshots_and_reuse_the_dreams_section() {
    let home = setup();
    let hub = EventHub::new();
    let mut receiver = hub.subscribe();
    let runtime =
        Runtime::new(home.path().into(), hub.clone(), fake_pi(home.path(), false)).unwrap();
    let dreams = Dreaming::new(home.path().into(), runtime.clone(), hub);
    for _ in 0..2 {
        dreams
            .call("alice", "hexbot.dreaming.run_now", &json!({"bot":"owl"}))
            .await
            .unwrap()
            .unwrap();
        let changed = event(&mut receiver, "hexbot.dreaming.changed").await;
        assert_eq!(changed["dream"]["status"], "complete");
        assert_eq!(changed["dream"]["memory_before"], "before");
        assert_eq!(changed["dream"]["memory_after"], "before");
    }
    let rows = common::rows(
        &db::open(home.path()).unwrap(),
        "SELECT id FROM sections WHERE title='Dreams'",
        &[],
    )
    .unwrap();
    assert_eq!(rows.len(), 1);
    let history = runtime_store::history(home.path(), rows[0]["id"].as_str().unwrap()).unwrap();
    assert_eq!(history.len(), 2);
    assert!(history.iter().all(|m| m["role"] == "assistant"));
    dreams.shutdown().await;
    runtime.shutdown().await;
}
#[tokio::test]
async fn restore_checks_owner_and_records_an_undoable_restore() {
    let home = setup();
    let hub = EventHub::new();
    let runtime =
        Runtime::new(home.path().into(), hub.clone(), fake_pi(home.path(), false)).unwrap();
    let dreams = Dreaming::new(home.path().into(), runtime.clone(), hub);
    db::open(home.path()).unwrap().execute_batch("INSERT INTO dreams(id,bot,started_at,finished_at,status,owner_id,memory_before,memory_after) VALUES ('d','owl',1,2,'complete','alice','older','before');").unwrap();
    assert_eq!(
        dreams
            .call("bob", "hexbot.dreaming.restore", &json!({"id":"d"}))
            .await
            .unwrap()
            .unwrap_err()
            .code,
        4302
    );
    let restored = dreams
        .call("alice", "hexbot.dreaming.restore", &json!({"id":"d"}))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(restored["memory_md"], "older");
    let undo = dreams
        .call(
            "alice",
            "hexbot.dreaming.restore",
            &json!({"id":restored["dream_id"]}),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(undo["memory_md"], "before");
    dreams.shutdown().await;
    runtime.shutdown().await;
}
#[tokio::test]
async fn concurrent_dreams_are_rejected_and_shutdown_records_failure() {
    let home = setup();
    let hub = EventHub::new();
    let mut receiver = hub.subscribe();
    let runtime =
        Runtime::new(home.path().into(), hub.clone(), fake_pi(home.path(), true)).unwrap();
    let dreams = Dreaming::new(home.path().into(), runtime.clone(), hub);
    dreams
        .call("alice", "hexbot.dreaming.run_now", &json!({"bot":"owl"}))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        dreams
            .call("alice", "hexbot.dreaming.run_now", &json!({"bot":"owl"}))
            .await
            .unwrap()
            .unwrap_err()
            .code,
        4243
    );
    event(&mut receiver, "status.update").await;
    tokio::time::timeout(Duration::from_secs(10), dreams.shutdown())
        .await
        .unwrap();
    let rows = dreams
        .call("alice", "hexbot.dreaming.list", &json!({"bot":"owl"}))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(rows["dreams"][0]["status"], "failed");
    runtime.shutdown().await;
}
#[tokio::test]
async fn cron_crud_run_now_and_owner_isolation() {
    let home = setup();
    let hub = EventHub::new();
    let mut receiver = hub.subscribe();
    let runtime =
        Runtime::new(home.path().into(), hub.clone(), fake_pi(home.path(), false)).unwrap();
    let dreams = Dreaming::new(home.path().into(), runtime.clone(), hub);
    let create = dreams
        .tool_call(
            "alice",
            "owl",
            &json!({"action":"create","prompt":"Summarize","schedule":"every hour"}),
        )
        .await
        .unwrap();
    let id = &create["job"]["id"];
    assert!(
        dreams
            .tool_call("bob", "owl", &json!({"action":"list"}))
            .await
            .is_err()
    );
    dreams
        .tool_call("alice", "owl", &json!({"action":"pause","job_id":id}))
        .await
        .unwrap();
    assert!(
        dreams
            .tool_call("alice", "owl", &json!({"action":"list"}))
            .await
            .unwrap()["jobs"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    dreams
        .tool_call("alice", "owl", &json!({"action":"run","job_id":id}))
        .await
        .unwrap();
    let complete = event(&mut receiver, "hexbot.scheduled.changed").await;
    assert_eq!(complete["job"]["last_status"], "success");
    assert_eq!(complete["job"]["enabled"], false);
    dreams
        .tool_call("alice", "owl", &json!({"action":"resume","job_id":id}))
        .await
        .unwrap();
    assert!(
        dreams
            .tool_call(
                "alice",
                "owl",
                &json!({"action":"update","job_id":id,"deliver":"telegram:123"})
            )
            .await
            .is_err()
    );
    dreams
        .tool_call("alice", "owl", &json!({"action":"remove","job_id":id}))
        .await
        .unwrap();
    assert!(
        dreams
            .tool_call(
                "alice",
                "owl",
                &json!({"action":"list","include_disabled":true})
            )
            .await
            .unwrap()["jobs"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    dreams.shutdown().await;
    runtime.shutdown().await;
}
#[tokio::test]
async fn scheduler_runs_each_bot_and_room_once_per_local_day() {
    let home = setup();
    let conn = db::open(home.path()).unwrap();
    let now = Local::now();
    let at = format!("{:02}:{:02}", now.hour(), now.minute());
    conn.execute(
        "INSERT INTO settings(key,value) VALUES ('dream_time',?)",
        [json!(at).to_string()],
    )
    .unwrap();
    conn.execute_batch("INSERT INTO rooms(id,name,owner_id,main_bot) VALUES ('room','Room','alice','owl'); INSERT INTO room_members(room_id,member_kind,member_id,added_by) VALUES ('room','bot','owl','alice');").unwrap();
    let hub = EventHub::new();
    let mut receiver = hub.subscribe();
    let runtime =
        Runtime::new(home.path().into(), hub.clone(), fake_pi(home.path(), false)).unwrap();
    let dreams = Dreaming::new(home.path().into(), runtime.clone(), hub);
    dreams.tick_at(common::now()).await.unwrap();
    event(&mut receiver, "hexbot.dreaming.changed").await;
    dreams.tick_at(common::now()).await.unwrap();
    let room = event(&mut receiver, "hexbot.dreaming.changed").await;
    assert_eq!(room["dream"]["room_id"], "room");
    dreams.tick_at(common::now()).await.unwrap();
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM dreams", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        2
    );
    assert_eq!(
        conn.query_row(
            "SELECT text FROM room_memory WHERE room_id='room'",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "Dream summary"
    );
    dreams.shutdown().await;
    runtime.shutdown().await;
}

#[tokio::test]
async fn imports_legacy_jobs_once_and_runs_scripts_without_an_agent() {
    let home = setup();
    let conn = db::open(home.path()).unwrap();
    // Scripts need Off or an OS sandbox; hosts without bubblewrap have neither.
    conn.execute("UPDATE bots SET approval_mode='off' WHERE name='owl'", [])
        .unwrap();
    conn.execute(
        "INSERT INTO settings(key,value) VALUES ('dream_enabled','false')",
        [],
    )
    .unwrap();
    let profile = home.path().join("profiles/owl");
    fs::create_dir_all(profile.join("cron")).unwrap();
    fs::create_dir_all(profile.join("scripts")).unwrap();
    fs::write(profile.join("scripts/check.sh"), "printf 'script result'\n").unwrap();
    fs::write(profile.join("cron/jobs.json"),json!({"jobs":[{"id":"old","name":"Legacy job","prompt":"","script":"check.sh","no_agent":true,"deliver":"local","enabled":false,"schedule":{"kind":"interval","minutes":30},"repeat":{"times":null,"completed":0}}]}).to_string()).unwrap();
    let hub = EventHub::new();
    let mut receiver = hub.subscribe();
    let runtime = Runtime::new(
        home.path().into(),
        hub.clone(),
        home.path().join("nonexistent-pi"),
    )
    .unwrap();
    let dreams = Dreaming::new(home.path().into(), runtime.clone(), hub);
    dreams.start().await.unwrap();
    let jobs = dreams
        .tool_call(
            "alice",
            "owl",
            &json!({"action":"list","include_disabled":true}),
        )
        .await
        .unwrap();
    assert_eq!(jobs["jobs"].as_array().unwrap().len(), 1);
    let id = &jobs["jobs"][0]["id"];
    dreams
        .tool_call("alice", "owl", &json!({"action":"run","job_id":id}))
        .await
        .unwrap();
    let completed = event(&mut receiver, "hexbot.scheduled.changed").await;
    assert_eq!(completed["job"]["last_output"], "script result");
    assert_eq!(completed["job"]["last_status"], "success");
    dreams.shutdown().await;
    runtime.shutdown().await;
}

#[tokio::test]
async fn monitors_skip_unchanged_output_and_one_shots_disable_after_firing() {
    let home = setup();
    db::open(home.path())
        .unwrap()
        .execute("UPDATE bots SET approval_mode='off' WHERE name='owl'", [])
        .unwrap();
    let profile = home.path().join("profiles/owl");
    fs::create_dir_all(profile.join("scripts")).unwrap();
    fs::write(profile.join("scripts/monitor.sh"), "printf stable\n").unwrap();
    let hub = EventHub::new();
    let mut receiver = hub.subscribe();
    let runtime =
        Runtime::new(home.path().into(), hub.clone(), fake_pi(home.path(), false)).unwrap();
    let dreams = Dreaming::new(home.path().into(), runtime.clone(), hub);
    let job=dreams.tool_call("alice","owl",&json!({"action":"create","schedule":"30m","prompt":"Inspect monitor","monitor":"monitor.sh"})).await.unwrap();
    let id = &job["job"]["id"];
    dreams
        .tool_call("alice", "owl", &json!({"action":"run","job_id":id}))
        .await
        .unwrap();
    assert_eq!(
        event(&mut receiver, "hexbot.scheduled.changed").await["job"]["last_status"],
        "success"
    );
    dreams
        .tool_call("alice", "owl", &json!({"action":"run","job_id":id}))
        .await
        .unwrap();
    assert_eq!(
        event(&mut receiver, "hexbot.scheduled.changed").await["job"]["last_status"],
        "skipped"
    );
    let once = dreams
        .tool_call(
            "alice",
            "owl",
            &json!({"action":"create","schedule":"in 30m","prompt":"One shot"}),
        )
        .await
        .unwrap();
    dreams
        .tool_call(
            "alice",
            "owl",
            &json!({"action":"run","job_id":once["job"]["id"]}),
        )
        .await
        .unwrap();
    let completed = event(&mut receiver, "hexbot.scheduled.changed").await;
    assert_eq!(completed["job"]["enabled"], false);
    assert_eq!(completed["job"]["state"], "completed");
    dreams.shutdown().await;
    runtime.shutdown().await;
}

#[tokio::test]
async fn cron_freezes_model_workdir_and_tool_overrides_in_the_new_session() {
    let home = setup();
    let workdir = home.workspace().join("job-workspace");
    fs::create_dir_all(&workdir).unwrap();
    let hub = EventHub::new();
    let mut receiver = hub.subscribe();
    let runtime =
        Runtime::new(home.path().into(), hub.clone(), fake_pi(home.path(), false)).unwrap();
    let dreams = Dreaming::new(home.path().into(), runtime.clone(), hub);
    let created=dreams.tool_call("alice","owl",&json!({"action":"create","prompt":"Inspect workspace","schedule":"30m","model":"other-model","provider":"openai","workdir":workdir,"reasoning_effort":"low","enabled_toolsets":["memory"]})).await.unwrap();
    dreams
        .tool_call(
            "alice",
            "owl",
            &json!({"action":"run","job_id":created["job"]["id"]}),
        )
        .await
        .unwrap();
    let done = event(&mut receiver, "hexbot.scheduled.changed").await;
    assert_eq!(done["job"]["last_status"], "success");
    let options: String = runtime_store::open(home.path())
        .unwrap()
        .query_row(
            "SELECT options FROM native_sessions WHERE stored_id LIKE 'cron-%'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let options: Value = serde_json::from_str(&options).unwrap();
    assert_eq!(options["model"], "other-model");
    assert_eq!(options["provider"], "openai");
    assert_eq!(options["cwd"], json!(fs::canonicalize(workdir).unwrap()));
    assert_eq!(options["reasoning_effort"], "low");
    assert_eq!(options["restricted"], json!(["memory"]));
    dreams.shutdown().await;
    runtime.shutdown().await;
}

#[test]
fn digest_prefers_native_branch_and_legacy_fallback_resolves_session_keys_and_active_rows() {
    let home = setup();
    let legacy = rusqlite::Connection::open(home.path().join("profiles/owl/state.db")).unwrap();
    legacy.execute_batch("CREATE TABLE sessions(id TEXT,session_key TEXT); CREATE TABLE messages(id INTEGER PRIMARY KEY,session_id TEXT,role TEXT,content TEXT,timestamp REAL,active INTEGER); INSERT INTO sessions VALUES ('physical-session','chat'); INSERT INTO messages VALUES (1,'physical-session','user','inactive legacy',100,0),(2,'physical-session','user','active legacy',101,1);").unwrap();
    let before = dreaming::build_digest(home.path(), "owl", 0.0, None).unwrap();
    assert_eq!(before["sections"][0]["transcript"], "user: active legacy");
    runtime_store::append(
        home.path(),
        "chat",
        json!({"role":"user","text":"imported native legacy","row_id":"legacy-2","timestamp":101}),
    )
    .unwrap();
    runtime_store::append(
        home.path(),
        "chat",
        json!({"role":"user","text":"abandoned native branch","timestamp":102}),
    )
    .unwrap();
    runtime_store::open(home.path()).unwrap().execute("INSERT INTO native_pi_journal(journal_id,session_id,raw_json,entry_id,projection_seq,active) VALUES ('j','chat','{}','old-entry',2,0)",[]).unwrap();
    let native = dreaming::build_digest(home.path(), "owl", 0.0, None).unwrap();
    assert_eq!(
        native["sections"][0]["transcript"],
        "user: imported native legacy"
    );
    runtime_store::open(home.path())
        .unwrap()
        .execute(
            "UPDATE native_pi_journal SET projection_seq=1 WHERE journal_id='j'",
            [],
        )
        .unwrap();
    runtime_store::open(home.path())
        .unwrap()
        .execute("DELETE FROM native_messages WHERE seq=2", [])
        .unwrap();
    assert!(
        dreaming::build_digest(home.path(), "owl", 0.0, None).unwrap()["sections"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[test]
fn digest_keeps_the_newest_conversations_within_one_prompt_budget() {
    let home = setup();
    let conn = db::open(home.path()).unwrap();
    for n in 1..=8 {
        let id = format!("busy-{n}");
        conn.execute(
            "INSERT INTO sections(id,bot,owner_id,title,created_at,updated_at) VALUES (?,'owl','alice','Busy',?,?)",
            rusqlite::params![id, n, n],
        )
        .unwrap();
        runtime_store::append(
            home.path(),
            &id,
            json!({"role":"user","text":"x".repeat(13000),"timestamp":100 + n}),
        )
        .unwrap();
    }
    let digest = dreaming::build_digest(home.path(), "owl", 0.0, None).unwrap();
    let ids: Vec<_> = digest["sections"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, ["busy-5", "busy-6", "busy-7", "busy-8"]);
    assert_eq!(digest["omitted_conversations"], 4);
    assert!(digest.to_string().len() <= 60_000);
}

#[tokio::test]
async fn monitor_urls_and_job_workdirs_follow_the_bot_policy() {
    use std::io::{Read, Write};
    let home = setup();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/", listener.local_addr().unwrap());
    let hub = EventHub::new();
    let mut receiver = hub.subscribe();
    let runtime =
        Runtime::new(home.path().into(), hub.clone(), fake_pi(home.path(), false)).unwrap();
    let dreams = Dreaming::new(home.path().into(), runtime.clone(), hub);
    let inside = home.path().join("profiles/owl");
    let refused = dreams
        .tool_call(
            "alice",
            "owl",
            &json!({"action":"create","schedule":"30m","prompt":"Edit","workdir":inside}),
        )
        .await
        .unwrap_err();
    assert_eq!(refused.code, 4202);
    let job = dreams
        .tool_call(
            "alice",
            "owl",
            &json!({"action":"create","schedule":"30m","prompt":"Watch","monitor":url}),
        )
        .await
        .unwrap();
    let id = &job["job"]["id"];
    dreams
        .tool_call("alice", "owl", &json!({"action":"run","job_id":id}))
        .await
        .unwrap();
    let blocked = event(&mut receiver, "hexbot.scheduled.changed").await;
    assert_eq!(blocked["job"]["last_status"], "error");
    assert!(
        blocked["job"]["last_error"]
            .as_str()
            .unwrap()
            .contains("network safety")
    );
    // The kernel queues a completed connection even before accept, so none was attempted.
    listener.set_nonblocking(true).unwrap();
    assert!(listener.accept().is_err());
    listener.set_nonblocking(false).unwrap();
    fs::write(
        home.path().join("profiles/owl/.env"),
        "HERMES_ALLOW_PRIVATE_URLS=true\n",
    )
    .unwrap();
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut request = [0; 1024];
        let _ = stream.read(&mut request).unwrap();
        stream
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 6\r\nConnection: close\r\n\r\nstatus")
            .unwrap();
    });
    dreams
        .tool_call("alice", "owl", &json!({"action":"run","job_id":id}))
        .await
        .unwrap();
    let allowed = event(&mut receiver, "hexbot.scheduled.changed").await;
    assert_eq!(allowed["job"]["last_status"], "success");
    assert!(allowed["job"]["monitor_state"]["last_output_hash"].is_string());
    server.join().unwrap();
    dreams.shutdown().await;
    runtime.shutdown().await;
}

#[test]
fn digest_bounds_metadata_and_counts_json_escaping_and_unicode() {
    let home = setup();
    let conn = db::open(home.path()).unwrap();
    let huge = "界\"\n".repeat(256 * 1024);
    conn.execute("UPDATE sections SET title=? WHERE id='chat'", [&huge])
        .unwrap();
    runtime_store::append(
        home.path(),
        "chat",
        json!({"role":"user","text":"recent","timestamp":1}),
    )
    .unwrap();
    for n in 1..=8 {
        let id = format!("room-{n}");
        conn.execute(
            "INSERT INTO rooms(id,name,owner_id) VALUES(?,?,'alice')",
            rusqlite::params![id, huge],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO room_members(room_id,member_kind,member_id) VALUES(?,'bot','owl')",
            [&id],
        )
        .unwrap();
        conn.execute("INSERT INTO room_events(room_id,seq,kind,actor_id,payload_json,created_at) VALUES(?,1,'message','alice',?,?)", rusqlite::params![id, json!({"text":"界\"\n".repeat(5000)}).to_string(), n + 1]).unwrap();
    }
    let digest = dreaming::build_digest(home.path(), "owl", 0.0, None).unwrap();
    assert!(digest.to_string().len() <= 60_000);
    assert!(digest["omitted_conversations"].as_u64().unwrap() > 0);
    let empty = dreaming::build_digest(home.path(), &"b".repeat(1024 * 1024), 0.0, None).unwrap();
    assert_eq!(empty["bot"].as_str().unwrap().len(), 256);
    assert!(empty.to_string().len() <= 60_000);
    // Small older conversations still fit after an oversized recent entry is skipped.
    let section = &digest["sections"][0];
    assert_eq!(section["id"], "chat");
    assert_eq!(section["title"].as_str().unwrap().chars().count(), 256);
    assert!(
        digest["rooms"]
            .as_array()
            .unwrap()
            .iter()
            .all(|room| { room["name"].as_str().unwrap().chars().count() <= 256 })
    );
}

#[test]
fn digest_keeps_private_thread_questions_and_sender_tool_replies() {
    let home = setup();
    let h = home.path();
    db::open(h).unwrap().execute_batch("INSERT INTO bots(name,owner_id) VALUES('cat','alice'); INSERT INTO sections(id,bot,owner_id,title,peer_bot,created_at) VALUES('private','cat','alice','From Owl','owl',0);").unwrap();
    runtime_store::append(
        h,
        "private",
        json!({"role":"user","text":"@owl: Review the plan","display_kind":"hidden"}),
    )
    .unwrap();
    runtime_store::append(
        h,
        "private",
        json!({"role":"assistant","text":"The plan needs a rollback"}),
    )
    .unwrap();
    runtime_store::append(h, "chat", json!({"role":"tool","name":"message_bot","text":"{\"reply\":\"The plan needs a rollback\",\"section_id\":\"private\"}"})).unwrap();
    let receiver = dreaming::build_digest(h, "cat", 0., None)
        .unwrap()
        .to_string();
    assert!(receiver.contains("user: @owl: Review the plan"));
    assert!(receiver.contains("assistant: The plan needs a rollback"));
    let sender = dreaming::build_digest(h, "owl", 0., None)
        .unwrap()
        .to_string();
    assert!(sender.contains("tool: "));
    assert!(sender.contains("The plan needs a rollback"));
}

#[tokio::test]
async fn paired_clients_manage_jobs_through_the_same_owner_scoped_scheduler() {
    let home = setup();
    let events = EventHub::default();
    let runtime = Runtime::new(
        home.path().into(),
        events.clone(),
        fake_pi(home.path(), false),
    )
    .unwrap();
    let scheduler = Dreaming::new(home.path().into(), runtime, events.clone());
    let mut receiver = events.subscribe();
    let create = scheduler.call("alice", "hexbot.jobs.create", &json!({
        "bot": "owl", "name": "Morning notes", "schedule": "every 2h", "prompt": "Write a short note"
    })).await.unwrap().unwrap();
    let id = create["job"]["id"].as_str().unwrap();
    let changed = event(&mut receiver, "hexbot.jobs.changed").await;
    assert_eq!(changed["bot"], "owl");
    let refused = scheduler
        .call("bob", "hexbot.jobs.list", &json!({"bot": "owl"}))
        .await
        .unwrap()
        .unwrap_err();
    assert_eq!(refused.code, 4302);
    scheduler
        .call(
            "alice",
            "hexbot.jobs.pause",
            &json!({"bot": "owl", "job_id": id}),
        )
        .await
        .unwrap()
        .unwrap();
    let paused = scheduler
        .call(
            "alice",
            "hexbot.jobs.list",
            &json!({"bot": "owl", "include_disabled": true}),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(paused["jobs"][0]["enabled"], false);
    scheduler
        .call(
            "alice",
            "hexbot.jobs.resume",
            &json!({"bot": "owl", "job_id": id}),
        )
        .await
        .unwrap()
        .unwrap();
    scheduler
        .call(
            "alice",
            "hexbot.jobs.update",
            &json!({"bot": "owl", "job_id": id, "name": "Evening notes"}),
        )
        .await
        .unwrap()
        .unwrap();
    let updated = scheduler
        .call("alice", "hexbot.jobs.list", &json!({"bot": "owl"}))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(updated["jobs"][0]["name"], "Evening notes");
    scheduler
        .call(
            "alice",
            "hexbot.jobs.remove",
            &json!({"bot": "owl", "job_id": id}),
        )
        .await
        .unwrap()
        .unwrap();
    let removed = scheduler
        .call("alice", "hexbot.jobs.list", &json!({"bot": "owl"}))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(removed["jobs"], json!([]));
    assert!(
        scheduler
            .call("alice", "hexbot.jobs.unknown", &json!({"bot": "owl"}))
            .await
            .is_none()
    );
}
