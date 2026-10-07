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

## Standalone installation

From an extracted native runtime, run `./hexbot setup --activate` to verify and
copy the bundle into `$HEXBOT_HOME/runtime/native`, select it, install managed
Python 3.11 and voice tools, and write `~/.local/bin/hexbot`. The wrapper preserves
the selected home and follows native updates. `--no-code-tools` skips Python and
voice provisioning. `--json` emits one progress object per line, including errors.
The shared tool pins and voice requirements live in `assets/`; the app uses the
same files and receipts. An existing installation can run `hexbot setup` to repair
its code tools and CLI wrapper without replacing the daemon bundle.

`hexbot service install` installs and starts a per-user launchd or systemd service.
Use `uninstall`, `start`, `stop`, or `restart` to manage it, `status --json` to inspect
it, and `logs [-f]` to read its logs. Linux installation also tries to enable
lingering so the daemon can stay up after logout. `HEXBOT_SERVICE_ROOT` replaces
`HOME` for service file locations; `HEXBOT_SERVICE_NO_LOAD=1` skips service-manager
commands. Tests use both with temporary directories.

`hexbot status [--json]` reports the daemon, LAN addresses, Tailscale IPv4, Hex
Connect hostname, service, and sandbox. It works before the first daemon start.
Pairing remains available through `hexbot pair`. `hexbot lan on|off` turns LAN
access on or off with or without a running daemon; the Headless installer turns it
on for a first install or a change into Headless. Repair keeps the LAN setting.
LAN and Tailscale pairing addresses are shown only when LAN is enabled.
On macOS the service uses the `gui` launchd domain and falls back to `user`, so
it also installs over SSH when nobody is signed in at the screen.

## Storage and compatibility

- `hexbot.db` keeps schema v13, IDs, ownership, rooms, sections, and settings.
  Migrations use captured legacy schema fixtures for starting versions 1–11
  and check that rows survive upgrades and repeated runs. Version 12 adds
  `devices.jkt` for optional device proof-key binding. Version 13 adds
  `memory_proposals`, the memory changes scheduled jobs ask for until the
  bot's next dream reviews them (`docs/dreaming.md`).
- Memory stays in `profiles/<bot>/memories/MEMORY.md`, soul in `SOUL.md`, and
  About you in `users/<id>/user.md`. Deleting a section leaves bot memory alone.
  Only sections, rooms, and dreams write it; a scheduled job's memory tool
  records proposals instead, and its soul tool only reads. The memory tool's
  `add`, `append`, and `replace` end each entry with the month it was learned
  (`[YYYY-MM]`); `set` and the app write text as given (`docs/dreaming.md`).
  Daily notes are one file a day in `memories/notes/YYYY-MM-DD.md`, 4,000
  characters a day, written by the tool's `note` action and read with
  `read {notes}`, never injected, read by the dream before transcripts, and
  deleted after 30 days. A shared bot in someone else's room is a guest
  there (`guest` in its live settings): its memory tool refuses notes and
  answers writes with a confirmation instead of the text, and the private
  extension's file tools refuse `memories/` and every `users/<id>/user.md`,
  through links too, outside Bypass. The sandbox for shell commands hides
  credential files only.
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
- `profiles/<bot>/pi/` is the bot's Pi agent directory. The daemon rewrites
  `auth.json`, `models.json`, and the `compaction` key of `settings.json`
  atomically before every Pi start and whenever credentials change; other
  `settings.json` keys are kept. Compaction uses Pi 1.0.1's defaults, written
  out so a Pi upgrade cannot move them: reserve 16,384 tokens, keep the most
  recent 20,000. Each model Hexbot lists in `models.json` gets a
  `modelOverrides` entry capping both at a quarter of its context window, so
  compaction fires at 75% of the window or later for every model instead of
  at half of a 32k window. The context meter clients draw
  (`hexbot.sections.open` and `session.usage`, `docs/api.md`) takes its
  `compact_at` from this key as the section's Pi process loaded it at start,
  so it always matches what that process does. A model with no known window (an empty models.dev
  cache, a custom or local server, an OpenRouter model missing from the
  catalog) is assumed to have 32,768 tokens and compacts near 24,500; set
  `model_overrides.<provider>.<model>.context_window` (or
  `model_overrides._default.context_window`) in `config.yaml` to tell the
  daemon the real window, and for Ollama `model.context_length`, which is also
  sent as `num_ctx`. Models Pi ships natively keep Pi's own metadata; their
  `modelOverrides` entries scale by the windows in the pinned catalog
  (`src/pi_catalog.json`, regenerated with `generate-pi-catalog.mjs`), so a
  small built-in model such as `openai/gpt-4` compacts at 6,144 tokens rather
  than never. A running Pi keeps the settings it loaded at start, so the
  daemon leaves an unchanged file alone.
