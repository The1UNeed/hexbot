# Testing

## Hexbot suites

- Python: `./venv/bin/pytest tests/hexbot -q`
- Web bundle: `pnpm --filter ./apps/web run typecheck && pnpm --filter ./apps/web run test --run && pnpm --filter ./apps/web run lint && pnpm --filter ./apps/web run build`
- Desktop: `pnpm --filter ./apps/desktop run typecheck && pnpm --filter ./apps/desktop run test --run && pnpm --filter ./apps/desktop run build`
- Packaging and release scripts: `node --test scripts/desktop/*.test.mjs scripts/dev/*.test.mjs && node scripts/desktop/release-smoke.mjs`
- Site: `pnpm --filter ./apps/site run check`
- Connect (unit): `pnpm --filter ./apps/connect run typecheck && pnpm --filter ./apps/connect run test --run`
- End to end: `pnpm --filter ./apps/desktop run e2e` (Playwright driving the built Electron app against a daemon in a temp home).
- Connect: `HEXBOT_CONNECT_E2E=1 ./venv/bin/pytest tests/hexbot/test_connect_e2e.py -q` (a real Connect service with the in-memory store, a real daemon, and the CLI, web, and desktop HTTP calls; no Cloudflare).

## Upstream Hermes suites

Run the suites that cover the seams Hexbot edits (see `CORE_EDITS.md`):

```
./venv/bin/pytest tests/plugins tests/test_plugins_manage_profile_scope.py \
  tests/tui_gateway/test_groups_methods.py tests/tui_gateway/test_hosted_room_server_rpc.py \
  tests/tui_gateway/test_bot_relay_methods.py -q -p no:cacheprovider
./venv/bin/pytest tests/agent/test_opencode_session_affinity.py -q -p no:cacheprovider
```

Run the affinity test on its own: it builds a real `AIAgent`, which leaks
state into the `tests/hexbot` fakes when both run in one process.

Baseline on 2026-09-03 at the import commit, with the venv built by
`uv sync --extra all --locked`: 1773 passed, 5 skipped, 16 failed. The
failures are pre-existing and identical on pristine upstream v0.21.0 in this
environment: `tests/plugins/memory/test_hindsight_provider.py` (missing
optional module `hindsight_client_api`),
`tests/plugins/memory/test_openviking_optional_peer.py`,
`tests/plugins/video_gen/test_fal_plugin.py` (optional fal client), and one
order-dependent case in `tests/plugins/test_a2a_plugin.py` that passes in
isolation. Treat any new failure outside that list as a regression.

## Dev daemon

`pnpm dev` starts a daemon and the web bundle from the checkout with
`HEXBOT_HOME=<checkout>/.hexbot` (gitignored) and ports derived from the
checkout path, so worktrees do not collide. `pnpm dev --desktop` starts
the Electron app instead. The smoke scripts below take the printed daemon
port. Never point a dev daemon at `~/.hexbot`.

## Real-model checks

The `openai-codex` provider works on a machine with a Codex CLI login. To
seed a temporary home for manual or end-to-end runs:

```
export HEXBOT_HOME=$(mktemp -d)
HERMES_HOME=$HEXBOT_HOME ./venv/bin/python -c \
  "from hermes_cli import auth; auth._save_codex_tokens(auth._import_codex_cli_tokens())"
./venv/bin/hexbot serve --port 9131
```

## Desktop end-to-end smoke test

Build the Electron app, then run its Playwright test against a temporary daemon:

```bash
pnpm desktop:build
pnpm desktop:e2e
```

The test imports Codex CLI OAuth tokens into a temporary daemon home, creates the `scout`
bot with `openai-codex` and `gpt-5.6-sol`, sends a real prompt, and creates a second section.
It requires a working Codex CLI login. `HEXBOT_E2E_TARGET` is exposed by
`apps/desktop/src/preload/index.ts`; `apps/web/src/stores/connection.ts` adopts it only when no
connection target is stored.

## Live smoke scripts

All of these need a Codex CLI login on the machine (see "Real-model checks").

- `scripts/dev/pairing_smoke.sh`: LAN-gated daemon, pairing code, cookie login, bearer ticket, revoke.
- `scripts/dev/multiuser_smoke.sh`: admin pairing, invite, member pairing, ownership filtering, admin-only refusal.
- `scripts/dev/rooms_smoke.py --url ws://127.0.0.1:<port>/api/ws?token=<t> --token <t>`: two bots in a room with a main bot, one human message, prints the room log.
- `scripts/dev/dream_smoke.py` (same flags): creates a bot, chats, runs a dream now, prints the memory notes and the Dreams section.
- `scripts/dev/rpc.py <port> '<calls json>'`: ad-hoc JSON-RPC calls against a loopback daemon.
- `scripts/dev/ui-review.mjs`, `ui-review-app.mjs`, `ui-shot.mjs`, `ui-error.mjs`, `ui-room-chat.mjs`: Playwright helpers that drive the daemon-served web bundle in Chromium and write screenshots to `/tmp/hexbot-shots`.
