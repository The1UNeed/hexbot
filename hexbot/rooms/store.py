"""SQLite operations for rooms. Event sequence allocation is transactional."""

from __future__ import annotations

import json
import time
import uuid

from hexbot import db
from hexbot.errors import HexbotError
from .models import Room, RoomEvent


def _room(row) -> dict:
    return Room(row["id"], row["name"], row["owner_id"], row["main_bot"],
                row["approval_mode"], json.loads(row["limits_json"] or "{}"),
                row["created_at"], row["updated_at"], row["last_activity_at"],
                row["archived_at"]).dict()


def _event(row) -> dict:
    return RoomEvent(row["room_id"], row["seq"], row["kind"], row["actor_kind"],
                     row["actor_id"], json.loads(row["payload_json"] or "{}"),
                     row["created_at"]).dict()


def get(room_id: str) -> dict:
    db.migrate()
    with db.transaction() as conn:
        row = conn.execute("SELECT * FROM rooms WHERE id=?", (room_id,)).fetchone()
        members = conn.execute(
            "SELECT * FROM room_members WHERE room_id=? ORDER BY added_at,member_id",
            (room_id,)).fetchall() if row else []
    if row is None:
        raise HexbotError(4230, f"room not found: {room_id}")
    result = _room(row)
    result["members"] = [dict(item) for item in members]
    return result


def list_rooms(include_archived=False) -> list[dict]:
    db.migrate()
    sql = "SELECT id FROM rooms" + ("" if include_archived else " WHERE archived_at IS NULL")
    sql += " ORDER BY last_activity_at DESC,name"
    with db.transaction() as conn:
        ids = [row[0] for row in conn.execute(sql)]
    return [get(room_id) for room_id in ids]


def create(name: str, members=(), main_bot=None, limits=None, approval_mode=None,
           owner_id="local") -> dict:
    db.migrate()
    name = str(name or "").strip()
    if not name:
        raise HexbotError(4200, "missing parameter: name")
    room_id, now = uuid.uuid4().hex, time.time()
    bots = list(dict.fromkeys(str(x) for x in members))
    if main_bot and main_bot not in bots:
        raise HexbotError(4231, "main_bot must be a room member")
    with db.transaction() as conn:
        conn.execute("INSERT INTO rooms VALUES (?,?,?,?,?,?,?,?,?,NULL)",
                     (room_id, name, owner_id, main_bot, approval_mode,
                      json.dumps(limits or {}), now, now, now))
        conn.execute("INSERT INTO room_members VALUES (?,?,?,?,?,NULL,0)",
                     (room_id, "human", owner_id, owner_id, now))
        for bot in bots:
            conn.execute("INSERT INTO room_members VALUES (?,?,?,?,?,NULL,0)",
                         (room_id, "bot", bot, owner_id, now))
    for bot in bots:
        append_event(room_id, "member.added", "human", owner_id, {"bot": bot})
    return get(room_id)


def update(room_id: str, **patch) -> dict:
    get(room_id)
    allowed = {"name", "main_bot", "approval_mode", "limits"}
    if set(patch) - allowed:
        raise HexbotError(4201, f"unknown room field: {sorted(set(patch)-allowed)[0]}")
    if "main_bot" in patch and patch["main_bot"]:
        active = {m["member_id"] for m in get(room_id)["members"] if m["member_kind"] == "bot" and m["left_at"] is None}
        if patch["main_bot"] not in active:
            raise HexbotError(4231, "main_bot must be an active room member")
    values, columns = [], []
    for key, value in patch.items():
        columns.append(("limits_json" if key == "limits" else key) + "=?")
        values.append(json.dumps(value) if key == "limits" else value)
    if columns:
        values += [time.time(), room_id]
        with db.transaction() as conn:
            conn.execute(f"UPDATE rooms SET {','.join(columns)},updated_at=? WHERE id=?", values)
    return get(room_id)


