# Hexbot design

Agreed on 2026-09-03. This is the reference for every implementation
decision. The glossary in `CLAUDE.md` defines the words used here.

## 1. Product

Hexbot is a self-hosted multi-agent desktop app. A Rust daemon runs persistent
agent conversations through Pi.
Bots on any provider share rooms, each with its own memory and skills, with
more freedom and more capability than a hosted product can offer.

- Repo: private `The1UNeed/hexbot`, no upstream git history, one import commit.
- License: AGPL-3.0. `NOTICE` carries the inherited MIT attributions.
- Layout: one monorepo. The daemon lives in `backend/hexbot-core/`, with a
  pinned agent runtime and private extension in `backend/pi-runtime/`.
  `apps/desktop/` hosts the shared React bundle from `apps/web/`.
  `backend/python-handoff/` provides the service handoff.
- Scope: macOS (Apple Silicon and Intel), Linux x86_64 (AppImage, .deb).
  No phone app. No import from unrelated agent installs. English UI.
  No telemetry until opt-in crash reports before public release.

## 2. Daemon

- Rust owns storage, rooms, tools, approvals, networking and scheduling.
  Each section has one persistent Pi conversation and cached prompt prefix,
  refreshed only at a compatible compaction boundary, as described below.
- No cap on bots per user or bots per room.
- All core providers are supported. Credentials are configured once at the
  deployment level. Each bot picks any model from any configured provider.
  The model picker is live (provider model list) plus a curated set on top.
- Onboarding and the providers screen state that users pay their own
  provider costs; Hexbot provides no tokens.

### Memory

- Each bot has two files: its soul (persona; the user and the bot both edit
  it, and the bot says so when it does) and its memory (short entries the
  bot writes during chat, each ending with the month it was learned, capped
  at 2,200 characters, injected every turn).
  Beside them sit its daily notes: one file a day, up to 4,000 characters,
  that the bot appends to at natural pauses and reads back by day. Notes
  are never injected; the dream folds what lasts into memory, and a day is
  deleted after 30 days. The user reads, edits, and deletes them by day in
  the bot's Memory tab.
  Searchable history over its chat and rooms sits beside them. The chat's
  own history is searchable from before its latest summary.
- About you: one text per user, capped at 2,000 characters, written only by
  the user and injected into every bot they own. Nothing else is shared
  between bots.
- A room is a shared section for its members. Late joiners see the full
  transcript. A bot that leaves keeps history up to that point.
- A bot has one chat with you; it is never archived or deleted on its own.
  Deleting the bot deletes it. What the bot wrote to its memory and its notes
  stays until the user or dreaming
  edits it.
- Dreaming: every bot, daily at a configurable time (default 03:00), reads
  conversations from the start of its last successful dream up to, but
  excluding, its own start and folds what matters into its memory using its
  own model. Both starts are rounded down to whole milliseconds. Messages
  and compaction summaries at or after that start wait for the next dream.
  Failed or interrupted dreams leave the lower cutoff unchanged; the first
  dream reviews earlier history. It reads what people
  and bots said, not tool output or its own earlier reports, plus the summaries
  written when its chat or that bot's room conversation was compacted,
  which it treats as untrusted since they were written with tool output in
  view, and its notes from those days first of all. It never touches the soul or About you. It posts a report in the
  bot's chat as a message the bot itself does not see, marked so later dreams
  skip it. A "dream now" action exists. Rooms dream through
  their main bot into the room's section.
- Scheduled jobs run unattended, so they cannot write memory, notes, or
  the soul. What a job asks to remember is a proposal; the bot's next dream reviews it
  as an untrusted suggestion and keeps or drops it. Soul changes need the
  user.

### Rooms

- An @-mentioned bot responds. An optional per-room main bot responds when
  nobody is mentioned. With neither, bots stay silent.
- The owner and the main bot can add members mid-conversation.
- When the main bot fans out to several bots, replies post as they finish,
  then the main bot takes one collecting turn.
- A bot tagging a human puts the room into a waiting state with a
  notification; the bot does nothing more until answered.
- Limits, set in system config with per-room override: eight bot turns per
  human turn, a per-bot daily token budget, a per-room budget per human turn.
  When a limit trips the room posts a notice and stops.
- Usage comes from the core's `session_model_usage` table and the native
  runtime's usage rows, all on the owner's keys.

### Bots talking to bots

