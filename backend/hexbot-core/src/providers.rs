//! Provider credentials and model catalogs. The embedded catalog is a snapshot of
//! the Hermes provider profiles in this checkout, with live refresh when requested.
const CATALOG: &str = include_str!("providers.json");

use crate::{Error, Result, common};
use base64::Engine;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::Duration,
};

fn catalog() -> &'static Value {
    static DATA: OnceLock<Value> = OnceLock::new();
    DATA.get_or_init(|| serde_json::from_str(CATALOG).expect("provider catalog"))
}
fn profiles() -> &'static [Value] {
    catalog()["providers"].as_array().unwrap()
}
fn string<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or("")
}
pub fn canonical_provider(name: &str) -> String {
    let name = name.trim().to_lowercase();
    let alias = match name.as_str() {
        "openai" | "gpt" => "openai-api",
        "chatgpt" | "codex" => "openai-codex",
        "claude" => "anthropic",
        "moonshotai" => "kimi-coding",
        "moonshotai-cn" => "kimi-coding-cn",
        "grok" => "xai",
        "glm" | "z.ai" | "z-ai" => "zai",
        _ => &name,
    };
    profiles()
        .iter()
        .find(|p| {
            p["aliases"]
                .as_array()
                .is_some_and(|a| a.iter().any(|s| s == alias))
        })
        .map(|p| string(p, "name").to_owned())
        .unwrap_or_else(|| alias.to_owned())
}
pub fn pi_provider(name: &str) -> String {
    match canonical_provider(name).as_str() {
        "openai-api" => "openai",
        "gemini" => "google",
        "vertex" => "google-vertex",
        "bedrock" => "amazon-bedrock",
        "copilot" => "github-copilot",
        "kimi-coding" => "moonshotai",
        "kimi-coding-cn" => "moonshotai-cn",
        "xai-oauth" => "xai",
        "opencode-zen" => "opencode",
        "ai-gateway" => "vercel-ai-gateway",
        other => other,
    }
    .to_owned()
}
fn profile(name: &str) -> Result<&'static Value> {
    profiles()
        .iter()
        .find(|p| p["name"] == name)
        .ok_or_else(|| Error::new(4206, format!("unknown provider: {name}")))
}
fn read_json(path: &Path) -> Result<Value> {
    match fs::read(path) {
        Ok(bytes) => {
            let value: Value = serde_json::from_slice(&bytes)
                .map_err(|_| Error::new(5200, format!("invalid JSON in {}", path.display())))?;
            if !value.is_object() {
                return Err(Error::new(
                    5200,
                    format!("expected JSON object in {}", path.display()),
                ));
            }
            Ok(value)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
        Err(e) => Err(e.into()),
    }
}
fn write_json(path: &Path, value: &Value) -> Result<()> {
    common::atomic_write(
        path,
        &serde_json::to_vec_pretty(value).map_err(|e| Error::new(5200, e.to_string()))?,
    )
}
fn credentials_lock() -> &'static Mutex<()> {
    common::credentials_lock()
}
fn key(home: &Path, p: &Value) -> Result<Option<String>> {
    let disabled = read_json(&home.join("providers-disabled.json"))?;
    if disabled[string(p, "name")] == true {
        return Ok(None);
    }
    let values = common::env_values(home)?;
    let explicit = p["env_vars"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter(|name| !name.ends_with("_BASE_URL"))
        .find_map(|name| {
            values
                .get(name)
                .cloned()
                .or_else(|| std::env::var(name).ok())
                .filter(|s| !s.is_empty())
        });
    if explicit.is_some() {
        return Ok(explicit
            .filter(|key| string(p, "name") != "copilot" || !key.trim().starts_with("ghp_")));
    }
    let slug = string(p, "name");
    if let Some(entry) = pool_entry(home, slug, false)? {
        return Ok(Some(string(&entry, "access_token").to_owned()));
    }
    if slug == "copilot"
        && home
            .parent()
            .and_then(Path::file_name)
            .is_none_or(|name| name != "profiles")
    {
        return Ok(github_cli_token("gh".as_ref()));
    }
    Ok(None)
}
fn github_cli_token(program: &Path) -> Option<String> {
    // Bound the credential helper as well as its output; never print its diagnostics.
    let mut child = std::process::Command::new(program)
        .args(["auth", "token"])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    return None;
                }
                use std::io::Read;
                let mut output = String::new();
                child
                    .stdout
                    .take()?
                    .take(16384)
                    .read_to_string(&mut output)
                    .ok()?;
                let token = output.trim();
                return (!token.is_empty() && !token.starts_with("ghp_")).then(|| token.to_owned());
            }
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(10))
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}
fn pool_entry(home: &Path, slug: &str, oauth: bool) -> Result<Option<Value>> {
    let auth = read_json(&home.join("auth.json"))?;
    Ok(auth["credential_pool"][slug]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|v| {
            (v["auth_type"] == "oauth" || string(v, "access_token").starts_with("sk-ant-oat"))
                == oauth
        })
        .filter(|v| {
            !string(v, "access_token").is_empty()
                && v["disabled"] != true
                && v["source"] != "claude_code"
        })
        .min_by_key(|v| v["priority"].as_i64().unwrap_or(0))
        .cloned())
}
fn oauth(home: &Path, slug: &str) -> Result<Value> {
    let auth = read_json(&home.join("auth.json"))?;
    let state = &auth["providers"][slug];
    if state.is_object() {
        return Ok(state.clone());
    }
    if let Some(mut entry) = pool_entry(home, slug, true)? {
        if let Some(ms) = entry["expires_at_ms"].as_f64() {
            entry["expires_at"] = json!(ms / 1000.0);
        }
        return Ok(entry);
    }
    if slug == "anthropic" {
        let login = read_json(&home.join(".anthropic_oauth.json"))?;
        if !string(&login, "accessToken").is_empty() {
            return Ok(
                json!({"access_token":login["accessToken"],"refresh_token":login["refreshToken"],"expires_at":login["expiresAt"].as_f64().unwrap_or(0.0)/1000.0}),
            );
        }
    }
    Ok(Value::Null)
}
// A grant copied into several legacy bot directories still maps to one daemon store.
// The import files remain read-only. Rotated tokens are committed here before use.
fn shared_grant_path(home: &Path, slug: &str, tokens: &Value) -> PathBuf {
    use sha2::{Digest, Sha256};
    let identity = tokens["refresh_token"]
        .as_str()
        .filter(|s| !s.is_empty())
        .unwrap_or(string(tokens, "access_token"));
    let digest = Sha256::digest(format!("{slug}:{identity}").as_bytes());
    home.join("runtime/provider-auth")
        .join(format!("{digest:x}.json"))
}
fn daemon_oauth(slug: &str) -> bool {
    matches!(slug, "openai-codex" | "anthropic" | "xai-oauth")
}

