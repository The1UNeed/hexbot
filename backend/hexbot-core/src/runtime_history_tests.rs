use super::*;

#[tokio::test]
async fn history_cursor_replaces_the_snapshot_after_one_chat_forks() {
    let (home, runtime, _) = setup();
    let h = home.path();
    db::open(h).unwrap().execute_batch("UPDATE sections SET title='Dreams' WHERE id='first'; INSERT INTO dreams(id,bot,started_at,status,summary) VALUES('d','owl',1,'complete','REPORT');").unwrap();
    let raw = format!(
        "{}\n{}\n{}\n",
        json!({"type":"session","version":3,"id":"first","cwd":home.workspace()}),
        json!({"type":"message","id":"report","parentId":null,"message":{"role":"assistant","content":"REPORT","timestamp":1000}}),
        json!({"type":"message","id":"human","parentId":"report","message":{"role":"user","content":"Keep me","timestamp":2000}})
    );
    fs::write(
        store::session_dir(h, "first")
            .unwrap()
            .join("conversation.jsonl"),
        &raw,
    )
    .unwrap();
    let first = runtime
        .call("alice", "hexbot.sections.open", &json!({"id":"first"}))
        .await
        .unwrap()
        .unwrap();
    let cursor = first["history_cursor"].as_str().unwrap();
    assert_eq!(first["messages"].as_array().unwrap().len(), 2);
    // The active source is still the chat. Closing lets canonical lookup fork it.
    assert_eq!(
        crate::catalog::chat_section(h, "alice", "owl").unwrap()["id"],
        "first"
    );
    runtime.close_stored("alice", "first").await.unwrap();
    let chat = crate::catalog::chat_section(h, "alice", "owl").unwrap();
    assert_ne!(chat["id"], "first");
    let error = runtime
        .call(
            "alice",
            "hexbot.sections.open",
            &json!({"id":"first","history_cursor":cursor}),
        )
        .await
        .unwrap()
        .unwrap_err();
    assert_eq!(error.code, 4002);
    assert!(error.message.contains(chat["id"].as_str().unwrap()));
    let replacement = runtime
        .call(
            "alice",
            "hexbot.sections.open",
            &json!({"id":chat["id"],"history_cursor":cursor}),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(replacement["history_delta"], false);
    assert_eq!(replacement["messages"].as_array().unwrap().len(), 2);
    assert!(
        replacement["messages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["text"] == "Keep me")
    );
    assert!(
        replacement["messages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["text"] == "REPORT" && m["dream"] == true)
    );
    assert_ne!(replacement["history_cursor"], cursor);
    // A copied row_id is still the same displayed message, but belongs to a new cursor.
    let replacement_cursor = replacement["history_cursor"].as_str().unwrap();
    let id = chat["id"].as_str().unwrap();
    store::append(
        h,
        id,
        json!({"role":"assistant","text":"New report","dream":true}),
    )
    .unwrap();
    let appended = runtime.call("alice", "session.history", &json!({"session_id":replacement["section"]["live_session_id"],"history_cursor":replacement_cursor})).await.unwrap().unwrap();
    assert_eq!(appended["history_delta"], true);
    assert_eq!(appended["messages"].as_array().unwrap().len(), 1);
    assert_eq!(appended["messages"][0]["text"], "New report");
    runtime.shutdown().await;
    drop(runtime);
    let runtime = Runtime::new(h.into(), EventHub::new(), h.join("pi.cjs")).unwrap();
    let reopened = runtime
        .call(
            "alice",
            "hexbot.sections.open",
            &json!({"id":id,"history_cursor":appended["history_cursor"]}),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(reopened["history_delta"], true);
    assert_eq!(reopened["messages"], json!([]));
    assert_eq!(
        fs::read_to_string(h.join("runtime/sessions/first/conversation.jsonl")).unwrap(),
        raw
    );
    runtime.shutdown().await;
}

/// A client that kept a section's history sends `history_cursor` and gets only the
/// rows appended since; after any rewrite, or with a cursor it cannot use, it gets
/// the whole history again.
#[tokio::test]
async fn sections_open_sends_only_new_history_after_a_cursor() {
    let (home, runtime, _) = setup();
    let open = |cursor: Option<&str>| {
        let mut params = json!({"id":"first"});
        if let Some(cursor) = cursor {
            params["history_cursor"] = json!(cursor);
        }
        let runtime = runtime.clone();
        async move {
            runtime
                .call("alice", "hexbot.sections.open", &params)
                .await
                .unwrap()
                .unwrap()
        }
    };
    let texts = |opened: &Value| {
        opened["messages"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m["text"].as_str().unwrap().to_owned())
            .collect::<Vec<_>>()
    };
    for text in ["one", "two"] {
        store::append(home.path(), "first", json!({"role":"user","text":text})).unwrap();
    }
    let first = open(None).await;
    assert_eq!(first["history_delta"], false);
    assert_eq!(texts(&first), ["one", "two"]);
    let cursor = first["history_cursor"].as_str().unwrap().to_owned();

    let same = open(Some(&cursor)).await;
    assert_eq!(same["history_delta"], true);
    assert!(texts(&same).is_empty());
    assert_eq!(same["history_cursor"], cursor.as_str());

    store::append(home.path(), "first", json!({"role":"user","text":"three"})).unwrap();
    let appended = open(Some(&cursor)).await;
    assert_eq!(appended["history_delta"], true);
    assert_eq!(texts(&appended), ["three"]);
    let cursor = appended["history_cursor"].as_str().unwrap().to_owned();

    // An edited row the client already holds: everything again.
    store::open(home.path())
        .unwrap()
        .execute(
            "UPDATE native_messages SET message_json=json_set(message_json,'$.text','uno') WHERE session_id='first' AND seq=1",
            [],
        )
        .unwrap();
    let rewritten = open(Some(&cursor)).await;
    assert_eq!(rewritten["history_delta"], false);
    assert_eq!(texts(&rewritten), ["uno", "two", "three"]);
    let cursor = rewritten["history_cursor"].as_str().unwrap().to_owned();

    // Deleting an already displayed row also replaces the whole snapshot.
    store::open(home.path())
        .unwrap()
        .execute(
            "DELETE FROM native_messages WHERE session_id='first' AND seq=2",
            [],
        )
        .unwrap();
    let deleted = open(Some(&cursor)).await;
    assert_eq!(deleted["history_delta"], false);
    assert_eq!(texts(&deleted), ["uno", "three"]);
    let cursor = deleted["history_cursor"].as_str().unwrap().to_owned();

    // A branch switch hides a row the client holds.
    let conn = store::open(home.path()).unwrap();
    conn.execute(
        "INSERT INTO native_pi_journal(journal_id,session_id,raw_json,entry_id,projection_seq) VALUES('j2','first','{}','e2',1)",
        [],
    )
    .unwrap();
    assert_eq!(open(Some(&cursor)).await["history_delta"], true);
    conn.execute(
        "UPDATE native_pi_journal SET active=0 WHERE journal_id='j2'",
        [],
    )
    .unwrap();
    let switched = open(Some(&cursor)).await;
    assert_eq!(switched["history_delta"], false);
    assert_eq!(texts(&switched), ["three"]);

    for stale in [
        "garbage",
        "0:99",
        "-1:1",
        "v1:first:1:-1",
        "v1:first:1:99",
        "v2:first:1:1",
    ] {
        let full = open(Some(stale)).await;
        assert_eq!(full["history_delta"], false, "{stale}");
        assert_eq!(texts(&full), ["three"]);
    }

    // After a reply, the open section asks its live session for what is new.
    let cursor = switched["history_cursor"].as_str().unwrap().to_owned();
    store::append(
        home.path(),
        "first",
        json!({"role":"assistant","text":"four"}),
    )
    .unwrap();
    let live = switched["section"]["live_session_id"].clone();
    let history = runtime
        .call(
            "alice",
            "session.history",
            &json!({"session_id":live,"history_cursor":cursor}),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(history["history_delta"], true);
    assert_eq!(texts(&history), ["four"]);
    let all = runtime
        .call("alice", "session.history", &json!({"session_id":live}))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(texts(&all), ["three", "four"]);
    assert_eq!(all["history_delta"], false);
    assert_eq!(same["busy"], false);
    assert_eq!(same["pending_requests"], json!([]));
    runtime.shutdown().await;
}
