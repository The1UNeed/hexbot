//! The Google and Microsoft accounts behind the connectors for their
//! services: Gmail, Google Calendar, Drive, Docs, Sheets, Slides and Tasks;
//! Outlook, Outlook Calendar, OneDrive, Word, Excel, PowerPoint and To Do.
//! The user connects each one in Settings, Plugins, alone or several in one
//! sign-in. A connector's grant lives in `accounts/<connector>.json`, holds
//! only the permissions that connector needs, and is read by no bot shell
//! (`credential-policy.json`); the daemon sends every request, so the model
//! never sees a token.
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

/// Who signs the user in: Google or Microsoft.
pub(crate) struct Provider {
    pub id: &'static str,
    /// The account as people call it: "Google", "Microsoft".
    pub name: &'static str,
    auth_base: &'static str,
    authorize_path: &'static str,
    device_path: Option<&'static str>,
    token_base: &'static str,
    token_path: &'static str,
    /// Asked with every sign-in: who the user is, and a lasting grant.
    identity: &'static str,
    client_key: &'static str,
    secret_key: Option<&'static str>,
    built_in: Option<&'static str>,
    built_in_secret: Option<&'static str>,
}

const GOOGLE_PROVIDER: Provider = Provider {
    id: GOOGLE,
    name: "Google",
    auth_base: "https://accounts.google.com",
    authorize_path: "/o/oauth2/v2/auth",
    device_path: None,
    token_base: "https://oauth2.googleapis.com",
    token_path: "/token",
    identity: "openid email",
    client_key: "GOOGLE_OAUTH_CLIENT_ID",
    secret_key: Some("GOOGLE_OAUTH_CLIENT_SECRET"),
    built_in: option_env!("HEXBOT_GOOGLE_CLIENT_ID"),
    built_in_secret: option_env!("HEXBOT_GOOGLE_CLIENT_SECRET"),
};
const MICROSOFT_PROVIDER: Provider = Provider {
    id: MICROSOFT,
    name: "Microsoft",
    auth_base: "https://login.microsoftonline.com",
    authorize_path: "",
    device_path: Some("/common/oauth2/v2.0/devicecode"),
    token_base: "https://login.microsoftonline.com",
    token_path: "/common/oauth2/v2.0/token",
    identity: "openid email offline_access User.Read",
    client_key: "MICROSOFT_OAUTH_CLIENT_ID",
    secret_key: None,
    built_in: option_env!("HEXBOT_MICROSOFT_CLIENT_ID"),
    built_in_secret: None,
};

pub(crate) const GMAIL_API: &str = "https://gmail.googleapis.com";
/// Calendar and Drive.
pub(crate) const GOOGLE_API: &str = "https://www.googleapis.com";
pub(crate) const DOCS_API: &str = "https://docs.googleapis.com";
pub(crate) const SHEETS_API: &str = "https://sheets.googleapis.com";
pub(crate) const SLIDES_API: &str = "https://slides.googleapis.com";
pub(crate) const TASKS_API: &str = "https://tasks.googleapis.com";
pub(crate) const GRAPH_API: &str = "https://graph.microsoft.com";

/// One connector's part of an account: Gmail, Google Calendar, Word. Each
/// has its own sign-in, its own grant file and only the permissions it
/// needs, so the user connects the ones they want.
pub(crate) struct Service {
    /// The connector's id, and the name of its grant file.
    pub id: &'static str,
    /// The product as people call it: "Gmail", "Outlook Calendar".
    pub name: &'static str,
    pub provider: &'static Provider,
    /// Where its requests go unless a call names another host.
    pub(crate) api: &'static str,
    /// The permissions it asks for, beyond the provider's identity ones.
    scope: &'static str,
    /// A light request that proves the grant works.
    probe: &'static str,
}

impl Service {
    pub(crate) fn google(&self) -> bool {
        self.provider.id == GOOGLE
    }
}

const DRIVE_FILES: &str = "/drive/v3/files?pageSize=1&fields=files(id)";
const ONEDRIVE: &str = "/v1.0/me/drive?$select=id";

