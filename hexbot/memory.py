"""Shared core memory and per-bot memory files."""

from __future__ import annotations

import json
import os
import tempfile
import time
import uuid
from pathlib import Path

from hexbot import db
from hexbot.errors import HexbotError
from hexbot.home import hexbot_home

CORE_SECTIONS = ("user", "household", "workspace", "rules")
CORE_CAP = 4000

#: Hermes caps a single plugin system-prompt section at
#: ``hermes_cli.plugins.MAX_SYSTEM_PROMPT_SECTION_CHARS`` (4000) and the sum of
#: every plugin section at ``MAX_SYSTEM_PROMPT_SECTIONS_TOTAL_CHARS`` (8000).
#: Registering one section per core-memory section buys each of them its own
#: 4000-char allowance instead of sharing one; the 8000-char aggregate is a core
#: constant Hexbot cannot raise from a plugin, so it is reported to clients.
PROMPT_TOTAL_CAP = 16000  # four sections of CORE_CAP each

_HEADINGS = {"user": "User", "household": "Household",
             "workspace": "Workspace", "rules": "Rules"}

CORE_MEMORY_TITLE = "Core memory (shared by all bots)"


def section_prompt_id(section: str) -> str:
    """Plugin system-prompt section id for a core memory section."""
    return f"hexbot.core-memory.{section}"


def get_core_memory(*, owner_id=None, _trusted=False) -> dict:
    from hexbot.identity import current_user_id, require_owner
    owner_id = owner_id or current_user_id()
    if not _trusted:
        require_owner(owner_id)
    db.migrate()
    sections = {key: "" for key in CORE_SECTIONS}
    updated = None
    with db.transaction() as conn:
        for row in conn.execute("SELECT section,text,updated_at FROM core_memory WHERE owner_id=?",
                                (owner_id,)):
            if row["section"] in sections:
                sections[row["section"]] = row["text"]
                updated = max(updated or 0, row["updated_at"] or 0)
    return {"sections": sections,
            "caps": {"per_section": CORE_CAP, "prompt_total": PROMPT_TOTAL_CAP},
            "updated_at": updated}


def set_core_memory(section: str, text: str, *, owner_id=None) -> dict:
    from hexbot.identity import current_user_id, require_owner
    owner_id = owner_id or current_user_id()
    require_owner(owner_id)
    db.migrate()
    if section not in CORE_SECTIONS:
        raise HexbotError(4203, f"unknown core memory section: {section}")
    text = text or ""
    if len(text) > CORE_CAP:
        raise HexbotError(
            4221,
            f"core memory section '{section}' is {len(text)} characters; "
            f"the cap is {CORE_CAP}")
    with db.transaction() as conn:
        conn.execute("INSERT OR REPLACE INTO core_memory(owner_id,section,text,updated_at) VALUES (?,?,?,?)",
                     (owner_id, section, text, time.time()))
    return get_core_memory(owner_id=owner_id)


def render_core_section(section: str, _session_info=None) -> str:
    """Render one core memory section, or "" when empty.

    Each section is its own plugin prompt block, so each block repeats the
    shared title: Hermes renders blocks in ``sorted()`` id order, and a reader
    must be able to tell what a lone ``## Rules`` block belongs to.
    """
    owner_id = None
    session_id = (_session_info or {}).get("session_id") if isinstance(_session_info, dict) else None
    if session_id:
        from hexbot.sections import section_for_session
        row = section_for_session(str(session_id))
        if row is not None:
            with db.transaction() as conn:
                bot = conn.execute("SELECT owner_id FROM bots WHERE name=?", (row["bot"],)).fetchone()
            owner_id = bot[0] if bot else None
        if owner_id is None:
            with db.transaction() as conn:
                bot = conn.execute(
                    "SELECT b.owner_id FROM room_sessions rs JOIN bots b ON b.name=rs.bot "
                    "WHERE rs.stored_session_id=? OR rs.live_session_id=? LIMIT 1",
                    (session_id, session_id)).fetchone()
            owner_id = bot[0] if bot else None
    text = get_core_memory(owner_id=owner_id, _trusted=True)["sections"].get(section, "").strip()
    if not text:
        return ""
    return f"{CORE_MEMORY_TITLE}\n\n## {_HEADINGS.get(section, section.title())}\n{text}"


def core_section_renderer(section: str):
    """Return the zero-config callable Hermes calls to render *section*."""
    def render(session_info=None, _section=section) -> str:
        return render_core_section(_section, session_info)

    render.__name__ = f"render_core_memory_{section}"
    render.__doc__ = f"Render the '{section}' core memory section."
    return render


