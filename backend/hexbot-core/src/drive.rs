//! Files in Google Drive and OneDrive behind one shape: finding them,
//! fetching their bytes and putting bytes back. `hexbot_drive` works on any
//! file; the document, spreadsheet and presentation tools use the same
//! calls for their own kind, since a Word, Excel or PowerPoint file is a
//! file in OneDrive and a Google one is found through Drive.
use crate::{
    Error, Result,
    accounts::{self, Body, GOOGLE_API, GRAPH_API, Service, enc},
};
use reqwest::Method;
use serde_json::{Value, json};
use std::path::Path;

/// The most a file may weigh to be fetched or put.
pub(crate) const FILE_CAP: usize = 50 * 1024 * 1024;
const MAX_RESULTS: usize = 50;

pub(crate) const GOOGLE_DOC: &str = "application/vnd.google-apps.document";
pub(crate) const GOOGLE_SHEET: &str = "application/vnd.google-apps.spreadsheet";
pub(crate) const GOOGLE_SLIDES: &str = "application/vnd.google-apps.presentation";
const GOOGLE_FOLDER: &str = "application/vnd.google-apps.folder";
pub(crate) const DOCX: &str =
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
pub(crate) const XLSX: &str = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
pub(crate) const PPTX: &str =
    "application/vnd.openxmlformats-officedocument.presentationml.presentation";

/// What a search may be narrowed to.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum Kind {
    Any,
    Document,
    Spreadsheet,
    Presentation,
    Pdf,
    Image,
    Folder,
}

impl Kind {
    pub(crate) fn parse(text: Option<&str>) -> Result<Self> {
        Ok(match text.unwrap_or("").trim() {
            "" | "any" | "file" => Kind::Any,
            "document" => Kind::Document,
            "spreadsheet" => Kind::Spreadsheet,
            "presentation" => Kind::Presentation,
            "pdf" => Kind::Pdf,
            "image" => Kind::Image,
            "folder" => Kind::Folder,
            _ => {
                return Err(Error::new(
                    4202,
                    "type must be document, spreadsheet, presentation, pdf, image or folder",
                ));
            }
        })
    }
}

fn extension(name: &str) -> String {
    name.rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase())
        .unwrap_or_default()
}

/// What a file is, in a word a bot can act on, and how it is stored.
pub(crate) fn kind_of(name: &str, mime: &str) -> (&'static str, &'static str) {
    let ext = extension(name);
    match (mime, ext.as_str()) {
        (GOOGLE_FOLDER, _) => ("folder", ""),
        (GOOGLE_DOC, _) => ("document", "google"),
        (GOOGLE_SHEET, _) => ("spreadsheet", "google"),
        (GOOGLE_SLIDES, _) => ("presentation", "google"),
        (DOCX, _) | (_, "docx") => ("document", "word"),
        (XLSX, _) | (_, "xlsx") => ("spreadsheet", "excel"),
        (PPTX, _) | (_, "pptx") => ("presentation", "powerpoint"),
        ("application/pdf", _) | (_, "pdf") => ("pdf", ""),
        (mime, _) if mime.starts_with("image/") => ("image", ""),
        (mime, _) if textual(name, mime) => ("text", ""),
        _ => ("file", ""),
    }
}

/// Whether a file's bytes are text a model can read as they are.
pub(crate) fn textual(name: &str, mime: &str) -> bool {
    mime.starts_with("text/")
        || matches!(
            mime,
            "application/json"
                | "application/xml"
                | "application/x-yaml"
                | "application/javascript"
        )
        || matches!(
            extension(name).as_str(),
            "txt"
                | "md"
                | "markdown"
                | "csv"
                | "tsv"
                | "json"
                | "xml"
                | "yaml"
                | "yml"
                | "html"
                | "htm"
                | "log"
                | "ini"
                | "toml"
                | "rst"
                | "tex"
                | "srt"
                | "vtt"
                | "ics"
                | "vcf"
        )
}

/// A file as a bot is shown it.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct File {
    pub id: String,
    pub name: String,
    pub mime: String,
    pub size: u64,
    pub modified: String,
    pub link: String,
    /// The version it is at, for a change that must not undo another.
    pub etag: String,
    /// Where OneDrive hands out its bytes, without a token.
    download: String,
    pub folder: bool,
}

