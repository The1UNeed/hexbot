//! The Google and Microsoft accounts behind the Google Workspace and
//! Microsoft 365 connectors. The user signs in once per daemon in Settings,
//! Plugins; the grant lives in `accounts/<service>.json`, which no bot shell
//! can read (`credential-policy.json`), and the daemon sends every request,
//! so the model never sees a token.
//!
//! Microsoft signs in with a device code, as the model providers do. Google
//! refuses Gmail scopes to its device flow, so it takes an authorization code
//! with PKCE: Google sends the browser back to the daemon's own loopback port
//! (`/oauth/google`), and a browser on another computer, which can't reach
//! that port, shows an error page whose address the user pastes back.
//!
//! The OAuth clients are Hexbot's, compiled in from the release build's
//! environment (`HEXBOT_GOOGLE_CLIENT_ID` and friends). A client ID saved in
//! the connector's own fields takes their place.
use crate::{Error, Result, common};
use base64::Engine;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::Duration,
};

pub const GOOGLE: &str = "google";
pub const MICROSOFT: &str = "microsoft";

pub(crate) struct Service {
    pub id: &'static str,
    /// The account as people call it: "Google", "Microsoft".
    pub name: &'static str,
    /// Its mail, as people call it: "Gmail", "Outlook".
    pub mail: &'static str,
    auth_base: &'static str,
    authorize_path: &'static str,
    device_path: Option<&'static str>,
    token_base: &'static str,
    token_path: &'static str,
    pub(crate) api_base: &'static str,
    scope: &'static str,
    client_key: &'static str,
    secret_key: Option<&'static str>,
    built_in: Option<&'static str>,
    built_in_secret: Option<&'static str>,
}

pub(crate) const SERVICES: &[Service] = &[
    Service {
        id: GOOGLE,
        name: "Google",
        mail: "Gmail",
        auth_base: "https://accounts.google.com",
        authorize_path: "/o/oauth2/v2/auth",
        device_path: None,
        token_base: "https://oauth2.googleapis.com",
        token_path: "/token",
        api_base: "https://gmail.googleapis.com",
        scope: "openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose",
        client_key: "GOOGLE_OAUTH_CLIENT_ID",
        secret_key: Some("GOOGLE_OAUTH_CLIENT_SECRET"),
        built_in: option_env!("HEXBOT_GOOGLE_CLIENT_ID"),
        built_in_secret: option_env!("HEXBOT_GOOGLE_CLIENT_SECRET"),
    },
    Service {
        id: MICROSOFT,
        name: "Microsoft",
        mail: "Outlook",
        auth_base: "https://login.microsoftonline.com",
        authorize_path: "",
        device_path: Some("/common/oauth2/v2.0/devicecode"),
        token_base: "https://login.microsoftonline.com",
        token_path: "/common/oauth2/v2.0/token",
        api_base: "https://graph.microsoft.com",
        scope: "openid email offline_access User.Read Mail.ReadWrite Mail.Send",
        client_key: "MICROSOFT_OAUTH_CLIENT_ID",
        secret_key: None,
        built_in: option_env!("HEXBOT_MICROSOFT_CLIENT_ID"),
        built_in_secret: None,
    },
];

pub(crate) fn service(id: &str) -> Result<&'static Service> {
    SERVICES
        .iter()
        .find(|s| s.id == id)
        .ok_or_else(|| Error::new(4202, "service must be google or microsoft"))
}

