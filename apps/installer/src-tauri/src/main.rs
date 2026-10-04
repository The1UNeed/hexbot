//! Hexbot Installer: a window over the `hexbot-installer` engine, which the
//! terminal installer drives too. Engine calls block, so each one runs on a
//! worker thread and streams `Progress` to the page over a channel. The page
//! asks every question itself before it calls in, so confirmations here
//! always answer yes.

mod platform;

use hexbot_installer::{
    InstallOption, InstallResult, Installer, Paths, Progress, Target, Track, read_receipt,
};
use serde::Serialize;
use std::{
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};
use tauri::{AppHandle, Manager, State, ipc::Channel};

type CommandResult<T> = Result<T, String>;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Detection {
    installer_version: String,
    /// `os/arch`, shown when this computer is not supported.
    platform: String,
    /// `None` when Hexbot has no build for this computer.
    target: Option<Target>,
    locations: Option<Locations>,
    installed: Option<InstalledView>,
    daemon_files: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Locations {
    home: PathBuf,
    hexbot_home: PathBuf,
    apps: PathBuf,
    cli: PathBuf,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct InstalledView {
    option: InstallOption,
    track: Option<Track>,
    version: Option<String>,
    service: bool,
    apps: Vec<hexbot_installer::InstalledApp>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Offer {
    size: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ManifestView {
    track: Track,
    version: String,
    headless: Option<Offer>,
    client: Option<Offer>,
    full: Option<Offer>,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct Pairing {
    code: String,
    expires: String,
    address: String,
    link: String,
}

/// One install, change, or uninstall at a time.
#[derive(Default)]
struct Busy(AtomicBool);

struct Claim<'a>(&'a AtomicBool);

impl Busy {
    fn is_busy(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }

    fn claim(&self) -> CommandResult<Claim<'_>> {
        if self.0.swap(true, Ordering::SeqCst) {
            return Err("The installer is already working.".into());
        }
        Ok(Claim(&self.0))
    }
}

impl Drop for Claim<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> hexbot_installer::Result<T> + Send + 'static,
) -> CommandResult<T> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())
}

/// Download progress arrives every 64 KB; the page only needs a step per half percent.
fn forward(channel: Channel<Progress>) -> impl FnMut(Progress) {
    let mut last = None;
    move |event: Progress| {
        if let (Some(done), Some(total)) = (event.downloaded, event.total) {
            let step = done.saturating_mul(200).checked_div(total).unwrap_or(0);
            if last == Some(step) {
                return;
            }
            last = Some(step);
        }
        let _ = channel.send(event);
    }
}

fn detection() -> hexbot_installer::Result<Detection> {
    let platform = format!("{}/{}", std::env::consts::OS, std::env::consts::ARCH);
    let Ok(target) = Target::detect() else {
        return Ok(Detection {
            installer_version: hexbot_installer::version(),
            platform,
            target: None,
            locations: None,
            installed: None,
            daemon_files: false,
        });
    };
    let engine = Installer::from_env()?;
    let installed = engine.detect()?;
    let paths = &engine.paths;
    Ok(Detection {
        installer_version: hexbot_installer::version(),
        platform,
        target: Some(target),
        locations: Some(Locations {
            home: paths.home.clone(),
            hexbot_home: paths.hexbot_home.clone(),
            apps: paths.planned_apps_dir(target)?,
            cli: paths.wrapper(),
        }),
        daemon_files: installed.runtime,
        installed: installed.option().map(|option| InstalledView {
            option,
            track: installed.track(),
            version: installed
                .receipt
                .as_ref()
                .map(|r| r.version.clone())
                .or_else(|| installed.apps.iter().find_map(|a| a.version.clone())),
            service: installed.service,
            apps: installed.apps.clone(),
        }),
    })
}

#[tauri::command]
async fn detect() -> CommandResult<Detection> {
    blocking(detection).await
}

#[tauri::command]
async fn default_track() -> CommandResult<Track> {
    blocking(|| {
        initial_track(&hexbot_installer::version(), || {
            hexbot_installer::default_track(&hexbot_installer::update_url())
        })
    })
    .await
}

