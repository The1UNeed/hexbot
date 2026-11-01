---
title: Every bot has a heartbeat
description: Every 30 minutes, day and night, each bot works through a checklist you give it, and writes to you only when something needs you.
date: 2026-10-28
image: /screens/heartbeat.webp
---

Most assistants wait for you to ask. Starting with today's nightly, your bots don't have to.

## A checklist, every 30 minutes

Every bot now has a **heartbeat**: a checklist, `HEARTBEAT.md` in its profile, that it works through every 30 minutes, day and night. Scout's might read:

```md
- Has Sam replied about the studio lease?
- Is the clay delivery still on for Friday?
- Has the kiln element dropped below $300?
- Did anything on my calendar change today?
```

For each line, the bot looks in its memory and notes, its files, its connectors (your email, calendar, or Notion), and the web. It doesn't read your chat.

![Scout adds a line to its heartbeat when Maya asks to hear about the lease, then writes when Sam replies.](/screens/heartbeat.webp)

## Quiet unless it matters

Most heartbeats end without a word. When something needs you, the bot writes one short message in its chat, with what you need to act on it, and a notification reaches your app, your browser, and your phone. A bot sends at most one message per heartbeat and eight a day.

## Easy to keep

Edit the checklist in the bot's **Heartbeat** tab, or just tell the bot in its chat: "let me know when Sam replies". It adds the line, and takes it off once it's settled. From a terminal, `hexbot heartbeat set` does the same.

A heartbeat only looks. It can't run commands, write files, change anything through a connector, or ask you questions. While a checklist is empty, the heartbeat doesn't run and costs nothing. One switch in Settings turns heartbeats on or off for every bot. See [Heartbeat](/docs/bots-and-sections/#heartbeat).

## Also in this nightly

- **Diagnostics.** Settings has a new Advanced group with a **Diagnostics** page: launch time, CPU and memory over the last hour, a timeline for every run, recent failures, and prompt cache hit rates. **Copy report** saves it for a bug report, and `hexbot diagnostics` prints the same from a terminal. See [Diagnostics](/docs/diagnostics/).
- **The computer over Hex Connect.** The bots' computer now plays over Hex Connect instead of showing a black screen. A quality menu sets the stream, and **Auto** stays as sharp as your connection allows, never below 720p at 30 fps.
- **A lighter web app.** Browsers now download a web app about 70% smaller, and don't check it again on every visit.
