//! Preview: a page a bot serves on one of the user's computers, shown beside
//! the chat. The daemon mints a link, `/hexbot/preview/<token>/…`, and
//! forwards it to `127.0.0.1:<port>` on the daemon's computer, or through a
//! desktop app's connection to the computer it lent, so every client reaches
//! it as it reaches the daemon: on this computer, over LAN or Tailscale, and
//! through Hex Connect. The bots' computer shows pages in its own browser.
//!
//! The page is the bot's, not Hexbot's, so it never runs as the daemon's
//! origin: every response carries a CSP `sandbox` without
//! `allow-same-origin`, which gives it an opaque origin, and cookies and
//! credentials are dropped both ways.
use crate::{Error, Result};
use axum::{
    body::Body,
    extract::Request,
    http::{HeaderMap, HeaderName, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

/// A link lasts this long; the bot opens a new one after.
const LIFETIME: Duration = Duration::from_secs(4 * 3600);
/// Request and response bodies stop here.
const BODY_LIMIT: usize = 16 * 1024 * 1024;
/// What a previewed page may do: run, submit forms, open its own windows.
/// Never `allow-same-origin`: it is not the daemon's page.
const SANDBOX: &str = "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads; frame-ancestors 'self' hexbot-app: http://localhost:* http://127.0.0.1:*";

#[derive(Clone, Debug, PartialEq, Eq)]
enum Target {
    Daemon,
    Device(String),
}

#[derive(Clone)]
struct Link {
    home: PathBuf,
    target: Target,
    port: u16,
    made: Instant,
}

fn links() -> &'static Mutex<HashMap<String, Link>> {
    static LINKS: OnceLock<Mutex<HashMap<String, Link>>> = OnceLock::new();
    LINKS.get_or_init(Default::default)
}

/// A link to `port` on a computer: the daemon's, or a lent one (`device`).
/// The path starts at the page the bot named.
pub fn open(home: &Path, device: Option<&str>, port: u16, path: &str) -> Result<String> {
    if port == 0 {
        return Err(Error::new(4202, "port must be between 1 and 65535"));
    }
    let token = crate::common::id();
    let mut links = links().lock().unwrap_or_else(|e| e.into_inner());
    links.retain(|_, link| link.made.elapsed() < LIFETIME);
    links.insert(
        token.clone(),
        Link {
            home: home.to_owned(),
            target: device.map_or(Target::Daemon, |d| Target::Device(d.to_owned())),
            port,
            made: Instant::now(),
        },
    );
    let path = path.trim_start_matches('/');
    Ok(format!("/hexbot/preview/{token}/{path}"))
}

fn refused(status: StatusCode, text: &str) -> Response {
    let mut response = (status, text.to_owned()).into_response();
    response.headers_mut().insert(
        axum::http::header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(SANDBOX),
    );
    response
}

/// Headers that never cross: hop-by-hop ones, and anything that carries a
/// credential or lets the page out of its sandbox.
const DROPPED: [&str; 16] = [
    "host",
    "connection",
    "keep-alive",
    "transfer-encoding",
    "upgrade",
    "te",
    "trailer",
    "content-length",
    "cookie",
    "set-cookie",
    "authorization",
    "proxy-authorization",
    "dpop",
    "content-security-policy",
    "x-frame-options",
    "origin",
];
fn kept(name: &str) -> bool {
    !DROPPED.contains(&name.to_ascii_lowercase().as_str())
}

/// Serve one request under `/hexbot/preview/<token>/<rest>`.
pub async fn proxy(token: String, rest: String, request: Request) -> Response {
    let link = {
        let links = links().lock().unwrap_or_else(|e| e.into_inner());
        links
            .get(&token)
            .filter(|link| link.made.elapsed() < LIFETIME)
            .cloned()
    };
    let Some(link) = link else {
        return refused(
            StatusCode::NOT_FOUND,
            "This preview ended. Ask the bot to open it again.",
        );
    };
    let (parts, body) = request.into_parts();
    let Ok(body) = axum::body::to_bytes(body, BODY_LIMIT).await else {
        return refused(StatusCode::PAYLOAD_TOO_LARGE, "That request is too large.");
    };
    let query = parts
        .uri
        .query()
        .map(|q| format!("?{q}"))
        .unwrap_or_default();
    let path = format!("/{}{query}", rest.trim_start_matches('/'));
    let headers = parts
        .headers
        .iter()
        .filter(|(name, _)| kept(name.as_str()))
        .filter_map(|(name, value)| Some((name.to_string(), value.to_str().ok()?.to_owned())))
        .collect::<Vec<_>>();
    let answer = match &link.target {
        Target::Daemon => {
            daemon(
                link.port,
                parts.method.as_str(),
                &path,
                &headers,
                body.to_vec(),
            )
            .await
        }
        Target::Device(device) => {
            lent(
                &link.home,
                device,
                link.port,
                parts.method.as_str(),
                &path,
                &headers,
                &body,
            )
            .await
        }
    };
    match answer {
        Ok((status, headers, body)) => respond(status, &headers, body),
        Err(error) => refused(StatusCode::BAD_GATEWAY, &error.message),
    }
}

type Answer = (u16, Vec<(String, String)>, Vec<u8>);

async fn daemon(
    port: u16,
    method: &str,
    path: &str,
    headers: &[(String, String)],
    body: Vec<u8>,
) -> Result<Answer> {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    let client = CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(120))
            .build()
            .expect("preview client")
    });
    let method = reqwest::Method::from_bytes(method.as_bytes())
        .map_err(|_| Error::new(4202, "unknown method"))?;
    let mut request = client.request(method, format!("http://127.0.0.1:{port}{path}"));
    for (name, value) in headers {
        request = request.header(name, value);
    }
    let response = request.body(body).send().await.map_err(|_| {
        Error::new(
            4211,
            "Nothing answers on that port on the daemon's computer. Is the server still running?",
        )
    })?;
    let status = response.status().as_u16();
    let headers = response
        .headers()
        .iter()
        .filter_map(|(name, value)| Some((name.to_string(), value.to_str().ok()?.to_owned())))
        .collect();
    let body = response
        .bytes()
        .await
        .map_err(|_| Error::new(4211, "The page stopped while loading."))?;
    if body.len() > BODY_LIMIT {
        return Err(Error::new(4211, "That page is too large to preview."));
    }
    Ok((status, headers, body.to_vec()))
}

