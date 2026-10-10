//! Native execution of configured tool backends. No Hermes daemon is required.
use crate::{Error, Result, common, connectors, credentials::desktop_environment};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, OnceLock},
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
    sync::Mutex,
};
const BODY_LIMIT: usize = 24 * 1024 * 1024;
fn failure(message: impl Into<String>) -> Error {
    Error::new(4211, message)
}
fn text<'a>(v: &'a Value, key: &str, default: &'a str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or(default)
}
fn descriptor(name: &str, description: &str, properties: Value, required: &[&str]) -> Value {
    json!({"name":name,"description":description,"parameters":{"type":"object","properties":properties,"required":required}})
}
fn credential(env: &std::collections::BTreeMap<String, String>, name: &str) -> String {
    env.get(name)
        .cloned()
        .or_else(|| std::env::var(name).ok())
        .unwrap_or_default()
}
fn endpoint(env: &std::collections::BTreeMap<String, String>, name: &str, default: &str) -> String {
    let value = credential(env, name);
    if value.is_empty() {
        default.to_owned()
    } else {
        value
    }
}
fn http() -> Result<reqwest::Client> {
    crate::http::client(90, 5).map_err(|_| failure("HTTP client unavailable"))
}
fn http_error(e: reqwest::Error) -> Error {
    crate::http::error(
        e,
        4211,
        [
            "tool request timed out",
            "tool service connection failed",
            "tool service request failed",
        ],
    )
}

