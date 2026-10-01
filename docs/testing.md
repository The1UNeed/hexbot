# Testing

## Hexbot suites

- Rust daemon: `cargo test --locked --manifest-path backend/hexbot-core/Cargo.toml`
  and `cargo clippy --locked --manifest-path backend/hexbot-core/Cargo.toml --all-targets -- -D warnings`.
  Node and Python 3 are needed by subprocess/database comparison fixtures.
  Database upgrades are compared with the original Python implementation in
  temporary homes. Local HTTP/SSE/MCP fixtures test provider/tool behavior.
  Actual Pi and unchanged-browser checks are documented in
  [`backend/hexbot-core/README.md`](../backend/hexbot-core/README.md).
- Pi runtime: `node --test backend/pi-runtime/*.test.mjs` after `npm ci --prefix backend/pi-runtime --ignore-scripts --no-audit --no-fund`. CI runs every test file and the Rust suite on Linux and macOS.
- Native browser end to end: `node scripts/dev/native-ui-smoke.mjs` after building
  Rust and the web bundle and installing the locked Pi dependency and Chromium.
  Uses a local streaming model with actual Pi; no provider credentials needed.
  Add `--desktop --edition=full` or `--desktop --edition=client` for Electron.
  On headless Linux run these Electron checks through `xvfb-run -a`.
- Legacy Python: `./venv/bin/pytest tests/hexbot -q` (the Connect tests also run the Node sidecar; they skip without `node`)
- Connect sidecar: `node --test tests/hexbot/*.test.mts`
- Legacy service handoff: `python3 -m unittest tests/hexbot/test_native_transition.py -v`
  (also included in the Python suite). Uses temporary homes and local archives to
  check the old service's upgrade, native restart, service migration,
  checksums, archive limits, failure recovery, and preservation of existing data.
- Web bundle: `pnpm --filter ./apps/web run typecheck && pnpm --filter ./apps/web run test --run && pnpm --filter ./apps/web run lint && pnpm --filter ./apps/web run build`
- Desktop: `pnpm --filter ./apps/desktop run typecheck && pnpm --filter ./apps/desktop run test --run && pnpm --filter ./apps/desktop run build`
- Packaging and release scripts: `node --test scripts/desktop/*.test.mjs scripts/dev/*.test.mjs && node scripts/desktop/release-smoke.mjs`
- Site: `pnpm --filter ./apps/site run check`
- Connect (unit): `pnpm --filter ./apps/connect run typecheck && pnpm --filter ./apps/connect run test --run && pnpm --filter ./apps/connect run lint`
- Legacy desktop end to end: `pnpm --filter ./apps/desktop run e2e` (Playwright driving the built Electron app against the retained Python daemon in a temp home). Native Electron coverage uses `native-ui-smoke.mjs` above.
- Legacy Connect end to end: `HEXBOT_CONNECT_E2E=1 ./venv/bin/pytest tests/hexbot/test_connect_e2e.py -q` (a real Connect service with the in-memory store, the retained Python daemon, and the CLI, web, desktop, and browser sign-in HTTP calls; no Cloudflare).

## Legacy core suites

Install the retained Python environment before running comparison or legacy tests:

```sh
uv venv venv --python 3.11
UV_PROJECT_ENVIRONMENT=venv uv sync --extra all --extra dev --locked
```

Run these when you change the core at the repository root, plus the
suites under `tests/` that cover the files you touched:

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
failures are pre-existing and identical on the unmodified v0.21.0 import in
this environment: `tests/plugins/memory/test_hindsight_provider.py` (missing
optional module `hindsight_client_api`),
`tests/plugins/memory/test_openviking_optional_peer.py`,
`tests/plugins/video_gen/test_fal_plugin.py` (optional fal client), and one
order-dependent case in `tests/plugins/test_a2a_plugin.py` that passes in
isolation. Treat any new failure outside that list as a regression.

These suites pin the universal system prompt text and must stay green:

