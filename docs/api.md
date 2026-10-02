# Hexbot daemon API

The client speaks JSON-RPC 2.0 over the daemon WebSocket at `/api/ws`
(newline-delimited text frames; server events arrive as notifications with
method `"event"` and `params: {type, session_id, seq, payload}`). Core
methods are used as-is for chat. Hexbot adds `hexbot.*` methods for its own
data model. Reference for the core subset: `/tmp/hexbot-notes/ws-api.md`
(copied to `docs/core/ws-api.md`).

## Mapping

| Hexbot | Core |
|---|---|
| bot | profile (`~/.hexbot/profiles/<name>`), plus a row in `hexbot.db` |
| section | stored session of that profile (`stored_session_id`), plus a row in `hexbot.db` |
| open section | live session (`session.resume {session_id: stored, profile}`) |
| persona | profile `soul` (SOUL.md) |
| bot model | profile `model` + `provider` |
| avatar | profile asset `avatar` |
| bot memory | profile `memories/MEMORY.md` (the core `USER.md` target is off) |
| history search | profile `state.db` FTS over its sessions |
| About you | `~/.hexbot/users/<owner_id>/user.md`, injected every turn by the hexbot plugin |

## Core methods the client calls directly

- Chat: `prompt.submit {session_id, text}`, `session.interrupt`, `session.steer`.
- History: `session.history {session_id}`, `session.events.since` on reconnect.
- Attachments: `image.attach_bytes {session_id, content_base64, filename}`,
  `file.attach {session_id, data_url, name}`, `pdf.attach {session_id, content_base64}`, `image.detach`.
  Images allow 25 MiB decoded; PDFs and generic files allow 45 MiB.
  Larger attachments return 4202 with the size limit. Browser clients check
  before reading or uploading. WebSocket frames and in-flight request bytes
  are capped at 64 MiB per connection.
- Approvals: `approval.pending`, `approval.respond {session_id, request_id, choice}`
  with `choice` in `once | session | always | deny`.
- Per-section model override: `config.set {key: "model", value, session_id}`.
- Model picker source: `model.options`.
- Keys: `model.save_key`, `model.disconnect`.
- Health: `gateway.ping`, `gateway.capabilities`.

Events the client renders: `message.start`, `message.delta`, `message.interim`,
`message.complete` (turn end), `reasoning.delta`, `thinking.delta`, `tool.start`, `tool.complete`,
`approval.request`, `status.update`, `session.info`, `session.usage`, `error`.

## `hexbot.*` methods

All results are objects. Errors use JSON-RPC error objects with core-style
codes. Code `4301` means `admin only`, `4302` means `not the owner`, and `4303`
means the user's daily token budget is exhausted.

List methods accept `all: true` only for admins. Without it, bots, sections,
rooms, devices, dreams, activity, and memory are scoped to the authenticated
user. Get and mutation methods always check ownership.

### Daemon

- `hexbot.info {}` → `{version, hermes_version, daemon_name, install_id,
  auth_required, lan_enabled, addresses: [string], platform, sandbox, home,
  update_capability}`. `update_capability` is `desktop` when the Hexbot app
  on that machine runs the daemon, `service` when launchd or systemd does,
  and `null` for a checkout or a hand-started daemon. `sandbox` is the OS
  sandbox shell and code tools run in: `sandbox-exec` on macOS, `bubblewrap`
  on Linux after a successful probe, and `null` when there is none; Settings,
  Approvals shows a notice then. The compatibility field
  `hermes_version` carries the pinned agent core version. `home` is an empty
  string for members and contains the daemon state path only for admins. `auth_required`
  is always true and kept for older clients: every client presents a device
  credential, whatever the bind address. `install_id` preserves the existing
  `<HEXBOT_HOME>/install_id` file and migrates an early native `install-id` file
  only if the original file has no ID.
- `hexbot.settings.get {}` → `{approval_mode, auto_approver_model, lan_enabled,
  service_installed, workspace_dir, billing_notice_ack, dream_time, dream_enabled}`
