"""Hexbot JSON-RPC method registration.

Every handler returns a JSON-RPC frame built with ``tui_gateway.server._ok`` /
``_err``. Error codes: 4200-4299 for client mistakes (missing/unknown
parameters, unknown ids, cap violations, busy resources), 5200-5299 for server
faults, and any Hermes code that reaches us through
:class:`hexbot.errors.GatewayError` is passed through unchanged so a caller can
tell "Hermes said 4001" from "Hexbot said 4204".
"""

from __future__ import annotations

import functools
import logging
import platform
import socket
import sys

from hexbot import bots, memory, network, pairing, providers, sections, settings
from hexbot.errors import HexbotError

logger = logging.getLogger(__name__)

_BOT_CREATE_FIELDS = ("display_name", "title", "description", "persona",
                      "provider", "model", "avatar")
_BOT_UPDATE_FIELDS = _BOT_CREATE_FIELDS


def _required(params, key):
    value = params.get(key)
    if value is None or value == "":
        raise HexbotError(4200, f"missing parameter: {key}")
    return value


def _fields(params, allowed, *, skip=("name",)):
    unknown = set(params) - set(allowed) - set(skip)
    if unknown:
        raise HexbotError(4201, f"unknown parameter: {sorted(unknown)[0]}")
    return {key: params[key] for key in allowed if key in params}


def _handler(fn):
    @functools.wraps(fn)
    def wrapped(rid, params):
        from tui_gateway.server import _err, _ok
        try:
            return _ok(rid, fn(params if isinstance(params, dict) else {}))
        except HexbotError as exc:
            return _err(rid, exc.code, exc.message, exc.data)
        except Exception as exc:  # noqa: BLE001 - the RPC boundary
            logger.exception("hexbot RPC handler failed")
            return _err(rid, 5200, str(exc))

    return wrapped


def _web_app_state(attribute, default=None):
    """Read the running web server's app state without importing it."""
    module = sys.modules.get("hermes_cli.web_server")
    if module is None:
        return default
    return getattr(getattr(module, "app", None), "state", None) and getattr(
        module.app.state, attribute, default)


def info(_params) -> dict:
    from hexbot import __version__
    from hexbot.home import hexbot_home

    try:
        from hermes_cli import __version__ as hermes_version
    except ImportError:
        hermes_version = None
    install_id = None
    module = sys.modules.get("hermes_cli.web_server")
    if module is not None:
        try:
            install_id = module.get_install_id()
        except Exception:
            logger.debug("install id unavailable", exc_info=True)
    net = network.get_network()
    from hexbot.serve import state as serve_state
    return {"version": __version__, "hermes_version": hermes_version,
            "daemon_name": socket.gethostname(), "install_id": install_id,
            "auth_required": serve_state()["auth_required"],
            "pairing_supported": True,
            "lan_enabled": net["lan_enabled"], "addresses": net["addresses"],
            "platform": platform.system().lower(), "home": str(hexbot_home())}


def _create_bot(params) -> dict:
    name = _required(params, "name")
    bot, section = bots.create_bot(name, **_fields(params, _BOT_CREATE_FIELDS))
    return {"bot": bot, "section": section}


def _list_models(params) -> dict:
    return providers.list_models(
        params.get("provider"),
        include_unconfigured=params.get("include_unconfigured"),
        refresh=bool(params.get("refresh")))


def _pairing_code(_params) -> dict:
    code = pairing.new_code()
    net = network.get_network()
    addresses = net["addresses"]
    host = addresses[0] if addresses else net["bind_host"]
    return {"code": code, "expires_at": pairing.code_expires_at(code),
            "link": pairing.pair_link(host, net["port"], code), "addresses": addresses}


def _current_device_id() -> str | None:
    try:
        from tui_gateway.server import current_transport
        identity = getattr(current_transport(), "auth_identity", None) or {}
    except Exception:
        return None
    user_id = str(identity.get("user_id", ""))
    return user_id.removeprefix("device:") if user_id.startswith("device:") else None


def _devices_list(_params) -> dict:
    current = _current_device_id()
    return {"devices": [
        {"id": row.id, "name": row.name, "platform": row.platform,
         "created_at": row.created_at, "last_seen_at": row.last_seen_at,
         "current": row.id == current}
        for row in pairing.list_devices()
    ]}


