use super::{tests::bundle, *};
use std::process::Command;

const EXECUTABLES: &[&str] = &[
    "hexbot",
    "hexbot-core",
    "node",
    "pi/hexbot-pi",
    "bin/rg",
    "bin/fd",
];
fn runnable_bundle(version: &str) -> (tempfile::TempDir, Value) {
    let (source, mut manifest) = bundle(version, 200);
    for file in EXECUTABLES {
        let path = source.path().join(file);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "#!/bin/sh\nexit 0\n").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        manifest["files"][file] = json!(services::file_sha256(&path).unwrap());
    }
    fs::write(source.path().join("manifest.json"), manifest.to_string()).unwrap();
    (source, manifest)
}

#[test]
fn permission_damage_never_returns_a_ready_but_unexecutable_selection() {
    for file in EXECUTABLES {
        let home = tempfile::tempdir().unwrap();
        let (source, manifest) = runnable_bundle("0.1.5-nightly.20261022.59");
        let executable = select(home.path(), source.path(), &manifest).unwrap();
        let damaged = executable.parent().unwrap().join(file);
        assert!(Command::new(&damaged).status().unwrap().success());
        let hash = services::file_sha256(&damaged).unwrap();
        fs::set_permissions(&damaged, fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(services::file_sha256(&damaged).unwrap(), hash);
        assert_eq!(
            Command::new(&damaged).status().unwrap_err().kind(),
            std::io::ErrorKind::PermissionDenied
        );
        let (older, older_manifest) = runnable_bundle("0.1.5-nightly.20261022.58");
        assert!(
            select(home.path(), older.path(), &older_manifest).is_err(),
            "retaining damaged {file}"
        );
        let repaired = select(home.path(), source.path(), &manifest).unwrap();
        assert_ne!(
            repaired, executable,
            "must publish an owned repair for {file}"
        );
        assert_eq!(
            fs::metadata(&damaged).unwrap().permissions().mode() & 0o777,
            0o644
        );
        let ready = repaired.parent().unwrap().join(file);
        assert!(Command::new(&ready).status().unwrap().success());
        verify_bytes(repaired.parent().unwrap(), &manifest).unwrap();
    }
}

#[test]
fn unusable_source_or_staging_permissions_cannot_authorize_publication() {
    for file in EXECUTABLES {
        let home = tempfile::tempdir().unwrap();
        let (source, manifest) = runnable_bundle("0.1.5-nightly.20261022.59");
        fs::set_permissions(source.path().join(file), fs::Permissions::from_mode(0o644)).unwrap();
        assert!(
            effective_manifest(source.path(), manifest.clone()).is_err(),
            "source {file}"
        );
        assert!(
            select(home.path(), source.path(), &manifest).is_err(),
            "staging {file}"
        );
        assert!(!home.path().join("runtime/native-current.json").exists());
    }
}

#[test]
fn an_execute_bit_for_other_users_does_not_prove_effective_user_access() {
    if unsafe { libc::geteuid() } == 0 {
        return;
    }
    let (source, manifest) = runnable_bundle("0.1.5-nightly.20261022.59");
    let path = source.path().join("hexbot-core");
    // The current user owns the file and has read access, but only others can execute.
    fs::set_permissions(&path, fs::Permissions::from_mode(0o401)).unwrap();
    assert_ne!(fs::metadata(&path).unwrap().permissions().mode() & 0o111, 0);
    assert!(verify_bytes(source.path(), &manifest).is_err());
}
