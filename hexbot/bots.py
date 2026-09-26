"""Bot registry layered over Hexbot profiles."""

from __future__ import annotations

import logging
import json
import time

from hexbot import db, gateway, sections
from hexbot.errors import GatewayError, HexbotError
from hexbot.settings import mirror_deployment_config

logger = logging.getLogger(__name__)

_UPDATABLE = frozenset(
    {"display_name", "title", "description", "persona", "provider", "model", "avatar",
     "dream_enabled", "shareable", "tools", "skills",
     "notify", "approval_mode", "workdir"}
)

#: Tools page keys -> Hexbot toolsets. Everything a bot can do on this computer
#: with no account. Anything that needs an outside service is a connector
#: (``hexbot.connectors``) and is never listed here.
TOOL_TOOLSETS = {"terminal": "terminal", "files": "file", "code_execution": "code_execution",
                 "browser": "browser", "computer_use": "computer_use", "vision": "vision",
                 "voice": "tts", "message_bots": "hexbot", "delegate": "delegation",
                 "scheduling": "cronjob"}

BOT_APPROVAL_MODES = ("inherit", "manual", "smart", "off")
#: The platform name Hexbot sessions resolve their tools under
#: (``tui_gateway/server.py`` calls ``_get_platform_tools(cfg, "cli")``).
SESSION_PLATFORM = "cli"


def _write_profile_config_key(profile_dir, section: str, key: str, value) -> None:
    """Set ``section.key`` in one profile's ``config.yaml`` (ruamel round-trip)."""
    from pathlib import Path
    from ruamel.yaml import YAML
    path = Path(profile_dir) / "config.yaml"
    yaml = YAML(typ="rt")
    try:
        data = yaml.load(path.read_text()) if path.exists() else None
    except Exception:
        logger.warning("could not parse %s; rewriting the managed key only", path)
        data = None
    data = data if isinstance(data, dict) else {}
    block = data.get(section)
    if not isinstance(block, dict):
        block = {}
        data[section] = block
    block[key] = value
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w") as stream:
        yaml.dump(data, stream)


def pin_toolsets(name: str, toolsets) -> None:
    """Pin exactly which toolsets a bot's sessions load.

    Two keys, because Hexbot reads two: ``tools.enabled_toolsets`` is what
    ``profiles.describe`` reports (and what the UI reads back), while a session
    resolves its tools from ``platform_toolsets.cli`` (``_get_platform_tools``
    in ``hermes_cli/tools_config.py``). An explicit platform list turns
    default-off toolsets (``x_search``, ``video_gen``) on when listed and any
    listed toolset off when absent. MCP servers are never listed: absent means
    "every enabled server", and per-bot MCP choice is the server's own
    ``disabled`` flag. ``hexbot`` is marked known so that absent means off.
    """
    from hermes_cli.profiles import get_profile_dir
    wanted = sorted({str(t) for t in toolsets if str(t) and not str(t).startswith("mcp-")})
    gateway.call("profiles.configure", {"name": name, "enabled_toolsets": wanted})
    profile_dir = get_profile_dir(name)
    _write_profile_config_key(profile_dir, "platform_toolsets", SESSION_PLATFORM, wanted)
    _write_profile_config_key(profile_dir, "known_plugin_toolsets", SESSION_PLATFORM, ["hexbot"])


STATUS_ORDER = ("stopped", "needs_you", "working", "idle")


def default_display_name(name: str) -> str:
    """``research-scout`` -> ``Research Scout``."""
    return name.replace("-", " ").replace("_", " ").title()


def default_persona(display_name: str, title: str | None = None) -> str:
    """Persona used when a bot is created without one (never the Hexbot default)."""
    role = f", {title.strip()}" if title and title.strip() else ""
    return (
        f"You are {display_name}{role}, a bot in Hexbot. Be direct and concise: match the "
        "length of your reply to the weight of the ask. Use your tools when they help, ask "
        "when a request is ambiguous, and remember what matters about the people you work with."
    )


