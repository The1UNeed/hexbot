//! The Windows sandbox, run as a standard user against real files, processes
//! and sockets. CI builds it from a disposable copy without the platform guard
//! (`scripts/dev/windows-sandbox-standard-user.ps1`).
#![cfg(windows)]
use base64::Engine;
use hexbot_core::windows_container::{self as sandbox, Access, Policy};
use std::{
    ffi::OsString,
    fs,
    io::Read,
    net::TcpListener,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

struct Fixture {
    _root: tempfile::TempDir,
    home: PathBuf,
    workspace: PathBuf,
    /// In the user's profile, where ~/.ssh and ~/.hexbot are.
    outside: PathBuf,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = sandbox::reset(&self.home);
        let _ = fs::remove_dir_all(&self.outside);
    }
}

fn fixture(name: &str) -> Fixture {
    let root = tempfile::tempdir().unwrap();
    let home = root.path().join("home");
    let workspace = root.path().join("workspace with spaces");
    fs::create_dir_all(home.join("runtime")).unwrap();
    fs::write(home.join("connect.json"), "{\"token\":\"secret\"}").unwrap();
    fs::create_dir_all(workspace.join(".git/hooks")).unwrap();
    fs::write(workspace.join(".git/config"), "[core]\n").unwrap();
    fs::write(workspace.join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();
    fs::create_dir_all(workspace.join("src")).unwrap();
    fs::write(workspace.join("src/a.txt"), "hello").unwrap();
    fs::write(workspace.join(".env"), "KEY=1").unwrap();
    let outside = PathBuf::from(std::env::var_os("USERPROFILE").unwrap())
        .join(format!("hexbot-sandbox-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&outside);
    fs::create_dir_all(&outside).unwrap();
    fs::write(outside.join("id_ed25519"), "PRIVATE").unwrap();
    fs::hard_link(outside.join("id_ed25519"), workspace.join("linked")).unwrap();
    let status = Command::new(cmd())
        // cmd.exe splits quoted arguments; a relative name needs no quoting.
        .current_dir(&workspace)
        .args(["/d", "/c", "mklink", "/J", "junction"])
        .arg(&outside)
        .stdout(Stdio::null())
        .status()
        .unwrap();
    assert!(status.success(), "cannot create the junction fixture");
    Fixture {
        _root: root,
        home,
        workspace,
        outside,
    }
}

fn cmd() -> PathBuf {
    PathBuf::from(std::env::var_os("SystemRoot").unwrap())
        .join("System32")
        .join("cmd.exe")
}

fn auto(f: &Fixture) -> Policy {
    Policy {
        access: Some(Access::Workspace),
        writable: vec![f.workspace.clone()],
        deny_write: vec![f.workspace.join(".git")],
        deny_all: vec![f.workspace.join(".env")],
        ..Policy::default()
    }
}

fn run(f: &Fixture, policy: &Policy, program: &Path, arguments: &[&str]) -> u32 {
    let access = policy.access.unwrap();
    let sid = sandbox::prepare(&f.home, policy).unwrap();
    let env = sandbox::environment(&f.home, access, std::env::vars_os());
    let arguments: Vec<OsString> = arguments.iter().map(OsString::from).collect();
    let child = sandbox::spawn(
        &sid,
        program,
        &arguments,
        Some(&f.workspace),
        &env,
        Some(64),
    )
    .unwrap();
    child.wait().unwrap()
}

/// cmd.exe parses its own command line, so scripts avoid quotes and use paths
/// relative to the workspace or without spaces.
fn script(f: &Fixture, policy: &Policy, script: &str) -> u32 {
    run(f, policy, &cmd(), &["/d", "/c", script])
}

fn icacls(path: &Path) -> String {
    let output = Command::new(
        PathBuf::from(std::env::var_os("SystemRoot").unwrap())
            .join("System32")
            .join("icacls.exe"),
    )
    .arg(path)
    .output()
    .unwrap();
    assert!(output.status.success());
    String::from_utf8_lossy(&output.stdout).into_owned()
}

#[test]
fn auto_writes_only_the_workspace_and_never_git_or_secrets() {
    let f = fixture("auto");
    let policy = auto(&f);
    let outside_acl = icacls(&f.outside.join("id_ed25519"));
    assert_eq!(script(&f, &policy, "echo x> new.txt"), 0);
    assert!(f.workspace.join("new.txt").is_file());
    assert_eq!(script(&f, &policy, "echo more>> src\\a.txt"), 0);
    assert_eq!(script(&f, &policy, "mkdir made && echo x> made\\b.txt"), 0);
    assert!(f.workspace.join("made/b.txt").is_file());
    // Git metadata reads, never writes.
    assert_eq!(script(&f, &policy, "type .git\\HEAD"), 0);
    assert_ne!(script(&f, &policy, "echo x>> .git\\config"), 0);
    assert_ne!(script(&f, &policy, "echo x> .git\\hooks\\pre-commit"), 0);
    // rmdir reports success even when it removes nothing; check what is left.
    script(&f, &policy, "rmdir /s /q .git");
    assert_eq!(
        fs::read_to_string(f.workspace.join(".git/config")).unwrap(),
        "[core]\n"
    );
    assert!(!f.workspace.join(".git/hooks/pre-commit").exists());
    // Project secrets neither read nor write.
    assert_ne!(script(&f, &policy, "type .env"), 0);
    assert_ne!(script(&f, &policy, "echo x>> .env"), 0);
    assert_eq!(
        fs::read_to_string(f.workspace.join(".env")).unwrap(),
        "KEY=1"
    );
    // A hard link to a profile file and a junction out of the workspace stay closed,
    // and granting the workspace did not change the profile file's own entries.
    assert_ne!(script(&f, &policy, "type linked"), 0);
    assert_ne!(script(&f, &policy, "dir junction"), 0);
    assert_ne!(script(&f, &policy, "echo x> junction\\planted"), 0);
    assert!(!f.outside.join("planted").exists());
    assert_eq!(icacls(&f.outside.join("id_ed25519")), outside_acl);
    // The user's profile and the Hexbot home are out of reach.
    let key = f.outside.join("id_ed25519");
    assert_ne!(script(&f, &policy, &format!("type {}", key.display())), 0);
    assert_ne!(
        script(
            &f,
            &policy,
            &format!("echo x> {}\\new", f.outside.display())
        ),
        0
    );
    assert_ne!(
        script(
            &f,
            &policy,
            &format!("type {}", f.home.join("connect.json").display())
        ),
        0
    );
    // A folder the walk never reached is created by the command with its grant.
    assert_eq!(
        script(
            &f,
            &policy,
            "echo x> %TEMP%\\scratch && type %TEMP%\\scratch"
        ),
        0
    );
}

#[test]
fn manual_reads_the_workspace_and_writes_nothing() {
    let f = fixture("manual");
    let policy = Policy {
        access: Some(Access::Read),
        readable: vec![f.workspace.clone()],
        deny_all: vec![f.workspace.join(".env")],
        ..Policy::default()
    };
    assert_eq!(script(&f, &policy, "type src\\a.txt"), 0);
    assert_ne!(script(&f, &policy, "echo x> new.txt"), 0);
    assert_ne!(script(&f, &policy, "echo x>> src\\a.txt"), 0);
    assert_ne!(script(&f, &policy, "type .env"), 0);
    assert!(!f.workspace.join("new.txt").exists());
    assert_eq!(
        fs::read_to_string(f.workspace.join("src/a.txt")).unwrap(),
        "hello"
    );
}

#[test]
fn no_network_and_no_loopback() {
    let f = fixture("network");
    let policy = auto(&f);
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let port = listener.local_addr().unwrap().port();
    let curl = PathBuf::from(std::env::var_os("SystemRoot").unwrap())
        .join("System32")
        .join("curl.exe");
    let local = format!("http://127.0.0.1:{port}/");
    assert_ne!(run(&f, &policy, &curl, &["-s", "-m", "5", &local]), 0);
    assert!(
        listener.accept().is_err(),
        "the sandbox reached a loopback listener"
    );
    assert_ne!(
        run(
            &f,
            &policy,
            &curl,
            &["-s", "-m", "10", "https://example.com/"]
        ),
        0
    );
    // The same requests work outside the sandbox, so the network was there.
    let status = Command::new(&curl)
        .args(["-s", "-m", "10", "-o", "NUL", "https://example.com/"])
        .status()
        .unwrap();
    assert!(
        status.success(),
        "the runner has no network; the denial proves nothing"
    );
    let _ = Command::new(&curl).args(["-s", "-m", "2", &local]).output();
    listener.set_nonblocking(false).unwrap();
    assert!(listener.accept().is_ok());
}

#[test]
fn git_bash_and_node_run_inside() {
    let f = fixture("tools");
    let mut policy = auto(&f);
    let bash = PathBuf::from(r"C:\Program Files\Git\usr\bin\bash.exe");
    if bash.is_file() {
        let code = run(
            &f,
            &policy,
            &bash,
            &[
                "--noprofile",
                "--norc",
                "-c",
                "echo ok > bash.txt && cat src/a.txt && ! cat .env",
            ],
        );
        assert_eq!(code, 0, "Git Bash did not run in the sandbox");
        assert_eq!(
            fs::read_to_string(f.workspace.join("bash.txt")).unwrap(),
            "ok\n"
        );
    }
    if let Some(node) = std::env::var_os("HEXBOT_WINDOWS_NODE") {
        // A copy the standard user owns, as the installed runtime is.
        let tools = f.home.join("runtime/native/test");
        fs::create_dir_all(&tools).unwrap();
        fs::copy(&node, tools.join("node.exe")).unwrap();
        policy.readable.push(tools.clone());
        let write = "require('fs').writeFileSync('node.txt','x')";
        assert_eq!(run(&f, &policy, &tools.join("node.exe"), &["-e", write]), 0);
        assert!(f.workspace.join("node.txt").is_file());
        let read = format!(
            "require('fs').readFileSync({:?})",
            f.home.join("connect.json").to_string_lossy()
        );
        assert_ne!(run(&f, &policy, &tools.join("node.exe"), &["-e", &read]), 0);
        let write = format!(
            "require('fs').writeFileSync({:?},'x')",
            tools.join("planted").to_string_lossy()
        );
        assert_ne!(
            run(&f, &policy, &tools.join("node.exe"), &["-e", &write]),
            0
        );
    }
}

fn hexbot() -> PathBuf {
    std::env::var_os("HEXBOT_WINDOWS_HEXBOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_BIN_EXE_hexbot")))
}

fn helper(f: &Fixture, policy: &Policy, script: &str) -> Command {
    let encoded =
        base64::engine::general_purpose::STANDARD.encode(serde_json::to_vec(policy).unwrap());
    let mut command = Command::new(hexbot());
    command
        .env("HEXBOT_HOME", &f.home)
        .current_dir(&f.workspace)
        .args(["sandbox", "exec", &encoded, "--"])
        .arg(cmd())
        .args(["/d", "/c", script]);
    command
}

#[test]
fn the_helper_runs_a_command_and_its_tree_ends_with_it() {
    let f = fixture("helper");
    let policy = auto(&f);
    let output = helper(
        &f,
        &policy,
        "echo from-sandbox && echo x> helper.txt && exit 7",
    )
    .output()
    .unwrap();
    assert_eq!(output.status.code(), Some(7));
    assert!(String::from_utf8_lossy(&output.stdout).contains("from-sandbox"));
    assert!(f.workspace.join("helper.txt").is_file());
    // A background grandchild keeps writing until the helper is killed.
    let mut child = helper(
        &f,
        &policy,
        "start /b cmd /d /c for /l %i in (0,0,1) do @echo x>> beat & for /l %j in (0,0,1) do @rem",
    )
    .stdout(Stdio::piped())
    .spawn()
    .unwrap();
    let beat = f.workspace.join("beat");
    let deadline = Instant::now() + Duration::from_secs(60);
    while !beat.is_file() {
        assert!(Instant::now() < deadline, "the grandchild never started");
        std::thread::sleep(Duration::from_millis(100));
    }
    child.kill().unwrap();
    child.wait().unwrap();
    let mut rest = String::new();
    let _ = child.stdout.take().unwrap().read_to_string(&mut rest);
    let settled = fs::metadata(&beat).unwrap().len();
    std::thread::sleep(Duration::from_secs(2));
    assert_eq!(
        fs::metadata(&beat).unwrap().len(),
        settled,
        "the tree outlived its helper"
    );
}

#[test]
fn reset_removes_hexbot_entries_and_keeps_every_other_one() {
    let f = fixture("reset");
    let watched = [
        f.workspace.clone(),
        f.workspace.join("src/a.txt"),
        f.workspace.join(".git"),
        f.workspace.join(".git/config"),
        f.workspace.join(".env"),
        f.outside.join("id_ed25519"),
    ];
    let before: Vec<String> = watched.iter().map(|p| icacls(p)).collect();
    assert_eq!(script(&f, &auto(&f), "echo x> new.txt"), 0);
    assert!(
        icacls(&f.workspace).contains("S-1-15-2-"),
        "the workspace was never granted"
    );
    assert!(icacls(&f.workspace.join(".env")).contains("S-1-15-2-"));
    sandbox::reset(&f.home).unwrap();
    let after: Vec<String> = watched.iter().map(|p| icacls(p)).collect();
    assert_eq!(after, before);
    let journal = fs::read_to_string(f.home.join("runtime/sandbox/grants.json")).unwrap();
    assert!(journal.contains("\"roots\": []"), "{journal}");
}

#[test]
fn quoting_matches_the_c_runtime() {
    let cases = [
        ("plain", "plain"),
        ("with space", "\"with space\""),
        ("", "\"\""),
        ("a\"b", "\"a\\\"b\""),
        ("trailing\\ space\\", "\"trailing\\ space\\\\\""),
    ];
    for (input, expected) in cases {
        let quoted = String::from_utf16(&sandbox::quote(input.as_ref())).unwrap();
        assert_eq!(quoted, expected, "{input:?}");
    }
}
