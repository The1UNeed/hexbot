//! The Windows file bridge's portable rules: the names a walk opens, the
//! identity an edit carries, the temporary file's name and the rename record.
//! `runtime_files_windows.rs` applies them through handles; every host runs
//! their tests.
use crate::windows_paths::sandbox as paths;

/// NTFS and ReFS names hold at most 255 UTF-16 units. A longer one is refused
/// here, so the walk's counted names never overflow.
const NAME_UNITS: usize = 255;
pub(super) const UNRESOLVED: &str = "file path must be absolute and resolved";
pub(super) const NO_NAME: &str = "invalid file name";
pub(super) const LONG: &str = "file names hold at most 255 characters";

/// A file's path, split for a walk from its drive's root.
#[derive(Debug, PartialEq, Eq)]
pub(super) struct Walk {
    /// The path in plain form, as the policy checks judged it: `C:\a\b`.
    pub plain: String,
    /// The drive's root folder: `C:\`.
    pub root: String,
    /// The plain path of the file's folder: `C:\a`, or the root.
    pub folder: String,
    /// The folders below the root, in order.
    pub folders: Vec<Vec<u16>>,
    /// The file's own name.
    pub name: Vec<u16>,
}

/// Split a path for a walk. Its text is judged first
/// (`windows_paths::sandbox::local`), so a network, device or stream path, a
/// reserved name or a name ending in a dot or space never reaches a file
/// system call; `.` and `..` are refused rather than resolved.
pub(super) fn walk(path: &str) -> Result<Walk, &'static str> {
    let plain = paths::local(path)?;
    let (root, rest) = plain.split_at(3);
    let mut names: Vec<&str> = rest.split('\\').filter(|name| !name.is_empty()).collect();
    let name = names.pop().ok_or(NO_NAME)?;
    for part in names.iter().chain([&name]) {
        if matches!(*part, "." | "..") {
            return Err(UNRESOLVED);
        }
        if part.encode_utf16().count() > NAME_UNITS {
            return Err(LONG);
        }
    }
    let units = |name: &str| name.encode_utf16().collect::<Vec<u16>>();
    Ok(Walk {
        folder: format!("{root}{}", names.join("\\")),
        root: root.to_owned(),
        folders: names.iter().map(|name| units(name)).collect(),
        name: units(name),
        plain,
    })
}

/// Whether the path Windows reports for an opened folder or file, its final
/// normalized path, is the plain path the policy checks judged. A short 8.3
/// name, or a name Windows matches without case that those checks fold
/// differently, reaches the same entry by other text, so it does not match.
pub(super) fn same_path(reported: &str, plain: &str) -> bool {
    paths::simplify(reported).is_ok_and(|reported| paths::fold(&reported) == paths::fold(plain))
}

/// An edit carries the file's identity from its read to its write, as the
/// Unix bridge carries its folder's device and inode: the volume serial
/// number and the 128-bit file ID, as two strings of digits, the form the
/// extension checks and returns.
pub(super) fn identity(volume: u64, file: [u8; 16]) -> [String; 2] {
    [volume.to_string(), u128::from_le_bytes(file).to_string()]
}

/// The file a write fills before it replaces the target, as on Unix.
pub(super) fn temporary(id: &str) -> Vec<u16> {
    format!(".hexbot-{id}.tmp").encode_utf16().collect()
}

