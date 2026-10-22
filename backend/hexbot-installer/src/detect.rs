#[cfg(unix)]
use crate::install_ownership;
use crate::{InstallOption, Installed, InstalledApp, Receipt, Result, Target, fail};
use std::{
    env, fs,
    path::{Path, PathBuf},
    process::Command,
};

#[derive(Debug, Clone)]
pub struct Paths {
    pub home: PathBuf,
    pub hexbot_home: PathBuf,
    pub apps_override: Option<PathBuf>,
    pub opt_override: Option<PathBuf>,
    pub service_root: PathBuf,
    pub service_no_load: bool,
}

impl Paths {
    pub fn from_env() -> Result<Self> {
        #[cfg(windows)]
        let user_home = env::var_os("USERPROFILE").or_else(|| env::var_os("HOME"));
        #[cfg(not(windows))]
        let user_home = env::var_os("HOME");
        let home = PathBuf::from(user_home.ok_or("User home is not set.")?);
        let paths = Self {
            hexbot_home: env::var_os("HEXBOT_HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(".hexbot")),
            opt_override: env::var_os("HEXBOT_INSTALL_OPT_DIR").map(PathBuf::from),
            apps_override: env::var_os("HEXBOT_INSTALL_APPS_DIR").map(PathBuf::from),
            service_root: env::var_os("HEXBOT_SERVICE_ROOT")
                .map(PathBuf::from)
                .unwrap_or_else(|| home.clone()),
            service_no_load: env::var("HEXBOT_SERVICE_NO_LOAD").as_deref() == Ok("1"),
            home,
        };
        paths.validate()?;
        Ok(paths)
    }

    pub fn validate(&self) -> Result<()> {
        for path in [&self.home, &self.hexbot_home, &self.service_root]
            .into_iter()
            .chain(self.apps_override.iter())
            .chain(self.opt_override.iter())
        {
            if !path.is_absolute()
                || path
                    .components()
                    .any(|c| matches!(c, std::path::Component::ParentDir))
            {
                return fail("Installer directories must be absolute paths without '..'.");
            }
        }
        if self.home.starts_with(&self.hexbot_home) {
            return fail("HEXBOT_HOME must not be HOME or one of its parent directories.");
        }
        Ok(())
    }

    pub fn receipt(&self) -> PathBuf {
        self.hexbot_home.join("install.json")
    }
    /// Shared by every installer for this user. Fixed under HOME rather than
    /// XDG_STATE_HOME, which a terminal and a desktop session may set
    /// differently, and kept out of caches that cleaners may sweep while it is held.
    pub fn installer_lock(&self, target: Target) -> PathBuf {
        if target.is_macos() {
            self.home
                .join("Library/Application Support/Hexbot/installer.lock")
        } else if target.is_windows() {
            self.home.join("AppData/Local/Hexbot/installer.lock")
        } else {
            self.home.join(".local/state/hexbot/installer.lock")
        }
    }
    pub fn executable(&self) -> PathBuf {
        {
            #[cfg(windows)]
            {
                native_selected(&self.hexbot_home)
                    .unwrap_or_else(|_| self.hexbot_home.join("runtime/not-installed.exe"))
            }
            #[cfg(not(windows))]
            {
                self.hexbot_home.join("runtime/native-executable")
            }
        }
    }
    pub fn desktop_dir(&self) -> PathBuf {
        self.home.join(".local/share/applications")
    }
    pub fn wrapper(&self) -> PathBuf {
        self.home.join(".local/bin/hexbot")
    }
    /// Windows CLI lives beside the Unix wrapper path, as a native forwarding EXE.
    /// macOS and Linux keep [`Self::wrapper`].
    pub fn cli_wrapper(&self, target: Target) -> PathBuf {
        if target.is_windows() {
            self.home.join(".local/bin/hexbot.exe")
        } else {
            self.wrapper()
        }
    }
    pub fn service_file(&self, target: Target) -> PathBuf {
        self.service_root.join(if target.is_windows() {
            "AppData/Local/Hexbot/daemon.ps1"
        } else if target.is_macos() {
            "Library/LaunchAgents/app.hexbot.daemon.plist"
        } else {
            ".config/systemd/user/hexbot.service"
        })
    }

    pub fn app_dirs(&self, target: Target) -> Vec<PathBuf> {
        if let Some(path) = &self.apps_override {
            return vec![path.clone()];
        }
        if target.is_macos() {
            vec![
                PathBuf::from("/Applications"),
                self.home.join("Applications"),
            ]
        } else if target.is_windows() {
            vec![self.home.join("AppData/Local/Hexbot/apps")]
        } else {
            vec![self.home.join(".local/share/hexbot")]
        }
    }

    pub fn install_apps_dir(&self, target: Target) -> Result<PathBuf> {
        let path = self.planned_apps_dir(target)?;
        fs::create_dir_all(&path)?;
        Ok(path)
    }

    /// Select the same destination for the option page without creating directories.
    pub fn planned_apps_dir(&self, target: Target) -> Result<PathBuf> {
        choose_apps_dir(self.app_dirs(target))
    }

    pub(crate) fn command(&self, executable: impl AsRef<std::ffi::OsStr>) -> Command {
        let mut command = Command::new(executable);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command
                .creation_flags(0x08000000)
                .env("USERPROFILE", &self.home);
        }
        command
            .env("HOME", &self.home)
            .env("HEXBOT_HOME", &self.hexbot_home)
            .env("HEXBOT_SERVICE_ROOT", &self.service_root)
            .env(
                "HEXBOT_SERVICE_NO_LOAD",
                if self.service_no_load { "1" } else { "0" },
            );
        #[cfg(target_os = "linux")]
        sanitize_appimage_env(&mut command);
        command
    }
}

