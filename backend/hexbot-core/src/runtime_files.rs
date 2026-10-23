//! Native file callbacks anchor every operation to a directory handle. A later
//! parent symlink must not redirect an already checked destination.
use crate::{Error, Result};
use std::{
    ffi::CString,
    fs::File,
    io::{Read, Write},
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::{ffi::OsStrExt, fs::MetadataExt},
    },
    path::{Component, Path},
};

pub(super) struct FileAccess {
    directory: File,
    name: CString,
}
fn c_name(name: &std::ffi::OsStr) -> Result<CString> {
    CString::new(name.as_bytes()).map_err(|_| Error::new(4202, "invalid file path"))
}
fn opened(fd: i32) -> Result<File> {
    if fd < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    // SAFETY: successful open/openat returned a fresh owned descriptor.
    Ok(unsafe { File::from_raw_fd(fd) })
}
impl FileAccess {
    pub(super) fn open(path: &Path, create: bool) -> Result<Self> {
        Self::open_with_mode(path, create, 0o755)
    }
    pub(super) fn pi_open(path: &Path, create: bool) -> Result<Self> {
        Self::open_with_mode(path, create, 0o777)
    }
    fn open_with_mode(path: &Path, create: bool, mode: libc::mode_t) -> Result<Self> {
        if !path.is_absolute() {
            return Err(Error::new(4202, "file path must be absolute"));
        }
        let parent = path
            .parent()
            .ok_or_else(|| Error::new(4202, "invalid file parent"))?;
        let name = c_name(
            path.file_name()
                .ok_or_else(|| Error::new(4202, "invalid file name"))?,
        )?;
        let flags = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
        let mut directory = opened(unsafe { libc::open(c"/".as_ptr(), flags) })?;
        for component in parent.components() {
            let Component::Normal(component) = component else {
                if component == Component::RootDir {
                    continue;
                }
                return Err(Error::new(4202, "file parent must be resolved"));
            };
            let name = c_name(component)?;
            let mut fd = unsafe { libc::openat(directory.as_raw_fd(), name.as_ptr(), flags) };
            if fd < 0
                && create
                && std::io::Error::last_os_error().kind() == std::io::ErrorKind::NotFound
            {
                let created = unsafe { libc::mkdirat(directory.as_raw_fd(), name.as_ptr(), mode) };
                if created < 0
                    && std::io::Error::last_os_error().kind() != std::io::ErrorKind::AlreadyExists
                {
                    return Err(std::io::Error::last_os_error().into());
                }
                fd = unsafe { libc::openat(directory.as_raw_fd(), name.as_ptr(), flags) };
            }
            directory = opened(fd)?;
        }
        Ok(Self { directory, name })
    }
    pub(super) fn parent_identity(&self) -> Result<[String; 2]> {
        let metadata = self.directory.metadata()?;
        Ok([metadata.dev().to_string(), metadata.ino().to_string()])
    }
    pub(super) fn check_parent(&self, expected: &[String; 2]) -> Result<()> {
        if &self.parent_identity()? != expected {
            return Err(Error::new(4302, "The file's folder changed. Try again."));
        }
        Ok(())
    }
    fn pi_mode(&self, read: bool, create: bool) -> Result<Option<libc::mode_t>> {
        let mut info = std::mem::MaybeUninit::<libc::stat>::uninit();
        if unsafe {
            libc::fstatat(
                self.directory.as_raw_fd(),
                self.name.as_ptr(),
                info.as_mut_ptr(),
                libc::AT_SYMLINK_NOFOLLOW,
            )
        } < 0
        {
            let error = std::io::Error::last_os_error();
            if create && error.kind() == std::io::ErrorKind::NotFound {
                return Ok(None);
            }
            return Err(error.into());
        }
        // SAFETY: successful fstatat initialized info.
        let mode = unsafe { info.assume_init() }.st_mode;
        if mode & libc::S_IFMT != libc::S_IFREG {
            return Err(Error::new(4202, "path is not a regular file"));
        }
        let access = libc::W_OK | if read { libc::R_OK } else { 0 };
        if unsafe {
            libc::faccessat(
                self.directory.as_raw_fd(),
                self.name.as_ptr(),
                access,
                libc::AT_EACCESS | libc::AT_SYMLINK_NOFOLLOW,
            )
        } < 0
        {
            let error = std::io::Error::last_os_error();
            return Err(Error::new(
                4202,
                format!(
                    "{}: {error}",
                    if error.kind() == std::io::ErrorKind::PermissionDenied {
                        "EACCES"
                    } else {
                        "File access failed"
                    }
                ),
            ));
        }
        Ok(Some(mode & 0o777))
    }
    pub(super) fn pi_read(&self, limit: usize) -> Result<Vec<u8>> {
        self.pi_mode(true, false)?;
        let file = opened(unsafe {
            libc::openat(
                self.directory.as_raw_fd(),
                self.name.as_ptr(),
                libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
            )
        })?;
        if !file.metadata()?.is_file() {
            return Err(Error::new(4202, "path is not a regular file"));
        }
        let mut bytes = Vec::new();
        file.take(limit as u64 + 1).read_to_end(&mut bytes)?;
        if bytes.len() > limit {
            return Err(Error::new(
                4202,
                "Restricted write/edit exceeds the 1 MiB transport limit (about 767 KiB of file data). Use a command for larger files.",
            ));
        }
        Ok(bytes)
    }
    pub(super) fn pi_write(&self, bytes: &[u8]) -> Result<()> {
        let mode = self.pi_mode(false, true)?;
        self.replace(bytes, mode)
    }
    pub(super) fn read(&self) -> Result<String> {
        let file = opened(unsafe {
            libc::openat(
                self.directory.as_raw_fd(),
                self.name.as_ptr(),
                libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
            )
        })?;
        if !file.metadata()?.is_file() {
            return Err(Error::new(4202, "path is not a regular file"));
        }
        let mut bytes = Vec::new();
        file.take(256 * 1024 + 1).read_to_end(&mut bytes)?;
        if bytes.len() > 256 * 1024 {
            return Err(Error::new(4202, "file exceeds the read limit"));
        }
        String::from_utf8(bytes).map_err(|_| Error::new(4202, "file is not UTF-8 text"))
    }
    pub(super) fn write(&self, bytes: &[u8]) -> Result<()> {
        self.replace(bytes, None)
    }
    fn replace(&self, bytes: &[u8], mode: Option<libc::mode_t>) -> Result<()> {
        let temporary = CString::new(format!(".hexbot-{}.tmp", crate::common::id()))
            .expect("generated file name");
        let mut file = opened(unsafe {
            libc::openat(
                self.directory.as_raw_fd(),
                temporary.as_ptr(),
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                0o600,
            )
        })?;
        let result = (|| -> Result<()> {
            file.write_all(bytes)?;
            if let Some(mode) = mode
                && unsafe { libc::fchmod(file.as_raw_fd(), mode) } < 0
            {
                return Err(std::io::Error::last_os_error().into());
            }
            file.sync_all()?;
            if unsafe {
                libc::renameat(
                    self.directory.as_raw_fd(),
                    temporary.as_ptr(),
                    self.directory.as_raw_fd(),
                    self.name.as_ptr(),
                )
            } < 0
            {
                return Err(std::io::Error::last_os_error().into());
            }
            self.directory.sync_all()?;
            Ok(())
        })();
        if result.is_err() {
            unsafe {
                libc::unlinkat(self.directory.as_raw_fd(), temporary.as_ptr(), 0);
            }
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn atomic_file_callback_preserves_other_hardlink_names_even_after_open() {
        for late in [false, true] {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path().canonicalize().unwrap();
            let source = root.join("native-current.json");
            let output = root.join("artifact");
            std::fs::write(&source, "keep").unwrap();
            if !late {
                std::fs::hard_link(&source, &output).unwrap();
            }
            let access = FileAccess::open(&output, true).unwrap();
            if late {
                std::fs::hard_link(&source, &output).unwrap();
            }
            access.write(b"ordinary output").unwrap();
            assert_eq!(std::fs::read_to_string(&source).unwrap(), "keep");
            assert_eq!(access.read().unwrap(), "ordinary output");
        }
    }
    #[test]
    fn parent_swap_cannot_redirect_an_open_file_callback() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let parent = root.join("output");
        let moved = root.join("moved");
        let managed = root.join("managed");
        std::fs::create_dir(&parent).unwrap();
        std::fs::create_dir(&managed).unwrap();
        std::fs::write(managed.join("hexbot.exe"), "keep").unwrap();
        let access = FileAccess::open(&parent.join("hexbot.exe"), true).unwrap();
        std::fs::rename(&parent, &moved).unwrap();
        std::os::unix::fs::symlink(&managed, &parent).unwrap();
        access.write(b"safe output").unwrap();
        assert_eq!(
            std::fs::read_to_string(managed.join("hexbot.exe")).unwrap(),
            "keep"
        );
        assert_eq!(
            std::fs::read_to_string(moved.join("hexbot.exe")).unwrap(),
            "safe output"
        );
        assert!(FileAccess::open(&parent.join("hexbot.exe"), true).is_err());
    }
    #[test]
    fn pi_parent_handles_and_atomic_replacement_preserve_other_names() {
        for late in [false, true] {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path().canonicalize().unwrap();
            let parent = root.join("output");
            let source = root.join("managed");
            std::fs::create_dir(&parent).unwrap();
            std::fs::write(&source, "keep").unwrap();
            let target = parent.join("file");
            if !late {
                std::fs::hard_link(&source, &target).unwrap();
            }
            let access = FileAccess::pi_open(&target, true).unwrap();
            if late {
                std::fs::hard_link(&source, &target).unwrap();
            }
            std::fs::rename(&parent, root.join("moved")).unwrap();
            std::fs::create_dir(&parent).unwrap();
            std::fs::write(&target, "replacement").unwrap();
            access.pi_write(b"changed").unwrap();
            assert_eq!(std::fs::read_to_string(&source).unwrap(), "keep");
            assert_eq!(std::fs::read_to_string(&target).unwrap(), "replacement");
            assert_eq!(
                std::fs::read_to_string(root.join("moved/file")).unwrap(),
                "changed"
            );
        }
    }
    #[test]
    fn pi_failed_rename_removes_its_temporary_entry() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let target = root.join("file");
        let access = FileAccess::pi_open(&target, true).unwrap();
        // Simulate a directory arriving after the regular-leaf check, at rename.
        std::fs::create_dir(&target).unwrap();
        assert!(access.replace(b"changed", None).is_err());
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 1);
        assert!(target.is_dir());
    }
    #[test]
    fn native_callback_permissions_and_utf8_limit_remain_unchanged() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let path = root.join("file");
        std::fs::write(&path, "keep").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o444)).unwrap();
        let access = FileAccess::open(&path, false).unwrap();
        access.write(b"native").unwrap();
        assert_eq!(access.read().unwrap(), "native");
        assert_eq!(std::fs::metadata(&path).unwrap().mode() & 0o077, 0);
        access.write(&[0xff]).unwrap();
        assert!(access.read().unwrap_err().message.contains("UTF-8"));
        access.write(&vec![b'x'; 256 * 1024 + 1]).unwrap();
        assert!(access.read().unwrap_err().message.contains("read limit"));
    }
}
