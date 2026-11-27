use axum::{
    Router,
    extract::State,
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
};
use hexbot_core::{db, providers, server::App, settings};
use serde_json::{Value, json};
use std::{
    fs,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::sync::Mutex;

mod support;

async fn start_mock_server(router: Router) -> (String, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let handle = tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    (format!("http://{addr}"), handle)
}

async fn wait_resolved_event(
    events: &mut tokio::sync::broadcast::Receiver<hexbot_core::events::Event>,
) -> Value {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let frame = events.recv().await.unwrap().frame;
            if frame["params"]["type"] == "hexbot.bots.changed"
                && frame["params"]["payload"]["resolved_incidents"].is_array()
            {
                return frame["params"]["payload"].clone();
            }
        }
    })
    .await
    .unwrap_or_else(|_| panic!("missing resolved hexbot.bots.changed event"))
}

async fn app_with_pi(script: &str) -> (support::TestHome, Arc<App>) {
    let home = support::TestHome::new();
    let pi = home.path().join("fake-pi.cjs");
    fs::write(&pi, script).unwrap();
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
    (home, app)
}

async fn record_dream_incident(
    home: &std::path::Path,
    bot: &str,
    section_id: &str,
    text: &str,
    provider: &str,
) -> Value {
    hexbot_core::runtime_store::open(home)
        .unwrap()
        .execute(
            "INSERT OR IGNORE INTO native_sessions(stored_id,owner,bot,prompt,options) VALUES(?,'local',?,'','{}')",
            rusqlite::params![section_id, bot],
        )
        .unwrap();
    settings::record_incident(
        home,
        bot,
        "turn_failed",
        text,
        &json!({"section_id": section_id, "provider": provider}),
    )
    .unwrap()
}

#[test]
fn quota_error_classification_matches_provider_limits_and_excludes_internal_or_other_errors() {
    for positive in [
        "Codex error: The usage limit has been reached",
        "429 {\"error\":\"Rate limit reached\"}",
        "HTTP 402 Payment Required: Insufficient credits",
        "You exceeded your current quota, please check your plan and billing details.",
        "Your credit balance is too low to access the Anthropic API.",
        "insufficient_quota",
        "RESOURCE_EXHAUSTED: quota exceeded",
        "Insufficient balance. Please top up your account.",
        "billing hard limit has been reached",
        "OpenRouter error (402): More credits are required",
    ] {
        assert!(
            settings::is_quota_error(positive),
            "expected quota error: {positive}"
        );
    }

    for negative in [
        "",
        "Fixture provider failed",
        "The turn was interrupted",
        "Configured turn limit (50) reached",
        "bot exceeded the turn deadline",
        "This model's maximum context length is 128000 tokens",
        "context_length_exceeded",
        "HTTP 401 Unauthorized: invalid api key",
        "Error code 4290: unexpected payload",
        "Error code 4021: validation failed",
        "See item (429) in list",
        "See item (402) in list",
        "HTTP 500 Internal Server Error",
        "The proposal is 12000 serialized bytes; the dream limit is 10000.",
        "Restricted write/edit exceeds the 1 MiB transport limit",
        "record exceeds byte limit",
    ] {
        assert!(
            !settings::is_quota_error(negative),
            "unexpected quota classification: {negative}"
        );
    }
}

#[tokio::test]
async fn codex_usage_recovery_clears_all_stopped_bots_automatically_and_respects_schedule() {
    let body = Arc::new(Mutex::new(json!({
        "rate_limit": {
            "allowed": false,
            "limit_reached": true,
            "primary_window": {
                "used_percent": 100,
                "reset_at": 1_000_120.0
            }
        },
        "credits": {"has_credits": false, "unlimited": false, "balance": "0"}
    })));
    let hits = Arc::new(AtomicUsize::new(0));

    let router = Router::new().route(
        "/backend-api/wham/usage",
        get({
            let body = body.clone();
            let hits = hits.clone();
            move || {
                let body = body.clone();
                let hits = hits.clone();
                async move {
                    hits.fetch_add(1, Ordering::SeqCst);
                    axum::Json(body.lock().await.clone())
                }
            }
        }),
    );
    let (origin, server) = start_mock_server(router).await;

    let (home, app) = app_with_pi(
        r#"#!/usr/bin/env node
const emit=v=>process.stdout.write(JSON.stringify(v)+'\n');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
const c=JSON.parse(line);emit({type:'response',id:c.id,command:c.type,success:true,data:{}});
if(c.type==='prompt'){emit({type:'agent_start'});emit({type:'message_end',message:{role:'user',content:c.message}});emit({type:'message_end',message:{role:'assistant',provider:'openai-codex',content:[],stopReason:'error',errorMessage:'Codex error: The usage limit has been reached'}});emit({type:'agent_end'});emit({type:'agent_settled'});}
});
"#,
    )
    .await;

    fs::write(
        home.path().join("config.yaml"),
        format!(
            "provider_auth:\n  openai-codex:\n    usage_url: \"{origin}/backend-api/wham/usage\"\n"
        ),
    )
    .unwrap();
    fs::write(
        home.path().join("auth.json"),
        json!({
            "providers": {
                "openai-codex": {
                    "access_token": "codex-token",
                    "expires_at": 4_102_444_800.0
                }
            }
        })
        .to_string(),
    )
    .unwrap();

    for name in ["english", "math"] {
        app.call(
            "local",
            "hexbot.bots.create",
            &json!({"name": name, "provider": "openai-codex", "model": "gpt-5.4", "tools": []}),
        )
        .await
        .unwrap();
    }

    // Both bots fail their 3:00 AM dreams with the Codex usage limit error.
    let err1 = app
        .runtime
        .run_hidden_job("local", "english", "dream-english-1", "dream", &json!({}))
        .await
        .unwrap_err();
    assert!(err1.message.contains("usage limit has been reached"));
    let err2 = app
        .runtime
        .run_hidden_job("local", "math", "dream-math-1", "dream", &json!({}))
        .await
        .unwrap_err();
    assert!(err2.message.contains("usage limit has been reached"));

    // Also insert a legacy pre-upgrade row (provider=NULL, category=NULL) to verify backfill handling.
    db::open(home.path())
        .unwrap()
        .execute(
            "INSERT INTO bot_incidents(id,bot,section_id,kind,text,created_at) VALUES('legacy-codex','math','dream-legacy','turn_failed','Codex error: The usage limit has been reached',1)",
            [],
        )
        .unwrap();

    for name in ["english", "math"] {
        let bot = app
            .call("local", "hexbot.bots.get", &json!({"name": name}))
            .await
            .unwrap()["bot"]
            .clone();
        assert_eq!(bot["status"], "stopped", "{name} should be stopped");
        assert_eq!(bot["status_detail"]["in_chat"], true);
    }

    let mut events = app.events.subscribe();

    // First on-demand check while still limited: hits endpoint once, keeps stopped, records reset_at.
    let res = providers::check_recovery_at(home.path(), &app.events, true, 1_000_000.0)
        .await
        .unwrap();
    assert_eq!(res["checked"], json!(["openai-codex"]));
    assert_eq!(res["resolved"], 0);
    assert_eq!(hits.load(Ordering::SeqCst), 1);

    // 10s later (inside 30s on-demand cooldown): must NOT hit endpoint again.
    let res = providers::check_recovery_at(home.path(), &app.events, true, 1_000_010.0)
        .await
        .unwrap();
    assert_eq!(res["checked"], json!([]));
    assert_eq!(hits.load(Ordering::SeqCst), 1);

    // 60s later on automatic tick (still before reset_at=1_000_120): must NOT hit yet.
    let res = providers::check_recovery_at(home.path(), &app.events, false, 1_000_060.0)
        .await
        .unwrap();
    assert_eq!(res["checked"], json!([]));
    assert_eq!(hits.load(Ordering::SeqCst), 1);

    // Subscription resets at 1_000_120!
    *body.lock().await = json!({
        "rate_limit": {
            "allowed": true,
            "limit_reached": false,
            "primary_window": { "used_percent": 0 }
        },
        "credits": {"has_credits": false, "unlimited": false, "balance": "0"}
    });

    // Automatic tick at reset_at clears ALL bots (including the legacy incident) and broadcasts resolved IDs.
    let res = providers::check_recovery_at(home.path(), &app.events, false, 1_000_120.0)
        .await
        .unwrap();
    assert_eq!(res["checked"], json!(["openai-codex"]));
    assert_eq!(res["resolved"], 3);
    assert_eq!(hits.load(Ordering::SeqCst), 2);

    let changed = wait_resolved_event(&mut events).await;
    assert_eq!(changed["resolved_incidents"].as_array().unwrap().len(), 3);
    let sections = changed["resolved_sections"].as_array().unwrap();
    assert!(sections.contains(&json!("dream-english-1")));
    assert!(sections.contains(&json!("dream-math-1")));
    assert!(sections.contains(&json!("dream-legacy")));

    for name in ["english", "math"] {
        let bot = app
            .call("local", "hexbot.bots.get", &json!({"name": name}))
            .await
            .unwrap()["bot"]
            .clone();
        assert_eq!(bot["status"], "idle", "{name} should recover to idle");
        assert!(bot["status_detail"].is_null());
    }

    // Subsequent check does zero HTTP work when no quota incidents remain.
    let res = providers::check_recovery_at(home.path(), &app.events, true, 1_000_300.0)
        .await
        .unwrap();
    assert_eq!(res["checked"], json!([]));
    assert_eq!(hits.load(Ordering::SeqCst), 2);

    app.shutdown().await;
    server.abort();
}

