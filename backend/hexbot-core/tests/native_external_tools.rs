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
    fs::write(home.path().join(".env"),format!("XAI_API_KEY='root-x-key'\nXAI_BASE_URL='{base}'\nHEXBOT_X_API_BASE_URL='{base}'\n")).unwrap();
    for bot in ["owl", "fox"] {
        let profile = home.path().join("profiles").join(bot);
        fs::create_dir_all(&profile).unwrap();
        common::write_config(&profile,&json!({"tools":{"enabled_toolsets":["x_search"]},"x_search":{"model":"fixture-model","retries":0,"reasoning_effort":"high"}})).unwrap();
    }
    fs::write(
        home.path().join("profiles/owl/.env"),
        "XAI_API_KEY='owl-x-key'\n",
    )
    .unwrap();
    home
}
async fn call(home: &Path, bot: &str, name: &str, args: Value) -> hexbot_core::Result<Value> {
    native_external_tools::call(
        home,
        if bot == "owl" { "alice" } else { "bob" },
        bot,
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
        call(home.path(), "fox", "x_search", json!({"query":"q"}))
            .await
            .unwrap_err()
            .code,
        4302
    );
    assert!(mock.calls().is_empty());
}

#[tokio::test]
async fn external_tools_require_ownership() {
    let mock = Mock::new().await;
    let home = setup(&mock.base);
    let denied =
        native_external_tools::call(home.path(), "bob", "owl", "x_search", json!({"query":"q"}))
            .await
            .unwrap()
            .unwrap_err();
    assert_eq!(denied.code, 4302);
    assert!(mock.calls().is_empty());
}

fn choose(home: &Path, provider: &str) {
    let mut cfg = common::read_config(home).unwrap();
    cfg["x_search"]["provider"] = json!(provider);
    common::write_config(home, &cfg).unwrap();
}

#[tokio::test]
async fn x_api_search_sends_the_query_with_handles_and_returns_posts() {
    let mock = Mock::new().await;
    let home = setup(&mock.base);
    fs::write(
        home.path().join(".env"),
        format!("X_BEARER_TOKEN='root-x-bearer'\nHEXBOT_X_API_BASE_URL='{}'\n", mock.base),
    )
    .unwrap();
    fs::write(home.path().join("profiles/owl/.env"), "").unwrap();
    choose(home.path(), "x_api");
    assert!(connectors::tool_available(home.path(), "owl", "x_search").unwrap());
    let today = chrono::Utc::now().date_naive();
    mock.reply(
        "GET",
        "/2/tweets/search/recent",
        json!({
            "data":[
                {"id":"11","text":"Love it","author_id":"1","created_at":"2026-11-07T10:00:00.000Z","public_metrics":{"like_count":3}},
                {"id":"12","text":"Meh","author_id":"9","created_at":"2026-11-06T10:00:00.000Z"}
            ],
            "includes":{"users":[{"id":"1","username":"alice","name":"Alice"}]},
            "meta":{"result_count":2}
        }),
    );
    let out = call(
        home.path(),
        "owl",
        "x_search",
        json!({"query":" product reactions ","allowed_x_handles":["@alice","bob"],"from_date":today.to_string(),"enable_image_understanding":true}),
    )
    .await
    .unwrap();
    assert_eq!(out["provider"], "x_api");
    assert_eq!(out["archive"], false);
    assert_eq!(out["posts"][0]["url"], "https://x.com/alice/status/11");
    assert_eq!(out["posts"][1]["url"], "https://x.com/i/status/12");
    assert_eq!(
        out["citations"],
        json!(["https://x.com/alice/status/11", "https://x.com/i/status/12"])
    );
    assert_eq!(
        out["answer"],
        "@alice (2026-11-07): Love it\nhttps://x.com/alice/status/11\n\n@unknown (2026-11-06): Meh\nhttps://x.com/i/status/12"
    );
    assert!(out["note"].is_string());
    let calls = mock.calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].method, Method::GET);
    assert_eq!(calls[0].authorization, "Bearer root-x-bearer");
    let url = reqwest::Url::parse(&format!("http://x{}", calls[0].path)).unwrap();
    let params = url
        .query_pairs()
        .into_owned()
        .collect::<std::collections::HashMap<_, _>>();
    assert_eq!(
        params["query"],
        "(product reactions) (from:alice OR from:bob)"
    );
    assert_eq!(params["start_time"], format!("{today}T00:00:00Z"));
    assert!(!params.contains_key("end_time"));
    assert_eq!(params["max_results"], "20");
    assert!(!out.to_string().contains("root-x-bearer"));
}

