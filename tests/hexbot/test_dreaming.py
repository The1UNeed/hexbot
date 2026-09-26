import json
import time

import pytest


def _bot_row(name="scout", **values):
    from hexbot import db
    db.migrate()
    now = time.time()
    with db.transaction() as conn:
        conn.execute(
            "INSERT INTO bots(name,display_name,created_at,updated_at,last_activity_at,"
            "dream_enabled) VALUES (?,?,?,?,?,?)",
            (name, name.title(), now, now, now, values.get("dream_enabled", 1)))


def test_ensure_dream_job_creates_and_updates_profile_store(isolated_home, monkeypatch):
    from cron import list_jobs
    from cron.jobs import use_cron_store
    from hexbot.dreaming import ensure_dream_job
    from hexbot.settings import update_settings

    _bot_row()
    profile = isolated_home / "profiles" / "scout"
    profile.mkdir(parents=True)
    monkeypatch.setattr("hexbot.bots._profile_details", lambda name: {})
    monkeypatch.setattr("hexbot.bots.sections.list_sections", lambda *a, **k: [])
    monkeypatch.setattr("hexbot.bots._avatar", lambda name: None)
    first = ensure_dream_job("scout")
    with use_cron_store(profile):
        assert len(list_jobs(include_disabled=True)) == 1
    assert first["name"] == "hexbot-dream"
    assert first["schedule"]["expr"] == "0 3 * * *"

    update_settings({"dream_time": "04:15"})
    second = ensure_dream_job("scout")
    assert second["id"] == first["id"]
    assert second["schedule"]["expr"] == "15 4 * * *"


def test_build_digest_uses_time_window_and_caps(isolated_home, monkeypatch):
    from hermes_state import SessionDB
    from hexbot import db
    from hexbot.dreaming import SECTION_CAP, build_digest

    _bot_row()
    now = time.time()
    with db.transaction() as conn:
        conn.execute("INSERT INTO sections(id,bot,title,created_at,updated_at) VALUES (?,?,?,?,?)",
                     ("section-1", "scout", "General", now, now))
    profile = isolated_home / "profiles" / "scout"
    profile.mkdir(parents=True)
    store = SessionDB(db_path=profile / "state.db")
    store.create_session("section-1", "cli")
    store.append_message("section-1", "user", "old", timestamp=1)
    store.append_message("section-1", "user", "a" * (SECTION_CAP + 100), timestamp=now)
    store.append_message("section-1", "assistant", "recent answer", timestamp=now + 1)
    store.close()
    monkeypatch.setattr("hexbot.bots._profile_details", lambda name: {})
    monkeypatch.setattr("hexbot.bots._avatar", lambda name: None)

    digest = build_digest("scout", now - 1)
    transcript = digest["sections"][0]["transcript"]
    assert len(transcript) == SECTION_CAP
    assert transcript.startswith("[earlier messages omitted]")
    assert "old" not in transcript
    assert "recent answer" in transcript


def test_record_dream_posts_a_bot_message_without_a_turn(isolated_home, monkeypatch):
    from hermes_state import SessionDB
    from hexbot import db
    from hexbot.dreaming import record_dream

    _bot_row()
    now = time.time()
    with db.transaction() as conn:
        conn.execute("INSERT INTO sections(id,bot,title,created_at,updated_at) VALUES (?,?,?,?,?)",
                     ("dreams-1", "scout", "Dreams", now, now))
    profile = isolated_home / "profiles" / "scout"
    profile.mkdir(parents=True)
    # No stored Hexbot session: a section that never had a prompt has none.
    calls = []

    def gateway_call(method, params=None):
        calls.append(method)
        return {"sessions": []}

    monkeypatch.setattr("hexbot.sections.gateway.call", gateway_call)

    record_dream("scout", "Kept two notes.")

    store = SessionDB(db_path=profile / "state.db")
    rows = store.get_messages("dreams-1")
    store.close()
    assert [(row["role"], row["content"]) for row in rows] == [("assistant", "Kept two notes.")]
    # A prompt would make the bot answer its own dream, and resume the section.
    assert "prompt.submit" not in calls and "session.resume" not in calls

    # A dream with nothing to report posts nothing.
    assert record_dream("scout", "[SILENT]")["summary"] == ""
    store = SessionDB(db_path=profile / "state.db")
    assert len(store.get_messages("dreams-1")) == 1
    store.close()


