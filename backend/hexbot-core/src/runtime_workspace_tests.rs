use super::*;
use crate::accounts::testing::{Reply, stand_in};

/// The extension gates every action of these tools that it does not know
/// as a read, so its list and the daemon's must be the same.
#[test]
fn the_extension_and_the_daemon_agree_on_what_only_reads() {
    let source = include_str!("../../pi-runtime/extension.ts");
    let start = source.find("export const ACCOUNT_READS").unwrap();
    let block = &source[start..start + source[start..].find("};").unwrap()];
    let mut seen = vec![];
    for line in block
        .lines()
        .filter(|l| l.trim_start().starts_with("hexbot_"))
    {
        let (name, reads) = line.trim().split_once(':').unwrap();
        let reads = reads
            .trim()
            .trim_start_matches('[')
            .trim_end_matches(',')
            .trim_end_matches(']')
            .split(',')
            .map(|r| r.trim().trim_matches('\''))
            .collect::<Vec<_>>();
        let tool = workspace_tool::tool(name).unwrap_or_else(|| panic!("{name} is not a tool"));
        assert_eq!(reads, tool.reads, "{name}");
        seen.push(name);
    }
    assert_eq!(seen.len(), workspace_tool::TOOLS.len());
}

/// Each tool's connectors are the catalog's, and every action its schema
/// offers is one it runs.
#[test]
fn every_tool_matches_the_catalog_and_its_own_schema() {
    let catalog = crate::connectors::catalog();
    for tool in workspace_tool::TOOLS {
        for (account, id) in tool.connectors {
            let entry = catalog.iter().find(|c| c["id"] == *id).unwrap();
            assert_eq!(entry["tools"], json!([tool.name]), "{id}");
            assert_eq!(entry["account"], *account);
        }
    }
    // Reads are actions the schema offers, and the schema names the tool.
    for tool in workspace_tool::TOOLS {
        let descriptor = workspace_tool::descriptor(tool.name);
        assert_eq!(descriptor["name"], tool.name);
        let actions = descriptor["parameters"]["properties"]["action"]["enum"]
            .as_array()
            .unwrap()
            .clone();
        for read in tool.reads {
            assert!(actions.iter().any(|a| a == read), "{} {read}", tool.name);
        }
        assert!(
            actions.len() > tool.reads.len(),
            "{} has no change",
            tool.name
        );
        assert!(
            descriptor["description"]
                .as_str()
                .unwrap()
                .contains("treat")
                || tool.name == "hexbot_tasks"
        );
    }
}

/// A home whose bot has `toolsets` on, with each connected and every
/// Google and Microsoft request going to `origin`.
fn connect(h: &Path, origin: &str, toolsets: &[&str]) {
    let mut config = fs::read_to_string(h.join("config.yaml")).unwrap_or_default();
    config.push_str(&format!(
        "\naccounts:\n  google:\n    endpoint: {origin}\n  microsoft:\n    endpoint: {origin}\n"
    ));
    fs::write(h.join("config.yaml"), config).unwrap();
    fs::create_dir_all(h.join("accounts")).unwrap();
    for id in toolsets {
        fs::write(
            h.join(format!("accounts/{id}.json")),
            json!({"email":"alice@example.com","client_id":"c","access_token":"tok","refresh_token":"r","expires_at":common::now() + 3600.0}).to_string(),
        )
        .unwrap();
    }
    fs::write(
        h.join("profiles/owl/config.yaml"),
        format!(
            "model:\n  provider: openai\n  default: fixture\ntools:\n  enabled_toolsets: [{}]\n",
            toolsets.join(", ")
        ),
    )
    .unwrap();
}