/// Where a service's requests go. `accounts.<service>.endpoint` in
/// `config.yaml` points all of them at one server, for tests and
/// operator-run proxies; it is never accepted from RPC input, and plain
/// HTTP is allowed only on loopback.
fn base(home: &Path, svc: &Service, default: &str) -> Result<String> {
    let config = common::read_config(home)?;
    let Some(value) = config["accounts"][svc.id]["endpoint"].as_str() else {
        return Ok(default.to_owned());
    };
    let value = value.trim_end_matches('/');
    let parsed =
        url::Url::parse(value).map_err(|_| Error::new(4211, "invalid accounts endpoint"))?;
    if parsed.scheme() != "https"
        && !(parsed.scheme() == "http"
            && matches!(parsed.host_str(), Some("127.0.0.1" | "localhost" | "[::1]")))
    {
        return Err(Error::new(4211, "accounts endpoint requires HTTPS"));
    }
    Ok(value.to_owned())
}
fn auth_url(home: &Path, svc: &Service, path: &str) -> Result<String> {
    Ok(format!("{}{path}", base(home, svc, svc.auth_base)?))
}
fn token_url(home: &Path, svc: &Service, path: &str) -> Result<String> {
    Ok(format!("{}{path}", base(home, svc, svc.token_base)?))
}
pub(crate) fn api_url(home: &Path, svc: &Service, path: &str) -> Result<String> {
    Ok(format!("{}{path}", base(home, svc, svc.api_base)?))
}

#[derive(Clone)]
struct Client {
    id: String,
    secret: Option<String>,
}
/// The user's own client when the connector's fields hold one, otherwise Hexbot's.
fn client(home: &Path, svc: &Service) -> Result<Client> {
    let env = common::env_values(home)?;
    let saved = |key: &str| {
        env.get(key)
            .map(|v| v.trim().to_owned())
            .filter(|v| !v.is_empty())
    };
    if let Some(id) = saved(svc.client_key) {
        return Ok(Client {
            id,
            secret: svc.secret_key.and_then(saved),
        });
    }
    match svc.built_in.filter(|id| !id.is_empty()) {
        Some(id) => Ok(Client {
            id: id.to_owned(),
            secret: svc
                .built_in_secret
                .filter(|s| !s.is_empty())
                .map(str::to_owned),
        }),
        None => Err(Error::new(
            4210,
            format!(
                "This Hexbot build has no {} sign-in of its own. Add your own OAuth client ID under Advanced first.",
                svc.name
            ),
        )),
    }
}
/// The secret that goes with a client signed in earlier: the saved one when
/// the saved ID is still the same, otherwise the built-in one if it matches.
fn client_for(home: &Path, svc: &Service, id: &str) -> Client {
    if let Ok(current) = client(home, svc)
        && current.id == id
    {
        return current;
    }
    let secret = (svc.built_in == Some(id))
        .then_some(svc.built_in_secret)
        .flatten()
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    Client {
        id: id.to_owned(),
        secret,
    }
}

