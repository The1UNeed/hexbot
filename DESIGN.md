# Hexbot design

Agreed on 2026-09-03. This is the reference for every implementation
decision. The glossary in `CLAUDE.md` defines the words used here.

## 1. Product

Hexbot is a self-hosted, Grok Bot shaped multi-agent desktop app. It began
as a fork of Hermes Agent v0.21.0 by Nous Research (`NOTICE` records the
import commit); the core is now Hexbot's own code and tracks no upstream.
Bots on any provider share rooms, each with its own memory and skills, with
more freedom and more capability than a hosted product can offer.

- Repo: private `The1UNeed/hexbot`, no upstream git history, one import commit.
- License: AGPL-3.0. `NOTICE` carries the Hermes Agent and T3 Code MIT attributions.
- Layout: one monorepo. The core Python sits at the root and keeps its
  `hermes` identifiers. Product code lives in `hexbot/` (Python),
  `apps/desktop/` (Electron) and `apps/web/` (the shared React bundle).
- Cut at fork time: the upstream desktop app, the Ink TUI, website, evals, contributors,
  Windows-only scripts and tests. The 22 messenger platforms stay in the tree
  but are disabled by default. `scripts/install.sh` is kept for the runtime
  installer.
- Scope: macOS (Apple Silicon and Intel), Linux x86_64 (AppImage, .deb).
  No phone app. No import from an existing Hermes Agent install. English UI.
  No telemetry until opt-in crash reports before public release.

## 2. Daemon

- The core with profiles multiplexed in one process
  (`gateway.multiplex_profiles`). A bot is a profile.
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
- Approvals render inline in the transcript with approve, deny and
  always-allow. Native notifications for approvals and mentions.
- New bots get files, web search, browser and terminal (terminal gated by
  approvals). Computer use is off until enabled. Self-authored skills are on,
  with a transcript notice.
- Tools run on the host in a shared workspace at `~/Hexbot`. Per-bot working
  directories come with the roster milestone.

### Sections

- Persistent, Discord-thread-like conversations per bot and per room. Each is
  its own core session with its own context window.
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
- The app bundles the Python source. First run downloads uv, Python 3.11,
  Git and ripgrep into `~/.hexbot` using the core's installer.
- The daemon installs as a user service (launchd on macOS, systemd user unit
  on Linux), starts at login and keeps running when the app quits. A tray
  item shows status. If the user declines, the daemon runs only while the
  app is open.
- Signed and notarized from milestone 1 with a Developer ID certificate and
  an App Store Connect API key from environment variables.
- Update feed, downloads and docs at hexbot.app. GitHub Actions CI on macOS
  and Linux runners; release builds on tags. Versions start at 0.1.0. One
  stable channel; beta later.
- `hexbot` CLI adds `serve`, `pair`, `bots`, `rooms`, `send`, and runs
  the core CLI as `hexbot core <command>`.

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
