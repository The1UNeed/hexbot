//! Operating-system boundaries shared by the daemon, setup and services.
use crate::{Error, Result};
use std::{
    ffi::OsString,
    fs, io,
    path::{Path, PathBuf},
};

pub fn user_home() -> Option<OsString> {
    #[cfg(windows)]
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"));
    #[cfg(not(windows))]
    let home = std::env::var_os("HOME");
    home.filter(|home| !home.is_empty())
}

pub fn executable_name(name: &str) -> String {
    format!("{name}{}", std::env::consts::EXE_SUFFIX)
}

/// Some native tools (including Git) reject Rust's canonical verbatim prefix.
/// Keep native path encoding while passing the equivalent Win32 disk/UNC path.
pub fn external_path(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::{OsStrExt, OsStringExt};
        let units = path.as_os_str().encode_wide().collect::<Vec<_>>();
        if units.starts_with(&[92, 92, 63, 92]) {
            if units.len() >= 7 && units[5] == 58 && units[6] == 92 {
                return PathBuf::from(OsString::from_wide(&units[4..]));
            }
            if units.len() >= 8
                && units[4..8]
                    .iter()
                    .zip([85u16, 78, 67, 92])
                    .all(|(&a, b)| a == b || a == b + 32 && b != 92)
            {
                let mut unc = vec![92, 92];
                unc.extend_from_slice(&units[8..]);
                return PathBuf::from(OsString::from_wide(&unc));
            }
        }
    }
    path.to_owned()
}

pub fn is_link(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    metadata.file_type().is_symlink()
}

/// Keep the native dispatcher's child tree tied to the dispatcher lifetime.
#[cfg(windows)]
pub async fn supervised_status(
    command: &mut tokio::process::Command,
) -> io::Result<(std::process::ExitStatus, u32)> {
    let (mut child, mut tree) = crate::pi::spawn_child(command)?;
    let pid = child
        .id()
        .ok_or_else(|| io::Error::other("Native child PID is unavailable"))?;
    let status = child.wait().await?;
    tree.finish()?;
    Ok((status, pid))
}

#[cfg(windows)]
pub fn restart_arguments(home: &Path, pid: u32) -> Result<Vec<OsString>> {
    let path = home.join("runtime/native-restart.json");
    let record: serde_json::Value = serde_json::from_slice(&fs::read(&path)?)
        .map_err(|error| Error::new(5243, format!("Invalid native restart handoff: {error}")))?;
    let host = crate::common::required(&record, "host")?
        .parse::<std::net::IpAddr>()
        .map_err(|_| Error::new(5243, "Invalid native restart address"))?;
    let port = record["port"]
        .as_u64()
        .and_then(|port| u16::try_from(port).ok())
        .filter(|port| *port > 0)
        .ok_or_else(|| Error::new(5243, "Invalid native restart port"))?;
    if record["pid"].as_u64() != Some(u64::from(pid)) {
        return Err(Error::new(
            5243,
            "Native restart handoff belongs to another process",
        ));
    }
    fs::remove_file(path)?;
    Ok([
        "serve".into(),
        "--host".into(),
        host.to_string().into(),
        "--port".into(),
        port.to_string().into(),
    ]
    .into())
}

/// Guarded Windows file operations must not trigger SMB authentication while
/// resolving an untrusted path. Bypass callers may use the general path guard.
pub fn validate_local_path(path: &Path) -> Result<()> {
    #[cfg(windows)]
    {
        let path = if path.is_absolute() {
            path.to_owned()
        } else {
            std::env::current_dir()?.join(path)
        };
        resolve_local_path(&path, 0)?;
    }
    #[cfg(not(windows))]
    validate_path(path)?;
    Ok(())
}

