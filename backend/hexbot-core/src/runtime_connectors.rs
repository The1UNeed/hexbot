//! `hexbot_connector_read` and `hexbot_connector_write`: Notion works
//! through a skill that describes its API and a key the user saves in
//! Settings, Plugins. A bot's shell never has connector keys
//! (`shellEnvironment` in the extension) and Auto's sandbox has no network,
//! so the daemon sends the request with the bot's key, which the model never
//! sees. Reads run in every mode and in heartbeats. Changes pass the
//! extension's gate like a connected tool's: Bypass runs them, Auto's
//! reviewer checks each one, Manual asks.
use super::*;

pub(super) const READ: &str = "hexbot_connector_read";
pub(super) const WRITE: &str = "hexbot_connector_write";

struct Api {
    id: &'static str,
    name: &'static str,
    base: &'static str,
    key: &'static str,
    headers: &'static [(&'static str, &'static str)],
    /// Paths a POST may go to and only read: searches and queries.
    reads_by_post: &'static [&'static str],
    prefix: &'static str,
}
const APIS: &[Api] = &[
    Api {
        id: "notion",
        name: "Notion",
        base: "https://api.notion.com",
        key: "NOTION_API_KEY",
        headers: &[("Notion-Version", "2025-09-03")],
        reads_by_post: &[
            "/v1/search",
            "/v1/databases/*/query",
            "/v1/data_sources/*/query",
        ],
        prefix: "/v1/",
    },
];
const CAP: usize = 200_000;

/// Whether the bot has Notion on; a heartbeat reads either way.
pub(super) fn offered(home: &Path, bot: &str) -> Result<bool> {
    for api in APIS {
        if crate::connectors::enabled(home, bot, api.id)? {
            return Ok(true);
        }
    }
    Ok(false)
}

fn parameters(methods: &[&str]) -> Value {
    json!({
        "type": "object",
        "properties": {
            "connector": { "type": "string", "enum": APIS.iter().map(|api| api.id).collect::<Vec<_>>() },
            "method": { "type": "string", "enum": methods },
            "path": { "type": "string", "description": "Like /v1/search or /v1/pages/PAGE_ID" },
            "body": { "type": "object", "description": "JSON body, for a POST, PATCH or PUT" }
        },
        "required": ["connector", "method", "path"]
    })
}

pub(super) fn read_descriptor() -> Value {
    json!({
        "name": READ,
        "label": "Read a connector",
        "description": "Read Notion with the key the user saved in Settings, Plugins. Your shell never has that key, so do not use curl, ntn or a browser sign-in for them, and never ask the user for a password or key. Send the API request the connector's skill describes (skill_view shows it), with the path only: Hexbot adds the host and the key. Only reads: GET, plus Notion's POST search and database or data source queries. A 401 means the key is wrong; a 404 on something that exists means the user has not shared it with their integration (in Notion: the page's ... menu, Connections).",
        "parameters": parameters(&["GET", "POST"])
    })
}

pub(super) fn write_descriptor() -> Value {
    json!({
        "name": WRITE,
        "label": "Change a connector",
        "description": "Create, update or delete in Notion: pages, blocks, database rows. Send the API request the connector's skill describes, with the path only: Hexbot adds the host and the key the user saved. The user's approval mode decides whether it runs at once or asks first. Use hexbot_connector_read to read.",
        "parameters": parameters(&["POST", "PATCH", "PUT", "DELETE"])
    })
}

/// Whether `path` stays on the API: under its prefix, with nothing that could
/// name another host.
fn clean(api: &Api, path: &str) -> bool {
    path.split('?').next().unwrap_or("").starts_with(api.prefix)
        && !path.contains("..")
        && !path.contains("://")
        && !path.contains('@')
        && !path.contains('#')
        && path
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"/_-.?=&%:,+[]".contains(&b))
}

/// Whether `path` is one of the API's read requests.
fn readable(api: &Api, method: &str, path: &str) -> bool {
    let route = path.split('?').next().unwrap_or("");
    let matches = |pattern: &str| {
        let (a, b) = (pattern.split('/'), route.split('/'));
        a.clone().count() == b.clone().count()
            && a.zip(b).all(|(p, s)| p == "*" && !s.is_empty() || p == s)
    };
    clean(api, path)
        && match method {
            "GET" => true,
            "POST" => api.reads_by_post.iter().any(|p| matches(p)),
            _ => false,
        }
}

/// The JSON a request carries: only POST, PATCH and PUT send one, since the
/// APIs refuse a GET with a body.
fn body(method: &str, args: &Value) -> Option<Value> {
    matches!(method, "POST" | "PATCH" | "PUT").then(|| {
        args.get("body")
            .filter(|b| !b.is_null())
            .cloned()
            .unwrap_or_else(|| json!({}))
    })
}