pub fn app_option(id: &str) -> Option<InstallOption> {
    let base = id
        .strip_suffix(".nightly")
        .or_else(|| id.strip_suffix(".dev"))
        .unwrap_or(id);
    match base {
        "app.hexbot.desktop" => Some(InstallOption::Full),
        "app.hexbot.client" => Some(InstallOption::Client),
        _ => None,
    }
}

pub(crate) fn plist_value(bundle: &Path, key: &str) -> Option<String> {
    let output = Command::new("/usr/bin/plutil")
        .args(["-extract", key, "raw", "-o", "-"])
        .arg(bundle.join("Contents/Info.plist"))
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
}

pub fn read_receipt(path: &Path) -> Result<Option<Receipt>> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(serde_json::from_slice(&bytes)?)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

pub fn detect() -> Result<Installed> {
    detect_at(&Paths::from_env()?, Target::detect()?)
}

pub fn detect_at(paths: &Paths, target: Target) -> Result<Installed> {
    paths.validate()?;
    let mut installed = Installed {
        receipt: read_receipt(&paths.receipt())?,
        service: paths.service_file(target).exists()
            && if target.is_windows() {
                crate::windows_service::check_service(
                    &paths.service_file(target),
                    &paths.hexbot_home,
                )
                .is_ok()
            } else {
                #[cfg(unix)]
                {
                    install_ownership::check_service(
                        &paths.service_file(target),
                        &paths.hexbot_home,
                        target.is_macos(),
                    )
                    .is_ok()
                }
                #[cfg(not(unix))]
                {
                    false
                }
            },
        wrapper: if target.is_windows() {
            crate::windows_cli::removable(&paths.cli_wrapper(target), &paths.hexbot_home)
        } else {
            #[cfg(unix)]
            {
                install_ownership::wrapper_owned(&paths.wrapper(), &paths.hexbot_home)
            }
            #[cfg(not(unix))]
            {
                false
            }
        },
        runtime: paths.executable().exists(),
        ..Installed::default()
    };
    for directory in paths.app_dirs(target) {
        let entries = match fs::read_dir(directory) {
            Ok(entries) => entries,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e.into()),
        };
        for entry in entries {
            let path = entry?.path();
            if target.is_macos() {
                if path.extension().is_none_or(|e| e != "app") {
                    continue;
                }
                if let Some(id) = plist_value(&path, "CFBundleIdentifier")
                    && let Some(option) = app_option(&id)
                {
                    installed.apps.push(InstalledApp {
                        version: plist_value(&path, "CFBundleShortVersionString"),
                        path,
                        option,
                        app_id: id,
                        managed_by_dpkg: false,
                    });
                }
            } else if target.is_windows() {
                if let Some(id) = windows_app_id(&path) {
                    installed.apps.push(InstalledApp {
                        option: app_option(&id).expect("known app id"),
                        app_id: id,
                        path,
                        version: None,
                        managed_by_dpkg: false,
                    });
                }
            } else if let Some(id) = appimage_id(&path, installed.receipt.as_ref()) {
                installed.apps.push(InstalledApp {
                    option: app_option(&id).expect("known app id"),
                    app_id: id,
                    path,
                    version: None,
                    managed_by_dpkg: false,
                });
            }
        }
    }
    // Explicit paths isolate discovery from the system's package database.
    #[cfg(unix)]
    if target.is_linux() && (paths.apps_override.is_none() || paths.opt_override.is_some()) {
        let opt = paths.opt_override.as_deref().unwrap_or(Path::new("/opt"));
        installed.apps.extend(dpkg_apps(opt, |path| {
            paths
                .command("dpkg-query")
                .arg("-S")
                .arg(dpkg_pattern(path))
                .output()
                .is_ok_and(|output| output.status.success())
        }));
    }
    Ok(installed)
}

