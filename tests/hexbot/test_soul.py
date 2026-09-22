def _rows():
    from hexbot import db
    db.migrate()
    with db.transaction() as conn:
        conn.execute("INSERT INTO bots(name,created_at,updated_at,last_activity_at) "
                     "VALUES ('scout',0,0,0)")
        conn.execute("INSERT INTO sections(id,bot,title,created_at,updated_at) "
                     "VALUES ('s1','scout','General',0,0)")


def test_soul_tool_reads_and_rewrites_the_calling_bot(fake_gateway):
    from hexbot.soul import SOUL_CAP, soul_tool

    _rows()
    fake_gateway.responses["profiles.describe"] = {"soul": "You are Scout."}

    assert soul_tool({"action": "read"}, session_id="s1") == {
        "soul": "You are Scout.", "cap": SOUL_CAP}

    result = soul_tool({"action": "write", "text": "You are Scout, blunt."}, session_id="s1")
    assert result["saved"] is True
    assert "Tell the user" in result["note"]
    assert fake_gateway.params_for("profiles.configure") == [
        {"name": "scout", "soul": "You are Scout, blunt."}]
    assert fake_gateway.events == [("hexbot.bots.changed", {"name": "scout"})]


def test_soul_tool_refuses_bad_input(fake_gateway):
    from hexbot.soul import SOUL_CAP, soul_tool

    _rows()
    assert "identify" in soul_tool({"action": "read"}, session_id="nope")["error"]
    assert "identify" in soul_tool({"action": "read"})["error"]
    assert "required" in soul_tool({"action": "write"}, session_id="s1")["error"]
    assert "cap" in soul_tool({"action": "write", "text": "x" * (SOUL_CAP + 1)},
                              session_id="s1")["error"]
    assert "action" in soul_tool({"action": "delete"}, session_id="s1")["error"]
    assert fake_gateway.params_for("profiles.configure") == []