async fn bytes(response: reqwest::Response) -> Result<Vec<u8>> {
    if !response.status().is_success() {
        return Err(failure(format!(
            "tool service returned HTTP {}",
            response.status().as_u16()
        )));
    }
    crate::http::bytes(
        response,
        BODY_LIMIT,
        http_error,
        failure("tool response exceeds 24 MB"),
    )
    .await
}
async fn request(request: reqwest::RequestBuilder) -> Result<Value> {
    let body = bytes(request.send().await.map_err(http_error)?).await?;
    serde_json::from_slice(&body).map_err(|_| failure("tool service returned invalid JSON"))
}
tokio::task_local! { static SECTION_CWD: PathBuf; }
// How the section's code runs: in the sandbox its commands get (read-only in
// Manual, the workspace in Auto), with no sandbox (Bypass, `None`), or with the
// base layer when the caller does not say; and the live working directory,
// which a bot or section can change.
tokio::task_local! { pub(crate) static CODE_SANDBOX: (Option<crate::credentials::Confine>, PathBuf); }
pub(crate) fn workdir(home: &Path, bot: &str) -> Result<PathBuf> {
    if let Ok(cwd) = SECTION_CWD.try_with(Clone::clone) {
        return Ok(cwd);
    }
    let path: Option<String> =
        crate::db::open(home)?
            .query_row("SELECT workdir FROM bots WHERE name=?", [bot], |r| r.get(0))?;
    let settings = crate::settings::get(home)?;
    let configured = common::configured_workdir(&[path.as_deref()], &settings);
    common::resolve_workdir(home, configured)
}
/// A section's saved cwd, unless it is missing from the store or now inside the
/// home; then the bot's working directory.
pub(crate) fn section_workdir(home: &Path, bot: &str, stored: &str) -> Result<PathBuf> {
    use rusqlite::OptionalExtension;
    let saved: Option<String> = crate::runtime_store::open(home)?
        .query_row(
            "SELECT options FROM native_sessions WHERE stored_id=? AND bot=?",
            [stored, bot],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(saved) = saved {
        let options: Value =
            serde_json::from_str(&saved).map_err(|_| failure("invalid conversation options"))?;
        let cwd = options["cwd"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or_else(|| failure("conversation working directory is missing"))?;
        if let Some(cwd) = common::saved_workdir(home, cwd) {
            return Ok(cwd);
        }
    }
    workdir(home, bot)
}
/// Resolve existing symlinks before checking both allowed roots, including new output paths.
fn media_path(home: &Path, bot: &str, value: &str) -> Result<PathBuf> {
    let cwd = workdir(home, bot)?;
    let artifacts = artifacts_dir(home, bot)?;
    let input = PathBuf::from(value);
    if input
        .components()
        .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return Err(Error::new(
            4302,
            "media path cannot contain parent traversal",
        ));
    }
    let input = if input.is_absolute() {
        input
    } else {
        cwd.join(input)
    };
    let mut ancestor = input.as_path();
    let mut suffix = Vec::new();
    while !ancestor.try_exists()? {
        if fs::symlink_metadata(ancestor).is_ok() {
            return Err(failure("invalid media path"));
        }
        suffix.push(
            ancestor
                .file_name()
                .ok_or_else(|| failure("invalid media path"))?,
        );
        ancestor = ancestor
            .parent()
            .ok_or_else(|| failure("invalid media path"))?;
    }
    let mut path = fs::canonicalize(ancestor)?;
    for part in suffix.iter().rev() {
        path.push(part);
    }
    if !path.starts_with(fs::canonicalize(cwd)?) && !path.starts_with(fs::canonicalize(artifacts)?)
    {
        return Err(Error::new(
            4302,
            "media path must be inside the working directory or artifacts folder",
        ));
    }
    Ok(path)
}
fn artifacts_dir(home: &Path, bot: &str) -> Result<PathBuf> {
    let profile = crate::catalog::profile(home, bot)?;
    let dir = profile.join("artifacts");
    fs::create_dir_all(&dir)?;
    let canonical = fs::canonicalize(&dir)?;
    if !canonical.starts_with(fs::canonicalize(profile)?) {
        return Err(Error::new(
            4302,
            "artifacts folder must stay inside the bot directory",
        ));
    }
    Ok(dir)
}
fn artifact(home: &Path, bot: &str, kind: &str, extension: &str) -> Result<PathBuf> {
    let root = artifacts_dir(home, bot)?;
    let dir = root.join(kind);
    fs::create_dir_all(&dir)?;
    let canonical = fs::canonicalize(&dir)?;
    if !canonical.starts_with(fs::canonicalize(root)?) {
        return Err(Error::new(
            4302,
            "artifact path escapes the artifacts folder",
        ));
    }
    Ok(dir.join(format!("{}.{}", common::id(), extension)))
}
fn enabled(home: &Path, bot: &str, family: &str) -> Result<bool> {
    Ok(connectors::toolsets(home, bot)?.iter().any(|v| v == family))
}
fn family(name: &str) -> Option<&'static str> {
    match name {
        "web_search" | "web_extract" => Some("web"),
        "execute_code" => Some("code_execution"),
        "vision_analyze" => Some("vision"),
        "computer_use" => Some("computer_use"),
        "text_to_speech" => Some("tts"),
        "image_generate" => Some("image_gen"),
        "browser_exec" | "browser_cdp" | "browser_navigate" | "browser_snapshot"
        | "browser_click" | "browser_type" | "browser_scroll" | "browser_back"
        | "browser_press" | "browser_get_images" | "browser_vision" | "browser_console" => {
            Some("browser")
        }
        _ => None,
    }
}
fn python_command(
    home: &Path,
    cfg: &Value,
    env: &std::collections::BTreeMap<String, String>,
) -> String {
    let configured = credential(env, "HEXBOT_CODE_PYTHON");
    let managed = common::managed_python(home);
    let fallback = if managed != Path::new("python3") {
        managed.to_string_lossy().into_owned()
    } else {
        on_path("python3")
            .or_else(|| on_path("python"))
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|| "python3".into())
    };
    text(
        &cfg["code_execution"],
        "python",
        if configured.is_empty() {
            &fallback
        } else {
            &configured
        },
    )
    .to_owned()
}
fn edge_command(home: &Path, options: &Value) -> String {
    let managed = home.join("bin/edge-tts");
    let fallback = if managed.is_file() {
        managed
    } else {
        on_path("edge-tts").unwrap_or_else(|| PathBuf::from("edge-tts"))
    };
    text(options, "command", &fallback.to_string_lossy()).to_owned()
}
/// Toolsets missing the program they run or the service they call on this
/// computer. They are never offered to a model and never shown in bot
/// settings.
pub fn not_set_up(home: &Path, bot: &str) -> Result<Vec<&'static str>> {
    not_set_up_with_config(home, bot, &common::merged_config(home, bot)?)
}
pub(crate) fn not_set_up_with_config(
    home: &Path,
    bot: &str,
    cfg: &Value,
) -> Result<Vec<&'static str>> {
    let env = connectors::profile_credentials(home, &crate::catalog::profile(home, bot)?)?;
    Ok(
        ["code_execution", "browser", "computer_use", "vision", "tts"]
            .into_iter()
            .filter(|toolset| !set_up(home, cfg, &env, toolset))
            .collect(),
    )
}
fn set_up(
    home: &Path,
    cfg: &Value,
    env: &std::collections::BTreeMap<String, String>,
    toolset: &str,
) -> bool {
    let has = |name: &str| !credential(env, name).is_empty();
    match toolset {
        "code_execution" => on_path(&python_command(home, cfg, env)).is_some(),
        "computer_use" => on_path(text(&computer_config(cfg, env), "command", "")).is_some(),
        "browser" => {
            let browser = &cfg["browser"];
            if text(browser, "backend", "") == "off" {
                return false;
            }
            if !text(browser, "cdp_url", "").is_empty() || has("BROWSER_CDP_URL") {
                return true;
            }
            // The browser-use backend only offers browser_exec, which is not ported.
            if text(browser, "backend", "") == "browser-use" {
                return false;
            }
            match text(browser, "cloud_provider", "") {
                "browserbase" => has("BROWSERBASE_API_KEY") && has("BROWSERBASE_PROJECT_ID"),
                "browser-use" => has("BROWSER_USE_API_KEY"),
                "" | "local" => on_path(&browser_command(cfg)[0]).is_some(),
                _ => false,
            }
        }
        "tts" => speech_set_up(home, cfg, env, text(&cfg["tts"], "provider", "edge")),
        "vision" => {
            let aux = &cfg["auxiliary"]["vision"];
            // An explicit endpoint may need no key, like a local server.
            let endpoint = !text(aux, "base_url", "").is_empty();
            match text(aux, "provider", text(&cfg["model"], "provider", "openai")) {
                "anthropic" | "claude" => endpoint || has("ANTHROPIC_API_KEY"),
                "google" | "gemini" => endpoint || has("GOOGLE_API_KEY") || has("GEMINI_API_KEY"),
                "openai" | "openai-api" => endpoint || has("OPENAI_API_KEY"),
                "openrouter" => endpoint || has("OPENROUTER_API_KEY"),
                "ollama" => true,
                "custom" => endpoint || !text(&cfg["model"], "base_url", "").is_empty(),
                _ => false,
            }
        }
        _ => true,
    }
}
fn speech_set_up(
    home: &Path,
    cfg: &Value,
    env: &std::collections::BTreeMap<String, String>,
    provider: &str,
) -> bool {
    let has = |name: &str| !credential(env, name).is_empty();
    let options = &cfg["tts"][provider];
    match provider {
        "openai" => {
            has("VOICE_TOOLS_OPENAI_KEY")
                || has("OPENAI_API_KEY")
                || !text(options, "base_url", "").is_empty()
        }
        "mistral" => has("MISTRAL_API_KEY"),
        "elevenlabs" => has("ELEVENLABS_API_KEY"),
        "edge" => on_path(&edge_command(home, options)).is_some(),
        name => {
            let custom = &cfg["tts"]["providers"][name];
            custom["type"] == "command" && custom["command"].as_str().and_then(on_path).is_some()
        }
    }
}
pub fn descriptors(home: &Path, bot: &str) -> Result<Vec<Value>> {
    let enabled = connectors::toolsets(home, bot)?;
    let cfg = common::merged_config(home, bot)?;
    let env = connectors::credentials(home, bot)?;
    let mut out = vec![];
    let mut ready = std::collections::HashMap::new();
    let mut add = |family: &str, d: Value| {
        if enabled.iter().any(|v| v == family)
            && *ready
                .entry(family.to_owned())
                .or_insert_with(|| set_up(home, &cfg, &env, family))
        {
            out.push(d)
        }
    };
    add(
        "web",
        descriptor(
            "web_search",
            "Search the configured web search service for titles, URLs and descriptions.",
            json!({"query":{"type":"string"},"limit":{"type":"integer","minimum":1,"maximum":100,"default":5}}),
            &["query"],
        ),
    );
    add(
        "web",
        descriptor(
            "web_extract",
            "Extract page content from up to five URLs. Long pages are saved in full to a local file.",
            json!({"urls":{"type":"array","items":{"type":"string"},"maxItems":5},"char_limit":{"type":"integer","minimum":2000,"default":15000}}),
            &["urls"],
        ),
    );
    add(
        "code_execution",
        descriptor(
            "execute_code",
            "Execute Python in a persistent conversation kernel. Variables and imports persist. Print the result. Set reset to discard prior kernel state.",
            json!({"code":{"type":"string"},"reset":{"type":"boolean"}}),
            &["code"],
        ),
    );
    add(
        "vision",
        descriptor(
            "vision_analyze",
            "Analyze an image using the configured vision model.",
            json!({"image_url":{"type":"string"},"question":{"type":"string"},"region":{"type":"array","items":{"type":"integer"},"minItems":4,"maxItems":4}}),
            &["image_url", "question"],
        ),
    );
    add(
        "tts",
        descriptor(
            "text_to_speech",
            "Convert text to an audio file using the configured speech provider.",
            json!({"text":{"type":"string"},"output_path":{"type":"string"},"speed":{"type":"number","minimum":0.25,"maximum":4},"instructions":{"type":"string"},"provider":{"type":"string"}}),
            &["text"],
        ),
    );
    add(
        "image_gen",
        descriptor(
            "image_generate",
            "Generate an image from a prompt using the configured image provider.",
            json!({"prompt":{"type":"string"},"aspect_ratio":{"type":"string"},"image_url":{"type":"string"},"reference_image_urls":{"type":"array","items":{"type":"string"}}}),
            &["prompt"],
        ),
    );
    if text(&cfg["browser"], "backend", "") == "browser-use"
        && browser_use_command(home, &cfg).is_some()
    {
        add(
            "browser",
            descriptor(
                "browser_exec",
                "Execute Python using the configured Browser Use CLI browser helpers.",
                json!({"code":{"type":"string"},"timeout_s":{"type":"integer","minimum":5,"maximum":1800}}),
                &["code"],
            ),
        );
    }
    if on_path(text(&computer_config(&cfg, &env), "command", "")).is_some() {
        add(
            "computer_use",
            descriptor(
                "computer_use",
                "Control desktop applications through the configured cua-driver. Capture first, then use returned element indices or window coordinates. Preserve verdicts and recapture after changes.",
                json!({
                    "action": {
                        "type": "string",
                        "enum": [
                            "capture",
                            "click",
                            "double_click",
                            "right_click",
                            "middle_click",
                            "drag",
                            "scroll",
                            "type",
                            "key",
                            "set_value",
                            "wait",
                            "list_apps",
                            "list_windows",
                            "focus_app"
                        ]
                    },
                    "mode": {
                        "type": "string",
                        "enum": ["som", "vision", "ax"]
                    },
                    "app": { "type": "string" },
                    "pid": { "type": "integer" },
                    "window_id": { "type": "integer" },
                    "element": { "type": "integer" },
                    "coordinate": {
                        "type": "array",
                        "items": { "type": "integer" },
                        "minItems": 2,
                        "maxItems": 2
                    },
                    "from_coordinate": {
                        "type": "array",
                        "items": { "type": "integer" },
                        "minItems": 2,
                        "maxItems": 2
                    },
                    "to_coordinate": {
                        "type": "array",
                        "items": { "type": "integer" },
                        "minItems": 2,
                        "maxItems": 2
                    },
                    "from_element": { "type": "integer" },
                    "to_element": { "type": "integer" },
                    "button": { "type": "string" },
                    "modifiers": {
                        "type": "array",
                        "items": { "type": "string" }
                    },
                    "text": { "type": "string" },
                    "keys": { "type": "string" },
                    "value": { "type": "string" },
                    "direction": { "type": "string" },
                    "amount": { "type": "integer" },
                    "seconds": { "type": "number" },
                    "delivery_mode": {
                        "type": "string",
                        "enum": ["background", "foreground"]
                    },
                    "bring_to_front": { "type": "boolean" },
                    "capture_after": { "type": "boolean" }
                }),
                &["action"],
            ),
        );
    }
    if !matches!(text(&cfg["browser"], "backend", ""), "browser-use" | "off") {
        for (name, description, properties, required) in [
            (
                "browser_navigate",
                "Open a URL and return an accessibility snapshot.",
                json!({"url":{"type":"string"}}),
                vec!["url"],
            ),
            (
                "browser_snapshot",
                "Capture the page accessibility tree and element references.",
                json!({"full":{"type":"boolean"}}),
                vec![],
            ),
            (
                "browser_click",
                "Click an element reference from the page snapshot.",
                json!({"ref":{"type":"string"}}),
                vec!["ref"],
            ),
            (
                "browser_type",
                "Fill an input identified by its snapshot reference.",
                json!({"ref":{"type":"string"},"text":{"type":"string"}}),
                vec!["ref", "text"],
            ),
            (
                "browser_scroll",
                "Scroll the page.",
                json!({"direction":{"type":"string","enum":["up","down","left","right"]},"pixels":{"type":"integer"}}),
                vec!["direction"],
            ),
            (
                "browser_back",
                "Return to the previous page.",
                json!({}),
                vec![],
            ),
            (
                "browser_press",
                "Press a keyboard key or shortcut in the page.",
                json!({"key":{"type":"string"}}),
                vec!["key"],
            ),
            (
                "browser_get_images",
                "List page image URLs and alt text.",
                json!({}),
                vec![],
            ),
            (
                "browser_vision",
                "Capture a browser screenshot for visual inspection.",
                json!({"question":{"type":"string"},"annotate":{"type":"boolean"}}),
                vec!["question"],
            ),
            (
                "browser_console",
                "Read console messages or evaluate JavaScript in the page.",
                json!({"expression":{"type":"string"},"clear":{"type":"boolean"}}),
                vec![],
            ),
        ] {
            add(
                "browser",
                descriptor(name, description, properties, &required),
            );
        }
    }
    if !text(&cfg["browser"], "cdp_url", "").is_empty()
        || !credential(&env, "BROWSER_CDP_URL").is_empty()
    {
        add(
            "browser",
            descriptor(
                "browser_cdp",
                "Send a Chrome DevTools Protocol command to the configured browser. Use Target.getTargets to discover tabs; page commands require target_id.",
                json!({"method":{"type":"string"},"params":{"type":"object","additionalProperties":true},"target_id":{"type":"string"},"timeout":{"type":"number","minimum":1,"maximum":120}}),
                &["method"],
            ),
        );
    }
    out.extend(crate::native_external_tools::descriptors(home, bot)?);
    out.extend(crate::native_product_tools::descriptors(home, bot)?);

    Ok(out)
}
pub async fn call(
    home: &Path,
    owner: &str,
    bot: &str,
    stored: &str,
    name: &str,
    args: &Value,
) -> Result<Value> {
    common::bot_owner(home, owner, bot)?;
    common::identifier(stored)?;
    let mut stopped = {
        let mut map = cancellations().lock().unwrap_or_else(|e| e.into_inner());
        map.entry((home.to_owned(), stored.to_owned()))
            .or_insert_with(|| tokio::sync::watch::channel(false).0)
            .subscribe()
    };
    let cwd = section_workdir(home, bot, stored)?;
    let request = SECTION_CWD.scope(cwd, async {
        if let Some(result) =
            crate::native_product_tools::call(home, owner, bot, stored, name, args).await
        {
            return result;
        }
        if let Some(result) =
            crate::native_external_tools::call(home, owner, bot, name, args.clone()).await
        {
            return result;
        }
        let family =
            family(name).ok_or_else(|| Error::new(4204, format!("unknown native tool: {name}")))?;
        if !enabled(home, bot, family)? {
            return Err(Error::new(4302, format!("tool is disabled: {name}")));
        }
        let cfg = common::merged_config(home, bot)?;
        let env = connectors::credentials(home, bot)?;
        let available = if name == "text_to_speech" {
            speech_set_up(
                home,
                &cfg,
                &env,
                text(args, "provider", text(&cfg["tts"], "provider", "edge")),
            )
        } else {
            set_up(home, &cfg, &env, family)
        };
        if !available {
            return Err(Error::new(
                4302,
                format!("tool is not set up on this computer: {name}"),
            ));
        }
        match name {
            "web_search" => search(&cfg, &env, args).await,
            "web_extract" => extract(home, bot, &cfg, &env, args).await,
            "execute_code" => execute_code(home, bot, stored, &cfg, &env, args).await,
            "vision_analyze" => vision(home, bot, &cfg, &env, args).await,
            "computer_use" => computer_use(home, bot, stored, &cfg, &env, args).await,
            "text_to_speech" => speech(home, bot, &cfg, &env, args).await,
            "image_generate" => image_generate(home, bot, &cfg, &env, args).await,
            "browser_exec" => browser_exec().await,
            "browser_cdp" => browser_cdp(&cfg, &env, args).await,
            "browser_navigate" | "browser_snapshot" | "browser_click" | "browser_type"
            | "browser_scroll" | "browser_back" | "browser_press" | "browser_get_images"
            | "browser_vision" | "browser_console" => {
                browser_tool(home, bot, stored, &cfg, &env, name, args).await
            }
            _ => Err(Error::new(4204, format!("unknown native tool: {name}"))),
        }
    });
    tokio::select! {
        result=request=>result,
        _=async {while !*stopped.borrow(){if stopped.changed().await.is_err(){break}}}=>Err(Error::new(5201,"tool interrupted")),
    }
}
fn web_backend(
    cfg: &Value,
    env: &std::collections::BTreeMap<String, String>,
    extract: bool,
) -> String {
    let selected = text(
        &cfg["web"],
        if extract {
            "extract_backend"
        } else {
            "search_backend"
        },
        text(&cfg["web"], "backend", "auto"),
    );
    if selected != "auto"
        && !selected.is_empty()
        && !(extract && matches!(selected, "brave" | "brave-free" | "searxng"))
    {
        return selected.to_owned();
    }
    for (backend, key) in [
        ("tavily", "TAVILY_API_KEY"),
        ("exa", "EXA_API_KEY"),
        ("parallel", "PARALLEL_API_KEY"),
        ("keenable", "KEENABLE_API_KEY"),
        ("firecrawl", "FIRECRAWL_API_KEY"),
        ("searxng", "SEARXNG_URL"),
        ("brave-free", "BRAVE_SEARCH_API_KEY"),
    ] {
        if !credential(env, key).is_empty()
            && !(extract && matches!(backend, "brave-free" | "searxng"))
        {
            return backend.to_owned();
        }
    }
    "tavily".into()
}
fn authorize(
    request: reqwest::RequestBuilder,
    env: &std::collections::BTreeMap<String, String>,
    key: &str,
    header: Option<&str>,
) -> reqwest::RequestBuilder {
    let key = credential(env, key);
    if key.is_empty() {
        request
    } else if let Some(header) = header {
        request.header(header, key)
    } else {
        request.bearer_auth(key)
    }
}
async fn search(
    cfg: &Value,
    env: &std::collections::BTreeMap<String, String>,
    args: &Value,
) -> Result<Value> {
    let query = common::required(args, "query")?;
    let limit = args
        .get("limit")
        .map(|v| {
            v.as_u64()
                .filter(|n| (1..=100).contains(n))
                .ok_or_else(|| Error::new(4202, "limit must be between 1 and 100"))
        })
        .transpose()?
        .unwrap_or(5);
    let backend = web_backend(cfg, env, false);
    let client = http()?;
    let response = match backend.as_str() {
        "keenable" => {
            request(authorize(
                client
                    .post(format!(
                        "{}/v1/search",
                        endpoint(env, "KEENABLE_BASE_URL", "https://api.keenable.ai")
                            .trim_end_matches('/')
                    ))
                    .header("X-Keenable-Title", "hexbot")
                    .json(&json!({
                        "query": query,
                        "max_results": limit.min(20)
                    })),
                env,
                "KEENABLE_API_KEY",
                None,
            ))
            .await?
        }
        "tavily" => {
            let req = client
                .post(format!(
                    "{}/search",
                    endpoint(env, "TAVILY_BASE_URL", "https://api.tavily.com")
                        .trim_end_matches('/')
                ))
                .header("X-Client-Name", "hexbot")
                .json(&json!({ "query": query, "max_results": limit.min(20) }));
            let req = if credential(env, "TAVILY_API_KEY").is_empty() {
                req.header("X-Tavily-Access-Mode", "keyless")
            } else {
                authorize(req, env, "TAVILY_API_KEY", None)
            };
            request(req).await?
        }
        "exa" => {
            request(authorize(
                client
                    .post(format!(
                        "{}/search",
                        endpoint(env, "EXA_BASE_URL", "https://api.exa.ai").trim_end_matches('/')
                    ))
                    .json(&json!({
                        "query": query,
                        "numResults": limit,
                        "contents": { "highlights": true }
                    })),
                env,
                "EXA_API_KEY",
                Some("x-api-key"),
            ))
            .await?
        }
        "parallel" => {
            request(authorize(
                client
                    .post(format!(
                        "{}/v1beta/search",
                        endpoint(env, "PARALLEL_BASE_URL", "https://api.parallel.ai")
                            .trim_end_matches('/')
                    ))
                    .json(&json!({
                        "search_queries": [query],
                        "objective": query,
                        "mode": "agentic",
                        "max_results": limit.min(20)
                    })),
                env,
                "PARALLEL_API_KEY",
                Some("x-api-key"),
            ))
            .await?
        }
        "firecrawl" => {
            request(authorize(
                client
                    .post(format!(
                        "{}/v2/search",
                        endpoint(env, "FIRECRAWL_API_URL", "https://api.firecrawl.dev")
                            .trim_end_matches('/')
                    ))
                    .json(&json!({ "query": query, "limit": limit })),
                env,
                "FIRECRAWL_API_KEY",
                None,
            ))
            .await?
        }
        "searxng" => {
            let base = credential(env, "SEARXNG_URL");
            if base.is_empty() {
                return Err(failure("SEARXNG_URL is not configured"));
            }
            request(
                client
                    .get(format!("{}/search", base.trim_end_matches('/')))
                    .query(&[("q", query), ("format", "json")]),
            )
            .await?
        }
        "brave" | "brave-free" => {
            request(authorize(
                client
                    .get(endpoint(
                        env,
                        "BRAVE_SEARCH_URL",
                        "https://api.search.brave.com/res/v1/web/search",
                    ))
                    .query(&[("q", query), ("count", &limit.min(20).to_string())]),
                env,
                "BRAVE_SEARCH_API_KEY",
                Some("X-Subscription-Token"),
            ))
            .await?
        }
        other => {
            return Err(failure(format!(
                "web search backend has not been ported: {other}"
            )));
        }
    };
    let values = response["results"]
        .as_array()
        .or_else(|| response["web"]["results"].as_array())
        .or_else(|| response["data"]["web"].as_array())
        .or_else(|| response["data"].as_array())
        .ok_or_else(|| failure("search service returned no results array"))?;
    let results = values
        .iter()
        .take(limit as usize)
        .enumerate()
        .map(|(i, row)| {
            let description = row["description"]
                .as_str()
                .or_else(|| row["snippet"].as_str())
                .or_else(|| row["content"].as_str())
                .map(str::to_owned)
                .unwrap_or_else(|| {
                    row["highlights"]
                        .as_array()
                        .or_else(|| row["excerpts"].as_array())
                        .into_iter()
                        .flatten()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join(" ")
                });
            json!({
                "title": text(row, "title", ""),
                "url": text(row, "url", ""),
                "description": description,
                "position": i + 1
            })
        })
        .collect::<Vec<_>>();
    Ok(json!({"success":true,"data":{"web":results}}))
}
async fn extract(
    home: &Path,
    bot: &str,
    cfg: &Value,
    env: &std::collections::BTreeMap<String, String>,
    args: &Value,
) -> Result<Value> {
    let urls = args["urls"]
        .as_array()
        .filter(|v| !v.is_empty() && v.len() <= 5)
        .ok_or_else(|| Error::new(4202, "urls must contain one to five URLs"))?;
    let allow_private = common::allow_private_urls(home, bot)?;
    let mut checked_urls = Vec::with_capacity(urls.len());
    for value in urls {
        let url = value
            .as_str()
            .ok_or_else(|| Error::new(4202, "URL must be a string"))?;
        // Check every redirect before handing the final URL to an extraction service.
        let response = common::safe_get(url, allow_private).await?;
        checked_urls.push(response.url().to_string());
    }
    let urls = checked_urls;
    let limit = args
        .get("char_limit")
        .map(|v| {
            v.as_u64()
                .filter(|n| *n >= 2000)
                .ok_or_else(|| Error::new(4202, "char_limit must be at least 2000"))
        })
        .transpose()?
        .unwrap_or(15000)
        .min(1_000_000) as usize;
    let backend = web_backend(cfg, env, true);
    let client = http()?;
    let mut results = match backend.as_str() {
        "keenable" => {
            let mut values = vec![];
            for url in &urls {
                let result = request(authorize(
                    client
                        .get(format!(
                            "{}/v1/fetch",
                            endpoint(env, "KEENABLE_BASE_URL", "https://api.keenable.ai")
                                .trim_end_matches('/')
                        ))
                        .header("X-Keenable-Title", "hexbot")
                        .query(&[("url", url)]),
                    env,
                    "KEENABLE_API_KEY",
                    None,
                ))
                .await;
                values.push(match result {
                    Ok(mut v) => {
                        v["url"] = json!(url);
                        v
                    }
                    Err(e) => json!({"url":url,"error":e.message}),
                });
            }
            values
        }
        "tavily" => {
            let req = client
                .post(format!(
                    "{}/extract",
                    endpoint(env, "TAVILY_BASE_URL", "https://api.tavily.com")
                        .trim_end_matches('/')
                ))
                .header("X-Client-Name", "hexbot")
                .json(&json!({"urls":urls,"format":"markdown"}));
            let req = if credential(env, "TAVILY_API_KEY").is_empty() {
                req.header("X-Tavily-Access-Mode", "keyless")
            } else {
                authorize(req, env, "TAVILY_API_KEY", None)
            };
            let data = request(req).await?;
            let mut values = data["results"]
                .as_array()
                .cloned()
                .ok_or_else(|| failure("extract service returned no results array"))?;
            for err in data["failed_results"].as_array().into_iter().flatten() {
                values.push(json!({"url":err["url"],"error":err["error"]}));
            }
            values
        }
        "exa" => {
            let data = request(authorize(
                client
                    .post(format!(
                        "{}/contents",
                        endpoint(env, "EXA_BASE_URL", "https://api.exa.ai").trim_end_matches('/')
                    ))
                    .json(&json!({"ids":urls,"text":true})),
                env,
                "EXA_API_KEY",
                Some("x-api-key"),
            ))
            .await?;
            data["results"]
                .as_array()
                .cloned()
                .ok_or_else(|| failure("extract service returned no results array"))?
        }
        "parallel" => {
            let data = request(authorize(
                client
                    .post(format!(
                        "{}/v1beta/extract",
                        endpoint(env, "PARALLEL_BASE_URL", "https://api.parallel.ai")
                            .trim_end_matches('/')
                    ))
                    .json(&json!({"urls":urls,"full_content":true})),
                env,
                "PARALLEL_API_KEY",
                Some("x-api-key"),
            ))
            .await?;
            data["results"]
                .as_array()
                .cloned()
                .ok_or_else(|| failure("extract service returned no results array"))?
        }
        "firecrawl" => {
            let mut values = vec![];
            for url in &urls {
                let result = request(authorize(
                    client
                        .post(format!(
                            "{}/v2/scrape",
                            endpoint(env, "FIRECRAWL_API_URL", "https://api.firecrawl.dev")
                                .trim_end_matches('/')
                        ))
                        .json(&json!({"url":url,"formats":["markdown"]})),
                    env,
                    "FIRECRAWL_API_KEY",
                    None,
                ))
                .await;
                values.push(match result {
                    Ok(v) => json!({"url":url,"title":v["data"]["metadata"]["title"],"content":v["data"]["markdown"]}),
                    Err(e) => json!({"url":url,"error":e.message}),
                });
            }
            values
        }
        other => {
            return Err(failure(format!(
                "web extraction backend has not been ported: {other}"
            )));
        }
    };
    for row in &mut results {
        if !row["error"].is_null() {
            continue;
        }
        let content = row["raw_content"]
            .as_str()
            .or_else(|| row["text"].as_str())
            .or_else(|| row["content"].as_str())
            .or_else(|| row["full_content"].as_str())
            .unwrap_or("")
            .to_owned();
        let chars = content.chars().count();
        row["content"] = json!(content);
        row["raw_content"] = json!(content);
        if chars > limit {
            let path = artifact(home, bot, "web", "md")?;
            common::atomic_write(&path, content.as_bytes())?;
            let tail = limit / 4;
            row["content"] = json!(format!(
                "{}\n\n[Full content: {}]\n\n{}",
                content.chars().take(limit - tail).collect::<String>(),
                path.display(),
                content.chars().skip(chars - tail).collect::<String>()
            ));
            row["raw_content"] = row["content"].clone();
            row["full_content_path"] = json!(path);
        }
    }
    Ok(json!({"results":results}))
}
const KERNEL: &str = r#"
import sys,json,io,contextlib,traceback,shlex,time,types,threading
wire=sys.stdout
rpc_lock=threading.Lock()
def tool_proxy(name):
 def call(*positional,**args):
  if len(positional)>1: raise TypeError('Pass tool arguments by name')
  if positional:
   field={'terminal':'command','bash':'command','read_file':'path','read':'path','web_search':'query','web_extract':'urls','vision_analyze':'image_url','text_to_speech':'text','image_generate':'prompt'}.get(name)
   if field is None: raise TypeError('Pass tool arguments by name')
   args[field]=positional[0]
  with rpc_lock:
   wire.write(json.dumps({'hexbot_tool':name,'args':args})+'\n');wire.flush()
   reply=json.loads(sys.stdin.readline())
  if 'error' in reply: raise RuntimeError(reply['error'])
  return reply.get('result')
 return call
