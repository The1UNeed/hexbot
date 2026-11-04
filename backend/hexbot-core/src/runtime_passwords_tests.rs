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
    assert_eq!(listed["items"][0]["site"], "app.schoology.com");
    assert!(listed["items"][0].get("bots").is_none());
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
            .unwrap()["items"]
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

#[tokio::test]
async fn a_bot_runs_commands_with_keys_it_never_sees() {
    let (home, runtime, hub) = setup();
    let h = home.path();
    db::open(h)
        .unwrap()
        .execute_batch("INSERT INTO bots(name,owner_id) VALUES('fox','alice');")
        .unwrap();
    fs::write(
        h.join("profiles/owl/config.yaml"),
        "model:\n  provider: openai\n  default: fixture\ntools:\n  enabled_toolsets: []\ncomputer_use:\n  command: /bin/sh\n",
    )
    .unwrap();
    let id = open(&runtime).await;
    let s = runtime.sessions.lock().unwrap()["first"].clone();
    let tool = |args: Value| {
        let runtime = runtime.clone();
        let s = s.clone();
        async move { runtime.tool(&s, "hexbot_passwords", &args).await }
    };
    let mut events = hub.subscribe();
    let next_card = |events: &mut tokio::sync::broadcast::Receiver<_>| {
        let events = events.resubscribe();
        async move {
            let mut events = events;
            tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    let event: crate::events::Event = events.recv().await.unwrap();
                    if event.frame["params"]["type"] == "approval.request" {
                        break event.frame["params"]["payload"].clone();
                    }
                }
            })
            .await
            .unwrap()
        }
    };
    // The API key card: the user types the key; the bot gets its variable.
    let card = next_card(&mut events);
    let asked = tokio::spawn(tool(json!({
        "action":"ask","kind":"api_key","title":"OpenAI","url":"https://platform.openai.com/api-keys"
    })));
    let card = card.await;
    assert_eq!(card["command"], "Add your OpenAI API key");
    assert_eq!(card["form"]["kind"], "api_key");
    assert_eq!(card["form"]["env"], "OPENAI_API_KEY");
    assert_eq!(card["form"]["site"], "platform.openai.com");
    let respond = |extra: Value| {
        let mut p = json!({"session_id":id,"request_id":card["request_id"],"choice":"once"});
        p.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        let runtime = runtime.clone();
        async move { runtime.call("alice", "approval.respond", &p).await.unwrap() }
    };
    assert_eq!(respond(json!({"key":"  "})).await.unwrap_err().code, 4202);
    let secret = "sk-proj-never-seen-0123456789";
    respond(json!({"key":secret})).await.unwrap();
    let saved = asked.await.unwrap().unwrap();
    assert_eq!(saved["kind"], "api_key");
    assert_eq!(saved["env"], "OPENAI_API_KEY");
    assert!(saved["note"].as_str().unwrap().contains("$OPENAI_API_KEY"));
    assert!(!saved.to_string().contains(secret));
    let api = saved["id"].as_str().unwrap().to_owned();
    assert_eq!(
        crate::passwords::secret(h, "alice", &api, "key").unwrap(),
        secret
    );

    // A new SSH key: the bot gets its public half only.
    let key = tool(json!({"action":"generate","title":"GitHub"}))
        .await
        .unwrap();
    assert!(
        key["public_key"]
            .as_str()
            .unwrap()
            .starts_with("ssh-ed25519 ")
    );
    assert!(!key.to_string().contains("PRIVATE KEY"));
    let ssh = key["id"].as_str().unwrap().to_owned();
    let items = tool(json!({"action":"list"})).await.unwrap()["items"].clone();
    assert_eq!(items.as_array().unwrap().len(), 2);
    assert!(!items.to_string().contains(secret));

    // Keys aren't typed into pages, and logins don't go to commands.
    let fill = json!({"action":"fill","id":api,"fields":[{"field":"password","coordinate":[1,1]}]});
    assert_eq!(tool(fill).await.unwrap_err().code, 4202);
    let login =
        crate::passwords::save(h, "alice", &json!({"url":"https://x.com","password":"p"})).unwrap();
    let run_login = json!({"action":"run","command":"true","ids":[login["id"]]});
    assert_eq!(tool(run_login).await.unwrap_err().code, 4202);

    // Running asks first, naming the keys and showing the command.
    let card = next_card(&mut events);
    let run = tokio::spawn(tool(json!({
        "action":"run","command":"git push origin main","ids":[ssh, api]
    })));
    let card = card.await;
    let command = card["command"].as_str().unwrap();
    assert!(
        command.contains("GitHub SSH key and OpenAI API key"),
        "{command}"
    );
    assert!(command.ends_with("git push origin main"), "{command}");
    assert!(card.get("form").is_none());
    runtime
        .call(
            "alice",
            "approval.respond",
            &json!({"session_id":id,"request_id":card["request_id"],"choice":"deny"}),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(run.await.unwrap().unwrap_err().code, 4302);

    // A key given to another bot is not this bot's to run with.
    crate::passwords::save(h, "alice", &json!({"id":api,"bots":["fox"]})).unwrap();
    let run = json!({"action":"run","command":"env","ids":[api]});
    assert_eq!(tool(run).await.unwrap_err().code, 4302);
    while let Ok(event) = events.try_recv() {
        assert!(!event.frame.to_string().contains(secret));
    }
    runtime.shutdown().await;
}
