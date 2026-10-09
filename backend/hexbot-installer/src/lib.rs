mod archive;
mod detect;
#[path = "../../hexbot-core/src/install_ownership.rs"]
mod install_ownership;
mod safety;
mod types;
#[path = "../../hexbot-core/src/update_signature.rs"]
pub mod update_signature;

pub use archive::{extract_native, verify_file};
pub use detect::{Paths, app_option, detect, detect_at, read_receipt, sanitize_appimage_env};
pub use types::*;

use reqwest::blocking::Client;
use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::Duration,
};

pub type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;
pub const DEFAULT_UPDATE_URL: &str = "https://updates.hexbot.app";
pub type ProgressCallback<'a> = dyn FnMut(Progress) + 'a;
const ICON: &[u8] = include_bytes!("../../../apps/desktop/build/icon.png");
const ICON_NIGHTLY: &[u8] = include_bytes!("../../../apps/desktop/resources/icon-nightly.png");
const ICON_DEV: &[u8] = include_bytes!("../../../apps/desktop/resources/icon-dev.png");

pub(crate) fn fail<T>(message: impl Into<String>) -> Result<T> {
    Err(message.into().into())
}

pub fn version() -> String {
    serde_json::from_str::<serde_json::Value>(include_str!("../../../apps/desktop/package.json"))
        .expect("valid desktop package")["version"]
        .as_str()
        .expect("desktop version")
        .into()
}

pub fn update_url() -> String {
    std::env::var("HEXBOT_UPDATE_URL").unwrap_or_else(|_| DEFAULT_UPDATE_URL.into())
}

fn client(base: &str) -> Result<Client> {
    let origin = reqwest::Url::parse(base)?.origin();
    Ok(Client::builder()
        .redirect(reqwest::redirect::Policy::custom(move |attempt| {
            if attempt.url().origin() != origin {
                attempt.error("Download redirect must stay on the update origin")
            } else if attempt.previous().len() >= 10 {
                attempt.error("Too many download redirects")
            } else {
                attempt.follow()
            }
        }))
        .connect_timeout(Duration::from_secs(30))
        .timeout(Duration::from_secs(3600))
        .user_agent(format!("hexbot-install/{}", version()))
        .build()?)
}

pub fn default_track(base: &str) -> Result<Track> {
    const ERROR: &str = "Could not reach the update server. Check your connection and try again.";
    https_origin(base)?;
    let response = client(base)?
        .get(format!(
            "{}/install/stable.json",
            base.trim_end_matches('/')
        ))
        .send()
        .map_err(|_| ERROR)?;
    match response.status() {
        reqwest::StatusCode::OK => Ok(Track::Stable),
        reqwest::StatusCode::NOT_FOUND => Ok(Track::Nightly),
        _ => fail(ERROR),
    }
}

/// The track's install manifest, after its release signature is checked. The
/// signature lives at the immutable `install/<version>/<track>.json.sig`, so
/// replacing `install/<track>.json` never races its signature.
pub fn fetch_manifest(base: &str, track: Track) -> Result<Manifest> {
    https_origin(base)?;
    let base = base.trim_end_matches('/');
    let client = client(base)?;
    let fetch = |url: String, limit: u64| -> Result<Vec<u8>> {
        let mut body = Vec::new();
        client
            .get(url)
            .send()?
            .error_for_status()?
            .take(limit + 1)
            .read_to_end(&mut body)?;
        if body.len() as u64 > limit {
            return fail("The install manifest is too large.");
        }
        Ok(body)
    };
    let bytes = fetch(format!("{base}/install/{track}.json"), 1024 * 1024)?;
    // Only the version is read before verification, to find the signature.
    let unverified: serde_json::Value = serde_json::from_slice(&bytes)?;
    let release = semver::Version::parse(unverified["version"].as_str().unwrap_or_default())?;
    let signature = fetch(
        format!("{base}/install/{release}/{track}.json.sig"),
        update_signature::SIGNATURE_LIMIT as u64,
    )?;
    if !update_signature::verify(&bytes, &signature) {
        return fail(update_signature::INVALID);
    }
    let manifest: Manifest = serde_json::from_slice(&bytes)?;
    manifest.validate(&version())?;
    validate_artifacts(base, &manifest)?;
    if manifest.channel != track {
        return fail("The install manifest has the wrong track.");
    }
    Ok(manifest)
}

