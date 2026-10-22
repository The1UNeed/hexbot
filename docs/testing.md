# Testing

## Native product suites

- Rust daemon: `cargo test --locked --manifest-path backend/hexbot-core/Cargo.toml`
  and `cargo clippy --locked --manifest-path backend/hexbot-core/Cargo.toml --all-targets -- -D warnings`.
  Node and Python 3 are needed by subprocess fixtures. Database upgrades use
  captured legacy schema fixtures in temporary homes. Local HTTP/SSE/MCP
  fixtures test provider and tool behavior. Actual Pi checks are documented
  in [`backend/hexbot-core/README.md`](../backend/hexbot-core/README.md).
  Section deletion regressions in `tests/section_delete.rs` cover public calls,
  offline catalog deletion, restart recovery, deferred catalog commit failures,
  disposition write failures and completed descendant cleanup in both orders.
  Concurrent deletes reserve SQLite writers and wait for committed policy rows;
  they use the existing busy timeouts, with no sleeps. Unit tests cover
  overlapping retirement claims and real todo/skill writes whose awaiters were
  cancelled. All deletion fixtures use disposable homes. Public deletion
  refuses owner chats (`4202`), so these fixtures delete peer threads; the
  one-chat migration case keeps an owner chat.
  `tests/runtime_config.rs` pauses the caller after Pi records a model reply,
  then completes deletion on another executor before resuming the caller.
  Prompt adoption tests also exercise the interval between tombstoning and close.
  `tests/bot_retained_delete.rs` combines retained children and legacy aliases
  with bot catalog COMMIT, native metadata, purge, completion, journal, jobs and
  profile cleanup faults. It checks exact frozen settings, restart retry, name
  reuse, other bots and completed-child exclusions. Product closure tests also
  exercise room deletion and last-member removal before either SQLite writer.
  `tests/room_delete.rs` checks public and direct room deletion, last-member
  removal, catalog rollback, exact owned descendants, legacy cleanup, terminal
  retry after cleanup faults, retained children and foreign-owner controls.
  The section, bot and room deletion files also start from tombstones and bot
  journals in the format of builds before retention, stopped before their
  catalog commit, and restart twice. Committed old deletions, recorded
  retention and foreign mappings stay closed.
  `section_delete_recovery` exercises public catalog/App deletions with native,
  legacy transaction, file and final metadata faults, restart, denied paths,
  exact aliases, descendants and ownership controls.
  `section_delete_ownership` compares catalog-only and native roots through
  public and direct deletion, exact foreign bot/owner branches, rollback,
  retention, completion and restart. A foreign ancestor blocks its entire
  branch, including an owned grandchild and live aliases.
  `unused_chat_fork` repeats missing-log and no-report lookups through both
  routes, checks restart leaves no empty tombstones, and rejects any reservation
  writes on the no-copy path. Partial-copy and published-adoption faults remain in
  `chat_fork_cleanup` and the catalog fork tests.
  `bot_journal_section_purge` checks independent public/direct section purges
  under provisional bot journals, explicit and startup rollback, healthy
  purges and committed profile removal. Exact legacy data and permanent native
  deletion metadata are checked across retries.
  The catalog library's
  `section_delete_crash_at_the_real_catalog_commit_recovers_the_decision`
  kills a child process at socket barriers before and after the actual SQLite
  catalog COMMIT. It checks rollback versus completed native and legacy erasure.
  `deletion_admission` holds actual child processes at TCP startup and shutdown
  barriers. It checks late hidden, CLI, job, teammate and room starts, descendant
  PIDs, rebound listeners, cancelled requests, concurrent removals and joins,
  and unrelated rooms. One-shot description PIDs check admission through actual
  shutdown after cancellation. SQLite and file barriers hold native insertion
  after ownership checks and actual blocking recovery after caller cancellation.
  A held accepted turn checks the final busy refusal after admission drains.
  Bot catalog faults and room faults before mutation
  check that admission releases and actual jobs and room posts can run again.
  `room_member_atomicity` checks joins and final-member removal in one catalog
  transaction. Catalog failure preserves exact native history, raw Pi files,
  frozen options, incident rows, membership and event sequence before retry.
  The section recovery false-purge control likewise requires exact retention
  of native and legacy history, frozen settings and raw files after restart.
  Room deletion purges room history only after its catalog commit, so a failed
  statement keeps the room and its history (`room_incidents`). Purge faults
  after the commit and last-member races are in `tests/room_delete.rs`.
