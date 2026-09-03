"""In-process bot-to-bot delivery and activity queries."""

from __future__ import annotations

import threading
import time
import uuid

from hexbot import db, gateway, sections, settings
from hexbot.errors import HexbotError
from hexbot.rooms.engine import CompletionWatcher, _usage

HOP_LIMIT = 8
_HOPS: dict[str, int] = {}
_SESSION_ORIGINS: dict[str, str] = {}
_DELIVERY_LOCKS: dict[tuple[str, str], threading.RLock] = {}
_DELIVERY_LOCKS_GUARD = threading.Lock()


def pairs(*, all_users=False):
    from hexbot.identity import owner_filter
    owner = owner_filter(all_users)
    db.migrate()
    with db.transaction() as conn:
        where, args = "", []
        if owner is not None:
            where = (" WHERE (from_bot IN (SELECT name FROM bots WHERE owner_id=?) OR "
                     "to_bot IN (SELECT name FROM bots WHERE owner_id=?))")
            args.extend((owner, owner))
        rows = conn.execute("SELECT from_bot,to_bot,COUNT(*) count,MAX(created_at) last_at "
                            "FROM bot_messages" + where +
                            " GROUP BY from_bot,to_bot ORDER BY last_at DESC", args).fetchall()
    return [dict(row) for row in rows]


def list_messages(from_bot=None, to_bot=None, limit=200, *, all_users=False):
    from hexbot.identity import owner_filter
    owner = owner_filter(all_users)
    db.migrate(); clauses, args = [], []
    if from_bot is not None: clauses.append("from_bot=?"); args.append(from_bot)
    if to_bot is not None: clauses.append("to_bot=?"); args.append(to_bot)
    if owner is not None:
        clauses.append("(from_bot IN (SELECT name FROM bots WHERE owner_id=?) OR "
                       "to_bot IN (SELECT name FROM bots WHERE owner_id=?))")
        args.extend((owner, owner))
    sql = "SELECT * FROM bot_messages" + (" WHERE " + " AND ".join(clauses) if clauses else "")
    sql += " ORDER BY created_at DESC LIMIT ?"; args.append(max(1, min(int(limit or 200), 1000)))
    with db.transaction() as conn: rows = conn.execute(sql, args).fetchall()
    return [dict(row) for row in rows]


def _sender(session_id):
    row = sections.section_for_session(session_id)
    if row is not None: return row["bot"], row["id"]
    with db.transaction() as conn:
        row = conn.execute("SELECT bot,stored_session_id FROM room_sessions WHERE stored_session_id=? OR live_session_id=?", (session_id, session_id)).fetchone()
    if row: return row["bot"], row["stored_session_id"]
    raise HexbotError(4240, "message_bot could not identify the sending bot")


def _target_section(to_bot, from_bot):
    title = f"From {from_bot}"
    db.migrate()
    with db.transaction() as conn:
        row = conn.execute("SELECT id FROM sections WHERE bot=? AND title=? ORDER BY created_at LIMIT 1", (to_bot, title)).fetchone()
    return sections.open_section(row[0])["section"] if row else sections.create_section(to_bot, title)


def _deliver(from_bot, to_bot, text, origin_section, *, wait, watcher, origin,
             message_id):
    with _DELIVERY_LOCKS_GUARD:
        lock = _DELIVERY_LOCKS.setdefault((from_bot, to_bot), threading.RLock())
    with lock:
        return _deliver_locked(from_bot, to_bot, text, origin_section, wait=wait,
                               watcher=watcher, origin=origin, message_id=message_id)


def _deliver_locked(from_bot, to_bot, text, origin_section, *, wait, watcher,
                    origin, message_id):
    target = _target_section(to_bot, from_bot)
    opened = sections.open_section(target["id"])
    live = opened["section"]["live_session_id"]
    _SESSION_ORIGINS[target["id"]] = origin
    _SESSION_ORIGINS[live] = origin
    baseline = sum(m.get("role") == "assistant" for m in opened["messages"])
    with db.transaction() as conn:
        conn.execute("INSERT INTO bot_messages VALUES (?,?,?,?,?,?,?)",
                     (message_id, from_bot, to_bot, None, target["id"], time.time(), text))
    gateway.call("prompt.submit", {"session_id": live, "text": f"@{from_bot}: {text}", "display_kind": "hidden"})
    reply = watcher.wait(live, baseline)
    if not wait:
        origin_live = sections.live_id(origin_section)
        if origin_live:
            gateway.call("prompt.submit", {"session_id": origin_live,
                         "text": f"[reply from {to_bot}] {reply}", "display_kind": "hidden"})
    return reply


def message_bot(args, *, session_id="", task_id="", watcher=None, **_kwargs):
    to_bot = str(args.get("to") or "").strip()
    text = str(args.get("text") or "").strip()
    if not to_bot or not text: return {"error": "to and text are required"}
    # Hermes assigns a fresh task id to each originating human turn. Relayed
    # calls retain it, so old turns do not consume the next turn's allowance.
    origin = str(args.get("origin_session_id") or _SESSION_ORIGINS.get(session_id)
                 or task_id or session_id)
    count = _HOPS.get(origin, 0)
    if count >= HOP_LIMIT: return {"error": f"bot message hop limit ({HOP_LIMIT}) reached"}
    _HOPS[origin] = count + 1
    try: from_bot, origin_section = _sender(session_id)
    except HexbotError as exc: return {"error": exc.message}
    watcher = watcher or CompletionWatcher(timeout=600)
    wait = bool(args.get("wait", True))
    budget = settings.get_settings().get("bot_daily_token_budget")
    used = _usage(to_bot, since=time.time()-time.time()%86400)
    if budget is not None and used["input"] + used["output"] >= int(budget):
        return {"error": "target bot daily token budget reached"}
    if wait:
        message_id = uuid.uuid4().hex
        return {"reply": _deliver(from_bot, to_bot, text, origin_section, wait=True,
                                   watcher=watcher, origin=origin,
                                   message_id=message_id)}
    message_id = uuid.uuid4().hex
    thread = threading.Thread(target=_deliver, args=(from_bot, to_bot, text, origin_section), kwargs={"wait": False, "watcher": watcher, "origin": origin, "message_id": message_id}, daemon=True)
    thread.start()
    return {"status": "sent", "message_id": message_id}


SCHEMA = {"name": "message_bot", "description": "Send a message to another Hexbot bot.",
          "parameters": {"type": "object", "properties": {
              "to": {"type": "string"}, "text": {"type": "string"},
              "wait": {"type": "boolean", "default": True}},
              "required": ["to", "text"], "additionalProperties": False}}
