use super::*;
use crate::accounts::testing::{Asked, Reply, connected, stand_in};

#[test]
fn a_file_is_known_by_its_kind_and_how_it_is_stored() {
    assert_eq!(kind_of("Plan", GOOGLE_DOC), ("document", "google"));
    assert_eq!(
        kind_of("Plan.DOCX", "application/octet-stream"),
        ("document", "word")
    );
    assert_eq!(kind_of("Budget", XLSX), ("spreadsheet", "excel"));
    assert_eq!(kind_of("Deck", GOOGLE_SLIDES), ("presentation", "google"));
    assert_eq!(kind_of("scan.pdf", ""), ("pdf", ""));
    assert_eq!(kind_of("photo", "image/heic"), ("image", ""));
    assert_eq!(kind_of("notes.md", ""), ("text", ""));
    assert_eq!(kind_of("data", "application/json"), ("text", ""));
    assert_eq!(kind_of("archive.zip", "application/zip"), ("file", ""));
    assert_eq!(
        file_name("  Q3: plan/draft?.docx ", "x"),
        "Q3 plan draft .docx"
    );
    assert_eq!(file_name("..", "Untitled"), "Untitled");
    assert_eq!(file_name(&"a".repeat(300), "x").chars().count(), 200);
    assert!(Kind::parse(Some("movie")).is_err());
    assert_eq!(Kind::parse(None).unwrap(), Kind::Any);
    for bad in ["", "a/b", "a?b", "a#b"] {
        assert!(id(bad).is_err(), "{bad}");
    }
    assert_eq!(id("01ABC!123").unwrap(), "01ABC%21123");
}

fn drive_file(id: &str, name: &str, mime: &str) -> Value {
    json!({"id": id, "name": name, "mimeType": mime, "size": "42", "modifiedTime": "2026-11-01T10:00:00Z", "webViewLink": format!("https://drive.example/{id}"), "version": "7"})
}

#[tokio::test]
async fn google_drive_searches_contents_and_falls_back_to_names() {
    let (origin, log) = stand_in(|asked| {
        // A connector that sees names only may not search contents.
        if asked.param("q").contains("fullText") && asked.header("authorization") == "Bearer tok" && asked.param("q").contains("document'") {
            return Reply::Json(403, json!({"error": {"message": "Insufficient scopes for fullText"}}));
        }
        Reply::Json(200, json!({"files": [drive_file("d1", "Q3 plan", GOOGLE_DOC), drive_file("x1", "Budget.xlsx", XLSX)]}))
    })
    .await;
    let home = connected(&["google_drive", "google_docs"], &origin);
    let drive = accounts::service("google_drive").unwrap();
    let found = search(
        home.path(),
        drive,
        "it's \\ here",
        Kind::Spreadsheet,
        Some("folder1"),
        false,
        20,
    )
    .await
    .unwrap();
    assert_eq!(
        found[1].to_json(),
        json!({"id": "x1", "name": "Budget.xlsx", "type": "spreadsheet", "format": "excel", "modified": "2026-11-01T10:00:00Z", "link": "https://drive.example/x1", "size": 42})
    );
    let asked = log.lock().unwrap().last().unwrap().clone();
    assert!(asked.is("GET", "/drive/v3/files"));
    assert_eq!(
        asked.param("q"),
        format!(
            "trashed = false and (mimeType = '{GOOGLE_SHEET}' or mimeType = '{XLSX}') and 'folder1' in parents and fullText contains 'it\\'s \\\\ here'"
        )
    );
    assert_eq!(asked.param("orderBy"), "");
    assert_eq!(asked.param("pageSize"), "20");
    // With no words: the latest changed.
    search(home.path(), drive, " ", Kind::Any, None, false, 99)
        .await
        .unwrap();
    let asked = log.lock().unwrap().last().unwrap().clone();
    assert_eq!(
        (
            asked.param("q"),
            asked.param("orderBy"),
            asked.param("pageSize")
        ),
        (
            "trashed = false".into(),
            "modifiedTime desc".into(),
            "50".into()
        )
    );

    // Google Docs finds its own kind only, by name when contents are closed to it.
    let docs = accounts::service("google_docs").unwrap();
    search(home.path(), docs, "plan", Kind::Document, None, true, 20)
        .await
        .unwrap();
    let asked = log.lock().unwrap().clone();
    let (first, second) = (&asked[asked.len() - 2], &asked[asked.len() - 1]);
    assert_eq!(
        first.param("q"),
        format!("trashed = false and mimeType = '{GOOGLE_DOC}' and fullText contains 'plan'")
    );
    assert_eq!(
        second.param("q"),
        format!("trashed = false and mimeType = '{GOOGLE_DOC}' and name contains 'plan'")
    );
    assert_eq!(second.param("orderBy"), "modifiedTime desc");
    assert_eq!(
        search(
            home.path(),
            drive,
            &"x".repeat(501),
            Kind::Any,
            None,
            false,
            5
        )
        .await
        .unwrap_err()
        .code,
        4202
    );
}

