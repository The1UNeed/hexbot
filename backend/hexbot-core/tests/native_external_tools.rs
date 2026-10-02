use axum::{
    Router,
    body::Bytes,
    extract::State,
    http::{HeaderMap, Method, StatusCode, Uri},
    response::IntoResponse,
    routing::any,
};
use hexbot_core::{common, connectors, db, native_external_tools};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, VecDeque},
    fs,
    path::Path,
    sync::{Arc, Mutex},
};

#[derive(Clone, Debug)]
struct Call {
    method: Method,
    path: String,
    authorization: String,
    body: Value,
}
#[derive(Clone)]
struct Reply {
    status: StatusCode,
    body: String,
}
#[derive(Clone, Default)]
struct ServerState {
    routes: Arc<Mutex<HashMap<String, VecDeque<Reply>>>>,
    calls: Arc<Mutex<Vec<Call>>>,
}
struct Mock {
    base: String,
    state: ServerState,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Mock {
    fn drop(&mut self) {
        self.task.abort()
    }
}
impl Mock {
    async fn new() -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let state = ServerState::default();
        let app = Router::new()
            .fallback(any(handle))
            .with_state(state.clone());
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        Self { base, state, task }
    }
    fn raw(&self, method: &str, path: &str, status: StatusCode, body: &str) {
        self.state
            .routes
            .lock()
            .unwrap()
            .entry(format!("{method} {path}"))
            .or_default()
            .push_back(Reply {
                status,
                body: body.into(),
            });
    }
    fn reply(&self, method: &str, path: &str, body: Value) {
        self.raw(method, path, StatusCode::OK, &body.to_string())
    }
    fn calls(&self) -> Vec<Call> {
        self.state.calls.lock().unwrap().clone()
    }
}
async fn handle(
    State(state): State<ServerState>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> impl IntoResponse {
    state.calls.lock().unwrap().push(Call {
        method: method.clone(),
        path: uri.to_string(),
        authorization: headers
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .into(),
        body: serde_json::from_slice(&body).unwrap_or(Value::Null),
    });
    let response = state
        .routes
        .lock()
        .unwrap()
        .get_mut(&format!("{method} {}", uri.path()))
        .and_then(VecDeque::pop_front)
        .unwrap_or(Reply {
            status: StatusCode::NOT_FOUND,
            body: "{\"error\":\"no fixture\"}".into(),
        });
    (
        response.status,
        [("content-type", "application/json")],
        response.body,
    )
}
fn setup(base: &str) -> tempfile::TempDir {
    let home = tempfile::tempdir().unwrap();
    db::migrate(home.path()).unwrap();
    db::open(home.path()).unwrap().execute_batch("INSERT INTO users(id,display_name,role,created_at) VALUES('alice','Alice','admin',0),('bob','Bob','member',0);INSERT INTO bots(name,owner_id) VALUES('owl','alice'),('fox','bob');").unwrap();
    fs::write(home.path().join(".env"),format!("XAI_API_KEY='root-x-key'\nXAI_BASE_URL='{base}'\nHASS_TOKEN='root-ha-key'\nHASS_URL='{base}'\nFAL_KEY='root-fal-key'\nFAL_QUEUE_URL='{base}'\n")).unwrap();
    for bot in ["owl", "fox"] {
        let profile = home.path().join("profiles").join(bot);
        fs::create_dir_all(&profile).unwrap();
        common::write_config(&profile,&json!({"tools":{"enabled_toolsets":["x_search","homeassistant","video_gen"]},"x_search":{"model":"fixture-model","retries":0,"reasoning_effort":"high"}})).unwrap();
    }
    fs::write(
        home.path().join("profiles/owl/.env"),
        "XAI_API_KEY='owl-x-key'\nHASS_TOKEN='owl-ha-key'\nFAL_KEY='owl-fal-key'\n",
    )
    .unwrap();
    home
}
async fn call(home: &Path, bot: &str, name: &str, args: Value) -> hexbot_core::Result<Value> {
    native_external_tools::call(
        home,
        if bot == "owl" { "alice" } else { "bob" },
        bot,
        "fixture-section",
        name,
        args,
    )
    .await
    .unwrap()
}

#[tokio::test]
async fn x_search_sends_normalized_query_filters_and_returns_citation_fields() {
    let mock = Mock::new().await;
    let home = setup(&mock.base);
    mock.reply("POST","/responses",json!({"output":[{"content":[{"type":"output_text","text":"Answer one","annotations":[{"type":"url_citation","url":"https://x.com/a/status/1","title":"Post","start_index":0,"end_index":5}]},{"text":"Answer two"}]}],"citations":["https://x.com/a/status/1"]}));
    let out=call(home.path(),"owl","x_search",json!({"query":"  product reactions  ","allowed_x_handles":[" @alice ","@@bob",""],"from_date":"2024-01-01","to_date":"2024-02-01","enable_image_understanding":true})).await.unwrap();
    assert_eq!(out["answer"], "Answer one\n\nAnswer two");
    assert_eq!(out["model"], "fixture-model");
    assert_eq!(out["query"], "product reactions");
    assert_eq!(out["credential_source"], "xai");
    assert_eq!(out["degraded"], false);
    assert!(out["degraded_reason"].is_null());
    assert_eq!(
        out["inline_citations"][0]["url"],
        "https://x.com/a/status/1"
    );
    let calls = mock.calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].authorization, "Bearer owl-x-key");
    assert_eq!(calls[0].method, Method::POST);
    assert_eq!(calls[0].body["input"][0]["content"], "product reactions");
    assert_eq!(
        calls[0].body["tools"][0]["allowed_x_handles"],
        json!(["alice", "bob"])
    );
    assert_eq!(
        calls[0].body["tools"][0]["enable_image_understanding"],
        true
    );
    assert_eq!(calls[0].body["reasoning"], json!({"effort":"high"}));
    assert_eq!(calls[0].body["store"], false);
    assert!(!out.to_string().contains("owl-x-key"));
}
#[tokio::test]
async fn x_search_reports_degraded_filters_and_scopes_credentials() {
    let mock = Mock::new().await;
    let home = setup(&mock.base);
    for _ in 0..2 {
        mock.reply(
            "POST",
            "/responses",
            json!({"output_text":"No matching posts"}),
        );
    }
    let out = call(
        home.path(),
        "owl",
        "x_search",
        json!({"query":"none","excluded_x_handles":["x"],"from_date":"2020-01-01"}),
    )
    .await
    .unwrap();
    assert_eq!(out["degraded"], true);
    assert_eq!(
        out["degraded_reason"],
        "no citations returned despite filters: excluded_x_handles, from_date"
    );
    assert_eq!(
        call(home.path(), "fox", "x_search", json!({"query":"none"}))
            .await
            .unwrap()["degraded"],
        false
    );
    let calls = mock.calls();
    assert_eq!(calls[0].authorization, "Bearer owl-x-key");
    assert_eq!(calls[1].authorization, "Bearer root-x-key");
}
#[tokio::test]
async fn x_search_validates_dates_filters_and_config_before_network() {
    let mock = Mock::new().await;
    let home = setup(&mock.base);
    for args in [
        json!({"query":" "}),
        json!({"query":"q","from_date":"2024-2-01"}),
        json!({"query":"q","from_date":"2023-02-29"}),
        json!({"query":"q","from_date":"2999-01-01"}),
        json!({"query":"q","from_date":"2024-02-01","to_date":"2024-01-01"}),
        json!({"query":"q","allowed_x_handles":["a"],"excluded_x_handles":["b"]}),
        json!({"query":"q","allowed_x_handles":vec!["a";11]}),
        json!({"query":"q","allowed_x_handles":"a"}),
    ] {
        assert_eq!(
            call(home.path(), "owl", "x_search", args)
                .await
                .unwrap_err()
                .code,
            4200
        );
    }
    let profile = home.path().join("profiles/owl");
    let mut cfg = common::read_config(&profile).unwrap();
    cfg["x_search"]["reasoning_effort"] = json!("invalid");
    common::write_config(&profile, &cfg).unwrap();
    assert_eq!(
        call(home.path(), "owl", "x_search", json!({"query":"q"}))
            .await
            .unwrap_err()
            .code,
        4200
    );
    assert!(mock.calls().is_empty());
}
#[tokio::test]
async fn x_search_retries_5xx_but_not_auth_or_malformed_responses() {
    let mock = Mock::new().await;
    let home = setup(&mock.base);
    let profile = home.path().join("profiles/owl");
    let mut cfg = common::read_config(&profile).unwrap();
    cfg["x_search"]["retries"] = json!(1);
    common::write_config(&profile, &cfg).unwrap();
    mock.raw(
        "POST",
        "/responses",
        StatusCode::BAD_GATEWAY,
        "temporarily unavailable",
    );
    mock.reply("POST", "/responses", json!({"output_text":"Recovered"}));
    assert_eq!(
        call(home.path(), "owl", "x_search", json!({"query":"q"}))
            .await
            .unwrap()["answer"],
        "Recovered"
    );
    assert_eq!(mock.calls().len(), 2);
    mock.raw(
        "POST",
        "/responses",
        StatusCode::UNAUTHORIZED,
        "secret response should not leak",
    );
    assert_eq!(
        call(home.path(), "owl", "x_search", json!({"query":"q"}))
            .await
            .unwrap_err()
            .message,
        "Tool provider returned HTTP 401"
    );
    assert_eq!(mock.calls().len(), 3);
    mock.raw("POST", "/responses", StatusCode::OK, "broken json");
    assert_eq!(
        call(home.path(), "owl", "x_search", json!({"query":"q"}))
            .await
            .unwrap_err()
            .message,
        "Tool provider returned invalid JSON"
    );
    assert_eq!(mock.calls().len(), 4);
}
#[tokio::test]
async fn x_search_oauth_only_credentials_are_advertised_and_used() {
    let mock = Mock::new().await;
    let home = setup(&mock.base);
    fs::write(
        home.path().join(".env"),
        format!("XAI_BASE_URL='{}'\n", mock.base),
    )
    .unwrap();
    fs::write(home.path().join("profiles/owl/.env"), "").unwrap();
    fs::write(home.path().join("profiles/owl/auth.json"),json!({"providers":{"xai-oauth":{"access_token":"owl-oauth-token","refresh_token":"unused-refresh","expires_at":common::now()+3600.0}}}).to_string()).unwrap();
    assert!(connectors::tool_available(home.path(), "owl", "x_search").unwrap());
    assert!(
        native_external_tools::descriptors(home.path(), "owl")
            .unwrap()
            .iter()
            .any(|t| t["name"] == "x_search")
    );
    mock.reply("POST", "/responses", json!({"output_text":"OAuth answer"}));
    let out = call(home.path(), "owl", "x_search", json!({"query":"q"}))
        .await
        .unwrap();
    assert_eq!(out["credential_source"], "xai-oauth");
    assert_eq!(mock.calls()[0].authorization, "Bearer owl-oauth-token");
}
#[tokio::test]
async fn home_assistant_preserves_filters_state_service_fields_and_json_string_data() {
    let mock = Mock::new().await;
    let home = setup(&mock.base);
    mock.reply("GET","/api/states",json!([{"entity_id":"light.kitchen","state":"on","attributes":{"friendly_name":"Kitchen main"}},{"entity_id":"light.bedroom","state":"off","attributes":{"friendly_name":"Bedroom lamp"}},{"entity_id":"sensor.kitchen","state":"21","attributes":{"friendly_name":"Kitchen temperature"}}]));
    assert_eq!(
        call(
            home.path(),
            "owl",
            "ha_list_entities",
            json!({"domain":"light","area":"KITCHEN"})
        )
        .await
        .unwrap(),
        json!({"result":{"count":1,"entities":[{"entity_id":"light.kitchen","state":"on","friendly_name":"Kitchen main"}]}})
    );
    let state = json!({"entity_id":"light.kitchen","state":"on","attributes":{"brightness":42}});
    mock.reply("GET", "/api/states/light.kitchen", state.clone());
    assert_eq!(
        call(
            home.path(),
            "owl",
            "ha_get_state",
            json!({"entity_id":"light.kitchen"})
        )
        .await
        .unwrap(),
        json!({"result":state})
    );
    mock.reply("GET","/api/services",json!([{"domain":"light","services":{"turn_on":{"description":"Light on","fields":{"brightness":{"description":"Brightness level","example":42}}}}},{"domain":"switch","services":{"toggle":{"description":"Toggle"}}}]));
    assert_eq!(
        call(
            home.path(),
            "owl",
            "ha_list_services",
            json!({"domain":"light"})
        )
        .await
        .unwrap(),
        json!({"result":{"count":1,"domains":[{"domain":"light","services":{"turn_on":{"description":"Light on","fields":{"brightness":"Brightness level"}}}}]}})
    );
    mock.reply(
        "POST",
        "/api/services/light/turn_on",
        json!([{"entity_id":"light.kitchen","state":"on"}]),
    );
    let out=call(home.path(),"owl","ha_call_service",json!({"domain":"light","service":"turn_on","entity_id":"light.kitchen","data":"{\"brightness\":128,\"entity_id\":\"light.other\"}"})).await.unwrap();
    assert_eq!(
        out,
        json!({"result":{"success":true,"service":"light.turn_on","affected_entities":[{"entity_id":"light.kitchen","state":"on"}]}})
    );
    let calls = mock.calls();
    assert_eq!(calls.len(), 4);
    assert!(calls.iter().all(|c| c.authorization == "Bearer owl-ha-key"));
    assert_eq!(
        calls[3].body,
        json!({"brightness":128,"entity_id":"light.kitchen"})
    );
}
#[tokio::test]
async fn home_assistant_blocks_execution_domains_and_traversal_before_requests() {
    let mock = Mock::new().await;
    let home = setup(&mock.base);
    for domain in [
        "shell_command",
        "command_line",
        "python_script",
        "pyscript",
        "hassio",
        "rest_command",
    ] {
        assert_eq!(
            call(
                home.path(),
                "owl",
                "ha_call_service",
                json!({"domain":domain,"service":"run"})
            )
            .await
            .unwrap_err()
            .code,
            4302
        );
    }
    for args in [
        json!({"domain":"shell_command/../light","service":"turn_on"}),
        json!({"domain":"light","service":"../turn_on"}),
        json!({"domain":"Light","service":"turn_on"}),
        json!({"domain":"light","service":"turn_on","entity_id":"sensor.%2fconfig"}),
        json!({"domain":"light","service":"turn_on","data":"[]"}),
        json!({"domain":"light","service":"turn_on","data":"broken json"}),
    ] {
        assert_eq!(
            call(home.path(), "owl", "ha_call_service", args)
                .await
                .unwrap_err()
                .code,
            4200
        );
    }
    for id in ["../config", "light.a/../../config", "light.%2fconfig"] {
        assert_eq!(
            call(home.path(), "owl", "ha_get_state", json!({"entity_id":id}))
                .await
                .unwrap_err()
                .code,
            4200
        );
    }
    assert!(mock.calls().is_empty());
}
#[tokio::test]
async fn home_assistant_rejects_invalid_responses_and_uses_root_fallback_credentials() {
    let mock = Mock::new().await;
    let home = setup(&mock.base);
    mock.reply("GET", "/api/states", json!({"unexpected":"object"}));
    assert_eq!(
        call(home.path(), "fox", "ha_list_entities", json!({}))
            .await
            .unwrap_err()
            .message,
        "Home Assistant returned invalid states"
    );
    assert_eq!(mock.calls()[0].authorization, "Bearer root-ha-key");
    mock.raw(
        "GET",
        "/api/services",
        StatusCode::FORBIDDEN,
        "private provider text",
    );
    let error = call(home.path(), "owl", "ha_list_services", json!({}))
        .await
        .unwrap_err();
    assert!(error.message.contains("403"));
    assert!(!error.message.contains("private"));
}
const VIDEO_ENDPOINT: &str = "/fal-ai/pixverse/v6/text-to-video";
#[tokio::test]
async fn fal_video_submits_scoped_payload_and_polls_same_origin_queue() {
    let mock = Mock::new().await;
    let home = setup(&mock.base);
    mock.reply("POST",VIDEO_ENDPOINT,json!({"request_id":"request-1","status_url":format!("{}/queue/request-1/status",mock.base),"response_url":format!("{}/queue/request-1/result",mock.base)}));
    mock.reply(
        "GET",
        "/queue/request-1/status",
        json!({"status":"COMPLETED"}),
    );
    mock.reply(
        "GET",
        "/queue/request-1/result",
        json!({"video":{"url":"https://cdn.example.test/video.mp4"}}),
    );
    let out=call(home.path(),"owl","video_generate",json!({"prompt":"A calm lake","duration":99,"resolution":"1080p","audio":false,"negative_prompt":"blur","seed":3})).await.unwrap();
    assert_eq!(out["success"], true);
    assert_eq!(out["video"], "https://cdn.example.test/video.mp4");
    assert_eq!(out["model"], "pixverse-v6");
    assert_eq!(out["modality"], "text");
    assert_eq!(out["provider"], "fal");
    let calls = mock.calls();
    assert_eq!(calls.len(), 3);
    assert!(calls.iter().all(|c| c.authorization == "Key owl-fal-key"));
    assert_eq!(calls[0].body["prompt"], "A calm lake");
    assert_eq!(calls[0].body["duration"], "15");
    assert_eq!(calls[0].body["generate_audio"], false);
    assert_eq!(calls[0].body["negative_prompt"], "blur");
    assert_eq!(calls[0].body["seed"], 3);
    assert!(!out.to_string().contains("owl-fal-key"));
}
#[tokio::test]
async fn fal_video_uses_model_capabilities_for_images_and_optional_upscale() {
    let mock = Mock::new().await;
    let home = setup(&mock.base);
    let models: Value = serde_json::from_str(include_str!("../src/fal_video_models.json")).unwrap();
    let image_endpoint = format!(
        "/{}",
        models["minimax-h3"]["image_endpoint"].as_str().unwrap()
    );
    mock.reply(
        "POST",
        &image_endpoint,
        json!({"video":{"url":"https://cdn.example.test/original.mp4"}}),
    );
    mock.reply(
        "POST",
        "/fal-ai/seedvr/upscale/video",
        json!({"video":{"url":"https://cdn.example.test/upscaled.mp4"}}),
    );
    let out=call(home.path(),"fox","video_generate",json!({"prompt":"Animate clouds","model":"minimax-h3","image_url":"data:image/png;base64,aW1hZ2U=","duration":99,"resolution":"1080p","aspect_ratio":"9:16","seed":6,"upscale":true})).await.unwrap();
    assert_eq!(out["video"], "https://cdn.example.test/upscaled.mp4");
    assert_eq!(out["upscaled"], true);
    assert_eq!(out["modality"], "image");
    let calls = mock.calls();
    assert_eq!(calls[0].authorization, "Key root-fal-key");
    assert_eq!(calls[0].body["duration"], 15);
    assert_eq!(calls[0].body["resolution"], "2K");
    assert!(calls[0].body.get("seed").is_none());
    assert!(calls[0].body.get("aspect_ratio").is_none());
    assert_eq!(
        calls[1].body["video_url"],
        "https://cdn.example.test/original.mp4"
    );
}
#[tokio::test]
async fn fal_video_refuses_foreign_queue_urls_and_malformed_request_ids() {
    let mock = Mock::new().await;
    let foreign = Mock::new().await;
    let home = setup(&mock.base);
    for submitted in [
        json!({"request_id":"request-1","response_url":format!("{}/stolen",foreign.base),"status_url":format!("{}/status",mock.base)}),
        json!({"request_id":"request-1","response_url":format!("{}/result",mock.base),"status_url":format!("{}/stolen",foreign.base)}),
        json!({"request_id":"../admin"}),
        json!({"request_id":"a%2fadmin"}),
        json!({"request_id":"a?secret"}),
        json!({"request_id":"request-1","response_url":mock.base.replace("http://","http://attacker:password@"),"status_url":format!("{}/status",mock.base)}),
    ] {
        mock.reply("POST", VIDEO_ENDPOINT, submitted);
        assert!(
            call(
                home.path(),
                "owl",
                "video_generate",
                json!({"prompt":"test"})
            )
            .await
            .is_err()
        );
    }
    assert!(foreign.calls().is_empty());
    assert!(mock.calls().iter().all(|c| c.path == VIDEO_ENDPOINT));
}
#[tokio::test]
async fn fal_video_fails_for_queue_failure_and_missing_video_and_rejects_unknown_model() {
    let mock = Mock::new().await;
    let home = setup(&mock.base);
    for args in [
        json!({"prompt":"test","model":"../../admin"}),
        json!({"prompt":"test","operation":"edit"}),
        json!({"prompt":"test","video_url":"https://example.test/video"}),
    ] {
        assert_eq!(
            call(home.path(), "owl", "video_generate", args)
                .await
                .unwrap_err()
                .code,
            4200
        );
    }
    assert!(mock.calls().is_empty());
    mock.reply("POST", VIDEO_ENDPOINT, json!({"request_id":"r"}));
    let status = format!("{VIDEO_ENDPOINT}/requests/r/status");
    mock.reply(
        "GET",
        &status,
        json!({"status":"FAILED","error":"private details"}),
    );
    assert_eq!(
        call(
            home.path(),
            "owl",
            "video_generate",
            json!({"prompt":"test"})
        )
        .await
        .unwrap_err()
        .message,
        "Video generation failed"
    );
    mock.reply("POST", VIDEO_ENDPOINT, json!({"video":{}}));
    assert_eq!(
        call(
            home.path(),
            "owl",
            "video_generate",
            json!({"prompt":"test"})
        )
        .await
        .unwrap_err()
        .message,
        "FAL returned no video"
    );
}
#[tokio::test]
async fn external_tool_disablement_and_active_identity_are_enforced() {
    let mock = Mock::new().await;
    let home = setup(&mock.base);
    let mut cfg = common::read_config(&home.path().join("profiles/owl")).unwrap();
    cfg["tools"]["enabled_toolsets"] = json!([]);
    common::write_config(&home.path().join("profiles/owl"), &cfg).unwrap();
    assert!(
        native_external_tools::descriptors(home.path(), "owl")
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        call(home.path(), "owl", "x_search", json!({"query":"q"}))
            .await
            .unwrap_err()
            .code,
        4302
    );
    db::open(home.path())
        .unwrap()
        .execute("UPDATE users SET disabled_at=1 WHERE id='bob'", [])
        .unwrap();
    assert_eq!(
        call(home.path(), "fox", "ha_list_entities", json!({}))
            .await
            .unwrap_err()
            .code,
        4302
    );
    assert!(mock.calls().is_empty());
}

