//! X search, the HTTP tool of the Hexbot connector catalog: through Grok
//! with a SuperGrok sign-in or an xAI key, or with X's own search API.
use crate::{Error, Result, common, connectors};
use serde_json::{Value, json};
use std::{collections::BTreeMap, path::Path, time::Duration};

fn config(home: &Path, bot: &str, section: &str) -> Result<Value> {
    Ok(common::merged_config(home, bot)?[section].clone())
}

fn client(seconds: u64) -> Result<reqwest::Client> {
    crate::http::client(seconds, 0).map_err(|e| Error::new(5200, e.to_string()))
}
async fn decode_response(response: reqwest::Response) -> Result<Value> {
    if !response.status().is_success() {
        return Err(Error::new(
            5200,
            format!("Tool provider returned HTTP {}", response.status().as_u16()),
        ));
    }
    crate::http::json(
        response,
        16 * 1024 * 1024,
        |_| Error::new(5200, "Tool provider response interrupted"),
        Error::new(5200, "Tool provider response exceeds 16 MiB"),
        Error::new(5200, "Tool provider returned invalid JSON"),
    )
    .await
}
fn credential(env: &BTreeMap<String, String>, name: &str) -> Result<String> {
    env.get(name)
        .cloned()
        .or_else(|| std::env::var(name).ok())
        .filter(|v| !v.is_empty())
        .ok_or_else(|| Error::new(4211, format!("Configure {name} to use this tool")))
}
fn string<'a>(p: &'a Value, name: &str, default: &'a str) -> &'a str {
    p[name]
        .as_str()
        .filter(|s| !s.is_empty())
        .unwrap_or(default)
}
pub fn descriptors(home: &Path, bot: &str) -> Result<Vec<Value>> {
    static SCHEMAS: std::sync::OnceLock<Vec<Value>> = std::sync::OnceLock::new();
    let schemas = SCHEMAS.get_or_init(|| {
        serde_json::from_str(include_str!("external_tool_schemas.json")).expect("tool schemas")
    });
    let mut output = vec![];
    for schema in schemas.iter().cloned() {
        let name = schema["name"].as_str().unwrap();
        if !connectors::tool_available(home, bot, name)? {
            continue;
        }
        output.push(schema);
    }
    Ok(output)
}
pub async fn call(
    home: &Path,
    owner: &str,
    bot: &str,
    name: &str,
    args: Value,
) -> Option<Result<Value>> {
    if name != "x_search" {
        return None;
    }
    Some(
        async {
            common::bot_owner(home, owner, bot)?;
            if !connectors::tool_available(home, bot, name)? {
                return Err(Error::new(4302, "Tool is disabled or unconfigured"));
            }
            x_search(home, bot, &args).await
        }
        .await,
    )
}

/// What a search asks for, checked before any request goes out.
struct Search<'a> {
    query: &'a str,
    allowed: Vec<&'a str>,
    excluded: Vec<&'a str>,
    from: Option<chrono::NaiveDate>,
    to: Option<chrono::NaiveDate>,
    filters: Vec<&'static str>,
}

fn parse(p: &Value) -> Result<Search<'_>> {
    let query = common::required(p, "query")?.trim();
    if query.is_empty() {
        return Err(Error::new(4200, "query is required"));
    }
    let mut filters = vec![];
    let mut handles = |field: &'static str| -> Result<Vec<&str>> {
        let Some(values) = p.get(field).filter(|v| !v.is_null()) else {
            return Ok(vec![]);
        };
        let values = values
            .as_array()
            .ok_or_else(|| Error::new(4200, format!("{field} must be an array")))?;
        let handles = values
            .iter()
            .filter_map(Value::as_str)
            .map(|s| s.trim().trim_start_matches('@'))
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>();
        if handles.len() > 10 {
            return Err(Error::new(4200, "At most 10 handles are supported"));
        }
        if !handles.is_empty() {
            filters.push(field);
        }
        Ok(handles)
    };
    let allowed = handles("allowed_x_handles")?;
    let excluded = handles("excluded_x_handles")?;
    if !allowed.is_empty() && !excluded.is_empty() {
        return Err(Error::new(
            4200,
            "Allowed and excluded handles cannot be combined",
        ));
    }
    let mut dates = [None, None];
    for (slot, field) in dates.iter_mut().zip(["from_date", "to_date"]) {
        let raw = string(p, field, "").trim();
        if raw.is_empty() {
            continue;
        }
        let date = chrono::NaiveDate::parse_from_str(raw, "%Y-%m-%d")
            .map_err(|_| Error::new(4200, "Dates must be YYYY-MM-DD"))?;
        if raw != date.format("%Y-%m-%d").to_string() {
            return Err(Error::new(4200, "Dates must be YYYY-MM-DD"));
        }
        if field == "from_date" && date > chrono::Utc::now().date_naive() {
            return Err(Error::new(4200, "from_date cannot be in the future"));
        }
        *slot = Some(date);
        filters.push(field);
    }
    let [from, to] = dates;
    if let (Some(from), Some(to)) = (from, to)
        && from > to
    {
        return Err(Error::new(4200, "from_date must precede to_date"));
    }
    Ok(Search {
        query,
        allowed,
        excluded,
        from,
        to,
        filters,
    })
}

