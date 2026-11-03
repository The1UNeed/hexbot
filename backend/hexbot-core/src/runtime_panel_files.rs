//! Files a chat's side panel opens: what the user attached and what the bot
//! wrote. The panel reads them, and saves the user's edits to text files, only
//! inside the folders the bot itself may write: the chat's working folder, the
//! bot's `artifacts` folder and the chat's `attachments` folder.
use super::*;

/// Text the panel edits; the bot's own edit tool handles larger files.
const TEXT_LIMIT: usize = 2 * 1024 * 1024;
/// Anything shown read-only, as a data URL, matching the attachment limit.
const READ_LIMIT: u64 = 45 * 1024 * 1024;
use super::pi_files::{SAVES, version_of};

impl Runtime {
    pub(super) async fn read_file(&self, s: &Live, p: &Value) -> Result<Value> {
        let path = self.file_path(s, required(p, "path")?)?;
        tokio::task::spawn_blocking(move || read_payload(&path))
            .await
            .map_err(|e| Error::new(5200, e.to_string()))?
    }

    pub(super) async fn write_file(&self, s: &Live, p: &Value) -> Result<Value> {
        let path = self.file_path(s, required(p, "path")?)?;
        let text = p["text"]
            .as_str()
            .ok_or_else(|| Error::new(4200, "missing parameter: text"))?
            .to_owned();
        let expected = p["version"].as_str().map(str::to_owned);
        tokio::task::spawn_blocking(move || write_text(&path, &text, expected.as_deref()))
            .await
            .map_err(|e| Error::new(5200, e.to_string()))?
    }

    fn file_path(&self, s: &Live, value: &str) -> Result<PathBuf> {
        let roots = [
            crate::native_tools::section_workdir(&self.home, &s.bot, &s.stored)?,
            crate::catalog::profile(&self.home, &s.bot)?.join("artifacts"),
            store::session_dir(&self.home, &s.stored)?.join("attachments"),
        ];
        resolve_in(&roots, value, crate::osutil::user_home().as_deref())
    }
}

/// `~`, `$HOME` or `${HOME}` at the start is the user's home, as the bot's file
/// tools read it, so a path the bot wrote with one opens here too.
fn expand_home(value: &str, home: Option<&Path>) -> PathBuf {
    let rest = ["${HOME}", "$HOME", "~"].iter().find_map(|prefix| {
        value
            .strip_prefix(prefix)
            .filter(|rest| rest.is_empty() || rest.starts_with('/'))
    });
    match (rest, home) {
        (Some(rest), Some(home)) => home.join(rest.trim_start_matches('/')),
        _ => PathBuf::from(value),
    }
}

/// The existing regular file `value` names, once symlinks are resolved, if it
/// is inside one of `roots`. A relative path is taken from the first root.
pub(super) fn resolve_in(roots: &[PathBuf], value: &str, home: Option<&Path>) -> Result<PathBuf> {
    let input = expand_home(value, home);
    let input = if input.is_absolute() {
        input
    } else {
        roots
            .first()
            .ok_or_else(|| Error::new(4302, "no folder to open files from"))?
            .join(input)
    };
    let path = fs::canonicalize(&input).map_err(|_| Error::new(4204, "file not found"))?;
    let inside = roots
        .iter()
        .filter_map(|root| fs::canonicalize(root).ok())
        .any(|root| path.starts_with(root));
    if !inside {
        return Err(Error::new(
            4302,
            "only files in the bot's working folder, its artifacts or this chat's attachments open here",
        ));
    }
    if !fs::metadata(&path)?.is_file() {
        return Err(Error::new(4202, "not a file"));
    }
    Ok(path)
}

fn modified_ms(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |since| since.as_millis() as u64)
}

/// A format that is bytes however they decode: a PDF can be all ASCII, and
/// editing it as text would break it.
fn binary_format(path: &Path) -> bool {
    let mime = mime_of(path);
    mime == "application/pdf"
        || mime.contains("officedocument")
        || (mime.starts_with("image/") && mime != "image/svg+xml")
}

fn mime_of(path: &Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "md" | "markdown" => "text/markdown",
        "txt" | "log" => "text/plain",
        "csv" => "text/csv",
        "json" => "application/json",
        "html" | "htm" => "text/html",
        "pdf" => "application/pdf",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        _ => "application/octet-stream",
    }
}

