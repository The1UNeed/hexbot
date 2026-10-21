//! Actual pinned Pi preflights, with lifecycle hooks widening valid boundaries.
use super::*;
use axum::{Json, Router, extract::State, routing::post};
use std::{future::Future, sync::Arc};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::{Semaphore, mpsc},
};

#[derive(Clone)]
struct Provider {
    requests: mpsc::UnboundedSender<Value>,
    release: Arc<Semaphore>,
}
async fn complete(
    State(provider): State<Provider>,
    Json(body): Json<Value>,
) -> ([(&'static str, &'static str); 1], String) {
    provider.requests.send(body).unwrap();
    provider.release.acquire().await.unwrap().forget();
    let chunk = json!({"id":"preflight","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{"role":"assistant","content":"finished"},"finish_reason":null}]});
    let end = json!({"id":"preflight","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]});
    (
        [("content-type", "text/event-stream")],
        format!("data: {chunk}\n\ndata: {end}\n\ndata: [DONE]\n\n"),
    )
}
async fn bounded<T>(future: impl Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(10), future)
        .await
        .expect("Pi lifecycle barrier")
}
async fn held(listener: &TcpListener) -> TcpStream {
    let (mut socket, _) = bounded(listener.accept()).await.unwrap();
    let mut marker = [0; 5];
    bounded(socket.read_exact(&mut marker)).await.unwrap();
    assert_eq!(&marker, b"held\n");
    socket
}
#[derive(Clone, Copy, Debug)]
enum Kind {
    Hidden,
    NormalFollowUp,
    Normal,
    IdleSteer,
    BusySteer,
}
#[derive(Clone, Copy, Default)]
struct Options {
    input_hook: bool,
    disconnect: bool,
    reject: bool,
    close: bool,
    second_stop: bool,
    no_stop: bool,
    old_start: bool,
}

async fn late_preflight(kind: Kind, options: Options) {
    let home = setup();
    let old_run = matches!(kind, Kind::Hidden | Kind::NormalFollowUp | Kind::BusySteer);
    let settled_hook = old_run && !options.input_hook && !options.old_start;
    let input_hook = options.input_hook
        || options.old_start
        || matches!(kind, Kind::Normal | Kind::IdleSteer | Kind::BusySteer);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (requests, mut received) = mpsc::unbounded_channel();
    let release = Arc::new(Semaphore::new(0));
    let app = Router::new()
        .route("/v1/chat/completions", post(complete))
        .with_state(Provider {
            requests,
            release: release.clone(),
        });
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    fs::create_dir_all(home.path().join("profiles/owl/pi")).unwrap();
    fs::write(
        home.path().join("profiles/owl/pi/settings.json"),
        r#"{"images":{"autoResize":false}}"#,
    )
    .unwrap();
    fs::write(home.path().join("profiles/owl/config.yaml"), format!("model:\n  provider: lmstudio\n  default: test-model\n  api_key: fixture\n  base_url: http://{address}/v1\nmodel_overrides:\n  lmstudio:\n    test-model:\n      supports_vision: true\ntools:\n  enabled_toolsets: []\n")).unwrap();
    let settled = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let input = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let start = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let extension = home.path().join("preflight-barriers.mjs");
    fs::write(
        &extension,
        format!(
            r#"import net from 'node:net';
import fs from 'node:fs';
const hold = port => new Promise(resolve => {{
  const socket = net.connect(port, '127.0.0.1', () => socket.write('held\n'));
  socket.once('data', () => {{socket.end(); resolve();}});
}});
export default function(pi) {{
  fs.appendFileSync({}, process.pid + '\n');
  let starts = 0, settlements = 0, inputs = 0;
  pi.on('agent_settled', async () => {{if ({} && ++settlements === 1) await hold({});}});
  pi.on('input', async event => {{
    if (!event.text.startsWith('late result')) return;
    if ({input_hook} && ++inputs === 1) await hold({});
    // Force Pi itself to reject normalization after the held preflight.
    if ({}) return {{action:'transform', text:null}};
  }});
  pi.on('agent_start', async () => {{if (!{} && (++starts === {} || ({} && starts === 1))) await hold({});}});
}}
"#,
            json!(home.path().join("pi-pids")),
            settled_hook,
            settled.local_addr().unwrap().port(),
            input.local_addr().unwrap().port(),
            options.reject,
            options.reject,
            if old_run { 2 } else { 1 },
            options.old_start,
            start.local_addr().unwrap().port()
        ),
    )
    .unwrap();
    let executable = home.path().join("preflight-pi.sh");
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
    let live = opened["section"]["live_session_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let mut initial = None;
    let mut old_settled = None;
    let mut old_started = None;
    if old_run {
        runtime
            .call(
                "alice",
                "prompt.submit",
                &json!({"session_id":live,"text":"old run"}),
            )
            .await
            .unwrap()
            .unwrap();
        if options.old_start {
            old_started = Some(held(&start).await);
        } else {
            initial = Some(bounded(received.recv()).await.unwrap());
        }
        if settled_hook {
            release.add_permits(1);
            old_settled = Some(held(&settled).await);
        }
    }
    let image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
    let mut uploads = vec![];
    let mut files = vec![];
    if !matches!(kind, Kind::IdleSteer | Kind::BusySteer) {
        for (method, params) in [
            (
                "image.attach_bytes",
                json!({"session_id":live,"content_base64":image,"filename":"pixel.png"}),
            ),
            (
                "file.attach",
                json!({"session_id":live,"name":"note.txt","data_url":"data:text/plain;base64,b3duZWQgZmlsZQ=="}),
            ),
        ] {
            let upload = runtime
                .call("alice", method, &params)
                .await
                .unwrap()
                .unwrap();
            uploads.push(upload["id"].clone());
            files.push(PathBuf::from(upload["path"].as_str().unwrap()));
        }
    }
    let mut submission = Some({
        let (runtime, live) = (runtime.clone(), live.clone());
        tokio::spawn(async move {
            let (method, params) = if matches!(kind, Kind::IdleSteer | Kind::BusySteer) {
                (
                    "session.steer",
                    json!({"session_id":live,"text":"late result"}),
                )
            } else {
                (
                    "prompt.submit",
                    json!({"session_id":live,"text":"late result","queued":old_run,"display_kind":if matches!(kind, Kind::Hidden) {"hidden"} else {"normal"},"attachments":uploads}),
                )
            };
            runtime.call("alice", method, &params).await.unwrap()
        })
    });
    let mut input_held = if input_hook {
        Some(held(&input).await)
    } else {
        None
    };
    bounded(async {
        loop {
            let count: i64 = runtime_store::open(home.path())
                .unwrap()
                .query_row(
                    "SELECT COUNT(*) FROM native_prompt_intents WHERE text LIKE 'late result%'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            if count == 1 {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await;
    // set_session_name orders behind the input's actual transport enqueue.
    runtime
        .call(
            "alice",
            "session.title",
            &json!({"session_id":live,"title":"preflight enqueued"}),
        )
        .await
        .unwrap()
        .unwrap();
    if options.disconnect {
        let caller = submission.take().unwrap();
        caller.abort();
        assert!(caller.await.unwrap_err().is_cancelled());
    }
    if options.old_start {
        let params = json!({"session_id":live});
        let stop = runtime.call("alice", "session.interrupt", &params);
        tokio::pin!(stop);
        assert!(futures_util::poll!(stop.as_mut()).is_pending());
        input_held
            .as_mut()
            .unwrap()
            .write_all(b"release")
            .await
            .unwrap();
        input_held = None;
        let ack = bounded(submission.take().unwrap()).await.unwrap().unwrap();
        assert_eq!(ack["status"], "submitted");
        let busy = runtime
            .call(
                "alice",
                "prompt.submit",
                &json!({"session_id":live,"text":"Stop still owns this operation"}),
            )
            .await
            .unwrap()
            .unwrap_err();
        assert_eq!(busy.code, 4002);
        old_started
            .as_mut()
            .unwrap()
            .write_all(b"release")
            .await
            .unwrap();
        bounded(stop).await.unwrap().unwrap();
    } else if !options.no_stop {
        runtime
            .call("alice", "session.interrupt", &json!({"session_id":live}))
            .await
            .unwrap()
            .unwrap();
    }
    if options.close {
        runtime
            .call("alice", "session.close", &json!({"session_id":live}))
            .await
            .unwrap()
            .unwrap();
        let mut byte = [0];
        assert_eq!(
            bounded(input_held.as_mut().unwrap().read(&mut byte))
                .await
                .unwrap(),
            0
        );
        runtime.shutdown().await;
        server.abort();
        return;
    }
    if let Some(socket) = &mut old_settled {
        socket.write_all(b"release").await.unwrap();
    }
    if let Some(socket) = &mut input_held {
        socket.write_all(b"release").await.unwrap();
    }
    // The caller may have disconnected, but the input still owns its preflight.
    // A rejected input has no subsequent agent_start or user projection.
    if let Some(submission) = submission.take() {
        let ack = bounded(submission).await.unwrap();
        if options.reject {
            assert!(ack.is_err(), "{ack:?}");
        } else {
            assert_eq!(
                ack.unwrap()["status"],
                if matches!(kind, Kind::IdleSteer | Kind::BusySteer) {
                    "queued"
                } else {
                    "submitted"
                }
            );
        }
    }
    if !options.reject {
        let mut started = held(&start).await;
        let before_projection = runtime
            .call("alice", "session.status", &json!({"session_id":live}))
            .await
            .unwrap();
        // Release the scheduled barrier even in the exact-base negative control.
        // Holding it until an old warning would turn a repair into a deadlock.
        if options.second_stop {
            let params = json!({"session_id":live});
            let stop = runtime.call("alice", "session.interrupt", &params);
            tokio::pin!(stop);
            assert!(futures_util::poll!(stop.as_mut()).is_pending());
            started.write_all(b"release").await.unwrap();
            bounded(stop).await.unwrap().unwrap();
        } else {
            started.write_all(b"release").await.unwrap();
        }
        assert_eq!(
            before_projection.unwrap()["status"],
            "working",
            "accepted started input must own the new operation: {kind:?}"
        );
        if !options.second_stop {
            let busy = runtime
                .call(
                    "alice",
                    "prompt.submit",
                    &json!({"session_id":live,"text":"too early owner"}),
                )
                .await
                .unwrap()
                .unwrap_err();
            assert_eq!(busy.code, 4002);
            let context = loop {
                let context = bounded(received.recv()).await.unwrap();
                let users = context["messages"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter(|m| m["role"] == "user")
                    .collect::<Vec<_>>();
                if runtime_store::text(&users.last().unwrap()["content"]).starts_with("late result")
                {
                    break context;
                }
                assert!(options.old_start && initial.is_none());
                assert_eq!(
                    runtime_store::text(&users.last().unwrap()["content"]),
                    "old run"
                );
                initial = Some(context);
            };
            let users = context["messages"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|m| m["role"] == "user")
                .collect::<Vec<_>>();
            assert_eq!(users.len(), if old_run { 2 } else { 1 }, "{context}");
            let content = &users.last().unwrap()["content"];
            assert!(runtime_store::text(content).starts_with("late result"));
            if !files.is_empty() {
                assert!(runtime_store::text(content).contains("Attached files:"));
                assert!(
                    content
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|c| c["type"] == "image_url"
                            && c["image_url"]["url"] == format!("data:image/png;base64,{image}")),
                    "{content}"
                );
            }
            if let Some(initial) = initial {
                assert_eq!(initial["messages"][0], context["messages"][0]);
                assert_eq!(initial["tools"], context["tools"]);
            }
        }
        release.add_permits(32);
        bounded(async {
            loop {
                let event = events.recv().await.unwrap().frame["params"].clone();
                assert_ne!(event["type"], "warning", "{event}");
                if event["type"] == "message.complete" {
                    let consumed: i64 = runtime_store::open(home.path()).unwrap().query_row("SELECT COUNT(*) FROM native_prompt_intents WHERE text LIKE 'late result%' AND consumed_by IS NOT NULL", [], |r| r.get(0)).unwrap();
                    let status = runtime.call("alice", "session.status", &json!({"session_id":live})).await.unwrap().unwrap();
                    if consumed == 1 && status["status"] == "idle" {break;}
                }
            }
        }).await;
        let history = runtime_store::history(home.path(), "section-a").unwrap();
        let late = history
            .iter()
            .filter(|r| {
                r["role"] == "user"
                    && r["text"]
                        .as_str()
                        .is_some_and(|t| t.starts_with("late result"))
            })
            .collect::<Vec<_>>();
        assert_eq!(late.len(), 1, "{history:?}");
        assert_eq!(
            late[0]["display_kind"],
            if matches!(kind, Kind::Hidden) {
                "hidden"
            } else {
                "normal"
            }
        );
        assert!(late[0].get("_input_intent").is_none());
        assert!(files.iter().all(|p| p.exists()));
    } else {
        release.add_permits(32);
        let count: i64 = runtime_store::open(home.path())
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM native_prompt_intents WHERE text LIKE 'late result%'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 0);
    }
    runtime
        .call(
            "alice",
            "prompt.submit",
            &json!({"session_id":live,"text":"fresh owner"}),
        )
        .await
        .unwrap()
        .unwrap();
    let expected_fresh = if options.reject && !files.is_empty() {
        format!("fresh owner\n\nAttached files:\n{}", files[1].display())
    } else {
        "fresh owner".into()
    };
    let mut cancelled_contexts = 0;
    let fresh = loop {
        let context = bounded(received.recv()).await.unwrap();
        let last = runtime_store::text(
            &context["messages"].as_array().unwrap().last().unwrap()["content"],
        );
        if last == expected_fresh {
            break context;
        }
        // A second Stop may race the already scheduled provider request. It
        // still cancels that request before fresh owner work is admitted.
        assert!(
            options.second_stop && last.starts_with("late result"),
            "{context}"
        );
        cancelled_contexts += 1;
        assert_eq!(cancelled_contexts, 1);
    };
    assert_eq!(
        runtime_store::text(&fresh["messages"].as_array().unwrap().last().unwrap()["content"]),
        expected_fresh
    );
    assert_eq!(
        fresh["messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|m| m["role"] == "user"
                && runtime_store::text(&m["content"]).starts_with("late result"))
            .count(),
        usize::from(!options.reject)
    );
    assert_eq!(
        fs::read_to_string(home.path().join("pi-pids"))
            .unwrap()
            .lines()
            .count(),
        1,
        "Stop must keep the same Pi process"
    );
    runtime.shutdown().await;
    server.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires HEXBOT_TEST_PI to the pinned Pi executable; uses a local provider"]
async fn actual_pi_late_original_followups_own_their_started_operation() {
    for kind in [Kind::Hidden, Kind::NormalFollowUp] {
        late_preflight(kind, Options::default()).await;
    }
    late_preflight(
        Kind::Hidden,
        Options {
            input_hook: true,
            ..Options::default()
        },
    )
    .await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires HEXBOT_TEST_PI to the pinned Pi executable; uses a local provider"]
async fn actual_pi_late_normal_and_idle_steer_bind_after_idle_stop() {
    for kind in [Kind::Normal, Kind::IdleSteer] {
        late_preflight(kind, Options::default()).await;
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires HEXBOT_TEST_PI to the pinned Pi executable; uses a local provider"]
async fn actual_pi_late_busy_steer_recovers_its_queued_disposition() {
    late_preflight(Kind::BusySteer, Options::default()).await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires HEXBOT_TEST_PI to the pinned Pi executable; uses a local provider"]
async fn actual_pi_late_original_survives_caller_disconnect_and_another_stop() {
    late_preflight(
        Kind::Hidden,
        Options {
            disconnect: true,
            ..Options::default()
        },
    )
    .await;
    late_preflight(
        Kind::Hidden,
        Options {
            second_stop: true,
            ..Options::default()
        },
    )
    .await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires HEXBOT_TEST_PI to the pinned Pi executable; uses a local provider"]
async fn actual_pi_preflight_rejection_and_close_release_input_ownership() {
    late_preflight(
        Kind::Normal,
        Options {
            reject: true,
            ..Options::default()
        },
    )
    .await;
    late_preflight(
        Kind::Normal,
        Options {
            close: true,
            ..Options::default()
        },
    )
    .await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires HEXBOT_TEST_PI to the pinned Pi executable; uses a local provider"]
async fn actual_pi_started_followup_without_stop_has_its_own_lifetime() {
    late_preflight(
        Kind::Hidden,
        Options {
            no_stop: true,
            ..Options::default()
        },
    )
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires HEXBOT_TEST_PI to the pinned Pi executable; uses a local provider"]
async fn actual_pi_original_preflight_acknowledged_while_stop_owns_old_run() {
    late_preflight(
        Kind::Hidden,
        Options {
            old_start: true,
            ..Options::default()
        },
    )
    .await;
}