/// HTTPS only; plain HTTP just for a loopback test server.
fn https_origin(base: &str) -> Result<reqwest::Url> {
    let url = reqwest::Url::parse(base)?;
    let loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if !(url.scheme() == "https" || url.scheme() == "http" && loopback)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return fail("The update URL must use HTTPS.");
    }
    Ok(url)
}

/// Resolve signed artifact paths against the selected update server.
fn artifact_url(base: &str, location: &str) -> Result<reqwest::Url> {
    let root = https_origin(&format!("{}/", base.trim_end_matches('/')))?;
    if location.trim().is_empty() {
        return fail("The install manifest names an invalid artifact.");
    }
    let url = root.join(location.trim())?;
    https_origin(url.as_str())?;
    if url.origin() != root.origin() {
        return fail("Every artifact URL must have the same origin as the update URL.");
    }
    Ok(url)
}

fn validate_artifacts(base: &str, manifest: &Manifest) -> Result<()> {
    for artifacts in manifest.targets.values() {
        for artifact in [
            &artifacts.headless,
            &artifacts.client,
            &artifacts.full,
            &artifacts.installer,
            &artifacts.installer_app,
        ]
        .into_iter()
        .flatten()
        {
            artifact_url(base, &artifact.url)?;
        }
    }
    Ok(())
}

fn done_message(option: InstallOption) -> String {
    format!("Hexbot {option} is installed.")
}

/// Blocking engine. Front ends can run it on a worker and forward progress events.
/// Configuration is captured once; callbacks and subprocess output never print here.
pub struct Installer {
    pub paths: Paths,
    pub target: Target,
    pub base_url: String,
}

impl Installer {
    pub fn from_env() -> Result<Self> {
        Ok(Self {
            paths: Paths::from_env()?,
            target: Target::detect()?,
            base_url: update_url(),
        })
    }

    pub fn detect(&self) -> Result<Installed> {
        detect_at(&self.paths, self.target)
    }

    pub fn apply(
        &self,
        option: InstallOption,
        track: Track,
        progress: &mut ProgressCallback<'_>,
    ) -> Result<InstallResult> {
        let manifest = fetch_manifest(&self.base_url, track)?;
        let result = self.install(option, &manifest, progress)?;
        self.write_receipt(&result.receipt)?;
        progress(Progress::new("done", done_message(option)));
        Ok(result)
    }

    pub fn repair(&self, progress: &mut ProgressCallback<'_>) -> Result<InstallResult> {
        let receipt = read_receipt(&self.paths.receipt())?
            .ok_or("No install receipt was found. Choose an option to install.")?;
        self.apply(receipt.option, receipt.channel, progress)
    }

    pub fn change(
        &self,
        from: InstallOption,
        to: InstallOption,
        track: Track,
        confirm: &mut dyn FnMut(&str) -> bool,
        progress: &mut ProgressCallback<'_>,
    ) -> Result<InstallResult> {
        if from == to {
            return self.apply(to, track, progress);
        }
        let installed = self.detect()?;
        let old_apps: Vec<_> = installed.apps.iter().filter(|a| a.option == from).collect();
        self.check_removable(&old_apps)?;
        self.preflight_home_removal()?;
        if !confirm(&format!(
            "Install Hexbot {to} and remove {from}? Your Hexbot data will be kept."
        )) {
            return fail("Change cancelled.");
        }
        let manifest = fetch_manifest(&self.base_url, track)?;
        let mut result = self.install(to, &manifest, progress)?;
        if to == InstallOption::Client && installed.service {
            self.remove_service(progress)?;
        }
        let _daemon_lock = if to == InstallOption::Client {
            self.stop_daemon()?
        } else {
            None
        };
        for app in old_apps {
            self.remove_app(app, progress)?;
        }
        // Headless -> Full intentionally retains the external daemon service.
        if to == InstallOption::Full && installed.service {
            result.status = self.status().ok();
        }
        self.write_receipt(&result.receipt)?;
        progress(Progress::new("done", done_message(to)));
        Ok(result)
    }

