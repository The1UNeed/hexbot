"""Daily transcript digestion and durable dream bookkeeping."""

from __future__ import annotations

import contextvars
import json
import logging
import time
import uuid
from datetime import datetime
from pathlib import Path

from hexbot import db, sections
from hexbot.errors import HexbotError
from hexbot.home import hexbot_home

logger = logging.getLogger(__name__)
SECTION_CAP = 12_000
ROOM_MEMORY_CAP = 3_000
DREAM_JOB_NAME = "hexbot-dream"

_dream_context: contextvars.ContextVar[dict | None] = contextvars.ContextVar(
    "hexbot_dream_context", default=None)
_active_turns: dict[str, dict] = {}


def _profile_home(bot: str) -> Path:
    from hermes_cli.profiles import get_profile_dir
    return Path(get_profile_dir(bot))


def _cron_expression(value: str) -> str:
    hour, minute = (int(part) for part in value.split(":"))
    return f"{minute} {hour} * * *"


def _job_prompt(bot: dict) -> str:
    core = (" You may also write a genuinely shared fact to core memory because "
            "your may_write_core permission is enabled." if bot.get("may_write_core") else "")
    return (
        f"This is the daily dream for Hexbot bot {bot['name']}. Call "
        f"hexbot_dream_digest with bot={json.dumps(bot['name'])}. Read its JSON digest, "
        "then use the memory tool to save only durable facts, preferences, and unfinished "
        "work in your notes. Do not save transient chatter or duplicate existing notes."
        f"{core} Finish with a concise markdown summary of what you kept."
    )


def ensure_dream_job(bot: dict | str) -> dict:
    """Create or reconcile one daily dream job in the bot profile store."""
    from cron import create_job, list_jobs, update_job
    from cron.jobs import use_cron_store
    from hexbot.bots import get_bot
    from hexbot.settings import get_settings

    bot = get_bot(bot) if isinstance(bot, str) else bot
    settings = get_settings()
    enabled = bool(settings["dream_enabled"] and bot.get("dream_enabled", True))
    schedule = _cron_expression(settings["dream_time"])
    wanted = {"prompt": _job_prompt(bot), "schedule": schedule, "enabled": enabled,
              "deliver": "local", "enabled_toolsets": ["memory", "hexbot"]}
    with use_cron_store(_profile_home(bot["name"])):
        current = next((job for job in list_jobs(include_disabled=True)
                        if job.get("name") == DREAM_JOB_NAME), None)
        if current is None:
            job = create_job(wanted["prompt"], schedule, name=DREAM_JOB_NAME,
                             deliver="local", enabled_toolsets=wanted["enabled_toolsets"])
            if not enabled:
                job = update_job(job["id"], {"enabled": False})
            return job
        updates = {key: value for key, value in wanted.items() if current.get(key) != value}
        return update_job(current["id"], updates) if updates else current


def ensure_room_dream_job(room: dict | str) -> dict | None:
    """Reconcile the room dream job on its main bot profile."""
    from cron import create_job, list_jobs, update_job
    from cron.jobs import use_cron_store
    from hexbot.rooms import store as rooms
    from hexbot.settings import get_settings

    room = rooms.get(room) if isinstance(room, str) else room
    bot = room.get("main_bot")
    if not bot:
        return None
    settings = get_settings()
    name = f"hexbot-dream-room-{room['id']}"
    schedule = _cron_expression(settings["dream_time"])
    enabled = bool(settings["dream_enabled"])
    prompt = (
        f"This is the room dream for {room['name']}. Call hexbot_dream_digest with "
        f"bot={json.dumps(bot)} and room_id={json.dumps(room['id'])}. Read the JSON, "
        "use the memory tool only for private durable notes that belong to your bot, then "
        "finish with a concise shared room summary."
    )
    wanted = {"prompt": prompt, "schedule": schedule, "enabled": enabled,
              "deliver": "local", "enabled_toolsets": ["memory", "hexbot"]}
    with use_cron_store(_profile_home(bot)):
        current = next((job for job in list_jobs(include_disabled=True)
                        if job.get("name") == name), None)
        if current is None:
            job = create_job(prompt, schedule, name=name, deliver="local",
                             enabled_toolsets=wanted["enabled_toolsets"])
            return update_job(job["id"], {"enabled": False}) if not enabled else job
        updates = {key: value for key, value in wanted.items() if current.get(key) != value}
        return update_job(current["id"], updates) if updates else current


def _cap(text: str, limit: int = SECTION_CAP) -> str:
    if len(text) <= limit:
        return text
    marker = "[earlier messages omitted]\n"
    return marker + text[-(limit - len(marker)):]