#[tokio::test]
async fn openrouter_credit_topup_clears_incidents_via_free_endpoints() {
    let total_credits = Arc::new(Mutex::new(5.0_f64));
    let router = Router::new()
        .route(
            "/api/v1/key",
            get(|| async { axum::Json(json!({"data": {"limit": null, "limit_remaining": null}})) }),
        )
        .route(
            "/api/v1/credits",
            get({
                let total_credits = total_credits.clone();
                move || {
                    let total_credits = total_credits.clone();
                    async move {
                        let credits = *total_credits.lock().await;
                        axum::Json(json!({"data": {"total_credits": credits, "total_usage": 5.0}}))
                    }
                }
            }),
        );
    let (origin, server) = start_mock_server(router).await;

    let (home, app) = app_with_pi("#!/usr/bin/env node\n").await;
    fs::write(
        home.path().join("config.yaml"),
        format!("model:\n  provider: openrouter\n  base_url: \"{origin}/api/v1\"\n"),
    )
    .unwrap();
    fs::write(
        home.path().join(".env"),
        "OPENROUTER_API_KEY='sk-or-test'\n",
    )
    .unwrap();
    app.call(
        "local",
        "hexbot.bots.create",
        &json!({"name": "owl", "provider": "openrouter", "model": "openai/gpt-4o-mini", "tools": []}),
    )
    .await
    .unwrap();

    record_dream_incident(
        home.path(),
        "owl",
        "dream-or",
        "HTTP 402 Payment Required: Insufficient credits",
        "openrouter",
    )
    .await;

    assert_eq!(
        app.call("local", "hexbot.bots.get", &json!({"name": "owl"}))
            .await
            .unwrap()["bot"]["status"],
        "stopped"
    );

    // Still $0 remaining -> remains stopped.
    let res = providers::check_recovery_at(home.path(), &app.events, true, 2_000_000.0)
        .await
        .unwrap();
    assert_eq!(res["resolved"], 0);
    assert_eq!(
        app.call("local", "hexbot.bots.get", &json!({"name": "owl"}))
            .await
            .unwrap()["bot"]["status"],
        "stopped"
    );

    // User adds $10 -> now total_credits=15, total_usage=5 -> clears via RPC!
    *total_credits.lock().await = 15.0;
    let res = providers::check_recovery_at(home.path(), &app.events, true, 2_000_040.0)
        .await
        .unwrap();
    assert_eq!(res["resolved"], 1);
    assert_eq!(
        app.call("local", "hexbot.bots.get", &json!({"name": "owl"}))
            .await
            .unwrap()["bot"]["status"],
        "idle"
    );

    app.shutdown().await;
    server.abort();
}

