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

pub fn parse_error() -> Value {
    json!({"jsonrpc":"2.0", "id":null, "error":{"code":-32700,"message":"parse error"}})
}
