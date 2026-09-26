# Hexbot

@AGENTS.md

## Notes for Claude Code

- The glossary, layout, dev commands, and channel rules above are the source
  of truth. `DESIGN.md` explains why; `docs/channels.md` explains Stable,
  Nightly, and Dev and what was borrowed from T3 Code; `docs/release.md` is
  the release procedure.
- Put product behaviour in a `hexbot/` module, a core plugin hook, or
  `apps/`. Change the core at the repository root when the fix belongs
  there, and read `docs/core/development.md` first.
- Run Hexbot from the checkout with `pnpm dev` (state in
  `<checkout>/.hexbot`). If you start a daemon by hand, set `HEXBOT_HOME` to a
  temp directory. Never point a dev daemon at `~/.hexbot`.
- Never push a `v*` tag or dispatch the Release workflow unless asked; both
  publish real builds.
- Run only the suites that cover the files you changed (see "Verifying").
- Commit only when asked. Use the commit and PR attribution given by the
  session.