    pub fn uninstall(&self, remove_data: bool, progress: &mut ProgressCallback<'_>) -> Result<()> {
        if remove_data {
            self.validate_data_removal()?;
        }
        self.preflight_home_removal()?;
        let installed = self.detect()?;
        self.check_removable(&installed.apps.iter().collect::<Vec<_>>())?;
        if installed.service {
            self.remove_service(progress)?;
        }
        let _daemon_lock = self.stop_daemon()?;
        for app in &installed.apps {
            self.remove_app(app, progress)?;
        }
        if !self.target.is_macos() {
            for base in ["app.hexbot.desktop", "app.hexbot.client"] {
                for suffix in ["", ".nightly", ".dev"] {
                    self.remove_owned_path(
                        &self
                            .paths
                            .desktop_dir()
                            .join(format!("{base}{suffix}.desktop")),
                    )?;
                }
            }
        }
        // The runtimes are not user data; bots, memory and settings stay.
        self.remove_owned_path(&self.paths.executable())?;
        self.remove_owned_path(&self.paths.hexbot_home.join("runtime/native-current.json"))?;
        self.remove_owned_path(&self.paths.hexbot_home.join("runtime/native"))?;
        // `hexbot setup` marks the wrapper it writes; leave anyone else's `hexbot`.
        if install_ownership::wrapper_owned(&self.paths.wrapper(), &self.paths.hexbot_home) {
            self.remove_owned_path(&self.paths.wrapper())?;
        }
        self.remove_owned_path(&self.paths.receipt())?;
        if remove_data {
            self.remove_owned_path(&self.paths.hexbot_home)?;
        }
        progress(Progress::new(
            "done",
            if remove_data {
                "Hexbot and its data were removed."
            } else {
                "Hexbot was removed. Your Hexbot data was kept."
            },
        ));
        Ok(())
    }

    fn validate_data_removal(&self) -> Result<()> {
        if fs::symlink_metadata(&self.paths.hexbot_home)
            .is_ok_and(|meta| meta.file_type().is_symlink())
        {
            return fail(format!(
                "~/.hexbot is a link to {}. Delete that folder yourself if you want the data gone.",
                fs::read_link(&self.paths.hexbot_home)?.display()
            ));
        }
        self.paths.validate()?;
        if self.paths.hexbot_home.exists() {
            let data = self.paths.hexbot_home.canonicalize()?;
            let home = self.paths.home.canonicalize()?;
            if home.starts_with(data) {
                return fail("Refusing to remove HOME or one of its parent directories.");
            }
        }
        Ok(())
    }

    /// A signed manifest stays valid after the next release replaces it, so a
    /// replayed old one must not move an install back on its own track. A fresh
    /// install and a track change may install an older version.
    fn refuse_downgrade(&self, manifest: &Manifest) -> Result<()> {
        let Some(receipt) = read_receipt(&self.paths.receipt())? else {
            return Ok(());
        };
        if receipt.channel != manifest.channel {
            return Ok(());
        }
        let installed = semver::Version::parse(&receipt.version)?;
        let offered = semver::Version::parse(&manifest.version)?;
        if offered.cmp_precedence(&installed).is_lt() {
            return fail(format!(
                "The update server offers Hexbot {offered}, older than the installed {installed}. Nothing was installed."
            ));
        }
        Ok(())
    }

    fn write_receipt(&self, receipt: &Receipt) -> Result<()> {
        archive::write_atomic(&self.paths.receipt(), &serde_json::to_vec_pretty(receipt)?)
    }

