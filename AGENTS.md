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
  toolsets, or rebuild the system prompt mid-conversation. Two exceptions.
  After a compatible section compacts, refresh its prompt only if the next
  provider request starts a new run. This picks up the bot's current name,
  soul, memory, About you, teammates, and skill catalog. If the active run
  resumes first, keep its prompt until another compaction. And because a
  bot's chat never ends, when the bot's tools or connected servers change,
  including when it becomes the primary bot, or an update changes Hexbot's
  own tools, the chat is rebuilt with
  them at its next message (`tools_stale` in `runtime.rs`); that one request
  misses the cache. Rooms, threads between bots, jobs and delegates keep what
  they started with.
- **One product, two packages, three channels.** Full package (app plus
  daemon) and client-only package (app alone) are build-time editions
  (`HEXBOT_EDITION`). The installer offers them as Full and Client, plus
  Headless: the daemon alone from its native archive, which is an install
  option and not an edition. Stable, Nightly, and Dev are release channels
  (`--channel` in `scripts/desktop/dist.mjs`). Never mix editions or install
  options with channels.

## Glossary

Use these words consistently in code, UI copy, docs, and commit messages.

- **Hexbot**: the product. Not "Hexybot". Package and CLI name `hexbot`, home directory `~/.hexbot`.
- **Daemon**: the Hexbot server process (`hexbot serve`) that runs bots, rooms, memory, tools, and serves the WebSocket API and the web UI. A daemon belongs to one person: no invites, roles, or other accounts. One person may run several daemons and switch between them; rooms with other people go through Hex Connect.
- **App**: the Electron desktop shell in `apps/desktop/` hosting the React bundle from `apps/web/`. The same bundle is served by the daemon to LAN browsers.
- **Full package**: the app with a local daemon. **Client-only**: the same app connected to a daemon elsewhere. Together, the two **editions**. The installer and its UI call them **Full** and **Client**.
- **Headless**: the install option for the daemon alone, without the app: the native runtime in `~/.hexbot/runtime`, a launchd or systemd user service (`hexbot service`), and the `hexbot` CLI in `~/.local/bin`. Used from another computer with Client or Full. Not an edition. Internal id `headless`.
- **Installer**: the one installer for Headless, Client, and Full, with two ways in: the terminal installer (`curl -fsSL https://hexbot.app/install.sh | sh`, which runs `hexbot-install`) and the windowed **Hexbot Installer** (.dmg, AppImage). Both use the engine in `backend/hexbot-installer/`, read `install/<track>.json` on the update server, download only the chosen option, and on a second run offer Update or repair, Change, and Uninstall. `~/.hexbot` is kept unless the user asks to delete it.
- **Channel**: how a build is named and published. **Stable** (tagged `v<version>`, updatable; named `Hexbot [alpha]` while the version is `0.x`), **Nightly** (`Hexbot Nightly`, daily from `main`, updatable on its own track), **Dev** (the source tree). See `docs/channels.md`.
- **Track**: the channel an installed app takes updates from, Stable or Nightly. Defaults to the channel the build came from; the user switches it in Settings, Updates.
- **Update server**: `updates.hexbot.app`, a Cloudflare R2 bucket holding every package, the electron-updater feed files, the native daemon archives, and the installers with their `install/<track>.json` manifests. Written only by `release.yml`.
- **Bot**: a named agent with its own soul, model, skills, and memory. One bot profile with independent Pi conversations managed by the daemon.
- **Chat**: your one ongoing conversation with a bot, like a contact in a messaging app. A bot has exactly one chat with you; it never ends, and summarising older messages keeps it going. There is no new chat, archive, or delete; deleting the bot deletes it. Dreams run out of sight and post nothing in it; reports an earlier version posted stay.
- **Primary bot**: the one bot that looks after the others, created by onboarding as **HexBot** (handle `hexbot`, which no other bot may take). In its own chat it can create, change, and delete bots, manage rooms, schedule jobs for any bot, and change settings; deleting anything and changing settings, approval modes, or working folders always ask, even in Bypass. It cannot be deleted. An install from before it adds HexBot or promotes a bot once. Internal column `bots.is_primary`. UI copy says "primary bot", since the user may rename HexBot.
- **Heartbeat**: every bot working through its own checklist, `HEARTBEAT.md` in its profile, every 30 minutes, day and night, without reading its chat. The user writes the checklist, and the bot keeps it from its chat. It posts in the bot's chat only when something needs the user, with a notification on their app, browser, and phone. A heartbeat runs unattended like a scheduled job and only reads; an empty checklist runs nothing. It replaced the primary bot's check-ins and wake-ups; an earlier **Check-ins** conversation stays until the user deletes it. Internal names `heartbeat`, `hexbot_heartbeat`, `hexbot_notify`.
- **Section** = **conversation** = **thread**: the daemon's name for one persistent Pi session with its own context window: a bot's chat, a room conversation, or a thread in which one bot asks another for help. UI copy says chat, room, or conversation, not section.
- **Room**: a group chat with one or more humans and any number of bots. May have a **main bot** that responds when nobody is @-mentioned.
- **Turn**: one user message and everything the bots do in response. The room turn engine (`backend/hexbot-core/src/rooms.rs`) decides who speaks.
- **Soul**: a bot's persona, the `SOUL.md` in its profile. The user and the bot both edit it; the bot says so when it does.
- **Visual**: an interactive HTML page (chart, table, diagram, mockup) a bot shows in its chat with `hexbot_show_html`. It sits in a bubble above the bot's final reply, in a sandboxed frame, and can open beside the chat as a tab. Not available in rooms.
- **Plugin**: anything a bot can use beyond its own tools, all in Settings, Plugins, where the user chooses the bots that get each one: a **connector** (a service Hexbot supports, such as web search or Notion, set up with a key), an **MCP server** (one the user or a bot adds), a **skill**, or a built-in tool that needs a program (Computer use, Browser, Code execution; internally a capability). A **plugin package** installs an MCP server with the skills that explain it, or several skills, as one, in `~/.hexbot/plugins/<name>/`. A bot asks for a plugin with `hexbot_plugins`; installing or turning one on always asks the user, even in Bypass, and puts it on for that bot only. The primary bot can do the same for any bot from its own chat and remove packages. Internal names `plugins.rs`, `hexbot.plugins.*`.
- **Passwords**: the sign-ins a user saves for their bots, in Settings, Passwords, kept in one KeePass (KDBX 4) vault per user, `users/<id>/passwords/passwords.kdbx`, whose key is in the OS keychain or an owner-only key file. A bot lists the logins it may use and has the daemon type one into a page with `hexbot_passwords`; it never sees a password. When none fits, it shows a **sign-in card** in its chat, and what the user types there is saved for every bot. The user, or the primary bot from its own chat, chooses which bots get each login. Internal names `passwords.rs`, `runtime_passwords.rs`, `hexbot.passwords.*`.
- **Notes**: a bot's daily record in `memories/notes/YYYY-MM-DD.md`. The bot appends during conversations; dreaming folds what lasts into memory. The user can edit or delete a day. Days older than 30 days are removed when notes are read, listed, appended, or a dream runs.
- **Memory**: a bot's durable facts, preferences, and lessons, the `MEMORY.md` in its profile. The bot writes it during chat, dreaming curates it, the user can edit it.
- **About you**: one text per user, written only by the user and read by every bot they own (`users/<id>/user.md`).
- **Dreaming**: a bot's daily pass over recent notes and conversations that folds what matters into its memory.
- **Auto mode**: the default approval mode. Bots work freely inside the workspace; shell commands run in an OS sandbox with no network. A step outside it is reviewed by the bot's model first: routine steps run, risky or unreviewable ones ask the user for that step. The review is a model judgment, not containment (`SECURITY.md`, `DESIGN.md`). The daemon calls it `smart`. The other modes are Manual (read-only sandbox, every file change asks) and Bypass (no prompts and no sandbox; the daemon calls it `off`).
- **Pairing**: connecting an app to a daemon with a one-time code or link over LAN. Never depends on Connect.
- **Hex Connect**: the optional cloud service at connect.hexbot.app (Clerk auth, Cloudflare tunnels) for reaching a daemon from outside the LAN. Brokers identity and a hostname; chat traffic never passes through it.
- **`hermes` identifiers**: some code names keep a `hermes` prefix for compatibility with existing installs: `HERMES_HOME` and other `HERMES_*` variables, `@hermes/shared`, the `hermes_session_at` cookie. Do not rename them. Never write "Hermes" in UI copy, docs, or prompts; the only exceptions are the credits to Hermes Agent in `README.md`, `NOTICE`, the site, and Settings, About.