helpers=types.ModuleType('hermes_tools')
helpers.__getattr__=lambda name: tool_proxy(name) if not name.startswith('__') else None
sys.modules['hermes_tools']=helpers
class Output(io.StringIO):
 def __init__(self,path):
  super().__init__();self.path=path;self.file=open(path,'w',encoding='utf-8');self.total=0
 def write(self,s):
  n=len(s);self.file.write(s);self.total+=n
  if self.tell()<100000: super().write(s[:100000-self.tell()])
  return n
 def finish(self):
  self.file.close()
  return self.getvalue()+('\n[Full output saved to '+self.path+']' if self.total>100000 else '')
def retry(fn,max_attempts=3,delay=2):
 for attempt in range(max_attempts):
  try: return fn()
  except Exception:
   if attempt+1==max_attempts: raise
   time.sleep(delay*2**attempt)
state={'__name__':'__main__','json_parse':json.loads,'shell_quote':shlex.quote,'retry':retry}
for line in sys.stdin:
 try:
  command=json.loads(line);output=Output(command['stdout_path']);errors=Output(command['stderr_path']);failed=False
  with contextlib.redirect_stdout(output),contextlib.redirect_stderr(errors):
   try: exec(compile(command['code'],'<hexbot-code>','exec'),state)
   except BaseException: traceback.print_exc();failed=True
  print(json.dumps({'output':output.finish(),'stderr':errors.finish(),'output_path':output.path,'stderr_path':errors.path,'success':not failed}),flush=True)
 except Exception as error: print(json.dumps({'success':False,'error':str(error)}),flush=True)
