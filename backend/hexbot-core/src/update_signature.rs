//! Release signatures for update manifests (docs/release.md, "Update signing").
//! A manifest pins each package's SHA-256; its Ed25519 signature proves that the
//! release workflow published it, not just whoever controls the update origin or
//! its TLS. The daemon's native updater and the installer engine share this file.
use base64::{Engine, engine::general_purpose::STANDARD};

/// The release keys' public halves, one per line (two while a key is replaced).
/// `scripts/desktop/update-signing.mjs` signs with the private half from the
/// `HEXBOT_UPDATE_SIGNING_KEY` secret.
const RELEASE_KEYS: &str = include_str!("../../../packaging/update-signing-key.pub");
/// Debug builds also trust this key, so tests and the fake update server can sign
/// their own manifests. Its seed is public (SHA-256 of "hexbot update signing
/// test key"); release builds never trust it.
pub const TEST_KEY: &str = "yWrCR+4HB5t9ZHKtbMZ4CTVA5JT9/lBdRcXV2/p79Fg=";
pub const INVALID: &str = "The update is not signed by the Hexbot release key. Nothing was installed.";
/// Signatures are tiny; anything bigger is not one.
pub const SIGNATURE_LIMIT: usize = 1024;

/// True when `signature` (base64 of a 64-byte Ed25519 signature, as published in
/// a `.sig` file) signs exactly `manifest` with a trusted key.
pub fn verify(manifest: &[u8], signature: &[u8]) -> bool {
    let Some(signature) = std::str::from_utf8(signature)
        .ok()
        .and_then(|text| STANDARD.decode(text.trim()).ok())
    else {
        return false;
    };
    let mut keys: Vec<&str> = RELEASE_KEYS.lines().map(str::trim).collect();
    if cfg!(debug_assertions) {
        keys.push(TEST_KEY);
    }
    keys.into_iter()
        .filter_map(|key| STANDARD.decode(key).ok())
        .any(|key| {
            ring::signature::UnparsedPublicKey::new(&ring::signature::ED25519, key)
                .verify(manifest, &signature)
                .is_ok()
        })
}

/// Signs `manifest` with the public test key, as the release workflow signs with
/// the real one. For tests and the fake update server only.
#[doc(hidden)]
pub fn test_signature(manifest: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let seed = Sha256::digest(b"hexbot update signing test key");
    let pair = ring::signature::Ed25519KeyPair::from_seed_unchecked(&seed).expect("test seed");
    STANDARD.encode(pair.sign(manifest))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_trusted_keys_and_exact_bytes_verify() {
        let manifest = br#"{"version":"1.2.3"}"#;
        let signature = test_signature(manifest);
        assert!(verify(manifest, signature.as_bytes()));
        assert!(verify(manifest, format!("{signature}\n").as_bytes()));
        assert!(!verify(br#"{"version":"1.2.4"}"#, signature.as_bytes()));
        assert!(!verify(manifest, b""));
        assert!(!verify(manifest, b"not base64"));
        let other = ring::signature::Ed25519KeyPair::from_seed_unchecked(&[7; 32]).unwrap();
        assert!(!verify(manifest, STANDARD.encode(other.sign(manifest)).as_bytes()));
        for key in RELEASE_KEYS.lines() {
            assert_eq!(STANDARD.decode(key.trim()).unwrap().len(), 32);
        }
    }
}