fn path(home: &Path, svc: &Service) -> PathBuf {
    home.join("accounts").join(format!("{}.json", svc.id))
}
fn read(home: &Path, svc: &Service) -> Result<Option<Value>> {
    match std::fs::read(path(home, svc)) {
        Ok(bytes) => Ok(serde_json::from_slice::<Value>(&bytes)
            .ok()
            .filter(Value::is_object)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}
fn write(home: &Path, svc: &Service, value: &Value) -> Result<()> {
    let file = path(home, svc);
    let dir = file.parent().expect("accounts dir");
    std::fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    common::atomic_write(
        &file,
        &serde_json::to_vec_pretty(value).map_err(|e| Error::new(5200, e.to_string()))?,
    )
}

/// The signed-in account as settings show it, never its tokens.
pub fn summary(home: &Path, id: &str) -> Result<Option<Value>> {
    let svc = service(id)?;
    Ok(read(home, svc)?.map(|a| {
        json!({
            "service": svc.id,
            "email": a["email"],
            "expired": a["expired"] == true,
            "connected_at": a["connected_at"],
        })
    }))
}
/// Whether the service is signed in and its grant still works.
pub fn connected(home: &Path, id: &str) -> Result<bool> {
    Ok(summary(home, id)?.is_some_and(|a| a["expired"] != true))
}

/// The claims of an ID token that came straight from the token endpoint
/// over TLS, so its signature needs no check here.
fn claims(id_token: &str) -> Value {
    id_token
        .split('.')
        .nth(1)
        .and_then(|p| {
            base64::engine::general_purpose::URL_SAFE_NO_PAD
                .decode(p.trim_end_matches('='))
                .ok()
        })
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or(Value::Null)
}

fn save(home: &Path, svc: &Service, client: &Client, tokens: &Value) -> Result<Value> {
    let refresh = tokens["refresh_token"].as_str().unwrap_or("");
    if tokens["access_token"].as_str().unwrap_or("").is_empty() || refresh.is_empty() {
        return Err(Error::new(
            4211,
            format!("{} did not return a lasting sign-in. Try again.", svc.name),
        ));
    }
    // Google lets the user untick a scope; mail needs every one it asked for.
    if let Some(granted) = tokens["scope"].as_str().filter(|g| !g.is_empty()) {
        let granted = granted.to_ascii_lowercase();
        // Only the mail APIs: Google names `email` userinfo.email.
        let missing = svc
            .scope
            .split(' ')
            .filter(|want| {
                let want = want.to_ascii_lowercase();
                want.contains("/gmail.") || want.starts_with("mail.")
            })
            .any(|want| {
                let want = want.to_ascii_lowercase();
                !granted
                    .split(' ')
                    .any(|g| g == want || g.ends_with(&format!("/{want}")))
            });
        if missing {
            return Err(Error::new(
                4211,
                format!(
                    "{} didn't allow every permission Hexbot asked for. Sign in again and leave every box ticked.",
                    svc.name
                ),
            ));
        }
    }
    let id = claims(tokens["id_token"].as_str().unwrap_or(""));
    let email = id["email"]
        .as_str()
        .or_else(|| id["preferred_username"].as_str())
        .unwrap_or("")
        .to_owned();
    let account = json!({
        "email": email,
        "client_id": client.id,
        "access_token": tokens["access_token"],
        "refresh_token": refresh,
        "expires_at": common::now() + tokens["expires_in"].as_f64().unwrap_or(3600.0),
        "scope": tokens["scope"].as_str().unwrap_or(svc.scope),
        "connected_at": common::now(),
    });
    let _lock = common::credentials_lock()
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    write(home, svc, &account)?;
    Ok(account)
}

fn http() -> Result<reqwest::Client> {
    crate::http::client(20, 0).map_err(|e| Error::new(5240, e.to_string()))
}
fn transport(svc: &Service) -> impl Fn(reqwest::Error) -> Error + '_ {
    move |e| {
        Error::new(
            5240,
            if e.is_timeout() {
                format!("{} timed out.", svc.name)
            } else if e.is_connect() {
                format!("{} could not be reached.", svc.name)
            } else {
                format!("The request to {} failed.", svc.name)
            },
        )
    }
}
async fn json_body(svc: &Service, response: reqwest::Response) -> Result<(u16, Value)> {
    let status = response.status().as_u16();
    let bytes = crate::http::bytes(
        response,
        2_000_000,
        |e| Error::new(5240, e.to_string()),
        Error::new(5240, format!("{} answered with too much.", svc.name)),
    )
    .await?;
    Ok((
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    ))
}

// --- Sign-in --------------------------------------------------------------

#[derive(Clone)]
struct Login {
    home: PathBuf,
    caller: String,
    service: &'static Service,
    client: Client,
    public: Value,
    state: String,
    verifier: String,
    redirect_uri: String,
    device: String,
    interval: f64,
    deadline: f64,
}
fn logins() -> &'static Mutex<HashMap<String, Login>> {
    static LOGINS: OnceLock<Mutex<HashMap<String, Login>>> = OnceLock::new();
    LOGINS.get_or_init(Default::default)
}
fn random(len: usize) -> String {
    use rand::Rng;
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
    let mut rng = rand::thread_rng();
    (0..len)
        .map(|_| ALPHABET[rng.gen_range(0..ALPHABET.len())] as char)
        .collect()
}
fn challenge(verifier: &str) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

/// The redirect Google sends the browser to: the daemon's own loopback port.
pub fn redirect_uri(port: u16) -> String {
    format!("http://127.0.0.1:{port}/oauth/google")
}

