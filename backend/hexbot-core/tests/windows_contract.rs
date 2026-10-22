#![cfg(windows)]
//! Native CI only. Requires the real signed update ZIP generated from this build.
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
