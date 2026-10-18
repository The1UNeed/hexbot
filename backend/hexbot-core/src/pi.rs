//! Bounded subprocess transport for Pi's LF-delimited RPC protocol.
//!
//! This is not a Hermes adapter. A successful `prompt` response only acknowledges
//! acceptance: clients must consume events through `agent_settled` to observe idle.
//! Supply the executable and all arguments explicitly, including `--mode rpc`.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

use serde::Deserialize;
use serde_json::Value;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::Command,
    sync::{OwnedSemaphorePermit, Semaphore, mpsc, oneshot, watch},
};

/// The levels Pi's `--thinking` accepts; Pi clamps each to what the model supports.
pub const THINKING_LEVELS: &[&str] = &["off", "minimal", "low", "medium", "high", "xhigh", "max"];

#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum PiError {
    #[error("invalid bot transport configuration: {0}")]
    Configuration(&'static str),
    #[error("invalid bot command: {0}")]
    InvalidCommand(&'static str),
    #[error("Bot connection failed during {0}")]
    Io(&'static str),
    #[error("invalid bot response: {0}")]
    Protocol(&'static str),
    #[error("The bot stopped unexpectedly")]
    Exited,
    #[error("The bot request timed out")]
    Timeout,
    #[error("The bot request was cancelled")]
    Cancelled,
    #[error("The bot stopped")]
    Shutdown,
    #[error("Too many pending bot requests")]
    Capacity,
    #[error("The bot could not stop cleanly")]
    Cleanup,
}

#[derive(Clone, Debug)]
pub struct PiOptions {
    #[cfg(test)]
    write_gate: Option<Arc<Semaphore>>,
    #[cfg(test)]
    write_queued: Option<mpsc::UnboundedSender<()>>,
    pub executable: PathBuf,
    pub args: Vec<String>,
    /// Per-profile credentials and per-session extension configuration.
    pub env: std::collections::BTreeMap<String, String>,
    pub working_dir: PathBuf,
    /// Explicitly isolates Pi's credentials, settings, sessions and resources.
    pub agent_dir: PathBuf,
    /// Maximum bytes in one JSONL record, excluding LF (including optional CR).
    pub max_record_bytes: usize,
    /// Events buffered ahead of the consumer. When full, the supervisor stops
    /// reading Pi's stdout until the consumer catches up; nothing is dropped.
    pub event_capacity: usize,
    pub request_capacity: usize,
}

impl PiOptions {
    pub fn new(
        executable: impl Into<PathBuf>,
        working_dir: impl Into<PathBuf>,
        agent_dir: impl Into<PathBuf>,
    ) -> Self {
        Self {
            #[cfg(test)]
            write_gate: None,
            #[cfg(test)]
            write_queued: None,
            executable: executable.into(),
            args: vec![],
            env: std::collections::BTreeMap::new(),
            working_dir: working_dir.into(),
            agent_dir: agent_dir.into(),
            max_record_bytes: 1024 * 1024,
            event_capacity: 128,
            request_capacity: 32,
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
pub struct PiResponse {
    pub id: String,
    pub command: String,
    pub success: bool,
    #[serde(default)]
    pub data: Option<Value>,
    #[serde(default)]
    pub error: Option<String>,
}

type Reply = oneshot::Sender<Result<PiResponse, PiError>>;
type Written = oneshot::Sender<Result<(), PiError>>;

/// An extension response already committed to the transport queue. A failed
/// write can be reported, but must not cause the response to be sent again.
pub(crate) struct ExtensionWrite {
    response: oneshot::Receiver<Result<(), PiError>>,
    done: watch::Receiver<Option<PiError>>,
    deadline: Duration,
}

impl ExtensionWrite {
    pub(crate) async fn wait(mut self) -> Result<(), PiError> {
        tokio::time::timeout(self.deadline, async {
            tokio::select! {
                biased;
                result = &mut self.response => result.map_err(|_| PiError::Exited)?,
                error = terminal(&mut self.done) => Err(error),
            }
        })
        .await
        .map_err(|_| PiError::Timeout)?
    }
}
enum Request {
    Command {
        id: String,
        command: String,
        bytes: Vec<u8>,
        reply: Reply,
    },
    Extension {
        bytes: Vec<u8>,
        reply: Written,
        admission: OwnedSemaphorePermit,
    },
}
impl Request {
    fn reject(self, error: PiError) {
        match self {
            Self::Command { reply, .. } => {
                let _ = reply.send(Err(error));
            }
            Self::Extension { reply, .. } => {
                let _ = reply.send(Err(error));
            }
        }
    }
}
struct WriteRecord {
    bytes: Vec<u8>,
    written: Option<Written>,
    _extension_admission: Option<OwnedSemaphorePermit>,
}
struct Pending {
    command: String,
    reply: Reply,
}

struct BoundedRecord {
    bytes: Vec<u8>,
    limit: usize,
}

impl std::io::Write for BoundedRecord {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if bytes.len() > self.limit.saturating_sub(self.bytes.len()) {
            return Err(std::io::Error::other("record exceeds byte limit"));
        }
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

struct Inner {
    #[cfg(test)]
    cleanup_failure: std::sync::atomic::AtomicBool,
    requests: mpsc::Sender<Request>,
    stop: watch::Sender<Option<PiError>>,
    done: watch::Receiver<Option<PiError>>,
    next_id: AtomicU64,
    admission: Semaphore,
    extension_admission: Arc<Semaphore>,
    max_record_bytes: usize,
}

impl Drop for Inner {
    fn drop(&mut self) {
        self.stop.send_replace(Some(PiError::Shutdown));
    }
}

/// Clones share one process. Dropping the last handle terminates and reaps it
/// while the Tokio runtime remains alive. Call `shutdown` before runtime teardown.
#[derive(Clone)]
pub struct PiProcess {
    inner: Arc<Inner>,
}

pub struct PiEvents {
    receiver: mpsc::Receiver<Value>,
    done: watch::Receiver<Option<PiError>>,
}

impl PiEvents {
    /// Drains already received events, then returns the terminal transport error.
    pub async fn recv(&mut self) -> Result<Value, PiError> {
        match self.receiver.recv().await {
            Some(event) => Ok(event),
            None => Err(terminal(&mut self.done).await),
        }
    }
}

struct CancelRequest {
    stop: watch::Sender<Option<PiError>>,
    armed: bool,
}
impl Drop for CancelRequest {
    fn drop(&mut self) {
        if self.armed {
            self.stop.send_replace(Some(PiError::Cancelled));
        }
    }
}

use crate::credentials::inherited_environment;

/// JavaScript entry points run through Node directly, including on Windows.
/// Batch launchers would reparse the section's arguments through cmd.exe.
pub(crate) fn javascript_entry(executable: &Path) -> bool {
    executable
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            ["js", "mjs", "cjs"]
                .iter()
                .any(|kind| extension.eq_ignore_ascii_case(kind))
        })
}

pub(crate) fn executable_command(executable: &Path) -> Command {
    executable_command_in(executable, std::env::var_os("PATH").as_deref())
}

pub(crate) fn executable_command_in(
    executable: &Path,
    search_path: Option<&std::ffi::OsStr>,
) -> Command {
    #[cfg(windows)]
    if let Some(entry) = npm_entry(executable, search_path) {
        return executable_command_in(&entry, search_path);
    }
    #[cfg(not(windows))]
    let _ = search_path;
    if javascript_entry(executable) {
        let bundled = executable
            .parent()
            .and_then(Path::parent)
            .map(|root| root.join(if cfg!(windows) { "node.exe" } else { "node" }))
            .filter(|path| path.is_file());
        let node = std::env::var_os("HEXBOT_NODE_EXECUTABLE")
            .map(PathBuf::from)
            .or(bundled)
            .unwrap_or_else(|| PathBuf::from("node"));
        let mut command = Command::new(node);
        command.arg(executable);
        command
    } else {
        Command::new(executable)
    }
}

#[cfg(windows)]
fn npm_entry(executable: &Path, search_path: Option<&std::ffi::OsStr>) -> Option<PathBuf> {
    let name = executable.file_name()?.to_str()?.to_ascii_lowercase();
    let name = match name.as_str() {
        "npm" | "npm.cmd" => "npm",
        "npx" | "npx.cmd" => "npx",
        _ => return None,
    };
    let mut roots = Vec::new();
    if executable.is_absolute() {
        roots.push(executable.parent()?.to_owned());
    } else if executable
        .parent()
        .is_some_and(|parent| !parent.as_os_str().is_empty())
    {
        return None;
    } else {
        roots.extend(std::env::split_paths(search_path.unwrap_or_default()));
    }
    roots
        .into_iter()
        .flat_map(|root| {
            [
                root.join(format!("node_modules/npm/bin/{name}-cli.js")),
                root.join(format!("../npm/bin/{name}-cli.js")),
            ]
        })
        .find(|entry| entry.is_file())
        .and_then(|entry| entry.canonicalize().ok())
}

/// Retain the Windows job until all protocol IO has stopped. The child starts
/// suspended, so it cannot create a descendant before joining the job.
pub(crate) struct ChildTree {
    #[cfg(windows)]
    _job: std::os::windows::io::OwnedHandle,
    #[cfg(windows)]
    sandbox: Option<crate::windows_sandbox::SandboxCleanup>,
}

pub(crate) fn spawn_child(
    command: &mut Command,
) -> std::io::Result<(tokio::process::Child, ChildTree)> {
    #[cfg(windows)]
    if Path::new(command.as_std().get_program())
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            ["cmd", "bat"]
                .iter()
                .any(|kind| extension.eq_ignore_ascii_case(kind))
        })
    {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "Batch launchers require a native executable or JavaScript entry point",
        ));
    }
    command.kill_on_drop(true);
    #[cfg(windows)]
    let cleanup = crate::windows_sandbox::cleanup_command(command.as_std());
    #[cfg(windows)]
    command.creation_flags(
        windows_sys::Win32::System::Threading::CREATE_SUSPENDED
            | windows_sys::Win32::System::Threading::CREATE_NO_WINDOW,
    );
    let mut child = command.spawn()?;
    match ChildTree::attach(
        &child,
        #[cfg(windows)]
        cleanup,
    ) {
        Ok(tree) => Ok((child, tree)),
        Err(error) => {
            let _ = child.start_kill();
            Err(error)
        }
    }
}

impl Drop for ChildTree {
    fn drop(&mut self) {
        let _ = self.finish();
    }
}

impl ChildTree {
    pub(crate) fn finish(&mut self) -> std::io::Result<()> {
        #[cfg(not(windows))]
        {
            Ok(())
        }
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            // Closing the job also kills descendants, but termination completes
            // asynchronously. Wait before publishing shutdown or removing grants.
            unsafe {
                windows_sys::Win32::System::JobObjects::TerminateJobObject(
                    self._job.as_raw_handle(),
                    1,
                )
            };
            let deadline = std::time::Instant::now() + Duration::from_secs(2);
            while self.active() && std::time::Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(1));
            }
            if self.active() {
                return Err(std::io::Error::other("child job could not stop"));
            }
            if let Some(cleanup) = &mut self.sandbox {
                cleanup
                    .cleanup()
                    .map_err(|_| std::io::Error::other("sandbox cleanup failed"))?;
            }
            Ok(())
        }
    }
}

