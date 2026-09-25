---
layout: ../../layouts/Docs.astro
title: Memory
description: Learn what Hexbot remembers and where that memory belongs.
---

Each bot keeps two files of its own. One text about you is shared by all of your bots. That is the whole system.

## Soul

A bot's soul is who it is: how it behaves and speaks. You edit it in the bot's settings under Soul. The bot may edit it too, when you ask it to change or when it learns how you want it to work, and it tells you when it does. A change to the soul applies from the next section you start.

## Memory

A bot's memory is what it has learned: facts, preferences, and lessons about working with you. The bot writes it on its own during a conversation. It is short by design, so the bot keeps it dense rather than long. You can read and edit it in the bot's settings under Memory.

Whenever a bot writes to its memory or its soul during a conversation, a small "Memory updated" or "Soul updated" mark appears under its reply. Open it to see what changed.

Other bots do not see it. Each bot also has searchable history over its own sections and the rooms it belongs to. Starting a new section gives the conversation a new context window without erasing that history.

Archiving a section hides it from the active list. Deleting a section removes the conversation and its history. The bot's memory stays as it is; edit it yourself if something should go. Treat deletion as permanent.

## About you

About you is one text that every bot you own reads: your name, what you do, and how you like to be spoken to. Only you write it. Hexbot asks for it once, at the first startup: your name, what you do, and how bots should talk to you. After that it lives in Settings under Memory.

Put durable facts there, such as preferred units or a standing rule. Do not use memory as a password store.

## Dreaming

Dreaming is a daily pass that folds a bot's recent conversations into its memory. Read [Dreaming](/docs/dreaming/) for scheduling and room memory.

## Backups

Memory lives with the daemon under `~/.hexbot`, not on this website. Back up the daemon's data directory if you depend on its history. Anyone who can read that directory may be able to read stored conversations and memory.
