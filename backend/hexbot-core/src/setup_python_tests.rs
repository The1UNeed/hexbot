//! Portable controls for the Windows owned Python pass. Processes are faked;
//! files, links, locks and the ordered pass itself are real.
use super::*;
use serde_json::Value;
use std::collections::VecDeque;

const KEY: &str = "cpython-3.11.16-windows-x86_64-none";
const LOCK: &str = super::super::VOICE_REQUIREMENTS;
const EXE: &[u8] = b"fake interpreter image, well over sixty-four bytes long ................";

fn home() -> (tempfile::TempDir, Layout) {
    let dir = tempfile::tempdir().unwrap();
    let layout = Layout::new(&dir.path().canonicalize().unwrap());
    (dir, layout)
}
fn write(path: &Path, bytes: &[u8]) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, bytes).unwrap();
}
fn link(target: &Path, link: &Path) {
    fs::create_dir_all(link.parent().unwrap()).unwrap();
    std::os::unix::fs::symlink(target, link).unwrap();
}
fn fake_base(layout: &Layout, key: &str, overwrite: bool) {
    let base = layout.base(key);
    for leaf in ["python.exe", "python311.dll"] {
        if overwrite || !base.join(leaf).exists() {
            write(&base.join(leaf), EXE);
        }
    }
    if fs::symlink_metadata(&layout.alias).is_err() {
        link(&base, &layout.alias);
    }
}
fn fake_venv(layout: &Layout, cfg_home: &Path) {
    write(&layout.venv_python, EXE);
    write(
        &layout.venv_cfg,
        format!(
            "home = {}\nimplementation = CPython\nuv = 0.12.18\nversion_info = 3.11.16\n",
            cfg_home.display()
        )
        .as_bytes(),
    );
}
fn fake_packages(layout: &Layout) {
    let site = layout.site_packages();
    for locked in LOCKED {
        write(&site.join(locked.module).join("__init__.py"), b"# owned\n");
        for (_, relative) in locked.extensions {
            write(&site.join(relative), b"MZ fake extension");
        }
    }
    write(&site.join("edge_tts/communicate.py"), b"# owned\n");
    write(&layout.entrypoint, EXE);
}
fn healthy_probe(site: &Path) -> Value {
    let mut distributions = serde_json::Map::new();
    let mut modules = serde_json::Map::new();
    let mut extensions = serde_json::Map::new();
    let versions = locked_versions(LOCK);
    for locked in LOCKED {
        distributions.insert(
            locked.dist.into(),
            json!({"version": versions[locked.dist], "error": null}),
        );
        modules.insert(
            locked.module.into(),
            json!({"status": "ok", "origin": site.join(locked.module).join("__init__.py"), "loader": "SourceFileLoader", "error": null}),
        );
        for (full, relative) in locked.extensions {
            extensions.insert(
                (*full).into(),
                json!({
                    "preopen": {"status": "ok", "size": 17, "regular": true, "reparse": false, "error": null},
                    "import": {"status": "ok", "origin": site.join(relative), "loader": "ExtensionFileLoader", "error": null}
                }),
            );
        }
    }
    json!({"distributions": distributions, "modules": modules, "extensions": extensions})
}
fn failure(kind: &str, exact: bool, name: Option<&str>, path: Option<&Path>) -> Value {
    json!({"type": kind, "exact_import_error": exact, "name": name, "path": path, "filename": null, "errno": null, "winerror": null})
}
fn completed_settlement() -> Settlement {
    Settlement {
        child: ChildState::Reaped,
        natural_eof: [true; 2],
        pipes_closed: true,
        worker: WorkerState::Joined,
        cleanup_unconfirmed: false,
        cleanup_threshold_exceeded: false,
    }
}
fn out(status: Option<i32>, stdout: &str) -> Output {
    Output {
        status,
        stdout: stdout.as_bytes().to_vec(),
        stderr: Vec::new(),
        capture_failure: None,
        settlement: completed_settlement(),
    }
}
fn json_out(value: &Value) -> Output {
    out(Some(0), &format!("{value}\n"))
}

#[tokio::test]
async fn observability_healthy_launcher_stderr_refuses_without_pip_or_completion_write() {
    let (_dir, layout) = installed().await;
    let before = snapshot(&[&layout.identity, &layout.receipt, &layout.requirements]);
    let mut fake = Fake::new(&layout);
    let mut warning = out(Some(0), "edge-tts 7.2.7\n");
    warning.stderr = b"actual launcher warning\n".to_vec();
    fake.entry.push_back(warning);
    let result = run(&layout, &mut fake).await;
    assert!(result.is_err());
    assert!(fake.uv_calls().is_empty());
    assert_eq!(
        snapshot(&[&layout.identity, &layout.receipt, &layout.requirements]),
        before
    );
}

#[test]
fn observability_schema2_requires_the_exact_digest_field() {
    let valid =
        json!({"schema":2,"home":"/owned/home","base_key":KEY,"base_dll_sha256":"a".repeat(64)});
    assert!(parse_identity(valid.to_string().as_bytes()).is_ok());
}

/// Fake processes over the real temp home. uv calls create the files the real
/// commands would; probes answer from the queue or from the files present.
struct Fake {
    layout: Layout,
    events: Vec<String>,
    fail: Option<&'static str>,
    packages: VecDeque<Output>,
    identity: VecDeque<Output>,
    entry: VecDeque<Output>,
    identity_at_pip: Option<bool>,
    receipt_at_pip: Option<bool>,
    observer_error: Option<Value>,
    last_package: Option<Value>,
    replacement_dll: Option<Vec<u8>>,
    change_dll_during_probe: bool,
    observer_cleanup_threshold: bool,
}
impl Fake {
    fn new(layout: &Layout) -> Self {
        Self {
            layout: Layout::new(&layout.home),
            events: Vec::new(),
            fail: None,
            packages: VecDeque::new(),
            identity: VecDeque::new(),
            entry: VecDeque::new(),
            identity_at_pip: None,
            receipt_at_pip: None,
            observer_error: None,
            last_package: None,
            replacement_dll: None,
            change_dll_during_probe: false,
            observer_cleanup_threshold: false,
        }
    }
    fn uv_calls(&self) -> Vec<String> {
        self.events
            .iter()
            .filter_map(|e| e.strip_prefix("uv ").map(str::to_owned))
            .collect()
    }
}
impl Runner for Fake {
    async fn uv(
        &mut self,
        layout: &Layout,
        uv: &Path,
        env: &[(OsString, OsString)],
        args: &[OsString],
    ) -> Result<()> {
        assert_eq!(uv, layout.bin.join("uv.exe"));
        assert!(env.iter().any(|(k, v)| k == "UV_LINK_MODE" && v == "copy"));
        assert!(env.iter().all(|(k, _)| {
            !k.to_string_lossy()
                .to_ascii_uppercase()
                .starts_with("PYTHON")
        }));
        let args: Vec<String> = args
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert_eq!(args[0], "--no-config");
        self.events.push(format!("uv {}", args[1..].join(" ")));
        if args[1] == "pip" {
            self.identity_at_pip = Some(self.layout.identity.exists());
            self.receipt_at_pip = Some(self.layout.receipt.exists());
        }
        if self.fail == Some(args[1].as_str()) {
            return Err(Error::new(5243, "Code runtime installer failed: fixture"));
        }
        match args[1].as_str() {
            "python" if args.contains(&"--reinstall".to_owned()) => {
                fake_base(&self.layout, &args[5], true)
            }
            "python" => fake_base(&self.layout, KEY, false),
            "venv" => fake_venv(&self.layout, &self.layout.alias),
            "pip" => fake_packages(&self.layout),
            other => panic!("unexpected uv subcommand {other}"),
        }
        if args[1] == "python"
            && let Some(bytes) = &self.replacement_dll
        {
            fs::write(self.layout.base(KEY).join("python311.dll"), bytes).unwrap();
        }
        Ok(())
    }
    async fn python(
        &mut self,
        executable: &Path,
        args: &[OsString],
        _cwd: &Path,
        _env: &[(OsString, OsString)],
    ) -> Result<Output> {
        assert_eq!(&args[..2], &[OsString::from("-I"), OsString::from("-B")]);
        if self.fail == Some("launch")
            || (self.fail == Some("package_launch") && args[3] == PACKAGE_PROBE)
        {
            return Err(Error::new(5243, "start probe: fixture OS error 193"));
        }
        if args[3] == IDENTITY_PROBE {
            self.events.push("identity".into());
            if let Some(queued) = self.identity.pop_front() {
                return Ok(queued);
            }
            let base = self.layout.base(KEY);
            let dll_ok =
                fs::metadata(base.join("python311.dll")).is_ok_and(|m| m.len() == EXE.len() as u64);
            if fs::read(executable).ok().as_deref() != Some(EXE) || !dll_ok {
                return Ok(out(Some(1), ""));
            }
            let prefix = if executable.starts_with(&self.layout.venv) {
                &self.layout.venv
            } else {
                &base
            };
            if self.change_dll_during_probe {
                fs::write(base.join("python311.dll"), vec![b'z'; EXE.len()]).unwrap();
            }
            return Ok(json_out(
                &json!({"implementation": "CPython", "version": "3.11.16", "executable": executable, "prefix": prefix, "base_prefix": base, "python_dll": base.join("python311.dll"), "failures": {}}),
            ));
        }
        assert_eq!(args[3], PACKAGE_PROBE);
        self.events.push("packages".into());
        let output = self
            .packages
            .pop_front()
            .unwrap_or_else(|| json_out(&healthy_probe(&self.layout.site_packages())));
        self.last_package = serde_json::from_slice(&output.stdout).ok();
        Ok(output)
    }
    async fn entrypoint(
        &mut self,
        executable: &Path,
        env: &[(OsString, OsString)],
    ) -> Result<Output> {
        assert_eq!(executable, self.layout.entrypoint);
        if self.fail == Some("entry_launch") {
            return Err(Error::new(5243, "start probe: fixture OS error 193"));
        }
        assert!(
            env.iter()
                .any(|(k, v)| k == "PYTHONDONTWRITEBYTECODE" && v == "1")
        );
        let scratch = env
            .iter()
            .find(|(name, _)| name == "PYTHONPATH")
            .map(|(_, path)| PathBuf::from(path));
        self.events.push(
            if scratch.is_some() {
                "observer"
            } else {
                "entry"
            }
            .into(),
        );
        if let (Some(scratch), Some(error)) = (scratch, self.observer_error.take()) {
            let source = fs::read_to_string(scratch.join("sitecustomize.py")).unwrap();
            let hex = source
                .split("bytes.fromhex('")
                .nth(1)
                .unwrap()
                .split('\'')
                .next()
                .unwrap();
            let bytes: Vec<u8> = hex
                .as_bytes()
                .chunks_exact(2)
                .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
                .collect();
            let config: Value = serde_json::from_slice(&bytes).unwrap();
            let mut output = json_out(&observer_fixture(
                &self.layout,
                self.last_package.as_ref().unwrap(),
                error,
                config["nonce"].as_str().unwrap(),
            ));
            if self.observer_cleanup_threshold {
                output.fail("primary capture error with classified observer bytes");
                output.cleanup_threshold_failed();
            }
            return Ok(output);
        }
        Ok(self
            .entry
            .pop_front()
            .unwrap_or_else(|| out(Some(0), "edge-tts 7.2.7\r\n")))
    }
}

#[tokio::test]
async fn interpreter_launch_errors_keep_the_layer_and_original_cause_without_repair() {
    let (_dir, layout) = installed().await;
    for (failure, stage) in [
        ("launch", "base"),
        ("package_launch", "voice"),
        ("entry_launch", "voice"),
    ] {
        let mut fake = Fake::new(&layout);
        fake.fail = Some(failure);
        let error = run(&layout, &mut fake).await.unwrap_err();
        assert!(
            error
                .message
                .starts_with(&format!("Python code tools ({stage}):"))
        );
        assert!(error.message.contains("fixture OS error 193"));
        assert!(fake.uv_calls().is_empty());
        assert_eq!(fs::read_to_string(&layout.receipt).unwrap(), LOCK);
    }
}
async fn run(layout: &Layout, fake: &mut Fake) -> Result<()> {
    let emit = |_: &str, _: &str| {};
    provision(
        &layout.home,
        &emit,
        fake,
        |home| async move {
            let uv = home.join("bin/uv.exe");
            write(&uv, b"uv");
            Ok(uv)
        },
        LOCK,
    )
    .await
}
async fn installed() -> (tempfile::TempDir, Layout) {
    let (dir, layout) = home();
    let mut fake = Fake::new(&layout);
    run(&layout, &mut fake).await.unwrap();
    assert_eq!(
        fake.uv_calls(),
        [
            "python install --no-bin 3.11".to_owned(),
            format!(
                "venv --allow-existing --no-project --managed-python --python {} {}",
                layout.base(KEY).join("python.exe").display(),
                layout.venv.display()
            ),
            format!(
                "pip install --python {} --reinstall --require-hashes --no-deps --no-build -r {}",
                layout.venv_python.display(),
                layout.requirements.display()
            ),
        ]
    );
    (dir, layout)
}
fn snapshot(paths: &[&Path]) -> Vec<Option<(Vec<u8>, std::time::SystemTime)>> {
    paths
        .iter()
        .map(|p| {
            fs::metadata(p)
                .ok()
                .map(|m| (fs::read(p).unwrap(), m.modified().unwrap()))
        })
        .collect()
}

