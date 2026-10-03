//! Copilot's stdio ACP transport. Each model call owns a cancellable child session.
use crate::{Error, Result, common};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Mutex, OnceLock},
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{ChildStdin, ChildStdout},
    sync::watch,
};

const MAX_FRAME: usize = 8 * 1024 * 1024;
type Active = HashMap<PathBuf, (String, watch::Sender<bool>)>;
fn active() -> &'static Mutex<Active> {
    static ACTIVE: OnceLock<Mutex<Active>> = OnceLock::new();
    ACTIVE.get_or_init(Default::default)
}
fn failure(message: impl Into<String>) -> Error {
    Error::new(5201, message)
}
fn session_key(home: &Path, stored: &str) -> PathBuf {
    home.join("runtime").join("acp").join(stored)
}
struct Lease {
    key: PathBuf,
    id: String,
}
impl Drop for Lease {
    fn drop(&mut self) {
        if let Ok(mut entries) = active().lock()
            && entries.get(&self.key).is_some_and(|(id, _)| id == &self.id)
        {
            entries.remove(&self.key);
        }
    }
}

pub async fn cancel(home: &Path, stored: &str) {
    if let Ok(entries) = active().lock()
        && let Some((_, sender)) = entries.get(&session_key(home, stored))
    {
        let _ = sender.send(true);
    }
}

