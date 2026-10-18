//! Standalone native runtime and managed code tools installation.
#[cfg(unix)]
use crate::install_ownership::{WRAPPER_MARKER, shell_quote};
use crate::{Error, Result, common, services};
use serde::Deserialize;
use serde_json::{Value, json};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::{
    collections::BTreeMap,
    fs,
    future::Future,
    io::Write,
    path::{Path, PathBuf},
};
use tokio::process::Command;

const VOICE_REQUIREMENTS: &str = include_str!("../assets/edge-tts.requirements.txt");
#[cfg(unix)]
const REQUIRED_FILES: &[&str] = &[
    "hexbot",
    "hexbot-core",
    "node",
    "pi/hexbot-pi",
    "pi/package-lock.json",
    "pi/node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
];
#[cfg(windows)]
const REQUIRED_FILES: &[&str] = &[
    "hexbot.exe",
    "node.exe",
    "pi/hexbot-pi.mjs",
    "pi/package-lock.json",
    "pi/node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
];

fn target() -> String {
    format!(
        "{}-{}",
        if cfg!(target_os = "macos") {
            "darwin"
        } else if cfg!(windows) {
            "win32"
        } else {
            "linux"
        },
        if cfg!(target_arch = "aarch64") {
            "arm64"
        } else {
            "x64"
        }
    )
}

#[derive(Deserialize)]
struct Manifest {
    version: String,
    target: String,
    files: BTreeMap<String, String>,
}
fn verify_runtime(directory: &Path) -> Result<Manifest> {
    let manifest: Manifest = serde_json::from_slice(&fs::read(directory.join("manifest.json"))?)
        .map_err(|e| Error::new(5243, format!("Invalid native runtime manifest: {e}")))?;
    if manifest.version != crate::version() || manifest.target != target() {
        return Err(Error::new(
            5243,
            "Native runtime version or architecture does not match this daemon",
        ));
    }
    if REQUIRED_FILES
        .iter()
        .any(|file| !manifest.files.contains_key(*file))
    {
        return Err(Error::new(5243, "Native runtime manifest is incomplete"));
    }
    let root = directory.canonicalize()?;
    for (file, digest) in &manifest.files {
        crate::platform::validate_path(Path::new(file))?;
        if !Path::new(file)
            .components()
            .all(|part| matches!(part, std::path::Component::Normal(_)))
            || file.starts_with('/')
            || file.contains('\\')
            || file.split('/').any(|part| matches!(part, "" | "." | ".."))
        {
            return Err(Error::new(5243, "Invalid native runtime manifest path"));
        }
        let path = root.join(file).canonicalize()?;
        if !path.starts_with(&root) || !path.is_file() || services::file_sha256(&path)? != *digest {
            return Err(Error::new(
                5243,
                format!("Native runtime checksum failed: {file}"),
            ));
        }
    }
    Ok(manifest)
}

// Bundles contain package symlinks. Resolve only links that stay inside the
// source, and copy their bytes so the installed bundle stands on its own.
fn copy_runtime(
    source: &Path,
    destination: &Path,
    root: &Path,
    ancestors: &mut Vec<PathBuf>,
) -> Result<()> {
    let source = source.canonicalize()?;
    if !source.starts_with(root) || ancestors.contains(&source) {
        return Err(Error::new(
            5243,
            "Native runtime contains an unsafe symbolic link",
        ));
    }
    let metadata = fs::metadata(&source)?;
    if metadata.is_dir() {
        ancestors.push(source.clone());
        fs::create_dir_all(destination)?;
        for entry in fs::read_dir(&source)? {
            let entry = entry?;
            copy_runtime(
                &entry.path(),
                &destination.join(entry.file_name()),
                root,
                ancestors,
            )?;
        }
        ancestors.pop();
    } else if metadata.is_file() {
        fs::copy(source, destination)?;
    } else {
        return Err(Error::new(5243, "Native runtime contains a special file"));
    }
    Ok(())
}

