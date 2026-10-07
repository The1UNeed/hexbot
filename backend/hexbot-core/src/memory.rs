//! File-backed About you and bot memory. Agent prompt snapshots are not integrated here.

use std::{
    collections::HashMap,
    fs,
    io::Write,
    ops::Range,
    path::{Component, Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::UNIX_EPOCH,
};

use chrono::NaiveDate;
use rusqlite::OptionalExtension;
use serde_json::{Value, json};

use crate::{Error, Result, db};

pub const USER_CAP: i64 = 2000;
pub const DEFAULT_BOT_CAP: i64 = 2200;

// Separate conversations and RPC handlers construct their own MemoryStore.
// Share the write lock across instances so read-modify-write remains atomic.
static BOT_WRITES: Mutex<()> = Mutex::new(());

pub struct MemoryStore {
    home: PathBuf,
    managed_dir: Option<PathBuf>,
    last_caps: Mutex<HashMap<String, i64>>,
}

impl MemoryStore {
    pub fn new(home: PathBuf) -> Self {
        let managed_dir = std::env::var("HEXBOT_MANAGED_DIR")
            .or_else(|_| std::env::var("HERMES_MANAGED_DIR"))
            .ok()
            .filter(|path| !path.trim().is_empty())
            .map(|path| PathBuf::from(path.trim()))
            .unwrap_or_else(|| {
                PathBuf::from(
                    if Path::new("/etc/hexbot").exists() || !Path::new("/etc/hermes").exists() {
                        "/etc/hexbot"
                    } else {
                        "/etc/hermes"
                    },
                )
            });
        Self {
            home,
            managed_dir: Some(managed_dir),
            last_caps: Mutex::new(HashMap::new()),
        }
    }

    #[cfg(test)]
    fn with_managed_dir(mut self, directory: Option<PathBuf>) -> Self {
        self.managed_dir = directory;
        self
    }

    pub fn get_user(&self, owner: &str) -> Result<Value> {
        self.require_user(owner)?;
        self.read_user(owner)
    }

    pub fn set_user(&self, owner: &str, text: &str) -> Result<Value> {
        self.require_user(owner)?;
        check_cap(text, USER_CAP, "About you")?;
        self.write(&PathBuf::from("users").join(owner).join("user.md"), text)?;
        self.read_user(owner)
    }

    pub fn get_bot(&self, caller: &str, bot: &str) -> Result<Value> {
        self.require_bot(caller, bot)?;
        let cap = self.bot_cap(bot)?;
        let path = self.path(&bot_path(bot).join("memories/MEMORY.md"))?;
        Ok(json!({"memory_md": read_optional(&path)?, "cap": cap}))
    }

    pub fn set_bot(&self, caller: &str, bot: &str, text: &str) -> Result<Value> {
        self.update_bot(caller, bot, |_| Ok(text.to_owned()))
    }

    /// Refuse text that could never fit the bot's memory, so a proposal is
    /// turned down at once instead of failing in the dream that reviews it.
    pub fn check_bot_fits(&self, caller: &str, bot: &str, text: &str) -> Result<()> {
        self.require_bot(caller, bot)?;
        check_cap(text, self.bot_cap(bot)?, "proposed memory")
    }

    /// Apply an edit to the latest memory while excluding other bot writers.
    pub fn update_bot(
        &self,
        caller: &str,
        bot: &str,
        edit: impl FnOnce(&str) -> Result<String>,
    ) -> Result<Value> {
        let _guard = BOT_WRITES
            .lock()
            .map_err(|_| Error::new(5200, "memory write lock poisoned"))?;
        self.require_bot(caller, bot)?;
        let cap = self.bot_cap(bot)?;
        let relative = bot_path(bot).join("memories/MEMORY.md");
        let current = read_optional(&self.path(&relative)?)?;
        let text = edit(&current)?;
        check_cap(&text, cap, "memory")?;
        self.write(&relative, &text)?;
        Ok(json!({"memory_md": text, "cap": cap}))
    }

    fn require_user(&self, owner: &str) -> Result<()> {
        check_identifier(owner)?;
        let exists: bool = db::open(&self.home)?.query_row(
            "SELECT EXISTS(SELECT 1 FROM users WHERE id=?1 AND disabled_at IS NULL)",
            [owner],
            |row| row.get(0),
        )?;
        if !exists {
            return Err(Error::new(4302, "not the owner"));
        }
        Ok(())
    }

    fn require_bot(&self, caller: &str, bot: &str) -> Result<()> {
        self.require_user(caller)?;
        check_identifier(bot)?;
        let owner: Option<String> = db::open(&self.home)?
            .query_row("SELECT owner_id FROM bots WHERE name=?1", [bot], |row| {
                row.get(0)
            })
            .optional()?;
        match owner {
            None => Err(Error::new(4205, format!("bot not found: {bot}"))),
            Some(owner) if owner != caller => Err(Error::new(4302, "not the owner")),
            Some(_) => Ok(()),
        }
    }

    fn read_user(&self, owner: &str) -> Result<Value> {
        let path = self.path(&PathBuf::from("users").join(owner).join("user.md"))?;
        let text = read_optional(&path)?;
        let updated_at = match fs::metadata(&path) {
            Ok(meta) => Some(
                meta.modified()?
                    .duration_since(UNIX_EPOCH)
                    .map_err(|error| Error::new(5200, error.to_string()))?
                    .as_secs_f64(),
            ),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.into()),
        };
        Ok(json!({"text": text, "cap": USER_CAP, "updated_at": updated_at}))
    }

    fn bot_cap(&self, bot: &str) -> Result<i64> {
        let path = self.path(&bot_path(bot).join("config.yaml"))?;
        // Preserve the last valid cap while an existing config is malformed,
        // matching the Hermes loader. A missing file restores defaults.
        let mut caps = self
            .last_caps
            .lock()
            .map_err(|_| Error::new(5200, "memory configuration lock poisoned"))?;
        let config = match fs::read_to_string(path) {
            Ok(text) => match serde_yaml::from_str::<serde_yaml::Value>(&text) {
                Ok(value) if value.is_mapping() || value.is_null() => Some(value),
                _ => {
                    if let Some(cap) = caps.get(bot) {
                        return Ok(*cap);
                    }
                    None
                }
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(_) => {
                if let Some(cap) = caps.get(bot) {
                    return Ok(*cap);
                }
                None
            }
        };
        let mut value = config
            .as_ref()
            .and_then(|c| c.get("memory"))
            .and_then(|m| m.get("memory_char_limit"));
        let managed = self
            .managed_dir
            .as_ref()
            .and_then(|dir| fs::read_to_string(dir.join("config.yaml")).ok())
            .and_then(|text| serde_yaml::from_str::<serde_yaml::Value>(&text).ok());
        // Managed values win at the leaf; a scalar memory section replaces it.
        if let Some(memory) = managed.as_ref().and_then(|config| config.get("memory"))
            && !memory.is_null()
            && (!memory.is_mapping() || memory.get("memory_char_limit").is_some())
        {
            value = memory.get("memory_char_limit");
        }
        let cap = value.and_then(config_integer).unwrap_or(DEFAULT_BOT_CAP);
        caps.insert(bot.to_owned(), cap);
        Ok(cap)
    }

    /// Reject existing symlinks beneath the configured home, including dangling links.
    /// The home must be private to the daemon; this is not an OS sandbox against
    /// another process concurrently replacing its directory tree.
    fn path(&self, relative: &Path) -> Result<PathBuf> {
        let mut path = self.home.canonicalize()?;
        for component in relative.components() {
            let Component::Normal(name) = component else {
                return Err(Error::new(4202, "invalid memory path"));
            };
            path.push(name);
            match fs::symlink_metadata(&path) {
                Ok(meta) if meta.file_type().is_symlink() => {
                    return Err(Error::new(4202, "symlinks are not allowed in memory paths"));
                }
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
        Ok(path)
    }

    fn write(&self, relative: &Path, text: &str) -> Result<()> {
        let path = self.path(relative)?;
        let parent = path
            .parent()
            .ok_or_else(|| Error::new(4202, "invalid memory path"))?;
        fs::create_dir_all(parent)?;
        self.path(relative)?;
        let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
        temporary.write_all(text.as_bytes())?;
        temporary.as_file().sync_all()?;
        self.path(relative)?;
        temporary
            .persist(&path)
            .map_err(|error| Error::from(error.error))?;
        fs::File::open(parent)?.sync_all()?;
        Ok(())
    }
}

/// The day a test pinned with `fix_today`, if any.
static TODAY: OnceLock<NaiveDate> = OnceLock::new();

/// The daemon's local day, which every stamp and date here is taken from.
/// A test pins it with `fix_today`, so writing a stamp and reading it back
/// cannot straddle midnight.
fn local_today() -> NaiveDate {
    TODAY
        .get()
        .copied()
        .unwrap_or_else(|| chrono::Local::now().date_naive())
}

/// Pin the daemon's day for the rest of the process. For tests only: the day
/// cannot change once set, so every test in one binary pins the same one.
#[doc(hidden)]
pub fn fix_today(date: NaiveDate) {
    let pinned = *TODAY.get_or_init(|| date);
    assert_eq!(pinned, date, "tests in one process pin one day");
}

/// The month entries are stamped with, `YYYY-MM` in the daemon's local time.
pub fn month_stamp() -> String {
    local_today().format("%Y-%m").to_string()
}

/// Entries a bot adds carry the month they were learned, so a dream can tell
/// a stale fact from a current one. Every non-empty line of `text` is one
/// entry and gets ` [YYYY-MM]` unless it already ends with a stamp; headings
/// and blank lines are left alone. Whole-file writes (`set`) are never
/// stamped, so the dream and the user keep control of the text.
pub fn stamp_entries(text: &str, month: &str) -> String {
    text.lines()
        .map(|line| {
            let entry = line.trim_end();
            if entry.is_empty() || entry.starts_with('#') || is_stamped(entry) {
                line.to_owned()
            } else {
                format!("{entry} [{month}]")
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// A replacement confirms the entries it touches: every line that crosses
/// `span`, the byte range of the new text inside `text`, ends with this
/// month's stamp in place of any older one, including a stamp the new text
/// brought along. An empty replacement is a removal and stamps nothing.
pub fn restamp_span(text: &str, span: Range<usize>, month: &str) -> String {
    if span.is_empty() {
        return text.to_owned();
    }
    let start = text[..span.start].rfind('\n').map_or(0, |i| i + 1);
    let last = span.end - usize::from(text[..span.end].ends_with('\n'));
    let end = text[last..].find('\n').map_or(text.len(), |i| last + i);
    let touched = text[start..end]
        .lines()
        .map(|line| {
            let entry = strip_stamps(line.trim_end());
            if entry.is_empty() || entry.starts_with('#') {
                line.to_owned()
            } else {
                format!("{entry} [{month}]")
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    format!("{}{touched}{}", &text[..start], &text[end..])
}

fn is_stamped(entry: &str) -> bool {
    let b = entry.trim_end().as_bytes();
    let n = b.len();
    n >= 9
        && b[n - 9] == b'['
        && b[n - 8..n - 4].iter().all(u8::is_ascii_digit)
        && b[n - 4] == b'-'
        && b[n - 3..n - 1].iter().all(u8::is_ascii_digit)
        && b[n - 1] == b']'
}

fn strip_stamps(mut entry: &str) -> &str {
    while is_stamped(entry) {
        entry = entry[..entry.len() - 9].trim_end();
    }
    entry
}

// Python's int() accepts boolean and floating-point YAML scalars as well.
fn config_integer(value: &serde_yaml::Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_bool().map(i64::from))
        .or_else(|| {
            value.as_str().and_then(|text| {
                expand_env(text, |name| std::env::var(name).ok())
                    .trim()
                    .parse()
                    .ok()
            })
        })
        .or_else(|| {
            value
                .as_f64()
                .filter(|n| n.is_finite() && *n >= i64::MIN as f64 && *n < i64::MAX as f64)
                .map(|n| n as i64)
        })
}

fn expand_env(text: &str, lookup: impl Fn(&str) -> Option<String>) -> String {
    let mut result = String::new();
    let mut remaining = text;
    while let Some(start) = remaining.find("${") {
        let Some(end) = remaining[start + 2..].find('}').map(|i| start + 2 + i) else {
            break;
        };
        result.push_str(&remaining[..start]);
        let reference = &remaining[start..=end];
        let raw = remaining[start + 2..end].trim();
        let name = raw.strip_prefix("env:").map(str::trim).unwrap_or(raw);
        let external = raw.split_once(':').is_some_and(|(prefix, _)| {
            prefix
                .as_bytes()
                .first()
                .is_some_and(u8::is_ascii_lowercase)
                && prefix
                    .bytes()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_' || c == b'-')
                && !raw.starts_with("env:")
        });
        let value = if name.is_empty() || external {
            None
        } else {
            lookup(name)
        };
        result.push_str(value.as_deref().unwrap_or(reference));
        remaining = &remaining[end + 1..];
    }
    result.push_str(remaining);
    result
}

fn bot_path(bot: &str) -> PathBuf {
    PathBuf::from("profiles").join(bot)
}

fn check_identifier(value: &str) -> Result<()> {
    if value.is_empty()
        || value == "."
        || value == ".."
        || value
            .chars()
            .any(|c| c == '/' || c == '\\' || c.is_control())
    {
        return Err(Error::new(4202, "invalid memory owner or bot identifier"));
    }
    Ok(())
}

fn check_cap(text: &str, cap: i64, label: &str) -> Result<()> {
    let length = text.chars().count();
    if cap < 0 || length as u64 > cap as u64 {
        return Err(Error::new(
            4221,
            format!("{label} is {length} characters; the cap is {cap}"),
        ));
    }
    Ok(())
}

fn read_optional(path: &Path) -> Result<String> {
    if !path.try_exists()? {
        return Ok(String::new());
    }
    crate::common::read_regular_text(path, 4 * 1024 * 1024)
}

#[cfg(test)]
mod tests {
    use super::expand_env;

    #[test]
    fn expands_only_supported_environment_references_without_recursive_expansion() {
        let lookup = |name: &str| match name {
            "CAP" => Some("3000".into()),
            "INDIRECT" => Some("${CAP}".into()),
            _ => None,
        };
        assert_eq!(expand_env("${CAP}/${env: CAP }", lookup), "3000/3000");
        assert_eq!(
            expand_env("${env:}/${missing}/${vault:CAP}/${}", lookup),
            "${env:}/${missing}/${vault:CAP}/${}"
        );
        assert_eq!(expand_env("${INDIRECT}", lookup), "${CAP}");
        assert_eq!(expand_env("${CAP", lookup), "${CAP");
    }
}

#[cfg(test)]
#[path = "memory_tests.rs"]
mod file_tests;
