# Rooms and bot-to-bot messaging

Milestone 3 design. Words per `CLAUDE.md`; product rules per `DESIGN.md`
section 2. The native room engine lives in `backend/hexbot-core/src/rooms.rs`
and uses a persistent Pi session for each room bot.

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
  one hidden Pi session per (room, bot) on that bot's profile, created
  with `room_plumbing: true, follow_profile_config: true,
  close_on_disconnect: false`, titled `Room: <name>`
- `room_turns(id, room_id, bot, trigger_seq, started_at, finished_at,
  status, input_tokens, output_tokens, cost_usd)`
- `bot_messages(id, from_bot, to_bot, room_id null, section_id, created_at,
  text)` for the activity view

## Turn engine

`backend/hexbot-core/src/rooms.rs` runs inside the daemon and reacts to
appended events.

1. **Responder selection** on `message.user`: the set of bot members whose
   handle is @-mentioned; if the message mentions no bot member and the room
   has a main bot, the main bot; otherwise nobody. The main bot never adds a
   reply to a message addressed to another bot. On `message.bot`: bots that message @-mentions and that
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
   The engine broadcasts `hexbot.rooms.event {room_id, event}` for every
   appended event and `hexbot.rooms.turn {room_id, bot, live_session_id,
   status}` so every client opens the live session's transcript. The owner
   gets every event of the live session. Other human members get an
   allowlisted copy (`viewer_payload` in `events.rs`): `message.start`,
   `message.delta`, `message.interim`, `message.complete` (text and status),
   `status.update`, and `tool.start` / `tool.complete` with only the tool
   name, the duration and whether it failed. Members see which tool a bot
   uses, not its arguments or results; reasoning, usage and error details
   stay with the owner too.
   Approvals and questions raised by a room turn surface as
   `approval.request` and `clarify.request` on that session for the owner
   alone, who answers them in the room; other members get
   `status.update {kind: "waiting", text: "Waiting for <owner name>"}`
   instead, and `status.update {kind: "working", text: "Working"}` once the owner answers.
