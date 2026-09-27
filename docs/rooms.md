# Rooms and bot-to-bot messaging

Milestone 3 design. Words per `CLAUDE.md`; product rules per `DESIGN.md`
section 2. Facts about the core in `docs/core/rooms-internals.md`.

## Why not the core's Hosted Rooms

Hosted Rooms is a discussion engine: two to six members, everyone answers a
message with no recognised @-handle, at most three rounds and ten messages,
membership fixed at creation, no client notifications, one task at a time
per room, and its caps are baked into validators and turn-id regexes.
Hexbot's rules (optional main bot, silence without a mention, members added
mid-conversation, parallel fan-out with a collecting turn, per-room caps and
budgets, a bot tagging a human) contradict most of that. Hosted Rooms stays
untouched for cross-gateway federation later. Hexbot rooms run on their own
engine over ordinary core sessions, so personas, memory, skills, tools and
approvals come from the core unchanged, and no core edit is needed.

## Data model (hexbot.db)

- `rooms(id, name, owner_id, main_bot null, approval_mode null,
  limits_json, created_at, updated_at, last_activity_at, archived_at)`
- `room_members(room_id, member_kind human|bot, member_id, added_by,
  added_at, left_at null, last_read_seq)` (a bot that leaves keeps its row
  with `left_at`; its session and history remain)
- `room_events(room_id, seq, kind, actor_kind, actor_id, payload_json,
  created_at)` with kinds `message.user`, `message.bot`, `member.added`,
  `member.left`, `waiting.human`, `limit.tripped`, `turn.started`,
  `turn.failed`, `note` (system line)
- `room_sessions(room_id, bot, stored_session_id, live_session_id null)`
  one hidden core session per (room, bot) on that bot's profile, created
  with `room_plumbing: true, follow_profile_config: true,
  close_on_disconnect: false`, titled `Room: <name>`
- `room_turns(id, room_id, bot, trigger_seq, started_at, finished_at,
  status, input_tokens, output_tokens, cost_usd)`
- `bot_messages(id, from_bot, to_bot, room_id null, section_id, created_at,
  text)` for the activity view

## Turn engine

`hexbot/rooms/engine.py` runs inside the daemon (a supervisor thread with a
small pool). It reacts to appended events.

1. **Responder selection** on `message.user`: the set of bot members whose
   handle is @-mentioned; if none and the room has a main bot, the main bot;
   otherwise nobody. On `message.bot`: bots that message @-mentions and that
   have not yet replied to it; `@user` or a question addressed to the human
   appends `waiting.human` and stops the chain.
2. **Fan-out**: selected bots run in parallel, one turn each, each with its
   own session lock. When a turn that the main bot triggered finishes for
   every mentioned bot, the main bot gets one collecting turn whose prompt
   contains their replies.
3. **Prompt**: the transcript delta since that bot's `last_read_seq`,
   rendered as `@handle: text` and `User: text` lines (capped at 40 lines
   and 96 KiB, oldest lines summarised into one line when over the cap), a
   header naming the room, the members and their titles, and the rules:
   reply once, say `(pass)` to stay silent, mention a member to bring them
   in, mention `@user` to ask the human and wait. A newly added bot has
   `last_read_seq = 0` and therefore sees the whole transcript.
4. **Execution**: `prompt.submit` in-process on the bot's room session.
   Streaming events of that live session reach any client holding the
   session's transport; additionally the engine broadcasts
   `hexbot.rooms.event {room_id, event}` for every appended event and
   `hexbot.rooms.turn {room_id, bot, live_session_id, status}` so every
   client can subscribe to the live session for deltas. Approvals raised by
   a room turn surface as normal `approval.request` events on that session;
   the client renders them in the room.
5. **Limits**, checked before each turn: bot turns since the last human
   message (default 8), per-room budget per human turn, per-bot daily token
   budget (from `session_model_usage` across the bot's profile), all from
   system settings with per-room overrides. A tripped limit appends
   `limit.tripped` and the engine idles until the next human message.
6. **Persistence**: the engine is restart-safe; on start it reconciles
   `room_turns` with status `running` to `failed` and re-evaluates rooms
   with an unanswered `message.user`.

## RPC

- `hexbot.rooms.list`, `hexbot.rooms.get {id}`, `hexbot.rooms.create {name,
  members: [bot], main_bot?, limits?}`, `hexbot.rooms.update`,
  `hexbot.rooms.add_member {id, bot}`, `hexbot.rooms.remove_member`,
  `hexbot.rooms.send {id, text, attachments?}`, `hexbot.rooms.log {id,
  after_seq, limit}`, `hexbot.rooms.stop {id}`, `hexbot.rooms.archive`,
  `hexbot.rooms.delete`, `hexbot.rooms.mark_read {id, seq}`.
- Events: `hexbot.rooms.changed`, `hexbot.rooms.event`, `hexbot.rooms.turn`.

Rooms appear in the roster list next to bots, ordered by
`last_activity_at`, and use the same section semantics: a room is one
section today; room sections come with threads later.

## Bot-to-bot messages

The core's `message_agent` tool delivers through a subprocess per profile and
is only injected into a special "Bot Chat" session. Hexbot registers its own
tool `message_bot {to, text, wait: bool}` for every bot through
`ctx.register_tool`:

- Delivery is in-process: resume or create the target bot's section titled
  `From <sender>` (one per sender), submit the text as a user-role message
  attributed to the sender bot, and record a `bot_messages` row.
- `wait: true` blocks the sender's tool call until the target's turn
  completes (bounded by 10 minutes) and returns the reply text; `wait:
  false` returns immediately and the reply, when it arrives, is injected
  into the sender's originating section as a message from the target.
- Loops are bounded by the same per-bot daily budget and a hop limit of 8
  messages per originating human turn, carried in the message metadata.
- The activity view reads `bot_messages` aggregated per pair
  (`hexbot.activity.pairs`) and lists conversations per pair
  (`hexbot.activity.list {from, to}`), each linking to the section.

## Client

- Room creation dialog: name, members, optional main bot, approval mode,
  limits prefilled from settings.
- Room view reuses the conversation column with sender avatars per bot, a
  "waiting on you" banner on `waiting.human`, a red banner on
  `turn.failed`, a limit notice on `limit.tripped`, and a header with the
  room cluster, name, member count, status dot and a Room settings button.
- Room settings (`/r/$room/settings`): name, members (Make main, Remove
  with an inline confirm, Add bot), approval mode, limits, Delete room.
  `hexbot.rooms.remove_member` deletes the room when the last bot leaves
  and answers `{room: {..., deleted: true}}`; the client drops it and
  returns to `/`.
- Composer @-mention popover lists members; `@user` is not offered to
  humans.
- Activity view: list of bot pairs with counts, click-through to sections.

## Tests

Engine unit tests with a fake gateway: responder selection cases, fan-out
and collecting turn ordering, waiting state, each limit, late joiner delta,
leaving keeps history, restart reconciliation. RPC frame tests. One live
test with two bots on the Codex provider exchanging one message.