    fn install(
        &self,
        option: InstallOption,
        manifest: &Manifest,
        progress: &mut ProgressCallback<'_>,
    ) -> Result<InstallResult> {
        self.paths.validate()?;
        manifest.validate(&version())?;
        validate_artifacts(&self.base_url, manifest)?;
        self.refuse_downgrade(manifest)?;
        if option == InstallOption::Headless {
            self.preflight_ownership()?;
        }
        let enable_lan = option == InstallOption::Headless
            && self.detect()?.option() != Some(InstallOption::Headless);
        let artifact = manifest.artifact(self.target, option)?;
        let identity = if option == InstallOption::Headless {
            None
        } else {
            Some(self.app_identity(artifact, option, manifest.channel)?)
        };
        let temp = tempfile::tempdir()?;
        let download = temp.path().join("download");
        download_file(&self.base_url, artifact, &download, progress)?;
        progress(Progress::new("verify", "Checking the download."));
        verify_file(&download, artifact, option)?;
        let mut warnings = Vec::new();
        let mut status = None;
        let paths = if option == InstallOption::Headless {
            if artifact.format.as_deref() != Some("tar.gz") {
                return fail("The native archive format is not supported.");
            }
            let runtime = self.paths.hexbot_home.join("runtime");
            fs::create_dir_all(&runtime)?;
            let staging = tempfile::tempdir_in(&runtime)?;
            let unpacked = staging.path().join("native");
            progress(Progress::new("extract", "Extracting the daemon."));
            extract_native(&download, &unpacked)?;
            let binary = unpacked.join("hexbot");
            self.run(&binary, &["setup", "--activate", "--json"], true, progress)?;
            if enable_lan {
                self.run(&self.paths.executable(), &["lan", "on"], false, progress)?;
                progress(Progress::new(
                    "lan",
                    "LAN access is on. Turn it off with: hexbot lan off. Direct LAN HTTP does not encrypt sign-ins or chat. Use Tailscale or HTTPS on untrusted networks.",
                ));
            }
            self.run(
                &self.paths.executable(),
                &["service", "install"],
                false,
                progress,
            )?;
            status = self.status().ok();
            if !self.target.is_macos()
                && !sandbox_available(status.as_ref(), || command_exists("bwrap"))
            {
                warnings.push("Bubblewrap is missing or unusable. Auto mode needs it for the sandbox. For installation and the Ubuntu 24.04 AppArmor fix, see https://hexbot.app/docs/install/#linux.".into());
            }
            vec![
                self.paths.executable(),
                self.paths.service_file(self.target),
                self.paths.wrapper(),
            ]
        } else if self.target.is_macos() {
            self.install_macos(
                &download,
                artifact,
                identity.unwrap(),
                temp.path(),
                &mut warnings,
                progress,
            )?
        } else {
            self.install_linux(&download, artifact, identity.unwrap(), progress)?
        };
        for warning in &warnings {
            progress(Progress::new("warning", warning));
        }
        Ok(InstallResult {
            receipt: Receipt {
                option,
                channel: manifest.channel,
                version: manifest.version.clone(),
                paths,
                installed_at: chrono::Utc::now().to_rfc3339(),
            },
            status,
            warnings,
        })
    }