#[tokio::test]
async fn openai_api_probe_uses_responses_endpoint_and_clears_after_adding_funds() {
    #[derive(Clone)]
    struct MockState {
        funded: Arc<Mutex<bool>>,
        last_body: Arc<Mutex<Option<Value>>>,
    }
    let state = MockState {
        funded: Arc::new(Mutex::new(false)),
        last_body: Arc::new(Mutex::new(None)),
    };
    let router = Router::new()
        .route(
            "/v1/responses",
            post(
                |State(s): State<MockState>, axum::Json(payload): axum::Json<Value>| async move {
                    *s.last_body.lock().await = Some(payload);
                    if *s.funded.lock().await {
                        (
                            StatusCode::OK,
                            [("retry-after", "0")],
                            axum::Json(json!({"id": "resp_1"})),
                        )
                            .into_response()
                    } else {
                        (
                            StatusCode::TOO_MANY_REQUESTS,
                            [("retry-after", "120")],
                            axum::Json(json!({"error": {"code": "insufficient_quota"}})),
                        )
                            .into_response()
                    }
                },
            ),
        )
        .with_state(state.clone());
    let (origin, server) = start_mock_server(router).await;

    let (home, app) = app_with_pi("#!/usr/bin/env node\n").await;
    fs::write(
        home.path().join(".env"),
        format!("OPENAI_API_KEY='sk-test'\nOPENAI_BASE_URL='{origin}/v1'\n"),
    )
    .unwrap();
    app.call(
        "local",
        "hexbot.bots.create",
        &json!({"name": "owl", "provider": "openai-api", "model": "gpt-5.4", "tools": []}),
    )
    .await
    .unwrap();
    record_dream_incident(
        home.path(),
        "owl",
        "dream-oai",
        "You exceeded your current quota, please check your plan and billing details.",
        "openai-api",
    )
    .await;
    assert_eq!(
        app.call("local", "hexbot.bots.get", &json!({"name": "owl"}))
            .await
            .unwrap()["bot"]["status"],
        "stopped"
    );

    let res = providers::check_recovery_at(home.path(), &app.events, true, 3_000_000.0)
        .await
        .unwrap();
    assert_eq!(res["resolved"], 0);
    let sent = state.last_body.lock().await.clone().unwrap();
    assert_eq!(sent["model"], "gpt-5.4");
    assert_eq!(sent["max_output_tokens"], 16);
    assert_eq!(sent["store"], false);

    // Paid on-demand check respects future Retry-After (120s), then probes & clears once elapsed.
    *state.funded.lock().await = true;
    let res = providers::check_recovery_at(home.path(), &app.events, true, 3_000_065.0)
        .await
        .unwrap();
    assert_eq!(res["checked"], json!([]));
    assert_eq!(res["resolved"], 0);

    let res = providers::check_recovery_at(home.path(), &app.events, true, 3_000_125.0)
        .await
        .unwrap();
    assert_eq!(res["resolved"], 1);
    assert_eq!(
        app.call("local", "hexbot.bots.get", &json!({"name": "owl"}))
            .await
            .unwrap()["bot"]["status"],
        "idle"
    );

    app.shutdown().await;
    server.abort();
}

#[tokio::test]
async fn successful_turn_clears_cross_bot_quota_incidents_only_for_provider_that_answered() {
    let (home, app) = app_with_pi(
        r#"#!/usr/bin/env node
const emit=v=>process.stdout.write(JSON.stringify(v)+'\n');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
const c=JSON.parse(line);emit({type:'response',id:c.id,command:c.type,success:true,data:{}});
if(c.type==='prompt'){
  const provider=c.message.includes('FALLBACK')?'anthropic':'openai-codex';
  emit({type:'agent_start'});
  emit({type:'message_end',message:{role:'user',content:c.message}});
  emit({type:'message_end',message:{role:'assistant',provider,content:[{type:'text',text:'ok'}],stopReason:'stop'}});
  emit({type:'agent_end'});
  emit({type:'agent_settled'});
}
});
"#,
    )
    .await;

    for name in ["english", "math"] {
        app.call(
            "local",
            "hexbot.bots.create",
            &json!({"name": name, "provider": "openai-codex", "model": "gpt-5.4", "tools": []}),
        )
        .await
        .unwrap();
        record_dream_incident(
            home.path(),
            name,
            &format!("dream-{name}"),
            "Codex error: The usage limit has been reached",
            "openai-codex",
        )
        .await;
    }

    // A turn that succeeded via a different fallback provider (anthropic) must NOT clear Codex incidents.
    let reply = app
        .runtime
        .run_hidden_job("local", "english", "chat-fallback", "FALLBACK", &json!({}))
        .await
        .unwrap();
    assert_eq!(reply, "ok");
    for name in ["english", "math"] {
        assert_eq!(
            app.call("local", "hexbot.bots.get", &json!({"name": name}))
                .await
                .unwrap()["bot"]["status"],
            "stopped"
        );
    }

    let mut events = app.events.subscribe();
    // Now a turn actually succeeds on openai-codex: clears BOTH english's and math's dream incidents!
    let reply = app
        .runtime
        .run_hidden_job("local", "english", "chat-ok", "hello", &json!({}))
        .await
        .unwrap();
    assert_eq!(reply, "ok");

    let changed = wait_resolved_event(&mut events).await;
    assert_eq!(changed["resolved_incidents"].as_array().unwrap().len(), 2);

    for name in ["english", "math"] {
        assert_eq!(
            app.call("local", "hexbot.bots.get", &json!({"name": name}))
                .await
                .unwrap()["bot"]["status"],
            "idle"
        );
    }

    app.shutdown().await;
}

#[tokio::test]
async fn saving_key_or_switching_bot_provider_clears_open_quota_incidents() {
    let (home, app) = app_with_pi("#!/usr/bin/env node\n").await;
    for name in ["english", "math"] {
        app.call(
            "local",
            "hexbot.bots.create",
            &json!({"name": name, "provider": "openai-api", "model": "gpt-5.4", "tools": []}),
        )
        .await
        .unwrap();
        record_dream_incident(
            home.path(),
            name,
            &format!("dream-{name}"),
            "You exceeded your current quota",
            "openai-api",
        )
        .await;
    }

    // Switching only `english` to anthropic resolves `english` while leaving `math` stopped.
    let updated = app
        .call(
            "local",
            "hexbot.bots.update",
            &json!({"name": "english", "provider": "anthropic", "model": "claude-sonnet-4-6"}),
        )
        .await
        .unwrap()["bot"]
        .clone();
    assert_eq!(updated["status"], "idle");
    assert_eq!(
        app.call("local", "hexbot.bots.get", &json!({"name": "math"}))
            .await
            .unwrap()["bot"]["status"],
        "stopped"
    );

    // Updating the OpenAI API key resolves `math` too.
    app.call(
        "local",
        "hexbot.providers.set_key",
        &json!({"provider": "openai-api", "key": "sk-new-funded-key"}),
    )
    .await
    .unwrap();
    assert_eq!(
        app.call("local", "hexbot.bots.get", &json!({"name": "math"}))
            .await
            .unwrap()["bot"]["status"],
        "idle"
    );

    app.shutdown().await;
}