#[test]
fn identity_record_schema_is_strict() {
    let valid =
        br#"{"schema":1,"home":"/owned/home","base_key":"cpython-3.11.16-windows-x86_64-none"}"#;
    assert_eq!(
        parse_identity(valid).unwrap(),
        Identity {
            home: "/owned/home".into(),
            base_key: KEY.into(),
            base_dll_sha256: None,
        }
    );
    for invalid in [
        r#"{"schema":1,"home":"/h","base_key":"cpython-3.11.16-windows-x86_64-none","uv":"0.12.18"}"#,
        r#"{"schema":1,"schema":1,"home":"/h","base_key":"cpython-3.11.16-windows-x86_64-none"}"#,
        r#"{"schema":1,"home":"/h"}"#,
        r#"{"schema":2,"home":"/h","base_key":"cpython-3.11.16-windows-x86_64-none"}"#,
        r#"{"schema":"1","home":"/h","base_key":"cpython-3.11.16-windows-x86_64-none"}"#,
        r#"{"schema":1.0,"home":"/h","base_key":"cpython-3.11.16-windows-x86_64-none"}"#,
        r#"{"schema":1,"home":"relative","base_key":"cpython-3.11.16-windows-x86_64-none"}"#,
        r#"{"schema":1,"home":"","base_key":"cpython-3.11.16-windows-x86_64-none"}"#,
        r#"{"schema":1,"home":"/h","base_key":"cpython-3.11.016-windows-x86_64-none"}"#,
        r#"{"schema":1,"home":"/h","base_key":"cpython-3.11-windows-x86_64-none"}"#,
        r#"{"schema":1,"home":"/h","base_key":"cpython-3.12.1-windows-x86_64-none"}"#,
        r#"{"schema":1,"home":"/h","base_key":"cpython-3.11.16-windows-aarch64-none"}"#,
        r#"{"schema":1,"home":"/h","base_key":"cpython-3.11.16-windows-x86_64-none+freethreaded"}"#,
        r#"{"schema":1,"home":"/h","base_key":"CPython-3.11.16-windows-x86_64-none"}"#,
        r#"[]"#,
        r#"not json"#,
    ] {
        assert!(parse_identity(invalid.as_bytes()).is_err(), "{invalid}");
    }
    let padded = format!(
        r#"{{"schema":1,"home":"/h","base_key":"{KEY}","pad":"{}"}}"#,
        "x".repeat(17 * 1024)
    );
    assert!(parse_identity(padded.as_bytes()).is_err());
    assert_eq!(key_patch("cpython-3.11.0-windows-x86_64-none"), Some(0));
    assert_eq!(key_patch("cpython-3.11.16-windows-x86_64-none"), Some(16));
    for bad in [
        "cpython-3.11.-windows-x86_64-none",
        "cpython-3.11.1a-windows-x86_64-none",
        "cpython-3.11.16-windows-x86_64-none ",
    ] {
        assert_eq!(key_patch(bad), None, "{bad}");
    }
}

#[test]
fn uv_mutation_forms_are_closed_to_four() {
    let base_python = Path::new("/h/python/cpython-3.11.16-windows-x86_64-none/python.exe");
    let venv = Path::new("/h/runtime/tools/code-python");
    let python = Path::new("/h/runtime/tools/code-python/Scripts/python.exe");
    let requirements = Path::new("/h/runtime/tools/code-python/requirements.txt");
    let forms = [
        (
            Mutation::InstallMinor,
            "--no-config python install --no-bin 3.11",
        ),
        (
            Mutation::ReinstallKey(KEY),
            "--no-config python install --no-bin --reinstall cpython-3.11.16-windows-x86_64-none",
        ),
        (
            Mutation::Venv { base_python, venv },
            "--no-config venv --allow-existing --no-project --managed-python --python /h/python/cpython-3.11.16-windows-x86_64-none/python.exe /h/runtime/tools/code-python",
        ),
        (
            Mutation::Pip {
                python,
                requirements,
            },
            "--no-config pip install --python /h/runtime/tools/code-python/Scripts/python.exe --reinstall --require-hashes --no-deps --no-build -r /h/runtime/tools/code-python/requirements.txt",
        ),
    ];
    for (mutation, expected) in forms {
        let joined = mutation
            .args()
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join(" ");
        assert_eq!(joined, expected);
    }
}

#[test]
fn environments_scrub_uv_python_and_virtual_env_case_insensitively() {
    let (_dir, layout) = home();
    let inherited: Vec<(OsString, OsString)> = [
        ("UV_CACHE_DIR", "/poison"),
        ("uv_link_mode", "hardlink"),
        ("PYTHONPATH", "/poison"),
        ("PythonHome", "/poison"),
        ("VIRTUAL_ENV", "/poison"),
        ("virtual_env", "/poison"),
        ("HOME", "/me"),
        ("USERPROFILE", "C:\\me"),
        ("PATH", "/bin"),
        ("MULTIDICT_NO_EXTENSIONS", "1"),
    ]
    .map(|(k, v)| (k.into(), v.into()))
    .to_vec();
    let env = uv_environment(inherited.clone(), &layout);
    let get = |name: &str| {
        env.iter()
            .filter(|(k, _)| k == name)
            .map(|(_, v)| v.clone())
            .collect::<Vec<_>>()
    };
    for kept in ["HOME", "USERPROFILE", "PATH", "MULTIDICT_NO_EXTENSIONS"] {
        assert_eq!(get(kept).len(), 1, "{kept}");
    }
    for dropped in [
        "uv_link_mode",
        "PYTHONPATH",
        "PythonHome",
        "VIRTUAL_ENV",
        "virtual_env",
    ] {
        assert!(get(dropped).is_empty(), "{dropped}");
    }
    assert_eq!(get("UV_CACHE_DIR"), [OsString::from(&layout.cache)]);
    assert_eq!(
        get("UV_PYTHON_INSTALL_DIR"),
        [OsString::from(&layout.python_root)]
    );
    assert_eq!(get("UV_PYTHON_BIN_DIR"), [OsString::from(&layout.bin)]);
    assert_eq!(get("UV_LINK_MODE"), [OsString::from("copy")]);
    assert_eq!(get("UV_PYTHON_NO_REGISTRY"), [OsString::from("1")]);
    let probe = probe_environment(inherited);
    assert!(
        probe
            .iter()
            .all(|(k, _)| k != "PYTHONPATH" && k != "VIRTUAL_ENV" && k != "UV_CACHE_DIR")
    );
    assert!(probe.contains(&("PYTHONDONTWRITEBYTECODE".into(), "1".into())));
    assert!(probe.contains(&("HOME".into(), "/me".into())));
}

#[test]
fn short_launchers_are_ordinary_unshared_files_under_sixty_four_bytes() {
    let file = |len: u64, links: u32, reparse: bool| Observed {
        regular: true,
        directory: false,
        reparse,
        len,
        links,
    };
    for len in [0, 1, 29, 63] {
        assert_eq!(
            launcher_policy(Some(file(len, 1, false)), Some(file(len, 1, false))),
            Ok(Launcher::Short),
            "{len}"
        );
    }
    for len in [64, 65, 10_000] {
        assert_eq!(
            launcher_policy(Some(file(len, 1, false)), Some(file(len, 1, false))),
            Ok(Launcher::Present),
            "{len}"
        );
    }
    assert_eq!(launcher_policy(None, None), Ok(Launcher::Missing));
    assert!(launcher_policy(Some(file(29, 1, true)), Some(file(29, 1, false))).is_err());
    assert!(launcher_policy(Some(file(29, 1, false)), Some(file(29, 2, false))).is_err());
    assert!(launcher_policy(Some(file(29, 1, false)), Some(file(30, 1, false))).is_err());
    assert!(launcher_policy(Some(file(29, 1, false)), None).is_err());
    assert!(
        launcher_policy(
            Some(Observed {
                regular: false,
                directory: true,
                reparse: false,
                len: 0,
                links: 1
            }),
            None
        )
        .is_err()
    );
    // The same rules against real entries, links and symlinks.
    let (_dir, layout) = home();
    let launcher = layout.venv_python.clone();
    write(&launcher, &[b'x'; 29]);
    assert_eq!(launcher_state("t", &launcher).unwrap(), Launcher::Short);
    write(&launcher, &[b'x'; 64]);
    assert_eq!(launcher_state("t", &launcher).unwrap(), Launcher::Present);
    fs::hard_link(&launcher, layout.scripts.join("other")).unwrap();
    assert!(launcher_state("t", &launcher).is_err());
    fs::remove_file(layout.scripts.join("other")).unwrap();
    fs::remove_file(&launcher).unwrap();
    assert_eq!(launcher_state("t", &launcher).unwrap(), Launcher::Missing);
    link(&layout.venv_cfg, &launcher);
    assert!(launcher_state("t", &launcher).is_err());
}

#[test]
fn cfg_accepts_only_the_alias_or_exact_base_under_this_python_root() {
    assert_eq!(
        parse_cfg(
            "home = C:\\p\\x\nimplementation = CPython\nuv = 0.12.18\nversion_info = 3.11.16\n"
        ),
        Some(VenvConfig {
            home: "C:\\p\\x".into(),
            implementation: Some("CPython".into()),
            version_info: Some("3.11.16".into()),
            uv: true
        })
    );
    assert_eq!(parse_cfg("home = a\nhome = b\n"), None);
    assert_eq!(parse_cfg("implementation = CPython\n"), None);
    let (_dir, layout) = home();
    fake_base(&layout, KEY, false);
    let cfg = |home: &Path, implementation: &str, uv: &str, version: &str| VenvConfig {
        home: home.display().to_string(),
        implementation: Some(implementation.into()),
        version_info: Some(version.into()),
        uv: !uv.is_empty(),
    };
    let base = layout.base(KEY);
    for (home, version) in [
        (&layout.alias, "3.11.16"),
        (&base, "3.11"),
        (&base, "3.11.16.final.0"),
    ] {
        cfg_consistent("t", &cfg(home, "CPython", "0.5.0", version), &layout, KEY).unwrap();
    }
    link(&base, &layout.python_root.join("sibling-alias"));
    let outside = tempfile::tempdir().unwrap();
    link(&base, &outside.path().join(MINOR_ALIAS));
    for (home, implementation, uv, version) in [
        (
            layout.python_root.join("sibling-alias"),
            "CPython",
            "0.12.18",
            "3.11.16",
        ),
        (
            outside.path().join(MINOR_ALIAS),
            "CPython",
            "0.12.18",
            "3.11.16",
        ),
        (layout.alias.clone(), "PyPy", "0.12.18", "3.11.16"),
        (layout.alias.clone(), "CPython", "", "3.11.16"),
        (layout.alias.clone(), "CPython", "0.12.18", "3.12.1"),
        (layout.alias.clone(), "CPython", "0.12.18", "3.11.15"),
        (
            layout
                .python_root
                .join("cpython-3.11.15-windows-x86_64-none"),
            "CPython",
            "0.12.18",
            "3.11.15",
        ),
    ] {
        assert!(
            cfg_consistent("t", &cfg(&home, implementation, uv, version), &layout, KEY).is_err(),
            "{}",
            home.display()
        );
    }
}

#[test]
fn the_lock_names_all_thirteen_distributions_and_the_probe_spec_lists_eight_extensions() {
    let versions = locked_versions(LOCK);
    assert_eq!(versions.len(), 13);
    for locked in LOCKED {
        assert!(versions.contains_key(locked.dist), "{}", locked.dist);
    }
    assert_eq!(versions["edge-tts"], "7.2.7");
    let spec: Vec<Value> = serde_json::from_str(&probe_spec()).unwrap();
    assert_eq!(spec.len(), 13);
    let extensions: Vec<&str> = spec
        .iter()
        .flat_map(|i| i["extensions"].as_array().unwrap())
        .map(|e| e[1].as_str().unwrap())
        .collect();
    assert_eq!(extensions.len(), 8);
    assert!(
        extensions
            .iter()
            .all(|e| e.ends_with(".cp311-win_amd64.pyd"))
    );
    assert!(
        PACKAGE_PROBE.contains("ensure_ascii=True") && IDENTITY_PROBE.contains("ensure_ascii=True")
    );
    assert!(PACKAGE_PROBE.contains("type(error) is ImportError"));
    for module in ["json", "_ssl", "_socket", "select", "asyncio", "zlib"] {
        assert!(
            IDENTITY_PROBE.contains(&format!("\"{module}\"")),
            "{module}"
        );
    }
}

#[test]
fn complete_results_need_a_normal_exit_and_exactly_one_ascii_json_line() {
    let ok = |o: &Output| complete_json::<Value>("t", "probe", o);
    assert_eq!(ok(&out(Some(0), "{\"a\":1}\n")).unwrap(), json!({"a": 1}));
    assert_eq!(ok(&out(Some(0), "{\"a\":1}\r\n")).unwrap(), json!({"a": 1}));
    assert_eq!(
        ok(&out(Some(0), "{\"a\":\"Jos\\u00e9\"}")).unwrap(),
        json!({"a": "José"})
    );
    for bad in [
        out(Some(1), "{}\n"),
        out(None, "{}\n"),
        out(Some(0), ""),
        out(Some(0), "warning\n{}\n"),
        out(Some(0), "{}\n{}\n"),
        out(Some(0), "{\"a\":\"José\"}\n"),
        out(Some(0), "{\"a\":"),
    ] {
        assert!(ok(&bad).is_err());
    }
}

#[test]
fn package_branch_follows_recreation_and_receipt_state() {
    assert_eq!(
        package_branch(false, Receipt::Current),
        Branch::HealthRepair
    );
    for receipt in [Receipt::Absent, Receipt::Stale] {
        assert_eq!(package_branch(false, receipt), Branch::InstallUpdate);
    }
    for receipt in [Receipt::Absent, Receipt::Stale, Receipt::Current] {
        assert_eq!(package_branch(true, receipt), Branch::InstallUpdate);
    }
}

