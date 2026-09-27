# Core `/api/ws` JSON-RPC reference (chat-client subset)

Read at the v0.21.0 fork point.

Route: `hermes_cli/web_server.py:17727` `@app.websocket("/api/ws")` → `tui_gateway/ws.py:handle_ws` →
`tui_gateway/server.py:dispatch` → `_methods` (`server.py:145`).

## 1. Wire format

Newline-delimited JSON-RPC 2.0, text frames, both directions (`ws.py:8-12`). No batching.

**Request** `{"jsonrpc":"2.0","id":<any>,"method":"prompt.submit","params":{...}}`. `params` must be an
object or omitted (`_normalize_request`, `server.py:3149`).

**Response** `_ok`/`_err` (`server.py:3130-3138`):
`{"jsonrpc":"2.0","id":rid,"result":{...}}` / `{"jsonrpc":"2.0","id":rid,"error":{"code":4001,"message":"session not found","data":{...}}}`.

**Server→client events** are JSON-RPC *notifications* with the literal method `"event"`
(`_event_frame`, `server.py:2599`):

```json
{"jsonrpc":"2.0","method":"event",
 "params":{"type":"message.delta","session_id":"a1b2c3d4","seq":42,"payload":{"text":"Hel"}}}
```

`seq` is stamped per session by `event_replay._stamp_event` (ring of 512 frames × 64 sessions).
Session-less globals (`skin.changed`) carry `session_id:""` and no `seq`.

**First frame after accept** (`ws.py:395`):
`{"jsonrpc":"2.0","method":"event","params":{"type":"gateway.ready","payload":{"skin":{...},"change_events":true,"heartbeat":true,"replay_epoch":"<opaque>"}}}`

### Stream event catalogue (all `params.type` values a chat client needs)

| type | payload | source |
|---|---|---|
| `message.start` | *(none)* | `server.py:13153` — turn begins |
| `message.delta` | `{text, rendered?}` | `server.py:13426` — assistant text token |
| `message.interim` | `{text, already_streamed}` | `server.py:13439` — commentary alongside tool calls |
| `message.complete` | `{text, usage, rendered?, status?, error?, recoverable?, partial?, error_surface?}` | `server.py:10813`, `13748` — **turn completion** |
| `thinking.delta` | `{text}` | `server.py:8416` |
| `reasoning.delta` / `reasoning.available` | `{text}` | `server.py:8370` |
| `tool.start` | `{tool_id, name, context, args?, args_text?}` | `_on_tool_start`, `server.py:8097` |
| `tool.complete` | `{tool_id, name, args, result, duration_s?, summary?, inline_diff?, result_text?}` | `_on_tool_complete`, `server.py:8151` |
| `tool.generating`, `tool.output_risk` | `{name}` / risk info | `server.py:8415` |
| `todo.updated` | `{todos, revision}` | `server.py:8156` |
| `approval.request` | `{request_id, command?, choices:["once","session","always","deny"], smart_denied?, ...}` | `_emit_approval_request`, `server.py:3086` |
| `status.update` | `{kind, text}` (`kind` ∈ status/loop/process/compacting) | `server.py:3102` |
| `session.info` | full info dict (model, provider, tools, skills, cwd, branch, project, profile_name) | `server.py:2887` |
| `session.usage` | `{usage}` | `server.py:13071` |
| `error` | `{message}` | `server.py:3006`, `10668`, `13957` |
| others | `moa.*`, `voice.*`, `wake.detected`, `browser.progress`, `terminal.close`, `notification.clear`, `pet.*`, `preview.restart.*`, `reaction`, `skin.changed` | — |

There is **no** `turn.end` on this socket. `turn.start/started/end/error` (`compute_host.py`) is the
internal gateway↔compute-host protocol. Client turn completion == `message.complete`.

Streaming coalescing: `message.delta`, `reasoning.delta`, `thinking.delta` are buffered ~33 ms and
flushed as a batch; every other frame drains the buffer ahead of itself, so order is preserved
(`ws.py:76-88`).

