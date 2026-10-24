use super::{tests::bundle, *};

// native_transition.install still writes precisely this legacy identity, without
// files or builtAt. Its real writer is covered in test_native_transition.py.
fn handoff_record(home: &Path, executable: &Path, manifest: &Value) -> PathBuf {
    let record = home.join("runtime/native-current.json");
    fs::write(
        &record,
        json!({"version": manifest["version"], "executable": executable, "previous": null})
            .to_string(),
    )
    .unwrap();
    record
}

#[test]
fn legacy_handoff_reuses_verified_bytes_and_allows_strictly_newer_selection() {
    let home = tempfile::tempdir().unwrap();
    let (source, manifest) = bundle("0.1.5-nightly.20261022.58", 200);
    let executable = select(home.path(), source.path(), &manifest).unwrap();
    let record = handoff_record(home.path(), &executable, &manifest);
    let before = fs::read(&record).unwrap();
    let native = services::native_directory(home.path()).unwrap();
    assert!(matches!(selected(&native), Selected::Verified(..)));
    assert_eq!(
        services::native_chronology_floor(&native, true).unwrap(),
        200
    );
    assert_eq!(
        select(home.path(), source.path(), &manifest).unwrap(),
        executable
    );
    assert_eq!(fs::read(&record).unwrap(), before);
    for at in [0, 200] {
        let (candidate, manifest) = bundle("0.1.5-nightly.20261022.59", at);
        assert_eq!(
            services::publish_native(
                &native,
                manifest["version"].as_str().unwrap(),
                candidate.path(),
                "hexbot",
                Some(&manifest)
            )
            .unwrap_err()
            .code,
            4212
        );
        assert_eq!(fs::read(&record).unwrap(), before);
    }
    let (candidate, manifest) = bundle("0.1.5-nightly.20261022.59", 300);
    assert_ne!(
        select(home.path(), candidate.path(), &manifest).unwrap(),
        executable
    );
    assert_eq!(read_manifest(&record).unwrap()["builtAt"], 300);
}

#[test]
fn handoff_hash_omission_does_not_erase_any_known_floor() {
    let home = tempfile::tempdir().unwrap();
    let (source, manifest) = bundle("0.1.5-nightly.20261022.58", 200);
    let executable = select(home.path(), source.path(), &manifest).unwrap();
    let record = handoff_record(home.path(), &executable, &manifest);
    let mut identity = read_manifest(&record).unwrap();
    identity["builtAt"] = json!(350);
    identity["updateManifest"] = json!({"builtAt": 400});
    fs::write(&record, identity.to_string()).unwrap();
    fs::write(
        home.path().join("runtime/native-running.json"),
        json!({"builtAt": 450, "pid": std::process::id(), "executable": executable}).to_string(),
    )
    .unwrap();
    let native = services::native_directory(home.path()).unwrap();
    assert!(matches!(selected(&native), Selected::Verified(..)));
    assert_eq!(
        services::native_chronology_floor(&native, true).unwrap(),
        450
    );
    let (candidate, manifest) = bundle("0.1.5-nightly.20261022.59", 450);
    assert_eq!(
        select(home.path(), candidate.path(), &manifest).unwrap(),
        executable
    );
    assert_eq!(
        services::publish_native(
            &native,
            manifest["version"].as_str().unwrap(),
            candidate.path(),
            "hexbot",
            Some(&manifest)
        )
        .unwrap_err()
        .code,
        4212
    );
    let (candidate, manifest) = bundle("0.1.5-nightly.20261022.59", 500);
    select(home.path(), candidate.path(), &manifest).unwrap();
    assert_eq!(read_manifest(&record).unwrap()["builtAt"], 500);
}

#[test]
fn present_invalid_handoff_hash_maps_and_identity_conflicts_still_refuse() {
    for damage in [
        "null",
        "incomplete",
        "conflicting",
        "version",
        "executable",
        "target",
        "lower-floor",
    ] {
        let home = tempfile::tempdir().unwrap();
        let (source, manifest) = bundle("0.1.5-nightly.20261022.58", 200);
        let executable = select(home.path(), source.path(), &manifest).unwrap();
        let record = handoff_record(home.path(), &executable, &manifest);
        let mut identity = read_manifest(&record).unwrap();
        match damage {
            "null" => identity["files"] = Value::Null,
            "incomplete" => identity["files"] = json!({"hexbot": manifest["files"]["hexbot"]}),
            "conflicting" => {
                identity["files"] = manifest["files"].clone();
                identity["files"]["hexbot"] = json!("0".repeat(64));
            }
            "version" => identity["version"] = json!("0.1.5"),
            "executable" => identity["executable"] = json!(source.path().join("hexbot")),
            "target" => identity["target"] = json!("another-target"),
            "lower-floor" => identity["builtAt"] = json!(100),
            _ => unreachable!(),
        }
        fs::write(&record, identity.to_string()).unwrap();
        let before = fs::read(&record).unwrap();
        let native = services::native_directory(home.path()).unwrap();
        assert!(
            matches!(selected(&native), Selected::Damaged(None)),
            "{damage}"
        );
        let (candidate, newer) = bundle("0.1.5-nightly.20261022.59", 300);
        assert_eq!(
            select(home.path(), candidate.path(), &newer)
                .unwrap_err()
                .code,
            4212,
            "{damage}"
        );
        assert_eq!(fs::read(&record).unwrap(), before);
    }
}

#[test]
fn handoff_requires_the_selected_manifest_and_actual_intact_bytes() {
    for damage in ["missing-manifest", "missing-record", "bytes", "permission"] {
        let home = tempfile::tempdir().unwrap();
        let (source, manifest) = bundle("0.1.5-nightly.20261022.58", 200);
        let executable = select(home.path(), source.path(), &manifest).unwrap();
        let record = handoff_record(home.path(), &executable, &manifest);
        match damage {
            "missing-manifest" => {
                fs::remove_file(executable.with_file_name("manifest.json")).unwrap()
            }
            "missing-record" => fs::remove_file(&record).unwrap(),
            "bytes" => fs::write(&executable, "different bytes").unwrap(),
            "permission" => fs::set_permissions(
                executable.with_file_name("hexbot-core"),
                fs::Permissions::from_mode(0o644),
            )
            .unwrap(),
            _ => unreachable!(),
        }
        let native = services::native_directory(home.path()).unwrap();
        assert!(
            matches!(selected(&native), Selected::Damaged(_)),
            "{damage}"
        );
        let (candidate, newer) = bundle("0.1.5-nightly.20261022.59", 300);
        assert_eq!(
            select(home.path(), candidate.path(), &newer)
                .unwrap_err()
                .code,
            4212,
            "{damage}"
        );
        if matches!(damage, "bytes" | "permission") {
            // Only the existing exact trusted identity repair can recover here.
            let repaired = select(home.path(), source.path(), &manifest).unwrap();
            assert_ne!(repaired, executable);
            verify_bytes(repaired.parent().unwrap(), &manifest).unwrap();
        }
    }
}