- `hexbot.settings.set {patch}` → same shape; only whitelisted keys.
  Room settings are `room_bot_turns_per_human_turn` (default 8),
  `room_budget_tokens_per_human_turn` (default null), and
  `bot_daily_token_budget` (default null).

### Bots

Bot shape: `{name, display_name, title, description, persona, tools: [string], skills: [string], shareable,
provider, model, avatar: {mime, data} | null, created_at, updated_at, last_activity_at,
owner_id, dream_enabled, notify, approval_mode, workdir | null,
status, status_detail | null, sections_total, sections_recent: [Section]}`

`status` is `idle`, `working`, `needs_you`, or `stopped` (priority in that
reverse order), folded by the daemon from live session state, room turns,
room `waiting.human` events, and open incidents. `status_detail` is
`{text, section_id, room_id, session_id, since, action}` where `action` is
null, `{kind: "fix_connector", connector}`, or `{kind: "retry"}`.
`approval_mode` is `inherit` (the deployment setting), `manual`, `smart`, or
`off`; `workdir` overrides the deployment workspace for that bot's terminal.
`workdir` and the `workspace_dir` setting are refused (4202) when they resolve
inside the Hexbot home, symlinks included.

- `hexbot.bots.list {all?}` → `{bots: [Bot]}` ordered by `last_activity_at` desc.
- `hexbot.bots.get {name}` → `{bot: Bot}`
- `hexbot.bots.create {name, display_name?, title?, description?, persona?,
  provider, model, avatar?}` → `{bot: Bot, section: Section}` (creates the
  profile with `mirror_credentials: true`, applies persona and model, stores
  the avatar, mirrors the deployment settings into the new profile's
  `config.yaml`, creates the first section titled "General").
  Any field `hexbot.bots.update` accepts may also be given here and is stored
  the same way.
  `display_name` defaults to the bot name in title case — never to `title`,
  which is free-form caller text stored verbatim.
- `hexbot.bots.introduce {name, section}` → `{submitted: true, section}`.
  Resumes the section on the calling transport, then submits the bot's
  hidden first prompt (`hexbot/kickoff.py`): a one-line greeting and up to
  three clarify questions about what the bot is for, whose answers it writes
  into its soul and memory. Clients call it right after `hexbot.bots.create`,
  once they have navigated to the section. Refused (4243) once the section
  has messages.
- `hexbot.bots.update {name, display_name?, title?, description?, persona?,
  provider?, model?, avatar?, dream_enabled?, shareable?, tools?, skills?,
  notify?, approval_mode?, workdir?}` →
  `{bot: Bot}`. `tools` accepts `terminal`, `files`, `code_execution`, `browser`,
  `computer_use`, `vision`, `voice`, `message_bots`, `delegate`, and
  `scheduling`; toolsets owned by connectors (web, image_gen, mcp-*) are left
  as they are. Both capability lists use replace semantics.
- `hexbot.bots.clear_status {name}` → `{bot: Bot}`. Closes every open incident
  for the bot.
- `hexbot.bots.delete {name}` → `{deleted: true}` (deletes the profile
  directory, all rows, and the bot's scheduled jobs; refuses with 4211 if any of its sections is live
  and mid-turn — `session.active_list` status `working` or `waiting` —
  with `data.sections: [{id, status}]`).

### Sections

Section shape: `{id, bot, title, title_by: "bot" | null, created_at,
updated_at, archived_at | null, done_at | null, preview, message_count,
live_session_id | null}`

`title_by` is `"bot"` when the daemon named the section, either from the
first prompt or through the bot's `hexbot_rename_section` tool; a user rename
clears it. `preview` is the first user message, also returned by `open`. The
roster shows only the title.

