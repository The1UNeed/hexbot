# Hexbot daemon API

The client speaks JSON-RPC 2.0 over the daemon WebSocket at `/api/ws`
(newline-delimited text frames; server events arrive as notifications with
method `"event"` and `params: {type, session_id, seq, payload}`). Core
methods are used as-is for chat. Hexbot adds `hexbot.*` methods for its own
data model. The native transport and event projection live in
`backend/hexbot-core/src/server.rs` and `events.rs`.

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
  with `choice` in `once | session | deny`. `session` quiets the same kind
  of request for the rest of the section; nothing persists across sections.
  Requests raised by the daemon offer `once | deny` only.
- Per-section model override: `config.set {key: "model", value, session_id}`.
- Model picker source: `model.options`.
- Keys: `model.save_key`, `model.disconnect`.
- Health: `gateway.ping`, `gateway.capabilities`.

Events the client renders: `message.start`, `message.delta`, `message.interim`,
`message.complete` (turn end), `reasoning.delta`, `thinking.delta`, `tool.start`, `tool.complete`,
`approval.request`, `status.update`, `session.info`, `session.usage {usage,
context}` (the section's totals and its context meter, see Sections), `error`.

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
- `hexbot.settings.get {}` → `{approval_mode, lan_enabled,
  service_installed, workspace_dir, billing_notice_ack, dream_time, dream_enabled}`.
  `approval_mode` defaults to `smart` (Auto).
- `hexbot.settings.set {patch}` → same shape; only whitelisted keys.
  Room settings are `room_bot_turns_per_human_turn` (default 8),
  `room_budget_tokens_per_human_turn` (default null), and
  `bot_daily_token_budget` (default null).

### Bots

Bot shape: `{name, display_name, title, description, persona, tools: [string], available_tools: [string], skills: [string], shareable,
provider, model, reasoning_effort | null, avatar: {mime, data} | null, created_at, updated_at, last_activity_at,
owner_id, dream_enabled, notify, approval_mode, workdir | null,
status, status_detail | null, sections_total, sections_recent: [Section]}`

`available_tools` lists the `tools` keys whose program or service exists on
the daemon computer: code execution needs Python, browser a browser driver,
CDP address, or cloud browser key, computer use the cua driver, vision a key
or endpoint for its vision provider, and voice edge-tts or its provider's
key. The others are always available. `tools` only reports available tools,
and a tool that isn't available is never offered to a model; a frozen section
that still lists one gets an error when calling it.
Provider key changes broadcast `hexbot.bots.changed` to every user so paired
clients refresh tool availability. Speech calls check the requested provider
when it overrides the default.

`status` is `idle`, `working`, `needs_you`, or `stopped` (priority in that
reverse order), folded by the daemon from live session state, room turns,
room `waiting.human` events, and open incidents. `status_detail` is
`{text, section_id, room_id, session_id, since, action}` where `action` is
null, `{kind: "fix_connector", connector}`, or `{kind: "retry"}`.
`approval_mode` is `inherit` (the deployment setting), `manual`, `smart`
(Auto), or `off` (Bypass); `workdir` overrides the deployment workspace for
that bot's terminal. Only the admin may set `off`: the daemon refuses it for
a member's bot or room with "Only the admin can choose Bypass." and runs a
member's bot in Auto if `off` was stored earlier.
`reasoning_effort` is the Pi thinking level a new section starts with: `off`,
`minimal`, `low`, `medium`, `high`, `xhigh`, or `max`, stored as
`model.reasoning_effort` in the profile's `config.yaml`. Null means Pi's
default, `medium`; Pi clamps a level the model lacks to the closest one it
has. Open sections keep the level they started with, so their cached prefix
stays valid. A scheduled job's own `reasoning_effort` wins over the bot's.
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
  hidden first prompt (`backend/hexbot-core/src/catalog.rs`): a one-line greeting and up to
  three clarify questions about what the bot is for, whose answers it writes
  into its soul and memory. Clients call it right after `hexbot.bots.create`,
  once they have navigated to the section. Refused (4243) once the section
  has messages.
- `hexbot.bots.update {name, display_name?, title?, description?, persona?,
  provider?, model?, reasoning_effort?, avatar?, dream_enabled?, shareable?,
  tools?, skills?, notify?, approval_mode?, workdir?}` →
  `{bot: Bot}`. `tools` accepts `terminal`, `files`, `code_execution`, `browser`,
  `computer_use`, `vision`, `voice`, `message_bots`, `delegate`, and
  `scheduling`; toolsets owned by connectors (web, image_gen, mcp-*) are left
  as they are. Both capability lists use replace semantics. A tool missing
  from `available_tools` is dropped from `tools` on write. Combined model and
  tool edits use the new provider when checking availability.
- `hexbot.bots.clear_status {name}` → `{bot: Bot}`. Closes every open incident
  for the bot.
- `hexbot.bots.delete {name}` → `{deleted: true}` (deletes the profile
  directory, all rows, the bot's scheduled jobs, and the memory proposals those jobs left; refuses with 4211 if any of its sections is live
  and mid-turn — `session.active_list` status `working` or `waiting` —
  with `data.sections: [{id, status}]`).

### Sections

Section shape: `{id, bot, title, title_by: "bot" | null, created_at,
updated_at, archived_at | null, done_at | null, preview, message_count,
live_session_id | null, peer_bot | null}`

`peer_bot` is set on a thread: the private conversation in which `peer_bot`
asked `bot` for help through `message_bot`.

`title_by` is `"bot"` when the daemon named the section, either from the
first prompt or through the bot's `hexbot_rename_section` tool; a user rename
clears it. `preview` is the first user message, also returned by `open`. The
roster shows only the title.

- `hexbot.sections.list {bot?, include_archived?, include_threads?}` →
  `{sections: [Section]}`. Threads are left out unless `include_threads` is
  true; so are the `sections_total` and `sections_recent` of a bot.
  A section still called `New section` takes its title from the first prompt
  as soon as `prompt.submit` accepts it, before the bot replies. The
  `General` section created with a bot, and any name the user or bot set, are
  kept.
- `hexbot.sections.create {bot, title?}` → `{section: Section}` (calls
  `session.create {profile: bot, close_on_disconnect: false}`, records the
  stored id). `title` is passed to the core only when given; an untitled
  core session is what its auto-titler names from the first prompt, and the
  row shows `New section` until then.
- `hexbot.sections.thread {bot, peer}` → `{section: Section | null}`: the
  caller's thread on `bot` whose sender is `peer`. It never creates one.
- `hexbot.sections.open {id}` → `{section: Section, messages: [Message],
  context: Context, pending_clarify?}` (resumes the stored session on the
  bot's profile; idempotent if live). If the bot is waiting on an approval,
  the daemon sends its `approval.request` event again so a reloaded client
  gets the card back; clients dedupe on `request_id`.

`Context = {tokens, window, compact_at, compacting, recounting, seq}` is how
full the section's context is: Pi's own estimate of the tokens the next
request will carry, the model's context window, and the point where Pi
summarises older messages (the window minus the reserve the daemon wrote for
that model in the bot's Pi `settings.json`, as that section's Pi process
loaded it at start, and never below half the window; see
`backend/hexbot-core/README.md`). `tokens` is null until the first reply and
right after a compaction, until the next reply measures the compacted
context; in the second case `recounting` is true, so a client keeps the meter
in a neutral state instead of hiding it. Right after the daemon clears old
tool output (`backend/hexbot-core/README.md`) it is Pi's size estimate of the
edited context until the next reply. `window` and `compact_at` are null when
Pi has no model. `compacting` is true from a compaction's start until Pi
reports it done. `seq` grows with every report of the daemon; the daemon
measures each report in its own task and drops one a later report has
overtaken, and a client drops a report whose `seq` is below the one it holds.
The same object rides on every `session.usage` event, which the daemon sends
after each turn, when a compaction starts and ends, and after a `config.set`
model switch. In a room each bot keeps its own section, so the room has no
context of its own; the meter belongs to bot sections.
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
thread with the sender: a section with `peer_bot` set to the sender. With
`wait: true` the result is `{reply, section_id}`; with `wait: false` it is
`{status: "sent", message_id, section_id}`, and a background watcher submits
the eventual reply to the sender section as hidden input prefixed
`[reply from <bot>]`. `to` naming the sender itself answers 4202; a bot the
section owner does not own answers 4205 with the names of their other bots.

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

The `hexbot_show_html {title, html}` tool shows a visual: one self-contained
HTML page (a chart, table, diagram or mockup) drawn in the conversation. It
is a base tool, on for every bot in sections opened after it shipped. It is
left out where nobody would see the page: rooms, threads between bots,
subagents, scheduled jobs and `hexbot send`; a call there is refused. The page stays in the call's arguments, which the section
already keeps, so nothing else is stored and deleting the section deletes it.
The daemon only checks the title (1 to 200 characters) and the page (up to
512 KB) and answers `{shown: true, note}`. Clients find the visual in the
call's arguments: live from `tool.start`, restored from the assistant row's
`tool_calls`. The web UI draws it in a bot bubble between the bot's earlier
messages and its final reply, live, under a title row whose Expand button
adds a tab to the side panel; tabs stay mounted, close one by one, and close together when the user leaves the
section. Each copy runs in an iframe sandboxed with `allow-scripts` only, so the page has an
opaque origin. The frame loads `/visual-frame.html` from the web bundle,
whose own CSP allows inline scripts and a few public CDNs but no fetches, and
writes the page into it after a bootstrap that applies the theme as CSS
variables (`--background`, `--foreground`, `--chart-1` to `--chart-6`, ...),
reports the page's height, and passes http(s) link clicks to the app. Host
and frame talk in MCP Apps messages (`ui/notifications/host-context-changed`,
`ui/notifications/size-changed`, `ui/open-link`). The page cannot prove a
click was the user's, so a link only appears as an Open button under the
visual, and the browser opens it from there. Daemon pages (and `pnpm dev`)
send `Content-Security-Policy: frame-src 'self'`, so a visual cannot navigate
its frame to another site; the Electron app's own policy does the same, it
serves the frame page without that policy, and it blocks any frame
navigation other than to it.

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
last_error | null, mcp?: {name, transport, tool_count, test_failed, running}}`. `state` is
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
- `hexbot.connectors.test {id, bot?}` → `{ok, message, tool_count?}`. A successful
  connected-server probe counts all tool pages and saves `tool_count`. The connector
  list reports the last probe count, or null when untested.
- `hexbot.connectors.clear {id, bot?, bot_only?}` → `{connector}`. Admin only.
- `hexbot.connectors.set_for_bot {id, bot, enabled}` → `{connector}`.
- `hexbot.connectors.add_mcp {name, command?, args?, env?, url?, transport?}` →
  `{connector}`; `hexbot.connectors.remove_mcp {name}` → `{removed: true}`.
  Admin only. MCP servers live in the root `config.yaml` and appear as
  `mcp:<name>` connectors. New entries accept stdio or streamable HTTP. SSE
  returns 4202, "SSE is not supported. Use the server's streamable HTTP URL."
  Environment values starting with `!` are rejected.
- `hexbot.skills.list {bot?}` → `{skills: [Skill]}`. The `skills.list` alias
  accepts the same arguments. Omitting `bot` lists the library. With `bot`,
  its private overrides are included.
- `hexbot.skills.get {name, bot?}` → `{name, source, category, content,
  files: [string]}`. `files` contains sorted paths relative to the skill
  directory, including `SKILL.md`. Disabled skills remain readable by people.
- `hexbot.skills.save {name, content, category?, bot?, bots_disabled?}` →
  `{skill: Skill}`. With `bot`, creates or edits a private skill. Otherwise
  writes to the library; editing a bundled skill creates a library override.
  Supporting files survive edits and overrides. `category` is a relative
  directory path; an empty string puts the skill at the root. Omit it to keep
  the current category. `bots_disabled: [string]` is accepted only for library
  saves and disables the skill for those bots; other grants stay unchanged.
  The caller must own every listed bot. Validation rejects the whole request
  before writing any skill or grant if one bot is not owned by the caller.
- `hexbot.skills.delete {name, bot?}` → `{deleted: true}`. With `bot`, removes
  only a private skill, revealing any inherited copy. Without `bot`, removes
  the library copy, reverting to bundled if present. Bundled-only deletion
  returns 4202, "Bundled skills can be turned off, not deleted."
- `hexbot.skills.share {bot, name, replace?}` → `{skill: Skill}`. Moves a private
  skill, including supporting files, to the library. An existing library or
  bundled name returns 4208 unless `replace: true`. Grants are preserved.
- `hexbot.skills.set_global {name, enabled}` → `{skill: Skill}`. Updates the
  root `config.yaml` skill deny-list. Global disable wins over every bot grant,
  including private overrides of that library skill.
- `hexbot.skills.set_for_bot {name, bot, enabled}` → `{skill: Skill}`. Updates
  that bot's deny-list. Enabling does not override a global disable.

`Skill` is `{name, description, category: string | null,
source: "bundled" | "library" | "bot", path: string, enabled_for_bot: boolean,
disabled_globally: boolean, enabled: boolean}`. `path` points to `SKILL.md`.
`enabled_for_bot` is the bot's own grant, independent of global disables.
`enabled` is the effective value: `enabled_for_bot && !disabled_globally`.
Without a bot, `enabled_for_bot` is true and `enabled` reflects the global deny-list. Names are directory
names matching `[a-z0-9_-]{1,64}`. Saves require YAML frontmatter with a
nonempty description and a Markdown body, capped at 2 MiB. Paths cannot escape
skill directories or traverse symlinks. Categories cannot be hidden or nested
inside another skill. A skill cannot contain another skill, including in a
`skill_manage` batch. Skill reads hold a shared lock through discovery and body
reads; saves and tool commits hold the exclusive side through replacement.

Library reads require a signed-in user. All library writes, sharing and global
changes require an admin, checked through one library-write permission helper.
Private reads, writes and per-bot grants require the bot's owner, including
when the caller is an admin. Sharing requires both library-write permission
and ownership of the source bot. `bots_disabled` requires ownership of every
listed bot.
New library skills are enabled for all bots unless denied. Resolution is by
name: private skill, then user library, then bundled skill. `hexbot.bots.update
{skills}` still sets per-bot selection; returned bot skills are derived from
current config rather than `bots.skills_json`. When a skill is globally
disabled, legacy selection updates preserve its existing per-bot grant,
whether it appears in the selection or not. Config read-modify-write operations
share one process-wide synchronous lock, including connector toggles and
settings mirroring.

Successful skill mutations emit `hexbot.skills.changed` and `hexbot.bots.changed`.
Library changes reach all users with `{name}`; private changes reach the caller
and bot owner with `{name, bot}`. Legacy bot selection and connector toggles
also emit a skills refresh, with `name: null` when several grants changed.
Bot authoring emits a refresh with `{bot}`.
New sections list skill descriptions and load bodies through `skill_view`.
`skill_view` and `skills_list` check live grants without requiring the authoring
toolset. `skill_manage` still requires that toolset and writes only private
skills; deleting an inherited skill disables it for that bot. Existing sections
keep their stored prompts and tool definitions. The existing repair of leaked
About you text in unversioned shared sections remains in place.

New sections freeze connected server names and reach tools through Pi's codemode.
Saved sections keep their frozen Rust bridge tools, including SSE. New sections
skip existing SSE entries and emit an owner-scoped `warning` with `{section_id,
room_id, message}`, once per bot/server for each daemon run. Room notices name
the bot. Pi warning/error notifications use the same event. Clients
show a dismissible notice under the conversation header.

Manual asks for every connected-tool call, including tools marked read-only.
Auto runs tools with `readOnlyHint: true` freely and asks for all others. Resource
tools are read-only. Allow in this section covers one server for the running Pi session. Bypass never asks. Each nested
codemode call uses the approval gate, including shell and file tools.

Stdio servers run as Pi children in a daemon-owned directory,
`<home>/runtime/mcp/<bot>` with mode 0700, outside the shell sandbox. Configured
working directories are ignored. Each section starts its own process per server.
They inherit Pi's allowlisted environment plus their explicit `env`, not every
connector credential. Put required `${KEY}` references in the server's `env`.
Expanded values reach Pi through the private in-memory bridge, not the saved
session configuration or Pi environment. Workspace `.pi/mcp.json` is ignored.
Connectors Test uses the same environment policy and daemon-owned directory,
using `<home>/runtime/mcp/probe` when no bot is given. Failed probes set
`test_failed: true`, `state: "error"` and `state_text: "Test failed"`. Adding,
replacing or removing an entry clears its saved probe and tool count.

Every direct or nested connected-tool call checks current configuration before
approval, including in Bypass. Removal and disable revoke access immediately.
Config or credential edits block stale clients; the next prompt re-registers the
changed server and closes its old connection. The frozen prompt and declarations
stay unchanged. Reconnection clears any permission for that server. Calls that
need approval in a section with no visible chat or room entry fail immediately
and tell the bot to use a visible section. Server stderr, up to the last 2 KB,
may reach the model in tool errors.

Live `tool.start` and `tool.complete` include `parent_tool_call_id` for nested
calls. Stored parent tool rows include Pi's `nested_calls` record. Clients show
nested steps below the code step both live and after reload. Pi retains nested
arguments and status, not full nested result bodies; its record is bounded.

### Providers and models

- `hexbot.providers.list {}` → `{providers: [{id, label, configured,
  auth_type, models_source}]}` (all core providers). `configured` is
  always a boolean: key providers are checked against the deployment
  `.env` and the process env, OAuth providers against the core auth
  store in `auth.json`, read by `backend/hexbot-core/src/providers.rs`. `label` is the provider's display
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

### Connect daemon identity

`GET /api/connect/identity?nonce=<base64url>` is public, including through the
tunnel and with an HTML Accept header. It returns 404 when unregistered and
400 for a missing or invalid nonce. The nonce must be canonical unpadded
base64url encoding 16–64 bytes. An unavailable identity key returns JSON 503
with `code: "identity_unavailable"` while the daemon keeps serving. Successful responses carry `Cache-Control: no-store`.
Cross-origin GETs are public with `Access-Control-Allow-Origin: *`, without
credential permission. This exemption does not apply to other daemon routes.

The JSON response is `{daemon_id, public_key, signature}`. The public key is
32 raw Ed25519 bytes and the signature is 64 bytes, both unpadded base64url.
The signature covers these exact UTF-8 bytes, with no final newline:

```text
hexbot-identity-v1\n<daemon_id>\n<normalised Host>\n<nonce>
```

Host comes from the request's `Host` header, never a forwarded header. It is
lower-case, without a trailing DNS dot or port 80/443; other ports remain,
and IPv6 literals keep their brackets. The nonce is the encoded string,
not its decoded bytes. Host is client-chosen; anyone who can reach the daemon
can request a signature for any Host. Verify against the key obtained from Connect's daemon
list, not a key supplied by the answering address. This detects a wrong
address but cannot detect an on-path party relaying the real daemon's reply.
See [Connect trust](connect.md#trust) for the TLS and compatibility limits.

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
  tunnel_hostname, tunnel_running, last_heartbeat_at, last_error, identity_error}`.
  The two nullable error fields report tunnel/Connect and identity problems
  separately. Settings refreshes them every five seconds while the panel is open.
- `hexbot.connect.register_start {daemon_name?}` → `{device_code, user_code,
  verify_url, interval}`
- `hexbot.connect.register_poll {device_code}` → `{status}`. An approved result
  stores the daemon and tunnel credentials on the daemon and mirrors
  `dashboard.public_url`. The RPC returns only status, never those credentials.
- `hexbot.connect.disconnect {}` stops Connect, deletes `connect.json` before
  `connect-identity.key`, and removes the mirrored public URL.

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
- Device tokens use `Authorization: Bearer <token>`. Prefer `POST
  /api/auth/ws-ticket` then `/api/ws?ticket=<single-use ticket>`; tickets expire
  after 30 seconds. The legacy `/api/ws?token=<device token>` upgrade requires
  a loopback peer and a loopback Host. Direct bearer or cookie
  upgrade remains accepted remotely. Keep long-lived tokens out of URLs; the CLI
  sends its credential in an Authorization header.
- `DPoP: <signed JWT>` optionally binds a new device at `/hexbot/pair` or
  `/auth/password-login`. Password-login responses include `device_token`
  and `device_id` only when proof is attached. Without proof, browsers retain
  only the HttpOnly cookie; `return_token` does not enable token disclosure.
  Bound tokens require this header at `/api/auth/ws-ticket`, `/hexbot/session`,
  and direct `/api/ws` authentication, including tokens carried in cookies.
  Proof failures never fall back to bearer; see error codes below.
  A WebSocket ticket carries the proof-authenticated device forward, so its
  upgrade needs no further proof. Unbound devices keep the old behavior.
- Proof header: `typ: dpop+jwt`, `alg: ES256`, public P-256 `jwk`. Claims:
  `htm` is the HTTP method, `htu` is the HTTP(S) request URL without query or
  fragment, `iat` is integer seconds within ±60 of daemon time, `jti` is unique
  per key, and `ath` is base64url SHA-256 of a presented token. At Connect login,
  hash the entire `cg_<jwt>` password. The daemon compares Host, port, and path,
  normalizing case, IPv6 brackets, and default ports using the proof URL's
  scheme. Transport scheme and forwarded headers do not widen trust.
  See `docs/auth.md` for replay limits.
- Connect `POST /api/daemons/{id}/grant` accepts optional `jkt`, a base64url
  SHA-256 JWK thumbprint, and signs it as `cnf: {jkt}`. Such a grant requires a
  matching proof at daemon login. No proof on an ordinary pairing request or
  a grant without `cnf` creates an unbound device.
- `POST /hexbot/session` with the bearer token sets the browser cookie session
  for the web bundle.

Proof failures at these HTTP endpoints carry
`WWW-Authenticate: DPoP error="invalid_dpop_proof"` and JSON
`{error: "invalid_dpop_proof", code, message}`:

| `code` | HTTP | Meaning |
| --- | --- | --- |
| `invalid_dpop_proof` | 401 | Invalid claims, signature, request binding, token hash, or replayed `jti` |
| `dpop_proof_required` | 401 | A bound token or grant was presented without proof |
| `dpop_key_mismatch` | 401 | The proof key differs from the token or grant binding |
| `dpop_clock_skew` | 401 | Proof time differs by more than 60 seconds; response also includes `server_time` and `proof_time` (Unix seconds) |
| `dpop_cache_full` | 503 | Replay cache limit reached; retry later (`Retry-After: 1`) |

Clients must distinguish these responses from a revoked credential: show the
error, retain the target, and retry with fresh proofs using reconnect backoff
and any `Retry-After` minimum delay. A key mismatch requires pairing again. An ordinary credential 401 has no DPoP code
or challenge. Database failures remain HTTP 500. The cache counts only
authenticated bound-token uses (1,024 per key, 65,536 total); login proofs rely
on the pairing code or grant's single-use protection instead. CORS exposes
`WWW-Authenticate` and `Retry-After` to remote browser clients.

## CLI

- `hexbot serve [--host IP] [--port N] [--lan | --no-lan]`: starts the Rust
  daemon with Pi agents. `HEXBOT_HOME` selects the daemon state directory.
  Started in a terminal without a supervisor, it prints a one-time sign-in
  link for a browser on the same machine (`docs/auth.md`).
- `hexbot pair [--sign-in]`: prints the pairing code, expiry, address, pairing link, and QR code.
  `--sign-in` preserves outstanding codes for startup links; ordinary pairing replaces the previous code.
- `hexbot connect [status|disconnect]`: registers, inspects, or disconnects
  this daemon from Hex Connect.
- `hexbot lan on|off`: turns "Allow other devices" on or off, through the
  running daemon or offline under its home lock.
- `hexbot status [--json]`, `hexbot service install|uninstall|start|stop|restart|status|logs`,
  and `hexbot setup [--activate]`: the Headless commands, described in
  `backend/hexbot-core/README.md`.
- `hexbot devices list|revoke`, `hexbot bots list|create|delete`,
  `hexbot rooms list`, and `hexbot send <bot> <text>`.
- Native commands use the running daemon when available, preserving event
  delivery and the single runtime owner. Offline mutations require its home lock.
