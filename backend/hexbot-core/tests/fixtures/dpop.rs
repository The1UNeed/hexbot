use serde_json::{Value, json};
const TEST_KEY:&[u8]=b"-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg/h5RZbRebJ4W8wDj\n0zi0DKNjL3NKu4LSLTr3GDLW1AuhRANCAATxLUB7ibYZJBU9qYp7mPjCc/fQfWet\nd1HBTxun6HHLoMilyIfHMI8E9KdpMIfgyZ8cQ6tCl8+s34X5gbiue9D9\n-----END PRIVATE KEY-----\n";
pub fn jwk() -> Value {
    json!({"kty":"EC","crv":"P-256","x":"8S1Ae4m2GSQVPamKe5j4wnP30H1nrXdRwU8bp-hxy6A","y":"yKXIh8cwjwT0p2kwh-DJnxxDq0KXz6zfhfmBuK570P0"})
}
pub fn proof(claims: &Value) -> String {
    let mut header = jsonwebtoken::Header::new(jsonwebtoken::Algorithm::ES256);
    header.typ = Some("dpop+jwt".into());
    header.jwk = Some(serde_json::from_value(jwk()).unwrap());
    jsonwebtoken::encode(
        &header,
        claims,
        &jsonwebtoken::EncodingKey::from_ec_pem(TEST_KEY).unwrap(),
    )
    .unwrap()
}
pub fn claims(method: &str, url: &str, token: Option<&str>) -> Value {
    let mut claims = json!({"htm":method,"htu":url,"iat":hexbot_core::common::now() as i64,"jti":uuid::Uuid::new_v4().to_string()});
    if let Some(token) = token {
        claims["ath"] = json!(hexbot_core::dpop::token_hash(token));
    }
    claims
}

#[allow(dead_code)]
pub fn grant(claims: &Value) -> String {
    let mut header = jsonwebtoken::Header::new(jsonwebtoken::Algorithm::ES256);
    header.typ = Some("hexbot-grant+jwt".into());
    header.kid = Some("fixture".into());
    jsonwebtoken::encode(
        &header,
        claims,
        &jsonwebtoken::EncodingKey::from_ec_pem(TEST_KEY).unwrap(),
    )
    .unwrap()
}
