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
| avatar | profile asset `avatar`; a face picked in an app also in `assets/face.json` |
| bot memory | profile `memories/MEMORY.md` (the core `USER.md` target is off) |
| history search | in-memory FTS5 index over the bot's sections, refreshed as history changes (`native_history_versions` in `hexbot-runtime.db`); the asking section is excluded from results and BM25 statistics, except that a chat Pi has compacted keeps its messages from before the latest compaction; cache budget counts retained JSON and allocated SQLite pages |
| About you | `~/.hexbot/users/<owner_id>/user.md`, injected every turn by the hexbot plugin |

## Core methods the client calls directly

- Chat: `prompt.submit {session_id, text, attachments?, input_id?}`,
  `session.interrupt`, `session.steer {session_id, text, input_id?}`.
  `session.steer` steers a healthy busy run. During Stop or manual compaction
  it waits before staging input; when idle it starts a fresh run. Close or
  process exit rejects a waiting steer with a session error.
- Recall: `session.recall {session_id, input_id? | row_id?}` → `{recalled:
  true, text}` takes back the owner's latest message in a bot's chat, named by
  the `input_id` it was sent with or its history `row_id`. A running turn
  stops first, as `session.interrupt` would. The private Pi extension moves
  the conversation back to just before the message and records the move in
  the conversation file, so the next request reuses the cached prefix and a
  restart keeps it. The message and every row after it leave the history;
  `hexbot.sections.changed {id, bot, reload: true, recalled: {row_id,
  input_id}}` tells clients to drop that message and what followed it, kept
  rows included, and read the chat again; a turn failure on this chat is
  resolved. Anything else answers 4202 and changes nothing: an older message,
  a hidden one, a room, a thread between bots or Check-ins. A Recall naming an older
  message than the one a running turn works on leaves that turn running; one
  still queued behind it answers 4002 until its own turn starts. A prompt or
  steer starting `/hexbot-recall` is refused with 4202.
  `hexbot.info.recall: true` advertises the method.
- History: `session.history {session_id, history_cursor?}` → `{messages,
  history_cursor: string, history_delta: boolean}`, using the same cursor
  rules as `hexbot.sections.open`; `session.events.since` on reconnect.
- Attachments: `image.attach_bytes {session_id, content_base64, filename}`,
  `file.attach {session_id, data_url, name}`, `pdf.attach {session_id, content_base64}`.
  `attachments.clear {session_id}` clears all unsubmitted attachments and removes
  their staged files. It refuses while the bot is working and keeps the session.
  Each attach call answers with an `id`. `prompt.submit` with
  `attachments: [id, ...]` consumes only those staged uploads. Unselected
  uploads remain staged for a later submission, including uploads from another
  paired client. An explicit empty list sends no uploads and retains all staging.
  An id that is no longer staged answers 4204 and changes nothing. Without
  `attachments`, every staged upload goes with the prompt as before. Rejected
  prompts restore selected uploads alongside unselected and newly staged ones.
  Retained uploads still count toward staging limits, prevent idle retirement,
  and survive a tools or model restart. `attachments.clear`, session close and
  section deletion remove unused staged files; submitting an exact list does not.
  Images allow 25 MiB decoded; PDFs and generic files allow 45 MiB.
  Larger attachments return 4202 with the size limit. Browser clients check
  before reading or uploading. WebSocket frames and in-flight request bytes
  are capped at 64 MiB per connection.
- Approvals: `approval.respond {session_id, request_id, choice}`
  with `choice` in `once | session | deny`. `session` ("Allow for now")
  quiets the same kind of Manual or unreviewed request until the section's
  Pi session restarts; nothing persists. Reviewed Auto cards, incomplete file
  scans and requests raised by the daemon offer `once | deny` only. Clients
  must use the card's `choices`; `session` is rejected when not offered. Delegates and
  background sections cannot wait for approval; actions that need it are
  refused. Opening a section re-emits its pending approval. Questions arrive as `clarify.request` and
  `pending_clarify` on section open; use `clarify.respond` to answer.
  Every card that stops waiting is settled once, to every client of the
  owner, by its `request_id`. An answer sends `approval.resolved
  {request_id, choice}` or `clarify.resolved {request_id, answers}` (answers
  by question id; a single question uses the request id), after the last
  question of a batch. Stop, turn end, section close and a process exit send
  `approval.expire {request_id}` or `clarify.expire {request_id}`. All four
  carry `bot` and `section_id`, and `hexbot.bots.changed {name}` follows.
  Clients settle exactly that card, so it no longer takes an answer in any
  app. A request a client saw settled never comes back from an older read
  or replay.
  In Auto, full-access shell commands, outside-workspace file changes,
  changing connected-tool calls and browser page scripts are reviewed against
  the owner's most recent messages before a card is needed. Review failures,
  unreadable evidence and steps over 20,000 characters produce a one-step
  card. Owner messages are read newest first, whole, until the 80,000-character
  request is full; an oversized stored row ends the read before parsing. When
  older messages are left out, only a low-risk `allow` runs. At most two
  reviews run per section at once. When a review starts or waits its turn
  and none was running, the section emits
  `status.update {kind: "checking", text: "Checking this step"}`; when the
  last running or waiting review ends, on any path, it emits
  `{kind: "checking", text: ""}`. Other status lines do not end the label.
  One 60-second review budget includes credential preparation, process startup
  and provider requests. On a timeout, a started process has bounded shutdown/reaping
  cleanup before the fallback card; temporary state is kept until cleanup finishes.
  The final evidence check and approval enqueue are ordered with owner prompt,
  steer and room-message writes. Changed or pending owner messages invalidate
  automatic approval. ACP review isolates the CLI home/configuration and
  retains explicit GitHub-token authentication; unavailable stored login,
  configured arguments beyond `--acp`/`--stdio`, or incompatible isolation
  flags also produce a one-step card.
  Stop cancels pending approvals, questions and Auto reviews, including the
  primary bot's approvals that ask even in Bypass. Approvals and
  questions arriving while the turn is stopping are cancelled before Pi's abort
  finishes, without publishing new cards. A client answer that Stop has already
  claimed returns 4204. An answer committed to Pi before Stop can finish;
  duplicate answers cannot commit again. Partial clarification answers remain
  waiting, and a failed final enqueue leaves the last question retryable.
  Queued input arriving during Stop waits until Stop finishes and the stopped
  run or command completes, then starts or joins a fresh run. Input already
  accepted into Pi's queue is recovered at that boundary too, before later
  input is admitted. Pi's steering-before-follow-up order is preserved, with
  each input's original display intent, images, file references and Chain.
  Queued input is held in memory. A model or tool change hands waiting input
  to the replacement process; it is lost only when the daemon restarts or Pi
  crashes.
  Input reaches Pi one at a time: later input waits until Pi acknowledges
  the earlier prompt.
  Replay uses acknowledged intents and actual user projections, so identical
  text remains distinct even when Pi omits it from returned queue metadata.
  A delayed original submission that starts after Stop finishes runs once as
  fresh work. Its acknowledgement records the new operation before recovery
  or later input can proceed. An active Stop keeps cancellation ownership until
  its cleanup finishes.
  Recovery keeps the same Pi session, stored history, prompt and tools.
  Idle Stop needs no run-settlement event. A new owner prompt or `/compact`
  arriving while idle recovery finishes waits for the admission handoff; it
  does not return 4002 just because the recovery worker has not run yet. An
  active Stop, unfinished run, or input reserved ahead of it or while it waits
  still returns 4002.
  That run accepts tools, approvals and questions again.
  If abort fails or times out, Pi exits and waiting deliveries report an error.
  Without OS isolation, shell commands require user approval even with
  `full_access`; review cannot replace
  it. An explicit Allow for now (`session`) can cover unreviewed requests when offered.
