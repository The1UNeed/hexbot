//! Owned Windows Python for code tools: identity, read-only probes, one
//! bounded repair per layer.
//!
//! The daemon owns `<home>/python/<exact key>`, the fixed venv
//! `runtime/tools/code-python` and the packages the voice lock names. A small
//! record beside the venv binds the home to one exact CPython key. Every
//! decision rests on fixed paths and complete ASCII JSON from `-I -B` probes;
//! anything unexpected refuses and leaves the previous files alone. Process
//! execution sits behind `Runner` so the same pass runs in portable tests.
use crate::{Error, Result, common};
use serde::Deserialize;
use serde_json::json;
use std::{
    collections::BTreeMap,
    ffi::{OsStr, OsString},
    fs, io,
    path::{Path, PathBuf},
};

const CODE: i64 = 5243;
pub(super) const MINOR_ALIAS: &str = "cpython-3.11-windows-x86_64-none";
const KEY_PREFIX: &str = "cpython-3.11.";
const KEY_SUFFIX: &str = "-windows-x86_64-none";
const SHORT_LIMIT: u64 = 64;
const IDENTITY_LIMIT: u64 = 16 * 1024;
const OUTPUT_LIMIT: usize = 1024 * 1024;
#[cfg(windows)]
const REPARSE_ATTRIBUTE: u32 = 0x400;

/// Locked distributions, their import name and audited native extensions.
/// The extension paths are the exact wheel members under `Lib/site-packages`.
struct Locked {
    dist: &'static str,
    module: &'static str,
    extensions: &'static [(&'static str, &'static str)],
}
const LOCKED: &[Locked] = &[
    Locked {
        dist: "aiohappyeyeballs",
        module: "aiohappyeyeballs",
        extensions: &[],
    },
    Locked {
        dist: "aiohttp",
        module: "aiohttp",
        extensions: &[
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
        ],
    },
    Locked {
        dist: "aiosignal",
        module: "aiosignal",
        extensions: &[],
    },
    Locked {
        dist: "attrs",
        module: "attrs",
        extensions: &[],
    },
    Locked {
        dist: "certifi",
        module: "certifi",
        extensions: &[],
    },
    Locked {
        dist: "edge-tts",
        module: "edge_tts",
        extensions: &[],
    },
    Locked {
        dist: "frozenlist",
        module: "frozenlist",
        extensions: &[(
            "frozenlist._frozenlist",
            "frozenlist/_frozenlist.cp311-win_amd64.pyd",
        )],
    },
    Locked {
        dist: "idna",
        module: "idna",
        extensions: &[],
    },
    Locked {
        dist: "multidict",
        module: "multidict",
        extensions: &[(
            "multidict._multidict",
            "multidict/_multidict.cp311-win_amd64.pyd",
        )],
    },
    Locked {
        dist: "propcache",
        module: "propcache",
        extensions: &[(
            "propcache._helpers_c",
            "propcache/_helpers_c.cp311-win_amd64.pyd",
        )],
    },
    Locked {
        dist: "tabulate",
        module: "tabulate",
        extensions: &[],
    },
    Locked {
        dist: "typing-extensions",
        module: "typing_extensions",
        extensions: &[],
    },
    Locked {
        dist: "yarl",
        module: "yarl",
        extensions: &[("yarl._quoting_c", "yarl/_quoting_c.cp311-win_amd64.pyd")],
    },
];

/// Reports interpreter identity and the small required stdlib set: json,
/// _ssl, _socket, select, asyncio and zlib.
const IDENTITY_PROBE: &str = r#"import json, platform, sys
result = {"implementation": platform.python_implementation(), "version": platform.python_version(), "executable": sys.executable, "prefix": sys.prefix, "base_prefix": sys.base_prefix, "failures": {}}
for name in ("json", "_ssl", "_socket", "select", "asyncio", "zlib"):
    try:
        __import__(name)
    except BaseException as error:
        result["failures"][name] = type(error).__name__
sys.stdout.write(json.dumps(result, ensure_ascii=True) + "\n")
"#;
/// argv: site-packages, JSON spec. Pre-opens each expected .pyd read-only
/// before any import of its distribution, then records complete per-check
/// results. `exact_import_error` is `type(e) is ImportError`, never a name.
const PACKAGE_PROBE: &str = r#"import importlib, importlib.metadata, json, os, stat, sys
site, spec = sys.argv[1], json.loads(sys.argv[2])
def failure(error):
    return {"type": type(error).__name__, "exact_import_error": type(error) is ImportError, "name": getattr(error, "name", None), "path": getattr(error, "path", None), "filename": getattr(error, "filename", None), "errno": getattr(error, "errno", None), "winerror": getattr(error, "winerror", None)}
def imported(name):
    try:
        module = importlib.import_module(name)
        found = getattr(module, "__spec__", None)
        return {"status": "ok", "origin": getattr(found, "origin", None), "loader": type(getattr(found, "loader", None)).__name__, "error": None}
    except BaseException as error:
        return {"status": "error", "origin": None, "loader": None, "error": failure(error)}
def preopen(path):
    result = {"status": "error", "size": None, "regular": None, "reparse": None, "error": None}
    try:
        try:
            parent = os.lstat(os.path.dirname(path))
        except FileNotFoundError:
            result["status"] = "parent_missing"
            return result
        if not stat.S_ISDIR(parent.st_mode):
            result["status"] = "parent_not_directory"
            return result
        try:
            leaf = os.lstat(path)
        except FileNotFoundError:
            result["status"] = "missing"
            return result
        result["regular"] = stat.S_ISREG(leaf.st_mode)
        result["reparse"] = bool(getattr(leaf, "st_file_attributes", 0) & 0x400)
        result["size"] = leaf.st_size
        if not result["regular"] or result["reparse"]:
            result["status"] = "not_ordinary"
            return result
        with open(path, "rb") as handle:
            handle.read(1)
        result["status"] = "ok"
    except BaseException as error:
        result["error"] = failure(error)
    return result
out = {"distributions": {}, "modules": {}, "extensions": {}}
# A top-level package can import another distribution's extension. Open every
# expected native member before importing any of the locked packages.
opened = {name: preopen(os.path.join(site, relative)) for item in spec for name, relative in item["extensions"]}
for item in spec:
    try:
        out["distributions"][item["dist"]] = {"version": importlib.metadata.version(item["dist"]), "error": None}
    except BaseException as error:
        out["distributions"][item["dist"]] = {"version": None, "error": failure(error)}
    out["modules"][item["module"]] = imported(item["module"])
    for name, relative in item["extensions"]:
        out["extensions"][name] = {"preopen": opened[name], "import": imported(name)}
sys.stdout.write(json.dumps(out, ensure_ascii=True) + "\n")
"#;

fn refuse(stage: &str, cause: impl std::fmt::Display) -> Error {
    Error::new(
        CODE,
        format!(
            "Python code tools ({stage}): {cause}. Any requested runtime activation already completed; details are in logs/bootstrap.log"
        ),
    )
}
fn io_stage(stage: &str, what: impl std::fmt::Display) -> impl FnOnce(io::Error) -> Error {
    let stage = stage.to_string();
    move |error| refuse(&stage, format!("{what}: {error}"))
}