#[test]
fn classifier_accepts_only_exact_structured_damage() {
    let (_dir, layout) = home();
    fake_packages(&layout);
    let site = layout.site_packages();
    let canon = |p: &Path| p.exists().then(|| p.to_owned());
    let run = |value: &Value| {
        let probe: PackageProbe = serde_json::from_value(value.clone()).unwrap();
        classify(&probe, &locked_versions(LOCK), &site, &canon)
    };
    let healthy = healthy_probe(&site);
    assert_eq!(run(&healthy), Health::Healthy);
    let parser = site.join("aiohttp/_http_parser.cp311-win_amd64.pyd");
    let with = |edit: &dyn Fn(&mut Value)| {
        let mut value = healthy.clone();
        edit(&mut value);
        value
    };
    let repairable = |v: &Value| matches!(run(v), Health::Repairable(_));
    let refused = |v: &Value| matches!(run(v), Health::Refused(_));
    // Distributions and top-level modules.
    assert!(repairable(&with(
        &|v| v["distributions"]["aiohttp"]["version"] = json!("3.14.3")
    )));
    assert!(repairable(&with(
        &|v| v["distributions"]["yarl"] = json!({"version": null, "error": failure("PackageNotFoundError", false, Some("yarl"), None)})
    )));
    assert!(refused(&with(
        &|v| v["distributions"]["yarl"] =
            json!({"version": null, "error": failure("PermissionError", false, None, None)})
    )));
    assert!(repairable(&with(
        &|v| v["modules"]["edge_tts"] = json!({"status": "error", "origin": null, "loader": null, "error": failure("ModuleNotFoundError", false, Some("edge_tts"), None)})
    )));
    assert!(refused(&with(
        &|v| v["modules"]["edge_tts"] = json!({"status": "error", "origin": null, "loader": null, "error": failure("ModuleNotFoundError", false, Some("edge_tts.communicate"), None)})
    )));
    let syntax = |filename: &Path| json!({"status": "error", "origin": null, "loader": null, "error": {"type": "SyntaxError", "exact_import_error": false, "name": null, "path": null, "filename": filename, "errno": null, "winerror": null}});
    assert!(repairable(&with(
        &|v| v["modules"]["edge_tts"] = syntax(&site.join("edge_tts/__init__.py"))
    )));
    assert!(repairable(&with(
        &|v| v["modules"]["edge_tts"] = syntax(&site.join("yarl/__init__.py"))
    )));
    let unknown = site.join("unknown_dependency/__init__.py");
    write(&unknown, b"def (:\n");
    assert!(refused(&with(
        &|v| v["modules"]["edge_tts"] = syntax(&unknown)
    )));
    assert!(refused(&with(
        &|v| v["modules"]["edge_tts"]["origin"] = json!(site.join("yarl/__init__.py"))
    )));
    assert!(refused(&with(
        &|v| v["modules"]["edge_tts"]["loader"] = json!("SourcelessFileLoader")
    )));
    assert!(refused(&with(
        &|v| v["modules"]["edge_tts"] = json!({"status": "error", "origin": null, "loader": null, "error": failure("PermissionError", false, None, None)})
    )));
    assert!(refused(&with(
        &|v| v["modules"]["edge_tts"] = json!({"status": "error", "origin": null, "loader": null, "error": failure("ImportError", true, Some("edge_tts"), None)})
    )));
    // Native extensions after a successful ordinary pre-open.
    let load = |kind: &str, exact: bool, name: Option<&str>, path: Option<&Path>| json!({"status": "error", "origin": null, "loader": null, "error": failure(kind, exact, name, path)});
    for name in ["aiohttp._http_parser", "_http_parser"] {
        assert!(
            repairable(&with(
                &|v| v["extensions"]["aiohttp._http_parser"]["import"] =
                    load("ImportError", true, Some(name), Some(&parser))
            )),
            "{name}"
        );
    }
    for name in [
        "x_http_parser",
        "_http_parser2",
        "http_parser",
        "aiohttp",
        "aiohttp._http_writer",
        "_http_parser.cp311-win_amd64",
    ] {
        assert!(
            refused(&with(
                &|v| v["extensions"]["aiohttp._http_parser"]["import"] =
                    load("ImportError", true, Some(name), Some(&parser))
            )),
            "{name}"
        );
    }
    assert!(refused(&with(&|v| v["extensions"]["aiohttp._http_parser"]
        ["import"] =
        load("ImportError", true, None, Some(&parser)))));
    assert!(refused(&with(&|v| v["extensions"]["aiohttp._http_parser"]
        ["import"] =
        load("ImportError", true, Some("_http_parser"), None))));
    assert!(refused(&with(&|v| v["extensions"]["aiohttp._http_parser"]
        ["import"] = load(
        "ImportError",
        true,
        Some("_http_parser"),
        Some(&site.join("aiohttp/_http_writer.cp311-win_amd64.pyd"))
    ))));
    assert!(refused(&with(&|v| v["extensions"]["aiohttp._http_parser"]
        ["import"] = load(
        "ModuleNotFoundError",
        false,
        Some("aiohttp._http_parser"),
        Some(&parser)
    ))));
    assert!(refused(&with(&|v| v["extensions"]["aiohttp._http_parser"]
        ["import"] = load(
        "ImportError",
        false,
        Some("_http_parser"),
        Some(&parser)
    ))));
    assert!(refused(&with(&|v| v["extensions"]["aiohttp._http_parser"]
        ["import"] =
        load("OSError", false, Some("_http_parser"), Some(&parser)))));
    assert!(refused(&with(&|v| v["extensions"]["aiohttp._http_parser"]
        ["import"]["loader"] =
        json!("SourceFileLoader"))));
    assert!(refused(&with(&|v| v["extensions"]["aiohttp._http_parser"]
        ["import"]["origin"] =
        json!(site.join("aiohttp/_http_writer.cp311-win_amd64.pyd")))));
    // Pre-open outcomes.
    let missing =
        json!({"status": "missing", "size": null, "regular": null, "reparse": null, "error": null});
    assert!(repairable(&with(&|v| {
        v["extensions"]["aiohttp._http_parser"]["preopen"] = missing.clone();
        v["extensions"]["aiohttp._http_parser"]["import"] = load(
            "ModuleNotFoundError",
            false,
            Some("aiohttp._http_parser"),
            None,
        );
    })));
    assert!(refused(&with(
        &|v| v["extensions"]["aiohttp._http_parser"]["preopen"] = missing.clone()
    )));
    assert!(refused(&with(&|v| {
        v["extensions"]["aiohttp._http_parser"]["preopen"] = missing.clone();
        v["extensions"]["aiohttp._http_parser"]["import"] =
            load("ModuleNotFoundError", false, Some("_http_parser"), None);
    })));
    let parent_missing = json!({"status": "parent_missing", "size": null, "regular": null, "reparse": null, "error": null});
    assert!(refused(&with(&|v| v["extensions"]["aiohttp._http_parser"]
        ["preopen"] =
        parent_missing.clone())));
    assert!(repairable(&with(&|v| {
        v["extensions"]["aiohttp._http_parser"]["preopen"] = parent_missing.clone();
        v["extensions"]["aiohttp._http_parser"]["import"] = load(
            "ModuleNotFoundError",
            false,
            Some("aiohttp._http_parser"),
            None,
        );
        v["modules"]["aiohttp"] = load("ModuleNotFoundError", false, Some("aiohttp"), None);
        v["distributions"]["aiohttp"] = json!({"version": null, "error": failure("PackageNotFoundError", false, Some("aiohttp"), None)});
    })));
    let denied = with(
        &|v| v["extensions"]["aiohttp._http_parser"]["preopen"] = json!({"status": "error", "size": 301568, "regular": true, "reparse": false, "error": {"type": "PermissionError", "exact_import_error": false, "name": null, "path": null, "filename": parser, "errno": 13, "winerror": 5}}),
    );
    match run(&denied) {
        Health::Refused(cause) => assert!(cause.contains("winerror 5"), "{cause}"),
        other => panic!("{other:?}"),
    }
    assert!(refused(&with(
        &|v| v["extensions"]["aiohttp._http_parser"]["preopen"] = json!({"status": "not_ordinary", "size": 0, "regular": false, "reparse": true, "error": null})
    )));
    // Refusal dominates earlier structured damage; incomplete results refuse.
    assert!(refused(&with(&|v| {
        v["distributions"]["aiohappyeyeballs"]["version"] = json!("0.0.1");
        v["extensions"]["yarl._quoting_c"]["import"] =
            load("ImportError", true, Some("_quoting_c"), None);
    })));
    assert!(refused(&with(&|v| {
        v["extensions"]
            .as_object_mut()
            .unwrap()
            .remove("yarl._quoting_c");
    })));
    assert!(refused(&with(&|v| {
        v["modules"].as_object_mut().unwrap().remove("idna");
    })));
    assert!(serde_json::from_value::<PackageProbe>(with(&|v| v["extra"] = json!(1))).is_err());
    fs::remove_dir_all(&site).unwrap();
    assert!(refused(&healthy));
}

#[test]
fn alias_and_directory_checks_follow_nothing_but_the_proved_alias() {
    let (_dir, layout) = home();
    fs::create_dir_all(&layout.python_root).unwrap();
    assert_eq!(alias_target("t", &layout).unwrap(), None);
    link(&layout.base(KEY), &layout.alias);
    assert_eq!(
        alias_target("t", &layout).unwrap(),
        Some(KEY.into()),
        "dangling target is still proved"
    );
    fake_base(&layout, KEY, false);
    assert_eq!(alias_target("t", &layout).unwrap(), Some(KEY.into()));
    check_tree("t", &layout.python_root, Some(&layout.alias)).unwrap();
    assert!(check_tree("t", &layout.python_root, None).is_err());
    fs::remove_file(&layout.alias).unwrap();
    let outside = tempfile::tempdir().unwrap();
    for target in [
        outside.path().to_owned(),
        layout.python_root.join("not-a-key"),
        layout.base(KEY).join("Lib"),
    ] {
        link(&target, &layout.alias);
        assert!(alias_target("t", &layout).is_err(), "{}", target.display());
        fs::remove_file(&layout.alias).unwrap();
    }
    fs::create_dir(&layout.alias).unwrap();
    assert!(alias_target("t", &layout).is_err());
    fs::remove_dir(&layout.alias).unwrap();
    write(&layout.alias, b"file");
    assert!(alias_target("t", &layout).is_err());
    fs::remove_file(&layout.alias).unwrap();
    check_tree("t", &layout.cache, None).unwrap();
    fs::create_dir_all(layout.cache.join("wheels/a")).unwrap();
    write(&layout.cache.join("wheels/a/file"), b"x");
    check_tree("t", &layout.cache, None).unwrap();
    link(outside.path(), &layout.cache.join("wheels/a/junction"));
    assert!(check_tree("t", &layout.cache, None).is_err());
    fs::remove_file(layout.cache.join("wheels/a/junction")).unwrap();
    link(
        &layout.cache.join("wheels/a/file"),
        &layout.cache.join("wheels/a/filelink"),
    );
    assert!(
        check_tree("t", &layout.cache, None).is_err(),
        "file reparse entries refuse too"
    );
}

#[tokio::test]
async fn first_install_records_identity_before_voice_and_repeats_without_writes() {
    let (_dir, layout) = home();
    let mut fake = Fake::new(&layout);
    // A nonempty Python root alone is a resume, not a refusal.
    write(&layout.python_root.join("partial-download.tmp"), b"...");
    run(&layout, &mut fake).await.unwrap();
    assert_eq!(fake.identity_at_pip, Some(true));
    assert_eq!(
        fake.events.iter().filter(|e| *e == "packages").count(),
        1,
        "final probe only"
    );
    let position = |needle: &str| {
        fake.events
            .iter()
            .position(|e| e.starts_with(needle))
            .unwrap()
    };
    assert!(
        position("identity") < position("uv venv"),
        "base identity before venv creation"
    );
    let record = parse_identity(&fs::read(&layout.identity).unwrap()).unwrap();
    assert_eq!(
        record,
        Identity {
            home: layout.home.clone(),
            base_key: KEY.into(),
            base_dll_sha256: Some(format!("{:x}", Sha256::digest(EXE)))
        }
    );
    assert_eq!(fs::read_to_string(&layout.receipt).unwrap(), LOCK);
    assert_eq!(fs::read_to_string(&layout.requirements).unwrap(), LOCK);
    write(&layout.log, b"earlier log\n");
    let before = snapshot(&[
        &layout.identity,
        &layout.receipt,
        &layout.requirements,
        &layout.venv_cfg,
        &layout.log,
    ]);
    let mut again = Fake::new(&layout);
    run(&layout, &mut again).await.unwrap();
    assert!(again.uv_calls().is_empty(), "{:?}", again.events);
    assert_eq!(again.events, ["identity", "identity", "packages", "entry"]);
    assert_eq!(
        snapshot(&[
            &layout.identity,
            &layout.receipt,
            &layout.requirements,
            &layout.venv_cfg,
            &layout.log
        ]),
        before
    );
}

#[tokio::test]
async fn preflight_refuses_reparse_or_shared_fixed_paths_before_creating_runtime_or_lock() {
    let outside = tempfile::tempdir().unwrap();
    let (_dir, layout) = home();
    link(outside.path(), &layout.python_root);
    let mut fake = Fake::new(&layout);
    assert!(run(&layout, &mut fake).await.is_err());
    assert!(fake.events.is_empty());
    assert!(
        !layout.runtime.exists(),
        "nothing created before the refusal"
    );
    fs::remove_file(&layout.python_root).unwrap();
    for (leaf, other) in [
        (&layout.log, layout.logs.join("other")),
        (&layout.lock, layout.runtime.join("other")),
    ] {
        write(leaf, b"");
        fs::hard_link(leaf, &other).unwrap();
        let mut fake = Fake::new(&layout);
        assert!(run(&layout, &mut fake).await.is_err(), "{}", leaf.display());
        assert!(fake.events.is_empty());
        fs::remove_file(&other).unwrap();
        fs::remove_file(leaf).unwrap();
    }
    write(&layout.identity, b"{\"schema\":1}");
    let mut fake = Fake::new(&layout);
    assert!(run(&layout, &mut fake).await.is_err());
    assert!(fake.events.is_empty());
    assert_eq!(fs::read(&layout.identity).unwrap(), b"{\"schema\":1}");
    assert!(
        !layout.lock.exists(),
        "a malformed record refuses before the lock"
    );
}

#[tokio::test]
async fn recorded_whole_venv_recreation_invalidates_the_receipt_before_pip_and_stays_absent() {
    let (_dir, layout) = installed().await;
    let identity = fs::read(&layout.identity).unwrap();
    fs::remove_dir_all(&layout.venv).unwrap();
    let mut fake = Fake::new(&layout);
    fake.fail = Some("pip");
    assert!(run(&layout, &mut fake).await.is_err());
    assert_eq!(fake.uv_calls().len(), 2);
    assert!(fake.uv_calls()[0].starts_with("venv ") && fake.uv_calls()[1].starts_with("pip "));
    assert_eq!(
        fake.receipt_at_pip,
        Some(false),
        "obsolete receipt removed after identity, before pip"
    );
    assert!(
        !layout.receipt.exists(),
        "interrupted pip leaves completion absent"
    );
    assert_eq!(fs::read(&layout.identity).unwrap(), identity);
    // The next run installs without a pre-package probe and without recreating.
    let mut next = Fake::new(&layout);
    run(&layout, &mut next).await.unwrap();
    assert_eq!(next.uv_calls().len(), 1);
    assert!(next.uv_calls()[0].starts_with("pip "));
    let pip = next
        .events
        .iter()
        .position(|e| e.starts_with("uv pip"))
        .unwrap();
    assert!(next.events[..pip].iter().all(|e| e != "packages"));
    assert_eq!(fs::read_to_string(&layout.receipt).unwrap(), LOCK);
    // A failed recreation never touches the receipt.
    fs::remove_dir_all(&layout.venv).unwrap();
    let mut failed = Fake::new(&layout);
    failed.fail = Some("venv");
    assert!(run(&layout, &mut failed).await.is_err());
    assert_eq!(fs::read_to_string(&layout.receipt).unwrap(), LOCK);
    let mut recovered = Fake::new(&layout);
    run(&layout, &mut recovered).await.unwrap();
    assert_eq!(recovered.receipt_at_pip, Some(false));
}

