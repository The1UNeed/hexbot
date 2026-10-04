//! Device proof verification. Host comes only from the HTTP request, never forwarded headers.
use crate::{Error, Result};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode, jwk::Jwk};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, sync::Mutex};

#[derive(Default)]
pub struct Proofs(Mutex<HashMap<String, HashMap<String, i64>>>);
pub const INVALID: i64 = 4233;
pub const CLOCK_SKEW: i64 = 4234;
pub const KEY_MISMATCH: i64 = 4235;
pub const REQUIRED: i64 = 4236;
pub const CACHE_FULL: i64 = 5233;
const PER_KEY_LIMIT: usize = 1024;
const TOTAL_LIMIT: usize = 65536;

pub struct ProofRequest<'a> {
    pub method: &'a str,
    pub host: &'a str,
    pub path: &'a str,
    pub token: Option<&'a str>,
    /// Set only after authenticating a bound device. Login proofs are not cached.
    pub expected_key: Option<&'a str>,
}
pub fn error_code(code: i64) -> Option<&'static str> {
    match code {
        INVALID => Some("invalid_dpop_proof"),
        CLOCK_SKEW => Some("dpop_clock_skew"),
        KEY_MISMATCH => Some("dpop_key_mismatch"),
        REQUIRED => Some("dpop_proof_required"),
        CACHE_FULL => Some("dpop_cache_full"),
        _ => None,
    }
}
#[derive(Deserialize)]
struct Claims {
    htm: String,
    htu: String,
    iat: i64,
    jti: String,
    ath: Option<String>,
}
pub fn invalid() -> Error {
    Error::new(INVALID, "invalid device proof")
}
pub fn token_hash(token: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(token.as_bytes()))
}
impl Proofs {
    pub fn verify(&self, proof: &str, request: &ProofRequest<'_>) -> Result<String> {
        self.verify_at(proof, request, crate::common::now() as i64)
    }
    /// Inject time for clock-skew and acceptance-window tests.
    pub fn verify_at(&self, proof: &str, request: &ProofRequest<'_>, now: i64) -> Result<String> {
        let ProofRequest {
            method,
            host,
            path,
            token,
            expected_key,
        } = *request;
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
        // Parse Host with the proof's scheme solely to normalize default ports.
        // No forwarded header or request scheme participates in the comparison.
        let authority = host
            .parse::<axum::http::uri::Authority>()
            .map_err(|_| invalid())?;
        let target =
            url::Url::parse(&format!("{}://{authority}/", url.scheme())).map_err(|_| invalid())?;
        if !matches!(url.scheme(), "http" | "https")
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || !target.username().is_empty()
            || target.password().is_some()
            || url.host_str() != target.host_str()
            || url.port_or_known_default() != target.port_or_known_default()
            || url.path() != path
            || claims.htm != method
            || claims.jti.is_empty()
            || claims.jti.len() > 256
            || token.is_some_and(|token| claims.ath.as_deref() != Some(token_hash(token).as_str()))
        {
            return Err(invalid());
        }
        if claims.iat.abs_diff(now) > 60 {
            return Err(Error::new(CLOCK_SKEW, "device and daemon clocks differ")
                .with_data(json!({"server_time":now,"proof_time":claims.iat})));
        }
        if expected_key.is_some_and(|key| key != thumbprint) {
            return Err(Error::new(KEY_MISMATCH, "device proof key does not match"));
        }
        if expected_key.is_some() {
            self.record(&thumbprint, claims.jti, claims.iat, now)?;
        }
        Ok(thumbprint)
    }
    fn record(&self, key: &str, jti: String, iat: i64, now: i64) -> Result<()> {
        let mut used = self.0.lock().unwrap_or_else(|e| e.into_inner());
        used.retain(|_, entries| {
            entries.retain(|_, expires| *expires >= now);
            !entries.is_empty()
        });
        if used
            .get(key)
            .is_some_and(|entries| entries.contains_key(&jti))
        {
            return Err(invalid());
        }
        if used
            .get(key)
            .is_some_and(|entries| entries.len() >= PER_KEY_LIMIT)
            || used.values().map(HashMap::len).sum::<usize>() >= TOTAL_LIMIT
        {
            return Err(Error::new(
                CACHE_FULL,
                "device proof cache is busy; retry shortly",
            ));
        }
        // A future proof stays valid for up to 120 seconds after first acceptance.
        used.entry(key.to_owned())
            .or_default()
            .insert(jti, iat.saturating_add(60));
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cache_limits_are_retryable_and_future_proofs_stay_spent() {
        let proofs = Proofs::default();
        for i in 0..PER_KEY_LIMIT {
            proofs.record("one", i.to_string(), 1060, 1000).unwrap();
        }
        assert_eq!(
            proofs
                .record("one", "overflow".into(), 1060, 1000)
                .unwrap_err()
                .code,
            CACHE_FULL
        );
        proofs.record("two", "fresh".into(), 1000, 1000).unwrap();
        assert_eq!(
            proofs
                .record("one", "0".into(), 1060, 1061)
                .unwrap_err()
                .code,
            INVALID
        );
        assert_eq!(
            proofs
                .record("one", "0".into(), 1060, 1120)
                .unwrap_err()
                .code,
            INVALID
        );
        proofs.record("one", "0".into(), 1121, 1121).unwrap();
        let entries = (0..TOTAL_LIMIT).map(|i| (i.to_string(), 1200)).collect();
        proofs.0.lock().unwrap().insert("full".into(), entries);
        assert_eq!(
            proofs
                .record("three", "fresh".into(), 1140, 1140)
                .unwrap_err()
                .code,
            CACHE_FULL
        );
        proofs.record("three", "fresh".into(), 1201, 1201).unwrap();
    }
}
