"""Database, settings and memory: the parts that own state on disk."""

import sqlite3
from types import MappingProxyType

import pytest
from ruamel.yaml import YAML


def _tables(conn):
    return {row[0] for row in conn.execute(
        "select name from sqlite_master where type='table'")}


def test_migration_is_idempotent():
    from hexbot import db

    db.migrate()
    db.migrate()
    db.migrate()
    with db.transaction() as conn:
        versions = conn.execute("select version from schema_version").fetchall()
        assert [row[0] for row in versions] == [db.SCHEMA_VERSION]
        assert {"bots", "sections", "devices", "pairing_codes", "settings"} <= _tables(conn)


def test_migration_upgrades_a_v1_database(isolated_home):
    """A database created before schema v2 gains the new column in place."""
    from hexbot import db

    path = isolated_home / "hexbot.db"
    legacy = sqlite3.connect(path)
    legacy.executescript(db._DDL)
    legacy.execute("insert into schema_version(version) values (1)")
    legacy.execute("insert into sections(id,bot,title) values ('s1','scout','Kept')")
    legacy.commit()
    legacy.close()

    db.migrate()
    db.migrate()
    with db.transaction() as conn:
        assert conn.execute("select version from schema_version").fetchone()[0] == db.SCHEMA_VERSION
        row = conn.execute("select title, title_dirty from sections where id='s1'").fetchone()
        assert {"notify", "approval_mode", "workdir"} <= db._columns(conn, "bots")
        assert "bot_incidents" in {
            r[0] for r in conn.execute("select name from sqlite_master where type='table'")}
    assert row["title"] == "Kept"
    assert row["title_dirty"] == 0


def test_settings_defaults_and_whitelist():
    from hexbot.errors import HexbotError
    from hexbot.settings import get_settings, update_settings

    defaults = get_settings()
    assert defaults["approval_mode"] == "manual"
    assert defaults["auto_approver_model"] is None
    assert defaults["lan_enabled"] is False
    assert defaults["billing_notice_ack"] is False

    with pytest.raises(HexbotError) as caught:
        update_settings({"nope": 1})
    assert caught.value.code == 4201

    with pytest.raises(HexbotError) as caught:
        update_settings({"approval_mode": "yolo"})
    assert caught.value.code == 4202

    assert update_settings({"billing_notice_ack": True})["billing_notice_ack"] is True
    # A rejected patch must not have been written.
    assert get_settings()["approval_mode"] == "manual"


def test_mirror_preserves_unrelated_yaml(tmp_path):
    from hexbot.settings import mirror_deployment_config, update_settings

    update_settings({"approval_mode": "smart", "auto_approver_model": "openai/gpt-5",
                     "workspace_dir": str(tmp_path / "work")})
    profile = tmp_path / "profiles" / "one"
    profile.mkdir(parents=True)
    (profile / "config.yaml").write_text(
        "# keep me\n"
        "unrelated:\n  keep: true\n"
        "approvals:\n  timeout: 42\n"
        "model:\n  default: anthropic/claude-opus-5\n")
    mirror_deployment_config(profile)

    text = (profile / "config.yaml").read_text()
    data = YAML(typ="safe").load(text)
    assert data["unrelated"]["keep"] is True
    assert data["model"]["default"] == "anthropic/claude-opus-5"
    assert data["approvals"] == {"timeout": 42, "mode": "smart"}
    assert data["auxiliary"]["approval"] == {"provider": "openai", "model": "gpt-5"}
    assert data["terminal"]["cwd"] == str(tmp_path / "work")
    assert (tmp_path / "work").is_dir()
    # Sections get the gateway's default platform (tui), rooms hexbot_room;
    # the hint must land in the prompt for both.
    from agent.system_prompt import _resolve_platform_hint
    from types import SimpleNamespace
    agent = SimpleNamespace(_platform_hint_overrides=data["platform_hints"])
    for platform in ("tui", "hexbot_room"):
        hint = _resolve_platform_hint(agent, platform, "terminal default")
        assert hint.startswith("You are chatting in Hexbot"), platform
        assert "terminal" not in hint
    assert "cli" not in data["platform_hints"]
    assert data["memory"]["user_profile_enabled"] is False
    assert "# keep me" in text


def test_apply_settings_everywhere_touches_root_and_profiles(isolated_home):
    from hexbot.settings import apply_settings_everywhere, update_settings

    for name in ("one", "two"):
        (isolated_home / "profiles" / name).mkdir(parents=True)
    update_settings({"approval_mode": "off"})
    apply_settings_everywhere()

    loader = YAML(typ="safe")
    for path in (isolated_home, isolated_home / "profiles/one", isolated_home / "profiles/two"):
        assert loader.load((path / "config.yaml").read_text())["approvals"]["mode"] == "off"


