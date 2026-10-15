# Hexbot security policy

Report vulnerabilities privately through [GitHub Security Advisories](https://github.com/The1UNeed/hexbot/security/advisories/new).
Email to [lumora.studio@hotmail.com](mailto:lumora.studio@hotmail.com) is also accepted.
Do not open a public issue for a vulnerability. Hexbot has no bug bounty program.

A useful report names the component, version or commit, operating system,
steps to reproduce, and what an attacker gains. Test only against accounts,
daemons, and files you own. Avoid exposing other users' data or disrupting services.

## What runs where

The Rust daemon in `backend/hexbot-core/` owns authentication, storage, rooms,
tools, and the HTTP/WebSocket API. Each section uses a persistent Pi subprocess;
the private extension in `backend/pi-runtime/` applies Hexbot's tool gates.
The Electron app hosts the same React bundle that the daemon serves to browsers.
Client-only apps use a daemon elsewhere. Headless installations run the daemon
without an app. The Python handoff package transfers existing services; it does
not run the agent loop.

Bots, conversations, souls, memory, provider credentials, and device records
live on the daemon computer under `~/.hexbot`. The daemon runs with its host
user's permissions. It is not a container around all its tools or subprocesses.

The installer in `backend/hexbot-installer/` and `apps/installer/` downloads
Full, Client, or Headless packages from `updates.hexbot.app`. Hex Connect
brokers identity and tunnel setup. Chat traffic goes through Cloudflare's tunnel
to the daemon, without passing through Connect's application servers.
Cloudflare terminates TLS and can read that traffic.

## Tool isolation

The operating-system sandbox is the containment boundary for untrusted shell
commands and code execution. Prompt instructions, approval text, output
redaction, and pattern checks do not provide equivalent containment.

- Auto runs shell commands and Python code in a workspace sandbox. macOS uses
  `sandbox-exec` to deny inbound and outbound network access, writes outside
  the workspace, and reads of protected credential paths. Linux uses bubblewrap
  with private network and process namespaces and masked credential paths.
  Writable roots include the working directory, daemon-selected artifact and
  attachment folders, and temporary folders. On macOS these include shared `/tmp`.
  Existing Git metadata (`.git`, linked `gitdir`/`commondir` targets and bare
  `*.git` repositories with `HEAD` and `objects`, plus `core.hooksPath`
  directories set by the repository or your own Git config) stays read-only within the scan limits below. A bot
  changes protected metadata with an approved `full_access` command. Project
  secrets such as `.env` and `.envrc`, keychains, and browser profiles with
  cookies and saved passwords are unreadable and unwritable. Apple Events are refused, so a command cannot
  drive Finder or another app. Other files outside the workspace can still be
  read.
- Manual uses a read-only shell/code sandbox and asks before file changes.
  Approved `execute_code` runs can write their own output folder in the Hexbot
  home. Manual scheduled scripts cannot write artifacts or workspace files.
- In Auto, a `full_access` command, a file change outside the workspace, a
  connected tool that changes something, and a browser page script go to a
  review on the section's model before they run. It reads the owner's most
  recent messages, whole, and the whole step, including the checked file
  destination and overwrite status. It loads no project instruction files,
  skills or tools, and sees no tool output or bot replies. A step over 20,000
  characters, or evidence that cannot be read, asks. When older owner messages
  do not fit, the reviewer is told, and only a step it rates low risk runs. Changed owner evidence or queued owner prompts and steers
  invalidate automatic approval when the evidence is rechecked. A step it rates
  low or medium risk runs without asking; anything else, and any review that
  fails or times out, asks the user for that step only. Allow for now grants do
  not cover reviewed steps. A mode or working-directory change during review
  blocks execution; file execution rechecks the destination and reviewed
  overwrite status. The review is a model judgment, not
  containment: a step it allows has the same access as one the user approves.
- So in Auto, internet access and writes outside the workspace are decided by
  a model, not the sandbox, and a small or local section model judges less
  well. The step the reviewer reads (command, reason, file content, tool
  arguments) is written by the bot and can carry instructions injected by a
  web page or file the bot read; such text can talk a reviewer into allowing
  a harmful step. Choose Manual where that risk is not acceptable.
- An approved `full_access` shell command leaves the workspace restrictions.
  The base credential-path and Hexbot-home protections still apply. Review both
  the command and its reason before granting more access.
- File-tool changes to shell profiles and login items use user approval
  rather than model review, subject to an explicit Allow for now. Full-access
  shell commands use the reviewer's system-configuration policy and can
  change these files without a card when the owner requested that exact change.
- Reviewers run in a fresh empty working directory and exclude
  `APPEND_SYSTEM.md`. ACP reviewers also isolate their home, Copilot settings
  and XDG directories, retaining explicit GitHub tokens rather than stored
  CLI login or configuration. Configured ACP arguments beyond `--acp` and
  `--stdio`, missing auth or incompatible isolation flags make review
  unavailable and produce a user card.
- Bypass removes prompts and sandboxing and is available only to the admin.

macOS also matches `.git` paths and secret filenames created during a command. It
blocks renaming protected files and browser stores, and pins the scanned
ancestors of secrets and Git metadata and the ancestors of browser stores so
renaming a folder cannot expose their contents. Browser rules include the
Google parent folder, Chrome Beta/unstable, and Snap and Flatpak profiles.
Denying `~/Library/Application Support/Google` also hides other Google data
stored there, including Android Studio and Drive data.
Tracked hook scripts remain writable unless selected by a configured
`core.hooksPath` or by a `hooks` link in the Git metadata; their edits appear
in `git status`. Review those changes before running them. When `hooks`,
`config`, `config.worktree` or `commondir` inside the Git metadata is a
symbolic link to a folder or file in the workspace, that target is protected
like the metadata.

Linux protects repositories and secret files that exist when a command starts.
Repositories created during a command are **not protected** on Linux. The scan
visits workspace and output roots breadth-first, including read-only workspaces
in Manual, through three nested folders. It resolves `.env` symlinks and Git
pointers, and skips dependency/runtime folders listed in `credential-policy.json`
plus shared temporary roots. Repositories and secrets beyond these limits are
not covered by the Linux scan. If more than 1,000 directories need scanning,
or the folders it reads hold more than 50,000 entries, only Linux bubblewrap
commands refuse to run and require an approved `full_access` retry. For
`execute_code`, use a smaller workspace or run the Python code through the
terminal tool with `full_access` and a reason; a scheduled script needs a
smaller workspace. macOS
and file tools use partial results when the budget is reached. File changes ask for approval
in Auto mode when the scan is incomplete, every time: that approval covers one
change, is never remembered for the section, and never stands in for the
approval a shell profile or a file outside the workspace needs. The cwd-ancestor Git pointer
walk is unbudgeted, and macOS `.git` and secret filename rules still apply.
Bare `*.git` repositories must exist when the scan starts on either platform.
File tools refuse protected Git writes; an unreadable Git configuration or
scan failure asks for approval instead of blocking ordinary writes. Repository
configs and their includes are parsed with the system Git at `/usr/bin/git`;
without it, a repository with a config counts as unreadable. Your own Git
config and its includes are read the same way, from the files Git reads:
`$GIT_CONFIG_GLOBAL`, or `~/.gitconfig` and `$XDG_CONFIG_HOME/git/config`, and
`$GIT_CONFIG_SYSTEM` or `/etc/gitconfig` and Homebrew's
`/opt/homebrew/etc/gitconfig` and `/usr/local/etc/gitconfig` unless
`GIT_CONFIG_NOSYSTEM` is set. A Git build that keeps its system config
elsewhere (for example the one bundled with Xcode) is not read; set
`core.hooksPath` in one of these files instead. A hooks path your config sets
is resolved in each repository, so a global `core.hooksPath = .githooks`
protects `.githooks` in every scanned repository. Each config file is read
once per scan. A scan that meets more than 64 included files beyond the
repository and user configs for one repository, more than 256 in all, or more
than 10,000 settings, counts as unreadable and says which limit it reached, so
include cycles and fan-out cannot stall it. Included files and
configured hook paths inside the workspace or an output folder are protected,
with their ancestors up to that folder. Ones outside are already read-only to
sandboxed commands; a hook path that contains the workspace, such as `/` or the
home folder, is ignored. FIFOs and other special files in Git metadata stay
locked and are never read. Bubblewrap can only lock a folder that exists, so on
Linux a configured hooks folder or included file that does not exist yet is
locked through its nearest existing parent inside a repository, such as
`.husky` for a missing `.husky/_`. When that parent would be a repository's own
folder, the workspace or an output folder, and is not already protected as Git
metadata, the command asks for approval instead of making all of it
read-only. A dangling link names the folder or file it points to. The reason
names every missing target and one command that creates them (`mkdir -p` for
folders, `touch` for included files); after that, commands run in the sandbox
again. Bubblewrap also cannot protect a symbolic link inside the workspace, so
on Linux a `.git` entry, hooks folder or included file reached through such a
link asks for approval the same way, until the link is replaced by what it
points to. Paths are followed as Git follows them, so `hooks-link/../hooks`
counts as reaching through `hooks-link`. A link inside the Git metadata is
protected with it and does not ask; a link in the workspace that it passes
through, such as `.githooks` for `.git/hooks -> ../.githooks -> store/hooks`,
asks. macOS locks the link itself. Python code and scheduled scripts cannot
ask: they stop with the same explanation.

macOS fails closed when its sandbox cannot start. On Linux, if bubblewrap is
missing or unusable, Hexbot reports the missing isolation and Auto and Manual
require user approval for shell commands and code runs, including full-access
commands. Model review cannot replace that approval; an explicit Allow for now
can cover later shell requests. Scheduled scripts refuse to run in every mode.
Approval in this state does not restore OS containment.

The policy is shared by Rust and the Pi extension through
`backend/pi-runtime/credential-policy.json`; parity tests check both builders.
It does not sandbox the entire daemon or Pi process. Admin-configured stdio
MCP servers and external tool executables are trusted code. Review skills,
connector configuration, and executables before installing or enabling them.
See [the daemon README](backend/hexbot-core/README.md#tool-boundaries) for tool-specific limits.

## Authentication and transport

The daemon listens on loopback by default. LAN access is an explicit setting;
a first Headless installation enables it so another computer can connect.
Pairing codes expire after ten minutes and work once. Paired devices receive
revocable tokens, stored hashed by the daemon. Users and rooms have ownership
and membership checks; a session identifier is not authorization.

Proof-capable clients can bind a token to a DPoP key. Browser cookie sessions
and older clients can be unbound. DPoP reduces token replay; it does not encrypt
traffic or protect a page delivered by an active HTTP intermediary. Plain LAN
HTTP exposes sign-ins and conversation contents to anyone able to intercept
that connection. Use a trusted network, Tailscale, or HTTPS, including Hex
Connect, and do not forward the daemon port directly to the internet.
See [authentication](docs/auth.md) and [deployment](docs/deploy.md).

Provider credentials are local files protected by directory and file permissions,
not encrypted by an OS keychain. Same-user malware and unprotected backups can
read them. The daemon and its configured providers must be trusted with these keys.

Installers validate archive paths, reject links, enforce size limits, and verify
download checksums. Install and native daemon manifests carry Ed25519 release
signatures. The installer and native updater refuse an untrusted manifest;
its signed checksums then pin the packages. Controlling the update origin,
its TLS, or `HEXBOT_UPDATE_URL` cannot replace packages accepted by an
already-trusted installer or native updater. Update URLs require HTTPS.
The Python handoff verifies native manifests only after the legacy updater
has downloaded and run the handoff package.

Not covered by those signatures:

- The legacy `daemon/hexbot-src-<version>.tar.gz` handoff source package.
  It trusts HTTPS and executes before the native signature check, so that
  check does not authenticate the handoff package itself.
- The terminal installer script, its `.txt` index, and initial installer
  download. The script follows no redirects but still trusts HTTPS to
  `hexbot.app` and the update server.
- Electron app update feeds. macOS updates rely on code signing;
  Linux AppImage updates use checksums only.

See [release signing](docs/release.md#update-signing) for key rotation and
mirror support.

## Report scope

Report sandbox escapes in Auto or Manual, unauthorized daemon or Connect
access, failures of user/room ownership checks, credential leaks across the
documented boundary, unsafe renderer access to privileged Electron operations,
and installer path or archive-validation bypasses.

Prompt injection alone, expected access in Bypass or after an approved
escalation, malicious admin-installed executables, and attacks requiring
pre-existing control of the host account are not containment failures. Report
practical chains that cross a boundary, not just an instruction a model followed.
Hardening proposals and documentation corrections are welcome as regular issues
or pull requests. Third-party service vulnerabilities belong with those providers.

## Disclosure

The coordinated disclosure window is 90 days from the report or until a fix is
released, whichever comes first. Reporters are credited in release notes unless
they request anonymity. Keep reproduction details private while a fix is prepared.