/// Search X the way the user set X search up: through Grok with a SuperGrok
/// sign-in or an xAI key, or with X's own search API.
async fn x_search(home: &Path, bot: &str, p: &Value) -> Result<Value> {
    let search = parse(p)?;
    let cfg = config(home, bot, "x_search")?;
    match connectors::x_search_provider(home, bot)?.as_deref() {
        Some("x_api") => x_api_search(home, bot, &cfg, p, &search).await,
        Some("supergrok") => grok_search(home, bot, &cfg, p, &search, Some("xai-oauth")).await,
        Some("xai") => grok_search(home, bot, &cfg, p, &search, Some("xai")).await,
        _ => grok_search(home, bot, &cfg, p, &search, None).await,
    }
}

/// Send a request, again after a server error or a dropped connection.
async fn send(
    cfg: &Value,
    request: impl Fn() -> reqwest::RequestBuilder,
) -> Result<reqwest::Response> {
    let retries = cfg["retries"].as_u64().unwrap_or(2).min(10);
    let mut attempt = 0;
    loop {
        let sent = request().send().await;
        let retry = match &sent {
            Ok(response) => response.status().is_server_error(),
            Err(error) => error.is_timeout() || error.is_connect(),
        };
        if retry && attempt < retries {
            attempt += 1;
            tokio::time::sleep(Duration::from_millis((1500 * attempt).min(5000))).await;
            continue;
        }
        return sent.map_err(|_| Error::new(5200, "Tool provider request failed"));
    }
}

fn timeout(cfg: &Value) -> u64 {
    cfg["timeout_seconds"]
        .as_u64()
        .unwrap_or(180)
        .clamp(30, 600)
}

async fn grok_search(
    home: &Path,
    bot: &str,
    cfg: &Value,
    p: &Value,
    s: &Search<'_>,
    source: Option<&str>,
) -> Result<Value> {
    let mut search = json!({"type":"x_search"});
    if !s.allowed.is_empty() {
        search["allowed_x_handles"] = json!(s.allowed);
    }
    if !s.excluded.is_empty() {
        search["excluded_x_handles"] = json!(s.excluded);
    }
    if let Some(from) = s.from {
        search["from_date"] = json!(from.format("%Y-%m-%d").to_string());
    }
    if let Some(to) = s.to {
        search["to_date"] = json!(to.format("%Y-%m-%d").to_string());
    }
    for key in ["enable_image_understanding", "enable_video_understanding"] {
        if p[key] == true {
            search[key] = json!(true);
        }
    }
    let model = string(cfg, "model", "grok-4.5");
    let mut body = json!({"model":model,"input":[{"role":"user","content":s.query}],"tools":[search],"store":false});
    if let Some(effort) = cfg["reasoning_effort"].as_str().filter(|s| !s.is_empty()) {
        if !["low", "medium", "high", "xhigh"].contains(&effort) {
            return Err(Error::new(4200, "Invalid X search reasoning effort"));
        }
        body["reasoning"] = json!({"effort":effort});
    }
    let auth = crate::providers::xai_credentials_from(home, bot, source).await?;
    let key = common::required(&auth, "api_key")?;
    let base = string(&auth, "base_url", "https://api.x.ai/v1").trim_end_matches('/');
    let client = client(timeout(cfg))?;
    let response = send(cfg, || {
        client
            .post(format!("{base}/responses"))
            .bearer_auth(key)
            .header("user-agent", "Hexbot Rust X search")
            .json(&body)
    })
    .await?;
    let data = decode_response(response).await?;
    let mut parts = vec![];
    let mut inline = vec![];
    for output in data["output"].as_array().into_iter().flatten() {
        for content in output["content"].as_array().into_iter().flatten() {
            if let Some(text) = content["text"].as_str() {
                parts.push(text);
            }
            for annotation in content["annotations"].as_array().into_iter().flatten() {
                if annotation["type"] == "url_citation" {
                    inline.push(json!({"url":annotation["url"],"title":annotation["title"],"start_index":annotation["start_index"],"end_index":annotation["end_index"]}));
                }
            }
        }
    }
    let citations = data["citations"].as_array().cloned().unwrap_or_default();
    let degraded = !s.filters.is_empty() && citations.is_empty() && inline.is_empty();
    Ok(json!({
        "success": true,
        "provider": "xai",
        "credential_source": auth["provider"],
        "tool": "x_search",
        "model": model,
        "query": s.query,
        "answer": data["output_text"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| parts.join("\n\n")),
        "citations": citations,
        "inline_citations": inline,
        "degraded": degraded,
        "degraded_reason": if degraded {
            Some(format!(
                "no citations returned despite filters: {}",
                s.filters.join(", ")
            ))
        } else {
            None
        }
    }))
}

