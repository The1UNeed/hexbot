//! A small native argv forwarder, separate from the immutable daemon executable.
use sha2::{Digest, Sha256};
use std::{
    fs, io,
    path::{Path, PathBuf},
};
fn metadata(path: &Path) -> io::Result<serde_json::Value> {
    if !fs::symlink_metadata(path.with_extension("json"))?.is_file() {
        return Err(io::Error::other("CLI configuration is not a regular file"));
    }
    serde_json::from_slice(&fs::read(path.with_extension("json"))?).map_err(io::Error::other)
}
pub fn owner(path: &Path) -> Option<PathBuf> {
    if !fs::symlink_metadata(path).ok()?.is_file() {
        return None;
    }
    let value = metadata(path).ok()?;
    let hash = format!("{:x}", Sha256::digest(fs::read(path).ok()?));
    if value["schema"] != 1
        || !value["hashes"]
            .as_array()?
            .iter()
            .any(|v| v.as_str() == Some(&hash))
    {
        return None;
    }
    Some(PathBuf::from(value["home"].as_str()?))
}
pub fn owned(path: &Path, home: &Path) -> bool {
    owner(path).is_some_and(|owner| {
        owner
            .canonicalize()
            .ok()
            .zip(home.canonicalize().ok())
            .is_some_and(|(a, b)| a == b)
    })
}
#[cfg(windows)]
pub fn install(source: &Path, home: &Path, bin: &Path) -> io::Result<PathBuf> {
    use std::io::Write;
    fs::create_dir_all(bin)?;
    let _lock = lock(bin)?;
    let path = bin.join("hexbot.exe");
    if path.exists() && !owned(&path, home) {
        return Err(io::Error::other(
            "Existing CLI belongs to another installation",
        ));
    }
    let path_added = metadata(&path).ok().is_some_and(|v| v["pathAdded"] == true);
    let mut hashes = Vec::new();
    if path.exists() {
        hashes.push(format!("{:x}", Sha256::digest(fs::read(&path)?)));
    }
    let bytes = fs::read(source)?;
    let hash = format!("{:x}", Sha256::digest(&bytes));
    if !hashes.contains(&hash) {
        hashes.push(hash);
    }
    let config = path.with_extension("json");
    if !path.exists() && config.exists() {
        let previous = metadata(&path)?;
        if previous["home"]
            .as_str()
            .map(Path::new)
            .and_then(|p| p.canonicalize().ok())
            != Some(home.canonicalize()?)
        {
            return Err(io::Error::other(
                "Existing CLI configuration belongs to another installation",
            ));
        }
    }
    // Commit ownership first, accepting both the previous and new trusted hash.
    // Interruption before or after the EXE rename remains recoverable.
    let mut record = tempfile::NamedTempFile::new_in(bin)?;
    record.write_all(serde_json::json!({"schema":1,"home":home.canonicalize()?,"hashes":hashes,"pathAdded":path_added}).to_string().as_bytes())?;
    record.as_file().sync_all()?;
    record.persist(&config).map_err(|e| e.error)?;
    if fs::read(&path).ok().as_deref() != Some(bytes.as_slice()) {
        let mut staged = tempfile::NamedTempFile::new_in(bin)?;
        staged.write_all(&bytes)?;
        staged.as_file().sync_all()?;
        if let Err(error) = staged.persist(&path) {
            // Windows may lock a forwarder while it waits for this setup child.
            // Its v1 selection/argv protocol remains compatible. Keep the
            // verified previous forwarder; Full setup or a direct installer
            // refreshes it once that invocation has exited.
            if error.error.kind() != io::ErrorKind::PermissionDenied || !owned(&path, home) {
                return Err(error.error);
            }
            eprintln!(
                "CLI forwarding component is in use; its verified previous copy stays until the next setup."
            );
        }
    }
    Ok(path)
}

#[cfg(windows)]
fn change_path(bin: &Path, add: bool) -> io::Result<bool> {
    use std::os::windows::process::CommandExt;
    if std::env::var("HEXBOT_CLI_NO_PATH").as_deref() == Ok("1") {
        return Ok(false);
    }
    let output = std::process::Command::new(crate::windows_paths::system_program(
        "WindowsPowerShell/v1.0/powershell.exe",
    )?)
    .args([
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        include_str!("../assets/windows-cli-path.ps1"),
    ])
    .env("HEXBOT_CLI_BIN", bin)
    .env("HEXBOT_CLI_PATH_ACTION", if add { "add" } else { "remove" })
    .creation_flags(0x08000000)
    .output()?;
    if !output.status.success() {
        return Err(io::Error::other(String::from_utf8_lossy(&output.stderr)));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim() == "changed")
}
#[cfg(windows)]
pub fn register_path(path: &Path) -> io::Result<()> {
    use std::io::Write;
    let _lock = lock(
        path.parent()
            .ok_or_else(|| io::Error::other("Missing CLI directory"))?,
    )?;
    if change_path(
        path.parent()
            .ok_or_else(|| io::Error::other("Missing CLI directory"))?,
        true,
    )? {
        let mut record = metadata(path)?;
        record["pathAdded"] = serde_json::json!(true);
        let mut staged = tempfile::NamedTempFile::new_in(path.parent().unwrap())?;
        staged.write_all(record.to_string().as_bytes())?;
        staged.as_file().sync_all()?;
        staged
            .persist(path.with_extension("json"))
            .map_err(|e| e.error)?;
    }
    Ok(())
}
#[cfg(windows)]
fn unregister_path(path: &Path) -> io::Result<()> {
    if metadata(path)?["pathAdded"] == true {
        change_path(
            path.parent()
                .ok_or_else(|| io::Error::other("Missing CLI directory"))?,
            false,
        )?;
    }
    Ok(())
}

#[cfg(windows)]
fn lock(bin: &Path) -> io::Result<fs::File> {
    let file = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(bin.join(".hexbot-cli.lock"))?;
    file.lock()?;
    Ok(file)
}
#[cfg(windows)]
pub fn remove(path: &Path, home: &Path) -> io::Result<()> {
    let _lock = lock(
        path.parent()
            .ok_or_else(|| io::Error::other("Missing CLI directory"))?,
    )?;
    if !owned(path, home) {
        return Err(io::Error::other("CLI belongs to another installation"));
    }
    unregister_path(path)?;
    fs::remove_file(path)?;
    fs::remove_file(path.with_extension("json"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_the_recorded_home_and_trusted_forwarder_hash_are_owned() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("state");
        fs::create_dir(&home).unwrap();
        let file = root.path().join("hexbot.exe");
        fs::write(&file, b"trusted forwarder").unwrap();
        assert!(!owned(&file, &home));
        let hash = format!("{:x}", Sha256::digest(b"trusted forwarder"));
        fs::write(
            file.with_extension("json"),
            serde_json::json!({"schema":1,"home":home,"hashes":[hash,"pending new build hash"]})
                .to_string(),
        )
        .unwrap();
        assert!(owned(&file, &home));
        assert!(!owned(&file, root.path()));
        fs::write(&file, b"unrelated executable").unwrap();
        assert!(!owned(&file, &home));
    }
}