/// Every fixed path this boundary reads or writes.
pub(super) struct Layout {
    pub home: PathBuf,
    pub bin: PathBuf,
    pub runtime: PathBuf,
    pub lock: PathBuf,
    pub logs: PathBuf,
    pub log: PathBuf,
    pub cache: PathBuf,
    pub python_root: PathBuf,
    pub alias: PathBuf,
    pub tools: PathBuf,
    pub venv: PathBuf,
    pub scripts: PathBuf,
    pub venv_python: PathBuf,
    pub venv_cfg: PathBuf,
    pub entrypoint: PathBuf,
    pub requirements: PathBuf,
    pub identity: PathBuf,
    pub receipt: PathBuf,
}
impl Layout {
    pub(super) fn new(home: &Path) -> Self {
        let runtime = home.join("runtime");
        let tools = runtime.join("tools");
        let venv = tools.join("code-python");
        let scripts = venv.join("Scripts");
        Self {
            home: home.to_owned(),
            bin: home.join("bin"),
            lock: runtime.join("activate.lock"),
            logs: home.join("logs"),
            log: home.join("logs/bootstrap.log"),
            cache: runtime.join("uv-cache"),
            python_root: home.join("python"),
            alias: home.join("python").join(MINOR_ALIAS),
            venv_python: scripts.join("python.exe"),
            venv_cfg: venv.join("pyvenv.cfg"),
            entrypoint: scripts.join("edge-tts.exe"),
            requirements: venv.join("requirements.txt"),
            identity: tools.join("code-python-identity.json"),
            receipt: tools.join("edge-tts.requirements.txt"),
            runtime,
            tools,
            venv,
            scripts,
        }
    }
    pub(super) fn base(&self, key: &str) -> PathBuf {
        self.python_root.join(key)
    }
    fn site_packages(&self) -> PathBuf {
        self.venv.join("Lib/site-packages")
    }
}

// Identity record: exactly schema, home and base_key.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawIdentity {
    schema: u64,
    home: String,
    base_key: String,
}
#[derive(Debug, PartialEq, Eq)]
pub(super) struct Identity {
    pub home: PathBuf,
    pub base_key: String,
}
/// `cpython-3.11.<patch>-windows-x86_64-none` with a plain decimal patch.
pub(super) fn key_patch(key: &str) -> Option<u32> {
    let patch = key.strip_prefix(KEY_PREFIX)?.strip_suffix(KEY_SUFFIX)?;
    let plain = patch == "0" || (!patch.starts_with('0') && !patch.is_empty());
    (plain && patch.bytes().all(|b| b.is_ascii_digit()))
        .then(|| patch.parse().ok())
        .flatten()
}
pub(super) fn parse_identity(bytes: &[u8]) -> std::result::Result<Identity, String> {
    if bytes.len() as u64 > IDENTITY_LIMIT {
        return Err("record is larger than 16 KiB".into());
    }
    let raw: RawIdentity = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
    if raw.schema != 1 {
        return Err(format!("unsupported schema {}", raw.schema));
    }
    if key_patch(&raw.base_key).is_none() {
        return Err(format!("invalid base key {:?}", raw.base_key));
    }
    if raw.home.is_empty() || !Path::new(&raw.home).is_absolute() {
        return Err("home is not an absolute path".into());
    }
    Ok(Identity {
        home: PathBuf::from(raw.home),
        base_key: raw.base_key,
    })
}

/// What `lstat` or an opened handle says about one path.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Observed {
    pub regular: bool,
    pub directory: bool,
    pub reparse: bool,
    pub len: u64,
    /// Hard-link count; known only from an opened handle, `1` from lstat.
    pub links: u32,
}
#[cfg(windows)]
fn reparse(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_attributes() & REPARSE_ATTRIBUTE != 0
}
#[cfg(not(windows))]
fn reparse(metadata: &fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}
fn lstat(path: &Path) -> io::Result<Option<Observed>> {
    match fs::symlink_metadata(path) {
        Ok(m) => Ok(Some(Observed {
            regular: m.is_file(),
            directory: m.is_dir(),
            reparse: reparse(&m),
            len: m.len(),
            links: 1,
        })),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}
/// Attributes, size and link count of an opened handle. The handle is the
/// authority for sharing; a directory entry cannot report hard links.
#[cfg(windows)]
fn observe(file: &fs::File) -> io::Result<Observed> {
    use std::os::windows::io::AsRawHandle;
    #[repr(C)]
    #[derive(Default)]
    struct Info {
        attributes: u32,
        times: [u32; 6],
        volume: u32,
        size_high: u32,
        size_low: u32,
        links: u32,
        index_high: u32,
        index_low: u32,
    }
    unsafe extern "system" {
        fn GetFileInformationByHandle(handle: *mut std::ffi::c_void, info: *mut Info) -> i32;
    }
    let mut info = Info::default();
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let directory = info.attributes & 0x10 != 0;
    Ok(Observed {
        regular: !directory,
        directory,
        reparse: info.attributes & REPARSE_ATTRIBUTE != 0,
        len: (u64::from(info.size_high) << 32) | u64::from(info.size_low),
        links: info.links,
    })
}
#[cfg(not(windows))]
fn observe(file: &fs::File) -> io::Result<Observed> {
    use std::os::unix::fs::MetadataExt;
    let m = file.metadata()?;
    Ok(Observed {
        regular: m.is_file(),
        directory: m.is_dir(),
        reparse: false,
        len: m.len(),
        links: u32::try_from(m.nlink()).unwrap_or(u32::MAX),
    })
}
fn open_observe(path: &Path) -> io::Result<Observed> {
    observe(&fs::File::open(path)?)
}
fn name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}
/// An existing fixed directory must be an ordinary directory. Returns whether
/// it exists; NotFound is a fact, every other error refuses.
fn ordinary_dir(stage: &str, path: &Path) -> Result<bool> {
    match lstat(path).map_err(io_stage(stage, format!("inspect {}", name(path))))? {
        None => Ok(false),
        Some(o) if o.directory && !o.reparse => Ok(true),
        Some(_) => Err(refuse(
            stage,
            format!("{} is not an ordinary directory", path.display()),
        )),
    }
}
/// An existing fixed file leaf must be an ordinary nonreparse file.
fn ordinary_leaf(stage: &str, path: &Path) -> Result<Option<Observed>> {
    match lstat(path).map_err(io_stage(stage, format!("inspect {}", name(path))))? {
        None => Ok(None),
        Some(o) if o.regular && !o.reparse => Ok(Some(o)),
        Some(_) => Err(refuse(
            stage,
            format!("{} is not an ordinary file", path.display()),
        )),
    }
}
/// Append, lock, launcher, cfg and DLL leaves must not share their data.
fn unshared_leaf(stage: &str, path: &Path) -> Result<Option<Observed>> {
    let Some(entry) = ordinary_leaf(stage, path)? else {
        return Ok(None);
    };
    let opened = open_observe(path).map_err(io_stage(stage, format!("open {}", name(path))))?;
    if opened.links != 1 || opened.reparse || !opened.regular {
        return Err(refuse(
            stage,
            format!("{} shares its data with another link", path.display()),
        ));
    }
    Ok(Some(entry))
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub(super) enum Launcher {
    Missing,
    Short,
    Present,
}
/// SHORT means an ordinary unshared file under 64 bytes whose opened object
/// agrees with its directory entry. Anything else that is not NotFound refuses.
pub(super) fn launcher_policy(
    entry: Option<Observed>,
    opened: Option<Observed>,
) -> std::result::Result<Launcher, &'static str> {
    let Some(entry) = entry else {
        return Ok(Launcher::Missing);
    };
    if !entry.regular || entry.reparse {
        return Err("is not an ordinary file");
    }
    let Some(opened) = opened else {
        return Err("could not be opened read-only");
    };
    if !opened.regular || opened.reparse || opened.len != entry.len {
        return Err("opened object disagrees with its directory entry");
    }
    if opened.links != 1 {
        return Err("shares its data with another link");
    }
    Ok(if entry.len < SHORT_LIMIT {
        Launcher::Short
    } else {
        Launcher::Present
    })
}
fn launcher_state(stage: &str, path: &Path) -> Result<Launcher> {
    let entry = lstat(path).map_err(io_stage(stage, format!("inspect {}", name(path))))?;
    let opened = match entry {
        Some(o) if o.regular && !o.reparse => {
            Some(open_observe(path).map_err(io_stage(stage, format!("open {}", name(path))))?)
        }
        _ => None,
    };
    launcher_policy(entry, opened)
        .map_err(|cause| refuse(stage, format!("{} {cause}", path.display())))
}

