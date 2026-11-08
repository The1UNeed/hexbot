//! Linux-only worker. The VM, rather than these per-process limits, bounds all
//! parser allocations and descendants. There is one immutable renderer/job.
use crate::*;
use std::{
    ffi::CString,
    fs::{self, OpenOptions},
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd, RawFd},
        unix::{fs::OpenOptionsExt, process::CommandExt},
    },
    path::{Path, PathBuf},
    process::{Child, Command, ExitStatus, Stdio},
    time::{Duration, Instant},
};

pub struct Socket {
    fd: OwnedFd,
    deadline: Instant,
}
impl Socket {
    pub fn new(fd: OwnedFd, deadline: Instant) -> io::Result<Self> {
        nonblocking(fd.as_raw_fd())?;
        Ok(Self { fd, deadline })
    }
    fn wait(&self, events: i16) -> io::Result<()> {
        poll(
            &mut [libc::pollfd {
                fd: self.fd.as_raw_fd(),
                events,
                revents: 0,
            }],
            self.deadline,
        )
    }
}
impl Read for Socket {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if buffer.is_empty() {
            return Ok(0);
        }
        loop {
            self.wait(libc::POLLIN)?;
            let length = unsafe {
                libc::read(
                    self.fd.as_raw_fd(),
                    buffer.as_mut_ptr().cast(),
                    buffer.len(),
                )
            };
            if length >= 0 {
                return Ok(length as usize);
            }
            let error = io::Error::last_os_error();
            if !matches!(
                error.kind(),
                io::ErrorKind::Interrupted | io::ErrorKind::WouldBlock
            ) {
                return Err(error);
            }
        }
    }
}
impl Write for Socket {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        if buffer.is_empty() {
            return Ok(0);
        }
        loop {
            self.wait(libc::POLLOUT)?;
            let length = unsafe {
                libc::send(
                    self.fd.as_raw_fd(),
                    buffer.as_ptr().cast(),
                    buffer.len(),
                    libc::MSG_NOSIGNAL,
                )
            };
            if length >= 0 {
                return Ok(length as usize);
            }
            let error = io::Error::last_os_error();
            if !matches!(
                error.kind(),
                io::ErrorKind::Interrupted | io::ErrorKind::WouldBlock
            ) {
                return Err(error);
            }
        }
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
fn poll(fds: &mut [libc::pollfd], deadline: Instant) -> io::Result<()> {
    loop {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .ok_or_else(|| io::Error::new(io::ErrorKind::TimedOut, "PDF deadline exceeded"))?;
        let millis = remaining
            .as_millis()
            .saturating_add(1)
            .min(i32::MAX as u128) as i32;
        let result = unsafe { libc::poll(fds.as_mut_ptr(), fds.len() as _, millis) };
        if result > 0 {
            return Ok(());
        }
        if result == 0 {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "PDF deadline exceeded",
            ));
        }
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::Interrupted {
            return Err(error);
        }
    }
}
fn nonblocking(fd: RawFd) -> io::Result<()> {
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

struct Input(PathBuf);
impl Drop for Input {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}
struct Renderer {
    child: Child,
    group: Option<i32>,
}
impl Renderer {
    fn wait(&mut self) -> io::Result<ExitStatus> {
        let status = self.child.wait()?;
        // Never signal a numeric process group after reaping its leader.
        self.group = None;
        Ok(status)
    }
}
impl Drop for Renderer {
    fn drop(&mut self) {
        if let Some(group) = self.group.take() {
            unsafe {
                libc::kill(-group, libc::SIGKILL);
            }
            let _ = self.child.wait();
        }
    }
}

/// The production entry always supplies the fixed, image-owned Poppler path.
/// Tests exercise this boundary with an owned renderer and a Unix socket pair.
pub fn serve(mut socket: Socket, directory: &Path, renderer: &Path) -> io::Result<Status> {
    socket.write_all(RESPONSE_MAGIC)?;
    let result = job(&mut socket, directory, renderer);
    let status = match result {
        Ok(status) => status,
        Err(error) if error.kind() == io::ErrorKind::TimedOut => Status::Timeout,
        Err(error)
            if matches!(
                error.kind(),
                io::ErrorKind::UnexpectedEof | io::ErrorKind::InvalidData
            ) =>
        {
            Status::InvalidRequest
        }
        Err(error)
            if matches!(
                error.kind(),
                io::ErrorKind::BrokenPipe | io::ErrorKind::ConnectionReset
            ) =>
        {
            return Err(error);
        }
        Err(_) => Status::RendererFailed,
    };
    finish(&mut socket, status)?;
    if unsafe { libc::shutdown(socket.fd.as_raw_fd(), libc::SHUT_WR) } != 0 {
        return Err(io::Error::last_os_error());
    }
    // Response EOF lets the host validate the terminal frame before closing
    // its channel. Do not power off while final bytes may still be queued.
    let mut trailing = [0; 1];
    if socket.read(&mut trailing)? != 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "trailing PDF request bytes",
        ));
    }
    Ok(status)
}
fn job(socket: &mut Socket, directory: &Path, renderer: &Path) -> io::Result<Status> {
    let mut header = [0; REQUEST_BYTES];
    socket.read_exact(&mut header)?;
    let request = Request::parse(header)?;
    let path = directory.join("input.pdf");
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&path)?;
    let input = Input(path);
    let mut magic = [0; 5];
    socket.read_exact(&mut magic)?;
    if &magic != b"%PDF-" {
        return Ok(Status::InvalidRequest);
    }
    file.write_all(&magic)?;
    let mut remaining = request.length - magic.len() as u64;
    let mut buffer = [0; CHUNK_LIMIT];
    while remaining > 0 {
        let length = remaining.min(buffer.len() as u64) as usize;
        socket.read_exact(&mut buffer[..length])?;
        file.write_all(&buffer[..length])?;
        remaining -= length as u64;
    }
    drop(file);
    let mut command = Command::new(renderer);
    command
        .args([
            "-png",
            "-r",
            "150",
            "-f",
            &request.first.to_string(),
            "-l",
            &request.last.to_string(),
            "-W",
            "8193",
            "-H",
            "8193",
        ])
        .arg(&input.0)
        .env_clear()
        .env("LC_ALL", "C")
        .env("HOME", "/nonexistent")
        .env("FONTCONFIG_FILE", "/etc/fonts/fonts.conf")
        .current_dir(directory)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .process_group(0);
    unsafe {
        command.pre_exec(renderer_limits);
    }
    let child = command.spawn()?;
    let group = child.id() as i32;
    eprintln!("hexbot-pdf-guest renderer-started");
    let mut child = Renderer {
        child,
        group: Some(group),
    };
    let mut output = child
        .child
        .stdout
        .take()
        .ok_or_else(|| io::Error::other("renderer stdout unavailable"))?;
    nonblocking(output.as_raw_fd())?;
    let pidfd = unsafe { libc::syscall(libc::SYS_pidfd_open, group, 0) };
    if pidfd < 0 {
        return Err(io::Error::last_os_error());
    }
    let pidfd = unsafe { OwnedFd::from_raw_fd(pidfd as RawFd) };
    let mut total = 0;
    let mut eof = false;
    loop {
        let mut events = [
            libc::pollfd {
                fd: socket.fd.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            },
            libc::pollfd {
                fd: if eof {
                    pidfd.as_raw_fd()
                } else {
                    output.as_raw_fd()
                },
                events: libc::POLLIN,
                revents: 0,
            },
        ];
        poll(&mut events, socket.deadline)?;
        if events[0].revents != 0 {
            // The complete request has already been consumed. Extra input or
            // disconnect cancels the only job instead of starting another one.
            return Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "PDF host disconnected or sent trailing input",
            ));
        }
        if events[1].revents == 0 {
            continue;
        }
        if eof {
            let status = child.wait()?;
            return Ok(if status.success() && total > 0 {
                Status::Ok
            } else {
                Status::RendererFailed
            });
        }
        let capacity = buffer.len().min(OUTPUT_LIMIT - total + 1);
        match output.read(&mut buffer[..capacity]) {
            Ok(0) => {
                eof = true;
            }
            Ok(length) => {
                if length > OUTPUT_LIMIT - total {
                    return Ok(Status::OutputLimit);
                }
                write_chunk(&mut *socket, &buffer[..length])?;
                total += length;
            }
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                ) => {}
            Err(error) => return Err(error),
        }
    }
}
fn renderer_limits() -> io::Result<()> {
    for (resource, ceiling) in [
        (libc::RLIMIT_DATA, 512 * 1024 * 1024),
        (libc::RLIMIT_CPU, DEADLINE_SECONDS),
        (libc::RLIMIT_FSIZE, OUTPUT_LIMIT as u64),
        (libc::RLIMIT_CORE, 0),
        (libc::RLIMIT_NOFILE, 32),
        (libc::RLIMIT_NPROC, 64),
    ] {
        let mut inherited = libc::rlimit {
            rlim_cur: 0,
            rlim_max: 0,
        };
        if unsafe { libc::getrlimit(resource, &mut inherited) } != 0 {
            return Err(io::Error::last_os_error());
        }
        let limit = libc::rlimit {
            rlim_cur: inherited.rlim_cur.min(ceiling),
            rlim_max: inherited.rlim_max.min(ceiling),
        };
        if unsafe { libc::setrlimit(resource, &limit) } != 0 {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(())
}

fn has_mount(info: &str, point: &str, kind: &str, option: &str) -> bool {
    info.lines().any(|line| {
        let Some((before, after)) = line.split_once(" - ") else {
            return false;
        };
        let mut fields = before.split_whitespace();
        fields.nth(4) == Some(point)
            && fields
                .next()
                .is_some_and(|options| options.split(',').any(|value| value == option))
            && after.split_whitespace().next() == Some(kind)
    })
}
fn verify_boot_mounts() -> io::Result<()> {
    let mut info = String::new();
    std::fs::File::open("/proc/self/mountinfo")?
        .take(16 * 1024 + 1)
        .read_to_string(&mut info)?;
    if info.len() > 16 * 1024
        || !has_mount(&info, "/dev", "devtmpfs", "nosuid")
        || !has_mount(&info, "/", "ext4", "ro")
    {
        return Err(io::Error::other(
            "PDF init requires its read-only ext4 root and existing devtmpfs",
        ));
    }
    Ok(())
}

pub fn boot() -> io::Result<()> {
    if std::process::id() != 1 || std::env::args_os().len() != 1 {
        return Err(io::Error::other(
            "PDF worker must be the guest init process",
        ));
    }
    verify_boot_mounts()?;
    mount(
        "tmpfs",
        "/tmp",
        "tmpfs",
        libc::MS_NOSUID | libc::MS_NODEV | libc::MS_NOEXEC,
        "size=67108864,mode=1777",
    )?;
    // PID1 keeps only the authority needed to power off. The socket and PDF
    // decoder belong to one separate unprivileged worker.
    let child = unsafe { libc::fork() };
    if child < 0 {
        return Err(io::Error::last_os_error());
    }
    if child == 0 {
        let result = worker();
        if let Err(error) = &result {
            eprintln!("PDF worker failed: {error}");
        }
        std::process::exit(if result.is_ok() { 0 } else { 1 });
    }
    let mut status = 0;
    loop {
        let result = unsafe { libc::waitpid(child, &mut status, 0) };
        if result == child {
            return Ok(());
        }
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::Interrupted {
            return Err(error);
        }
    }
}
fn worker() -> io::Result<()> {
    if unsafe { libc::setgroups(0, std::ptr::null()) } != 0
        || unsafe { libc::setgid(65534) } != 0
        || unsafe { libc::setuid(65534) } != 0
        || unsafe { libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) } != 0
    {
        return Err(io::Error::last_os_error());
    }
    let deadline = Instant::now() + Duration::from_secs(DEADLINE_SECONDS);
    let raw = unsafe {
        libc::socket(
            libc::AF_VSOCK,
            libc::SOCK_STREAM | libc::SOCK_CLOEXEC | libc::SOCK_NONBLOCK,
            0,
        )
    };
    if raw < 0 {
        return Err(io::Error::last_os_error());
    }
    let fd = unsafe { OwnedFd::from_raw_fd(raw) };
    let mut address: libc::sockaddr_vm = unsafe { std::mem::zeroed() };
    address.svm_family = libc::AF_VSOCK as _;
    address.svm_cid = 2; // The owning VM helper, never a network endpoint.
    address.svm_port = PORT;
    let result = unsafe {
        libc::connect(
            fd.as_raw_fd(),
            (&address as *const libc::sockaddr_vm).cast(),
            std::mem::size_of_val(&address) as _,
        )
    };
    if result < 0 {
        let error = io::Error::last_os_error();
        if error.raw_os_error() != Some(libc::EINPROGRESS) {
            return Err(error);
        }
        poll(
            &mut [libc::pollfd {
                fd: fd.as_raw_fd(),
                events: libc::POLLOUT,
                revents: 0,
            }],
            deadline,
        )?;
        let mut code = 0i32;
        let mut size = std::mem::size_of_val(&code) as libc::socklen_t;
        if unsafe {
            libc::getsockopt(
                fd.as_raw_fd(),
                libc::SOL_SOCKET,
                libc::SO_ERROR,
                (&mut code as *mut i32).cast(),
                &mut size,
            )
        } != 0
        {
            return Err(io::Error::last_os_error());
        }
        if code != 0 {
            return Err(io::Error::from_raw_os_error(code));
        }
    }
    eprintln!("hexbot-pdf-guest connected");
    serve(
        Socket::new(fd, deadline)?,
        Path::new("/tmp"),
        Path::new("/usr/bin/pdftoppm"),
    )?;
    Ok(())
}
fn mount(
    source: &str,
    target: &str,
    kind: &str,
    flags: libc::c_ulong,
    data: &str,
) -> io::Result<()> {
    let source = CString::new(source).unwrap();
    let target = CString::new(target).unwrap();
    let kind = CString::new(kind).unwrap();
    let data = CString::new(data).unwrap();
    if unsafe {
        libc::mount(
            source.as_ptr(),
            target.as_ptr(),
            kind.as_ptr(),
            flags,
            data.as_ptr().cast(),
        )
    } != 0
    {
        return Err(io::Error::other(format!(
            "mount {kind:?} on {target:?}: {}",
            io::Error::last_os_error()
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        os::unix::{fs::PermissionsExt, net::UnixStream},
        sync::atomic::{AtomicU64, Ordering},
        thread,
    };
    static NEXT: AtomicU64 = AtomicU64::new(0);
    struct Directory(PathBuf);
    impl Directory {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!(
                "hexbot-pdf-guest-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&p).unwrap();
            Self(p)
        }
        fn renderer(&self, script: &str) -> PathBuf {
            let p = self.0.join("renderer");
            fs::write(&p, format!("#!/bin/sh\nset -eu\n{script}\n")).unwrap();
            fs::set_permissions(&p, fs::Permissions::from_mode(0o700)).unwrap();
            p
        }
    }
    impl Drop for Directory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn start(
        directory: &Directory,
        renderer: PathBuf,
        duration: Duration,
        request: Request,
        pdf: &[u8],
    ) -> (UnixStream, thread::JoinHandle<io::Result<Status>>) {
        let (mut client, server) = UnixStream::pair().unwrap();
        client
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        client
            .set_write_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let directory = directory.0.clone();
        let worker = thread::spawn(move || {
            serve(
                Socket::new(server.into(), Instant::now() + duration).unwrap(),
                &directory,
                &renderer,
            )
        });
        client.write_all(&request.header()).unwrap();
        client.write_all(pdf).unwrap();
        (client, worker)
    }
    fn ready(client: &mut UnixStream) -> i32 {
        let mut magic = [0; 8];
        client.read_exact(&mut magic).unwrap();
        assert_eq!(&magic, RESPONSE_MAGIC);
        let mut length = [0; 4];
        client.read_exact(&mut length).unwrap();
        let length = u32::from_be_bytes(length) as usize;
        let mut payload = vec![0; length];
        client.read_exact(&mut payload).unwrap();
        std::str::from_utf8(&payload)
            .unwrap()
            .trim()
            .parse()
            .unwrap()
    }
    fn request() -> Request {
        Request {
            first: 1,
            last: 25,
            length: 5,
        }
    }
    #[test]
    fn boot_requires_the_existing_private_mounts() {
        let info = "1 0 1:0 / / ro,relatime - ext4 /dev/vda ro\n2 1 0:2 / /dev rw,nosuid - devtmpfs devtmpfs rw\n";
        assert!(has_mount(info, "/", "ext4", "ro"));
        assert!(has_mount(info, "/dev", "devtmpfs", "nosuid"));
        assert!(!has_mount(info, "/", "ext4", "rw"));
        assert!(!has_mount(info, "/dev", "tmpfs", "nosuid"));
        assert!(!has_mount(info, "/device", "devtmpfs", "nosuid"));
        assert!(!has_mount("malformed", "/dev", "devtmpfs", "nosuid"));
    }
    #[test]
    fn malformed_input_never_starts_the_renderer_and_cleans_the_input() {
        let dir = Directory::new();
        let renderer = dir.renderer("touch should-not-exist");
        let (client, worker) = start(&dir, renderer, Duration::from_secs(5), request(), b"wrong");
        assert_eq!(
            read_response(client, io::sink()).unwrap(),
            Status::InvalidRequest
        );
        assert_eq!(worker.join().unwrap().unwrap(), Status::InvalidRequest);
        assert!(!dir.0.join("input.pdf").exists());
        assert!(!dir.0.join("should-not-exist").exists());
    }
    #[test]
    fn a_preexisting_input_is_not_removed_or_overwritten() {
        let dir = Directory::new();
        fs::write(dir.0.join("input.pdf"), b"existing owned file").unwrap();
        let renderer = dir.renderer("exit 0");
        let (client, worker) = start(&dir, renderer, Duration::from_secs(5), request(), b"%PDF-");
        // Rejection precedes payload consumption, so the peer can receive a
        // reset. Either transport failure or an error status must preserve it.
        assert!(!matches!(read_response(client, io::sink()), Ok(Status::Ok)));
        assert!(!matches!(worker.join().unwrap(), Ok(Status::Ok)));
        assert_eq!(
            fs::read(dir.0.join("input.pdf")).unwrap(),
            b"existing owned file"
        );
    }
    #[test]
    fn incomplete_input_and_nonzero_exit_cannot_succeed() {
        let dir = Directory::new();
        let renderer = dir.renderer("printf output; exit 7");
        let (client, worker) = start(
            &dir,
            renderer.clone(),
            Duration::from_secs(5),
            request(),
            b"%PDF-",
        );
        assert_eq!(
            read_response(client, io::sink()).unwrap(),
            Status::RendererFailed
        );
        assert_eq!(worker.join().unwrap().unwrap(), Status::RendererFailed);
        let (client, worker) = start(
            &dir,
            renderer,
            Duration::from_secs(5),
            Request {
                length: 6,
                ..request()
            },
            b"%PDF-",
        );
        client.shutdown(std::net::Shutdown::Write).unwrap();
        assert_eq!(
            read_response(client, io::sink()).unwrap(),
            Status::InvalidRequest
        );
        assert_eq!(worker.join().unwrap().unwrap(), Status::InvalidRequest);
        assert!(!dir.0.join("input.pdf").exists());
    }
    #[test]
    fn disconnect_kills_and_reaps_a_ready_renderer() {
        let dir = Directory::new();
        let renderer = dir.renderer("mkfifo wait; printf '%s\\n' \"$$\"; read unused < wait");
        let (mut client, worker) =
            start(&dir, renderer, Duration::from_secs(5), request(), b"%PDF-");
        let pid = ready(&mut client);
        drop(client);
        assert!(worker.join().unwrap().is_err());
        assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
        assert_eq!(io::Error::last_os_error().raw_os_error(), Some(libc::ESRCH));
        assert!(!dir.0.join("input.pdf").exists());
    }
    #[test]
    fn the_same_deadline_covers_renderer_eof_and_exit() {
        for close_stdout in [false, true] {
            let dir = Directory::new();
            let renderer = dir.renderer(&format!(
                "mkfifo wait; printf '%s\\n' \"$$\"; {} read unused < wait",
                if close_stdout { "exec 1>&-;" } else { "" }
            ));
            let (mut client, worker) =
                start(&dir, renderer, Duration::from_secs(1), request(), b"%PDF-");
            let pid = ready(&mut client);
            let mut response = Vec::new();
            client.read_to_end(&mut response).unwrap();
            assert!(worker.join().unwrap().is_err());
            assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
            assert_eq!(io::Error::last_os_error().raw_os_error(), Some(libc::ESRCH));
            assert!(!dir.0.join("input.pdf").exists());
        }
    }
    #[test]
    fn output_exact_limit_succeeds_and_the_next_byte_is_rejected() {
        for extra in [0, 1] {
            let dir = Directory::new();
            let renderer =
                dir.renderer(&format!("exec head -c {} /dev/zero", OUTPUT_LIMIT + extra));
            let (client, worker) =
                start(&dir, renderer, Duration::from_secs(10), request(), b"%PDF-");
            let expected = if extra == 0 {
                Status::Ok
            } else {
                Status::OutputLimit
            };
            assert_eq!(read_response(client, io::sink()).unwrap(), expected);
            assert_eq!(worker.join().unwrap().unwrap(), expected);
            assert!(!dir.0.join("input.pdf").exists());
        }
    }
    #[test]
    fn trailing_request_data_cancels_the_job() {
        let dir = Directory::new();
        let renderer = dir.renderer("mkfifo wait; printf '%s\\n' \"$$\"; read unused < wait");
        let (mut client, worker) =
            start(&dir, renderer, Duration::from_secs(5), request(), b"%PDF-");
        let pid = ready(&mut client);
        client.write_all(b"extra request").unwrap();
        let mut rest = Vec::new();
        let read = client.read_to_end(&mut rest);
        assert!(read.is_ok() || read.unwrap_err().kind() == io::ErrorKind::ConnectionReset);
        assert!(worker.join().unwrap().is_err());
        assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
        assert!(!dir.0.join("input.pdf").exists());
    }
}
