//! Service creator lifetime, not execution isolation. Holding the verified
//! creator handle prevents PID reuse from becoming shutdown authority.
#[path = "windows_service_parent_policy.rs"]
mod policy;
#[path = "windows_paths.rs"]
pub(crate) mod trusted_paths;
use std::{
    ffi::c_void,
    io,
    os::windows::io::{AsRawHandle, OwnedHandle},
};
const WATCHDOG_EXIT: u32 = 124;
const CLEANUP_MILLIS: u32 = 10_000;
#[path = "windows_process_identity.rs"]
mod identity;
use identity::{created, image, same_owner};
#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetCurrentProcess() -> *mut c_void;
    fn TerminateProcess(process: *mut c_void, code: u32) -> i32;
}
fn parent_id() -> io::Result<u32> {
    identity::snapshot()?
        .into_iter()
        .find(|(pid, _)| *pid == std::process::id())
        .map(|(_, parent)| parent)
        .ok_or_else(|| io::Error::other("Cannot identify the Windows service creator"))
}
fn acquire() -> io::Result<OwnedHandle> {
    let pid = parent_id()?;
    let parent = identity::open(pid)?
        .ok_or_else(|| io::Error::other("Windows service creator already exited"))?; // SYNCHRONIZE | QUERY_LIMITED_INFORMATION
    let expected =
        trusted_paths::system_program("WindowsPowerShell/v1.0/powershell.exe")?.canonicalize()?;
    let identity = policy::Identity {
        pid,
        created: created(parent.as_raw_handle())?,
        alive: !identity::wait(parent.as_raw_handle(), 0)?,
        same_owner: same_owner(parent.as_raw_handle())?,
        system_powershell: image(parent.as_raw_handle())? == expected,
    };
    if !identity.verified(
        std::process::id(),
        created(unsafe { GetCurrentProcess() })?,
        parent_id()?,
    ) || identity::wait(parent.as_raw_handle(), 0)?
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
                let waited = identity::wait(parent.as_raw_handle(), u32::MAX);
                if !matches!(waited, Ok(true)) {
                    eprintln!("Windows service creator wait failed; shutting down");
                }
                let _ = sender.send(());
                // The only force target is this process, through its pseudo handle.
                // Normal App/Pi/tunnel cleanup exits zero before the deadline and
                // OS teardown ends this thread. A hang exits 124; the existing
                // non-inheritable daemon job then reaps remaining descendants.
                let deadline = std::time::Instant::now()
                    + std::time::Duration::from_millis(CLEANUP_MILLIS.into());
                if !matches!(
                    identity::wait(unsafe { GetCurrentProcess() }, CLEANUP_MILLIS),
                    Ok(true)
                ) {
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
