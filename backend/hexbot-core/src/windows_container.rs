//! Windows tool isolation: AppContainers, file grants and contained processes.
//!
//! One AppContainer per Hexbot home and access level (Auto writes the
//! workspace, Manual only reads it). A container has no capabilities, so it has
//! no network, not even loopback, and reaches no file the user owns unless
//! Hexbot granted it. Grants are allow entries for the container's SID only:
//! the workspace and output folders, a private home and temp folder, and the
//! runtime programs a command may run. Git metadata gets a write deny and
//! project secrets a full deny for the same SIDs.
//!
//! Grants are applied by walking each tree through handles. Every entry is
//! opened relative to its parent's handle without following reparse points, so
//! swapping a folder for a junction during the walk cannot redirect it. Reparse
//! points are never changed or entered, and a file with more than one hard link
//! is never granted: its DACL is shared with names outside the tree. A journal
//! names every root before it changes, and `hexbot sandbox reset` removes
//! every entry for Hexbot's SIDs from the roots it names. Other entries are
//! never touched. One lock file serializes all changes across processes.
use serde::{Deserialize, Serialize};
use std::{
    ffi::{OsStr, OsString, c_void},
    fs, io, mem,
    os::windows::{
        ffi::{OsStrExt, OsStringExt},
        io::{AsRawHandle, FromRawHandle, OwnedHandle},
    },
    path::{Path, PathBuf},
    ptr,
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
const DUPLICATE_SAME_ACCESS: u32 = 2;
/// A job's limit counts one command's tree, so it is the Unix headroom alone.
const PROCESS_LIMIT: u32 = 512;

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

/// Which container a command runs in.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Access {
    /// Auto: the workspace and outputs are writable.
    Workspace,
    /// Manual: the workspace is only readable.
    Read,
}
impl Access {
    fn suffix(self) -> &'static str {
        match self {
            Self::Workspace => "write",
            Self::Read => "read",
        }
    }
    pub fn all() -> [Self; 2] {
        [Self::Workspace, Self::Read]
    }
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

/// The profile name: stable for one home, under the 64-character limit.
pub fn profile_name(home: &Path, access: Access) -> String {
    use sha2::{Digest, Sha256};
    let canonical = home.to_string_lossy().to_lowercase();
    let digest = Sha256::digest(canonical.as_bytes());
    let hash: String = digest[..8].iter().map(|b| format!("{b:02x}")).collect();
    format!("Hexbot.Sandbox.{}.{hash}", access.suffix())
}

/// Create the home's container for `access`, or return the existing one.
pub fn container(home: &Path, access: Access) -> io::Result<ContainerSid> {
    let name = wide(OsStr::new(&profile_name(home, access)));
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
            return Err(io::Error::from_raw_os_error(result & 0xFFFF));
        }
    } else if result < 0 {
        return Err(io::Error::from_raw_os_error(result & 0xFFFF));
    }
    Ok(ContainerSid(sid))
}

