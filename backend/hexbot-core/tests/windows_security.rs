//! Run after combining the Windows build ports with the security foundation.
//! These tests prove refusal, not a working Windows sandbox.
#![cfg(windows)]

use hexbot_core::credentials::{self, Confine};

#[test]
fn windows_security_child_environment_preserves_only_allowed_locations() {
    for name in [
        "SystemRoot",
        "windir",
        "UserProfile",
        "appdata",
        "LocalAppData",
    ] {
        assert!(credentials::inherited_environment(name), "{name}");
    }
    for name in [
        "OPENAI_API_KEY",
        "AWS_SECRET_ACCESS_KEY",
        "ARBITRARY_CONNECTOR",
        "NODE_OPTIONS",
        "BASH_ENV",
        "PYTHONPATH",
        "COMSPEC",
        "PATHEXT",
    ] {
        assert!(!credentials::inherited_environment(name), "{name}");
    }
}

#[test]
fn windows_security_all_isolation_levels_refuse_before_launch_or_scan() {
    // A missing home and device paths must get the same explicit refusal. No
    // scanner, shell lookup, Python runtime or process limit probe may run first.
    for mode in [Confine::Workspace, Confine::ReadOnly, Confine::No] {
        for program in ["cmd.exe", "python.exe", "git.exe", r"\\.\pipe\hexbot"] {
            let error = credentials::isolated_command(
                std::path::Path::new(r"Z:\missing\hexbot"),
                program,
                &[std::path::PathBuf::from(r"\\.\pipe\workspace")],
                mode,
            )
            .unwrap_err();
            assert_eq!(error.code, 4302);
            assert!(
                error
                    .message
                    .contains("Windows tool isolation is not implemented")
            );
        }
    }
    assert!(!credentials::isolation_available());
    assert_eq!(credentials::sandbox(), None);
    assert!(credentials::require_isolation().is_err());
}

