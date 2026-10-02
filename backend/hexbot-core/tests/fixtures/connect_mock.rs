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
    pub(super) binary: Mutex<Vec<u8>>,
    pub(super) manifest: Mutex<Value>,
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
    let body = serde_json::from_slice(&body).unwrap_or(Value::Null);
    let _ = state.observed.send((path.clone(), body, auth));
    if *state.bad.lock().await {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    let value = match path.as_str() {
        "/api/register/start" => {
            json!({"device_code":"device-code","user_code":"ABCD1234","verify_url":"https://connect.example/approve","interval":1})
        }
        "/api/register/poll" => state.response.lock().await.clone(),
        "/.well-known/jwks.json" => state.keys.lock().await.clone(),
        "/binary" => return state.binary.lock().await.clone().into_response(),
        path if path.ends_with("/manifest.json") => state.manifest.lock().await.clone(),
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
            binary: Mutex::new(vec![]),
            manifest: Mutex::new(Value::Null),
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
        tokio::time::timeout(Duration::from_secs(10), async {
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
