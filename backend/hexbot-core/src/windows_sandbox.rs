//! Windows AppContainer confinement for shell commands and code.
//!
//! The plan is pure data and is tested on every OS. On Windows the `sandbox`
//! subcommand applies it and fails closed: a command that cannot be placed in
//! an AppContainer with no capabilities (no network) does not start. Deny
//! entries are access-denied ACEs for the AppContainer SID only, so a crash
//! cannot lock the user out of their own files.
use crate::{Error, Result};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Grant {
    pub path: PathBuf,
    pub write: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Plan {
    /// Full access, after the user agrees. Confined Auto and Manual stay offline.
    pub network: bool,
    /// `0` means no active-process cap. Confined commands must pass a positive cap.
    pub process_limit: u32,
    pub allow: Vec<Grant>,
    pub deny: Vec<PathBuf>,
}

fn fold_path(path: &Path, fold: bool) -> PathBuf {
    if fold {
        PathBuf::from(path.to_string_lossy().to_lowercase())
    } else {
        path.to_owned()
    }
}

fn nested(path: &Path, root: &Path, fold: bool) -> bool {
    let (path, root) = (fold_path(path, fold), fold_path(root, fold));
    path == root || path.starts_with(&root)
}

/// Build a plan. `fold` is true on macOS and Windows. A writable path is kept
/// even when a secret sits inside it; the secret is listed in `deny` and the
/// AppContainer deny ACE wins over the inherited allow.
pub fn prepare(
    network: bool,
    process_limit: Option<u32>,
    must_cap: bool,
    writable: &[PathBuf],
    readable: &[PathBuf],
    deny: &[PathBuf],
    fold: bool,
) -> Result<Plan> {
    let process_limit = match process_limit {
        Some(limit) if limit > 0 => limit,
        Some(0) | None if !must_cap => 0,
        _ => {
            return Err(Error::new(
                5240,
                "Hexbot could not cap processes for the sandbox.",
            ))
        }
    };
    if must_cap && process_limit > 100_000 {
        return Err(Error::new(
            5240,
            "Hexbot could not cap processes for the sandbox.",
        ));
    }
    let mut allow: Vec<Grant> = Vec::new();
    for (path, write) in writable
        .iter()
        .map(|path| (path, true))
        .chain(readable.iter().map(|path| (path, false)))
    {
        if !path.is_absolute() {
            return Err(Error::new(5240, "The sandbox refused a relative path."));
        }
        if deny.iter().any(|secret| nested(path, secret, fold)) {
            continue;
        }
        if let Some(existing) = allow
            .iter_mut()
            .find(|grant| nested(&grant.path, path, fold) && nested(path, &grant.path, fold))
        {
            existing.write |= write;
        } else {
            allow.push(Grant {
                path: path.clone(),
                write,
            });
        }
    }
    if allow.is_empty() {
        return Err(Error::new(
            5240,
            "The sandbox has nowhere to run this command.",
        ));
    }
    let mut kept: Vec<PathBuf> = Vec::new();
    for path in deny.iter().filter(|path| path.is_absolute()) {
        if !kept.iter().any(|have| nested(path, have, fold)) {
            kept.push(path.clone());
        }
    }
    let deny = kept;
    Ok(Plan {
        network,
        process_limit,
        allow,
        deny,
    })
}

pub fn write_plan(directory: &Path, plan: &Plan) -> Result<PathBuf> {
    fs::create_dir_all(directory)?;
    let path = directory.join(format!("{}.json", crate::common::id()));
    let mut options = fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&path)?;
    use std::io::Write;
    file.write_all(
        &serde_json::to_vec(plan).map_err(|error| Error::new(5240, error.to_string()))?,
    )?;
    file.sync_all()?;
    Ok(path)
}

