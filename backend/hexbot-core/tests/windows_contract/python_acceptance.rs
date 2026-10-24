//! Remaining owned-Python controls, reached by the existing windows_contract target.
//! No production hooks: interruptions use the existing progress callback or an
//! owned, joined damage-only uv child. Only setup performs recovery.
use futures_util::FutureExt;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    cell::RefCell,
    collections::BTreeMap,
    fs, io,
    os::windows::{
        ffi::{OsStrExt, OsStringExt},
        fs::{MetadataExt, OpenOptionsExt},
        io::AsRawHandle,
    },
    panic::AssertUnwindSafe,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};
const LOCK: &str = include_str!("../../assets/edge-tts.requirements.txt");
const ALIAS: &str = "cpython-3.11-windows-x86_64-none";
const MODULES: &[(&str, &str)] = &[
    ("aiohappyeyeballs", "aiohappyeyeballs"),
    ("aiohttp", "aiohttp"),
    ("aiosignal", "aiosignal"),
    ("attrs", "attrs"),
    ("certifi", "certifi"),
    ("edge-tts", "edge_tts"),
    ("frozenlist", "frozenlist"),
    ("idna", "idna"),
    ("multidict", "multidict"),
    ("propcache", "propcache"),
    ("tabulate", "tabulate"),
    ("typing-extensions", "typing_extensions"),
    ("yarl", "yarl"),
];
const EXTENSIONS: &[(&str, &str)] = &[
    (
        "aiohttp._http_parser",
        "aiohttp/_http_parser.cp311-win_amd64.pyd",
    ),
    (
        "aiohttp._http_writer",
        "aiohttp/_http_writer.cp311-win_amd64.pyd",
    ),
    (
        "aiohttp._websocket.mask",
        "aiohttp/_websocket/mask.cp311-win_amd64.pyd",
    ),
    (
        "aiohttp._websocket.reader_c",
        "aiohttp/_websocket/reader_c.cp311-win_amd64.pyd",
    ),
    (
        "frozenlist._frozenlist",
        "frozenlist/_frozenlist.cp311-win_amd64.pyd",
    ),
    (
        "multidict._multidict",
        "multidict/_multidict.cp311-win_amd64.pyd",
    ),
    (
        "propcache._helpers_c",
        "propcache/_helpers_c.cp311-win_amd64.pyd",
    ),
    ("yarl._quoting_c", "yarl/_quoting_c.cp311-win_amd64.pyd"),
];
pub(super) fn locked_sources(home: &Path) -> Vec<PathBuf> {
    let site = home.join("runtime/tools/code-python/Lib/site-packages");
    MODULES
        .iter()
        .map(|(_, module)| {
            let package = site.join(module).join("__init__.py");
            let path = if package.is_file() {
                package
            } else {
                site.join(format!("{module}.py"))
            };
            assert!(path.is_file(), "missing locked source {module}");
            path
        })
        .collect()
}
fn digest(path: &Path) -> String {
    format!("{:x}", Sha256::digest(fs::read(path).unwrap()))
}
fn case(label: &str) {
    eprintln!("owned Python acceptance: {label}");
}
fn ps(script: &str) {
    let output = Command::new(
        super::windows_paths::system_program("WindowsPowerShell/v1.0/powershell.exe").unwrap(),
    )
    .args(["-NoProfile", "-NonInteractive", "-Command", script])
    .env_remove("PSModulePath")
    .output()
    .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}