def render_core_memory(_session_info=None) -> str:
    """Render every non-empty core memory section as one block.

    Kept for callers that want the whole thing in one string (CLI, tests). The
    plugin registers :func:`core_section_renderer` per section instead, because
    one combined block would be truncated at the registrar's 4000-char
    per-section ceiling.
    """
    data = get_core_memory()["sections"]
    chunks = [CORE_MEMORY_TITLE]
    for section in CORE_SECTIONS:
        if data[section].strip():
            chunks.extend((f"## {_HEADINGS[section]}", data[section].strip()))
    return "\n\n".join(chunks) if len(chunks) > 1 else ""


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


def _memory_dir(bot: str) -> Path:
    return hexbot_home() / "profiles" / bot / "memories"


def _caps() -> dict:
    from tools.memory_tool import MemoryStore
    store = MemoryStore()
    return {"memory_md": store.memory_char_limit, "user_md": store.user_char_limit}


def get_bot_memory(bot: str) -> dict:
    from hexbot.bots import _row
    try:
        _row(bot)
    except HexbotError as exc:
        if exc.code != 4205:
            raise
    base = _memory_dir(bot)
    return {
        "memory_md": (base / "MEMORY.md").read_text() if (base / "MEMORY.md").exists() else "",
        "user_md": (base / "USER.md").read_text() if (base / "USER.md").exists() else "",
        "caps": _caps(),
    }


def set_bot_memory(bot: str, memory_md=None, user_md=None) -> dict:
    from hexbot.bots import _row
    try:
        _row(bot)
    except HexbotError as exc:
        if exc.code != 4205:
            raise
    caps = _caps()
    for value, key, filename in ((memory_md, "memory_md", "MEMORY.md"),
                                 (user_md, "user_md", "USER.md")):
        if value is None:
            continue
        cap = caps[key]
        if len(value) > cap:
            raise HexbotError(
                4221, f"{key} is {len(value)} characters; the cap is {cap}")
        _atomic_write(_memory_dir(bot) / filename, value)
    return get_bot_memory(bot)


def _written_texts(args: dict) -> list[tuple[str, str]]:
    """Return the target/text pairs added by a successful memory tool call."""
    action = args.get("action")
    target = str(args.get("target") or "memory")
    if action == "add" and args.get("content"):
        return [(target, str(args["content"]))]
    if action == "replace" and args.get("new_text"):
        return [(target, str(args["new_text"]))]
    if action == "batch":
        pairs = []
        for operation in args.get("operations") or []:
            if operation.get("action") == "add" and operation.get("content"):
                pairs.append((target, str(operation["content"])))
            elif operation.get("action") == "replace" and operation.get("new_text"):
                pairs.append((target, str(operation["new_text"])))
        return pairs
    return []


def tag_memory_write(*, tool_name="", args=None, result=None, status=None,
                     session_id="", task_id="", **_kwargs) -> None:
    """Record successful builtin memory writes with their Hexbot provenance."""
    if tool_name != "memory" or status not in (None, "success"):
        return
    if isinstance(result, str):
        try:
            if json.loads(result).get("success") is False:
                return
        except (json.JSONDecodeError, AttributeError):
            pass
    from hexbot.dreaming import current_dream
    from hexbot.sections import section_for_session
    dream = current_dream(session_id=session_id, task_id=task_id)
    section = section_for_session(str(session_id)) if session_id else None
    bot = dream.get("bot") if dream else (section["bot"] if section else None)
    room_id = dream.get("room_id") if dream else None
    if not room_id and session_id:
        with db.transaction() as conn:
            row = conn.execute("SELECT room_id,bot FROM room_sessions WHERE stored_session_id=? "
                               "OR live_session_id=? LIMIT 1", (session_id, session_id)).fetchone()
        if row:
            room_id, bot = row["room_id"], bot or row["bot"]
    if not bot:
        return
    entries = _written_texts(args or {})
    with db.transaction() as conn:
        for target, text in entries:
            conn.execute("INSERT INTO memory_entries VALUES (?,?,?,?,?,?,?,?)",
                         (uuid.uuid4().hex, bot, section["id"] if section else None,
                          room_id, dream.get("id") if dream else None,
                          target, text, time.time()))


def purge_entries(*, section_id: str | None = None, room_id: str | None = None) -> int:
    """Remove tagged entries from profile memory and delete their tag rows."""
    if not section_id and not room_id:
        return 0
    clause, value = ("section_id", section_id) if section_id else ("room_id", room_id)
    with db.transaction() as conn:
        rows = conn.execute(f"SELECT * FROM memory_entries WHERE {clause}=?", (value,)).fetchall()
    from hermes_constants import reset_hermes_home_override, set_hermes_home_override
    from tools.memory_tool import load_on_disk_store
    removed = 0
    for row in rows:
        token = set_hermes_home_override(str(_memory_dir(row["bot"]).parent))
        try:
            answer = load_on_disk_store().remove(row["target"], row["text"])
            removed += int(bool(answer.get("success")))
        finally:
            reset_hermes_home_override(token)
    with db.transaction() as conn:
        conn.execute(f"DELETE FROM memory_entries WHERE {clause}=?", (value,))
    return removed
