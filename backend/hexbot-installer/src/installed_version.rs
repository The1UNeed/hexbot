use crate::{InstalledApp, Installer, Result, Track, app_option, detect};
use std::{
    fs,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
};

fn parse(version: &str) -> Option<semver::Version> {
    semver::Version::parse(version).ok()
}

pub(crate) fn track(version: &semver::Version) -> Track {
    if version.pre.as_str().starts_with("nightly.") {
        Track::Nightly
    } else {
        Track::Stable
    }
}

/// Release apps only. The app id names the track a package was installed
/// from, but the app updater can move it to the other track in Settings, so
/// the version decides which floor it sets.
fn release_app(id: &str) -> bool {
    app_option(id).is_some() && !id.ends_with(".dev")
}

/// A runtime launcher is a file inside `runtime/native`.
fn in_native(native: &Path, executable: &Path) -> bool {
    executable.starts_with(native) && executable.is_file()
}

/// The version recorded in a native runtime package beside its launcher.
fn package_version(executable: &Path) -> Option<semver::Version> {
    let bytes = fs::read(executable.parent()?.join("manifest.json")).ok()?;
    let manifest: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    manifest["version"].as_str().and_then(parse)
}

/// The track of the verified Windows runtime selection. Its Windows manifest
/// and native-current.json must name one release version; otherwise unknown.
pub(crate) fn windows_runtime_track(home: &Path) -> Option<Track> {
    let executable = crate::native_selection::selected(home).ok()?;
    let read = |path: &Path| -> Option<serde_json::Value> {
        serde_json::from_slice(&fs::read(path).ok()?).ok()
    };
    let manifest = read(&executable.parent()?.join("manifest.json"))?;
    let recorded = read(&home.join("runtime/native-current.json"))?;
    let version = manifest["version"].as_str().and_then(parse)?;
    (manifest["target"] == "win32-x64"
        && recorded["version"] == manifest["version"]
        && version.build.is_empty())
    .then(|| track(&version))
}

/// A macOS app a killed install left in its staging directory: the staging
/// directory and the Hexbot bundle inside it.
pub(crate) struct StrandedApp {
    pub staging: PathBuf,
    pub app: PathBuf,
    pub id: String,
}

impl Installer {
    /// Automatic app/native updates do not advance the install receipt. Read
    /// the current packages as well, including installs made without a receipt.
    pub(crate) fn installed_version(
        &self,
        offered_track: Track,
    ) -> Result<Option<semver::Version>> {
        let installed = self.detect()?;
        let mut versions = Vec::new();
        if let Some(receipt) = installed.receipt
            && receipt.channel == offered_track
            && let Some(version) = parse(&receipt.version)
        {
            versions.push(version);
        }
        for app in installed.apps {
            if release_app(&app.app_id)
                && let Some(version) = self.app_version(&app)?
                && track(&version) == offered_track
            {
                versions.push(version);
            }
        }
        // An interrupted replacement may strand the latest app inside staging.
        // Count it for every option, even when installing the other edition or
        // Headless would not recover that app.
        for stranded in self.stranded_apps()? {
            if release_app(&stranded.id)
                && let Some(version) =
                    detect::plist_value(&stranded.app, "CFBundleShortVersionString")
                        .as_deref()
                        .and_then(parse)
                && track(&version) == offered_track
            {
                versions.push(version);
            }
        }
        // Activation writes native-current.json and swaps native-executable in
        // two steps (the daemon and `hexbot setup` in one order, the desktop
        // bootstrap in the other), so either may be ahead after a crash. Count
        // the package the pointer selects and the one the metadata names.
        let runtime = self.paths.hexbot_home.join("runtime");
        if let Ok(native) = runtime.join("native").canonicalize() {
            let selected = self
                .paths
                .executable()
                .canonicalize()
                .ok()
                .filter(|executable| in_native(&native, executable))
                .and_then(|executable| package_version(&executable));
            let recorded = fs::read(runtime.join("native-current.json"))
                .ok()
                .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
                .and_then(|current| {
                    let executable = Path::new(current["executable"].as_str()?)
                        .canonicalize()
                        .ok()?;
                    in_native(&native, &executable)
                        .then(|| current["version"].as_str().and_then(parse))
                        .flatten()
                });
            versions.extend(
                [selected, recorded]
                    .into_iter()
                    .flatten()
                    .filter(|version| track(version) == offered_track),
            );
        }
        Ok(versions.into_iter().max_by(semver::Version::cmp_precedence))
    }

    /// Hexbot bundles stranded in `.tmp*/previous.app` inside the app folders.
    pub(crate) fn stranded_apps(&self) -> Result<Vec<StrandedApp>> {
        let mut stranded = Vec::new();
        if !self.target.is_macos() {
            return Ok(stranded);
        }
        for directory in self.paths.app_dirs(self.target) {
            let entries = match fs::read_dir(directory) {
                Ok(entries) => entries,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error.into()),
            };
            for entry in entries {
                let entry = entry?;
                if !entry.file_name().to_string_lossy().starts_with(".tmp")
                    || !entry.file_type()?.is_dir()
                {
                    continue;
                }
                let app = entry.path().join("previous.app");
                if fs::symlink_metadata(&app).is_ok_and(|m| m.is_dir())
                    && let Some(id) = detect::plist_value(&app, "CFBundleIdentifier")
                    && app_option(&id).is_some()
                {
                    stranded.push(StrandedApp {
                        staging: entry.path(),
                        app,
                        id,
                    });
                }
            }
        }
        Ok(stranded)
    }

    pub(crate) fn app_version(&self, app: &InstalledApp) -> Result<Option<semver::Version>> {
        if let Some(version) = app.version.as_deref().and_then(parse) {
            return Ok(Some(version));
        }
        if app.managed_by_dpkg || self.target.is_windows() {
            return if self.target.is_windows() {
                Ok(asar_version_checked(&app.path.join("resources/app.asar"))?)
            } else {
                Ok(asar_version(&app.path.join("resources/app.asar")))
            };
        }
        if !self.target.is_linux() {
            return Ok(None);
        }
        appimage_version(&app.path)
    }
}

