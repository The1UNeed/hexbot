#![cfg(windows)]
//! Exercise the actual generated launchers with Windows PowerShell 5.1.
#[path = "../src/windows_paths.rs"]
mod windows_paths;
use hexbot_core::{system_service, windows_cli};
use serde_json::json;
use std::os::windows::process::CommandExt;
use std::{fs, path::Path, process::Command};

fn powershell(script: &str) -> std::process::Output {
    Command::new(windows_paths::system_program("WindowsPowerShell/v1.0/powershell.exe").unwrap())
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .output()
        .unwrap()
}
fn quote(path: &Path) -> String {
    format!("'{}'", path.display().to_string().replace('\'', "''"))
}

#[test]
fn task_principal_ownership_uses_exact_resolved_windows_sids() {
    let output = powershell(&format!(
        r#"{}
$ErrorActionPreference='Stop'
$owner=[Security.Principal.WindowsIdentity]::GetCurrent()
$sid=$owner.User.Value
$account=$owner.Name
foreach($identity in @($sid,$account,[Environment]::UserName)) {{
    $resolved=Resolve-HexbotTaskSid $identity
    if($resolved -cne $sid) {{ throw 'Own SID/account representation did not resolve to the exact owner SID' }}
    [Console]::WriteLine((@{{identity=$identity;resolvedSid=$resolved}}|ConvertTo-Json -Compress))
}}
$foreignSid='S-1-5-18'
if($sid -ceq $foreignSid) {{ throw 'Probe requires a user, not LocalSystem' }}
$foreignName=[Security.Principal.SecurityIdentifier]::new($foreignSid).Translate([Security.Principal.NTAccount]).Value
foreach($identity in @($foreignSid,$foreignName,('Hexbot-no-such-user-'+[Guid]::NewGuid().ToString()),'', 'not a valid SID')) {{
    if((Resolve-HexbotTaskSid $identity) -ceq $sid) {{ throw 'Foreign or unresolvable principal was accepted' }}
}}
if($null -ne (Resolve-HexbotTaskSid ('Hexbot-no-such-user-'+[Guid]::NewGuid().ToString()))) {{ throw 'Unresolvable principal must fail closed' }}
# Run the actual ownership gate with controlled task definitions, without
# needing permission to register a task for another Windows account.
$expectedSid=$sid
$expectedPowerShell=Join-Path ([Environment]::GetFolderPath('System')) 'WindowsPowerShell\v1.0\powershell.exe'
$expectedArguments='-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "C:\fixture\daemon.ps1"'
$expectedOwner='Hexbot owned home: "C:\fixture home"'
$allowLegacy=$false;$operation='state';$taskName='fixture'
$control=[ScriptBlock]::Create(@'
{}
'@)
function New-Object([string]$ComObject) {{
    if($ComObject -cne 'Schedule.Service') {{ throw 'Unexpected fixture COM object' }}
    return $script:fixtureService
}}
foreach($case in @('sid','account','unqualified','foreign','unknown','program','arguments','home','count')) {{
    $action=[pscustomobject]@{{Path=$expectedPowerShell;Arguments=$expectedArguments}}
    $actions=[pscustomobject]@{{Count=1;Entry=$action}}
    $actions|Add-Member ScriptMethod Item {{param($index) $this.Entry}}
    $definition=[pscustomobject]@{{Actions=$actions;Principal=[pscustomobject]@{{UserId=$sid}};RegistrationInfo=[pscustomobject]@{{Description=$expectedOwner}}}}
    $script:fixtureTask=[pscustomobject]@{{Definition=$definition;State=3}}
    $script:fixtureFolder=[pscustomobject]@{{}}
    $script:fixtureFolder|Add-Member ScriptMethod GetTask {{param($name) $script:fixtureTask}}
    $script:fixtureService=[pscustomobject]@{{}}
    $script:fixtureService|Add-Member ScriptMethod Connect {{}}
    $script:fixtureService|Add-Member ScriptMethod GetFolder {{param($path) $script:fixtureFolder}}
    switch($case) {{
        'account' {{$definition.Principal.UserId=$account}}
        'unqualified' {{$definition.Principal.UserId=[Environment]::UserName}}
        'foreign' {{$definition.Principal.UserId=$foreignSid}}
        'unknown' {{$definition.Principal.UserId='Hexbot-no-such-user-'+[Guid]::NewGuid().ToString()}}
        'program' {{$action.Path='C:\foreign\powershell.exe'}}
        'arguments' {{$action.Arguments+=' -foreign'}}
        'home' {{$definition.RegistrationInfo.Description='Hexbot owned home: "C:\another home"'}}
        'count' {{$actions.Count=2}}
    }}
    $accepted=$true
    try {{$result=& $control}} catch {{
        $accepted=$false
        if($_.Exception.Message -notmatch 'another installation|home ownership context') {{throw}}
    }}
    if($accepted -ne ($case -in @('sid','account','unqualified'))) {{throw "Incorrect task ownership result for $case"}}
    if($accepted -and $result -ne 3) {{throw 'Owned task state was not returned'}}
}}
[Console]::WriteLine('SID, qualified and unqualified owner names accepted; foreign and unresolved identities refused')
"#,
        include_str!("../assets/windows-task-identity.ps1"),
        include_str!("../assets/windows-task-control.ps1")
    ));
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    eprintln!("{}", String::from_utf8_lossy(&output.stdout));
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
            fs::write(home.join("runtime/native-current.json"), json!({"executable":if allowed { selected.canonicalize().unwrap() } else { selected.clone() }}).to_string()).unwrap();
            if !service {
                let output = Command::new(&forwarder)
                    .args(["space arg", "a&b", "quote\"arg", "%PATH%", "!"])
                    .output()
                    .unwrap();
                if allowed {
                    assert_eq!(
                        output.status.code(),
                        Some(17),
                        "native CLI stderr={}",
                        String::from_utf8_lossy(&output.stderr)
                    );
                } else {
                    assert!(!output.status.success());
                }
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
                            windows_paths::system_program("cmd.exe").unwrap(),
                            vec!["/D", "/S", "/C"],
                        ),
                        (
                            windows_paths::system_program("WindowsPowerShell/v1.0/powershell.exe")
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
            if allowed {
                assert_eq!(
                    output.status.code(),
                    Some(17),
                    "service={service}, stderr={}",
                    String::from_utf8_lossy(&output.stderr)
                );
            } else {
                assert!(!output.status.success());
            }
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
    // Exercise an actual short-name alias where the volume provides one. Some
    // Windows volumes disable 8.3 creation; report that fact without inventing
    // an alias or counting it as native short-name evidence.
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetShortPathNameW(long: *const u16, short: *mut u16, length: u32) -> u32;
    }
    let long: Vec<_> = home.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut short = vec![0u16; 32768];
    let length = unsafe { GetShortPathNameW(long.as_ptr(), short.as_mut_ptr(), short.len() as u32) }
        as usize;
    assert!(
        length > 0 && length < short.len(),
        "{}",
        std::io::Error::last_os_error()
    );
    let short = std::path::PathBuf::from(std::ffi::OsString::from_wide(&short[..length]));
    if short != home {
        eprintln!("native 8.3 home alias={short:?}");
        let short_forwarder = windows_cli::install(
            Path::new(env!("CARGO_BIN_EXE_hexbot-cli")),
            &short,
            &root.path().join("short-bin"),
        )
        .unwrap();
        for service in [false, true] {
            let launcher = root.path().join(if service {
                "short-task.ps1"
            } else {
                "short-cli.ps1"
            });
            system_service::write_owned_script(&launcher, &short, service).unwrap();
            for (selected, allowed) in [
                (inside.join("hexbot.exe"), true),
                (linked.join("hexbot.exe"), false),
            ] {
                fs::write(
                    home.join("runtime/native-current.json"),
                    json!({"executable": selected}).to_string(),
                )
                .unwrap();
                let output = if service {
                    powershell(&format!(
                        "& {} version; exit $LASTEXITCODE",
                        quote(&launcher)
                    ))
                } else {
                    Command::new(&short_forwarder)
                        .arg("version")
                        .output()
                        .unwrap()
                };
                if allowed {
                    assert_eq!(
                        output.status.code(),
                        Some(17),
                        "8.3 stderr={}",
                        String::from_utf8_lossy(&output.stderr)
                    );
                } else {
                    assert!(!output.status.success());
                }
                assert_eq!(
                    marker.exists(),
                    allowed,
                    "8.3 containment service={service}"
                );
                if allowed {
                    fs::remove_file(&marker).unwrap();
                }
            }
        }
    } else {
        eprintln!(
            "Native volume supplies no distinct 8.3 home alias; short-name launch is unproved on this volume"
        );
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
    // setup must reject a foreign/reparse legacy launcher BEFORE creating a
    // forwarder, sidecar, PATH intent or registry entry. Owned migration works.
    for case in ["foreign", "other-home", "directory", "junction", "owned"] {
        let user = root.path().join(format!("legacy {case}"));
        let state = user.join("state");
        let native = state.join("runtime/native/build");
        let bin = user.join(".local/bin");
        fs::create_dir_all(&native).unwrap();
        fs::create_dir_all(&bin).unwrap();
        fs::copy(env!("CARGO_BIN_EXE_hexbot"), native.join("hexbot.exe")).unwrap();
        fs::copy(
            env!("CARGO_BIN_EXE_hexbot-cli"),
            native.join("hexbot-cli.exe"),
        )
        .unwrap();
        fs::write(
            state.join("runtime/native-current.json"),
            json!({"executable":native.join("hexbot.exe")}).to_string(),
        )
        .unwrap();
        let legacy = bin.join("hexbot.ps1");
        match case {
            "foreign" => fs::write(&legacy, "foreign bytes").unwrap(),
            "other-home" => system_service::write_owned_script(&legacy, &home, false).unwrap(),
            "directory" => fs::create_dir(&legacy).unwrap(),
            "junction" => {
                let output = powershell(&format!(
                    "New-Item -ItemType Junction -Path {} -Target {} | Out-Null",
                    quote(&legacy),
                    quote(&home)
                ));
                assert!(
                    output.status.success(),
                    "{}",
                    String::from_utf8_lossy(&output.stderr)
                );
            }
            _ => system_service::write_owned_script(&legacy, &state, false).unwrap(),
        }
        let old = fs::read(&legacy).ok();
        let output = Command::new(env!("CARGO_BIN_EXE_hexbot"))
            .args(["setup", "--no-code-tools", "--json"])
            .env("HEXBOT_HOME", &state)
            .env("USERPROFILE", &user)
            .env("HOME", &user)
            .env_remove("HEXBOT_CLI_NO_PATH")
            .output()
            .unwrap();
        let forwarder = bin.join("hexbot.exe");
        if case == "owned" {
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            assert!(!legacy.exists());
            assert!(windows_cli::owned(&forwarder, &state));
            windows_cli::remove(&forwarder, &state).unwrap();
        } else {
            assert!(!output.status.success());
            assert!(!forwarder.exists() && !forwarder.with_extension("json").exists());
            assert_eq!(fs::read_dir(&bin).unwrap().count(), 1);
            assert_eq!(fs::read(&legacy).ok(), old);
            if case == "junction" {
                fs::remove_dir(&legacy).unwrap();
            }
        }
        let unchanged: serde_json::Value =
            serde_json::from_slice(&powershell(query).stdout).unwrap();
        assert_eq!(unchanged, before, "legacy {case} changed persistent PATH");
    }
    // Exercise the real metadata/registry interruption boundaries, followed by
    // either a repair (including the CLI reinstall step) or direct uninstall.
    for boundary in [
        "before-intent",
        "after-intent",
        "after-registry",
        "after-commit",
    ] {
        for repair in [false, true] {
            let bin = root.path().join(format!("Jos\u{e9} {boundary} {repair}"));
            let source = Path::new(env!("CARGO_BIN_EXE_hexbot-cli"));
            let cli = windows_cli::install(source, &home, &bin).unwrap();
            assert!(windows_cli::register_path_interruption_probe(&cli, boundary).is_err());
            assert!(
                windows_cli::remove(&cli, root.path()).is_err(),
                "foreign home claimed CLI"
            );
            if repair {
                windows_cli::install(source, &home, &bin).unwrap();
                windows_cli::register_path(&cli).unwrap();
                let ownership: serde_json::Value =
                    serde_json::from_slice(&fs::read(cli.with_extension("json")).unwrap()).unwrap();
                assert_eq!(ownership["pathAdded"], true);
            } else if boundary == "after-registry" {
                fs::remove_file(&cli).unwrap(); // partial uninstall still recovers the journal
            }
            windows_cli::remove(&cli, &home).unwrap();
            assert!(!cli.with_extension("json").exists());
            let restored: serde_json::Value =
                serde_json::from_slice(&powershell(query).stdout).unwrap();
            assert_eq!(
                restored["value"], before["value"],
                "{boundary} repair={repair}"
            );
            assert_eq!(restored["exists"], before["exists"]);
        }
    }
    // An entry present before registration belongs to the user, even when the
    // entry was installed by another tool. Never claim/delete it.
    let bin = root.path().join("preexisting user CLI");
    let cli =
        windows_cli::install(Path::new(env!("CARGO_BIN_EXE_hexbot-cli")), &home, &bin).unwrap();
    let mut preexisting = before.clone();
    preexisting["value"] = serde_json::json!(if before["value"].as_str().unwrap().is_empty() {
        bin.display().to_string()
    } else {
        format!("{};{}", before["value"].as_str().unwrap(), bin.display())
    });
    preexisting["exists"] = serde_json::json!(true);
    let text = preexisting.to_string().replace('\'', "''");
    let output = powershell(&format!(
        "$v='{text}'|ConvertFrom-Json;$k=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment');try{{$k.SetValue('Path',[string]$v.value,[Microsoft.Win32.RegistryValueKind][int]$v.kind)}}finally{{$k.Dispose()}}"
    ));
    assert!(output.status.success());
    windows_cli::register_path(&cli).unwrap();
    let ownership: serde_json::Value =
        serde_json::from_slice(&fs::read(cli.with_extension("json")).unwrap()).unwrap();
    assert_eq!(ownership["pathAdded"], false);
    assert!(ownership["pathIntent"].is_null());
    windows_cli::remove(&cli, &home).unwrap();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&powershell(query).stdout).unwrap(),
        preexisting
    );
    // A concurrent edit to a pending snapshot is ambiguous. Preserve both
    // user PATH and the journal instead of attributing the edit to Hexbot.
    let bin = root.path().join("pending concurrent edit");
    let cli =
        windows_cli::install(Path::new(env!("CARGO_BIN_EXE_hexbot-cli")), &home, &bin).unwrap();
    assert!(windows_cli::register_path_interruption_probe(&cli, "after-intent").is_err());
    let pending = fs::read(cli.with_extension("json")).unwrap();
    let mut changed = preexisting.clone();
    changed["value"] = serde_json::json!(format!(
        "{};unrelated-user-entry",
        changed["value"].as_str().unwrap()
    ));
    for value in [&changed, &preexisting] {
        let text = value.to_string().replace('\'', "''");
        assert!(powershell(&format!("$v='{text}'|ConvertFrom-Json;$k=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment');try{{$k.SetValue('Path',[string]$v.value,[Microsoft.Win32.RegistryValueKind][int]$v.kind)}}finally{{$k.Dispose()}}")).status.success());
        if value == &changed {
            assert!(windows_cli::register_path(&cli).is_err());
            assert!(windows_cli::remove(&cli, &home).is_err());
            assert_eq!(fs::read(cli.with_extension("json")).unwrap(), pending);
            assert_eq!(
                serde_json::from_slice::<serde_json::Value>(&powershell(query).stdout).unwrap(),
                changed
            );
        }
    }
    windows_cli::remove(&cli, &home).unwrap();
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
    assert_eq!(fs::read_to_string(&file).unwrap(), "foreign script");
    fs::remove_file(&file).unwrap();
    system_service::write_owned_script(&file, &home, true).unwrap();
    let sid = powershell("[Security.Principal.WindowsIdentity]::GetCurrent().User.Value");
    assert!(sid.status.success());
    let sid = String::from_utf8(sid.stdout).unwrap().trim().to_owned();
    let name = format!("Hexbot-daemon-{sid}");
    struct TaskCleanup(String);
    impl Drop for TaskCleanup {
        fn drop(&mut self) {
            let output = powershell(&format!(
                "$s=New-Object -ComObject 'Schedule.Service';$s.Connect();try{{$t=$s.GetFolder('\\').GetTask('{}');if([int]$t.State -eq 4 -or [int]$t.State -eq 2){{$t.Stop(0)}};$s.GetFolder('\\').DeleteTask($t.Name,0)}}catch{{$e=$_.Exception;while($e.InnerException){{$e=$e.InnerException}};if($e.HResult -ne -2147024894){{throw}}}}",
                self.0
            ));
            assert!(
                output.status.success(),
                "Cannot remove owned foreign-action fixture: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
    }
    let register = powershell(&format!(
        "$s=New-Object -ComObject 'Schedule.Service';$s.Connect();$t=$s.NewTask(0);$t.Principal.UserId='{sid}';$t.Principal.LogonType=3;$t.Principal.RunLevel=0;$a=$t.Actions.Create(0);$a.Path={};$a.Arguments='/D /C exit 0';$s.GetFolder('\\').RegisterTaskDefinition('{name}',$t,2,$null,$null,3) | Out-Null",
        quote(&windows_paths::system_program("cmd.exe").unwrap())
    ));
    assert!(
        register.status.success(),
        "{}",
        String::from_utf8_lossy(&register.stderr)
    );
    let cleanup = TaskCleanup(name.clone());
    let output = run();
    assert!(
        !output.status.success(),
        "Uninstall claimed a foreign task action"
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    let diagnostic = stderr
        .lines()
        .find_map(|line| line.strip_prefix("Hexbot task ownership diagnostic: "))
        .unwrap_or_else(|| panic!("Missing bounded ownership diagnostic: {stderr}"));
    let diagnostic: serde_json::Value = serde_json::from_str(diagnostic).unwrap();
    assert_eq!(diagnostic["reason"], "principal/action mismatch");
    assert_eq!(diagnostic["program"]["matches"], false);
    assert_eq!(diagnostic["arguments"]["actual"]["value"], "/D /C exit 0");
    assert_eq!(diagnostic["principal"]["expected"]["value"], sid);
    assert_eq!(diagnostic["principal"]["resolved"]["value"], sid);
    assert_eq!(diagnostic["principal"]["matches"], true);
    for field in ["program", "arguments", "principal", "home"] {
        for side in ["actual", "expected"] {
            assert!(diagnostic[field][side]["value"].as_str().unwrap().len() <= 2048);
            assert!(diagnostic[field][side]["type"].is_string());
        }
    }
    assert!(system_service::owned(&file, &home));
    let query = powershell(&format!(
        "$s=New-Object -ComObject 'Schedule.Service';$s.Connect();$s.GetFolder('\\').GetTask('{name}') | Out-Null"
    ));
    assert!(query.status.success(), "Foreign task was deleted");
    drop(cleanup);
    assert!(run().status.success());
    assert!(!file.exists());
    // A real task keeps its own home binding after its script disappears.
    // Use the actual daemon so install/repair must stop its old process and
    // release the home lock before replacing and running the task again.
    let native = home.join("runtime/native/build");
    fs::create_dir_all(&native).unwrap();
    fs::copy(env!("CARGO_BIN_EXE_hexbot"), native.join("hexbot.exe")).unwrap();
    fs::write(
        home.join("runtime/native-current.json"),
        json!({"executable":native.join("hexbot.exe")}).to_string(),
    )
    .unwrap();
    let service = |owner: &Path, action: &str| {
        Command::new(env!("CARGO_BIN_EXE_hexbot"))
            .args(
                [
                    "service",
                    action,
                    if action == "status" { "--json" } else { "" },
                ]
                .into_iter()
                .filter(|s| !s.is_empty()),
            )
            .env("HEXBOT_HOME", owner)
            .env("HEXBOT_SERVICE_ROOT", root.path())
            .env_remove("HEXBOT_SERVICE_NO_LOAD")
            .output()
            .unwrap()
    };
    let ready = |previous: u32| -> u32 {
        let path = home.join("runtime/native-running.json");
        let output = powershell(&format!(
            r#"[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$p={};$w=[IO.FileSystemWatcher]::new([IO.Path]::GetDirectoryName($p));$w.Filter=[IO.Path]::GetFileName($p);$w.EnableRaisingEvents=$true;$clock=[Diagnostics.Stopwatch]::StartNew();try{{do{{if(Test-Path -LiteralPath $p){{$v=Get-Content -LiteralPath $p -Raw -Encoding UTF8|ConvertFrom-Json;if($v.pid -and $v.pid -ne {previous}){{$v.pid;exit 0}}}}$remaining=30000-[int]$clock.ElapsedMilliseconds;if($remaining -le 0){{throw 'Daemon did not become ready'}};$null=$w.WaitForChanged([IO.WatcherChangeTypes]::All,$remaining)}}while($true)}}finally{{$w.Dispose()}}"#,
            quote(&path)
        ));
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout)
            .unwrap()
            .trim()
            .parse()
            .unwrap()
    };
    // Direct CLI install must not race an app-owned daemon when no task
    // exists. Wait for real readiness while its home lock is held.
    use std::io::{BufRead, BufReader, Write};
    let mut desktop = Command::new(env!("CARGO_BIN_EXE_hexbot"))
        .args(["serve", "--host", "127.0.0.1", "--port", "0"])
        .env("HEXBOT_HOME", &home)
        .env("HEXBOT_SUPERVISOR", "desktop")
        .env("HEXBOT_DESKTOP_CONTROL", "stdin-v1")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::inherit())
        .spawn()
        .unwrap();
    let mut lines = BufReader::new(desktop.stdout.take().unwrap());
    let mut line = String::new();
    loop {
        assert!(lines.read_line(&mut line).unwrap() > 0);
        if line.starts_with("HERMES_BACKEND_READY") {
            break;
        }
        line.clear();
    }
    let refused = service(&home, "install");
    assert!(!refused.status.success());
    assert!(String::from_utf8_lossy(&refused.stderr).contains("Stop the daemon"));
    assert!(!file.exists());
    assert!(!file.with_extension("xml").exists());
    let status = service(&home, "status");
    assert!(status.status.success());
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&status.stdout).unwrap()["installed"],
        false
    );
    desktop
        .stdin
        .take()
        .unwrap()
        .write_all(b"HEXBOT_SHUTDOWN_V1\n")
        .unwrap();
    assert_eq!(desktop.wait().unwrap().code(), Some(0));
    eprintln!("Task recovery stage: initial install; home={home:?} script={file:?}");
    let output = service(&home, "install");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let _task_cleanup = TaskCleanup(name.clone());
    let first_pid = ready(0);
    eprintln!("Task recovery stage: initial daemon ready pid={first_pid}; removing owned script");
    fs::remove_file(&file).unwrap();
    eprintln!("Task recovery stage: status after script removal");
    let status = service(&home, "status");
    assert!(
        status.status.success(),
        "{}",
        String::from_utf8_lossy(&status.stderr)
    );
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&status.stdout).unwrap()["installed"],
        true
    );
    let other = root.path().join("other home");
    fs::create_dir(&other).unwrap();
    for action in ["status", "uninstall"] {
        assert!(
            !service(&other, action).status.success(),
            "Another home claimed the missing-script task"
        );
    }
    // Losing the description as well loses proof. Exact SID/action/path alone
    // must not authorize either repair or removal. Restore only our fixture.
    let unbound = powershell(&format!(
        r#"$s=New-Object -ComObject 'Schedule.Service';$s.Connect();$f=$s.GetFolder('\');$t=$f.GetTask('{name}').Definition;$owner=$t.RegistrationInfo.Description;try{{$t.RegistrationInfo.Description='';$null=$f.RegisterTaskDefinition('{name}',$t,6,$null,$null,3);$env:HEXBOT_HOME={};$env:HEXBOT_SERVICE_ROOT={}; & {} service status --json;if($LASTEXITCODE -eq 0){{throw 'Unbound task was claimed'}}}}finally{{$t.RegistrationInfo.Description=$owner;$null=$f.RegisterTaskDefinition('{name}',$t,6,$null,$null,3)}}"#,
        quote(&home),
        quote(root.path()),
        quote(Path::new(env!("CARGO_BIN_EXE_hexbot")))
    ));
    assert!(
        unbound.status.success(),
        "{}",
        String::from_utf8_lossy(&unbound.stderr)
    );
    let output = service(&home, "install");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let next_pid = ready(first_pid);
    assert_ne!(next_pid, first_pid);
    assert!(powershell(&format!("if(Get-Process -Id {first_pid} -ErrorAction SilentlyContinue){{throw 'Old task daemon survived repair'}}")).status.success());
    assert!(service(&home, "stop").status.success());
    fs::remove_file(&file).unwrap();
    // Removal authenticates the task independently of runtime selection.
    // Quarantine the binary and corrupt the pointer; no repair/network is needed.
    fs::rename(native.join("hexbot.exe"), native.join("quarantined.exe")).unwrap();
    fs::write(
        home.join("runtime/native-current.json"),
        "{ damaged selection",
    )
    .unwrap();
    let installer =
        std::env::var_os("HEXBOT_WINDOWS_INSTALLER").expect("native installer engine executable");
    let removed = Command::new(installer)
        .args(["--uninstall", "--yes", "--json"])
        .env("HEXBOT_HOME", &home)
        .env("HOME", root.path())
        .env("USERPROFILE", root.path())
        .env("HEXBOT_SERVICE_ROOT", root.path())
        .env_remove("HEXBOT_SERVICE_NO_LOAD")
        .output()
        .unwrap();
    assert!(
        removed.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&removed.stdout),
        String::from_utf8_lossy(&removed.stderr)
    );
    // Engine detection/removal must reach the same verified remaining task.
    let missing = powershell(&format!(
        "$s=New-Object -ComObject 'Schedule.Service';$s.Connect();try{{$null=$s.GetFolder('\\').GetTask('{name}');throw 'Owned task was not removed'}}catch{{$e=$_.Exception;while($e.InnerException){{$e=$e.InnerException}};if($e.HResult -ne -2147024894){{throw}}}}"
    ));
    assert!(
        missing.status.success(),
        "{}",
        String::from_utf8_lossy(&missing.stderr)
    );
    drop(_task_cleanup); // Already-removed owned tasks are an idempotent cleanup.
}