"#;
struct Kernel {
    sandbox: (Option<crate::credentials::Confine>, PathBuf),
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
}
pub type ToolDispatcher = Arc<
    dyn Fn(
            String,
            Value,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Value>> + Send>>
        + Send
        + Sync,
>;
type Cancellations = HashMap<(PathBuf, String), tokio::sync::watch::Sender<bool>>;
fn cancellations() -> &'static std::sync::Mutex<Cancellations> {
    static SIGNALS: OnceLock<std::sync::Mutex<Cancellations>> = OnceLock::new();
    SIGNALS.get_or_init(Default::default)
}
type Dispatchers = HashMap<(PathBuf, String), ToolDispatcher>;
fn dispatchers() -> &'static std::sync::Mutex<Dispatchers> {
    static DISPATCHERS: OnceLock<std::sync::Mutex<Dispatchers>> = OnceLock::new();
    DISPATCHERS.get_or_init(Default::default)
}
pub fn register_dispatcher(home: &Path, stored: &str, callback: ToolDispatcher) {
    dispatchers()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert((home.to_owned(), stored.to_owned()), callback);
}
type KernelMap = HashMap<(PathBuf, String, String), Arc<Mutex<Option<Kernel>>>>;
fn kernels() -> &'static Mutex<KernelMap> {
    static KERNELS: OnceLock<Mutex<KernelMap>> = OnceLock::new();
    KERNELS.get_or_init(Default::default)
}
pub async fn close_session(home: &Path, stored: &str) {
    if let Some(sender) = cancellations()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&(home.to_owned(), stored.to_owned()))
    {
        let _ = sender.send(true);
    }
    close_browsers(home, stored).await;
    dispatchers()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&(home.to_owned(), stored.to_owned()));
    let removed_computers = {
        let mut map = computers().lock().await;
        let keys = map
            .keys()
            .filter(|(h, _, s)| h == home && s == stored)
            .cloned()
            .collect::<Vec<_>>();
        for key in &keys {
            map.remove(key);
        }
        keys
    };
    for (_, bot, session) in removed_computers {
        connectors::close_config(home, &bot, &format!("hexbot-cua-{session}")).await;
    }
    let removed = {
        let mut map = kernels().lock().await;
        let keys = map
            .keys()
            .filter(|(h, _, s)| h == home && s == stored)
            .cloned()
            .collect::<Vec<_>>();
        keys.into_iter()
            .filter_map(|k| map.remove(&k))
            .collect::<Vec<_>>()
    };
    for kernel in removed {
        if let Some(mut worker) = kernel.lock().await.take() {
            let _ = worker.child.kill().await;
            let _ = worker.child.wait().await;
        }
    }
}
async fn execute_code(
    home: &Path,
    bot: &str,
    stored: &str,
    cfg: &Value,
    env: &std::collections::BTreeMap<String, String>,
    args: &Value,
) -> Result<Value> {
    let code = common::required(args, "code")?;
    crate::credentials::check_code(code)?;
    let key = (home.to_owned(), bot.to_owned(), stored.to_owned());
    let kernel = kernels()
        .lock()
        .await
        .entry(key)
        .or_insert_with(|| Arc::new(Mutex::new(None)))
        .clone();
    let mut kernel = kernel.lock().await;
    let sandbox = match CODE_SANDBOX.try_with(Clone::clone) {
        Ok(sandbox) => sandbox,
        Err(_) => (Some(crate::credentials::Confine::No), workdir(home, bot)?),
    };
    // A mode or workspace change takes effect on the next run: the worker
    // restarts in the new sandbox.
    if (args["reset"] == true
        || kernel.as_ref().is_some_and(|k| k.sandbox != sandbox)
        || kernel
            .as_mut()
            .is_some_and(|k| k.child.try_wait().ok().flatten().is_some()))
        && let Some(mut worker) = kernel.take()
    {
        let _ = worker.child.kill().await;
        let _ = worker.child.wait().await;
    }
    if kernel.is_none() {
        let python = python_command(home, cfg, env);
        let python = python.as_str();
        let mut command = match sandbox.0 {
            None => Command::new(python),
            Some(confine) => crate::credentials::isolated_command_with_outputs(
                home,
                python,
                &[sandbox.1.clone(), artifacts_dir(home, bot)?],
                confine,
                &[artifacts_dir(home, bot)?],
            ).map_err(|mut error| {
                if cfg!(target_os = "linux") && error.code == 5240 {
                    error.message.push_str(" If the workspace scan cannot finish, run this Python code with the terminal tool using full_access and a reason, or choose a smaller workspace.");
                }
                error
            })?,
        };
        desktop_environment(&mut command);
        let mut child = command
            .args(["-u", "-c", KERNEL])
            .current_dir(&sandbox.1)
            .env("PYTHONUNBUFFERED", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|_| failure(format!("Python code runtime could not start: {python}")))?;
        *kernel = Some(Kernel {
            sandbox: sandbox.clone(),
            input: child.stdin.take().expect("piped stdin"),
            output: BufReader::new(child.stdout.take().expect("piped stdout")),
            child,
        });
    }
    let worker = kernel.as_mut().expect("kernel initialized");
    let seconds = cfg["code_execution"]["timeout"]
        .as_u64()
        .unwrap_or(120)
        .clamp(1, 1800);
    let stdout_path = artifact(home, bot, "code", "stdout.txt")?;
    let stderr_path = artifact(home, bot, "code", "stderr.txt")?;
    let result = tokio::time::timeout(Duration::from_secs(seconds), async {
        worker
            .input
            .write_all(
                format!(
                    "{}\n",
                    json!({"code":code,"stdout_path":stdout_path,"stderr_path":stderr_path})
                )
                .as_bytes(),
            )
            .await?;
        worker.input.flush().await?;
        loop {
            let mut line = String::new();
            let count = (&mut worker.output)
                .take(512 * 1024)
                .read_line(&mut line)
                .await?;
            if count == 0 {
                return Err(failure("Python code runtime exited unexpectedly"));
            }
            let value: Value = serde_json::from_str(&line)
                .map_err(|_| failure("Python code runtime returned invalid output"))?;
            let Some(tool) = value["hexbot_tool"].as_str() else {
                return Ok(value);
            };
            let dispatcher = dispatchers()
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get(&(home.to_owned(), stored.to_owned()))
                .cloned();
            let result = if tool == "execute_code" {
                Err(Error::new(4202, "execute_code cannot call itself"))
            } else if let Some(dispatcher) = dispatcher {
                dispatcher(tool.to_owned(), value["args"].clone()).await
            } else {
                Err(failure("conversation tool dispatcher is not attached"))
            };
            let response = match result {
                Ok(value) => json!({"result":value}),
                Err(error) => json!({"error":error.message}),
            };
            worker
                .input
                .write_all(format!("{response}\n").as_bytes())
                .await?;
            worker.input.flush().await?;
        }
    })
    .await;
    match result {
        Ok(Ok(value)) => Ok(value),
        other => {
            if let Some(mut worker) = kernel.take() {
                let _ = worker.child.kill().await;
                let _ = worker.child.wait().await;
            }
            match other {
                Ok(Err(e)) => Err(e),
                Err(_) => Err(failure(
                    "Python execution timed out; kernel state was reset",
                )),
                _ => unreachable!(),
            }
        }
    }
}
async fn run(mut command: Command, input: &[u8], seconds: u64) -> Result<Value> {
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command
        .spawn()
        .map_err(|e| failure(format!("tool command could not start: {e}")))?;
    let mut stdin = child.stdin.take().expect("piped stdin");
    let mut stdout = child.stdout.take().expect("piped stdout");
    let mut stderr = child.stderr.take().expect("piped stderr");
    let result = tokio::time::timeout(Duration::from_secs(seconds), async {
        let write = async move {
            stdin.write_all(input).await?;
            drop(stdin);
            Ok::<_, std::io::Error>(())
        };
        let read_out = async {
            let mut data = Vec::new();
            let mut chunk = [0u8; 8192];
            loop {
                let n = stdout.read(&mut chunk).await?;
                if n == 0 {
                    break;
                }
                let count = n.min(100_000usize.saturating_sub(data.len()));
                data.extend_from_slice(&chunk[..count]);
            }
            Ok::<_, std::io::Error>(data)
        };
        let read_err = async {
            let mut data = Vec::new();
            let mut chunk = [0u8; 8192];
            loop {
                let n = stderr.read(&mut chunk).await?;
                if n == 0 {
                    break;
                }
                let count = n.min(100_000usize.saturating_sub(data.len()));
                data.extend_from_slice(&chunk[..count]);
            }
            Ok::<_, std::io::Error>(data)
        };
        let (_, out, err, status) = tokio::try_join!(write, read_out, read_err, child.wait())?;
        Ok::<_, Error>(json!({"output":String::from_utf8_lossy(&out),"stderr":String::from_utf8_lossy(&err),"exit_code":status.code(),"success":status.success()}))
    })
    .await;
    match result {
        Ok(v) => v,
        Err(_) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            Err(failure("tool command timed out"))
        }
    }
}
async fn browser_exec() -> Result<Value> {
    Err(Error::new(
        4302,
        "Browser code execution requires network interception. Use the managed browser tools.",
    ))
}

