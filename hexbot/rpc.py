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

from hexbot import (activity, bots, connect, connectors, dreaming, memory, network, pairing,
                    provider_login, providers, sections, settings, update, usage, users)
from hexbot.rooms import get_engine
from hexbot.rooms import store as rooms
from hexbot.errors import HexbotError

logger = logging.getLogger(__name__)

_BOT_CREATE_FIELDS = ("display_name", "title", "description", "persona",
                      "provider", "model", "avatar")
_BOT_UPDATE_FIELDS = _BOT_CREATE_FIELDS + ("dream_enabled", "shareable", "tools", "skills",
                                            "notify", "approval_mode", "workdir")


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


def _admin(fn):
    @functools.wraps(fn)
    def wrapped(params):
        from hexbot.identity import require_admin
        require_admin()
        return fn(params)
    return wrapped


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
            "pairing_supported": True, "update_capability": update.capability(),
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
    from hexbot.identity import current_user_id, owner_filter
    current = _current_device_id()
    return {"devices": [
        {"id": row.id, "name": row.name, "platform": row.platform,
         "created_at": row.created_at, "last_seen_at": row.last_seen_at,
         "current": row.id == current}
        for row in pairing.list_devices(owner_id=owner_filter(bool(_params.get("all"))))
    ]}


def _device_revoke(params) -> dict:
    from hexbot.identity import current_user_id
    return {"revoked": pairing.revoke_device(
        _required(params, "id"), owner_id=current_user_id())}


def _connect_register_start(params) -> dict:
    client = connect.ConnectClient()
    return client.register_start(params.get("daemon_name") or socket.gethostname(),
                                 platform.system().lower())


def _connect_register_poll(params) -> dict:
    client = connect.ConnectClient()
    result = client.register_poll(_required(params, "device_code"))
    state = result.get("status", "approved" if result.get("daemon_token") else "pending")
    result["status"] = state
    if state == "approved":
        connect.save_registration(result, client.api_base)
        from hexbot import serve
        connect.start_daemon(serve.state()["port"])
    return result


def _rooms_create(p):
    return {"room": rooms.create(_required(p, "name"), p.get("members", []),
                                  p.get("main_bot"), p.get("limits"),
                                  p.get("approval_mode"), humans=p.get("humans", []))}


def _rooms_update(p):
    patch = _fields(p, ("name", "main_bot", "approval_mode", "limits"), skip=("id",))
    return {"room": rooms.update(_required(p, "id"), **patch)}


def _rooms_send(p):
    from hexbot.identity import current_user_id
    room_id = _required(p, "id")
    event = rooms.append_event(room_id, "message.user", "human", current_user_id(),
                               {"text": _required(p, "text"), "attachments": p.get("attachments", [])})
    get_engine().notify(room_id)
    return {"event": event}


def _connectors_setup(p) -> dict:
    fields = _fields(p, ("id", "values", "provider", "bot", "enable_for_bot", "bot_only"), skip=())
    return connectors.setup(_required(p, "id"), fields.get("values"), provider=fields.get("provider"),
                            bot=fields.get("bot"), enable_for_bot=fields.get("enable_for_bot"),
                            bot_only=bool(fields.get("bot_only")))


def _connectors_add_mcp(p) -> dict:
    fields = _fields(p, ("name", "command", "args", "env", "url", "transport"), skip=())
    return connectors.add_mcp(_required(p, "name"), command=fields.get("command"),
                              args=fields.get("args"), env=fields.get("env"),
                              url=fields.get("url"), transport=fields.get("transport"))


def _dreams_list(params):
    args = (_required(params, "bot"), params.get("limit", 20))
    if params.get("all"):
        return dreaming.list_dreams(*args, all_users=True)
    return dreaming.list_dreams(*args)


