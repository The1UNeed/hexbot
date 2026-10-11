---
layout: ../../layouts/Docs.astro
title: Approvals
description: Choose when Hexbot asks before a bot acts.
---

Bots read files, run commands, use a browser, and change data. The approval mode decides which of those happen on their own and which wait for you. Hexbot follows Codex and Claude Code: an operating-system sandbox is the boundary, and in Auto a quick check by the bot's model decides which steps outside it need you. Set the mode in Settings, Approvals; a bot or a room can override it.

The **workspace** is the bot's working directory (`~/Hexbot` by default) plus its artifact and attachment folders and the temp folders.

## Auto

Auto is the default. Bots work freely inside the workspace, and only risky steps outside it ask.

- Shell commands run in a sandbox with no internet access and no access to local service sockets, and can write only inside the workspace. They cannot signal your other programs, and they can start only a few hundred processes, so a runaway loop stops there. Shell profiles and login items stay read-only even there; on Linux, a profile that does not exist yet is not protected when the workspace holds your home folder, and a service socket inside your home folder stays reachable (the ones in `/run` and `/tmp` are hidden).
- When a command needs the internet or must write outside the workspace, the bot says so with a one-sentence reason. Before it runs outside the workspace sandbox, the section's model reviews the step against your messages in the section. Routine work toward what you asked runs without a card: reading or downloading public pages, saving into the workspace or a temp folder, installing packages, builds and tests, pushing a feature branch. Risky steps show a card with the command, the bot's reason and why it was stopped: deleting or overwriting data outside the workspace, force pushes or pushes to main, running downloaded code, sending private data or credentials anywhere, changing system settings or credentials, deploying, publishing, sending messages or paying. Credential files stay unreadable either way.
- The same check covers file changes outside the workspace, connected tools that change something, and browser page scripts. File-tool changes to shell profiles and login items go directly to user approval, subject to an explicit section grant. A full-access shell command that changes them goes through model review and can run without a card when you requested that exact change. File and browser steps a code run asks for through Hexbot's tools also use user approval.
- A card from the check is approved one step at a time, so approving one risky step does not let the next through, and Allow in this section from Manual does not carry over. The reviewer reads your complete messages and the whole step, including the working directory and resolved file destination. It loads no project instructions, skills or tools. If the check fails, takes over a minute, or the evidence is too long to read whole, the card appears as usual. It checks your messages again before allowing the step. Changed messages or queued prompts and steers invalidate automatic approval and produce a card. Changing the mode or working directory while it checks stops the step; a file create also stops if the destination has appeared before execution. Reported reviewer usage counts toward section, room and daily totals.
- The check reads only your messages and the whole step, not web pages, files or the bot's replies, so text a bot reads cannot approve its own step. In a room it reads only your own messages there, not other people's. It is a judgment, not a guarantee: choose Manual when you want to see every step.
- File tools change files inside the workspace without asking.
- Python code and scheduled scripts run in the same workspace sandbox without asking. Scheduling a script by an absolute path asks.
- Reads are free everywhere except credential files, which stay private.

Copilot ACP reviews use an empty working directory and a separate temporary
home, including the Copilot and XDG settings folders. They keep explicitly
configured GitHub login tokens, but do not import your saved Copilot CLI login
or configuration. If the CLI needs that stored login, or an older or custom
ACP command rejects the required isolation flags, Auto shows a one-step card
instead. Configured ACP arguments beyond `--acp` and `--stdio` also fall back
to a card. Copilot ACP currently reports zero token usage and cost, so its
reviews add no measured usage to budgets or totals. Ordinary ACP chat keeps
its existing login behavior.

## Manual

Manual is for work you want to watch closely. Reads are free; every change asks.

- Shell commands run in a read-only sandbox with no internet access, without asking. A command that needs to write or reach the internet asks first, with the bot's reason.
- Every file change asks. Every code run asks, then runs in the workspace sandbox.
- Browser page scripts and absolute-path scheduled scripts ask.

## Bypass

Bypass is plain Pi, the agent runtime: no prompts, no sandbox, no credential checks. Bots can read and change anything the daemon's user account can, including Hexbot's own credential files and provider keys. Scheduled jobs and their delegates run in Auto instead, including scheduled scripts. Reserve it for a machine you can rebuild.

## Connected tools

