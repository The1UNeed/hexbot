//! Windows execution remains unsupported until its containment contract passes
//! native standard-user tests. Never substitute approval for this boundary.
//!
//! In particular, do not grant recursive access to the user's home or workspace:
//! inherited grants would also expose secrets and writable Git/runtime metadata.
//! This module deliberately creates no processes, profiles, or ACL entries.

pub const UNAVAILABLE: &str = "Windows tool isolation is not implemented. Auto and Manual cannot run local commands, code, or file tools on Windows, including approved full_access requests. Windows remains unsupported. Bypass has no sandbox or credential protection.";

pub fn require() -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        UNAVAILABLE,
    ))
}