pub fn validate_local_path_in(cwd: &Path, path: &Path) -> Result<()> {
    #[cfg(windows)]
    {
        let cwd = resolve_local_path(cwd, 0)?;
        let path = if path.is_absolute() {
            path.to_owned()
        } else {
            cwd.join(path)
        };
        resolve_local_path(&path, 0)?;
    }
    #[cfg(not(windows))]
    {
        let _ = cwd;
        validate_path(path)?;
    }
    Ok(())
}

#[cfg(windows)]
fn resolve_local_path(path: &Path, depth: usize) -> Result<PathBuf> {
    use std::{
        os::windows::fs::OpenOptionsExt,
        path::{Component, Prefix},
    };
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES,
        GetDriveTypeW,
    };
    validate_path(path)?;
    if depth > 40 {
        return Err(Error::new(4202, "Too many links in a Windows file path"));
    }
    let mut components = path.components();
    let Some(Component::Prefix(prefix)) = components.next() else {
        return Err(Error::new(4202, "A guarded Windows path must be absolute"));
    };
    let drive = match prefix.kind() {
        Prefix::Disk(drive) | Prefix::VerbatimDisk(drive) => drive,
        Prefix::UNC(_, _) | Prefix::VerbatimUNC(_, _) => {
            return Err(Error::new(4202, "Network file paths require Bypass"));
        }
        _ => return Err(Error::new(4202, "Windows device paths are not allowed")),
    };
    let root = format!("{}:\\\0", drive as char)
        .encode_utf16()
        .collect::<Vec<_>>();
    // DRIVE_REMOTE. The drive mapping is checked before opening any path on it.
    match unsafe { GetDriveTypeW(root.as_ptr()) } {
        2 | 3 | 5 | 6 => {}
        4 => return Err(Error::new(4202, "Network drives require Bypass")),
        _ => {
            return Err(Error::new(
                4202,
                "This Windows drive cannot be checked before access",
            ));
        }
    }
    let mut current = PathBuf::from(prefix.as_os_str());
    current.push("\\");
    for component in components {
        match component {
            Component::RootDir | Component::CurDir => continue,
            Component::ParentDir => {
                current.pop();
                continue;
            }
            Component::Normal(name) => current.push(name),
            Component::Prefix(_) => return Err(Error::new(4202, "Invalid Windows path prefix")),
        }
        let opened = fs::OpenOptions::new()
            .access_mode(FILE_READ_ATTRIBUTES)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS)
            .open(&current);
        let file = match opened {
            Ok(file) => file,
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::NotFound | io::ErrorKind::NotADirectory
                ) =>
            {
                continue;
            }
            Err(error) => return Err(error.into()),
        };
        if is_link(&file.metadata()?) {
            // Rust read_link uses OPEN_REPARSE_POINT too; it never opens the target.
            let target = fs::read_link(&current).map_err(|_| {
                Error::new(
                    4202,
                    "This Windows reparse point cannot be checked before access",
                )
            })?;
            let target = if target.is_absolute() {
                target
            } else {
                current.parent().unwrap().join(target)
            };
            current = resolve_local_path(&target, depth + 1)?;
        }
    }
    Ok(current)
}

