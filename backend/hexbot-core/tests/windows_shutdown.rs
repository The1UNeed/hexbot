#![cfg(windows)]
//! Owned desktop pipe shutdown must reach App/Pi cleanup and release the home.
use futures_util::{FutureExt, SinkExt, StreamExt};
#[path = "../src/windows_paths.rs"]
mod windows_paths;
use hexbot_core::{auth, db, osutil};
use serde_json::{Value, json};
use std::{fs, path::PathBuf, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::Command,
};
use tokio_tungstenite::{connect_async, tungstenite::Message};

#[tokio::test]
#[ignore = "requires the real locked Node/Pi bundle on a native Windows runner"]
async fn owned_desktop_pipe_quit_and_restart_clean_up_real_pi_and_home_lock() {
    let bundle =
        PathBuf::from(std::env::var_os("HEXBOT_NATIVE_TEST_BUNDLE").expect("native bundle"));
    let root = tempfile::tempdir().unwrap();
    let home = root.path().join("Jos\u{e9} Full state");
    fs::create_dir_all(home.join("profiles/owl")).unwrap();
    db::migrate(&home).unwrap();
    db::open(&home).unwrap().execute_batch(
        "INSERT INTO bots(name,owner_id,description) VALUES('owl','local','Owned cleanup fixture'); INSERT INTO sections(id,bot,owner_id,title) VALUES('first','owl','local','First');"
    ).unwrap();
    fs::write(
        home.join("profiles/owl/config.yaml"),
        "model:\n  provider: openai\n  default: gpt-4o-mini\ntools:\n  enabled_toolsets: []\n",
    )
    .unwrap();
    let token = auth::local_token(&home).unwrap();
    let fixture = root.path().join("trusted launch wrapper");
    fs::create_dir_all(fixture.join("pi")).unwrap();
    fs::copy(bundle.join("node.exe"), fixture.join("node.exe")).unwrap();
    let module = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../pi-runtime/fixtures/windows-shutdown-pi.mjs");
    let module = url::Url::from_file_path(&module).unwrap();
    let launcher = url::Url::from_file_path(bundle.join("pi/launch.mjs")).unwrap();
    for mode in ["section", "command", "eof", "force"] {
        let nonce = hexbot_core::common::id();
        let evidence = fixture.join(format!("{mode}-{nonce}"));
        fs::create_dir(&evidence).unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let config = json!({"directory":evidence,"mode":mode,"nonce":nonce,"launcher":launcher.as_str(),"monitor":listener.local_addr().unwrap().port()});
        fs::write(
            fixture.join("pi/launch.mjs"),
            format!(
                "import {{runShutdownFixture}} from {module};await runShutdownFixture({config});\n",
                module = json!(module.as_str())
            ),
        )
        .unwrap();
        let mut child = Command::new(env!("CARGO_BIN_EXE_hexbot"))
            .args(["serve", "--host", "127.0.0.1", "--port", "0"])
            .env("HEXBOT_HOME", &home)
            .env("HEXBOT_PI_EXECUTABLE", fixture.join("node.exe"))
            .env("HEXBOT_SUPERVISOR", "desktop")
            .env("HEXBOT_DESKTOP_CONTROL", "stdin-v1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .creation_flags(0x08000000)
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let daemon_pid = child.id().unwrap();
        let mut handles = Vec::new();
        let result = std::panic::AssertUnwindSafe(async {
            let mut output = BufReader::new(child.stdout.take().unwrap()).lines();
            let port: u16 = tokio::time::timeout(Duration::from_secs(45), async {
                while let Some(line) = output.next_line().await.unwrap() {
                    if let Some(port) = line.strip_prefix("HERMES_BACKEND_READY port=") { return port.parse().unwrap(); }
                }
                panic!("{mode}: daemon exited before readiness");
            }).await.unwrap();
            let (mut socket, _) = connect_async(format!("ws://127.0.0.1:{port}/api/ws?token={token}")).await.unwrap();
            socket.send(Message::Text(json!({"jsonrpc":"2.0","id":"open-pi","method":"hexbot.sections.open","params":{"id":"first"}}).to_string().into())).await.unwrap();
            // A fixture-only loopback barrier captures kernel handles before
            // real Pi imports or replies. No PID polling or daemon endpoint.
            let mut monitor = tokio::time::timeout(Duration::from_secs(45), async {
                loop {
                    tokio::select! {
                        accepted = listener.accept() => return accepted.unwrap().0,
                        frame = socket.next() => {
                            let frame = frame.expect("socket closed before tracking").unwrap();
                            if frame.is_text() {
                                let value: Value = serde_json::from_str(frame.to_text().unwrap()).unwrap();
                                if value["id"] == "open-pi" { panic!("{mode}: Pi replied before fixture tracking: {value}"); }
                            }
                        }
                    }
                }
            }).await.expect("Pi fixture did not identify its processes");
            let mut line = String::new();
            tokio::time::timeout(Duration::from_secs(15),
                BufReader::new((&mut monitor).take(4097)).read_line(&mut line)).await.unwrap().unwrap();
            assert!(line.len() <= 4096 && line.ends_with('\n'));
            let tracked: Value = serde_json::from_str(&line).unwrap();
            assert_eq!(tracked["mode"], mode); assert_eq!(tracked["nonce"], nonce);
            assert_eq!(tracked["ppid"], daemon_pid);
            let pi_pid = u32::try_from(tracked["pid"].as_u64().unwrap()).unwrap();
            let descendant = u32::try_from(tracked["child"].as_u64().unwrap()).unwrap();
            assert_ne!(pi_pid, descendant);
            handles.extend([ProcessHandle::open(pi_pid), ProcessHandle::open(descendant)]);
            assert!(handles.iter().all(ProcessHandle::alive), "Startup process already exited");
            monitor.write_all(b"tracked\n").await.unwrap();
            drop(monitor);
            tokio::time::timeout(Duration::from_secs(90), async {
                while let Some(frame) = socket.next().await {
                    let frame = frame.unwrap();
                    if !frame.is_text() { continue; }
                    let value: Value = serde_json::from_str(frame.to_text().unwrap()).unwrap();
                    if value["id"] == "open-pi" {
                        assert!(value.get("error").is_none(), "{mode}: Actual Pi open failed: {value}");
                        return;
                    }
                }
                panic!("{mode}: socket closed before Pi open reply");
            }).await.unwrap();
            let ready: Value = serde_json::from_slice(&fs::read(evidence.join("ready.json")).unwrap()).unwrap();
            assert_eq!(ready, tracked, "Current Pi RPC readiness must match this run's tracked processes");
            let query = format!("[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process -Filter 'ParentProcessId = {daemon_pid} OR ProcessId = {descendant}' | Where-Object Name -eq 'node.exe' | Select-Object ProcessId,ParentProcessId,ExecutablePath,CreationDate)");
            let children = Command::new(windows_paths::system_program("WindowsPowerShell/v1.0/powershell.exe").unwrap())
                .args(["-NoProfile", "-NonInteractive", "-Command", &query]).output().await.unwrap();
            assert!(children.status.success(), "{}", String::from_utf8_lossy(&children.stderr));
            let rows: Vec<Value> = serde_json::from_slice(&children.stdout).unwrap();
            eprintln!("Shutdown {mode}/{nonce}: daemon={daemon_pid}, tracked={tracked}, CIM={rows:?}, handles={:?}", handles.iter().map(ProcessHandle::snapshot).collect::<Vec<_>>());
            for (pid, parent) in [(pi_pid, daemon_pid), (descendant, pi_pid)] {
                let row = rows.iter().find(|r| r["ProcessId"] == pid).expect("Tracked process missing from CIM");
                assert_eq!(row["ParentProcessId"], parent);
                assert_eq!(PathBuf::from(row["ExecutablePath"].as_str().unwrap()).canonicalize().unwrap(), fixture.join("node.exe").canonicalize().unwrap());
            }
            // Also retain any other live Runtime-owned Node identity. Never
            // silently reinterpret a replacement or stale PID as cleanup proof.
            for row in rows {
                let pid = u32::try_from(row["ProcessId"].as_u64().unwrap()).unwrap();
                if !handles.iter().any(|handle| handle.pid == pid) { handles.push(ProcessHandle::open(pid)); }
            }
            let pi_pids = handles.iter().map(|handle| handle.pid).collect::<Vec<_>>();
            assert!(pi_pids.iter().all(|pid| osutil::process_alive(*pid)) && handles.iter().all(ProcessHandle::alive),
                "{mode}: A current Pi/descendant died BEFORE shutdown: {:?}", handles.iter().map(ProcessHandle::snapshot).collect::<Vec<_>>());
            if mode == "section" {
                // Subsequent Pi instances run the original pinned launcher.
                // Keep a second section live throughout closing/rebuilding first.
                fs::write(fixture.join("pi/launch.mjs"),format!("await import({});\n",json!(launcher.as_str()))).unwrap();
                db::open(&home).unwrap().execute("INSERT INTO sections(id,bot,owner_id,title) VALUES('second','owl','local','Second')",[]).unwrap();
                let second = rpc(&mut socket,"second-open","hexbot.sections.open",json!({"id":"second"})).await;
                assert!(second.get("error").is_none(),"{second}");
                let second_id=second["result"]["section"]["live_session_id"].as_str().expect("live second session").to_owned();
                let close=rpc(&mut socket,"close-first","hexbot.sections.close",json!({"id":"first"})).await;
                assert!(close.get("error").is_none(),"{close}");
                // Cleanup completion must mean kernel exit, without waiting
                // on our own handles to turn an early reply into success.
                assert!(handles[..2].iter().all(|p| !p.alive()),"Section close left its Pi tree alive: {:?}",handles[..2].iter().map(ProcessHandle::snapshot).collect::<Vec<_>>());
                assert!(child.try_wait().unwrap().is_none(),"Section close killed daemon");
                let second_status=rpc(&mut socket,"second-status","session.status",json!({"session_id":second_id})).await;
                assert!(second_status.get("error").is_none(),"{second_status}");
                let rebuilt=rpc(&mut socket,"rebuild-first","hexbot.sections.open",json!({"id":"first"})).await;
                assert!(rebuilt.get("error").is_none(),"{rebuilt}");
                let lock=fs::OpenOptions::new().read(true).write(true).open(home.join("native-daemon.lock")).unwrap();
                assert!(lock.try_lock().is_err(),"Live daemon lost its home lock");
            }
            let mut input = child.stdin.take().unwrap();
            if matches!(mode,"command"|"section") { input.write_all(b"HEXBOT_SHUTDOWN_V1\n").await.unwrap(); }
            if mode == "force" { child.start_kill().unwrap(); }
            drop(input);
            let status = tokio::time::timeout(Duration::from_secs(15), child.wait()).await.unwrap().unwrap();
            if mode != "force" { assert_eq!(status.code(), Some(0), "{mode}: daemon normal exit must be zero"); }
            for process in &handles { process.wait(); }
            assert!(handles.iter().all(|p| !p.alive()), "{mode}: Pi survived owned shutdown");
            eprintln!("Shutdown {mode}/{nonce}: daemon exit={status}, descendants={:?}", handles.iter().map(ProcessHandle::snapshot).collect::<Vec<_>>());
            if mode != "force" { assert!(!home.join("serve-state.json").exists()); }
            let lock = fs::OpenOptions::new().read(true).write(true).open(home.join("native-daemon.lock")).unwrap();
            lock.try_lock().expect("Home lock was not released before restart");
        }).catch_unwind().await;
        for entry in fs::read_dir(&evidence).unwrap().take(8) {
            let path = entry.unwrap().path();
            if path.extension().is_some_and(|e| e == "jsonl") {
                let bytes = fs::read(&path).unwrap();
                eprintln!(
                    "Shutdown {mode}/{nonce} lifecycle {}: {}",
                    path.file_name().unwrap().to_string_lossy(),
                    String::from_utf8_lossy(&bytes[..bytes.len().min(8192)])
                );
            }
        }
        if let Err(error) = result {
            eprintln!(
                "Shutdown {mode}/{nonce} FAILED before cleanup: daemon={:?}, processes={:?}",
                child.try_wait(),
                handles
                    .iter()
                    .map(ProcessHandle::snapshot)
                    .collect::<Vec<_>>()
            );
            if child.id().is_some() {
                if let Err(error) = child.start_kill() {
                    eprintln!("Owned fixture kill: {error}");
                }
                if let Err(error) =
                    tokio::time::timeout(Duration::from_secs(15), child.wait()).await
                {
                    eprintln!("Owned fixture reap: {error}");
                }
            }
            std::panic::resume_unwind(error);
        }
    }
}

#[path = "support/windows_process_handle.rs"]
mod process_handle;
use process_handle::ProcessHandle;

#[tokio::test]
async fn native_tunnel_worker_cleanup_reaps_and_can_restart_its_metrics_process() {
    let root = tempfile::tempdir().unwrap();
    let binary = root.path().join("trusted tunnel fixture.exe");
    let record = root.path().join("tunnel.pid");
    let source = format!(
        r#"public class Tunnel {{ public static void Main(string[] args) {{
int at = System.Array.IndexOf(args, "--metrics"); int port = int.Parse(args[at+1].Split(':')[1]);
System.IO.File.WriteAllText(@"{}", System.Diagnostics.Process.GetCurrentProcess().Id.ToString());
var listener = new System.Net.Sockets.TcpListener(System.Net.IPAddress.Loopback, port); listener.Start();
while (true) {{ using (var client = listener.AcceptTcpClient()) {{
client.ReceiveTimeout = 15000; var stream = client.GetStream(); string request = "";
while (request.Length < 8192 && !request.EndsWith("\r\n\r\n")) {{ int value = stream.ReadByte(); if (value < 0) break; request += (char)value; }}
var bytes = System.Text.Encoding.ASCII.GetBytes("HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"); stream.Write(bytes, 0, bytes.Length); }} }}
}} }}"#,
        record.to_string_lossy().replace('"', "\"\"")
    );
    let quote = |value: &str| format!("'{}'", value.replace('\'', "''"));
    let compile = Command::new(
        windows_paths::system_program("WindowsPowerShell/v1.0/powershell.exe").unwrap(),
    )
    .args([
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        &format!(
            "Add-Type -TypeDefinition {} -OutputAssembly {} -OutputType ConsoleApplication",
            quote(&source),
            quote(&binary.to_string_lossy())
        ),
    ])
    .output()
    .await
    .unwrap();
    assert!(
        compile.status.success(),
        "{}",
        String::from_utf8_lossy(&compile.stderr)
    );
    let home = root.path().join("state");
    fs::create_dir(&home).unwrap();
    hexbot_core::services::windows_contract_tests::tunnel_worker_cleanup(&home, &binary, &record)
        .await;
}

async fn rpc(
    socket: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    id: &str,
    method: &str,
    params: Value,
) -> Value {
    socket
        .send(Message::Text(
            json!({"jsonrpc":"2.0","id":id,"method":method,"params":params})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(90), async {
        while let Some(frame) = socket.next().await {
            let frame = frame.unwrap();
            if frame.is_text() {
                let v: Value = serde_json::from_str(frame.to_text().unwrap()).unwrap();
                if v["id"] == id {
                    return v;
                }
            }
        }
        panic!("Daemon socket closed waiting for {id}");
    })
    .await
    .unwrap()
}
