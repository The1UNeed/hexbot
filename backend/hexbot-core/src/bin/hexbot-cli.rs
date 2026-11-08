//! Windows CLI forwarding component. This is not the daemon or a shell shim.
#[cfg(windows)]
fn main() {
    fn run() -> Result<i32, Box<dyn std::error::Error>> {
        let launcher = std::env::current_exe()?;
        let home = hexbot_core::windows_cli::owner(&launcher)
            .ok_or("Unrecognized Hexbot CLI configuration")?;
        let executable = hexbot_core::native_selection::selected(&home)?;
        let status = std::process::Command::new(executable)
            .args(std::env::args_os().skip(1))
            .env("HEXBOT_HOME", &home)
            .status()?;
        Ok(status.code().unwrap_or(1))
    }
    match run() {
        Ok(code) => std::process::exit(code),
        Err(error) => {
            eprintln!("Hexbot CLI: {error}");
            std::process::exit(1);
        }
    }
}
#[cfg(not(windows))]
fn main() {
    eprintln!("The native CLI forwarding component is Windows-only");
    std::process::exit(1);
}
