//! The container engine the bots' computer runs in: Colima, OrbStack, Docker
//! Desktop, or Docker as a user service. Cua finds a running one by itself.
//! When none answers, as after the daemon's computer restarts for an update,
//! the daemon starts the one the computer was made in, so the computer comes
//! back without the user.
use crate::{Error, Result, native_tools};
use serde_json::Value;
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

/// Colima boots a VM; the slowest engine to start.
const START_WAIT: Duration = Duration::from_secs(300);

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Engine {
    /// A Colima profile, `default` unless the user made another.
    Colima(String),
    OrbStack,
    DockerDesktop,
    /// Docker as the user's own systemd service (rootless Docker on Linux).
    Docker,
    /// `computer_use.engine_start` in config.yaml: an engine Hexbot does not know.
    Custom(Vec<String>),
}

impl Engine {
    /// The engine's name in what the user reads.
    pub fn name(&self) -> &'static str {
        match self {
            Self::Colima(_) => "Colima",
            Self::OrbStack => "OrbStack",
            Self::DockerDesktop => "Docker Desktop",
            Self::Docker => "Docker",
            Self::Custom(_) => "the container engine",
        }
    }
    /// How computer.json remembers it.
    pub fn id(&self) -> Option<String> {
        Some(match self {
            Self::Colima(profile) => format!("colima:{profile}"),
            Self::OrbStack => "orbstack".into(),
            Self::DockerDesktop => "docker-desktop".into(),
            Self::Docker => "docker".into(),
            Self::Custom(_) => return None,
        })
    }
    fn from_id(id: &str) -> Option<Self> {
        Some(match id {
            "orbstack" => Self::OrbStack,
            "docker-desktop" => Self::DockerDesktop,
            "docker" => Self::Docker,
            _ => Self::Colima(id.strip_prefix("colima:")?.to_owned()),
        })
    }
    fn command(&self) -> Vec<String> {
        let words: &[&str] = match self {
            Self::Colima(profile) => return vec!["colima".into(), "start".into(), profile.clone()],
            Self::OrbStack => &["orb", "start"],
            Self::DockerDesktop if cfg!(target_os = "macos") => &["open", "-g", "-a", "Docker"],
            Self::DockerDesktop => &["systemctl", "--user", "start", "docker-desktop"],
            Self::Docker => &["systemctl", "--user", "start", "docker"],
            Self::Custom(command) => return command.clone(),
        };
        words.iter().map(|w| (*w).to_owned()).collect()
    }
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

/// The engine a Docker endpoint such as `unix:///Users/me/.colima/default/docker.sock` belongs to.
pub fn from_endpoint(host: &str) -> Option<Engine> {
    let path = host.strip_prefix("unix://")?;
    if let Some(rest) = path.split("/.colima/").nth(1) {
        let profile = rest.split('/').next().filter(|p| *p != "docker.sock");
        return Some(Engine::Colima(profile.unwrap_or("default").to_owned()));
    }
    if path.contains("/.orbstack/") {
        return Some(Engine::OrbStack);
    }
    if path.ends_with("/.docker/run/docker.sock") || path.contains("/.docker/desktop/") {
        return Some(Engine::DockerDesktop);
    }
    if path.starts_with("/run/user/") && path.ends_with("/docker.sock") {
        return Some(Engine::Docker);
    }
    None
}

/// Where Docker clients connect: `DOCKER_HOST`, else the current Docker
/// context. Both outlive a stopped engine, whose socket is gone.
fn endpoint() -> Option<String> {
    if let Ok(host) = std::env::var("DOCKER_HOST")
        && !host.is_empty()
    {
        return Some(host);
    }
    let config = std::env::var_os("DOCKER_CONFIG")
        .map(PathBuf::from)
        .or_else(|| home_dir().map(|h| h.join(".docker")))?;
    let context = std::env::var("DOCKER_CONTEXT")
        .ok()
        .filter(|c| !c.is_empty())
        .or_else(|| {
            let text = std::fs::read_to_string(config.join("config.json")).ok()?;
            serde_json::from_str::<Value>(&text).ok()?["currentContext"]
                .as_str()
                .map(str::to_owned)
        })
        .filter(|c| c != "default")?;
    std::fs::read_dir(config.join("contexts/meta"))
        .ok()?
        .flatten()
        .filter_map(|dir| std::fs::read_to_string(dir.path().join("meta.json")).ok())
        .filter_map(|text| serde_json::from_str::<Value>(&text).ok())
        .find(|meta| meta["Name"] == context.as_str())
        .and_then(|meta| {
            meta["Endpoints"]["docker"]["Host"]
                .as_str()
                .map(str::to_owned)
        })
}

/// The engine of whatever Docker answers on now, to remember for later.
pub fn current() -> Option<Engine> {
    endpoint().and_then(|e| from_endpoint(&e)).or_else(|| {
        let home = home_dir()?;
        [
            ".colima/default/docker.sock",
            ".colima/docker.sock",
            ".orbstack/run/docker.sock",
            ".docker/run/docker.sock",
        ]
        .iter()
        .map(|socket| home.join(socket))
        .find(|socket| socket.exists())
        .and_then(|socket| from_endpoint(&format!("unix://{}", socket.display())))
    })
}

