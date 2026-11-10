//! Windows paths and command lines. `system_program` locates trusted programs
//! through the OS, not the caller's PATH. `sandbox` holds the Windows sandbox's
//! pure rules, which every host builds for its tests.
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

/// The module path for the Windows PowerShell at `program`: its own
/// `$PSHOME\Modules`, the folder of `program`. A PowerShell 7 parent's module
/// path reaches Windows PowerShell 5.1 through every process in between, and
/// 5.1 then finds 7's same-name modules first and cannot load them
/// (about_PSModulePath); a stripped environment names no modules at all.
/// Every Windows PowerShell Hexbot starts gets this path, as does a program
/// that starts one for Hexbot.
// Only some of the crates that include this file start PowerShell.
#[cfg(windows)]
#[allow(dead_code)]
pub fn powershell_modules(program: &std::path::Path) -> std::path::PathBuf {
    // Rebuilt from its components, so every separator is native.
    let home: std::path::PathBuf = program.parent().unwrap_or(program).components().collect();
    home.join("Modules")
}

/// System32's Windows PowerShell, with its own modules ([`powershell_modules`]).
#[cfg(windows)]
#[allow(dead_code)]
pub fn system_powershell() -> std::io::Result<std::process::Command> {
    let program = system_program("WindowsPowerShell/v1.0/powershell.exe")?;
    let mut command = std::process::Command::new(&program);
    command.env("PSModulePath", powershell_modules(&program));
    Ok(command)
}

/// The Windows sandbox's rules: path forms, which roots a container may be
/// granted, command-line quoting, profile names and the grant journal.
/// `windows_container` applies them.
#[cfg(any(windows, test))]
// The service parent and the launcher tests include this file for `system_program` alone.
#[allow(dead_code)]
pub mod sandbox {
    use serde::{Deserialize, Serialize};
    use std::path::PathBuf;

