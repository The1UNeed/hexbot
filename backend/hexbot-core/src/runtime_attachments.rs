use super::*;
use std::ops::Range;
use std::process::Stdio;
use tokio::io::{AsyncRead, AsyncReadExt};

const SESSION_LIMIT: u64 = 512 * 1024 * 1024;
/// Staged images travel inside one prompt record, which Pi reads into a JavaScript
/// string; keep well under V8's 512 MiB string cap so an oversized batch is refused
/// here instead of killing the bot on every retry.
pub(super) const ENVELOPE_LIMIT: usize = 128 * 1024 * 1024;
const IMAGE_ENVELOPE_LIMIT: usize = ENVELOPE_LIMIT - 2 * 1024 * 1024;
const PDF_OUTPUT_LIMIT: usize = (IMAGE_ENVELOPE_LIMIT - 256) / 4 * 3;
#[derive(Clone, Copy)]
struct RenderBounds {
    bytes: usize,
    timeout: Duration,
}
const PDF_RENDER_BOUNDS: RenderBounds = RenderBounds {
    bytes: PDF_OUTPUT_LIMIT,
    timeout: Duration::from_secs(120),
};
type RenderReservation = Arc<tokio::sync::SemaphorePermit<'static>>;
const PDF_PAGE_EDGE: u32 = 8192;
// Render one extra pixel to detect oversized pages, without downscaling or
// allocating their full raster. Standard paper sizes, including A0, fit.
const PDF_RENDER_EDGE: &str = "8193";
static PDF_RENDERS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);
const VM_REPAIR: &str = "The PDF VM runtime is missing, damaged or unsupported. Run the Hexbot installer again and choose Update or repair.";
#[cfg(any(target_os = "macos", test))]
const APPLE_RUNTIME: &str = "PDF rendering requires the native Apple silicon runtime on this Mac. Install Apple silicon Full or Headless with the Hexbot installer.";
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PdfBackend {
    Host,
    Vm,
}

fn pdf_backend(config: &Value, os: &str) -> Result<PdfBackend> {
    let selected = match config.pointer("/attachments/pdf_backend") {
        None => {
            if os == "macos" {
                PdfBackend::Vm
            } else {
                PdfBackend::Host
            }
        }
        Some(Value::String(value)) if value == "vm" => PdfBackend::Vm,
        Some(Value::String(value)) if value == "host" => PdfBackend::Host,
        _ => {
            return Err(Error::new(
                4202,
                "attachments.pdf_backend must be vm or host",
            ));
        }
    };
    if os == "windows" {
        return Err(Error::new(
            5028,
            "PDF attachments are not supported on Windows.",
        ));
    }
    if selected == PdfBackend::Vm && os != "macos" {
        return Err(Error::new(
            5028,
            "attachments.pdf_backend: vm requires macOS.",
        ));
    }
    Ok(selected)
}

