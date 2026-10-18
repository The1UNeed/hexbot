//! Per-user NSIS packages retain the registry entries and uninstaller that
//! Electron's updater needs. The engine never extracts a Windows app over a
//! live executable or tries to reproduce NSIS bookkeeping.
use crate::{
    Artifact, InstalledApp, Installer, Progress, ProgressCallback, Result, app_option, fail,
};
use std::{
    fs,
    path::{Path, PathBuf},
};

const EXECUTABLE: &str = "Hexbot.exe";

pub(crate) fn installed_app(directory: &Path) -> Result<Option<InstalledApp>> {
    let Some(id) = directory.file_name().and_then(|name| name.to_str()) else {
        return Ok(None);
    };
    let Some(option) = app_option(id) else {
        return Ok(None);
    };
    if !fs::symlink_metadata(directory)
        .is_ok_and(|metadata| metadata.is_dir() && !crate::safety::is_link(&metadata))
    {
        return Ok(None);
    }
    let Some(package) =
        crate::installed_version::asar_package(&directory.join("resources/app.asar"))
    else {
        return Ok(None);
    };
    if package["name"] != id
        || package["hexbotAppId"] != id
        || !directory.join(EXECUTABLE).is_file()
    {
        return Ok(None);
    }
    Ok(Some(InstalledApp {
        path: directory.to_owned(),
        option,
        app_id: id.to_owned(),
        version: package["version"].as_str().map(str::to_owned),
        managed_by_dpkg: false,
    }))
}

impl Installer {
    pub(crate) fn install_windows(
        &self,
        download: &Path,
        artifact: &Artifact,
        (id, _name): (&str, &str),
        progress: &mut ProgressCallback<'_>,
    ) -> Result<Vec<PathBuf>> {
        if artifact.format.as_deref() != Some("exe") {
            return fail("The Windows app installer format is not supported.");
        }
        let directory = self.paths.install_apps_dir(self.target)?.join(id);
        if fs::symlink_metadata(&directory).is_ok() {
            let installed = installed_app(&directory)?
                .ok_or("An unrelated app already uses the install path.")?;
            if installed.app_id != id {
                return fail("The app id does not match the install path.");
            }
            self.require_quit(&directory)?;
        }
        progress(Progress::new("install", "Installing the app."));
        // Windows CreateProcess requires an .exe suffix. Keep the verified
        // payload in the download's private temporary directory.
        let executable = download.with_extension("exe");
        fs::rename(download, &executable)?;
        let mut command = self.paths.command(&executable);
        command.arg("/S");
        nsis_directory(&mut command, "/D=", &directory)?;
        let status = command.status()?;
        if !status.success() {
            return fail(format!("The Windows app installer failed with {status}."));
        }
        if installed_app(&directory)?.is_none() || !uninstaller(&directory).is_file() {
            return fail(
                "The Windows app installer did not create the expected app and uninstaller.",
            );
        }
        Ok(vec![directory.join(EXECUTABLE)])
    }

    pub(crate) fn uninstall_windows(&self, app: &InstalledApp) -> Result<()> {
        let found = installed_app(&app.path)?
            .ok_or("Cannot identify the installed Windows app; left it alone.")?;
        if found.app_id != app.app_id {
            return fail("The installed Windows app id changed; left it alone.");
        }
        let uninstaller = uninstaller(&app.path);
        if !fs::symlink_metadata(&uninstaller)
            .is_ok_and(|metadata| metadata.is_file() && !crate::safety::is_link(&metadata))
        {
            return fail("Cannot identify the Windows app uninstaller; left it alone.");
        }
        // _?= disables NSIS's asynchronous copy-to-temp path so this process
        // waits until removal finishes. NSIS requires it to be the last arg.
        let mut command = self.paths.command(&uninstaller);
        command.arg("/S");
        nsis_directory(&mut command, "_?=", &app.path)?;
        let status = command.status()?;
        if !status.success() {
            return fail(format!("The Windows app uninstaller failed with {status}."));
        }
        if app.path.join(EXECUTABLE).exists() {
            return fail("The Windows app is still installed. Close it and try again.");
        }
        // NSIS leaves its running uninstaller behind with _?=. It has exited.
        crate::remove_path(&app.path)
    }

