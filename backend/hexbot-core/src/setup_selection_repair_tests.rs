use super::{tests::bundle, *};

#[test]
fn unchecked_installer_activation_repairs_damage_and_keeps_each_readable_floor() {
    for damage in [
        "broken-record",
        "array-record",
        "invalid-floor",
        "broken-manifest",
        "unreadable-record",
        "unreadable-manifest",
    ] {
        let home = tempfile::tempdir().unwrap();
        let (initial, manifest) = bundle(&crate::version(), 300);
        select(home.path(), initial.path(), &manifest).unwrap();
        let native = services::native_directory(home.path()).unwrap();
        let executable = services::selected_native_executable(home.path()).unwrap();
        let record_path = home.path().join("runtime/native-current.json");
        let manifest_path = executable.with_file_name("manifest.json");
        let mut record = read_manifest(&record_path).unwrap();
        let floor = if damage == "invalid-floor" {
            500
        } else if damage.ends_with("manifest") {
            400
        } else {
            300
        };
        match damage {
            "broken-record" => fs::write(&record_path, "broken").unwrap(),
            "array-record" => fs::write(&record_path, "[]").unwrap(),
            "invalid-floor" => {
                record["builtAt"] = json!("x");
                record["updateManifest"] = json!({"builtAt":500});
                fs::write(&record_path, record.to_string()).unwrap();
            }
            "broken-manifest" | "unreadable-manifest" => {
                record["builtAt"] = json!(400);
                fs::write(&record_path, record.to_string()).unwrap();
                if damage == "broken-manifest" {
                    fs::write(&manifest_path, "broken").unwrap();
                } else {
                    fs::set_permissions(&manifest_path, fs::Permissions::from_mode(0o000)).unwrap();
                }
            }
            "unreadable-record" => {
                fs::set_permissions(&record_path, fs::Permissions::from_mode(0o000)).unwrap();
            }
            _ => unreachable!(),
        }
        if !damage.starts_with("unreadable") || unsafe { libc::geteuid() } != 0 {
            let (candidate, manifest) = bundle("0.1.5-nightly.20261022.60", 600);
            assert!(
                select(home.path(), candidate.path(), &manifest).is_err(),
                "packaged {damage}"
            );
            assert!(
                services::publish_native(
                    &native,
                    manifest["version"].as_str().unwrap(),
                    candidate.path(),
                    "hexbot",
                    Some(&manifest)
                )
                .is_err(),
                "automatic {damage}"
            );
        }
        let (trusted, manifest) = bundle(&crate::version(), 200);
        super::super::activate(home.path(), trusted.path(), &|_, _| {}).unwrap();
        let repaired = services::selected_native_executable(home.path()).unwrap();
        assert_ne!(repaired, executable, "{damage}");
        assert_eq!(
            read_manifest(&record_path).unwrap()["builtAt"],
            floor,
            "{damage}"
        );
        assert_eq!(
            read_manifest(&repaired.with_file_name("manifest.json")).unwrap(),
            manifest
        );
        assert!(
            matches!(selected(&native), Selected::Verified(..)),
            "{damage}"
        );
        let (candidate, manifest) = bundle("0.1.5-nightly.20261022.61", floor);
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
        let (candidate, manifest) = bundle("0.1.5-nightly.20261022.61", floor + 50);
        assert_ne!(
            select(home.path(), candidate.path(), &manifest).unwrap(),
            repaired
        );
    }
}
