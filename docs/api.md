# Hexbot daemon API

The client speaks JSON-RPC 2.0 over the Hermes WebSocket at `/api/ws`
(newline-delimited text frames; server events arrive as notifications with
method `"event"` and `params: {type, session_id, seq, payload}`). Hermes
methods are used as-is for chat. Hexbot adds `hexbot.*` methods for its own
data model. Reference for the Hermes subset: `/tmp/hexbot-notes/ws-api.md`
(copied to `docs/upstream/ws-api.md`).

## Mapping

| Hexbot | Hermes |
|---|---|
| bot | profile (`~/.hexbot/profiles/<name>`), plus a row in `hexbot.db` |
| section | stored session of that profile (`stored_session_id`), plus a row in `hexbot.db` |
| open section | live session (`session.resume {session_id: stored, profile}`) |
| persona | profile `soul` (SOUL.md) |
| bot model | profile `model` + `provider` |
| avatar | profile asset `avatar` |
| bot notes (section memory, notes part) | profile `memories/MEMORY.md` and `USER.md` |
| section memory search | profile `state.db` FTS over its sessions |
| core memory | `~/.hexbot/core_memory.json`, injected every turn by the hexbot plugin |

## Hermes methods the client calls directly

- Chat: `prompt.submit {session_id, text}`, `session.interrupt`, `session.steer`.
- History: `session.history {session_id}`, `session.events.since` on reconnect.
- Attachments: `image.attach_bytes {session_id, content_base64, filename}`,
  `file.attach {session_id, data_url, name}`, `pdf.attach {session_id, content_base64}`, `image.detach`.
- Approvals: `approval.pending`, `approval.respond {session_id, request_id, choice}`
  with `choice` in `once | session | always | deny`.
- Per-section model override: `config.set {key: "model", value, session_id}`.
- Model picker source: `model.options`.
- Keys: `model.save_key`, `model.disconnect`.
- Health: `gateway.ping`, `gateway.capabilities`.

Events the client renders: `message.start`, `message.delta`, `message.interim`,
`message.complete` (turn end), `thinking.delta`, `tool.start`, `tool.complete`,
`approval.request`, `status.update`, `session.info`, `session.usage`, `error`.

## `hexbot.*` methods (milestone 1)

All results are objects. Errors use JSON-RPC error objects with Hermes-style
codes in the 4200–4299 (client) and 5200–5299 (server) ranges.

### Daemon

- `hexbot.info {}` → `{version, hermes_version, daemon_name, install_id,
  auth_required, lan_enabled, addresses: [string], platform, home}`
- `hexbot.settings.get {}` → `{approval_mode, auto_approver_model, lan_enabled,
  service_installed, workspace_dir, billing_notice_ack}`
- `hexbot.settings.set {patch}` → same shape; only whitelisted keys.

### Bots

Bot shape: `{name, display_name, title, description, persona, provider, model,
avatar: {mime, data} | null, created_at, updated_at, last_activity_at,
owner_id, sections_total, sections_recent: [Section]}`

- `hexbot.bots.list {}` → `{bots: [Bot]}` ordered by `last_activity_at` desc.
- `hexbot.bots.get {name}` → `{bot: Bot}`
- `hexbot.bots.create {name, display_name?, title?, description?, persona?,
  provider, model, avatar?}` → `{bot: Bot, section: Section}` (creates the
  profile with `mirror_credentials: true`, applies persona and model, stores
  the avatar, mirrors the deployment settings into the new profile's
  `config.yaml`, creates the first section titled "General").
  `display_name` defaults to the bot name in title case — never to `title`,
  which is free-form caller text stored verbatim.
- `hexbot.bots.update {name, display_name?, title?, description?, persona?,
  provider?, model?, avatar?}` → `{bot: Bot}`
- `hexbot.bots.delete {name}` → `{deleted: true}` (deletes the profile
  directory and all rows; refuses with 4211 if any of its sections is live
  and mid-turn — `session.active_list` status `working` or `waiting` —
  with `data.sections: [{id, status}]`).

### Sections

Section shape: `{id, bot, title, created_at, updated_at, archived_at | null,
preview, message_count, live_session_id | null}`

- `hexbot.sections.list {bot?, include_archived?}` → `{sections: [Section]}`
- `hexbot.sections.create {bot, title?}` → `{section: Section}` (calls
  `session.create {profile: bot, title, close_on_disconnect: false}`, records
  the stored id).
