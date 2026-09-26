"""Deployment settings and profile config mirroring."""

from __future__ import annotations

import json
import logging
from pathlib import Path

from ruamel.yaml import YAML

from hexbot import db
from hexbot.errors import HexbotError
from hexbot.home import DEFAULT_WORKSPACE, hexbot_home

logger = logging.getLogger(__name__)

DEFAULTS = {"approval_mode": "manual", "auto_approver_model": None,
            "lan_enabled": False, "service_installed": False,
            "workspace_dir": str(DEFAULT_WORKSPACE), "billing_notice_ack": False,
            "room_bot_turns_per_human_turn": 8,
            "room_budget_tokens_per_human_turn": None,
            "bot_daily_token_budget": None,
            "dream_time": "03:00", "dream_enabled": True,
            # "provider/model" pre-filled for new bots, and the model bots fall
            # back to when their own provider fails. Both optional.
            "default_model": None, "fallback_model": None}

#: The core calls the auto-approval mode ``smart``; the UI labels it "Auto".
APPROVAL_MODES = ("manual", "smart", "off")

#: Replaces the Hexbot platform hint, which for a section (platform ``tui``,
#: the gateway's default) tells the bot it is in a terminal where markdown does
#: not render, and for a room (source ``hexbot_room``) says nothing. Tools are
#: resolved under ``cli`` (``SESSION_PLATFORM``); that key plays no part in the
#: prompt. What the user actually sees is the Hexbot chat.
HINT_PLATFORMS = ("tui", "hexbot_room")
PLATFORM_HINT = (
    "You are chatting in Hexbot, a desktop app. Markdown renders with GitHub "
    "flavor: headings, lists, tables and fenced code. To hand over a file, give "
    "its absolute path or URL; the user opens it themselves. Scheduled jobs run "
    "on their own and their output is not delivered back into this conversation."
)


def get_settings() -> dict:
    db.migrate()
    result = dict(DEFAULTS)
    with db.transaction() as conn:
        for row in conn.execute("SELECT key, value FROM settings"):
            if row["key"] in result:
                try:
                    result[row["key"]] = json.loads(row["value"])
                except json.JSONDecodeError:
                    logger.warning("dropping unreadable setting %s", row["key"])
    return result


def update_settings(patch: dict) -> dict:
    if not isinstance(patch, dict):
        raise HexbotError(4201, "patch must be an object")
    unknown = set(patch) - set(DEFAULTS)
    if unknown:
        raise HexbotError(4201, f"unknown setting: {sorted(unknown)[0]}")
    if "approval_mode" in patch and patch["approval_mode"] not in APPROVAL_MODES:
        raise HexbotError(4202, "approval_mode must be manual, smart, or off")
    for key in ("auto_approver_model", "default_model", "fallback_model"):
        if key in patch and patch[key] is not None and "/" not in str(patch[key]):
            raise HexbotError(4202, f"{key} must be 'provider/model'")
    if "dream_enabled" in patch and not isinstance(patch["dream_enabled"], bool):
        raise HexbotError(4202, "dream_enabled must be a boolean")
    if "dream_time" in patch:
        import re
        if not isinstance(patch["dream_time"], str) or not re.fullmatch(
                r"(?:[01]\d|2[0-3]):[0-5]\d", patch["dream_time"]):
            raise HexbotError(4202, "dream_time must be HH:MM in local time")
    for key in ("room_bot_turns_per_human_turn",
                "room_budget_tokens_per_human_turn", "bot_daily_token_budget"):
        if key in patch and (patch[key] is not None) and (
                isinstance(patch[key], bool) or not isinstance(patch[key], int) or patch[key] < 0):
            raise HexbotError(4202, f"{key} must be a non-negative integer or null")
    db.migrate()
    with db.transaction() as conn:
        for key, value in patch.items():
            conn.execute("INSERT OR REPLACE INTO settings(key,value) VALUES (?,?)",
                         (key, json.dumps(value)))
    apply_settings_everywhere()
    if "dream_time" in patch or "dream_enabled" in patch:
        try:
            from hexbot.bots import list_bots
            from hexbot.dreaming import ensure_dream_job, ensure_room_dream_job
            for bot in list_bots():
                ensure_dream_job(bot)
            from hexbot.rooms.store import list_rooms
            for room in list_rooms(include_archived=False):
                if room.get("main_bot"):
                    ensure_room_dream_job(room)
        except Exception:
            logger.warning("could not update dream jobs", exc_info=True)
    return get_settings()


def mirror_deployment_config(profile_dir: Path) -> None:
    """Write the deployment settings into one profile's ``config.yaml``.

    Round-trips with ruamel so unrelated keys, comments and ordering survive.
    """
    settings = get_settings()
    override = _bot_overrides(Path(profile_dir).name)
    path = Path(profile_dir) / "config.yaml"
    yaml = YAML(typ="rt")
    try:
        data = yaml.load(path.read_text()) if path.exists() else None
    except Exception:
        logger.warning("could not parse %s; rewriting the managed keys only", path)
        data = None
    data = data if isinstance(data, dict) else {}
    mode = override.get("approval_mode") or settings["approval_mode"]
    data.setdefault("approvals", {})["mode"] = mode
    workdir = Path(override.get("workdir") or settings["workspace_dir"]).expanduser()
    # A missing cwd makes Hexbot fall back to the daemon's launch directory and
    # load whatever AGENTS.md it finds there as project context.
    try:
        workdir.mkdir(parents=True, exist_ok=True)
    except OSError:
        logger.warning("could not create working directory %s", workdir)
    data.setdefault("terminal", {})["cwd"] = str(workdir)
    hints = data.setdefault("platform_hints", {})
    for platform in HINT_PLATFORMS:
        hints[platform] = {"replace": PLATFORM_HINT}
    # A bot keeps one memory file. Facts about the user live in the shared
    # About you text, so the Hexbot USER.md target stays off.
    data.setdefault("memory", {})["user_profile_enabled"] = False
    choice = settings["auto_approver_model"]
    if choice:
        provider, _, model = str(choice).partition("/")
        approval = data.setdefault("auxiliary", {}).setdefault("approval", {})
        approval["provider"], approval["model"] = provider, model
    fallback = settings.get("fallback_model")
    if fallback:
        provider, _, model = str(fallback).partition("/")
        data["fallback_providers"] = [{"provider": provider, "model": model}]
    elif "fallback_providers" in data:
        del data["fallback_providers"]
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w") as stream:
        yaml.dump(data, stream)


def _bot_overrides(name: str) -> dict:
    """Per-bot approval mode and working directory, when the bot row has them."""
    db.migrate()
    with db.transaction() as conn:
        row = conn.execute("SELECT approval_mode, workdir FROM bots WHERE name=?",
                           (name,)).fetchone()
    if row is None:
        return {}
    mode = row["approval_mode"] if row["approval_mode"] in APPROVAL_MODES else None
    return {"approval_mode": mode, "workdir": row["workdir"] or None}


def apply_settings_everywhere() -> None:
    """Mirror settings into the root config and every bot profile."""
    home = hexbot_home()
    mirror_deployment_config(home)
    profiles = home / "profiles"
    if not profiles.exists():
        return
    for path in sorted(profiles.iterdir()):
        if path.is_dir():
            mirror_deployment_config(path)
