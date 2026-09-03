# Core edits

Every change to imported Hermes files is listed here with its reason. New
Hexbot code lives in `hexbot/`, `apps/desktop/`, `apps/web/` and Hermes
plugins, and is not listed.

| # | File(s) | Reason |
|---|---------|--------|
| 1 | `gateway/hosted_room_discussion.py`, `gateway/hosted_rooms.py`, `tui_gateway/methods_groups.py` | Remove the six-member room cap (Hexbot rooms have no member cap). |
| 2 | `hermes_cli/plugins.py`, `tui_gateway/server.py` | Add `PluginContext.register_rpc_method` and a fallback lookup in `handle_request` so the hexbot plugin can expose `hexbot.*` JSON-RPC methods without editing the gateway. |
