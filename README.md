# Hexbot

**HexBot is currently in beta, so expect to occasionally run into hiccups and bugs, however we encourage you to give it a shot anyway.**

Hexbot is a desktop app and a background daemon. You create **bots**, each
with its own persona, model, skills, and memory. You talk to a bot in its
**chat** (one ongoing conversation), or put several bots and people in a
**room** and let them talk to each other. Everything runs on your machine or
a box on your LAN. Phones and laptops pair with it by code, and the optional
**Hex Connect** service reaches it from anywhere without routing your chat
through the cloud.

Hexbot is in alpha. Every build carries its channel in its name so you know
what you are running.

## Get it

| Channel | Name | Get it from | For |
| --- | --- | --- | --- |
| **Stable** | `Hexbot [alpha]` | [GitHub releases](https://github.com/The1UNeed/hexbot/releases) and, once published, [hexbot.app](https://hexbot.app/download/) | Users. Tagged, signed, notarized when the keys are in place, updates itself. Still alpha while the version is `0.x`. |
| **Nightly** | `Hexbot Nightly` | [hexbot.app](https://hexbot.app/download/) until the first stable release, and [nightly prereleases on GitHub](https://github.com/The1UNeed/hexbot/releases?q=nightly) | Testers who want yesterday's fixes. Installs next to the stable app, updates itself to the next nightly. |
| **Dev** | `Hexbot (dev)` / source | This repository, see [Develop](#develop) | Contributors and coding agents. |

Install with the Hexbot Installer from
[hexbot.app/download](https://hexbot.app/download/), or from a terminal,
also over SSH:

```sh
curl -fsSL https://hexbot.app/install.sh | sh
```

Both offer three options and download only the one you choose:

- **Full** (`Hexbot`): the app plus the daemon. Install where your bots
  should live.
- **Client** (`Hexbot Client`): the app alone. Install on any other computer
  and pair it with a daemon.
- **Headless**: the daemon alone, as a background service with the `hexbot`
  command. Install on a server and use it from Client or Full elsewhere.

Run the installer again to update or repair, change options, or uninstall;
`~/.hexbot` is kept unless you ask to delete it. Full and Client are also
direct downloads for macOS (Apple Silicon and Intel) and Linux (AppImage and
deb). [Install](https://hexbot.app/docs/install/) has the details.

Stable and Nightly share `~/.hexbot`. Back it up before opening a nightly.
The app follows the track it was installed from; switch in Settings, Updates.
`docs/channels.md` has the full matrix.

## What it does

- **A primary bot.** Setup creates **HexBot**, which creates, changes, and
  deletes your other bots, builds rooms, schedules jobs, and changes settings
  from its chat. Deleting anything or changing settings always asks, even in
  Bypass.
- **Bots with memory.** Each bot has a soul, its own memory, daily notes, and
  a searchable history of its one ongoing **chat**. A daily **dreaming** pass
  folds the notes into memory. One **About you** text, written by you,
  reaches every bot you own. Recall your latest message and the bot forgets
  it.
- **Heartbeat.** Every 30 minutes each bot works through its own checklist,
  `HEARTBEAT.md`, and writes to you only when something needs you.
- **A shared computer.** With Computer use on, bots click and type on one
  Linux desktop (a [Cua](https://cua.ai) sandbox in Docker) that you can
  watch live and take over.
- **Visuals.** In its chat a bot can show a chart, table, diagram, or mockup
  as a live, sandboxed page above its reply.
- **Faces.** Each bot's face moves with what it does and reacts to what
  happens, with optional sound cues.
- **Rooms.** Group chats with any number of bots and people. A **main bot**
  answers when nobody is @-mentioned; bots can address each other.
- **Any model.** Bring keys for OpenAI, Anthropic, Google, OpenRouter, local
  servers, and more. Pick a model and a reasoning level per bot.
- **Plugins.** Connectors, MCP servers, skills, and plugin packages, set up
  once in Settings, Plugins and given to the bots you choose. A bot can ask to
  install one; that always asks you.
- **Tools with approvals.** Bots can run commands, browse, and edit files.
  In **Auto mode**, the default, they work freely inside the workspace
  behind an OS sandbox; steps outside it get a check by the bot's model, and
  risky or unreviewable steps ask once. The check is the model's judgment,
  not a sandbox. Without OS isolation, shell commands require user approval
  even when requesting full access. Manual asks
  before every change; Bypass asks nothing. Git metadata is read-only and
  project secrets and browser stores are hidden within the platform limits in
  [SECURITY.md](SECURITY.md#tool-isolation). Linux scans existing repositories
  through three nested folders and skips dependency/runtime folders. Only Linux
  bubblewrap commands require an approved full-access retry when the scan
  exceeds 1,000 directories or 50,000 entries. macOS uses partial scan
  results; file changes ask for approval in Auto mode, one at a time, when the
  scan is incomplete.
  Repositories created during a command are not protected on Linux. macOS
  filename rules also cover new `.git` metadata directories.
- **Your hardware.** The daemon runs where you install it and keeps working
  when the window closes. Pair the desktop app, a browser, or the iPhone and
  Android app over LAN or Tailscale, and revoke them from settings.
  Settings, Advanced, Diagnostics shows what the daemon is doing.
- **Hex Connect.** Sign in once, reach your daemon from outside the LAN in the app or a browser.
  Connect brokers identity and a hostname; chat traffic never passes through
  it.

Docs live at [hexbot.app/docs](https://hexbot.app/docs/) and are built from
`apps/site/`.

### Connected tools

Each section starts its own process per connected stdio server in a daemon-owned
directory. Servers receive only the runtime's allowed environment and their
explicit settings. Manual asks for every connected-tool call. Auto runs tools
marked read-only freely and reviews other calls one at a time. Risky or
unreviewable calls ask, with Approve and Deny only. In Manual, Allow for now
covers that server until the bot's agent process restarts. Bypass never asks.
Removing or disabling a server revokes it in open sections. Config or credential edits block
old connections and reconnect at the next message. Server stderr, up to the
last 2 KB, may reach the bot in connection errors.

## Develop

Hexbot's daemon is Rust in `backend/hexbot-core/`; agents run on pinned Pi
1.0.1 through the private extension in `backend/pi-runtime/`. The web bundle,
Electron app, site, and Connect service live in `apps/`. `backend/python-handoff/` provides the service handoff for
existing Python installs. Hexbot began as a fork of
[Hermes Agent](https://github.com/NousResearch/hermes-agent) by Nous Research. `AGENTS.md` is the guide for anyone, human or agent, working on the
code; `backend/hexbot-core/README.md` covers storage compatibility.

Install rustup and Node 26, then use the Rust toolchain pinned in
`rust-toolchain.toml`:

```sh
rustup show active-toolchain
pnpm install --frozen-lockfile
```

Then run Hexbot from the checkout:

```sh
pnpm dev              # daemon + web bundle; open the printed URL
pnpm dev --desktop    # web bundle + Electron app (the app runs the daemon)
pnpm site:dev         # hexbot.app on 4321
pnpm connect:dev      # Connect on 3000
```

`pnpm dev` keeps daemon state in `<checkout>/.hexbot` (gitignored) and
picks ports from the checkout path, so worktrees run side by side and nothing
touches `~/.hexbot`, your real install. `scripts/dev/run.mjs` has the flags.

Tests:

```sh
cargo test --locked --manifest-path backend/hexbot-core/Cargo.toml
pnpm --filter ./apps/web run typecheck && pnpm --filter ./apps/web run test --run && pnpm --filter ./apps/web run lint
pnpm --filter ./apps/desktop run typecheck && pnpm --filter ./apps/desktop run test --run
node --test scripts/desktop/*.test.mjs scripts/dev/*.test.mjs
pnpm --filter ./apps/site run check
pnpm --filter ./apps/connect run typecheck && pnpm --filter ./apps/connect run test --run
```

`docs/testing.md` lists everything, including the handoff package and
Electron end-to-end tests.

## How releases work

One workflow, `.github/workflows/release.yml`, modelled on
[T3 Code](https://github.com/pingdotgg/t3code)'s:

- Every push and pull request runs `ci.yml`: tests and builds, no publishing.
- **Stable**: `node scripts/desktop/set-version.mjs 0.x.y-alpha.N`, write
  `docs/releases/0.x.y-alpha.N.md`, commit, push the `v0.x.y-alpha.N` tag.
  The workflow runs CI, builds all six packages, uploads the update feed to
  `updates.hexbot.app`, creates the GitHub release, and commits the website
  manifest and Homebrew casks back to `main`.
- **Nightly**: every day at 09:00 UTC when `main` moved, the same workflow
  builds `0.x.y-nightly.YYYYMMDD.<run>` and publishes a prerelease and the
  nightly feed. The last 14 nightlies are kept.

`docs/channels.md` explains the channels and what was borrowed from T3 Code;
`docs/release.md` is the procedure and the one-time setup.

## Where things are

| | |
| --- | --- |
| Site and docs | [hexbot.app](https://hexbot.app), `apps/site` |
| Hex Connect | [connect.hexbot.app](https://connect.hexbot.app), `apps/connect` |
| Update server | `https://updates.hexbot.app/` (Cloudflare R2, written by `release.yml`) |
| Design | `DESIGN.md` |
| Channels | `docs/channels.md` |
| Release procedure | `docs/release.md` |
| Agent guide | `AGENTS.md` |

## Status

Milestones 1 through 6 of `DESIGN.md` are implemented: daemon, pairing, the
desktop app on macOS and Linux, sections and memory, Connect end to end,
rooms and the turn engine, dreaming, and packaging. Milestone 5 now makes
a daemon one person's; rooms with other people will go through Hex Connect. The first
public alpha waits on Apple signing credentials and the Connect production
accounts (Clerk, Neon, Cloudflare). Until then hexbot.app/download offers
the current nightly and says stable is coming soon.

## License

Hexbot's own source code is Apache-2.0, except where a file or directory
states otherwise. See `LICENSE` and `NOTICE`.
The licenses of the third-party software each package includes are written by
`scripts/desktop/third-party-notices.mjs`: `THIRD_PARTY_NOTICES` beside
`LICENSE` in the app, the daemon runtime and the windowed installer,
`hexbot-install --license`, Settings, About, Licenses in the app, and
Settings, Licenses on mobile. 
