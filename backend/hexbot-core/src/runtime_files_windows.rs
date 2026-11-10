//! Pi's write and edit on Windows go through handles, as `runtime_files.rs`
//! does on Unix. The walk opens each folder relative to the one before it,
//! from the drive's root, and never follows a link, junction or other
//! reparse point, so a folder swapped for one cannot redirect a checked
//! write. The folder and the file must be named on disk as the path names
//! them, so a short 8.3 name cannot reach an entry the policy checks never
//! saw. A write fills a temporary file in that folder and renames it over the
//! target through the folder's handle: the target is replaced at once, a
//! folder there refuses, and its other hard-link names keep their content.
//! An edit carries the file's own identity from its read to its write and
//! refuses when another file has the name by then. Nothing falls back to
//! opening the path by name.
#[path = "runtime_files_windows_policy.rs"]
mod policy;

use crate::{Error, Result};
use std::{
    ffi::c_void,
    fs::{File, OpenOptions},
    io::{self, Read, Write},
    os::windows::{
        fs::OpenOptionsExt,
        io::{AsRawHandle, FromRawHandle, OwnedHandle},
    },
    path::Path,
    ptr,
};

type Handle = *mut c_void;

#[repr(C)]
struct UnicodeString {
    length: u16,
    maximum: u16,
    buffer: *const u16,
}
#[repr(C)]
struct ObjectAttributes {
    length: u32,
    root: Handle,
    name: *const UnicodeString,
    attributes: u32,
    descriptor: *mut c_void,
    quality: *mut c_void,
}
#[repr(C)]
#[derive(Default)]
struct IoStatus {
    status: usize,
    information: usize,
}
/// FILE_ATTRIBUTE_TAG_INFO.
#[repr(C)]
#[derive(Default)]
struct AttributeTag {
    attributes: u32,
    tag: u32,
}
/// FILE_ID_INFO.
#[repr(C)]
#[derive(Default)]
struct FileId {
    volume: u64,
    id: [u8; 16],
}
// Other modules declare some of these with their own struct types.
#[allow(clashing_extern_declarations)]
#[link(name = "kernel32", kind = "raw-dylib")]
unsafe extern "system" {
    fn GetFileType(handle: Handle) -> u32;
    fn GetFileInformationByHandleEx(
        handle: Handle,
        class: u32,
        buffer: *mut c_void,
        length: u32,
    ) -> i32;
    fn GetFinalPathNameByHandleW(handle: Handle, path: *mut u16, length: u32, flags: u32) -> u32;
}
#[allow(clashing_extern_declarations)]
#[link(name = "ntdll", kind = "raw-dylib")]
unsafe extern "system" {
    fn NtCreateFile(
        handle: *mut Handle,
        access: u32,
        attributes: *const ObjectAttributes,
        status: *mut IoStatus,
        allocation: *const i64,
        file_attributes: u32,
        share: u32,
        disposition: u32,
        options: u32,
        ea: *const c_void,
        ea_length: u32,
    ) -> i32;
    fn NtSetInformationFile(
        handle: Handle,
        status: *mut IoStatus,
        information: *const c_void,
        length: u32,
        class: u32,
    ) -> i32;
    fn RtlNtStatusToDosError(status: i32) -> u32;
}

const FILE_READ_DATA: u32 = 0x1;
const FILE_WRITE_DATA: u32 = 0x2;
const FILE_READ_ATTRIBUTES: u32 = 0x80;
const DELETE: u32 = 0x0001_0000;
const SYNCHRONIZE: u32 = 0x0010_0000;
const GENERIC_WRITE: u32 = 0x4000_0000;
const SHARE_ALL: u32 = 0x7;
const FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
const FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
const OBJ_CASE_INSENSITIVE: u32 = 0x40;
const FILE_OPEN: u32 = 1;
const FILE_CREATE: u32 = 2;
const FILE_OPEN_IF: u32 = 3;
const FILE_DIRECTORY_FILE: u32 = 0x1;
const FILE_SYNCHRONOUS_IO_NONALERT: u32 = 0x20;
const FILE_NON_DIRECTORY_FILE: u32 = 0x40;
const FILE_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
const FILE_ATTRIBUTE_DIRECTORY: u32 = 0x10;
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
const FILE_TYPE_DISK: u32 = 1;
const ATTRIBUTE_TAG_INFO: u32 = 9;
const ID_INFO: u32 = 18;
const RENAME_INFORMATION: u32 = 10;
const DISPOSITION_INFORMATION: u32 = 13;
const DISPOSITION_INFORMATION_EX: u32 = 64;
const RENAME_INFORMATION_EX: u32 = 65;
const RENAME_REPLACE_IF_EXISTS: u32 = 0x1;
const RENAME_POSIX_SEMANTICS: u32 = 0x2;
const DISPOSITION_DELETE: u32 = 0x1;
const DISPOSITION_POSIX_SEMANTICS: u32 = 0x2;
const ERROR_FILE_NOT_FOUND: i32 = 2;