In new sections, bots call connected tools from short scripts they run. Manual
asks for every connected-tool call. Auto runs tools marked read-only freely and
checks the others first, asking only when a call looks risky. Bypass never asks. Reading a resource needs no approval.
In Manual, Allow in this section covers that server while the section's agent
process runs. Auto reviews each changing call again; its cards offer Approve
and Deny only.
Shell and file calls inside a script still follow their usual approval rules.
Removing or turning off a server stops its tools at once, even in open sections.

Connected servers are trusted code you configure. They run outside
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

Each card shows the command or action and why it asks. Approve runs it once. Deny stops it, and the bot sees that you declined. Reviewed Auto cards offer only those two choices.

When a Manual or unreviewed card offers Allow in this section, it stops asking for that kind of request while the section's agent process runs. For example, Manual can grant full-access commands, outside file changes, or one connected server. In Auto, unreviewed shell requests without a sandbox and host-configuration file requests can offer a section grant. These grants never cover reviewed Auto steps. Nothing is saved across sections. Incomplete file scans and requests the daemon raises itself, such as code runs, browser scripts and scheduling, offer Approve and Deny only.

Delegates and background sections cannot wait for approval; actions that need it are refused.

Read the command and the reason before approving. A familiar tool can still do damage with broad arguments.

## Credential and browser access

In Manual and Auto, shell commands, Python code, and scheduled scripts cannot read Hexbot credential files, including device tokens in `desktop-data/`. They cannot write the Hexbot home except the artifact and attachment folders. Hexbot refuses a workspace or bot working directory inside its home, symlinks included. The default workspace at `~/Hexbot` stays writable. On macOS the sandbox is `sandbox-exec`; if the operating system cannot apply the profile, the command fails. Linux uses bubblewrap after a successful startup probe.

If bubblewrap is missing or cannot start, Hexbot has no OS sandbox: a shell command or Python code can read any file you can, including credentials. Hexbot logs a warning at startup and Settings, Approvals shows a notice. Manual and Auto then require user approval for shell commands and code runs, including full-access commands; model review cannot replace that approval. Allow in this section can quiet the shell prompt while the section's agent process runs. Scheduled scripts refuse to run until you install bubblewrap. Hexbot checks for bubblewrap when the daemon and each section start, so restart the daemon after installing it. On Ubuntu 24.04 and later, the package alone is not enough: bubblewrap also needs the AppArmor profile from [Install](/docs/install/#ubuntu-2404-and-later).

Credential stores stay private in Manual and Auto: `~/.netrc`, `~/.pgpass`, `~/.npmrc`, `~/.pypirc`, `~/.git-credentials`, `~/.aws`, `~/.gnupg`, `~/.kube`, `~/.docker`, `~/.azure`, `~/.config/gh` and `~/.config/gcloud`. The file tools neither read nor write them, and the workspace sandbox hides them from every program a command starts. A command you approve for full access can read them, since tools like `aws` or `gh` need their keys, but it still cannot write them. macOS protects these names even before they exist and keeps `~/.config` in place so a nested store cannot be renamed out of reach. Linux protects stores that exist when a command or code run starts; a store that does not exist yet can be created by a full-access command, or by any command when the workspace holds your home folder, and one created later stays visible to a code run that is still going.

Project secrets and browser data are private the same way. Files named `.env`, `.envrc` or `.env.<anything>` (but not `.env.example`, `.env.sample`, `.env.template` or `.env.dist`), your keychains, and browser profiles, which hold cookies and saved passwords, are unreadable and unwritable to the file tools and to sandboxed commands. Browser protection includes Chrome Beta/unstable and Snap and Flatpak profiles. macOS also refuses secret and browser-store renames, including their scanned ancestors. When a bot needs a `.env` to run something, it asks for full access. On Linux the sandbox hides `.env` files that exist in the workspace, up to three folders deep, when a command starts.

Git metadata (`.git`, linked `gitdir` and `commondir` targets, bare `*.git` repositories with `HEAD` and `objects`, and `core.hooksPath` directories set by the repository or your own Git config) is read-only inside the sandbox within the scan limits below. File tools also refuse writes there. A bot changes protected metadata with a full-access command, which Auto reviews and Manual asks about first. Tracked hook scripts remain writable unless selected by a configured `core.hooksPath` or a `hooks` link in the Git metadata, and edits appear in `git status`. Review them before running them. When `hooks`, `config`, `config.worktree` or `commondir` in the Git metadata is a symbolic link to something in the workspace, that target is read-only too.

