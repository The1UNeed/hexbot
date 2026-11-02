//! Windows tool isolation: AppContainers, file grants and contained processes.
//!
//! One AppContainer per policy: its Hexbot home, its access level (Auto writes
//! the workspace, Manual only reads it) and the roots it is granted. Grants are
//! lasting ACL entries, so a container never reaches a root that only another
//! policy was granted. A container has no capabilities, so it has no network,
//! not even loopback, and reaches no file the user owns unless Hexbot granted
//! it. Grants are allow entries for the container's SID only: the workspace and
//! output folders, its own private home and temp folder, and the runtime
//! programs a command may run. Git metadata gets a write deny and project
//! secrets a full deny for the same SID; a deny that misses an entry stops the
//! command. A root that is or holds the user's profile, the Hexbot home, a
//! credential store or the managed runtime is refused before anything changes.
//!
//! Grants are applied by walking each tree through handles. Every entry is
//! opened relative to its parent's handle without following reparse points, so
//! swapping a folder for a junction during the walk cannot redirect it. Reparse
//! points are never changed or entered, and a file with more than one hard link
//! is never granted: its DACL is shared with names outside the tree. A journal
//! names every profile before it is created and every root before it changes,
//! and `hexbot sandbox reset` removes every entry for those profiles' SIDs from
//! the roots it names, then deletes the profiles. Other entries are never
//! touched. One lock file serializes all changes across processes.
use crate::windows_paths::sandbox::{self as rules, Protected};
pub use crate::windows_paths::sandbox::{Access, GrantKind, Journal, JournalEntry, Policy};
use std::{
    ffi::{OsStr, OsString, c_void},
    fs, io, mem,
    os::windows::{
        ffi::{OsStrExt, OsStringExt},
        io::{AsRawHandle, FromRawHandle, OwnedHandle},
    },
    path::{Path, PathBuf},
    ptr,
    sync::OnceLock,
};

type Handle = *mut c_void;
type Sid = *mut c_void;

#[repr(C)]
struct AceHeader {
    kind: u8,
    flags: u8,
    size: u16,
}
#[repr(C)]
struct AclSize {
    count: u32,
    used: u32,
    free: u32,
}
#[repr(C)]
struct SecurityCapabilities {
    container: Sid,
    capabilities: *mut c_void,
    count: u32,
    reserved: u32,
}
#[repr(C)]
struct StartupInfo {
    cb: u32,
    reserved: *mut u16,
    desktop: *mut u16,
    title: *mut u16,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
    columns: u32,
    rows: u32,
    fill: u32,
    flags: u32,
    show: u16,
    reserved2_len: u16,
    reserved2: *mut u8,
    stdin: Handle,
    stdout: Handle,
    stderr: Handle,
}
#[repr(C)]
struct StartupInfoEx {
    info: StartupInfo,
    attributes: *mut c_void,
}
#[repr(C)]
struct ProcessInformation {
    process: Handle,
    thread: Handle,
    pid: u32,
    tid: u32,
}
#[repr(C)]
#[derive(Default)]
struct BasicLimits {
    process_time: i64,
    job_time: i64,
    flags: u32,
    minimum_working_set: usize,
    maximum_working_set: usize,
    active_processes: u32,
    affinity: usize,
    priority: u32,
    scheduling: u32,
}
#[repr(C)]
#[derive(Default)]
struct ExtendedLimits {
    basic: BasicLimits,
    io_counters: [u64; 6],
    process_memory: usize,
    job_memory: usize,
    peak_process_memory: usize,
    peak_job_memory: usize,
}
#[repr(C)]
#[derive(Default)]
struct FileInformation {
    attributes: u32,
    created: [u32; 2],
    accessed: [u32; 2],
    written: [u32; 2],
    volume: u32,
    size_high: u32,
    size_low: u32,
    links: u32,
    index_high: u32,
    index_low: u32,
}
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

#[link(name = "userenv", kind = "raw-dylib")]
unsafe extern "system" {
    fn CreateAppContainerProfile(
        name: *const u16,
        display: *const u16,
        description: *const u16,
        capabilities: *const c_void,
        count: u32,
        sid: *mut Sid,
    ) -> i32;
    fn DeriveAppContainerSidFromAppContainerName(name: *const u16, sid: *mut Sid) -> i32;
    fn DeleteAppContainerProfile(name: *const u16) -> i32;
    fn GetUserProfileDirectoryW(token: Handle, directory: *mut u16, size: *mut u32) -> i32;
}
// Other modules declare some of these with their own struct types.
#[allow(clashing_extern_declarations)]
#[link(name = "advapi32", kind = "raw-dylib")]
unsafe extern "system" {
    fn FreeSid(sid: Sid) -> *mut c_void;
    fn GetLengthSid(sid: Sid) -> u32;
    fn EqualSid(first: *const c_void, second: *const c_void) -> i32;
    fn GetKernelObjectSecurity(
        handle: Handle,
        information: u32,
        descriptor: *mut c_void,
        length: u32,
        needed: *mut u32,
    ) -> i32;
    fn SetKernelObjectSecurity(handle: Handle, information: u32, descriptor: *const c_void) -> i32;
    fn GetSecurityDescriptorDacl(
        descriptor: *const c_void,
        present: *mut i32,
        dacl: *mut *mut c_void,
        defaulted: *mut i32,
    ) -> i32;
    fn GetSecurityDescriptorControl(
        descriptor: *const c_void,
        control: *mut u16,
        revision: *mut u32,
    ) -> i32;
    fn InitializeSecurityDescriptor(descriptor: *mut c_void, revision: u32) -> i32;
    fn SetSecurityDescriptorDacl(
        descriptor: *mut c_void,
        present: i32,
        dacl: *const c_void,
        defaulted: i32,
    ) -> i32;
    fn SetSecurityDescriptorControl(descriptor: *mut c_void, mask: u16, bits: u16) -> i32;
    fn InitializeAcl(acl: *mut c_void, length: u32, revision: u32) -> i32;
    fn GetAclInformation(
        acl: *const c_void,
        information: *mut c_void,
        length: u32,
        class: u32,
    ) -> i32;
    fn GetAce(acl: *const c_void, index: u32, ace: *mut *mut c_void) -> i32;
    fn AddAce(acl: *mut c_void, revision: u32, index: u32, ace: *const c_void, length: u32) -> i32;
    fn AddAccessAllowedAceEx(
        acl: *mut c_void,
        revision: u32,
        flags: u32,
        mask: u32,
        sid: Sid,
    ) -> i32;
    fn AddAccessDeniedAceEx(
        acl: *mut c_void,
        revision: u32,
        flags: u32,
        mask: u32,
        sid: Sid,
    ) -> i32;
    fn ConvertSidToStringSidW(sid: Sid, text: *mut *mut u16) -> i32;
    fn OpenProcessToken(process: Handle, access: u32, token: *mut Handle) -> i32;
}
// Other modules declare some of these with their own struct types.
#[allow(clashing_extern_declarations)]
#[link(name = "kernel32", kind = "raw-dylib")]
unsafe extern "system" {
    fn LocalFree(memory: *mut c_void) -> *mut c_void;
    fn CreateFileW(
        name: *const u16,
        access: u32,
        share: u32,
        security: *mut c_void,
        disposition: u32,
        flags: u32,
        template: Handle,
    ) -> Handle;
    fn GetFileInformationByHandle(handle: Handle, information: *mut FileInformation) -> i32;
    fn GetFileInformationByHandleEx(
        handle: Handle,
        class: u32,
        buffer: *mut c_void,
        length: u32,
    ) -> i32;
    fn InitializeProcThreadAttributeList(
        list: *mut c_void,
        count: u32,
        flags: u32,
        size: *mut usize,
    ) -> i32;
    fn UpdateProcThreadAttribute(
        list: *mut c_void,
        flags: u32,
        attribute: usize,
        value: *const c_void,
        size: usize,
        previous: *mut c_void,
        returned: *mut usize,
    ) -> i32;
    fn DeleteProcThreadAttributeList(list: *mut c_void);
    fn CreateProcessW(
        application: *const u16,
        command: *mut u16,
        process_security: *mut c_void,
        thread_security: *mut c_void,
        inherit: i32,
        flags: u32,
        environment: *const c_void,
        directory: *const u16,
        startup: *const StartupInfoEx,
        information: *mut ProcessInformation,
    ) -> i32;
    fn ResumeThread(thread: Handle) -> u32;
    fn TerminateProcess(process: Handle, code: u32) -> i32;
    fn CreateJobObjectW(security: *mut c_void, name: *const u16) -> Handle;
    fn SetInformationJobObject(
        job: Handle,
        class: u32,
        information: *const c_void,
        length: u32,
    ) -> i32;
    fn AssignProcessToJobObject(job: Handle, process: Handle) -> i32;
    fn WaitForSingleObject(handle: Handle, milliseconds: u32) -> u32;
    fn GetExitCodeProcess(process: Handle, code: *mut u32) -> i32;
    fn GetStdHandle(which: u32) -> Handle;
    fn GetCurrentProcess() -> Handle;
    fn DuplicateHandle(
        source_process: Handle,
        source: Handle,
        target_process: Handle,
        target: *mut Handle,
        access: u32,
        inherit: i32,
        options: u32,
    ) -> i32;
}
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
    fn RtlNtStatusToDosError(status: i32) -> u32;
}