def add_member(room_id: str, bot: str, added_by="local") -> dict:
    get(room_id); now = time.time()
    with db.transaction() as conn:
        conn.execute("INSERT INTO room_members(room_id,member_kind,member_id,added_by,added_at,left_at,last_read_seq) VALUES (?,?,?,?,?,NULL,0) ON CONFLICT(room_id,member_kind,member_id) DO UPDATE SET left_at=NULL,added_by=excluded.added_by,added_at=excluded.added_at,last_read_seq=0",
                     (room_id, "bot", bot, added_by, now))
    append_event(room_id, "member.added", "human", added_by, {"bot": bot})
    return get(room_id)


def remove_member(room_id: str, bot: str, removed_by="local") -> dict:
    with db.transaction() as conn:
        cur = conn.execute("UPDATE room_members SET left_at=? WHERE room_id=? AND member_kind='bot' AND member_id=? AND left_at IS NULL", (time.time(), room_id, bot))
    if not cur.rowcount:
        raise HexbotError(4232, f"active room member not found: {bot}")
    append_event(room_id, "member.left", "human", removed_by, {"bot": bot})
    if get(room_id)["main_bot"] == bot:
        update(room_id, main_bot=None)
    return get(room_id)


def append_event(room_id, kind, actor_kind=None, actor_id=None, payload=None) -> dict:
    get(room_id); now = time.time()
    with db.transaction() as conn:
        conn.execute("INSERT INTO room_events(room_id,seq,kind,actor_kind,actor_id,payload_json,created_at) SELECT ?,COALESCE(MAX(seq),0)+1,?,?,?,?,? FROM room_events WHERE room_id=?",
                     (room_id, kind, actor_kind, actor_id, json.dumps(payload or {}), now, room_id))
        seq = conn.execute("SELECT MAX(seq) FROM room_events WHERE room_id=?", (room_id,)).fetchone()[0]
        conn.execute("UPDATE rooms SET updated_at=?,last_activity_at=? WHERE id=?", (now, now, room_id))
    event = log(room_id, seq - 1, 1)[0]
    from hexbot.gateway import broadcast
    try:
        broadcast("hexbot.rooms.event", {"room_id": room_id, "event": event})
    except Exception:
        # Persistence is authoritative. A room remains usable when no gateway
        # transport is attached yet, as during daemon startup reconciliation.
        pass
    return event


def log(room_id: str, after_seq=0, limit=200) -> list[dict]:
    get(room_id)
    limit = max(1, min(int(limit or 200), 1000))
    with db.transaction() as conn:
        rows = conn.execute("SELECT * FROM room_events WHERE room_id=? AND seq>? ORDER BY seq LIMIT ?", (room_id, int(after_seq or 0), limit)).fetchall()
    return [_event(row) for row in rows]


def mark_read(room_id: str, seq: int, member_kind="human", member_id="local") -> dict:
    get(room_id)
    with db.transaction() as conn:
        conn.execute("UPDATE room_members SET last_read_seq=MAX(last_read_seq,?) WHERE room_id=? AND member_kind=? AND member_id=?", (int(seq), room_id, member_kind, member_id))
    return get(room_id)


def archive(room_id):
    with db.transaction() as conn: conn.execute("UPDATE rooms SET archived_at=?,updated_at=? WHERE id=?", (time.time(), time.time(), room_id))
    return get(room_id)


def delete(room_id):
    get(room_id)
    with db.transaction() as conn:
        sessions = conn.execute("SELECT bot,stored_session_id,live_session_id FROM room_sessions WHERE room_id=?", (room_id,)).fetchall()
    from hexbot import gateway
    for session in sessions:
        try:
            if session["live_session_id"]:
                gateway.call("session.close", {"session_id": session["live_session_id"]})
            gateway.call("session.delete", {"session_id": session["stored_session_id"],
                                             "profile": session["bot"]})
        except Exception:
            # The durable Hexbot row must remain deletable if Hermes already
            # lost or closed its hidden session.
            pass
    with db.transaction() as conn:
        conn.execute("DELETE FROM rooms WHERE id=?", (room_id,))
    return True