fn graph_item(id: &str, name: &str, asked: &Asked) -> Value {
    json!({"id": id, "name": name, "size": 9, "eTag": "\"v7\"", "lastModifiedDateTime": "2026-11-01T10:00:00Z", "webUrl": format!("https://onedrive.example/{id}"),
           "file": {"mimeType": "application/octet-stream"}, "@microsoft.graph.downloadUrl": format!("{}/download/{id}", asked.origin)})
}

#[tokio::test]
async fn onedrive_finds_by_kind_and_hands_out_bytes_without_the_token() {
    let (origin, log) = stand_in(|asked| match asked.path.as_str() {
        path if path.starts_with("/download/") => Reply::Bytes(b"file bytes".to_vec()),
        "/v1.0/me/drive/items/w1" => Reply::Json(200, graph_item("w1", "Report.docx", asked)),
        "/v1.0/me/drive/items/missing" => {
            Reply::Json(404, json!({"error": {"message": "itemNotFound"}}))
        }
        _ => Reply::Json(
            200,
            json!({"value": [
                graph_item("w1", "Report.docx", asked), graph_item("x1", "Budget.xlsx", asked),
                {"id": "f1", "name": "Reports", "folder": {"childCount": 2}},
            ]}),
        ),
    })
    .await;
    let home = connected(&["onedrive", "word"], &origin);
    let svc = accounts::service("onedrive").unwrap();
    let found = search(
        home.path(),
        svc,
        "o'brien report",
        Kind::Any,
        None,
        false,
        20,
    )
    .await
    .unwrap();
    assert_eq!(found.len(), 3);
    assert_eq!(found[2].kind(), ("folder", ""));
    let asked = log.lock().unwrap().last().unwrap().clone();
    // A quote in the words is doubled, as OData reads it, then encoded.
    assert_eq!(
        asked.path,
        "/v1.0/me/drive/root/search(q='o%27%27brien%20report')"
    );
    // Word lists its own kind: with no words, files with its extension.
    let word = accounts::service("word").unwrap();
    let found = search(home.path(), word, "", Kind::Document, None, true, 20)
        .await
        .unwrap();
    assert_eq!(
        found.iter().map(|f| f.name.as_str()).collect::<Vec<_>>(),
        ["Report.docx"]
    );
    assert_eq!(
        log.lock().unwrap().last().unwrap().path,
        "/v1.0/me/drive/root/search(q='.docx')"
    );
    // A folder's contents, and a search that stays under it. OneDrive for
    // work sorts a folder by name only, so no order is asked for.
    search(home.path(), svc, "", Kind::Any, Some("f1"), false, 20)
        .await
        .unwrap();
    let asked = log.lock().unwrap().last().unwrap().clone();
    assert_eq!(asked.path, "/v1.0/me/drive/items/f1/children");
    assert_eq!(asked.param("$orderby"), "");
    search(
        home.path(),
        svc,
        "report",
        Kind::Document,
        Some("f1"),
        false,
        20,
    )
    .await
    .unwrap();
    assert_eq!(
        log.lock().unwrap().last().unwrap().path,
        "/v1.0/me/drive/items/f1/search(q='report')"
    );

    let file = meta(home.path(), svc, "w1").await.unwrap();
    assert_eq!(
        (file.kind(), file.etag.as_str()),
        (("document", "word"), "\"v7\"")
    );
    assert_eq!(fetch(home.path(), svc, &file).await.unwrap(), b"file bytes");
    // The token went to Graph and not to the address the bytes came from.
    let asked = log.lock().unwrap().clone();
    assert_eq!(asked[asked.len() - 2].header("authorization"), "Bearer tok");
    assert_eq!(asked.last().unwrap().header("authorization"), "");
    assert_eq!(
        meta(home.path(), svc, "missing").await.unwrap_err().code,
        4215
    );
    assert_eq!(
        fetch(home.path(), svc, &found_folder())
            .await
            .unwrap_err()
            .code,
        4202
    );
}