#[cfg(unix)]
fn dpkg_pattern(path: &Path) -> std::ffi::OsString {
    use std::os::unix::ffi::{OsStrExt, OsStringExt};
    let mut pattern = Vec::new();
    for &byte in path.as_os_str().as_bytes() {
        if matches!(byte, b'[' | b']' | b'*' | b'?' | b'\\') {
            pattern.push(b'\\');
        }
        pattern.push(byte);
    }
    std::ffi::OsString::from_vec(pattern)
}

#[cfg(unix)]
fn dpkg_apps(opt: &Path, owned: impl Fn(&Path) -> bool) -> Vec<InstalledApp> {
    fs::read_dir(opt)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name();
            let name = name.to_str()?;
            let suffix = name
                .strip_prefix("Hexbot Client")
                .or_else(|| name.strip_prefix("Hexbot"))?;
            if !matches!(suffix, "" | " [alpha]" | " Nightly" | " (dev)")
                || !entry.file_type().ok()?.is_dir()
                || !owned(&entry.path())
            {
                return None;
            }
            let id = id_from_name(name);
            Some(InstalledApp {
                path: entry.path(),
                option: app_option(&id)?,
                app_id: id,
                version: None,
                managed_by_dpkg: true,
            })
        })
        .collect()
}

/// Clean child processes only; the installer's WebKit still needs its AppImage libraries.
pub fn sanitize_appimage_env(command: &mut Command) {
    let mut environment: std::collections::BTreeMap<_, _> = env::vars_os().collect();
    for (key, value) in command.get_envs() {
        if let Some(value) = value {
            environment.insert(key.to_owned(), value.to_owned());
        } else {
            environment.remove(key);
        }
    }
    let Some(mount) = environment
        .get(std::ffi::OsStr::new("APPDIR"))
        .filter(|s| !s.is_empty())
    else {
        return;
    };
    let mount = PathBuf::from(mount);
    for (key, value) in environment {
        let name = key.to_string_lossy();
        if matches!(name.as_ref(), "APPDIR" | "APPIMAGE" | "ARGV0" | "OWD") {
            command.env_remove(&key);
        } else if matches!(
            name.as_ref(),
            "PATH" | "LD_LIBRARY_PATH" | "XDG_DATA_DIRS" | "GSETTINGS_SCHEMA_DIR"
        ) || ["GIO_", "GDK_PIXBUF_", "GTK_"]
            .iter()
            .any(|prefix| name.starts_with(prefix))
        {
            let kept: Vec<_> = env::split_paths(&value)
                .filter(|path| !path.starts_with(&mount))
                .collect();
            if kept.is_empty() {
                command.env_remove(&key);
            } else if let Ok(joined) = env::join_paths(kept) {
                command.env(&key, joined);
            }
        }
    }
}

fn id_from_name(name: &str) -> String {
    let lower = name.to_ascii_lowercase();
    let base = if lower.contains("client") {
        "app.hexbot.client"
    } else {
        "app.hexbot.desktop"
    };
    let suffix = if lower.contains("nightly") {
        ".nightly"
    } else if lower.contains("(dev)") || lower.contains("-dev") {
        ".dev"
    } else {
        ""
    };
    format!("{base}{suffix}")
}

