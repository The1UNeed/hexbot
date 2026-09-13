def test_message_bot_delivery_and_hop_limit(fake_gateway):
    from hexbot import activity, db
    from hexbot.rooms.engine import CompletionWatcher
    db.migrate()
    with db.transaction() as conn:
        conn.execute("INSERT INTO bots(name,created_at,updated_at,last_activity_at) VALUES ('sender',0,0,0)")
        conn.execute("INSERT INTO bots(name,created_at,updated_at,last_activity_at) VALUES ('target',0,0,0)")
        conn.execute("INSERT INTO sections(id,bot,title,created_at,updated_at) VALUES ('origin','sender','General',0,0)")
    from hexbot.sections import _LIVE
    _LIVE["origin"] = "origin-live"
    history_calls = {"n": 0}
    def history(_params):
        history_calls["n"] += 1
        return {"messages": [] if history_calls["n"] < 2 else
                [{"role": "assistant", "content": "reply"}]}
    fake_gateway.responses.update({
        "session.create": {"session_id": "target-live", "stored_session_id": "target-stored", "messages": []},
        "session.resume": {"session_id": "target-live", "messages": []},
        "session.list": {"sessions": []}, "prompt.submit": {"status": "streaming"},
        "session.history": history})
    watcher = CompletionWatcher(sleep=lambda _: None, interval=0)
    result = activity.message_bot({"to": "target", "text": "question", "wait": True}, session_id="origin", watcher=watcher)
    assert result == {"reply": "reply"}
    assert activity.pairs()[0]["count"] == 1
    activity._HOPS["origin"] = 8
    assert "hop limit" in activity.message_bot({"to": "target", "text": "again"}, session_id="origin")["error"]
