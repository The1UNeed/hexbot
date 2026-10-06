//! Shared skill discovery, grants, library writes and migration.
use crate::{Error, Result, catalog, common, db};
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    path::{Component, Path, PathBuf},
    sync::RwLock,
};

pub(crate) static LOCK: RwLock<()> = RwLock::new(());

pub(crate) fn relative(value: &str) -> Result<PathBuf> {
    let path = Path::new(value);
    if value.is_empty()
        || path.is_absolute()
        || path
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
        || value.contains('\\')
    {
        return Err(Error::new(
            4202,
            "path must stay inside the skill directory",
        ));
    }
    Ok(path.to_path_buf())
}
/// `root` is trusted and may itself be a symlink (a linked `HEXBOT_HOME`).
pub(crate) fn safe_path(root: &Path, path: &Path) -> Result<()> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| Error::new(4202, "path is outside the bot directory"))?;
    let mut cursor = root.to_path_buf();
    for part in relative.components() {
        if !matches!(part, Component::Normal(_)) {
            return Err(Error::new(4202, "invalid skill path"));
        }
        cursor.push(part);
        if fs::symlink_metadata(&cursor).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err(Error::new(4202, "skill paths must not contain symlinks"));
        }
    }
    Ok(())
}
pub(crate) fn frontmatter(content: &str) -> (Value, String) {
    let normalized = content.replace("\r\n", "\n");
    let source = normalized.trim_start_matches('\u{feff}');
    if let Some(rest) = source.strip_prefix("---\n")
        && let Some((yaml, body)) = rest.split_once("\n---")
    {
        return (
            serde_yaml::from_str(yaml).unwrap_or_else(|_| json!({})),
            body.trim_start().to_owned(),
        );
    }
    (json!({}), source.to_owned())
}
pub(crate) fn walk_files(root: &Path, path: &Path, out: &mut Vec<PathBuf>) -> Result<()> {
    // Here `root` is a skill directory, never the home, so it must be real.
    if fs::symlink_metadata(root).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err(Error::new(4202, "skill paths must not contain symlinks"));
    }
    safe_path(root, path)?;
    if !path.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        if kind.is_symlink() {
            return Err(Error::new(4202, "skill paths must not contain symlinks"));
        }
        if kind.is_dir() {
            walk_files(root, &entry.path(), out)?
        } else if kind.is_file() {
            out.push(entry.path());
            if out.len() > 2000 {
                return Err(Error::new(4202, "skill contains too many files"));
            }
        }
    }
    Ok(())
}
pub(crate) fn copy_tree(source: &Path, dest: &Path) -> Result<()> {
    let mut files = vec![];
    walk_files(source, source, &mut files)?;
    fs::create_dir_all(dest)?;
    for path in files {
        if fs::metadata(&path)?.len() > 8 * 1024 * 1024 {
            return Err(Error::new(4202, "skill file exceeds 8 MiB"));
        }
        let target = dest.join(path.strip_prefix(source).unwrap());
        fs::create_dir_all(target.parent().unwrap())?;
        fs::copy(path, target)?;
    }
    Ok(())
}
pub(crate) fn valid_skill_name(name: &str) -> Result<()> {
    if name.is_empty()
        || name.len() > 64
        || !name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
    {
        return Err(Error::new(
            4202,
            "skill name must use lowercase letters, digits, hyphens or underscores, up to 64 characters",
        ));
    }
    Ok(())
}
pub(crate) fn valid_skill_content(content: &str) -> Result<()> {
    if content.len() > 2 * 1024 * 1024 {
        return Err(Error::new(4202, "skill content exceeds 2 MiB"));
    }
    let (meta, body) = frontmatter(content);
    if meta["description"].as_str().unwrap_or("").trim().is_empty() || body.trim().is_empty() {
        return Err(Error::new(
            4200,
            "SKILL.md needs YAML frontmatter with a description and a Markdown body",
        ));
    }
    Ok(())
}
#[derive(Clone, Debug, Serialize)]
pub struct Skill {
    pub name: String,
    pub description: String,
    pub category: Option<String>,
    pub source: String,
    pub path: PathBuf,
    pub enabled_for_bot: bool,
    pub disabled_globally: bool,
    /// Compatibility with the existing web client.
    pub enabled: bool,
}