const ACL_REVISION: u32 = 2;
const DACL_SECURITY_INFORMATION: u32 = 4;
const SE_DACL_AUTO_INHERITED: u16 = 0x0400;
const SE_DACL_PROTECTED: u16 = 0x1000;
const ALLOWED: u8 = 0;
const DENIED: u8 = 1;
const OBJECT_INHERIT: u8 = 0x1;
const CONTAINER_INHERIT: u8 = 0x2;
const INHERITED: u8 = 0x10;
const READ_CONTROL: u32 = 0x0002_0000;
const WRITE_DAC: u32 = 0x0004_0000;
const SYNCHRONIZE: u32 = 0x0010_0000;
const LIST_DIRECTORY: u32 = 0x0001;
const READ_ATTRIBUTES: u32 = 0x0080;
/// Read, list, traverse and execute.
pub const READ: u32 = 0x0012_00A9;
/// READ plus create, write, delete and delete children; never WRITE_DAC or WRITE_OWNER.
pub const MODIFY: u32 = 0x0013_01BF;
/// Every right that changes an object, without READ_CONTROL or SYNCHRONIZE,
/// which reads share.
pub const DENY_WRITE: u32 = 0x000D_0156;
pub const DENY_ALL: u32 = 0x001F_01FF;
const FILE_ATTRIBUTE_DIRECTORY: u32 = 0x10;
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
const SHARE_ALL: u32 = 0x7;
const OPEN_EXISTING: u32 = 3;
const FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
const FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
const FILE_OPEN: u32 = 1;
const OPTION_SYNCHRONOUS: u32 = 0x20;
const OPTION_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
const OPTION_OPEN_FOR_BACKUP: u32 = 0x4000;
const OBJ_CASE_INSENSITIVE: u32 = 0x40;
const FULL_DIRECTORY_INFO: u32 = 0xE;
const FULL_DIRECTORY_RESTART_INFO: u32 = 0xF;
const ERROR_NO_MORE_FILES: i32 = 18;
const ALREADY_EXISTS: i32 = 0x8007_00B7_u32 as i32;
const SECURITY_CAPABILITIES_ATTRIBUTE: usize = 0x0002_0009;
const HANDLE_LIST_ATTRIBUTE: usize = 0x0002_0002;
const EXTENDED_STARTUPINFO_PRESENT: u32 = 0x0008_0000;
const CREATE_SUSPENDED: u32 = 0x4;
const CREATE_UNICODE_ENVIRONMENT: u32 = 0x400;
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const STARTF_USESTDHANDLES: u32 = 0x100;
const EXTENDED_LIMITS: u32 = 9;
const KILL_ON_JOB_CLOSE: u32 = 0x2000;
const DIE_ON_UNHANDLED_EXCEPTION: u32 = 0x400;
const ACTIVE_PROCESS: u32 = 0x8;
const INFINITE: u32 = 0xFFFF_FFFF;
const WAIT_OBJECT_0: u32 = 0;
const WAIT_TIMEOUT: u32 = 0x102;
const DUPLICATE_SAME_ACCESS: u32 = 2;
const TOKEN_QUERY: u32 = 0x8;
const GENERIC_READ: u32 = 0x8000_0000;
const GENERIC_WRITE: u32 = 0x4000_0000;
/// A job's limit counts one command's tree, so it is the Unix headroom alone.
const PROCESS_LIMIT: u32 = 512;
/// The exit code when the program never ran, as a shell exits for a command it cannot run.
const NOT_RUN: i32 = 126;
const USAGE: &str = "sandbox expects exec <policy> -- <program> [arguments...] or reset";

fn wide(value: &OsStr) -> Vec<u16> {
    value.encode_wide().chain(Some(0)).collect()
}
fn check(ok: i32) -> io::Result<()> {
    if ok == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}
fn owned(handle: Handle) -> io::Result<OwnedHandle> {
    if handle.is_null() || handle as isize == -1 {
        Err(io::Error::last_os_error())
    } else {
        // SAFETY: a valid handle returned to this process, owned from here on.
        Ok(unsafe { OwnedHandle::from_raw_handle(handle) })
    }
}

fn refused(message: String) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}

/// An AppContainer SID, freed on drop.
pub struct ContainerSid(Sid);
impl ContainerSid {
    fn as_ptr(&self) -> Sid {
        self.0
    }
    pub fn text(&self) -> io::Result<String> {
        let mut text = ptr::null_mut();
        // SAFETY: a valid SID; the returned string is freed below.
        check(unsafe { ConvertSidToStringSidW(self.0, &mut text) })?;
        let mut length = 0;
        // SAFETY: a NUL-terminated string from ConvertSidToStringSidW.
        while unsafe { *text.add(length) } != 0 {
            length += 1;
        }
        // SAFETY: `length` UTF-16 units before the terminator.
        let value = String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(text, length) });
        // SAFETY: allocated by ConvertSidToStringSidW.
        unsafe { LocalFree(text.cast()) };
        Ok(value)
    }
}
impl Drop for ContainerSid {
    fn drop(&mut self) {
        // SAFETY: allocated by the AppContainer API.
        unsafe { FreeSid(self.0) };
    }
}

fn hresult(result: i32) -> io::Error {
    io::Error::from_raw_os_error(result & 0xFFFF)
}