fn configured(home: &Path, p: &Value) -> Result<bool> {
    let slug = string(p, "name");
    if read_json(&home.join("providers-disabled.json"))?[slug] == true {
        return Ok(false);
    }
    if key(home, p)?.is_some() {
        return Ok(true);
    }
    let state = oauth(home, slug)?;
    if ["access_token", "api_key", "agent_key"]
        .iter()
        .any(|k| state[k].as_str().is_some_and(|v| !v.is_empty()))
        || state["tokens"]["access_token"]
            .as_str()
            .is_some_and(|v| !v.is_empty())
    {
        return Ok(true);
    }
    if matches!(slug, "custom" | "ollama" | "lmstudio") {
        let cfg = common::read_config(home)?;
        return Ok(cfg["model"]["base_url"]
            .as_str()
            .is_some_and(|s| !s.is_empty())
            && canonical_provider(string(&cfg["model"], "provider")) == slug);
    }
    Ok(false)
}
fn env_paths(home: &Path) -> Result<Vec<PathBuf>> {
    let mut paths = vec![home.to_path_buf()];
    if home.join("profiles").is_dir() {
        for entry in fs::read_dir(home.join("profiles"))? {
            let entry = entry?;
            if entry.file_type()?.is_dir() {
                paths.push(entry.path());
            }
        }
    }
    Ok(paths)
}
fn edit_env(path: &Path, names: &[&str], replacement: Option<(&str, &str)>) -> Result<()> {
    let text = match fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(e.into()),
    };
    let mut lines: Vec<String> = text
        .lines()
        .filter(|line| {
            !line
                .trim()
                .strip_prefix("export ")
                .unwrap_or(line.trim())
                .split_once('=')
                .is_some_and(|(k, _)| names.contains(&k.trim()))
        })
        .map(str::to_owned)
        .collect();
    if let Some((name, value)) = replacement {
        lines.push(format!(
            "{name}='{}'",
            value.replace('\\', "\\\\").replace('\'', "\\'")
        ));
    }
    common::atomic_write(path, format!("{}\n", lines.join("\n")).as_bytes())
}
fn scrub_mirrors(value: &mut Value, old: &[String], replacement: Option<&str>) {
    match value {
        Value::Object(object) => {
            if object
                .get("api_key")
                .and_then(Value::as_str)
                .is_some_and(|v| old.iter().any(|k| k == v))
            {
                if let Some(key) = replacement {
                    object.insert("api_key".into(), json!(key));
                } else {
                    object.remove("api_key");
                }
            }
            for child in object.values_mut() {
                scrub_mirrors(child, old, replacement);
            }
        }
        Value::Array(values) => {
            for child in values {
                scrub_mirrors(child, old, replacement);
            }
        }
        _ => {}
    }
}
fn update_mirrors(home: &Path, names: &[&str], replacement: Option<&str>) -> Result<()> {
    for dir in env_paths(home)? {
        let values = common::env_values(&dir)?;
        let old = names
            .iter()
            .filter_map(|name| {
                values
                    .get(*name)
                    .cloned()
                    .or_else(|| std::env::var(name).ok())
            })
            .filter(|v| !v.is_empty())
            .collect::<Vec<_>>();
        if dir.join("config.yaml").exists() && !old.is_empty() {
            let mut cfg = common::read_config(&dir)?;
            scrub_mirrors(&mut cfg, &old, replacement);
            common::write_config(&dir, &cfg)?;
        }
    }
    let mut auth = read_json(&home.join("auth.json"))?;
    if let Some(pool) = auth["credential_pool"].as_object_mut() {
        for entries in pool.values_mut() {
            if let Some(entries) = entries.as_array_mut() {
                entries.retain(|entry| {
                    !names
                        .iter()
                        .any(|name| entry["source"] == format!("env:{name}"))
                });
            }
        }
        write_json(&home.join("auth.json"), &auth)?;
    }
    Ok(())
}
pub fn set_key(home: &Path, provider: &str, value: &str) -> Result<Value> {
    let slug = canonical_provider(provider);
    let p = profile(&slug)?;
    let env = p["env_vars"]
        .as_array()
        .and_then(|a| a.first())
        .and_then(Value::as_str)
        .ok_or_else(|| Error::new(4207, "provider has no API-key environment variable"))?;
    if value.trim().is_empty() || value.chars().any(char::is_control) {
        return Err(Error::new(
            4200,
            "API key must be nonempty and contain no control characters",
        ));
    }
    let _lock = credentials_lock()
        .lock()
        .map_err(|_| Error::new(5200, "credentials lock unavailable"))?;
    let mut disabled = read_json(&home.join("providers-disabled.json"))?;
    update_mirrors(home, &[env], Some(value.trim()))?;
    for dir in env_paths(home)? {
        edit_env(&dir.join(".env"), &[env], Some((env, value.trim())))?;
    }
    disabled[&slug] = json!(false);
    write_json(&home.join("providers-disabled.json"), &disabled)?;
    Ok(json!({"provider":slug,"configured":true}))
}
pub fn clear_key(home: &Path, provider: &str) -> Result<Value> {
    let slug = canonical_provider(provider);
    let p = profile(&slug)?;
    let _lock = credentials_lock()
        .lock()
        .map_err(|_| Error::new(5200, "credentials lock unavailable"))?;
    let names = p["env_vars"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect::<Vec<_>>();
    let mut disabled = read_json(&home.join("providers-disabled.json"))?;
    update_mirrors(home, &names, None)?;
    let mut auth = read_json(&home.join("auth.json"))?;
    for dir in env_paths(home)? {
        edit_env(&dir.join(".env"), &names, None)?;
    }
    if let Some(pool) = auth["credential_pool"].as_object_mut() {
        pool.remove(&slug);
    }
    if let Some(providers) = auth["providers"].as_object_mut() {
        providers.remove(&slug);
    }
    if auth["active_provider"] == slug {
        auth.as_object_mut().unwrap().remove("active_provider");
    }
    write_json(&home.join("auth.json"), &auth)?;
    disabled[&slug] = json!(true);
    let epoch_key = format!("__epoch_{slug}");
    disabled[&epoch_key] = json!(disabled[&epoch_key].as_u64().unwrap_or(0).saturating_add(1));
    write_json(&home.join("providers-disabled.json"), &disabled)?;
    Ok(json!({"provider":slug,"configured":false}))
}
fn custom_profiles(cfg: &Value) -> Vec<Value> {
    let mut rows = Vec::new();
    let mut add = |name: &str, entry: &Value| {
        let base = entry["base_url"]
            .as_str()
            .or_else(|| entry["api"].as_str())
            .unwrap_or("");
        if name.is_empty() || base.is_empty() {
            return;
        }
        let slug = name.to_lowercase();
        let mut models = entry["models"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|m| {
                m.as_str()
                    .map(str::to_owned)
                    .or_else(|| m["id"].as_str().map(str::to_owned))
            })
            .collect::<Vec<_>>();
        if let Some(model) = entry["model"]
            .as_str()
            .or_else(|| entry["default_model"].as_str())
            && !models.iter().any(|m| m == model)
        {
            models.push(model.to_owned());
        }
        rows.push(json!({"name":slug,"display_name":name,"base_url":base,"api_key":entry["api_key"],"env_vars":entry["key_env"].as_str().map(|k|vec![k]).unwrap_or_default(),"api_mode":entry["api_mode"].as_str().unwrap_or("chat_completions"),"auth_type":"api_key","models":models,"aliases":[format!("custom:{slug}")]}));
    };
    if let Some(providers) = cfg["providers"].as_object() {
        for (name, entry) in providers {
            add(name, entry);
        }
    }
    if let Some(providers) = cfg["custom_providers"].as_array() {
        for entry in providers {
            add(string(entry, "name"), entry);
        }
    }
    rows
}
fn custom_key(home: &Path, p: &Value) -> Result<Option<String>> {
    let literal = string(p, "api_key");
    if let Some(name) = literal.strip_prefix("${").and_then(|s| s.strip_suffix('}')) {
        return Ok(common::env_values(home)?
            .get(name)
            .cloned()
            .or_else(|| std::env::var(name).ok()));
    }
    if !literal.is_empty() {
        return Ok(Some(literal.to_owned()));
    }
    key(home, p)
}
pub fn list_providers(home: &Path) -> Result<Value> {
    let mut rows=profiles().iter().map(|p|Ok(json!({"id":p["name"],"label":p["display_name"].as_str().unwrap_or(string(p,"name")),"configured":configured(home,p)?,"auth_type":p["auth_type"].as_str().unwrap_or("api_key"),"key_supported":p["env_vars"].as_array().is_some_and(|v|!v.is_empty()),"models_source":if string(p,"models_url").is_empty(){"registry"}else{"live"}}))).collect::<Result<Vec<Value>>>()?;
    for p in custom_profiles(&common::read_config(home)?) {
        rows.push(json!({"id":p["name"],"label":p["display_name"],"configured":true,"auth_type":"api_key","key_supported":!p["env_vars"].as_array().unwrap().is_empty(),"models_source":"live"}));
    }
    rows.sort_by_key(|p| {
        (
            !p["configured"].as_bool().unwrap_or(false),
            string(p, "label").to_lowercase(),
        )
    });
    Ok(json!({"providers":rows}))
}
fn catalog_models(slug: &str) -> Vec<String> {
    let mut models = profiles()
        .iter()
        .find(|p| p["name"] == slug)
        .and_then(|p| p["models"].as_array())
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect::<Vec<_>>();
    for row in catalog()["curated"].as_array().unwrap() {
        if canonical_provider(string(row, "provider")) == slug {
            let id = string(row, "id").to_owned();
            if !models.contains(&id) {
                models.push(id)
            }
        }
    }
    models
}
fn metadata(cache: &Value, cfg: &Value, provider: &str, model: &str) -> Value {
    let mapped = pi_provider(provider);
    let raw = cache[provider]["models"]
        .get(model)
        .or_else(|| cache[&mapped]["models"].get(model));
    let mut data = raw.cloned().unwrap_or_else(|| json!({}));
    let overrides = &cfg["model_overrides"];
    let patch = overrides[provider]
        .get(model)
        .or_else(|| overrides[&mapped].get(model));
    let defaults = if raw.is_none() {
        overrides[provider]
            .get("_default")
            .or_else(|| overrides.get("_default"))
    } else {
        None
    };
    for patch in defaults.into_iter().chain(patch) {
        if let Some(context) = patch["context_window"].as_u64() {
            data["limit"]["context"] = json!(context)
        }
        if let Some(output) = patch["max_output_tokens"].as_u64() {
            data["limit"]["output"] = json!(output)
        }
        if let Some(reasoning) = patch["supports_reasoning"].as_bool() {
            data["reasoning"] = json!(reasoning)
        }
        if let Some(vision) = patch["supports_vision"].as_bool() {
            data["modalities"]["input"] = if vision {
                json!(["text", "image"])
            } else {
                json!(["text"])
            }
        }
    }
    data
}
fn model_row(cache: &Value, cfg: &Value, provider: &str, id: &str) -> Value {
    let data = metadata(cache, cfg, provider, id);
    let mut row = json!({"provider":provider,"id":id,"label":id});
    if let Some(context) = data["limit"]["context"].as_u64() {
        row["context"] = json!(context)
    }
    for (source, target) in [("input", "input_cost"), ("output", "output_cost")] {
        if let Some(cost) = data["cost"][source].as_f64() {
            row[target] = json!(if cost == 0.0 {
                "free".to_owned()
            } else {
                format!("${cost:.2}")
            })
        }
    }
    row
}
fn client() -> Result<reqwest::Client> {
    crate::http::client(20, 0).map_err(|_| Error::new(5200, "HTTP client unavailable"))
}
fn http_error(e: reqwest::Error) -> Error {
    crate::http::error(
        e,
        4211,
        [
            "provider request failed: timeout",
            "provider request failed: connection failed",
            "provider request failed: invalid response",
        ],
    )
}
async fn limited_json(response: reqwest::Response) -> Result<Value> {
    crate::http::json(
        response,
        16 * 1024 * 1024,
        http_error,
        Error::new(4211, "provider response exceeds 16 MiB"),
        Error::new(4211, "provider request failed: invalid response"),
    )
    .await
}

async fn live_models(home: &Path, p: &Value) -> Result<Vec<String>> {
    let cfg = common::read_config(home)?;
    let slug = string(p, "name");
    let base = if canonical_provider(string(&cfg["model"], "provider")) == slug {
        cfg["model"]["base_url"]
            .as_str()
            .unwrap_or(string(p, "base_url"))
    } else {
        string(p, "base_url")
    };
    let url = if !string(p, "models_url").is_empty() {
        string(p, "models_url").to_owned()
    } else {
        format!("{}/models", base.trim_end_matches('/'))
    };
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Ok(vec![]);
    }
    let mut req = client()?.get(url);
    if let Some(k) = custom_key(home, p)? {
        req = if slug == "anthropic" {
            req.header("x-api-key", k)
                .header("anthropic-version", "2023-06-01")
        } else {
            req.bearer_auth(k)
        }
    }
    let response = req.send().await.map_err(http_error)?;
    if !response.status().is_success() {
        return Err(Error::new(
            4211,
            format!(
                "model catalog request failed (HTTP {})",
                response.status().as_u16()
            ),
        ));
    }
    let data: Value = limited_json(response).await?;
    let mut models = data["data"]
        .as_array()
        .or_else(|| data["models"].as_array())
        .into_iter()
        .flatten()
        .filter_map(|m| m["id"].as_str().or_else(|| m["name"].as_str()))
        .map(|s| s.trim_start_matches("models/").to_owned())
        .collect::<Vec<_>>();
    models.sort();
    models.dedup();
    Ok(models)
}
pub async fn model_options(home: &Path, p: &Value) -> Result<Value> {
    let cfg = common::read_config(home)?;
    let current = canonical_provider(string(&cfg["model"], "provider"));
    let mut rows = vec![];
    for provider in profiles() {
        let slug = string(provider, "name");
        let configured = configured(home, provider)?;
        let mut models = if configured || p["include_unconfigured"] == true {
            catalog_models(slug)
        } else {
            vec![]
        };
        let mut source = "catalog";
        let mut error = None;
        if p["refresh"] == true
            && configured
            && (string(p, "provider").is_empty()
                || canonical_provider(string(p, "provider")) == slug)
        {
            match live_models(home, provider).await {
                Ok(m) if !m.is_empty() => {
                    models = m;
                    source = "live"
                }
                Ok(_) => {}
                Err(e) => error = Some(e.message),
            }
        }
        let mut row = json!({"slug":slug,"name":provider["display_name"].as_str().unwrap_or(slug),"is_current":current==slug,"total_models":models.len(),"models":models,"authenticated":configured,"auth_type":provider["auth_type"].as_str().unwrap_or("api_key"),"key_env":provider["env_vars"][0].as_str().unwrap_or(""),"source":source,"pricing":{}});
        if let Some(error) = error {
            row["error"] = json!(error)
        }
        rows.push(row);
    }
    for provider in custom_profiles(&cfg) {
        let slug = string(&provider, "name");
        let active = current == slug || current == format!("custom:{slug}");
        let mut models = provider["models"].as_array().cloned().unwrap_or_default();
        if active
            && let Some(model) = cfg["model"]["default"].as_str()
            && !models.iter().any(|id| id == model)
        {
            models.push(json!(model));
        }
        let mut error = None;
        if p["refresh"] == true
            && (string(p, "provider").is_empty()
                || canonical_provider(string(p, "provider")) == slug
                || canonical_provider(string(p, "provider")) == format!("custom:{slug}"))
        {
            match live_models(home, &provider).await {
                Ok(ids) if !ids.is_empty() => models = ids.into_iter().map(Value::from).collect(),
                Err(e) => error = Some(e.message),
                _ => {}
            }
        }
        let mut row = json!({"slug":slug,"name":provider["display_name"],"aliases":provider["aliases"],"is_user_defined":true,"is_current":active,"total_models":models.len(),"models":models,"authenticated":true,"auth_type":"api_key","source":"custom","pricing":{}});
        if let Some(error) = error {
            row["error"] = json!(error);
        }
        rows.push(row);
    }
    Ok(
        json!({"providers":rows,"model":cfg["model"]["default"].as_str().unwrap_or(""),"provider":current}),
    )
}
pub async fn list_models(home: &Path, p: &Value) -> Result<Value> {
    let slug = canonical_provider(string(p, "provider"));
    let curated = catalog()["curated"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|m| slug.is_empty() || canonical_provider(string(m, "provider")) == slug)
        .cloned()
        .collect::<Vec<_>>();
    let mut options = p.clone();
    if !options.is_object() {
        options = json!({})
    }
    if !slug.is_empty() && options.get("include_unconfigured").is_none() {
        options["include_unconfigured"] = json!(true)
    }
    let options = model_options(home, &options).await?;
    let cache = read_json(&home.join("models_dev_cache.json")).unwrap_or_else(|_| json!({}));
    let cfg = common::read_config(home)?;
    let mut all = vec![];
    let mut live = false;
    let mut errors = vec![];
    for row in options["providers"].as_array().unwrap() {
        let provider = string(row, "slug");
        if !slug.is_empty()
            && slug != provider
            && !row["aliases"]
                .as_array()
                .is_some_and(|aliases| aliases.iter().any(|alias| alias == &slug))
        {
            continue;
        }
        live |= row["source"] == "live";
        if let Some(error) = row["error"].as_str() {
            errors.push(error.to_owned())
        }
        let mut ids = row["models"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect::<Vec<_>>();
        if ids.is_empty() {
            ids = catalog_models(provider)
        }
        for id in ids {
            all.push(model_row(&cache, &cfg, provider, &id))
        }
    }
    all.sort_by_key(|v| string(v, "label").to_lowercase());
    let mut output = json!({"curated":curated,"all_source":if all.is_empty(){"none"}else if live{"mixed"}else{"catalog"},"all":all});
    if !errors.is_empty() {
        output["error"] = json!(errors.join("; "))
    }
    Ok(output)
}

/// Prepare transport credentials. The daemon alone owns and rotates OAuth refresh tokens.
pub fn prepare_pi(home: &Path, agent_dir: &Path) -> Result<()> {
    prepare_pi_config(home, None, agent_dir)
}
pub fn prepare_pi_for_bot(home: &Path, bot: &str, agent_dir: &Path) -> Result<()> {
    common::identifier(bot)?;
    prepare_pi_config(home, Some(&home.join("profiles").join(bot)), agent_dir)
}
/// Short-lived callers without the extension also start with a current access token.
pub async fn prepare_pi_for_request(
    home: &Path,
    bot: &str,
    agent_dir: &Path,
    provider: Option<&str>,
) -> Result<()> {
    prepare_pi_for_bot(home, bot, agent_dir)?;
    let Some(provider) = provider else {
        return Ok(());
    };
    let mut slug = canonical_provider(provider);
    let auth = read_json(&agent_dir.join("auth.json"))?;
    if slug == "xai" && auth["xai"]["type"] == "oauth" {
        slug = "xai-oauth".into();
    }
    if daemon_oauth(&slug) && auth[pi_provider(&slug)]["type"] == "oauth" {
        request_auth(home, bot, &slug).await?;
        prepare_pi_for_bot(home, bot, agent_dir)?;
    }
    Ok(())
}
fn prepare_pi_config(home: &Path, profile_home: Option<&Path>, agent_dir: &Path) -> Result<()> {
    let _lock = credentials_lock()
        .lock()
        .map_err(|_| Error::new(5200, "credentials lock unavailable"))?;
    let mut cfg = common::read_config(home)?;
    if let Some(profile_home) = profile_home {
        let profile_cfg = common::read_config(profile_home)?;
        for key in [
            "model_overrides",
            "providers",
            "custom_providers",
            "fallback_providers",
        ] {
            if profile_cfg.get(key).is_some() {
                cfg[key] = profile_cfg[key].clone();
            }
        }
        if let Some(model) = profile_cfg["model"].as_object() {
            if !cfg["model"].is_object() {
                cfg["model"] = json!({});
            }
            for (key, value) in model {
                cfg["model"][key] = value.clone();
            }
        }
    }
    let selected_provider = canonical_provider(string(&cfg["model"], "provider"));
    let mut fallbacks = cfg["fallback_providers"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    for row in common::rows(
        &crate::db::open(home)?,
        "SELECT value FROM settings WHERE key='fallback_model'",
        &[],
    )? {
        if let Ok(Value::String(choice)) = serde_json::from_str::<Value>(string(&row, "value"))
            && let Some((provider, model)) = choice.split_once('/')
        {
            fallbacks.push(json!({"provider":provider,"model":model}));
        }
    }
    let mut auth = read_json(&agent_dir.join("auth.json"))?;
    let disabled = read_json(&home.join("providers-disabled.json"))?;
    for p in profiles() {
        let slug = string(p, "name");
        let pi = pi_provider(slug);
        // xAI API and subscription credentials share a Pi transport. Use the bot's selected grant.
        if matches!(slug, "xai" | "xai-oauth")
            && matches!(selected_provider.as_str(), "xai" | "xai-oauth")
            && slug != selected_provider
        {
            continue;
        }
        if slug == "copilot-acp" && disabled[slug] != true {
            auth[&pi] = json!({"type":"api_key","key":"external-process"});
        }
        if disabled[slug] == true {
            if let Some(object) = auth.as_object_mut() {
                object.remove(&pi);
            }
            continue;
        }
        let profile_key = profile_home.map(|dir| key(dir, p)).transpose()?.flatten();
        let inline_key = if slug == selected_provider {
            cfg["model"]["api_key"]
                .as_str()
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
        } else {
            None
        };
        if let Some(key) = inline_key.or(profile_key).or(key(home, p)?) {
            auth[&pi] = json!({"type":"api_key","key":key});
            continue;
        }
        let profile_state = profile_home
            .map(|dir| oauth(dir, slug))
            .transpose()?
            .unwrap_or(Value::Null);
        let mut state = if profile_state.is_object() {
            profile_state
        } else {
            oauth(home, slug)?
        };
        if slug == "qwen-oauth"
            && string(&state, "access_token").is_empty()
            && !state["tokens"].is_object()
        {
            state = import_qwen(home)?;
        }
        let tokens = if state["tokens"].is_object() {
            &state["tokens"]
        } else {
            &state
        };
        let access = string(tokens, "access_token");
        if access.is_empty() {
            if daemon_oauth(slug) && auth[&pi]["type"] == "oauth" {
                auth.as_object_mut().unwrap().remove(&pi);
            }
            continue;
        }
        if daemon_oauth(slug) {
            let shared = read_json(&shared_grant_path(home, slug, tokens))?;
            let access = shared["access_token"]
                .as_str()
                .filter(|s| !s.is_empty())
                .unwrap_or(access);
            // Pi retains its OAuth transport behavior, but only the daemon can refresh.
            auth[&pi] =
                json!({"type":"oauth","access":access,"refresh":"","expires":8640000000000000u64});
            if slug == "openai-codex"
                && let Some(claims) = jwt_claims(access)
            {
                auth[&pi]["accountId"] =
                    claims["https://api.openai.com/auth"]["chatgpt_account_id"].clone();
            }
        } else {
            auth[&pi] = json!({"type":"api_key","key":state["agent_key"].as_str().filter(|s|!s.is_empty()).unwrap_or(access)});
        }
    }
    write_json(&agent_dir.join("auth.json"), &auth)?;
    let mut providers = json!({});
    // Providers Pi implements natively retain their own transport and model metadata.
    const NATIVE: &[&str] = &[
        "openai",
        "openai-codex",
        "anthropic",
        "google",
        "google-vertex",
        "amazon-bedrock",
        "github-copilot",
        "openrouter",
        "xai",
        "deepseek",
        "fireworks",
        "huggingface",
        "kimi-coding",
        "moonshotai",
        "moonshotai-cn",
        "minimax",
        "minimax-cn",
        "nvidia",
        "opencode",
        "opencode-go",
        "vercel-ai-gateway",
        "xiaomi",
        "zai",
        "groq",
        "cerebras",
        "mistral",
    ];
    // Snapshot of ids and transports from the pinned Pi SDK; built-in metadata stays intact.
    static PI_CATALOG: OnceLock<Value> = OnceLock::new();
    let pi_catalog = PI_CATALOG.get_or_init(|| {
        serde_json::from_str(include_str!("pi_catalog.json")).expect("valid pinned Pi catalog")
    });
    let cache = read_json(&home.join("models_dev_cache.json")).unwrap_or_else(|_| json!({}));
    for p in profiles() {
        let slug = string(p, "name");
        let pi = pi_provider(slug);
        let selected = canonical_provider(string(&cfg["model"], "provider")) == slug;
        // ACP's custom stream is registered by the bundled Pi extension.
        if slug == "copilot-acp" {
            continue;
        }
        let env_name = string(p, "base_url_env_var");
        let override_url = if env_name.is_empty() {
            None
        } else {
            profile_home
                .map(common::env_values)
                .transpose()?
                .and_then(|env| env.get(env_name).cloned())
                .or(common::env_values(home)?.get(env_name).cloned())
                .or_else(|| std::env::var(env_name).ok())
                .filter(|v| !v.is_empty())
        };
        let configured_url = if selected {
            cfg["model"]["base_url"].as_str().filter(|s| !s.is_empty())
        } else {
            None
        };
        let native = NATIVE.contains(&pi.as_str());
        let override_base = configured_url.is_some() || override_url.is_some() || slug == "zai";
        let base = configured_url
            .or(override_url.as_deref())
            .unwrap_or(string(p, "base_url"));
        if base.is_empty() {
            continue;
        }
        let mut ids = catalog_models(slug);
        for fallback in &fallbacks {
            if canonical_provider(string(fallback, "provider")) == slug
                && !ids.iter().any(|id| id == string(fallback, "model"))
            {
                ids.push(string(fallback, "model").to_owned());
            }
        }
        if selected {
            let model = string(&cfg["model"], "default");
            if !model.is_empty() && !ids.iter().any(|s| s == model) {
                ids.push(model.to_owned())
            }
        }
        if native {
            let known = pi_catalog["providers"][&pi]["models"].as_array();
            ids.retain(|id| !known.is_some_and(|known| known.iter().any(|v| v == id)));
            if ids.is_empty() {
                if override_base {
                    providers[&pi] = json!({"baseUrl":base});
                }
                continue;
            }
        }
        let models=ids.into_iter().map(|id|{
            let meta=metadata(&cache,&cfg,slug,&id);
            json!({"id":id,"name":id,"reasoning":meta["reasoning"].as_bool().unwrap_or(false),"input":meta["modalities"]["input"].as_array().cloned().unwrap_or_else(||vec![json!("text")]),"cost":{"input":meta["cost"]["input"].as_f64().unwrap_or(0.0),"output":meta["cost"]["output"].as_f64().unwrap_or(0.0),"cacheRead":meta["cost"]["cache_read"].as_f64().unwrap_or(0.0),"cacheWrite":meta["cost"]["cache_write"].as_f64().unwrap_or(0.0)},"contextWindow":meta["limit"]["context"].as_u64().unwrap_or(32768),"maxTokens":meta["limit"]["output"].as_u64().unwrap_or(8192)})
        }).collect::<Vec<_>>();
        let api = if native {
            string(&pi_catalog["providers"][&pi], "api")
        } else {
            match string(p, "api_mode") {
                "anthropic_messages" | "anthropic" => "anthropic-messages",
                "responses" | "codex_responses" => "openai-responses",
                _ => "openai-completions",
            }
        };
        let mut entry = json!({"baseUrl":base,"api":api,"models":models});
        if !native {
            entry["authHeader"] = json!(!matches!(slug, "custom" | "ollama" | "lmstudio"));
        }
        // xAI API and subscription auth share one Pi provider and contribute different ids.
        if let Some(existing) = providers[&pi]["models"].as_array() {
            let models = entry["models"].as_array_mut().unwrap();
            for model in existing {
                if !models.iter().any(|m| m["id"] == model["id"]) {
                    models.push(model.clone());
                }
            }
        }
        providers[&pi] = entry;
    }
    for custom in custom_profiles(&cfg) {
        let slug = string(&custom, "name");
        let mut ids = custom["models"].as_array().cloned().unwrap_or_default();
        let selected = selected_provider == slug || selected_provider == format!("custom:{slug}");
        for fallback in &fallbacks {
            let provider = canonical_provider(string(fallback, "provider"));
            if (provider == slug || provider == format!("custom:{slug}"))
                && !ids.iter().any(|id| id == string(fallback, "model"))
            {
                ids.push(json!(string(fallback, "model")));
            }
        }
        if selected
            && let Some(id) = cfg["model"]["default"].as_str()
            && !ids.iter().any(|m| m == id)
        {
            ids.push(json!(id));
        }
        let models=ids.into_iter().filter_map(|v|v.as_str().map(str::to_owned)).map(|id|{
            let meta=metadata(&cache,&cfg,slug,&id);
            json!({"id":id,"name":id,"contextWindow":meta["limit"]["context"].as_u64().unwrap_or(32768),"maxTokens":meta["limit"]["output"].as_u64().unwrap_or(8192),"reasoning":meta["reasoning"].as_bool().unwrap_or(false),"input":meta["modalities"]["input"].as_array().cloned().unwrap_or_else(||vec![json!("text")])})
        }).collect::<Vec<_>>();
        let api = match string(&custom, "api_mode") {
            "anthropic_messages" => "anthropic-messages",
            "responses" | "codex_responses" => "openai-responses",
            _ => "openai-completions",
        };
        let key = profile_home
            .map(|home| custom_key(home, &custom))
            .transpose()?
            .flatten()
            .or(custom_key(home, &custom)?);
        for id in [slug.to_owned(), format!("custom:{slug}")] {
            providers[&id] = json!({"baseUrl":custom["base_url"],"api":api,"models":models,"authHeader":key.is_some()});
            if let Some(key) = &key {
                auth[&id] = json!({"type":"api_key","key":key})
            }
        }
    }
    write_json(&agent_dir.join("auth.json"), &auth)?;
    let mut models = read_json(&agent_dir.join("models.json"))?;
    if !models["providers"].is_object() {
        models["providers"] = json!({})
    }
    for (k, v) in providers.as_object().unwrap() {
        models["providers"][k] = v.clone()
    }
    write_json(&agent_dir.join("models.json"), &models)
}
fn jwt_claims(token: &str) -> Option<Value> {
    let payload = token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .ok()?;
    serde_json::from_slice(&bytes).ok()
}

#[derive(Clone)]
struct Login {
    home: PathBuf,
    caller: String,
    provider: String,
    public: Value,
    device: String,
    token_url: String,
    issuer: String,
    client_id: String,
    deadline: f64,
    next_poll: f64,
    interval: f64,
    epoch: u64,
}
fn logins() -> &'static tokio::sync::Mutex<HashMap<String, Login>> {
    static LOGINS: OnceLock<tokio::sync::Mutex<HashMap<String, Login>>> = OnceLock::new();
    LOGINS.get_or_init(|| tokio::sync::Mutex::new(HashMap::new()))
}
fn endpoint(home: &Path, slug: &str, default: &str) -> Result<String> {
    // Endpoint overrides are operator-controlled files, never accepted in RPC input.
    let cfg = common::read_config(home)?;
    let value = cfg["provider_auth"][slug]["issuer"]
        .as_str()
        .unwrap_or(default)
        .trim_end_matches('/');
    let parsed = url::Url::parse(value).map_err(|_| Error::new(4211, "invalid provider issuer"))?;
    if parsed.scheme() != "https"
        && !(parsed.scheme() == "http"
            && matches!(parsed.host_str(), Some("127.0.0.1" | "localhost" | "[::1]")))
    {
        return Err(Error::new(4211, "provider issuer requires HTTPS"));
    }
    Ok(value.to_owned())
}
async fn response_json(response: reqwest::Response) -> Result<Value> {
    let status = response.status();
    if !status.is_success() {
        return Err(Error::new(
            4211,
            format!("provider sign-in request failed (HTTP {})", status.as_u16()),
        ));
    }
    limited_json(response).await
}
async fn login_start(home: &Path, caller: &str, provider: &str) -> Result<Value> {
    let slug = canonical_provider(provider);
    if !matches!(slug.as_str(), "openai-codex" | "xai-oauth" | "nous") {
        return Ok(
            json!({"supported":false,"provider":slug,"message":"This provider requires an API key or an imported OAuth grant."}),
        );
    }
    let (default, client_id, path, scope) = match slug.as_str() {
        "openai-codex" => (
            "https://auth.openai.com",
            "app_EMoamEEZ73f0CkXaXp7hrann",
            "/api/accounts/deviceauth/usercode",
            "",
        ),
        "xai-oauth" => (
            "https://auth.x.ai",
            "b1a00492-073a-47ea-816f-4c329264a828",
            "/oauth2/device/code",
            "openid profile email offline_access grok-cli:access api:access",
        ),
        _ => (
            "https://portal.nousresearch.com",
            "hermes-cli",
            "/api/oauth/device/code",
            "inference:invoke",
        ),
    };
    let epoch = read_json(&home.join("providers-disabled.json"))?[format!("__epoch_{slug}")]
        .as_u64()
        .unwrap_or(0);
    let issuer = endpoint(home, &slug, default)?;
    let request = client()?.post(format!("{issuer}{path}"));
    let response = if slug == "openai-codex" {
        request.json(&json!({"client_id":client_id})).send().await
    } else {
        request
            .form(&[("client_id", client_id), ("scope", scope)])
            .send()
            .await
    }
    .map_err(http_error)?;
    let data = response_json(response).await?;
    let code = string(&data, "user_code");
    let device = string(
        &data,
        if slug == "openai-codex" {
            "device_auth_id"
        } else {
            "device_code"
        },
    );
    if code.is_empty() || device.is_empty() {
        return Err(Error::new(
            4211,
            "provider device-code response was incomplete",
        ));
    }
    let url = if slug == "openai-codex" {
        format!("{issuer}/codex/device")
    } else {
        data["verification_uri_complete"]
            .as_str()
            .or_else(|| data["verification_uri"].as_str())
            .unwrap_or("")
            .to_owned()
    };
    let parsed = url::Url::parse(&url).map_err(|_| Error::new(4211, "invalid verification URL"))?;
    if parsed.scheme() != "https" && !(parsed.scheme() == "http" && url.starts_with(&issuer)) {
        return Err(Error::new(4211, "untrusted verification URL"));
    }
    let id = common::id();
    let public = json!({"supported":true,"login_id":id,"provider":slug,"status":"pending","url":url,"code":code,"message":""});
    let now = common::now();
    let interval = data["interval"]
        .as_f64()
        .or_else(|| {
            data["interval"]
                .as_str()
                .and_then(|s| s.parse::<f64>().ok())
        })
        .unwrap_or(5.0)
        .clamp(1.0, 30.0);
    let token_url = format!(
        "{issuer}{}",
        match slug.as_str() {
            "openai-codex" => "/api/accounts/deviceauth/token",
            "xai-oauth" => "/oauth2/token",
            _ => "/api/oauth/token",
        }
    );
    let login = Login {
        home: home.to_path_buf(),
        caller: caller.to_owned(),
        provider: slug.clone(),
        public: public.clone(),
        device: device.to_owned(),
        token_url,
        issuer,
        client_id: client_id.to_owned(),
        deadline: now
            + data["expires_in"]
                .as_f64()
                .unwrap_or(900.0)
                .clamp(1.0, 900.0),
        next_poll: now + interval,
        interval,
        epoch,
    };
    let mut entries = logins().lock().await;
    entries.retain(|_, entry| entry.deadline + 900.0 > now);
    for entry in entries.values_mut() {
        if entry.home == home && entry.provider == slug && entry.public["status"] == "pending" {
            entry.public["status"] = json!("cancelled");
            entry.public["message"] = json!("Sign-in replaced by another request.")
        }
    }
    entries.insert(id.clone(), login);
    drop(entries);
    let home = home.to_path_buf();
    let caller = caller.to_owned();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs_f64(interval)).await;
            match login_poll(&home, &caller, &id, false).await {
                Ok(v) if v["status"] == "pending" => {}
                _ => break,
            }
        }
    });
    Ok(public)
}
async fn login_poll(home: &Path, caller: &str, id: &str, cancel: bool) -> Result<Value> {
    common::admin(home, caller)?;
    let mut entries = logins().lock().await;
    let entry = entries
        .get_mut(id)
        .filter(|e| e.home == home && e.caller == caller)
        .ok_or_else(|| Error::new(4210, "unknown sign-in"))?;
    if entry.public["status"] != "pending" {
        return Ok(entry.public.clone());
    }
    if cancel {
        entry.public["status"] = json!("cancelled");
        entry.public["message"] = json!("Sign-in cancelled.");
        return Ok(entry.public.clone());
    }
    let now = common::now();
    if now >= entry.deadline {
        entry.public["status"] = json!("error");
        entry.public["message"] = json!("Sign-in timed out. Start it again when you are ready.");
        return Ok(entry.public.clone());
    }
    if now < entry.next_poll {
        return Ok(entry.public.clone());
    }
    entry.next_poll = now + entry.interval;
    let login = entry.clone();
    drop(entries);
    let result = poll_token(&login).await;
    let mut entries = logins().lock().await;
    let entry = entries
        .get_mut(id)
        .ok_or_else(|| Error::new(4210, "unknown sign-in"))?;
    // Recheck after network activity: cancelling must never install a late grant.
    if entry.public["status"] != "pending" {
        return Ok(entry.public.clone());
    }
    match result {
        Ok(Some(tokens)) => match save_tokens(home, &login, &tokens) {
            Ok(()) => {
                entry.public["status"] = json!("done");
                entry.public["message"] = json!("Signed in.")
            }
            Err(e) => {
                entry.public["status"] = json!("error");
                entry.public["message"] = json!(e.message)
            }
        },
        Ok(None) => {}
        Err(e) if e.code == 4212 => {
            entry.interval = (entry.interval + 1.0).min(30.0);
            entry.next_poll = common::now() + entry.interval
        }
        Err(e) => {
            entry.public["status"] = json!("error");
            entry.public["message"] = json!(e.message)
        }
    }
    Ok(entry.public.clone())
}
async fn poll_token(login: &Login) -> Result<Option<Value>> {
    let request = client()?.post(&login.token_url);
    let response = if login.provider == "openai-codex" {
        request
            .json(&json!({"device_auth_id":login.device,"user_code":login.public["code"]}))
            .send()
            .await
    } else {
        request
            .form(&[
                ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
                ("client_id", login.client_id.as_str()),
                ("device_code", login.device.as_str()),
            ])
            .send()
            .await
    }
    .map_err(http_error)?;
    let status = response.status();
    if login.provider == "openai-codex" && matches!(status.as_u16(), 403 | 404) {
        return Ok(None);
    }
    let data: Value = limited_json(response).await?;
    if !status.is_success() {
        return match string(&data, "error") {
            "authorization_pending" => Ok(None),
            "slow_down" => Err(Error::new(4212, "authorization polling slowed")),
            _ => Err(Error::new(
                4211,
                format!("provider sign-in polling failed (HTTP {})", status.as_u16()),
            )),
        };
    }
    let tokens = if login.provider == "openai-codex" {
        let code = string(&data, "authorization_code");
        let verifier = string(&data, "code_verifier");
        if code.is_empty() || verifier.is_empty() {
            return Err(Error::new(
                4211,
                "provider authorization response was incomplete",
            ));
        }
        response_json(
            client()?
                .post(format!("{}/oauth/token", login.issuer))
                .form(&[
                    ("grant_type", "authorization_code"),
                    ("code", code),
                    (
                        "redirect_uri",
                        format!("{}/deviceauth/callback", login.issuer).as_str(),
                    ),
                    ("client_id", login.client_id.as_str()),
                    ("code_verifier", verifier),
                ])
                .send()
                .await
                .map_err(http_error)?,
        )
        .await?
    } else {
        data
    };
    if string(&tokens, "access_token").is_empty() {
        return Err(Error::new(4211, "provider did not return an access token"));
    }
    if login.provider == "nous" {
        validate_nous(&tokens)?;
    }
    Ok(Some(tokens))
}
fn save_tokens(home: &Path, login: &Login, tokens: &Value) -> Result<()> {
    let _lock = credentials_lock()
        .lock()
        .map_err(|_| Error::new(5200, "credentials lock unavailable"))?;
    let mut disabled = read_json(&home.join("providers-disabled.json"))?;
    if disabled[format!("__epoch_{}", login.provider)]
        .as_u64()
        .unwrap_or(0)
        != login.epoch
    {
        return Err(Error::new(
            4211,
            "Provider was disconnected during sign-in.",
        ));
    }
    let mut store = read_json(&home.join("auth.json"))?;
    if !store["providers"].is_object() {
        store["providers"] = json!({})
    }
    let mut tokens = tokens.clone();
    let now = common::now();
    tokens["expires_at"] = json!(now + tokens["expires_in"].as_f64().unwrap_or(3600.0));
    let state = if login.provider == "nous" {
        tokens["portal_base_url"] = json!(login.issuer);
        tokens["inference_base_url"] = json!("https://inference-api.nousresearch.com/v1");
        tokens["client_id"] = json!(login.client_id);
        tokens["scope"] = json!("inference:invoke");
        tokens
    } else {
        json!({"tokens":tokens})
    };
    store["providers"][&login.provider] = state;
    write_json(&home.join("auth.json"), &store)?;
    disabled[&login.provider] = json!(false);
    write_json(&home.join("providers-disabled.json"), &disabled)
}
pub async fn call(home: &Path, caller: &str, method: &str, p: &Value) -> Option<Result<Value>> {
    if !matches!(
        method,
        "hexbot.providers.list"
            | "hexbot.providers.set_key"
            | "hexbot.providers.clear_key"
            | "hexbot.providers.login_start"
            | "hexbot.providers.login_poll"
            | "hexbot.providers.login_cancel"
            | "hexbot.models.list"
            | "model.options"
            | "model.save_key"
            | "model.disconnect"
    ) {
        return None;
    }
    Some(async {
  common::user(home,caller)?;
  if !matches!(method,"hexbot.providers.list"|"hexbot.models.list"|"model.options"){common::admin(home,caller)?;}
  match method {
   "hexbot.providers.list"=>list_providers(home),
   "hexbot.providers.set_key"=>set_key(home,common::required(p,"provider")?,common::required(p,"key")?),
   "hexbot.providers.clear_key"=>clear_key(home,common::required(p,"provider")?),
   "hexbot.providers.login_start"=>login_start(home,caller,common::required(p,"provider")?).await,
   "hexbot.providers.login_poll"|"hexbot.providers.login_cancel"=>login_poll(home,caller,common::required(p,"login_id")?,method.ends_with("cancel")).await,
   "hexbot.models.list"=>list_models(home,p).await,
   "model.options"=>model_options(home,p).await,
   "model.save_key"=>{let slug=canonical_provider(common::required(p,"slug")?);set_key(home,&slug,common::required(p,"api_key")?)?;let options=model_options(home,&json!({})).await?;Ok(json!({"provider":options["providers"].as_array().unwrap().iter().find(|row|row["slug"]==slug)}))},
   "model.disconnect"=>{let slug=canonical_provider(common::required(p,"slug")?);clear_key(home,&slug)?;Ok(json!({"slug":slug,"name":profile(&slug)?["display_name"],"disconnected":true}))},
   _=>unreachable!()
  }
 }.await)
}