#[tokio::test]
async fn external_tools_require_ownership_or_active_shared_room_session() {
    let mock = Mock::new().await;
    let home = setup(&mock.base);
    let denied = native_external_tools::call(
        home.path(),
        "bob",
        "owl",
        "fake-session",
        "ha_list_entities",
        json!({}),
    )
    .await
    .unwrap()
    .unwrap_err();
    assert_eq!(denied.code, 4302);
    assert!(mock.calls().is_empty());
    db::open(home.path()).unwrap().execute_batch("UPDATE bots SET shareable=1 WHERE name='owl';INSERT INTO rooms(id,name,owner_id) VALUES('room','Shared','bob');INSERT INTO room_sessions(room_id,bot,stored_session_id) VALUES('room','owl','shared-session');INSERT INTO room_members(room_id,member_kind,member_id) VALUES('room','bot','owl');").unwrap();
    assert_eq!(
        native_external_tools::call(
            home.path(),
            "bob",
            "owl",
            "fake-session",
            "ha_list_entities",
            json!({})
        )
        .await
        .unwrap()
        .unwrap_err()
        .code,
        4302
    );
    mock.reply("GET", "/api/states", json!([]));
    let result = native_external_tools::call(
        home.path(),
        "bob",
        "owl",
        "shared-session",
        "ha_list_entities",
        json!({}),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(result["result"]["count"], 0);
    assert_eq!(mock.calls()[0].authorization, "Bearer owl-ha-key");
    db::open(home.path())
        .unwrap()
        .execute("UPDATE room_members SET left_at=1 WHERE room_id='room'", [])
        .unwrap();
    assert_eq!(
        native_external_tools::call(
            home.path(),
            "bob",
            "owl",
            "shared-session",
            "ha_list_entities",
            json!({})
        )
        .await
        .unwrap()
        .unwrap_err()
        .code,
        4302
    );
    assert_eq!(mock.calls().len(), 1);
}
