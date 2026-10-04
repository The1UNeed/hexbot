use crate::{Artifact, InstallOption, Result, fail};
use base64::{Engine, engine::general_purpose::STANDARD};
use sha2::{Digest, Sha256, Sha512};
use std::{
    fs::File,
    io::{Read, Write},
    path::{Component, Path},
};

pub fn verify_file(path: &Path, artifact: &Artifact, option: InstallOption) -> Result<()> {
    let mut file = File::open(path)?;
    let mut sha256 = Sha256::new();
    let mut sha512 = Sha512::new();
    let mut buffer = [0; 64 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        sha256.update(&buffer[..count]);
        sha512.update(&buffer[..count]);
    }
    let matches = if option == InstallOption::Headless {
        artifact
            .sha256
            .as_ref()
            .is_some_and(|s| s.eq_ignore_ascii_case(&format!("{:x}", sha256.finalize())))
    } else {
        artifact.sha512.as_ref().is_some_and(|s| {
            STANDARD
                .decode(s)
                .is_ok_and(|expected| expected == sha512.finalize().as_slice())
        })
    };
    if !matches {
        return fail("The download checksum does not match. Run the installer again.");
    }
    Ok(())
}

/// Native release archives contain materialized regular files, not npm links.
/// Reject all links, devices and FIFOs so extraction cannot write outside root.
pub fn extract_native(archive: &Path, root: &Path) -> Result<()> {
    extract_native_limited(archive, root, 4 * 1024 * 1024 * 1024)
}

fn extract_native_limited(archive: &Path, root: &Path, limit: u64) -> Result<()> {
    let parent = root.parent().ok_or("Missing extraction parent.")?;
    std::fs::create_dir_all(parent)?;
    let staging = tempfile::tempdir_in(parent)?;
    let mut total = 0u64;
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(File::open(archive)?));
    for entry in archive.entries()? {
        let mut entry = entry?;
        let path = entry.path()?.into_owned();
        if path.is_absolute()
            || path.components().any(|c| {
                matches!(
                    c,
                    Component::ParentDir | Component::Prefix(_) | Component::RootDir
                )
            })
        {
            return fail("The native archive contains an unsafe path.");
        }
        let kind = entry.header().entry_type();
        if !kind.is_file() && !kind.is_dir() {
            return fail("The native archive contains a link or unsupported file type.");
        }
        total = total
            .checked_add(entry.size())
            .filter(|size| *size <= limit)
            .ok_or("The native archive exceeds the 4 GiB expanded-size limit.")?;
        if !entry.unpack_in(staging.path())? {
            return fail("The native archive contains an unsafe path.");
        }
    }
    std::fs::rename(staging.path(), root)?;
    Ok(())
}

pub(crate) fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path.parent().ok_or("Missing parent directory.")?;
    std::fs::create_dir_all(parent)?;
    let mut temp = tempfile::NamedTempFile::new_in(parent)?;
    temp.write_all(bytes)?;
    temp.as_file().sync_all()?;
    temp.persist(path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn expanded_size_is_cumulative_and_failed_extraction_is_cleaned_up() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("native.tar.gz");
        let encoder = flate2::write::GzEncoder::new(
            File::create(&path).unwrap(),
            flate2::Compression::default(),
        );
        let mut tar = tar::Builder::new(encoder);
        for name in ["first", "second", "third"] {
            let mut header = tar::Header::new_gnu();
            header.set_size(4);
            header.set_mode(0o644);
            header.set_cksum();
            tar.append_data(&mut header, name, &b"data"[..]).unwrap();
        }
        tar.into_inner().unwrap().finish().unwrap();
        let root = temp.path().join("out");
        assert!(
            extract_native_limited(&path, &root, 8)
                .unwrap_err()
                .to_string()
                .contains("expanded-size limit")
        );
        assert!(!root.exists());
        assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 1);
        extract_native_limited(&path, &root, 12).unwrap();
        assert_eq!(std::fs::read(root.join("third")).unwrap(), b"data");
    }

    #[test]
    fn production_limit_rejects_oversized_header_before_writing_content() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("native.tar.gz");
        let mut header = tar::Header::new_gnu();
        header.set_path("large").unwrap();
        header.set_size(4 * 1024 * 1024 * 1024 + 1);
        header.set_cksum();
        let mut gzip = flate2::write::GzEncoder::new(
            File::create(&path).unwrap(),
            flate2::Compression::default(),
        );
        gzip.write_all(header.as_bytes()).unwrap();
        gzip.finish().unwrap();
        assert!(
            extract_native(&path, &temp.path().join("out"))
                .unwrap_err()
                .to_string()
                .contains("expanded-size limit")
        );
        assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 1);
    }
}