pub fn read_plan(path: &Path) -> Result<Plan> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.file_type().is_file() {
        return Err(Error::new(5240, "The sandbox plan must be a regular file."));
    }
    if metadata.len() > 1 << 20 {
        return Err(Error::new(5240, "The sandbox plan is too large."));
    }
    let bytes = fs::read(path)?;
    let plan: Plan = serde_json::from_slice(&bytes)
        .map_err(|_| Error::new(5240, "The sandbox plan could not be read."))?;
    if plan.allow.is_empty() || plan.allow.iter().any(|grant| !grant.path.is_absolute()) {
        return Err(Error::new(5240, "The sandbox plan is not usable."));
    }
    let _ = fs::remove_file(path);
    Ok(plan)
}

pub fn run_cli(args: &[String]) -> Result<()> {
    #[cfg(not(windows))]
    {
        let _ = args;
        return Err(Error::new(
            5240,
            "The Windows sandbox is only available on Windows.",
        ));
    }
    #[cfg(windows)]
    match apply_cli(args) {
        Ok(code) => std::process::exit(code),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(126);
        }
    }
}

/// Quote one `CreateProcessW` argument the way `CommandLineToArgvW` parses it.
pub fn quote_arg(value: &str) -> String {
    if !value.is_empty() && !value.contains([' ', '\t', '"']) {
        return value.to_owned();
    }
    let mut out = String::from("\"");
    let mut slashes = 0;
    for ch in value.chars() {
        if ch == '\\' {
            slashes += 1;
        } else if ch == '"' {
            out.push_str(&"\\".repeat(slashes * 2 + 1));
            out.push('"');
            slashes = 0;
        } else {
            out.push_str(&"\\".repeat(slashes));
            out.push(ch);
            slashes = 0;
        }
    }
    out.push_str(&"\\".repeat(slashes * 2));
    out.push('"');
    out
}

#[cfg(windows)]
fn apply_cli(args: &[String]) -> Result<i32> {
    let marker = args
        .iter()
        .position(|arg| arg == "--")
        .ok_or_else(|| Error::new(5240, "The sandbox command is missing."))?;
    let flags = &args[..marker];
    let command = &args[marker + 1..];
    if command.is_empty()
        || command
            .iter()
            .any(|arg| arg.contains('\0') || arg.len() > 32_767)
    {
        return Err(Error::new(5240, "The sandbox command is missing."));
    }
    let mut home = None;
    let mut confine = None;
    let mut cwd = None;
    let mut writes = Vec::new();
    let mut index = 0;
    while index < flags.len() {
        let flag = flags[index].as_str();
        let value = flags
            .get(index + 1)
            .ok_or_else(|| Error::new(5240, "The sandbox command is missing a value."))?;
        if value.contains('\0') || flag.contains('\0') {
            return Err(Error::new(5240, "The sandbox command is not usable."));
        }
        match flag {
            "--home" => home = Some(PathBuf::from(value)),
            "--confine" => confine = Some(value.as_str()),
            "--cwd" => cwd = Some(PathBuf::from(value)),
            "--write" => writes.push(PathBuf::from(value)),
            "--plan" => {
                return Err(Error::new(
                    5240,
                    "The sandbox builds its own plan and does not accept a plan file.",
                ))
            }
            _ => return Err(Error::new(5240, "The sandbox command is not usable.")),
        }
        index += 2;
    }
    let home = home.ok_or_else(|| Error::new(5240, "The sandbox home is missing."))?;
    let confine = match confine {
        Some("base") => crate::credentials::Confine::No,
        Some("workspace") => crate::credentials::Confine::Workspace,
        Some("readonly") => crate::credentials::Confine::ReadOnly,
        _ => return Err(Error::new(5240, "The sandbox mode is not usable.")),
    };
    if !home.is_absolute() || writes.iter().any(|path| !path.is_absolute()) {
        return Err(Error::new(5240, "The sandbox refused a relative path."));
    }
    let cwd = cwd
        .unwrap_or(std::env::current_dir().map_err(|error| Error::new(5240, error.to_string()))?);
    if !cwd.is_absolute() || cwd.as_os_str().as_encoded_bytes().contains(&0) {
        return Err(Error::new(
            5240,
            "The sandbox working directory is not usable.",
        ));
    }
    let plan = crate::credentials::confinement_plan(&home, confine, &writes)?;
    launch(&plan, &cwd, Path::new(&command[0]), &command[1..])
}

