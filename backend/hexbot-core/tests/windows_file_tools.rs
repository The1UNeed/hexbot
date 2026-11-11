#![cfg(windows)]
//! Native Windows only: Pi's write and edit through the daemon's handle
//! bridge (`runtime_files_windows.rs`) and the production private protocol,
//! against real junctions, file links, hard links, short names, file IDs and
//! renames. Other hosts run the bridge's portable rules
//! (`runtime_files_windows_policy.rs`) and the Unix handle tests.
use base64::{Engine, engine::general_purpose::STANDARD};
use hexbot_core::{Error, Result, common, windows_sandbox};
use serde_json::{Value, json};
use std::{
    ffi::OsString,
    fs,
    os::windows::ffi::{OsStrExt, OsStringExt},
    path::{Path, PathBuf},
    process::Command,
    time::{Duration, Instant},
};

#[path = "../src/runtime_files_windows.rs"]
mod files;
#[allow(dead_code)]
#[path = "../src/runtime_pi_files.rs"]
mod protocol;
#[allow(dead_code)]
#[path = "../src/windows_paths.rs"]
mod windows_paths;

fn call(args: Value) -> Result<Value> {
    let event = json!({"type":"extension_ui_request","id":"test","method":"input","title":format!("__HEXBOT_TOOL__{}",json!({"name":"hexbot_pi_file","args":args}))});
    protocol::perform(&protocol::parse(&event, &args)?, "test")
}

fn content(text: impl AsRef<[u8]>) -> String {
    STANDARD.encode(text)
}

