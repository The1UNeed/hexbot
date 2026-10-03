#[path = "fixtures/dpop.rs"]
mod fixture;
use fixture::{claims, proof};
use hexbot_core::dpop::{Proofs, token_hash};
use serde_json::json;

#[test]
fn signature_request_key_token_time_and_replay_are_checked() {
    let proofs = Proofs::default();
    let good = claims(
        "POST",
        "https://daemon.test/api/auth/ws-ticket",
        Some("device"),
    );
    let jkt = token_hash(&fixture::jwk().to_string());
    let verify = |p: &str, host: &str, expected: &str| {
        proofs.verify(
            p,
            "POST",
            host,
            "/api/auth/ws-ticket",
            Some("device"),
            Some(expected),
        )
    };
    assert!(verify(&proof(&good), "daemon.test", "another-key").is_err());
    assert!(verify(&proof(&good), "other.test", &jkt).is_err());
    for (field, value) in [
        ("htm", json!("GET")),
        ("htu", json!("https://daemon.test/hexbot/session")),
        ("htu", json!("https://other.test/api/auth/ws-ticket")),
        ("htu", json!("https://daemon.test:444/api/auth/ws-ticket")),
        (
            "htu",
            json!("https://daemon.test/api/auth/ws-ticket?token=secret"),
        ),
        ("iat", json!(good["iat"].as_i64().unwrap() - 120)),
        ("iat", json!(good["iat"].as_i64().unwrap() + 120)),
        ("ath", json!("wrong")),
        ("ath", json!(null)),
        ("jti", json!("")),
    ] {
        let mut bad = good.clone();
        bad[field] = value;
        assert!(verify(&proof(&bad), "daemon.test", &jkt).is_err(), "{bad}");
    }
    let signed = proof(&good);
    let mut altered = signed.clone().into_bytes();
    let last = altered.len() - 5;
    altered[last] = if altered[last] == b'A' { b'B' } else { b'A' };
    assert!(verify(std::str::from_utf8(&altered).unwrap(), "daemon.test", &jkt).is_err());
    assert_eq!(verify(&signed, "daemon.test", &jkt).unwrap(), jkt);
    assert!(verify(&signed, "daemon.test", &jkt).is_err());
    let mut http = claims(
        "POST",
        "http://daemon.test/api/auth/ws-ticket",
        Some("device"),
    );
    http["iat"] = json!(good["iat"].as_i64().unwrap() + 60);
    assert!(verify(&proof(&http), "daemon.test", &jkt).is_ok());
}

#[test]
fn webcrypto_proofs_verify_in_the_daemon() {
    let output = std::process::Command::new("node")
        .args(["--input-type=module", "-e", r#"
const pair = await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},false,['sign','verify']);
const publicKey = await crypto.subtle.exportKey('jwk',pair.publicKey);
const jwk = {crv:publicKey.crv,kty:publicKey.kty,x:publicKey.x,y:publicKey.y};
const b64 = value => Buffer.from(value).toString('base64url');
const hash = async text => b64(await crypto.subtle.digest('SHA-256',Buffer.from(text)));
const header = b64(JSON.stringify({typ:'dpop+jwt',alg:'ES256',jwk}));
const claims = b64(JSON.stringify({htm:'POST',htu:'https://daemon.test/api/auth/ws-ticket',iat:Math.floor(Date.now()/1000),jti:crypto.randomUUID(),ath:await hash('device')}));
const signature = b64(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},pair.privateKey,Buffer.from(`${header}.${claims}`)));
process.stdout.write(JSON.stringify({proof:`${header}.${claims}.${signature}`,jkt:await hash(JSON.stringify(jwk)),extractable:pair.privateKey.extractable}));
"#]).output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["extractable"], false);
    let jkt = result["jkt"].as_str().unwrap();
    assert_eq!(
        Proofs::default()
            .verify(
                result["proof"].as_str().unwrap(),
                "POST",
                "daemon.test",
                "/api/auth/ws-ticket",
                Some("device"),
                Some(jkt)
            )
            .unwrap(),
        jkt
    );
}
