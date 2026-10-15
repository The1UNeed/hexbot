use super::*;
use axum::{Json, Router, extract::State, routing::post};
use std::sync::Arc;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::Semaphore,
};

#[derive(Clone)]
struct Provider {
    requests: tokio::sync::mpsc::UnboundedSender<Value>,
    release: Arc<Semaphore>,
}
async fn complete(
    State(provider): State<Provider>,
    Json(body): Json<Value>,
) -> ([(&'static str, &'static str); 1], String) {
    provider.requests.send(body).unwrap();
    let _permit = provider.release.acquire().await.unwrap();
    let chunk = json!({"id":"duplicate","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{"role":"assistant","content":"finished"},"finish_reason":null}]});
    let end = json!({"id":"duplicate","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]});
    (
        [("content-type", "text/event-stream")],
        format!("data: {chunk}\n\ndata: {end}\n\ndata: [DONE]\n\n"),
    )
}

// Pi 1.0.1 removes queue metadata by text when any user message starts.
// Suspend agent_start before projection, so identical later inputs are already
// acknowledged when the earlier message consumes their metadata. The real
// queues still retain those inputs, and clear_queue clears both queues.
#[tokio::test]
#[ignore = "requires HEXBOT_TEST_PI to the pinned Pi executable; uses a local provider"]
async fn actual_pi_identical_inputs_keep_their_intents_through_repeated_stop() {
    let home = setup();
    // Keep the original image bytes and text stable across first submission
    // and queue replay. Image resizing is covered separately by Pi.
    fs::create_dir_all(home.path().join("profiles/owl/pi")).unwrap();
    fs::write(
        home.path().join("profiles/owl/pi/settings.json"),
        r#"{"images":{"autoResize":false}}"#,
    )
    .unwrap();
    let barrier = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (requests, mut received) = tokio::sync::mpsc::unbounded_channel();
    let release = Arc::new(Semaphore::new(0));
    let app = Router::new()
        .route("/v1/chat/completions", post(complete))
        .with_state(Provider {
            requests,
            release: release.clone(),
        });
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    fs::write(home.path().join("profiles/owl/config.yaml"), format!("model:\n  provider: lmstudio\n  default: test-model\n  api_key: test-key\n  base_url: http://{address}/v1\nmodel_overrides:\n  lmstudio:\n    test-model:\n      supports_vision: true\ntools:\n  enabled_toolsets: []\n")).unwrap();
    let extension = home.path().join("start-barrier.mjs");
    fs::write(
        &extension,
        format!(
            r#"import net from 'node:net';
export default function(pi) {{
  let starts = 0;
  pi.on('agent_start', async () => {{
    if (++starts > 2) return;
    await new Promise(resolve => {{
      const socket = net.connect({}, '127.0.0.1', () => socket.write('start\n'));
      socket.once('data', () => {{ socket.end(); resolve(); }});
    }});
  }});
}}
"#,
            barrier.local_addr().unwrap().port()
        ),
    )
    .unwrap();
    let executable = home.path().join("barrier-pi.sh");
    let quote = |path: &Path| format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"));
    fs::write(
        &executable,
        format!(
            "#!/bin/sh\nexec {} \"$@\" --extension {}\n",
            quote(Path::new(&std::env::var_os("HEXBOT_TEST_PI").unwrap())),
            quote(&extension)
        ),
    )
    .unwrap();
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
    let hub = EventHub::new();
    let mut events = hub.subscribe();
    let runtime = Runtime::new(home.path().into(), hub.clone(), executable).unwrap();
    let opened = open(&runtime, "alice").await;
    let live = &opened["section"]["live_session_id"];
    let image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
    let submit = |queued: bool| {
        let runtime = &runtime;
        async move {
            let upload = runtime
                .call(
                    "alice",
                    "image.attach_bytes",
                    &json!({"session_id":live,"content_base64":image,"filename":"same.png"}),
                )
                .await
                .unwrap()
                .unwrap();
            runtime.call("alice", "prompt.submit", &json!({"session_id":live,"text":"same text","queued":queued,"display_kind":if queued {"hidden"} else {"normal"},"attachments":[upload["id"]]})).await.unwrap().unwrap();
            PathBuf::from(upload["path"].as_str().unwrap())
        }
    };
    let mut uploads = vec![submit(false).await];
    let (mut first, _) = tokio::time::timeout(Duration::from_secs(5), barrier.accept())
        .await
        .unwrap()
        .unwrap();
    let mut marker = [0; 6];
    first.read_exact(&mut marker).await.unwrap();
    assert_eq!(&marker, b"start\n");
    uploads.push(submit(true).await);
    uploads.push(submit(true).await);
    runtime
        .call(
            "alice",
            "session.steer",
            &json!({"session_id":live,"text":"same text"}),
        )
        .await
        .unwrap()
        .unwrap();
    first.write_all(b"release").await.unwrap();
    let initial = tokio::time::timeout(Duration::from_secs(10), received.recv())
        .await
        .unwrap()
        .unwrap();
    runtime
        .call("alice", "session.interrupt", &json!({"session_id":live}))
        .await
        .unwrap()
        .unwrap();

    let next = tokio::time::timeout(Duration::from_secs(5), barrier.accept()).await;
    if next.is_err() {
        let evidence = hub.since("alice", live.as_str().unwrap(), 0);
        release.add_permits(16);
        runtime.shutdown().await;
        server.abort();
        panic!("acknowledged identical inputs were not resumed: {evidence}");
    }
    let (mut second, _) = next.unwrap().unwrap();
    second.read_exact(&mut marker).await.unwrap();
    // Steer admission waits until recovery has acknowledged both hidden inputs.
    // It adds another identical owner input before the second user projection,
    // deterministically losing that steering metadata in Pi too.
    runtime
        .call(
            "alice",
            "session.steer",
            &json!({"session_id":live,"text":"same text"}),
        )
        .await
        .unwrap()
        .unwrap();
    second.write_all(b"release").await.unwrap();
    let recovered = tokio::time::timeout(Duration::from_secs(10), received.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(initial["messages"][0], recovered["messages"][0]);
    assert_eq!(initial["tools"], recovered["tools"]);
    runtime
        .call("alice", "session.interrupt", &json!({"session_id":live}))
        .await
        .unwrap()
        .unwrap();
    release.add_permits(16);
    tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            let event = events.recv().await.unwrap().frame["params"].clone();
            assert_ne!(event["type"], "warning", "{event}");
            if event["type"] == "message.complete" && event["payload"]["text"] == "finished" {
                break;
            }
        }
    })
    .await
    .unwrap();
    // Pi drains steering before each provider request. The first owner steer
    // precedes the first hidden input; the second precedes the remaining one.
    let history = runtime_store::history(home.path(), "section-a").unwrap();
    let users = history
        .iter()
        .filter(|r| r["role"] == "user")
        .collect::<Vec<_>>();
    assert_eq!(users.len(), 5, "{users:?}");
    assert!(users.iter().all(|r| r["text"] == "same text"), "{users:?}");
    assert_eq!(
        users
            .iter()
            .map(|r| r["display_kind"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["normal", "normal", "hidden", "normal", "hidden"]
    );
    for (row, has_image) in users.iter().zip([true, false, true, false, true]) {
        assert_eq!(
            row["content"]
                .as_array()
                .unwrap()
                .iter()
                .any(|c| c["type"] == "image"),
            has_image,
            "{row}"
        );
        if has_image {
            assert!(
                row["content"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|c| c["type"] == "image" && c["data"] == image)
            );
        }
        assert!(row.get("_input_intent").is_none());
    }
    let (count, consumed, unique): (i64, i64, i64) = runtime_store::open(home.path()).unwrap().query_row("SELECT COUNT(*),COUNT(consumed_by),COUNT(DISTINCT consumed_by) FROM native_prompt_intents WHERE session_id='section-a'", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap();
    assert_eq!((count, consumed, unique), (5, 5, 5));
    runtime
        .call(
            "alice",
            "prompt.submit",
            &json!({"session_id":live,"text":"fresh owner"}),
        )
        .await
        .unwrap()
        .unwrap();
    let final_context = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let request = received.recv().await.unwrap();
            if runtime_store::text(
                &request["messages"].as_array().unwrap().last().unwrap()["content"],
            ) == "fresh owner"
            {
                break request;
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(
        final_context["messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|m| m["role"] == "user" && runtime_store::text(&m["content"]) == "same text")
            .count(),
        5,
        "provider context: {}",
        final_context["messages"]
    );
    assert!(uploads.iter().all(|path| path.exists()));
    let images = final_context["messages"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|m| m["content"].as_array().into_iter().flatten())
        .filter(|c| c["type"] == "image_url")
        .collect::<Vec<_>>();
    assert_eq!(images.len(), 3);
    assert!(
        images
            .iter()
            .all(|c| c["image_url"]["url"] == format!("data:image/png;base64,{image}"))
    );
    runtime.shutdown().await;
    server.abort();
}
