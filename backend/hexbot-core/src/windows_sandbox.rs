//! The Windows sandbox from the daemon's side. Auto and Manual commands run
//! through `hexbot sandbox exec` (`windows_container`), with a policy that
//! `credentials` builds. This module finds what the policy and the helper
//! need on this computer: the helper itself, Git for Windows and its Bash,
//! and the managed Python. It reads Git metadata only from local disks, and
//! names what Windows still refuses.
use crate::windows_paths::sandbox as rules;
use crate::{Error, Result};
use std::{
    ffi::OsString,
    path::{Path, PathBuf},
    sync::OnceLock,
};

/// Why Auto and Manual refuse local commands: the startup probe could not run
/// a contained command.
pub const UNAVAILABLE: &str = "The Windows sandbox could not start, so Auto and Manual refuse local commands and file tools, and scheduled scripts do not run. Bypass has no sandbox or credential protection. Restart Hexbot to try again.";
/// Code runs on the bot's own computer; the daemon's Python worker is retired
/// and never starts on Windows.
pub const NATIVE_WORKER: &str = "On Windows, code runs on the bot's own computer (Computer use), not on the computer running Hexbot.";
/// Pi's restricted write and edit use a Unix handle bridge.
pub const FILE_BRIDGE: &str = "On Windows, Auto and Manual cannot use the write and edit tools yet. Change files with a command, which runs in the sandbox.";
pub const NO_GIT_BASH: &str = "Shell commands and scripts on Windows run in Git Bash, which is not installed. Install Git for Windows, then try again.";
pub const TOO_LARGE: &str = "This workspace has too many protected files for the Windows sandbox to start a command. Choose a smaller workspace.";

static HELPER: OnceLock<PathBuf> = OnceLock::new();

/// The executable that runs `sandbox exec`: the daemon's own.
pub fn helper() -> Result<PathBuf> {
    match HELPER.get() {
        Some(helper) => Ok(helper.clone()),
        None => Ok(std::env::current_exe()?),
    }
}

/// Integration tests link this library into their own executable, which has
/// no `sandbox exec`, so they name the daemon binary once.
pub fn use_helper(helper: PathBuf) -> bool {
    HELPER.set(helper).is_ok()
}

fn variable(name: &str) -> Option<OsString> {
    std::env::var_os(name).filter(|value| !value.is_empty())
}

/// `path` resolved, in the plain form paths are compared in, when it is a
/// local disk path. Anything else is never opened.
fn real(path: &Path) -> Option<PathBuf> {
    rules::local(path.to_str()?).ok()?;
    let real = std::fs::canonicalize(path).ok()?;
    rules::simplify(real.to_str()?).ok().map(PathBuf::from)
}

#[allow(clashing_extern_declarations)]
#[link(name = "advapi32", kind = "raw-dylib")]
unsafe extern "system" {
    fn RegGetValueW(
        key: isize,
        subkey: *const u16,
        value: *const u16,
        flags: u32,
        kind: *mut u32,
        data: *mut u16,
        size: *mut u32,
    ) -> i32;
}
#[allow(clashing_extern_declarations)]
#[link(name = "kernel32", kind = "raw-dylib")]
unsafe extern "system" {
    fn GetDriveTypeW(root: *const u16) -> u32;
}
const HKEY_CURRENT_USER: isize = 0x8000_0001_u32 as i32 as isize;
const HKEY_LOCAL_MACHINE: isize = 0x8000_0002_u32 as i32 as isize;
const RRF_RT_REG_SZ: u32 = 0x2;

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(Some(0)).collect()
}

/// A string value from the registry.
fn registry_text(key: isize, subkey: &str, value: &str) -> Option<String> {
    let (subkey, value) = (wide(subkey), wide(value));
    let mut size = 0u32;
    // SAFETY: NUL-terminated names and a size query.
    let status = unsafe {
        RegGetValueW(
            key,
            subkey.as_ptr(),
            value.as_ptr(),
            RRF_RT_REG_SZ,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut size,
        )
    };
    if status != 0 || size == 0 {
        return None;
    }
    let mut buffer = vec![0u16; (size as usize).div_ceil(2)];
    // SAFETY: a buffer of the queried size in bytes.
    let status = unsafe {
        RegGetValueW(
            key,
            subkey.as_ptr(),
            value.as_ptr(),
            RRF_RT_REG_SZ,
            std::ptr::null_mut(),
            buffer.as_mut_ptr(),
            &mut size,
        )
    };
    if status != 0 {
        return None;
    }
    let length = buffer.iter().position(|&unit| unit == 0)?;
    String::from_utf16(&buffer[..length]).ok()
}