/// Create the profile `name`, or return the existing one's SID.
fn create_profile(name: &str) -> io::Result<ContainerSid> {
    let name = wide(OsStr::new(name));
    let display = wide(OsStr::new("Hexbot sandbox"));
    let mut sid = ptr::null_mut();
    // SAFETY: NUL-terminated names, no capabilities, an out pointer.
    let result = unsafe {
        CreateAppContainerProfile(
            name.as_ptr(),
            display.as_ptr(),
            display.as_ptr(),
            ptr::null(),
            0,
            &mut sid,
        )
    };
    if result == ALREADY_EXISTS {
        // SAFETY: as above.
        let result = unsafe { DeriveAppContainerSidFromAppContainerName(name.as_ptr(), &mut sid) };
        if result < 0 {
            return Err(hresult(result));
        }
    } else if result < 0 {
        return Err(hresult(result));
    }
    Ok(ContainerSid(sid))
}

/// The SID of the profile `name`, which need not exist: it derives from the name.
pub fn profile_sid(name: &str) -> io::Result<ContainerSid> {
    let name = wide(OsStr::new(name));
    let mut sid = ptr::null_mut();
    // SAFETY: a NUL-terminated name and an out pointer.
    let result = unsafe { DeriveAppContainerSidFromAppContainerName(name.as_ptr(), &mut sid) };
    if result < 0 {
        return Err(hresult(result));
    }
    Ok(ContainerSid(sid))
}

/// Delete the profile `name`. A missing profile is fine.
fn delete_profile(name: &str) -> io::Result<()> {
    let name = wide(OsStr::new(name));
    // SAFETY: a NUL-terminated name.
    let result = unsafe { DeleteAppContainerProfile(name.as_ptr()) };
    if result < 0 && result & 0xFFFF != 2 {
        return Err(hresult(result));
    }
    Ok(())
}

/// What one walk does to every entry it reaches.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Change {
    Allow(u32),
    Deny(u32),
    /// Remove every entry for the SIDs, allow or deny, explicit or inherited.
    Revoke,
}

/// What a walk changed and what it left alone.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Walk {
    pub changed: usize,
    pub unchanged: usize,
    /// Reparse points and files with several hard links: never changed or entered.
    pub skipped_links: usize,
    /// Entries Hexbot cannot open or change. A grant leaves them inaccessible.
    pub failed: usize,
}

fn descriptor(handle: Handle) -> io::Result<Vec<u8>> {
    let mut needed = 0;
    // SAFETY: a size query.
    unsafe {
        GetKernelObjectSecurity(
            handle,
            DACL_SECURITY_INFORMATION,
            ptr::null_mut(),
            0,
            &mut needed,
        )
    };
    if needed == 0 {
        return Err(io::Error::last_os_error());
    }
    let mut buffer = vec![0u8; needed as usize];
    // SAFETY: a buffer of the queried size.
    check(unsafe {
        GetKernelObjectSecurity(
            handle,
            DACL_SECURITY_INFORMATION,
            buffer.as_mut_ptr().cast(),
            needed,
            &mut needed,
        )
    })?;
    Ok(buffer)
}

struct Ace {
    kind: u8,
    flags: u8,
    mask: u32,
    bytes: Vec<u8>,
    ours: bool,
}

/// The entries of a DACL, marking those for one of `sids`.
fn entries(dacl: *mut c_void, sids: &[Sid]) -> io::Result<Vec<Ace>> {
    if dacl.is_null() {
        return Ok(Vec::new());
    }
    let mut size = AclSize {
        count: 0,
        used: 0,
        free: 0,
    };
    // SAFETY: a valid ACL and an AclSizeInformation buffer.
    check(unsafe { GetAclInformation(dacl, (&mut size as *mut AclSize).cast(), 12, 2) })?;
    let mut list = Vec::with_capacity(size.count as usize);
    for index in 0..size.count {
        let mut ace = ptr::null_mut();
        // SAFETY: index is below the ACL's count.
        check(unsafe { GetAce(dacl, index, &mut ace) })?;
        // SAFETY: GetAce returns a pointer to a header inside the ACL.
        let header = unsafe { &*(ace as *const AceHeader) };
        // SAFETY: the ACE occupies header.size bytes.
        let bytes =
            unsafe { std::slice::from_raw_parts(ace as *const u8, header.size as usize) }.to_vec();
        let simple = header.kind == ALLOWED || header.kind == DENIED;
        let mask = if bytes.len() >= 8 {
            u32::from_le_bytes([bytes[4], bytes[5], bytes[6], bytes[7]])
        } else {
            0
        };
        let ours = simple
            && bytes.len() > 8
            // SAFETY: allowed and denied ACEs carry their SID at offset 8.
            && sids
                .iter()
                .any(|sid| unsafe { EqualSid((ace as *mut u8).add(8).cast(), *sid) } != 0);
        list.push(Ace {
            kind: header.kind,
            flags: header.flags,
            mask,
            bytes,
            ours,
        });
    }
    Ok(list)
}

