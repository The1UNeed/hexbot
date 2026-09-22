---
layout: ../../layouts/Docs.astro
title: Dreaming
description: Let bots review recent conversations and update their memory.
---

A dream is a normal bot turn that reads the conversations since the bot's last dream and tidies its memory: it merges duplicates, sharpens vague entries, drops what is stale, and adds durable facts and lessons about working with you. Memory is short on purpose, so a dream keeps it dense rather than long. Unfinished work and what happened on a given day stay in section history.

The dream uses the bot's configured model, soul, memory, and skills. Model provider charges apply as they do for any other turn.

## When dreams run

Hexbot creates a daily dream schedule for each bot. The default time is 3:00 AM in the daemon's local time. The daemon must be running, but a missed dream catches up after it starts again and covers activity since the previous run.

Dreaming must be enabled for the daemon and for the individual bot. You can also run a bot's dream now from its Dreaming controls. The status shows the last run, next run, and any error.

## Read the result

Hexbot posts each summary in that bot's `Dreams` section. The section stays out of the sidebar. Open the bot's settings, Memory, and find the dream log at the bottom. Each dream that changed memory shows what it looked like before and after, with a button to restore the memory from before that dream.

A dream reads only that bot's sections and the rooms it belongs to. Long transcripts are capped, with the newest part kept for review.

## What a dream may change

A dream writes only to the bot's own memory. It never edits the bot's soul or your About you text, so who the bot is and what it knows about you stay in your hands.

## Room memory

A room with a main bot gets its own daily room dream. Its summary becomes shared room memory, which Hexbot includes in later prompts for every bot in that room. Each bot may also keep private notes about the room in its own memory.
