---
layout: ../../layouts/Docs.astro
title: Approvals and Auto mode
description: Choose when Hexbot may approve tool actions.
---

Tools can read files, run commands, use a browser, and change data. Approval mode controls how Hexbot handles actions that need permission.

## Manual

Manual is the default. Hexbot asks before a protected action. Depending on the request, you can allow it once, allow similar actions for the section, always allow it, or deny it.

Read the requested command and target before approving. A familiar tool can still perform a destructive action when given broad arguments.

## Auto mode

Auto mode asks a separate small model to judge low-risk approval requests. It reduces interruptions during routine work, but it is not a security boundary and can make a bad decision.

Use Auto mode only when you trust the task, files, configured tools, and selected auto-approver model. Keep backups for data that matters. Hexbot still presents higher-risk actions for manual review when policy requires it.

Provider charges apply to auto-approver requests too.

## Off

Off disables approval prompts where the configured policy permits that behavior. This grants the agent more freedom and more room to make damaging changes. Reserve it for isolated environments you can rebuild.

## A practical default

Start with Manual. Grant section-scoped approval for repeated, well-understood work. Try Auto mode only after you understand what the bot's tools can reach. Revoke persistent approvals when a project or device changes hands.
