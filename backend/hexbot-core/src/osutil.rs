//! Process, home and filesystem boundary utilities. Windows helpers prepare
//! build/install boundaries; they do not provide confinement or enable a
//! supported Windows product.
//!
//! The filesystem boundaries every caller shares: removing an entry and
//! judging a root never follow a link (a symbolic link, or a junction on
//! Windows), and private files and folders are their owner's alone. They
//! build on std's no-follow primitives, whose `remove_dir_all` works through
//! directory descriptors on Unix and handles on Windows.
use std::{
    fs::{self, File},
    io,
    path::{Component, Path, PathBuf},
};

/// Windows follows the OS profile, even when Git Bash sets a different HOME.
/// Unix keeps the existing HOME lookup, including an explicitly empty value.
pub fn user_home() -> Option<PathBuf> {
    #[cfg(windows)]
    let value = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"));
    #[cfg(not(windows))]
    let value = std::env::var_os("HOME");
    value.map(PathBuf::from)
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

/// Remove one entry without following it: a directory with everything in it,
/// anything else by itself. A link goes as a link and its target stays. On
/// Windows that includes directory links and junctions, which Rust reports as
/// links but only `remove_dir` deletes. Nothing there is fine.
pub fn remove_entry(path: &Path) -> io::Result<()> {
    let kind = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata.file_type(),
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    if kind.is_dir() {
        fs::remove_dir_all(path)
    } else if directory_link(&kind) {
        fs::remove_dir(path)
    } else {
        fs::remove_file(path)
    }
}
#[cfg(windows)]
fn directory_link(kind: &fs::FileType) -> bool {
    std::os::windows::fs::FileTypeExt::is_symlink_dir(kind)
}
#[cfg(not(windows))]
fn directory_link(_: &fs::FileType) -> bool {
    false
}

/// Whether `path`, below `base`, is a directory a walk or removal may enter,
/// judged name by name without following any: `Ok(true)` for a directory,
/// `Ok(false)` when a name is missing. A link on the way (a symbolic link, or
/// a junction on Windows) fails with `InvalidInput`, a file with
/// `NotADirectory`, so nothing rooted there leaves `base`. `base` is trusted.
pub fn directory_below(base: &Path, path: &Path) -> io::Result<bool> {
    let relative = path.strip_prefix(base).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("{} is not inside {}", path.display(), base.display()),
        )
    })?;
    let mut current = base.to_path_buf();
    for component in relative.components() {
        let Component::Normal(name) = component else {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("{} must name plain folders", path.display()),
            ));
        };
        current.push(name);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    format!(
                        "{} is a link, which Hexbot does not follow",
                        current.display()
                    ),
                ));
            }
            Ok(metadata) if metadata.is_dir() => {}
            Ok(_) => {
                return Err(io::Error::new(
                    io::ErrorKind::NotADirectory,
                    format!("{} is not a folder", current.display()),
                ));
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(error),
        }
    }
    Ok(true)
}

/// Make a directory its owner's alone. Unix: mode 0700. Windows: a protected
/// DACL with two entries, full control for SYSTEM and for the user the daemon
/// runs as, which what is created inside later inherits; nothing comes from
/// the parent and no entry names Everyone, Users or Administrators. Windows
/// does not check the folders on the way to a file, and this changes the
/// directory alone, so what it already holds keeps its own DACL: make a
/// directory private before writing into it.
pub fn private_dir(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
    }
    #[cfg(windows)]
    private_acl::restrict(path, true)
}

/// Make a file its owner's alone: mode 0600 on Unix, and on Windows the
/// protected DACL of [`private_dir`] for this file.
pub fn private_file(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
    }
    #[cfg(windows)]
    private_acl::restrict(path, false)
}

/// Create `path` and its missing parents, each new one owner-only on Unix
/// (mode 0700), then make `path` private.
pub fn create_private_dir_all(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(path)?;
    }
    #[cfg(windows)]
    fs::create_dir_all(path)?;
    private_dir(path)
}

/// The private DACL in SDDL: protected (`P`), so the parent passes nothing
/// down, with full control (`FA`) for SYSTEM (`SY`) and `user` alone. A
/// directory passes both entries on to new files and folders (`OICI`).
#[cfg(any(windows, test))]
fn private_sddl(user: &str, directory: bool) -> String {
    let inherit = if directory { "OICI" } else { "" };
    format!("D:P(A;{inherit};FA;;;SY)(A;{inherit};FA;;;{user})")
}

/// Private DACLs, set through a handle like the sandbox's grants
/// (`windows_container`), with the descriptor built from SDDL like the Python
/// worker's pipe.
#[cfg(windows)]
mod private_acl {
    use std::{
        ffi::c_void,
        io,
        os::windows::{
            fs::OpenOptionsExt,
            io::{AsRawHandle, FromRawHandle, OwnedHandle},
        },
        path::Path,
        ptr,
        sync::OnceLock,
    };

