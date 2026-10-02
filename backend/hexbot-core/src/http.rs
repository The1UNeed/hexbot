//! Shared HTTP transport; callers retain their status and error contracts.
use crate::{Error, Result};
use serde_json::Value;
use std::time::Duration;

pub fn client(seconds: u64, redirects: usize) -> reqwest::Result<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(seconds))
        .redirect(if redirects == 0 {
            reqwest::redirect::Policy::none()
        } else {
            reqwest::redirect::Policy::limited(redirects)
        })
        .build()
}

pub fn error(error: reqwest::Error, code: i64, messages: [&str; 3]) -> Error {
    Error::new(
        code,
        messages[if error.is_timeout() {
            0
        } else if error.is_connect() {
            1
        } else {
            2
        }],
    )
}

pub async fn bytes(
    mut response: reqwest::Response,
    limit: usize,
    transport: impl Fn(reqwest::Error) -> Error,
    oversized: Error,
) -> Result<Vec<u8>> {
    if response.content_length().is_some_and(|n| n > limit as u64) {
        return Err(oversized);
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(&transport)? {
        if chunk.len() > limit.saturating_sub(body.len()) {
            return Err(oversized);
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

pub async fn json(
    response: reqwest::Response,
    limit: usize,
    transport: impl Fn(reqwest::Error) -> Error,
    oversized: Error,
    invalid: Error,
) -> Result<Value> {
    let body = bytes(response, limit, transport, oversized).await?;
    serde_json::from_slice(&body).map_err(|_| invalid)
}
