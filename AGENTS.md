# Hexbot — agent guide

Read this before changing anything. It is written for coding agents (Claude
Code, Codex, Cursor) and for people; `CLAUDE.md` imports it.

## What Hexbot is

Hexbot is a self-hosted multi-agent desktop app. Named **bots**, each with a
face, a model, skills, and its own memory, talk to you and to each other in
**rooms**. A Python **daemon** runs the bots and serves a WebSocket API plus a
web UI; an Electron **app** connects to it over LAN, Tailscale, or **Hex
Connect**. The **core** (agent loop, tools, providers, gateway, CLI) sits at
the repository root; product code sits in `hexbot/` and `apps/`. The core
is Hexbot's own code; there is no upstream to track.

Three facts shape most decisions:

- **Product behaviour lives at the edges.** New behaviour goes in `hexbot/`
  (a core plugin plus its own modules), `apps/`, or a skill. Change the core
  when the fix belongs there, not to bolt on a product feature.
- **Prompt caching is sacred.** A section is one long-lived core session
  that reuses a cached prefix every turn. Do not mutate past context, swap
  toolsets, or rebuild the system prompt mid-conversation.
- **One product, two packages, three channels.** Full package (app plus
  daemon) and client-only package (app alone) are build-time editions
  (`HEXBOT_EDITION`). Stable, Nightly, and Dev are release channels
  (`--channel` in `scripts/desktop/dist.mjs`). Never mix the two ideas.

## Glossary

Use these words consistently in code, UI copy, docs, and commit messages.

- **Hexbot**: the product. Not "Hexybot". Package and CLI name `hexbot`, home directory `~/.hexbot`.
- **Daemon**: the Hexbot server process (`hexbot serve`) that runs bots, rooms, memory, tools, and serves the WebSocket API and the web UI.
- **App**: the Electron desktop shell in `apps/desktop/` hosting the React bundle from `apps/web/`. The same bundle is served by the daemon to LAN browsers.
- **Full package**: the app with a local daemon. **Client-only**: the same app connected to a daemon elsewhere. Together, the two **editions**.
- **Channel**: how a build is named and published. **Stable** (tagged `v<version>`, updatable; named `Hexbot [alpha]` while the version is `0.x`), **Nightly** (`Hexbot Nightly`, daily from `main`, updatable on its own track), **Dev** (the source tree). See `docs/channels.md`.
- **Track**: the channel an installed app takes updates from, Stable or Nightly. Defaults to the channel the build came from; the user switches it in Settings, Updates.
- **Update server**: `updates.hexbot.app`, a Cloudflare R2 bucket holding every package and the electron-updater feed files. Written only by `release.yml`.
- **Bot**: a named agent with its own soul, model, skills, and memory. One core profile, multiplexed in one daemon process.
- **Section** = **conversation** = **thread**: one persistent chat with a bot or inside a room. A section lives until the user archives or deletes it. Each section is its own core session with its own context window.
- **Room**: a group chat with one or more humans and any number of bots. May have a **main bot** that responds when nobody is @-mentioned.
- **Turn**: one user message and everything the bots do in response. The room turn engine (`hexbot/rooms/`) decides who speaks.
- **Soul**: a bot's persona, the `SOUL.md` in its profile. The user and the bot both edit it; the bot says so when it does.
- **Memory**: a bot's own notes, the `MEMORY.md` in its profile. The bot writes it during chat, dreaming curates it, the user can edit it. Deleting a section removes its history and leaves memory alone.
- **About you**: one text per user, written only by the user and read by every bot they own (`users/<id>/user.md`).
- **Dreaming**: a bot's daily pass over that day's conversations that folds what matters into its memory.
- **Auto mode**: the approval mode that lets a small model auto-approve low-risk tool actions. The core calls it `smart`. The other modes are Manual (default) and Off.
- **Pairing**: connecting an app to a daemon with a one-time code or link over LAN. Never depends on Connect.
- **Hex Connect**: the optional cloud service at connect.hexbot.app (Clerk auth, Cloudflare tunnels) for reaching a daemon from outside the LAN. Brokers identity and a hostname; chat traffic never passes through it.
- **Core**: the Python code at the repository root. Core words that leak into Hexbot (`profile`, `session`, `smart`) stay internal; UI copy uses the Hexbot word.
- **`hermes` identifiers**: the core began as a fork of Hermes Agent, so some code names keep a `hermes` prefix for compatibility with existing installs: `hermes_cli/`, `HERMES_HOME` and other `HERMES_*` variables, `@hermes/shared`, the `hermes_session_at` cookie. Do not rename them. Never write "Hermes" in UI copy, docs, or prompts; the only exceptions are the credits to Hermes Agent in `README.md`, `NOTICE`, the site, and Settings, About.

