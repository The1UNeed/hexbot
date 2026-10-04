//! Shared by the daemon CLI and standalone installer. Fail closed on unknown files.
use std::{
    fs, io,
    path::{Path, PathBuf},
};

pub const WRAPPER_MARKER: &str = "# Hexbot CLI, written by hexbot setup";

pub fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

pub fn resolved(path: &Path) -> io::Result<PathBuf> {
    if !path.is_absolute()
        || path
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(io::Error::other("Expected an absolute path without '..'"));
    }
    match path.canonicalize() {
        Ok(path) => Ok(path),
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            // A broken symlink is not an absent path.
            if fs::symlink_metadata(path).is_ok() {
                return Err(e);
            }
            Ok(resolved(path.parent().ok_or(e)?)?.join(path.file_name().unwrap()))
        }
        Err(e) => Err(e),
    }
}

pub fn wrapper_home(text: &str) -> Option<PathBuf> {
    if !text.lines().any(|line| line == WRAPPER_MARKER) {
        return None;
    }
    let mut lines = text
        .lines()
        .filter_map(|line| line.strip_prefix("export HEXBOT_HOME="));
    let value = lines.next()?;
    if lines.next().is_some() {
        return None;
    }
    let decoded = value
        .strip_prefix('\'')?
        .strip_suffix('\'')?
        .replace("'\\''", "'");
    (shell_quote(&decoded) == value).then(|| PathBuf::from(decoded))
}

pub fn wrapper_owned(path: &Path, home: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|m| m.is_file())
        && fs::read_to_string(path)
            .ok()
            .and_then(|s| wrapper_home(&s))
            .is_some_and(|owner| {
                resolved(&owner)
                    .ok()
                    .zip(resolved(home).ok())
                    .is_some_and(|(a, b)| a == b)
            })
}

fn xml_string(text: &str, key: &str, array: bool) -> Option<String> {
    let marker = format!("<key>{key}</key>");
    let mut pieces = text.split(&marker);
    pieces.next()?;
    let mut value = pieces.next()?.trim_start();
    if pieces.next().is_some() {
        return None;
    }
    if array {
        value = value.strip_prefix("<array>")?.trim_start();
    }
    let value = value.strip_prefix("<string>")?.split_once("</string>")?.0;
    Some(
        value
            .replace("&quot;", "\"")
            .replace("&apos;", "'")
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&amp;", "&"),
    )
}

fn unit_value(text: &str, prefix: &str, suffix: &str) -> Option<String> {
    let mut lines = text.lines().filter_map(|line| line.strip_prefix(prefix));
    let value = lines.next()?.strip_suffix(suffix)?;
    if lines.next().is_some() {
        return None;
    }
    let value = value.strip_prefix('"')?.strip_suffix('"')?;
    let mut result = String::new();
    let mut chars = value.chars();
    while let Some(ch) = chars.next() {
        result.push(if ch == '\\' {
            match chars.next()? {
                c @ ('\\' | '"') => c,
                _ => return None,
            }
        } else if ch == '%' {
            if chars.next()? != '%' {
                return None;
            }
            '%'
        } else {
            ch
        });
    }
    Some(result)
}

pub fn check_service(path: &Path, home: &Path, macos: bool) -> io::Result<()> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
    };
    if !metadata.is_file() {
        return Err(io::Error::other(
            "Refusing a symlink or non-file Hexbot service definition",
        ));
    }
    let text = fs::read_to_string(path)?;
    if text.matches("HEXBOT_HOME").count() != 1
        || (!macos && text.matches("ExecStart=").count() != 1)
    {
        return Err(io::Error::other(
            "Cannot identify the owner of the Hexbot service; left it alone",
        ));
    }
    let (owner, executable) = if macos {
        (
            xml_string(&text, "HEXBOT_HOME", false),
            xml_string(&text, "ProgramArguments", true),
        )
    } else {
        (
            unit_value(&text, "Environment=HEXBOT_HOME=", ""),
            unit_value(&text, "ExecStart=", " serve"),
        )
    };
    let owner = owner.ok_or_else(|| {
        io::Error::other("Cannot identify the home of the existing Hexbot service; left it alone")
    })?;
    let expected = resolved(home)?;
    if resolved(Path::new(&owner))? != expected {
        return Err(io::Error::other(format!(
            "The Hexbot service on this computer belongs to {owner}. Uninstall it from there first."
        )));
    }
    let executable = executable.ok_or_else(|| {
        io::Error::other("Cannot identify the executable of the existing Hexbot service")
    })?;
    let executable = Path::new(&executable);
    // Allow a broken stable pointer so the service can still be uninstalled.
    let stable = executable
        .file_name()
        .is_some_and(|n| n == "native-executable")
        && executable.parent().and_then(|p| resolved(p).ok()) == Some(expected.join("runtime"));
    let stable = stable
        && match fs::symlink_metadata(executable) {
            Ok(meta) if meta.file_type().is_symlink() => {
                let link = fs::read_link(executable)?;
                let link = if link.is_absolute() {
                    link
                } else {
                    executable.parent().unwrap().join(link)
                };
                resolved(&link).is_ok_and(|p| p.starts_with(expected.join("runtime/native")))
            }
            Ok(meta) => meta.is_file(),
            Err(e) if e.kind() == io::ErrorKind::NotFound => true,
            Err(e) => return Err(e),
        };
    let native = resolved(executable).is_ok_and(|p| p.starts_with(expected.join("runtime/native")));
    if !stable && !native {
        return Err(io::Error::other(
            "The Hexbot service executable does not belong to this home; left it alone",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn service_ownership_checks_home_and_executable_on_both_platforms() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home %n & space");
        fs::create_dir(&home).unwrap();
        let home = home.canonicalize().unwrap();
        let other = root.path().join("other");
        fs::create_dir(&other).unwrap();
        let file = root.path().join("service");
        for macos in [false, true] {
            let text = if macos {
                include_str!("../tests/fixtures/daemon.plist").replace(
                    "/home/me/.hexbot",
                    &home.to_string_lossy().replace('&', "&amp;"),
                )
            } else {
                include_str!("../tests/fixtures/daemon.service").replace(
                    "/home/me/.hexbot",
                    &home.to_string_lossy().replace('%', "%%"),
                )
            };
            fs::write(&file, &text).unwrap();
            check_service(&file, &home, macos).unwrap();
            assert!(
                check_service(&file, &other, macos)
                    .unwrap_err()
                    .to_string()
                    .contains("belongs to")
            );
            fs::write(
                &file,
                text.replace("runtime/native-executable", "unrelated"),
            )
            .unwrap();
            assert!(check_service(&file, &home, macos).is_err());
        }
    }
}
