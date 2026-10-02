use hexbot_core::{
    Error, Result, auth, common, db,
    server::{self, App},
    services,
};
use std::{
    io::IsTerminal,
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
fn refuse_legacy_listener(home: &Path) -> Result<()> {
    if !home.join("runtime/native-transition-pending").exists() {
        return Ok(());
    }
    let path = home.join("serve-state.json");
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    let state: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| {
        Error::new(
            4208,
            "Cannot verify the previous daemon's address in serve-state.json",
        )
    })?;
    let port = state["port"]
        .as_u64()
        .filter(|port| *port > 0 && *port <= 65535)
        .ok_or_else(|| Error::new(4208, "Cannot verify the previous daemon's port"))?
        as u16;
    let host = state["host"].as_str().unwrap_or("127.0.0.1");
    let ip: IpAddr = match host {
        "localhost" | "0.0.0.0" => "127.0.0.1".parse().unwrap(),
        "::" => "::1".parse().unwrap(),
        host => host
            .parse()
            .map_err(|_| Error::new(4208, "Cannot verify the previous daemon's address"))?,
    };
    match std::net::TcpStream::connect_timeout(
        &SocketAddr::new(ip, port),
        std::time::Duration::from_secs(1),
    ) {
        Err(_) => Ok(()),
        _ => Err(Error::new(
            4208,
            "A previous daemon may still own this home. Stop the existing Hexbot daemon before starting this one.",
        )),
    }
}