/// The search X's API understands: the query with its handle filters. The
/// query goes in parentheses first, since AND binds before OR in X's syntax.
fn x_api_query(s: &Search<'_>) -> String {
    if s.allowed.is_empty() && s.excluded.is_empty() {
        return s.query.to_owned();
    }
    let mut query = format!("({})", s.query);
    if !s.allowed.is_empty() {
        let from = s
            .allowed
            .iter()
            .map(|h| format!("from:{h}"))
            .collect::<Vec<_>>()
            .join(" OR ");
        query = format!("{query} ({from})");
    }
    for handle in &s.excluded {
        query.push_str(&format!(" -from:{handle}"));
    }
    query
}

/// Search with X's own API. Recent search covers the last seven days; an
/// older date goes to the full archive.
async fn x_api_search(
    home: &Path,
    bot: &str,
    cfg: &Value,
    p: &Value,
    s: &Search<'_>,
) -> Result<Value> {
    let token = credential(&connectors::credentials(home, bot)?, "X_BEARER_TOKEN")
        .map_err(|_| Error::new(4211, "Save an X API bearer token to use X search"))?;
    let base = connectors::x_api_base(home, Some(bot))?;
    let query = x_api_query(s);
    let now = chrono::Utc::now();
    let day = |date: chrono::NaiveDate| date.and_time(chrono::NaiveTime::MIN).and_utc();
    let oldest = s.from.or(s.to).map(day);
    let archive = oldest.is_some_and(|t| t < now - chrono::Duration::days(7));
    let mut params = vec![
        ("query", query.clone()),
        (
            "max_results",
            cfg["max_results"]
                .as_u64()
                .unwrap_or(20)
                .clamp(10, 100)
                .to_string(),
        ),
        ("sort_order", "relevancy".to_owned()),
        (
            "tweet.fields",
            "created_at,author_id,public_metrics,conversation_id".to_owned(),
        ),
        ("expansions", "author_id".to_owned()),
        ("user.fields", "name,username,verified".to_owned()),
    ];
    if let Some(from) = s.from {
        params.push(("start_time", day(from).format("%Y-%m-%dT%H:%M:%SZ").to_string()));
    }
    // X wants the end at least ten seconds in the past; a later one is now.
    if let Some(to) = s.to
        && let Some(end) = to.succ_opt().map(day)
        && end < now - chrono::Duration::seconds(30)
    {
        params.push(("end_time", end.format("%Y-%m-%dT%H:%M:%SZ").to_string()));
    }
    let path = if archive { "all" } else { "recent" };
    let client = client(timeout(cfg))?;
    let response = send(cfg, || {
        client
            .get(format!("{base}/2/tweets/search/{path}"))
            .bearer_auth(&token)
            .header("user-agent", "Hexbot X search")
            .query(&params)
    })
    .await?;
    match response.status().as_u16() {
        401 | 403 => {
            return Err(Error::new(
                4211,
                format!(
                    "X refused the bearer token (HTTP {}). Check it in Settings, Plugins, X search.",
                    response.status().as_u16()
                ),
            ));
        }
        402 => {
            return Err(Error::new(
                4211,
                "The X API account has no credits left. Add some in the X developer console.",
            ));
        }
        429 => {
            return Err(Error::new(
                5200,
                "The X API rate limit is reached. Try again in a few minutes.",
            ));
        }
        _ => {}
    }
    let data = decode_response(response).await?;
    let users = data["includes"]["users"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|u| Some((u["id"].as_str()?, u)))
        .collect::<std::collections::HashMap<_, _>>();
    let mut posts = vec![];
    let mut lines = vec![];
    for post in data["data"].as_array().into_iter().flatten() {
        let id = post["id"].as_str().unwrap_or_default();
        let author = post["author_id"].as_str().and_then(|a| users.get(a));
        let username = author.and_then(|u| u["username"].as_str());
        let url = match username {
            Some(name) => format!("https://x.com/{name}/status/{id}"),
            None => format!("https://x.com/i/status/{id}"),
        };
        let text = post["text"].as_str().unwrap_or_default();
        let created = post["created_at"].as_str().unwrap_or_default();
        lines.push(format!(
            "@{} ({}): {text}\n{url}",
            username.unwrap_or("unknown"),
            created.get(..10).unwrap_or(created)
        ));
        posts.push(json!({
            "id": id,
            "url": url,
            "text": text,
            "created_at": post["created_at"],
            "author": author.map(|u| json!({"username":u["username"],"name":u["name"],"verified":u["verified"]})),
            "metrics": post["public_metrics"],
        }));
    }
    let citations = posts.iter().map(|p| p["url"].clone()).collect::<Vec<_>>();
    let ignored = ["enable_image_understanding", "enable_video_understanding"]
        .iter()
        .any(|key| p[key] == true);
    Ok(json!({
        "success": true,
        "provider": "x_api",
        "credential_source": "x_api",
        "tool": "x_search",
        "query": s.query,
        "search_query": query,
        "archive": archive,
        "answer": if lines.is_empty() {
            "No posts matched.".to_owned()
        } else {
            lines.join("\n\n")
        },
        "posts": posts,
        "citations": citations,
        "inline_citations": [],
        "degraded": false,
        "degraded_reason": null,
        "note": if ignored {
            Some("X's own search returns posts only; it does not analyze their images or videos.")
        } else {
            None
        }
    }))
}