/// Git for Windows' install folder: where its installer recorded it, for all
/// users or this one, else its default folders. Never the PATH, which a
/// workspace can change.
pub fn git_install() -> Option<PathBuf> {
    let recorded = [HKEY_LOCAL_MACHINE, HKEY_CURRENT_USER]
        .into_iter()
        .filter_map(|key| registry_text(key, r"SOFTWARE\GitForWindows", "InstallPath"))
        .map(PathBuf::from);
    let defaults = [("ProgramFiles", "Git"), ("LOCALAPPDATA", r"Programs\Git")]
        .into_iter()
        .filter_map(|(name, local)| variable(name).map(|root| PathBuf::from(root).join(local)));
    recorded
        .chain(defaults)
        .filter_map(|folder| real(&folder))
        .filter(|folder| {
            folder
                .to_str()
                .map(|plain| fixed_drive(plain).is_ok())
                .unwrap_or(false)
        })
        .find(|folder| folder.join(r"bin\bash.exe").is_file())
}

/// Git Bash, which runs shell scripts as Pi's Bash does on Windows.
pub fn git_bash() -> Option<PathBuf> {
    git_install().map(|git| git.join(r"bin\bash.exe"))
}

/// Program Files and the Windows folder are readable to every AppContainer,
/// so a program there needs no grant, which a standard user could not make.
fn readable_to_containers(path: &Path) -> bool {
    let folded = |path: &Path| path.to_str().map(rules::fold);
    let Some(path) = folded(path) else {
        return false;
    };
    [
        "ProgramFiles",
        "ProgramFiles(x86)",
        "ProgramW6432",
        "SystemRoot",
    ]
    .into_iter()
    .filter_map(variable)
    .filter_map(|root| real(Path::new(&root)))
    .filter_map(|root| folded(&root))
    .any(|root| rules::within(&path, &root))
}

/// Folders every contained command may read and run programs from: the
/// managed Python, its base interpreter, and Git for Windows when it is
/// installed for this user only.
pub fn programs(home: &Path) -> Vec<PathBuf> {
    let mut programs = Vec::new();
    let venv = home.join(r"runtime\tools\code-python");
    if let Some(venv) = real(&venv).filter(|venv| venv.is_dir()) {
        // The venv's python.exe starts the base interpreter its pyvenv.cfg
        // names, which must be one of the managed bases in <home>\python.
        let base = std::fs::read_to_string(venv.join("pyvenv.cfg"))
            .ok()
            .and_then(|text| {
                text.lines().find_map(|line| {
                    let (key, value) = line.split_once('=')?;
                    (key.trim() == "home").then(|| PathBuf::from(value.trim()))
                })
            })
            .and_then(|base| real(&base));
        let managed = real(&home.join("python"));
        programs.push(venv);
        if let (Some(base), Some(managed)) = (base, managed)
            && base != managed
            && base.starts_with(&managed)
        {
            programs.push(base);
        }
    }
    if let Some(git) = git_install().filter(|git| !readable_to_containers(git)) {
        programs.push(git);
    }
    programs
}

/// A path on a fixed local drive. Removable, network, optical and RAM
/// drives, and drives that do not exist, are refused before any file system
/// call reaches the path.
pub fn fixed_drive(plain: &str) -> Result<()> {
    const DRIVE_FIXED: u32 = 3;
    let root = wide(&plain[..3]);
    // SAFETY: a NUL-terminated drive root such as `C:\`.
    if unsafe { GetDriveTypeW(root.as_ptr()) } != DRIVE_FIXED {
        return Err(Error::new(
            4202,
            format!(
                "{} is not a local fixed drive, so Hexbot does not use folders or scripts on it.",
                &plain[..2]
            ),
        ));
    }
    Ok(())
}

/// Read a small regular file on a local disk. The path is checked by its text
/// first, so a network, device or stream path is never opened; a final link
/// is opened as itself and refused, never followed (`common::open_disk_entry`,
/// which `common::read_regular` shares). Ok(None) means nothing is there or
/// it is a folder.
pub fn regular_file(path: &Path, limit: u64) -> Result<Option<Vec<u8>>> {
    use crate::common::DiskEntry;
    use std::io::Read;
    let (file, length) = match crate::common::open_disk_entry(path) {
        Ok(DiskEntry::File(file, length)) => (file, length),
        // Folders read as "not a file" rather than failing.
        Ok(DiskEntry::Directory) => return Ok(None),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
        Ok(DiskEntry::Refused(reason)) => {
            // The Git reader keeps its own wording for the one refusal its
            // callers have always seen.
            let what = if reason == crate::common::NOT_UNICODE {
                "Git metadata paths must be Unicode"
            } else {
                reason
            };
            return Err(Error::new(5240, format!("{what}: {}", path.display())));
        }
        Ok(DiskEntry::Device) => {
            return Err(Error::new(
                5240,
                format!("Git metadata is not a disk file: {}", path.display()),
            ));
        }
        Ok(DiskEntry::Link) => {
            return Err(Error::new(
                5240,
                format!(
                    "Git metadata is reached through a link, which the Windows scan does not follow: {}",
                    path.display()
                ),
            ));
        }
    };
    if length > limit {
        return Err(Error::new(5240, "Git metadata is too large to scan."));
    }
    let mut bytes = vec![];
    file.take(length + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > length {
        return Err(Error::new(
            5240,
            "Git metadata changed while it was scanned.",
        ));
    }
    Ok(Some(bytes))
}
