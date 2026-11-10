//! The Logs view of Settings, Advanced, Diagnostics: the files in
//! `<home>/logs`, read from the end so a large log costs one window per page.
//!
//! The daemon writes to stderr; whoever runs it keeps the file: the app in
//! `daemon.log`, the service in `service-error.log` and `service.log`. The
//! app, the tunnel and earlier versions keep their own logs beside them.

use crate::{Error, Result};
use regex::Regex;
use serde_json::{Value, json};
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::Path,
    sync::LazyLock,
    time::UNIX_EPOCH,
};

/// Lines one page returns at most.
const LINES: usize = 1000;
/// Bytes read per step from the end.
const WINDOW: u64 = 256 * 1024;
/// Bytes one page reads at most, so a search over a large file answers in
/// steps; `more` and `before` continue it.
const SCAN: u64 = 16 * 1024 * 1024;
/// Characters kept of one line.
const LINE_CHARS: usize = 16_000;

/// A line that reports a failure. The same words mark the line red.
static ERROR: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)\b(error|errors|err|failed|failure|fatal|panic|panicked|exception|traceback|crash|crashed|refused|denied|timed out|unreachable)\b",
    )
    .unwrap()
});
static WARNING: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\b(warn|warning|retry|retrying)\b").unwrap());

fn level(text: &str) -> Option<&'static str> {
    if ERROR.is_match(text) {
        Some("error")
    } else if WARNING.is_match(text) {
        Some("warning")
    } else {
        None
    }
}

/// Plain files directly in `<home>/logs`, newest change first. Symbolic
/// links and folders are left out.
fn list(home: &Path) -> Vec<Value> {
    let Ok(entries) = std::fs::read_dir(home.join("logs")) else {
        return Vec::new();
    };
    let mut files = entries
        .flatten()
        .filter_map(|entry| {
            let meta = entry.path().symlink_metadata().ok()?;
            if !meta.file_type().is_file() {
                return None;
            }
            let modified = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as f64);
            Some(json!({
                "name": entry.file_name().to_str()?,
                "size": meta.len(),
                "modified": modified,
            }))
        })
        .collect::<Vec<_>>();
    files.sort_by(|a, b| {
        let at = |v: &Value| v["modified"].as_f64().unwrap_or(0.);
        at(b)
            .total_cmp(&at(a))
            .then_with(|| a["name"].as_str().cmp(&b["name"].as_str()))
    });
    files
}

/// The file the view opens first: the one this daemon's output goes to.
fn default_file(files: &[Value], supervisor: Option<&str>) -> Option<String> {
    let has = |name: &str| files.iter().any(|f| f["name"] == name);
    let own = match supervisor {
        Some("desktop") => Some("daemon.log"),
        Some("service") => Some("service-error.log"),
        _ => None,
    };
    own.filter(|name| has(name))
        .map(str::to_owned)
        .or_else(|| files.first()?["name"].as_str().map(str::to_owned))
}

/// `hexbot.diagnostics.logs {file?, before?, query?, errors?}`.
pub fn read(home: &Path, p: &Value) -> Result<Value> {
    let files = list(home);
    let file = match p["file"].as_str().filter(|name| !name.is_empty()) {
        Some(name) => {
            // Only a name from the listing, so nothing outside the folder.
            if !files.iter().any(|f| f["name"] == name) {
                return Err(Error::new(4204, format!("no log named {name}")));
            }
            Some(name.to_owned())
        }
        None => default_file(&files, std::env::var("HEXBOT_SUPERVISOR").ok().as_deref()),
    };
    let Some(name) = file else {
        return Ok(json!({
            "files": files, "file": null, "lines": [], "size": 0, "before": 0, "more": false,
        }));
    };
    let query = p["query"]
        .as_str()
        .map(str::trim)
        .unwrap_or("")
        .to_lowercase();
    let errors = p["errors"].as_bool().unwrap_or(false);
    let before = p["before"].as_u64();
    let page = tail(&home.join("logs").join(&name), before, |text| {
        (!errors || ERROR.is_match(text))
            && (query.is_empty() || text.to_lowercase().contains(&query))
    })
    .map_err(|error| Error::new(5200, format!("could not read {name}: {error}")))?;
    Ok(json!({
        "files": files,
        "file": name,
        "lines": page.lines.iter().map(|(offset, text)| json!({
            "offset": offset, "text": text, "level": level(text),
        })).collect::<Vec<_>>(),
        "size": page.size,
        "before": page.before,
        "more": page.before > 0,
    }))
}