/// Recursive directory-only no-follow check over one operation root. Only
/// the validated minor alias directly under the Python root may be a reparse
/// entry; it is never descended. A missing root is a fact for the caller.
fn check_tree(stage: &str, root: &Path, alias: Option<&Path>) -> Result<()> {
    fn walk(stage: &str, dir: &Path, alias: Option<&Path>) -> Result<()> {
        for entry in
            fs::read_dir(dir).map_err(io_stage(stage, format!("list {}", dir.display())))?
        {
            let entry = entry.map_err(io_stage(stage, format!("list {}", dir.display())))?;
            let path = entry.path();
            let metadata = entry
                .metadata()
                .map_err(io_stage(stage, format!("inspect {}", path.display())))?;
            if reparse(&metadata) && (metadata.is_dir() || cfg!(unix)) {
                if alias == Some(path.as_path()) {
                    continue;
                }
                return Err(refuse(
                    stage,
                    format!(
                        "{} is a reparse point inside an owned directory",
                        path.display()
                    ),
                ));
            }
            if metadata.is_dir() {
                walk(stage, &path, alias)?;
            }
        }
        Ok(())
    }
    match lstat(root).map_err(io_stage(stage, format!("inspect {}", root.display())))? {
        None => Ok(()),
        Some(o) if o.directory && !o.reparse => walk(stage, root, alias),
        Some(_) => Err(refuse(
            stage,
            format!("{} is not an ordinary directory", root.display()),
        )),
    }
}

fn canonical(path: &Path) -> io::Result<PathBuf> {
    fs::canonicalize(path)
}
/// Check just the ancestors and final leaf of an expected import path. Missing
/// components remain package damage; existing reparse components refuse before
/// Python can execute through them. This never walks site-packages recursively.
fn import_path(stage: &str, site: &Path, relative: &Path) -> Result<()> {
    let mut path = site.to_owned();
    ordinary_dir(stage, &path)?;
    for component in relative.parent().unwrap_or(Path::new("")).components() {
        path.push(component);
        ordinary_dir(stage, &path)?;
    }
    ordinary_leaf(stage, &site.join(relative))?;
    Ok(())
}

fn package_preflight(stage: &str, site: &Path) -> Result<()> {
    // Lib is outside the relative import paths, but is still a fixed ancestor.
    ordinary_dir(stage, site.parent().unwrap_or(site))?;
    import_path(stage, site, Path::new("edge_tts/communicate.py"))?;
    for locked in LOCKED {
        import_path(
            stage,
            site,
            &PathBuf::from(locked.module).join("__init__.py"),
        )?;
        import_path(stage, site, Path::new(&format!("{}.py", locked.module)))?;
        for (_, relative) in locked.extensions {
            import_path(stage, site, Path::new(relative))?;
            if ordinary_leaf(stage, &site.join(relative))?.is_some() {
                open_observe(&site.join(relative))
                    .map_err(io_stage(stage, format!("open {relative}")))?;
            }
        }
    }
    Ok(())
}
fn same_identity(a: &Path, b: &Path) -> bool {
    matches!((canonical(a), canonical(b)), (Ok(a), Ok(b)) if a == b)
}
/// Long-name form of a path without following its final reparse entry, so an
/// 8.3 component compares by name. Unix paths have no short aliases.
#[cfg(windows)]
fn long_name(path: &Path) -> io::Result<PathBuf> {
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetLongPathNameW(short: *const u16, long: *mut u16, length: u32) -> u32;
    }
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut long = vec![0u16; 32768];
    let length =
        unsafe { GetLongPathNameW(wide.as_ptr(), long.as_mut_ptr(), long.len() as u32) } as usize;
    if length == 0 || length >= long.len() {
        return Err(io::Error::last_os_error());
    }
    Ok(PathBuf::from(OsString::from_wide(&long[..length])))
}
#[cfg(not(windows))]
fn long_name(path: &Path) -> io::Result<PathBuf> {
    Ok(path.to_owned())
}

/// The minor alias, when present, must be a reparse entry directly under the
/// Python root whose no-follow target is an immediate exact-key sibling. The
/// target may be missing; its parent and final component are still proved.
pub(super) fn alias_target(stage: &str, layout: &Layout) -> Result<Option<String>> {
    let Some(entry) = lstat(&layout.alias).map_err(io_stage(stage, "inspect Python alias"))? else {
        return Ok(None);
    };
    if !entry.reparse || entry.regular {
        return Err(refuse(stage, "the Python alias is not a directory link"));
    }
    let target = fs::read_link(&layout.alias).map_err(io_stage(stage, "read Python alias"))?;
    let target = if target.is_absolute() {
        target
    } else {
        layout.python_root.join(target)
    };
    let (Some(parent), Some(key)) = (target.parent(), target.file_name().and_then(OsStr::to_str))
    else {
        return Err(refuse(stage, "the Python alias target has no parent"));
    };
    if key_patch(key).is_none() || !same_identity(parent, &layout.python_root) {
        return Err(refuse(
            stage,
            format!(
                "the Python alias points outside the owned exact-key layout: {}",
                target.display()
            ),
        ));
    }
    Ok(Some(key.to_owned()))
}

#[derive(Debug, PartialEq, Eq)]
pub(super) struct VenvConfig {
    pub home: String,
    pub implementation: Option<String>,
    pub version_info: Option<String>,
    pub uv: bool,
}
/// `key = value` lines. A repeated tracked key makes the file unusable.
pub(super) fn parse_cfg(text: &str) -> Option<VenvConfig> {
    let mut home = None;
    let mut implementation = None;
    let mut version_info = None;
    let mut uv = false;
    for line in text.lines() {
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let (key, value) = (key.trim(), value.trim().to_owned());
        let slot = match key {
            "home" => &mut home,
            "implementation" => &mut implementation,
            "version_info" => &mut version_info,
            "uv" => {
                if uv {
                    return None;
                }
                uv = true;
                continue;
            }
            _ => continue,
        };
        if slot.replace(value).is_some() {
            return None;
        }
    }
    Some(VenvConfig {
        home: home?,
        implementation,
        version_info,
        uv,
    })
}
/// cfg home must be the minor alias or the exact-key directory directly under
/// this home's Python root, by long name, and resolve to the exact base.
fn cfg_consistent(stage: &str, cfg: &VenvConfig, layout: &Layout, key: &str) -> Result<()> {
    if cfg.implementation.as_deref() != Some("CPython") {
        return Err(refuse(stage, "pyvenv.cfg implementation is not CPython"));
    }
    if !cfg.uv {
        return Err(refuse(stage, "pyvenv.cfg was not created by uv"));
    }
    let patch = key_patch(key).unwrap_or_default();
    let version_ok = cfg.version_info.as_deref().is_some_and(|v| {
        let mut parts = v.split('.');
        parts.next() == Some("3")
            && parts.next() == Some("11")
            && parts.next().is_none_or(|p| p.parse::<u32>() == Ok(patch))
    });
    if !version_ok {
        return Err(refuse(
            stage,
            format!("pyvenv.cfg version_info disagrees with {key}"),
        ));
    }
    let home = Path::new(&cfg.home);
    let base_missing = !ordinary_dir(stage, &layout.base(key))?;
    let long = match long_name(home) {
        Ok(path) => path,
        Err(e) if base_missing && e.kind() == io::ErrorKind::NotFound => home.to_owned(),
        Err(e) => return Err(io_stage(stage, "resolve pyvenv.cfg home")(e)),
    };
    let entry = long.file_name().and_then(OsStr::to_str).unwrap_or_default();
    let parent_ok = long
        .parent()
        .is_some_and(|parent| same_identity(parent, &layout.python_root));
    let base_ok = if base_missing {
        entry == key
            || (entry == MINOR_ALIAS && alias_target(stage, layout)?.as_deref() == Some(key))
    } else {
        same_identity(home, &layout.base(key))
    };
    if !parent_ok || (entry != MINOR_ALIAS && entry != key) || !base_ok {
        return Err(refuse(
            stage,
            format!(
                "pyvenv.cfg home {} is not the owned {key} base or its alias",
                cfg.home
            ),
        ));
    }
    Ok(())
}
fn read_cfg(stage: &str, layout: &Layout) -> Result<Option<VenvConfig>> {
    if unshared_leaf(stage, &layout.venv_cfg)?.is_none() {
        return Ok(None);
    }
    let text = fs::read_to_string(&layout.venv_cfg).map_err(io_stage(stage, "read pyvenv.cfg"))?;
    parse_cfg(&text)
        .map(Some)
        .ok_or_else(|| refuse(stage, "pyvenv.cfg is not usable"))
}
fn check_cfg(stage: &str, layout: &Layout, key: &str) -> Result<()> {
    let cfg = read_cfg(stage, layout)?.ok_or_else(|| refuse(stage, "pyvenv.cfg is missing"))?;
    cfg_consistent(stage, &cfg, layout, key)
}

