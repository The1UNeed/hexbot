use hexbot_installer::{
    InstallOption, InstallResult, Installer, Progress, Result, Track, default_track,
};
use std::io::{self, IsTerminal, Write};

#[derive(Default)]
struct Args {
    option: Option<InstallOption>,
    track: Option<Track>,
    repair: bool,
    uninstall: bool,
    remove_data: bool,
    yes: bool,
    json: bool,
}

fn parse_args() -> Result<Args> {
    let mut args = Args::default();
    for argument in std::env::args().skip(1) {
        match argument.as_str() {
            "--headless" | "--client" | "--full" => {
                let option = match argument.as_str() {
                    "--headless" => InstallOption::Headless,
                    "--client" => InstallOption::Client,
                    _ => InstallOption::Full,
                };
                if args.option.replace(option).is_some() {
                    return Err("Choose only one install option.".into());
                }
            }
            "--stable" | "--nightly" => {
                let track = if argument == "--stable" {
                    Track::Stable
                } else {
                    Track::Nightly
                };
                if args.track.replace(track).is_some() {
                    return Err("Choose only one track.".into());
                }
            }
            "--repair" => args.repair = true,
            "--uninstall" => args.uninstall = true,
            "--remove-data" => args.remove_data = true,
            "--yes" => args.yes = true,
            "--json" => args.json = true,
            "--version" => {
                println!("{}", hexbot_installer::version());
                std::process::exit(0);
            }
            "--help" | "-h" => {
                println!(
                    "Hexbot installer\n\nhexbot-install [--headless|--client|--full] [--stable|--nightly]\nhexbot-install --repair\nhexbot-install --uninstall [--remove-data]\n\n--yes   Accept changes and uninstall without prompting\n--json  Write machine-readable progress\n\nHEXBOT_UPDATE_URL overrides the update server. HEXBOT_TRACK sets the default track."
                );
                std::process::exit(0);
            }
            _ => return Err(format!("Unknown argument: {argument}").into()),
        }
    }
    if usize::from(args.option.is_some()) + usize::from(args.repair) + usize::from(args.uninstall)
        > 1
    {
        return Err("Choose one of install, repair, or uninstall.".into());
    }
    if args.remove_data && !args.uninstall {
        return Err("--remove-data requires --uninstall.".into());
    }
    if args.track.is_none() {
        args.track = match std::env::var("HEXBOT_TRACK").ok().as_deref() {
            Some("stable") => Some(Track::Stable),
            Some("nightly") => Some(Track::Nightly),
            None => None,
            _ => return Err("HEXBOT_TRACK must be stable or nightly.".into()),
        };
    }
    Ok(args)
}

fn prompt(message: &str) -> Result<String> {
    eprint!("{message} ");
    io::stderr().flush()?;
    let mut line = String::new();
    if io::stdin().read_line(&mut line)? == 0 {
        return Err("No answer was entered.".into());
    }
    Ok(line.trim().to_string())
}

fn choose() -> Result<InstallOption> {
    eprintln!(
        "1) Headless  The daemon alone, as a background service. Use it from other devices over LAN, Tailscale, or Hex Connect.\n2) Client    The desktop app alone. Connects to a daemon on another computer.\n3) Full      The desktop app and the daemon on this computer."
    );
    loop {
        match prompt("Choose 1, 2, or 3:")?.as_str() {
            "1" => return Ok(InstallOption::Headless),
            "2" => return Ok(InstallOption::Client),
            "3" => return Ok(InstallOption::Full),
            _ => eprintln!("Enter 1, 2, or 3."),
        }
    }
}

fn confirm(message: &str, yes: bool, interactive: bool) -> bool {
    yes || (interactive
        && prompt(&format!("{message} [y/N]"))
            .is_ok_and(|answer| matches!(answer.to_ascii_lowercase().as_str(), "y" | "yes")))
}

fn show_progress(event: Progress, json: bool, bar_active: &mut bool) {
    if json {
        println!("{}", serde_json::to_string(&event).expect("progress JSON"));
        return;
    }
    if let (Some(done), Some(total)) = (event.downloaded, event.total) {
        let filled = done
            .saturating_mul(25)
            .checked_div(total)
            .unwrap_or(0)
            .min(25) as usize;
        eprint!(
            "\r[{}{}] {:.1} / {:.1} MB",
            "=".repeat(filled),
            " ".repeat(25 - filled),
            done as f64 / 1_000_000.0,
            total as f64 / 1_000_000.0
        );
        let _ = io::stderr().flush();
        *bar_active = true;
    } else {
        if *bar_active {
            eprintln!();
            *bar_active = false;
        }
        eprintln!("{}", event.message);
    }
}

fn pairing_addresses(status: &serde_json::Value) -> Vec<String> {
    let port = status["port"].as_u64().unwrap_or(9119);
    let mut lines = Vec::new();
    if status["lan_enabled"] == true {
        for address in status["lan_addresses"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(serde_json::Value::as_str)
            .filter(|address| Some(*address) != status["tailscale_ipv4"].as_str())
        {
            lines.push(format!("LAN        {address}:{port}"));
        }
    }
    if status["lan_enabled"] == true
        && let Some(address) = status["tailscale_ipv4"].as_str()
    {
        lines.push(format!("Tailscale  {address}:{port}"));
    }
    lines
}

fn lan_hint(status: &serde_json::Value) -> &'static str {
    if status["lan_enabled"] == true {
        "Turn off LAN:     hexbot lan off"
    } else {
        "LAN access is off. Turn it on with: hexbot lan on"
    }
}

