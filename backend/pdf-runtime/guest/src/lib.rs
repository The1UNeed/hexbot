//! The private, single-job PDF guest protocol. No executable or path is supplied
//! by the host. The host still validates every returned PNG before staging it.
#[cfg(any(target_os = "linux", test))]
use std::io::Read;
use std::io::{self, Write};

pub const REQUEST_MAGIC: &[u8; 8] = b"HXPDF001";
pub const RESPONSE_MAGIC: &[u8; 8] = b"HXPNG001";
pub const REQUEST_BYTES: usize = 32;
pub const INPUT_LIMIT: u64 = 45 * 1024 * 1024;
pub const OUTPUT_LIMIT: usize = 99_090_240;
pub const CHUNK_LIMIT: usize = 65_536;
pub const PORT: u32 = 5000;
pub const DEADLINE_SECONDS: u64 = 120;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum Status {
    Ok = 0,
    InvalidRequest = 1,
    RendererFailed = 2,
    OutputLimit = 3,
    Timeout = 4,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Request {
    pub first: u32,
    pub last: u32,
    pub length: u64,
}
impl Request {
    pub fn parse(header: [u8; REQUEST_BYTES]) -> io::Result<Self> {
        let first = u32::from_be_bytes(header[8..12].try_into().unwrap());
        let last = u32::from_be_bytes(header[12..16].try_into().unwrap());
        let length = u64::from_be_bytes(header[16..24].try_into().unwrap());
        if &header[..8] != REQUEST_MAGIC
            || header[24..] != [0; 8]
            || first == 0
            || last > i32::MAX as u32
            || last < first
            || last - first >= 25
            || !(5..=INPUT_LIMIT).contains(&length)
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "invalid PDF request",
            ));
        }
        Ok(Self {
            first,
            last,
            length,
        })
    }
    #[cfg(test)]
    pub fn header(self) -> [u8; REQUEST_BYTES] {
        let mut header = [0; REQUEST_BYTES];
        header[..8].copy_from_slice(REQUEST_MAGIC);
        header[8..12].copy_from_slice(&self.first.to_be_bytes());
        header[12..16].copy_from_slice(&self.last.to_be_bytes());
        header[16..24].copy_from_slice(&self.length.to_be_bytes());
        header
    }
}

pub fn write_chunk(mut writer: impl Write, data: &[u8]) -> io::Result<()> {
    if data.is_empty() || data.len() > CHUNK_LIMIT {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid PNG chunk size",
        ));
    }
    writer.write_all(&(data.len() as u32).to_be_bytes())?;
    writer.write_all(data)
}
pub fn finish(mut writer: impl Write, status: Status) -> io::Result<()> {
    writer.write_all(&0u32.to_be_bytes())?;
    writer.write_all(&(status as u32).to_be_bytes())
}

/// Test peer for the real worker. Discard payload unless its terminal status succeeds.
#[cfg(test)]
pub fn read_response(mut reader: impl Read, mut writer: impl Write) -> io::Result<Status> {
    let mut magic = [0; 8];
    reader.read_exact(&mut magic)?;
    if &magic != RESPONSE_MAGIC {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid PDF response",
        ));
    }
    let mut total = 0usize;
    let mut buffer = [0; CHUNK_LIMIT];
    loop {
        let mut length = [0; 4];
        reader.read_exact(&mut length)?;
        let length = u32::from_be_bytes(length) as usize;
        if length == 0 {
            let mut status = [0; 4];
            reader.read_exact(&mut status)?;
            return match u32::from_be_bytes(status) {
                0 => Ok(Status::Ok),
                1 => Ok(Status::InvalidRequest),
                2 => Ok(Status::RendererFailed),
                3 => Ok(Status::OutputLimit),
                4 => Ok(Status::Timeout),
                _ => Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "invalid PDF status",
                )),
            };
        }
        if length > CHUNK_LIMIT || length > OUTPUT_LIMIT - total {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "PDF output exceeds limit",
            ));
        }
        reader.read_exact(&mut buffer[..length])?;
        writer.write_all(&buffer[..length])?;
        total += length;
    }
}

#[cfg(target_os = "linux")]
pub mod linux;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn request_validates_before_allocating_or_rendering() {
        let valid = Request {
            first: 2,
            last: 26,
            length: INPUT_LIMIT,
        };
        assert_eq!(Request::parse(valid.header()).unwrap(), valid);
        for invalid in [
            Request { first: 0, ..valid },
            Request { last: 1, ..valid },
            Request { last: 27, ..valid },
            Request {
                length: INPUT_LIMIT + 1,
                ..valid
            },
            Request { length: 4, ..valid },
            Request {
                first: i32::MAX as u32,
                last: i32::MAX as u32 + 1,
                length: 5,
            },
        ] {
            assert!(Request::parse(invalid.header()).is_err());
        }
        let mut reserved = valid.header();
        reserved[31] = 1;
        assert!(Request::parse(reserved).is_err());
        let mut magic = valid.header();
        magic[0] = 0;
        assert!(Request::parse(magic).is_err());
    }
    #[test]
    fn response_requires_framing_and_a_known_terminal_status() {
        let mut wire = RESPONSE_MAGIC.to_vec();
        write_chunk(&mut wire, b"PNG1").unwrap();
        write_chunk(&mut wire, b"PNG2").unwrap();
        finish(&mut wire, Status::Ok).unwrap();
        let mut output = Vec::new();
        assert_eq!(read_response(&wire[..], &mut output).unwrap(), Status::Ok);
        assert_eq!(output, b"PNG1PNG2");
        for length in 0..wire.len() {
            assert!(read_response(&wire[..length], io::sink()).is_err());
        }
        let last = wire.len() - 1;
        wire[last] = 99;
        assert!(read_response(&wire[..], io::sink()).is_err());
        let mut oversized = RESPONSE_MAGIC.to_vec();
        oversized.extend_from_slice(&((CHUNK_LIMIT + 1) as u32).to_be_bytes());
        assert!(read_response(&oversized[..], io::sink()).is_err());
    }
    #[test]
    fn terminal_status_ends_output_without_reading_or_forwarding_later_bytes() {
        let mut wire = RESPONSE_MAGIC.to_vec();
        write_chunk(&mut wire, b"PNG").unwrap();
        finish(&mut wire, Status::Ok).unwrap();
        let end = wire.len();
        wire.extend_from_slice(b"untrusted postterminal bytes");
        let mut input = io::Cursor::new(wire);
        let mut output = Vec::new();
        assert_eq!(read_response(&mut input, &mut output).unwrap(), Status::Ok);
        assert_eq!(input.position(), end as u64);
        assert_eq!(output, b"PNG");
    }
    #[test]
    fn error_status_is_preserved_and_chunk_zero_is_reserved() {
        assert!(write_chunk(Vec::new(), b"").is_err());
        assert!(write_chunk(Vec::new(), &vec![0; CHUNK_LIMIT + 1]).is_err());
        for status in [
            Status::InvalidRequest,
            Status::RendererFailed,
            Status::OutputLimit,
            Status::Timeout,
        ] {
            let mut wire = RESPONSE_MAGIC.to_vec();
            finish(&mut wire, status).unwrap();
            assert_eq!(read_response(&wire[..], io::sink()).unwrap(), status);
        }
    }
}