- `hexbot.sections.open {id}` → `{section: Section, messages: [Message]}`
  (resumes the stored session on the bot's profile; idempotent if live).
- `hexbot.sections.rename {id, title}` → `{section: Section}`
- `hexbot.sections.archive {id}` / `hexbot.sections.unarchive {id}` → `{section}`
- `hexbot.sections.delete {id, purge_memory?: true}` → `{deleted: true}`
  (closes the live session, `session.delete` on the stored row, removes
  memory entries tagged with the section id). With `purge_memory: false`
  only the Hexbot row goes and the Hermes transcript is left in place.
- `hexbot.sections.touch {id}` is internal; activity is stamped by the plugin
  on `message.complete`.

### Memory

- `hexbot.memory.core.get {}` → `{sections: {user, household, workspace,
  rules}, caps: {per_section: 4000, prompt_total: 8000}, updated_at}`.
  Each section is injected as its own Hermes plugin prompt section
  (`hexbot.core-memory.<section>`), so each gets the registrar's full
  4000-char allowance; `prompt_total` is Hermes'
  `MAX_SYSTEM_PROMPT_SECTIONS_TOTAL_CHARS` budget shared by every plugin
  section, and sections past it are dropped in sorted-id order.
- `hexbot.memory.core.set {section, text}` → same as get.
- `hexbot.memory.bot.get {bot}` → `{memory_md, user_md, caps}`
- `hexbot.memory.bot.set {bot, memory_md?, user_md?}` → same as get.

### Providers and models

- `hexbot.providers.list {}` → `{providers: [{id, label, configured,
  auth_type, models_source}]}` (all Hermes providers). `configured` is
  always a boolean: key providers are checked against the deployment
  `.env` and the process env, OAuth providers against the Hermes auth
  store (`openai-codex` via `hermes_cli.auth._read_codex_tokens`, the rest
  via their stored provider state). `label` is the provider's display
  name, never the raw slug.
- `hexbot.providers.set_key {provider, key}` / `hexbot.providers.clear_key {provider}`.
- `hexbot.models.list {provider?, include_unconfigured?, refresh?}` →
  `{curated: [Model], all: [Model], all_source, error?}` with
  `Model = {provider, id, label, context?, input_cost?, output_cost?}`,
  built from `model.options`. `provider` accepts the friendly aliases
  `openai` (→ `openai-api`), `chatgpt` (→ `openai-codex`), `claude`,
  `grok`, `glm`. `include_unconfigured` defaults to true when the named
  provider has no credentials; `model.options` returns empty skeleton rows
  for those, so `all` then falls back to Hermes' offline curated catalog
  and `all_source` reports `model.options | catalog | mixed | none`.
  `context` is in tokens; `input_cost` / `output_cost` are the $/Mtok
  strings Hermes formats for its own picker (e.g. `"$3.00"`, `"free"`).

### Network and pairing

- `hexbot.network.get {}` → `{lan_enabled, bind_host, port, addresses}`
- `hexbot.network.set {lan_enabled}` → same; restarts the listener.
- `hexbot.pairing.code {}` → `{code, expires_at, link}` (loopback or paired
  admin only). `link` is `hexbot://pair?host=...&port=...#code=...`.
- `hexbot.devices.list {}` → `{devices: [{id, name, platform, created_at,
  last_seen_at, current: bool}]}`
- `hexbot.devices.revoke {id}` → `{revoked: true}`

### Events emitted by the plugin

`hexbot.bots.changed {name}`, `hexbot.sections.changed {id, bot}`,
`hexbot.memory.core.changed {}`, `hexbot.network.changed {}`. Session-less,
broadcast to every connection.

## Pairing and auth over HTTP

- `POST /hexbot/pair {code, device_name, platform}` → `{device_token,
  device_id, daemon_name}`; the code is single-use and expires in 10 minutes.
- Device token is sent as `Authorization: Bearer <token>` on HTTP and as the
  `?token=` query on `/api/ws` (see `docs/auth.md` once the dashboard-auth
  integration is settled).
- `POST /hexbot/session` with the bearer token sets the browser cookie session
  for the web bundle.

## CLI

- `hexbot serve [--host] [--port] [--lan]`: starts the daemon (wraps
  `hermes serve`, loads the hexbot plugin, applies `~/.hexbot` as home).
- `hexbot pair`: prints the pairing code, addresses, and a QR.
- `hexbot bots list|create|delete`, `hexbot rooms list` (milestone 3),
  `hexbot send <bot> <text>`.
- Every Hermes command remains reachable as `hexbot hermes <args>`.