const CHANGED: &str = "The file changed. Try again.";
const NOT_REGULAR: &str = "path is not a regular file";
const LINKED: &str = "A folder on this path is a link, a junction or a cloud-synced folder, which Hexbot does not write through.";
const ANOTHER_NAME: &str = "This path names a file or folder by another name, such as an 8.3 short name. Use its full path.";

fn check(ok: i32) -> io::Result<()> {
    if ok == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}
fn nt(status: i32) -> io::Result<()> {
    if status < 0 {
        // SAFETY: converts an NTSTATUS to a Win32 error code.
        let code = unsafe { RtlNtStatusToDosError(status) };
        return Err(io::Error::from_raw_os_error(code as i32));
    }
    Ok(())
}

/// The drive's root folder, such as `C:\`. Only a drive root is opened by
/// its path, after the path's text was judged.
fn open_root(root: &str) -> io::Result<OwnedHandle> {
    OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES | SYNCHRONIZE)
        .share_mode(SHARE_ALL)
        .custom_flags(FLAG_BACKUP_SEMANTICS | FLAG_OPEN_REPARSE_POINT)
        .open(root)
        .map(OwnedHandle::from)
}

/// Open `name` inside `folder` through the folder's handle, never by path. A
/// link, junction or other reparse point is opened as itself.
fn open_at(
    folder: &OwnedHandle,
    name: &[u16],
    access: u32,
    share: u32,
    disposition: u32,
    options: u32,
) -> io::Result<OwnedHandle> {
    let length = u16::try_from(name.len() * 2)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, policy::LONG))?;
    let text = UnicodeString {
        length,
        maximum: length,
        buffer: name.as_ptr(),
    };
    let attributes = ObjectAttributes {
        length: size_of::<ObjectAttributes>() as u32,
        root: folder.as_raw_handle(),
        name: &text,
        attributes: OBJ_CASE_INSENSITIVE,
        descriptor: ptr::null_mut(),
        quality: ptr::null_mut(),
    };
    let mut status = IoStatus::default();
    let mut handle = ptr::null_mut();
    // SAFETY: valid attributes naming one entry relative to `folder`.
    nt(unsafe {
        NtCreateFile(
            &mut handle,
            access | SYNCHRONIZE,
            &attributes,
            &mut status,
            ptr::null(),
            0,
            share,
            disposition,
            options | FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT,
            ptr::null(),
            0,
        )
    })?;
    // SAFETY: a fresh handle, owned from here on.
    Ok(unsafe { OwnedHandle::from_raw_handle(handle) })
}

fn attributes(handle: &OwnedHandle) -> io::Result<u32> {
    let mut info = AttributeTag::default();
    // SAFETY: a valid handle and an output struct of the class's size.
    check(unsafe {
        GetFileInformationByHandleEx(
            handle.as_raw_handle(),
            ATTRIBUTE_TAG_INFO,
            (&raw mut info).cast(),
            size_of::<AttributeTag>() as u32,
        )
    })?;
    Ok(info.attributes)
}

/// The path Windows reports for an open folder or file: each name as it is
/// on disk, from its drive.
fn final_path(handle: &OwnedHandle) -> io::Result<String> {
    let mut buffer = vec![0u16; 512];
    loop {
        // SAFETY: a valid handle and a buffer of the length given.
        let length = unsafe {
            GetFinalPathNameByHandleW(
                handle.as_raw_handle(),
                buffer.as_mut_ptr(),
                buffer.len() as u32,
                0,
            )
        } as usize;
        if length == 0 {
            return Err(io::Error::last_os_error());
        }
        if length < buffer.len() {
            return String::from_utf16(&buffer[..length])
                .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "path is not Unicode"));
        }
        // Too small: the length asked for counts the terminating NUL.
        buffer.resize(length, 0);
    }
}