#[tokio::test]
async fn a_bot_has_the_tools_of_the_connectors_it_was_given_and_no_others() {
    let (home, runtime, _hub) = setup();
    let h = home.path();
    let (origin, _) = stand_in(|asked| match asked.path.as_str() {
        "/tasks/v1/users/@me/lists" => Reply::Json(
            200,
            json!({"items": [{"id": "inbox", "title": "My Tasks"}]}),
        ),
        "/tasks/v1/lists/inbox/tasks" => Reply::Json(
            200,
            json!({"items": [{"id": "t1", "title": "File taxes", "status": "needsAction"}]}),
        ),
        _ => Reply::Json(404, json!({"error": {"message": "Not Found"}})),
    })
    .await;
    // Tasks is on and connected; Calendar is connected but not given to
    // this bot; Drive is given but not connected.
    connect(h, &origin, &["google_tasks", "google_calendar"]);
    fs::write(
        h.join("profiles/owl/config.yaml"),
        "model:\n  provider: openai\n  default: fixture\ntools:\n  enabled_toolsets: [google_tasks, google_drive]\n",
    )
    .unwrap();
    open(&runtime).await;
    let s = runtime.sessions.lock().unwrap()["first"].clone();
    let names = s
        .tools
        .iter()
        .filter_map(|t| t["name"].as_str())
        .filter(|n| workspace_tool::tool(n).is_some())
        .collect::<Vec<_>>();
    assert_eq!(names, ["hexbot_tasks"]);

    let found = runtime
        .tool(&s, "hexbot_tasks", &json!({"action": "list"}))
        .await
        .unwrap();
    assert_eq!(found["tasks"][0]["title"], "File taxes");
    assert_eq!(found["account"], "google");
    // A tool the section was not given is refused, whatever is connected.
    let refused = runtime
        .tool(&s, "hexbot_calendar", &json!({"action": "list"}))
        .await
        .unwrap_err();
    assert_eq!(refused.code, 4210);
    // The account named must be one the bot has.
    let other = runtime
        .tool(
            &s,
            "hexbot_tasks",
            &json!({"action": "list", "account": "microsoft"}),
        )
        .await
        .unwrap_err();
    assert!(
        other
            .message
            .contains("Microsoft To Do isn't connected for you"),
        "{}",
        other.message
    );
    assert_eq!(
        runtime
            .tool(&s, "hexbot_tasks", &json!({"action": "purge"}))
            .await
            .unwrap_err()
            .code,
        4202
    );
    // Turned off for the bot since the chat began: no longer served.
    fs::write(
        h.join("profiles/owl/config.yaml"),
        "model:\n  provider: openai\n  default: fixture\ntools:\n  enabled_toolsets: []\n",
    )
    .unwrap();
    let off = runtime
        .tool(&s, "hexbot_tasks", &json!({"action": "list"}))
        .await
        .unwrap_err();
    assert!(
        off.message.contains("No task list is connected for you"),
        "{}",
        off.message
    );
}

