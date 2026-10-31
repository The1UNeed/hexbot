use super::*;

#[tokio::test]
async fn a_bot_signs_in_with_a_password_it_never_sees() {
    use std::os::unix::fs::PermissionsExt;
    let (home, runtime, hub) = setup();
    let h = home.path();
    db::open(h)
        .unwrap()
        .execute_batch("INSERT INTO bots(name,owner_id) VALUES('fox','alice');")
        .unwrap();
    // agent-browser, faked: it logs its arguments, keeps what batch typed,
    // and a page script reads it all back.
    let (page, argv, typed) = (h.join("page"), h.join("argv.jsonl"), h.join("typed"));
    fs::write(&page, "https://app.schoology.com/login").unwrap();
    fs::write(&typed, "").unwrap();
    let browser = h.join("agent-browser");
    fs::write(
        &browser,
        format!(
            r#"#!/usr/bin/env node
const fs=require('node:fs'),a=process.argv.slice(2),at=a.indexOf('--disable-quic'),verb=a[at+1];
fs.appendFileSync({argv},JSON.stringify(a)+'\n');
const out=v=>console.log(JSON.stringify(v));
if(verb==='get')out({{success:true,data:{{url:fs.readFileSync({page},'utf8')}}}});
else if(verb==='batch'){{const input=fs.readFileSync(0,'utf8');fs.appendFileSync({typed},input);out(JSON.parse(input).map(c=>({{command:c,success:true,result:{{filled:c[1]}}}})));}}
else if(verb==='eval')out({{success:true,data:{{result:fs.readFileSync({typed},'utf8')}}}});
else out({{success:true,data:{{snapshot:'- textbox "Password" [ref=e2]'}}}});
"#,
            argv = json!(argv),
            page = json!(page),
            typed = json!(typed),
        ),
    )
    .unwrap();
    fs::set_permissions(&browser, fs::Permissions::from_mode(0o755)).unwrap();
    fs::write(
        h.join("profiles/owl/config.yaml"),
        format!(
            "model:\n  provider: openai\n  default: fixture\ntools:\n  enabled_toolsets: [browser]\nbrowser:\n  command: {}\n",
            browser.display()
        ),
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
    let fill = json!({"action":"fill","id":login,"fields":[{"field":"username","ref":"e1"},{"field":"password","ref":"@e2"}]});
    // Nothing is open yet.
    assert_eq!(
        runtime
            .tool(&s, "hexbot_passwords", &fill)
            .await
            .unwrap_err()
            .code,
        4204
    );
    runtime
        .tool(&s, "browser_snapshot", &json!({}))
        .await
        .unwrap();
    // Another site's page gets nothing.
    fs::write(&page, "https://app.schoology.com.evil.io/login").unwrap();
    let refused = runtime
        .tool(&s, "hexbot_passwords", &fill)
        .await
        .unwrap_err();
    assert_eq!(refused.code, 4302, "{}", refused.message);
    assert_eq!(fs::read_to_string(&typed).unwrap(), "");
    fs::write(&page, "https://app.schoology.com/login?next=home").unwrap();
    let filled = runtime.tool(&s, "hexbot_passwords", &fill).await.unwrap();
    assert_eq!(filled["filled"], "username and password");
    assert!(!filled.to_string().contains(secret));
    assert!(fs::read_to_string(&typed).unwrap().contains(secret));
    // Never on a command line, and a page script reading it back gets dots.
    assert!(!fs::read_to_string(&argv).unwrap().contains(secret));
    let read_back = runtime
        .tool(
            &s,
            "browser_console",
            &json!({"expression":"document.forms[0].password.value"}),
        )
        .await
        .unwrap();
    assert!(!read_back.to_string().contains(secret), "{read_back}");
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
