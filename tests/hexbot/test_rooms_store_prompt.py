import json


def test_room_crud_sequence_read_and_departure_rows(fake_gateway):
    from hexbot.rooms import store
    room = store.create("Writers", ["scout", "writer"], "scout", {"room_bot_turns_per_human_turn": 3})
    assert room["main_bot"] == "scout"
    first = store.append_event(room["id"], "message.user", "human", "local", {"text": "hello"})
    second = store.append_event(room["id"], "note", "system", None, {"text": "note"})
    assert second["seq"] == first["seq"] + 1
    assert store.log(room["id"], first["seq"])[0]["kind"] == "note"
    store.mark_read(room["id"], second["seq"], "bot", "writer")
    left = store.remove_member(room["id"], "writer")
    writer = next(m for m in left["members"] if m["member_id"] == "writer")
    assert writer["left_at"] is not None and writer["last_read_seq"] == second["seq"]
    store.add_member(room["id"], "editor")
    editor = next(m for m in store.get(room["id"])["members"] if m["member_id"] == "editor")
    assert editor["last_read_seq"] == 0


def test_prompt_delta_rules_and_caps():
    from hexbot.rooms.prompt import MAX_BYTES, MAX_LINES, render, transcript_lines
    room = {"name": "Lab", "members": [
        {"member_id": "local", "left_at": None},
        {"member_id": "scout", "left_at": None}], "member_titles": {"scout": "Researcher"}}
    events = [{"kind": "message.user", "actor_id": "local", "payload": {"text": str(i) + "x" * 3000}}
              for i in range(80)]
    text = render(room, "scout", events)
    transcript = text.split("Transcript since your last turn:\n", 1)[1].split("\n\nRoom rules:", 1)[0]
    assert len(transcript.splitlines()) <= MAX_LINES
    assert len(transcript.encode()) <= MAX_BYTES
    assert transcript.startswith("[... ")
    assert "Mention @user" in text and "@scout (Researcher)" in text
    assert transcript_lines(events[:1])[0].startswith("User: ")


def test_responder_selection():
    from hexbot.rooms.engine import select_responders
    room = {"main_bot": "scout", "members": [
        {"member_kind": "bot", "member_id": "scout", "left_at": None},
        {"member_kind": "bot", "member_id": "writer", "left_at": None}]}
    event = lambda kind, text: {"kind": kind, "payload": {"text": text}}
    assert select_responders(room, event("message.user", "@writer go"))[0] == ["writer"]
    assert select_responders(room, event("message.user", "go"))[0] == ["scout"]
    room["main_bot"] = None
    assert select_responders(room, event("message.user", "go"))[0] == []
    assert select_responders(room, event("message.bot", "@user which?")) == ([], True)
    assert select_responders(room, event("message.bot", "@writer go"), ["writer"])[0] == []


def test_restart_reconciles_running_turn(fake_gateway):
    from hexbot import db
    from hexbot.rooms import store
    from hexbot.rooms.engine import InlineExecutor, RoomEngine
    room = store.create("R", ["scout"], "scout")
    event = store.append_event(room["id"], "message.user", "human", "local", {"text": "hi"})
    with db.transaction() as conn:
        conn.execute("INSERT INTO room_turns(id,room_id,bot,trigger_seq,started_at,status) VALUES ('t',?,?,?,0,'running')", (room["id"], "scout", event["seq"]))
    engine = RoomEngine(executor=InlineExecutor(), start_thread=False)
    with db.transaction() as conn:
        assert conn.execute("SELECT status FROM room_turns WHERE id='t'").fetchone()[0] == "failed"
    assert room["id"] in engine._pending


def test_create_accepts_human_members_by_user_id(fake_gateway):
    from hexbot import db
    from hexbot.rooms import store
    db.migrate()
    with db.transaction() as conn:
        conn.execute("INSERT INTO bots(name,display_name,title,description,owner_id,created_at,updated_at,last_activity_at) VALUES ('scout','Scout','','','local',1,1,1)")
        conn.execute("INSERT INTO users(id,display_name,role,limits_json,created_at,disabled_at) VALUES ('sam','Sam','member','{}',1,NULL)")
    room = store.create("Plan", ["scout", "sam"], main_bot="scout")
    kinds = {(m["member_kind"], m["member_id"]) for m in room["members"]}
    assert ("bot", "scout") in kinds and ("human", "sam") in kinds and ("human", "local") in kinds


def test_removing_the_last_bot_deletes_the_room(fake_gateway):
    from hexbot.errors import HexbotError
    from hexbot.rooms import store
    import pytest
    room = store.create("Solo", ["scout", "writer"], "scout")
    kept = store.remove_member(room["id"], "writer")
    assert not kept.get("deleted") and kept["main_bot"] == "scout"
    gone = store.remove_member(room["id"], "scout")
    assert gone["deleted"] is True and gone["id"] == room["id"]
    with pytest.raises(HexbotError):
        store.get(room["id"])
    assert not any(item["id"] == room["id"] for item in store.list_rooms(True))


def test_rooms_changed_payload_marks_deleted_rooms():
    from hexbot.rpc import _event_payload
    assert _event_payload({"id": "r1", "bot": "scout"}, {"room": {"id": "r1", "deleted": True}}) == {
        "id": "r1", "deleted": True, "bot": "scout"}
    assert _event_payload({"id": "r1"}, {"deleted": True}) == {"id": "r1", "deleted": True}
    assert "deleted" not in _event_payload({"id": "r1"}, {"room": {"id": "r1"}})