METHODS = {
    "hexbot.info": info,
    "hexbot.settings.get": lambda p: settings.get_settings(),
    "hexbot.settings.set": lambda p: settings.update_settings(_required(p, "patch")),
    "hexbot.bots.list": lambda p: {"bots": bots.list_bots()},
    "hexbot.bots.get": lambda p: {"bot": bots.get_bot(_required(p, "name"))},
    "hexbot.bots.create": _create_bot,
    "hexbot.bots.update": lambda p: {"bot": bots.update_bot(
        _required(p, "name"), **_fields(p, _BOT_UPDATE_FIELDS))},
    "hexbot.bots.delete": lambda p: {"deleted": bots.delete_bot(_required(p, "name"))},
    "hexbot.sections.list": lambda p: {"sections": sections.list_sections(
        p.get("bot"), bool(p.get("include_archived")))},
    "hexbot.sections.create": lambda p: {"section": sections.create_section(
        _required(p, "bot"), p.get("title"))},
    "hexbot.sections.open": lambda p: sections.open_section(_required(p, "id")),
    "hexbot.sections.rename": lambda p: {"section": sections.rename_section(
        _required(p, "id"), _required(p, "title"))},
    "hexbot.sections.archive": lambda p: {"section": sections.archive_section(
        _required(p, "id"))},
    "hexbot.sections.unarchive": lambda p: {"section": sections.unarchive_section(
        _required(p, "id"))},
    "hexbot.sections.delete": lambda p: {"deleted": sections.delete_section(
        _required(p, "id"), bool(p.get("purge_memory", True)))},
    "hexbot.sections.touch": lambda p: {"section": sections.touch_section(_required(p, "id"))},
    "hexbot.memory.core.get": lambda p: memory.get_core_memory(),
    "hexbot.memory.core.set": lambda p: memory.set_core_memory(
        _required(p, "section"), p.get("text", "")),
    "hexbot.memory.bot.get": lambda p: memory.get_bot_memory(_required(p, "bot")),
    "hexbot.memory.bot.set": lambda p: memory.set_bot_memory(
        _required(p, "bot"), p.get("memory_md"), p.get("user_md")),
    "hexbot.providers.list": lambda p: {"providers": providers.list_providers()},
    "hexbot.providers.set_key": lambda p: providers.set_key(
        _required(p, "provider"), _required(p, "key")),
    "hexbot.providers.clear_key": lambda p: providers.clear_key(_required(p, "provider")),
    "hexbot.models.list": _list_models,
    "hexbot.network.get": lambda p: network.get_network(),
    "hexbot.network.set": lambda p: network.set_network(_required(p, "lan_enabled")),
    "hexbot.pairing.code": _pairing_code,
    "hexbot.devices.list": _devices_list,
    "hexbot.devices.revoke": lambda p: {"revoked": pairing.revoke_device(_required(p, "id"))},
}

#: method -> broadcast event emitted after a successful mutation.
MUTATION_EVENTS = {
    "hexbot.bots.create": "hexbot.bots.changed",
    "hexbot.bots.update": "hexbot.bots.changed",
    "hexbot.bots.delete": "hexbot.bots.changed",
    "hexbot.sections.create": "hexbot.sections.changed",
    "hexbot.sections.rename": "hexbot.sections.changed",
    "hexbot.sections.archive": "hexbot.sections.changed",
    "hexbot.sections.unarchive": "hexbot.sections.changed",
    "hexbot.sections.delete": "hexbot.sections.changed",
    "hexbot.sections.touch": "hexbot.sections.changed",
    "hexbot.memory.core.set": "hexbot.memory.core.changed",
    "hexbot.network.set": "hexbot.network.changed",
}


def _event_payload(params: dict, result: dict) -> dict:
    """Identify the mutated row from the result first, then the request."""
    section = result.get("section") if isinstance(result.get("section"), dict) else {}
    bot = result.get("bot") if isinstance(result.get("bot"), dict) else {}
    payload = {}
    if section.get("id") or params.get("id"):
        payload["id"] = section.get("id") or params.get("id")
    if bot.get("name") or section.get("bot") or params.get("bot") or params.get("name"):
        payload["bot"] = bot.get("name") or section.get("bot") or params.get("bot")
        payload.setdefault("name", bot.get("name") or params.get("name"))
    return {key: value for key, value in payload.items() if value}


def _emitting(fn, event):
    @functools.wraps(fn)
    def wrapped(params):
        result = fn(params)
        from hexbot.gateway import broadcast
        try:
            broadcast(event, _event_payload(params, result if isinstance(result, dict) else {}))
        except Exception:
            logger.debug("could not broadcast %s", event, exc_info=True)
        return result

    return wrapped


def register(ctx) -> None:
    for name, fn in METHODS.items():
        event = MUTATION_EVENTS.get(name)
        ctx.register_rpc_method(name, _handler(_emitting(fn, event) if event else fn))
