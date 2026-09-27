//! Local compatibility driver, deliberately not a replacement `hexbot serve`.

use std::{
    io::{self, BufRead, Read, Write},
    path::{Component, Path, PathBuf},
};

use hexbot_core::{Error, Result, db, memory::MemoryStore, rpc};

const MAX_REQUEST_BYTES: u64 = 1024 * 1024;

fn resolved_path(path: &Path) -> Result<PathBuf> {
    if !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, Component::ParentDir))
    {
        return Err(Error::new(
            4200,
            "home paths must be absolute and must not contain '..'",
        ));
    }
    // Resolve existing symlinks even when the final directory does not exist.
    let mut ancestor = path;
    let base = loop {
        match ancestor.canonicalize() {
            Ok(base) => break base,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                ancestor = ancestor
                    .parent()
                    .ok_or_else(|| Error::new(4200, "invalid home"))?;
            }
            Err(error) => return Err(error.into()),
        }
    };
    let mut result = base;
    for component in path.strip_prefix(ancestor).unwrap().components() {
        match component {
            Component::Normal(name) => result.push(name),
            Component::ParentDir => {
                result.pop();
            }
            Component::CurDir => {}
            _ => return Err(Error::new(4200, "invalid home")),
        }
    }
    Ok(result)
}

fn check_development_home(home: &Path, live: &Path) -> Result<()> {
    if resolved_path(home)?.starts_with(resolved_path(live)?) {
        return Err(Error::new(
            4200,
            "copy the live ~/.hexbot home before using this development driver",
        ));
    }
    Ok(())
}

fn run() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let command = args.next().unwrap_or_default();
    let mut home = None;
    let mut user = None;
    while let Some(flag) = args.next() {
        match flag.as_str() {
            "--home" if home.is_none() => home = args.next().map(PathBuf::from),
            "--user" if user.is_none() => user = args.next(),
            _ => return Err(Error::new(4200, format!("unexpected argument: {flag}"))),
        }
    }
    if !matches!(command.as_str(), "migrate" | "memory-rpc") {
        return Err(Error::new(
            4200,
            "usage: hexbot-core migrate --home DIR | memory-rpc --home DIR --user USER",
        ));
    }
    let home =
        home.ok_or_else(|| Error::new(4200, "--home is required; use a temporary home or a copy"))?;
    if !home.is_absolute() {
        return Err(Error::new(4200, "--home must be an absolute path"));
    }
    if command == "memory-rpc" && user.is_none() {
        return Err(Error::new(
            4200,
            "--user is required for the local memory RPC driver",
        ));
    }
    // This development driver must not silently upgrade the user's real daemon.
    let user_home = std::env::var_os("HOME")
        .filter(|value| !value.is_empty())
        .ok_or_else(|| Error::new(4200, "HOME is required to protect the live daemon's files"))?;
    let live = PathBuf::from(user_home).join(".hexbot");
    check_development_home(&home, &live)?;
    db::migrate(&home)?;
    if command == "migrate" {
        println!("{{\"schema_version\":{}}}", db::SCHEMA_VERSION);
        return Ok(());
    }
    let store = MemoryStore::new(home);
    let caller = user.unwrap();
    let mut input = io::stdin().lock();
    let mut output = io::stdout().lock();
    loop {
        let mut bytes = Vec::new();
        let read = (&mut input)
            .take(MAX_REQUEST_BYTES + 1)
            .read_until(b'\n', &mut bytes)?;
        if read == 0 {
            break;
        }
        if read as u64 > MAX_REQUEST_BYTES {
            return Err(Error::new(4200, "request exceeds 1 MiB"));
        }
        let response = match serde_json::from_slice(&bytes) {
            Ok(request) => rpc::dispatch(&store, &caller, request),
            Err(_) => Some(rpc::parse_error()),
        };
        if let Some(response) = response {
            writeln!(output, "{response}")?;
            output.flush()?;
        }
    }
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn development_driver_refuses_live_home_descendants_and_aliases() {
        let temp = tempfile::tempdir().unwrap();
        let live = temp.path().join("live");
        assert!(check_development_home(&live, &live).is_err());
        assert!(check_development_home(&live.join("child"), &live).is_err());
        assert!(check_development_home(&temp.path().join("copy"), &live).is_ok());
        std::fs::create_dir(&live).unwrap();
        #[cfg(unix)]
        {
            let alias = temp.path().join("alias");
            std::os::unix::fs::symlink(&live, &alias).unwrap();
            assert!(check_development_home(&alias.join("child"), &live).is_err());
            assert!(check_development_home(&temp.path().join("missing/../alias"), &live).is_err());
            assert!(!live.join("hexbot.db").exists());
        }
    }
}
