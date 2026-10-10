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
- Scheduled jobs do not write memory. In a job's session, and in any delegate
  under it, the memory tool reads as usual, but `add`, `append`, `replace`,
  `set`, and `remove` are saved as rows in `memory_proposals` (bot, owner,
  job id, action, arguments, created_at) after the same injection scan and
  memory cap as an edit, so a proposal the dream could never apply is
  refused at once. The tool result tells the bot the change waits for its
  next dream. A bot keeps at most 100 pending proposals; older ones are
  dropped unread. Reviewed proposals are kept 30 days. The soul tool reads
  in a job's session but refuses to write: soul changes need the user, in a
  section, and the dream never writes the soul either.
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
  `append` runs, to every non-empty line outside fenced code blocks, except
  headings and rules; a line that already ends with a stamp keeps it.
  `replace` restamps the lines it touches with the current month, since a
  replacement confirms the entry. An empty replacement and `remove` stamp
  nothing, and drop a line left holding only a bullet and a stamp. Rules
  and adjacent blank separators remain. `set`, the Memory tab, and
  `hexbot.memory.bot.set` write text as given, so the dream and the user
  keep control. The threat scan checks both the literal
  text and copies with all trailing stamps stripped from the old and new
  memory, before stamping and again on the final text. Existing unchanged
  threats may remain, but dates cannot hide a new match across lines. A
  proposal is stored as the job wrote it and stamped when the dream applies
  it through its own memory tool, so the cap check on an addition counts its
  stamps. For a replacement it reserves one stamp per new line plus one for
  the surrounding line; the dream checks
  the final memory again when applying it. The dream prompt names the
  current month and asks the dream to keep stamps, refresh one when a fact
  is confirmed again, and stamp new or merged entries when rewriting with
  `set`. It judges every entry on its content: an entry without a stamp
  predates stamps or was written by the user, and a missing date is
  no reason to remove it. Stamps count against the memory cap.
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
