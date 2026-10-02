//! Native command line operations. A running daemon remains the sole runtime owner.
use crate::{
    Error, Result, auth, catalog, common, db, events::EventHub, runtime::Runtime, services,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::{
    io::{IsTerminal, Write},
    net::{IpAddr, SocketAddr},
    path::Path,
    time::Duration,
};
use tokio_tungstenite::{connect_async, tungstenite::Message};
type Socket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

pub const USAGE: &str = concat!(
    "hexbot serve [--host IP] [--port N] [--lan | --no-lan]\n",
    "hexbot pair\n",
    "hexbot bots list | create NAME [--title TEXT] [--description TEXT] [--persona TEXT] [--provider NAME] [--model NAME] | delete NAME\n",
    "hexbot rooms list\n",
    "hexbot devices list | revoke ID\n",
    "hexbot connect [--name TEXT | status | disconnect]\n",
    "hexbot send BOT TEXT"
);

fn invalid() -> Error {
    Error::new(4200, format!("usage:\n{USAGE}"))
}
fn command(args: &[String]) -> Result<(&'static str, Value)> {
    let a: Vec<&str> = args.iter().map(String::as_str).collect();
    match a.as_slice() {
        ["connect"] => Ok(("register", json!({}))),
        ["connect", "--name", name] => Ok(("register", json!({"name":name}))),
        ["connect", "status"] => Ok(("hexbot.connect.status", json!({}))),
        ["connect", "disconnect"] => Ok(("hexbot.connect.disconnect", json!({}))),
        ["devices", "list"] => Ok(("hexbot.devices.list", json!({}))),
        ["devices", "revoke", id] => Ok(("hexbot.devices.revoke", json!({"id":id}))),
        ["bots", "delete", name] => Ok(("hexbot.bots.delete", json!({"name":name}))),
        ["send", bot, text] => Ok((
            "hexbot.cli.send",
            json!({"bot":bot,"text":text,"request_id":common::id()}),
        )),
        ["bots", "create", name, rest @ ..] => {
            let mut p = json!({"name":name});
            let mut flags = rest.iter();
            while let Some(flag) = flags.next() {
                let (key, value) = if let Some((key, value)) = flag.split_once('=') {
                    (key, value)
                } else {
                    (*flag, *flags.next().ok_or_else(invalid)?)
                };
                let key = key.strip_prefix("--").ok_or_else(invalid)?;
                if !["title", "description", "persona", "provider", "model"].contains(&key) {
                    return Err(invalid());
                }
                p[key] = json!(value);
            }
            Ok(("hexbot.bots.create", p))
        }
        ["hermes", ..] => Err(Error::new(
            4200,
            "This command was removed. Use hexbot send BOT TEXT for one-shot chat.",
        )),
        _ => Err(invalid()),
    }
}

fn offline_lock(home: &Path) -> Result<std::fs::File> {
    std::fs::create_dir_all(home)?;
    let mut options = std::fs::OpenOptions::new();
    options.create(true).read(true).write(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(home.join("native-daemon.lock"))?;
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err(Error::new(
                4208,
                "A daemon owns this home but its API is unreachable. Retry after it finishes starting or restarting.",
            ));
        }
        Ok(file)
    }
}
async fn socket(home: &Path) -> Result<Option<Socket>> {
    let state = match std::fs::read(home.join("serve-state.json")) {
        Ok(v) => {
            serde_json::from_slice::<Value>(&v).map_err(|e| Error::new(5200, e.to_string()))?
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    let mut host: IpAddr = state["host"]
        .as_str()
        .ok_or_else(|| Error::new(5200, "Invalid daemon address"))?
        .parse()
        .map_err(|_| Error::new(5200, "Invalid daemon address"))?;
    if host.is_unspecified() {
        host = if host.is_ipv6() {
            "::1".parse().unwrap()
        } else {
            "127.0.0.1".parse().unwrap()
        };
    }
    let port = u16::try_from(state["port"].as_u64().unwrap_or(0))
        .map_err(|_| Error::new(5200, "Invalid daemon port"))?;
    if port == 0 {
        return Err(Error::new(5200, "Invalid daemon port"));
    }
    let token = auth::local_token(home)?;
    match tokio::time::timeout(
        Duration::from_secs(3),
        connect_async(format!(
            "ws://{}/api/ws?token={token}",
            SocketAddr::new(host, port)
        )),
    )
    .await
    {
        Ok(Ok((socket, _))) => Ok(Some(socket)),
        Ok(Err(tokio_tungstenite::tungstenite::Error::Io(_))) | Err(_) => Ok(None),
        Ok(Err(e)) => Err(Error::new(
            5200,
            format!("Cannot authenticate with daemon: {e}"),
        )),
    }
}
async fn answers(event: &Value) -> Result<Vec<(&'static str, Value)>> {
    let kind = event["type"].as_str().unwrap_or("");
    if kind != "approval.request" && kind != "clarify.request" {
        return Ok(vec![]);
    }
    let payload = &event["payload"];
    let base = json!({"session_id":event["session_id"],"request_id":payload["request_id"]});
    if kind == "approval.request" {
        let choices: Vec<&str> = payload["choices"]
            .as_array()
            .map(|c| c.iter().filter_map(Value::as_str).collect())
            .unwrap_or_else(|| vec!["once", "deny"]);
        let prompt = format!(
            "Allow {}: {}? [{}] ",
            payload["tool"].as_str().unwrap_or("tool"),
            payload["command"].as_str().unwrap_or(""),
            choices.join("/")
        );
        let choice = input(prompt).await?;
        let mut params = base;
        params["choice"] = json!(if choices.contains(&choice.as_str()) {
            choice
        } else {
            "deny".into()
        });
        return Ok(vec![("approval.respond", params)]);
    }
    let questions = payload["questions"]
        .as_array()
        .cloned()
        .unwrap_or_else(|| vec![payload.clone()]);
    let mut out = Vec::new();
    for question in questions {
        let mut params = base.clone();
        if let Some(qid) = question.get("qid") {
            params["question_id"] = qid.clone();
        }
        params["answer"] = json!(
            input(format!(
                "{} {} ",
                question["question"]
                    .as_str()
                    .or(question["prompt"].as_str())
                    .unwrap_or("Answer"),
                question["choices"]
            ))
            .await?
        );
        out.push(("clarify.respond", params));
    }
    Ok(out)
}
async fn input(prompt: String) -> Result<String> {
    if !std::io::stdin().is_terminal() {
        eprintln!("{prompt}(no terminal; declining)");
        return Ok(String::new());
    }
    #[cfg(unix)]
    let mut interrupt = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())?;
    eprint!("{prompt}");
    std::io::stderr().flush()?;
    #[cfg(unix)]
    {
        use std::{
            io::Read,
            os::unix::{ffi::OsStrExt, fs::OpenOptionsExt},
        };
        // A separate terminal descriptor lets cancellation drop the read immediately.
        let mut name = [0 as libc::c_char; 1024];
        let status = unsafe { libc::ttyname_r(0, name.as_mut_ptr(), name.len()) };
        if status != 0 {
            return Err(std::io::Error::from_raw_os_error(status).into());
        }
        let name = unsafe { std::ffi::CStr::from_ptr(name.as_ptr()) };
        let terminal = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NONBLOCK)
            .open(std::ffi::OsStr::from_bytes(name.to_bytes()))?;
        let terminal = tokio::io::unix::AsyncFd::new(terminal)?;
        let read = async {
            let mut bytes = Vec::new();
            loop {
                let mut ready = terminal.readable().await?;
                let mut byte = [0];
                match ready.try_io(|fd| {
                    let mut file = fd.get_ref();
                    file.read(&mut byte)
                }) {
                    Ok(Ok(0)) => break,
                    Ok(Ok(_)) if byte[0] == b'\n' => break,
                    Ok(Ok(_)) => {
                        bytes.push(byte[0]);
                        if bytes.len() > 65536 {
                            return Err(Error::new(4200, "Terminal answer exceeds 64 KiB"));
                        }
                    }
                    Ok(Err(error)) => return Err(error.into()),
                    Err(_) => {}
                }
            }
            Ok(String::from_utf8_lossy(&bytes).trim().to_owned())
        };
        tokio::select! {result=read=>result,_=interrupt.recv()=>Err(Error::new(5200,"Command interrupted"))}
    }
}
async fn remote(socket: &mut Socket, method: &str, p: Value) -> Result<Value> {
    let id = common::id();
    socket
        .send(Message::Text(
            json!({"jsonrpc":"2.0","id":id,"method":method,"params":p})
                .to_string()
                .into(),
        ))
        .await
        .map_err(|e| Error::new(5200, e.to_string()))?;
    let mut live = None::<String>;
    let operation = async {
        while let Some(frame) = socket.next().await {
            match frame.map_err(|e| Error::new(5200, e.to_string()))? {
                Message::Text(text) => {
                    for line in text.lines() {
                        let frame: Value = serde_json::from_str(line)
                            .map_err(|e| Error::new(5200, e.to_string()))?;
                        if frame["id"] == id {
                            if frame["error"].is_object() {
                                return Err(Error {
                                    code: frame["error"]["code"].as_i64().unwrap_or(5200),
                                    message: frame["error"]["message"]
                                        .as_str()
                                        .unwrap_or("Daemon request failed")
                                        .into(),
                                    data: frame["error"].get("data").cloned(),
                                });
                            }
                            return Ok(frame["result"].clone());
                        }
                        let event = &frame["params"];
                        if method == "hexbot.cli.send"
                            && event["type"] == "hexbot.cli.session"
                            && event["payload"]["request_id"] == p["request_id"]
                        {
                            live = event["session_id"].as_str().map(str::to_owned);
                        }
                        if live.as_deref().is_some_and(|v| event["session_id"] == v) {
                            for (method, params) in answers(event).await? {
                                socket
                                    .send(Message::Text(
                                        json!({
                                            "jsonrpc": "2.0",
                                            "id": common::id(),
                                            "method": method,
                                            "params": params
                                        })
                                        .to_string()
                                        .into(),
                                    ))
                                    .await
                                    .map_err(|e| Error::new(5200, e.to_string()))?;
                            }
                        }
                    }
                }
                Message::Ping(bytes) => socket
                    .send(Message::Pong(bytes))
                    .await
                    .map_err(|e| Error::new(5200, e.to_string()))?,
                Message::Close(_) => break,
                _ => {}
            }
        }
        Err(Error::new(5200, "Daemon disconnected before replying"))
    };
    let timeout = Duration::from_secs(if method == "hexbot.cli.send" {
        1800
    } else {
        60
    });
    let result = tokio::select! {
        result = tokio::time::timeout(timeout, operation) => {
            result.unwrap_or_else(|_| Err(Error::new(5200, "Daemon command timed out")))
        }
        _ = tokio::signal::ctrl_c() => Err(Error::new(5200, "Command interrupted")),
    };
    if result.is_err()
        && let Some(live) = live
    {
        let close_id = common::id();
        let close = async {
            socket
                .send(Message::Text(json!({"jsonrpc":"2.0","id":close_id,"method":"session.close","params":{"session_id":live}}).to_string().into()))
                .await
                .ok()?;
            while let Some(Ok(frame)) = socket.next().await {
                if let Message::Text(text) = frame {
                    for line in text.lines() {
                        if serde_json::from_str::<Value>(line)
                            .ok()
                            .is_some_and(|v| v["id"] == close_id)
                        {
                            return Some(());
                        }
                    }
                }
            }
            None
        };
        let _ = tokio::time::timeout(Duration::from_secs(5), close).await;
    }
    result
}
async fn offline_send(home: &Path, p: &Value) -> Result<Value> {
    let events = EventHub::new();
    let mut receiver = events.subscribe();
    let runtime = Runtime::new(home.to_owned(), events, common::pi_executable()?)?;
    let bot = common::required(p, "bot")?;
    let text = common::required(p, "text")?;
    let stored = format!("cli-{}", common::id());
    let result = async {
        let live = runtime.ensure_hidden("local", bot, &stored).await?;
        let operation = runtime.run_hidden_job("local", bot, &stored, text, &Value::Null);
        tokio::pin!(operation);
        loop {
            tokio::select! {
                result = &mut operation => break result.map(|text| json!({"text":text})),
                event = receiver.recv() => {
                    let event = event.map_err(|e| Error::new(5200, e.to_string()))?;
                    if event.frame["params"]["session_id"] == live {
                        for (method, p) in answers(&event.frame["params"]).await? {
                            runtime
                                .call("local", method, &p)
                                .await
                                .ok_or_else(|| Error::new(5200, "Missing response handler"))??;
                        }
                    }
                }
                _ = tokio::signal::ctrl_c() => break Err(Error::new(5200, "Command interrupted")),
            }
        }
    }
    .await;
    runtime.shutdown().await;
    result
}
async fn invoke(home: &Path, socket: &mut Option<Socket>, method: &str, p: Value) -> Result<Value> {
    if let Some(socket) = socket {
        return remote(socket, method, p).await;
    }
    if method == "hexbot.cli.send" {
        return offline_send(home, &p).await;
    }
    if method == "hexbot.connect.register_poll" {
        return services::register_poll(home, common::required(&p, "device_code")?, false).await;
    }
    if let Some(result) =
        auth::call(home, "local", method, &p).or_else(|| catalog::call(home, "local", method, &p))
    {
        return result;
    }
    services::call(home, "local", method, &p)
        .await
        .ok_or_else(|| Error::new(-32601, "Unknown command"))?
}
/// Execute without printing the resulting JSON, useful to embedding clients and tests.
pub async fn execute(home: &Path, args: &[String]) -> Result<Value> {
    let (method, p) = command(args)?;
    let mut socket = socket(home).await?;
    let _guard = if socket.is_none() {
        Some(offline_lock(home)?)
    } else {
        None
    };
    db::migrate(home)?;
    common::user(home, "local")?;
    if method == "register" {
        common::admin(home, "local")?;
        if services::ConnectConfig::load(home)?.is_some_and(|c| !c.daemon_id.is_empty()) {
            return Err(Error::new(
                4240,
                "Already connected to Hex Connect. Disconnect first to register again.",
            ));
        }
        let name = p["name"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(auth::daemon_name);
        let started = invoke(
            home,
            &mut socket,
            "hexbot.connect.register_start",
            json!({"daemon_name":name}),
        )
        .await?;
        println!(
            "Open: {}\nCode: {}",
            common::required(&started, "verify_url")?,
            common::required(&started, "user_code")?
        );
        let code = common::required(&started, "device_code")?;
        let interval = Duration::from_secs_f64(
            started["interval"]
                .as_f64()
                .filter(|v| v.is_finite())
                .unwrap_or(5.0)
                .clamp(0.01, 60.0),
        );
        let poll = async {
            loop {
                let result = invoke(
                    home,
                    &mut socket,
                    "hexbot.connect.register_poll",
                    json!({"device_code":code}),
                )
                .await?;
                match result["status"].as_str().unwrap_or("pending") {
                    "approved" => {
                        return Ok(
                            json!({"connected":format!("https://{}",services::ConnectConfig::load(home)?.ok_or_else(||Error::new(5241,"Hex Connect registration was not saved"))?.tunnel_hostname)}),
                        );
                    }
                    "expired" => return Err(Error::new(4241, "Hex Connect registration expired")),
                    "denied" => return Err(Error::new(4242, "Hex Connect registration denied")),
                    "pending" => tokio::time::sleep(interval).await,
                    _ => {
                        return Err(Error::new(
                            5241,
                            "Hex Connect returned an unknown registration status",
                        ));
                    }
                }
            }
        };
        return tokio::select! {
            result = tokio::time::timeout(Duration::from_secs(600), poll) => result.map_err(|_| Error::new(4241, "Hex Connect registration expired"))?,
            _ = tokio::signal::ctrl_c() => Err(Error::new(5200, "Registration interrupted")),
        };
    }
    let mut result = invoke(home, &mut socket, method, p).await?;
    if method == "hexbot.devices.list"
        && let Some(devices) = result["devices"].as_array_mut()
    {
        for device in devices {
            if let Some(d) = device.as_object_mut() {
                d.remove("current");
            }
        }
    }
    Ok(result)
}
/// Return None for commands implemented by the daemon entry point.
pub async fn dispatch(home: &Path, args: &[String]) -> Option<Result<()>> {
    let recognized = matches!(
        args.first().map(String::as_str),
        Some("connect" | "devices" | "send" | "hermes")
    ) || (args.first().map(String::as_str) == Some("bots")
        && args.get(1).map(String::as_str) != Some("list"));
    if !recognized {
        return None;
    }
    Some(execute(home, args).await.map(|v| {
        if let Some(text) = v["text"].as_str() {
            println!("{text}");
        } else if let Some(url) = v["connected"].as_str() {
            println!("Connected: {url}");
        } else {
            println!("{}", serde_json::to_string_pretty(&v).unwrap());
        }
    }))
}
