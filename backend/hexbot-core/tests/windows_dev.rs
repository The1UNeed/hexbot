#![cfg(windows)]
//! The actual dev provisioner feeds the real PiProcess Node boundary.
use hexbot_core::pi::{PiOptions, PiProcess};
use serde_json::json;
use std::{collections::BTreeMap, fs, path::PathBuf, process::Command, time::Duration};
#[path = "../src/windows_node_path.rs"]
mod windows_node_path;

#[tokio::test]
#[ignore = "requires trusted running Node, network for pinned dev tools and locked Pi dependencies"]
async fn prepared_dev_node_runs_real_pi_for_daemon_and_desktop() {
    let node =
        PathBuf::from(std::env::var_os("HEXBOT_WINDOWS_SERVICE_NODE").expect("trusted Node"));
    assert!(node.is_absolute() && node.is_file());
    let repository = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap();
    let root = tempfile::tempdir().unwrap();
    let home = root.path().join("dev Jos\u{e9} \u{4e2d}\u{6587} & home");
    fs::create_dir(&home).unwrap();
    let prepare = r#"import {pathToFileURL} from 'node:url';
const [repo,home,hexbot]=process.argv.slice(1);
const {ensurePiRuntime,prepareDevRuntime,devPiEntrypoint}=await import(pathToFileURL(repo+'/scripts/dev/run.mjs'));
await ensurePiRuntime(repo+'/backend/pi-runtime');
await ensurePiRuntime(repo+'/backend/pi-runtime');
const env=await prepareDevRuntime(home,hexbot,devPiEntrypoint(repo+'/backend/pi-runtime'));
console.log(JSON.stringify(env));"#;
    let result = Command::new(&node)
        .args(["--input-type=module", "-e", prepare])
        .arg(windows_node_path::node_path(&repository).unwrap())
        .arg(&home)
        .arg(env!("CARGO_BIN_EXE_hexbot"))
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "Dev preparation: status={} stdout={} stderr={}",
        result.status,
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
    let env: BTreeMap<String, String> = serde_json::from_slice(&result.stdout).unwrap();
    let executable = PathBuf::from(&env["HEXBOT_PI_EXECUTABLE"]);
    assert_eq!(executable.file_name().unwrap(), "node.exe");
    assert!(executable.with_file_name("pi").join("launch.mjs").is_file());
    for mode in ["daemon", "desktop"] {
        let profile = home.join(mode);
        fs::create_dir(&profile).unwrap();
        let record = profile.join("argv.json");
        let extension = profile.join("literal \u{3c0} & extension.mjs");
        fs::write(&extension,format!("import {{writeFileSync}} from 'node:fs';export default function(pi){{pi.registerFlag('literal',{{type:'string',default:''}});writeFileSync({},JSON.stringify(process.argv));}}",json!(record))).unwrap();
        let mut options = PiOptions::new(&executable, &profile, profile.join("agent"));
        let arguments = vec![
            "--mode".into(),
            "rpc".into(),
            "--no-session".into(),
            "--extension".into(),
            windows_node_path::node_path(&extension.canonicalize().unwrap())
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            "--literal".into(),
            "spaces \u{3c0} \u{4e2d}\u{6587} & \"quote\"".into(),
        ];
        options.args = arguments.clone();
        options.env = env.clone();
        if mode == "daemon" {
            options.env.insert("HEXBOT_SUPERVISOR".into(), "dev".into());
        }
        options
            .env
            .insert("HEXBOT_WEB_DEV_URL".into(), "http://localhost:9876".into());
        let (pi, _events) = PiProcess::spawn(options).unwrap();
        let response = pi
            .request(json!({"type":"get_state"}), Duration::from_secs(45))
            .await;
        pi.shutdown().await.unwrap();
        assert!(response.unwrap().success);
        let argv: Vec<String> = serde_json::from_slice(&fs::read(&record).unwrap()).unwrap();
        assert_eq!(&argv[2..], arguments.as_slice());
        for tool in ["rg.exe", "fd.exe"] {
            assert_eq!(
                fs::read(profile.join("agent/bin").join(tool)).unwrap(),
                fs::read(home.join("bin").join(tool)).unwrap()
            );
        }
        eprintln!(
            "Actual dev PiProcess: mode={mode} executable={} literalArgv=true handshake=true verifiedSearchTools=true",
            executable.display()
        );
    }
}
