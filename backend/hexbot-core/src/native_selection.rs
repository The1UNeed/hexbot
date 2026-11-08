//! Windows selects immutable runtimes through metadata, without symlink privileges.
use std::{
    fs, io,
    path::{Path, PathBuf},
};

pub fn selected(home: &Path) -> io::Result<PathBuf> {
    let root = home.join("runtime/native").canonicalize()?;
    let current: serde_json::Value =
        serde_json::from_slice(&fs::read(home.join("runtime/native-current.json"))?)
            .map_err(io::Error::other)?;
    let path = Path::new(
        current["executable"]
            .as_str()
            .ok_or_else(|| io::Error::other("Missing native executable"))?,
    )
    .canonicalize()?;
    if !path.starts_with(root)
        || !path.is_file()
        || path.file_name().is_none_or(|n| n != "hexbot.exe")
    {
        return Err(io::Error::other("Invalid Windows runtime selection"));
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn selection_requires_a_real_exe_inside_the_native_directory() {
        let home = tempfile::tempdir().unwrap();
        fs::create_dir_all(home.path().join("runtime/native/build")).unwrap();
        for name in [
            "runtime/native/build/hexbot.exe",
            "runtime/native/build/wrong.exe",
            "outside.exe",
        ] {
            let exe = home.path().join(name);
            fs::write(&exe, b"MZ").unwrap();
            fs::write(
                home.path().join("runtime/native-current.json"),
                serde_json::json!({"executable":exe}).to_string(),
            )
            .unwrap();
            assert_eq!(
                selected(home.path()).is_ok(),
                name == "runtime/native/build/hexbot.exe"
            );
        }
    }
}