fn quote(path: &Path) -> String {
    format!("'{}'", path.display().to_string().replace('\'', "''"))
}
fn junction(path: &Path, target: &Path) {
    ps(&format!(
        "New-Item -ItemType Junction -Path {} -Target {} -ErrorAction Stop | Out-Null",
        quote(path),
        quote(target)
    ));
}
fn unlink_alias(alias: &Path) {
    let m = fs::symlink_metadata(alias).unwrap();
    assert_ne!(m.file_attributes() & 0x400, 0);
    if m.file_attributes() & 0x10 != 0 {
        fs::remove_dir(alias).unwrap();
    } else {
        fs::remove_file(alias).unwrap();
    }
}
fn pins() -> BTreeMap<String, String> {
    LOCK.lines()
        .filter_map(|line| {
            let (name, rest) = line.trim().split_once("==")?;
            Some((name.to_owned(), rest.split_whitespace().next()?.to_owned()))
        })
        .collect()
}
fn python(home: &Path, script: &str, args: &[String]) -> Value {
    let output = Command::new(home.join("runtime/tools/code-python/Scripts/python.exe"))
        .args(["-I", "-B", "-c", script])
        .args(args)
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        output.stdout.is_ascii(),
        "structured probe must be ASCII escaped"
    );
    serde_json::from_slice(&output.stdout).unwrap()
}
/// Independent complete version/origin/loader and exact interpreter assertions.
pub(super) fn assert_health(home: &Path, key: &str) {
    let script = r#"import ctypes,importlib,importlib.metadata,json,platform,sys
modules,extensions=json.loads(sys.argv[1]),json.loads(sys.argv[2])
out={'implementation':platform.python_implementation(),'version':platform.python_version(),'executable':sys.executable,'prefix':sys.prefix,'base':sys.base_prefix,'distributions':{},'modules':{},'extensions':{}}
api=ctypes.WinDLL('kernel32',use_last_error=True).GetModuleFileNameW
api.argtypes=[ctypes.c_void_p,ctypes.c_wchar_p,ctypes.c_uint32]; api.restype=ctypes.c_uint32
buffer=ctypes.create_unicode_buffer(32768); count=api(ctypes.c_void_p(sys.dllhandle),buffer,len(buffer))
assert 0<count<len(buffer),ctypes.get_last_error()
out['loaded_dll']=buffer[:count]; out['ctypes_origin']=ctypes.__spec__.origin
for dist,name in modules:
 out['distributions'][dist]=importlib.metadata.version(dist)
 module=importlib.import_module(name); out['modules'][name]=[module.__spec__.origin,type(module.__spec__.loader).__name__]
for name,relative in extensions:
 module=importlib.import_module(name); out['extensions'][name]=[module.__spec__.origin,type(module.__spec__.loader).__name__]
print(json.dumps(out,ensure_ascii=True))"#;
    let result = python(
        home,
        script,
        &[json!(MODULES).to_string(), json!(EXTENSIONS).to_string()],
    );
    let venv = home.join("runtime/tools/code-python");
    let site = venv.join("Lib/site-packages");
    assert_eq!(result["implementation"], "CPython");
    assert_eq!(
        format!(
            "cpython-{}-windows-x86_64-none",
            result["version"].as_str().unwrap()
        ),
        key
    );
    for (field, expected) in [
        ("executable", venv.join("Scripts/python.exe")),
        ("prefix", venv.clone()),
        ("base", home.join("python").join(key)),
    ] {
        assert_eq!(
            Path::new(result[field].as_str().unwrap())
                .canonicalize()
                .unwrap(),
            expected.canonicalize().unwrap()
        );
    }
    assert_eq!(
        Path::new(result["loaded_dll"].as_str().unwrap())
            .canonicalize()
            .unwrap(),
        home.join("python")
            .join(key)
            .join("python311.dll")
            .canonicalize()
            .unwrap()
    );
    assert_eq!(
        Path::new(result["ctypes_origin"].as_str().unwrap())
            .canonicalize()
            .unwrap(),
        home.join("python")
            .join(key)
            .join("Lib/ctypes/__init__.py")
            .canonicalize()
            .unwrap()
    );
    let record: Value = serde_json::from_slice(
        &fs::read(home.join("runtime/tools/code-python-identity.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(record["schema"], 2);
    assert_eq!(
        record["base_dll_sha256"],
        digest(&home.join("python").join(key).join("python311.dll"))
    );
    assert_eq!(result["distributions"], json!(pins()));
    for (_, module) in MODULES {
        let entry = &result["modules"][module];
        assert_eq!(entry[1], "SourceFileLoader");
        let origin = Path::new(entry[0].as_str().unwrap())
            .canonicalize()
            .unwrap();
        assert!(
            [
                site.join(module).join("__init__.py"),
                site.join(format!("{module}.py"))
            ]
            .iter()
            .any(|p| p.canonicalize().ok().as_ref() == Some(&origin)),
            "{module}: {origin:?}"
        );
    }
    for (module, relative) in EXTENSIONS {
        assert_eq!(result["extensions"][module][1], "ExtensionFileLoader");
        assert_eq!(
            Path::new(result["extensions"][module][0].as_str().unwrap())
                .canonicalize()
                .unwrap(),
            site.join(relative).canonicalize().unwrap()
        );
    }
    let output = Command::new(venv.join("Scripts/edge-tts.exe"))
        .arg("--version")
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(output.status.success());
    assert_eq!(
        String::from_utf8_lossy(&output.stdout).trim(),
        "edge-tts 7.2.7"
    );
}
struct Home {
    _root: tempfile::TempDir,
    home: PathBuf,
    events: RefCell<Vec<String>>,
}
impl Home {
    fn empty() -> Self {
        let root = tempfile::tempdir().unwrap();
        let home = root
            .path()
            .join("Jos\u{e9} \u{4e2d}\u{6587} owned home with spaces");
        fs::create_dir(&home).unwrap();
        Self {
            _root: root,
            home: home.canonicalize().unwrap(),
            events: RefCell::new(Vec::new()),
        }
    }
    async fn installed() -> Self {
        let f = Self::empty();
        f.setup().await.unwrap();
        f.healthy();
        f
    }
    fn path(&self, relative: &str) -> PathBuf {
        self.home.join(relative)
    }
    fn emit(&self, stage: &str, message: &str) {
        self.events.borrow_mut().push(format!("{stage}: {message}"));
    }
    async fn setup(&self) -> hexbot_core::Result<()> {
        self.events.borrow_mut().clear();
        hexbot_core::setup::windows_contract_code_tools(&self.home, &|stage, message| {
            self.emit(stage, message)
        })
        .await
    }
    fn record(&self) -> Value {
        serde_json::from_slice(&fs::read(self.identity()).unwrap()).unwrap()
    }
    fn key(&self) -> String {
        self.record()["base_key"].as_str().unwrap().to_owned()
    }
    fn identity(&self) -> PathBuf {
        self.path("runtime/tools/code-python-identity.json")
    }
    fn receipt(&self) -> PathBuf {
        self.path("runtime/tools/edge-tts.requirements.txt")
    }
    fn venv(&self) -> PathBuf {
        self.path("runtime/tools/code-python")
    }
    fn site(&self) -> PathBuf {
        self.venv().join("Lib/site-packages")
    }
    fn healthy(&self) {
        assert_health(&self.home, &self.key());
        assert_eq!(fs::read_to_string(self.receipt()).unwrap(), LOCK);
    }
    fn completion(&self) -> Vec<(Vec<u8>, std::time::SystemTime)> {
        [self.identity(), self.receipt()]
            .iter()
            .map(|p| {
                (
                    fs::read(p).unwrap(),
                    fs::metadata(p).unwrap().modified().unwrap(),
                )
            })
            .collect()
    }
    fn payloads(&self) -> BTreeMap<PathBuf, String> {
        let mut files = vec![
            self.path(&format!("python/{}/python.exe", self.key())),
            self.path(&format!("python/{}/python311.dll", self.key())),
            self.venv().join("Scripts/python.exe"),
            self.venv().join("Scripts/edge-tts.exe"),
            self.site().join("edge_tts/communicate.py"),
        ];
        files.extend(locked_sources(&self.home));
        files.extend(EXTENSIONS.iter().map(|(_, p)| self.site().join(p)));
        files
            .into_iter()
            .map(|p| {
                let hash = digest(&p);
                (p, hash)
            })
            .collect()
    }
    fn restored(&self, original: &BTreeMap<PathBuf, String>) {
        for (path, hash) in original {
            assert_eq!(&digest(path), hash, "{path:?}");
        }
        self.healthy();
    }
    fn uv(&self) -> Command {
        let uv = self.path("bin/uv.exe");
        let receipt: Value =
            serde_json::from_slice(&fs::read(self.path("bin/uv-version")).unwrap()).unwrap();
        assert_eq!(receipt["version"], "0.12.18");
        assert_eq!(receipt["sha256"], digest(&uv));
        let mut command = Command::new(uv);
        command
            .env_clear()
            .envs(std::env::vars_os().filter(|(name, _)| {
                let name = name.to_string_lossy().to_ascii_uppercase();
                !name.starts_with("UV_") && !name.starts_with("PYTHON") && name != "VIRTUAL_ENV"
            }))
            .env("UV_PYTHON_INSTALL_DIR", self.path("python"))
            .env("UV_PYTHON_BIN_DIR", self.path("bin"))
            .env("UV_CACHE_DIR", self.path("runtime/uv-cache"))
            .env("UV_LINK_MODE", "copy")
            .env("UV_PYTHON_NO_REGISTRY", "1")
            .current_dir(self.path("runtime"))
            .stdin(Stdio::null());
        command
    }
    async fn refusal(&self, label: &str) -> String {
        case(label);
        let before = self.completion();
        let error = self.setup().await.unwrap_err();
        assert_eq!(self.completion(), before, "{label}");
        assert!(
            self.events.borrow().is_empty(),
            "{label}: {:?}",
            self.events.borrow()
        );
        assert!(
            error.message.starts_with("Python code tools ("),
            "{label}: {}",
            error.message
        );
        error.message
    }
}
fn production_probe(name: &str) -> &'static str {
    include_str!("../../src/setup_python.rs")
        .split(&format!("const {name}: &str = r#\""))
        .nth(1)
        .unwrap()
        .split("\"#;")
        .next()
        .unwrap()
}
fn spec() -> Value {
    json!(MODULES.iter().map(|(dist, module)| json!({"dist":dist,"module":module,"extensions":EXTENSIONS.iter().filter(|(name,_)| name.split('.').next() == Some(*module)).collect::<Vec<_>>()})).collect::<Vec<_>>())
}

#[tokio::test]
async fn first_install_alias_resume_and_record_before_voice_interruption() {
    let f = Home::empty();
    // Existing progress callback, before the venv uv call: base is provisioned,
    // no venv/record exists. Unwind before any following mutation can start.
    let emit = |stage: &str, _: &str| {
        if stage == "python" && f.path("python").join(ALIAS).exists() {
            std::panic::panic_any("owned before venv");
        }
    };
    case("A/N1 interrupt after managed base, before venv/record");
    let result = AssertUnwindSafe(hexbot_core::setup::windows_contract_code_tools(
        &f.home, &emit,
    ))
    .catch_unwind()
    .await;
    assert_eq!(
        result.unwrap_err().downcast_ref::<&str>(),
        Some(&"owned before venv")
    );
    assert!(!f.venv().exists() && !f.identity().exists());
    unlink_alias(&f.path("python").join(ALIAS));
    case("A/N1 missing alias resume; A record before voice");
    let emit = |stage: &str, _: &str| {
        if stage == "voice" {
            std::panic::panic_any("owned before pip");
        }
    };
    let result = AssertUnwindSafe(hexbot_core::setup::windows_contract_code_tools(
        &f.home, &emit,
    ))
    .catch_unwind()
    .await;
    let interrupted = result.unwrap_err();
    assert_eq!(
        interrupted.downcast_ref::<&str>(),
        Some(&"owned before pip")
    );
    assert!(f.identity().is_file());
    assert!(!f.receipt().exists());
    let record = fs::read(f.identity()).unwrap();
    let key = f.key();
    assert_eq!(
        f.path("python").join(ALIAS).canonicalize().unwrap(),
        f.path("python").join(&key).canonicalize().unwrap()
    );
    case("A resume packages after record publication");
    f.setup().await.unwrap();
    assert_eq!(fs::read(f.identity()).unwrap(), record);
    assert!(
        f.events
            .borrow()
            .iter()
            .all(|e| e == "voice: Installing voice tools")
    );
    f.healthy();
}

#[tokio::test]
async fn legacy_adoption_alias_cfg_forms_and_ascii_round_trips() {
    let f = Home::installed().await;
    let original = f.payloads();
    let identity = fs::read(f.identity()).unwrap();
    let key = f.key();
    for stale in [true, false] {
        case(if stale {
            "B adopt healthy identity with stale receipt"
        } else {
            "B adopt healthy identity with missing receipt"
        });
        fs::remove_file(f.identity()).unwrap();
        if stale {
            fs::write(f.receipt(), "old lock").unwrap();
        } else {
            fs::remove_file(f.receipt()).unwrap();
        }
        f.setup().await.unwrap();
        assert_eq!(fs::read(f.identity()).unwrap(), identity);
        assert_eq!(*f.events.borrow(), ["voice: Installing voice tools"]);
        f.restored(&original);
    }
    for leaf in [
        f.path(&format!("python/{key}/python.exe")),
        f.venv().join("Scripts/python.exe"),
    ] {
        case("B damaged unrecorded interpreter refuses without adoption/repair");
        fs::remove_file(f.identity()).unwrap();
        let saved = fs::read(&leaf).unwrap();
        fs::write(&leaf, b"x").unwrap();
        let receipt = fs::read(f.receipt()).unwrap();
        let error = f.setup().await.unwrap_err();
        assert!(error.message.contains("Python code tools"));
        assert!(f.events.borrow().is_empty());
        assert!(!f.identity().exists());
        assert_eq!(fs::read(f.receipt()).unwrap(), receipt);
        assert_eq!(fs::read(&leaf).unwrap(), b"x");
        fs::write(&leaf, saved).unwrap();
        fs::write(f.identity(), &identity).unwrap();
    }
    case("N2 absent minor alias exact-key reinstall");
    let alias = f.path("python").join(ALIAS);
    unlink_alias(&alias);
    fs::remove_file(f.path(&format!("python/{key}/python311.dll"))).unwrap();
    // Use the permitted exact-key cfg shape while an unused alias is absent.
    let cfg = f.venv().join("pyvenv.cfg");
    let original_cfg = fs::read_to_string(&cfg).unwrap();
    let with_home = |home: &Path| {
        original_cfg
            .lines()
            .map(|line| {
                if line.starts_with("home =") {
                    format!("home = {}", home.display())
                } else {
                    line.to_owned()
                }
            })
            .collect::<Vec<_>>()
            .join("\n")
    };
    fs::write(&cfg, with_home(&f.path("python").join(&key))).unwrap();
    f.setup().await.unwrap();
    assert_eq!(fs::read(f.identity()).unwrap(), identity);
    f.restored(&original);
    case(&format!(
        "N2 observed alias present after exact reinstall: {}",
        fs::symlink_metadata(&alias).is_ok()
    ));
    if fs::symlink_metadata(&alias).is_ok() {
        assert_eq!(
            alias.canonicalize().unwrap(),
            f.path("python").join(&key).canonicalize().unwrap(),
            "N2: uv must not repoint to another patch"
        );
    }
    // N3 uses actual OS short names, not lowercasing or prefix stripping.
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetShortPathNameW(path: *const u16, out: *mut u16, length: u32) -> u32;
    }
    let base = f.path("python").join(&key);
    let wide: Vec<u16> = base.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut short = vec![0u16; 32768];
    let count = unsafe { GetShortPathNameW(wide.as_ptr(), short.as_mut_ptr(), short.len() as u32) }
        as usize;
    assert!(
        count > 0 && count < short.len(),
        "N3 GetShortPathNameW: {}",
        io::Error::last_os_error()
    );
    let short = PathBuf::from(std::ffi::OsString::from_wide(&short[..count]));
    let long = f
        ._root
        .path()
        .join(f.home.file_name().unwrap())
        .join("python")
        .join(&key);
    assert!(
        short.to_string_lossy().contains('~'),
        "N3 filesystem supplied no actual 8.3 alias: {short:?}"
    );
    for shape in [long, short, base.canonicalize().unwrap()] {
        case("N3 actual allow-existing repair through Unicode/long/OS-short/extended home");
        fs::write(&cfg, with_home(&shape)).unwrap();
        fs::write(f.venv().join("Scripts/python.exe"), b"x").unwrap();
        let before = f.completion();
        let caller_home = shape.parent().unwrap().parent().unwrap();
        f.events.borrow_mut().clear();
        hexbot_core::setup::windows_contract_code_tools(caller_home, &|stage, message| {
            f.emit(stage, message)
        })
        .await
        .unwrap();
        assert_eq!(
            *f.events.borrow(),
            ["python: Restoring the code tools interpreter"]
        );
        assert_eq!(f.completion(), before);
        f.restored(&original);
        let observed_cfg = fs::read_to_string(&cfg).unwrap();
        let actual_home = observed_cfg
            .lines()
            .find_map(|line| line.strip_prefix("home = "))
            .unwrap();
        assert_eq!(
            Path::new(actual_home).canonicalize().unwrap(),
            base.canonicalize().unwrap()
        );
        case(&format!("N3 actual cfg after repair: {observed_cfg}"));
    }
    fs::write(&cfg, original_cfg).unwrap();
    case("N6 exact production identity and package probes emit escaped ASCII");
    let identity_result = python(&f.home, production_probe("IDENTITY_PROBE"), &[]);
    assert_eq!(
        Path::new(identity_result["prefix"].as_str().unwrap())
            .canonicalize()
            .unwrap(),
        f.venv().canonicalize().unwrap()
    );
    let source = f.site().join("edge_tts/communicate.py");
    let saved = fs::read(&source).unwrap();
    fs::write(&source, "def (:\n# \u{4e2d}\u{6587}\n").unwrap();
    let package_result = python(
        &f.home,
        production_probe("PACKAGE_PROBE"),
        &[f.site().display().to_string(), spec().to_string()],
    );
    let filename = package_result["modules"]["edge_tts"]["error"]["filename"]
        .as_str()
        .unwrap();
    assert_eq!(
        Path::new(filename).canonicalize().unwrap(),
        source.canonicalize().unwrap()
    );
    assert!(filename.contains('\u{4e2d}'));
    fs::write(&source, saved).unwrap();
    f.restored(&original);
}

fn file_tree(root: &Path) -> BTreeMap<PathBuf, (std::time::SystemTime, String)> {
    fn walk(path: &Path, out: &mut BTreeMap<PathBuf, (std::time::SystemTime, String)>) {
        let m = fs::symlink_metadata(path).unwrap();
        if m.file_attributes() & 0x400 != 0 {
            out.insert(
                path.to_owned(),
                (
                    m.modified().unwrap(),
                    format!("link:{:?}", fs::read_link(path).unwrap()),
                ),
            );
        } else if m.is_dir() {
            out.insert(path.to_owned(), (m.modified().unwrap(), "directory".into()));
            for entry in fs::read_dir(path).unwrap() {
                walk(&entry.unwrap().path(), out);
            }
        } else {
            out.insert(path.to_owned(), (m.modified().unwrap(), digest(path)));
        }
    }
    let mut out = BTreeMap::new();
    walk(root, &mut out);
    out
}
fn remove_bytecode(root: &Path) {
    for entry in fs::read_dir(root).unwrap() {
        let path = entry.unwrap().path();
        let m = fs::symlink_metadata(&path).unwrap();
        if m.file_attributes() & 0x400 != 0 {
            continue;
        }
        if m.is_dir() {
            if path.file_name().unwrap() == "__pycache__" {
                fs::remove_dir_all(path).unwrap();
            } else {
                remove_bytecode(&path);
            }
        } else if path.extension().is_some_and(|e| e == "pyc") {
            fs::remove_file(path).unwrap();
        }
    }
}
#[tokio::test]
async fn finite_healthy_checks_and_owned_path_refusals() {
    let f = Home::installed().await;
    let original = f.payloads();
    case("D bytecode absent, healthy traversal remains finite across base/site/cache");
    remove_bytecode(&f.path("python"));
    remove_bytecode(&f.venv());
    let outside = tempfile::tempdir().unwrap();
    fs::write(outside.path().join("sentinel"), b"outside unchanged").unwrap();
    let roots = [
        f.path("python").join(f.key()),
        f.site(),
        f.path("runtime/uv-cache"),
    ];
    for root in &roots {
        junction(&root.join("unrelated-directory-junction"), outside.path());
    }
    let before = [file_tree(&f.path("python")), file_tree(&f.venv())];
    let completion = f.completion();
    f.setup().await.unwrap();
    assert!(f.events.borrow().is_empty());
    f.healthy();
    assert_eq!([file_tree(&f.path("python")), file_tree(&f.venv())], before);
    assert_eq!(f.completion(), completion);
    assert!(
        before
            .iter()
            .flat_map(|tree| tree.keys())
            .all(|p| p.extension().is_none_or(|e| e != "pyc"))
    );
    case("N5 filled operation roots reject those junctions before uv mutation");
    let entry = f.venv().join("Scripts/edge-tts.exe");
    let entry_bytes = fs::read(&entry).unwrap();
    for root in &roots {
        fs::remove_dir(root.join("unrelated-directory-junction")).unwrap();
    }
    for root in &roots {
        junction(&root.join("unrelated-directory-junction"), outside.path());
        fs::remove_file(&entry).unwrap();
        f.refusal(&format!("E/N5 populated mutation-only walk: {root:?}"))
            .await;
        fs::remove_dir(root.join("unrelated-directory-junction")).unwrap();
        fs::write(&entry, &entry_bytes).unwrap();
    }
    assert_eq!(
        fs::read(outside.path().join("sentinel")).unwrap(),
        b"outside unchanged"
    );
    case("E alias drift and escape refuse without selecting another base");
    let alias = f.path("python").join(ALIAS);
    let base = f.path("python").join(f.key());
    let wrong = f.path("python/cpython-3.11.0-windows-x86_64-none");
    fs::create_dir(&wrong).unwrap();
    for target in [outside.path(), wrong.as_path()] {
        unlink_alias(&alias);
        junction(&alias, target);
        f.refusal("E alias escape/drift").await;
        unlink_alias(&alias);
        junction(&alias, &base);
    }
    fs::remove_dir(wrong).unwrap();

    // Existing fixed shared leaves must refuse without changing their other link.
    for leaf in [
        f.venv().join("Scripts/python.exe"),
        f.venv().join("Scripts/edge-tts.exe"),
        f.venv().join("pyvenv.cfg"),
        f.path(&format!("python/{}/python.exe", f.key())),
        f.path(&format!("python/{}/python311.dll", f.key())),
        f.path("runtime/activate.lock"),
        f.path("logs/bootstrap.log"),
    ] {
        let witness = outside.path().join("shared-leaf");
        fs::hard_link(&leaf, &witness).unwrap();
        let bytes = fs::read(&witness).unwrap();
        f.refusal(&format!(
            "E hard-linked fixed leaf {}",
            leaf.file_name().unwrap().to_string_lossy()
        ))
        .await;
        assert_eq!(fs::read(&witness).unwrap(), bytes);
        fs::remove_file(witness).unwrap();
    }
    for leaf in [
        f.path("bin/uv.exe"),
        f.venv().join("Scripts/python.exe"),
        f.venv().join("pyvenv.cfg"),
        f.site().join(EXTENSIONS[4].1),
        f.path("logs/bootstrap.log"),
    ] {
        let parked = outside.path().join("reparse-leaf-target");
        fs::rename(&leaf, &parked).unwrap();
        let bytes = fs::read(&parked).unwrap();
        std::os::windows::fs::symlink_file(&parked, &leaf)
            .unwrap_or_else(|error| panic!("E file-reparse fixture unavailable: {error}"));
        f.refusal("E reparse fixed file/native leaf refuses before execution/write-through")
            .await;
        assert_eq!(fs::read(&parked).unwrap(), bytes);
        fs::remove_file(&leaf).unwrap();
        fs::rename(parked, leaf).unwrap();
    }
    for leaf in [
        f.venv().join("Scripts/python.exe"),
        f.site().join(EXTENSIONS[4].1),
        f.receipt(),
    ] {
        let completion = f.completion();
        let held = fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&leaf)
            .unwrap();
        // Snapshot before locking a completion leaf, since a read must itself fail.
        let error = f.setup().await.unwrap_err();
        assert!(error.message.contains("os error 32"), "{}", error.message);
        assert!(f.events.borrow().is_empty());
        drop(held);
        assert_eq!(f.completion(), completion);
        f.restored(&original);
    }
    let requirements = f.venv().join("requirements.txt");
    let permissions = fs::metadata(&requirements).unwrap().permissions();
    let mut readonly = permissions.clone();
    readonly.set_readonly(true);
    fs::set_permissions(&requirements, readonly).unwrap();
    fs::remove_file(&entry).unwrap();
    f.refusal("E read-only atomic requirements refuse before pip")
        .await;
    fs::set_permissions(&requirements, permissions).unwrap();
    fs::write(&entry, &entry_bytes).unwrap();

    // A fixed package leaf redirected outside must never execute its payload.
    let init = f.site().join("edge_tts/__init__.py");
    let saved_init = fs::read(&init).unwrap();
    let redirected = outside.path().join("foreign.py");
    fs::write(
        &redirected,
        format!(
            "from pathlib import Path\nPath({:?}).write_text('executed')\n",
            outside.path().join("executed").display().to_string()
        ),
    )
    .unwrap();
    fs::remove_file(&init).unwrap();
    // Junctions need no developer-mode symlink privilege; the package itself is
    // moved aside and its directory replaced with an owned outside junction.
    fs::write(&init, &saved_init).unwrap();
    let package = f.site().join("edge_tts");
    let parked = f.site().join("edge_tts-parked");
    fs::rename(&package, &parked).unwrap();
    let foreign_package = outside.path().join("foreign-package");
    fs::create_dir(&foreign_package).unwrap();
    fs::copy(&redirected, foreign_package.join("__init__.py")).unwrap();
    junction(&package, &foreign_package);
    f.refusal("E foreign package junction refuses before outside execution")
        .await;
    assert!(!outside.path().join("executed").exists());
    fs::remove_dir(&package).unwrap();
    fs::rename(parked, package).unwrap();
    for payload in [
        b"import os\nos._exit(77)\n".as_slice(),
        b"print('owned unexpected stdout')\n",
        b"raise AttributeError('owned unknown exception')\n",
    ] {
        fs::write(&init, [payload, saved_init.as_slice()].concat()).unwrap();
        f.refusal("E current-receipt crash/malformed/unknown pre-probe refuses")
            .await;
        fs::write(&init, &saved_init).unwrap();
    }
    // Atomic destinations may be shared only if the witness remains unchanged
    // (or publication safely refuses); they are not append/launcher leaves.
    for destination in [&requirements, &f.receipt(), &f.identity()] {
        case("E hard-linked atomic destination preserves witness bytes");
        let witness = outside.path().join("atomic-witness");
        fs::hard_link(destination, &witness).unwrap();
        let bytes = fs::read(&witness).unwrap();
        let before = f.completion();
        if destination == &f.receipt() {
            fs::write(destination, "old lock").unwrap();
        }
        let expected_witness = fs::read(&witness).unwrap();
        if destination == &requirements {
            fs::remove_file(&entry).unwrap();
        }
        let result = f.setup().await;
        assert_eq!(fs::read(&witness).unwrap(), expected_witness);
        if let Err(error) = &result {
            assert!(
                error.message.contains("replace") || error.message.contains("os error"),
                "{}",
                error.message
            );
        }
        fs::remove_file(witness).unwrap();
        if result.is_err() {
            fs::write(destination, &bytes).unwrap();
            fs::write(&entry, &entry_bytes).unwrap();
        }
        if destination == &f.identity() {
            assert_eq!(f.completion(), before);
        }
        f.restored(&original);
    }
    // Direct Python boundary phase: no outside child or lock created, even
    // though the chosen home itself already exists.
    let fresh = Home::empty();
    junction(&fresh.path("runtime"), outside.path());
    let error = fresh.setup().await.unwrap_err();
    assert!(error.message.contains("preflight"));
    assert!(fresh.events.borrow().is_empty());
    assert!(!outside.path().join("activate.lock").exists());
    assert!(!outside.path().join("uv-cache").exists());
    fs::remove_dir(fresh.path("runtime")).unwrap();
}

