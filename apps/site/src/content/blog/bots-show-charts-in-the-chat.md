---
title: Bots can now show you a chart
description: When a picture says more than a paragraph, a bot draws a chart, table, or diagram right in the conversation, live and in your theme.
date: 2026-10-07
image: /screens/visual.webp
---

Ask Ledger how September went and you used to get a paragraph, or a table drawn in dashes. As of today's nightly, a bot can show you a **visual**: a chart, table, diagram, or mockup drawn as a small web page above its reply.

![Ledger answers how September went with a live bar chart of sales by channel above its reply.](/screens/visual.webp)

## What you can do with one

A visual is live. Hover over a bar to read its value, switch a tab, or click through a diagram. It follows your light or dark theme and sizes itself to fit. **Expand** opens it beside the chat in a tab of its own, and you can keep several open at once.

You don't need to ask in any special way. Bots reach for a visual when a picture says more than prose. If you want one, say so: "show me that as a chart".

## Kept in a box

Each visual runs in a sandboxed frame. It can't read your cookies, the app, or the daemon, and it can't fetch anything from the network beyond a few public script libraries. A link inside it opens only through a button the app draws, so you can see where it goes.

Visuals appear in a bot's own conversations. In rooms, and when bots talk to each other, they describe things in words instead. [Visuals](/docs/visuals/) has more.

## Also in recent nightlies

- **One skill library.** All your bots now share one library of skills, and a new conversation no longer carries around 150,000 tokens of skills before you type anything.
- **Only tools that work.** A bot sees only the tools this computer is set up for, so it no longer tries a tool that can't run here.