#[cfg(windows)]
fn launch(plan: &Plan, cwd: &Path, program: &Path, args: &[String]) -> Result<i32> {
    if !program.is_absolute() || !program.is_file() {
        return Err(Error::new(
            5240,
            "The sandbox refused a command that is not an absolute program.",
        ));
    }
    let container = appcontainer(plan.network)?;
    // Grants stay on the file after this process exits. They name this
    // launch's profile only, and the profile is deleted with it. Revoke them
    // anyway so a busy directory does not collect a dead ACE per command.
    let mut applied = Vec::new();
    let result = (|| -> Result<i32> {
        for grant in &plan.allow {
            if grant.path.exists() {
                set_container_ace(&container, &grant.path, grant.write, false)?;
                applied.push(grant.path.clone());
            }
        }
        for secret in &plan.deny {
            if secret.exists() {
                set_container_ace(&container, secret, false, true)?;
                applied.push(secret.clone());
            }
        }
        let job = job_object(plan.process_limit)?;
        let process = create_confined(program, args, cwd, &container, plan.network)?;
        let assigned = unsafe {
            windows_sys::Win32::System::JobObjects::AssignProcessToJobObject(
                job,
                process.process,
            )
        };
        if assigned == 0 {
            unsafe {
                windows_sys::Win32::System::Threading::TerminateProcess(process.process, 126);
                windows_sys::Win32::Foundation::CloseHandle(process.thread);
                windows_sys::Win32::Foundation::CloseHandle(process.process);
                windows_sys::Win32::Foundation::CloseHandle(job);
            }
            return Err(Error::new(
                5240,
                "Hexbot could not cap processes for the sandbox.",
            ));
        }
        let resumed =
            unsafe { windows_sys::Win32::System::Threading::ResumeThread(process.thread) };
        unsafe { windows_sys::Win32::Foundation::CloseHandle(process.thread) };
        if resumed == u32::MAX {
            unsafe {
                windows_sys::Win32::System::Threading::TerminateProcess(process.process, 126);
                windows_sys::Win32::Foundation::CloseHandle(process.process);
                windows_sys::Win32::Foundation::CloseHandle(job);
            }
            return Err(Error::new(
                5240,
                "Hexbot could not start the sandboxed command.",
            ));
        }
        let waited = unsafe {
            windows_sys::Win32::System::Threading::WaitForSingleObject(process.process, u32::MAX)
        };
        let mut code = 1u32;
        unsafe {
            windows_sys::Win32::System::Threading::GetExitCodeProcess(process.process, &mut code);
            windows_sys::Win32::Foundation::CloseHandle(process.process);
            windows_sys::Win32::Foundation::CloseHandle(job);
        }
        if waited != 0 {
            return Err(Error::new(5240, "The sandboxed command did not finish."));
        }
        Ok(code as i32)
    })();
    for path in &applied {
        let _ = revoke_container_ace(&container, path);
    }
    result
}

#[cfg(windows)]
struct AppContainer {
    /// Profile name, NUL-terminated. A new name every launch so a grant left
    /// on disk cannot authorize the next command.
    name: Vec<u16>,
    sid: windows_sys::Win32::Security::PSID,
    network: Vec<u8>,
}

#[cfg(windows)]
impl Drop for AppContainer {
    fn drop(&mut self) {
        unsafe {
            if !self.name.is_empty() {
                windows_sys::Win32::Security::Isolation::DeleteAppContainerProfile(
                    self.name.as_ptr(),
                );
            }
            if !self.sid.is_null() {
                windows_sys::Win32::Foundation::LocalFree(self.sid as _);
            }
        }
    }
}

#[cfg(windows)]
fn wide(text: &std::ffi::OsStr) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    text.encode_wide().chain(std::iter::once(0)).collect()
}