/// The volume and 128-bit ID of an open file. A file system without them
/// (FAT, exFAT) recycles its file index when a directory entry is reused,
/// so an edit could commit to a re-created file carrying the old identity;
/// those refuse instead of falling back to a weaker identity.
fn identity(handle: &OwnedHandle) -> io::Result<[String; 2]> {
    let mut info = FileId::default();
    // SAFETY: a valid handle and an output struct of the class's size.
    if unsafe {
        GetFileInformationByHandleEx(
            handle.as_raw_handle(),
            ID_INFO,
            (&raw mut info).cast(),
            size_of::<FileId>() as u32,
        )
    } != 0
    {
        return Ok(policy::identity(info.volume, info.id));
    }
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "This file system has no file identity an edit can check.",
    ))
}

/// The identity of an open entry that is a regular file named on disk as
/// `path` names it: no folder, link, junction or other reparse point, pipe
/// or device, and not reached by a short name.
fn regular(handle: &OwnedHandle, path: &str) -> Result<[String; 2]> {
    // SAFETY: a valid handle.
    if unsafe { GetFileType(handle.as_raw_handle()) } != FILE_TYPE_DISK
        || attributes(handle)? & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT) != 0
    {
        return Err(Error::new(4202, NOT_REGULAR));
    }
    if !policy::same_path(&final_path(handle)?, path) {
        return Err(Error::new(4202, ANOTHER_NAME));
    }
    Ok(identity(handle)?)
}

/// What had the file's name when the walk ended.
enum Leaf {
    Missing,
    /// A regular file, by its identity.
    File([String; 2]),
    /// Anything else, and why it is neither read nor replaced.
    Other(i64, String),
}

pub(super) struct FileAccess {
    /// The file's folder, reached by the walk.
    folder: OwnedHandle,
    /// The file's name in that folder.
    name: Vec<u16>,
    /// The file's plain path, which its name on disk must match.
    path: String,
    leaf: Leaf,
}

