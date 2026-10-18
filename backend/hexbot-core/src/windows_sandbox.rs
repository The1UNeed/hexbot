//! Native Windows tool isolation. A fresh AppContainer SID is granted only the
//! selected roots. No network capabilities are present. A kill-on-close job
//! contains the complete process tree before the first instruction executes.
//!
//! This helper is intentionally separate from the daemon process: CreateProcess
//! security attributes apply only to the untrusted child, never to Pi or Rust.
use crate::{Error, Result, credentials, platform};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    ffi::{OsStr, OsString, c_void},
    fs,
    mem::{size_of, size_of_val, zeroed},
    os::windows::{
        ffi::OsStrExt,
        io::{AsRawHandle, FromRawHandle, OwnedHandle},
    },
    path::{Path, PathBuf},
    ptr::{null, null_mut},
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Foundation::{DUPLICATE_SAME_ACCESS, DuplicateHandle, HANDLE, LocalFree, WAIT_OBJECT_0},
    Security::{
        ACL,
        Authorization::{
            ACCESS_MODE, BuildTrusteeWithSidW, ConvertSidToStringSidW, ConvertStringSidToSidW,
            DENY_ACCESS, EXPLICIT_ACCESS_W, GRANT_ACCESS, GetNamedSecurityInfoW, REVOKE_ACCESS,
            SE_FILE_OBJECT, SetEntriesInAclW, SetNamedSecurityInfoW,
        },
        DACL_SECURITY_INFORMATION, FreeSid,
        Isolation::{
            CreateAppContainerProfile, DeleteAppContainerProfile, GetAppContainerFolderPath,
        },
        PSECURITY_DESCRIPTOR, PSID, SECURITY_CAPABILITIES, SUB_CONTAINERS_AND_OBJECTS_INHERIT,
    },
    Storage::FileSystem::{
        DELETE, FILE_APPEND_DATA, FILE_DELETE_CHILD, FILE_GENERIC_EXECUTE, FILE_GENERIC_READ,
        FILE_GENERIC_WRITE, FILE_WRITE_ATTRIBUTES, FILE_WRITE_DATA, FILE_WRITE_EA, WRITE_DAC,
        WRITE_OWNER,
    },
    System::{
        Com::CoTaskMemFree,
        JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_ACTIVE_PROCESS,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectBasicAccountingInformation,
            JobObjectExtendedLimitInformation, OpenJobObjectW, QueryInformationJobObject,
            SetInformationJobObject, TerminateJobObject,
        },
        Threading::{
            CREATE_NO_WINDOW, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, CreateProcessW,
            DeleteProcThreadAttributeList, EXTENDED_STARTUPINFO_PRESENT, GetCurrentProcess,
            GetExitCodeProcess, InitializeProcThreadAttributeList, LPPROC_THREAD_ATTRIBUTE_LIST,
            PROC_THREAD_ATTRIBUTE_HANDLE_LIST, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
            PROCESS_INFORMATION, ResumeThread, STARTF_USESTDHANDLES, STARTUPINFOEXW,
            TerminateProcess, UpdateProcThreadAttribute, WaitForSingleObject,
        },
    },
};
const WRITE: u32 = FILE_WRITE_DATA
    | FILE_APPEND_DATA
    | FILE_WRITE_EA
    | FILE_WRITE_ATTRIBUTES
    | FILE_DELETE_CHILD
    | DELETE
    | WRITE_DAC
    | WRITE_OWNER;
