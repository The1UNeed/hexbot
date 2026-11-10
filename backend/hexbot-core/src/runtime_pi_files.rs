//! Stateless private Pi filesystem protocol. No public tool or native-code route.
use crate::{Error, Result, common::required};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::path::PathBuf;

pub(super) const LIMIT: usize = 1024 * 1024;
pub(super) const READ_LIMIT: usize = (LIMIT - 1024) / 4 * 3;
pub(super) const SIZE_ERROR: &str = "Restricted write/edit exceeds the 1 MiB transport limit (about 767 KiB of file data). Use a command for larger files.";

/// One checked replace at a time: a side panel save or a bot's edit. Each
/// checks the version it read and replaces the file under this lock, so neither
/// can pass its check and then write over the other's change.
pub(super) static SAVES: std::sync::Mutex<()> = std::sync::Mutex::new(());
/// A file's version: the SHA-256 of its contents. Unlike a modification time
/// it cannot repeat for a different file, however quickly the file is replaced.
pub(super) fn version_of(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(bytes))
}

pub(super) struct Request {
    pub operation: String,
    pub tool: &'static str,
    pub path: PathBuf,
    pub bytes: Vec<u8>,
    pub parent: Option<[String; 2]>,
    /// For an edit, the version `edit_open` returned with the bytes it opened.
    pub opened: Option<String>,
}
pub(super) fn parse(event: &Value, args: &Value) -> Result<Request> {
    if event["type"] != "extension_ui_request" || event["method"] != "input" {
        return Err(Error::new(
            4302,
            "The private file bridge requires Pi's input transport.",
        ));
    }
    if serde_json::to_vec(event)
        .map_err(|e| Error::new(4202, e.to_string()))?
        .len()
        > LIMIT
    {
        return Err(Error::new(4202, SIZE_ERROR));
    }
    let operation = required(args, "operation")?;
    let tool = match operation {
        "write" => "write",
        "edit_open" | "edit_commit" => "edit",
        _ => return Err(Error::new(4202, "Unknown private file operation")),
    };
    let path = PathBuf::from(required(args, "path")?);
    if !path.is_absolute()
        || path.components().any(|c| {
            matches!(
                c,
                std::path::Component::ParentDir | std::path::Component::CurDir
            )
        })
    {
        return Err(Error::new(4202, "file path must be absolute and resolved"));
    }
    let bytes = if operation == "edit_open" {
        Vec::new()
    } else {
        let encoded = args["content"]
            .as_str()
            .ok_or_else(|| Error::new(4202, "Missing file content base64"))?;
        STANDARD
            .decode(encoded)
            .map_err(|_| Error::new(4202, "Invalid file content base64"))?
    };
    let parent = if operation == "edit_commit" {
        Some(
            serde_json::from_value::<[String; 2]>(args["parent"].clone())
                .map_err(|_| Error::new(4202, "Invalid file folder identity"))?,
        )
    } else {
        None
    };
    let opened = if operation == "edit_commit" {
        let opened = required(args, "opened")?;
        if opened.len() != 64 || !opened.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(Error::new(4202, "Invalid opened file version"));
        }
        Some(opened.to_ascii_lowercase())
    } else {
        None
    };
    Ok(Request {
        operation: operation.into(),
        tool,
        path,
        bytes,
        parent,
        opened,
    })
}
/// The envelope actually sent by PiProcess::respond_extension, excluding LF.
pub(super) fn reply(id: &str, result: &Value) -> Result<()> {
    let envelope = json!({"type":"extension_ui_response","id":id,"value":json!({"result":result}).to_string()});
    if serde_json::to_vec(&envelope)
        .map_err(|e| Error::new(4202, e.to_string()))?
        .len()
        > LIMIT
    {
        return Err(Error::new(4202, SIZE_ERROR));
    }
    Ok(())
}
/// The file layer anchors every operation to folder handles: `runtime_files.rs`
/// on Unix, `runtime_files_windows.rs` on Windows, where an edit's identity is
/// the file's own rather than its folder's.
pub(super) fn perform(request: &Request, id: &str) -> Result<Value> {
    // Check every known reply before creating any missing parent directories.
    let success = json!({"success":true});
    reply(id, &success)?;
    let access = super::files::FileAccess::pi_open(&request.path, request.operation == "write")
        .map_err(|error| {
            if request.operation == "edit_commit" {
                Error::new(4302, "The file's folder changed. Try again.")
            } else {
                error
            }
        })?;
    if let Some(parent) = &request.parent {
        access.check_parent(parent)?;
    }
    if request.operation == "edit_open" {
        let bytes = access.pi_read(READ_LIMIT)?;
        let value = json!({"content":STANDARD.encode(&bytes),"parent":access.parent_identity()?,"version":version_of(&bytes)});
        reply(id, &value)?;
        return Ok(value);
    }
    // An edit was computed from the bytes it opened. If the file changed since,
    // such as the user saving it from the side panel, writing would undo that.
    let _save = SAVES
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(opened) = &request.opened
        && version_of(&access.pi_read(READ_LIMIT)?) != *opened
    {
        return Err(Error::new(
            4209,
            "The file changed after it was read. Read it again and redo the edit.",
        ));
    }
    access.pi_write(&request.bytes)?;
    Ok(success)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    fn call(args: Value) -> Result<Value> {
        let event = json!({"type":"extension_ui_request","id":"test","method":"input","title":format!("__HEXBOT_TOOL__{}",json!({"name":"hexbot_pi_file","args":args}))});
        perform(&parse(&event, &args)?, "test")
    }
    #[test]
    fn pi_edit_reopens_parent_and_refuses_a_replacement_directory() {
        for symlink in [false, true] {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path().canonicalize().unwrap();
            let output = root.join("output");
            let moved = root.join("moved");
            let managed = root.join("managed");
            std::fs::create_dir(&output).unwrap();
            std::fs::create_dir(&managed).unwrap();
            let path = output.join("file");
            std::fs::write(&path, b"\xff\xef\xbb\xbfkeep\r\n").unwrap();
            std::fs::write(managed.join("file"), "keep").unwrap();
            let opened = call(json!({"operation":"edit_open","path":path})).unwrap();
            assert_eq!(
                STANDARD
                    .decode(opened["content"].as_str().unwrap())
                    .unwrap(),
                b"\xff\xef\xbb\xbfkeep\r\n"
            );
            std::fs::rename(&output, &moved).unwrap();
            if symlink {
                std::os::unix::fs::symlink(&managed, &output).unwrap();
            } else {
                std::fs::create_dir(&output).unwrap();
                std::fs::write(&path, "replacement").unwrap();
            }
            let result = call(
                json!({"operation":"edit_commit","path":path,"parent":opened["parent"],"opened":opened["version"],"content":STANDARD.encode("changed")}),
            );
            assert!(result.unwrap_err().message.contains("folder changed"));
            assert_eq!(
                std::fs::read_to_string(managed.join("file")).unwrap(),
                "keep"
            );
            assert_eq!(
                std::fs::read(moved.join("file")).unwrap(),
                b"\xff\xef\xbb\xbfkeep\r\n"
            );
            if !symlink {
                assert_eq!(std::fs::read_to_string(path).unwrap(), "replacement");
            }
        }
    }
    #[test]
    fn pi_edit_refuses_to_undo_a_change_made_after_it_opened_the_file() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().canonicalize().unwrap().join("plan.md");
        std::fs::write(&path, "draft").unwrap();
        let commit = |opened: &Value, content: &str| {
            call(
                json!({"operation":"edit_commit","path":path,"parent":opened["parent"],"opened":opened["version"],"content":STANDARD.encode(content)}),
            )
        };
        let opened = call(json!({"operation":"edit_open","path":path})).unwrap();
        // The user saves from the side panel while the bot works out its edit.
        super::super::panel_files::write_text(&path, "user's save", None).unwrap();
        let refused = commit(&opened, "bot's edit of the draft").unwrap_err();
        assert_eq!(refused.code, 4209);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "user's save");
        // Reopened, the edit goes through.
        let opened = call(json!({"operation":"edit_open","path":path})).unwrap();
        commit(&opened, "bot's edit of the save").unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "bot's edit of the save"
        );
        let missing = call(
            json!({"operation":"edit_commit","path":path,"parent":opened["parent"],"content":STANDARD.encode("x")}),
        );
        assert!(missing.is_err());
    }
    #[test]
    fn pi_invalid_or_oversized_requests_do_not_create_parents() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let path = root.join("missing/nested/file");
        for content in ["!".into(), "A".repeat(LIMIT)] {
            assert!(call(json!({"operation":"write","path":path,"content":content})).is_err());
            assert!(!root.join("missing").exists());
        }
        let source = root.join("large");
        std::fs::write(&source, vec![b'x'; READ_LIMIT + 1]).unwrap();
        assert!(
            call(json!({"operation":"edit_open","path":source}))
                .unwrap_err()
                .message
                .contains("1 MiB")
        );
        assert_eq!(
            std::fs::metadata(source).unwrap().len(),
            (READ_LIMIT + 1) as u64
        );
    }
    #[test]
    fn pi_write_creates_parents_but_never_follows_parent_or_leaf_links() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let path = root.join("new/nested/file");
        call(json!({"operation":"write","path":path,"content":STANDARD.encode("ordinary")}))
            .unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "ordinary");
        let source = root.join("protected");
        std::fs::write(&source, "keep").unwrap();
        std::fs::remove_file(&path).unwrap();
        std::os::unix::fs::symlink(&source, &path).unwrap();
        assert!(
            call(json!({"operation":"write","path":path,"content":STANDARD.encode("changed")}))
                .is_err()
        );
        assert_eq!(std::fs::read_to_string(&source).unwrap(), "keep");
        std::os::unix::fs::symlink(root.join("new"), root.join("alias")).unwrap();
        assert!(call(json!({"operation":"write","path":root.join("alias/nested/file"),"content":STANDARD.encode("changed")})).is_err());
        let fifo = root.join("fifo");
        let name = std::ffi::CString::new(fifo.as_os_str().as_encoded_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        for operation in ["write", "edit_open"] {
            assert!(
                call(
                    json!({"operation":operation,"path":fifo,"content":STANDARD.encode("changed")})
                )
                .unwrap_err()
                .message
                .contains("regular file")
            );
        }
    }
}
