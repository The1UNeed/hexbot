# Hexbot — agent guide

Read this before changing anything. It is written for coding agents (Claude
Code, Codex, Cursor) and for people; `CLAUDE.md` imports it.

## What Hexbot is

Hexbot is a self-hosted multi-agent desktop app. Named **bots**, each with a
face, a model, skills, and its own memory, talk to you and to each other in
**rooms**. A Rust **daemon** runs Pi agent sessions and serves a WebSocket API plus a
web UI; an Electron **app** connects to it over LAN, Tailscale, or **Hex
Connect**. The native daemon is in `backend/hexbot-core/`, with pinned Pi and
its private extension in `backend/pi-runtime/`. The tiny
`backend/python-handoff/` package hands existing Python background services
over to the native daemon.

Three facts shape most decisions:

- **Rust owns the daemon; Pi runs the agent loop.** New daemon behaviour goes
  in `backend/hexbot-core/`; the private Pi extension adapts tools and events.
  The existing frontend contract stays in `apps/`.
- **Prompt caching is sacred.** A section is one persistent Pi session
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
- **Bot**: a named agent with its own soul, model, skills, and memory. One bot profile with independent Pi conversations managed by the daemon.
- **Section** = **conversation** = **thread**: one persistent chat with a bot or inside a room. A section lives until the user archives or deletes it. Each section is its own Pi session with its own context window.
- **Room**: a group chat with one or more humans and any number of bots. May have a **main bot** that responds when nobody is @-mentioned.
- **Turn**: one user message and everything the bots do in response. The room turn engine (`backend/hexbot-core/src/rooms.rs`) decides who speaks.
- **Soul**: a bot's persona, the `SOUL.md` in its profile. The user and the bot both edit it; the bot says so when it does.
- **Memory**: a bot's own notes, the `MEMORY.md` in its profile. The bot writes it during chat, dreaming curates it, the user can edit it. Deleting a section removes its history and leaves memory alone.
- **About you**: one text per user, written only by the user and read by every bot they own (`users/<id>/user.md`).
- **Dreaming**: a bot's daily pass over that day's conversations that folds what matters into its memory.
- **Auto mode**: the default approval mode. Bots work freely inside the workspace; shell commands run in an OS sandbox with no network, and anything outside the workspace asks first. The daemon calls it `smart`. The other modes are Manual (read-only sandbox, every file change asks) and Bypass (no prompts and no sandbox, admin only; the daemon calls it `off`).
- **Pairing**: connecting an app to a daemon with a one-time code or link over LAN. Never depends on Connect.
- **Hex Connect**: the optional cloud service at connect.hexbot.app (Clerk auth, Cloudflare tunnels) for reaching a daemon from outside the LAN. Brokers identity and a hostname; chat traffic never passes through it.
- **`hermes` identifiers**: some code names keep a `hermes` prefix for compatibility with existing installs: `HERMES_HOME` and other `HERMES_*` variables, `@hermes/shared`, the `hermes_session_at` cookie. Do not rename them. Never write "Hermes" in UI copy, docs, or prompts; the only exceptions are the credits to Hermes Agent in `README.md`, `NOTICE`, the site, and Settings, About.

## Where code lives

| Path | What | Channel |
| --- | --- | --- |
| `backend/hexbot-core/` | Rust daemon, CLI, storage, rooms, tools, scheduling, providers, Connect | all |
| `backend/pi-runtime/` | Pinned Pi runtime and private Hexbot extension | all |
| `backend/python-handoff/` | Minimal service handoff to the native daemon | all |
| `apps/web/` | React bundle (Vite, Tailwind). Used by the app and served to browsers | all |
| `apps/desktop/` | Electron shell, updater, runtime bootstrap, three electron-builder configs: base, full, client | all |
| `apps/shared/` | `@hermes/shared`. `apps/web` imports its gateway client and event types | all |
| `apps/site/` | Astro site at hexbot.app: landing page, docs, pairing page | stable |
| `apps/connect/` | Next.js Connect service at connect.hexbot.app | all |
| `scripts/desktop/` | Version, build, icon, update feed, and cask scripts, each with tests | stable, nightly |
| `scripts/dev/` | `run.mjs` (`pnpm dev`) and the live smoke scripts | dev |
| `.github/workflows/` | `ci.yml` (tests, also called by release), `release.yml` (stable and nightly) | see file |
| `.devcontainer/` | Dev environment | dev |
| `docs/` | Product design, native WebSocket API, testing and operations docs | |
| `skills/` | Skills bundled by the native runtime | all |

