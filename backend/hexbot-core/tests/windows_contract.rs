#![cfg(windows)]
//! Native CI only. Requires the real signed update ZIP generated from this build.
#[path = "../src/windows_paths.rs"]
mod windows_paths;

// Comparative publication controls. The current path is the public
// `common::atomic_write` (tempfile persist). The candidate below is private to
// this file: it closes the temp, clears only that owned temp's attributes,
// publishes with std::fs::rename, and disables cleanup only after success.
// These prove a mechanism; they do not identify the operation that failed in CI.
mod publication {
    use std::{
        fs,
        io::{self, Read, Seek, Write},
        os::windows::{
            ffi::OsStrExt,
            fs::{MetadataExt, OpenOptionsExt},
        },
        path::Path,
    };
    const SHARE_READ_WRITE: u32 = 0x1 | 0x2;
    const SHARE_ALL: u32 = SHARE_READ_WRITE | 0x4;
    const ATTRIBUTE_TEMPORARY: u32 = 0x100;

    fn candidate(path: &Path, bytes: &[u8]) -> io::Result<()> {
        unsafe extern "system" {
            fn SetFileAttributesW(path: *const u16, attributes: u32) -> i32;
        }
        let mut file = tempfile::NamedTempFile::new_in(path.parent().unwrap())?;
        file.write_all(bytes)?;
        file.as_file().sync_all()?;
        let mut owned = file.into_temp_path();
        let wide: Vec<u16> = owned.as_os_str().encode_wide().chain(Some(0)).collect();
        if unsafe { SetFileAttributesW(wide.as_ptr(), 0x80) } == 0 {
            return Err(io::Error::last_os_error());
        }
        // A failure here leaves cleanup enabled, so the temp is removed on drop.
        fs::rename(&owned, path)?;
        owned.disable_cleanup(true);
        Ok(())
    }
    fn current(path: &Path, bytes: &[u8]) -> Result<(), String> {
        hexbot_core::common::atomic_write(path, bytes).map_err(|error| error.message)
    }
    fn reader(path: &Path, share: u32) -> fs::File {
        fs::OpenOptions::new()
            .read(true)
            .share_mode(share)
            .open(path)
            .unwrap()
    }
    fn reread(file: &mut fs::File) -> Vec<u8> {
        file.rewind().unwrap();
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes).unwrap();
        bytes
    }
    // Only the named destinations may remain: refused publications leave no temp.
    fn entries(directory: &Path) -> Vec<String> {
        let mut names: Vec<_> = fs::read_dir(directory)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }
    fn sddl(path: &Path) -> String {
        let program =
            super::windows_paths::system_program("WindowsPowerShell/v1.0/powershell.exe").unwrap();
        let output = std::process::Command::new(program)
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "(Get-Acl -LiteralPath $env:HEXBOT_ACL_PATH).Sddl",
            ])
            .env("HEXBOT_ACL_PATH", path)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap().trim().to_owned()
    }

    #[test]
    fn a_held_reader_that_allows_delete_blocks_persist_but_not_the_candidate() {
        let root = tempfile::tempdir().unwrap();
        for (name, publish) in [("current", true), ("candidate", false)] {
            let path = root.path().join(format!("{name}.json"));
            fs::write(&path, b"old").unwrap();
            let mut held = reader(&path, SHARE_ALL);
            let result = if publish {
                current(&path, b"new")
            } else {
                candidate(&path, b"new").map_err(|error| error.to_string())
            };
            eprintln!("Publication with a delete-sharing reader: {name}={result:?}");
            if publish {
                let message = result.unwrap_err();
                assert!(message.starts_with("replace current.json: "), "{message}");
                assert!(message.contains("(os error 5)"), "{message}");
                assert_eq!(fs::read(&path).unwrap(), b"old");
            } else {
                result.unwrap();
                assert_eq!(fs::read(&path).unwrap(), b"new");
            }
            // The retained reader keeps the bytes it opened in every case.
            assert_eq!(reread(&mut held), b"old");
        }
        assert_eq!(entries(root.path()), ["candidate.json", "current.json"]);
    }

    #[test]
    fn readers_without_delete_sharing_and_read_only_files_are_refused_by_both() {
        let root = tempfile::tempdir().unwrap();
        for (name, publish) in [("current", true), ("candidate", false)] {
            let path = root.path().join(format!("{name}.json"));
            fs::write(&path, b"old").unwrap();
            let held = reader(&path, SHARE_READ_WRITE);
            let refused = if publish {
                current(&path, b"new").err()
            } else {
                candidate(&path, b"new")
                    .err()
                    .map(|error| error.to_string())
            };
            eprintln!("Publication with a non-delete reader: {name}={refused:?}");
            assert!(refused.is_some(), "{name}");
            drop(held);
            assert_eq!(fs::read(&path).unwrap(), b"old");

            let original = fs::metadata(&path).unwrap().permissions();
            let mut read_only = original.clone();
            read_only.set_readonly(true);
            fs::set_permissions(&path, read_only).unwrap();
            let refused = if publish {
                current(&path, b"new").err()
            } else {
                candidate(&path, b"new")
                    .err()
                    .map(|error| error.to_string())
            };
            eprintln!("Publication over a read-only file: {name}={refused:?}");
            assert!(refused.is_some(), "{name}");
            assert_eq!(fs::read(&path).unwrap(), b"old");
            fs::set_permissions(&path, original).unwrap();
        }
        assert_eq!(entries(root.path()), ["candidate.json", "current.json"]);
    }

    #[test]
    fn ordinary_publication_matches_attributes_and_inherited_permissions() {
        let root = tempfile::tempdir().unwrap();
        let current_path = root.path().join("current.json");
        let candidate_path = root.path().join("candidate.json");
        for round in [b"first".as_slice(), b"second".as_slice()] {
            current(&current_path, round).unwrap();
            candidate(&candidate_path, round).unwrap();
            for path in [&current_path, &candidate_path] {
                let metadata = fs::metadata(path).unwrap();
                assert_eq!(fs::read(path).unwrap(), round);
                assert_eq!(
                    metadata.file_attributes() & ATTRIBUTE_TEMPORARY,
                    0,
                    "{path:?}"
                );
                assert!(!metadata.permissions().readonly(), "{path:?}");
            }
            assert_eq!(sddl(&current_path), sddl(&candidate_path));
        }
        assert_eq!(entries(root.path()), ["candidate.json", "current.json"]);
    }
}

