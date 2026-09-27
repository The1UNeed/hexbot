"""The ``hexbot_rename_section`` tool: a bot names the section it is in."""

import json

import pytest


@pytest.fixture
def gw(fake_gateway):
    fake_gateway.responses.update({
        "session.create": {"session_id": "live1", "stored_session_id": "stored1", "messages": []},
        "session.list": {"sessions": []},
    })
    return fake_gateway


def rename_tool(*args, **kwargs):
    """The real handler returns a JSON string, as Hexbot requires."""
    from hexbot.sections import rename_tool as handler
    reply = handler(*args, **kwargs)
    assert isinstance(reply, str)
    return json.loads(reply)


def test_bot_names_its_section_and_the_user_can_take_it_back(gw):
    from hexbot import sections

    sections.create_section("scout")
    gw.calls.clear()

    # Hexbot hands tools the stored key; the live id must work too.
    reply = rename_tool({"title": '"Budget for the Lisbon trip."'}, session_id="live1")
    assert reply == {"renamed": True, "title": "Budget for the Lisbon trip"}
    assert gw.params_for("session.title") == [
        {"session_id": "live1", "title": "Budget for the Lisbon trip"}]
    assert gw.events == [("hexbot.sections.changed", {"id": "stored1", "bot": "scout"})]
    assert sections.list_sections("scout")[0]["title_by"] == "bot"

    # A user rename clears the marker.
    renamed = sections.rename_section("stored1", "Lisbon")
    assert (renamed["title"], renamed["title_by"]) == ("Lisbon", None)


def test_rename_tool_skips_the_owner_check(gw, monkeypatch):
    from hexbot import sections

    sections.create_section("scout")
    monkeypatch.setattr("hexbot.identity.current_user_id", lambda: "device:other")
    assert rename_tool({"title": "Plans"}, session_id="stored1")["renamed"] is True


def test_rename_tool_refuses_bad_input(gw):
    from hexbot import sections
    from hexbot.sections import TITLE_CAP

    sections.create_section("scout")
    assert "section" in rename_tool({"title": "x"}, session_id="nope")["error"]
    assert "section" in rename_tool({"title": "x"})["error"]
    assert "required" in rename_tool({"title": "  "}, session_id="stored1")["error"]
    assert "cap" in rename_tool({"title": "x" * (TITLE_CAP + 1)}, session_id="stored1")["error"]
    assert sections.list_sections("scout")[0]["title"] == "New section"

    from hexbot import db
    with db.transaction() as conn:
        conn.execute("UPDATE sections SET title='Dreams' WHERE id='stored1'")
    assert "Dreams" in rename_tool({"title": "x"}, session_id="stored1")["error"]
    assert gw.events == []
