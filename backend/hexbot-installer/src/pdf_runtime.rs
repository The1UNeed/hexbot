use crate::{Result, Target, fail};
use sha2::{Digest, Sha256};
#[cfg(unix)]
use std::os::unix::ffi::OsStrExt;
use std::{collections::BTreeMap, fs, io::Read, path::Path};

const FILES: &[&str] = &[
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
const REPAIR: &str =
    "The PDF VM runtime is missing or damaged. Update or repair Hexbot with the installer.";

fn checked_file(path: &Path, limit: u64) -> Result<String> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > limit {
        return fail(REPAIR);
    }
    let mut hash = Sha256::new();
    let mut file = fs::File::open(path)?.take(limit + 1);
    let mut bytes = 0u64;
    let mut buffer = [0; 64 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        bytes += count as u64;
        if bytes > limit {
            return fail(REPAIR);
        }
        hash.update(&buffer[..count]);
    }
    if bytes != metadata.len() {
        return fail(REPAIR);
    }
    Ok(format!("{:x}", hash.finalize()))
}

/// Full archives are authenticated as complete app bytes. Their helper is
/// signed after staging; Headless archives refresh that hash before publication.
pub(crate) fn validate(directory: &Path, target: Target, signed_app: bool) -> Result<()> {
    if !target.is_macos() {
        return Ok(());
    }
    let checked = || -> Result<()> {
        checked_file(&directory.join("manifest.json"), 1024 * 1024)?;
        let outer: serde_json::Value =
            serde_json::from_slice(&fs::read(directory.join("manifest.json"))?)?;
        if outer["pdfVm"] != 1 {
            return fail(REPAIR);
        }
        let outer_files = outer["files"].as_object().ok_or(REPAIR)?;
        let pdf = directory.join("pdf");
        if !fs::symlink_metadata(directory)?.is_dir() || !fs::symlink_metadata(&pdf)?.is_dir() {
            return fail(REPAIR);
        }
        let mut entries = fs::read_dir(&pdf)?
            .map(|entry| Ok(entry?.file_name()))
            .collect::<std::io::Result<Vec<_>>>()?;
        entries.sort();
        let mut expected: Vec<_> = FILES.iter().map(std::ffi::OsString::from).collect();
        expected.sort();
        if entries != expected
            || outer_files
                .keys()
                .filter(|name| name.starts_with("pdf/"))
                .count()
                != FILES.len()
        {
            return fail(REPAIR);
        }
        let mut hashes = BTreeMap::new();
        for name in FILES {
            let limit = match *name {
                "kernel" | "hexbot-pdf-vm" => 64 * 1024 * 1024,
                "initramfs" => 32 * 1024 * 1024,
                "rootfs" => 192 * 1024 * 1024,
                "manifest.json" => 128 * 1024,
                "SOURCES.json" | "THIRD_PARTY_NOTICES" => 8 * 1024 * 1024,
                _ => 2 * 1024 * 1024,
            };
            let hash = checked_file(&pdf.join(name), limit)?;
            let key = format!("pdf/{name}");
            let expected = outer_files
                .get(&key)
                .and_then(serde_json::Value::as_str)
                .ok_or(REPAIR)?;
            if expected.len() != 64
                || !expected.bytes().all(|c| c.is_ascii_hexdigit())
                || ((!signed_app || *name != "hexbot-pdf-vm") && hash != expected)
            {
                return fail(REPAIR);
            }
            hashes.insert(*name, hash);
        }
        let manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(pdf.join("manifest.json"))?)?;
        let architecture = if target == Target::MacosAarch64 {
            "aarch64"
        } else {
            "x86_64"
        };
        for name in ["PROVENANCE.json", "SOURCES.json"] {
            let record: serde_json::Value = serde_json::from_slice(&fs::read(pdf.join(name))?)?;
            if record["version"] != 1 || record["architecture"] != architecture {
                return fail(REPAIR);
            }
        }
        let files = manifest["files"].as_object().ok_or(REPAIR)?;
        if manifest["version"] != 1 || manifest["architecture"] != architecture || files.len() != 3
        {
            return fail(REPAIR);
        }
        for name in ["kernel", "initramfs", "rootfs"] {
            if files.get(name).and_then(serde_json::Value::as_str)
                != hashes.get(name).map(String::as_str)
            {
                return fail(REPAIR);
            }
        }
        let helper = pdf.join("hexbot-pdf-vm");
        let mut header = [0; 8];
        fs::File::open(&helper)?.read_exact(&mut header)?;
        let cpu: u32 = if target == Target::MacosAarch64 {
            0x100000c
        } else {
            0x1000007
        };
        #[cfg(unix)]
        let accessible = {
            let executable = std::ffi::CString::new(helper.as_os_str().as_bytes())?;
            unsafe {
                libc::faccessat(
                    libc::AT_FDCWD,
                    executable.as_ptr(),
                    libc::R_OK | libc::X_OK,
                    libc::AT_EACCESS,
                ) == 0
            }
        };
        #[cfg(not(unix))]
        let accessible = false;
        if header[..4] != 0xfeedfacfu32.to_le_bytes()
            || header[4..] != cpu.to_le_bytes()
            || !accessible
        {
            return fail(REPAIR);
        }
        Ok(())
    };
    checked().map_err(|_| REPAIR.into())
}
