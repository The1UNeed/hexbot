use super::*;

#[test]
fn publication_keeps_durable_floors_when_selection_is_damaged() {
    for damage in [
        "missing",
        "invalid-json",
        "invalid-version",
        "lower-manifest",
        "missing-pointer",
    ] {
        let home = tempfile::tempdir().unwrap();
        let native = native_directory(home.path()).unwrap();
        let runtime = native.parent().unwrap();
        let selected = native.join("selected");
        fs::create_dir(&selected).unwrap();
        fs::write(selected.join("hexbot"), "selected").unwrap();
        fs::write(
            selected.join("manifest.json"),
            json!({"version":"9.8.8", "builtAt":300}).to_string(),
        )
        .unwrap();
        activate_native(&native, "9.8.8", &selected.join("hexbot")).unwrap();
        let record = runtime.join("native-current.json");
        let mut metadata: Value = serde_json::from_slice(&fs::read(&record).unwrap()).unwrap();
        metadata["builtAt"] = json!(400);
        if damage == "invalid-version" {
            metadata["version"] = json!("invalid");
        }
        fs::write(&record, metadata.to_string()).unwrap();
        match damage {
            "missing" => fs::remove_file(selected.join("manifest.json")).unwrap(),
            "invalid-json" => fs::write(selected.join("manifest.json"), "invalid").unwrap(),
            "lower-manifest" => fs::write(
                selected.join("manifest.json"),
                json!({"builtAt":100}).to_string(),
            )
            .unwrap(),
            "missing-pointer" => fs::remove_file(runtime.join("native-executable")).unwrap(),
            _ => {}
        }
        let before = fs::read(&record).unwrap();
        for built_at in [0, 200, 400] {
            let staging = tempfile::tempdir_in(&native).unwrap();
            fs::write(staging.path().join("hexbot"), "replacement").unwrap();
            let requested = json!({"version":"9.9.0", "builtAt":built_at});
            assert_eq!(
                publish_native(&native, "9.9.0", staging.path(), "hexbot", Some(&requested))
                    .unwrap_err()
                    .code,
                4212,
                "{damage}"
            );
            assert!(staging.path().is_dir());
            assert_eq!(fs::read(&record).unwrap(), before);
        }
    }
}

#[test]
fn publication_rechecks_the_recorded_running_bundle_floor() {
    let home = tempfile::tempdir().unwrap();
    let native = native_directory(home.path()).unwrap();
    let running = native.join("running");
    fs::create_dir(&running).unwrap();
    fs::write(running.join("hexbot"), "running").unwrap();
    fs::write(
        running.join("manifest.json"),
        json!({"version":"9.8.8", "builtAt":500}).to_string(),
    )
    .unwrap();
    fs::write(
        native.parent().unwrap().join("native-running.json"),
        json!({"pid":std::process::id(), "executable":running.join("hexbot")}).to_string(),
    )
    .unwrap();
    let staging = tempfile::tempdir_in(&native).unwrap();
    fs::write(staging.path().join("hexbot"), "replacement").unwrap();
    assert_eq!(
        publish_native(
            &native,
            "9.9.0",
            staging.path(),
            "hexbot",
            Some(&json!({"version":"9.9.0", "builtAt":400}))
        )
        .unwrap_err()
        .code,
        4212
    );
    assert!(
        !native
            .parent()
            .unwrap()
            .join("native-current.json")
            .exists()
    );
}

#[test]
fn publication_rechecks_a_durable_floor_changed_under_the_activation_lock() {
    let home = tempfile::tempdir().unwrap();
    let native = native_directory(home.path()).unwrap();
    let runtime = native.parent().unwrap();
    let lock = activation_lock(runtime).unwrap();
    let staging = tempfile::tempdir_in(&native).unwrap();
    fs::write(staging.path().join("hexbot"), "replacement").unwrap();
    let (started, waiting) = std::sync::mpsc::channel();
    let worker = std::thread::spawn({
        let native = native.clone();
        let staging = staging.path().to_owned();
        move || {
            started.send(()).unwrap();
            publish_native(
                &native,
                "9.9.0",
                &staging,
                "hexbot",
                Some(&json!({"version":"9.9.0", "builtAt":400})),
            )
        }
    });
    waiting.recv().unwrap();
    let metadata = json!({"version":"9.8.8", "builtAt":500});
    fs::write(runtime.join("native-current.json"), metadata.to_string()).unwrap();
    drop(lock);
    assert_eq!(worker.join().unwrap().unwrap_err().code, 4212);
    assert!(staging.path().is_dir());
    assert_eq!(
        serde_json::from_slice::<Value>(&fs::read(runtime.join("native-current.json")).unwrap())
            .unwrap(),
        metadata
    );
}