/// The one installed, when nothing says which.
fn installed() -> Option<Engine> {
    let home = home_dir()?;
    if native_tools::on_path("colima").is_some() && home.join(".colima/default").is_dir() {
        return Some(Engine::Colima("default".into()));
    }
    if native_tools::on_path("orb").is_some() {
        return Some(Engine::OrbStack);
    }
    if cfg!(target_os = "macos") && Path::new("/Applications/Docker.app").is_dir() {
        return Some(Engine::DockerDesktop);
    }
    if cfg!(target_os = "linux") {
        let units = home.join(".config/systemd/user");
        if units.join("docker-desktop.service").exists() {
            return Some(Engine::DockerDesktop);
        }
        if units.join("docker.service").exists() {
            return Some(Engine::Docker);
        }
    }
    None
}

/// The engine to start: the configured one, the one the computer last ran
/// in, the current Docker context's, or the only one installed.
pub fn find(cfg: &Value, remembered: Option<&str>) -> Option<Engine> {
    if let Some(command) = cfg["computer_use"]["engine_start"].as_array() {
        let words = command
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect::<Vec<_>>();
        if !words.is_empty() {
            return Some(Engine::Custom(words));
        }
    }
    remembered
        .and_then(Engine::from_id)
        .or_else(|| endpoint().and_then(|e| from_endpoint(&e)))
        .or_else(installed)
}

/// Starts the engine. It returns once the command does, which for Colima is
/// once Docker answers; the others answer a little later.
pub async fn start(engine: &Engine) -> Result<()> {
    let words = engine.command();
    let (program, args) = words
        .split_first()
        .ok_or_else(|| Error::new(4211, "no command"))?;
    let path = native_tools::on_path(program)
        .ok_or_else(|| Error::new(4211, format!("{program} is not installed")))?;
    let mut cmd = tokio::process::Command::new(&path);
    crate::credentials::desktop_environment(&mut cmd);
    // Colima runs limactl and docker from beside itself.
    if let Some(dir) = path.parent() {
        let rest = std::env::var_os("PATH").unwrap_or_default();
        let joined = std::env::join_paths(
            std::iter::once(dir.to_owned()).chain(std::env::split_paths(&rest)),
        )
        .unwrap_or(rest);
        cmd.env("PATH", joined);
    }
    // The engine outlives this command; a timeout must not kill what it began.
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let output = tokio::time::timeout(START_WAIT, cmd.output())
        .await
        .map_err(|_| Error::new(4211, "it took too long to start"))??;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let line = stderr
        .lines()
        .map(str::trim)
        .rfind(|line| !line.is_empty())
        .unwrap_or("it stopped with an error");
    // Colima logs as `time=... level=fatal msg="..."`.
    let line = line
        .split_once("msg=")
        .map_or(line, |(_, msg)| msg)
        .trim_matches('"');
    Err(Error::new(4211, line.chars().take(300).collect::<String>()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_endpoint_names_its_engine() {
        for (host, engine) in [
            (
                "unix:///Users/me/.colima/default/docker.sock",
                Some(Engine::Colima("default".into())),
            ),
            (
                "unix:///Users/me/.colima/work/docker.sock",
                Some(Engine::Colima("work".into())),
            ),
            (
                "unix:///Users/me/.colima/docker.sock",
                Some(Engine::Colima("default".into())),
            ),
            (
                "unix:///Users/me/.orbstack/run/docker.sock",
                Some(Engine::OrbStack),
            ),
            (
                "unix:///Users/me/.docker/run/docker.sock",
                Some(Engine::DockerDesktop),
            ),
            ("unix:///run/user/1000/docker.sock", Some(Engine::Docker)),
            ("unix:///var/run/docker.sock", None),
            ("tcp://10.0.0.2:2375", None),
        ] {
            assert_eq!(from_endpoint(host), engine, "{host}");
        }
    }

    #[test]
    fn a_remembered_engine_comes_back_from_its_id() {
        for engine in [
            Engine::Colima("work".into()),
            Engine::OrbStack,
            Engine::DockerDesktop,
            Engine::Docker,
        ] {
            assert_eq!(Engine::from_id(&engine.id().unwrap()), Some(engine));
        }
        assert_eq!(Engine::from_id("podman"), None);
    }

    #[test]
    fn a_configured_start_command_wins() {
        let cfg = serde_json::json!({"computer_use":{"engine_start":["podman","machine","start"]}});
        assert_eq!(
            find(&cfg, Some("orbstack")),
            Some(Engine::Custom(vec![
                "podman".into(),
                "machine".into(),
                "start".into()
            ]))
        );
        assert_eq!(
            find(&serde_json::json!({}), Some("orbstack")),
            Some(Engine::OrbStack)
        );
    }
}
