# Dreaming

Milestone 4. A bot's daily pass over that day's conversations that
summarises them into its section memory. Facts about Hermes cron in
`docs/upstream/plugin-apis.md` section 4.

## Mechanics

- One Hermes cron job per bot, stored in that bot's profile
  (`<profile>/cron/jobs.json` via `cron.jobs.use_cron_store(home)`),
  named `hexbot-dream`, schedule `cron` kind from the deployment setting
  `dream_time` (default `03:00` local), created when the bot is created and
  updated when the setting changes. Rooms get one job on their main bot
  named `hexbot-dream-room-<id>`.
- The job runs a normal agent turn on the bot's profile (SOUL.md, memory
  and skills loaded, `platform="cron"`), so it uses the bot's own model.
- The prompt is built by `hexbot/dreaming.py`: it lists the bot's sections
  and rooms with activity since the last dream, includes for each a
  transcript digest (Hermes session search over the profile's `state.db`
  by time range; capped at 12k characters per section, older parts
  summarised first), and instructs the bot to write durable facts,
  preferences and unfinished work into its notes with the memory tool. Core
  memory is mentioned only when the bot's `may_write_core` flag is on, and
  then only through the explicit core action.
- Output delivery: `deliver: bot-chat:<profile>` is not used; instead the
  job's markdown output is posted by `hexbot/dreaming.py` into the bot's
  section titled `Dreams` (created on first use) as a message from the bot,
  so the human can read and edit what was recorded. Memory entries created
  during the dream are tagged with the dream id in a `memory_entries`
  table (`bot, section_id null, room_id null, dream_id, target, text`) so
  deleting a section or room can purge derived entries.
- `hexbot.dreaming.run_now {bot}` triggers the job immediately through
  `cron.trigger_job`. `hexbot.dreaming.status {bot}` reports last run,
  next run and last error.
- The daemon must be running at the scheduled time; the user service from
  milestone 1 provides that. If it was not, Hermes cron catches up on the
  next tick and the dream covers everything since the last run.

## Room memory

The room section's shared memory is the room dream output stored in
`room_memory(room_id, text, updated_at)` and injected into every member's
room prompt header (capped at 3k characters). Members keep their own notes
about the room in their section memory.

## Vector memory (bundled plugin)

Default-off bundled Hermes memory plugin (`plugins/memory/<choice>`), chosen
per deployment in settings; the embedding model is a provider model from the
configured providers or a local one. Enabled per bot. Not needed for the
two-tier model to work; it improves recall over long histories.

## Milestone 4 implementation decisions

- Dream schedules are stored as local five-field cron expressions. `03:00`
  becomes `0 3 * * *`. Deployment-level and bot-level enablement must both be
  true for the job to stay enabled.
- `post_tool_call` records builtin memory writes. The optional memory-provider
  callback does not fire for every builtin write, so it cannot provide complete
  provenance.
- The digest tool starts the dream row and associates its id with the cron
  turn. The stream-end hook records the final summary, updates room memory for
  room dreams, and clears the association.
- Hermes currently accepts `display_kind: "hidden"` on `prompt.submit`. If an
  older daemon rejects it, Hexbot appends an assistant row to the Dreams
  section's profile `state.db`; it never resubmits the summary as user input.
- Transcript caps keep the newest 12,000 characters and prepend
  `[earlier messages omitted]`. Room prompt memory keeps its first 3,000
  characters.
