#![cfg(windows)]
//! Native CI only. Requires the real signed update ZIP generated from this build.
#[path = "../src/windows_paths.rs"]
mod windows_paths;

#[path = "windows_contract/python_acceptance.rs"]
mod owned_python_acceptance;

// Comparative publication controls. The current path is the public
// `common::atomic_write` (tempfile persist). The candidate below is private to
// this file: it closes the temp, clears only that owned temp's attributes,
// publishes with std::fs::rename, and disables cleanup only after success.
// These prove a mechanism; they do not identify the operation that failed in CI.
mod publication {
    use std::{
        fs,
        io::{self, Read, Seek, Write},
        os::windows::{
            ffi::OsStrExt,
            fs::{MetadataExt, OpenOptionsExt},
        },
        path::Path,
    };
    const SHARE_READ_WRITE: u32 = 0x1 | 0x2;
    const SHARE_ALL: u32 = SHARE_READ_WRITE | 0x4;
    const ATTRIBUTE_TEMPORARY: u32 = 0x100;

    fn candidate(path: &Path, bytes: &[u8]) -> io::Result<()> {
        unsafe extern "system" {
            fn SetFileAttributesW(path: *const u16, attributes: u32) -> i32;
        }
        let mut file = tempfile::NamedTempFile::new_in(path.parent().unwrap())?;
        file.write_all(bytes)?;
        file.as_file().sync_all()?;
        let mut owned = file.into_temp_path();
        let wide: Vec<u16> = owned.as_os_str().encode_wide().chain(Some(0)).collect();
        if unsafe { SetFileAttributesW(wide.as_ptr(), 0x80) } == 0 {
            return Err(io::Error::last_os_error());
        }
        // A failure here leaves cleanup enabled, so the temp is removed on drop.
        fs::rename(&owned, path)?;
        owned.disable_cleanup(true);
        Ok(())
    }
    fn current(path: &Path, bytes: &[u8]) -> Result<(), String> {
        hexbot_core::common::atomic_write(path, bytes).map_err(|error| error.message)
    }
    fn reader(path: &Path, share: u32) -> fs::File {
        fs::OpenOptions::new()
            .read(true)
            .share_mode(share)
            .open(path)
            .unwrap()
    }
    fn reread(file: &mut fs::File) -> Vec<u8> {
        file.rewind().unwrap();
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes).unwrap();
        bytes
    }
    // Only the named destinations may remain: refused publications leave no temp.
    fn entries(directory: &Path) -> Vec<String> {
        let mut names: Vec<_> = fs::read_dir(directory)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }
    fn sddl(path: &Path) -> String {
        let program =
            super::windows_paths::system_program("WindowsPowerShell/v1.0/powershell.exe").unwrap();
        let output = std::process::Command::new(program)
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "(Get-Acl -LiteralPath $env:HEXBOT_ACL_PATH).Sddl",
            ])
            .env("HEXBOT_ACL_PATH", path)
            // A PowerShell 7 runner's module path reaches Windows PowerShell 5.1
            // through this Rust child, which then cannot autoload Get-Acl's module
            // (about_PSModulePath). Let 5.1 build its default path; test-only.
            .env_remove("PSModulePath")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap().trim().to_owned()
    }

    #[test]
    fn a_held_reader_that_allows_delete_blocks_persist_but_not_the_candidate() {
        let root = tempfile::tempdir().unwrap();
        for (name, publish) in [("current", true), ("candidate", false)] {
            let path = root.path().join(format!("{name}.json"));
            fs::write(&path, b"old").unwrap();
            let mut held = reader(&path, SHARE_ALL);
            let result = if publish {
                current(&path, b"new")
            } else {
                candidate(&path, b"new").map_err(|error| error.to_string())
            };
            eprintln!("Publication with a delete-sharing reader: {name}={result:?}");
            if publish {
                let message = result.unwrap_err();
                assert!(message.starts_with("replace current.json: "), "{message}");
                assert!(message.contains("(os error 5)"), "{message}");
                assert_eq!(fs::read(&path).unwrap(), b"old");
            } else {
                result.unwrap();
                assert_eq!(fs::read(&path).unwrap(), b"new");
            }
            // The retained reader keeps the bytes it opened in every case.
            assert_eq!(reread(&mut held), b"old");
        }
        assert_eq!(entries(root.path()), ["candidate.json", "current.json"]);
    }

    #[test]
    fn readers_without_delete_sharing_and_read_only_files_are_refused_by_both() {
        let root = tempfile::tempdir().unwrap();
        for (name, publish) in [("current", true), ("candidate", false)] {
            let path = root.path().join(format!("{name}.json"));
            fs::write(&path, b"old").unwrap();
            let held = reader(&path, SHARE_READ_WRITE);
            let refused = if publish {
                current(&path, b"new").err()
            } else {
                candidate(&path, b"new")
                    .err()
                    .map(|error| error.to_string())
            };
            eprintln!("Publication with a non-delete reader: {name}={refused:?}");
            assert!(refused.is_some(), "{name}");
            drop(held);
            assert_eq!(fs::read(&path).unwrap(), b"old");

            let original = fs::metadata(&path).unwrap().permissions();
            let mut read_only = original.clone();
            read_only.set_readonly(true);
            fs::set_permissions(&path, read_only).unwrap();
            let refused = if publish {
                current(&path, b"new").err()
            } else {
                candidate(&path, b"new")
                    .err()
                    .map(|error| error.to_string())
            };
            eprintln!("Publication over a read-only file: {name}={refused:?}");
            assert!(refused.is_some(), "{name}");
            assert_eq!(fs::read(&path).unwrap(), b"old");
            fs::set_permissions(&path, original).unwrap();
        }
        assert_eq!(entries(root.path()), ["candidate.json", "current.json"]);
    }

    #[test]
    fn ordinary_publication_matches_attributes_and_inherited_permissions() {
        let root = tempfile::tempdir().unwrap();
        let current_path = root.path().join("current.json");
        let candidate_path = root.path().join("candidate.json");
        for round in [b"first".as_slice(), b"second".as_slice()] {
            current(&current_path, round).unwrap();
            candidate(&candidate_path, round).unwrap();
            for path in [&current_path, &candidate_path] {
                let metadata = fs::metadata(path).unwrap();
                assert_eq!(fs::read(path).unwrap(), round);
                assert_eq!(
                    metadata.file_attributes() & ATTRIBUTE_TEMPORARY,
                    0,
                    "{path:?}"
                );
                assert!(!metadata.permissions().readonly(), "{path:?}");
            }
            assert_eq!(sddl(&current_path), sddl(&candidate_path));
        }
        assert_eq!(entries(root.path()), ["candidate.json", "current.json"]);
    }
}

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

