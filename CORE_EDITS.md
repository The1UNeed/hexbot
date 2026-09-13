# Core edits

Every change to imported Hermes files is listed here with its reason. New
Hexbot code lives in `hexbot/`, `apps/desktop/`, `apps/web/` and Hermes
plugins, and is not listed.

| # | File(s) | Reason |
|---|---------|--------|
| 1 | (withdrawn) | Hexbot rooms run on their own engine over Hermes sessions (see `docs/rooms.md`), so Hosted Rooms and its member cap stay untouched. |
| 2 | `hermes_cli/plugins.py`, `tui_gateway/server.py` | Add `PluginContext.register_rpc_method` and a fallback lookup in `handle_request` so the hexbot plugin can expose `hexbot.*` JSON-RPC methods without editing the gateway. |
| 3 | `agent/opencode_affinity.py` (new), `agent/chat_completion_helpers.py`, `agent/auxiliary_client.py`, `tests/agent/test_opencode_session_affinity.py` | Port upstream Hermes `x-opencode-session` affinity header. OpenCode Go rejects requests without it (HTTP 400 "cannot be routed efficiently"), so every OpenCode request on every transport now carries the session key. Drop on the next upstream merge past 0.21.0. |
