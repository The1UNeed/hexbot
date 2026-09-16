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


def get(room_id: str, *, enforce_owner=True, all_users=False) -> dict:
    from hexbot.identity import current_user_id
    if all_users:
        from hexbot.identity import require_admin
        require_admin()
        enforce_owner = False
    db.migrate()
    with db.transaction() as conn:
        row = conn.execute("SELECT * FROM rooms WHERE id=?", (room_id,)).fetchone()
        members = conn.execute(
            "SELECT * FROM room_members WHERE room_id=? ORDER BY added_at,member_id",
            (room_id,)).fetchall() if row else []
    if row is None:
        raise HexbotError(4230, f"room not found: {room_id}")
    if enforce_owner and row["owner_id"] != current_user_id():
        raise HexbotError(4302, "not the owner")
    result = _room(row)
    result["members"] = [dict(item) for item in members]
    return result


def list_rooms(include_archived=False, *, all_users=False) -> list[dict]:
    from hexbot.identity import owner_filter
    owner = owner_filter(all_users)
    db.migrate()
    clauses, args = [], []
    if not include_archived: clauses.append("archived_at IS NULL")
    if owner is not None: clauses.append("owner_id=?"); args.append(owner)
    sql = "SELECT id FROM rooms" + (" WHERE " + " AND ".join(clauses) if clauses else "")
    sql += " ORDER BY last_activity_at DESC,name"
    with db.transaction() as conn:
        ids = [row[0] for row in conn.execute(sql, args)]
    return [get(room_id, enforce_owner=False) for room_id in ids]


def create(name: str, members=(), main_bot=None, limits=None, approval_mode=None,
           owner_id=None, humans=()) -> dict:
    from hexbot.identity import current_user_id
    owner_id = owner_id or current_user_id()
    db.migrate()
    name = str(name or "").strip()
    if not name:
        raise HexbotError(4200, "missing parameter: name")
    room_id, now = uuid.uuid4().hex, time.time()
    requested = list(dict.fromkeys(str(x) for x in members))
    humans = list(dict.fromkeys(str(x) for x in (humans or ())))
    bots: list[str] = []
    with db.transaction() as conn:
        for member in requested:
            row = conn.execute("SELECT owner_id,shareable FROM bots WHERE name=?", (member,)).fetchone()
            if row is None:
                # Not a registered bot. A user id names a human member (the
                # client sends both kinds in one list); anything else is kept
                # as a bot name for callers that create profiles out of band.
                user = conn.execute("SELECT id FROM users WHERE id=? AND disabled_at IS NULL", (member,)).fetchone()
                if user is not None:
                    if member not in humans:
                        humans.append(member)
                    continue
                bots.append(member)
                continue
            if row["owner_id"] != owner_id and not row["shareable"]:
                raise HexbotError(4302, "not the owner")
            bots.append(member)
    if main_bot and main_bot not in bots:
        raise HexbotError(4231, "main_bot must be a room member")
    with db.transaction() as conn:
        conn.execute("INSERT INTO rooms VALUES (?,?,?,?,?,?,?,?,?,NULL)",
                     (room_id, name, owner_id, main_bot, approval_mode,
                      json.dumps(limits or {}), now, now, now))
        conn.execute("INSERT INTO room_members VALUES (?,?,?,?,?,NULL,0)",
                     (room_id, "human", owner_id, owner_id, now))
        for user in humans:
            if user != owner_id:
                conn.execute("INSERT INTO room_members VALUES (?,?,?,?,?,NULL,0)",
                             (room_id, "human", user, owner_id, now))
        for bot in bots:
            conn.execute("INSERT INTO room_members VALUES (?,?,?,?,?,NULL,0)",
                         (room_id, "bot", bot, owner_id, now))
    for user in humans:
        if user != owner_id:
            append_event(room_id, "member.added", "human", owner_id, {"user": user})
    for bot in bots:
        append_event(room_id, "member.added", "human", owner_id, {"bot": bot})
    result = get(room_id, enforce_owner=False)
    if main_bot:
        try:
            from hexbot.dreaming import ensure_room_dream_job
            ensure_room_dream_job(result)
        except Exception:
            pass
    return result


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
    result = get(room_id)
    if "main_bot" in patch and result.get("main_bot"):
        try:
            from hexbot.dreaming import ensure_room_dream_job
            ensure_room_dream_job(result)
        except Exception:
            pass
    return result


