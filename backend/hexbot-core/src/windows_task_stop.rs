//! Scheduler Stop plus completion of retained, authenticated kernel processes.
//! No process is terminated here and no PID from home metadata is authority.
#[path = "windows_process_identity.rs"]
mod identity;
#[path = "windows_task_stop_policy.rs"]
mod policy;
use std::{
    fs,
    io::{self, Read, Seek, SeekFrom},
    os::windows::{
        io::{AsRawHandle, OwnedHandle},
        process::CommandExt,
    },
    path::{Component, Path},
    process::{Command, Stdio},
    time::{Duration, Instant},
};
struct Engine {
    pid: u32,
    created: u64,
    handle: OwnedHandle,
}
struct Completion {
    engines: Vec<Engine>,
    children: Vec<OwnedHandle>,
    captured: bool,
}
impl Completion {
    fn capture(text: &str, before_query: u64) -> io::Result<Self> {
        let instances = policy::Instances::parse(text)?;
        let expected =
            crate::windows_paths::system_program("WindowsPowerShell/v1.0/powershell.exe")?
                .canonicalize()?;
        let mut engines = Vec::new();
        for pid in instances.engines {
            let Some(handle) = identity::open(pid)? else {
                continue;
            };
            if identity::wait(handle.as_raw_handle(), 0)? {
                continue;
            }
            let checked = (|| {
                let created = identity::created(handle.as_raw_handle())?;
                if !policy::engine_matches(
                    created,
                    before_query,
                    identity::same_owner(handle.as_raw_handle())?,
                    identity::image(handle.as_raw_handle())? == expected,
                ) {
                    return Err(io::Error::other(
                        "Cannot verify the running Windows task engine",
                    ));
                }
                Ok(created)
            })();
            let created = match checked {
                Ok(created) => created,
                // Only a signalled retained handle proves the acquisition race
                // ended. Access denied/new/live identities never become absence.
                Err(_) if identity::wait(handle.as_raw_handle(), 0)? => continue,
                Err(error) => return Err(error),
            };
            engines.push(Engine {
                pid,
                created,
                handle,
            });
        }
        Ok(Self {
            engines,
            children: Vec::new(),
            captured: false,
        })
    }
    fn complete(&mut self, home: &Path) -> io::Result<bool> {
        for engine in &self.engines {
            if !identity::wait(engine.handle.as_raw_handle(), 0)? {
                return Ok(false);
            }
        }
        if !self.captured {
            let first = identity::snapshot()?;
            let mut candidates = Vec::new();
            for (pid, parent) in first {
                let Some(engine) = self.engines.iter().find(|engine| engine.pid == parent) else {
                    continue;
                };
                let Some(handle) = identity::open(pid)? else {
                    continue;
                };
                if identity::wait(handle.as_raw_handle(), 0)? {
                    continue;
                }
                let checked = (|| {
                    let image = identity::image(handle.as_raw_handle())?;
                    if !image
                        .file_name()
                        .is_some_and(|name| name.eq_ignore_ascii_case("hexbot.exe"))
                    {
                        return Ok(None);
                    }
                    let root = home.join("runtime/native").canonicalize()?;
                    let managed = image.strip_prefix(root).is_ok_and(|relative| {
                        let components = relative.components().collect::<Vec<_>>();
                        components.len() == 2
                            && components
                                .iter()
                                .all(|part| matches!(part, Component::Normal(_)))
                    });
                    Ok(Some(policy::Child {
                        parent,
                        created: identity::created(handle.as_raw_handle())?,
                        same_owner: identity::same_owner(handle.as_raw_handle())?,
                        managed_image: managed,
                    }))
                })();
                match checked {
                    Ok(Some(child)) => {
                        candidates.push((pid, engine.pid, engine.created, child, handle))
                    }
                    Ok(None) => {}
                    Err(_) if identity::wait(handle.as_raw_handle(), 0)? => {}
                    Err(error) => return Err(error),
                }
            }
            let second = identity::snapshot()?;
            for (pid, engine, created, child, handle) in candidates {
                if identity::wait(handle.as_raw_handle(), 0)? {
                    continue;
                }
                let parent = second
                    .iter()
                    .find(|(other, _)| *other == pid)
                    .map(|(_, parent)| *parent);
                if !child.matches(engine, created, parent) {
                    return Err(io::Error::other(
                        "Cannot corroborate the Windows task daemon identity",
                    ));
                }
                self.children.push(handle);
            }
            self.captured = true;
        }
        for child in &self.children {
            if !identity::wait(child.as_raw_handle(), 0)? {
                return Ok(false);
            }
        }
        Ok(true)
    }
    fn wait_event(&self, deadline: Instant) -> io::Result<()> {
        let duration = deadline
            .saturating_duration_since(Instant::now())
            .min(Duration::from_millis(200));
        for handle in self
            .engines
            .iter()
            .map(|engine| &engine.handle)
            .chain(&self.children)
        {
            if !identity::wait(handle.as_raw_handle(), 0)? {
                identity::wait(handle.as_raw_handle(), duration.as_millis() as u32)?;
                return Ok(());
            }
        }
        // All witnessed processes are gone. Only scheduler state/home-lock
        // convergence remains, at the existing bounded polling cadence.
        std::thread::park_timeout(duration);
        Ok(())
    }
}
fn timeout() -> io::Error {
    io::Error::other("Windows task did not stop and release the daemon lock")
}
fn query(file: &Path, home: &Path, operation: &str, deadline: Instant) -> io::Result<String> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return Err(timeout());
    }
    let mut stdout = tempfile::tempfile()?;
    let mut stderr = tempfile::tempfile()?;
    let mut child = Command::new(crate::windows_paths::system_program(
        "WindowsPowerShell/v1.0/powershell.exe",
    )?)
    .args([
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        &super::control(file, home, operation)?,
    ])
    .creation_flags(0x08000000)
    .stdin(Stdio::null())
    .stdout(stdout.try_clone()?)
    .stderr(stderr.try_clone()?)
    .spawn()?;
    let remaining = deadline.saturating_duration_since(Instant::now());
    let waited = if remaining.is_zero() {
        Ok(false)
    } else {
        identity::wait(
            child.as_raw_handle(),
            remaining.as_millis().min(u32::MAX as u128) as u32,
        )
    };
    if !matches!(waited, Ok(true)) {
        let _ = child.kill();
        let _ = child.wait();
        return match waited {
            Err(error) => Err(error),
            _ => Err(timeout()),
        };
    }
    let status = child.wait()?;
    let read = |file: &mut fs::File, limit: u64| -> io::Result<Vec<u8>> {
        file.seek(SeekFrom::Start(0))?;
        let mut bytes = Vec::new();
        file.take(limit + 1).read_to_end(&mut bytes)?;
        if bytes.len() as u64 > limit {
            return Err(io::Error::other("Oversized Windows task control response"));
        }
        Ok(bytes)
    };
    let out = read(&mut stdout, 4096)?;
    let err = read(&mut stderr, 32768)?;
    if !status.success() {
        return Err(io::Error::other(format!(
            "Windows task {operation} failed ({status}): {}",
            String::from_utf8_lossy(&err).trim()
        )));
    }
    Ok(String::from_utf8(out)
        .map_err(io::Error::other)?
        .trim()
        .to_owned())
}
pub fn stop(file: &Path, home: &Path) -> io::Result<()> {
    // The caller preserves its NO_LOAD contract without scheduler/kernel calls.
    let deadline = Instant::now() + Duration::from_secs(30);
    unsafe extern "system" {
        fn GetSystemTimeAsFileTime(value: *mut u64);
    }
    let mut before_query = 0;
    unsafe { GetSystemTimeAsFileTime(&mut before_query) };
    let mut completion =
        Completion::capture(&query(file, home, "instances", deadline)?, before_query)?;
    query(file, home, "stop", deadline)?;
    loop {
        if Instant::now() >= deadline {
            return Err(timeout());
        }
        let completed = completion.complete(home)?;
        let state = query(file, home, "state", deadline)?;
        if !matches!(state.as_str(), "missing" | "0" | "1" | "2" | "3" | "4") {
            return Err(io::Error::other("Invalid Windows task state"));
        }
        if completed && !matches!(state.as_str(), "2" | "4") && super::home_idle(home)? {
            if Instant::now() >= deadline {
                return Err(timeout());
            }
            return Ok(());
        }
        completion.wait_event(deadline)?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{BufRead, BufReader, Write},
        os::windows::io::AsHandle,
        sync::mpsc,
        thread,
    };
    struct Fixture {
        child: std::process::Child,
        reader: Option<thread::JoinHandle<()>>,
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            self.child.stdin.take();
            if !identity::wait(self.child.as_raw_handle(), 0).unwrap_or(false) {
                let _ = self.child.kill();
            }
            let _ = self.child.wait();
            if let Some(reader) = self.reader.take() {
                let _ = reader.join();
            }
        }
    }
    #[test]
    fn a_released_home_lock_does_not_mean_the_retained_process_has_exited() {
        let home = tempfile::tempdir().unwrap();
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args(["--ignored", "--nocapture", "release_before_exit_fixture"])
            .env("HEXBOT_STOP_FIXTURE_HOME", home.path())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let handle = child.as_handle().try_clone_to_owned().unwrap();
        let stdout = child.stdout.take().unwrap();
        let (tx, rx) = mpsc::channel();
        let reader = thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if let Some(index) = line.find("STOP_FIXTURE_") {
                    let _ = tx.send(line[index..].to_owned());
                }
            }
        });
        let mut fixture = Fixture {
            child,
            reader: Some(reader),
        };
        assert_eq!(
            rx.recv_timeout(Duration::from_secs(10)).unwrap(),
            "STOP_FIXTURE_LOCKED"
        );
        assert!(!super::super::home_idle(home.path()).unwrap());
        fixture
            .child
            .stdin
            .as_mut()
            .unwrap()
            .write_all(b"release\n")
            .unwrap();
        assert_eq!(
            rx.recv_timeout(Duration::from_secs(10)).unwrap(),
            "STOP_FIXTURE_RELEASED"
        );
        assert!(super::super::home_idle(home.path()).unwrap());
        assert!(!identity::wait(handle.as_raw_handle(), 0).unwrap());
        // The previous state==ready/home-idle predicate would return here.
        // The exact production retained-handle predicate must still refuse.
        let mut completion = Completion {
            engines: Vec::new(),
            children: vec![handle],
            captured: true,
        };
        assert!(!completion.complete(home.path()).unwrap());
        fixture
            .child
            .stdin
            .as_mut()
            .unwrap()
            .write_all(b"exit\n")
            .unwrap();
        assert!(identity::wait(fixture.child.as_raw_handle(), 10_000).unwrap());
        assert_eq!(fixture.child.wait().unwrap().code(), Some(0));
        assert!(completion.complete(home.path()).unwrap());
    }
    #[test]
    #[ignore = "isolated subprocess fixture, invoked by retained-handle test"]
    fn release_before_exit_fixture() {
        let home = std::path::PathBuf::from(std::env::var_os("HEXBOT_STOP_FIXTURE_HOME").unwrap());
        let file = fs::File::create(home.join("native-daemon.lock")).unwrap();
        file.lock().unwrap();
        println!("STOP_FIXTURE_LOCKED");
        std::io::stdout().flush().unwrap();
        let mut line = String::new();
        assert_ne!(std::io::stdin().read_line(&mut line).unwrap(), 0);
        file.unlock().unwrap();
        println!("STOP_FIXTURE_RELEASED");
        std::io::stdout().flush().unwrap();
        line.clear();
        assert_ne!(std::io::stdin().read_line(&mut line).unwrap(), 0);
    }
}
