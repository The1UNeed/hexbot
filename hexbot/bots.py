"""Bot registry layered over Hermes profiles."""

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
     "dream_enabled", "may_write_core", "shareable", "tools", "skills"}
)

TOOL_TOOLSETS = {"terminal": "terminal", "files": "file", "browser": "browser",
                 "web_search": "search", "computer_use": "computer_use"}


def default_display_name(name: str) -> str:
    """``research-scout`` -> ``Research Scout``."""
    return name.replace("-", " ").replace("_", " ").title()


def default_persona(display_name: str, title: str | None = None) -> str:
    """Persona used when a bot is created without one (never the Hermes default)."""
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


def _shape(row, *, all_users=False) -> dict:
    detail = _profile_details(row["name"])
    model = detail.get("model") or {}
    all_sections = sections.list_sections(
        row["name"], include_archived=True, all_users=all_users)
    recent = [item for item in all_sections if item["archived_at"] is None][:2]
    return {
        "name": row["name"],
        "display_name": row["display_name"] or default_display_name(row["name"]),
        "title": row["title"] or "",
        "description": row["description"] or detail.get("description", ""),
        "persona": detail.get("soul", ""),
        "skills": json.loads(row["skills_json"] or "[]"),
        "tools": json.loads(row["tools_json"] or "[]"),
        "dream_enabled": bool(row["dream_enabled"]),
        "may_write_core": bool(row["may_write_core"]),
        "shareable": bool(row["shareable"]),
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
    return [_shape(row, all_users=all_users) for row in rows]


def get_bot(name: str, *, all_users=False) -> dict:
    if all_users:
        from hexbot.identity import require_admin
        require_admin()
    db.migrate()
    return _shape(_row(name, enforce_owner=not all_users), all_users=all_users)


def create_bot(name: str, *, display_name=None, title=None, description=None,
               persona=None, provider=None, model=None, avatar=None) -> tuple[dict, dict]:
    """Create a bot: a Hermes profile plus the Hexbot rows and first section.

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
            raise HexbotError(4202, "tools must contain terminal, files, browser, web_search, or computer_use")
        configure["enabled_toolsets"] = [TOOL_TOOLSETS[item] for item in dict.fromkeys(tools)]
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
    values["tools_json"] = json.dumps(list(dict.fromkeys(patch.get("tools", [])))) if "tools" in patch else None
    values["skills_json"] = json.dumps(list(dict.fromkeys(patch.get("skills", [])))) if "skills" in patch else None
    columns = [key for key in ("display_name", "title", "description", "dream_enabled",
                               "shareable",
                               "may_write_core", "tools_json", "skills_json")
               if key in patch or key.removesuffix("_json") in patch]
    if columns:
        with db.transaction() as conn:
            assignments = ",".join(f"{key}=?" for key in columns)
            conn.execute(f"UPDATE bots SET {assignments},updated_at=? WHERE name=?",
                         [values[key] for key in columns] + [time.time(), name])
    result = get_bot(name)
    if "dream_enabled" in patch:
        from hexbot.dreaming import ensure_dream_job
        ensure_dream_job(result)
    return result


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
            # A stored session Hermes has already lost must not strand the
            # bot; drop the Hexbot row and keep going.
            logger.warning("could not delete section %s cleanly", item["id"], exc_info=True)
            sections.close_section(item["id"])
            with db.transaction() as conn:
                conn.execute("DELETE FROM sections WHERE id=?", (item["id"],))
    with db.transaction() as conn:
        conn.execute("DELETE FROM sections WHERE bot=?", (name,))
        conn.execute("DELETE FROM bots WHERE name=?", (name,))
    delete_profile(name, yes=True)
    return True
