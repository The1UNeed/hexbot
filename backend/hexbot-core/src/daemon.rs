use hexbot_core::{
    Error, Result, auth, common, db,
    server::{self, App},
    services,
};
use std::{
    io::Write,
    net::{IpAddr, SocketAddr},
    path::{Path, PathBuf},
};

fn home() -> Result<PathBuf> {
    if let Some(home) = std::env::var_os("HEXBOT_HOME").filter(|value| !value.is_empty()) {
        let mut path = PathBuf::from(home);
        if path.starts_with("~") {
            path = PathBuf::from(
                std::env::var_os("HOME")
                    .ok_or_else(|| Error::new(4200, "HOME is required to expand ~"))?,
            )
            .join(path.strip_prefix("~").unwrap());
        }
        if path.is_relative() {
            path = std::env::current_dir()?.join(path);
        }
        return Ok(path);
    }
    Ok(PathBuf::from(
        std::env::var_os("HOME").ok_or_else(|| Error::new(4200, "HEXBOT_HOME is required"))?,
    )
    .join(".hexbot"))
}
fn pi_executable() -> Result<PathBuf> {
    if let Some(path) = std::env::var_os("HEXBOT_PI_EXECUTABLE") {
        return Ok(PathBuf::from(path));
    }
    let candidate =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../pi-runtime/node_modules/.bin/pi");
    if candidate.is_file() {
        return Ok(candidate);
    }
    Err(Error::new(
        5200,
        "Pi runtime missing. Set HEXBOT_PI_EXECUTABLE or run npm ci --prefix backend/pi-runtime --ignore-scripts",
    ))
}
fn lock_home(home: &Path) -> Result<std::fs::File> {
    std::fs::create_dir_all(home)?;
    let path = home.join("native-daemon.lock");
    let mut options = std::fs::OpenOptions::new();
    options.create(true).truncate(false).write(true).read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err(Error::new(4208, "a daemon already owns this home"));
        }
    }
    file.set_len(0)?;
    write!(file, "{}", std::process::id())?;
    file.sync_all()?;
    Ok(file)
}
async fn run() -> Result<()> {
    let arguments = std::env::args().skip(1).collect::<Vec<_>>();
    let mut args = arguments.clone().into_iter();
    let command = args.next().unwrap_or_else(|| "help".into());
    if matches!(command.as_str(), "--version" | "version" | "-V") {
        if args.next().is_some() {
            return Err(Error::new(4200, "version takes no arguments"));
        }
        println!("{}", hexbot_core::version());
        return Ok(());
    }
    if matches!(command.as_str(), "help" | "--help" | "-h") {
        println!(
            "Hexbot {}\nhexbot serve [--host IP] [--port N] [--lan | --no-lan]\nhexbot pair\nhexbot bots list | create NAME | delete NAME\nhexbot rooms list\nhexbot devices list | revoke ID\nhexbot connect [status | disconnect]\nhexbot send BOT TEXT",
            hexbot_core::version()
        );
        return Ok(());
    }
    let home = home()?;

    if let Some(result) = hexbot_core::cli::dispatch(&home, &arguments).await {
        return result;
    }

    if command == "pair" {
        if args.next().is_some() {
            return Err(Error::new(4200, "pair takes no arguments"));
        }
        db::migrate(&home)?;
        let code = auth::new_code(&home, "local")?;
        let network = hexbot_core::settings::network(&home)?;
        let port = network["port"].as_u64().unwrap_or(9119);
        let addresses = network["addresses"].as_array().cloned().unwrap_or_default();
        let address = addresses
            .first()
            .and_then(serde_json::Value::as_str)
            .unwrap_or("127.0.0.1");
        println!(
            "Pairing code: {}\nExpires in: 10 minutes\nAddresses: {address}:{port}\nLink: hexbot://pair?host={address}&port={port}#code={}",
            code["code"].as_str().unwrap_or(""),
            code["code"].as_str().unwrap_or("")
        );
        let link = format!(
            "hexbot://pair?host={address}&port={port}#code={}",
            code["code"].as_str().unwrap_or("")
        );
        let qr =
            qrcode::QrCode::new(link.as_bytes()).map_err(|e| Error::new(5200, e.to_string()))?;
        println!(
            "{}",
            qr.render::<qrcode::render::unicode::Dense1x2>().build()
        );
        return Ok(());
    }
    if command == "bots" || command == "rooms" {
        if args.next().as_deref() != Some("list") || args.next().is_some() {
            return Err(Error::new(4200, "expected list"));
        }
        db::migrate(&home)?;
        let result = if command == "bots" {
            hexbot_core::catalog::call(&home, "local", "hexbot.bots.list", &serde_json::json!({}))
        } else {
            hexbot_core::rooms::call(&home, "local", "hexbot.rooms.list", &serde_json::json!({}))
        };
        println!(
            "{}",
            result.ok_or_else(|| Error::new(5200, "missing handler"))??
        );
        return Ok(());
    }
    if command != "serve" {
        return Err(Error::new(4200, format!("unknown command: {command}")));
    }
    let mut host = None;
    let mut port = std::env::var("HEXBOT_PORT")
        .ok()
        .and_then(|p| p.parse::<u16>().ok())
        .unwrap_or(9119);
    let mut lan = None;
    while let Some(flag) = args.next() {
        match flag.as_str() {
            "--host" => {
                host = Some(
                    args.next()
                        .ok_or_else(|| Error::new(4200, "--host requires IP"))?
                        .parse::<IpAddr>()
                        .map_err(|_| Error::new(4200, "invalid host"))?,
                )
            }
            "--port" => {
                port = args
                    .next()
                    .ok_or_else(|| Error::new(4200, "--port requires number"))?
                    .parse()
                    .map_err(|_| Error::new(4200, "invalid port"))?
            }
            "--lan" | "--no-lan" => {
                let value = flag == "--lan";
                if lan.is_some_and(|previous| previous != value) {
                    return Err(Error::new(4200, "--lan and --no-lan conflict"));
                }
                lan = Some(value);
            }
            _ => return Err(Error::new(4200, format!("unknown option: {flag}"))),
        }
    }
    let _lock = lock_home(&home)?;
    db::migrate(&home)?;
    if let Some(lan) = lan {
        hexbot_core::settings::update(&home, "local", &serde_json::json!({"lan_enabled":lan}))?;
    }
    let pi = pi_executable()?;
    let dist = std::env::var_os("HEXBOT_WEB_DIST")
        .map(PathBuf::from)
        .or_else(|| Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../apps/web/dist")))
        .filter(|p| p.join("index.html").is_file());
    let signal = shutdown_signal();
    tokio::pin!(signal);
    loop {
        let enabled = hexbot_core::settings::get(&home)?["lan_enabled"]
            .as_bool()
            .unwrap_or(false);
        let address = SocketAddr::new(
            host.take().unwrap_or_else(|| {
                if enabled {
                    IpAddr::from([0, 0, 0, 0])
                } else {
                    IpAddr::from([127, 0, 0, 1])
                }
            }),
            port,
        );
        let listener = tokio::net::TcpListener::bind(address).await?;
        let address = listener.local_addr()?;
        port = address.port();
        let app = App::new(home.clone(), address, pi.clone(), dist.clone())?;
        common::atomic_write(
            &home.join("serve-state.json"),
            serde_json::json!({"host":address.ip().to_string(),"port":port})
                .to_string()
                .as_bytes(),
        )?;
        app.rooms.reconcile().await?;
        app.dreaming.start().await?;
        if let Err(error) = services::start_daemon(&home, port).await {
            eprintln!("Connect: {error}");
        }
        let (stop, stopped) = tokio::sync::oneshot::channel();
        let router = server::router(app.clone());
        let mut serving = tokio::spawn(async move {
            axum::serve(listener, router)
                .with_graceful_shutdown(async {
                    let _ = stopped.await;
                })
                .await
        });
        println!("HERMES_BACKEND_READY port={port}");
        std::io::stdout().flush()?;
        let mut tick = tokio::time::interval(std::time::Duration::from_millis(250));
        let mut update = None;
        let mut terminated = false;
        loop {
            tokio::select! {
                _=&mut signal=>{terminated=true;break;}
                result=&mut serving=>{app.shutdown().await;let _=services::shutdown(&home).await;return result.map_err(|e|Error::new(5200,e.to_string()))?.map_err(Into::into);}
                _=tick.tick()=>{
                    if let Some(path)=services::take_restart(&home).await? {update=Some(path);break;}
                    if hexbot_core::settings::get(&home)?["lan_enabled"].as_bool().unwrap_or(false)!=enabled {break;}
                }
            }
        }
        // Close established WebSockets as well as listeners before waiting for Axum.
        app.shutdown().await;
        let _ = services::shutdown(&home).await;
        let _ = stop.send(());
        if tokio::time::timeout(std::time::Duration::from_secs(10), &mut serving)
            .await
            .is_err()
        {
            serving.abort();
            let _ = serving.await;
        }
        if terminated {
            break;
        }
        if let Some(executable) = update {
            let mut next = std::process::Command::new(executable);
            next.arg("serve")
                .arg("--host")
                .arg(address.ip().to_string())
                .arg("--port")
                .arg(port.to_string())
                .env("HEXBOT_HOME", &home);
            #[cfg(unix)]
            {
                use std::os::unix::process::CommandExt;
                return Err(next.exec().into());
            }
            #[cfg(not(unix))]
            {
                return Err(Error::new(
                    5200,
                    "native restart is unsupported on this platform",
                ));
            }
        }
    }
    Ok(())
}
async fn shutdown_signal() {
    #[cfg(unix)]
    {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut term) => {
                tokio::select! {_=tokio::signal::ctrl_c()=>{},_=term.recv()=>{}}
            }
            Err(_) => {
                let _ = tokio::signal::ctrl_c().await;
            }
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}
#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("{error}");
        std::process::exit(1)
    }
}
