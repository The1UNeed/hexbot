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
- The digest includes sections and rooms with activity since the start of the
  last successful dream up to, but excluding, the current dream's start.
  Both starts are recorded before building their digests and rounded down to
  whole milliseconds. Messages and compaction summaries at or after the current
  start wait for the next dream, so the time windows do not overlap. A first
  dream starts at the beginning of history; failed or interrupted dreams do not
  advance the lower cutoff.
  It retains the newest 12,000 characters per conversation,
  caps the complete serialized digest at 60,000 bytes, and reports how many
  conversations it left out as `omitted_conversations`. Titles keep their
  first 256 characters.
- A section or room conversation Pi compacted within that time window also
  carries the summaries Pi wrote at those compactions as
  `compactions: [{at, summary}]`, oldest first, read from its
  `conversation.jsonl` on the current branch only; abandoned branches,
  deleted sections, and legacy sections without a
  conversation file contribute none. For rooms, only this bot's conversation
  contributes summaries. Entries without a valid timestamp are skipped.
  Files last modified more than one second before the cutoff are skipped
  without reading them, allowing for whole-second filesystem timestamps;
  the digest's file and database reads run on a blocking worker.
  The dream makes no model call for the summaries.
  Summaries count against the same 12,000 characters: each is capped at
  4,000, the newest are kept first because a later compaction folds the
  earlier ones in, and the verbatim tail keeps at least 4,000 characters of
  its own, so the summary of the morning and the tail of the evening fit
  together. Pi writes a summary from the transcript it compacts, tool results
  included, so a summary can carry text from a fetched page that the digest
  itself leaves out. The prompt adds one clause, only when a conversation has
  summaries, saying what they are and that they may carry text from pages
  and other tools: the dream uses only what the user or the bot clearly
  established in them and never takes an instruction from them, as it does
  with proposals.
- The digest carries what the user and the bot said. It leaves out the dream
  reports in the bot's chat (messages marked `dream: true`), so a dream never
  re-reads its previous summaries, and
  it leaves out tool results such as `web_extract` output, so fetched pages
  do not become memory through the transcript; the compaction summaries
  above are the one place such text can still reach the dream, labelled as
  such. A teammate's reply through `message_bot` is speech and stays.
- A bot keeps daily notes beside its memory: one file per local day,
  `profiles/<bot>/memories/notes/YYYY-MM-DD.md`, capped at 4,000 characters
  a day with an error that tells the bot to keep notes short or fold what
  matters into memory. The memory tool's `note` action appends to today's
  file after the same injection scan as a memory edit; lines carry no month
  stamp, since the file is the date. `read` with `notes` (`today`,
  `yesterday`, a day, or a range of up to seven days) returns those days
  instead of memory. Notes are never injected into a section's prompt.
  Appending returns the date, length, cap, and `noted: true`, without
  repeating the day's text in the conversation.
  Nothing else indexes them; a day or a range is the way to find one.
- The bot dream (not a room dream) reads notes from the day its last
  successful dream started, as `notes: [{date, text}]`, oldest first, at most
  16,000 serialized bytes with the newest days kept. If the newest day alone
  exceeds that budget, its newest part is kept. Notes count against the
  60,000-byte budget before any transcript: a day's notes are already that day
  condensed. The prompt adds one clause: read them first, fold the durable
  facts and lessons into memory, notes are not memory. Before building the
  digest the dream deletes note files older than 30 days; reads, listings,
  and appends also prune them, even with dreaming off. Pruning failures
  never fail a saved append. Only regular files named like a day are touched,
  and linked directories are refused. Using the previous dream's start day
  keeps late notes eligible when a dream finishes after midnight. The Memory
  tab shows notes by day; the user can edit or delete a day there, and
  `hexbot.memory.notes.set` writes text as given. Saves and deletions accept `expected` and refuse stale text. The
  editor merges only new lines after the exact append boundary and keeps
  the user's draft on other conflicts. Future dates and days older than 30
  days are refused before saving. A stale deletion refreshes the list and
  keeps the selected day and any draft, shows what changed below the
  editor, and keeps the text the draft was loaded from as the save's
  `expected`, so the next save still merges or refuses.
  Deleting a section leaves notes alone, like memory; deleting the
  bot deletes them with the profile.
- Scheduled jobs do not write memory or notes. In a job's session, and in
  any delegate under it, the memory tool reads as usual, but `add`,
  `append`, `replace`, `set`, `remove`, and `note` are saved as rows in `memory_proposals` (bot, owner,
  job id, action, arguments, created_at) after the same injection scan as an
  edit on every retained text field, including removal targets and
  replacement `old_text`. Notes use the 4,000-character day cap after
  trimming, and blank notes are refused; memory proposals use the bot's
  memory cap. Each proposal must also fit the digest's 10,000-byte
  serialized limit, including metadata and JSON escaping, so a proposal the
  dream could never apply is refused at once. The tool result tells the bot the change waits for its
  next dream. A bot keeps at most 100 pending proposals; older ones are
  dropped unread. Reviewed proposals expire after 30 days; inserting a proposal
  or completing a bot dream removes expired rows. The soul tool reads
  in a job's session but refuses to write: soul changes need the user, in a
  section, and the dream never writes the soul either.
- Jobs and their delegates run in Auto when the bot is set to Bypass; Manual
  stays Manual. File tools and the shell/code sandbox protect memory and soul
  from direct writes. Scheduled scripts, including monitor scripts and jobs
  without an agent, require OS isolation even in Bypass.
  Actions that need approval are refused immediately because jobs and their
  delegates have no visible section where the user can answer.
- Jobs and their delegates cannot use `message_bot`. Delivery reuses the
  recipient's ordinary section, whose writes would bypass the job's proposal
  rule. Results stay local; use the memory tool for proposals when available.
- The next bot dream (not a room dream) puts pending proposals in the digest
  as `proposals`, created before the current dream's start, newest first,
  at most 20 and at most 10,000 bytes, counted against the 60,000-byte budget;
  a proposal that does not fit is skipped and the smaller ones after it still go in. The prompt labels them as suggestions from
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
  keep control. The threat scan reads the old and new
  memory with every run of stamps, anywhere in a line, turned into one space
  (line ends are kept), before stamping and again on the final text. A match may remain only when the same exact text matched as often in
  the old memory, so existing unchanged threats stay, but dates cannot hide
  a new match and an old prefix cannot exempt its completion. A
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
- A completed summary is stored directly as an assistant message marked
  `dream: true` in the bot's chat, made if it has none. It does not trigger
  another agent turn, and it is shown, not said: the bot's Pi conversation
  does not include it. An idle chat is closed first so open clients load the
  report; in a busy one, open clients reload the chat when its turn settles.
  Updating from the old separate `Dreams` section keeps it only when the bot
  has no other conversation, archived or not, and then marks its reports.
  Reports an earlier build left in the old store are marked when the chat
  first opens, so they never enter the bot's context either.
- `hexbot.dreaming.run_now {bot}` starts a dream immediately.
  `hexbot.dreaming.status {bot}` reports the last run, next run, and last error.
  Interrupted dreams are marked failed when the daemon restarts.

## Room memory

A room dream curates the main bot's private memory, then produces a
shared summary of at most 3,000 characters. Private user facts must stay out
of that summary. The result is stored in `room_memory` and injected into
members' room prompt headers. Bots keep durable facts about the room in
their own memory.
