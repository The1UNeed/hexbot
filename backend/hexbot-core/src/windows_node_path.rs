/// Node's JavaScript CLI arguments need ordinary absolute DOS/UNC paths.
/// Preserve canonical validation separately; strip only Windows' namespace
/// spelling after resolution, without re-resolving a lexical untrusted path.
#[cfg(windows)]
pub fn node_path(path: &std::path::Path) -> std::io::Result<std::path::PathBuf> {
    use std::{
        ffi::OsString,
        path::{Component, PathBuf, Prefix},
    };
    let mut components = path.components();
    let Some(Component::Prefix(prefix)) = components.next() else {
        return Ok(path.to_owned());
    };
    let mut normalized = match prefix.kind() {
        Prefix::VerbatimDisk(drive) => PathBuf::from(format!("{}:\\", char::from(drive))),
        Prefix::VerbatimUNC(server, share) => {
            let mut root = OsString::from("\\\\");
            root.push(server);
            root.push("\\");
            root.push(share);
            root.push("\\");
            PathBuf::from(root)
        }
        Prefix::Verbatim(_) | Prefix::DeviceNS(_) => {
            return Err(std::io::Error::other("Unsupported Node device path"));
        }
        _ => return Ok(path.to_owned()),
    };
    if !matches!(components.next(), Some(Component::RootDir)) {
        return Err(std::io::Error::other("Node path must be absolute"));
    }
    normalized.extend(components);
    Ok(normalized)
}