/// Copilot only produces text here. Hexbot actions come back as `<tool_call>` text and run
/// through the section's own guarded tools, so Copilot's native tools are never granted and
/// the child never receives daemon or provider secrets.
/// Dropping this future also kills the child; cancellation explicitly sends ACP session/cancel.
pub async fn complete(home: &Path, bot: &str, stored: &str, args: &Value) -> Result<Value> {
    common::identifier(bot)?;
    common::identifier(stored)?;
    let cwd = crate::native_tools::section_workdir(home, bot, stored)?;
    let mut env = common::env_values(home)?;
    env.extend(common::env_values(&home.join("profiles").join(bot))?);
    let value = |name: &str| {
        env.get(name)
            .cloned()
            .or_else(|| std::env::var(name).ok())
            .filter(|v| !v.trim().is_empty())
    };
    let executable = value("HEXBOT_COPILOT_ACP_COMMAND")
        .or_else(|| value("HERMES_COPILOT_ACP_COMMAND"))
        .or_else(|| value("COPILOT_CLI_PATH"))
        .unwrap_or_else(|| "copilot".into());
    let command_args = value("HEXBOT_COPILOT_ACP_ARGS")
        .or_else(|| value("HERMES_COPILOT_ACP_ARGS"))
        .map(|v| split_args(&v))
        .transpose()?
        .unwrap_or_else(|| vec!["--acp".into(), "--stdio".into()]);
    // sandbox-exec and bubblewrap start even when the CLI is missing, so look first.
    // A relative command lives in the workspace, where the child starts.
    let not_started = || {
        failure(format!(
            "Could not start Copilot ACP command '{executable}'. Install GitHub Copilot CLI or configure HEXBOT_COPILOT_ACP_COMMAND."
        ))
    };
    let Some(program) = common::command_path(&executable, &cwd) else {
        return Err(not_started());
    };
    // Copilot's own reads must not reach the daemon's .env, connect.json or auth files,
    // so the child runs in the same sandbox as scripts, with its workspace writable.
    let mut command = crate::credentials::isolated_command(
        home,
        &program.to_string_lossy(),
        std::slice::from_ref(&cwd),
        crate::credentials::Confine::No,
    )?;
    command
        .args(command_args)
        .current_dir(&cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    // The CLI authenticates through its own login or GitHub credentials, never daemon,
    // provider, or connector secrets. Same allowlist as every other child process.
    command.env_clear().envs(
        std::env::vars()
            .filter(|(key, _)| crate::credentials::inherited_environment(key) || copilot_auth(key))
            .chain(env.into_iter().filter(|(key, _)| copilot_auth(key))),
    );
    let key = session_key(home, stored);
    let id = common::id();
    let (sender, mut cancellation) = watch::channel(false);
    {
        let mut entries = active()
            .lock()
            .map_err(|_| failure("ACP session lock unavailable"))?;
        if entries.contains_key(&key) {
            return Err(failure(
                "An ACP request is already running for this conversation",
            ));
        }
        entries.insert(key.clone(), (id.clone(), sender));
    }
    let _lease = Lease { key, id };
    let mut child = command.spawn().map_err(|_| not_started())?;
    let input = child
        .stdin
        .take()
        .ok_or_else(|| failure("ACP stdin unavailable"))?;
    let output = child
        .stdout
        .take()
        .ok_or_else(|| failure("ACP stdout unavailable"))?;
    let mut wire = Wire {
        input,
        output: BufReader::new(output),
        next_id: 0,
        session: String::new(),
        text: String::new(),
        thinking: String::new(),
    };
    let timeout = args["timeout_seconds"]
        .as_f64()
        .filter(|n| n.is_finite() && *n > 0.0)
        .unwrap_or(900.0)
        .min(3600.0);
    let run = async {
        wire.request(
            "initialize",
            json!({
                "protocolVersion": 1,
                "clientCapabilities": {
                    "fs": { "readTextFile": false, "writeTextFile": false }
                },
                "clientInfo": {
                    "name": "hexbot",
                    "title": "Hexbot",
                    "version": crate::version()
                }
            }),
        )
        .await?;
        let session = wire
            .request("session/new", json!({"cwd":cwd,"mcpServers":[]}))
            .await?;
        wire.session = session["sessionId"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or_else(|| failure("Copilot ACP did not return a sessionId"))?
            .into();
        let result = wire
            .request(
                "session/prompt",
                json!({"sessionId":wire.session,"prompt":[{"type":"text","text":prompt(args)}]}),
            )
            .await?;
        let (text, tool_calls) = extract_calls(&wire.text)?;
        let stop = if !tool_calls.is_empty() {
            "toolUse"
        } else if result["stopReason"] == "max_tokens" {
            "length"
        } else if result["stopReason"] == "cancelled" {
            return Err(failure("The turn was interrupted"));
        } else {
            "stop"
        };
        Ok(json!({"text":text,"thinking":wire.thinking,"toolCalls":tool_calls,"stopReason":stop}))
    };
    let result = tokio::select! {
        result=tokio::time::timeout(Duration::from_secs_f64(timeout),run)=>result.unwrap_or_else(|_|Err(failure("Copilot ACP request timed out"))),
        _=cancellation.changed()=>Err(failure("The turn was interrupted")),
    };
    if result.is_err() && !wire.session.is_empty() {
        let _ = tokio::time::timeout(Duration::from_millis(100), wire.send(json!({"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":wire.session}}))).await;
    }
    let _ = child.kill().await;
    let _ = child.wait().await;
    result
}

/// What Copilot CLI reads to find its GitHub login.
fn copilot_auth(key: &str) -> bool {
    matches!(
        key.to_ascii_uppercase().as_str(),
        "GH_TOKEN" | "GITHUB_TOKEN" | "COPILOT_GITHUB_TOKEN" | "GH_HOST" | "XDG_CONFIG_HOME"
    )
}
fn split_args(raw: &str) -> Result<Vec<String>> {
    let mut args = vec![];
    let mut current = String::new();
    let mut quote = None;
    let mut escaped = false;
    let mut started = false;
    for ch in raw.chars() {
        if escaped {
            current.push(ch);
            escaped = false;
            started = true;
            continue;
        }
        if ch == '\\' && quote != Some('\'') {
            escaped = true;
            started = true;
            continue;
        }
        if let Some(q) = quote {
            if ch == q {
                quote = None
            } else {
                current.push(ch)
            };
            continue;
        }
        if ch == '\'' || ch == '"' {
            quote = Some(ch);
            started = true;
        } else if ch.is_whitespace() {
            if started {
                args.push(std::mem::take(&mut current));
                started = false;
            }
        } else {
            current.push(ch);
            started = true;
        }
    }
    if escaped || quote.is_some() {
        return Err(failure("Invalid HEXBOT_COPILOT_ACP_ARGS quoting"));
    }
    if started {
        args.push(current);
    }
    Ok(args)
}

struct Wire {
    input: ChildStdin,
    output: BufReader<ChildStdout>,
    next_id: u64,
    session: String,
    text: String,
    thinking: String,
}
impl Wire {
    async fn send(&mut self, value: Value) -> Result<()> {
        let mut bytes = serde_json::to_vec(&value).map_err(|_| failure("Invalid ACP request"))?;
        bytes.push(b'\n');
        self.input.write_all(&bytes).await?;
        self.input.flush().await?;
        Ok(())
    }
    async fn frame(&mut self) -> Result<Value> {
        let mut data = Vec::new();
        loop {
            let buffer = self.output.fill_buf().await?;
            if buffer.is_empty() {
                return Err(failure(
                    "Copilot ACP exited before completing the request. Check the CLI installation and login.",
                ));
            }
            let length = buffer
                .iter()
                .position(|b| *b == b'\n')
                .map(|n| n + 1)
                .unwrap_or(buffer.len());
            let done = buffer[length - 1] == b'\n';
            if data.len() + length > MAX_FRAME {
                return Err(failure("Copilot ACP response exceeded its size limit"));
            }
            data.extend_from_slice(&buffer[..length]);
            self.output.consume(length);
            if done {
                break;
            }
        }
        serde_json::from_slice(&data).map_err(|_| failure("Copilot ACP returned malformed JSON"))
    }
    async fn request(&mut self, method: &str, params: Value) -> Result<Value> {
        self.next_id += 1;
        let id = self.next_id;
        self.send(json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))
            .await?;
        loop {
            let message = self.frame().await?;
            if message["method"].is_string() {
                self.server_message(&message).await?;
                continue;
            }
            if message["id"] != id {
                continue;
            }
            if message.get("error").is_some() {
                return Err(failure(format!(
                    "Copilot ACP {method} failed: {}",
                    message["error"]["message"]
                        .as_str()
                        .unwrap_or("protocol error")
                )));
            }
            return Ok(message["result"].clone());
        }
    }
    async fn server_message(&mut self, message: &Value) -> Result<()> {
        let method = message["method"].as_str().unwrap_or("");
        let params = &message["params"];
        if method == "session/update" {
            if !self.session.is_empty() && params["sessionId"] != self.session {
                return Ok(());
            }
            let update = &params["update"];
            let chunk = update["content"]["text"].as_str().unwrap_or("");
            let target = match update["sessionUpdate"].as_str() {
                Some("agent_message_chunk") => Some(&mut self.text),
                Some("agent_thought_chunk") => Some(&mut self.thinking),
                _ => None,
            };
            if let Some(target) = target {
                if target.len() + chunk.len() > MAX_FRAME {
                    return Err(failure("Copilot ACP response exceeded its size limit"));
                }
                target.push_str(chunk);
            }
            return Ok(());
        }
        if message.get("id").is_none() {
            return Ok(());
        }
        let id = message["id"].clone();
        // Copilot's own tools run outside the section's toolsets, approval mode, sandbox,
        // and command guards, so no request is ever granted. Hexbot actions arrive as
        // `<tool_call>` text instead and run through the guarded tools.
        let response = if method == "session/request_permission" {
            json!({"jsonrpc":"2.0","id":id,"result":{"outcome":{"outcome":"cancelled"}}})
        } else {
            json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"Unsupported ACP client method"}})
        };
        self.send(response).await
    }
}

