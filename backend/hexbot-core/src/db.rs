//! Compatible storage for the Hexbot-owned database, using an explicit home.

use std::{collections::BTreeMap, fs, io::Write, path::Path, time::Duration};

use rusqlite::{Connection, OptionalExtension, TransactionBehavior};

use crate::{Error, Result};

pub const SCHEMA_VERSION: i64 = 14;

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
CREATE TABLE IF NOT EXISTS users(
 id TEXT PRIMARY KEY, display_name TEXT NOT NULL, role TEXT NOT NULL
 CHECK(role IN ('admin','member')), limits_json TEXT NOT NULL DEFAULT '{}',
 created_at REAL NOT NULL, disabled_at REAL);
CREATE TABLE IF NOT EXISTS bot_incidents(
 id TEXT PRIMARY KEY, bot TEXT NOT NULL, section_id TEXT, room_id TEXT, session_id TEXT,
 kind TEXT NOT NULL CHECK(kind IN ('connector_error','turn_failed')), connector TEXT,
 text TEXT NOT NULL DEFAULT '', created_at REAL NOT NULL, resolved_at REAL);
CREATE TABLE IF NOT EXISTS memory_proposals(
 id TEXT PRIMARY KEY, bot TEXT NOT NULL, owner_id TEXT NOT NULL, job_id TEXT NOT NULL,
 action TEXT NOT NULL, args_json TEXT NOT NULL DEFAULT '{}', created_at REAL NOT NULL,
 consumed_at REAL, consumed_by TEXT);
CREATE INDEX IF NOT EXISTS idx_sections_bot ON sections(bot);
CREATE INDEX IF NOT EXISTS idx_memory_proposals_bot_pending ON memory_proposals(bot,consumed_at,created_at);
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
    if table_exists(&transaction, "schema_version")? {
        let version: Option<i64> =
            transaction.query_row("SELECT MAX(version) FROM schema_version", [], |row| {
                row.get(0)
            })?;
        if version.is_some_and(|version| version > SCHEMA_VERSION) {
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
    transaction.execute("DELETE FROM schema_version", [])?;
    transaction.execute(
        "INSERT INTO schema_version(version) VALUES (?)",
        [SCHEMA_VERSION],
    )?;
    transaction.commit()?;
    crate::skills::migrate(home)?;
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