fn finish_native_transition(home: &Path) -> Result<()> {
    let runtime = home.join("runtime");
    let marker = runtime.join("native-transition-pending");
    if !marker.is_file() {
        return Ok(());
    }
    if !std::fs::symlink_metadata(&runtime)?.file_type().is_dir() {
        return Err(Error::new(
            5243,
            "Runtime directory cannot be a symbolic link",
        ));
    }
    let venv = runtime.join("venv");
    // launchd may still have the old executable path loaded until its next reload.
    // Keep only a tiny forwarding script, never the Python environment.
    let keep_shim = std::fs::read_to_string(&marker)? != "remove-shim"
        && std::fs::symlink_metadata(&venv).is_ok_and(|m| m.file_type().is_dir())
        && std::fs::symlink_metadata(venv.join("bin")).is_ok_and(|m| m.file_type().is_dir())
        && std::fs::read(venv.join("bin/hexbot"))
            .is_ok_and(|bytes| bytes.starts_with(b"#!/bin/sh\n"));
    fn remove(path: &Path) -> Result<()> {
        match std::fs::symlink_metadata(path) {
            Ok(meta) if meta.file_type().is_dir() => std::fs::remove_dir_all(path)?,
            Ok(_) => std::fs::remove_file(path)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        Ok(())
    }
    if keep_shim {
        // Leave the old entrypoint continuously available, including if cleanup
        // is interrupted by a crash or the service manager restarting us.
        for entry in std::fs::read_dir(&venv)? {
            let entry = entry?;
            if entry.file_name() == "bin" {
                for binary in std::fs::read_dir(entry.path())? {
                    let binary = binary?;
                    if binary.file_name() != "hexbot" {
                        remove(&binary.path())?;
                    }
                }
            } else {
                remove(&entry.path())?;
            }
        }
    } else {
        remove(&venv)?;
    }
    remove(&runtime.join("src"))?;
    std::fs::remove_file(marker)?;
    Ok(())
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
    refuse_legacy_listener(home)?;
    file.set_len(0)?;
    write!(file, "{}", std::process::id())?;
    file.sync_all()?;
    Ok(file)
}
/// Only print a startup link to an unsupervised terminal. macOS shells inherit
/// XPC_SERVICE_NAME=0, which does not name a launchd service.
fn prints_sign_in_link(terminal: bool, env: impl Fn(&str) -> Option<String>) -> bool {
    terminal
        && env("HEXBOT_SUPERVISOR").is_none()
        && env("INVOCATION_ID").is_none()
        && env("XPC_SERVICE_NAME").is_none_or(|name| name == "0")
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
            "Hexbot {}\n{}",
            hexbot_core::version(),
            hexbot_core::cli::USAGE
        );
        return Ok(());
    }
    let home = home()?;

    if let Some(result) = hexbot_core::cli::dispatch(&home, &arguments).await {
        return result;
    }

    if command == "pair" {
        let sign_in = match (args.next().as_deref(), args.next()) {
            (None, None) => false,
            (Some("--sign-in"), None) => true,
            _ => return Err(Error::new(4200, "pair accepts only --sign-in")),
        };
        db::migrate(&home)?;
        let code = if sign_in {
            auth::new_sign_in_code(&home)?
        } else {
            auth::new_code(&home, "local")?
        };
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
    let executable = std::env::current_exe()?;
    common::atomic_write(
        &home.join("runtime/native-running.json"),
        &serde_json::to_vec(&serde_json::json!({"pid":std::process::id(),"executable":executable}))
            .unwrap(),
    )?;
    db::migrate(&home)?;
    if let Some(lan) = lan {
        hexbot_core::settings::update(&home, "local", &serde_json::json!({"lan_enabled":lan}))?;
    }
    let pi = common::pi_executable()?;
    let dist = std::env::var_os("HEXBOT_WEB_DIST")
        .map(PathBuf::from)
        .or_else(|| Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../apps/web/dist")))
        .filter(|p| p.join("index.html").is_file());
    let signal = shutdown_signal();
    tokio::pin!(signal);
    let mut previous: Option<std::sync::Arc<App>> = None;
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
        let listener = match tokio::net::TcpListener::bind(address).await {
            Ok(listener) => listener,
            Err(error) => {
                if let Some(app) = previous.take() {
                    app.shutdown().await;
                }
                return Err(error.into());
            }
        };
        let address = listener.local_addr()?;
        port = address.port();
        // Changing LAN access rebinds the listener; running bots keep going.
        let first = previous.is_none();
        let app = match previous.take() {
            Some(previous) => previous.rebind(address)?,
            None => App::new(home.clone(), address, pi.clone(), dist.clone())?,
        };
        common::atomic_write(
            &home.join("serve-state.json"),
            serde_json::json!({"host":address.ip().to_string(),"port":port})
                .to_string()
                .as_bytes(),
        )?;
        if first {
            app.rooms.reconcile().await?;
            app.dreaming.start().await?;
        }
        if let Err(error) = services::start_daemon(&home, port).await {
            eprintln!("Connect: {error}");
        }
        let (stop, stopped) = tokio::sync::oneshot::channel();
        let router = server::router(app.clone());
        let mut serving = tokio::spawn(async move {
            axum::serve(
                listener,
                router.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .with_graceful_shutdown(async {
                let _ = stopped.await;
            })
            .await
        });
        if let Err(error) = services::prune_current_native(&home) {
            eprintln!("Runtime cleanup: {error}");
        }
        if let Err(error) = finish_native_transition(&home) {
            eprintln!("Runtime cleanup: {error}");
        }
        if first
            && prints_sign_in_link(std::io::stdout().is_terminal(), |name| {
                std::env::var_os(name).map(|value| value.to_string_lossy().into_owned())
            })
        {
            let ip = if address.ip().is_unspecified() {
                IpAddr::from([127, 0, 0, 1])
            } else {
                address.ip()
            };
            match auth::new_sign_in_code(&home) {
                Ok(code) => println!(
                    "Sign in: http://{}/login?code={}\nThe link works once and expires in 10 minutes. Run `hexbot pair` for a new code.",
                    SocketAddr::new(ip, port),
                    code["code"].as_str().unwrap_or("")
                ),
                Err(error) => eprintln!("Sign-in link: {error}"),
            }
        }
        println!("HERMES_BACKEND_READY port={port}");
        std::io::stdout().flush()?;
        let mut tick = tokio::time::interval(std::time::Duration::from_millis(250));
        let mut update = None;
        let mut terminated = false;
        let mut rebind = false;
        loop {
            tokio::select! {
                _ = &mut signal => {
                    terminated = true;
                    break;
                }
                result = &mut serving => {
                    app.shutdown().await;
                    let _ = services::shutdown(&home).await;
                    let _ = std::fs::remove_file(home.join("serve-state.json"));
                    return result
                        .map_err(|e| Error::new(5200, e.to_string()))?
                        .map_err(Into::into);
                }
                _ = tick.tick() => {
                    if let Some(path) = services::take_restart(&home).await? {
                        update = Some(path);
                        break;
                    }
                    if hexbot_core::settings::get(&home)?["lan_enabled"]
                        .as_bool()
                        .unwrap_or(false)
                        != enabled
                    {
                        rebind = true;
                        break;
                    }
                }
            }
        }
        // Close established WebSockets as well as listeners before waiting for Axum.
        if rebind {
            app.disconnect();
            previous = Some(app);
        } else {
            app.shutdown().await;
        }
        let _ = services::shutdown(&home).await;
        let _ = std::fs::remove_file(home.join("serve-state.json"));
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
        }
    }
    Ok(())
}
/// Registers the handlers before returning, so a SIGTERM or SIGINT that arrives
/// between the ready line and the first poll still shuts the daemon down cleanly.
fn shutdown_signal() -> impl std::future::Future<Output = ()> {
    use tokio::signal::unix::{SignalKind, signal};
    let term = signal(SignalKind::terminate()).ok();
    let interrupt = signal(SignalKind::interrupt()).ok();
    async move {
        let wait = |signal: Option<tokio::signal::unix::Signal>| async move {
            match signal {
                Some(mut signal) => {
                    signal.recv().await;
                }
                None => std::future::pending().await,
            }
        };
        tokio::select! {_=wait(term)=>{},_=wait(interrupt)=>{}}
    }
}
#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("{error}");
        std::process::exit(1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn legacy_listener_blocks_a_second_daemon_even_on_another_port() {
        let home = tempfile::tempdir().unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::fs::create_dir_all(home.path().join("runtime")).unwrap();
        std::fs::write(home.path().join("runtime/native-transition-pending"), "1").unwrap();
        std::fs::write(
            home.path().join("serve-state.json"),
            format!(r#"{{"host":"0.0.0.0","port":{port}}}"#),
        )
        .unwrap();
        assert!(
            lock_home(home.path())
                .unwrap_err()
                .to_string()
                .contains("Stop the existing Hexbot daemon")
        );
        std::fs::remove_file(home.path().join("runtime/native-transition-pending")).unwrap();
        assert!(lock_home(home.path()).is_ok());
        drop(listener);
        assert!(lock_home(home.path()).is_ok());
    }
    #[cfg(unix)]
    #[test]
    fn transition_cleanup_refuses_symlink_runtime_roots() {
        let home = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        common::atomic_write(&outside.path().join("native-transition-pending"), b"1").unwrap();
        common::atomic_write(&outside.path().join("src/data"), b"keep").unwrap();
        std::os::unix::fs::symlink(outside.path(), home.path().join("runtime")).unwrap();
        assert!(finish_native_transition(home.path()).is_err());
        assert!(outside.path().join("src/data").is_file());
    }
    #[test]
    fn transition_cleanup_removes_python_but_preserves_data_and_service_shim() {
        let home = tempfile::tempdir().unwrap();
        for file in [
            "runtime/venv/bin/python",
            "runtime/venv/lib/dependency",
            "runtime/src/old/source.py",
            "runtime/native-transition-pending",
            "state.db",
            "bots/owl/MEMORY.md",
        ] {
            common::atomic_write(&home.path().join(file), b"keep user data").unwrap();
        }
        let shim = home.path().join("runtime/venv/bin/hexbot");
        common::atomic_write(&shim, b"#!/bin/sh\nexec native").unwrap();
        finish_native_transition(home.path()).unwrap();
        assert!(!home.path().join("runtime/src").exists());
        assert!(!home.path().join("runtime/venv/lib").exists());
        assert!(!home.path().join("runtime/venv/bin/python").exists());
        assert!(shim.is_file());
        assert!(home.path().join("state.db").is_file());
        assert!(home.path().join("bots/owl/MEMORY.md").is_file());
        finish_native_transition(home.path()).unwrap();
        common::atomic_write(
            &home.path().join("runtime/native-transition-pending"),
            b"remove-shim",
        )
        .unwrap();
        finish_native_transition(home.path()).unwrap();
        assert!(!home.path().join("runtime/venv").exists());
    }
}

#[cfg(test)]
mod sign_in_tests {
    use super::prints_sign_in_link;
    #[test]
    fn only_a_terminal_without_a_supervisor_prints_the_link() {
        let env = |vars: &'static [(&'static str, &'static str)]| {
            move |name: &str| {
                vars.iter()
                    .find(|(key, _)| *key == name)
                    .map(|(_, value)| value.to_string())
            }
        };
        assert!(prints_sign_in_link(true, env(&[])));
        assert!(prints_sign_in_link(true, env(&[("XPC_SERVICE_NAME", "0")])));
        assert!(!prints_sign_in_link(
            true,
            env(&[("XPC_SERVICE_NAME", "application.com.apple.Terminal.1")])
        ));
        assert!(!prints_sign_in_link(false, env(&[])));
        for name in ["HEXBOT_SUPERVISOR", "INVOCATION_ID", "XPC_SERVICE_NAME"] {
            assert!(!prints_sign_in_link(true, |key| (key == name).then(String::new)));
        }
        assert!(!prints_sign_in_link(
            true,
            env(&[("HEXBOT_SUPERVISOR", "desktop")])
        ));
        assert!(!prints_sign_in_link(
            true,
            env(&[("HEXBOT_SUPERVISOR", "dev")])
        ));
        assert!(!prints_sign_in_link(true, env(&[("INVOCATION_ID", "abc")])));
        assert!(!prints_sign_in_link(
            true,
            env(&[("XPC_SERVICE_NAME", "app.hexbot.daemon")])
        ));
    }
}