fn show_result(result: InstallResult, json: bool) {
    if json {
        println!("{}", serde_json::json!({"stage":"result", "result":result}));
    } else if let Some(status) = result.status {
        let port = status["port"].as_u64().unwrap_or(9119);
        eprintln!(
            "Daemon {} on port {port}.",
            if status["running"] == true {
                "running"
            } else {
                "installed"
            }
        );
        for line in pairing_addresses(&status) {
            eprintln!("{line}");
        }
        if let Some(hostname) = status["connect_hostname"].as_str() {
            eprintln!("Hex Connect: https://{hostname}");
        }
        eprintln!(
            "\nPair a device:     hexbot pair\nUse Hex Connect:   hexbot connect\nCheck the daemon:  hexbot status\nRead service logs: hexbot service logs\n{}",
            lan_hint(&status)
        );
    }
}

fn package_manager_notice(installed: &hexbot_installer::Installed) -> Option<&'static str> {
    installed.apps.iter().any(|app| app.managed_by_dpkg).then_some(
        "Hexbot was installed with your package manager. Update it with apt, or remove it with sudo apt remove hexbot, then run this installer again. Your Hexbot data will be kept."
    )
}

fn run() -> Result<()> {
    let mut args = parse_args()?;
    let interactive = io::stdin().is_terminal() && !args.json;
    let engine = Installer::from_env()?;
    let installed = engine.detect()?;
    if args.option.is_none() && !args.repair && !args.uninstall {
        if !interactive {
            return Err("Choose --headless, --client, --full, --repair, or --uninstall.".into());
        }
        eprintln!("Welcome to Hexbot.");
        if let Some(notice) = package_manager_notice(&installed) {
            eprintln!("{notice}");
            return Ok(());
        }
        if let Some(option) = installed.option() {
            if let Some(receipt) = &installed.receipt {
                eprintln!(
                    "Hexbot {option} is installed ({} {}).",
                    receipt.channel, receipt.version
                );
            } else {
                eprintln!("Hexbot {option} is installed.");
            }
            eprintln!("1) Update or repair\n2) Change to another option\n3) Uninstall");
            match prompt("Choose 1, 2, or 3:")?.as_str() {
                "1" => {
                    args.option = Some(option);
                }
                "2" => {
                    args.option = Some(choose()?);
                }
                "3" => {
                    args.uninstall = true;
                    args.remove_data = confirm("Also delete your Hexbot data?", false, interactive);
                }
                _ => return Err("Enter 1, 2, or 3.".into()),
            }
        } else {
            if installed.runtime {
                eprintln!(
                    "Hexbot daemon files were found in {}. Your data stays.",
                    engine.paths.hexbot_home.display()
                );
            }
            args.option = Some(choose()?);
        }
    }
    let mut bar_active = false;
    let mut progress = |event| show_progress(event, args.json, &mut bar_active);
    if args.uninstall {
        let message = if args.remove_data {
            "Remove Hexbot and permanently delete its data?"
        } else {
            "Remove Hexbot? Your Hexbot data will be kept."
        };
        if !confirm(message, args.yes, interactive) {
            return Err("Uninstall cancelled. Use --yes to confirm in a script.".into());
        }
        engine.uninstall(args.remove_data, &mut progress)?;
    } else {
        let result = if args.repair {
            engine.repair(&mut progress)?
        } else {
            let option = args.option.ok_or("Choose an install option.")?;
            let track = match args.track.or(installed.track()) {
                Some(track) => track,
                None => default_track(&engine.base_url)?,
            };
            if let Some(from) = installed.option().filter(|from| *from != option) {
                engine.change(
                    from,
                    option,
                    track,
                    &mut |message| confirm(message, args.yes, interactive),
                    &mut progress,
                )?
            } else {
                engine.apply(option, track, &mut progress)?
            }
        };
        show_result(result, args.json);
    }
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        if std::env::args().any(|arg| arg == "--json") {
            println!(
                "{}",
                serde_json::json!({"stage":"error", "message":error.to_string()})
            );
        } else {
            eprintln!("\n{error}");
        }
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn package_managed_apps_replace_the_interactive_menu_with_a_notice() {
        let mut installed = hexbot_installer::Installed::default();
        assert!(package_manager_notice(&installed).is_none());
        installed.apps.push(hexbot_installer::InstalledApp {
            path: "/opt/Hexbot".into(),
            option: InstallOption::Full,
            app_id: "app.hexbot.desktop".into(),
            version: None,
            managed_by_dpkg: true,
        });
        assert!(
            package_manager_notice(&installed)
                .unwrap()
                .contains("Update it with apt")
        );
        installed.apps[0].managed_by_dpkg = false;
        assert!(package_manager_notice(&installed).is_none());
    }
    #[test]
    fn pairing_addresses_respect_lan_setting_and_have_no_url_scheme() {
        let mut status = serde_json::json!({"port":9119,"lan_enabled":false,"lan_addresses":["192.168.1.20", "100.64.0.1"],"tailscale_ipv4":"100.64.0.1"});
        assert!(pairing_addresses(&status).is_empty());
        assert_eq!(
            lan_hint(&status),
            "LAN access is off. Turn it on with: hexbot lan on"
        );
        status["lan_enabled"] = true.into();
        assert_eq!(lan_hint(&status), "Turn off LAN:     hexbot lan off");
        assert_eq!(
            pairing_addresses(&status),
            ["LAN        192.168.1.20:9119", "Tailscale  100.64.0.1:9119"]
        );
    }
}
