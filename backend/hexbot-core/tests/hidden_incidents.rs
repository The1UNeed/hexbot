use hexbot_core::{db, server::App};
use serde_json::{Value, json};
use std::{fs, sync::Arc, time::Duration};

mod support;

async fn fixture() -> (support::TestHome, Arc<App>) {
    let home = support::TestHome::new();
    let pi = home.path().join("fake-pi.cjs");
    fs::write(&pi, r#"#!/usr/bin/env node
const emit=v=>process.stdout.write(JSON.stringify(v)+'\n');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
const c=JSON.parse(line);emit({type:'response',id:c.id,command:c.type,success:true,data:{}});
if(c.type==='prompt'){emit({type:'agent_start'});emit({type:'message_end',message:{role:'user',content:c.message}});emit({type:'message_end',message:{role:'assistant',content:[],stopReason:'error',errorMessage:'Fixture provider failed'}});emit({type:'agent_end'});emit({type:'agent_settled'});}
});
"#).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&pi, fs::Permissions::from_mode(0o700)).unwrap();
    }
    let app = App::new(home.path().into(), "127.0.0.1:0".parse().unwrap(), pi, None).unwrap();
    db::open(home.path())
        .unwrap()
        .execute(
            "INSERT OR REPLACE INTO settings(key,value) VALUES('workspace_dir',?)",
            [json!(home.workspace()).to_string()],
        )
        .unwrap();
    app.call(
        "local",
        "hexbot.bots.create",
        &json!({"name":"owl","provider":"openai","model":"fixture","tools":[]}),
    )
    .await
    .unwrap();
    (home, app)
}

async fn event(
    events: &mut tokio::sync::broadcast::Receiver<hexbot_core::events::Event>,
    kind: &str,
) -> Value {
    tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            let event = events.recv().await.unwrap().frame;
            if event["params"]["type"] == kind {
                return event["params"]["payload"].clone();
            }
        }
    })
    .await
    .unwrap_or_else(|_| panic!("missing {kind}"))
}

async fn assert_stopped(app: &Arc<App>, failure: &Value) {
    for method in ["hexbot.bots.get", "hexbot.bots.list"] {
        let response = app
            .call("local", method, &json!({"name":"owl"}))
            .await
            .unwrap();
        let bot = if method.ends_with("get") {
            &response["bot"]
        } else {
            &response["bots"][0]
        };
        assert_eq!(bot["status"], "stopped", "{method}: {bot}");
        assert_eq!(bot["status_detail"]["text"], "Fixture provider failed");
        assert_eq!(bot["status_detail"]["section_id"], failure["section_id"]);
        assert_eq!(bot["status_detail"]["session_id"], failure["session_id"]);
        assert_eq!(bot["status_detail"]["action"]["kind"], "retry");
        assert!(bot["status_detail"]["room_id"].is_null());
    }
}

#[tokio::test]
async fn hidden_job_failure_keeps_stopped_status_and_notification_after_restart() {
    let (home, app) = fixture().await;
    let mut events = app.events.subscribe();
    // Deliberately use an ID without a cron/dream/CLI prefix.
    let error = app
        .runtime
        .run_hidden_job(
            "local",
            "owl",
            "background-review",
            "Fail",
            &json!({"job":"review"}),
        )
        .await
        .unwrap_err();
    assert_eq!(error.message, "Fixture provider failed");
    let failure = event(&mut events, "hexbot.bots.incident").await;
    assert_eq!(failure["section_id"], "background-review");
    assert_stopped(&app, &failure).await;
    app.shutdown().await;
    let reopened = App::new(
        home.path().into(),
        "127.0.0.1:0".parse().unwrap(),
        home.path().join("fake-pi.cjs"),
        None,
    )
    .unwrap();
    assert_stopped(&reopened, &failure).await;
    reopened.shutdown().await;
}

#[tokio::test]
async fn cli_provider_failure_keeps_stopped_status_and_notification() {
    let (_home, app) = fixture().await;
    let mut events = app.events.subscribe();
    assert_eq!(
        app.call(
            "local",
            "hexbot.cli.send",
            &json!({"bot":"owl","text":"Fail"})
        )
        .await
        .unwrap_err()
        .message,
        "Fixture provider failed"
    );
    let failure = event(&mut events, "hexbot.bots.incident").await;
    assert_stopped(&app, &failure).await;
    app.shutdown().await;
}