pub(crate) async fn image_data(home: &Path, bot: &str, value: &str) -> Result<String> {
    if value.starts_with("https://") || value.starts_with("http://") {
        let response = common::safe_get(value, common::allow_private_urls(home, bot)?).await?;
        let mime = response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("image/png")
            .split(';')
            .next()
            .unwrap_or("image/png")
            .to_owned();
        if !["image/png", "image/jpeg", "image/webp", "image/gif"].contains(&mime.as_str()) {
            return Err(Error::new(4202, "URL did not return an image"));
        }
        return Ok(format!(
            "data:{mime};base64,{}",
            STANDARD.encode(bytes(response).await?)
        ));
    }
    if value.starts_with("data:image/") {
        if value.len() > BODY_LIMIT * 2 {
            return Err(Error::new(4202, "image exceeds size limit"));
        }
        return Ok(value.to_owned());
    }
    let path = media_path(home, bot, value)?;
    let mime = match path
        .extension()
        .and_then(|v| v.to_str())
        .unwrap_or("")
        .to_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "jpeg" | "jpg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        _ => {
            return Err(Error::new(
                4202,
                "supported image types: PNG, JPEG, WebP, GIF",
            ));
        }
    };
    Ok(format!(
        "data:{mime};base64,{}",
        STANDARD.encode(common::read_regular(&path, 20 * 1024 * 1024)?)
    ))
}
async fn vision(
    home: &Path,
    bot: &str,
    cfg: &Value,
    env: &std::collections::BTreeMap<String, String>,
    args: &Value,
) -> Result<Value> {
    let original = common::required(args, "image_url")?;
    let image = if let Some(region) = args.get("region") {
        let coords = region
            .as_array()
            .filter(|v| v.len() == 4)
            .ok_or_else(|| Error::new(4202, "region must contain x1, y1, x2, y2"))?;
        let coords = coords
            .iter()
            .map(|v| {
                v.as_u64()
                    .filter(|n| *n <= u32::MAX as u64)
                    .map(|n| n as u32)
                    .ok_or_else(|| {
                        Error::new(4202, "region coordinates must be non-negative integers")
                    })
            })
            .collect::<Result<Vec<_>>>()?;
        let (_, data) = image_bytes(home, bot, original).await?;
        let mut reader = image::ImageReader::new(std::io::Cursor::new(data))
            .with_guessed_format()
            .map_err(|_| Error::new(4202, "invalid image"))?;
        let mut limits = image::Limits::default();
        limits.max_alloc = Some(64 * 1024 * 1024);
        reader.limits(limits);
        let decoded = reader
            .decode()
            .map_err(|_| Error::new(4202, "image could not be decoded within memory limit"))?;
        if coords[0] >= coords[2]
            || coords[1] >= coords[3]
            || coords[2] > decoded.width()
            || coords[3] > decoded.height()
        {
            return Err(Error::new(4202, "crop region is outside the image"));
        }
        let cropped = decoded.crop_imm(
            coords[0],
            coords[1],
            coords[2] - coords[0],
            coords[3] - coords[1],
        );
        let mut output = std::io::Cursor::new(Vec::new());
        cropped
            .write_to(&mut output, image::ImageFormat::Png)
            .map_err(|_| failure("could not encode cropped image"))?;
        format!(
            "data:image/png;base64,{}",
            STANDARD.encode(output.into_inner())
        )
    } else {
        image_data(home, bot, original).await?
    };
    let question = common::required(args, "question")?;
    let aux = &cfg["auxiliary"]["vision"];
    let provider = text(aux, "provider", text(&cfg["model"], "provider", "openai"));
    let model = text(aux, "model", text(&cfg["model"], "default", "gpt-4o-mini"));
    if matches!(provider, "anthropic" | "claude") {
        let source = if let Some((meta, data)) =
            image.strip_prefix("data:").and_then(|v| v.split_once(','))
        {
            json!({"type":"base64","media_type":meta.trim_end_matches(";base64"),"data":data})
        } else {
            json!({"type":"url","url":image})
        };
        let base = endpoint(env, "ANTHROPIC_BASE_URL", "https://api.anthropic.com");
        let response = request(authorize(
            http()?
                .post(format!(
                    "{}/v1/messages",
                    text(aux, "base_url", &base).trim_end_matches('/')
                ))
                .header("anthropic-version", "2023-06-01")
                .json(&json!({
                    "model": model,
                    "max_tokens": 4096,
                    "messages": [
                        {
                            "role": "user",
                            "content": [
                                { "type": "image", "source": source },
                                { "type": "text", "text": question }
                            ]
                        }
                    ]
                })),
            env,
            "ANTHROPIC_API_KEY",
            Some("x-api-key"),
        ))
        .await?;
        let output = response["content"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|b| b["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n");
        if output.is_empty() {
            return Err(failure("vision provider returned no analysis"));
        }
        return Ok(json!({"analysis":output,"model":model}));
    }
    if matches!(provider, "google" | "gemini") {
        let (mime, data) = if let Some((meta, data)) =
            image.strip_prefix("data:").and_then(|v| v.split_once(','))
        {
            (meta.trim_end_matches(";base64").to_owned(), data.to_owned())
        } else {
            let response = common::safe_get(&image, common::allow_private_urls(home, bot)?).await?;
            let mime = response
                .headers()
                .get("content-type")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("image/png")
                .to_owned();
            (mime, STANDARD.encode(bytes(response).await?))
        };
        let base = endpoint(
            env,
            "GEMINI_BASE_URL",
            "https://generativelanguage.googleapis.com/v1beta",
        );
        let key = if credential(env, "GOOGLE_API_KEY").is_empty() {
            "GEMINI_API_KEY"
        } else {
            "GOOGLE_API_KEY"
        };
        let response = request(authorize(
            http()?
                .post(format!(
                    "{}/models/{model}:generateContent",
                    text(aux, "base_url", &base).trim_end_matches('/')
                ))
                .json(&json!({
                    "contents": [
                        {
                            "parts": [
                                { "text": question },
                                {
                                    "inline_data": { "mime_type": mime, "data": data }
                                }
                            ]
                        }
                    ]
                })),
            env,
            key,
            Some("x-goog-api-key"),
        ))
        .await?;
        let output = response["candidates"][0]["content"]["parts"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|b| b["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n");
        if output.is_empty() {
            return Err(failure("vision provider returned no analysis"));
        }
        return Ok(json!({"analysis":output,"model":model}));
    }
    let (base, key) = match provider {
        "openai" | "openai-api" => (
            endpoint(env, "OPENAI_BASE_URL", "https://api.openai.com/v1"),
            "OPENAI_API_KEY",
        ),
        "openrouter" => (
            endpoint(env, "OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1"),
            "OPENROUTER_API_KEY",
        ),
        "ollama" => (
            endpoint(env, "OLLAMA_BASE_URL", "http://localhost:11434/v1"),
            "OLLAMA_API_KEY",
        ),
        "custom" => (
            text(aux, "base_url", text(&cfg["model"], "base_url", "")).to_owned(),
            "CUSTOM_API_KEY",
        ),
        other => {
            return Err(failure(format!(
                "vision provider has not been ported: {other}"
            )));
        }
    };
    let base = text(aux, "base_url", &base);
    if base.is_empty() {
        return Err(failure("vision API base URL is not configured"));
    }
    let data = request(authorize(
        http()?
            .post(format!("{}/chat/completions", base.trim_end_matches('/')))
            .json(&json!({
                "model": model,
                "messages": [
                    {
                        "role": "user",
                        "content": [
                            { "type": "text", "text": question },
                            {
                                "type": "image_url",
                                "image_url": { "url": image }
                            }
                        ]
                    }
                ],
                "max_tokens": 4096
            })),
        env,
        key,
        None,
    ))
    .await?;
    let output = data["choices"][0]["message"]["content"]
        .as_str()
        .ok_or_else(|| failure("vision provider returned no analysis"))?;
    Ok(json!({"analysis":output,"model":model}))
}
async fn speech(
    home: &Path,
    bot: &str,
    cfg: &Value,
    env: &std::collections::BTreeMap<String, String>,
    args: &Value,
) -> Result<Value> {
    let input = common::required(args, "text")?;
    let provider = text(args, "provider", text(&cfg["tts"], "provider", "edge"));
    let options = &cfg["tts"][provider];
    let speed = args["speed"]
        .as_f64()
        .or_else(|| options["speed"].as_f64())
        .unwrap_or(1.);
    if !(0.25..=4.).contains(&speed) {
        return Err(Error::new(4202, "speed must be between 0.25 and 4"));
    }
    let output = if let Some(path) = args["output_path"].as_str() {
        media_path(home, bot, path)?
    } else {
        artifact(home, bot, "audio", "mp3")?
    };
    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent)?;
    }
    match provider {
        "openai" => {
            let base = text(options, "base_url", "https://api.openai.com/v1");
            let base = if base == "https://api.openai.com/v1" {
                endpoint(env, "OPENAI_BASE_URL", base)
            } else {
                base.to_owned()
            };
            let model = text(options, "model", "gpt-4o-mini-tts");
            let mut audio = vec![];
            // MP3 frames concatenate without dropping long-input chunks.
            for chunk in input.chars().collect::<Vec<_>>().chunks(4096) {
                let chunk = chunk.iter().collect::<String>();
                let mut body = json!({"model":model,"input":chunk,"voice":text(options,"voice","alloy"),"response_format":"mp3","speed":speed});
                if let Some(instructions) = args["instructions"].as_str() {
                    body["instructions"] = json!(instructions)
                }
                let data = bytes(
                    authorize(
                        http()?
                            .post(format!("{}/audio/speech", base.trim_end_matches('/')))
                            .json(&body),
                        env,
                        if credential(env, "VOICE_TOOLS_OPENAI_KEY").is_empty() {
                            "OPENAI_API_KEY"
                        } else {
                            "VOICE_TOOLS_OPENAI_KEY"
                        },
                        None,
                    )
                    .send()
                    .await
                    .map_err(http_error)?,
                )
                .await?;
                if audio.len() + data.len() > BODY_LIMIT {
                    return Err(failure("generated audio exceeds 24 MB"));
                }
                audio.extend(data);
            }
            common::atomic_write(&output, &audio)?;
        }
        "mistral" => {
            let base = text(options, "base_url", "https://api.mistral.ai");
            let mut audio = Vec::new();
            for chunk in input.chars().collect::<Vec<_>>().chunks(4000) {
                let data = request(authorize(
                    http()?
                        .post(format!("{}/v1/audio/speech", base.trim_end_matches('/')))
                        .json(&json!({
                            "model": text(options, "model", "voxtral-mini-tts-2603"),
                            "input": chunk.iter().collect::<String>(),
                            "voice_id": text(options, "voice_id", "c69964a6-ab8b-4f8a-9465-ec0925096ec8"),
                            "response_format": "mp3"
                        })),
                    env,
                    "MISTRAL_API_KEY",
                    None,
                ))
                .await?;
                let encoded = data["audio_data"]
                    .as_str()
                    .ok_or_else(|| failure("Mistral returned no audio"))?;
                audio.extend(
                    STANDARD
                        .decode(encoded)
                        .map_err(|_| failure("Mistral returned invalid audio"))?,
                );
                if audio.len() > BODY_LIMIT {
                    return Err(failure("generated audio exceeds 24 MB"));
                }
            }
            common::atomic_write(&output, &audio)?;
        }
        "elevenlabs" => {
            let base = text(options, "base_url", "https://api.elevenlabs.io/v1");
            let voice = text(options, "voice_id", "pNInz6obpgDQGcFmaJgB");
            let mut audio = vec![];
            for chunk in input.chars().collect::<Vec<_>>().chunks(4500) {
                let body = json!({"text":chunk.iter().collect::<String>(),"model_id":text(options,"model_id","eleven_multilingual_v2"),"voice_settings":{"speed":speed.clamp(0.7,1.2)}});
                let data = bytes(
                    authorize(
                        http()?
                            .post(format!(
                                "{}/text-to-speech/{voice}",
                                base.trim_end_matches('/')
                            ))
                            .json(&body),
                        env,
                        "ELEVENLABS_API_KEY",
                        Some("xi-api-key"),
                    )
                    .send()
                    .await
                    .map_err(http_error)?,
                )
                .await?;
                if audio.len() + data.len() > BODY_LIMIT {
                    return Err(failure("generated audio exceeds 24 MB"));
                }
                audio.extend(data);
            }
            common::atomic_write(&output, &audio)?;
        }
        "edge" => {
            let mut command = Command::new(edge_command(home, options));
            command
                .args([
                    "--text",
                    input,
                    "--voice",
                    text(options, "voice", "en-US-AriaNeural"),
                    "--rate",
                    &format!("{:+.0}%", (speed - 1.) * 100.),
                    "--write-media",
                ])
                .arg(&output)
                .envs(env);
            let result = run(command, b"", 180).await?;
            if result["success"] != true {
                return Err(failure(format!(
                    "Edge speech command failed: {}",
                    result["stderr"].as_str().unwrap_or("")
                )));
            }
        }
        name => {
            let custom = &cfg["tts"]["providers"][name];
            if custom["type"] != "command" {
                return Err(failure(format!(
                    "speech provider has not been ported: {name}"
                )));
            }
            let executable = custom["command"]
                .as_str()
                .ok_or_else(|| failure("custom speech provider needs a command executable"))?;
            let mut command = Command::new(executable);
            for arg in custom["args"].as_array().into_iter().flatten() {
                command.arg(
                    arg.as_str()
                        .ok_or_else(|| failure("speech command arguments must be strings"))?
                        .replace("{output_path}", &output.to_string_lossy())
                        .replace("{text}", input),
                );
            }
            command.envs(env).env("HEXBOT_TTS_OUTPUT", &output);
            let result = run(command, input.as_bytes(), 180).await?;
            if result["success"] != true {
                return Err(failure(format!(
                    "speech command failed: {}",
                    result["stderr"].as_str().unwrap_or("")
                )));
            }
        }
    }
    if !fs::metadata(&output).is_ok_and(|m| m.len() > 0) {
        return Err(failure("speech provider did not create audio"));
    }
    Ok(json!({"success":true,"file_path":output,"media":format!("MEDIA:{}",output.display())}))
}
async fn image_generate(
    home: &Path,
    bot: &str,
    cfg: &Value,
    env: &std::collections::BTreeMap<String, String>,
    args: &Value,
) -> Result<Value> {
    let prompt = common::required(args, "prompt")?;
    let options = &cfg["image_gen"];
    let provider = text(options, "provider", "fal");
    let ratio = text(args, "aspect_ratio", "square");
    let response = match provider {
        "openai" | "openai-api" => {
            let size = match ratio {
                "portrait" | "9:16" | "2:3" => "1024x1536",
                "landscape" | "16:9" | "3:2" => "1536x1024",
                _ => "1024x1024",
            };
            let base = endpoint(env, "OPENAI_BASE_URL", "https://api.openai.com/v1");
            let mut images = vec![];
            if let Some(url) = args["image_url"].as_str() {
                images.push(url)
            }
            for value in args["reference_image_urls"]
                .as_array()
                .into_iter()
                .flatten()
            {
                images.push(
                    value
                        .as_str()
                        .ok_or_else(|| Error::new(4202, "reference images must be strings"))?,
                )
            }
            if images.len() > 16 {
                return Err(Error::new(
                    4202,
                    "at most 16 reference images are supported",
                ));
            }
            if images.is_empty() {
                request(authorize(
                    http()?
                        .post(format!(
                            "{}/images/generations",
                            text(options, "base_url", &base).trim_end_matches('/')
                        ))
                        .json(&json!({
                            "model": text(options, "model", "gpt-image-1"),
                            "prompt": prompt,
                            "size": size,
                            "n": 1
                        })),
                    env,
                    "OPENAI_API_KEY",
                    None,
                ))
                .await?
            } else {
                let boundary = format!("hexbot-{}", common::id());
                let mut body = Vec::new();
                for (name, value) in [
                    ("model", text(options, "model", "gpt-image-1")),
                    ("prompt", prompt),
                    ("size", size),
                    ("n", "1"),
                ] {
                    body.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n").as_bytes());
                }
                for (index, input) in images.iter().enumerate() {
                    let (mime, bytes) = image_bytes(home, bot, input).await?;
                    let ext = match mime.as_str() {
                        "image/jpeg" => "jpg",
                        "image/webp" => "webp",
                        _ => "png",
                    };
                    body.extend_from_slice(
                        format!(
                            "--{boundary}\r\nContent-Disposition: form-data; name=\"image[]\"; filename=\"image-{index}.{ext}\"\r\nContent-Type: {mime}\r\n\r\n"
                        )
                        .as_bytes(),
                    );
                    body.extend(bytes);
                    body.extend_from_slice(b"\r\n");
                    if body.len() > BODY_LIMIT {
                        return Err(Error::new(4202, "combined reference images exceed 24 MB"));
                    }
                }
                body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
                request(authorize(
                    http()?
                        .post(format!(
                            "{}/images/edits",
                            text(options, "base_url", &base).trim_end_matches('/')
                        ))
                        .header(
                            "Content-Type",
                            format!("multipart/form-data; boundary={boundary}"),
                        )
                        .body(body),
                    env,
                    "OPENAI_API_KEY",
                    None,
                ))
                .await?
            }
        }
        "krea" => {
            let base = endpoint(env, "KREA_BASE_URL", "https://api.krea.ai");
            let model_env = credential(env, "KREA_IMAGE_MODEL");
            let model = if model_env.is_empty() {
                text(
                    &options["krea"],
                    "model",
                    text(options, "model", "krea-2-medium"),
                )
            } else {
                &model_env
            };
            let path = match model {
                "krea-2-medium" => "medium",
                "krea-2-large" => "large",
                "krea-2-medium-turbo" => "medium-turbo",
                _ => return Err(Error::new(4202, "unknown Krea image model")),
            };
            let mut body = json!({
                "prompt": prompt,
                "aspect_ratio": match ratio {
                    "square" => "1:1",
                    "portrait" => "9:16",
                    "landscape" => "16:9",
                    v => v,
                },
                "resolution": "1K",
                "creativity": text(&options["krea"], "creativity", "medium")
            });
            let mut references = Vec::new();
            if let Some(image) = args["image_url"].as_str() {
                references.push(image_data(home, bot, image).await?)
            }
            for reference in args["reference_image_urls"]
                .as_array()
                .into_iter()
                .flatten()
            {
                references.push(
                    image_data(
                        home,
                        bot,
                        reference.as_str().ok_or_else(|| {
                            Error::new(4202, "reference images must be URLs or paths")
                        })?,
                    )
                    .await?,
                )
            }
            if references.len() > 10 {
                return Err(Error::new(
                    4202,
                    "Krea supports at most ten reference images",
                ));
            }
            if !references.is_empty() {
                body["image_style_references"] = json!(
                    references
                        .into_iter()
                        .map(|url| json!({"url":url,"strength":0.6}))
                        .collect::<Vec<_>>()
                );
            }
            let submit = request(authorize(
                http()?
                    .post(format!(
                        "{}/generate/image/krea/krea-2/{path}",
                        base.trim_end_matches('/')
                    ))
                    .json(&body),
                env,
                "KREA_API_KEY",
                None,
            ))
            .await?;
            let job = submit["job_id"]
                .as_str()
                .ok_or_else(|| failure("Krea returned no job id"))?;
            tokio::time::timeout(Duration::from_secs(180), async {
                loop {
                    let result = request(authorize(
                        http()?.get(format!("{}/jobs/{job}", base.trim_end_matches('/'))),
                        env,
                        "KREA_API_KEY",
                        None,
                    ))
                    .await?;
                    if matches!(text(&result, "status", ""), "failed" | "cancelled") {
                        return Err(failure("Krea image job failed"));
                    }
                    if result["result"]["urls"].is_array() {
                        return Ok(json!({"images":result["result"]["urls"].as_array().unwrap().iter().map(|url|json!({"url":url})).collect::<Vec<_>>()}));
                    }
                    if let Some(url) = result["result"]["url"].as_str() {
                        return Ok(json!({ "images": [{ "url": url }] }));
                    }
                    tokio::time::sleep(Duration::from_secs(2)).await;
                }
            })
            .await
            .map_err(|_| failure("Krea image job timed out"))??
        }
        "fal" => fal_image(home, bot, options, env, args).await?,
        other => {
            return Err(failure(format!(
                "image provider has not been ported: {other}"
            )));
        }
    };
    let images = response["data"]
        .as_array()
        .or_else(|| response["images"].as_array())
        .ok_or_else(|| failure("image provider returned no images"))?;
    let mut outputs = vec![];
    for image in images {
        let data = if let Some(encoded) = image["b64_json"].as_str() {
            STANDARD
                .decode(encoded)
                .map_err(|_| failure("invalid encoded image"))?
        } else if let Some(url) = image["url"].as_str() {
            bytes(common::safe_get(url, common::allow_private_urls(home, bot)?).await?).await?
        } else {
            return Err(failure(
                "image response contains neither URL nor encoded image",
            ));
        };
        let ext = if data.starts_with(b"\x89PNG") {
            "png"
        } else if data.starts_with(b"\xff\xd8") {
            "jpg"
        } else if data.starts_with(b"RIFF") {
            "webp"
        } else {
            return Err(failure(
                "image provider returned an unsupported image format",
            ));
        };
        let output = artifact(home, bot, "images", ext)?;
        common::atomic_write(&output, &data)?;
        outputs.push(json!({"path":output,"media":format!("MEDIA:{}",output.display())}));
    }
    Ok(json!({"success":true,"images":outputs}))
}
async fn browser_cdp(
    cfg: &Value,
    env: &std::collections::BTreeMap<String, String>,
    args: &Value,
) -> Result<Value> {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;
    let method = common::required(args, "method")?;
    // Direct CDP has no enforcing network interceptor. Allow only inspection;
    // evaluation, input dispatch and navigation can all trigger arbitrary URLs.
    if !matches!(
        method,
        "Target.getTargets"
            | "Browser.getVersion"
            | "Page.captureScreenshot"
            | "Page.getLayoutMetrics"
            | "DOM.getDocument"
            | "DOMSnapshot.captureSnapshot"
            | "Accessibility.getFullAXTree"
    ) {
        return Err(Error::new(
            4302,
            "This browser operation requires a browser managed by Hexbot",
        ));
    }
    if args.get("frame_id").is_some() {
        return Err(Error::new(4202, "frame_id is unavailable; use target_id"));
    }
    let configured = credential(env, "BROWSER_CDP_URL");
    let url = text(&cfg["browser"], "cdp_url", &configured);
    if url.is_empty() {
        return Err(failure("browser.cdp_url is not configured"));
    }
    let seconds = args["timeout"].as_f64().unwrap_or(30.).clamp(1., 120.);
    tokio::time::timeout(Duration::from_secs_f64(seconds), async {
        let endpoint = if url.starts_with("http://") || url.starts_with("https://") {
            let info =
                request(http()?.get(format!("{}/json/version", url.trim_end_matches('/')))).await?;
            info["webSocketDebuggerUrl"]
                .as_str()
                .ok_or_else(|| failure("browser returned no debugger WebSocket URL"))?
                .to_owned()
        } else {
            url.to_owned()
        };
        if !endpoint.starts_with("ws://") && !endpoint.starts_with("wss://") {
            return Err(Error::new(
                4202,
                "browser endpoint must use HTTP or WebSocket",
            ));
        }
        let (mut socket, _) = tokio_tungstenite::connect_async(&endpoint)
            .await
            .map_err(|_| failure("browser WebSocket connection failed"))?;
        let mut id = 1u64;
        let mut session = None;
        if let Some(target) = args["target_id"].as_str() {
            socket
                .send(Message::Text(json!({
                    "id": id,
                    "method": "Target.attachToTarget",
                    "params": { "targetId": target, "flatten": true }
                }).to_string().into()))
                .await
                .map_err(|_| failure("browser connection closed"))?;
            loop {
                let message = socket
                    .next()
                    .await
                    .ok_or_else(|| failure("browser connection closed"))?
                    .map_err(|_| failure("invalid browser response"))?;
                if let Message::Text(raw) = message {
                    let v: Value = serde_json::from_str(&raw)
                        .map_err(|_| failure("invalid browser response"))?;
                    if v["id"] == id {
                        if let Some(error) = v.get("error") {
                            return Err(failure(format!(
                                "browser attach failed: {}",
                                text(error, "message", "unknown error")
                            )));
                        }
                        session = Some(
                            v["result"]["sessionId"]
                                .as_str()
                                .ok_or_else(|| failure("browser returned no target session"))?
                                .to_owned(),
                        );
                        break;
                    }
                }
            }
            id += 1;
        }
        let mut command = json!({"id":id,"method":method,"params":args.get("params").cloned().unwrap_or(json!({}))});
        if let Some(session) = session {
            command["sessionId"] = json!(session);
        }
        socket
            .send(Message::Text(command.to_string().into()))
            .await
            .map_err(|_| failure("browser connection closed"))?;
        while let Some(message) = socket.next().await {
            match message.map_err(|_| failure("invalid browser response"))? {
                Message::Text(raw) => {
                    if raw.len() > BODY_LIMIT {
                        return Err(failure("browser response exceeds 24 MB"));
                    }
                    let v: Value = serde_json::from_str(&raw)
                        .map_err(|_| failure("invalid browser response"))?;
                    if v["id"] != id {
                        continue;
                    }
                    if let Some(error) = v.get("error") {
                        return Err(failure(format!(
                            "browser command failed: {}",
                            text(error, "message", "unknown error")
                        )));
                    }
                    return Ok(v["result"].clone());
                }
                Message::Ping(data) => socket
                    .send(Message::Pong(data))
                    .await
                    .map_err(|_| failure("browser connection closed"))?,
                Message::Close(_) => break,
                _ => {}
            }
        }
        Err(failure("browser connection closed before replying"))
    })
    .await
    .map_err(|_| failure("browser command timed out"))?
}
#[derive(Default)]
struct Computer {
    started: bool,
    target: Option<Value>,
    tokens: HashMap<i64, String>,
}
type ComputerMap = HashMap<(PathBuf, String, String), Arc<Mutex<Computer>>>;
fn computers() -> &'static Mutex<ComputerMap> {
    static COMPUTERS: OnceLock<Mutex<ComputerMap>> = OnceLock::new();
    COMPUTERS.get_or_init(Default::default)
}
fn computer_config(cfg: &Value, env: &std::collections::BTreeMap<String, String>) -> Value {
    let mut command = credential(env, "HEXBOT_CUA_DRIVER_CMD");
    if command.is_empty() {
        command = credential(env, "HERMES_CUA_DRIVER_CMD");
    }
    if command.is_empty() {
        command = on_path("cua-driver")
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();
    }
    json!({
        "command": text(
            &cfg["computer_use"],
            "command",
            if command.is_empty() {
                "cua-driver"
            } else {
                &command
            },
        ),
        "args": cfg["computer_use"]
            .get("args")
            .cloned()
            .unwrap_or(json!(["mcp"])),
        "isolated_env": true,
        "env": {
            "CUA_DRIVER_RS_TELEMETRY_ENABLED": if cfg["computer_use"]["telemetry"] == true {
                "1"
            } else {
                "0"
            }
        }
    })
}
fn mcp_data(result: &Value) -> Value {
    if let Some(value) = result.get("structuredContent") {
        return value.clone();
    }
    for value in result["content"].as_array().into_iter().flatten() {
        if let Some(text) = value["text"].as_str()
            && let Ok(json) = serde_json::from_str::<Value>(text)
        {
            return json;
        }
    }
    result.clone()
}
async fn computer_request(
    home: &Path,
    bot: &str,
    server: &str,
    config: &Value,
    tool: &str,
    args: Value,
) -> Result<Value> {
    let result = connectors::mcp_call_config(home, bot, server, config, tool, args).await?;
    if result["isError"] == true {
        return Err(failure(format!(
            "computer action {tool} failed: {}",
            result["content"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|v| v["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n")
        )));
    }
    Ok(result)
}
async fn computer_use(
    home: &Path,
    bot: &str,
    stored: &str,
    cfg: &Value,
    env: &std::collections::BTreeMap<String, String>,
    args: &Value,
) -> Result<Value> {
    let action = common::required(args, "action")?;
    if action == "wait" {
        let seconds = args["seconds"].as_f64().unwrap_or(1.);
        if !(0. ..=30.).contains(&seconds) {
            return Err(Error::new(4202, "wait seconds must be between 0 and 30"));
        }
        tokio::time::sleep(Duration::from_secs_f64(seconds)).await;
        return Ok(json!({"ok":true,"action":"wait"}));
    }
    let config = computer_config(cfg, env);
    let server = format!("hexbot-cua-{stored}");
    let session = format!("hexbot-{stored}");
    let state = computers()
        .lock()
        .await
        .entry((home.to_owned(), bot.to_owned(), stored.to_owned()))
        .or_insert_with(|| Arc::new(Mutex::new(Computer::default())))
        .clone();
    let mut state = state.lock().await;
    if !state.started {
        computer_request(
            home,
            bot,
            &server,
            &config,
            "start_session",
            json!({"session":session}),
        )
        .await?;
        state.started = true;
    }
    if matches!(action, "list_apps" | "list_windows") {
        return computer_request(
            home,
            bot,
            &server,
            &config,
            action,
            json!({"session":session}),
        )
        .await;
    }
    if action == "capture" || action == "focus_app" {
        state.target = None;
        state.tokens.clear();
        let app = text(args, "app", "");
        if matches!(app, "screen" | "fullscreen" | "full screen" | "all") {
            let result = computer_request(
                home,
                bot,
                &server,
                &config,
                "get_desktop_state",
                json!({"session":session}),
            )
            .await?;
            return save_capture(home, bot, result);
        }
        let target = if args["pid"].as_i64().is_some_and(|v| v > 0)
            && args["window_id"].as_i64().is_some_and(|v| v > 0)
        {
            json!({"pid":args["pid"],"window_id":args["window_id"]})
        } else {
            let windows = computer_request(
                home,
                bot,
                &server,
                &config,
                "list_windows",
                json!({"session":session,"on_screen_only":true}),
            )
            .await?;
            let data = mcp_data(&windows);
            let windows = data["windows"]
                .as_array()
                .ok_or_else(|| failure("computer driver returned no window list"))?;
            let app = app.to_lowercase();
            let mut matches = windows
                .iter()
                .filter(|w| {
                    w["is_on_screen"] != false
                        && w["pid"].as_i64().is_some_and(|v| v > 0)
                        && w["window_id"].as_i64().is_some_and(|v| v > 0)
                })
                .filter(|w| {
                    app.is_empty()
                        || text(w, "app_name", "").to_lowercase().contains(&app)
                        || text(w, "title", "").to_lowercase().contains(&app)
                })
                .collect::<Vec<_>>();
            matches.sort_by(|a, b| {
                b["z_index"]
                    .as_i64()
                    .unwrap_or(0)
                    .cmp(&a["z_index"].as_i64().unwrap_or(0))
            });
            let selected = matches
                .iter()
                .find(|w| text(w, "app_name", "").eq_ignore_ascii_case(&app))
                .copied()
                .or_else(|| matches.first().copied())
                .ok_or_else(|| failure("no on-screen window matched the requested app"))?;
            json!({"pid":selected["pid"],"window_id":selected["window_id"]})
        };
        let mut params = target.clone();
        params["session"] = json!(session);
        if action == "focus_app" && args["bring_to_front"] == true {
            computer_request(
                home,
                bot,
                &server,
                &config,
                "bring_to_front",
                params.clone(),
            )
            .await?;
        }
        let capture =
            computer_request(home, bot, &server, &config, "get_window_state", params).await?;
        for element in mcp_data(&capture)["elements"]
            .as_array()
            .into_iter()
            .flatten()
        {
            if let (Some(index), Some(token)) = (
                element["element_index"].as_i64(),
                element["element_token"].as_str(),
            ) {
                state.tokens.insert(index, token.to_owned());
            }
        }
        state.target = Some(target);
        return save_capture(home, bot, capture);
    }
    let mut params = state
        .target
        .clone()
        .ok_or_else(|| failure("no active computer window; capture first"))?;
    params["session"] = json!(session);
    for key in ["delivery_mode", "bring_to_front"] {
        if let Some(value) = args.get(key) {
            params[key] = value.clone()
        }
    }
    if let Some(index) = args["element"].as_i64() {
        params["element_index"] = json!(index);
        if let Some(token) = state.tokens.get(&index) {
            params["element_token"] = json!(token)
        }
    }
    if let Some(xy) = args["coordinate"].as_array().filter(|v| v.len() == 2) {
        params["x"] = xy[0].clone();
        params["y"] = xy[1].clone();
    }
    if let Some(modifiers) = args.get("modifiers") {
        params["modifier"] = modifiers.clone()
    }
    let tool = match action {
        "click" | "double_click" | "right_click" | "middle_click" => {
            if params.get("element_index").is_none() && params.get("x").is_none() {
                return Err(Error::new(4200, "click requires element or coordinate"));
            }
            params["button"] = json!(match action {
                "right_click" => "right",
                "middle_click" => "middle",
                _ => text(args, "button", "left"),
            });
            if action == "double_click" {
                "double_click"
            } else {
                "click"
            }
        }
        "type" => {
            params["text"] = json!(common::required(args, "text")?);
            "type_text"
        }
        "key" => {
            let keys = common::required(args, "keys")?
                .split(['+', '-'])
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .collect::<Vec<_>>();
            if keys.len() > 1 {
                params["keys"] = json!(keys);
                "hotkey"
            } else {
                params["key"] = json!(
                    keys.first()
                        .ok_or_else(|| Error::new(4202, "empty key combination"))?
                );
                "press_key"
            }
        }
        "scroll" => {
            params["direction"] = json!(common::required(args, "direction")?);
            params["amount"] = json!(args["amount"].as_u64().unwrap_or(3).clamp(1, 50));
            "scroll"
        }
        "set_value" => {
            if params.get("element_index").is_none() {
                return Err(Error::new(4200, "set_value requires element"));
            }
            params["value"] = args
                .get("value")
                .cloned()
                .ok_or_else(|| Error::new(4200, "missing parameter: value"))?;
            "set_value"
        }
        "drag" => {
            for direction in ["from", "to"] {
                if let Some(index) = args.get(format!("{direction}_element")) {
                    params[format!("{direction}_element")] = index.clone()
                } else if let Some(xy) = args[format!("{direction}_coordinate")]
                    .as_array()
                    .filter(|v| v.len() == 2)
                {
                    params[format!("{direction}_x")] = xy[0].clone();
                    params[format!("{direction}_y")] = xy[1].clone()
                } else {
                    return Err(Error::new(
                        4200,
                        format!("drag requires {direction}_element or {direction}_coordinate"),
                    ));
                }
            }
            "drag"
        }
        _ => {
            return Err(Error::new(
                4202,
                format!("unknown computer action: {action}"),
            ));
        }
    };
    let result = computer_request(home, bot, &server, &config, tool, params).await?;
    if args["capture_after"] == true {
        let mut params = state.target.clone().expect("selected target");
        params["session"] = json!(session);
        let capture =
            computer_request(home, bot, &server, &config, "get_window_state", params).await?;
        state.tokens.clear();
        for element in mcp_data(&capture)["elements"]
            .as_array()
            .into_iter()
            .flatten()
        {
            if let (Some(index), Some(token)) = (
                element["element_index"].as_i64(),
                element["element_token"].as_str(),
            ) {
                state.tokens.insert(index, token.to_owned());
            }
        }
        return Ok(json!({"action_result":result,"capture":save_capture(home,bot,capture)?}));
    }
    Ok(result)
}
fn save_capture(home: &Path, bot: &str, mut result: Value) -> Result<Value> {
    let image = result["content"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|v| v["type"] == "image")
        .map(|v| {
            (
                text(v, "mimeType", "image/png").to_owned(),
                text(v, "data", "").to_owned(),
            )
        })
        .or_else(|| {
            mcp_data(&result)["screenshot_png_b64"]
                .as_str()
                .map(|v| ("image/png".into(), v.to_owned()))
        });
    if let Some((mime, data)) = image {
        if data.len() > BODY_LIMIT * 2 {
            return Err(failure("computer screenshot exceeds limit"));
        }
        let raw = STANDARD
            .decode(&data)
            .map_err(|_| failure("computer driver returned invalid image"))?;
        let output = artifact(
            home,
            bot,
            "screenshots",
            if mime == "image/jpeg" { "jpg" } else { "png" },
        )?;
        common::atomic_write(&output, &raw)?;
        result["screenshot_path"] = json!(output);
    }
    Ok(result)
}
async fn image_bytes(home: &Path, bot: &str, value: &str) -> Result<(String, Vec<u8>)> {
    let value = image_data(home, bot, value).await?;
    if let Some((meta, encoded)) = value.strip_prefix("data:").and_then(|v| v.split_once(',')) {
        if encoded.len() > BODY_LIMIT * 2 {
            return Err(Error::new(4202, "image exceeds size limit"));
        }
        let mime = meta.trim_end_matches(";base64");
        if !["image/png", "image/jpeg", "image/webp", "image/gif"].contains(&mime) {
            return Err(Error::new(4202, "unsupported image media type"));
        }
        return Ok((
            mime.to_owned(),
            STANDARD
                .decode(encoded)
                .map_err(|_| Error::new(4202, "invalid base64 image"))?,
        ));
    }
    Err(Error::new(4202, "invalid image data"))
}
struct Browser {
    proxy: common::BrowserProxy,
    name: String,
    command: Vec<String>,
    directory: PathBuf,
    cdp: String,
    provider: String,
    remote_id: String,
    base: String,
    key: String,
    project: String,
    headed: bool,
    cli_started: bool,
}
type BrowserMap = HashMap<(PathBuf, String, String), Arc<Mutex<Option<Browser>>>>;
fn browsers() -> &'static Mutex<BrowserMap> {
    static BROWSERS: OnceLock<Mutex<BrowserMap>> = OnceLock::new();
    BROWSERS.get_or_init(Default::default)
}
fn on_path(command: &str) -> Option<PathBuf> {
    let cwd = std::env::current_dir().ok()?;
    if let Some(path) = common::command_path(command, &cwd) {
        return Some(path);
    }
    let mut directories = vec![];
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        directories.push(home.join(".local/bin"));
        directories.push(home.join(".cargo/bin"));
    }
    directories.extend([
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/usr/bin"),
    ]);
    directories
        .into_iter()
        .map(|path| path.join(command))
        .find(|p| common::executable_file(p))
}
fn browser_use_command(home: &Path, cfg: &Value) -> Option<Vec<String>> {
    if let Some(command) = cfg["browser"]["command"].as_str().filter(|s| !s.is_empty()) {
        return on_path(command).map(|p| vec![p.to_string_lossy().into_owned()]);
    }
    for managed in [true, false] {
        for name in ["browser-use", "uvx"] {
            let path = if managed {
                let path = home.join("bin").join(name);
                common::executable_file(&path).then_some(path)
            } else {
                on_path(name)
            };
            if let Some(path) = path {
                let mut command = vec![path.to_string_lossy().into_owned()];
                if name == "uvx" {
                    command.push("browser-use".into());
                }
                return Some(command);
            }
        }
    }
    None
}
fn browser_command(cfg: &Value) -> Vec<String> {
    if let Some(command) = cfg["browser"]["command"].as_str() {
        return vec![command.to_owned()];
    };
    if let Some(path) = on_path("agent-browser") {
        vec![path.to_string_lossy().into_owned()]
    } else {
        vec![
            "npx".into(),
            "--ignore-scripts".into(),
            "--prefer-offline".into(),
            "-y".into(),
            "agent-browser@0.26.0".into(),
        ]
    }
}
async fn launch_browser(
    home: &Path,
    bot: &str,
    stored: &str,
    cfg: &Value,
    env: &std::collections::BTreeMap<String, String>,
) -> Result<Browser> {
    if text(&cfg["browser"], "backend", "") == "off" {
        return Err(Error::new(4302, "browser is disabled"));
    }
    let directory = crate::catalog::profile(home, bot)?
        .join("browser")
        .join(stored);
    fs::create_dir_all(&directory)?;
    let mut browser = Browser {
        proxy: common::BrowserProxy::start(common::allow_private_urls(home, bot)?).await?,
        name: format!("hexbot-{}", common::id()),
        command: browser_command(cfg),
        directory,
        cdp: text(
            &cfg["browser"],
            "cdp_url",
            &credential(env, "BROWSER_CDP_URL"),
        )
        .to_owned(),
        provider: String::new(),
        remote_id: String::new(),
        base: String::new(),
        key: String::new(),
        project: String::new(),
        headed: cfg["browser"]["headed"] == true,
        cli_started: false,
    };
    if !browser.cdp.is_empty() {
        return Ok(browser);
    }
    let provider = text(&cfg["browser"], "cloud_provider", "");
    match provider {
        "browserbase" => {
            browser.provider = provider.into();
            browser.base = endpoint(env, "BROWSERBASE_BASE_URL", "https://api.browserbase.com");
            browser.key = credential(env, "BROWSERBASE_API_KEY");
            browser.project = credential(env, "BROWSERBASE_PROJECT_ID");
            if browser.key.is_empty() || browser.project.is_empty() {
                return Err(failure("Browserbase API key and project id are required"));
            }
            let data = request(
                http()?
                    .post(format!(
                        "{}/v1/sessions",
                        browser.base.trim_end_matches('/')
                    ))
                    .header("X-BB-API-Key", &browser.key)
                    .json(&json!({"projectId":browser.project})),
            )
            .await?;
            browser.remote_id = common::required(&data, "id")?.to_owned();
            browser.cdp = common::required(&data, "connectUrl")?.to_owned();
        }
        "browser-use" => {
            browser.provider = provider.into();
            browser.base = endpoint(
                env,
                "BROWSER_USE_BASE_URL",
                "https://api.browser-use.com/api/v3",
            );
            browser.key = credential(env, "BROWSER_USE_API_KEY");
            if browser.key.is_empty() {
                return Err(failure("Browser Use API key is required"));
            }
            let data = request(
                http()?
                    .post(format!("{}/browsers", browser.base.trim_end_matches('/')))
                    .header("X-Browser-Use-API-Key", &browser.key)
                    .json(&json!({})),
            )
            .await?;
            browser.remote_id = common::required(&data, "id")?.to_owned();
            browser.cdp = data["cdpUrl"]
                .as_str()
                .or_else(|| data["connectUrl"].as_str())
                .filter(|v| !v.is_empty())
                .ok_or_else(|| failure("Browser Use returned no CDP URL"))?
                .to_owned();
        }
        "" | "local" => {}
        other => return Err(failure(format!("unknown cloud browser provider: {other}"))),
    }
    Ok(browser)
}
fn agent_command(browser: &Browser, verb: &str, args: &[String]) -> Command {
    let mut command = Command::new(&browser.command[0]);
    command.args(&browser.command[1..]);
    desktop_environment(&mut command);
    command
        .env("AGENT_BROWSER_SOCKET_DIR", &browser.directory)
        .env("AGENT_BROWSER_IDLE_TIMEOUT_MS", "1800000")
        .arg("--session")
        .arg(&browser.name)
        .arg("--json");
    if !browser.cdp.is_empty() {
        command.arg("--cdp").arg(&browser.cdp);
    }
    if browser.cdp.is_empty() {
        command
            .arg("--proxy")
            .arg(format!("http://{}", browser.proxy.address))
            // Chromium's subtractive rule disables implicit localhost bypass.
            // agent-browser forwards proxy-bypass to --proxy-bypass-list.
            .args(["--proxy-bypass", "<-loopback>", "--args", "--disable-quic"]);
    }
    if browser.headed {
        command.arg("--headed");
    }
    command.arg(verb).args(args);
    command
}
async fn agent_browser(browser: &Browser, verb: &str, args: &[String]) -> Result<Value> {
    let result = run(agent_command(browser, verb, args), b"", 120).await?;
    let output = result["output"].as_str().unwrap_or("");
    let parsed: Value = serde_json::from_str(output)
        .unwrap_or_else(|_| json!({"success":false,"error":result["stderr"]}));
    if parsed["success"] == false || result["success"] != true {
        return Err(failure(format!(
            "browser command failed: {}",
            text(&parsed, "error", "invalid browser response")
        )));
    }
    Ok(parsed)
}
async fn browser_tool(
    home: &Path,
    bot: &str,
    stored: &str,
    cfg: &Value,
    env: &std::collections::BTreeMap<String, String>,
    name: &str,
    args: &Value,
) -> Result<Value> {
    if name == "browser_navigate" {
        let url = url::Url::parse(common::required(args, "url")?)
            .map_err(|_| Error::new(4202, "invalid browser URL"))?;
        common::url_addresses(&url, common::allow_private_urls(home, bot)?).await?;
    }
    if (!text(
        &cfg["browser"],
        "cdp_url",
        &credential(env, "BROWSER_CDP_URL"),
    )
    .is_empty()
        || !matches!(text(&cfg["browser"], "cloud_provider", ""), "" | "local"))
        && !matches!(
            name,
            "browser_snapshot" | "browser_vision" | "browser_get_images"
        )
    {
        return Err(Error::new(
            4302,
            "This browser operation requires a browser managed by Hexbot",
        ));
    }
    let state = browsers()
        .lock()
        .await
        .entry((home.to_owned(), bot.to_owned(), stored.to_owned()))
        .or_insert_with(|| Arc::new(Mutex::new(None)))
        .clone();
    let mut state = state.lock().await;
    if state.is_none() {
        *state = Some(launch_browser(home, bot, stored, cfg, env).await?)
    }
    let browser = state.as_mut().expect("browser initialized");
    browser.cli_started = true;
    let reference = || {
        let value = common::required(args, "ref")?;
        Ok::<_, Error>(if value.starts_with('@') {
            value.to_owned()
        } else {
            format!("@{value}")
        })
    };
    let (verb, arguments) = match name {
        "browser_navigate" => {
            let url = common::required(args, "url")?;
            let parsed =
                url::Url::parse(url).map_err(|_| Error::new(4202, "invalid browser URL"))?;
            if !matches!(parsed.scheme(), "http" | "https" | "about") {
                return Err(Error::new(
                    4202,
                    "browser URL must use http, https or about",
                ));
            }
            ("open", vec![url.to_owned()])
        }
        "browser_snapshot" => (
            "snapshot",
            if args["full"] == true {
                vec![]
            } else {
                vec!["-c".into()]
            },
        ),
        "browser_click" => ("click", vec![reference()?]),
        "browser_type" => (
            "fill",
            vec![
                reference()?,
                args["text"]
                    .as_str()
                    .ok_or_else(|| Error::new(4200, "missing parameter: text"))?
                    .to_owned(),
            ],
        ),
        "browser_scroll" => (
            "scroll",
            vec![
                common::required(args, "direction")?.to_owned(),
                args["pixels"]
                    .as_u64()
                    .unwrap_or(600)
                    .min(10000)
                    .to_string(),
            ],
        ),
        "browser_back" => ("back", vec![]),
        "browser_press" => ("press", vec![common::required(args, "key")?.to_owned()]),
        "browser_get_images" => (
            "eval",
            vec![
                "JSON.stringify(Array.from(document.images).map(i=>({src:i.currentSrc||i.src,alt:i.alt,width:i.naturalWidth,height:i.naturalHeight})))"
                    .into(),
            ],
        ),
        "browser_console" => {
            if let Some(expression) = args["expression"].as_str() {
                ("eval", vec![expression.into()])
            } else {
                (
                    "console",
                    if args["clear"] == true {
                        vec!["--clear".into()]
                    } else {
                        vec![]
                    },
                )
            }
        }
        "browser_vision" => {
            let path = artifact(home, bot, "screenshots", "png")?;
            let mut args = vec![path.to_string_lossy().into_owned()];
            if args.len() == 1 && cfg["browser"]["annotate"] == true {
                args.push("--annotate".into());
            }
            agent_browser(browser, "screenshot", &args).await?;
            let data = STANDARD.encode(common::read_regular(&path, BODY_LIMIT)?);
            return Ok(json!({
                "screenshot_path": path,
                "content": [
                    { "type": "text", "text": format!("Browser screenshot saved to {}", path.display()) },
                    { "type": "image", "mimeType": "image/png", "data": data }
                ]
            }));
        }
        _ => return Err(Error::new(4204, "unknown browser tool")),
    };
    let result = agent_browser(browser, verb, &arguments).await;
    let result = match result {
        Err(error)
            if browser.cdp.is_empty()
                && name == "browser_navigate"
                && (error.message.to_lowercase().contains("install")
                    || error
                        .message
                        .to_lowercase()
                        .contains("executable doesn't exist")) =>
        {
            let mut command = Command::new(&browser.command[0]);
            command.args(&browser.command[1..]).arg("install");
            desktop_environment(&mut command);
            let install = run(command, b"", 300).await?;
            if install["success"] != true {
                return Err(failure(format!(
                    "browser installation failed: {}",
                    text(&install, "stderr", "unknown error")
                )));
            }
            agent_browser(browser, verb, &arguments).await?
        }
        other => other?,
    };
    if name == "browser_navigate" {
        return agent_browser(browser, "snapshot", &["-c".into()]).await;
    }
    Ok(result)
}
async fn close_browsers(home: &Path, stored: &str) {
    let removed = {
        let mut map = browsers().lock().await;
        let keys = map
            .keys()
            .filter(|(h, _, s)| h == home && s == stored)
            .cloned()
            .collect::<Vec<_>>();
        keys.into_iter()
            .filter_map(|key| map.remove(&key))
            .collect::<Vec<_>>()
    };
    for state in removed {
        if let Some(browser) = state.lock().await.take() {
            if browser.cli_started {
                let _ = run(agent_command(&browser, "close", &[]), b"", 10).await;
            }
            if let Ok(client) = http() {
                let request = match browser.provider.as_str() {
                    "browserbase" => Some(
                        client
                            .post(format!(
                                "{}/v1/sessions/{}",
                                browser.base.trim_end_matches('/'),
                                browser.remote_id
                            ))
                            .header("X-BB-API-Key", browser.key)
                            .json(&json!({"projectId":browser.project,"status":"REQUEST_RELEASE"})),
                    ),
                    "browser-use" => Some(
                        client
                            .patch(format!(
                                "{}/browsers/{}",
                                browser.base.trim_end_matches('/'),
                                browser.remote_id
                            ))
                            .header("X-Browser-Use-API-Key", browser.key)
                            .json(&json!({"action":"stop"})),
                    ),
                    _ => None,
                };
                if let Some(request) = request {
                    let _ = request.timeout(Duration::from_secs(10)).send().await;
                }
            }
        }
    }
}

