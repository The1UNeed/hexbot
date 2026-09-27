use hexbot_core::{
    Error, Result, db,
    events::EventHub,
    rooms::{self, RoomEngine, RoomRunner},
};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
};
fn setup() -> tempfile::TempDir {
    let h = tempfile::tempdir().unwrap();
    db::migrate(h.path()).unwrap();
    db::open(h.path()).unwrap().execute_batch("INSERT INTO users(id,display_name,role,created_at) VALUES ('alice','Alice','member',0),('bob','Bob','member',0); INSERT INTO bots(name,owner_id) VALUES ('owl','alice'),('fox','alice'),('private','bob');").unwrap();
    h
}
fn call(h: &tempfile::TempDir, method: &str, p: Value) -> Value {
    rooms::call(h.path(), "alice", &format!("hexbot.rooms.{method}"), &p)
        .unwrap()
        .unwrap()
}
fn create(h: &tempfile::TempDir) -> String {
    call(
        h,
        "create",
        json!({"name":"Room","members":["owl","fox"],"main_bot":"owl"}),
    )["room"]["id"]
        .as_str()
        .unwrap()
        .into()
}
#[test]
fn storage_owner_members_archive_and_monotonic_reads() {
    let h = setup();
    let room = create(&h);
    assert_eq!(
        rooms::call(h.path(), "bob", "hexbot.rooms.get", &json!({"id":room}))
            .unwrap()
            .unwrap_err()
            .code,
        4302
    );
    assert_eq!(
        rooms::call(
            h.path(),
            "alice",
            "hexbot.rooms.add_member",
            &json!({"id":room,"bot":"private"})
        )
        .unwrap()
        .unwrap_err()
        .code,
        4302
    );
    let ev = call(&h, "send", json!({"id":room,"text":"hi"}));
    assert_eq!(ev["event"]["seq"], 3);
    call(&h, "mark_read", json!({"id":room,"seq":3}));
    call(&h, "mark_read", json!({"id":room,"seq":1}));
    let got = call(&h, "get", json!({"id":room}));
    assert_eq!(
        got["room"]["members"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["member_id"] == "alice")
            .unwrap()["last_read_seq"],
        3
    );
    call(&h, "archive", json!({"id":room}));
    assert_eq!(call(&h, "list", json!({}))["rooms"], json!([]));
    call(&h, "archive", json!({"id":room,"archived":false}));
    assert_eq!(
        call(&h, "list", json!({}))["rooms"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    call(&h, "remove_member", json!({"id":room,"bot":"owl"}));
    assert!(call(&h, "get", json!({"id":room}))["room"]["main_bot"].is_null());
    assert_eq!(
        call(&h, "remove_member", json!({"id":room,"bot":"fox"}))["room"]["deleted"],
        true
    );
    assert_eq!(
        db::open(h.path())
            .unwrap()
            .query_row("SELECT COUNT(*) FROM room_events", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
}
#[test]
fn responders_obey_mentions_and_wait_for_humans() {
    let h = setup();
    let id = create(&h);
    let room = call(&h, "get", json!({"id":id}))["room"].clone();
    let done = HashSet::new();
    let select = |kind: &str, text: &str| {
        rooms::select_responders(&room, &json!({"kind":kind,"payload":{"text":text}}), &done)
    };
    assert_eq!(select("message.user", "hello").0, vec!["owl"]);
    assert_eq!(select("message.user", "@FOX please").0, vec!["fox"]);
    assert!(select("message.bot", "email@fox.com").0.is_empty());
    assert!(select("message.bot", "@user confirm @fox").1);
    assert!(select("message.bot", "Can you clarify?").1);
}
#[test]
fn transcript_limits_memory_and_collecting() {
    let room = json!({"name":"R","members":[]});
    let events = (0..100)
        .map(|n| json!({"kind":"message.user","payload":{"text":format!("line {n}")}}))
        .collect::<Vec<_>>();
    let prompt = rooms::render_prompt(
        &room,
        "owl",
        &events,
        "shared memory",
        &[("fox".into(), "answer".into())],
    );
    assert!(prompt.contains("older transcript lines omitted"));
    assert!(!prompt.contains("User: line 0\n"));
    assert!(prompt.contains("Room memory:\nshared memory"));
    assert!(prompt.contains("Replies to collect:\n@fox: answer"));
}
#[derive(Default)]
struct Fake {
    replies: Mutex<HashMap<String, Vec<String>>>,
    calls: Mutex<Vec<(String, String, String)>>,
}
impl Fake {
    fn replies(&self, bot: &str, replies: &[&str]) {
        self.replies.lock().unwrap().insert(
            bot.into(),
            replies.iter().rev().map(|s| s.to_string()).collect(),
        );
    }
}
impl RoomRunner for Fake {
    fn run<'a>(
        &'a self,
        _: &'a str,
        bot: &'a str,
        stored: &'a str,
        text: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<String>> + Send + 'a>> {
        Box::pin(async move {
            self.calls
                .lock()
                .unwrap()
                .push((bot.into(), stored.into(), text.into()));
            let reply = self
                .replies
                .lock()
                .unwrap()
                .get_mut(bot)
                .and_then(|r| r.pop())
                .unwrap_or_else(|| "(pass)".into());
            if reply == "FAIL" {
                Err(Error::new(5200, "model failed"))
            } else {
                Ok(reply)
            }
        })
    }
    fn interrupt<'a>(
        &'a self,
        _: &'a str,
        _: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + Send + 'a>> {
        Box::pin(async { Ok(()) })
    }
}
#[tokio::test]
async fn engine_fanout_collects_reuses_sessions_and_never_replays() {
    let h = setup();
    let room = create(&h);
    let runner = Arc::new(Fake::default());
    runner.replies("owl", &["@fox investigate", "Here is the result"]);
    runner.replies("fox", &["Found it"]);
    let engine = RoomEngine::with_runner(h.path().into(), runner.clone(), EventHub::new());
    call(&h, "send", json!({"id":room,"text":"start"}));
    engine.drain("alice", &room).await.unwrap();
    let calls = runner.calls.lock().unwrap().clone();
    assert_eq!(
        calls.iter().map(|c| c.0.as_str()).collect::<Vec<_>>(),
        vec!["owl", "fox", "owl"]
    );
    assert_eq!(calls[0].1, calls[2].1);
    assert!(calls[2].2.contains("Replies to collect:\n@fox: Found it"));
    engine.drain("alice", &room).await.unwrap();
    assert_eq!(runner.calls.lock().unwrap().len(), 3);
    call(&h, "send", json!({"id":room,"text":"next"}));
    engine.drain("alice", &room).await.unwrap();
    assert_eq!(runner.calls.lock().unwrap()[3].1, calls[0].1);
}
#[tokio::test]
async fn limits_failures_and_pass_are_durable() {
    let h = setup();
    let room = create(&h);
    let runner = Arc::new(Fake::default());
    runner.replies("owl", &["FAIL", "(pass)"]);
    let engine = RoomEngine::with_runner(h.path().into(), runner.clone(), EventHub::new());
    call(&h, "send", json!({"id":room,"text":"start"}));
    engine.drain("alice", &room).await.unwrap();
    engine.drain("alice", &room).await.unwrap();
    assert_eq!(runner.calls.lock().unwrap().len(), 1);
    call(&h, "send", json!({"id":room,"text":"next"}));
    engine.drain("alice", &room).await.unwrap();
    assert_eq!(runner.calls.lock().unwrap().len(), 2);
    call(
        &h,
        "update",
        json!({"id":room,"limits":{"room_bot_turns_per_human_turn":0}}),
    );
    call(&h, "send", json!({"id":room,"text":"limited"}));
    engine.drain("alice", &room).await.unwrap();
    assert_eq!(runner.calls.lock().unwrap().len(), 2);
    let events = call(&h, "log", json!({"id":room}));
    let events = events["events"].as_array().unwrap();
    assert!(events.iter().any(|e| e["kind"] == "turn.failed"));
    assert!(events.iter().any(|e| e["kind"] == "limit.tripped"));
    assert!(!events.iter().any(|e| e["kind"] == "message.bot"));
}
#[tokio::test]
async fn old_rooms_continue_after_more_than_a_thousand_events() {
    let h = setup();
    let room = create(&h);
    let conn = db::open(h.path()).unwrap();
    for n in 3..=1100 {
        conn.execute(
            "INSERT INTO room_events VALUES (?,?,'note','system',NULL,'{}',0)",
            rusqlite::params![room, n],
        )
        .unwrap();
    }
    let runner = Arc::new(Fake::default());
    let engine = RoomEngine::with_runner(h.path().into(), runner.clone(), EventHub::new());
    call(&h, "send", json!({"id":room,"text":"late message"}));
    engine.drain("alice", &room).await.unwrap();
    assert_eq!(runner.calls.lock().unwrap().len(), 1);
    assert!(runner.calls.lock().unwrap()[0].2.contains("late message"));
}
#[test]
fn activity_queries_are_owner_scoped() {
    let h = setup();
    let conn = db::open(h.path()).unwrap();
    conn.execute_batch("INSERT INTO bot_messages VALUES ('a','owl','fox',NULL,NULL,1,'hello'),('b','private','private',NULL,NULL,2,'secret');").unwrap();
    let pairs = rooms::call(h.path(), "alice", "hexbot.activity.pairs", &json!({}))
        .unwrap()
        .unwrap();
    assert_eq!(pairs["pairs"].as_array().unwrap().len(), 1);
    let list = rooms::call(
        h.path(),
        "alice",
        "hexbot.activity.list",
        &json!({"from_bot":"owl"}),
    )
    .unwrap()
    .unwrap();
    assert_eq!(list["messages"][0]["text"], "hello");
}

#[tokio::test]
async fn concurrent_fanout_reserves_turn_budget_before_models_run() {
    let h = setup();
    let room = create(&h);
    let runner = Arc::new(Fake::default());
    let engine = RoomEngine::with_runner(h.path().into(), runner.clone(), EventHub::new());
    call(
        &h,
        "update",
        json!({"id":room,"limits":{"room_bot_turns_per_human_turn":1}}),
    );
    call(&h, "send", json!({"id":room,"text":"@owl @fox answer"}));
    engine.drain("alice", &room).await.unwrap();
    assert_eq!(runner.calls.lock().unwrap().len(), 1);
    assert_eq!(
        db::open(h.path())
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM room_turns WHERE status='complete'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        1
    );
}

#[tokio::test]
async fn native_usage_enforces_daily_budget_including_cached_tokens() {
    let h = setup();
    let room = create(&h);
    let runner = Arc::new(Fake::default());
    db::open(h.path())
        .unwrap()
        .execute(
            "UPDATE users SET limits_json=? WHERE id='alice'",
            [r#"{"daily_tokens":10}"#],
        )
        .unwrap();
    hexbot_core::runtime_store::record_usage(
        h.path(),
        "other",
        "alice",
        "owl",
        &json!({"usage":{"input":1,"output":1,"cacheRead":8}}),
    )
    .unwrap();
    call(&h, "send", json!({"id":room,"text":"hello"}));
    RoomEngine::with_runner(h.path().into(), runner.clone(), EventHub::new())
        .drain("alice", &room)
        .await
        .unwrap();
    assert!(runner.calls.lock().unwrap().is_empty());
    let events = call(&h, "log", json!({"id":room}));
    assert!(
        events["events"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["kind"] == "limit.tripped" && e["payload"]["limit"] == "daily_tokens")
    );
}

struct Blocking {
    entered: tokio::sync::Notify,
    release: tokio::sync::Notify,
}
impl RoomRunner for Blocking {
    fn run<'a>(
        &'a self,
        _: &'a str,
        _: &'a str,
        _: &'a str,
        _: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<String>> + Send + 'a>> {
        Box::pin(async move {
            self.entered.notify_one();
            self.release.notified().await;
            Ok("must not be posted after stop".into())
        })
    }
    fn interrupt<'a>(
        &'a self,
        _: &'a str,
        _: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + Send + 'a>> {
        Box::pin(async move {
            self.release.notify_one();
            Ok(())
        })
    }
}
#[tokio::test]
async fn stop_interrupts_running_bot_and_does_not_publish_late_reply() {
    let h = setup();
    let room = create(&h);
    let runner = Arc::new(Blocking {
        entered: tokio::sync::Notify::new(),
        release: tokio::sync::Notify::new(),
    });
    let hub = EventHub::new();
    let mut events = hub.subscribe();
    let engine = Arc::new(RoomEngine::with_runner(
        h.path().into(),
        runner.clone(),
        hub,
    ));
    call(&h, "send", json!({"id":room,"text":"begin"}));
    engine.notify("alice", &room).await.unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(3), runner.entered.notified())
        .await
        .unwrap();
    assert_eq!(engine.stop("bob", &room).await.unwrap_err().code, 4302);
    engine.stop("alice", &room).await.unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        loop {
            let event = events.recv().await.unwrap();
            if event.frame["params"]["payload"]["event"]["kind"] == "turn.failed" {
                break;
            }
        }
    })
    .await
    .unwrap();
    assert!(
        !call(&h, "log", json!({"id":room}))["events"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["kind"] == "message.bot")
    );
}

