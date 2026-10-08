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
            state.attachments.clear();
            state.refs.clear();
            std::mem::take(&mut state.staged_files)
        };
        for path in paths {
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
        let path = store::session_dir(&self.home, &s.stored)?
            .join("attachments")
            .join(format!("{}-{name}", common::id()));
        let mut staged = stage_files(vec![(path.clone(), bytes)]).await?;
        let mut state = s.state.lock().unwrap();
        if state.closed {
            return Err(Error::new(4001, "session not found"));
        }
        if let Some(image) = &image {
            ensure_envelope(&state.attachments, std::slice::from_ref(image))?;
        }
        state.staged_files.append(&mut staged.0);
        if let Some(image) = image {
            state.attachments.push(image);
        } else {
            state.refs.push(path.to_string_lossy().into_owned());
        }
        state.last_activity = common::now();
        Ok(
            json!({"attached":true,"name":name,"path":path,"ref_text":format!("Attached file: {}",path.display()),"count":state.attachments.len()+state.refs.len()}),
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
        let dir = store::session_dir(&self.home, &s.stored)?.join("attachments");
        let (images, pages, mut staged) = tokio::task::spawn_blocking(move || {
            let mut images = vec![];
            let mut pages = vec![];
            let mut files = vec![];
            for (page, path) in rendered {
                let data = fs::read(path)?;
                images.push(json!({"type":"image","data":base64::engine::general_purpose::STANDARD.encode(&data),"mimeType":"image/png"}));
                let destination = dir.join(format!("{}-pdf_p{page}.png", common::id()));
                pages.push(json!({"path":destination,"page":page}));
                files.push((destination, data));
            }
            Ok::<_, Error>((images, pages, write_files(files)?))
        }).await.map_err(|e| Error::new(5200, e.to_string()))??;
        let mut state = s.state.lock().unwrap();
        if state.closed {
            return Err(Error::new(4001, "session not found"));
        }
        ensure_envelope(&state.attachments, &images)?;
        state.staged_files.append(&mut staged.0);
        state.attachments.extend(images);
        state.last_activity = common::now();
        Ok(json!({
            "attached": true,
            "filename": name,
            "pages_attached": pages.len(),
            "pages": pages,
            "count": state.attachments.len(),
            "text": format!("[User attached PDF: {name} ({} page(s))]", pages.len())
        }))
    }
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
fn ensure_envelope(existing: &[Value], additional: &[Value]) -> Result<()> {
    // Leave space for the prompt, metadata, JSON escaping, and a bounded file list.
    let bytes = existing
        .iter()
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
        return Err(Error::new(
            4018,
            "Attachments in this section exceed 512 MiB",
        ));
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
    fn total_includes_files_from_prior_turns_and_rendered_pages() {
        let dir = tempfile::tempdir().unwrap();
        let file = fs::File::create(dir.path().join("old.bin")).unwrap();
        file.set_len(SESSION_LIMIT - 10).unwrap();
        assert!(ensure_total(dir.path(), 10).is_ok());
        assert_eq!(ensure_total(dir.path(), 11).unwrap_err().code, 4018);
    }
}