/// Apply `change` for `sids` to one object. `explicit` marks the root of a walk;
/// below it entries carry INHERITED, as the system's own propagation writes them.
fn change_object(
    handle: Handle,
    directory: bool,
    change: Change,
    explicit: bool,
    sids: &[Sid],
) -> io::Result<bool> {
    let original = descriptor(handle)?;
    let mut present = 0;
    let mut dacl = ptr::null_mut();
    let mut defaulted = 0;
    // SAFETY: a self-relative descriptor read above.
    check(unsafe {
        GetSecurityDescriptorDacl(
            original.as_ptr().cast(),
            &mut present,
            &mut dacl,
            &mut defaulted,
        )
    })?;
    if present == 0 || dacl.is_null() {
        // A NULL DACL grants everyone everything; Hexbot does not restrict it.
        return Ok(false);
    }
    let mut control = 0;
    let mut revision = 0;
    // SAFETY: as above.
    check(unsafe {
        GetSecurityDescriptorControl(original.as_ptr().cast(), &mut control, &mut revision)
    })?;
    let existing = entries(dacl, sids)?;
    let inherit = if directory {
        OBJECT_INHERIT | CONTAINER_INHERIT
    } else {
        0
    };
    let flags = inherit | if explicit { 0 } else { INHERITED };
    let wanted = match change {
        Change::Allow(mask) => Some((ALLOWED, mask)),
        Change::Deny(mask) => Some((DENIED, mask)),
        Change::Revoke => None,
    };
    if let Some((kind, mask)) = wanted {
        if existing
            .iter()
            .any(|ace| ace.ours && ace.kind == kind && ace.mask == mask && ace.flags == flags)
        {
            return Ok(false);
        }
    } else if !existing.iter().any(|ace| ace.ours) {
        return Ok(false);
    }
    // Canonical order: explicit deny, explicit allow, then inherited entries.
    // An explicit deny goes first, an explicit allow and an inherited deny at the
    // start of the inherited section, an inherited allow last. A grant replaces
    // this object's earlier entries for the SIDs of the same kind.
    let kept: Vec<&Ace> = existing
        .iter()
        .filter(|ace| match wanted {
            None => !ace.ours,
            Some((kind, _)) => {
                !(ace.ours && ace.kind == kind && (ace.flags & INHERITED) == (flags & INHERITED))
            }
        })
        .collect();
    let first_inherited = kept
        .iter()
        .position(|ace| ace.flags & INHERITED != 0)
        .unwrap_or(kept.len());
    let position = match wanted {
        None => kept.len(),
        Some((DENIED, _)) if explicit => 0,
        Some((ALLOWED, _)) if !explicit => kept.len(),
        Some(_) => first_inherited,
    };
    let sid_bytes: u32 = sids
        .iter()
        .map(|sid| unsafe { GetLengthSid(*sid) } + 8)
        .sum();
    let length = 8
        + kept.iter().map(|ace| ace.bytes.len() as u32).sum::<u32>()
        + if wanted.is_some() { sid_bytes } else { 0 };
    let length = (length + 3) & !3;
    let mut acl = vec![0u8; length as usize];
    // SAFETY: a buffer of `length` bytes.
    check(unsafe { InitializeAcl(acl.as_mut_ptr().cast(), length, ACL_REVISION) })?;
    let add_ours = |acl: &mut Vec<u8>| -> io::Result<()> {
        if let Some((kind, mask)) = wanted {
            for sid in sids {
                // SAFETY: the ACL was sized for these entries.
                check(unsafe {
                    if kind == ALLOWED {
                        AddAccessAllowedAceEx(
                            acl.as_mut_ptr().cast(),
                            ACL_REVISION,
                            flags as u32,
                            mask,
                            *sid,
                        )
                    } else {
                        AddAccessDeniedAceEx(
                            acl.as_mut_ptr().cast(),
                            ACL_REVISION,
                            flags as u32,
                            mask,
                            *sid,
                        )
                    }
                })?;
            }
        }
        Ok(())
    };
    for (index, ace) in kept.iter().enumerate() {
        if index == position {
            add_ours(&mut acl)?;
        }
        // SAFETY: an ACE copied from the original DACL; appended at the end.
        check(unsafe {
            AddAce(
                acl.as_mut_ptr().cast(),
                ACL_REVISION,
                u32::MAX,
                ace.bytes.as_ptr().cast(),
                ace.bytes.len() as u32,
            )
        })?;
    }
    if position == kept.len() {
        add_ours(&mut acl)?;
    }
    let mut descriptor = [0u8; 64];
    // SAFETY: an absolute descriptor in a buffer larger than SECURITY_DESCRIPTOR_MIN_LENGTH.
    check(unsafe { InitializeSecurityDescriptor(descriptor.as_mut_ptr().cast(), 1) })?;
    // SAFETY: the ACL outlives the descriptor's use below.
    check(unsafe {
        SetSecurityDescriptorDacl(descriptor.as_mut_ptr().cast(), 1, acl.as_ptr().cast(), 0)
    })?;
    let bits = control & (SE_DACL_AUTO_INHERITED | SE_DACL_PROTECTED);
    // SAFETY: only the DACL inheritance bits, copied from the original.
    check(unsafe {
        SetSecurityDescriptorControl(
            descriptor.as_mut_ptr().cast(),
            SE_DACL_AUTO_INHERITED | SE_DACL_PROTECTED,
            bits,
        )
    })?;
    // SetKernelObjectSecurity changes this object only. The walk propagates.
    // SAFETY: a valid handle opened with WRITE_DAC and a valid descriptor.
    check(unsafe {
        SetKernelObjectSecurity(
            handle,
            DACL_SECURITY_INFORMATION,
            descriptor.as_ptr().cast(),
        )
    })?;
    Ok(true)
}

fn information(handle: Handle) -> io::Result<FileInformation> {
    let mut info = FileInformation::default();
    // SAFETY: a valid handle and an output struct.
    check(unsafe { GetFileInformationByHandle(handle, &mut info) })?;
    Ok(info)
}

/// Open a root by path without following a final reparse point.
fn open_root(path: &Path) -> io::Result<OwnedHandle> {
    let name = wide(path.as_os_str());
    // SAFETY: a NUL-terminated path; the handle is owned below.
    owned(unsafe {
        CreateFileW(
            name.as_ptr(),
            READ_CONTROL | WRITE_DAC | LIST_DIRECTORY | READ_ATTRIBUTES | SYNCHRONIZE,
            SHARE_ALL,
            ptr::null_mut(),
            OPEN_EXISTING,
            FLAG_BACKUP_SEMANTICS | FLAG_OPEN_REPARSE_POINT,
            ptr::null_mut(),
        )
    })
}

/// Open `name` inside `parent` through the parent's handle, never by path.
fn open_child(parent: Handle, name: &[u16]) -> io::Result<OwnedHandle> {
    let text = UnicodeString {
        length: (name.len() * 2) as u16,
        maximum: (name.len() * 2) as u16,
        buffer: name.as_ptr(),
    };
    let attributes = ObjectAttributes {
        length: mem::size_of::<ObjectAttributes>() as u32,
        root: parent,
        name: &text,
        attributes: OBJ_CASE_INSENSITIVE,
        descriptor: ptr::null_mut(),
        quality: ptr::null_mut(),
    };
    let mut status = IoStatus::default();
    let mut handle = ptr::null_mut();
    let mut open = |access: u32| {
        // SAFETY: valid attributes naming one component relative to `parent`.
        unsafe {
            NtCreateFile(
                &mut handle,
                access,
                &attributes,
                &mut status,
                ptr::null(),
                0,
                SHARE_ALL,
                FILE_OPEN,
                OPTION_SYNCHRONOUS | OPTION_OPEN_REPARSE_POINT | OPTION_OPEN_FOR_BACKUP,
                ptr::null(),
                0,
            )
        }
    };
    let base = READ_CONTROL | WRITE_DAC | READ_ATTRIBUTES | SYNCHRONIZE;
    let mut result = open(base | LIST_DIRECTORY);
    if result < 0 {
        // Files the user cannot read are still granted; they just are not listed.
        result = open(base);
    }
    if result < 0 {
        // SAFETY: converts an NTSTATUS to a Win32 code.
        return Err(io::Error::from_raw_os_error(
            unsafe { RtlNtStatusToDosError(result) } as i32,
        ));
    }
    owned(handle)
}

/// The names in a directory, read through its handle.
fn names(directory: Handle) -> io::Result<Vec<Vec<u16>>> {
    let mut list = Vec::new();
    let mut buffer = vec![0u64; 8192];
    let mut class = FULL_DIRECTORY_RESTART_INFO;
    loop {
        // SAFETY: a synchronous directory handle and an aligned buffer.
        let ok = unsafe {
            GetFileInformationByHandleEx(
                directory,
                class,
                buffer.as_mut_ptr().cast(),
                (buffer.len() * 8) as u32,
            )
        };
        if ok == 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(ERROR_NO_MORE_FILES) {
                return Ok(list);
            }
            return Err(error);
        }
        class = FULL_DIRECTORY_INFO;
        let bytes = buffer.as_ptr() as *const u8;
        let mut offset = 0usize;
        loop {
            // SAFETY: FILE_FULL_DIR_INFO records inside the filled buffer.
            let (next, length) = unsafe {
                (
                    ptr::read_unaligned(bytes.add(offset) as *const u32) as usize,
                    ptr::read_unaligned(bytes.add(offset + 60) as *const u32) as usize,
                )
            };
            // SAFETY: the name follows the fixed 68-byte header.
            let name: Vec<u16> = (0..length / 2)
                .map(|i| unsafe {
                    ptr::read_unaligned(bytes.add(offset + 68 + i * 2) as *const u16)
                })
                .collect();
            if name != [b'.' as u16] && name != [b'.' as u16, b'.' as u16] {
                list.push(name);
            }
            if next == 0 {
                break;
            }
            offset += next;
        }
    }
}

