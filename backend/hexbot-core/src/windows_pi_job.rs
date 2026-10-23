//! Per-Pi descendant lifetime, not execution confinement. The process starts
//! suspended and cannot create descendants until assignment succeeds. Nested
//! membership retains the daemon/Task Scheduler job as well; no breakaway.
use super::windows_pi_ledger::{LIMIT, Ledger, process_ids};
use crate::windows_process_identity as identity;
use std::{
    collections::BTreeMap,
    ffi::c_void,
    io,
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    sync::OnceLock,
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
    fn IsProcessInJob(process: *mut c_void, job: *mut c_void, result: *mut i32) -> i32;
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
    root: OnceLock<(u32, u64, OwnedHandle)>,
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
        Ok(Self {
            job,
            port,
            root: OnceLock::new(),
        })
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
        // Retain a query/synchronize-only root handle before user code can run.
        let retained =
            identity::open(pid)?.ok_or_else(|| io::Error::other("Suspended Pi disappeared"))?;
        let created = identity::created(retained.as_raw_handle())?;
        if created != identity::created(process)? {
            return Err(io::Error::other("Suspended Pi identity changed"));
        }
        self.root
            .set((pid, created, retained))
            .map_err(|_| io::Error::other("Pi root was assigned twice"))?;
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
    fn accounting(&self) -> io::Result<Accounting> {
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
        Ok(info)
    }
    fn members(&self) -> io::Result<Vec<u32>> {
        // JOBOBJECT_BASIC_PROCESS_ID_LIST is two DWORDs followed by ULONG_PTRs.
        // A fixed cap makes ERROR_MORE_DATA an honest budget failure, never a
        // truncated list accepted as complete coverage.
        let header_words = 8 / std::mem::size_of::<usize>();
        let mut buffer = vec![0usize; LIMIT + header_words];
        let mut returned = 0;
        if unsafe {
            QueryInformationJobObject(
                self.job.as_raw_handle(),
                3,
                buffer.as_mut_ptr().cast(),
                std::mem::size_of_val(buffer.as_slice()) as u32,
                &mut returned,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        let header = buffer.as_ptr().cast::<u32>();
        let (assigned, listed) = unsafe { (*header, *header.add(1)) };
        process_ids(
            assigned,
            listed,
            &buffer[header_words..],
            returned as usize,
            std::mem::size_of_val(buffer.as_slice()),
        )
    }

    fn observe(
        &self,
        pid: u32,
        announced: bool,
        ledger: &mut Ledger,
        handles: &mut BTreeMap<u32, (u64, OwnedHandle)>,
    ) -> io::Result<()> {
        if let Some((created, _)) = handles.get(&pid) {
            return ledger.observe(pid, Ok(Some(*created)), announced);
        }
        let Some(process) = identity::open(pid)? else {
            // Only definitive absence, never access denied, supplies one
            // historical slot. A reused/live unrelated PID is not evidence.
            return ledger.observe(pid, Ok(None), announced);
        };
        let mut member = 0;
        if unsafe {
            IsProcessInJob(
                process.as_raw_handle(),
                self.job.as_raw_handle(),
                &mut member,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        if member == 0 {
            return Err(io::Error::other(
                "Pi job hint refers to an unrelated process",
            ));
        }
        let created = identity::created(process.as_raw_handle())?;
        ledger.observe(pid, Ok(Some(created)), announced)?;
        handles.insert(pid, (created, process));
        Ok(())
    }
    fn notification(&self, millis: u32, messages: &mut usize) -> io::Result<Option<(u32, u32)>> {
        let (mut kind, mut key, mut pid) = (0, 0, std::ptr::null_mut());
        if unsafe {
            GetQueuedCompletionStatus(
                self.port.as_raw_handle(),
                &mut kind,
                &mut key,
                &mut pid,
                millis,
            )
        } == 0
        {
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(258) {
                return Ok(None);
            }
            return Err(error);
        }
        *messages += 1;
        if *messages > LIMIT * 4 || key != 1 || !matches!(kind, 4 | 6 | 7 | 8) {
            return Err(io::Error::other(
                "Pi job notification budget/key/type invalid",
            ));
        }
        let pid = u32::try_from(pid as usize)
            .map_err(|_| io::Error::other("Invalid Pi job notification ID"))?;
        if (kind == 4 && pid != 0) || (kind != 4 && pid == 0) {
            return Err(io::Error::other("Invalid Pi job notification payload"));
        }
        Ok(Some((kind, pid)))
    }
    fn capture(
        &self,
        ledger: &mut Ledger,
        handles: &mut BTreeMap<u32, (u64, OwnedHandle)>,
        messages: &mut usize,
        deadline: Instant,
    ) -> io::Result<Accounting> {
        for pid in self.members()? {
            remaining(deadline)?;
            self.observe(pid, false, ledger, handles)?;
        }
        while let Some((kind, pid)) = self.notification(0, messages)? {
            remaining(deadline)?;
            if kind == 6 {
                self.observe(pid, true, ledger, handles)?;
            }
        }
        let info = self.accounting()?;
        ledger.total(info.total)?;
        Ok(info)
    }
    /// Accounting zero is not a kernel completion barrier. Retain each
    /// provable identity and require both exact association coverage and all
    /// handles signalled. Historical notification loss/reuse or rejected job
    /// associations can conservatively fail cleanup, never fabricate coverage.
    pub(super) fn terminate_and_wait(self) -> io::Result<()> {
        let deadline = Instant::now() + Duration::from_secs(15);
        let (mut ledger, mut handles, mut messages) = (Ledger::default(), BTreeMap::new(), 0);
        let captured = (|| {
            let (pid, created, process) = self
                .root
                .get()
                .ok_or_else(|| io::Error::other("Pi job root missing"))?;
            handles.insert(*pid, (*created, process.try_clone()?));
            ledger.observe(*pid, Ok(Some(*created)), false)?;
            self.capture(&mut ledger, &mut handles, &mut messages, deadline)
                .map(|_| ())
        })();
        // Even capture/ledger uncertainty must terminate the private job. Never
        // use a PID as termination authority or leave teardown on a happy path.
        let terminated = if unsafe { TerminateJobObject(self.job.as_raw_handle(), 1) } == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        };
        let completed = (|| {
            captured?;
            terminated?;
            loop {
                remaining(deadline)?;
                let info = self.capture(&mut ledger, &mut handles, &mut messages, deadline)?;
                let mut waited = false;
                for (_, process) in handles.values() {
                    if !identity::wait(process.as_raw_handle(), 0)? {
                        if !identity::wait(process.as_raw_handle(), remaining(deadline)?)? {
                            return Err(io::Error::new(
                                io::ErrorKind::TimedOut,
                                "Pi member did not signal exit",
                            ));
                        }
                        waited = true;
                        break;
                    }
                }
                if waited {
                    continue;
                }
                let final_info =
                    self.capture(&mut ledger, &mut handles, &mut messages, deadline)?;
                if info.active == 0
                    && final_info.active == 0
                    && info.total == final_info.total
                    && ledger.complete()
                    && all_signalled(&handles)?
                {
                    return Ok(());
                }
                // Await a raced discovery notification within the SAME deadline.
                // Missing history is an explicit failure when that budget ends.
                match self.notification(remaining(deadline)?, &mut messages)? {
                    Some((6, pid)) => self.observe(pid, true, &mut ledger, &mut handles)?,
                    Some(_) => {}
                    None => {
                        return Err(io::Error::new(
                            io::ErrorKind::TimedOut,
                            "Incomplete Pi job completion evidence",
                        ));
                    }
                }
            }
        })();
        // Keep all discovered handles through final waits even on a failed
        // capture. Preserve its original cause; Drop still closes the private
        // kill-on-close job if the explicit termination itself failed.
        if completed.is_err() {
            drop(self.job); // trigger the same private kill-on-close boundary
            for (_, process) in handles.values() {
                if let Ok(millis) = remaining(deadline) {
                    let _ = identity::wait(process.as_raw_handle(), millis);
                }
            }
        }
        completed
    }
}
fn remaining(deadline: Instant) -> io::Result<u32> {
    let millis = deadline
        .saturating_duration_since(Instant::now())
        .as_millis();
    if millis == 0 {
        return Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "Pi job cleanup deadline elapsed",
        ));
    }
    Ok(millis.min(u32::MAX as u128) as u32)
}

fn all_signalled(handles: &BTreeMap<u32, (u64, OwnedHandle)>) -> io::Result<bool> {
    for (_, process) in handles.values() {
        if !identity::wait(process.as_raw_handle(), 0)? {
            return Ok(false);
        }
    }
    Ok(true)
}