fn initial_track(
    version: &str,
    probe: impl FnOnce() -> hexbot_installer::Result<Track>,
) -> hexbot_installer::Result<Track> {
    if version.contains("-nightly.") {
        Ok(Track::Nightly)
    } else {
        probe()
    }
}

#[tauri::command]
async fn fetch_manifest(track: Track) -> CommandResult<ManifestView> {
    blocking(move || {
        let target = Target::detect()?;
        let manifest =
            match hexbot_installer::fetch_manifest(&hexbot_installer::update_url(), track) {
                Err(error) if error.to_string().contains("(404 Not Found)") => {
                    let name = if track == Track::Stable {
                        "Stable"
                    } else {
                        "Nightly"
                    };
                    return Err(format!("No {name} release is published yet.").into());
                }
                result => result?,
            };
        let offer = |option| {
            manifest
                .artifact(target, option)
                .ok()
                .map(|artifact| Offer {
                    size: artifact.size,
                })
        };
        Ok(ManifestView {
            track: manifest.channel,
            version: manifest.version.clone(),
            headless: offer(InstallOption::Headless),
            client: offer(InstallOption::Client),
            full: offer(InstallOption::Full),
        })
    })
    .await
}

#[tauri::command]
async fn apply(
    busy: State<'_, Busy>,
    option: InstallOption,
    track: Track,
    on_progress: Channel<Progress>,
) -> CommandResult<InstallResult> {
    let _claim = busy.claim()?;
    blocking(move || Installer::from_env()?.apply(option, track, &mut forward(on_progress))).await
}

#[tauri::command]
async fn change(
    busy: State<'_, Busy>,
    from: InstallOption,
    to: InstallOption,
    track: Track,
    on_progress: Channel<Progress>,
) -> CommandResult<InstallResult> {
    let _claim = busy.claim()?;
    blocking(move || {
        Installer::from_env()?.change(from, to, track, &mut |_| true, &mut forward(on_progress))
    })
    .await
}

/// Update or repair: the installed option again, from its own track. Installs
/// found without a receipt (older packages) take the same path as the terminal.
#[tauri::command]
async fn repair(
    busy: State<'_, Busy>,
    on_progress: Channel<Progress>,
) -> CommandResult<InstallResult> {
    let _claim = busy.claim()?;
    blocking(move || {
        let engine = Installer::from_env()?;
        let mut progress = forward(on_progress);
        let installed = engine.detect()?;
        if installed.receipt.is_some() {
            return engine.repair(&mut progress);
        }
        let option = installed.option().ok_or("Hexbot is not installed.")?;
        let track = match installed.track() {
            Some(track) => track,
            None => hexbot_installer::default_track(&engine.base_url)?,
        };
        engine.apply(option, track, &mut progress)
    })
    .await
}

#[tauri::command]
async fn uninstall(
    busy: State<'_, Busy>,
    remove_data: bool,
    on_progress: Channel<Progress>,
) -> CommandResult<()> {
    let _claim = busy.claim()?;
    blocking(move || Installer::from_env()?.uninstall(remove_data, &mut forward(on_progress))).await
}