/// FILE_RENAME_INFORMATION, which the Ex form shares: its flags (the first
/// byte is ReplaceIfExists in the plain form), the folder the new name is
/// relative to, the name's length in bytes and the name, which starts right
/// after the length. The record and its length in bytes, never less than the
/// C struct's size, which Windows requires even for a one-letter name.
pub(super) fn rename_record(flags: u32, folder: usize, name: &[u16]) -> (Vec<u64>, u32) {
    #[repr(C)]
    struct Header {
        flags: u32,
        folder: usize,
        length: u32,
    }
    let (folder_at, length_at) = (
        std::mem::offset_of!(Header, folder),
        std::mem::offset_of!(Header, length),
    );
    let start = length_at + 4;
    // The C struct ends in a one-character name, padded to its alignment.
    let minimum = (start + 2).next_multiple_of(align_of::<Header>());
    let size = (start + name.len() * 2).max(minimum);
    let mut bytes = vec![0u8; size.div_ceil(8) * 8];
    bytes[..4].copy_from_slice(&flags.to_ne_bytes());
    bytes[folder_at..folder_at + size_of::<usize>()].copy_from_slice(&folder.to_ne_bytes());
    bytes[length_at..start].copy_from_slice(&((name.len() * 2) as u32).to_ne_bytes());
    for (index, unit) in name.iter().enumerate() {
        bytes[start + index * 2..start + index * 2 + 2].copy_from_slice(&unit.to_ne_bytes());
    }
    let record = bytes
        .chunks_exact(8)
        .map(|chunk| u64::from_ne_bytes(chunk.try_into().expect("eight bytes")))
        .collect();
    (record, size as u32)
}

