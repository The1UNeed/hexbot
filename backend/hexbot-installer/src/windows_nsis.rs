//! Read-only collision checks for the registry identities baked into NSIS.
use std::{
    fs, io,
    path::{Path, PathBuf},
};

// UUID.v5(appId, 50e065bc-3134-11e6-9bab-38c9862bdaf3), verified against
// the pinned builder-util-runtime by windows-nsis.test.mjs.
pub(crate) const IDENTITIES: [(&str, &str); 4] = [
    ("app.hexbot.desktop", "5c6fd00f-bd80-53ff-aeef-f9c3358a4c57"),
    (
        "app.hexbot.desktop.nightly",
        "6626f9dd-933a-5e44-9657-6fa079966fb4",
    ),
    ("app.hexbot.client", "05b10340-fa13-50a8-9202-f1b511554ce2"),
    (
        "app.hexbot.client.nightly",
        "5625bc89-25d6-5b85-9fd5-b4d4fd6cf320",
    ),
];
fn invalid() -> io::Error {
    io::Error::other(
        "Windows app registration is incomplete or belongs to another installation. Nothing was changed.",
    )
}
pub(crate) fn uninstaller_name(id: &str, name: &str) -> bool {
    if !IDENTITIES.iter().any(|(known, _)| *known == id) {
        return false;
    }
    let base = if id.starts_with("app.hexbot.client") {
        "Hexbot Client"
    } else {
        "Hexbot"
    };
    if id.ends_with(".nightly") {
        name.eq_ignore_ascii_case(&format!("Uninstall {base} Nightly.exe"))
    } else {
        name.eq_ignore_ascii_case(&format!("Uninstall {base}.exe"))
            || name.eq_ignore_ascii_case(&format!("Uninstall {base} [alpha].exe"))
    }
}
fn command_file<'a>(id: &str, command: &'a str) -> io::Result<&'a str> {
    let (file, arguments) = command
        .strip_prefix('"')
        .and_then(|s| s.split_once('"'))
        .ok_or_else(invalid)?;
    if !arguments.trim().eq_ignore_ascii_case("/currentuser")
        || file.contains(['\r', '\n', '\0'])
        || !uninstaller_name(id, file.rsplit(['\\', '/']).next().unwrap_or_default())
    {
        return Err(invalid());
    }
    Ok(file)
}

#[derive(Clone, serde::Deserialize)]
struct Registration {
    install: bool,
    uninstall: bool,
    location: Option<String>,
    command: Option<String>,
}

#[cfg(windows)]
pub(crate) fn check(
    destination: &std::path::Path,
    id: &str,
    uninstaller: Option<&std::path::Path>,
) -> io::Result<bool> {
    use std::{os::windows::process::CommandExt, process::Command};
    let guid = IDENTITIES
        .iter()
        .find(|(known, _)| *known == id)
        .ok_or_else(invalid)?
        .1;
    let output = Command::new(crate::windows_paths::system_program(
        "WindowsPowerShell/v1.0/powershell.exe",
    )?)
    .args([
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        include_str!("windows-nsis-registration.ps1"),
    ])
    .env("HEXBOT_NSIS_GUID", guid)
    .creation_flags(0x08000000)
    .output()?;
    if !output.status.success() || output.stdout.len() > 32768 {
        return Err(invalid());
    }
    let entries: Vec<Registration> =
        serde_json::from_slice(&output.stdout).map_err(|_| invalid())?;
    let registered = entries
        .first()
        .is_some_and(|entry| entry.install && entry.uninstall);
    check_entries(destination, id, uninstaller, entries)?;
    Ok(registered)
}
fn check_entries(
    destination: &Path,
    id: &str,
    uninstaller: Option<&Path>,
    entries: Vec<Registration>,
) -> io::Result<()> {
    if !IDENTITIES.iter().any(|(known, _)| *known == id) {
        return Err(invalid());
    }
    if entries.len() != 2 {
        return Err(invalid());
    }
    for entry in entries {
        if !entry.install && !entry.uninstall {
            continue;
        }
        if !entry.install || !entry.uninstall {
            return Err(invalid());
        }
        let canonical = destination.canonicalize()?;
        let location = PathBuf::from(entry.location.ok_or_else(invalid)?);
        if !location.is_absolute() || !same_path(&location.canonicalize()?, &canonical) {
            return Err(invalid());
        }
        let command = entry.command.ok_or_else(invalid)?;
        let file = PathBuf::from(command_file(id, &command)?);
        if !file.is_absolute()
            || !fs::symlink_metadata(&file)
                .is_ok_and(|m| crate::detect::ordinary(&m) && m.is_file())
        {
            return Err(invalid());
        }
        let file = file.canonicalize()?;
        if !file
            .parent()
            .is_some_and(|parent| same_path(parent, &canonical))
            || uninstaller.is_some_and(|expected| {
                !expected
                    .canonicalize()
                    .is_ok_and(|expected| same_path(&expected, &file))
            })
        {
            return Err(invalid());
        }
    }
    Ok(())
}