- Shortly before Pi would compact, the private extension clears old tool
  output instead (`extension.ts`, `turn_end`). When Pi's context estimate
  passes the compaction point minus a tenth of the window, tool results from
  before the third most recent user message and over about 1,000 characters
  are replaced in model context by a one-line note saying the output was
  cleared; the call and its arguments stay, and so do results of `clarify`,
  `memory`, `hexbot_soul`, `todo`, `message_bot`, `skill_view` and
  `delegate_task`, and anything before the first user message. Results are
  kept by user messages, not assistant rounds, because Pi ends a turn after
  every tool round and a long run is still using its reads. The edits are Pi
  `context_edit` entries in `conversation.jsonl`:
  they change only what the model sees from then on, never the displayed
  history (`reconcile` skips them), billing, or the summaries dreaming reads.
  One trim per crossing of the line, so the cached prefix is rewritten once
  rather than every request; it happens only when it would bring usage under
  70% of the compaction point, otherwise compaction runs as before. Right
  after a trim the meter's `tokens` is Pi's size estimate of the edited
  context until the next reply measures it. The extension reads the
  compaction key of `settings.json` once when it loads, as Pi does, so its
  line, Pi's compaction and the meter follow the settings this process
  started with.
- A conversation keeps its system prompt, skill catalog and tool definitions
  across turns and daemon restarts. Skill bodies and grants resolve live. Runtime settings outside the prompt may
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

## Skills

One resolver in `skills.rs` supplies prompts, tools, RPCs, scheduled jobs and
skill-backed connectors. Skills resolve by directory name, with a bot's private
copy taking precedence over `<home>/skills`, then bundled `skills/` selected by
`HEXBOT_BUNDLED_SKILLS`. New bots do not copy bundled skills. Bot authoring writes
only private skills; editing an inherited skill creates a private override.
People can move a private skill into the library using the share RPC.

New library skills are on for every bot. The bot's `config.yaml` `skills.disabled`
is the per-bot deny-list, and the root config's `skills.disabled` disables a
library name globally, including private overrides. `bots.skills_json` remains
for storage compatibility but is not read for grants or the bot's skills list.
Library writes and global disables pass one admin-only helper. Owners can edit
private skills and grants for their bots. Admins must own the source bot to
share a skill and every bot listed in a library save's `bots_disabled`. All
ownership checks finish before that save writes anything. RPC contracts are
in `docs/api.md`.

`enabled_for_bot` reports the bot's own grant; `enabled` also applies the global
deny-list. Legacy bot selection updates leave globally disabled skills at
their current per-bot grant. Every daemon config mutation uses the synchronous
config writer in `common.rs`, locking read-modify-write across skills,
connectors, bot configuration, settings mirroring, provider cleanup and Connect.
Acquire the skills lock before the config lock when both are needed; neither
lock may cross an await. Skill discovery and body reads hold a shared lock;
saves, sharing, deletion and `skill_manage` commits hold the exclusive side.
Skill destinations cannot contain or be contained in another skill, including
destinations staged together in a batch.

Under the startup migration lock, a one-time pass removes private skill
directories whose fingerprint matches the current bundled copy or any shipped
version of the same name recorded in `skills/.history.json`. The manifest maps
skill names to sorted, unique arrays of lowercase SHA-256 hashes. Fingerprints
cover sorted relative paths, the executable bit and file bytes. Dotfiles and
dot directories, empty directories and other permission bits are ignored,
matching the old seeding rules. Modified bodies, scripts, extra non-dot files
and non-dot symlinks keep a copy private. Empty category directories and those
containing only an unchanged bundled `DESCRIPTION.md` are also removed.

Run `node scripts/desktop/skill-history.mjs` after changing bundled skills.
It reads every commit from `git log -- skills` plus the current tree and needs
full Git history. For each file, the hash input is its relative POSIX path,
NUL, executable flag `0` or `1`, NUL, decimal byte length, NUL, then file bytes.
Files sort by UTF-8 path bytes. Node and Rust tests share a fingerprint vector;
CI checks every current bundled skill against the manifest. Discovery and old
seeding skip the dotfile. Runtime packaging copies the entire skills tree,
including the manifest.

