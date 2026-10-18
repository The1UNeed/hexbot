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
    installed_app_with(directory, registered_location)
}

fn same_edition(initial: &str, payload: &str) -> bool {
    app_option(initial).is_some()
        && app_option(initial) == app_option(payload)
        && initial.ends_with(".dev") == payload.ends_with(".dev")
}

fn installed_app_with(
    directory: &Path,
    registered: impl Fn(&str) -> Result<Option<PathBuf>>,
) -> Result<Option<InstalledApp>> {
    if !fs::symlink_metadata(directory)
        .is_ok_and(|metadata| metadata.is_dir() && !crate::safety::is_link(&metadata))
    {
        return Ok(None);
    }
    for (path, directory_expected) in [
        (directory.join("resources"), true),
        (directory.join("resources/app.asar"), false),
        (directory.join(EXECUTABLE), false),
    ] {
        if !fs::symlink_metadata(path).is_ok_and(|metadata| {
            !crate::safety::is_link(&metadata)
                && if directory_expected {
                    metadata.is_dir()
                } else {
                    metadata.is_file()
                }
        }) {
            return Ok(None);
        }
    }
    let Some(package) =
        crate::installed_version::asar_package(&directory.join("resources/app.asar"))
    else {
        return Ok(None);
    };
    let Some(payload) = package["hexbotAppId"]
        .as_str()
        .filter(|id| app_option(id).is_some())
    else {
        return Ok(None);
    };
    if package["name"] != payload
        || package["version"]
            .as_str()
            .is_none_or(|version| semver::Version::parse(version).is_err())
    {
        return Ok(None);
    }
    let id = match installation_id(&directory.join("hexbot-install.ini"))? {
        Some(id) => {
            if !same_edition(&id, payload) {
                return Ok(None);
            }
            let Some(registered) = registered(&id)? else {
                return Ok(None);
            };
            if registered.canonicalize().ok() != directory.canonicalize().ok()
                || !registered.is_absolute()
                || registered
                    .components()
                    .any(|part| matches!(part, std::path::Component::ParentDir))
            {
                return Ok(None);
            }
            id
        }
        None => {
            // Before persistent install identities, the directory and package
            // both named the same build. A missing marker cannot authorize a
            // cross-track or arbitrarily named installation.
            if directory.file_name().and_then(|name| name.to_str()) != Some(payload) {
                return Ok(None);
            }
            payload.to_owned()
        }
    };
    Ok(Some(InstalledApp {
        path: directory.to_owned(),
        option: app_option(&id).expect("validated install id"),
        app_id: id,
        version: package["version"].as_str().map(str::to_owned),
        managed_by_dpkg: false,
    }))
}

fn installation_id(path: &Path) -> Result<Option<String>> {
    use std::io::Read;
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if !metadata.is_file() || crate::safety::is_link(&metadata) || metadata.len() > 4096 {
        return fail("The Windows app's installation identity is invalid; left it alone.");
    }
    let mut bytes = Vec::new();
    fs::File::open(path)?.take(4097).read_to_end(&mut bytes)?;
    if bytes.len() > 4096 {
        return fail("The Windows app's installation identity is too large.");
    }
    let text = if let Some(bytes) = bytes.strip_prefix(&[0xff, 0xfe]) {
        if bytes.len() % 2 != 0 {
            return fail("The Windows app's installation identity is invalid.");
        }
        String::from_utf16(
            &bytes
                .chunks_exact(2)
                .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
                .collect::<Vec<_>>(),
        )?
    } else {
        String::from_utf8(bytes)?
            .trim_start_matches('\u{feff}')
            .to_owned()
    };
    let mut lines = text.lines().filter(|line| !line.is_empty());
    let id = if lines.next() == Some("[installation]") {
        lines.next().and_then(|line| line.strip_prefix("appId="))
    } else {
        None
    };
    match id.filter(|id| app_option(id).is_some() && lines.next().is_none()) {
        Some(id) => Ok(Some(id.to_owned())),
        None => fail("The Windows app's installation identity is invalid; left it alone."),
    }
}

