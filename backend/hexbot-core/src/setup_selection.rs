//! Explicit packaged POSIX runtime selection. No tools, CLI or services.
use super::*;
use std::io::Read;
use std::os::unix::{ffi::OsStrExt, fs::OpenOptionsExt};

const LIMIT: u64 = 1024 * 1024;
const SIGNED_MACHO: &[&str] = &["node", "hexbot-core", "bin/rg", "bin/fd"];

fn read_manifest(path: &Path) -> Result<Value> {
    let file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)?;
    if !file.metadata()?.is_file() {
        return Err(Error::new(
            5243,
            "Runtime manifest must be an ordinary file",
        ));
    }
    let mut bytes = Vec::new();
    file.take(LIMIT + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > LIMIT {
        return Err(Error::new(5243, "Runtime manifest exceeds byte limit"));
    }
    let manifest: Value =
        serde_json::from_slice(&bytes).map_err(|e| Error::new(5243, e.to_string()))?;
    if !manifest.is_object() {
        return Err(Error::new(5243, "Invalid runtime manifest"));
    }
    Ok(manifest)
}

fn files(manifest: &Value) -> Result<&serde_json::Map<String, Value>> {
    manifest["files"]
        .as_object()
        .filter(|files| REQUIRED_FILES.iter().all(|file| files.contains_key(*file)))
        .ok_or_else(|| Error::new(5243, "Native runtime manifest is incomplete"))
}

// These manifest entries are executed directly; JS modules and lockfiles are read.
const EXECUTABLE_FILES: &[&str] = &[
    "hexbot",
    "hexbot-core",
    "node",
    "pi/hexbot-pi",
    "bin/rg",
    "bin/fd",
];
fn verify_executable(path: &Path) -> Result<()> {
    let name = std::ffi::CString::new(path.as_os_str().as_bytes())
        .map_err(|_| Error::new(5243, "Invalid native executable path"))?;
    // Effective-user access includes owner/group selection and ACLs. An execute
    // bit belonging to another user is insufficient, as in runtime_files.rs.
    if unsafe {
        libc::faccessat(
            libc::AT_FDCWD,
            name.as_ptr(),
            libc::R_OK | libc::X_OK,
            libc::AT_EACCESS,
        )
    } < 0
    {
        return Err(Error::new(
            5243,
            format!(
                "Native runtime is not executable for this user: {}: {}",
                path.display(),
                std::io::Error::last_os_error()
            ),
        ));
    }
    Ok(())
}

fn verify_bytes(directory: &Path, manifest: &Value) -> Result<()> {
    if manifest["target"] != target()
        || manifest["version"]
            .as_str()
            .is_none_or(|v| semver::Version::parse(v).is_err())
        || manifest["builtAt"].as_u64().unwrap_or(0) == 0
    {
        return Err(Error::new(
            5243,
            "Runtime identity or source chronology is invalid",
        ));
    }
    let root = directory.canonicalize()?;
    for (file, digest) in files(manifest)? {
        if file.starts_with('/')
            || file.contains('\\')
            || file.split('/').any(|p| matches!(p, "" | "." | ".."))
        {
            return Err(Error::new(5243, "Invalid native runtime manifest path"));
        }
        let path = root.join(file).canonicalize()?;
        if !path.starts_with(&root)
            || !path.is_file()
            || digest.as_str().is_none_or(|digest| {
                services::file_sha256(&path).map_or(true, |hash| hash != digest)
            })
        {
            return Err(Error::new(
                5243,
                format!("Native runtime checksum failed: {file}"),
            ));
        }
        if EXECUTABLE_FILES.contains(&file.as_str()) {
            verify_executable(&path)?;
        }
    }
    Ok(())
}

fn effective_manifest(source: &Path, effective: Value) -> Result<Value> {
    let actual = read_manifest(&source.join("manifest.json"))?;
    let actual_files = files(&actual)?;
    let effective_files = files(&effective)?;
    if actual_files.keys().ne(effective_files.keys()) {
        return Err(Error::new(
            5243,
            "Effective runtime manifest file set differs from bundle",
        ));
    }
    let mut normalized = actual.clone();
    for (file, digest) in effective_files {
        if cfg!(target_os = "macos") && SIGNED_MACHO.contains(&file.as_str()) {
            normalized["files"][file] = digest.clone();
        }
    }
    if effective != normalized {
        return Err(Error::new(
            5243,
            "Effective runtime manifest differs from bundle identity or hashes",
        ));
    }
    verify_bytes(source, &effective)?;
    Ok(effective)
}

