//! Native ZIP extraction shared with the installer. Never follows archive links.
use std::{
    collections::HashSet,
    fs,
    io::{self, Read},
    path::Path,
};

pub fn extract_zip(source: &Path, root: &Path, limit: u64) -> io::Result<()> {
    let mut archive = zip::ZipArchive::new(fs::File::open(source)?).map_err(io::Error::other)?;
    if archive.len() > 100_000 {
        return Err(io::Error::other("Too many archive entries"));
    }
    let mut total = 0u64;
    let mut names = HashSet::new();
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(io::Error::other)?;
        let name = entry
            .name()
            .trim_start_matches("./")
            .trim_end_matches('/')
            .to_string();
        if name.is_empty() && entry.is_dir() {
            continue;
        }
        if name.is_empty()
            || name.contains(['\\', ':', '\0'])
            || name.starts_with('/')
            || name.split('/').any(|part| {
                let stem = part.split('.').next().unwrap_or("").to_ascii_uppercase();
                matches!(part, "" | "." | "..")
                    || part.ends_with(['.', ' '])
                    || part.chars().any(|c| c.is_control())
                    || matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
                    || (stem.len() == 4
                        && (stem.starts_with("COM") || stem.starts_with("LPT"))
                        && matches!(stem.as_bytes()[3], b'1'..=b'9'))
            })
        {
            return Err(io::Error::other("Unsafe native ZIP path"));
        }
        if !names.insert(name.to_lowercase()) {
            return Err(io::Error::other("Duplicate native ZIP path"));
        }
        if let Some(mode) = entry.unix_mode() {
            let kind = mode & 0o170000;
            if kind != 0 && kind != 0o100000 && kind != 0o040000 {
                return Err(io::Error::other("Unsupported native ZIP file type"));
            }
        }
        total = total
            .checked_add(entry.size())
            .filter(|n| *n <= limit)
            .ok_or_else(|| io::Error::other("Native ZIP exceeds expanded-size limit"))?;
        let path = root.join(&name);
        if entry.is_dir() {
            fs::create_dir_all(path)?;
            continue;
        }
        fs::create_dir_all(path.parent().unwrap())?;
        let mut output = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)?;
        let size = entry.size();
        let copied = io::copy(
            &mut entry.by_ref().take(size.saturating_add(1)),
            &mut output,
        )?;
        if copied != size {
            return Err(io::Error::other("Invalid native ZIP entry size"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    #[test]
    fn windows_paths_links_collisions_and_expansion_limits_are_refused() {
        for names in [
            vec!["../escape"],
            vec!["dir/../../escape"],
            vec!["/escape"],
            vec!["a:b"],
            vec!["NUL.txt"],
            vec!["trailing."],
            vec!["A", "a"],
        ] {
            let temp = tempfile::tempdir().unwrap();
            let source = temp.path().join("archive.zip");
            let mut zip = zip::ZipWriter::new(fs::File::create(&source).unwrap());
            for name in names {
                zip.start_file(name, zip::write::SimpleFileOptions::default())
                    .unwrap();
                zip.write_all(b"42").unwrap();
            }
            zip.finish().unwrap();
            assert!(extract_zip(&source, &temp.path().join("out"), 100).is_err());
        }
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("archive.zip");
        let mut zip = zip::ZipWriter::new(fs::File::create(&source).unwrap());
        zip.start_file("hexbot.exe", zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(b"42").unwrap();
        zip.finish().unwrap();
        assert!(extract_zip(&source, &temp.path().join("small"), 1).is_err());
        extract_zip(&source, &temp.path().join("out"), 2).unwrap();
        assert_eq!(fs::read(temp.path().join("out/hexbot.exe")).unwrap(), b"42");
    }
}