#[tokio::test]
async fn dream_provider_failure_keeps_stopped_status_and_notification() {
    let (_home, app) = fixture().await;
    let mut events = app.events.subscribe();
    app.call("local", "hexbot.dreaming.run_now", &json!({"bot":"owl"}))
        .await
        .unwrap();
    let failure = event(&mut events, "hexbot.bots.incident").await;
    let finished = event(&mut events, "hexbot.dreaming.changed").await;
    assert_eq!(finished["dream"]["status"], "failed");
    assert_stopped(&app, &failure).await;
    app.shutdown().await;
}

#[tokio::test]
async fn archived_and_deleted_private_failures_do_not_become_hidden_run_failures() {
    let (home, app) = fixture().await;
    let stored = app
        .call("local", "hexbot.sections.list", &json!({"bot":"owl"}))
        .await
        .unwrap()["sections"][0]["id"]
        .clone();
    let opened = app
        .call("local", "hexbot.sections.open", &json!({"id":stored}))
        .await
        .unwrap();
    let mut events = app.events.subscribe();
    app.call(
        "local",
        "prompt.submit",
        &json!({"session_id":opened["section"]["live_session_id"],"text":"Fail"}),
    )
    .await
    .unwrap();
    let failure = event(&mut events, "hexbot.bots.incident").await;
    event(&mut events, "message.complete").await;
    assert_stopped(&app, &failure).await;
    app.call("local", "hexbot.sections.archive", &json!({"id":stored}))
        .await
        .unwrap();
    assert_eq!(
        app.call("local", "hexbot.bots.get", &json!({"name":"owl"}))
            .await
            .unwrap()["bot"]["status"],
        "idle"
    );
    app.call("local", "hexbot.sections.unarchive", &json!({"id":stored}))
        .await
        .unwrap();
    assert_stopped(&app, &failure).await;
    app.call("local", "hexbot.sections.delete", &json!({"id":stored}))
        .await
        .unwrap();
    // An older daemon could leave the incident unresolved. The deleted native
    // conversation still must not be mistaken for a hidden run on reads.
    db::open(home.path())
        .unwrap()
        .execute(
            "UPDATE bot_incidents SET resolved_at=NULL WHERE id=?",
            [failure["incident"]["id"].as_str().unwrap()],
        )
        .unwrap();
    assert_eq!(
        app.call("local", "hexbot.bots.get", &json!({"name":"owl"}))
            .await
            .unwrap()["bot"]["status"],
        "idle"
    );
    app.shutdown().await;
}

#[tokio::test]
async fn archived_parent_keeps_child_failure_until_deletion_even_after_restart() {
    let (home, app) = fixture().await;
    let stored = app
        .call("local", "hexbot.sections.create", &json!({"bot":"owl"}))
        .await
        .unwrap()["section"]["id"]
        .clone();
    app.call("local", "hexbot.sections.open", &json!({"id":stored}))
        .await
        .unwrap();
    let mut events = app.events.subscribe();
    app.runtime
        .run_hidden_job(
            "local",
            "owl",
            "child-review",
            "Fail",
            &json!({"parent_session":stored}),
        )
        .await
        .unwrap_err();
    let failure = event(&mut events, "hexbot.bots.incident").await;
    assert_stopped(&app, &failure).await;
    app.call("local", "hexbot.sections.archive", &json!({"id":stored}))
        .await
        .unwrap();
    assert_stopped(&app, &failure).await;
    app.shutdown().await;
    let reopened = App::new(
        home.path().into(),
        "127.0.0.1:0".parse().unwrap(),
        home.path().join("fake-pi.cjs"),
        None,
    )
    .unwrap();
    assert_stopped(&reopened, &failure).await;
    reopened
        .call("local", "hexbot.sections.delete", &json!({"id":stored}))
        .await
        .unwrap();
    assert_eq!(
        reopened
            .call("local", "hexbot.bots.get", &json!({"name":"owl"}))
            .await
            .unwrap()["bot"]["status"],
        "idle"
    );
    let native = hexbot_core::runtime_store::open(home.path()).unwrap();
    assert!(
        !native
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM native_sessions WHERE stored_id='child-review')",
                [],
                |r| r.get::<_, bool>(0)
            )
            .unwrap()
    );
    assert!(hexbot_core::runtime_store::session_dir(home.path(), "child-review").is_err());
    reopened.shutdown().await;
    let restarted = App::new(
        home.path().into(),
        "127.0.0.1:0".parse().unwrap(),
        home.path().join("fake-pi.cjs"),
        None,
    )
    .unwrap();
    assert_eq!(
        restarted
            .call("local", "hexbot.bots.get", &json!({"name":"owl"}))
            .await
            .unwrap()["bot"]["status"],
        "idle"
    );
    restarted.shutdown().await;
}
