use super::{tests::bundle, *};

const PI_CLI: &str = "pi/node_modules/@earendil-works/pi-coding-agent/dist/cli.js";
fn change_pi(source: &Path, manifest: &mut Value) {
    fs::write(source.join(PI_CLI), "// Different verified Pi bytes\n").unwrap();
    manifest["files"][PI_CLI] = json!(services::file_sha256(&source.join(PI_CLI)).unwrap());
    fs::write(source.join("manifest.json"), manifest.to_string()).unwrap();
    effective_manifest(source, manifest.clone()).unwrap();
}
fn healthy_identity_is_retained(version: &str) {
    let home = tempfile::tempdir().unwrap();
    let (source, original) = bundle(version, 200);
    effective_manifest(source.path(), original.clone()).unwrap();
    let executable = select(home.path(), source.path(), &original).unwrap();
    let record = home.path().join("runtime/native-current.json");
    let before = fs::read(&record).unwrap();
    // Exact healthy reuse does not publish a new immutable directory or record.
    assert_eq!(
        select(home.path(), source.path(), &original).unwrap(),
        executable
    );
    assert_eq!(fs::read(&record).unwrap(), before);
    let (candidate, mut changed) = bundle(version, 200);
    change_pi(candidate.path(), &mut changed);
    assert_ne!(changed["files"][PI_CLI], original["files"][PI_CLI]);
    assert_eq!(
        select(home.path(), candidate.path(), &changed).unwrap(),
        executable
    );
    assert_eq!(fs::read(&record).unwrap(), before);
    assert_eq!(
        services::selected_native_executable(home.path()).unwrap(),
        executable
    );
    let native = services::native_directory(home.path()).unwrap();
    assert_eq!(fs::read_dir(native).unwrap().count(), 1);
    // Different bytes of the same version can publish at strictly newer chronology.
    changed["builtAt"] = json!(250);
    fs::write(candidate.path().join("manifest.json"), changed.to_string()).unwrap();
    effective_manifest(candidate.path(), changed.clone()).unwrap();
    let advanced = select(home.path(), candidate.path(), &changed).unwrap();
    assert_ne!(advanced, executable);
    assert_eq!(read_manifest(&record).unwrap()["builtAt"], 250);
    assert_eq!(
        read_manifest(&record).unwrap()["files"][PI_CLI],
        changed["files"][PI_CLI]
    );
}

#[test]
fn healthy_stable_equal_chronology_keeps_original_identity() {
    healthy_identity_is_retained("0.1.5");
}
#[test]
fn healthy_nightly_equal_chronology_keeps_original_identity() {
    healthy_identity_is_retained("0.1.5-nightly.20261022.59");
}
#[test]
fn later_canonical_nightly_can_publish_changed_bytes_at_the_same_floor() {
    let home = tempfile::tempdir().unwrap();
    let (first, manifest) = bundle("0.1.5-nightly.20261022.59", 200);
    let old = select(home.path(), first.path(), &manifest).unwrap();
    let (candidate, mut manifest) = bundle("0.1.5-nightly.20261022.60", 200);
    change_pi(candidate.path(), &mut manifest);
    let advanced = select(home.path(), candidate.path(), &manifest).unwrap();
    assert_ne!(advanced, old);
    assert_eq!(
        read_manifest(&home.path().join("runtime/native-current.json")).unwrap()["files"],
        manifest["files"]
    );
}
#[test]
fn permission_damage_does_not_authorize_different_same_version_bytes() {
    for version in ["0.1.5", "0.1.5-nightly.20261022.59"] {
        let home = tempfile::tempdir().unwrap();
        let (source, manifest) = bundle(version, 200);
        let executable = select(home.path(), source.path(), &manifest).unwrap();
        let record = home.path().join("runtime/native-current.json");
        let before = fs::read(&record).unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o644)).unwrap();
        let (candidate, mut changed) = bundle(version, 200);
        change_pi(candidate.path(), &mut changed);
        assert_eq!(
            select(home.path(), candidate.path(), &changed)
                .unwrap_err()
                .code,
            4212
        );
        assert_eq!(fs::read(&record).unwrap(), before);
        assert_eq!(
            services::selected_native_executable(home.path()).unwrap(),
            executable
        );
        // The original trusted identity still repairs into owned staging.
        let repaired = select(home.path(), source.path(), &manifest).unwrap();
        assert_ne!(repaired, executable);
        assert_eq!(
            fs::metadata(&executable).unwrap().permissions().mode() & 0o777,
            0o644
        );
        verify_bytes(repaired.parent().unwrap(), &manifest).unwrap();
    }
}
