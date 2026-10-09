---
layout: ../../layouts/Docs.astro
title: Memory
description: Learn what Hexbot remembers and where that memory belongs.
---

Each bot has its own soul and memory. About you is shared by all of your bots, and a room can keep shared memory through its daily dream.

## Soul

A bot's soul is who it is: how it behaves and speaks. You edit it in the bot's settings under Soul. The bot may edit it too, when you ask it to change or when it learns how you want it to work, and it tells you when it does. A change to the soul applies from the next section you start. Long sections can also pick it up after compaction, as described below.

## Memory

A bot's memory is what it has learned: facts, preferences, and lessons about working with you. The bot writes it on its own during a conversation. It is short by design, so the bot keeps it dense rather than long. You can read and edit it in the bot's settings under Memory.

Each entry the bot writes ends with the month it learned it, such as `[2026-10]`, so a dream can tell an old note from a current one. Hexbot adds the stamp when the bot writes; entries you type in the editor are saved as you wrote them. A scheduled job running on its own cannot write memory; what it asks for waits as a proposal for the bot's next dream (see [Scheduled work](/docs/scheduling/#jobs-and-memory)).

## Notes

Beside its memory, a bot keeps notes: a short line here and there about what happened, filed by day. It writes one at a natural pause, when something is worth keeping, and can read a day or a few days back when it needs them. Notes stay out of its conversations unless it reads them, so they cost nothing while they sit there. Each night the bot's [dream](/docs/dreaming/) reads the notes since its last dream first, folds what lasts into memory, and leaves the rest. A day's notes hold up to 4,000 characters, and days older than 30 days are removed.

You can read, edit, and delete notes by day in the bot's settings under Memory. If the bot adds a note while you are editing that day, Hexbot keeps the bot's line and asks you to try again with the reloaded text. A bot shared into someone else's room cannot read your notes there, with its memory tool or its file tools, just as it does not see your About you.

Whenever a bot writes to its memory, its notes, or its soul during a conversation, a small "Memory updated", "Note added", or "Soul updated" mark appears under its reply. Open it to see what changed.

Hexbot includes a bot's own memory in its starting prompt, rather than another bot's notes. Each bot also has searchable history over its own sections and the rooms it belongs to. Starting a new section gives the conversation a new context window without erasing that history. These ownership rules do not isolate local files from enabled file and terminal tools; see [Multi-user](/docs/multi-user/) before sharing a daemon.

A new section reads the current soul, memory, and About you text into its starting context. Sections started with prompt refresh support can read the current text after compaction, provided the next model request starts a new run. If the bot continues its current run first, the section keeps its prompt until another compaction. Older sections keep their starting prompt, as do sections whose fixed guidance or tool layout no longer matches after an update. After editing these settings, start a new section when you need the bot to begin with the updated text right away. In-conversation memory edits remain part of the conversation that made them.

Archiving a section hides it from the active list. Deleting a section removes the conversation and its history. The bot's memory and notes stay as they are; edit them yourself if something should go. Treat deletion as permanent. Deleting a bot deletes its notes with it.

## About you

About you is one text that every bot you own reads: your name, what you do, and how you like to be spoken to. Only you write it. Hexbot asks for it once, at the first startup: your name, what you do, and how bots should talk to you. After that it lives in Settings under Memory.

Put durable facts there, such as preferred units or a standing rule. Do not use memory as a password store.

## Dreaming

Dreaming is a daily pass that folds a bot's recent conversations into its memory. Read [Dreaming](/docs/dreaming/) for scheduling and room memory.

## Backups

Memory lives with the daemon under `~/.hexbot`, not on this website. Stop the daemon before copying its complete data directory for a backup. Anyone who can read that directory may be able to read stored conversations and memory. See [Install](/docs/install/#data-and-updates) for data and workspace locations.
