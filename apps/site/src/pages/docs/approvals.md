---
layout: ../../layouts/Docs.astro
title: Approvals
description: Choose when Hexbot asks before a bot acts.
---

Bots read files, run commands, use a browser, and change data. The approval mode decides which of those happen on their own and which wait for you. Hexbot follows the model of Codex: an operating-system sandbox is the boundary, not a model judging each command and not a list of risky patterns. Set the mode in Settings, Approvals; a bot or a room can override it.

The **workspace** is the bot's working directory (`~/Hexbot` by default) plus its artifact and attachment folders and the temp folders.

## Auto

Auto is the default. Bots work freely inside the workspace and ask before anything outside it.

- Shell commands run in a sandbox with no internet access and no access to local service sockets, and can write only inside the workspace. They cannot signal your other programs, and they can start only a few hundred processes, so a runaway loop stops there. Shell profiles and login items stay read-only even there; on Linux, a profile that does not exist yet is not protected when the workspace holds your home folder, and a service socket inside your home folder stays reachable (the ones in `/run` and `/tmp` are hidden).
- When a command needs the internet or must write outside the workspace, the bot says so. You see a card with the command and the bot's one-sentence reason. If you approve, the command runs outside the workspace sandbox; credential files stay unreadable.
- File tools change files inside the workspace without asking, and ask before changing anything outside it or a shell profile.
- Python code and scheduled scripts run in the same workspace sandbox without asking.
- Browser page scripts ask. Scheduling a script by an absolute path asks.
- Reads are free everywhere except credential files, which stay private.

## Manual

Manual is for work you want to watch closely. Reads are free; every change asks.

- Shell commands run in a read-only sandbox with no internet access, without asking. A command that needs to write or reach the internet asks first, with the bot's reason.
- Every file change asks. Every code run asks, then runs in the workspace sandbox.
- Browser page scripts and absolute-path scheduled scripts ask.

## Bypass

Bypass is plain Pi, the agent runtime: no prompts, no sandbox, no credential checks. Bots can read and change anything the daemon's user account can, including Hexbot's own credential files and provider keys. Only the admin can choose it. A member's bots and rooms run in Auto instead, and so does an admin's bot that a member uses in their own section or room. Reserve it for a machine you can rebuild.

## Connected tools

In new sections, bots call connected tools from short scripts they run. Manual
asks for every connected-tool call. Auto runs tools marked read-only freely and
asks for all others. Bypass never asks. Reading a resource needs no approval.
Allow in this section covers that server while the section's agent process runs.
Shell and file calls inside a script still follow their usual approval rules.
Removing or turning off a server stops its tools at once, even in open sections.

Connected servers are trusted code configured by the admin. They run outside
the shell sandbox, in a daemon-owned directory. Each section starts its own
process per connected server. A server receives its explicit
environment settings and the runtime's allowed environment variables, rather
than every connector key. Add references for any keys it needs. New servers
must use stdio or streamable HTTP; existing SSE servers work only in saved
sections that already used them. Connection problems appear under the
conversation header. The last 2 KB of server stderr may reach the bot in a
connection error.

Removing or disabling a connected server stops further calls in open sections,
even in Bypass. Changing its configuration or credentials blocks the old
connection and reconnects at the next message. The section's prompt and tool
declarations stay fixed. A background section with no visible chat or room
cannot wait for approval; the bot must ask you to run that action in a visible
section.

Codemode scripts cannot use Node, files, or the network directly. Their model
helpers can call provider APIs with the section's credentials and incur costs.

## Answering a card

Each card shows the command or action and why it asks. Approve runs it once. Allow in this section stops asking for that kind of request, for example full-access commands or file changes outside the workspace, until the section ends. Deny stops it, and the bot sees that you declined. Nothing is saved across sections, so a new section starts asking again. Requests the daemon raises itself (code runs, browser scripts, scheduling) offer Approve and Deny only.

Read the command and the reason before approving. A familiar tool can still do damage with broad arguments.

## Credential and browser access

In Manual and Auto, shell commands, Python code, and scheduled scripts cannot read Hexbot credential files, including device tokens in `desktop-data/`. They cannot write the Hexbot home except the artifact and attachment folders. When a shared bot works in someone else's room, its commands and code also cannot read its owner's daily notes, any user's About you, or other sections' history and uploads, and it cannot ask for full access there (see [Multi-user](/docs/multi-user/)). Hexbot refuses a workspace or bot working directory inside its home, symlinks included. The default workspace at `~/Hexbot` stays writable. On macOS the sandbox is `sandbox-exec`; if the operating system cannot apply the profile, the command fails. Linux uses bubblewrap after a successful startup probe.

If bubblewrap is missing or cannot start, Hexbot has no OS sandbox: a shell command, Python code, or a script can read any file you can, including credentials. Hexbot logs a warning at startup and Settings, Approvals shows a notice. Manual and Auto then ask before every shell command and every code run; Allow in this section quiets the shell prompt for one section. A shared bot in someone else's room is not offered that choice: its commands and code are refused until the sandbox is back. Scheduled scripts run only in Bypass until you install bubblewrap. Hexbot checks for bubblewrap when the daemon and each section start, so restart the daemon after installing it. On Ubuntu 24.04 and later, the package alone is not enough: bubblewrap also needs the AppArmor profile from [Install](/docs/install/#ubuntu-2404-and-later).

Credential stores stay private in Manual and Auto: `~/.netrc`, `~/.pgpass`, `~/.npmrc`, `~/.pypirc`, `~/.git-credentials`, `~/.aws`, `~/.gnupg`, `~/.kube`, `~/.docker`, `~/.azure`, `~/.config/gh` and `~/.config/gcloud`. The file tools neither read nor write them, and the workspace sandbox hides them from every program a command starts. A command you approve for full access can read them, since tools like `aws` or `gh` need their keys, but it still cannot write them. macOS protects these names even before they exist and keeps `~/.config` in place so a nested store cannot be renamed out of reach. Linux protects stores that exist when a command or code run starts; a store that does not exist yet can be created by a full-access command, or by any command when the workspace holds your home folder, and one created later stays visible to a code run that is still going.

Shell profiles, `~/.gitconfig`, launch agents, autostart entries and systemd user units are read-only inside the sandbox; a file tool asks before writing one. File tools refuse writes under `/etc` and `/private/etc` in Manual and Auto; a command that writes there needs full access, so it asks, and `sudo` system administration stays possible once approved.

SSH private keys are private; config, known hosts, authorized keys, and public keys are not. Commands can use your SSH agent for Git without reading private keys. Reaching a remote host needs the network, so `ssh`, `scp`, `rsync` and the like ask in Manual and Auto.

Scheduled scripts must live in the bot scripts folder or workspace and run without provider credentials. A job that watches a URL follows the same network rules as the web tools.

Navigation and page actions require a local browser managed by Hexbot. Browsers connected through a debugging address or a cloud provider support inspection only until network interception is available. Browser code execution is unavailable without interception. Allowing private URLs still blocks cloud metadata and the daemon's own listener.

Bot-specific browser settings override matching fields in the daemon settings. Other nested browser fields keep their daemon defaults. A bot's explicit private-URL setting takes precedence over the daemon's setting.
