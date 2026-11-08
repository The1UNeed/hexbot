fn main() {
    #[cfg(target_os = "linux")]
    {
        if let Err(error) = hexbot_pdf_worker::linux::boot() {
            eprintln!("PDF guest failed: {error}");
        }
        if std::process::id() != 1 {
            std::process::exit(1);
        }
        // No init exit/panic/reboot loop. Power off after the worker returns,
        // including disconnect or startup failure. The host also owns teardown.
        unsafe {
            libc::reboot(libc::LINUX_REBOOT_CMD_POWER_OFF);
        }
        eprintln!("PDF guest poweroff failed");
        loop {
            unsafe {
                libc::pause();
            }
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        eprintln!("hexbot-pdf-worker runs only inside its Linux guest");
        std::process::exit(1);
    }
}
