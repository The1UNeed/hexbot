//! Locate trusted Windows programs through the OS, not the caller's PATH.
#[cfg(windows)]
pub fn system_program(relative: &str) -> std::io::Result<std::path::PathBuf> {
    unsafe extern "system" {
        fn GetSystemDirectoryW(buffer: *mut u16, size: u32) -> u32;
    }
    let mut buffer = vec![0u16; 32768];
    let length = unsafe { GetSystemDirectoryW(buffer.as_mut_ptr(), buffer.len() as u32) } as usize;
    if length == 0 {
        return Err(std::io::Error::last_os_error());
    }
    if length >= buffer.len() {
        return Err(std::io::Error::other(
            "Windows system directory is too long",
        ));
    }
    Ok(std::path::PathBuf::from(String::from_utf16_lossy(&buffer[..length])).join(relative))
}
