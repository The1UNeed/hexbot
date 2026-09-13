"""Section lifecycle against a fake gateway.

The invariant under test throughout: stored ids go to ``session.resume`` /
``session.delete`` / ``session.list``, live ids go to ``session.history`` /
``session.title`` / ``session.close``.
"""

import pytest

from hexbot.errors import GatewayError, HexbotError


@pytest.fixture
def gw(fake_gateway):
    """A gateway that hands out live ids ``live1``, ``live2``, ... on demand."""
    state = {"live": 0}

    def create(params):
        state["live"] += 1
        return {"session_id": f"live{state['live']}", "stored_session_id": "stored1",
                "messages": [], "info": {}}

    def resume(params):
        state["live"] += 1
        return {"session_id": f"live{state['live']}",
                "stored_session_id": params["session_id"], "messages": []}

    fake_gateway.responses.update({
        "session.create": create,
        "session.resume": resume,
        "session.history": {"messages": [{"role": "user", "content": "hi"}]},
        "session.list": {"sessions": []},
        "session.active_list": {"sessions": []},
    })
    return fake_gateway


def test_create_section_records_the_stored_id(gw):
    from hexbot import sections

    made = sections.create_section("scout", "General")
    assert made["id"] == "stored1"
    assert made["title"] == "General"
    assert made["live_session_id"] == "live1"
    assert made["archived_at"] is None
    params = gw.params_for("session.create")[0]
    assert params["profile"] == "scout"
    assert params["close_on_disconnect"] is False


def test_create_section_refuses_a_missing_stored_id(fake_gateway):
    from hexbot import sections

    fake_gateway.responses["session.create"] = {"session_id": "live1", "messages": []}
    with pytest.raises(HexbotError) as caught:
        sections.create_section("scout")
    assert caught.value.code == 5201
    assert sections.list_sections("scout") == []


def test_open_section_resumes_the_stored_id_even_when_live(gw):
    """A reload must reattach the caller to the live session, which only
    ``session.resume`` does; a ``session.history`` probe leaves it parked."""
    from hexbot import sections

    sections.create_section("scout", "General")
    gw.responses["session.resume"] = lambda p: {"session_id": "live1", "messages": [{"role": "user", "content": "hi"}]}
    gw.calls.clear()
    opened = sections.open_section("stored1")

    assert len(opened["messages"]) == 1
    assert opened["section"]["live_session_id"] == "live1"
    assert gw.calls == [("session.resume", {"session_id": "stored1", "profile": "scout"})]


def test_open_section_takes_the_new_live_id_after_a_reap(gw):
    from hexbot import sections

    sections.create_section("scout", "General")
    gw.calls.clear()
    opened = sections.open_section("stored1")

    assert opened["section"]["live_session_id"] == "live2"
    assert gw.methods() == ["session.resume"]
    assert sections.live_id("stored1") == "live2"


def test_open_section_propagates_other_gateway_errors(gw):
    from hexbot import sections

    sections.create_section("scout", "General")

    def broken(_params):
        raise GatewayError(5007, "database unavailable")

    gw.responses["session.resume"] = broken
    with pytest.raises(GatewayError) as caught:
        sections.open_section("stored1")
    assert caught.value.code == 5007


def test_rename_a_live_section_uses_the_live_id(gw):
    from hexbot import db, sections

    sections.create_section("scout", "General")
    gw.calls.clear()
    renamed = sections.rename_section("stored1", "Renamed")

    assert renamed["title"] == "Renamed"
    # The regression: session.title must never see the stored id.
    assert gw.params_for("session.title") == [{"session_id": "live1", "title": "Renamed"}]
    with db.transaction() as conn:
        assert conn.execute(
            "select title_dirty from sections where id='stored1'").fetchone()[0] == 0


def test_rename_a_closed_section_defers_the_hermes_rename(gw):
    from hexbot import db, sections

    sections.create_section("scout", "General")
    sections.close_section("stored1")
    gw.calls.clear()

    renamed = sections.rename_section("stored1", "Offline rename")
    assert renamed["title"] == "Offline rename"
    assert renamed["live_session_id"] is None
    assert "session.title" not in gw.methods()
    with db.transaction() as conn:
        assert conn.execute(
            "select title_dirty from sections where id='stored1'").fetchone()[0] == 1

    # Opening the section resumes it and flushes the pending rename.
    gw.calls.clear()
    sections.open_section("stored1")
    assert gw.params_for("session.title") == [
        {"session_id": "live2", "title": "Offline rename"}]
    with db.transaction() as conn:
        assert conn.execute(
            "select title_dirty from sections where id='stored1'").fetchone()[0] == 0

    # A second open must not re-push the title.
    gw.calls.clear()
    sections.open_section("stored1")
    assert "session.title" not in gw.methods()