def _message_text(message: dict) -> str:
    content = message.get("content", "")
    if isinstance(content, str):
        return content
    return json.dumps(content, ensure_ascii=False)


def build_digest(bot: dict | str, since: float) -> dict:
    """Collect this bot's section messages and room events since ``since``."""
    from hermes_state import SessionDB
    from hexbot.bots import get_bot
    from hexbot.rooms import store as rooms

    bot = get_bot(bot) if isinstance(bot, str) else bot
    result = {"bot": bot["name"], "since": since, "sections": [], "rooms": [],
              "may_write_core": bool(bot.get("may_write_core"))}
    state_path = _profile_home(bot["name"]) / "state.db"
    if state_path.exists():
        session_db = SessionDB(db_path=state_path, read_only=True)
        try:
            for section in sections.list_sections(bot["name"], include_archived=True):
                messages = [m for m in session_db.get_messages(
                    section["id"], include_compacted=True)
                    if float(m.get("timestamp") or 0) >= float(since)]
                if not messages:
                    continue
                transcript = "\n".join(
                    f"{m.get('role', 'unknown')}: {_message_text(m)}" for m in messages)
                result["sections"].append({"id": section["id"], "title": section["title"],
                                           "transcript": _cap(transcript)})
        finally:
            session_db.close()
    with db.transaction() as conn:
        room_ids = [row[0] for row in conn.execute(
            "SELECT room_id FROM room_members WHERE member_kind='bot' AND member_id=? "
            "AND left_at IS NULL", (bot["name"],))]
    for room_id in room_ids:
        events, after = [], 0
        while True:
            page = rooms.log(room_id, after, 1000, enforce_owner=False)
            events.extend(event for event in page
                          if float(event.get("created_at") or 0) >= float(since))
            if len(page) < 1000:
                break
            after = page[-1]["seq"]
        if events:
            transcript = "\n".join(
                f"{event.get('kind')} {event.get('actor_id') or ''}: "
                f"{event.get('payload', {}).get('text', '')}" for event in events)
            result["rooms"].append({"id": room_id, "name": rooms.get(room_id, enforce_owner=False)["name"],
                                    "transcript": _cap(transcript)})
    return result


def _last_finished(bot: str, room_id: str | None = None) -> float:
    with db.transaction() as conn:
        row = conn.execute(
            "SELECT MAX(finished_at) FROM dreams WHERE bot=? AND room_id IS ? AND status='complete'",
            (bot, room_id)).fetchone()
    return float(row[0] or 0)


def dream_digest(args: dict, **kwargs) -> str:
    """Tool handler. Start a dream and return its source material as JSON."""
    from hexbot.bots import get_bot
    bot = str(args.get("bot") or "").strip()
    room_id = str(args.get("room_id") or "").strip() or None
    if not bot:
        return json.dumps({"error": "bot is required"})
    bot_row = get_bot(bot)
    dream_id, now = uuid.uuid4().hex, time.time()
    context = {"id": dream_id, "bot": bot, "room_id": room_id,
               "session_id": str(kwargs.get("session_id") or ""),
               "task_id": str(kwargs.get("task_id") or "")}
    with db.transaction() as conn:
        conn.execute("INSERT INTO dreams(id,bot,room_id,started_at,status,summary,owner_id) "
                     "VALUES (?,?,?,?,?,?,?)", (dream_id, bot, room_id, now, "running", "",
                     bot_row["owner_id"]))
    _dream_context.set(context)
    for key in (context["session_id"], context["task_id"]):
        if key:
            _active_turns[key] = context
    digest = build_digest(bot_row, _last_finished(bot, room_id))
    if room_id:
        digest["rooms"] = [room for room in digest["rooms"] if room["id"] == room_id]
        digest["sections"] = []
    digest["dream_id"] = dream_id
    return json.dumps(digest, ensure_ascii=False)


def current_dream(**kwargs) -> dict | None:
    context = _dream_context.get()
    if context:
        return context
    for key in (str(kwargs.get("session_id") or ""), str(kwargs.get("task_id") or "")):
        if key and key in _active_turns:
            return _active_turns[key]
    return None


