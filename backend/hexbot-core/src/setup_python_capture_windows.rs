//! Win32 ownership boundary for one read-only probe. The worker never uses a
//! synchronous pipe reader, Tokio's blocking pool, or an I/O callback.
use super::{ChildState, Output, WorkerState};
use std::{
    cell::UnsafeCell,
    ffi::c_void,
    fs::File,
    io,
    mem::size_of,
    os::windows::io::{AsRawHandle, FromRawHandle, IntoRawHandle, OwnedHandle},
    process::{Child, Stdio},
    ptr,
    sync::Arc,
    thread::JoinHandle,
    time::{Duration, Instant},
};
type Handle = *mut c_void;
const INFINITE: u32 = u32::MAX;
const WAIT_TIMEOUT: u32 = 258;
const IO_INCOMPLETE: i32 = 996;
const IO_PENDING: i32 = 997;
const BROKEN_PIPE: i32 = 109;
const PIPE_CONNECTED: i32 = 535;
const NOT_FOUND: i32 = 1168;

#[repr(C)]
struct SecurityAttributes {
    length: u32,
    descriptor: Handle,
    inherit: i32,
}
#[repr(C)]
struct Overlapped {
    internal: usize,
    internal_high: usize,
    offset: u32,
    offset_high: u32,
    event: Handle,
}
struct IoStorage {
    request: Overlapped,
    buffer: [u8; 8192],
}
#[repr(C)]
struct SidAndAttributes {
    sid: Handle,
    attributes: u32,
}
#[repr(C)]
struct TokenGroups {
    count: u32,
    first: SidAndAttributes,
}
#[link(name = "kernel32")]
unsafe extern "system" {
    fn CreateNamedPipeW(
        name: *const u16,
        mode: u32,
        pipe_mode: u32,
        instances: u32,
        output: u32,
        input: u32,
        timeout: u32,
        security: *const SecurityAttributes,
    ) -> Handle;
    fn CreateFileW(
        name: *const u16,
        access: u32,
        share: u32,
        security: *const SecurityAttributes,
        disposition: u32,
        flags: u32,
        template: Handle,
    ) -> Handle;
    fn ConnectNamedPipe(pipe: Handle, request: *mut Overlapped) -> i32;
    fn ReadFile(
        pipe: Handle,
        buffer: *mut c_void,
        count: u32,
        read: *mut u32,
        request: *mut Overlapped,
    ) -> i32;
    fn GetOverlappedResult(
        pipe: Handle,
        request: *mut Overlapped,
        count: *mut u32,
        wait: i32,
    ) -> i32;
    fn CancelIoEx(pipe: Handle, request: *mut Overlapped) -> i32;
    fn CreateEventW(
        security: *const SecurityAttributes,
        manual: i32,
        initial: i32,
        name: *const u16,
    ) -> Handle;
    fn SetEvent(event: Handle) -> i32;
    fn ResetEvent(event: Handle) -> i32;
    fn WaitForMultipleObjects(count: u32, handles: *const Handle, all: i32, timeout: u32) -> u32;
    fn WaitForSingleObject(handle: Handle, timeout: u32) -> u32;
    fn CloseHandle(handle: Handle) -> i32;
    fn GetCurrentProcess() -> Handle;
    fn LocalFree(memory: Handle) -> Handle;
}
#[link(name = "advapi32")]
unsafe extern "system" {
    fn OpenProcessToken(process: Handle, access: u32, token: *mut Handle) -> i32;
    fn GetTokenInformation(
        token: Handle,
        class: u32,
        data: Handle,
        size: u32,
        needed: *mut u32,
    ) -> i32;
    fn ConvertSidToStringSidW(sid: Handle, text: *mut *mut u16) -> i32;
    fn ConvertStringSecurityDescriptorToSecurityDescriptorW(
        text: *const u16,
        revision: u32,
        descriptor: *mut Handle,
        size: *mut u32,
    ) -> i32;
}
fn owned(raw: Handle) -> io::Result<OwnedHandle> {
    if raw.is_null() || raw == -1isize as Handle {
        Err(io::Error::last_os_error())
    } else {
        Ok(unsafe { OwnedHandle::from_raw_handle(raw) })
    }
}
fn event() -> io::Result<OwnedHandle> {
    owned(unsafe { CreateEventW(ptr::null(), 1, 0, ptr::null()) })
}
fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(Some(0)).collect()
}
struct LocalMemory(Handle);
impl Drop for LocalMemory {
    fn drop(&mut self) {
        unsafe {
            LocalFree(self.0);
        }
    }
}
fn security() -> io::Result<LocalMemory> {
    let mut token = ptr::null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), 8, &mut token) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let token = owned(token)?;
    let mut needed = 0;
    let first =
        unsafe { GetTokenInformation(token.as_raw_handle(), 28, ptr::null_mut(), 0, &mut needed) };
    let error = io::Error::last_os_error();
    if first != 0
        || error.raw_os_error() != Some(122)
        || needed < size_of::<TokenGroups>() as u32
        || needed > 65536
    {
        return Err(io::Error::other(format!(
            "query logon SID size: {error}; size {needed}"
        )));
    }
    // Aligned, still-live TOKEN_GROUPS storage; all SID pointers are consumed
    // before releasing it. TokenLogonSid must supply exactly one logon SID.
    let mut storage = vec![0usize; (needed as usize).div_ceil(size_of::<usize>())];
    if unsafe {
        GetTokenInformation(
            token.as_raw_handle(),
            28,
            storage.as_mut_ptr().cast(),
            needed,
            &mut needed,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    let groups = unsafe { &*storage.as_ptr().cast::<TokenGroups>() };
    if groups.count != 1 || groups.first.attributes & 0xc0000000 != 0xc0000000 {
        return Err(io::Error::other("expected exactly one current logon SID"));
    }
    let mut sid_text = ptr::null_mut();
    if unsafe { ConvertSidToStringSidW(groups.first.sid, &mut sid_text) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let sid_memory = LocalMemory(sid_text.cast());
    let mut length = 0;
    while length < 256 && unsafe { *sid_text.add(length) } != 0 {
        length += 1;
    }
    if length == 256 {
        return Err(io::Error::other("logon SID text exceeds bound"));
    }
    let sid = String::from_utf16(unsafe { std::slice::from_raw_parts(sid_text, length) })
        .map_err(io::Error::other)?;
    drop(sid_memory);
    let mut descriptor = ptr::null_mut();
    // Only this logon SID. GA here is the server DACL; the client below requests
    // FILE_WRITE_DATA|SYNCHRONIZE, never FILE_GENERIC_WRITE/create-instance.
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            wide(&format!("D:P(A;;GA;;;{sid})")).as_ptr(),
            1,
            &mut descriptor,
            ptr::null_mut(),
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(LocalMemory(descriptor))
}
#[derive(Clone, Copy)]
enum Pending {
    Connect,
    Read,
}
struct Pipe {
    server: Option<OwnedHandle>,
    event: Option<OwnedHandle>,
    // Never move or borrow this allocation mutably after submission. Raw field
    // pointers are derived through UnsafeCell. No buffer references exist until
    // the exact request has a terminal result; resetting/rearming requires idle.
    storage: Box<UnsafeCell<IoStorage>>,
    pending: Option<Pending>,
    eof: bool,
    cancelled: bool,
}
impl Pipe {
    fn new(descriptor: Handle) -> io::Result<(Self, Vec<u16>)> {
        let name = wide(&format!(r"\\.\pipe\hexbot-python-{}", uuid::Uuid::new_v4()));
        let attributes = SecurityAttributes {
            length: size_of::<SecurityAttributes>() as u32,
            descriptor,
            inherit: 0,
        };
        let server = owned(unsafe {
            CreateNamedPipeW(
                name.as_ptr(),
                1 | 0x40000000 | 0x80000,
                8,
                1,
                0,
                8192,
                0,
                &attributes,
            )
        })?;
        let event = event()?;
        let storage = Box::new(UnsafeCell::new(IoStorage {
            request: Overlapped {
                internal: 0,
                internal_high: 0,
                offset: 0,
                offset_high: 0,
                event: event.as_raw_handle(),
            },
            buffer: [0; 8192],
        }));
        Ok((
            Self {
                server: Some(server),
                event: Some(event),
                storage,
                pending: None,
                eof: false,
                cancelled: false,
            },
            name,
        ))
    }
    fn raw(&self) -> Handle {
        self.server
            .as_ref()
            .map_or(ptr::null_mut(), AsRawHandle::as_raw_handle)
    }
    fn request(&self) -> *mut Overlapped {
        unsafe { ptr::addr_of_mut!((*self.storage.get()).request) }
    }
    fn reset(&self) -> io::Result<()> {
        debug_assert!(self.pending.is_none());
        let event = self
            .event
            .as_ref()
            .expect("live operation event")
            .as_raw_handle();
        if unsafe { ResetEvent(event) } == 0 {
            return Err(io::Error::last_os_error());
        }
        unsafe {
            self.request().write(Overlapped {
                internal: 0,
                internal_high: 0,
                offset: 0,
                offset_high: 0,
                event,
            });
        }
        Ok(())
    }
    fn connect(&mut self) -> io::Result<()> {
        self.reset()?;
        self.pending = Some(Pending::Connect);
        if unsafe { ConnectNamedPipe(self.raw(), self.request()) } != 0 {
            self.pending = None;
            return Ok(());
        }
        let error = io::Error::last_os_error();
        match error.raw_os_error() {
            Some(PIPE_CONNECTED) => {
                self.pending = None;
                Ok(())
            }
            Some(IO_PENDING) => {
                self.pending = Some(Pending::Connect);
                Ok(())
            }
            _ => {
                self.pending = None;
                Err(error)
            }
        }
    }
    fn read(&mut self) -> io::Result<Option<u32>> {
        self.reset()?;
        let buffer = unsafe { ptr::addr_of_mut!((*self.storage.get()).buffer).cast::<c_void>() };
        self.pending = Some(Pending::Read);
        let result = unsafe { ReadFile(self.raw(), buffer, 8192, ptr::null_mut(), self.request()) };
        let error = if result == 0 {
            Some(io::Error::last_os_error())
        } else {
            None
        };
        if result != 0 || error.as_ref().and_then(io::Error::raw_os_error) == Some(IO_PENDING) {
            self.pending = Some(Pending::Read);
            return self.collect();
        }
        self.pending = None; // Immediate failure did not submit asynchronous I/O.
        if error.as_ref().and_then(io::Error::raw_os_error) == Some(BROKEN_PIPE) {
            self.eof = !self.cancelled;
            return Ok(None);
        }
        Err(error.expect("ReadFile error saved"))
    }
    fn collect(&mut self) -> io::Result<Option<u32>> {
        let Some(kind) = self.pending else {
            return Ok(None);
        };
        let mut count = 0;
        let result = unsafe { GetOverlappedResult(self.raw(), self.request(), &mut count, 0) };
        let error = if result == 0 {
            Some(io::Error::last_os_error())
        } else {
            None
        };
        if error.as_ref().and_then(io::Error::raw_os_error) == Some(IO_INCOMPLETE) {
            return Ok(None);
        }
        // Terminal result consumed exactly once, including cancellation errors.
        self.pending = None;
        if result != 0 {
            return Ok(if matches!(kind, Pending::Read) {
                Some(count)
            } else {
                None
            });
        }
        if error.as_ref().and_then(io::Error::raw_os_error) == Some(BROKEN_PIPE)
            && !self.cancelled
            && matches!(kind, Pending::Read)
        {
            self.eof = true;
            return Ok(None);
        }
        Err(error.expect("GetOverlappedResult error saved"))
    }
    fn bytes(&self, count: u32) -> &[u8] {
        debug_assert!(self.pending.is_none() && count <= 8192);
        unsafe {
            std::slice::from_raw_parts(
                ptr::addr_of!((*self.storage.get()).buffer).cast::<u8>(),
                count as usize,
            )
        }
    }
    fn cancel(&mut self) -> io::Result<()> {
        self.cancelled = true;
        if self.pending.is_some() && unsafe { CancelIoEx(self.raw(), self.request()) } == 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() != Some(NOT_FOUND) {
                return Err(error);
            }
        }
        // NOT_FOUND is not settlement. collect still consumes this slot.
        Ok(())
    }
}
// Nothing holding pending storage may unwind independently of Owner. It installs
// each pipe before any connect/read and owns the child immediately after spawn.
struct Owner {
    pipes: [Option<Pipe>; 2],
    child: Option<Child>,
    output: Output,
    stop: Arc<OwnedHandle>,
    deadline: Instant,
    cleanup: Duration,
    cleanup_deadline: Option<Instant>,
    finished: bool,
}
impl Owner {
    fn new(stop: Arc<OwnedHandle>, deadline: Instant, cleanup: Duration) -> Self {
        let mut output = Output::empty();
        output.settlement.worker = WorkerState::Running;
        Self {
            pipes: [None, None],
            child: None,
            output,
            stop,
            deadline,
            cleanup,
            cleanup_deadline: None,
            finished: false,
        }
    }
    fn run(&mut self, mut command: std::process::Command) -> io::Result<()> {
        let descriptor = security()?;
        for index in 0..2 {
            let (pipe, name) = Pipe::new(descriptor.0)?;
            self.pipes[index] = Some(pipe);
            self.output.settlement.pipes_closed = false;
            let client = owned(unsafe {
                CreateFileW(
                    name.as_ptr(),
                    0x00100002,
                    0,
                    ptr::null(),
                    3,
                    0,
                    ptr::null_mut(),
                )
            })?;
            let pipe = self.pipes[index].as_mut().expect("installed pipe");
            pipe.connect()?;
            let file = File::from(client);
            if index == 0 {
                command.stdout(Stdio::from(file));
            } else {
                command.stderr(Stdio::from(file));
            }
        }
        drop(descriptor);
        self.check_active()?;
        let spawned = command.spawn();
        // std retains the original Stdio handles. Always drop them, including
        // on spawn failure, before waiting for any pipe EOF.
        drop(command);
        self.child = Some(spawned?);
        self.output.settlement.child = ChildState::Unconfirmed;
        loop {
            self.check_active()?;
            self.reap()?;
            let mut immediate = false;
            for index in 0..2 {
                let pipe = self.pipes[index].as_mut().expect("installed pipe");
                let bytes = pipe.collect()?;
                if let Some(count) = bytes {
                    self.output.append(index, pipe.bytes(count));
                    immediate = true;
                }
                if pipe.pending.is_none() && !pipe.eof && self.output.capture_failure.is_none() {
                    if let Some(count) = pipe.read()? {
                        self.output.append(index, pipe.bytes(count));
                        immediate = true;
                    }
                }
                self.output.settlement.natural_eof[index] = pipe.eof;
            }
            if self.output.capture_failure.is_some() {
                return Ok(());
            }
            if self.output.reaped() && self.pipes.iter().all(|p| p.as_ref().is_some_and(|p| p.eof))
            {
                return Ok(());
            }
            if !immediate {
                self.wait(Some(self.deadline), true)?;
            }
        }
    }
    fn check_active(&self) -> io::Result<()> {
        match unsafe { WaitForSingleObject(self.stop.as_raw_handle(), 0) } {
            0 => return Err(io::Error::other("probe wrapper cancelled")),
            WAIT_TIMEOUT => {}
            _ => return Err(io::Error::last_os_error()),
        }
        if Instant::now() >= self.deadline {
            return Err(io::Error::other(
                "probe operation deadline expired before completion and pipe EOF",
            ));
        }
        Ok(())
    }
    fn reap(&mut self) -> io::Result<()> {
        if self.output.settlement.child == ChildState::Unconfirmed {
            if let Some(status) = self.child.as_mut().expect("owned child").try_wait()? {
                self.output.status = status.code();
                self.output.settlement.child = ChildState::Reaped;
            }
        }
        Ok(())
    }
    fn wait(&self, deadline: Option<Instant>, active: bool) -> io::Result<()> {
        let mut handles = Vec::with_capacity(4);
        if active {
            handles.push(self.stop.as_raw_handle());
        }
        for pipe in self.pipes.iter().flatten() {
            if pipe.pending.is_some() {
                handles.push(pipe.event.as_ref().expect("live event").as_raw_handle());
            }
        }
        if self.output.settlement.child == ChildState::Unconfirmed {
            handles.push(self.child.as_ref().expect("owned child").as_raw_handle());
        }
        if handles.is_empty() {
            return Ok(());
        }
        wait_events(&handles, deadline)
    }
    fn wait_child(&mut self) {
        if self.output.settlement.child != ChildState::Unconfirmed {
            return;
        }
        match self.child.as_mut().expect("owned child").wait() {
            Ok(status) => {
                self.output.status = status.code();
                self.output.settlement.child = ChildState::Reaped;
            }
            Err(error) => {
                self.output
                    .fail(format!("owned child wait cannot confirm reap: {error}"));
                self.output.cleanup_unconfirmed();
                loop {
                    std::thread::park();
                }
            }
        }
    }
    fn threshold(&mut self) {
        if self.cleanup_deadline.is_some_and(|d| Instant::now() >= d) {
            self.output.cleanup_unconfirmed();
        }
    }
    fn settle(&mut self) {
        if self.finished {
            return;
        }
        if self.output.capture_failure.is_some() {
            self.cleanup_deadline
                .get_or_insert_with(|| Instant::now() + self.cleanup);
            // Request both exact cancellations AND child stop before any wait.
            for (index, pipe) in self
                .pipes
                .iter_mut()
                .enumerate()
                .filter_map(|(i, p)| p.as_mut().map(|p| (i, p)))
            {
                if let Err(error) = pipe.cancel() {
                    self.output.fail(format!("cancel stream {index}: {error}"));
                }
            }
            if self.output.settlement.child == ChildState::Unconfirmed {
                if let Err(error) = self.child.as_mut().expect("owned child").kill() {
                    self.output
                        .fail(format!("stop directly owned probe: {error}"));
                }
            }
        }
        while self.output.settlement.child == ChildState::Unconfirmed
            || self.pipes.iter().flatten().any(|p| p.pending.is_some())
        {
            for (index, pipe) in self
                .pipes
                .iter_mut()
                .enumerate()
                .filter_map(|(i, p)| p.as_mut().map(|p| (i, p)))
            {
                match pipe.collect() {
                    Ok(Some(count)) => self.output.append(index, pipe.bytes(count)),
                    Ok(None) => {}
                    Err(error) => self.output.fail(format!("settle stream {index}: {error}")),
                }
            }
            if let Err(error) = self.reap() {
                self.output
                    .fail(format!("reap directly owned probe: {error}"));
                self.wait_child();
                self.threshold();
            }
            let pending = self.output.settlement.child == ChildState::Unconfirmed
                || self.pipes.iter().flatten().any(|p| p.pending.is_some());
            if !pending {
                break;
            }
            self.threshold();
            let deadline = self
                .cleanup_deadline
                .filter(|_| !self.output.settlement.cleanup_unconfirmed);
            if let Err(error) = self.wait(deadline, false) {
                self.output.fail(format!("cleanup event wait: {error}"));
                // A failed wait is never settlement. Fall back to waiting on
                // the exact outstanding operations, retaining all storage. This
                // OS wait may block; elapsed threshold failure remains latched.
                for (index, pipe) in self
                    .pipes
                    .iter_mut()
                    .enumerate()
                    .filter_map(|(i, p)| p.as_mut().map(|p| (i, p)))
                {
                    if pipe.pending.is_some() {
                        let event = pipe.event.as_ref().expect("live event").as_raw_handle();
                        if unsafe { WaitForSingleObject(event, INFINITE) } != 0 {
                            let error = io::Error::last_os_error();
                            self.output.fail(format!(
                                "exact operation event cannot confirm completion {index}: {error}"
                            ));
                            self.output.cleanup_unconfirmed();
                            // No terminal result: retain the submitted storage.
                            loop {
                                std::thread::park();
                            }
                        }
                    }
                    match pipe.collect() {
                        Ok(Some(count)) => self.output.append(index, pipe.bytes(count)),
                        Ok(None) => {}
                        Err(error) => self.output.fail(format!(
                            "blocking completion acknowledgement {index}: {error}"
                        )),
                    }
                }
                self.wait_child();
                self.threshold();
            }
        }
        // Even if a blocking OS call eventually settled everything, crossing
        // the shared threshold is permanent failure, never a new success.
        if self.cleanup_deadline.is_some() {
            self.threshold();
        }
        for pipe in self.pipes.iter_mut().flatten() {
            debug_assert!(pipe.pending.is_none());
            for handle in [&mut pipe.server, &mut pipe.event] {
                if let Some(handle) = handle.take() {
                    let raw = handle.into_raw_handle();
                    if unsafe { CloseHandle(raw) } == 0 {
                        let error = io::Error::last_os_error();
                        let _retained = unsafe { OwnedHandle::from_raw_handle(raw) };
                        self.output
                            .fail(format!("close settled pipe/event: {error}"));
                        self.output.cleanup_unconfirmed();
                        // An unconfirmed close cannot authorize return/free.
                        loop {
                            std::thread::park();
                        }
                    }
                }
            }
        }
        self.output.settlement.pipes_closed = true;
        self.child.take();
        self.finished = true;
    }
}
impl Drop for Owner {
    fn drop(&mut self) {
        if !self.finished {
            self.output.fail("probe worker unwound before settlement");
            self.settle();
        }
    }
}
fn wait_events(handles: &[Handle], deadline: Option<Instant>) -> io::Result<()> {
    let timeout = deadline.map_or(INFINITE, |d| remaining_ms(d, Instant::now()));
    let result =
        unsafe { WaitForMultipleObjects(handles.len() as u32, handles.as_ptr(), 0, timeout) };
    if result < handles.len() as u32 || result == WAIT_TIMEOUT {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}
fn remaining_ms(deadline: Instant, now: Instant) -> u32 {
    deadline
        .saturating_duration_since(now)
        .as_millis()
        .min((INFINITE - 1) as u128) as u32
}
struct Worker {
    stop: Arc<OwnedHandle>,
    thread: Option<JoinHandle<Output>>,
}
impl Worker {
    fn join(&mut self) -> Output {
        // The worker does not use a wrapper-held lock or Tokio progress.
        let result = self.thread.take().expect("owned worker").join();
        match result {
            Ok(mut output) => {
                output.settlement.worker = WorkerState::Joined;
                output
            }
            Err(_) => {
                // Owner's unwind guard settles resources before this join ends.
                let mut output = Output::empty();
                output.fail("capture worker panic; result unavailable");
                output.settlement.child = ChildState::Unconfirmed;
                output.settlement.pipes_closed = false;
                output.cleanup_unconfirmed();
                output.settlement.worker = WorkerState::Joined;
                output
            }
        }
    }
}
impl Drop for Worker {
    fn drop(&mut self) {
        if self.thread.is_some() {
            unsafe {
                SetEvent(self.stop.as_raw_handle());
            }
            // A failed SetEvent cannot detach: the worker also has its original
            // operation deadline. Drop still waits for actual ownership release.
            let _ = self.join();
        }
    }
}
fn start(
    command: tokio::process::Command,
    deadline: Instant,
    cleanup: Duration,
) -> io::Result<(Worker, tokio::sync::oneshot::Receiver<()>)> {
    let stop = Arc::new(event()?);
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let worker_stop = stop.clone();
    // into_std retains argv/cwd/env/stdin/creation flags. Actual Owner cleanup
    // replaces Tokio's lost kill_on_drop; it is never used as reap evidence.
    let command = command.into_std();
    let thread = std::thread::Builder::new()
        .name("python-probe-capture".into())
        .spawn(move || {
            let mut owner = Owner::new(worker_stop, deadline, cleanup);
            let result =
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| owner.run(command)));
            match result {
                Ok(Ok(())) => {}
                Ok(Err(error)) => owner.output.fail(format!("probe API/process: {error}")),
                Err(panic) => {
                    let message = panic
                        .downcast_ref::<String>()
                        .map(String::as_str)
                        .or_else(|| panic.downcast_ref::<&str>().copied())
                        .unwrap_or("non-string panic");
                    owner.output.fail(format!(
                        "probe worker panic during capture: {}",
                        message.chars().take(512).collect::<String>()
                    ));
                }
            }
            owner.settle();
            // Notification is nonblocking and never needs receiver consumption.
            let _ = sender.send(());
            std::mem::replace(&mut owner.output, Output::empty())
        })?;
    Ok((
        Worker {
            stop,
            thread: Some(thread),
        },
        receiver,
    ))
}
pub(crate) async fn capture(
    command: tokio::process::Command,
    operation: Duration,
    cleanup: Duration,
) -> Output {
    let deadline = Instant::now() + operation;
    match start(command, deadline, cleanup) {
        Ok((mut worker, receiver)) => {
            let _ = receiver.await;
            worker.join()
        }
        Err(error) => {
            let mut output = Output::empty();
            output.fail(format!(
                "start probe capture before child creation: {error}"
            ));
            output
        }
    }
}

#[cfg(test)]
#[path = "setup_python_capture_tests.rs"]
mod tests;
