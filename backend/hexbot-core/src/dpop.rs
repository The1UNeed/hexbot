//! Device proof verification. Host comes only from the HTTP request, never forwarded headers.
use crate::{Error, Result};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode, jwk::Jwk};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, sync::Mutex};

#[derive(Default)]
pub struct Proofs(Mutex<HashMap<(String, String), i64>>);
#[derive(Deserialize)]
struct Claims {
    htm: String,
    htu: String,
    iat: i64,
    jti: String,
    ath: Option<String>,
}
fn invalid() -> Error {
    Error::new(4231, "invalid device proof")
}
pub fn token_hash(token: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(token.as_bytes()))
}
impl Proofs {
    /// Consume only after signature, request, token, and key checks succeed.
    #[allow(clippy::too_many_arguments)]
    pub fn verify(
        &self,
        proof: &str,
        method: &str,
        host: &str,
        path: &str,
        token: Option<&str>,
        expected_key: Option<&str>,
    ) -> Result<String> {
        self.verify_at(
            proof,
            method,
            host,
            path,
            token,
            expected_key,
            crate::common::now() as i64,
        )
    }
    #[allow(clippy::too_many_arguments)]
    fn verify_at(
        &self,
        proof: &str,
        method: &str,
        host: &str,
        path: &str,
        token: Option<&str>,
        expected_key: Option<&str>,
        now: i64,
    ) -> Result<String> {
        if proof.len() > 8192 {
            return Err(invalid());
        }
        let header: Value = serde_json::from_slice(
            &URL_SAFE_NO_PAD
                .decode(proof.split('.').next().ok_or_else(invalid)?)
                .map_err(|_| invalid())?,
        )
        .map_err(|_| invalid())?;
        let jwk = &header["jwk"];
        if header["typ"] != "dpop+jwt"
            || header["alg"] != "ES256"
            || header.get("crit").is_some()
            || jwk["kty"] != "EC"
            || jwk["crv"] != "P-256"
            || jwk.get("d").is_some()
        {
            return Err(invalid());
        }
        for field in ["x", "y"] {
            let value = jwk[field].as_str().ok_or_else(invalid)?;
            if URL_SAFE_NO_PAD.decode(value).map_err(|_| invalid())?.len() != 32 {
                return Err(invalid());
            }
        }
        let thumbprint =
            token_hash(&json!({"crv":"P-256","kty":"EC","x":jwk["x"],"y":jwk["y"]}).to_string());
        if expected_key.is_some_and(|key| key != thumbprint) {
            return Err(invalid());
        }
        let jwk: Jwk = serde_json::from_value(jwk.clone()).map_err(|_| invalid())?;
        let key = DecodingKey::from_jwk(&jwk).map_err(|_| invalid())?;
        let mut validation = Validation::new(Algorithm::ES256);
        validation.required_spec_claims.clear();
        validation.validate_exp = false;
        validation.validate_aud = false;
        let claims = decode::<Claims>(proof, &key, &validation)
            .map_err(|_| invalid())?
            .claims;
        let url = url::Url::parse(&claims.htu).map_err(|_| invalid())?;
        let authority = &url[url::Position::BeforeHost..url::Position::AfterPort];
        if !matches!(url.scheme(), "http" | "https")
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || !authority.eq_ignore_ascii_case(host)
            || url.path() != path
            || claims.htm != method
            || claims.iat.abs_diff(now) > 60
            || claims.jti.is_empty()
            || claims.jti.len() > 256
            || token.is_some_and(|token| claims.ath.as_deref() != Some(token_hash(token).as_str()))
        {
            return Err(invalid());
        }
        let mut used = self.0.lock().unwrap_or_else(|e| e.into_inner());
        // Future proofs can remain valid for 120 seconds after first acceptance.
        used.retain(|_, expires| *expires >= now);
        let id = (thumbprint.clone(), claims.jti);
        if used.contains_key(&id) || used.len() >= 65536 {
            return Err(invalid());
        }
        used.insert(id, claims.iat.saturating_add(60));
        Ok(thumbprint)
    }
}