fn same_path(first: &Path, second: &Path) -> bool {
    if cfg!(windows) {
        first
            .as_os_str()
            .to_string_lossy()
            .eq_ignore_ascii_case(&second.as_os_str().to_string_lossy())
    } else {
        first == second
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_known_identity_and_exact_quoted_current_user_uninstallers_are_executable() {
        for (id, _) in IDENTITIES {
            let base = if id.starts_with("app.hexbot.client") {
                "Hexbot Client"
            } else {
                "Hexbot"
            };
            let name = format!(
                "Uninstall {base}{}.exe",
                if id.ends_with(".nightly") {
                    " Nightly"
                } else {
                    " [alpha]"
                }
            );
            let path = format!("C:\\José state\\{id}\\{name}");
            assert_eq!(
                command_file(id, &format!("\"{path}\" /currentuser")).unwrap(),
                path
            );
            assert_eq!(
                command_file(id, &format!("\"{path}\"  /CURRENTUSER  ")).unwrap(),
                path
            );
            for bad in [
                format!("{path} /currentuser"),
                format!("\"{path}\" /allusers"),
                format!("\"{path}\""),
                format!("\"{path}\" /currentuser /D=C:\\other"),
                format!("\"{path}\" /currentuser && evil"),
                "\"C:\\foreign.exe\" /currentuser".into(),
            ] {
                assert!(command_file(id, &bad).is_err(), "{bad}");
            }
        }
        assert!(command_file("org.foreign", "\"C:\\Uninstall Hexbot.exe\" /currentuser").is_err());
    }
    #[test]
    fn canonical_registration_binding_refuses_partial_foreign_and_nonordinary_paths() {
        let root = tempfile::tempdir().unwrap();
        let destination = root.path().join("José app");
        fs::create_dir(&destination).unwrap();
        let file = destination.join("Uninstall Hexbot Client [alpha].exe");
        fs::write(&file, "not executed").unwrap();
        let absent = Registration {
            install: false,
            uninstall: false,
            location: None,
            command: None,
        };
        let bound = Registration {
            install: true,
            uninstall: true,
            location: Some(format!(
                "{}{sep}",
                destination.display(),
                sep = std::path::MAIN_SEPARATOR
            )),
            command: Some(format!("\"{}\" /currentuser", file.display())),
        };
        let id = "app.hexbot.client";
        assert!(
            check_entries(
                &destination,
                id,
                Some(&file),
                vec![bound.clone(), absent.clone()]
            )
            .is_ok()
        );
        assert!(
            check_entries(&destination, id, None, vec![absent.clone(), absent.clone()]).is_ok()
        );
        // Lexical aliases are accepted only after filesystem canonicalization.
        let alias = destination.join(".");
        let mut equivalent = bound.clone();
        equivalent.location = Some(alias.display().to_string());
        assert!(check_entries(&destination, id, None, vec![equivalent, absent.clone()]).is_ok());
        for case in [
            "install-only",
            "uninstall-only",
            "missing-location",
            "missing-command",
            "wrong-directory",
            "foreign-command",
            "extra-arguments",
        ] {
            let mut entry = bound.clone();
            match case {
                "install-only" => entry.uninstall = false,
                "uninstall-only" => entry.install = false,
                "missing-location" => entry.location = None,
                "missing-command" => entry.command = None,
                "wrong-directory" => entry.location = Some(root.path().display().to_string()),
                "foreign-command" => {
                    entry.command = Some(format!(
                        "\"{}\" /currentuser",
                        root.path()
                            .join("Uninstall Hexbot Client [alpha].exe")
                            .display()
                    ))
                }
                _ => entry.command = Some(format!("\"{}\" /currentuser garbage", file.display())),
            }
            assert!(
                check_entries(&destination, id, None, vec![entry, absent.clone()]).is_err(),
                "{case}"
            );
        }
        let other = destination.join("Uninstall Hexbot Client.exe");
        fs::write(&other, "different").unwrap();
        assert!(
            check_entries(
                &destination,
                id,
                Some(&other),
                vec![bound.clone(), absent.clone()]
            )
            .is_err()
        );
        fs::remove_file(&file).unwrap();
        fs::create_dir(&file).unwrap();
        assert!(
            check_entries(&destination, id, None, vec![bound.clone(), absent.clone()]).is_err()
        );
        #[cfg(unix)]
        {
            std::fs::remove_dir(&file).unwrap();
            std::os::unix::fs::symlink(&other, &file).unwrap();
            assert!(check_entries(&destination, id, None, vec![bound, absent]).is_err());
        }
    }
}