- `hexbot.sections.list {bot?, include_archived?}` → `{sections: [Section]}`.
  A section still called `New section` takes its title from the first prompt
  as soon as `prompt.submit` accepts it, before the bot replies. The
  `General` section created with a bot, and any name the user or bot set, are
  kept.
- `hexbot.sections.create {bot, title?}` → `{section: Section}` (calls
  `session.create {profile: bot, close_on_disconnect: false}`, records the
  stored id). `title` is passed to the core only when given; an untitled
  core session is what its auto-titler names from the first prompt, and the
  row shows `New section` until then.
- `hexbot.sections.open {id}` → `{section: Section, messages: [Message],
  pending_clarify?}` (resumes the stored session on the bot's profile;
  idempotent if live). If the bot is waiting on an approval, the daemon
  sends its `approval.request` event again so a reloaded client gets the
  card back; clients dedupe on `request_id`.
- `hexbot.sections.rename {id, title}` → `{section: Section}`
- `hexbot.sections.archive {id}` / `hexbot.sections.unarchive {id}` → `{section}`
- `hexbot.sections.delete {id, purge_memory?: true}` → `{deleted: true}`
  (closes the live session, `session.delete` on the stored row). With
  `purge_memory: false` only the Hexbot row goes and the core transcript
  is left in place. The bot's memory is not touched either way.
- `hexbot.sections.touch {id}` is internal; activity is stamped by the plugin
  on `message.complete`. It also sets the section's `done_at`.
- `hexbot.sections.mark_read {id}` → `{section: Section}` clears `done_at`:
  the user has seen the finished work. Broadcasts `hexbot.sections.changed`,
  so the green dot clears on every device.

### Memory

- `hexbot.memory.user.get {}` → `{text, cap: 2000, updated_at}`. The caller's
  About you text, injected as the plugin prompt section
  `hexbot.about-you` into every session of a bot they own. Shared bot sessions
  saved with the room owner's About you before this restriction rebuild their
  prompt once on reopen, preserving their saved tools and options.
- `hexbot.memory.user.set {text}` → same as get. Broadcasts
  `hexbot.memory.user.changed`.
- `hexbot.memory.bot.get {bot}` → `{memory_md, cap: 2200}`
- `hexbot.memory.bot.set {bot, memory_md}` → same as get.

### Dreaming

- `hexbot.dreaming.status {bot}` → `{enabled, last_run_at, next_run_at,
  last_status, last_error}`.
- `hexbot.dreaming.run_now {bot}` → `{job}`. The profile's `hexbot-dream` job
  runs on the next cron tick.
- `hexbot.dreaming.list {bot, limit?}` → `{dreams: [{id, bot, room_id,
  started_at, finished_at, status, summary, memory_before, memory_after}]}`.
  `limit` defaults to 20 and is capped at 200. `memory_before` and
  `memory_after` are the bot's `MEMORY.md` when the dream started and
  finished.
- `hexbot.dreaming.restore {id}` → `{bot, memory_md, dream_id}` writes
  `memory_before` back as the bot's memory. Owner only, and only while the
  bot exists. The restore is logged as a dream of its own (`dream_id`) whose
  `memory_before` is the memory it replaced, so it can be undone in turn.
  Broadcasts `hexbot.dreaming.changed`.

### Rooms

Room shape: `{id, name, owner_id, main_bot, approval_mode, limits,
created_at, updated_at, last_activity_at, archived_at, members}`. Member rows
include `display_name` for both bots and people, and keep `left_at` after
departure so old transcripts retain their identities.
`limits` is `{bot_turns_per_human_turn?, budget_tokens_per_human_turn?}`,
each a whole number or null (use the system setting); other keys are
rejected with 4202. Rooms saved by earlier builds may still hold
`room_bot_turns_per_human_turn` or `room_budget_tokens_per_human_turn` in
`limits`; those keys are ignored, so such a room uses the system settings
until its limits are saved again. The owner and the room's human members can
list, get, read, send, mark read and stop; only the owner can update, change
members, archive or delete (4302 otherwise). A member may remove only
themselves. Bots always run as the owner.

