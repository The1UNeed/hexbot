"""Persistent bot sections backed by Hermes sessions.

Two identifiers exist for every section and they are never interchangeable:

``stored id``
    ``session.create``'s ``stored_session_id`` (== the Hermes ``session_key``).
    Durable, survives restarts, and is the Hexbot section id. It is what
    ``session.resume``, ``session.delete`` and ``session.list`` take.

``live id``
    ``session.create`` / ``session.resume``'s ``session_id``. Valid only while
    the gateway holds the session in memory. It is what ``session.history``,
    ``session.title``, ``session.close``, ``session.status`` and
    ``prompt.submit`` take; passing a stored id to those returns Hermes error
    4001 "session not found".

``_LIVE`` maps stored -> live for the sections this process has opened. It is
refreshed by every ``open_section`` (a ``session.resume`` on the stored id) and
dropped for a section as soon as Hermes reports 4001 for its live id.
"""

from __future__ import annotations

import logging
import time

from hexbot import db, gateway
from hexbot.errors import GatewayError, HexbotError

logger = logging.getLogger(__name__)

#: stored section id -> live Hermes session id (this process only).
_LIVE: dict[str, str] = {}

#: Hermes ``session.active_list`` statuses that mean a turn is in flight.
BUSY_STATUSES = frozenset({"working", "waiting"})


def _row_shape(row, session=None) -> dict:
    return {"id": row["id"], "bot": row["bot"], "title": row["title"],
            "created_at": row["created_at"], "updated_at": row["updated_at"],
            "archived_at": row["archived_at"], "preview": (session or {}).get("preview", ""),
            "message_count": (session or {}).get("message_count", 0),
            "live_session_id": _LIVE.get(row["id"])}


def _get(section_id, *, enforce_owner=True):
    from hexbot.identity import current_user_id
    db.migrate()
    with db.transaction() as conn:
        row = conn.execute("SELECT * FROM sections WHERE id=?", (section_id,)).fetchone()
    if row is None:
        raise HexbotError(4204, f"section not found: {section_id}")
    if enforce_owner and row["owner_id"] != current_user_id():
        raise HexbotError(4302, "not the owner")
    return row


def _forget_live(section_id: str) -> None:
    _LIVE.pop(section_id, None)
    with db.transaction() as conn:
        conn.execute("UPDATE sections SET last_live_session_id=NULL WHERE id=?", (section_id,))


def _remember_live(section_id: str, live_id: str) -> None:
    _LIVE[section_id] = live_id
    with db.transaction() as conn:
        conn.execute("UPDATE sections SET last_live_session_id=? WHERE id=?",
                     (live_id, section_id))


def live_id(section_id: str) -> str | None:
    """Return the live Hermes session id for *section_id*, or None."""
    return _LIVE.get(section_id)


def section_for_session(session_id: str):
    """Resolve a section row from either a stored or a live Hermes session id.

    Hermes hands plugins ``agent.session_id``, which is the *stored* key, while
    the gateway RPCs speak live ids. Both are accepted here so callers never
    have to guess which flavour they were given.
    """
    db.migrate()
    with db.transaction() as conn:
        row = conn.execute("SELECT * FROM sections WHERE id=?", (session_id,)).fetchone()
    if row is not None:
        return row
    stored = next((s for s, live in _LIVE.items() if live == session_id), None)
    if stored is None:
        return None
    try:
        return _get(stored)
    except HexbotError:
        return None


def live_statuses() -> dict[str, str]:
    """Map stored session id -> live status via ``session.active_list``.

    ``session.status`` returns a rendered text blob, not a machine-readable
    state, so the authoritative structured source is ``session.active_list``:
    each row carries ``session_key`` (the stored id) and ``status`` in
    ``waiting | starting | working | idle``.
    """
    try:
        rows = gateway.call("session.active_list", {}).get("sessions", [])
    except GatewayError:
        return {}
    result: dict[str, str] = {}
    for item in rows:
        key = str(item.get("session_key") or "")
        if key:
            result[key] = str(item.get("status") or "")
    return result


