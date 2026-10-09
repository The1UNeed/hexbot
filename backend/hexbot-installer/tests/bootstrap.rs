mod common;
use hexbot_installer::Target;
use sha2::{Digest, Sha256};
use std::{fs, process::Command};

#[test]
fn bootstrap_checks_the_companion_index_and_forwards_arguments() {
    let root = tempfile::tempdir().unwrap();
    let server = common::Server::new(root.path());
    fs::create_dir(root.path().join("install")).unwrap();
    let bytes = b"#!/bin/sh\nprintf '<%s>\\n' \"$@\"\n";
    fs::write(root.path().join("installer"), bytes).unwrap();
    let line = format!(
        "{} {:x} {}/installer\n",
        Target::detect().unwrap(),
        Sha256::digest(bytes),
        server.base
    );
    fs::write(root.path().join("install/nightly.txt"), &line).unwrap();
    let script =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../apps/site/public/install.sh");
    let run = || {
        Command::new("sh")
            .arg(&script)
            .args(["--client", "--yes", "argument with spaces"])
            .env("HEXBOT_UPDATE_URL", &server.base)
            .env_remove("HEXBOT_TRACK")
            .env("HEXBOT_INSTALL_TMPDIR", root.path())
            .stdin(std::process::Stdio::null())
            .output()
            .unwrap()
    };
    let output = common::success(run());
    assert_eq!(output, "<--client>\n<--yes>\n<argument with spaces>\n");
    assert!(
        server
            .requests
            .lock()
            .unwrap()
            .iter()
            .any(|p| p == "/install/nightly.txt")
    );
    assert!(!fs::read_dir(root.path()).unwrap().flatten().any(|p| {
        p.file_name()
            .to_string_lossy()
            .starts_with("hexbot-install.")
    }));
    fs::write(root.path().join("install/stable.json"), "{}").unwrap();
    fs::write(root.path().join("install/stable.txt"), &line).unwrap();
    common::success(run());
    assert!(
        server
            .requests
            .lock()
            .unwrap()
            .iter()
            .any(|p| p == "/install/stable.txt")
    );
    fs::write(root.path().join("installer"), "tampered").unwrap();
    let output = run();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("checksum does not match"));
    fs::write(
        root.path().join("install/stable.txt"),
        format!("{line}{line}"),
    )
    .unwrap();
    let before = server
        .requests
        .lock()
        .unwrap()
        .iter()
        .filter(|p| *p == "/installer")
        .count();
    assert!(!run().status.success());
    let after = server
        .requests
        .lock()
        .unwrap()
        .iter()
        .filter(|p| *p == "/installer")
        .count();
    assert_eq!(
        before, after,
        "duplicate target rows must not be downloaded"
    );
}

#[test]
fn bootstrap_rejects_foreign_and_prefix_lookalike_installer_urls() {
    let root = tempfile::tempdir().unwrap();
    let server = common::Server::new(root.path());
    fs::create_dir(root.path().join("install")).unwrap();
    for url in [
        "https://elsewhere.test/install".to_string(),
        format!("{}@elsewhere.test/install", server.base),
        format!("{}-elsewhere/install", server.base),
    ] {
        fs::write(
            root.path().join("install/stable.txt"),
            format!("{} {} {url}\n", Target::detect().unwrap(), "a".repeat(64)),
        )
        .unwrap();
        let output = Command::new("sh")
            .arg(
                std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../../apps/site/public/install.sh"),
            )
            .env("HEXBOT_UPDATE_URL", &server.base)
            .env("HEXBOT_TRACK", "stable")
            .env("HEXBOT_INSTALL_TMPDIR", root.path())
            .output()
            .unwrap();
        assert!(!output.status.success());
        assert!(String::from_utf8_lossy(&output.stderr).contains("must be on the update server"));
    }
    assert!(
        server
            .requests
            .lock()
            .unwrap()
            .iter()
            .all(|p| p == "/install/stable.txt")
    );
}

#[test]
fn bootstrap_does_not_fall_back_on_server_or_connection_errors() {
    let root = tempfile::tempdir().unwrap();
    fs::create_dir(root.path().join("install")).unwrap();
    let server = common::Server::new(root.path());
    let base = server.base.clone();
    let run = || {
        Command::new("sh")
            .arg(
                std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../../apps/site/public/install.sh"),
            )
            .env("HEXBOT_UPDATE_URL", &base)
            .env_remove("HEXBOT_TRACK")
            .env("HEXBOT_INSTALL_TMPDIR", root.path())
            .stdin(std::process::Stdio::null())
            .output()
            .unwrap()
    };
    for status in [
        "403 Forbidden",
        "500 Internal Server Error",
        "503 Service Unavailable",
    ] {
        fs::write(root.path().join("install/stable.json.status"), status).unwrap();
        let output = run();
        assert!(!output.status.success());
        assert!(String::from_utf8_lossy(&output.stderr).contains("Check your connection"));
    }
    assert!(
        server
            .requests
            .lock()
            .unwrap()
            .iter()
            .all(|p| p == "/install/stable.json")
    );
    drop(server);
    let output = run();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("Check your connection"));
}