struct ShutdownRunner {
    entered: tokio::sync::Notify,
    dropped: tokio::sync::Notify,
    interrupted: std::sync::atomic::AtomicBool,
}
struct Dropped<'a>(&'a tokio::sync::Notify);
impl Drop for Dropped<'_> {
    fn drop(&mut self) {
        self.0.notify_one();
    }
}
impl RoomRunner for ShutdownRunner {
    fn run<'a>(
        &'a self,
        _: &'a str,
        _: &'a str,
        _: &'a str,
        _: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<String>> + Send + 'a>> {
        Box::pin(async move {
            let _dropped = Dropped(&self.dropped);
            self.entered.notify_one();
            std::future::pending().await
        })
    }
    fn interrupt<'a>(
        &'a self,
        _: &'a str,
        _: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + Send + 'a>> {
        Box::pin(async move {
            self.interrupted
                .store(true, std::sync::atomic::Ordering::Release);
            Ok(())
        })
    }
}
#[tokio::test]
async fn shutdown_cancels_disabled_owners_and_permanently_rejects_new_work() {
    let h = setup();
    let room = create(&h);
    let runner = Arc::new(ShutdownRunner {
        entered: tokio::sync::Notify::new(),
        dropped: tokio::sync::Notify::new(),
        interrupted: std::sync::atomic::AtomicBool::new(false),
    });
    let engine = Arc::new(RoomEngine::with_runner(
        h.path().into(),
        runner.clone(),
        EventHub::new(),
    ));
    call(&h, "send", json!({"id":room,"text":"start"}));
    engine.notify("alice", &room).await.unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(3), runner.entered.notified())
        .await
        .unwrap();
    let conn = db::open(h.path()).unwrap();
    conn.execute("UPDATE users SET disabled_at=1 WHERE id='alice'", [])
        .unwrap();
    assert_eq!(engine.stop("alice", &room).await.unwrap_err().code, 4302);
    engine.shutdown().await;
    tokio::time::timeout(std::time::Duration::from_secs(3), runner.dropped.notified())
        .await
        .unwrap();
    assert!(
        runner
            .interrupted
            .load(std::sync::atomic::Ordering::Acquire)
    );
    assert_eq!(
        conn.query_row(
            "SELECT COUNT(*) FROM room_turns WHERE status='running'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    assert_eq!(
        conn.query_row(
            "SELECT COUNT(*) FROM room_events WHERE kind='message.bot'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    conn.execute("UPDATE users SET disabled_at=NULL WHERE id='alice'", [])
        .unwrap();
    assert_eq!(engine.notify("alice", &room).await.unwrap_err().code, 5200);
    engine.shutdown().await;
}
#[tokio::test]
async fn reconcile_skips_disabled_users_and_marks_interrupted_turns_failed() {
    let h = setup();
    let room = create(&h);
    call(&h, "send", json!({"id":room,"text":"pending"}));
    let conn = db::open(h.path()).unwrap();
    conn.execute("UPDATE users SET disabled_at=1 WHERE id='alice'", [])
        .unwrap();
    conn.execute(
        "INSERT INTO room_turns VALUES ('interrupted',?,'owl',3,0,NULL,'running',0,0,0)",
        [room],
    )
    .unwrap();
    let runner = Arc::new(Fake::default());
    let engine = Arc::new(RoomEngine::with_runner(
        h.path().into(),
        runner.clone(),
        EventHub::new(),
    ));
    engine.reconcile().await.unwrap();
    assert!(runner.calls.lock().unwrap().is_empty());
    assert_eq!(
        conn.query_row(
            "SELECT status FROM room_turns WHERE id='interrupted'",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "failed"
    );
}
