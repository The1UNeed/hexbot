#![cfg(windows)]
//! Exercise the actual generated launchers with Windows PowerShell 5.1.
use hexbot_core::{system_service, windows_cli};
use serde_json::json;
use std::os::windows::process::CommandExt;
use std::{fs, path::Path, process::Command};

fn powershell(script: &str) -> std::process::Output {
    Command::new(
        hexbot_core::windows_paths::system_program("WindowsPowerShell/v1.0/powershell.exe")
            .unwrap(),
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
        r#"public class Probe {{ public static int Main(string[] args) {{ System.IO.File.WriteAllText(@"{}", System.String.Join("\n", args)); return 17; }} }}"#,
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
                            hexbot_core::windows_paths::system_program("cmd.exe").unwrap(),
                            vec!["/D", "/S", "/C"],
                        ),
                        (
                            hexbot_core::windows_paths::system_program(
                                "WindowsPowerShell/v1.0/powershell.exe",
                            )
                            .unwrap(),
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
                        let mut command = Command::new(&program);
                        command.args(&arguments).env("PATH", &path);
                        // cmd.exe has its own command-line grammar. This is a
                        // fixed trusted command, with no interpolated paths/args.
                        if program.file_name().unwrap() == "cmd.exe" {
                            command.raw_arg("hexbot version");
                        }
                        eprintln!(
                            "shell probe program={program:?} args={arguments:?} raw_cmd=hexbot version home={alias:?} selected={selected:?}"
                        );
                        let output = command.output().unwrap();
                        eprintln!(
                            "shell probe status={} stdout={} stderr={}",
                            output.status,
                            String::from_utf8_lossy(&output.stdout),
                            String::from_utf8_lossy(&output.stderr)
                        );
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

#[test]
#[ignore = "changes PATH only on an explicitly disposable native CI user"]
fn user_path_registration_preserves_existing_entries_and_removes_only_its_own() {
    assert_eq!(
        std::env::var("HEXBOT_WINDOWS_PATH_PROBE").as_deref(),
        Ok("1")
    );
    assert_ne!(std::env::var("HEXBOT_CLI_NO_PATH").as_deref(), Ok("1"));
    let query = r#"[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); $k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment'); try { @{value=[string]$k.GetValue('Path','',[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames); exists=($k.GetValueNames() -contains 'Path'); kind=$(if ($k.GetValueNames() -contains 'Path') { [int]$k.GetValueKind('Path') } else { 2 })} | ConvertTo-Json -Compress } finally { $k.Dispose() }"#;
    let output = powershell(query);
    assert!(output.status.success());
    let before: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    struct Restore(serde_json::Value);
    impl Drop for Restore {
        fn drop(&mut self) {
            let text = self.0.to_string().replace('\'', "''");
            let output = powershell(&format!(
                "$v = '{text}' | ConvertFrom-Json; $k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment'); try {{ if ($v.exists) {{ $k.SetValue('Path', [string]$v.value, [Microsoft.Win32.RegistryValueKind][int]$v.kind) }} else {{ $k.DeleteValue('Path', $false) }} }} finally {{ $k.Dispose() }}"
            ));
            assert!(output.status.success());
        }
    }
    let _restore = Restore(before.clone());
    let root = tempfile::tempdir().unwrap();
    let home = root.path().join("state");
    fs::create_dir(&home).unwrap();
    let bin = root.path().join("Jos\u{e9} CLI with spaces");
    let cli =
        windows_cli::install(Path::new(env!("CARGO_BIN_EXE_hexbot-cli")), &home, &bin).unwrap();
    windows_cli::register_path(&cli).unwrap();
    let added: serde_json::Value = serde_json::from_slice(&powershell(query).stdout).unwrap();
    assert!(
        added["value"]
            .as_str()
            .unwrap()
            .split(';')
            .any(|p| p == bin.to_str().unwrap())
    );
    windows_cli::register_path(&cli).unwrap();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&powershell(query).stdout).unwrap(),
        added
    );
    windows_cli::remove(&cli, &home).unwrap();
    let after: serde_json::Value = serde_json::from_slice(&powershell(query).stdout).unwrap();
    assert_eq!(after["value"], before["value"]);
    if before["exists"] == true {
        assert_eq!(after["kind"], before["kind"]);
    }
}

#[test]
#[ignore = "requires an isolated Windows CI user with no existing Hexbot task"]
fn interrupted_task_install_uninstalls_owned_files_when_the_task_is_absent() {
    assert_eq!(
        std::env::var("HEXBOT_WINDOWS_SERVICE_PROBE").as_deref(),
        Ok("1")
    );
    let absent = powershell(
        "$s=New-Object -ComObject 'Schedule.Service'; $s.Connect(); $tasks=@($s.GetFolder('\\').GetTasks(0) | Where-Object {$_.Name -like 'Hexbot-daemon-*'}); if ($tasks.Count) { throw 'Expected an isolated user with no Hexbot task' }",
    );
    assert!(
        absent.status.success(),
        "{}",
        String::from_utf8_lossy(&absent.stderr)
    );
    let root = tempfile::tempdir().unwrap();
    let home = root.path().join("Jos\u{e9} state");
    fs::create_dir_all(&home).unwrap();
    let file = root.path().join("AppData/Local/Hexbot/daemon.ps1");
    system_service::write_owned_script(&file, &home, true).unwrap();
    fs::write(file.with_extension("xml"), "interrupted task creation").unwrap();
    let run = || {
        Command::new(env!("CARGO_BIN_EXE_hexbot"))
            .args(["service", "uninstall"])
            .env("HEXBOT_HOME", &home)
            .env("HEXBOT_SERVICE_ROOT", root.path())
            .env_remove("HEXBOT_SERVICE_NO_LOAD")
            .output()
            .unwrap()
    };
    let output = run();
    assert!(
        output.status.success(),
        "status={} stderr={}",
        output.status,
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(!file.exists());
    assert!(!file.with_extension("xml").exists());
    // An unrelated script is never removed even when the named task is absent.
    fs::write(&file, "foreign script").unwrap();
    let output = run();
    assert!(!output.status.success());
    assert_eq!(fs::read_to_string(file).unwrap(), "foreign script");
}
