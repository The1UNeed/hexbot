//! Protect processes from the pinned NSIS macro's silent default-to-kill paths.
use std::path::Path;

#[cfg(windows)]
pub(crate) const AVAILABLE_PROBE: &str =
    "if (Get-Command Get-CimInstance -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }";
#[cfg(windows)]
pub(crate) const POLICY_PROBE: &str =
    "if ((Get-ExecutionPolicy -Scope Process) -eq 'Restricted') { exit 1 } else { exit 0 }";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Machine {
    I386,
    Amd64,
}
fn machine(mut file: impl std::io::Read + std::io::Seek) -> std::io::Result<Machine> {
    use std::io::SeekFrom;
    let invalid =
        || std::io::Error::other("The Windows installer has an invalid or unsupported PE header.");
    let mut dos = [0u8; 64];
    file.read_exact(&mut dos)?;
    if &dos[..2] != b"MZ" {
        return Err(invalid());
    }
    let offset = u32::from_le_bytes(dos[60..64].try_into().unwrap());
    if !(64..=1_048_576).contains(&offset) {
        return Err(invalid());
    }
    file.seek(SeekFrom::Start(u64::from(offset)))?;
    let mut pe = [0u8; 6];
    file.read_exact(&mut pe)?;
    if &pe[..4] != b"PE\0\0" {
        return Err(invalid());
    }
    match u16::from_le_bytes([pe[4], pe[5]]) {
        0x14c => Ok(Machine::I386),
        0x8664 => Ok(Machine::Amd64),
        _ => Err(invalid()),
    }
}

#[cfg(windows)]
fn host(machine: Machine) -> crate::Result<std::path::PathBuf> {
    let program = if machine == Machine::Amd64 {
        crate::windows_paths::system_program("WindowsPowerShell/v1.0/powershell.exe")?
    } else {
        unsafe extern "system" {
            fn GetSystemWow64DirectoryW(buffer: *mut u16, size: u32) -> u32;
        }
        let mut buffer = [0u16; 32768];
        let length =
            unsafe { GetSystemWow64DirectoryW(buffer.as_mut_ptr(), buffer.len() as u32) } as usize;
        if length == 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        if length >= buffer.len() {
            return crate::fail("The Windows WOW64 system directory is too long.");
        }
        std::path::PathBuf::from(String::from_utf16(&buffer[..length])?)
            .join("WindowsPowerShell/v1.0/powershell.exe")
    };
    let meta = std::fs::symlink_metadata(&program)?;
    if !program.is_absolute() || !meta.is_file() || !crate::detect::ordinary(&meta) {
        return crate::fail(
            "The matching Windows system PowerShell host is not an ordinary absolute executable.",
        );
    }
    Ok(program)
}

fn inputs(destination: &Path, id: &str) -> crate::Result<(Vec<String>, &'static str)> {
    let executable = match id {
        "app.hexbot.desktop" | "app.hexbot.desktop.nightly" => "Hexbot.exe",
        "app.hexbot.client" | "app.hexbot.client.nightly" => "HexbotClient.exe",
        _ => return crate::fail("Unknown Windows app identity."),
    };
    let unsupported = "This Windows app path is unsupported by the pinned NSIS installer. Use an ordinary drive path without apostrophes, quotes, percent signs or control characters.";
    let raw = destination.to_str().ok_or(unsupported)?;
    crate::windows_recovery::drive_path(raw).ok_or(unsupported)?;
    let mut spellings = vec![raw.to_owned(), raw.replace('/', "\\")];
    spellings.sort();
    spellings.dedup();
    Ok((spellings, executable))
}