    pub(crate) fn remove_windows_service(&self, file: &Path) -> Result<()> {
        crate::install_ownership::check_service(file, &self.paths.hexbot_home, false)?;
        #[cfg(windows)]
        {
            // Read and verify Task Scheduler's definition too. A local XML file
            // alone cannot authorize removal of an unrelated registered task.
            let task = crate::install_ownership::windows_task_name(&self.paths.hexbot_home)?;
            let output = self.task_scheduler(&task, None,
                "try{$task=$folder.GetTask($env:HEXBOT_INSTALL_TASK_NAME);$task.Xml}catch{if($_.Exception.HResult -eq -2147024894){exit 3};throw}")?;
            if output.status.code() == Some(3) {
                return Ok(());
            }
            let xml = String::from_utf8(crate::check_output(output)?)?;
            let xml = xml.trim();
            crate::install_ownership::check_windows_service_text(xml, &self.paths.hexbot_home)?;
            let _daemon = self.stop_daemon()?;
            crate::check_output(self.task_scheduler(&task, Some(xml),
                "$task=$folder.GetTask($env:HEXBOT_INSTALL_TASK_NAME);if($task.Xml.Trim() -cne $env:HEXBOT_INSTALL_TASK_XML){throw 'The Hexbot task changed; left it alone'};$task.Stop(0);$folder.DeleteTask($env:HEXBOT_INSTALL_TASK_NAME,0)")?)?;
            Ok(())
        }
        #[cfg(not(windows))]
        fail("Windows service operations require Windows.")
    }

    #[cfg(windows)]
    fn task_scheduler(
        &self,
        task: &str,
        xml: Option<&str>,
        source: &str,
    ) -> Result<std::process::Output> {
        use base64::{Engine, engine::general_purpose::STANDARD};
        use std::{
            io::{Read, Seek, SeekFrom},
            process::Stdio,
            time::{Duration, Instant},
        };
        let root = std::env::var_os("SystemRoot").ok_or("SystemRoot is not set.")?;
        let executable = PathBuf::from(root).join("System32/WindowsPowerShell/v1.0/powershell.exe");
        let source = format!(
            "$ErrorActionPreference='Stop';[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);$scheduler=New-Object -ComObject Schedule.Service;$scheduler.Connect();$folder=$scheduler.GetFolder('\\');{source}"
        );
        let bytes: Vec<u8> = source.encode_utf16().flat_map(u16::to_le_bytes).collect();
        let mut stdout = tempfile::tempfile()?;
        let mut stderr = tempfile::tempfile()?;
        let mut child = self
            .paths
            .command(executable)
            .args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-EncodedCommand",
                &STANDARD.encode(bytes),
            ])
            .env("HEXBOT_INSTALL_TASK_NAME", task)
            .env("HEXBOT_INSTALL_TASK_XML", xml.unwrap_or_default())
            .stdin(Stdio::null())
            .stdout(stdout.try_clone()?)
            .stderr(stderr.try_clone()?)
            .spawn()?;
        let deadline = Instant::now() + Duration::from_secs(30);
        let status = loop {
            if let Some(status) = child.try_wait()? {
                break status;
            }
            if Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                return fail("Task Scheduler request timed out.");
            }
            std::thread::sleep(Duration::from_millis(25));
        };
        stdout.seek(SeekFrom::Start(0))?;
        stderr.seek(SeekFrom::Start(0))?;
        let mut output = std::process::Output {
            status,
            stdout: Vec::new(),
            stderr: Vec::new(),
        };
        stdout.read_to_end(&mut output.stdout)?;
        stderr.read_to_end(&mut output.stderr)?;
        Ok(output)
    }
}

fn uninstaller(directory: &Path) -> PathBuf {
    directory.join("Uninstall Hexbot.exe")
}

fn nsis_directory(
    command: &mut std::process::Command,
    prefix: &str,
    directory: &Path,
) -> Result<()> {
    let value = directory
        .to_str()
        .ok_or("The install path is not valid UTF-8.")?;
    if !directory.is_absolute() || value.contains(['"', '\n', '\r', '\0']) {
        return fail("The Windows install path is invalid.");
    }
    // NSIS treats this final option as the rest of the command line, including
    // spaces. Its documented syntax explicitly forbids quoting the directory.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.raw_arg(format!("{prefix}{value}"));
    }
    #[cfg(not(windows))]
    command.arg(format!("{prefix}{value}"));
    Ok(())
}

#[cfg(not(windows))]
pub(crate) fn require_quit(_: &Path) -> Result<()> {
    fail("Windows app operations require Windows.")
}

#[cfg(windows)]
pub(crate) fn process_executable(pid: u32) -> Option<PathBuf> {
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::{
        Foundation::CloseHandle,
        System::Threading::{
            OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW,
        },
    };
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        return None;
    }
    let mut path = vec![0u16; 32768];
    let mut len = path.len() as u32;
    let ok = unsafe { QueryFullProcessImageNameW(handle, 0, path.as_mut_ptr(), &mut len) };
    unsafe { CloseHandle(handle) };
    (ok != 0).then(|| PathBuf::from(std::ffi::OsString::from_wide(&path[..len as usize])))
}

#[cfg(windows)]
pub(crate) fn require_quit(app: &Path) -> Result<()> {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, INVALID_HANDLE_VALUE},
        System::Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
            TH32CS_SNAPPROCESS,
        },
    };
    let app = match app.canonicalize() {
        Ok(path) => path,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(std::io::Error::last_os_error().into());
    }
    let result = (|| {
        let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut more = unsafe { Process32FirstW(snapshot, &mut entry) } != 0;
        while more {
            if let Some(path) =
                process_executable(entry.th32ProcessID).and_then(|path| path.canonicalize().ok())
                && (path == app || app.is_dir() && path.starts_with(&app))
            {
                return fail(format!(
                    "Quit {}, then run the installer again.",
                    app.display()
                ));
            }
            more = unsafe { Process32NextW(snapshot, &mut entry) } != 0;
        }
        Ok(())
    })();
    unsafe { CloseHandle(snapshot) };
    result
}