def list_sections(bot=None, include_archived=False, *, all_users=False) -> list[dict]:
    from hexbot.identity import owner_filter
    owner = owner_filter(all_users)
    db.migrate()
    sql, args = "SELECT * FROM sections WHERE 1=1", []
    if bot:
        sql += " AND bot=?"
        args.append(bot)
    if owner is not None:
        sql += " AND owner_id=?"; args.append(owner)
    if not include_archived:
        sql += " AND archived_at IS NULL"
    sql += " ORDER BY updated_at DESC"
    with db.transaction() as conn:
        rows = conn.execute(sql, args).fetchall()
    history = {}
    for profile in {row["bot"] for row in rows}:
        try:
            history.update({item["id"]: item for item in gateway.call(
                "session.list", {"profile": profile, "include_hidden": True})["sessions"]})
        except (GatewayError, KeyError, TypeError):
            logger.debug("session.list unavailable for profile %s", profile, exc_info=True)
    return [_row_shape(row, history.get(row["id"])) for row in rows]


def create_section(bot: str, title=None) -> dict:
    db.migrate()
    from hexbot.identity import current_user_id
    with db.transaction() as conn:
        found_bot = conn.execute("SELECT owner_id FROM bots WHERE name=?", (bot,)).fetchone()
    if found_bot is not None and found_bot["owner_id"] != current_user_id():
        raise HexbotError(4302, "not the owner")
    owner_id = found_bot["owner_id"] if found_bot is not None else current_user_id()
    title = (title or "New section").strip() or "New section"
    result = gateway.call("session.create", {"profile": bot, "title": title,
        "close_on_disconnect": False, "follow_profile_config": True})
    stored = result.get("stored_session_id")
    live = result.get("session_id")
    if not stored:
        # Without the durable key the section could never be resumed or
        # deleted, so refuse rather than record an id Hermes does not know.
        raise HexbotError(5201, "session.create returned no stored_session_id")
    if live:
        # Hermes only persists a session once it has messages; save the empty
        # session now so the section can be reopened after a reconnect.
        try:
            gateway.call("session.save", {"session_id": live})
        except GatewayError:
            logger.debug("session.save failed for new section %s", stored, exc_info=True)
    now = time.time()
    with db.transaction() as conn:
        conn.execute(
            "INSERT INTO sections(id,bot,title,created_at,updated_at,last_live_session_id,owner_id)"
            " VALUES (?,?,?,?,?,?,?)", (stored, bot, title, now, now, live, owner_id))
    if live:
        _LIVE[stored] = live
    _touch_bot(bot, now)
    return _row_shape(_get(stored), {"message_count": len(result.get("messages", []))})


def open_section(section_id: str) -> dict:
    """Return the section and its messages, attaching the caller to its live session.

    Always ``session.resume`` on the stored id. When Hermes still holds the
    session it reuses it (same agent, warm prompt cache), rebinds it to the
    calling transport and cancels the orphan reap that a page reload armed;
    otherwise it rebuilds the session from the store. A ``session.history``
    probe would leave a reloaded page attached to nothing: the parked session
    is reaped twenty seconds later and the next ``prompt.submit`` fails with
    4001 "session not found".
    """
    row = _get(section_id)
    from hexbot.usage import require_budget
    require_budget(row["owner_id"])
    result = gateway.call("session.resume", {"session_id": section_id, "profile": row["bot"]})
    live = result.get("session_id")
    if not live:
        raise HexbotError(5201, f"session.resume returned no session_id for {section_id}")
    if _LIVE.get(section_id) != live:
        _remember_live(section_id, live)
    _flush_pending_title(section_id, live, row["title"])
    messages = result.get("messages", [])
    opened = {"section": _row_shape(_get(section_id), {"message_count": len(messages)}),
              "messages": messages}
    # A question the bot is still waiting on: the client re-draws its card
    # after a reload, since the clarify.request event only reached the page
    # that was open when it fired.
    if result.get("pending_clarify"):
        opened["pending_clarify"] = result["pending_clarify"]
    return opened


