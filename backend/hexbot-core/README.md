# Hexbot Rust daemon

The `hexbot` binary is the native daemon. Rust owns HTTP/WebSocket serving,
authentication, storage, rooms, tool dispatch, providers, scheduling, Connect,
and updates. A pinned **Pi 0.87.1** subprocess runs each agent conversation.
Pi is the agent runtime at [earendil-works/pi](https://github.com/earendil-works/pi),
not Raspberry Pi hardware. The private extension in `../pi-runtime/extension.ts`
connects Pi tools, approvals, clarification, provider auth, and events to Rust.
The existing React app and shared gateway client are unchanged.

## Run

Use Rust 1.97.1 and Node 26.5.0. From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm dev
# Electron instead of the browser:
pnpm dev --desktop
```

The development runner builds Rust, installs the locked Pi dependency, and uses
this checkout's `.hexbot` directory. To start only the daemon against disposable
state:

```sh
npm ci --prefix backend/pi-runtime --ignore-scripts
cargo build --locked --manifest-path backend/hexbot-core/Cargo.toml --bin hexbot
test_home=$(mktemp -d)
HEXBOT_HOME="$test_home" backend/hexbot-core/target/debug/hexbot serve --port 9119
```

`HEXBOT_PI_EXECUTABLE` selects an explicit Pi executable; `HEXBOT_WEB_DIST`
selects the built web bundle. Full desktop packages include Rust, Node, Pi,
web assets, and skills. Desktop bootstrap provisions an isolated Python interpreter
for code tools and pinned edge-tts for free voice, without installing Hermes.
Client-only packages contain no daemon. Native package
builds must run on their target OS and architecture.

The former Python backend remains in the repository for comparison and explicit
`pnpm dev --backend python` use. It is not called by the Rust daemon. Python
code execution is a language tool and still needs a Python interpreter; browser,
voice, and desktop tools likewise use their configured command-line dependencies.
PDF attachments use Poppler's `pdftoppm`, as in the former daemon, to render
selected pages for the model. Install Poppler on standalone daemon hosts.
The native CLI implements Hexbot commands. The arbitrary `hexbot hermes ...`
upstream administration CLI belongs to the retained Python installation.

## Storage and compatibility

- `hexbot.db` keeps schema v9, IDs, ownership, rooms, sections, and settings.
  Migrations compare against the original Python implementation, including
  versions 1–9, repeat runs, and opening the upgraded result with Python.
- Memory stays in `profiles/<bot>/memories/MEMORY.md`, soul in `SOUL.md`, and
  About you in `users/<id>/user.md`. Deleting a section leaves bot memory alone.
- `hexbot-runtime.db` stores native transcript projections, usage, and frozen
  session options. Pi keeps its conversation JSONL under the native session
  directory. Existing Hermes `state.db` history is imported once, including
  hidden and tool messages. New native turns are not mirrored into legacy
  Hermes history, so switching back to Python is not a full transcript rollback.
  Session recovery reconciles Pi's durable log with native history and usage;
  replaying an already recorded message does not duplicate it or its cost.
- Settled Pi processes retire after 15 idle minutes. Session IDs remain valid;
  a later RPC resumes the durable session. Staged files and pending questions
  prevent retirement. Replay retention is bounded by session count and bytes.
- A conversation keeps its system prompt, selected skills, tool definitions,
  working directory, and approval settings across turns and daemon restarts.
  Native live session IDs remain distinct from stored section IDs.
- HTTP cookies, pairing, device revocation, JSON-RPC names, error objects,
  owner-scoped events, replay sequence numbers, and replay epochs preserve the
  existing client contract. LAN setting changes restart the listener and close
  clients with a reconnect signal. A home lock prevents competing daemons.
- YAML edits preserve unmanaged values and comments. Credentials are inherited
  per bot and are not exposed in client responses or model event streams.

## Modules

| Module | Responsibility |
| --- | --- |
| `server`, `daemon`, `cli`, `auth`, `events` | Transport, process lifecycle, CLI, users, pairing, replay |
| `db`, `catalog`, `memory`, `runtime_store` | Existing data, bots, sections, skills, memory, transcripts |
| `runtime`, `pi`, `runtime_delegation` | Pi sessions, streaming, attachments, approvals, clarification, delegation |
| `rooms` | Concurrent responders, mentions, main-bot collection, limits, interruption |
| `settings`, `dreaming` | Settings, budgets, incidents, dreaming, restoration, cron |
| `providers`, `provider_acp`, `connectors` | Models, credentials, OAuth, ACP, connector setup/probes, MCP |
| `native_tools`, `native_external_tools`, `native_product_tools` | Code, browser, computer, media, web, HA, X, skills and history tools |
| `services` | Connect registration, grants, tunnel lifecycle, native updates |

## Verification

All tests use temporary homes. Provider integration tests use local HTTP/SSE,
WebSocket, and subprocess fixtures; they do not spend provider credits.

```sh
cargo fmt --manifest-path backend/hexbot-core/Cargo.toml --check
cargo test --locked --manifest-path backend/hexbot-core/Cargo.toml
cargo clippy --locked --manifest-path backend/hexbot-core/Cargo.toml --all-targets -- -D warnings
node --test backend/pi-runtime/acp.test.mjs
```

Run real Pi against the local model fixture, including native memory tools and
provider fallback:

```sh
HEXBOT_TEST_PI="$PWD/backend/pi-runtime/node_modules/.bin/pi" \
  cargo test --locked --manifest-path backend/hexbot-core/Cargo.toml --test runtime -- --ignored
HEXBOT_TEST_PI="$PWD/backend/pi-runtime/node_modules/.bin/pi" \
  cargo test --locked --manifest-path backend/hexbot-core/Cargo.toml --test pi_live -- --ignored
HEXBOT_TEST_PI="$PWD/backend/pi-runtime/node_modules/.bin/pi" \
  cargo test --locked --manifest-path backend/hexbot-core/Cargo.toml --test runtime_recovery -- --ignored
```

Run the unchanged browser app against the daemon and actual Pi:

```sh
pnpm --filter ./apps/web run build
pnpm --filter ./apps/desktop exec playwright install chromium
node scripts/dev/native-ui-smoke.mjs
node scripts/dev/native-ui-smoke.mjs --desktop --edition=full
node scripts/dev/native-ui-smoke.mjs --desktop --edition=client
```

The browser test covers direct chat, multi-agent room collection and human
waiting, per-bot memory, soul/About you, archive reversal, and restored history.
Rust tests cover revoked users/devices, cross-user ownership and shared bots,
malformed requests, large attachments, overload, interruption, restart, legacy
history, transport failure, provider auth, MCP, scheduled work, and updates.
Full/client editions retain their existing desktop checks.

These checks do not certify every external provider, OS permission prompt,
network deployment, or workload. Real paid-provider accounts, Cloudflare and
Tailscale deployments, Linux/Intel package execution, and sustained resource
limits need their corresponding environment checks. No release is published
by running the tests. App install count is not a daemon capacity measurement.