/// Apply `change` to `root` and everything below it, through handles.
pub fn walk(root: &Path, change: Change, sids: &[&ContainerSid]) -> io::Result<Walk> {
    let sids: Vec<Sid> = sids.iter().map(|sid| sid.as_ptr()).collect();
    let root = open_root(root)?;
    let info = information(root.as_raw_handle())?;
    if info.attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Sandbox roots cannot be links or junctions",
        ));
    }
    let directory = info.attributes & FILE_ATTRIBUTE_DIRECTORY != 0;
    if !directory && info.links > 1 && change != Change::Revoke {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Sandbox roots cannot have several hard links",
        ));
    }
    let mut walk = Walk::default();
    if change_object(root.as_raw_handle(), directory, change, true, &sids)? {
        walk.changed += 1;
    } else {
        walk.unchanged += 1;
    }
    if !directory {
        return Ok(walk);
    }
    let mut stack = vec![root];
    while let Some(parent) = stack.pop() {
        let listed = match names(parent.as_raw_handle()) {
            Ok(listed) => listed,
            Err(_) => {
                walk.failed += 1;
                continue;
            }
        };
        for name in listed {
            let Ok(child) = open_child(parent.as_raw_handle(), &name) else {
                walk.failed += 1;
                continue;
            };
            let Ok(info) = information(child.as_raw_handle()) else {
                walk.failed += 1;
                continue;
            };
            let directory = info.attributes & FILE_ATTRIBUTE_DIRECTORY != 0;
            if info.attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 || (!directory && info.links > 1)
            {
                // Revoking still cleans a file that gained a second name later.
                if change == Change::Revoke && info.attributes & FILE_ATTRIBUTE_REPARSE_POINT == 0 {
                    let _ = change_object(child.as_raw_handle(), false, change, false, &sids);
                }
                walk.skipped_links += 1;
                continue;
            }
            match change_object(child.as_raw_handle(), directory, change, false, &sids) {
                Ok(true) => walk.changed += 1,
                Ok(false) => walk.unchanged += 1,
                Err(_) => {
                    walk.failed += 1;
                    continue;
                }
            }
            if directory {
                stack.push(child);
            }
        }
    }
    Ok(walk)
}

/// Whether `root` already carries the explicit entry `change` would write.
pub fn applied(root: &Path, change: Change, sid: &ContainerSid) -> io::Result<bool> {
    let handle = open_root(root)?;
    let info = information(handle.as_raw_handle())?;
    let directory = info.attributes & FILE_ATTRIBUTE_DIRECTORY != 0;
    let original = descriptor(handle.as_raw_handle())?;
    let (mut present, mut dacl, mut defaulted) = (0, ptr::null_mut(), 0);
    // SAFETY: a descriptor read above.
    check(unsafe {
        GetSecurityDescriptorDacl(
            original.as_ptr().cast(),
            &mut present,
            &mut dacl,
            &mut defaulted,
        )
    })?;
    let flags = if directory {
        OBJECT_INHERIT | CONTAINER_INHERIT
    } else {
        0
    };
    let (kind, mask) = match change {
        Change::Allow(mask) => (ALLOWED, mask),
        Change::Deny(mask) => (DENIED, mask),
        Change::Revoke => return Ok(!entries(dacl, &[sid.as_ptr()])?.iter().any(|ace| ace.ours)),
    };
    Ok(entries(dacl, &[sid.as_ptr()])?
        .iter()
        .any(|ace| ace.ours && ace.kind == kind && ace.mask == mask && ace.flags == flags))
}

impl GrantKind {
    pub fn change(self) -> Change {
        match self {
            Self::Read => Change::Allow(READ),
            Self::Modify => Change::Allow(MODIFY),
            Self::DenyWrite => Change::Deny(DENY_WRITE),
            Self::DenyAll => Change::Deny(DENY_ALL),
        }
    }
}

pub fn sandbox_dir(home: &Path) -> PathBuf {
    // Native separators: programs such as cmd.exe parse the paths they are given.
    home.join("runtime").join("sandbox")
}
fn journal_path(home: &Path) -> PathBuf {
    sandbox_dir(home).join("grants.json")
}
fn read_journal(home: &Path) -> io::Result<Journal> {
    match fs::read(journal_path(home)) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(io::Error::other),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Journal::default()),
        Err(error) => Err(error),
    }
}
fn write_journal(home: &Path, journal: &Journal) -> io::Result<()> {
    crate::common::atomic_write(
        &journal_path(home),
        &serde_json::to_vec_pretty(journal).map_err(io::Error::other)?,
    )
    .map_err(|error| io::Error::other(error.to_string()))
}

/// The cross-process lock every grant change holds.
pub fn lock(home: &Path) -> io::Result<fs::File> {
    fs::create_dir_all(sandbox_dir(home))?;
    let file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(sandbox_dir(home).join("grants.lock"))?;
    file.lock()?;
    Ok(file)
}

/// Make sure `path` carries `kind` for `profile`, walking it only when the
/// journal has no finished grant or the root lost its entry. A deny walk that
/// misses an entry fails: that entry keeps the allow it inherited from above,
/// so the command must not start.
fn ensure(
    home: &Path,
    journal: &mut Journal,
    path: &Path,
    profile: &str,
    kind: GrantKind,
    sid: &ContainerSid,
) -> io::Result<()> {
    let index = journal
        .roots
        .iter()
        .position(|root| root.path == path && root.profile == profile && root.kind == kind);
    if let Some(index) = index
        && journal.roots[index].complete
        && applied(path, kind.change(), sid)?
    {
        return Ok(());
    }
    let index = index.unwrap_or_else(|| {
        journal.roots.push(JournalEntry {
            path: path.to_owned(),
            profile: profile.to_owned(),
            kind,
            complete: false,
        });
        journal.roots.len() - 1
    });
    journal.roots[index].complete = false;
    write_journal(home, journal)?;
    let walk = walk(path, kind.change(), &[sid])?;
    if kind.denies() && walk.failed > 0 {
        // Left unfinished: the next command walks it again, and reset revokes it.
        return Err(io::Error::other(format!(
            "Could not protect {} entries under {}",
            walk.failed,
            path.display()
        )));
    }
    journal.roots[index].complete = true;
    write_journal(home, journal)
}

