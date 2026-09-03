"""Hexbot daemon launcher."""

from __future__ import annotations

import json
import os
import sys
import threading
from pathlib import Path

_serve_args: list[str] = []
_restart_scheduled = False
_bind_host = "127.0.0.1"
_bind_port = 9119


def state() -> dict:
    return {"host": _bind_host, "port": _bind_port,
            "auth_required": _bind_host not in {"localhost", "127.0.0.1", "::1"}}


def _web_dist() -> Path | None:
    configured = os.environ.get("HEXBOT_WEB_DIST")
    candidate = (Path(configured).expanduser() if configured
                 else Path(__file__).parents[1] / "apps/web/dist")
    return candidate.resolve() if (candidate / "index.html").is_file() else None


def run(host=None, port=None, lan=None):
    global _serve_args, _bind_host, _bind_port
    from hexbot import db
    from hexbot.home import ensure_layout
    from hexbot.settings import apply_settings_everywhere, get_settings
    ensure_layout(); db.migrate(); apply_settings_everywhere()
    enabled = get_settings()["lan_enabled"] if lan is None else lan
    host = host or ("0.0.0.0" if enabled else "127.0.0.1")
    port = port or int(os.environ.get("HEXBOT_PORT", "9119"))
    _bind_host, _bind_port = host, port
    os.environ["HEXBOT_PORT"] = str(port)
    runtime_path = ensure_layout() / "serve-state.json"
    runtime_path.write_text(json.dumps({"host": host, "port": port}) + "\n")
    os.chmod(runtime_path, 0o600)
    _serve_args = ["--host", host, "--port", str(port)]
    web_dist = _web_dist()
    command = "serve"
    extra = []
    if web_dist is not None:
        os.environ["HERMES_WEB_DIST"] = str(web_dist)
        command = "dashboard"
        extra = ["--skip-build", "--no-open"]
    from hermes_cli.main import main

    _start_cron_ticker()
    from hexbot import connect
    connect.start_daemon(port)
    old = sys.argv
    try:
        sys.argv = ["hermes", command, *extra, *_serve_args]
        return main()
    finally:
        sys.argv = old
        connect.stop_daemon()


def request_restart():
    global _restart_scheduled
    if _restart_scheduled or not _serve_args:
        return
    _restart_scheduled = True
    def restart():
        import time
        time.sleep(0.5)
        os.execv(sys.executable, [sys.executable, "-m", "hexbot.cli", "serve", *_serve_args])
    threading.Thread(target=restart, daemon=True).start()


def _start_cron_ticker(interval: int = 60) -> None:
    """Tick every profile's cron store in-process.

    Hermes only starts its ticker when spawned by Hermes Desktop
    (``HERMES_DESKTOP=1``); ``hexbot serve`` must do it itself so scheduled
    dreams and routines fire without a separate gateway process.
    """
    import logging
    import threading

    try:
        from hermes_cli.web_server import _start_desktop_cron_ticker
    except Exception:  # pragma: no cover - defensive
        logging.getLogger(__name__).exception("cron ticker unavailable")
        return
    stop = threading.Event()
    threading.Thread(
        target=_start_desktop_cron_ticker, args=(stop, interval), name="hexbot-cron", daemon=True
    ).start()