fn bundled_root() -> PathBuf {
    let path = std::env::var_os("HEXBOT_BUNDLED_SKILLS")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../skills"));
    path.canonicalize().unwrap_or(path)
}

fn discover(
    root: &Path,
    path: &Path,
    source: &str,
    out: &mut BTreeMap<String, Skill>,
) -> Result<()> {
    safe_path(root, path)?;
    if !path.exists() {
        return Ok(());
    }
    let main = path.join("SKILL.md");
    safe_path(root, &main)?;
    if main.is_file() && path != root {
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        let content = common::read_regular_text(&main, 2 * 1024 * 1024)?;
        let (meta, body) = frontmatter(&content);
        let description = meta["description"]
            .as_str()
            .or_else(|| {
                body.lines()
                    .find(|s| !s.trim().is_empty() && !s.trim_start().starts_with('#'))
            })
            .unwrap_or("")
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        let category = path
            .parent()
            .unwrap()
            .strip_prefix(root)
            .unwrap()
            .to_string_lossy();
        out.insert(
            name.clone(),
            Skill {
                name,
                description: description.chars().take(1000).collect(),
                category: (!category.is_empty()).then(|| category.into_owned()),
                source: source.into(),
                path: main,
                enabled_for_bot: true,
                disabled_globally: false,
                enabled: true,
            },
        );
        return Ok(());
    }
    let mut entries = fs::read_dir(path)?.collect::<std::io::Result<Vec<_>>>()?;
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        if entry.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        // Never follow a symlink into another bot or outside the library.
        if entry.file_type()?.is_dir() {
            discover(root, &entry.path(), source, out)?;
        }
    }
    Ok(())
}

fn is_disabled(config: &Value, name: &str) -> bool {
    config["skills"]["disabled"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|v| v.as_str().is_some_and(|v| v.eq_ignore_ascii_case(name)))
}

pub(crate) fn read_lock() -> Result<std::sync::RwLockReadGuard<'static, ()>> {
    LOCK.read()
        .map_err(|_| Error::new(5200, "skills lock unavailable"))
}

pub fn resolve(home: &Path, bot: Option<&str>) -> Result<Vec<Skill>> {
    let _guard = read_lock()?;
    resolve_unlocked(home, bot)
}

// Caller holds either side of LOCK through discovery and any body reads.
pub(crate) fn resolve_unlocked(home: &Path, bot: Option<&str>) -> Result<Vec<Skill>> {
    resolve_with(home, bot, &bundled_root())
}
fn resolve_with(home: &Path, bot: Option<&str>, bundled: &Path) -> Result<Vec<Skill>> {
    let mut found = BTreeMap::new();
    discover(bundled, bundled, "bundled", &mut found)?;
    let library = home.join("skills");
    safe_path(home, &library)?;
    discover(&library, &library, "library", &mut found)?;
    let config = if let Some(bot) = bot {
        let profile = catalog::profile(home, bot)?;
        let root = profile.join("skills");
        safe_path(home, &root)?;
        discover(&root, &root, "bot", &mut found)?;
        safe_path(home, &profile.join("config.yaml"))?;
        common::read_config(&profile)?
    } else {
        json!({})
    };
    safe_path(home, &home.join("config.yaml"))?;
    let global = common::read_config(home)?;
    for skill in found.values_mut() {
        skill.disabled_globally = is_disabled(&global, &skill.name);
        skill.enabled_for_bot = !is_disabled(&config, &skill.name);
        skill.enabled = skill.enabled_for_bot && !skill.disabled_globally;
    }
    Ok(found.into_values().collect())
}

pub fn find(home: &Path, bot: Option<&str>, name: &str) -> Result<Skill> {
    let _guard = read_lock()?;
    find_unlocked(home, bot, name)
}
pub(crate) fn find_unlocked(home: &Path, bot: Option<&str>, name: &str) -> Result<Skill> {
    valid_skill_name(name)?;
    resolve_unlocked(home, bot)?
        .into_iter()
        .find(|s| s.name == name)
        .ok_or_else(|| Error::new(4205, format!("skill not found: {name}")))
}
pub fn find_enabled(home: &Path, bot: &str, name: &str) -> Result<Skill> {
    let _guard = read_lock()?;
    find_enabled_unlocked(home, bot, name)
}
pub(crate) fn find_enabled_unlocked(home: &Path, bot: &str, name: &str) -> Result<Skill> {
    let skill = find_unlocked(home, Some(bot), name)?;
    if !skill.enabled {
        return Err(Error::new(4302, format!("skill is disabled: {name}")));
    }
    Ok(skill)
}

