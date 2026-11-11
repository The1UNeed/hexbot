//! The zip container Word, Excel and PowerPoint files are (`ooxml.rs`):
//! enough to read a file's parts, write a new file, and change some parts
//! of one while the others stay byte for byte. Stored and deflated entries
//! only, no zip64 and no encryption, which is every file Office writes
//! under 4 GB.
use crate::{Error, Result};
use flate2::{Compression, Crc, read::DeflateDecoder, write::DeflateEncoder};
use std::io::{Read, Write};

/// The most one part may inflate to: a guard against a file built to
/// exhaust memory.
pub(crate) const PART_CAP: usize = 64 * 1024 * 1024;
const MAX_ENTRIES: usize = 20_000;

fn bad(why: &str) -> Error {
    Error::new(4202, format!("This file can't be read: {why}."))
}

struct Entry {
    name: String,
    flags: u16,
    method: u16,
    crc: u32,
    compressed: u32,
    size: u32,
    /// Where its data starts in the file.
    data: usize,
}

pub(crate) struct Archive {
    bytes: Vec<u8>,
    entries: Vec<Entry>,
}

fn u16_at(bytes: &[u8], at: usize) -> Result<u16> {
    bytes
        .get(at..at + 2)
        .map(|b| u16::from_le_bytes([b[0], b[1]]))
        .ok_or_else(|| bad("it is cut short"))
}
fn u32_at(bytes: &[u8], at: usize) -> Result<u32> {
    bytes
        .get(at..at + 4)
        .map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        .ok_or_else(|| bad("it is cut short"))
}

impl Archive {
    pub(crate) fn open(bytes: Vec<u8>) -> Result<Self> {
        // The directory's end record sits at the tail, before a comment
        // of at most 65535 bytes.
        let floor = bytes.len().saturating_sub(22 + 65_535);
        let end = (floor..=bytes.len().saturating_sub(22))
            .rev()
            .find(|at| bytes[*at..].starts_with(b"PK\x05\x06"))
            .filter(|_| bytes.len() >= 22)
            .ok_or_else(|| bad("it is not a Word, Excel or PowerPoint file"))?;
        let count = u16_at(&bytes, end + 10)? as usize;
        let mut at = u32_at(&bytes, end + 16)? as usize;
        if count > MAX_ENTRIES || count == 0xFFFF || at == 0xFFFF_FFFF {
            return Err(bad("it is too large"));
        }
        let mut entries = Vec::with_capacity(count);
        for _ in 0..count {
            if !bytes
                .get(at..)
                .is_some_and(|b| b.starts_with(b"PK\x01\x02"))
            {
                return Err(bad("its directory is damaged"));
            }
            let flags = u16_at(&bytes, at + 8)?;
            let method = u16_at(&bytes, at + 10)?;
            let crc = u32_at(&bytes, at + 16)?;
            let compressed = u32_at(&bytes, at + 20)?;
            let size = u32_at(&bytes, at + 24)?;
            let name_len = u16_at(&bytes, at + 28)? as usize;
            let extra_len = u16_at(&bytes, at + 30)? as usize;
            let comment_len = u16_at(&bytes, at + 32)? as usize;
            let local = u32_at(&bytes, at + 42)? as usize;
            let name = bytes
                .get(at + 46..at + 46 + name_len)
                .ok_or_else(|| bad("it is cut short"))?;
            let name = String::from_utf8_lossy(name).into_owned();
            if flags & 1 != 0 {
                return Err(bad("it is password-protected"));
            }
            if compressed == 0xFFFF_FFFF || size == 0xFFFF_FFFF || local == 0xFFFF_FFFF {
                return Err(bad("it is too large"));
            }
            if !bytes
                .get(local..)
                .is_some_and(|b| b.starts_with(b"PK\x03\x04"))
            {
                return Err(bad("its directory is damaged"));
            }
            let data = local
                + 30
                + u16_at(&bytes, local + 26)? as usize
                + u16_at(&bytes, local + 28)? as usize;
            if bytes.len() < data.saturating_add(compressed as usize) {
                return Err(bad("it is cut short"));
            }
            entries.push(Entry {
                name,
                flags,
                method,
                crc,
                compressed,
                size,
                data,
            });
            at += 46 + name_len + extra_len + comment_len;
        }
        Ok(Archive { bytes, entries })
    }