def _profile_details(name: str) -> dict:
    try:
        return gateway.call("profiles.describe", {"name": name})
    except GatewayError:
        logger.debug("profiles.describe failed for %s", name, exc_info=True)
        return {}


def _tools(detail: dict, row) -> list[str]:
    """The Tools tab keys that are on for this bot.

    Hexbot is the source of truth: ``profiles.describe`` resolves the
    ``enabled_toolsets`` pin (or every toolset when unpinned), so a new bot
    shows all five on, as it really is. The stored list is the fallback when
    the profile cannot be described.
    """
    toolsets = detail.get("toolsets")
    if isinstance(toolsets, list) and toolsets:
        enabled = {t.get("name") for t in toolsets if isinstance(t, dict) and t.get("enabled")}
        return [key for key, toolset in TOOL_TOOLSETS.items() if toolset in enabled]
    return json.loads(row["tools_json"] or "[]")


def _avatar(name: str):
    try:
        asset = gateway.call("profiles.get_asset", {"name": name, "asset": "avatar"})
    except GatewayError:
        return None
    if not asset.get("found"):
        return None
    return {"mime": asset.get("mime"), "data": asset.get("data")}


def _skill_names(skills) -> list[str]:
    """Normalise ``profiles.describe`` skill entries (dicts or strings) to names."""
    names = []
    for item in skills or []:
        name = item.get("name") if isinstance(item, dict) else item
        if isinstance(name, str) and name:
            names.append(name)
    return sorted(set(names))


def _status(name: str, all_sections: list[dict], live: dict[str, str],
            incidents: dict[str, dict]) -> tuple[str, dict | None]:
    """Fold the live signals into one status. Priority: stopped > needs_you > working."""
    incident = incidents.get(name)
    if incident is not None:
        action = None
        if incident["kind"] == "connector_error" and incident.get("connector"):
            action = {"kind": "fix_connector", "connector": incident["connector"]}
        elif incident["kind"] == "turn_failed":
            action = {"kind": "retry"}
        return "stopped", {"text": incident["text"], "section_id": incident["section_id"],
                           "room_id": incident["room_id"], "session_id": incident["session_id"],
                           "since": incident["created_at"], "action": action}
    by_status: dict[str, dict] = {}
    for item in all_sections:
        state = live.get(item["id"])
        if state in ("working", "starting", "waiting") and state not in by_status:
            by_status[state] = item
    waiting = by_status.get("waiting")
    if waiting is not None:
        return "needs_you", {"text": f"Waiting on you in “{waiting['title']}”.",
                             "section_id": waiting["id"], "room_id": None,
                             "session_id": waiting.get("live_session_id"),
                             "since": waiting.get("updated_at"), "action": None}
    room_wait = _room_waiting(name)
    if room_wait is not None:
        return "needs_you", room_wait
    working = by_status.get("working") or by_status.get("starting")
    if working is not None:
        return "working", {"text": f"Working in “{working['title']}”.",
                           "section_id": working["id"], "room_id": None,
                           "session_id": working.get("live_session_id"),
                           "since": working.get("updated_at"), "action": None}
    room_turn = _room_running(name)
    if room_turn is not None:
        return "working", room_turn
    return "idle", None


def _room_waiting(name: str) -> dict | None:
    """The newest room whose latest event is this bot tagging a human."""
    with db.transaction() as conn:
        row = conn.execute(
            "SELECT e.room_id, e.created_at, r.name AS room_name FROM room_events e "
            "JOIN rooms r ON r.id=e.room_id WHERE e.kind='waiting.human' AND e.actor_id=? "
            "AND e.seq=(SELECT MAX(seq) FROM room_events WHERE room_id=e.room_id) "
            "AND r.archived_at IS NULL ORDER BY e.created_at DESC LIMIT 1", (name,)).fetchone()
    if row is None:
        return None
    return {"text": f"Waiting on you in “{row['room_name']}”.", "section_id": None,
            "room_id": row["room_id"], "session_id": None, "since": row["created_at"],
            "action": None}


