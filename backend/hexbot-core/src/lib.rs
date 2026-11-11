//! Native Hexbot daemon with Pi agent sessions and the existing frontend contract.

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
compile_error!("The Hexbot daemon supports macOS and Linux only");

pub mod accounts;
mod admission;
pub mod auth;
mod calendar;
pub mod catalog;
pub mod cli;
pub mod common;
pub mod computers;
pub mod connectors;
pub mod credentials;
pub mod daemon_status;
pub mod db;
pub mod diagnostics;
mod docs;
pub mod dpop;
pub mod dreaming;
mod drive;
pub mod engines;
pub mod events;
mod excel;
pub mod faces;
pub mod http;
mod install_ownership;
pub mod log_files;
pub mod mail;
mod markdown;
pub mod memory;
pub mod native_external_tools;
pub mod native_product_tools;
pub mod native_tools;
mod ooxml;
pub mod osutil;
pub mod passwords;
pub mod pi;
pub mod plugins;
mod powerpoint;
pub mod provider_acp;
pub mod providers;
pub mod rooms;
pub mod rpc;
pub mod runtime;
pub mod runtime_store;
pub mod searxng;
pub mod server;
pub mod services;
pub mod settings;
pub mod setup;
mod sheets;
pub mod skills;
mod slides;
pub mod system_service;
mod tasks;
pub mod team;
mod update_path;
pub mod update_signature;
pub mod usage;
mod word;
mod zip;

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
