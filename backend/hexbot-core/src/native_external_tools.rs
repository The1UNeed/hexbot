//! HTTP tools used by the Hexbot connector catalog. No legacy daemon dependency.
use crate::{Error, Result, common, connectors};
use serde_json::{Value, json};
use std::{collections::BTreeMap, path::Path, time::Duration};

fn config(home: &Path, bot: &str, section: &str) -> Result<Value> {
    let mut value = common::read_config(home)?[section].clone();
    let local = common::read_config(&home.join("profiles").join(bot))?[section].clone();
    if let Some(local) = local.as_object() {
        if !value.is_object() {
            value = json!({});
        }
        for (k, v) in local {
            value[k] = v.clone();
        }
    }
    Ok(value)
}
fn client(seconds: u64) -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(seconds))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| Error::new(5200, e.to_string()))
}
async fn response(request: reqwest::RequestBuilder) -> Result<Value> {
    let response = request
        .send()
        .await
        .map_err(|_| Error::new(5200, "Tool provider request failed"))?;
    decode_response(response).await
}
async fn decode_response(mut response: reqwest::Response) -> Result<Value> {
    if !response.status().is_success() {
        return Err(Error::new(
            5200,
            format!("Tool provider returned HTTP {}", response.status().as_u16()),
        ));
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| Error::new(5200, "Tool provider response interrupted"))?
    {
        if body.len() + chunk.len() > 16 * 1024 * 1024 {
            return Err(Error::new(5200, "Tool provider response exceeds 16 MiB"));
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body)
        .map_err(|_| Error::new(5200, "Tool provider returned invalid JSON"))
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
    let schemas: Vec<Value> =
        serde_json::from_str(include_str!("external_tool_schemas.json")).expect("tool schemas");
    let mut output = vec![];
    for mut schema in schemas {
        let name = schema["name"].as_str().unwrap();
        if !connectors::tool_available(home, bot, name)? {
            continue;
        }
        if name == "video_generate" {
            schema["description"] = json!(
                "Generate a video from a prompt or animate an image using the configured video provider. Returns a video URL. Generation may take several minutes."
            );
            for (key, kind) in [
                ("image_url", "string"),
                ("negative_prompt", "string"),
                ("audio", "boolean"),
                ("seed", "integer"),
                ("upscale", "boolean"),
            ] {
                schema["parameters"]["properties"][key] = json!({"type":kind});
            }
        }
        output.push(schema);
    }
    Ok(output)
}
pub async fn call(
    home: &Path,
    owner: &str,
    bot: &str,
    stored: &str,
    name: &str,
    args: Value,
) -> Option<Result<Value>> {
    if !matches!(
        name,
        "x_search"
            | "ha_list_entities"
            | "ha_get_state"
            | "ha_list_services"
            | "ha_call_service"
            | "video_generate"
    ) {
        return None;
    }
    Some(
        async {
            common::bot_session_access(home, owner, bot, stored)?;
            if !connectors::tool_available(home, bot, name)? {
                return Err(Error::new(4302, "Tool is disabled or unconfigured"));
            }
            let env = connectors::credentials(home, bot)?;
            match name {
                "x_search" => x_search(home, bot, &env, &args).await,
                "video_generate" => video(home, bot, &env, &args).await,
                _ => home_assistant(&env, name, &args).await,
            }
        }
        .await,
    )
}
fn service_name(s: &str) -> bool {
    s.as_bytes().first().is_some_and(u8::is_ascii_lowercase)
        && s.bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_')
}
fn entity(s: &str) -> bool {
    s.split_once('.').is_some_and(|(d, n)| {
        !n.is_empty()
            && (service_name(d)
                || d.starts_with('_')
                    && d.bytes()
                        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_'))
            && n.bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_')
    })
}
async fn home_assistant(env: &BTreeMap<String, String>, name: &str, p: &Value) -> Result<Value> {
    let key = credential(env, "HASS_TOKEN")?;
    let base = env
        .get("HASS_URL")
        .map(String::as_str)
        .unwrap_or("http://homeassistant.local:8123")
        .trim_end_matches('/');
    let client = client(15)?;
    let domain = string(p, "domain", "");
    let result = match name {
        "ha_get_state" => {
            let id = common::required(p, "entity_id")?;
            if !entity(id) {
                return Err(Error::new(4200, "Invalid entity_id"));
            }
            response(
                client
                    .get(format!("{base}/api/states/{id}"))
                    .bearer_auth(key),
            )
            .await?
        }
        "ha_list_entities" => {
            let states =
                response(client.get(format!("{base}/api/states")).bearer_auth(key)).await?;
            let area = string(p, "area", "").to_lowercase();
            let entities=states.as_array().ok_or_else(||Error::new(5200,"Home Assistant returned invalid states"))?.iter().filter(|s|(domain.is_empty()||string(s,"entity_id","").starts_with(&format!("{domain}.")))&&(area.is_empty()||string(&s["attributes"],"friendly_name","").to_lowercase().contains(&area)||string(&s["attributes"],"area","").to_lowercase().contains(&area))).map(|s|json!({"entity_id":s["entity_id"],"state":s["state"],"friendly_name":string(&s["attributes"],"friendly_name","")})).collect::<Vec<_>>();
            json!({"count":entities.len(),"entities":entities})
        }
        "ha_list_services" => {
            let services =
                response(client.get(format!("{base}/api/services")).bearer_auth(key)).await?;
            let mut domains = vec![];
            for d in services
                .as_array()
                .ok_or_else(|| Error::new(5200, "Home Assistant returned invalid services"))?
            {
                if !domain.is_empty() && d["domain"] != domain {
                    continue;
                }
                let mut entries = json!({});
                if let Some(map) = d["services"].as_object() {
                    for (name, info) in map {
                        let mut entry = json!({"description":string(info,"description","")});
                        if let Some(fields) = info["fields"].as_object().filter(|f| !f.is_empty()) {
                            entry["fields"] = json!({});
                            for (k, v) in fields {
                                if v.is_object() {
                                    entry["fields"][k] = json!(string(v, "description", ""));
                                }
                            }
                        }
                        entries[name] = entry;
                    }
                }
                domains.push(json!({"domain":d["domain"],"services":entries}));
            }
            json!({"count":domains.len(),"domains":domains})
        }
        "ha_call_service" => {
            let service = common::required(p, "service")?;
            if !service_name(domain) || !service_name(service) {
                return Err(Error::new(4200, "Invalid service or domain"));
            }
            if [
                "shell_command",
                "command_line",
                "python_script",
                "pyscript",
                "hassio",
                "rest_command",
            ]
            .contains(&domain)
            {
                return Err(Error::new(4302, "Home Assistant service domain is blocked"));
            }
            let mut data = p
                .get("data")
                .filter(|v| !v.is_null())
                .cloned()
                .unwrap_or_else(|| json!({}));
            if let Some(encoded) = data.as_str() {
                data = if encoded.trim().is_empty() {
                    json!({})
                } else {
                    serde_json::from_str(encoded)
                        .map_err(|_| Error::new(4200, "Invalid JSON string in service data"))?
                };
            }
            if !data.is_object() {
                return Err(Error::new(4200, "Service data must be an object"));
            }
            if let Some(id) = p["entity_id"].as_str().filter(|s| !s.is_empty()) {
                if !entity(id) {
                    return Err(Error::new(4200, "Invalid entity_id"));
                }
                data["entity_id"] = json!(id);
            }
            let result = response(
                client
                    .post(format!("{base}/api/services/{domain}/{service}"))
                    .bearer_auth(key)
                    .json(&data),
            )
            .await?;
            let affected = result
                .as_array()
                .map(|a| {
                    a.iter()
                        .map(|s| json!({"entity_id":s["entity_id"],"state":s["state"]}))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            json!({"success":true,"service":format!("{domain}.{service}"),"affected_entities":affected})
        }
        _ => unreachable!(),
    };
    Ok(json!({"result":result}))
}
async fn x_search(
    home: &Path,
    bot: &str,
    _env: &BTreeMap<String, String>,
    p: &Value,
) -> Result<Value> {
    let query = common::required(p, "query")?.trim();
    if query.is_empty() {
        return Err(Error::new(4200, "query is required"));
    }
    let cfg = config(home, bot, "x_search")?;
    let mut search = json!({"type":"x_search"});
    let mut filters = vec![];
    for field in ["allowed_x_handles", "excluded_x_handles"] {
        if let Some(values) = p.get(field).filter(|v| !v.is_null()) {
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
                search[field] = json!(handles);
                filters.push(field);
            }
        }
    }
    if search.get("allowed_x_handles").is_some() && search.get("excluded_x_handles").is_some() {
        return Err(Error::new(
            4200,
            "Allowed and excluded handles cannot be combined",
        ));
    }
    let mut dates = vec![];
    for field in ["from_date", "to_date"] {
        let raw = string(p, field, "").trim();
        if !raw.is_empty() {
            let date = chrono::NaiveDate::parse_from_str(raw, "%Y-%m-%d")
                .map_err(|_| Error::new(4200, "Dates must be YYYY-MM-DD"))?;
            if raw != date.format("%Y-%m-%d").to_string() {
                return Err(Error::new(4200, "Dates must be YYYY-MM-DD"));
            }
            if field == "from_date" && date > chrono::Utc::now().date_naive() {
                return Err(Error::new(4200, "from_date cannot be in the future"));
            }
            search[field] = json!(raw);
            dates.push(date);
            filters.push(field);
        }
    }
    if dates.len() == 2 && dates[0] > dates[1] {
        return Err(Error::new(4200, "from_date must precede to_date"));
    }
    for key in ["enable_image_understanding", "enable_video_understanding"] {
        if p[key] == true {
            search[key] = json!(true);
        }
    }
    let model = string(&cfg, "model", "grok-4.5");
    let mut body = json!({"model":model,"input":[{"role":"user","content":query}],"tools":[search],"store":false});
    if let Some(effort) = cfg["reasoning_effort"].as_str().filter(|s| !s.is_empty()) {
        if !["low", "medium", "high", "xhigh"].contains(&effort) {
            return Err(Error::new(4200, "Invalid X search reasoning effort"));
        }
        body["reasoning"] = json!({"effort":effort});
    }
    let auth = crate::providers::xai_credentials(home, bot).await?;
    let key = common::required(&auth, "api_key")?;
    let base = string(&auth, "base_url", "https://api.x.ai/v1").trim_end_matches('/');
    let client = client(
        cfg["timeout_seconds"]
            .as_u64()
            .unwrap_or(180)
            .clamp(30, 600),
    )?;
    let retries = cfg["retries"].as_u64().unwrap_or(2).min(10);
    let mut attempt = 0;
    let data = loop {
        let sent = client
            .post(format!("{base}/responses"))
            .bearer_auth(key)
            .header("user-agent", "Hexbot Rust X search")
            .json(&body)
            .send()
            .await;
        let retry = match &sent {
            Ok(response) => response.status().is_server_error(),
            Err(error) => error.is_timeout() || error.is_connect(),
        };
        if retry && attempt < retries {
            attempt += 1;
            tokio::time::sleep(Duration::from_millis((1500 * attempt).min(5000))).await;
            continue;
        }
        break decode_response(sent.map_err(|_| Error::new(5200, "Tool provider request failed"))?)
            .await?;
    };
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
    let degraded = !filters.is_empty() && citations.is_empty() && inline.is_empty();
    Ok(
        json!({"success":true,"provider":"xai","credential_source":auth["provider"],"tool":"x_search","model":model,"query":query,"answer":data["output_text"].as_str().map(str::to_owned).unwrap_or_else(||parts.join("\n\n")),"citations":citations,"inline_citations":inline,"degraded":degraded,"degraded_reason":if degraded{Some(format!("no citations returned despite filters: {}",filters.join(", ")))}else{None}}),
    )
}
fn fal_payload(family: &Value, p: &Value) -> Value {
    let mut body = json!({"prompt":p["prompt"]});
    let image = string(p, "image_url", "");
    if !image.is_empty() {
        body[string(family, "image_param_key", "image_url")] = json!(image);
    }
    if family["seed"] != false && !p["seed"].is_null() {
        body["seed"] = p["seed"].clone();
    }
    for (param, list, default) in [
        ("aspect_ratio", "aspect_ratios", "16:9"),
        ("resolution", "resolutions", "720p"),
    ] {
        let mut value = string(p, param, default).to_owned();
        if param == "resolution" {
            value = family["resolution_aliases"][value.to_lowercase()]
                .as_str()
                .unwrap_or(&value)
                .to_owned();
        }
        if family[list]
            .as_array()
            .is_some_and(|a| a.contains(&json!(value)))
        {
            body[param] = json!(value);
        }
    }
    if let Some(duration) = p["duration"].as_i64() {
        let ds = family["durations"]
            .as_array()
            .map(|a| a.iter().filter_map(Value::as_i64).collect::<Vec<_>>())
            .unwrap_or_default();
        if !ds.is_empty() {
            let d = if ds.len() == 2 && ds[1] - ds[0] > 1 {
                duration.clamp(ds[0], ds[1])
            } else {
                *ds.iter().min_by_key(|d| (**d - duration).abs()).unwrap()
            };
            body["duration"] = if family["duration_int"] == true {
                json!(d)
            } else {
                json!(format!("{d}{}", string(family, "duration_suffix", "")))
            };
        }
    }
    if family["audio"] == true && !p["audio"].is_null() {
        body["generate_audio"] = p["audio"].clone();
    }
    if family["negative"] == true && !p["negative_prompt"].is_null() {
        body["negative_prompt"] = p["negative_prompt"].clone();
    }
    if !image.is_empty() {
        for k in family["image_drop_keys"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            body.as_object_mut().unwrap().remove(k);
        }
    }
    if let Some(extra) = family["static_payload"].as_object() {
        for (k, v) in extra {
            body.as_object_mut().unwrap().entry(k).or_insert(v.clone());
        }
    }
    body
}
async fn fal_request(
    client: &reqwest::Client,
    base: &str,
    key: &str,
    endpoint: &str,
    payload: &Value,
) -> Result<Value> {
    let auth = format!("Key {key}");
    let submitted = response(
        client
            .post(format!("{base}/{endpoint}"))
            .header("authorization", &auth)
            .json(payload),
    )
    .await?;
    if submitted.get("video").is_some() {
        return Ok(submitted);
    }
    let id = common::required(&submitted, "request_id")?;
    if !id
        .bytes()
        .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    {
        return Err(Error::new(5200, "Invalid FAL request id"));
    }
    let origin = url::Url::parse(base).map_err(|_| Error::new(4200, "Invalid FAL base URL"))?;
    let fallback = format!("{base}/{endpoint}/requests/{id}");
    let result_url = string(&submitted, "response_url", &fallback);
    let status_fallback = format!("{result_url}/status");
    let status_url = string(&submitted, "status_url", &status_fallback);
    for url in [result_url, status_url] {
        let parsed = url::Url::parse(url).map_err(|_| Error::new(5200, "Invalid FAL queue URL"))?;
        if parsed.origin() != origin.origin()
            || !parsed.username().is_empty()
            || parsed.password().is_some()
        {
            return Err(Error::new(
                5200,
                "FAL queue changed origin or supplied credentials",
            ));
        }
    }
    tokio::time::timeout(Duration::from_secs(900), async {
        loop {
            let status = response(client.get(status_url).header("authorization", &auth)).await?;
            match string(&status, "status", "") {
                "COMPLETED" => {
                    return response(client.get(result_url).header("authorization", &auth)).await;
                }
                "IN_QUEUE" | "IN_PROGRESS" => tokio::time::sleep(Duration::from_secs(1)).await,
                _ => return Err(Error::new(5200, "Video generation failed")),
            }
        }
    })
    .await
    .map_err(|_| Error::new(5200, "Video generation timed out"))?
}
async fn video(home: &Path, bot: &str, env: &BTreeMap<String, String>, p: &Value) -> Result<Value> {
    let prompt = common::required(p, "prompt")?;
    let cfg = config(home, bot, "video_gen")?;
    if p.get("operation").is_some() || p.get("video_url").is_some() {
        return Err(Error::new(
            4200,
            "video_generate does not support edit or extend",
        ));
    }
    let provider = string(&cfg, "provider", "fal");
    if provider != "fal" {
        return Err(Error::new(
            4211,
            format!("Video provider {provider} is not configured through the Hexbot FAL connector"),
        ));
    }
    let catalog: Value = serde_json::from_str(include_str!("fal_video_models.json")).unwrap();
    let model = p["model"]
        .as_str()
        .or_else(|| env.get("FAL_VIDEO_MODEL").map(String::as_str))
        .or(cfg["fal"]["model"].as_str())
        .or(cfg["model"].as_str())
        .unwrap_or("pixverse-v6");
    let (model, family) = catalog
        .as_object()
        .unwrap()
        .iter()
        .find(|(id, f)| {
            id.as_str() == model || f["text_endpoint"] == model || f["image_endpoint"] == model
        })
        .ok_or_else(|| Error::new(4200, "Unknown FAL video model"))?;
    let is_image = !string(p, "image_url", "").is_empty();
    let endpoint = family[if is_image {
        "image_endpoint"
    } else {
        "text_endpoint"
    }]
    .as_str()
    .ok_or_else(|| Error::new(4200, "This model requires an image"))?;
    let key = credential(env, "FAL_KEY")?;
    let base = env
        .get("FAL_QUEUE_URL")
        .map(String::as_str)
        .unwrap_or("https://queue.fal.run")
        .trim_end_matches('/');
    let client = client(180)?;
    let mut data = fal_request(&client, base, &key, endpoint, &fal_payload(family, p)).await?;
    let mut url = data["video"]["url"]
        .as_str()
        .or(data["video"].as_str())
        .ok_or_else(|| Error::new(5200, "FAL returned no video"))?
        .to_owned();
    let mut upscaled = false;
    if p["upscale"] == true
        && let Ok(result) = fal_request(
            &client,
            base,
            &key,
            "fal-ai/seedvr/upscale/video",
            &json!({"video_url":url,"upscale_mode":"factor","upscale_factor":2}),
        )
        .await
        && let Some(next) = result["video"]["url"].as_str()
    {
        url = next.into();
        upscaled = true;
        data = result;
    }
    Ok(
        json!({"success":true,"video":url,"model":model,"prompt":prompt,"modality":if is_image{"image"}else{"text"},"aspect_ratio":string(p,"aspect_ratio","16:9"),"duration":p["duration"].as_i64().unwrap_or(0),"provider":"fal","upscaled":upscaled,"metadata":data}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fal_model_capabilities_preserve_wire_quirks() {
        let models: Value = serde_json::from_str(include_str!("fal_video_models.json")).unwrap();
        let args = json!({"prompt":"A test","duration":99,"resolution":"1080p","aspect_ratio":"16:9","image_url":"https://example.test/image.png","seed":2,"audio":false});
        let body = fal_payload(&models["minimax-h3"], &args);
        assert_eq!(body["duration"], 15);
        assert_eq!(body["resolution"], "2K");
        assert!(body.get("aspect_ratio").is_none());
        assert!(body.get("seed").is_none());
        assert_eq!(fal_payload(&models["veo3.1"], &args)["duration"], "8s");
    }
    #[test]
    fn homeassistant_path_components_reject_traversal() {
        for bad in ["../light", "shell_command/../light", "a%2fb", "A", "x.y"] {
            assert!(!service_name(bad));
        }
        assert!(entity("sensor.temperature_1"));
        assert!(!entity("sensor../config"));
    }
}