fn activate(home: &Path, source: &Path, emit: &impl Fn(&str, &str)) -> Result<()> {
    emit("verify", "Verifying the native runtime");
    let manifest = verify_runtime(source)?;
    fs::create_dir_all(home)?;
    let native = services::native_directory(home)?;
    let source = source.canonicalize()?;
    if native.starts_with(&source) {
        return Err(Error::new(
            5243,
            "Native runtime source contains the installation directory",
        ));
    }
    let staging = tempfile::tempdir_in(&native)?;
    emit("copy", "Copying the native runtime");
    copy_runtime(&source, staging.path(), &source, &mut Vec::new())?;
    verify_runtime(staging.path())?;
    emit("activate", "Activating the native runtime");
    services::publish_native(
        &native,
        &manifest.version,
        staging.path(),
        &crate::platform::executable_name("hexbot"),
        None,
    )?;
    Ok(())
}

#[derive(Deserialize)]
struct Release {
    version: String,
    url: String,
    name: String,
    targets: BTreeMap<String, (String, String)>,
}
struct Asset {
    version: String,
    #[cfg(unix)]
    directory: String,
    url: String,
    sha256: String,
}
fn tool_asset(tool: &str, target: &str) -> Result<Asset> {
    let releases: BTreeMap<String, Release> =
        serde_json::from_str(include_str!("../assets/code-tools.json"))
            .map_err(|e| Error::new(5243, e.to_string()))?;
    let release = releases
        .get(tool)
        .ok_or_else(|| Error::new(5243, "Unknown code tool"))?;
    let (triple, sha256) = release
        .targets
        .get(target)
        .ok_or_else(|| Error::new(5243, format!("Unsupported code runtime target: {target}")))?;
    let directory = format!("{}{triple}", release.name);
    Ok(Asset {
        version: release.version.clone(),
        url: format!(
            "{}/{directory}.{}",
            release.url,
            if target.starts_with("win32-") {
                "zip"
            } else {
                "tar.gz"
            }
        ),
        #[cfg(unix)]
        directory,
        sha256: sha256.clone(),
    })
}
async fn download_tool(url: String, destination: PathBuf) -> Result<()> {
    services::download(&url, &destination, 256 * 1024 * 1024, true).await
}
async fn install_tool<F, Fut>(
    home: &Path,
    tool: &str,
    asset: &Asset,
    download: F,
    emit: &impl Fn(&str, &str),
) -> Result<PathBuf>
where
    F: FnOnce(String, PathBuf) -> Fut,
    Fut: Future<Output = Result<()>>,
{
    let bin = home.join("bin");
    let executable = bin.join(crate::platform::executable_name(tool));
    let receipt = bin.join(format!("{tool}-version"));
    let recorded: Value = fs::read(&receipt)
        .ok()
        .and_then(|s| serde_json::from_slice(&s).ok())
        .unwrap_or(Value::Null);
    if executable.is_file()
        && recorded["version"] == asset.version
        && recorded["sha256"].as_str() == Some(services::file_sha256(&executable)?.as_str())
    {
        return Ok(executable);
    }
    emit("uv", "Preparing the code runtime installer");
    fs::create_dir_all(&bin)?;
    let runtime = home.join("runtime");
    fs::create_dir_all(&runtime)?;
    let staging = tempfile::tempdir_in(runtime)?;
    let archive = staging.path().join("archive.tar.gz");
    download(asset.url.clone(), archive.clone()).await?;
    if services::file_sha256(&archive)? != asset.sha256 {
        return Err(Error::new(5243, format!("{tool} checksum mismatch")));
    }
    let extracted = staging.path().join("extracted");
    fs::create_dir(&extracted)?;
    #[cfg(unix)]
    services::extract_archive(&archive, &extracted, 512 * 1024 * 1024)?;
    #[cfg(unix)]
    let source = extracted.join(&asset.directory).join(tool);
    #[cfg(windows)]
    let source = {
        use std::io::Read;
        let mut archive = zip::ZipArchive::new(fs::File::open(&archive)?)
            .map_err(|error| Error::new(5243, format!("Invalid code runtime archive: {error}")))?;
        let name = crate::platform::executable_name(tool);
        let mut entry = archive.by_name(&name).map_err(|error| {
            Error::new(5243, format!("Code runtime executable is missing: {error}"))
        })?;
        if !entry.is_file() || entry.size() > 128 * 1024 * 1024 {
            return Err(Error::new(5243, "Invalid code runtime executable"));
        }
        let source = extracted.join(&name);
        let mut bytes = Vec::new();
        entry
            .by_ref()
            .take(128 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() > 128 * 1024 * 1024 {
            return Err(Error::new(
                5243,
                "Code runtime executable exceeds byte limit",
            ));
        }
        fs::write(&source, bytes)?;
        source
    };
    #[cfg(unix)]
    fs::set_permissions(&source, fs::Permissions::from_mode(0o755))?;
    let mut staged = tempfile::NamedTempFile::new_in(&bin)?;
    std::io::copy(&mut fs::File::open(source)?, staged.as_file_mut())?;
    #[cfg(unix)]
    staged
        .as_file()
        .set_permissions(fs::Permissions::from_mode(0o755))?;
    staged
        .persist(&executable)
        .map_err(|error| Error::from(error.error))?;
    common::atomic_write(
        &receipt,
        json!({"version":asset.version,"sha256":services::file_sha256(&executable)?})
            .to_string()
            .as_bytes(),
    )?;
    Ok(executable)
}
async fn run_uv(home: &Path, uv: &Path, args: &[&str]) -> Result<String> {
    let mut command = Command::new(uv);
    command
        .args(args)
        .current_dir(home.join("runtime"))
        .env("UV_PYTHON_INSTALL_DIR", home.join("python"))
        .env("UV_PYTHON_BIN_DIR", home.join("bin"))
        .env("UV_CACHE_DIR", home.join("runtime/uv-cache"))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let (child, mut tree) = crate::pi::spawn_child(&mut command)?;
    let output = child.wait_with_output().await?;
    tree.finish()?;
    fs::create_dir_all(home.join("logs"))?;
    let mut log = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(home.join("logs/bootstrap.log"))?;
    log.write_all(&output.stdout)?;
    log.write_all(&output.stderr)?;
    if !output.status.success() {
        return Err(Error::new(
            5243,
            format!(
                "Code runtime installer failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ),
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}
fn remove_file(path: &Path) -> Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}
fn voice_current(home: &Path) -> bool {
    home.join(if cfg!(windows) {
        "runtime/tools/edge-tts/Scripts/edge-tts.exe"
    } else {
        "bin/edge-tts"
    })
    .exists()
        && fs::read_to_string(home.join("runtime/tools/edge-tts.requirements.txt"))
            .is_ok_and(|text| text == VOICE_REQUIREMENTS)
}
async fn install_code_runtime(home: &Path, emit: &impl Fn(&str, &str)) -> Result<()> {
    fs::create_dir_all(home.join("bin"))?;
    fs::create_dir_all(home.join("runtime"))?;
    let runtime = home.join("runtime");
    let _lock = tokio::task::spawn_blocking(move || services::activation_lock(&runtime))
        .await
        .map_err(|e| Error::new(5243, e.to_string()))??;
    let python = common::managed_python(home);
    let current = voice_current(home);
    if python.is_absolute() && python.exists() && current {
        return Ok(());
    }
    let uv = install_tool(
        home,
        "uv",
        &tool_asset("uv", &target())?,
        download_tool,
        emit,
    )
    .await?;
    let python = if !python.is_absolute() || !python.exists() {
        emit("python", "Installing Python for code tools");
        run_uv(home, &uv, &["python", "install", "--no-bin", "3.11"]).await?;
        let output = run_uv(
            home,
            &uv,
            &["python", "find", "--no-project", "--managed-python", "3.11"],
        )
        .await?;
        let executable = output
            .lines()
            .rfind(|line| Path::new(line.trim()).is_absolute())
            .ok_or_else(|| Error::new(5243, "Managed code interpreter was not found"))?
            .trim();
        let executable = PathBuf::from(executable);
        if !executable.is_file() {
            return Err(Error::new(5243, "Managed code interpreter was not found"));
        }
        #[cfg(unix)]
        {
            let python = home.join("bin/python3.11");
            remove_file(&python)?;
            std::os::unix::fs::symlink(&executable, &python)?;
        }
        #[cfg(windows)]
        common::atomic_write(
            &home.join("runtime/code-python.txt"),
            executable.to_string_lossy().as_bytes(),
        )?;
        executable
    } else {
        python
    };
    if !current {
        emit("voice", "Installing voice tools");
        let environment = home.join("runtime/tools/edge-tts");
        let receipt = home.join("runtime/tools/edge-tts.requirements.txt");
        remove_file(&receipt)?;
        match fs::remove_dir_all(&environment) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
        run_uv(
            home,
            &uv,
            &[
                "venv",
                "--no-project",
                "--python",
                &python.to_string_lossy(),
                &environment.to_string_lossy(),
            ],
        )
        .await?;
        let requirements = environment.join("requirements.txt");
        fs::write(&requirements, VOICE_REQUIREMENTS)?;
        run_uv(
            home,
            &uv,
            &[
                "pip",
                "install",
                "--python",
                &environment
                    .join(if cfg!(windows) {
                        "Scripts/python.exe"
                    } else {
                        "bin/python"
                    })
                    .to_string_lossy(),
                "--require-hashes",
                "--no-deps",
                "--no-build",
                "-r",
                &requirements.to_string_lossy(),
            ],
        )
        .await?;
        #[cfg(unix)]
        {
            let voice = home.join("bin/edge-tts");
            remove_file(&voice)?;
            std::os::unix::fs::symlink(environment.join("bin/edge-tts"), voice)?;
        }
        common::atomic_write(&receipt, VOICE_REQUIREMENTS.as_bytes())?;
    }
    Ok(())
}
fn link_cli(home: &Path, user_home: &Path, emit: &impl Fn(&str, &str)) -> Result<()> {
    let executable = crate::platform::stable_executable(home);
    if !executable.is_file() {
        return Err(Error::new(
            5243,
            "Native runtime is not installed; run hexbot setup --activate from an extracted runtime",
        ));
    }
    let bin = user_home.join(".local/bin");
    fs::create_dir_all(&bin)?;
    // Replace only a wrapper this command wrote; another `hexbot` stays put.
    let wrapper_path = bin.join(if cfg!(windows) {
        "hexbot.exe"
    } else {
        "hexbot"
    });
    #[cfg(windows)]
    if wrapper_path.with_file_name("hexbot-cli.json").exists() && !wrapper_path.exists() {
        let receipt: Value =
            serde_json::from_slice(&fs::read(wrapper_path.with_file_name("hexbot-cli.json"))?)
                .map_err(|_| {
                    Error::new(5243, "The existing Hexbot CLI receipt cannot be identified")
                })?;
        let owner = receipt["home"]
            .as_str()
            .and_then(|home| crate::install_ownership::resolved(Path::new(home)).ok());
        if receipt["marker"] != crate::install_ownership::WRAPPER_MARKER
            || owner != Some(home.canonicalize()?)
        {
            emit(
                "link",
                "Left the existing CLI receipt alone; it belongs to another installation",
            );
            return Ok(());
        }
    }
    if !matches!(fs::symlink_metadata(&wrapper_path), Err(e) if e.kind() == std::io::ErrorKind::NotFound)
        && !crate::install_ownership::wrapper_owned(&wrapper_path, home)
    {
        emit(
            "link",
            &format!(
                "Left {} alone; it is not this home's Hexbot wrapper. Run {} directly",
                wrapper_path.display(),
                executable.display()
            ),
        );
        return Ok(());
    }
    #[cfg(windows)]
    if wrapper_path.is_file()
        && services::file_sha256(&wrapper_path)? == services::file_sha256(&executable)?
    {
        emit(
            "link",
            &format!("CLI installed at {}", wrapper_path.display()),
        );
        return Ok(());
    }
    #[cfg(unix)]
    let wrapper = format!(
        "#!/bin/sh\n{WRAPPER_MARKER}\nexport HEXBOT_HOME={}\nexec {} \"$@\"\n",
        shell_quote(&home.to_string_lossy()),
        shell_quote(&executable.to_string_lossy())
    );
    let staged = tempfile::NamedTempFile::new_in(&bin)?;
    #[cfg(unix)]
    fs::write(staged.path(), wrapper)?;
    #[cfg(windows)]
    fs::copy(&executable, staged.path())?;
    #[cfg(unix)]
    fs::set_permissions(staged.path(), fs::Permissions::from_mode(0o755))?;
    staged
        .persist(&wrapper_path)
        .map_err(|error| Error::from(error.error))?;
    #[cfg(windows)]
    common::atomic_write(
        &bin.join("hexbot-cli.json"),
        &crate::install_ownership::windows_cli_receipt(home, &wrapper_path)?,
    )?;
    emit(
        "link",
        &format!("CLI installed at {}", wrapper_path.display()),
    );
    if !std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()).any(|p| p == bin) {
        emit(
            "link",
            if cfg!(windows) {
                "Add %USERPROFILE%\\.local\\bin to your user Path in Windows settings"
            } else {
                "Add to your shell profile: export PATH=\"$HOME/.local/bin:$PATH\""
            },
        );
    }
    Ok(())
}

pub async fn run(home: &Path, args: &[String]) -> Result<()> {
    crate::platform::validate_home(home)?;
    if args.iter().any(|arg| {
        !matches!(
            arg.as_str(),
            "--activate" | "--no-code-tools" | "--no-cli" | "--json"
        )
    }) {
        return Err(Error::new(
            4200,
            "setup accepts --activate, --no-code-tools, --no-cli and --json",
        ));
    }
    let json = args.iter().any(|a| a == "--json");
    let emit = |stage: &str, message: &str| {
        if json {
            println!("{}", json!({"stage":stage,"message":message}));
        } else {
            println!("{message}");
        }
    };
    let user_home = PathBuf::from(
        crate::platform::user_home()
            .ok_or_else(|| Error::new(4200, "The user home directory is required"))?,
    );
    #[cfg(windows)]
    crate::windows_sandbox::create_private_dir_all(home)?;
    #[cfg(not(windows))]
    fs::create_dir_all(home)?;
    let home = home.canonicalize()?;
    if args.iter().any(|a| a == "--activate") {
        let executable = std::env::current_exe()?.canonicalize()?;
        let source = executable
            .parent()
            .ok_or_else(|| Error::new(5243, "Native runtime directory not found"))?;
        activate(&home, source, &emit)?;
    }
    if !args.iter().any(|a| a == "--no-code-tools") {
        install_code_runtime(&home, &emit).await?;
    }
    if !args.iter().any(|arg| arg == "--no-cli") {
        link_cli(&home, &user_home, &emit)?;
    }
    emit("done", "Hexbot setup complete");
    Ok(())
}

#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;
    fn runtime(root: &Path) {
        let mut files = BTreeMap::new();
        for file in REQUIRED_FILES {
            let path = root.join(file);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, file.as_bytes()).unwrap();
            files.insert(*file, services::file_sha256(&path).unwrap());
        }
        fs::write(
            root.join("manifest.json"),
            json!({"version":crate::version(),"target":target(),"files":files}).to_string(),
        )
        .unwrap();
    }
    #[test]
    fn windows_bundle_activation_selects_an_exe_without_symlinks() {
        let source = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let user = tempfile::tempdir().unwrap();
        runtime(source.path());
        activate(home.path(), source.path(), &|_, _| {}).unwrap();
        let selected = crate::platform::selected_native(home.path()).unwrap();
        assert_eq!(selected.file_name().unwrap(), "hexbot.exe");
        let stable = crate::platform::stable_executable(home.path());
        assert!(!crate::platform::is_link(
            &fs::symlink_metadata(&stable).unwrap()
        ));
        assert_eq!(
            fs::read_to_string(home.path().join("runtime/native-dispatcher.sha256")).unwrap(),
            services::file_sha256(&stable).unwrap()
        );
        link_cli(home.path(), user.path(), &|_, _| {}).unwrap();
        assert!(crate::install_ownership::wrapper_owned(
            &user.path().join(".local/bin/hexbot.exe"),
            home.path()
        ));
        fs::write(source.path().join("node.exe"), "tampered").unwrap();
        assert!(activate(home.path(), source.path(), &|_, _| {}).is_err());
        assert_eq!(
            crate::platform::selected_native(home.path()).unwrap(),
            selected
        );
    }
    #[test]
    fn windows_manifest_and_tool_pins_cover_native_launchers() {
        let source = tempfile::tempdir().unwrap();
        runtime(source.path());
        assert_eq!(verify_runtime(source.path()).unwrap().target, "win32-x64");
        assert!(
            tool_asset("uv", "win32-x64")
                .unwrap()
                .url
                .ends_with("uv-x86_64-pc-windows-msvc.zip")
        );
        let mut manifest: Value =
            serde_json::from_slice(&fs::read(source.path().join("manifest.json")).unwrap())
                .unwrap();
        manifest["files"][r"C:\outside.exe"] = json!("bad");
        fs::write(source.path().join("manifest.json"), manifest.to_string()).unwrap();
        assert!(verify_runtime(source.path()).is_err());
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    fn runtime(root: &Path) {
        let mut files = BTreeMap::new();
        for file in REQUIRED_FILES {
            let path = root.join(file);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, if *file == "hexbot" {
                // The packaged launcher resolves symlinks before locating its root.
                "#!/bin/sh\nset -eu\nlauncher=$0\nwhile [ -L \"$launcher\" ]; do\n  directory=$(CDPATH= cd -- \"$(dirname -- \"$launcher\")\" && pwd)\n  launcher=$(readlink \"$launcher\")\n  case \"$launcher\" in /*) ;; *) launcher=\"$directory/$launcher\" ;; esac\ndone\nroot=$(CDPATH= cd -- \"$(dirname -- \"$launcher\")\" && pwd)\nexec \"$root/hexbot-core\" \"$@\"\n"
            } else { "#!/bin/sh\nprintf '%s\\n' \"$HEXBOT_HOME\" \"$@\"\n" }).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
            files.insert(file.to_string(), services::file_sha256(&path).unwrap());
        }
        fs::write(
            root.join("manifest.json"),
            json!({"version":crate::version(),"target":target(),"files":files}).to_string(),
        )
        .unwrap();
    }
    #[test]
    fn activation_verifies_copies_and_links_a_synthetic_runtime() {
        let source = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let user = tempfile::tempdir().unwrap();
        runtime(source.path());
        activate(home.path(), source.path(), &|_, _| {}).unwrap();
        let selected = home
            .path()
            .join("runtime/native-executable")
            .canonicalize()
            .unwrap();
        assert!(selected.starts_with(home.path().canonicalize().unwrap().join("runtime/native")));
        assert_eq!(
            fs::read(&selected).unwrap(),
            fs::read(source.path().join("hexbot")).unwrap()
        );
        let receipt: Value = serde_json::from_slice(
            &fs::read(home.path().join("runtime/native-current.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(receipt["version"], crate::version());
        link_cli(home.path(), user.path(), &|_, _| {}).unwrap();
        let output = std::process::Command::new(user.path().join(".local/bin/hexbot"))
            .args(["one argument", "two"])
            .output()
            .unwrap();
        assert!(output.status.success());
        assert_eq!(
            String::from_utf8(output.stdout).unwrap(),
            format!("{}\none argument\ntwo\n", home.path().display())
        );
        link_cli(home.path(), user.path(), &|_, _| {}).unwrap();
        let foreign = user.path().join(".local/bin/hexbot");
        fs::write(&foreign, "#!/bin/sh\necho mine\n").unwrap();
        link_cli(home.path(), user.path(), &|_, _| {}).unwrap();
        assert_eq!(
            fs::read_to_string(&foreign).unwrap(),
            "#!/bin/sh\necho mine\n"
        );
        fs::write(source.path().join("node"), "tampered").unwrap();
        assert!(activate(home.path(), source.path(), &|_, _| {}).is_err());
        assert_eq!(
            home.path()
                .join("runtime/native-executable")
                .canonicalize()
                .unwrap(),
            selected
        );
    }
    #[test]
    fn link_cli_keeps_binary_unreadable_and_other_home_wrappers() {
        let home = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let user = tempfile::tempdir().unwrap();
        fs::create_dir(home.path().join("runtime")).unwrap();
        fs::write(home.path().join("runtime/native-executable"), "runtime").unwrap();
        let wrapper = user.path().join(".local/bin/hexbot");
        fs::create_dir_all(wrapper.parent().unwrap()).unwrap();
        for bytes in [
            vec![0x7f, b'E', b'L', b'F', 0xff],
            format!(
                "#!/bin/sh\n{WRAPPER_MARKER}\nexport HEXBOT_HOME={}\n",
                shell_quote(&other.path().to_string_lossy())
            )
            .into_bytes(),
        ] {
            fs::write(&wrapper, &bytes).unwrap();
            let messages = std::cell::RefCell::new(Vec::new());
            link_cli(home.path(), user.path(), &|_, message| {
                messages.borrow_mut().push(message.to_string())
            })
            .unwrap();
            assert_eq!(fs::read(&wrapper).unwrap(), bytes);
            assert!(messages.borrow().iter().any(|m| m.starts_with("Left ")));
        }
        fs::remove_file(&wrapper).unwrap();
        std::os::unix::fs::symlink(user.path().join("missing"), &wrapper).unwrap();
        link_cli(home.path(), user.path(), &|_, _| {}).unwrap();
        assert!(
            fs::symlink_metadata(&wrapper)
                .unwrap()
                .file_type()
                .is_symlink()
        );
    }

    #[test]
    fn manifest_paths_and_bundle_links_cannot_escape() {
        let source = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        runtime(source.path());
        fs::write(outside.path().join("secret"), "secret").unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("secret"),
            source.path().join("unlisted-link"),
        )
        .unwrap();
        let home = tempfile::tempdir().unwrap();
        assert!(activate(home.path(), source.path(), &|_, _| {}).is_err());
        assert!(!home.path().join("runtime/native-executable").exists());
        let path = source.path().join("manifest.json");
        let mut manifest: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        manifest["files"]["../escape"] = json!("0".repeat(64));
        fs::write(path, manifest.to_string()).unwrap();
        assert!(verify_runtime(source.path()).is_err());
    }
    #[test]
    fn pins_cover_all_desktop_targets_and_voice_receipts_match_exactly() {
        for tool in ["uv", "rg", "fd"] {
            for target in ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"] {
                let asset = tool_asset(tool, target).unwrap();
                assert_eq!(asset.sha256.len(), 64);
                assert!(asset.sha256.bytes().all(|c| c.is_ascii_hexdigit()));
                assert!(asset.url.starts_with("https://github.com/"));
            }
        }
        let home = tempfile::tempdir().unwrap();
        fs::create_dir_all(home.path().join("bin")).unwrap();
        fs::create_dir_all(home.path().join("runtime/tools")).unwrap();
        fs::write(home.path().join("bin/edge-tts"), "voice").unwrap();
        let receipt = home.path().join("runtime/tools/edge-tts.requirements.txt");
        fs::write(&receipt, VOICE_REQUIREMENTS).unwrap();
        assert!(voice_current(home.path()));
        fs::write(&receipt, "old").unwrap();
        assert!(!voice_current(home.path()));
    }
    #[tokio::test]
    async fn code_setup_waits_for_the_home_lock_before_checking_receipts() {
        let home = tempfile::tempdir().unwrap();
        fs::create_dir_all(home.path().join("runtime/tools")).unwrap();
        let lock = services::activation_lock(&home.path().join("runtime")).unwrap();
        let emit = |_: &str, _: &str| panic!("completed provisioning must be reused");
        let mut install = Box::pin(install_code_runtime(home.path(), &emit));
        std::future::poll_fn(|cx| {
            assert!(install.as_mut().poll(cx).is_pending());
            std::task::Poll::Ready(())
        })
        .await;
        // Another setup finishes its files and receipt while holding the lock.
        fs::write(home.path().join("bin/python3.11"), "python").unwrap();
        fs::write(home.path().join("bin/edge-tts"), "voice").unwrap();
        fs::write(
            home.path().join("runtime/tools/edge-tts.requirements.txt"),
            VOICE_REQUIREMENTS,
        )
        .unwrap();
        drop(lock);
        install.await.unwrap();
        // The guard is released even on the receipt fast path.
        use std::os::fd::AsRawFd;
        let contender = fs::File::open(home.path().join("runtime/activate.lock")).unwrap();
        assert_eq!(
            unsafe { libc::flock(contender.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
            0
        );
    }
    #[tokio::test]
    async fn concurrent_code_setup_builds_voice_once_under_the_home_lock() {
        use std::os::fd::AsRawFd;
        let home = tempfile::tempdir().unwrap();
        let bin = home.path().join("bin");
        fs::create_dir(&bin).unwrap();
        fs::write(bin.join("python3.11"), "python").unwrap();
        let uv = bin.join("uv");
        fs::write(
            &uv,
            r#"#!/bin/sh
set -eu
case "$1" in
    venv) for last do :; done; mkdir -p "$last/bin" ;;
    pip) touch tools/edge-tts/bin/edge-tts ;;
    *) exit 1 ;;
esac
"#,
        )
        .unwrap();
        fs::set_permissions(&uv, fs::Permissions::from_mode(0o755)).unwrap();
        fs::write(
            bin.join("uv-version"),
            json!({
                "version": tool_asset("uv", &target()).unwrap().version,
                "sha256": services::file_sha256(&uv).unwrap(),
            })
            .to_string(),
        )
        .unwrap();
        let builds = std::cell::Cell::new(0);
        let emit = |stage: &str, _: &str| {
            assert_eq!(stage, "voice");
            builds.set(builds.get() + 1);
            let contender = fs::File::open(home.path().join("runtime/activate.lock")).unwrap();
            assert_ne!(
                unsafe { libc::flock(contender.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
                0
            );
        };
        let (first, second) = tokio::join!(
            install_code_runtime(home.path(), &emit),
            install_code_runtime(home.path(), &emit),
        );
        first.unwrap();
        second.unwrap();
        assert_eq!(builds.get(), 1);
        assert!(voice_current(home.path()));
    }
    #[tokio::test]
    async fn tool_downloads_are_verified_and_receipts_detect_tampering() {
        let home = tempfile::tempdir().unwrap();
        let fixture = tempfile::tempdir().unwrap();
        let archive = fixture.path().join("tool.tar.gz");
        let gzip = flate2::write::GzEncoder::new(
            fs::File::create(&archive).unwrap(),
            flate2::Compression::default(),
        );
        let mut tar = tar::Builder::new(gzip);
        let content = b"#!/bin/sh\nexit 0\n";
        let mut header = tar::Header::new_gnu();
        header.set_size(content.len() as u64);
        header.set_mode(0o755);
        header.set_cksum();
        tar.append_data(&mut header, "uv-test/uv", &content[..])
            .unwrap();
        tar.into_inner().unwrap().finish().unwrap();
        let mut asset = Asset {
            version: "test".into(),
            directory: "uv-test".into(),
            url: "fixture".into(),
            sha256: services::file_sha256(&archive).unwrap(),
        };
        let download = |_: String, destination: PathBuf| {
            let archive = archive.clone();
            async move {
                fs::copy(archive, destination)?;
                Ok(())
            }
        };
        let executable = install_tool(home.path(), "uv", &asset, download, &|_, _| {})
            .await
            .unwrap();
        install_tool(
            home.path(),
            "uv",
            &asset,
            |_, _| async { panic!("current receipt must skip download") },
            &|_, _| {},
        )
        .await
        .unwrap();
        fs::write(&executable, "corrupt").unwrap();
        asset.sha256 = "0".repeat(64);
        assert!(
            install_tool(home.path(), "uv", &asset, download, &|_, _| {})
                .await
                .is_err()
        );
        assert_eq!(fs::read_to_string(&executable).unwrap(), "corrupt");
        asset.sha256 = services::file_sha256(&archive).unwrap();
        install_tool(home.path(), "uv", &asset, download, &|_, _| {})
            .await
            .unwrap();
        assert_eq!(fs::read(executable).unwrap(), content);
    }
}
