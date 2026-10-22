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
    // cmd.exe also parses its own argv[0]. Keep its path in native form:
    // a forward slash in the executable token can be interpreted as a switch.
    let mut program = std::path::PathBuf::from(String::from_utf16_lossy(&buffer[..length]));
    for component in relative.split('/') {
        if component.is_empty()
            || component == "."
            || component == ".."
            || component.contains(['\\', ':'])
        {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "Invalid system program path",
            ));
        }
        program.push(component);
    }
    Ok(program)
}
