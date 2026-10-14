//! Check-ins: the primary bot looks at what is going on, on its own, and
//! messages the user only when something matters.
use chrono::{Local, TimeZone, Timelike};
use hexbot_core::{common, db, runtime_store, server::App};
use serde_json::{Value, json};
use std::{fs, sync::Arc, time::Duration};
mod support;

/// A prompt that is a JSON `{tool, args}` calls that daemon tool. A check-in
/// whose prompt carries `send: TEXT` messages the user with TEXT, one carrying
/// `crash:` fails like a model outage, and any other stays quiet.
const FAKE_PI: &str = r#"#!/usr/bin/env node
const rl=require('node:readline').createInterface({input:process.stdin});const emit=x=>process.stdout.write(JSON.stringify(x)+'\n');
const finish=text=>{emit({type:'message_end',message:{role:'assistant',content:[{type:'text',text}],stopReason:'stop'}});emit({type:'agent_end'});emit({type:'agent_settled'});};
const bridge=(name,args)=>emit({type:'extension_ui_request',id:'tool-1',method:'input',title:'__HEXBOT_TOOL__'+JSON.stringify({name,args})});
let listing=false;
rl.on('line',l=>{const c=JSON.parse(l);
if(c.type==='extension_ui_response'){if(listing){listing=false;const v=JSON.parse(c.value);finish((v.result??v).tools.map(t=>t.name).sort().join(','));}else finish(String(c.value));return;}
emit({type:'response',id:c.id,command:c.type,success:true,data:{}});
if(c.type==='prompt'){emit({type:'agent_start'});emit({type:'message_end',message:{role:'user',content:c.message}});
let call;try{call=JSON.parse(c.message)}catch{}
const send=/send: ([^\n]*)/.exec(c.message);
if(c.message.startsWith('# Check-in')&&c.message.includes('crash:')){emit({type:'message_end',message:{role:'assistant',content:[],stopReason:'error',errorMessage:'model down'}});emit({type:'agent_end'});emit({type:'agent_settled'});}
else if(c.message.startsWith('# Check-in')&&c.message.includes('tools?')){listing=true;bridge('hexbot_session_settings',{});}
else if(call&&call.tool)bridge(call.tool,call.args);
else if(send&&c.message.startsWith('# Check-in'))bridge('hexbot_notify',{message:send[1]});
else finish('Looked at the calendar; nothing needs them now.');}
if(c.type==='abort')emit({type:'agent_settled'});});
"#;

fn setup() -> (support::TestHome, Arc<App>) {
    let h = support::TestHome::new();
    db::migrate(h.path()).unwrap();
    db::open(h.path())
        .unwrap()
        .execute(
            "INSERT INTO settings(key,value) VALUES('workspace_dir',?)",
            [json!(h.workspace()).to_string()],
        )
        .unwrap();
    let pi = h.path().join("fake-pi.cjs");
    fs::write(&pi, FAKE_PI).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&pi, fs::Permissions::from_mode(0o755)).unwrap();
    }
    let app = App::new(h.path().into(), "127.0.0.1:0".parse().unwrap(), pi, None).unwrap();
    (h, app)
}

async fn set(app: &Arc<App>, patch: Value) {
    app.call("local", "hexbot.settings.set", &json!({ "patch": patch }))
        .await
        .unwrap();
}

/// Hours that include now, so a heartbeat may run whatever the clock says.
fn hours_around_now() -> String {
    let now = Local::now();
    let from = (now.hour() + 23) % 24;
    let to = (now.hour() + 2) % 24;
    format!("{from:02}:00-{to:02}:00")
}

async fn open(app: &Arc<App>, section: &str) -> String {
    app.call("local", "hexbot.sections.open", &json!({"id":section}))
        .await
        .unwrap()["section"]["live_session_id"]
        .as_str()
        .unwrap()
        .to_owned()
}

/// Calls a daemon tool from a section and returns its reply.
async fn call_tool(app: &Arc<App>, live: &str, tool: &str, args: Value) -> String {
    let mut events = app.events.subscribe();
    app.call(
        "local",
        "prompt.submit",
        &json!({"session_id":live,"text":json!({"tool":tool,"args":args}).to_string()}),
    )
    .await
    .unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let event = events.recv().await.unwrap();
            let params = &event.frame["params"];
            if params["type"] == "message.complete" && params["session_id"] == live {
                return params["payload"]["text"].as_str().unwrap_or("").to_owned();
            }
        }
    })
    .await
    .unwrap()
}