def _flush_pending_title(section_id: str, live: str, title: str) -> None:
    """Push a rename that was made while the section was closed."""
    with db.transaction() as conn:
        row = conn.execute("SELECT title_dirty FROM sections WHERE id=?", (section_id,)).fetchone()
    if row is None or not row["title_dirty"]:
        return
    if _set_hermes_title(live, title):
        with db.transaction() as conn:
            conn.execute("UPDATE sections SET title_dirty=0 WHERE id=?", (section_id,))


def _set_hermes_title(live: str, title: str) -> bool:
    """Best-effort ``session.title`` on a LIVE session id. True when applied."""
    try:
        gateway.call("session.title", {"session_id": live, "title": title})
        return True
    except GatewayError as exc:
        logger.info("session.title on live id %s failed: %s", live, exc.message)
        return False


def rename_section(section_id: str, title: str) -> dict:
    """Rename a section.

    The Hexbot row is always updated (it is what every ``hexbot.*`` result
    reports). The Hermes session title is only settable through
    ``session.title``, which needs the LIVE session id, so:

    * section live in this process -> rename immediately;
    * section closed, or Hermes answers 4001 -> mark the row ``title_dirty``
      and push the rename lazily on the next :func:`open_section`, right after
      ``session.resume`` hands back a fresh live id.
    """
    title = (title or "").strip()
    if not title:
        raise HexbotError(4200, "missing parameter: title")
    row = _get(section_id)
    live = _LIVE.get(section_id)
    applied = bool(live) and _set_hermes_title(live, title)
    if live and not applied:
        _forget_live(section_id)
    with db.transaction() as conn:
        conn.execute("UPDATE sections SET title=?,updated_at=?,title_dirty=? WHERE id=?",
                     (title, time.time(), 0 if applied else 1, section_id))
    _touch_bot(row["bot"])
    return _row_shape(_get(section_id))


def _archive(section_id, value):
    row = _get(section_id)
    with db.transaction() as conn:
        conn.execute("UPDATE sections SET archived_at=?,updated_at=? WHERE id=?",
                     (value, time.time(), section_id))
    _touch_bot(row["bot"])
    return _row_shape(_get(section_id))


def archive_section(section_id):
    """Archive a section. The stored session and its memory are kept."""
    return _archive(section_id, time.time())


def unarchive_section(section_id):
    return _archive(section_id, None)


def close_section(section_id: str) -> bool:
    """Close the live session of a section, if it has one. Idempotent."""
    live = _LIVE.get(section_id)
    if not live:
        return False
    try:
        gateway.call("session.close", {"session_id": live})
    except GatewayError as exc:
        if exc.code != 4001:
            raise
    finally:
        _forget_live(section_id)
    return True


def delete_section(section_id: str, purge_memory=True) -> bool:
    """Delete a section.

    Closes the live session first (``session.delete`` refuses with 4023 while
    the stored key is bound to a live record). With ``purge_memory`` the stored
    Hermes session is deleted too, which drops its transcript and every section
    memory entry derived from it; with ``purge_memory=False`` only the Hexbot
    row goes and the Hermes transcript is left behind.
    """
    row = _get(section_id)
    close_section(section_id)
    if purge_memory:
        try:
            gateway.call("session.delete", {"session_id": section_id, "profile": row["bot"]})
        except GatewayError as exc:
            # A section that never had a message has no stored Hermes session
            # (Hermes persists on the first prompt), so there is nothing to
            # purge. session.delete says 4007 for that; 4001 is the live-id form.
            if exc.code not in (4001, 4007):
                raise
        from hexbot.memory import purge_entries
        purge_entries(section_id=section_id)
    with db.transaction() as conn:
        conn.execute("DELETE FROM sections WHERE id=?", (section_id,))
    _touch_bot(row["bot"])
    return True


def _touch_bot(bot: str, when: float | None = None) -> None:
    with db.transaction() as conn:
        conn.execute("UPDATE bots SET last_activity_at=? WHERE name=?",
                     (when or time.time(), bot))


def touch_section(section_id: str) -> dict:
    """Stamp activity on a section and its bot (fired on turn completion)."""
    row = _get(section_id)
    now = time.time()
    with db.transaction() as conn:
        conn.execute("UPDATE sections SET updated_at=? WHERE id=?", (now, section_id))
    _touch_bot(row["bot"], now)
    return _row_shape(_get(section_id))