    fn app_identity<'a>(
        &self,
        artifact: &'a Artifact,
        option: InstallOption,
        track: Track,
    ) -> Result<(&'a str, &'a str)> {
        let id = artifact
            .app_id
            .as_deref()
            .ok_or("The app id is missing from the manifest.")?;
        if app_option(id) != Some(option) {
            return fail("The app id does not match the selected option.");
        }
        let suffix = if track == Track::Nightly {
            ".nightly"
        } else {
            ""
        };
        let base = if option == InstallOption::Full {
            "app.hexbot.desktop"
        } else {
            "app.hexbot.client"
        };
        if id != format!("{base}{suffix}") {
            return fail("The app id does not match the selected track.");
        }
        let name = artifact
            .product_name
            .as_deref()
            .ok_or("The app name is missing from the manifest.")?;
        if name.is_empty() || name.contains(['/', '\\', '\n', '\r']) || name == "." || name == ".."
        {
            return fail("The manifest contains an invalid app name.");
        }
        Ok((id, name))
    }

    fn install_macos(
        &self,
        download: &Path,
        artifact: &Artifact,
        (id, name): (&str, &str),
        temp: &Path,
        warnings: &mut Vec<String>,
        progress: &mut ProgressCallback<'_>,
    ) -> Result<Vec<PathBuf>> {
        if artifact.format.as_deref() != Some("zip") {
            return fail("The app archive format is not supported.");
        }
        let unpacked = temp.join("app");
        progress(Progress::new("extract", "Extracting the app."));
        let output = self
            .paths
            .command("/usr/bin/ditto")
            .args(["-x", "-k"])
            .arg(download)
            .arg(&unpacked)
            .output()?;
        check_output(output)?;
        let bundles: Vec<_> = fs::read_dir(&unpacked)?
            .collect::<std::io::Result<Vec<_>>>()?
            .into_iter()
            .map(|e| e.path())
            .filter(|p| {
                p.extension().is_some_and(|e| e == "app")
                    && detect::plist_value(p, "CFBundleIdentifier").as_deref() == Some(id)
            })
            .collect();
        if bundles.len() != 1 {
            return fail("The archive must contain one app with the expected app id.");
        }
        let directory = self.paths.install_apps_dir(self.target)?;
        let destination = directory.join(format!("{name}.app"));
        recover_previous_app(&directory, &destination, id)?;
        if destination.exists()
            && detect::plist_value(&destination, "CFBundleIdentifier").as_deref() != Some(id)
        {
            return fail("An unrelated app already uses the install path.");
        }
        let previous: Vec<_> = self
            .detect()?
            .apps
            .into_iter()
            .filter(|a| a.app_id == id)
            .collect();
        for app in previous.iter().map(|a| &a.path).chain([&destination]) {
            self.require_quit(app)?;
        }
        let previous = removable_previous_apps(previous, &destination, warnings);
        // Stage on the destination volume before touching any installed bundle.
        let staging = tempfile::tempdir_in(&directory)?;
        let staged = staging.path().join("new.app");
        check_output(
            self.paths
                .command("/usr/bin/ditto")
                .arg(&bundles[0])
                .arg(&staged)
                .output()?,
        )?;
        progress(Progress::new("install", "Installing the app."));
        let backup = staging.path().join("previous.app");
        let had_previous = destination.exists();
        if had_previous {
            fs::rename(&destination, &backup)?;
        }
        if let Err(error) = fs::rename(&staged, &destination) {
            if had_previous {
                fs::rename(&backup, &destination)?;
            }
            return Err(error.into());
        }
        for app in previous {
            if app.path != destination {
                self.remove_owned_path(&app.path)?;
            }
        }
        Ok(vec![destination])
    }

    fn install_linux(
        &self,
        download: &Path,
        artifact: &Artifact,
        (id, name): (&str, &str),
        progress: &mut ProgressCallback<'_>,
    ) -> Result<Vec<PathBuf>> {
        if artifact.format.as_deref() != Some("AppImage") {
            return fail("The app archive format is not supported.");
        }
        let directory = self.paths.install_apps_dir(self.target)?;
        let destination = directory.join(format!("{id}.AppImage"));
        let previous: Vec<_> = self
            .detect()?
            .apps
            .into_iter()
            .filter(|a| a.app_id == id)
            .collect();
        self.check_removable(&previous.iter().collect::<Vec<_>>())?;
        self.require_quit(&destination)?;
        if fs::symlink_metadata(&destination).is_ok_and(|m| !m.is_file()) {
            return fail("The app destination is not a regular file.");
        }
        progress(Progress::new("install", "Installing the app."));
        let staged = tempfile::NamedTempFile::new_in(&directory)?;
        fs::copy(download, staged.path())?;
        executable(staged.path())?;
        staged.persist(&destination)?;
        let icon = directory.join(format!("{id}.png"));
        archive::write_atomic(
            &icon,
            match id.rsplit('.').next() {
                Some("nightly") => ICON_NIGHTLY,
                Some("dev") => ICON_DEV,
                _ => ICON,
            },
        )?;
        let desktop = self.paths.desktop_dir().join(format!("{id}.desktop"));
        let executable_path = desktop_exec(&destination)?;
        // The scheme handler lets hexbot:// pairing links open the app, as the deb does.
        let entry = format!(
            "[Desktop Entry]\nType=Application\nName={}\nExec={executable_path} %U\nIcon={}\nTerminal=false\nCategories=Utility;\nMimeType=x-scheme-handler/hexbot;\n",
            name.replace('\\', "\\\\"),
            icon.display()
        );
        archive::write_atomic(&desktop, entry.as_bytes())?;
        for (command, args) in [
            (
                "update-desktop-database",
                vec![self.paths.desktop_dir().into_os_string()],
            ),
            (
                "xdg-mime",
                vec![
                    "default".into(),
                    format!("{id}.desktop").into(),
                    "x-scheme-handler/hexbot".into(),
                ],
            ),
        ] {
            if command_exists(command) {
                let _ = self.paths.command(command).args(args).output();
            }
        }
        for app in previous {
            if app.path != destination {
                self.remove_owned_path(&app.path)?;
            }
        }
        Ok(vec![destination, desktop, icon])
    }

    fn status(&self) -> Result<serde_json::Value> {
        let output = self
            .paths
            .command(self.paths.executable())
            .args(["status", "--json"])
            .output()?;
        let bytes = check_output(output)?;
        Ok(serde_json::from_slice(&bytes)?)
    }

    fn run(
        &self,
        executable: &Path,
        args: &[&str],
        json: bool,
        progress: &mut ProgressCallback<'_>,
    ) -> Result<()> {
        let stderr = tempfile::tempfile()?;
        let mut child = self
            .paths
            .command(executable)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(stderr.try_clone()?)
            .spawn()?;
        let output = child.stdout.take().ok_or("Could not read daemon output.")?;
        let mut last_error = None;
        let read_result: Result<()> = (|| {
            for line in BufReader::new(output).lines() {
                let line = line?;
                if json {
                    let value: serde_json::Value = serde_json::from_str(&line)?;
                    if value["stage"] == "error" {
                        last_error = value["message"].as_str().map(str::to_owned);
                    }
                    progress(Progress::new(
                        value["stage"].as_str().unwrap_or("setup"),
                        value["message"].as_str().unwrap_or(&line),
                    ));
                } else if !line.is_empty() {
                    progress(Progress::new("service", line));
                }
            }
            Ok(())
        })();
        if read_result.is_err() {
            let _ = child.kill();
        }
        let status = child.wait()?;
        read_result?;
        let mut errors = String::new();
        use std::io::{Seek, SeekFrom};
        let mut stderr = stderr;
        stderr.seek(SeekFrom::Start(0))?;
        stderr.read_to_string(&mut errors)?;
        if !status.success() {
            return fail(format!(
                "hexbot {} failed: {}",
                args.join(" "),
                last_error.as_deref().unwrap_or_else(|| errors.trim())
            ));
        }
        if !errors.trim().is_empty() {
            progress(Progress::new("warning", errors.trim()));
        }
        Ok(())
    }

    fn check_removable(&self, apps: &[&InstalledApp]) -> Result<()> {
        for app in apps {
            self.require_quit(&app.path)?;
        }
        if apps.iter().any(|a| a.managed_by_dpkg) {
            return fail(
                "Hexbot was installed with a package manager. Remove it with sudo apt remove hexbot, then run this installer again. Your Hexbot data will be kept.",
            );
        }
        Ok(())
    }

    fn remove_app(&self, app: &InstalledApp, progress: &mut ProgressCallback<'_>) -> Result<()> {
        self.require_quit(&app.path)?;
        progress(Progress::new(
            "remove",
            format!("Removing {}.", app.path.display()),
        ));
        self.remove_owned_path(&app.path)?;
        if !self.target.is_macos() {
            if app
                .path
                .file_stem()
                .is_some_and(|stem| stem == app.app_id.as_str())
            {
                self.remove_owned_path(&app.path.with_extension("png"))?;
            }
            self.remove_owned_path(
                &self
                    .paths
                    .desktop_dir()
                    .join(format!("{}.desktop", app.app_id)),
            )?;
        }
        Ok(())
    }

    // Replacing or deleting an app while it runs breaks it mid-session.
    fn require_quit(&self, app: &Path) -> Result<()> {
        if !self.target.is_macos() && safety::appimage_running(Path::new("/proc"), app)? {
            return fail(format!(
                "Quit {}, then run the installer again.",
                app.display()
            ));
        }
        let probe = if self.target.is_macos() {
            format!("{}/Contents/MacOS/", app.display())
        } else {
            app.display().to_string()
        };
        let Ok(output) = Command::new("ps").args(["-A", "-o", "command="]).output() else {
            return Ok(());
        };
        if String::from_utf8_lossy(&output.stdout)
            .lines()
            .any(|line| line.trim_start().starts_with(&probe))
        {
            let name = app.file_stem().unwrap_or_default().to_string_lossy();
            return fail(format!("Quit {name}, then run the installer again."));
        }
        Ok(())
    }
}

