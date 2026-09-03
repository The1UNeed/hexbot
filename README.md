# Hexbot

Self-hosted multi-agent desktop app. Named bots on any model provider, each
with its own memory and skills, talking to you and to each other in rooms.
Runs on your machine or a box on your LAN; the desktop app pairs with it by
code.

Hexbot is a hard fork of [Hermes Agent](https://github.com/NousResearch/hermes-agent)
(see `NOTICE` and `docs/upstream/`). Design: `DESIGN.md`. Words: `CLAUDE.md`.

## Layout

- Root: the Hermes Python core (daemon, tools, memory, providers, plugins).
- `hexbot/`: Hexbot's Python package (CLI, pairing, bots, sections, memory,
  WebSocket extensions).
- `apps/web/`: the React bundle used by the desktop app and served to LAN
  browsers by the daemon.
- `apps/desktop/`: the Electron shell.

## License

AGPL-3.0. See `LICENSE` and `NOTICE`.
