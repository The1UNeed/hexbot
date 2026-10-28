//! Heartbeat: every 30 minutes each bot works through its HEARTBEAT.md on its
//! own and posts in its chat only when something needs the user.
use hexbot_core::{common, db, runtime_store, server::App};
use serde_json::{Value, json};
use std::{fs, sync::Arc, time::Duration};
mod support;

/// How long a test waits for an event before it fails. Each heartbeat starts a
/// Pi process, and test runs side by side can make that take many seconds.
const WAIT: Duration = Duration::from_secs(60);

/// A prompt that is a JSON `{tool, args}` calls that daemon tool. A heartbeat
/// whose checklist carries `send: TEXT` messages the user with TEXT, one
/// carrying `crash:` fails like a model outage, `tools?` lists its tools,
/// `chat?` says whether the chat's words reached it, and any other stays quiet.
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
const beat=c.message.startsWith('# Heartbeat');
const send=/send: ([^\n]*)/.exec(c.message);
if(beat&&c.message.includes('crash:')){emit({type:'message_end',message:{role:'assistant',content:[],stopReason:'error',errorMessage:'model down'}});emit({type:'agent_end'});emit({type:'agent_settled'});}
else if(beat&&c.message.includes('tools?')){listing=true;bridge('hexbot_session_settings',{});}
else if(beat&&c.message.includes('chat?'))finish(c.message.includes('Remember the lighthouse')?'saw the chat':'checklist only');
else if(call&&call.tool)bridge(call.tool,call.args);
else if(send&&beat)bridge('hexbot_notify',{message:send[1]});
else finish('Looked at the inbox; nothing needs them now.');}
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

async fn create(app: &Arc<App>, bot: &str) {
    app.call("local", "hexbot.bots.create", &json!({ "name": bot }))
        .await
        .unwrap();
}

async fn checklist(app: &Arc<App>, bot: &str, text: &str) -> Value {
    app.call(
        "local",
        "hexbot.heartbeat.set",
        &json!({"bot":bot,"text":text}),
    )
    .await
    .unwrap()
}

async fn status(app: &Arc<App>, bot: &str) -> Value {
    app.call("local", "hexbot.heartbeat.status", &json!({ "bot": bot }))
        .await
        .unwrap()
}

async fn chat(app: &Arc<App>, bot: &str) -> String {
    app.call("local", "hexbot.sections.create", &json!({ "bot": bot }))
        .await
        .unwrap()["section"]["id"]
        .as_str()
        .unwrap()
        .to_owned()
}

async fn open(app: &Arc<App>, section: &str) -> String {
    app.call("local", "hexbot.sections.open", &json!({"id":section}))
        .await
        .unwrap()["section"]["live_session_id"]
        .as_str()
        .unwrap()
        .to_owned()
}