#[cfg(any(target_os = "macos", test))]
fn native_pdf_arch(arch: &str, hardware_arm: bool, translated: bool) -> Result<()> {
    if hardware_arm && (arch != "aarch64" || translated) {
        return Err(Error::new(5028, APPLE_RUNTIME));
    }
    if !hardware_arm && (arch != "x86_64" || translated) {
        return Err(Error::new(5028, VM_REPAIR));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn vm_command() -> Result<tokio::process::Command> {
    let flag = |name: &std::ffi::CStr| -> Result<bool> {
        let mut value: i32 = 0;
        let mut size = std::mem::size_of_val(&value);
        if unsafe {
            libc::sysctlbyname(
                name.as_ptr(),
                (&mut value as *mut i32).cast(),
                &mut size,
                std::ptr::null_mut(),
                0,
            )
        } == 0
        {
            return Ok(value != 0);
        }
        if std::io::Error::last_os_error().raw_os_error() == Some(libc::ENOENT) {
            return Ok(false);
        }
        Err(Error::new(5028, VM_REPAIR))
    };
    native_pdf_arch(
        std::env::consts::ARCH,
        flag(c"hw.optional.arm64")?,
        flag(c"sysctl.proc_translated")?,
    )?;
    let executable = std::env::current_exe().map_err(|_| Error::new(5028, VM_REPAIR))?;
    let directory = pdf_vm_directory(
        &executable,
        std::env::var_os("HEXBOT_PDF_RUNTIME_DIR").as_deref(),
    )?;
    let helper = directory.join("hexbot-pdf-vm");
    if !fs::symlink_metadata(&helper).is_ok_and(|m| m.is_file()) {
        return Err(Error::new(5028, VM_REPAIR));
    }
    let mut command = tokio::process::Command::new(helper);
    command.arg("--assets").arg(directory);
    Ok(command)
}

#[cfg(any(target_os = "macos", all(test, unix)))]
fn pdf_vm_directory(executable: &Path, selected: Option<&std::ffi::OsStr>) -> Result<PathBuf> {
    let directory = match selected.filter(|value| !value.is_empty()) {
        Some(value) => PathBuf::from(value),
        None => executable
            .parent()
            .ok_or_else(|| Error::new(5028, VM_REPAIR))?
            .join("pdf"),
    };
    if !directory.is_absolute() {
        return Err(Error::new(
            4202,
            "HEXBOT_PDF_RUNTIME_DIR must be an absolute trusted runtime directory",
        ));
    }
    Ok(directory)
}

#[cfg(not(target_os = "macos"))]
fn vm_command() -> Result<tokio::process::Command> {
    Err(Error::new(5028, "PDF VM rendering requires macOS"))
}

fn renderer_failed(backend: PdfBackend, status: Option<i32>) -> Error {
    if backend == PdfBackend::Vm && status == Some(80) {
        return envelope_exceeded();
    }
    Error::new(
        5028,
        match (backend, status) {
            (PdfBackend::Host, _) => "pdftoppm failed to render this PDF",
            (PdfBackend::Vm, Some(78)) => VM_REPAIR,
            (PdfBackend::Vm, Some(69)) => {
                "PDF virtualization is unavailable or the runtime does not match this Mac. Install the native Apple silicon or Intel Full or Headless package for this Mac."
            }
            (PdfBackend::Vm, Some(65)) => {
                "The PDF VM could not read this PDF. Try attaching it again."
            }
            (PdfBackend::Vm, Some(124)) => "PDF VM rendering timed out (>120s)",
            (PdfBackend::Vm, _) => "The PDF VM could not render this PDF.",
        },
    )
}
fn attachment_limit_mib(method: &str) -> usize {
    if method == "image.attach_bytes" {
        25
    } else {
        45
    }
}
impl Runtime {
    pub(super) async fn clear_attachments(&self, s: &Live) -> Result<Value> {
        let _attachment = s.attachment_gate.lock().await;
        ensure_open(s)?;
        let paths = {
            let mut state = s.state.lock().unwrap();
            if state.busy {
                return Err(Error::new(
                    4002,
                    "wait for the bot before clearing attachments",
                ));
            }
            std::mem::take(&mut state.staged)
        };
        for path in paths.into_iter().flat_map(|u| u.files) {
            match fs::remove_file(path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
        Ok(json!({"cleared": true}))
    }
    pub(super) async fn attach(&self, s: &Live, method: &str, p: &Value) -> Result<Value> {
        let encoded = if method == "file.attach" {
            let url = required(p, "data_url")?;
            let (head, body) = url
                .split_once(',')
                .ok_or_else(|| Error::new(4202, "invalid data URL"))?;
            if !head.starts_with("data:") || !head.ends_with(";base64") {
                return Err(Error::new(4202, "expected a base64 data URL"));
            }
            body
        } else {
            required(p, "content_base64")?
        };
        let limit_mib = attachment_limit_mib(method);
        let limit = limit_mib * 1024 * 1024;
        if encoded.len() > 4 * limit.div_ceil(3) {
            return Err(Error::new(
                4202,
                format!("attachment exceeds {limit_mib} MiB"),
            ));
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .map_err(|_| Error::new(4202, "invalid base64 attachment"))?;
        if bytes.len() > limit {
            return Err(Error::new(
                4202,
                format!("attachment exceeds {limit_mib} MiB"),
            ));
        }
        let name =
            p["name"]
                .as_str()
                .or(p["filename"].as_str())
                .unwrap_or(if method == "pdf.attach" {
                    "uploaded.pdf"
                } else {
                    "attachment"
                });
        let name = Path::new(name)
            .file_name()
            .and_then(|s| s.to_str())
            .filter(|s| !s.is_empty() && *s != "..")
            .ok_or_else(|| Error::new(4202, "invalid attachment name"))?;
        if method == "pdf.attach" {
            return self.attach_pdf(s, p, name, &bytes).await;
        }
        let image = if method == "image.attach_bytes" {
            let mime = if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
                "image/jpeg"
            } else if bytes.starts_with(b"GIF8") {
                "image/gif"
            } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
                "image/webp"
            } else if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
                "image/png"
            } else {
                return Err(Error::new(
                    4017,
                    "payload is not a supported PNG, JPEG, GIF, or WebP image",
                ));
            };
            Some(json!({"type":"image","data":encoded,"mimeType":mime}))
        } else {
            None
        };
        let _attachment = s.attachment_gate.lock().await;
        ensure_open(s)?;
        let id = common::id();
        let path = store::session_dir(&self.home, &s.stored)?
            .join("attachments")
            .join(format!("{id}-{name}"));
        let mut staged = stage_files(vec![(path.clone(), bytes)]).await?;
        let mut state = s.state.lock().unwrap();
        if state.closed {
            return Err(Error::new(4001, "session not found"));
        }
        if let Some(image) = &image {
            ensure_envelope(&state.staged, std::slice::from_ref(image))?;
        }
        let (images, refs) = match image {
            Some(image) => (vec![image], vec![]),
            None => (vec![], vec![path.to_string_lossy().into_owned()]),
        };
        state.staged.push(Staged {
            id: id.clone(),
            images,
            refs,
            files: std::mem::take(&mut staged.0),
        });
        state.last_activity = common::now();
        Ok(
            json!({"attached":true,"id":id,"name":name,"path":path,"ref_text":format!("Attached file: {}",path.display()),"count":count(&state.staged)}),
        )
    }
    async fn attach_pdf(&self, s: &Live, p: &Value, name: &str, bytes: &[u8]) -> Result<Value> {
        if !bytes.starts_with(b"%PDF-") {
            return Err(Error::new(
                4017,
                "payload is not a PDF (missing %PDF- magic bytes)",
            ));
        }
        let number = |key: &str, default: u64| -> Result<u64> {
            match p.get(key).filter(|v| !v.is_null()) {
                Some(value) => value
                    .as_u64()
                    // Poppler parses -f/-l as signed 32-bit integers; larger
                    // values can wrap and render a different page.
                    .filter(|n| (1..=i32::MAX as u64).contains(n))
                    .ok_or_else(|| {
                        Error::new(4015, format!("{key} must be between 1 and {}", i32::MAX))
                    }),
                None => Ok(default),
            }
        };
        let first = number("first_page", 1)?;
        let last = number("last_page", (first + 24).min(i32::MAX as u64))?;
        if last < first {
            return Err(Error::new(4015, "last_page must be >= first_page"));
        }
        if last - first >= 25 {
            return Err(Error::new(
                4019,
                "page range exceeds cap of 25 pages per attach call",
            ));
        }
        let config = common::read_config(&self.home)?;
        let backend = pdf_backend(&config, std::env::consts::OS)?;
        let render = Arc::new(pdf_render_permit(&PDF_RENDERS, || ensure_open(s)).await?);
        let tmp = tempfile::tempdir()?;
        let input = tmp.path().join("input.pdf");
        fs::write(&input, bytes)?;
        let mut command = match backend {
            PdfBackend::Host => tokio::process::Command::new(
                config["attachments"]["pdf_renderer"]
                    .as_str()
                    .unwrap_or("pdftoppm"),
            ),
            PdfBackend::Vm => vm_command()?,
        };
        command
            .args([
                "-png",
                "-r",
                "150",
                "-f",
                &first.to_string(),
                "-l",
                &last.to_string(),
                "-W",
                PDF_RENDER_EDGE,
                "-H",
                PDF_RENDER_EDGE,
            ])
            .arg(&input);
        let data = render_pdf(backend, command, Some(render.clone()), PDF_RENDER_BOUNDS).await?;
        let _attachment = s.attachment_gate.lock().await;
        ensure_open(s)?;
        let id = common::id();
        let dir = store::session_dir(&self.home, &s.stored)?.join("attachments");
        let prefix = id.clone();
        let (images, pages, mut staged) = tokio::task::spawn_blocking(move || {
            // A cancelled RPC must not release the memory reservation while
            // its blocking encoding and staging are still running.
            let _render = render;
            stage_pdf_pages(&data, first, (last - first + 1) as usize, &dir, &prefix)
        })
        .await
        .map_err(|e| Error::new(5200, e.to_string()))??;
        let mut state = s.state.lock().unwrap();
        if state.closed {
            return Err(Error::new(4001, "session not found"));
        }
        ensure_envelope(&state.staged, &images)?;
        state.staged.push(Staged {
            id: id.clone(),
            images,
            refs: vec![],
            files: std::mem::take(&mut staged.0),
        });
        state.last_activity = common::now();
        Ok(json!({
            "attached": true,
            "id": id,
            "filename": name,
            "pages_attached": pages.len(),
            "pages": pages,
            "count": count(&state.staged),
            "text": format!("[User attached PDF: {name} ({} page(s))]", pages.len())
        }))
    }
}
async fn pdf_render_permit(
    gate: &tokio::sync::Semaphore,
    check_open: impl Fn() -> Result<()>,
) -> Result<tokio::sync::SemaphorePermit<'_>> {
    check_open()?;
    let permit = gate
        .acquire()
        .await
        .map_err(|_| Error::new(5028, "PDF renderer is unavailable"))?;
    check_open()?;
    Ok(permit)
}

// Group cleanup precedes Child's drop/reaper handoff, including if the owned
// worker itself is aborted. Normal cancellation waits for reap before this
// struct releases its reservation.
struct RenderChild {
    child: tokio::process::Child,
    #[cfg(unix)]
    group: Option<libc::pid_t>,
    waited: bool,
    _reservation: Option<RenderReservation>,
}
impl RenderChild {
    fn new(child: tokio::process::Child, reservation: Option<RenderReservation>) -> Self {
        Self {
            #[cfg(unix)]
            group: child
                .id()
                .and_then(|pid| libc::pid_t::try_from(pid).ok())
                .filter(|pid| *pid > 0),
            child,
            waited: false,
            _reservation: reservation,
        }
    }
    #[cfg(unix)]
    fn kill_group(&mut self) {
        if let Some(group) = self.group.take() {
            // This group was created for this child and its leader has not
            // been reaped. Never signal a numeric PGID after wait returns.
            unsafe {
                libc::kill(-group, libc::SIGKILL);
            }
        }
    }
    fn abort(&mut self) {
        if !self.waited {
            #[cfg(unix)]
            self.kill_group();
            let _ = self.child.start_kill();
        }
    }
    async fn wait(&mut self) -> std::io::Result<std::process::ExitStatus> {
        let result = self.child.wait().await;
        self.waited = true;
        #[cfg(unix)]
        {
            self.group = None;
        }
        result
    }
}
impl Drop for RenderChild {
    fn drop(&mut self) {
        if !self.waited {
            #[cfg(unix)]
            self.kill_group();
        }
    }
}

struct CancelRender(Option<tokio::sync::oneshot::Sender<()>>);
impl Drop for CancelRender {
    fn drop(&mut self) {
        if let Some(cancel) = self.0.take() {
            let _ = cancel.send(());
        }
    }
}

async fn render_pdf(
    backend: PdfBackend,
    mut command: tokio::process::Command,
    reservation: Option<RenderReservation>,
    bounds: RenderBounds,
) -> Result<Vec<u8>> {
    if backend == PdfBackend::Vm {
        // The absolute helper/assets paths were resolved in the daemon. No
        // credentials, loader hooks or custom renderer environment enter it.
        command.env_clear();
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    #[cfg(target_os = "linux")]
    // SAFETY: setrlimit/getrlimit are async-signal-safe. Only the renderer inherits
    // these caps; existing stricter limits remain stricter. RLIMIT_DATA also
    // covers anonymous mmap allocations on supported Linux kernels. Allow for
    // V8's code-range reservation so configured Node renderers can start on x64.
    unsafe {
        command.pre_exec(|| {
            for (resource, cap) in [
                (libc::RLIMIT_DATA, (1024 * 1024 * 1024) as libc::rlim_t),
                (libc::RLIMIT_CPU, 120 as libc::rlim_t),
                (libc::RLIMIT_FSIZE, PDF_OUTPUT_LIMIT as libc::rlim_t),
                (libc::RLIMIT_CORE, 0 as libc::rlim_t),
            ] {
                let mut limit = libc::rlimit {
                    rlim_cur: 0,
                    rlim_max: 0,
                };
                if libc::getrlimit(resource, &mut limit) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                limit.rlim_cur = limit.rlim_cur.min(cap);
                limit.rlim_max = limit.rlim_max.min(cap);
                if libc::setrlimit(resource, &limit) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
            }
            Ok(())
        });
    }
    let child = command.spawn().map_err(|error| {
        Error::new(
            5028,
            if error.kind() == std::io::ErrorKind::NotFound {
                if backend == PdfBackend::Vm {
                    VM_REPAIR.into()
                } else {
                    "pdftoppm not installed (poppler-utils package required)".into()
                }
            } else {
                if backend == PdfBackend::Vm {
                    VM_REPAIR.into()
                } else {
                    format!("pdftoppm could not start: {error}")
                }
            },
        )
    })?;
    let mut child = RenderChild::new(child, reservation);
    let stdout = child.child.stdout.take().expect("renderer stdout is piped");
    let (cancel, cancelled) = tokio::sync::oneshot::channel();
    let _cancel = CancelRender(Some(cancel));
    // This task owns the child and reservation through cleanup. Dropping the
    // caller signals cancellation; it never leaves the renderer running.
    tokio::spawn(async move {
        let result = tokio::select! {
            _ = cancelled => Err(Error::new(5028, "PDF rendering was cancelled")),
            result = tokio::time::timeout(bounds.timeout, async {
                let data = read_pdf_stdout(stdout, bounds.bytes).await?;
                let status = child.wait().await.map_err(|error| {
                    Error::new(5028, format!("pdftoppm wait failed: {error}"))
                })?;
                if !status.success() {
                    return Err(renderer_failed(backend, status.code()));
                }
                Ok(data)
            }) => result.unwrap_or_else(|_| Err(Error::new(
                5028, format!("{} timed out (>{}s)", if backend == PdfBackend::Vm { "PDF VM" } else { "pdftoppm" }, bounds.timeout.as_secs_f64())
            ))),
        };
        if result.is_err() {
            child.abort();
            let _ = child.wait().await;
        }
        result
    })
    .await
    .map_err(|error| Error::new(5028, format!("PDF renderer task failed: {error}")))?
}

async fn read_pdf_stdout(reader: impl AsyncRead + Unpin, limit: usize) -> Result<Vec<u8>> {
    let mut data = vec![];
    let cap = (limit as u64)
        .checked_add(1)
        .ok_or_else(envelope_exceeded)?;
    reader
        .take(cap)
        .read_to_end(&mut data)
        .await
        .map_err(|error| Error::new(5028, format!("Could not read pdftoppm output: {error}")))?;
    if data.len() > limit {
        return Err(envelope_exceeded());
    }
    Ok(data)
}

fn invalid_png() -> Error {
    Error::new(5028, "pdftoppm produced an invalid PNG page")
}

// Poppler writes complete PNGs back to back when no output root is supplied.
// Only bounded slices are inspected; chunk lengths never become allocations.
fn png_pages(data: &[u8], max_pages: usize, mut budget: usize) -> Result<Vec<Range<usize>>> {
    if data.is_empty() {
        return Err(Error::new(
            5028,
            "pdftoppm produced no pages (corrupt PDF?)",
        ));
    }
    let mut pages = vec![];
    let mut at = 0usize;
    while at < data.len() {
        let signature_end = at.checked_add(8).ok_or_else(invalid_png)?;
        if pages.len() >= max_pages.min(25)
            || data.get(at..signature_end) != Some(b"\x89PNG\r\n\x1a\n")
        {
            return Err(invalid_png());
        }
        let start = at;
        at = signature_end;
        let mut header = false;
        let mut pixels = false;
        loop {
            let length = data
                .get(at..at.checked_add(4).ok_or_else(invalid_png)?)
                .ok_or_else(invalid_png)?;
            let length = u32::from_be_bytes(length.try_into().unwrap()) as usize;
            let end = at
                .checked_add(12)
                .and_then(|n| n.checked_add(length))
                .filter(|end| *end <= data.len())
                .ok_or_else(invalid_png)?;
            let kind = &data[at + 4..at + 8];
            let mut crc = flate2::Crc::new();
            crc.update(&data[at + 4..end - 4]);
            if crc.sum() != u32::from_be_bytes(data[end - 4..end].try_into().unwrap()) {
                return Err(invalid_png());
            }
            if !header && kind != b"IHDR" {
                return Err(invalid_png());
            }
            match kind {
                b"IHDR" => {
                    if header || length != 13 {
                        return Err(invalid_png());
                    }
                    header = true;
                    let width = u32::from_be_bytes(data[at + 8..at + 12].try_into().unwrap());
                    let height = u32::from_be_bytes(data[at + 12..at + 16].try_into().unwrap());
                    if width == 0 || height == 0 {
                        return Err(invalid_png());
                    }
                    if width > PDF_PAGE_EDGE || height > PDF_PAGE_EDGE {
                        return Err(Error::new(
                            4018,
                            format!(
                                "PDF pages must fit within {PDF_PAGE_EDGE} pixels at 150 dpi. Use a smaller page size."
                            ),
                        ));
                    }
                }
                b"IDAT" => pixels = true,
                b"IEND" => {
                    if length != 0 || !pixels {
                        return Err(invalid_png());
                    }
                    let size = end - start;
                    budget = budget
                        .checked_sub(4 * size.div_ceil(3) + 256)
                        .ok_or_else(envelope_exceeded)?;
                    pages.push(start..end);
                    at = end;
                    break;
                }
                _ => {}
            }
            at = end;
        }
    }
    Ok(pages)
}

fn stage_pdf_pages(
    data: &[u8],
    first: u64,
    max_pages: usize,
    dir: &Path,
    prefix: &str,
) -> Result<(Vec<Value>, Vec<Value>, StagedFiles)> {
    let ranges = png_pages(data, max_pages, IMAGE_ENVELOPE_LIMIT)?;
    let mut images = vec![];
    let mut pages = vec![];
    let mut files = vec![];
    for (index, range) in ranges.into_iter().enumerate() {
        let page = first + index as u64;
        let bytes = &data[range];
        images.push(json!({"type":"image","data":base64::engine::general_purpose::STANDARD.encode(bytes),"mimeType":"image/png"}));
        let destination = dir.join(format!("{prefix}-pdf_p{page}.png"));
        pages.push(json!({"path":destination,"page":page}));
        files.push((destination, bytes));
    }
    Ok((images, pages, write_files(files)?))
}

// Unregistered files are removed on errors, cancellation, or a concurrent close.
/// Staging must not recreate the folder of a section that is closing.
fn ensure_open(s: &Live) -> Result<()> {
    if s.state.lock().unwrap().closed {
        return Err(Error::new(4001, "session not found"));
    }
    Ok(())
}
struct StagedFiles(Vec<PathBuf>);
impl Drop for StagedFiles {
    fn drop(&mut self) {
        for path in &self.0 {
            let _ = fs::remove_file(path);
        }
    }
}
async fn stage_files(files: Vec<(PathBuf, Vec<u8>)>) -> Result<StagedFiles> {
    tokio::task::spawn_blocking(move || write_files(files))
        .await
        .map_err(|e| Error::new(5200, e.to_string()))?
}
fn write_files<B: AsRef<[u8]>>(files: Vec<(PathBuf, B)>) -> Result<StagedFiles> {
    let mut staged = StagedFiles(vec![]);
    let total = files
        .iter()
        .map(|(_, bytes)| bytes.as_ref().len() as u64)
        .sum();
    ensure_total(files[0].0.parent().unwrap(), total)?;
    for (path, bytes) in files {
        common::atomic_write(&path, bytes.as_ref())?;
        staged.0.push(path);
    }
    Ok(staged)
}
/// Images and file references waiting for the next prompt.
fn count(staged: &[Staged]) -> usize {
    staged.iter().map(|u| u.images.len() + u.refs.len()).sum()
}
fn ensure_envelope(existing: &[Staged], additional: &[Value]) -> Result<()> {
    // Leave space for the prompt, metadata, JSON escaping, and a bounded file list.
    let bytes = existing
        .iter()
        .flat_map(|u| &u.images)
        .chain(additional)
        .map(|v| v["data"].as_str().map_or(0, str::len) + 256)
        .sum::<usize>();
    if bytes > IMAGE_ENVELOPE_LIMIT {
        return Err(envelope_exceeded());
    }
    Ok(())
}
fn envelope_exceeded() -> Error {
    Error::new(4018, "staged images exceed the bot request size limit")
}

fn ensure_total(dir: &Path, additional: u64) -> Result<()> {
    let mut total = additional;
    if dir.exists() {
        for entry in fs::read_dir(dir)? {
            total = total.saturating_add(entry?.metadata()?.len());
        }
    }
    if total > SESSION_LIMIT {
        return Err(Error::new(4018, "Attachments in this chat exceed 512 MiB"));
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    #[cfg(unix)]
    #[tokio::test]
    async fn vm_helpers_receive_no_daemon_environment_but_host_renderers_keep_it() {
        use super::*;
        let mut host = tokio::process::Command::new("/usr/bin/env");
        host.env("HEXBOT_PDF_ENV_PROBE", "sentinel");
        let bytes = render_pdf(PdfBackend::Host, host, None, PDF_RENDER_BOUNDS)
            .await
            .unwrap();
        assert!(
            bytes
                .windows(b"HEXBOT_PDF_ENV_PROBE=sentinel".len())
                .any(|part| part == b"HEXBOT_PDF_ENV_PROBE=sentinel")
        );
        let mut vm = tokio::process::Command::new("/usr/bin/env");
        vm.env("HEXBOT_PDF_ENV_PROBE", "sentinel");
        let bytes = render_pdf(PdfBackend::Vm, vm, None, PDF_RENDER_BOUNDS)
            .await
            .unwrap();
        assert!(
            bytes.is_empty(),
            "the VM helper must not inherit daemon environment variables"
        );
    }
    #[test]
    fn pdf_backend_defaults_and_opt_ins_do_not_fall_back() {
        use super::*;
        assert_eq!(pdf_backend(&json!({}), "macos").unwrap(), PdfBackend::Vm);
        assert_eq!(pdf_backend(&json!({}), "linux").unwrap(), PdfBackend::Host);
        let custom = json!({"attachments":{"pdf_renderer":"custom"}});
        assert_eq!(pdf_backend(&custom, "macos").unwrap(), PdfBackend::Vm);
        assert_eq!(pdf_backend(&custom, "linux").unwrap(), PdfBackend::Host);
        for os in ["linux", "macos"] {
            assert_eq!(
                pdf_backend(&json!({"attachments":{"pdf_backend":"host"}}), os).unwrap(),
                PdfBackend::Host
            );
            for value in [
                Value::Null,
                json!(true),
                json!(1),
                json!("unknown"),
                json!([]),
            ] {
                assert_eq!(
                    pdf_backend(&json!({"attachments":{"pdf_backend":value}}), os)
                        .unwrap_err()
                        .code,
                    4202
                );
            }
        }
        for backend in [
            json!({}),
            json!({"attachments":{"pdf_backend":"host"}}),
            json!({"attachments":{"pdf_backend":"vm"}}),
        ] {
            assert_eq!(pdf_backend(&backend, "windows").unwrap_err().code, 5028);
        }
        assert_eq!(
            pdf_backend(&json!({"attachments":{"pdf_backend":"vm"}}), "linux")
                .unwrap_err()
                .code,
            5028
        );
    }

    #[test]
    fn translated_intel_pdf_helpers_require_apple_silicon_runtime() {
        use super::*;
        native_pdf_arch("aarch64", true, false).unwrap();
        native_pdf_arch("x86_64", false, false).unwrap();
        for translated in [false, true] {
            assert!(
                native_pdf_arch("x86_64", true, translated)
                    .unwrap_err()
                    .message
                    .contains("Apple silicon Full or Headless")
            );
        }
        assert!(native_pdf_arch("aarch64", true, true).is_err());
        assert!(native_pdf_arch("aarch64", false, false).is_err());
        for code in [1, 65, 69, 78, 124] {
            let error = renderer_failed(PdfBackend::Vm, Some(code));
            assert_eq!(error.code, 5028);
            if code == 78 {
                assert!(error.message.contains("Update or repair"));
            }
        }
        assert_eq!(renderer_failed(PdfBackend::Vm, Some(80)).code, 4018);
        assert_eq!(renderer_failed(PdfBackend::Host, Some(80)).code, 5028);
    }

    #[test]
    #[cfg(unix)]
    fn pdf_vm_resolves_only_a_sibling_or_explicit_absolute_trusted_directory() {
        use super::*;
        assert_eq!(
            pdf_vm_directory(Path::new("/bundle/hexbot-core"), None).unwrap(),
            PathBuf::from("/bundle/pdf")
        );
        assert_eq!(
            pdf_vm_directory(
                Path::new("/build/hexbot"),
                Some(std::ffi::OsStr::new("/dev/pdf"))
            )
            .unwrap(),
            PathBuf::from("/dev/pdf")
        );
        assert!(
            pdf_vm_directory(
                Path::new("/build/hexbot"),
                Some(std::ffi::OsStr::new("relative/pdf"))
            )
            .is_err()
        );
    }
    use super::*;

    fn png(width: u32, height: u32) -> Vec<u8> {
        let mut data = std::io::Cursor::new(vec![]);
        image::RgbaImage::new(width, height)
            .write_to(&mut data, image::ImageFormat::Png)
            .unwrap();
        data.into_inner()
    }
    fn repair_crc(data: &mut [u8], at: usize) {
        let length = u32::from_be_bytes(data[at..at + 4].try_into().unwrap()) as usize;
        let end = at + 12 + length;
        let mut crc = flate2::Crc::new();
        crc.update(&data[at + 4..end - 4]);
        data[end - 4..end].copy_from_slice(&crc.sum().to_be_bytes());
    }

    #[tokio::test]
    async fn waiting_pdf_renders_cancel_and_recheck_closed_sessions() {
        use std::sync::atomic::{AtomicBool, Ordering};
        let gate = tokio::sync::Semaphore::new(1);
        let first = pdf_render_permit(&gate, || Ok(())).await.unwrap();
        let mut cancelled = Box::pin(pdf_render_permit(&gate, || Ok(())));
        assert!(futures_util::poll!(cancelled.as_mut()).is_pending());
        drop(cancelled);
        let closed = AtomicBool::new(false);
        let mut waiting = Box::pin(pdf_render_permit(&gate, || {
            if closed.load(Ordering::Relaxed) {
                Err(Error::new(4001, "session not found"))
            } else {
                Ok(())
            }
        }));
        assert!(futures_util::poll!(waiting.as_mut()).is_pending());
        closed.store(true, Ordering::Relaxed);
        drop(first);
        assert_eq!(waiting.await.err().unwrap().code, 4001);
        drop(pdf_render_permit(&gate, || Ok(())).await.unwrap());
        assert_eq!(gate.available_permits(), 1);
    }

    #[tokio::test]
    async fn renderer_stderr_is_discarded_and_stdout_is_preserved() {
        let mut command = tokio::process::Command::new("node");
        command.args([
            "-e",
            r#"
const fs = require('node:fs');
if (!fs.fstatSync(1).isFIFO() || !fs.fstatSync(2).isCharacterDevice()) process.exit(33);
const chunk = Buffer.alloc(64 * 1024, 120);
for (let n = 0; n < 64; n++) fs.writeSync(2, chunk);
process.stdout.write('page');
"#,
        ]);
        assert_eq!(
            render_pdf(PdfBackend::Host, command, None, PDF_RENDER_BOUNDS)
                .await
                .unwrap(),
            b"page"
        );
    }

    #[tokio::test]
    async fn renderer_failure_keeps_the_generic_error() {
        let mut command = tokio::process::Command::new("node");
        command.args([
            "-e",
            "process.stderr.write('private renderer diagnostics'); process.exit(9)",
        ]);
        let error = render_pdf(PdfBackend::Host, command, None, PDF_RENDER_BOUNDS)
            .await
            .unwrap_err();
        assert_eq!(error.code, 5028);
        assert_eq!(error.message, "pdftoppm failed to render this PDF");
    }

    #[tokio::test]
    async fn stdout_bounds_accept_exact_limit_and_stop_after_one_excess_byte() {
        assert_eq!(
            read_pdf_stdout(&b"12345678"[..], 8).await.unwrap(),
            b"12345678"
        );
        let mut growing = &b"123456789 more output"[..];
        assert_eq!(
            read_pdf_stdout(&mut growing, 8).await.unwrap_err().code,
            4018
        );
        assert_eq!(growing, b" more output");
        assert!(read_pdf_stdout(&b""[..], 8).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn stdout_read_errors_are_reported() {
        struct Broken;
        impl AsyncRead for Broken {
            fn poll_read(
                self: std::pin::Pin<&mut Self>,
                _: &mut std::task::Context<'_>,
                _: &mut tokio::io::ReadBuf<'_>,
            ) -> std::task::Poll<std::io::Result<()>> {
                std::task::Poll::Ready(Err(std::io::Error::other("fixture read failure")))
            }
        }
        assert!(read_pdf_stdout(Broken, 8).await.is_err());
    }

    #[tokio::test]
    async fn renderer_overflow_kills_and_reaps_the_child() {
        let temp = tempfile::tempdir().unwrap();
        let pid = temp.path().join("pid");
        let mut command = tokio::process::Command::new("node");
        command.args(["-e", "require('node:fs').writeFileSync(process.argv[1],String(process.pid));process.stdout.write(Buffer.alloc(65536));setInterval(()=>{},1000)"]).arg(&pid);
        let error = render_pdf(
            PdfBackend::Host,
            command,
            None,
            RenderBounds {
                bytes: 8,
                ..PDF_RENDER_BOUNDS
            },
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, 4018);
        #[cfg(unix)]
        assert_eq!(
            unsafe { libc::kill(fs::read_to_string(pid).unwrap().parse().unwrap(), 0) },
            -1
        );
    }

    #[tokio::test]
    async fn renderer_deadline_covers_both_missing_eof_and_missing_exit() {
        for close_stdout in [false, true] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let mut command = tokio::process::Command::new("node");
            command
                .args(["-e", "const fs=require('node:fs');if(process.argv[1]==='close')fs.closeSync(1);else fs.writeSync(1,'page');const c=require('node:net').connect(Number(process.argv[2]),'127.0.0.1',()=>c.write('ready'));setInterval(()=>{},1000)"])
                .arg(if close_stdout { "close" } else { "open" })
                .arg(listener.local_addr().unwrap().port().to_string());
            let rendering = render_pdf(
                PdfBackend::Host,
                command,
                None,
                RenderBounds {
                    timeout: Duration::from_secs(1),
                    ..PDF_RENDER_BOUNDS
                },
            );
            tokio::pin!(rendering);
            let (_ready, _) = tokio::select! {
                result = &mut rendering => panic!("renderer ended before child readiness: {result:?}"),
                connection = listener.accept() => connection.unwrap(),
            };
            let error = rendering.await.unwrap_err();
            assert_eq!(error.code, 5028);
            assert!(error.message.contains("timed out"));
        }
    }

    #[tokio::test]
    async fn cancelling_renderer_keeps_its_reservation_until_the_child_is_reaped() {
        use tokio::io::AsyncBufReadExt;
        static GATE: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut command = tokio::process::Command::new("node");
        command.args(["-e", "const c=require('node:net').connect(Number(process.argv[1]),'127.0.0.1',()=>c.write(String(process.pid)+'\\n'));setInterval(()=>{},1000)"]).arg(listener.local_addr().unwrap().port().to_string());
        let permit = Arc::new(GATE.acquire().await.unwrap());
        let task = tokio::spawn(render_pdf(
            PdfBackend::Host,
            command,
            Some(permit),
            PDF_RENDER_BOUNDS,
        ));
        let (socket, _) = tokio::time::timeout(Duration::from_secs(10), listener.accept())
            .await
            .unwrap()
            .unwrap();
        let mut socket = tokio::io::BufReader::new(socket);
        let mut pid = String::new();
        socket.read_line(&mut pid).await.unwrap();
        assert_eq!(GATE.available_permits(), 0);
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        let _permit = tokio::time::timeout(Duration::from_secs(10), GATE.acquire())
            .await
            .unwrap()
            .unwrap();
        #[cfg(unix)]
        assert_eq!(unsafe { libc::kill(pid.trim().parse().unwrap(), 0) }, -1);
    }

    #[cfg(unix)]
    fn wrapper(exec: bool, port: u16, mode: &str) -> tokio::process::Command {
        let mut command = tokio::process::Command::new("/bin/sh");
        command.args([
            "-c",
            if exec { "exec node \"$@\"" } else { "node \"$@\" & wait" },
            "pdf-wrapper", "-e",
            "const c=require('node:net').connect(Number(process.argv[1]),'127.0.0.1',()=>{c.write(String(process.pid)+'\\n');if(process.argv[2]==='overflow')require('node:fs').writeSync(1,Buffer.alloc(65536));});setInterval(()=>{},1000)",
        ]).arg(port.to_string()).arg(mode);
        command
    }

    #[cfg(unix)]
    fn assert_not_running(pid: &str) {
        let output = std::process::Command::new("ps")
            .args(["-o", "stat=", "-p", pid.trim()])
            .output()
            .unwrap();
        let state = String::from_utf8(output.stdout).unwrap();
        // A container's PID 1 may retain an orphan zombie. It is terminated,
        // whereas a live decoder must never survive the wrapper's cleanup.
        assert!(
            state.trim().is_empty() || state.trim().starts_with('Z'),
            "decoder {pid}: {state}"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn wrapper_decoders_stop_on_cancel_timeout_and_output_overflow() {
        use tokio::io::AsyncBufReadExt;
        static GATE: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);
        for exec in [false, true] {
            for mode in ["cancel", "timeout", "overflow"] {
                let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
                let command = wrapper(exec, listener.local_addr().unwrap().port(), mode);
                let permit = Arc::new(GATE.acquire().await.unwrap());
                let task = tokio::spawn(render_pdf(
                    PdfBackend::Host,
                    command,
                    Some(permit),
                    RenderBounds {
                        bytes: if mode == "overflow" {
                            8
                        } else {
                            PDF_OUTPUT_LIMIT
                        },
                        timeout: if mode == "timeout" {
                            Duration::from_secs(1)
                        } else {
                            PDF_RENDER_BOUNDS.timeout
                        },
                    },
                ));
                let (socket, _) = tokio::time::timeout(Duration::from_secs(10), listener.accept())
                    .await
                    .unwrap()
                    .unwrap();
                let mut socket = tokio::io::BufReader::new(socket);
                let mut pid = String::new();
                socket.read_line(&mut pid).await.unwrap();
                if mode == "cancel" {
                    task.abort();
                    assert!(task.await.unwrap_err().is_cancelled());
                } else {
                    let error = task.await.unwrap().unwrap_err();
                    assert_eq!(error.code, if mode == "overflow" { 4018 } else { 5028 });
                }
                let _permit = tokio::time::timeout(Duration::from_secs(10), GATE.acquire())
                    .await
                    .unwrap()
                    .unwrap();
                let mut tail = vec![];
                tokio::time::timeout(Duration::from_secs(10), socket.read_to_end(&mut tail))
                    .await
                    .unwrap()
                    .unwrap();
                assert_not_running(&pid);
            }
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn aborting_the_owned_worker_drops_its_group_before_the_child() {
        use tokio::io::AsyncBufReadExt;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut command = wrapper(false, listener.local_addr().unwrap().port(), "idle");
        command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .process_group(0);
        let mut child = RenderChild::new(command.spawn().unwrap(), None);
        let worker = tokio::spawn(async move { child.wait().await });
        let (socket, _) = tokio::time::timeout(Duration::from_secs(10), listener.accept())
            .await
            .unwrap()
            .unwrap();
        let mut socket = tokio::io::BufReader::new(socket);
        let mut pid = String::new();
        socket.read_line(&mut pid).await.unwrap();
        worker.abort();
        assert!(worker.await.unwrap_err().is_cancelled());
        let mut tail = vec![];
        tokio::time::timeout(Duration::from_secs(10), socket.read_to_end(&mut tail))
            .await
            .unwrap()
            .unwrap();
        assert_not_running(&pid);
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn renderer_resource_caps_apply_to_the_child() {
        let temp = tempfile::tempdir().unwrap();
        let report = temp.path().join("limits.json");
        let mut command = tokio::process::Command::new("python3");
        command.args(["-c", r#"
import json, resource, sys
limits = {name: resource.getrlimit(getattr(resource, 'RLIMIT_' + name)) for name in ['DATA','CPU','FSIZE','CORE']}
with open(sys.argv[1], 'w') as target: json.dump(limits, target)
"#]).arg(&report);
        render_pdf(PdfBackend::Host, command, None, PDF_RENDER_BOUNDS)
            .await
            .unwrap();
        let limits: Value = serde_json::from_slice(&fs::read(report).unwrap()).unwrap();
        for (name, cap) in [
            ("DATA", 1024 * 1024 * 1024),
            ("CPU", 120),
            ("FSIZE", (IMAGE_ENVELOPE_LIMIT - 256) / 4 * 3),
            ("CORE", 0),
        ] {
            for limit in limits[name].as_array().unwrap() {
                assert!(limit.as_u64().unwrap() <= cap as u64, "{limits}");
            }
        }
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn renderer_limits_preserve_lower_inherited_caps() {
        let temp = tempfile::tempdir().unwrap();
        let report = temp.path().join("limits.json");
        let mut command = tokio::process::Command::new("python3");
        command.args(["-c", r#"
import json, resource, sys
limits = {name: resource.getrlimit(getattr(resource, 'RLIMIT_' + name)) for name in ['DATA','CPU','FSIZE','CORE']}
with open(sys.argv[1], 'w') as target: json.dump(limits, target)
"#]).arg(&report);
        // SAFETY: the child only lowers its own resource limits.
        unsafe {
            command.pre_exec(|| {
                for (resource, cap) in [
                    (libc::RLIMIT_DATA, 128 * 1024 * 1024),
                    (libc::RLIMIT_CPU, 3),
                    (libc::RLIMIT_FSIZE, 4096),
                    (libc::RLIMIT_CORE, 0),
                ] {
                    let limit = libc::rlimit {
                        rlim_cur: cap,
                        rlim_max: cap,
                    };
                    if libc::setrlimit(resource, &limit) != 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                }
                Ok(())
            });
        }
        render_pdf(PdfBackend::Host, command, None, PDF_RENDER_BOUNDS)
            .await
            .unwrap();
        let limits: Value = serde_json::from_slice(&fs::read(report).unwrap()).unwrap();
        assert_eq!(
            limits,
            json!({"DATA":[134217728,134217728],"CPU":[3,3],"FSIZE":[4096,4096],"CORE":[0,0]})
        );
    }

    #[test]
    fn attachment_limits_fit_transport_with_room_for_json() {
        for method in ["file.attach", "pdf.attach", "image.attach_bytes"] {
            let bytes = attachment_limit_mib(method) * 1024 * 1024;
            assert!(4 * bytes.div_ceil(3) + 1024 * 1024 < crate::server::WS_MESSAGE_LIMIT);
        }
    }
    #[test]
    fn total_includes_files_from_prior_turns_and_rendered_pages() {
        let dir = tempfile::tempdir().unwrap();
        let file = fs::File::create(dir.path().join("old.bin")).unwrap();
        file.set_len(SESSION_LIMIT - 10).unwrap();
        assert!(ensure_total(dir.path(), 10).is_ok());
        assert_eq!(ensure_total(dir.path(), 11).unwrap_err().code, 4018);
    }

    #[test]
    fn png_stream_preserves_pages_and_exact_encoded_budget() {
        let first = png(1, 1);
        let second = png(2, 1);
        let data = [first.clone(), second.clone()].concat();
        let budget = [first.len(), second.len()]
            .into_iter()
            .map(|n| 4 * n.div_ceil(3) + 256)
            .sum();
        assert_eq!(
            png_pages(&data, 2, budget).unwrap(),
            [0..first.len(), first.len()..data.len()]
        );
        assert_eq!(png_pages(&data, 2, budget - 1).unwrap_err().code, 4018);
        assert_eq!(png_pages(&data, 1, budget).unwrap_err().code, 5028);
        let many = first.repeat(25);
        assert_eq!(
            png_pages(&many, 25, IMAGE_ENVELOPE_LIMIT).unwrap().len(),
            25
        );
        assert_eq!(
            png_pages(&first.repeat(26), 25, IMAGE_ENVELOPE_LIMIT)
                .unwrap_err()
                .code,
            5028
        );
    }

    #[test]
    fn png_stream_rejects_truncation_forged_lengths_crc_and_trailing_junk() {
        let page = png(1, 1);
        for end in 0..page.len() {
            assert_eq!(
                png_pages(&page[..end], 25, IMAGE_ENVELOPE_LIMIT)
                    .unwrap_err()
                    .code,
                5028
            );
        }
        let mut forged = page.clone();
        forged[8..12].copy_from_slice(&u32::MAX.to_be_bytes());
        let mut corrupt = page.clone();
        corrupt[20] ^= 1;
        let mut trailing = page.clone();
        trailing.push(0);
        let mut duplicate_header = page[..33].to_vec();
        duplicate_header.extend_from_slice(&page[8..]);
        let mut missing_data = page[..33].to_vec();
        missing_data.extend_from_slice(&page[page.len() - 12..]);
        for data in [forged, corrupt, trailing, duplicate_header, missing_data] {
            assert_eq!(
                png_pages(&data, 25, IMAGE_ENVELOPE_LIMIT).unwrap_err().code,
                5028
            );
        }
    }

    #[test]
    fn png_dimensions_refuse_the_crop_sentinel_and_accept_the_limit() {
        let page = png(1, 1);
        for (width, height, code) in [
            (8193u32, 1u32, 4018),
            (1, 8193, 4018),
            (0, 1, 5028),
            (1, 0, 5028),
        ] {
            let mut data = page.clone();
            data[16..20].copy_from_slice(&width.to_be_bytes());
            data[20..24].copy_from_slice(&height.to_be_bytes());
            repair_crc(&mut data, 8);
            assert_eq!(
                png_pages(&data, 1, IMAGE_ENVELOPE_LIMIT).unwrap_err().code,
                code
            );
        }
        assert!(png_pages(&png(PDF_PAGE_EDGE, 1), 1, IMAGE_ENVELOPE_LIMIT).is_ok());
    }

    #[test]
    fn staged_pdf_pages_keep_numbering_bytes_and_cleanup_unregistered_files() {
        let temp = tempfile::tempdir().unwrap();
        let first = png(1, 1);
        let second = png(2, 1);
        let data = [first.clone(), second.clone()].concat();
        let dir = temp.path().join("attachments");
        let (images, pages, staged) = stage_pdf_pages(&data, 2, 2, &dir, "upload").unwrap();
        assert_eq!(
            pages
                .iter()
                .map(|p| p["page"].as_u64().unwrap())
                .collect::<Vec<_>>(),
            [2, 3]
        );
        assert_eq!(
            images[0]["data"],
            base64::engine::general_purpose::STANDARD.encode(&first)
        );
        assert_eq!(fs::read(dir.join("upload-pdf_p2.png")).unwrap(), first);
        assert_eq!(fs::read(dir.join("upload-pdf_p3.png")).unwrap(), second);
        drop(staged);
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 0);
        assert!(stage_pdf_pages(&data[..data.len() - 1], 2, 2, &dir, "broken").is_err());
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 0);
    }
}