Deny-lists and native sessions are untouched. A completion marker in `settings` makes later starts skip the pass; interruption is safe to retry.
A missing bundled directory defers migration until it is available.

New prompts contain only skill names and descriptions, with an instruction to
load bodies through `skill_view`. Read-only `skill_view` and `skills_list` are
available without the authoring toolset and enforce current grants on every
call. `skill_manage` still requires the skills toolset. Skill body edits are
live. Existing sections retain their exact prompt and options, including old
inline skill bodies. The existing About you privacy repair is unchanged.

Pi starts with `--no-skills` and receives no `--skill` paths. Pi 1.0.1 accepts
explicit skill paths even with `--no-skills`; its `/skill:name` commands load
bodies directly, bypassing daemon grants. Its generated skill prompt is also
replaced by the private extension's `before_agent_start` handler. Scheduled
jobs resolve their explicitly requested skills through the same live grants.
Notion and Airtable connectors toggle grants without making private copies.

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

Manual asks for every connected-tool call. Auto asks unless the server declares
`readOnlyHint: true`. Resource tools are read-only. Allow in this section
covers that server until the Pi process ends; Bypass never asks. Codemode
itself needs no approval, but every nested tool call passes the same gates.
Its QuickJS worker has no Node, filesystem, or network globals. Its `models`
helpers can call provider APIs using session credentials and incur costs.

Stdio servers are trusted admin-configured code, outside the shell sandbox.
Pi starts one process per section per server in `<home>/runtime/mcp/<bot>`, a
daemon-owned directory with mode 0700, with its allowlisted environment and only
the server's explicit `env`, rather than all connector credentials. Reference
needed keys explicitly in `env`. HTTP headers can reference credentials in
`config.yaml`. OAuth sign-in UI is not yet available. `mcp-auth.json` is a
protected credential file. The last 2 KB of server stderr can reach the model in
connection errors. Connectors Test uses the same cwd and environment policy.

The daemon hashes expanded server configs in `hexbot_session_settings`, so
config and credential edits revoke old registrations in open sections. Every
`mcp__` gate compares that revision before honoring Bypass or a prior approval.
Removed or disabled entries are blocked. Changed entries reconnect at the next
prompt using Pi's same-name `registerMcpServer`; its `mcp_servers_change` handler
hides old deferred tools and closes the old client before reconnecting. The
model's frozen prompt and declarations do not change. Reconnection is asynchronous;
a call during it can fail as unavailable and can be retried after connection. A failed initial bridge
request retries at the next prompt. One invalid entry cannot disable the rest.
Approvals for sections with no chat or room entry fail immediately. Visible
sections retain the existing approval-card behavior.

Pi 1.0.1 exposes no execute wrapper for a tool owned by its MCP extension.
`getAllTools()` returns metadata, and `tool_execution_start` fires *before*
`tool_call`, including for nested calls. We re-check mode and server revision
after an approval answer in the last blocking hook. Unlike Hexbot's wrapped
file and shell tools, MCP calls cannot do a second check inside `execute` through
Pi's public extension API. A mode change after the gate returns is therefore
not covered by an execution-time check. See `dist/core/nested-tool-calls.js`,
`dist/core/agent-session.js`, `dist/core/extensions/runner.js`, and
`pi-agent-core/dist/agent-loop.js` in the pinned Pi distribution.

Pi 1.0.1's `--tools` filters future deferred registrations too. MCP sections
therefore use `--no-builtin-tools` and `--exclude-tools` for every built-in the
extension does not wrap, including `powershell`. The extension selects the frozen tool names
and codemode once at `session_start`. Deferred tools never enter the model's
tool declarations. Every Pi process runs with `--no-approve`, so a workspace
`.pi/` directory (settings, `mcp.json`, extensions, skills, prompts, system
prompt files) is never loaded, whatever Pi's trust store or
`defaultProjectTrust` says. Without the flag Pi 1.0.1 resolves trust through
the extension's `project_trust` event, then `<agent-dir>/trust.json`, then
`defaultProjectTrust`; in RPC mode the `ask` default answers no, but a trust
entry for the workspace or any parent would let a project `.pi/settings.json`
override the compaction values below. Sections without connected servers load
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