def test_dream_snapshots_memory_and_can_restore_it(isolated_home, monkeypatch):
    from hexbot import db
    from hexbot.dreaming import dream_digest, list_dreams, record_dream, restore_dream
    from hexbot.errors import HexbotError
    from hexbot.memory import get_bot_memory, set_bot_memory

    _bot_row()
    monkeypatch.setattr("hexbot.bots._profile_details", lambda name: {})
    monkeypatch.setattr("hexbot.bots.sections.list_sections", lambda *a, **k: [])
    monkeypatch.setattr("hexbot.bots._avatar", lambda name: None)
    monkeypatch.setattr("hexbot.sections.gateway.call", lambda *a, **k: {"sessions": []})
    set_bot_memory("scout", "User likes tea")

    digest = json.loads(dream_digest({"bot": "scout"}, session_id="cron-1"))
    # The dream rewrote memory, as its curation pass does.
    set_bot_memory("scout", "User likes tea\n§\nUser works in Auckland")
    record_dream("scout", "[SILENT]", dream_id=digest["dream_id"])

    [dream] = list_dreams("scout")["dreams"]
    assert dream["memory_before"] == "User likes tea"
    assert dream["memory_after"] == "User likes tea\n§\nUser works in Auckland"

    restored = restore_dream(dream["id"])
    assert restored["memory_md"] == "User likes tea"
    assert get_bot_memory("scout")["memory_md"] == "User likes tea"
    # The restore is a dream of its own, so it shows in the log and can be undone.
    log = list_dreams("scout")["dreams"]
    assert [entry["id"] for entry in log] == [restored["dream_id"], dream["id"]]
    assert log[0]["summary"].startswith("Restored the memory from before the dream of")
    assert log[0]["memory_before"] == "User likes tea\n§\nUser works in Auckland"
    assert log[0]["memory_after"] == "User likes tea"
    assert restore_dream(restored["dream_id"])["memory_md"] == log[0]["memory_before"]

    with pytest.raises(HexbotError) as caught:
        restore_dream("nope")
    assert caught.value.code == 4241
    with db.transaction() as conn:
        conn.execute("UPDATE dreams SET memory_before=NULL WHERE id=?", (dream["id"],))
    with pytest.raises(HexbotError) as caught:
        restore_dream(dream["id"])
    assert caught.value.code == 4242

    # Another user's bot, and a bot that no longer exists, are refused.
    with db.transaction() as conn:
        conn.execute("UPDATE bots SET owner_id='u2' WHERE name='scout'")
    with pytest.raises(HexbotError) as caught:
        restore_dream(restored["dream_id"])
    assert caught.value.code == 4302
    with db.transaction() as conn:
        conn.execute("DELETE FROM bots WHERE name='scout'")
    with pytest.raises(HexbotError) as caught:
        restore_dream(restored["dream_id"])
    assert caught.value.code == 4205


def test_room_memory_is_capped_in_prompt(fake_gateway):
    from hexbot import db
    from hexbot.rooms import prompt, store
    room = store.create("Lab", ["scout"], "scout")
    with db.transaction() as conn:
        conn.execute("INSERT INTO room_memory VALUES (?,?,?)", (room["id"], "m" * 4000, time.time()))
    text = prompt.render(room, "scout", [])
    memory = text.split("Room memory:\n", 1)[1].split("\n\nTranscript", 1)[0]
    assert len(memory) == 3000

