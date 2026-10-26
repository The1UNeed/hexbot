//! Native-only controls for the exact private capture implementation. No test
//! changes a production hook, deadline, command or process-kill authority.
use super::*;
use std::{future::Future, path::Path, task::Poll};
const BOUND: Duration = Duration::from_secs(10);
const CLEANUP: Duration = Duration::from_secs(5);
#[link(name = "kernel32")]
unsafe extern "system" {
    fn OpenEventW(access: u32, inherit: i32, name: *const u16) -> Handle;
    fn GetStdHandle(which: u32) -> Handle;
    fn WriteFile(
        file: Handle,
        bytes: *const c_void,
        count: u32,
        written: *mut u32,
        request: *mut Overlapped,
    ) -> i32;
    fn OpenProcess(access: u32, inherit: i32, pid: u32) -> Handle;
    fn GetProcessHandleCount(process: Handle, count: *mut u32) -> i32;
    fn GetExitCodeProcess(process: Handle, code: *mut u32) -> i32;
}
fn signal(event: &OwnedHandle) {
    assert_ne!(
        unsafe { SetEvent(event.as_raw_handle()) },
        0,
        "{}",
        io::Error::last_os_error()
    );
}
fn wait(event: &OwnedHandle) {
    assert_eq!(
        unsafe { WaitForSingleObject(event.as_raw_handle(), BOUND.as_millis() as u32) },
        0,
        "{}",
        io::Error::last_os_error()
    );
}
fn named_event() -> (OwnedHandle, String) {
    let name = format!("Local\\hexbot-python-test-{}", uuid::Uuid::new_v4());
    let descriptor = security().unwrap();
    let attributes = SecurityAttributes {
        length: size_of::<SecurityAttributes>() as u32,
        descriptor: descriptor.0,
        inherit: 0,
    };
    (
        owned(unsafe { CreateEventW(&attributes, 1, 0, wide(&name).as_ptr()) }).unwrap(),
        name,
    )
}
fn open_event(name: &str) -> OwnedHandle {
    owned(unsafe { OpenEventW(0x00100002, 0, wide(name).as_ptr()) }).unwrap()
}
fn fixture_command(mode: &str) -> tokio::process::Command {
    let mut command = tokio::process::Command::new(std::env::current_exe().unwrap());
    let module = module_path!().split_once("::").unwrap().1;
    command
        .args([
            "--exact",
            &format!("{module}::capture_fixture"),
            "--nocapture",
        ])
        .env("HEXBOT_CAPTURE_FIXTURE", mode)
        .stdin(Stdio::null())
        .kill_on_drop(true);
    command
}
struct Fixture {
    ready: OwnedHandle,
    gate: OwnedHandle,
    ready_name: String,
    gate_name: String,
    directory: tempfile::TempDir,
    processes: Vec<OwnedHandle>,
}
impl Fixture {
    fn new() -> Self {
        let (ready, ready_name) = named_event();
        let (gate, gate_name) = named_event();
        Self {
            ready,
            gate,
            ready_name,
            gate_name,
            directory: tempfile::tempdir().unwrap(),
            processes: Vec::new(),
        }
    }
    fn command(&self, mode: &str) -> tokio::process::Command {
        let mut command = fixture_command(mode);
        command
            .current_dir(self.directory.path())
            .env("HEXBOT_CAPTURE_READY", &self.ready_name)
            .env("HEXBOT_CAPTURE_GATE", &self.gate_name)
            .env("HEXBOT_CAPTURE_DIRECTORY", self.directory.path());
        command
    }
    fn retain(&mut self, name: &str) -> u32 {
        let pid: u32 = std::fs::read_to_string(self.directory.path().join(name))
            .unwrap()
            .parse()
            .unwrap();
        // This exact PID comes from the fixture's started child while its gate
        // remains held. Retain a kernel wait handle; never terminate by PID.
        self.processes
            .push(owned(unsafe { OpenProcess(0x00101000, 0, pid) }).unwrap());
        pid
    }
    fn release_and_join(&mut self) {
        signal(&self.gate);
        for process in self.processes.drain(..) {
            wait(&process);
            let mut status = 0;
            assert_ne!(
                unsafe { GetExitCodeProcess(process.as_raw_handle(), &mut status) },
                0
            );
            assert_eq!(status, 0, "fixture writer must finish normally");
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        // Always release and wait for fixture writers, including assertion
        // unwind. Production capture never receives their process handles.
        unsafe {
            SetEvent(self.gate.as_raw_handle());
        }
        for process in &self.processes {
            unsafe {
                WaitForSingleObject(process.as_raw_handle(), BOUND.as_millis() as u32);
            }
        }
    }
}
fn write_stream(stream: u32, bytes: &[u8]) {
    let mut written = 0;
    assert_ne!(
        unsafe {
            WriteFile(
                GetStdHandle(stream),
                bytes.as_ptr().cast(),
                bytes.len() as u32,
                &mut written,
                ptr::null_mut(),
            )
        },
        0,
        "{}",
        io::Error::last_os_error()
    );
    assert_eq!(written as usize, bytes.len());
}
#[test]
fn capture_fixture() {
    let Ok(mode) = std::env::var("HEXBOT_CAPTURE_FIXTURE") else {
        return;
    };
    if mode == "stability" {
        // A separate exact-test process avoids unrelated suite threads/handles.
        // Its runtime has no blocking pool I/O or time/network driver to warm.
        let pid = std::process::id();
        // Keep the original baseline's thread count as the first Toolhelp
        // call. Observe its handle-count measurement gap separately.
        let before_runtime_handles = handles();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        let before = (handles(), threads());
        let after_baseline_threads_handles = handles();
        for round in 0..3 {
            let mut observation = StabilityRound::default();
            runtime.block_on(held_writers_once("both", Some(&mut observation)));
            let after = (handles(), threads());
            // Log only after the final sample, without retaining Fixture,
            // Output or an extra owned handle through that sample.
            if after != before {
                eprintln!(
                    "stability pid={pid} round={round} before_runtime_handles={before_runtime_handles} baseline={before:?} after_baseline_threads_handles={after_baseline_threads_handles} phases={observation:?} after_block_on={after:?}"
                );
            }
            assert_eq!(
                after, before,
                "owned worker/pipe/event/process handles must close"
            );
        }
        drop(runtime); // Must return after all workers joined, with no pool read.
        let after_runtime_drop = (handles(), threads());
        if after_runtime_drop != before {
            eprintln!(
                "stability pid={pid} after_runtime_drop={after_runtime_drop:?} baseline={before:?} before_runtime_handles={before_runtime_handles} after_baseline_threads_handles={after_baseline_threads_handles}"
            );
        }
        assert_eq!(after_runtime_drop, before);
        return;
    }
    let ready = open_event(&std::env::var("HEXBOT_CAPTURE_READY").unwrap());
    let gate = open_event(&std::env::var("HEXBOT_CAPTURE_GATE").unwrap());
    let directory = std::env::var_os("HEXBOT_CAPTURE_DIRECTORY").unwrap();
    assert_eq!(
        std::env::current_dir().unwrap().canonicalize().unwrap(),
        Path::new(&directory).canonicalize().unwrap(),
        "into_std must retain the owned cwd"
    );
    if mode == "holder" {
        let selection = std::env::var("HEXBOT_CAPTURE_STREAM").unwrap();
        let mut command = fixture_command("writer").into_std();
        command
            .env(
                "HEXBOT_CAPTURE_READY",
                std::env::var("HEXBOT_CAPTURE_READY").unwrap(),
            )
            .env(
                "HEXBOT_CAPTURE_GATE",
                std::env::var("HEXBOT_CAPTURE_GATE").unwrap(),
            )
            .env("HEXBOT_CAPTURE_DIRECTORY", &directory)
            .stdout(if selection == "stderr" {
                Stdio::null()
            } else {
                Stdio::inherit()
            })
            .stderr(if selection == "stdout" {
                Stdio::null()
            } else {
                Stdio::inherit()
            });
        let child = command.spawn().unwrap();
        drop(command);
        std::fs::write(Path::new(&directory).join("writer"), child.id().to_string()).unwrap();
        wait(&ready); // Writer is live and owns its intended inherited handles.
        drop(child); // Fixture parent below retains and joins its exact process.
        return;
    }
    if mode == "writer" {
        signal(&ready);
        wait(&gate);
        std::process::exit(0); // Do not let the harness print into a cancelled pipe.
    }
    std::fs::write(
        Path::new(&directory).join("root"),
        std::process::id().to_string(),
    )
    .unwrap();
    if mode == "both" {
        write_stream(-11i32 as u32, b""); // A zero-byte write is not EOF.
        write_stream(-11i32 as u32, b"early stdout\n");
        write_stream(-12i32 as u32, b"early stderr\n");
        signal(&ready);
        wait(&gate);
        write_stream(-11i32 as u32, b"late stdout\n");
        write_stream(-12i32 as u32, b"late stderr\n");
    } else if mode == "cap" {
        signal(&ready);
        write_stream(-12i32 as u32, b"stderr before cap\n");
        write_stream(-11i32 as u32, &vec![b'x'; super::super::OUTPUT_LIMIT + 1]);
        wait(&gate);
    } else if mode == "hang" {
        signal(&ready);
        wait(&gate);
    } else {
        panic!("unknown owned capture fixture mode");
    }
}
fn handles() -> u32 {
    let mut count = 0;
    assert_ne!(
        unsafe { GetProcessHandleCount(GetCurrentProcess(), &mut count) },
        0
    );
    count
}
#[repr(C)]
struct ThreadEntry {
    size: u32,
    usage: u32,
    thread: u32,
    owner: u32,
    base: i32,
    delta: i32,
    flags: u32,
}
#[link(name = "kernel32")]
unsafe extern "system" {
    fn CreateToolhelp32Snapshot(flags: u32, pid: u32) -> Handle;
    fn Thread32First(snapshot: Handle, entry: *mut ThreadEntry) -> i32;
    fn Thread32Next(snapshot: Handle, entry: *mut ThreadEntry) -> i32;
}
fn threads() -> usize {
    let snapshot = owned(unsafe { CreateToolhelp32Snapshot(4, 0) }).unwrap();
    let mut entry = ThreadEntry {
        size: size_of::<ThreadEntry>() as u32,
        usage: 0,
        thread: 0,
        owner: 0,
        base: 0,
        delta: 0,
        flags: 0,
    };
    let mut more = unsafe { Thread32First(snapshot.as_raw_handle(), &mut entry) };
    let mut count = 0;
    while more != 0 {
        count += usize::from(entry.owner == std::process::id());
        more = unsafe { Thread32Next(snapshot.as_raw_handle(), &mut entry) };
    }
    assert_eq!(io::Error::last_os_error().raw_os_error(), Some(18));
    count
}
fn settled(output: &Output) {
    assert!(output.settlement.pipes_closed);
    assert_eq!(output.settlement.worker, WorkerState::Joined);
    assert_ne!(output.settlement.child, ChildState::Unconfirmed);
}
#[tokio::test(flavor = "current_thread")]
async fn native_both_streams_zero_write_and_late_bytes_require_natural_eof() {
    let fixture = Fixture::new();
    let mut capture = Box::pin(super::super::capture(
        fixture.command("both"),
        BOUND,
        CLEANUP,
    ));
    std::future::poll_fn(|cx| {
        assert!(capture.as_mut().poll(cx).is_pending());
        Poll::Ready(())
    })
    .await;
    wait(&fixture.ready);
    signal(&fixture.gate);
    let output = capture.await;
    settled(&output);
    assert!(output.capture_failure.is_none());
    assert!(output.settlement.complete());
    for (bytes, early, late) in [
        (&output.stdout, "early stdout", "late stdout"),
        (&output.stderr, "early stderr", "late stderr"),
    ] {
        let text = String::from_utf8_lossy(bytes);
        assert!(text.contains(early) && text.contains(late), "{text}");
    }
}
#[derive(Debug, Default)]
struct StabilityRound {
    // Pairs are (handles, threads); intermediate fixture resources are live.
    // Only the original final equality is a success assertion.
    block_on_entry: (u32, usize),
    after_fixture: (u32, usize),
    after_capture: (u32, usize),
    after_join: (u32, usize),
    after_drop: (u32, usize),
    writer_pid: Option<u32>,
    settlement: Option<Settlement>,
    status: Option<i32>,
}
async fn held_writers_once(selection: &str, mut observation: Option<&mut StabilityRound>) {
    if let Some(round) = observation.as_deref_mut() {
        round.block_on_entry = (handles(), threads());
    }
    let mut fixture = Fixture::new();
    if let Some(round) = observation.as_deref_mut() {
        round.after_fixture = (handles(), threads());
    }
    let mut command = fixture.command("holder");
    command.env("HEXBOT_CAPTURE_STREAM", selection);
    let output = super::super::capture(command, Duration::from_secs(2), CLEANUP).await;
    if let Some(round) = observation.as_deref_mut() {
        round.after_capture = (handles(), threads());
        round.settlement = Some(output.settlement);
        round.status = output.status;
    }
    wait(&fixture.ready);
    let writer_pid = fixture.retain("writer");
    if let Some(round) = observation.as_deref_mut() {
        round.writer_pid = Some(writer_pid);
    }
    settled(&output);
    assert!(
        output.reaped(),
        "must observe exact root exit, not kill a live root"
    );
    assert_eq!(output.status, Some(0));
    assert!(
        output
            .capture_failure
            .as_ref()
            .unwrap()
            .contains("deadline")
    );
    assert!(!output.settlement.complete());
    assert!(output.settlement.cleanup_eligible());
    let index = usize::from(selection == "stderr");
    assert!(!output.settlement.natural_eof[index]);
    fixture.release_and_join();
    if let Some(round) = observation.as_deref_mut() {
        round.after_join = (handles(), threads());
    }
    drop(output);
    drop(fixture);
    if let Some(round) = observation {
        round.after_drop = (handles(), threads());
    }
}
#[tokio::test(flavor = "current_thread")]
async fn native_root_reaped_held_stdout_stderr_and_both_refuse_without_descendant_kills() {
    for selection in ["stdout", "stderr", "both"] {
        held_writers_once(selection, None).await;
    }
}
#[tokio::test(flavor = "current_thread")]
async fn native_cap_with_other_stream_hanging_preserves_bytes_and_settles() {
    let fixture = Fixture::new();
    let output = super::super::capture(fixture.command("cap"), BOUND, CLEANUP).await;
    settled(&output);
    assert!(output.reaped());
    assert_eq!(output.stdout.len(), super::super::OUTPUT_LIMIT + 1);
    assert!(
        output
            .capture_failure
            .unwrap()
            .contains("stdout output exceeded")
    );
    assert!(String::from_utf8_lossy(&output.stderr).contains("stderr before cap"));
    assert!(!output.settlement.complete());
}
#[tokio::test(flavor = "current_thread")]
async fn native_wrapper_drop_signals_and_joins_on_the_only_tokio_thread() {
    let mut fixture = Fixture::new();
    let mut capture = Box::pin(super::super::capture(
        fixture.command("hang"),
        BOUND,
        CLEANUP,
    ));
    std::future::poll_fn(|cx| {
        assert!(capture.as_mut().poll(cx).is_pending());
        Poll::Ready(())
    })
    .await;
    wait(&fixture.ready);
    fixture.retain("root");
    drop(capture); // Actual Drop must join without receiver/runtime progress.
    wait(fixture.processes.last().unwrap());
    // It was terminated by its direct owner; no success exit is required.
    fixture.processes.clear();
}
#[tokio::test(flavor = "current_thread")]
async fn native_final_bytes_racing_cancel_never_restore_health() {
    for release_first in [true, false] {
        let fixture = Fixture::new();
        let (mut worker, _receiver) =
            start(fixture.command("both"), Instant::now() + BOUND, CLEANUP).unwrap();
        wait(&fixture.ready);
        if release_first {
            signal(&fixture.gate);
        }
        signal(&worker.stop);
        if !release_first {
            signal(&fixture.gate);
        }
        let output = worker.join();
        settled(&output);
        // Either the complete child won before cancellation, or cancellation
        // is a permanent refusal. No result labels cancellation as natural EOF.
        if let Some(cause) = &output.capture_failure {
            assert!(cause.contains("cancelled"));
            assert!(!output.complete());
        } else {
            assert!(output.settlement.complete());
        }
    }
}
#[tokio::test(flavor = "current_thread")]
async fn native_spawn_193_and_access_5_keep_nochild_cleanup_and_original_causes() {
    let directory = tempfile::tempdir().unwrap();
    let image = directory.path().join("invalid.exe");
    std::fs::write(&image, b"this is not a Windows executable image").unwrap();
    for (case, path, code) in [
        ("invalid-image", image.as_path(), 193),
        ("directory-access", directory.path(), 5),
    ] {
        let output =
            super::super::capture(tokio::process::Command::new(path), BOUND, CLEANUP).await;
        let metadata =
            std::fs::symlink_metadata(path).map(|metadata| (metadata.file_type(), metadata.len()));
        let failure: Option<String> = output
            .capture_failure
            .as_ref()
            .map(|cause| cause.chars().take(2048).collect());
        let stdout = String::from_utf8_lossy(&output.stdout[..output.stdout.len().min(512)]);
        let stderr = String::from_utf8_lossy(&output.stderr[..output.stderr.len().min(512)]);
        eprintln!(
            "spawn case={case} expected_os_error={code} path={path:?} absolute={} metadata={metadata:?} capture_failure={failure:?} status={:?} settlement={:?} cleanup_eligible={} complete={} stdout_len={} stdout_prefix={stdout:?} stderr_len={} stderr_prefix={stderr:?}",
            path.is_absolute(),
            output.status,
            output.settlement,
            output.settlement.cleanup_eligible(),
            output.settlement.complete(),
            output.stdout.len(),
            output.stderr.len(),
        );
        settled(&output);
        assert_eq!(output.settlement.child, ChildState::NoChild);
        assert!(output.settlement.cleanup_eligible());
        assert!(!output.settlement.complete());
        assert!(
            output
                .capture_failure
                .unwrap()
                .contains(&format!("os error {code}"))
        );
    }
}
fn owned_case(fixture: impl FnOnce(&mut Owner) + Send + 'static) -> Output {
    let stop = Arc::new(event().unwrap());
    let child_stop = stop.clone();
    let thread = std::thread::spawn(move || {
        let mut owner = Owner::new(child_stop, Instant::now() + BOUND, CLEANUP);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| fixture(&mut owner)));
        if result.is_err() {
            owner.output.fail("fixture panic after submitted operation");
        }
        owner.settle();
        std::mem::replace(&mut owner.output, Output::empty())
    });
    Worker {
        stop,
        thread: Some(thread),
    }
    .join()
}
#[test]
fn native_partial_setup_pending_connect_and_real_read_wait_errors_keep_ownership() {
    for count in 0..=2 {
        let output = owned_case(move |owner| {
            let descriptor = security().unwrap();
            for index in 0..count {
                let (mut pipe, _) = Pipe::new(descriptor.0).unwrap();
                // Register in Owner BEFORE submitting the pending connection.
                pipe.pending = None;
                owner.pipes[index] = Some(pipe);
                owner.output.settlement.pipes_closed = false;
                owner.pipes[index].as_mut().unwrap().connect().unwrap();
                assert!(owner.pipes[index].as_ref().unwrap().pending.is_some());
            }
            owner
                .output
                .fail(format!("owned partial setup at pipe count {count}"));
        });
        settled(&output);
        assert_eq!(output.settlement.child, ChildState::NoChild);
        assert!(output.settlement.cleanup_eligible());
        assert!(
            output
                .capture_failure
                .unwrap()
                .contains("owned partial setup")
        );
    }
    let output = owned_case(|owner| {
        let descriptor = security().unwrap();
        let (pipe, _) = Pipe::new(descriptor.0).unwrap();
        owner.pipes[0] = Some(pipe);
        let error = owner.pipes[0].as_mut().unwrap().read().unwrap_err();
        owner
            .output
            .fail(format!("real unconnected ReadFile: {error}"));
        // Invalid pseudo-handle is never installed as an owned resource.
        let error = wait_events(&[ptr::null_mut()], Some(Instant::now())).unwrap_err();
        owner.output.fail(format!("real event wait API: {error}"));
    });
    settled(&output);
    let causes = output.capture_failure.unwrap();
    assert!(
        causes.contains("ReadFile")
            && causes.contains("event wait API")
            && causes.contains("os error")
    );
}
#[test]
fn native_pending_storage_survives_panic_unwind_until_cancelled_and_collected() {
    let output = owned_case(|owner| {
        let descriptor = security().unwrap();
        let (pipe, _) = Pipe::new(descriptor.0).unwrap();
        owner.pipes[0] = Some(pipe);
        owner.output.settlement.pipes_closed = false;
        owner.pipes[0].as_mut().unwrap().connect().unwrap();
        panic!("owned panic with an actual pending connect");
    });
    settled(&output);
    assert!(output.settlement.cleanup_eligible());
    assert!(output.capture_failure.unwrap().contains("fixture panic"));
}
#[test]
fn native_simulated_past_five_second_threshold_retains_pending_owner_until_release() {
    let latched = Arc::new(event().unwrap());
    let acknowledged = Arc::new(event().unwrap());
    let release = Arc::new(event().unwrap());
    let stop = Arc::new(event().unwrap());
    let (a, b, c, d) = (
        latched.clone(),
        acknowledged.clone(),
        release.clone(),
        stop.clone(),
    );
    let thread = std::thread::spawn(move || {
        let mut owner = Owner::new(d.clone(), Instant::now() + BOUND, CLEANUP);
        let descriptor = security().unwrap();
        let (pipe, _) = Pipe::new(descriptor.0).unwrap();
        owner.pipes[0] = Some(pipe);
        owner.output.settlement.pipes_closed = false;
        owner.pipes[0].as_mut().unwrap().connect().unwrap();
        owner.output.fail("primary simulated cleanup delay");
        owner.cleanup_deadline = Some(Instant::now() - Duration::from_secs(6));
        owner.threshold(); // Actual one-way result path, no copied timer logic.
        signal(&a);
        wait(&d);
        signal(&b); // Stop observed; pending allocation is still owned here.
        wait(&c); // Test-only simulation of unavailable completion, not an OS stall.
        owner.settle();
        std::mem::replace(&mut owner.output, Output::empty())
    });
    let mut worker = Worker {
        stop,
        thread: Some(thread),
    };
    wait(&latched);
    signal(&worker.stop);
    wait(&acknowledged);
    assert!(!worker.thread.as_ref().unwrap().is_finished());
    signal(&release);
    let output = worker.join();
    settled(&output);
    assert!(!output.settlement.cleanup_eligible());
    assert!(output.settlement.cleanup_unconfirmed);
    assert!(output.settlement.cleanup_threshold_exceeded);
    let cause = output.capture_failure.unwrap();
    assert!(
        cause.starts_with("primary simulated cleanup delay")
            && cause.contains("CleanupUnconfirmed")
    );
}
#[test]
fn native_owned_worker_handles_return_to_baseline_and_runtime_exits() {
    let output = fixture_command("stability").into_std().output().unwrap();
    assert!(
        output.status.success(),
        "stdout {} stderr {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn native_owner_drop_settles_pending_connect_before_unwinding_its_storage() {
    let (sender, receiver) = std::sync::mpsc::channel();
    let thread = std::thread::spawn(move || {
        let stop = Arc::new(event().unwrap());
        let mut owner = Owner::new(stop, Instant::now() + BOUND, CLEANUP);
        let descriptor = security().unwrap();
        let (pipe, name) = Pipe::new(descriptor.0).unwrap();
        owner.pipes[0] = Some(pipe);
        owner.output.settlement.pipes_closed = false;
        owner.pipes[0].as_mut().unwrap().connect().unwrap();
        sender.send(name).unwrap();
        panic!("force actual Owner Drop with pending Win32 storage");
    });
    let name = receiver.recv_timeout(BOUND).unwrap();
    assert!(thread.join().is_err());
    let result = owned(unsafe {
        CreateFileW(
            name.as_ptr(),
            0x00100002,
            0,
            ptr::null(),
            3,
            0,
            ptr::null_mut(),
        )
    });
    assert_eq!(
        result.unwrap_err().raw_os_error(),
        Some(2),
        "the closed first-instance pipe must no longer exist"
    );
}

#[test]
fn native_exact_pending_read_normal_and_aborted_completions_are_consumed_once() {
    for complete_before_cancel in [true, false] {
        let output = owned_case(move |owner| {
            let descriptor = security().unwrap();
            let (pipe, name) = Pipe::new(descriptor.0).unwrap();
            owner.pipes[0] = Some(pipe);
            owner.output.settlement.pipes_closed = false;
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
            })
            .unwrap();
            let pipe = owner.pipes[0].as_mut().unwrap();
            pipe.connect().unwrap();
            assert!(pipe.pending.is_none()); // Client opened before ConnectNamedPipe.
            assert!(pipe.read().unwrap().is_none());
            assert!(matches!(pipe.pending, Some(Pending::Read)));
            if complete_before_cancel {
                let bytes = b"late completed read";
                let mut written = 0;
                assert_ne!(
                    unsafe {
                        WriteFile(
                            client.as_raw_handle(),
                            bytes.as_ptr().cast(),
                            bytes.len() as u32,
                            &mut written,
                            ptr::null_mut(),
                        )
                    },
                    0
                );
                wait(pipe.event.as_ref().unwrap());
            }
            owner.output.fail("primary cancellation race");
            // Keep the writer open until actual CancelIoEx/collection. The
            // no-data arm must abort, not acquire broken-pipe EOF accidentally.
            owner.settle();
            drop(client);
        });
        settled(&output);
        assert!(!output.settlement.natural_eof[0]);
        assert!(!output.complete());
        if complete_before_cancel {
            assert_eq!(output.stdout, b"late completed read");
        } else {
            assert!(
                output
                    .capture_failure
                    .as_ref()
                    .unwrap()
                    .contains("os error 995")
            );
        }
        assert!(
            output
                .capture_failure
                .unwrap()
                .starts_with("primary cancellation race")
        );
    }
}
