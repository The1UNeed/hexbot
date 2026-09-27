use super::*;
use std::process::Stdio;

const ENVELOPE_LIMIT: usize = 768 * 1024 * 1024;
impl Runtime {
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
        let limit_mib: usize = match method {
            "image.attach_bytes" => 25,
            "pdf.attach" => 50,
            _ => 256,
        };
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
        let path = store::session_dir(&self.home, &s.stored)?
            .join("attachments")
            .join(format!("{}-{name}", common::id()));
        let mut state = s.state.lock().unwrap();
        if state.closed {
            return Err(Error::new(4001, "session not found"));
        }
        if let Some(image) = &image {
            ensure_envelope(&state.attachments, std::slice::from_ref(image))?;
        }
        common::atomic_write(&path, &bytes)?;
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
        let mut images = vec![];
        for (_, path) in &rendered {
            let data = fs::read(path)?;
            images.push(json!({"type":"image","data":base64::engine::general_purpose::STANDARD.encode(data),"mimeType":"image/png"}));
        }
        let mut state = s.state.lock().unwrap();
        if state.closed {
            return Err(Error::new(4001, "session not found"));
        }
        ensure_envelope(&state.attachments, &images)?;
        let dir = store::session_dir(&self.home, &s.stored)?.join("attachments");
        fs::create_dir_all(&dir)?;
        let mut pages = vec![];
        for (page, path) in &rendered {
            let destination = dir.join(format!("{}-pdf_p{page}.png", common::id()));
            fs::copy(path, &destination)?;
            pages.push(json!({"path":destination,"page":page}));
        }
        state.attachments.extend(images);
        state.last_activity = common::now();
        Ok(
            json!({"attached":true,"filename":name,"pages_attached":pages.len(),"pages":pages,"count":state.attachments.len(),"text":format!("[User attached PDF: {name} ({} page(s))]",rendered.len())}),
        )
    }
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
            "staged images exceed the Pi request size limit",
        ));
    }
    Ok(())
}