#[tokio::test]
async fn interrupted_pip_missing_record_and_unpacked_cache_integrity() {
    let f = Home::installed().await;
    let original = f.payloads();
    let identity = fs::read(f.identity()).unwrap();
    case("N4 process-start pip interruption, not a partial-write-window claim");
    fs::remove_file(f.receipt()).unwrap();
    let mut command = f.uv();
    command
        .args(["--no-config", "pip", "install", "--python"])
        .arg(f.venv().join("Scripts/python.exe"))
        .args([
            "--reinstall",
            "--require-hashes",
            "--no-deps",
            "--no-build",
            "-r",
        ])
        .arg(f.venv().join("requirements.txt"))
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let mut child = command.spawn().unwrap();
    let owned_pid = child.id();
    assert!(owned_pid > 0);
    assert!(
        child.try_wait().unwrap().is_none(),
        "N4 uv completed before interruption; no retry"
    );
    child.kill().unwrap();
    let status = child.wait().unwrap();
    assert!(!status.success(), "N4 child was not interrupted");
    // --no-build admits no build subprocess; this owned uv mutation process has
    // exited and is joined before setup can acquire the fixture's lock again.
    assert!(!f.receipt().exists());
    assert_eq!(fs::read(f.identity()).unwrap(), identity);
    f.setup().await.unwrap();
    assert_eq!(*f.events.borrow(), ["voice: Installing voice tools"]);
    f.restored(&original);
    case("N4 deterministic incomplete dist-info without RECORD");
    let record = f.site().join("edge_tts-7.2.7.dist-info/RECORD");
    assert!(record.is_file());
    fs::remove_file(record).unwrap();
    let source = f.site().join("edge_tts/communicate.py");
    fs::write(&source, b"raise RuntimeError('owned partial install')\n").unwrap();
    fs::remove_file(f.receipt()).unwrap();
    let result = f.setup().await;
    assert_eq!(fs::read(f.identity()).unwrap(), identity);
    if let Err(error) = result {
        assert!(!f.receipt().exists());
        panic!(
            "N4 missing-RECORD recovery safely refused, concrete native limitation: {}",
            error.message
        );
    }
    assert_eq!(*f.events.borrow(), ["voice: Installing voice tools"]);
    f.restored(&original);
    case("F/N5 actual populated cache, ordinary unpacked member tamper");
    let cache = f.path("runtime/uv-cache");
    let source_hash = digest(&source);
    let mut cached = Vec::new();
    fn find(dir: &Path, hash: &str, found: &mut Vec<PathBuf>) {
        for entry in fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            let m = fs::symlink_metadata(&path).unwrap();
            assert_eq!(
                m.file_attributes() & 0x400,
                0,
                "N5 unexpected populated-cache reparse: {path:?}"
            );
            if m.is_dir() {
                find(&path, hash, found);
            } else if path.file_name().unwrap() == "communicate.py" && digest(&path) == hash {
                found.push(path);
            }
        }
    }
    find(&cache, &source_hash, &mut cached);
    assert!(
        !cached.is_empty(),
        "F: no ordinary unpacked source member found; native cache shape needs review"
    );
    for path in &cached {
        let mut bytes = fs::read(path).unwrap();
        bytes.extend_from_slice(b"\n# owned cache-integrity tamper, imports remain healthy\n");
        fs::write(path, bytes).unwrap();
        assert_ne!(digest(path), source_hash);
    }
    assert_eq!(
        digest(&source),
        source_hash,
        "cache mutation must not write through to installed bytes"
    );
    let completion = f.completion();
    // An independently missing launcher reaches pip even while strict
    // entrypoint aggregation leaves module-only repair unresolved. Keep the
    // installed source healthy until uv actually tries to replace it.
    fs::remove_file(f.venv().join("Scripts/edge-tts.exe")).unwrap();
    match f.setup().await {
        Ok(()) => {
            f.restored(&original);
            assert_eq!(
                digest(&source),
                source_hash,
                "UNSAFE cache reuse: altered unpacked payload passed final health"
            );
        }
        Err(error) => {
            assert_eq!(f.completion(), completion);
            assert!(error.message.contains("Python code tools"));
            let events = f.events.borrow();
            assert_eq!(events.len(), 1);
            assert!(events[0].starts_with("voice: Repairing voice tools:"));
            case("F observed explicit safe failure; no completion publication");
        }
    }
    assert_eq!(f.completion(), completion);
    assert_eq!(fs::read(f.identity()).unwrap(), identity);
}