async fn start(home: &Path, caller: &str, id: &str, port: u16) -> Result<Value> {
    let svc = service(id)?;
    let client = client(home, svc)?;
    let login_id = common::id();
    let now = common::now();
    let mut login = Login {
        home: home.to_path_buf(),
        caller: caller.to_owned(),
        service: svc,
        client: client.clone(),
        public: json!({}),
        state: String::new(),
        verifier: String::new(),
        redirect_uri: String::new(),
        device: String::new(),
        interval: 5.0,
        deadline: now + 900.0,
    };
    if let Some(device) = svc.device_path {
        let response = http()?
            .post(auth_url(home, svc, device)?)
            .form(&[("client_id", client.id.as_str()), ("scope", svc.scope)])
            .send()
            .await
            .map_err(transport(svc))?;
        let (status, data) = json_body(svc, response).await?;
        let code = data["user_code"].as_str().unwrap_or("");
        login.device = data["device_code"].as_str().unwrap_or("").to_owned();
        let url = data["verification_uri"].as_str().unwrap_or("");
        if status >= 400
            || code.is_empty()
            || login.device.is_empty()
            || !url.starts_with("https://")
        {
            return Err(Error::new(
                4211,
                format!(
                    "{} would not start a sign-in{}.",
                    svc.name,
                    data["error_description"]
                        .as_str()
                        .map(|d| format!(": {}", d.lines().next().unwrap_or(d)))
                        .unwrap_or_default()
                ),
            ));
        }
        login.interval = data["interval"].as_f64().unwrap_or(5.0).clamp(1.0, 30.0);
        login.deadline = now
            + data["expires_in"]
                .as_f64()
                .unwrap_or(900.0)
                .clamp(60.0, 900.0);
        login.public = json!({"login_id":login_id,"service":svc.id,"mode":"device","status":"pending","url":url,"code":code,"message":""});
    } else {
        login.verifier = random(64);
        login.state = random(32);
        login.redirect_uri = redirect_uri(port);
        let mut url = url::Url::parse(&auth_url(home, svc, svc.authorize_path)?)
            .map_err(|_| Error::new(4211, "invalid sign-in address"))?;
        url.query_pairs_mut()
            .append_pair("client_id", &client.id)
            .append_pair("redirect_uri", &login.redirect_uri)
            .append_pair("response_type", "code")
            .append_pair("scope", svc.scope)
            .append_pair("code_challenge", &challenge(&login.verifier))
            .append_pair("code_challenge_method", "S256")
            .append_pair("state", &login.state)
            .append_pair("access_type", "offline")
            .append_pair("prompt", "consent");
        login.public = json!({"login_id":login_id,"service":svc.id,"mode":"browser","status":"pending","url":url.to_string(),"redirect_uri":login.redirect_uri,"message":""});
    }
    let public = login.public.clone();
    {
        let mut entries = logins().lock().unwrap();
        entries.retain(|_, e| e.deadline + 900.0 > now);
        for e in entries.values_mut() {
            if e.home == home && e.service.id == svc.id && e.public["status"] == "pending" {
                e.public["status"] = json!("cancelled");
                e.public["message"] = json!("Replaced by another sign-in.");
            }
        }
        entries.insert(login_id.clone(), login.clone());
    }
    if svc.device_path.is_some() {
        tokio::spawn(async move {
            loop {
                let interval = logins()
                    .lock()
                    .unwrap()
                    .get(&login_id)
                    .map(|l| l.interval)
                    .unwrap_or(5.0);
                tokio::time::sleep(Duration::from_secs_f64(interval)).await;
                match poll_device(&login_id).await {
                    Ok(true) => {}
                    _ => break,
                }
            }
        });
    }
    Ok(public)
}

/// Finishes or fails a login while it is still pending; a cancelled one
/// never takes a late grant.
fn settle(id: &str, outcome: Result<Value>) -> Value {
    let mut entries = logins().lock().unwrap();
    let Some(entry) = entries.get_mut(id) else {
        return json!({"status":"error","message":"Unknown sign-in."});
    };
    if entry.public["status"] != "pending" {
        return entry.public.clone();
    }
    let svc = entry.service;
    match outcome.and_then(|tokens| save(&entry.home, svc, &entry.client, &tokens)) {
        Ok(account) => {
            entry.public["status"] = json!("done");
            entry.public["email"] = account["email"].clone();
            entry.public["message"] = json!(format!("Signed in to {}.", svc.name));
        }
        Err(e) => {
            entry.public["status"] = json!("error");
            entry.public["message"] = json!(e.message);
        }
    }
    entry.public.clone()
}