fn found_folder() -> File {
    graph_file(&json!({"id": "f1", "name": "Reports", "folder": {}}))
}

#[tokio::test]
async fn a_new_file_never_writes_over_another_and_a_new_version_needs_the_one_read() {
    let (origin, log) = stand_in(|asked| match (asked.method.as_str(), asked.path.as_str()) {
        ("PUT", "/v1.0/me/drive/items/stale/content") => {
            Reply::Json(412, json!({"error": {"message": "eTag mismatch"}}))
        }
        ("PUT", "/v1.0/me/drive/items/open/content") => {
            Reply::Json(423, json!({"error": {"message": "locked"}}))
        }
        ("PUT", path) if path.starts_with("/v1.0/me/drive/") => Reply::Json(
            201,
            json!({"id": "new", "name": "Q3 plan 1.docx", "file": {}, "eTag": "\"v1\""}),
        ),
        // Drive: a session is started, then the bytes go where it says.
        ("POST" | "PATCH", path) if path.starts_with("/upload/drive/v3/files") => {
            if path.ends_with("/theirs") {
                return Reply::Json(
                    403,
                    json!({"error": {"message": "The user has not granted the app write access"}}),
                );
            }
            Reply::Location(format!("{}/session/1", asked.origin))
        }
        ("PUT", "/session/1") => Reply::Json(200, drive_file("g-new", "notes.md", "text/markdown")),
        _ => Reply::Json(500, Value::Null),
    })
    .await;
    let home = connected(&["onedrive", "google_drive"], &origin);
    let h = home.path();
    let onedrive = accounts::service("onedrive").unwrap();
    let made = put_new(
        h,
        onedrive,
        "Q3 plan.docx",
        Some("folder1"),
        b"bytes",
        DOCX,
        None,
    )
    .await
    .unwrap();
    assert_eq!(made.name, "Q3 plan 1.docx");
    let sent = log.lock().unwrap().last().unwrap().clone();
    assert!(sent.is(
        "PUT",
        "/v1.0/me/drive/items/folder1:/Q3%20plan.docx:/content"
    ));
    assert_eq!(sent.param("@microsoft.graph.conflictBehavior"), "rename");
    assert_eq!(
        (sent.header("content-type"), sent.body.as_slice()),
        (DOCX, b"bytes".as_slice())
    );
    put_new(h, onedrive, "a.txt", None, b"x", "text/plain", None)
        .await
        .unwrap();
    assert_eq!(
        log.lock().unwrap().last().unwrap().path,
        "/v1.0/me/drive/root:/a.txt:/content"
    );

    // A new version goes over the version that was read, or not at all.
    let file = |id: &str| {
        graph_file(&json!({"id": id, "name": "Report.docx", "eTag": "\"v7\"", "file": {}}))
    };
    put_over(h, onedrive, &file("w1"), b"new", DOCX)
        .await
        .unwrap();
    assert_eq!(
        log.lock().unwrap().last().unwrap().header("if-match"),
        "\"v7\""
    );
    let stale = put_over(h, onedrive, &file("stale"), b"new", DOCX)
        .await
        .unwrap_err();
    assert_eq!(stale.code, 4209);
    assert!(stale.message.contains("changed while"), "{}", stale.message);
    let locked = put_over(h, onedrive, &file("open"), b"new", DOCX)
        .await
        .unwrap_err();
    assert!(locked.message.contains("locked"), "{}", locked.message);

    let drive = accounts::service("google_drive").unwrap();
    let made = put_new(
        h,
        drive,
        "notes.md",
        None,
        b"# Hi",
        "text/markdown",
        Some(GOOGLE_DOC),
    )
    .await
    .unwrap();
    assert_eq!(made.id, "g-new");
    let asked = log.lock().unwrap().clone();
    let (start, bytes) = (&asked[asked.len() - 2], &asked[asked.len() - 1]);
    assert!(start.is("POST", "/upload/drive/v3/files"));
    assert_eq!(start.param("uploadType"), "resumable");
    assert_eq!(
        start.json(),
        json!({"name": "notes.md", "mimeType": GOOGLE_DOC})
    );
    assert_eq!(start.header("x-upload-content-type"), "text/markdown");
    assert_eq!(
        (bytes.path.as_str(), bytes.body.as_slice()),
        ("/session/1", b"# Hi".as_slice())
    );
    // Drive lets Hexbot replace only what it added, and says so plainly.
    let theirs = google_file(&drive_file("theirs", "Theirs.pdf", "application/pdf"));
    let refused = put_over(h, drive, &theirs, b"x", "application/pdf")
        .await
        .unwrap_err();
    assert!(
        refused.message.contains("only the files it added"),
        "{}",
        refused.message
    );
    assert_eq!(
        put_new(h, drive, "big", None, &vec![0; FILE_CAP + 1], "x/y", None)
            .await
            .unwrap_err()
            .code,
        4202
    );
}