Linux protects repositories that exist when a command starts. Repositories created during a command are not protected on Linux. macOS filename rules also cover new `.git` metadata directories. Bare `*.git` repositories must exist when the scan starts on either platform. The scan visits workspace and output roots breadth-first through three nested folders, skips dependency/runtime folders and shared temporary roots, and has a 1,000-directory budget. It also reads at most 50,000 entries in the folders it visits. Only Linux bubblewrap commands refuse to run when a budget is exhausted and require an approved full-access retry. For `execute_code`, choose a smaller workspace or run the Python code through the terminal tool with `full_access` and a reason; a scheduled script needs a smaller workspace. Linux repositories and secrets beyond these scan limits are not covered. Manual scans read-only workspaces too and resolves secret symlinks. macOS and file tools use partial results when the budget is reached. File changes ask for approval in Auto mode when the scan is incomplete, every time: that approval covers one change and is never remembered for the section. The cwd-ancestor Git pointer walk is unbudgeted, and macOS `.git` and secret filename rules still apply. File tools ask for approval if Git configuration or a directory cannot be scanned. Repository configs and their includes are parsed with the system Git at `/usr/bin/git`; without it, a repository with a config counts as unreadable. Your own Git config and its includes are read too, from the files Git reads: `$GIT_CONFIG_GLOBAL`, or `~/.gitconfig` and `$XDG_CONFIG_HOME/git/config`, and `$GIT_CONFIG_SYSTEM` or `/etc/gitconfig` and Homebrew's `/opt/homebrew/etc/gitconfig` and `/usr/local/etc/gitconfig` unless `GIT_CONFIG_NOSYSTEM` is set. A Git build that keeps its system config elsewhere, such as Xcode's, is not read. A hooks path your config sets, such as `.githooks`, is protected in every scanned repository. Each config file is read once per scan, and a scan that meets more than 64 included files beyond the repository and user configs for one repository, more than 256 in all, or more than 10,000 settings, counts as unreadable and says which limit it reached. Included files and configured hook paths inside the workspace or an output folder are protected, with their ancestors up to that folder. Ones outside are already read-only to sandboxed commands; a hook path that contains the workspace, such as `/` or the home folder, is ignored. FIFOs and other special files in Git metadata stay locked and are never read. On Linux a configured hooks folder or included file that does not exist yet is locked through its nearest existing parent inside a repository, such as `.husky` for a missing `.husky/_`. When that parent would be a repository's own folder, the workspace or an output folder, and is not already protected as Git metadata, the command asks for approval instead of making all of it read-only. A dangling link names the folder or file it points to. The reason names every missing target and one command that creates them (`mkdir -p` for folders, `touch` for included files), and after that commands run in the sandbox again. A `.git` entry, hooks folder or included file reached through a symbolic link inside the workspace asks the same way on Linux, until the link is replaced by what it points to, and `hooks-link/../hooks` counts as reaching through `hooks-link`. A link inside the Git metadata is protected with it and does not ask; a link in the workspace that it passes through, such as `.githooks` for `.git/hooks -> ../.githooks -> store/hooks`, asks. macOS locks the link itself. Python code and scheduled scripts cannot ask, so they stop with the same explanation.

On macOS, sandboxed commands cannot send Apple Events, so they cannot drive Finder or another app.

In Manual, approved Python code runs read-only too. It can write only its own output folder in the Hexbot home.

Shell profiles, `~/.gitconfig`, launch agents, autostart entries and systemd user units are read-only inside the sandbox; file tools use user approval before writing one, subject to an explicit section grant. File tools refuse writes under `/etc` and `/private/etc` in Manual and Auto. Commands that change these settings need full access. Manual asks; Auto reviews them against your request, and can run an exact change you requested without a card. `sudo` system administration stays possible with full access.

SSH private keys are private; config, known hosts, authorized keys, and public keys are not. Commands can use your SSH agent for Git without reading private keys. Reaching a remote host needs full access for the network, so Manual asks and Auto reviews `ssh`, `scp`, `rsync` and similar commands first.

Scheduled scripts must live in the bot scripts folder or workspace and run without provider credentials. A job that watches a URL follows the same network rules as the web tools.

Navigation and page actions require a local browser managed by Hexbot. Browsers connected through a debugging address or a cloud provider support inspection only until network interception is available. Browser code execution is unavailable without interception. Allowing private URLs still blocks cloud metadata and the daemon's own listener.

Bot-specific browser settings override matching fields in the daemon settings. Other nested browser fields keep their daemon defaults. A bot's explicit private-URL setting takes precedence over the daemon's setting.

Manual scheduled scripts cannot write workspace files or artifacts. Only approved `execute_code` runs receive an explicit exception for their own output folder.