#[cfg(windows)]
fn appcontainer(network: bool) -> Result<AppContainer> {
    use windows_sys::Win32::Foundation::S_OK;
    use windows_sys::Win32::Security::Isolation::CreateAppContainerProfile;
    use windows_sys::Win32::Security::PSID;
    // Letters, digits, and underscore only. A dot is rejected by the profile API.
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let label = format!("hexbot_{}_{:x}", std::process::id(), nonce);
    let name = wide(std::ffi::OsStr::new(&label));
    let display = wide(std::ffi::OsStr::new("Hexbot"));
    let mut sid: PSID = std::ptr::null_mut();
    let created = unsafe {
        CreateAppContainerProfile(
            name.as_ptr(),
            display.as_ptr(),
            display.as_ptr(),
            std::ptr::null(),
            0,
            &mut sid,
        )
    };
    if created != S_OK || sid.is_null() {
        if !sid.is_null() {
            unsafe { windows_sys::Win32::Foundation::LocalFree(sid as _) };
        }
        unsafe {
            windows_sys::Win32::Security::Isolation::DeleteAppContainerProfile(name.as_ptr())
        };
        return Err(Error::new(
            5240,
            "Hexbot could not create the Windows sandbox.",
        ));
    }
    let network_sid = match network {
        true => match internet_sid() {
            Ok(sid_bytes) => sid_bytes,
            Err(error) => {
                unsafe {
                    windows_sys::Win32::Foundation::LocalFree(sid as _);
                    windows_sys::Win32::Security::Isolation::DeleteAppContainerProfile(
                        name.as_ptr(),
                    );
                }
                return Err(error);
            }
        },
        false => Vec::new(),
    };
    Ok(AppContainer {
        name,
        sid,
        network: network_sid,
    })
}

#[cfg(windows)]
fn internet_sid() -> Result<Vec<u8>> {
    use windows_sys::Win32::Security::{CreateWellKnownSid, WinCapabilityInternetClientSid};
    let mut bytes = 0u32;
    unsafe {
        CreateWellKnownSid(
            WinCapabilityInternetClientSid,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut bytes,
        )
    };
    if bytes == 0 {
        return Err(Error::new(
            5240,
            "Hexbot could not allow network for this command.",
        ));
    }
    let mut sid = vec![0u8; bytes as usize];
    let ok = unsafe {
        CreateWellKnownSid(
            WinCapabilityInternetClientSid,
            std::ptr::null_mut(),
            sid.as_mut_ptr() as _,
            &mut bytes,
        )
    };
    if ok == 0 {
        return Err(Error::new(
            5240,
            "Hexbot could not allow network for this command.",
        ));
    }
    Ok(sid)
}

#[cfg(windows)]
fn container_trustee(
    container: &AppContainer,
) -> windows_sys::Win32::Security::Authorization::TRUSTEE_W {
    use windows_sys::Win32::Security::Authorization::{
        TRUSTEE_IS_SID, TRUSTEE_IS_UNKNOWN, TRUSTEE_W,
    };
    let mut trustee: TRUSTEE_W = unsafe { std::mem::zeroed() };
    trustee.TrusteeForm = TRUSTEE_IS_SID;
    trustee.TrusteeType = TRUSTEE_IS_UNKNOWN;
    trustee.ptstrName = container.sid as *mut u16;
    trustee
}

#[cfg(windows)]
fn set_container_ace(container: &AppContainer, path: &Path, write: bool, deny: bool) -> Result<()> {
    use windows_sys::Win32::Security::Authorization::{DENY_ACCESS, GRANT_ACCESS};
    use windows_sys::Win32::Security::{CONTAINER_INHERIT_ACE, OBJECT_INHERIT_ACE};
    // Drop an earlier ACE for this same launch before writing the new one.
    // A write grant must not survive a later read-only grant on this path.
    revoke_container_ace(container, path)?;
    let access = if deny {
        0x001F_01FF
    } else if write {
        0x0012_019F
    } else {
        0x0012_0089
    };
    let mut entry: windows_sys::Win32::Security::Authorization::EXPLICIT_ACCESS_W =
        unsafe { std::mem::zeroed() };
    entry.grfAccessPermissions = access;
    entry.grfAccessMode = if deny { DENY_ACCESS } else { GRANT_ACCESS };
    entry.grfInheritance = OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE;
    entry.Trustee = container_trustee(container);
    write_container_ace(path, &entry, false)
}