#[tokio::test]
async fn files_come_down_among_the_chats_files_and_credentials_never_go_up() {
    let (home, runtime, _hub) = setup();
    let h = home.path();
    let docx = crate::word::create("Report", "# Report\n\nAll good.");
    let served = docx.clone();
    let (origin, log) = stand_in(move |asked| match (asked.method.as_str(), asked.path.as_str()) {
        ("GET", "/v1.0/me/drive/items/w1") => Reply::Json(200, json!({"id": "w1", "name": "Q3: Report.docx", "size": 10, "eTag": "\"v1\"", "file": {},
            "@microsoft.graph.downloadUrl": format!("{}/download", asked.origin)})),
        ("GET", "/download") => Reply::Bytes(served.clone()),
        ("PUT", _) => Reply::Json(201, json!({"id": "up", "name": "notes.md", "file": {}, "webUrl": "https://onedrive.example/up"})),
        _ => Reply::Json(404, json!({"error": {"message": "itemNotFound"}})),
    })
    .await;
    connect(h, &origin, &["onedrive", "word"]);
    open(&runtime).await;
    let s = runtime.sessions.lock().unwrap()["first"].clone();

    // A document reads as text, in parts when it is long.
    let read = runtime
        .tool(
            &s,
            "hexbot_documents",
            &json!({"action": "read", "id": "w1"}),
        )
        .await
        .unwrap();
    assert_eq!(read["text"], "# Report\n\nAll good.");
    assert_eq!(read["type"], "document");
    assert!(read.get("next_offset").is_none());
    let rest = runtime
        .tool(
            &s,
            "hexbot_drive",
            &json!({"action": "read", "id": "w1", "offset": 10}),
        )
        .await
        .unwrap();
    assert_eq!(rest["text"], "All good.");

    // A download lands in this chat's own files under a safe name, and a
    // second copy does not write over the first.
    let down = runtime
        .tool(
            &s,
            "hexbot_drive",
            &json!({"action": "download", "id": "w1"}),
        )
        .await
        .unwrap();
    let path = PathBuf::from(down["path"].as_str().unwrap());
    assert_eq!(down["name"], "Q3 Report.docx");
    let attachments = fs::canonicalize(store::session_dir(h, &s.stored).unwrap())
        .unwrap()
        .join("attachments");
    assert_eq!(path.parent(), Some(attachments.as_path()));
    assert_eq!(fs::read(&path).unwrap(), docx);
    let again = runtime
        .tool(
            &s,
            "hexbot_drive",
            &json!({"action": "download", "id": "w1"}),
        )
        .await
        .unwrap();
    assert_eq!(again["name"], "Q3 Report (2).docx");
    // A link a bot left under the next name is never followed out of the
    // folder: the download takes the name after it.
    let outside = h.join("outside.txt");
    std::os::unix::fs::symlink(&outside, attachments.join("Q3 Report (3).docx")).unwrap();
    let third = runtime
        .tool(
            &s,
            "hexbot_drive",
            &json!({"action": "download", "id": "w1"}),
        )
        .await
        .unwrap();
    assert_eq!(third["name"], "Q3 Report (4).docx");
    assert!(!outside.exists());

    // What was downloaded can go back up; a key file or one outside the
    // bot's folders cannot.
    let up = runtime
        .tool(
            &s,
            "hexbot_drive",
            &json!({"action": "upload", "path": path, "name": "notes.md"}),
        )
        .await
        .unwrap();
    assert_eq!(up["uploaded"], true);
    let sent = log.lock().unwrap().last().unwrap().clone();
    assert_eq!(sent.path, "/v1.0/me/drive/root:/notes.md:/content");
    assert_eq!(sent.body, docx);
    let workdir = crate::native_tools::section_workdir(h, &s.bot, &s.stored).unwrap();
    fs::create_dir_all(&workdir).unwrap();
    fs::write(workdir.join(".env"), "API_KEY=secret").unwrap();
    let before = log.lock().unwrap().len();
    let private = runtime
        .tool(
            &s,
            "hexbot_drive",
            &json!({"action": "upload", "path": ".env"}),
        )
        .await
        .unwrap_err();
    assert_eq!(private.message, "Credential files are private.");
    let outside = runtime
        .tool(
            &s,
            "hexbot_drive",
            &json!({"action": "upload", "path": "/etc/hosts"}),
        )
        .await
        .unwrap_err();
    assert_eq!(outside.code, 4302);
    assert_eq!(log.lock().unwrap().len(), before);
    // A tool whose connector the bot was not given is not served.
    let wrong = runtime
        .tool(
            &s,
            "hexbot_spreadsheets",
            &json!({"action": "read", "id": "w1"}),
        )
        .await
        .unwrap_err();
    assert_eq!(wrong.code, 4210);
}

