"""Deployment settings and profile config mirroring."""

from __future__ import annotations

import json
from pathlib import Path

from ruamel.yaml import YAML

from hexbot import db
from hexbot.errors import HexbotError
from hexbot.home import DEFAULT_WORKSPACE, hexbot_home

DEFAULTS = {"approval_mode": "manual", "auto_approver_model": None,
            "lan_enabled": False, "service_installed": False,
            "workspace_dir": str(DEFAULT_WORKSPACE), "billing_notice_ack": False}


def get_settings() -> dict:
    db.migrate()
    result = dict(DEFAULTS)
    with db.connect() as conn:
        for row in conn.execute("SELECT key, value FROM settings"):
            if row["key"] in result:
                result[row["key"]] = json.loads(row["value"])
    return result


def update_settings(patch: dict) -> dict:
    unknown = set(patch) - set(DEFAULTS)
    if unknown:
        raise HexbotError(4201, f"unknown setting: {sorted(unknown)[0]}")
    if "approval_mode" in patch and patch["approval_mode"] not in {"manual", "smart", "off"}:
        raise HexbotError(4202, "approval_mode must be manual, smart, or off")
    with db.connect() as conn:
        for key, value in patch.items():
            conn.execute("INSERT OR REPLACE INTO settings(key,value) VALUES (?,?)",
                         (key, json.dumps(value)))
    apply_settings_everywhere()
    return get_settings()


def mirror_deployment_config(profile_dir: Path) -> None:
    settings = get_settings()
    path = profile_dir / "config.yaml"
    yaml = YAML(typ="rt")
    data = yaml.load(path.read_text() if path.exists() else "") or {}
    data.setdefault("approvals", {})["mode"] = settings["approval_mode"]
    data.setdefault("terminal", {})["cwd"] = str(Path(settings["workspace_dir"]).expanduser())
    auxiliary = data.setdefault("auxiliary", {}).setdefault("approval", {})
    choice = settings["auto_approver_model"]
    if choice:
        provider, _, model = choice.partition("/")
        auxiliary["provider"], auxiliary["model"] = provider, model
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w") as stream:
        yaml.dump(data, stream)


def apply_settings_everywhere() -> None:
    home = hexbot_home()
    mirror_deployment_config(home)
    profiles = home / "profiles"
    if profiles.exists():
        for path in profiles.iterdir():
            if path.is_dir():
                mirror_deployment_config(path)