#[test]
fn publication_refuses_damaged_records_without_erasing_the_manifest_floor() {
    for damage in [
        None,
        Some("invalid"),
        Some("[]"),
        Some("{\"builtAt\":\"unknown\"}"),
        Some("{\"builtAt\":400,\"updateManifest\":[]}"),
    ] {
        let home = tempfile::tempdir().unwrap();
        let native = native_directory(home.path()).unwrap();
        let directory = native.join("selected");
        fs::create_dir(&directory).unwrap();
        fs::write(directory.join("hexbot"), "selected").unwrap();
        fs::write(
            directory.join("manifest.json"),
            json!({"version":"9.8.8", "builtAt":500}).to_string(),
        )
        .unwrap();
        activate_native(&native, "9.8.8", &directory.join("hexbot")).unwrap();
        let record = native.parent().unwrap().join("native-current.json");
        if let Some(damage) = damage {
            fs::write(&record, damage).unwrap();
        } else {
            fs::remove_file(&record).unwrap();
        }
        let before = fs::read(&record).ok();
        let staging = tempfile::tempdir_in(&native).unwrap();
        fs::write(staging.path().join("hexbot"), "replacement").unwrap();
        assert_eq!(
            publish_native(
                &native,
                "9.9.0",
                staging.path(),
                "hexbot",
                Some(&json!({"version":"9.9.0", "builtAt":400}))
            )
            .unwrap_err()
            .code,
            4212
        );
        assert_eq!(fs::read(&record).ok(), before);
        assert!(staging.path().is_dir());
        if damage.is_some() {
            assert_eq!(
                publish_native(
                    &native,
                    "9.9.0",
                    staging.path(),
                    "hexbot",
                    Some(&json!({"version":"9.9.0", "builtAt":600}))
                )
                .unwrap_err()
                .code,
                4212
            );
            assert_eq!(fs::read(&record).ok(), before);
            assert!(staging.path().is_dir());
        }
    }
}

#[test]
fn publication_refuses_an_installed_record_with_no_recoverable_chronology() {
    let home = tempfile::tempdir().unwrap();
    let native = native_directory(home.path()).unwrap();
    let record = native.parent().unwrap().join("native-current.json");
    fs::write(&record, json!({"version":"9.8.8"}).to_string()).unwrap();
    let staging = tempfile::tempdir_in(&native).unwrap();
    fs::write(staging.path().join("hexbot"), "replacement").unwrap();
    assert_eq!(
        publish_native(
            &native,
            "9.9.0",
            staging.path(),
            "hexbot",
            Some(&json!({"version":"9.9.0", "builtAt":400}))
        )
        .unwrap_err()
        .code,
        4212
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&fs::read(record).unwrap()).unwrap(),
        json!({"version":"9.8.8"})
    );
    assert!(staging.path().is_dir());
}

#[test]
fn activation_preserves_the_highest_record_manifest_and_signed_floor() {
    let home = tempfile::tempdir().unwrap();
    let native = native_directory(home.path()).unwrap();
    let record = native.parent().unwrap().join("native-current.json");
    fs::write(
        &record,
        json!({"version":"invalid", "builtAt":400, "updateManifest":{"builtAt":600}}).to_string(),
    )
    .unwrap();
    let directory = native.join("repair");
    fs::create_dir(&directory).unwrap();
    fs::write(directory.join("hexbot"), "repair").unwrap();
    fs::write(
        directory.join("manifest.json"),
        json!({"version":"9.8.8", "builtAt":300}).to_string(),
    )
    .unwrap();
    activate_native(&native, "9.8.8", &directory.join("hexbot")).unwrap();
    let metadata: Value = serde_json::from_slice(&fs::read(&record).unwrap()).unwrap();
    assert_eq!(metadata["builtAt"], 600);
    let staging = tempfile::tempdir_in(&native).unwrap();
    fs::write(staging.path().join("hexbot"), "replacement").unwrap();
    assert_eq!(
        publish_native(
            &native,
            "9.9.0",
            staging.path(),
            "hexbot",
            Some(&json!({"version":"9.9.0", "builtAt":500}))
        )
        .unwrap_err()
        .code,
        4212
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&fs::read(record).unwrap()).unwrap(),
        metadata
    );
}

#[test]
fn publication_records_the_signed_floor_even_without_an_embedded_manifest() {
    let home = tempfile::tempdir().unwrap();
    let native = native_directory(home.path()).unwrap();
    let staging = tempfile::tempdir_in(&native).unwrap();
    fs::write(staging.path().join("hexbot"), "replacement").unwrap();
    let requested = json!({"version":"9.9.0", "builtAt":400});
    publish_native(&native, "9.9.0", staging.path(), "hexbot", Some(&requested)).unwrap();
    let metadata: Value = serde_json::from_slice(
        &fs::read(native.parent().unwrap().join("native-current.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(metadata["builtAt"], 400);
    assert_eq!(metadata["updateManifest"], requested);
    let staging = tempfile::tempdir_in(&native).unwrap();
    fs::write(staging.path().join("hexbot"), "older").unwrap();
    assert_eq!(
        publish_native(
            &native,
            "10.0.0",
            staging.path(),
            "hexbot",
            Some(&json!({"version":"10.0.0", "builtAt":400}))
        )
        .unwrap_err()
        .code,
        4212
    );
}
