---
layout: ../../layouts/Docs.astro
title: Approvals and Auto mode
description: Choose when Hexbot may approve tool actions.
---

Tools can read files, run commands, use a browser, and change data. Approval mode controls how Hexbot handles actions that need permission.

## Manual

Manual is the default. Hexbot asks before a protected action. Depending on the request, you can allow it once, allow similar actions for the section, always allow it, or deny it.

Python code execution always asks in Manual mode. Auto mode asks its approver first and falls back to your decision. Off skips this prompt. Obvious commands that destroy the system stay blocked in every mode.

Read the requested command and target before approving. A familiar tool can still perform a destructive action when given broad arguments.

## Auto mode

Auto mode asks a separate small model to judge low-risk approval requests. It reduces interruptions during routine work, but it is not a security boundary and can make a bad decision.

Use Auto mode only when you trust the task, files, configured tools, and selected auto-approver model. Keep backups for data that matters. Hexbot still presents higher-risk actions for manual review when policy requires it.

Provider charges apply to auto-approver requests too.

## Off

Off disables approval prompts where the configured policy permits that behavior. This grants the agent more freedom and more room to make damaging changes. Reserve it for isolated environments you can rebuild.

## A practical default

Start with Manual. Grant section-scoped approval for repeated, well-understood work. Try Auto mode only after you understand what the bot's tools can reach. Revoke persistent approvals when a project or device changes hands.

## Credential and browser access

On macOS, shell, Python, and scheduled scripts cannot read Hexbot credential files, including device tokens in `desktop-data/`. They cannot write the Hexbot home except the artifact and attachment folders. Hexbot refuses a workspace or bot working directory inside its home, symlinks included. File tools keep the same home write protection in every approval mode. The default workspace at `~/Hexbot` stays writable. If the operating system cannot apply isolation, the command fails. Linux uses bubblewrap after a successful startup probe.

If bubblewrap is missing or cannot start, Hexbot has no OS sandbox: a shell command, Python code, or a script can read any file you can, including credentials. Hexbot logs a warning at startup, Settings, Approvals shows a notice, and Manual and Auto stop assuming the protection. Manual asks before every shell command and every Python code run. Auto sends them to you instead of its approver. Session approval quiets the shell prompt for one section; always allow does not persist it. Scheduled scripts do not run until you install bubblewrap or set approval mode to Off. Hexbot checks for bubblewrap when the daemon and each section start, so restart the daemon after installing it. On Ubuntu 24.04 and later, the package alone is not enough: bubblewrap also needs the AppArmor profile from [Install](/docs/install/#ubuntu-2404-and-later). Off runs commands without isolation, as it always did.

File tools never write credential stores: `~/.netrc`, `~/.pgpass`, `~/.npmrc`, `~/.pypirc`, `~/.git-credentials`, `~/.aws`, `~/.gnupg`, `~/.kube`, `~/.docker`, `~/.azure`, `~/.config/gh` and `~/.config/gcloud`. The OS sandbox also denies writes there for shell commands, Python, and scheduled scripts. macOS protects these names even before they exist, and keeps `~/.config` in place so a nested store cannot be renamed out of reach; Linux binds existing stores read-only. A shell command that names a store, for reading or writing and including interpreter one-liners, asks in Manual and Auto. Without a working OS sandbox, the shell scanner can only refuse writes it recognises. On Linux, a store that does not exist yet has no bind: in Off mode a command can create it, for example `touch ~/.npmrc` or a Python one-liner, so keep Off for environments you can rebuild.

Writing a shell profile, `~/.gitconfig`, a launch agent, an autostart or systemd user unit asks in Manual and Auto. Bash writes under `/etc` and `/private/etc` also ask, so `sudo` system administration stays possible once approved. File tools refuse writes under `/etc` and `/private/etc` in every mode.

SSH files are private unless they are config, known hosts, authorized keys, or public keys. Commands can use your SSH agent for Git without reading private keys. Direct `ssh`, `ssh-copy-id`, `autossh`, `scp`, `sftp`, and `rsync` commands to a remote host ask in Manual and Auto, because the agent would unlock that host too.

Scheduled scripts must live in the bot scripts folder or workspace and run without provider credentials. When a bot schedules an absolute script path, Manual and Auto ask the section owner for approval. A job that watches a URL follows the same network rules as the web tools.

Navigation and page actions require a local browser managed by Hexbot. Browsers connected through a debugging address or a cloud provider support inspection only until network interception is available. Browser code execution is unavailable without interception. Allowing private URLs still blocks cloud metadata and the daemon's own listener.

Bot-specific browser settings override matching fields in the daemon settings. Other nested browser fields keep their daemon defaults. A bot's explicit private-URL setting takes precedence over the daemon's setting.
