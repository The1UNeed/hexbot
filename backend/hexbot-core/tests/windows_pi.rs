#![cfg(windows)]
//! Actual PiProcess, its cleared environment, bundled Node and JS launcher.
use hexbot_core::pi::{PiOptions, PiProcess};
use serde_json::json;
use std::{fs, path::PathBuf, time::Duration};
#[path = "support/windows_process_handle.rs"]
mod process_handle;
#[path = "../src/windows_node_path.rs"]
mod windows_node_path;
#[path = "../src/windows_pi_job.rs"]
mod windows_pi_job;
#[path = "../src/windows_pi_ledger.rs"]
mod windows_pi_ledger;
#[path = "../src/windows_process_identity.rs"]
mod windows_process_identity;

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

#[tokio::test]
#[ignore = "requires the real locked Node/Pi bundle and native Windows Git Bash"]
async fn stopping_one_pi_reaps_its_real_bash_tree_and_preserves_another_pi() {
    use process_handle::ProcessHandle;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    let bundle =
        PathBuf::from(std::env::var_os("HEXBOT_NATIVE_TEST_BUNDLE").expect("native bundle"));
    let root = tempfile::tempdir().unwrap();
    private_job_event_completion_control(&bundle.join("node.exe"), root.path()).await;
    let mut processes = Vec::new();
    let mut nodes = Vec::new();
    let mut event_streams = Vec::new();
    for name in ["first", "second"] {
        let dir = root.path().join(name);
        fs::create_dir(&dir).unwrap();
        let record = dir.join("identity.json");
        let extension = dir.join("identity.mjs");
        fs::write(&extension,format!("import {{writeFileSync}} from 'node:fs';export default function(){{writeFileSync({},JSON.stringify({{pid:process.pid,parent:process.ppid}}));}}",json!(record))).unwrap();
        let mut options = PiOptions::new(bundle.join("node.exe"), &dir, dir.join("agent"));
        options.args = vec![
            "--mode".into(),
            "rpc".into(),
            "--no-session".into(),
            "--no-approve".into(),
            "--extension".into(),
            extension.to_string_lossy().into_owned(),
        ];
        let (pi, events) = PiProcess::spawn(options).unwrap();
        assert!(
            pi.request(json!({"type":"get_state"}), Duration::from_secs(45))
                .await
                .unwrap()
                .success
        );
        let value: serde_json::Value = serde_json::from_slice(&fs::read(record).unwrap()).unwrap();
        nodes.push(ProcessHandle::open(value["pid"].as_u64().unwrap() as u32));
        processes.push(pi);
        event_streams.push(events);
    }
    // Request Pi's real built-in user bash path. The shell stays alive waiting
    // for an actual long-lived Node tool child; readiness is an IPC event.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let script = root.path().join("long lived tool.mjs");
    fs::write(&script,format!("import net from 'node:net';const s=net.connect({},'127.0.0.1',()=>s.write(JSON.stringify({{pid:process.pid,parent:process.ppid}})+'\\n'));s.on('data',()=>{{setInterval(()=>{{}},60000);s.end();}});",listener.local_addr().unwrap().port())).unwrap();
    let quote = |path: &std::path::Path| {
        format!(
            "'{}'",
            windows_node_path::node_path(path)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/")
                .replace('\'', "'\\''")
        )
    };
    let command = format!(
        "{} {}; exit $?",
        quote(&bundle.join("node.exe")),
        quote(&script)
    );
    let owner = processes[0].clone();
    let mut pending = tokio::spawn(async move {
        owner
            .request(
                json!({"type":"bash","command":command}),
                Duration::from_secs(90),
            )
            .await
    });
    let (mut socket, _) = tokio::time::timeout(Duration::from_secs(45), async {
        tokio::select! {
            accepted=listener.accept()=>accepted.unwrap(),
            result=&mut pending=>panic!("Actual Pi bash exited before tool readiness: {result:?}"),
        }
    })
    .await
    .unwrap();
    let mut line = String::new();
    tokio::time::timeout(
        Duration::from_secs(15),
        BufReader::new(&mut socket).read_line(&mut line),
    )
    .await
    .unwrap()
    .unwrap();
    let tool: serde_json::Value = serde_json::from_str(&line).unwrap();
    let descendants = [
        ProcessHandle::open(tool["parent"].as_u64().unwrap() as u32),
        ProcessHandle::open(tool["pid"].as_u64().unwrap() as u32),
    ];
    assert!(
        nodes
            .iter()
            .chain(descendants.iter())
            .all(ProcessHandle::alive)
    );
    assert_ne!(
        descendants[0].pid, nodes[0].pid,
        "Actual bash must stay alive as tool parent"
    );
    socket.write_all(b"tracked\n").await.unwrap();
    processes[0].shutdown().await.unwrap();
    assert!(
        nodes[..1]
            .iter()
            .chain(descendants.iter())
            .all(|p| !p.alive()),
        "Cleanup replied before kernel exit: {:?}",
        nodes[..1]
            .iter()
            .chain(descendants.iter())
            .map(ProcessHandle::snapshot)
            .collect::<Vec<_>>()
    );
    for p in &descendants {
        p.wait();
    }
    assert!(pending.await.unwrap().is_err());
    assert!(
        nodes[1].alive(),
        "Stopping one Pi killed a different section"
    );
    assert!(
        processes[1]
            .request(json!({"type":"get_state"}), Duration::from_secs(15))
            .await
            .unwrap()
            .success
    );
    // The unaffected instance still shuts down through its own job.
    processes[1].shutdown().await.unwrap();
    assert!(!nodes[1].alive());
}