fn download_file(
    base: &str,
    artifact: &Artifact,
    path: &Path,
    progress: &mut ProgressCallback<'_>,
) -> Result<()> {
    let mut response = client(base)?
        .get(artifact_url(base, &artifact.url)?)
        .send()?
        .error_for_status()?;
    let mut file = fs::File::create(path)?;
    let mut downloaded = 0;
    progress(Progress {
        stage: "download".into(),
        message: "Downloading Hexbot.".into(),
        downloaded: Some(0),
        total: Some(artifact.size),
    });
    let mut buffer = [0; 64 * 1024];
    loop {
        let size = response.read(&mut buffer)?;
        if size == 0 {
            break;
        }
        downloaded += size as u64;
        if downloaded > artifact.size {
            return fail("The download is larger than the manifest size.");
        }
        file.write_all(&buffer[..size])?;
        progress(Progress {
            stage: "download".into(),
            message: "Downloading Hexbot.".into(),
            downloaded: Some(downloaded),
            total: Some(artifact.size),
        });
    }
    if downloaded != artifact.size {
        return fail("The download size does not match the manifest.");
    }
    Ok(())
}

fn check_output(output: std::process::Output) -> Result<Vec<u8>> {
    if !output.status.success() {
        return fail(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(output.stdout)
}

fn remove_path(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() => fs::remove_dir_all(path)?,
        Ok(_) => fs::remove_file(path)?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.into()),
    }
    Ok(())
}