fn appimage_id(path: &Path, receipt: Option<&Receipt>) -> Option<String> {
    use std::io::Read;
    if !fs::symlink_metadata(path).ok()?.is_file() {
        return None;
    }
    let name = path.file_name()?.to_str()?;
    let stem = name.strip_suffix(".AppImage")?;
    if app_option(stem).is_some() {
        return Some(stem.into());
    }
    if let Some(receipt) = receipt.filter(|r| r.paths.iter().any(|p| p == path)) {
        let base = match receipt.option {
            InstallOption::Full => "app.hexbot.desktop",
            InstallOption::Client => "app.hexbot.client",
            InstallOption::Headless => return None,
        };
        return Some(format!(
            "{base}{}",
            if receipt.channel == crate::Track::Nightly {
                ".nightly"
            } else {
                ""
            }
        ));
    }
    let version = stem
        .strip_prefix("Hexbot-")
        .or_else(|| stem.strip_prefix("HexbotClient-"))?
        .strip_suffix("-linux-x86_64")?;
    semver::Version::parse(version).ok()?;
    let mut magic = [0; 4];
    fs::File::open(path).ok()?.read_exact(&mut magic).ok()?;
    (magic == *b"\x7fELF").then(|| id_from_name(stem))
}

pub(crate) fn writable_directory(path: &Path) -> bool {
    let Some(existing) = path.ancestors().find(|p| p.exists()) else {
        return false;
    };
    if !existing.is_dir() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        let Ok(path) = std::ffi::CString::new(existing.as_os_str().as_bytes()) else {
            return false;
        };
        unsafe { libc::access(path.as_ptr(), libc::W_OK | libc::X_OK) == 0 }
    }
    #[cfg(windows)]
    {
        tempfile::NamedTempFile::new_in(existing).is_ok()
    }
}

pub(crate) fn windows_app_id(path: &Path) -> Option<String> {
    if !fs::symlink_metadata(path).ok()?.is_dir() {
        return None;
    }
    if ![".hexbot-app.json", "resources", "resources/app.asar"]
        .iter()
        .all(|name| {
            fs::symlink_metadata(path.join(name)).is_ok_and(|m| {
                if *name == "resources" {
                    m.is_dir()
                } else {
                    m.is_file()
                }
            })
        })
    {
        return None;
    }
    let value: serde_json::Value =
        serde_json::from_slice(&fs::read(path.join(".hexbot-app.json")).ok()?).ok()?;
    let id = value["appId"].as_str()?;
    let exe = if id.starts_with("app.hexbot.client") {
        "HexbotClient.exe"
    } else {
        "Hexbot.exe"
    };
    (app_option(id).is_some()
        && fs::symlink_metadata(path.join(exe)).is_ok_and(|m| m.is_file())
        && path.join("resources/app.asar").is_file())
    .then(|| id.to_owned())
}
#[cfg(windows)]
fn native_selected(home: &Path) -> std::io::Result<PathBuf> {
    crate::native_selection::selected(home)
}

