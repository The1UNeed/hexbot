//! Service creator lifetime, not execution isolation. Holding the verified
//! creator handle prevents PID reuse from becoming shutdown authority.
#[path = "windows_service_parent_policy.rs"]
mod policy;
#[path = "windows_paths.rs"]
mod trusted_paths;
use std::{
    ffi::c_void,
    io,
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    path::PathBuf,
};
const WATCHDOG_EXIT: u32 = 124;
const CLEANUP_MILLIS: u32 = 10_000;
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
    fn TerminateProcess(process: *mut c_void, code: u32) -> i32;
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
fn created(process: *mut c_void) -> io::Result<u64> {
    let (mut born, mut exited, mut kernel, mut user) = (0, 0, 0, 0);
    if unsafe { GetProcessTimes(process, &mut born, &mut exited, &mut kernel, &mut user) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(born)
}
fn parent_id() -> io::Result<u32> {
    let snapshot = owned(unsafe { CreateToolhelp32Snapshot(2, 0) })?;
    // PROCESSENTRY32W is plain integer/array storage. Initialize its required
    // size before passing it to Toolhelp, which fills the remaining fields.
    let mut entry: ProcessEntry = unsafe { std::mem::zeroed() };
    entry.size = std::mem::size_of::<ProcessEntry>() as u32;
    let mut more = unsafe { Process32FirstW(snapshot.as_raw_handle(), &mut entry) };
    while more != 0 {
        if entry.pid == std::process::id() {
            return Ok(entry.parent);
        }
        more = unsafe { Process32NextW(snapshot.as_raw_handle(), &mut entry) };
    }
    Err(io::Error::other(
        "Cannot identify the Windows service creator",
    ))
}
fn image(process: *mut c_void) -> io::Result<PathBuf> {
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
fn same_owner(parent: *mut c_void) -> io::Result<bool> {
    let first = user(parent)?;
    let second = user(unsafe { GetCurrentProcess() })?;
    // TOKEN_USER begins with SID_AND_ATTRIBUTES. Its SID points into the
    // still-live returned buffer; read the pointer without assuming Vec<u8>
    // alignment. Both buffers remain alive through EqualSid.
    let sid =
        |bytes: &[u8]| unsafe { std::ptr::read_unaligned(bytes.as_ptr().cast::<*const c_void>()) };
    Ok(unsafe { EqualSid(sid(&first), sid(&second)) } != 0)
}
fn acquire() -> io::Result<OwnedHandle> {
    let pid = parent_id()?;
    let parent = owned(unsafe { OpenProcess(0x00101000, 0, pid) })?; // SYNCHRONIZE | QUERY_LIMITED_INFORMATION
    let expected =
        trusted_paths::system_program("WindowsPowerShell/v1.0/powershell.exe")?.canonicalize()?;
    let identity = policy::Identity {
        pid,
        created: created(parent.as_raw_handle())?,
        alive: unsafe { WaitForSingleObject(parent.as_raw_handle(), 0) } == 258,
        same_owner: same_owner(parent.as_raw_handle())?,
        system_powershell: image(parent.as_raw_handle())? == expected,
    };
    if !identity.verified(
        std::process::id(),
        created(unsafe { GetCurrentProcess() })?,
        parent_id()?,
    ) || unsafe { WaitForSingleObject(parent.as_raw_handle(), 0) } != 258
    {
        return Err(io::Error::other(
            "Cannot verify the live Windows service creator",
        ));
    }
    Ok(parent)
}
pub fn shutdown() -> io::Result<impl Future<Output = ()>> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    if std::env::var("HEXBOT_SUPERVISOR").as_deref() == Ok("service") {
        let parent = acquire()?;
        // The kernel handle is retained by this thread from acquisition until
        // the exit event. No metadata PID is reopened after task Stop.
        std::thread::Builder::new()
            .name("hexbot-service-parent".into())
            .spawn(move || {
                let waited = unsafe { WaitForSingleObject(parent.as_raw_handle(), u32::MAX) };
                if waited != 0 {
                    eprintln!("Windows service creator wait failed; shutting down");
                }
                let _ = sender.send(());
                // The only force target is this process, through its pseudo handle.
                // Normal App/Pi/tunnel cleanup exits zero before the deadline and
                // OS teardown ends this thread. A hang exits 124; the existing
                // non-inheritable daemon job then reaps remaining descendants.
                let deadline = std::time::Instant::now()
                    + std::time::Duration::from_millis(CLEANUP_MILLIS.into());
                if unsafe { WaitForSingleObject(GetCurrentProcess(), CLEANUP_MILLIS) } != 0 {
                    // Even a failed wait cannot force cleanup before its deadline.
                    std::thread::sleep(
                        deadline.saturating_duration_since(std::time::Instant::now()),
                    );
                    eprintln!("Windows service cleanup exceeded its deadline");
                    unsafe { TerminateProcess(GetCurrentProcess(), WATCHDOG_EXIT) };
                }
            })?;
    }
    Ok(async move {
        if receiver.await.is_err() {
            std::future::pending::<()>().await;
        }
    })
}
