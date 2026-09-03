"""Hexbot daemon launcher."""

from __future__ import annotations

import os
import sys
import threading

_serve_args: list[str] = []
_restart_scheduled = False


def run(host=None, port=None, lan=None):
    global _serve_args
    from hexbot import db
    from hexbot.home import ensure_layout
    from hexbot.settings import apply_settings_everywhere, get_settings
    ensure_layout(); db.migrate(); apply_settings_everywhere()
    enabled = get_settings()["lan_enabled"] if lan is None else lan
    host = host or ("0.0.0.0" if enabled else "127.0.0.1")
    port = port or int(os.environ.get("HEXBOT_PORT", "9119"))
    _serve_args = ["--host", host, "--port", str(port)]
    from hermes_cli.main import main
    old = sys.argv
    try:
        sys.argv = ["hermes", "serve", *_serve_args]
        return main()
    finally:
        sys.argv = old


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