#[tokio::test]
async fn windows_security_runtime_refuses_code_before_approval() {
    use futures_util::FutureExt;
    use hexbot_core::{credentials, db, events::EventHub, runtime::Runtime};
    use serde_json::json;
    use std::{fs, path::PathBuf, time::Duration};

    let node =
        PathBuf::from(std::env::var_os("HEXBOT_WINDOWS_NODE").expect("absolute Node executable"));
    assert!(node.is_absolute() && node.is_file());
    let python = PathBuf::from(
        std::env::var_os("HEXBOT_WINDOWS_PYTHON").expect("absolute trusted Python executable"),
    );
    assert!(python.is_absolute() && python.is_file());
    let scratch = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(scratch.path()).unwrap();
    let home = root.join("home");
    let work = root.join("workspace");
    let fixture = root.join("fixture");
    for dir in [
        &home,
        &work,
        &fixture.join("pi"),
        &home.join("profiles/owl"),
    ] {
        fs::create_dir_all(dir).unwrap();
    }
    fs::copy(node, fixture.join("node.exe")).unwrap();
    fs::write(
        fixture.join("pi/launch.mjs"),
        include_str!("../../pi-runtime/fixtures/windows-daemon-pi.mjs"),
    )
    .unwrap();
    let managed = [
        "runtime/native-current.json",
        "runtime/native/build/hexbot.exe",
        "runtime/tools/code-python/Scripts/python.exe",
    ];
    for local in managed {
        let path = home.join(local);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, "keep").unwrap();
    }
    fs::write(work.join(".env"), "private").unwrap();
    fs::write(home.join("connect.json"), "private").unwrap();
    // Direct callers cannot get a command builder in any isolation level,
    // even with nonexistent homes, device inputs or apparent output grants.
    for mode in [
        credentials::Confine::Workspace,
        credentials::Confine::ReadOnly,
        credentials::Confine::No,
    ] {
        for program in ["cmd.exe", "python.exe", "git.exe", r"\\.\pipe\hexbot"] {
            let error = credentials::isolated_command(
                &root.join("missing"),
                program,
                &[PathBuf::from(r"\\.\pipe\workspace"), home.join("runtime")],
                mode,
            )
            .unwrap_err();
            assert_eq!(error.code, 4302);
            assert!(
                error
                    .message
                    .contains("Windows tool isolation is not implemented")
            );
        }
    }
    assert!(credentials::require_isolation().is_err());
    assert!(!credentials::isolation_available());
    db::migrate(&home).unwrap();
    db::open(&home)
        .unwrap()
        .execute_batch(
            "INSERT INTO users(id,display_name,role,created_at) VALUES('alice','Alice','admin',0);\
         INSERT INTO bots(name,owner_id) VALUES('owl','alice');\
         INSERT INTO sections(id,bot,owner_id,title) VALUES('first','owl','alice','First');",
        )
        .unwrap();
    db::open(&home)
        .unwrap()
        .execute(
            "INSERT OR REPLACE INTO settings(key,value) VALUES('workspace_dir',?)",
            [json!(work).to_string()],
        )
        .unwrap();
    fs::write(home.join("profiles/owl/config.yaml"), json!({"model":{"provider":"openai","default":"fixture"},"tools":{"enabled_toolsets":["code_execution","file"]},"code_execution":{"python":python}}).to_string()).unwrap();
    let hub = EventHub::new();
    let runtime = Runtime::new(home.clone(), hub.clone(), fixture.join("node.exe")).unwrap();
    let scheduler =
        hexbot_core::dreaming::Dreaming::new(home.clone(), runtime.clone(), hub.clone());
    let result = async {
        for mode in ["smart", "manual"] {
            db::open(&home)
                .unwrap()
                .execute("UPDATE bots SET approval_mode=?", [mode])
                .unwrap();
            let opened = runtime
                .call("alice", "hexbot.sections.open", &json!({"id":"first"}))
                .await
                .unwrap()
                .unwrap();
            let live = opened["section"]["live_session_id"].as_str().unwrap();
            let mut events = hub.subscribe();
            runtime
                .call(
                    "alice",
                    "prompt.submit",
                    &json!({"session_id":live,"text":"native refusal probe"}),
                )
                .await
                .unwrap()
                .unwrap();
            let reply = native_reply(&mut events).await;
            assert!(
                reply["error"]
                    .as_str()
                    .unwrap()
                    .contains("Windows tool isolation is not implemented")
            );
        }
        for mode in ["smart", "manual"] {
            // Real Python starts under Bypass. Change its live policy while it
            // waits on a socket, then exercise that same worker's native bridge.
            db::open(&home)
                .unwrap()
                .execute("UPDATE bots SET approval_mode='off'", [])
                .unwrap();
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let target = home.join("runtime/native-current.json");
            let code = format!(
                r#"import socket, hermes_tools
s=socket.create_connection(('127.0.0.1', {port}))
s.recv(1)
for name, args in [('write_file', {{'path':{target},'content':'changed'}}), ('patch', {{'path':{target},'old_string':'keep','new_string':'changed'}}), ('read_file', {{'path':r'\\.\pipe\hexbot-security-untrusted'}}), ('read_file', {{'path':r'\\hexbot-hostile.invalid\share\secret'}})]:
    try:
        print(getattr(hermes_tools,name)(**args))
    except RuntimeError as error:
        print('bridge-denied:'+str(error))
s.close()
"#,
                target = json!(target)
            );
            fs::write(fixture.join("code.json"), json!({"code":code}).to_string()).unwrap();
            let opened = runtime
                .call("alice", "hexbot.sections.open", &json!({"id":"first"}))
                .await
                .unwrap()
                .unwrap();
            let live = opened["section"]["live_session_id"].as_str().unwrap();
            let mut events = hub.subscribe();
            runtime
                .call(
                    "alice",
                    "prompt.submit",
                    &json!({"session_id":live,"text":json!({"code":code}).to_string()}),
                )
                .await
                .unwrap()
                .unwrap();
            let (mut socket,_) = tokio::time::timeout(Duration::from_secs(15), async {
                loop {
                    tokio::select! {
                        connection = listener.accept() => break connection.unwrap(),
                        event = events.recv() => assert_ne!(event.unwrap().frame["params"]["type"], "approval.request", "Bypass must not ask for missing bubblewrap"),
                    }
                }
            }).await.expect("Bypass Python connected");
            db::open(&home)
                .unwrap()
                .execute("UPDATE bots SET approval_mode=?", [mode])
                .unwrap();
            use tokio::io::AsyncWriteExt;
            socket.write_all(b"x").await.unwrap();
            let reply = native_reply(&mut events).await;
            assert_eq!(reply["result"]["success"], true, "{reply}");
            let output = reply["result"]["output"].as_str().unwrap();
            assert_eq!(
                output
                    .matches("bridge-denied:Windows tool isolation is not implemented")
                    .count(),
                4,
                "{reply}"
            );
            assert_eq!(fs::read_to_string(target).unwrap(), "keep");
        }
        for mode in ["smart", "manual", "off"] {
            db::open(&home)
                .unwrap()
                .execute("UPDATE bots SET approval_mode=?", [mode])
                .unwrap();
            for key in ["script", "monitor_script"] {
                for path in [
                    r"\\.\pipe\hexbot-security-untrusted",
                    r"\\hexbot-hostile.invalid\share\probe.py",
                    r"Z:\missing\probe.py",
                ] {
                    let mut request = json!({"action":"create","schedule":"1h","prompt":"probe"});
                    request[key] = json!(path);
                    let created = scheduler.tool_call("alice", "owl", &request).await.unwrap();
                    let id = created["job"]["id"].as_str().unwrap();
                    // Simulate a stored job whose workdir became hostile after
                    // creation. Execution must refuse before revalidation I/O.
                    hexbot_core::runtime_store::open(&home).unwrap().execute(
                        "UPDATE native_jobs SET job_json=json_set(job_json,'$.workdir',?) WHERE id=?",
                        rusqlite::params![path, id],
                    ).unwrap();
                    let mut events = hub.subscribe();
                    scheduler
                        .tool_call("alice", "owl", &json!({"action":"run","job_id":id}))
                        .await
                        .unwrap();
                    tokio::time::timeout(Duration::from_secs(15), async {
                        loop {
                            let event = events.recv().await.unwrap();
                            assert_ne!(event.frame["params"]["type"], "approval.request");
                            if event.frame["params"]["type"] == "hexbot.scheduled.changed" {
                                let job = &event.frame["params"]["payload"]["job"];
                                if job["id"] != id {
                                    continue;
                                }
                                assert_eq!(job["last_status"], "error");
                                assert!(
                                    job["last_error"]
                                        .as_str()
                                        .unwrap()
                                        .contains("Windows tool isolation is not implemented"),
                                    "{job}"
                                );
                                break;
                            }
                        }
                    })
                    .await
                    .expect("script refused before path access");
                }
            }
        }
        for local in managed {
            assert_eq!(fs::read_to_string(home.join(local)).unwrap(), "keep");
        }
        assert_eq!(fs::read_to_string(work.join(".env")).unwrap(), "private");
        assert_eq!(
            fs::read_to_string(home.join("connect.json")).unwrap(),
            "private"
        );
    };
    // Keep the owned Pi process alive only for this probe, even on failure.
    let result = std::panic::AssertUnwindSafe(result).catch_unwind().await;
    scheduler.shutdown().await;
    runtime.shutdown().await;
    let pid: u32 = fs::read_to_string(fixture.join("fixture.pid"))
        .unwrap()
        .parse()
        .unwrap();
    assert!(
        !hexbot_core::osutil::process_alive(pid),
        "owned Pi fixture must exit during shutdown"
    );
    result.unwrap();
    println!("Native Rust daemon refusal probes passed");
}