def add_member(room_id: str, bot: str, added_by=None) -> dict:
    from hexbot.identity import current_user_id
    added_by = added_by or current_user_id()
    get(room_id); now = time.time()
    with db.transaction() as conn:
        bot_row = conn.execute("SELECT owner_id,shareable FROM bots WHERE name=?", (bot,)).fetchone()
    if bot_row is not None and bot_row["owner_id"] != added_by and not bot_row["shareable"]:
        raise HexbotError(4302, "not the owner")
    with db.transaction() as conn:
        conn.execute("INSERT INTO room_members(room_id,member_kind,member_id,added_by,added_at,left_at,last_read_seq) VALUES (?,?,?,?,?,NULL,0) ON CONFLICT(room_id,member_kind,member_id) DO UPDATE SET left_at=NULL,added_by=excluded.added_by,added_at=excluded.added_at,last_read_seq=0",
                     (room_id, "bot", bot, added_by, now))
    append_event(room_id, "member.added", "human", added_by, {"bot": bot})
    return get(room_id)


def remove_member(room_id: str, bot: str, removed_by=None) -> dict:
    from hexbot.identity import current_user_id
    removed_by = removed_by or current_user_id()
    get(room_id)
    with db.transaction() as conn:
        cur = conn.execute("UPDATE room_members SET left_at=? WHERE room_id=? AND member_kind='bot' AND member_id=? AND left_at IS NULL", (time.time(), room_id, bot))
    if not cur.rowcount:
        raise HexbotError(4232, f"active room member not found: {bot}")
    append_event(room_id, "member.left", "human", removed_by, {"bot": bot})
    room = get(room_id)
    if not any(m["member_kind"] == "bot" and not m["left_at"] for m in room["members"]):
        # A room with no bots is nothing: delete it (never the bot).
        delete(room_id)
        return dict(room, deleted=True)
    if room["main_bot"] == bot:
        room = update(room_id, main_bot=None)
    return room


def append_event(room_id, kind, actor_kind=None, actor_id=None, payload=None, *,
                 enforce_owner=True) -> dict:
    get(room_id, enforce_owner=enforce_owner); now = time.time()
    with db.transaction() as conn:
        conn.execute("INSERT INTO room_events(room_id,seq,kind,actor_kind,actor_id,payload_json,created_at) SELECT ?,COALESCE(MAX(seq),0)+1,?,?,?,?,? FROM room_events WHERE room_id=?",
                     (room_id, kind, actor_kind, actor_id, json.dumps(payload or {}), now, room_id))
        seq = conn.execute("SELECT MAX(seq) FROM room_events WHERE room_id=?", (room_id,)).fetchone()[0]
        conn.execute("UPDATE rooms SET updated_at=?,last_activity_at=? WHERE id=?", (now, now, room_id))
    event = log(room_id, seq - 1, 1, enforce_owner=False)[0]
    from hexbot.gateway import broadcast
    try:
        broadcast("hexbot.rooms.event", {"room_id": room_id, "event": event})
    except Exception:
        # Persistence is authoritative. A room remains usable when no gateway
        # transport is attached yet, as during daemon startup reconciliation.
        pass
    return event


def log(room_id: str, after_seq=0, limit=200, *, enforce_owner=True) -> list[dict]:
    get(room_id, enforce_owner=enforce_owner)
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
    get(room_id)
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
    from hexbot.memory import purge_entries
    purge_entries(room_id=room_id)
    return True


def get_memory(room_id: str) -> str:
    with db.transaction() as conn:
        row = conn.execute("SELECT text FROM room_memory WHERE room_id=?", (room_id,)).fetchone()
    return row[0] if row else ""