    #[link(name = "advapi32", kind = "raw-dylib")]
    unsafe extern "system" {
        fn OpenProcessToken(process: *mut c_void, access: u32, token: *mut *mut c_void) -> i32;
        fn GetTokenInformation(
            token: *mut c_void,
            class: u32,
            information: *mut c_void,
            size: u32,
            needed: *mut u32,
        ) -> i32;
        fn ConvertSidToStringSidW(sid: *mut c_void, text: *mut *mut u16) -> i32;
        fn ConvertStringSecurityDescriptorToSecurityDescriptorW(
            text: *const u16,
            revision: u32,
            descriptor: *mut *mut c_void,
            size: *mut u32,
        ) -> i32;
        fn SetKernelObjectSecurity(
            handle: *mut c_void,
            information: u32,
            descriptor: *const c_void,
        ) -> i32;
    }
    #[link(name = "kernel32", kind = "raw-dylib")]
    unsafe extern "system" {
        fn GetCurrentProcess() -> *mut c_void;
        fn LocalFree(memory: *mut c_void) -> *mut c_void;
    }
    const TOKEN_QUERY: u32 = 0x8;
    const TOKEN_USER: u32 = 1;
    const SDDL_REVISION: u32 = 1;
    const DACL_SECURITY_INFORMATION: u32 = 0x4;
    const READ_CONTROL: u32 = 0x0002_0000;
    const WRITE_DAC: u32 = 0x0004_0000;
    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;

    /// Memory the security functions allocated.
    struct Local(*mut c_void);
    impl Drop for Local {
        fn drop(&mut self) {
            // SAFETY: allocated by the function that filled it, freed once.
            unsafe { LocalFree(self.0) };
        }
    }

    fn check(ok: i32) -> io::Result<()> {
        if ok == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }

    /// The SID of the user this process runs as, in text form.
    fn user() -> io::Result<&'static str> {
        static USER: OnceLock<String> = OnceLock::new();
        if let Some(user) = USER.get() {
            return Ok(user);
        }
        let mut token = ptr::null_mut();
        // SAFETY: this process's pseudo handle and an out pointer.
        check(unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) })?;
        // SAFETY: a token handle this process owns from here on.
        let token = unsafe { OwnedHandle::from_raw_handle(token) };
        let mut needed = 0;
        // SAFETY: a size query, which fails with ERROR_INSUFFICIENT_BUFFER.
        unsafe {
            GetTokenInformation(
                token.as_raw_handle(),
                TOKEN_USER,
                ptr::null_mut(),
                0,
                &mut needed,
            )
        };
        if needed < std::mem::size_of::<usize>() as u32 || needed > 64 * 1024 {
            return Err(io::Error::other("the process token has no user"));
        }
        // usize storage keeps TOKEN_USER and the SID pointer it starts with aligned.
        let mut buffer = vec![0usize; (needed as usize).div_ceil(std::mem::size_of::<usize>())];
        // SAFETY: a buffer of at least `needed` bytes.
        check(unsafe {
            GetTokenInformation(
                token.as_raw_handle(),
                TOKEN_USER,
                buffer.as_mut_ptr().cast(),
                needed,
                &mut needed,
            )
        })?;
        let mut text = ptr::null_mut();
        // SAFETY: TOKEN_USER's SID points into `buffer`, alive until the copy below.
        check(unsafe { ConvertSidToStringSidW(buffer[0] as *mut c_void, &mut text) })?;
        let text = Local(text.cast());
        let units = text.0 as *const u16;
        // SAFETY: a NUL-terminated string from ConvertSidToStringSidW.
        let length = (0..).take_while(|&i| unsafe { *units.add(i) } != 0).count();
        // SAFETY: `length` units before the terminator.
        let sid = String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(units, length) });
        Ok(USER.get_or_init(|| sid))
    }

    /// Give `path`, followed as chmod follows it, the private DACL.
    /// SetKernelObjectSecurity changes this object only: unlike
    /// SetNamedSecurityInfoW it passes nothing down to what a directory
    /// already holds, so it never walks the sandbox's folders in the home or
    /// through a link inside.
    pub(super) fn restrict(path: &Path, directory: bool) -> io::Result<()> {
        // Hot paths such as db::open call this on every use; the descriptor
        // is built and set once per file per process, not each time.
        static DONE: std::sync::OnceLock<
            std::sync::Mutex<std::collections::HashSet<(std::path::PathBuf, bool)>>,
        > = std::sync::OnceLock::new();
        let done = DONE.get_or_init(Default::default);
        let key = (path.to_path_buf(), directory);
        if done
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .contains(&key)
        {
            return Ok(());
        }
        let sddl: Vec<u16> = super::private_sddl(user()?, directory)
            .encode_utf16()
            .chain(Some(0))
            .collect();
        let mut descriptor = ptr::null_mut();
        // SAFETY: a NUL-terminated SDDL string and an out pointer.
        check(unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                SDDL_REVISION,
                &mut descriptor,
                ptr::null_mut(),
            )
        })?;
        let descriptor = Local(descriptor);
        // Backup semantics open folders too.
        let object = std::fs::OpenOptions::new()
            .access_mode(READ_CONTROL | WRITE_DAC)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
            .open(path)?;
        // SAFETY: a handle opened with WRITE_DAC and a self-relative descriptor.
        check(unsafe {
            SetKernelObjectSecurity(
                object.as_raw_handle(),
                DACL_SECURITY_INFORMATION,
                descriptor.0,
            )
        })?;
        done.lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(key);
        Ok(())
    }
}