- Pi runtime: `node --test backend/pi-runtime/*.test.mjs` after
  `npm ci --prefix backend/pi-runtime --ignore-scripts --no-audit --no-fund`.
  CI runs the Rust and Pi suites on Linux and macOS. Approval tests use a stub
  sandbox; isolation tests use `sandbox-exec` on macOS and working bubblewrap
  on Linux. CI installs bubblewrap with the AppArmor profile from the install docs.
  Gate regressions change the working directory and resolved file destination
  during review, check create-to-overwrite changes, and simulate unavailable
  bubblewrap for both ordinary and full-access shell requests.
  Reviewer fixtures use local fake provider and ACP endpoints to check that
  ancestor instructions, `APPEND_SYSTEM.md`, skills and tools stay out. ACP
  checks verify a separate home and Copilot/XDG directories, disabled
  instruction/tool/MCP discovery, and failure on extra configured ACP arguments.
  Explicit GitHub-token login variables remain allowed, but these fixtures use
  fake transports and do not verify live CLI authentication or compatibility.
  Daemon regressions change or queue owner messages while review waits and
  check that its verdict cannot automatically approve the old evidence.
  macOS tests check that Auto and Manual deny IPv4 and IPv6 TCP/UDP listeners,
  while approved full-access commands can still listen. Dummy secret/browser
  fixtures exercise rename, unlink and append denial, ancestor renames, linked
  `gitdir`/`commondir` targets from both Git directory and file markers,
  configured hooks in ignored directories and config includes, bare `*.git`
  repositories, dangling `.env` links, and ordinary writes in `project.git`
  workspaces. Hook-path tests set `core.hooksPath` to `/`, a browser store, the
  home folder and a link to `/`, and check that nothing outside the workspace is
  bound or locked, that no bind follows a mask, and that file tools still
  write; the link inside the workspace refuses the Linux command and is locked
  by name on macOS. Link tests make `.git` and a hooks folder symbolic links
  inside the workspace and check the same, with `sandbox-exec` refusing to
  remove or replace them. Metadata link tests make `.git/hooks` and
  `.git/config` links to tracked files and check that their targets are bound
  read-only and refuse writes under `sandbox-exec`, that a dangling hooks link
  asks for `mkdir`, that `hooksPath = hooks-link/../hooks` finds the link, and
  that `hooksPath = /` cannot hold a missing `.githooks`; a chain
  `.git/hooks -> ../.githooks -> store/hooks` refuses the Linux command for
  `.githooks` and locks it under `sandbox-exec`. Repository fixtures for hook
  paths are made by `git init`; nested-repository tests check that husky's
  `.husky/_` and `.githooks` are bound and locked in each nested repository's
  own folder and that a missing `.githooks` there asks for `mkdir`. FIFO tests
  put FIFOs at `.git`, `commondir`, a config and an include and check that the
  scan finishes. Include tests use a cyclic, fanned-out set
  of includes (12^10 visits without deduplication), a config with 64 includes,
  which scans, and one with 10,001, which must fail the scan within seconds.
  Seventy repositories with one include each scan; 260 stop the scan with a
  reason that names the 256-file limit, and 65 in one repository name it.
  Entry tests fill one folder past the entry budget. Global-config tests point
  `GIT_CONFIG_GLOBAL` at a config with `core.hooksPath = .githooks` and check
  that each worktree's folder is locked, an absolute one outside the workspace
  is not, and a missing one that would pin a nested repository or the
  workspace refuses the Linux command with `mkdir` guidance until the folder
  exists. Pinning tests check that a missing `.husky/_` pins only `.husky`,
  that a missing include asks for `touch`, and that one message names every
  missing target. Every other test reads no user or system Git config: the Pi
  tests set `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_NOSYSTEM=1`, and the
  Rust tests read only the files a test names. The parity test includes that
  global setting and a nested husky repository. Large-workspace tests cover file-tool writes/edits and macOS
  commands after the scan budget is reached. Incomplete scans ask before each
  file change, offer only once or deny, and keep the shell-profile and
  outside-workspace reasons; cache-marker `.git` files stay locked without failing the scan.
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
- Live Pi suites: ignored unless `HEXBOT_TEST_PI` names a Pi executable. CI runs
  them with the pinned Pi after the Pi runtime install above, from
  `backend/hexbot-core`:

  ```sh
  export HEXBOT_TEST_PI="$PWD/../pi-runtime/node_modules/.bin/pi"
  cargo test --locked --test pi_live -- --ignored
  cargo test --locked --test runtime -- --ignored
  cargo test --locked --test runtime_recovery -- --ignored
  cargo test --locked --lib runtime::lifecycle_tests::actual_pi_reviewer -- --ignored
  cargo test --locked --test room_incidents -- --ignored
  ```
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

