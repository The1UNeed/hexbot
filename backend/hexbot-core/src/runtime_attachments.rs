use super::*;
use std::process::Stdio;

const SESSION_LIMIT: u64 = 512 * 1024 * 1024;
/// Staged images travel inside one prompt record, which Pi reads into a JavaScript
/// string; keep well under V8's 512 MiB string cap so an oversized batch is refused
/// here instead of killing the bot on every retry.
pub(super) const ENVELOPE_LIMIT: usize = 128 * 1024 * 1024;
fn attachment_limit_mib(method: &str) -> usize {
    if method == "image.attach_bytes" {
        25
    } else {
        45
    }
}
/// The largest file a part upload can grow to, the largest attachment.
const UPLOAD_LIMIT: u64 = 45 * 1024 * 1024;
/// One part, decoded; clients send far less, so progress moves often.
const PART_LIMIT: usize = 8 * 1024 * 1024;
/// Part uploads a chat keeps at once, and how long one nobody finishes stays.
const UPLOADS_KEPT: usize = 4;
const UPLOAD_IDLE: Duration = Duration::from_secs(60 * 60);
/// A client's name for one part upload.
fn upload_id(value: &Value) -> Result<&str> {
    value
        .as_str()
        .filter(|id| {
            !id.is_empty()
                && id.len() <= 64
                && id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        })
        .ok_or_else(|| Error::new(4202, "upload must be 1 to 64 letters, digits, - or _"))
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
        // Parts of a file still on its way go too.
        let uploads = store::session_dir(&self.home, &s.stored)?.join("uploads");
        match fs::remove_dir_all(uploads) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        Ok(json!({"cleared": true}))
    }
    /// One upload the user took out of the composer. A message on its way
    /// already holds its uploads, so this never reaches into a turn: an upload
    /// that is no longer staged answers 4204.
    pub(super) async fn remove_attachment(&self, s: &Live, p: &Value) -> Result<Value> {
        let id = required(p, "id")?;
        let _attachment = s.attachment_gate.lock().await;
        ensure_open(s)?;
        let upload = {
            let mut state = s.state.lock().unwrap();
            let index = state
                .staged
                .iter()
                .position(|u| u.id == id)
                .ok_or_else(|| Error::new(4204, format!("attachment not found: {id}")))?;
            state.staged.remove(index)
        };
        for path in upload.files {
            match fs::remove_file(path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
        Ok(json!({"removed": true}))
    }
    /// One part of a file sent in parts, so a client can show how much of it
    /// arrived. Parts go in order: `offset` is the size so far, and 0 starts
    /// the upload afresh. They wait on disk in the chat's folder, where a new
    /// process for the chat finds them, until an attach call names the upload.
    pub(super) async fn attach_part(&self, s: &Live, p: &Value) -> Result<Value> {
        let upload = upload_id(&p["upload"])?.to_owned();
        let offset = p["offset"]
            .as_u64()
            .ok_or_else(|| Error::new(4015, "offset must be a non-negative integer"))?;
        // An empty part is fine: it starts a file of no bytes.
        let data = p["data"]
            .as_str()
            .ok_or_else(|| Error::new(4200, "missing parameter: data"))?;
        if data.len() > 4 * PART_LIMIT.div_ceil(3) {
            return Err(Error::new(4202, "a part may hold at most 8 MiB"));
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data)
            .map_err(|_| Error::new(4202, "invalid base64 part"))?;
        let _attachment = s.attachment_gate.lock().await;
        ensure_open(s)?;
        let dir = store::session_dir(&self.home, &s.stored)?.join("uploads");
        let received =
            tokio::task::spawn_blocking(move || write_part(&dir, &upload, offset, &bytes))
                .await
                .map_err(|e| Error::new(5200, e.to_string()))??;
        Ok(json!({"received": received}))
    }
    pub(super) async fn attach(&self, s: &Live, method: &str, p: &Value) -> Result<Value> {
        let (bytes, part) = self.attachment_bytes(s, method, p).await?;
        let staged = self.attach_bytes(s, method, p, bytes).await;
        // A failed attach keeps the parts, so a PDF the daemon cannot draw
        // can still go as a file.
        if staged.is_ok()
            && let Some(part) = part
        {
            let _ = fs::remove_file(part);
        }
        staged
    }
    /// The file an attach call carries: whole, or sent before in parts.
    async fn attachment_bytes(
        &self,
        s: &Live,
        method: &str,
        p: &Value,
    ) -> Result<(Vec<u8>, Option<PathBuf>)> {
        let limit_mib = attachment_limit_mib(method);
        let limit = limit_mib * 1024 * 1024;
        let too_big = || Error::new(4202, format!("attachment exceeds {limit_mib} MiB"));
        if let Some(upload) = p.get("upload").filter(|v| !v.is_null()) {
            let upload = upload_id(upload)?;
            // Under the gate, so no part lands while the file is read.
            let _attachment = s.attachment_gate.lock().await;
            ensure_open(s)?;
            let path = store::session_dir(&self.home, &s.stored)?
                .join("uploads")
                .join(format!("{upload}.part"));
            let reading = path.clone();
            let bytes = tokio::task::spawn_blocking(move || fs::read(reading))
                .await
                .map_err(|e| Error::new(5200, e.to_string()))?
                .map_err(|error| {
                    if error.kind() == std::io::ErrorKind::NotFound {
                        Error::new(4204, "upload not found; send the file again")
                    } else {
                        error.into()
                    }
                })?;
            if bytes.len() > limit {
                return Err(too_big());
            }
            return Ok((bytes, Some(path)));
        }
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
        if encoded.len() > 4 * limit.div_ceil(3) {
            return Err(too_big());
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .map_err(|_| Error::new(4202, "invalid base64 attachment"))?;
        if bytes.len() > limit {
            return Err(too_big());
        }
        Ok((bytes, None))
    }
    async fn attach_bytes(
        &self,
        s: &Live,
        method: &str,
        p: &Value,
        bytes: Vec<u8>,
    ) -> Result<Value> {
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
            let data = base64::engine::general_purpose::STANDARD.encode(&bytes);
            Some(json!({"type":"image","data":data,"mimeType":mime}))
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
            at: common::now(),
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
                    .ok_or_else(|| Error::new(4015, format!("{key} must be a positive integer"))),
                None => Ok(default),
            }
        };
        let first = number("first_page", 1)?;
        if first == 0 {
            return Err(Error::new(4015, "first_page must be >= 1"));
        }
        let last = number(
            "last_page",
            first
                .checked_add(24)
                .ok_or_else(|| Error::new(4015, "page range is too large"))?,
        )?;
        if last < first {
            return Err(Error::new(4015, "last_page must be >= first_page"));
        }
        if last - first >= 25 {
            return Err(Error::new(
                4019,
                "page range exceeds cap of 25 pages per attach call",
            ));
        }
        let tmp = tempfile::tempdir()?;
        let input = tmp.path().join("input.pdf");
        fs::write(&input, bytes)?;
        let config = common::read_config(&self.home)?;
        let renderer = config["attachments"]["pdf_renderer"]
            .as_str()
            .unwrap_or("pdftoppm");
        let mut command = tokio::process::Command::new(renderer);
        command
            .args([
                "-png",
                "-r",
                "150",
                "-f",
                &first.to_string(),
                "-l",
                &last.to_string(),
            ])
            .arg(&input)
            .arg(tmp.path().join("page"))
            .stdin(Stdio::null())
            .kill_on_drop(true);
        let output = tokio::time::timeout(Duration::from_secs(120), command.output())
            .await
            .map_err(|_| Error::new(5028, "pdftoppm timed out (>120s)"))?
            .map_err(|error| {
                Error::new(
                    5028,
                    if error.kind() == std::io::ErrorKind::NotFound {
                        "pdftoppm not installed (poppler-utils package required)".into()
                    } else {
                        format!("pdftoppm could not start: {error}")
                    },
                )
            })?;
        if !output.status.success() {
            return Err(Error::new(5028, "pdftoppm failed to render this PDF"));
        }
        let mut rendered = fs::read_dir(tmp.path())?
            .filter_map(|entry| entry.ok())
            .filter_map(|entry| {
                let name = entry.file_name();
                let name = name.to_str()?;
                let page = name
                    .strip_prefix("page-")?
                    .strip_suffix(".png")?
                    .parse::<u64>()
                    .ok()?;
                Some((page, entry.path()))
            })
            .collect::<Vec<_>>();
        rendered.sort_by_key(|(page, _)| *page);
        if rendered.is_empty() {
            return Err(Error::new(
                5028,
                "pdftoppm produced no pages (corrupt PDF?)",
            ));
        }
        let _attachment = s.attachment_gate.lock().await;
        ensure_open(s)?;
        let id = common::id();
        let dir = store::session_dir(&self.home, &s.stored)?.join("attachments");
        let prefix = id.clone();
        let (images, pages, mut staged) = tokio::task::spawn_blocking(move || {
            let mut images = vec![];
            let mut pages = vec![];
            let mut files = vec![];
            for (page, path) in rendered {
                let data = fs::read(path)?;
                images.push(json!({"type":"image","data":base64::engine::general_purpose::STANDARD.encode(&data),"mimeType":"image/png"}));
                let destination = dir.join(format!("{prefix}-pdf_p{page}.png"));
                pages.push(json!({"path":destination,"page":page}));
                files.push((destination, data));
            }
            Ok::<_, Error>((images, pages, write_files(files)?))
        }).await.map_err(|e| Error::new(5200, e.to_string()))??;
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
            at: common::now(),
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
/// Appends one part; returns the upload's size so far.
fn write_part(dir: &Path, upload: &str, offset: u64, bytes: &[u8]) -> Result<u64> {
    use std::io::{Seek, Write};
    fs::create_dir_all(dir)?;
    let path = dir.join(format!("{upload}.part"));
    if offset == 0 {
        prune_parts(dir, &path)?;
    }
    let mut options = fs::OpenOptions::new();
    options
        .create(offset == 0)
        .truncate(offset == 0)
        .write(true);
    // Readable only by the daemon's user, as staged files are.
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let mut file = options.open(&path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            Error::new(4204, "upload not found; send the file again from the start")
        } else {
            error.into()
        }
    })?;
    let size = file.metadata()?.len();
    if size != offset {
        return Err(Error::new(
            4202,
            format!("the upload holds {size} bytes, not {offset}; send the file again"),
        ));
    }
    if size + bytes.len() as u64 > UPLOAD_LIMIT {
        drop(file);
        let _ = fs::remove_file(&path);
        return Err(Error::new(4202, "attachment exceeds 45 MiB"));
    }
    file.seek(std::io::SeekFrom::End(0))?;
    file.write_all(bytes)?;
    Ok(size + bytes.len() as u64)
}
/// Before a new upload: drop ones idle for an hour, and the oldest past a few.
fn prune_parts(dir: &Path, starting: &Path) -> Result<()> {
    let now = std::time::SystemTime::now();
    let mut kept = vec![];
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if path == starting || path.extension().is_none_or(|ext| ext != "part") {
            continue;
        }
        let modified = entry.metadata()?.modified()?;
        if now.duration_since(modified).unwrap_or_default() > UPLOAD_IDLE {
            let _ = fs::remove_file(&path);
        } else {
            kept.push((modified, path));
        }
    }
    kept.sort();
    let extra = (kept.len() + 1).saturating_sub(UPLOADS_KEPT);
    for (_, path) in kept.into_iter().take(extra) {
        let _ = fs::remove_file(path);
    }
    Ok(())
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
fn write_files(files: Vec<(PathBuf, Vec<u8>)>) -> Result<StagedFiles> {
    let mut staged = StagedFiles(vec![]);
    let total = files.iter().map(|(_, bytes)| bytes.len() as u64).sum();
    ensure_total(files[0].0.parent().unwrap(), total)?;
    for (path, bytes) in files {
        common::atomic_write(&path, &bytes)?;
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
    if bytes > ENVELOPE_LIMIT - 2 * 1024 * 1024 {
        return Err(Error::new(
            4018,
            "staged images exceed the bot request size limit",
        ));
    }
    Ok(())
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
    use super::*;
    #[test]
    fn attachment_limits_fit_transport_with_room_for_json() {
        for method in ["file.attach", "pdf.attach", "image.attach_bytes"] {
            let bytes = attachment_limit_mib(method) * 1024 * 1024;
            assert!(4 * bytes.div_ceil(3) + 1024 * 1024 < crate::server::WS_MESSAGE_LIMIT);
        }
    }
    #[test]
    fn an_upload_in_parts_stops_at_the_attachment_limit() {
        let dir = tempfile::tempdir().unwrap();
        let most = vec![0; UPLOAD_LIMIT as usize - 1];
        assert_eq!(
            write_part(dir.path(), "big", 0, &most).unwrap(),
            UPLOAD_LIMIT - 1
        );
        assert_eq!(
            write_part(dir.path(), "big", UPLOAD_LIMIT - 1, b"xy")
                .unwrap_err()
                .code,
            4202
        );
        assert!(!dir.path().join("big.part").exists());
    }
    #[cfg(unix)]
    #[test]
    fn parts_are_readable_only_by_the_daemon_user() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        write_part(dir.path(), "secret", 0, b"x").unwrap();
        let mode = fs::metadata(dir.path().join("secret.part"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }
    #[test]
    fn a_new_upload_keeps_only_a_few_unfinished_ones() {
        let dir = tempfile::tempdir().unwrap();
        let start = std::time::SystemTime::now() - Duration::from_secs(60);
        for (age, name) in ["a", "b", "c", "d", "e"].into_iter().enumerate() {
            write_part(dir.path(), name, 0, b"x").unwrap();
            // Distinct modification times, oldest first, without waiting.
            fs::File::options()
                .write(true)
                .open(dir.path().join(format!("{name}.part")))
                .unwrap()
                .set_modified(start + Duration::from_secs(age as u64))
                .unwrap();
        }
        let mut left = fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect::<Vec<_>>();
        left.sort();
        assert_eq!(left, ["b.part", "c.part", "d.part", "e.part"]);
    }
    #[test]
    fn total_includes_files_from_prior_turns_and_rendered_pages() {
        let dir = tempfile::tempdir().unwrap();
        let file = fs::File::create(dir.path().join("old.bin")).unwrap();
        file.set_len(SESSION_LIMIT - 10).unwrap();
        assert!(ensure_total(dir.path(), 10).is_ok());
        assert_eq!(ensure_total(dir.path(), 11).unwrap_err().code, 4018);
    }
}