#[cfg(windows)]
pub(crate) fn user_programs() -> Result<PathBuf> {
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::{
        System::Com::CoTaskMemFree,
        UI::Shell::{FOLDERID_UserProgramFiles, KF_FLAG_DONT_VERIFY, SHGetKnownFolderPath},
    };
    let mut pointer = std::ptr::null_mut();
    // Read the configured location without creating it on the option screen.
    let result = unsafe {
        SHGetKnownFolderPath(
            &FOLDERID_UserProgramFiles,
            KF_FLAG_DONT_VERIFY as u32,
            std::ptr::null_mut(),
            &mut pointer,
        )
    };
    let path = if result >= 0 && !pointer.is_null() {
        let mut len = 0;
        while len < 32768 && unsafe { *pointer.add(len) } != 0 {
            len += 1;
        }
        (len < 32768).then(|| {
            PathBuf::from(std::ffi::OsString::from_wide(unsafe {
                std::slice::from_raw_parts(pointer, len)
            }))
        })
    } else {
        None
    };
    if !pointer.is_null() {
        unsafe { CoTaskMemFree(pointer.cast()) };
    }
    path.filter(|path| path.is_absolute()).ok_or_else(|| {
        format!("Could not resolve the Windows programs folder, HRESULT {result:#x}.").into()
    })
}

#[cfg(not(windows))]
fn registered_location(_: &str) -> Result<Option<PathBuf>> {
    Ok(None)
}

#[cfg(windows)]
fn registered_location(id: &str) -> Result<Option<PathBuf>> {
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::{
        Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS},
        System::Registry::{HKEY_CURRENT_USER, RRF_RT_REG_SZ, RegGetValueW},
    };
    if app_option(id).is_none() {
        return fail("Invalid Windows installation id.");
    }
    let key: Vec<u16> = format!("Software\\{id}\0").encode_utf16().collect();
    let name: Vec<u16> = "InstallLocation\0".encode_utf16().collect();
    let mut size = 0;
    let result = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            key.as_ptr(),
            name.as_ptr(),
            RRF_RT_REG_SZ,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut size,
        )
    };
    if result == ERROR_FILE_NOT_FOUND {
        return Ok(None);
    }
    if result != ERROR_SUCCESS {
        return Err(std::io::Error::from_raw_os_error(result as i32).into());
    }
    if size == 0 || size > 65536 || size % 2 != 0 {
        return fail("The Windows app's registered install location is invalid.");
    }
    let mut buffer = vec![0u16; size as usize / 2];
    let result = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            key.as_ptr(),
            name.as_ptr(),
            RRF_RT_REG_SZ,
            std::ptr::null_mut(),
            buffer.as_mut_ptr().cast(),
            &mut size,
        )
    };
    if result != ERROR_SUCCESS {
        return Err(std::io::Error::from_raw_os_error(result as i32).into());
    }
    buffer.truncate(size as usize / 2);
    while buffer.last() == Some(&0) {
        buffer.pop();
    }
    if buffer.contains(&0) {
        return fail("The Windows app's registered install location contains a null character.");
    }
    Ok(Some(PathBuf::from(std::ffi::OsString::from_wide(&buffer))))
}

#[cfg(windows)]
pub(crate) fn registered_apps() -> Result<Vec<InstalledApp>> {
    registered_apps_with(registered_location)
}

#[cfg(any(test, windows))]
fn registered_apps_with(
    lookup: impl Fn(&str) -> Result<Option<PathBuf>>,
) -> Result<Vec<InstalledApp>> {
    let mut apps = Vec::new();
    for base in ["app.hexbot.desktop", "app.hexbot.client"] {
        for suffix in ["", ".nightly", ".dev"] {
            let id = format!("{base}{suffix}");
            if let Some(directory) = lookup(&id)?
                && let Some(app) = installed_app_with(&directory, &lookup)?
                && app.app_id == id
            {
                apps.push(app);
            }
        }
    }
    Ok(apps)
}