#[tokio::test]
async fn short_or_missing_redirector_repairs_once_and_longer_garbage_refuses() {
    let (_dir, layout) = installed().await;
    let receipt_before = snapshot(&[&layout.receipt]);
    for image in [&[b'x'; 29][..], &[][..]] {
        fs::write(&layout.venv_python, image).unwrap();
        let mut fake = Fake::new(&layout);
        run(&layout, &mut fake).await.unwrap();
        assert_eq!(fake.uv_calls().len(), 1, "{:?}", fake.events);
        assert!(fake.uv_calls()[0].starts_with("venv --allow-existing"));
        assert_eq!(fs::read(&layout.venv_python).unwrap(), EXE);
    }
    fs::remove_file(&layout.venv_python).unwrap();
    let mut fake = Fake::new(&layout);
    run(&layout, &mut fake).await.unwrap();
    assert_eq!(fake.uv_calls().len(), 1);
    assert_eq!(
        snapshot(&[&layout.receipt]),
        receipt_before,
        "redirector repair keeps the receipt"
    );
    let garbage = [b'g'; 64];
    fs::write(&layout.venv_python, garbage).unwrap();
    let mut fake = Fake::new(&layout);
    assert!(run(&layout, &mut fake).await.is_err());
    assert!(fake.uv_calls().is_empty());
    assert_eq!(fs::read(&layout.venv_python).unwrap(), garbage);
    fs::write(&layout.venv_python, EXE).unwrap();
    fs::hard_link(&layout.venv_cfg, layout.venv.join("cfg-link")).unwrap();
    let mut fake = Fake::new(&layout);
    assert!(run(&layout, &mut fake).await.is_err());
    assert!(fake.events.is_empty());
}

#[tokio::test]
async fn current_receipt_crash_refuses_while_stale_receipt_installs_without_the_pre_probe() {
    let (_dir, layout) = installed().await;
    let mut fake = Fake::new(&layout);
    fake.packages.push_back(out(None, ""));
    assert!(run(&layout, &mut fake).await.is_err());
    assert!(fake.uv_calls().is_empty());
    let mut fake = Fake::new(&layout);
    fake.packages
        .push_back(out(Some(77), "partial {\"distributions\""));
    assert!(run(&layout, &mut fake).await.is_err());
    assert!(fake.uv_calls().is_empty());
    assert_eq!(fs::read_to_string(&layout.receipt).unwrap(), LOCK);
    // Stale receipt: identity first, then one pip install, never the old probe.
    let other = layout.tools.join("receipt-link");
    fs::write(&layout.receipt, "old lock").unwrap();
    fs::hard_link(&layout.receipt, &other).unwrap();
    let mut fake = Fake::new(&layout);
    run(&layout, &mut fake).await.unwrap();
    let pip = fake
        .events
        .iter()
        .position(|e| e.starts_with("uv pip"))
        .unwrap();
    assert_eq!(fake.events[..pip], ["identity", "identity"]);
    assert_eq!(fake.uv_calls().len(), 1);
    assert_eq!(fs::read_to_string(&layout.receipt).unwrap(), LOCK);
    assert_eq!(
        fs::read_to_string(&other).unwrap(),
        "old lock",
        "atomic replacement leaves the other link alone"
    );
    // A final probe failure publishes nothing.
    fs::write(&layout.receipt, "old lock").unwrap();
    let mut fake = Fake::new(&layout);
    fake.entry.push_back(out(Some(0), "edge-tts 7.2.6\n"));
    assert!(run(&layout, &mut fake).await.is_err());
    assert_eq!(fs::read_to_string(&layout.receipt).unwrap(), "old lock");
}

#[tokio::test]
async fn final_package_crash_or_malformed_output_never_publishes_completion() {
    for recreated in [false, true] {
        for crashed in [false, true] {
            let (_dir, layout) = installed().await;
            let identity = snapshot(&[&layout.identity]);
            if recreated {
                fs::remove_dir_all(&layout.venv).unwrap();
            } else {
                fs::write(&layout.receipt, "old lock").unwrap();
            }
            let receipt = snapshot(&[&layout.receipt]);
            let mut fake = Fake::new(&layout);
            fake.packages.push_back(if crashed {
                out(None, "")
            } else {
                out(Some(0), "{\"distributions\":")
            });
            assert!(run(&layout, &mut fake).await.is_err());
            let pip = fake
                .events
                .iter()
                .position(|e| e.starts_with("uv pip"))
                .unwrap();
            assert_eq!(fake.events[pip + 1..], ["identity", "packages"]);
            assert_eq!(fake.receipt_at_pip, Some(!recreated));
            assert_eq!(snapshot(&[&layout.identity]), identity);
            if recreated {
                assert!(!layout.receipt.exists());
            } else {
                assert_eq!(snapshot(&[&layout.receipt]), receipt);
            }
            // Both failure states remain eligible for the intended next install,
            // without probing the crashing or incomplete old package result.
            let mut next = Fake::new(&layout);
            run(&layout, &mut next).await.unwrap();
            let pip = next
                .events
                .iter()
                .position(|e| e.starts_with("uv pip"))
                .unwrap();
            assert!(!next.events[..pip].iter().any(|e| e == "packages"));
            assert_eq!(next.uv_calls().len(), 1);
            assert_eq!(fs::read_to_string(&layout.receipt).unwrap(), LOCK);
        }
    }
}

#[tokio::test]
async fn module_damage_repairs_packages_without_touching_the_venv() {
    let (_dir, layout) = installed().await;
    let site = layout.site_packages();
    let before = snapshot(&[
        &layout.venv_cfg,
        &layout.venv_python,
        &layout.receipt,
        &layout.identity,
    ]);
    fs::remove_file(site.join("edge_tts/__init__.py")).unwrap();
    let mut damaged = healthy_probe(&site);
    damaged["modules"]["edge_tts"] = json!({"status": "error", "origin": null, "loader": null, "error": failure("ModuleNotFoundError", false, Some("edge_tts"), None)});
    let mut fake = Fake::new(&layout);
    fake.packages.push_back(json_out(&damaged));
    run(&layout, &mut fake).await.unwrap();
    assert_eq!(fake.uv_calls().len(), 1);
    assert!(fake.uv_calls()[0].starts_with("pip "));
    assert!(site.join("edge_tts/__init__.py").exists());
    assert_eq!(
        snapshot(&[
            &layout.venv_cfg,
            &layout.venv_python,
            &layout.receipt,
            &layout.identity
        ]),
        before
    );
    // Unknown exceptions refuse without pip, and entrypoint failures never authorize overwrite.
    let mut unknown = healthy_probe(&site);
    unknown["modules"]["edge_tts"] = json!({"status": "error", "origin": null, "loader": null, "error": failure("AttributeError", false, None, None)});
    let mut fake = Fake::new(&layout);
    fake.packages.push_back(json_out(&unknown));
    assert!(run(&layout, &mut fake).await.is_err());
    assert!(fake.uv_calls().is_empty());
    let mut fake = Fake::new(&layout);
    fake.entry.push_back(out(Some(5), ""));
    assert!(run(&layout, &mut fake).await.is_err());
    assert!(fake.uv_calls().is_empty());
    fs::write(&layout.entrypoint, [b'e'; 29]).unwrap();
    let mut fake = Fake::new(&layout);
    run(&layout, &mut fake).await.unwrap();
    assert_eq!(fake.uv_calls().len(), 1);
    assert_eq!(fs::read(&layout.entrypoint).unwrap(), EXE);
}

#[tokio::test]
async fn recorded_base_absence_and_missing_dll_repair_but_present_dll_damage_refuses() {
    let (_dir, layout) = installed().await;
    let base = layout.base(KEY);
    let reinstall = format!("python install --no-bin --reinstall {KEY}");
    fs::remove_dir_all(&base).unwrap();
    assert!(
        fs::symlink_metadata(&layout.alias).is_ok(),
        "alias dangles at the recorded key"
    );
    let mut fake = Fake::new(&layout);
    run(&layout, &mut fake).await.unwrap();
    assert_eq!(fake.uv_calls(), std::slice::from_ref(&reinstall));
    for leaf in ["python.exe", "python311.dll"] {
        fs::remove_file(base.join(leaf)).unwrap();
        let mut fake = Fake::new(&layout);
        run(&layout, &mut fake).await.unwrap();
        assert_eq!(fake.uv_calls(), std::slice::from_ref(&reinstall), "{leaf}");
    }
    fs::write(base.join("python.exe"), [b'p'; 29]).unwrap();
    let mut fake = Fake::new(&layout);
    run(&layout, &mut fake).await.unwrap();
    assert_eq!(fake.uv_calls(), std::slice::from_ref(&reinstall));
    fs::write(base.join("python311.dll"), b"truncated").unwrap();
    let mut fake = Fake::new(&layout);
    assert!(run(&layout, &mut fake).await.is_err());
    assert!(fake.uv_calls().is_empty());
    assert_eq!(fs::read(base.join("python311.dll")).unwrap(), b"truncated");
    fs::write(base.join("python311.dll"), EXE).unwrap();
    // A dangling alias naming another key, or a missing Python root, refuses.
    fs::remove_dir_all(&base).unwrap();
    fs::remove_file(&layout.alias).unwrap();
    link(
        &layout
            .python_root
            .join("cpython-3.11.15-windows-x86_64-none"),
        &layout.alias,
    );
    let mut fake = Fake::new(&layout);
    assert!(run(&layout, &mut fake).await.is_err());
    assert!(fake.uv_calls().is_empty());
    fs::remove_dir_all(&layout.python_root).unwrap();
    let mut fake = Fake::new(&layout);
    assert!(run(&layout, &mut fake).await.is_err());
    assert!(fake.uv_calls().is_empty());
    assert!(layout.identity.exists() && !layout.python_root.exists());
}

#[tokio::test]
async fn unrecorded_homes_adopt_consistent_venvs_and_refuse_damaged_or_unknown_ones() {
    // Nonempty venv without a usable cfg is neither first install nor adoption.
    let (_dir, layout) = home();
    write(&layout.venv_python, EXE);
    let mut fake = Fake::new(&layout);
    assert!(run(&layout, &mut fake).await.is_err());
    assert!(fake.events.is_empty());
    assert!(!layout.identity.exists());
    // Legacy adoption: healthy base and venv, stale receipt, no record.
    let (_dir, layout) = home();
    fake_base(&layout, KEY, false);
    fake_venv(&layout, &layout.base(KEY));
    fake_packages(&layout);
    write(&layout.receipt, b"old lock");
    let mut fake = Fake::new(&layout);
    run(&layout, &mut fake).await.unwrap();
    assert_eq!(fake.uv_calls().len(), 1);
    assert!(fake.uv_calls()[0].starts_with("pip "));
    assert_eq!(fake.identity_at_pip, Some(true), "record before voice");
    assert_eq!(
        parse_identity(&fs::read(&layout.identity).unwrap())
            .unwrap()
            .base_key,
        KEY
    );
    assert_eq!(fs::read_to_string(&layout.receipt).unwrap(), LOCK);
    // Adoption with a current receipt and healthy packages writes only the record.
    let (_dir, layout) = home();
    fake_base(&layout, KEY, false);
    fake_venv(&layout, &layout.alias);
    fake_packages(&layout);
    write(&layout.receipt, LOCK.as_bytes());
    let mut fake = Fake::new(&layout);
    run(&layout, &mut fake).await.unwrap();
    assert!(fake.uv_calls().is_empty());
    assert!(layout.identity.exists());
    // Damaged unrecorded base or venv refuses without repair or record.
    for damage in ["base", "venv"] {
        let (_dir, layout) = home();
        fake_base(&layout, KEY, false);
        fake_venv(&layout, &layout.alias);
        fake_packages(&layout);
        if damage == "base" {
            fs::remove_file(layout.base(KEY).join("python.exe")).unwrap();
        } else {
            fs::write(&layout.venv_python, [b'x'; 29]).unwrap();
        }
        let mut fake = Fake::new(&layout);
        assert!(run(&layout, &mut fake).await.is_err(), "{damage}");
        assert!(fake.uv_calls().is_empty());
        assert!(!layout.identity.exists());
    }
    // A record for another home refuses even when everything else is healthy.
    let (_dir, layout) = installed().await;
    let elsewhere = tempfile::tempdir().unwrap();
    write(
        &layout.identity,
        json!({"schema": 1, "home": elsewhere.path().canonicalize().unwrap(), "base_key": KEY})
            .to_string()
            .as_bytes(),
    );
    let mut fake = Fake::new(&layout);
    assert!(run(&layout, &mut fake).await.is_err());
    assert!(fake.events.is_empty());
}

#[tokio::test]
async fn concurrent_passes_serialize_under_the_activation_lock() {
    let (_dir, layout) = home();
    let mut first = Fake::new(&layout);
    let mut second = Fake::new(&layout);
    let (a, b) = tokio::join!(run(&layout, &mut first), run(&layout, &mut second));
    a.unwrap();
    b.unwrap();
    let mut calls = first.uv_calls();
    calls.extend(second.uv_calls());
    assert_eq!(
        calls.len(),
        3,
        "one install sequence across both passes: {calls:?}"
    );
    assert!(first.uv_calls().is_empty() || second.uv_calls().is_empty());
    assert_eq!(fs::read_to_string(&layout.receipt).unwrap(), LOCK);
}

