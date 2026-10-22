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
    fs::copy(&node, fixture.join("node.exe")).unwrap();
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
                .expect("sections.open is a registered Runtime method")
                .unwrap_or_else(|error| panic!("Runtime open in {mode} before refusal: {error:?}"));
            let live = opened["section"]["live_session_id"].as_str().unwrap();
            let absent_workdir = work.join(format!("untrusted-{mode}"));
            let absent_output = home.join("runtime/sessions/first/attachments");
            if absent_output.exists() {
                fs::remove_dir(&absent_output).unwrap();
            }
            db::open(&home)
                .unwrap()
                .execute(
                    "UPDATE bots SET workdir=?",
                    [absent_workdir.to_str().unwrap()],
                )
                .unwrap();
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
            assert!(
                !absent_workdir.exists(),
                "execute_code resolved the untrusted workdir before refusal"
            );
            assert!(
                !absent_output.exists(),
                "execute_code created outputs before refusal"
            );
            // Pi's settings refresh must use the same preaccess boundary.
            fs::write(
                fixture.join("code.json"),
                json!({"tool":"hexbot_session_settings"}).to_string(),
            )
            .unwrap();
            let mut events = hub.subscribe();
            runtime
                .call(
                    "alice",
                    "prompt.submit",
                    &json!({"session_id":live,"text":"settings preaccess probe"}),
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
            assert!(!absent_workdir.exists());
            assert!(!absent_output.exists());
            fs::remove_file(fixture.join("code.json")).unwrap();
            db::open(&home)
                .unwrap()
                .execute("UPDATE bots SET workdir=?", [work.to_str().unwrap()])
                .unwrap();
        }
        for mode in ["smart", "manual", "off"] {
            db::open(&home)
                .unwrap()
                .execute(
                    "UPDATE bots SET approval_mode=?,workdir=?",
                    rusqlite::params![mode, work.to_str().unwrap()],
                )
                .unwrap();
            let opened = runtime
                .call("alice", "hexbot.sections.open", &json!({"id":"first"}))
                .await
                .unwrap()
                .unwrap();
            let live = opened["section"]["live_session_id"].as_str().unwrap();
            db::open(&home)
                .unwrap()
                .execute(
                    "UPDATE bots SET workdir=?",
                    [r"\\hexbot-hostile.invalid\share\private-file-workdir"],
                )
                .unwrap();
            for operation in ["write", "edit_open", "edit_commit"] {
                let absent_output = home.join("runtime/sessions/first/attachments");
                if absent_output.exists() {
                    fs::remove_dir(&absent_output).unwrap();
                }
                fs::write(fixture.join("code.json"),json!({"tool":"hexbot_pi_file","args":{"operation":operation,"path":r"\\.\pipe\hexbot-private-file","callId":"private-file","snapshot":{"approvalMode":mode,"fileEpoch":0},"content":"eA==","parent":["0","0"]}}).to_string()).unwrap();
                let mut events = hub.subscribe();
                runtime
                    .call(
                        "alice",
                        "prompt.submit",
                        &json!({"session_id":live,"text":"private file preaccess probe"}),
                    )
                    .await
                    .unwrap()
                    .unwrap();
                let reply = native_reply(&mut events).await;
                assert!(
                    reply["error"]
                        .as_str()
                        .unwrap()
                        .contains("Windows tool isolation is not implemented"),
                    "{reply}"
                );
                assert!(
                    !absent_output.exists(),
                    "private file bridge created outputs before refusal"
                );
            }
            fs::remove_file(fixture.join("code.json")).unwrap();
            db::open(&home)
                .unwrap()
                .execute("UPDATE bots SET workdir=?", [work.to_str().unwrap()])
                .unwrap();
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
                .execute(
                    "UPDATE bots SET approval_mode=?,workdir=?",
                    rusqlite::params![mode, r"\\hexbot-hostile.invalid\share\workdir"],
                )
                .unwrap();
            let absent_output = home.join("runtime/sessions/first/attachments");
            if absent_output.exists() {
                fs::remove_dir(&absent_output).unwrap();
            }
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
            assert!(
                !absent_output.exists(),
                "native callback created outputs before support refusal"
            );
            db::open(&home)
                .unwrap()
                .execute("UPDATE bots SET workdir=?", [work.to_str().unwrap()])
                .unwrap();
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
                    let input_key = if key == "monitor_script" {
                        "monitor"
                    } else {
                        "script"
                    };
                    let mut request =
                        json!({"action":"create","schedule":"1h","prompt":"probe","workdir":path});
                    request[input_key] = json!(path);
                    let error = scheduler
                        .tool_call("alice", "owl", &request)
                        .await
                        .unwrap_err();
                    assert!(
                        error
                            .message
                            .contains("Windows tool isolation is not implemented"),
                        "{error:?}"
                    );
                    let created = scheduler
                        .tool_call(
                            "alice",
                            "owl",
                            &json!({"action":"create","schedule":"1h","prompt":"probe"}),
                        )
                        .await
                        .unwrap();
                    let id = created["job"]["id"].as_str().unwrap();
                    request["action"] = json!("update");
                    request["job_id"] = json!(id);
                    let error = scheduler
                        .tool_call("alice", "owl", &request)
                        .await
                        .unwrap_err();
                    assert!(
                        error
                            .message
                            .contains("Windows tool isolation is not implemented"),
                        "{error:?}"
                    );
                    // Stored jobs may predate this guard or change on disk.
                    hexbot_core::runtime_store::open(&home).unwrap().execute(
                        "UPDATE native_jobs SET job_json=json_set(job_json,'$.workdir',?,?,?) WHERE id=?",
                        rusqlite::params![path, format!("$.{key}"), path, id],
                    ).unwrap();
                    let error = scheduler
                        .tool_call(
                            "alice",
                            "owl",
                            &json!({"action":"update","job_id":id,"workdir":path}),
                        )
                        .await
                        .unwrap_err();
                    assert!(
                        error
                            .message
                            .contains("Windows tool isolation is not implemented"),
                        "{error:?}"
                    );
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
    // Report cleanup separately, then resume the original panic. A missing
    // startup record must not replace the error that explains why startup failed.
    let records_path = fixture.join("fixture.events.jsonl");
    let cleanup = (|| -> Result<(), String> {
        let records = fs::read_to_string(&records_path)
            .map_err(|error| format!("{}: {error}", records_path.display()))?;
        let mut started = 0;
        for line in records.lines() {
            let record: serde_json::Value = serde_json::from_str(line)
                .map_err(|error| format!("{}: {error}", records_path.display()))?;
            eprintln!("Trusted Pi fixture lifecycle: {record}");
            if record["event"] == "start" {
                let pid = record["pid"].as_u64().ok_or("fixture start without PID")?;
                let pid = u32::try_from(pid).map_err(|error| error.to_string())?;
                started += 1;
                if hexbot_core::osutil::process_alive(pid) {
                    return Err(format!("owned Pi fixture {pid} survived shutdown"));
                }
            }
        }
        if started == 0 {
            return Err("no Runtime-owned Pi fixture started".into());
        }
        Ok(())
    })();
    if result.is_err() || cleanup.is_err() {
        eprintln!(
            "Trusted probe paths: node={}, launcher={}, python={}, home={}",
            fixture.join("node.exe").display(),
            fixture.join("pi/launch.mjs").display(),
            python.display(),
            home.display()
        );
        if let Err(error) = &cleanup {
            eprintln!("Fixture cleanup diagnostic: {error}");
        }
        // Production Pi deliberately discards stderr, which may contain secrets.
        // Only this fixed, trusted fixture is rerun with bounded capture. It
        // receives no prompt, provider settings or credential environment.
        let mut command = tokio::process::Command::new(&node);
        credentials::shell_environment(&mut command);
        command
            .arg(scratch.path().join("fixture/pi/launch.mjs"))
            .arg("--hexbot-fixture-diagnose")
            .current_dir(&work)
            .kill_on_drop(true);
        match tokio::time::timeout(Duration::from_secs(5), command.output()).await {
            Ok(Ok(output)) => eprintln!(
                "Trusted fixture loader: status={}, stdout={}, stderr={}",
                output.status,
                String::from_utf8_lossy(&output.stdout[..output.stdout.len().min(8192)]),
                String::from_utf8_lossy(&output.stderr[..output.stderr.len().min(8192)])
            ),
            Ok(Err(error)) => eprintln!("Trusted fixture loader could not spawn: {error}"),
            Err(_) => eprintln!("Trusted fixture loader timed out"),
        }
    }
    if let Err(error) = result {
        std::panic::resume_unwind(error);
    }
    assert!(cleanup.is_ok(), "{cleanup:?}");
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
        for reviewer in [false, true] {
            let run = async {
                if reviewer {
                    hexbot_core::provider_acp::complete_reviewer(
                        std::path::Path::new(home),
                        "owl",
                        "first",
                        &serde_json::json!({}),
                        std::path::Path::new(r"\\.\pipe\untrusted-review-cwd"),
                    )
                    .await
                } else {
                    hexbot_core::provider_acp::complete(
                        std::path::Path::new(home),
                        "owl",
                        "first",
                        &serde_json::json!({}),
                    )
                    .await
                }
            };
            let result = tokio::time::timeout(std::time::Duration::from_secs(2), run)
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
}

#[tokio::test]
async fn windows_security_stored_script_and_monitor_pause_without_path_validation() {
    use hexbot_core::{db, dreaming::Dreaming, events::EventHub, runtime::Runtime, runtime_store};
    use serde_json::json;
    let scratch = tempfile::tempdir().unwrap();
    let home = scratch.path().join("home");
    db::migrate(&home).unwrap();
    db::open(&home).unwrap().execute_batch("INSERT INTO users(id,display_name,role,created_at) VALUES('alice','Alice','admin',0); INSERT INTO bots(name,owner_id) VALUES('owl','alice');").unwrap();
    let events = EventHub::new();
    // This path must never be launched: pause/list/remove need no Pi process.
    let runtime = Runtime::new(
        home.clone(),
        events.clone(),
        home.join("must-not-spawn.exe"),
    )
    .unwrap();
    let scheduler = Dreaming::new(home.clone(), runtime, events);
    for mode in ["smart", "manual", "off"] {
        db::open(&home)
            .unwrap()
            .execute("UPDATE bots SET approval_mode=?", [mode])
            .unwrap();
        for key in ["script", "monitor_script"] {
            for path in [
                r"\\hexbot-hostile.invalid\share\untrusted",
                r"\\.\pipe\hexbot-untrusted",
            ] {
                let created = scheduler
                    .tool_call(
                        "alice",
                        "owl",
                        &json!({"action":"create","schedule":"1h","prompt":"probe"}),
                    )
                    .await
                    .unwrap();
                let id = created["job"]["id"].as_str().unwrap();
                runtime_store::open(&home).unwrap().execute(
                    "UPDATE native_jobs SET job_json=json_set(job_json,'$.workdir',?,?,?) WHERE id=?",
                    rusqlite::params![path, format!("$.{key}"), path, id],
                ).unwrap();
                let paused = scheduler
                    .call(
                        "alice",
                        "hexbot.jobs.pause",
                        &json!({"bot":"owl","job_id":id}),
                    )
                    .await
                    .unwrap()
                    .unwrap();
                assert_eq!(paused["job"]["enabled"], false);
                assert_eq!(paused["job"]["state"], "paused");
                let listed = scheduler
                    .tool_call(
                        "alice",
                        "owl",
                        &json!({"action":"list","include_disabled":true}),
                    )
                    .await
                    .unwrap();
                let stored = &listed["jobs"][0];
                assert_eq!(stored["id"], id);
                assert_eq!(stored["enabled"], false);
                assert_eq!(stored["state"], "paused");
                assert_eq!(
                    stored[key], path,
                    "pause must not resolve or change a script path"
                );
                assert_eq!(stored["workdir"], path);
                for action in ["update", "resume"] {
                    let error = scheduler
                        .tool_call("alice", "owl", &json!({"action":action,"job_id":id}))
                        .await
                        .unwrap_err();
                    assert_eq!(error.code, 4302);
                    assert!(
                        error
                            .message
                            .contains("Windows tool isolation is not implemented")
                    );
                }
                let still_paused = scheduler
                    .tool_call(
                        "alice",
                        "owl",
                        &json!({"action":"list","include_disabled":true}),
                    )
                    .await
                    .unwrap();
                assert_eq!(still_paused["jobs"][0]["enabled"], false);
                assert_eq!(still_paused["jobs"][0]["state"], "paused");
                scheduler
                    .call(
                        "alice",
                        "hexbot.jobs.remove",
                        &json!({"bot":"owl","job_id":id}),
                    )
                    .await
                    .unwrap()
                    .unwrap();
                let empty = scheduler
                    .tool_call(
                        "alice",
                        "owl",
                        &json!({"action":"list","include_disabled":true}),
                    )
                    .await
                    .unwrap();
                assert_eq!(empty["jobs"], json!([]));
            }
        }
    }
    scheduler.shutdown().await;
}