impl ChildTree {
    #[cfg(windows)]
    pub(crate) fn active(&self) -> bool {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::JobObjects::{
            JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JobObjectBasicAccountingInformation,
            QueryInformationJobObject,
        };
        let mut accounting: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { std::mem::zeroed() };
        let success = unsafe {
            QueryInformationJobObject(
                self._job.as_raw_handle(),
                JobObjectBasicAccountingInformation,
                (&mut accounting as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
                std::mem::size_of_val(&accounting) as u32,
                std::ptr::null_mut(),
            )
        };
        success == 0 || accounting.ActiveProcesses > 0
    }

    fn attach(
        child: &tokio::process::Child,
        #[cfg(windows)] cleanup: Option<crate::windows_sandbox::SandboxCleanup>,
    ) -> std::io::Result<Self> {
        #[cfg(not(windows))]
        {
            let _ = child;
            Ok(Self {})
        }
        #[cfg(windows)]
        {
            use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
            use windows_sys::Win32::{
                Foundation::{FILETIME, INVALID_HANDLE_VALUE},
                System::{
                    Diagnostics::ToolHelp::{
                        CreateToolhelp32Snapshot, TH32CS_SNAPTHREAD, THREADENTRY32, Thread32First,
                        Thread32Next,
                    },
                    JobObjects::{
                        AssignProcessToJobObject, CreateJobObjectW,
                        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
                        JobObjectExtendedLimitInformation, SetInformationJobObject,
                    },
                    Threading::{
                        GetThreadTimes, OpenThread, ResumeThread, THREAD_QUERY_LIMITED_INFORMATION,
                        THREAD_SUSPEND_RESUME,
                    },
                },
            };
            let failure = std::io::Error::last_os_error;
            // Every handle here is uniquely owned and never inherited by children.
            let raw = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
            if raw.is_null() {
                return Err(failure());
            }
            let job = unsafe { OwnedHandle::from_raw_handle(raw) };
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if unsafe {
                SetInformationJobObject(
                    raw,
                    JobObjectExtendedLimitInformation,
                    (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                    std::mem::size_of_val(&limits) as u32,
                )
            } == 0
            {
                return Err(failure());
            }
            let process = child
                .raw_handle()
                .ok_or_else(|| std::io::Error::other("child handle unavailable"))?;
            if unsafe { AssignProcessToJobObject(raw, process) } == 0 {
                return Err(failure());
            }
            let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
            if snapshot == INVALID_HANDLE_VALUE {
                return Err(failure());
            }
            let snapshot = unsafe { OwnedHandle::from_raw_handle(snapshot) };
            let mut thread: THREADENTRY32 = unsafe { std::mem::zeroed() };
            thread.dwSize = std::mem::size_of_val(&thread) as u32;
            let mut found = unsafe { Thread32First(snapshot.as_raw_handle(), &mut thread) };
            let mut threads = Vec::new();
            while found != 0 {
                if Some(thread.th32OwnerProcessID) == child.id() {
                    let handle = unsafe {
                        OpenThread(
                            THREAD_SUSPEND_RESUME | THREAD_QUERY_LIMITED_INFORMATION,
                            0,
                            thread.th32ThreadID,
                        )
                    };
                    if handle.is_null() {
                        return Err(failure());
                    }
                    let handle = unsafe { OwnedHandle::from_raw_handle(handle) };
                    let mut creation: FILETIME = unsafe { std::mem::zeroed() };
                    let mut exit: FILETIME = unsafe { std::mem::zeroed() };
                    let mut kernel: FILETIME = unsafe { std::mem::zeroed() };
                    let mut user: FILETIME = unsafe { std::mem::zeroed() };
                    if unsafe {
                        GetThreadTimes(
                            handle.as_raw_handle(),
                            &mut creation,
                            &mut exit,
                            &mut kernel,
                            &mut user,
                        )
                    } == 0
                    {
                        return Err(failure());
                    }
                    let created =
                        ((creation.dwHighDateTime as u64) << 32) | creation.dwLowDateTime as u64;
                    threads.push((created, handle));
                }
                found = unsafe { Thread32Next(snapshot.as_raw_handle(), &mut thread) };
            }
            threads.sort_by_key(|(created, _)| *created);
            let Some((created, primary)) = threads.first() else {
                return Err(std::io::Error::other("suspended child thread unavailable"));
            };
            // Injected auxiliary threads need not be suspended and snapshot
            // order is unspecified. The primary thread was created first.
            if threads.get(1).is_some_and(|(next, _)| next == created) {
                return Err(std::io::Error::other("primary child thread is ambiguous"));
            }
            match unsafe { ResumeThread(primary.as_raw_handle()) } {
                1 => Ok(Self {
                    _job: job,
                    sandbox: cleanup,
                }),
                u32::MAX => Err(failure()),
                _ => Err(std::io::Error::other("primary child thread did not resume")),
            }
        }
    }
}
pub fn provider_environment(name: &str, provider: &str) -> bool {
    inherited_environment(name)
        || match provider {
            "bedrock" | "amazon-bedrock" => name.starts_with("AWS_"),
            "vertex" | "google-vertex" => {
                name.starts_with("GOOGLE_") || name.starts_with("CLOUDSDK_")
            }
            _ => false,
        }
}

impl PiProcess {
    pub fn spawn(options: PiOptions) -> Result<(Self, PiEvents), PiError> {
        if options.max_record_bytes == 0
            || options.event_capacity == 0
            || options.request_capacity == 0
        {
            return Err(PiError::Configuration("buffer capacities must be positive"));
        }
        if !options.working_dir.is_absolute() || !options.agent_dir.is_absolute() {
            return Err(PiError::Configuration(
                "working_dir and agent_dir must be absolute",
            ));
        }
        // Diagnostics can contain credentials or model inputs. Discard them at
        // the OS boundary rather than retaining or returning them with errors.
        let mut command = executable_command(&options.executable);
        if options
            .executable
            .file_stem()
            .is_some_and(|name| name == "node")
            && let Some(script) = std::env::var_os("HEXBOT_PI_SCRIPT")
        {
            command.arg(script);
        }
        command
            .args(&options.args)
            .env_clear()
            .envs(std::env::vars().filter(|(name, _)| inherited_environment(name)))
            .envs(&options.env)
            .current_dir(&options.working_dir)
            .env("PI_CODING_AGENT_DIR", &options.agent_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.env(
            "HEXBOT_DAEMON_EXECUTABLE",
            std::env::var_os("HEXBOT_DAEMON_EXECUTABLE")
                .map(PathBuf::from)
                .or_else(|| std::env::current_exe().ok())
                .ok_or(PiError::Io("daemon executable"))?,
        );
        #[cfg(windows)]
        command.env(
            "HEXBOT_GIT_SCAN_ENV",
            serde_json::to_string(&crate::windows_sandbox::git_scan_environment())
                .map_err(|_| PiError::Io("Git scan environment"))?,
        );
        let (mut child, tree) = spawn_child(&mut command).map_err(|_| PiError::Io("spawn"))?;
        let stdin = child.stdin.take().ok_or(PiError::Io("stdin"))?;
        let stdout = child.stdout.take().ok_or(PiError::Io("stdout"))?;
        let (requests, request_rx) = mpsc::channel(options.request_capacity);
        let (event_tx, receiver) = mpsc::channel(options.event_capacity);
        let (stop, stop_rx) = watch::channel(None);
        let (done_tx, done) = watch::channel(None);
        let max_record_bytes = options.max_record_bytes;
        let admission = Semaphore::new(options.request_capacity);
        tokio::spawn(supervise(
            child, tree, stdin, stdout, request_rx, event_tx, stop_rx, done_tx, options,
        ));
        Ok((
            Self {
                inner: Arc::new(Inner {
                    #[cfg(test)]
                    cleanup_failure: std::sync::atomic::AtomicBool::new(false),
                    requests,
                    stop,
                    done: done.clone(),
                    next_id: AtomicU64::new(1),
                    admission,
                    extension_admission: Arc::new(Semaphore::new(1)),
                    max_record_bytes,
                }),
            },
            PiEvents { receiver, done },
        ))
    }

    /// Commands must be objects with a string `type`, without a caller-supplied
    /// `id`. Cancellation abandons the reply, not the shared bot process.
    /// Timed out commands may still have side effects and must not be retried.
    pub async fn request(
        &self,
        mut command: Value,
        deadline: Duration,
    ) -> Result<PiResponse, PiError> {
        self.request_with_policy(&mut command, Some(deadline), false)
            .await
    }

    /// Dedicated callers may opt into terminating the process on cancellation.
    pub async fn request_cancellable(
        &self,
        mut command: Value,
        deadline: Duration,
    ) -> Result<PiResponse, PiError> {
        self.request_with_policy(&mut command, Some(deadline), true)
            .await
    }

    /// Prompt acceptance can include auto-compaction. Terminal events, Stop, or
    /// shutdown bound its lifetime rather than a short acknowledgement timer.
    pub async fn prompt(&self, command: &mut Value) -> Result<PiResponse, PiError> {
        self.request_with_policy(command, None, false).await
    }

    async fn request_with_policy(
        &self,
        command: &mut Value,
        deadline: Option<Duration>,
        kill_on_cancel: bool,
    ) -> Result<PiResponse, PiError> {
        let _admission = self
            .inner
            .admission
            .try_acquire()
            .map_err(|_| PiError::Capacity)?;
        let object = command
            .as_object_mut()
            .ok_or(PiError::InvalidCommand("expected an object"))?;
        if object.contains_key("id") {
            return Err(PiError::InvalidCommand("id is assigned by the transport"));
        }
        let name = object
            .get("type")
            .and_then(Value::as_str)
            .filter(|name| !name.is_empty())
            .ok_or(PiError::InvalidCommand("type must be a nonempty string"))?
            .to_owned();
        if name == "extension_ui_response" {
            return Err(PiError::InvalidCommand(
                "extension UI responses require their original request id",
            ));
        }
        let id = format!(
            "hexbot-{}",
            self.inner.next_id.fetch_add(1, Ordering::Relaxed)
        );
        object.insert("id".into(), Value::String(id.clone()));
        let bytes = self.serialize(command);
        command.as_object_mut().unwrap().remove("id");
        let bytes = bytes?;
        let (reply, response) = oneshot::channel();
        self.send(
            Request::Command {
                id,
                command: name,
                bytes,
                reply,
            },
            response,
            deadline,
            kill_on_cancel,
        )
        .await
    }

    /// Answer a Pi extension dialog. The response keeps Pi's original id and
    /// only waits for the write, because Pi sends no command acknowledgement.
    /// One reserved admission slot lets dialogs finish even when commands fill
    /// every request slot. `fields` contains `value`, `confirmed`, or `cancelled`.
    pub async fn respond_extension(
        &self,
        id: &str,
        fields: Value,
        deadline: Duration,
    ) -> Result<(), PiError> {
        // Admission is part of the deadline too: a previous committed response
        // can still own its slot after its caller times out or is cancelled.
        tokio::time::timeout(deadline, async {
            let mut stop = self.inner.stop.subscribe();
            let mut done = self.inner.done.clone();
            if let Some(error) = stop.borrow().clone() { return Err(error); }
            if let Some(error) = done.borrow().clone() { return Err(error); }
            let admission = tokio::select! {
                biased;
                error = terminal(&mut stop) => return Err(error),
                error = terminal(&mut done) => return Err(error),
                permit = self.inner.extension_admission.clone().acquire_owned() => permit.map_err(|_| PiError::Capacity)?,
            };
            let bytes = self.extension_record(id, fields)?;
            let (reply, response) = oneshot::channel();
            self.send(Request::Extension { bytes, reply, admission }, response, None, false).await
        }).await.map_err(|_| PiError::Timeout)?
    }

    /// Commit an approval without waiting for capacity. Callers can keep their
    /// evidence lock through this enqueue, then await only the write receipt.
    /// A full or stopped transport leaves the approval uncommitted.
    pub(crate) fn try_respond_extension(
        &self,
        id: &str,
        fields: Value,
        deadline: Duration,
    ) -> Result<ExtensionWrite, PiError> {
        let admission = self
            .inner
            .extension_admission
            .clone()
            .try_acquire_owned()
            .map_err(|_| PiError::Capacity)?;
        let bytes = self.extension_record(id, fields)?;
        let stop = self.inner.stop.borrow();
        if let Some(error) = stop.as_ref().or(self.inner.done.borrow().as_ref()) {
            return Err(error.clone());
        }
        let (reply, response) = oneshot::channel();
        self.inner
            .requests
            .try_send(Request::Extension {
                bytes,
                reply,
                admission,
            })
            .map_err(|error| match error {
                mpsc::error::TrySendError::Full(_) => PiError::Capacity,
                mpsc::error::TrySendError::Closed(_) => PiError::Exited,
            })?;
        drop(stop);
        Ok(ExtensionWrite {
            response,
            done: self.inner.done.clone(),
            deadline,
        })
    }

    /// Wait until the extension reply slot is free, so a caller whose
    /// `try_respond_extension` found it busy can try once more. Gives up at
    /// the deadline or when the process stops; the retry then reports why.
    pub(crate) async fn extension_slot(&self, deadline: Duration) {
        let mut stop = self.inner.stop.subscribe();
        let mut done = self.inner.done.clone();
        let _ = tokio::time::timeout(deadline, async {
            tokio::select! {
                _ = terminal(&mut stop) => {}
                _ = terminal(&mut done) => {}
                _ = self.inner.extension_admission.acquire() => {}
            }
        })
        .await;
    }

    fn extension_record(&self, id: &str, mut fields: Value) -> Result<Vec<u8>, PiError> {
        if id.is_empty() {
            return Err(PiError::InvalidCommand("extension request id is empty"));
        }
        let object = fields
            .as_object_mut()
            .ok_or(PiError::InvalidCommand("expected an object"))?;
        if object.contains_key("type") || object.contains_key("id") {
            return Err(PiError::InvalidCommand(
                "extension id and type are assigned by the transport",
            ));
        }
        object.insert("type".into(), Value::String("extension_ui_response".into()));
        object.insert("id".into(), Value::String(id.to_owned()));
        self.serialize(&fields)
    }

    fn serialize(&self, value: &Value) -> Result<Vec<u8>, PiError> {
        let mut record = BoundedRecord {
            bytes: Vec::new(),
            limit: self.inner.max_record_bytes,
        };
        serde_json::to_writer(&mut record, value)
            .map_err(|_| PiError::InvalidCommand("record exceeds byte limit"))?;
        record.bytes.push(b'\n');
        Ok(record.bytes)
    }

    async fn send<T>(
        &self,
        request: Request,
        response: oneshot::Receiver<Result<T, PiError>>,
        deadline: Option<Duration>,
        kill_on_cancel: bool,
    ) -> Result<T, PiError> {
        let mut done = self.inner.done.clone();
        if let Some(error) = done.borrow().clone() {
            return Err(error);
        }
        let mut guard = CancelRequest {
            stop: self.inner.stop.clone(),
            armed: kill_on_cancel,
        };
        let wait = async {
            tokio::select! {
                biased;
                result = async {
                    self.inner.requests.send(request).await
                        .map_err(|_| PiError::Exited)?;
                    response.await.map_err(|_| PiError::Exited)?
                } => result,
                error = terminal(&mut done) => Err(error),
            }
        };
        let outcome = if let Some(deadline) = deadline {
            tokio::time::timeout(deadline, wait).await
        } else {
            Ok(wait.await)
        };
        guard.armed = false;
        match outcome {
            Ok(result) => result,
            Err(_) => {
                if kill_on_cancel {
                    self.inner.stop.send_replace(Some(PiError::Timeout));
                    terminal(&mut self.inner.done.clone()).await;
                }
                Err(PiError::Timeout)
            }
        }
    }

    #[cfg(test)]
    pub(crate) fn fail_cleanup(&self) {
        self.inner.cleanup_failure.store(true, Ordering::Release);
    }
    #[cfg(test)]
    pub(crate) fn hold_extension_admission(&self) -> OwnedSemaphorePermit {
        self.inner
            .extension_admission
            .clone()
            .try_acquire_owned()
            .unwrap()
    }
    /// Request SIGTERM cleanup on Unix, then force termination after one second.
    /// Success means the owned child was reaped. Forced reaping also has a one
    /// second deadline; OS cleanup failures are reported, never awaited forever.
    pub async fn shutdown(&self) -> Result<(), PiError> {
        self.inner.stop.send_replace(Some(PiError::Shutdown));
        let result = terminal(&mut self.inner.done.clone()).await;
        #[cfg(test)]
        if self.inner.cleanup_failure.load(Ordering::Acquire) {
            return Err(PiError::Cleanup);
        }
        match result {
            PiError::Cleanup => Err(PiError::Cleanup),
            _ => Ok(()),
        }
    }
}

async fn terminal(done: &mut watch::Receiver<Option<PiError>>) -> PiError {
    loop {
        if let Some(error) = done.borrow().clone() {
            return error;
        }
        if done.changed().await.is_err() {
            return PiError::Exited;
        }
    }
}

// One reader owns framing; one writer honors pipe backpressure independently.
// The supervisor bounds requests, records and events, and owns child cleanup.
#[allow(clippy::too_many_arguments)]
async fn supervise(
    mut child: tokio::process::Child,
    mut tree: ChildTree,
    mut stdin: tokio::process::ChildStdin,
    mut stdout: tokio::process::ChildStdout,
    mut requests: mpsc::Receiver<Request>,
    events: mpsc::Sender<Value>,
    mut stop: watch::Receiver<Option<PiError>>,
    done: watch::Sender<Option<PiError>>,
    options: PiOptions,
) {
    // At most request_capacity commands remain pending until Pi reads them,
    // and extension admission permits one response until its write completes.
    // Keep its slot in the actual writer queue too, not only in admission.
    let (writes, mut write_rx) = mpsc::channel::<WriteRecord>(options.request_capacity + 1);
    #[cfg(test)]
    let write_gate = options.write_gate.clone();
    let mut writer = tokio::spawn(async move {
        #[cfg(test)]
        if let Some(gate) = write_gate {
            let _permit = gate.acquire().await;
        }
        while let Some(record) = write_rx.recv().await {
            stdin
                .write_all(&record.bytes)
                .await
                .map_err(|_| PiError::Io("write"))?;
            stdin.flush().await.map_err(|_| PiError::Io("flush"))?;
            if let Some(written) = record.written {
                let _ = written.send(Ok(()));
            }
        }
        Ok::<(), PiError>(())
    });
    let mut writer_finished = false;
    let mut exited = false;
    let mut exit_deadline = tokio::time::Instant::now();
    let mut pending: HashMap<String, Pending> = HashMap::new();
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 8192];
    let reason = 'running: loop {
        tokio::select! {
            _ = stop.changed() => {
                break stop.borrow().clone().unwrap_or(PiError::Shutdown);
            }
            _ = tokio::time::sleep_until(exit_deadline), if exited => {
                break if buffer.is_empty() { PiError::Exited } else { PiError::Protocol("unterminated record") };
            }
            result = &mut writer => {
                writer_finished = true;
                break result.unwrap_or(Err(PiError::Io("writer task"))).err().unwrap_or(PiError::Exited);
            }
            result = stdout.read(&mut chunk) => {
                let count = match result { Ok(count) => count, Err(_) => break PiError::Io("read") };
                if count == 0 {
                    break if buffer.is_empty() { PiError::Exited } else { PiError::Protocol("unterminated record") };
                }
                for byte in &chunk[..count] {
                    if *byte == b'\n' {
                        if buffer.last() == Some(&b'\r') { buffer.pop(); }
                        let event = match record(&buffer, &mut pending) {
                            Ok(event) => event,
                            Err(error) => break 'running error,
                        };
                        buffer.clear();
                        // A slow consumer pauses stdout reads, so pipe backpressure
                        // reaches Pi instead of a dropped event ending the section.
                        if let Some(event) = event {
                            tokio::select! {
                                biased;
                                _ = stop.changed() => break 'running stop.borrow().clone().unwrap_or(PiError::Shutdown),
                                sent = events.send(event) => if sent.is_err() { break 'running PiError::Cancelled; },
                            }
                        }
                    } else {
                        if buffer.len() >= options.max_record_bytes { break 'running PiError::Protocol("record exceeds byte limit"); }
                        buffer.push(*byte);
                    }
                }
            }
            result = child.wait(), if !exited => {
                if result.is_err() { break PiError::Cleanup; }
                exited = true;
                // Consume any final buffered records, but do not wait forever
                // on stdout inherited by a descendant of the exited process.
                exit_deadline = tokio::time::Instant::now() + Duration::from_millis(100);
            }
            request = requests.recv() => {
                let Some(request) = request else { break PiError::Shutdown; };
                if exited { request.reject(PiError::Exited); continue; }
                match request {
                    Request::Command { id, command, bytes, reply } => {
                        if pending.len() >= options.request_capacity { let _ = reply.send(Err(PiError::Capacity)); continue; }
                        match writes.try_send(WriteRecord { bytes, written: None, _extension_admission: None }) {
                            Ok(()) => {
                                pending.insert(id, Pending { command, reply });
                                #[cfg(test)]
                                if let Some(queued) = &options.write_queued { let _ = queued.send(()); }
                            }
                            Err(mpsc::error::TrySendError::Full(_)) => { let _ = reply.send(Err(PiError::Capacity)); }
                            Err(mpsc::error::TrySendError::Closed(_)) => break PiError::Io("writer closed"),
                        }
                    }
                    Request::Extension { bytes, reply, admission } => {
                        if let Err(error) = writes.try_send(WriteRecord { bytes, written: Some(reply), _extension_admission: Some(admission) }) {
                            let full = matches!(error, mpsc::error::TrySendError::Full(_));
                            let record = error.into_inner();
                            if let Some(reply) = record.written { let _ = reply.send(Err(if full { PiError::Capacity } else { PiError::Io("writer closed") })); }
                            if !full { break PiError::Io("writer closed"); }
                        } else {
                            #[cfg(test)]
                            if let Some(queued) = &options.write_queued { let _ = queued.send(()); }
                        }
                    }
                }
            }
        }
    };
    // Keep stdin open throughout graceful shutdown. Closing it immediately
    // after SIGTERM can race Pi's input-EOF handler against tool cleanup.
    let graceful = !exited && signal_termination(&mut child);
    let cleanup_failed = !exited && terminate(&mut child, graceful).await.is_err();
    if !writer_finished {
        writer.abort();
        let _ = writer.await;
    }
    let cleanup_failed = tree.finish().is_err() || cleanup_failed;
    let reason = if cleanup_failed {
        PiError::Cleanup
    } else {
        reason
    };
    drop(tree);
    done.send_replace(Some(reason.clone()));
    for (_, request) in pending {
        let _ = request.reply.send(Err(reason.clone()));
    }
    requests.close();
    while let Some(request) = requests.recv().await {
        request.reject(reason.clone());
    }
}

fn signal_termination(child: &mut tokio::process::Child) -> bool {
    #[cfg(unix)]
    if let Some(pid) = child.id() {
        // The child is still owned and unreaped, so this PID cannot be reused.
        return unsafe { libc::kill(pid as libc::pid_t, libc::SIGTERM) } == 0;
    }
    #[cfg(not(unix))]
    let _ = child;
    false
}

async fn terminate(child: &mut tokio::process::Child, graceful: bool) -> Result<(), PiError> {
    match child.try_wait() {
        Ok(Some(_)) => return Ok(()),
        Err(_) => return Err(PiError::Cleanup),
        Ok(None) => {}
    }
    if graceful {
        match tokio::time::timeout(Duration::from_secs(1), child.wait()).await {
            Ok(Ok(_)) => return Ok(()),
            Ok(Err(_)) => return Err(PiError::Cleanup),
            Err(_) => {}
        }
    }
    let _ = child.start_kill();
    match tokio::time::timeout(Duration::from_secs(1), child.wait()).await {
        Ok(Ok(_)) => Ok(()),
        _ => Err(PiError::Cleanup),
    }
}

/// Resolve a response to its request, or return the event for the consumer.
fn record(bytes: &[u8], pending: &mut HashMap<String, Pending>) -> Result<Option<Value>, PiError> {
    let value: Value =
        serde_json::from_slice(bytes).map_err(|_| PiError::Protocol("invalid JSON"))?;
    let kind = value
        .get("type")
        .and_then(Value::as_str)
        .filter(|kind| !kind.is_empty())
        .ok_or(PiError::Protocol("missing record type"))?;
    if kind == "response" {
        let response: PiResponse =
            serde_json::from_value(value).map_err(|_| PiError::Protocol("invalid response"))?;
        let request = pending
            .get(&response.id)
            .ok_or(PiError::Protocol("unknown response id"))?;
        if request.command != response.command {
            return Err(PiError::Protocol("response command mismatch"));
        }
        if !response.success && response.error.is_none() {
            return Err(PiError::Protocol("failed response missing error"));
        }
        if let Some(request) = pending.remove(&response.id) {
            let _ = request.reply.send(Ok(response));
        }
        Ok(None)
    } else {
        Ok(Some(value))
    }
}

#[cfg(test)]
mod environment_policy_tests {
    use super::*;
    use crate::credentials::inherited_environment;
    #[test]
    fn cloud_credentials_pass_only_to_their_provider() {
        for name in [
            "AWS_PROFILE",
            "AWS_REGION",
            "AWS_ACCESS_KEY_ID",
            "AWS_SECRET_ACCESS_KEY",
            "AWS_SESSION_TOKEN",
            "AWS_BEARER_TOKEN_BEDROCK",
        ] {
            assert!(provider_environment(name, "amazon-bedrock"));
            assert!(!provider_environment(name, "google-vertex"));
            assert!(!inherited_environment(name));
        }
        for name in [
            "GOOGLE_APPLICATION_CREDENTIALS",
            "GOOGLE_CLOUD_PROJECT",
            "GOOGLE_CLOUD_LOCATION",
            "CLOUDSDK_CONFIG",
        ] {
            assert!(provider_environment(name, "google-vertex"));
            assert!(!provider_environment(name, "amazon-bedrock"));
            assert!(!inherited_environment(name));
        }
    }
}

#[cfg(all(test, windows))]
mod windows_command_tests {
    use super::*;
    #[test]
    fn npm_lookup_uses_owner_path_and_local_node_modules_shims() {
        let directory = tempfile::tempdir().unwrap();
        let bin = directory.path().join("node_modules/.bin");
        let script = directory.path().join("node_modules/npm/bin/npx-cli.js");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::create_dir_all(script.parent().unwrap()).unwrap();
        std::fs::write(&script, "// fixture").unwrap();
        std::fs::write(bin.join("npx.cmd"), "@echo must not run").unwrap();
        let search = std::env::join_paths([&bin]).unwrap();
        for executable in [PathBuf::from("npx"), bin.join("npx.cmd")] {
            let command = executable_command_in(&executable, Some(&search));
            assert_eq!(
                command.as_std().get_args().next().unwrap(),
                script.canonicalize().unwrap().as_os_str()
            );
        }
    }
    #[test]
    fn npm_launchers_use_the_javascript_entry_without_a_batch_interpreter() {
        let directory = tempfile::tempdir().unwrap();
        for name in ["npm", "npx"] {
            let script = directory
                .path()
                .join(format!("node_modules/npm/bin/{name}-cli.js"));
            std::fs::create_dir_all(script.parent().unwrap()).unwrap();
            std::fs::write(&script, "// fixture").unwrap();
            let shim = directory.path().join(format!("{name}.cmd"));
            std::fs::write(&shim, "@echo batch launchers must not run").unwrap();
            let command = executable_command(&shim);
            assert_eq!(
                command.as_std().get_args().next().unwrap(),
                script.canonicalize().unwrap().as_os_str()
            );
            assert!(
                !Path::new(command.as_std().get_program())
                    .extension()
                    .is_some_and(|extension| extension == "cmd")
            );
        }
    }
}

#[cfg(test)]
mod commit_tests {
    use super::*;
    use serde_json::json;

    fn transport() -> (PiProcess, mpsc::Receiver<Request>) {
        let (requests, receiver) = mpsc::channel(1);
        let (stop, _) = watch::channel(None);
        let (_, done) = watch::channel(None);
        (
            PiProcess {
                inner: Arc::new(Inner {
                    cleanup_failure: std::sync::atomic::AtomicBool::new(false),
                    requests,
                    stop,
                    done,
                    next_id: AtomicU64::new(1),
                    admission: Semaphore::new(1),
                    extension_admission: Arc::new(Semaphore::new(1)),
                    max_record_bytes: 1024,
                }),
            },
            receiver,
        )
    }

    #[tokio::test]
    async fn approval_commit_rejects_full_closed_and_stopped_queues() {
        let (process, mut requests) = transport();
        let (reply, _) = oneshot::channel();
        process
            .inner
            .requests
            .try_send(Request::Command {
                id: "hold".into(),
                command: "hold".into(),
                bytes: vec![],
                reply,
            })
            .unwrap();
        assert!(matches!(
            process.try_respond_extension(
                "dialog",
                json!({"value":"once"}),
                Duration::from_secs(5)
            ),
            Err(PiError::Capacity)
        ));
        requests.recv().await.unwrap();
        process.inner.stop.send_replace(Some(PiError::Shutdown));
        assert!(matches!(
            process.try_respond_extension(
                "dialog",
                json!({"value":"once"}),
                Duration::from_secs(5)
            ),
            Err(PiError::Shutdown)
        ));
        process.inner.stop.send_replace(None);
        requests.close();
        assert!(matches!(
            process.try_respond_extension(
                "dialog",
                json!({"value":"once"}),
                Duration::from_secs(5)
            ),
            Err(PiError::Exited)
        ));
        assert_eq!(process.inner.extension_admission.available_permits(), 1);
    }

    #[tokio::test]
    async fn writer_reserves_approval_capacity_until_actual_write_even_after_receipt_drop() {
        let home = tempfile::tempdir().unwrap();
        let script = home.path().join("pi.cjs");
        std::fs::write(
            &script,
            r#"require('node:readline').createInterface({input:process.stdin}).on('line', line => {
            const c = JSON.parse(line);
            process.stdout.write(JSON.stringify(c.type === 'extension_ui_response'
                ? {type:'written',id:c.id}
                : {type:'response',id:c.id,command:c.type,success:true})+'\n');
        });"#,
        )
        .unwrap();
        let gate = Arc::new(Semaphore::new(0));
        let (queued, mut records) = mpsc::unbounded_channel();
        let mut options = PiOptions::new("node", home.path(), home.path());
        options.args = vec![script.to_string_lossy().into_owned()];
        options.request_capacity = 2;
        options.write_gate = Some(gate.clone());
        options.write_queued = Some(queued);
        let (process, mut events) = PiProcess::spawn(options).unwrap();
        let mut commands = vec![];
        for _ in 0..2 {
            let caller = process.clone();
            commands.push(tokio::spawn(async move {
                caller
                    .request(json!({"type":"hold"}), Duration::from_secs(5))
                    .await
            }));
            tokio::time::timeout(Duration::from_secs(5), records.recv())
                .await
                .unwrap()
                .unwrap();
        }
        // Both command slots occupy the actual writer queue, not merely RPC admission.
        let write = process
            .try_respond_extension("first", json!({"value":"once"}), Duration::from_secs(5))
            .unwrap();
        tokio::time::timeout(Duration::from_secs(5), records.recv())
            .await
            .unwrap()
            .unwrap();
        drop(write);
        assert!(matches!(
            process.try_respond_extension(
                "second",
                json!({"value":"once"}),
                Duration::from_secs(5)
            ),
            Err(PiError::Capacity)
        ));
        assert_eq!(
            process
                .respond_extension(
                    "waiting",
                    json!({"cancelled":true}),
                    Duration::from_millis(10)
                )
                .await
                .unwrap_err(),
            PiError::Timeout
        );
        gate.add_permits(1);
        for command in commands {
            assert!(command.await.unwrap().unwrap().success);
        }
        assert_eq!(events.recv().await.unwrap()["id"], "first");
        process
            .respond_extension("second", json!({"cancelled":true}), Duration::from_secs(5))
            .await
            .unwrap();
        assert_eq!(events.recv().await.unwrap()["id"], "second");
        process.shutdown().await.unwrap();
        assert_eq!(
            process
                .respond_extension("stopped", json!({"cancelled":true}), Duration::from_secs(5))
                .await
                .unwrap_err(),
            PiError::Shutdown
        );
    }
}