/// Runs one scheduler tick at `at` and waits for the check-in it starts to end.
async fn tick(app: &Arc<App>, at: f64) -> Value {
    let mut events = app.events.subscribe();
    app.dreaming.tick_at(at).await.unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let status = app
                .call("local", "hexbot.checkins.status", &json!({}))
                .await
                .unwrap();
            if status["running"] == false {
                return status;
            }
            while events.recv().await.unwrap().frame["params"]["type"] != "hexbot.checkins.changed"
            {
            }
        }
    })
    .await
    .unwrap()
}

fn rfc3339(at: f64) -> String {
    Local
        .timestamp_opt(at as i64, 0)
        .single()
        .unwrap()
        .to_rfc3339()
}

#[tokio::test]
async fn a_wakeup_the_primary_bot_sets_messages_the_user_in_its_check_ins_section() {
    let (h, app) = setup();
    let created = app
        .call("local", "hexbot.bots.create_primary", &json!({}))
        .await
        .unwrap();
    let live = open(&app, created["section"]["id"].as_str().unwrap()).await;
    let now = common::now();
    let note = "send: Your PE Invasion Games mid-unit feedback is due tonight at 11:59 PM, and it is still marked not started.";
    let reply = call_tool(
        &app,
        &live,
        "hexbot_wakeups",
        json!({"action":"add","at":rfc3339(now + 600.0),"note":note}),
    )
    .await;
    assert!(reply.contains("\"wakeup\""), "{reply}");
    let waiting = app
        .call("local", "hexbot.checkins.status", &json!({}))
        .await
        .unwrap();
    assert_eq!(waiting["wakeups"].as_array().unwrap().len(), 1);
    assert_eq!(waiting["bot"], "hexbot");

    // Not yet: the wake-up waits for its time, and no heartbeat runs outside the hours.
    set(&app, json!({"checkin_hours": "03:00-03:01"})).await;
    app.dreaming.tick_at(now).await.unwrap();
    let status = app
        .call("local", "hexbot.checkins.status", &json!({}))
        .await
        .unwrap();
    assert!(status["recent"].as_array().unwrap().is_empty());

    let mut events = app.events.subscribe();
    let status = tick(&app, now + 601.0).await;
    let run = &status["recent"][0];
    assert_eq!(run["kind"], "wakeup");
    assert_eq!(run["status"], "complete");
    assert_eq!(run["messaged"], true);
    assert!(status["wakeups"].as_array().unwrap().is_empty());

    let message = loop {
        let event = events.recv().await.unwrap();
        if event.frame["params"]["type"] == "hexbot.checkins.message" {
            break event.frame["params"]["payload"].clone();
        }
    };
    let section = message["section_id"].as_str().unwrap().to_owned();
    assert_eq!(status["section_id"], section.as_str());
    let (title, bot): (String, String) = db::open(h.path())
        .unwrap()
        .query_row(
            "SELECT title,bot FROM sections WHERE id=?",
            [&section],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!((title.as_str(), bot.as_str()), ("Check-ins", "hexbot"));
    // Unread until opened, like a turn that finished elsewhere.
    let done: Option<f64> = db::open(h.path())
        .unwrap()
        .query_row("SELECT done_at FROM sections WHERE id=?", [&section], |r| {
            r.get(0)
        })
        .unwrap();
    assert!(done.is_some());
    let shown = runtime_store::history(h.path(), &section).unwrap();
    let text = &note["send: ".len()..];
    assert!(
        shown
            .iter()
            .any(|m| m["role"] == "assistant" && m["text"] == text),
        "{shown:?}"
    );

    // The user's next message there brings it into context. This Pi never
    // reports taking it, so it is offered once more and then not again.
    let live = open(&app, &section).await;
    let context = call_tool(&app, &live, "hexbot_checkin_context", json!({})).await;
    assert!(context.contains("PE Invasion Games"), "{context}");
    let again = call_tool(&app, &live, "hexbot_checkin_context", json!({})).await;
    assert!(again.contains("PE Invasion Games"), "{again}");
    let done = call_tool(&app, &live, "hexbot_checkin_context", json!({})).await;
    assert!(done.contains("\"text\":null"), "{done}");

    // Deleting the section takes what was said there with it.
    app.call("local", "hexbot.sections.delete", &json!({"id":section}))
        .await
        .unwrap();
    let kept: String = db::open(h.path())
        .unwrap()
        .query_row("SELECT text FROM checkin_messages", [], |r| r.get(0))
        .unwrap();
    assert_eq!(kept, "");
}

#[tokio::test]
async fn a_failed_check_in_gives_its_wake_up_back_and_runs_read_only() {
    let (h, app) = setup();
    let created = app
        .call("local", "hexbot.bots.create_primary", &json!({}))
        .await
        .unwrap();
    // Every tool the bot has, so the check-in has something to leave out.
    app.call(
        "local",
        "hexbot.bots.update",
        &json!({"name":"hexbot","tools":["terminal","files","code_execution","browser","computer_use","message_bots","delegate","scheduling"]}),
    )
    .await
    .unwrap();
    set(&app, json!({"checkin_hours": "03:00-03:01"})).await;
    let live = open(&app, created["section"]["id"].as_str().unwrap()).await;
    let now = common::now();
    call_tool(
        &app,
        &live,
        "hexbot_wakeups",
        json!({"action":"add","at":rfc3339(now + 600.0),"note":"crash: the provider is down"}),
    )
    .await;
    let status = tick(&app, now + 601.0).await;
    assert_eq!(status["recent"][0]["status"], "failed");
    assert_eq!(status["recent"][0]["summary"], "model down");
    // Back, waiting out the retry pause rather than run every minute.
    assert_eq!(status["wakeups"].as_array().unwrap().len(), 1);
    app.dreaming.tick_at(now + 660.0).await.unwrap();
    let count = || -> i64 {
        db::open(h.path())
            .unwrap()
            .query_row("SELECT COUNT(*) FROM checkins", [], |r| r.get(0))
            .unwrap()
    };
    assert_eq!(count(), 1);
    let status = tick(&app, now + 601.0 + 16.0 * 60.0).await;
    assert_eq!(count(), 2);
    assert_eq!(status["recent"][0]["kind"], "wakeup");

    // Still failing, so still waiting; the user cancels it from Settings.
    let waiting = status["wakeups"][0]["id"].as_str().unwrap().to_owned();
    app.call(
        "local",
        "hexbot.checkins.cancel_wakeup",
        &json!({ "id": waiting }),
    )
    .await
    .unwrap();
    // What the check-in held: its own two tools and reading, nothing that acts.
    call_tool(
        &app,
        &live,
        "hexbot_wakeups",
        json!({"action":"add","at":rfc3339(now + 3000.0),"note":"tools?"}),
    )
    .await;
    let status = tick(&app, now + 3001.0).await;
    assert_eq!(
        status["recent"][0]["summary"],
        "hexbot_notify,hexbot_soul,hexbot_wakeups,memory"
    );
    // And its transcript is gone once it ends.
    let left: i64 = runtime_store::open(h.path())
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM native_sessions WHERE stored_id LIKE 'checkin-%'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(left, 0);
}

#[tokio::test]
async fn heartbeats_run_in_the_users_hours_and_usually_stay_quiet() {
    let (h, app) = setup();
    app.call("local", "hexbot.bots.create_primary", &json!({}))
        .await
        .unwrap();
    set(
        &app,
        json!({"checkin_hours": hours_around_now(), "checkin_every_minutes": 60}),
    )
    .await;
    let now = common::now();
    let status = tick(&app, now).await;
    let runs = status["recent"].as_array().unwrap();
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0]["kind"], "heartbeat");
    assert_eq!(runs[0]["status"], "complete");
    assert_eq!(runs[0]["messaged"], false);
    assert_eq!(
        runs[0]["summary"],
        "Looked at the calendar; nothing needs them now."
    );
    // Quiet: no section was made.
    assert!(status["section_id"].is_null());
    // The next waits its interval.
    app.dreaming.tick_at(now + 60.0).await.unwrap();
    let status = app
        .call("local", "hexbot.checkins.status", &json!({}))
        .await
        .unwrap();
    assert_eq!(status["recent"].as_array().unwrap().len(), 1);
    // Off means off.
    set(&app, json!({"checkin_enabled": false})).await;
    app.dreaming.tick_at(now + 7200.0).await.unwrap();
    let count: i64 = db::open(h.path())
        .unwrap()
        .query_row("SELECT COUNT(*) FROM checkins", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 1);
}