/// One poll of a device code: true while the user has yet to approve it.
async fn poll_device(id: &str) -> Result<bool> {
    let Some(login) = logins().lock().unwrap().get(id).cloned() else {
        return Ok(false);
    };
    if login.public["status"] != "pending" {
        return Ok(false);
    }
    if common::now() >= login.deadline {
        let mut entries = logins().lock().unwrap();
        if let Some(e) = entries
            .get_mut(id)
            .filter(|e| e.public["status"] == "pending")
        {
            e.public["status"] = json!("error");
            e.public["message"] = json!("The code expired. Start again when you are ready.");
        }
        return Ok(false);
    }
    let svc = login.service;
    let response = http()?
        .post(token_url(&login.home, svc, svc.token_path)?)
        .form(&[
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
            ("client_id", login.client.id.as_str()),
            ("device_code", login.device.as_str()),
        ])
        .send()
        .await;
    let (status, data) = match response {
        Ok(response) => json_body(svc, response).await?,
        // A dropped connection is tried again at the next interval.
        Err(_) => return Ok(true),
    };
    if status < 400 {
        settle(id, Ok(data));
        return Ok(false);
    }
    match data["error"].as_str().unwrap_or("") {
        "authorization_pending" => Ok(true),
        "slow_down" => {
            if let Some(e) = logins().lock().unwrap().get_mut(id) {
                e.interval = (e.interval + 5.0).min(30.0);
            }
            Ok(true)
        }
        "authorization_declined" | "access_denied" => {
            settle(id, Err(Error::new(4211, "The sign-in was declined.")));
            Ok(false)
        }
        "expired_token" => {
            settle(
                id,
                Err(Error::new(
                    4211,
                    "The code expired. Start again when you are ready.",
                )),
            );
            Ok(false)
        }
        _ => {
            settle(
                id,
                Err(Error::new(
                    4211,
                    format!("{} refused the sign-in (HTTP {status}).", svc.name),
                )),
            );
            Ok(false)
        }
    }
}

/// Exchanges Google's code for tokens.
async fn exchange(login: &Login, code: &str) -> Result<Value> {
    let svc = login.service;
    let mut form = vec![
        ("grant_type", "authorization_code"),
        ("code", code),
        ("client_id", login.client.id.as_str()),
        ("code_verifier", login.verifier.as_str()),
        ("redirect_uri", login.redirect_uri.as_str()),
    ];
    if let Some(secret) = &login.client.secret {
        form.push(("client_secret", secret));
    }
    let response = http()?
        .post(token_url(&login.home, svc, svc.token_path)?)
        .form(&form)
        .send()
        .await
        .map_err(transport(svc))?;
    let (status, data) = json_body(svc, response).await?;
    if status >= 400 {
        return Err(Error::new(
            4211,
            format!(
                "{} refused the sign-in{}.",
                svc.name,
                data["error_description"]
                    .as_str()
                    .or(data["error"].as_str())
                    .map(|d| format!(": {d}"))
                    .unwrap_or_default()
            ),
        ));
    }
    Ok(data)
}

/// The state in the address Google sent the browser to, and its code, or
/// why there is none. A declined sign-in still names its state, so the
/// login it ends is the one waiting.
fn returned(url: &str) -> Result<(String, Result<String>)> {
    let url = url::Url::parse(url.trim()).map_err(|_| {
        Error::new(
            4202,
            "Paste the whole address, starting with http://127.0.0.1.",
        )
    })?;
    let get = |key: &str| {
        url.query_pairs()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.into_owned())
    };
    let none = || {
        Error::new(
            4202,
            "That address holds no sign-in code. Paste the address the browser ended on.",
        )
    };
    let state = get("state").ok_or_else(none)?;
    if let Some(error) = get("error") {
        return Ok((
            state,
            Err(Error::new(
                4211,
                if error == "access_denied" {
                    "The sign-in was declined.".to_owned()
                } else {
                    format!("Google refused the sign-in: {error}.")
                },
            )),
        ));
    }
    match get("code") {
        Some(code) if !code.is_empty() => Ok((state, Ok(code))),
        _ => Err(none()),
    }
}