- Per-section model override: `config.set {key: "model", value, session_id}`.
- Model picker source: `model.options`.
- Keys: `model.save_key`, `model.disconnect`.
- Health: `gateway.ping`, `gateway.capabilities`.

Events the client renders: `message.start`, `message.delta`, `message.interim`,
`message.complete` (turn end), `reasoning.delta`, `thinking.delta`, `tool.start`, `tool.complete`,
`approval.request`, `approval.resolved`, `approval.expire`, `clarify.request`,
`clarify.resolved`, `clarify.expire`, `status.update`, `session.info`, `session.usage {usage,
context}` (the section's totals and its context meter, see Sections), `error`.
Reported reviewer usage contributes to section totals, room turn budgets and
the bot's daily token budget without adding reviewer text to the conversation.
Copilot ACP reports zero token usage and cost, so its reviews add no measured
usage to these totals or budgets.

### Optional transcript identity

`hexbot.info.transcript_identity: true` advertises authoritative metadata when
present. A missing or false capability keeps the legacy request shapes.
Coverage is partial. Historical, recovered, queued and ambiguous rows may omit
identity fields even when the capability is true.

`prompt.submit` and `session.steer` accept a fresh, lowercase hyphenated,
nonzero UUID `input_id`. It reserves the existing native prompt-intent key
before uploads move or Pi receives the command. Invalid or already reserved
IDs return 4202 without taking another intent or changing staged uploads.
Successful staged submissions echo a supplied `input_id`; callers that omit
it retain the original response shape. This is correlation only, with no
idempotency, retry or automatic resend promise. A refusal from Pi returns
5201. When the bot's process fails before Pi answers, the reply is 5200:
Pi may already have taken the message.

Manual `/compact` is a daemon command, not a Pi user or operation. It sends
no uploads; staged files stay staged. A supplied `input_id` is reserved
before Pi compacts and freed if Pi does not compact. After a compaction the
reply echoes it, and the `/compact` user row the daemon stores carries it.
That row and its summary notice have no `turn_id` or `message_id`.

A user projection exposes `input_id` only for a proven binding to that actual
Pi user. The current producer binds the sole identified `started` operation's
initial user slot through ordered transport preflight, including transformed
and image input. A queued or steer ACK, equal text, display matching or a late
RPC reply cannot establish ownership. Same-text queued and steered inputs
remain unbound, including a follow-up dequeued before a late steer ACK.

`turn_id` names each actual Pi agent operation, independently of room turns,
visible users and input IDs. One operation may consume several users or no new
user and produce several assistant fragments. Each actual assistant
`message_start` allocates `message_id`. Its durable assistant `row_id` is that
same value, retained through SQLite retries and full-raw reconciliation.
The existing `message.start` timing remains at `agent_start` and carries only
`turn_id`. Later deltas, reasoning, interims, tool events and completion carry
the optional IDs when known. There are no extra legacy starts per fragment.
Tool-event `message_id` names the assistant that actually owns `toolCallId`.
Unknown, nested or ambiguous owners omit it. An explicit `parentToolCallId`
prevents direct-call attribution even when the nested ID equals an earlier
top-level tool ID. Tool-result history keeps its
own distinct `row_id` and `tool_call_id`. Cards may omit fragment association.

Terminal metadata is captured at `agent_end`, rather than read from a newer
operation at settlement. Unmatched settlement cannot finish a known active
operation. Error, EOF and compact paths do not invent an assistant fragment.
Independent operations can settle out of order. When their untagged settlements
cannot be paired, terminal IDs are omitted while durable rows retain their IDs.
A live fragment ID alone does not prove a durable row. Clients adopt
authoritative history and keep unresolved local files unconfirmed rather
than attach them to another user. Committed projection metadata survives
reconcile/restart. A raw-only recovered occurrence cannot recover a client
UUID from text, position or an old pending intent and omits `input_id`.
All identity metadata stays outside the original Pi messages, model context,
frozen prompts, tools, options and usage records.

## `hexbot.*` methods

All results are objects. Errors use JSON-RPC error objects with core-style
codes. Code `4302` means `not the owner`.

A daemon belongs to one person. Bots, sections, rooms, devices, dreams,
activity, and memory are scoped to the authenticated user, and get and
mutation methods check ownership.

### Daemon

- `hexbot.info {}` → `{version, hermes_version, daemon_name, install_id,
  auth_required, lan_enabled, addresses: [string], platform, sandbox, home,
  update_capability, one_chat, transcript_identity?}`. See optional transcript
  identity above. `one_chat` is true once
  `hexbot.sections.create` returns the bot's one chat; older daemons leave it
  out. `update_capability` is `desktop` when the Hexbot app
  on that machine runs the daemon, `service` when launchd or systemd does,
  and `null` for a checkout or a hand-started daemon. `sandbox` is the OS
  sandbox shell and code tools run in: `sandbox-exec` on macOS, `bubblewrap`
  on Linux after a successful probe, and `null` when there is none; Settings,
  Approvals shows a notice then. The compatibility field
  `hermes_version` carries the pinned agent core version. `home` is the daemon
  state path. `auth_required`
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

Bot shape: `{name, display_name, title, description, primary, persona, tools: [string], available_tools: [string], skills: [string],
provider, model, reasoning_effort | null, avatar: {mime, data} | null, face: {shape, color} | null,
created_at, updated_at, last_activity_at,
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
room `waiting.human` events, and open incidents. Only a bot's chat and its
room sessions make it `working`; check-ins, scheduled jobs, dreams, CLI runs
and subagents never do, though one waiting on the user still makes it
`needs_you`. `status_detail` is
`{text, section_id, room_id, session_id, since, action}` where `action` is
null, `{kind: "fix_connector", connector}`, or `{kind: "retry"}`. A room's
failed turns count only while the bot is still in that room; adding it back
restores them. When a message you send, such as Retry, starts a turn in a
private section, it resolves that section's own failed turn: same bot and
owner, no room. Room, connector and other sections' failures stay, and
background, room and other hidden runs resolve nothing when they start.
`hexbot.bots.changed {name}` follows the start of each turn, once per turn,
and any start that resolved a failure, so clients show Working instead of
Stopped. Pi decides where an owner's input starts a turn, including an idle
steer and a message queued behind a settling run.
Failing again records a new incident.
`approval_mode` is `inherit` (the deployment setting), `manual`, `smart`
(Auto), or `off` (Bypass); `workdir` overrides the deployment workspace for
that bot's terminal.
`reasoning_effort` is the bot's Pi thinking level: `off`, `minimal`, `low`,
`medium`, `high`, `xhigh`, or `max`, stored as `model.reasoning_effort` in
the profile's `config.yaml`. Null means Pi's default, `medium`; Pi rounds a
level the model lacks up to the next one it has, else down. Changing
`provider`, `model` or `reasoning_effort` moves every section of the bot still
on the previous value; each one restarts its Pi process on the same
conversation and live ID the next time it is reached while idle. A turn
already running, a message queued behind it, and files already attached
finish on the model they started with. Switching models costs the cached
prefix once. A section on something else, like a scheduled job with
its own model or `reasoning_effort`, keeps it.
`face` is the shape and colour of a face picked in an app (ids from
`apps/web/src/lib/avatar-builder.ts`, such as `{shape: "pill", color:
"orange"}`), stored in the profile's `assets/face.json`. The app saves the
face as the `avatar` PNG too, for clients that only show pictures; clients
that know `face` draw it live and wash the bot's bubbles with its colour.
It is null when no face was picked, and it is cleared whenever the avatar
changes without one (a photo, `avatar: null`, or `profiles.set_asset`), so it
never describes a picture it did not come with. `hexbot.bots.update` refuses
a non-null `face` without an `avatar` in the same call (4202), so a face never
lands on a photo. Older daemons leave it out and refuse `face` in writes
(4201 `unknown bot field: face`); the web app then sends the write again
without it, and the face is kept as the picture alone.
`workdir` and the `workspace_dir` setting are refused (4202) when they resolve
inside the Hexbot home, symlinks included.

`primary` is true for the primary bot, the one bot that looks after the
others (`DESIGN.md`, "The primary bot"). There is at most one per owner.

- `hexbot.bots.list {all?}` → `{bots: [Bot]}`, the primary bot first, then by
  `last_activity_at` desc.
- `hexbot.bots.get {name}` → `{bot: Bot}`
- `hexbot.bots.create {name, display_name?, title?, description?, persona?,
  provider, model, avatar?, face?}` → `{bot: Bot, section: Section}` (creates the
  profile with `mirror_credentials: true`, applies persona and model, stores
  the avatar, mirrors the deployment settings into the new profile's
  `config.yaml`, creates the first section titled "General").
  Any field `hexbot.bots.update` accepts may also be given here and is stored
  the same way.
  `display_name` defaults to the bot name in title case — never to `title`,
  which is free-form caller text stored verbatim.
- `hexbot.bots.create_primary {display_name?, provider?, model?,
  reasoning_effort?, avatar?, face?}` → `{bot: Bot, section: Section}`. Creates
  HexBot: handle `hexbot`, display name "HexBot" unless given, title
  "Primary bot", a soul for looking after the user's bots, and every
  available tool. Refused with 4214 when there is already a primary bot and
  with 4208 when a bot called `hexbot` exists (make it primary instead).
  `hexbot.bots.create` refuses the handle `hexbot` (4202).
- `hexbot.bots.set_primary {name}` → `{bot: Bot}`. Makes an existing bot
  primary; refused with 4214 once there is one. Its chat takes the primary
  bot's tools with its next message, which misses the prompt cache once.
- `hexbot.bots.introduce {name, section}` → `{submitted: true, section}`.
  Resumes the section on the calling transport, then submits the bot's
  hidden first prompt (`backend/hexbot-core/src/catalog.rs`): a one-line greeting and up to
  three clarify questions about what the bot is for, whose answers it writes
  into its soul and memory. Clients call it right after `hexbot.bots.create`,
  once they have navigated to the section. Refused (4243) once the section
  has messages.
- `hexbot.bots.update {name, display_name?, title?, description?, persona?,
  provider?, model?, reasoning_effort?, avatar?, face?, dream_enabled?,
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
  directory, all rows, the bot's scheduled jobs, and the memory proposals those jobs left;
  refuses with 4211 while any conversation has active work, Stop cleanup or
  recovery, or input reserved to run next, with `data.sections: [{id, status}]`,
  and with 4214 for the primary bot before any of its sections stop).
  Reserved input and Stop recovery report `working` in this refusal even after
  the previous run has settled. Deletion can proceed once that work finishes.

### Sections

A bot has one chat with its owner: the one section of that bot with no
`peer_bot` and no `purpose`. The other sections are threads (`peer_bot`
set) and, for the primary bot, its Check-ins (`purpose` `checkins`). Rooms keep their
conversations in `room_sessions`, not here. On its first start after the
upgrade the daemon keeps one chat per bot (`catalog::one_chat_per_bot`, once,
recorded as the `one_chat_per_bot` setting): for a bot with several, the one
with non-report dialogue, then not archived, then newest, and deletes the
others with their history. It runs in `App::new`
before `Runtime::new`, so no client is connected, and it is tried once. Before
deleting anything it makes a fresh full copy of `hexbot.db`,
`hexbot-runtime.db`, the affected bots' `state.db` and all of
`runtime/sessions` in `<home>/backups/one-chat-per-bot-<time>/`, so it needs
about that much free disk space. The setting is written before the first
delete. If copying, `reconcile_all`, catalog deletion or history cleanup
fails, the error is logged, an unfinished copy (`one-chat-per-bot-<time>.partial`)
is removed, nothing more is deleted, the setting is written anyway, and the
daemon starts; the sections left are kept for good and no later start deletes
any. Each delete uses the private cleanup helper: once its catalog
row is gone it stays deleted, even if history cleanup fails. Native cleanup
retries at startup; it never resumes the migration's remaining deletes.
A bot with a conversation that recovery set aside or could not read, or whose `state.db` cannot be read, keeps all its sections. Sections
made later, by an older build, are never deleted. `hexbot.sections.create`,
and a dream posting its report, rank a bot's healthy sections the same way,
so a report-only Dreams log never outranks a conversation. A mixed log with
non-report dialogue competes as a conversation; the daemon filters reports
using stored dream summaries and message markers, never title or prefix
heuristics. For known mixed logs, reports never advance dialogue recency.
If a report followed the dialogue, or a message timestamp is absent or invalid,
the upgrade preserves every section of that bot and chooses the chat using
known non-report dialogue times. Older reports and the old `unarchive` RPC
both write `updated_at`, without recording why. A report can overwrite a saved
choice, and the separate report and catalog timestamps cannot prove whether a
choice came after the report either. The daemon cannot recover that intent:
it preserves the competing histories instead of deleting either. When the
latest report predates the dialogue, a later catalog update still counts,
preserving an explicit choice without another message. Unreadable history stays untouched. A section that recovery
set aside or could not recover, or whose history is only in an unreadable
`state.db`, is never the chat, since it would not open; when nothing else is left, `create`
makes a new General chat and the other stays for repair. Sections `create`
makes are recorded in `native_fresh` and open without reading `state.db`.
Transient native recovery failures are recorded in `native_unrecovered`, so
lookup skips them without rereading the Pi logs or attempting recovery under
the catalog write lock. A successful recovery on a later start clears the record.
Before anything else, the upgrade finds each bot's old Dreams logs and
records them as the `dream_logs` setting, with the bots it could read as
`dream_log_bots`: only in those logs are messages matching a dream summary
treated as dream reports, when the log is first opened, in history search
and in a dream's digest. A bot whose `state.db` could not be read then
has its logs found at the next `create`, first open or history search that
can read the store (`catalog::dream_logs`); until then the recorded logs stand.
Classification also inspects current sections at chat lookup and before a dream,
so logs recreated by an older build after migration are marked too. This never
repeats migration deletes or changes Pi context. A failed classification stops
the dream before it can learn from uncertain reports. Filesystem metadata errors
are read failures, not missing legacy databases; backup cannot omit such a database.

Already-imported legacy Dream logs can contain reports in Pi JSONL as well as
in the display projection. When one would become the owner chat, chat lookup
starts an independent section with the original dialogue and marked display
reports. Its context replays the selected branch's original messages, expanding
compaction and branch summaries, and excludes the reports. Original JSONL,
journal, frozen options and prompt remain unchanged. `dream_chat_adoptions`
records the source, replacement and source history version. Lookup prefers the
healthy replacement. Dream input omits the copied source snapshot and its old
summaries; later writes from old clients remain eligible. Copied usage is zero;
original usage remains on the original conversation.

Bot deletion blocks new bot starts and waits for opens already in progress,
including hidden jobs, CLI runs and room turns. New starts fail with 4211 while
deletion waits or runs. One-shot description and review processes also finish
shutting down before cleanup, even if their caller was cancelled. Active turns
still refuse deletion with 4211, including work that became active while opens
were draining. It retires sessions before changing the catalog, then atomically
removes its sections, bot and room mappings before purging history or profile
files. A `pending_bot_delete:<name>` settings journal records exact native,
legacy-only, room, retained and delegated targets and the catalog commit decision.
Its native retirement claim is recorded before retirement, without changing any
previous retention choice. Only a committed bot decision promotes those targets
to purge. A failed bot decision releases its own provisional claim and preserves
earlier committed section deletions, frozen options and completed cleanup. Startup
rolls back uncommitted retirement or finishes committed cleanup. A committed
cleanup failure returns `{deleted:true, history_pending:true}` and keeps its
journal for startup retry. No failed catalog commit removes history, memory or
notes. Creation refuses with 4208 while that name has a pending deletion, even
if its profile is already gone. App create/delete requests are ordered across
retirement and cleanup; startup cleanup re-reads the decision under the same
catalog write reservation used to reserve a new profile. The shared product-tool
boundary is acquired before either database writer, including during bot and
room cleanup. If an older journal
conflicts with a catalog bot, or its remaining profile has no name-reservation
provenance, cleanup reports an error and keeps the files, jobs and journal for
manual recovery. This does not reconstruct data already purged by an older build.


Section shape: `{id, bot, title, title_by: "bot" | null, created_at,
updated_at, archived_at | null, done_at | null, preview, message_count,
live_session_id | null, peer_bot | null, purpose | null}`

`peer_bot` is set on a thread: the private conversation in which `peer_bot`
asked `bot` for help through `message_bot`. `purpose` is set on a section
with its own job, so far only `checkins`, the primary bot's Check-ins; it
is never the bot's chat. Daemons from before one chat per bot leave it out;
there, `hexbot.checkins.status` names the Check-ins section.

`title_by` is `"bot"` when the daemon named the section from the first
prompt; a user rename clears it. Clients do not show chat titles. `preview`
is the latest visible message from either side, as a chat list shows it, also
returned by `open`.

- `hexbot.sections.list {bot?, include_archived?, include_threads?}` →
  `{sections: [Section]}`. Threads are left out unless `include_threads` is
  true; so are the `sections_total` and `sections_recent` of a bot.
  A section still called `New section` takes its title from the first prompt
  as soon as `prompt.submit` accepts it, before the bot replies. The
  `General` section created with a bot, and any name the user or bot set, are
  kept.
- `hexbot.sections.create {bot}` → `{section: Section}`: the bot's chat,
  made titled `General` on first use. An archived chat comes back. A `title`
  from an older client is ignored. Clients call it for the bot's chat rather
  than pick from their own list, which cannot tell a section recovery set
  aside. A retained old Dreams conversation stays the chat while it is open,
  including accepted messages, uploads and background work. Once it closes or
  retires, a later lookup can move it to a chat without the old reports in
  model context. Opening its old ID then returns `4002` with the replacement
  ID; the client must resolve the bot's chat again before sending input, and
  `hexbot.sections.list` no longer lists it. The new chat replays the log's
  original messages, not its old summaries, which were written with the
  reports in context. Its first reply therefore reads the whole history
  without the prompt cache, once; a history past the model's window is
  summarised the way any chat that outgrew it is.
  A daemon without `one_chat` in `hexbot.info` makes a new section on
  every call, so clients there list the bot's sections and call `create`
  only when it has none. Its upgrade keeps the latest conversation, giving
  way only for a report-only log, which its list cannot tell apart, so a client
  opens a section by itself only while at most one has something said (the
  newest open one when none has); otherwise the user picks among those, once
  per bot while the app runs. Every resolved choice is persisted with
  `hexbot.sections.unarchive`, supported by older daemons: it updates
  `updated_at` even for an open section. The pick is remembered only after
  that RPC succeeds. A real conversation then survives upgrade without
  another message. Cancelled or obsolete lookups do not save a choice.
- `hexbot.sections.thread {bot, peer}` → `{section: Section | null}`: the
  caller's thread on `bot` whose sender is `peer`. It never creates one.
- `hexbot.sections.open {id, history_cursor?}` → `{section: Section,
  messages: [Message], history_cursor: string, history_delta: boolean,
  context: Context, pending_clarify?, busy, pending_requests}` (resumes the
  stored session on the bot's profile; idempotent if live). If the bot is waiting on an approval,
  the daemon sends its `approval.request` event again so a reloaded client
  gets the card back; clients dedupe on `request_id`. `busy` says whether a
  turn runs at this read and `pending_requests` lists the `request_id` of
  every approval and question still waiting. A client that missed events,
  such as while it was offline, drops the unanswered cards it showed before
  the read that are not listed, and ends a turn it showed when `busy` is
  false. Answered cards and anything received during the read stay. The web
  app reads a chat again each time it opens it and after a reconnect. The
  three fields come from one moment.
  A missing catalog section returns code `4204`. Ordinary web bot-chat routes
  resolve the daemon's canonical chat before opening history, displaying it,
  or enabling input, including saved routes and already-loaded live IDs.
  Explicit peer threads keep their own route. Metadata or open failures keep
  the selected route and offer Retry, including when canonical resolution
  returns the same ID. Late replies from an obsolete route or daemon do not
  redirect the current view.

Both history methods always return an opaque `history_cursor`. Keep it with
exactly the displayed snapshot for that conversation on that daemon, then send
it with the next read. If `history_delta` is true, append `messages` in order;
an unchanged conversation returns an empty array. If false, replace the entire
snapshot with `messages`. A read without a cursor returns the full history.
The rows and returned cursor come from one database snapshot. The cursor
survives a daemon restart. Edits, deletions, backfills, reordering and journal
changes that hide or reveal messages invalidate it, so the next read returns
full history. Malformed, unsupported, out-of-range or different-conversation
cursors also return full history rather than an error. The cursor format is
private; clients must not construct or interpret it. After a canonical chat
replacement, resolve and open the new ID as above; an old conversation's cursor
cannot make that replacement return a delta, even when message IDs were copied.
Older daemons omit both cursor fields and always return full history.

`Context = {tokens, window, compact_at, compacting, recounting, seq}` is how
full the section's context is: Pi's own estimate of the tokens the next
request will carry, the model's context window, and the point where Pi
summarises older messages (the window minus the reserve the daemon wrote for
that model in the bot's Pi `settings.json`, as that section's Pi process
loaded it at start; see `backend/hexbot-core/README.md`). Pi triggers when
context tokens exceed `compact_at`. The threshold can be zero or negative if
that process loaded a reserve at least as large as the model's window.
`tokens` is null when Pi has no context estimate, or right after a summary
until the next reply measures the context. An explicit null in Pi's context
result sets `recounting` to true, so a client keeps the meter in a neutral
state, including after process retirement or daemon restart. Missing context
usage leaves `recounting` false. `window` and `compact_at` are null when Pi
has no model. `compacting` is true from a compaction's start until Pi
reports it done. `seq` grows with every report of the daemon; the daemon
measures each report in its own task and drops one a later report has
overtaken, and a client drops a report whose `seq` is below the one it holds.
The same object rides on every `session.usage` event, which the daemon sends
after each turn, when a compaction starts and ends, and after a `config.set`
model switch. In a room each bot keeps its own section, so the room has no
context of its own; the meter belongs to bot sections.
- `hexbot.sections.rename {id, title}` → `{section: Section}`
- `hexbot.sections.archive {id}` / `hexbot.sections.unarchive {id}` → `{section}`
  Current clients offer neither action for a chat; both remain available to
  older clients.
- `hexbot.sections.delete {id, purge_memory?: true}` → `{deleted: true, history_pending?: true}`
  Deletes only a peer thread (`peer_bot` set) or a section with its own
  `purpose`, such as the primary bot's Check-ins, which also forgets what
  check-ins said there. Any other owned section is a bot chat, including
  archived sections and legacy sections kept for repair. Deleting it returns
  error `4202`,
  `A bot chat cannot be deleted; delete the bot to remove it`.
  Ownership and missing-section errors take precedence. Rejection leaves
  the live session, pending work, staged uploads and stored history untouched,
  emits no change or deletion event, and ignores the purge option. Opening
  or creating the bot's chat still resolves its existing conversation.
  Deleting the bot removes its chat through bot deletion's existing cleanup;
  the one-time migration can still retire superseded chats privately.
  An allowed peer-thread deletion closes the live session and its delegated
  tasks, removes the catalog row and permanently blocks the deleted IDs from
  reopening or accepting late messages or delegated results.
  By default, or with `purge_memory: true`, it deletes native transcripts,
  session settings, Pi files in `runtime/sessions/<id>` and matching legacy
  `state.db` sessions and messages, including descendants. With
  `purge_memory: false`, those records and files remain across daemon restarts.
  Retained history is no longer available through the section or session APIs;
  there is no restore RPC. The historical parameter name refers to section
  history. Neither choice changes the bot's `MEMORY.md` or daily notes.
  The durable tombstone and retention choice precede the catalog transaction;
  history removal follows its commit. A stop before that commit keeps the
  section whole. A failed parent deletion preserves any descendant deleted
  earlier, including its ownership, retention choice and completion marker.
  Overlapping deletion attempts cannot undo one another's committed markers.
  After the catalog commit, startup preserves retained history or retries an
  interrupted purge. A durable completion marker prevents later startups from
  repeating successful native, file and legacy cleanup; the tombstone remains.
  Bulk bot deletion also skips descendants completed earlier in the same pass.
  An explicit storage cleanup retry can remove replacement artifacts for an
  already completed ID.
  Product tools and Python tool callbacks also reject deleted source IDs,
  including retained conversations. An admitted product-tool write finishes
  before deletion commits, even if its waiting tool call was cancelled. Bot
  model changes leave retained section settings alone.
  Cleanup failures after the catalog commit are logged and deletion still
  succeeds with `history_pending: true`. A catalog failure returns an error
  and releases only that attempt's provisional markers. Migration and bot
  deletion stop when cleanup is pending, leaving later sections untouched.
  Tombstones from earlier builds record no retention choice. Startup reopens
  those still belonging to a surviving section, owned room mapping or exact
  uncommitted bot deletion journal, along with their owned delegated tasks.
  Recorded committed deletions, retained history and completed cleanup stay
  closed. Other old tombstones are destructively cleaned up, including
  identifiable legacy history.
  Legacy cleanup requires known bot ownership; older tombstones that have lost
  it can leave unread legacy rows. Usage accounting and upgrade backups are
  kept. `hexbot.bots.delete` purges the bot's owned history, including retained
  sections whose catalog rows have already gone.
- `hexbot.sections.touch {id}` is internal; activity is stamped by the plugin
  on `message.complete`. It also sets the section's `done_at`.
- `hexbot.sections.mark_read {id}` → `{section: Section}` clears `done_at`:
  the user has seen the finished work. Broadcasts `hexbot.sections.changed`,
  so the green dot clears on every device.

### Memory

- `hexbot.memory.user.get {}` → `{text, cap: 2000, updated_at}`. The caller's
  About you text, injected as the plugin prompt section
  `hexbot.about-you` into new sessions. Existing sections retain their saved
  prompt, including About you, after ownership is folded.
- `hexbot.memory.user.set {text}` → same as get. Broadcasts
  `hexbot.memory.user.changed`.
- `hexbot.memory.bot.get {bot}` → `{memory_md, cap: 2200}`
- `hexbot.memory.bot.set {bot, memory_md}` → same as get.
- `hexbot.memory.notes.list {bot}` → `{days: [{date, text}], today, cap:
  4000, retention_days: 30}`. The bot's daily notes, newest day first, each
  `date` a local day of the daemon as `YYYY-MM-DD`; `today` is the daemon's
  current day, so a client in another timezone labels Today and Yesterday
  as the daemon files them. Owner only.
- `hexbot.memory.notes.set {bot, date, text, expected?}` → `{date, text,
  cap}` writes one day as given; an empty `text` removes the day. Future
  dates and days older than 30 days return 4202 before any write. With
  `expected`, the text the editor loaded, a changed
  day returns 4209. The app merges appended lines or keeps the draft on
  other conflicts.
- `hexbot.memory.notes.delete {bot, date, expected?}` → `{date, deleted: true}`.
  With `expected`, deletion returns 4209 if the day has changed; the file stays.
  The app refreshes the list while keeping the selected day and any draft;
  a kept draft still saves with the text it was loaded from as `expected`.
  Notes are written by the bot through its `memory` tool (`note`, and `read`
  with `notes`); see `docs/dreaming.md`.

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

### Check-ins

The primary bot's own looks at what is going on (`DESIGN.md`, "Check-ins").
Settings `checkin_enabled`, `checkin_every_minutes` (15 to 1440) and
`checkin_hours` (`HH:MM-HH:MM`) go through `hexbot.settings.set`.

- `hexbot.checkins.status {}` → `{enabled, every_minutes, hours, bot,
  section_id, running, next_run_at, wakeups: [{id, at, local, note}], recent:
  [{id, bot, kind, started_at, finished_at, status, summary, messaged}]}`.
  `bot` is the primary bot or null; `kind` is `heartbeat`, `wakeup`, or
  `manual`; `section_id` is its Check-ins section once it has one.
- `hexbot.checkins.run_now {}` → `{id, kind, status}`. Error 4246 without a
  primary bot, 4243 while one runs.
- `hexbot.checkins.cancel_wakeup {id}` → `{cancelled: true}`; 4244 if it ran
  or is unknown.
- Changes broadcast `hexbot.checkins.changed {bot?}`. A message from a
  check-in broadcasts `hexbot.sections.changed {id, bot}` and then
  `hexbot.checkins.message {bot, section_id, id, row_id, timestamp, text}`
  with the whole text; `row_id` is the message's id in the section history.

### Computer

The daemon has one computer that its bots share: a Cua sandbox, a Linux
desktop made from the `linux` image the first time a bot or the user turns
it on. Every bot with Computer use (`computer_use` in its tools) works on
it. The daemon drives it with the `cua` CLI on its own computer
(`computer_use.command` in config, `HEXBOT_CUA_CMD`, or `cua` on the path)
and runs `cua mcp` for the bots' actions. It passes `CUA_TELEMETRY=0` unless
`computer_use.telemetry` is true. The sandbox is named
`hexbot-computer-<hash>`, unique per daemon home. Deleting a bot leaves the
computer and removes only its cursor.

The desktop has one pointer and one focused window, so bots take turns one
action at a time; a bot that waits more than two minutes gets error 4209.
The daemon records where each bot last acted so clients can draw its
cursor there.

- `hexbot.computer.status {}` → `{available, state, control, actor,
  activity, cursors: [{bot, x, y, action, at}], error, size, sizes: [{name,
  cpu, memory_gb}], image}`. `available` is false when the daemon's computer
  has no Cua. `state` is `absent`, `starting`, `running`, `stopping`,
  `stopped`, `restarting`, `resetting` or `error`. `control` is `bot`, or
  `user` while the user has taken over; the bots' actions are refused until
  it is `bot` again. `actor` and `activity` are the bot acting and its action,
  such as `click`. A cursor's `x` and `y` are fractions of the screen and
  `at` is when it last acted, in seconds.
- `hexbot.computer.start|stop|restart|reset {}` → the status. The step runs
  on and reports by event; a first start downloads the image. Reset deletes
  the computer and makes a new one at the chosen size. Error 4209 while
  another step runs.
- `hexbot.computer.control {holder: "user" | "bot"}` → the status.
- `hexbot.computer.view {control?}` → `{path, control, expires_at}`. `path`
  is relative to the daemon, `/hexbot/computer/<token>/viewer/#ticket=…`:
  Cua's viewer, served by the daemon for an hour, so it works over LAN,
  Tailscale and Connect. Without `control` it only watches. With `control`
  the user takes over and the page takes clicks and keys. Handing the
  computer back closes the pages that could type. The token in the path is
  the credential; the daemon drops cookies and the viewer's own ticket
  authorises its calls.
- `hexbot.computer.configure {size: "small" | "medium" | "large"}` → the
  status. Small is 2 CPUs and 4 GB, medium 4 and 8, large 8 and 16. A new
  size applies when the computer is next made, so after Reset.
- Changes broadcast `hexbot.computer.changed {state, control, actor,
  activity, cursors, error}`.

### Scheduled jobs

Paired apps manage the scheduler through the same owner checks and job storage
as the bot's scheduling tool. Every method requires `bot`. Job mutations
broadcast `hexbot.jobs.changed`.

- `hexbot.jobs.list {bot, include_disabled?}` returns `{jobs}`.
- `hexbot.jobs.create {bot, name?, prompt?, schedule, script?, workdir?, model?,
  provider?, reasoning_effort?, skills?, repeat?}` returns `{job}`. Jobs need
  instructions or a script. Wall-clock schedules use the daemon's timezone.
- `hexbot.jobs.update {bot, job_id, ...changes}` returns `{job}`.
- `hexbot.jobs.pause {bot, job_id}` / `hexbot.jobs.resume {bot, job_id}` return `{job}`.
- `hexbot.jobs.remove {bot, job_id}` removes the job.
- `hexbot.jobs.run {bot, job_id}` starts the job without waiting for its schedule.

The daemon enforces unattended approval rules and script workspace restrictions.
The mobile app displays the last status, error and up to 12,000 characters of output
stored on the daemon. Jobs do not send push notifications.

Scheduled jobs and their delegates cannot call `message_bot`. Jobs use Auto
when the bot's approval mode is Bypass; Manual remains Manual. Scheduled
scripts require OS isolation in every mode. Actions that need approval are
refused immediately in jobs and their delegates. Memory writes become proposals
for the next dream, and soul writes are refused. See [Dreaming](dreaming.md).

### Rooms

Room shape: `{id, name, owner_id, main_bot, approval_mode, limits,
created_at, updated_at, last_activity_at, archived_at, members}`. Member rows
include `display_name` for bots and for the owner, and keep `left_at` after
departure so old transcripts retain their identities.
`limits` is `{bot_turns_per_human_turn?, budget_tokens_per_human_turn?}`,
each a whole number or null (use the system setting); other keys are
rejected with 4202. Rooms saved by earlier builds may still hold
`room_bot_turns_per_human_turn` or `room_budget_tokens_per_human_turn` in
`limits`; those keys are ignored, so such a room uses the system settings
until its limits are saved again. Only the owner uses a room (4302 otherwise),
and its bots run as the owner.

- `hexbot.rooms.list {include_archived?}` → `{rooms: [Room]}`
- `hexbot.rooms.get {id}` → `{room: Room}`
- `hexbot.rooms.create {name, members: [bot], main_bot?, limits?, approval_mode?}`
  → `{room: Room}`
- `hexbot.rooms.update {id, name?, main_bot?, limits?, approval_mode?}` → `{room}`
- `hexbot.rooms.add_member {id, bot}` / `hexbot.rooms.remove_member {id, bot,
  keep_room?}` → `{room}`. Removing the last bot deletes the room; with
  `keep_room: true` that removal is refused with 4216 instead, checked in the
  same statement that removes the bot.
- `hexbot.rooms.send {id, text, attachments?}` → `{event}`. This queues the
  room engine after writing the user event.
- `hexbot.rooms.log {id, after_seq?, before_seq?, limit?}` → `{events}` in
  ascending room sequence order. `limit` is capped at 1000. With `before_seq`,
  the events are the newest `limit` before that sequence, so a client can open
  a long room at its latest messages and page back.
- `hexbot.rooms.stop {id}` → `{stopped: true}`
- `hexbot.rooms.archive {id}` → `{room}`
- `hexbot.rooms.unarchive {id}` → `{room}`
- `hexbot.rooms.delete {id}` → `{deleted: true, history_pending?: true}`
  New posts, worker starts and mapped session opens fail with 4211 while the
  room is being deleted. Opens already in progress finish before the daemon
  captures and closes its sessions. A cancelled request still completes the
  deletion or rollback. A failed decision releases admission; removing the
  last bot also releases it if a concurrent join keeps the room.
  Member removals are ordered per room and pause new work until the removal
  finishes; other bots may still join while its processes close.
  The room, its mappings and its owned turn failures change in one catalog
  transaction before transcript or Pi-file cleanup. A failed decision keeps
  history, frozen settings, incidents and membership. Successful deletion
  permanently closes the mapped IDs and their owned delegated descendants.
  Partial cleanup reports `history_pending` and retries from durable native
  ownership on restart, including after mappings or parent links are gone.
  Removing the last bot uses this same decision; pending cleanup is reported
  as `room.history_pending`. Neither operation changes bot memory or notes.
- `hexbot.rooms.mark_read {id, seq}` → `{room}`

Room turns use hidden sessions on each bot profile. The daemon waits
for the corresponding assistant row through `session.history` after
`prompt.submit`; it does not depend on the WebSocket that initiated the room.
The live session's events (`message.delta`, `tool.*`, `approval.*`,
`clarify.*` and the rest) reach the owner, who answers approvals and
questions; `session.events.since` replays a room session. Opening a room with
`hexbot.rooms.get` re-sends pending cards for each running turn. In
`hexbot.rooms.get` and `hexbot.rooms.list`, each running turn with a live
session carries `pending_requests`, the cards it still waits on; a client
that missed events drops the other cards it showed before that read. Tool labels in
rooms and sections stay in the present tense until the tool completes.

### Bot activity

- `hexbot.activity.pairs {}` → `{pairs: [{from_bot, to_bot, count, last_at}]}`
- `hexbot.activity.list {from?, to?, limit?}` → `{messages: [BotMessage]}`

The `message_bot {to, text, wait}` tool delivers into the target bot's
thread with the sender: a section with `peer_bot` set to the sender. With
`wait: true` the result is `{reply, section_id}`; with `wait: false` it is
`{status: "sent", message_id, section_id}`, and a background watcher submits
the eventual reply to the sender section as hidden input prefixed
`[reply from <bot>]`. `to` naming the sender itself, or a bot waiting on the sender's reply
further up the chain, answers 4202; a bot the
section owner does not own answers 4205 with the names of their other bots.
Queued input and background replies keep the active turn's requester chain and
shared hop count. Delegated work, including nested children, inherits both.
An idle section starts a fresh chain for a new originating turn. A background
result that finds the section idle keeps its originating hop count but no
requesters, since nobody waits on that turn, so the bot can pass the answer on.

The `hexbot_soul {action: read | write, text?}` tool lets a bot read or
replace its own `SOUL.md` (capped at 4000 characters). It sits in its own
plugin toolset, `hexbot-soul`, which is never written to
`known_plugin_toolsets`, so the core keeps it on for every bot. A write calls
`profiles.configure {soul}` and broadcasts `hexbot.bots.changed`; it reaches
new sections immediately. Sections started with prompt refresh support also
pick it up after compaction if the next provider request starts a new run; a
continuation within the active run defers refresh until another compaction.
The refreshed prompt is saved only once the extension adopts it, so idle
retirement and daemon restart never reopen a section on a discarded refresh.
Older sections and those whose fixed guidance or tool layout no longer matches
after an update keep their prompt, except a chat, which is rebuilt with its
bot's current tools at its next message. The chat shows no mark for soul,
memory, or note writes; the side panel's Computer tab lists the calls.

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
  enable_for_bot?, bot_only?}` → `{connector, test: {ok, message}}`.
  Writes the values into the root `.env`, every profile `.env` and the
  process environment (`bot_only` writes only that bot's profile), records the
  backend choice where the core reads it, runs the check or probe, and, when
  it passes, turns the connector on for `bot` unless `enable_for_bot` is
  false. A failed probe leaves the connector off for the bot.
- `hexbot.connectors.test {id, bot?}` → `{ok, message, tool_count?}`. A successful
  connected-server probe counts all tool pages and saves `tool_count`. The connector
  list reports the last probe count, or null when untested.
- `hexbot.connectors.clear {id, bot?, bot_only?}` → `{connector}`.
- `hexbot.connectors.set_for_bot {id, bot, enabled}` → `{connector}`.
- `hexbot.connectors.add_mcp {name, command?, args?, env?, url?, transport?}` →
  `{connector}`; `hexbot.connectors.remove_mcp {name}` → `{removed: true}`.
  MCP servers live in the root `config.yaml` and appear as
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

Library reads and writes, sharing and global changes require a signed-in
user, checked through one library-write permission helper. Private reads,
writes and per-bot grants require the bot's owner. Sharing also requires
ownership of the source bot. `bots_disabled` requires ownership of every
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
keep their stored prompts and tool definitions. The former shared-session
About you repair is removed because every section now belongs to the owner.

New sections freeze connected server names and reach tools through Pi's codemode.
Saved sections keep their frozen Rust bridge tools, including SSE. A chat is
the exception: when its bot's tools, connected servers or Hexbot's tool layout
differ from what it froze, its next input rebuilds its tools and prompt and
restarts its process on the same conversation, keeping its model, thinking
level and directory. That request misses the prompt cache once. New sections
skip existing SSE entries and emit an owner-scoped `warning` with `{section_id,
room_id, message}`, once per bot/server for each daemon run. Room notices name
the bot. Pi warning/error notifications use the same event. Clients
show a dismissible notice under the conversation header.

Manual asks for every connected-tool call, including tools marked read-only.
Auto runs tools with `readOnlyHint: true` freely and reviews other calls one at
a time, asking about risky or unreviewable calls with `once | deny` only.
Resource tools are read-only. In Manual, Allow for now covers one server
for the running Pi session. Bypass never asks. Each nested
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

Provider configuration lives on the daemon in `config.yaml`. Set
`model_overrides.<provider>.<model>.context_window` to supply a missing context
window. When no window is known, Hexbot assumes 32,768 tokens. For the
custom/Ollama endpoint, `model.context_length` takes precedence for every model,
including fallbacks, and is also sent as `num_ctx`. Bot configuration overrides
deployment values.
Before Pi starts, Hexbot writes compaction settings to the bot's Pi directory
using the final model registry. The 16,384-token reserve and 20,000-token recent
context budgets are each capped at a quarter of the model's window. Running
sections keep the settings loaded at start; workspace `.pi/settings.json`
cannot override them. See the [daemon reference](../backend/hexbot-core/README.md#storage-and-compatibility)
and [provider setup guide](https://hexbot.app/docs/providers/).

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
  `Model = {provider, id, label, context?, input_cost?, output_cost?, reasoning_levels?}`,
  built from `model.options`. Ids come from the profile list and the pinned
  Pi catalog. Naming a configured provider also asks it for its current list
  when that list holds only models an agent can run: OpenAI Codex (its
  `/models` endpoint with the ChatGPT sign-in, which also reports reasoning
  levels), a provider with a `models_url` such as OpenRouter, or one with no
  catalog of its own. Other providers are asked only with `refresh: true`. `reasoning_levels` are the thinking levels both Pi and the provider
  accept, in Pi's order, or whichever of them knows the model; it is absent
  when neither does. Levels a provider reports for a model newer than the
  pinned Pi are kept in `live_model_levels.json` and given to Pi. A
  recommended model the provider no longer lists is left out of `curated`. `provider` accepts the friendly aliases
  `openai` (→ `openai-api`), `chatgpt` (→ `openai-codex`), `claude`,
  `grok`, `glm`. `include_unconfigured` defaults to true when the named
  provider has no credentials; `model.options` returns empty skeleton rows
  for those, so `all` then falls back to the core's offline curated catalog
  and `all_source` reports `model.options | catalog | mixed | none`.
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
  device). `link` is `hexbot://pair?host=...&port=...#code=...`.
