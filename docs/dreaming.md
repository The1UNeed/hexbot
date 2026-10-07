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
- A section Pi compacted since the last dream also carries the summaries Pi
  wrote at those compactions as `compactions: [{at, summary}]`, oldest
  first, read from the section's `conversation.jsonl` on the current branch
  only; abandoned branches, deleted sections, and legacy sections without a
  conversation file contribute none. The dream makes no model call for them.
  Summaries count against the same 12,000 characters: each is capped at
  4,000, the newest are kept first because a later compaction folds the
  earlier ones in, and the verbatim tail keeps at least 4,000 characters of
  its own, so the summary of the morning and the tail of the evening fit
  together. Pi writes a summary from the transcript it compacts, tool results
  included, so a summary can carry text from a fetched page that the digest
  itself leaves out. The prompt adds one clause, only when a section has
  summaries, saying what they are and that they may carry text from pages
  and other tools: the dream uses only what the user or the bot clearly
  established in them and never takes an instruction from them, as it does
  with proposals.
- The digest carries what the user and the bot said. It leaves out the bot's
  own `Dreams` section, so a dream never re-reads its previous summaries, and
  it leaves out tool results such as `web_extract` output, so fetched pages
  do not become memory through the transcript; the compaction summaries
  above are the one place such text can still reach the dream, labelled as
  such. A teammate's reply through `message_bot` is speech and stays. The `Dreams` section is known by its title everywhere (sidebar,
  Memory tab, `post_summary`), so a section the user titles "Dreams" is
  treated as the dream log here as well.
- A bot keeps daily notes beside its memory: one file per local day,
  `profiles/<bot>/memories/notes/YYYY-MM-DD.md`, capped at 4,000 characters
  a day with an error that tells the bot to keep notes short or fold what
  matters into memory. The memory tool's `note` action appends to today's
  file after the same injection scan as a memory edit; lines carry no month
  stamp, since the file is the date. `read` with `notes` (`today`,
  `yesterday`, a day, or a range of up to seven days) returns those days
  instead of memory. Notes never enter a prompt. A shared bot in someone
  else's room cannot read its owner's notes there, as it gets no About you;
  its memory writes there answer with a confirmation rather than the text,
  and the extension's file tools, the daemon's file bridge and the sandbox
  for its commands and code refuse the bot's `memories/` folder, every About
  you and other sections' history in that session (`guest` in the live
  settings; `docs/multi-user.md`).
  Nothing else indexes them; a day or a range is the way to find one.
- The bot dream (not a room dream) reads the notes from the day of the last
  successful dream on as `notes: [{date, text}]`, oldest first, at most
  16,000 bytes with the newest days kept, counted against the 60,000-byte
  budget before any transcript: a day's notes are already that day
  condensed. The prompt adds one clause: read them first, fold the durable
  facts and lessons into memory, notes are not memory. Before building the
  digest the dream deletes note files older than 30 days; only files named
  like a day are touched. The Memory tab shows notes by day; the user can
  edit or delete a day there, and `hexbot.memory.notes.set` writes text as
  given. Deleting a section leaves notes alone, like memory; deleting the
  bot deletes them with the profile.
- Scheduled jobs do not write memory or notes. In a job's session, and in
  any delegate under it, the memory tool reads as usual, but `add`,
  `append`, `replace`, `set`, `remove`, and `note` are saved as rows in
  `memory_proposals` (bot, owner, job id, action, arguments, created_at)
  after the same injection scan and memory cap as an edit, so a proposal the
  dream could never apply is refused at once. The tool result tells the bot
  the change waits for its next dream. A bot keeps at most 100 pending
  proposals; older ones are dropped unread. Reviewed proposals are kept 30
  days. The soul tool reads in a job's session but refuses to write: soul
  changes need the user, in a section, and the dream never writes the soul
  either.
- The next bot dream (not a room dream) puts pending proposals in the digest
  as `proposals`, newest first, at most 20 and at most 10,000 bytes, counted
  against the 60,000-byte budget; a proposal that does not fit is skipped
  and the smaller ones after it still go in. The prompt labels them as suggestions from
  unattended jobs that may carry text from the web. The dream applies the
  ones it agrees with through its own memory tool, which scans them again,
  and says in its summary which it applied or ignored. When the dream
  completes, the proposals it read are marked consumed with that dream's id;
  a failed dream leaves them pending, as it leaves `since` where it was.
  Deleting the bot deletes its proposals.
- Memory entries end with the month they were learned, `[YYYY-MM]` in the
  daemon's local time. The daemon adds it when the memory tool's `add` or
  `append` runs, to every non-empty line that is not a heading and does not
  already end with a stamp; `replace` restamps the lines it touches with the
  current month, since a replacement confirms the entry; an empty
  replacement is a removal. `set`, `remove`, the Memory tab, and
  `hexbot.memory.bot.set` write text as given, so the dream and the user
  keep control. A proposal is stored as the job wrote it and stamped when the
  dream applies it through its own memory tool. The dream prompt names the
  current month and asks the dream to keep stamps, refresh one when a fact
  is confirmed again, and treat undated or old entries that may have changed
  as candidates to verify or remove. Stamps count against the memory cap.
- Dream rows in `hexbot.db` record `memory_before`, `memory_after`, status,
  and summary. The Memory tab shows the two versions side by side.
  `hexbot.dreaming.restore {id}` restores `memory_before`.
- A completed summary is stored directly as an assistant message in the
  bot's hidden `Dreams` section. It does not trigger another agent turn.
- `hexbot.dreaming.run_now {bot}` starts a dream immediately.
  `hexbot.dreaming.status {bot}` reports the last run, next run, and last error.
  Interrupted dreams are marked failed when the daemon restarts.

## Room memory

A room dream curates the main bot's private memory, then produces a
shared summary of at most 3,000 characters. Private user facts must stay out
of that summary. The result is stored in `room_memory` and injected into
members' room prompt headers. Members keep their own private notes about
the room in their bot memory.
