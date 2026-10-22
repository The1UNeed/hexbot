//! Ownership of scripts written by the native Windows CLI.
use std::{
    fs, io,
    path::{Path, PathBuf},
};
const MARKER: &str = "# Hexbot owned home: ";
fn owner(path: &Path) -> Option<PathBuf> {
    if !fs::symlink_metadata(path).ok()?.is_file() {
        return None;
    }
    let text = fs::read_to_string(path).ok()?;
    serde_json::from_str(
        text.trim_start_matches('\u{feff}')
            .lines()
            .next()?
            .strip_prefix(MARKER)?,
    )
    .ok()
}
pub fn wrapper_owned(path: &Path, home: &Path) -> bool {
    owner(path).is_some_and(|owner| {
        crate::install_ownership::resolved(&owner).ok()
            == crate::install_ownership::resolved(home).ok()
    })
}
pub fn check_service(path: &Path, home: &Path) -> io::Result<()> {
    if matches!(fs::symlink_metadata(path), Err(e) if e.kind() == io::ErrorKind::NotFound)
        || wrapper_owned(path, home)
    {
        Ok(())
    } else {
        Err(io::Error::other(
            "Existing Windows service belongs to another installation",
        ))
    }
}
pub fn foreign_wrapper_owner(path: &Path, home: &Path) -> io::Result<Option<PathBuf>> {
    if matches!(fs::symlink_metadata(path), Err(e) if e.kind() == io::ErrorKind::NotFound)
        || wrapper_owned(path, home)
    {
        return Ok(None);
    }
    Ok(Some(owner(path).ok_or_else(|| {
        io::Error::other("Unrecognized Windows CLI wrapper; left it alone")
    })?))
}