impl File {
    pub(crate) fn kind(&self) -> (&'static str, &'static str) {
        if self.folder {
            ("folder", "")
        } else {
            kind_of(&self.name, &self.mime)
        }
    }
    pub(crate) fn to_json(&self) -> Value {
        let (kind, format) = self.kind();
        let mut out = json!({
            "id": self.id,
            "name": self.name,
            "type": kind,
            "modified": self.modified,
            "link": self.link,
        });
        if !format.is_empty() {
            out["format"] = json!(format);
        }
        if self.size > 0 {
            out["size"] = json!(self.size);
        }
        out
    }
}

fn google_file(f: &Value) -> File {
    File {
        id: f["id"].as_str().unwrap_or("").to_owned(),
        name: f["name"].as_str().unwrap_or("").to_owned(),
        mime: f["mimeType"].as_str().unwrap_or("").to_owned(),
        // Drive gives a size as text.
        size: f["size"]
            .as_str()
            .and_then(|s| s.parse().ok())
            .or(f["size"].as_u64())
            .unwrap_or(0),
        modified: f["modifiedTime"].as_str().unwrap_or("").to_owned(),
        link: f["webViewLink"].as_str().unwrap_or("").to_owned(),
        etag: f["version"].as_str().unwrap_or("").to_owned(),
        download: String::new(),
        folder: f["mimeType"] == GOOGLE_FOLDER,
    }
}

fn graph_file(f: &Value) -> File {
    File {
        id: f["id"].as_str().unwrap_or("").to_owned(),
        name: f["name"].as_str().unwrap_or("").to_owned(),
        mime: f["file"]["mimeType"].as_str().unwrap_or("").to_owned(),
        size: f["size"].as_u64().unwrap_or(0),
        modified: f["lastModifiedDateTime"].as_str().unwrap_or("").to_owned(),
        link: f["webUrl"].as_str().unwrap_or("").to_owned(),
        etag: f["eTag"].as_str().unwrap_or("").to_owned(),
        download: f["@microsoft.graph.downloadUrl"]
            .as_str()
            .unwrap_or("")
            .to_owned(),
        folder: f["folder"].is_object(),
    }
}

fn host(svc: &Service) -> &'static str {
    if svc.google() { GOOGLE_API } else { GRAPH_API }
}

async fn call(
    home: &Path,
    svc: &Service,
    method: Method,
    path: &str,
    body: Option<&Value>,
) -> Result<Value> {
    accounts::api(home, svc, None, method, host(svc), path, body, &[], "file").await
}

pub(crate) fn id(value: &str) -> Result<String> {
    if value.is_empty() || value.len() > 1_024 || value.contains(['/', '?', '#']) {
        return Err(Error::new(4202, "id must be a file id from search"));
    }
    Ok(enc(value))
}

const GOOGLE_FIELDS: &str = "id,name,mimeType,size,modifiedTime,webViewLink,version";

/// The words of a Drive query that narrow it to one kind. The Drive
/// connector counts Office files as their kind; a Google connector's own
/// search (`native`) finds only Google's.
fn google_kind(kind: Kind, native: bool) -> Option<String> {
    let either = |google: &str, office: &str| {
        if native {
            format!("mimeType = '{google}'")
        } else {
            format!("(mimeType = '{google}' or mimeType = '{office}')")
        }
    };
    Some(match kind {
        Kind::Any => return None,
        Kind::Document => either(GOOGLE_DOC, DOCX),
        Kind::Spreadsheet => either(GOOGLE_SHEET, XLSX),
        Kind::Presentation => either(GOOGLE_SLIDES, PPTX),
        Kind::Pdf => "mimeType = 'application/pdf'".into(),
        Kind::Image => "mimeType contains 'image/'".into(),
        Kind::Folder => format!("mimeType = '{GOOGLE_FOLDER}'"),
    })
}