    pub(crate) fn names(&self) -> impl Iterator<Item = &str> {
        self.entries.iter().map(|e| e.name.as_str())
    }

    pub(crate) fn has(&self, name: &str) -> bool {
        self.entries.iter().any(|e| e.name == name)
    }

    /// One part's bytes, or None when the file has no such part.
    pub(crate) fn read(&self, name: &str) -> Result<Option<Vec<u8>>> {
        let Some(entry) = self.entries.iter().find(|e| e.name == name) else {
            return Ok(None);
        };
        if entry.size as usize > PART_CAP {
            return Err(bad("a part of it is too large"));
        }
        let raw = &self.bytes[entry.data..entry.data + entry.compressed as usize];
        let out = match entry.method {
            0 => raw.to_vec(),
            8 => {
                let mut out = Vec::with_capacity(entry.size as usize);
                DeflateDecoder::new(raw)
                    .take(PART_CAP as u64 + 1)
                    .read_to_end(&mut out)
                    .map_err(|_| bad("a part of it is damaged"))?;
                out
            }
            _ => return Err(bad("it is packed in a way Hexbot does not read")),
        };
        let mut crc = Crc::new();
        crc.update(&out);
        if out.len() != entry.size as usize || crc.sum() != entry.crc {
            return Err(bad("a part of it is damaged"));
        }
        Ok(Some(out))
    }

    /// One part as text.
    pub(crate) fn text(&self, name: &str) -> Result<Option<String>> {
        Ok(self
            .read(name)?
            .map(|bytes| String::from_utf8_lossy(&bytes).into_owned()))
    }

    /// The file with `changes` made: a part named with bytes is replaced or
    /// added, one named with None is removed. Every other part is copied
    /// as it was packed.
    pub(crate) fn with(&self, changes: &[(String, Option<Vec<u8>>)]) -> Vec<u8> {
        let mut writer = Writer::default();
        for entry in &self.entries {
            match changes.iter().find(|(name, _)| *name == entry.name) {
                Some((_, Some(bytes))) => writer.add(&entry.name, bytes),
                Some((_, None)) => {}
                None => writer.copy(
                    entry,
                    &self.bytes[entry.data..entry.data + entry.compressed as usize],
                ),
            }
        }
        for (name, bytes) in changes {
            if let Some(bytes) = bytes
                && !self.has(name)
            {
                writer.add(name, bytes);
            }
        }
        writer.finish()
    }
}

#[derive(Default)]
struct Writer {
    out: Vec<u8>,
    directory: Vec<u8>,
    count: u16,
}

impl Writer {
    #[allow(clippy::too_many_arguments)]
    fn entry(&mut self, name: &str, flags: u16, method: u16, crc: u32, size: u32, data: &[u8]) {
        let offset = self.out.len() as u32;
        let mut header = Vec::with_capacity(26);
        header.extend_from_slice(&20u16.to_le_bytes());
        header.extend_from_slice(&flags.to_le_bytes());
        header.extend_from_slice(&method.to_le_bytes());
        // 1980-01-01 00:00, so the same content makes the same file.
        header.extend_from_slice(&0u16.to_le_bytes());
        header.extend_from_slice(&0x21u16.to_le_bytes());
        header.extend_from_slice(&crc.to_le_bytes());
        header.extend_from_slice(&(data.len() as u32).to_le_bytes());
        header.extend_from_slice(&size.to_le_bytes());
        header.extend_from_slice(&(name.len() as u16).to_le_bytes());
        header.extend_from_slice(&0u16.to_le_bytes());
        self.out.extend_from_slice(b"PK\x03\x04");
        self.out.extend_from_slice(&header);
        self.out.extend_from_slice(name.as_bytes());
        self.out.extend_from_slice(data);
        self.directory.extend_from_slice(b"PK\x01\x02");
        self.directory.extend_from_slice(&20u16.to_le_bytes());
        self.directory.extend_from_slice(&header);
        // No comment, disk 0, no attributes.
        self.directory.extend_from_slice(&[0; 10]);
        self.directory.extend_from_slice(&offset.to_le_bytes());
        self.directory.extend_from_slice(name.as_bytes());
        self.count += 1;
    }