#[tokio::test]
async fn a_google_file_is_exported_and_a_session_elsewhere_is_not_followed() {
    let (origin, log) = stand_in(|asked| match asked.path.as_str() {
        "/drive/v3/files/d1/export" => Reply::Bytes(b"docx bytes".to_vec()),
        "/drive/v3/files/huge/export" => Reply::Json(
            403,
            json!({"error": {"message": "exportSizeLimitExceeded"}}),
        ),
        "/drive/v3/files/raw" => Reply::Bytes(b"raw bytes".to_vec()),
        _ => Reply::Location("https://evil.example/session".into()),
    })
    .await;
    let home = connected(&["google_drive"], &origin);
    let svc = accounts::service("google_drive").unwrap();
    assert_eq!(
        export(home.path(), svc, "d1", DOCX).await.unwrap(),
        b"docx bytes"
    );
    assert_eq!(log.lock().unwrap().last().unwrap().param("mimeType"), DOCX);
    assert!(
        export(home.path(), svc, "huge", DOCX)
            .await
            .unwrap_err()
            .message
            .contains("too large for Google to export")
    );
    let file = google_file(&drive_file("raw", "notes.txt", "text/plain"));
    assert_eq!(fetch(home.path(), svc, &file).await.unwrap(), b"raw bytes");
    assert_eq!(log.lock().unwrap().last().unwrap().param("alt"), "media");
    // An upload session pointing off Google's hosts gets no token and no bytes.
    let before = log.lock().unwrap().len();
    let refused = put_new(
        home.path(),
        svc,
        "a.txt",
        None,
        b"secret",
        "text/plain",
        None,
    )
    .await
    .unwrap_err();
    assert!(
        refused.message.contains("won't follow"),
        "{}",
        refused.message
    );
    assert_eq!(log.lock().unwrap().len(), before + 1);
}