/// A liveness hint only, never authority to signal a recorded PID. Unknown or
/// permission-denied probes count as alive so runtime cleanup stays conservative.
#[cfg(unix)]
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
#[cfg(unix)]
pub(crate) fn signal_termination(child: &mut tokio::process::Child) -> bool {
    child
        .id()
        .is_some_and(|pid| unsafe { libc::kill(pid as libc::pid_t, libc::SIGTERM) } == 0)
}

#[cfg(unix)]
fn hostname_from_bytes(bytes: &[u8]) -> Option<String> {
    let length = bytes
        .iter()
        .position(|byte| *byte == 0)
        .unwrap_or(bytes.len());
    (length > 0).then(|| String::from_utf8_lossy(&bytes[..length]).into_owned())
}

#[cfg(unix)]
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

#[cfg(unix)]
pub fn name_too_long(error: &io::Error) -> bool {
    error.raw_os_error() == Some(libc::ENAMETOOLONG)
}

#[cfg(all(test, unix))]
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

#[cfg(windows)]
pub fn process_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    unsafe extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut std::ffi::c_void;
        fn WaitForSingleObject(handle: *mut std::ffi::c_void, milliseconds: u32) -> u32;
        fn CloseHandle(handle: *mut std::ffi::c_void) -> i32;
    }
    let process = unsafe { OpenProcess(0x00100000, 0, pid) }; // SYNCHRONIZE
    if process.is_null() {
        return io::Error::last_os_error().raw_os_error() != Some(87);
    }
    let state = unsafe { WaitForSingleObject(process, 0) };
    unsafe {
        CloseHandle(process);
    }
    state != 0 // WAIT_OBJECT_0 means exited; failures remain conservative.
}
/// Windows has no request to stop a process, so this ends the child at once
/// (TerminateProcess through `start_kill`) and a caller's grace period only
/// waits for the exit. The Pi supervisor asks first, by ending Pi's input.
#[cfg(windows)]
pub(crate) fn signal_termination(child: &mut tokio::process::Child) -> bool {
    child.id().is_some() && child.start_kill().is_ok()
}
#[cfg(windows)]
pub fn hostname() -> Option<String> {
    unsafe extern "system" {
        fn GetComputerNameW(buffer: *mut u16, size: *mut u32) -> i32;
    }
    let mut buffer = [0u16; 256];
    let mut size = buffer.len() as u32;
    (unsafe { GetComputerNameW(buffer.as_mut_ptr(), &mut size) } != 0)
        .then(|| String::from_utf16_lossy(&buffer[..size as usize]))
}
#[cfg(windows)]
pub fn name_too_long(error: &io::Error) -> bool {
    error.raw_os_error() == Some(206)
}

#[cfg(test)]
mod boundary_tests {
    use super::*;

    /// What a private folder or file grants, read back out of its SDDL.
    fn entries(sddl: &str) -> (String, Vec<Vec<String>>) {
        let (flags, aces) = sddl.strip_prefix("D:").unwrap().split_once('(').unwrap();
        let aces = aces
            .strip_suffix(')')
            .unwrap()
            .split(")(")
            .map(|ace| ace.split(';').map(str::to_owned).collect())
            .collect();
        (flags.to_owned(), aces)
    }

    #[test]
    fn private_dacls_grant_full_control_to_system_and_the_user_alone() {
        let user = "S-1-5-21-1004336348-1177238915-682003330-1001";
        for (directory, inherit) in [(true, "OICI"), (false, "")] {
            let sddl = private_sddl(user, directory);
            let (flags, aces) = entries(&sddl);
            // Protected: nothing the parent grants reaches it.
            assert!(flags.contains('P'), "{sddl}");
            assert_eq!(aces.len(), 2, "{sddl}");
            for ace in &aces {
                // Allowed, full control; a folder passes it on to new entries.
                assert_eq!(ace[..5], ["A", inherit, "FA", "", ""], "{sddl}");
            }
            let trustees: Vec<&str> = aces.iter().map(|ace| ace[5].as_str()).collect();
            assert_eq!(trustees, ["SY", user], "{sddl}");
            // Never Everyone, any signed-in user, Users or Administrators.
            for broad in ["WD", "S-1-1-0", "AU", "BU", "BA", "AC"] {
                assert!(!trustees.contains(&broad), "{sddl}");
            }
        }
    }