/// Text when the file is UTF-8 without NUL bytes and small enough to edit,
/// otherwise its bytes as a data URL.
pub(super) fn read_payload(path: &Path) -> Result<Value> {
    let meta = fs::metadata(path)?;
    if meta.len() > READ_LIMIT {
        return Err(Error::new(
            4202,
            format!("file exceeds {} MiB", READ_LIMIT / 1024 / 1024),
        ));
    }
    let bytes = fs::read(path)?;
    let mut result = json!({
        "path": path,
        "name": path.file_name().and_then(|n| n.to_str()).unwrap_or(""),
        "size": meta.len(),
        "modified": modified_ms(&meta),
        "version": version_of(&bytes),
        "mime": mime_of(path),
    });
    match std::str::from_utf8(&bytes) {
        Ok(text) if bytes.len() <= TEXT_LIMIT && !text.contains('\0') && !binary_format(path) => {
            result["text"] = json!(text);
        }
        _ => {
            result["data_url"] = json!(format!(
                "data:{};base64,{}",
                mime_of(path),
                base64::engine::general_purpose::STANDARD.encode(&bytes)
            ));
        }
    }
    Ok(result)
}

/// Swaps in the new bytes through a directory handle that refuses symlinks,
/// so a folder replaced by a link after the check cannot redirect the save.
#[cfg(unix)]
fn replace(path: &Path, bytes: &[u8], meta: &fs::Metadata) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    super::files::FileAccess::open(path, false)?
        .write_keeping_mode(bytes, (meta.permissions().mode() & 0o777) as libc::mode_t)
}

#[cfg(not(unix))]
fn replace(path: &Path, bytes: &[u8], meta: &fs::Metadata) -> Result<()> {
    use std::io::Write;
    let dir = path
        .parent()
        .ok_or_else(|| Error::new(4202, "invalid file path"))?;
    let mut temp = tempfile::NamedTempFile::new_in(dir)?;
    temp.write_all(bytes)?;
    temp.as_file().set_permissions(meta.permissions())?;
    temp.persist(path).map_err(|e| Error::from(e.error))?;
    Ok(())
}