def _room_running(name: str) -> dict | None:
    with db.transaction() as conn:
        row = conn.execute(
            "SELECT t.room_id, t.started_at, r.name AS room_name FROM room_turns t "
            "JOIN rooms r ON r.id=t.room_id WHERE t.bot=? AND t.status='running' "
            "ORDER BY t.started_at DESC LIMIT 1", (name,)).fetchone()
    if row is None:
        return None
    return {"text": f"Working in “{row['room_name']}”.", "section_id": None,
            "room_id": row["room_id"], "session_id": None, "since": row["started_at"],
            "action": None}


def _shape(row, *, all_users=False, live=None, incidents=None) -> dict:
    from hexbot.incidents import open_incidents
    detail = _profile_details(row["name"])
    model = detail.get("model") or {}
    all_sections = sections.list_sections(
        row["name"], include_archived=True, all_users=all_users)
    # Dreams is a background section: never the one a client lands on or lists.
    recent = [item for item in all_sections
              if item["archived_at"] is None and item["title"] != "Dreams"][:2]
    if live is None:
        live = sections.live_statuses()
    if incidents is None:
        incidents = open_incidents([row["name"]])
    status, detail_row = _status(row["name"], all_sections, live, incidents)
    return {
        "name": row["name"],
        "display_name": row["display_name"] or default_display_name(row["name"]),
        "title": row["title"] or "",
        "description": row["description"] or detail.get("description", ""),
        "persona": detail.get("soul", ""),
        "skills": json.loads(row["skills_json"] or "[]"),
        "tools": _tools(detail, row),
        "dream_enabled": bool(row["dream_enabled"]),
        "shareable": bool(row["shareable"]),
        "notify": bool(row["notify"]),
        "approval_mode": row["approval_mode"] or "inherit",
        "workdir": row["workdir"] or None,
        "status": status,
        "status_detail": detail_row,
        "provider": model.get("provider"),
        "model": model.get("default"),
        "avatar": _avatar(row["name"]),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "last_activity_at": row["last_activity_at"],
        "owner_id": row["owner_id"],
        "sections_total": len(all_sections),
        "sections_recent": recent,
    }


def _row(name: str, *, enforce_owner=True):
    from hexbot.identity import current_user_id
    db.migrate()
    with db.transaction() as conn:
        row = conn.execute("SELECT * FROM bots WHERE name=?", (name,)).fetchone()
    if row is None:
        raise HexbotError(4205, f"bot not found: {name}")
    if enforce_owner and row["owner_id"] != current_user_id():
        raise HexbotError(4302, "not the owner")
    return row


def list_bots(*, all_users=False) -> list[dict]:
    from hexbot.identity import owner_filter
    owner = owner_filter(all_users)
    db.migrate()
    with db.transaction() as conn:
        sql = "SELECT * FROM bots"; args = []
        if owner is not None:
            sql += " WHERE owner_id=?"; args.append(owner)
        rows = conn.execute(sql + " ORDER BY last_activity_at DESC, name ASC", args).fetchall()
    from hexbot.incidents import open_incidents
    live = sections.live_statuses()
    incidents = open_incidents([row["name"] for row in rows])
    return [_shape(row, all_users=all_users, live=live, incidents=incidents) for row in rows]


def get_bot(name: str, *, all_users=False) -> dict:
    if all_users:
        from hexbot.identity import require_admin
        require_admin()
    db.migrate()
    return _shape(_row(name, enforce_owner=not all_users), all_users=all_users)


