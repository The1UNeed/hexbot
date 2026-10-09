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
/// A bot's daily notes are one file per local day beside its memory,
/// `memories/notes/YYYY-MM-DD.md`. The bot appends to today's file during
/// conversations; nothing injects them into a prompt. The dream reads them
/// and keeps what lasts in memory, and after NOTE_RETENTION_DAYS they go.
pub const NOTE_DAY_CAP: i64 = 4000;
pub const NOTE_RETENTION_DAYS: i64 = 30;
/// Days one memory read may cover, so a read never floods the context.
pub const NOTE_READ_DAYS: i64 = 7;

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

    /// Append a note to today's file while excluding other bot writers.
    /// `check` sees the day's current text and the result, like a memory
    /// edit. The day is capped so a note never grows past what a dream
    /// can read; the error says so in words the bot can act on. The result
    /// is a confirmation with the day's length, not the day's text: a note
    /// costs the conversation nothing it did not already say.
    pub fn add_note(
        &self,
        caller: &str,
        bot: &str,
        text: &str,
        check: impl FnOnce(&str, &str) -> Result<()>,
    ) -> Result<Value> {
        let note = text.trim();
        if note.is_empty() {
            return Err(Error::new(4202, "a note needs some text"));
        }
        let _guard = BOT_WRITES
            .lock()
            .map_err(|_| Error::new(5200, "memory write lock poisoned"))?;
        self.require_bot(caller, bot)?;
        let today = local_today();
        let relative = note_path(bot, today);
        let current = read_optional(&self.path(&relative)?)?;
        let updated = if current.trim().is_empty() {
            note.to_owned()
        } else {
            format!("{}\n{note}", current.trim_end())
        };
        check(&current, &updated)?;
        let length = updated.chars().count();
        if length as i64 > NOTE_DAY_CAP {
            return Err(Error::new(
                4221,
                format!(
                    "Today's notes are {length} characters with this one; the cap is {NOTE_DAY_CAP}. Keep notes short, or fold what matters into memory."
                ),
            ));
        }
        self.write(&relative, &updated)?;
        self.housekeep(bot);
        Ok(json!({"date": today.to_string(), "noted": true, "length": length, "cap": NOTE_DAY_CAP}))
    }

    /// Retention runs whenever notes are touched, not only when a dream
    /// runs, so a bot with dreaming off sheds its old days too. It is
    /// housekeeping: a failure never fails the call that triggered it.
    fn housekeep(&self, bot: &str) {
        let _ = prune_notes(&self.home, bot, local_today());
    }

    /// Notes for the days `from..=to`, oldest first; days without notes are left out.
    pub fn get_notes(
        &self,
        caller: &str,
        bot: &str,
        from: NaiveDate,
        to: NaiveDate,
    ) -> Result<Value> {
        self.require_bot(caller, bot)?;
        self.housekeep(bot);
        let mut notes = vec![];
        for date in from.iter_days().take_while(|date| *date <= to) {
            let text = read_optional(&self.path(&note_path(bot, date))?)?;
            if !text.trim().is_empty() {
                notes.push(json!({"date": date.to_string(), "text": text}));
            }
        }
        Ok(
            json!({"notes": notes, "from": from.to_string(), "to": to.to_string(), "cap": NOTE_DAY_CAP}),
        )
    }

    /// Every day that has notes, newest first, for the Memory tab, with the
    /// daemon's `today` so a client in another timezone names the days as
    /// the daemon files them.
    pub fn list_notes(&self, caller: &str, bot: &str) -> Result<Value> {
        self.require_bot(caller, bot)?;
        self.housekeep(bot);
        let mut days = vec![];
        for date in note_days(&self.home, bot)?.into_iter().rev() {
            let text = read_optional(&self.path(&note_path(bot, date))?)?;
            if !text.trim().is_empty() {
                days.push(json!({"date": date.to_string(), "text": text}));
            }
        }
        Ok(
            json!({"days": days, "today": local_today().to_string(), "cap": NOTE_DAY_CAP, "retention_days": NOTE_RETENTION_DAYS}),
        )
    }

    /// The user's edit of one day, written as given; an empty text removes
    /// the day. With `expected`, the text the editor loaded, the edit is
    /// refused when the day has changed since, so a note the bot added in
    /// the meantime is not written over. Notes can only be filed for days
    /// up to today.
    pub fn set_notes(
        &self,
        caller: &str,
        bot: &str,
        date: NaiveDate,
        text: &str,
        expected: Option<&str>,
    ) -> Result<Value> {
        let _guard = BOT_WRITES
            .lock()
            .map_err(|_| Error::new(5200, "memory write lock poisoned"))?;
        self.require_bot(caller, bot)?;
        check_cap(text, NOTE_DAY_CAP, "notes")?;
        if date > local_today() {
            return Err(Error::new(
                4202,
                "Notes are kept for today and earlier days only.",
            ));
        }
        let relative = note_path(bot, date);
        self.check_expected(&relative, expected)?;
        if text.trim().is_empty() {
            remove_optional(&self.path(&relative)?)?;
        } else {
            self.write(&relative, text)?;
        }
        Ok(json!({"date": date.to_string(), "text": text, "cap": NOTE_DAY_CAP}))
    }

    /// Remove one day. With `expected`, the text the client showed, the
    /// deletion is refused when the day has changed since, as an edit is.
    pub fn delete_notes(
        &self,
        caller: &str,
        bot: &str,
        date: NaiveDate,
        expected: Option<&str>,
    ) -> Result<Value> {
        let _guard = BOT_WRITES
            .lock()
            .map_err(|_| Error::new(5200, "memory write lock poisoned"))?;
        self.require_bot(caller, bot)?;
        let relative = note_path(bot, date);
        self.check_expected(&relative, expected)?;
        remove_optional(&self.path(&relative)?)?;
        Ok(json!({"date": date.to_string(), "deleted": true}))
    }

    /// A client that says what it loaded only changes a day that still
    /// reads the same; the bot may have added a note in the meantime.
    fn check_expected(&self, relative: &Path, expected: Option<&str>) -> Result<()> {
        if let Some(expected) = expected
            && read_optional(&self.path(relative)?)? != expected
        {
            return Err(Error::new(
                4209,
                "This day's notes changed since you opened them.",
            ));
        }
        Ok(())
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
        safe_path(&self.home, relative)
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

/// The daemon's local day, which every stamp and note date is taken from.
/// A test pins it with `fix_today`, so writing a stamp or a note and reading
/// it back cannot straddle midnight.
pub fn local_today() -> NaiveDate {
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

/// A note day as the tool and the app name it: `YYYY-MM-DD`, nothing looser,
/// since the day is also the file name.
pub fn parse_note_date(text: &str) -> Result<NaiveDate> {
    NaiveDate::parse_from_str(text.trim(), "%Y-%m-%d")
        .ok()
        .filter(|date| date.to_string() == text.trim())
        .ok_or_else(|| Error::new(4202, "date must be a day written as YYYY-MM-DD"))
}

/// What the memory tool's `notes` argument may say: `today`, `yesterday`, one
/// day as `YYYY-MM-DD`, or a range `YYYY-MM-DD..YYYY-MM-DD` of at most
/// NOTE_READ_DAYS days.
pub fn parse_note_range(spec: &str, today: NaiveDate) -> Result<(NaiveDate, NaiveDate)> {
    let spec = spec.trim();
    let (from, to) = match spec {
        "today" => (today, today),
        "yesterday" => {
            let day = today.pred_opt().unwrap_or(today);
            (day, day)
        }
        _ => match spec.split_once("..") {
            Some((from, to)) => (parse_note_date(from)?, parse_note_date(to)?),
            None => {
                let day = parse_note_date(spec).map_err(|_| {
                    Error::new(
                        4202,
                        "notes must be today, yesterday, a day (YYYY-MM-DD) or a range (YYYY-MM-DD..YYYY-MM-DD)",
                    )
                })?;
                (day, day)
            }
        },
    };
    if to < from {
        return Err(Error::new(4202, "a notes range must start before it ends"));
    }
    if (to - from).num_days() >= NOTE_READ_DAYS {
        return Err(Error::new(
            4202,
            format!("Read at most {NOTE_READ_DAYS} days of notes at a time."),
        ));
    }
    Ok((from, to))
}

/// `relative` under `home` with no symlink on the way, so a link planted in a
/// profile cannot point memory or notes at a file outside it.
fn safe_path(home: &Path, relative: &Path) -> Result<PathBuf> {
    let mut path = home.canonicalize()?;
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
            // An overlong path cannot name a file either. Discovery treats
            // it as absent; an attempted read or write still reports the I/O error.
            Err(error)
                if error.kind() == std::io::ErrorKind::NotFound
                    || error.raw_os_error() == Some(libc::ENAMETOOLONG) => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(path)
}

fn notes_dir(bot: &str) -> PathBuf {
    bot_path(bot).join("memories/notes")
}

fn note_path(bot: &str, date: NaiveDate) -> PathBuf {
    notes_dir(bot).join(format!("{date}.md"))
}

/// Days with a notes file, oldest first. Only regular files named like a day
/// count; anything else in the folder is ignored and never touched, and a
/// folder reached through a link is no notes folder at all.
fn note_days(home: &Path, bot: &str) -> Result<Vec<NaiveDate>> {
    check_identifier(bot)?;
    let mut days = vec![];
    let dir = safe_path(home, &notes_dir(bot))?;
    if !dir.is_dir() {
        return Ok(days);
    }
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        match entry.file_type() {
            Ok(kind) if kind.is_file() => {}
            Ok(_) => continue,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
        }
        let name = entry.file_name();
        if let Some(day) = name
            .to_str()
            .and_then(|name| name.strip_suffix(".md"))
            .and_then(|day| parse_note_date(day).ok())
        {
            days.push(day);
        }
    }
    days.sort_unstable();
    Ok(days)
}

/// Notes from `from` on, oldest first, for the dream digest. Ownership is the
/// caller's concern, as with the memory file the digest reads beside them.
pub fn notes_from(home: &Path, bot: &str, from: NaiveDate) -> Result<Vec<(NaiveDate, String)>> {
    let mut notes = vec![];
    for date in note_days(home, bot)? {
        if date < from {
            continue;
        }
        let text = read_optional(&safe_path(home, &note_path(bot, date))?)?;
        if !text.trim().is_empty() {
            notes.push((date, text));
        }
    }
    Ok(notes)
}

/// Delete note files older than NOTE_RETENTION_DAYS before `today` and return
/// their days. Nothing but those files is removed. Two callers pruning at
/// once (a dream and a section) each find the file gone and carry on.
pub fn prune_notes(home: &Path, bot: &str, today: NaiveDate) -> Result<Vec<NaiveDate>> {
    let mut removed = vec![];
    for date in note_days(home, bot)? {
        if (today - date).num_days() > NOTE_RETENTION_DAYS {
            remove_optional(&safe_path(home, &note_path(bot, date))?)?;
            removed.push(date);
        }
    }
    Ok(removed)
}

/// A note a scheduled job proposes must fit a day on its own, as a memory
/// proposal must fit the memory cap, so the dream is never handed one it
/// could not write.
pub fn check_note_fits(text: &str) -> Result<()> {
    check_cap(text, NOTE_DAY_CAP, "proposed notes")
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

fn remove_optional(path: &Path) -> Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
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