/// AppImages are installed only on Linux.
#[cfg(not(target_os = "linux"))]
fn appimage_version(_: &Path) -> Result<Option<semver::Version>> {
    Ok(None)
}

/// Read electron-builder's embedded desktop metadata directly from SquashFS.
/// Installer-created .desktop files and custom AppImage filenames can be stale.
#[cfg(target_os = "linux")]
fn appimage_version(path: &Path) -> Result<Option<semver::Version>> {
    use std::io::BufReader;
    let mut file = fs::File::open(path)?;
    let mut prefix = Vec::new();
    // Type 2 AppImages append SquashFS to a small ELF runtime. Limit the search
    // to the runtime prefix rather than scanning the whole app or executing it.
    (&mut file)
        .take(16 * 1024 * 1024)
        .read_to_end(&mut prefix)?;
    if !prefix.starts_with(b"\x7fELF") || prefix.get(8..11) != Some(&b"AI\x02"[..]) {
        return Ok(None);
    }
    for (offset, header) in prefix.windows(32).enumerate() {
        if &header[..4] != b"hsqs" || header[28..32] != [4, 0, 0, 0] {
            continue;
        }
        let Ok(filesystem) = backhand::FilesystemReader::from_reader_with_offset(
            BufReader::new(file.try_clone()?),
            offset as u64,
        ) else {
            continue;
        };
        let version = filesystem
            .files()
            .filter_map(|node| {
                if node.fullpath.extension()? != "desktop"
                    || node.fullpath.parent()? != Path::new("/")
                {
                    return None;
                }
                let backhand::InnerNode::File(data) = &node.inner else {
                    return None;
                };
                let mut text = String::new();
                filesystem
                    .file(data)
                    .reader()
                    .take(64 * 1024)
                    .read_to_string(&mut text)
                    .ok()?;
                text.lines()
                    .find_map(|line| line.strip_prefix("X-AppImage-Version=").and_then(parse))
            })
            .max_by(semver::Version::cmp_precedence);
        if version.is_some() {
            return Ok(version);
        }
    }
    crate::fail(format!(
        "Could not read the app version from {}. Delete that file, then run the installer again. Your Hexbot data will be kept. Nothing was installed.",
        path.display()
    ))
}

/// Read only package.json from an installed Electron ASAR, without launching it.
pub(crate) fn asar_version(path: &Path) -> Option<semver::Version> {
    asar_version_checked(path).ok().flatten()
}

// Truncated/invalid package bytes have no version. Access, device and other
// filesystem errors must not become permission to repair an unreadable path.
fn asar_version_checked(path: &Path) -> std::io::Result<Option<semver::Version>> {
    let mut file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    fn read(file: &mut fs::File, size: usize) -> std::io::Result<Option<Vec<u8>>> {
        let mut bytes = vec![0; size];
        match file.read_exact(&mut bytes) {
            Ok(()) => Ok(Some(bytes)),
            Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => Ok(None),
            Err(error) => Err(error),
        }
    }
    let Some(prefix) = read(&mut file, 16)? else {
        return Ok(None);
    };
    let word = |at| u32::from_le_bytes(prefix[at..at + 4].try_into().unwrap()) as u64;
    let header_size = word(4);
    let json_size = word(12);
    if word(0) != 4 || json_size > 16 * 1024 * 1024 || json_size + 8 > header_size {
        return Ok(None);
    }
    let Some(header) = read(&mut file, json_size as usize)? else {
        return Ok(None);
    };
    let Ok(header) = serde_json::from_slice::<serde_json::Value>(&header) else {
        return Ok(None);
    };
    let package = &header["files"]["package.json"];
    let Some((offset, size)) = package["offset"]
        .as_str()
        .and_then(|s| s.parse::<u64>().ok())
        .zip(package["size"].as_u64())
    else {
        return Ok(None);
    };
    let Some(offset) = 8u64
        .checked_add(header_size)
        .and_then(|n| n.checked_add(offset))
    else {
        return Ok(None);
    };
    if size > 1024 * 1024 {
        return Ok(None);
    }
    file.seek(SeekFrom::Start(offset))?;
    let Some(bytes) = read(&mut file, size as usize)? else {
        return Ok(None);
    };
    let Ok(package) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
        return Ok(None);
    };
    Ok(package["version"].as_str().and_then(parse))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_packaged_electron_version_without_running_the_app() {
        let temp = tempfile::tempdir().unwrap();
        let package = br#"{"version":"1.2.3-nightly.20261011.7"}"#;
        let header = serde_json::to_vec(&serde_json::json!({"files": {
            "package.json": {"offset": "0", "size": package.len()}
        }}))
        .unwrap();
        let size = (header.len() + 11) & !3;
        let mut bytes = Vec::new();
        for word in [4, size as u32, (size - 4) as u32, header.len() as u32] {
            bytes.extend(word.to_le_bytes());
        }
        bytes.extend(header);
        bytes.resize(size + 8, 0);
        bytes.extend(package);
        let path = temp.path().join("app.asar");
        fs::write(&path, &bytes).unwrap();
        assert_eq!(
            asar_version(&path).unwrap().to_string(),
            "1.2.3-nightly.20261011.7"
        );
        for invalid in [&bytes[..8], &[4, 0, 0, 0, 255, 255, 255, 255][..]] {
            fs::write(&path, invalid).unwrap();
            assert!(asar_version(&path).is_none());
        }
    }
}