/// Remove every entry for the journaled profiles' SIDs from every journaled
/// root, then delete each profile no remaining root names: once every root
/// is revoked, every profile. Roots that no longer exist are dropped.
pub fn reset(home: &Path) -> io::Result<Walk> {
    let _lock = lock(home)?;
    let mut journal = read_journal(home)?;
    let mut paths: Vec<PathBuf> = Vec::new();
    for root in &journal.roots {
        if !paths.contains(&root.path) {
            paths.push(root.path.clone());
        }
    }
    let mut total = Walk::default();
    let mut left = Vec::new();
    for path in paths {
        // One walk per root, for every profile it was granted to.
        let granted: Vec<JournalEntry> = journal
            .roots
            .iter()
            .filter(|root| root.path == path)
            .cloned()
            .collect();
        let revoked = granted
            .iter()
            .map(|root| profile_sid(&root.profile))
            .collect::<io::Result<Vec<_>>>()
            .and_then(|sids| walk(&path, Change::Revoke, &sids.iter().collect::<Vec<_>>()));
        match revoked {
            Ok(walk) => {
                total.changed += walk.changed;
                total.unchanged += walk.unchanged;
                total.skipped_links += walk.skipped_links;
                total.failed += walk.failed;
                if walk.failed > 0 {
                    left.extend(granted);
                }
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(_) => left.extend(granted),
        }
    }
    journal.roots = left;
    let roots = &journal.roots;
    let mut failure = None;
    journal.profiles.retain(|profile| {
        roots.iter().any(|root| &root.profile == profile)
            || delete_profile(profile)
                .map_err(|error| failure.get_or_insert(error))
                .is_err()
    });
    write_journal(home, &journal)?;
    failure.map_or(Ok(total), Err)
}

/// A policy's container, granted and ready for commands.
pub struct Container {
    pub sid: ContainerSid,
    /// The profile reset deletes.
    pub profile: String,
    /// Its private home and temp folder, in the plain form programs are given.
    pub private: PathBuf,
}

/// Folders of the user's profile that hold its credential stores. A root may
/// sit inside them, never be or contain them.
const PROFILE_FOLDERS: [&str; 4] = [
    "AppData",
    r"AppData\Roaming",
    r"AppData\Local",
    r"AppData\LocalLow",
];

/// `path` in plain form. Network, device and stream paths are refused.
fn plain(path: &Path) -> io::Result<String> {
    let text = path.to_str().ok_or_else(|| {
        refused(format!(
            "Sandbox paths must be valid Unicode: {}",
            path.display()
        ))
    })?;
    rules::simplify(text).map_err(|reason| refused(format!("{reason}: {}", path.display())))
}

/// Plain, folded forms of `path`, as given and resolved, each once. A path
/// that is not a plain disk path has none and is never opened.
fn forms(path: &Path) -> Vec<String> {
    let Ok(given) = plain(path) else {
        return Vec::new();
    };
    let mut forms = vec![rules::fold(&given)];
    if let Ok(real) = fs::canonicalize(path).and_then(|real| plain(&real)) {
        let real = rules::fold(&real);
        if !forms.contains(&real) {
            forms.push(real);
        }
    }
    forms
}
fn add_forms(list: &mut Vec<String>, path: &Path) {
    for form in forms(path) {
        if !list.contains(&form) {
            list.push(form);
        }
    }
}

/// The user's profile folder, from the OS rather than the environment.
fn profile_directory() -> io::Result<PathBuf> {
    let mut token = ptr::null_mut();
    // SAFETY: this process's pseudo-handle and an out pointer; the token is owned below.
    check(unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) })?;
    let token = owned(token)?;
    let mut size = 0;
    // SAFETY: a size query.
    unsafe { GetUserProfileDirectoryW(token.as_raw_handle(), ptr::null_mut(), &mut size) };
    if size == 0 {
        return Err(io::Error::last_os_error());
    }
    let mut buffer = vec![0u16; size as usize];
    // SAFETY: a buffer of the queried size.
    check(unsafe {
        GetUserProfileDirectoryW(token.as_raw_handle(), buffer.as_mut_ptr(), &mut size)
    })?;
    let length = buffer
        .iter()
        .position(|&unit| unit == 0)
        .unwrap_or(buffer.len());
    Ok(path_from_wide(&buffer[..length]))
}

/// What no root may reach. The user's profile comes from the OS and from every
/// variable that names it, so a cleared or changed environment only adds to it.
fn protected(home: &Path) -> io::Result<Protected> {
    let (stores, runtime) = rules::policy_paths();
    let variable = |name| {
        std::env::var_os(name)
            .filter(|value: &OsString| !value.is_empty())
            .map(PathBuf::from)
    };
    let users: Vec<PathBuf> = std::iter::once(profile_directory()?)
        .chain(["USERPROFILE", "HOME"].into_iter().filter_map(variable))
        .collect();
    let mut protected = Protected::default();
    for folder in ["APPDATA", "LOCALAPPDATA"].into_iter().filter_map(variable) {
        add_forms(&mut protected.homes, &folder);
    }
    for user in &users {
        add_forms(&mut protected.homes, user);
        for folder in PROFILE_FOLDERS {
            add_forms(&mut protected.homes, &user.join(folder));
        }
        for store in &stores {
            add_forms(&mut protected.stores, &user.join(store));
        }
    }
    add_forms(&mut protected.homes, home);
    add_forms(&mut protected.stores, &sandbox_dir(home));
    for local in &runtime {
        add_forms(&mut protected.runtime, &home.join(local));
    }
    Ok(protected)
}

/// A policy root as walks open it (canonical) and checks compare it (plain
/// and folded).
struct Root {
    canonical: PathBuf,
    folded: String,
}

/// `path` as a root, or None when it does not exist. Its form is checked
/// before any file system call, so a network root is never opened.
fn root(path: &Path) -> io::Result<Option<Root>> {
    plain(path)?;
    let canonical = match fs::canonicalize(path) {
        Ok(canonical) => canonical,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    let folded = rules::fold(&plain(&canonical)?);
    Ok(Some(Root { canonical, folded }))
}

/// The policy's Hexbot home in plain form. It must exist, so a mistyped home
/// never gains a journal of its own.
fn hexbot_home(policy: &Policy) -> io::Result<PathBuf> {
    if policy.home.as_os_str().is_empty() {
        return Err(refused("The sandbox policy names no Hexbot home".into()));
    }
    plain(&policy.home)?;
    Ok(PathBuf::from(plain(&fs::canonicalize(&policy.home)?)?))
}

/// Grant `policy` to its own container, created if need be. Every root is
/// checked before a profile, journal entry or ACL changes.
pub fn prepare(policy: &Policy) -> io::Result<Container> {
    let home = hexbot_home(policy)?;
    let access = policy.access.unwrap_or(Access::Workspace);
    let protected = protected(&home)?;
    let allowed = |path: &Path, writable: bool| -> io::Result<Option<Root>> {
        let Some(root) = root(path)? else {
            return Ok(None);
        };
        match protected.refusal(&root.folded, writable) {
            Some(reason) => Err(refused(format!("{reason}: {}", path.display()))),
            None => Ok(Some(root)),
        }
    };
    let mut writable = Vec::new();
    for path in &policy.writable {
        writable.push(allowed(path, true)?.ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::NotFound,
                format!("A writable sandbox root is missing: {}", path.display()),
            )
        })?);
    }
    // A runtime folder that is not installed is simply not granted.
    let mut readable = Vec::new();
    for path in &policy.readable {
        readable.extend(allowed(path, false)?);
    }
    let denied = |paths: &[PathBuf]| -> io::Result<Vec<Root>> {
        paths
            .iter()
            .filter_map(|path| root(path).transpose())
            .collect()
    };
    let (deny_write, deny_all) = (denied(&policy.deny_write)?, denied(&policy.deny_all)?);
    let folded = |roots: &[Root]| {
        roots
            .iter()
            .map(|root| root.folded.clone())
            .collect::<Vec<_>>()
    };
    let digest = rules::roots_digest(&folded(&writable), &folded(&readable));
    let profile = rules::profile_name(&home.to_string_lossy(), access, &digest);
    let private = sandbox_dir(&home).join(format!("{}-{digest}", access.suffix()));
    let _lock = lock(&home)?;
    let mut journal = read_journal(&home)?;
    if !journal.profiles.contains(&profile) {
        journal.profiles.push(profile.clone());
        write_journal(&home, &journal)?;
    }
    let sid = create_profile(&profile)?;
    for folder in ["home", "tmp", "appdata/roaming", "appdata/local"] {
        fs::create_dir_all(private.join(folder))?;
    }
    let mut grant = |path: &Path, kind| ensure(&home, &mut journal, path, &profile, kind, &sid);
    grant(&fs::canonicalize(&private)?, GrantKind::Modify)?;
    // Manual callers pass the workspace as readable and only approved outputs
    // as writable; the access level picks the container, not the grants.
    for root in &readable {
        grant(&root.canonical, GrantKind::Read)?;
    }
    for root in &writable {
        grant(&root.canonical, GrantKind::Modify)?;
    }
    for root in &deny_write {
        grant(&root.canonical, GrantKind::DenyWrite)?;
    }
    for root in &deny_all {
        grant(&root.canonical, GrantKind::DenyAll)?;
    }
    Ok(Container {
        sid,
        profile,
        private,
    })
}

