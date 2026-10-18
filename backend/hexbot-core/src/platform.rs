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
) -> io::Result<std::process::ExitStatus> {
    let (mut child, mut tree) = crate::pi::spawn_child(command)?;
    let status = child.wait().await?;
    tree.finish()?;
    Ok(status)
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
}