#[tokio::test]
async fn in_flight_recovery_does_not_clear_incident_created_after_check_started() {
    let gate = Arc::new(tokio::sync::Notify::new());
    let arrived = Arc::new(tokio::sync::Notify::new());
    let router = Router::new().route(
        "/backend-api/wham/usage",
        get({
            let gate = gate.clone();
            let arrived = arrived.clone();
            move || {
                let gate = gate.clone();
                let arrived = arrived.clone();
                async move {
                    arrived.notify_one();
                    gate.notified().await;
                    axum::Json(json!({"rate_limit": {"allowed": true, "limit_reached": false}}))
                }
            }
        }),
    );
    let (origin, server) = start_mock_server(router).await;

    let (home, app) = app_with_pi("#!/usr/bin/env node\n").await;
    fs::write(
        home.path().join("config.yaml"),
        format!(
            "provider_auth:\n  openai-codex:\n    usage_url: \"{origin}/backend-api/wham/usage\"\n"
        ),
    )
    .unwrap();
    fs::write(
        home.path().join("auth.json"),
        json!({"providers": {"openai-codex": {"access_token": "tok", "expires_at": 4_102_444_800.0}}})
            .to_string(),
    )
    .unwrap();
    app.call(
        "local",
        "hexbot.bots.create",
        &json!({"name": "english", "provider": "openai-codex", "model": "gpt-5.4", "tools": []}),
    )
    .await
    .unwrap();
    app.call(
        "local",
        "hexbot.bots.create",
        &json!({"name": "math", "provider": "openai-codex", "model": "gpt-5.4", "tools": []}),
    )
    .await
    .unwrap();

    let old = record_dream_incident(
        home.path(),
        "english",
        "dream-old",
        "Codex error: The usage limit has been reached",
        "openai-codex",
    )
    .await;

    let check_home = home.path().to_path_buf();
    let check_events = app.events.clone();
    let check = tokio::spawn(async move {
        providers::check_recovery_at(&check_home, &check_events, true, 4_000_000.0).await
    });

    arrived.notified().await;
    // A brand-new incident lands on `math` AFTER the HTTP check started.
    let newer = record_dream_incident(
        home.path(),
        "math",
        "dream-new",
        "Codex error: The usage limit has been reached",
        "openai-codex",
    )
    .await;
    gate.notify_one();

    let result = check.await.unwrap().unwrap();
    assert_eq!(result["resolved"], 1);

    // `english`'s older incident was cleared; `math`'s newer incident stayed open!
    assert_eq!(
        app.call("local", "hexbot.bots.get", &json!({"name": "english"}))
            .await
            .unwrap()["bot"]["status"],
        "idle"
    );
    let math = app
        .call("local", "hexbot.bots.get", &json!({"name": "math"}))
        .await
        .unwrap()["bot"]
        .clone();
    assert_eq!(math["status"], "stopped");
    assert_ne!(old["id"], newer["id"]);

    app.shutdown().await;
    server.abort();
}

#[tokio::test]
async fn anthropic_api_400_credit_balance_and_deepseek_balance_recover_automatically() {
    let anthropic_funded = Arc::new(Mutex::new(false));
    let deepseek_available = Arc::new(Mutex::new(false));
    let router = Router::new()
        .route(
            "/v1/messages",
            post({
                let funded = anthropic_funded.clone();
                move || {
                    let funded = funded.clone();
                    async move {
                        if *funded.lock().await {
                            (StatusCode::OK, axum::Json(json!({"id": "msg_1"}))).into_response()
                        } else {
                            (
                                StatusCode::BAD_REQUEST,
                                axum::Json(json!({
                                    "type": "error",
                                    "error": {
                                        "type": "invalid_request_error",
                                        "message": "Your credit balance is too low to access the Anthropic API."
                                    }
                                })),
                            )
                                .into_response()
                        }
                    }
                }
            }),
        )
        .route(
            "/user/balance",
            get({
                let available = deepseek_available.clone();
                move || {
                    let available = available.clone();
                    async move {
                        let ok = *available.lock().await;
                        axum::Json(json!({"is_available": ok, "balance_infos": []}))
                    }
                }
            }),
        );
    let (origin, server) = start_mock_server(router).await;

    let (home, app) = app_with_pi("#!/usr/bin/env node\n").await;
    fs::write(
        home.path().join(".env"),
        format!(
            "ANTHROPIC_API_KEY='sk-ant-test'\nANTHROPIC_BASE_URL='{origin}'\nDEEPSEEK_API_KEY='sk-ds-test'\nDEEPSEEK_BASE_URL='{origin}/v1'\n"
        ),
    )
    .unwrap();
    app.call(
        "local",
        "hexbot.bots.create",
        &json!({"name": "claude", "provider": "anthropic", "model": "claude-sonnet-4-6", "tools": []}),
    )
    .await
    .unwrap();
    app.call(
        "local",
        "hexbot.bots.create",
        &json!({"name": "ds", "provider": "deepseek", "model": "deepseek-chat", "tools": []}),
    )
    .await
    .unwrap();

    record_dream_incident(
        home.path(),
        "claude",
        "dream-claude",
        "Your credit balance is too low to access the Anthropic API.",
        "anthropic",
    )
    .await;
    record_dream_incident(
        home.path(),
        "ds",
        "dream-ds",
        "Insufficient balance",
        "deepseek",
    )
    .await;

    // Both still limited on first check.
    let res = providers::check_recovery_at(home.path(), &app.events, true, 5_000_000.0)
        .await
        .unwrap();
    assert_eq!(res["resolved"], 0);
    for name in ["claude", "ds"] {
        assert_eq!(
            app.call("local", "hexbot.bots.get", &json!({"name": name}))
                .await
                .unwrap()["bot"]["status"],
            "stopped"
        );
    }

    // Both funded -> recover on next check after cooldown.
    *anthropic_funded.lock().await = true;
    *deepseek_available.lock().await = true;
    let res = providers::check_recovery_at(home.path(), &app.events, true, 5_000_065.0)
        .await
        .unwrap();
    assert_eq!(res["resolved"], 2);
    for name in ["claude", "ds"] {
        assert_eq!(
            app.call("local", "hexbot.bots.get", &json!({"name": name}))
                .await
                .unwrap()["bot"]["status"],
            "idle"
        );
    }

    app.shutdown().await;
    server.abort();
}

