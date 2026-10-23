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
    io::Error::other("Windows app registration is incomplete or belongs to another installation.")
}
pub(crate) fn uninstaller_filename(id: &str) -> Option<&'static str> {
    IDENTITIES.iter().any(|(known, _)| *known == id).then_some(
        if id.starts_with("app.hexbot.client") {
            "Uninstall HexbotClient.exe"
        } else {
            "Uninstall Hexbot.exe"
        },
    )
}
pub(crate) fn uninstaller_name(id: &str, name: &str) -> bool {
    // Pinned NSIS uses PRODUCT_FILENAME, which AppInfo derives from the
    // configured Windows executableName, not the channel's productName.
    uninstaller_filename(id).is_some_and(|expected| name.eq_ignore_ascii_case(expected))
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
    let raw = read(id)?;
    let entries: Vec<Registration> = serde_json::from_value(raw.clone()).map_err(|_| invalid())?;
    let registered = entries
        .first()
        .is_some_and(|entry| entry.install && entry.uninstall);
    if let Err(error) = check_entries(destination, id, uninstaller, entries) {
        eprintln!(
            "NSIS registry binding refused: {}",
            registration_diagnostic(destination, id, uninstaller, &raw)
        );
        return Err(error);
    }
    Ok(registered)
}
#[cfg(windows)]
fn read(id: &str) -> io::Result<serde_json::Value> {
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
        eprintln!(
            "NSIS registry read failed: status={}; stderr={:?}; stdoutBytes={}",
            output.status,
            String::from_utf8_lossy(&output.stderr)
                .chars()
                .take(2048)
                .collect::<String>(),
            output.stdout.len()
        );
        return Err(invalid());
    }
    serde_json::from_slice(&output.stdout).map_err(|_| invalid())
}

#[cfg(windows)]
pub(crate) fn missing(
    destination: &Path,
    id: &str,
) -> io::Result<crate::windows_recovery::Registration> {
    Ok(classify_missing(destination, id, &read(id)?))
}

fn classify_missing(
    destination: &Path,
    id: &str,
    raw: &serde_json::Value,
) -> crate::windows_recovery::Registration {
    use crate::windows_recovery::{Registration as Class, drive_path};
    let Some(entries) = raw.as_array().filter(|entries| entries.len() == 2) else {
        return Class::Other;
    };
    if entries[0]["scope"] != "CurrentUser"
        || entries[1]["scope"] != "LocalMachine"
        || entries.iter().any(|entry| entry["view"] != "Registry64")
    {
        return Class::Other;
    }
    let empty = |entry: &serde_json::Value| {
        entry["install"] == false
            && entry["uninstall"] == false
            && entry["location"].is_null()
            && entry["command"].is_null()
            && entry["locationType"].is_null()
            && entry["commandType"].is_null()
    };
    if !empty(&entries[1]) {
        return Class::Other;
    }
    let user = &entries[0];
    if empty(user) {
        return Class::None;
    }
    let Some(destination) = destination.to_str().and_then(drive_path) else {
        return Class::Other;
    };
    let Some(filename) = uninstaller_filename(id) else {
        return Class::Other;
    };
    let bound = user["install"] == true
        && user["uninstall"] == true
        && user["locationType"] == "String"
        && user["commandType"] == "String"
        && user["location"].as_str().and_then(drive_path).as_ref() == Some(&destination)
        && user["command"]
            .as_str()
            .filter(|s| s.len() <= 8192 && !s.chars().any(char::is_control))
            .and_then(|command| command_file(id, command).ok())
            .and_then(drive_path)
            == Some(format!("{destination}\\{}", filename.to_ascii_lowercase()));
    if bound {
        Class::ExactStale
    } else {
        Class::Other
    }
}

