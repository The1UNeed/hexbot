# Hexbot

Self-hosted multi-agent desktop app. Named bots on any model provider, each
with its own memory and skills, talking to you and to each other in rooms.
Runs on your machine or a box on your LAN; the desktop app pairs with it by
code.

Two packages are built from this repository: the **full package** (`Hexbot`,
the app plus the daemon runtime) and the **client-only package**
(`Hexbot Client`, the app alone, which connects to a full package elsewhere).

Hexbot is a hard fork of [Hermes Agent](https://github.com/NousResearch/hermes-agent)
(see `NOTICE` and `docs/upstream/`). Design: `DESIGN.md`. Words: `CLAUDE.md`.

## Status

Built on 2026-09-03 from the design in `DESIGN.md`. What runs today:

- Milestone 1: the daemon (`hexbot serve`), pairing over LAN, the desktop app on
  macOS and Linux, sections, attachments, core and section memory, approvals,
  the web bundle served to LAN browsers, signed-or-ad-hoc builds, the update
  feed scripts, unit tests, and an Electron end-to-end test.
- Milestone 2: Connect, daemon side (registration, tunnel supervision, grant
  login) and the Connect API app in `apps/connect` with an in-memory store.
- Milestone 3: rooms with the Hexbot turn engine, bot-to-bot messages, the
  activity view, bot templates, per-bot tools and skills.
- Milestone 4: dreaming, room memory, memory tagging and purge, the activity
  graph, the computer tab.
- Milestone 5: users, invites, ownership, shareable bots, budgets, usage.
- Milestone 6: Homebrew cask, deb metadata, beta channel,
  opt-in crash reports, release docs.

Not done on the build machine because it needs accounts or hardware that are
not there: Apple signing and notarization, deploying `apps/site` and
`apps/connect` to Vercel with Clerk, Neon and Cloudflare credentials, DNS for
hexbot.app, and a test on a second physical machine over
LAN or Tailscale. `docs/release.md` lists the steps.

## Layout

- Root: the Hermes Python core (daemon, tools, memory, providers, plugins).
- `hexbot/`: Hexbot's Python package (CLI, pairing, bots, sections, memory,
  WebSocket extensions).
- `apps/web/`: the React bundle used by the desktop app and served to LAN
  browsers by the daemon.
- `apps/desktop/`: the Electron shell. `electron-builder.yml` builds the full
  package; `electron-builder.client.yml` builds the client-only package.

## License

AGPL-3.0. See `LICENSE` and `NOTICE`.