/// Finishes a Google sign-in from the browser's return to `/oauth/google`
/// (by its state) or from an address the user pasted (by login and state).
async fn finish(
    home: &Path,
    caller: Option<&str>,
    login_id: Option<&str>,
    url: &str,
) -> Result<Value> {
    let returned = returned(url);
    let found = {
        let entries = logins().lock().unwrap();
        entries
            .iter()
            .find(|(id, l)| {
                l.home == home
                    && l.service.device_path.is_none()
                    && login_id.is_none_or(|want| want == id.as_str())
                    && caller.is_none_or(|c| c == l.caller)
                    && match &returned {
                        Ok((state, _)) => *state == l.state,
                        Err(_) => login_id.is_some(),
                    }
            })
            .map(|(id, l)| (id.clone(), l.clone()))
    };
    let Some((id, login)) = found else {
        return Err(Error::new(
            4210,
            "This sign-in is no longer waiting. Start it again in Settings, Plugins.",
        ));
    };
    if login.public["status"] != "pending" {
        return Ok(login.public);
    }
    let outcome = match returned {
        Ok((_, Ok(code))) => exchange(&login, &code).await,
        Ok((_, Err(declined))) => Err(declined),
        Err(e) => return Err(e),
    };
    Ok(settle(&id, outcome))
}

/// The page the browser lands on after Google.
pub async fn callback(home: &Path, query: &str) -> (bool, String) {
    let url = format!("http://127.0.0.1/oauth/google?{query}");
    let (ok, text) = match finish(home, None, None, &url).await {
        Ok(v) if v["status"] == "done" => (
            true,
            format!(
                "Signed in{}. You can close this tab and go back to Hexbot.",
                v["email"]
                    .as_str()
                    .filter(|e| !e.is_empty())
                    .map(|e| format!(" as {e}"))
                    .unwrap_or_default()
            ),
        ),
        Ok(v) => (
            false,
            v["message"]
                .as_str()
                .unwrap_or("Sign-in failed.")
                .to_owned(),
        ),
        // Started on another Hexbot that uses the same port, most likely.
        Err(e) if e.code == 4210 => (
            false,
            "This Hexbot isn't waiting for this sign-in. If you started it from another Hexbot, copy this page's address and paste it there.".to_owned(),
        ),
        Err(e) => (false, e.message),
    };
    let escaped = text
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;");
    (
        ok,
        format!(
            "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Hexbot</title><style>body{{font:16px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#f7f7f5;color:#1d1d1b}}@media(prefers-color-scheme:dark){{body{{background:#161615;color:#ededeb}}}}main{{max-width:28rem;padding:24px}}</style></head><body><main><p>{escaped}</p></main></body></html>"
        ),
    )
}

fn poll(home: &Path, caller: &str, id: &str, cancel: bool) -> Result<Value> {
    let mut entries = logins().lock().unwrap();
    let entry = entries
        .get_mut(id)
        .filter(|e| e.home == home && e.caller == caller)
        .ok_or_else(|| Error::new(4210, "Unknown sign-in."))?;
    if entry.public["status"] == "pending" {
        if cancel {
            entry.public["status"] = json!("cancelled");
            entry.public["message"] = json!("Sign-in cancelled.");
        } else if common::now() >= entry.deadline {
            entry.public["status"] = json!("error");
            entry.public["message"] =
                json!("The sign-in timed out. Start again when you are ready.");
        }
    }
    Ok(entry.public.clone())
}

// --- Tokens ---------------------------------------------------------------

fn refreshing() -> &'static tokio::sync::Mutex<()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(Default::default)
}

/// A current access token, refreshed when it has under a minute left.
pub(crate) async fn access_token(home: &Path, svc: &Service) -> Result<String> {
    access_token_for(home, svc, None).await
}

