"""Calls into the Hermes gateway registry."""

from __future__ import annotations

import uuid

from hexbot.errors import GatewayError


def call(method: str, params: dict, rid=None) -> dict:
    from tui_gateway import server as gw

    request_id = rid if rid is not None else uuid.uuid4().hex
    fn = gw._methods.get(method)
    if fn is None:
        from hermes_cli.plugins import lookup_plugin_rpc_method
        fn = lookup_plugin_rpc_method(method)
    if fn is None:
        raise GatewayError(-32601, f"unknown method: {method}")
    frame = fn(request_id, params)
    if "error" in frame:
        error = frame["error"]
        raise GatewayError(error["code"], error["message"], error.get("data"))
    return frame.get("result", {})


def broadcast(event: str, payload: dict) -> None:
    from tui_gateway import server as gw
    gw._broadcast_global_event(event, payload)