struct Page {
    /// `(byte offset, text)`, oldest first.
    lines: Vec<(u64, String)>,
    size: u64,
    /// Where the next older page ends: the start of the oldest line read.
    before: u64,
}

/// The last `LINES` lines that `keep` accepts, ending at `before` (or the end).
fn tail(path: &Path, before: Option<u64>, keep: impl Fn(&str) -> bool) -> std::io::Result<Page> {
    let mut file = File::open(path)?;
    let size = file.metadata()?.len();
    let end = before.unwrap_or(size).min(size);
    let mut lines = Vec::new();
    // Read up to `cursor`; `pending` holds the bytes from `cursor` to the
    // start of the oldest line taken, a line still cut by the window.
    let mut cursor = end;
    let mut next = end;
    let mut pending = Vec::new();
    let take = |offset: u64, bytes: &[u8], lines: &mut Vec<(u64, String)>| {
        let text = String::from_utf8_lossy(bytes);
        let text = text.trim_end_matches('\r');
        if !text.trim().is_empty() && keep(text) {
            lines.push((offset, clip(text)));
        }
    };
    'read: while cursor > 0 && lines.len() < LINES && end - cursor < SCAN {
        let from = cursor.saturating_sub(WINDOW);
        let mut data = vec![0; (cursor - from) as usize];
        file.seek(SeekFrom::Start(from))?;
        file.read_exact(&mut data)?;
        data.extend_from_slice(&pending);
        cursor = from;
        let mut cut = data.len();
        while let Some(newline) = data[..cut].iter().rposition(|b| *b == b'\n') {
            let offset = from + newline as u64 + 1;
            take(offset, &data[newline + 1..cut], &mut lines);
            next = offset;
            cut = newline;
            if lines.len() == LINES {
                break 'read;
            }
        }
        pending = data[..cut].to_vec();
    }
    if cursor == 0 && lines.len() < LINES {
        // The first line of the file has no newline before it.
        take(0, &pending, &mut lines);
        next = 0;
    } else if next == end && cursor < end {
        // One line longer than a whole page: skip past it.
        next = cursor;
    }
    lines.reverse();
    Ok(Page {
        lines,
        size,
        before: next,
    })
}

