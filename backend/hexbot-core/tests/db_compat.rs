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
    // Native v12 additions, independent of the current migration constants.
    if version == 12 {
        connection
            .execute_batch(
                "ALTER TABLE bots ADD COLUMN auto_description TEXT;
            ALTER TABLE bots ADD COLUMN auto_description_key TEXT;
            ALTER TABLE devices ADD COLUMN jkt TEXT;
            ALTER TABLE sections ADD COLUMN peer_bot TEXT;
            ALTER TABLE bot_messages ADD COLUMN source_section TEXT;",
            )
            .unwrap();
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
            "devices" => &["jkt"],
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
fn all_legacy_versions_upgrade_without_losing_rows() {
    let python_v11 = legacy_home(11);
    let reference = Connection::open(python_v11.path().join("hexbot.db")).unwrap();
    for version in 1..=12 {
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
            db::SCHEMA_VERSION
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
            "CREATE TABLE schema_version(version INTEGER); INSERT INTO schema_version VALUES (99);",
        )
        .unwrap();
    assert!(db::migrate(home.path()).is_err());
    assert_eq!(
        connection
            .query_row("SELECT version FROM schema_version", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        99
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
fn bot_thread_backfill_uses_first_sender_keeps_renamed_sections_and_is_idempotent() {
    let home = legacy_home(11);
    let conn = db::open(home.path()).unwrap();
    conn.execute_batch("INSERT INTO sections(id,bot,title) VALUES('thread','receiver','From sender'),('normal','receiver','Normal'),('renamed','receiver','Plans');
        INSERT INTO bot_messages(id,from_bot,to_bot,section_id,created_at,text) VALUES('later','second','receiver','thread',2,'later'),('first','sender','receiver','thread',1,'first'),('unassigned','sender','receiver',NULL,0,'unassigned'),('kept','sender','receiver','renamed',3,'kept');").unwrap();
    db::migrate(home.path()).unwrap();
    let snapshot = || {
        conn.prepare("SELECT id,peer_bot FROM sections WHERE id IN ('normal','renamed','thread') ORDER BY id")
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
            // The user renamed it; it is their conversation and stays in their lists.
            ("renamed".into(), None),
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
            ("renamed".into(), None),
            ("thread".into(), Some("sender".into()))
        ]
    );
    assert_eq!(
        conn.query_row("SELECT version FROM schema_version", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        db::SCHEMA_VERSION
    );
}

#[test]
fn upgrading_folds_invited_people_into_the_owner_once() {
    let home = TempDir::new().unwrap();
    let h = home.path();
    db::migrate(h).unwrap();
    let conn = db::open(h).unwrap();
    conn.execute_batch(
        "UPDATE schema_version SET version=12;
         INSERT INTO users(id,display_name,role,created_at) VALUES ('bob','Bob','member',0);
         INSERT INTO bots(name,owner_id,approval_mode) VALUES ('owl','local','off'),('fox','bob','off');
         INSERT INTO sections(id,bot,owner_id) VALUES ('mine','owl','local'),('his','fox','bob');
         INSERT INTO devices(id,name,token_hash,owner_id) VALUES ('phone','Phone','a','local'),('his-phone','Phone','b','bob');
         INSERT INTO pairing_codes(code_hash,created_at,expires_at,user_id) VALUES ('code',0,9999999999,'bob');
         INSERT INTO rooms(id,name,owner_id,approval_mode) VALUES ('ours','Ours','local',NULL),('his-room','His','bob','off');
         INSERT INTO room_members(room_id,member_kind,member_id,added_by) VALUES ('ours','human','local','local'),('ours','human','bob','local'),('his-room','human','bob','bob'),('his-room','human','local','bob'),('his-room','bot','fox','bob');",
    )
    .unwrap();
    conn.execute(
        "UPDATE room_members SET left_at=1 WHERE room_id='his-room' AND member_id='local'",
        [],
    )
    .unwrap();
    hexbot_core::runtime_store::open(h)
        .unwrap()
        .execute_batch("INSERT INTO native_sessions(stored_id,owner,bot,prompt) VALUES ('his','bob','fox','');")
        .unwrap();
    fs::create_dir_all(h.join("users/local")).unwrap();
    fs::write(
        h.join("users/local/user.md"),
        "Name: Alex\nWhat I do: Design",
    )
    .unwrap();
    db::migrate(h).unwrap();
    let one = |sql: &str| -> String { conn.query_row(sql, [], |r| r.get(0)).unwrap() };
    let count = |sql: &str| -> i64 { conn.query_row(sql, [], |r| r.get(0)).unwrap() };
    assert_eq!(
        one("SELECT display_name FROM users WHERE id='local'"),
        "Alex"
    );
    for table in ["bots", "sections", "rooms"] {
        assert_eq!(
            count(&format!(
                "SELECT COUNT(*) FROM {table} WHERE owner_id<>'local'"
            )),
            0,
            "{table}"
        );
    }
    // Members could never choose Bypass, so their bot and room keep Auto.
    assert_eq!(
        one("SELECT approval_mode FROM bots WHERE name='fox'"),
        "smart"
    );
    assert_eq!(
        one("SELECT approval_mode FROM bots WHERE name='owl'"),
        "off"
    );
    assert_eq!(
        one("SELECT approval_mode FROM rooms WHERE id='his-room'"),
        "smart"
    );
    assert_eq!(
        count("SELECT COUNT(*) FROM room_members WHERE member_kind='human' AND left_at IS NULL"),
        2
    );
    assert_eq!(
        count(
            "SELECT COUNT(*) FROM room_members WHERE member_kind='human' AND member_id='local' AND left_at IS NULL"
        ),
        2
    );
    assert_eq!(
        count("SELECT COUNT(*) FROM devices WHERE revoked_at IS NULL"),
        1
    );
    assert_eq!(
        count("SELECT COUNT(*) FROM pairing_codes WHERE used_at IS NULL"),
        0
    );
    assert_eq!(
        count("SELECT COUNT(*) FROM users WHERE disabled_at IS NULL"),
        1
    );
    let owner: String = hexbot_core::runtime_store::open(h)
        .unwrap()
        .query_row(
            "SELECT owner FROM native_sessions WHERE stored_id='his'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(owner, "local");
    // Later migrations never fold again.
    conn.execute_batch("INSERT INTO users(id,display_name,role,created_at) VALUES ('carol','Carol','member',0); INSERT INTO bots(name,owner_id) VALUES ('ant','carol');").unwrap();
    db::migrate(h).unwrap();
    assert_eq!(one("SELECT owner_id FROM bots WHERE name='ant'"), "carol");
}

#[test]
fn fold_preserves_bot_modes_resolving_inheritance_and_admin_caps() {
    for global in ["off", "manual", "smart"] {
        let home = legacy_home(12);
        let conn = db::open(home.path()).unwrap();
        conn.execute_batch(
            "INSERT INTO users(id,display_name,role,created_at) VALUES
            ('bob','Bob','member',0),('admin','Admin','admin',0);
            INSERT INTO bots(name,owner_id,approval_mode) VALUES
            ('inherited','bob','inherit'),('bypass','bob','off'),
            ('manual','bob','manual'),('auto','bob','smart'),('admin-bot','admin','off');",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO settings VALUES ('approval_mode',?)",
            [serde_json::json!(global).to_string()],
        )
        .unwrap();
        db::migrate(home.path()).unwrap();
        for (bot, expected) in [
            (
                "inherited",
                if global == "off" { "smart" } else { "inherit" },
            ),
            ("bypass", "smart"),
            ("manual", "manual"),
            ("auto", "smart"),
            ("admin-bot", "off"),
        ] {
            let mode: String = conn
                .query_row("SELECT approval_mode FROM bots WHERE name=?", [bot], |r| {
                    r.get(0)
                })
                .unwrap();
            assert_eq!(mode, expected, "{bot}, daemon {global}");
        }
        db::migrate(home.path()).unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT owner_id FROM bots WHERE name='inherited'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "local"
        );
    }
}

#[test]
fn fold_preserves_shared_room_restrictions() {
    // room owner, room mode, bot owner, bot mode, daemon mode, pinned room mode
    for (owner, mode, bot_owner, bot_mode, global, expected) in [
        ("bob", None, "local", "off", "smart", Some("smart")),
        (
            "bob",
            Some("inherit"),
            "local",
            "inherit",
            "off",
            Some("smart"),
        ),
        ("bob", Some("off"), "local", "off", "smart", Some("smart")),
        (
            "local",
            Some("off"),
            "bob",
            "manual",
            "smart",
            Some("manual"),
        ),
        ("local", Some("off"), "bob", "smart", "smart", Some("smart")),
        (
            "local",
            Some("off"),
            "bob",
            "inherit",
            "manual",
            Some("manual"),
        ),
        (
            "local",
            Some("smart"),
            "bob",
            "manual",
            "smart",
            Some("manual"),
        ),
        (
            "bob",
            Some("off"),
            "local",
            "manual",
            "smart",
            Some("manual"),
        ),
        ("bob", None, "bob", "inherit", "manual", None),
        (
            "local",
            Some("off"),
            "local",
            "manual",
            "smart",
            Some("off"),
        ),
    ] {
        let home = legacy_home(12);
        let conn = db::open(home.path()).unwrap();
        conn.execute_batch(
            "INSERT INTO users(id,display_name,role,created_at) VALUES
            ('local','Owner','admin',0),('bob','Bob','member',0);",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO settings VALUES ('approval_mode',?)",
            [serde_json::json!(global).to_string()],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO bots(name,owner_id,approval_mode) VALUES ('bot',?,?)",
            [bot_owner, bot_mode],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO rooms(id,name,owner_id,approval_mode) VALUES ('room','Room',?,?)",
            rusqlite::params![owner, mode],
        )
        .unwrap();
        conn.execute_batch("INSERT INTO room_members(room_id,member_kind,member_id,added_by) VALUES ('room','bot','bot','local');").unwrap();
        db::migrate(home.path()).unwrap();
        let after: Option<String> = conn
            .query_row("SELECT approval_mode FROM rooms WHERE id='room'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(
            after.as_deref(),
            expected,
            "room {owner}/{mode:?}, bot {bot_owner}/{bot_mode}, daemon {global}"
        );
        db::migrate(home.path()).unwrap();
        assert_eq!(
            conn.query_row("SELECT approval_mode FROM rooms WHERE id='room'", [], |r| r
                .get::<_, Option<String>>(0))
                .unwrap(),
            after
        );
    }
}

#[test]
fn pinning_inherited_room_does_not_relax_its_other_manual_bots() {
    let home = legacy_home(12);
    let conn = db::open(home.path()).unwrap();
    conn.execute_batch("INSERT INTO users(id,display_name,role,created_at) VALUES
        ('local','Owner','admin',0),('bob','Bob','member',0);
        INSERT INTO bots(name,owner_id,approval_mode) VALUES ('bypass','local','off'),('manual','local','manual');
        INSERT INTO rooms(id,name,owner_id) VALUES ('room','Room','bob');
        INSERT INTO room_members(room_id,member_kind,member_id,added_by) VALUES
        ('room','bot','bypass','bob'),('room','bot','manual','bob');").unwrap();
    db::migrate(home.path()).unwrap();
    assert_eq!(
        conn.query_row("SELECT approval_mode FROM rooms WHERE id='room'", [], |r| r
            .get::<_, String>(0))
            .unwrap(),
        "manual"
    );
}

#[test]
fn empty_schema_version_still_folds_legacy_accounts() {
    let home = legacy_home(12);
    let conn = db::open(home.path()).unwrap();
    conn.execute_batch(
        "DELETE FROM schema_version;
        INSERT INTO users(id,display_name,role,created_at) VALUES ('bob','Bob','member',0);
        UPDATE bots SET owner_id='bob',approval_mode='off';",
    )
    .unwrap();
    db::migrate(home.path()).unwrap();
    assert_eq!(
        conn.query_row("SELECT owner_id,approval_mode FROM bots", [], |r| Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?
        )))
        .unwrap(),
        ("local".into(), "smart".into())
    );
}