#[cfg(windows)]
pub fn validate_local_paths_cli() -> Result<()> {
    use std::io::Read;
    #[derive(serde::Deserialize)]
    struct Request {
        cwd: PathBuf,
        paths: Vec<PathBuf>,
    }
    let mut bytes = Vec::new();
    std::io::stdin()
        .take(256 * 1024 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > 256 * 1024 {
        return Err(Error::new(4200, "Path validation request exceeds 256 KiB"));
    }
    let request: Request = serde_json::from_slice(&bytes)
        .map_err(|_| Error::new(4200, "Invalid path validation request"))?;
    if request.paths.len() > 1024 {
        return Err(Error::new(
            4200,
            "Path validation accepts at most 1024 paths",
        ));
    }
    let allowed: Vec<bool> = request
        .paths
        .iter()
        .map(|path| validate_local_path_in(&request.cwd, path).is_ok())
        .collect();
    println!("{}", serde_json::json!({"allowed":allowed}));
    Ok(())
}

/// Refuse Windows aliases that do not identify an ordinary file path.
pub fn validate_path(path: &Path) -> Result<()> {
    #[cfg(windows)]
    {
        use std::path::{Component, Prefix};
        if path.has_root() != path.is_absolute() {
            return Err(Error::new(
                4202,
                "A Windows path must include its drive or share",
            ));
        }
        for component in path.components() {
            match component {
                Component::Prefix(prefix) => match prefix.kind() {
                    Prefix::Disk(_)
                    | Prefix::UNC(_, _)
                    | Prefix::VerbatimDisk(_)
                    | Prefix::VerbatimUNC(_, _)
                        if path.is_absolute() => {}
                    _ => {
                        return Err(Error::new(
                            4202,
                            "Windows device and drive-relative paths are not allowed",
                        ));
                    }
                },
                Component::Normal(name) => {
                    let name = name.to_string_lossy();
                    let base = name
                        .split('.')
                        .next()
                        .unwrap_or("")
                        .trim_end_matches(' ')
                        .to_ascii_uppercase();
                    let reserved = matches!(
                        base.as_str(),
                        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
                    ) || ["COM", "LPT"].iter().any(|prefix| {
                        base.strip_prefix(prefix).is_some_and(|tail| {
                            matches!(
                                tail,
                                "1" | "2"
                                    | "3"
                                    | "4"
                                    | "5"
                                    | "6"
                                    | "7"
                                    | "8"
                                    | "9"
                                    | "¹"
                                    | "²"
                                    | "³"
                            )
                        })
                    });
                    if reserved
                        || name.ends_with(['.', ' '])
                        || name
                            .chars()
                            .any(|ch| ch.is_control() || "<>:\"|?*".contains(ch))
                    {
                        return Err(Error::new(
                            4202,
                            "Windows device names, file streams and ambiguous names are not allowed",
                        ));
                    }
                }
                _ => {}
            }
        }
    }
    #[cfg(not(windows))]
    let _ = path;
    Ok(())
}

/// A daemon home must be a directory within a drive or share, never its root.
pub fn validate_home(path: &Path) -> Result<()> {
    validate_path(path)?;
    #[cfg(windows)]
    {
        let canonical = path.canonicalize().unwrap_or_else(|_| path.to_owned());
        if !path.is_absolute()
            || path
                .components()
                .any(|part| matches!(part, std::path::Component::ParentDir))
            || !canonical
                .components()
                .any(|part| matches!(part, std::path::Component::Normal(_)))
        {
            return Err(Error::new(
                4202,
                "The Hexbot home must be a directory inside a Windows drive or share",
            ));
        }
    }
    Ok(())
}

pub fn stable_executable(home: &Path) -> PathBuf {
    home.join("runtime")
        .join(executable_name("native-executable"))
}

#[cfg(windows)]
pub fn cli_home(executable: &Path) -> Result<PathBuf> {
    crate::install_ownership::windows_cli_home(executable).map_err(Into::into)
}

pub fn selected_native(home: &Path) -> Result<PathBuf> {
    #[cfg(not(windows))]
    let executable = stable_executable(home).canonicalize()?;
    #[cfg(windows)]
    let executable = {
        let selected: serde_json::Value = serde_json::from_slice(&fs::read(
            home.join("runtime/native-current.json"),
        )?)
        .map_err(|error| Error::new(5243, format!("Invalid native runtime selection: {error}")))?;
        PathBuf::from(crate::common::required(&selected, "executable")?).canonicalize()?
    };
    let native = home.join("runtime/native").canonicalize()?;
    if !executable.starts_with(&native) || !executable.is_file() {
        return Err(Error::new(
            5243,
            "Native runtime selection escaped its installation",
        ));
    }
    Ok(executable)
}

pub fn try_lock(file: &fs::File) -> io::Result<bool> {
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
            return Ok(true);
        }
        let error = io::Error::last_os_error();
        if error.kind() == io::ErrorKind::WouldBlock {
            Ok(false)
        } else {
            Err(error)
        }
    }
    #[cfg(windows)]
    match file.try_lock() {
        Ok(()) => Ok(true),
        Err(fs::TryLockError::WouldBlock) => Ok(false),
        Err(fs::TryLockError::Error(error)) => Err(error),
    }
}