5. **Limits**, checked before each turn: bot turns since the last human
   message (default 8), per-room budget per human turn, per-bot daily token
   budget (from `session_model_usage` across the bot's profile), all from
   system settings. A room's `limits` may override the first two
   (`bot_turns_per_human_turn`, `budget_tokens_per_human_turn`); the daily
   budgets always come from the admin. A tripped limit appends
   `limit.tripped` and the engine idles until the next human message.
6. **Persistence**: the engine is restart-safe; on start it reconciles
   `room_turns` with status `running` to `failed` and re-evaluates rooms
   with an unanswered `message.user`.

## RPC

- `hexbot.rooms.list`, `hexbot.rooms.get {id}`, `hexbot.rooms.create {name,
  members: [bot], humans?: [user], main_bot?, limits?}`, `hexbot.rooms.update`,
  `hexbot.rooms.add_member {id, bot | user}`, `hexbot.rooms.remove_member {id,
  bot | user}`,
  `hexbot.rooms.send {id, text, attachments?}`, `hexbot.rooms.log {id,
  after_seq, limit}`, `hexbot.rooms.stop {id}`, `hexbot.rooms.archive`,
  `hexbot.rooms.delete`, `hexbot.rooms.mark_read {id, seq}`.
- Events: `hexbot.rooms.changed`, `hexbot.rooms.event`, `hexbot.rooms.turn`,
  delivered to the owner and every human member. The person a removal or
  leave takes out of the room gets `hexbot.rooms.changed {id, removed: true}`
  and drops the room; a client that missed it gets 4302 on its next load
  and drops the room then.
- Room rows (`list`, `get`) carry each bot and person's `display_name` on their
  member row, so every member can name the others, and `turns`, the bots
  with a turn running now (`{bot, live_session_id}`). Turn events are not
  replayed, so a reconnecting client rebuilds who is working from `turns`.
- `hexbot.rooms.get` from the owner sends the `approval.request` or
  `clarify.request` each running turn waits on again, as
  `hexbot.sections.open` does for a section, so a reloaded app shows the
  card. For other members, it sends the current `status.update` for each
  running turn, including "Waiting for <owner name>" while a card is open.
  Clients dedupe on `request_id`. The room view shows open cards under
  the bot's live turn and drops them once answered or when the turn ends.
- `create` and `add_member` take only people on this daemon with an enabled
  account: 4232 "That person is not on this daemon.", 4202 "That person's
  account is disabled."
- Human members read, post, mark read, stop and leave. Only the owner
  updates the room, changes members, archives or deletes it; the app
  compares `owner_id` with the current user and shows other members the
  settings read-only, with a Leave action. While the current user is
  unknown it shows neither. The owner can remove a person but not
  themselves. Add person in the People group lists active daemon users outside
  the room. Adding a person back clears `left_at` and restores room and live
  session events. Adding a disabled account answers 4202. `hexbot.rooms.people {id}` lists user ids and names for the
  owner, including owners who are not admins. A person who leaves or is removed keeps their row with
  `left_at`, stops receiving the room's events, and gets 4302 from it. Bots
  run as the owner, so their sessions and usage belong to the owner whoever
  sent the message.
- Removing a bot stops only that bot's turn; the others keep going.

Rooms appear in the roster list next to bots, ordered by
`last_activity_at`, and use the same section semantics: a room is one
section today; room sections come with threads later.

## Bot-to-bot messages

The native daemon provides `message_bot {to, text, wait: bool}` for bots:

- Every bot has a description. The user writes `bots.description`; when it
  is blank the daemon writes `bots.auto_description` with a one-shot model
  call (the Auto mode model when set, else the bot's own) from the display
  name, title, and soul, and never returns it to clients. It is rewritten in
  the background when those inputs change (`auto_description_key` is their
  hash), after create, update, `profiles.configure`, a `hexbot_soul` write,
  and once at daemon start.
- When a section's prompt is built, a bot the section owner owns gets a
  `# Team` block before its skills: how other bots see it and, when its
  `hexbot` toolset is on, the owner's other bots (up to 24) with their
  descriptions. Like the rest of the prompt it is frozen with the section;
  new teammates and changed descriptions reach new sections only.
- Delivery is in-process: resume or create the target bot's thread with the
  sender, a section with `peer_bot` set to the sender (one per pair, titled
  `From <sender>`), submit the text there as a hidden user-role message
  `@<sender>: <text>`, and record a `bot_messages` row. The thread exists
  before the tool returns, and the result carries its `section_id`.
- `wait: true` blocks the sender's tool call until the target's turn
  completes and returns `{reply, section_id}`; `wait: false` returns
  `{status: "sent", message_id, section_id}` and the reply, when it
  arrives, is injected into the sender's originating section as a hidden
  `[reply from <bot>]` message.
- Threads are private one-to-one conversations. Section lists leave them
  out unless asked (`include_threads`); the app opens one on demand from the
  row under the sender's reply (the two bots' faces turned toward each other,
  "<sender> is asking <bot>" with the reply streaming in, then "<bot> helped"),
  in a side panel. Dreaming reads them like
  any other section, so both bots learn from the exchange. In a room, a
  bot's `message.bot` event carries `asks: [{to, section_id}]` for the
  teammates it asked during that turn (from `bot_messages.source_section`),
  so the room keeps the "<bot> helped" row after the turn ends. Only the
  room owner receives `asks`; other members get the reply without it.
- Only a bot owned by the section owner can ask: a shared bot running in
  someone else's room gets 4302 and never sees their bots. Approval and
  question events carry `bot`, so a client honours that bot's Notify me
  for a thread it does not list.
- Loops are bounded by the same per-bot daily budget and a hop limit of 8
  messages per originating turn (a user message, a room turn, or a scheduled
  job); every section in the chain shares that count, and each new turn
  starts a fresh one.
- `hexbot.activity.pairs` and `hexbot.activity.list {from, to}` read
  `bot_messages` per pair, each row linking to its thread section.

## Client

- Room creation dialog: name, members, optional main bot, approval mode,
  limits prefilled from settings.
- Room view reuses the conversation column with sender avatars per bot, a
  "waiting on you" banner on `waiting.human`, a red banner on
  `turn.failed`, a limit notice on `limit.tripped`, and a header with the
  room cluster, name, member count, status dot and a Room settings button.
- Room settings (`/r/$room/settings`): name, Bots (Make main, Remove
  with an inline confirm, Add bot), People (Remove with an inline confirm,
  owner only; shown when someone besides the owner is in the room, or when
  the owner has someone to add), approval mode, limits, Delete room for the
  owner, Leave room for anyone else. A room you can no longer see, in the
  room view or its settings, returns you to `/`.
- Your own messages are the right-hand bubble. Messages from other people
  show their name and sit on the left like the bots'.
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
