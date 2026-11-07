//! Windows PowerShell 5.1 must encode its redirected answer independently of
//! the interactive console's legacy code page.
pub const READ_LINE: &str =
    "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);[Console]::ReadLine()";

pub fn answer(output: &std::process::Output) -> Option<String> {
    (output.status.success() && output.stdout.len() <= 65536)
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned())
}