pub fn read_body(home: &Path, bot: &str, name: &str) -> Result<String> {
    let _guard = read_lock()?;
    let skill = find_enabled_unlocked(home, bot, name)?;
    common::read_regular_text(&skill.path, 2 * 1024 * 1024)
}

pub fn set_enabled(home: &Path, bot: Option<&str>, name: &str, enabled: bool) -> Result<()> {
    let root = bot
        .map(|bot| catalog::profile(home, bot))
        .transpose()?
        .unwrap_or_else(|| home.to_path_buf());
    safe_path(home, &root.join("config.yaml"))?;
    let writer = common::config_writer()?;
    let mut config = common::read_config(&root)?;
    let mut disabled = config["skills"]["disabled"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    disabled.retain(|v| !v.as_str().is_some_and(|v| v.eq_ignore_ascii_case(name)));
    if !enabled {
        disabled.push(json!(name));
    }
    if !config["skills"].is_object() {
        config["skills"] = json!({});
    }
    config["skills"]["disabled"] = json!(disabled);
    writer.write(&root, &config)
}

/// All human writes to the shared library pass this boundary.
fn library_writer(home: &Path, caller: &str) -> Result<()> {
    common::admin(home, caller)
}

fn skill_content(skill: &Skill) -> Result<Value> {
    let dir = skill.path.parent().unwrap();
    let mut files = vec![];
    walk_files(dir, dir, &mut files)?;
    let mut files = files
        .into_iter()
        .map(|p| p.strip_prefix(dir).unwrap().to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    files.sort();
    Ok(
        json!({"name":skill.name,"source":skill.source,"category":skill.category,
        "content":common::read_regular_text(&skill.path, 2 * 1024 * 1024)?,"files":files}),
    )
}

pub(crate) fn destination(root: &Path, name: &str, category: Option<&str>) -> Result<PathBuf> {
    let dir = if let Some(category) = category.filter(|v| !v.is_empty()) {
        let category = relative(category)?;
        if category
            .components()
            .any(|part| part.as_os_str().to_string_lossy().starts_with('.'))
        {
            return Err(Error::new(4202, "skill categories must not be hidden"));
        }
        root.join(category).join(name)
    } else {
        root.join(name)
    };
    validate_destination(root, &dir)?;
    Ok(dir)
}

pub(crate) fn validate_destination(root: &Path, dir: &Path) -> Result<()> {
    safe_path(root, dir)?;
    // A skill cannot contain another skill, or replace a category containing skills.
    let mut parent = dir.parent();
    while let Some(path) = parent {
        if path == root {
            break;
        }
        if path.join("SKILL.md").exists() {
            return Err(Error::new(4202, "category is inside another skill"));
        }
        parent = path.parent();
    }
    if dir.exists() && !dir.join("SKILL.md").is_file() {
        return Err(Error::new(4202, "skill path is an existing category"));
    }
    if dir.exists() {
        let mut files = vec![];
        walk_files(root, dir, &mut files)?;
        if files.iter().any(|path| {
            path.file_name().is_some_and(|n| n == "SKILL.md") && path.parent() != Some(dir)
        }) {
            return Err(Error::new(4202, "skills must not contain other skills"));
        }
    }
    Ok(())
}

fn save(home: &Path, bot: Option<&str>, p: &Value) -> Result<Skill> {
    let name = common::required(p, "name")?;
    valid_skill_name(name)?;
    let content = common::required(p, "content")?;
    valid_skill_content(content)?;
    let existing = resolve_unlocked(home, bot)?
        .into_iter()
        .find(|s| s.name == name);
    let root = bot
        .map(|b| catalog::profile(home, b))
        .transpose()?
        .unwrap_or_else(|| home.to_path_buf())
        .join("skills");
    safe_path(home, &root)?;
    let category = match p.get("category") {
        Some(v) => Some(
            v.as_str()
                .ok_or_else(|| Error::new(4202, "category must be a string"))?,
        ),
        None => existing.as_ref().and_then(|s| s.category.as_deref()),
    };
    let dest = destination(&root, name, category)?;
    fs::create_dir_all(&root)?;
    let stage = tempfile::tempdir_in(&root)?;
    let work = stage.path().join("work");
    if let Some(skill) = &existing {
        copy_tree(skill.path.parent().unwrap(), &work)?;
    } else {
        fs::create_dir(&work)?;
    }
    fs::write(work.join("SKILL.md"), content)?;
    validate_destination(stage.path(), &work)?;
    let old = existing
        .as_ref()
        .filter(|s| s.path.starts_with(&root))
        .map(|s| s.path.parent().unwrap());
    let backup = stage.path().join("backup");
    fs::create_dir_all(dest.parent().unwrap())?;
    if let Some(old) = old {
        fs::rename(old, &backup)?;
    }
    if let Err(error) = fs::rename(&work, &dest) {
        if let Some(old) = old {
            fs::rename(&backup, old)?;
        }
        return Err(error.into());
    }
    find_unlocked(home, bot, name)
}

fn share(home: &Path, bot: &str, name: &str, replace: bool) -> Result<Skill> {
    let skill = find_unlocked(home, Some(bot), name)?;
    if skill.source != "bot" {
        return Err(Error::new(4202, "only a private skill can be shared"));
    }
    let library = resolve_unlocked(home, None)?
        .into_iter()
        .find(|s| s.name == name);
    if library.is_some() && !replace {
        return Err(Error::new(
            4208,
            "skill already exists in the library; use replace to overwrite it",
        ));
    }
    let root = home.join("skills");
    let dest = match library.as_ref().filter(|s| s.source == "library") {
        Some(skill) => skill.path.parent().unwrap().to_path_buf(),
        None => destination(&root, name, skill.category.as_deref())?,
    };
    safe_path(home, &dest)?;
    let source = skill.path.parent().unwrap();
    let mut files = vec![];
    walk_files(source, source, &mut files)?;
    fs::create_dir_all(&root)?;
    let stage = tempfile::tempdir_in(&root)?;
    let backup = stage.path().join("backup");
    fs::create_dir_all(dest.parent().unwrap())?;
    let had_dest = dest.exists();
    if had_dest {
        fs::rename(&dest, &backup)?;
    }
    if let Err(error) = fs::rename(source, &dest) {
        if had_dest {
            fs::rename(&backup, &dest)?;
        }
        return Err(error.into());
    }
    find_unlocked(home, None, name)
}

pub fn call(home: &Path, caller: &str, method: &str, p: &Value) -> Result<Value> {
    common::user(home, caller)?;
    let bot = match p.get("bot") {
        Some(value) => Some(
            value
                .as_str()
                .filter(|s| !s.is_empty())
                .ok_or_else(|| Error::new(4202, "bot must be a name"))?,
        ),
        None => None,
    };
    if method == "hexbot.skills.share" {
        library_writer(home, caller)?;
        common::bot_owner(home, caller, common::required(p, "bot")?)?;
    } else if let Some(bot) = bot {
        common::bot_owner(home, caller, bot)?;
    }
    if matches!(method, "skills.list" | "hexbot.skills.list") {
        return Ok(json!({"skills":resolve(home, bot)?}));
    }
    let name = common::required(p, "name")?;
    valid_skill_name(name)?;
    if method == "hexbot.skills.get" {
        let _guard = read_lock()?;
        return skill_content(&find_unlocked(home, bot, name)?);
    }
    let _guard = LOCK
        .write()
        .map_err(|_| Error::new(5200, "skills lock unavailable"))?;
    match method {
        "hexbot.skills.save" => {
            if bot.is_none() {
                library_writer(home, caller)?;
            }
            let bots_disabled = match p.get("bots_disabled") {
                Some(v) => {
                    if bot.is_some() {
                        return Err(Error::new(
                            4202,
                            "bots_disabled is only valid for library saves",
                        ));
                    }
                    let values = v.as_array().ok_or_else(|| {
                        Error::new(4202, "bots_disabled must be a list of bot names")
                    })?;
                    let mut bots = vec![];
                    for value in values {
                        let b = value.as_str().ok_or_else(|| {
                            Error::new(4202, "bots_disabled must contain bot names")
                        })?;
                        common::bot_owner(home, caller, b)?;
                        let root = catalog::profile(home, b)?;
                        safe_path(home, &root.join("config.yaml"))?;
                        common::read_config(&root)?;
                        bots.push(b);
                    }
                    bots
                }
                None => vec![],
            };
            let skill = save(home, bot, p)?;
            for bot in bots_disabled {
                set_enabled(home, Some(bot), name, false)?;
            }
            Ok(json!({"skill":skill}))
        }
        "hexbot.skills.delete" => {
            if bot.is_none() {
                library_writer(home, caller)?;
            }
            let skill = find_unlocked(home, bot, name)?;
            if bot.is_some() && skill.source != "bot" {
                return Err(Error::new(
                    4202,
                    "only a private skill can be deleted for a bot; use set_for_bot to turn off a library skill",
                ));
            }
            if skill.source == "bundled" {
                return Err(Error::new(
                    4202,
                    "Bundled skills can be turned off, not deleted.",
                ));
            }
            let dir = skill.path.parent().unwrap();
            safe_path(home, dir)?;
            fs::remove_dir_all(dir)?;
            Ok(json!({"deleted":true}))
        }
        "hexbot.skills.share" => {
            let bot = common::required(p, "bot")?;
            let replace = match p.get("replace") {
                Some(v) => v
                    .as_bool()
                    .ok_or_else(|| Error::new(4202, "replace must be a boolean"))?,
                None => false,
            };
            Ok(json!({"skill":share(home, bot, name, replace)?}))
        }
        "hexbot.skills.set_global" | "hexbot.skills.set_for_bot" => {
            let target = if method == "hexbot.skills.set_global" {
                library_writer(home, caller)?;
                if bot.is_some() {
                    return Err(Error::new(4202, "set_global does not accept bot"));
                }
                None
            } else {
                Some(common::required(p, "bot")?)
            };
            let enabled = p["enabled"]
                .as_bool()
                .ok_or_else(|| Error::new(4202, "enabled must be a boolean"))?;
            find_unlocked(home, target, name)?;
            set_enabled(home, target, name, enabled)?;
            Ok(json!({"skill":find_unlocked(home, target, name)?}))
        }
        _ => Err(Error::new(-32601, "method not found")),
    }
}

// Same framing as scripts/desktop/skill-history.mjs. Non-dot symlinks and
// special files are never deduplicated; empty directories do not affect hashes.
fn fingerprint(dir: &Path) -> Result<Option<String>> {
    fn collect(dir: &Path, files: &mut Vec<PathBuf>) -> Result<bool> {
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            if entry.file_name().to_string_lossy().starts_with('.') {
                continue;
            }
            let kind = entry.file_type()?;
            if kind.is_dir() {
                if !collect(&entry.path(), files)? {
                    return Ok(false);
                }
            } else if kind.is_file() {
                files.push(entry.path());
            } else {
                return Ok(false);
            }
        }
        Ok(true)
    }
    let mut files = vec![];
    if !collect(dir, &mut files)? {
        return Ok(None);
    }
    let mut paths = vec![];
    for file in files {
        let Some(parts) = file
            .strip_prefix(dir)
            .unwrap()
            .components()
            .map(|part| part.as_os_str().to_str())
            .collect::<Option<Vec<_>>>()
        else {
            return Ok(None);
        };
        paths.push((parts.join("/"), file));
    }
    // PathBuf orders components, which differs from path bytes for a.txt vs a/b.
    paths.sort_by(|a, b| a.0.cmp(&b.0));
    let mut hash = Sha256::new();
    for (path, file) in paths {
        #[cfg(unix)]
        let executable = {
            use std::os::unix::fs::PermissionsExt;
            fs::metadata(&file)?.permissions().mode() & 0o111 != 0
        };
        #[cfg(not(unix))]
        let executable = false;
        let bytes = fs::read(&file)?;
        hash.update(format!(
            "{path}\0{}\0{}\0",
            u8::from(executable),
            bytes.len()
        ));
        hash.update(bytes);
    }
    Ok(Some(format!("{:x}", hash.finalize())))
}

// Seeding never copied dotfiles, so one inside a copy was written by the user
// or a bot, and the copy is kept.
fn has_hidden(dir: &Path) -> Result<bool> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        if entry.file_name().to_string_lossy().starts_with('.')
            || (entry.file_type()?.is_dir() && has_hidden(&entry.path())?)
        {
            return Ok(true);
        }
    }
    Ok(false)
}