## Where code lives

| Path | What | Channel |
| --- | --- | --- |
| `hexbot/` | Hexbot Python package: CLI, daemon plugin, pairing, bots, sections, rooms, memory, dreaming, users, Connect client | all |
| `apps/web/` | React bundle (Vite, Tailwind). Used by the app and served to browsers | all |
| `apps/desktop/` | Electron shell, updater, runtime bootstrap, two electron-builder configs | all |
| `apps/shared/` | `@hermes/shared`. `apps/web` imports its gateway client and event types; the core `web/` dashboard uses the rest | all |
| `apps/site/` | Astro site at hexbot.app: landing page, docs, pairing page | stable |
| `apps/connect/` | Next.js Connect service at connect.hexbot.app | all |
| `tests/hexbot/` | Hexbot Python tests. Core suites stay under `tests/` | all |
| `scripts/desktop/` | Version, build, icon, update feed, and cask scripts, each with tests | stable, nightly |
| `scripts/dev/` | `run.mjs` (`pnpm dev`) and the live smoke scripts | dev |
| `.github/workflows/` | `ci.yml` (tests, also called by release), `release.yml` (stable and nightly) | see file |
| `.devcontainer/` | Dev environment | dev |
| `docs/` | Design and operations docs. `docs/core/` covers the core: development guide, plugin APIs, the WebSocket API | |
| Root `*.py`, `agent/`, `tools/`, `hermes_cli/`, `tui_gateway/`, `gateway/`, `plugins/`, `skills/` | The core: agent loop, tools, providers, gateway, core CLI (`hexbot core <command>`) | |

`DESIGN.md` is the product design; `docs/channels.md` explains how the three
channels map to files, GitHub, and the update server, and what was borrowed
from T3 Code; `docs/release.md` is the release procedure and one-time setup;
`docs/testing.md` lists every test suite.

## Dev environment

Install once:

```sh
uv venv venv --python 3.11 && UV_PROJECT_ENVIRONMENT=venv uv sync --extra all --extra dev --locked
pnpm install --frozen-lockfile
```

Or open the repository in the dev container (`.devcontainer/`), which runs
those two lines for you.

Run Hexbot from the checkout (the Dev channel):

```sh
pnpm dev                # daemon + web bundle; open the printed URL
pnpm dev --desktop      # web bundle + Electron app (the app runs the daemon)
pnpm dev --home DIR     # daemon state elsewhere; --port N fixes the daemon port
pnpm site:dev           # hexbot.app on 4321
pnpm connect:dev        # Connect on 3000
```

`scripts/dev/run.mjs` keeps daemon state in `<checkout>/.hexbot` (gitignored)
and derives the daemon and web ports from the checkout path, so worktrees run
side by side and nothing touches `~/.hexbot`. It ignores an ambient
`HEXBOT_HOME` on purpose, refuses `~/.hexbot`, and prints the ports it picked;
read them from its output rather than assuming. It stops what it started by
PID. This mirrors T3 Code's `vp run dev` and its per-worktree `.t3` state.

Starting pieces by hand is fine too, with the same rule:

```sh
HEXBOT_HOME=$(mktemp -d) ./venv/bin/hexbot serve --port 9119
VITE_HEXBOT_ORIGIN=http://127.0.0.1:9119 pnpm --filter ./apps/web run dev
```

Three ways to hurt yourself:

1. **Writing to the live install.** `~/.hexbot` is the developer's real
   daemon state. Use `pnpm dev`, or run daemons with `HEXBOT_HOME` pointing
   at a temp directory. Read and copy from `~/.hexbot` if you need real data;
   never start a server against it.
2. **Killing by pattern.** Do not `pkill -f hexbot` or `pkill -f python`;
   your own agent process may match. Kill only PIDs you started.
3. **Growing the core for a product feature.** Prefer a plugin hook, a
   `hexbot/` module, or the RPC registration in `hexbot/plugin.py`. Change
   the core when the fix belongs there.

## Verifying