/// A scratch folder by its long, plain path. Runners name their temp folder
/// by an 8.3 short name, which the bridge refuses.
fn scratch() -> (tempfile::TempDir, PathBuf) {
    let temp = tempfile::tempdir().unwrap();
    let real = fs::canonicalize(temp.path()).unwrap();
    let text = real.to_str().unwrap();
    let root = PathBuf::from(text.strip_prefix(r"\\?\").unwrap_or(text));
    (temp, root)
}

fn junction(link: &Path, target: &Path) {
    let output = Command::new(windows_paths::system_program("cmd.exe").unwrap())
        .args(["/d", "/c", "mklink", "/J"])
        .arg(link)
        .arg(target)
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");
    assert!(fs::symlink_metadata(link).unwrap().file_type().is_symlink());
}

/// The 8.3 short name Windows gave the last name of `path`, if the volume
/// makes them and it differs from the long one.
fn short_name(path: &Path) -> Option<String> {
    #[link(name = "kernel32", kind = "raw-dylib")]
    unsafe extern "system" {
        fn GetShortPathNameW(long: *const u16, short: *mut u16, length: u32) -> u32;
    }
    let long: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut buffer = vec![0u16; 32768];
    // SAFETY: a NUL-terminated path and a buffer of the length given.
    let length =
        unsafe { GetShortPathNameW(long.as_ptr(), buffer.as_mut_ptr(), buffer.len() as u32) }
            as usize;
    if length == 0 || length >= buffer.len() {
        return None;
    }
    let short = PathBuf::from(OsString::from_wide(&buffer[..length]));
    let name = short.file_name()?.to_str()?.to_owned();
    (name != path.file_name()?.to_str()?).then_some(name)
}

/// Every write leaves no temporary file behind in `folder`.
fn no_temporary(folder: &Path) {
    for entry in fs::read_dir(folder).unwrap() {
        let name = entry.unwrap().file_name();
        assert!(
            !name.to_string_lossy().starts_with(".hexbot-"),
            "{}: {name:?}",
            folder.display()
        );
    }
}

#[test]
fn write_creates_folders_and_replaces_files_without_following_links() {
    let (_temp, root) = scratch();
    let path = root.join(r"new\nested\file.txt");
    let write = |path: &Path, text: &str| {
        call(json!({"operation":"write","path":path,"content":content(text)}))
    };
    assert_eq!(write(&path, "first").unwrap(), json!({"success":true}));
    assert_eq!(fs::read_to_string(&path).unwrap(), "first");
    // The file is replaced, never written in place: another hard-link name
    // keeps the old content.
    let alias = root.join("alias.txt");
    fs::hard_link(&path, &alias).unwrap();
    write(&path, "second").unwrap();
    assert_eq!(fs::read_to_string(&path).unwrap(), "second");
    assert_eq!(fs::read_to_string(&alias).unwrap(), "first");
    write(&path, "").unwrap();
    assert_eq!(fs::metadata(&path).unwrap().len(), 0);
    // A one-letter name takes the shortest rename record Windows accepts.
    write(&root.join("a"), "short").unwrap();
    assert_eq!(fs::read_to_string(root.join("a")).unwrap(), "short");
    // A junction on the way is opened as itself and refused, never followed,
    // and no folder is created through it.
    let outside = root.join("outside");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("file.txt"), "keep").unwrap();
    junction(&root.join("link"), &outside);
    for (operation, path) in [
        ("write", root.join(r"link\file.txt")),
        ("write", root.join(r"link\new\file.txt")),
        ("edit_open", root.join(r"link\file.txt")),
    ] {
        let error = call(json!({"operation":operation,"path":path,"content":content("changed")}))
            .unwrap_err();
        assert!(
            error.message.contains("a link, a junction"),
            "{operation} {}: {}",
            path.display(),
            error.message
        );
    }
    assert!(!outside.join("new").exists());
    assert_eq!(
        fs::read_to_string(outside.join("file.txt")).unwrap(),
        "keep"
    );
    // A junction or file link at the name is no regular file: it is neither
    // read nor replaced. File links need a privilege some accounts lack.
    let mut links = vec![root.join("leaf")];
    junction(&links[0], &outside);
    let file_link = root.join("file-link.txt");
    if std::os::windows::fs::symlink_file(outside.join("file.txt"), &file_link).is_ok() {
        links.push(file_link);
    }
    for link in &links {
        for operation in ["write", "edit_open"] {
            let error =
                call(json!({"operation":operation,"path":link,"content":content("changed")}))
                    .unwrap_err();
            assert!(
                error.message.contains("regular file"),
                "{operation} {}: {}",
                link.display(),
                error.message
            );
        }
        assert!(fs::symlink_metadata(link).unwrap().file_type().is_symlink());
    }
    assert_eq!(
        fs::read_to_string(outside.join("file.txt")).unwrap(),
        "keep"
    );
    for folder in [&root, &root.join(r"new\nested"), &outside] {
        no_temporary(folder);
    }
}

#[test]
fn edit_commits_only_to_the_file_it_read() {
    let (_temp, root) = scratch();
    let folder = root.join("output");
    fs::create_dir(&folder).unwrap();
    let path = folder.join("file.txt");
    let raw = b"\xef\xbb\xbfkeep\r\n\xff";
    fs::write(&path, raw).unwrap();
    let open = || call(json!({"operation":"edit_open","path":path})).unwrap();
    let commit = |opened: &Value, text: &str| {
        call(
            json!({"operation":"edit_commit","path":path,"parent":opened["parent"],"opened":opened["version"],"content":content(text)}),
        )
    };
    // Raw bytes come back with the file's identity, two strings of digits.
    let opened = open();
    assert_eq!(
        STANDARD
            .decode(opened["content"].as_str().unwrap())
            .unwrap(),
        raw
    );
    let parent = opened["parent"].clone();
    let parts = parent.as_array().unwrap();
    assert_eq!(parts.len(), 2);
    assert!(parts.iter().all(|part| {
        part.as_str()
            .is_some_and(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()))
    }));
    commit(&opened, "edited").unwrap();
    assert_eq!(fs::read_to_string(&path).unwrap(), "edited");
    // The commit replaced the file, so the identity read before is stale.
    let error = commit(&opened, "again").unwrap_err();
    assert!(error.message.contains("file changed"), "{}", error.message);
    assert_eq!(fs::read_to_string(&path).unwrap(), "edited");
    // The same file rewritten in place keeps its identity, so the version of
    // the bytes the edit read refuses it.
    let opened = open();
    fs::write(&path, "saved since").unwrap();
    let error = commit(&opened, "changed").unwrap_err();
    assert_eq!(error.code, 4209, "{}", error.message);
    assert_eq!(fs::read_to_string(&path).unwrap(), "saved since");
    // Another file put in its place between the read and the commit refuses.
    let opened = open();
    let other = folder.join("other.txt");
    fs::write(&other, "replacement").unwrap();
    fs::rename(&other, &path).unwrap();
    let error = commit(&opened, "changed").unwrap_err();
    assert!(error.message.contains("file changed"), "{}", error.message);
    assert_eq!(fs::read_to_string(&path).unwrap(), "replacement");
    // So does a deleted file, which a commit never recreates.
    let opened = open();
    fs::remove_file(&path).unwrap();
    let error = commit(&opened, "changed").unwrap_err();
    assert!(error.message.contains("file changed"), "{}", error.message);
    assert!(!path.exists());
    // A new folder in place of the file's folder: the moved file keeps its
    // content and the new folder's file is untouched.
    fs::write(&path, "keep").unwrap();
    let opened = open();
    let moved = root.join("moved");
    fs::rename(&folder, &moved).unwrap();
    fs::create_dir(&folder).unwrap();
    fs::write(&path, "replacement").unwrap();
    let error = commit(&opened, "changed").unwrap_err();
    assert!(error.message.contains("file changed"), "{}", error.message);
    assert_eq!(fs::read_to_string(&path).unwrap(), "replacement");
    assert_eq!(fs::read_to_string(moved.join("file.txt")).unwrap(), "keep");
    // A junction there reaches the very file that was read, but the walk
    // never follows it.
    fs::remove_file(&path).unwrap();
    fs::remove_dir(&folder).unwrap();
    junction(&folder, &moved);
    let error = commit(&opened, "changed").unwrap_err();
    assert!(
        error.message.contains("folder changed"),
        "{}",
        error.message
    );
    assert_eq!(fs::read_to_string(moved.join("file.txt")).unwrap(), "keep");
    // An edit through one hard-link name replaces that name alone.
    let source = root.join("managed.txt");
    fs::write(&source, "keep").unwrap();
    let alias = root.join("alias.txt");
    fs::hard_link(&source, &alias).unwrap();
    let opened = call(json!({"operation":"edit_open","path":alias})).unwrap();
    call(json!({"operation":"edit_commit","path":alias,"parent":opened["parent"],"opened":opened["version"],"content":content("changed")}))
        .unwrap();
    assert_eq!(fs::read_to_string(&alias).unwrap(), "changed");
    assert_eq!(fs::read_to_string(&source).unwrap(), "keep");
    no_temporary(&root);
    no_temporary(&moved);
}