def create_bot(name: str, *, display_name=None, title=None, description=None,
               persona=None, provider=None, model=None, avatar=None) -> tuple[dict, dict]:
    """Create a bot: a Hexbot profile plus the Hexbot rows and first section.

    ``display_name`` falls back to the bot name in title case — never to
    ``title``, which is free-form caller text kept verbatim in the ``bots`` row.
    """
    db.migrate()
    from hermes_cli.profiles import get_profile_dir, validate_profile_name, write_profile_meta

    validate_profile_name(name)
    with db.transaction() as conn:
        if conn.execute("SELECT 1 FROM bots WHERE name=?", (name,)).fetchone():
            raise HexbotError(4208, f"bot already exists: {name}")
    display_name = (display_name or "").strip() or default_display_name(name)
    gateway.call("profiles.create", {
        "name": name, "description": description or "", "soul": (persona or "").strip() or default_persona(display_name or default_display_name(name), title),
        "model": model, "provider": provider, "mirror_credentials": True})
    profile_dir = get_profile_dir(name)
    write_profile_meta(profile_dir, description=description or "", display_name=display_name)
    if avatar is not None:
        gateway.call("profiles.set_asset", {"name": name, "asset": "avatar", "data": avatar})
    # Deployment settings (approval mode, auto-approver, workspace) are mirrored
    # into the fresh profile's config.yaml so a new bot inherits them without
    # waiting for the next hexbot.settings.set.
    mirror_deployment_config(profile_dir)
    from hexbot.identity import current_user_id
    owner_id = current_user_id()
    now = time.time()
    with db.transaction() as conn:
        conn.execute(
            "INSERT INTO bots(name,display_name,title,description,created_at,updated_at,"
            "last_activity_at,owner_id) VALUES (?,?,?,?,?,?,?,?)",
            (name, display_name, title or "", description or "", now, now, now, owner_id))
    section = sections.create_section(name, "General")
    try:
        from hexbot.dreaming import ensure_dream_job
        ensure_dream_job(get_bot(name))
    except Exception:
        logger.warning("could not create dream job for %s", name, exc_info=True)
    return get_bot(name), section


def update_bot(name: str, **patch) -> dict:
    _row(name)
    unknown = set(patch) - _UPDATABLE
    if unknown:
        raise HexbotError(4201, f"unknown bot field: {sorted(unknown)[0]}")
    configure = {"name": name}
    configure.update({k: v for k, v in patch.items()
                      if k in {"description", "provider", "model"} and v is not None})
    if patch.get("persona") is not None:
        configure["soul"] = patch["persona"]
    if "tools" in patch:
        tools = patch["tools"]
        if not isinstance(tools, list) or any(item not in TOOL_TOOLSETS for item in tools):
            raise HexbotError(4202, f"tools must be a list of {', '.join(TOOL_TOOLSETS)}")
        # ``enabled_toolsets`` is an allowlist, so pin the toolsets the UI does
        # not manage (memory, skills, web, image_gen, mcp-*, ...) exactly as
        # they are today and only swap the ones the Tools page shows.
        managed = set(TOOL_TOOLSETS.values())
        current = {t["name"] for t in _profile_details(name).get("toolsets") or []
                   if isinstance(t, dict) and t.get("enabled") and t.get("name")}
        chosen = {TOOL_TOOLSETS[item] for item in tools}
        pin_toolsets(name, (current - managed) | chosen)
    if "approval_mode" in patch and patch["approval_mode"] not in BOT_APPROVAL_MODES:
        raise HexbotError(4202, "approval_mode must be inherit, manual, smart, or off")
    if "workdir" in patch and patch["workdir"] is not None and (
            not isinstance(patch["workdir"], str) or not patch["workdir"].strip()):
        raise HexbotError(4202, "workdir must be a path or null")
    if "notify" in patch and not isinstance(patch["notify"], bool):
        raise HexbotError(4202, "notify must be a boolean")
    if "skills" in patch:
        skills = patch["skills"]
        if not isinstance(skills, list) or any(not isinstance(item, str) for item in skills):
            raise HexbotError(4202, "skills must be a list of skill names")
        detail = _profile_details(name)
        installed = set(_skill_names(detail.get("skills")))
        chosen = set(skills)
        unknown_skills = chosen - installed
        if unknown_skills:
            raise HexbotError(4202, f"unknown skill: {sorted(unknown_skills)[0]}")
        configure["disabled_skills"] = sorted(installed - chosen)
    if len(configure) > 1:
        gateway.call("profiles.configure", configure)
    if "avatar" in patch:
        params = {"name": name, "asset": "avatar"}
        params.update({"clear": True} if patch["avatar"] is None else {"data": patch["avatar"]})
        gateway.call("profiles.set_asset", params)
    if patch.get("display_name") or patch.get("description") is not None:
        from hermes_cli.profiles import get_profile_dir, write_profile_meta
        try:
            write_profile_meta(
                get_profile_dir(name),
                description=patch.get("description"),
                display_name=patch.get("display_name"))
        except (OSError, FileNotFoundError):
            logger.warning("could not update profile.yaml for %s", name, exc_info=True)
    values = dict(patch)
    if "workdir" in patch and patch["workdir"] is not None:
        values["workdir"] = patch["workdir"].strip()
    values["tools_json"] = json.dumps(list(dict.fromkeys(patch.get("tools", [])))) if "tools" in patch else None
    values["skills_json"] = json.dumps(list(dict.fromkeys(patch.get("skills", [])))) if "skills" in patch else None
    columns = [key for key in ("display_name", "title", "description", "dream_enabled",
                               "shareable", "notify", "approval_mode", "workdir",
                               "tools_json", "skills_json")
               if key in patch or key.removesuffix("_json") in patch]
    if columns:
        with db.transaction() as conn:
            assignments = ",".join(f"{key}=?" for key in columns)
            conn.execute(f"UPDATE bots SET {assignments},updated_at=? WHERE name=?",
                         [values[key] for key in columns] + [time.time(), name])
    if "approval_mode" in patch or "workdir" in patch:
        # The per-bot override lives in the bots row; the mirror reads it back
        # so the profile's config.yaml follows without a second code path.
        from hermes_cli.profiles import get_profile_dir
        try:
            mirror_deployment_config(get_profile_dir(name))
        except (OSError, FileNotFoundError):
            logger.warning("could not mirror settings into %s", name, exc_info=True)
    result = get_bot(name)
    if "dream_enabled" in patch:
        from hexbot.dreaming import ensure_dream_job
        ensure_dream_job(result)
    return result


