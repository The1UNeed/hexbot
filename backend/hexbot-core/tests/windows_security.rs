//! The daemon's Windows execution boundary, run as a standard user against
//! real AppContainers: Auto and Manual commands and scheduled scripts run
//! through the sandbox helper; Pi's write and edit go through the daemon's
//! handle bridge with a live policy snapshot; full_access, the Python worker
//! and Copilot refuse; and network, device and stream paths are refused by
//! their text before anything opens them. CI runs it as a new local standard
//! user (`scripts/dev/windows-security-standard-user.ps1`).
#![cfg(windows)]

use base64::Engine;
use hexbot_core::credentials::{self, Confine};
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

/// The daemon binary, which runs `sandbox exec` for this test executable.
fn helper() -> PathBuf {
    let hexbot = PathBuf::from(
        std::env::var_os("HEXBOT_WINDOWS_HEXBOT").expect("absolute daemon executable"),
    );
    assert!(hexbot.is_absolute() && hexbot.is_file());
    credentials::use_sandbox_helper(hexbot.clone());
    hexbot
}

fn cmd() -> PathBuf {
    PathBuf::from(std::env::var_os("SystemRoot").unwrap())
        .join("System32")
        .join("cmd.exe")
}

/// `C:\x` rather than `\\?\C:\x`, as the daemon gives programs their paths.
fn plain(path: &Path) -> PathBuf {
    let text = path.to_str().unwrap();
    PathBuf::from(text.strip_prefix(r"\\?\").unwrap_or(text))
}

fn decoded(policy: &str) -> Value {
    serde_json::from_slice(
        &base64::engine::general_purpose::STANDARD
            .decode(policy)
            .unwrap(),
    )
    .unwrap()
}

fn contains(list: &Value, path: &Path) -> bool {
    list.as_array().unwrap().iter().any(|entry| {
        entry
            .as_str()
            .is_some_and(|entry| entry.eq_ignore_ascii_case(path.to_str().unwrap()))
    })
}

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

#[tokio::test]
async fn windows_security_auto_writes_manual_reads_and_full_access_refuses() {
    let hexbot = helper();
    assert_eq!(credentials::sandbox(), Some("appcontainer"));
    assert!(credentials::isolation_available());
    assert!(credentials::require_isolation().is_ok());
    let scratch = tempfile::tempdir().unwrap();
    let root = plain(&fs::canonicalize(scratch.path()).unwrap());
    let (home, work) = (root.join("home"), root.join("workspace"));
    fs::create_dir_all(home.join("runtime")).unwrap();
    fs::create_dir_all(&work).unwrap();
    fs::write(work.join(".env"), "private").unwrap();
    for (mode, access, writes) in [
        (Confine::Workspace, "workspace", true),
        (Confine::ReadOnly, "read", false),
    ] {
        let command = |script: &str| {
            let mut command = credentials::isolated_command(
                &home,
                cmd().to_str().unwrap(),
                std::slice::from_ref(&work),
                mode,
            )
            .unwrap();
            credentials::shell_environment(&mut command);
            command
                .args(["/d", "/c", script])
                .current_dir(&work)
                .kill_on_drop(true);
            command
        };
        let probe = command("echo contained>written.txt");
        let std = probe.as_std();
        assert_eq!(std.get_program(), hexbot.as_os_str());
        let args: Vec<String> = std
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        assert_eq!(args[..2], ["sandbox", "exec"]);
        assert_eq!(args[3..5], ["--", cmd().to_str().unwrap()]);
        let policy = decoded(&args[2]);
        assert_eq!(policy["access"], access);
        assert!(
            contains(&policy["deny_all"], &work.join(".env")),
            "{policy}"
        );
        // Every policy may run the runtime's shell, beside the helper.
        if let Some(staged) = std::env::var_os("HEXBOT_WINDOWS_BUSYBOX") {
            let named = policy["shell"].as_str().unwrap_or_default();
            assert!(
                named.eq_ignore_ascii_case(&staged.to_string_lossy()),
                "{policy}"
            );
        }
        let output = command("echo contained>written.txt")
            .output()
            .await
            .unwrap();
        assert_eq!(
            output.status.success(),
            writes,
            "{mode:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(work.join("written.txt").exists(), writes, "{mode:?}");
        let output = command("type .env").output().await.unwrap();
        assert!(!output.status.success(), "{mode:?} read a project secret");
        assert!(!String::from_utf8_lossy(&output.stdout).contains("private"));
        // The home's own stores are not granted at all: a contained command
        // can neither read nor write them.
        let store = home.join("connect.json");
        let output = command(&format!("type {}", store.to_str().unwrap()))
            .output()
            .await
            .unwrap();
        assert!(
            !output.status.success(),
            "{mode:?} read the home's connect file"
        );
        assert!(!String::from_utf8_lossy(&output.stdout).contains("private"));
        let profile_secret = home.join("profiles/owl/.env");
        let output = command(&format!("type {}", profile_secret.to_str().unwrap()))
            .output()
            .await
            .unwrap();
        assert!(
            !output.status.success(),
            "{mode:?} read a bot profile secret"
        );
        assert!(!String::from_utf8_lossy(&output.stdout).contains("private"));
        let _ = fs::remove_file(work.join("written.txt"));
    }
    let started = Instant::now();
    let error = credentials::isolated_command(
        &home,
        cmd().to_str().unwrap(),
        std::slice::from_ref(&work),
        Confine::No,
    )
    .unwrap_err();
    assert_eq!(error.code, 4302);
    assert!(
        error.message.contains("full_access is not available"),
        "{}",
        error.message
    );
    assert!(started.elapsed() < Duration::from_secs(2));
    assert_eq!(fs::read_to_string(work.join(".env")).unwrap(), "private");
    hexbot_core::windows_container::reset(&home).unwrap();
}

#[test]
fn windows_security_network_device_and_stream_paths_refuse_before_any_access() {
    helper();
    let scratch = tempfile::tempdir().unwrap();
    let root = plain(&fs::canonicalize(scratch.path()).unwrap());
    let (home, work) = (root.join("home"), root.join("workspace"));
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&work).unwrap();
    let cmd = cmd();
    let cmd = cmd.to_str().unwrap();
    for (path, reason) in [
        (r"\\hexbot-hostile.invalid\share\work", "network paths"),
        (
            r"\\?\UNC\hexbot-hostile.invalid\share\work",
            "network paths",
        ),
        (r"\\.\pipe\hexbot-workspace", "device or NT object paths"),
        (
            r"\\?\GLOBALROOT\Device\HarddiskVolume1\work",
            "device or NT object paths",
        ),
        (r"C:\hexbot-work\notes:stream", "alternate data stream"),
        (r"C:\hexbot-work\CON", "reserved Windows device name"),
        (r"C:\hexbot-work\nul.txt", "reserved Windows device name"),
    ] {
        for mode in [Confine::Workspace, Confine::ReadOnly] {
            let started = Instant::now();
            let error = credentials::isolated_command(&home, cmd, &[PathBuf::from(path)], mode)
                .unwrap_err();
            assert!(error.message.contains(reason), "{path}: {}", error.message);
            assert!(started.elapsed() < Duration::from_secs(2), "{path}");
        }
        // Some Windows versions make `C:\x\CON` the device `\\.\CON` when a
        // working folder is made absolute; either way it is refused.
        let error = hexbot_core::common::check_workdir(&home, path).unwrap_err();
        assert!(
            error.message.contains(reason)
                || (reason == "reserved Windows device name"
                    && error.message.contains("device or NT object paths")),
            "{path}: {}",
            error.message
        );
    }
    for (program, reason) in [
        ("cmd.exe", "by their full path"),
        ("python.exe", "by their full path"),
        ("git.exe", "by their full path"),
        (r"\\.\pipe\hexbot", "device or NT object paths"),
        (r"\\hexbot-hostile.invalid\share\tool.exe", "network paths"),
    ] {
        let error = credentials::isolated_command(
            &home,
            program,
            std::slice::from_ref(&work),
            Confine::Workspace,
        )
        .unwrap_err();
        assert!(
            error.message.contains(reason),
            "{program}: {}",
            error.message
        );
    }
    // A drive letter that names no drive is refused before it is opened.
    let missing = ('D'..='Z')
        .rev()
        .map(|drive| format!(r"{drive}:\"))
        .find(|root| !Path::new(root).exists())
        .expect("an unused drive letter");
    let error = hexbot_core::common::check_workdir(&home, &format!("{missing}hexbot")).unwrap_err();
    assert!(
        error.message.contains("not a local fixed drive"),
        "{}",
        error.message
    );
    hexbot_core::windows_container::reset(&home).unwrap();
}

#[tokio::test]
async fn windows_security_runtime_runs_sections_and_scripts_in_the_sandbox() {
    use futures_util::FutureExt;
    use hexbot_core::{db, events::EventHub, runtime::Runtime};

    let hexbot = helper();
    let node =
        PathBuf::from(std::env::var_os("HEXBOT_WINDOWS_NODE").expect("absolute Node executable"));
    assert!(node.is_absolute() && node.is_file());
    let python = PathBuf::from(
        std::env::var_os("HEXBOT_WINDOWS_PYTHON").expect("absolute trusted Python executable"),
    );
    assert!(python.is_absolute() && python.is_file());
    let scratch = tempfile::tempdir().unwrap();
    let root = plain(&fs::canonicalize(scratch.path()).unwrap());
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
    fs::write(home.join("profiles/owl/.env"), "private").unwrap();
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
    let set_workdir = |workdir: &str| {
        db::open(&home)
            .unwrap()
            .execute("UPDATE bots SET workdir=?", [workdir])
            .unwrap();
    };
    let result = async {
        let ask = async |live: &str, request: Option<Value>| {
            match request {
                Some(request) => fs::write(fixture.join("code.json"), request.to_string()).unwrap(),
                None => {
                    let _ = fs::remove_file(fixture.join("code.json"));
                }
            }
            let mut events = hub.subscribe();
            runtime
                .call(
                    "alice",
                    "prompt.submit",
                    &json!({"session_id":live,"text":"native boundary probe"}),
                )
                .await
                .unwrap()
                .unwrap();
            native_reply(&mut events).await
        };
        let absent_output = home.join("runtime/sessions/first/attachments");
        for mode in ["smart", "manual"] {
            db::open(&home)
                .unwrap()
                .execute("UPDATE bots SET approval_mode=?", [mode])
                .unwrap();
            let opened = runtime
                .call("alice", "hexbot.sections.open", &json!({"id":"first"}))
                .await
                .expect("sections.open is a registered Runtime method")
                .unwrap_or_else(|error| panic!("Runtime open in {mode}: {error:?}"));
            let live = opened["section"]["live_session_id"]
                .as_str()
                .unwrap()
                .to_owned();
            // The daemon's Python worker refuses before approval, the
            // working folder or the outputs.
            let absent_workdir = work.join(format!("untrusted-{mode}"));
            if absent_output.exists() {
                fs::remove_dir(&absent_output).unwrap();
            }
            set_workdir(absent_workdir.to_str().unwrap());
            let reply = ask(&live, None).await;
            assert!(
                reply["error"]
                    .as_str()
                    .unwrap()
                    .contains("code runs on the bot's own computer"),
                "{reply}"
            );
            assert!(!absent_workdir.exists());
            assert!(!absent_output.exists());
            // Session settings now resolve, and name the sandbox Pi uses.
            let reply = ask(&live, Some(json!({"tool":"hexbot_session_settings"}))).await;
            let settings = &reply["result"];
            assert_eq!(settings["sandbox"]["kind"], "appcontainer", "{reply}");
            assert_eq!(settings["sandbox"]["helper"], json!(hexbot));
            // The runtime's shell for Pi's commands, BusyBox, when it starts
            // in the sandbox, or why not.
            let shell = &settings["sandbox"]["shell"];
            assert_ne!(
                shell.is_object(),
                settings["sandbox"]["shellRefusal"].is_string(),
                "{reply}"
            );
            if shell.is_object() {
                assert_eq!(shell["kind"], "busybox", "{reply}");
                assert!(Path::new(shell["path"].as_str().unwrap()).is_file());
            }
            assert_eq!(settings["cwd"], json!(absent_workdir));
            assert!(absent_workdir.is_dir() && absent_output.is_dir());
            // A network working folder refuses by its text, before outputs.
            fs::remove_dir(&absent_output).unwrap();
            set_workdir(r"\\hexbot-hostile.invalid\share\workspace");
            let reply = ask(&live, Some(json!({"tool":"hexbot_session_settings"}))).await;
            assert!(
                reply["error"].as_str().unwrap().contains("network paths"),
                "{reply}"
            );
            assert!(!absent_output.exists());
            set_workdir(work.to_str().unwrap());
            // Pi's commands get the helper and a policy for this section.
            let reply = ask(
                &live,
                Some(json!({"tool":"hexbot_sandbox_policy","args":{"level":"confined"}})),
            )
            .await;
            assert_eq!(reply["result"]["helper"], json!(hexbot), "{reply}");
            let encoded = reply["result"]["policy"].as_str().unwrap().to_owned();
            let policy = decoded(&encoded);
            let auto = mode == "smart";
            assert_eq!(policy["access"], if auto { "workspace" } else { "read" });
            assert!(contains(&policy["deny_all"], &work.join(".env")));
            let marker = format!("pi-{mode}.txt");
            let mut command = tokio::process::Command::new(&hexbot);
            credentials::shell_environment(&mut command);
            let output = command
                .args(["sandbox", "exec", &encoded, "--"])
                .arg(cmd())
                .args(["/d", "/c", &format!("echo pi>{marker}")])
                .current_dir(&work)
                .kill_on_drop(true)
                .output()
                .await
                .unwrap();
            assert_eq!(output.status.success(), auto, "{mode}");
            assert_eq!(work.join(&marker).exists(), auto, "{mode}");
            let reply = ask(
                &live,
                Some(json!({"tool":"hexbot_sandbox_policy","args":{"level":"base"}})),
            )
            .await;
            assert!(
                reply["error"]
                    .as_str()
                    .unwrap()
                    .contains("full_access is not available"),
                "{reply}"
            );
        }
        // Pi's restricted write and edit run through the daemon's handle
        // bridge with the live policy's snapshot. A path is judged by its
        // text and drive before anything opens it, a stale snapshot or Bypass
        // refuses before the path is resolved, and an edit commits only to
        // the file it read.
        let missing_drive = ('D'..='Z')
            .rev()
            .map(|drive| format!(r"{drive}:\hexbot\file.txt"))
            .find(|path| !Path::new(&path[..3]).exists())
            .expect("an unused drive letter");
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
            let live = opened["section"]["live_session_id"]
                .as_str()
                .unwrap()
                .to_owned();
            if mode == "off" {
                let reply = ask(
                    &live,
                    Some(json!({"tool":"hexbot_sandbox_policy","args":{"level":"confined"}})),
                )
                .await;
                assert!(
                    reply["error"].as_str().unwrap().contains("Bypass"),
                    "{reply}"
                );
            }
            let settings =
                ask(&live, Some(json!({"tool":"hexbot_session_settings"}))).await["result"].clone();
            let snapshot = json!({"approvalMode":settings["approvalMode"],"cwd":settings["cwd"],"outputDirs":settings["outputDirs"],"fileWorkdir":settings["fileWorkdir"],"fileEpoch":settings["fileEpoch"]});
            let encode = |text: String| base64::engine::general_purpose::STANDARD.encode(text);
            // `opened` is what edit_open returned: the file's identity and the
            // version of the bytes it read, which a commit sends back.
            let request = |operation: &str, path: &Path, opened: Value| {
                Some(
                    json!({"tool":"hexbot_pi_file","args":{"operation":operation,"path":path,"callId":"private-file","snapshot":snapshot,"content":encode(format!("{operation}-{mode}")),"parent":opened["parent"],"opened":opened["version"]}}),
                )
            };
            let unopened = || json!({"parent":["0","0"],"version":"0".repeat(64)});
            let target = work.join(format!("bridge-{mode}")).join("file.txt");
            if mode == "off" {
                // Bypass writes through Pi itself, never through the bridge.
                let reply = ask(&live, request("write", &target, Value::Null)).await;
                assert!(
                    reply["error"]
                        .as_str()
                        .unwrap()
                        .contains("File policy changed"),
                    "{reply}"
                );
                assert!(!target.parent().unwrap().exists());
                continue;
            }
            let stream = format!(r"{}\notes.txt:stream", work.display());
            let reserved = format!(r"{}\nul.txt", work.display());
            let secret = work.join(".env");
            for (path, reason) in [
                (r"\\hexbot-hostile.invalid\share\file.txt", "network paths"),
                (r"\\.\pipe\hexbot-private-file", "device or NT object paths"),
                (stream.as_str(), "alternate data stream"),
                (reserved.as_str(), "reserved Windows device name"),
                (missing_drive.as_str(), "not a local fixed drive"),
                (secret.to_str().unwrap(), "protected"),
            ] {
                for operation in ["write", "edit_open", "edit_commit"] {
                    let reply = ask(
                        &live,
                        request(operation, Path::new(path), unopened()),
                    )
                    .await;
                    assert!(
                        reply["error"].as_str().unwrap().contains(reason),
                        "{operation} {path}: {reply}"
                    );
                }
            }
            assert!(!work.join("notes.txt").exists());
            assert_eq!(fs::read_to_string(&secret).unwrap(), "private");
            // The bridge writes as the daemon's user, so the repository's
            // configured Git metadata refuses by the scan commands use: a
            // hooksPath folder with an ordinary name, and the metadata folder
            // a linked worktree's .git file names. Written directly, no git.
            let repo = work.join("repo");
            let linked = work.join("meta").join("linked");
            for dir in [
                repo.join(".git").join("objects"),
                repo.join(".githooks"),
                linked.join("objects"),
                work.join("linked"),
            ] {
                fs::create_dir_all(dir).unwrap();
            }
            fs::write(repo.join(".git").join("HEAD"), "ref: refs/heads/main\n").unwrap();
            fs::write(
                repo.join(".git").join("config"),
                "[core]\n\thooksPath = .githooks\n",
            )
            .unwrap();
            let hook = repo.join(".githooks").join("pre-commit");
            fs::write(&hook, "#!/bin/sh\n").unwrap();
            fs::write(linked.join("HEAD"), "ref: refs/heads/main\n").unwrap();
            fs::write(work.join("linked").join(".git"), "gitdir: ../meta/linked\n").unwrap();
            for path in [
                hook.clone(),
                repo.join(".githooks").join("post-merge"),
                linked.join("config"),
            ] {
                for operation in ["write", "edit_open", "edit_commit"] {
                    let reply = ask(&live, request(operation, &path, unopened())).await;
                    assert!(
                        reply["error"]
                            .as_str()
                            .unwrap()
                            .contains("Git metadata is read-only"),
                        "{operation} {}: {reply}",
                        path.display()
                    );
                }
            }
            assert_eq!(fs::read_to_string(&hook).unwrap(), "#!/bin/sh\n");
            assert!(!repo.join(".githooks").join("post-merge").exists());
            assert!(!linked.join("config").exists());
            let ordinary = repo.join("src").join("main.txt");
            let reply = ask(&live, request("write", &ordinary, Value::Null)).await;
            assert_eq!(reply["result"], json!({"success":true}), "{reply}");
            assert_eq!(
                fs::read_to_string(&ordinary).unwrap(),
                format!("write-{mode}")
            );
            // Later commands and scripts run in a workspace without them.
            fs::remove_dir_all(&repo).unwrap();
            fs::remove_dir_all(work.join("meta")).unwrap();
            fs::remove_dir_all(work.join("linked")).unwrap();
            // A write creates its folder; an edit reads the file's bytes and
            // commits only to the file it read.
            let reply = ask(&live, request("write", &target, Value::Null)).await;
            assert_eq!(reply["result"], json!({"success":true}), "{reply}");
            assert_eq!(
                fs::read_to_string(&target).unwrap(),
                format!("write-{mode}")
            );
            let opened = ask(&live, request("edit_open", &target, Value::Null)).await;
            assert_eq!(
                opened["result"]["content"],
                encode(format!("write-{mode}")),
                "{opened}"
            );
            fs::remove_file(&target).unwrap();
            fs::write(&target, "replacement").unwrap();
            let reply = ask(
                &live,
                request("edit_commit", &target, opened["result"].clone()),
            )
            .await;
            assert!(
                reply["error"].as_str().unwrap().contains("file changed"),
                "{reply}"
            );
            assert_eq!(fs::read_to_string(&target).unwrap(), "replacement");
            let opened = ask(&live, request("edit_open", &target, Value::Null)).await;
            let reply = ask(
                &live,
                request("edit_commit", &target, opened["result"].clone()),
            )
            .await;
            assert_eq!(reply["result"], json!({"success":true}), "{reply}");
            assert_eq!(
                fs::read_to_string(&target).unwrap(),
                format!("edit_commit-{mode}")
            );
            // A snapshot of another working folder refuses before the path is
            // resolved or its folder created, and a working folder that moved
            // to a network share is refused by its text.
            let elsewhere = work.join(format!("stale-{mode}")).join("file.txt");
            let mut stale = request("write", &elsewhere, Value::Null).unwrap();
            stale["args"]["snapshot"]["fileWorkdir"] = json!("changed");
            let reply = ask(&live, Some(stale)).await;
            assert!(
                reply["error"]
                    .as_str()
                    .unwrap()
                    .contains("File policy changed"),
                "{reply}"
            );
            let network = r"\\hexbot-hostile.invalid\share\private-file-workdir";
            set_workdir(network);
            let mut moved = request("write", &elsewhere, Value::Null).unwrap();
            moved["args"]["snapshot"]["fileWorkdir"] = json!(network);
            let reply = ask(&live, Some(moved)).await;
            assert!(
                reply["error"].as_str().unwrap().contains("network paths"),
                "{reply}"
            );
            assert!(!elsewhere.parent().unwrap().exists());
            set_workdir(work.to_str().unwrap());
        }
        // Scheduled scripts: network and device paths refuse by their text;
        // Auto runs a shell script that writes the workspace, Manual's
        // writes nothing.
        let wait =
            async |events: &mut tokio::sync::broadcast::Receiver<hexbot_core::events::Event>,
                   id: &str| {
                tokio::time::timeout(Duration::from_secs(120), async {
                    loop {
                        let event = events.recv().await.unwrap();
                        assert_ne!(event.frame["params"]["type"], "approval.request");
                        if event.frame["params"]["type"] == "hexbot.scheduled.changed" {
                            let job = &event.frame["params"]["payload"]["job"];
                            if job["id"] == id && job["last_status"].is_string() {
                                return job.clone();
                            }
                        }
                    }
                })
                .await
                .expect("the script finished")
            };
        let create = async |request: Value| {
            scheduler
                .tool_call("alice", "owl", &request)
                .await
                .map(|created| created["job"]["id"].as_str().unwrap().to_owned())
        };
        for mode in ["smart", "manual"] {
            db::open(&home)
                .unwrap()
                .execute("UPDATE bots SET approval_mode=?", [mode])
                .unwrap();
            for path in [
                r"\\.\pipe\hexbot-security-untrusted",
                r"\\hexbot-hostile.invalid\share\probe.py",
            ] {
                let error = create(json!({"action":"create","schedule":"1h","prompt":"probe","script":"probe.sh","workdir":path,"no_agent":true}))
                    .await
                    .unwrap_err();
                assert!(
                    error.message.starts_with("Sandbox paths cannot be"),
                    "{error:?}"
                );
                let id = create(json!({"action":"create","schedule":"1h","prompt":"probe","script":path,"no_agent":true}))
                    .await
                    .unwrap();
                let mut events = hub.subscribe();
                scheduler
                    .tool_call("alice", "owl", &json!({"action":"run","job_id":id}))
                    .await
                    .unwrap();
                let job = wait(&mut events, &id).await;
                assert_eq!(job["last_status"], "error");
                assert!(
                    job["last_error"]
                        .as_str()
                        .unwrap()
                        .starts_with("Sandbox paths cannot be"),
                    "{job}"
                );
            }
            let marker = work.join(format!("scheduled-{mode}.txt"));
            fs::write(
                work.join("probe.sh"),
                format!("printf scheduled > 'scheduled-{mode}.txt' && echo wrote\n"),
            )
            .unwrap();
            let id = create(json!({"action":"create","schedule":"1h","prompt":"probe","script":work.join("probe.sh"),"workdir":work,"no_agent":true}))
                .await
                .unwrap();
            let mut events = hub.subscribe();
            scheduler
                .tool_call("alice", "owl", &json!({"action":"run","job_id":id}))
                .await
                .unwrap();
            let job = wait(&mut events, &id).await;
            // Shell scripts run in the runtime's shell, BusyBox's sh, once it
            // starts inside the sandbox. Without it, as when the runtime is
            // not staged beside the helper, the script refuses with the
            // daemon's reason instead of starting.
            let refusal = credentials::sandbox_settings(&home).unwrap()["shellRefusal"]
                .as_str()
                .map(str::to_owned);
            if std::env::var_os("HEXBOT_WINDOWS_BUSYBOX").is_some() {
                assert_eq!(refusal, None, "the staged shell must run scheduled scripts");
            }
            if let Some(refusal) = refusal {
                assert_eq!(job["last_status"], "error", "{job}");
                assert!(
                    job["last_error"].as_str().unwrap().contains(&refusal),
                    "{job}"
                );
                assert!(!marker.exists());
            } else if mode == "smart" {
                assert_eq!(job["last_status"], "success", "{job}");
                assert_eq!(job["last_output"].as_str().unwrap().trim(), "wrote");
                assert_eq!(fs::read_to_string(&marker).unwrap(), "scheduled");
            } else {
                assert_eq!(job["last_status"], "error", "{job}");
                assert!(!marker.exists());
            }
            // Only .sh, .bash, .py and .exe scripts have an interpreter.
            fs::write(work.join("probe.cmd"), "echo x>cmd.txt\r\n").unwrap();
            let id = create(json!({"action":"create","schedule":"1h","prompt":"probe","script":work.join("probe.cmd"),"workdir":work,"no_agent":true}))
                .await
                .unwrap();
            let mut events = hub.subscribe();
            scheduler
                .tool_call("alice", "owl", &json!({"action":"run","job_id":id}))
                .await
                .unwrap();
            let job = wait(&mut events, &id).await;
            assert!(
                job["last_error"]
                    .as_str()
                    .unwrap()
                    .contains("must be .sh, .bash, .py or .exe"),
                "{job}"
            );
            assert!(!work.join("cmd.txt").exists());
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
    let reset = hexbot_core::windows_container::reset(&home);
    // Report cleanup separately, then resume the original panic. A missing
    // startup record must not replace the error that explains why startup failed.
    let records_path = fixture.join("fixture.events.jsonl");
    let cleanup = (|| -> Result<(), String> {
        reset.map_err(|error| format!("sandbox reset: {error}"))?;
        let records = fs::read_to_string(&records_path)
            .map_err(|error| format!("{}: {error}", records_path.display()))?;
        let mut started = 0;
        for line in records.lines() {
            let record: Value = serde_json::from_str(line)
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
    println!("Native Rust daemon boundary probes passed");
}

async fn native_reply(
    events: &mut tokio::sync::broadcast::Receiver<hexbot_core::events::Event>,
) -> Value {
    tokio::time::timeout(Duration::from_secs(60), async {
        let mut reply = None;
        loop {
            let event = events.recv().await.unwrap();
            let kind = &event.frame["params"]["type"];
            assert_ne!(
                kind, "approval.request",
                "the bridge must answer without approval"
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
async fn windows_security_copilot_refuses_before_path_or_command_resolution() {
    for home in [
        r"\\.\pipe\hexbot-security-untrusted",
        r"\\hexbot-hostile.invalid\share",
        r"Z:\missing",
    ] {
        for reviewer in [false, true] {
            let run = async {
                if reviewer {
                    hexbot_core::provider_acp::complete_reviewer(
                        Path::new(home),
                        "owl",
                        "first",
                        &json!({}),
                        Path::new(r"\\.\pipe\untrusted-review-cwd"),
                    )
                    .await
                } else {
                    hexbot_core::provider_acp::complete(Path::new(home), "owl", "first", &json!({}))
                        .await
                }
            };
            let result = tokio::time::timeout(Duration::from_secs(2), run)
                .await
                .expect("ACP must refuse immediately");
            let error = result.unwrap_err();
            assert_eq!(error.code, 4302);
            assert!(
                error
                    .message
                    .contains("Copilot is not available on Windows"),
                "{}",
                error.message
            );
        }
    }
}

#[tokio::test]
async fn windows_security_stored_script_and_monitor_pause_without_path_validation() {
    use hexbot_core::{db, dreaming::Dreaming, events::EventHub, runtime::Runtime, runtime_store};
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
            for (path, reason) in [
                (r"\\hexbot-hostile.invalid\share\untrusted", "network paths"),
                (r"\\.\pipe\hexbot-untrusted", "device or NT object paths"),
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
                // Update and resume check the working folder by its text.
                for action in ["update", "resume"] {
                    let error = scheduler
                        .tool_call("alice", "owl", &json!({"action":action,"job_id":id}))
                        .await
                        .unwrap_err();
                    assert!(error.message.contains(reason), "{error:?}");
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