def record_dream(bot: str, output: str, *, room_id: str | None = None,
                 dream_id: str | None = None, status: str = "complete") -> dict:
    """Persist a completed dream and post it in the bot's Dreams section.

    The summary is written to ``state.db`` as a message from the bot. It is
    never sent through ``prompt.submit``: even with ``display_kind='hidden'``
    that is a user prompt, so the bot would spend a turn answering its own
    dream, and could ask the human a question from a section nobody opens.
    """
    dream_id = dream_id or uuid.uuid4().hex
    now = time.time()
    # Hermes cron lets a job answer "[SILENT]" when it has nothing to report.
    if output.strip() == "[SILENT]":
        output = ""
    with db.transaction() as conn:
        exists = conn.execute("SELECT 1 FROM dreams WHERE id=?", (dream_id,)).fetchone()
        if exists:
            conn.execute("UPDATE dreams SET finished_at=?,status=?,summary=? WHERE id=?",
                         (now, status, output, dream_id))
        else:
            owner = conn.execute("SELECT owner_id FROM bots WHERE name=?", (bot,)).fetchone()
            conn.execute("INSERT INTO dreams(id,bot,room_id,started_at,finished_at,status,summary,owner_id) "
                         "VALUES (?,?,?,?,?,?,?,?)",
                         (dream_id, bot, room_id, now, now, status, output,
                          owner[0] if owner else "local"))
        if room_id and status == "complete":
            conn.execute("INSERT OR REPLACE INTO room_memory(room_id,text,updated_at) VALUES (?,?,?)",
                         (room_id, output, now))
    if not room_id and output:
        dream_section = next((item for item in sections.list_sections(bot, True)
                              if item["title"] == "Dreams"), None)
        dream_section = dream_section or sections.create_section(bot, "Dreams")
        # A live session keeps its own history; close it so the next open reads the store.
        sections.close_section(dream_section["id"])
        from hermes_state import SessionDB
        store = SessionDB(db_path=_profile_home(bot) / "state.db")
        try:
            # Hermes stores a session on its first prompt, and this one never gets one.
            if store.get_session(dream_section["id"]) is None:
                store.create_session(dream_section["id"], "tui")
            store.append_message(dream_section["id"], "assistant", output)
        finally:
            store.close()
    return {"id": dream_id, "bot": bot, "room_id": room_id, "started_at": now,
            "finished_at": now, "status": status, "summary": output}


def finish_turn(output: str, *, status: str = "complete", **kwargs) -> None:
    context = current_dream(**kwargs)
    if not context:
        return
    record_dream(context["bot"], output or "", room_id=context.get("room_id"),
                 dream_id=context["id"], status=status)
    for key, value in list(_active_turns.items()):
        if value.get("id") == context["id"]:
            _active_turns.pop(key, None)
    _dream_context.set(None)


def status(bot: str) -> dict:
    from cron import list_jobs
    from cron.jobs import use_cron_store
    from hexbot.bots import get_bot
    bot_row = get_bot(bot)
    with use_cron_store(_profile_home(bot)):
        job = next((j for j in list_jobs(include_disabled=True)
                    if j.get("name") == DREAM_JOB_NAME), None) or ensure_dream_job(bot_row)
    return {"enabled": bool(job.get("enabled")), "last_run_at": job.get("last_run_at"),
            "next_run_at": job.get("next_run_at"), "last_status": job.get("last_status"),
            "last_error": job.get("last_error")}


def run_now(bot: str) -> dict:
    from cron import trigger_job
    from cron.jobs import use_cron_store
    job = ensure_dream_job(bot)
    home = _profile_home(bot)
    with use_cron_store(home):
        triggered = trigger_job(job["id"])
    if not triggered:
        raise HexbotError(5240, f"dream job not found for {bot}")
    _tick_soon(home)
    return {"job": triggered}


def _tick_soon(home: Path) -> None:
    """Run this profile's due jobs now instead of waiting for the next tick."""
    import threading

    def _run() -> None:
        from cron.jobs import use_cron_store
        from cron.scheduler import tick
        from hermes_constants import reset_hermes_home_override, set_hermes_home_override

        token = set_hermes_home_override(str(home))
        try:
            with use_cron_store(home):
                tick(verbose=False)
        except Exception:  # pragma: no cover - logged, never raised into RPC
            logger.exception("immediate dream tick failed for %s", home)
        finally:
            reset_hermes_home_override(token)

    threading.Thread(target=_run, name="hexbot-dream-now", daemon=True).start()


def list_dreams(bot: str, limit: int = 20, *, all_users=False) -> dict:
    from hexbot.bots import get_bot
    get_bot(bot, all_users=all_users)
    limit = max(1, min(int(limit or 20), 200))
    with db.transaction() as conn:
        rows = conn.execute("SELECT * FROM dreams WHERE bot=? ORDER BY started_at DESC LIMIT ?",
                            (bot, limit)).fetchall()
    return {"dreams": [dict(row) for row in rows]}


DIGEST_SCHEMA = {"type": "function", "function": {"name": "hexbot_dream_digest",
    "description": "Load the conversations for the current Hexbot dream.",
    "parameters": {"type": "object", "properties": {
        "bot": {"type": "string"}, "room_id": {"type": "string"}},
        "required": ["bot"]}}}
