//! Compatible storage for the Hexbot-owned database, using an explicit home.

use std::{collections::BTreeMap, fs, io::Write, path::Path, time::Duration};

use rusqlite::{Connection, OptionalExtension, TransactionBehavior};

use crate::{Error, Result};

pub const SCHEMA_VERSION: i64 = 13;
/// Version 13 made a daemon one person's: earlier accounts fold into the owner.
const ONE_PERSON_VERSION: i64 = 13;

/// Native scheduler tables live in hexbot-runtime.db, separate from the legacy schema.
pub(crate) fn migrate_runtime(conn: &Connection) -> Result<()> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS native_jobs(id TEXT PRIMARY KEY,owner TEXT NOT NULL,bot TEXT NOT NULL,job_json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS native_job_imports(bot TEXT PRIMARY KEY);")?;
    Ok(())
}

const TABLES: &str = "
CREATE TABLE IF NOT EXISTS schema_version(version INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS bots(name TEXT PRIMARY KEY, display_name TEXT, title TEXT,
 description TEXT, owner_id TEXT NOT NULL DEFAULT 'local', created_at REAL,
 updated_at REAL, last_activity_at REAL);
CREATE TABLE IF NOT EXISTS sections(id TEXT PRIMARY KEY, bot TEXT NOT NULL, title TEXT,
 owner_id TEXT NOT NULL DEFAULT 'local', created_at REAL, updated_at REAL,
 archived_at REAL, last_live_session_id TEXT);
CREATE TABLE IF NOT EXISTS devices(id TEXT PRIMARY KEY, name TEXT, platform TEXT,
 token_hash TEXT UNIQUE, owner_id TEXT NOT NULL DEFAULT 'local', created_at REAL,
 last_seen_at REAL, revoked_at REAL);
CREATE TABLE IF NOT EXISTS pairing_codes(code_hash TEXT PRIMARY KEY, created_at REAL,
 expires_at REAL, used_at REAL);
CREATE TABLE IF NOT EXISTS spent_grants(jti TEXT PRIMARY KEY, exp REAL NOT NULL);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS rooms(
 id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id TEXT NOT NULL DEFAULT 'local',
 main_bot TEXT, approval_mode TEXT, limits_json TEXT NOT NULL DEFAULT '{}',
 created_at REAL, updated_at REAL, last_activity_at REAL, archived_at REAL);
CREATE TABLE IF NOT EXISTS room_members(
 room_id TEXT NOT NULL, member_kind TEXT NOT NULL CHECK(member_kind IN ('human','bot')),
 member_id TEXT NOT NULL, added_by TEXT, added_at REAL, left_at REAL,
 last_read_seq INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(room_id,member_kind,member_id),
 FOREIGN KEY(room_id) REFERENCES rooms(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS room_events(
 room_id TEXT NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL,
 actor_kind TEXT, actor_id TEXT, payload_json TEXT NOT NULL DEFAULT '{}', created_at REAL,
 PRIMARY KEY(room_id,seq), FOREIGN KEY(room_id) REFERENCES rooms(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS room_sessions(
 room_id TEXT NOT NULL, bot TEXT NOT NULL, stored_session_id TEXT NOT NULL,
 live_session_id TEXT, PRIMARY KEY(room_id,bot),
 FOREIGN KEY(room_id) REFERENCES rooms(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS room_turns(
 id TEXT PRIMARY KEY, room_id TEXT NOT NULL, bot TEXT NOT NULL, trigger_seq INTEGER NOT NULL,
 started_at REAL, finished_at REAL, status TEXT NOT NULL,
 input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
 cost_usd REAL NOT NULL DEFAULT 0,
 FOREIGN KEY(room_id) REFERENCES rooms(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS bot_messages(
 id TEXT PRIMARY KEY, from_bot TEXT NOT NULL, to_bot TEXT NOT NULL,
 room_id TEXT, section_id TEXT, created_at REAL, text TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS dreams(
 id TEXT PRIMARY KEY, bot TEXT NOT NULL, room_id TEXT, started_at REAL NOT NULL,
 finished_at REAL, status TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS room_memory(
 room_id TEXT PRIMARY KEY, text TEXT NOT NULL DEFAULT '', updated_at REAL NOT NULL,
 FOREIGN KEY(room_id) REFERENCES rooms(id) ON DELETE CASCADE);
-- One row: the owner, id 'local'. role and limits_json are left from multi-user builds.
CREATE TABLE IF NOT EXISTS users(
 id TEXT PRIMARY KEY, display_name TEXT NOT NULL, role TEXT NOT NULL
 CHECK(role IN ('admin','member')), limits_json TEXT NOT NULL DEFAULT '{}',
 created_at REAL NOT NULL, disabled_at REAL);
CREATE TABLE IF NOT EXISTS bot_incidents(
 id TEXT PRIMARY KEY, bot TEXT NOT NULL, section_id TEXT, room_id TEXT, session_id TEXT,
 kind TEXT NOT NULL CHECK(kind IN ('connector_error','turn_failed')), connector TEXT,
 text TEXT NOT NULL DEFAULT '', created_at REAL NOT NULL, resolved_at REAL);
CREATE INDEX IF NOT EXISTS idx_sections_bot ON sections(bot);
CREATE INDEX IF NOT EXISTS idx_room_events_room_seq ON room_events(room_id,seq);
CREATE INDEX IF NOT EXISTS idx_room_turns_room_trigger ON room_turns(room_id,trigger_seq);
CREATE INDEX IF NOT EXISTS idx_bot_messages_pair ON bot_messages(from_bot,to_bot,created_at);
CREATE INDEX IF NOT EXISTS idx_dreams_bot_started ON dreams(bot,started_at DESC);
CREATE INDEX IF NOT EXISTS idx_devices_owner ON devices(owner_id);
CREATE INDEX IF NOT EXISTS idx_bots_owner ON bots(owner_id);
CREATE INDEX IF NOT EXISTS idx_sections_owner ON sections(owner_id);
CREATE INDEX IF NOT EXISTS idx_rooms_owner ON rooms(owner_id);
CREATE INDEX IF NOT EXISTS idx_bot_incidents_bot_open ON bot_incidents(bot,resolved_at);
";

const COLUMNS: &[(&str, &str, &str)] = &[
    ("devices", "jkt", "TEXT"),
    ("sections", "title_dirty", "INTEGER NOT NULL DEFAULT 0"),
    ("bots", "dream_enabled", "INTEGER NOT NULL DEFAULT 1"),
    ("bots", "tools_json", "TEXT NOT NULL DEFAULT '[]'"),
    ("bots", "skills_json", "TEXT NOT NULL DEFAULT '[]'"),
    ("bots", "shareable", "INTEGER NOT NULL DEFAULT 0"),
    ("pairing_codes", "user_id", "TEXT NOT NULL DEFAULT 'local'"),
    ("dreams", "owner_id", "TEXT NOT NULL DEFAULT 'local'"),
    ("bots", "notify", "INTEGER NOT NULL DEFAULT 1"),
    ("bots", "approval_mode", "TEXT NOT NULL DEFAULT 'inherit'"),
    ("bots", "workdir", "TEXT"),
    ("sections", "done_at", "REAL"),
    ("dreams", "memory_before", "TEXT"),
    ("dreams", "memory_after", "TEXT"),
    ("sections", "title_by", "TEXT"),
    ("bots", "auto_description", "TEXT"),
    ("bots", "auto_description_key", "TEXT"),
    ("sections", "peer_bot", "TEXT"),
    ("bot_messages", "source_section", "TEXT"),
];

/// Open the explicitly selected database without running schema migrations.
pub fn open(home: &Path) -> Result<Connection> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(home)?;
        fs::set_permissions(home, fs::Permissions::from_mode(0o700))?;
    }
    let database = home.join("hexbot.db");
    if fs::symlink_metadata(&database).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err(Error::new(5200, "database must not be a symlink"));
    }
    let connection = Connection::open(database)?;
    connection.busy_timeout(Duration::from_secs(10))?;
    connection.pragma_update(None, "journal_mode", "WAL")?;
    connection.pragma_update(None, "foreign_keys", "ON")?;
    Ok(connection)
}

/// Upgrade all known schemas in one database transaction. Never downgrade.
pub fn migrate(home: &Path) -> Result<()> {
    fs::create_dir_all(home)?;
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(home.join("migrate.lock"))?;
    lock.lock()?;
    let mut connection = open(home)?;
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let mut previous: Option<i64> = None;
    if table_exists(&transaction, "schema_version")? {
        previous = transaction.query_row("SELECT MAX(version) FROM schema_version", [], |row| {
            row.get(0)
        })?;
        if previous.is_some_and(|version| version > SCHEMA_VERSION) {
            return Err(Error::new(
                5200,
                "database was created by a newer Hexbot version",
            ));
        }
    }
    transaction.execute_batch(TABLES)?;
    for (table, column, definition) in COLUMNS {
        if !column_exists(&transaction, table, column)? {
            // All identifiers and definitions are constants above.
            transaction.execute_batch(&format!(
                "ALTER TABLE {table} ADD COLUMN {column} {definition}"
            ))?;
        }
    }
    transaction.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_bot_messages_source ON bot_messages(source_section,created_at);",
    )?;
    transaction.execute("UPDATE sections SET peer_bot=(SELECT from_bot FROM bot_messages b WHERE b.section_id=sections.id ORDER BY created_at LIMIT 1) WHERE peer_bot IS NULL AND title=('From '||(SELECT from_bot FROM bot_messages b WHERE b.section_id=sections.id ORDER BY created_at LIMIT 1))", [])?;
    fold_core_memory(&transaction, home)?;
    transaction
        .execute_batch("DROP TABLE IF EXISTS core_memory; DROP TABLE IF EXISTS memory_entries;")?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| Error::new(5200, error.to_string()))?
        .as_secs_f64();
    transaction.execute(
        "INSERT OR IGNORE INTO users(id,display_name,role,limits_json,created_at) VALUES ('local','Admin','admin','{}',?)",
        [now],
    )?;
    if previous.is_some_and(|version| version < ONE_PERSON_VERSION) {
        name_from_about_you(&transaction, home)?;
        fold_people(&transaction, home, now)?;
    }
    transaction.execute("DELETE FROM schema_version", [])?;
    transaction.execute(
        "INSERT INTO schema_version(version) VALUES (?)",
        [SCHEMA_VERSION],
    )?;
    transaction.commit()?;
    crate::skills::migrate(home)?;
    Ok(())
}

/// Earlier builds kept the name from Get Started only in About you and called the
/// owner Admin everywhere else.
fn name_from_about_you(connection: &Connection, home: &Path) -> Result<()> {
    let about = fs::read_to_string(home.join("users/local/user.md")).unwrap_or_default();
    let Some(name) = about
        .lines()
        .find_map(|line| line.strip_prefix("Name:"))
        .map(str::trim)
        .filter(|name| !name.is_empty())
    else {
        return Ok(());
    };
    let name: String = name.chars().take(64).collect();
    connection.execute(
        "UPDATE users SET display_name=? WHERE id='local' AND display_name='Admin'",
        [name],
    )?;
    Ok(())
}

/// Earlier builds let an admin invite other people. A daemon is now one person's:
/// what other accounts made becomes the owner's, and their devices stop working.
fn fold_people(connection: &Connection, home: &Path, now: f64) -> Result<()> {
    let others: i64 =
        connection.query_row("SELECT COUNT(*) FROM users WHERE id<>'local'", [], |row| {
            row.get(0)
        })?;
    if others == 0 {
        return Ok(());
    }
    // The runtime database commits first; rerunning this fold is harmless.
    let mut runtime = crate::runtime_store::open(home)?;
    let tx = runtime.transaction()?;
    tx.execute_batch(
        "UPDATE native_sessions SET owner='local' WHERE owner<>'local';
         UPDATE native_jobs SET owner='local' WHERE owner<>'local';
         UPDATE native_usage SET owner_id='local' WHERE owner_id<>'local';",
    )?;
    tx.commit()?;
    // Members could never choose Bypass, so their bots and rooms keep Auto.
    connection.execute_batch(
        "UPDATE bots SET approval_mode='smart' WHERE approval_mode='off' AND owner_id<>'local';
         UPDATE rooms SET approval_mode='smart' WHERE approval_mode='off' AND owner_id<>'local';
         UPDATE bots SET owner_id='local' WHERE owner_id<>'local';
         UPDATE sections SET owner_id='local' WHERE owner_id<>'local';
         UPDATE rooms SET owner_id='local' WHERE owner_id<>'local';
         UPDATE dreams SET owner_id='local' WHERE owner_id<>'local';
         UPDATE room_members SET added_by='local' WHERE added_by<>'local';",
    )?;
    connection.execute(
        "UPDATE room_members SET left_at=? WHERE member_kind='human' AND member_id<>'local' AND left_at IS NULL",
        [now],
    )?;
    connection.execute(
        "INSERT OR IGNORE INTO room_members(room_id,member_kind,member_id,added_by,added_at,left_at,last_read_seq) SELECT id,'human','local','local',?,NULL,0 FROM rooms",
        [now],
    )?;
    connection.execute(
        "UPDATE room_members SET left_at=NULL WHERE member_kind='human' AND member_id='local'",
        [],
    )?;
    connection.execute(
        "UPDATE devices SET revoked_at=? WHERE owner_id<>'local' AND revoked_at IS NULL",
        [now],
    )?;
    connection.execute(
        "UPDATE pairing_codes SET used_at=? WHERE user_id<>'local' AND used_at IS NULL",
        [now],
    )?;
    connection.execute(
        "UPDATE users SET disabled_at=? WHERE id<>'local' AND disabled_at IS NULL",
        [now],
    )?;
    connection.execute(
        "UPDATE users SET role='admin',disabled_at=NULL,limits_json='{}' WHERE id='local'",
        [],
    )?;
    Ok(())
}

fn table_exists(connection: &Connection, name: &str) -> Result<bool> {
    Ok(connection
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
            [name],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

fn column_exists(connection: &Connection, table: &str, column: &str) -> Result<bool> {
    let mut statement = connection.prepare(&format!("PRAGMA table_info({table})"))?;
    let names = statement.query_map([], |row| row.get::<_, String>(1))?;
    for name in names {
        if name? == column {
            return Ok(true);
        }
    }
    Ok(false)
}

fn fold_core_memory(connection: &Connection, home: &Path) -> Result<()> {
    if !table_exists(connection, "core_memory")? {
        return Ok(());
    }
    let owner = if column_exists(connection, "core_memory", "owner_id")? {
        "owner_id"
    } else {
        "'local'"
    };
    let mut statement = connection.prepare(&format!(
        "SELECT {owner} AS owner_id, section, text FROM core_memory WHERE trim(text) != '' ORDER BY owner_id, section"
    ))?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
        ))
    })?;
    let mut owners: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for row in rows {
        let (owner, section, text) = row?;
        if owner.is_empty()
            || owner == "."
            || owner == ".."
            || owner.contains(['/', '\\', '\0'])
            || !matches!(
                Path::new(&owner).components().next(),
                Some(std::path::Component::Normal(_))
            )
        {
            return Err(Error::new(5200, "invalid legacy memory owner"));
        }
        owners.entry(owner).or_default().push(format!(
            "## {}\n{}",
            title_case(&section),
            text.trim()
        ));
    }
    for (owner, chunks) in owners {
        let users = home.join("users");
        let directory = users.join(owner);
        for path in [&users, &directory] {
            if fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
                return Err(Error::new(
                    5200,
                    "legacy memory directory must not be a symlink",
                ));
            }
        }
        let destination = directory.join("user.md");
        // Preserve user-written files, including empty files.
        if fs::symlink_metadata(&destination).is_ok() {
            continue;
        }
        fs::create_dir_all(&directory)?;
        let text: String = chunks.join("\n\n").chars().take(2000).collect();
        let mut temporary = tempfile::NamedTempFile::new_in(&directory)?;
        temporary.write_all(text.as_bytes())?;
        temporary.as_file().sync_all()?;
        if let Err(error) = temporary.persist_noclobber(&destination)
            && error.error.kind() != std::io::ErrorKind::AlreadyExists
        {
            return Err(error.error.into());
        }
        #[cfg(unix)]
        fs::File::open(&directory)?.sync_all()?;
    }
    Ok(())
}

// Legacy headings capitalize words separated by punctuation.
fn title_case(value: &str) -> String {
    let mut previous_cased = false;
    let mut output = String::new();
    for character in value.chars() {
        if previous_cased {
            output.extend(character.to_lowercase());
        } else {
            output.extend(character.to_uppercase());
        }
        previous_cased = character.is_lowercase() || character.is_uppercase();
    }
    output
}