pub fn lock(file: &fs::File) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        loop {
            if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) } == 0 {
                return Ok(());
            }
            let error = io::Error::last_os_error();
            if error.kind() != io::ErrorKind::Interrupted {
                return Err(error);
            }
        }
    }
    #[cfg(windows)]
    file.lock()
}

pub fn process_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        (unsafe { libc::kill(pid as i32, 0) == 0 })
            || io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::{
            Foundation::{CloseHandle, WAIT_TIMEOUT},
            System::Threading::{OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject},
        };
        let process = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
        if process.is_null() {
            return io::Error::last_os_error().raw_os_error() != Some(87);
        }
        let alive = unsafe { WaitForSingleObject(process, 0) == WAIT_TIMEOUT };
        unsafe { CloseHandle(process) };
        alive
    }
}

#[cfg(windows)]
pub struct ShutdownEvent(windows_sys::Win32::Foundation::HANDLE);
#[cfg(windows)]
unsafe impl Send for ShutdownEvent {}
#[cfg(windows)]
unsafe impl Sync for ShutdownEvent {}
#[cfg(windows)]
impl ShutdownEvent {
    pub fn create(home: &Path) -> io::Result<Self> {
        use windows_sys::Win32::System::Threading::CreateEventW;
        let name = shutdown_event_name(std::process::id(), home)?;
        let handle = unsafe { CreateEventW(std::ptr::null(), 1, 0, name.as_ptr()) };
        if handle.is_null() {
            Err(io::Error::last_os_error())
        } else {
            Ok(Self(handle))
        }
    }
    pub fn signalled(&self) -> bool {
        unsafe { windows_sys::Win32::System::Threading::WaitForSingleObject(self.0, 0) == 0 }
    }
}
#[cfg(windows)]
impl Drop for ShutdownEvent {
    fn drop(&mut self) {
        unsafe { windows_sys::Win32::Foundation::CloseHandle(self.0) };
    }
}
#[cfg(windows)]
fn shutdown_event_name(pid: u32, home: &Path) -> io::Result<Vec<u16>> {
    use sha2::{Digest, Sha256};
    let home = home
        .canonicalize()?
        .to_string_lossy()
        .replace('\\', "/")
        .to_lowercase();
    let home = home.strip_prefix("//?/").unwrap_or(&home);
    let digest = format!("{:x}", Sha256::digest(home.as_bytes()));
    Ok(format!("Local\\HexbotShutdown-{pid}-{digest}\0")
        .encode_utf16()
        .collect())
}
#[cfg(windows)]
pub fn request_shutdown(pid: u32, home: &Path) -> io::Result<()> {
    use windows_sys::Win32::{
        Foundation::CloseHandle,
        System::Threading::{EVENT_MODIFY_STATE, OpenEventW, SetEvent},
    };
    let event = unsafe {
        OpenEventW(
            EVENT_MODIFY_STATE,
            0,
            shutdown_event_name(pid, home)?.as_ptr(),
        )
    };
    if event.is_null() {
        return Err(io::Error::last_os_error());
    }
    let ok = unsafe { SetEvent(event) };
    let error = io::Error::last_os_error();
    unsafe { CloseHandle(event) };
    if ok == 0 { Err(error) } else { Ok(()) }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(windows)]
    #[test]
    fn external_paths_preserve_native_unicode_and_unc_names() {
        for (canonical, native) in [
            (
                r"\\?\C:\用户\space & percent%\file",
                r"C:\用户\space & percent%\file",
            ),
            (r"\\?\UNC\server\共享\file", r"\\server\共享\file"),
            (r"C:\normal\file", r"C:\normal\file"),
        ] {
            assert_eq!(external_path(Path::new(canonical)), Path::new(native));
        }
    }
    #[test]
    fn exclusive_locks_cover_independent_handles() {
        let temporary = tempfile::NamedTempFile::new().unwrap();
        let first = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(temporary.path())
            .unwrap();
        let second = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(temporary.path())
            .unwrap();
        assert!(try_lock(&first).unwrap());
        assert!(!try_lock(&second).unwrap());
        drop(first);
        assert!(try_lock(&second).unwrap());
    }

    #[cfg(windows)]
    #[test]
    fn windows_paths_require_unambiguous_file_names() {
        for path in [r"C:\", r"\\server\share\"] {
            validate_path(Path::new(path)).unwrap();
            assert!(validate_home(Path::new(path)).is_err());
        }
        assert!(validate_home(Path::new(r"C:\folder\..")).is_err());
        for path in [
            r"C:\workspace\file.txt",
            r"\\server\share\file.txt",
            r"\\?\C:\workspace\file.txt",
            "file.txt",
            "folder/file.txt",
        ] {
            validate_path(Path::new(path)).unwrap();
        }
        for path in [
            r"C:relative",
            r"\root-relative",
            r"\\.\PhysicalDrive0",
            r"\\?\GLOBALROOT\Device\HarddiskVolume1",
            r"C:\file:stream",
            r"C:\AUX.txt",
            r"C:\COM¹",
            r"C:\name.",
            r"C:\name ",
        ] {
            assert!(validate_path(Path::new(path)).is_err(), "{path}");
        }
    }

    #[cfg(windows)]
    #[test]
    fn shutdown_events_only_apply_to_the_selected_home() {
        let home = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let event = ShutdownEvent::create(home.path()).unwrap();
        assert!(request_shutdown(std::process::id(), other.path()).is_err());
        assert!(!event.signalled());
        request_shutdown(std::process::id(), home.path()).unwrap();
        assert!(event.signalled());
    }
    #[cfg(windows)]
    #[test]
    fn guarded_paths_reject_network_locations_before_following_links() {
        for path in [
            r"\\127.0.0.1\blocked\file.txt",
            r"\\?\UNC\127.0.0.1\blocked\file.txt",
        ] {
            assert!(validate_local_path(Path::new(path)).is_err());
        }
        let home = tempfile::tempdir().unwrap();
        validate_local_path(home.path()).unwrap();
        validate_local_path_in(home.path(), Path::new("new/file.txt")).unwrap();
        let link = home.path().join("network-link");
        match std::os::windows::fs::symlink_dir(r"\\127.0.0.1\blocked", &link) {
            Ok(()) => assert!(validate_local_path(&link.join("file.txt")).is_err()),
            Err(error) if error.raw_os_error() == Some(1314) => {
                eprintln!("Network-link probe requires Windows symbolic-link permission")
            }
            Err(error) => panic!("Could not create the network-link fixture: {error}"),
        }
    }
    #[cfg(windows)]
    #[test]
    fn native_restart_handoff_uses_effective_listener_without_launch_only_flags() {
        let home = tempfile::tempdir().unwrap();
        fs::create_dir(home.path().join("runtime")).unwrap();
        let record = home.path().join("runtime/native-restart.json");
        fs::write(
            &record,
            serde_json::json!({"pid":42,"host":"127.0.0.1","port":38127}).to_string(),
        )
        .unwrap();
        assert!(restart_arguments(home.path(), 43).is_err());
        assert_eq!(
            restart_arguments(home.path(), 42).unwrap(),
            ["serve", "--host", "127.0.0.1", "--port", "38127"].map(OsString::from)
        );
        assert!(!record.exists());
    }
}
