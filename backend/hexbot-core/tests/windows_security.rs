//! Run after combining the Windows build ports with the security foundation.
//! These tests prove refusal, not a working Windows sandbox.
#![cfg(windows)]

use hexbot_core::credentials::{self, Confine};

#[test]
fn windows_security_all_isolation_levels_refuse_before_launch_or_scan() {
    // A missing home and device paths must get the same explicit refusal. No
    // scanner, shell lookup, Python runtime or process limit probe may run first.
    for mode in [Confine::Workspace, Confine::ReadOnly, Confine::No] {
        for program in ["cmd.exe", "python.exe", "git.exe", r"\\.\pipe\hexbot"] {
            let error = credentials::isolated_command(
                std::path::Path::new(r"Z:\missing\hexbot"),
                program,
                &[std::path::PathBuf::from(r"\\.\pipe\workspace")],
                mode,
            )
            .unwrap_err();
            assert_eq!(error.code, 4302);
            assert!(
                error
                    .message
                    .contains("Windows tool isolation is not implemented")
            );
        }
    }
    assert!(!credentials::isolation_available());
    assert_eq!(credentials::sandbox(), None);
    assert!(credentials::require_isolation().is_err());
}
