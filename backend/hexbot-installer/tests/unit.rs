mod common;
use base64::{Engine, engine::general_purpose::STANDARD};
use hexbot_installer::{
    Artifact, InstallOption, Manifest, Receipt, Target, Track, detect_at, extract_native,
    read_receipt, verify_file,
};
use sha2::{Digest, Sha256, Sha512};
use std::{fs, io::Write};

#[test]
fn manifest_accepts_future_fields_and_missing_options() {
    let manifest: Manifest = serde_json::from_value(serde_json::json!({
        "schema":1,"channel":"stable","version":"0.1.0","minInstaller":"0.0.1","future":true,
        "targets":{"linux-x86_64":{"client":{"url":"https://example.test/client","sha512":"test","size":12,"format":"AppImage","productName":"Hexbot Client","appId":"app.hexbot.client","future":{}}}}
    })).unwrap();
    manifest.validate("0.1.0").unwrap();
    assert!(
        manifest
            .artifact(Target::LinuxX86_64, InstallOption::Headless)
            .is_err()
    );
    assert_eq!(
        manifest
            .artifact(Target::LinuxX86_64, InstallOption::Client)
            .unwrap()
            .size,
        12
    );
    assert!(
        manifest
            .validate("0.0.0")
            .unwrap_err()
            .to_string()
            .contains("This installer is too old.")
    );
}

#[test]
fn target_names_match_the_release_manifest() {
    for (os, arch, expected) in [
        ("macos", "aarch64", "macos-aarch64"),
        ("macos", "x86_64", "macos-x86_64"),
        ("linux", "x86_64", "linux-x86_64"),
    ] {
        let target = Target::from_platform(os, arch).unwrap();
        assert_eq!(target.to_string(), expected);
        assert_eq!(
            serde_json::to_string(&target).unwrap(),
            format!("\"{expected}\"")
        );
    }
    assert!(Target::from_platform("windows", "x86_64").is_err());
    assert!(Target::from_platform("linux", "aarch64").is_err());
}

#[test]
fn receipt_round_trip_and_legacy_detection_are_isolated() {
    let root = tempfile::tempdir().unwrap();
    let paths = common::paths(root.path());
    fs::create_dir_all(paths.receipt().parent().unwrap()).unwrap();
    let receipt = Receipt {
        option: InstallOption::Full,
        channel: Track::Nightly,
        version: "0.1.0".into(),
        paths: vec![root.path().join("apps/Hexbot.app")],
        installed_at: "2026-10-04T00:00:00Z".into(),
    };
    fs::write(paths.receipt(), serde_json::to_vec(&receipt).unwrap()).unwrap();
    let read = read_receipt(&paths.receipt()).unwrap().unwrap();
    assert_eq!(read.option, InstallOption::Full);
    assert_eq!(read.channel, Track::Nightly);
    assert_eq!(read.paths, receipt.paths);
    fs::remove_file(paths.receipt()).unwrap();
    let target = Target::detect().unwrap();
    let apps = paths.apps_override.as_ref().unwrap();
    fs::create_dir_all(apps).unwrap();
    if target.is_macos() {
        common::bundle(&apps.join("Renamed.app"), "app.hexbot.client.nightly");
        common::bundle(&apps.join("Hexbot.app"), "org.example.unrelated");
    } else {
        fs::write(
            apps.join("HexbotClient-0.1.0-nightly.1-linux-x86_64.AppImage"),
            b"\x7fELFapp",
        )
        .unwrap();
        fs::write(apps.join("Unrelated.AppImage"), "app").unwrap();
    }
    let installed = detect_at(&paths, target).unwrap();
    assert_eq!(installed.apps.len(), 1);
    assert_eq!(installed.option(), Some(InstallOption::Client));
    assert_eq!(installed.track(), Some(Track::Nightly));
    assert!(!installed.service);
    fs::create_dir_all(paths.service_file(target).parent().unwrap()).unwrap();
    fs::write(paths.service_file(target), "fake service").unwrap();
    assert!(!detect_at(&paths, target).unwrap().service);
    fs::write(paths.receipt(), "not json").unwrap();
    assert!(read_receipt(&paths.receipt()).is_err());
}

#[test]
fn verifies_both_hash_algorithms_and_rejects_missing_or_bad_checksums() {
    let root = tempfile::tempdir().unwrap();
    let file = root.path().join("download");
    fs::write(&file, b"hello").unwrap();
    let mut artifact = Artifact {
        url: "https://example.test".into(),
        sha256: Some(format!("{:x}", Sha256::digest(b"hello"))),
        sha512: Some(STANDARD.encode(Sha512::digest(b"hello"))),
        size: 5,
        format: None,
        product_name: None,
        app_id: None,
    };
    verify_file(&file, &artifact, InstallOption::Headless).unwrap();
    verify_file(&file, &artifact, InstallOption::Client).unwrap();
    artifact.sha256 = None;
    assert!(verify_file(&file, &artifact, InstallOption::Headless).is_err());
    fs::write(&file, b"wrong").unwrap();
    assert!(verify_file(&file, &artifact, InstallOption::Full).is_err());
    artifact.sha512 = Some("%%%".into());
    assert!(verify_file(&file, &artifact, InstallOption::Full).is_err());
}

#[test]
fn extraction_rejects_traversal_absolute_paths_and_links() {
    let root = tempfile::tempdir().unwrap();
    for (i, (path, kind, link)) in [
        ("../outside", tar::EntryType::Regular, ""),
        ("/tmp/outside", tar::EntryType::Regular, ""),
        ("safe/link", tar::EntryType::Symlink, "../../outside"),
        ("safe/link", tar::EntryType::Link, "../../outside"),
    ]
    .into_iter()
    .enumerate()
    {
        let archive = root.path().join(format!("{i}.tar.gz"));
        let mut header = tar::Header::new_gnu();
        header.set_entry_type(kind);
        header.set_size(0);
        header.set_mode(0o755);
        // Raw header permits adversarial names rejected by tar::Builder.
        header.as_mut_bytes()[..path.len()].copy_from_slice(path.as_bytes());
        if !link.is_empty() {
            header.set_link_name(link).unwrap();
        }
        header.set_cksum();
        let mut gzip = flate2::write::GzEncoder::new(
            fs::File::create(&archive).unwrap(),
            flate2::Compression::default(),
        );
        gzip.write_all(header.as_bytes()).unwrap();
        gzip.write_all(&[0; 1024]).unwrap();
        gzip.finish().unwrap();
        assert!(extract_native(&archive, &root.path().join(format!("out-{i}"))).is_err());
    }
    assert!(!root.path().join("outside").exists());
    let artifact = common::native_artifact(root.path(), "http://127.0.0.1");
    assert!(artifact.size > 0);
    extract_native(
        &root.path().join("native.tar.gz"),
        &root.path().join("valid"),
    )
    .unwrap();
    assert!(root.path().join("valid/hexbot").is_file());
}
