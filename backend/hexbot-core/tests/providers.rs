use hexbot_core::{common, db, providers};
use serde_json::{Value, json};
use std::{
    fs,
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};

fn setup() -> tempfile::TempDir {
    let home = tempfile::tempdir().unwrap();
    db::migrate(home.path()).unwrap();
    db::open(home.path()).unwrap().execute_batch("INSERT INTO users(id,display_name,role,created_at) VALUES ('member','Member','member',0),('other','Other','admin',0)").unwrap();
    home
}
async fn call(home: &Path, caller: &str, method: &str, p: Value) -> hexbot_core::Result<Value> {
    providers::call(home, caller, method, &p).await.unwrap()
}
#[tokio::test]
async fn credentials_reach_profiles_without_leaking_to_clients() {
    let home = setup();
    fs::create_dir_all(home.path().join("profiles/owl")).unwrap();
    fs::write(
        home.path().join(".env"),
        "OTHER='keep'\nOPENAI_API_KEY='old'\n",
    )
    .unwrap();
    let output = call(
        home.path(),
        "local",
        "hexbot.providers.set_key",
        json!({"provider":"gpt","key":"new's\\secret"}),
    )
    .await
    .unwrap();
    assert_eq!(output, json!({"provider":"openai-api","configured":true}));
    assert!(
        fs::read_to_string(home.path().join(".env"))
            .unwrap()
            .contains("OTHER='keep'")
    );
    assert!(
        fs::read_to_string(home.path().join("profiles/owl/.env"))
            .unwrap()
            .contains("OPENAI_API_KEY=")
    );
    let rows = call(home.path(), "member", "hexbot.providers.list", json!({}))
        .await
        .unwrap();
    assert!(!rows.to_string().contains("secret"));
    assert_eq!(
        rows["providers"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["id"] == "openai-api")
            .unwrap()["configured"],
        true
    );
    let dir = home.path().join("pi");
    providers::prepare_pi_for_bot(home.path(), "owl", &dir).unwrap();
    let auth: Value = serde_json::from_slice(&fs::read(dir.join("auth.json")).unwrap()).unwrap();
    assert_eq!(auth["openai"]["key"], "new's\\secret");
    call(
        home.path(),
        "local",
        "hexbot.providers.clear_key",
        json!({"provider":"openai"}),
    )
    .await
    .unwrap();
    providers::prepare_pi_for_bot(home.path(), "owl", &dir).unwrap();
    let auth: Value = serde_json::from_slice(&fs::read(dir.join("auth.json")).unwrap()).unwrap();
    assert!(auth.get("openai").is_none());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(dir.join("auth.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
}
#[tokio::test]
async fn guards_provider_mutations_and_rejects_invalid_keys() {
    let home = setup();
    for method in [
        "hexbot.providers.set_key",
        "hexbot.providers.clear_key",
        "hexbot.providers.login_start",
        "model.save_key",
        "model.disconnect",
    ] {
        assert_eq!(
            call(
                home.path(),
                "member",
                method,
                json!({"provider":"openai","key":"secret","slug":"openai-api","api_key":"secret"})
            )
            .await
            .unwrap_err()
            .code,
            4301
        )
    }
    assert_eq!(
        call(home.path(), "missing", "hexbot.providers.list", json!({}))
            .await
            .unwrap_err()
            .code,
        4302
    );
    for key in ["", "  ", "abc\nEVIL=secret", "abc\0def"] {
        assert!(
            call(
                home.path(),
                "local",
                "hexbot.providers.set_key",
                json!({"provider":"openai","key":key})
            )
            .await
            .is_err()
        )
    }
    assert_eq!(
        call(
            home.path(),
            "local",
            "hexbot.providers.set_key",
            json!({"provider":"unknown","key":"key"})
        )
        .await
        .unwrap_err()
        .code,
        4206
    );
    assert_eq!(
        call(
            home.path(),
            "local",
            "hexbot.providers.set_key",
            json!({"provider":"openai-codex","key":"key"})
        )
        .await
        .unwrap_err()
        .code,
        4207
    );
    assert!(!home.path().join(".env").exists());
}
#[tokio::test]
async fn model_catalog_preserves_aliases_and_curated_rows() {
    let home = setup();
    let models = call(
        home.path(),
        "member",
        "hexbot.models.list",
        json!({"provider":"chatgpt"}),
    )
    .await
    .unwrap();
    assert!(!models["all"].as_array().unwrap().is_empty());
    assert!(
        models["all"]
            .as_array()
            .unwrap()
            .iter()
            .all(|m| m["provider"] == "openai-codex")
    );
    let models = call(
        home.path(),
        "member",
        "hexbot.models.list",
        json!({"provider":"openai"}),
    )
    .await
    .unwrap();
    assert!(
        models["curated"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["id"] == "gpt-5.6")
    );
    assert_eq!(models["all_source"], "catalog");
    assert_eq!(providers::pi_provider("gemini"), "google");
    assert_eq!(providers::pi_provider("bedrock"), "amazon-bedrock");
}

async fn auth_server(
    status: &'static str,
) -> (String, Arc<AtomicUsize>, tokio::task::JoinHandle<()>) {
    let count = Arc::new(AtomicUsize::new(0));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let url = base.clone();
    let requests = count.clone();
    let app=axum::Router::new().route("/api/accounts/deviceauth/usercode",axum::routing::post(||async{axum::Json(json!({"device_auth_id":"device","user_code":"ABCD","interval":1}))})).route("/api/accounts/deviceauth/token",axum::routing::post(move||{let count=requests.clone();async move{count.fetch_add(1,Ordering::SeqCst);if status=="ok" {(axum::http::StatusCode::OK,axum::Json(json!({"authorization_code":"auth","code_verifier":"verifier"})))}else if status=="pending"{(axum::http::StatusCode::NOT_FOUND,axum::Json(json!({})))}else{(axum::http::StatusCode::BAD_REQUEST,axum::Json(json!({"error":"access_denied"})))}}})).route("/oauth/token",axum::routing::post(||async{axum::Json(json!({"access_token":"access","refresh_token":"refresh","expires_in":3600}))})).route("/api/oauth/device/code",axum::routing::post(move||{let url=url.clone();async move{axum::Json(json!({"device_code":"device","user_code":"ABCD","verification_uri":format!("{url}/verify"),"interval":1,"expires_in":1}))}}));
    let handle = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (base, count, handle)
}
async fn wait_for_status(home: &Path, id: &str) -> Value {
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let value = call(
                home,
                "local",
                "hexbot.providers.login_poll",
                json!({"login_id":id}),
            )
            .await
            .unwrap();
            if value["status"] != "pending" {
                return value;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap()
}
#[tokio::test]
async fn device_login_saves_real_grant_and_scopes_polling() {
    let home = setup();
    let mirror = home.path().join("profiles/owl/pi");
    providers::prepare_pi_for_bot(home.path(), "owl", &mirror).unwrap();
    let (base, count, server) = auth_server("ok").await;
    common::write_config(
        home.path(),
        &json!({"provider_auth":{"openai-codex":{"issuer":base}}}),
    )
    .unwrap();
    let login = call(
        home.path(),
        "local",
        "hexbot.providers.login_start",
        json!({"provider":"codex"}),
    )
    .await
    .unwrap();
    assert_eq!(login["status"], "pending");
    let id = login["login_id"].as_str().unwrap();
    assert_eq!(
        call(
            home.path(),
            "other",
            "hexbot.providers.login_poll",
            json!({"login_id":id})
        )
        .await
        .unwrap_err()
        .code,
        4210
    );
    let other = setup();
    assert_eq!(
        call(
            other.path(),
            "local",
            "hexbot.providers.login_cancel",
            json!({"login_id":id})
        )
        .await
        .unwrap_err()
        .code,
        4210
    );
    let done = wait_for_status(home.path(), id).await;
    assert_eq!(done["status"], "done");
    assert!(!done.to_string().contains("refresh"));
    assert!(count.load(Ordering::SeqCst) > 0);
    let auth: Value =
        serde_json::from_slice(&fs::read(home.path().join("auth.json")).unwrap()).unwrap();
    assert_eq!(
        auth["providers"]["openai-codex"]["tokens"]["access_token"],
        "access"
    );
    let mirrored: Value =
        serde_json::from_slice(&fs::read(mirror.join("auth.json")).unwrap()).unwrap();
    assert_eq!(mirrored["openai-codex"]["access"], "access");
    providers::clear_key(home.path(), "codex").unwrap();
    let mirrored: Value =
        serde_json::from_slice(&fs::read(mirror.join("auth.json")).unwrap()).unwrap();
    assert!(mirrored.get("openai-codex").is_none());
    server.abort();
}
#[tokio::test]
async fn cancellation_never_saves_a_grant_and_provider_errors_are_visible() {
    let home = setup();
    let (base, _, server) = auth_server("denied").await;
    common::write_config(
        home.path(),
        &json!({"provider_auth":{"openai-codex":{"issuer":base}}}),
    )
    .unwrap();
    let login = call(
        home.path(),
        "local",
        "hexbot.providers.login_start",
        json!({"provider":"codex"}),
    )
    .await
    .unwrap();
    let id = login["login_id"].as_str().unwrap();
    let cancelled = call(
        home.path(),
        "local",
        "hexbot.providers.login_cancel",
        json!({"login_id":id}),
    )
    .await
    .unwrap();
    assert_eq!(cancelled["status"], "cancelled");
    assert!(!home.path().join("auth.json").exists());
    let login = call(
        home.path(),
        "local",
        "hexbot.providers.login_start",
        json!({"provider":"codex"}),
    )
    .await
    .unwrap();
    let done = wait_for_status(home.path(), login["login_id"].as_str().unwrap()).await;
    assert_eq!(done["status"], "error");
    assert!(!home.path().join("auth.json").exists());
    server.abort();
}
#[tokio::test]
async fn sign_in_expires_and_unsupported_flows_do_not_fake_success() {
    let home = setup();
    let (base, _, server) = auth_server("pending").await;
    common::write_config(
        home.path(),
        &json!({"provider_auth":{"nous":{"issuer":base}}}),
    )
    .unwrap();
    let login = call(
        home.path(),
        "local",
        "hexbot.providers.login_start",
        json!({"provider":"nous"}),
    )
    .await
    .unwrap();
    let done = wait_for_status(home.path(), login["login_id"].as_str().unwrap()).await;
    assert_eq!(done["status"], "error");
    assert!(done["message"].as_str().unwrap().contains("timed out"));
    let unsupported = call(
        home.path(),
        "local",
        "hexbot.providers.login_start",
        json!({"provider":"qwen-oauth"}),
    )
    .await
    .unwrap();
    assert_eq!(unsupported["supported"], false);
    server.abort();
}

#[tokio::test]
async fn rotation_and_disconnect_update_config_and_credential_pool() {
    let home = setup();
    fs::write(home.path().join(".env"), "OPENAI_API_KEY='old'\n").unwrap();
    common::write_config(home.path(),&json!({"model":{"provider":"openai-api","api_key":"old"},"providers":{"unrelated":{"api_key":"other"}}})).unwrap();
    fs::write(home.path().join("auth.json"),serde_json::to_vec(&json!({"credential_pool":{"openai-api":[{"source":"env:OPENAI_API_KEY","api_key":"old"},{"source":"manual","api_key":"manual"}]}})).unwrap()).unwrap();
    providers::set_key(home.path(), "openai", "new").unwrap();
    let cfg = common::read_config(home.path()).unwrap();
    assert_eq!(cfg["model"]["api_key"], "new");
    assert_eq!(cfg["providers"]["unrelated"]["api_key"], "other");
    let auth: Value =
        serde_json::from_slice(&fs::read(home.path().join("auth.json")).unwrap()).unwrap();
    assert_eq!(
        auth["credential_pool"]["openai-api"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    providers::clear_key(home.path(), "openai").unwrap();
    assert!(
        common::read_config(home.path()).unwrap()["model"]
            .get("api_key")
            .is_none()
    );
}
#[tokio::test]
async fn bot_custom_endpoints_preserve_credentials_and_metadata() {
    let home = setup();
    let profile = home.path().join("profiles/local-model");
    fs::create_dir_all(&profile).unwrap();
    common::write_config(
        home.path(),
        &json!({"model":{"provider":"openai-api","default":"gpt-5.6"}}),
    )
    .unwrap();
    common::write_config(&profile,&json!({"model":{"provider":"custom","default":"local-model","base_url":"http://127.0.0.1:11434/v1","api_key":"local-secret"}})).unwrap();
    fs::write(home.path().join("models_dev_cache.json"),serde_json::to_vec(&json!({"custom":{"models":{"local-model":{"limit":{"context":65536,"output":4096},"reasoning":true,"modalities":{"input":["text","image"]},"cost":{"input":1.25,"output":2.5}}}}})).unwrap()).unwrap();
    let dir = home.path().join("pi-local");
    providers::prepare_pi_for_bot(home.path(), "local-model", &dir).unwrap();
    let auth: Value = serde_json::from_slice(&fs::read(dir.join("auth.json")).unwrap()).unwrap();
    let models: Value =
        serde_json::from_slice(&fs::read(dir.join("models.json")).unwrap()).unwrap();
    assert_eq!(auth["custom"]["key"], "local-secret");
    assert_eq!(
        models["providers"]["custom"]["baseUrl"],
        "http://127.0.0.1:11434/v1"
    );
    let model = models["providers"]["custom"]["models"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["id"] == "local-model")
        .unwrap();
    assert_eq!(model["contextWindow"], 65536);
    assert_eq!(model["input"], json!(["text", "image"]));
    assert_eq!(model["reasoning"], true);
    assert!(providers::prepare_pi_for_bot(home.path(), "../escape", &dir).is_err());
}
#[tokio::test]
async fn live_catalog_refresh_uses_custom_url_and_reports_failures() {
    let home = setup();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let app = axum::Router::new().route(
        "/models",
        axum::routing::get(|| async {
            axum::Json(json!({"data":[{"id":"new-model"},{"id":"new-model"},{"id":"a-model"}]}))
        }),
    );
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    common::write_config(
        home.path(),
        &json!({"model":{"provider":"custom","base_url":url,"default":"new-model"}}),
    )
    .unwrap();
    let models = providers::list_models(home.path(), &json!({"provider":"custom","refresh":true}))
        .await
        .unwrap();
    assert_eq!(models["all"].as_array().unwrap().len(), 2);
    assert_eq!(models["all"][0]["id"], "a-model");
    assert!(models.get("error").is_none());
    server.abort();
    server.await.unwrap_err();
    let failed = providers::list_models(home.path(), &json!({"provider":"custom","refresh":true}))
        .await
        .unwrap();
    assert!(failed["error"].is_string());
}

#[tokio::test]
async fn disconnect_invalidates_pending_login_and_corrupt_credentials_fail_closed() {
    let home = setup();
    let (base, _, server) = auth_server("ok").await;
    common::write_config(
        home.path(),
        &json!({"provider_auth":{"openai-codex":{"issuer":base}}}),
    )
    .unwrap();
    let login = call(
        home.path(),
        "local",
        "hexbot.providers.login_start",
        json!({"provider":"codex"}),
    )
    .await
    .unwrap();
    providers::clear_key(home.path(), "codex").unwrap();
    let done = wait_for_status(home.path(), login["login_id"].as_str().unwrap()).await;
    assert_eq!(done["status"], "error");
    let auth: Value =
        serde_json::from_slice(&fs::read(home.path().join("auth.json")).unwrap()).unwrap();
    assert!(auth["providers"]["openai-codex"].is_null());
    server.abort();
    fs::write(home.path().join("auth.json"), "[]").unwrap();
    assert_eq!(
        providers::prepare_pi_for_bot(home.path(), "owl", &home.path().join("pi"))
            .unwrap_err()
            .code,
        5200
    );
}

#[tokio::test]
async fn oauth_refresh_rotates_nous_qwen_and_minimax_grants() {
    use base64::Engine;
    for provider in ["nous", "qwen-oauth", "minimax-oauth", "xai-oauth"] {
        let home = setup();
        let claims = json!({"scope":"inference:invoke","exp":common::now()+7200.0});
        let access = format!(
            "header.{}.sig",
            base64::engine::general_purpose::URL_SAFE_NO_PAD
                .encode(serde_json::to_vec(&claims).unwrap())
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let issuer = format!("http://{}", listener.local_addr().unwrap());
        let expected = access.clone();
        let hits = Arc::new(AtomicUsize::new(0));
        let count = hits.clone();
        let app=axum::Router::new().fallback(axum::routing::post(move|body:String|{let access=expected.clone();let count=count.clone();async move{assert!(body.contains("grant_type=refresh_token"));assert!(body.contains("refresh_token=old-refresh"));count.fetch_add(1,Ordering::SeqCst);axum::Json(json!({"status":"success","access_token":access,"refresh_token":"rotated-refresh","expires_in":3600,"expired_in":(common::now()+3600.0)*1000.0,"scope":"inference:invoke"}))}}));
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let mut config = json!({"provider_auth":{provider:{"issuer":issuer}}});
        if provider == "qwen-oauth" {
            let import = home.path().join("qwen-import.json");
            fs::write(&import,serde_json::to_vec(&json!({"access_token":"old-access","refresh_token":"old-refresh","expiry_date":0})).unwrap()).unwrap();
            config["provider_auth"][provider]["auth_file"] = json!(import);
        } else {
            fs::write(home.path().join("auth.json"),serde_json::to_vec(&json!({"providers":{provider:{"access_token":"old-access","refresh_token":"old-refresh","expires_at":"2020-01-01T00:00:00Z","scope":"inference:invoke"}}})).unwrap()).unwrap();
        }
        common::write_config(home.path(), &config).unwrap();
        let first = providers::request_auth(home.path(), "owl", provider)
            .await
            .unwrap();
        assert_eq!(
            first["headers"]["authorization"],
            format!("Bearer {access}")
        );
        let second = providers::request_auth(home.path(), "owl", provider)
            .await
            .unwrap();
        assert_eq!(first, second);
        assert_eq!(hits.load(Ordering::SeqCst), 1);
        let auth: Value =
            serde_json::from_slice(&fs::read(home.path().join("auth.json")).unwrap()).unwrap();
        if provider == "xai-oauth" {
            assert_eq!(auth["providers"][provider]["refresh_token"], "old-refresh");
            let entry = fs::read_dir(home.path().join("runtime/provider-auth"))
                .unwrap()
                .next()
                .unwrap()
                .unwrap();
            let shared: Value = serde_json::from_slice(&fs::read(entry.path()).unwrap()).unwrap();
            assert_eq!(shared["refresh_token"], "rotated-refresh");
        } else {
            assert_eq!(
                auth["providers"][provider]["refresh_token"],
                "rotated-refresh"
            );
        }
        providers::clear_key(home.path(), provider).unwrap();
        assert!(
            providers::request_auth(home.path(), "owl", provider)
                .await
                .unwrap_err()
                .message
                .contains("disconnected")
        );
        server.abort();
    }
}
#[test]
fn model_selection_guards_cost_boundaries_and_data_tiers() {
    assert!(
        providers::selection_warning(&json!({"id":"normal","cost":{"input":20.0,"output":100.0}}))
            .is_none()
    );
    assert!(
        providers::selection_warning(&json!({"id":"costly","cost":{"input":20.01,"output":0.0}}))
            .unwrap()
            .contains("cost threshold")
    );
    assert!(
        providers::selection_warning(&json!({"id":"openai/gpt-5.5-pro"}))
            .unwrap()
            .contains("openai/gpt-5.5?")
    );
    assert!(
        providers::selection_warning(&json!({"id":"muse-spark-1.2-contributor"}))
            .unwrap()
            .contains("training")
    );
    assert!(providers::selection_warning(&json!({"id":"muse-spark-1.2"})).is_none());
}

#[test]
fn provider_wire_adapters_keep_history_and_reasoning_controls_consistent() {
    let home = setup();
    let source = json!({"messages":[{"role":"system","content":"fixed prefix"},{"role":"user","content":["hello"]}],"temperature":0.7,"reasoning_effort":"low"});
    let adapt = |provider: &str, model: &str, thinking: &str| {
        providers::adapt_request(
            home.path(),
            "owl",
            "conversation-1",
            &json!({"provider":provider,"model":model,"thinking":thinking,"payload":source}),
        )
        .unwrap()
    };
    let qwen = adapt("qwen-oauth", "coder-model", "off");
    assert_eq!(
        qwen["messages"][0]["content"][0]["cache_control"]["type"],
        "ephemeral"
    );
    assert_eq!(qwen["vl_high_resolution_images"], true);
    assert_eq!(source["messages"][0]["content"], "fixed prefix");
    let kimi = adapt("kimi-coding", "kimi-k3", "medium");
    assert_eq!(kimi["reasoning_effort"], "high");
    assert!(kimi.get("thinking").is_none());
    assert!(kimi.get("temperature").is_none());
    let kimi = adapt("kimi-coding", "kimi-k3", "off");
    assert_eq!(kimi["thinking"]["type"], "disabled");
    assert!(kimi.get("reasoning_effort").is_none());
    let glm = adapt("zai", "glm-5.2", "low");
    assert_eq!(glm["reasoning_effort"], "high");
    let glm = adapt("zai", "glm-5.3", "low");
    assert_eq!(glm["reasoning_effort"], "low");
    let glm = adapt("zai", "glm-5.3", "off");
    assert_eq!(glm["thinking"]["type"], "disabled");
    assert!(glm.get("reasoning_effort").is_none());
    let ds = adapt("deepseek", "deepseek-v4-pro", "xhigh");
    assert_eq!(ds["reasoning_effort"], "max");
    let nous = adapt("nous", "deepseek/deepseek-v4-pro", "off");
    assert_eq!(nous["session_id"], "conversation-1");
    assert!(nous.get("reasoning_effort").is_none());
    common::write_config(home.path(),&json!({"model":{"provider":"custom","base_url":"http://localhost:11434/v1","context_length":32000}})).unwrap();
    let local = adapt("custom", "local", "off");
    assert_eq!(local["think"], false);
    assert_eq!(local["reasoning_effort"], "none");
    assert_eq!(local["options"]["num_ctx"], 32000);
    common::write_config(
        home.path(),
        &json!({"model":{"provider":"custom","base_url":"https://vllm.example/v1"}}),
    )
    .unwrap();
    assert!(adapt("custom", "local", "off").get("think").is_none());
}

#[tokio::test]
async fn named_custom_provider_identity_survives_model_listing_and_pi_import() {
    let home = setup();
    common::write_config(home.path(),&json!({"model":{"provider":"custom:work","default":"work-model"},"providers":{"work":{"api":"https://example.test/v1","api_key":"custom-secret","models":["work-model"]}}})).unwrap();
    let list = providers::model_options(home.path(), &json!({}))
        .await
        .unwrap();
    let provider = list["providers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["slug"] == "work")
        .unwrap();
    assert_eq!(provider["is_current"], true);
    assert_eq!(provider["aliases"], json!(["custom:work"]));
    assert!(!list.to_string().contains("custom-secret"));
    let dir = home.path().join("pi");
    providers::prepare_pi_for_bot(home.path(), "owl", &dir).unwrap();
    let models: Value =
        serde_json::from_slice(&fs::read(dir.join("models.json")).unwrap()).unwrap();
    let auth: Value = serde_json::from_slice(&fs::read(dir.join("auth.json")).unwrap()).unwrap();
    assert_eq!(
        models["providers"]["custom:work"]["models"][0]["id"],
        "work-model"
    );
    assert_eq!(auth["custom:work"]["key"], "custom-secret");
}

#[test]
fn response_providers_and_acp_keep_their_transport() {
    let home = setup();
    let dir = home.path().join("pi");
    common::write_config(
        home.path(),
        &json!({"model":{"provider":"copilot-acp","default":"copilot-acp"}}),
    )
    .unwrap();
    providers::prepare_pi_for_bot(home.path(), "owl", &dir).unwrap();
    let models: Value =
        serde_json::from_slice(&fs::read(dir.join("models.json")).unwrap()).unwrap();
    let auth: Value = serde_json::from_slice(&fs::read(dir.join("auth.json")).unwrap()).unwrap();
    assert!(models["providers"].get("copilot-acp").is_none());
    assert_eq!(auth["copilot-acp"]["key"], "external-process");
    for (name, url) in [
        ("meta-ai", "https://api.meta.ai/v1"),
        ("router", "https://api.router.com/v1"),
        ("actual", "https://api.actual.inc/v1"),
    ] {
        assert_eq!(models["providers"][name]["baseUrl"], url);
        assert_eq!(models["providers"][name]["api"], "openai-responses");
    }
    for (provider, pi, api) in [
        ("openai-api", "openai", "openai-responses"),
        ("zai", "zai", "openai-completions"),
        ("kimi-coding", "moonshotai", "openai-completions"),
    ] {
        common::write_config(
            home.path(),
            &json!({"model":{"provider":provider,"default":"operator-new-model"}}),
        )
        .unwrap();
        providers::prepare_pi_for_bot(home.path(), "owl", &dir).unwrap();
        let models: Value =
            serde_json::from_slice(&fs::read(dir.join("models.json")).unwrap()).unwrap();
        let added = models["providers"][pi]["models"].as_array().unwrap();
        assert!(added.iter().any(|m| m["id"] == "operator-new-model"));
        assert_eq!(models["providers"][pi]["api"], api);
        assert!(
            !added.iter().any(|m| m["id"] == "gpt-4o"),
            "built-in metadata must remain intact"
        );
    }
}

#[tokio::test]
async fn refreshing_one_provider_does_not_block_another() {
    use axum::{Json, Router, routing::post};
    use tokio::sync::Notify;
    let home = setup();
    let entered = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let started = entered.clone();
    let resume = release.clone();
    let app = Router::new()
        .route("/oauth/token", post(move || { let started = started.clone(); let resume = resume.clone(); async move {
            started.notify_one(); resume.notified().await;
            Json(json!({"access_token":"codex-new","refresh_token":"codex-refresh","expires_in":3600}))
        }}))
        .route("/v1/oauth/token", post(|| async { Json(json!({"access_token":"anthropic-new","refresh_token":"anthropic-refresh","expires_in":3600})) }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let issuer = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    common::write_config(
        home.path(),
        &json!({"provider_auth":{"openai-codex":{"issuer":issuer},"anthropic":{"issuer":issuer}}}),
    )
    .unwrap();
    fs::write(home.path().join("auth.json"), json!({"providers":{
        "openai-codex":{"access_token":"expired","refresh_token":"codex-refresh","expires_at":1},
        "anthropic":{"access_token":"expired","refresh_token":"anthropic-refresh","expires_at":1}
    }}).to_string()).unwrap();
    let path = home.path().to_owned();
    let codex =
        tokio::spawn(async move { providers::request_auth(&path, "owl", "openai-codex").await });
    tokio::time::timeout(std::time::Duration::from_secs(5), entered.notified())
        .await
        .unwrap();
    let auth = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        providers::request_auth(home.path(), "owl", "anthropic"),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(auth["headers"]["authorization"], "Bearer anthropic-new");
    release.notify_one();
    assert_eq!(
        codex.await.unwrap().unwrap()["headers"]["authorization"],
        "Bearer codex-new"
    );
    server.abort();
}

#[tokio::test]
async fn xai_hexbot_base_url_precedes_legacy_name() {
    let home = setup();
    fs::write(home.path().join(".env"), "XAI_API_KEY=test-key\nHEXBOT_XAI_BASE_URL=https://new.test/v1\nHERMES_XAI_BASE_URL=https://old.test/v1\n").unwrap();
    assert_eq!(
        providers::xai_credentials(home.path(), "owl")
            .await
            .unwrap()["base_url"],
        "https://new.test/v1"
    );
    fs::write(
        home.path().join(".env"),
        "XAI_API_KEY=test-key\nHERMES_XAI_BASE_URL=https://old.test/v1\n",
    )
    .unwrap();
    assert_eq!(
        providers::xai_credentials(home.path(), "owl")
            .await
            .unwrap()["base_url"],
        "https://old.test/v1"
    );
}

#[tokio::test]
async fn key_changes_refresh_every_existing_pi_mirror() {
    let home = setup();
    providers::set_key(home.path(), "openai", "old").unwrap();
    for bot in ["owl", "fox"] {
        let dir = home.path().join("profiles").join(bot).join("pi");
        providers::prepare_pi_for_bot(home.path(), bot, &dir).unwrap();
    }
    fs::create_dir_all(home.path().join("profiles/unused")).unwrap();
    for key in [Some("rotated"), None, Some("reconnected")] {
        match key {
            Some(key) => providers::set_key(home.path(), "openai", key).unwrap(),
            None => providers::clear_key(home.path(), "openai").unwrap(),
        };
        for bot in ["owl", "fox"] {
            let auth: Value = serde_json::from_slice(
                &fs::read(home.path().join("profiles").join(bot).join("pi/auth.json")).unwrap(),
            )
            .unwrap();
            assert_eq!(auth["openai"]["key"].as_str(), key);
        }
        assert!(!home.path().join("profiles/unused/pi").exists());
    }
}

#[tokio::test]
async fn lmstudio_picker_discovers_models_without_refresh_and_keeps_offline_default() {
    let home = setup();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/v1", listener.local_addr().unwrap());
    let count = Arc::new(AtomicUsize::new(0));
    let calls = count.clone();
    let app = axum::Router::new().route(
        "/v1/models",
        axum::routing::get(move || {
            calls.fetch_add(1, Ordering::SeqCst);
            async { axum::Json(json!({"data":[{"id":"qwen-local"}]})) }
        }),
    );
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    common::write_config(
        home.path(),
        &json!({"model":{"provider":"lmstudio","base_url":url}}),
    )
    .unwrap();
    providers::set_key(home.path(), "lmstudio", "local").unwrap();
    providers::model_options(home.path(), &json!({}))
        .await
        .unwrap();
    assert_eq!(
        count.load(Ordering::SeqCst),
        0,
        "unfiltered reads must not query local servers"
    );
    let models = providers::list_models(home.path(), &json!({"provider":"lmstudio"}))
        .await
        .unwrap();
    assert_eq!(models["all"][0]["id"], "qwen-local");
    assert_eq!(count.load(Ordering::SeqCst), 1);
    server.abort();
    server.await.unwrap_err();
    common::write_config(
        home.path(),
        &json!({"model":{"provider":"lmstudio","base_url":url,"default":"offline-model"}}),
    )
    .unwrap();
    let models = providers::list_models(home.path(), &json!({"provider":"lmstudio"}))
        .await
        .unwrap();
    assert_eq!(models["all"][0]["id"], "offline-model");
    assert!(models["error"].is_string());
}
