//! Private Windows debug runner host. Reuses Pi's one job and identity module.
use super::{
    dev_child_policy as policy, windows_pi_job::PiJob, windows_process_identity as identity,
};
use std::{
    ffi::c_void,
    io::{self, Read},
    os::windows::io::{AsRawHandle, OwnedHandle},
    path::Path,
    process::Stdio,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::{
    process::{Child, Command},
    sync::oneshot,
    time::{Instant, timeout_at},
};
#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetCurrentProcess() -> *mut c_void;
}
fn parent_id() -> io::Result<u32> {
    identity::snapshot()?
        .into_iter()
        .find(|(pid, _)| *pid == std::process::id())
        .map(|(_, parent)| parent)
        .ok_or_else(|| io::Error::other("Cannot identify Dev host parent"))
}
fn parent() -> io::Result<OwnedHandle> {
    let pid = parent_id()?;
    if pid == 0 || pid == std::process::id() {
        return Err(io::Error::other("Invalid Dev host parent"));
    }
    let handle = identity::open(pid)?.ok_or_else(|| io::Error::other("Dev host parent exited"))?;
    let witness = policy::Parent {
        pid,
        created: identity::created(handle.as_raw_handle())?,
        alive: !identity::wait(handle.as_raw_handle(), 0)?,
        same_owner: identity::same_owner(handle.as_raw_handle())?,
    };
    if !witness.verified(
        std::process::id(),
        identity::created(unsafe { GetCurrentProcess() })?,
        parent_id()?,
    ) || identity::wait(handle.as_raw_handle(), 0)?
    {
        return Err(io::Error::other("Cannot verify Dev host parent"));
    }
    Ok(handle)
}
fn input() -> io::Result<(Arc<AtomicBool>, oneshot::Receiver<()>)> {
    let ended = Arc::new(AtomicBool::new(false));
    let flag = ended.clone();
    let (send, receive) = oneshot::channel();
    std::thread::Builder::new()
        .name("hexbot-dev-input".into())
        .spawn(move || {
            let mut bytes = [0; 64];
            let stdin = io::stdin();
            let mut stdin = stdin.lock();
            loop {
                match stdin.read(&mut bytes) {
                    Ok(0) => break,
                    Ok(_) => {}
                    Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                    Err(_) => break,
                }
            }
            flag.store(true, Ordering::SeqCst);
            let _ = send.send(());
        })?;
    Ok((ended, receive))
}
async fn reap(child: &mut Child, code: i32) -> i32 {
    let deadline = Instant::now() + Duration::from_secs(15);
    let killed = child.start_kill();
    let waited = timeout_at(deadline, child.wait()).await;
    if killed.is_err() || !matches!(waited, Ok(Ok(_))) {
        eprintln!("Dev host refused child cleanup was not confirmed");
    }
    code // Keep the admission/assignment failure as the primary error.
}

pub async fn run(args: &[String]) -> i32 {
    let path = args.get(2).map(Path::new);
    if !policy::arguments(
        args,
        path.is_some_and(Path::is_absolute),
        path.is_some_and(|p| std::fs::symlink_metadata(p).is_ok_and(|m| m.file_type().is_file())),
    ) {
        eprintln!("Invalid Dev child arguments");
        return 2;
    }
    match host(args).await {
        Ok(code) => code,
        Err(error) => {
            eprintln!("Dev host refused: {error}");
            3
        }
    }
}
async fn host(args: &[String]) -> io::Result<i32> {
    // Register both handlers before any child can run. Console events do not
    // acknowledge descendant completion or provide a graceful shutdown period.
    let mut ctrl_c = tokio::signal::windows::ctrl_c()?;
    let mut ctrl_break = tokio::signal::windows::ctrl_break()?;
    let parent = parent()?;
    let (ended, mut eof) = input()?;
    let job = PiJob::new()?;
    let mut child = Command::new(&args[2])
        .args(&args[3..])
        .creation_flags(0x00000004) // CREATE_SUSPENDED, retain the console
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()?;
    let admissible = identity::wait(parent.as_raw_handle(), 0).map(|dead| !dead);
    if !matches!(admissible, Ok(true)) || ended.load(Ordering::SeqCst) {
        return Ok(reap(&mut child, 3).await);
    }
    if let Err(error) = job.assign_and_resume(&child) {
        eprintln!("Dev host job assignment failed: {error}");
        drop(job);
        return Ok(reap(&mut child, 126).await);
    }
    let mut parent_exit =
        tokio::task::spawn_blocking(move || identity::wait(parent.as_raw_handle(), u32::MAX));
    let code = loop {
        tokio::select! {
            biased; // A ready root exit retains its own status when EOF races it.
            status = child.wait() => break status.ok().and_then(|s| s.code()).unwrap_or(125),
            _ = &mut eof => break 0,
            status = &mut parent_exit => break if matches!(status, Ok(Ok(true))) { 0 } else { 125 },
            event = ctrl_c.recv() => if event.is_none() { break 125; },
            event = ctrl_break.recv() => if event.is_none() { break 125; },
        }
    };
    // PiJob starts its single 15s budget at entry, before capture/termination.
    let deadline = Instant::now() + Duration::from_secs(15);
    let completed = tokio::task::spawn_blocking(move || job.terminate_and_wait()).await;
    let reaped = timeout_at(deadline, child.wait()).await;
    if !matches!(completed, Ok(Ok(()))) || !matches!(reaped, Ok(Ok(_))) {
        eprintln!("Dev host descendant cleanup was not confirmed");
        return Ok(125);
    }
    Ok(code)
}