```
./venv/bin/pytest tests/agent/test_system_prompt.py tests/agent/test_prompt_builder.py \
  tests/run_agent/test_steer.py tests/agent/test_bot_profile_prompt_isolation.py \
  tests/agent/test_profile_home_override_precedence.py tests/agent/test_phantom_tool_references.py \
  tests/tools/test_cross_profile_guard.py -q -p no:cacheprovider
```

## Dev daemon

`pnpm dev` starts a daemon and the web bundle from the checkout with
`HEXBOT_HOME=<checkout>/.hexbot` (gitignored) and ports derived from the
checkout path, so worktrees do not collide. `pnpm dev --desktop` starts
the Electron app instead. The smoke scripts below take the printed daemon
port. Never point a dev daemon at `~/.hexbot`. The runner reinstalls locked Pi
dependencies when the lockfile changes and installs the desktop's pinned,
checksum-verified ripgrep and fd into the dev home's `bin` directory before
starting either the daemon or the app. It no longer accepts
`--backend`; legacy comparison tests use their own Python fixtures.

## Legacy Python real-model checks

The `openai-codex` provider works on a machine with a Codex CLI login. To
seed a temporary home for manual or end-to-end runs:

```
export HEXBOT_HOME=$(mktemp -d)
HERMES_HOME=$HEXBOT_HOME ./venv/bin/python -c \
  "from hermes_cli import auth; auth._save_codex_tokens(auth._import_codex_cli_tokens())"
./venv/bin/hexbot serve --port 9131
```

## Legacy desktop end-to-end smoke test

Build the Electron app, then run its retained Playwright test against a temporary
Python daemon. This requires the legacy Python environment above. Use
`native-ui-smoke.mjs` for the shipped Rust daemon:

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
- `HEXBOT_HOME=<home> python3 scripts/dev/rpc.py <port> '<calls json>'`: ad-hoc JSON-RPC calls against a loopback daemon.
- `scripts/dev/ui-review.mjs`, `ui-review-app.mjs`, `ui-shot.mjs`, `ui-error.mjs`, `ui-room-chat.mjs`: Playwright helpers that drive the daemon-served web bundle in Chromium and write screenshots to `/tmp/hexbot-shots`. Set `HEXBOT_HOME=<home>` to sign in using the local device token.

## Packaged runtime checks

`rust-toolchain.toml` is the only Rust toolchain pin. Run `rustup show
active-toolchain` from the checkout to install it before building. Native staging
uses an explicit Cargo target and installs npm dependencies for that OS and CPU.
On Apple Silicon, `rustup target add x86_64-apple-darwin` enables the Intel build;
Rosetta is required to run its packaged Node probe.

```sh
pnpm --filter ./apps/web run build
node scripts/desktop/stage-runtime.mjs
HEXBOT_NATIVE_TEST_BUNDLE="$PWD/apps/desktop/resources/hexbot-native" \
  pnpm --filter ./apps/desktop run test --run src/main/backend/native-bootstrap.test.ts
```

CI also runs live extension and permission tests through the staged launcher, including
its pruned dependencies:

```sh
HEXBOT_TEST_PI="$PWD/apps/desktop/resources/hexbot-native/pi/hexbot-pi" \
  cargo test --locked --manifest-path backend/hexbot-core/Cargo.toml --test runtime -- --ignored
```

After packaging on macOS, verify the app and native executables with their shipped
signatures. The check launches both editions, exercises Node's JIT and checks that
a self-update archive preserves the full package's runtime bytes and signatures.
It also compares bundled executable minimum macOS versions with the packaged
app's minimum, on both release architectures:

```sh
HEXBOT_PACKAGED_TEST_DIR="$PWD/apps/desktop/release" \
  node --test scripts/desktop/runtime-signing.test.mjs
```

Staging reports dependency bytes before and after pruning. The installed-runtime
test uses a temporary home and checks the launcher, agent runtime, daemon HTTP
listener, managed Python and voice executable. Desktop unit tests cover bad uv
checksums, consecutive updates, failed activation, running-runtime retention and
service migration. Rust tests cover update pruning and legacy listener refusal.