/// Remove the home's containers. Missing profiles are fine.
pub fn delete_containers(home: &Path) -> io::Result<()> {
    for access in Access::all() {
        let name = wide(OsStr::new(&profile_name(home, access)));
        // SAFETY: a NUL-terminated name.
        let result = unsafe { DeleteAppContainerProfile(name.as_ptr()) };
        if result < 0 && result & 0xFFFF != 2 {
            return Err(io::Error::from_raw_os_error(result & 0xFFFF));
        }
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

/// Every root Hexbot has changed, kept before each change.
#[derive(Default, Serialize, Deserialize)]
pub struct Journal {
    pub roots: Vec<JournalEntry>,
}
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct JournalEntry {
    pub path: PathBuf,
    pub access: Access,
    pub kind: GrantKind,
    /// False until the walk finished; an unfinished grant is walked again.
    pub complete: bool,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GrantKind {
    Read,
    Modify,
    DenyWrite,
    DenyAll,
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
    home.join("runtime/sandbox")
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

/// Make sure `path` carries `kind` for `access`, walking it only when the
/// journal has no finished grant or the root lost its entry.
pub fn ensure(
    home: &Path,
    path: &Path,
    access: Access,
    kind: GrantKind,
    sid: &ContainerSid,
) -> io::Result<()> {
    let mut journal = read_journal(home)?;
    let entry = JournalEntry {
        path: path.to_owned(),
        access,
        kind,
        complete: true,
    };
    if journal.roots.contains(&entry) && applied(path, kind.change(), sid)? {
        return Ok(());
    }
    journal
        .roots
        .retain(|root| !(root.path == path && root.access == access && root.kind == kind));
    journal.roots.push(JournalEntry {
        complete: false,
        ..entry.clone()
    });
    write_journal(home, &journal)?;
    walk(path, kind.change(), &[sid])?;
    if let Some(root) = journal
        .roots
        .iter_mut()
        .find(|root| root.path == path && root.access == access && root.kind == kind)
    {
        root.complete = true;
    }
    write_journal(home, &journal)
}

/// Remove every entry for the home's containers from every journaled root,
/// then delete the containers. Roots that no longer exist are dropped.
pub fn reset(home: &Path) -> io::Result<Walk> {
    let _lock = lock(home)?;
    let mut journal = read_journal(home)?;
    let sids = Access::all()
        .map(|access| container(home, access))
        .into_iter()
        .collect::<io::Result<Vec<_>>>()?;
    let sids: Vec<&ContainerSid> = sids.iter().collect();
    let mut total = Walk::default();
    let mut left = Vec::new();
    for root in journal.roots.drain(..) {
        match walk(&root.path, Change::Revoke, &sids) {
            Ok(walk) => {
                total.changed += walk.changed;
                total.unchanged += walk.unchanged;
                total.skipped_links += walk.skipped_links;
                total.failed += walk.failed;
                if walk.failed > 0 {
                    left.push(root);
                }
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(_) => left.push(root),
        }
    }
    journal.roots = left;
    write_journal(home, &journal)?;
    if journal.roots.is_empty() {
        delete_containers(home)?;
    }
    Ok(total)
}

/// Everything one contained command may reach.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Policy {
    pub access: Option<Access>,
    /// Folders the command may write (Auto's workspace, approved outputs).
    pub writable: Vec<PathBuf>,
    /// Folders the command may read and run programs from.
    pub readable: Vec<PathBuf>,
    /// Git metadata: readable where granted, never written.
    pub deny_write: Vec<PathBuf>,
    /// Project secrets: never read or written.
    pub deny_all: Vec<PathBuf>,
}

/// The container's private home and temp folder.
pub fn private_dirs(home: &Path, access: Access) -> PathBuf {
    sandbox_dir(home).join(access.suffix())
}

/// Grant `policy` to its container and return the container's SID.
pub fn prepare(home: &Path, policy: &Policy) -> io::Result<ContainerSid> {
    let access = policy.access.unwrap_or(Access::Workspace);
    let sid = container(home, access)?;
    let _lock = lock(home)?;
    let private = private_dirs(home, access);
    for folder in ["home", "tmp", "appdata/roaming", "appdata/local"] {
        fs::create_dir_all(private.join(folder))?;
    }
    let canonical = |path: &PathBuf| fs::canonicalize(path);
    ensure(home, &canonical(&private)?, access, GrantKind::Modify, &sid)?;
    // Manual callers pass the workspace as readable and only approved outputs
    // as writable; the access level picks the container, not the grants.
    for path in &policy.readable {
        if let Ok(path) = canonical(path) {
            ensure(home, &path, access, GrantKind::Read, &sid)?;
        }
    }
    for path in &policy.writable {
        let path = canonical(path)?;
        ensure(home, &path, access, GrantKind::Modify, &sid)?;
    }
    for path in &policy.deny_write {
        if let Ok(path) = canonical(path) {
            ensure(home, &path, access, GrantKind::DenyWrite, &sid)?;
        }
    }
    for path in &policy.deny_all {
        if let Ok(path) = canonical(path) {
            ensure(home, &path, access, GrantKind::DenyAll, &sid)?;
        }
    }
    Ok(sid)
}

/// The environment a contained command sees: the caller's, with its home,
/// profile and temp folders moved into the container's private folders.
pub fn environment(
    home: &Path,
    access: Access,
    inherited: impl IntoIterator<Item = (OsString, OsString)>,
) -> Vec<(OsString, OsString)> {
    let private = private_dirs(home, access);
    let moved = [
        ("HOME", private.join("home")),
        ("USERPROFILE", private.join("home")),
        ("TEMP", private.join("tmp")),
        ("TMP", private.join("tmp")),
        ("APPDATA", private.join("appdata/roaming")),
        ("LOCALAPPDATA", private.join("appdata/local")),
    ];
    let mut env: Vec<(OsString, OsString)> = inherited
        .into_iter()
        .filter(|(name, _)| {
            !moved
                .iter()
                .any(|(moved, _)| name.to_string_lossy().eq_ignore_ascii_case(moved))
        })
        .collect();
    env.extend(
        moved
            .into_iter()
            .map(|(name, path)| (OsString::from(name), path.into_os_string())),
    );
    env
}

/// Quote one argument as the Microsoft C runtime parses it.
pub fn quote(argument: &OsStr) -> Vec<u16> {
    let units: Vec<u16> = argument.encode_wide().collect();
    let plain = !units.is_empty()
        && !units
            .iter()
            .any(|&c| c == b' ' as u16 || c == b'\t' as u16 || c == b'"' as u16);
    if plain {
        return units;
    }
    let mut quoted = vec![b'"' as u16];
    let mut backslashes = 0;
    for &unit in &units {
        if unit == b'\\' as u16 {
            backslashes += 1;
            continue;
        }
        if unit == b'"' as u16 {
            quoted.extend(std::iter::repeat_n(b'\\' as u16, backslashes * 2 + 1));
        } else {
            quoted.extend(std::iter::repeat_n(b'\\' as u16, backslashes));
        }
        backslashes = 0;
        quoted.push(unit);
    }
    quoted.extend(std::iter::repeat_n(b'\\' as u16, backslashes * 2));
    quoted.push(b'"' as u16);
    quoted
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
        // SAFETY: a valid process handle.
        unsafe { WaitForSingleObject(self.process.as_raw_handle(), INFINITE) };
        let mut code = 0;
        // SAFETY: as above.
        check(unsafe { GetExitCodeProcess(self.process.as_raw_handle(), &mut code) })?;
        Ok(code)
    }
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
    // SAFETY: standard handles of this process; GetStdHandle does not transfer ownership.
    let standard: Vec<OwnedHandle> = [0xFFFF_FFF6u32, 0xFFFF_FFF5, 0xFFFF_FFF4]
        .into_iter()
        .map(|which| inheritable(unsafe { GetStdHandle(which) }))
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

/// `hexbot sandbox exec <policy> -- <program> [arguments...]` runs one program
/// in the container `policy` names and exits with its code. `<policy>` is the
/// base64 JSON of a [`Policy`]. `hexbot sandbox reset` removes every grant.
pub fn run(home: &Path, arguments: &[String]) -> crate::Result<()> {
    use base64::Engine;
    let invalid = |message: &str| crate::Error::new(4200, message.to_owned());
    match arguments {
        [reset] if reset == "reset" => {
            let walk = reset_home(home)?;
            println!(
                "Removed {} sandbox entries; {} left unchanged.",
                walk.changed, walk.failed
            );
            Ok(())
        }
        [exec, policy, separator, program, rest @ ..] if exec == "exec" && separator == "--" => {
            let policy: Policy = base64::engine::general_purpose::STANDARD
                .decode(policy)
                .ok()
                .and_then(|bytes| serde_json::from_slice(&bytes).ok())
                .ok_or_else(|| invalid("sandbox exec needs a base64 JSON policy"))?;
            let program = Path::new(program);
            if !program.is_absolute() {
                return Err(invalid("sandbox exec needs an absolute program path"));
            }
            let access = policy.access.unwrap_or(Access::Workspace);
            let sid = prepare(home, &policy).map_err(|error| {
                crate::Error::new(
                    5240,
                    format!("Could not prepare the Windows sandbox: {error}"),
                )
            })?;
            let env = environment(home, access, std::env::vars_os());
            let directory = std::env::current_dir().ok();
            let arguments: Vec<OsString> = rest.iter().map(OsString::from).collect();
            let child = spawn(
                &sid,
                program,
                &arguments,
                directory.as_deref(),
                &env,
                Some(PROCESS_LIMIT),
            )
            .map_err(|error| {
                crate::Error::new(
                    5240,
                    format!(
                        "Could not start {} in the Windows sandbox: {error}",
                        program.display()
                    ),
                )
            })?;
            let code = child
                .wait()
                .map_err(|error| crate::Error::new(5240, error.to_string()))?;
            drop(child);
            std::process::exit(code as i32)
        }
        _ => Err(invalid(
            "sandbox expects exec <policy> -- <program> [arguments...] or reset",
        )),
    }
}

fn reset_home(home: &Path) -> crate::Result<Walk> {
    reset(home).map_err(|error| {
        crate::Error::new(
            5240,
            format!("Could not remove the Windows sandbox grants: {error}"),
        )
    })
}
