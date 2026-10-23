//! Outer-installer cleanup of Electron's exact per-user hexbot:// command.
//! This deliberately leaves protocol keys/other values and other handlers alone.
use std::path::Path;

const COMMAND_KEY: &str = r"Software\Classes\hexbot\shell\open\command";
const SCRIPT: &str = include_str!("windows-protocol-cleanup.ps1");
#[derive(Debug)]
pub(crate) struct Binding(Vec<String>);

fn command(directory: &str, executable: &str) -> Option<String> {
    // Candidate paths come only from an already authenticated app directory.
    // Do not resolve a registry-supplied path, reopen a missing EXE, or guess UNC.
    let directory = directory
        .strip_prefix(r"\\?\")
        .unwrap_or(directory)
        .replace('/', r"\");
    let bytes = directory.as_bytes();
    if bytes.len() < 3
        || !bytes[0].is_ascii_alphabetic()
        || bytes[1] != b':'
        || bytes[2] != b'\\'
        || directory.contains(['"', '\r', '\n', '\0'])
        || directory.encode_utf16().count() > 4096
        || directory
            .split('\\')
            .any(|part| part == "." || part == "..")
    {
        return None;
    }
    Some(format!(
        "\"{}\\{executable}\" \"%1\"",
        directory.trim_end_matches('\\')
    ))
}
pub(crate) fn binding(directory: &Path, id: &str) -> Binding {
    let executable = match id {
        "app.hexbot.desktop" | "app.hexbot.desktop.nightly" => "Hexbot.exe",
        "app.hexbot.client" | "app.hexbot.client.nightly" => "HexbotClient.exe",
        _ => return Binding(Vec::new()),
    };
    let mut candidates = Vec::new();
    if let Some(candidate) = directory
        .to_str()
        .and_then(|path| command(path, executable))
    {
        candidates.push(candidate);
    }
    if candidates.is_empty() {
        return Binding(candidates);
    }
    // Existing app-directory canonicalization is allowed; the EXE may already
    // be missing. Only a drive-qualified result can add a second candidate.
    if let Ok(canonical) = directory.canonicalize()
        && let Some(candidate) = canonical
            .to_str()
            .and_then(|path| command(path, executable))
        && !candidates.contains(&candidate)
    {
        candidates.push(candidate);
    }
    Binding(candidates)
}
#[cfg(windows)]
pub(crate) fn cleanup(binding: &Binding) -> crate::Result<()> {
    if binding.0.is_empty() {
        return Ok(());
    }
    execute(binding, &script(COMMAND_KEY))
}
#[cfg(windows)]
fn script(key: &str) -> String {
    format!(
        "{}\n{}",
        include_str!("windows-protocol-binding.ps1"),
        SCRIPT.replace("__COMMAND_KEY__", key)
    )
}
#[cfg(windows)]
fn execute(binding: &Binding, script: &str) -> crate::Result<()> {
    use std::{os::windows::process::CommandExt, process::Command};
    let output = Command::new(crate::windows_paths::system_program(
        "WindowsPowerShell/v1.0/powershell.exe",
    )?)
    .args(["-NoProfile", "-NonInteractive", "-Command", script])
    .env(
        "HEXBOT_PROTOCOL_BINDINGS",
        serde_json::to_string(&binding.0)?,
    )
    .creation_flags(0x08000000)
    .output()?;
    if !output.status.success() || output.stdout.len() > 1024 {
        return Err(format!("Protocol command cleanup failed ({}).", output.status).into());
    }
    let result: serde_json::Value = serde_json::from_slice(&output.stdout)?;
    match result["outcome"].as_str() {
        Some("removed" | "absent" | "preserved") => Ok(()),
        _ => Err("Unexpected protocol cleanup result.".into()),
    }
}
#[cfg(any(windows, test))]
pub(crate) fn finish(
    cleanup: crate::Result<()>,
    remove: impl FnOnce() -> crate::Result<()>,
) -> crate::Result<()> {
    let residual = remove();
    match (cleanup, residual) {
        (Ok(()), result) => result,
        (Err(cleanup), residual) => Err(Box::new(PartialRemoval {
            cleanup,
            residual: residual.err(),
        })),
    }
}
#[cfg(any(windows, test))]
#[derive(Debug)]
struct PartialRemoval {
    cleanup: Box<dyn std::error::Error + Send + Sync>,
    residual: Option<Box<dyn std::error::Error + Send + Sync>>,
}
#[cfg(any(windows, test))]
impl std::fmt::Display for PartialRemoval {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let message = if self.residual.is_some() {
            "The app uninstaller finished, but app files and hexbot:// links could not be fully cleaned up."
        } else {
            "The app was removed, but hexbot:// links may still point to it."
        };
        write!(f, "{message} Cleanup: {}", self.cleanup)?;
        if let Some(error) = &self.residual {
            write!(f, " App files also could not be fully removed: {error}")?;
        }
        Ok(())
    }
}
#[cfg(any(windows, test))]
impl std::error::Error for PartialRemoval {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(self.cleanup.as_ref())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn candidates_are_known_edition_paths_without_reopening_missing_executables() {
        for id in [
            "app.hexbot.desktop",
            "app.hexbot.desktop.nightly",
            "app.hexbot.client",
            "app.hexbot.client.nightly",
        ] {
            let path = format!(r"C:\José state\{id}");
            let binding = binding(Path::new(&path), id);
            let exe = if id.contains("client") {
                "HexbotClient.exe"
            } else {
                "Hexbot.exe"
            };
            assert_eq!(binding.0, vec![format!("\"{path}\\{exe}\" \"%1\"")]);
        }
        for path in [
            r"\\server\share\app",
            r"\\?\UNC\server\share\app",
            r"\\.\C:\app",
            r"C:\app\..\other",
            "C:\\app\nother",
            "C:\\app\"other",
        ] {
            assert!(command(path, "Hexbot.exe").is_none(), "{path}");
        }
        assert!(binding(Path::new(r"C:\owned"), "org.foreign").0.is_empty());
        assert!(command(&format!("C:\\{}", "x".repeat(4097)), "Hexbot.exe").is_none());
        assert_eq!(
            command(r"\\?\C:\owned\", "Hexbot.exe"),
            command("C:/owned", "Hexbot.exe")
        );
        assert_eq!(COMMAND_KEY, r"Software\Classes\hexbot\shell\open\command");
        assert_eq!(SCRIPT.matches("__COMMAND_KEY__").count(), 1);
    }
    #[test]
    fn cleanup_error_is_reported_after_residual_removal_and_retains_both_causes() {
        let removed = std::cell::Cell::new(false);
        let cleanup: crate::Result<()> = Err(std::io::Error::other("registry unavailable").into());
        let residual = || {
            removed.set(true);
            Err(std::io::Error::other("residual unavailable").into())
        };
        let error = finish(cleanup, residual).unwrap_err();
        assert!(removed.get());
        assert!(error.to_string().contains("registry unavailable"));
        assert!(error.to_string().contains("residual unavailable"));
        assert!(
            error
                .source()
                .unwrap()
                .to_string()
                .contains("registry unavailable")
        );
        assert!(!error.to_string().contains("Nothing was changed"));
    }
}

#[cfg(all(test, windows))]
mod native_tests {
    use super::*;
    use serde_json::{Value, json};
    use std::{path::PathBuf, process::Command};
    fn fixture(key: &str, action: &str, command: &str, kind: &str) -> Value {
        let script = r#"$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$r=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser,[Microsoft.Win32.RegistryView]::Registry64)
try {
 if($env:TEST_ACTION -eq 'clear'){$r.DeleteSubKeyTree($env:TEST_KEY,$false);'{}';exit}
 $k=$r.CreateSubKey($env:TEST_KEY)
 try {
  if($env:TEST_ACTION -eq 'set'){$k.SetValue('',[string]$env:TEST_COMMAND,([Enum]::Parse([Microsoft.Win32.RegistryValueKind],$env:TEST_KIND)));$k.SetValue('sentinel','keep named value');$i=$k.CreateSubKey('child');try{$i.SetValue('','keep child')}finally{$i.Dispose()}}
  @{exists=($k.GetValueNames() -contains '');value=$k.GetValue('',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames);kind=$(if($k.GetValueNames() -contains ''){$k.GetValueKind('').ToString()});sentinel=$k.GetValue('sentinel');child=$k.GetSubKeyNames()}|ConvertTo-Json -Compress
 }finally{$k.Dispose()}
}finally{$r.Dispose()}"#;
        let output = Command::new(
            crate::windows_paths::system_program("WindowsPowerShell/v1.0/powershell.exe").unwrap(),
        )
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .env("TEST_KEY", key)
        .env("TEST_ACTION", action)
        .env("TEST_COMMAND", command)
        .env("TEST_KIND", kind)
        .output()
        .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        serde_json::from_slice(&output.stdout).unwrap()
    }
    struct Key(String);
    impl Drop for Key {
        fn drop(&mut self) {
            fixture(&self.0, "clear", "", "String");
        }
    }
    #[test]
    fn registry_cleanup_matches_only_owned_command_default_and_preserves_other_values() {
        let root = tempfile::tempdir().unwrap();
        let key = Key(format!(
            r"Software\HexbotProtocolTests\{}\{}",
            std::process::id(),
            root.path().file_name().unwrap().to_string_lossy()
        ));
        let executable = root.path().join("HexbotClient.exe");
        std::fs::write(&executable, "owned fixture").unwrap();
        let binding = binding(root.path(), "app.hexbot.client");
        let expected = binding.0[0].clone();
        std::fs::remove_file(executable).unwrap(); // NSIS already removed it.
        let script = script(&key.0);
        for (command, kind, remove) in [
            (expected.clone(), "String", true),
            (expected.to_lowercase(), "String", true),
            (expected.clone(), "ExpandString", false),
            (
                expected.replace("HexbotClient.exe", "Hexbot.exe"),
                "String",
                false,
            ),
            (
                expected.replace("HexbotClient.exe", "other\\HexbotClient.exe"),
                "String",
                false,
            ),
            (
                expected.replace("\" \"%1\"", "\" \"%1\" extra"),
                "String",
                false,
            ),
            (expected.replace('"', ""), "String", false),
            (expected.replace("%1", "%L"), "String", false),
            (format!("{expected}\r\n"), "String", false),
            ("x".repeat(4201), "String", false),
        ] {
            let before = fixture(&key.0, "set", &command, kind);
            execute(&binding, &script).unwrap();
            let after = fixture(&key.0, "read", "", "String");
            if remove {
                assert_eq!(after["exists"], false);
                assert_eq!(after["sentinel"], before["sentinel"]);
                assert_eq!(after["child"], before["child"]);
            } else {
                assert_eq!(after, before);
            }
        }
        // A new handler written before cleanup is preserved rather than using
        // a stale pre-uninstall registry snapshot as deletion authority.
        let replacement = Binding(vec![expected.replace("HexbotClient.exe", "Hexbot.exe")]);
        let before = fixture(&key.0, "set", &replacement.0[0], "String");
        execute(&binding, &script).unwrap();
        assert_eq!(fixture(&key.0, "read", "", "String"), before);
        let residual = root.path().join("residual");
        std::fs::create_dir(&residual).unwrap();
        let error = finish(
            execute(&binding, "throw 'injected cleanup failure'"),
            || Ok(std::fs::remove_dir(&residual)?),
        )
        .unwrap_err();
        assert!(!residual.exists());
        assert!(error.to_string().contains("The app was removed"));
        assert!(!PathBuf::from(&binding.0[0]).exists());
        eprintln!(
            "Native protocol command cleanup controls: {}",
            json!({"exactOwned":true,"missingExe":true,"replacementPreserved":true,"expandStringPreserved":true,"namedValuesAndChildrenPreserved":true,"failedCleanupStillRemovesResidual":true})
        );
    }
}