Reconnect: call `session.events.since {session_id, last_seen}` → `{events, latest_seq, truncated, count, epoch}`.
`events[]` elements are bare event objects (the `params` dict). Compare `epoch` to the `replay_epoch`
from `gateway.ready`; mismatch means the backend restarted — reset watermarks.

## 2. Methods

`gateway.ping` is intercepted in `ws.py:498` (never reaches `_methods`) and answers `{"ok":true}` on the
reader thread. `ping` → `{"pong":true}`. `gateway.capabilities` → `{"per_session_exclusive_submit":true}`.
There is **no** in-band auth method or version method — auth happens at the WS upgrade
(`_ws_auth_ok`, subprotocol `hermes-gateway-v1` + `hermes-gateway-ticket.<t>`, or legacy `?token=`;
close codes 4401 auth / 4403 forbidden / 4400 bad).

### Sessions
`session.create` `session.list` `session.resume` `session.activate` `session.close` `session.delete`
`session.title` `session.history` `session.status` `session.usage` `session.branch` `session.compress`
`session.context_breakdown` `session.cwd.set` `session.events.since` `session.events.stats`
`session.interrupt` `session.most_recent` `session.redirect` `session.save` `session.set_hidden`
`session.steer` `session.undo` `session.workspace.move` `session.active_list`

- **`session.create`** (`methods_session.py:14`) params: `cols`, `messages` (seed history), `title`,
  `parent_session_id`, `cwd`, `source`, `profile`, `model`, `provider`, `reasoning_effort`, `fast`,
  `hidden`, `close_on_disconnect`, `room_plumbing`, `follow_profile_config`.
  Result: `{session_id, stored_session_id, message_count, messages[], info:{model, provider?, tools, skills, cwd, branch, project, lazy, desktop_contract, profile_name}}`.
  The agent is built asynchronously; watch for `session.info`.
- **`session.list`** params: `profile`, `limit` (200), `include_hidden`, `title` (exact-title registry lookup).
  Result `{sessions:[{id, resolved_id?, title, preview, started_at, message_count, source}]}`.
- **`session.resume`** params: `session_id` (**stored** id or title), `cols`, `profile`, `lazy`,
  `defer_history`, `omit_messages`.
- **`session.history`** params: `session_id` (**live** id). Result `{count, messages[]}`;
  messages are the `_history_to_messages` display projection (`server.py:9787`) — roles
  user/assistant/tool/system, tool rows carry `{role:"tool", name, context, args}`, `row_id` when stamped,
  `display_kind:"hidden"` rows filtered out.
- **`session.delete`** params `{session_id (stored), profile?}` → `{deleted}`; 4023 if the session is live.
- **`session.title`** params `{session_id, title?}` (omit `title` to read).
- **Rename** = `session.title`. **Switch** = `session.activate` (already-live sid) or `session.resume`.

### Chat / turn control
`prompt.submit` `prompt.background` `prompt.btw` `session.interrupt` `session.steer` `session.redirect`
`message.react` `clarify.respond` `slash.exec` `command.dispatch` `command.resolve` `commands.catalog`
`complete.path` `complete.slash` `paste.collapse` `llm.oneshot` `cli.exec` `shell.exec`

- **`prompt.submit`** (`methods_prompt.py:287`) params: `session_id`, `text`, `queued` (bool — never
  becomes a live-turn correction), `surface` (`"hud"`), `display_kind:"hidden"`, `interrupted`,
  `truncate_before_user_ordinal|_row_id|_message_id`. Result `{status:"streaming", survivor_user_row_ids?, survivor_row_id_map?}`.
  Attached images are consumed from the session's `attached_images` list at submit.
- Submitting while a turn runs is not an error: `_handle_busy_submit` (`server.py:10508`) applies
  `display.busy_input_mode` (`interrupt` default / `queue` / `steer`).