fn executable(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o755))?;
    }
    Ok(())
}

fn sandbox_available(status: Option<&serde_json::Value>, on_path: impl FnOnce() -> bool) -> bool {
    status.map_or_else(on_path, |status| status["sandbox_available"] != false)
}

fn command_exists(name: &str) -> bool {
    std::env::var_os("PATH")
        .is_some_and(|paths| std::env::split_paths(&paths).any(|p| p.join(name).is_file()))
}

fn desktop_exec(path: &Path) -> Result<String> {
    let path = path.to_str().ok_or("The app path is not valid UTF-8.")?;
    if path.contains(['\n', '\r']) {
        return fail("The app path contains a newline.");
    }
    // Exec has its own quoting on top of the desktop-entry string escapes.
    let escaped = path
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('`', "\\`")
        .replace('$', "\\$")
        .replace('%', "%%");
    Ok(format!("\"{}\"", escaped.replace('\\', "\\\\")))
}

fn removable_previous_apps(
    previous: Vec<InstalledApp>,
    destination: &Path,
    warnings: &mut Vec<String>,
) -> Vec<InstalledApp> {
    previous
        .into_iter()
        .filter(|app| {
            if app.path == destination {
                return false;
            }
            let parent = app.path.parent().expect("app has a parent");
            if detect::writable_directory(parent) {
                true
            } else {
                warnings.push(format!(
                    "An older copy stays in {}. Remove it in Finder.",
                    parent.display()
                ));
                false
            }
        })
        .collect()
}

