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

On macOS, shell, Python, and scheduled scripts cannot read Hexbot credential files, including device tokens in `desktop-data/`. They cannot write the Hexbot home except the section workspace and artifact or attachment folders. File tools keep the same home write protection in every approval mode. The default workspace at `~/Hexbot` stays writable. If the operating system cannot apply isolation, the command fails. Linux uses bubblewrap after a successful startup probe. If bubblewrap is missing or cannot start, Hexbot warns and keeps the command approval guards.

SSH private keys named `id_*` except `.pub`, `*.pem`, or `*.key` are protected. SSH config, known hosts, and public keys remain readable. Commands can use your SSH agent for Git without reading private keys.

Scheduled scripts must live in the bot scripts folder or workspace and run without provider credentials. When a bot schedules an absolute script path, Manual and Auto ask the section owner for approval.

Navigation and page actions require a local browser managed by Hexbot. Browsers connected through a debugging address or a cloud provider support inspection only until network interception is available. Browser code execution is unavailable without interception. Allowing private URLs still blocks cloud metadata and the daemon's own listener.
