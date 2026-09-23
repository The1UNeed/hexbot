"""Database, settings and memory: the parts that own state on disk."""

import sqlite3

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
        assert {"bots", "sections", "devices", "pairing_codes",
                "core_memory", "settings"} <= _tables(conn)


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


def test_core_memory_caps_and_sections():
    from hexbot.errors import HexbotError
    from hexbot.memory import CORE_CAP, get_core_memory, set_core_memory

    empty = get_core_memory()
    assert set(empty["sections"]) == {"user", "household", "workspace", "rules"}
    assert empty["caps"]["per_section"] == CORE_CAP
    assert empty["updated_at"] is None

    result = set_core_memory("user", "Name: Alex")
    assert result["sections"]["user"] == "Name: Alex"
    assert result["updated_at"] is not None

    with pytest.raises(HexbotError) as caught:
        set_core_memory("rules", "x" * (CORE_CAP + 1))
    assert caught.value.code == 4221
    assert str(CORE_CAP) in caught.value.message
    # Exactly at the cap is allowed.
    assert len(set_core_memory("rules", "y" * CORE_CAP)["sections"]["rules"]) == CORE_CAP

    with pytest.raises(HexbotError) as caught:
        set_core_memory("nope", "x")
    assert caught.value.code == 4203


def test_core_memory_renders_one_block_per_section():
    from hexbot.memory import (CORE_SECTIONS, core_section_renderer,
                               render_core_memory, render_core_section,
                               section_prompt_id)

    assert render_core_memory() == ""
    assert render_core_section("user") == ""

    from hexbot.memory import set_core_memory
    set_core_memory("user", "Name: Alex")
    set_core_memory("rules", "Never deploy on Friday")

    block = render_core_section("rules")
    assert "Core memory (shared by all bots)" in block
    assert "## Rules" in block
    assert "Never deploy on Friday" in block
    assert "Name: Alex" not in block  # sections do not bleed into each other

    assert core_section_renderer("user")({"session_id": "x"}) == render_core_section("user")

    combined = render_core_memory()
    for text in ("Name: Alex", "Never deploy on Friday", "## User", "## Rules"):
        assert text in combined

    ids = [section_prompt_id(name) for name in CORE_SECTIONS]
    assert ids == ["hexbot.core-memory.user", "hexbot.core-memory.household",
                   "hexbot.core-memory.workspace", "hexbot.core-memory.rules"]


def test_core_memory_prompt_sections_fit_the_registrar():
    """Each section must be registrable at its full cap and render in a stable order."""
    from hermes_cli.plugins import (MAX_SYSTEM_PROMPT_SECTION_CHARS,
                                    is_valid_system_prompt_section_id)

    from hexbot.memory import CORE_CAP, CORE_SECTIONS, section_prompt_id

    assert CORE_CAP <= MAX_SYSTEM_PROMPT_SECTION_CHARS
    ids = [section_prompt_id(name) for name in CORE_SECTIONS]
    assert all(is_valid_system_prompt_section_id(value) for value in ids)
    assert len(set(ids)) == len(ids)
    # Hermes renders sections in sorted() id order — deterministic, not the
    # declaration order.
    assert sorted(ids) == ["hexbot.core-memory.household", "hexbot.core-memory.rules",
                           "hexbot.core-memory.user", "hexbot.core-memory.workspace"]


def test_bot_memory_round_trip_and_caps(isolated_home):
    from hexbot.errors import HexbotError
    from hexbot.memory import get_bot_memory, set_bot_memory

    empty = get_bot_memory("scout")
    assert empty == {"memory_md": "", "user_md": "",
                     "caps": {"memory_md": 2200, "user_md": 1375}}

    result = set_bot_memory("scout", memory_md="a\n§\nb", user_md="Name: Alex")
    assert result["memory_md"] == "a\n§\nb"
    assert result["user_md"] == "Name: Alex"
    memories = isolated_home / "profiles" / "scout" / "memories"
    assert (memories / "MEMORY.md").read_text() == "a\n§\nb"

    # A None value leaves the other file untouched.
    assert set_bot_memory("scout", user_md="Name: Bea")["memory_md"] == "a\n§\nb"

    with pytest.raises(HexbotError) as caught:
        set_bot_memory("scout", user_md="x" * 1376)
    assert caught.value.code == 4221
    assert get_bot_memory("scout")["user_md"] == "Name: Bea"