#[tokio::test]
async fn only_the_primary_bot_checks_in_and_only_a_check_in_messages_the_user() {
    let (h, app) = setup();
    // No primary bot: nothing to run.
    set(&app, json!({"checkin_hours": hours_around_now()})).await;
    let fox = app
        .call("local", "hexbot.bots.create", &json!({"name":"fox"}))
        .await
        .unwrap();
    app.dreaming.tick_at(common::now()).await.unwrap();
    assert_eq!(
        app.call("local", "hexbot.checkins.run_now", &json!({}))
            .await
            .unwrap_err()
            .code,
        4246
    );
    let count: i64 = db::open(h.path())
        .unwrap()
        .query_row("SELECT COUNT(*) FROM checkins", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 0);
    // Another bot's section has neither tool.
    let section = app
        .call("local", "hexbot.sections.create", &json!({"bot":"fox"}))
        .await
        .unwrap();
    let id = section["section"]["id"]
        .as_str()
        .or(section["id"].as_str())
        .unwrap();
    let live = open(&app, id).await;
    let reply = call_tool(&app, &live, "hexbot_wakeups", json!({"action":"list"})).await;
    assert!(reply.contains("disabled"), "{reply}");
    let _ = fox;
    // The primary bot's own section sets wake-ups but cannot message out of band.
    let created = app
        .call("local", "hexbot.bots.create_primary", &json!({}))
        .await
        .unwrap();
    let live = open(&app, created["section"]["id"].as_str().unwrap()).await;
    let reply = call_tool(&app, &live, "hexbot_notify", json!({"message":"hi"})).await;
    assert!(reply.contains("disabled"), "{reply}");
    let reply = call_tool(&app, &live, "hexbot_wakeups", json!({"action":"list"})).await;
    assert!(reply.contains("\"wakeups\":[]"), "{reply}");
    // A wake-up in the past, or with no note, is refused.
    let reply = call_tool(
        &app,
        &live,
        "hexbot_wakeups",
        json!({"action":"add","at":"2020-01-01 08:00","note":"too late"}),
    )
    .await;
    assert!(reply.contains("at least a minute from now"), "{reply}");
    // Asked from Settings, a check-in runs now.
    let mut events = app.events.subscribe();
    let started = app
        .call("local", "hexbot.checkins.run_now", &json!({}))
        .await
        .unwrap();
    assert_eq!(started["kind"], "manual");
    assert_eq!(
        app.call("local", "hexbot.checkins.run_now", &json!({}))
            .await
            .unwrap_err()
            .code,
        4243
    );
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let status = app
                .call("local", "hexbot.checkins.status", &json!({}))
                .await
                .unwrap();
            if status["running"] == false {
                assert_eq!(status["recent"][0]["status"], "complete");
                return;
            }
            while events.recv().await.unwrap().frame["params"]["type"] != "hexbot.checkins.changed"
            {
            }
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn a_wake_up_waits_a_few_minutes_after_the_last_check_in() {
    let (h, app) = setup();
    let created = app
        .call("local", "hexbot.bots.create_primary", &json!({}))
        .await
        .unwrap();
    set(&app, json!({"checkin_hours": "03:00-03:01"})).await;
    let now = common::now();
    let mut events = app.events.subscribe();
    app.call("local", "hexbot.checkins.run_now", &json!({}))
        .await
        .unwrap();
    while app
        .call("local", "hexbot.checkins.status", &json!({}))
        .await
        .unwrap()["running"]
        == true
    {
        while events.recv().await.unwrap().frame["params"]["type"] != "hexbot.checkins.changed" {}
    }
    let live = open(&app, created["section"]["id"].as_str().unwrap()).await;
    call_tool(
        &app,
        &live,
        "hexbot_wakeups",
        json!({"action":"add","at":rfc3339(now + 90.0),"note":"look again"}),
    )
    .await;
    let count = || -> i64 {
        db::open(h.path())
            .unwrap()
            .query_row("SELECT COUNT(*) FROM checkins", [], |r| r.get(0))
            .unwrap()
    };
    // Due, but the last check-in was a moment ago: no back-to-back runs.
    app.dreaming.tick_at(now + 120.0).await.unwrap();
    assert_eq!(count(), 1);
    let status = tick(&app, now + 360.0).await;
    assert_eq!(count(), 2);
    assert_eq!(status["recent"][0]["kind"], "wakeup");
}

#[tokio::test]
async fn check_in_now_takes_the_wake_ups_already_due() {
    let (h, app) = setup();
    let created = app
        .call("local", "hexbot.bots.create_primary", &json!({}))
        .await
        .unwrap();
    set(&app, json!({"checkin_enabled": false})).await;
    let live = open(&app, created["section"]["id"].as_str().unwrap()).await;
    let now = common::now();
    call_tool(
        &app,
        &live,
        "hexbot_wakeups",
        json!({"action":"add","at":rfc3339(now + 61.0),"note":"send: The essay is due at 9 AM."}),
    )
    .await;
    // Check-ins are off, so only Check in now runs it, once it is due.
    db::open(h.path())
        .unwrap()
        .execute("UPDATE checkin_wakeups SET at=?", [now - 1.0])
        .unwrap();
    let mut events = app.events.subscribe();
    app.call("local", "hexbot.checkins.run_now", &json!({}))
        .await
        .unwrap();
    let message = loop {
        let event = events.recv().await.unwrap();
        if event.frame["params"]["type"] == "hexbot.checkins.message" {
            break event.frame["params"]["payload"]["text"].clone();
        }
    };
    assert_eq!(message, "The essay is due at 9 AM.");
    let waiting: i64 = db::open(h.path())
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM checkin_wakeups WHERE fired_at IS NULL",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(waiting, 0);
}