/// The same, but only from the grant whose `connected_at` is `grant`, when
/// given: a sign-in to another account since then is refused, not used.
pub(crate) async fn access_token_for(
    home: &Path,
    svc: &Service,
    grant: Option<&Value>,
) -> Result<String> {
    let signed_out = || {
        Error::new(
            4210,
            format!(
                "{} isn't signed in. Sign in under Settings, Plugins, {}.",
                svc.name,
                connector_name(svc)
            ),
        )
    };
    let _one = refreshing().lock().await;
    let account = read(home, svc)?.ok_or_else(signed_out)?;
    if grant.is_some_and(|g| *g != account["connected_at"]) {
        return Err(Error::new(
            4210,
            format!(
                "{} is signed in to another account now. Discard this and ask for a new draft.",
                svc.mail
            ),
        ));
    }
    if account["expired"] == true {
        return Err(Error::new(
            4210,
            format!(
                "The {} sign-in stopped working. Sign in again under Settings, Plugins, {}.",
                svc.name,
                connector_name(svc)
            ),
        ));
    }
    let token = account["access_token"].as_str().unwrap_or("");
    if !token.is_empty() && account["expires_at"].as_f64().unwrap_or(0.0) - 60.0 > common::now() {
        return Ok(token.to_owned());
    }
    let client = client_for(home, svc, account["client_id"].as_str().unwrap_or(""));
    let refresh = account["refresh_token"].as_str().unwrap_or("");
    let mut form = vec![
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh),
        ("client_id", client.id.as_str()),
    ];
    if svc.device_path.is_some() {
        form.push(("scope", svc.scope));
    }
    if let Some(secret) = &client.secret {
        form.push(("client_secret", secret));
    }
    let response = http()?
        .post(token_url(home, svc, svc.token_path)?)
        .form(&form)
        .send()
        .await
        .map_err(transport(svc))?;
    let (status, data) = json_body(svc, response).await?;
    if status >= 400 || data["access_token"].as_str().unwrap_or("").is_empty() {
        // A revoked or expired grant needs the user; anything else may pass.
        if matches!(
            data["error"].as_str(),
            Some("invalid_grant" | "unauthorized_client" | "invalid_client")
        ) {
            let mut stale = account.clone();
            stale["expired"] = json!(true);
            let _lock = common::credentials_lock()
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            if !same_grant(home, svc, &account)? {
                return Err(signed_out());
            }
            write(home, svc, &stale)?;
            return Err(Error::new(
                4210,
                format!(
                    "The {} sign-in stopped working. Sign in again under Settings, Plugins, {}.",
                    svc.name,
                    connector_name(svc)
                ),
            ));
        }
        return Err(Error::new(
            5240,
            format!("{} would not renew the sign-in (HTTP {status}).", svc.name),
        ));
    }
    let mut next = account.clone();
    next["access_token"] = data["access_token"].clone();
    next["expires_at"] = json!(common::now() + data["expires_in"].as_f64().unwrap_or(3600.0));
    // Microsoft hands out a new refresh token each time; Google keeps its own.
    if let Some(r) = data["refresh_token"].as_str().filter(|r| !r.is_empty()) {
        next["refresh_token"] = json!(r);
    }
    let _lock = common::credentials_lock()
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    // A sign-out or a new sign-in while this renewed wins: its file stays.
    if !same_grant(home, svc, &account)? {
        return Err(signed_out());
    }
    write(home, svc, &next)?;
    Ok(data["access_token"].as_str().unwrap_or("").to_owned())
}

/// Whether the file still holds the grant `account` was read from, under
/// the credentials lock. Sign-out removes it; a new sign-in replaces it.
fn same_grant(home: &Path, svc: &Service, account: &Value) -> Result<bool> {
    Ok(read(home, svc)?.is_some_and(|now| {
        now["connected_at"] == account["connected_at"]
            && now["refresh_token"] == account["refresh_token"]
    }))
}

fn connector_name(svc: &Service) -> &'static str {
    if svc.id == GOOGLE {
        "Google Workspace"
    } else {
        "Microsoft 365"
    }
}