#[cfg(windows)]
fn revoke_container_ace(container: &AppContainer, path: &Path) -> Result<()> {
    use windows_sys::Win32::Security::Authorization::REVOKE_ACCESS;
    let mut entry: windows_sys::Win32::Security::Authorization::EXPLICIT_ACCESS_W =
        unsafe { std::mem::zeroed() };
    entry.grfAccessMode = REVOKE_ACCESS;
    entry.Trustee = container_trustee(container);
    write_container_ace(path, &entry, true)
}

#[cfg(windows)]
fn write_container_ace(
    path: &Path,
    entry: &windows_sys::Win32::Security::Authorization::EXPLICIT_ACCESS_W,
    ignore_missing: bool,
) -> Result<()> {
    use windows_sys::Win32::Security::Authorization::{
        GetNamedSecurityInfoW, SetEntriesInAclW, SetNamedSecurityInfoW, SE_FILE_OBJECT,
    };
    use windows_sys::Win32::Security::{ACL, DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR};
    let wide_path = wide(path.as_os_str());
    let mut descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
    let mut dacl: *mut ACL = std::ptr::null_mut();
    let read = unsafe {
        GetNamedSecurityInfoW(
            wide_path.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut dacl,
            std::ptr::null_mut(),
            &mut descriptor,
        )
    };
    if read != 0 {
        unsafe {
            if !descriptor.is_null() {
                windows_sys::Win32::Foundation::LocalFree(descriptor);
            }
        }
        return Err(Error::new(
            5240,
            "Hexbot could not read the sandbox directory permissions.",
        ));
    }
    if dacl.is_null() {
        unsafe {
            if !descriptor.is_null() {
                windows_sys::Win32::Foundation::LocalFree(descriptor);
            }
        }
        // A null DACL means every account is allowed. Replacing it with only
        // the sandbox ACE would lock the owner out, so a revoke is a no-op
        // and a grant refuses to run.
        return if ignore_missing {
            Ok(())
        } else {
            Err(Error::new(
                5240,
                "Hexbot could not read the sandbox directory permissions.",
            ))
        };
    }
    let mut new_dacl: *mut ACL = std::ptr::null_mut();
    let merged = unsafe { SetEntriesInAclW(1, entry, dacl, &mut new_dacl) };
    let wrote = if merged == 0 && !new_dacl.is_null() {
        unsafe {
            SetNamedSecurityInfoW(
                wide_path.as_ptr() as *mut u16,
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                new_dacl,
                std::ptr::null_mut(),
            )
        }
    } else if merged == 0 && ignore_missing {
        0
    } else {
        merged
    };
    unsafe {
        if !new_dacl.is_null() {
            windows_sys::Win32::Foundation::LocalFree(new_dacl as _);
        }
        if !descriptor.is_null() {
            windows_sys::Win32::Foundation::LocalFree(descriptor);
        }
    }
    if wrote != 0 {
        Err(Error::new(
            5240,
            "Hexbot could not apply the Windows sandbox permissions.",
        ))
    } else {
        Ok(())
    }
}

#[cfg(windows)]
fn job_object(limit: u32) -> Result<windows_sys::Win32::Foundation::HANDLE> {
    use windows_sys::Win32::System::JobObjects::{
        CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_ACTIVE_PROCESS, JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
    if job.is_null() {
        return Err(Error::new(
            5240,
            "Hexbot could not cap processes for the sandbox.",
        ));
    }
    let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
    // Keep the job handle until the process exits: closing it earlier kills
    // the command because of KILL_ON_JOB_CLOSE.
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION
        | if limit > 0 {
            JOB_OBJECT_LIMIT_ACTIVE_PROCESS
        } else {
            0
        };
    limits.BasicLimitInformation.ActiveProcessLimit = limit;
    let set = unsafe {
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &limits as *const _ as *const _,
            std::mem::size_of_val(&limits) as u32,
        )
    };
    if set == 0 {
        unsafe { windows_sys::Win32::Foundation::CloseHandle(job) };
        return Err(Error::new(
            5240,
            "Hexbot could not cap processes for the sandbox.",
        ));
    }
    Ok(job)
}

