//! Memory RPC handlers. Transport authentication supplies the caller identity.
//! This module does not authenticate a network connection.

use serde_json::{Value, json};

use crate::{Error, Result, memory::MemoryStore};

pub const METHODS: &[&str] = &[
    "hexbot.memory.user.get",
    "hexbot.memory.user.set",
    "hexbot.memory.bot.get",
    "hexbot.memory.bot.set",
];

fn text<'a>(params: &'a Value, key: &str, required: bool) -> Result<&'a str> {
    match params.get(key) {
        None | Some(Value::Null) if !required => Ok(""),
        Some(Value::String(value)) if !required || !value.is_empty() => Ok(value),
        None | Some(Value::Null) | Some(Value::String(_)) => {
            Err(Error::new(4200, format!("missing parameter: {key}")))
        }
        _ => Err(Error::new(4201, format!("{key} must be a string"))),
    }
}

pub fn call(store: &MemoryStore, caller: &str, method: &str, params: &Value) -> Result<Value> {
    match method {
        "hexbot.memory.user.get" => store.get_user(caller),
        "hexbot.memory.user.set" => store.set_user(caller, text(params, "text", false)?),
        "hexbot.memory.bot.get" => store.get_bot(caller, text(params, "bot", true)?),
        "hexbot.memory.bot.set" => store.set_bot(
            caller,
            text(params, "bot", true)?,
            text(params, "memory_md", false)?,
        ),
        _ => Err(Error::new(-32601, format!("unknown method: {method}"))),
    }
}

fn failure(id: Value, code: i64, message: impl Into<String>) -> Value {
    json!({"jsonrpc":"2.0", "id":id, "error":{"code":code,"message":message.into()}})
}

/// One response for a request, no response for a valid JSON-RPC notification.
/// Mutation broadcasts belong to the future gateway, not this local test transport.
pub fn dispatch(store: &MemoryStore, caller: &str, request: Value) -> Option<Value> {
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    let valid_id = id.is_null() || id.is_string() || id.is_number();
    if request.get("jsonrpc").and_then(Value::as_str) != Some("2.0")
        || request.get("method").and_then(Value::as_str).is_none()
        || !valid_id
    {
        return Some(failure(Value::Null, -32600, "invalid request"));
    }
    let notification = request.get("id").is_none();
    let params = request.get("params").unwrap_or(&Value::Null);
    let result = if !params.is_null() && !params.is_object() {
        Err(Error::new(-32602, "params must be an object"))
    } else {
        call(store, caller, request["method"].as_str().unwrap(), params)
    };
    if notification {
        return None;
    }
    Some(match result {
        Ok(value) => json!({"jsonrpc":"2.0", "id":id, "result":value}),
        Err(error) => failure(id, error.code, error.message),
    })
}

pub fn parse_error() -> Value {
    failure(Value::Null, -32700, "parse error")
}
