//! Test-only stdio fixture for the production private file protocol and handles.
use hexbot_core::common;
use hexbot_core::{Error, Result};
use serde_json::{Value, json};
use std::io::Read;
#[cfg(unix)]
#[allow(dead_code)] // This fixture exercises Pi, not the existing native callbacks.
#[path = "../src/runtime_files.rs"]
mod files;
#[cfg(windows)]
#[path = "../src/runtime_files_windows.rs"]
mod files;
#[path = "../src/runtime_pi_files.rs"]
mod protocol;

/// The Windows walk judges a path by the sandbox's text rules first.
#[cfg(windows)]
#[allow(dead_code)]
#[path = "../src/windows_paths.rs"]
mod windows_paths;
fn main() {
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input).unwrap();
    let event: Value = serde_json::from_str(&input).unwrap();
    let request: Value = serde_json::from_str(
        event["title"]
            .as_str()
            .unwrap()
            .strip_prefix("__HEXBOT_TOOL__")
            .unwrap(),
    )
    .unwrap();
    let result: Result<Value> = protocol::parse(&event, &request["args"]).and_then(|request| {
        let _ = request.tool;
        protocol::perform(&request, event["id"].as_str().unwrap())
    });
    println!(
        "{}",
        match result {
            Ok(value) => json!({"result":value}),
            Err(error) => json!({"error":error.message}),
        }
    );
}