- `hexbot.devices.list {}` → `{devices: [{id, name, platform, created_at,
  last_seen_at, current: bool}]}`
- `hexbot.devices.revoke {id}` → `{revoked: true}`
- `hexbot.devices.set_push {token, platform}` → `{ok: true}` stores the
  calling device's Expo push token (`ExponentPushToken[...]`) and platform
  (`ios` or `android`) for check-in pushes; `{token: null}` stops them. Only
  the calling connection's own paired device changes.

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

- `hexbot.update.request {version}` → `{accepted: true, method,
  version}`. `method` is the daemon's `update_capability`. With `desktop` the
  app running the daemon downloads and installs its own update and relaunches;
  with `service` the daemon fetches
  `daemon/native/<version>/<target>/manifest.json`, verifies the target archive
  and its SHA-256, activates the runtime, and restarts itself. Errors: 4210
  no capability, 4211 an update is already running, 4212 chronology or
  selection refused.
  A service update needs a positive manifest `builtAt` strictly greater than
  every one the daemon knows: its running, selected and recorded runtimes,
  across Stable and Nightly. The check repeats under the activation lock before
  publication. A higher version never authorizes an equal, older or unknown
  `builtAt`.
  With `desktop`, an app that is already current can restart a daemon it started
  on a verified runtime instead of updating itself, including on Linux outside
  the AppImage. It prepares that runtime before stopping the daemon. It reports
  success only once the replacement's home, PID and executable match. It never
  stops a daemon run by a service or another app. If preparation fails, including
  when the retained runtime cannot satisfy the client, the daemon keeps running.
  Failure after stopping or while waiting for readiness is reported; recovery
  may also fail.
  Unlike automatic service updates, explicit packaged POSIX selection may accept
  an equal positive `builtAt`, but only for a later canonical release Nightly
  (`X.Y.Z-nightly.YYYYMMDD.N`) with the same `X.Y.Z` and target. Equal `builtAt`
  does not mean the builds share a source commit. The selected manifest, complete
  file hashes and recorded identity must agree. Executable access is checked for
  the current user. Matching trusted bytes with permission damage can be repaired
  into owned staging without changing the damaged selection's permissions.
  The record's `builtAt` is a historical floor, separate from bundle identity.
  It may exceed the selected manifest's chronology after explicit setup chooses
  an older bundle. The selected bundle itself must be at the floor for a packaged
  tie or exact-version repair; automatic updates must still exceed the floor.
  Legacy Python handoff records omit `files` and `builtAt`. Packaged selection
  verifies their identity against the complete selected manifest, actual bytes
  and executable access, and derives chronology from that manifest while keeping
  every other known floor. A present invalid or conflicting `files` map still
  fails. Missing records or selected manifests, corrupt records and conflicting
  identities are refused, not treated as a first install. Since the Full app
  prepares before ordinary local attachment too, this can block starting or
  connecting to its local daemon.
  Automatic updates keep their strict chronology checks. Existing explicit
  `hexbot setup --activate` from a verified bundle can rewrite damaged metadata
  and keeps the highest valid `builtAt` it can still read independently. The
  installer's Headless Update or repair uses this path; Full has no installer
  runtime-repair route. Explicit installer choices may select an older bundle
  without lowering a readable historical floor.
  A service-download manifest must carry a release signature at `manifest.json.sig`
  (docs/release.md, "Update signing"); without a valid one the update fails
  before anything downloads, and the SHA-256 in the signed manifest then pins
  the archive.