// Behavior metadata preserved from the historical image-generation tool.
const FAL_MODELS: &str = include_str!("fal_image_models.json");
async fn fal_image(
    home: &Path,
    bot: &str,
    options: &Value,
    env: &std::collections::BTreeMap<String, String>,
    args: &Value,
) -> Result<Value> {
    static MODELS: OnceLock<Value> = OnceLock::new();
    let models =
        MODELS.get_or_init(|| serde_json::from_str(FAL_MODELS).expect("embedded FAL catalog"));
    let fallback = credential(env, "FAL_IMAGE_MODEL");
    let model = text(options, "model", &fallback);
    let model = if models.get(model).is_some() {
        model
    } else {
        "fal-ai/flux-2/klein/9b"
    };
    let meta = &models[model];
    let mut images = vec![];
    if let Some(input) = args["image_url"].as_str() {
        images.push(image_data(home, bot, input).await?);
    }
    for input in args["reference_image_urls"]
        .as_array()
        .into_iter()
        .flatten()
    {
        images.push(
            image_data(
                home,
                bot,
                input
                    .as_str()
                    .ok_or_else(|| Error::new(4202, "reference image must be a URL or path"))?,
            )
            .await?,
        );
    }
    let editing = !images.is_empty();
    let target = if editing {
        meta["edit_endpoint"]
            .as_str()
            .ok_or_else(|| Error::new(4202, "selected FAL model does not support editing"))?
    } else {
        model
    };
    if images.len() > meta["max_reference_images"].as_u64().unwrap_or(1) as usize {
        return Err(Error::new(
            4202,
            "too many reference images for selected FAL model",
        ));
    }
    let mut body = meta["defaults"].clone();
    if !body.is_object() {
        body = json!({})
    }
    body["prompt"] = json!(common::required(args, "prompt")?);
    let aspect = match text(args, "aspect_ratio", "square") {
        "16:9" | "landscape" => "landscape",
        "9:16" | "portrait" => "portrait",
        _ => "square",
    };
    let size_key = if meta["size_style"] == "aspect_ratio" {
        "aspect_ratio"
    } else {
        "image_size"
    };
    body[size_key] = meta["sizes"][aspect].clone();
    let supported = meta[if editing { "edit_supports" } else { "supports" }]
        .as_array()
        .expect("FAL supported fields");
    for name in [
        "seed",
        "num_images",
        "num_inference_steps",
        "guidance_scale",
        "output_format",
    ] {
        if let Some(value) = args.get(name) {
            body[name] = value.clone();
        }
    }
    body.as_object_mut()
        .expect("payload")
        .retain(|key, _| key == "prompt" || supported.iter().any(|value| value == key));
    if editing {
        body["image_urls"] = json!(images)
    }
    let response = request(
        http()?
            .post(format!(
                "{}/{target}",
                endpoint(env, "FAL_BASE_URL", "https://fal.run").trim_end_matches('/')
            ))
            .header(
                "Authorization",
                format!("Key {}", credential(env, "FAL_KEY")),
            )
            .json(&body),
    )
    .await?;
    Ok(response)
}