#[repr(C)]
#[derive(Default, Debug, PartialEq, Eq)]
struct FileInfo {
    attributes: u32,
    times: [u32; 6],
    volume: u32,
    high: u32,
    low: u32,
    links: u32,
    index_high: u32,
    index_low: u32,
}
fn file_info(path: &Path) -> FileInfo {
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetFileInformationByHandle(handle: *mut std::ffi::c_void, info: *mut FileInfo) -> i32;
    }
    let file = fs::File::open(path).unwrap();
    let mut info = FileInfo::default();
    assert_ne!(
        unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) },
        0
    );
    info
}
#[tokio::test]
async fn diagnostic_uv_observes_launcher_and_cfg_leaf_write_through() {
    // A separate fresh fixture. This diagnostic never supplies a repaired
    // environment to another acceptance control and is not production repair.
    let f = Home::installed().await;
    let before_completion = f.completion();
    let witness = f.path("diagnostic-witnesses");
    fs::create_dir(&witness).unwrap();
    let leaves = [
        f.venv().join("Scripts/python.exe"),
        f.venv().join("pyvenv.cfg"),
    ];
    for leaf in &leaves {
        fs::hard_link(leaf, witness.join(leaf.file_name().unwrap())).unwrap();
    }
    f.refusal("F production refuses shared launcher/cfg before diagnostic uv")
        .await;
    fs::write(&leaves[0], b"ordinary truncated redirector").unwrap();
    let before: Vec<_> = leaves
        .iter()
        .map(|p| (file_info(p), digest(&witness.join(p.file_name().unwrap()))))
        .collect();
    case("F diagnostic exact uv venv command observes owned leaf replacement/write-through");
    let output = f
        .uv()
        .args([
            "--no-config",
            "venv",
            "--allow-existing",
            "--no-project",
            "--managed-python",
            "--python",
        ])
        .arg(f.path("python").join(f.key()).join("python.exe"))
        .arg(f.venv())
        .output()
        .unwrap();
    for (index, leaf) in leaves.iter().enumerate() {
        let after = file_info(leaf);
        let witness_hash = digest(&witness.join(leaf.file_name().unwrap()));
        case(&format!(
            "F observed {}: status {:?}, ID before ({},{},{}), after ({},{},{}), witness_changed={}",
            leaf.file_name().unwrap().to_string_lossy(),
            output.status.code(),
            before[index].0.volume,
            before[index].0.index_high,
            before[index].0.index_low,
            after.volume,
            after.index_high,
            after.index_low,
            witness_hash != before[index].1
        ));
    }
    assert_eq!(f.completion(), before_completion);
    assert!(
        output.status.success(),
        "F diagnostic command refused; concrete behavior needs review: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    // No production recovery is inferred from this diagnostic. Observe only.
}

#[tokio::test]
async fn required_module_only_repairs_remain_explicit_acceptance_gates() {
    let f = Home::installed().await;
    let original = f.payloads();
    let source = f.site().join("edge_tts/communicate.py");
    // Required positives use the actual launcher observer and production
    // repair. A native failure remains an acceptance failure, never a skip.
    for damage in ["missing", "syntax", "combined", "dependency"] {
        case(&format!("required module-only positive gate: {damage}"));
        if damage == "dependency" {
            fs::write(f.site().join("frozenlist/__init__.py"), b"def (:\n").unwrap();
        } else if damage == "syntax" {
            fs::write(&source, b"def (:\n").unwrap();
        } else {
            fs::remove_file(&source).unwrap();
        }
        if damage == "combined" {
            fs::write(f.venv().join("Scripts/python.exe"), b"x").unwrap();
        }
        f.setup().await.unwrap();
        f.restored(&original);
    }
}
#[tokio::test]
async fn required_existing_dll_refusal_dominates_missing_base_executable_gate() {
    let f = Home::installed().await;
    let key = f.key();
    let completion = f.completion();
    let exe = f.path(&format!("python/{key}/python.exe"));
    let dll = f.path(&format!("python/{key}/python311.dll"));
    let exe_bytes = fs::read(&exe).unwrap();
    let image = fs::read(&dll).unwrap();
    let u16_at = |offset| u16::from_le_bytes(image[offset..offset + 2].try_into().unwrap());
    let u32_at =
        |offset| u32::from_le_bytes(image[offset..offset + 4].try_into().unwrap()) as usize;
    let pe = u32_at(0x3c);
    assert_eq!(&image[pe..pe + 4], b"PE\0\0");
    let sections = pe + 24 + usize::from(u16_at(pe + 20));
    let cut = image.len() / 2;
    assert!(
        (0..usize::from(u16_at(pe + 6))).any(|index| {
            let at = sections + index * 40;
            let size = u32_at(at + 16);
            let start = u32_at(at + 20);
            start < cut && cut < start + size
        }),
        "DLL cut must enter section raw data"
    );
    for short_exe in [false, true] {
        for bytes in [b"truncated".as_slice(), &image[..cut]] {
            if short_exe {
                fs::write(&exe, b"x").unwrap();
            } else {
                fs::remove_file(&exe).unwrap();
            }
            fs::write(&dll, bytes).unwrap();
            case("schema2 required combined existing-DLL refusal, missing/SHORT EXE");
            f.refusal("DLL mismatch dominates base EXE repair").await;
            assert_eq!(fs::read(&dll).unwrap(), bytes);
            assert_eq!(f.completion(), completion);
            fs::write(&exe, &exe_bytes).unwrap();
            fs::write(&dll, &image).unwrap();
        }
    }
}

#[tokio::test]
async fn actual_launcher_observer_refuses_unknown_diagnostics_alternate_and_access() {
    let f = Home::installed().await;
    let original = f.payloads();
    let init = f.site().join("edge_tts/__init__.py");
    let init_bytes = fs::read(&init).unwrap();
    let source = f.site().join("edge_tts/communicate.py");
    let source_bytes = fs::read(&source).unwrap();
    case("observer healthy-package ordinary version plus stderr refuses, no observer fallback");
    fs::write(
        &init,
        [
            b"import sys\nsys.stderr.write('owned ordinary launcher diagnostics\\n')\n".as_slice(),
            &init_bytes,
        ]
        .concat(),
    )
    .unwrap();
    let error = f.refusal("ordinary healthy stderr").await;
    assert!(
        error.contains("owned ordinary launcher diagnostics"),
        "{error}"
    );
    fs::write(&init, &init_bytes).unwrap();
    for candidate in [false, true] {
        case("observer expected version OR tagged error with late atexit stderr refuses");
        fs::write(&init,[b"import atexit\ndef owned_late_failure():\n raise RuntimeError('owned late teardown cause')\natexit.register(owned_late_failure)\n".as_slice(),&init_bytes].concat()).unwrap();
        if candidate {
            fs::write(&source, b"def (:\n").unwrap();
        }
        // Healthy packages exercise the ordinary health rule; syntax damage
        // exercises tagged observer JSON plus genuine finalization diagnostics.
        let error = f.refusal("actual late teardown diagnostics").await;
        assert!(error.contains("owned late teardown cause"), "{error}");
        if candidate {
            assert!(error.contains("SyntaxError"), "{error}");
        }
        fs::write(&source, &source_bytes).unwrap();
        fs::write(&init, &init_bytes).unwrap();
    }
    for (label, injection, expected) in [
        (
            "observer extra stdout",
            "import sys\nif sys.argv[0].lower().endswith('edge-tts.exe'):\n print('owned unexpected stdout')\n",
            "incomplete result",
        ),
        (
            "observer final flush",
            "import sys\nif sys.argv[0].lower().endswith('edge-tts.exe'):\n class OwnedOutput:\n  def __init__(self): self.calls=0; self.original=sys.stdout\n  def write(self,text): return self.original.write(text)\n  def flush(self):\n   self.calls+=1\n   if self.calls>1: raise OSError('owned final flush cause')\n   return self.original.flush()\n sys.stdout=OwnedOutput()\n",
            "status Some(120)",
        ),
        (
            "observer output bound",
            "import sys\nif sys.argv[0].lower().endswith('edge-tts.exe'):\n sys.stdout.write('x'*(1024*1024+1)); sys.stdout.flush()\n",
            "exceeded",
        ),
    ] {
        fs::write(&init, [injection.as_bytes(), &init_bytes].concat()).unwrap();
        fs::write(&source, b"def (:\n").unwrap();
        let error = f.refusal(label).await;
        assert!(error.contains(expected), "{label}: {error}");
        fs::write(&source, &source_bytes).unwrap();
        fs::write(&init, &init_bytes).unwrap();
    }
    case("observer exclusive version stdout with diagnostics on a repairable graph");
    let metadata = fs::read_dir(f.site())
        .unwrap()
        .map(|e| e.unwrap().path())
        .find(|p| {
            p.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("idna-")
                && p.extension().is_some_and(|e| e == "dist-info")
        })
        .unwrap()
        .join("METADATA");
    let metadata_bytes = fs::read(&metadata).unwrap();
    let metadata_text = String::from_utf8(metadata_bytes.clone()).unwrap();
    let altered = metadata_text
        .lines()
        .map(|line| {
            if line.starts_with("Version: ") {
                "Version: 0"
            } else {
                line
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    fs::write(&metadata, altered).unwrap();
    fs::write(&init,[b"import sys\nif sys.argv[0].lower().endswith('edge-tts.exe'):\n sys.stderr.write('owned observer version diagnostics\\n')\n".as_slice(),&init_bytes].concat()).unwrap();
    let error = f.refusal("observer version and stderr").await;
    assert!(
        error.contains("owned observer version diagnostics"),
        "{error}"
    );
    fs::write(&init,[b"import sys\nif sys.argv[0].lower().endswith('edge-tts.exe'):\n raise AttributeError('owned independent launcher failure')\n".as_slice(),&init_bytes].concat()).unwrap();
    let error = f.refusal("observer unmatched actual AttributeError").await;
    assert!(error.contains("AttributeError"), "{error}");
    fs::write(&init, &init_bytes).unwrap();
    let entry = f.venv().join("Scripts/edge-tts.exe");
    let entry_bytes = fs::read(&entry).unwrap();
    fs::write(&entry, [b'g'; 64]).unwrap();
    let error = f.refusal("observer unknown native OS193").await;
    assert!(error.contains("os error 193"), "{error}");
    fs::write(&entry, &entry_bytes).unwrap();
    // Execute permission denial leaves read/hash checks available. Only this
    // owned fixture leaf's deny ACE is changed and removed after the refusal.
    let user = std::env::var("USERNAME").unwrap();
    let icacls = super::windows_paths::system_program("icacls.exe").unwrap();
    let denied = Command::new(&icacls)
        .arg(&entry)
        .args(["/deny", &format!("{user}:(X)")])
        .output()
        .unwrap();
    assert!(denied.status.success());
    let completion = f.completion();
    let result = f.setup().await;
    let restored = Command::new(&icacls)
        .arg(&entry)
        .args(["/remove:d", &user])
        .output()
        .unwrap();
    assert!(restored.status.success());
    assert_eq!(f.completion(), completion);
    let error = result.unwrap_err();
    assert!(error.message.contains("os error 5"), "{}", error.message);
    assert!(f.events.borrow().is_empty());
    fs::write(&metadata, &metadata_bytes).unwrap();
    let alternate = f.site().join("sitecustomize.py");
    fs::write(
        &alternate,
        b"# owned alternate must be discovered, never masked\n",
    )
    .unwrap();
    fs::write(&source, b"def (:\n").unwrap();
    let error = f.refusal("observer planted alternate sitecustomize").await;
    assert!(error.contains("alternate sitecustomize"), "{error}");
    fs::remove_file(alternate).unwrap();
    fs::write(&source, &source_bytes).unwrap();
    f.restored(&original);
    // Failed CreateProcess calls conservatively retain their invocation scratch:
    // the Runner returned no confirmed-reap result. No leftover is reused.
    let retained: Vec<_> = fs::read_dir(f.path("runtime"))
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| {
            p.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with(".hexbot-entrypoint-")
        })
        .collect();
    for path in &retained {
        assert_eq!(fs::read_dir(path).unwrap().count(), 1);
        assert!(path.join("sitecustomize.py").is_file());
    }
    let completion = f.completion();
    f.setup().await.unwrap();
    assert_eq!(f.completion(), completion);
    assert!(f.events.borrow().is_empty());
    for path in &retained {
        assert!(path.join("sitecustomize.py").is_file());
    }
}

#[tokio::test]
async fn schema2_loaded_dll_migration_and_changed_bytes_are_explicit_native_gates() {
    let f = Home::installed().await;
    let key = f.key();
    let original = f.payloads();
    let identity = fs::read(f.identity()).unwrap();
    let base = f.path("python").join(&key);
    let exe = base.join("python.exe");
    let dll = base.join("python311.dll");
    let exe_bytes = fs::read(&exe).unwrap();
    let dll_bytes = fs::read(&dll).unwrap();
    case("schema2 actual loaded DLL and exact digest, SHORT base EXE restoration");
    let record = f.record();
    assert_eq!(record["schema"], 2);
    assert_eq!(record["base_dll_sha256"], digest(&dll));
    fs::write(&exe, b"x").unwrap();
    f.setup().await.unwrap();
    f.restored(&original);
    assert_eq!(fs::read(f.identity()).unwrap(), identity);
    case("schema1 healthy one-time enrichment before voice, no repeat record write");
    let legacy = json!({"schema":1,"home":f.home,"base_key":key}).to_string();
    fs::write(f.identity(), &legacy).unwrap();
    f.setup().await.unwrap();
    assert!(f.events.borrow().is_empty());
    assert_eq!(fs::read(f.identity()).unwrap(), identity);
    f.healthy();
    let completion = f.completion();
    f.setup().await.unwrap();
    assert_eq!(f.completion(), completion);
    for short in [false, true] {
        case("schema1 damaged EXE with present DLL refuses without retroactive blessing");
        fs::write(f.identity(), &legacy).unwrap();
        if short {
            fs::write(&exe, b"x").unwrap();
        } else {
            fs::remove_file(&exe).unwrap();
        }
        let error = f.refusal("schema1 no historical DLL evidence").await;
        assert!(error.contains("schema 1"), "{error}");
        fs::write(&exe, &exe_bytes).unwrap();
        fs::write(f.identity(), &identity).unwrap();
    }
    case("schema1 missing DLL exact-key repair then observed enrichment");
    fs::write(f.identity(), &legacy).unwrap();
    fs::remove_file(&dll).unwrap();
    f.setup().await.unwrap();
    assert_eq!(fs::read(f.identity()).unwrap(), identity);
    f.restored(&original);
    case("schema2 future-pin compatibility guard: changed existing same-key bytes refuse");
    let mut changed = dll_bytes.clone();
    changed.extend_from_slice(b"owned prospective payload difference");
    fs::write(&dll, &changed).unwrap();
    let error = f.refusal("changed fixed DLL cannot rebaseline").await;
    assert!(error.contains("previously observed"), "{error}");
    assert_eq!(fs::read(&dll).unwrap(), changed);
    fs::write(&dll, &dll_bytes).unwrap();
    f.restored(&original);
    // Actual future-pin mutation is not simulated by invoking a different uv.
    // Portable Runner controls supply different bytes after the production uv
    // boundary and assert post-mutation refusal plus no automatic rebaseline.
}