fn expires_at(tokens: &Value) -> f64 {
    tokens["expiry_date"]
        .as_f64()
        .map(|v| v / 1000.0)
        .or_else(|| tokens["expires_at"].as_f64())
        .or_else(|| {
            tokens["expires_at"]
                .as_str()
                .and_then(|v| chrono::DateTime::parse_from_rfc3339(v).ok())
                .map(|v| v.timestamp() as f64)
        })
        .or_else(|| jwt_claims(string(tokens, "access_token")).and_then(|v| v["exp"].as_f64()))
        .unwrap_or(0.0)
}
fn validate_nous(tokens: &Value) -> Result<()> {
    let claims = jwt_claims(string(tokens, "access_token")).ok_or_else(|| {
        Error::new(
            4211,
            "Nous Portal did not return an inference JWT. Sign in again.",
        )
    })?;
    let scopes = format!(
        "{} {} {}",
        string(tokens, "scope"),
        string(&claims, "scope"),
        string(&claims, "scp")
    );
    let array_scope = claims["scp"]
        .as_array()
        .is_some_and(|a| a.iter().any(|v| v == "inference:invoke"));
    if !array_scope
        && !scopes
            .split(|c: char| c.is_whitespace() || c == ',')
            .any(|s| s == "inference:invoke")
    {
        return Err(Error::new(
            4211,
            "Nous Portal grant has no inference:invoke scope. Sign in again.",
        ));
    }
    if expires_at(tokens) <= common::now() + 30.0 {
        return Err(Error::new(
            4211,
            "Nous Portal inference token has expired. Sign in again.",
        ));
    }
    Ok(())
}
fn import_qwen(home: &Path) -> Result<Value> {
    let cfg = common::read_config(home)?;
    let path = if let Some(path) = cfg["provider_auth"]["qwen-oauth"]["auth_file"].as_str() {
        PathBuf::from(path)
    } else {
        let Some(user_home) = std::env::var_os("HOME") else {
            return Ok(Value::Null);
        };
        PathBuf::from(user_home).join(".qwen/oauth_creds.json")
    };
    if path.exists() {
        read_json(&path)
    } else {
        Ok(Value::Null)
    }
}
/// Resolve OAuth at the HTTP boundary, including long-running sessions. Returned headers
/// belong only on the private Pi bridge and must never be published as client events.
pub async fn request_auth(home: &Path, bot: &str, provider: &str) -> Result<Value> {
    common::identifier(bot)?;
    let slug = canonical_provider(provider);
    if !matches!(
        slug.as_str(),
        "nous" | "qwen-oauth" | "minimax-oauth" | "xai-oauth" | "openai-codex" | "anthropic"
    ) {
        return Ok(json!({"headers":{}}));
    }
    static REFRESH: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _refresh = REFRESH.lock().await;
    let disabled = read_json(&home.join("providers-disabled.json"))?;
    if disabled[&slug] == true {
        return Err(Error::new(
            4211,
            format!("{slug} is disconnected. Sign in again."),
        ));
    }
    let epoch = disabled[format!("__epoch_{slug}")].as_u64().unwrap_or(0);
    let profile_home = home.join("profiles").join(bot);
    let p = profile(&slug)?;
    let root_cfg = common::read_config(home)?;
    let profile_cfg = common::read_config(&profile_home)?;
    let inline = [&profile_cfg, &root_cfg].into_iter().find_map(|cfg| {
        if canonical_provider(string(&cfg["model"], "provider")) == slug {
            cfg["model"]["api_key"]
                .as_str()
                .filter(|k| !k.is_empty())
                .map(str::to_owned)
        } else {
            None
        }
    });
    if let Some(key) = inline.or(key(&profile_home, p)?).or(key(home, p)?) {
        return Ok(if slug == "anthropic" {
            json!({"headers":{"x-api-key":key,"authorization":null}})
        } else {
            json!({"headers":{"authorization":format!("Bearer {key}")}})
        });
    }
    let profile_state = oauth(&profile_home, &slug)?;
    let credential_home = if !string(&profile_state, "access_token").is_empty()
        || profile_state["tokens"].is_object()
    {
        profile_home.as_path()
    } else {
        home
    };
    let mut state = oauth(credential_home, &slug)?;
    if slug == "qwen-oauth" && string(&state, "access_token").is_empty() {
        state = import_qwen(home)?;
    }
    let mut tokens = if state["tokens"].is_object() {
        state["tokens"].clone()
    } else {
        state.clone()
    };
    if !tokens.is_object() {
        return Err(Error::new(
            4211,
            format!("No {slug} credentials are available. Sign in again."),
        ));
    }
    let shared_path = daemon_oauth(&slug).then(|| shared_grant_path(home, &slug, &tokens));
    if let Some(path) = &shared_path {
        let shared = read_json(path)?;
        if shared["access_token"].is_string() {
            tokens = shared;
        }
    }
    let should_refresh = expires_at(&tokens) <= common::now() + 120.0
        || (slug == "nous" && validate_nous(&tokens).is_err());
    if should_refresh {
        let refresh = string(&tokens, "refresh_token");
        if refresh.is_empty() {
            return Err(Error::new(
                4211,
                format!("{slug} has expired and has no refresh token. Sign in again."),
            ));
        }
        let (default, path, default_client) = match slug.as_str() {
            "openai-codex" => (
                "https://auth.openai.com",
                "/oauth/token",
                "app_EMoamEEZ73f0CkXaXp7hrann",
            ),
            "anthropic" => (
                "https://platform.claude.com",
                "/v1/oauth/token",
                "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
            ),
            "nous" => (
                "https://portal.nousresearch.com",
                "/api/oauth/token",
                "hermes-cli",
            ),
            "xai-oauth" => (
                "https://auth.x.ai",
                "/oauth2/token",
                "b1a00492-073a-47ea-816f-4c329264a828",
            ),
            "qwen-oauth" => (
                "https://chat.qwen.ai",
                "/api/v1/oauth2/token",
                "f0304373b74a44d2b584a3fb70ca9e56",
            ),
            _ => (
                "https://api.minimax.io",
                "/oauth/token",
                "78257093-7e40-4613-99e0-527b14b39113",
            ),
        };
        let stored = string(&state, "portal_base_url");
        let stored_allowed = url::Url::parse(stored)
            .ok()
            .is_some_and(|url| match slug.as_str() {
                "nous" => matches!(
                    url.host_str(),
                    Some("portal.nousresearch.com" | "localhost" | "127.0.0.1")
                ),
                "minimax-oauth" => {
                    matches!(url.host_str(), Some("api.minimax.io" | "api.minimaxi.com"))
                }
                _ => false,
            });
        let default = if stored_allowed { stored } else { default };
        let issuer = endpoint(home, &slug, default)?;
        let id = state["client_id"]
            .as_str()
            .filter(|s| !s.is_empty())
            .unwrap_or(default_client);
        let request = client()?.post(format!("{issuer}{path}"));
        let request = if slug == "anthropic" {
            request
                .json(&json!({"grant_type":"refresh_token","client_id":id,"refresh_token":refresh}))
        } else {
            request.form(&[
                ("grant_type", "refresh_token"),
                ("client_id", id),
                ("refresh_token", refresh),
            ])
        };
        let response = request.send().await.map_err(http_error)?;
        let response = response_json(response).await?;
        if string(&response, "access_token").is_empty()
            || (slug == "minimax-oauth" && response["status"] != "success")
        {
            return Err(Error::new(
                4211,
                format!("{slug} refresh did not return valid credentials. Sign in again."),
            ));
        }
        let now = common::now();
        let expires = if slug == "minimax-oauth" {
            let raw = response["expired_in"]
                .as_f64()
                .ok_or_else(|| Error::new(4211, "MiniMax refresh response is missing expiry"))?;
            if raw > 100_000_000_000.0 {
                raw / 1000.0
            } else {
                now + raw.max(1.0)
            }
        } else {
            now + response["expires_in"].as_f64().unwrap_or(21600.0).max(1.0)
        };
        tokens["access_token"] = response["access_token"].clone();
        if !string(&response, "refresh_token").is_empty() {
            tokens["refresh_token"] = response["refresh_token"].clone()
        }
        if response["scope"].is_string() {
            tokens["scope"] = response["scope"].clone()
        }
        tokens["expires_at"] = json!(
            chrono::DateTime::from_timestamp(expires as i64, 0)
                .ok_or_else(|| Error::new(4211, "invalid token expiry"))?
                .to_rfc3339()
        );
        if slug == "qwen-oauth" {
            tokens["expiry_date"] = json!((expires * 1000.0) as u64)
        }
    }
    let access = string(&tokens, "access_token");
    if access.is_empty() {
        return Err(Error::new(
            4211,
            format!("{slug} has no access token. Sign in again."),
        ));
    }
    {
        let _lock = credentials_lock()
            .lock()
            .map_err(|_| Error::new(5200, "credentials lock unavailable"))?;
        let disabled = read_json(&home.join("providers-disabled.json"))?;
        if disabled[&slug] == true
            || disabled[format!("__epoch_{slug}")].as_u64().unwrap_or(0) != epoch
        {
            return Err(Error::new(
                4211,
                "Provider was disconnected during token refresh.",
            ));
        }
        if let Some(path) = &shared_path {
            write_json(path, &tokens)?;
        } else {
            let mut auth = read_json(&credential_home.join("auth.json"))?;
            if !auth["providers"].is_object() {
                auth["providers"] = json!({})
            }
            if state["tokens"].is_object() {
                state["tokens"] = tokens.clone();
                auth["providers"][&slug] = state
            } else {
                auth["providers"][&slug] = tokens.clone()
            }
            write_json(&credential_home.join("auth.json"), &auth)?;
        }
    }
    // Persist rotated refresh tokens before validation, because an upstream rotation is irreversible.
    if slug == "nous" {
        validate_nous(&tokens)?
    }
    Ok(json!({"headers":{"authorization":format!("Bearer {access}"),"x-api-key":null}}))
}

