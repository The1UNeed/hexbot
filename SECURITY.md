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
  Git's own folders (`.git`) stay read-only inside them, so a sandboxed
  command cannot plant a hook or config that runs on your next commit; a bot
  commits, inits, or clones with an approved `full_access` command. Project
  secrets such as `.env`, keychains, and browser profiles (cookies, saved
  passwords) are unreadable. Apple Events are refused, so a command cannot
  drive Finder or another app. Other files outside the workspace can still be
  read.
- Manual uses a read-only shell/code sandbox and asks before file changes.
  Approved code can write only its own output folder in the Hexbot home.
- An approved `full_access` shell command leaves the workspace restrictions.
  The base credential-path and Hexbot-home protections still apply. Review both
  the command and its reason before granting more access.
- Bypass removes prompts and sandboxing and is available only to the admin.

macOS fails closed when its sandbox cannot start. On Linux, if bubblewrap is
missing or unusable, Hexbot reports the missing isolation and Auto and Manual
ask before every shell command and code run. Scheduled scripts then run only
in Bypass. Approval in this state does not restore OS containment.

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
download checksums. Checksums detect corruption; unsigned native manifests
still trust HTTPS and write access to the update origin. Manifest signing needs
independent release-key provisioning. See [the update API](docs/api.md).

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
