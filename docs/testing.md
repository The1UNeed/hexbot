# Testing

## Native product suites

- Rust daemon: `cargo test --locked --manifest-path backend/hexbot-core/Cargo.toml`
  and `cargo clippy --locked --manifest-path backend/hexbot-core/Cargo.toml --all-targets -- -D warnings`.
  Node and Python 3 are needed by subprocess fixtures. Database upgrades use
  captured legacy schema fixtures in temporary homes. Local HTTP/SSE/MCP
  fixtures test provider and tool behavior. Actual Pi checks are documented
  in [`backend/hexbot-core/README.md`](../backend/hexbot-core/README.md).
- Pi runtime: `node --test backend/pi-runtime/*.test.mjs` after
  `npm ci --prefix backend/pi-runtime --ignore-scripts --no-audit --no-fund`.
  CI runs the Rust and Pi suites on Linux and macOS. Approval tests use a stub
  sandbox; isolation tests use `sandbox-exec` on macOS and working bubblewrap
  on Linux. CI installs bubblewrap with the AppArmor profile from the install docs.
  macOS tests check that Auto and Manual deny IPv4 and IPv6 TCP/UDP listeners,
  while approved full-access commands can still listen. Dummy secret/browser
  fixtures exercise rename, unlink and append denial, ancestor renames, linked
  `gitdir`/`commondir` targets from both Git directory and file markers,
  configured hooks in ignored directories and config includes, bare `*.git`
  repositories, dangling `.env` links, and ordinary writes in `project.git`
  workspaces. Large-workspace tests cover file-tool writes/edits and macOS
  commands after the scan budget is reached. Incomplete scans ask before file
  changes; cache-marker `.git` files stay locked without failing the scan.
  Rust/TypeScript parity checks compare both profiles and Linux argument lists.
  Linux argument tests run on either platform and cover Manual read-only roots,
  secret symlinks, breadth-first scan order and Linux-only budget refusal. Linux
  execution runs in Ubuntu CI; macOS cannot validate the bubblewrap kernel
  boundary. The Linux `execute_code` regression checks its scan-budget recovery
  guidance and that a smaller workspace can run the code.
  Scheduled-script tests verify that Manual cannot write artifacts. Run
  `cargo fmt --manifest-path backend/hexbot-core/Cargo.toml --check` too.
  See [sandbox behavior and limits](../SECURITY.md#tool-isolation): Linux protects
  only existing repositories within the bounded scan; repositories created
  during a command remain unprotected. macOS filename rules cover new `.git`
  metadata directories.
- Native browser end to end: `node scripts/dev/native-ui-smoke.mjs` after building
  Rust and the web bundle and installing the locked Pi dependency and Chromium.
  Uses a local streaming model with actual Pi; no provider credentials needed.
  Add `--desktop --edition=full` or `--desktop --edition=client` for Electron.
  On headless Linux run these Electron checks through `xvfb-run -a`.
- Web bundle: `pnpm --filter ./apps/web run typecheck && pnpm --filter ./apps/web run test --run && pnpm --filter ./apps/web run lint && pnpm --filter ./apps/web run build`.
- Desktop: `pnpm --filter ./apps/desktop run typecheck && pnpm --filter ./apps/desktop run test --run && pnpm --filter ./apps/desktop run build`.
- Packaging and release scripts: `node --test scripts/desktop/*.test.mjs scripts/dev/*.test.mjs && node scripts/desktop/release-smoke.mjs`.
- Site: `pnpm --filter ./apps/site run check`.
- Connect: `pnpm --filter ./apps/connect run typecheck && pnpm --filter ./apps/connect run test --run && pnpm --filter ./apps/connect run lint`.

## Installer

Run `cargo test --locked --manifest-path backend/hexbot-installer/Cargo.toml`
and `cargo clippy --locked --manifest-path backend/hexbot-installer/Cargo.toml --all-targets -- -D warnings`.
The engine tests use temporary homes and `HEXBOT_SERVICE_NO_LOAD=1`. They cover
foreign service ownership, runtime files without a Headless install, LAN
preservation on repair, macOS app recovery, and status failures after setup.
The bootstrap suite exercises curl and wget track selection. Only a Stable
manifest 404 permits a Nightly fallback.

For the windowed installer, run
`cargo test --locked --manifest-path apps/installer/src-tauri/Cargo.toml`
and `cargo clippy --locked --manifest-path apps/installer/src-tauri/Cargo.toml --all-targets -- -D warnings`, then
`pnpm --filter ./apps/installer run typecheck && pnpm --filter ./apps/installer run test --run && pnpm --filter ./apps/installer run lint && pnpm --filter ./apps/installer run build`.
These cover the busy guard, daemon files opening on Welcome, service removal
before download, and the deliberate retry action after a failed uninstall.

## Service handoff

`backend/python-handoff/` is the service handoff for installed
Python background services. It contains no daemon or runtime dependencies.

```sh
cd backend/python-handoff
uv venv --python 3.11
uv sync --extra dev --locked
.venv/bin/pytest tests -q
```

Tests use temporary homes and local archives to check native activation,
historical module restart, service migration, checksums, archive limits,
failure recovery, preservation of existing data, and CLI home defaults.
The release archive also accepts `uv sync --extra all --locked`, as required
by the installed old updater. A failed native version probe exits non-zero,
so that updater reports failure without restarting the running old daemon.

## Dev daemon

`pnpm dev` starts the native daemon and web bundle with state in this checkout's
`.hexbot` and ports derived from its path. `pnpm dev --desktop` starts Electron.
Never point a dev daemon at `~/.hexbot`. The runner installs locked Pi
dependencies and checksum-verified ripgrep and fd in the dev home's `bin`.

## Desktop test with a real model

```sh
cargo build --locked --manifest-path backend/hexbot-core/Cargo.toml --bin hexbot
npm ci --prefix backend/pi-runtime --ignore-scripts --no-audit --no-fund
pnpm desktop:build
pnpm desktop:e2e
```

This Playwright test starts the native daemon in a temporary home, imports
Codex CLI OAuth tokens into that home, creates a bot, sends a real prompt,
and creates a second section. It requires a working Codex CLI login.
`native-ui-smoke.mjs` above provides coverage without provider credentials.

## Live smoke helpers

These Python helpers only speak WebSocket to the running native daemon; they
need no Python core or repository venv. Run them with a standalone dependency:

```sh
uv run --no-project --with websockets python scripts/dev/rooms_smoke.py --url 'ws://127.0.0.1:<port>/api/ws' --token '<t>'
uv run --no-project --with websockets python scripts/dev/dream_smoke.py --url 'ws://127.0.0.1:<port>/api/ws' --token '<t>'
HEXBOT_HOME=<home> uv run --no-project --with websockets python scripts/dev/rpc.py <port> '<calls json>'
```

The rooms and dreaming checks need configured model credentials on the daemon.
The RPC helper reads the selected home's private local device token.
`scripts/dev/ui-review.mjs`, `ui-review-app.mjs`, `ui-shot.mjs`, `ui-error.mjs`,
and `ui-room-chat.mjs` drive the daemon-served web bundle in Chromium and write
screenshots to `/tmp/hexbot-shots`. Set `HEXBOT_HOME=<home>` for local sign-in.

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

### Connected tools through Pi

`node --test backend/pi-runtime/*.test.mjs` includes `mcp.test.mjs`, which runs
real Pi 1.0.1 against a local streaming model fixture and stdio server. It checks
first-call connection, nested approval enforcement, literal credential values,
untrusted workspace config, and stable provider prompt/tool declarations across
turns. No provider account is needed. Rust tests cover frozen names, restricted
and legacy sections, probe counts, SSE compatibility, and warning events.

`node scripts/dev/mcp-smoke.mjs` runs `pnpm dev` with disposable state, configures
a bot and connected servers by RPC, and exercises the browser with a local model
fixture. Set `HEXBOT_SMOKE_ARTIFACTS` to choose where its screenshots and proof
files go. It checks daemon-owned cwd, revocation after removal and disable,
credential changes in an open section, Manual approval for read-only tools, and
nested steps before and after reload in light and dark themes.
