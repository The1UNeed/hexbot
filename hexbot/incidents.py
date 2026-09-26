"""Bot incidents: the daemon's record of why a bot is "stopped".

An incident is opened by a plugin hook (a connector refused a tool call, a
turn ended with an error) and resolved when the cause goes away (the
connector is set up again, a later turn on the same section completes) or the
user clears it. The newest open incident is what ``bots.list`` reports as
``status: stopped`` with its ``status_detail``.
"""

from __future__ import annotations

import json
import logging
import re
import time
import uuid

from hexbot import db

logger = logging.getLogger(__name__)

KINDS = ("connector_error", "turn_failed")

#: Text that means "the service refused us", regardless of which tool said it.
_AUTH_PATTERN = re.compile(
    r"\b(401|402|429|403 forbidden|unauthori[sz]ed|forbidden|invalid[ _-]?(api[ _-]?)?(key|token)|"
    r"(api[ _-]?)?(key|token|credentials?|session)[^.\n]{0,40}(expired|invalid|missing|revoked)|"
    r"quota (exceeded|reached|exhausted)|insufficient[ _-]?credits?|rate[ _-]?limit(ed)?|"
    r"payment required)\b",
    re.IGNORECASE)

#: Tools whose output is the only evidence of a refusal (skills run through them).
_TEXT_ONLY_TOOLS = ("terminal", "execute_code")

#: A stream that ended because the user stopped it is not a failure.
_INTERRUPT_PATTERN = re.compile(r"interrupt|cancel", re.IGNORECASE)


def is_interrupt(error: str) -> bool:
    return bool(error) and bool(_INTERRUPT_PATTERN.search(str(error)))


def _shape(row) -> dict:
    return {"id": row["id"], "bot": row["bot"], "section_id": row["section_id"],
            "room_id": row["room_id"], "session_id": row["session_id"],
            "kind": row["kind"], "connector": row["connector"], "text": row["text"],
            "created_at": row["created_at"], "resolved_at": row["resolved_at"]}


def _broadcast(row: dict) -> None:
    from hexbot import gateway
    payload = {key: row[key] for key in ("bot", "section_id", "room_id", "session_id")}
    payload["incident"] = {key: row[key] for key in
                           ("id", "kind", "connector", "text", "created_at", "resolved_at")}
    for event, body in (("hexbot.bots.incident", payload),
                        ("hexbot.bots.changed", {"name": row["bot"]})):
        try:
            gateway.broadcast(event, body)
        except Exception:
            logger.debug("could not broadcast %s", event, exc_info=True)


def record(bot: str, kind: str, text: str, *, connector=None, section_id=None,
           room_id=None, session_id=None) -> dict:
    """Open an incident and broadcast it. Duplicates (same open cause) are folded."""
    if kind not in KINDS:
        raise ValueError(kind)
    text = (text or "").strip()[:500]
    db.migrate()
    with db.transaction() as conn:
        existing = conn.execute(
            "SELECT * FROM bot_incidents WHERE bot=? AND kind=? AND resolved_at IS NULL "
            "AND COALESCE(connector,'')=COALESCE(?,'') AND COALESCE(section_id,'')=COALESCE(?,'')",
            (bot, kind, connector, section_id)).fetchone()
        if existing is not None:
            conn.execute("UPDATE bot_incidents SET text=?,created_at=?,session_id=? WHERE id=?",
                         (text or existing["text"], time.time(), session_id or existing["session_id"],
                          existing["id"]))
            row = conn.execute("SELECT * FROM bot_incidents WHERE id=?", (existing["id"],)).fetchone()
        else:
            row_id = uuid.uuid4().hex
            conn.execute(
                "INSERT INTO bot_incidents(id,bot,section_id,room_id,session_id,kind,connector,"
                "text,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
                (row_id, bot, section_id, room_id, session_id, kind, connector, text, time.time()))
            row = conn.execute("SELECT * FROM bot_incidents WHERE id=?", (row_id,)).fetchone()
    shaped = _shape(row)
    _broadcast(shaped)
    return shaped


def resolve(*, bot=None, connector=None, section_id=None, incident_id=None,
            kind=None) -> list[dict]:
    """Close matching open incidents. Any combination of filters; at least one
    of bot, connector, section or id (``kind`` only narrows)."""
    if not any((bot, connector, section_id, incident_id)):
        raise ValueError("resolve needs a filter")
    if kind is not None and kind not in KINDS:
        raise ValueError(kind)
    sql, args = "SELECT * FROM bot_incidents WHERE resolved_at IS NULL", []
    for column, value in (("bot", bot), ("connector", connector),
                          ("section_id", section_id), ("id", incident_id), ("kind", kind)):
        if value:
            sql += f" AND {column}=?"
            args.append(value)
    db.migrate()
    with db.transaction() as conn:
        rows = conn.execute(sql, args).fetchall()
        now = time.time()
        for row in rows:
            conn.execute("UPDATE bot_incidents SET resolved_at=? WHERE id=?", (now, row["id"]))
        resolved = [dict(_shape(row), resolved_at=now) for row in rows]
    for item in resolved:
        _broadcast(item)
    return resolved


def open_incidents(bots: list[str] | None = None) -> dict[str, dict]:
    """Newest open incident per bot (all bots when ``bots`` is None)."""
    db.migrate()
    with db.transaction() as conn:
        rows = conn.execute(
            "SELECT * FROM bot_incidents WHERE resolved_at IS NULL ORDER BY created_at DESC"
        ).fetchall()
    result: dict[str, dict] = {}
    for row in rows:
        if (bots is None or row["bot"] in bots) and row["bot"] not in result:
            result[row["bot"]] = _shape(row)
    return result


def looks_like_refusal(text: str) -> bool:
    return bool(text) and bool(_AUTH_PATTERN.search(text))


def _result_text(result) -> str:
    if result is None:
        return ""
    if isinstance(result, (dict, list)):
        try:
            return json.dumps(result)
        except (TypeError, ValueError):
            return str(result)
    return str(result)


def classify_tool_result(tool_name: str, result, *, status=None, error_message=None):
    """Return ``(connector_id, text)`` when a tool result means a connector refused
    us, else ``None``.

    A connector's own tool (``image_generate``, ``x_search``, ...) counts only
    when Hexbot flagged the call as an error: its successful output is web
    pages and search hits, which mention "rate limit" and "expired" all the
    time. For every other tool the text decides, and only when the call failed
    or the tool is one skills run their API calls through (``terminal``,
    ``execute_code``), since a Notion skill hitting a 401 through curl is a
    successful terminal call as far as Hexbot knows.
    """
    from hexbot.connectors import connector_for_tool, connector_mentioned

    text = (error_message or "").strip() or _result_text(result)
    connector = connector_for_tool(tool_name)
    if connector is not None:
        return (connector, text[:300]) if status == "error" else None
    if status != "error" and tool_name not in _TEXT_ONLY_TOOLS:
        return None
    if not looks_like_refusal(text):
        return None
    connector = connector_mentioned(text)
    if connector is None:
        return None
    return connector, text[:300]