#[test]
fn a_folder_at_the_name_refuses_and_leaves_no_temporary_file() {
    let (_temp, root) = scratch();
    let target = root.join("file");
    fs::create_dir(&target).unwrap();
    for operation in ["write", "edit_open"] {
        let error = call(json!({"operation":operation,"path":target,"content":content("changed")}))
            .unwrap_err();
        assert!(
            error.message.contains("regular file"),
            "{operation}: {}",
            error.message
        );
    }
    fs::remove_dir(&target).unwrap();
    // A folder that arrives after the walk found the name free refuses at
    // the rename, and the temporary file goes through its own handle.
    let access = files::FileAccess::pi_open(&target, true).unwrap();
    fs::create_dir(&target).unwrap();
    assert!(access.pi_write(b"changed").is_err());
    drop(access);
    assert!(target.is_dir());
    assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
}

#[test]
fn invalid_oversized_and_read_only_requests_change_nothing() {
    let (_temp, root) = scratch();
    let path = root.join(r"missing\nested\file");
    for text in ["!".to_owned(), "A".repeat(protocol::LIMIT)] {
        assert!(call(json!({"operation":"write","path":path,"content":text})).is_err());
        assert!(!root.join("missing").exists());
    }
    let large = root.join("large");
    fs::write(&large, vec![b'x'; protocol::READ_LIMIT + 1]).unwrap();
    let error = call(json!({"operation":"edit_open","path":large})).unwrap_err();
    assert!(error.message.contains("1 MiB"), "{}", error.message);
    assert_eq!(
        fs::metadata(&large).unwrap().len(),
        (protocol::READ_LIMIT + 1) as u64
    );
    // A read-only file is neither replaced nor read for an edit.
    let locked = root.join("locked.txt");
    fs::write(&locked, "keep").unwrap();
    let mut permissions = fs::metadata(&locked).unwrap().permissions();
    permissions.set_readonly(true);
    fs::set_permissions(&locked, permissions.clone()).unwrap();
    for operation in ["write", "edit_open"] {
        let error = call(json!({"operation":operation,"path":locked,"content":content("changed")}))
            .unwrap_err();
        assert!(
            error.message.contains("EACCES"),
            "{operation}: {}",
            error.message
        );
    }
    assert_eq!(fs::read_to_string(&locked).unwrap(), "keep");
    no_temporary(&root);
    // Windows has no world-writable bit; this only lets the cleanup delete it.
    #[allow(clippy::permissions_set_readonly_false)]
    permissions.set_readonly(false);
    fs::set_permissions(&locked, permissions).unwrap();
}

