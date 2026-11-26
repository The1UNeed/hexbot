# Rooms and bot-to-bot messaging

Milestone 3 design. Words per `CLAUDE.md`; product rules per `DESIGN.md`
section 2. A daemon belongs to one person, so a room has one human, its
owner; rooms with people on other daemons will go through Hex Connect. The native room engine lives in `backend/hexbot-core/src/rooms.rs`
and uses a persistent Pi session for each room bot.

## Upgrading from multi-user builds

Former accounts' bots, sections and rooms become the owner's. Their devices
are signed out. Bots that were capped to Auto because their owner was a member
stay on Auto, including bots inheriting daemon Bypass. Inherited Manual stays
inherited. If folding ownership would relax a room bot's approval mode, the
migration pins that room to the strictest mode it previously required. This
can also tighten the other bots in that room. The owner can change it later.

Former members' private sections on the owner's shared bots now follow those
bots' modes, including Bypass. Their old per-person Bypass cap is not preserved.
Saved prompts and transcripts are kept. Old room messages keep former members'
names; the owner's messages use their current display name.

When a new app connects to an older daemon, rooms owned by someone else show
Leave instead of owner controls. Get Started still saves the name in About you;
the separate name editor requires a daemon that advertises `can_rename`.

## Data model (hexbot.db)

- `rooms(id, name, owner_id, main_bot null, approval_mode null,
  limits_json, created_at, updated_at, last_activity_at, archived_at)`
- `room_members(room_id, member_kind human|bot, member_id, added_by,
  added_at, left_at null, last_read_seq)` (the owner's `human` row holds
  their read position; a bot that leaves keeps its row with `left_at`; its
  session and history remain. Rooms from multi-user builds keep the rows of
  people who were in them, marked left, so old transcripts keep their names)
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
   reply once, say `(pass)` to stay silent, add only what others have not
   said and speak only for yourself, mention a member to bring them in,
   mention `@user` to ask the human and wait, and keep private
   conversations private. A newly added bot has
   `last_read_seq = 0` and therefore sees the whole transcript.
4. **Execution**: `prompt.submit` in-process on the bot's room session.
   The engine broadcasts `hexbot.rooms.event {room_id, event}` for every
   appended event and `hexbot.rooms.turn {room_id, bot, live_session_id,
   status}` so every client opens the live session's transcript.
   Approvals and questions raised by a room turn surface as
   `approval.request` and `clarify.request` on that session, and the owner
   answers them in the room.
