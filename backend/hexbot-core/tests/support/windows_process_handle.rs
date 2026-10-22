use serde_json::{Value, json};
// Capture handles before shutdown, then wait on kernel exit events. PIDs alone
// cannot prove all descendants have finished when the daemon wait completes.
pub struct ProcessHandle {
    handle: *mut std::ffi::c_void,
    pub pid: u32,
}
#[link(name = "kernel32")]
unsafe extern "system" {
    fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut std::ffi::c_void;
    fn WaitForSingleObject(handle: *mut std::ffi::c_void, milliseconds: u32) -> u32;
    fn GetExitCodeProcess(handle: *mut std::ffi::c_void, code: *mut u32) -> i32;
    fn GetProcessTimes(
        handle: *mut std::ffi::c_void,
        created: *mut u64,
        exited: *mut u64,
        kernel: *mut u64,
        user: *mut u64,
    ) -> i32;
    fn CloseHandle(handle: *mut std::ffi::c_void) -> i32;
}
impl ProcessHandle {
    pub fn open(pid: u32) -> Self {
        Self::try_open(pid).unwrap_or_else(|e| panic!("Cannot own fixture process {pid}: {e}"))
    }
    pub fn try_open(pid: u32) -> std::io::Result<Self> {
        let handle = unsafe { OpenProcess(0x00101000, 0, pid) };
        if handle.is_null() {
            return Err(std::io::Error::last_os_error());
        }
        Ok(Self { handle, pid })
    }
    pub fn created(&self) -> std::io::Result<String> {
        let (mut created, mut exited, mut kernel, mut user) = (0, 0, 0, 0);
        if unsafe {
            GetProcessTimes(
                self.handle,
                &mut created,
                &mut exited,
                &mut kernel,
                &mut user,
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error());
        }
        Ok(created.to_string())
    }
    pub fn alive(&self) -> bool {
        (unsafe { WaitForSingleObject(self.handle, 0) }) == 258
    }
    pub fn snapshot(&self) -> Value {
        let mut code = 0;
        let queried = unsafe { GetExitCodeProcess(self.handle, &mut code) };
        json!({"pid":self.pid,"created":self.created().ok(),"wait":unsafe { WaitForSingleObject(self.handle,0) },"exitCode":if queried != 0 {Some(code)} else {None}})
    }
    pub fn wait(&self) {
        assert_eq!(
            unsafe { WaitForSingleObject(self.handle, 15000) },
            0,
            "Descendant did not exit"
        );
    }
}
impl Drop for ProcessHandle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.handle);
        }
    }
}