    /// Which container a command runs in.
    #[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "snake_case")]
    pub enum Access {
        /// Auto: the workspace and outputs are writable.
        Workspace,
        /// Manual: the workspace is only readable.
        Read,
    }
    impl Access {
        pub fn suffix(self) -> &'static str {
            match self {
                Self::Workspace => "write",
                Self::Read => "read",
            }
        }
    }

    #[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
    #[serde(rename_all = "snake_case")]
    pub enum GrantKind {
        Read,
        Modify,
        DenyWrite,
        DenyAll,
        /// Pass-through alone on one folder above a private folder. Earlier
        /// builds wrote it; a container needs none, and `hexbot sandbox
        /// reset` takes it off that folder without opening what it holds.
        Traverse,
    }
    impl GrantKind {
        /// Whether the grant protects a path rather than opening one: it caps
        /// what allows above it opened, so an entry its walk misses stays open.
        pub fn denies(self) -> bool {
            matches!(self, Self::DenyWrite | Self::DenyAll)
        }
    }

    /// Everything one contained command may reach. The daemon builds it and
    /// `hexbot sandbox exec` applies it.
    #[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
    pub struct Policy {
        /// The Hexbot home: its journal, lock and the containers' private folders.
        /// The helper never reads HEXBOT_HOME: callers clear the environment of
        /// the commands they contain.
        pub home: PathBuf,
        pub access: Option<Access>,
        /// Folders the command may write (Auto's workspace, approved outputs).
        pub writable: Vec<PathBuf>,
        /// Folders the command may read and run programs from.
        pub readable: Vec<PathBuf>,
        /// Git metadata: readable where granted, never written.
        pub deny_write: Vec<PathBuf>,
        /// Project secrets: never read or written.
        pub deny_all: Vec<PathBuf>,
        /// The shell the runtime ships (`windows_sandbox::bundled_shell`),
        /// read as `readable` is but left out of the container's name: each
        /// runtime brings it at a new path, and the containers stay the same.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub shell: Option<PathBuf>,
    }

    /// Every profile Hexbot created and every root it changed, kept before each.
    #[derive(Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
    pub struct Journal {
        pub roots: Vec<JournalEntry>,
        pub profiles: Vec<String>,
    }
    #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
    pub struct JournalEntry {
        pub path: PathBuf,
        /// The container profile the grant is for.
        pub profile: String,
        pub kind: GrantKind,
        /// False until the walk finished; an unfinished grant is walked again.
        pub complete: bool,
    }

    fn digest(bytes: &[u8]) -> String {
        use sha2::{Digest, Sha256};
        Sha256::digest(bytes)[..8]
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect()
    }

    /// Windows compares paths without case.
    pub fn fold(path: &str) -> String {
        path.to_lowercase()
    }

    /// Names one set of roots: the same writable and readable roots, in any
    /// order, give the same digest. Roots are plain paths.
    pub fn roots_digest(writable: &[String], readable: &[String]) -> String {
        let mut text = String::new();
        for (tag, roots) in [("write", writable), ("read", readable)] {
            let mut roots: Vec<String> = roots.iter().map(|root| fold(root)).collect();
            roots.sort();
            roots.dedup();
            // NUL never appears in a Windows path.
            for root in roots {
                text.push_str(tag);
                text.push('\0');
                text.push_str(&root);
                text.push('\0');
            }
        }
        digest(text.as_bytes())
    }

    /// The profile for one home, access level and set of roots, under the
    /// 64-character limit. `home` is plain; `roots` comes from [`roots_digest`].
    pub fn profile_name(home: &str, access: Access, roots: &str) -> String {
        format!(
            "Hexbot.Sandbox.{}.{}.{roots}",
            access.suffix(),
            digest(fold(home).as_bytes())
        )
    }

    pub const NETWORK: &str = "Sandbox paths cannot be network paths";
    pub const DEVICE: &str = "Sandbox paths cannot be device or NT object paths";
    pub const STREAM: &str = "Sandbox paths cannot name an alternate data stream";
    pub const RELATIVE: &str = "Sandbox paths must be absolute disk paths";

    /// A disk path in plain form, from a caller or `canonicalize`: `\\?\C:\x`
    /// becomes `C:\x` and `/` becomes `\`. Network (`\\server`, `\\?\UNC\`),
    /// device (`\\.\`, `\\?\Volume{..}`) and NT object (`\??\`) paths,
    /// alternate data streams and relative paths are refused. `.` and `..`
    /// stay as they are, so only canonical paths are compared.
    pub fn simplify(path: &str) -> Result<String, &'static str> {
        let (verbatim, rest) = match path.strip_prefix(r"\\?\") {
            Some(rest) => (true, rest),
            None => (false, path),
        };
        // A verbatim path keeps `/` as a character, which no disk name holds.
        let separator = |c: char| c == '\\' || (!verbatim && c == '/');
        if verbatim
            && rest
                .get(..4)
                .is_some_and(|prefix| prefix.eq_ignore_ascii_case(r"UNC\"))
        {
            return Err(NETWORK);
        }
        let mut chars = rest.chars();
        match (chars.next(), chars.next(), chars.next()) {
            (Some(first), Some(second), _) if separator(first) && separator(second) => {
                return Err(if rest[2..].starts_with(['.', '?']) {
                    DEVICE
                } else {
                    NETWORK
                });
            }
            (Some('\\'), Some('?'), Some('?')) => return Err(DEVICE),
            (Some(drive), Some(':'), Some(slash))
                if drive.is_ascii_alphabetic() && separator(slash) => {}
            _ => return Err(if verbatim { DEVICE } else { RELATIVE }),
        }
        let tail = &rest[3..];
        if tail.contains(':') {
            return Err(STREAM);
        }
        if verbatim && tail.contains('/') {
            return Err(DEVICE);
        }
        let components: Vec<&str> = tail.split(separator).filter(|c| !c.is_empty()).collect();
        Ok(format!("{}\\{}", &rest[..2], components.join("\\")))
    }

    pub const RESERVED: &str = "Paths cannot use a reserved Windows device name";
    /// A link on the way names a network share, a device or a drive that is
    /// no fixed disk, or the chain of links is too long to judge.
    pub const LINKED: &str = "Paths cannot pass through a link that leaves this computer's disks";
    pub const TRAILING: &str = "Paths cannot have names that end in a dot or space";

    /// A disk path in plain form whose names Windows opens as named: never a
    /// reserved device name (CON, NUL, COM1, with any extension), which a
    /// plain path opens as the device, and never a name ending in a dot or
    /// space, which Windows strips and so opens another file.
    pub fn local(path: &str) -> Result<String, &'static str> {
        let plain = simplify(path)?;
        for name in plain[3..].split('\\').filter(|name| !name.is_empty()) {
            if name == "." || name == ".." {
                continue;
            }
            if name.ends_with(['.', ' ']) {
                return Err(TRAILING);
            }
            let stem = name.split('.').next().unwrap_or(name).trim_end_matches(' ');
            let device = ["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"]
                .iter()
                .any(|device| stem.eq_ignore_ascii_case(device))
                || ["COM", "LPT"].iter().any(|port| {
                    stem.get(..3)
                        .is_some_and(|start| start.eq_ignore_ascii_case(port))
                        && matches!(
                            &stem[3..],
                            "0" | "1"
                                | "2"
                                | "3"
                                | "4"
                                | "5"
                                | "6"
                                | "7"
                                | "8"
                                | "9"
                                | "¹"
                                | "²"
                                | "³"
                        )
                });
            if device {
                return Err(RESERVED);
            }
        }
        Ok(plain)
    }

    /// Whether `path` is `root` or inside it. Both are plain and folded.
    pub fn within(path: &str, root: &str) -> bool {
        path.strip_prefix(root)
            .is_some_and(|rest| rest.is_empty() || root.ends_with('\\') || rest.starts_with('\\'))
    }

    /// An AppContainer has no network and reads only what it is granted, so a
    /// command cannot leave the workspace sandbox for the base layer alone.
    pub const FULL_ACCESS: &str = "On Windows, Auto and Manual run every command inside the sandbox, so full_access is not available. Bypass runs commands without a sandbox.";
    pub const HOME: &str =
        "Sandbox roots cannot be or contain the user's profile or the Hexbot home";
    pub const STORE: &str = "Sandbox roots cannot be, contain or sit inside a credential store";
    pub const RUNTIME: &str = "Sandbox roots cannot be or contain the managed runtime";
    pub const RUNTIME_WRITE: &str = "Writable sandbox roots cannot sit inside the managed runtime";

    /// What no root may reach, as plain, folded paths.
    #[derive(Debug, Default)]
    pub struct Protected {
        /// The user's profile and its AppData folders, and the Hexbot home. A
        /// root may sit inside them: workspaces and outputs do.
        pub homes: Vec<String>,
        /// Credential stores and the sandbox's own journal and folders.
        pub stores: Vec<String>,
        /// Managed runtime roots. Programs there may be read, never written.
        pub runtime: Vec<String>,
    }
    impl Protected {
        /// Why `root`, plain and folded, cannot be granted, if it cannot.
        pub fn refusal(&self, root: &str, writable: bool) -> Option<&'static str> {
            if self.homes.iter().any(|home| within(home, root)) {
                Some(HOME)
            } else if self
                .stores
                .iter()
                .any(|store| within(store, root) || within(root, store))
            {
                Some(STORE)
            } else if self.runtime.iter().any(|runtime| within(runtime, root)) {
                Some(RUNTIME)
            } else if writable && self.runtime.iter().any(|runtime| within(root, runtime)) {
                Some(RUNTIME_WRITE)
            } else {
                None
            }
        }
    }

    #[derive(Deserialize)]
    struct CredentialPolicy {
        #[serde(rename = "readDeny")]
        read_deny: Vec<String>,
        #[serde(rename = "windowsReadDeny", default)]
        windows_read_deny: Vec<String>,
        #[serde(rename = "windowsWriteDeny", default)]
        windows_write_deny: Vec<String>,
        write: WritePolicy,
        user: Vec<String>,
        #[serde(rename = "managedRuntime")]
        managed_runtime: Vec<String>,
    }
    #[derive(Deserialize)]
    struct WritePolicy {
        deny: Vec<String>,
    }

    /// Credential stores, relative to each user home, and managed runtime
    /// roots, relative to the Hexbot home, from the policy the other sandboxes
    /// and the file tools use. SSH keys are credentials too.
    pub fn policy_paths() -> (Vec<String>, Vec<String>) {
        let policy: CredentialPolicy =
            serde_json::from_str(include_str!("../../pi-runtime/credential-policy.json"))
                .expect("credential policy");
        let native = |path: &String| path.replace('/', "\\");
        let mut stores: Vec<String> = policy
            .read_deny
            .iter()
            .chain(&policy.windows_read_deny)
            .chain(&policy.write.deny)
            .chain(&policy.windows_write_deny)
            .chain(&policy.user)
            .map(native)
            .collect();
        stores.push(".ssh".into());
        (stores, policy.managed_runtime.iter().map(native).collect())
    }

    /// Units that need quotes: separators for the C runtime and MSYS, quotes
    /// of either kind, and what MSYS expands outside quotes when one of Git's
    /// MSYS tools reads a Windows command line: `~` and the glob characters.
    /// BusyBox expands none: the sandbox sets `BB_GLOBBING=0` for it.
    const QUOTED: &[u8] = b" \t\n\r\x0b\x0c\"'*?[{~";

    /// Quote one argument as the Microsoft C runtime parses it. MSYS reads
    /// `\\` inside quotes as one backslash, unlike the C runtime, so only
    /// arguments without doubled backslashes reach MSYS programs exactly.
    pub fn quote(argument: &[u16]) -> Vec<u16> {
        let special = |unit: u16| unit < 0x80 && QUOTED.contains(&(unit as u8));
        if !argument.is_empty() && !argument.iter().any(|&unit| special(unit)) {
            return argument.to_vec();
        }
        let (quote, backslash) = (b'"' as u16, b'\\' as u16);
        let mut quoted = vec![quote];
        let mut backslashes = 0;
        for &unit in argument {
            if unit == backslash {
                backslashes += 1;
                continue;
            }
            let escapes = if unit == quote {
                backslashes * 2 + 1
            } else {
                backslashes
            };
            quoted.extend(std::iter::repeat_n(backslash, escapes));
            backslashes = 0;
            quoted.push(unit);
        }
        quoted.extend(std::iter::repeat_n(backslash, backslashes * 2));
        quoted.push(quote);
        quoted
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn units(text: &str) -> Vec<u16> {
            text.encode_utf16().collect()
        }

        /// How the Microsoft C runtime splits the arguments after the program.
        fn split(line: &[u16]) -> Vec<Vec<u16>> {
            let (space, tab, quote, backslash) =
                (b' ' as u16, b'\t' as u16, b'"' as u16, b'\\' as u16);
            let mut arguments = Vec::new();
            let mut i = 0;
            loop {
                while i < line.len() && (line[i] == space || line[i] == tab) {
                    i += 1;
                }
                if i == line.len() {
                    return arguments;
                }
                let mut argument = Vec::new();
                let mut quoted = false;
                while i < line.len() {
                    let mut backslashes = 0;
                    while i < line.len() && line[i] == backslash {
                        backslashes += 1;
                        i += 1;
                    }
                    if i < line.len() && line[i] == quote {
                        argument.extend(std::iter::repeat_n(backslash, backslashes / 2));
                        if backslashes % 2 == 1 {
                            argument.push(quote);
                        } else {
                            quoted = !quoted;
                        }
                        i += 1;
                        continue;
                    }
                    argument.extend(std::iter::repeat_n(backslash, backslashes));
                    if i == line.len() || (!quoted && (line[i] == space || line[i] == tab)) {
                        break;
                    }
                    argument.push(line[i]);
                    i += 1;
                }
                arguments.push(argument);
            }
        }

        #[test]
        fn quoting_matches_the_c_runtime_and_keeps_msys_from_expanding() {
            let cases = [
                ("plain", "plain"),
                (r"C:\Program\x.exe", r"C:\Program\x.exe"),
                ("ünïcødé", "ünïcødé"),
                ("with space", "\"with space\""),
                ("", "\"\""),
                ("a\"b", "\"a\\\"b\""),
                ("trailing\\ space\\", "\"trailing\\ space\\\\\""),
                ("\\\"", "\"\\\\\\\"\""),
                ("ünïcødé 名前", "\"ünïcødé 名前\""),
                ("tab\there", "\"tab\there\""),
                ("line\nbreak", "\"line\nbreak\""),
                ("*", "\"*\""),
                ("*.txt", "\"*.txt\""),
                ("a?b", "\"a?b\""),
                ("[ab]", "\"[ab]\""),
                ("{a,b}", "\"{a,b}\""),
                ("~", "\"~\""),
                ("~/x", "\"~/x\""),
                ("it's", "\"it's\""),
            ];
            for (input, expected) in cases {
                let quoted = String::from_utf16(&quote(&units(input))).unwrap();
                assert_eq!(quoted, expected, "{input:?}");
            }
        }

        #[test]
        fn quoted_arguments_split_back_unchanged() {
            let cases = [
                "",
                "plain",
                "with space",
                "a\"b",
                "\\",
                "\\\\",
                "a\\",
                "a\\ b",
                "\\\"",
                "a\\\"b",
                "\"\"",
                " ",
                "tab\there",
                "C:\\Program Files\\x\\",
                "ünïcødé 名前",
                "😀 x",
                "*",
                "?",
                "[x]",
                "{a,b}",
                "~",
                "it's",
                "a\\\\\"b c\\\\",
            ];
            let mut line = Vec::new();
            for case in cases {
                line.extend(quote(&units(case)));
                line.push(b' ' as u16);
            }
            let expected: Vec<Vec<u16>> = cases.iter().map(|case| units(case)).collect();
            assert_eq!(split(&line), expected);
        }

        #[test]
        fn simplify_keeps_disk_paths_and_refuses_every_other_form() {
            for (input, expected) in [
                (r"\\?\C:\Users\x", r"C:\Users\x"),
                (r"\\?\c:\", r"c:\"),
                (r"C:\", r"C:\"),
                ("C:/work/sub/", r"C:\work\sub"),
                (r"C:\work\\sub\", r"C:\work\sub"),
                (r"D:\名前\ünïcødé", r"D:\名前\ünïcødé"),
            ] {
                assert_eq!(simplify(input), Ok(expected.to_owned()), "{input}");
            }
            for (input, reason) in [
                (r"\\?\UNC\server\share\x", NETWORK),
                (r"\\?\unc\server\share", NETWORK),
                (r"\\server\share\x", NETWORK),
                ("//server/share", NETWORK),
                (r"\/server\share", NETWORK),
                (r"\\.\pipe\x", DEVICE),
                (r"\\.\C:\x", DEVICE),
                ("//?/C:/x", DEVICE),
                (r"\??\C:\x", DEVICE),
                (r"\\?\GLOBALROOT\Device\HarddiskVolume1\x", DEVICE),
                (
                    r"\\?\Volume{0a1b2c3d-0000-0000-0000-000000000000}\x",
                    DEVICE,
                ),
                (r"\\?\C:\work/x", DEVICE),
                (r"\\?\C:", DEVICE),
                (r"C:\work\file:stream", STREAM),
                (r"C:\work\file::$DATA", STREAM),
                (r"\\?\C:\work\file:stream", STREAM),
                (r"work\sub", RELATIVE),
                (r"\work", RELATIVE),
                ("C:work", RELATIVE),
                ("C:", RELATIVE),
                ("", RELATIVE),
            ] {
                assert_eq!(simplify(input), Err(reason), "{input}");
            }
        }

        #[test]
        fn local_paths_refuse_device_names_and_names_windows_would_strip() {
            for (input, expected) in [
                (r"C:\work\app", r"C:\work\app"),
                ("C:/work/con-tools", r"C:\work\con-tools"),
                (r"C:\work\console", r"C:\work\console"),
                (r"C:\work\COM10", r"C:\work\COM10"),
                (r"C:\work\.git\config", r"C:\work\.git\config"),
                (r"\\?\C:\work\notes.txt", r"C:\work\notes.txt"),
                (r"C:\", r"C:\"),
            ] {
                assert_eq!(local(input), Ok(expected.to_owned()), "{input}");
            }
            for (input, reason) in [
                (r"C:\work\CON", RESERVED),
                (r"C:\work\nul.txt", RESERVED),
                (r"C:\work\Aux\x", RESERVED),
                (r"C:\work\COM1", RESERVED),
                (r"C:\work\lpt9.log", RESERVED),
                (r"C:\work\COM¹", RESERVED),
                (r"C:\work\conin$", RESERVED),
                (r"C:\work\NUL .txt", RESERVED),
                (r"C:\work\app.", TRAILING),
                (r"C:\work\app ", TRAILING),
                (r"C:\work\file:stream", STREAM),
                (r"\\server\share\work", NETWORK),
                (r"\\.\pipe\work", DEVICE),
                (r"work", RELATIVE),
            ] {
                assert_eq!(local(input), Err(reason), "{input}");
            }
        }

        #[test]
        fn within_respects_component_boundaries() {
            assert!(within(r"c:\a\b", r"c:\a"));
            assert!(within(r"c:\a", r"c:\a"));
            assert!(within(r"c:\a", r"c:\"));
            assert!(!within(r"c:\ab", r"c:\a"));
            assert!(!within(r"c:\", r"c:\a"));
            assert!(!within(r"d:\a", r"c:\"));
        }

        #[test]
        fn roots_cannot_reach_the_profile_the_home_stores_or_the_runtime() {
            let protected = Protected {
                homes: vec![
                    r"c:\users\x".into(),
                    r"c:\users\x\appdata\local".into(),
                    r"c:\users\x\.hexbot".into(),
                ],
                stores: vec![
                    r"c:\users\x\.aws".into(),
                    r"c:\users\x\.config\gh".into(),
                    r"c:\users\x\.hexbot\runtime\sandbox".into(),
                ],
                runtime: vec![r"c:\users\x\.hexbot\runtime\native".into()],
            };
            for (root, writable, expected) in [
                (r"c:\users\x", false, Some(HOME)),
                (r"c:\users", false, Some(HOME)),
                (r"c:\", true, Some(HOME)),
                (r"c:\users\x\appdata\local", false, Some(HOME)),
                (r"c:\users\x\.hexbot", true, Some(HOME)),
                (r"c:\users\x\.aws", false, Some(STORE)),
                (r"c:\users\x\.aws\sub", true, Some(STORE)),
                (r"c:\users\x\.config", false, Some(STORE)),
                (
                    r"c:\users\x\.hexbot\runtime\sandbox\write-0",
                    false,
                    Some(STORE),
                ),
                (r"c:\users\x\.hexbot\runtime", false, Some(STORE)),
                (r"c:\users\x\.hexbot\runtime\native", false, Some(RUNTIME)),
                (
                    r"c:\users\x\.hexbot\runtime\native\v1",
                    true,
                    Some(RUNTIME_WRITE),
                ),
                (r"c:\users\x\.hexbot\runtime\native\v1", false, None),
                (r"c:\users\x\.hexbot\profiles\owl\artifacts", true, None),
                (r"c:\users\x\projects\app", true, None),
                (r"c:\users\x\.awsome", true, None),
                (r"c:\users\x\appdata\local\programs\tool", false, None),
                (r"d:\work", true, None),
            ] {
                assert_eq!(protected.refusal(root, writable), expected, "{root}");
            }
        }

        #[test]
        fn the_credential_policy_names_the_stores_and_the_runtime() {
            let (stores, runtime) = policy_paths();
            for store in [
                ".aws",
                ".ssh",
                ".kube",
                ".config\\gh",
                "Library\\Keychains",
                ".codex\\auth.json",
                "AppData\\Local\\Google",
                "AppData\\Local\\Microsoft\\Edge",
                "AppData\\Roaming\\Mozilla",
                "AppData\\Roaming\\Microsoft\\Credentials",
                "AppData\\Roaming\\Microsoft\\Protect",
                "AppData\\Roaming\\gcloud",
                "AppData\\Roaming\\GitHub CLI",
            ] {
                assert!(stores.iter().any(|s| s == store), "{store}");
            }
            for root in [
                "runtime\\native",
                "runtime\\tools",
                "runtime\\bin",
                "bin",
                "python",
            ] {
                assert!(runtime.iter().any(|r| r == root), "{root}");
            }
        }

        #[test]
        fn roots_digests_and_profile_names_are_stable() {
            let w = |roots: &[&str]| {
                roots
                    .iter()
                    .map(|root| root.to_string())
                    .collect::<Vec<_>>()
            };
            let digest = roots_digest(&w(&[r"C:\work", r"C:\out"]), &w(&[r"C:\tools"]));
            // A change here renames every container, which strands their grants.
            assert_eq!(digest, "db5ced832d0d6b9f");
            assert_eq!(
                roots_digest(&w(&[r"c:\out", r"C:\WORK", r"C:\work"]), &w(&[r"C:\tools"])),
                digest,
                "order, case and repeats do not matter"
            );
            assert_ne!(
                roots_digest(&w(&[r"C:\work"]), &w(&[r"C:\out", r"C:\tools"])),
                digest
            );
            assert_ne!(
                roots_digest(&w(&[r"C:\work", r"C:\tools"]), &w(&[r"C:\out"])),
                digest
            );
            assert_ne!(
                roots_digest(&w(&[r"C:\work"]), &[]),
                roots_digest(&[], &w(&[r"C:\work"]))
            );
            assert_ne!(
                roots_digest(&w(&[r"C:\work"]), &[]),
                roots_digest(&w(&[r"C:\work2"]), &[])
            );

            let name = profile_name(r"C:\Users\x\.hexbot", Access::Workspace, &digest);
            assert_eq!(
                name,
                "Hexbot.Sandbox.write.2890b49fdcc73f54.db5ced832d0d6b9f"
            );
            assert!(name.len() <= 64);
            assert_eq!(
                profile_name(r"c:\users\X\.HEXBOT", Access::Workspace, &digest),
                name
            );
            assert_ne!(
                profile_name(r"C:\Users\x\.hexbot", Access::Read, &digest),
                name
            );
            assert_ne!(
                profile_name(r"C:\Users\y\.hexbot", Access::Workspace, &digest),
                name
            );
        }

        #[test]
        fn the_journal_names_the_profile_of_every_grant() {
            let journal = Journal {
                roots: vec![JournalEntry {
                    path: PathBuf::from(r"\\?\C:\work\.git"),
                    profile: "Hexbot.Sandbox.write.a.b".into(),
                    kind: GrantKind::DenyWrite,
                    complete: false,
                }],
                profiles: vec!["Hexbot.Sandbox.write.a.b".into()],
            };
            let text = serde_json::to_string(&journal).unwrap();
            assert_eq!(
                text,
                r#"{"roots":[{"path":"\\\\?\\C:\\work\\.git","profile":"Hexbot.Sandbox.write.a.b","kind":"deny_write","complete":false}],"profiles":["Hexbot.Sandbox.write.a.b"]}"#
            );
            assert_eq!(serde_json::from_str::<Journal>(&text).unwrap(), journal);
            // Reset revokes a grant for its own profile's SID, so an entry without one never loads.
            assert!(
                serde_json::from_str::<Journal>(
                    r#"{"roots":[{"path":"C:\\work","access":"workspace","kind":"modify","complete":true}],"profiles":[]}"#
                )
                .is_err()
            );
            assert!(GrantKind::DenyWrite.denies() && GrantKind::DenyAll.denies());
            assert!(!GrantKind::Read.denies() && !GrantKind::Modify.denies());
        }
    }
}
