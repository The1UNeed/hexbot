use super::{tests::bundle, *};

fn record(home: &Path) -> Value {
    read_manifest(&home.join("runtime/native-current.json")).unwrap()
}

#[test]
fn explicit_setup_can_select_an_older_intact_bundle_without_damaging_its_identity() {
    let home = tempfile::tempdir().unwrap();
    let (newer, manifest) = bundle("0.1.5-nightly.20261022.59", 300);
    select(home.path(), newer.path(), &manifest).unwrap();
    let (older, old_manifest) = bundle(&crate::version(), 200);
    // The actual existing setup --activate path, including its verifier/writer.
    super::super::activate(home.path(), older.path(), &|_, _| {}).unwrap();
    let native = services::native_directory(home.path()).unwrap();
    let executable = services::selected_native_executable(home.path()).unwrap();
    assert_eq!(record(home.path())["builtAt"], 300);
    assert_eq!(
        read_manifest(&executable.with_file_name("manifest.json")).unwrap(),
        old_manifest
    );
    assert!(matches!(selected(&native), Selected::Verified(..)));
    assert_eq!(
        select(home.path(), older.path(), &old_manifest).unwrap(),
        executable
    );
    for at in [200, 250, 300] {
        let (candidate, manifest) = bundle("0.1.5-nightly.20261022.60", at);
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
        assert!(candidate.path().is_dir());
        assert_eq!(
            services::selected_native_executable(home.path()).unwrap(),
            executable
        );
        assert_eq!(record(home.path())["builtAt"], 300);
    }
    let (candidate, manifest) = bundle("0.1.5-nightly.20261022.60", 350);
    let advanced = select(home.path(), candidate.path(), &manifest).unwrap();
    assert_ne!(advanced, executable);
    assert_eq!(record(home.path())["builtAt"], 350);
    assert!(matches!(selected(&native), Selected::Verified(..)));
}

#[test]
fn a_historical_floor_does_not_authorize_a_nightly_tie_above_the_selected_bundle() {
    let home = tempfile::tempdir().unwrap();
    let (newer, manifest) = bundle("0.1.5", 300);
    select(home.path(), newer.path(), &manifest).unwrap();
    let native = services::native_directory(home.path()).unwrap();
    let (older, manifest) = bundle("0.1.5-nightly.20261022.58", 200);
    // The same unrestricted explicit writer used by existing setup, across tracks.
    let executable = services::publish_native(
        &native,
        manifest["version"].as_str().unwrap(),
        older.path(),
        "hexbot",
        None,
    )
    .unwrap();
    assert!(matches!(selected(&native), Selected::Verified(..)));
    let (candidate, manifest) = bundle("0.1.5-nightly.20261022.59", 300);
    assert_eq!(
        select(home.path(), candidate.path(), &manifest).unwrap(),
        executable
    );
    assert_eq!(record(home.path())["builtAt"], 300);
}

#[test]
fn explicit_selection_rechecks_a_historical_floor_published_while_it_waits() {
    let home = tempfile::tempdir().unwrap();
    let (first, manifest) = bundle("0.1.5-nightly.20261022.58", 300);
    select(home.path(), first.path(), &manifest).unwrap();
    let native = services::native_directory(home.path()).unwrap();
    let lock = services::activation_lock(native.parent().unwrap()).unwrap();
    let (candidate, manifest) = bundle("0.1.5-nightly.20261022.59", 350);
    let (started, waiting) = std::sync::mpsc::channel();
    let worker = std::thread::spawn({
        let home = home.path().to_owned();
        let source = candidate.path().to_owned();
        move || {
            started.send(()).unwrap();
            select(&home, &source, &manifest)
        }
    });
    waiting.recv().unwrap();
    let (winner, manifest) = bundle("0.1.5-nightly.20261022.60", 400);
    services::publish_native_locked(
        &native,
        manifest["version"].as_str().unwrap(),
        winner.path(),
        "hexbot",
        None,
    )
    .unwrap();
    let (older, manifest) = bundle("0.1.5-nightly.20261022.58", 200);
    let executable = services::publish_native_locked(
        &native,
        manifest["version"].as_str().unwrap(),
        older.path(),
        "hexbot",
        None,
    )
    .unwrap();
    drop(lock);
    assert_eq!(worker.join().unwrap().unwrap(), executable);
    assert_eq!(record(home.path())["builtAt"], 400);
    assert!(matches!(selected(&native), Selected::Verified(..)));
}