#[cfg(windows)]
pub(crate) fn check(
    paths: &crate::Paths,
    destination: &Path,
    id: &str,
    nsis: &Path,
) -> crate::Result<()> {
    let (mut spellings, image) = inputs(destination, id)?;
    // Resolve only the authenticated existing parent, never registry/process
    // strings or a missing EXE. An uncertain alias must not drop a predicate.
    let canonical = destination
        .parent()
        .ok_or("Invalid NSIS destination")?
        .canonicalize()?
        .join(destination.file_name().ok_or("Invalid NSIS destination")?);
    let canonical = canonical
        .to_str()
        .ok_or("Unsupported NSIS canonical path")?;
    let canonical = canonical.strip_prefix(r"\\?\").unwrap_or(canonical);
    crate::windows_recovery::drive_path(canonical)
        .ok_or("The canonical Windows app path is unsupported by the pinned NSIS installer.")?;
    spellings.push(canonical.replace('/', "\\"));
    spellings.sort();
    spellings.dedup();
    let meta = std::fs::symlink_metadata(nsis)?;
    if !nsis.is_absolute() || !meta.is_file() || !crate::detect::ordinary(&meta) {
        return crate::fail("The NSIS program is not an ordinary absolute file.");
    }
    let machine = machine(std::fs::File::open(nsis)?)?;
    let program = host(machine)?;
    // Exactly the two separate pinned invocations, same inherited policy/env.
    // No ExecutionPolicy flag or PowerShell preference is added by this check.
    let invoke = |script: &str| {
        let mut command = paths.command(&program);
        command.args(["-NoProfile", "-NonInteractive", "-C", script]);
        command
    };
    let available = output(invoke(AVAILABLE_PROBE))?.status.success()
        && output(invoke(POLICY_PROBE))?.status.success();
    let script = format!(
        "{}\n{}",
        include_str!("windows-nsis-process-policy.ps1"),
        include_str!("windows-nsis-process-query.ps1")
    );
    let mut command = invoke(&script);
    command
        .env(
            "HEXBOT_NSIS_DESTINATIONS",
            serde_json::to_string(&spellings)?,
        )
        .env("HEXBOT_NSIS_IMAGE", image)
        .env("HEXBOT_NSIS_AVAILABLE", if available { "1" } else { "0" });
    let result = output(command)?;
    if !result.status.success() {
        eprintln!(
            "NSIS process query failed: status={} stderr={}",
            result.status,
            String::from_utf8_lossy(&result.stderr)
        );
        return crate::fail(
            "Could not verify processes affected by the Windows installer. Nothing was started.",
        );
    }
    let record: serde_json::Value = serde_json::from_slice(&result.stdout)?;
    if record["complete"] != true
        || record["branch"] != if available { "prefix" } else { "image" }
        || record["matchCount"].as_u64().is_none()
        || record["enumerated"]
            .as_u64()
            .zip(record["matchCount"].as_u64())
            .is_none_or(|(total, matches)| total < matches)
        || record["shown"]
            .as_array()
            .zip(record["matchCount"].as_u64())
            .is_none_or(|(shown, matches)| shown.len() != matches.min(8) as usize)
    {
        return crate::fail("The Windows process query was incomplete. Nothing was started.");
    }
    if record["host"]["is64"].as_bool() != Some(machine == Machine::Amd64) {
        return crate::fail(
            "The NSIS process check used the wrong Windows PowerShell architecture.",
        );
    }
    if std::env::var("HEXBOT_WINDOWS_NSIS_PROBE").as_deref() == Ok("1") {
        eprintln!(
            "Native NSIS process host: {}",
            serde_json::json!({"machine":format!("{machine:?}"),"program":program,"canonicalHost":program.canonicalize().ok(),"observedHost":record["host"],"branch":record["branch"],"enumerated":record["enumerated"],"matchCount":record["matchCount"]})
        );
    }
    if record["matchCount"] != 0 {
        eprintln!("NSIS process preflight refused: {record}");
        return crate::fail(if available {
            "Close the app or process whose path overlaps this Windows install directory, then try again. No process was stopped."
        } else {
            "This NSIS fallback cannot safely install or uninstall beside the live app or daemon under the current PowerShell policy. No process was stopped."
        });
    }
    Ok(())
}

#[cfg(windows)]
fn output(mut command: std::process::Command) -> crate::Result<std::process::Output> {
    use std::{
        io::{Read, Seek, SeekFrom},
        os::windows::{io::AsRawHandle, process::CommandExt},
        process::Stdio,
    };
    unsafe extern "system" {
        fn WaitForSingleObject(handle: *mut std::ffi::c_void, milliseconds: u32) -> u32;
    }
    let mut stdout = tempfile::tempfile()?;
    let mut stderr = tempfile::tempfile()?;
    let mut child = command
        .creation_flags(0x08000000)
        .stdin(Stdio::null())
        .stdout(stdout.try_clone()?)
        .stderr(stderr.try_clone()?)
        .spawn()?;
    // Bounded event wait on this exact child, not polling or a PID lookup.
    if unsafe { WaitForSingleObject(child.as_raw_handle(), 30_000) } != 0 {
        let _ = child.kill();
        let _ = child.wait();
        return crate::fail(
            "The Windows installer process check did not complete. Nothing was started.",
        );
    }
    let status = child.wait()?;
    let read = |file: &mut std::fs::File| -> crate::Result<Vec<u8>> {
        file.seek(SeekFrom::Start(0))?;
        let mut bytes = Vec::new();
        file.take(32769).read_to_end(&mut bytes)?;
        if bytes.len() > 32768 {
            return crate::fail("The Windows installer process check exceeded its output limit.");
        }
        Ok(bytes)
    };
    Ok(std::process::Output {
        status,
        stdout: read(&mut stdout)?,
        stderr: read(&mut stderr)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pe_machine_parser_has_fixed_reads_and_a_bounded_dos_offset() {
        let header = |machine: u16| {
            let mut bytes = vec![0u8; 134];
            bytes[..2].copy_from_slice(b"MZ");
            bytes[60..64].copy_from_slice(&128u32.to_le_bytes());
            bytes[128..132].copy_from_slice(b"PE\0\0");
            bytes[132..134].copy_from_slice(&machine.to_le_bytes());
            bytes
        };
        for (value, expected) in [(0x14c, Machine::I386), (0x8664, Machine::Amd64)] {
            assert_eq!(
                machine(std::io::Cursor::new(header(value))).unwrap(),
                expected
            );
        }
        for case in [
            "mz",
            "pe",
            "negative",
            "overflow",
            "budget",
            "small-offset",
            "truncated-dos",
            "truncated-pe",
            "arm",
        ] {
            let mut bytes = header(0x14c);
            match case {
                "mz" => bytes[0] = 0,
                "pe" => bytes[128] = 0,
                "negative" => bytes[60..64].copy_from_slice(&0x80000000u32.to_le_bytes()),
                "overflow" => bytes[60..64].copy_from_slice(&u32::MAX.to_le_bytes()),
                "budget" => bytes[60..64].copy_from_slice(&1_048_577u32.to_le_bytes()),
                "small-offset" => bytes[60..64].copy_from_slice(&63u32.to_le_bytes()),
                "truncated-dos" => bytes.truncate(63),
                "truncated-pe" => bytes.truncate(133),
                _ => bytes[132..134].copy_from_slice(&0xaa64u16.to_le_bytes()),
            }
            assert!(machine(std::io::Cursor::new(bytes)).is_err(), "{case}");
        }
    }

    #[test]
    fn nsis_operands_are_trusted_drive_paths_not_macro_injection() {
        for id in [
            "app.hexbot.desktop",
            "app.hexbot.desktop.nightly",
            "app.hexbot.client",
            "app.hexbot.client.nightly",
        ] {
            let (paths, image) = inputs(Path::new(r"C:\José app\known"), id).unwrap();
            assert_eq!(paths, [r"C:\José app\known"]);
            assert_eq!(
                image,
                if id.contains("client") {
                    "HexbotClient.exe"
                } else {
                    "Hexbot.exe"
                }
            );
        }
        for path in [
            "C:\\a'pp",
            "C:\\a\rpp",
            r"\\server\app",
            r"\\?\C:\app",
            r"C:\app%USER%",
            r"C:\app\..\other",
        ] {
            assert!(inputs(Path::new(path), "app.hexbot.desktop").is_err());
        }
    }
}