fn deduplicate(
    dir: &Path,
    bundled_dir: &Path,
    history: &BTreeMap<String, Vec<String>>,
) -> Result<()> {
    let metadata = match fs::symlink_metadata(dir) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Ok(());
    }
    if dir.join("SKILL.md").exists() {
        if let Some(hashes) = dir
            .file_name()
            .and_then(|n| n.to_str())
            .and_then(|n| history.get(n))
            && let Some(hash) = fingerprint(dir)?
            && hashes.contains(&hash)
            && !has_hidden(dir)?
        {
            fs::remove_dir_all(dir)?;
        }
        return Ok(());
    }
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        if !entry.file_name().to_string_lossy().starts_with('.') {
            deduplicate(&entry.path(), &bundled_dir.join(entry.file_name()), history)?;
        }
    }
    let entries = fs::read_dir(dir)?.collect::<std::io::Result<Vec<_>>>()?;
    if entries.len() == 1
        && entries[0].file_name() == "DESCRIPTION.md"
        && entries[0].file_type()?.is_file()
    {
        let bundled = bundled_dir.join("DESCRIPTION.md");
        if fs::symlink_metadata(&bundled).is_ok_and(|m| m.file_type().is_file())
            && fs::read(entries[0].path())? == fs::read(bundled)?
        {
            fs::remove_file(entries[0].path())?;
        }
    }
    if fs::read_dir(dir)?.next().is_none() {
        fs::remove_dir(dir)?;
    }
    Ok(())
}