#[tokio::test]
async fn unknown_after_retry_at_clears_retry_at_and_respects_backoff() {
    let mode = Arc::new(Mutex::new("limited"));
    let hits = Arc::new(AtomicUsize::new(0));
    let router = Router::new().route(
        "/v1/responses",
        post({
            let mode = mode.clone();
            let hits = hits.clone();
            move || {
                let mode = mode.clone();
                let hits = hits.clone();
                async move {
                    hits.fetch_add(1, Ordering::SeqCst);
                    match *mode.lock().await {
                        "limited" => (
                            StatusCode::TOO_MANY_REQUESTS,
                            [("retry-after", "120")],
                            axum::Json(json!({"error": {"code": "rate_limit"}})),
                        )
                            .into_response(),
                        _ => (
                            StatusCode::INTERNAL_SERVER_ERROR,
                            axum::Json(json!({"error": "upstream down"})),
                        )
                            .into_response(),
                    }
                }
            }
        }),
    );
    let (origin, server) = start_mock_server(router).await;

    let (home, app) = app_with_pi("#!/usr/bin/env node\n").await;
    fs::write(
        home.path().join(".env"),
        format!("OPENAI_API_KEY='sk-test'\nOPENAI_BASE_URL='{origin}/v1'\n"),
    )
    .unwrap();
    app.call(
        "local",
        "hexbot.bots.create",
        &json!({"name": "owl", "provider": "openai-api", "model": "gpt-5.4", "tools": []}),
    )
    .await
    .unwrap();
    record_dream_incident(
        home.path(),
        "owl",
        "dream-backoff",
        "HTTP 429 rate limit exceeded",
        "openai-api",
    )
    .await;

    // First auto check gets StillLimited with retry_at = t0 + 120.
    let t0 = 6_000_000.0;
    providers::check_recovery_at(home.path(), &app.events, false, t0)
        .await
        .unwrap();
    assert_eq!(hits.load(Ordering::SeqCst), 1);

    // At retry_at (t0 + 120), endpoint returns 500 -> Unknown; clears stale retry_at.
    *mode.lock().await = "error";
    providers::check_recovery_at(home.path(), &app.events, false, t0 + 120.0)
        .await
        .unwrap();
    assert_eq!(hits.load(Ordering::SeqCst), 2);

    // 60s and 300s later: must NOT hammer probe; backoff is 600s for paid probes.
    providers::check_recovery_at(home.path(), &app.events, false, t0 + 180.0)
        .await
        .unwrap();
    providers::check_recovery_at(home.path(), &app.events, false, t0 + 420.0)
        .await
        .unwrap();
    assert_eq!(hits.load(Ordering::SeqCst), 2);

    // At t0 + 120 + 600 = t0 + 720: backoff expired, next probe runs.
    providers::check_recovery_at(home.path(), &app.events, false, t0 + 720.0)
        .await
        .unwrap();
    assert_eq!(hits.load(Ordering::SeqCst), 3);

    app.shutdown().await;
    server.abort();
}

#[tokio::test]
async fn superseded_turn_without_assistant_message_does_not_clear_quota_incidents() {
    let (home, app) = app_with_pi(
        r#"#!/usr/bin/env node
const emit=v=>process.stdout.write(JSON.stringify(v)+'\n');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
const c=JSON.parse(line);emit({type:'response',id:c.id,command:c.type,success:true,data:{}});
if(c.type==='prompt'){
  emit({type:'agent_start'});
  emit({type:'message_end',message:{role:'user',content:c.message}});
  emit({type:'agent_end'});
  emit({type:'agent_settled'});
}
});
"#,
    )
    .await;

    for name in ["english", "math"] {
        app.call(
            "local",
            "hexbot.bots.create",
            &json!({"name": name, "provider": "openai-codex", "model": "gpt-5.4", "tools": []}),
        )
        .await
        .unwrap();
        record_dream_incident(
            home.path(),
            name,
            &format!("dream-{name}"),
            "Codex error: The usage limit has been reached",
            "openai-codex",
        )
        .await;
    }

    // Turn completes with zero assistant messages (no provider answered): must NOT clear Codex incidents!
    let _ = app
        .runtime
        .run_hidden_job("local", "english", "chat-empty", "hello", &json!({}))
        .await
        .unwrap();
    for name in ["english", "math"] {
        assert_eq!(
            app.call("local", "hexbot.bots.get", &json!({"name": name}))
                .await
                .unwrap()["bot"]["status"],
            "stopped"
        );
    }

    app.shutdown().await;
}

#[tokio::test]
async fn unchanged_provider_save_keeps_legacy_incidents_and_profiles_configure_switch_clears_them()
{
    let (home, app) = app_with_pi("#!/usr/bin/env node\n").await;
    app.call(
        "local",
        "hexbot.bots.create",
        &json!({"name": "english", "provider": "openai-api", "model": "gpt-5.4", "tools": []}),
    )
    .await
    .unwrap();
    hexbot_core::runtime_store::open(home.path())
        .unwrap()
        .execute(
            "INSERT OR IGNORE INTO native_sessions(stored_id,owner,bot,prompt,options) VALUES('dream-legacy','local','english','','{}')",
            [],
        )
        .unwrap();
    // Legacy pre-upgrade row with provider = NULL and category = NULL.
    db::open(home.path())
        .unwrap()
        .execute(
            "INSERT INTO bot_incidents(id,bot,section_id,kind,text,created_at,provider,category) VALUES('legacy-oai','english','dream-legacy','turn_failed','You exceeded your current quota',1000,NULL,NULL)",
            [],
        )
        .unwrap();

    // Updating title while sending the unchanged provider (as mobile does on every save) must NOT clear it.
    let updated = app
        .call(
            "local",
            "hexbot.bots.update",
            &json!({"name": "english", "title": "English Tutor", "provider": "openai-api", "model": "gpt-5.4"}),
        )
        .await
        .unwrap()["bot"]
        .clone();
    assert_eq!(updated["status"], "stopped");

    // Switching provider via profiles.configure DOES resolve the old provider's legacy incident.
    app.call(
        "local",
        "profiles.configure",
        &json!({"name": "english", "provider": "anthropic", "model": "claude-sonnet-4-6"}),
    )
    .await
    .unwrap();
    assert_eq!(
        app.call("local", "hexbot.bots.get", &json!({"name": "english"}))
            .await
            .unwrap()["bot"]["status"],
        "idle"
    );

    app.shutdown().await;
}

#[tokio::test]
async fn per_bot_credentials_are_isolated_from_shared_recovery() {
    let (home, app) = app_with_pi(
        r#"#!/usr/bin/env node
const emit=v=>process.stdout.write(JSON.stringify(v)+'\n');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
const c=JSON.parse(line);emit({type:'response',id:c.id,command:c.type,success:true,data:{}});
if(c.type==='prompt'){
  emit({type:'agent_start'});
  emit({type:'message_end',message:{role:'user',content:c.message}});
  emit({type:'message_end',message:{role:'assistant',provider:'openai-codex',content:[{type:'text',text:'ok'}],stopReason:'stop'}});
  emit({type:'agent_end'});
  emit({type:'agent_settled'});
}
});
"#,
    )
    .await;

    fs::write(
        home.path().join("auth.json"),
        json!({"providers": {"openai-codex": {"access_token": "shared-tok", "expires_at": 4_102_444_800.0}}})
            .to_string(),
    )
    .unwrap();
    for name in ["shared_a", "shared_b", "own_bot"] {
        app.call(
            "local",
            "hexbot.bots.create",
            &json!({"name": name, "provider": "openai-codex", "model": "gpt-5.4", "tools": []}),
        )
        .await
        .unwrap();
    }
    // Give `own_bot` its own ChatGPT OAuth account in its profile directory.
    fs::write(
        home.path().join("profiles/own_bot/auth.json"),
        json!({"providers": {"openai-codex": {"access_token": "private-tok", "expires_at": 4_102_444_800.0}}})
            .to_string(),
    )
    .unwrap();

    for name in ["shared_a", "shared_b", "own_bot"] {
        record_dream_incident(
            home.path(),
            name,
            &format!("dream-{name}"),
            "Codex error: The usage limit has been reached",
            "openai-codex",
        )
        .await;
    }

    // `shared_a` completing a turn resolves `shared_a` and `shared_b`, NOT `own_bot`.
    app.runtime
        .run_hidden_job("local", "shared_a", "chat-a", "hi", &json!({}))
        .await
        .unwrap();
    assert_eq!(
        app.call("local", "hexbot.bots.get", &json!({"name": "shared_a"}))
            .await
            .unwrap()["bot"]["status"],
        "idle"
    );
    assert_eq!(
        app.call("local", "hexbot.bots.get", &json!({"name": "shared_b"}))
            .await
            .unwrap()["bot"]["status"],
        "idle"
    );
    assert_eq!(
        app.call("local", "hexbot.bots.get", &json!({"name": "own_bot"}))
            .await
            .unwrap()["bot"]["status"],
        "stopped"
    );

    app.shutdown().await;
}