/// The environment a contained command sees: the caller's, with its home,
/// profile and temp folders moved into the container's private folders, and
/// without the Hexbot home.
pub fn environment(
    container: &Container,
    inherited: impl IntoIterator<Item = (OsString, OsString)>,
) -> Vec<(OsString, OsString)> {
    let private = &container.private;
    let moved = [
        ("HOME", private.join("home")),
        ("USERPROFILE", private.join("home")),
        ("TEMP", private.join("tmp")),
        ("TMP", private.join("tmp")),
        ("APPDATA", private.join("appdata").join("roaming")),
        ("LOCALAPPDATA", private.join("appdata").join("local")),
    ];
    let removed = ["HEXBOT_HOME", "HERMES_HOME"];
    let mut env: Vec<(OsString, OsString)> = inherited
        .into_iter()
        .filter(|(name, _)| {
            let name = name.to_string_lossy();
            !moved
                .iter()
                .map(|(moved, _)| *moved)
                .chain(removed)
                .any(|known| name.eq_ignore_ascii_case(known))
        })
        .collect();
    env.extend(
        moved
            .into_iter()
            .map(|(name, path)| (OsString::from(name), path.into_os_string())),
    );
    env
}

/// Quote one argument as the Microsoft C runtime parses it, so that MSYS
/// programs such as Git Bash expand none of it either.
pub fn quote(argument: &OsStr) -> Vec<u16> {
    rules::quote(&argument.encode_wide().collect::<Vec<_>>())
}

/// A contained process tree. Dropping it closes the job, which ends the tree.
pub struct Contained {
    process: OwnedHandle,
    _job: OwnedHandle,
    pub pid: u32,
}
impl Contained {
    /// Wait for the first process and return its exit code. Its descendants end
    /// with the job when this value drops.
    pub fn wait(&self) -> io::Result<u32> {
        self.wait_for(INFINITE)?
            .ok_or_else(|| io::Error::other("The wait for the sandboxed program ended early"))
    }
    /// As `wait`, or None after `milliseconds`.
    fn wait_for(&self, milliseconds: u32) -> io::Result<Option<u32>> {
        // SAFETY: a valid process handle.
        match unsafe { WaitForSingleObject(self.process.as_raw_handle(), milliseconds) } {
            WAIT_OBJECT_0 => {}
            WAIT_TIMEOUT => return Ok(None),
            _ => return Err(io::Error::last_os_error()),
        }
        let mut code = 0;
        // SAFETY: as above.
        check(unsafe { GetExitCodeProcess(self.process.as_raw_handle(), &mut code) })?;
        Ok(Some(code))
    }
}

/// This process's standard handle `which`, inheritable, or NUL when it has
/// none, as a process without a console does.
fn standard_handle(which: u32) -> io::Result<OwnedHandle> {
    // SAFETY: GetStdHandle does not transfer ownership.
    let handle = unsafe { GetStdHandle(which) };
    if !handle.is_null() && handle as isize != -1 {
        return inheritable(handle);
    }
    let name = wide(OsStr::new(r"\\.\NUL"));
    // SAFETY: a NUL-terminated device name; the handle is owned below.
    let null = owned(unsafe {
        CreateFileW(
            name.as_ptr(),
            GENERIC_READ | GENERIC_WRITE,
            SHARE_ALL,
            ptr::null_mut(),
            OPEN_EXISTING,
            0,
            ptr::null_mut(),
        )
    })?;
    inheritable(null.as_raw_handle())
}

fn inheritable(handle: Handle) -> io::Result<OwnedHandle> {
    let mut copy = ptr::null_mut();
    // SAFETY: duplicates one of this process's standard handles.
    check(unsafe {
        DuplicateHandle(
            GetCurrentProcess(),
            handle,
            GetCurrentProcess(),
            &mut copy,
            0,
            1,
            DUPLICATE_SAME_ACCESS,
        )
    })?;
    owned(copy)
}

/// Start `program` in the container with this process's standard handles.
pub fn spawn(
    sid: &ContainerSid,
    program: &Path,
    arguments: &[OsString],
    directory: Option<&Path>,
    environment: &[(OsString, OsString)],
    process_limit: Option<u32>,
) -> io::Result<Contained> {
    let standard: Vec<OwnedHandle> = [0xFFFF_FFF6u32, 0xFFFF_FFF5, 0xFFFF_FFF4]
        .into_iter()
        .map(standard_handle)
        .collect::<io::Result<_>>()?;
    let mut handles: Vec<Handle> = standard.iter().map(|h| h.as_raw_handle()).collect();
    let mut size = 0;
    // SAFETY: a size query for two attributes.
    unsafe { InitializeProcThreadAttributeList(ptr::null_mut(), 2, 0, &mut size) };
    let mut list = vec![0u64; size.div_ceil(8)];
    // SAFETY: a buffer of the queried size.
    check(unsafe { InitializeProcThreadAttributeList(list.as_mut_ptr().cast(), 2, 0, &mut size) })?;
    struct List(*mut c_void);
    impl Drop for List {
        fn drop(&mut self) {
            // SAFETY: initialized above.
            unsafe { DeleteProcThreadAttributeList(self.0) };
        }
    }
    let list = List(list.as_mut_ptr().cast());
    let capabilities = SecurityCapabilities {
        container: sid.as_ptr(),
        capabilities: ptr::null_mut(),
        count: 0,
        reserved: 0,
    };
    // SAFETY: both values outlive CreateProcessW below.
    check(unsafe {
        UpdateProcThreadAttribute(
            list.0,
            0,
            SECURITY_CAPABILITIES_ATTRIBUTE,
            (&capabilities as *const SecurityCapabilities).cast(),
            mem::size_of::<SecurityCapabilities>(),
            ptr::null_mut(),
            ptr::null_mut(),
        )
    })?;
    // Only the three standard handles are inherited, never others the caller holds.
    check(unsafe {
        UpdateProcThreadAttribute(
            list.0,
            0,
            HANDLE_LIST_ATTRIBUTE,
            handles.as_mut_ptr().cast(),
            handles.len() * mem::size_of::<Handle>(),
            ptr::null_mut(),
            ptr::null_mut(),
        )
    })?;
    let mut command = quote(program.as_os_str());
    for argument in arguments {
        command.push(b' ' as u16);
        command.extend(quote(argument));
    }
    command.push(0);
    let mut block: Vec<u16> = Vec::new();
    for (name, value) in environment {
        block.extend(name.encode_wide());
        block.push(b'=' as u16);
        block.extend(value.encode_wide());
        block.push(0);
    }
    block.push(0);
    let application = wide(program.as_os_str());
    let directory = directory.map(|d| wide(d.as_os_str()));
    let startup = StartupInfoEx {
        info: StartupInfo {
            cb: mem::size_of::<StartupInfoEx>() as u32,
            reserved: ptr::null_mut(),
            desktop: ptr::null_mut(),
            title: ptr::null_mut(),
            x: 0,
            y: 0,
            width: 0,
            height: 0,
            columns: 0,
            rows: 0,
            fill: 0,
            flags: STARTF_USESTDHANDLES,
            show: 0,
            reserved2_len: 0,
            reserved2: ptr::null_mut(),
            stdin: handles[0],
            stdout: handles[1],
            stderr: handles[2],
        },
        attributes: list.0,
    };
    // SAFETY: an unnamed job, owned below.
    let job = owned(unsafe { CreateJobObjectW(ptr::null_mut(), ptr::null()) })?;
    let mut limits = ExtendedLimits::default();
    limits.basic.flags = KILL_ON_JOB_CLOSE | DIE_ON_UNHANDLED_EXCEPTION;
    if let Some(limit) = process_limit {
        limits.basic.flags |= ACTIVE_PROCESS;
        limits.basic.active_processes = limit;
    }
    // SAFETY: a valid job and limits struct.
    check(unsafe {
        SetInformationJobObject(
            job.as_raw_handle(),
            EXTENDED_LIMITS,
            (&limits as *const ExtendedLimits).cast(),
            mem::size_of::<ExtendedLimits>() as u32,
        )
    })?;
    let mut information = ProcessInformation {
        process: ptr::null_mut(),
        thread: ptr::null_mut(),
        pid: 0,
        tid: 0,
    };
    // SAFETY: every pointer outlives the call; the process starts suspended.
    check(unsafe {
        CreateProcessW(
            application.as_ptr(),
            command.as_mut_ptr(),
            ptr::null_mut(),
            ptr::null_mut(),
            1,
            EXTENDED_STARTUPINFO_PRESENT
                | CREATE_SUSPENDED
                | CREATE_UNICODE_ENVIRONMENT
                | CREATE_NO_WINDOW,
            block.as_ptr().cast(),
            directory.as_ref().map_or(ptr::null(), |d| d.as_ptr()),
            &startup,
            &mut information,
        )
    })?;
    let process = owned(information.process)?;
    let thread = owned(information.thread)?;
    // SAFETY: a suspended process this function created.
    if unsafe { AssignProcessToJobObject(job.as_raw_handle(), process.as_raw_handle()) } == 0 {
        let error = io::Error::last_os_error();
        // SAFETY: as above; the process never ran.
        unsafe { TerminateProcess(process.as_raw_handle(), 1) };
        return Err(error);
    }
    // SAFETY: the process's suspended primary thread.
    if unsafe { ResumeThread(thread.as_raw_handle()) } == u32::MAX {
        return Err(io::Error::last_os_error());
    }
    drop(standard);
    Ok(Contained {
        process,
        _job: job,
        pid: information.pid,
    })
}

