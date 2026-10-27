//! Resolve managed installation paths without following a broken pointer.
use std::{
    fs, io,
    path::{Path, PathBuf},
};

pub fn resolved(path: &Path) -> io::Result<PathBuf> {
    if !path.is_absolute()
        || path
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(io::Error::other("Expected an absolute path without '..'"));
    }
    match path.canonicalize() {
        Ok(path) => Ok(path),
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            // A broken symlink is not an absent path.
            if fs::symlink_metadata(path).is_ok() {
                return Err(e);
            }
            Ok(resolved(path.parent().ok_or(e)?)?.join(path.file_name().unwrap()))
        }
        Err(e) => Err(e),
    }
}
