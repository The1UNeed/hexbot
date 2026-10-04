# Hexbot Rust daemon

The `hexbot` binary is the native daemon. Rust owns HTTP/WebSocket serving,
authentication, storage, rooms, tool dispatch, providers, scheduling, Connect,
and updates. A pinned **Pi 1.0.1** subprocess runs each agent conversation.
Pi is the agent runtime at [earendil-works/pi](https://github.com/earendil-works/pi),
not Raspberry Pi hardware. The private extension in `../pi-runtime/extension.ts`
connects Pi tools, approvals, clarification, provider auth, and events to Rust.
The existing React app and shared gateway client are unchanged.

## Run

Use the Rust toolchain in `rust-toolchain.toml` and Node 26.5.0. From the repository root:

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
web assets, and skills from `skills/`. Desktop bootstrap provisions an isolated Python interpreter
for code tools and pinned edge-tts for free voice, separately from the daemon.
Client-only packages contain no daemon. Native package
builds use their target OS and architecture. Intel macOS also cross-compiles
on Apple Silicon with Rosetta for the runtime probe.

`../python-handoff/` provides the service handoff for existing
Python background services. It is not called by the Rust daemon. Python code execution is a language tool and still needs a Python interpreter; browser,
voice, and desktop tools likewise use their configured command-line dependencies.
PDF attachments use Poppler's `pdftoppm`, as in the former daemon, to render
selected pages for the model. Install Poppler on standalone daemon hosts.
The native CLI implements Hexbot commands. Legacy core administration commands are not part of the native CLI.

## Storage and compatibility

- `hexbot.db` keeps schema v12, IDs, ownership, rooms, sections, and settings.
  Migrations use captured legacy schema fixtures for starting versions 1–11
  and check that rows survive upgrades and repeated runs. Version 12 adds
  `devices.jkt` for optional device proof-key binding.
- Memory stays in `profiles/<bot>/memories/MEMORY.md`, soul in `SOUL.md`, and
  About you in `users/<id>/user.md`. Deleting a section leaves bot memory alone.
- `hexbot-runtime.db` stores native transcript projections, usage, and frozen
  session options. Pi keeps its conversation JSONL under the native session
  directory. Existing Python `state.db` history is imported once, including
  hidden and tool messages. New native turns are not mirrored into legacy
  Python history. There is no Python rollback package.
  Session recovery reconciles Pi's durable log with native history and usage;
  replaying an already recorded message does not duplicate it or its cost.
- Settled Pi processes retire after 15 idle minutes. Session IDs remain valid;
  a later RPC resumes the durable session. Staged files and pending questions
  prevent retirement. Replay retention is bounded by session count and bytes.
- A conversation keeps its system prompt, selected skills, tool definitions,
  across turns and daemon restarts. Runtime settings outside the prompt may
  resolve live.
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
node --test backend/pi-runtime/*.test.mjs
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

## Tool boundaries

Approval modes follow Codex: the OS sandbox is the boundary, not a judging
model and not a list of command patterns. Pi has no approval modes of its own;
Bypass (`off`) is plain Pi with no prompts, no sandbox, and no credential
checks, and only the admin may choose it (`common::bypass_allowed` rejects it
for a member's bot or room, error 4301, and such a bot runs in Auto). In Auto (`smart`, the default) the
private extension runs each shell command in a sandbox with no network that
writes only inside the workspace: the bot's working directory, its artifact
and attachment folders, and temp folders, with shell profiles and login items
read-only even there. A command that needs more sets `full_access` with a
`reason` on the bash tool; the user sees both and, if approved, the command
runs with the sandbox's base layer only (credential paths still masked). In
Manual the shell sandbox is read-only and every file change asks. Both modes
ask before browser page scripts and before scheduling an absolute script path.

Python code execution runs in the same workspace sandbox outside Bypass.
Auto runs it without asking; Manual asks first (`runtime.rs`, `native_approval`);
Bypass runs it unsandboxed. A small literal guard (`check_code`) refuses a
handful of catastrophic one-liners in every mode. The extension offers
`once`, `session`, and `deny` on its cards, and a `session` choice quiets that
kind of request for the rest of the section; daemon-raised requests offer
`once` and `deny`. Nothing is saved across sections.
Memory and soul edits, including removals, scan the complete result before bot writes. Existing flagged text may remain; newly assembled matches are rejected.

`../pi-runtime/credential-policy.json` is the one source for the credential
paths, the host write tiers (`write.deny` is never written by a tool outside
Bypass, `write.ask` prompts the file tools in Manual and Auto, `write.fileDeny`
is refused to the file tools), the child environment allowlist, and the sandbox
walk. `credentials.rs` and the private extension both read it, and a parity test
in `credentials.rs` checks that both sides build the same sandbox profile and
bubblewrap arguments. macOS shell and Python children use
`sandbox-exec` and fail closed if the profile cannot be applied. Linux uses
bubblewrap after a successful startup probe, with credential paths masked and a private process
namespace. Shell, Python, and scheduled scripts cannot write the Hexbot home except
the output folders the daemon chose (artifacts and attachments); a working
directory saved inside the home before the daemon refused one is ignored, logged
once, and replaced by the default workspace. SSH private keys are protected; SSH
config, known hosts, public keys, and the SSH agent remain available. If bubblewrap
is missing or cannot start, a startup warning records the lack of OS isolation,
`hexbot.info` reports `sandbox: null` so Settings can show a notice,
Manual and Auto ask before every shell command and code run, and scheduled
scripts refuse to run unless approval mode is Bypass.
Provider keys reach the agent through its auth file. The selected Bedrock or Vertex provider also receives its cloud environment settings; shell and scheduled script children do not.
The Python environment does not include `HEXBOT_HOME`.

Managed browser traffic uses the safety proxy, including loopback. The
[agent-browser implementation](https://github.com/vercel-labs/agent-browser/blob/main/cli/src/native/cdp/chrome.rs)
forwards the proxy bypass setting to Chromium;
[Chromium documents `<-loopback>`](https://chromium.googlesource.com/chromium/src/+/HEAD/net/docs/proxy.md#overriding-the-implicit-bypass-rules)
as disabling implicit bypass. Unmanaged browsers allow inspection only, and
browser code execution is refused without interception. URL tools always deny
the daemon listener and metadata addresses, even with private URLs enabled.
The Copilot ACP child starts from the same environment allowlist as every
other child process plus its GitHub login variables, and its own tools are
never granted: permission requests are cancelled and no file bridge is
offered, so Hexbot actions come back as `<tool_call>` text and run through
the section's guarded tools.

New sections freeze connected server names and reach their tools through Pi's
`builtin:mcp` and `builtin:codemode`. Configs with expanded credentials travel
through the private bridge in memory on the first prompt, never through the
session config, transcript, prompt, or Pi environment. The extension escapes
Pi's config templates before registration. Existing sections retain their
frozen Rust bridge tools, including legacy SSE servers. New SSE entries are
rejected; new sections skip existing SSE entries with a warning.

Manual and Auto ask for each connected tool call unless the server declares
`readOnlyHint: true`. Resource tools are read-only. Allow in this section
covers that server until the Pi process ends; Bypass never asks. Codemode
itself needs no approval, but every nested tool call passes the same gates.
Its QuickJS worker has no Node, filesystem, or network globals. Its `models`
helpers can call provider APIs using session credentials and incur costs.

Stdio servers are trusted admin-configured code, outside the shell sandbox.
Pi starts them in the bot workspace with its allowlisted environment and only
the server's explicit `env`, rather than all connector credentials. Reference
needed keys explicitly in `env`. HTTP headers can reference credentials in
`config.yaml`. OAuth sign-in UI is not yet available. `mcp-auth.json` is a
protected credential file.

Pi 1.0.1's `--tools` filters future deferred registrations too. MCP sections
therefore use `--no-builtin-tools`; the extension selects the frozen tool names
and codemode once at `session_start`. Deferred tools never enter the model's
tool declarations. `--no-approve` keeps workspace `.pi/mcp.json` ignored even
if Pi has a saved trust decision. Sections without connected servers load
neither builtin. The daemon's frozen prompt lists server namespaces only;
Pi's changing server section is hidden by the forced-prompt projection.

Hidden turns include prompt submission in their 30-minute deadline.
Recovery quarantines damaged data; transient I/O or SQLite failures leave the
files in place for a later attempt. A quarantined section moves its
`conversation.jsonl` aside as `conversation.quarantine-<id>.jsonl` and refuses
to open until a `conversation.jsonl` is put back; the next daemon start then
recovers that file and lifts the quarantine if it is sound.

Prefer `HEXBOT_MANAGED_DIR`, `HEXBOT_MAX_TURNS`,
`HEXBOT_COPILOT_ACP_COMMAND`, `HEXBOT_COPILOT_ACP_ARGS`,
`HEXBOT_CUA_DRIVER_CMD`, and `HEXBOT_XAI_BASE_URL`. The corresponding old
`HERMES_*` names remain fallbacks. Managed config defaults to `/etc/hexbot`,
with `/etc/hermes` as the fallback when the new directory is absent.