pub fn selection_warning(model: &Value) -> Option<String> {
    let id = string(model, "id");
    let lower = id.trim().to_lowercase();
    let mut warnings = vec![];
    let input = model["cost"]["input"].as_f64();
    let output = model["cost"]["output"].as_f64();
    if input.is_some_and(|v| v > 20.0)
        || output.is_some_and(|v| v > 100.0)
        || lower == "openai/gpt-5.5-pro"
    {
        let cost = |value: Option<f64>| {
            value
                .map(|v| format!("${v:.2}/M"))
                .unwrap_or_else(|| "unknown".to_owned())
        };
        let mut message = format!(
            "{id} exceeds the model cost threshold of $20/M input or $100/M output. Input: {}. Output: {}. Confirm only if you intend to use this model.",
            cost(input),
            cost(output)
        );
        if lower == "openai/gpt-5.5-pro" {
            message.push_str(" Did you mean to select openai/gpt-5.5?");
        }
        warnings.push(message);
    }
    if lower.ends_with("-contributor") || lower.split('-').any(|part| part == "contributor") {
        warnings.push(format!("{id} is a contributor tier that permits training on your prompts and completions. Confirm only if this data use is acceptable. Select the standard model to avoid this tier. Source: https://dev.meta.ai/docs/pricing-rate-limits/"));
    }
    if warnings.is_empty() {
        None
    } else {
        Some(warnings.join("\n\n"))
    }
}

