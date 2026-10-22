#![cfg(windows)]
//! Actual PiProcess, its cleared environment, bundled Node and JS launcher.
use hexbot_core::pi::{PiOptions, PiProcess};
use serde_json::json;
use std::{fs, path::PathBuf, time::Duration};

#[tokio::test]
#[ignore = "requires HEXBOT_NATIVE_TEST_BUNDLE with the real locked Node/Pi bundle"]
async fn real_pi_process_uses_absolute_node_launcher_and_windows_environment() {
    let bundle =
        PathBuf::from(std::env::var_os("HEXBOT_NATIVE_TEST_BUNDLE").expect("native bundle"))
            .canonicalize()
            .unwrap();
    let root = tempfile::tempdir().unwrap();
    let profile = root.path().join("Jos\u{e9} profile with spaces");
    let agent = profile.join("pi-agent");
    fs::create_dir_all(&agent).unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let router = axum::Router::new().route("/", axum::routing::get(|| async { "network works" }));
    let server = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    let record = root.path().join("environment.json");
    let extension = root.path().join("environment.mjs");
    fs::write(&extension, format!(r#"import {{ writeFileSync }} from 'node:fs';
export default async function () {{
  const response = await fetch('http://{address}/');
  writeFileSync({}, JSON.stringify({{ systemRoot: process.env.SystemRoot, profile: process.env.USERPROFILE, appData: process.env.APPDATA, network: await response.text() }}));
}}"#, json!(record))).unwrap();
    let mut options = PiOptions::new(bundle.join("node.exe"), &profile, &agent);
    // No Node script argument here: PiProcess itself must insert the trusted
    // absolute sibling pi/launch.mjs before these Pi arguments.
    options.args = vec![
        "--mode".into(),
        "rpc".into(),
        "--no-approve".into(),
        "--extension".into(),
        extension.to_string_lossy().into_owned(),
    ];
    options
        .env
        .insert("HOME".into(), profile.to_string_lossy().into_owned());
    options
        .env
        .insert("USERPROFILE".into(), profile.to_string_lossy().into_owned());
    options.env.insert(
        "APPDATA".into(),
        profile.join("roaming").to_string_lossy().into_owned(),
    );
    let (pi, _events) = PiProcess::spawn(options).unwrap();
    let response = pi
        .request(json!({"type":"get_state"}), Duration::from_secs(45))
        .await;
    pi.shutdown().await.unwrap();
    server.abort();
    assert!(response.unwrap().success);
    let env: serde_json::Value = serde_json::from_slice(&fs::read(record).unwrap()).unwrap();
    assert_eq!(env["profile"], profile.to_string_lossy().as_ref());
    assert_eq!(
        env["appData"],
        profile.join("roaming").to_string_lossy().as_ref()
    );
    assert!(env["systemRoot"].as_str().is_some_and(|s| !s.is_empty()));
    assert_eq!(env["network"], "network works");
}
