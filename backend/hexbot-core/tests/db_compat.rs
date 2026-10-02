use std::{
    fs,
    sync::{Arc, Barrier},
};

use hexbot_core::db;
use rusqlite::Connection;
use tempfile::TempDir;

// Captured from the historical Python schema constants. This fixture builds
// each Python-era schema independently of the Rust migration implementation.
fn legacy_home(version: i64) -> TempDir {
    let home = TempDir::new().unwrap();
    let connection = Connection::open(home.path().join("hexbot.db")).unwrap();
    let schema: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/python_db_schema.json")).unwrap();
    connection
        .execute_batch(schema["_DDL"].as_str().unwrap())
        .unwrap();
    for step in 2..=version {
        let key = step.to_string();
        if let Some(ddl) = schema["_MIGRATION_DDL"][&key].as_str() {
            connection.execute_batch(ddl).unwrap();
        }
        if let Some(columns) = schema["_ADDED_COLUMNS"][&key].as_array() {
            for column in columns {
                connection
                    .execute_batch(&format!(
                        "ALTER TABLE {} ADD COLUMN {} {}",
                        column[0].as_str().unwrap(),
                        column[1].as_str().unwrap(),
                        column[2].as_str().unwrap()
                    ))
                    .unwrap();
            }
        }
    }
    connection
        .execute("INSERT INTO schema_version VALUES (?)", [version])
        .unwrap();
    connection
        .execute(
            "INSERT INTO bots(name,display_name) VALUES ('scout','Scout')",
            [],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO sections(id,bot,title) VALUES ('durable-session','scout','Saved chat')",
            [],
        )
        .unwrap();
    connection
        .execute("INSERT INTO settings VALUES ('dream_time','\"04:30\"')", [])
        .unwrap();
    home
}

type Column = (String, String, bool, Option<String>, i64);

fn shape(connection: &Connection) -> Vec<(String, Vec<Column>)> {
    let tables: Vec<String> = connection
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    tables
        .into_iter()
        .map(|table| {
            let columns = connection
                .prepare(&format!("PRAGMA table_info({table})"))
                .unwrap()
                .query_map([], |row| {
                    Ok((
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ))
                })
                .unwrap()
                .map(Result::unwrap)
                .collect();
            (table, columns)
        })
        .collect()
}

fn team_shape(connection: &Connection) -> Vec<(String, Vec<Column>)> {
    let mut expected = shape(connection);
    for (table, columns) in &mut expected {
        let names: &[&str] = match table.as_str() {
            "bots" => &["auto_description", "auto_description_key"],
            "sections" => &["peer_bot"],
            "bot_messages" => &["source_section"],
            _ => &[],
        };
        for name in names {
            columns.push(((*name).into(), "TEXT".into(), false, None, 0));
        }
    }
    expected
}