const CONTROL: u32 = FILE_DELETE_CHILD | WRITE_DAC | WRITE_OWNER;
const READ: u32 = FILE_GENERIC_READ | FILE_GENERIC_EXECUTE;
const ALL: u32 = READ | FILE_GENERIC_WRITE | WRITE;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Spec {
    pub home: PathBuf,
    pub read_roots: Vec<PathBuf>,
    pub write_roots: Vec<PathBuf>,
    pub id: String,
    #[serde(default)]
    pub git_env: BTreeMap<String, String>,
    #[serde(default)]
    pub read_only: bool,
}
pub fn git_scan_environment() -> BTreeMap<String, String> {
    [
        "HOME",
        "GIT_CONFIG_GLOBAL",
        "GIT_CONFIG_SYSTEM",
        "GIT_CONFIG_NOSYSTEM",
        "XDG_CONFIG_HOME",
    ]
    .into_iter()
    .filter_map(|name| {
        std::env::var(name)
            .ok()
            .map(|value| (name.to_owned(), value))
    })
    .collect()
}
fn helper_executable() -> Result<PathBuf> {
    let executable = std::env::var_os("HEXBOT_DAEMON_EXECUTABLE")
        .map(PathBuf::from)
        .map_or_else(std::env::current_exe, Ok)?;
    platform::validate_local_path(&executable)?;
    if !executable.is_absolute()
        || !executable.is_file()
        || executable
            .file_stem()
            .is_none_or(|name| !name.eq_ignore_ascii_case("hexbot"))
    {
        return Err(failed("the native Hexbot executable is unavailable"));
    }
    Ok(executable)
}
const PROTOTYPE_DISABLED: &str = "the Windows AppContainer prototype is disabled because concurrent filesystem ACL changes are not yet safely contained";
/// Production stays fail-closed until the concurrent ACL/junction and output
/// parent races pass independent review and real Windows adversarial tests.
/// A successful startup probe alone does not establish that boundary.
pub fn available() -> bool {
    false
}
pub(crate) fn command(
    home: &Path,
    program: &str,
    readable: &[PathBuf],
    writable: &[PathBuf],
    read_only: bool,
) -> Result<tokio::process::Command> {
    if !available() {
        return Err(failed(PROTOTYPE_DISABLED));
    }
    platform::validate_local_path(home)?;
    let spec = Spec {
        home: home.canonicalize()?,
        read_roots: readable.to_vec(),
        write_roots: writable.to_vec(),
        id: uuid::Uuid::new_v4().to_string(),
        git_env: git_scan_environment(),
        read_only,
    };
    let mut command = tokio::process::Command::new(helper_executable()?);
    command
        .arg("__sandbox")
        .arg(serde_json::to_string(&spec).map_err(failed)?)
        .arg("--")
        .arg(program);
    Ok(command)
}
#[derive(Deserialize, Serialize)]
struct Lease {
    profile: String,
    job: String,
    sid: String,
    helper_pid: u32,
    #[serde(default)]
    helper_started: u64,
    paths: Vec<PathBuf>,
}
fn failed(context: impl std::fmt::Display) -> Error {
    Error::new(5240, format!("Windows sandbox: {context}"))
}
fn last(context: &str) -> Error {
    failed(format!("{context}: {}", std::io::Error::last_os_error()))
}
fn wide(value: impl AsRef<OsStr>) -> Vec<u16> {
    value.as_ref().encode_wide().chain([0]).collect()
}
unsafe fn wide_string(value: *const u16) -> String {
    let mut length = 0;
    while unsafe { *value.add(length) } != 0 {
        length += 1;
    }
    String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(value, length) })
}
struct AppSid(PSID);
impl Drop for AppSid {
    fn drop(&mut self) {
        unsafe { FreeSid(self.0) };
    }
}
struct Local(*mut c_void);
impl Drop for Local {
    fn drop(&mut self) {
        unsafe { LocalFree(self.0) };
    }
}
fn sid_text(sid: PSID) -> Result<String> {
    let mut text = null_mut();
    if unsafe { ConvertSidToStringSidW(sid, &mut text) } == 0 {
        return Err(last("encode SID"));
    }
    let _owned = Local(text.cast());
    Ok(unsafe { wide_string(text) })
}
fn parse_sid(text: &str) -> Result<Local> {
    let mut sid = null_mut();
    if unsafe { ConvertStringSidToSidW(wide(text).as_ptr(), &mut sid) } == 0 {
        return Err(last("decode SID"));
    }
    Ok(Local(sid))
}
/// Windows counterpart of mode 0700/0600. Apply to a newly-created home and to
/// a credential temporary file before its atomic rename, never afterwards.
fn current_user_sid() -> Result<String> {
    use windows_sys::Win32::Security::{GetTokenInformation, TOKEN_QUERY, TOKEN_USER, TokenUser};
    use windows_sys::Win32::System::Threading::OpenProcessToken;
    let mut raw = null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut raw) } == 0 {
        return Err(last("open current user token"));
    }
    let token = unsafe { OwnedHandle::from_raw_handle(raw) };
    let mut size = 0;
    unsafe { GetTokenInformation(token.as_raw_handle(), TokenUser, null_mut(), 0, &mut size) };
    let mut buffer = vec![0usize; (size as usize).div_ceil(size_of::<usize>())];
    if unsafe {
        GetTokenInformation(
            token.as_raw_handle(),
            TokenUser,
            buffer.as_mut_ptr().cast(),
            size,
            &mut size,
        )
    } == 0
    {
        return Err(last("read current user token"));
    }
    let user = unsafe { &*buffer.as_ptr().cast::<TOKEN_USER>() };
    sid_text(user.User.Sid)
}
struct AclLock(OwnedHandle);
impl AclLock {
    fn acquire() -> Result<Self> {
        use windows_sys::Win32::System::Threading::CreateMutexW;
        let name = format!("Global\\HexbotAclMutation-{}", current_user_sid()?);
        let raw = unsafe { CreateMutexW(null(), 0, wide(&name).as_ptr()) };
        if raw.is_null() {
            return Err(last("create ACL mutation lock"));
        }
        let mutex = unsafe { OwnedHandle::from_raw_handle(raw) };
        let wait = unsafe { WaitForSingleObject(mutex.as_raw_handle(), 30000) };
        if wait != WAIT_OBJECT_0 && wait != 128 {
            return Err(failed("could not acquire ACL mutation lock"));
        }
        Ok(Self(mutex))
    }
}
impl Drop for AclLock {
    fn drop(&mut self) {
        unsafe { windows_sys::Win32::System::Threading::ReleaseMutex(self.0.as_raw_handle()) };
    }
}
fn private_descriptor(directory: bool) -> Result<Local> {
    private_descriptor_with_inheritance(directory, false)
}
fn private_descriptor_with_inheritance(directory: bool, inherit_parent: bool) -> Result<Local> {
    use windows_sys::Win32::Security::Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW;
    let sid = current_user_sid()?;
    let inherit = if directory { "OICI" } else { "" };
    let protection = if inherit_parent { "" } else { "P" };
    let sddl = format!("D:{protection}(A;{inherit};FA;;;SY)(A;{inherit};FA;;;{sid})");
    let mut descriptor = null_mut();
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            wide(&sddl).as_ptr(),
            1,
            &mut descriptor,
            null_mut(),
        )
    } == 0
    {
        return Err(last("build private permissions"));
    }
    Ok(Local(descriptor))
}
pub fn protect_private_path(path: &Path, directory: bool) -> Result<()> {
    use windows_sys::Win32::Security::{
        GetSecurityDescriptorDacl, PROTECTED_DACL_SECURITY_INFORMATION,
    };
    platform::validate_local_path(path)?;
    let descriptor = private_descriptor(directory)?;
    let (mut present, mut defaulted, mut acl) = (0, 0, null_mut());
    if unsafe { GetSecurityDescriptorDacl(descriptor.0, &mut present, &mut acl, &mut defaulted) }
        == 0
        || present == 0
    {
        return Err(last("read private permissions"));
    }
    let _lock = AclLock::acquire()?;
    let result = unsafe {
        SetNamedSecurityInfoW(
            wide(path.as_os_str()).as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            acl,
            null(),
        )
    };
    if result != 0 {
        return Err(failed(format!(
            "set private permissions for {}: {result}",
            path.display()
        )));
    }
    Ok(())
}
/// Create an empty temporary file with its private DACL in the same system
/// call that creates the file. No other account can retain an early read handle.
pub fn private_tempfile_in(parent: &Path) -> Result<tempfile::NamedTempFile> {
    create_tempfile(parent, private_descriptor(false)?)
}
fn create_tempfile(parent: &Path, descriptor: Local) -> Result<tempfile::NamedTempFile> {
    use windows_sys::Win32::{
        Foundation::{GENERIC_READ, GENERIC_WRITE, INVALID_HANDLE_VALUE},
        Security::SECURITY_ATTRIBUTES,
        Storage::FileSystem::{
            CREATE_NEW, CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_DELETE, FILE_SHARE_READ,
            FILE_SHARE_WRITE,
        },
    };
    platform::validate_local_path(parent)?;
    let attributes = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor.0,
        bInheritHandle: 0,
    };
    Ok(tempfile::Builder::new().make_in(parent, |path| {
        let handle = unsafe {
            CreateFileW(
                wide(path.as_os_str()).as_ptr(),
                GENERIC_READ | GENERIC_WRITE,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                &attributes,
                CREATE_NEW,
                FILE_ATTRIBUTE_NORMAL,
                null_mut(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            return Err(std::io::Error::last_os_error());
        }
        Ok(unsafe { fs::File::from_raw_handle(handle) })
    })?)
}
fn output_home(path: &Path) -> Option<PathBuf> {
    for ancestor in path.ancestors() {
        let name = ancestor.file_name()?;
        if name.eq_ignore_ascii_case("artifacts") {
            let profiles = ancestor.parent()?.parent()?;
            if profiles.file_name()?.eq_ignore_ascii_case("profiles") {
                return profiles.parent().map(Path::to_owned);
            }
        }
        if name.eq_ignore_ascii_case("attachments") {
            let sessions = ancestor.parent()?.parent()?;
            if sessions.file_name()?.eq_ignore_ascii_case("sessions")
                && sessions
                    .parent()?
                    .file_name()?
                    .eq_ignore_ascii_case("runtime")
            {
                return sessions.parent()?.parent().map(Path::to_owned);
            }
        }
    }
    None
}
fn verified_active_sids(home: &Path) -> Result<Vec<String>> {
    let dir = home.join("runtime/windows-sandbox");
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(error) => return Err(error.into()),
    };
    let mut sids = vec![];
    for (count, entry) in entries.enumerate() {
        if count >= 1000 {
            return Err(failed(
                "too many sandbox leases to verify output permissions",
            ));
        }
        let entry = entry?;
        if entry
            .path()
            .extension()
            .is_none_or(|extension| extension != "json")
        {
            continue;
        }
        if !entry.file_type()?.is_file() {
            return Err(failed("unexpected sandbox lease entry"));
        }
        let bytes = match fs::read(entry.path()) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
        };
        let lease: Lease = serde_json::from_slice(&bytes).map_err(failed)?;
        if lease_active(&lease)? {
            let mut raw = null_mut();
            let result = unsafe {
                windows_sys::Win32::Security::Isolation::DeriveAppContainerSidFromAppContainerName(
                    wide(&lease.profile).as_ptr(),
                    &mut raw,
                )
            };
            if result < 0 {
                return Err(failed("cannot verify output AppContainer identity"));
            }
            let sid = AppSid(raw);
            if sid_text(sid.0)? != lease.sid {
                return Err(failed("sandbox lease SID does not match its profile"));
            }
            sids.push(lease.sid);
        }
    }
    Ok(sids)
}
fn safe_output_parent(parent: &Path, home: &Path) -> Result<bool> {
    use windows_sys::Win32::Security::{ACCESS_ALLOWED_ACE, ACE_HEADER, GetAce};
    let current = current_user_sid()?;
    let allowed = verified_active_sids(home)?;
    let mut acl = null_mut();
    let mut descriptor = null_mut();
    let result = unsafe {
        GetNamedSecurityInfoW(
            wide(parent.as_os_str()).as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            &mut acl,
            null_mut(),
            &mut descriptor,
        )
    };
    if result != 0 {
        return Err(failed(format!("read output-folder permissions: {result}")));
    }
    let _descriptor = Local(descriptor);
    if acl.is_null() {
        return Ok(false);
    }
    for index in 0..u32::from(unsafe { (*acl).AceCount }) {
        let mut raw = null_mut();
        if unsafe { GetAce(acl, index, &mut raw) } == 0 {
            return Err(last("read output-folder ACE"));
        }
        let header = unsafe { &*raw.cast::<ACE_HEADER>() };
        if header.AceType == 1 {
            continue;
        }
        if header.AceType != 0 {
            return Ok(false);
        }
        let ace = raw.cast::<ACCESS_ALLOWED_ACE>();
        let sid = sid_text(unsafe { std::ptr::addr_of!((*ace).SidStart).cast_mut().cast() })?;
        if sid != current && sid != "S-1-5-18" && !allowed.contains(&sid) {
            return Ok(false);
        }
    }
    Ok(true)
}
/// Selected outputs inherit the private folder's current and future sandbox
/// grants. Secret files always keep their protected user/SYSTEM-only DACL.
pub fn private_tempfile_for(destination: &Path) -> Result<tempfile::NamedTempFile> {
    let parent = destination
        .parent()
        .ok_or_else(|| failed("invalid output path"))?;
    if let Some(home) = output_home(destination)
        && !credentials::private_file_path(destination)
    {
        let _lock = AclLock::acquire()?;
        if !safe_output_parent(parent, &home)? {
            return Err(failed(
                "the output folder has permissions that cannot be shared safely",
            ));
        }
        create_tempfile(parent, private_descriptor_with_inheritance(false, true)?)
    } else {
        private_tempfile_in(parent)
    }
}
fn make_output_inheritable(path: &Path, home: &Path) -> Result<()> {
    use windows_sys::Win32::Security::UNPROTECTED_DACL_SECURITY_INFORMATION;
    let _lock = AclLock::acquire()?;
    let parent = path.parent().ok_or_else(|| failed("invalid output path"))?;
    if !safe_output_parent(parent, home)? {
        return Err(failed(
            "the output folder has permissions that cannot be shared safely",
        ));
    }
    let mut acl = null_mut();
    let mut descriptor = null_mut();
    let result = unsafe {
        GetNamedSecurityInfoW(
            wide(path.as_os_str()).as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            &mut acl,
            null_mut(),
            &mut descriptor,
        )
    };
    if result != 0 {
        return Err(failed(format!("read output permissions: {result}")));
    }
    let _descriptor = Local(descriptor);
    if acl.is_null() {
        return Err(failed("an output has no discretionary ACL"));
    }
    let result = unsafe {
        SetNamedSecurityInfoW(
            wide(path.as_os_str()).as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | UNPROTECTED_DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            acl,
            null(),
        )
    };
    if result != 0 {
        return Err(failed(format!(
            "inherit private output permissions: {result}"
        )));
    }
    Ok(())
}
/// New directories receive their private DACL at creation. Existing selected
/// homes are repaired before the daemon opens or creates any credential files.
pub fn create_private_dir_all(path: &Path) -> Result<()> {
    use windows_sys::Win32::{
        Security::SECURITY_ATTRIBUTES, Storage::FileSystem::CreateDirectoryW,
    };
    platform::validate_local_path(path)?;
    if path.is_dir() {
        return protect_private_path(path, true);
    }
    if let Some(parent) = path.parent().filter(|parent| !parent.is_dir()) {
        create_private_dir_all(parent)?;
    }
    let descriptor = private_descriptor(true)?;
    let attributes = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor.0,
        bInheritHandle: 0,
    };
    if unsafe { CreateDirectoryW(wide(path.as_os_str()).as_ptr(), &attributes) } == 0 {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() != Some(183) {
            return Err(error.into());
        }
        protect_private_path(path, true)?;
    }
    Ok(())
}
fn lease_path(home: &Path, id: &str) -> Result<PathBuf> {
    if uuid::Uuid::parse_str(id).is_err()
        || id.len() != 36
        || !id.bytes().all(|c| c.is_ascii_hexdigit() || c == b'-')
    {
        return Err(failed("invalid sandbox identifier"));
    }
    platform::validate_local_path(home)?;
    if !home.is_absolute() {
        return Err(failed("home must be absolute"));
    }
    Ok(home
        .join("runtime/windows-sandbox")
        .join(format!("{id}.json")))
}
/// Retained by the daemon's process-tree guard as well as the helper. Revocation
/// is idempotent, and can happen only after the helper and its job have stopped.
pub struct SandboxCleanup {
    path: PathBuf,
}
pub fn cleanup_command(command: &std::process::Command) -> Option<SandboxCleanup> {
    let mut args = command.get_args();
    if args.next()? != "__sandbox" {
        return None;
    }
    let spec: Spec = serde_json::from_str(args.next()?.to_str()?).ok()?;
    Some(SandboxCleanup {
        path: lease_path(&spec.home, &spec.id).ok()?,
    })
}
fn process_started(pid: u32) -> Result<Option<u64>> {
    use windows_sys::Win32::{
        Foundation::FILETIME,
        System::Threading::{
            GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
        },
    };
    let raw = unsafe {
        OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
            0,
            pid,
        )
    };
    if raw.is_null() {
        let error = std::io::Error::last_os_error();
        return if error.raw_os_error() == Some(87) {
            Ok(None)
        } else {
            Err(error.into())
        };
    }
    let handle = unsafe { OwnedHandle::from_raw_handle(raw) };
    if unsafe { WaitForSingleObject(handle.as_raw_handle(), 0) } == WAIT_OBJECT_0 {
        return Ok(None);
    }
    let (mut created, mut exited, mut kernel, mut user): (FILETIME, FILETIME, FILETIME, FILETIME) =
        unsafe { zeroed() };
    if unsafe {
        GetProcessTimes(
            handle.as_raw_handle(),
            &mut created,
            &mut exited,
            &mut kernel,
            &mut user,
        )
    } == 0
    {
        return Err(last("read helper process identity"));
    }
    Ok(Some(
        (u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime),
    ))
}
fn lease_active(lease: &Lease) -> Result<bool> {
    Ok(process_started(lease.helper_pid)?
        .is_some_and(|started| lease.helper_started == 0 || started == lease.helper_started))
}
/// Repair interrupted runs after acquiring the daemon's home lock. Never touch
/// a live helper, including one whose PID was subsequently reused.
pub fn recover_stale(home: &Path) -> Result<()> {
    let dir = home.join("runtime/windows-sandbox");
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    for (count, entry) in entries.enumerate() {
        if count >= 1000 {
            return Err(failed("too many interrupted sandbox leases to recover"));
        }
        let entry = entry?;
        if entry
            .path()
            .extension()
            .is_none_or(|extension| extension != "json")
        {
            continue;
        }
        if !entry.file_type()?.is_file() {
            return Err(failed("unexpected sandbox lease entry"));
        }
        let lease: Lease = serde_json::from_slice(&fs::read(entry.path())?).map_err(failed)?;
        if !lease_active(&lease)? {
            SandboxCleanup { path: entry.path() }.cleanup()?;
        }
    }
    Ok(())
}
impl SandboxCleanup {
    pub fn cleanup(&mut self) -> Result<()> {
        let bytes = match fs::read(&self.path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error.into()),
        };
        let lease: Lease = serde_json::from_slice(&bytes).map_err(failed)?;
        if lease.helper_pid != std::process::id() {
            let start = Instant::now();
            while lease_active(&lease)? {
                if start.elapsed() > Duration::from_secs(5) {
                    return Err(failed(
                        "cannot remove permissions while its helper is running",
                    ));
                }
                std::thread::sleep(Duration::from_millis(5));
            }
        }
        // A killed launcher closes its job handle, which kills descendants.
        // Open the named job when it still exists and wait for termination
        // before touching ACLs, even when cleanup came from Pi's timeout path.
        let raw = unsafe { OpenJobObjectW(4 | 8, 0, wide(&lease.job).as_ptr()) };
        if !raw.is_null() {
            let job = unsafe { OwnedHandle::from_raw_handle(raw) };
            stop_job(job.as_raw_handle())?;
        } else if std::io::Error::last_os_error().raw_os_error() != Some(2) {
            return Err(last("open sandbox job for cleanup"));
        }
        let sid = parse_sid(&lease.sid)?;
        // Do not restore a snapshot of the DACL: another section can have a
        // concurrent lease. Remove only this run's unique SID entries.
        for path in lease.paths.iter().rev() {
            if path.exists() {
                edit_acl(path, sid.0, REVOKE_ACCESS, 0, true)?;
            }
        }
        let result = unsafe { DeleteAppContainerProfile(wide(&lease.profile).as_ptr()) };
        if result < 0 && result as u32 != 0x80070002 {
            return Err(failed(format!("delete profile: {result:#x}")));
        }
        fs::remove_file(&self.path)?;
        Ok(())
    }
}
fn output_root(home: &Path, path: &Path) -> bool {
    let Ok(local) = path.strip_prefix(home) else {
        return false;
    };
    let parts: Vec<_> = local.iter().collect();
    (parts.len() >= 3 && parts[0] == "profiles" && parts[2] == "artifacts")
        || (parts.len() >= 4
            && parts[0] == "runtime"
            && parts[1] == "sessions"
            && parts[3] == "attachments")
}
struct ProfileOnError(Option<Vec<u16>>);
impl Drop for ProfileOnError {
    fn drop(&mut self) {
        if let Some(name) = &self.0 {
            unsafe { DeleteAppContainerProfile(name.as_ptr()) };
        }
    }
}
struct Session {
    spec: Spec,
    lease: Lease,
    sid: AppSid,
    profile: PathBuf,
    cleanup: SandboxCleanup,
}
impl Session {
    fn new(mut spec: Spec) -> Result<Self> {
        let path = lease_path(&spec.home, &spec.id)?;
        spec.home = spec.home.canonicalize()?;
        for root in spec
            .read_roots
            .iter_mut()
            .chain(spec.write_roots.iter_mut())
        {
            platform::validate_local_path(root)?;
            if !root.is_absolute() {
                return Err(failed("sandbox roots must be absolute"));
            }
            *root = root.canonicalize()?;
            if !root.is_dir() {
                return Err(failed("sandbox roots must be directories"));
            }
        }
        let name = format!("hexbot.{}", spec.id);
        let mut derived = null_mut();
        let result = unsafe {
            windows_sys::Win32::Security::Isolation::DeriveAppContainerSidFromAppContainerName(
                wide(&name).as_ptr(),
                &mut derived,
            )
        };
        if result < 0 {
            return Err(failed(format!("derive AppContainer SID: {result:#x}")));
        }
        let derived = AppSid(derived);
        let lease = Lease {
            profile: name.clone(),
            job: format!("Local\\HexbotSandbox-{}", spec.id),
            sid: sid_text(derived.0)?,
            helper_pid: std::process::id(),
            helper_started: process_started(std::process::id())?
                .ok_or_else(|| failed("helper identity is unavailable"))?,
            paths: vec![],
        };
        let parent = path.parent().ok_or_else(|| failed("invalid lease path"))?;
        fs::create_dir_all(parent)?;
        let mut journal = private_tempfile_in(parent)?;
        use std::io::Write;
        journal.write_all(&serde_json::to_vec(&lease).map_err(failed)?)?;
        journal.as_file().sync_all()?;
        journal
            .persist_noclobber(&path)
            .map_err(|error| Error::from(error.error))?;
        let mut sid = null_mut();
        let result = unsafe {
            CreateAppContainerProfile(
                wide(&name).as_ptr(),
                wide("Hexbot tool").as_ptr(),
                wide("Temporary Hexbot tool sandbox").as_ptr(),
                null(),
                0,
                &mut sid,
            )
        };
        if result < 0 {
            let _ = fs::remove_file(&path);
            return Err(failed(format!("create profile: {result:#x}")));
        }
        let mut profile_on_error = ProfileOnError(Some(wide(&name)));
        let sid = AppSid(sid);
        let text = sid_text(sid.0)?;
        let mut profile = null_mut();
        let result = unsafe { GetAppContainerFolderPath(wide(&text).as_ptr(), &mut profile) };
        if result < 0 {
            unsafe { DeleteAppContainerProfile(wide(&name).as_ptr()) };
            return Err(failed(format!("find profile: {result:#x}")));
        }
        let profile_path = PathBuf::from(unsafe { wide_string(profile) });
        unsafe { CoTaskMemFree(profile.cast()) };
        if lease.sid != text {
            return Err(failed("AppContainer SID changed during creation"));
        }
        let session = Self {
            spec,
            lease,
            sid,
            profile: profile_path,
            cleanup: SandboxCleanup { path },
        };
        session.save()?;
        profile_on_error.0 = None;
        Ok(session)
    }
    fn save(&self) -> Result<()> {
        crate::common::atomic_write(
            &self.cleanup.path,
            &serde_json::to_vec(&self.lease).map_err(failed)?,
        )
    }
    fn edit(&mut self, path: &Path, mode: ACCESS_MODE, rights: u32, inherit: bool) -> Result<()> {
        let path = path.canonicalize()?;
        if !self.lease.paths.contains(&path) {
            self.lease.paths.push(path.clone());
            // Record before modifying the DACL, so cancellation at every point
            // leaves enough information for the parent to undo the grant.
            self.save()?;
        }
        edit_acl(&path, self.sid.0, mode, rights, inherit)
    }
    fn prepare(&mut self, executable: &Path) -> Result<()> {
        let runtime = executable
            .parent()
            .filter(|runtime| {
                !["SystemRoot", "ProgramFiles", "ProgramFiles(x86)"]
                    .iter()
                    .filter_map(std::env::var_os)
                    .map(PathBuf::from)
                    .any(|root| credentials::under(runtime, &root))
            })
            .map(Path::to_owned);
        if let Some(runtime) = &runtime
            && !self
                .spec
                .read_roots
                .iter()
                .any(|root| credentials::under(runtime, root))
        {
            self.spec.read_roots.push(runtime.clone());
        }
        let (unreadable, unwritable) = credentials::windows_protection(
            &self.spec.home,
            &self.spec.read_roots,
            &self.spec.git_env,
        )?;
        self.spec.write_roots.retain(|root| {
            if !credentials::under(root, &self.spec.home) {
                return true;
            }
            let Ok(local) = root.strip_prefix(&self.spec.home) else {
                return false;
            };
            let parts: Vec<_> = local.iter().collect();
            (parts.len() >= 3 && parts[0] == "profiles" && parts[2] == "artifacts")
                || (parts.len() >= 4
                    && parts[0] == "runtime"
                    && parts[1] == "sessions"
                    && parts[3] == "attachments")
        });
        if self.spec.read_roots.iter().any(|root| {
            unreadable
                .iter()
                .any(|protected| credentials::under(root, protected))
        }) {
            return Err(failed(
                "a selected root is inside a protected credential directory",
            ));
        }
        if self.spec.write_roots.iter().any(|root| {
            unwritable
                .iter()
                .any(|protected| credentials::under(root, protected))
        }) {
            return Err(failed(
                "a writable root is inside protected configuration or Git metadata",
            ));
        }
        // An explicit home deny beats grants inherited from a broad workspace.
        // Explicit grants on validated output folders override the inherited
        // deny there without reopening any of the surrounding home.
        let home = self.spec.home.clone();
        self.edit(&home, DENY_ACCESS, WRITE, true)?;
        // Install protected child denies before inheritable root grants. No
        // command can run during ACL preparation.
        for (paths, mask) in [(&unreadable, ALL), (&unwritable, WRITE)] {
            for path in paths.iter().filter(|path| path.exists()) {
                // No need to modify credentials outside any granted tree.
                if self
                    .spec
                    .read_roots
                    .iter()
                    .chain(&self.spec.write_roots)
                    .any(|root| credentials::under(path, root))
                {
                    self.edit(path, DENY_ACCESS, mask, true)?;
                    let mut parent = path.parent();
                    while let Some(path) = parent.filter(|p| {
                        self.spec
                            .read_roots
                            .iter()
                            .chain(&self.spec.write_roots)
                            .any(|root| credentials::under(p, root))
                    }) {
                        self.edit(path, DENY_ACCESS, DELETE | CONTROL, false)?;
                        parent = path.parent();
                    }
                }
            }
        }
        let read_roots = self.spec.read_roots.clone();
        for root in read_roots {
            self.edit(&root, GRANT_ACCESS, READ, true)?;
            self.edit(&root, DENY_ACCESS, CONTROL, true)?;
            self.edit(&root, DENY_ACCESS, DELETE, false)?;
        }
        if let Some(runtime) = &runtime {
            self.edit(runtime, DENY_ACCESS, WRITE, true)?;
        }
        let write_roots = self.spec.write_roots.clone();
        for root in write_roots {
            self.edit(
                &root,
                GRANT_ACCESS,
                READ | FILE_GENERIC_WRITE | DELETE,
                true,
            )?;
            self.edit(&root, DENY_ACCESS, CONTROL, true)?;
            self.edit(&root, DENY_ACCESS, DELETE, false)?;
        }
        let output_roots: Vec<_> = self
            .spec
            .read_roots
            .iter()
            .filter(|root| output_root(&self.spec.home, root))
            .cloned()
            .collect();
        let mut visited = 0;
        for output in output_roots {
            let mut queue = std::collections::VecDeque::from([output]);
            while let Some(dir) = queue.pop_front() {
                for entry in fs::read_dir(&dir)? {
                    let entry = entry?;
                    visited += 1;
                    if visited > 50000 {
                        return Err(failed(
                            "selected output folders are too large to share safely",
                        ));
                    }
                    let path = entry.path();
                    let metadata = fs::symlink_metadata(&path)?;
                    if platform::is_link(&metadata) {
                        continue;
                    }
                    if unreadable
                        .iter()
                        .any(|protected| credentials::under(&path, protected))
                        || credentials::credential_name(&self.spec.home, &path)
                    {
                        continue;
                    }
                    if unwritable
                        .iter()
                        .any(|protected| credentials::under(&path, protected))
                    {
                        continue;
                    }
                    make_output_inheritable(&path, &self.spec.home)?;
                    if metadata.is_dir() {
                        queue.push_back(path);
                    }
                }
            }
        }
        // AppContainer profiles normally grant their SID Full Control. Replace
        // that grant before launch, including the directories created by Windows.
        let mut profile_paths = vec![self.profile.clone()];
        let mut at = 0;
        while at < profile_paths.len() {
            if profile_paths[at].is_dir() {
                for entry in fs::read_dir(&profile_paths[at])? {
                    let entry = entry?;
                    if platform::is_link(&entry.metadata()?) {
                        return Err(failed("unexpected profile link"));
                    }
                    profile_paths.push(entry.path());
                }
            }
            at += 1;
            if profile_paths.len() > 1000 {
                return Err(failed("unexpected profile contents"));
            }
        }
        for path in &profile_paths {
            self.edit(path, REVOKE_ACCESS, 0, true)?;
        }
        let profile = self.profile.clone();
        self.edit(
            &profile,
            GRANT_ACCESS,
            READ | if self.spec.read_only {
                0
            } else {
                FILE_GENERIC_WRITE | DELETE
            },
            true,
        )?;
        self.edit(
            &profile,
            DENY_ACCESS,
            if self.spec.read_only { WRITE } else { CONTROL },
            true,
        )?;
        Ok(())
    }
}
impl Drop for Session {
    fn drop(&mut self) {
        if let Err(error) = self.cleanup.cleanup() {
            eprintln!("{}", error.message);
        }
    }
}
fn edit_acl(path: &Path, sid: PSID, mode: ACCESS_MODE, rights: u32, inherit: bool) -> Result<()> {
    // Every launcher and cleanup process serializes the complete RMW and
    // inherited propagation, so another run's denies can never be overwritten.
    let _lock = AclLock::acquire()?;
    let mut old_acl: *mut ACL = null_mut();
    let mut descriptor: PSECURITY_DESCRIPTOR = null_mut();
    let name = wide(path.as_os_str());
    let result = unsafe {
        GetNamedSecurityInfoW(
            name.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            &mut old_acl,
            null_mut(),
            &mut descriptor,
        )
    };
    if result != 0 {
        return Err(failed(format!(
            "read permissions for {}: {result}",
            path.display()
        )));
    }
    let _descriptor = Local(descriptor);
    if old_acl.is_null() {
        return Err(failed(format!(
            "{} has no discretionary ACL",
            path.display()
        )));
    }
    let mut entry: EXPLICIT_ACCESS_W = unsafe { zeroed() };
    entry.grfAccessMode = mode;
    entry.grfAccessPermissions = rights;
    entry.grfInheritance = if inherit && path.is_dir() {
        SUB_CONTAINERS_AND_OBJECTS_INHERIT
    } else {
        0
    };
    unsafe { BuildTrusteeWithSidW(&mut entry.Trustee, sid) };
    let mut new_acl = null_mut();
    let result = unsafe { SetEntriesInAclW(1, &entry, old_acl, &mut new_acl) };
    if result != 0 {
        return Err(failed(format!(
            "build permissions for {}: {result}",
            path.display()
        )));
    }
    let _acl = Local(new_acl.cast());
    let result = unsafe {
        SetNamedSecurityInfoW(
            name.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            new_acl,
            null(),
        )
    };
    if result != 0 {
        return Err(failed(format!(
            "set permissions for {}: {result}",
            path.display()
        )));
    }
    Ok(())
}
fn executable(program: &OsStr) -> Result<PathBuf> {
    let path = PathBuf::from(program);
    let path = if path.is_absolute() {
        path
    } else {
        std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
            .flat_map(|root| [root.join(program), root.join(program).with_extension("exe")])
            .find(|candidate| {
                candidate.is_absolute()
                    && platform::validate_local_path(candidate).is_ok()
                    && candidate.is_file()
            })
            .ok_or_else(|| failed("executable was not found"))?
    };
    platform::validate_local_path(&path)?;
    if path
        .extension()
        .is_none_or(|ext| !ext.eq_ignore_ascii_case("exe") && !ext.eq_ignore_ascii_case("com"))
    {
        return Err(failed("sandbox programs must be native executables"));
    }
    Ok(path.canonicalize()?)
}
// Windows C runtime argument quoting. Do not feed arguments to cmd.exe or
// interpret shell metacharacters while constructing the trusted launcher.
fn quote(argument: &OsStr) -> Vec<u16> {
    let mut result = vec![b'"' as u16];
    let mut backslashes = 0;
    for unit in argument.encode_wide() {
        if unit == b'\\' as u16 {
            backslashes += 1;
            continue;
        }
        result.extend(std::iter::repeat_n(
            b'\\' as u16,
            backslashes * if unit == b'"' as u16 { 2 } else { 1 },
        ));
        if unit == b'"' as u16 {
            result.push(b'\\' as u16);
        }
        result.push(unit);
        backslashes = 0;
    }
    result.extend(std::iter::repeat_n(b'\\' as u16, backslashes * 2));
    result.push(b'"' as u16);
    result
}
struct Attributes {
    _memory: Vec<usize>,
    list: LPPROC_THREAD_ATTRIBUTE_LIST,
}
impl Attributes {
    fn new(count: u32) -> Result<Self> {
        let mut bytes = 0;
        unsafe { InitializeProcThreadAttributeList(null_mut(), count, 0, &mut bytes) };
        let mut memory = vec![0usize; bytes.div_ceil(size_of::<usize>())];
        let list = memory.as_mut_ptr().cast();
        if unsafe { InitializeProcThreadAttributeList(list, count, 0, &mut bytes) } == 0 {
            return Err(last("create process attributes"));
        }
        Ok(Self {
            _memory: memory,
            list,
        })
    }
    fn set<T>(&self, attribute: u32, value: &T) -> Result<()> {
        if unsafe {
            UpdateProcThreadAttribute(
                self.list,
                0,
                attribute as usize,
                (value as *const T).cast(),
                size_of_val(value),
                null_mut(),
                null(),
            )
        } == 0
        {
            return Err(last("set process attributes"));
        }
        Ok(())
    }
}
impl Drop for Attributes {
    fn drop(&mut self) {
        unsafe { DeleteProcThreadAttributeList(self.list) };
    }
}
struct Job(OwnedHandle);
impl Job {
    fn new(name: &str) -> Result<Self> {
        let raw = unsafe { CreateJobObjectW(null(), wide(name).as_ptr()) };
        if raw.is_null() {
            return Err(last("create process job"));
        }
        let owned = unsafe { OwnedHandle::from_raw_handle(raw) };
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
        limits.BasicLimitInformation.LimitFlags =
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
        limits.BasicLimitInformation.ActiveProcessLimit = 512;
        if unsafe {
            SetInformationJobObject(
                raw,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                size_of_val(&limits) as u32,
            )
        } == 0
        {
            return Err(last("set process job limits"));
        }
        Ok(Self(owned))
    }
}
fn stop_job(job: HANDLE) -> Result<()> {
    if unsafe { TerminateJobObject(job, 1) } == 0 {
        return Err(last("terminate sandbox job"));
    }
    let started = Instant::now();
    loop {
        let mut accounting: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { zeroed() };
        if unsafe {
            QueryInformationJobObject(
                job,
                JobObjectBasicAccountingInformation,
                (&mut accounting as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
                size_of_val(&accounting) as u32,
                null_mut(),
            )
        } == 0
        {
            return Err(last("read sandbox job status"));
        }
        if accounting.ActiveProcesses == 0 {
            return Ok(());
        }
        if started.elapsed() > Duration::from_secs(5) {
            return Err(failed(
                "sandbox descendants did not terminate; permissions retained for cleanup",
            ));
        }
        std::thread::sleep(Duration::from_millis(1));
    }
}
impl Drop for Job {
    fn drop(&mut self) {
        let _ = stop_job(self.0.as_raw_handle());
    }
}
fn inherited(handle: HANDLE) -> Result<OwnedHandle> {
    let mut duplicate = null_mut();
    let process = unsafe { GetCurrentProcess() };
    if unsafe {
        DuplicateHandle(
            process,
            handle,
            process,
            &mut duplicate,
            0,
            1,
            DUPLICATE_SAME_ACCESS,
        )
    } == 0
    {
        return Err(last("duplicate standard handle"));
    }
    Ok(unsafe { OwnedHandle::from_raw_handle(duplicate) })
}
fn run(spec: Spec, args: &[OsString]) -> Result<u32> {
    run_at(spec, args, &std::env::current_dir()?, None)
}
fn run_at(spec: Spec, args: &[OsString], cwd: &Path, timeout: Option<Duration>) -> Result<u32> {
    platform::validate_local_path(cwd)?;
    let executable = executable(args.first().ok_or_else(|| failed("missing program"))?)?;
    let mut session = Session::new(spec)?;
    session.prepare(&executable)?;
    let status = launch(
        &executable,
        args,
        cwd,
        timeout,
        Some((session.sid.0, &session.profile)),
        &session.lease.job,
    )?;
    session.cleanup.cleanup()?;
    Ok(status)
}
fn launch(
    executable: &Path,
    args: &[OsString],
    cwd: &Path,
    timeout: Option<Duration>,
    sandbox: Option<(PSID, &Path)>,
    job_name: &str,
) -> Result<u32> {
    let job = Job::new(job_name)?;
    let stdin = inherited(std::io::stdin().as_raw_handle())?;
    let stdout = inherited(std::io::stdout().as_raw_handle())?;
    let stderr = inherited(std::io::stderr().as_raw_handle())?;
    let handles = [
        stdin.as_raw_handle(),
        stdout.as_raw_handle(),
        stderr.as_raw_handle(),
    ];
    let capabilities = SECURITY_CAPABILITIES {
        AppContainerSid: sandbox.map_or(null_mut(), |(sid, _)| sid),
        Capabilities: null_mut(),
        CapabilityCount: 0,
        Reserved: 0,
    };
    let attributes = Attributes::new(if sandbox.is_some() { 2 } else { 1 })?;
    if sandbox.is_some() {
        attributes.set(PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, &capabilities)?;
    }
    attributes.set(PROC_THREAD_ATTRIBUTE_HANDLE_LIST, &handles)?;
    let mut startup: STARTUPINFOEXW = unsafe { zeroed() };
    startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = handles[0];
    startup.StartupInfo.hStdOutput = handles[1];
    startup.StartupInfo.hStdError = handles[2];
    startup.lpAttributeList = attributes.list;
    let mut command = quote(executable.as_os_str());
    for arg in &args[1..] {
        command.push(b' ' as u16);
        command.extend(quote(arg));
    }
    command.push(0);
    let mut environment: BTreeMap<OsString, OsString> = std::env::vars_os()
        .filter(|(name, _)| {
            sandbox.is_none()
                || credentials::inherited_environment(&name.to_string_lossy())
                || name == "PYTHONUNBUFFERED"
        })
        .collect();
    if let Some((_, profile)) = sandbox {
        for (name, value) in [
            ("TEMP", profile.join("Temp")),
            ("TMP", profile.join("Temp")),
            ("LOCALAPPDATA", profile.to_owned()),
        ] {
            environment.retain(|key, _| !key.eq_ignore_ascii_case(name));
            environment.insert(name.into(), value.into_os_string());
        }
    }
    let mut block = Vec::new();
    for (name, value) in environment {
        block.extend(name.encode_wide());
        block.push(b'=' as u16);
        block.extend(value.encode_wide());
        block.push(0);
    }
    block.push(0);
    let cwd = wide(cwd.as_os_str());
    let mut process: PROCESS_INFORMATION = unsafe { zeroed() };
    if unsafe {
        CreateProcessW(
            wide(executable.as_os_str()).as_ptr(),
            command.as_mut_ptr(),
            null(),
            null(),
            1,
            CREATE_NO_WINDOW
                | CREATE_SUSPENDED
                | CREATE_UNICODE_ENVIRONMENT
                | EXTENDED_STARTUPINFO_PRESENT,
            block.as_ptr().cast(),
            cwd.as_ptr(),
            &startup.StartupInfo,
            &mut process,
        )
    } == 0
    {
        return Err(last("start AppContainer process"));
    }
    let child = unsafe { OwnedHandle::from_raw_handle(process.hProcess) };
    let thread = unsafe { OwnedHandle::from_raw_handle(process.hThread) };
    if unsafe { AssignProcessToJobObject(job.0.as_raw_handle(), child.as_raw_handle()) } == 0 {
        unsafe { TerminateProcess(child.as_raw_handle(), 1) };
        unsafe { WaitForSingleObject(child.as_raw_handle(), 5000) };
        return Err(last("assign AppContainer job"));
    }
    if unsafe { ResumeThread(thread.as_raw_handle()) } == u32::MAX {
        return Err(last("resume AppContainer"));
    }
    if unsafe {
        WaitForSingleObject(
            child.as_raw_handle(),
            timeout.map_or(u32::MAX, |timeout| {
                timeout.as_millis().min(u32::MAX as u128) as u32
            }),
        )
    } != WAIT_OBJECT_0
    {
        return Err(failed("AppContainer did not finish before its deadline"));
    }
    let mut status = 1;
    if unsafe { GetExitCodeProcess(child.as_raw_handle(), &mut status) } == 0 {
        return Err(last("read AppContainer exit status"));
    }
    // Kill surviving descendants before revoking their ACLs or removing profile.
    stop_job(job.0.as_raw_handle())?;
    drop(job);
    Ok(status)
}
/// The daemon binary intercepts this private command before loading settings,
/// credentials, listeners or the selected-runtime dispatcher.
pub fn run_helper() -> i32 {
    let args: Vec<_> = std::env::args_os().skip(2).collect();
    let result = if args.first().is_some_and(|arg| arg == "--probe") {
        Err(failed(PROTOTYPE_DISABLED))
    } else if args.first().is_some_and(|arg| arg == "--probe-prototype") {
        if std::env::var_os("HEXBOT_TEST_WINDOWS_SANDBOX_PROTOTYPE").as_deref()
            != Some(OsStr::new("1"))
        {
            eprintln!("Windows AppContainer prototype probes require the isolated CI test marker");
            return 125;
        }
        probe().map(|_| 0)
    } else if args.first().is_some_and(|arg| arg == "--diagnose") {
        diagnose().map(|_| 0)
    } else if args.first().is_some_and(|arg| arg == "--unconfined") {
        if args.get(1).is_none_or(|arg| arg != "--") {
            Err(failed("missing program separator"))
        } else {
            executable(
                args.get(2)
                    .map(OsString::as_os_str)
                    .unwrap_or(OsStr::new("")),
            )
            .and_then(|executable| {
                launch(
                    &executable,
                    &args[2..],
                    &std::env::current_dir()?,
                    None,
                    None,
                    &format!("Local\\HexbotJob-{}", uuid::Uuid::new_v4()),
                )
            })
        }
    } else if args.first().is_some_and(|arg| arg == "--cleanup") && args.len() == 3 {
        lease_path(Path::new(&args[1]), &args[2].to_string_lossy())
            .and_then(|path| SandboxCleanup { path }.cleanup())
            .map(|_| 0)
    } else if std::env::var_os("HEXBOT_TEST_WINDOWS_SANDBOX_PROTOTYPE").as_deref()
        != Some(OsStr::new("1"))
    {
        Err(failed(PROTOTYPE_DISABLED))
    } else {
        args.first()
            .and_then(|value| value.to_str())
            .ok_or_else(|| failed("missing sandbox specification"))
            .and_then(|value| serde_json::from_str(value).map_err(failed))
            .and_then(|spec| {
                if args.get(1).is_none_or(|arg| arg != "--") {
                    return Err(failed("missing program separator"));
                }
                run(spec, &args[2..])
            })
    };
    match result {
        Ok(code) => code as i32,
        Err(error) => {
            eprintln!("{}", error.message);
            125
        }
    }
}
fn diagnose() -> Result<()> {
    let root = tempfile::tempdir()?;
    let home = root.path().join("home");
    let work = root.path().join("work");
    create_private_dir_all(&home)?;
    fs::create_dir_all(&work)?;
    let source = work.join("network-initialization.cs");
    let diagnostic = work.join("network-initialization.exe");
    fs::write(
        &source,
        r#"using System;
using System.Net;
using System.Net.Sockets;
class Diagnostic {
 static void Check(string name,Action action) { Console.WriteLine("CHECK "+name); try { action(); Console.WriteLine("OK"); } catch(Exception error) { Console.WriteLine(error.ToString()); } }
 static int Main() {
  Console.WriteLine("C# diagnostic started");
  Check("ServicePointManager",()=>Console.WriteLine(ServicePointManager.SecurityProtocol));
  Check("Socket",()=> { using(var socket=new Socket(AddressFamily.InterNetwork,SocketType.Stream,ProtocolType.Tcp)) { Console.WriteLine(socket.AddressFamily); } });
  Console.WriteLine("C# diagnostic finished"); return 0;
 }
}"#,
    )?;
    let system = PathBuf::from(
        std::env::var_os("SystemRoot").ok_or_else(|| failed("SystemRoot is missing"))?,
    );
    let compiler = system.join("Microsoft.NET/Framework64/v4.0.30319/csc.exe");
    let compiled = std::process::Command::new(compiler)
        .arg("/nologo")
        .arg(format!("/out:{}", diagnostic.display()))
        .arg(&source)
        .status()?;
    if !compiled.success() {
        return Err(failed("compile .NET Framework startup diagnostic"));
    }
    let mut programs:Vec<(String,Vec<OsString>)>=vec![
        ("C# network initialization".into(),vec![diagnostic.into_os_string()]),
        ("cmd".into(),vec![system.join("System32/cmd.exe").into_os_string(),"/d".into(),"/c".into(),"echo ready".into()]),
        ("Windows PowerShell 5.1".into(),vec![powershell()?.into_os_string(),"-NoProfile".into(),"-NonInteractive".into(),"-Command".into(),"[Console]::WriteLine('PowerShell ready'); [Console]::WriteLine($PSVersionTable.PSVersion.ToString()); exit 0".into()]),
    ];
    if let Some(root) = std::env::var_os("ProgramFiles") {
        let pwsh = PathBuf::from(root).join("PowerShell/7/pwsh.exe");
        if pwsh.is_file() {
            programs.push(("PowerShell 7 diagnostic only".into(),vec![pwsh.into_os_string(),"-NoProfile".into(),"-NonInteractive".into(),"-Command".into(),"[Console]::WriteLine('PowerShell 7 ready'); [Console]::WriteLine($PSVersionTable.PSVersion.ToString()); exit 0".into()]));
        }
    }
    for (name, args) in programs {
        for read_only in [true, false] {
            eprintln!("Windows sandbox diagnostic: {name}, readOnly={read_only}");
            let spec = Spec {
                home: home.clone(),
                read_roots: vec![work.clone()],
                write_roots: if read_only {
                    vec![]
                } else {
                    vec![work.clone()]
                },
                id: uuid::Uuid::new_v4().to_string(),
                read_only,
                git_env: BTreeMap::from([
                    ("GIT_CONFIG_GLOBAL".into(), "NUL".into()),
                    ("GIT_CONFIG_NOSYSTEM".into(), "1".into()),
                ]),
            };
            match run_at(spec, &args, &work, Some(Duration::from_secs(12))) {
                Ok(status) => eprintln!("Windows sandbox diagnostic exit: {status:#x}"),
                Err(error) => eprintln!("{}", error.message),
            }
        }
    }
    Ok(())
}
fn powershell() -> Result<PathBuf> {
    let root = std::env::var_os("SystemRoot").ok_or_else(|| failed("SystemRoot is missing"))?;
    let executable = PathBuf::from(root).join("System32/WindowsPowerShell/v1.0/powershell.exe");
    executable
        .is_file()
        .then_some(executable)
        .ok_or_else(|| failed("Windows PowerShell is missing"))
}
fn encoded(script: &str) -> String {
    use base64::Engine;
    let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    base64::engine::general_purpose::STANDARD.encode(bytes)
}
fn ps_path(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', "''"))
}
/// A real startup check, including successful in-workspace execution and
/// rejected writes, reads and socket operations. A failing probe leaves the
/// existing user-approval fallback in place.
fn probe() -> Result<()> {
    let root = tempfile::tempdir()?;
    let home = root.path().join("home");
    let work = root.path().join("work");
    fs::create_dir_all(&home)?;
    fs::create_dir_all(work.join(".git"))?;
    fs::write(work.join("plain.txt"), "readable")?;
    fs::write(work.join(".env"), "secret")?;
    fs::write(work.join(".git/config"), "")?;
    fs::write(root.path().join("outside.txt"), "outside")?;
    let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))?;
    let port = listener.local_addr()?.port();
    for writable in [false, true] {
        let script = format!(
            r#"$ErrorActionPreference='Stop';
if ([IO.File]::ReadAllText({plain}) -ne 'readable') {{exit 10}};
try {{[IO.File]::ReadAllText({secret}) | Out-Null; exit 11}} catch {{}};
try {{[IO.File]::WriteAllText({outside},'bad'); exit 12}} catch {{}};
try {{[IO.File]::WriteAllText({git},'bad'); exit 13}} catch {{}};
try {{$acl=[IO.File]::GetAccessControl({git}); [IO.File]::SetAccessControl({git},$acl); exit 18}} catch {{}};
$client = New-Object Net.Sockets.TcpClient;
try {{$task=$client.ConnectAsync('127.0.0.1',{port}); if($task.Wait(1500)){{exit 14}}}} catch {{}} finally {{$client.Dispose()}};
try {{$server=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0); $server.Start(); $server.Stop(); exit 15}} catch {{}};
try {{[IO.File]::WriteAllText({output},'ok'); if(-not ${writable}){{exit 16}}}} catch {{if(${writable}){{exit 17}}}};
exit 0"#,
            plain = ps_path(&work.join("plain.txt")),
            secret = ps_path(&work.join(".env")),
            outside = ps_path(&root.path().join("outside.txt")),
            git = ps_path(&work.join(".git/config")),
            output = ps_path(&work.join("result.txt")),
            writable = if writable { "true" } else { "false" }
        );
        let spec = Spec {
            home: home.clone(),
            read_roots: vec![work.clone()],
            write_roots: if writable { vec![work.clone()] } else { vec![] },
            id: uuid::Uuid::new_v4().to_string(),
            read_only: !writable,
            git_env: BTreeMap::from([
                ("GIT_CONFIG_NOSYSTEM".into(), "1".into()),
                ("GIT_CONFIG_GLOBAL".into(), "NUL".into()),
            ]),
        };
        let status = run_at(
            spec,
            &[
                powershell()?.into_os_string(),
                "-NoProfile".into(),
                "-NonInteractive".into(),
                "-EncodedCommand".into(),
                encoded(&script).into(),
            ],
            &work,
            Some(Duration::from_secs(5)),
        )?;
        if status != 0 {
            return Err(failed(format!(
                "containment probe failed with exit {status}"
            )));
        }
    }
    if fs::read_to_string(root.path().join("outside.txt"))? != "outside" {
        return Err(failed("outside-write probe changed its fixture"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_production_containment_stays_disabled_until_the_boundary_is_reviewed() {
        assert!(!available());
    }

    #[test]
    fn windows_appcontainer_passes_real_containment_probes() {
        probe().expect("Manual and Auto must both enforce the Windows sandbox");
    }

    #[test]
    fn concurrent_windows_sandboxes_preserve_each_others_secret_denies_and_cleanup() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        let work = root.path().join("work");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&work).unwrap();
        fs::write(work.join(".env"), "secret").unwrap();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let workers: Vec<_> = (0..2)
            .map(|worker| {
                let (home, work, barrier) = (home.clone(), work.clone(), barrier.clone());
                std::thread::spawn(move || {
                    barrier.wait();
                    let ready = work.join(format!("ready-{worker}"));
                    let other = work.join(format!("ready-{}", 1 - worker));
                    let script = format!(
                        r#"$ErrorActionPreference='Stop';
[IO.File]::WriteAllText({ready},'ready');
$until=[DateTime]::UtcNow.AddSeconds(5);
while(-not [IO.File]::Exists({other})) {{if([DateTime]::UtcNow -gt $until){{exit 41}}}};
for($i=0;$i -lt 3000;$i++) {{
try {{[IO.File]::ReadAllText({secret}) | Out-Null; exit 42}} catch {{}};
[IO.File]::WriteAllText({normal},'ok');
}};
exit 0"#,
                        ready = ps_path(&ready),
                        other = ps_path(&other),
                        secret = ps_path(&work.join(".env")),
                        normal = ps_path(&work.join(format!("normal-{worker}.txt")))
                    );
                    let spec = Spec {
                        home,
                        read_roots: vec![work.clone()],
                        write_roots: vec![work.clone()],
                        id: uuid::Uuid::new_v4().to_string(),
                        read_only: false,
                        git_env: BTreeMap::from([
                            ("GIT_CONFIG_NOSYSTEM".into(), "1".into()),
                            ("GIT_CONFIG_GLOBAL".into(), "NUL".into()),
                        ]),
                    };
                    run_at(
                        spec,
                        &[
                            powershell().unwrap().into_os_string(),
                            "-NoProfile".into(),
                            "-NonInteractive".into(),
                            "-EncodedCommand".into(),
                            encoded(&script).into(),
                        ],
                        &work,
                        Some(Duration::from_secs(20)),
                    )
                    .unwrap()
                })
            })
            .collect();
        for worker in workers {
            assert_eq!(worker.join().unwrap(), 0);
        }
        assert_eq!(fs::read_to_string(work.join(".env")).unwrap(), "secret");
        assert_eq!(
            fs::read_dir(home.join("runtime/windows-sandbox"))
                .unwrap()
                .count(),
            0
        );
    }

    #[test]
    fn windows_argument_quoting_preserves_quotes_and_trailing_backslashes() {
        let text = |value: &str| String::from_utf16(&quote(OsStr::new(value))).unwrap();
        assert_eq!(text(""), "\"\"");
        assert_eq!(text("plain"), "\"plain\"");
        assert_eq!(text("C:\\a b\\"), "\"C:\\a b\\\\\"");
        assert_eq!(text("a\"b"), "\"a\\\"b\"");
    }

    #[test]
    fn windows_rejects_writable_roots_inside_git_and_linked_metadata() {
        let base = tempfile::tempdir().unwrap();
        let home = base.path().join("home");
        create_private_dir_all(&home).unwrap();
        for name in ["repo/.git", "linked-metadata"] {
            let metadata = base.path().join(name);
            fs::create_dir_all(metadata.join("refs")).unwrap();
            fs::create_dir_all(metadata.join("objects")).unwrap();
            fs::write(metadata.join("HEAD"), "ref: refs/heads/main\n").unwrap();
            fs::write(metadata.join("config"), "").unwrap();
            let root = metadata.join("refs");
            let marker = root.join("ran.txt");
            let spec = Spec {
                home: home.clone(),
                read_roots: vec![root.clone()],
                write_roots: vec![root.clone()],
                id: uuid::Uuid::new_v4().to_string(),
                read_only: false,
                git_env: BTreeMap::from([
                    ("GIT_CONFIG_NOSYSTEM".into(), "1".into()),
                    ("GIT_CONFIG_GLOBAL".into(), "NUL".into()),
                ]),
            };
            let result = run_at(
                spec,
                &[
                    powershell().unwrap().into_os_string(),
                    "-NoProfile".into(),
                    "-NonInteractive".into(),
                    "-EncodedCommand".into(),
                    encoded(&format!(
                        "[IO.File]::WriteAllText({},'bad')",
                        ps_path(&marker)
                    ))
                    .into(),
                ],
                &root,
                Some(Duration::from_secs(5)),
            );
            let error = result.expect_err("metadata root must be rejected");
            assert!(
                error
                    .message
                    .contains("inside protected configuration or Git metadata"),
                "metadata root {name} failed for another reason: {}",
                error.message
            );
            assert!(!marker.exists());
            assert_eq!(fs::read_to_string(metadata.join("config")).unwrap(), "");
        }
    }

    #[test]
    fn windows_python_reads_new_private_outputs_and_keeps_secrets_and_children_contained() {
        let python = PathBuf::from(std::env::var_os("HEXBOT_TEST_PYTHON").expect(
            "Windows containment tests require HEXBOT_TEST_PYTHON to name the native Python executable",
        ));
        let base = tempfile::tempdir().unwrap();
        let home = base.path().join("home");
        create_private_dir_all(&home).unwrap();
        let work = base.path().join("work");
        let artifacts = home.join("profiles/owl/artifacts");
        fs::create_dir_all(&work).unwrap();
        fs::create_dir_all(&artifacts).unwrap();
        let initial = artifacts.join("initial.txt");
        let incoming = artifacts.join("incoming.txt");
        let secret = artifacts.join(".env");
        crate::common::atomic_write(&initial, b"initial").unwrap();
        crate::common::atomic_write(&secret, b"secret").unwrap();
        let ready = work.join("ready.txt");
        let child_pid = work.join("child.pid");
        let script = r#"import pathlib,sys,time,subprocess,socket
work,outputs=map(pathlib.Path,sys.argv[1:])
assert (outputs/'initial.txt').read_text()=='initial'
try:
    (outputs/'.env').read_text()
    raise AssertionError('secret was readable')
except PermissionError:
    pass
(work/'ready.txt').write_text('ready')
deadline=time.monotonic()+10
while not (outputs/'incoming.txt').exists():
    if time.monotonic()>deadline: raise AssertionError('native output did not arrive')
assert (outputs/'incoming.txt').read_text()=='incoming'
(outputs/'initial.txt').write_text('updated')
(outputs/'result.txt').write_text('result')
(outputs/'result.txt').rename(outputs/'moved.txt')
(outputs/'moved.txt').unlink()
try:
    listener=socket.socket()
    listener.bind(('127.0.0.1',0))
    listener.listen()
    raise AssertionError('network listener was permitted')
except PermissionError:
    pass
child=subprocess.Popen([sys.executable,'-B','-c','import time; time.sleep(300)'],creationflags=0x00000008|0x00000200)
(work/'child.pid').write_text(str(child.pid))
"#;
        let spec = Spec {
            home: home.clone(),
            read_roots: vec![work.clone(), artifacts.clone()],
            write_roots: vec![work.clone(), artifacts.clone()],
            id: uuid::Uuid::new_v4().to_string(),
            read_only: false,
            git_env: BTreeMap::from([
                ("GIT_CONFIG_NOSYSTEM".into(), "1".into()),
                ("GIT_CONFIG_GLOBAL".into(), "NUL".into()),
            ]),
        };
        let args = vec![
            python.into_os_string(),
            "-B".into(),
            "-c".into(),
            script.into(),
            work.clone().into_os_string(),
            artifacts.into_os_string(),
        ];
        let (finished, result) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            let status = run_at(spec, &args, &work, Some(Duration::from_secs(20)));
            finished.send(status).unwrap();
        });
        let start = Instant::now();
        while !ready.exists() {
            if let Ok(status) = result.try_recv() {
                panic!("Python exited before accepting native outputs: {status:?}");
            }
            assert!(
                start.elapsed() < Duration::from_secs(20),
                "Python never became ready"
            );
            std::thread::yield_now();
        }
        crate::common::atomic_write(&incoming, b"incoming").unwrap();
        assert_eq!(
            result
                .recv_timeout(Duration::from_secs(20))
                .unwrap()
                .unwrap(),
            0
        );
        worker.join().unwrap();
        assert_eq!(fs::read_to_string(initial).unwrap(), "updated");
        assert_eq!(fs::read_to_string(secret).unwrap(), "secret");
        let pid: u32 = fs::read_to_string(child_pid).unwrap().parse().unwrap();
        assert!(
            process_started(pid).unwrap().is_none(),
            "detached Python child survived the tool"
        );
        assert_eq!(
            fs::read_dir(home.join("runtime/windows-sandbox"))
                .unwrap()
                .count(),
            0
        );
    }

    #[test]
    fn windows_home_stays_read_only_inside_a_broad_workspace_and_outputs_open_explicitly() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        let artifacts = home.join("profiles/owl/artifacts");
        create_private_dir_all(&home).unwrap();
        fs::create_dir_all(&artifacts).unwrap();
        fs::write(home.join("config.yaml"), "keep").unwrap();
        fs::write(home.join("auth.json"), "secret").unwrap();
        let script = format!(
            r#"$ErrorActionPreference='Stop';
try {{[IO.File]::WriteAllText({config},'bad'); exit 31}} catch {{}};
try {{[IO.File]::ReadAllText({auth}) | Out-Null; exit 32}} catch {{}};
[IO.File]::WriteAllText({artifact},'ok');
[IO.File]::WriteAllText({outside},'ok');
exit 0"#,
            config = ps_path(&home.join("config.yaml")),
            auth = ps_path(&home.join("auth.json")),
            artifact = ps_path(&artifacts.join("result.txt")),
            outside = ps_path(&root.path().join("result.txt"))
        );
        let spec = Spec {
            home: home.clone(),
            read_roots: vec![root.path().to_owned(), artifacts.clone()],
            write_roots: vec![root.path().to_owned(), artifacts.clone()],
            id: uuid::Uuid::new_v4().to_string(),
            read_only: false,
            git_env: BTreeMap::from([
                ("GIT_CONFIG_NOSYSTEM".into(), "1".into()),
                ("GIT_CONFIG_GLOBAL".into(), "NUL".into()),
            ]),
        };
        let status = run_at(
            spec,
            &[
                powershell().unwrap().into_os_string(),
                "-NoProfile".into(),
                "-NonInteractive".into(),
                "-EncodedCommand".into(),
                encoded(&script).into(),
            ],
            root.path(),
            Some(Duration::from_secs(15)),
        )
        .unwrap();
        assert_eq!(status, 0);
        assert_eq!(
            fs::read_to_string(home.join("config.yaml")).unwrap(),
            "keep"
        );
        assert_eq!(
            fs::read_to_string(artifacts.join("result.txt")).unwrap(),
            "ok"
        );
        assert_eq!(
            fs::read_dir(home.join("runtime/windows-sandbox"))
                .unwrap()
                .count(),
            0
        );
    }

    #[test]
    fn windows_sandbox_cleans_permissions_after_a_failed_child() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        let work = root.path().join("work");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&work).unwrap();
        let spec = Spec {
            home: home.clone(),
            read_roots: vec![work.clone()],
            write_roots: vec![work.clone()],
            id: uuid::Uuid::new_v4().to_string(),
            read_only: false,
            git_env: BTreeMap::from([
                ("GIT_CONFIG_NOSYSTEM".into(), "1".into()),
                ("GIT_CONFIG_GLOBAL".into(), "NUL".into()),
            ]),
        };
        let path = lease_path(&home, &spec.id).unwrap();
        let status = run_at(
            spec,
            &[
                powershell().unwrap().into_os_string(),
                "-NoProfile".into(),
                "-NonInteractive".into(),
                "-Command".into(),
                "exit 47".into(),
            ],
            &work,
            Some(Duration::from_secs(15)),
        )
        .unwrap();
        assert_eq!(status, 47);
        assert!(
            !path.exists(),
            "failed children must revoke permissions and remove their lease"
        );
    }
}
