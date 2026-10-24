//! Daemon child lifetime only. This is not tool isolation or a sandbox.
//! Retain one non-inheritable job handle until OS process teardown. Children
//! created with CreateProcess inherit membership, including grandchildren.
use std::{ffi::c_void, io};

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
#[link(name = "kernel32")]
unsafe extern "system" {
    fn CreateJobObjectW(attributes: *const c_void, name: *const u16) -> *mut c_void;
    fn SetInformationJobObject(
        job: *mut c_void,
        class: u32,
        information: *const c_void,
        size: u32,
    ) -> i32;
    fn AssignProcessToJobObject(job: *mut c_void, process: *mut c_void) -> i32;
    fn GetCurrentProcess() -> *mut c_void;
    fn CloseHandle(handle: *mut c_void) -> i32;
}
/// Errors name the failed phase and keep the original OS error unwrapped.
pub fn retain_until_process_exit() -> Result<(), (&'static str, io::Error)> {
    let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
    if job.is_null() {
        return Err(("create daemon job", io::Error::last_os_error()));
    }
    // Capture the OS error before CloseHandle can overwrite it.
    let fail = |phase| {
        let error = io::Error::last_os_error();
        unsafe {
            CloseHandle(job);
        }
        Err((phase, error))
    };
    let limits = ExtendedLimits {
        basic: BasicLimits {
            flags: 0x00002000,
            ..Default::default()
        },
        ..Default::default()
    }; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if unsafe {
        SetInformationJobObject(
            job,
            9,
            (&limits as *const ExtendedLimits).cast(),
            std::mem::size_of::<ExtendedLimits>() as u32,
        )
    } == 0
    {
        return fail("configure daemon job");
    }
    if unsafe { AssignProcessToJobObject(job, GetCurrentProcess()) } == 0 {
        return fail("assign daemon job");
    }
    // Deliberately do not CloseHandle during Rust cleanup: this job contains
    // this process too. OS teardown closes it after normal App/services cleanup,
    // or on force termination, killing any remaining descendants. No breakaway
    // is allowed and any ambient task/runner job stays in the nested hierarchy.
    Ok(())
}
