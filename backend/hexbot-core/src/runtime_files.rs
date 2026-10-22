//! Native file callbacks anchor every operation to a directory handle. A later
//! parent symlink must not redirect an already checked destination.
use crate::{Error, Result};
use std::{
    ffi::CString,
    fs::File,
    io::{Read, Write},
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::ffi::OsStrExt,
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
                let created = unsafe { libc::mkdirat(directory.as_raw_fd(), name.as_ptr(), 0o755) };
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
}