- **`session.interrupt`** `{session_id, expected_hosted_task_id?}` → `{status:"interrupted"|"not_interrupted"}`.
- **`session.steer`** `{session_id, text}` → `{status:"queued"|"rejected", text}` — injects into the next
  tool result without interrupting. **`session.redirect`** replaces the live turn's instruction.

### Attachments
`image.attach` `image.attach_bytes` `image.detach` `pdf.attach` `file.attach` `clipboard.paste`
`input.detect_drop` `image.generate`

Attachments stage into `session["attached_images"]` and are picked up by the **next** `prompt.submit`.
- `image.attach {session_id, path}` (gateway-local path) → `{attached, path, count, remainder, text, width, height, token_estimate}`.
- `image.attach_bytes {session_id, content_base64|data, filename?, ext?}` — remote-client path. Cap
  **25 MiB** decoded (`_ATTACH_BYTES_MAX_BYTES`, `server.py:14167`); extensions gated by
  `_allowed_image_extensions()`; magic-byte sniff for PNG/JPEG/GIF/WebP/BMP, default `.png`.
  Errors 4015 missing, 4017 bad base64/empty, 4018 too large, 4016 bad extension.
- `pdf.attach {session_id, path|content_base64}` — renders pages at 150 DPI via `pdftoppm`; 50 MB / 25 pages; 5028 if poppler missing.
- `file.attach {session_id, path?, data_url?, name?}` → `{attached, name, path, ref_path, ref_text:"@file:…", uploaded}`.
- Uvicorn frame cap is **384 MiB** (`ws_max_size=_DESKTOP_ATTACHMENT_WS_MAX_BYTES`, `web_server.py:696`).

### Approvals
`approval.pending {session_id}` → `{approvals:[…]}`;
`approval.respond {session_id, choice:"once"|"session"|"always"|"deny", request_id?, all?}` → `{resolved}`
(`"session"` = allow for this session, `"always"` = allow-always);
`approval.received {session_id, request_id}` → `{acknowledged}` (delivery ack).
Sibling prompt responders: `sudo.respond` `secret.respond` `tour.respond` `mcp.setup.respond`
`terminal.read.respond` `preview.read.respond` `preview.act.respond` `window.read.respond`.

### Profiles (= bots)
`profiles.list {include_sessions=true}` → rows with `last_session`; `profiles.create {name, description,
clone_from, clone_all, no_skills, soul, model, provider, mirror_credentials=true}`;
`profiles.describe {name}` → `{name, description, soul, model:{provider,default}, skills[], toolsets[]}`;
`profiles.configure {name, description?, soul?, model?+provider?, disabled_skills[], enabled_toolsets[], ui_meta{}, ui_meta_expected_revisions{}}` (per-section `applied` map; `ui_meta` capped 64 KiB);
`profiles.set_asset {name, asset:"avatar", data (data-URL/base64) | clear:true}` → `{ok, asset, size}` (2 MB, PNG/JPEG/WebP, magic-byte checked);
`profiles.get_asset {name, asset}` → `{found, mime?, size?, data?}`.

### Models / providers / config
`model.options` (full picker payload; pooled) `model.save_key` `model.disconnect` `config.get` `config.set`
`config.show` `reload.env` `reload.mcp` `agents.list` `toolsets.list` `tools.list` `tools.show` `tools.configure`
`mcp.catalog` `mcp.servers.{add,list,remove,set_api_key,test,oauth.start,oauth.poll,oauth.callback}`
`setup.status` `setup.runtime_check` `plugins.list` `plugins.manage` `skills.manage` `skills.reload`

`config.get {key, profile?, session_id?, cwd?}` — keys include `provider` (→ `{model, provider, providers[]}`),
`profile`, `project`, `full`, `prompt`, `skin`, `indicator`, `personality`, `reasoning`.
`config.set {key, value, session_id?, profile?, confirm_expensive_model?}`. With `key:"model"` **and**
`session_id`, the switch is per-session (deferred to the next turn if one is running) and never writes
global config; guarded picks answer `{confirm_required, confirm_message}` and must be re-sent with
`confirm_expensive_model:true`. Both are `@_profile_scoped`.