/// Sends `text` in a section and returns the bot's reply.
async fn say(app: &Arc<App>, live: &str, text: &str) -> String {
    let mut events = app.events.subscribe();
    app.call(
        "local",
        "prompt.submit",
        &json!({"session_id":live,"text":text}),
    )
    .await
    .unwrap();
    tokio::time::timeout(WAIT, async {
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

/// Calls a daemon tool from a section and returns its reply.
async fn call_tool(app: &Arc<App>, live: &str, tool: &str, args: Value) -> String {
    say(app, live, &json!({"tool":tool,"args":args}).to_string()).await
}

/// Waits until no heartbeat of `bot` runs, and returns its status.
async fn settled(
    app: &Arc<App>,
    bot: &str,
    mut events: tokio::sync::broadcast::Receiver<hexbot_core::events::Event>,
) -> Value {
    tokio::time::timeout(WAIT, async {
        loop {
            let status = status(app, bot).await;
            if status["running"] == false {
                return status;
            }
            while events.recv().await.unwrap().frame["params"]["type"] != "hexbot.heartbeat.changed"
            {
            }
        }
    })
    .await
    .unwrap()
}

/// Runs one scheduler tick at `at` and waits for the heartbeat it starts to end.
async fn tick(app: &Arc<App>, bot: &str, at: f64) -> Value {
    let events = app.events.subscribe();
    app.dreaming.tick_at(at).await.unwrap();
    settled(app, bot, events).await
}

fn runs(h: &support::TestHome) -> i64 {
    db::open(h.path())
        .unwrap()
        .query_row("SELECT COUNT(*) FROM heartbeats", [], |r| r.get(0))
        .unwrap()
}

#[tokio::test]
async fn a_heartbeat_posts_what_it_found_in_the_bots_chat() {
    let (h, app) = setup();
    create(&app, "owl").await;
    checklist(
        &app,
        "owl",
        "# Heartbeat\n- Is flight BA 286 on Friday delayed? send: BA 286 on Friday now leaves at 18:40, two hours late.",
    )
    .await;
    let mut events = app.events.subscribe();
    let status = tick(&app, "owl", common::now()).await;
    let run = &status["recent"][0];
    assert_eq!(run["kind"], "scheduled");
    assert_eq!(run["status"], "complete");
    assert_eq!(run["messaged"], true);

    let message = loop {
        let event = events.recv().await.unwrap();
        if event.frame["params"]["type"] == "hexbot.heartbeat.message" {
            break event.frame["params"]["payload"].clone();
        }
    };
    // In the bot's one chat, not a conversation of its own.
    let section = message["section_id"].as_str().unwrap().to_owned();
    assert_eq!(section, chat(&app, "owl").await);
    assert_eq!(message["bot"], "owl");
    // Unread until opened, like a turn that finished elsewhere.
    let done: Option<f64> = db::open(h.path())
        .unwrap()
        .query_row("SELECT done_at FROM sections WHERE id=?", [&section], |r| {
            r.get(0)
        })
        .unwrap();
    assert!(done.is_some());
    let text = "BA 286 on Friday now leaves at 18:40, two hours late.";
    let shown = runtime_store::history(h.path(), &section).unwrap();
    assert!(
        shown
            .iter()
            .any(|m| m["role"] == "assistant" && m["text"] == text && m["heartbeat"] == true),
        "{shown:?}"
    );

    // The user's next message there brings it into context. This Pi never
    // reports taking it, so it is offered once more and then not again.
    let live = open(&app, &section).await;
    let context = call_tool(&app, &live, "hexbot_heartbeat_context", json!({})).await;
    assert!(context.contains("two hours late"), "{context}");
    assert!(context.contains("<heartbeat_message"), "{context}");
    let again = call_tool(&app, &live, "hexbot_heartbeat_context", json!({})).await;
    assert!(again.contains("two hours late"), "{again}");
    let done = call_tool(&app, &live, "hexbot_heartbeat_context", json!({})).await;
    assert!(done.contains("\"text\":null"), "{done}");

    // One message a heartbeat.
    let left: i64 = runtime_store::open(h.path())
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM native_sessions WHERE stored_id LIKE 'heartbeat-%'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(left, 0, "a heartbeat's transcript goes when it ends");

    // A new bot with a deleted one's name starts with no heartbeats.
    app.call("local", "hexbot.bots.delete", &json!({"name":"owl"}))
        .await
        .unwrap();
    create(&app, "owl").await;
    let kept: i64 = db::open(h.path())
        .unwrap()
        .query_row(
            "SELECT (SELECT COUNT(*) FROM heartbeats WHERE bot='owl')+(SELECT COUNT(*) FROM heartbeat_messages WHERE bot='owl')",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(kept, 0);
    assert_eq!(self::status(&app, "owl").await["recent"], json!([]));
}

#[tokio::test]
async fn an_empty_checklist_runs_nothing_and_each_bot_runs_every_thirty_minutes() {
    let (h, app) = setup();
    create(&app, "owl").await;
    create(&app, "fox").await;
    // A new bot's checklist is the placeholder: nothing to check, no run.
    let first = status(&app, "owl").await;
    assert_eq!(first["empty"], true);
    assert_eq!(first["every_minutes"], 30);
    assert!(first["next_run_at"].is_null());
    assert!(first["text"].as_str().unwrap().contains("Every 30 minutes"));
    assert!(h.path().join("profiles/owl/HEARTBEAT.md").is_file());
    let now = common::now();
    app.dreaming.tick_at(now).await.unwrap();
    assert_eq!(runs(&h), 0);
    assert_eq!(
        app.call("local", "hexbot.heartbeat.run_now", &json!({"bot":"owl"}))
            .await
            .unwrap_err()
            .code,
        4246
    );

    // Picked up on the next tick, and usually quiet.
    let saved = checklist(&app, "owl", "- Has Sam replied about the lease?").await;
    assert_eq!(saved["empty"], false);
    let status = tick(&app, "owl", now).await;
    let run = &status["recent"][0];
    assert_eq!(run["status"], "complete");
    assert_eq!(run["messaged"], false);
    assert_eq!(
        run["summary"],
        "Looked at the inbox; nothing needs them now."
    );
    // Quiet: nothing in the chat, and fox has nothing to check.
    assert_eq!(runs(&h), 1);
    // The next waits 30 minutes, around the clock.
    app.dreaming.tick_at(now + 60.0).await.unwrap();
    assert_eq!(runs(&h), 1);
    tick(&app, "owl", now + 30.0 * 60.0 + 1.0).await;
    assert_eq!(runs(&h), 2);
    // Each bot keeps its own time.
    checklist(&app, "fox", "- Did anything on my calendar change today?").await;
    tick(&app, "fox", now + 30.0 * 60.0 + 61.0).await;
    assert_eq!(runs(&h), 3);
    // Clearing the checklist stops it.
    assert_eq!(checklist(&app, "fox", "").await["empty"], true);
    assert_eq!(
        app.call("local", "hexbot.heartbeat.run_now", &json!({"bot":"fox"}))
            .await
            .unwrap_err()
            .code,
        4246
    );
    // Off means off.
    app.call(
        "local",
        "hexbot.settings.set",
        &json!({"patch":{"heartbeat_enabled":false}}),
    )
    .await
    .unwrap();
    assert!(self::status(&app, "owl").await["next_run_at"].is_null());
    app.dreaming.tick_at(now + 7200.0).await.unwrap();
    assert_eq!(runs(&h), 3);
    // Run now still works while it is off.
    let events = app.events.subscribe();
    let started = app
        .call("local", "hexbot.heartbeat.run_now", &json!({"bot":"owl"}))
        .await
        .unwrap();
    assert_eq!(started["kind"], "manual");
    assert_eq!(
        app.call("local", "hexbot.heartbeat.run_now", &json!({"bot":"owl"}))
            .await
            .unwrap_err()
            .code,
        4243
    );
    let status = settled(&app, "owl", events).await;
    // Dated now, before the ticks this test ran ahead of the clock.
    let manual = status["recent"]
        .as_array()
        .unwrap()
        .iter()
        .find(|run| run["kind"] == "manual")
        .unwrap();
    assert_eq!(manual["status"], "complete");
}

#[tokio::test]
async fn a_heartbeat_reads_its_checklist_not_the_chat_and_holds_only_reading_tools() {
    let (h, app) = setup();
    create(&app, "owl").await;
    // Every tool the bot has, so the heartbeat has something to leave out.
    app.call(
        "local",
        "hexbot.bots.update",
        &json!({"name":"owl","tools":["terminal","files","code_execution","browser","computer_use","message_bots","delegate","scheduling"]}),
    )
    .await
    .unwrap();
    let live = open(&app, &chat(&app, "owl").await).await;
    say(&app, &live, "Remember the lighthouse at Point Reyes.").await;
    checklist(&app, "owl", "- chat?").await;
    let now = common::now();
    let status = tick(&app, "owl", now).await;
    assert_eq!(status["recent"][0]["summary"], "checklist only");

    checklist(&app, "owl", "- tools?").await;
    let status = tick(&app, "owl", now + 1801.0).await;
    assert_eq!(
        status["recent"][0]["summary"],
        "hexbot_connector_read,hexbot_heartbeat,hexbot_notify,hexbot_soul,memory,skill_view,web_extract,web_search"
    );

    // A failed run is logged and the next waits its 30 minutes.
    checklist(&app, "owl", "- crash: the provider is down").await;
    let status = tick(&app, "owl", now + 3602.0).await;
    assert_eq!(status["recent"][0]["status"], "failed");
    assert_eq!(status["recent"][0]["summary"], "model down");
    app.dreaming.tick_at(now + 3662.0).await.unwrap();
    assert_eq!(runs(&h), 3);
}

#[tokio::test]
async fn every_bots_chat_keeps_its_checklist_but_only_a_heartbeat_messages_the_user() {
    let (h, app) = setup();
    create(&app, "fox").await;
    let live = open(&app, &chat(&app, "fox").await).await;
    let reply = call_tool(
        &app,
        &live,
        "hexbot_heartbeat",
        json!({"action":"write","text":"# Heartbeat\n- Has the Sony WH-1000XM6 dropped below $300?\n"}),
    )
    .await;
    assert!(reply.contains("\"saved\":true"), "{reply}");
    assert_eq!(
        fs::read_to_string(h.path().join("profiles/fox/HEARTBEAT.md")).unwrap(),
        "# Heartbeat\n- Has the Sony WH-1000XM6 dropped below $300?\n"
    );
    let reply = call_tool(&app, &live, "hexbot_heartbeat", json!({"action":"read"})).await;
    assert!(reply.contains("WH-1000XM6"), "{reply}");
    // Open tabs follow what the bot wrote.
    assert_eq!(status(&app, "fox").await["empty"], false);
    // Only a heartbeat speaks out of turn.
    let reply = call_tool(&app, &live, "hexbot_notify", json!({"message":"hi"})).await;
    assert!(reply.contains("disabled"), "{reply}");
    let reply = call_tool(
        &app,
        &live,
        "hexbot_connector_read",
        json!({"connector":"notion","method":"GET","path":"/v1/users"}),
    )
    .await;
    assert!(reply.contains("disabled"), "{reply}");
    // Too long is refused, from the chat and from the app.
    let reply = call_tool(
        &app,
        &live,
        "hexbot_heartbeat",
        json!({"action":"write","text":"x".repeat(4001)}),
    )
    .await;
    assert!(reply.contains("4000"), "{reply}");
    assert!(
        app.call(
            "local",
            "hexbot.heartbeat.set",
            &json!({"bot":"fox","text":"x".repeat(4001)}),
        )
        .await
        .is_err()
    );
}

#[tokio::test]
async fn messages_the_user_only_read_still_go_after_thirty_days() {
    let (h, app) = setup();
    let now = common::now();
    db::open(h.path())
        .unwrap()
        .execute(
            "INSERT INTO heartbeat_messages(id,owner_id,bot,section_id,text,created_at) VALUES ('old','local','owl','s','Sam replied.',?),('new','local','owl','s','BA 286 is late.',?)",
            [now - 31.0 * 86_400.0, now],
        )
        .unwrap();
    app.dreaming.tick_at(now).await.unwrap();
    let kept: Vec<String> = db::open(h.path())
        .unwrap()
        .prepare("SELECT id FROM heartbeat_messages")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(kept, ["new"]);
}