#[tokio::test]
async fn refused_logs_never_write_through_links_or_reparse_parents() {
    for kind in ["hardlink", "symlink", "parent"] {
        let (_dir, layout) = home();
        let outside = tempfile::tempdir().unwrap();
        let sentinel = outside.path().join("bootstrap.log");
        fs::write(&sentinel, b"keep outside bytes").unwrap();
        fs::create_dir_all(&layout.logs).unwrap();
        match kind {
            "hardlink" => fs::hard_link(&sentinel, &layout.log).unwrap(),
            "symlink" => link(&sentinel, &layout.log),
            _ => {
                fs::remove_dir(&layout.logs).unwrap();
                link(outside.path(), &layout.logs);
            }
        }
        let mut fake = Fake::new(&layout);
        assert!(run(&layout, &mut fake).await.is_err());
        assert!(fake.events.is_empty());
        assert_eq!(
            fs::read(&sentinel).unwrap(),
            b"keep outside bytes",
            "{kind}"
        );
    }
}

#[tokio::test]
async fn native_parent_escape_refuses_before_package_execution() {
    let (_dir, layout) = installed().await;
    let outside = tempfile::tempdir().unwrap();
    let websocket = layout.site_packages().join("aiohttp/_websocket");
    fs::remove_dir_all(&websocket).unwrap();
    link(outside.path(), &websocket);
    let mut fake = Fake::new(&layout);
    assert!(run(&layout, &mut fake).await.is_err());
    assert!(fake.events.iter().all(|e| e != "packages"));
    assert!(fake.uv_calls().is_empty());
}

#[test]
fn required_transitive_source_missing_is_repairable_but_unknown_names_refuse() {
    let (_dir, layout) = home();
    fake_packages(&layout);
    let site = layout.site_packages();
    fs::remove_file(site.join("edge_tts/communicate.py")).unwrap();
    for missing in ["edge_tts.communicate", "unknown_dependency"] {
        let mut value = healthy_probe(&site);
        value["modules"]["edge_tts"] = json!({"status":"error", "origin":null, "loader":null,
            "error":failure("ModuleNotFoundError", false, Some(missing), None)});
        let probe = serde_json::from_value(value).unwrap();
        let health = classify(&probe, &locked_versions(LOCK), &site, &|p| {
            canonical(p).ok()
        });
        assert_eq!(
            matches!(health, Health::Repairable(_)),
            missing == "edge_tts.communicate",
            "{missing}: {health:?}"
        );
    }
}

#[tokio::test]
async fn surviving_invalid_cfg_or_missing_launcher_parent_refuses_before_base_repair() {
    for damage in ["cfg", "scripts"] {
        let (_dir, layout) = installed().await;
        fs::remove_file(layout.base(KEY).join("python.exe")).unwrap();
        if damage == "cfg" {
            fs::write(
                &layout.venv_cfg,
                "home = /foreign\nimplementation = CPython\nuv = old\nversion_info = 3.11.16\n",
            )
            .unwrap();
        } else {
            fs::remove_dir_all(&layout.scripts).unwrap();
        }
        let mut fake = Fake::new(&layout);
        assert!(run(&layout, &mut fake).await.is_err());
        assert!(fake.uv_calls().is_empty(), "{damage}: {:?}", fake.events);
        assert!(!layout.base(KEY).join("python.exe").exists());
    }
}

#[test]
fn every_native_member_requires_its_own_exact_name_type_and_path() {
    let (_dir, layout) = home();
    fake_packages(&layout);
    let site = layout.site_packages();
    for (full, relative) in LOCKED.iter().flat_map(|locked| locked.extensions) {
        let short = full.rsplit('.').next().unwrap();
        for (kind, exact, name, path, eligible) in [
            (
                "ImportError",
                true,
                Some(*full),
                Some(site.join(relative)),
                true,
            ),
            (
                "ImportError",
                true,
                Some(short),
                Some(site.join(relative)),
                true,
            ),
            (
                "ImportError",
                false,
                Some(short),
                Some(site.join(relative)),
                false,
            ),
            (
                "ModuleNotFoundError",
                false,
                Some(*full),
                Some(site.join(relative)),
                false,
            ),
            (
                "ImportError",
                true,
                Some("wrong_name"),
                Some(site.join(relative)),
                false,
            ),
            ("ImportError", true, None, Some(site.join(relative)), false),
            ("ImportError", true, Some(short), None, false),
            (
                "ImportError",
                true,
                Some(short),
                Some(site.join("other.pyd")),
                false,
            ),
        ] {
            let mut value = healthy_probe(&site);
            value["extensions"][full]["import"] = json!({"status":"error", "origin":null, "loader":null,
                "error": failure(kind, exact, name, path.as_deref())});
            let probe = serde_json::from_value(value).unwrap();
            let health = classify(&probe, &locked_versions(LOCK), &site, &|p| {
                canonical(p).ok()
            });
            assert_eq!(
                matches!(health, Health::Repairable(_)),
                eligible,
                "{full}: {health:?}"
            );
        }
    }
}

#[tokio::test]
async fn first_install_refuses_an_unproved_alias_before_uv() {
    let (_dir, layout) = home();
    let outside = tempfile::tempdir().unwrap();
    link(outside.path(), &layout.alias);
    let mut fake = Fake::new(&layout);
    assert!(run(&layout, &mut fake).await.is_err());
    assert!(fake.events.is_empty());
    assert!(!layout.identity.exists());
}

#[test]
fn obsolete_receipt_removal_preserves_original_errors_and_never_restores_old_bytes() {
    let (_dir, layout) = home();
    write(&layout.receipt, LOCK.as_bytes());
    let error =
        remove_obsolete_receipt(&layout, |_| Err(io::Error::from_raw_os_error(13))).unwrap_err();
    assert!(
        error
            .message
            .contains(&io::Error::from_raw_os_error(13).to_string())
    );
    assert_eq!(fs::read_to_string(&layout.receipt).unwrap(), LOCK);
    remove_obsolete_receipt(&layout, |path| fs::remove_file(path)).unwrap();
    remove_obsolete_receipt(&layout, |path| fs::remove_file(path)).unwrap();
    assert!(!layout.receipt.exists());
}

#[tokio::test]
async fn failed_recreated_venv_identity_keeps_the_old_receipt_and_prevents_pip() {
    let (_dir, layout) = installed().await;
    fs::remove_dir_all(&layout.venv).unwrap();
    let mut fake = Fake::new(&layout);
    let base = layout.base(KEY);
    fake.identity.push_back(json_out(&json!({"implementation":"CPython", "version":"3.11.16", "executable":base.join("python.exe"), "prefix":base, "base_prefix":base, "python_dll":base.join("python311.dll"), "failures":{}})));
    fake.identity.push_back(out(Some(1), ""));
    assert!(run(&layout, &mut fake).await.is_err());
    assert_eq!(fake.uv_calls().len(), 1);
    assert!(fake.uv_calls()[0].starts_with("venv "));
    assert_eq!(fs::read_to_string(&layout.receipt).unwrap(), LOCK);
    assert_eq!(fake.receipt_at_pip, None);
}

#[tokio::test]
async fn review_r1_package_damage_cannot_mask_entrypoint_refusal() {
    let (_dir, layout) = installed().await;
    let before = snapshot(&[
        &layout.requirements,
        &layout.receipt,
        &layout.identity,
        &layout.entrypoint,
    ]);
    let mut damaged = healthy_probe(&layout.site_packages());
    damaged["distributions"]["idna"]["version"] = json!("0");
    let mut fake = Fake::new(&layout);
    fake.packages.push_back(json_out(&damaged));
    fake.fail = Some("entry_launch");
    let error = run(&layout, &mut fake).await.unwrap_err();
    assert!(error.message.contains("OS error 193"));
    assert!(fake.uv_calls().is_empty(), "{:?}", fake.events);
    assert_eq!(
        snapshot(&[
            &layout.requirements,
            &layout.receipt,
            &layout.identity,
            &layout.entrypoint
        ]),
        before
    );
}
#[tokio::test]
async fn review_r2_existing_truncated_dll_dominates_missing_executable() {
    let (_dir, layout) = installed().await;
    fs::remove_file(layout.base(KEY).join("python.exe")).unwrap();
    fs::write(layout.base(KEY).join("python311.dll"), b"truncated").unwrap();
    let mut fake = Fake::new(&layout);
    let result = run(&layout, &mut fake).await;
    assert!(result.is_err());
    assert!(fake.uv_calls().is_empty(), "{:?}", fake.uv_calls());
    assert_eq!(
        fs::read(layout.base(KEY).join("python311.dll")).unwrap(),
        b"truncated"
    );
}
#[test]
fn review_r3_locked_dependency_source_syntax_is_owned_graph_damage() {
    let (_dir, layout) = home();
    fake_packages(&layout);
    let site = layout.site_packages();
    let source = site.join("frozenlist/__init__.py");
    fs::write(&source, b"def (:\n").unwrap();
    let mut value = healthy_probe(&site);
    for module in ["aiosignal", "frozenlist"] {
        let mut error = failure("SyntaxError", false, None, None);
        error["filename"] = json!(source);
        value["modules"][module] =
            json!({"status":"error","origin":null,"loader":null,"error":error});
    }
    let probe = serde_json::from_value(value).unwrap();
    assert!(matches!(
        classify(&probe, &locked_versions(LOCK), &site, &|p| canonical(p)
            .ok()),
        Health::Repairable(_)
    ));
}
#[test]
fn review_r4_missing_parent_cannot_mask_unknown_extension_failure() {
    let (_dir, layout) = home();
    fake_packages(&layout);
    let site = layout.site_packages();
    let mut value = healthy_probe(&site);
    value["distributions"]["frozenlist"] = json!({"version":null,"error":failure("PackageNotFoundError",false,Some("frozenlist"),None)});
    value["modules"]["frozenlist"] = json!({"status":"error","origin":null,"loader":null,"error":failure("ModuleNotFoundError",false,Some("frozenlist"),None)});
    value["extensions"]["frozenlist._frozenlist"] = json!({"preopen":{"status":"parent_missing","size":null,"regular":null,"reparse":null,"error":null},"import":{"status":"error","origin":null,"loader":null,"error":failure("PermissionError",false,None,None)}});
    let probe = serde_json::from_value(value).unwrap();
    assert!(matches!(
        classify(&probe, &locked_versions(LOCK), &site, &|p| canonical(p)
            .ok()),
        Health::Refused(_)
    ));
}
#[test]
fn review_r4_missing_parent_cannot_mask_foreign_success() {
    let (_dir, layout) = home();
    fake_packages(&layout);
    let site = layout.site_packages();
    let outside = tempfile::tempdir().unwrap();
    let foreign = outside.path().join("_frozenlist.py");
    fs::write(&foreign, b"# foreign\n").unwrap();
    let mut value = healthy_probe(&site);
    value["distributions"]["frozenlist"] = json!({"version":null,"error":failure("PackageNotFoundError",false,Some("frozenlist"),None)});
    value["extensions"]["frozenlist._frozenlist"] = json!({"preopen":{"status":"parent_missing","size":null,"regular":null,"reparse":null,"error":null},"import":{"status":"ok","origin":foreign,"loader":"SourceFileLoader","error":null}});
    let probe = serde_json::from_value(value).unwrap();
    assert!(matches!(
        classify(&probe, &locked_versions(LOCK), &site, &|p| canonical(p)
            .ok()),
        Health::Refused(_)
    ));
}
#[test]
fn review_r5_real_identity_probe_preserves_os_cause() {
    let wrapper = format!(
        "import builtins\noriginal=builtins.__import__\ndef controlled(name,*args,**kwargs):\n if name=='_ssl': raise PermissionError(13,'owned denied stdlib sentinel','owned/\\u4e2d_ssl.pyd')\n return original(name,*args,**kwargs)\nbuiltins.__import__=controlled\nexec({})\n",
        json!(IDENTITY_PROBE)
    );
    let output = std::process::Command::new("python3")
        .args(["-I", "-B", "-c", &wrapper])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stdout.is_ascii());
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["failures"]["_ssl"]["errno"], 13);
    assert_eq!(
        value["failures"]["_ssl"]["filename"],
        "owned/\u{4e2d}_ssl.pyd"
    );
    assert!(
        value["failures"]["_ssl"]["message"]
            .as_str()
            .unwrap()
            .contains("owned denied stdlib sentinel")
    );
}

#[tokio::test]
async fn review_r5_identity_consumer_and_entrypoint_keep_original_diagnostics() {
    let (_dir, layout) = installed().await;
    let base = layout.base(KEY);
    let value = json!({"implementation":"CPython","version":"3.11.16","executable":base.join("python.exe"),"prefix":base,"base_prefix":base,
        "failures":{"_ssl":{"type":"PermissionError","errno":13,"winerror":5,"filename":base.join("DLLs/_ssl.pyd"),"message":"owned denied stdlib sentinel"}}});
    let probe: IdentityProbe = serde_json::from_value(value).unwrap();
    let error = identity_consistent("base", &probe, &base.join("python.exe"), &base, &base, KEY)
        .unwrap_err();
    for original in [
        "PermissionError",
        "13",
        "5",
        "_ssl.pyd",
        "owned denied stdlib sentinel",
    ] {
        assert!(error.message.contains(original), "{}", error.message);
    }
    let mut fake = Fake::new(&layout);
    let mut output = out(Some(5), "");
    output.stderr = b"owned entrypoint sharing sentinel OS error 5".to_vec();
    fake.entry.push_back(output);
    let error = run(&layout, &mut fake).await.unwrap_err();
    assert!(
        error
            .message
            .contains("owned entrypoint sharing sentinel OS error 5")
    );
    assert!(fake.uv_calls().is_empty());
}

