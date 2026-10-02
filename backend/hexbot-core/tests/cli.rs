use hexbot_core::{
    auth, catalog, cli, common, db,
    server::{self, App},
};
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
    time::Duration,
};
mod support;
fn args(values: &[&str]) -> Vec<String> {
    values.iter().map(|v| (*v).into()).collect()
}
async fn run(home: &Path, values: &[&str]) -> Value {
    cli::execute(home, &args(values)).await.unwrap()
}
fn home() -> support::TestHome {
    let h = support::TestHome::new();
    db::migrate(h.path()).unwrap();
    db::open(h.path())
        .unwrap()
        .execute(
            "INSERT INTO settings VALUES ('workspace_dir',?)",
            [json!(h.workspace()).to_string()],
        )
        .unwrap();
    h
}
fn fake_pi(home: &Path) -> PathBuf {
    let path = home.join("fake-pi.cjs");
    fs::write(&path,r##"#!/usr/bin/env node
const out=v=>process.stdout.write(JSON.stringify(v)+'\n');
const finish=()=>{out({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'CLI fixture reply'}],stopReason:'stop'}});out({type:'agent_end'});out({type:'agent_settled'});};
require('node:fs').writeFileSync(__filename+'.pid',String(process.pid));
process.on('SIGTERM',()=>{
 const marker=__filename+'.exit-address';
 if(require('node:fs').existsSync(marker)){const port=Number(require('node:fs').readFileSync(marker,'utf8'));const socket=require('node:net').connect(port,'127.0.0.1',()=>socket.end('exit',()=>process.exit(0)));socket.on('error',()=>process.exit(0));}
 else process.exit(0);
});
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const c=JSON.parse(line);
 if(c.type==='extension_ui_response'){
   if(c.id==='approval' && c.value!=='deny')process.exit(12);
   if(c.id==='clarify' && c.value!==JSON.stringify({q1:'',q2:''}))process.exit(13);
   finish();return;
 }
 out({type:'response',id:c.id,command:c.type,success:true,data:{}});
 if(c.type==='prompt'){
   out({type:'agent_start'});out({type:'message_end',message:{role:'user',content:c.message}});
   if(c.message==='approval')out({type:'extension_ui_request',id:'approval',method:'select',title:'__HEXBOT_APPROVAL__'+JSON.stringify({tool:'terminal',command:'echo test'}),options:['once','session','deny']});
   else if(c.message==='clarify')out({type:'extension_ui_request',id:'clarify',method:'input',title:'__HEXBOT_CLARIFY__'+JSON.stringify({questions:[{qid:'q1',question:'First?'},{qid:'q2',question:'Second?'}]})});
   else if(c.message!=='hang')finish();
 }
});
"##).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
    }
    path
}
#[tokio::test]
async fn invalid_commands_fail_before_creating_state() {
    let t = tempfile::tempdir().unwrap();
    let h = t.path().join("uncreated");
    for a in [
        vec!["bots", "create"],
        vec!["bots", "create", "x", "--unknown", "value"],
        vec!["devices", "revoke"],
        vec!["send", "a"],
        vec!["connect", "status", "extra"],
        vec!["hermes", "chat"],
    ] {
        assert_eq!(cli::execute(&h, &args(&a)).await.unwrap_err().code, 4200);
    }
    assert!(!h.exists());
    assert!(cli::dispatch(&h, &args(&["bots", "list"])).await.is_none());
}
#[tokio::test]
async fn offline_bot_lifecycle_and_device_output_match_python_cli() {
    let h = home();
    let h = h.path();
    let bot = run(
        h,
        &[
            "bots",
            "create",
            "owl",
            "--title",
            "Owl",
            "--model=fixture",
            "--provider",
            "openai",
            "--persona",
            "Remember carefully",
        ],
    )
    .await;
    assert_eq!(bot["bot"]["display_name"], "Owl");
    assert_eq!(bot["bot"]["persona"], "Remember carefully");
    assert_eq!(bot["bot"]["model"], "fixture");
    let device = support::mint_device(h, "Phone", "ios", "local").unwrap();
    db::open(h)
        .unwrap()
        .execute(
            "INSERT INTO users(id,display_name,role,created_at)VALUES('alice','Alice','member',0)",
            [],
        )
        .unwrap();
    support::mint_device(h, "Other", "android", "alice").unwrap();
    let devices = run(h, &["devices", "list"]).await;
    assert_eq!(devices["devices"].as_array().unwrap().len(), 1);
    assert_eq!(devices["devices"][0].as_object().unwrap().len(), 5);
    assert_eq!(
        run(
            h,
            &["devices", "revoke", device["device_id"].as_str().unwrap()]
        )
        .await,
        json!({"revoked":true})
    );
    assert_eq!(
        cli::execute(
            h,
            &args(&["devices", "revoke", device["device_id"].as_str().unwrap()])
        )
        .await
        .unwrap_err()
        .code,
        4204
    );
    assert_eq!(
        run(h, &["bots", "delete", "owl"]).await,
        json!({"deleted":true})
    );
    assert!(!h.join("profiles/owl").exists());
}
#[cfg(unix)]
#[tokio::test]
async fn offline_mutation_refuses_a_home_owned_by_unreachable_daemon() {
    use std::os::fd::AsRawFd;
    let h = home();
    let file = fs::File::create(h.path().join("native-daemon.lock")).unwrap();
    assert_eq!(
        unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
        0
    );
    assert_eq!(
        cli::execute(h.path(), &args(&["bots", "create", "owl"]))
            .await
            .unwrap_err()
            .code,
        4208
    );
    assert_eq!(
        db::open(h.path())
            .unwrap()
            .query_row("SELECT COUNT(*) FROM bots", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
}
#[tokio::test]
async fn online_cli_reuses_daemon_and_hidden_send_preserves_section_list() {
    let h = home();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = App::new(h.path().to_owned(), address, fake_pi(h.path()), None).unwrap();
    common::atomic_write(
        &h.path().join("serve-state.json"),
        json!({"host":"0.0.0.0","port":address.port()})
            .to_string()
            .as_bytes(),
    )
    .unwrap();
    let router = server::router(app.clone());
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let mut events = app.events.subscribe();
    run(
        h.path(),
        &[
            "bots",
            "create",
            "owl",
            "--provider",
            "fixture",
            "--model",
            "one",
        ],
    )
    .await;
    let event = tokio::time::timeout(Duration::from_secs(2), events.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(event.frame["params"]["type"], "hexbot.bots.changed");
    let before = catalog::call(h.path(), "local", "hexbot.sections.list", &json!({}))
        .unwrap()
        .unwrap();
    let sent = tokio::time::timeout(
        Duration::from_secs(10),
        cli::execute(h.path(), &args(&["send", "owl", "Hello"])),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(sent["text"], "CLI fixture reply");
    for message in ["approval", "clarify"] {
        let output = tokio::time::timeout(
            Duration::from_secs(10),
            tokio::process::Command::new(env!("CARGO_BIN_EXE_hexbot"))
                .args(["send", "owl", message])
                .env("HEXBOT_HOME", h.path())
                .stdin(std::process::Stdio::null())
                .kill_on_drop(true)
                .output(),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            String::from_utf8_lossy(&output.stdout).trim(),
            "CLI fixture reply"
        );
    }
    let after = catalog::call(h.path(), "local", "hexbot.sections.list", &json!({}))
        .unwrap()
        .unwrap();
    assert_eq!(before, after);
    assert_eq!(
        app.runtime
            .call("local", "session.active_list", &json!({}))
            .await
            .unwrap()
            .unwrap()["sessions"],
        json!([])
    );
    app.shutdown().await;
    server.abort();
}
#[cfg(unix)]
#[tokio::test]
async fn command_binary_runs_offline_send_and_declines_unattended_approval() {
    let h = home();
    let pi = fake_pi(h.path());
    run(
        h.path(),
        &[
            "bots",
            "create",
            "owl",
            "--provider",
            "fixture",
            "--model",
            "one",
        ],
    )
    .await;
    for message in ["Hello", "approval", "clarify"] {
        let output = tokio::time::timeout(
            Duration::from_secs(12),
            tokio::process::Command::new(env!("CARGO_BIN_EXE_hexbot"))
                .args(["send", "owl", message])
                .env("HEXBOT_HOME", h.path())
                .env("HEXBOT_PI_EXECUTABLE", &pi)
                .stdin(std::process::Stdio::null())
                .kill_on_drop(true)
                .output(),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            String::from_utf8_lossy(&output.stdout).trim(),
            "CLI fixture reply"
        );
    }
    assert_eq!(
        db::open(h.path())
            .unwrap()
            .query_row("SELECT COUNT(*) FROM sections", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
}
#[tokio::test]
async fn offline_connect_registration_saves_without_spawning_tunnel() {
    async fn start() -> axum::Json<Value> {
        axum::Json(
            json!({"verify_url":"https://connect.hexbot.app/activate","user_code":"AAAA-BBBB","device_code":"device","interval":0}),
        )
    }
    async fn poll() -> axum::Json<Value> {
        axum::Json(
            json!({"status":"approved","daemon_id":"daemon1","daemon_token":"private","slug":"owl","tunnel_hostname":"owl.tunnel.hexbot.app","tunnel_token":"private-tunnel","owner_id":"owner","issuer":"https://connect.hexbot.app","keys":[{"kid":"fixture"}]}),
        )
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            axum::Router::new()
                .route("/api/register/start", axum::routing::post(start))
                .route("/api/register/poll", axum::routing::post(poll)),
        )
        .await
        .unwrap()
    });
    let h = home();
    fs::write(
        h.path().join("config.yaml"),
        format!("connect:\n  api_base: http://{address}\n"),
    )
    .unwrap();
    assert_eq!(
        run(h.path(), &["connect", "--name", "Kitchen"]).await["connected"],
        "https://owl.tunnel.hexbot.app"
    );
    assert!(h.path().join("connect.json").is_file());
    assert!(
        cli::execute(h.path(), &["connect".into()])
            .await
            .unwrap_err()
            .message
            .contains("Already connected")
    );
    assert!(!h.path().join("bin/cloudflared").exists());
    assert_eq!(
        run(h.path(), &["connect", "status"]).await["registered"],
        true
    );
    run(h.path(), &["connect", "disconnect"]).await;
    assert!(!h.path().join("connect.json").exists());
    server.abort();
}

#[cfg(unix)]
#[tokio::test]
async fn disconnected_one_shot_request_closes_session_and_reaps_owned_pi() {
    use futures_util::{SinkExt, StreamExt};
    use tokio::io::AsyncReadExt;
    use tokio_tungstenite::tungstenite::Message;
    let h = home();
    let pi = fake_pi(h.path());
    let exited = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    fs::write(
        pi.with_extension("cjs.exit-address"),
        exited.local_addr().unwrap().port().to_string(),
    )
    .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = App::new(h.path().to_owned(), address, pi.clone(), None).unwrap();
    catalog::call(
        h.path(),
        "local",
        "hexbot.bots.create",
        &json!({"name":"owl","provider":"fixture","model":"one"}),
    )
    .unwrap()
    .unwrap();
    let router = server::router(app.clone());
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let token = auth::local_token(h.path()).unwrap();
    let (mut socket, _) =
        tokio_tungstenite::connect_async(format!("ws://{address}/api/ws?token={token}"))
            .await
            .unwrap();
    socket.next().await.unwrap().unwrap();
    let mut events = app.events.subscribe();
    socket.send(Message::Text(json!({"jsonrpc":"2.0","id":"one-shot","method":"hexbot.cli.send","params":{"bot":"owl","text":"hang","request_id":"one-shot"}}).to_string().into())).await.unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if events.recv().await.unwrap().frame["params"]["type"] == "message.start" {
                break;
            }
        }
    })
    .await
    .unwrap();
    let pid = fs::read_to_string(pi.with_extension("cjs.pid"))
        .unwrap()
        .parse::<i32>()
        .unwrap();
    // Drop the TCP client without a close request, as with a killed command process.
    drop(socket);
    tokio::time::timeout(Duration::from_secs(5), async {
        let (mut stream, _) = exited.accept().await.unwrap();
        let mut bytes = vec![];
        stream.read_to_end(&mut bytes).await.unwrap();
        assert_eq!(bytes, b"exit");
        while unsafe { libc::kill(pid, 0) } == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        app.runtime
            .call("local", "session.active_list", &json!({}))
            .await
            .unwrap()
            .unwrap()["sessions"],
        json!([])
    );
    app.shutdown().await;
    server.abort();
}

#[cfg(unix)]
#[tokio::test]
async fn terminal_approval_and_ctrl_c_do_not_leave_blocking_stdin_readers() {
    use std::{io::Write, os::fd::FromRawFd};
    use tokio::io::AsyncReadExt;
    let h = home();
    let pi = fake_pi(h.path());
    run(
        h.path(),
        &[
            "bots",
            "create",
            "owl",
            "--provider",
            "fixture",
            "--model",
            "one",
        ],
    )
    .await;
    for (input, success) in [(b"deny\n".as_slice(), true), (b"\x03".as_slice(), false)] {
        let (mut master, mut slave) = (-1, -1);
        assert_eq!(
            unsafe {
                libc::openpty(
                    &mut master,
                    &mut slave,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                )
            },
            0
        );
        assert_eq!(
            unsafe { libc::fcntl(master, libc::F_SETFD, libc::FD_CLOEXEC) },
            0
        );
        assert_eq!(
            unsafe { libc::fcntl(slave, libc::F_SETFD, libc::FD_CLOEXEC) },
            0
        );
        let mut settings = std::mem::MaybeUninit::<libc::termios>::uninit();
        assert_eq!(unsafe { libc::tcgetattr(slave, settings.as_mut_ptr()) }, 0);
        let mut settings = unsafe { settings.assume_init() };
        settings.c_lflag |= libc::ICANON | libc::ISIG;
        settings.c_cc[libc::VINTR] = 3;
        assert_eq!(
            unsafe { libc::tcsetattr(slave, libc::TCSANOW, &settings) },
            0
        );
        let mut master = unsafe { fs::File::from_raw_fd(master) };
        let slave = unsafe { fs::File::from_raw_fd(slave) };
        let mut command = tokio::process::Command::new(env!("CARGO_BIN_EXE_hexbot"));
        command
            .args(["send", "owl", "approval"])
            .env("HEXBOT_HOME", h.path())
            .env("HEXBOT_PI_EXECUTABLE", &pi)
            .stdin(slave)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() < 0
                    || libc::ioctl(0, libc::TIOCSCTTY as libc::c_ulong, 0) < 0
                    || libc::tcsetpgrp(0, libc::getpgrp()) < 0
                {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let mut child = command.spawn().unwrap();
        drop(command);
        let mut stderr = child.stderr.take().unwrap();
        tokio::time::timeout(Duration::from_secs(8), async {
            let mut prompt = Vec::new();
            let mut bytes = [0; 512];
            while !String::from_utf8_lossy(&prompt).contains("[once/session/deny]") {
                let count = stderr.read(&mut bytes).await.unwrap();
                assert!(count > 0, "{}", String::from_utf8_lossy(&prompt));
                prompt.extend_from_slice(&bytes[..count]);
            }
        })
        .await
        .unwrap();
        master.write_all(input).unwrap();
        let status = match tokio::time::timeout(Duration::from_secs(5), child.wait()).await {
            Ok(status) => status.unwrap(),
            Err(error) => {
                child.start_kill().unwrap();
                let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
                let mut details = String::new();
                let _ = tokio::time::timeout(
                    Duration::from_secs(2),
                    stderr.read_to_string(&mut details),
                )
                .await;
                panic!("terminal input {:?}: {error}: {details}", input);
            }
        };
        assert_eq!(status.success(), success);
        if success {
            let mut bytes = [0; 18];
            tokio::time::timeout(
                Duration::from_secs(2),
                child.stdout.take().unwrap().read_exact(&mut bytes),
            )
            .await
            .unwrap()
            .unwrap();
            assert_eq!(&bytes, b"CLI fixture reply\n");
        }
        let pid = fs::read_to_string(pi.with_extension("cjs.pid"))
            .unwrap()
            .parse::<i32>()
            .unwrap();
        assert_eq!(
            unsafe { libc::kill(pid, 0) },
            -1,
            "owned Pi survived CLI termination"
        );
    }
}

#[tokio::test]
async fn help_and_invalid_command_describe_all_native_commands() {
    let home = tempfile::tempdir().unwrap();
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_hexbot"))
        .arg("--help")
        .env("HEXBOT_HOME", home.path().join("uncreated"))
        .output()
        .unwrap();
    assert!(output.status.success());
    let help = String::from_utf8(output.stdout).unwrap();
    let error = cli::execute(&home.path().join("uncreated"), &args(&["bots", "create"]))
        .await
        .unwrap_err();
    for command in [
        "hexbot serve [--host IP] [--port N] [--lan | --no-lan]",
        "hexbot pair",
        "hexbot bots list | create NAME",
        "[--title TEXT] [--description TEXT] [--persona TEXT] [--provider NAME] [--model NAME]",
        "hexbot rooms list",
        "hexbot devices list | revoke ID",
        "hexbot connect [--name TEXT | status | disconnect]",
        "hexbot send BOT TEXT",
    ] {
        assert!(help.contains(command), "missing help for {command}");
        assert!(
            error.message.contains(command),
            "missing usage for {command}"
        );
    }
    assert!(!home.path().join("uncreated").exists());
}
