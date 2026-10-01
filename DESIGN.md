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
  Legacy Python remains for one release of background-service handoff.
- Scope: macOS (Apple Silicon and Intel), Linux x86_64 (AppImage, .deb).
  No phone app. No import from unrelated agent installs. English UI.
  No telemetry until opt-in crash reports before public release.

## 2. Daemon

- Rust owns storage, rooms, tools, approvals, networking and scheduling.
  Each section has one persistent Pi conversation and cached prompt prefix.
- No cap on bots per user or bots per room.
- All core providers are supported. Credentials are configured once at the
  deployment level. Each bot picks any model from any configured provider.
  The model picker is live (provider model list) plus a curated set on top.
- Onboarding and the providers screen state that users pay their own
  provider costs; Hexbot provides no tokens.

### Memory

- Each bot has two files: its soul (persona; the user and the bot both edit
  it, and the bot says so when it does) and its memory (short entries the
  bot writes during chat, capped at 2,200 characters, injected every turn).
  Searchable history over its own sections and rooms sits beside them.
- About you: one text per user, capped at 2,000 characters, written only by
  the user and injected into every bot they own. Nothing else is shared
  between bots.
- A room is a shared section for its members. Late joiners see the full
  transcript. A bot that leaves keeps history up to that point.
- Archive keeps a section. Delete removes the section and its history; what
  the bot wrote to its memory stays until the user or dreaming edits it.
- Dreaming: every bot, daily at a configurable time (default 03:00), reads
  that day's conversations and folds what matters into its memory using
  its own model. It never touches the soul or About you. It posts a
  report in its direct message thread. A "dream now" action exists. Rooms
  dream through their main bot into the room's section.

### Rooms

- An @-mentioned bot responds. An optional per-room main bot responds when
  nobody is mentioned. With neither, bots stay silent.
- Humans and the main bot can add members mid-conversation.
- When the main bot fans out to several bots, replies post as they finish,
  then the main bot takes one collecting turn.
- A bot tagging a human puts the room into a waiting state with a
  notification; the bot does nothing more until answered.
- Limits, set in system config with per-room override: eight bot turns per
  human turn, a per-bot daily token budget, a per-room budget per human turn.
  When a limit trips the room posts a notice and stops.
- Usage comes from the core's `session_model_usage` table, attributed to the
  inviter in rooms and to the owner in direct messages, on the admin's keys.

### Bots talking to bots

- Bots may message each other unprompted.
- The activity view shows bot pairs with message counts, later a network
  graph, with click-through to the conversation.

### Approvals and tools

- Modes: Manual (default), Auto (`smart` in config), Off. Overridable per bot
  and per room. The auto-approver runs on the cheapest model of the first
  configured provider.
- Off skips approval prompts. Manual asks before dangerous shell commands
  and protected actions. Auto uses the same gates
  with a small model deciding. Every mode blocks catastrophic commands and
  prevents tools from reading Hexbot credential files, including app device
  tokens in `desktop-data/`. On macOS, shell, Python, and scheduled scripts
  cannot write the Hexbot home except their workspace and artifact or attachment
  folders. Linux applies these restrictions when bubblewrap passes its startup
  probe; otherwise Hexbot warns, Manual asks before every shell command and
  code run, Auto sends them to the section owner, and scheduled scripts wait
  for Off. Credential stores (`~/.aws`, `~/.netrc`, `~/.npmrc` and the rest of
  the deny list in `credential-policy.json`) are never written by tools; the
  sandbox denies writes there for every program a command starts, and a shell
  command that names one asks in Manual and Auto. bubblewrap can only bind a
  store that exists, so on Linux in Off mode a command can still create a
  missing one. SSH private keys
  (`id_*` except `.pub`, `*.pem`, `*.key`) are protected. SSH config, known hosts,
  public keys, and the SSH agent remain available. A bot scheduling an absolute
  script path asks the section owner in Manual and Auto. Scripts must stay in
  the bot scripts folder or workspace.
- Approvals render inline in the transcript with approve, deny and
  always-allow. Native notifications for approvals and mentions.
- New bots get files, web search, browser and terminal (terminal gated by
  approvals). Computer use is off until enabled. Self-authored skills are on,
  with a transcript notice.
- Tools run on the host in a shared workspace at `~/Hexbot`. Per-bot working
  directories come with the roster milestone.

### Sections

- Persistent, Discord-thread-like conversations per bot and per room. Each is
  its own persistent conversation with its own context window.
- A new section starts with only the bot's memory and skills.
- Sidebar: one list of bots and rooms ordered by recent activity. Each entry
  shows one or two recent sections and expands to show the rest. Archived
  sections sit collapsed at the bottom.

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
- Signed and notarized from milestone 1 with a Developer ID certificate and
  an App Store Connect API key from environment variables.
- Update feed, downloads and docs at hexbot.app. GitHub Actions CI on macOS
  and Linux runners; release builds on tags. Versions start at 0.1.0. One
  stable channel; beta later.
- The native `hexbot` CLI provides `serve`, `pair`, `bots`, `rooms`, `devices`,
  `connect` and `send`. Legacy core administration commands are not included.

## 6. Multi-user (later)

- Owner ids on bots, rooms, sections, messages and memory from day one.
- One shared daemon per household. The admin owns provider keys and limits.
  Members get their own bots and rooms. Owners can mark bots shareable.
  Per-user budgets and a usage view for the admin.

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
5. Multi-user.
6. Packaging and release: Homebrew, .deb polish, beta channel,
   opt-in crash reports, public repo.
