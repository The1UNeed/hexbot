//! OS utilities for the daemon's supported platforms, macOS and Linux.
//! Keep platform details here; this module does not add support for other OSes.
use std::{fs::File, io, path::PathBuf};

/// Preserve the daemon's HOME lookup, including an explicitly empty value.
pub fn user_home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

/// Blocking exclusive lock, retrying interrupted waits like the activation lock.
/// Nonblocking callers can use `File::try_lock` directly.
pub fn lock_exclusive(file: &File) -> io::Result<()> {
    loop {
        match file.lock() {
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            result => return result,
        }
    }
}

/// A liveness hint only, never authority to signal a recorded PID. Unknown or
/// permission-denied probes count as alive so runtime cleanup stays conservative.
pub fn process_alive(pid: u32) -> bool {
    let Ok(pid) = libc::pid_t::try_from(pid) else {
        return false;
    };
    pid > 0
        && (unsafe { libc::kill(pid, 0) } == 0
            || io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH))
}

/// Signal only a child we still own. Tokio clears its ID after reaping, so the
/// PID cannot have been reused while this mutable child reference is held.
pub(crate) fn signal_termination(child: &mut tokio::process::Child) -> bool {
    child
        .id()
        .is_some_and(|pid| unsafe { libc::kill(pid as libc::pid_t, libc::SIGTERM) } == 0)
}

fn hostname_from_bytes(bytes: &[u8]) -> Option<String> {
    let length = bytes
        .iter()
        .position(|byte| *byte == 0)
        .unwrap_or(bytes.len());
    (length > 0).then(|| String::from_utf8_lossy(&bytes[..length]).into_owned())
}

pub fn hostname() -> Option<String> {
    let mut bytes = [0u8; 256];
    // The buffer is valid for its entire length and read only after the call.
    if unsafe { libc::gethostname(bytes.as_mut_ptr().cast(), bytes.len()) } == 0
        && let Some(name) = hostname_from_bytes(&bytes)
    {
        return Some(name);
    }
    std::env::var("HOSTNAME")
        .ok()
        .filter(|name| !name.is_empty())
}

pub fn name_too_long(error: &io::Error) -> bool {
    error.raw_os_error() == Some(libc::ENAMETOOLONG)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::fd::AsRawFd;

    #[test]
    fn hostname_ignores_empty_results_and_stops_at_nul() {
        assert_eq!(hostname_from_bytes(&[0; 256]), None);
        assert_eq!(hostname_from_bytes(b"owl\0ignored"), Some("owl".into()));
        assert_eq!(hostname_from_bytes(b"fox"), Some("fox".into()));
        assert_eq!(hostname_from_bytes(b"f\xff\0"), Some("f\u{fffd}".into()));
    }

    #[test]
    fn only_name_too_long_is_classified_as_such() {
        assert!(name_too_long(&io::Error::from_raw_os_error(
            libc::ENAMETOOLONG
        )));
        for code in [libc::ENOENT, libc::EACCES, libc::ELOOP] {
            assert!(!name_too_long(&io::Error::from_raw_os_error(code)));
        }
    }

    #[test]
    fn std_locks_interoperate_with_flock_and_last_duplicate_holds_the_lock() {
        let owner = tempfile::NamedTempFile::new().unwrap();
        let duplicate = owner.as_file().try_clone().unwrap();
        let contender = File::open(owner.path()).unwrap();
        lock_exclusive(owner.as_file()).unwrap();
        assert!(matches!(
            contender.try_lock(),
            Err(std::fs::TryLockError::WouldBlock)
        ));
        let raw_lock =
            || unsafe { libc::flock(contender.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
        assert_ne!(raw_lock(), 0);
        drop(owner);
        assert_ne!(raw_lock(), 0);
        drop(duplicate);
        assert_eq!(raw_lock(), 0);
        contender.try_lock().unwrap();
    }

    #[test]
    fn blocking_lock_acquires_after_the_owner_closes() {
        let owner = tempfile::NamedTempFile::new().unwrap();
        lock_exclusive(owner.as_file()).unwrap();
        let contender = File::open(owner.path()).unwrap();
        assert!(matches!(
            contender.try_lock(),
            Err(std::fs::TryLockError::WouldBlock)
        ));
        let (send, receive) = std::sync::mpsc::channel();
        let waiter = std::thread::spawn(move || {
            lock_exclusive(&contender).unwrap();
            send.send(contender).unwrap();
        });
        assert!(matches!(
            receive.try_recv(),
            Err(std::sync::mpsc::TryRecvError::Empty)
        ));
        drop(owner);
        let held = receive
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        waiter.join().unwrap();
        drop(held);
    }

    #[tokio::test]
    async fn termination_signals_only_an_unreaped_owned_child() {
        use std::{process::Stdio, time::Duration};
        use tokio::io::{AsyncBufReadExt, BufReader};

        let mut child = tokio::process::Command::new("/bin/sh")
            .args(["-c", "trap 'exit 23' TERM; echo ready; read answer"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let pid = child.id().unwrap();
        let mut output = BufReader::new(child.stdout.take().unwrap());
        let mut ready = String::new();
        tokio::time::timeout(Duration::from_secs(5), output.read_line(&mut ready))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(ready, "ready\n");
        assert!(process_alive(pid));
        assert!(signal_termination(&mut child));
        let status = tokio::time::timeout(Duration::from_secs(5), child.wait())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(status.code(), Some(23));
        assert!(!signal_termination(&mut child));
        assert!(!process_alive(pid));
        assert!(!process_alive(0));
        assert!(!process_alive(u32::MAX));
    }
}
