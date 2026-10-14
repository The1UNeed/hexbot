//! The primary bot: created once, never deleted, and the only bot whose own
//! sections can manage the others. Destructive changes always ask.
use hexbot_core::{db, server::App};
use serde_json::{Value, json};
use std::{fs, sync::Arc, time::Duration};
mod support;

/// A prompt that is a JSON `{tool, args}` calls that daemon tool; the reply is its result.
const FAKE_PI: &str = r#"#!/usr/bin/env node
const rl=require('node:readline').createInterface({input:process.stdin});const emit=x=>process.stdout.write(JSON.stringify(x)+'\n');
const finish=text=>{emit({type:'message_end',message:{role:'assistant',content:[{type:'text',text}],stopReason:'stop'}});emit({type:'agent_end'});emit({type:'agent_settled'});};
rl.on('line',l=>{const c=JSON.parse(l);
if(c.type==='extension_ui_response'){finish(String(c.value));return;}
emit({type:'response',id:c.id,command:c.type,success:true,data:{}});
if(c.type==='prompt'){emit({type:'agent_start'});emit({type:'message_end',message:{role:'user',content:c.message}});
let call;try{call=JSON.parse(c.message)}catch{}
if(call&&call.tool)emit({type:'extension_ui_request',id:'tool-1',method:'input',title:'__HEXBOT_TOOL__'+JSON.stringify({name:call.tool,args:call.args})});
else finish('ok');}
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

async fn open(app: &Arc<App>, section: &str) -> String {
    app.call("local", "hexbot.sections.open", &json!({"id":section}))
        .await
        .unwrap()["section"]["live_session_id"]
        .as_str()
        .unwrap()
        .to_owned()
}

/// Calls a tool from the section and returns the reply, answering an
/// approval with `choice` if one is asked. Returns whether one was asked.
async fn call_tool(
    app: &Arc<App>,
    live: &str,
    tool: &str,
    args: Value,
    choice: &str,
) -> (bool, String) {
    let mut events = app.events.subscribe();
    app.call(
        "local",
        "prompt.submit",
        &json!({"session_id":live,"text":json!({"tool":tool,"args":args}).to_string()}),
    )
    .await
    .unwrap();
    let mut asked = false;
    let text = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let event = events.recv().await.unwrap();
            let params = &event.frame["params"];
            if params["type"] == "approval.request" {
                asked = true;
                assert_eq!(
                    params["payload"]["reason"],
                    "The primary bot always asks before this."
                );
                app.call(
                    "local",
                    "approval.respond",
                    &json!({"session_id":live,"request_id":params["payload"]["request_id"],"choice":choice}),
                )
                .await
                .unwrap();
            }
            if params["type"] == "message.complete" {
                return params["payload"]["text"].as_str().unwrap_or("").to_owned();
            }
        }
    })
    .await
    .unwrap();
    (asked, text)
}

fn exists(h: &support::TestHome, bot: &str) -> bool {
    db::open(h.path())
        .unwrap()
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM bots WHERE name=?)",
            [bot],
            |r| r.get(0),
        )
        .unwrap()
}

