//! Retained kernel process identities shared by creator lifetime and task Stop.
use std::{
    ffi::c_void,
    io,
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    path::PathBuf,
};
#[repr(C)]
struct ProcessEntry {
    size: u32,
    usage: u32,
    pid: u32,
    heap: usize,
    module: u32,
    threads: u32,
    parent: u32,
    priority: i32,
    flags: u32,
    executable: [u16; 260],
}
#[link(name = "kernel32")]
unsafe extern "system" {
    fn CreateToolhelp32Snapshot(flags: u32, pid: u32) -> *mut c_void;
    fn Process32FirstW(snapshot: *mut c_void, entry: *mut ProcessEntry) -> i32;
    fn Process32NextW(snapshot: *mut c_void, entry: *mut ProcessEntry) -> i32;
    fn GetCurrentProcess() -> *mut c_void;
    fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut c_void;
    fn GetProcessTimes(
        process: *mut c_void,
        created: *mut u64,
        exited: *mut u64,
        kernel: *mut u64,
        user: *mut u64,
    ) -> i32;
    fn QueryFullProcessImageNameW(
        process: *mut c_void,
        flags: u32,
        path: *mut u16,
        length: *mut u32,
    ) -> i32;
    fn WaitForSingleObject(handle: *mut c_void, milliseconds: u32) -> u32;
}
#[link(name = "advapi32")]
unsafe extern "system" {
    fn OpenProcessToken(process: *mut c_void, access: u32, token: *mut *mut c_void) -> i32;
    fn GetTokenInformation(
        token: *mut c_void,
        class: u32,
        information: *mut c_void,
        size: u32,
        needed: *mut u32,
    ) -> i32;
    fn EqualSid(first: *const c_void, second: *const c_void) -> i32;
}
fn owned(raw: *mut c_void) -> io::Result<OwnedHandle> {
    if raw.is_null() || raw == -1isize as *mut c_void {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { OwnedHandle::from_raw_handle(raw) })
}
pub(crate) fn created(process: *mut c_void) -> io::Result<u64> {
    let (mut born, mut exited, mut kernel, mut user) = (0, 0, 0, 0);
    if unsafe { GetProcessTimes(process, &mut born, &mut exited, &mut kernel, &mut user) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(born)
}
pub(crate) fn snapshot() -> io::Result<Vec<(u32, u32)>> {
    let snapshot = owned(unsafe { CreateToolhelp32Snapshot(2, 0) })?;
    let mut entry: ProcessEntry = unsafe { std::mem::zeroed() };
    entry.size = std::mem::size_of::<ProcessEntry>() as u32;
    let mut more = unsafe { Process32FirstW(snapshot.as_raw_handle(), &mut entry) };
    let mut entries = Vec::new();
    while more != 0 {
        entries.push((entry.pid, entry.parent));
        more = unsafe { Process32NextW(snapshot.as_raw_handle(), &mut entry) };
    }
    let error = io::Error::last_os_error();
    if error.raw_os_error() != Some(18) {
        return Err(error);
    }
    Ok(entries)
}
pub(crate) fn image(process: *mut c_void) -> io::Result<PathBuf> {
    let mut path = vec![0u16; 32768];
    let mut length = path.len() as u32;
    if unsafe { QueryFullProcessImageNameW(process, 0, path.as_mut_ptr(), &mut length) } == 0 {
        return Err(io::Error::last_os_error());
    }
    PathBuf::from(String::from_utf16_lossy(&path[..length as usize])).canonicalize()
}
fn user(process: *mut c_void) -> io::Result<Vec<u8>> {
    let mut token = std::ptr::null_mut();
    if unsafe { OpenProcessToken(process, 8, &mut token) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let token = owned(token)?;
    let mut needed = 0;
    unsafe {
        GetTokenInformation(
            token.as_raw_handle(),
            1,
            std::ptr::null_mut(),
            0,
            &mut needed,
        )
    };
    if needed < std::mem::size_of::<*const c_void>() as u32 || needed > 65536 {
        return Err(io::Error::other("Invalid process owner token"));
    }
    let mut bytes = vec![0u8; needed as usize];
    if unsafe {
        GetTokenInformation(
            token.as_raw_handle(),
            1,
            bytes.as_mut_ptr().cast(),
            needed,
            &mut needed,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(bytes)
}
pub(crate) fn same_owner(parent: *mut c_void) -> io::Result<bool> {
    let first = user(parent)?;
    let second = user(unsafe { GetCurrentProcess() })?;
    // TOKEN_USER begins with SID_AND_ATTRIBUTES. Its SID points into the
    // still-live returned buffer; read the pointer without assuming Vec<u8>
    // alignment. Both buffers remain alive through EqualSid.
    let sid =
        |bytes: &[u8]| unsafe { std::ptr::read_unaligned(bytes.as_ptr().cast::<*const c_void>()) };
    Ok(unsafe { EqualSid(sid(&first), sid(&second)) } != 0)
}

// ERROR_INVALID_PARAMETER for a nonzero PID means no process exists. Access
// denied and all other errors remain errors, never "already exited".
pub(crate) fn open(pid: u32) -> io::Result<Option<OwnedHandle>> {
    if pid == 0 {
        return Err(io::Error::other("Invalid process ID"));
    }
    match owned(unsafe { OpenProcess(0x00101000, 0, pid) }) {
        Ok(handle) => Ok(Some(handle)),
        Err(error) if error.raw_os_error() == Some(87) => Ok(None),
        Err(error) => Err(error),
    }
}
pub(crate) fn wait(process: *mut c_void, milliseconds: u32) -> io::Result<bool> {
    match unsafe { WaitForSingleObject(process, milliseconds) } {
        0 => Ok(true),
        258 => Ok(false),
        _ => Err(io::Error::last_os_error()),
    }
}