/// Signs out: the grant is forgotten here and, for Google, revoked there.
/// A sign-in still waiting for this service ends first, so finishing it
/// later can't sign the user back in.
async fn disconnect(home: &Path, svc: &Service) -> Result<()> {
    for entry in logins().lock().unwrap().values_mut() {
        if entry.home == home && entry.service.id == svc.id && entry.public["status"] == "pending" {
            entry.public["status"] = json!("cancelled");
            entry.public["message"] = json!("Signed out while this sign-in waited.");
        }
    }
    let account = {
        let _lock = common::credentials_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let account = read(home, svc)?;
        match std::fs::remove_file(path(home, svc)) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.into()),
            _ => {}
        }
        account
    };
    if svc.id == GOOGLE
        && let Some(token) = account.as_ref().and_then(|a| a["refresh_token"].as_str())
        && let Ok(url) = token_url(home, svc, "/revoke")
        && let Ok(client) = http()
    {
        let _ = client.post(url).form(&[("token", token)]).send().await;
    }
    Ok(())
}

/// A light request that proves the grant works: the account's profile.
pub async fn probe(home: &Path, id: &str) -> Result<Value> {
    let svc = service(id)?;
    if read(home, svc)?.is_none() {
        return Ok(json!({"ok":false,"message":format!("Sign in to {} first.", svc.name)}));
    }
    let path = if svc.id == GOOGLE {
        "/gmail/v1/users/me/profile"
    } else {
        "/v1.0/me?$select=mail,userPrincipalName"
    };
    let result = async {
        let token = access_token(home, svc).await?;
        let response = http()?
            .get(api_url(home, svc, path)?)
            .bearer_auth(token)
            .send()
            .await
            .map_err(transport(svc))?;
        let (status, data) = json_body(svc, response).await?;
        if status >= 400 {
            return Err(Error::new(
                5240,
                format!("{} answered HTTP {status}.", svc.mail),
            ));
        }
        Ok(data["emailAddress"]
            .as_str()
            .or(data["mail"].as_str())
            .or(data["userPrincipalName"].as_str())
            .unwrap_or("")
            .to_owned())
    }
    .await;
    Ok(match result {
        Ok(email) if email.is_empty() => json!({"ok":true,"message":"Connected."}),
        Ok(email) => json!({"ok":true,"message":format!("Connected as {email}.")}),
        Err(e) => json!({"ok":false,"message":e.message}),
    })
}

pub const CHANGES: &[&str] = &[
    "hexbot.accounts.sign_in_finish",
    "hexbot.accounts.disconnect",
];

/// `hexbot.accounts.*`. `port` is the daemon's own, where Google returns.
pub async fn call(
    home: &Path,
    caller: &str,
    method: &str,
    p: &Value,
    port: u16,
) -> Option<Result<Value>> {
    if !method.starts_with("hexbot.accounts.") {
        return None;
    }
    Some(
        async {
            common::user(home, caller)?;
            match method {
                "hexbot.accounts.sign_in_start" => {
                    start(home, caller, common::required(p, "service")?, port).await
                }
                "hexbot.accounts.sign_in_poll" => {
                    poll(home, caller, common::required(p, "login_id")?, false)
                }
                "hexbot.accounts.sign_in_cancel" => {
                    poll(home, caller, common::required(p, "login_id")?, true)
                }
                "hexbot.accounts.sign_in_finish" => {
                    let url = common::required(p, "url")?;
                    if url.len() > 8192 {
                        return Err(Error::new(4202, "That address is too long."));
                    }
                    finish(
                        home,
                        Some(caller),
                        Some(common::required(p, "login_id")?),
                        url,
                    )
                    .await
                }
                "hexbot.accounts.disconnect" => {
                    let svc = service(common::required(p, "service")?)?;
                    disconnect(home, svc).await?;
                    Ok(json!({"disconnected": svc.id}))
                }
                _ => Err(Error::new(-32601, format!("unknown method: {method}"))),
            }
        }
        .await,
    )
}

#[cfg(test)]
#[path = "accounts_tests.rs"]
mod tests;
