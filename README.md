# Hexbot [alpha]

Self-hosted bots with faces, names, and a memory of their own.

Hexbot is a desktop app and a background daemon. You create **bots**, each
with its own persona, model, skills, and memory. You talk to a bot in a
**section** (a persistent conversation), or put several bots and people in a
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

Each channel comes in two packages for macOS (Apple Silicon and Intel) and
Linux (AppImage and deb):

- **Full package** (`Hexbot`): the app plus the daemon. Install where your
  bots should live.
- **Client only** (`Hexbot Client`): the app alone. Install on any other
  computer and pair it with a full package.

Stable and Nightly share `~/.hexbot`. Back it up before opening a nightly.
The app follows the track it was installed from; switch in Settings, Updates.
`docs/channels.md` has the full matrix.

## What it does

- **Bots with memory.** Each bot has a soul, its own memory, and a searchable
  history of its conversations. A daily **dreaming** pass tidies the memory.
  One **About you** text, written by you, reaches every bot you own.
- **Rooms.** Group chats with any number of bots and people. A **main bot**
  answers when nobody is @-mentioned; bots can address each other.
- **Any model.** Bring keys for OpenAI, Anthropic, Google, OpenRouter, local
  servers, and more. Pick a model per bot.
- **Tools with approvals.** Bots can run commands, browse, and edit files.
  Manual approval by default; **Auto mode** lets a small model approve
  low-risk actions.
- **Your hardware.** The daemon runs where you install it. Pair devices over
  LAN or Tailscale, revoke them from settings, and delete conversations
  together with the memory they produced.
- **Hex Connect.** Sign in once, reach your daemon from outside the LAN.
  Connect brokers identity and a hostname; chat traffic never passes through
  it.

Docs live at [hexbot.app/docs](https://hexbot.app/docs/) and are built from
`apps/site/`.

## Develop

Hexbot is a hard fork of [Hermes Agent](https://github.com/NousResearch/hermes-agent).
The Hermes core sits at the repository root; Hexbot's code sits in `hexbot/`
(Python daemon extensions) and `apps/` (web bundle, Electron app, site,
Connect). `AGENTS.md` is the guide for anyone, human or agent, working on the
code. `CORE_EDITS.md` lists every change to imported Hermes files.

Fastest start: open the repository in the dev container (`.devcontainer/`),
which installs everything. By hand:

```sh
uv venv venv --python 3.11 && UV_PROJECT_ENVIRONMENT=venv uv sync --extra all --extra dev --locked
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
./venv/bin/pytest tests/hexbot -q
pnpm --filter ./apps/web run typecheck && pnpm --filter ./apps/web run test --run && pnpm --filter ./apps/web run lint
pnpm --filter ./apps/desktop run typecheck && pnpm --filter ./apps/desktop run test --run
node --test scripts/desktop/*.test.mjs scripts/dev/*.test.mjs
pnpm --filter ./apps/site run check
pnpm --filter ./apps/connect run typecheck && pnpm --filter ./apps/connect run test --run
```

`docs/testing.md` lists everything, including the upstream Hermes suites and
the Electron end-to-end test.

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
rooms and the turn engine, dreaming, multi-user, and packaging. The first
public alpha waits on Apple signing credentials and the Connect production
accounts (Clerk, Neon, Cloudflare). Until then hexbot.app/download offers
the current nightly and says stable is coming soon.

## License

AGPL-3.0. See `LICENSE` and `NOTICE`. Hermes Agent is MIT licensed; its
license is in `docs/upstream/HERMES_LICENSE.txt`.