impl FileAccess {
    /// Walk to `path`'s folder, creating missing folders when `create` is
    /// set, and note what has the file's name there.
    pub(super) fn pi_open(path: &Path, create: bool) -> Result<Self> {
        let text = path
            .to_str()
            .ok_or_else(|| Error::new(4202, "file path must be Unicode"))?;
        let walk =
            policy::walk(text).map_err(|reason| Error::new(4202, format!("{reason}: {text}")))?;
        // A mapped network drive is not local, whatever its letter says.
        crate::windows_sandbox::fixed_drive(&walk.plain[..3])?;
        let mut folder = open_root(&walk.root)?;
        for name in &walk.folders {
            folder = open_at(
                &folder,
                name,
                FILE_READ_ATTRIBUTES,
                SHARE_ALL,
                if create { FILE_OPEN_IF } else { FILE_OPEN },
                FILE_DIRECTORY_FILE,
            )?;
            if attributes(&folder)? & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                return Err(Error::new(4202, LINKED));
            }
        }
        if !policy::same_path(&final_path(&folder)?, &walk.folder) {
            return Err(Error::new(4202, ANOTHER_NAME));
        }
        let leaf = match open_at(
            &folder,
            &walk.name,
            FILE_READ_ATTRIBUTES,
            SHARE_ALL,
            FILE_OPEN,
            0,
        ) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => Leaf::Missing,
            Err(error) => Leaf::Other(5200, error.to_string()),
            Ok(entry) => match regular(&entry, &walk.plain) {
                Ok(identity) => Leaf::File(identity),
                Err(error) => Leaf::Other(error.code, error.message),
            },
        };
        Ok(Self {
            folder,
            name: walk.name,
            path: walk.plain,
            leaf,
        })
    }
    /// The bridge's `parent` field holds the file's own identity on Windows:
    /// the name must still have the file the edit read.
    pub(super) fn check_parent(&self, expected: &[String; 2]) -> Result<()> {
        match &self.leaf {
            Leaf::File(identity) if identity == expected => Ok(()),
            _ => Err(Error::new(4302, CHANGED)),
        }
    }
    /// The identity of the file `pi_read` reads.
    pub(super) fn parent_identity(&self) -> Result<[String; 2]> {
        match &self.leaf {
            Leaf::File(identity) => Ok(identity.clone()),
            _ => Err(Error::new(4302, CHANGED)),
        }
    }
    pub(super) fn pi_read(&self, limit: usize) -> Result<Vec<u8>> {
        // As on Unix, the bridge reads only a file it may also write.
        let file = self.reopen(FILE_READ_DATA | FILE_WRITE_DATA)?;
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
        if !matches!(self.leaf, Leaf::Missing) {
            // The user may write the file, and it is still the one found.
            drop(self.reopen(FILE_WRITE_DATA)?);
        }
        self.replace(bytes)
    }
    /// The file the walk found, opened again with `access`, while the name
    /// still has that file.
    fn reopen(&self, access: u32) -> Result<File> {
        let expected = match &self.leaf {
            Leaf::Missing => return Err(io::Error::from_raw_os_error(ERROR_FILE_NOT_FOUND).into()),
            Leaf::Other(code, message) => return Err(Error::new(*code, message.clone())),
            Leaf::File(identity) => identity,
        };
        let file = open_at(
            &self.folder,
            &self.name,
            access | FILE_READ_ATTRIBUTES,
            SHARE_ALL,
            FILE_OPEN,
            0,
        )
        .map_err(|error| match error.kind() {
            io::ErrorKind::NotFound => Error::new(4302, CHANGED),
            io::ErrorKind::PermissionDenied => Error::new(4202, format!("EACCES: {error}")),
            _ => Error::new(4202, format!("File access failed: {error}")),
        })?;
        if regular(&file, &self.path)? != *expected {
            return Err(Error::new(4302, CHANGED));
        }
        Ok(File::from(file))
    }
    /// Fill a new file in the folder, shared with no one, and rename it over
    /// the name through the folder's handle. On failure the new file is
    /// deleted through its own handle, never by name.
    fn replace(&self, bytes: &[u8]) -> Result<()> {
        let temporary = policy::temporary(&crate::common::id());
        let mut file = File::from(open_at(
            &self.folder,
            &temporary,
            GENERIC_WRITE | DELETE | FILE_READ_ATTRIBUTES,
            0,
            FILE_CREATE,
            FILE_NON_DIRECTORY_FILE,
        )?);
        let result = (|| -> Result<()> {
            file.write_all(bytes)?;
            file.sync_all()?;
            self.rename(&file)
        })();
        if result.is_err() {
            delete(&file);
        }
        result
    }
    /// Replace the name with `file`, relative to the folder's handle. A
    /// folder at the name refuses, as does a read-only file.
    fn rename(&self, file: &File) -> Result<()> {
        let folder = self.folder.as_raw_handle() as usize;
        let rename = |flags: u32, class: u32| {
            let (record, length) = policy::rename_record(flags, folder, &self.name);
            let mut status = IoStatus::default();
            // SAFETY: a rename record of `length` bytes naming one entry
            // relative to the folder's handle, which outlives the call.
            unsafe {
                NtSetInformationFile(
                    file.as_raw_handle(),
                    &mut status,
                    record.as_ptr().cast(),
                    length,
                    class,
                )
            }
        };
        let mut status = rename(
            RENAME_REPLACE_IF_EXISTS | RENAME_POSIX_SEMANTICS,
            RENAME_INFORMATION_EX,
        );
        if policy::unsupported_class(status) {
            // The plain record's first byte is ReplaceIfExists.
            status = rename(1, RENAME_INFORMATION);
        }
        Ok(nt(status)?)
    }
}

/// Delete a file through the handle that wrote it, never by name: its name
/// goes at once, even while a scanner still holds the file, where the file
/// system supports that; otherwise when the last handle closes.
fn delete(file: &File) {
    let set = |information: *const c_void, length: u32, class: u32| {
        let mut status = IoStatus::default();
        // SAFETY: a disposition record of `length` bytes for a handle opened
        // with DELETE.
        unsafe {
            NtSetInformationFile(
                file.as_raw_handle(),
                &mut status,
                information,
                length,
                class,
            )
        }
    };
    let flags = DISPOSITION_DELETE | DISPOSITION_POSIX_SEMANTICS;
    if policy::unsupported_class(set(
        (&raw const flags).cast(),
        4,
        DISPOSITION_INFORMATION_EX,
    )) {
        // FILE_DISPOSITION_INFORMATION is one BOOLEAN.
        let yes = 1u8;
        set((&raw const yes).cast(), 1, DISPOSITION_INFORMATION);
    }
}