/// The closed set of uv mutations. Nothing else is ever executed with uv.
#[derive(Debug, Clone, Copy)]
pub(super) enum Mutation<'a> {
    InstallMinor,
    ReinstallKey(&'a str),
    Venv {
        base_python: &'a Path,
        venv: &'a Path,
    },
    Pip {
        python: &'a Path,
        requirements: &'a Path,
    },
}
impl Mutation<'_> {
    pub(super) fn args(&self) -> Vec<OsString> {
        let mut args: Vec<OsString> = vec!["--no-config".into()];
        match self {
            Self::InstallMinor => {
                args.extend(["python", "install", "--no-bin", "3.11"].map(OsString::from));
            }
            Self::ReinstallKey(key) => {
                args.extend(
                    ["python", "install", "--no-bin", "--reinstall", key].map(OsString::from),
                );
            }
            Self::Venv { base_python, venv } => {
                args.extend(
                    [
                        "venv",
                        "--allow-existing",
                        "--no-project",
                        "--managed-python",
                        "--python",
                    ]
                    .map(OsString::from),
                );
                args.push(base_python.into());
                args.push(venv.into());
            }
            Self::Pip {
                python,
                requirements,
            } => {
                args.extend(["pip", "install", "--python"].map(OsString::from));
                args.push(python.into());
                args.extend(
                    [
                        "--reinstall",
                        "--require-hashes",
                        "--no-deps",
                        "--no-build",
                        "-r",
                    ]
                    .map(OsString::from),
                );
                args.push(requirements.into());
            }
        }
        args
    }
    /// Operation roots checked immediately before this mutation.
    fn roots(&self, layout: &Layout, key: Option<&str>) -> Vec<PathBuf> {
        match self {
            Self::InstallMinor | Self::ReinstallKey(_) => {
                vec![layout.python_root.clone(), layout.cache.clone()]
            }
            Self::Venv { .. } | Self::Pip { .. } => vec![
                layout.base(key.unwrap_or_default()),
                layout.venv.clone(),
                layout.cache.clone(),
            ],
        }
    }
}
fn scrubbed(name: &OsStr) -> bool {
    let upper = name.to_string_lossy().to_ascii_uppercase();
    upper.starts_with("UV_") || upper.starts_with("PYTHON") || upper == "VIRTUAL_ENV"
}
/// Inherited environment minus UV_*, PYTHON* and VIRTUAL_ENV, with the owned
/// uv locations. HOME and USERPROFILE pass through unchanged.
pub(super) fn uv_environment(
    inherited: impl IntoIterator<Item = (OsString, OsString)>,
    layout: &Layout,
) -> Vec<(OsString, OsString)> {
    let mut env: Vec<(OsString, OsString)> = inherited
        .into_iter()
        .filter(|(name, _)| !scrubbed(name))
        .collect();
    env.extend([
        (
            "UV_PYTHON_INSTALL_DIR".into(),
            layout.python_root.clone().into(),
        ),
        ("UV_PYTHON_BIN_DIR".into(), layout.bin.clone().into()),
        ("UV_CACHE_DIR".into(), layout.cache.clone().into()),
        ("UV_LINK_MODE".into(), "copy".into()),
        ("UV_PYTHON_NO_REGISTRY".into(), "1".into()),
    ]);
    env
}
/// Probe environment: the same scrub, plus no bytecode for the entrypoint,
/// which cannot take `-B` itself. `-I` probes ignore PYTHON* anyway.
pub(super) fn probe_environment(
    inherited: impl IntoIterator<Item = (OsString, OsString)>,
) -> Vec<(OsString, OsString)> {
    let mut env: Vec<(OsString, OsString)> = inherited
        .into_iter()
        .filter(|(name, _)| !scrubbed(name))
        .collect();
    env.push(("PYTHONDONTWRITEBYTECODE".into(), "1".into()));
    env
}

/// One child process result. `status` is `None` for abnormal termination.
pub(super) struct Output {
    pub status: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}