fn newer_nightly(candidate: &str, selected: &str) -> bool {
    fn parse(raw: &str) -> Option<semver::Version> {
        let version = semver::Version::parse(raw).ok()?;
        if !version.build.is_empty() {
            return None;
        }
        let parts: Vec<_> = version.pre.split('.').collect();
        if parts.len() != 3 || parts[0] != "nightly" || parts[1].len() != 8 {
            return None;
        }
        let date = chrono::NaiveDate::parse_from_str(parts[1], "%Y%m%d").ok()?;
        let run = parts[2].parse::<u64>().ok()?;
        if date.format("%Y%m%d").to_string() != parts[1] || run == 0 || run.to_string() != parts[2]
        {
            return None;
        }
        Some(version)
    }
    match (parse(candidate), parse(selected)) {
        (Some(next), Some(old)) => {
            (next.major, next.minor, next.patch) == (old.major, old.minor, old.patch) && next > old
        }
        _ => false,
    }
}

enum Selected {
    Missing,
    Verified(PathBuf, Value),
    Damaged(Option<Value>),
}

fn selected(native: &Path) -> Selected {
    let runtime = native.parent().unwrap();
    let pointer = runtime.join("native-executable");
    let record = runtime.join("native-current.json");
    let absent = |path: &Path| matches!(fs::symlink_metadata(path), Err(e) if e.kind() == std::io::ErrorKind::NotFound);
    if absent(&pointer) && absent(&record) {
        return Selected::Missing;
    }
    let verify = || -> Result<(PathBuf, Value)> {
        let executable = pointer.canonicalize()?;
        let record = read_manifest(&record)?;
        let mut manifest = read_manifest(&executable.with_file_name("manifest.json"))?;
        if !executable.starts_with(native)
            || !executable.is_file()
            || record["version"] != manifest["version"]
            || record["executable"]
                .as_str()
                .and_then(|p| Path::new(p).canonicalize().ok())
                .as_ref()
                != Some(&executable)
            // The record preserves historical chronology; the manifest identifies
            // the selected bundle, which explicit setup may have chosen below it.
            || record.get("builtAt").is_some_and(|at| {
                at.as_u64().is_none_or(|floor| {
                    manifest["builtAt"].as_u64().is_none_or(|bundle| floor < bundle)
                })
            })
            || record.get("target").is_some_and(|target| target != &manifest["target"])
        {
            return Err(Error::new(
                4212,
                "Runtime identity cannot be verified; repair the installation",
            ));
        }
        // Python handoff records omit files. Verify those against the complete
        // selected manifest below; a present null or incomplete map is damage.
        if record.get("files").is_some() {
            if files(&record)?.keys().ne(files(&manifest)?.keys()) {
                return Err(Error::new(
                    4212,
                    "Runtime file identities disagree; repair the installation",
                ));
            }
            for (file, digest) in files(&record)? {
                if manifest["files"][file] != *digest
                    && !(cfg!(target_os = "macos") && SIGNED_MACHO.contains(&file.as_str()))
                {
                    return Err(Error::new(
                        4212,
                        "Runtime file identities disagree; repair the installation",
                    ));
                }
            }
            // A complete legacy record pins post-signing bytes of the same bundle.
            manifest["files"] = record["files"].clone();
        }
        Ok((executable, manifest))
    };
    match verify() {
        Ok((path, manifest)) => match verify_bytes(path.parent().unwrap(), &manifest) {
            Ok(()) => Selected::Verified(path, manifest),
            Err(_) => Selected::Damaged(Some(manifest)),
        },
        Err(_) => Selected::Damaged(None),
    }
}

fn select(home: &Path, source: &Path, manifest: &Value) -> Result<PathBuf> {
    fs::create_dir_all(home)?;
    let native = services::native_directory(home)?;
    let source = source.canonicalize()?;
    if native.starts_with(&source) {
        return Err(Error::new(
            5243,
            "Runtime source contains the installation directory",
        ));
    }
    let _lock = services::activation_lock(native.parent().unwrap())?;
    let selection = selected(&native);
    if matches!(selection, Selected::Damaged(None)) {
        return Err(Error::new(
            4212,
            "Runtime identity cannot be verified; repair the installation",
        ));
    }
    let floor = services::native_chronology_floor(&native, true)?;
    let at = manifest["builtAt"].as_u64().unwrap_or(0);
    if let Selected::Damaged(Some(current)) = &selection
        && (at != floor
            || current["builtAt"] != floor
            || manifest["version"] != current["version"]
            || manifest["target"] != current["target"]
            || manifest["files"] != current["files"])
    {
        return Err(Error::new(
            4212,
            "Runtime identity cannot be verified; repair the installation",
        ));
    }
    if let Selected::Verified(executable, current) = &selection {
        let newer_tie = at > 0
            && at == floor
            && current["builtAt"] == floor
            && manifest["target"] == current["target"]
            && newer_nightly(
                manifest["version"].as_str().unwrap(),
                current["version"].as_str().unwrap(),
            );
        if at <= floor && !newer_tie {
            return Ok(executable.clone());
        }
    } else if matches!(selection, Selected::Missing) && at <= floor {
        return Err(Error::new(
            4212,
            "Runtime selection does not exceed the recorded chronology floor",
        ));
    }
    let staging = tempfile::tempdir_in(&native)?;
    copy_runtime(&source, staging.path(), &source, &mut Vec::new())?;
    common::atomic_write(
        &staging.path().join("manifest.json"),
        &serde_json::to_vec(manifest).unwrap(),
    )?;
    verify_bytes(staging.path(), manifest)?;
    services::publish_native_locked(
        &native,
        manifest["version"].as_str().unwrap(),
        staging.path(),
        "hexbot",
        None,
    )
}