#[test]
fn network_device_stream_and_short_name_paths_refuse_before_any_change() {
    let (_temp, root) = scratch();
    let stream = format!(r"{}\notes.txt:secret", root.display());
    let reserved = format!(r"{}\nul.txt", root.display());
    for (path, reason) in [
        (r"\\hexbot-hostile.invalid\share\file.txt", "network paths"),
        (
            r"\\?\UNC\hexbot-hostile.invalid\share\file.txt",
            "network paths",
        ),
        (r"\\.\pipe\hexbot-private-file", "device or NT object paths"),
        (stream.as_str(), "alternate data stream"),
        (reserved.as_str(), "reserved Windows device name"),
    ] {
        for operation in ["write", "edit_open", "edit_commit"] {
            let started = Instant::now();
            let error = call(json!({"operation":operation,"path":path,"content":content("changed"),"parent":["0","0"],"opened":"0".repeat(64)}))
                .unwrap_err();
            // A commit reports any walk that stops as a changed folder; the
            // daemon judges the text before the bridge and names the reason.
            let expected = if operation == "edit_commit" {
                "folder changed"
            } else {
                reason
            };
            assert!(
                error.message.contains(expected),
                "{operation} {path}: {}",
                error.message
            );
            assert!(started.elapsed() < Duration::from_secs(2), "{path}");
        }
    }
    assert!(!root.join("notes.txt").exists());
    // An 8.3 short name reaches an entry by text no policy check saw, so a
    // folder or a file reached by one refuses.
    let folder = root.join("hexbot long folder name");
    fs::create_dir(&folder).unwrap();
    let file = folder.join("hexbot long file name.txt");
    fs::write(&file, "keep").unwrap();
    let (Some(short_folder), Some(short_file)) = (short_name(&folder), short_name(&file)) else {
        eprintln!("This volume makes no 8.3 names; the short-name refusals are not exercised.");
        return;
    };
    for path in [
        root.join(short_folder).join("hexbot long file name.txt"),
        folder.join(short_file),
    ] {
        for operation in ["write", "edit_open"] {
            let error =
                call(json!({"operation":operation,"path":path,"content":content("changed")}))
                    .unwrap_err();
            assert!(
                error.message.contains("another name"),
                "{operation} {}: {}",
                path.display(),
                error.message
            );
        }
    }
    assert_eq!(fs::read_to_string(&file).unwrap(), "keep");
    no_temporary(&folder);
}