/// Sends one request for `bot`. `write` is the change tool, which the
/// extension's gate approved; it refuses reads so they never wait on a review.
pub(super) async fn request(home: &Path, bot: &str, args: &Value, write: bool) -> Result<Value> {
    let id = common::required(args, "connector")?;
    let api = APIS
        .iter()
        .find(|api| api.id == id)
        .ok_or_else(|| Error::new(4202, "connector must be notion"))?;
    let method = common::required(args, "method")?;
    let path = common::required(args, "path")?;
    if !clean(api, path) {
        return Err(Error::new(
            4202,
            format!(
                "The path must start with {} and hold only the API path and query.",
                api.prefix
            ),
        ));
    }
    let read = readable(api, method, path);
    if !write && !read {
        return Err(Error::new(
            4302,
            format!(
                "{READ} only reads {}. Send GET, or a POST to a search or query; use {WRITE} to change something.",
                api.name
            ),
        ));
    }
    if write && (read || !matches!(method, "POST" | "PATCH" | "PUT" | "DELETE")) {
        return Err(Error::new(
            4202,
            format!("This request reads {}; use {READ}.", api.name),
        ));
    }
    if !crate::connectors::enabled(home, bot, api.id)? {
        return Err(Error::new(
            4210,
            format!("{} is not turned on for this bot.", api.name),
        ));
    }
    let key = crate::connectors::credentials(home, bot)?
        .remove(api.key)
        .filter(|k| !k.is_empty())
        .ok_or_else(|| {
            Error::new(
                4210,
                format!(
                    "{} has no key yet; the user adds it in Settings, Plugins.",
                    api.name
                ),
            )
        })?;
    let client = crate::http::client(20, 0).map_err(|e| Error::new(5240, e.to_string()))?;
    let url = format!("{}{path}", api.base);
    let verb = reqwest::Method::from_bytes(method.as_bytes())
        .map_err(|_| Error::new(4202, "unknown method"))?;
    let mut request = client.request(verb, &url).bearer_auth(key);
    if let Some(body) = body(method, args) {
        request = request.json(&body);
    }
    for (name, value) in api.headers {
        request = request.header(*name, *value);
    }
    let response = request.send().await.map_err(|e| {
        crate::http::error(
            e,
            5240,
            [
                "The connector timed out.",
                "The connector could not be reached.",
                "The connector request failed.",
            ],
        )
    })?;
    let status = response.status().as_u16();
    let body = crate::http::bytes(
        response,
        CAP,
        |e| Error::new(5240, e.to_string()),
        Error::new(5240, "The answer is too long; ask for fewer results."),
    )
    .await?;
    Ok(json!({"status":status,"body":String::from_utf8_lossy(&body)}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connector_reads_only_read() {
        let notion = &APIS[0];
        assert!(readable(notion, "GET", "/v1/pages/abc-123"));
        assert!(readable(notion, "POST", "/v1/search"));
        assert!(readable(notion, "POST", "/v1/data_sources/abc/query"));
        assert!(!readable(notion, "POST", "/v1/pages"));
        assert!(!readable(notion, "POST", "/v1/data_sources//query"));
        assert!(!readable(notion, "PATCH", "/v1/pages/abc"));
        assert!(!readable(notion, "GET", "/v1/../oauth"));
        assert!(!readable(notion, "GET", "//evil.example/v1/x"));
        assert!(!readable(notion, "GET", "/v1/x@evil.example"));
    }

    #[test]
    fn only_posts_patches_and_puts_carry_a_body() {
        let args = json!({"body":{}});
        assert_eq!(body("GET", &args), None);
        assert_eq!(body("DELETE", &json!({"body":{"a":1}})), None);
        assert_eq!(body("POST", &json!({})), Some(json!({})));
        assert_eq!(
            body("PATCH", &json!({"body":{"archived":true}})),
            Some(json!({"archived":true}))
        );
    }

    /// Both tools stay on the API's host, and each takes only its own kind
    /// of request, before any key is read.
    #[tokio::test]
    async fn each_tool_takes_only_its_own_requests() {
        let home = tempfile::tempdir().unwrap();
        let ask =
            |method: &str, path: &str| json!({"connector":"notion","method":method,"path":path});
        let read = |args: Value| {
            let home = home.path().to_path_buf();
            async move { request(&home, "owl", &args, false).await.unwrap_err().code }
        };
        let write = |args: Value| {
            let home = home.path().to_path_buf();
            async move { request(&home, "owl", &args, true).await.unwrap_err().code }
        };
        assert_eq!(read(ask("PATCH", "/v1/pages/abc")).await, 4302);
        assert_eq!(read(ask("POST", "/v1/pages")).await, 4302);
        assert_eq!(write(ask("POST", "/v1/search")).await, 4202);
        assert_eq!(write(ask("GET", "/v1/pages/abc")).await, 4202);
        assert_eq!(write(ask("PATCH", "//evil.example/v1/pages")).await, 4202);
        assert_eq!(write(ask("PATCH", "/v1/x@evil.example")).await, 4202);
    }

    #[test]
    fn the_two_tools_split_reads_from_changes() {
        let read = read_descriptor();
        let write = write_descriptor();
        assert_eq!(read["name"], READ);
        assert_eq!(write["name"], WRITE);
        assert_eq!(
            read["parameters"]["properties"]["method"]["enum"],
            json!(["GET", "POST"])
        );
        assert_eq!(
            write["parameters"]["properties"]["method"]["enum"],
            json!(["POST", "PATCH", "PUT", "DELETE"])
        );
    }
}
