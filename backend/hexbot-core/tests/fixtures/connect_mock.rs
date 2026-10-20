use super::common;
use axum::{
    Json, Router,
    extract::{Request, State},
    http::StatusCode,
    response::IntoResponse,
    routing::any,
};
use serde_json::{Value, json};
use std::{fs, sync::Arc, time::Duration};
use tokio::sync::{Mutex, mpsc};

pub(super) fn jwks() -> Value {
    json!({"keys":[{"kty":"EC","crv":"P-256","alg":"ES256","use":"sig","kid":"fixture","x":"8S1Ae4m2GSQVPamKe5j4wnP30H1nrXdRwU8bp-hxy6A","y":"yKXIh8cwjwT0p2kwh-DJnxxDq0KXz6zfhfmBuK570P0"}]})
}
pub(super) struct StateData {
    pub(super) response: Mutex<Value>,
    pub(super) keys: Mutex<Value>,
    observed: mpsc::UnboundedSender<(String, Value, String)>,
    pub(super) bad: Mutex<bool>,
    pub(super) legacy_poll: Mutex<bool>,
    pub(super) identity_gate: Mutex<Option<Arc<tokio::sync::Notify>>>,
    pub(super) binary: Mutex<Vec<u8>>,
    pub(super) manifest: Mutex<Value>,
    /// Sign native manifests with a key the daemon does not trust.
    pub(super) unsigned: Mutex<bool>,
    /// Per-path replies `(status, body)`, for routes the daemon must handle by status.
    pub(super) overrides: Mutex<std::collections::HashMap<String, (u16, Value)>>,
}
pub(super) struct Mock {
    pub(super) base: String,
    pub(super) data: Arc<StateData>,
    pub(super) events: mpsc::UnboundedReceiver<(String, Value, String)>,
    pending: Vec<(String, Value, String)>,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Mock {
    fn drop(&mut self) {
        self.task.abort();
    }
}
async fn handler(
    State(state): State<Arc<StateData>>,
    request: Request,
) -> axum::response::Response {
    let path = request.uri().path().to_owned();
    let auth = request
        .headers()
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_owned();
    let body = axum::body::to_bytes(request.into_body(), 1024 * 1024)
        .await
        .unwrap();
    let body: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    let reject_key = path == "/api/register/poll"
        && body.get("public_key").is_some()
        && *state.legacy_poll.lock().await;
    let _ = state.observed.send((path.clone(), body, auth));
    if path.ends_with("/identity")
        && let Some(gate) = state.identity_gate.lock().await.clone()
    {
        gate.notified().await;
    }
    if reject_key {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"invalid_request"})),
        )
            .into_response();
    }
    if *state.bad.lock().await {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    if let Some((status, body)) = state.overrides.lock().await.get(&path) {
        return (StatusCode::from_u16(*status).unwrap(), Json(body.clone())).into_response();
    }
    let value = match path.as_str() {
        "/api/register/start" => {
            json!({"device_code":"device-code","user_code":"ABCD1234","verify_url":"https://connect.example/approve","interval":1})
        }
        "/api/register/poll" => state.response.lock().await.clone(),
        "/.well-known/jwks.json" => state.keys.lock().await.clone(),
        "/binary" => return state.binary.lock().await.clone().into_response(),
        path if path.ends_with("/manifest.json") => state.manifest.lock().await.clone(),
        path if path.ends_with("/manifest.json.sig") => {
            use base64::Engine;
            use sha2::Digest;
            // Debug builds trust the key from this public seed (update_signature.rs).
            let seed = if *state.unsigned.lock().await {
                [7; 32].into()
            } else {
                sha2::Sha256::digest(b"hexbot update signing test key")
            };
            let manifest = serde_json::to_vec(&*state.manifest.lock().await).unwrap();
            let key = ring::signature::Ed25519KeyPair::from_seed_unchecked(&seed).unwrap();
            return base64::engine::general_purpose::STANDARD
                .encode(key.sign(&manifest))
                .into_response();
        }
        _ => json!({"ok":true}),
    };
    Json(value).into_response()
}
impl Mock {
    pub(super) async fn new() -> Self {
        let (sender, events) = mpsc::unbounded_channel();
        let data = Arc::new(StateData {
            keys: Mutex::new(jwks()),
            response: Mutex::new(json!({"status":"pending"})),
            observed: sender,
            bad: Mutex::new(false),
            legacy_poll: Mutex::new(false),
            identity_gate: Mutex::default(),
            binary: Mutex::new(vec![]),
            manifest: Mutex::new(Value::Null),
            unsigned: Mutex::default(),
            overrides: Mutex::default(),
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let app = Router::new()
            .fallback(any(handler))
            .with_state(data.clone());
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        Self {
            base,
            data,
            events,
            pending: vec![],
            task,
        }
    }
    pub(super) async fn event(&mut self, path: &str) -> (Value, String) {
        if let Some(index) = self.pending.iter().position(|item| item.0 == path) {
            let (_, body, auth) = self.pending.remove(index);
            return (body, auth);
        }
        // Generous: a loaded machine starts node stand-ins slowly, and a wait here only
        // delays a failure, never a success.
        tokio::time::timeout(Duration::from_secs(30), async {
            loop {
                let (seen, body, auth) = self.events.recv().await.unwrap();
                if seen == path {
                    return (body, auth);
                }
                self.pending.push((seen, body, auth));
            }
        })
        .await
        .unwrap()
    }
    pub(super) fn configure(&self, home: &std::path::Path) {
        common::write_config(home,&json!({"connect":{"api_base":self.base},"updates":{"base_url":self.base},"model":"keep"})).unwrap();
    }
    pub(super) fn persist_registration(&self, home: &std::path::Path) {
        fs::write(home.join("connect.json"),serde_json::to_vec(&json!({"api_base":self.base,"daemon_id":"daemon-1","daemon_token":"daemon-secret","slug":"kitchen","tunnel_hostname":"kitchen.connect.example","tunnel_token":"tunnel-secret","owner_id":"cloud-user","issuer":"https://connect.hexbot.app","keys":jwks()["keys"]})).unwrap()).unwrap();
    }
}