#[test]
fn bootstrap_wget_only_falls_back_on_404() {
    use std::os::unix::fs::symlink;
    let root = tempfile::tempdir().unwrap();
    let bin = root.path().join("bin");
    fs::create_dir(&bin).unwrap();
    // Isolate PATH so curl is absent; all downloads are simulated.
    for command in [
        "mkdir",
        "uname",
        "mktemp",
        "rm",
        "grep",
        "awk",
        "shasum",
        "sha256sum",
    ] {
        let output = Command::new("sh")
            .args(["-c", &format!("command -v {command}")])
            .output()
            .unwrap();
        if output.status.success() {
            symlink(
                String::from_utf8(output.stdout).unwrap().trim(),
                bin.join(command),
            )
            .unwrap();
        }
    }
    common::executable(
        &bin.join("wget"),
        br#"#!/bin/sh
case "$*" in
    *stable.json*) printf '%s\n' "$WGET_ERROR" >&2; exit "$WGET_EXIT" ;;
    *) printf '%s\n' "$*" >> "$REQUESTS"; exit 1 ;;
esac
"#,
    );
    let requests = root.path().join("requests");
    for (exit, error, track) in [
        (0, "", Some("stable")),
        (8, "ERROR 404: Not Found.", Some("nightly")),
        (8, "ERROR 503: Service Unavailable.", None),
        (4, "Unable to resolve host address", None),
        (4, "Connection to 10.0.0.1:404 failed", None),
    ] {
        fs::write(&requests, "").unwrap();
        let output = Command::new("/bin/sh")
            .arg(
                std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../../apps/site/public/install.sh"),
            )
            .env("PATH", &bin)
            .env("HEXBOT_INSTALL_TMPDIR", root.path())
            .env_remove("HEXBOT_TRACK")
            .env("HEXBOT_UPDATE_URL", "https://updates.example.test")
            .env("WGET_ERROR", error)
            .env("WGET_EXIT", exit.to_string())
            .env("REQUESTS", &requests)
            .output()
            .unwrap();
        assert!(!output.status.success());
        let requests = fs::read_to_string(&requests).unwrap();
        if let Some(track) = track {
            assert!(
                requests.contains(&format!("install/{track}.txt")),
                "{output:?}"
            );
        } else {
            assert!(requests.is_empty());
            assert!(String::from_utf8_lossy(&output.stderr).contains("Check your connection"));
        }
    }
}

#[test]
fn bootstrap_executes_from_cache_or_explicit_override_and_cleans_up() {
    let root = tempfile::tempdir().unwrap();
    let server = common::Server::new(root.path());
    fs::create_dir(root.path().join("install")).unwrap();
    let bytes = b"#!/bin/sh\nprintf '%s\\n' \"$0\"\n";
    fs::write(root.path().join("installer"), bytes).unwrap();
    fs::write(
        root.path().join("install/stable.txt"),
        format!(
            "{} {:x} {}/installer\n",
            Target::detect().unwrap(),
            Sha256::digest(bytes),
            server.base
        ),
    )
    .unwrap();
    for mode in ["home", "xdg", "override"] {
        let home = root.path().join("home");
        let xdg = root.path().join("cache with spaces");
        let override_dir = root.path().join("override");
        let mut command = Command::new("sh");
        command
            .arg(
                std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../../apps/site/public/install.sh"),
            )
            .env("HOME", &home)
            .env("TMPDIR", root.path().join("unusable-tmp"))
            .env_remove("XDG_CACHE_HOME")
            .env_remove("HEXBOT_INSTALL_TMPDIR")
            .env("HEXBOT_UPDATE_URL", &server.base)
            .env("HEXBOT_TRACK", "stable");
        let expected = match mode {
            "xdg" => {
                command.env("XDG_CACHE_HOME", &xdg);
                xdg.join("hexbot")
            }
            "override" => {
                command.env("HEXBOT_INSTALL_TMPDIR", &override_dir);
                override_dir
            }
            _ => home.join(".cache/hexbot"),
        };
        let output = common::success(command.output().unwrap());
        assert!(
            std::path::Path::new(output.trim()).starts_with(&expected),
            "{output}"
        );
        assert_eq!(fs::read_dir(expected).unwrap().count(), 0);
    }
}

/// A redirect would let whoever answers it supply both the checksum and the
/// binary, so the bootstrap follows none; and it speaks only HTTPS.
#[test]
fn bootstrap_follows_no_redirects_and_refuses_plain_http() {
    let root = tempfile::tempdir().unwrap();
    let server = common::Server::new(root.path());
    let foreign_root = tempfile::tempdir().unwrap();
    let foreign = common::Server::new(foreign_root.path());
    fs::create_dir(root.path().join("install")).unwrap();
    fs::write(
        root.path().join("install/nightly.txt.redirect"),
        format!("{}/install/nightly.txt", foreign.base),
    )
    .unwrap();
    let script =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../apps/site/public/install.sh");
    let run = |base: &str| {
        Command::new("sh")
            .arg(&script)
            .env("HEXBOT_UPDATE_URL", base)
            .env("HEXBOT_TRACK", "nightly")
            .env("HEXBOT_INSTALL_TMPDIR", root.path())
            .stdin(std::process::Stdio::null())
            .output()
            .unwrap()
    };
    let output = run(&server.base);
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("installer index"));
    assert!(foreign.requests.lock().unwrap().is_empty());
    for base in [
        "http://updates.example.test",
        "https://user@updates.example.test",
    ] {
        let output = run(base);
        assert!(!output.status.success());
        assert!(
            String::from_utf8_lossy(&output.stderr).contains("must be an HTTPS address"),
            "{base}"
        );
    }
}