### Groups (hosted rooms)
`groups.capabilities` `groups.list {limit, offset, include_disbanded}` `groups.create {room_id, name, members}`
`groups.state {room_id, include_disbanded}` `groups.send {room_id, event_id, payload}` (only inert
`message.user` events; actor is server-owned) `groups.rename {room_id, event_id, name}` `groups.disband`
`groups.stop` `groups.approve` `groups.retry` `groups.log` `groups.replicate` `groups.replica_state`
`groups.promote` `groups.demote` `groups.peer.invite` `groups.peer.register` `groups.peer.revoke`.

### bot_relay (cross-connection A2A; the desktop is the relay)
`bot_relay.roster.sync {agents:[{profile, handle, connection_id, connection_label?, title?, description?}]}` → `{count}`;
`bot_relay.outbox.drain {}` → `{envelopes}`; `bot_relay.deliver {profile, message}` → `{reply}` (blocking, pooled);
`bot_relay.reply {…}`.

### Delegation / subagents
`delegation.status` → `{active, paused, max_spawn_depth, max_concurrent_children}`;
`delegation.pause {paused=true}`; `subagent.interrupt {subagent_id}` → `{found, subagent_id}`;
`subagent.steer {session_id, subagent_id, text}` → `{status:"queued"|"rejected", …}`;
`spawn_tree.list|load|save` `handoff.request|state|fail` `process.list|kill|stop`.

### Everything else in `_methods`
`billing.{auto_reload,charge,charge_status,state,step_up}` `subscription.{change,preview,resume,state,upgrade}`
`usage.bars` `insights.get` `verification.status` `learning.{delete,detail,edit,frames}` `cron.manage`
`browser.manage` `browser.controller.{register,result,heartbeat,detach}` `diagnostics.share_nous`
`projects.{discover_repos,record_repos,tree,project_sessions}` `project.facts` `rollback.{diff,list,restore}`
`preview.restart` `terminal.resize` `voice.{record,toggle,tts}` `wake.{start,stop,pause,resume,status,feed}`
`system.battery` `pet.{cancel,cells,disable,export,gallery,generate,generate.status,hatch,info,info.meta,remove,rename,scale,select,thumb}`.

## 3. Session keys

Two ids, always distinguish them:
- **`session_id`** (live/runtime): `uuid4().hex[:8]`, key of the in-memory `_sessions` dict. Used by every
  session-scoped RPC (`prompt.submit`, `session.history`, `image.attach`, …). Dies with the process/socket.
- **`session_key`** / `stored_session_id`: `YYYYmmdd_HHMMSS_<6 hex>` (`_new_session_key`, `server.py:9450`),
  the durable `state.db` row id. Used by `session.resume`, `session.delete`, `session.list` output.

Mapping to a bot: pass **`profile`** (profile name) to `session.create` / `session.resume`. `_profile_home`
(`server.py:2446`) resolves it to `~/.hexbot/profiles/<name>` (None ⇒ launch profile) and stores it as
`session["profile_home"]`, so the agent build, `state.db` writes, and every turn re-bind `HERMES_HOME` to
that profile. Read-only handlers use the `@_profile_scoped` decorator, which binds the same override for
the call. **One section = one Hexbot section = one `session.create` with that bot's `profile`; persist the
returned `stored_session_id` and re-open with `session.resume {session_id: <stored>, profile}`.**

**`follow_profile_config: true`** (`session.create`) persists `model_config.follow_profile_config` on the DB
row (`server.py:4175`). On resume, `_stored_session_runtime_overrides` (`server.py:5586`) returns `{}` for
such rows — the session rebuilds from the profile's *current* model/provider instead of restoring the pin
stored when the row was created. Omit it for user chats (they must reopen on the model they used); set it
for bot-owned "forever DM" sections. Legacy rows titled exactly `"Bot Chat"` are treated the same.

## 4. Extension

