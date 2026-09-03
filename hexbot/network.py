"""LAN listener settings and address discovery."""

from __future__ import annotations

import json
import os
import socket

from hexbot.home import hexbot_home

from hexbot.settings import get_settings, update_settings


def lan_addresses() -> list[str]:
    found = []
    try:
        for item in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            found.append(item[4][0])
    except OSError:
        pass
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("8.8.8.8", 80)); found.append(sock.getsockname()[0])
    except OSError:
        pass
    finally:
        sock.close()
    return list(dict.fromkeys(address for address in found if not address.startswith("127.")))


def get_network() -> dict:
    enabled = bool(get_settings()["lan_enabled"])
    configured_port = os.environ.get("HEXBOT_PORT")
    port = int(configured_port or "9119")
    if configured_port is None:
        try:
            state = json.loads((hexbot_home() / "serve-state.json").read_text())
            port = int(state.get("port", port))
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            pass
    return {"lan_enabled": enabled, "bind_host": "0.0.0.0" if enabled else "127.0.0.1",
            "port": port, "addresses": lan_addresses()}


def set_network(lan_enabled: bool) -> dict:
    update_settings({"lan_enabled": bool(lan_enabled)})
    from hexbot.serve import request_restart
    request_restart()
    return {**get_network(), "restart_required": True}