impl Installer {
    fn windows_app_destination(&self, id: &str) -> Result<PathBuf> {
        let installed = self.detect()?;
        match existing_destination(&installed, id) {
            Some(path) => Ok(path),
            None => Ok(self.paths.planned_apps_dir(self.target)?.join(id)),
        }
    }

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
        let directory = self.windows_app_destination(id)?;
        fs::create_dir_all(directory.parent().ok_or("Invalid Windows app directory.")?)?;
        if fs::symlink_metadata(&directory).is_ok() {
            let installed = installed_app(&directory)?
                .ok_or("An unrelated app already uses the install path.")?;
            if !same_edition(&installed.app_id, id) {
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
        if installed_app(&directory)?.is_none_or(|app| !same_edition(&app.app_id, id))
            || !uninstaller(&directory).is_file()
        {
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
                "try{$task=$folder.GetTask($env:HEXBOT_INSTALL_TASK_NAME);$task.Xml}catch{$error=$_.Exception;while($error.InnerException){$error=$error.InnerException};if($error.HResult -eq -2147024894){exit 3};throw}")?;
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

fn existing_destination(installed: &crate::Installed, id: &str) -> Option<PathBuf> {
    let target = if id.ends_with(".nightly") {
        crate::Track::Nightly
    } else {
        crate::Track::Stable
    };
    let current_track = |app: &&InstalledApp| {
        app.version
            .as_deref()
            .and_then(|version| semver::Version::parse(version).ok())
            .map(|version| {
                if version.pre.as_str().starts_with("nightly.") {
                    crate::Track::Nightly
                } else {
                    crate::Track::Stable
                }
            })
            == Some(target)
    };
    let same = |app: &&InstalledApp| same_edition(&app.app_id, id);
    let selected = installed.receipt.as_ref().and_then(|receipt| {
        installed.apps.iter().find(|app| {
            receipt
                .paths
                .iter()
                .any(|path| path == &app.path || path.parent() == Some(app.path.as_path()))
        })
    });
    selected
        .filter(|app| same(app) && current_track(app))
        .or_else(|| installed.apps.iter().find(|app| app.app_id == id))
        .or_else(|| installed.apps.iter().filter(same).find(current_track))
        .map(|app| app.path.clone())
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
                user_programs: None,
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

    #[test]
    fn redirected_programs_location_and_explicit_override_remain_distinct() {
        let root = tempfile::tempdir().unwrap();
        let redirected = root.path().join("redirected-programs");
        asar(
            &redirected.join("app.hexbot.desktop"),
            "app.hexbot.desktop",
            "1.2.3",
        );
        let mut paths = crate::Paths {
            home: root.path().join("home"),
            local_data: Some(root.path().join("redirected-appdata")),
            user_programs: Some(redirected.clone()),
            hexbot_home: root.path().join("state"),
            apps_override: None,
            opt_override: None,
            service_root: root.path().join("services"),
            service_no_load: true,
        };
        assert_eq!(
            paths.app_dirs(crate::Target::WindowsX86_64),
            vec![redirected]
        );
        let apps = paths.app_dirs(crate::Target::WindowsX86_64);
        assert!(
            installed_app(&apps[0].join("app.hexbot.desktop"))
                .unwrap()
                .is_some()
        );
        let explicit = root.path().join("isolated-programs");
        paths.apps_override = Some(explicit.clone());
        assert_eq!(paths.app_dirs(crate::Target::WindowsX86_64), vec![explicit]);
    }

    #[test]
    fn cross_track_payload_retains_verified_install_identity_and_current_track() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("custom-directory-name");
        asar(&directory, "app.hexbot.desktop.nightly", "1.2.4-nightly.1");
        let marker = directory.join("hexbot-install.ini");
        fs::write(&marker, "[installation]\r\nappId=app.hexbot.desktop\r\n").unwrap();
        let lookup = |id: &str| Ok((id == "app.hexbot.desktop").then(|| directory.clone()));
        let app = installed_app_with(&directory, lookup).unwrap().unwrap();
        assert_eq!(app.app_id, "app.hexbot.desktop");
        let installed = crate::Installed {
            target: Some(crate::Target::WindowsX86_64),
            receipt: Some(crate::Receipt {
                option: crate::InstallOption::Full,
                channel: crate::Track::Stable,
                version: "1.2.3".into(),
                paths: vec![directory.join(EXECUTABLE)],
                installed_at: String::new(),
            }),
            apps: vec![app],
            ..Default::default()
        };
        assert_eq!(installed.track(), Some(crate::Track::Nightly));
        assert_eq!(installed.version(), Some("1.2.4-nightly.1"));
        assert_eq!(
            existing_destination(&installed, "app.hexbot.desktop.nightly"),
            Some(directory.clone())
        );
        assert!(
            installed_app_with(&directory, |_| Ok(Some(root.path().join("unrelated"))))
                .unwrap()
                .is_none()
        );
        asar(&directory, "app.hexbot.client.nightly", "1.2.4-nightly.1");
        assert!(installed_app_with(&directory, lookup).unwrap().is_none());
        asar(&directory, "app.hexbot.desktop.dev", "1.2.4");
        assert!(installed_app_with(&directory, lookup).unwrap().is_none());
    }

    #[test]
    fn stable_and_nightly_initial_installs_keep_separate_destinations() {
        let root = tempfile::tempdir().unwrap();
        let app = |id: &str, version: &str| InstalledApp {
            path: root.path().join(id),
            option: crate::InstallOption::Full,
            app_id: id.into(),
            version: Some(version.into()),
            managed_by_dpkg: false,
        };
        let installed = crate::Installed {
            apps: vec![
                app("app.hexbot.desktop", "1.2.3"),
                app("app.hexbot.desktop.nightly", "1.2.4-nightly.1"),
            ],
            ..Default::default()
        };
        for id in ["app.hexbot.desktop", "app.hexbot.desktop.nightly"] {
            assert_eq!(
                existing_destination(&installed, id),
                Some(root.path().join(id))
            );
        }
        assert!(existing_destination(&installed, "app.hexbot.client").is_none());
    }

    #[test]
    fn registered_custom_directory_is_discovered_and_foreign_entries_are_ignored() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("user-picked-install-path");
        asar(&directory, "app.hexbot.client.nightly", "1.2.4-nightly.1");
        fs::write(
            directory.join("hexbot-install.ini"),
            "[installation]\r\nappId=app.hexbot.client.nightly\r\n",
        )
        .unwrap();
        let apps = registered_apps_with(|id| {
            Ok((id == "app.hexbot.client.nightly").then(|| directory.clone()))
        })
        .unwrap();
        assert_eq!(apps.len(), 1);
        assert_eq!(apps[0].path, directory);
        assert!(
            registered_apps_with(|id| Ok((id == "app.hexbot.desktop").then(|| directory.clone())))
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn installation_marker_rejects_duplicates_and_unbounded_content() {
        let root = tempfile::tempdir().unwrap();
        let marker = root.path().join("hexbot-install.ini");
        for text in [
            "[installation]\nappId=app.hexbot.desktop\nappId=app.hexbot.client\n",
            "[installation]\nappId=app.hexbot.desktop\n[other]\n",
            "[installation]\nappId=org.example.app\n",
        ] {
            fs::write(&marker, text).unwrap();
            assert!(installation_id(&marker).is_err());
        }
        fs::write(&marker, vec![b'X'; 4097]).unwrap();
        assert!(installation_id(&marker).is_err());
        let mut utf16 = vec![0xff, 0xfe];
        utf16.extend(
            "[installation]\r\nappId=app.hexbot.desktop\r\n"
                .encode_utf16()
                .flat_map(u16::to_le_bytes),
        );
        fs::write(&marker, utf16).unwrap();
        assert_eq!(
            installation_id(&marker).unwrap().as_deref(),
            Some("app.hexbot.desktop")
        );
    }

    #[test]
    #[cfg(windows)]
    fn known_programs_folder_ignores_local_appdata_environment() {
        const CHILD: &str = "HEXBOT_TEST_KNOWN_PROGRAMS_CHILD";
        if std::env::var_os(CHILD).is_none() {
            let root = tempfile::tempdir().unwrap();
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "windows::tests::known_programs_folder_ignores_local_appdata_environment",
                ])
                .env(CHILD, "1")
                .env("LOCALAPPDATA", root.path())
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{} {}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
        } else {
            let folder = user_programs().unwrap();
            assert!(folder.is_absolute());
            assert_ne!(
                folder,
                PathBuf::from(std::env::var_os("LOCALAPPDATA").unwrap()).join("Programs")
            );
        }
    }
}