def test_rename_falls_back_when_hermes_reports_4001(gw):
    from hexbot import db, sections

    sections.create_section("scout", "General")

    def dead(_params):
        raise GatewayError(4001, "session not found")

    gw.responses["session.title"] = dead
    renamed = sections.rename_section("stored1", "Renamed")

    assert renamed["title"] == "Renamed"
    assert renamed["live_session_id"] is None  # the stale live id was dropped
    with db.transaction() as conn:
        assert conn.execute(
            "select title_dirty from sections where id='stored1'").fetchone()[0] == 1


def test_rename_requires_a_title(gw):
    from hexbot import sections

    sections.create_section("scout", "General")
    with pytest.raises(HexbotError) as caught:
        sections.rename_section("stored1", "   ")
    assert caught.value.code == 4200


def test_archive_round_trip_and_listing(gw):
    from hexbot import sections

    sections.create_section("scout", "General")
    assert sections.archive_section("stored1")["archived_at"] is not None
    assert sections.list_sections("scout") == []
    assert len(sections.list_sections("scout", include_archived=True)) == 1
    # Archiving keeps the section in memory: no session.delete.
    assert "session.delete" not in gw.methods()
    assert sections.unarchive_section("stored1")["archived_at"] is None
    assert len(sections.list_sections("scout")) == 1


def test_delete_section_closes_then_deletes(gw):
    from hexbot import sections

    sections.create_section("scout", "General")
    gw.calls.clear()
    assert sections.delete_section("stored1") is True

    assert gw.methods() == ["session.close", "session.delete"]
    assert gw.params_for("session.close")[0] == {"session_id": "live1"}
    assert gw.params_for("session.delete")[0] == {"session_id": "stored1", "profile": "scout"}
    assert sections.live_id("stored1") is None
    with pytest.raises(HexbotError) as caught:
        sections.open_section("stored1")
    assert caught.value.code == 4204


def test_delete_section_can_keep_the_transcript(gw):
    from hexbot import sections

    sections.create_section("scout", "General")
    gw.calls.clear()
    sections.delete_section("stored1", purge_memory=False)
    assert gw.methods() == ["session.close"]


def test_unknown_section_is_4204(gw):
    from hexbot import sections

    for call in (sections.open_section, sections.archive_section,
                 sections.touch_section, sections.delete_section):
        with pytest.raises(HexbotError) as caught:
            call("nope")
        assert caught.value.code == 4204


def test_touch_stamps_the_section_and_its_bot(gw):
    from hexbot import db, sections

    db.migrate()
    with db.transaction() as conn:
        conn.execute("INSERT INTO bots(name,last_activity_at) VALUES ('scout', 0)")
    sections.create_section("scout", "General")
    with db.transaction() as conn:
        conn.execute("UPDATE sections SET updated_at=0 WHERE id='stored1'")
        conn.execute("UPDATE bots SET last_activity_at=0 WHERE name='scout'")

    assert sections.touch_section("stored1")["updated_at"] > 0
    with db.transaction() as conn:
        assert conn.execute(
            "select last_activity_at from bots where name='scout'").fetchone()[0] > 0


def test_section_for_session_accepts_either_id(gw):
    from hexbot import sections

    sections.create_section("scout", "General")
    assert sections.section_for_session("stored1")["id"] == "stored1"
    assert sections.section_for_session("live1")["id"] == "stored1"
    assert sections.section_for_session("nothing") is None


def test_live_statuses_reads_active_list(gw):
    from hexbot import sections

    gw.responses["session.active_list"] = {"sessions": [
        {"id": "live1", "session_key": "stored1", "status": "working"},
        {"id": "live9", "session_key": "stored9", "status": "idle"},
        {"id": "live8", "status": "idle"},
    ]}
    assert sections.live_statuses() == {"stored1": "working", "stored9": "idle"}


def test_live_statuses_survives_an_unavailable_gateway(fake_gateway):
    from hexbot import sections

    def boom(_params):
        raise GatewayError(-32601, "unknown method")

    fake_gateway.responses["session.active_list"] = boom
    assert sections.live_statuses() == {}


def test_delete_section_tolerates_a_never_messaged_session(gw):
    """An empty section has no stored Hermes session; deleting it must still work."""
    from hexbot import sections

    sections.create_section("scout", "New section")

    def missing(_params):
        raise GatewayError(4007, "session not found")

    gw.responses["session.delete"] = missing
    gw.responses["session.close"] = {"status": "closed"}
    assert sections.delete_section("stored1") is True
    assert sections.list_sections("scout") == []