- Bots may message each other unprompted. Each bot reads its teammates'
  descriptions (the user's, or a hidden one the daemon writes) and asks the
  one that fits, in a private one-to-one conversation the user opens on
  demand. Both bots dream over these conversations like any other.
- The activity view shows bot pairs with message counts, later a network
  graph, with click-through to the conversation.

### Approvals and tools

- Modes: Auto (default, `smart` in config), Manual, Bypass (`off` in
  config). Overridable per bot and per room. The model follows Codex: the
  OS sandbox is the boundary, not pattern matching. In Auto, a step that
  leaves the sandbox goes to a reviewer first, like Codex's auto-review and
  Claude Code's auto mode. Pi itself has no approval modes; Bypass is plain Pi.
- Auto trades containment for fewer prompts, on purpose. Inside the sandbox
  the OS decides; outside it, internet access and writes outside the
  workspace are decided by a model review on the section's model, which can
  be a small local one. The step text the reviewer judges (command, reason,
  file content, tool arguments) is written by the bot and can carry
  instructions injected by a page or file the bot read, so a reviewer can be
  talked into allowing a step. That is a judgment, not containment; Manual
  keeps the user in front of every such step.
- Auto: shell commands run in a sandbox with no network that can write only
  inside the workspace (the bot's working directory, its artifact and
  attachment folders, temp folders); shell profiles and login items stay
  read-only even there. A command that needs the internet or a write outside
  the workspace sets `full_access` with a one-sentence `reason`, and runs
  with the sandbox's base layer only (credential files still unreadable).
  File tools change the workspace without asking. Code execution runs in the
  same workspace sandbox without asking. Absolute cron script paths ask.
  File changes to shell profiles and login items use user approval rather than
  model review. Full-access shell commands can change them after model review,
  including without a card when the owner requested that exact change.
- Auto's reviewer (`runtime_review.rs`): a full-access command, a file change
  outside the workspace, a connected tool that changes something, and a
  browser page script go to a tool-free one-shot call on the section's model.
  It reads the owner's visible messages in the section and their room
  messages, newest first, plus the step's whole input, working directory,
  checked file destination and overwrite status. It loads no project instruction files,
  skills or tools. Assistant text, tool output and bot-added messages stay out.
  Pi starts in an empty directory and explicitly excludes `APPEND_SYSTEM.md`.
  ACP reviewers also use an isolated temporary home and Copilot/XDG folders,
  keeping only explicit GitHub-token authentication. Stored CLI login is not
  imported. Only `--acp` and `--stdio` are accepted as configured ACP arguments.
  Extra arguments, missing auth or rejected isolation flags fall back to a
  card; ordinary ACP sessions keep their login behavior.
  A step over 20,000 characters asks without review, whatever the tool.
  Owner messages fill the rest of an 80,000-character request, newest first
  and never clipped. When older ones are left out (or a stored row is too
  large to load), the request says so and only a low risk `allow` runs: a
  long chat's lost restriction could forbid a medium-risk step, so it asks.
  History-read failures also ask. Each section runs at most two reviews at
  once, and shows "Checking this step" while one runs. The final check
  retries once when the database or reply slot is briefly busy. Reported reviewer usage counts toward section,
  room and daily totals. Changed owner messages or pending owner prompts and steers
  invalidate automatic approval when the complete evidence is rechecked.
  Copilot ACP reports zero token usage and cost, so its reviews add no measured
  usage to budgets or totals.
  A low or medium risk `allow` runs the step; anything else, including a failure,
  a timeout (60 s) or unparseable output, shows the card with the reviewer's sentence. Those
  cards offer Approve and Deny only, and reviewed steps ignore Allow for now
  grants from Manual, so one approval never covers the next step. Changing the mode
  or working directory during review blocks the step. File execution also
  checks the resolved destination and reviewed overwrite status again.
  Only visible sections are reviewed; the rest still refuse.
- Manual: the shell sandbox is read-only, so a command that writes or
  reaches the network sets `full_access` and asks. Every file change and
  every code run asks. Reads are free in both modes except credential files,
  which stay private: Hexbot's own `.env`, provider auth, device tokens in
  `desktop-data/`, the stores in `credential-policy.json` (`~/.aws`,
  `~/.netrc`, `~/.npmrc` and the rest), and SSH private keys (`id_*` except
  `.pub`, `*.pem`, `*.key`). SSH config, known hosts, public keys, and the
  SSH agent remain available. The sandbox denies writes to the stores for
  every program a command starts, and to the Hexbot home except the output
  folders. Scheduled scripts must stay in the bot scripts folder or
  workspace.
- Bypass: no prompts, no sandbox, no credential checks. A bot can read and
  change anything the daemon's OS user can, including provider keys.
- Without an OS sandbox (Linux where bubblewrap fails its startup probe)
  Hexbot warns, Settings shows a notice, Manual and Auto ask before every
  shell command and code run, including full-access commands, and scheduled
  scripts refuse to run. Model review cannot replace this user approval;
  an explicit Allow for now can cover later shell requests.
- Connected tools use Pi's built-in MCP through codemode. A section freezes
  server namespaces and tool declarations; a bot's chat takes changed ones at
  its next message, rebuilt once without the cache. Manual asks for every
  connected-tool call, and Allow for now covers that server. Auto runs
  read-only tools freely and reviews other calls individually; their cards
  offer Approve and Deny only. Bypass never asks. Every nested codemode call
  uses the same approval gate. Removal and disable revoke access immediately,
  including in Bypass.
  Changed credentials block old clients until they reconnect at the next prompt.
  Saved sections keep their existing Rust bridge tools.
- Approvals render inline in the transcript with Approve, Allow for now, and
  Deny when a grant is available. "Allow for now" quiets the same kind of
  Manual or unreviewed request until the bot's agent process restarts;
  nothing is saved. Reviewed Auto cards, incomplete file scans and requests
  the daemon raises itself (code runs, browser scripts, cron) offer Approve
  and Deny only. Native notifications for approvals and mentions.
- New bots get files, web search, browser and terminal (terminal gated by
  approvals). Computer use is off until enabled. Self-authored skills are on,
  with a transcript notice. Bundled and user-shared skills form one library,
  enabled for every bot unless disabled globally or for that bot. Bots write
  private skills; the owner can share a bot's skills into the library.
  A bot owner can edit its private skills and grants.
- Tools run on the host in a shared workspace at `~/Hexbot`. Per-bot working
  directories come with the roster milestone.

### Chats

- One chat per bot, like a contact in a messaging app. It never ends: there
  is no new chat, archive or delete, and summarising older messages keeps it
  going. Rooms have one conversation each. Internally each is a section, its
  own persistent Pi conversation with its own context window; the threads in
  which bots ask each other for help are sections too.
- Updating from a build with many sections per bot keeps, for each bot, the
  section with the latest conversation (something said, not the old Dreams
  log, not archived, newest) and deletes the rest with their history. It runs
  once, at the first start of this version before any client can connect,
  and first makes a full copy of `hexbot.db`, `hexbot-runtime.db`, the bots'
  `state.db` and `runtime/sessions` in `backups/one-chat-per-bot-<time>/`, so
  it needs that much free disk. If anything fails (the copy, recovery, a
  delete) nothing more is deleted, the partial copy is removed, and the
  sections left stay for good; no later start tries again. A section leaves
  the list before its history is removed, so a stop part way never leaves a
  broken one: it is whole or gone, and what is left of a gone one is removed
  at the next start. A bot whose conversations recovery could not read, or
  whose older `state.db` cannot be read, keeps them all. Its chat is ranked
  the same way, so the old Dreams log is never a bot's chat while a
  conversation remains; while its `state.db` cannot be read, or recovery has
  set its conversation aside, it gets a new, empty chat, and the old sections
  open once their files are repaired. Memory and notes stay.
- An updated app on a daemon from before one chat per bot makes a section
  only for a bot with none, since that daemon makes a new one on every
  create. That daemon's list cannot tell its Dreams log, renamed or not, from
  a conversation, so the app opens a section by itself only while at most
  one has something said, and otherwise asks which one to continue.
- A chat starts with the bot's memory and a catalog of skill descriptions.
  It loads skill bodies when needed. It picks up the current name, soul,
  memory, About you, teammates and skill catalog after compaction if the next
  request starts a new run. A continuation within the active run discards that
  refresh until another compaction. When the bot's tools or connected servers
  change, or an update changes Hexbot's own tools, the chat is rebuilt with
  them at its next message; rooms, threads between bots, jobs and delegates
  keep what they started with. Skill reads use current bodies and grants.
- Sidebar: one list of bots and rooms ordered by recent activity. A bot is one
  row; opening it opens the chat.

## 3. Client

- Electron, React 19, TanStack Router, Tailwind v4, Base UI. Plain Vite,
  a pnpm workspace shared with the core at the root. No Effect.
- Talks directly to the daemon's JSON-RPC WebSocket at `/api/ws`, extended by
  `hexbot.*` methods (bots, sections, rooms add-member, memory, pairing).
  No middle server.
- The same bundle is served to LAN browsers by the daemon with a cookie
  session.
- Grok Bot's layout and interactions are reproduced as patterns with
  Hexbot's own colours, type and icons. Milestone 1 panels: roster, chat,
  right profile panel. Attachment parity with Grok Bot: text, links, images,
  local files, with previews.
- Light and dark themes following the system. Voice dictation as the core
  implements it. One daemon connection at a time (several in the Connect
  milestone).
- Bot avatars: uploaded image, generated initials by default.
- Tool calls show only while they run, then collapse into one line above the reply.
- Visuals: a bot can show a chart, table, diagram or mockup as an HTML page
  in the conversation (`hexbot_show_html`). It is drawn, live, in a bot
  bubble above the bot's final reply, under its title and an Expand button
  that opens it beside the chat, where each visual gets a tab like a
  browser's. It follows the app's theme and runs sandboxed with no network
  access beyond a few script CDNs.

## 4. Network, auth, Connect

- The core's session token and single-use WebSocket ticket flow, plus pairing:
  the daemon shows a short code and QR, the client exchanges it once for a
  long-lived device token, revocable in settings.
- The daemon listens on localhost until the user enables "Allow other
  devices", then binds `0.0.0.0` and shows the pairing code.
- Plain WebSocket on the LAN. Tailscale is the documented first outside path.
- Connect (hexbot.app): Cloudflare Tunnel per daemon with a managed hostname,
  one Clerk account owning many daemons, device-code registration, Next.js on
  Vercel with Postgres, AGPL, free during beta. Traffic goes direct through
  the tunnel; Connect only brokers identity and hostnames.

## 5. Packaging and operations

- One Electron app, delivered as a single complete package. First launch
  asks: connect to a Hexbot daemon, or run one on this machine. No container
  engine or separate server install is ever required of a user.
- The full package bundles the native daemon, Node, the agent runtime, web
  assets and skills. First launch downloads a pinned, checksum-verified uv
  binary, managed Python 3.11 for code tools and edge-tts for voice.
  The client-only edition installs no runtime.
- The daemon installs as a user service (launchd on macOS, systemd user unit
  on Linux), starts at login and keeps running when the app quits. A tray
  item shows status. If the user declines, the daemon runs only while the
  app is open.
- One installer, as a small windowed app (Hexbot Installer, Tauri) or
  `curl -fsSL https://hexbot.app/install.sh | sh`, offers Full, Client, and
  Headless, and fetches only the chosen option. Headless is the daemon alone:
  `hexbot setup` and `hexbot service install` do without Electron what the
  full package's first launch does, for servers reached over SSH. Running
  the installer again updates, changes, or uninstalls; `~/.hexbot` stays.
- Signed and notarized from milestone 1 with a Developer ID certificate and
  an App Store Connect API key from environment variables.
- Update feed, downloads and docs at hexbot.app. GitHub Actions CI on macOS
  and Linux runners; release builds on tags. Versions start at 0.1.0. One
  stable channel; beta later.
- The native `hexbot` CLI provides `serve`, `setup`, `service`, `status`,
  `pair`, `bots`, `rooms`, `devices`, `connect` and `send`. Legacy core administration commands are not included.

## 6. One person per daemon

- A daemon belongs to one person. There are no invites, roles or other
  accounts on it; every device paired to it is that person's. Get Started
  asks for their name, and rooms show it on their messages.
- One person may run several daemons, or reach several through Hex Connect
  accounts, and switches between them in the app (Full or Client).
- Rooms with other people go through Hex Connect: each person keeps their
  own daemon, and the room spans them. Not built yet.
- Owner ids stay on bots, rooms, sections, messages and memory. Earlier
  builds had invited members; upgrading folds what they made into the owner
  and revokes their devices.

## 7. Milestones

1. Single bot over LAN and Tailscale: full package and client-only modes,
   pairing, streaming chat, sections, attachments, core and section memory,
   tools with approvals and notifications, web UI, `hexbot serve` and
   `hexbot pair`, signed builds with a working update feed, unit tests plus
   one end-to-end Electron test.
   Done means: fresh macOS and fresh Linux install; a second machine paired
   over LAN and Tailscale; memory survives restarts; an update is delivered.
2. Connect.
3. Roster and rooms: name-first bot creation (the bot asks the rest), per-bot
   tools, skills and directories, room mechanics and limits, bot-to-bot
   messages, activity list, usage view.
4. Live computer view, dreaming, activity graph, room memory, bundled vector
   memory.
5. One person per daemon (earlier: multi-user, since removed).
6. Packaging and release: Homebrew, .deb polish, beta channel,
   opt-in crash reports, public repo.