#[tokio::test]
async fn anthropic_oauth_model_windows_openrouter_rate_limit_moonshot_balance_and_flap_guard() {
    let opus_util = Arc::new(Mutex::new(100.0_f64));
    let kimi_balance = Arc::new(Mutex::new(0.0_f64));
    let router = Router::new()
        .route(
            "/api/oauth/usage",
            get({
                let opus_util = opus_util.clone();
                move || {
                    let opus_util = opus_util.clone();
                    async move {
                        let u = *opus_util.lock().await;
                        axum::Json(json!({
                            "five_hour": {"utilization": 10.0, "resets_at": null},
                            "seven_day": {"utilization": 25.0, "resets_at": null},
                            "seven_day_opus": {"utilization": u, "resets_at": "2099-01-01T00:00:00Z"},
                            "extra_usage": {"is_enabled": false}
                        }))
                    }
                }
            }),
        )
        .route(
            "/v1/key",
            get(|| async { axum::Json(json!({"data": {"limit_remaining": 10.0}})) }),
        )
        .route(
            "/v1/credits",
            get(|| async { axum::Json(json!({"data": {"total_credits": 20.0, "total_usage": 1.0}})) }),
        )
        .route(
            "/v1/users/me/balance",
            get({
                let kimi_balance = kimi_balance.clone();
                move || {
                    let kimi_balance = kimi_balance.clone();
                    async move {
                        let b = *kimi_balance.lock().await;
                        axum::Json(json!({"data": {"available_balance": b}}))
                    }
                }
            }),
        );
    let (origin, server) = start_mock_server(router).await;

    let (home, app) = app_with_pi("#!/usr/bin/env node\n").await;
    fs::write(
        home.path().join("config.yaml"),
        format!(
            "provider_auth:\n  anthropic:\n    usage_url: \"{origin}/api/oauth/usage\"\nmodel:\n  provider: openrouter\n  base_url: \"{origin}/v1\"\n"
        ),
    )
    .unwrap();
    fs::write(
        home.path().join("auth.json"),
        json!({"providers": {"anthropic": {"access_token": "ant-tok", "expires_at": 4_102_444_800.0}}})
            .to_string(),
    )
    .unwrap();
    fs::write(
        home.path().join(".env"),
        format!(
            "OPENROUTER_API_KEY='sk-or-test'\nKIMI_API_KEY='sk-kimi-test'\nKIMI_BASE_URL='{origin}/v1'\n"
        ),
    )
    .unwrap();
    for (name, prov, model) in [
        ("opus", "anthropic", "claude-opus-4-6"),
        ("free_or", "openrouter", "google/gemma-3-27b-it:free"),
        ("kimi", "kimi-coding", "kimi-k2.5"),
    ] {
        app.call(
            "local",
            "hexbot.bots.create",
            &json!({"name": name, "provider": prov, "model": model, "tools": []}),
        )
        .await
        .unwrap();
    }
    record_dream_incident(
        home.path(),
        "opus",
        "dream-opus",
        "Weekly limit reached",
        "anthropic",
    )
    .await;
    // OpenRouter free-model 429 rate limit: NOT a credits error!
    record_dream_incident(
        home.path(),
        "free_or",
        "dream-or-429",
        "HTTP 429 Rate limit exceeded: free-models-per-day",
        "openrouter",
    )
    .await;
    record_dream_incident(
        home.path(),
        "kimi",
        "dream-kimi",
        "Insufficient balance",
        "kimi-coding",
    )
    .await;

    // Opus blocked by seven_day_opus=100, OpenRouter 429 NOT falsely cleared by $19 credits, Kimi balance=0.
    let res = providers::check_recovery_at(home.path(), &app.events, true, 7_000_000.0)
        .await
        .unwrap();
    assert_eq!(res["resolved"], 0);
    for name in ["opus", "free_or", "kimi"] {
        assert_eq!(
            app.call("local", "hexbot.bots.get", &json!({"name": name}))
                .await
                .unwrap()["bot"]["status"],
            "stopped",
            "expected {name} to remain stopped"
        );
    }

    // Opus window resets & Kimi gets funded -> both clear; OpenRouter 429 still stays stopped.
    *opus_util.lock().await = 0.0;
    *kimi_balance.lock().await = 25.0;
    let res = providers::check_recovery_at(home.path(), &app.events, true, 7_000_040.0)
        .await
        .unwrap();
    assert_eq!(res["resolved"], 2);
    assert_eq!(
        app.call("local", "hexbot.bots.get", &json!({"name": "opus"}))
            .await
            .unwrap()["bot"]["status"],
        "idle"
    );
    assert_eq!(
        app.call("local", "hexbot.bots.get", &json!({"name": "kimi"}))
            .await
            .unwrap()["bot"]["status"],
        "idle"
    );
    assert_eq!(
        app.call("local", "hexbot.bots.get", &json!({"name": "free_or"}))
            .await
            .unwrap()["bot"]["status"],
        "stopped"
    );

    // Flap guard: if `kimi` immediately fails again after an automatic clear, automatic recovery pauses.
    record_dream_incident(
        home.path(),
        "kimi",
        "dream-kimi-flap",
        "Insufficient balance",
        "kimi-coding",
    )
    .await;
    providers::note_quota_incident(home.path(), "kimi-coding", None, None);
    let res = providers::check_recovery_at(home.path(), &app.events, true, 7_000_200.0)
        .await
        .unwrap();
    assert_eq!(res["resolved"], 0);
    assert_eq!(
        app.call("local", "hexbot.bots.get", &json!({"name": "kimi"}))
            .await
            .unwrap()["bot"]["status"],
        "stopped"
    );

    app.shutdown().await;
    server.abort();
}