def clear_status(name: str) -> dict:
    """Close every open incident for the bot and return it."""
    from hexbot.incidents import resolve
    _row(name)
    resolve(bot=name)
    return get_bot(name)


def busy_sections(name: str) -> list[tuple[str, str]]:
    """Return ``(section_id, status)`` for every section with a turn in flight."""
    statuses = sections.live_statuses()
    rows = sections.list_sections(name, include_archived=True)
    return [(item["id"], statuses[item["id"]])
            for item in rows
            if statuses.get(item["id"]) in sections.BUSY_STATUSES]


def delete_bot(name: str) -> bool:
    """Delete a bot, its sections and its profile directory.

    Refuses with 4211 only while one of its sections is mid-turn. Liveness comes
    from ``session.active_list`` (``status`` in ``working``/``waiting``), which
    is the only structured live-state source the gateway exposes —
    ``session.status`` returns a rendered text blob with no machine-readable
    state field.
    """
    from hermes_cli.profiles import delete_profile

    _row(name)
    busy = busy_sections(name)
    if busy:
        raise HexbotError(4211, f"bot {name} has a streaming section",
                          {"sections": [{"id": sid, "status": status} for sid, status in busy]})
    for item in sections.list_sections(name, include_archived=True):
        try:
            sections.delete_section(item["id"])
        except (GatewayError, HexbotError):
            # A stored session Hexbot has already lost must not strand the
            # bot; drop the Hexbot row and keep going.
            logger.warning("could not delete section %s cleanly", item["id"], exc_info=True)
            sections.close_section(item["id"])
            with db.transaction() as conn:
                conn.execute("DELETE FROM sections WHERE id=?", (item["id"],))
    with db.transaction() as conn:
        conn.execute("DELETE FROM sections WHERE bot=?", (name,))
        # Dream rows carry two copies of the bot's memory; they go with it.
        conn.execute("DELETE FROM dreams WHERE bot=?", (name,))
        conn.execute("DELETE FROM bots WHERE name=?", (name,))
    delete_profile(name, yes=True)
    return True
