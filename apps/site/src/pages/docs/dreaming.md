---
layout: ../../layouts/Docs.astro
title: Dreaming
description: Let bots review recent conversations and update their memory.
---

# Dreaming

A dream is a normal bot turn that reviews conversations since the bot's last dream. It looks for durable facts, preferences, decisions, and unfinished work, then records useful items in the bot's section memory.

The dream uses the bot's configured model, persona, memory, and skills. Model provider charges apply as they do for any other turn.

## When dreams run

Hexbot creates a daily dream schedule for each bot. The default time is 3:00 AM in the daemon's local time. The daemon must be running, but a missed dream catches up after it starts again and covers activity since the previous run.

Dreaming must be enabled for the daemon and for the individual bot. You can also run a bot's dream now from its Dreaming controls. The status shows the last run, next run, and any error.

## Read the result

Hexbot posts each summary in that bot's `Dreams` section. The section appears after the first dream. Open it to inspect what the bot recorded instead of treating the background job as invisible.

A dream reads only that bot's sections and the rooms it belongs to. Long transcripts are capped, with the newest part kept for review.

## Memory permissions

Dreams may write to the bot's private section memory. They can write to your core memory only when the bot has the `may write core memory` permission. Core writes still use the explicit core-memory action.

Leave that permission off for bots that should keep their conclusions private. You can review and edit core memory separately.

## Room memory

A room with a main bot gets its own daily room dream. Its summary becomes shared room memory, which Hexbot includes in later prompts for every bot in that room. Each bot may also keep private notes about the room in its own section memory.

Deleting a section or room can purge memory entries that came from it.