/// A wide, NUL-free path from UTF-16 units, for tests and logs.
pub fn path_from_wide(units: &[u16]) -> PathBuf {
    PathBuf::from(OsString::from_wide(units))
}

/// The profile the startup probe creates and deletes. One name per user, so a
/// probe that crashed leaves nothing the next probe does not delete.
pub const PROBE_PROFILE: &str = "Hexbot.Sandbox.probe";
/// A hung probe must not hold the daemon; the bubblewrap probe waits as long.
const PROBE_MILLIS: u32 = 5000;

/// Whether contained commands can run here, probed once per process: the
/// counterpart of the bubblewrap probe on Linux.
pub fn probe_available() -> bool {
    static AVAILABLE: OnceLock<bool> = OnceLock::new();
    *AVAILABLE.get_or_init(|| probe().is_ok())
}

/// Run `cmd /c exit 0` in a throwaway profile with no grants, then delete it.
pub fn probe() -> io::Result<()> {
    let sid = create_profile(PROBE_PROFILE)?;
    let ran = (|| {
        let cmd = crate::windows_paths::system_program("cmd.exe")?;
        let system = cmd.parent().unwrap_or(&cmd);
        let windows = system.parent().unwrap_or(system);
        let environment = [(OsString::from("SystemRoot"), windows.as_os_str().to_owned())];
        let arguments = ["/d", "/c", "exit", "0"].map(OsString::from);
        // System32 is readable to every AppContainer, so it needs no grant.
        let child = spawn(
            &sid,
            &cmd,
            &arguments,
            Some(system),
            &environment,
            Some(PROCESS_LIMIT),
        )?;
        match child.wait_for(PROBE_MILLIS)? {
            Some(0) => Ok(()),
            Some(code) => Err(io::Error::other(format!(
                "The sandbox probe exited with {code}"
            ))),
            None => Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "The sandbox probe did not finish",
            )),
        }
    })();
    drop(sid);
    ran.and(delete_profile(PROBE_PROFILE))
}

/// `hexbot sandbox exec <policy> -- <program> [arguments...]` runs one program
/// in the container `policy` names and exits with its code. `<policy>` is the
/// base64 JSON of a [`Policy`], which names the Hexbot home. When the program
/// cannot run, because the policy is invalid, a root is refused or the
/// container cannot be made, the helper writes one line to stderr and exits
/// with 126, as a shell does for a command it cannot run.
pub fn exec(arguments: &[String]) -> ! {
    let code = match start(arguments) {
        // The job ends the program's descendants when `child` drops.
        Ok(child) => child
            .wait()
            .map(|code| code as i32)
            .unwrap_or_else(|error| not_run(&error.to_string())),
        Err(message) => not_run(&message),
    };
    std::process::exit(code)
}

fn not_run(message: &str) -> i32 {
    eprintln!("{}", message.replace(['\r', '\n'], " "));
    NOT_RUN
}

fn start(arguments: &[String]) -> Result<Contained, String> {
    use base64::Engine;
    let [policy, separator, program, rest @ ..] = arguments else {
        return Err(USAGE.to_owned());
    };
    if separator != "--" {
        return Err(USAGE.to_owned());
    }
    let policy: Policy = base64::engine::general_purpose::STANDARD
        .decode(policy)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .ok_or("sandbox exec needs a base64 JSON policy")?;
    let program = Path::new(program);
    if !program.is_absolute() {
        return Err("sandbox exec needs an absolute program path".to_owned());
    }
    let container = prepare(&policy)
        .map_err(|error| format!("Could not prepare the Windows sandbox: {error}"))?;
    let environment = environment(&container, std::env::vars_os());
    let directory = std::env::current_dir().ok();
    let arguments: Vec<OsString> = rest.iter().map(OsString::from).collect();
    spawn(
        &container.sid,
        program,
        &arguments,
        directory.as_deref(),
        &environment,
        Some(PROCESS_LIMIT),
    )
    .map_err(|error| {
        format!(
            "Could not start {} in the Windows sandbox: {error}",
            program.display()
        )
    })
}

/// `hexbot sandbox reset` removes every grant and profile in the home. The
/// daemon runs `exec` before it reads the home, through [`exec`].
pub fn run(home: &Path, arguments: &[String]) -> crate::Result<()> {
    match arguments {
        [command] if command == "reset" => {
            let walk = reset(home).map_err(|error| {
                crate::Error::new(
                    5240,
                    format!("Could not remove the Windows sandbox grants: {error}"),
                )
            })?;
            println!(
                "Removed {} sandbox entries; {} left unchanged.",
                walk.changed, walk.failed
            );
            Ok(())
        }
        _ => Err(crate::Error::new(4200, USAGE.to_owned())),
    }
}