#[tokio::test]
async fn model_scoped_turns_and_paid_probes_isolate_distinct_models() {
    let router = Router::new().route(
        "/v1/responses",
        post(|axum::Json(payload): axum::Json<Value>| async move {
            if payload["model"] == "gpt-5.4" {
                (StatusCode::OK, axum::Json(json!({"id": "resp_ok"}))).into_response()
            } else {
                (
                    StatusCode::TOO_MANY_REQUESTS,
                    axum::Json(json!({"error": {"code": "rate_limit"}})),
                )
                    .into_response()
            }
        }),
    );
    let (origin, server) = start_mock_server(router).await;

    let (home, app) = app_with_pi(
        r#"#!/usr/bin/env node
const emit=v=>process.stdout.write(JSON.stringify(v)+'\n');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
const c=JSON.parse(line);emit({type:'response',id:c.id,command:c.type,success:true,data:{}});
if(c.type==='prompt'){
  emit({type:'agent_start'});
  emit({type:'message_end',message:{role:'user',content:c.message}});
  emit({type:'message_end',message:{role:'assistant',provider:'anthropic',model:'claude-sonnet-4-6',content:[{type:'text',text:'ok'}],stopReason:'stop'}});
  emit({type:'agent_end'});
  emit({type:'agent_settled'});
}
});
"#,
    )
    .await;

    fs::write(
        home.path().join(".env"),
        format!("OPENAI_API_KEY='sk-test'\nOPENAI_BASE_URL='{origin}/v1'\n"),
    )
    .unwrap();
    for (name, prov, model) in [
        ("opus_bot", "anthropic", "claude-opus-4-6"),
        ("sonnet_a", "anthropic", "claude-sonnet-4-6"),
        ("sonnet_b", "anthropic", "claude-sonnet-4-6"),
        ("oai_54", "openai-api", "gpt-5.4"),
        ("oai_4o", "openai-api", "gpt-4o"),
    ] {
        app.call(
            "local",
            "hexbot.bots.create",
            &json!({"name": name, "provider": prov, "model": model, "tools": []}),
        )
        .await
        .unwrap();
        record_dream_incident(
            home.path(),
            name,
            &format!("dream-{name}"),
            "Rate limit reached",
            prov,
        )
        .await;
    }

    // Sonnet completing a turn clears sonnet_a & sonnet_b, but MUST NOT clear opus_bot!
    app.runtime
        .run_hidden_job("local", "sonnet_a", "chat-s", "hi", &json!({}))
        .await
        .unwrap();
    assert_eq!(
        app.call("local", "hexbot.bots.get", &json!({"name": "sonnet_a"}))
            .await
            .unwrap()["bot"]["status"],
        "idle"
    );
    assert_eq!(
        app.call("local", "hexbot.bots.get", &json!({"name": "sonnet_b"}))
            .await
            .unwrap()["bot"]["status"],
        "idle"
    );
    assert_eq!(
        app.call("local", "hexbot.bots.get", &json!({"name": "opus_bot"}))
            .await
            .unwrap()["bot"]["status"],
        "stopped"
    );

    // Paid probe for OpenAI probes each distinct model: gpt-5.4 succeeds and clears oai_54,
    // while gpt-4o returns 429 and leaves oai_4o stopped.
    let res = providers::check_recovery_at(home.path(), &app.events, true, 8_000_000.0)
        .await
        .unwrap();
    assert_eq!(res["resolved"], 1);
    assert_eq!(
        app.call("local", "hexbot.bots.get", &json!({"name": "oai_54"}))
            .await
            .unwrap()["bot"]["status"],
        "idle"
    );
    assert_eq!(
        app.call("local", "hexbot.bots.get", &json!({"name": "oai_4o"}))
            .await
            .unwrap()["bot"]["status"],
        "stopped"
    );

    app.shutdown().await;
    server.abort();
}

