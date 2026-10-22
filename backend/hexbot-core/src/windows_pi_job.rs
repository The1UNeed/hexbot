//! Per-Pi descendant lifetime, not execution confinement. The process starts
//! suspended and cannot create descendants until assignment succeeds. Nested
//! membership retains the daemon/Task Scheduler job as well; no breakaway.
use std::{
    ffi::c_void,
    io,
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    time::{Duration, Instant},
};
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
struct CompletionPort {
    key: usize,
    port: *mut c_void,
}
#[repr(C)]
#[derive(Default)]
struct Accounting {
    user_time: i64,
    kernel_time: i64,
    period_user: i64,
    period_kernel: i64,
    page_faults: u32,
    total: u32,
    active: u32,
    terminated: u32,
}
#[repr(C)]
#[derive(Default)]
struct ThreadEntry {
    size: u32,
    usage: u32,
    id: u32,
    owner: u32,
    base_priority: i32,
    delta_priority: i32,
    flags: u32,
}
#[link(name = "kernel32")]
unsafe extern "system" {
    fn CreateJobObjectW(attributes: *const c_void, name: *const u16) -> *mut c_void;
    fn SetInformationJobObject(job: *mut c_void, class: u32, info: *const c_void, size: u32)
    -> i32;
    fn QueryInformationJobObject(
        job: *mut c_void,
        class: u32,
        info: *mut c_void,
        size: u32,
        returned: *mut u32,
    ) -> i32;
    fn AssignProcessToJobObject(job: *mut c_void, process: *mut c_void) -> i32;
    fn TerminateJobObject(job: *mut c_void, code: u32) -> i32;
    fn CreateIoCompletionPort(
        file: *mut c_void,
        port: *mut c_void,
        key: usize,
        threads: u32,
    ) -> *mut c_void;
    fn GetQueuedCompletionStatus(
        port: *mut c_void,
        bytes: *mut u32,
        key: *mut usize,
        overlapped: *mut *mut c_void,
        millis: u32,
    ) -> i32;
    fn CreateToolhelp32Snapshot(flags: u32, pid: u32) -> *mut c_void;
    fn Thread32First(snapshot: *mut c_void, entry: *mut ThreadEntry) -> i32;
    fn Thread32Next(snapshot: *mut c_void, entry: *mut ThreadEntry) -> i32;
    fn OpenThread(access: u32, inherit: i32, id: u32) -> *mut c_void;
    fn GetProcessIdOfThread(thread: *mut c_void) -> u32;
    fn ResumeThread(thread: *mut c_void) -> u32;
}
fn handle(raw: *mut c_void) -> io::Result<OwnedHandle> {
    if raw.is_null() || raw == (-1isize as *mut c_void) {
        Err(io::Error::last_os_error())
    } else {
        Ok(unsafe { OwnedHandle::from_raw_handle(raw) })
    }
}
pub(super) struct PiJob {
    job: OwnedHandle,
    port: OwnedHandle,
}
impl PiJob {
    pub(super) fn new() -> io::Result<Self> {
        let job = handle(unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) })?;
        let limits = ExtendedLimits {
            basic: BasicLimits {
                flags: 0x2000,
                ..Default::default()
            },
            ..Default::default()
        };
        if unsafe {
            SetInformationJobObject(
                job.as_raw_handle(),
                9,
                (&limits as *const ExtendedLimits).cast(),
                std::mem::size_of_val(&limits) as u32,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        let port = handle(unsafe {
            CreateIoCompletionPort(-1isize as *mut c_void, std::ptr::null_mut(), 0, 1)
        })?;
        let association = CompletionPort {
            key: 1,
            port: port.as_raw_handle(),
        };
        if unsafe {
            SetInformationJobObject(
                job.as_raw_handle(),
                7,
                (&association as *const CompletionPort).cast(),
                std::mem::size_of_val(&association) as u32,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(Self { job, port })
    }
    pub(super) fn assign_and_resume(&self, child: &tokio::process::Child) -> io::Result<()> {
        let pid = child
            .id()
            .ok_or_else(|| io::Error::other("Pi exited before job assignment"))?;
        let process = child
            .raw_handle()
            .ok_or_else(|| io::Error::other("Pi process handle is missing"))?;
        if unsafe { AssignProcessToJobObject(self.job.as_raw_handle(), process) } == 0 {
            return Err(io::Error::last_os_error());
        }
        // std/Tokio close PROCESS_INFORMATION.hThread. Enumerate the held,
        // suspended process's sole initial thread via documented Toolhelp APIs.
        // Fail closed on ambiguity; no user-mode initialization has run yet.
        let snapshot = handle(unsafe { CreateToolhelp32Snapshot(4, 0) })?;
        let mut entry = ThreadEntry {
            size: std::mem::size_of::<ThreadEntry>() as u32,
            ..Default::default()
        };
        let mut found = None;
        let mut more = unsafe { Thread32First(snapshot.as_raw_handle(), &mut entry) };
        while more != 0 {
            if entry.owner == pid {
                if found.is_some() {
                    return Err(io::Error::other("Suspended Pi has multiple threads"));
                }
                found = Some(entry.id);
            }
            more = unsafe { Thread32Next(snapshot.as_raw_handle(), &mut entry) };
        }
        if io::Error::last_os_error().raw_os_error() != Some(18) {
            return Err(io::Error::last_os_error());
        }
        let id = found.ok_or_else(|| io::Error::other("Suspended Pi thread is missing"))?;
        let thread = handle(unsafe { OpenThread(0x0802, 0, id) })?; // QUERY_LIMITED_INFORMATION | SUSPEND_RESUME
        if unsafe { GetProcessIdOfThread(thread.as_raw_handle()) } != pid {
            return Err(io::Error::other("Pi thread identity changed"));
        }
        if unsafe { ResumeThread(thread.as_raw_handle()) } != 1 {
            return Err(io::Error::other("Pi initial thread was not suspended once"));
        }
        Ok(())
    }
    fn active(&self) -> io::Result<u32> {
        let mut info = Accounting::default();
        if unsafe {
            QueryInformationJobObject(
                self.job.as_raw_handle(),
                1,
                (&mut info as *mut Accounting).cast(),
                std::mem::size_of_val(&info) as u32,
                std::ptr::null_mut(),
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(info.active)
    }
    /// Terminate only this section's tree, including children that outlived
    /// Node. Wait on kernel job notifications, then confirm accounting zero.
    pub(super) fn terminate_and_wait(self) -> io::Result<()> {
        if unsafe { TerminateJobObject(self.job.as_raw_handle(), 1) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let deadline = Instant::now() + Duration::from_secs(15);
        while self.active()? != 0 {
            let millis = deadline
                .saturating_duration_since(Instant::now())
                .as_millis()
                .min(u32::MAX as u128) as u32;
            if millis == 0 {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "Pi descendants did not exit",
                ));
            }
            let (mut bytes, mut key, mut overlapped) = (0, 0, std::ptr::null_mut());
            if unsafe {
                GetQueuedCompletionStatus(
                    self.port.as_raw_handle(),
                    &mut bytes,
                    &mut key,
                    &mut overlapped,
                    millis,
                )
            } == 0
            {
                let error = io::Error::last_os_error();
                if error.raw_os_error() == Some(258) && self.active()? == 0 {
                    return Ok(());
                }
                return Err(error);
            }
        }
        Ok(())
    }
}