METHODS = {
    "hexbot.info": info,
    "hexbot.settings.get": _admin(lambda p: settings.get_settings()),
    "hexbot.settings.set": _admin(lambda p: settings.update_settings(_required(p, "patch"))),
    "hexbot.bots.list": lambda p: {"bots": bots.list_bots(all_users=bool(p.get("all")))},
    "hexbot.bots.get": lambda p: {"bot": bots.get_bot(
        _required(p, "name"), all_users=bool(p.get("all")))},
    "hexbot.bots.create": _create_bot,
    "hexbot.bots.update": lambda p: {"bot": bots.update_bot(
        _required(p, "name"), **_fields(p, _BOT_UPDATE_FIELDS))},
    "hexbot.bots.delete": lambda p: {"deleted": bots.delete_bot(_required(p, "name"))},
    "hexbot.bots.clear_status": lambda p: {"bot": bots.clear_status(_required(p, "name"))},
    "hexbot.connectors.list": lambda p: connectors.list_connectors(p.get("bot") or None),
    "hexbot.connectors.setup": _admin(_connectors_setup),
    "hexbot.connectors.test": lambda p: connectors.test_connector(
        _required(p, "id"), bot=p.get("bot") or None),
    "hexbot.connectors.clear": _admin(lambda p: connectors.clear(
        _required(p, "id"), bot=p.get("bot") or None, bot_only=bool(p.get("bot_only")))),
    "hexbot.connectors.set_for_bot": lambda p: connectors.set_for_bot(
        _required(p, "id"), _required(p, "bot"), bool(p.get("enabled", True))),
    "hexbot.connectors.add_mcp": _admin(_connectors_add_mcp),
    "hexbot.connectors.remove_mcp": _admin(lambda p: connectors.remove_mcp(_required(p, "name"))),
    "hexbot.skills.list": lambda p: connectors.list_skills(_required(p, "bot")),
    "hexbot.sections.list": lambda p: {"sections": sections.list_sections(
        p.get("bot"), bool(p.get("include_archived")), all_users=bool(p.get("all")))},
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
    "hexbot.sections.mark_read": lambda p: {"section": sections.mark_read(_required(p, "id"))},
    "hexbot.memory.user.get": lambda p: memory.get_user_memory(),
    "hexbot.memory.user.set": lambda p: memory.set_user_memory(p.get("text", "")),
    "hexbot.memory.bot.get": lambda p: memory.get_bot_memory(_required(p, "bot")),
    "hexbot.memory.bot.set": lambda p: memory.set_bot_memory(
        _required(p, "bot"), p.get("memory_md", "")),
    "hexbot.providers.list": lambda p: {"providers": providers.list_providers()},
    "hexbot.providers.set_key": _admin(lambda p: providers.set_key(
        _required(p, "provider"), _required(p, "key"))),
    "hexbot.providers.clear_key": _admin(lambda p: providers.clear_key(_required(p, "provider"))),
    "hexbot.providers.login_start": _admin(lambda p: provider_login.start(_required(p, "provider"))),
    "hexbot.providers.login_poll": _admin(lambda p: provider_login.poll(_required(p, "login_id"))),
    "hexbot.providers.login_cancel": _admin(lambda p: provider_login.cancel(_required(p, "login_id"))),
    "hexbot.models.list": _list_models,
    "hexbot.network.get": _admin(lambda p: network.get_network()),
    "hexbot.update.request": _admin(lambda p: update.request(_required(p, "version"))),
    "hexbot.update.status": lambda p: update.status(),
    "hexbot.network.set": _admin(lambda p: network.set_network(_required(p, "lan_enabled"))),
    "hexbot.pairing.code": _admin(_pairing_code),
    "hexbot.devices.list": _devices_list,
    "hexbot.devices.revoke": _device_revoke,
    "hexbot.connect.status": _admin(lambda p: connect.status()),
    "hexbot.connect.disconnect": _admin(lambda p: connect.disconnect()),
    "hexbot.connect.register_start": _admin(_connect_register_start),
    "hexbot.connect.register_poll": _admin(_connect_register_poll),
    "hexbot.rooms.list": lambda p: {"rooms": rooms.list_rooms(
        bool(p.get("include_archived")), all_users=bool(p.get("all")))},
    "hexbot.rooms.get": lambda p: {"room": rooms.get(
        _required(p, "id"), all_users=bool(p.get("all")))},
    "hexbot.rooms.create": _rooms_create,
    "hexbot.rooms.update": _rooms_update,
    "hexbot.rooms.add_member": lambda p: {"room": rooms.add_member(_required(p, "id"), _required(p, "bot"))},
    "hexbot.rooms.remove_member": lambda p: {"room": rooms.remove_member(_required(p, "id"), _required(p, "bot"))},
    "hexbot.rooms.send": _rooms_send,
    "hexbot.rooms.log": lambda p: {"events": rooms.log(_required(p, "id"), p.get("after_seq", 0), p.get("limit", 200))},
    "hexbot.rooms.stop": lambda p: {"stopped": get_engine().stop(_required(p, "id"))},
    "hexbot.rooms.archive": lambda p: {"room": rooms.archive(_required(p, "id"))},
    "hexbot.rooms.delete": lambda p: {"deleted": rooms.delete(_required(p, "id"))},
    "hexbot.rooms.mark_read": lambda p: {"room": rooms.mark_read(_required(p, "id"), _required(p, "seq"))},
    "hexbot.activity.pairs": lambda p: {"pairs": activity.pairs(all_users=bool(p.get("all")))},
    "hexbot.activity.list": lambda p: {"messages": activity.list_messages(
        p.get("from"), p.get("to"), p.get("limit", 200), all_users=bool(p.get("all")))},
    "hexbot.dreaming.status": lambda p: dreaming.status(_required(p, "bot")),
    "hexbot.dreaming.run_now": lambda p: dreaming.run_now(_required(p, "bot")),
    "hexbot.dreaming.list": _dreams_list,
    "hexbot.users.me": lambda p: users.me(),
    "hexbot.users.list": _admin(lambda p: {"users": users.list_users()}),
    "hexbot.users.invite": _admin(lambda p: users.invite(
        _required(p, "display_name"), p.get("role", "member"))),
    "hexbot.users.update": _admin(lambda p: {"user": users.update_user(
        _required(p, "id"), **_fields(p, ("display_name", "role", "disabled", "limits"), skip=("id",))) }),
    "hexbot.usage.summary": lambda p: usage.summary(user_id=p.get("user"), since=p.get("since", 0)),
}