#[tokio::test]
async fn balance_providers_skip_non_credit_429_and_real_turn_clears_flap_guard_and_archived_sections_ignored()
 {
    let balance_hits = Arc::new(AtomicUsize::new(0));
    let codex_hits = Arc::new(AtomicUsize::new(0));
    let router = Router::new()
        .route(
            "/v1/key",
            get({
                let hits = balance_hits.clone();
                move || {
                    let hits = hits.clone();
                    async move {
                        hits.fetch_add(1, Ordering::SeqCst);
                        axum::Json(json!({"data": {"limit_remaining": 10.0}}))
                    }
                }
            }),
        )
        .route(
            "/user/balance",
            get({
                let hits = balance_hits.clone();
                move || {
                    let hits = hits.clone();
                    async move {
                        hits.fetch_add(1, Ordering::SeqCst);
                        axum::Json(json!({"is_available": true}))
                    }
                }
            }),
        )
        .route(
            "/v1/users/me/balance",
            get({
                let hits = balance_hits.clone();
                move || {
                    let hits = hits.clone();
                    async move {
                        hits.fetch_add(1, Ordering::SeqCst);
                        axum::Json(json!({"data": {"available_balance": 20.0}}))
                    }
                }
            }),
        )
        .route(
            "/backend-api/wham/usage",
            get({
                let hits = codex_hits.clone();
                move || {
                    let hits = hits.clone();
                    async move {
                        hits.fetch_add(1, Ordering::SeqCst);
                        axum::Json(json!({"rate_limit": {"allowed": true, "limit_reached": false}}))
                    }
                }
            }),
        );
    let (origin, server) = start_mock_server(router).await;

    let (home, app) = app_with_pi(
        r#"#!/usr/bin/env node
const emit=v=>process.stdout.write(JSON.stringify(v)+'\n');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
const c=JSON.parse(line);emit({type:'response',id:c.id,command:c.type,success:true,data:{}});
if(c.type==='prompt'){
  emit({type:'agent_start'});
  emit({type:'message_end',message:{role:'user',content:c.message}});
  emit({type:'message_end',message:{role:'assistant',provider:'openai-codex',model:'gpt-5.4',content:[{type:'text',text:'ok'}],stopReason:'stop'}});
  emit({type:'agent_end'});
  emit({type:'agent_settled'});
}
});
"#,
    )
    .await;

    fs::write(
        home.path().join("config.yaml"),
        format!(
            "provider_auth:\n  openai-codex:\n    usage_url: \"{origin}/backend-api/wham/usage\"\nmodel:\n  provider: openrouter\n  base_url: \"{origin}/v1\"\n"
        ),
    )
    .unwrap();
    fs::write(
        home.path().join("auth.json"),
        json!({"providers": {"openai-codex": {"access_token": "tok", "expires_at": 4_102_444_800.0}}})
            .to_string(),
    )
    .unwrap();
    fs::write(
        home.path().join(".env"),
        format!(
            "OPENROUTER_API_KEY='sk-or'\nDEEPSEEK_API_KEY='sk-ds'\nDEEPSEEK_BASE_URL='{origin}/v1'\nKIMI_API_KEY='sk-k'\nKIMI_BASE_URL='{origin}/v1'\n"
        ),
    )
    .unwrap();

    for (name, prov, model) in [
        ("or_429", "openrouter", "google/gemma-3-27b-it:free"),
        ("ds_429", "deepseek", "deepseek-chat"),
        ("kimi_429", "kimi-coding", "kimi-k2.5"),
        ("local_ollama", "custom", "llama3"),
        ("codex_bot", "openai-codex", "gpt-5.4"),
    ] {
        app.call(
            "local",
            "hexbot.bots.create",
            &json!({"name": name, "provider": prov, "model": model, "tools": []}),
        )
        .await
        .unwrap();
    }

    // Non-credit 429s on balance-only providers and local custom server must not be probed at all.
    for (name, prov) in [
        ("or_429", "openrouter"),
        ("ds_429", "deepseek"),
        ("kimi_429", "kimi-coding"),
        ("local_ollama", "custom"),
    ] {
        record_dream_incident(
            home.path(),
            name,
            &format!("dream-{name}"),
            "HTTP 429 Rate limit exceeded",
            prov,
        )
        .await;
    }

    // Archived section incident on codex_bot is hidden and must not trigger polling.
    db::open(home.path())
        .unwrap()
        .execute(
            "INSERT INTO sections(id,bot,title,owner_id,created_at,updated_at,archived_at) VALUES('arch-1','codex_bot','Old','local',100,100,200)",
            [],
        )
        .unwrap();
    settings::record_incident(
        home.path(),
        "codex_bot",
        "turn_failed",
        "Codex error: The usage limit has been reached",
        &json!({"section_id": "arch-1", "provider": "openai-codex"}),
    )
    .unwrap();

    let res = providers::check_recovery_at(home.path(), &app.events, true, 9_000_000.0)
        .await
        .unwrap();
    assert_eq!(res["checked"], json!([]));
    assert_eq!(res["resolved"], 0);
    assert_eq!(balance_hits.load(Ordering::SeqCst), 0);
    assert_eq!(codex_hits.load(Ordering::SeqCst), 0);

    // Real turn after automatic clear resets the flap guard so a subsequent quota error still auto-recovers.
    record_dream_incident(
        home.path(),
        "codex_bot",
        "dream-codex-1",
        "Codex error: The usage limit has been reached",
        "openai-codex",
    )
    .await;
    let res = providers::check_recovery_at(home.path(), &app.events, true, 9_000_100.0)
        .await
        .unwrap();
    // Resolves both the visible dream incident and cleans up the hidden archived-section incident.
    assert_eq!(res["resolved"], 2);
    assert_eq!(codex_hits.load(Ordering::SeqCst), 1);

    // Real successful turn while NO quota incident is open clears auto_resolved_times.
    app.runtime
        .run_hidden_job("local", "codex_bot", "chat-real", "hi", &json!({}))
        .await
        .unwrap();

    // A later quota incident within 10 minutes is NOT paused as a flap and auto-recovers cleanly.
    record_dream_incident(
        home.path(),
        "codex_bot",
        "dream-codex-2",
        "Codex error: The usage limit has been reached",
        "openai-codex",
    )
    .await;
    providers::note_quota_incident(home.path(), "openai-codex", None, Some("gpt-5.4"));
    let res = providers::check_recovery_at(home.path(), &app.events, true, 9_000_200.0)
        .await
        .unwrap();
    assert_eq!(res["resolved"], 1);
    assert_eq!(codex_hits.load(Ordering::SeqCst), 2);

    app.shutdown().await;
    server.abort();
}

#[tokio::test]
async fn fallback_model_quota_incident_probes_exact_fallback_model_and_clears_without_looping() {
    let probed_models: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(vec![]));
    let router = Router::new().route(
        "/v1/responses",
        post({
            let probed_models = probed_models.clone();
            move |axum::Json(payload): axum::Json<Value>| {
                let probed_models = probed_models.clone();
                async move {
                    probed_models
                        .lock()
                        .await
                        .push(payload["model"].as_str().unwrap_or("").to_owned());
                    (StatusCode::OK, axum::Json(json!({"id": "resp_ok"}))).into_response()
                }
            }
        }),
    );
    let (origin, server) = start_mock_server(router).await;

    let (home, app) = app_with_pi("#!/usr/bin/env node\n").await;
    fs::write(
        home.path().join(".env"),
        format!("OPENAI_API_KEY='sk-test'\nOPENAI_BASE_URL='{origin}/v1'\n"),
    )
    .unwrap();
    // Bot is configured on Anthropic, NOT OpenAI API.
    app.call(
        "local",
        "hexbot.bots.create",
        &json!({"name": "owl", "provider": "anthropic", "model": "claude-sonnet-4-6", "tools": []}),
    )
    .await
    .unwrap();

    // A fallback run hits a quota limit on `openai-api` / `gpt-5.4-mini` (recorded on the incident).
    hexbot_core::runtime_store::open(home.path())
        .unwrap()
        .execute(
            "INSERT OR IGNORE INTO native_sessions(stored_id,owner,bot,prompt,options) VALUES('dream-fb','local','owl','','{}')",
            [],
        )
        .unwrap();
    settings::record_incident(
        home.path(),
        "owl",
        "turn_failed",
        "HTTP 429 rate limit exceeded",
        &json!({"section_id": "dream-fb", "provider": "openai-api", "model": "gpt-5.4-mini"}),
    )
    .unwrap();

    let res = providers::check_recovery_at(home.path(), &app.events, true, 10_000_000.0)
        .await
        .unwrap();
    assert_eq!(res["resolved"], 1);
    assert_eq!(
        probed_models.lock().await.as_slice(),
        &["gpt-5.4-mini".to_owned()]
    );
    assert_eq!(
        app.call("local", "hexbot.bots.get", &json!({"name": "owl"}))
            .await
            .unwrap()["bot"]["status"],
        "idle"
    );

    // Subsequent check must find no remaining open quota incidents and issue zero probes.
    let res2 = providers::check_recovery_at(home.path(), &app.events, true, 10_000_700.0)
        .await
        .unwrap();
    assert_eq!(res2["checked"], json!([]));
    assert_eq!(probed_models.lock().await.len(), 1);

    app.shutdown().await;
    server.abort();
}