#[tokio::test]
async fn x_api_search_goes_to_the_archive_for_old_dates_and_explains_refusals() {
    let mock = Mock::new().await;
    let home = setup(&mock.base);
    fs::write(
        home.path().join(".env"),
        format!("X_BEARER_TOKEN='root-x-bearer'\nHEXBOT_X_API_BASE_URL='{}'\n", mock.base),
    )
    .unwrap();
    choose(home.path(), "x_api");
    mock.reply("GET", "/2/tweets/search/all", json!({"meta":{"result_count":0}}));
    let out = call(
        home.path(),
        "owl",
        "x_search",
        json!({"query":"launch OR release","excluded_x_handles":["spam"],"from_date":"2024-01-01","to_date":"2024-01-31"}),
    )
    .await
    .unwrap();
    assert_eq!(out["archive"], true);
    assert_eq!(out["answer"], "No posts matched.");
    let path = &mock.calls()[0].path;
    assert!(path.starts_with("/2/tweets/search/all?"));
    assert!(path.contains("start_time=2024-01-01T00%3A00%3A00Z"));
    assert!(path.contains("end_time=2024-02-01T00%3A00%3A00Z"));
    // The exclusion covers both sides of the OR.
    assert!(path.contains("query=%28launch+OR+release%29+-from%3Aspam"), "{path}");
    for (status, text) in [
        (StatusCode::UNAUTHORIZED, "X refused the bearer token"),
        (StatusCode::PAYMENT_REQUIRED, "no credits left"),
        (StatusCode::TOO_MANY_REQUESTS, "rate limit"),
    ] {
        mock.raw("GET", "/2/tweets/search/recent", status, "{}");
        let err = call(home.path(), "owl", "x_search", json!({"query":"q"}))
            .await
            .unwrap_err();
        assert!(err.message.contains(text), "{}", err.message);
    }
}

#[tokio::test]
async fn x_search_uses_the_chosen_xai_credential() {
    let mock = Mock::new().await;
    let home = setup(&mock.base);
    fs::write(home.path().join("profiles/owl/auth.json"),json!({"providers":{"xai-oauth":{"access_token":"owl-oauth-token","refresh_token":"unused-refresh","expires_at":common::now()+3600.0}}}).to_string()).unwrap();
    for _ in 0..3 {
        mock.reply("POST", "/responses", json!({"output_text":"answer"}));
    }
    // With nothing chosen, the key comes first, as before.
    let out = call(home.path(), "owl", "x_search", json!({"query":"q"}))
        .await
        .unwrap();
    assert_eq!(out["credential_source"], "xai");
    choose(home.path(), "supergrok");
    let out = call(home.path(), "owl", "x_search", json!({"query":"q"}))
        .await
        .unwrap();
    assert_eq!(out["credential_source"], "xai-oauth");
    // Fox has no sign-in of its own, so the subscription is not set up for it.
    assert!(!connectors::tool_available(home.path(), "fox", "x_search").unwrap());
    choose(home.path(), "xai");
    let out = call(home.path(), "owl", "x_search", json!({"query":"q"}))
        .await
        .unwrap();
    assert_eq!(out["credential_source"], "xai");
    let auth = mock
        .calls()
        .iter()
        .map(|c| c.authorization.clone())
        .collect::<Vec<_>>();
    assert_eq!(
        auth,
        ["Bearer owl-x-key", "Bearer owl-oauth-token", "Bearer owl-x-key"]
    );
}
