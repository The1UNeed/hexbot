//! One startup witness for the real PowerShell creator, not a supervisor/RPC.
use super::{process_handle::ProcessHandle, shutdown_output::Output, windows_paths};
#[path = "readiness_input.rs"]
mod readiness_input;
use readiness_input::ReadinessInput;
#[allow(dead_code)] // Reuse identity checks, not the production PID-opening helper.
#[path = "../../src/windows_process_identity.rs"]
mod identity;
use serde_json::{Value, json};
use std::{
    ffi::c_void,
    io,
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    path::Path,
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader, Lines, Take},
    net::{TcpListener, TcpStream},
    process::{Child, Command},
    sync::mpsc,
    time::{Instant, timeout_at},
};

#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetCurrentProcess() -> *mut c_void;
    fn DuplicateHandle(
        source: *mut c_void,
        original: *mut c_void,
        target: *mut c_void,
        copy: *mut *mut c_void,
        access: u32,
        inherit: i32,
        options: u32,
    ) -> i32;
    fn TerminateProcess(process: *mut c_void, code: u32) -> i32;
}
type Records = Lines<Take<BufReader<TcpStream>>>;
pub struct Startup {
    pub daemon: Option<ProcessHandle>,
    // Separate from the query/synchronize witness; never inherited or PID based.
    terminate: Option<OwnedHandle>,
    parent: ProcessHandle,
    listener: Option<TcpListener>,
    connection: Option<Records>,
    nonce: String,
    phase: String,
    versions: Value,
    error_code: Option<i64>,
    forward: bool,
    stdout: Output,
    stderr: Output,
    ready: mpsc::Receiver<Result<u16, String>>,
    drains: Vec<tokio::task::JoinHandle<()>>,
}
fn duplicate_termination(source: *mut c_void, original: *mut c_void) -> io::Result<OwnedHandle> {
    let mut copy = std::ptr::null_mut();
    if unsafe { DuplicateHandle(source, original, GetCurrentProcess(), &mut copy, 1, 0, 0) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { OwnedHandle::from_raw_handle(copy) })
}
pub async fn service_command(nonce: &str, forward: bool) -> (Command, TcpListener) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let quote = |s: &str| format!("'{}'", s.replace('\'', "''"));
    // Keep the original -Command path, without a new script execution-policy
    // dependency. The fixture is embedded in this exact test executable.
    let script = include_str!("service-parent-fixture.ps1");
    let command = format!(
        "& {{ {script} }} -Exe {} -Port {} -Nonce {} -Forward ${forward}",
        quote(env!("CARGO_BIN_EXE_hexbot")),
        listener.local_addr().unwrap().port(),
        quote(nonce)
    );
    let mut parent = Command::new(
        windows_paths::system_program("WindowsPowerShell/v1.0/powershell.exe").unwrap(),
    );
    parent.args(["-NoProfile", "-NonInteractive", "-Command", &command]);
    (parent, listener)
}
impl Startup {
    pub fn new(
        child: &mut Child,
        listener: Option<TcpListener>,
        nonce: &str,
        forward: bool,
    ) -> Self {
        let parent =
            ProcessHandle::duplicate(unsafe { GetCurrentProcess() }, child.raw_handle().unwrap())
                .unwrap();
        let stdout = Output::default();
        let stderr = Output::default();
        let (tx, ready) = mpsc::channel(2);
        let drains = vec![
            stdout.drain(child.stdout.take().unwrap(), Some(tx)),
            stderr.drain(child.stderr.take().unwrap(), None),
        ];
        let mut result = Self {
            daemon: None,
            terminate: None,
            parent,
            listener,
            connection: None,
            nonce: nonce.into(),
            phase: "spawned".into(),
            versions: Value::Null,
            error_code: None,
            forward,
            stdout,
            stderr,
            ready,
            drains,
        };
        if result.listener.is_none() {
            result.daemon = Some(
                ProcessHandle::duplicate(
                    unsafe { GetCurrentProcess() },
                    child.raw_handle().unwrap(),
                )
                .unwrap(),
            );
            result.terminate = Some(
                duplicate_termination(unsafe { GetCurrentProcess() }, child.raw_handle().unwrap())
                    .unwrap(),
            );
        }
        result
    }
    pub fn snapshot(&self) -> Value {
        json!({"nonce":self.nonce,"verifiedServiceCreator":!self.versions.is_null(),"verifiedReturnedChild":self.listener.is_some() && self.terminate.is_some(),"expectedDaemon":env!("CARGO_BIN_EXE_hexbot"),"phase":self.phase,"errorCode":self.error_code,"versions":self.versions,"parent":self.parent.snapshot(),"actualChild":self.daemon.as_ref().map(ProcessHandle::snapshot),"stdout":self.stdout.snapshot(),"stderr":self.stderr.snapshot(),"childStreams":if self.listener.is_none(){"direct"}else if self.forward {"B forwarded"}else{"A inherited, unobserved at child boundary"}})
    }
    async fn record(
        listener: &Option<TcpListener>,
        connection: &mut Option<Records>,
    ) -> Result<Value, String> {
        let Some(listener) = listener else {
            return std::future::pending().await;
        };
        if connection.is_none() {
            *connection = Some(
                BufReader::new(listener.accept().await.map_err(|e| e.to_string())?.0)
                    .take(4097)
                    .lines(),
            );
        }
        // Lines::next_line is cancellation safe in the readiness select. The
        // entire fixed-purpose witness, including versions and exit, is capped.
        let text = connection
            .as_mut()
            .unwrap()
            .next_line()
            .await
            .map_err(|e| e.to_string())?
            .ok_or("witness EOF")?;
        if connection.as_mut().unwrap().get_ref().limit() == 0 {
            return Err("oversized witness".into());
        }
        serde_json::from_str(&text).map_err(|_| "invalid witness record".into())
    }
    fn accept_child(&mut self, child: &Child, record: &Value) -> io::Result<()> {
        let number = |key: &str| {
            record[key]
                .as_str()
                .and_then(|s| s.parse::<u64>().ok())
                .ok_or_else(|| io::Error::other("invalid child identity"))
        };
        let original = usize::try_from(number("handle")?).map_err(io::Error::other)? as *mut c_void;
        let witness = ProcessHandle::duplicate(child.raw_handle().unwrap(), original)?;
        // Keep the actual returned object even if verification fails or it has
        // already exited. Only the fully verified live child gets a kill handle.
        self.daemon = Some(witness);
        let witness = self.daemon.as_ref().unwrap();
        if !witness.alive() {
            return Err(io::Error::other(format!(
                "actual child exited during startup: {}",
                witness.snapshot()
            )));
        }
        let expected = Path::new(env!("CARGO_BIN_EXE_hexbot")).canonicalize()?;
        if witness.pid == 0
            || witness.pid == self.parent.pid
            || record["parent"] != self.parent.pid
            || record["pid"] != witness.pid
            || number("created")? != identity::created(witness.raw())?
            || identity::created(witness.raw())? < identity::created(self.parent.raw())?
            || !identity::same_owner(witness.raw())?
            || identity::image(witness.raw())? != expected
            || !identity::snapshot()?.contains(&(witness.pid, self.parent.pid))
        {
            return Err(io::Error::other(
                "actual child identity/owner/image/creator verification failed",
            ));
        }
        self.terminate = Some(duplicate_termination(
            child.raw_handle().unwrap(),
            original,
        )?);
        Ok(())
    }
    async fn accept_record(&mut self, child: &Child, record: Value) -> Result<(), String> {
        if record["nonce"] != self.nonce {
            return Err("witness nonce mismatch".into());
        }
        let phase = record["phase"].as_str().ok_or("missing phase")?;
        match phase {
            "parent" => {
                if self.phase != "spawned" {
                    return Err("duplicate/out-of-order parent witness".into());
                }
                let born = self.parent.created().map_err(|e| e.to_string())?;
                let expected =
                    windows_paths::system_program("WindowsPowerShell/v1.0/powershell.exe")
                        .map_err(|e| e.to_string())?
                        .canonicalize()
                        .map_err(|e| e.to_string())?;
                if born == "0"
                    || record["pid"] != self.parent.pid
                    || record["created"].as_str() != Some(&born)
                    || !identity::same_owner(self.parent.raw()).map_err(|e| e.to_string())?
                    || identity::image(self.parent.raw()).map_err(|e| e.to_string())? != expected
                    || !self.parent.alive()
                {
                    return Err("PowerShell parent identity mismatch".into());
                }
                self.versions = json!({"clr":record["clr"],"systemDll":record["systemDll"],"powershell":record["powershell"]});
            }
            "starting" => {
                if self.phase != "parent" {
                    return Err("out-of-order start witness".into());
                }
            }
            "child" => {
                if self.phase != "starting" {
                    return Err("out-of-order child witness".into());
                }
                self.accept_child(child, &record)
                    .map_err(|e| e.to_string())?;
                self.connection
                    .as_mut()
                    .unwrap()
                    .get_mut()
                    .get_mut()
                    .get_mut()
                    .write_all(format!("{}\n", self.nonce).as_bytes())
                    .await
                    .map_err(|e| e.to_string())?;
            }
            "child-exit" | "start-error" | "forward-error" | "observe-error" => {
                self.phase = phase.to_owned();
                let code = record["code"]
                    .as_i64()
                    .ok_or("invalid native exit/error code")?;
                self.error_code = Some(code);
                return Err(format!("{phase}, native/exit code {code}"));
            }
            _ => return Err("unknown witness phase".into()),
        }
        self.phase = phase.to_owned();
        Ok(())
    }
    pub async fn ready(&mut self, child: &mut Child) -> Result<u16, String> {
        let mut input = ReadinessInput::new(child);
        let child = input.child();
        let deadline = Instant::now() + Duration::from_secs(45);
        let run = async {
            let mut port = None;
            loop {
                if let (Some(port), Some(daemon)) = (port, &self.daemon) {
                    if !daemon.alive() {
                        return Err(format!(
                            "child exited before readiness acceptance: {}",
                            daemon.snapshot()
                        ));
                    }
                    return Ok(port);
                }
                tokio::select! {
                    line=self.ready.recv(), if port.is_none()=> {port=Some(line.ok_or("stdout EOF before readiness")??);}
                    status=child.wait()=> {return Err(format!("parent exited before readiness: {status:?}"));}
                    record=Self::record(&self.listener,&mut self.connection)=> {self.accept_record(child,record?).await?;}
                }
            }
        };
        timeout_at(deadline, run)
            .await
            .map_err(|_| "45-second real readiness timeout".to_owned())?
    }
    // One existing 15s failure-cleanup budget, reserving its last 3s for an
    // owned-child force/reap. Fallback never converts the failed test to a pass.
    pub async fn cleanup(&self, child: &mut Child, deadline: Instant) -> bool {
        let _ = child.start_kill();
        let parent = matches!(
            timeout_at(deadline - Duration::from_secs(3), child.wait()).await,
            Ok(Ok(_))
        );
        let mut graceful = true;
        if let Some(daemon) = &self.daemon {
            let remaining =
                (deadline - Duration::from_secs(3)).saturating_duration_since(Instant::now());
            graceful = daemon.exits_within(remaining.as_millis().min(u32::MAX as u128) as u32);
            eprintln!("Owned child before fallback: {}", daemon.snapshot());
            if !graceful
                && let Some(termination) = &self.terminate
                && unsafe { TerminateProcess(termination.as_raw_handle(), 1) } == 0
            {
                eprintln!(
                    "Owned child fallback failed: {:?}",
                    io::Error::last_os_error().raw_os_error()
                );
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            let exited = daemon.exits_within(remaining.as_millis().min(u32::MAX as u128) as u32);
            eprintln!("Owned child after failure cleanup: {}", daemon.snapshot());
            if !exited {
                return false;
            }
        } else if self.listener.is_some() {
            // No actual-child authority was obtained. Do not claim a reap.
            return false;
        }
        if !graceful {
            eprintln!("Owned child required failure-only termination");
        }
        parent && Instant::now() <= deadline
    }
}
impl Drop for Startup {
    fn drop(&mut self) {
        for drain in &self.drains {
            drain.abort();
        }
    }
}