#[cfg(windows)]
struct Process {
    process: windows_sys::Win32::Foundation::HANDLE,
    thread: windows_sys::Win32::Foundation::HANDLE,
}

#[cfg(windows)]
fn create_confined(
    program: &Path,
    args: &[String],
    cwd: &Path,
    container: &AppContainer,
    network: bool,
) -> Result<Process> {
    use windows_sys::Win32::Security::{SECURITY_CAPABILITIES, SID_AND_ATTRIBUTES};
    use windows_sys::Win32::System::Console::{
        GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
    };
    use windows_sys::Win32::System::Threading::{
        CreateProcessW, DeleteProcThreadAttributeList, InitializeProcThreadAttributeList,
        UpdateProcThreadAttribute, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT,
        EXTENDED_STARTUPINFO_PRESENT, PROCESS_INFORMATION,
        PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, STARTF_USESTDHANDLES, STARTUPINFOEXW,
        STARTUPINFOW,
    };
    let mut size = 0usize;
    unsafe { InitializeProcThreadAttributeList(std::ptr::null_mut(), 1, 0, &mut size) };
    if size == 0 {
        return Err(Error::new(
            5240,
            "Hexbot could not create the Windows sandbox.",
        ));
    }
    #[repr(C, align(16))]
    #[derive(Clone, Copy)]
    struct AlignedByte(u8);
    let mut buffer = vec![AlignedByte(0); size];
    let list = buffer.as_mut_ptr().cast();
    if unsafe { InitializeProcThreadAttributeList(list, 1, 0, &mut size) } == 0 {
        return Err(Error::new(
            5240,
            "Hexbot could not create the Windows sandbox.",
        ));
    }
    let mut capability = SID_AND_ATTRIBUTES {
        Sid: container.network.as_ptr() as _,
        Attributes: windows_sys::Win32::System::SystemServices::SE_GROUP_ENABLED as u32,
    };
    let mut capabilities = SECURITY_CAPABILITIES {
        AppContainerSid: container.sid,
        Capabilities: if network {
            &mut capability
        } else {
            std::ptr::null_mut()
        },
        CapabilityCount: if network { 1 } else { 0 },
        Reserved: 0,
    };
    let updated = unsafe {
        UpdateProcThreadAttribute(
            list,
            0,
            PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES as usize,
            &mut capabilities as *mut _ as *mut _,
            std::mem::size_of::<SECURITY_CAPABILITIES>(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    if updated == 0 {
        unsafe { DeleteProcThreadAttributeList(list) };
        return Err(Error::new(
            5240,
            "Hexbot could not create the Windows sandbox.",
        ));
    }
    let mut startup: STARTUPINFOEXW = unsafe { std::mem::zeroed() };
    startup.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = unsafe { GetStdHandle(STD_INPUT_HANDLE) };
    startup.StartupInfo.hStdOutput = unsafe { GetStdHandle(STD_OUTPUT_HANDLE) };
    startup.StartupInfo.hStdError = unsafe { GetStdHandle(STD_ERROR_HANDLE) };
    startup.lpAttributeList = list;
    let mut info: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
    let application = wide(program.as_os_str());
    let mut command = command_line_wide(program, args);
    let directory = wide(cwd.as_os_str());
    let mut environment = environment_block();
    let created = unsafe {
        CreateProcessW(
            application.as_ptr(),
            command.as_mut_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            1,
            EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT,
            environment.as_mut_ptr() as _,
            directory.as_ptr(),
            &startup as *const STARTUPINFOEXW as *const STARTUPINFOW,
            &mut info,
        )
    };
    unsafe { DeleteProcThreadAttributeList(list) };
    if created == 0 || info.hProcess.is_null() || info.hThread.is_null() {
        return Err(Error::new(
            5240,
            "Hexbot could not create the Windows sandbox.",
        ));
    }
    Ok(Process {
        process: info.hProcess,
        thread: info.hThread,
    })
}

#[cfg(windows)]
fn command_line_wide(program: &Path, args: &[String]) -> Vec<u16> {
    let mut parts = Vec::new();
    parts.push(quote_arg(&program.to_string_lossy()));
    for arg in args {
        parts.push(quote_arg(arg));
    }
    wide(std::ffi::OsStr::new(&parts.join(" ")))
}

#[cfg(windows)]
fn environment_block() -> Vec<u16> {
    let mut block = Vec::new();
    // The process that spawned this helper already applied the credential
    // allowlist, including provider-specific additions such as Copilot auth.
    // Filtering again would drop those. This process must not be started with
    // the daemon's raw environment.
    for (key, value) in std::env::vars() {
        if key.is_empty() || key.contains('=') || key.contains('\0') || value.contains('\0') {
            continue;
        }
        block.extend(wide(std::ffi::OsStr::new(&format!("{key}={value}"))));
    }
    if block.is_empty() {
        block.push(0);
    }
    block.push(0);
    block
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn confined_plan_drops_secret_roots_and_requires_a_cap() {
        let workspace = PathBuf::from("/work/app");
        let secret = PathBuf::from("/work/app/.ssh");
        let plan = prepare(
            false,
            Some(600),
            true,
            &[workspace.clone()],
            &[workspace.clone(), PathBuf::from("/usr/bin")],
            &[secret.clone(), PathBuf::from("/home/me/.aws")],
            false,
        )
        .unwrap();
        assert!(!plan.network);
        assert_eq!(plan.process_limit, 600);
        assert!(plan
            .allow
            .iter()
            .any(|grant| grant.path == workspace && grant.write));
        assert!(!plan.allow.iter().any(|grant| grant.path == secret));
        assert!(plan.deny.iter().any(|path| path == &secret));
        assert!(prepare(false, None, true, &[workspace.clone()], &[], &[], false).is_err());
    }

    #[test]
    fn a_secret_inside_the_workspace_stays_denied() {
        let workspace = PathBuf::from("/work/app");
        let env = PathBuf::from("/work/app/.env");
        let plan = prepare(
            false,
            Some(10),
            true,
            &[workspace.clone()],
            &[],
            &[env.clone()],
            true,
        )
        .unwrap();
        assert_eq!(
            plan.allow,
            vec![Grant {
                path: workspace,
                write: true
            }]
        );
        assert_eq!(plan.deny, vec![env]);
    }

    #[test]
    fn full_access_may_skip_the_process_cap_and_still_needs_a_directory() {
        let home = PathBuf::from("/Users/me");
        let plan = prepare(true, None, false, &[home.clone()], &[], &[], false).unwrap();
        assert!(plan.network);
        assert_eq!(plan.process_limit, 0);
        assert!(prepare(true, None, false, &[], &[], &[], false).is_err());
        assert!(prepare(
            false,
            Some(1),
            true,
            &[PathBuf::from("relative")],
            &[],
            &[],
            false
        )
        .is_err());
    }

    #[test]
    fn command_line_quotes_match_create_process() {
        assert_eq!(quote_arg("cmd"), "cmd");
        assert_eq!(quote_arg(""), "\"\"");
        assert_eq!(quote_arg("echo hi"), "\"echo hi\"");
        assert_eq!(quote_arg(r#"say "hi""#), r#""say \"hi\"""#);
        assert_eq!(quote_arg(r"C:\work dir\"), "\"C:\\work dir\\\\\"");
    }

    #[test]
    fn plans_round_trip_through_a_private_file() {
        let directory = tempfile::tempdir().unwrap();
        let plan = prepare(
            false,
            Some(32),
            true,
            &[PathBuf::from("/work")],
            &[],
            &[PathBuf::from("/work/.env")],
            false,
        )
        .unwrap();
        let path = write_plan(directory.path(), &plan).unwrap();
        assert!(path.is_file());
        let read = read_plan(&path).unwrap();
        assert_eq!(read, plan);
        assert!(!path.exists());
    }
}