pub async fn xai_credentials(home: &Path, bot: &str) -> Result<Value> {
    common::identifier(bot)?;
    let profile_home = home.join("profiles").join(bot);
    let root_env = common::env_values(home)?;
    let profile_env = common::env_values(&profile_home)?;
    let base = profile_env
        .get("HERMES_XAI_BASE_URL")
        .or_else(|| profile_env.get("XAI_BASE_URL"))
        .or_else(|| root_env.get("HERMES_XAI_BASE_URL"))
        .or_else(|| root_env.get("XAI_BASE_URL"))
        .cloned()
        .or_else(|| std::env::var("XAI_BASE_URL").ok())
        .unwrap_or_else(|| "https://api.x.ai/v1".to_owned());
    let disabled = read_json(&home.join("providers-disabled.json"))?;
    if disabled["xai"] != true
        && let Some(api_key) = key(&profile_home, profile("xai")?)?.or(key(home, profile("xai")?)?)
    {
        return Ok(json!({"api_key":api_key,"base_url":base,"provider":"xai"}));
    }
    let headers = request_auth(home, bot, "xai-oauth").await?;
    let token = string(&headers["headers"], "authorization")
        .strip_prefix("Bearer ")
        .ok_or_else(|| Error::new(4211, "xAI credentials are unavailable"))?;
    Ok(json!({"api_key":token,"base_url":base,"provider":"xai-oauth"}))
}