fn choose_apps_dir(dirs: Vec<PathBuf>) -> Result<PathBuf> {
    dirs.into_iter()
        .find(|path| writable_directory(path))
        .ok_or_else(|| "The apps directory is not writable.".into())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    #[test]
    fn appimage_environment_is_sanitized_only_on_the_child() {
        let mut command = Command::new("fixture");
        command.envs([
            ("APPDIR", "/tmp/installer"),
            ("APPIMAGE", "/downloads/installer.AppImage"),
            ("ARGV0", "installer"),
            ("OWD", "/downloads"),
            (
                "PATH",
                "/tmp/installer/usr/bin:/usr/bin:/tmp/installer-other/bin",
            ),
            ("LD_LIBRARY_PATH", "/tmp/installer/lib:/usr/lib"),
            ("XDG_DATA_DIRS", "/tmp/installer/share:/usr/share"),
            ("GSETTINGS_SCHEMA_DIR", "/tmp/installer/schemas"),
            ("GIO_EXTRA_MODULES", "/tmp/installer/gio"),
            ("GDK_PIXBUF_MODULE_FILE", "/tmp/installer/cache"),
            ("GTK_PATH", "/tmp/installer/gtk:/usr/lib/gtk"),
            ("GTK_THEME", "Adwaita"),
            ("KEEP", "/tmp/installer/unrelated"),
        ]);
        sanitize_appimage_env(&mut command);
        let env: std::collections::BTreeMap<_, _> = command.get_envs().collect();
        for name in [
            "APPDIR",
            "APPIMAGE",
            "ARGV0",
            "OWD",
            "GSETTINGS_SCHEMA_DIR",
            "GIO_EXTRA_MODULES",
            "GDK_PIXBUF_MODULE_FILE",
        ] {
            assert_eq!(env[std::ffi::OsStr::new(name)], None, "{name}");
        }
        for (name, value) in [
            ("PATH", "/usr/bin:/tmp/installer-other/bin"),
            ("LD_LIBRARY_PATH", "/usr/lib"),
            ("XDG_DATA_DIRS", "/usr/share"),
            ("GTK_PATH", "/usr/lib/gtk"),
            ("GTK_THEME", "Adwaita"),
            ("KEEP", "/tmp/installer/unrelated"),
        ] {
            assert_eq!(
                env[std::ffi::OsStr::new(name)],
                Some(std::ffi::OsStr::new(value))
            );
        }
        let mut plain = Command::new("fixture");
        plain
            .env_remove("APPDIR")
            .env("PATH", "/tmp/installer/bin:/usr/bin");
        sanitize_appimage_env(&mut plain);
        assert!(plain.get_envs().any(|(key, value)| key == "PATH"
            && value == Some(std::ffi::OsStr::new("/tmp/installer/bin:/usr/bin"))));
    }

    #[test]
    fn opt_override_uses_dpkg_query_ownership() {
        let root = tempfile::tempdir().unwrap();
        let opt = root.path().join(r"opt [?]*\");
        fs::create_dir_all(opt.join("Hexbot [alpha]")).unwrap();
        fs::create_dir(opt.join("Hexbot Client [alpha]")).unwrap();
        fs::create_dir(opt.join("Hexbot Nightly")).unwrap();
        fs::create_dir(opt.join("HexbotBackup")).unwrap();
        let paths = Paths {
            home: root.path().join("user"),
            hexbot_home: root.path().join("user/.hexbot"),
            apps_override: Some(root.path().join("apps")),
            opt_override: Some(opt.clone()),
            service_root: root.path().join("services"),
            service_no_load: true,
        };
        fs::create_dir(&paths.home).unwrap();
        fs::write(paths.home.join("owned"), "").unwrap();
        // dpkg-query -S matches a glob against the package file list.
        let query = root.path().join("dpkg-query");
        fs::write(
            &query,
            r#"#!/bin/sh
printf '%s\n' "$@" >> "$HOME/args"
[ "$1" = -S ] || exit 2
while IFS= read -r path; do
    case "$path" in $2) exit 0 ;; esac
done < "$HOME/owned"
exit 1
"#,
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&query, fs::Permissions::from_mode(0o755)).unwrap();
        let scan = || {
            dpkg_apps(paths.opt_override.as_ref().unwrap(), |path| {
                paths
                    .command(&query)
                    .arg("-S")
                    .arg(dpkg_pattern(path))
                    .output()
                    .unwrap()
                    .status
                    .success()
            })
        };
        assert!(scan().is_empty());
        fs::write(
            paths.home.join("owned"),
            format!(
                "{}/Hexbot [alpha]\n{}/Hexbot Client [alpha]\n",
                opt.display(),
                opt.display()
            ),
        )
        .unwrap();
        let apps = scan();
        assert_eq!(apps.len(), 2);
        for app in apps {
            assert!(
                app.path.ends_with("Hexbot [alpha]") || app.path.ends_with("Hexbot Client [alpha]")
            );
            assert!(app.managed_by_dpkg);
        }
        let args = fs::read_to_string(paths.home.join("args")).unwrap();
        assert!(
            args.lines()
                .any(|arg| arg.ends_with(r"opt \[\?\]\*\\/Hexbot \[alpha\]"))
        );
        assert_eq!(args.lines().filter(|arg| *arg == "-S").count(), 6);
    }

    #[test]
    fn opt_requires_an_exact_product_directory_and_package_ownership() {
        let root = tempfile::tempdir().unwrap();
        for name in [
            "Hexbot",
            "Hexbot [alpha]",
            "Hexbot Nightly",
            "Hexbot (dev)",
            "Hexbot Client",
            "Hexbot Client [alpha]",
            "Hexbot Client Nightly",
            "Hexbot Client (dev)",
            "HexbotBackup",
            "Hexbot Client-old",
            "Hexbot Installer",
        ] {
            fs::create_dir(root.path().join(name)).unwrap();
        }
        assert!(dpkg_apps(root.path(), |_| false).is_empty());
        let apps = dpkg_apps(root.path(), |path| {
            assert!(
                !["HexbotBackup", "Hexbot Client-old", "Hexbot Installer"]
                    .iter()
                    .any(|name| path.ends_with(name))
            );
            true
        });
        assert_eq!(apps.len(), 8);
        assert!(apps.iter().all(|app| app.managed_by_dpkg));
        fs::remove_dir(root.path().join("Hexbot")).unwrap();
        fs::write(root.path().join("Hexbot"), "not a directory").unwrap();
        assert_eq!(dpkg_apps(root.path(), |_| true).len(), 7);
    }

    #[test]
    fn app_destination_skips_unwritable_paths_without_creating_directories() {
        let root = tempfile::tempdir().unwrap();
        let blocked = root.path().join("blocked");
        fs::write(&blocked, "not a directory").unwrap();
        let fallback = root.path().join("user/Applications");
        if unsafe { libc::geteuid() } != 0 {
            use std::os::unix::fs::PermissionsExt;
            let readonly = root.path().join("Applications");
            fs::create_dir(&readonly).unwrap();
            fs::set_permissions(&readonly, fs::Permissions::from_mode(0o555)).unwrap();
            assert_eq!(
                choose_apps_dir(vec![readonly.clone(), fallback.clone()]).unwrap(),
                fallback
            );
            fs::set_permissions(readonly, fs::Permissions::from_mode(0o755)).unwrap();
        }
        assert_eq!(
            choose_apps_dir(vec![blocked, fallback.clone()]).unwrap(),
            fallback
        );
        assert!(!fallback.exists());
        let paths = Paths {
            home: root.path().join("user"),
            hexbot_home: root.path().join("user/.hexbot"),
            apps_override: Some(fallback.clone()),
            opt_override: None,
            service_root: root.path().into(),
            service_no_load: true,
        };
        assert_eq!(
            paths.planned_apps_dir(Target::MacosAarch64).unwrap(),
            fallback
        );
        assert!(!fallback.exists());
        assert_eq!(
            paths.install_apps_dir(Target::MacosAarch64).unwrap(),
            fallback
        );
        assert!(fallback.is_dir());
    }
}

