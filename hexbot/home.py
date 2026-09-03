"""Hexbot filesystem layout."""

from __future__ import annotations

import os
from pathlib import Path

DEFAULT_HOME = Path("~/.hexbot")
DEFAULT_WORKSPACE = Path("~/Hexbot")
DATABASE_NAME = "hexbot.db"


def hexbot_home() -> Path:
    path = Path(os.environ.get("HEXBOT_HOME", str(DEFAULT_HOME))).expanduser()
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.chmod(0o700)
    return path


def ensure_layout() -> Path:
    home = hexbot_home()
    (home / "profiles").mkdir(mode=0o700, exist_ok=True)
    workspace = Path(os.environ.get("HEXBOT_WORKSPACE", str(DEFAULT_WORKSPACE))).expanduser()
    try:
        workspace.mkdir(parents=True, exist_ok=True)
    except PermissionError:
        # Read-only service accounts can still serve an existing deployment;
        # terminal use will report the inaccessible configured cwd itself.
        pass
    return home