#[tokio::test]
async fn primary_bot_manages_other_bots_and_always_asks_before_deleting() {
    let (h, app) = setup();
    let created = app
        .call("local", "hexbot.bots.create_primary", &json!({}))
        .await
        .unwrap();
    assert_eq!(created["bot"]["name"], "hexbot");
    assert_eq!(created["bot"]["display_name"], "HexBot");
    assert_eq!(created["bot"]["primary"], true);
    assert_eq!(
        app.call("local", "hexbot.bots.create_primary", &json!({}))
            .await
            .unwrap_err()
            .code,
        4214
    );
    let fox = app
        .call("local", "hexbot.bots.create", &json!({"name":"fox"}))
        .await
        .unwrap();
    assert_eq!(fox["bot"]["primary"], false);
    // Bypass skips ordinary approvals but not the primary bot's destructive ones.
    app.call(
        "local",
        "hexbot.bots.update",
        &json!({"name":"hexbot","approval_mode":"off"}),
    )
    .await
    .unwrap();

    let section = created["section"]["id"].as_str().unwrap();
    let live = open(&app, section).await;
    let config: Value = serde_json::from_str(
        &fs::read_to_string(
            h.path()
                .join("runtime/sessions")
                .join(section)
                .join("config.json"),
        )
        .unwrap(),
    )
    .unwrap();
    for tool in [
        "hexbot_bots",
        "hexbot_rooms",
        "hexbot_jobs",
        "hexbot_settings",
    ] {
        assert!(
            config["tools"]
                .as_array()
                .unwrap()
                .iter()
                .any(|t| t["name"] == tool)
        );
    }
    assert!(config["prompt"].as_str().unwrap().contains("# Primary bot"));

    let (asked, reply) = call_tool(
        &app,
        &live,
        "hexbot_bots",
        json!({"action":"create","name":"owl","display_name":"Owl","title":"Research"}),
        "deny",
    )
    .await;
    assert!(!asked, "{reply}");
    assert!(exists(&h, "owl"), "{reply}");

    let (asked, reply) =
        call_tool(&app, &live, "hexbot_bots", json!({"action":"list"}), "deny").await;
    assert!(!asked);
    assert!(
        reply.contains("\"owl\"") && !reply.contains("avatar"),
        "{reply}"
    );

    let (asked, reply) = call_tool(
        &app,
        &live,
        "hexbot_bots",
        json!({"action":"delete","name":"fox"}),
        "deny",
    )
    .await;
    assert!(asked);
    assert!(reply.contains("denied"), "{reply}");
    assert!(exists(&h, "fox"));

    let (asked, _) = call_tool(
        &app,
        &live,
        "hexbot_bots",
        json!({"action":"delete","name":"fox"}),
        "once",
    )
    .await;
    assert!(asked);
    assert!(!exists(&h, "fox"));

    let (asked, reply) = call_tool(
        &app,
        &live,
        "hexbot_bots",
        json!({"action":"delete","name":"hexbot"}),
        "once",
    )
    .await;
    assert!(!asked);
    assert!(reply.contains("can't be deleted"), "{reply}");

    let (asked, reply) = call_tool(
        &app,
        &live,
        "hexbot_settings",
        json!({"action":"set","patch":{"lan_enabled":true}}),
        "once",
    )
    .await;
    assert!(!asked);
    assert!(reply.contains("only be changed by the user"), "{reply}");

    let (asked, _) = call_tool(
        &app,
        &live,
        "hexbot_settings",
        json!({"action":"set","patch":{"dream_time":"04:30"}}),
        "once",
    )
    .await;
    assert!(asked);
    assert_eq!(
        app.call("local", "hexbot.settings.get", &json!({}))
            .await
            .unwrap()["dream_time"],
        "04:30"
    );

    let (asked, reply) = call_tool(
        &app,
        &live,
        "hexbot_rooms",
        json!({"action":"create","name":"Lab","members":["owl"],"main_bot":"owl"}),
        "deny",
    )
    .await;
    assert!(!asked);
    let rooms = app
        .call("local", "hexbot.rooms.list", &json!({}))
        .await
        .unwrap();
    assert_eq!(rooms["rooms"][0]["name"], "Lab", "{reply}");
    let room = rooms["rooms"][0]["id"].as_str().unwrap().to_owned();

    // A room's approval mode asks like a bot's, even in Bypass.
    let (asked, reply) = call_tool(
        &app,
        &live,
        "hexbot_rooms",
        json!({"action":"update","id":room,"approval_mode":"off"}),
        "deny",
    )
    .await;
    assert!(asked);
    assert!(reply.contains("denied"), "{reply}");
    let rooms = app
        .call("local", "hexbot.rooms.list", &json!({}))
        .await
        .unwrap();
    assert!(rooms["rooms"][0]["approval_mode"].is_null());

    // Jobs go through the jobs methods, so paired clients hear about them.
    let mut events = app.events.subscribe();
    let (asked, reply) = call_tool(
        &app,
        &live,
        "hexbot_jobs",
        json!({"action":"create","bot":"owl","name":"Digest","prompt":"Summarise the news","schedule":"every 1h"}),
        "deny",
    )
    .await;
    assert!(!asked);
    assert!(reply.contains("Digest"), "{reply}");
    let changed = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let event = events.recv().await.unwrap();
            if event.frame["params"]["type"] == "hexbot.jobs.changed" {
                return event.frame["params"]["payload"].clone();
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(changed["bot"], "owl");
    app.shutdown().await;
}

#[tokio::test]
async fn other_bots_and_promoted_bots_get_the_tools_only_in_new_own_sections() {
    let (h, app) = setup();
    let owl = app
        .call("local", "hexbot.bots.create", &json!({"name":"owl"}))
        .await
        .unwrap();
    let before = owl["section"]["id"].as_str().unwrap().to_owned();
    let tools = |section: &str| -> Vec<String> {
        let config: Value = serde_json::from_str(
            &fs::read_to_string(
                h.path()
                    .join("runtime/sessions")
                    .join(section)
                    .join("config.json"),
            )
            .unwrap(),
        )
        .unwrap();
        config["tools"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|t| t["name"].as_str().map(str::to_owned))
            .collect()
    };
    let live = open(&app, &before).await;
    assert!(!tools(&before).iter().any(|t| t == "hexbot_bots"));
    let (_, reply) = call_tool(&app, &live, "hexbot_bots", json!({"action":"list"}), "deny").await;
    assert!(reply.contains("disabled"), "{reply}");

    let promoted = app
        .call("local", "hexbot.bots.set_primary", &json!({"name":"owl"}))
        .await
        .unwrap();
    assert_eq!(promoted["bot"]["primary"], true);
    // The open section keeps the tools it was frozen with.
    app.call("local", "hexbot.sections.close", &json!({"id":before}))
        .await
        .unwrap();
    open(&app, &before).await;
    assert!(!tools(&before).iter().any(|t| t == "hexbot_bots"));
    let after = app
        .call(
            "local",
            "hexbot.sections.create",
            &json!({"bot":"owl","title":"New"}),
        )
        .await
        .unwrap()["section"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    open(&app, &after).await;
    assert!(tools(&after).iter().any(|t| t == "hexbot_bots"));
    assert_eq!(
        app.call("local", "hexbot.bots.delete", &json!({"name":"owl"}))
            .await
            .unwrap_err()
            .code,
        4214
    );
    assert!(exists(&h, "owl"));
    app.shutdown().await;
}
