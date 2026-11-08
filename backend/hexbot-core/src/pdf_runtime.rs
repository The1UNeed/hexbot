//! The Mac PDF capability in an authenticated native runtime. Never reads PDFs.
use crate::{Error, Result};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{fs, io::Read, path::Path};

pub(crate) const REPAIR: &str = "The PDF VM runtime is missing, damaged or unsupported. Run the Hexbot installer again and choose Update or repair.";
pub(crate) const FILES: &[&str] = &[
    "hexbot-pdf-vm",
    "manifest.json",
    "kernel",
    "initramfs",
    "rootfs",
    "kernel.provenance.json",
    "PROVENANCE.json",
    "THIRD_PARTY_NOTICES",
    "SOURCES.json",
];

fn invalid() -> Error {
    Error::new(5243, REPAIR)
}
pub(crate) fn manifest(directory: &Path) -> Result<Value> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options
        .open(directory.join("manifest.json"))
        .map_err(|_| invalid())?;
    if !file.metadata().map_err(|_| invalid())?.is_file() {
        return Err(invalid());
    }
    let mut bytes = Vec::new();
    file.take(1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| invalid())?;
    if bytes.len() > 1024 * 1024 {
        return Err(invalid());
    }
    serde_json::from_slice(&bytes).map_err(|_| invalid())
}
fn limit(name: &str) -> u64 {
    match name {
        "kernel" | "hexbot-pdf-vm" => 64 * 1024 * 1024,
        "initramfs" => 32 * 1024 * 1024,
        "rootfs" => 192 * 1024 * 1024,
        "manifest.json" => 128 * 1024,
        "SOURCES.json" | "THIRD_PARTY_NOTICES" => 8 * 1024 * 1024,
        _ => 2 * 1024 * 1024,
    }
}

fn file(directory: &Path, name: &str) -> Result<fs::File> {
    let path = directory.join(name);
    let info = fs::symlink_metadata(&path).map_err(|_| invalid())?;
    if !info.is_file() || info.len() == 0 || info.len() > limit(name) {
        return Err(invalid());
    }
    #[cfg(unix)]
    if name == "hexbot-pdf-vm" {
        use std::os::unix::ffi::OsStrExt;
        use std::os::unix::fs::PermissionsExt;
        let path = std::ffi::CString::new(path.as_os_str().as_bytes()).map_err(|_| invalid())?;
        if info.permissions().mode() & 0o111 == 0
            || unsafe {
                libc::faccessat(
                    libc::AT_FDCWD,
                    path.as_ptr(),
                    libc::R_OK | libc::X_OK,
                    libc::AT_EACCESS,
                )
            } != 0
        {
            return Err(invalid());
        }
    }
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(path).map_err(|_| invalid())?;
    if !file.metadata().map_err(|_| invalid())?.is_file() {
        return Err(invalid());
    }
    Ok(file)
}

pub(crate) fn verify(directory: &Path, manifest: &Value) -> Result<()> {
    if manifest["pdfVm"] != 1 {
        return Err(invalid());
    }
    let expected_arch = match manifest["target"].as_str() {
        Some("darwin-arm64" | "macos-aarch64") => "aarch64",
        Some("darwin-x64" | "macos-x86_64") => "x86_64",
        _ => return Err(invalid()),
    };
    let pdf = directory.join("pdf");
    if !fs::symlink_metadata(&pdf).map_err(|_| invalid())?.is_dir() {
        return Err(invalid());
    }
    let hashes = manifest["files"].as_object().ok_or_else(invalid)?;
    if hashes.keys().filter(|key| key.starts_with("pdf/")).count() != FILES.len() {
        return Err(invalid());
    }
    for name in FILES {
        let expected = hashes
            .get(&format!("pdf/{name}"))
            .and_then(Value::as_str)
            .ok_or_else(invalid)?;
        let mut reader = file(&pdf, name)?.take(limit(name) + 1);
        let mut digest = Sha256::new();
        let mut total = 0;
        let mut chunk = [0; 65_536];
        loop {
            let count = reader.read(&mut chunk).map_err(|_| invalid())?;
            if count == 0 {
                break;
            }
            total += count as u64;
            if total > limit(name) {
                return Err(invalid());
            }
            digest.update(&chunk[..count]);
        }
        if format!("{:x}", digest.finalize()) != expected {
            return Err(invalid());
        }
    }
    let mut data = Vec::new();
    file(&pdf, "manifest.json")?
        .take(limit("manifest.json") + 1)
        .read_to_end(&mut data)
        .map_err(|_| invalid())?;
    let inner: Value = serde_json::from_slice(&data).map_err(|_| invalid())?;
    if inner["version"] != 1
        || inner["architecture"] != expected_arch
        || inner["files"]
            .as_object()
            .is_none_or(|files| files.len() != 3)
        || ["kernel", "initramfs", "rootfs"]
            .iter()
            .any(|name| inner["files"][name] != hashes[&format!("pdf/{name}")])
    {
        return Err(invalid());
    }
    let mut header = [0; 8];
    file(&pdf, "hexbot-pdf-vm")?
        .read_exact(&mut header)
        .map_err(|_| invalid())?;
    let cpu = if expected_arch == "aarch64" {
        0x0100_000c_u32
    } else {
        0x0100_0007_u32
    };
    if header[..4] != [0xcf, 0xfa, 0xed, 0xfe] || header[4..] != cpu.to_le_bytes() {
        return Err(invalid());
    }
    Ok(())
}

