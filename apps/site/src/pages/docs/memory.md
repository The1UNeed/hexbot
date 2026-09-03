---
layout: ../../layouts/Docs.astro
title: Memory
description: Learn what Hexbot remembers and where that memory belongs.
---

# Memory

Hexbot separates shared facts from a bot's own history. This keeps one bot's private context out of another bot unless you choose to share it.

## Core memory

Core memory belongs to the user and is available to all of that user's bots. It has sections for the user, household, workspace, and standing rules. Bots write to core memory only through an explicit action.

Put durable facts there, such as preferred units or a workspace convention. Do not use memory as a password store.

## Section memory

Each bot has private notes and searchable history from its own sections and the rooms it belongs to. Other bots do not inherit those notes. Starting a new section gives the conversation a new context window without erasing the bot's searchable history.

Archiving a section hides it from the active list but keeps it in memory. Deleting a section removes the conversation and can purge memory entries derived from it. Treat deletion as permanent.

## Dreaming

Dreaming is a daily pass that summarizes a bot's recent conversations into its section memory. Read [Dreaming](/docs/dreaming/) for scheduling, permissions, and room memory.

## Backups

Memory lives with the daemon under `~/.hexbot`, not on this website. Back up the daemon's data directory if you depend on its history. Anyone who can read that directory may be able to read stored conversations and memory.
