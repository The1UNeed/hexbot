//! Local daemon, network and service status.
use crate::{Error, Result, common, credentials, settings, system_service};
use serde_json::{Value, json};
use std::{path::Path, process::Stdio, time::Duration};
use tokio::process::Command;

async fn tailscale() -> Option<String> {
    let output = tokio::time::timeout(
        Duration::from_secs(3),
        Command::new("tailscale")
            .args(["ip", "-4"])
            .stdin(Stdio::null())
            .kill_on_drop(true)
            .output(),
    )
    .await
    .ok()?
    .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .find_map(|line| {
            line.trim()
                .parse::<std::net::Ipv4Addr>()
                .ok()
                .map(|ip| ip.to_string())
        })
}
pub async fn run(home: &Path, args: &[String]) -> Result<()> {
    if !args.is_empty() && args != ["--json"] {
        return Err(Error::new(4200, "status accepts only --json"));
    }
    let network = settings::network(home)?;
    let info = crate::cli::daemon_info(home).await?;
    let config = common::read_config(home)?;
    let connect = config
        .pointer("/dashboard/public_url")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .and_then(|s| url::Url::parse(s).ok())
        .and_then(|url| url.host_str().map(str::to_owned));
    let (service, tailscale) = tokio::join!(system_service::status(home), tailscale());
    let selected: Value = std::fs::read(home.join("runtime/native-current.json"))
        .ok()
        .and_then(|s| serde_json::from_slice(&s).ok())
        .unwrap_or(Value::Null);
    let version = info
        .as_ref()
        .and_then(|v| v["version"].as_str())
        .or_else(|| selected["version"].as_str())
        .map(str::to_owned)
        .unwrap_or_else(crate::version);
    let sandbox = info
        .as_ref()
        .map(|v| !v["sandbox"].is_null())
        .unwrap_or_else(|| credentials::sandbox().is_some());
    let status = json!({"running":info.is_some(),"version":version,"port":network["port"],
        "lan_addresses":network["addresses"],"lan_enabled":network["lan_enabled"],
        "tailscale_ipv4":tailscale,"connect_hostname":connect,"service":service?,"sandbox_available":sandbox});
    if args == ["--json"] {
        println!("{status}");
    } else {
        println!("{}", human(&status));
    }
    Ok(())
}
fn human(status: &Value) -> String {
    let version = status["version"].as_str().unwrap_or("unknown");
    let port = status["port"].as_u64().unwrap_or(9119);
    let mut lines = vec![if status["running"] == true {
        format!("Hexbot daemon {version} is running on port {port}")
    } else {
        format!("Hexbot daemon {version} is not running")
    }];
    if status["lan_enabled"] == true {
        for address in status["lan_addresses"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .filter(|address| Some(*address) != status["tailscale_ipv4"].as_str())
        {
            lines.push(format!("LAN          {address}:{port}"));
        }
    } else {
        lines.push("LAN          disabled".into());
    }
    if status["lan_enabled"] == true
        && let Some(address) = status["tailscale_ipv4"].as_str()
    {
        lines.push(format!("Tailscale    {address}:{port}"));
    }
    lines.push(format!(
        "Hex Connect  {}",
        status["connect_hostname"]
            .as_str()
            .unwrap_or("not set up (run: hexbot connect)")
    ));
    lines.push(format!(
        "Service      {}",
        if status["service"]["installed"] == true {
            if status["service"]["running"] == true {
                "installed, running, starts at login"
            } else {
                "installed, stopped, starts at login"
            }
        } else {
            "not installed"
        }
    ));
    lines.push(format!(
        "Sandbox      {}",
        if status["sandbox_available"] == true {
            "available"
        } else {
            "unavailable"
        }
    ));
    lines.push("Pair a device: hexbot pair".into());
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pairing_addresses_require_lan() {
        let mut status = json!({"port":9119,"lan_enabled":false,"lan_addresses":["192.0.2.1", "100.64.0.1"],"tailscale_ipv4":"100.64.0.1"});
        assert!(!human(&status).contains("192.0.2.1"));
        assert!(!human(&status).contains("100.64.0.1"));
        status["lan_enabled"] = true.into();
        assert!(human(&status).contains("LAN          192.0.2.1:9119"));
        assert_eq!(human(&status).matches("100.64.0.1").count(), 1);
        assert!(human(&status).contains("Tailscale    100.64.0.1:9119"));
    }

    #[test]
    fn stopped_daemon_uses_product_words() {
        let output = human(
            &json!({"version":"0.1.5","running":false,"port":9119,"service":{"installed":false},"sandbox_available":true}),
        );
        assert!(output.starts_with("Hexbot daemon 0.1.5 is not running\n"));
        assert!(output.contains("Hex Connect  not set up (run: hexbot connect)"));
        assert!(output.ends_with("Pair a device: hexbot pair"));
    }
}
