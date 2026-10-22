//! Daemon child lifetime only. This is not tool isolation or a sandbox.
//! Retain one non-inheritable job handle until OS process teardown. Children
//! inherit membership before their first instruction, including grandchildren.
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
pub fn retain_until_process_exit() -> io::Result<()> {
    let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
    if job.is_null() {
        return Err(io::Error::last_os_error());
    }
    let limits = ExtendedLimits {
        basic: BasicLimits {
            flags: 0x00002000,
            ..Default::default()
        },
        ..Default::default()
    }; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    let configured = unsafe {
        SetInformationJobObject(
            job,
            9,
            (&limits as *const ExtendedLimits).cast(),
            std::mem::size_of::<ExtendedLimits>() as u32,
        )
    };
    let assigned =
        configured != 0 && unsafe { AssignProcessToJobObject(job, GetCurrentProcess()) } != 0;
    if !assigned {
        let error = io::Error::last_os_error();
        unsafe {
            CloseHandle(job);
        }
        return Err(error);
    }
    // Deliberately do not CloseHandle during Rust cleanup: this job contains
    // this process too. OS teardown closes it after normal App/services cleanup,
    // or on force termination, killing any remaining descendants. No breakaway
    // is allowed and any ambient task/runner job stays in the nested hierarchy.
    Ok(())
}