/// Files matching `query`, or the latest changed when it is empty. With
/// `native`, only the service's own kind: Google's documents for Google
/// Docs, .docx files for Word.
pub(crate) async fn search(
    home: &Path,
    svc: &Service,
    query: &str,
    kind: Kind,
    folder: Option<&str>,
    native: bool,
    max: usize,
) -> Result<Vec<File>> {
    let max = max.clamp(1, MAX_RESULTS);
    let query = query.trim();
    if query.chars().count() > 500 {
        return Err(Error::new(4202, "query is too long"));
    }
    if svc.google() {
        let quoted = query.replace('\\', "\\\\").replace('\'', "\\'");
        let build = |field: &str| -> Result<String> {
            let mut parts = vec!["trashed = false".to_owned()];
            parts.extend(google_kind(kind, native));
            if let Some(folder) = folder.filter(|f| !f.is_empty()) {
                id(folder)?;
                parts.push(format!("'{}' in parents", folder.replace(['\'', '\\'], "")));
            }
            if !query.is_empty() {
                parts.push(format!("{field} contains '{quoted}'"));
            }
            Ok(format!(
                "/drive/v3/files?pageSize={max}&fields=files({GOOGLE_FIELDS})&supportsAllDrives=true&includeItemsFromAllDrives=true&q={}{}",
                enc(&parts.join(" and ")),
                // Drive does not sort a search of contents.
                if query.is_empty() || field == "name" {
                    "&orderBy=modifiedTime%20desc"
                } else {
                    ""
                }
            ))
        };
        let found = match call(home, svc, Method::GET, &build("fullText")?, None).await {
            // A connector that sees names only can't search contents.
            Err(e) if e.code == 4210 && !query.is_empty() => {
                call(home, svc, Method::GET, &build("name")?, None).await?
            }
            other => other?,
        };
        return Ok(found["files"]
            .as_array()
            .into_iter()
            .flatten()
            .map(google_file)
            .collect());
    }
    // Graph's search has no filter for a kind, so more are asked for and
    // the kind is picked out here; with no words, a kind's extension is
    // what is searched for.
    let ext = match kind {
        Kind::Document => "docx",
        Kind::Spreadsheet => "xlsx",
        Kind::Presentation => "pptx",
        Kind::Pdf => "pdf",
        _ => "",
    };
    let words = if query.is_empty() && !ext.is_empty() {
        format!(".{ext}")
    } else {
        query.to_owned()
    };
    // A folder narrows both: its own files, or a search under it.
    let within = match folder.filter(|f| !f.is_empty()) {
        Some(folder) => format!("items/{}", id(folder)?),
        None => "root".to_owned(),
    };
    let listing = words.is_empty();
    let path = if listing {
        // OneDrive for work sorts a folder by name only, so it is sorted here.
        format!("/v1.0/me/drive/{within}/children?$top=200")
    } else {
        format!(
            "/v1.0/me/drive/{within}/search(q='{}')?$top=200",
            enc(&words.replace('\'', "''"))
        )
    };
    let found = call(home, svc, Method::GET, &path, None).await?;
    let mut files: Vec<File> = found["value"]
        .as_array()
        .into_iter()
        .flatten()
        .map(graph_file)
        .collect();
    if query.is_empty() {
        // With no words to rank by, the latest changed first.
        files.sort_by(|a, b| b.modified.cmp(&a.modified));
    }
    Ok(files
        .into_iter()
        .filter(|f| match kind {
            Kind::Any => true,
            Kind::Folder => f.folder,
            Kind::Image => f.mime.starts_with("image/"),
            Kind::Document => f.kind().0 == "document",
            Kind::Spreadsheet => f.kind().0 == "spreadsheet",
            Kind::Presentation => f.kind().0 == "presentation",
            Kind::Pdf => f.kind().0 == "pdf",
        })
        .take(max)
        .collect())
}

/// One file's details.
pub(crate) async fn meta(home: &Path, svc: &Service, file: &str) -> Result<File> {
    let file = id(file)?;
    if svc.google() {
        let found = call(
            home,
            svc,
            Method::GET,
            &format!("/drive/v3/files/{file}?fields={GOOGLE_FIELDS}&supportsAllDrives=true"),
            None,
        )
        .await?;
        return Ok(google_file(&found));
    }
    let found = call(
        home,
        svc,
        Method::GET,
        &format!("/v1.0/me/drive/items/{file}"),
        None,
    )
    .await?;
    Ok(graph_file(&found))
}

fn too_large(svc: &Service) -> Error {
    Error::new(
        4202,
        format!(
            "That file is over {} MB, the most Hexbot moves to or from {} at a time.",
            FILE_CAP / 1024 / 1024,
            svc.name
        ),
    )
}