#[tokio::test]
#[ignore = "requires HEXBOT_WINDOWS_UPDATE_ROOT with a real locally built runtime"]
async fn signed_zip_update_and_connect_executable() {
    hexbot_core::services::windows_contract_tests::windows_contract_signed_zip_update_and_connect_executable().await;
}

#[test]
fn damaged_manifests_cannot_lower_the_native_publication_floor() {
    hexbot_core::services::windows_contract_tests::publication_floor();
}

#[tokio::test]
async fn uv_repair_replaces_ordinary_existing_bytes_and_missing_or_stale_receipts() {
    use sha2::{Digest, Sha256};
    use std::{fs, io::Write};
    let root = tempfile::tempdir().unwrap();
    let archive = root.path().join("uv.zip");
    let expected = b"verified normal UV fixture bytes";
    let mut zip = zip::ZipWriter::new(fs::File::create(&archive).unwrap());
    zip.start_file("uv.exe", zip::write::SimpleFileOptions::default())
        .unwrap();
    zip.write_all(expected).unwrap();
    zip.finish().unwrap();
    let home = root.path().join("home");
    fs::create_dir_all(home.join("bin")).unwrap();
    let exe = home.join("bin/uv.exe");
    let receipt = home.join("bin/uv-version");
    let old = b"old ordinary executable bytes";
    for record in [
        None,
        Some(b"not JSON".to_vec()),
        Some(
            serde_json::json!({"version":"old","sha256":format!("{:x}",Sha256::digest(old))})
                .to_string()
                .into_bytes(),
        ),
        Some(
            serde_json::json!({"version":"native-contract","sha256":"0".repeat(64)})
                .to_string()
                .into_bytes(),
        ),
    ] {
        fs::write(&exe, old).unwrap();
        if let Some(record) = record {
            fs::write(&receipt, record).unwrap();
        } else if receipt.exists() {
            fs::remove_file(&receipt).unwrap();
        }
        let installed = hexbot_core::setup::windows_contract_install_uv(&home, &archive)
            .await
            .unwrap();
        assert_eq!(installed, exe);
        assert_eq!(fs::read(&exe).unwrap(), expected);
        let record: serde_json::Value =
            serde_json::from_slice(&fs::read(&receipt).unwrap()).unwrap();
        assert_eq!(record["version"], "native-contract");
        assert_eq!(record["sha256"], format!("{:x}", Sha256::digest(expected)));
    }
}

#[test]
fn setup_revalidates_a_concurrent_newer_runtime_and_preserves_automatic_update_floor() {
    hexbot_core::services::windows_contract_tests::setup_retains_newer();
}