- `hexbot.rooms.list {include_archived?}` → `{rooms: [Room]}`
- `hexbot.rooms.get {id}` → `{room: Room}`
- `hexbot.rooms.create {name, members: [bot], main_bot?, limits?, approval_mode?}`
  → `{room: Room}`
- `hexbot.rooms.update {id, name?, main_bot?, limits?, approval_mode?}` → `{room}`
- `hexbot.rooms.add_member {id, bot}` / `hexbot.rooms.remove_member {id, bot}`
  → `{room}`
- `hexbot.rooms.people {id}` → `{users: [{id, display_name}]}`. Owner only;
  lists active daemon users for Add person without exposing account settings.
- `hexbot.rooms.add_member {id, user}` → `{room}`. Owner only; adding a
  person back clears `left_at`, resets their read position, and restores room
  and live session events.
- `hexbot.rooms.remove_member {id, user}` → `{room}`. The owner removes a
  person; any other member passes their own id to leave. The owner cannot
  remove themselves (4202); they delete the room instead. The person gets the
  `member.left` event and `hexbot.rooms.changed`, then 4302 from every room
  call and no further room or live session events.
- `hexbot.rooms.send {id, text, attachments?}` → `{event}`. This queues the
  room engine after writing the user event.
- `hexbot.rooms.log {id, after_seq?, limit?}` → `{events}` in ascending room
  sequence order. `limit` is capped at 1000.
- `hexbot.rooms.stop {id}` → `{stopped: true}`
- `hexbot.rooms.archive {id}` → `{room}`
- `hexbot.rooms.delete {id}` → `{deleted: true}`
- `hexbot.rooms.mark_read {id, seq}` → `{room}`

Room turns use hidden sessions on each bot profile. The daemon waits
for the corresponding assistant row through `session.history` after
`prompt.submit`; it does not depend on the WebSocket that initiated the room.
The live session's events (`message.delta`, `tool.*` and the rest) reach the
owner and every human member, so everyone watches the bot work. Approval and
question events (`approval.*`, `clarify.*`) go to the owner alone, who
answers them; `session.events.since` replays a room session to the owner
only. Opening a room with `hexbot.rooms.get` re-sends pending cards to the
owner and the current waiting or working `status.update` to other members
for each running turn. Members receive "Waiting for <owner name>" while
an approval or question is open, including after a reload. Tool labels in
rooms and sections stay in the present tense until the tool completes.

### Bot activity

- `hexbot.activity.pairs {}` → `{pairs: [{from_bot, to_bot, count, last_at}]}`
- `hexbot.activity.list {from?, to?, limit?}` → `{messages: [BotMessage]}`

The `message_bot {to, text, wait}` tool delivers into the target bot's
`From <sender>` section. With `wait: false`, a background watcher submits the
eventual reply to the sender section as hidden input prefixed
`[reply from <bot>]`. This is the closest supported core mechanism to a
hidden note and preserves it in the section context.

The `hexbot_soul {action: read | write, text?}` tool lets a bot read or
replace its own `SOUL.md` (capped at 4000 characters). It sits in its own
plugin toolset, `hexbot-soul`, which is never written to
`known_plugin_toolsets`, so the core keeps it on for every bot. A write calls
`profiles.configure {soul}` and broadcasts `hexbot.bots.changed`; it reaches
new sections only, since a running section's prompt is frozen. The chat
shows a "Soul updated" mark under the bubble, as it shows "Memory updated"
for the builtin memory tool.

The `hexbot_rename_section {title}` tool (toolset `hexbot-section`, kept on
the same way) renames the section the bot is speaking in, up to 60
characters, and broadcasts `hexbot.sections.changed`. It refuses in rooms and
in the Dreams section. The roster and the conversation header fade the new
title in where the old one was.

### Connectors and skills

