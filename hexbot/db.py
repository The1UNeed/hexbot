"""SQLite persistence for Hexbot-owned data."""

from __future__ import annotations

import logging
import sqlite3
from contextlib import contextmanager
from typing import Iterator

from hexbot.home import DATABASE_NAME, ensure_layout

logger = logging.getLogger(__name__)

SCHEMA_VERSION = 8

_DDL = """
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
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_sections_bot ON sections(bot);
"""

# version -> list of statements applied when upgrading INTO that version.
# Every statement must tolerate being run against a database that already has
# the change (SQLite has no ``ADD COLUMN IF NOT EXISTS``), so ``_migrate_step``
# checks the column set first.
_ADDED_COLUMNS: dict[int, list[tuple[str, str, str]]] = {
    # (table, column, definition)
    2: [("sections", "title_dirty", "INTEGER NOT NULL DEFAULT 0")],
    4: [
        ("bots", "dream_enabled", "INTEGER NOT NULL DEFAULT 1"),
        ("bots", "tools_json", "TEXT NOT NULL DEFAULT '[]'"),
        ("bots", "skills_json", "TEXT NOT NULL DEFAULT '[]'"),
    ],
    5: [
        ("bots", "shareable", "INTEGER NOT NULL DEFAULT 0"),
        ("pairing_codes", "user_id", "TEXT NOT NULL DEFAULT 'local'"),
        ("dreams", "owner_id", "TEXT NOT NULL DEFAULT 'local'"),
    ],
    6: [
        ("bots", "notify", "INTEGER NOT NULL DEFAULT 1"),
        ("bots", "approval_mode", "TEXT NOT NULL DEFAULT 'inherit'"),
        ("bots", "workdir", "TEXT"),
    ],
    7: [("sections", "done_at", "REAL")],
}

_MIGRATION_DDL: dict[int, str] = {
    3: """
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
CREATE INDEX IF NOT EXISTS idx_room_events_room_seq ON room_events(room_id,seq);
CREATE INDEX IF NOT EXISTS idx_room_turns_room_trigger ON room_turns(room_id,trigger_seq);
CREATE INDEX IF NOT EXISTS idx_bot_messages_pair ON bot_messages(from_bot,to_bot,created_at);
""",
    4: """
CREATE TABLE IF NOT EXISTS dreams(
 id TEXT PRIMARY KEY, bot TEXT NOT NULL, room_id TEXT, started_at REAL NOT NULL,
 finished_at REAL, status TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS room_memory(
 room_id TEXT PRIMARY KEY, text TEXT NOT NULL DEFAULT '', updated_at REAL NOT NULL,
 FOREIGN KEY(room_id) REFERENCES rooms(id) ON DELETE CASCADE);
CREATE INDEX IF NOT EXISTS idx_dreams_bot_started ON dreams(bot,started_at DESC);
""",
    5: """
CREATE TABLE IF NOT EXISTS users(
 id TEXT PRIMARY KEY, display_name TEXT NOT NULL, role TEXT NOT NULL
 CHECK(role IN ('admin','member')), limits_json TEXT NOT NULL DEFAULT '{}',
 created_at REAL NOT NULL, disabled_at REAL);
CREATE INDEX IF NOT EXISTS idx_devices_owner ON devices(owner_id);
CREATE INDEX IF NOT EXISTS idx_bots_owner ON bots(owner_id);
CREATE INDEX IF NOT EXISTS idx_sections_owner ON sections(owner_id);
CREATE INDEX IF NOT EXISTS idx_rooms_owner ON rooms(owner_id);
""",
    6: """
CREATE TABLE IF NOT EXISTS bot_incidents(
 id TEXT PRIMARY KEY, bot TEXT NOT NULL, section_id TEXT, room_id TEXT, session_id TEXT,
 kind TEXT NOT NULL CHECK(kind IN ('connector_error','turn_failed')), connector TEXT,
 text TEXT NOT NULL DEFAULT '', created_at REAL NOT NULL, resolved_at REAL);
CREATE INDEX IF NOT EXISTS idx_bot_incidents_bot_open ON bot_incidents(bot,resolved_at);
""",
    # v8: core memory became the per-user About you file; memory provenance
    # tagging went away with the purge-on-delete promise.
    8: """
DROP TABLE IF EXISTS core_memory;
DROP TABLE IF EXISTS memory_entries;
""",
}


def connect() -> sqlite3.Connection:
    """Open a connection to the Hexbot database.

    Callers are responsible for closing it; prefer :func:`transaction`.
    """
    conn = sqlite3.connect(ensure_layout() / DATABASE_NAME)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


@contextmanager
def transaction() -> Iterator[sqlite3.Connection]:
    """Open a connection, commit on success, roll back on error, always close."""
    conn = connect()
    try:
        with conn:
            yield conn
    finally:
        conn.close()


def _columns(conn: sqlite3.Connection, table: str) -> set[str]:
    return {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}


def migrate() -> None:
    """Create or upgrade the schema. Safe to call repeatedly."""
    with transaction() as conn:
        conn.executescript(_DDL)
        row = conn.execute("SELECT version FROM schema_version LIMIT 1").fetchone()
        current = int(row[0]) if row is not None else 0
        for version in range(max(current, 1) + 1, SCHEMA_VERSION + 1):
            if version in _MIGRATION_DDL:
                conn.executescript(_MIGRATION_DDL[version])
            for table, column, definition in _ADDED_COLUMNS.get(version, []):
                if column not in _columns(conn, table):
                    conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")
                    logger.info("hexbot db: added %s.%s (schema v%d)", table, column, version)
        # A brand-new database gets every column from ``_ADDED_COLUMNS`` too:
        # ``_DDL`` deliberately keeps the v1 shape so the upgrade path is the
        # only place a column is defined.
        for statements in _ADDED_COLUMNS.values():
            for table, column, definition in statements:
                if column not in _columns(conn, table):
                    conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")
        # New databases and databases whose version row got ahead of their
        # physical schema still receive every idempotent table migration.
        for ddl in _MIGRATION_DDL.values():
            conn.executescript(ddl)
        import time
        conn.execute(
            "INSERT OR IGNORE INTO users(id,display_name,role,limits_json,created_at) "
            "VALUES ('local','Admin','admin','{}',?)", (time.time(),))
        if row is None:
            conn.execute("INSERT INTO schema_version(version) VALUES (?)", (SCHEMA_VERSION,))
        elif current != SCHEMA_VERSION:
            conn.execute("UPDATE schema_version SET version=?", (SCHEMA_VERSION,))