#: method -> broadcast event emitted after a successful mutation.
MUTATION_EVENTS = {
    "hexbot.bots.create": "hexbot.bots.changed",
    "hexbot.bots.update": "hexbot.bots.changed",
    "hexbot.bots.delete": "hexbot.bots.changed",
    "hexbot.bots.clear_status": "hexbot.bots.changed",
    "hexbot.connectors.setup": ("hexbot.connectors.changed", "hexbot.bots.changed"),
    "hexbot.connectors.clear": ("hexbot.connectors.changed", "hexbot.bots.changed"),
    "hexbot.connectors.set_for_bot": ("hexbot.connectors.changed", "hexbot.bots.changed"),
    "hexbot.connectors.add_mcp": ("hexbot.connectors.changed", "hexbot.bots.changed"),
    "hexbot.connectors.remove_mcp": ("hexbot.connectors.changed", "hexbot.bots.changed"),
    "hexbot.sections.create": "hexbot.sections.changed",
    "hexbot.sections.rename": "hexbot.sections.changed",
    "hexbot.sections.archive": "hexbot.sections.changed",
    "hexbot.sections.unarchive": "hexbot.sections.changed",
    "hexbot.sections.delete": "hexbot.sections.changed",
    "hexbot.sections.touch": "hexbot.sections.changed",
    "hexbot.sections.mark_read": "hexbot.sections.changed",
    "hexbot.memory.user.set": "hexbot.memory.user.changed",
    "hexbot.network.set": "hexbot.network.changed",
    "hexbot.connect.disconnect": "hexbot.connect.changed",
    "hexbot.connect.register_poll": "hexbot.connect.changed",
    "hexbot.rooms.create": "hexbot.rooms.changed",
    "hexbot.rooms.update": "hexbot.rooms.changed",
    "hexbot.rooms.add_member": "hexbot.rooms.changed",
    "hexbot.rooms.remove_member": "hexbot.rooms.changed",
    "hexbot.rooms.archive": "hexbot.rooms.changed",
    "hexbot.rooms.delete": "hexbot.rooms.changed",
    "hexbot.dreaming.run_now": "hexbot.dreaming.changed",
}


def _event_payload(params: dict, result: dict) -> dict:
    """Identify the mutated row from the result first, then the request."""
    section = result.get("section") if isinstance(result.get("section"), dict) else {}
    bot = result.get("bot") if isinstance(result.get("bot"), dict) else {}
    room = result.get("room") if isinstance(result.get("room"), dict) else {}
    payload = {}
    if section.get("id") or params.get("id"):
        payload["id"] = section.get("id") or params.get("id")
    if room.get("id"):
        payload["id"] = room["id"]
    if room.get("deleted") or (result.get("deleted") is True and params.get("id")):
        payload["deleted"] = True
    if bot.get("name") or section.get("bot") or params.get("bot") or params.get("name"):
        payload["bot"] = bot.get("name") or section.get("bot") or params.get("bot")
        payload.setdefault("name", bot.get("name") or params.get("name"))
    connector = result.get("connector") if isinstance(result.get("connector"), dict) else {}
    if connector.get("id"):
        payload["connector"] = connector["id"]
    return {key: value for key, value in payload.items() if value}


def _emitting(fn, event):
    events = event if isinstance(event, tuple) else (event,)

    @functools.wraps(fn)
    def wrapped(params):
        result = fn(params)
        from hexbot.gateway import broadcast
        payload = _event_payload(params, result if isinstance(result, dict) else {})
        for name in events:
            try:
                broadcast(name, payload)
            except Exception:
                logger.debug("could not broadcast %s", name, exc_info=True)
        return result

    return wrapped


def register(ctx) -> None:
    for name, fn in METHODS.items():
        event = MUTATION_EVENTS.get(name)
        ctx.register_rpc_method(name, _handler(_emitting(fn, event) if event else fn))