/// The bytes of `file`. A Google document, sheet or presentation has none
/// of its own; `export` turns one into a file.
pub(crate) async fn fetch(home: &Path, svc: &Service, file: &File) -> Result<Vec<u8>> {
    if file.folder {
        return Err(Error::new(4202, "That is a folder, not a file."));
    }
    if file.size as usize > FILE_CAP {
        return Err(too_large(svc));
    }
    if svc.google() {
        let answer = accounts::send(
            home,
            svc,
            None,
            Method::GET,
            &accounts::url_at(
                home,
                svc,
                GOOGLE_API,
                &format!(
                    "/drive/v3/files/{}?alt=media&supportsAllDrives=true",
                    id(&file.id)?
                ),
            )?,
            Body::None,
            &[],
            FILE_CAP,
        )
        .await?;
        if answer.status >= 400 {
            return Err(accounts::refused(svc, answer.status, &answer.bytes, "file"));
        }
        return Ok(answer.bytes);
    }
    // OneDrive answers with an address that needs no token, on a host of
    // its own; the token stays with Graph.
    let trusted = accounts::trusted(home, svc, &file.download);
    if !trusted && !file.download.starts_with("https://") {
        return Err(Error::new(
            5240,
            "OneDrive gave no way to download that file.",
        ));
    }
    // A file gets five minutes, as in `accounts::send`.
    let client = crate::http::client(300, 0).map_err(|e| Error::new(5240, e.to_string()))?;
    let response = client.get(&file.download).send().await.map_err(|e| {
        crate::http::error(
            e,
            5240,
            [
                "OneDrive timed out.",
                "OneDrive could not be reached.",
                "The download from OneDrive failed.",
            ],
        )
    })?;
    if !response.status().is_success() {
        return Err(Error::new(
            5240,
            format!(
                "OneDrive answered HTTP {} for the download.",
                response.status().as_u16()
            ),
        ));
    }
    crate::http::bytes(
        response,
        FILE_CAP,
        |e| Error::new(5240, format!("The download from OneDrive stopped: {e}")),
        too_large(svc),
    )
    .await
}

/// A Google document, sheet or presentation as a file of type `mime`.
pub(crate) async fn export(home: &Path, svc: &Service, file: &str, mime: &str) -> Result<Vec<u8>> {
    let answer = accounts::send(
        home,
        svc,
        None,
        Method::GET,
        &accounts::url_at(
            home,
            svc,
            GOOGLE_API,
            &format!(
                "/drive/v3/files/{}/export?mimeType={}",
                id(file)?,
                enc(mime)
            ),
        )?,
        Body::None,
        &[],
        FILE_CAP,
    )
    .await?;
    if answer.status >= 400 {
        // Google exports at most 10 MB.
        if answer.status == 403
            && String::from_utf8_lossy(&answer.bytes).contains("exportSizeLimitExceeded")
        {
            return Err(Error::new(
                4202,
                "That file is too large for Google to export. Read a part of it instead.",
            ));
        }
        return Err(accounts::refused(svc, answer.status, &answer.bytes, "file"));
    }
    Ok(answer.bytes)
}

/// A name a file can have in both services: no path marks, no control
/// characters, 200 characters at most, never empty.
pub(crate) fn file_name(wanted: &str, fallback: &str) -> String {
    let clean: String = wanted
        .chars()
        .map(|c| {
            if c.is_control() || "\"*:<>?/\\|".contains(c) {
                ' '
            } else {
                c
            }
        })
        .collect();
    let clean = clean.split_whitespace().collect::<Vec<_>>().join(" ");
    let clean = clean.trim_matches('.').trim();
    if clean.is_empty() {
        fallback.to_owned()
    } else {
        clean.chars().take(200).collect()
    }
}

/// What a change to a file answers with when the file moved on meanwhile.
fn conflict(svc: &Service, status: u16, bytes: &[u8]) -> Error {
    match status {
        409 | 412 => Error::new(
            4209,
            "The file changed while this was being written. Read it again and repeat the change.",
        ),
        423 => Error::new(
            4209,
            "The file is open for editing somewhere, so it is locked. Close it there, or try again shortly.",
        ),
        _ => accounts::refused(svc, status, bytes, "file"),
    }
}

/// Puts `bytes` in Drive through an upload session: starts it at `start`
/// with `details`, then sends the bytes where Google says.
async fn google_upload(
    home: &Path,
    svc: &Service,
    method: Method,
    start: &str,
    details: &Value,
    bytes: &[u8],
    kind: &str,
) -> Result<File> {
    let begun = accounts::send(
        home,
        svc,
        None,
        method,
        &accounts::url_at(home, svc, GOOGLE_API, start)?,
        Body::Json(details),
        &[("X-Upload-Content-Type", kind)],
        1_000_000,
    )
    .await?;
    if begun.status >= 400 {
        return Err(conflict(svc, begun.status, &begun.bytes));
    }
    let session = begun
        .location
        .ok_or_else(|| Error::new(5240, "Google Drive did not start the upload."))?;
    let done = accounts::send(
        home,
        svc,
        None,
        Method::PUT,
        &session,
        Body::Bytes(bytes, kind),
        &[],
        1_000_000,
    )
    .await?;
    if done.status >= 400 {
        return Err(conflict(svc, done.status, &done.bytes));
    }
    Ok(google_file(
        &serde_json::from_slice(&done.bytes).unwrap_or(Value::Null),
    ))
}