#[allow(clippy::too_many_arguments)]
async fn lent(
    home: &Path,
    device: &str,
    port: u16,
    method: &str,
    path: &str,
    headers: &[(String, String)],
    body: &[u8],
) -> Result<Answer> {
    let reply = crate::computer_lend::request(
        home,
        device,
        "http",
        json!({
            "port": port,
            "method": method,
            "path": path,
            "headers": headers,
            "body": STANDARD.encode(body),
        }),
    )
    .await?;
    let status = reply["status"].as_u64().unwrap_or(502) as u16;
    let headers = reply["headers"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|pair| Some((pair[0].as_str()?.to_owned(), pair[1].as_str()?.to_owned())))
        .collect();
    let body = STANDARD
        .decode(reply["body"].as_str().unwrap_or(""))
        .map_err(|_| Error::new(4211, "That computer sent an unreadable page."))?;
    Ok((status, headers, body))
}

fn respond(status: u16, headers: &[(String, String)], body: Vec<u8>) -> Response {
    let mut response = Response::new(Body::from(body));
    *response.status_mut() = StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY);
    let map: &mut HeaderMap = response.headers_mut();
    for (name, value) in headers {
        if !kept(name) {
            continue;
        }
        // A redirect stays inside the preview: an absolute one to the same
        // port loses its origin, a relative one already works.
        if let (Ok(name), Ok(value)) = (
            HeaderName::from_bytes(name.as_bytes()),
            HeaderValue::from_str(value),
        ) {
            map.append(name, value);
        }
    }
    map.insert(
        axum::http::header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(SANDBOX),
    );
    map.insert(
        HeaderName::from_static("referrer-policy"),
        HeaderValue::from_static("no-referrer"),
    );
    response
}

/// `preview` in `computer_use`: show `port` on the computer the bot named.
/// The bots' computer opens it in its own browser; the others get a link.
pub fn for_bot(home: &Path, computer: &Value, port: u16, path: &str) -> Result<Value> {
    let device = computer["id"]
        .as_str()
        .and_then(|id| crate::computer_access::device_for(home, id));
    let link = open(home, device.as_deref(), port, path)?;
    Ok(json!({
        "preview": link,
        "computer": computer["name"],
        "note": "The user sees it beside the chat. Say what to look at; don't paste the link.",
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[tokio::test]
    async fn a_daemon_page_is_served_sandboxed_and_without_cookies() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let served = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut seen = vec![0; 4096];
            let read = socket.read(&mut seen).await.unwrap();
            let request = String::from_utf8_lossy(&seen[..read]).to_lowercase();
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nSet-Cookie: s=1\r\nX-Frame-Options: DENY\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello")
                .await
                .unwrap();
            request
        });
        let home = tempfile::tempdir().unwrap();
        let link = open(home.path(), None, port, "/app/").unwrap();
        let token = link.split('/').nth(3).unwrap().to_owned();
        let request = Request::builder()
            .uri(format!("{link}index.html?x=1"))
            .header("cookie", "hermes_session_at=secret")
            .header("authorization", "Bearer nope")
            .body(Body::empty())
            .unwrap();
        let response = proxy(token, "app/index.html".into(), request).await;
        assert_eq!(response.status(), StatusCode::OK);
        let headers = response.headers().clone();
        assert!(
            headers["content-security-policy"]
                .to_str()
                .unwrap()
                .starts_with("sandbox allow-scripts")
        );
        assert!(
            !headers["content-security-policy"]
                .to_str()
                .unwrap()
                .contains("allow-same-origin")
        );
        assert!(headers.get("set-cookie").is_none());
        assert!(headers.get("x-frame-options").is_none());
        let body = axum::body::to_bytes(response.into_body(), 1024)
            .await
            .unwrap();
        assert_eq!(&body[..], b"hello");
        let request = served.await.unwrap();
        assert!(request.starts_with("get /app/index.html?x=1 "));
        assert!(!request.contains("hermes_session_at"));
        assert!(!request.contains("authorization"));
    }

    #[tokio::test]
    async fn an_unknown_link_or_a_closed_port_says_so_inside_the_sandbox() {
        let request = || Request::builder().uri("/").body(Body::empty()).unwrap();
        let gone = proxy("nope".into(), String::new(), request()).await;
        assert_eq!(gone.status(), StatusCode::NOT_FOUND);
        assert!(
            gone.headers()["content-security-policy"]
                .to_str()
                .unwrap()
                .starts_with("sandbox")
        );
        let home = tempfile::tempdir().unwrap();
        // Port 9 (discard) answers nothing over HTTP here.
        let link = open(home.path(), None, 9, "").unwrap();
        let token = link.split('/').nth(3).unwrap().to_owned();
        let closed = proxy(token, String::new(), request()).await;
        assert_eq!(closed.status(), StatusCode::BAD_GATEWAY);
        assert!(open(home.path(), None, 0, "").is_err());
    }
}
