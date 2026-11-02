#![cfg(windows)]
//! Native Windows only: the shared filesystem boundaries against real
//! junctions, devices and DACLs. Other hosts cover the same rules with
//! symbolic links and the portable tests in `osutil` and `common`.
#[path = "../src/windows_paths.rs"]
mod windows_paths;

use hexbot_core::{common, osutil};
use std::{
    fs, io,
    path::{Path, PathBuf},
    process::Command,
};

fn junction(link: &Path, target: &Path) {
    let status = Command::new(windows_paths::system_program("cmd.exe").unwrap())
        .args(["/d", "/c", "mklink", "/J"])
        .arg(link)
        .arg(target)
        .output()
        .unwrap();
    assert!(status.status.success(), "{status:?}");
    assert!(fs::symlink_metadata(link).unwrap().file_type().is_symlink());
}

/// The DACL of `path` as Windows reports it: its control flags and each
/// entry's type, flags, rights and trustee.
fn dacl(path: &Path) -> (String, Vec<[String; 4]>) {
    let literal = path.to_str().unwrap().replace('\'', "''");
    let output = Command::new(
        windows_paths::system_program("WindowsPowerShell/v1.0/powershell.exe").unwrap(),
    )
    .args(["-NoProfile", "-NonInteractive", "-Command"])
    .arg(format!("(Get-Acl -LiteralPath '{literal}').Sddl"))
    .output()
    .unwrap();
    assert!(output.status.success(), "{output:?}");
    let sddl = String::from_utf8(output.stdout).unwrap();
    let dacl = sddl[sddl.find("D:").unwrap() + 2..].trim();
    let (flags, aces) = dacl.split_once('(').unwrap();
    let entries = aces
        .trim_end_matches(')')
        .split(")(")
        .map(|ace| {
            let parts: Vec<&str> = ace.split(';').collect();
            [parts[0], parts[1], parts[2], parts[5]].map(str::to_owned)
        })
        .collect();
    (flags.to_owned(), entries)
}

/// SYSTEM and the user, with full control and these entry flags.
fn private(sid: &str, flags: &str) -> Vec<[String; 4]> {
    ["SY", sid]
        .map(|trustee| ["A", flags, "FA", trustee].map(str::to_owned))
        .to_vec()
}

fn user_sid() -> String {
    let output = Command::new(windows_paths::system_program("whoami.exe").unwrap())
        .args(["/user", "/fo", "csv", "/nh"])
        .output()
        .unwrap();
    let text = String::from_utf8(output.stdout).unwrap();
    text.trim()
        .rsplit(',')
        .next()
        .unwrap()
        .trim_matches('"')
        .to_owned()
}

#[test]
fn junctions_are_removed_as_links_and_refused_as_roots() {
    let base = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    fs::write(outside.path().join("keep"), "keep").unwrap();
    // A junction by itself, and one inside a tree, go as links.
    let link = base.path().join("link");
    junction(&link, outside.path());
    osutil::remove_entry(&link).unwrap();
    assert!(fs::symlink_metadata(&link).is_err());
    let tree = base.path().join("tree");
    fs::create_dir(&tree).unwrap();
    junction(&tree.join("inside"), outside.path());
    osutil::remove_entry(&tree).unwrap();
    assert!(!tree.exists());
    assert!(outside.path().join("keep").is_file());
    // A junction on the way to a root is refused.
    let runtime = base.path().join("runtime");
    junction(&runtime, outside.path());
    let error = osutil::directory_below(base.path(), &runtime.join("sessions")).unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
    assert!(outside.path().join("keep").is_file());
}

#[test]
fn reads_open_only_local_disk_files() {
    let base = tempfile::tempdir().unwrap();
    let file = base.path().join("text");
    fs::write(&file, "12345").unwrap();
    assert_eq!(common::read_regular(&file, 5).unwrap(), b"12345");
    assert_eq!(common::read_regular(&file, 4).unwrap_err().code, 4202);
    let link = base.path().join("link");
    junction(&link, base.path());
    for (path, reason) in [
        (base.path().to_path_buf(), "regular file"),
        (link, "regular file"),
        (PathBuf::from(r"\\.\pipe\hexbot-never-opened"), "device"),
        (base.path().join("NUL"), "reserved"),
        (
            PathBuf::from(r"\\hexbot-never-opened\share\file"),
            "network",
        ),
        (base.path().join("text:stream"), "stream"),
        (PathBuf::from("relative.txt"), "absolute"),
    ] {
        let error = common::read_regular(&path, 5).unwrap_err();
        assert_eq!(error.code, 4202, "{}", path.display());
        assert!(
            error.message.contains(reason),
            "{}: {}",
            path.display(),
            error.message
        );
    }
}

#[test]
fn commands_take_pathext_extensions_and_either_separator() {
    let cwd = tempfile::tempdir().unwrap();
    fs::create_dir(cwd.path().join("bin")).unwrap();
    fs::write(cwd.path().join("bin/tool.cmd"), "@echo off\r\n").unwrap();
    fs::write(cwd.path().join("bin/plain"), "").unwrap();
    for program in [r"bin\tool", "bin/tool", "bin/tool.cmd"] {
        let found = common::command_path(program, cwd.path()).unwrap();
        assert!(
            found
                .to_string_lossy()
                .to_ascii_lowercase()
                .ends_with("tool.cmd"),
            "{program}: {}",
            found.display()
        );
    }
    // A file Windows cannot run is no command.
    assert_eq!(common::command_path("bin/plain", cwd.path()), None);
}

#[test]
fn private_folders_and_files_are_for_system_and_the_user_alone() {
    let base = tempfile::tempdir().unwrap();
    let sid = user_sid();
    assert!(sid.starts_with("S-1-"), "{sid}");
    let home = base.path().join("home");
    osutil::create_private_dir_all(&home).unwrap();
    let (flags, entries) = dacl(&home);
    // Protected: nothing the parent grants reaches it.
    assert!(flags.contains('P'), "{flags}");
    assert_eq!(entries, private(&sid, "OICI"));
    // What is written into a private folder later inherits only its entries.
    let key = home.join("passwords.key");
    common::atomic_write(&key, b"secret").unwrap();
    assert_eq!(dacl(&key).1, private(&sid, "ID"));
    let token = base.path().join("local-device.token");
    fs::write(&token, "token").unwrap();
    osutil::private_file(&token).unwrap();
    let (flags, entries) = dacl(&token);
    assert!(flags.contains('P'), "{flags}");
    assert_eq!(entries, private(&sid, ""));
    let folder = base.path().join("mcp");
    fs::create_dir(&folder).unwrap();
    osutil::private_dir(&folder).unwrap();
    assert_eq!(dacl(&folder).1, private(&sid, "OICI"));
    // Repeating it changes nothing.
    osutil::private_dir(&home).unwrap();
    assert_eq!(dacl(&home).1, private(&sid, "OICI"));
}