#[test]
fn all_python_versions_upgrade_without_losing_rows() {
    let python_v11 = legacy_home(11);
    let reference = Connection::open(python_v11.path().join("hexbot.db")).unwrap();
    for version in 1..=11 {
        let home = legacy_home(version);
        db::migrate(home.path()).unwrap();
        db::migrate(home.path()).unwrap();
        let connection = db::open(home.path()).unwrap();
        assert_eq!(
            shape(&connection),
            team_shape(&reference),
            "schema {version}"
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT title FROM sections WHERE id='durable-session'",
                    [],
                    |r| r.get::<_, String>(0)
                )
                .unwrap(),
            "Saved chat"
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT value FROM settings WHERE key='dream_time'",
                    [],
                    |r| r.get::<_, String>(0)
                )
                .unwrap(),
            "\"04:30\""
        );
        assert_eq!(
            connection
                .query_row("SELECT version FROM schema_version", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            11
        );
        assert_eq!(
            connection
                .query_row("SELECT role FROM users WHERE id='local'", [], |r| r
                    .get::<_, String>(0))
                .unwrap(),
            "admin"
        );
        assert_eq!(
            connection
                .query_row("PRAGMA foreign_keys", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            connection
                .query_row("PRAGMA journal_mode", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "wal"
        );
    }
}

#[test]
fn open_does_not_migrate_and_future_versions_remain_untouched() {
    let home = TempDir::new().unwrap();
    let connection = db::open(home.path()).unwrap();
    assert_eq!(
        connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
    connection
        .execute_batch(
            "CREATE TABLE schema_version(version INTEGER); INSERT INTO schema_version VALUES (12);",
        )
        .unwrap();
    assert!(db::migrate(home.path()).is_err());
    assert_eq!(
        connection
            .query_row("SELECT version FROM schema_version", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        12
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        1
    );
}

#[test]
fn legacy_memory_exports_per_owner_preserves_files_and_caps_characters() {
    let home = legacy_home(7);
    let connection = db::open(home.path()).unwrap();
    connection.execute_batch("CREATE TABLE core_memory(owner_id TEXT, section TEXT, text TEXT); CREATE TABLE memory_entries(text TEXT);").unwrap();
    connection.execute("INSERT INTO core_memory VALUES ('alice','preferences','  Tea  '),('alice','facts','A fact'),('bob','facts',?)", ["猫".repeat(3000)]).unwrap();
    fs::create_dir_all(home.path().join("users/alice")).unwrap();
    fs::write(home.path().join("users/alice/user.md"), "user-written").unwrap();
    db::migrate(home.path()).unwrap();
    assert_eq!(
        fs::read_to_string(home.path().join("users/alice/user.md")).unwrap(),
        "user-written"
    );
    let bob = fs::read_to_string(home.path().join("users/bob/user.md")).unwrap();
    assert!(bob.starts_with("## Facts\n猫"));
    assert_eq!(bob.chars().count(), 2000);
    assert_eq!(
        connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name IN ('core_memory','memory_entries')",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
}

#[test]
fn oldest_memory_without_owner_exports_to_local() {
    let home = legacy_home(1);
    let connection = db::open(home.path()).unwrap();
    connection.execute_batch("CREATE TABLE core_memory(section TEXT,text TEXT); INSERT INTO core_memory VALUES ('favorite-FOODS','  noodles  '),('empty','   ');").unwrap();
    db::migrate(home.path()).unwrap();
    assert_eq!(
        fs::read_to_string(home.path().join("users/local/user.md")).unwrap(),
        "## Favorite-Foods\nnoodles"
    );
}

#[test]
fn invalid_memory_owner_rolls_back_database_upgrade() {
    let home = legacy_home(7);
    let connection = db::open(home.path()).unwrap();
    connection.execute_batch("CREATE TABLE core_memory(owner_id TEXT,section TEXT,text TEXT); INSERT INTO core_memory VALUES ('../../escape','facts','secret');").unwrap();
    let before = shape(&connection);
    assert!(db::migrate(home.path()).is_err());
    assert_eq!(shape(&connection), before);
    assert_eq!(
        connection
            .query_row("SELECT version FROM schema_version", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        7
    );
    assert_eq!(
        connection
            .query_row("SELECT text FROM core_memory", [], |r| r
                .get::<_, String>(0))
            .unwrap(),
        "secret"
    );
}

#[cfg(unix)]
#[test]
fn home_is_private_and_database_symlinks_are_refused() {
    use std::os::unix::fs::PermissionsExt;
    let home = TempDir::new().unwrap();
    fs::set_permissions(home.path(), fs::Permissions::from_mode(0o777)).unwrap();
    db::open(home.path()).unwrap();
    assert_eq!(
        fs::metadata(home.path()).unwrap().permissions().mode() & 0o777,
        0o700
    );
    fs::remove_file(home.path().join("hexbot.db")).unwrap();
    let outside = TempDir::new().unwrap();
    let target = outside.path().join("outside.db");
    std::os::unix::fs::symlink(&target, home.path().join("hexbot.db")).unwrap();
    assert!(db::open(home.path()).is_err());
    assert!(!target.exists());
}

#[cfg(unix)]
#[test]
fn memory_export_refuses_symlinked_owner_directory() {
    let home = legacy_home(7);
    let outside = TempDir::new().unwrap();
    fs::create_dir(home.path().join("users")).unwrap();
    std::os::unix::fs::symlink(outside.path(), home.path().join("users/alice")).unwrap();
    let connection = db::open(home.path()).unwrap();
    connection.execute_batch("CREATE TABLE core_memory(owner_id TEXT,section TEXT,text TEXT); INSERT INTO core_memory VALUES ('alice','facts','secret');").unwrap();
    assert!(db::migrate(home.path()).is_err());
    assert!(!outside.path().join("user.md").exists());
}

#[test]
fn simultaneous_migrations_serialize_and_remain_idempotent() {
    let home = Arc::new(legacy_home(1));
    let barrier = Arc::new(Barrier::new(6));
    let threads: Vec<_> = (0..6)
        .map(|_| {
            let home = Arc::clone(&home);
            let barrier = Arc::clone(&barrier);
            std::thread::spawn(move || {
                barrier.wait();
                db::migrate(home.path())
            })
        })
        .collect();
    for thread in threads {
        thread.join().unwrap().unwrap();
    }
    let connection = db::open(home.path()).unwrap();
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM schema_version", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM users WHERE id='local'", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        connection
            .query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "ok"
    );
}

#[test]
fn current_python_database_preserves_title_attribution_and_spent_grants() {
    let home = legacy_home(11);
    let conn = db::open(home.path()).unwrap();
    conn.execute("UPDATE sections SET title_by='user'", [])
        .unwrap();
    conn.execute("INSERT INTO spent_grants VALUES ('spent',9999999999)", [])
        .unwrap();
    let before = team_shape(&conn);
    db::migrate(home.path()).unwrap();
    assert_eq!(shape(&conn), before);
    assert_eq!(
        conn.query_row("SELECT title_by FROM sections", [], |r| r
            .get::<_, String>(0))
            .unwrap(),
        "user"
    );
    assert_eq!(
        conn.query_row("SELECT exp FROM spent_grants WHERE jti='spent'", [], |r| {
            r.get::<_, f64>(0)
        })
        .unwrap(),
        9999999999.
    );
}

#[test]
fn bot_thread_backfill_uses_first_sender_and_is_idempotent() {
    let home = legacy_home(11);
    let conn = db::open(home.path()).unwrap();
    conn.execute_batch("INSERT INTO sections(id,bot,title) VALUES('thread','receiver','Old title'),('normal','receiver','Normal');
        INSERT INTO bot_messages(id,from_bot,to_bot,section_id,created_at,text) VALUES('later','second','receiver','thread',2,'later'),('first','sender','receiver','thread',1,'first'),('unassigned','sender','receiver',NULL,0,'unassigned');").unwrap();
    db::migrate(home.path()).unwrap();
    let snapshot = || {
        conn.prepare("SELECT id,peer_bot FROM sections WHERE id IN ('normal','thread') ORDER BY id")
            .unwrap()
            .query_map([], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap()
    };
    let before = snapshot();
    assert_eq!(
        before,
        vec![
            ("normal".into(), None),
            ("thread".into(), Some("sender".into()))
        ]
    );
    conn.execute(
        "UPDATE sections SET peer_bot='preserved' WHERE id='normal'",
        [],
    )
    .unwrap();
    db::migrate(home.path()).unwrap();
    assert_eq!(
        snapshot(),
        vec![
            ("normal".into(), Some("preserved".into())),
            ("thread".into(), Some("sender".into()))
        ]
    );
    assert_eq!(
        conn.query_row("SELECT version FROM schema_version", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        11
    );
}