def test_about_you_round_trip_and_cap(isolated_home):
    from hexbot.errors import HexbotError
    from hexbot.memory import USER_CAP, get_user_memory, set_user_memory

    assert get_user_memory() == {"text": "", "cap": USER_CAP, "updated_at": None}

    result = set_user_memory("Name: Alex")
    assert result["text"] == "Name: Alex"
    assert result["updated_at"] is not None
    assert (isolated_home / "users" / "local" / "user.md").read_text() == "Name: Alex"

    with pytest.raises(HexbotError) as caught:
        set_user_memory("x" * (USER_CAP + 1))
    assert caught.value.code == 4221
    assert str(USER_CAP) in caught.value.message
    # Exactly at the cap is allowed.
    assert len(set_user_memory("y" * USER_CAP)["text"]) == USER_CAP


def test_about_you_renders_as_one_prompt_block(isolated_home):
    from hermes_cli.plugins import is_valid_system_prompt_section_id

    from hexbot.memory import PROMPT_SECTION_ID, render_user_memory, set_user_memory

    from hexbot import db
    db.migrate()
    with db.transaction() as conn:
        conn.execute("INSERT INTO bots(name,created_at,updated_at,last_activity_at) "
                     "VALUES ('scout',0,0,0)")
    assert is_valid_system_prompt_section_id(PROMPT_SECTION_ID)
    assert render_user_memory() == ""
    assert render_user_memory({"session_id": "unknown", "profile_name": "scout"}) == ""

    set_user_memory("Name: Alex")
    block = render_user_memory({"session_id": "unknown", "profile_name": "scout"})
    assert block.startswith("About you")
    assert "Name: Alex" in block
    # Hexbot passes a read-only mapping proxy, not a dict, when it renders
    # plugin sections; the block must survive that.
    assert render_user_memory(MappingProxyType(
        {"session_id": "unknown", "profile_name": "scout"})) == block
    # A session on no bot of ours gets nothing.
    assert render_user_memory({"session_id": "unknown", "profile_name": "default"}) == ""


def test_bot_memory_round_trip_and_cap(isolated_home):
    from hexbot.errors import HexbotError
    from hexbot.memory import get_bot_memory, set_bot_memory

    assert get_bot_memory("scout") == {"memory_md": "", "cap": 2200}

    result = set_bot_memory("scout", "a\n§\nb")
    assert result["memory_md"] == "a\n§\nb"
    memories = isolated_home / "profiles" / "scout" / "memories"
    assert (memories / "MEMORY.md").read_text() == "a\n§\nb"
    assert not (memories / "USER.md").exists()

    with pytest.raises(HexbotError) as caught:
        set_bot_memory("scout", "x" * 2201)
    assert caught.value.code == 4221
    assert get_bot_memory("scout")["memory_md"] == "a\n§\nb"


def test_v8_folds_old_core_memory_into_about_you(isolated_home):
    from hexbot import db
    from hexbot.memory import get_user_memory

    db.migrate()
    with db.transaction() as conn:
        conn.executescript("""
CREATE TABLE core_memory(owner_id TEXT NOT NULL DEFAULT 'local', section TEXT NOT NULL,
 text TEXT NOT NULL DEFAULT '', updated_at REAL, PRIMARY KEY(owner_id, section));
INSERT INTO core_memory VALUES ('local','user','Name: Alex',1), ('local','rules','',1),
 ('local','workspace','Repo: /srv/hexbot',1), ('u2','user','Name: Bea',1);
UPDATE schema_version SET version=7;
""")
    db.migrate()

    assert get_user_memory(owner_id="local", _trusted=True)["text"] == (
        "## User\nName: Alex\n\n## Workspace\nRepo: /srv/hexbot")
    assert (isolated_home / "users" / "u2" / "user.md").read_text() == "## User\nName: Bea"
    with db.transaction() as conn:
        assert not conn.execute("SELECT 1 FROM sqlite_master WHERE name='core_memory'").fetchone()

    # A second run finds no table and leaves the files alone.
    (isolated_home / "users" / "local" / "user.md").write_text("edited")
    db.migrate()
    assert get_user_memory(owner_id="local", _trusted=True)["text"] == "edited"


def test_about_you_follows_the_bots_owner_outside_sections(isolated_home):
    """A dream runs on the bot's profile with no section; the owner comes from the bot."""
    from hexbot import db
    from hexbot.memory import render_user_memory, set_user_memory

    db.migrate()
    with db.transaction() as conn:
        conn.execute("INSERT INTO users(id,display_name,role,limits_json,created_at) "
                     "VALUES ('u2','Bea','member','{}',0)")
        conn.execute("INSERT INTO bots(name,owner_id,created_at,updated_at,last_activity_at) "
                     "VALUES ('beabot','u2',0,0,0)")
    set_user_memory("Name: Alex")
    (isolated_home / "users" / "u2").mkdir(parents=True, exist_ok=True)
    (isolated_home / "users" / "u2" / "user.md").write_text("Name: Bea")

    dream = render_user_memory({"session_id": "cron-turn-1", "profile_name": "beabot"})
    assert "Name: Bea" in dream and "Name: Alex" not in dream
    # An unknown profile gets nothing rather than the admin's text.
    assert render_user_memory({"session_id": "cron-turn-2", "profile_name": "ghost"}) == ""
