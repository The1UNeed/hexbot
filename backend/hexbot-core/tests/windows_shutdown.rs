#![cfg(windows)]
//! Owned desktop pipe shutdown must reach App/Pi cleanup and release the home.
use futures_util::{FutureExt, SinkExt, StreamExt};
#[path = "../src/windows_paths.rs"]
mod windows_paths;
use hexbot_core::{auth, db, osutil};
use serde_json::{Value, json};
use std::{fs, path::PathBuf, process::Stdio, time::Duration};
#[path = "support/service_parent_fixture.rs"]
mod service_parent_fixture;
#[path = "support/shutdown_output.rs"]
mod shutdown_output;
use service_parent_fixture::Startup;
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
    let peer_home = root.path().join("independent daemon");
    let mut peer = Command::new(env!("CARGO_BIN_EXE_hexbot"))
        .args(["serve", "--host", "127.0.0.1", "--port", "0"])
        .env("HEXBOT_HOME", &peer_home)
        .env("HEXBOT_PI_EXECUTABLE", bundle.join("node.exe"))
        .env("HEXBOT_SUPERVISOR", "desktop")
        .env("HEXBOT_DESKTOP_CONTROL", "stdin-v1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(0x08000000)
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let peer_handle = ProcessHandle::open(peer.id().unwrap());
    let mut peer_startup = Startup::new(&mut peer, None, "peer", false);
    let mut owned_reaped = true;
    let mut cleanup_deadline = None;
    let all = std::panic::AssertUnwindSafe(async {
    let peer_port = peer_startup.ready(&mut peer).await.unwrap();
    for mode in [
        "section",
        "command",
        "eof",
        "force",
        "service-exit",
        "service-kill",
    ] {
        let service_mode = mode.starts_with("service-");
        let stored = if mode == "section" {
            "first-section"
        } else {
            "first"
        };
        let tool_ready = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let script = root.path().join("actual tool child.mjs");
        fs::write(&script,format!("import net from 'node:net';const s=net.connect({},'127.0.0.1',()=>s.write(JSON.stringify({{pid:process.pid,parent:process.ppid}})+'\\n'));s.on('data',()=>{{setInterval(()=>{{}},60000);s.end();}});",tool_ready.local_addr().unwrap().port())).unwrap();
        let quote = |path: &std::path::Path| {
            format!(
                "'{}'",
                path.to_string_lossy()
                    .replace('\\', "/")
                    .replace('\'', "'\\''")
            )
        };
        let tool_command = format!(
            "{} {}; exit $?",
            quote(&bundle.join("node.exe")),
            quote(&script)
        );
        let http = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let model_address = http.local_addr().unwrap();
        let model = axum::Router::new().route("/v1/chat/completions",axum::routing::post(move || {
            let command=tool_command.clone(); async move {
                let first=json!({"id":"lifetime","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"long-child","type":"function","function":{"name":"bash","arguments":json!({"command":command}).to_string()}}]},"finish_reason":null}]});
                let end=json!({"id":"lifetime","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]});
                ([("content-type","text/event-stream")],format!("data: {first}\n\ndata: {end}\n\ndata: [DONE]\n\n"))
            }
        }));
        let provider = tokio::spawn(async move {
            axum::serve(http, model).await.unwrap();
        });
        if mode == "section" || service_mode {
            let work = root.path().join("workspace");
            fs::create_dir_all(&work).unwrap();
            db::open(&home)
                .unwrap()
                .execute(
                    "UPDATE bots SET approval_mode='off',workdir=?",
                    [work.to_string_lossy().as_ref()],
                )
                .unwrap();
            fs::write(home.join("profiles/owl/config.yaml"),format!("model:\n  provider: lmstudio\n  default: test-model\n  api_key: test-key\n  base_url: http://{model_address}/v1\ntools:\n  enabled_toolsets: [terminal]\n")).unwrap();
        } else {
            db::open(&home)
                .unwrap()
                .execute("UPDATE bots SET approval_mode='smart'", [])
                .unwrap();
            fs::write(home.join("profiles/owl/config.yaml"),"model:\n  provider: openai\n  default: gpt-4o-mini\ntools:\n  enabled_toolsets: []\n").unwrap();
        }
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
        // The forwarding candidate remains opt-in pending native A/B review.
        let forward = std::env::var("HEXBOT_SHUTDOWN_FORWARD_STDIO").as_deref() == Ok("1");
        let (mut command, witness) = if service_mode {
            let (command, listener) = service_parent_fixture::service_command(&nonce, forward).await;
            (command, Some(listener))
        } else {
            let mut daemon = Command::new(env!("CARGO_BIN_EXE_hexbot"));
            daemon.args(["serve", "--host", "127.0.0.1", "--port", "0"]);
            (daemon, None)
        };
        command
            .env("HEXBOT_HOME", &home)
            .env("HEXBOT_PI_EXECUTABLE", fixture.join("node.exe"))
            .env(
                "HEXBOT_SUPERVISOR",
                if service_mode { "service" } else { "desktop" },
            );
        if service_mode {
            command.env_remove("HEXBOT_DESKTOP_CONTROL");
        } else {
            command.env("HEXBOT_DESKTOP_CONTROL", "stdin-v1");
        }
        owned_reaped = false;
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .creation_flags(0x08000000)
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let supervisor_pid = child.id().unwrap();
        let mut startup = Startup::new(&mut child, witness, &nonce, forward);
        let mut daemon_pid = supervisor_pid;
        let mut handles = Vec::new();
        let result = std::panic::AssertUnwindSafe(async {
            let port = startup.ready(&mut child).await.unwrap_or_else(|error| panic!("{mode}: {error}"));
            let daemon_handle = startup.daemon.as_ref().expect("actual retained child before readiness");
            daemon_pid = daemon_handle.pid;
            let running:Value=serde_json::from_slice(&fs::read(home.join("runtime/native-running.json")).unwrap()).unwrap();
            assert_eq!(running["pid"],daemon_pid,"Readiness record must match the actual retained child");
            assert!(daemon_handle.alive() && peer_handle.alive());
            if service_mode {assert_ne!(daemon_pid,supervisor_pid);} else {assert_eq!(daemon_pid,supervisor_pid);}
            eprintln!("Shutdown {mode}: supervisor={supervisor_pid}; currentDaemon={}; independent={}",daemon_handle.snapshot(),peer_handle.snapshot());
            if mode == "section" {
                db::open(&home).unwrap().execute("INSERT INTO sections(id,bot,owner_id,title) VALUES('first-section','owl','local','Lifetime')",[]).unwrap();
            }
            let (mut socket, _) = connect_async(format!("ws://127.0.0.1:{port}/api/ws?token={token}")).await.unwrap();
            socket.send(Message::Text(json!({"jsonrpc":"2.0","id":"open-pi","method":"hexbot.sections.open","params":{"id":stored}}).to_string().into())).await.unwrap();
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
            let opened = tokio::time::timeout(Duration::from_secs(90), async {
                while let Some(frame) = socket.next().await {
                    let frame = frame.unwrap();
                    if !frame.is_text() { continue; }
                    let value: Value = serde_json::from_str(frame.to_text().unwrap()).unwrap();
                    if value["id"] == "open-pi" {
                        assert!(value.get("error").is_none(), "{mode}: Actual Pi open failed: {value}");
                        return value;
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
            if mode == "section" || service_mode {
                // The model calls the pinned Pi Bash tool, inside this real
                // daemon section, and blocks with a live shell + tool child.
                let first_id=opened["result"]["section"]["live_session_id"].as_str().unwrap();
                let submitted=rpc(&mut socket,"start-tool","prompt.submit",json!({"session_id":first_id,"text":"Run the lifetime fixture"})).await;
                assert!(submitted.get("error").is_none(),"{submitted}");
                let (mut tool_socket,_)=tokio::time::timeout(Duration::from_secs(45),tool_ready.accept()).await.unwrap().unwrap();
                let mut line=String::new();
                tokio::time::timeout(Duration::from_secs(15),BufReader::new(&mut tool_socket).read_line(&mut line)).await.unwrap().unwrap();
                let tool:Value=serde_json::from_str(&line).unwrap();
                let tool_handles=[ProcessHandle::open(tool["parent"].as_u64().unwrap() as u32),ProcessHandle::open(tool["pid"].as_u64().unwrap() as u32)];
                assert!(tool_handles.iter().all(ProcessHandle::alive));
                eprintln!("Section lifetime actual tool handles: {:?}",tool_handles.iter().map(ProcessHandle::snapshot).collect::<Vec<_>>());
                assert_ne!(tool_handles[0].pid,pi_pid,"Actual Bash must remain the tool child's parent");
                tool_socket.write_all(b"tracked\n").await.unwrap();
                if service_mode {handles.extend(tool_handles);} else {
                // Keep the actual tool identities available to panic cleanup,
                // even if this future unwinds before its close assertions.
                for handle in &tool_handles {handles.push(handle.try_clone().unwrap());}
                // Subsequent Pi instances run the original pinned launcher.
                // Keep a second section live throughout closing/rebuilding first.
                fs::write(fixture.join("pi/launch.mjs"),format!("await import({});\n",json!(launcher.as_str()))).unwrap();
                db::open(&home).unwrap().execute("INSERT INTO sections(id,bot,owner_id,title) VALUES('second','owl','local','Second')",[]).unwrap();
                let second = rpc(&mut socket,"second-open","hexbot.sections.open",json!({"id":"second"})).await;
                assert!(second.get("error").is_none(),"{second}");
                let second_id=second["result"]["section"]["live_session_id"].as_str().expect("live second session").to_owned();
                let children=Command::new(windows_paths::system_program("WindowsPowerShell/v1.0/powershell.exe").unwrap()).args(["-NoProfile","-NonInteractive","-Command",&query]).output().await.unwrap();
                assert!(children.status.success());
                let current:Vec<Value>=serde_json::from_slice(&children.stdout).unwrap();
                let second_handles=current.iter().filter_map(|row| {
                    let pid=row["ProcessId"].as_u64().unwrap() as u32;
                    (!handles.iter().any(|h| h.pid==pid) && pid!=descendant).then(||ProcessHandle::open(pid))
                }).collect::<Vec<_>>();
                assert_eq!(second_handles.len(),1,"Expected one newly opened Pi: {current:?}");
                let close=rpc(&mut socket,"close-first","hexbot.sections.close",json!({"id":stored})).await;
                assert!(close.get("error").is_none(),"{close}");
                // Cleanup completion must mean kernel exit, without waiting
                // on our own handles to turn an early reply into success.
                assert!(handles[..2].iter().all(|p| !p.alive()),"Section close left its Pi tree alive: {:?}",handles[..2].iter().map(ProcessHandle::snapshot).collect::<Vec<_>>());
                assert!(tool_handles.iter().all(|p| !p.alive()),"Section close left actual tool processes: {:?}",tool_handles.iter().map(ProcessHandle::snapshot).collect::<Vec<_>>());
                assert!(second_handles.iter().all(ProcessHandle::alive),"Section close affected another Pi");
                assert!(child.try_wait().unwrap().is_none(),"Section close killed daemon");
                let second_status=rpc(&mut socket,"second-status","session.status",json!({"session_id":second_id})).await;
                assert!(second_status.get("error").is_none(),"{second_status}");
                let rebuilt=rpc(&mut socket,"rebuild-first","hexbot.sections.open",json!({"id":stored})).await;
                assert!(rebuilt.get("error").is_none(),"{rebuilt}");
                assert!(second_handles.iter().all(ProcessHandle::alive),"Rebuild affected another Pi");
                let lock=fs::OpenOptions::new().read(true).write(true).open(home.join("native-daemon.lock")).unwrap();
                assert!(lock.try_lock().is_err(),"Live daemon lost its home lock");
                }
            }
            let mut input = child.stdin.take().unwrap();
            if matches!(mode,"command"|"section") { input.write_all(b"HEXBOT_SHUTDOWN_V1\n").await.unwrap(); }
            if mode=="service-exit" {input.write_all(b"exit\n").await.unwrap();}
            if mode == "force" || mode=="service-kill" { child.start_kill().unwrap(); }
            drop(input);
            let status = tokio::time::timeout(Duration::from_secs(15), child.wait()).await.unwrap().unwrap();
            if mode != "force" && mode!="service-kill" { assert_eq!(status.code(), Some(0), "{mode}: owned supervisor normal exit must be zero"); }
            daemon_handle.wait();
            if mode!="force" {
                assert_eq!(daemon_handle.snapshot()["exitCode"],0,"{mode}: daemon graceful exit must be zero");
                assert!(handles.iter().all(|p|!p.alive()),"{mode}: graceful daemon exit preceded descendant cleanup: {:?}",handles.iter().map(ProcessHandle::snapshot).collect::<Vec<_>>());
            }
            for process in &handles { process.wait(); }
            assert!(handles.iter().all(|p| !p.alive()), "{mode}: Pi survived owned shutdown");
            eprintln!("Shutdown {mode}/{nonce}: daemon exit={status}, descendants={:?}", handles.iter().map(ProcessHandle::snapshot).collect::<Vec<_>>());
            if mode != "force" { assert!(!home.join("serve-state.json").exists()); }
            let lock = fs::OpenOptions::new().read(true).write(true).open(home.join("native-daemon.lock")).unwrap();
            lock.try_lock().expect("Home lock was not released before restart");
            assert!(peer_handle.alive(),"Shutdown affected an independent daemon");
            let identity:Value=tokio::time::timeout(Duration::from_secs(5),async {reqwest::get(format!("http://127.0.0.1:{peer_port}/api/daemon/identity")).await.unwrap().json().await.unwrap()}).await.unwrap();
            assert_eq!(identity["pid"],peer_handle.pid);
            let peer_lock=fs::OpenOptions::new().read(true).write(true).open(peer_home.join("native-daemon.lock")).unwrap();
            assert!(peer_lock.try_lock().is_err(),"Independent daemon lost its home");
        }).catch_unwind().await;
        provider.abort();
        for entry in fs::read_dir(&evidence).into_iter().flatten().take(8).flatten() {
            let path = entry.path();
            if path.extension().is_some_and(|e| e == "jsonl") {
                let mut bytes = Vec::new();
                if let Ok(file) = fs::File::open(&path) {let _=std::io::Read::read_to_end(&mut std::io::Read::take(file,8192),&mut bytes);}
                eprintln!(
                    "Shutdown {mode}/{nonce} lifecycle {}: {}",
                    path.file_name().unwrap().to_string_lossy(),
                    String::from_utf8_lossy(&bytes[..bytes.len().min(8192)])
                );
            }
        }
        if let Err(error) = result {
            eprintln!(
                "Shutdown {mode}/{nonce} FAILED before cleanup: supervisor={:?}, processes={:?}",
                child.try_wait(),
                handles
                    .iter()
                    .map(ProcessHandle::snapshot)
                    .collect::<Vec<_>>()
            );
            eprintln!("Shutdown {mode}/{nonce} startup before cleanup: {}",startup.snapshot());
            eprintln!("Independent peer before failure cleanup: {}",peer_startup.snapshot());
            let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
            cleanup_deadline = Some(deadline);
            let _ = peer.start_kill();
            owned_reaped = startup.cleanup(&mut child, deadline).await;
            for handle in &handles {
                let remaining=deadline.saturating_duration_since(tokio::time::Instant::now());
                owned_reaped &= handle.exits_within(remaining.as_millis().min(u32::MAX as u128) as u32);
            }
            eprintln!("Owned descendants after failure cleanup: {:?}",handles.iter().map(ProcessHandle::snapshot).collect::<Vec<_>>());
            std::panic::resume_unwind(error);
        }
        owned_reaped = true;
        eprintln!("Shutdown {mode}/{nonce} completed startup/exit: {}", startup.snapshot());
    }
    peer.stdin
        .take()
        .unwrap()
        .write_all(b"HEXBOT_SHUTDOWN_V1\n")
        .await
        .unwrap();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(15), peer.wait())
            .await
            .unwrap()
            .unwrap()
            .code(),
        Some(0)
    );
    peer_handle.wait();
    }).catch_unwind().await;
    if let Err(error) = all {
        eprintln!(
            "Independent peer before cleanup: {}",
            peer_startup.snapshot()
        );
        let deadline = cleanup_deadline
            .unwrap_or_else(|| tokio::time::Instant::now() + Duration::from_secs(15));
        let peer_reaped = peer_startup.cleanup(&mut peer, deadline).await;
        if !owned_reaped || !peer_reaped {
            eprintln!(
                "Bounded owned cleanup FAILED; retained temporary state at {}",
                root.keep().display()
            );
        }
        std::panic::resume_unwind(error);
    }
}

#[path = "support/windows_process_handle.rs"]
mod process_handle;
use process_handle::ProcessHandle;

#[tokio::test]
#[ignore = "native Windows A/B control; each fresh-home case runs once and a failed A remains a test failure"]
async fn real_service_parent_stdio_control() {
    let bundle =
        PathBuf::from(std::env::var_os("HEXBOT_NATIVE_TEST_BUNDLE").expect("native bundle"));
    let mut outcomes = Vec::new();
    for forward in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("fresh service state");
        let nonce = hexbot_core::common::id();
        let (mut command, listener) =
            service_parent_fixture::service_command(&nonce, forward).await;
        let mut child = command
            .env("HEXBOT_HOME", &home)
            .env("HEXBOT_PI_EXECUTABLE", bundle.join("node.exe"))
            .env("HEXBOT_SUPERVISOR", "service")
            .env_remove("HEXBOT_DESKTOP_CONTROL")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .creation_flags(0x08000000)
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let mut startup = Startup::new(&mut child, Some(listener), &nonce, forward);
        let mut real_ready = false;
        let mut cleanup_deadline = None;
        let result = std::panic::AssertUnwindSafe(async {
            let port = startup
                .ready(&mut child)
                .await
                .unwrap_or_else(|error| panic!("Control forward={forward}: {error}"));
            assert_ne!(port, 0);
            real_ready = true;
            let daemon = startup.daemon.as_ref().unwrap();
            assert!(daemon.alive());
            let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
            cleanup_deadline = Some(deadline);
            let normal = deadline - Duration::from_secs(3);
            child
                .stdin
                .take()
                .unwrap()
                .write_all(b"exit\n")
                .await
                .unwrap();
            let status = tokio::time::timeout_at(normal, child.wait())
                .await
                .unwrap()
                .unwrap();
            assert_eq!(status.code(), Some(0));
            assert!(
                daemon.exits_within(
                    normal
                        .saturating_duration_since(tokio::time::Instant::now())
                        .as_millis() as u32
                ),
                "Service child did not complete after its real creator exited"
            );
            assert_eq!(
                daemon.snapshot()["exitCode"],
                0,
                "Graceful kernel completion is required before any failure fallback"
            );
            let lock = fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(home.join("native-daemon.lock"))
                .unwrap();
            lock.try_lock().expect("Control did not release its home");
        })
        .catch_unwind()
        .await;
        // Always record both cases, including A passing on this machine. No
        // missing READY or early child exit is an expected-success outcome.
        eprintln!(
            "Service A/B forward={forward} before cleanup: {}",
            startup.snapshot()
        );
        let passed = result.is_ok();
        let mut authenticated_listener = false;
        if !passed {
            let deadline = cleanup_deadline
                .unwrap_or_else(|| tokio::time::Instant::now() + Duration::from_secs(15));
            // Diagnostic only, within the SAME cleanup budget. At most its
            // first second is spent here, leaving the witness's 10s deadline
            // and the reserved force/reap time. Never substitutes for READY.
            let probe = async {
                let daemon = startup.daemon.as_ref()?;
                if !daemon.alive() {
                    return None;
                }
                let state: Value =
                    serde_json::from_slice(&fs::read(home.join("serve-state.json")).ok()?).ok()?;
                let port = u16::try_from(state["port"].as_u64()?).ok()?;
                let identity: Value = reqwest::Client::builder()
                    .no_proxy()
                    .build()
                    .ok()?
                    .get(format!("http://127.0.0.1:{port}/api/daemon/identity"))
                    .send()
                    .await
                    .ok()?
                    .json()
                    .await
                    .ok()?;
                if identity["pid"] != daemon.pid {
                    return None;
                }
                let token = auth::local_token(&home).ok()?;
                let (_socket, _) =
                    connect_async(format!("ws://127.0.0.1:{port}/api/ws?token={token}"))
                        .await
                        .ok()?;
                Some(daemon.alive())
            };
            authenticated_listener =
                tokio::time::timeout_at(deadline - Duration::from_secs(14), probe)
                    .await
                    .ok()
                    .flatten()
                    == Some(true);
            eprintln!(
                "Service A/B forward={forward}: authenticated listener bound to retained child={authenticated_listener}; before cleanup {}",
                startup.snapshot()
            );
            if !startup.cleanup(&mut child, deadline).await {
                eprintln!(
                    "Control bounded cleanup FAILED; retained {}",
                    root.keep().display()
                );
            }
        }
        outcomes.push(json!({"forward":forward,"realReady":real_ready,"graceful":passed,"authenticatedListenerWithoutReady":!real_ready && authenticated_listener}));
    }
    eprintln!(
        "Service A/B outcomes: {outcomes:?}; A without READY plus its authenticated listener and B's real READY supports transport loss in this control only; otherwise a live unready A remains unknown. Historical cause is unproved."
    );
    assert!(
        outcomes.iter().all(|row| row["graceful"] == true),
        "A/B startup or graceful-exit contract failed; B cannot turn A's failure into a pass"
    );
}

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