pub(super) fn run(home: &Path, args: &[String]) -> Result<()> {
    if args.len() != 4
        || args
            .iter()
            .filter(|a| a.as_str() == "--select-runtime")
            .count()
            != 1
        || args.iter().filter(|a| a.as_str() == "--json").count() != 1
    {
        return Err(Error::new(
            4200,
            "Use setup --select-runtime --manifest ABSOLUTE_FILE --json",
        ));
    }
    let index = args
        .iter()
        .position(|a| a == "--manifest")
        .ok_or_else(|| Error::new(4200, "Missing effective runtime manifest"))?;
    let path = args
        .get(index + 1)
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .ok_or_else(|| Error::new(4200, "Runtime manifest path must be absolute"))?;
    let executable = std::env::current_exe()?.canonicalize()?;
    let source = executable
        .parent()
        .ok_or_else(|| Error::new(5243, "Missing runtime source"))?;
    let manifest = effective_manifest(source, read_manifest(&path)?)?;
    let executable = select(home, source, &manifest)?;
    let selected = read_manifest(&executable.with_file_name("manifest.json"))?;
    println!(
        "{}",
        json!({"stage":"done", "message":"Hexbot runtime is ready", "executable":executable,"version":selected["version"]})
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(super) fn bundle(version: &str, at: u64) -> (tempfile::TempDir, Value) {
        let root = tempfile::tempdir().unwrap();
        let mut hashes = serde_json::Map::new();
        for file in REQUIRED_FILES {
            let path = root.path().join(file);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, file).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
            hashes.insert(
                file.to_string(),
                json!(services::file_sha256(&path).unwrap()),
            );
        }
        let manifest = json!({"version":version,"target":target(),"builtAt":at,"files":hashes});
        fs::write(root.path().join("manifest.json"), manifest.to_string()).unwrap();
        (root, manifest)
    }

    #[test]
    fn effective_manifest_preserves_identity_keyset_and_signed_resources() {
        let (source, manifest) = bundle("0.1.5-nightly.20261022.59", 200);
        for field in ["version", "target", "builtAt", "extra"] {
            let mut changed = manifest.clone();
            changed[field] = json!("different");
            assert!(
                effective_manifest(source.path(), changed).is_err(),
                "{field}"
            );
        }
        let mut changed = manifest.clone();
        changed["files"].as_object_mut().unwrap().remove("node");
        assert!(effective_manifest(source.path(), changed).is_err());
        let mut changed = manifest.clone();
        changed["files"]["extra"] = json!("hash");
        assert!(effective_manifest(source.path(), changed).is_err());
        let original = fs::read(source.path().join("manifest.json")).unwrap();
        fs::write(source.path().join("node"), "signed node").unwrap();
        let mut effective = manifest.clone();
        effective["files"]["node"] =
            json!(services::file_sha256(&source.path().join("node")).unwrap());
        assert_eq!(
            effective_manifest(source.path(), effective).is_ok(),
            cfg!(target_os = "macos")
        );
        assert_eq!(
            fs::read(source.path().join("manifest.json")).unwrap(),
            original
        );
        let mut forbidden = manifest;
        fs::write(source.path().join("hexbot"), "changed launcher").unwrap();
        forbidden["files"]["hexbot"] =
            json!(services::file_sha256(&source.path().join("hexbot")).unwrap());
        assert!(effective_manifest(source.path(), forbidden).is_err());
    }

    #[test]
    fn manifest_input_is_bounded_and_ordinary_and_flags_are_exclusive() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("manifest");
        fs::write(&path, vec![b' '; LIMIT as usize + 1]).unwrap();
        assert!(read_manifest(&path).is_err());
        fs::remove_file(&path).unwrap();
        std::os::unix::fs::symlink(root.path().join("missing"), &path).unwrap();
        assert!(read_manifest(&path).is_err());
        assert!(read_manifest(root.path()).is_err());
        for args in [
            vec!["--select-runtime"],
            vec!["--select-runtime", "--activate", "--json"],
            vec!["--select-runtime", "--manifest", "relative", "--json"],
            vec![
                "--select-runtime",
                "--manifest",
                "/tmp/x",
                "--no-code-tools",
                "--json",
            ],
        ] {
            assert!(
                run(
                    root.path(),
                    &args.into_iter().map(str::to_string).collect::<Vec<_>>()
                )
                .is_err()
            );
        }
        assert!(
            fs::read_dir(root.path())
                .unwrap()
                .all(|entry| entry.unwrap().file_name() == "manifest")
        );
    }

    #[test]
    fn explicit_selection_allows_only_canonical_positive_same_base_nightly_ties() {
        let home = tempfile::tempdir().unwrap();
        let (first, manifest) = bundle("0.1.5-nightly.20261022.58", 200);
        let old = select(home.path(), first.path(), &manifest).unwrap();
        let (next, manifest) = bundle("0.1.5-nightly.20261022.59", 200);
        let selected = select(home.path(), next.path(), &manifest).unwrap();
        assert_ne!(old, selected);
        assert_eq!(
            fs::metadata(&selected).unwrap().permissions().mode() & 0o777,
            0o755
        );
        for version in [
            "0.1.5-nightly.20261022.58",
            "0.1.5",
            "0.1.6-nightly.20261022.60",
            "0.1.5-nightly.20260230.60",
        ] {
            let (candidate, manifest) = bundle(version, 200);
            assert_eq!(
                select(home.path(), candidate.path(), &manifest).unwrap(),
                selected,
                "{version}"
            );
        }
        let native = services::native_directory(home.path()).unwrap();
        assert_eq!(fs::read_dir(native).unwrap().count(), 2);
        assert!(!home.path().join("bin").exists());
        assert!(!home.path().join("python").exists());
    }

    #[test]
    fn damaged_identity_never_becomes_a_missing_install_or_a_tie_repair() {
        for damage in [
            "record-missing",
            "record-json",
            "version",
            "pointer",
            "files",
            "floor",
            "floor-invalid",
            "floor-null",
            "target",
            "record-path",
            "hash",
        ] {
            let home = tempfile::tempdir().unwrap();
            let (source, manifest) = bundle("0.1.5-nightly.20261022.58", 200);
            let selected = select(home.path(), source.path(), &manifest).unwrap();
            let runtime = home.path().join("runtime");
            let path = runtime.join("native-current.json");
            let mut record = read_manifest(&path).unwrap();
            match damage {
                "record-missing" => fs::remove_file(&path).unwrap(),
                "record-json" => fs::write(&path, "broken").unwrap(),
                "pointer" => {
                    fs::remove_file(runtime.join("native-executable")).unwrap();
                }
                "version" => {
                    record["version"] = json!("invalid");
                    fs::write(&path, record.to_string()).unwrap();
                }
                "files" => {
                    record["files"].as_object_mut().unwrap().remove("node");
                    fs::write(&path, record.to_string()).unwrap();
                }
                "target" => {
                    record["target"] = json!("other-platform");
                    fs::write(&path, record.to_string()).unwrap();
                }
                "record-path" => {
                    record["executable"] = json!(runtime.join("elsewhere"));
                    fs::write(&path, record.to_string()).unwrap();
                }
                "hash" => {
                    record["files"]["hexbot"] = json!("0".repeat(64));
                    fs::write(&path, record.to_string()).unwrap();
                }
                _ => {
                    record["builtAt"] = match damage {
                        "floor-invalid" => json!("300"),
                        "floor-null" => Value::Null,
                        _ => json!(100),
                    };
                    fs::write(&path, record.to_string()).unwrap();
                }
            }
            let before = fs::read(&path).ok();
            let (candidate, next) = bundle("0.1.5-nightly.20261022.59", 200);
            assert!(
                select(home.path(), candidate.path(), &next).is_err(),
                "{damage}"
            );
            assert!(
                select(home.path(), source.path(), &manifest).is_err(),
                "exact repair {damage}"
            );
            let (candidate, newer) = bundle("0.1.5-nightly.20261022.60", 350);
            assert!(
                select(home.path(), candidate.path(), &newer).is_err(),
                "newer {damage}"
            );
            assert_eq!(fs::read(&path).ok(), before);
            assert!(selected.exists());
        }
    }

    #[test]
    fn nightly_ties_use_release_grammar_and_the_same_version_base() {
        let old = "0.1.5-nightly.20261022.58";
        assert!(newer_nightly("0.1.5-nightly.20261022.59", old));
        assert!(newer_nightly("0.1.5-nightly.20261023.1", old));
        for candidate in [
            old,
            "0.1.5-nightly.20261022.57",
            "0.1.5",
            "0.1.6-nightly.20261022.59",
            "0.1.5-nightly.20260230.59",
            "0.1.5-nightly.20261023.0",
            "0.1.5-nightly.20261023.01",
            "0.1.5-nightly.20261023.1+other",
            "0.1.5-nightly.20261023.1.extra",
        ] {
            assert!(!newer_nightly(candidate, old), "{candidate}");
        }
    }

    #[test]
    fn explicit_selection_rechecks_the_winner_under_the_activation_lock() {
        let home = tempfile::tempdir().unwrap();
        let (first, manifest) = bundle("0.1.5-nightly.20261022.58", 200);
        select(home.path(), first.path(), &manifest).unwrap();
        let native = services::native_directory(home.path()).unwrap();
        let lock = services::activation_lock(native.parent().unwrap()).unwrap();
        let (candidate, manifest) = bundle("0.1.5-nightly.20261022.59", 200);
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
        let (winner, manifest) = bundle("0.1.5-nightly.20261022.60", 300);
        let staging = tempfile::tempdir_in(&native).unwrap();
        copy_runtime(
            &winner.path().canonicalize().unwrap(),
            staging.path(),
            &winner.path().canonicalize().unwrap(),
            &mut Vec::new(),
        )
        .unwrap();
        let selected = services::publish_native_locked(
            &native,
            manifest["version"].as_str().unwrap(),
            staging.path(),
            "hexbot",
            None,
        )
        .unwrap();
        drop(lock);
        assert_eq!(worker.join().unwrap().unwrap(), selected);
        assert_eq!(fs::read_dir(native).unwrap().count(), 2);
    }

    #[test]
    fn legacy_post_signing_hashes_need_complete_record_and_matching_bytes() {
        let home = tempfile::tempdir().unwrap();
        let (first, manifest) = bundle("0.1.5-nightly.20261022.58", 200);
        let selected = select(home.path(), first.path(), &manifest).unwrap();
        let path = selected.with_file_name("manifest.json");
        let mut baked = read_manifest(&path).unwrap();
        baked["files"]["node"] = json!("0".repeat(64));
        fs::write(path, baked.to_string()).unwrap();
        let record = home.path().join("runtime/native-current.json");
        let mut legacy = read_manifest(&record).unwrap();
        legacy.as_object_mut().unwrap().remove("builtAt");
        fs::write(record, legacy.to_string()).unwrap();
        let native = services::native_directory(home.path()).unwrap();
        assert_eq!(
            matches!(super::selected(&native), Selected::Verified(..)),
            cfg!(target_os = "macos")
        );
        fs::write(selected.with_file_name("node"), "tampered").unwrap();
        assert!(!matches!(super::selected(&native), Selected::Verified(..)));
    }

    #[test]
    fn legacy_record_and_exact_byte_repair_require_complete_durable_identity() {
        let home = tempfile::tempdir().unwrap();
        let (source, manifest) = bundle("0.1.5-nightly.20261022.58", 200);
        let selected = select(home.path(), source.path(), &manifest).unwrap();
        let record = home.path().join("runtime/native-current.json");
        let mut legacy = read_manifest(&record).unwrap();
        legacy.as_object_mut().unwrap().remove("builtAt");
        fs::write(&record, legacy.to_string()).unwrap();
        assert_eq!(
            select(home.path(), source.path(), &manifest).unwrap(),
            selected
        );
        fs::write(&selected, "broken bytes").unwrap();
        let repaired = select(home.path(), source.path(), &manifest).unwrap();
        assert_ne!(repaired, selected);
        verify_bytes(repaired.parent().unwrap(), &manifest).unwrap();
    }
}

#[cfg(test)]
#[path = "setup_selection_floor_tests.rs"]
mod floor_tests;

#[cfg(test)]
#[path = "setup_selection_permissions_tests.rs"]
mod permissions_tests;

#[cfg(test)]
#[path = "setup_selection_repair_tests.rs"]
mod repair_tests;

#[cfg(test)]
#[path = "setup_selection_identity_tests.rs"]
mod identity_tests;

#[cfg(test)]
#[path = "setup_selection_handoff_tests.rs"]
mod handoff_tests;
