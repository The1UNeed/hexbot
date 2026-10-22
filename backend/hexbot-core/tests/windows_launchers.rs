#![cfg(windows)]
//! Exercise the actual generated launchers with Windows PowerShell 5.1.
use hexbot_core::{system_service, windows_cli};
use serde_json::json;
use std::{fs, path::Path, process::Command};

fn powershell(script: &str) -> std::process::Output {
    Command::new(
        Path::new(&std::env::var_os("SystemRoot").expect("Windows system root"))
            .join("System32/WindowsPowerShell/v1.0/powershell.exe"),
    )
    .args(["-NoProfile", "-NonInteractive", "-Command", script])
    .output()
    .unwrap()
}
fn quote(path: &Path) -> String {
    format!("'{}'", path.display().to_string().replace('\'', "''"))
}

#[test]
fn launchers_resolve_unicode_and_junctions_before_executing() {
    let root = tempfile::tempdir().unwrap();
    let home = root.path().join("Jos\u{e9} state");
    let native = home.join("runtime/native");
    let inside = native.join("good");
    let outside = root.path().join("outside");
    for dir in [&inside, &outside, &home.join("logs")] {
        fs::create_dir_all(dir).unwrap();
    }
    let fixture = outside.join("hexbot.exe");
    let marker = root.path().join("executed.txt");
    let source = format!(
        r#"public class Probe {{ public static int Main(string[] args) {{ System.IO.File.WriteAllText(@"{}", String.Join("\n", args)); return 17; }} }}"#,
        marker.display().to_string().replace('"', "\"\"")
    );
    let compile = powershell(&format!(
        "Add-Type -TypeDefinition '{}' -OutputAssembly {} -OutputType ConsoleApplication",
        source.replace('\'', "''"),
        quote(&fixture)
    ));
    assert!(
        compile.status.success(),
        "{}",
        String::from_utf8_lossy(&compile.stderr)
    );
    fs::copy(&fixture, inside.join("hexbot.exe")).unwrap();
    let alias = root.path().join("home junction");
    let linked = native.join("linked-build");
    for (link, target) in [(&alias, &home), (&linked, &outside)] {
        let output = powershell(&format!(
            "New-Item -ItemType Junction -Path {} -Target {} | Out-Null",
            quote(link),
            quote(target)
        ));
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    let bin = root.path().join("cli-bin");
    let forwarder =
        windows_cli::install(Path::new(env!("CARGO_BIN_EXE_hexbot-cli")), &alias, &bin).unwrap();
    for service in [false, true] {
        let launcher = root
            .path()
            .join(if service { "task.ps1" } else { "cli.ps1" });
        // The generated script has a lexical junction home; selection contains
        // its canonical Unicode target. Both canonical operands must agree.
        system_service::write_owned_script(&launcher, &alias, service).unwrap();
        for (selected, allowed) in [
            (inside.join("hexbot.exe"), true),
            (linked.join("hexbot.exe"), false),
        ] {
            fs::write(home.join("runtime/native-current.json"), json!({"executable":if allowed { selected.canonicalize().unwrap() } else { selected }}).to_string()).unwrap();
            if !service {
                let output = Command::new(&forwarder)
                    .args(["space arg", "a&b", "quote\"arg", "%PATH%", "!"])
                    .output()
                    .unwrap();
                assert!(!output.status.success());
                assert_eq!(marker.exists(), allowed, "native CLI containment");
                if allowed {
                    assert_eq!(
                        fs::read_to_string(&marker).unwrap(),
                        "space arg\na&b\nquote\"arg\n%PATH%\n!"
                    );
                    fs::remove_file(&marker).unwrap();
                    let path = format!(
                        "{};{}",
                        bin.display(),
                        std::env::var("PATH").unwrap_or_default()
                    );
                    for (program, arguments) in [
                        (
                            Path::new(&std::env::var_os("SystemRoot").unwrap())
                                .join("System32/cmd.exe"),
                            vec!["/D", "/S", "/C", "hexbot version"],
                        ),
                        (
                            Path::new(&std::env::var_os("SystemRoot").unwrap())
                                .join("System32/WindowsPowerShell/v1.0/powershell.exe"),
                            vec![
                                "-NoProfile",
                                "-NonInteractive",
                                "-ExecutionPolicy",
                                "Restricted",
                                "-Command",
                                "hexbot version; exit $LASTEXITCODE",
                            ],
                        ),
                    ] {
                        let output = Command::new(program)
                            .args(arguments)
                            .env("PATH", &path)
                            .output()
                            .unwrap();
                        assert_eq!(
                            output.status.code(),
                            Some(17),
                            "{}",
                            String::from_utf8_lossy(&output.stderr)
                        );
                        assert_eq!(fs::read_to_string(&marker).unwrap(), "version");
                        fs::remove_file(&marker).unwrap();
                    }
                }
            }
            let output = powershell(&format!(
                "& {} version; exit $LASTEXITCODE",
                quote(&launcher)
            ));
            assert!(!output.status.success()); // fixture returns 17; rejected selection returns 1
            assert_eq!(
                marker.exists(),
                allowed,
                "service={service}, stderr={}",
                String::from_utf8_lossy(&output.stderr)
            );
            if allowed {
                fs::remove_file(&marker).unwrap();
            }
        }
    }
    // Junctions are directory links, never recursively clean their targets.
    fs::remove_dir(&linked).unwrap();
    fs::remove_dir(&alias).unwrap();
}

#[tokio::test]
async fn logs_follow_both_streams_after_append_creation_and_rotation() {
    use tokio::io::{AsyncBufReadExt, BufReader};
    let root = tempfile::tempdir().unwrap();
    let home = root.path().join("state");
    fs::create_dir_all(home.join("logs")).unwrap();
    fs::write(home.join("logs/service.log"), "ready\n").unwrap();
    let mut child = tokio::process::Command::new(env!("CARGO_BIN_EXE_hexbot"))
        .args(["service", "logs", "-f"])
        .env("HEXBOT_HOME", &home)
        .env("HOME", root.path())
        .env("USERPROFILE", root.path())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    async fn next(lines: &mut tokio::io::Lines<BufReader<tokio::process::ChildStdout>>) -> String {
        tokio::time::timeout(std::time::Duration::from_secs(15), lines.next_line())
            .await
            .unwrap()
            .unwrap()
            .expect("follower exited")
    }
    assert_eq!(next(&mut lines).await, "ready"); // observable readiness, no sleeps
    fs::write(home.join("logs/service-error.log"), "new stderr\n").unwrap();
    assert_eq!(next(&mut lines).await, "new stderr");
    fs::rename(home.join("logs/service.log"), home.join("logs/service.old")).unwrap();
    fs::write(home.join("logs/service.log"), "rotated stdout\n").unwrap();
    assert_eq!(next(&mut lines).await, "rotated stdout");
    use std::io::Write;
    fs::OpenOptions::new()
        .append(true)
        .open(home.join("logs/service-error.log"))
        .unwrap()
        .write_all(b"appended stderr\n")
        .unwrap();
    assert_eq!(next(&mut lines).await, "appended stderr");
    child.kill().await.unwrap();
    child.wait().await.unwrap();
    let snapshot = Command::new(env!("CARGO_BIN_EXE_hexbot"))
        .args(["service", "logs"])
        .env("HEXBOT_HOME", &home)
        .output()
        .unwrap();
    assert!(snapshot.status.success());
    let text = String::from_utf8(snapshot.stdout).unwrap();
    assert!(text.contains("rotated stdout"));
    assert!(text.contains("appended stderr"));
    assert!(
        !Command::new(env!("CARGO_BIN_EXE_hexbot"))
            .args(["service", "logs", "--wrong"])
            .env("HEXBOT_HOME", &home)
            .status()
            .unwrap()
            .success()
    );
}
