use super::{tests::bundle, *};

fn wrong_entrypoints_refuse(sparse: bool) {
    for (file, mode) in [("unlisted", 0o644), ("unlisted", 0o755), ("node", 0o755)] {
        let home = tempfile::tempdir().unwrap();
        let (source, manifest) = bundle("0.1.5-nightly.20261022.58", 200);
        let executable = select(home.path(), source.path(), &manifest).unwrap();
        let wrong = executable.with_file_name(file);
        if file == "unlisted" {
            fs::write(&wrong, "not the verified Hexbot launcher").unwrap();
        }
        fs::set_permissions(&wrong, fs::Permissions::from_mode(mode)).unwrap();
        let pointer = home.path().join("runtime/native-executable");
        fs::remove_file(&pointer).unwrap();
        std::os::unix::fs::symlink(&wrong, &pointer).unwrap();
        let record = home.path().join("runtime/native-current.json");
        let mut identity = if sparse {
            json!({"version":manifest["version"], "previous":null})
        } else {
            read_manifest(&record).unwrap()
        };
        identity["executable"] = json!(wrong);
        fs::write(&record, identity.to_string()).unwrap();
        let before = fs::read(&record).unwrap();
        let native = services::native_directory(home.path()).unwrap();
        // Every manifest-listed file remains intact and executable, even node.
        verify_bytes(executable.parent().unwrap(), &manifest).unwrap();
        assert!(
            matches!(selected(&native), Selected::Damaged(None)),
            "{file} {mode:o} sparse={sparse}"
        );
        // Wrong executable identity must not enter exact-byte repair either.
        assert_eq!(
            select(home.path(), source.path(), &manifest)
                .unwrap_err()
                .code,
            4212
        );
        let (candidate, newer) = bundle("0.1.5-nightly.20261022.59", 300);
        assert_eq!(
            select(home.path(), candidate.path(), &newer)
                .unwrap_err()
                .code,
            4212
        );
        assert_eq!(fs::read(&record).unwrap(), before);
        assert_eq!(pointer.canonicalize().unwrap(), wrong);
        assert_eq!(fs::read_dir(native).unwrap().count(), 1);
    }
}

#[test]
fn full_record_cannot_select_an_unlisted_file_or_another_listed_executable() {
    wrong_entrypoints_refuse(false);
}

#[test]
fn sparse_handoff_record_cannot_select_an_unlisted_file_or_another_listed_executable() {
    wrong_entrypoints_refuse(true);
}

#[test]
fn canonical_alias_of_the_verified_launcher_keeps_a_valid_handoff_selection() {
    let home = tempfile::tempdir().unwrap();
    let (source, manifest) = bundle("0.1.5-nightly.20261022.58", 200);
    let executable = select(home.path(), source.path(), &manifest).unwrap();
    let alias = executable.with_file_name("launcher-alias");
    std::os::unix::fs::symlink(&executable, &alias).unwrap();
    let pointer = home.path().join("runtime/native-executable");
    fs::remove_file(&pointer).unwrap();
    std::os::unix::fs::symlink(&alias, &pointer).unwrap();
    let record = home.path().join("runtime/native-current.json");
    fs::write(
        &record,
        json!({"version":manifest["version"], "executable":alias, "previous":null}).to_string(),
    )
    .unwrap();
    assert_eq!(
        select(home.path(), source.path(), &manifest).unwrap(),
        executable
    );
}
