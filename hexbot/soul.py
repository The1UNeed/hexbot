"""The ``hexbot_soul`` tool: a bot reads or rewrites its own soul.

The soul is the profile's ``SOUL.md``. Hermes freezes it into a section's
system prompt when the section starts, so a rewrite reaches new sections
only; the tool says so in its reply, and asks the bot to tell the user.
"""

from __future__ import annotations

from hexbot import db, gateway
from hexbot.errors import GatewayError

SOUL_CAP = 4000

SCHEMA = {
    "name": "hexbot_soul",
    "description": (
        "Read or rewrite your own soul: the text that says who you are, how you "
        "behave and how you speak. Use action 'read' to see the current text and "
        "action 'write' with the complete new text to replace it. Rewrite it when "
        "the user asks you to change, or when you learn how they want you to work. "
        "Always tell the user what you changed."),
    "parameters": {"type": "object", "properties": {
        "action": {"type": "string", "enum": ["read", "write"]},
        "text": {"type": "string", "description": "The complete new soul, for 'write'."}},
        "required": ["action"], "additionalProperties": False}}


def _bot_for_session(session_id: str) -> str | None:
    from hexbot.sections import section_for_session
    row = section_for_session(session_id)
    if row is not None:
        return row["bot"]
    with db.transaction() as conn:
        row = conn.execute("SELECT bot FROM room_sessions WHERE stored_session_id=? "
                           "OR live_session_id=?", (session_id, session_id)).fetchone()
    return row["bot"] if row else None


def soul_tool(args: dict, *, session_id: str = "", **_kwargs) -> dict:
    bot = _bot_for_session(str(session_id)) if session_id else None
    if not bot:
        return {"error": "hexbot_soul could not identify the calling bot"}
    action = str(args.get("action") or "read")
    if action == "read":
        try:
            detail = gateway.call("profiles.describe", {"name": bot})
        except GatewayError as exc:
            return {"error": exc.message}
        return {"soul": detail.get("soul", ""), "cap": SOUL_CAP}
    if action != "write":
        return {"error": "action must be 'read' or 'write'"}
    text = str(args.get("text") or "").strip()
    if not text:
        return {"error": "text is required for 'write'"}
    if len(text) > SOUL_CAP:
        return {"error": f"the soul is {len(text)} characters; the cap is {SOUL_CAP}"}
    try:
        gateway.call("profiles.configure", {"name": bot, "soul": text})
    except GatewayError as exc:
        return {"error": exc.message}
    gateway.broadcast("hexbot.bots.changed", {"name": bot})
    return {"saved": True, "chars": len(text),
            "note": "Saved. It applies to new sections. Tell the user what you changed."}