#[test]
fn setup_revalidates_a_concurrent_newer_runtime_and_preserves_automatic_update_floor() {
    hexbot_core::services::windows_contract_tests::setup_retains_newer();
}

// Production owned-Python pass in a disposable Unicode home: first install,
// healthy repeat, recorded repairs and refusals, all through the same code
// `hexbot setup` runs. Needs network for the pinned uv, CPython and wheels.
#[tokio::test]
async fn owned_python_provisions_repairs_and_refuses_through_production_setup() {
    use sha2::{Digest, Sha256};
    use std::{fs, path::Path, process::Command};
    const LOCK: &str = include_str!("../assets/edge-tts.requirements.txt");
    fn sha(path: &Path) -> String {
        format!("{:x}", Sha256::digest(fs::read(path).unwrap()))
    }
    fn powershell(script: &str) -> std::process::Output {
        Command::new(
            windows_paths::system_program("WindowsPowerShell/v1.0/powershell.exe").unwrap(),
        )
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .output()
        .unwrap()
    }
    fn quote(path: &Path) -> String {
        format!("'{}'", path.display().to_string().replace('\'', "''"))
    }
    let root = tempfile::tempdir().unwrap();
    let home = root.path().join("Jos\u{e9} owned home");
    fs::create_dir_all(&home).unwrap();
    let home = home.canonicalize().unwrap();
    let events = std::cell::RefCell::new(Vec::<String>::new());
    let emit = |stage: &str, message: &str| events.borrow_mut().push(format!("{stage}: {message}"));
    let setup = || hexbot_core::setup::windows_contract_code_tools(&home, &emit);
    let since = |mark: usize| events.borrow()[mark..].to_vec();
    let tools = home.join("runtime/tools");
    let venv = tools.join("code-python");
    let python = venv.join("Scripts/python.exe");
    let entrypoint = venv.join("Scripts/edge-tts.exe");
    let cfg = venv.join("pyvenv.cfg");
    let identity = tools.join("code-python-identity.json");
    let receipt = tools.join("edge-tts.requirements.txt");
    let site = venv.join("Lib/site-packages");
    let log = home.join("logs/bootstrap.log");
    let probe = |label: &str| {
        let record: serde_json::Value =
            serde_json::from_slice(&fs::read(&identity).unwrap()).unwrap();
        owned_python_acceptance::assert_health(&home, record["base_key"].as_str().unwrap());
        let output = Command::new(&python)
            .args(["-I", "-B", "-c", "import aiohappyeyeballs, aiohttp, aiosignal, attrs, certifi, edge_tts, frozenlist, idna, multidict, propcache, tabulate, typing_extensions, yarl; import aiohttp._http_parser, aiohttp._http_writer, aiohttp._websocket.mask, aiohttp._websocket.reader_c, frozenlist._frozenlist, multidict._multidict, propcache._helpers_c, yarl._quoting_c; from importlib.metadata import version; print(version('edge-tts'))"])
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{label}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            String::from_utf8_lossy(&output.stdout).trim(),
            "7.2.7",
            "{label}"
        );
        let version = Command::new(&entrypoint)
            .arg("--version")
            .env("PYTHONDONTWRITEBYTECODE", "1")
            .output()
            .unwrap();
        assert_eq!(
            String::from_utf8_lossy(&version.stdout).trim(),
            "edge-tts 7.2.7",
            "{label}"
        );
    };

    // A. First install into an empty home.
    setup().await.unwrap();
    let record: serde_json::Value = serde_json::from_slice(&fs::read(&identity).unwrap()).unwrap();
    assert_eq!(record["schema"], 2);
    assert_eq!(record.as_object().unwrap().len(), 3);
    assert_eq!(
        Path::new(record["home"].as_str().unwrap())
            .canonicalize()
            .unwrap(),
        home
    );
    let key = record["base_key"].as_str().unwrap().to_owned();
    let patch = key
        .strip_prefix("cpython-3.11.")
        .and_then(|k| k.strip_suffix("-windows-x86_64-none"))
        .unwrap();
    assert!(
        !patch.is_empty() && patch.bytes().all(|b| b.is_ascii_digit()) && !patch.starts_with('0'),
        "{key}"
    );
    let base = home.join("python").join(&key);
    let alias = home.join("python/cpython-3.11-windows-x86_64-none");
    let alias_target = fs::read_link(&alias).unwrap();
    eprintln!(
        "native alias {alias:?} -> {alias_target:?}; cfg {}",
        fs::read_to_string(&cfg).unwrap()
    );
    assert_eq!(alias_target.file_name().unwrap(), key.as_str());
    assert_eq!(fs::read_to_string(&receipt).unwrap(), LOCK);
    assert_eq!(
        fs::read_to_string(venv.join("requirements.txt")).unwrap(),
        LOCK
    );
    probe("first install");
    let communicate = site.join("edge_tts/communicate.py");
    let frozen = site.join("frozenlist/_frozenlist.cp311-win_amd64.pyd");
    let dll = base.join("python311.dll");
    let base_python = base.join("python.exe");
    let mut original_paths = vec![
        python.clone(),
        entrypoint.clone(),
        communicate.clone(),
        frozen.clone(),
        dll.clone(),
        base_python.clone(),
    ];
    original_paths.extend(owned_python_acceptance::locked_sources(&home));
    let originals: Vec<(std::path::PathBuf, String)> = original_paths
        .into_iter()
        .map(|path| {
            let hash = sha(&path);
            (path, hash)
        })
        .collect();
    let restored = |label: &str| {
        for (path, digest) in &originals {
            assert_eq!(&sha(path), digest, "{label}: {}", path.display());
        }
        probe(label);
    };
    let snapshot = || -> Vec<(Vec<u8>, std::time::SystemTime)> {
        [&identity, &receipt, &venv.join("requirements.txt"), &cfg]
            .iter()
            .map(|p| {
                (
                    fs::read(p).unwrap(),
                    fs::metadata(p).unwrap().modified().unwrap(),
                )
            })
            .collect()
    };

    // D. Healthy repeat: no uv call, no identity/receipt/requirements/cfg write.
    let before = snapshot();
    let log_len = fs::metadata(&log).unwrap().len();
    let mark = events.borrow().len();
    setup().await.unwrap();
    assert_eq!(snapshot(), before);
    assert_eq!(
        fs::metadata(&log).unwrap().len(),
        log_len,
        "uv appends to the log; a healthy pass must not run it"
    );
    assert!(since(mark).is_empty(), "{:?}", since(mark));

    // C. Recorded damage repaired by the production pass, same payload hashes.
    type Damage<'a> = (&'static str, Box<dyn Fn() + 'a>, &'static str);
    let cases: Vec<Damage<'_>> = vec![
        (
            "short redirector 29 B",
            Box::new(|| fs::write(&python, b"ordinary truncated redirector").unwrap()),
            "Restoring the code tools interpreter",
        ),
        (
            "empty redirector",
            Box::new(|| fs::write(&python, b"").unwrap()),
            "Restoring the code tools interpreter",
        ),
        (
            "missing redirector",
            Box::new(|| fs::remove_file(&python).unwrap()),
            "Restoring the code tools interpreter",
        ),
        (
            "missing base python.exe",
            Box::new(|| fs::remove_file(&base_python).unwrap()),
            "Restoring the Python base",
        ),
        (
            "missing python311.dll",
            Box::new(|| fs::remove_file(&dll).unwrap()),
            "Restoring the Python base",
        ),
        (
            "missing edge entrypoint",
            Box::new(|| fs::remove_file(&entrypoint).unwrap()),
            "Repairing voice tools",
        ),
        (
            "short edge entrypoint 63 B",
            Box::new(|| fs::write(&entrypoint, [b'e'; 63]).unwrap()),
            "Repairing voice tools",
        ),
        (
            "missing native extension",
            Box::new(|| fs::remove_file(&frozen).unwrap()),
            "Repairing voice tools",
        ),
    ];
    for (label, damage, expected_event) in cases {
        damage();
        let mark = events.borrow().len();
        setup()
            .await
            .unwrap_or_else(|e| panic!("{label}: {}", e.message));
        assert!(
            since(mark).iter().any(|e| e.contains(expected_event)),
            "{label}: {:?}",
            since(mark)
        );
        assert_eq!(fs::read_to_string(&receipt).unwrap(), LOCK, "{label}");
        restored(label);
    }
    // N7. A real cut into the extension's section data must be an exact
    // ImportError after a successful pre-open; the pass repairs it.
    let image = fs::read(&frozen).unwrap();
    assert!(image.len() > 4096);
    // Fixture-only PE section offsets prove this is more than an overlay cut.
    let u16_at = |offset| u16::from_le_bytes(image[offset..offset + 2].try_into().unwrap());
    let u32_at =
        |offset| u32::from_le_bytes(image[offset..offset + 4].try_into().unwrap()) as usize;
    let pe = u32_at(0x3c);
    assert_eq!(&image[pe..pe + 4], b"PE\0\0");
    let sections = pe + 24 + usize::from(u16_at(pe + 20));
    let cut = image.len() / 2;
    let containing = (0..usize::from(u16_at(pe + 6))).find_map(|index| {
        let section = sections + index * 40;
        let size = u32_at(section + 16);
        let start = u32_at(section + 20);
        (start < cut && cut < start + size).then_some((start, size))
    });
    assert!(
        containing.is_some(),
        "half-file cut must be inside section raw data"
    );
    fs::write(&frozen, &image[..cut]).unwrap();
    eprintln!(
        "truncated {} from {} to {} bytes",
        frozen.display(),
        image.len(),
        cut
    );
    let load = Command::new(&python).args(["-I", "-B", "-c", "import importlib,json\ntry:\n importlib.import_module('frozenlist._frozenlist')\n result={'loaded':True}\nexcept BaseException as e:\n result={'loaded':False,'exact':type(e) is ImportError,'name':getattr(e,'name',None),'path':getattr(e,'path',None)}\nprint(json.dumps(result,ensure_ascii=True))"]).output().unwrap();
    assert!(
        load.status.success(),
        "{}",
        String::from_utf8_lossy(&load.stderr)
    );
    assert!(load.stdout.is_ascii());
    let failure: serde_json::Value = serde_json::from_slice(&load.stdout).unwrap();
    assert_eq!(failure["loaded"], false);
    assert_eq!(failure["exact"], true);
    assert!(["frozenlist._frozenlist", "_frozenlist"].contains(&failure["name"].as_str().unwrap()));
    assert_eq!(
        Path::new(failure["path"].as_str().unwrap())
            .canonicalize()
            .unwrap(),
        frozen.canonicalize().unwrap()
    );
    eprintln!("truncated extension probe: {failure}; section {containing:?}");
    let mark = events.borrow().len();
    setup().await.unwrap();
    assert!(
        since(mark)
            .iter()
            .any(|e| e.contains("Repairing voice tools")),
        "{:?}",
        since(mark)
    );
    restored("truncated native extension");

    // Whole recorded layers: exact venv directory, then exact base directory
    // with its dangling alias. The record stays byte-identical.
    let record_bytes = fs::read(&identity).unwrap();
    fs::remove_dir_all(&venv).unwrap();
    let mark = events.borrow().len();
    setup().await.unwrap();
    assert!(
        since(mark)
            .iter()
            .any(|e| e.contains("Recreating the code tools environment"))
    );
    assert!(
        since(mark)
            .iter()
            .any(|e| e.contains("Installing voice tools"))
    );
    assert_eq!(fs::read(&identity).unwrap(), record_bytes);
    restored("recreated venv");
    fs::remove_dir_all(&base).unwrap();
    assert!(
        fs::symlink_metadata(&alias).is_ok(),
        "alias must dangle at the recorded key"
    );
    let mark = events.borrow().len();
    setup().await.unwrap();
    assert!(
        since(mark)
            .iter()
            .any(|e| e.contains("Restoring the Python base"))
    );
    assert_eq!(
        fs::read_link(&alias).unwrap().file_name().unwrap(),
        key.as_str(),
        "N2: alias binds the recorded key after reinstall"
    );
    assert_eq!(fs::read(&identity).unwrap(), record_bytes);
    restored("recreated base");

    // E. Refusals: no uv mutation, no receipt change, original bytes kept.
    type Refusal<'a> = (&'static str, Box<dyn Fn() -> Box<dyn FnOnce()> + 'a>);
    let refusals: Vec<Refusal<'_>> = vec![
        (
            "64-byte invalid redirector",
            Box::new(|| {
                let saved = fs::read(&python).unwrap();
                fs::write(&python, [b'g'; 64]).unwrap();
                let python = python.clone();
                Box::new(move || fs::write(&python, saved).unwrap())
            }),
        ),
        (
            "existing truncated python311.dll",
            Box::new(|| {
                let saved = fs::read(&dll).unwrap();
                fs::write(&dll, &saved[..saved.len() / 2]).unwrap();
                let dll = dll.clone();
                Box::new(move || fs::write(&dll, saved).unwrap())
            }),
        ),
        (
            "malformed identity record",
            Box::new(|| {
                let saved = fs::read(&identity).unwrap();
                fs::write(&identity, b"{\"schema\":1,\"home\":\"C:\\\\elsewhere\"}").unwrap();
                let identity = identity.clone();
                Box::new(move || fs::write(&identity, saved).unwrap())
            }),
        ),
        (
            "identity record of another home",
            Box::new(|| {
                let saved = fs::read(&identity).unwrap();
                fs::write(&identity, serde_json::json!({"schema":1,"home":root.path().canonicalize().unwrap(),"base_key":key}).to_string()).unwrap();
                let identity = identity.clone();
                Box::new(move || fs::write(&identity, saved).unwrap())
            }),
        ),
        (
            "foreign pyvenv.cfg home",
            Box::new(|| {
                let saved = fs::read(&cfg).unwrap();
                let text = String::from_utf8(saved.clone())
                    .unwrap()
                    .lines()
                    .map(|l| {
                        if l.starts_with("home") {
                            format!("home = {}", root.path().display())
                        } else {
                            l.to_owned()
                        }
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                fs::write(&cfg, text).unwrap();
                let cfg = cfg.clone();
                Box::new(move || fs::write(&cfg, saved).unwrap())
            }),
        ),
        (
            "current receipt with a crashing package",
            Box::new(|| {
                let init = site.join("edge_tts/__init__.py");
                let saved = fs::read(&init).unwrap();
                fs::write(
                    &init,
                    [b"import os\nos._exit(77)\n".as_slice(), &saved].concat(),
                )
                .unwrap();
                Box::new(move || fs::write(&init, saved).unwrap())
            }),
        ),
        (
            "junction inside the uv cache before a package mutation",
            Box::new(|| {
                let junction = home.join("runtime/uv-cache/owned-junction");
                let output = powershell(&format!(
                    "New-Item -ItemType Junction -Path {} -Target {} | Out-Null",
                    quote(&junction),
                    quote(root.path())
                ));
                assert!(
                    output.status.success(),
                    "{}",
                    String::from_utf8_lossy(&output.stderr)
                );
                let saved = fs::read(&entrypoint).unwrap();
                fs::remove_file(&entrypoint).unwrap();
                let entrypoint = entrypoint.clone();
                Box::new(move || {
                    fs::remove_dir(&junction).unwrap();
                    fs::write(&entrypoint, saved).unwrap();
                })
            }),
        ),
        (
            "denied read on an expected extension",
            Box::new(|| {
                let user = std::env::var("USERNAME").unwrap();
                let deny = Command::new("icacls")
                    .arg(&frozen)
                    .args(["/deny", &format!("{user}:(R)")])
                    .output()
                    .unwrap();
                assert!(
                    deny.status.success(),
                    "{}",
                    String::from_utf8_lossy(&deny.stdout)
                );
                let frozen = frozen.clone();
                Box::new(move || {
                    let allow = Command::new("icacls")
                        .arg(&frozen)
                        .args(["/remove:d", &user])
                        .output()
                        .unwrap();
                    assert!(
                        allow.status.success(),
                        "{}",
                        String::from_utf8_lossy(&allow.stdout)
                    );
                })
            }),
        ),
    ];
    for (label, arrange) in refusals {
        let undo = arrange();
        let before = snapshot_bytes(&[&receipt, &python, &dll, &entrypoint]);
        let log_len = fs::metadata(&log).unwrap().len();
        let mark = events.borrow().len();
        let error = setup()
            .await
            .err()
            .unwrap_or_else(|| panic!("{label}: expected a refusal"));
        eprintln!("{label}: {}", error.message);
        assert!(
            error.message.starts_with("Python code tools ("),
            "{label}: {}",
            error.message
        );
        assert!(
            since(mark)
                .iter()
                .all(|e| !e.contains("Installing voice tools")
                    && !e.contains("Repairing")
                    && !e.contains("Restoring")
                    && !e.contains("Recreating")),
            "{label}: {:?}",
            since(mark)
        );
        assert_eq!(
            snapshot_bytes(&[&receipt, &python, &dll, &entrypoint]),
            before,
            "{label}"
        );
        let appended = fs::metadata(&log).unwrap().len() - log_len;
        assert!(
            appended <= error.message.len() as u64 + 2,
            "{label}: a refusal appends only its own line"
        );
        undo();
    }
    fn snapshot_bytes(paths: &[&std::path::PathBuf]) -> Vec<Option<Vec<u8>>> {
        paths.iter().map(|p| fs::read(p).ok()).collect()
    }
    restored("after refusals");
    // A stale receipt with crashing packages takes the one explicit install
    // without the old pre-probe and recovers.
    let init = site.join("edge_tts/__init__.py");
    let saved = fs::read(&init).unwrap();
    fs::write(
        &init,
        [b"import os\nos._exit(77)\n".as_slice(), &saved].concat(),
    )
    .unwrap();
    fs::write(&receipt, "old lock").unwrap();
    let mark = events.borrow().len();
    setup().await.unwrap();
    assert_eq!(since(mark), ["voice: Installing voice tools"]);
    assert_eq!(fs::read(&init).unwrap(), saved);
    assert_eq!(fs::read_to_string(&receipt).unwrap(), LOCK);
    restored("stale receipt recovery");
    // Legacy adoption: the record alone is removed; the pass records the
    // observed key again without reinstalling anything.
    fs::remove_file(&identity).unwrap();
    let mark = events.borrow().len();
    setup().await.unwrap();
    assert!(since(mark).is_empty(), "{:?}", since(mark));
    assert_eq!(fs::read(&identity).unwrap(), record_bytes);
}