fn child_command(code: &str) -> tokio::process::Command {
    let mut command = tokio::process::Command::new("python3");
    command
        .args(["-I", "-B", "-c", code])
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    command
}
#[tokio::test]
async fn observability_actual_child_complete_eof_and_cap_error_are_not_health() {
    let output = bounded_output(child_command(
        "import sys; print('edge-tts 7.2.7'); sys.stderr.write('late diagnostics\\n')",
    ))
    .await
    .unwrap();
    assert!(output.reaped() && output.capture_failure.is_none());
    let error = ordinary_entrypoint(&output, "edge-tts 7.2.7").unwrap_err();
    assert!(error.message.contains("late diagnostics"));
    let output = capture_output(child_command("import sys; sys.stdout.buffer.write(b'x'*(1024*1024+1)); sys.stdout.flush(); sys.stdin.read()"), Duration::from_secs(2), PROBE_CLEANUP).await.unwrap();
    assert!(output.reaped());
    assert!(
        output
            .capture_failure
            .as_ref()
            .unwrap()
            .contains("exceeded")
    );
    assert!(ordinary_entrypoint(&output, "edge-tts 7.2.7").is_err());
}
#[tokio::test]
async fn observability_actual_hanging_child_is_stopped_and_reaped() {
    use tokio::io::AsyncReadExt;
    let mut command = child_command("import sys; print('R',flush=True); sys.stdin.buffer.read()");
    command
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut child = command.spawn().unwrap();
    let input = child.stdin.take().unwrap();
    let mut stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let mut ready = [0; 2];
    stdout.read_exact(&mut ready).await.unwrap();
    assert_eq!(&ready, b"R\n");
    assert!(child.try_wait().unwrap().is_none());
    let output = capture_child(
        &mut child,
        stdout,
        stderr,
        tokio::time::Instant::now() + Duration::from_millis(50),
        PROBE_CLEANUP,
    )
    .await
    .unwrap();
    assert!(output.reaped() && child.try_wait().unwrap().is_some());
    assert!(output.capture_failure.unwrap().contains("deadline"));
    drop(input);
}
#[tokio::test]
async fn observability_root_exit_does_not_complete_another_owned_writer_eof() {
    use std::os::fd::OwnedFd;
    use tokio::io::AsyncReadExt;
    let (reader, writer) = std::os::unix::net::UnixStream::pair().unwrap();
    reader.set_nonblocking(true).unwrap();
    let mut reader = tokio::net::UnixStream::from_std(reader).unwrap();
    let (err_reader, err_writer) = std::os::unix::net::UnixStream::pair().unwrap();
    err_reader.set_nonblocking(true).unwrap();
    let err_reader = tokio::net::UnixStream::from_std(err_reader).unwrap();
    // Both processes are directly owned by this fixture. Sharing the root's
    // write ends reproduces inherited-pipe EOF behavior without unowned kills.
    let mut holder_command = child_command("import sys; sys.stdin.buffer.read()");
    holder_command
        .stdin(std::process::Stdio::piped())
        .stdout(OwnedFd::from(writer.try_clone().unwrap()))
        .stderr(OwnedFd::from(err_writer.try_clone().unwrap()));
    let mut holder = holder_command.spawn().unwrap();
    let holder_input = holder.stdin.take().unwrap();
    let mut root_command = child_command("print('R',flush=True)");
    root_command
        .stdout(OwnedFd::from(writer))
        .stderr(OwnedFd::from(err_writer));
    let mut root = root_command.spawn().unwrap();
    let mut ready = [0; 2];
    reader.read_exact(&mut ready).await.unwrap();
    assert_eq!(&ready, b"R\n");
    assert!(root.wait().await.unwrap().success());
    assert!(holder.try_wait().unwrap().is_none());
    let output = capture_child(
        &mut root,
        reader,
        err_reader,
        tokio::time::Instant::now() + Duration::from_millis(50),
        PROBE_CLEANUP,
    )
    .await
    .unwrap();
    assert_eq!(output.status, Some(0));
    assert!(output.reaped() && output.capture_failure.unwrap().contains("deadline"));
    drop(holder_input);
    assert!(
        tokio::time::timeout(PROBE_CLEANUP, holder.wait())
            .await
            .unwrap()
            .unwrap()
            .success()
    );
}
#[tokio::test]
async fn observability_actual_pipe_read_error_preserves_primary_diagnostics_and_reaps() {
    struct BrokenAfterData(tokio::process::ChildStderr, bool);
    impl tokio::io::AsyncRead for BrokenAfterData {
        fn poll_read(
            mut self: std::pin::Pin<&mut Self>,
            cx: &mut std::task::Context<'_>,
            buffer: &mut tokio::io::ReadBuf<'_>,
        ) -> std::task::Poll<io::Result<()>> {
            if self.1 {
                return std::task::Poll::Ready(Err(io::Error::other("owned pipe read failure")));
            }
            let before = buffer.filled().len();
            let result = std::pin::Pin::new(&mut self.0).poll_read(cx, buffer);
            if buffer.filled().len() > before {
                self.1 = true;
            }
            result
        }
    }
    let mut command = child_command(
        "import sys; sys.stderr.write('primary exception cause\\n'); sys.stderr.flush(); sys.stdin.buffer.read()",
    );
    command
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut child = command.spawn().unwrap();
    let input = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    let stderr = BrokenAfterData(child.stderr.take().unwrap(), false);
    let output = capture_child(
        &mut child,
        stdout,
        stderr,
        tokio::time::Instant::now() + Duration::from_secs(2),
        PROBE_CLEANUP,
    )
    .await
    .unwrap();
    assert!(output.reaped());
    assert!(
        output
            .capture_failure
            .as_ref()
            .unwrap()
            .contains("owned pipe read failure")
    );
    let error = ordinary_entrypoint(&output, "edge-tts 7.2.7").unwrap_err();
    assert!(
        error.message.contains("primary exception cause")
            && error.message.contains("owned pipe read failure")
    );
    drop(input);
}

fn observer_fixture(layout: &Layout, graph: &Value, error: Value, nonce: &str) -> Value {
    let base = layout.base(KEY);
    let preopens: serde_json::Map<String, Value> = graph["extensions"]
        .as_object()
        .unwrap()
        .iter()
        .map(|(name, item)| (name.clone(), item["preopen"].clone()))
        .collect();
    json!({"tag":"hexbot-entrypoint-error-v1","nonce":nonce,"identity":{"implementation":"CPython","version":"3.11.16","executable":layout.venv_python,"prefix":layout.venv,"base_prefix":base,"python_dll":base.join("python311.dll"),"failures":{}},"argv":[layout.entrypoint,"--version"],"preopens":preopens,"error":error})
}
fn syntax_evidence(layout: &Layout) -> (Value, Value) {
    let source = layout.site_packages().join("edge_tts/communicate.py");
    fs::write(&source, "def (:\n").unwrap();
    let mut graph = healthy_probe(&layout.site_packages());
    let mut failed = failure("SyntaxError", false, None, None);
    failed["filename"] = json!(source);
    graph["modules"]["edge_tts"] =
        json!({"status":"error","origin":null,"loader":null,"error":failed});
    let error = json!({"module":"builtins","qualname":"SyntaxError","exact_module_not_found_error":false,"exact_syntax_error":true,"failure":failed,"message":"owned syntax cause"});
    (graph, error)
}
#[tokio::test]
async fn observability_matching_exception_repairs_once_then_ordinary_final_and_preserves_cause() {
    let (_dir, layout) = installed().await;
    let before = snapshot(&[
        &layout.identity,
        &layout.receipt,
        &layout.venv_python,
        &layout.venv_cfg,
    ]);
    let (graph, error) = syntax_evidence(&layout);
    let mut fake = Fake::new(&layout);
    fake.packages.push_back(json_out(&graph));
    fake.observer_error = Some(error.clone());
    run(&layout, &mut fake).await.unwrap();
    assert_eq!(fake.events.iter().filter(|e| *e == "observer").count(), 1);
    assert_eq!(fake.events.iter().filter(|e| *e == "entry").count(), 1);
    assert_eq!(fake.uv_calls().len(), 1);
    assert_eq!(
        snapshot(&[
            &layout.identity,
            &layout.receipt,
            &layout.venv_python,
            &layout.venv_cfg
        ]),
        before
    );
    assert!(!fs::read_dir(&layout.runtime).unwrap().any(|e| {
        e.unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".hexbot-entrypoint-")
    }));
    let (graph, _) = syntax_evidence(&layout);
    let mut failed = Fake::new(&layout);
    failed.packages.push_back(json_out(&graph));
    failed.observer_error = Some(error);
    failed.fail = Some("pip");
    let error = run(&layout, &mut failed).await.unwrap_err();
    assert!(
        error.message.contains("owned syntax cause") && error.message.contains("installer failed")
    );
}
#[tokio::test]
async fn observability_unknown_or_unmatched_exception_never_uses_unrelated_version_damage() {
    let (_dir, layout) = installed().await;
    let before = snapshot(&[&layout.identity, &layout.receipt, &layout.requirements]);
    let (mut graph, error) = syntax_evidence(&layout);
    // Valid observer syntax evidence must not match only a version mismatch.
    graph["modules"]["edge_tts"] =
        healthy_probe(&layout.site_packages())["modules"]["edge_tts"].clone();
    graph["distributions"]["idna"]["version"] = json!("old");
    let mut fake = Fake::new(&layout);
    fake.packages.push_back(json_out(&graph));
    fake.observer_error = Some(error);
    assert!(run(&layout, &mut fake).await.is_err());
    assert!(fake.uv_calls().is_empty());
    assert_eq!(
        snapshot(&[&layout.identity, &layout.receipt, &layout.requirements]),
        before
    );
}
#[test]
fn observability_exact_observer_contract_refuses_all_independent_failures() {
    let (_dir, layout) = home();
    fake_base(&layout, KEY, false);
    fake_venv(&layout, &layout.alias);
    fake_packages(&layout);
    let (graph, error) = syntax_evidence(&layout);
    let parsed: PackageProbe = serde_json::from_value(graph.clone()).unwrap();
    let good = observer_fixture(&layout, &graph, error, "nonce");
    assert!(
        observer_result(
            &json_out(&good),
            "edge-tts 7.2.7",
            "nonce",
            &layout,
            KEY,
            &parsed
        )
        .unwrap()
        .unwrap()
        .contains("owned syntax cause")
    );
    for (pointer, value) in [
        ("/nonce", json!("wrong")),
        ("/tag", json!("unknown")),
        ("/argv/1", json!("--other")),
        ("/identity/python_dll", json!("/foreign/python311.dll")),
        ("/identity/executable", json!("/foreign/python.exe")),
        ("/error/exact_syntax_error", json!(false)),
        ("/error/exact_syntax_error", json!("true")),
        ("/error/module", json!("lookalike")),
        ("/error/failure/winerror", json!(5)),
        ("/error/failure/filename", json!("/foreign/source.py")),
        ("/preopens/frozenlist._frozenlist/status", json!("error")),
    ] {
        let mut bad = good.clone();
        *bad.pointer_mut(pointer).unwrap() = value;
        assert!(
            observer_result(
                &json_out(&bad),
                "edge-tts 7.2.7",
                "nonce",
                &layout,
                KEY,
                &parsed
            )
            .is_err(),
            "{pointer}"
        );
    }
    for version_text in [false, true] {
        for failure in [
            "stderr",
            "capture",
            "unreaped",
            "nonzero",
            "crash",
            "over-limit",
        ] {
            let mut output = if version_text {
                out(Some(0), "edge-tts 7.2.7\n")
            } else {
                json_out(&good)
            };
            match failure {
                "stderr" => output.stderr = b"late atexit diagnostics\n".to_vec(),
                "capture" => output.capture_failure = Some("pipe read failed".into()),
                "unreaped" => {
                    output.settlement.child = ChildState::Unconfirmed;
                    output.capture_failure = Some("cleanup reap unconfirmed".into());
                }
                "nonzero" => output.status = Some(120),
                "crash" => output.status = None,
                _ => output.stdout.extend(vec![b'x'; OUTPUT_LIMIT]),
            }
            let denied = observer_result(&output, "edge-tts 7.2.7", "nonce", &layout, KEY, &parsed)
                .unwrap_err();
            if !version_text && failure != "over-limit" {
                assert!(denied.message.contains("owned syntax cause"));
            }
        }
    }
    for text in [
        format!("{}\nextra", good),
        format!("{}\n\n", good),
        "{\"tag\":".to_owned(),
    ] {
        assert!(
            observer_result(
                &out(Some(0), &text),
                "edge-tts 7.2.7",
                "nonce",
                &layout,
                KEY,
                &parsed
            )
            .is_err()
        );
    }
}
#[tokio::test]
async fn observability_unconfirmed_reap_retains_only_own_scratch_and_completion() {
    let (_dir, layout) = installed().await;
    let (graph, _) = syntax_evidence(&layout);
    let before = snapshot(&[&layout.identity, &layout.receipt, &layout.requirements]);
    let mut fake = Fake::new(&layout);
    fake.packages.push_back(json_out(&graph));
    let mut output = out(Some(0), "edge-tts 7.2.7\n");
    output.settlement.child = ChildState::Unconfirmed;
    output.capture_failure = Some("primary timeout; cleanup reap unconfirmed".into());
    fake.entry.push_back(output);
    let error = run(&layout, &mut fake).await.unwrap_err();
    assert!(
        error.message.contains("primary timeout") && error.message.contains("scratch retained")
    );
    assert!(fake.uv_calls().is_empty());
    assert_eq!(
        snapshot(&[&layout.identity, &layout.receipt, &layout.requirements]),
        before
    );
    let scratch: Vec<_> = fs::read_dir(&layout.runtime)
        .unwrap()
        .filter_map(|e| {
            let e = e.unwrap();
            e.file_name()
                .to_string_lossy()
                .starts_with(".hexbot-entrypoint-")
                .then_some(e.path())
        })
        .collect();
    assert_eq!(scratch.len(), 1);
    assert!(scratch[0].join("sitecustomize.py").is_file());
    // Fake has no real child. Only this test-owned leftover is removed here.
    fs::remove_file(scratch[0].join("sitecustomize.py")).unwrap();
    fs::remove_dir(&scratch[0]).unwrap();
}