async fn private_job_event_completion_control(node: &std::path::Path, cwd: &std::path::Path) {
    use std::os::windows::io::AsRawHandle;
    use tokio::io::{AsyncBufReadExt, BufReader};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let leaf = "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>process.stdout.write('ready\\n'))";
    let script = format!(
        r#"const child=require('child_process').spawn(process.execPath,['--eval',{}],{{stdio:['ignore','pipe','ignore']}});child.stdout.once('data',()=>{{const socket=require('net').connect({},'127.0.0.1',()=>socket.write(JSON.stringify({{root:process.pid,leaf:child.pid}})+'\n'));}});"#,
        json!(leaf),
        port
    );
    let job = windows_pi_job::PiJob::new().unwrap();
    let mut command = tokio::process::Command::new(node);
    command.creation_flags(0x08000004);
    let mut root = command
        .args(["--eval", &script])
        .current_dir(cwd)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    job.assign_and_resume(&root).unwrap();
    let (mut stream,_)=tokio::time::timeout(Duration::from_secs(15),async {
        tokio::select! { result=listener.accept()=>result.unwrap(), status=root.wait()=>panic!("Job root exited before event readiness: {status:?}") }
    }).await.unwrap();
    let mut line = String::new();
    tokio::time::timeout(
        Duration::from_secs(15),
        BufReader::new(&mut stream).read_line(&mut line),
    )
    .await
    .unwrap()
    .unwrap();
    let record: serde_json::Value = serde_json::from_str(&line).unwrap();
    assert_eq!(record["root"].as_u64(), root.id().map(u64::from));
    let handles = [
        process_handle::ProcessHandle::open(record["root"].as_u64().unwrap() as u32),
        process_handle::ProcessHandle::open(record["leaf"].as_u64().unwrap() as u32),
    ];
    assert!(handles.iter().all(process_handle::ProcessHandle::alive));
    let snapshot = windows_process_identity::snapshot().unwrap();
    assert!(
        snapshot
            .iter()
            .any(|(pid, parent)| *pid == handles[1].pid && *parent == handles[0].pid)
    );
    for handle in &handles {
        let exact = windows_process_identity::open(handle.pid).unwrap().unwrap();
        assert!(windows_process_identity::same_owner(exact.as_raw_handle()).unwrap());
        assert_eq!(
            windows_process_identity::image(exact.as_raw_handle())
                .unwrap()
                .canonicalize()
                .unwrap(),
            node.canonicalize().unwrap()
        );
    }
    tokio::task::spawn_blocking(move || job.terminate_and_wait())
        .await
        .unwrap()
        .unwrap();
    eprintln!(
        "Private Pi job completion at API return: {:?}",
        handles
            .iter()
            .map(process_handle::ProcessHandle::snapshot)
            .collect::<Vec<_>>()
    );
    assert!(handles.iter().all(|handle| !handle.alive()));
    assert_eq!(root.wait().await.unwrap().code(), Some(1));
}