// A killed installer may leave the previous bundle in its staging directory.
fn recover_previous_app(directory: &Path, destination: &Path, id: &str) -> Result<()> {
    if fs::symlink_metadata(destination).is_ok() {
        return Ok(());
    }
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        if !entry.file_name().to_string_lossy().starts_with(".tmp") || !entry.file_type()?.is_dir()
        {
            continue;
        }
        let previous = entry.path().join("previous.app");
        if fs::symlink_metadata(&previous).is_ok_and(|m| m.is_dir())
            && detect::plist_value(&previous, "CFBundleIdentifier").as_deref() == Some(id)
        {
            fs::rename(previous, destination)?;
            break;
        }
    }
    Ok(())
}

#[cfg(all(test, target_os = "macos"))]
mod recovery_tests {
    use super::*;
    fn bundle(path: &Path, id: &str) {
        fs::create_dir_all(path.join("Contents")).unwrap();
        fs::write(path.join("Contents/Info.plist"), format!("<plist version=\"1.0\"><dict><key>CFBundleIdentifier</key><string>{id}</string></dict></plist>")).unwrap();
    }
    #[test]
    fn superseded_apps_in_unwritable_directories_are_kept_with_a_warning() {
        use std::os::unix::fs::PermissionsExt;
        if unsafe { libc::geteuid() } == 0 {
            return;
        }
        let root = tempfile::tempdir().unwrap();
        let blocked = root.path().join("Applications");
        let app = blocked.join("Hexbot.app");
        bundle(&app, "app.hexbot.desktop");
        fs::set_permissions(&blocked, fs::Permissions::from_mode(0o555)).unwrap();
        let mut warnings = Vec::new();
        let removable = removable_previous_apps(
            vec![InstalledApp {
                path: app.clone(),
                option: InstallOption::Full,
                app_id: "app.hexbot.desktop".into(),
                version: None,
                managed_by_dpkg: false,
            }],
            &root.path().join("user/Applications/Hexbot.app"),
            &mut warnings,
        );
        assert!(removable.is_empty());
        assert!(app.exists());
        assert_eq!(
            warnings,
            [format!(
                "An older copy stays in {}. Remove it in Finder.",
                blocked.display()
            )]
        );
        fs::set_permissions(blocked, fs::Permissions::from_mode(0o755)).unwrap();
    }
    #[test]
    fn restores_stranded_app_only_when_destination_is_missing() {
        let root = tempfile::tempdir().unwrap();
        let previous = root.path().join(".tmpInterrupted/previous.app");
        let unrelated = root.path().join(".tmpOther/previous.app");
        let destination = root.path().join("Hexbot.app");
        bundle(&previous, "app.hexbot.desktop");
        bundle(&unrelated, "org.example.other");
        bundle(&destination, "app.hexbot.desktop");
        fs::write(destination.join("keep"), "current").unwrap();
        recover_previous_app(root.path(), &destination, "app.hexbot.desktop").unwrap();
        assert!(destination.join("keep").exists());
        assert!(previous.exists());
        fs::remove_dir_all(&destination).unwrap();
        recover_previous_app(root.path(), &destination, "app.hexbot.desktop").unwrap();
        assert!(destination.exists());
        assert!(!previous.exists());
        assert!(unrelated.exists());
    }
}

#[cfg(test)]
mod sandbox_tests {
    use super::*;

    #[test]
    fn daemon_sandbox_probe_takes_precedence_over_bwrap_on_path() {
        for available in [false, true] {
            let status = serde_json::json!({"sandbox_available": available});
            assert_eq!(
                sandbox_available(Some(&status), || panic!("status is available")),
                available
            );
            assert_eq!(sandbox_available(None, || available), available);
        }
    }
}