## Where code lives

| Path | What | Channel |
| --- | --- | --- |
| `backend/hexbot-core/` | Rust daemon, CLI, storage, rooms, tools, scheduling, providers, Connect | all |
| `backend/pi-runtime/` | Pinned Pi runtime and private Hexbot extension | all |
| `backend/python-handoff/` | Minimal service handoff to the native daemon | all |
| `backend/hexbot-installer/` | Installer engine (standalone crate) and the terminal installer `hexbot-install` | stable, nightly |
| `apps/web/` | React bundle (Vite, Tailwind). Used by the app and served to browsers | all |
| `apps/mobile/` | Expo app for iOS and Android, connecting to an existing daemon | all |
| `apps/desktop/` | Electron shell, updater, runtime bootstrap, three electron-builder configs: base, full, client | all |
| `apps/installer/` | Hexbot Installer, the windowed installer (Tauri) on the installer engine | stable, nightly |
| `apps/shared/` | `@hermes/shared`. `apps/web` imports its gateway client and event types | all |
| `apps/site/` | Astro site at hexbot.app: landing page, docs, pairing page, `install.sh` | stable |
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
cargo test --locked --manifest-path backend/hexbot-installer/Cargo.toml
cargo clippy --locked --manifest-path backend/hexbot-installer/Cargo.toml --all-targets -- -D warnings
node --test backend/pi-runtime/*.test.mjs
uv sync --project backend/python-handoff --extra dev --locked
backend/python-handoff/.venv/bin/pytest backend/python-handoff/tests -q
pnpm mobile:check
pnpm --filter ./apps/web run typecheck && pnpm --filter ./apps/web run test --run && pnpm --filter ./apps/web run lint
pnpm --filter ./apps/desktop run typecheck && pnpm --filter ./apps/desktop run test --run
pnpm --filter ./apps/installer run typecheck && pnpm --filter ./apps/installer run test --run && pnpm --filter ./apps/installer run lint
cargo test --locked --manifest-path apps/installer/src-tauri/Cargo.toml
cargo clippy --locked --manifest-path apps/installer/src-tauri/Cargo.toml --all-targets -- -D warnings
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
- **Install options**: Full, Client, and Headless. A daemon feature that a
  user sets up in the app must also be reachable from a paired app or the
  `hexbot` CLI when no app runs on the daemon's computer.
- **Clients**: the Electron app, the browser bundle served by the daemon,
  and the mobile app in `apps/mobile` (iOS and Android). A change a user can
  see or use in `apps/web` lands in `apps/mobile` in the same PR, or the PR
  says why it is desktop-only. The mobile app reuses the wire types in
  `apps/web/src/lib/types.ts` and talks to the daemon through
  `apps/mobile/src/core/useMobile.ts`; it shares no components, so port the
  behaviour, not the markup. Run `pnpm mobile:check`, and the mobile smoke
  test when navigation or a flow changes (`docs/testing.md`, "Mobile").
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
- The mobile app is a messaging app. One list holds every bot's chat, every
  room, newest first, with the primary bot pinned. Settings
  sit behind your initials at the top left, new bots and rooms behind +,
  and every bot's profile, scheduled jobs and all rooms behind the grid
  button next to Search. There are no tabs. A new feature finds its place
  in one of these; it does not add a tab or a home-screen section.

## Cursor Cloud specific instructions

`pnpm dev` starts on boot in tmux session `hexbot-dev`. Read
`/tmp/hexbot-dev/dev.log` for the daemon port, the web port, and a one-time
sign-in link. The code expires in 10 minutes. The log's `hexbot pair` line
mints another. Vite listens on localhost (`::1`), not `127.0.0.1`.

Node 26.5.0 is linked ahead of the image's Node 22.14, which `engines`
rejects. Ubuntu 24.04 has no `python3.11` package; uv installs CPython 3.11.

## Daemon reference

Daemon work follows `backend/hexbot-core/README.md`.
