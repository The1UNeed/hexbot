//! Receipt authority is limited to one known release identity whose leaf is absent.
use crate::{InstallOption, Installed, Paths, Receipt, Result, Target, Track, detect};
use std::{
    fs,
    path::{Path, PathBuf},
};

pub(crate) const REPAIR_FIRST: &str = "The app folder is missing but its Windows entry remains. Repair the app before changing or uninstalling it.";
pub(crate) const ENTRY_REMAINS: &str = "The app folder was already missing. Its Windows entry was not removed because its ownership could not be verified.";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Registration {
    None,
    ExactStale,
    Other,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct MissingApp {
    pub id: &'static str,
    pub option: InstallOption,
    pub track: Track,
    pub path: PathBuf,
    pub version: semver::Version,
}

impl MissingApp {
    /// Pure identity check. This does not authorize any existing filesystem object.
    pub fn receipt(receipt: &Receipt, root: &Path) -> Option<Self> {
        let id = match (receipt.option, receipt.channel) {
            (InstallOption::Full, Track::Stable) => "app.hexbot.desktop",
            (InstallOption::Full, Track::Nightly) => "app.hexbot.desktop.nightly",
            (InstallOption::Client, Track::Stable) => "app.hexbot.client",
            (InstallOption::Client, Track::Nightly) => "app.hexbot.client.nightly",
            _ => return None,
        };
        let version = semver::Version::parse(&receipt.version).ok()?;
        if receipt.paths != [root.join(id)]
            || crate::installed_version::track(&version) != receipt.channel
            || version.pre.as_str().split('.').any(|part| part == "dev")
        {
            return None;
        }
        Some(Self {
            id,
            option: receipt.option,
            track: receipt.channel,
            path: root.join(id),
            version,
        })
    }
}

pub(crate) fn absent(paths: &Paths, installed: &Installed) -> Result<Option<MissingApp>> {
    let root = paths.planned_apps_dir(Target::WindowsX86_64)?;
    let Some(app) = installed
        .receipt
        .as_ref()
        .and_then(|receipt| MissingApp::receipt(receipt, &root))
    else {
        return Ok(None);
    };
    if installed
        .apps
        .iter()
        .any(|existing| existing.app_id == app.id)
    {
        return Ok(None);
    }
    match fs::symlink_metadata(&app.path) {
        Ok(_) => return Ok(None),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    match fs::symlink_metadata(root) {
        Ok(meta) if !detect::ordinary(&meta) || !meta.is_dir() => {
            return crate::fail("The Windows apps root is not an ordinary directory.");
        }
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(error.into()),
        _ => {}
    }
    Ok(Some(app))
}

/// Drive spelling only. Never resolve a registry string, especially UNC paths.
#[cfg(any(windows, test))]
pub(crate) fn drive_path(value: &str) -> Option<String> {
    let value = value.replace('/', "\\");
    let bytes = value.as_bytes();
    if value.encode_utf16().count() > 4096
        || bytes.len() < 4
        || !bytes[0].is_ascii_alphabetic()
        || bytes[1..3] != *b":\\"
        || value
            .chars()
            .any(|c| c.is_control() || matches!(c, '\'' | '"' | '%'))
    {
        return None;
    }
    let value = value.trim_end_matches('\\');
    if value.len() <= 3 {
        return None;
    }
    if value[3..].split('\\').any(|part| {
        part.is_empty()
            || matches!(part, "." | "..")
            || part.ends_with(['.', ' '])
            || part.contains(':')
    }) {
        return None;
    }
    Some(value.to_ascii_lowercase())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn receipt_identity_is_exact_and_version_matches_track() {
        let root = Path::new("/trusted/apps");
        for option in [InstallOption::Full, InstallOption::Client] {
            for track in [Track::Stable, Track::Nightly] {
                let id = format!(
                    "app.hexbot.{}{}",
                    if option == InstallOption::Full {
                        "desktop"
                    } else {
                        "client"
                    },
                    if track == Track::Nightly {
                        ".nightly"
                    } else {
                        ""
                    }
                );
                let receipt = Receipt {
                    option,
                    channel: track,
                    version: if track == Track::Nightly {
                        "1.2.3-nightly.1"
                    } else {
                        "1.2.3"
                    }
                    .into(),
                    paths: vec![root.join(&id)],
                    installed_at: String::new(),
                };
                assert_eq!(MissingApp::receipt(&receipt, root).unwrap().id, id);
                for bad in [
                    "extra", "parent", "sibling", "option", "track", "version", "dev",
                ] {
                    let mut changed = receipt.clone();
                    match bad {
                        "extra" => changed.paths.push(root.join(&id)),
                        "parent" => changed.paths = vec![root.into()],
                        "sibling" => changed.paths = vec![root.join("other")],
                        "option" => changed.option = InstallOption::Headless,
                        "track" => {
                            changed.channel = if track == Track::Stable {
                                Track::Nightly
                            } else {
                                Track::Stable
                            }
                        }
                        "version" => changed.version = "invalid".into(),
                        _ => changed.version = "1.2.3-dev".into(),
                    }
                    assert!(MissingApp::receipt(&changed, root).is_none(), "{bad}");
                }
            }
        }
    }
    #[test]
    fn registry_drive_spelling_has_no_namespace_or_path_ambiguity() {
        assert_eq!(
            drive_path("C:/José/apps/app.hexbot.client/"),
            drive_path(r"c:\José\apps\app.hexbot.client")
        );
        for bad in [
            r"\\server\share\app",
            r"\\?\C:\apps\app",
            r"C:apps\app",
            r"C:\apps\..\app",
            r"C:\apps\.\app",
            r"C:\apps\\app",
            r"C:\apps\app.",
            r"C:\apps\app ",
            r"C:\%USER%\app",
            "C:\\a'pp",
            "C:\\a\npp",
            r#"C:\a"pp"#,
            r"C:\app:stream",
            r"C:\",
        ] {
            assert!(drive_path(bad).is_none(), "{bad}");
        }
    }
}