/// Apply Hermes provider wire rules to the outgoing copy. Stored conversation messages
/// and the system-prompt/tool prefix remain unchanged.
pub fn adapt_request(home: &Path, bot: &str, session: &str, p: &Value) -> Result<Value> {
    common::identifier(bot)?;
    let provider = canonical_provider(string(p, "provider"));
    let model = string(p, "model").to_lowercase();
    let mut payload = p["payload"].clone();
    if !payload.is_object() {
        return Err(Error::new(
            4200,
            "provider request payload must be an object",
        ));
    }
    let root = common::read_config(home)?;
    let profile_cfg = common::read_config(&home.join("profiles").join(bot))?;
    let base = profile_cfg["model"]["base_url"]
        .as_str()
        .or_else(|| root["model"]["base_url"].as_str())
        .unwrap_or("");
    let effort = p["thinking"]
        .as_str()
        .filter(|s| !s.is_empty())
        .or_else(|| payload["reasoning_effort"].as_str())
        .map(str::to_lowercase);
    let off = effort
        .as_deref()
        .is_some_and(|s| matches!(s, "off" | "none" | "false"));
    let effort = effort.as_deref().map(|s| match s {
        "xhigh" | "ultra" => "max",
        "minimal" => "low",
        other => other,
    });
    let object = payload.as_object_mut().unwrap();
    match provider.as_str() {
        "qwen-oauth" => {
            object.insert("vl_high_resolution_images".into(), json!(true));
            if let Some(messages) = object.get_mut("messages").and_then(Value::as_array_mut) {
                let mut marked = false;
                for message in messages {
                    if let Some(text) = message["content"].as_str() {
                        message["content"] = json!([{"type":"text","text":text}]);
                    }
                    if let Some(parts) = message["content"].as_array_mut() {
                        for part in parts {
                            if let Some(text) = part.as_str() {
                                *part = json!({"type":"text","text":text});
                            }
                        }
                    }
                    if !marked && message["role"] == "system" {
                        if let Some(last) = message["content"]
                            .as_array_mut()
                            .and_then(|a| a.last_mut())
                            .filter(|v| v.is_object())
                        {
                            last["cache_control"] = json!({"type":"ephemeral"});
                        }
                        marked = true;
                    }
                }
            }
        }
        "nous" | "openrouter" => {
            object.insert("session_id".into(), json!(session));
            if provider == "nous" {
                object.insert(
                    "tags".into(),
                    json!(["product=hexbot", format!("conversation={session}")]),
                );
            }
            let prefs = profile_cfg
                .get("provider_preferences")
                .or_else(|| root.get("provider_preferences"));
            if let Some(prefs) = prefs.filter(|v| v.is_object()) {
                object.insert("provider".into(), prefs.clone());
            }
            if provider == "nous" && off {
                object.remove("reasoning");
                object.remove("reasoning_effort");
            }
        }
        "kimi-coding" | "kimi-coding-cn" => {
            object.remove("temperature");
            object.remove("thinking");
            object.remove("reasoning_effort");
            if off {
                object.insert("thinking".into(), json!({"type":"disabled"}));
            } else if let Some(effort) =
                effort.filter(|e| matches!(*e, "low" | "medium" | "high" | "max"))
            {
                object.insert(
                    "reasoning_effort".into(),
                    json!(if effort == "medium" { "high" } else { effort }),
                );
            } else {
                object.insert("thinking".into(), json!({"type":"enabled"}));
            }
        }
        "deepseek" if model.starts_with("deepseek-v") && !model.starts_with("deepseek-v3") => {
            object.insert(
                "thinking".into(),
                json!({"type":if off{"disabled"}else{"enabled"}}),
            );
            object.remove("reasoning_effort");
            if !off
                && let Some(effort) =
                    effort.filter(|e| matches!(*e, "low" | "medium" | "high" | "max"))
            {
                object.insert("reasoning_effort".into(), json!(effort));
            }
        }
        "zai"
            if (model.starts_with("glm-5")
                || model.starts_with("glm-4.5")
                || model.starts_with("glm-4.6")
                || model.starts_with("glm-4.7"))
                && effort.is_some() =>
        {
            object.insert(
                "thinking".into(),
                json!({"type":if off{"disabled"}else{"enabled"}}),
            );
            object.remove("reasoning_effort");
            if !off
                && (model.contains("5.2")
                    || model.contains("5.3")
                    || model.contains("5-2")
                    || model.contains("5-3")
                    || model.contains("5p2")
                    || model.contains("5p3"))
            {
                let mut effort = effort.unwrap_or("high");
                if model.contains("5.2") && effort != "max" {
                    effort = "high"
                }
                if matches!(effort, "low" | "medium" | "high" | "max") {
                    object.insert("reasoning_effort".into(), json!(effort));
                }
            }
        }
        "minimax" | "minimax-cn" | "minimax-oauth"
            if matches!(model.as_str(), "minimax-m3" | "minimax/minimax-m3")
                && base.trim_end_matches('/') == "https://api.minimax.io/v1" =>
        {
            object.insert("reasoning_split".into(), json!(true));
            object.remove("reasoning_effort");
            if effort.is_some() {
                object.insert(
                    "thinking".into(),
                    json!({"type":if off{"disabled"}else{"adaptive"}}),
                );
            }
        }
        "custom" => {
            if let Some(context) = profile_cfg["model"]["context_length"]
                .as_u64()
                .or_else(|| root["model"]["context_length"].as_u64())
            {
                object.entry("options").or_insert_with(|| json!({}))["num_ctx"] = json!(context);
            }
            if off {
                object.insert("reasoning_effort".into(), json!("none"));
                if url::Url::parse(base).ok().is_some_and(|u| {
                    u.port() == Some(11434)
                        || u.host_str().is_some_and(|h| {
                            h == "ollama.com"
                                || h.ends_with(".ollama.com")
                                || h.split('.').any(|p| p == "ollama")
                        })
                }) {
                    object.insert("think".into(), json!(false));
                }
            } else if let Some(effort) = effort {
                object.insert("reasoning_effort".into(), json!(effort));
            }
        }
        _ => {}
    }
    Ok(payload)
}