#[cfg(test)]
mod safety_tests {
    use super::*;
    #[tokio::test]
    async fn managed_browser_sends_loopback_through_the_proxy() {
        let home = fixture();
        let cfg = json!({"browser":{"command":"/bin/echo"}});
        let browser = launch_browser(home.path(), "owl", "test", &cfg, &Default::default())
            .await
            .unwrap();
        let command = agent_command(&browser, "open", &["https://example.com".into()]);
        let args = command
            .as_std()
            .get_args()
            .map(|s| s.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert!(
            args.windows(2)
                .any(|w| w == ["--proxy-bypass", "<-loopback>"])
        );
        assert!(
            args.windows(2)
                .any(|w| w[0] == "--proxy" && w[1] == format!("http://{}", browser.proxy.address))
        );
    }
    #[tokio::test]
    async fn unmanaged_browsers_refuse_actions_that_can_navigate() {
        let home = fixture();
        let env = std::collections::BTreeMap::new();
        for cfg in [
            json!({"browser":{"cdp_url":"http://127.0.0.1:9222"}}),
            json!({"browser":{"cloud_provider":"browserbase"}}),
        ] {
            for name in [
                "browser_click",
                "browser_press",
                "browser_back",
                "browser_type",
                "browser_console",
            ] {
                assert_eq!(
                    browser_tool(home.path(), "owl", "section", &cfg, &env, name, &json!({}))
                        .await
                        .unwrap_err()
                        .code,
                    4302
                );
            }
        }
        for method in [
            "Runtime.evaluate",
            "Runtime.callFunctionOn",
            "Page.navigate",
            "Input.dispatchMouseEvent",
            "Target.createTarget",
        ] {
            assert_eq!(
                browser_cdp(&json!({}), &env, &json!({"method":method,"params":{"expression":"location='http://169.254.169.254/'"}}))
                    .await
                    .unwrap_err()
                    .code,
                4302
            );
        }
    }
    fn fixture() -> common::TestHome {
        let home = common::TestHome::new();
        crate::db::migrate(home.path()).unwrap();
        crate::db::open(home.path()).unwrap().execute("INSERT INTO users(id,display_name,role,created_at) VALUES('alice','Alice','admin',0)", []).unwrap();
        crate::db::open(home.path())
            .unwrap()
            .execute("INSERT INTO bots(name,owner_id) VALUES('owl','alice')", [])
            .unwrap();
        let cwd = home.workspace();
        fs::create_dir_all(&cwd).unwrap();
        crate::db::open(home.path())
            .unwrap()
            .execute(
                "INSERT INTO settings(key,value) VALUES('workspace_dir',?)",
                [json!(cwd).to_string()],
            )
            .unwrap();
        common::write_config(home.path(), &json!({"tools":{"enabled_toolsets":["code_execution","image_gen","tts","browser","web"]}})).unwrap();
        home
    }
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn code_scan_budget_explains_recovery_and_a_smaller_workspace_runs() {
        if !crate::credentials::isolation_available() {
            return;
        }
        let home = fixture();
        let work = home.workspace();
        for i in 0..1001 {
            fs::create_dir(work.join(i.to_string())).unwrap();
        }
        let cfg = json!({});
        let env = Default::default();
        let args = json!({"code": "print('ok')"});
        let error = CODE_SANDBOX
            .scope(
                (Some(crate::credentials::Confine::Workspace), work.clone()),
                execute_code(home.path(), "owl", "section", &cfg, &env, &args),
            )
            .await
            .unwrap_err();
        assert!(error.message.contains("directory budget"));
        assert!(
            error
                .message
                .contains("terminal tool using full_access and a reason")
        );
        assert!(error.message.contains("smaller workspace"));
        let small = work.join("0");
        let result = CODE_SANDBOX
            .scope(
                (Some(crate::credentials::Confine::Workspace), small),
                execute_code(home.path(), "owl", "section", &cfg, &env, &args),
            )
            .await
            .unwrap();
        close_session(home.path(), "section").await;
        assert_eq!(result["success"], true, "{result}");
        assert_eq!(result["output"], "ok\n");
    }
    #[tokio::test]
    async fn kernel_uses_frozen_cwd_without_connector_secrets() {
        let home = fixture();
        fs::write(
            home.path().join(".env"),
            "OPENAI_API_KEY=secret\nAWS_SECRET_ACCESS_KEY=secret\nPYTHONPATH=/wrong\n",
        )
        .unwrap();
        let cwd = home.workspace().with_file_name("scheduled-directory");
        fs::create_dir(&cwd).unwrap();
        fs::write(cwd.join("from-pi.txt"), "shared cwd").unwrap();
        crate::runtime_store::open(home.path())
            .unwrap()
            .execute(
                "INSERT INTO native_sessions(stored_id,owner,bot,prompt,options) VALUES('section','alice','owl','frozen',?)",
                [json!({ "cwd": cwd }).to_string()],
            )
            .unwrap();
        let result = call(
            home.path(),
            "alice",
            "owl",
            "section",
            "execute_code",
            &json!({
                "code": "import os\nassert 'OPENAI_API_KEY' not in os.environ\nassert 'AWS_SECRET_ACCESS_KEY' not in os.environ\nassert 'PYTHONPATH' not in os.environ\nprint(open('from-pi.txt').read())"
            }),
        )
        .await
        .unwrap();
        close_session(home.path(), "section").await;
        assert_eq!(result["success"], true, "{result}");
        assert_eq!(result["output"], "shared cwd\n");
        assert_eq!(
            workdir(home.path(), "owl").unwrap(),
            home.workspace().canonicalize().unwrap()
        );
    }
    #[tokio::test]
    async fn media_paths_reject_escapes_and_nonregular_files() {
        let home = fixture();
        let cwd = workdir(home.path(), "owl").unwrap();
        fs::write(cwd.join("image.png"), b"image").unwrap();
        assert!(
            image_data(home.path(), "owl", "image.png")
                .await
                .unwrap()
                .starts_with("data:image/png")
        );
        for path in [
            "../outside.png",
            "/etc/passwd",
            "/dev/zero",
            "/tmp/../../etc/passwd",
        ] {
            assert!(media_path(home.path(), "owl", path).is_err(), "{path}");
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(home.path(), cwd.join("escape")).unwrap();
            assert!(media_path(home.path(), "owl", "escape/private.png").is_err());
            std::os::unix::fs::symlink("/dev/zero", cwd.join("device.png")).unwrap();
            assert!(image_data(home.path(), "owl", "device.png").await.is_err());
        }
        assert_eq!(
            media_path(home.path(), "owl", "new/audio.mp3").unwrap(),
            cwd.join("new/audio.mp3")
        );
        let output = artifact(home.path(), "owl", "images", "png").unwrap();
        assert_eq!(
            media_path(home.path(), "owl", output.to_str().unwrap()).unwrap(),
            output
                .parent()
                .unwrap()
                .canonicalize()
                .unwrap()
                .join(output.file_name().unwrap())
        );
        assert!(
            speech(
                home.path(),
                "owl",
                &json!({}),
                &Default::default(),
                &json!({"text":"hello","output_path":"/etc/passwd"})
            )
            .await
            .is_err()
        );
    }
    #[tokio::test]
    async fn model_url_tools_reject_metadata_before_calling_services() {
        let home = fixture();
        for (name, args) in [
            ("browser_navigate", json!({"url":"http://169.254.169.254/"})),
            ("web_extract", json!({"urls":["http://127.0.0.1:9119/"]})),
        ] {
            assert!(
                call(home.path(), "alice", "owl", "section", name, &args)
                    .await
                    .is_err(),
                "{name}"
            );
        }
        assert_eq!(
            image_data(home.path(), "owl", "http://169.254.169.254/image.png")
                .await
                .unwrap_err()
                .code,
            4302
        );
    }
    #[tokio::test]
    async fn extraction_blocks_metadata_redirects_before_calling_the_backend() {
        let home = fixture();
        common::write_config(
            home.path(),
            &json!({"security":{"allow_private_urls":true}}),
        )
        .unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = axum::Router::new().route(
            "/",
            axum::routing::get(|| async {
                axum::response::Redirect::temporary("http://169.254.169.254/latest")
            }),
        );
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let error = extract(
            home.path(),
            "owl",
            &json!({}),
            &Default::default(),
            &json!({"urls":[format!("http://{address}/")]}),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, 4302);
        server.abort();
    }
    #[test]
    fn bot_tool_descriptions_use_product_words() {
        let home = fixture();
        common::write_config(
            home.path(),
            &json!({"tools":{"enabled_toolsets":["session_search","skills"]}}),
        )
        .unwrap();
        let tools = crate::native_product_tools::descriptors(home.path(), "owl").unwrap();
        assert!(!tools.is_empty());
        for tool in tools {
            let description = tool["description"].as_str().unwrap();
            for word in ["sessions", "profile", "Hermes"] {
                assert!(!description.contains(word), "{description}");
            }
        }
    }
}
