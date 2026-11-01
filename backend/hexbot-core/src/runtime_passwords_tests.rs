use super::*;

#[tokio::test]
async fn a_bot_signs_in_with_a_password_it_never_sees() {
    let (home, runtime, hub) = setup();
    let h = home.path();
    db::open(h)
        .unwrap()
        .execute_batch("INSERT INTO bots(name,owner_id) VALUES('fox','alice');")
        .unwrap();
    // Every bot has Computer use; any program stands in for Cua here.
    fs::write(
        h.join("profiles/owl/config.yaml"),
        "model:\n  provider: openai\n  default: fixture\ntools:\n  enabled_toolsets: []\ncomputer_use:\n  command: /bin/sh\n",
    )
    .unwrap();
    let id = open(&runtime).await;
    let s = runtime.sessions.lock().unwrap()["first"].clone();
    assert!(s.tools.iter().any(|t| t["name"] == "hexbot_passwords"));
    // With nothing saved, the bot is told to use the card, not the chat.
    let empty = runtime
        .tool(&s, "hexbot_passwords", &json!({"action":"list"}))
        .await
        .unwrap();
    assert!(empty["note"].as_str().unwrap().contains("call ask"));
    let secret = "hunter2-correct-horse";
    let mut events = hub.subscribe();
    let asked = {
        let runtime = runtime.clone();
        let s = s.clone();
        tokio::spawn(async move {
            runtime
                .tool(
                    &s,
                    "hexbot_passwords",
                    &json!({"action":"ask","title":"Schoology","url":"https://app.schoology.com/login"}),
                )
                .await
        })
    };
    let card = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let event = events.recv().await.unwrap();
            if event.frame["params"]["type"] == "approval.request" {
                break event.frame["params"]["payload"].clone();
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(card["command"], "Sign in to Schoology");
    assert_eq!(card["form"]["site"], "app.schoology.com");
    assert_eq!(card["form"]["update"], false);
    let respond = |extra: Value| {
        let mut p = json!({"session_id":id,"request_id":card["request_id"],"choice":"once"});
        p.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        let runtime = runtime.clone();
        async move { runtime.call("alice", "approval.respond", &p).await.unwrap() }
    };
    // An app that can't show the form can't approve it empty.
    assert_eq!(respond(json!({})).await.unwrap_err().code, 4202);
    respond(json!({"username":"alex","password":secret}))
        .await
        .unwrap();
    let saved = asked.await.unwrap().unwrap();
    assert_eq!(saved["username"], "alex");
    assert!(!saved.to_string().contains(secret));
    let login = saved["id"].as_str().unwrap().to_owned();
    assert_eq!(
        crate::passwords::secret(h, "alice", &login, "password").unwrap(),
        secret
    );
    let listed = runtime
        .tool(&s, "hexbot_passwords", &json!({"action":"list"}))
        .await
        .unwrap();
    assert_eq!(listed["logins"][0]["site"], "app.schoology.com");
    assert!(listed["logins"][0].get("bots").is_none());
    // The daemon's browser is gone, so a field ref from it types nothing.
    let fill = json!({"action":"fill","id":login,"fields":[{"field":"username","ref":"e1"},{"field":"password","ref":"@e2"}]});
    assert_eq!(
        runtime
            .tool(&s, "hexbot_passwords", &fill)
            .await
            .unwrap_err()
            .code,
        4302
    );
    // No event carried it either.
    while let Ok(event) = events.try_recv() {
        assert!(!event.frame.to_string().contains(secret));
    }
    // A login given to other bots is not this bot's to use or manage.
    crate::passwords::save(h, "alice", &json!({"id":login,"bots":["fox"]})).unwrap();
    assert!(
        runtime
            .tool(&s, "hexbot_passwords", &json!({"action":"list"}))
            .await
            .unwrap()["logins"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        runtime
            .tool(&s, "hexbot_passwords", &fill)
            .await
            .unwrap_err()
            .code,
        4302
    );
    assert_eq!(
        runtime
            .tool(
                &s,
                "hexbot_passwords",
                &json!({"action":"share","id":login,"bots":null})
            )
            .await
            .unwrap_err()
            .code,
        4210
    );
    runtime.shutdown().await;
}