pub fn xai_configured(home: &Path, bot: &str) -> Result<bool> {
    common::identifier(bot)?;
    let profile_home = home.join("profiles").join(bot);
    let disabled = read_json(&home.join("providers-disabled.json"))?;
    if disabled["xai"] != true
        && (key(&profile_home, profile("xai")?)?.is_some() || key(home, profile("xai")?)?.is_some())
    {
        return Ok(true);
    }
    if disabled["xai-oauth"] == true {
        return Ok(false);
    }
    for path in [&profile_home, home] {
        let state = oauth(path, "xai-oauth")?;
        let tokens = if state["tokens"].is_object() {
            &state["tokens"]
        } else {
            &state
        };
        if !string(tokens, "access_token").is_empty() || !string(tokens, "refresh_token").is_empty()
        {
            return Ok(true);
        }
    }
    let pi = read_json(&profile_home.join("pi/auth.json"))?;
    Ok(pi["xai"]["type"] == "oauth" && pi["xai"]["access"].as_str().is_some_and(|s| !s.is_empty()))
}

#[cfg(test)]
mod migration_tests {
    use super::*;
    #[test]
    fn reads_credential_pool_and_hexbot_anthropic_login_without_changing_imports() {
        let home = tempfile::tempdir().unwrap();
        let original = json!({"credential_pool":{"test":[{"auth_type":"api_key","access_token":"pooled-key","priority":0}],"anthropic":[{"auth_type":"oauth","access_token":"sk-ant-oat-pool","refresh_token":"refresh","expires_at_ms":999000}]}}).to_string();
        fs::write(home.path().join("auth.json"), &original).unwrap();
        assert_eq!(
            key(
                home.path(),
                &json!({"name":"test","env_vars":["HEXBOT_W3_TEST_KEY"]})
            )
            .unwrap()
            .as_deref(),
            Some("pooled-key")
        );
        assert_eq!(
            oauth(home.path(), "anthropic").unwrap()["expires_at"],
            999.0
        );
        assert_eq!(
            fs::read_to_string(home.path().join("auth.json")).unwrap(),
            original
        );
        fs::write(home.path().join(".env"), "HEXBOT_W3_TEST_KEY=explicit\n").unwrap();
        assert_eq!(
            key(
                home.path(),
                &json!({"name":"test","env_vars":["HEXBOT_W3_TEST_KEY"]})
            )
            .unwrap()
            .as_deref(),
            Some("explicit")
        );
        fs::write(home.path().join("auth.json"), "{}").unwrap();
        let login = json!({"accessToken":"sk-ant-oat-login","refreshToken":"login-refresh","expiresAt":1234000});
        write_json(&home.path().join(".anthropic_oauth.json"), &login).unwrap();
        assert_eq!(
            oauth(home.path(), "anthropic").unwrap()["access_token"],
            "sk-ant-oat-login"
        );
        assert_eq!(
            read_json(&home.path().join(".anthropic_oauth.json")).unwrap(),
            login
        );
    }
    #[cfg(unix)]
    #[test]
    fn github_cli_fallback_reads_only_a_successful_supported_token() {
        use std::os::unix::fs::PermissionsExt;
        let home = tempfile::tempdir().unwrap();
        let program = home.path().join("gh");
        for (script, expected) in [
            (
                "#!/bin/sh\n[ \"$1 $2\" = 'auth token' ] || exit 1\nprintf 'ghu_test\\n'",
                Some("ghu_test"),
            ),
            ("#!/bin/sh\nprintf ghp_unsupported", None),
            ("#!/bin/sh\nprintf ghu_test; exit 1", None),
        ] {
            fs::write(&program, script).unwrap();
            fs::set_permissions(&program, fs::Permissions::from_mode(0o700)).unwrap();
            assert_eq!(github_cli_token(&program).as_deref(), expected);
        }
    }
    #[tokio::test]
    async fn bots_share_rotating_oauth_tokens_and_never_receive_refresh_tokens() {
        use std::sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        };
        let home = tempfile::tempdir().unwrap();
        crate::db::migrate(home.path()).unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let issuer = format!("http://{}", listener.local_addr().unwrap());
        let count = Arc::new(AtomicUsize::new(0));
        let calls = count.clone();
        let app = axum::Router::new().route("/oauth/token", axum::routing::post(move |body: String| {
            let calls = calls.clone();
            async move {
                let n = calls.fetch_add(1, Ordering::SeqCst);
                assert!(body.contains(if n == 0 { "refresh_token=original" } else { "refresh_token=rotated-1" }), "{body}");
                axum::Json(json!({"access_token":format!("access-{}", n+1),"refresh_token":format!("rotated-{}",n+1),"expires_in":3600}))
            }
        }));
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        common::write_config(
            home.path(),
            &json!({"provider_auth":{"openai-codex":{"issuer":issuer}}}),
        )
        .unwrap();
        let tokens = json!({"access_token":"expired","refresh_token":"original","expires_at":1});
        let original = json!({"providers":{"openai-codex":tokens}}).to_string();
        fs::write(home.path().join("auth.json"), &original).unwrap();
        for bot in ["owl", "fox"] {
            fs::create_dir_all(home.path().join("profiles").join(bot)).unwrap();
            fs::write(
                home.path().join("profiles").join(bot).join("auth.json"),
                &original,
            )
            .unwrap();
        }
        let (a, b) = tokio::join!(
            request_auth(home.path(), "owl", "openai-codex"),
            request_auth(home.path(), "fox", "openai-codex")
        );
        assert_eq!(a.unwrap()["headers"]["authorization"], "Bearer access-1");
        assert_eq!(b.unwrap()["headers"]["authorization"], "Bearer access-1");
        assert_eq!(count.load(Ordering::SeqCst), 1);
        let path = shared_grant_path(home.path(), "openai-codex", &tokens);
        let mut shared = read_json(&path).unwrap();
        assert_eq!(shared["refresh_token"], "rotated-1");
        shared["expires_at"] = json!(0);
        write_json(&path, &shared).unwrap();
        let short_lived = home.path().join("profiles/owl/pi");
        prepare_pi_for_request(home.path(), "owl", &short_lived, Some("codex"))
            .await
            .unwrap();
        assert_eq!(
            read_json(&short_lived.join("auth.json")).unwrap()["openai-codex"]["access"],
            "access-2"
        );
        assert_eq!(
            request_auth(home.path(), "fox", "openai-codex")
                .await
                .unwrap()["headers"]["authorization"],
            "Bearer access-2"
        );
        assert_eq!(count.load(Ordering::SeqCst), 2);
        for bot in ["owl", "fox"] {
            let dir = home.path().join("profiles").join(bot).join("pi");
            prepare_pi_for_bot(home.path(), bot, &dir).unwrap();
            let exported = read_json(&dir.join("auth.json")).unwrap();
            assert_eq!(exported["openai-codex"]["refresh"], "");
            assert_eq!(exported["openai-codex"]["access"], "access-2");
            assert_eq!(
                fs::read_to_string(home.path().join("profiles").join(bot).join("auth.json"))
                    .unwrap(),
                original
            );
        }
        assert_eq!(
            fs::read_to_string(home.path().join("auth.json")).unwrap(),
            original
        );
        server.abort();
    }
}