**No plugin registrar exists.** `_methods` is a plain module dict populated only by the `@method(...)`
decorator in `server.py` and by the nine `methods_*.py` split modules, which use
`method_ctx.HandlerRegistry` and are installed at the bottom of `server.py` (`server.py:18369-18391`).
`HandlerRegistry` is an internal seam for the file split, not a public API — it rebinds handler
`__globals__` onto `server`'s namespace via `types.FunctionType`.

`hermes_cli/plugins.py` `PluginContext` (line 1458) has registrars for tools, hooks, context engines,
memory/image/video/search/browser/TTS/transcription/secret providers, platform handlers, middleware,
approval transports, and an event bus (`register_hook`, `emit`, `subscribe`) — but **nothing** touching
JSON-RPC methods or gateway notifications. `VALID_HOOKS` (line 163) contains no gateway-RPC hook, and
`server.py` calls `invoke_hook` only for `on_session_end` / `on_session_finalize`.

Smallest core edit: export the registrar. Add to `PluginContext`

```python
def register_rpc_method(self, name: str, fn) -> PluginRegistration: ...
```

that namespace-checks `name` (e.g. require a `plugin.<plugin_id>.` prefix) and does
`tui_gateway.server._methods.setdefault(name, fn)`, plus an unload path that pops it — and in
`server.py`, one call in `handle_request`'s `if not fn:` branch to consult the plugin table before
returning -32601. For notifications, plugins can already reach clients by calling
`server._emit(type, sid, payload)` / `server._broadcast_global_event(type, payload)`; no core edit needed
there beyond making those public names.

## 5. Limits and errors

**Codes.** JSON-RPC standard: `-32700` parse error (from `ws.py`), `-32600` invalid request, `-32601`
unknown method, `-32602` invalid params, `-32603` internal error (dispatch crash), `-32000` handler
exception. Hexbot uses `4xxx` for client faults and `5xxx` for server faults, sub-ranged by area:
4000–4025 generic (4001 session not found, 4002 missing text, 4006 missing session_id, 4009 session busy,
4015–4018 attachments, 4023 delete-active), 4061–4071 profiles, 4090–4094 capacity/relay
(4090 active-session limit, with `data.reason` machine-readable), 4110–4123 groups/hosted rooms,
5000–5036 generic server (5006/5036 DB unavailable, 5032 agent init timeout), 5061–5066 profiles,
5090–5096 bot_relay, 5110–5120 groups. `error.data` is optional and usually `{"reason": "..."}`.

**Sizes.** WS frame cap 384 MiB (uvicorn `ws_max_size`); image bytes 25 MiB decoded; PDF 50 MB / 25 pages;
profile asset 2 MB; `ui_meta` 64 KiB; quick-command output truncated to 4000 chars.

**Rate limits.** None on `/api/ws` — no per-message throttle in `ws.py` or `server.py`. The only limiter
in `web_server.py` is on the unrelated `/api/reveal` endpoint. Admission control is the active-session
lease (`_ensure_active_session_slot` → 4090) plus `PER_SESSION_EXCLUSIVE_SUBMIT = True`
(`hermes_cli/active_sessions.py:152`), advertised via `gateway.capabilities`: one writer per session.

**Concurrency.** Yes — two (or many) sessions stream simultaneously on one socket. Methods in
`_LONG_HANDLERS` (`server.py:263`) run on an 8-worker `ThreadPoolExecutor` (`HERMES_TUI_RPC_POOL_WORKERS`);
everything else runs inline via `asyncio.to_thread`. Each turn gets its own thread and writes through
`WSTransport.write`, which serializes on an `asyncio.Lock`, so frames from different sessions interleave
freely and are demultiplexed by `params.session_id`. `write_json` (`server.py:2567`) routes an event to the
transport stored on its own session, so events reach the client that owns that session even from an
unbound background thread. Slow-loop writes (>10 s) log a warning but do not kill the transport.
Frames from a session whose transport died are dropped; disconnect reaps `close_on_disconnect` sessions and
detaches the rest to a grace-windowed orphan reaper that a quick reconnect + `session.resume` cancels.