`DESIGN.md` is the product design; `docs/channels.md` explains how the three
channels map to files, GitHub, and the update server, and what was borrowed
from T3 Code; `docs/release.md` is the release procedure and one-time setup;
`docs/testing.md` lists every test suite.

## Dev environment

Install once:

```sh
rustup show active-toolchain # installs the toolchain pinned in rust-toolchain.toml
pnpm install --frozen-lockfile
```

The development runner builds Rust and installs locked Pi dependencies.
The handoff tests use their own Python environment, documented in
`docs/testing.md`. The runner always starts the native daemon.

Run Hexbot from the checkout (the Dev channel):

```sh
pnpm dev                # daemon + web bundle; open the printed sign-in link
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

Starting pieces by hand is fine too, with the same rule. In a terminal the
daemon prints a one-time sign-in link for its own port; the dev server
proxies the daemon, so open the same code on the dev server's origin
(`http://localhost:5173/login?code=...`) or run `hexbot pair` for another.
`HEXBOT_WEB_DEV_URL` lets the dev server's origin through:

```sh
HEXBOT_HOME=$(mktemp -d) HEXBOT_WEB_DEV_URL=http://localhost:5173 backend/hexbot-core/target/debug/hexbot serve --port 9119
VITE_HEXBOT_ORIGIN=http://127.0.0.1:9119 pnpm --filter ./apps/web run dev --port 5173 --strictPort
```

Three ways to hurt yourself:

1. **Writing to the live install.** `~/.hexbot` is the developer's real
   daemon state. Use `pnpm dev`, or run daemons with `HEXBOT_HOME` pointing
   at a temp directory. Read and copy from `~/.hexbot` if you need real data;
   never start a server against it.
2. **Killing by pattern.** Do not `pkill -f hexbot` or `pkill -f python`;
   your own agent process may match. Kill only PIDs you started.
3. **Adding daemon work to the handoff package.** Use
   `backend/hexbot-core/` or the private extension in `backend/pi-runtime/`.
   The Python package only transfers existing services to the native daemon.

## Verifying

Run the suite that covers what you touched, not everything:

```sh
cargo test --locked --manifest-path backend/hexbot-core/Cargo.toml
cargo clippy --locked --manifest-path backend/hexbot-core/Cargo.toml --all-targets -- -D warnings
node --test backend/pi-runtime/*.test.mjs
uv sync --project backend/python-handoff --extra dev --locked
backend/python-handoff/.venv/bin/pytest backend/python-handoff/tests -q
pnpm --filter ./apps/web run typecheck && pnpm --filter ./apps/web run test --run && pnpm --filter ./apps/web run lint
pnpm --filter ./apps/desktop run typecheck && pnpm --filter ./apps/desktop run test --run
pnpm --filter ./apps/site run check
pnpm --filter ./apps/connect run typecheck && pnpm --filter ./apps/connect run test --run && pnpm --filter ./apps/connect run lint
node --test scripts/desktop/*.test.mjs scripts/dev/*.test.mjs && node scripts/desktop/release-smoke.mjs
```

`ci.yml` runs all of these on every push and pull request, and `release.yml`
runs it again before building packages.

Backend tests wait on events and RPC replies, never on `sleep`.

## Hit every surface

A change is done when it works in every place the feature appears:

- **Editions**: full and client-only. Anything that needs the daemon runtime
  must go through `requireRuntime` in `apps/desktop/src/main/edition.ts`.
- **Clients**: the Electron app and the browser bundle served by the daemon.
- **Connection modes**: LAN pairing, Tailscale, and Connect.
- **Reverse states**: a toggle needs both directions; archive needs
  unarchive; a revoked device needs to land back on the connect screen.
- **Words**: UI copy uses the glossary. Internal names (`profile`,
  `session`, `smart`) stay internal; UI copy uses the Hexbot word. `docs/`
  and the site docs change in the same PR when behaviour changes.

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
- The version lives in `apps/desktop/package.json`; Rust reads it at build
  time. Set it through `node scripts/desktop/set-version.mjs <version>`.
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
- Complexity belongs at boundaries: the private extension, the WebSocket
  RPC layer, the Electron main process. Components and daemon handlers stay
  plain.
- Users notice dropped frames and stale labels. No continuous repaint
  animations; the bot faces are the one place motion is allowed.
- Copy is short, concrete, and uses glossary words. No "seamless", no
  exclamation marks.

## Daemon reference

Daemon work follows `backend/hexbot-core/README.md`.
