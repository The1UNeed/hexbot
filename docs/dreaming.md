# Dreaming

Milestone 4. A bot's daily pass over that day's conversations that
summarises them into its section memory. Facts about core cron in
`docs/core/plugin-apis.md` section 4.

## Mechanics

- One core cron job per bot, stored in that bot's profile
  (`<profile>/cron/jobs.json` via `cron.jobs.use_cron_store(home)`),
  named `hexbot-dream`, schedule `cron` kind from the deployment setting
  `dream_time` (default `03:00` local), created when the bot is created and
  updated when the setting changes. Rooms get one job on their main bot
  named `hexbot-dream-room-<id>`.
- The job runs a normal agent turn on the bot's profile (SOUL.md, memory
  and skills loaded, `platform="cron"`), so it uses the bot's own model.
- The prompt is built by `hexbot/dreaming.py`: it lists the bot's sections
  and rooms with activity since the last dream, includes for each a
  transcript digest (core session search over the profile's `state.db`
  by time range; capped at 12k characters per section, older parts
  summarised first), and instructs the bot to curate its memory with the
  memory tool: merge duplicates, sharpen vague entries, drop stale ones, add
  durable facts and lessons about working with the user, and keep it dense.
  Unfinished work and day-by-day events stay in section history. It never
  writes the soul or About you.
- `hexbot_dream_digest` records the bot's `MEMORY.md` on the dream row
  (`memory_before`); the stream-end hook records it again (`memory_after`).
  The Memory tab's dream log shows the two side by side and
  `hexbot.dreaming.restore {id}` writes `memory_before` back.
- Output delivery: `deliver: bot-chat:<profile>` is not used; instead the
  job's markdown output is posted by `hexbot/dreaming.py` into the bot's
  section titled `Dreams` (created on first use, hidden from the roster and
  reached from the bot's Memory settings) as a message from the bot,
  so the human can read and edit what was recorded.
- `hexbot.dreaming.run_now {bot}` triggers the job immediately through
  `cron.trigger_job`. `hexbot.dreaming.status {bot}` reports last run,
  next run and last error.
- The daemon must be running at the scheduled time; the user service from
  milestone 1 provides that. If it was not, core cron catches up on the
  next tick and the dream covers everything since the last run.

## Room memory

The room section's shared memory is the room dream output stored in
`room_memory(room_id, text, updated_at)` and injected into every member's
room prompt header (capped at 3k characters). Members keep their own notes
about the room in their memory.

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
- Hexbot appends the summary as an assistant row to the Dreams section's
  profile `state.db`. It never sends it through `prompt.submit`: a hidden
  prompt is still a user prompt, and the bot would spend a turn answering its
  own dream.
- Transcript caps keep the newest 12,000 characters and prepend
  `[earlier messages omitted]`. Room prompt memory keeps its first 3,000
  characters.