## Mobile

`pnpm mobile:check` runs the Expo app's TypeScript, lint, protocol and chat-state tests,
and `scripts/ios-entitlements.mjs`, which refuses a change to the iOS
entitlements until `ios-entitlements.json`, the list the stored provisioning
profile supports, is updated. The same script with `--eas` checks the profile
stored on EAS itself; the Release workflow runs it before the TestFlight
build, and `scripts/ios-profile.mjs` regenerates the profile
(`apps/mobile/README.md`, "iOS capabilities and the provisioning profile").
Room regressions cover simultaneous turns, reconnect cleanup, failure and limit
notices, and former members' names. File tests cover size checks before reads.
`pnpm --filter @hexbot/mobile run export` bundles iOS, Android and web.

With an Expo CLI login, validate the TestFlight workflow files from
`apps/mobile` without starting a build or uploading to Apple:

```sh
pnpm exec eas workflow:validate .eas/workflows/testflight.yml --non-interactive
pnpm exec eas workflow:validate .eas/workflows/testflight-upload.yml --non-interactive
```

The build workflow runs the mobile checks before compiling iOS. Release
commands and account setup are in `apps/mobile/README.md`. An actual
TestFlight upload is a release operation, separate from these checks.

For the integration test:

```sh
cargo build --locked --manifest-path backend/hexbot-core/Cargo.toml --bin hexbot
npm ci --prefix backend/pi-runtime --ignore-scripts --no-audit --no-fund
pnpm --filter @hexbot/mobile exec playwright install chromium
pnpm --filter @hexbot/mobile run export
pnpm --filter @hexbot/mobile run smoke -- --static
```

The test serves the exported Expo web app at iPhone size, pairs a device with
DPoP, and uses the real Rust daemon and pinned Pi with a local streaming model.
It checks chat, attachment-only sends, unlimited room turn budgets, rooms, soul,
isolated memory, About you, scheduled jobs,
disconnect, reconnect and history. It writes screenshots and a JSON report to a
new temporary directory. `HEXBOT_MOBILE_ARTIFACTS` selects an output directory.
It creates and removes its own daemon home and workspace.

To check a native simulator, start Metro on 8181 and run the smoke without
`--static`, adding `--keep`. It leaves the test daemon available and writes
`native-pairing.json` in that temporary output directory. This contains a
short-lived pairing code. Use the Maestro flow in `apps/mobile/maestro` with
that origin and code, then stop the smoke process to clean up. Native build
commands and Hex Connect validation limits are in `apps/mobile/README.md`.

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
