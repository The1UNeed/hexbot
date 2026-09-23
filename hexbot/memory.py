"""About you (one text per user, read by all their bots) and per-bot memory."""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

from hexbot import db
from hexbot.errors import HexbotError
from hexbot.home import hexbot_home

#: Written only by the user, so it gets a little more room than a bot's notes.
USER_CAP = 2000
ABOUT_YOU_TITLE = "About you (written by the user, shared by all of their bots)"
#: Plugin system-prompt section id for the About you text.
PROMPT_SECTION_ID = "hexbot.about-you"


def _atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.")
    try:
        with os.fdopen(fd, "w") as stream:
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


# ---------------------------------------------------------------------------
# About you
# ---------------------------------------------------------------------------

def _user_path(owner_id: str) -> Path:
    return hexbot_home() / "users" / owner_id / "user.md"


def get_user_memory(*, owner_id=None, _trusted=False) -> dict:
    from hexbot.identity import current_user_id, require_owner
    owner_id = owner_id or current_user_id()
    if not _trusted:
        require_owner(owner_id)
    path = _user_path(owner_id)
    exists = path.exists()
    return {"text": path.read_text() if exists else "",
            "cap": USER_CAP,
            "updated_at": path.stat().st_mtime if exists else None}


def set_user_memory(text: str, *, owner_id=None) -> dict:
    from hexbot.identity import current_user_id, require_owner
    owner_id = owner_id or current_user_id()
    require_owner(owner_id)
    text = text or ""
    if len(text) > USER_CAP:
        raise HexbotError(4221, f"About you is {len(text)} characters; the cap is {USER_CAP}")
    _atomic_write(_user_path(owner_id), text)
    return get_user_memory(owner_id=owner_id)


def _session_owner(session_info) -> str | None:
    """The owner of the bot behind a Hermes session: a section, a room, or
    any other turn on a bot's profile (a dream)."""
    if not isinstance(session_info, dict):
        return None
    session_id = str(session_info.get("session_id") or "")
    bot_name = None
    if session_id:
        from hexbot.sections import section_for_session
        row = section_for_session(session_id)
        if row is not None:
            bot_name = row["bot"]
        else:
            with db.transaction() as conn:
                room = conn.execute(
                    "SELECT bot FROM room_sessions WHERE stored_session_id=? "
                    "OR live_session_id=? LIMIT 1", (session_id, session_id)).fetchone()
            bot_name = room["bot"] if room else None
    bot_name = bot_name or session_info.get("profile_name")
    if not bot_name:
        return None
    with db.transaction() as conn:
        bot = conn.execute("SELECT owner_id FROM bots WHERE name=?", (bot_name,)).fetchone()
    return bot[0] if bot else None


def render_user_memory(session_info=None) -> str:
    """Render the session owner's About you text as a prompt block, or "".

    A session that belongs to no bot (the root profile, an unknown one) gets
    nothing rather than the admin's text.
    """
    owner_id = _session_owner(session_info)
    if not owner_id:
        return ""
    text = get_user_memory(owner_id=owner_id, _trusted=True)["text"].strip()
    return f"{ABOUT_YOU_TITLE}\n\n{text}" if text else ""


# ---------------------------------------------------------------------------
# Bot memory
# ---------------------------------------------------------------------------

def _memory_path(bot: str) -> Path:
    return hexbot_home() / "profiles" / bot / "memories" / "MEMORY.md"


def _cap() -> int:
    from tools.memory_tool import MemoryStore
    return MemoryStore().memory_char_limit


def _check_bot(bot: str) -> None:
    from hexbot.bots import _row
    try:
        _row(bot)
    except HexbotError as exc:
        if exc.code != 4205:
            raise


def get_bot_memory(bot: str) -> dict:
    _check_bot(bot)
    path = _memory_path(bot)
    return {"memory_md": path.read_text() if path.exists() else "", "cap": _cap()}


def set_bot_memory(bot: str, memory_md: str) -> dict:
    _check_bot(bot)
    memory_md = memory_md or ""
    cap = _cap()
    if len(memory_md) > cap:
        raise HexbotError(4221, f"memory is {len(memory_md)} characters; the cap is {cap}")
    _atomic_write(_memory_path(bot), memory_md)
    return get_bot_memory(bot)