/// Replaces a text file's contents in one step. `expected` is the version the
/// editor last read; a different one means the bot changed the file since, and
/// the save is refused rather than overwriting that change.
pub(super) fn write_text(path: &Path, text: &str, expected: Option<&str>) -> Result<Value> {
    let _save = SAVES
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if text.len() > TEXT_LIMIT {
        return Err(Error::new(
            4202,
            format!("text exceeds {} MiB", TEXT_LIMIT / 1024 / 1024),
        ));
    }
    let meta = fs::metadata(path)?;
    let current = fs::read(path)?;
    if let Some(expected) = expected
        && version_of(&current) != expected
    {
        return Err(Error::new(4209, "the file changed since it was opened"));
    }
    if binary_format(path) || std::str::from_utf8(&current).is_err() || current.contains(&0) {
        return Err(Error::new(4202, "only text files can be edited here"));
    }
    replace(path, text.as_bytes(), &meta)?;
    let meta = fs::metadata(path)?;
    Ok(json!({
        "path": path,
        "size": meta.len(),
        "modified": modified_ms(&meta),
        "version": version_of(text.as_bytes()),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roots(dir: &Path) -> Vec<PathBuf> {
        let work = dir.join("work");
        let attachments = dir.join("attachments");
        fs::create_dir_all(&work).unwrap();
        fs::create_dir_all(&attachments).unwrap();
        vec![work, attachments]
    }

    #[test]
    fn opens_files_only_inside_the_bots_folders() {
        let dir = tempfile::tempdir().unwrap();
        let roots = roots(dir.path());
        fs::write(roots[0].join("plan.md"), "# Plan").unwrap();
        fs::write(roots[1].join("abc-pins.csv"), "pin,use").unwrap();
        fs::write(dir.path().join("secret.txt"), "no").unwrap();

        assert!(
            resolve_in(&roots, "plan.md", None)
                .unwrap()
                .ends_with("work/plan.md")
        );
        let attached = roots[1].join("abc-pins.csv");
        assert!(resolve_in(&roots, attached.to_str().unwrap(), None).is_ok());
        assert_eq!(
            resolve_in(&roots, "../secret.txt", None).unwrap_err().code,
            4302
        );
        let outside = dir.path().join("secret.txt");
        assert_eq!(
            resolve_in(&roots, outside.to_str().unwrap(), None)
                .unwrap_err()
                .code,
            4302
        );
        assert_eq!(
            resolve_in(&roots, "missing.md", None).unwrap_err().code,
            4204
        );
        assert_eq!(resolve_in(&roots, ".", None).unwrap_err().code, 4202);
    }

    #[test]
    fn a_home_path_opens_as_the_bot_wrote_it() {
        let dir = tempfile::tempdir().unwrap();
        let roots = roots(dir.path());
        fs::write(roots[0].join("plan.md"), "# Plan").unwrap();
        fs::write(dir.path().join("secret.txt"), "no").unwrap();
        let home = Some(dir.path());

        for value in [
            "~/work/plan.md",
            "$HOME/work/plan.md",
            "${HOME}/work/plan.md",
        ] {
            assert!(
                resolve_in(&roots, value, home)
                    .unwrap()
                    .ends_with("work/plan.md"),
                "{value}"
            );
        }
        assert_eq!(
            resolve_in(&roots, "~/secret.txt", home).unwrap_err().code,
            4302
        );
        // Only the whole word: "$HOMEWORK" is a name in the working folder.
        assert_eq!(
            resolve_in(&roots, "$HOMEWORK/plan.md", home)
                .unwrap_err()
                .code,
            4204
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_link_out_of_the_folders_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let roots = roots(dir.path());
        fs::write(dir.path().join("secret.txt"), "no").unwrap();
        std::os::unix::fs::symlink(dir.path().join("secret.txt"), roots[0].join("link.txt"))
            .unwrap();

        assert_eq!(resolve_in(&roots, "link.txt", None).unwrap_err().code, 4302);
    }

    #[test]
    fn text_comes_back_as_text_and_the_rest_as_a_data_url() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("plan.md"), "# Plan\n").unwrap();
        fs::write(dir.path().join("doc.pdf"), b"%PDF-1.4\0binary").unwrap();

        let text = read_payload(&dir.path().join("plan.md")).unwrap();
        assert_eq!(text["text"], "# Plan\n");
        assert_eq!(text["mime"], "text/markdown");
        assert!(text["modified"].as_u64().unwrap() > 0);

        let pdf = read_payload(&dir.path().join("doc.pdf")).unwrap();
        assert!(pdf["text"].is_null());
        assert!(
            pdf["data_url"]
                .as_str()
                .unwrap()
                .starts_with("data:application/pdf;base64,")
        );
    }

    #[test]
    fn a_save_replaces_the_text_and_refuses_after_the_bot_changed_it() {
        let dir = tempfile::tempdir().unwrap();
        // Saves take the resolved path `resolve_in` returns, never one through a link.
        let path = fs::canonicalize(dir.path()).unwrap().join("plan.md");
        fs::write(&path, "first").unwrap();
        let opened = read_payload(&path).unwrap()["version"]
            .as_str()
            .unwrap()
            .to_owned();

        let saved = write_text(&path, "second", Some(&opened)).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "second");
        assert_eq!(saved["size"], 6);
        let stale = saved["version"].as_str().unwrap().to_owned();
        assert_eq!(read_payload(&path).unwrap()["version"], stale.as_str());

        // The bot replaces the file within the same modification time the editor
        // read: the version still differs, so the stale editor may not overwrite it.
        let time = fs::metadata(&path).unwrap().modified().unwrap();
        fs::write(&path, "the bot's version").unwrap();
        fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(time)
            .unwrap();
        assert_eq!(
            write_text(&path, "third", Some(&stale)).unwrap_err().code,
            4209
        );
        assert_eq!(fs::read_to_string(&path).unwrap(), "the bot's version");
        assert!(write_text(&path, "third", None).is_ok());
    }

    #[test]
    fn two_saves_from_the_same_version_cannot_both_land() {
        let dir = tempfile::tempdir().unwrap();
        let path = fs::canonicalize(dir.path()).unwrap().join("plan.md");
        fs::write(&path, "first").unwrap();
        let opened = read_payload(&path).unwrap()["version"]
            .as_str()
            .unwrap()
            .to_owned();

        let start = std::sync::Arc::new(std::sync::Barrier::new(2));
        let saves = ["from the app", "from the phone"].map(|text| {
            let (path, start, opened) = (path.clone(), start.clone(), opened.clone());
            std::thread::spawn(move || {
                start.wait();
                write_text(&path, text, Some(&opened)).map_err(|error| error.code)
            })
        });
        let mut results = saves.map(|save| save.join().unwrap()).to_vec();
        results.sort_by_key(|result| result.is_err());

        assert!(results[0].is_ok());
        assert_eq!(results[1], Err(4209));
    }

    #[test]
    fn an_ascii_pdf_is_still_a_pdf() {
        let dir = tempfile::tempdir().unwrap();
        let path = fs::canonicalize(dir.path()).unwrap().join("board.pdf");
        fs::write(
            &path,
            "%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n",
        )
        .unwrap();

        let read = read_payload(&path).unwrap();
        assert!(read["text"].is_null());
        assert!(
            read["data_url"]
                .as_str()
                .unwrap()
                .starts_with("data:application/pdf;base64,")
        );
        assert_eq!(write_text(&path, "oops", None).unwrap_err().code, 4202);
        assert!(fs::read_to_string(&path).unwrap().starts_with("%PDF-1.4"));
    }

    #[test]
    fn binary_files_are_not_edited_as_text() {
        let dir = tempfile::tempdir().unwrap();
        let path = fs::canonicalize(dir.path()).unwrap().join("doc.pdf");
        fs::write(&path, b"%PDF\0").unwrap();
        assert_eq!(write_text(&path, "text", None).unwrap_err().code, 4202);
        assert_eq!(fs::read(&path).unwrap(), b"%PDF\0");
    }
}