    fn add(&mut self, name: &str, bytes: &[u8]) {
        let mut crc = Crc::new();
        crc.update(bytes);
        let mut packer = DeflateEncoder::new(Vec::new(), Compression::default());
        packer.write_all(bytes).expect("memory write");
        let packed = packer.finish().expect("memory write");
        // Bit 11: the name is UTF-8.
        self.entry(name, 0x0800, 8, crc.sum(), bytes.len() as u32, &packed);
    }

    fn copy(&mut self, entry: &Entry, packed: &[u8]) {
        // Sizes now sit in the header, so the "sizes follow" bit goes.
        self.entry(
            &entry.name,
            entry.flags & !0x0008,
            entry.method,
            entry.crc,
            entry.size,
            packed,
        );
    }

    fn finish(mut self) -> Vec<u8> {
        let start = self.out.len() as u32;
        let size = self.directory.len() as u32;
        self.out.append(&mut self.directory);
        self.out.extend_from_slice(b"PK\x05\x06\0\0\0\0");
        self.out.extend_from_slice(&self.count.to_le_bytes());
        self.out.extend_from_slice(&self.count.to_le_bytes());
        self.out.extend_from_slice(&size.to_le_bytes());
        self.out.extend_from_slice(&start.to_le_bytes());
        self.out.extend_from_slice(&0u16.to_le_bytes());
        self.out
    }
}

/// A new file from its parts, in the order given.
pub(crate) fn build(parts: &[(&str, Vec<u8>)]) -> Vec<u8> {
    let mut writer = Writer::default();
    for (name, bytes) in parts {
        writer.add(name, bytes);
    }
    writer.finish()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_file_round_trips_and_a_change_leaves_the_rest_as_packed() {
        let file = build(&[
            ("[Content_Types].xml", b"<Types/>".to_vec()),
            (
                "word/document.xml",
                "<w:t>caf\u{e9}</w:t>".repeat(500).into_bytes(),
            ),
            ("word/media/image1.png", vec![7; 3_000]),
        ]);
        let archive = Archive::open(file).unwrap();
        assert_eq!(
            archive.names().collect::<Vec<_>>(),
            [
                "[Content_Types].xml",
                "word/document.xml",
                "word/media/image1.png"
            ]
        );
        assert_eq!(
            archive.text("[Content_Types].xml").unwrap().unwrap(),
            "<Types/>"
        );
        assert!(archive.read("missing.xml").unwrap().is_none());

        let changed = Archive::open(archive.with(&[
            ("word/document.xml".into(), Some(b"<w:t>new</w:t>".to_vec())),
            ("[Content_Types].xml".into(), None),
            (
                "word/numbering.xml".into(),
                Some(b"<w:numbering/>".to_vec()),
            ),
        ]))
        .unwrap();
        assert_eq!(
            changed.names().collect::<Vec<_>>(),
            [
                "word/document.xml",
                "word/media/image1.png",
                "word/numbering.xml"
            ]
        );
        assert_eq!(
            changed.text("word/document.xml").unwrap().unwrap(),
            "<w:t>new</w:t>"
        );
        assert_eq!(
            changed.read("word/media/image1.png").unwrap().unwrap(),
            vec![7; 3_000]
        );
    }

    #[test]
    fn a_damaged_or_foreign_file_is_refused_not_read() {
        assert!(Archive::open(b"not a zip".to_vec()).is_err());
        assert!(Archive::open(vec![]).is_err());
        let mut file = build(&[("a.xml", b"hello hello hello hello".to_vec())]);
        // Flip a byte of the packed data: its checksum no longer matches.
        file[40] ^= 0xFF;
        let archive = Archive::open(file).unwrap();
        assert!(archive.read("a.xml").is_err());
    }
}