pub(crate) const SERVICES: &[Service] = &[
    Service {
        id: "gmail",
        name: "Gmail",
        provider: &GOOGLE_PROVIDER,
        api: GMAIL_API,
        scope: "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose",
        probe: "/gmail/v1/users/me/profile",
    },
    Service {
        id: "google_calendar",
        name: "Google Calendar",
        provider: &GOOGLE_PROVIDER,
        api: GOOGLE_API,
        scope: "https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events",
        probe: "/calendar/v3/users/me/calendarList?maxResults=1",
    },
    Service {
        id: "google_drive",
        name: "Google Drive",
        provider: &GOOGLE_PROVIDER,
        api: GOOGLE_API,
        // Reads everything; changes only the files Hexbot added.
        scope: "https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file",
        probe: DRIVE_FILES,
    },
    Service {
        id: "google_docs",
        name: "Google Docs",
        provider: &GOOGLE_PROVIDER,
        api: DOCS_API,
        // Drive's metadata finds a document by name; `drive.file` makes new ones.
        scope: "https://www.googleapis.com/auth/documents https://www.googleapis.com/auth/drive.metadata.readonly https://www.googleapis.com/auth/drive.file",
        probe: DRIVE_FILES,
    },
    Service {
        id: "google_sheets",
        name: "Google Sheets",
        provider: &GOOGLE_PROVIDER,
        api: SHEETS_API,
        scope: "https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.metadata.readonly",
        probe: DRIVE_FILES,
    },
    Service {
        id: "google_slides",
        name: "Google Slides",
        provider: &GOOGLE_PROVIDER,
        api: SLIDES_API,
        scope: "https://www.googleapis.com/auth/presentations https://www.googleapis.com/auth/drive.metadata.readonly",
        probe: DRIVE_FILES,
    },
    Service {
        id: "google_tasks",
        name: "Google Tasks",
        provider: &GOOGLE_PROVIDER,
        api: TASKS_API,
        scope: "https://www.googleapis.com/auth/tasks",
        probe: "/tasks/v1/users/@me/lists?maxResults=1",
    },
    Service {
        id: "outlook",
        name: "Outlook",
        provider: &MICROSOFT_PROVIDER,
        api: GRAPH_API,
        scope: "Mail.ReadWrite Mail.Send",
        probe: "/v1.0/me/mailFolders/inbox?$select=id",
    },
    Service {
        id: "outlook_calendar",
        name: "Outlook Calendar",
        provider: &MICROSOFT_PROVIDER,
        api: GRAPH_API,
        // Mailbox settings hold the user's time zone, which event times use.
        scope: "Calendars.ReadWrite MailboxSettings.Read",
        probe: "/v1.0/me/calendar?$select=id",
    },
    Service {
        id: "onedrive",
        name: "OneDrive",
        provider: &MICROSOFT_PROVIDER,
        api: GRAPH_API,
        scope: "Files.ReadWrite",
        probe: ONEDRIVE,
    },
    Service {
        id: "word",
        name: "Word",
        provider: &MICROSOFT_PROVIDER,
        api: GRAPH_API,
        scope: "Files.ReadWrite",
        probe: ONEDRIVE,
    },
    Service {
        id: "excel",
        name: "Excel",
        provider: &MICROSOFT_PROVIDER,
        api: GRAPH_API,
        scope: "Files.ReadWrite",
        probe: ONEDRIVE,
    },
    Service {
        id: "powerpoint",
        name: "PowerPoint",
        provider: &MICROSOFT_PROVIDER,
        api: GRAPH_API,
        scope: "Files.ReadWrite",
        probe: ONEDRIVE,
    },
    Service {
        id: "microsoft_todo",
        name: "Microsoft To Do",
        provider: &MICROSOFT_PROVIDER,
        api: GRAPH_API,
        // The mailbox's zone says which day a due date is.
        scope: "Tasks.ReadWrite MailboxSettings.Read",
        probe: "/v1.0/me/todo/lists?$top=1",
    },
];

/// A connector's service. `google` and `microsoft` are what Gmail and
/// Outlook were called while each account had one connector; a draft card
/// from then still names them.
pub(crate) fn service(id: &str) -> Result<&'static Service> {
    let id = match id {
        GOOGLE => "gmail",
        MICROSOFT => "outlook",
        id => id,
    };
    SERVICES
        .iter()
        .find(|s| s.id == id)
        .ok_or_else(|| Error::new(4202, "unknown Google or Microsoft connector"))
}