5. **Limits**, checked before each turn: bot turns since the last human
   message (default 8), per-room budget per human turn, per-bot daily token
   budget (from `session_model_usage` across the bot's profile), all from
   system settings. A room's `limits` may override the first two
   (`bot_turns_per_human_turn`, `budget_tokens_per_human_turn`); the daily
   bot budget always comes from settings. A tripped limit appends
   `limit.tripped` and the engine idles until the next human message.
6. **Persistence**: the engine is restart-safe; on start it reconciles
   `room_turns` with status `running` to `failed` and re-evaluates rooms
   with an unanswered `message.user`.

## RPC

- `hexbot.rooms.list`, `hexbot.rooms.get {id}`, `hexbot.rooms.create {name,
  members: [bot], main_bot?, limits?}`, `hexbot.rooms.update`,
  `hexbot.rooms.add_member {id, bot}`, `hexbot.rooms.remove_member {id, bot}`,
  `hexbot.rooms.send {id, text, attachments?}`, `hexbot.rooms.log {id,
  after_seq, limit}`, `hexbot.rooms.stop {id}`, `hexbot.rooms.archive`,
  `hexbot.rooms.delete`, `hexbot.rooms.mark_read {id, seq}`.
- Events: `hexbot.rooms.changed`, `hexbot.rooms.event`, `hexbot.rooms.turn`,
  delivered to the owner. A deleted room sends `hexbot.rooms.changed {id,
  deleted: true}` and the client drops it; a client that missed it gets
  4230 or 4302 on its next load and drops the room then.
- Room rows (`list`, `get`) carry each member's `display_name` on their
  member row, and `turns`, the bots with a turn running now (`{bot,
  live_session_id}`). Turn events are not replayed, so a reconnecting client
  rebuilds who is working from `turns`.
- `hexbot.rooms.get` sends the `approval.request` or `clarify.request` each
  running turn waits on again, as `hexbot.sections.open` does for a section,
  so a reloaded app shows the card. Clients dedupe on `request_id`. The room
  view shows open cards under the bot's live turn and drops them once
  answered or when the turn ends.
- Only the owner reads or changes a room; any other caller gets 4302. Bots
  run as the owner, so their sessions and usage belong to the owner.
- Removing a bot stops only that bot's turn; the others keep going.

Rooms appear in the roster list next to bots, ordered by
`last_activity_at`, and use the same section semantics: a room is one
section today; room sections come with threads later.

## Discord rooms

A Discord channel can be a room (`discord.rs`, API in `docs/api.md`,
Discord). Each bot connects its own Discord app with a token from the
Discord Developer Portal, so several of the owner's bots can sit in one
server and each keeps what it hears in its own room session and notes.

- `discord_bots(bot, owner_id, application_id, user_id, username, status,
  error, connected_at, updated_at)`: the bot's app. The token is
  `accounts/discord/<bot>.json`.
- `discord_channels(channel_id, guild_id, room_id, guild_name,
  channel_name, posted_seq)`: the channel a room mirrors and the last room
  event the outbox handled.
- `discord_messages(message_id, room_id, seq, bot)`: which Discord message
  is which room event; `bot` is the bot that posted it, NULL for people. A
  message seen by several bots' connections lands once.
- `discord_closed(channel_id, closed_at)`: when a channel's last Discord room
  was deleted.
- `discord_plugin(bot, owner_id, mode, enabled_at)`: the bots Discord is on
  for in Plugins, and how each acts by default. Kept when a bot disconnects;
  a bot connected before this table existed gets a row once.
- `discord_guilds(bot, guild_id, name, mode, present)`: the servers a bot's
  app is in, from its Gateway, and a server's own mode (NULL follows the
  bot's).

A bot's mode in a server (`discord::mode`) is `mentions`, `reads` (the
default), `active` or `everyone`. `reads` and up read the whole channel and
can read the rest of the server with `hexbot_discord`; `active` and
`everyone` listen: they open a room for a channel the first time a person
writes there, join it as of that message, and are picked for the room's
newest person message they haven't read (`rooms::select_responders`, with
`modes` and `latest_seq` from `discord::room_info`). `mentions` sees only
the messages that address it, in its prompt and in the room: what is said to
nobody is not kept when every bot in a room sees only mentions, and a room
opened for such bots starts without history. A whole `@handle` addresses a
bot (`rooms::typed_handles`): `@owl-admin` never addresses `owl`. A bot taken
out of a server leaves its rooms there; a listening bot that left before its
app was last connected or added to the server (`discord_guilds.joined_at`)
joins again when a person writes. A listening bot opens or joins a room only
where it can post (Send Messages, or Send Messages in Threads for a thread),
asked once before it joins; a refusal is remembered for ten minutes and
costs no Discord call meanwhile. A bot whose post Discord refuses (403)
leaves the room until it is mentioned. A listening bot leaves a message that
addresses another bot in the room to that bot, and answers the newest message
said to none of them (`latest_seq`).