/// Statuses that mean the file system has no Ex form of an information
/// class, such as FileRenameInformationEx (FAT and exFAT, older Windows),
/// which then takes the plain class. Any other failure, such as a folder or
/// a read-only file at a rename's target, stands.
pub(super) fn unsupported_class(status: i32) -> bool {
    matches!(
        status as u32,
        0xC000_0002 | 0xC000_0003 | 0xC000_000D | 0xC000_00BB
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn units(name: &str) -> Vec<u16> {
        name.encode_utf16().collect()
    }

    #[test]
    fn walks_split_plain_paths_and_refuse_by_text_first() {
        let split = walk(r"C:/Users/owl/work\notes.txt").unwrap();
        assert_eq!(split.plain, r"C:\Users\owl\work\notes.txt");
        assert_eq!(split.root, r"C:\");
        assert_eq!(split.folder, r"C:\Users\owl\work");
        assert_eq!(split.folders, ["Users", "owl", "work"].map(units));
        assert_eq!(split.name, units("notes.txt"));
        let top = walk(r"\\?\D:\file").unwrap();
        assert_eq!(
            (top.root.as_str(), top.folder.as_str(), top.folders.len()),
            (r"D:\", r"D:\", 0)
        );
        assert_eq!(top.name, units("file"));
        let longest = format!(r"C:\work\{}", "é".repeat(255));
        assert_eq!(walk(&longest).unwrap().name.len(), 255);
        let too_long = format!(r"C:\{}\file", "x".repeat(256));
        for (path, reason) in [
            (r"\\server\share\file", paths::NETWORK),
            (r"\\?\UNC\server\share\file", paths::NETWORK),
            (r"\\.\pipe\hexbot", paths::DEVICE),
            (r"\\?\GLOBALROOT\Device\HarddiskVolume1\file", paths::DEVICE),
            (r"\??\C:\file", paths::DEVICE),
            (r"C:\work\notes.txt:secret", paths::STREAM),
            (r"C:\work\notes.txt::$DATA", paths::STREAM),
            (r"C:\work\CON", paths::RESERVED),
            (r"C:\work\nul.txt\file", paths::RESERVED),
            (r"C:\work\notes.", paths::TRAILING),
            (r"C:\work \notes", paths::TRAILING),
            (r"work\notes.txt", paths::RELATIVE),
            (r"C:notes.txt", paths::RELATIVE),
            (r"C:\work\..\notes.txt", UNRESOLVED),
            (r"C:\work\.\notes.txt", UNRESOLVED),
            (r"C:\work\..", UNRESOLVED),
            (r"C:\", NO_NAME),
            (too_long.as_str(), LONG),
        ] {
            assert_eq!(walk(path), Err(reason), "{path}");
        }
    }

    #[test]
    fn final_paths_must_be_the_judged_text() {
        assert!(same_path(r"\\?\C:\Users\Owl\Work", r"C:\users\owl\work"));
        assert!(same_path(r"\\?\C:\", r"C:\"));
        assert!(same_path(r"C:\work\file", r"C:\work\file"));
        for (reported, plain) in [
            // An 8.3 name reaches `.git` by text no check saw.
            (r"\\?\C:\work\.git", r"C:\work\GIT~1"),
            (r"\\?\C:\work\.env", r"C:\work\ENV~1"),
            // A name Windows matches without case, that lowercase does not.
            (r"\\?\C:\work\.git", r"C:\work\.gıt"),
            // A substituted drive reaches another folder.
            (r"\\?\C:\real\work", r"X:\work"),
            (r"\\?\UNC\server\share\work", r"C:\work"),
            (r"\\?\Volume{0}\work", r"C:\work"),
            (r"\\?\C:\work\file", r"C:\work\file2"),
        ] {
            assert!(!same_path(reported, plain), "{reported} {plain}");
        }
    }

    #[test]
    fn identities_are_two_strings_of_digits_that_tell_files_apart() {
        let one = identity(0x1234_5678_9abc_def0, [7; 16]);
        assert!(
            one.iter()
                .all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()))
        );
        assert_eq!(one, identity(0x1234_5678_9abc_def0, [7; 16]));
        assert_ne!(one, identity(0x1234_5678_9abc_def1, [7; 16]));
        let mut other = [7; 16];
        other[15] = 8;
        assert_ne!(one, identity(0x1234_5678_9abc_def0, other));
        assert_eq!(
            identity(u64::MAX, [0xff; 16]),
            [u64::MAX.to_string(), u128::MAX.to_string()]
        );
        assert_eq!(identity(0, [0; 16]), ["0", "0"]);
    }

    #[test]
    fn temporary_names_pass_the_rules_every_walked_name_does() {
        let id = "0123456789abcdef0123456789abcdef";
        let name = String::from_utf16(&temporary(id)).unwrap();
        assert_eq!(name, format!(".hexbot-{id}.tmp"));
        assert_eq!(
            walk(&format!(r"C:\work\{name}")).unwrap().name,
            temporary(id)
        );
        assert_ne!(temporary(id), temporary(&id.replace('0', "1")));
    }

    #[test]
    fn rename_records_follow_the_native_layout() {
        let name = units("target.txt");
        let (record, length) = rename_record(3, 0x1234_5678, &name);
        let bytes: Vec<u8> = record.iter().flat_map(|word| word.to_ne_bytes()).collect();
        // Flags, then the folder handle on its pointer boundary, then the
        // name's byte length, then the name with no padding before it.
        let pointer = size_of::<usize>();
        assert_eq!(bytes[..4], 3u32.to_ne_bytes());
        assert_eq!(bytes[pointer..pointer * 2], 0x1234_5678usize.to_ne_bytes());
        assert_eq!(bytes[pointer * 2..pointer * 2 + 4], 20u32.to_ne_bytes());
        let start = pointer * 2 + 4;
        assert_eq!(length as usize, start + 20);
        // FILE_RENAME_INFORMATION is 24 bytes on 64-bit Windows: a shorter
        // record is refused, so a one-letter name still takes 24.
        let (short, length) = rename_record(1, 1, &units("a"));
        assert_eq!(length as usize, (start + 2).next_multiple_of(pointer));
        assert!(short.len() * 8 >= length as usize);
        let written: Vec<u16> = bytes[start..start + 20]
            .chunks_exact(2)
            .map(|pair| u16::from_ne_bytes([pair[0], pair[1]]))
            .collect();
        assert_eq!(written, name);
        assert!(bytes.len() >= length as usize && bytes.len().is_multiple_of(8));
    }

    #[test]
    fn only_a_missing_ex_class_takes_the_plain_class() {
        for status in [0xC000_0002_u32, 0xC000_0003, 0xC000_000D, 0xC000_00BB] {
            assert!(unsupported_class(status as i32), "{status:#x}");
        }
        // Access denied (a folder or read-only file there), a sharing
        // violation, a collision and success all stand.
        for status in [0xC000_0022_u32, 0xC000_0043, 0xC000_0035, 0] {
            assert!(!unsupported_class(status as i32), "{status:#x}");
        }
    }
}