#[cfg(any(windows, test))]
fn registration_diagnostic(
    destination: &Path,
    id: &str,
    uninstaller: Option<&Path>,
    raw: &serde_json::Value,
) -> serde_json::Value {
    use serde_json::json;
    // Only fixed fields from the two known registry keys, bounded and JSON
    // escaped. Never enumerate unrelated registry data or execute its strings.
    let entries: Vec<_> = raw
        .as_array()
        .into_iter()
        .flatten()
        .take(2)
        .map(|entry| {
            let mut bounded = serde_json::Map::new();
            for key in [
                "scope",
                "view",
                "install",
                "uninstall",
                "location",
                "locationType",
                "command",
                "commandType",
            ] {
                let value = &entry[key];
                bounded.insert(
                    key.into(),
                    if let Some(text) = value.as_str() {
                        json!(text.chars().take(1024).collect::<String>())
                    } else if value.is_boolean() {
                        value.clone()
                    } else {
                        serde_json::Value::Null
                    },
                );
            }
            serde_json::Value::Object(bounded)
        })
        .collect();
    let bounded_path = |path: &Path| {
        path.to_string_lossy()
            .chars()
            .take(1024)
            .collect::<String>()
    };
    json!({"appId":id,"destination":bounded_path(destination),"expectedFilename":uninstaller_filename(id),"expectedArguments":"/currentuser","expectedUninstaller":uninstaller.map(bounded_path),"entries":entries})
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
    fn absent_registration_exception_is_exact_hkcu_only_and_never_resolves_strings() {
        use crate::windows_recovery::Registration as Class;
        use serde_json::json;
        let empty = json!({"scope":"LocalMachine","view":"Registry64","install":false,"uninstall":false,"location":null,"command":null,"locationType":null,"commandType":null});
        let mut empty_user = empty.clone();
        empty_user["scope"] = json!("CurrentUser");
        for (id, _) in IDENTITIES {
            let destination = format!(r"C:\José apps\{id}");
            let file = uninstaller_filename(id).unwrap();
            let user = json!({"scope":"CurrentUser","view":"Registry64","install":true,"uninstall":true,"location":format!("{destination}/"),
                "command":format!("\"{destination}\\{file}\" /currentuser"),"locationType":"String","commandType":"String"});
            assert_eq!(
                classify_missing(Path::new(&destination), id, &json!([empty_user, empty])),
                Class::None
            );
            assert_eq!(
                classify_missing(Path::new(&destination), id, &json!([user, empty])),
                Class::ExactStale
            );
            assert_eq!(
                classify_missing(Path::new(&destination), id, &json!([user, user])),
                Class::Other
            );
            for (field, value) in [
                ("install", json!(false)),
                ("uninstall", json!(false)),
                ("location", json!(null)),
                ("command", json!(null)),
                ("locationType", json!("ExpandString")),
                ("commandType", json!("ExpandString")),
                ("location", json!(format!("{destination}.nightly"))),
                ("location", json!(r"\\server\share")),
                ("location", json!(r"\\?\C:\José apps")),
                (
                    "command",
                    json!(format!("{destination}\\{file} /currentuser")),
                ),
                (
                    "command",
                    json!(format!("\"{destination}\\{file}\" /allusers")),
                ),
                (
                    "command",
                    json!(format!("\"{destination}\\{file}\" /currentuser /S")),
                ),
                (
                    "command",
                    json!(format!("\"{destination}\\unrecognized.exe\" /currentuser")),
                ),
            ] {
                let mut changed = user.clone();
                changed[field] = value;
                assert_eq!(
                    classify_missing(Path::new(&destination), id, &json!([changed, empty])),
                    Class::Other,
                    "{id} {field}"
                );
            }
        }
        assert_eq!(
            classify_missing(Path::new(r"C:\app"), "org.foreign", &json!([])),
            Class::Other
        );
    }

    #[test]
    fn binding_diagnostics_are_bounded_to_known_fields_and_escape_control_text() {
        let raw = serde_json::json!([{"scope":"CurrentUser","view":"Registry64","install":true,"uninstall":true,"location":"x".repeat(4096),"command":"\"C:\\Uninstall HexbotClient.exe\" /currentuser\nextra","locationType":"String","commandType":"String","unrelated":"not collected"}]);
        let diagnostic =
            registration_diagnostic(Path::new("expected app"), "app.hexbot.client", None, &raw);
        assert_eq!(diagnostic["expectedFilename"], "Uninstall HexbotClient.exe");
        assert_eq!(
            diagnostic["entries"][0]["location"].as_str().unwrap().len(),
            1024
        );
        assert_eq!(diagnostic["entries"][0]["commandType"], "String");
        assert!(diagnostic["entries"][0].get("unrelated").is_none());
        assert!(!diagnostic.to_string().contains('\n'));
    }
    #[test]
    fn executable_based_nsis_names_are_bound_to_the_known_edition() {
        for (id, _) in IDENTITIES {
            let filename = if id.starts_with("app.hexbot.client") {
                "Uninstall HexbotClient.exe"
            } else {
                "Uninstall Hexbot.exe"
            };
            let command = format!("\"C:\\José state\\{id}\\{filename}\" /currentuser");
            assert!(command_file(id, &command).is_ok(), "{id}: {command}");
            for foreign in [
                if id.starts_with("app.hexbot.client") {
                    "Uninstall Hexbot.exe"
                } else {
                    "Uninstall HexbotClient.exe"
                },
                "Uninstall Hexbot Client [alpha].exe",
                "Uninstall Hexbot Nightly.exe",
            ] {
                assert!(!uninstaller_name(id, foreign), "{id}: {foreign}");
            }
        }
    }
    #[test]
    fn only_known_identity_and_exact_quoted_current_user_uninstallers_are_executable() {
        for (id, _) in IDENTITIES {
            let name = uninstaller_filename(id).unwrap();
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
        let file = destination.join("Uninstall HexbotClient.exe");
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
                        root.path().join("Uninstall HexbotClient.exe").display()
                    ))
                }
                _ => entry.command = Some(format!("\"{}\" /currentuser garbage", file.display())),
            }
            assert!(
                check_entries(&destination, id, None, vec![entry, absent.clone()]).is_err(),
                "{case}"
            );
        }
        let other = destination.join("Uninstall Hexbot.exe");
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