Run the suite that covers what you touched, not everything:

```sh
./venv/bin/pytest tests/hexbot -q && node --test tests/hexbot/*.test.mts
pnpm --filter ./apps/web run typecheck && pnpm --filter ./apps/web run test --run && pnpm --filter ./apps/web run lint
pnpm --filter ./apps/desktop run typecheck && pnpm --filter ./apps/desktop run test --run
pnpm --filter ./apps/site run check
pnpm --filter ./apps/connect run typecheck && pnpm --filter ./apps/connect run test --run && pnpm --filter ./apps/connect run lint
node --test scripts/desktop/*.test.mjs scripts/dev/*.test.mjs && node scripts/desktop/release-smoke.mjs
```

`ci.yml` runs all of these on every push and pull request, and `release.yml`
runs it again before building packages.

If you edited a core file, also run the core suites named in
`docs/testing.md` and compare against the recorded baseline. Backend tests
wait on events and RPC replies, never on `sleep`.

## Hit every surface

A change is done when it works in every place the feature appears:

- **Editions**: full and client-only. Anything that needs the daemon runtime
  must go through `requireRuntime` in `apps/desktop/src/main/edition.ts`.
- **Clients**: the Electron app and the browser bundle served by the daemon.
- **Connection modes**: LAN pairing, Tailscale, and Connect.
- **Reverse states**: a toggle needs both directions; archive needs
  unarchive; a revoked device needs to land back on the connect screen.
- **Words**: UI copy uses the glossary. `docs/` and the site docs change in
  the same PR when behaviour changes.

## Channels and releases

The release model is T3 Code's (`docs/channels.md`, "Borrowed from T3
Code"): one `release.yml` for both channels, a stable tag, a scheduled
nightly, and a finalize step that commits bookkeeping back to `main`.

- `main` is always buildable. CI (`ci.yml`) runs tests and builds on every
  push and pull request and publishes nothing.
- A **stable** release is a `v<version>` tag on `main` where `<version>`
  equals `apps/desktop/package.json` (`preflight` refuses anything else).
  Push the tag, or dispatch `release.yml` on `main` with channel `stable`
  and the run creates it.
  `release.yml` runs CI, builds six packages, uploads the feed to
  `updates.hexbot.app`, creates the GitHub release (prerelease while the
  version has a suffix, "latest" for a plain `X.Y.Z`), then `finalize`
  commits the website manifest and the Homebrew casks to `main`.
- A **nightly** is built by the same workflow every day `main` moved, as
  `<next>-nightly.<YYYYMMDD>.<run>`, published as a prerelease and to the
  nightly feed. Nightly versions are never committed. The last 14 are kept.
- **Dev** is your checkout (`pnpm dev`). `node scripts/desktop/dist.mjs
  --mac` produces a `Hexbot (dev)` package with its own app id.
- Versions live in two files and change together through
  `node scripts/desktop/set-version.mjs <version>`.
- The `[alpha]` suffix in the app name comes from `productName()` in
  `scripts/desktop/release-version.mjs` and goes away at 1.0. Never remove
  it by hand while the version is `0.x`.

Never hand-edit versions inside a workflow run, never publish from a laptop,
and never push a `v*` tag or dispatch the Release workflow unless asked; both
publish real builds. There is no dry run; a manual nightly is the way to
exercise the graph.

## Pull requests and commits

- Conventional titles in plain words: `fix(web): rooms no longer drop the
  first message`, `feat(daemon): dreaming skips archived sections`.
- One concern per PR. Screenshots for UI changes.
- Do not commit plans, scratch files, or build output (`apps/*/.next`,
  `apps/*/dist`, `apps/desktop/release` are ignored; keep them that way).
- Write release notes in `docs/releases/<version>.md` before tagging.

## Taste

- Simple over clever. The smallest change that fixes the whole bug class.
- Complexity belongs at boundaries: the core plugin seam, the WebSocket
  RPC layer, the Electron main process. Components and daemon handlers stay
  plain.
- Users notice dropped frames and stale labels. No continuous repaint
  animations; the bot faces are the one place motion is allowed.
- Copy is short, concrete, and uses glossary words. No "seamless", no
  exclamation marks.

## Core reference

`docs/core/development.md` is the development guide for the core (tools,
plugins, skills, cron, the AIAgent class, prompt caching rules). Read it
before editing anything at the repository root.
