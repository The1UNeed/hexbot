//! Bounded subprocess transport for Pi's LF-delimited RPC protocol.
//!
//! This is not a Hermes adapter. A successful `prompt` response only acknowledges
//! acceptance: clients must consume events through `agent_settled` to observe idle.
//! Supply the executable and all arguments explicitly, including `--mode rpc`.

use std::{
    collections::HashMap,
    path::PathBuf,
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

/// Input already enqueued under the session's event gate. Retains command
/// admission until preflight replies, even when the RPC client disconnects.
pub(crate) struct InputReply {
    response: oneshot::Receiver<Result<PiResponse, PiError>>,
    done: watch::Receiver<Option<PiError>>,
    _admission: OwnedSemaphorePermit,
}
impl InputReply {
    pub(crate) async fn wait(mut self) -> Result<PiResponse, PiError> {
        tokio::select! {
            biased;
            result = &mut self.response => result.map_err(|_| PiError::Exited)?,
            error = terminal(&mut self.done) => Err(error),
        }
    }
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
        input: Option<String>,
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
    input: Option<String>,
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
    admission: Arc<Semaphore>,
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
        let mut child = Command::new(&options.executable)
            .args(&options.args)
            .env_clear()
            .envs(std::env::vars().filter(|(name, _)| inherited_environment(name)))
            .envs(&options.env)
            .current_dir(&options.working_dir)
            .env("PI_CODING_AGENT_DIR", &options.agent_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|_| PiError::Io("spawn"))?;
        let stdin = child.stdin.take().ok_or(PiError::Io("stdin"))?;
        let stdout = child.stdout.take().ok_or(PiError::Io("stdout"))?;
        let (requests, request_rx) = mpsc::channel(options.request_capacity);
        let (event_tx, receiver) = mpsc::channel(options.event_capacity);
        let (stop, stop_rx) = watch::channel(None);
        let (done_tx, done) = watch::channel(None);
        let max_record_bytes = options.max_record_bytes;
        let admission = Arc::new(Semaphore::new(options.request_capacity));
        tokio::spawn(supervise(
            child, stdin, stdout, request_rx, event_tx, stop_rx, done_tx, options,
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

    /// Commit an input before Stop can claim the event gate. Unlike an async
    /// send, this cannot enqueue a pre-Stop input behind the abort command.
    pub(crate) fn try_input(&self, command: &Value, intent: &str) -> Result<InputReply, PiError> {
        let admission = self
            .inner
            .admission
            .clone()
            .try_acquire_owned()
            .map_err(|_| PiError::Capacity)?;
        let name = command["type"]
            .as_str()
            .filter(|name| matches!(*name, "prompt" | "steer"))
            .ok_or(PiError::InvalidCommand("expected prompt or steer"))?;
        if command.get("id").is_some() {
            return Err(PiError::InvalidCommand("id is assigned by the transport"));
        }
        let id = format!(
            "hexbot-{}",
            self.inner.next_id.fetch_add(1, Ordering::Relaxed)
        );
        let mut command = command.clone();
        command["id"] = Value::String(id.clone());
        let bytes = self.serialize(&command)?;
        let stop = self.inner.stop.borrow();
        if let Some(error) = stop.as_ref().or(self.inner.done.borrow().as_ref()) {
            return Err(error.clone());
        }
        let (reply, response) = oneshot::channel();
        self.inner
            .requests
            .try_send(Request::Command {
                id,
                command: name.into(),
                input: Some(intent.into()),
                bytes,
                reply,
            })
            .map_err(|error| match error {
                mpsc::error::TrySendError::Full(_) => PiError::Capacity,
                mpsc::error::TrySendError::Closed(_) => PiError::Exited,
            })?;
        Ok(InputReply {
            response,
            done: self.inner.done.clone(),
            _admission: admission,
        })
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
                input: None,
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
        self.respond_extension_with(admission, id, fields, deadline)
    }

    /// Wait for the extension reply slot, so a caller can then commit its
    /// reply synchronously with `respond_extension_with`.
    pub(crate) async fn extension_permit(
        &self,
        deadline: Duration,
    ) -> Result<OwnedSemaphorePermit, PiError> {
        let mut stop = self.inner.stop.subscribe();
        let mut done = self.inner.done.clone();
        tokio::time::timeout(deadline, async {
            tokio::select! {
                biased;
                error = terminal(&mut stop) => Err(error),
                error = terminal(&mut done) => Err(error),
                permit = self.inner.extension_admission.clone().acquire_owned() => permit.map_err(|_| PiError::Capacity),
            }
        })
        .await
        .map_err(|_| PiError::Timeout)?
    }

    pub(crate) fn respond_extension_with(
        &self,
        admission: OwnedSemaphorePermit,
        id: &str,
        fields: Value,
        deadline: Duration,
    ) -> Result<ExtensionWrite, PiError> {
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
                    Request::Command { id, command, input, bytes, reply } => {
                        if pending.len() >= options.request_capacity { let _ = reply.send(Err(PiError::Capacity)); continue; }
                        match writes.try_send(WriteRecord { bytes, written: None, _extension_admission: None }) {
                            Ok(()) => {
                                pending.insert(id, Pending { command, input, reply });
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
    let reason = if cleanup_failed {
        PiError::Cleanup
    } else {
        reason
    };
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
        let request = pending.remove(&response.id).unwrap();
        // Put preflight disposition in the same ordered stream as user events.
        // Daemon scheduling must not attribute identical text to a later steer.
        let input = request.input.map(|intent| serde_json::json!({"type":"hexbot_input_preflight","intent":intent,"disposition":if response.success { response.data.as_ref().map(|data| &data["disposition"]) } else { None }}));
        let _ = request.reply.send(Ok(response));
        Ok(input)
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
                    admission: Arc::new(Semaphore::new(1)),
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
                input: None,
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
