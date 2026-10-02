# Hexbot

@AGENTS.md

## Notes for Claude Code

- The glossary, layout, dev commands, and channel rules above are the source
  of truth. `DESIGN.md` explains why; `docs/channels.md` explains Stable,
  Nightly, and Dev and what was borrowed from T3 Code; `docs/release.md` is
  the release procedure.
- Put daemon behaviour in `backend/hexbot-core/` or the private extension in
  `backend/pi-runtime/`. Client code lives in `apps/`.
  `backend/python-handoff/` is only the service handoff.
- Run Hexbot from the checkout with `pnpm dev` (state in
  `<checkout>/.hexbot`). If you start a daemon by hand, set `HEXBOT_HOME` to a
  temp directory. Never point a dev daemon at `~/.hexbot`.
- Never push a `v*` tag or dispatch the Release workflow unless asked; both
  publish real builds.
- Run only the suites that cover the files you changed (see "Verifying").
- Commit only when asked. Use the commit and PR attribution given by the
  session.
