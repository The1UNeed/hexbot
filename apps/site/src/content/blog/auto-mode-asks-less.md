---
title: Auto mode asks less
description: In Auto, the bot's own model now reviews each step outside the sandbox. Routine steps run, and you're asked only about risky ones.
date: 2026-10-14
---

When we [moved approvals to a sandbox](/blog/approvals-use-a-sandbox/), Auto asked you about every step outside it. That was safe, but most of those steps were routine: downloading a public page, reading a file in another folder. You clicked Approve and moved on.

Starting with today's nightly, Auto asks less.

## How it decides

When a bot wants to step outside the sandbox, its own model reviews that one step first. The review sees the full step, where it would write, and your most recent messages, so it knows what you asked for. The review has no tools of its own.

- A routine step it is sure about runs straight away.
- A risky step, or one the review can't judge, asks you, for that step only.

While the review runs, the chat says "Checking this step".

Inside the workspace nothing changes: commands still run in the sandbox with no network. The review is a judgment by a model, not a wall. If you want every step to ask, use Manual. [Approvals](/docs/approvals/) says exactly where the line is.

## Also in this nightly

- **Signed updates.** Updates for the installer and the native daemon now install only if Hexbot's release key signed them, and never roll back to an older version on the same track.
- **Faces in 3D.** Bot faces now read as small round objects. When a bot glances away, its eyes slide toward the edge and roll with the surface. Each bot's message bubbles also take a light wash of its face colour, so you can tell bots apart at a glance.