    #[test]
    fn missing_entries_are_already_removed_and_missing_roots_hold_nothing() {
        let base = tempfile::tempdir().unwrap();
        remove_entry(&base.path().join("absent")).unwrap();
        let sessions = base.path().join("runtime/sessions");
        assert!(!directory_below(base.path(), &sessions).unwrap());
        fs::create_dir_all(&sessions).unwrap();
        assert!(directory_below(base.path(), &sessions).unwrap());
        // Only plain names below the base are judged.
        for outside in [
            base.path().join("runtime/../elsewhere"),
            base.path().parent().unwrap().to_path_buf(),
        ] {
            assert_eq!(
                directory_below(base.path(), &outside).unwrap_err().kind(),
                io::ErrorKind::InvalidInput,
                "{}",
                outside.display()
            );
        }
        fs::write(base.path().join("file"), "").unwrap();
        assert_eq!(
            directory_below(base.path(), &base.path().join("file/inner"))
                .unwrap_err()
                .kind(),
            io::ErrorKind::NotADirectory
        );
        fs::create_dir_all(base.path().join("tree/nested")).unwrap();
        fs::write(base.path().join("tree/nested/file"), "x").unwrap();
        for entry in ["tree", "file"] {
            remove_entry(&base.path().join(entry)).unwrap();
            assert!(fs::symlink_metadata(base.path().join(entry)).is_err());
        }
    }

    #[cfg(unix)]
    #[test]
    fn links_are_removed_as_links_and_refused_as_roots() {
        use std::os::unix::fs::symlink;
        let base = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::create_dir(outside.path().join("sessions")).unwrap();
        fs::write(outside.path().join("sessions/keep"), "keep").unwrap();
        // A tree holding a link loses the link, never what it names.
        let tree = base.path().join("tree");
        fs::create_dir(&tree).unwrap();
        symlink(outside.path(), tree.join("link")).unwrap();
        remove_entry(&tree).unwrap();
        assert!(!tree.exists());
        // A link to a folder, and one to nothing, go by themselves.
        for (name, target) in [
            ("folder", outside.path().to_path_buf()),
            ("dangling", outside.path().join("absent")),
        ] {
            let link = base.path().join(name);
            symlink(&target, &link).unwrap();
            remove_entry(&link).unwrap();
            assert!(fs::symlink_metadata(&link).is_err(), "{name}");
        }
        assert!(outside.path().join("sessions/keep").is_file());
        // A link at any level of a root is refused, not followed.
        let sessions = base.path().join("runtime/sessions");
        symlink(outside.path(), base.path().join("runtime")).unwrap();
        let error = directory_below(base.path(), &sessions).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
        assert!(error.to_string().contains("is a link"), "{error}");
        fs::remove_file(base.path().join("runtime")).unwrap();
        fs::create_dir(base.path().join("runtime")).unwrap();
        symlink(outside.path().join("sessions"), &sessions).unwrap();
        assert_eq!(
            directory_below(base.path(), &sessions).unwrap_err().kind(),
            io::ErrorKind::InvalidInput
        );
        assert!(outside.path().join("sessions/keep").is_file());
    }

    #[cfg(unix)]
    #[test]
    fn private_entries_are_their_owners_alone() {
        use std::os::unix::fs::PermissionsExt;
        let base = tempfile::tempdir().unwrap();
        let mode = |path: &Path| fs::metadata(path).unwrap().permissions().mode() & 0o777;
        let home = base.path().join("parent/home");
        create_private_dir_all(&home).unwrap();
        // Every folder made on the way is the owner's alone, as before.
        assert_eq!(mode(&home), 0o700);
        assert_eq!(mode(&base.path().join("parent")), 0o700);
        fs::set_permissions(&home, fs::Permissions::from_mode(0o755)).unwrap();
        create_private_dir_all(&home).unwrap();
        assert_eq!(mode(&home), 0o700);
        let folder = base.path().join("folder");
        fs::create_dir(&folder).unwrap();
        private_dir(&folder).unwrap();
        assert_eq!(mode(&folder), 0o700);
        let file = base.path().join("token");
        fs::write(&file, "secret").unwrap();
        private_file(&file).unwrap();
        assert_eq!(mode(&file), 0o600);
    }
}