async fn native_reply(
    events: &mut tokio::sync::broadcast::Receiver<hexbot_core::events::Event>,
) -> serde_json::Value {
    tokio::time::timeout(std::time::Duration::from_secs(15), async {
        let mut reply = None;
        loop {
            let event = events.recv().await.unwrap();
            let kind = &event.frame["params"]["type"];
            assert_ne!(
                kind, "approval.request",
                "the bridge must refuse before approval"
            );
            if let Some(text) = event.frame["params"]["payload"]["text"].as_str()
                && let Some(value) = text.strip_prefix("native-boundary:")
            {
                reply = Some(serde_json::from_str(value).unwrap());
            }
            if kind == "message.complete" {
                return reply.expect("native bridge reply before settlement");
            }
        }
    })
    .await
    .expect("native bridge settled without blocking on paths or approval")
}

#[tokio::test]
async fn windows_security_acp_refuses_before_path_or_command_resolution() {
    for home in [
        r"\\.\pipe\hexbot-security-untrusted",
        r"\\hexbot-hostile.invalid\share",
        r"Z:\missing",
    ] {
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            hexbot_core::provider_acp::complete(
                std::path::Path::new(home),
                "owl",
                "first",
                &serde_json::json!({}),
            ),
        )
        .await
        .expect("ACP must refuse immediately");
        let error = result.unwrap_err();
        assert_eq!(error.code, 4302);
        assert!(
            error
                .message
                .contains("Windows tool isolation is not implemented")
        );
    }
}