A connector is an outside service a bot can reach (web search, image
generation, Notion, X search, Home Assistant, an MCP server, ...). Credentials
are stored once for the daemon; each bot has its own on/off switch.
Native tool configuration for a bot overrides matching fields in the daemon configuration.
Nested objects merge recursively, preserving unspecified fields; lists and
other values replace the daemon value. Native tool configuration rejects profile paths
that contain symlinks. Browser private-URL settings use the same merge.

A tool that belongs to a connector (`web_search`, `web_extract`,
`image_generate`, `video_generate`, `x_search`, the Home Assistant tools) is
left out of every session's tool schema until that connector is `ready`.
The core alone would offer some of them without a key (its keyless web search
tier, or an xAI model key); `connectors.gate_tools` adds the "set up" condition
to each tool's core availability check when the plugin registers. Onboarding
offers the search and media connectors before the first bot is created
(`hexbot.connectors.setup` without a `bot`).

Connector shape: `{id, name, description, group, icon, scope, state, state_text,
providers | null, provider | null, fields: [{key, provider, label, help, url,
secret, advanced, set, hint}], enabled_for_bot | null, enabled_bots: [string],
last_error | null, mcp?: {transport, tool_count, running}}`. `state` is
`not_set_up`, `ready`, or `error`; `icon` is a Simple Icons slug or `glyph:*`.
`fields` carries every provider's fields, each tagged with its `provider`
(`null` = common to all), so a client can show the right ones before a choice
is saved. `state_text` says "Connected" only after a probe answered (Notion,
Airtable, ElevenLabs, Home Assistant, xAI make one small authenticated GET);
connectors with only an offline check say "Key saved". A failed probe keeps
the row in `error` with the probe's message until the next successful setup
or a clear.

