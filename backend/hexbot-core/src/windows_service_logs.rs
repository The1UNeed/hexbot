//! Follow both service streams by name, reopening after removal or rotation.
use std::{
    fs::File,
    io::{self, Read, Seek, SeekFrom},
    path::PathBuf,
};

pub(super) struct Log {
    path: PathBuf,
    identity: Option<(u64, u64)>,
    offset: u64,
    utf16: bool,
    pending: Vec<u8>,
}
impl Log {
    pub(super) fn new(path: PathBuf) -> Self {
        Self {
            path,
            identity: None,
            offset: 0,
            utf16: false,
            pending: Vec::new(),
        }
    }
    pub(super) fn read(&mut self, tail: bool) -> io::Result<String> {
        let mut file = match File::open(&self.path) {
            Ok(file) => file,
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                self.identity = None;
                return Ok(String::new());
            }
            Err(e) => return Err(e),
        };
        let identity = file_identity(&file)?;
        let reset = self.identity != Some(identity) || file.metadata()?.len() < self.offset;
        if reset {
            self.identity = Some(identity);
            self.offset = 0;
            self.pending.clear();
            let mut bom = [0; 2];
            let length = file.read(&mut bom)?;
            self.utf16 = length == 2 && bom == [0xff, 0xfe];
            if self.utf16 {
                self.offset = 2;
            }
        }
        file.seek(SeekFrom::Start(self.offset))?;
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)?;
        self.offset += bytes.len() as u64;
        self.pending.extend(bytes);
        // Keep split UTF-16 units / UTF-8 codepoints until the next append.
        let (text, used) = if self.utf16 {
            let used = self.pending.len() / 2 * 2;
            let units = self.pending[..used]
                .chunks_exact(2)
                .map(|b| u16::from_le_bytes([b[0], b[1]]))
                .collect::<Vec<_>>();
            let used = if units.last().is_some_and(|u| (0xd800..=0xdbff).contains(u)) {
                used - 2
            } else {
                used
            };
            (String::from_utf16_lossy(&units[..used / 2]), used)
        } else {
            let used = match std::str::from_utf8(&self.pending) {
                Ok(_) => self.pending.len(),
                Err(e) if e.error_len().is_none() => e.valid_up_to(),
                Err(_) => self.pending.len(),
            };
            (
                String::from_utf8_lossy(&self.pending[..used]).into_owned(),
                used,
            )
        };
        self.pending.drain(..used);
        if reset && tail {
            let lines = text.split_inclusive('\n').collect::<Vec<_>>();
            Ok(lines[lines.len().saturating_sub(100)..].concat())
        } else {
            Ok(text)
        }
    }
}
#[cfg(unix)]
fn file_identity(file: &File) -> io::Result<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    let metadata = file.metadata()?;
    Ok((metadata.dev(), metadata.ino()))
}
#[cfg(windows)]
fn file_identity(file: &File) -> io::Result<(u64, u64)> {
    use std::os::windows::io::AsRawHandle;
    #[repr(C)]
    #[derive(Default)]
    struct Info {
        attributes: u32,
        times: [u32; 6],
        volume: u32,
        size_high: u32,
        size_low: u32,
        links: u32,
        index_high: u32,
        index_low: u32,
    }
    unsafe extern "system" {
        fn GetFileInformationByHandle(handle: *mut std::ffi::c_void, info: *mut Info) -> i32;
    }
    let mut info = Info::default();
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok((
        u64::from(info.volume),
        (u64::from(info.index_high) << 32) | u64::from(info.index_low),
    ))
}

pub(super) async fn logs(home: &std::path::Path, follow: bool) -> crate::Result<()> {
    use std::io::Write;
    let mut logs = [
        Log::new(home.join("logs/service.log")),
        Log::new(home.join("logs/service-error.log")),
    ];
    let mut interval = tokio::time::interval(std::time::Duration::from_millis(200));
    loop {
        for log in &mut logs {
            print!("{}", log.read(follow)?);
        }
        io::stdout().flush()?;
        if !follow {
            return Ok(());
        }
        tokio::select! { _ = interval.tick() => {}, _ = tokio::signal::ctrl_c() => return Ok(()) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Write;
    #[test]
    fn follows_missing_appended_truncated_rotated_and_utf16_logs() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("service-error.log");
        let mut log = Log::new(path.clone());
        assert_eq!(log.read(true).unwrap(), "");
        fs::write(&path, b"first\n").unwrap();
        assert_eq!(log.read(true).unwrap(), "first\n");
        File::options()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(b"stderr appended\n")
            .unwrap();
        assert_eq!(log.read(true).unwrap(), "stderr appended\n");
        assert_eq!(log.read(true).unwrap(), "");
        fs::write(&path, b"new\n").unwrap();
        assert_eq!(log.read(true).unwrap(), "new\n");
        fs::rename(&path, path.with_extension("old")).unwrap();
        let bytes = [
            vec![0xff, 0xfe],
            "Jos\u{e9}\n"
                .encode_utf16()
                .flat_map(u16::to_le_bytes)
                .collect(),
        ]
        .concat();
        fs::write(&path, bytes).unwrap();
        assert_eq!(log.read(true).unwrap(), "Jos\u{e9}\n");
    }
}