/// A new file called `name` holding `bytes`, in `folder` or at the top.
/// A name already taken gets a number; nothing is overwritten. For Drive,
/// `convert` names the Google kind the bytes become (a document from
/// HTML).
pub(crate) async fn put_new(
    home: &Path,
    svc: &Service,
    name: &str,
    folder: Option<&str>,
    bytes: &[u8],
    kind: &str,
    convert: Option<&str>,
) -> Result<File> {
    if bytes.len() > FILE_CAP {
        return Err(too_large(svc));
    }
    let folder = folder.filter(|f| !f.is_empty());
    if svc.google() {
        let mut details = json!({"name": name});
        if let Some(folder) = folder {
            id(folder)?;
            details["parents"] = json!([folder]);
        }
        if let Some(convert) = convert {
            details["mimeType"] = json!(convert);
        }
        return google_upload(
            home,
            svc,
            Method::POST,
            &format!(
                "/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true&fields={GOOGLE_FIELDS}"
            ),
            &details,
            bytes,
            kind,
        )
        .await;
    }
    let parent = match folder {
        Some(folder) => format!("items/{}", id(folder)?),
        None => "root".to_owned(),
    };
    let answer = accounts::send(
        home,
        svc,
        None,
        Method::PUT,
        &accounts::url_at(
            home,
            svc,
            GRAPH_API,
            &format!(
                "/v1.0/me/drive/{parent}:/{}:/content?@microsoft.graph.conflictBehavior=rename",
                enc(name)
            ),
        )?,
        Body::Bytes(bytes, kind),
        &[],
        1_000_000,
    )
    .await?;
    if answer.status >= 400 {
        return Err(conflict(svc, answer.status, &answer.bytes));
    }
    Ok(graph_file(
        &serde_json::from_slice(&answer.bytes).unwrap_or(Value::Null),
    ))
}

/// Replaces the content of `file` with `bytes`, as long as the file is
/// still the version that was read: a change made meanwhile is not undone.
/// Drive lets Hexbot replace only the files it added.
pub(crate) async fn put_over(
    home: &Path,
    svc: &Service,
    file: &File,
    bytes: &[u8],
    kind: &str,
) -> Result<File> {
    if bytes.len() > FILE_CAP {
        return Err(too_large(svc));
    }
    if svc.google() {
        return google_upload(
            home,
            svc,
            Method::PATCH,
            &format!(
                "/upload/drive/v3/files/{}?uploadType=resumable&supportsAllDrives=true&fields={GOOGLE_FIELDS}",
                id(&file.id)?
            ),
            &json!({}),
            bytes,
            kind,
        )
        .await
        .map_err(|e| {
            if e.code == 4210 || e.code == 4215 {
                Error::new(
                    e.code,
                    "Google Drive lets Hexbot replace only the files it added. Upload this as a new file instead.",
                )
            } else {
                e
            }
        });
    }
    let headers: &[(&str, &str)] = if file.etag.is_empty() {
        &[]
    } else {
        &[("If-Match", file.etag.as_str())]
    };
    let answer = accounts::send(
        home,
        svc,
        None,
        Method::PUT,
        &accounts::url_at(
            home,
            svc,
            GRAPH_API,
            &format!("/v1.0/me/drive/items/{}/content", id(&file.id)?),
        )?,
        Body::Bytes(bytes, kind),
        headers,
        1_000_000,
    )
    .await?;
    if answer.status >= 400 {
        return Err(conflict(svc, answer.status, &answer.bytes));
    }
    Ok(graph_file(
        &serde_json::from_slice(&answer.bytes).unwrap_or(Value::Null),
    ))
}

/// The content type a file's name stands for, for an upload.
pub(crate) fn content_type(name: &str) -> &'static str {
    match extension(name).as_str() {
        "docx" => DOCX,
        "xlsx" => XLSX,
        "pptx" => PPTX,
        "pdf" => "application/pdf",
        "txt" | "log" => "text/plain",
        "md" | "markdown" => "text/markdown",
        "csv" => "text/csv",
        "json" => "application/json",
        "html" | "htm" => "text/html",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "zip" => "application/zip",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
#[path = "drive_tests.rs"]
mod tests;