- `hexbot.update.status {}` → `{capability, status, requested, version,
  percent, message, at}`. `status` is `idle`, `requested`, `checking`,
  `downloading`, `installing`, `restarting`, `up-to-date`, or `failed`.
  A successful update ends with the connection dropping and the daemon
  coming back on a verified runtime that satisfies the requesting client.

### Users and usage

A daemon belongs to one person. Earlier builds let an admin invite others;
upgrading folds their bots, sections and rooms into the owner, revokes their
devices, and removes the invite and update methods.

- `hexbot.users.me {}` → `{id, display_name, role, can_rename: true}`.
  The name Get Started asks for; rooms show it on your messages. `role` is
  always `admin`.
- `hexbot.users.list {}` → `{users: [{id, display_name, role}]}`, only you.
  Kept with `role` so apps older than 0.1.6 still offer Bypass and the other
  owner controls.
- Renaming broadcasts owner-scoped `hexbot.users.changed`; clients refresh
  `hexbot.users.me`. Older daemons omit `can_rename`, so clients hide the editor
  and Get Started falls back to saving About you on an unknown-method error.
- `hexbot.users.me.set {display_name}` → `{id, display_name, can_rename: true}`.
  The name is trimmed, nonempty (4200) and at most 64 characters (4202).
- `hexbot.usage.summary {since?}` → `{input_tokens, output_tokens,
  estimated_cost_usd, by_bot}`.

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
broadcast to every connection. When a message lands in a chat outside its
turns (earlier versions did this for dream reports; dreams now post nothing),
`hexbot.sections.changed` also carries `reload`: true when a client showing
the chat should open it again to read the report. The report never stops the
chat's process. While a turn runs, `reload` is false and a second
`hexbot.sections.changed {id, bot, reload: true}` follows when that turn
ends, always after the report is stored: when it settles, when a manual
compaction finishes or fails, when Pi refuses the message, or when its
process exits.
Connect registration and disconnection emit `hexbot.connect.changed {}`.
Room mutations emit `hexbot.rooms.changed {id, deleted?}`; `add_member` and
`remove_member` also name the bot in `bot` and `name`. Room deletion,
including last-member removal, sets `deleted: true`. Deletion, `add_member` and
`remove_member` then emit an owner-scoped, session-less `hexbot.bots.changed
{}`. Every persisted room event
emits `hexbot.rooms.event {room_id, event}`. Turn state changes emit
`hexbot.rooms.turn {room_id, bot, live_session_id, status}`. Room events go
to the owner.
Dream triggers emit `hexbot.dreaming.changed {bot}`.
Connector mutations emit `hexbot.connectors.changed {connector, bot?}` and
`hexbot.bots.changed`. Recording a runtime failure emits
`hexbot.bots.incident {bot, section_id, room_id, session_id, incident: {id,
bot, section_id, room_id, session_id, kind, connector, text, created_at,
resolved_at}}`. Room failures include their room ID in both the payload and
incident. Bot reads return that ID in `status_detail.room_id` for attributable
legacy room failures too. Resolving an incident does not emit an incident event.

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
- `hexbot checkins [now | on | off | every MINUTES | hours HH:MM-HH:MM |
  cancel ID]`: shows check-ins and wake-ups, runs one, or changes their
  settings. Status, now, and cancel need the daemon running.
- `hexbot computer [on | off | restart | reset | give-back | size
  small|medium|large]`: shows the bots' computer or changes it, through the
  running daemon.
- `hexbot devices list|revoke`, `hexbot bots list|create|delete`,
  `hexbot rooms list`, and `hexbot send <bot> <text>`.
- Native commands use the running daemon when available, preserving event
  delivery and the single runtime owner. Offline mutations require its home lock.
