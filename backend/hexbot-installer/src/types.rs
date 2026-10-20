use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, fmt, path::PathBuf};

use crate::{Result, fail};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Track {
    Stable,
    Nightly,
}

impl fmt::Display for Track {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Stable => "stable",
            Self::Nightly => "nightly",
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum InstallOption {
    Headless,
    Client,
    Full,
}

impl fmt::Display for InstallOption {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Headless => "Headless",
            Self::Client => "Client",
            Self::Full => "Full",
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Target {
    #[serde(rename = "macos-aarch64")]
    MacosAarch64,
    #[serde(rename = "macos-x86_64")]
    MacosX86_64,
    #[serde(rename = "linux-x86_64")]
    LinuxX86_64,
}

impl Target {
    pub fn detect() -> Result<Self> {
        Self::from_platform(std::env::consts::OS, std::env::consts::ARCH)
    }

    pub fn from_platform(os: &str, arch: &str) -> Result<Self> {
        match (os, arch) {
            ("macos", "aarch64") => Ok(Self::MacosAarch64),
            ("macos", "x86_64") => Ok(Self::MacosX86_64),
            ("linux", "x86_64") => Ok(Self::LinuxX86_64),
            _ => fail(format!("Hexbot is not available for {os}/{arch}.")),
        }
    }

    pub fn is_macos(self) -> bool {
        self != Self::LinuxX86_64
    }
}

impl fmt::Display for Target {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::MacosAarch64 => "macos-aarch64",
            Self::MacosX86_64 => "macos-x86_64",
            Self::LinuxX86_64 => "linux-x86_64",
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Artifact {
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default)]
    pub sha256: Option<String>,
    #[serde(default)]
    pub sha512: Option<String>,
    pub size: u64,
    #[serde(default)]
    pub format: Option<String>,
    #[serde(default)]
    pub product_name: Option<String>,
    #[serde(default)]
    pub app_id: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Artifacts {
    pub headless: Option<Artifact>,
    pub client: Option<Artifact>,
    pub full: Option<Artifact>,
    pub installer: Option<Artifact>,
    pub installer_app: Option<Artifact>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub schema: u32,
    pub channel: Track,
    pub version: String,
    pub min_installer: String,
    pub targets: BTreeMap<String, Artifacts>,
}

impl Manifest {
    pub fn validate(&self, installer_version: &str) -> Result<()> {
        if self.schema != 1 {
            return fail("This install manifest has an unsupported schema.");
        }
        semver::Version::parse(&self.version)?;
        if semver::Version::parse(installer_version)? < semver::Version::parse(&self.min_installer)?
        {
            return fail(
                "This installer is too old. Run the install command again to get the current one.",
            );
        }
        Ok(())
    }

    pub fn artifact(&self, target: Target, option: InstallOption) -> Result<&Artifact> {
        let artifact = self
            .targets
            .get(&target.to_string())
            .and_then(|a| match option {
                InstallOption::Headless => a.headless.as_ref(),
                InstallOption::Client => a.client.as_ref(),
                InstallOption::Full => a.full.as_ref(),
            });
        artifact
            .ok_or_else(|| format!("Hexbot {option} is not available for this computer.").into())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    pub option: InstallOption,
    pub channel: Track,
    pub version: String,
    pub paths: Vec<PathBuf>,
    pub installed_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Progress {
    pub stage: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub downloaded: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<u64>,
}

impl Progress {
    pub fn new(stage: &str, message: impl Into<String>) -> Self {
        Self {
            stage: stage.into(),
            message: message.into(),
            downloaded: None,
            total: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct InstalledApp {
    pub path: PathBuf,
    pub option: InstallOption,
    pub app_id: String,
    pub version: Option<String>,
    /// Package-manager installs must be removed with that package manager.
    pub managed_by_dpkg: bool,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct Installed {
    pub receipt: Option<Receipt>,
    pub apps: Vec<InstalledApp>,
    pub service: bool,
    pub runtime: bool,
    pub wrapper: bool,
}

impl Installed {
    pub fn option(&self) -> Option<InstallOption> {
        self.receipt
            .as_ref()
            .map(|r| r.option)
            .or_else(|| {
                self.apps
                    .iter()
                    .find(|a| a.option == InstallOption::Full)
                    .map(|a| a.option)
            })
            .or_else(|| self.apps.first().map(|a| a.option))
            .or_else(|| (self.service || self.wrapper).then_some(InstallOption::Headless))
    }

    pub fn track(&self) -> Option<Track> {
        self.receipt.as_ref().map(|r| r.channel).or_else(|| {
            self.apps.first().and_then(|a| {
                if a.app_id.ends_with(".dev") {
                    None
                } else if a.app_id.ends_with(".nightly") {
                    Some(Track::Nightly)
                } else {
                    Some(Track::Stable)
                }
            })
        })
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct InstallResult {
    pub receipt: Receipt,
    pub status: Option<serde_json::Value>,
    pub warnings: Vec<String>,
}