The first mention of a bot in a channel, or the first message where a bot
listens, creates the room, Manual, with the 20 messages before it marked
`history`, except that a person's mention of a
connected bot in the minute before, possibly still on its way through another
bot's connection, and what followed it are ingested live (`IN_FLIGHT_MS`),
each with its own retries, unless it was said before the channel's last room
was deleted (`discord_closed`); a late copy of such a message is dropped. It has no main bot. A bot joins the
room when it is mentioned there or replied to, also by another of the
owner's bots, and comes back that way after the owner removed it or it was
disconnected. Every mentioned bot joins in the transaction that saves the
message, with `added_at` now, or the time of the bot reply that brought it
in, and in a Discord room only messages from `added_at` on address it. The
message is saved even while a member removal holds the room; the wake waits
for the removal (`RoomEngine::notify_later`).
Messages from other apps' Discord bots, and messages that arrive while the
room is archived, start no turn; another app's bot also opens no room and
brings no bot in. Only the first copy of a person's message brings bots in,
and a bot reply never brings back a bot removed after it was written. A bot
reply is matched to its room event by the message id recorded when it was
posted, else its nonce, else, when it has no nonce, the author's oldest reply
not yet posted; a post whose nonce names another room brings nobody in. People's messages are `message.user` events with `actor_kind:
discord` and the author's name in the payload; the prompt names them as
Discord shows them, after `speaker()` strips anything that could pose as a
bot or a line. Each bot's reply goes out through its own app. One worker
takes the Gateway's messages in order, trying a failed one twice more; one
outbox worker posts, woken by `message.bot` events and on start, from
`posted_seq`, part by part with a nonce, and tries again every 30 seconds
while Discord is unreachable or answering 5xx or the database is busy. A
bot's own post coming back on its Gateway marks its part sent.

Bots in a Discord room have only notes, the web and reading their server
(`discord::TOOLS`). Their
prompt is the soul and the Discord rules, without memory, About you, files,
teammates or skills, and every line a person wrote is prefixed with their
name. Notes become memory proposals the dream treats as untrusted, and the
dream leaves Discord rooms out. The app shows the room read-only with an
Open in Discord link.

## Bot-to-bot messages

The native daemon provides `message_bot {to, text, wait: bool}` for bots:

- Every bot has a description. The user writes `bots.description`; when it
  is blank the daemon writes `bots.auto_description` with a one-shot call
  to the bot's own model from the display
  name, title, and soul, and never returns it to clients. It is rewritten in
  the background when those inputs change (`auto_description_key` is their
  hash), after create, update, `profiles.configure`, a `hexbot_soul` write,
  and once at daemon start.
- When a section's prompt is built, the bot gets a `# Team` block before its skills: how other bots see it and, when its
  `hexbot` toolset is on, the owner's other bots (up to 24) with their
  descriptions. Like the rest of the prompt it is frozen with the section;
  new teammates and changed descriptions reach new sections. Sections started
  with prompt refresh support also pick them up after compaction if the next
  request starts a new run. A continuation within the active run defers refresh
  until another compaction. Older sections, or sections whose fixed guidance
  or tool layout no longer matches after an update, keep their prompt, except
  a bot's chat with its owner, which is rebuilt with current tools at its next
  message (see `docs/api.md`, connected tools). Threads keep what they started
  with.
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
  centered inline row under the sender's reply ("Messaging <bot>" while
  running, settling in place to "Message from <bot>", "Messaged <bot>" when
  no reply was waited for, or "Asked <bot>" on error), or from that bot's
  name in a message, in the main conversation view (`<Bot A> ⇄ <Bot B>` with
  a floating **Close Chat** button). Dreaming reads them like
  any other section, so both bots learn from the exchange. In a room, a
  bot's `message.bot` event carries `asks: [{to, section_id, waited, failed}]`
  for the teammates it asked during that turn (from `bot_messages.source_section`
  plus pre-delivery rejected calls from the turn's transcript),
  so the room keeps the inline ask row after the turn ends. Approval and
  question events carry `bot`, so a client honours that bot's Notify me
  for a thread it does not list.
- A bot cannot message a bot that is waiting on its reply: the one that
  asked it, or any bot further up the chain. That request answers 4202 and
  tells the bot to do the work and reply instead, so a request is never
  handed back. Each delivered turn carries the chain of bots waiting on it.
  Its delegated work and nested children inherit that chain and the shared
  hop count. Queued user input and background results keep the active chain
  until the turn settles. A background result arriving while idle keeps its
  originating hop count but no requesters, since nobody waits on that turn,
  so the bot can pass the answer on with `message_bot`; one joining a newer
  busy turn keeps that active chain.
- Loops are bounded by the same per-bot daily budget and a hop limit of 8
  messages per originating turn (a user message, a room turn, or a scheduled
  job); every section in the chain shares that count, and each new turn
  starts a fresh one when it begins from idle.
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
  with an inline confirm, Add bot), approval mode, limits, Delete room. A
  room you can no longer see, in the room view or its settings, returns you
  to `/`.
- Your own messages are the right-hand bubble. Messages from people in rooms
  made by multi-user builds show their name and sit on the left like the
  bots'.
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
