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
    process::{Command, Output, Stdio},
    time::{Duration, Instant},
};

struct Fixture {
    root: tempfile::TempDir,
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
        root,
        home,
        workspace,
        outside,
    }
}

fn system(program: &str) -> PathBuf {
    PathBuf::from(std::env::var_os("SystemRoot").unwrap())
        .join("System32")
        .join(program)
}

fn cmd() -> PathBuf {
    system("cmd.exe")
}

fn auto(f: &Fixture) -> Policy {
    Policy {
        home: f.home.clone(),
        access: Some(Access::Workspace),
        writable: vec![f.workspace.clone()],
        deny_write: vec![f.workspace.join(".git")],
        deny_all: vec![f.workspace.join(".env")],
        ..Policy::default()
    }
}

fn run_in(policy: &Policy, directory: &Path, program: &Path, arguments: &[&str]) -> u32 {
    let container = sandbox::prepare(policy).unwrap();
    let env = sandbox::environment(&container, std::env::vars_os());
    let arguments: Vec<OsString> = arguments.iter().map(OsString::from).collect();
    let child = sandbox::spawn(
        &container.sid,
        program,
        &arguments,
        Some(directory),
        &env,
        Some(64),
    )
    .unwrap();
    child.wait().unwrap()
}

fn run(f: &Fixture, policy: &Policy, program: &Path, arguments: &[&str]) -> u32 {
    run_in(policy, &f.workspace, program, arguments)
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

/// Whether the AppContainer profile behind `sid` is registered for this user.
fn registered(sid: &str) -> bool {
    Command::new(system("reg.exe"))
        .args([
            "query",
            &format!(
                r"HKCU\Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppContainer\Mappings\{sid}"
            ),
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .unwrap()
        .success()
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
        home: f.home.clone(),
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

/// `hexbot sandbox exec`, which finds the home in the policy alone.
fn helper_with(f: &Fixture, policy: &Policy, program: &Path, arguments: &[&str]) -> Command {
    let encoded =
        base64::engine::general_purpose::STANDARD.encode(serde_json::to_vec(policy).unwrap());
    let mut command = Command::new(hexbot());
    command
        .current_dir(&f.workspace)
        .args(["sandbox", "exec", &encoded, "--"])
        .arg(program)
        .args(arguments);
    command
}

fn helper(f: &Fixture, policy: &Policy, script: &str) -> Command {
    helper_with(f, policy, &cmd(), &["/d", "/c", script])
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
    assert!(
        journal.contains("\"roots\": []") && journal.contains("\"profiles\": []"),
        "{journal}"
    );
}

#[test]
fn quoting_matches_the_c_runtime() {
    let cases = [
        ("plain", "plain"),
        ("with space", "\"with space\""),
        ("", "\"\""),
        ("a\"b", "\"a\\\"b\""),
        ("trailing\\ space\\", "\"trailing\\ space\\\\\""),
        ("*.txt", "\"*.txt\""),
        ("a?b", "\"a?b\""),
        ("[ab]", "\"[ab]\""),
        ("{a,b}", "\"{a,b}\""),
        ("ünïcødé", "ünïcødé"),
    ];
    for (input, expected) in cases {
        let quoted = String::from_utf16(&sandbox::quote(input.as_ref())).unwrap();
        assert_eq!(quoted, expected, "{input:?}");
    }
}

/// The command never ran: 126 and one line on stderr.
fn assert_not_run(output: &Output) {
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert_eq!(output.status.code(), Some(126), "{stderr}");
    assert_eq!(stderr.lines().count(), 1, "{stderr}");
    assert!(!stderr.trim().is_empty());
}

#[test]
fn each_policy_gets_its_own_container() {
    let f = fixture("isolation");
    let other = f.root.path().join("other");
    fs::create_dir_all(&other).unwrap();
    fs::write(other.join("b.txt"), "b").unwrap();
    let a = auto(&f);
    let b = Policy {
        writable: vec![other.clone()],
        deny_write: vec![],
        deny_all: vec![],
        ..auto(&f)
    };
    let first = sandbox::prepare(&a).unwrap();
    let second = sandbox::prepare(&b).unwrap();
    assert_ne!(first.profile, second.profile);
    assert_ne!(first.sid.text().unwrap(), second.sid.text().unwrap());
    assert_ne!(first.private, second.private);
    assert_eq!(
        sandbox::prepare(&a).unwrap().profile,
        first.profile,
        "a policy keeps its container"
    );
    // B's container writes B. A's, granted the workspace alone, never reaches
    // B or B's private folders, though B's grants are still in place.
    let planted = other.join("planted");
    assert_eq!(
        run_in(&b, &other, &cmd(), &["/d", "/c", "echo x> planted"]),
        0
    );
    fs::remove_file(&planted).unwrap();
    assert_ne!(script(&f, &a, &format!("echo x> {}", planted.display())), 0);
    assert!(!planted.exists());
    assert_ne!(
        script(&f, &a, &format!("type {}", other.join("b.txt").display())),
        0
    );
    assert_ne!(
        script(&f, &a, &format!("dir {}", second.private.display())),
        0
    );
}

#[test]
fn a_deny_walk_that_misses_an_entry_stops_the_command() {
    let f = fixture("deny-walk");
    let locked = f.workspace.join(".git").join("locked");
    fs::write(&locked, "x").unwrap();
    // OWNER RIGHTS replaces the owner's implicit rights: Hexbot cannot change
    // this DACL, but the user can still delete the file.
    let status = Command::new(system("icacls.exe"))
        .arg(&locked)
        .args(["/inheritance:r", "/grant:r", "*S-1-3-4:(R,D)"])
        .stdout(Stdio::null())
        .status()
        .unwrap();
    assert!(status.success(), "cannot lock the fixture");
    let policy = auto(&f);
    let error = sandbox::prepare(&policy)
        .err()
        .expect("the deny walk missed an entry");
    assert!(error.to_string().contains("Could not protect"), "{error}");
    assert_not_run(&helper(&f, &policy, "echo x> ran.txt").output().unwrap());
    assert!(!f.workspace.join("ran.txt").exists());
    // With the entry gone, reset revokes everything when the fixture drops.
    fs::remove_file(&locked).unwrap();
}

#[test]
fn the_helper_takes_its_home_from_the_policy() {
    let f = fixture("home");
    let policy = auto(&f);
    let check = "if defined HEXBOT_HOME (exit 3) else if defined HERMES_HOME (exit 4) else (echo x> home.txt)";
    // Callers clear the environment; the helper still finds the home.
    let output = helper(&f, &policy, check).env_clear().output().unwrap();
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(f.workspace.join("home.txt").is_file());
    assert!(f.home.join("runtime/sandbox/grants.json").is_file());
    // Another home in the environment is neither used nor passed on.
    fs::remove_file(f.workspace.join("home.txt")).unwrap();
    let decoy = tempfile::tempdir().unwrap();
    let output = helper(&f, &policy, check)
        .env("HEXBOT_HOME", decoy.path())
        .env("HERMES_HOME", decoy.path())
        .output()
        .unwrap();
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(f.workspace.join("home.txt").is_file());
    assert!(!decoy.path().join("runtime").exists());
}

#[test]
fn roots_that_reach_the_profile_the_home_or_a_store_are_refused_before_any_change() {
    let f = fixture("refusals");
    let profile = PathBuf::from(std::env::var_os("USERPROFILE").unwrap());
    let journal = f.home.join("runtime/sandbox/grants.json");
    for folder in [
        f.home.join("runtime/native/test"),
        f.home.join("runtime/sandbox"),
        profile.join(".aws/sub"),
        profile.join(".ssh"),
    ] {
        fs::create_dir_all(folder).unwrap();
    }
    let status = Command::new(cmd())
        .current_dir(&f.workspace)
        .args(["/d", "/c", "mklink", "/J", "profile-link"])
        .arg(&profile)
        .stdout(Stdio::null())
        .status()
        .unwrap();
    assert!(status.success(), "cannot create the junction fixture");
    let base = Policy {
        home: f.home.clone(),
        access: Some(Access::Workspace),
        ..Policy::default()
    };
    let writable = |path: PathBuf| Policy {
        writable: vec![path],
        ..base.clone()
    };
    let readable = |path: PathBuf| Policy {
        readable: vec![path],
        ..base.clone()
    };
    for policy in [
        writable(profile.clone()),
        readable(profile.parent().unwrap().to_owned()),
        readable(f.workspace.join("profile-link")),
        readable(profile.join("AppData")),
        writable(f.home.clone()),
        readable(f.root.path().to_owned()),
        readable(f.home.join("runtime")),
        readable(f.home.join("runtime/native")),
        writable(f.home.join("runtime/native/test")),
        readable(f.home.join("runtime/sandbox")),
        readable(profile.join(".ssh")),
        writable(profile.join(".aws/sub")),
        writable(PathBuf::from(r"\\localhost\C$\Windows")),
        readable(PathBuf::from(r"\\.\C:\Windows")),
        writable(f.workspace.join("src").join("a.txt:hidden")),
        writable(PathBuf::from("relative")),
        Policy {
            home: PathBuf::new(),
            ..writable(f.workspace.clone())
        },
    ] {
        let error = sandbox::prepare(&policy)
            .err()
            .unwrap_or_else(|| panic!("{policy:?} was granted"));
        assert_eq!(
            error.kind(),
            std::io::ErrorKind::InvalidInput,
            "{policy:?}: {error}"
        );
        assert!(!journal.exists(), "{policy:?} changed the journal");
    }
    // A program folder inside the runtime may still be read.
    sandbox::prepare(&Policy {
        readable: vec![f.home.join("runtime/native/test")],
        ..auto(&f)
    })
    .unwrap();
}

#[test]
fn a_command_that_cannot_run_exits_126_with_one_line() {
    let f = fixture("not-run");
    assert_not_run(
        &Command::new(hexbot())
            .args(["sandbox", "exec"])
            .output()
            .unwrap(),
    );
    assert_not_run(
        &Command::new(hexbot())
            .current_dir(&f.workspace)
            .args(["sandbox", "exec", "not a policy", "--"])
            .arg(cmd())
            .args(["/d", "/c", "echo x> ran.txt"])
            .output()
            .unwrap(),
    );
    let refused = Policy {
        writable: vec![PathBuf::from(std::env::var_os("USERPROFILE").unwrap())],
        ..auto(&f)
    };
    assert_not_run(&helper(&f, &refused, "echo x> ran.txt").output().unwrap());
    assert_not_run(
        &helper_with(
            &f,
            &auto(&f),
            Path::new("cmd.exe"),
            &["/d", "/c", "echo x> ran.txt"],
        )
        .output()
        .unwrap(),
    );
    assert_not_run(
        &helper_with(&f, &auto(&f), &f.workspace.join("missing.exe"), &[])
            .output()
            .unwrap(),
    );
    assert!(!f.workspace.join("ran.txt").exists());
}

#[test]
fn reset_deletes_every_profile_it_made() {
    let f = fixture("profiles");
    let other = f.root.path().join("other");
    fs::create_dir_all(&other).unwrap();
    let first = sandbox::prepare(&auto(&f)).unwrap();
    let second = sandbox::prepare(&Policy {
        access: Some(Access::Read),
        writable: vec![],
        readable: vec![other],
        ..auto(&f)
    })
    .unwrap();
    let sids = [first.sid.text().unwrap(), second.sid.text().unwrap()];
    assert!(
        sids.iter().all(|sid| registered(sid)),
        "the profiles were never registered"
    );
    let journal: serde_json::Value =
        serde_json::from_slice(&fs::read(f.home.join("runtime/sandbox/grants.json")).unwrap())
            .unwrap();
    assert_eq!(
        journal["profiles"],
        serde_json::json!([first.profile, second.profile])
    );
    assert!(journal["roots"].as_array().unwrap().iter().all(|root| {
        root["profile"] == first.profile.as_str() || root["profile"] == second.profile.as_str()
    }));
    drop((first, second));
    sandbox::reset(&f.home).unwrap();
    assert!(
        sids.iter().all(|sid| !registered(sid)),
        "reset left a profile"
    );
    let journal = fs::read_to_string(f.home.join("runtime/sandbox/grants.json")).unwrap();
    assert!(
        journal.contains("\"roots\": []") && journal.contains("\"profiles\": []"),
        "{journal}"
    );
}

#[test]
fn the_probe_runs_a_contained_command_and_leaves_no_profile() {
    sandbox::probe().unwrap();
    assert!(sandbox::probe_available());
    let sid = sandbox::profile_sid(sandbox::PROBE_PROFILE)
        .unwrap()
        .text()
        .unwrap();
    assert!(!registered(&sid), "the probe left its profile");
}

#[test]
fn arguments_reach_programs_unchanged() {
    let f = fixture("arguments");
    let cases = [
        "plain",
        "with space",
        "",
        "a\"b",
        "back\\slash\\",
        "\\\"",
        "ünïcødé 名前",
        "*",
        "*.txt",
        "a?b",
        "[ab]",
        "{a,b}",
        "~",
        "it's",
        "tab\there",
    ];
    if let Some(node) = std::env::var_os("HEXBOT_WINDOWS_NODE") {
        let tools = f.home.join("runtime/native/test");
        fs::create_dir_all(&tools).unwrap();
        fs::copy(&node, tools.join("node.exe")).unwrap();
        let policy = Policy {
            readable: vec![tools.clone()],
            ..auto(&f)
        };
        let mut arguments = vec![
            "-e",
            "process.stdout.write(JSON.stringify(process.argv.slice(1)))",
        ];
        arguments.extend(cases);
        let output = helper_with(&f, &policy, &tools.join("node.exe"), &arguments)
            .output()
            .unwrap();
        assert_eq!(
            output.status.code(),
            Some(0),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let seen: Vec<String> = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(seen, cases);
    }
    let bash = PathBuf::from(r"C:\Program Files\Git\usr\bin\bash.exe");
    if bash.is_file() {
        // MSYS expands none of these once quoted. It reads backslashes inside
        // quotes its own way, so these cases have none.
        let msys = [
            "with space",
            "*",
            "*.txt",
            "a?b",
            "[ab]",
            "{a,b}",
            "~",
            "it's",
            "a\"b",
            "tab\there",
        ];
        let mut arguments = vec![
            "--noprofile",
            "--norc",
            "-c",
            "printf '<%s>\\n' \"$@\"",
            "bash",
        ];
        arguments.extend(msys);
        let output = helper_with(&f, &auto(&f), &bash, &arguments)
            .output()
            .unwrap();
        assert_eq!(
            output.status.code(),
            Some(0),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let expected: String = msys.iter().map(|case| format!("<{case}>\n")).collect();
        assert_eq!(String::from_utf8_lossy(&output.stdout), expected);
    }
}