/// Where a provider's requests go. `accounts.<google|microsoft>.endpoint`
/// in `config.yaml` points all of them at one server, for tests and
/// operator-run proxies; it is never accepted from RPC input, and plain
/// HTTP is allowed only on loopback.
fn base(home: &Path, provider: &Provider, default: &str) -> Result<String> {
    let config = common::read_config(home)?;
    let Some(value) = config["accounts"][provider.id]["endpoint"].as_str() else {
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
fn auth_url(home: &Path, provider: &Provider, path: &str) -> Result<String> {
    Ok(format!(
        "{}{path}",
        base(home, provider, provider.auth_base)?
    ))
}
fn token_url(home: &Path, provider: &Provider, path: &str) -> Result<String> {
    Ok(format!(
        "{}{path}",
        base(home, provider, provider.token_base)?
    ))
}
/// `path` on one of the provider's hosts: the service's own (`svc.api`),
/// or another, as Docs needs Drive's.
pub(crate) fn url_at(home: &Path, svc: &Service, host: &str, path: &str) -> Result<String> {
    Ok(format!("{}{path}", base(home, svc.provider, host)?))
}
/// Whether `url` is on one of the provider's own hosts, or the endpoint that
/// stands in for them: the only places a token may go.
pub(crate) fn trusted(home: &Path, svc: &Service, url: &str) -> bool {
    let Ok(parsed) = url::Url::parse(url) else {
        return false;
    };
    let origin = |u: &url::Url| {
        (
            u.scheme().to_owned(),
            u.host_str().map(str::to_owned),
            u.port(),
        )
    };
    if let Ok(Some(endpoint)) = common::read_config(home).map(|c| {
        c["accounts"][svc.provider.id]["endpoint"]
            .as_str()
            .map(str::to_owned)
    }) {
        return url::Url::parse(&endpoint).is_ok_and(|e| origin(&e) == origin(&parsed));
    }
    let host = parsed.host_str().unwrap_or("");
    parsed.scheme() == "https"
        && if svc.google() {
            // The APIs Hexbot calls, not every host of googleapis.com: one
            // of those serves files anyone may have put there.
            [
                GMAIL_API, GOOGLE_API, DOCS_API, SHEETS_API, SLIDES_API, TASKS_API,
            ]
            .iter()
            .any(|api| api.strip_prefix("https://") == Some(host))
        } else {
            host == "graph.microsoft.com"
        }
}

#[derive(Clone)]
struct Client {
    id: String,
    secret: Option<String>,
}
/// The user's own client when the connector's fields hold one, otherwise Hexbot's.
fn client(home: &Path, svc: &Provider) -> Result<Client> {
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
fn client_for(home: &Path, svc: &Provider, id: &str) -> Client {
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

/// Moves the grants of the two connectors that once covered a whole
/// account to the connectors that took their place: Google Workspace was
/// Gmail, Microsoft 365 was Outlook. Runs at every start.
pub(crate) fn migrate(home: &Path) -> Result<()> {
    let _lock = common::credentials_lock()
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    for (old, new) in [(GOOGLE, "gmail"), (MICROSOFT, "outlook")] {
        let from = home.join("accounts").join(format!("{old}.json"));
        let to = home.join("accounts").join(format!("{new}.json"));
        if from.is_file() && !to.exists() {
            std::fs::rename(from, to)?;
        }
    }
    Ok(())
}

/// The signed-in account as settings show it, never its tokens.
pub fn summary(home: &Path, id: &str) -> Result<Option<Value>> {
    let svc = service(id)?;
    Ok(read(home, svc)?.map(|a| {
        json!({
            "service": svc.id,
            "provider": svc.provider.id,
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

/// Whether a token answer grants every permission `svc` asks for. Google
/// lets the user untick one; a connector needs all of its own.
fn granted(svc: &Service, tokens: &Value) -> bool {
    let Some(granted) = tokens["scope"].as_str().filter(|g| !g.is_empty()) else {
        return true;
    };
    let granted = granted.to_ascii_lowercase();
    svc.scope.split(' ').all(|want| {
        let want = want.to_ascii_lowercase();
        // Microsoft may name a permission with or without Graph's address.
        granted
            .split(' ')
            .any(|g| g == want || g.ends_with(&format!("/{want}")))
    })
}

/// Saves the grant for each of `services` it covers: the ones signed in,
/// and those the user left unticked.
fn save(
    home: &Path,
    services: &[&'static Service],
    client: &Client,
    tokens: &Value,
) -> Result<(Value, Vec<&'static Service>, Vec<&'static Service>)> {
    let provider = services[0].provider;
    let refresh = tokens["refresh_token"].as_str().unwrap_or("");
    if tokens["access_token"].as_str().unwrap_or("").is_empty() || refresh.is_empty() {
        return Err(Error::new(
            4211,
            format!(
                "{} did not return a lasting sign-in. Try again.",
                provider.name
            ),
        ));
    }
    let (allowed, refused): (Vec<_>, Vec<_>) =
        services.iter().copied().partition(|s| granted(s, tokens));
    if allowed.is_empty() {
        return Err(Error::new(
            4211,
            format!(
                "{} didn't allow every permission Hexbot asked for. Sign in again and leave every box ticked.",
                provider.name
            ),
        ));
    }
    let id = claims(tokens["id_token"].as_str().unwrap_or(""));
    let email = id["email"]
        .as_str()
        .or_else(|| id["preferred_username"].as_str())
        .unwrap_or("")
        .to_owned();
    let now = common::now();
    let _lock = common::credentials_lock()
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let mut account = Value::Null;
    for svc in &allowed {
        account = json!({
            "email": email,
            "client_id": client.id,
            "access_token": tokens["access_token"],
            "refresh_token": refresh,
            "expires_at": now + tokens["expires_in"].as_f64().unwrap_or(3600.0),
            "scope": svc.scope,
            "connected_at": now,
        });
        write(home, svc, &account)?;
        // A test that failed before this sign-in says nothing about it.
        // The grant is written either way.
        let _ = crate::connectors::forget_test(home, svc.id);
    }
    Ok((account, allowed, refused))
}

fn http() -> Result<reqwest::Client> {
    crate::http::client(20, 0).map_err(|e| Error::new(5240, e.to_string()))
}
fn transport(svc: &Provider) -> impl Fn(reqwest::Error) -> Error + '_ {
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
async fn json_body(svc: &Provider, response: reqwest::Response) -> Result<(u16, Value)> {
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
    /// The connectors this sign-in is for, all of one provider.
    services: Vec<&'static Service>,
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

/// "Gmail, Google Calendar and Google Drive".
fn listed(services: &[&'static Service]) -> String {
    let names = services.iter().map(|s| s.name).collect::<Vec<_>>();
    match names.as_slice() {
        [] => String::new(),
        [one] => (*one).to_owned(),
        [first @ .., last] => format!("{} and {last}", first.join(", ")),
    }
}

/// Every permission one sign-in for `services` asks for, each once.
fn scopes(services: &[&'static Service]) -> String {
    let mut all: Vec<&str> = services[0].provider.identity.split(' ').collect();
    for scope in services.iter().flat_map(|s| s.scope.split(' ')) {
        if !all.contains(&scope) {
            all.push(scope);
        }
    }
    all.join(" ")
}

/// The address another connector of `provider` is signed in with, so Google
/// offers that account first.
fn known_email(home: &Path, provider: &Provider) -> Option<String> {
    SERVICES
        .iter()
        .filter(|s| s.provider.id == provider.id)
        .filter_map(|s| read(home, s).ok().flatten())
        .filter(|a| a["expired"] != true)
        .filter_map(|a| a["email"].as_str().map(str::to_owned))
        .find(|e| !e.is_empty())
}

/// Starts one sign-in for the connectors `ids`, which share a provider.
async fn start(home: &Path, caller: &str, ids: &[&str], port: u16) -> Result<Value> {
    let mut services: Vec<&'static Service> = vec![];
    for id in ids {
        let svc = service(id)?;
        if !services.iter().any(|s| s.id == svc.id) {
            services.push(svc);
        }
    }
    let Some(first) = services.first() else {
        return Err(Error::new(4200, "missing parameter: service"));
    };
    let provider = first.provider;
    if services.iter().any(|s| s.provider.id != provider.id) {
        return Err(Error::new(
            4202,
            "One sign-in covers one account: Google or Microsoft, not both.",
        ));
    }
    let scope = scopes(&services);
    let client = client(home, provider)?;
    let login_id = common::id();
    let now = common::now();
    let mut login = Login {
        home: home.to_path_buf(),
        caller: caller.to_owned(),
        services: services.clone(),
        client: client.clone(),
        public: json!({}),
        state: String::new(),
        verifier: String::new(),
        redirect_uri: String::new(),
        device: String::new(),
        interval: 5.0,
        deadline: now + 900.0,
    };
    let names = services.iter().map(|s| s.id).collect::<Vec<_>>();
    if let Some(device) = provider.device_path {
        let response = http()?
            .post(auth_url(home, provider, device)?)
            .form(&[("client_id", client.id.as_str()), ("scope", scope.as_str())])
            .send()
            .await
            .map_err(transport(provider))?;
        let (status, data) = json_body(provider, response).await?;
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
                    provider.name,
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
        login.public = json!({"login_id":login_id,"service":first.id,"services":names,"provider":provider.id,"mode":"device","status":"pending","url":url,"code":code,"message":""});
    } else {
        login.verifier = random(64);
        login.state = random(32);
        login.redirect_uri = redirect_uri(port);
        let mut url = url::Url::parse(&auth_url(home, provider, provider.authorize_path)?)
            .map_err(|_| Error::new(4211, "invalid sign-in address"))?;
        url.query_pairs_mut()
            .append_pair("client_id", &client.id)
            .append_pair("redirect_uri", &login.redirect_uri)
            .append_pair("response_type", "code")
            .append_pair("scope", &scope)
            .append_pair("code_challenge", &challenge(&login.verifier))
            .append_pair("code_challenge_method", "S256")
            .append_pair("state", &login.state)
            .append_pair("access_type", "offline")
            .append_pair("prompt", "consent");
        if let Some(email) = known_email(home, provider) {
            url.query_pairs_mut().append_pair("login_hint", &email);
        }
        login.public = json!({"login_id":login_id,"service":first.id,"services":names,"provider":provider.id,"mode":"browser","status":"pending","url":url.to_string(),"redirect_uri":login.redirect_uri,"message":""});
    }
    let public = login.public.clone();
    {
        let mut entries = logins().lock().unwrap();
        entries.retain(|_, e| e.deadline + 900.0 > now);
        // A new sign-in for a connector ends the one still waiting for it.
        for e in entries.values_mut() {
            if e.home == home
                && e.public["status"] == "pending"
                && e.services
                    .iter()
                    .any(|s| services.iter().any(|n| n.id == s.id))
            {
                e.public["status"] = json!("cancelled");
                e.public["message"] = json!("Replaced by another sign-in.");
            }
        }
        entries.insert(login_id.clone(), login.clone());
    }
    if provider.device_path.is_some() {
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
    match outcome.and_then(|tokens| save(&entry.home, &entry.services, &entry.client, &tokens)) {
        Ok((account, allowed, refused)) => {
            entry.public["status"] = json!("done");
            entry.public["email"] = account["email"].clone();
            entry.public["connected"] = json!(allowed.iter().map(|s| s.id).collect::<Vec<_>>());
            entry.public["skipped"] = json!(refused.iter().map(|s| s.id).collect::<Vec<_>>());
            entry.public["message"] = json!(if refused.is_empty() {
                format!("Connected {}.", listed(&allowed))
            } else {
                format!(
                    "Connected {}. {} didn't allow {}: connect {} again and leave every box ticked.",
                    listed(&allowed),
                    entry.services[0].provider.name,
                    listed(&refused),
                    if refused.len() == 1 { "it" } else { "them" }
                )
            });
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
    let svc = login.services[0].provider;
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
    let svc = login.services[0].provider;
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
                    && l.services[0].provider.device_path.is_none()
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
    let provider = svc.provider;
    let signed_out = || {
        Error::new(
            4210,
            format!(
                "{} isn't connected. Connect it in Settings, Plugins.",
                svc.name
            ),
        )
    };
    let stopped = || {
        Error::new(
            4210,
            format!(
                "The {} sign-in stopped working. Sign in again in Settings, Plugins.",
                svc.name
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
                svc.name
            ),
        ));
    }
    if account["expired"] == true {
        return Err(stopped());
    }
    let token = account["access_token"].as_str().unwrap_or("");
    if !token.is_empty() && account["expires_at"].as_f64().unwrap_or(0.0) - 60.0 > common::now() {
        return Ok(token.to_owned());
    }
    let client = client_for(home, provider, account["client_id"].as_str().unwrap_or(""));
    let refresh = account["refresh_token"].as_str().unwrap_or("");
    // Microsoft narrows the new token to the permissions named: this
    // connector's own, whatever else its sign-in covered.
    let scope = scopes(&[service(svc.id)?]);
    let mut form = vec![
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh),
        ("client_id", client.id.as_str()),
    ];
    if provider.device_path.is_some() {
        form.push(("scope", scope.as_str()));
    }
    if let Some(secret) = &client.secret {
        form.push(("client_secret", secret));
    }
    let response = http()?
        .post(token_url(home, provider, provider.token_path)?)
        .form(&form)
        .send()
        .await
        .map_err(transport(provider))?;
    let (status, data) = json_body(provider, response).await?;
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
            return Err(stopped());
        }
        return Err(Error::new(
            5240,
            format!(
                "{} would not renew the sign-in (HTTP {status}).",
                provider.name
            ),
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

// --- Requests -------------------------------------------------------------

/// A request that may have been carried out without a whole answer.
pub(crate) const UNCERTAIN: i64 = 5244;

/// What a request carries.
pub(crate) enum Body<'a> {
    None,
    Json(&'a Value),
    /// Bytes and their content type.
    Bytes(&'a [u8], &'a str),
}

/// An answer as it came: its status, its bytes and where it points.
pub(crate) struct Answer {
    pub status: u16,
    pub bytes: Vec<u8>,
    /// The `Location` header: where an upload's bytes go.
    pub location: Option<String>,
}

/// Sends one request with the connector's token, from the grant `grant`
/// names (its `connected_at`) when given. `url` is whole and must be on the
/// provider's own hosts: a token goes nowhere else. A request that reached
/// the service but got no whole answer is `UNCERTAIN`: it may have been
/// carried out. Only a refused connection is certain to have done nothing.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn send(
    home: &Path,
    svc: &Service,
    grant: Option<&Value>,
    method: reqwest::Method,
    url: &str,
    body: Body<'_>,
    headers: &[(&str, &str)],
    cap: usize,
) -> Result<Answer> {
    if !trusted(home, svc, url) {
        return Err(Error::new(
            5240,
            format!("{} pointed somewhere Hexbot won't follow.", svc.name),
        ));
    }
    let token = access_token_for(home, svc, grant).await?;
    // A file takes longer than an answer: up or down, it gets five minutes.
    let seconds = if matches!(body, Body::Bytes(..)) || cap > 8 * 1024 * 1024 {
        300
    } else {
        60
    };
    let client = crate::http::client(seconds, 0).map_err(|e| Error::new(5240, e.to_string()))?;
    let mut req = client.request(method, url).bearer_auth(token);
    for (name, value) in headers {
        req = req.header(*name, *value);
    }
    req = match body {
        Body::None => req,
        Body::Json(body) => req.json(body),
        Body::Bytes(bytes, kind) => req
            .header(reqwest::header::CONTENT_TYPE, kind)
            .body(bytes.to_vec()),
    };
    let response = req.send().await.map_err(|e| {
        let connected = !e.is_connect();
        let mut error = Error::new(
            5240,
            if e.is_timeout() {
                format!("{} timed out.", svc.name)
            } else if e.is_connect() {
                format!("{} could not be reached.", svc.name)
            } else {
                format!("The request to {} failed.", svc.name)
            },
        );
        if connected {
            error.code = UNCERTAIN;
        }
        error
    })?;
    let status = response.status().as_u16();
    let header = |name: reqwest::header::HeaderName| {
        response
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned)
    };
    let location = header(reqwest::header::LOCATION);
    let bytes = crate::http::bytes(
        response,
        cap,
        |e| Error::new(UNCERTAIN, format!("{} stopped answering: {e}", svc.name)),
        Error::new(
            5240,
            format!("{} answered with too much to read here.", svc.name),
        ),
    )
    .await?;
    Ok(Answer {
        status,
        bytes,
        location,
    })
}

/// The error a refused request becomes. `what` names the thing asked for,
/// as in "Gmail has no such message."
pub(crate) fn refused(svc: &Service, status: u16, bytes: &[u8], what: &str) -> Error {
    let data: Value = serde_json::from_slice(bytes).unwrap_or(Value::Null);
    let detail = data["error"]["message"]
        .as_str()
        .or(data["error"].as_str())
        .unwrap_or("")
        .trim();
    Error::new(
        match status {
            // A malformed id or value is answered with 400.
            400 => 4202,
            401 | 403 => 4210,
            // Not a card's 4204 ("no longer waiting"): nothing has that id.
            404 => 4215,
            _ => 5240,
        },
        match status {
            404 => format!("{} has no such {what}.", svc.name),
            // Read by the user on a card as well as by the bot.
            401 | 403 => format!(
                "{} refused it{}. Signing in again under Settings, Plugins may fix this.",
                svc.name,
                if detail.is_empty() {
                    format!(" (HTTP {status})")
                } else {
                    format!(": {}", detail.trim_end_matches('.'))
                }
            ),
            429 => format!("{} is busy. Try again in a moment.", svc.name),
            _ => format!("{} answered HTTP {status}. {detail}", svc.name)
                .trim()
                .to_owned(),
        },
    )
}

/// One JSON request on `host`, answered as JSON; a refusal is an error.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn api(
    home: &Path,
    svc: &Service,
    grant: Option<&Value>,
    method: reqwest::Method,
    host: &str,
    path: &str,
    body: Option<&Value>,
    headers: &[(&str, &str)],
    what: &str,
) -> Result<Value> {
    let answer = send(
        home,
        svc,
        grant,
        method,
        &url_at(home, svc, host, path)?,
        body.map_or(Body::None, Body::Json),
        headers,
        4_000_000,
    )
    .await?;
    if answer.status >= 400 {
        return Err(refused(svc, answer.status, &answer.bytes, what));
    }
    Ok(serde_json::from_slice(&answer.bytes).unwrap_or(Value::Null))
}

/// Percent-encodes one part of a path or query. A space is `%20`, which
/// both take; `+` means a space only in a query.
pub(crate) fn enc(part: &str) -> String {
    url::form_urlencoded::byte_serialize(part.as_bytes())
        .collect::<String>()
        .replace('+', "%20")
}

/// Disconnects one connector: its grant is forgotten here. Google's is
/// also revoked there once no other connector uses that account, since
/// Google ends every grant an account gave Hexbot at once. A sign-in still
/// waiting for the connector ends first, so finishing it later can't
/// connect it again.
async fn disconnect(home: &Path, svc: &'static Service) -> Result<()> {
    for entry in logins().lock().unwrap().values_mut() {
        if entry.home == home
            && entry.services.iter().any(|s| s.id == svc.id)
            && entry.public["status"] == "pending"
        {
            entry.public["status"] = json!("cancelled");
            entry.public["message"] = json!("Disconnected while this sign-in waited.");
        }
    }
    let (account, shared) = {
        let _lock = common::credentials_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let account = read(home, svc)?;
        match std::fs::remove_file(path(home, svc)) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.into()),
            _ => {}
        }
        let mut shared = false;
        for other in SERVICES
            .iter()
            .filter(|o| o.provider.id == svc.provider.id && o.id != svc.id)
        {
            if let (Some(mine), Some(theirs)) = (&account, read(home, other)?) {
                shared |= mine["client_id"] == theirs["client_id"]
                    && mine["email"]
                        .as_str()
                        .unwrap_or("")
                        .eq_ignore_ascii_case(theirs["email"].as_str().unwrap_or(""));
            }
        }
        (account, shared)
    };
    let _ = crate::connectors::forget_test(home, svc.id);
    if svc.google()
        && !shared
        && let Some(token) = account.as_ref().and_then(|a| a["refresh_token"].as_str())
        && let Ok(url) = token_url(home, svc.provider, "/revoke")
        && let Ok(client) = http()
    {
        let _ = client.post(url).form(&[("token", token)]).send().await;
    }
    Ok(())
}

/// A light request that proves the grant works, on the connector's own API.
pub async fn probe(home: &Path, id: &str) -> Result<Value> {
    let svc = service(id)?;
    let Some(account) = read(home, svc)? else {
        return Ok(json!({"ok":false,"message":format!("Connect {} first.", svc.name)}));
    };
    // Docs, Sheets and Slides are found through Drive.
    let host = if svc.probe.starts_with("/drive/") {
        GOOGLE_API
    } else {
        svc.api
    };
    let result = async {
        let token = access_token(home, svc).await?;
        let response = http()?
            .get(url_at(home, svc, host, svc.probe)?)
            .bearer_auth(token)
            .send()
            .await
            .map_err(transport(svc.provider))?;
        let (status, _) = json_body(svc.provider, response).await?;
        if status >= 400 {
            return Err(Error::new(
                5240,
                format!("{} answered HTTP {status}.", svc.name),
            ));
        }
        Ok(())
    }
    .await;
    Ok(match result {
        Ok(()) => match account["email"].as_str().filter(|e| !e.is_empty()) {
            Some(email) => json!({"ok":true,"message":format!("Connected as {email}.")}),
            None => json!({"ok":true,"message":"Connected."}),
        },
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
                    // `service` is the connector; `also` names others of the
                    // same account to connect in the same sign-in.
                    let mut ids = vec![common::required(p, "service")?];
                    match &p["also"] {
                        Value::Null => {}
                        Value::Array(more) if more.len() <= SERVICES.len() => {
                            for id in more {
                                ids.push(id.as_str().ok_or_else(|| {
                                    Error::new(4202, "also must list connectors")
                                })?);
                            }
                        }
                        _ => return Err(Error::new(4202, "also must list connectors")),
                    }
                    start(home, caller, &ids, port).await
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

/// What tests of the connectors' own modules share.
#[cfg(test)]
pub(crate) mod testing {
    use super::*;

    /// A server standing in for Google or Microsoft, and its address.
    pub(crate) async fn serve(app: axum::Router) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        origin
    }

    /// One request a stand-in service got.
    #[derive(Clone, Debug, Default)]
    pub(crate) struct Asked {
        pub method: String,
        pub path: String,
        /// The query as sent, still encoded.
        pub query: String,
        /// The stand-in's own address, for an answer that points back to it.
        pub origin: String,
        pub headers: HashMap<String, String>,
        pub body: Vec<u8>,
    }

    impl Asked {
        pub(crate) fn json(&self) -> Value {
            serde_json::from_slice(&self.body).unwrap_or(Value::Null)
        }
        pub(crate) fn header(&self, name: &str) -> &str {
            self.headers.get(name).map_or("", String::as_str)
        }
        /// One query value, decoded.
        pub(crate) fn param(&self, name: &str) -> String {
            url::form_urlencoded::parse(self.query.as_bytes())
                .find(|(key, _)| key == name)
                .map(|(_, value)| value.into_owned())
                .unwrap_or_default()
        }
        pub(crate) fn is(&self, method: &str, path: &str) -> bool {
            self.method == method && self.path == path
        }
    }

    /// What a stand-in service answers.
    pub(crate) enum Reply {
        Json(u16, Value),
        Bytes(Vec<u8>),
        /// 200 with a `Location` header: where an upload's bytes go.
        Location(String),
    }

    pub(crate) type Log = std::sync::Arc<Mutex<Vec<Asked>>>;

    /// A server standing in for Google or Microsoft that answers every
    /// request with `answer` and keeps what it was asked.
    pub(crate) async fn stand_in(
        answer: impl Fn(&Asked) -> Reply + Send + Sync + 'static,
    ) -> (String, Log) {
        use axum::{body::Bytes, http, response::IntoResponse};
        let log: Log = Default::default();
        let kept = log.clone();
        let answer = std::sync::Arc::new(answer);
        let origin = serve(axum::Router::new().fallback(
            move |method: http::Method, uri: http::Uri, headers: http::HeaderMap, body: Bytes| {
                let (kept, answer) = (kept.clone(), answer.clone());
                async move {
                    let asked = Asked {
                        method: method.to_string(),
                        path: uri.path().to_owned(),
                        query: uri.query().unwrap_or("").to_owned(),
                        origin: format!(
                            "http://{}",
                            headers
                                .get(http::header::HOST)
                                .and_then(|h| h.to_str().ok())
                                .unwrap_or("")
                        ),
                        headers: headers
                            .iter()
                            .map(|(k, v)| {
                                (k.as_str().to_owned(), v.to_str().unwrap_or("").to_owned())
                            })
                            .collect(),
                        body: body.to_vec(),
                    };
                    let reply = answer(&asked);
                    kept.lock().unwrap().push(asked);
                    match reply {
                        Reply::Json(status, body) => (
                            http::StatusCode::from_u16(status).unwrap(),
                            axum::Json(body),
                        )
                            .into_response(),
                        Reply::Bytes(bytes) => bytes.into_response(),
                        Reply::Location(to) => ([(http::header::LOCATION, to)], "").into_response(),
                    }
                }
            },
        ))
        .await;
        (origin, log)
    }

    /// A daemon home with `connectors` connected as me@example.com, whose
    /// Google and Microsoft requests all go to `origin`.
    pub(crate) fn connected(connectors: &[&str], origin: &str) -> tempfile::TempDir {
        let home = tempfile::tempdir().unwrap();
        std::fs::write(
            home.path().join("config.yaml"),
            format!(
                "accounts:\n  google:\n    endpoint: {origin}\n  microsoft:\n    endpoint: {origin}\n"
            ),
        )
        .unwrap();
        std::fs::create_dir_all(home.path().join("accounts")).unwrap();
        for id in connectors {
            std::fs::write(
                home.path().join(format!("accounts/{id}.json")),
                json!({"email":"me@example.com","client_id":"c","access_token":"tok","refresh_token":"r","expires_at":common::now() + 3600.0,"connected_at":1.0}).to_string(),
            )
            .unwrap();
        }
        home
    }
}

#[cfg(test)]
#[path = "accounts_tests.rs"]
mod tests;
