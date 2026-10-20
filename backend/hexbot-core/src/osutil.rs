//! Process, lock, and home helpers shared by the daemon and the installer.
//! Unix keeps the libc calls the rest of the crate already depends on. Windows
//! uses the same failure rules so two daemons cannot share one home.
use std::{fs::File, io, path::PathBuf};

/// The account home. Windows services and desktop logons set USERPROFILE;
/// HOME is the Unix variable and is still accepted when a shell sets it.
pub fn user_home() -> Option<PathBuf> {
    let names: &[&str] = if cfg!(windows) {
        &["USERPROFILE", "HOME"]
    } else {
        &["HOME"]
    };
    names.iter().find_map(|name| {
        std::env::var_os(name)
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
    })
}

pub fn try_lock_exclusive(file: &File) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }
    #[cfg(windows)]
    {
        lock_file(file, true)
    }
}

pub fn lock_exclusive(file: &File) -> io::Result<()> {
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
    {
        lock_file(file, false)
    }
}

#[cfg(windows)]
fn lock_file(file: &File, immediate: bool) -> io::Result<()> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::ERROR_LOCK_VIOLATION;
    use windows_sys::Win32::Storage::FileSystem::{
        LockFileEx, LOCKFILE_EXCLUSIVE_LOCK, LOCKFILE_FAIL_IMMEDIATELY,
    };
    use windows_sys::Win32::System::IO::OVERLAPPED;
    let mut overlapped: OVERLAPPED = unsafe { std::mem::zeroed() };
    let flags = LOCKFILE_EXCLUSIVE_LOCK
        | if immediate {
            LOCKFILE_FAIL_IMMEDIATELY
        } else {
            0
        };
    let locked = unsafe {
        LockFileEx(
            file.as_raw_handle(),
            flags,
            0,
            u32::MAX,
            u32::MAX,
            &mut overlapped,
        )
    };
    if locked == 0 {
        let error = io::Error::last_os_error();
        if immediate && error.raw_os_error() == Some(ERROR_LOCK_VIOLATION as i32) {
            return Err(error);
        }
        Err(error)
    } else {
        Ok(())
    }
}

/// True when the process exists. A permission error still counts as alive,
/// matching `kill(pid, 0)` with `EPERM`.
pub fn process_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    #[cfg(unix)]
    {
        let result = unsafe { libc::kill(pid as libc::pid_t, 0) };
        result == 0 || io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::{CloseHandle, ERROR_INVALID_PARAMETER};
        use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if handle.is_null() {
            // ERROR_INVALID_PARAMETER is a dead pid. Access denied still means it exists.
            return io::Error::last_os_error().raw_os_error() != Some(ERROR_INVALID_PARAMETER as i32);
        }
        unsafe { CloseHandle(handle) };
        true
    }
}

pub fn terminate(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    #[cfg(unix)]
    {
        unsafe { libc::kill(pid as libc::pid_t, libc::SIGKILL) == 0 }
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};
        let handle = unsafe { OpenProcess(PROCESS_TERMINATE, 0, pid) };
        if handle.is_null() {
            return false;
        }
        let ok = unsafe { TerminateProcess(handle, 1) };
        unsafe { CloseHandle(handle) };
        ok != 0
    }
}

pub fn hostname() -> Option<String> {
    #[cfg(windows)]
    {
        if let Some(name) = std::env::var("COMPUTERNAME")
            .ok()
            .filter(|name| !name.is_empty())
        {
            return Some(name);
        }
    }
    #[cfg(unix)]
    {
        let mut bytes = [0u8; 256];
        if unsafe { libc::gethostname(bytes.as_mut_ptr().cast(), bytes.len()) } == 0 {
            let length = bytes.iter().position(|byte| *byte == 0).unwrap_or(bytes.len());
            if length > 0 {
                return Some(String::from_utf8_lossy(&bytes[..length]).into_owned());
            }
        }
    }
    std::env::var("HOSTNAME")
        .ok()
        .filter(|name| !name.is_empty())
}

/// Opening a FIFO or a missing parent is absence, not a scan failure.
pub fn absent_path(error: &io::Error) -> bool {
    if error.kind() == io::ErrorKind::NotFound {
        return true;
    }
    #[cfg(unix)]
    {
        matches!(
            error.raw_os_error(),
            Some(libc::ENOTDIR) | Some(libc::ENXIO)
        )
    }
    #[cfg(windows)]
    {
        // ERROR_PATH_NOT_FOUND and ERROR_DIRECTORY.
        matches!(error.raw_os_error(), Some(3) | Some(267))
    }
}

#[cfg(windows)]
pub fn windows_process_count() -> Option<usize> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    let snap = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snap.is_null() || snap == INVALID_HANDLE_VALUE {
        return None;
    }
    let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
    entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
    if unsafe { Process32FirstW(snap, &mut entry) } == 0 {
        unsafe { CloseHandle(snap) };
        return None;
    }
    let mut count = 1usize;
    while unsafe { Process32NextW(snap, &mut entry) } != 0 {
        count += 1;
    }
    unsafe { CloseHandle(snap) };
    Some(count)
}

pub fn name_too_long(error: &io::Error) -> bool {
    #[cfg(unix)]
    {
        error.raw_os_error() == Some(libc::ENAMETOOLONG)
    }
    #[cfg(windows)]
    {
        // ERROR_FILENAME_EXCED_RANGE
        error.raw_os_error() == Some(206)
    }
}
