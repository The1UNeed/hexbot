---
layout: ../../layouts/Docs.astro
title: Memory
description: Learn what Hexbot remembers and where that memory belongs.
---

Each bot has its own soul and memory. About you is shared by all of your bots, and a room can keep shared memory through its daily dream.

## Soul

A bot's soul is who it is: how it behaves and speaks. You edit it in the bot's settings under Soul. The bot may edit it too, when you ask it to change or when it learns how you want it to work, and it tells you when it does. The bot's chat picks up a change to the soul after it next summarises older messages, as described below.

## Memory

A bot's memory is what it has learned: facts, preferences, and lessons about working with you. The bot writes it on its own during a conversation. It is short by design, so the bot keeps it dense rather than long. You can read and edit it in the bot's settings under Memory.

Each entry the bot adds or replaces ends with the month it learned it, such as `[2026-10]`, so a dream can tell an old entry from a current one. Hexbot adds the stamp when the bot adds or replaces an entry, leaving headings, rules, blank lines, and fenced code alone. When the bot rewrites its whole memory at once, as a dream may, and when you edit it in the editor, the text is saved as written. A dream is asked to date new or merged entries during a whole-memory rewrite and keep dates on unchanged entries. An entry without a stamp is treated as yours or as older than stamps, and a dream judges it on what it says. A scheduled job running on its own cannot write memory; what it asks for waits as a proposal for the bot's next dream (see [Scheduled work](/docs/scheduling/#jobs-and-memory)).

## Notes

Beside its memory, a bot keeps notes: a short line here and there about what happened, filed by day. It writes one at a natural pause, when something is worth keeping, and can read a day or a few days back when it needs them. Adding a note returns a short confirmation. The full day stays out of the conversation unless the bot reads it. Each night the bot's [dream](/docs/dreaming/) reads the notes from the day its last successful dream started first, folds what lasts into memory, and leaves the rest. A day's notes hold up to 4,000 characters, and days older than 30 days are removed when notes are read, listed, or added, or when a dream runs.

You can read, edit, and delete notes by day in the bot's settings under Memory. If the bot appends new lines while you edit, Hexbot saves your edit with those lines kept below it. Other changes leave your draft in the editor and show an error; copy it before reloading. You cannot save notes for a future day or a day older than 30 days. Deleting a day also checks that its notes have not changed since you loaded them. If they have, Hexbot refreshes the list, keeps your selected day and draft, shows an error, and shows what changed below the editor so you can review it before trying again. Saving that draft works like any other save: added lines are kept below your edit.

When a bot writes to its memory, its notes, or its soul during a conversation, nothing appears in the conversation. To see what changed, open the bot's settings, or the Computer tab in the side panel.

Hexbot includes each bot's own memory in its starting prompt. Each bot also has searchable history over its chat, from before the chat's latest summary, and the rooms it belongs to.

The chat reads the current soul, memory, and About you text into its starting context and picks up changes after Hexbot compacts it, usually from your next message. If the bot is still working when it compacts, it keeps the earlier text until the next compaction. A change to the bot's tools or connectors, or an update that changes Hexbot's tools, also brings the current text in from your next message. In-conversation memory edits remain part of the conversation that made them.

A chat is never archived or deleted on its own. The bot's memory and notes stay as they are until you or a dream edit them. Deleting a bot deletes its chat and notes with it; treat that as permanent.

## About you

About you is one text that every bot you own reads: your name, what you do, and how you like to be spoken to. Only you write it. Hexbot asks for it once, at the first startup: your name, what you do, and how bots should talk to you. After that it lives in Settings under Memory.

Put durable facts there, such as preferred units or a standing rule. Do not use memory as a password store.

## Dreaming

Dreaming is a daily pass that folds a bot's recent notes and conversations into its memory. Read [Dreaming](/docs/dreaming/) for scheduling and room memory.

## Backups

Memory lives with the daemon under `~/.hexbot`, not on this website. Stop the daemon before copying its complete data directory for a backup. Anyone who can read that directory may be able to read stored conversations and memory. See [Install](/docs/install/#data-and-updates) for data and workspace locations.