#[test]
fn observability_schema2_rejects_null_duplicate_unknown_or_noncanonical_digests() {
    let good =
        json!({"schema":2,"home":"/owned/home","base_key":KEY,"base_dll_sha256":"a".repeat(64)});
    for value in [
        Value::Null,
        json!("A".repeat(64)),
        json!("f".repeat(63)),
        json!("g".repeat(64)),
        json!(7),
    ] {
        let mut bad = good.clone();
        bad["base_dll_sha256"] = value;
        assert!(parse_identity(bad.to_string().as_bytes()).is_err());
    }
    let mut legacy = good.clone();
    legacy["schema"] = json!(1);
    assert!(parse_identity(legacy.to_string().as_bytes()).is_err());
    let null_legacy =
        format!(r#"{{"schema":1,"home":"/h","base_key":"{KEY}","base_dll_sha256":null}}"#);
    assert!(parse_identity(null_legacy.as_bytes()).is_err());
    assert!(
        parse_identity(
            null_legacy
                .replace("base_dll_sha256", "base_dll_sha25\\u0036")
                .as_bytes()
        )
        .is_err()
    );
    let duplicate = format!(
        r#"{{"schema":2,"home":"/h","base_key":"{KEY}","base_dll_sha256":"{}","base_dll_sha256":"{}"}}"#,
        "a".repeat(64),
        "b".repeat(64)
    );
    assert!(parse_identity(duplicate.as_bytes()).is_err());
}
fn legacy_record(layout: &Layout) {
    fs::write(
        &layout.identity,
        json!({"schema":1,"home":layout.home,"base_key":KEY}).to_string(),
    )
    .unwrap();
}
#[tokio::test]
async fn observability_schema1_enriches_only_after_both_identities_then_repeats_without_write() {
    let (_dir, layout) = installed().await;
    legacy_record(&layout);
    let before = snapshot(&[
        &layout.receipt,
        &layout.requirements,
        &layout.venv_cfg,
        &layout.venv_python,
    ]);
    let mut fake = Fake::new(&layout);
    run(&layout, &mut fake).await.unwrap();
    assert!(fake.uv_calls().is_empty());
    let record = parse_identity(&fs::read(&layout.identity).unwrap()).unwrap();
    assert_eq!(
        record.base_dll_sha256,
        Some(format!("{:x}", Sha256::digest(EXE)))
    );
    assert_eq!(
        snapshot(&[
            &layout.receipt,
            &layout.requirements,
            &layout.venv_cfg,
            &layout.venv_python
        ]),
        before
    );
    let identity = snapshot(&[&layout.identity]);
    let mut next = Fake::new(&layout);
    run(&layout, &mut next).await.unwrap();
    assert_eq!(snapshot(&[&layout.identity]), identity);
    // Any failed second identity keeps the exact legacy record.
    legacy_record(&layout);
    let identity = snapshot(&[&layout.identity]);
    let mut failed = Fake::new(&layout);
    failed.identity.push_back(json_out(&json!({"implementation":"CPython","version":"3.11.16","executable":layout.base(KEY).join("python.exe"),"prefix":layout.base(KEY),"base_prefix":layout.base(KEY),"python_dll":layout.base(KEY).join("python311.dll"),"failures":{}})));
    failed.identity.push_back(out(Some(77), ""));
    assert!(run(&layout, &mut failed).await.is_err());
    assert_eq!(snapshot(&[&layout.identity]), identity);
    assert!(failed.uv_calls().is_empty());
}
#[tokio::test]
async fn observability_schema1_damaged_exe_refuses_but_missing_dll_can_repair_then_enrich() {
    for short in [false, true] {
        let (_dir, layout) = installed().await;
        legacy_record(&layout);
        let before = snapshot(&[&layout.identity, &layout.receipt]);
        let exe = layout.base(KEY).join("python.exe");
        if short {
            fs::write(&exe, b"x").unwrap();
        } else {
            fs::remove_file(&exe).unwrap();
        }
        let mut fake = Fake::new(&layout);
        let error = run(&layout, &mut fake).await.unwrap_err();
        assert!(error.message.contains("schema 1"));
        assert!(fake.uv_calls().is_empty());
        assert_eq!(snapshot(&[&layout.identity, &layout.receipt]), before);
    }
    let (_dir, layout) = installed().await;
    legacy_record(&layout);
    fs::remove_file(layout.base(KEY).join("python311.dll")).unwrap();
    let mut fake = Fake::new(&layout);
    run(&layout, &mut fake).await.unwrap();
    assert_eq!(fake.uv_calls().len(), 1);
    assert!(
        parse_identity(&fs::read(&layout.identity).unwrap())
            .unwrap()
            .base_dll_sha256
            .is_some()
    );
}
#[tokio::test]
async fn observability_schema2_dll_mismatch_dominates_exe_and_never_rebaselines_after_uv() {
    for short_exe in [false, true] {
        let (_dir, layout) = installed().await;
        let before = snapshot(&[&layout.identity, &layout.receipt]);
        let base = layout.base(KEY);
        if short_exe {
            fs::write(base.join("python.exe"), b"x").unwrap();
        } else {
            fs::remove_file(base.join("python.exe")).unwrap();
        }
        fs::write(base.join("python311.dll"), vec![b'z'; EXE.len()]).unwrap();
        let mut fake = Fake::new(&layout);
        assert!(run(&layout, &mut fake).await.is_err());
        assert!(fake.uv_calls().is_empty());
        assert_eq!(snapshot(&[&layout.identity, &layout.receipt]), before);
    }
    let (_dir, layout) = installed().await;
    let before = snapshot(&[&layout.identity, &layout.receipt]);
    fs::remove_file(layout.base(KEY).join("python311.dll")).unwrap();
    let mut changed = Fake::new(&layout);
    changed.replacement_dll = Some(vec![b'z'; EXE.len()]);
    let error = run(&layout, &mut changed).await.unwrap_err();
    assert!(error.message.contains("previously observed"));
    assert_eq!(changed.uv_calls().len(), 1);
    assert_eq!(snapshot(&[&layout.identity, &layout.receipt]), before);
    let mut next = Fake::new(&layout);
    assert!(run(&layout, &mut next).await.is_err());
    assert!(next.uv_calls().is_empty());
    assert_eq!(snapshot(&[&layout.identity, &layout.receipt]), before);
}
#[tokio::test]
async fn observability_failed_loaded_path_or_unstable_bytes_never_publishes_identity() {
    for unstable in [false, true] {
        let (_dir, layout) = home();
        fake_base(&layout, KEY, false);
        fake_venv(&layout, &layout.alias);
        fake_packages(&layout);
        let mut fake = Fake::new(&layout);
        if unstable {
            fake.change_dll_during_probe = true;
        } else {
            fake.identity.push_back(json_out(&json!({"implementation":"CPython","version":"3.11.16","executable":layout.base(KEY).join("python.exe"),"prefix":layout.base(KEY),"base_prefix":layout.base(KEY),"python_dll":layout.entrypoint,"failures":{}})));
        }
        assert!(run(&layout, &mut fake).await.is_err());
        assert!(!layout.identity.exists());
        assert!(fake.uv_calls().is_empty());
    }
}
#[tokio::test]
async fn observability_final_ordinary_diagnostics_cannot_publish_completion() {
    for recreated in [false, true] {
        let (_dir, layout) = installed().await;
        if recreated {
            fs::remove_dir_all(&layout.venv).unwrap();
        } else {
            fs::write(&layout.receipt, "old lock").unwrap();
        }
        let before = snapshot(&[&layout.identity, &layout.receipt]);
        let mut fake = Fake::new(&layout);
        let mut output = out(Some(0), "edge-tts 7.2.7\n");
        output.stderr = b"final launcher diagnostics".to_vec();
        fake.entry.push_back(output);
        let error = run(&layout, &mut fake).await.unwrap_err();
        assert!(error.message.contains("final launcher diagnostics"));
        assert!(!fake.events.iter().any(|e| e == "observer"));
        assert_eq!(snapshot(&[&layout.identity]), before[..1]);
        if recreated {
            assert!(!layout.receipt.exists());
        } else {
            assert_eq!(snapshot(&[&layout.identity, &layout.receipt]), before);
        }
    }
}

#[tokio::test]
async fn observability_actual_python_hook_teardown_and_alternate_lookup() {
    let (_dir, layout) = home();
    fake_base(&layout, KEY, false);
    fake_venv(&layout, &layout.alias);
    fake_packages(&layout);
    let (graph, error) = syntax_evidence(&layout);
    let graph: PackageProbe = serde_json::from_value(graph.clone()).unwrap();
    let scratch = layout.runtime.join("portable observer");
    fs::create_dir_all(&scratch).unwrap();
    let script = scratch.join("sitecustomize.py");
    fs::write(&script, observer_source(&layout.site_packages(), "nonce")).unwrap();
    let identity = observer_fixture(
        &layout,
        &healthy_probe(&layout.site_packages()),
        error,
        "nonce",
    )["identity"]
        .clone();
    let driver = r#"import sys,json,types,importlib.util
from pathlib import Path
script,body,identity,argv,extra,mode=sys.argv[1:]
source=Path(script).read_text(); head=source[:-len(body)]
namespace={'__name__':'sitecustomize','__file__':script}
exec(compile(head,script,'exec'),namespace)
# Only the native DLL identity is supplied by this portable fixture. The
# generated hook, lookup, pre-opens, finalization and capture are production code.
namespace['identity']=lambda:json.loads(identity)
sys.argv=json.loads(argv)
sys.path.insert(0,str(Path(script).parent))
sys.modules['sitecustomize']=types.ModuleType('sitecustomize')
sys.modules['sitecustomize'].__spec__=importlib.util.spec_from_file_location('sitecustomize',script)
if extra: sys.path.append(extra)
if mode=='missing-finder': sys.meta_path.insert(0,object())
exec(compile(body,script,'exec'),namespace)
if mode=='atexit':
 import atexit
 def teardown(): raise RuntimeError('actual late teardown cause')
 atexit.register(teardown)
if mode=='final-flush':
 class OwnedOutput:
  def __init__(self): self.calls=0; self.original=sys.stdout
  def write(self,text): return self.original.write(text)
  def flush(self):
   self.calls+=1
   if self.calls>1: raise OSError('actual final flush cause')
   return self.original.flush()
 sys.stdout=OwnedOutput()
if mode=='unknown': raise AttributeError('actual unknown cause')
if mode=='exit':
 import os
 os._exit(77)
if mode=='success': print('edge-tts 7.2.7')
else:
 source=Path(sys.argv[0]).parent.parent/'Lib'/'site-packages'/'edge_tts'/'communicate.py'
 exec(compile(source.read_text(),str(source),'exec'))
"#;
    let alternate = layout.runtime.join("alternate");
    fs::create_dir(&alternate).unwrap();
    let sentinel = alternate.join("executed");
    fs::write(
        alternate.join("sitecustomize.py"),
        format!(
            "from pathlib import Path\nPath({:?}).write_text('unsafe')\n",
            sentinel.display().to_string()
        ),
    )
    .unwrap();
    for mode in [
        "syntax",
        "atexit",
        "unknown",
        "exit",
        "missing-finder",
        "final-flush",
        "alternate",
        "success",
    ] {
        let mut command = child_command(driver);
        command
            .arg(&script)
            .arg(ENTRYPOINT_OBSERVER)
            .arg(identity.to_string())
            .arg(json!([layout.entrypoint, "--version"]).to_string())
            .arg(if mode == "alternate" {
                alternate.as_os_str()
            } else {
                OsStr::new("")
            })
            .arg(mode);
        let output = bounded_output(command).await.unwrap();
        let result = observer_result(&output, "edge-tts 7.2.7", "nonce", &layout, KEY, &graph);
        if matches!(mode, "syntax" | "success") {
            assert!(result.is_ok(), "{mode}: {}", output_cause(&output));
        } else {
            let error = result.unwrap_err();
            if mode == "final-flush" {
                assert_eq!(output.status, Some(120));
                assert!(error.message.contains("actual final flush cause"));
            }
            if mode == "atexit" {
                assert_eq!(output.status, Some(0));
                assert!(
                    error.message.contains("actual late teardown cause")
                        && error.message.contains("SyntaxError")
                );
            }
        }
        assert!(output.reaped());
        assert!(!sentinel.exists());
    }
}
#[tokio::test]
async fn observability_production_dll_probe_uses_pointer_sized_handle_and_grows_unicode_buffer() {
    let driver = r#"import ctypes,sys,types,os
source,path,mode=sys.argv[1:]
ctypes.__spec__.origin=os.path.join(sys.base_prefix,'Lib','ctypes','__init__.py')
sys.dllhandle=0x100000001
state={'error':0,'sizes':[]}
ctypes.set_last_error=lambda error:state.update(error=error)
ctypes.get_last_error=lambda:state['error']
ctypes.WinError=lambda code:OSError(code,'emulated API error')
class API:
 def __call__(self,handle,buffer,size):
  assert handle.value==0x100000001,'DLL handle was truncated'
  assert self.argtypes[0] is ctypes.c_void_p
  state['sizes'].append(size)
  if mode=='zero': state['error']=5; return 0
  if mode=='truncate' or len(path)>=size: state['error']=122; return size
  buffer.value=path
  return len(path)
api=API()
ctypes.WinDLL=lambda name,**kwargs:types.SimpleNamespace(GetModuleFileNameW=api)
exec(compile(source,'identity-probe','exec'))
assert state['sizes'][0]==512
if mode=='long': assert len(state['sizes'])>1
if mode=='truncate': assert state['sizes'][-1]==32768
"#;
    for mode in ["long", "zero", "truncate"] {
        let path = format!("C:/{}python311.dll", "José 中文/".repeat(100));
        let mut command = child_command(driver);
        command.arg(IDENTITY_PROBE).arg(&path).arg(mode);
        let output = bounded_output(command).await.unwrap();
        let result: Value = complete_json("test", "emulated DLL API probe", &output).unwrap();
        assert!(output.stderr.is_empty(), "{}", output_cause(&output));
        if mode == "long" {
            assert_eq!(result["python_dll"], path);
            assert!(output.stdout.is_ascii());
        } else {
            assert!(result["python_dll"].is_null());
            assert!(
                result["failures"]["python_dll"]["message"]
                    .as_str()
                    .is_some()
            );
        }
    }
}

#[test]
fn observability_missing_source_and_finite_native_names_need_the_same_graph_evidence() {
    let (_dir, layout) = home();
    fake_base(&layout, KEY, false);
    fake_venv(&layout, &layout.alias);
    fake_packages(&layout);
    fs::remove_file(layout.site_packages().join("edge_tts/communicate.py")).unwrap();
    let mut graph = healthy_probe(&layout.site_packages());
    let missing = failure(
        "ModuleNotFoundError",
        false,
        Some("edge_tts.communicate"),
        None,
    );
    graph["modules"]["edge_tts"] =
        json!({"status":"error","origin":null,"loader":null,"error":missing});
    let error = json!({"module":"builtins","qualname":"ModuleNotFoundError","exact_module_not_found_error":true,"exact_syntax_error":false,"failure":missing,"message":"missing owned communicate"});
    let parsed: PackageProbe = serde_json::from_value(graph.clone()).unwrap();
    assert!(matches!(
        classify(
            &parsed,
            &locked_versions(LOCK),
            &layout.site_packages(),
            &|p| canonical(p).ok()
        ),
        Health::Repairable(_)
    ));
    let result = observer_fixture(&layout, &graph, error, "n");
    assert!(
        observer_result(
            &json_out(&result),
            "edge-tts 7.2.7",
            "n",
            &layout,
            KEY,
            &parsed
        )
        .is_ok()
    );
    for locked in LOCKED {
        for (full, relative) in locked.extensions {
            let mut graph = healthy_probe(&layout.site_packages());
            let path = layout.site_packages().join(relative);
            let short = full.rsplit('.').next().unwrap();
            let known = failure("ImportError", true, Some(full), Some(&path));
            graph["extensions"][full]["import"] =
                json!({"status":"error","origin":null,"loader":null,"error":known});
            let parsed: PackageProbe = serde_json::from_value(graph.clone()).unwrap();
            assert!(matches!(
                classify(
                    &parsed,
                    &locked_versions(LOCK),
                    &layout.site_packages(),
                    &|p| canonical(p).ok()
                ),
                Health::Repairable(_)
            ));
            for name in [*full, short] {
                let error = json!({"module":"builtins","qualname":"ImportError","exact_module_not_found_error":false,"exact_syntax_error":false,"failure":failure("ImportError",true,Some(name),Some(&path)),"message":"actual DLL load exception"});
                let good = observer_fixture(&layout, &graph, error, "n");
                assert!(
                    observer_result(
                        &json_out(&good),
                        "edge-tts 7.2.7",
                        "n",
                        &layout,
                        KEY,
                        &parsed
                    )
                    .is_ok(),
                    "{full} {name}"
                );
                for (pointer, value) in [
                    ("/error/failure/name", json!(format!("prefix_{name}"))),
                    ("/error/failure/path", json!(layout.entrypoint)),
                    ("/error/failure/exact_import_error", json!(false)),
                    ("/error/failure/winerror", json!(5)),
                ] {
                    let mut bad = good.clone();
                    *bad.pointer_mut(pointer).unwrap() = value;
                    assert!(
                        observer_result(
                            &json_out(&bad),
                            "edge-tts 7.2.7",
                            "n",
                            &layout,
                            KEY,
                            &parsed
                        )
                        .is_err()
                    );
                }
            }
        }
    }
}
#[tokio::test]
async fn observability_actual_child_zero_cleanup_budget_never_fabricates_reap() {
    use tokio::io::AsyncReadExt;
    let mut command = child_command("import sys;print('R',flush=True);sys.stdin.buffer.read()");
    command
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut child = command.spawn().unwrap();
    let input = child.stdin.take().unwrap();
    let mut stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let mut ready = [0; 2];
    stdout.read_exact(&mut ready).await.unwrap();
    assert_eq!(&ready, b"R\n");
    assert!(child.try_wait().unwrap().is_none());
    let output = capture_child(
        &mut child,
        stdout,
        stderr,
        tokio::time::Instant::now(),
        Duration::ZERO,
    )
    .await
    .unwrap();
    assert!(
        output
            .capture_failure
            .as_ref()
            .unwrap()
            .contains("operation deadline")
    );
    if output.reaped() {
        assert!(child.try_wait().unwrap().is_some());
    } else {
        assert!(
            output
                .capture_failure
                .as_ref()
                .unwrap()
                .contains("cleanup deadline")
        );
        // The fixture still owns this exact child. Finish its cleanup without
        // claiming that the production helper's exhausted envelope succeeded.
        tokio::time::timeout(PROBE_CLEANUP, child.wait())
            .await
            .unwrap()
            .unwrap();
    }
    assert!(ordinary_entrypoint(&output, "edge-tts 7.2.7").is_err());
    drop(input);
}

#[tokio::test]
async fn observability_actual_child_cleanup_result_controls_invocation_scratch_lifetime() {
    struct HangingEntrypoint {
        fake: Fake,
        child: Option<tokio::process::Child>,
        input: Option<tokio::process::ChildStdin>,
        reaped: bool,
    }
    impl Runner for HangingEntrypoint {
        async fn uv(
            &mut self,
            layout: &Layout,
            uv: &Path,
            env: &[(OsString, OsString)],
            args: &[OsString],
        ) -> Result<()> {
            self.fake.uv(layout, uv, env, args).await
        }
        async fn python(
            &mut self,
            executable: &Path,
            args: &[OsString],
            cwd: &Path,
            env: &[(OsString, OsString)],
        ) -> Result<Output> {
            self.fake.python(executable, args, cwd, env).await
        }
        async fn entrypoint(&mut self, _: &Path, env: &[(OsString, OsString)]) -> Result<Output> {
            use tokio::io::AsyncReadExt;
            let scratch = env
                .iter()
                .find(|(name, _)| name == "PYTHONPATH")
                .unwrap()
                .1
                .clone();
            assert!(Path::new(&scratch).join("sitecustomize.py").is_file());
            // This is a real helper/process lifetime control, not a claim that
            // a Unix Python child is the shipped Windows launcher.
            let mut command =
                child_command("import sys;print('R',flush=True);sys.stdin.buffer.read()");
            command
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped());
            let mut child = command.spawn().unwrap();
            self.input = child.stdin.take();
            let mut stdout = child.stdout.take().unwrap();
            let stderr = child.stderr.take().unwrap();
            let mut ready = [0; 2];
            stdout.read_exact(&mut ready).await.unwrap();
            assert_eq!(&ready, b"R\n");
            assert!(child.try_wait().unwrap().is_none());
            let output = capture_child(
                &mut child,
                stdout,
                stderr,
                tokio::time::Instant::now(),
                Duration::ZERO,
            )
            .await?;
            self.reaped = output.reaped();
            self.child = Some(child);
            Ok(output)
        }
    }
    let (_dir, layout) = installed().await;
    let (graph, _) = syntax_evidence(&layout);
    let before = snapshot(&[&layout.identity, &layout.receipt, &layout.requirements]);
    let mut fake = Fake::new(&layout);
    fake.packages.push_back(json_out(&graph));
    let mut runner = HangingEntrypoint {
        fake,
        child: None,
        input: None,
        reaped: false,
    };
    let result = provision(
        &layout.home,
        &|_, _| {},
        &mut runner,
        |home| async move { Ok(home.join("bin/uv.exe")) },
        LOCK,
    )
    .await;
    let error = result.unwrap_err();
    assert!(error.message.contains("operation deadline"));
    assert!(runner.fake.uv_calls().is_empty());
    assert_eq!(
        snapshot(&[&layout.identity, &layout.receipt, &layout.requirements]),
        before
    );
    let scratch: Vec<_> = fs::read_dir(&layout.runtime)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| {
            p.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with(".hexbot-entrypoint-")
        })
        .collect();
    assert_eq!(scratch.len(), usize::from(!runner.reaped));
    if !runner.reaped {
        assert!(
            error.message.contains("scratch retained")
                && error.message.contains("cleanup deadline")
        );
        assert!(scratch[0].join("sitecustomize.py").is_file());
    }
    // The fixture joins the same retained Child before touching retained
    // scratch. It never converts its exhausted production envelope to success.
    tokio::time::timeout(PROBE_CLEANUP, runner.child.as_mut().unwrap().wait())
        .await
        .unwrap()
        .unwrap();
    drop(runner.input.take());
    for path in scratch {
        fs::remove_file(path.join("sitecustomize.py")).unwrap();
        fs::remove_dir(path).unwrap();
    }
}