/// Runs the installed daemon CLI with the same environment the engine gives it.
fn daemon(paths: &Paths, args: &[&str]) -> hexbot_installer::Result<String> {
    let output = daemon_command(paths, args).output()?;
    if !output.status.success() {
        let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if message.is_empty() {
            format!("hexbot {} failed.", args.join(" "))
        } else {
            message
        }
        .into());
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn daemon_command(paths: &Paths, args: &[&str]) -> std::process::Command {
    let mut command = std::process::Command::new(paths.executable());
    command
        .args(args)
        .env("HOME", &paths.home)
        .env("HEXBOT_HOME", &paths.hexbot_home)
        .env("HEXBOT_SERVICE_ROOT", &paths.service_root)
        .env(
            "HEXBOT_SERVICE_NO_LOAD",
            if paths.service_no_load { "1" } else { "0" },
        )
        .stdin(std::process::Stdio::null());
    hexbot_installer::sanitize_appimage_env(&mut command);
    command
}

#[tauri::command]
async fn status() -> CommandResult<serde_json::Value> {
    blocking(|| {
        let paths = Paths::from_env()?;
        Ok(serde_json::from_str(&daemon(
            &paths,
            &["status", "--json"],
        )?)?)
    })
    .await
}

/// Reads the text `hexbot pair` prints (backend/hexbot-core/src/daemon.rs).
fn parse_pairing(output: &str) -> Option<Pairing> {
    let field = |name: &str| {
        output
            .lines()
            .find_map(|line| line.strip_prefix(name))
            .map(|value| value.trim().to_string())
    };
    let pairing = Pairing {
        code: field("Pairing code:")?,
        expires: field("Expires in:").unwrap_or_default(),
        address: field("Addresses:").unwrap_or_default(),
        link: field("Link:")?,
    };
    (!pairing.code.is_empty() && pairing.link.starts_with("hexbot://pair?")).then_some(pairing)
}

#[tauri::command]
async fn show_pairing() -> CommandResult<Pairing> {
    blocking(|| {
        let paths = Paths::from_env()?;
        let output = daemon(&paths, &["pair"])?;
        Ok(parse_pairing(&output).ok_or("The daemon did not print a pairing code.")?)
    })
    .await
}

/// Opens an app this installer put in place, then closes the installer.
#[tauri::command]
async fn open_app(app: AppHandle, path: PathBuf) -> CommandResult<()> {
    blocking(move || {
        let paths = Paths::from_env()?;
        let receipt = read_receipt(&paths.receipt())?.ok_or("Hexbot is not installed.")?;
        if !receipt.paths.contains(&path) || !is_app(&path) {
            return Err("That is not an app this installer installed.".into());
        }
        platform::open(&path)
    })
    .await?;
    app.exit(0);
    Ok(())
}

fn is_app(path: &Path) -> bool {
    path.extension()
        .is_some_and(|extension| extension == "app" || extension == "AppImage")
}

#[tauri::command]
fn quit(app: AppHandle) {
    app.exit(0);
}

fn main() {
    platform::prepare_environment();
    tauri::Builder::default()
        .manage(Busy::default())
        .invoke_handler(tauri::generate_handler![
            detect,
            default_track,
            fetch_manifest,
            apply,
            change,
            repair,
            uninstall,
            status,
            show_pairing,
            open_app,
            quit
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event
                && window.state::<Busy>().is_busy()
            {
                api.prevent_close();
            }
        })
        .build(tauri::generate_context!())
        .expect("Hexbot Installer could not start")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event
                && app.state::<Busy>().is_busy()
            {
                api.prevent_exit();
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initial_track_follows_the_installer_version_or_the_probe() {
        assert_eq!(
            initial_track("0.1.5-nightly.20261004.1", || panic!("must not probe")).unwrap(),
            Track::Nightly
        );
        for version in ["0.1.5", "0.1.5-alpha.1"] {
            for published in [Track::Stable, Track::Nightly] {
                assert_eq!(initial_track(version, || Ok(published)).unwrap(), published);
            }
            assert!(initial_track(version, || Err("probe failed".into())).is_err());
        }
    }

    #[test]
    fn daemon_commands_clean_the_appimage_environment() {
        // Put the inherited environment in a subprocess, not the parallel test runner.
        const CHILD: &str = "HEXBOT_TEST_APPIMAGE_CHILD";
        if std::env::var_os(CHILD).is_none() {
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "tests::daemon_commands_clean_the_appimage_environment",
                ])
                .env(CHILD, "1")
                .env("APPDIR", "/tmp/installer-appimage")
                .env("APPIMAGE", "/tmp/installer.AppImage")
                .env(
                    "LD_LIBRARY_PATH",
                    "/tmp/installer-appimage/usr/lib:/usr/lib",
                )
                .env("GIO_MODULE_DIR", "/tmp/installer-appimage/usr/lib/gio")
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stdout)
            );
            return;
        }
        let paths = Paths {
            home: "/tmp/hexbot-test/home".into(),
            hexbot_home: "/tmp/hexbot-test/state".into(),
            service_root: "/tmp/hexbot-test/services".into(),
            service_no_load: true,
            apps_override: None,
            opt_override: None,
        };
        for args in [&["status", "--json"][..], &["pair"][..]] {
            let command = daemon_command(&paths, args);
            let env: std::collections::BTreeMap<_, _> = command.get_envs().collect();
            let value = |key: &str| env.get(std::ffi::OsStr::new(key)).copied().flatten();
            for key in ["APPDIR", "APPIMAGE", "GIO_MODULE_DIR"] {
                assert_eq!(env.get(std::ffi::OsStr::new(key)), Some(&None));
            }
            assert_eq!(
                value("LD_LIBRARY_PATH"),
                Some(std::ffi::OsStr::new("/usr/lib"))
            );
            assert_eq!(value("HOME"), Some(paths.home.as_os_str()));
            assert_eq!(value("HEXBOT_HOME"), Some(paths.hexbot_home.as_os_str()));
            assert_eq!(
                value("HEXBOT_SERVICE_ROOT"),
                Some(paths.service_root.as_os_str())
            );
            assert_eq!(
                value("HEXBOT_SERVICE_NO_LOAD"),
                Some(std::ffi::OsStr::new("1"))
            );
            assert_eq!(command.get_program(), paths.executable());
            assert_eq!(command.get_args().collect::<Vec<_>>(), args);
        }
        assert_eq!(std::env::var("APPDIR").unwrap(), "/tmp/installer-appimage");
    }

    #[test]
    fn detection_exposes_package_ownership_for_each_app() {
        let installed = InstalledView {
            option: InstallOption::Full,
            track: None,
            version: None,
            service: false,
            apps: vec![hexbot_installer::InstalledApp {
                path: "/opt/Hexbot".into(),
                option: InstallOption::Full,
                app_id: "app.hexbot.desktop".into(),
                version: None,
                managed_by_dpkg: true,
            }],
        };
        let json = serde_json::to_value(installed).unwrap();
        assert_eq!(json["apps"][0]["path"], "/opt/Hexbot");
        assert_eq!(json["apps"][0]["managed_by_dpkg"], true);
    }

    #[test]
    fn busy_blocks_close_and_exit_until_the_job_finishes() {
        let busy = Busy::default();
        assert!(!busy.is_busy());
        let claim = busy.claim().unwrap();
        assert!(busy.is_busy());
        assert!(busy.claim().is_err());
        assert!(busy.is_busy());
        drop(claim);
        assert!(!busy.is_busy());
        assert!(busy.claim().is_ok());
    }

    #[test]
    fn reads_the_pairing_output() {
        let output = "Pairing code: 7KQ2-M9XD\nExpires in: 10 minutes\nAddresses: 192.168.1.24:9119\nLink: hexbot://pair?host=192.168.1.24&port=9119#code=7KQ2-M9XD\n█▀▀▀▀▀█ ▄ █\n";
        assert_eq!(
            parse_pairing(output),
            Some(Pairing {
                code: "7KQ2-M9XD".into(),
                expires: "10 minutes".into(),
                address: "192.168.1.24:9119".into(),
                link: "hexbot://pair?host=192.168.1.24&port=9119#code=7KQ2-M9XD".into(),
            })
        );
        assert_eq!(
            parse_pairing("Pairing code: \nLink: https://example.com"),
            None
        );
    }

    #[test]
    fn opens_only_app_bundles() {
        assert!(is_app(Path::new("/Applications/Hexbot [alpha].app")));
        assert!(is_app(Path::new(
            "/home/a/.local/share/hexbot/app.hexbot.client.AppImage"
        )));
        assert!(!is_app(Path::new(
            "/home/a/.local/share/applications/app.hexbot.client.desktop"
        )));
    }

    #[test]
    fn download_progress_is_thinned() {
        let progress = |downloaded| Progress {
            stage: "download".into(),
            message: "Downloading Hexbot.".into(),
            downloaded: Some(downloaded),
            total: Some(1_000_000),
        };
        let (channel, received) = {
            let received = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
            let sink = received.clone();
            (
                Channel::new(move |body| {
                    sink.lock().unwrap().push(body);
                    Ok(())
                }),
                received,
            )
        };
        let mut send = forward(channel);
        for downloaded in (0..=1_000_000).step_by(64 * 1024) {
            send(progress(downloaded));
        }
        send(progress(1_000_000));
        send(Progress::new("verify", "Checking the download."));
        // 16 chunks, each a new half-percent step, then the last chunk and verify.
        assert_eq!(received.lock().unwrap().len(), 18);
    }
}
