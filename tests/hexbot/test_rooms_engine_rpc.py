def _history_sequence():
    count = {"n": 0}
    def history(_params):
        count["n"] += 1
        return {"messages": [] if count["n"] < 3 else [{"role": "assistant", "content": "done"}]}
    return history


def test_room_turn_uses_hidden_plumbing_and_appends_reply(fake_gateway):
    from hexbot.rooms import store
    from hexbot.rooms.engine import CompletionWatcher, InlineExecutor, RoomEngine
    fake_gateway.responses.update({
        "session.create": {"session_id": "live", "stored_session_id": "stored"},
        "session.history": _history_sequence(), "prompt.submit": {"status": "streaming"}})
    room = store.create("R", ["scout"], "scout")
    event = store.append_event(room["id"], "message.user", "human", "local", {"text": "hello"})
    engine = RoomEngine(executor=InlineExecutor(),
                        watcher=CompletionWatcher(sleep=lambda _: None, interval=0), start_thread=False)
    engine.run_pending()
    create = fake_gateway.params_for("session.create")[0]
    assert create["room_plumbing"] and create["follow_profile_config"]
    assert create["close_on_disconnect"] is False
    assert any(e["kind"] == "message.bot" and e["payload"]["text"] == "done"
               for e in store.log(room["id"], event["seq"]))
    assert [name for name, _ in fake_gateway.events].count("hexbot.rooms.turn") == 2


def test_turn_limit_trips_and_next_human_wakes(fake_gateway):
    from hexbot.rooms import store
    from hexbot.rooms.engine import InlineExecutor, RoomEngine
    room = store.create("R", ["scout"], "scout", {"room_bot_turns_per_human_turn": 0})
    store.append_event(room["id"], "message.user", "human", "local", {"text": "hello"})
    engine = RoomEngine(executor=InlineExecutor(), start_thread=False)
    engine.run_pending()
    assert store.log(room["id"], 0)[-1]["kind"] == "limit.tripped"
    assert room["id"] in engine._stopped
    engine.notify(room["id"])
    assert room["id"] not in engine._stopped


def test_fanout_finishes_before_main_bot_collects(fake_gateway):
    import time
    import uuid
    from hexbot import db
    from hexbot.rooms import store
    from hexbot.rooms.engine import InlineExecutor, RoomEngine

    order = []
    class RecordingEngine(RoomEngine):
        def _run_turn(self, room, bot, event, collecting, limit_checked=False):
            order.append((bot, bool(collecting)))
            text = ("@writer @critic please answer" if bot == "scout" and not collecting
                    else "collected" if collecting else f"{bot} reply")
            with db.transaction() as conn:
                conn.execute("INSERT INTO room_turns VALUES (?,?,?,?,?,?,?,0,0,0)",
                             (uuid.uuid4().hex, room["id"], bot, event["seq"],
                              time.time(), time.time(), "complete"))
            store.append_event(room["id"], "message.bot", "bot", bot, {"text": text})
            return text

    room = store.create("R", ["scout", "writer", "critic"], "scout")
    store.append_event(room["id"], "message.user", "human", "local", {"text": "begin"})
    engine = RecordingEngine(executor=InlineExecutor(), start_thread=False)
    engine.run_pending()
    assert order[0] == ("scout", False)
    assert set(order[1:3]) == {("writer", False), ("critic", False)}
    assert order[3] == ("scout", True)


def test_rooms_rpc_frames(fake_gateway, monkeypatch):
    from hexbot.rooms.engine import InlineExecutor, RoomEngine, set_engine
    from hexbot.plugin import register
    from test_rpc import RecordingCtx, call
    engine = RoomEngine(executor=InlineExecutor(), start_thread=False)
    set_engine(engine)
    ctx = RecordingCtx(); register(ctx)
    made = call(ctx, "hexbot.rooms.create", {"name": "R", "members": ["scout"], "main_bot": "scout"})
    room_id = made["result"]["room"]["id"]
    sent = call(ctx, "hexbot.rooms.send", {"id": room_id, "text": "hi"})
    assert sent["result"]["event"]["kind"] == "message.user"
    assert room_id in engine._pending
    logged = call(ctx, "hexbot.rooms.log", {"id": room_id, "after_seq": 0})
    assert logged["result"]["events"]
