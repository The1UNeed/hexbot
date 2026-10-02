# Dreaming

Dreaming is a bot's daily pass over recent conversations to curate its memory.
The native scheduler and digest builder live in
`backend/hexbot-core/src/dreaming.rs`.

## Mechanics

- Deployment settings `dream_enabled` and `dream_time`, default `03:00` local,
  control daily scheduling. Bot dreams also require the bot's enablement flag.
  Active rooms with a main bot get room dreams. The scheduler catches today's
  run after the configured time if the daemon was offline then.
- Each dream uses a fresh Pi session with the bot's model and only the memory
  tool. It merges duplicates, replaces vague entries, removes stale facts,
  and records durable preferences and lessons. Unfinished work and daily
  events stay in conversation history. It never writes soul or About you.
- The digest includes sections and rooms with activity since the last
  successful dream. It retains the newest 12,000 characters per conversation,
  caps the complete serialized digest at 60,000 bytes, and reports how many
  conversations it left out as `omitted_conversations`. Titles keep their
  first 256 characters.
- Dream rows in `hexbot.db` record `memory_before`, `memory_after`, status,
  and summary. The Memory tab shows the two versions side by side.
  `hexbot.dreaming.restore {id}` restores `memory_before`.
- A completed summary is stored directly as an assistant message in the
  bot's hidden `Dreams` section. It does not trigger another agent turn.
- `hexbot.dreaming.run_now {bot}` starts a dream immediately.
  `hexbot.dreaming.status {bot}` reports the last run, next run, and last error.
  Interrupted dreams are marked failed when the daemon restarts.

## Room memory

A room dream curates the main bot's private durable notes, then produces a
shared summary of at most 3,000 characters. Private user facts must stay out
of that summary. The result is stored in `room_memory` and injected into
members' room prompt headers. Members keep their own private notes about
the room in their bot memory.