- `hexbot.connectors.list {bot?}` → `{connectors: [Connector]}`.
- `hexbot.connectors.setup {id, values: {ENV_KEY: value}, provider?, bot?,
  enable_for_bot?, bot_only?}` → `{connector, test: {ok, message}}`. Admin
  only. Writes the values into the root `.env`, every profile `.env` and the
  process environment (`bot_only` writes only that bot's profile), records the
  backend choice where the core reads it, runs the check or probe, and, when
  it passes, turns the connector on for `bot` unless `enable_for_bot` is
  false. A failed probe leaves the connector off for the bot.
- `hexbot.connectors.test {id, bot?}` → `{ok, message}`.
- `hexbot.connectors.clear {id, bot?, bot_only?}` → `{connector}`. Admin only.
- `hexbot.connectors.set_for_bot {id, bot, enabled}` → `{connector}`.
- `hexbot.connectors.add_mcp {name, command?, args?, env?, url?, transport?}` →
  `{connector}`; `hexbot.connectors.remove_mcp {name}` → `{removed: true}`.
  Admin only. MCP servers live in the root `config.yaml` and appear as
  `mcp:<name>` connectors.
- `hexbot.skills.list {bot}` → `{skills: [{name, description, category, enabled}]}`.

### Providers and models

- `hexbot.providers.list {}` → `{providers: [{id, label, configured,
  auth_type, models_source}]}` (all core providers). `configured` is
  always a boolean: key providers are checked against the deployment
  `.env` and the process env, OAuth providers against the core auth
  store (`openai-codex` via `hermes_cli.auth._read_codex_tokens`, the rest
  via their stored provider state). `label` is the provider's display
  name, never the raw slug.
- `hexbot.providers.set_key {provider, key}` / `hexbot.providers.clear_key {provider}`.
  Key changes and completed sign-ins refresh existing Pi credential copies.
  Open sections use the updated credentials on their next provider request.
  Disconnect removes the provider from those copies, including bots that are idle.
- `hexbot.models.list {provider?, include_unconfigured?, refresh?}` →
  `{curated: [Model], all: [Model], all_source, error?}` with
  `Model = {provider, id, label, context?, input_cost?, output_cost?}`,
  built from `model.options`. `provider` accepts the friendly aliases
  `openai` (→ `openai-api`), `chatgpt` (→ `openai-codex`), `claude`,
  `grok`, `glm`. `include_unconfigured` defaults to true when the named
  provider has no credentials; `model.options` returns empty skeleton rows
  for those, so `all` then falls back to the core's offline curated catalog
  and `all_source` reports `model.options | catalog | mixed | none`.
  A named, configured provider with no offline catalog is queried automatically.
  LM Studio uses its OpenAI-compatible `/v1/models` endpoint. Unfiltered reads
  query providers only with `refresh: true`. The current configured model remains
  selectable if discovery fails, and `error` reports the failure.
  `context` is in tokens; `input_cost` / `output_cost` are the $/Mtok
  strings the core formats for its own picker (e.g. `"$3.00"`, `"free"`).

### Network and pairing

- `hexbot.network.get {}` → `{lan_enabled, bind_host, port, addresses}`
- `hexbot.network.set {lan_enabled}` → same; moves the listener to the new
  address and closes open connections with code 1012 so clients reconnect.
  The daemon does not restart and running bot turns continue. The reply's
  `restarting: true` is kept for older apps.
- `hexbot.pairing.code {}` → `{code, expires_at, link}` (loopback or paired
  admin only). `link` is `hexbot://pair?host=...&port=...#code=...`.
- `hexbot.devices.list {}` → `{devices: [{id, name, platform, created_at,
  last_seen_at, current: bool}]}`
- `hexbot.devices.revoke {id}` → `{revoked: true}`

### Local daemon identity

`GET /api/daemon/identity` returns `{install_id, pid}` only to a loopback peer that sends a loopback `Host` (`127.0.0.1`, `localhost` or `[::1]`), so it stays closed through Hex Connect and local proxies.
The app compares these with this home's `install_id` and `native-daemon.lock`
before reusing a daemon, including after an app-owned daemon exits. Stopping an
external service daemon through the app leaves its status as running.

### Updates

A client newer than the daemon asks the daemon to update itself
(`docs/channels.md`, "Updating a daemon from a client").

- `hexbot.update.request {version}` (admin) → `{accepted: true, method,
  version}`. `method` is the daemon's `update_capability`. With `desktop` the
  app running the daemon downloads and installs its own update and relaunches;
  with `service` the daemon fetches
  `daemon/native/<version>/<target>/manifest.json`, verifies the target archive
  and its SHA-256, activates the runtime, and restarts itself. Errors: 4210
  no capability, 4211 an update is already running, 4212 already on that
  version. Service updates require a newer source build, using manifest
  `builtAt` across Stable and Nightly. An older or equally old build reports
  failure before downloading its archive.
  Native manifests are not signed yet. SHA-256 checks detect corruption;
  authenticity depends on HTTPS and update-origin write access. Release-key
  provisioning and manifest signing remain a known gap.
- `hexbot.update.status {}` → `{capability, status, requested, version,
  percent, message, at}`. `status` is `idle`, `requested`, `checking`,
  `downloading`, `installing`, `restarting`, `up-to-date`, or `failed`.
  A successful update ends with the connection dropping and the daemon
  coming back on the requested version.

### Users and usage

- `hexbot.users.me {}` → `{id, display_name, role}`.
- `hexbot.users.list {}` → `{users}`. Admin only.
- `hexbot.users.invite {display_name, role?}` → `{user, code, expires_at}`.
  Admin only. The code is bound to the new user, and its redeemed device keeps
  that ownership.
- `hexbot.users.update {id, display_name?, role?, disabled?, limits?}` →
  `{user}`. Admin only. `limits.daily_tokens` is a non-negative integer or null.
  Updates that remove the last enabled admin return 4202.
- `hexbot.usage.summary {user?, since?}` → `{input_tokens, output_tokens,
  estimated_cost_usd, by_bot}`. Members may request only their own usage.

The room engine and `hexbot.sections.open` refuse a new turn after the owning
user reaches `daily_tokens`, and emit `hexbot.usage.limit {user}`. The core's
`pre_llm_call` plugin hook cannot refuse a request, so it is not used as a
budget gate.

### Hex Connect

- `hexbot.connect.status {}` → `{registered, daemon_id, slug,
  tunnel_hostname, tunnel_running, last_heartbeat_at, last_error}`
- `hexbot.connect.register_start {daemon_name?}` → `{device_code, user_code,
  verify_url, interval}`
- `hexbot.connect.register_poll {device_code}` → `{status}`. An approved result
  stores the daemon and tunnel credentials on the daemon and mirrors
  `dashboard.public_url`. The RPC returns only status, never those credentials.
- `hexbot.connect.disconnect {}` stops Connect, deletes `connect.json`, and
  removes the mirrored public URL.

### Events emitted by the plugin

`hexbot.bots.changed {name}`, `hexbot.sections.changed {id, bot}`,
`hexbot.memory.user.changed {}`, `hexbot.network.changed {}`. Session-less,
broadcast to every connection.
Connect registration and disconnection emit `hexbot.connect.changed {}`.
Room mutations emit `hexbot.rooms.changed {id}`. Every persisted room event
emits `hexbot.rooms.event {room_id, event}`. Turn state changes emit
`hexbot.rooms.turn {room_id, bot, live_session_id, status}`. Room events go
to the owner and every human member.
Dream triggers emit `hexbot.dreaming.changed {bot}`.
Connector mutations emit `hexbot.connectors.changed {connector, bot?}` and
`hexbot.bots.changed`. Opening or resolving an incident emits
`hexbot.bots.incident {bot, section_id, room_id, session_id, incident: {id,
kind, connector, text, created_at, resolved_at}}` followed by
`hexbot.bots.changed {name}`.

## Pairing and auth over HTTP

- `GET /auth/login` starts browser sign-in through Hex Connect with a
  one-time state cookie. `GET /auth/callback` validates the state and grant,
  then sets the browser cookie and returns to the web bundle.
- `GET /login?code=<pairing code>` is the one-time sign-in link `hexbot
  serve` prints: it redeems the code once, sets the browser cookie, and
  redirects to `next`. `GET /` never carries a credential, on any bind
  address; an HTML request without a valid cookie is redirected to `/login`.
  The served page sets `window.__HERMES_AUTH_REQUIRED__=true`, kept for older
  clients; the web bundle reads it only to know a daemon served it.

- `POST /hexbot/pair {code, device_name, platform}` → `{device_token,
  device_id, daemon_name}`; the code is single-use and expires in 10 minutes.
- Device token is sent as `Authorization: Bearer <token>` on HTTP and as the
  `?token=` query on `/api/ws` (see `docs/auth.md` once the dashboard-auth
  integration is settled).
- `POST /hexbot/session` with the bearer token sets the browser cookie session
  for the web bundle.

## CLI

- `hexbot serve [--host IP] [--port N] [--lan | --no-lan]`: starts the Rust
  daemon with Pi agents. `HEXBOT_HOME` selects the daemon state directory.
  Started in a terminal without a supervisor, it prints a one-time sign-in
  link for a browser on the same machine (`docs/auth.md`).
- `hexbot pair [--sign-in]`: prints the pairing code, expiry, address, pairing link, and QR code.
  `--sign-in` preserves outstanding codes for startup links; ordinary pairing replaces the previous code.
- `hexbot connect [status|disconnect]`: registers, inspects, or disconnects
  this daemon from Hex Connect.
- `hexbot devices list|revoke`, `hexbot bots list|create|delete`,
  `hexbot rooms list`, and `hexbot send <bot> <text>`.
- Native commands use the running daemon when available, preserving event
  delivery and the single runtime owner. Offline mutations require its home lock.
- `hexbot core <args>` exists only in the legacy Python installation; the
  Rust daemon has no core CLI.