// Independent round-2 controls appended after the exact original test bytes.
#[tokio::test]
async fn review_round2_cleanup_failure_must_retain_classified_observer_cause() {
    struct ExtraScratch {
        fake: Fake,
    }
    impl Runner for ExtraScratch {
        async fn uv(
            &mut self,
            l: &Layout,
            u: &Path,
            e: &[(OsString, OsString)],
            a: &[OsString],
        ) -> Result<()> {
            self.fake.uv(l, u, e, a).await
        }
        async fn python(
            &mut self,
            p: &Path,
            a: &[OsString],
            c: &Path,
            e: &[(OsString, OsString)],
        ) -> Result<Output> {
            self.fake.python(p, a, c, e).await
        }
        async fn entrypoint(&mut self, p: &Path, e: &[(OsString, OsString)]) -> Result<Output> {
            let result = self.fake.entrypoint(p, e).await?;
            let scratch = PathBuf::from(&e.iter().find(|(k, _)| k == "PYTHONPATH").unwrap().1);
            fs::write(scratch.join("fixture-extra-leaf"), b"owned fixture").unwrap();
            Ok(result)
        }
    }
    let (_dir, layout) = installed().await;
    let (graph, error) = syntax_evidence(&layout);
    let mut fake = Fake::new(&layout);
    fake.packages.push_back(json_out(&graph));
    fake.observer_error = Some(error);
    let mut runner = ExtraScratch { fake };
    let error = provision(
        &layout.home,
        &|_, _| {},
        &mut runner,
        |h| async move { Ok(h.join("bin/uv.exe")) },
        LOCK,
    )
    .await
    .unwrap_err();
    eprintln!("cleanup error={}", error.message);
    assert!(runner.fake.uv_calls().is_empty());
    assert!(error.message.contains("remove private scratch"));
    assert!(
        error.message.contains("owned syntax cause"),
        "cleanup failure must retain the original observed exception"
    );
}
#[tokio::test]
async fn review_round2_structured_identity_refusal_must_retain_stderr_cause() {
    let (_dir, layout) = installed().await;
    let base = layout.base(KEY);
    let mut failed = json_out(
        &json!({"implementation":"CPython","version":"3.11.16","executable":base.join("python.exe"),"prefix":base,"base_prefix":base,"python_dll":base.join("python311.dll"),"failures":{"_ssl":{"type":"PermissionError","errno":13,"winerror":5,"filename":base.join("DLLs/_ssl.pyd"),"message":"original import denial"}}}),
    );
    failed.stderr = b"available original structured-probe stderr sentinel\n".to_vec();
    let mut fake = Fake::new(&layout);
    fake.identity.push_back(failed);
    let error = run(&layout, &mut fake).await.unwrap_err();
    eprintln!("identity error={}", error.message);
    assert!(fake.uv_calls().is_empty());
    assert!(error.message.contains("original import denial"));
    assert!(
        error
            .message
            .contains("available original structured-probe stderr sentinel"),
        "structured refusal must preserve available stderr cause"
    );
}

#[tokio::test]
async fn identity_stderr_alone_does_not_change_healthy_repeat_eligibility() {
    let (_dir, layout) = installed().await;
    let before = snapshot(&[&layout.identity, &layout.receipt, &layout.requirements]);
    let mut fake = Fake::new(&layout);
    let args = ["-I", "-B", "-c", IDENTITY_PROBE].map(OsString::from);
    let mut healthy = fake
        .python(
            &layout.base(KEY).join("python.exe"),
            &args,
            &layout.runtime,
            &[],
        )
        .await
        .unwrap();
    healthy.stderr = b"identity diagnostic without an import failure\n".to_vec();
    fake.identity.push_back(healthy);
    run(&layout, &mut fake).await.unwrap();
    assert!(fake.uv_calls().is_empty());
    assert_eq!(
        before,
        snapshot(&[&layout.identity, &layout.receipt, &layout.requirements])
    );
}

#[test]
fn capture_result_requires_eof_settlement_and_join_without_erasing_failure() {
    let mut output = capture::Output::empty();
    output.fail("primary read error OS error 5");
    assert!(output.settlement.cleanup_eligible()); // No child/worker/pipe existed.
    assert!(complete_capture("observer", &output).is_err());
    output.settlement = completed_settlement();
    for state in [
        Settlement {
            child: ChildState::Unconfirmed,
            ..completed_settlement()
        },
        Settlement {
            natural_eof: [true, false],
            ..completed_settlement()
        },
        Settlement {
            pipes_closed: false,
            ..completed_settlement()
        },
        Settlement {
            cleanup_threshold_exceeded: true,
            ..completed_settlement()
        },
        Settlement {
            worker: WorkerState::Running,
            ..completed_settlement()
        },
    ] {
        output.settlement = state;
        assert!(complete_capture("observer", &output).is_err());
    }
    output.append(0, &vec![b'x'; OUTPUT_LIMIT + 32]);
    output.append(1, b"late stderr diagnostic");
    output.cleanup_threshold_failed();
    output.settlement.child = ChildState::Reaped;
    output.settlement.natural_eof = [true; 2];
    output.settlement.pipes_closed = true;
    output.settlement.worker = WorkerState::Joined;
    assert_eq!(output.stdout.len(), OUTPUT_LIMIT + 1);
    assert_eq!(output.stderr, b"late stderr diagnostic");
    assert!(!output.settlement.cleanup_eligible());
    assert!(complete_capture("observer", &output).is_err());
    let causes = output.capture_failure.as_ref().unwrap();
    assert!(causes.starts_with("primary read error OS error 5"));
    assert!(causes.contains("stdout output exceeded") && causes.contains("CleanupUnconfirmed"));
}
#[tokio::test]
async fn capture_threshold_remains_a_refusal_and_preserves_scratch_after_eventual_join() {
    let (_dir, layout) = installed().await;
    let before = snapshot(&[&layout.identity, &layout.receipt, &layout.requirements]);
    let (graph, error) = syntax_evidence(&layout);
    let mut fake = Fake::new(&layout);
    fake.packages.push_back(json_out(&graph));
    fake.observer_error = Some(error);
    fake.observer_cleanup_threshold = true;
    let error = run(&layout, &mut fake).await.unwrap_err();
    assert!(error.message.contains("primary capture error"));
    assert!(error.message.contains("owned syntax cause"));
    assert!(error.message.contains("CleanupUnconfirmed"));
    assert!(fake.uv_calls().is_empty());
    assert_eq!(
        before,
        snapshot(&[&layout.identity, &layout.receipt, &layout.requirements])
    );
    let scratch: Vec<_> = fs::read_dir(&layout.runtime)
        .unwrap()
        .filter_map(|e| {
            let p = e.unwrap().path();
            p.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with(".hexbot-entrypoint-")
                .then_some(p)
        })
        .collect();
    assert_eq!(scratch.len(), 1);
    assert!(scratch[0].join("sitecustomize.py").is_file());
}
