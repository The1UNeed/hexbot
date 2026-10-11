use crate::{InstalledApp, Installer, Result, Track, app_option, detect, fail};
use std::{
    fs,
    io::{BufReader, Read, Seek, SeekFrom},
    path::Path,
};

fn parse(version: &str) -> Option<semver::Version> {
    semver::Version::parse(version).ok()
}

fn track(version: &semver::Version) -> Option<Track> {
    if version.pre.as_str().starts_with("nightly.") {
        Some(Track::Nightly)
    } else {
        Some(Track::Stable)
    }
}

fn app_track(id: &str) -> Option<Track> {
    if app_option(id).is_none() || id.ends_with(".dev") {
        None
    } else if id.ends_with(".nightly") {
        Some(Track::Nightly)
    } else {
        Some(Track::Stable)
    }
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
            if app_track(&app.app_id) == Some(offered_track)
                && let Some(version) = self.app_version(&app)?
            {
                versions.push(version);
            }
        }
        if self.target.is_macos() {
            for directory in self.paths.app_dirs(self.target) {
                let entries = match fs::read_dir(directory) {
                    Ok(entries) => entries,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                    Err(error) => return Err(error.into()),
                };
                // An interrupted replacement may strand the latest app inside
                // staging. Count it for every option, even when installing the
                // other edition or Headless would not recover that app.
                for entry in entries {
                    let entry = entry?;
                    if !entry.file_name().to_string_lossy().starts_with(".tmp")
                        || !entry.file_type()?.is_dir()
                    {
                        continue;
                    }
                    let previous = entry.path().join("previous.app");
                    if fs::symlink_metadata(&previous).is_ok_and(|m| m.is_dir())
                        && let Some(id) = detect::plist_value(&previous, "CFBundleIdentifier")
                        && app_track(&id) == Some(offered_track)
                        && let Some(version) =
                            detect::plist_value(&previous, "CFBundleShortVersionString")
                                .as_deref()
                                .and_then(parse)
                    {
                        versions.push(version);
                    }
                }
            }
        }
        let runtime = self.paths.hexbot_home.join("runtime");
        if let Ok(bytes) = fs::read(runtime.join("native-current.json"))
            && let Ok(current) = serde_json::from_slice::<serde_json::Value>(&bytes)
            && let Some(version) = current["version"].as_str().and_then(parse)
            && track(&version) == Some(offered_track)
            && let Ok(executable) = self.paths.executable().canonicalize()
            && current["executable"].as_str().map(Path::new) == Some(executable.as_path())
            && executable.is_file()
            && let Ok(native) = runtime.join("native").canonicalize()
            && executable.starts_with(native)
        {
            versions.push(version);
        }
        Ok(versions.into_iter().max_by(semver::Version::cmp_precedence))
    }

    fn app_version(&self, app: &InstalledApp) -> Result<Option<semver::Version>> {
        if let Some(version) = app.version.as_deref().and_then(parse) {
            return Ok(Some(version));
        }
        if app.managed_by_dpkg {
            return Ok(asar_version(&app.path.join("resources/app.asar")));
        }
        if self.target.is_macos() {
            return Ok(None);
        }
        appimage_version(&app.path)
    }
}

/// Read electron-builder's embedded desktop metadata directly from SquashFS.
/// Installer-created .desktop files and custom AppImage filenames can be stale.
fn appimage_version(path: &Path) -> Result<Option<semver::Version>> {
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
    fail(format!(
        "Could not read the installed app version from {}. Nothing was installed.",
        path.display()
    ))
}

/// Read only package.json from an installed Electron ASAR, without launching it.
fn asar_version(path: &Path) -> Option<semver::Version> {
    let mut file = fs::File::open(path).ok()?;
    let mut prefix = [0; 16];
    file.read_exact(&mut prefix).ok()?;
    let word = |at| u32::from_le_bytes(prefix[at..at + 4].try_into().unwrap()) as u64;
    let header_size = word(4);
    let json_size = word(12);
    if word(0) != 4 || json_size > 16 * 1024 * 1024 || json_size + 8 > header_size {
        return None;
    }
    let mut header = vec![0; json_size as usize];
    file.read_exact(&mut header).ok()?;
    let header: serde_json::Value = serde_json::from_slice(&header).ok()?;
    let package = &header["files"]["package.json"];
    let offset = package["offset"].as_str()?.parse::<u64>().ok()?;
    let size = package["size"].as_u64()?;
    if size > 1024 * 1024 {
        return None;
    }
    file.seek(SeekFrom::Start(
        8u64.checked_add(header_size)?.checked_add(offset)?,
    ))
    .ok()?;
    let mut bytes = vec![0; size as usize];
    file.read_exact(&mut bytes).ok()?;
    let package: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    package["version"].as_str().and_then(parse)
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