fn clip(text: &str) -> String {
    match text.char_indices().nth(LINE_CHARS) {
        Some((cut, _)) => format!("{}…", &text[..cut]),
        None => text.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn home_with(files: &[(&str, &str)]) -> tempfile::TempDir {
        let home = tempfile::tempdir().unwrap();
        fs::create_dir_all(home.path().join("logs/curator")).unwrap();
        for (name, text) in files {
            fs::write(home.path().join("logs").join(name), text).unwrap();
        }
        home
    }

    fn texts(page: &Value) -> Vec<&str> {
        page["lines"]
            .as_array()
            .unwrap()
            .iter()
            .map(|l| l["text"].as_str().unwrap())
            .collect()
    }

    #[test]
    fn lists_plain_files_and_reads_one_oldest_line_first() {
        let home = home_with(&[("daemon.log", "one\ntwo\r\n\nthree")]);
        let page = read(home.path(), &json!({"file": "daemon.log"})).unwrap();
        let names = page["files"].as_array().unwrap();
        assert_eq!(names.len(), 1, "folders are left out");
        assert_eq!(names[0]["name"], "daemon.log");
        assert_eq!(texts(&page), ["one", "two", "three"]);
        assert_eq!(page["lines"][0]["offset"], 0);
        assert_eq!(page["lines"][1]["offset"], 4);
        assert_eq!(page["more"], false);
    }

    #[test]
    fn refuses_a_name_outside_the_listing() {
        let home = home_with(&[("daemon.log", "one\n")]);
        fs::write(home.path().join("secret"), "no").unwrap();
        for name in ["../secret", "curator", "/etc/passwd"] {
            let error = read(home.path(), &json!({"file": name})).unwrap_err();
            assert_eq!(error.code, 4204, "{name}");
        }
    }

    #[test]
    fn an_empty_folder_reads_no_file() {
        let home = tempfile::tempdir().unwrap();
        let page = read(home.path(), &json!({})).unwrap();
        assert_eq!(page["file"], Value::Null);
        assert_eq!(page["files"], json!([]));
    }

    #[test]
    fn filters_errors_and_search_and_marks_levels() {
        let home = home_with(&[(
            "daemon.log",
            "ready\nConnect: service returned HTTP 500 error\nwarning: retrying\nOne-shot call failed for english\n",
        )]);
        let page = read(home.path(), &json!({"file": "daemon.log"})).unwrap();
        let levels = page["lines"]
            .as_array()
            .unwrap()
            .iter()
            .map(|l| l["level"].clone())
            .collect::<Vec<_>>();
        assert_eq!(
            levels,
            [
                Value::Null,
                json!("error"),
                json!("warning"),
                json!("error")
            ]
        );

        let errors = read(home.path(), &json!({"file": "daemon.log", "errors": true})).unwrap();
        assert_eq!(
            texts(&errors),
            [
                "Connect: service returned HTTP 500 error",
                "One-shot call failed for english"
            ]
        );
        let search = read(
            home.path(),
            &json!({"file": "daemon.log", "errors": true, "query": "ENGLISH"}),
        )
        .unwrap();
        assert_eq!(texts(&search), ["One-shot call failed for english"]);
    }

    #[test]
    fn pages_back_through_a_file_larger_than_one_window() {
        let text = (0..3000)
            .map(|n| format!("line {n:04} {}", "x".repeat(200)))
            .collect::<Vec<_>>()
            .join("\n");
        let home = home_with(&[("big.log", &text)]);
        let mut seen = Vec::new();
        let mut before = None;
        loop {
            let page = read(home.path(), &json!({"file": "big.log", "before": before})).unwrap();
            let mut chunk = texts(&page)
                .iter()
                .map(|t| t[5..9].parse::<usize>().unwrap())
                .collect::<Vec<_>>();
            assert!(chunk.len() <= LINES);
            chunk.extend(seen);
            seen = chunk;
            if page["more"] == false {
                break;
            }
            before = page["before"].as_u64();
        }
        assert_eq!(
            seen,
            (0..3000).collect::<Vec<_>>(),
            "every line once, in order"
        );
    }

    #[test]
    fn opens_the_daemon_output_of_its_supervisor_first() {
        let files = [
            json!({"name": "cloudflared.log"}),
            json!({"name": "daemon.log"}),
            json!({"name": "service-error.log"}),
        ];
        assert_eq!(
            default_file(&files, Some("desktop")).as_deref(),
            Some("daemon.log")
        );
        assert_eq!(
            default_file(&files, Some("service")).as_deref(),
            Some("service-error.log")
        );
        // In a terminal, or when the supervisor kept no file yet: the newest.
        assert_eq!(
            default_file(&files, None).as_deref(),
            Some("cloudflared.log")
        );
        assert_eq!(
            default_file(&files[..1], Some("desktop")).as_deref(),
            Some("cloudflared.log")
        );
        assert_eq!(default_file(&[], None), None);
    }
}
