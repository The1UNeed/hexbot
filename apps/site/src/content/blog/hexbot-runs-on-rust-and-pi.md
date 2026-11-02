---
title: Hexbot now runs on Rust and Pi
description: Today's nightly replaces the daemon with a native one written in Rust. Each conversation is now one long-running Pi session, and your bots, rooms, and history stay where they were.
date: 2026-10-02
---

The daemon is the part of Hexbot that runs your bots: their conversations, rooms, memory, tools, and schedules. Until today it was written in Python. As of today's nightly, it is a native program written in Rust, and each conversation runs as one long-running agent session on [Pi](https://github.com/earendil-works/pi).

## What you'll notice

Ideally, nothing. Your bots, rooms, memory, and history stay in the same `~/.hexbot`. The app, the browser, and Hex Connect talk to the new daemon the same way they talked to the old one. Background services you set up earlier move over to the new daemon on their next update.

## What changed underneath

- **One session per conversation.** A conversation keeps the same session from its first message to its last. The start of every request stays the same from turn to turn, so the model provider can reuse its prompt cache instead of reading everything again.
- **A sandbox for commands.** Shell and Python commands a bot runs go through the operating system's sandbox: `sandbox-exec` on macOS, bubblewrap on Linux. They can't read Hexbot's own secrets or your private SSH keys, and they can't write to places where credentials live, such as `~/.aws` or `~/.config/gh`.
- **A sign-in link that works once.** A daemon you start in a terminal prints a one-time sign-in link. It works once and expires after ten minutes. To sign in from another browser, run `hexbot pair`.

As always with a nightly, back up `~/.hexbot` now and then, and [open an issue](https://github.com/The1UNeed/hexbot/issues) with the version from Settings, About if something breaks.
