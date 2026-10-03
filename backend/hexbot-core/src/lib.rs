//! Native Hexbot daemon with Pi agent sessions and the existing frontend contract.

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
compile_error!("The Hexbot daemon supports macOS and Linux only");

pub mod auth;
pub mod catalog;
pub mod cli;
pub mod common;
pub mod connectors;
pub mod credentials;
pub mod db;
pub mod dpop;
pub mod dreaming;
pub mod events;
pub mod http;
pub mod memory;
pub mod native_external_tools;
pub mod native_product_tools;
pub mod native_tools;
pub mod pi;
pub mod provider_acp;
pub mod providers;
pub mod rooms;
pub mod rpc;
pub mod runtime;
pub mod runtime_store;
pub mod server;
pub mod services;
pub mod settings;
pub mod team;

pub fn version() -> String {
    serde_json::from_str::<serde_json::Value>(include_str!("../../../apps/desktop/package.json"))
        .expect("valid desktop package")["version"]
        .as_str()
        .expect("desktop version")
        .to_owned()
}

#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct Error {
    pub code: i64,
    pub message: String,
    pub data: Option<serde_json::Value>,
}

impl Error {
    pub fn with_data(mut self, data: serde_json::Value) -> Self {
        self.data = Some(data);
        self
    }
    pub fn rpc_value(self) -> serde_json::Value {
        let mut value = serde_json::json!({"code":self.code,"message":self.message});
        if let Some(data) = self.data {
            value["data"] = data;
        }
        value
    }
    pub fn new(code: i64, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            data: None,
        }
    }
}

impl From<std::io::Error> for Error {
    fn from(error: std::io::Error) -> Self {
        Self::new(5200, error.to_string()).with_data(serde_json::json!({"transient":true}))
    }
}

impl From<rusqlite::Error> for Error {
    fn from(error: rusqlite::Error) -> Self {
        Self::new(5200, error.to_string()).with_data(serde_json::json!({"transient":true}))
    }
}

pub type Result<T> = std::result::Result<T, Error>;