fn tail(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    let text = text.trim();
    let start = text.len().saturating_sub(512);
    text[text.ceil_char_boundary(start)..].to_owned()
}
/// A complete structured result: normal exit, one ASCII JSON line, nothing else.
pub(super) fn complete_json<T: serde::de::DeserializeOwned>(
    stage: &str,
    what: &str,
    output: &Output,
) -> Result<T> {
    if output.status != Some(0) {
        return Err(refuse(
            stage,
            format!(
                "{what} exited with {}: {}",
                output
                    .status
                    .map_or("an abnormal termination".to_owned(), |c| format!(
                        "status {c}"
                    )),
                tail(&output.stderr)
            ),
        ));
    }
    if output.stdout.len() > OUTPUT_LIMIT || !output.stdout.is_ascii() {
        return Err(refuse(stage, format!("{what} produced unexpected output")));
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let line = text.trim_end_matches(['\r', '\n']);
    if line.contains('\n') || line.is_empty() {
        return Err(refuse(
            stage,
            format!("{what} produced an incomplete result"),
        ));
    }
    serde_json::from_str(line)
        .map_err(|e| refuse(stage, format!("{what} result is malformed: {e}")))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct IdentityProbe {
    implementation: String,
    version: String,
    executable: String,
    prefix: String,
    base_prefix: String,
    failures: BTreeMap<String, String>,
}
/// Exact implementation, patch, canonical executable/prefix/base and stdlib.
pub(super) fn identity_consistent(
    stage: &str,
    probe: &IdentityProbe,
    executable: &Path,
    prefix: &Path,
    base: &Path,
    key: &str,
) -> Result<()> {
    let patch = key_patch(key).unwrap_or_default();
    if probe.implementation != "CPython" || probe.version != format!("3.11.{patch}") {
        return Err(refuse(
            stage,
            format!(
                "interpreter reports {} {}, expected CPython 3.11.{patch}",
                probe.implementation, probe.version
            ),
        ));
    }
    for (label, reported, expected) in [
        ("executable", &probe.executable, executable),
        ("prefix", &probe.prefix, prefix),
        ("base prefix", &probe.base_prefix, base),
    ] {
        if !same_identity(Path::new(reported), expected) {
            return Err(refuse(
                stage,
                format!(
                    "interpreter {label} {reported} is not {}",
                    expected.display()
                ),
            ));
        }
    }
    if let Some((module, kind)) = probe.failures.iter().next() {
        return Err(refuse(
            stage,
            format!("required module {module} failed: {kind}"),
        ));
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct PackageProbe {
    distributions: BTreeMap<String, Distribution>,
    modules: BTreeMap<String, ImportResult>,
    extensions: BTreeMap<String, Extension>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Distribution {
    version: Option<String>,
    error: Option<Failure>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ImportResult {
    status: String,
    origin: Option<String>,
    loader: Option<String>,
    error: Option<Failure>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Failure {
    #[serde(rename = "type")]
    kind: String,
    exact_import_error: bool,
    name: Option<String>,
    path: Option<String>,
    filename: Option<String>,
    errno: Option<i64>,
    winerror: Option<i64>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Extension {
    preopen: Preopen,
    import: ImportResult,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Preopen {
    status: String,
    size: Option<u64>,
    regular: Option<bool>,
    reparse: Option<bool>,
    error: Option<Failure>,
}
impl Failure {
    fn describe(&self) -> String {
        let mut text = self.kind.clone();
        if let Some(code) = self.winerror {
            text.push_str(&format!(" winerror {code}"));
        } else if let Some(code) = self.errno {
            text.push_str(&format!(" errno {code}"));
        }
        text
    }
}
#[derive(Debug, PartialEq, Eq)]
pub(super) enum Health {
    Healthy,
    /// Structured damage that one pinned pip install may repair.
    Repairable(String),
    Refused(String),
}
/// Locked `name==version` pins from the voice requirements.
pub(super) fn locked_versions(requirements: &str) -> BTreeMap<&str, &str> {
    requirements
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            let (name, rest) = line.split_once("==")?;
            let version = rest.split([' ', '\\']).next()?;
            (!name.is_empty() && !version.is_empty()).then_some((name, version))
        })
        .collect()
}
pub(super) fn probe_spec() -> String {
    serde_json::to_string(
        &LOCKED
            .iter()
            .map(|l| json!({"dist": l.dist, "module": l.module, "extensions": l.extensions}))
            .collect::<Vec<_>>(),
    )
    .unwrap_or_default()
}
/// Classify a complete package probe. Any refusal dominates; otherwise the
/// first structured damage is the repair cause. `canon` resolves a reported
/// path to its canonical identity, or `None` when it cannot be resolved.
pub(super) fn classify(
    probe: &PackageProbe,
    versions: &BTreeMap<&str, &str>,
    site: &Path,
    canon: &dyn Fn(&Path) -> Option<PathBuf>,
) -> Health {
    if probe.distributions.len() != LOCKED.len()
        || probe.modules.len() != LOCKED.len()
        || probe.extensions.len() != LOCKED.iter().map(|l| l.extensions.len()).sum::<usize>()
    {
        return Health::Refused("probe returned an unexpected set of checks".into());
    }
    let mut repair: Option<String> = None;
    let mut note = |cause: String| {
        repair.get_or_insert(cause);
    };
    let Some(site_canonical) = canon(site) else {
        return Health::Refused(format!(
            "site-packages {} cannot be resolved",
            site.display()
        ));
    };
    for locked in LOCKED {
        let expected_version = versions.get(locked.dist).copied().unwrap_or_default();
        let Some(dist) = probe.distributions.get(locked.dist) else {
            return Health::Refused(format!("probe omitted distribution {}", locked.dist));
        };
        let dist_missing = match (&dist.version, &dist.error) {
            (Some(v), None) if v == expected_version => false,
            (Some(v), None) => {
                note(format!("{} is {v}, locked {expected_version}", locked.dist));
                false
            }
            (None, Some(e)) if e.kind == "PackageNotFoundError" => {
                note(format!("{} is not installed", locked.dist));
                true
            }
            (_, Some(e)) => {
                return Health::Refused(format!(
                    "{} metadata failed: {}",
                    locked.dist,
                    e.describe()
                ));
            }
            (None, None) => return Health::Refused(format!("{} reported no version", locked.dist)),
        };
        let Some(module) = probe.modules.get(locked.module) else {
            return Health::Refused(format!("probe omitted module {}", locked.module));
        };
        let package_dir = site_canonical.join(locked.module);
        let module_missing = match (module.status.as_str(), &module.error) {
            ("ok", _) => {
                let origin = module.origin.as_deref().map(Path::new).and_then(canon);
                let expected = [
                    package_dir.join("__init__.py"),
                    site_canonical.join(format!("{}.py", locked.module)),
                ];
                if module.loader.as_deref() != Some("SourceFileLoader")
                    || !origin.is_some_and(|o| expected.contains(&o))
                {
                    return Health::Refused(format!(
                        "{} loads from an unexpected origin {:?}",
                        locked.module, module.origin
                    ));
                }
                false
            }
            ("error", Some(e))
                if e.kind == "ModuleNotFoundError"
                    && (e.name.as_deref() == Some(locked.module)
                        || e.name.as_deref().is_some_and(|name| {
                            LOCKED.iter().any(|l| {
                                l.module == name
                                    || l.extensions.iter().any(|(full, _)| *full == name)
                            }) || (name == "edge_tts.communicate"
                                && matches!(lstat(&site.join("edge_tts/communicate.py")), Ok(None)))
                        })) =>
            {
                note(format!("{} is missing", locked.module));
                true
            }
            ("error", Some(e)) if e.kind == "SyntaxError" => {
                let owned = e
                    .filename
                    .as_deref()
                    .map(Path::new)
                    .and_then(canon)
                    .is_some_and(|f| f.starts_with(&package_dir));
                if !owned {
                    return Health::Refused(format!(
                        "{} has a syntax error outside its owned files",
                        locked.module
                    ));
                }
                note(format!(
                    "{} has an invalid owned source file",
                    locked.module
                ));
                false
            }
            ("error", Some(e)) => {
                return Health::Refused(format!(
                    "{} import failed: {}",
                    locked.module,
                    e.describe()
                ));
            }
            _ => {
                return Health::Refused(format!("{} reported an incomplete result", locked.module));
            }
        };
        for (full, relative) in locked.extensions {
            let short = full.rsplit('.').next().unwrap_or(full);
            let Some(extension) = probe.extensions.get(*full) else {
                return Health::Refused(format!("probe omitted extension {full}"));
            };
            let expected = site_canonical.join(relative);
            let import = &extension.import;
            match extension.preopen.status.as_str() {
                "ok" => match (import.status.as_str(), &import.error) {
                    ("ok", _) => {
                        let origin = import.origin.as_deref().map(Path::new).and_then(canon);
                        if import.loader.as_deref() != Some("ExtensionFileLoader")
                            || origin.as_deref() != Some(expected.as_path())
                        {
                            return Health::Refused(format!(
                                "{full} loads from an unexpected origin {:?}",
                                import.origin
                            ));
                        }
                    }
                    ("error", Some(e)) => {
                        let path_ok = e
                            .path
                            .as_deref()
                            .map(Path::new)
                            .and_then(canon)
                            .is_some_and(|p| p == expected);
                        let name_ok =
                            e.name.as_deref() == Some(full) || e.name.as_deref() == Some(short);
                        if e.exact_import_error && name_ok && path_ok {
                            note(format!("{full} failed to load from its expected file"));
                        } else {
                            return Health::Refused(format!(
                                "{full} import failed without an exact load failure: {}",
                                e.describe()
                            ));
                        }
                    }
                    _ => return Health::Refused(format!("{full} reported an incomplete result")),
                },
                "missing" => match (import.status.as_str(), &import.error) {
                    ("error", Some(e))
                        if e.kind == "ModuleNotFoundError" && e.name.as_deref() == Some(full) =>
                    {
                        note(format!("{full} is missing"));
                    }
                    ("ok", _) => {
                        return Health::Refused(format!(
                            "{full} imported from elsewhere while its expected file is missing"
                        ));
                    }
                    _ => {
                        return Health::Refused(format!(
                            "{full} is missing and failed unexpectedly"
                        ));
                    }
                },
                "parent_missing" => {
                    if !(dist_missing || module_missing) {
                        return Health::Refused(format!(
                            "{full} parent directory is missing while {} is present",
                            locked.dist
                        ));
                    }
                }
                other => {
                    let detail = extension
                        .preopen
                        .error
                        .as_ref()
                        .map(Failure::describe)
                        .unwrap_or_else(|| {
                            format!(
                                "regular {:?} reparse {:?} size {:?}",
                                extension.preopen.regular,
                                extension.preopen.reparse,
                                extension.preopen.size
                            )
                        });
                    return Health::Refused(format!(
                        "{full} could not be opened ({other}): {detail}"
                    ));
                }
            }
        }
    }
    match repair {
        Some(cause) => Health::Repairable(cause),
        None => Health::Healthy,
    }
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub(super) enum Receipt {
    Absent,
    Current,
    Stale,
}
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub(super) enum Branch {
    InstallUpdate,
    HealthRepair,
}
/// A recreated venv or a receipt that is not the current lock installs; only
/// an identity-healthy venv with the current receipt is probed for repair.
pub(super) fn package_branch(recreated: bool, receipt: Receipt) -> Branch {
    if recreated || receipt != Receipt::Current {
        Branch::InstallUpdate
    } else {
        Branch::HealthRepair
    }
}
fn read_receipt(stage: &str, layout: &Layout, lock: &str) -> Result<Receipt> {
    if ordinary_leaf(stage, &layout.receipt)?.is_none() {
        return Ok(Receipt::Absent);
    }
    let bytes = fs::read(&layout.receipt).map_err(io_stage(stage, "read voice receipt"))?;
    Ok(if bytes == lock.as_bytes() {
        Receipt::Current
    } else {
        Receipt::Stale
    })
}

fn remove_obsolete_receipt(
    layout: &Layout,
    remove: impl FnOnce(&Path) -> io::Result<()>,
) -> Result<()> {
    ordinary_leaf("voice", &layout.receipt)?;
    match remove(&layout.receipt) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(io_stage("voice", "remove the obsolete voice receipt")(e)),
    }
}

/// Child processes. Production runs real programs; tests record calls.
pub(super) trait Runner {
    async fn uv(
        &mut self,
        layout: &Layout,
        uv: &Path,
        env: &[(OsString, OsString)],
        args: &[OsString],
    ) -> Result<()>;
    async fn python(
        &mut self,
        executable: &Path,
        args: &[OsString],
        cwd: &Path,
        env: &[(OsString, OsString)],
    ) -> Result<Output>;
    async fn entrypoint(
        &mut self,
        executable: &Path,
        env: &[(OsString, OsString)],
    ) -> Result<Output>;
}

struct Pass<'a, R: Runner> {
    layout: &'a Layout,
    emit: &'a dyn Fn(&str, &str),
    runner: &'a mut R,
    uv: PathBuf,
    uv_env: Vec<(OsString, OsString)>,
    probe_env: Vec<(OsString, OsString)>,
    lock: &'a str,
}
impl<R: Runner> Pass<'_, R> {
    async fn mutate(
        &mut self,
        stage: &str,
        key: Option<&str>,
        mutation: Mutation<'_>,
        message: (&str, &str),
    ) -> Result<()> {
        let alias = matches!(mutation, Mutation::InstallMinor | Mutation::ReinstallKey(_))
            .then_some(self.layout.alias.as_path());
        if alias.is_some() {
            // Even first-install resume may encounter an existing alias.
            // Only the proved owned alias is exempt from the directory walk.
            if let Some(selected) = alias_target(stage, self.layout)? {
                if key.is_some_and(|key| key != selected) {
                    return Err(refuse(
                        stage,
                        "the Python alias disagrees with the recorded key",
                    ));
                }
                ordinary_dir(stage, &self.layout.base(&selected))?;
            }
        }
        for root in mutation.roots(self.layout, key) {
            check_tree(stage, &root, alias)?;
        }
        if matches!(mutation, Mutation::Venv { .. } | Mutation::Pip { .. }) {
            unshared_leaf(stage, &self.layout.venv_cfg)?;
            launcher_state(stage, &self.layout.venv_python)?;
        }
        let args = mutation.args();
        (self.emit)(message.0, message.1);
        self.runner
            .uv(self.layout, &self.uv, &self.uv_env, &args)
            .await
            .map_err(|error| refuse(stage, error.message))
    }
    async fn probe_identity(
        &mut self,
        stage: &str,
        executable: &Path,
        prefix: &Path,
        key: &str,
    ) -> Result<()> {
        let args: Vec<OsString> = ["-I", "-B", "-c", IDENTITY_PROBE]
            .map(OsString::from)
            .to_vec();
        let output = self
            .runner
            .python(executable, &args, &self.layout.runtime, &self.probe_env)
            .await?;
        let probe: IdentityProbe = complete_json(stage, "identity probe", &output)?;
        identity_consistent(
            stage,
            &probe,
            executable,
            prefix,
            &self.layout.base(key),
            key,
        )
    }
    async fn base_healthy(&mut self, stage: &str, key: &str) -> Result<()> {
        let base = self.layout.base(key);
        if !ordinary_dir(stage, &base)? {
            return Err(refuse(stage, format!("{} is missing", base.display())));
        }
        if launcher_state(stage, &base.join("python.exe"))? != Launcher::Present {
            return Err(refuse(stage, "the base python.exe is missing or invalid"));
        }
        if unshared_leaf(stage, &base.join("python311.dll"))?.is_none() {
            return Err(refuse(stage, "python311.dll is missing"));
        }
        if let Some(alias) = alias_target(stage, self.layout)?
            && alias != key
        {
            return Err(refuse(
                stage,
                format!("the Python alias names {alias}, not {key}"),
            ));
        }
        self.probe_identity(stage, &base.join("python.exe"), &base, key)
            .await
    }
    async fn venv_healthy(&mut self, stage: &str, key: &str) -> Result<()> {
        check_cfg(stage, self.layout, key)?;
        if launcher_state(stage, &self.layout.venv_python)? != Launcher::Present {
            return Err(refuse(stage, "Scripts/python.exe is missing or invalid"));
        }
        let (python, venv) = (self.layout.venv_python.clone(), self.layout.venv.clone());
        self.probe_identity(stage, &python, &venv, key).await
    }
    /// Recorded base: whole-directory or launcher/DLL absence gets one exact-key
    /// reinstall. A present DLL is never replaced.
    async fn ensure_recorded_base(&mut self, key: &str) -> Result<()> {
        let stage = "base";
        let base = self.layout.base(key);
        if let Some(alias) = alias_target(stage, self.layout)?
            && alias != key
        {
            return Err(refuse(
                stage,
                format!("the Python alias names {alias}, the record names {key}"),
            ));
        }
        let repair = if ordinary_dir(stage, &base)? {
            launcher_state(stage, &base.join("python.exe"))? != Launcher::Present
                || unshared_leaf(stage, &base.join("python311.dll"))?.is_none()
        } else {
            if !ordinary_dir(stage, &self.layout.python_root)? {
                return Err(refuse(stage, "the Python root is missing"));
            }
            true
        };
        if repair {
            self.mutate(
                stage,
                Some(key),
                Mutation::ReinstallKey(key),
                ("python", "Restoring the Python base for code tools"),
            )
            .await?;
        }
        self.base_healthy(stage, key).await
    }
    /// Recorded venv: whole-directory absence recreates, a missing or SHORT
    /// redirector gets one allow-existing repair. Returns whether the whole
    /// venv was recreated.
    async fn ensure_recorded_venv(&mut self, key: &str) -> Result<bool> {
        let stage = "venv";
        let base_python = self.layout.base(key).join("python.exe");
        let venv = self.layout.venv.clone();
        let mutation = Mutation::Venv {
            base_python: &base_python,
            venv: &venv,
        };
        let recreated = if ordinary_dir(stage, &venv)? {
            check_cfg(stage, self.layout, key)?;
            if launcher_state(stage, &self.layout.venv_python)? != Launcher::Present {
                self.mutate(
                    stage,
                    Some(key),
                    mutation,
                    ("python", "Restoring the code tools interpreter"),
                )
                .await?;
            }
            false
        } else {
            if !ordinary_dir(stage, &self.layout.tools)? {
                return Err(refuse(stage, "runtime/tools is missing"));
            }
            self.mutate(
                stage,
                Some(key),
                mutation,
                ("python", "Recreating the code tools environment"),
            )
            .await?;
            true
        };
        self.venv_healthy(stage, key).await?;
        Ok(recreated)
    }
    /// No record, venv absent or empty: one managed install, trust only the
    /// alias-selected exact base after probing it, then create the venv.
    async fn first_install(&mut self) -> Result<String> {
        let stage = "install";
        self.mutate(
            stage,
            None,
            Mutation::InstallMinor,
            ("python", "Installing Python for code tools"),
        )
        .await?;
        let key = alias_target(stage, self.layout)?
            .ok_or_else(|| refuse(stage, "uv did not create the expected Python alias"))?;
        self.base_healthy(stage, &key).await?;
        let base_python = self.layout.base(&key).join("python.exe");
        let venv = self.layout.venv.clone();
        self.mutate(
            stage,
            Some(&key),
            Mutation::Venv {
                base_python: &base_python,
                venv: &venv,
            },
            ("python", "Installing Python for code tools"),
        )
        .await?;
        self.venv_healthy(stage, &key).await?;
        Ok(key)
    }
    /// No record, populated venv: adopt only a consistent uv-created venv on a
    /// healthy owned base. Nothing is repaired here.
    async fn adopt(&mut self) -> Result<String> {
        let stage = "adopt";
        let cfg = read_cfg(stage, self.layout)?
            .ok_or_else(|| refuse(stage, "an unrecorded environment has no usable pyvenv.cfg"))?;
        let home =
            long_name(Path::new(&cfg.home)).map_err(io_stage(stage, "resolve pyvenv.cfg home"))?;
        let entry = home
            .file_name()
            .and_then(OsStr::to_str)
            .unwrap_or_default()
            .to_owned();
        let key = if entry == MINOR_ALIAS {
            alias_target(stage, self.layout)?.ok_or_else(|| {
                refuse(stage, "pyvenv.cfg names a Python alias that does not exist")
            })?
        } else if key_patch(&entry).is_some() {
            entry
        } else {
            return Err(refuse(
                stage,
                format!("pyvenv.cfg home {} is not an owned base", cfg.home),
            ));
        };
        cfg_consistent(stage, &cfg, self.layout, &key)?;
        self.base_healthy(stage, &key).await?;
        self.venv_healthy(stage, &key).await?;
        Ok(key)
    }
    fn publish_identity(&self, key: &str) -> Result<()> {
        let stage = "identity";
        if lstat(&self.layout.identity)
            .map_err(io_stage(stage, "inspect identity record"))?
            .is_some()
        {
            return Err(refuse(
                stage,
                "an identity record appeared during provisioning",
            ));
        }
        let home = self
            .layout
            .home
            .to_str()
            .ok_or_else(|| refuse(stage, "the home path is not valid Unicode"))?;
        common::atomic_write(
            &self.layout.identity,
            json!({"schema": 1, "home": home, "base_key": key})
                .to_string()
                .as_bytes(),
        )
    }
    async fn probe_packages(&mut self, stage: &str) -> Result<Health> {
        let site = self.layout.site_packages();
        package_preflight(stage, &site)?;
        let args: Vec<OsString> = vec![
            "-I".into(),
            "-B".into(),
            "-c".into(),
            PACKAGE_PROBE.into(),
            site.clone().into(),
            probe_spec().into(),
        ];
        let output = self
            .runner
            .python(
                &self.layout.venv_python,
                &args,
                &self.layout.runtime,
                &self.probe_env,
            )
            .await?;
        let probe: PackageProbe = complete_json(stage, "package probe", &output)?;
        let versions = locked_versions(self.lock);
        let health = classify(&probe, &versions, &site, &|p| canonical(p).ok());
        if health != Health::Healthy {
            return Ok(health);
        }
        match launcher_state(stage, &self.layout.entrypoint)? {
            Launcher::Present => {}
            Launcher::Missing => return Ok(Health::Repairable("edge-tts.exe is missing".into())),
            Launcher::Short => return Ok(Health::Repairable("edge-tts.exe is truncated".into())),
        }
        let expected = format!(
            "edge-tts {}",
            versions.get("edge-tts").copied().unwrap_or_default()
        );
        let output = self
            .runner
            .entrypoint(&self.layout.entrypoint, &self.probe_env)
            .await?;
        let reported = String::from_utf8_lossy(&output.stdout).trim().to_owned();
        if output.status != Some(0) || reported != expected {
            return Ok(Health::Refused(format!(
                "edge-tts.exe --version reported {reported:?} with {}",
                output
                    .status
                    .map_or("an abnormal termination".to_owned(), |c| format!(
                        "status {c}"
                    ))
            )));
        }
        Ok(Health::Healthy)
    }
    async fn install_packages(&mut self, stage: &str, key: &str, message: &str) -> Result<()> {
        common::atomic_write(&self.layout.requirements, self.lock.as_bytes())?;
        let (python, requirements) = (
            self.layout.venv_python.clone(),
            self.layout.requirements.clone(),
        );
        self.mutate(
            stage,
            Some(key),
            Mutation::Pip {
                python: &python,
                requirements: &requirements,
            },
            ("voice", message),
        )
        .await?;
        let (venv_python, venv) = (self.layout.venv_python.clone(), self.layout.venv.clone());
        self.probe_identity("final", &venv_python, &venv, key)
            .await?;
        match self.probe_packages("final").await? {
            Health::Healthy => Ok(()),
            Health::Repairable(cause) | Health::Refused(cause) => Err(refuse(
                "final",
                format!("voice tools are still unhealthy after installation: {cause}"),
            )),
        }
    }
    async fn packages(&mut self, key: &str, recreated: bool) -> Result<()> {
        let stage = "voice";
        let receipt = read_receipt(stage, self.layout, self.lock)?;
        if recreated {
            // The old receipt describes the deleted venv; it must not survive.
            remove_obsolete_receipt(self.layout, |path| fs::remove_file(path))?;
        }
        match package_branch(recreated, receipt) {
            Branch::InstallUpdate => {
                self.install_packages(stage, key, "Installing voice tools")
                    .await?;
                common::atomic_write(&self.layout.receipt, self.lock.as_bytes())
            }
            Branch::HealthRepair => match self.probe_packages(stage).await? {
                Health::Healthy => Ok(()),
                Health::Repairable(cause) => self
                    .install_packages(stage, key, &format!("Repairing voice tools: {cause}"))
                    .await
                    .map_err(|error| {
                        refuse(stage, format!("{cause}; repair failed: {}", error.message))
                    }),
                Health::Refused(cause) => Err(refuse(stage, cause)),
            },
        }
    }
}

/// Read-only checks of every fixed chain and leaf that exists.
fn preflight(layout: &Layout, key: Option<&str>) -> Result<()> {
    let stage = "preflight";
    for directory in [
        &layout.home,
        &layout.runtime,
        &layout.bin,
        &layout.python_root,
        &layout.tools,
        &layout.venv,
        &layout.scripts,
        &layout.logs,
        &layout.cache,
    ] {
        ordinary_dir(stage, directory)?;
    }
    for leaf in [
        &layout.bin.join("uv.exe"),
        &layout.bin.join("uv-version"),
        &layout.requirements,
        &layout.identity,
        &layout.receipt,
    ] {
        ordinary_leaf(stage, leaf)?;
    }
    for leaf in [&layout.lock, &layout.log, &layout.venv_cfg] {
        unshared_leaf(stage, leaf)?;
    }
    for launcher in [&layout.venv_python, &layout.entrypoint] {
        launcher_state(stage, launcher)?;
    }
    if let Some(key) = key {
        let base = layout.base(key);
        if ordinary_dir(stage, &base)? {
            launcher_state(stage, &base.join("python.exe"))?;
            unshared_leaf(stage, &base.join("python311.dll"))?;
        }
    }
    Ok(())
}
#[derive(Debug, PartialEq, Eq)]
pub(super) enum Record {
    Absent,
    Valid(Identity),
}
fn read_record(layout: &Layout) -> Result<Record> {
    let stage = "identity";
    let Some(entry) = ordinary_leaf(stage, &layout.identity)? else {
        return Ok(Record::Absent);
    };
    if entry.len > IDENTITY_LIMIT {
        return Err(refuse(stage, "the identity record is larger than 16 KiB"));
    }
    use std::io::Read;
    let mut bytes = Vec::new();
    fs::File::open(&layout.identity)
        .and_then(|file| file.take(IDENTITY_LIMIT + 1).read_to_end(&mut bytes))
        .map_err(io_stage(stage, "read identity record"))?;
    let identity = parse_identity(&bytes)
        .map_err(|cause| refuse(stage, format!("the identity record is invalid: {cause}")))?;
    if !same_identity(&identity.home, &layout.home) {
        return Err(refuse(
            stage,
            format!(
                "the identity record names another home: {}",
                identity.home.display()
            ),
        ));
    }
    Ok(Record::Valid(identity))
}
#[derive(Debug, PartialEq, Eq)]
enum VenvState {
    AbsentOrEmpty,
    Populated,
}
fn unrecorded_venv_state(layout: &Layout) -> Result<VenvState> {
    let stage = "venv";
    if !ordinary_dir(stage, &layout.venv)? {
        return Ok(VenvState::AbsentOrEmpty);
    }
    let mut entries = fs::read_dir(&layout.venv).map_err(io_stage(stage, "list code-python"))?;
    Ok(match entries.next() {
        None => VenvState::AbsentOrEmpty,
        Some(Ok(_)) => VenvState::Populated,
        Some(Err(e)) => return Err(io_stage(stage, "list code-python")(e)),
    })
}

/// The one Windows provisioning pass. `install_uv` is the existing verified
/// tool installer; `lock` is the compiled voice requirements.
pub(super) async fn provision<R, F, Fut>(
    home: &Path,
    emit: &dyn Fn(&str, &str),
    runner: &mut R,
    install_uv: F,
    lock: &str,
) -> Result<()>
where
    R: Runner,
    F: FnOnce(PathBuf) -> Fut,
    Fut: Future<Output = Result<PathBuf>>,
{
    let layout = Layout::new(&canonical(home).map_err(io_stage("preflight", "resolve home"))?);
    let result = provision_in(&layout, emit, runner, install_uv, lock).await;
    if let Err(error) = &result
        && ordinary_dir("log", &layout.logs).is_ok_and(|exists| exists)
        && unshared_leaf("log", &layout.log).is_ok_and(|leaf| leaf.is_some())
        && let Ok(mut log) = fs::OpenOptions::new().append(true).open(&layout.log)
    {
        use std::io::Write;
        let _ = writeln!(log, "{}", error.message);
    }
    result
}
async fn provision_in<R, F, Fut>(
    layout: &Layout,
    emit: &dyn Fn(&str, &str),
    runner: &mut R,
    install_uv: F,
    lock: &str,
) -> Result<()>
where
    R: Runner,
    F: FnOnce(PathBuf) -> Fut,
    Fut: Future<Output = Result<PathBuf>>,
{
    // Entry: read-only checks before this boundary creates anything.
    preflight(layout, None)?;
    let key = match read_record(layout)? {
        Record::Valid(identity) => Some(identity.base_key),
        Record::Absent => None,
    };
    preflight(layout, key.as_deref())?;
    if !ordinary_dir("preflight", &layout.runtime)? {
        fs::create_dir(&layout.runtime).map_err(io_stage("preflight", "create runtime"))?;
    }
    if !ordinary_dir("preflight", &layout.runtime)? {
        return Err(refuse("preflight", "runtime disappeared"));
    }
    unshared_leaf("preflight", &layout.lock)?;
    let runtime = layout.runtime.clone();
    let _lock = tokio::task::spawn_blocking(move || crate::services::activation_lock(&runtime))
        .await
        .map_err(|e| Error::new(CODE, e.to_string()))??;
    // Under the lock: repeat the fixed checks and record validation.
    let record = read_record(layout)?;
    let recorded_key = match &record {
        Record::Valid(identity) => Some(identity.base_key.clone()),
        Record::Absent => None,
    };
    preflight(layout, recorded_key.as_deref())?;
    let uv = install_uv(layout.home.clone()).await?;
    let mut pass = Pass {
        layout,
        emit,
        runner,
        uv,
        uv_env: uv_environment(std::env::vars_os(), layout),
        probe_env: probe_environment(std::env::vars_os()),
        lock,
    };
    let (key, recreated) = match recorded_key {
        Some(key) => {
            // Refuse an inconsistent surviving venv before repairing the base.
            // Only whole-layer absence bypasses that layer's cfg/parents.
            if ordinary_dir("venv", &layout.venv)? {
                check_cfg("venv", layout, &key)?;
                if !ordinary_dir("venv", &layout.scripts)? {
                    return Err(refuse("venv", "Scripts is missing"));
                }
            }
            pass.ensure_recorded_base(&key).await?;
            let recreated = pass.ensure_recorded_venv(&key).await?;
            (key, recreated)
        }
        None => {
            let key = match unrecorded_venv_state(layout)? {
                VenvState::AbsentOrEmpty => pass.first_install().await?,
                VenvState::Populated => pass.adopt().await?,
            };
            pass.publish_identity(&key)?;
            (key, false)
        }
    };
    pass.packages(&key, recreated).await
}

/// Production processes: hidden children, null stdin, kill on drop, uv output
/// appended to the bootstrap log.
#[cfg(windows)]
pub(super) struct Processes;
#[cfg(windows)]
impl Runner for Processes {
    async fn uv(
        &mut self,
        layout: &Layout,
        uv: &Path,
        env: &[(OsString, OsString)],
        args: &[OsString],
    ) -> Result<()> {
        let output = command(uv, args, &layout.runtime, env)
            .output()
            .await
            .map_err(common::io_context("start uv"))?;
        fs::create_dir_all(&layout.logs)?;
        let mut log = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&layout.log)?;
        use std::io::Write;
        log.write_all(&output.stdout)?;
        log.write_all(&output.stderr)?;
        if !output.status.success() {
            return Err(Error::new(
                CODE,
                format!("Code runtime installer failed: {}", tail(&output.stderr)),
            ));
        }
        Ok(())
    }
    async fn python(
        &mut self,
        executable: &Path,
        args: &[OsString],
        cwd: &Path,
        env: &[(OsString, OsString)],
    ) -> Result<Output> {
        bounded_output(command(executable, args, cwd, env)).await
    }
    async fn entrypoint(
        &mut self,
        executable: &Path,
        env: &[(OsString, OsString)],
    ) -> Result<Output> {
        let args = [OsString::from("--version")];
        let cwd = executable.parent().unwrap_or(executable);
        bounded_output(command(executable, &args, cwd, env)).await
    }
}
#[cfg(windows)]
async fn bounded_output(mut command: tokio::process::Command) -> Result<Output> {
    use tokio::io::AsyncReadExt;
    command
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(common::io_context("start the code tools probe"))?;
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    async fn read(stream: impl tokio::io::AsyncRead + Unpin) -> Result<Vec<u8>> {
        let mut bytes = Vec::new();
        stream
            .take(OUTPUT_LIMIT as u64 + 1)
            .read_to_end(&mut bytes)
            .await?;
        if bytes.len() > OUTPUT_LIMIT {
            return Err(refuse("probe", "output exceeded 1 MiB"));
        }
        Ok(bytes)
    }
    // An over-limit stream stops the wait, then kill_on_drop stops the child.
    let (status, stdout, stderr) = tokio::try_join!(
        async { child.wait().await.map_err(Error::from) },
        read(stdout),
        read(stderr),
    )?;
    Ok(Output {
        status: status.code(),
        stdout,
        stderr,
    })
}
#[cfg(windows)]
fn command(
    program: &Path,
    args: &[OsString],
    cwd: &Path,
    env: &[(OsString, OsString)],
) -> tokio::process::Command {
    let mut command = tokio::process::Command::new(program);
    command.creation_flags(0x08000000); // Noninteractive GUI bootstrap child.
    command
        .args(args)
        .current_dir(cwd)
        .env_clear()
        .envs(env.iter().map(|(k, v)| (k.as_os_str(), v.as_os_str())))
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    command
}

// Portable controls run on Unix hosts; symlinks stand in for reparse points.
#[cfg(all(test, unix))]
#[path = "setup_python_tests.rs"]
mod tests;