#[cfg(test)]
mod windows_ownership_tests {
    use super::*;
    #[test]
    fn child_commands_keep_setup_and_cli_in_the_selected_user_profile() {
        let root = tempfile::tempdir().unwrap();
        let paths = Paths {
            home: root.path().join("Jos\u{e9} profile"),
            hexbot_home: root.path().join("selected state"),
            service_root: root.path().join("services"),
            service_no_load: true,
            apps_override: None,
            opt_override: None,
        };
        let command = paths.command("hexbot.exe");
        let env: std::collections::BTreeMap<_, _> = command.get_envs().collect();
        let value = |key: &str| env.get(std::ffi::OsStr::new(key)).copied().flatten();
        assert_eq!(value("HOME"), Some(paths.home.as_os_str()));
        assert_eq!(value("HEXBOT_HOME"), Some(paths.hexbot_home.as_os_str()));
        #[cfg(windows)]
        assert_eq!(value("USERPROFILE"), Some(paths.home.as_os_str()));
    }

    #[test]
    fn packaged_ownership_survives_an_absent_receipt_without_claiming_unrelated_apps() {
        let root = tempfile::tempdir().unwrap();
        let app = root.path().join("app.hexbot.client");
        fs::create_dir_all(app.join("resources")).unwrap();
        fs::write(app.join("HexbotClient.exe"), "unrelated exe").unwrap();
        fs::write(app.join("resources/app.asar"), "archive").unwrap();
        assert_eq!(windows_app_id(&app), None);
        for id in ["org.example.unrelated", "app.hexbot.desktop"] {
            fs::write(
                app.join(".hexbot-app.json"),
                serde_json::json!({"appId":id}).to_string(),
            )
            .unwrap();
            assert_eq!(windows_app_id(&app), None);
        }
        fs::write(
            app.join(".hexbot-app.json"),
            br#"{"appId":"app.hexbot.client"}"#,
        )
        .unwrap();
        assert_eq!(windows_app_id(&app).as_deref(), Some("app.hexbot.client"));
        fs::remove_file(app.join("resources/app.asar")).unwrap();
        assert_eq!(windows_app_id(&app), None);
    }
}