#[cfg(windows)]
pub(crate) fn request_shutdown(pid: u32, home: &Path) -> std::io::Result<()> {
    use sha2::{Digest, Sha256};
    use windows_sys::Win32::{
        Foundation::CloseHandle,
        System::Threading::{EVENT_MODIFY_STATE, OpenEventW, SetEvent},
    };
    let home = home
        .canonicalize()?
        .to_string_lossy()
        .replace('\\', "/")
        .to_lowercase();
    let home = home.strip_prefix("//?/").unwrap_or(&home);
    let digest = format!("{:x}", Sha256::digest(home.as_bytes()));
    let name: Vec<u16> = format!("Local\\HexbotShutdown-{pid}-{digest}\0")
        .encode_utf16()
        .collect();
    let event = unsafe { OpenEventW(EVENT_MODIFY_STATE, 0, name.as_ptr()) };
    if event.is_null() {
        return Err(std::io::Error::last_os_error());
    }
    let ok = unsafe { SetEvent(event) };
    let error = std::io::Error::last_os_error();
    unsafe { CloseHandle(event) };
    if ok == 0 { Err(error) } else { Ok(()) }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn asar(directory: &Path, id: &str, version: &str) {
        let package = serde_json::to_vec(&serde_json::json!({
            "name": id, "hexbotAppId": id, "version": version
        }))
        .unwrap();
        let header = serde_json::to_vec(&serde_json::json!({"files": {
            "package.json": {"offset": "0", "size": package.len()}
        }}))
        .unwrap();
        let size = (header.len() + 11) & !3;
        let mut bytes = Vec::new();
        for word in [4, size as u32, (size - 4) as u32, header.len() as u32] {
            bytes.extend(word.to_le_bytes());
        }
        bytes.extend(header);
        bytes.resize(size + 8, 0);
        bytes.extend(package);
        fs::create_dir_all(directory.join("resources")).unwrap();
        fs::write(directory.join("resources/app.asar"), bytes).unwrap();
        fs::write(directory.join(EXECUTABLE), "app fixture").unwrap();
    }

    #[test]
    fn detection_requires_exact_packaged_identity_and_reads_current_version() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("app.hexbot.client.nightly");
        fs::create_dir(&directory).unwrap();
        assert!(installed_app(&directory).unwrap().is_none());
        asar(&directory, "app.hexbot.desktop", "1.2.3");
        assert!(installed_app(&directory).unwrap().is_none());
        asar(&directory, "app.hexbot.client.nightly", "1.2.4-nightly.1");
        let app = installed_app(&directory).unwrap().unwrap();
        assert_eq!(app.option, crate::InstallOption::Client);
        assert_eq!(app.version.as_deref(), Some("1.2.4-nightly.1"));
        fs::rename(
            &directory,
            root.path().join("app.hexbot.client.nightly-backup"),
        )
        .unwrap();
        assert!(
            installed_app(&root.path().join("app.hexbot.client.nightly-backup"))
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn windows_discovery_and_version_floor_work_without_a_receipt() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        fs::create_dir(&home).unwrap();
        let apps = root.path().join("apps");
        asar(
            &apps.join("app.hexbot.desktop"),
            "app.hexbot.desktop",
            "1.2.3",
        );
        let engine = Installer {
            paths: crate::Paths {
                local_data: None,
                home,
                hexbot_home: root.path().join("state"),
                apps_override: Some(apps),
                opt_override: None,
                service_root: root.path().join("services"),
                service_no_load: true,
            },
            target: crate::Target::WindowsX86_64,
            base_url: "http://127.0.0.1".into(),
        };
        let installed = engine.detect().unwrap();
        assert!(installed.receipt.is_none());
        assert_eq!(installed.option(), Some(crate::InstallOption::Full));
        assert_eq!(
            engine
                .installed_version(crate::Track::Stable)
                .unwrap()
                .unwrap()
                .to_string(),
            "1.2.3"
        );
        assert!(
            engine
                .installed_version(crate::Track::Nightly)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn nsis_destination_rejects_command_line_breaks() {
        let root = tempfile::tempdir().unwrap();
        for suffix in ["quote\" /S", "line\n/D=other", "carriage\r"] {
            let mut command = std::process::Command::new("fixture");
            assert!(nsis_directory(&mut command, "/D=", &root.path().join(suffix)).is_err());
        }
        let mut command = std::process::Command::new("fixture");
        assert!(
            nsis_directory(
                &mut command,
                "/D=",
                &root.path().join("space and & Unicode 雪")
            )
            .is_ok()
        );
    }
}