/// A sheet may name a cell a million rows down. Every cell up to it is
/// never made: a file read as text shows the sheet's first part, and a read
/// of a range is cut to what a model is handed, with the range to read next.
#[test]
fn a_far_cell_or_a_large_range_reads_in_parts() {
    use crate::excel::{self, Cell};
    let text = |t: &str| vec![vec![Cell::Text(t.into())]];
    let file =
        crate::zip::Archive::open(excel::create("Far", &[(String::new(), text("first"))]).unwrap())
            .unwrap();
    let sheet = excel::sheet(&file, None).unwrap();
    let far = excel::write(
        &file,
        &sheet,
        excel::MAX_ROWS,
        excel::MAX_COLUMNS,
        &text("last"),
    )
    .unwrap();
    let shown = workspace_tool::workbook_text(&crate::zip::Archive::open(far).unwrap()).unwrap();
    assert_eq!(
        shown,
        "## Sheet1\nfirst\n[Rows 13 to 1048576 are not shown.]"
    );

    let mut out = json!({});
    let rows = vec![json!(["x".repeat(40_000)]); 3];
    let asked = excel::range("A1:A3").unwrap().1;
    workspace_tool::put_rows(
        &mut out,
        rows,
        asked,
        Some(excel::range("A4:A9").unwrap().1),
    )
    .unwrap();
    assert_eq!(out["rows"].as_array().unwrap().len(), 1);
    assert_eq!(out["range"], "A1:A1");
    assert_eq!(out["next_range"], "A2:A9");
    // What fits says nothing of a next range.
    let mut out = json!({});
    workspace_tool::put_rows(&mut out, vec![json!([1, 2])], asked, None).unwrap();
    assert_eq!(out, json!({"range": "A1:A3", "rows": [[1, 2]]}));
    // A first row too long to show is refused, with the part that fits.
    let long = vec![json!(vec!["x".repeat(25_000); 5]), json!([1])];
    let asked = excel::range("B7:F8").unwrap().1;
    let error = workspace_tool::put_rows(&mut json!({}), long, asked, None).unwrap_err();
    assert_eq!(
        error.message,
        "Row 7 holds too much text to read whole. Read it in parts, starting with B7:C7."
    );
    // Many short cells count with the commas between them.
    let wide = vec![json!(vec!["x"; 16_384])];
    let asked = excel::range("A1:XFD1").unwrap().1;
    assert!(workspace_tool::put_rows(&mut json!({}), wide, asked, None).is_err());
}

/// These tools reach the user's own things, so a room, a thread between
/// bots and a heartbeat have none of them; a scheduled job does.
#[test]
fn the_tools_are_offered_in_the_bots_own_chat_and_its_jobs_only() {
    assert!(account_tool::here(true, None));
    assert!(!account_tool::here(false, None));
    assert!(account_tool::here(false, Some(&json!({"job": "daily"}))));
    assert!(!account_tool::here(true, Some(&json!({"heartbeat": "h1"}))));
    assert!(!account_tool::here(
        true,
        Some(&json!({"parent_session": "p"}))
    ));
}

/// A sign-in is the user's to do, in Settings. A bot that asks for a
/// connector that isn't connected hears where the user goes, with no card.
#[tokio::test]
async fn a_bot_asking_for_an_unconnected_connector_is_sent_to_settings() {
    let (home, runtime, _hub) = setup();
    let h = home.path();
    fs::write(
        h.join("profiles/owl/config.yaml"),
        "model:\n  provider: openai\n  default: fixture\ntools:\n  enabled_toolsets: [hexbot]\n",
    )
    .unwrap();
    open(&runtime).await;
    let s = runtime.sessions.lock().unwrap()["first"].clone();
    for action in ["enable", "setup"] {
        let error = runtime
            .tool(
                &s,
                "hexbot_plugins",
                &json!({"action": action, "id": "connector:google_calendar"}),
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, 4209, "{action}");
        assert!(
            error
                .message
                .contains("Settings, Plugins, Google Calendar, Connect"),
            "{}",
            error.message
        );
    }
    assert!(s.state.lock().unwrap().pending.is_empty());
    // One whose sign-in stopped working needs the user too.
    fs::create_dir_all(h.join("accounts")).unwrap();
    fs::write(
        h.join("accounts/outlook.json"),
        json!({"email":"sam@contoso.com","refresh_token":"r","expired":true}).to_string(),
    )
    .unwrap();
    let error = runtime
        .tool(
            &s,
            "hexbot_plugins",
            &json!({"action": "enable", "id": "connector:outlook"}),
        )
        .await
        .unwrap_err();
    assert!(error.message.contains("Outlook, Fix"), "{}", error.message);
}