#[cfg(all(test, unix))]
pub(crate) fn fixture(root: &Path, manifest: &mut Value) {
    use std::os::unix::fs::PermissionsExt;
    let arm = manifest["target"] == "darwin-arm64";
    let dir = root.join("pdf");
    fs::create_dir_all(&dir).unwrap();
    for name in FILES {
        fs::write(dir.join(name), name).unwrap();
    }
    let cpu = if arm {
        0x0100_000c_u32
    } else {
        0x0100_0007_u32
    };
    fs::write(
        dir.join("hexbot-pdf-vm"),
        [vec![0xcf, 0xfa, 0xed, 0xfe], cpu.to_le_bytes().to_vec()].concat(),
    )
    .unwrap();
    fs::set_permissions(dir.join("hexbot-pdf-vm"), fs::Permissions::from_mode(0o755)).unwrap();
    let hashes: serde_json::Map<_, _> = ["kernel", "initramfs", "rootfs"]
        .into_iter()
        .map(|name| {
            (
                name.into(),
                serde_json::json!(crate::services::file_sha256(&dir.join(name)).unwrap()),
            )
        })
        .collect();
    fs::write(dir.join("manifest.json"), serde_json::json!({"version":1,"architecture":if arm {"aarch64"} else {"x86_64"},"files":hashes}).to_string()).unwrap();
    manifest["pdfVm"] = serde_json::json!(1);
    for name in FILES {
        manifest["files"][format!("pdf/{name}")] =
            serde_json::json!(crate::services::file_sha256(&dir.join(name)).unwrap());
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn verifies_native_architecture_marker_and_every_pdf_file() {
        for target in ["darwin-arm64", "darwin-x64"] {
            let root = tempfile::tempdir().unwrap();
            let mut manifest = json!({"target":target,"files":{}});
            fixture(root.path(), &mut manifest);
            fs::write(root.path().join("manifest.json"), manifest.to_string()).unwrap();
            assert_eq!(super::manifest(root.path()).unwrap(), manifest);
            verify(root.path(), &manifest).unwrap();
            for marker in [Value::Null, json!(2), json!("1")] {
                let mut bad = manifest.clone();
                bad["pdfVm"] = marker;
                assert!(verify(root.path(), &bad).is_err());
            }
            let mut wrong = manifest.clone();
            wrong["target"] = json!(if target == "darwin-arm64" {
                "darwin-x64"
            } else {
                "darwin-arm64"
            });
            assert!(verify(root.path(), &wrong).is_err());
            for name in FILES {
                let path = root.path().join("pdf").join(name);
                let bytes = fs::read(&path).unwrap();
                fs::write(&path, b"damaged").unwrap();
                assert!(verify(root.path(), &manifest).is_err(), "{name}");
                fs::write(&path, bytes).unwrap();
            }
        }
    }

    #[test]
    fn refuses_linked_oversized_and_architecture_conflicting_pdf_assets() {
        use std::os::unix::fs::{PermissionsExt, symlink};
        let root = tempfile::tempdir().unwrap();
        let mut manifest = json!({"target":"darwin-arm64","files":{}});
        fixture(root.path(), &mut manifest);
        let dir = root.path().join("pdf");
        let kernel = dir.join("kernel");
        fs::rename(&kernel, dir.join("other")).unwrap();
        symlink("other", &kernel).unwrap();
        assert!(verify(root.path(), &manifest).is_err());
        fs::remove_file(&kernel).unwrap();
        fs::rename(dir.join("other"), &kernel).unwrap();
        let helper = dir.join("hexbot-pdf-vm");
        fs::set_permissions(&helper, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(verify(root.path(), &manifest).is_err());
        fs::set_permissions(&helper, fs::Permissions::from_mode(0o401)).unwrap();
        use std::os::unix::ffi::OsStrExt;
        let path = std::ffi::CString::new(helper.as_os_str().as_bytes()).unwrap();
        let executable = unsafe {
            libc::faccessat(
                libc::AT_FDCWD,
                path.as_ptr(),
                libc::R_OK | libc::X_OK,
                libc::AT_EACCESS,
            )
        } == 0;
        assert_eq!(
            verify(root.path(), &manifest).is_ok(),
            executable,
            "helper acceptance must match effective-user read/execute access"
        );
        fs::set_permissions(&helper, fs::Permissions::from_mode(0o755)).unwrap();
        fs::write(
            &helper,
            [
                vec![0xcf, 0xfa, 0xed, 0xfe],
                0x0100_0007_u32.to_le_bytes().to_vec(),
            ]
            .concat(),
        )
        .unwrap();
        manifest["files"]["pdf/hexbot-pdf-vm"] =
            json!(crate::services::file_sha256(&helper).unwrap());
        assert!(verify(root.path(), &manifest).is_err());
        fixture(root.path(), &mut manifest);
        fs::OpenOptions::new()
            .write(true)
            .open(&kernel)
            .unwrap()
            .set_len(limit("kernel") + 1)
            .unwrap();
        assert!(verify(root.path(), &manifest).is_err());
        let outer = root.path().join("manifest.json");
        fs::write(&outer, vec![b' '; 1024 * 1024 + 1]).unwrap();
        assert!(super::manifest(root.path()).is_err());
        fs::remove_file(&outer).unwrap();
        symlink(dir.join("manifest.json"), &outer).unwrap();
        assert!(super::manifest(root.path()).is_err());
    }
}