/// Called under the database migration lock. Mark only a completed pass; a
/// crash can safely rerun it because only known bundled copies are removed.
pub(crate) fn migrate(home: &Path) -> Result<()> {
    migrate_with(home, &bundled_root())
}
fn migrate_with(home: &Path, bundled: &Path) -> Result<()> {
    let _guard = LOCK
        .write()
        .map_err(|_| Error::new(5200, "skills lock unavailable"))?;
    let conn = db::open(home)?;
    let key = "migration:shared-skills-v1";
    let done: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM settings WHERE key=?)",
        [key],
        |r| r.get(0),
    )?;
    if done || !bundled.is_dir() {
        return Ok(());
    }
    let mut bundles = BTreeMap::new();
    discover(bundled, bundled, "bundled", &mut bundles)?;
    let mut history: BTreeMap<String, Vec<String>> = match fs::read(bundled.join(".history.json")) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| Error::new(5200, e.to_string()))?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => BTreeMap::new(),
        Err(e) => return Err(e.into()),
    };
    for (name, skill) in bundles {
        if let Some(hash) = fingerprint(skill.path.parent().unwrap())? {
            history.entry(name).or_default().push(hash);
        }
    }
    let profiles = home.join("profiles");
    safe_path(home, &profiles)?;
    if profiles.exists() {
        for profile in fs::read_dir(&profiles)? {
            let profile = profile?;
            if !profile.file_type()?.is_dir() {
                continue;
            }
            let root = profile.path().join("skills");
            deduplicate(&root, bundled, &history)?;
        }
    }
    conn.execute("INSERT INTO settings(key,value) VALUES (?, 'true')", [key])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn put(root: &Path, name: &str, body: &str) -> PathBuf {
        let dir = root.join(name);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("SKILL.md"),
            format!("---\ndescription: {body}\n---\n{body}"),
        )
        .unwrap();
        dir
    }
    #[test]
    fn precedence_grants_and_private_visibility() {
        let home = tempfile::tempdir().unwrap();
        let bundled = tempfile::tempdir().unwrap();
        put(bundled.path(), "work/notes", "bundled");
        put(&home.path().join("skills"), "writing/notes", "library");
        let private = put(
            &home.path().join("profiles/owl/skills"),
            "personal/notes",
            "private",
        );
        let read = |bot| {
            resolve_with(home.path(), bot, bundled.path())
                .unwrap()
                .remove(0)
        };
        assert_eq!(read(None).source, "library");
        assert_eq!(read(Some("fox")).description, "library");
        let skill = read(Some("owl"));
        assert_eq!(skill.source, "bot");
        assert_eq!(skill.description, "private");
        assert_eq!(skill.category.as_deref(), Some("personal"));
        set_enabled(home.path(), Some("owl"), "notes", false).unwrap();
        assert!(!read(Some("owl")).enabled_for_bot);
        assert!(read(Some("fox")).enabled_for_bot);
        set_enabled(home.path(), None, "notes", false).unwrap();
        set_enabled(home.path(), Some("owl"), "notes", true).unwrap();
        assert!(read(Some("owl")).disabled_globally);
        assert!(read(Some("owl")).enabled_for_bot);
        assert!(!read(Some("owl")).enabled);
        assert!(!read(None).enabled);
        set_enabled(home.path(), None, "notes", true).unwrap();
        assert!(read(Some("owl")).enabled_for_bot);
        fs::remove_dir_all(private).unwrap();
        assert_eq!(read(Some("owl")).source, "library");
        fs::remove_dir_all(home.path().join("skills")).unwrap();
        assert_eq!(read(Some("owl")).source, "bundled");
    }
    #[test]
    fn migration_removes_only_identical_directories_once() {
        let home = tempfile::tempdir().unwrap();
        db::migrate(home.path()).unwrap();
        db::open(home.path())
            .unwrap()
            .execute(
                "DELETE FROM settings WHERE key='migration:shared-skills-v1'",
                [],
            )
            .unwrap();
        let bundled = tempfile::tempdir().unwrap();
        let private = home.path().join("profiles/owl/skills");
        for name in ["same", "body", "support", "extra"] {
            let bundle = put(bundled.path(), &format!("work/{name}"), "original");
            fs::create_dir(bundle.join("scripts")).unwrap();
            fs::write(bundle.join("scripts/run.py"), "print(1)").unwrap();
            copy_tree(&bundle, &private.join("work").join(name)).unwrap();
        }
        fs::write(private.join("work/body/SKILL.md"), "changed").unwrap();
        fs::write(private.join("work/support/scripts/run.py"), "print(2)").unwrap();
        fs::write(private.join("work/extra/.note"), "keep").unwrap();
        set_enabled(home.path(), Some("owl"), "same", false).unwrap();
        let config = fs::read(home.path().join("profiles/owl/config.yaml")).unwrap();
        migrate_with(home.path(), bundled.path()).unwrap();
        assert!(!private.join("work/same").exists());
        assert!(private.join("work/extra/.note").is_file());
        for name in ["body", "support", "extra"] {
            assert!(private.join("work").join(name).is_dir());
        }
        assert_eq!(
            config,
            fs::read(home.path().join("profiles/owl/config.yaml")).unwrap()
        );
        assert!(
            !resolve_with(home.path(), Some("owl"), bundled.path())
                .unwrap()
                .into_iter()
                .find(|s| s.name == "same")
                .unwrap()
                .enabled
        );
        copy_tree(
            &bundled.path().join("work/same"),
            &private.join("work/same"),
        )
        .unwrap();
        migrate_with(home.path(), bundled.path()).unwrap();
        assert!(
            private.join("work/same").exists(),
            "completed migration is not rerun"
        );
    }
    #[cfg(unix)]
    #[test]
    fn a_symlinked_home_migrates_and_resolves() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("real")).unwrap();
        let home = dir.path().join("home");
        std::os::unix::fs::symlink(dir.path().join("real"), &home).unwrap();
        let bundled = tempfile::tempdir().unwrap();
        put(bundled.path(), "work/same", "body");
        db::migrate(&home).unwrap();
        migrate_with(&home, bundled.path()).unwrap();
        assert!(
            resolve_with(&home, None, bundled.path())
                .unwrap()
                .iter()
                .any(|s| s.name == "same")
        );
    }
    #[test]
    fn fingerprints_match_manifest_and_ignore_only_dotfiles_and_non_exec_permissions() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("SKILL.md"), "body").unwrap();
        assert_eq!(
            fingerprint(dir.path()).unwrap().unwrap(),
            "58689cdc43326993f597c831b4497c78b5af37e37d42f59796bcba1a489d91e4"
        );
        fs::write(dir.path().join("a.txt"), "sibling").unwrap();
        fs::create_dir(dir.path().join("a")).unwrap();
        fs::write(dir.path().join("a/b"), "nested").unwrap();
        assert_eq!(
            fingerprint(dir.path()).unwrap().unwrap(),
            "9ffb1ec9d346ae7a634e29f97b901607127543b617ea843d9e3623dafa919f8e"
        );
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../skills");
        let history: BTreeMap<String, Vec<String>> =
            serde_json::from_slice(&fs::read(root.join(".history.json")).unwrap()).unwrap();
        let mut found = BTreeMap::new();
        discover(&root, &root, "bundled", &mut found).unwrap();
        assert!(!found.contains_key(".history.json"));
        for (name, skill) in found {
            assert!(
                history[&name]
                    .contains(&fingerprint(skill.path.parent().unwrap()).unwrap().unwrap()),
                "regenerate history for {name}"
            );
        }
    }

    #[test]
    fn migration_removes_old_versions_and_category_remnants_but_keeps_edits() {
        let home = tempfile::tempdir().unwrap();
        db::migrate(home.path()).unwrap();
        db::open(home.path())
            .unwrap()
            .execute(
                "DELETE FROM settings WHERE key='migration:shared-skills-v1'",
                [],
            )
            .unwrap();
        let bundled = tempfile::tempdir().unwrap();
        let private = home.path().join("profiles/owl/skills");
        let old = put(bundled.path(), "work/old", "old version");
        let old_hash = fingerprint(&old).unwrap().unwrap();
        copy_tree(&old, &private.join("work/old")).unwrap();
        copy_tree(&old, &private.join("work/noted")).unwrap();
        fs::create_dir(private.join("work/noted/.hidden")).unwrap();
        fs::write(private.join("work/noted/.hidden/data"), "user data").unwrap();
        put(bundled.path(), "work/old", "new version");
        put(bundled.path(), "work/modified", "new version");
        put(&private, "work/modified", "user edited");
        let same = put(bundled.path(), "clean/same", "unchanged");
        copy_tree(&same, &private.join("clean/same")).unwrap();
        for root in [bundled.path(), private.as_path()] {
            fs::write(root.join("clean/DESCRIPTION.md"), "category").unwrap();
        }
        fs::create_dir_all(private.join("empty/nested")).unwrap();
        fs::write(
            bundled.path().join(".history.json"),
            json!({"old":[old_hash],"noted":[old_hash]}).to_string(),
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::{PermissionsExt, symlink};
            fs::set_permissions(
                private.join("work/old/SKILL.md"),
                fs::Permissions::from_mode(0o600),
            )
            .unwrap();
            let executable = put(bundled.path(), "work/executable", "body");
            copy_tree(&executable, &private.join("work/executable")).unwrap();
            fs::set_permissions(
                private.join("work/executable/SKILL.md"),
                fs::Permissions::from_mode(0o700),
            )
            .unwrap();
            let linked = put(bundled.path(), "work/linked", "body");
            fs::create_dir_all(private.join("work/linked")).unwrap();
            symlink(
                linked.join("SKILL.md"),
                private.join("work/linked/SKILL.md"),
            )
            .unwrap();
        }
        migrate_with(home.path(), bundled.path()).unwrap();
        assert!(!private.join("work/old").exists());
        assert!(private.join("work/noted/.hidden/data").is_file());
        assert!(!private.join("clean").exists());
        assert!(!private.join("empty").exists());
        assert!(private.join("work/modified/SKILL.md").exists());
        #[cfg(unix)]
        {
            assert!(private.join("work/executable/SKILL.md").exists());
            assert!(
                fs::symlink_metadata(private.join("work/linked/SKILL.md"))
                    .unwrap()
                    .file_type()
                    .is_symlink()
            );
        }
    }
}