fn content(value: &Value) -> String {
    if let Some(text) = value.as_str() {
        return text.into();
    }
    if let Some(items) = value.as_array() {
        return items
            .iter()
            .map(|v| match v["type"].as_str() {
                Some("text" | "thinking") => v["text"]
                    .as_str()
                    .or(v["thinking"].as_str())
                    .unwrap_or("")
                    .to_owned(),
                Some("toolCall") => format!(
                    "<tool_call>{}</tool_call>",
                    json!({
                        "id": v["id"],
                        "type": "function",
                        "function": {
                            "name": v["name"],
                            "arguments": v["arguments"].to_string()
                        }
                    })
                ),
                _ => v.to_string(),
            })
            .collect::<Vec<_>>()
            .join("\n");
    }
    value.to_string()
}
fn prompt(args: &Value) -> String {
    let context = &args["context"];
    let mut sections = vec![
        "You are the active ACP agent backend for Hexbot. Use the provided tools to take actions. When using a tool, emit ONLY <tool_call>{...}</tool_call> with one JSON object containing id/type/function{name,arguments}. arguments must be a JSON string. Otherwise answer normally."
            .to_owned(),
    ];
    if let Some(model) = args["model"].as_str() {
        sections.push(format!("Requested model hint: {model}"));
    }
    if let Some(system) = context["systemPrompt"].as_str() {
        sections.push(format!("System:\n{system}"));
    }
    if let Some(tools) = context["tools"].as_array() {
        sections.push(format!(
            "Available tools (OpenAI function schema):\n{}",
            Value::Array(tools.clone())
        ));
    }
    if let Some(messages) = context["messages"].as_array() {
        for message in messages {
            sections.push(format!(
                "{}:\n{}",
                message["role"].as_str().unwrap_or("context"),
                content(&message["content"])
            ));
        }
    }
    sections.push("Continue the conversation from the latest user request.".into());
    sections.join("\n\n")
}

fn extract_calls(response: &str) -> Result<(String, Vec<Value>)> {
    let mut calls = vec![];
    let mut text = String::new();
    let mut remaining = response;
    while let Some(start) = remaining.find("<tool_call>") {
        text.push_str(&remaining[..start]);
        let body = &remaining[start + 11..];
        let Some(end) = body.find("</tool_call>") else {
            return Err(failure("ACP returned an incomplete tool call"));
        };
        let raw: Value = serde_json::from_str(body[..end].trim())
            .map_err(|_| failure("ACP returned an invalid tool call"))?;
        let function = &raw["function"];
        let name = function["name"]
            .as_str()
            .filter(|v| !v.is_empty())
            .ok_or_else(|| failure("ACP tool call has no name"))?;
        let arguments = match function.get("arguments") {
            Some(Value::String(s)) => serde_json::from_str::<Value>(s)
                .map_err(|_| failure("ACP returned invalid tool arguments"))?,
            Some(v) => v.clone(),
            None => json!({}),
        };
        if !arguments.is_object() {
            return Err(failure("ACP tool arguments must be an object"));
        }
        calls.push(json!({"id":raw["id"].as_str().filter(|v|!v.is_empty()).map(str::to_owned).unwrap_or_else(||format!("acp_{}",common::id())),"name":name,"arguments":arguments}));
        remaining = &body[end + 12..];
    }
    text.push_str(remaining);
    // Some ACP versions return the OpenAI object without its wrapper.
    if calls.is_empty()
        && let Ok(raw) = serde_json::from_str::<Value>(response.trim())
        && raw["type"] == "function"
        && raw["function"].is_object()
    {
        return extract_calls(&format!("<tool_call>{raw}</tool_call>"));
    }
    Ok((text.trim().into(), calls))
}
