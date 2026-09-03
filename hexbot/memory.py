"""Shared core memory and per-bot memory files."""

from __future__ import annotations

import os
import tempfile
import time
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
PROMPT_TOTAL_CAP = 8000

_HEADINGS = {"user": "User", "household": "Household",
             "workspace": "Workspace", "rules": "Rules"}

CORE_MEMORY_TITLE = "Core memory (shared by all bots)"


def section_prompt_id(section: str) -> str:
    """Plugin system-prompt section id for a core memory section."""
    return f"hexbot.core-memory.{section}"


def get_core_memory() -> dict:
    db.migrate()
    sections = {key: "" for key in CORE_SECTIONS}
    updated = None
    with db.transaction() as conn:
        for row in conn.execute("SELECT section,text,updated_at FROM core_memory"):
            if row["section"] in sections:
                sections[row["section"]] = row["text"]
                updated = max(updated or 0, row["updated_at"] or 0)
    return {"sections": sections,
            "caps": {"per_section": CORE_CAP, "prompt_total": PROMPT_TOTAL_CAP},
            "updated_at": updated}


def set_core_memory(section: str, text: str) -> dict:
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
        conn.execute("INSERT OR REPLACE INTO core_memory(section,text,updated_at) VALUES (?,?,?)",
                     (section, text, time.time()))
    return get_core_memory()


def render_core_section(section: str, _session_info=None) -> str:
    """Render one core memory section, or "" when empty.

    Each section is its own plugin prompt block, so each block repeats the
    shared title: Hermes renders blocks in ``sorted()`` id order, and a reader
    must be able to tell what a lone ``## Rules`` block belongs to.
    """
    text = get_core_memory()["sections"].get(section, "").strip()
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
    base = _memory_dir(bot)
    return {
        "memory_md": (base / "MEMORY.md").read_text() if (base / "MEMORY.md").exists() else "",
        "user_md": (base / "USER.md").read_text() if (base / "USER.md").exists() else "",
        "caps": _caps(),
    }


def set_bot_memory(bot: str, memory_md=None, user_md=None) -> dict:
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
