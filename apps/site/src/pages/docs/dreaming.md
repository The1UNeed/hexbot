---
layout: ../../layouts/Docs.astro
title: Dreaming
description: Let bots review recent conversations and update their memory.
---

A dream is a normal bot turn that reads the conversations since the bot's last dream and tidies its memory: it merges duplicates, sharpens vague entries, drops what is stale, and adds durable facts and lessons about working with you. Memory is short on purpose, so a dream keeps it dense rather than long. Unfinished work and what happened on a given day stay in the chat's history. Each entry the bot adds ends with the month it was learned; the dream keeps those stamps, refreshes one when a fact is confirmed again, and checks or drops old entries that may no longer hold. An entry without a stamp is one you wrote or one from before stamps; the dream judges it on what it says, not on the missing date.

The dream uses the bot's configured model, soul, memory, and skills. Model provider charges apply as they do for any other turn.

## When dreams run

Hexbot creates a daily dream schedule for each bot. The default time is 3:00 AM in the daemon's local time. The daemon must be running, but a missed dream catches up after it starts again.

Each dream reviews activity from the start of the last successful dream up to, but excluding, its own start. Both starts are rounded down to whole milliseconds. Messages and compaction summaries at or after that start wait for the next dream, so the time windows do not overlap. The first dream reviews earlier history. Failed or interrupted dreams leave the lower cutoff unchanged.

An unreadable database from an older Hexbot version does not stop a dream when its conversations are available in native history. If a conversation still needs that database, or its log is missing or has messages that have not reached native history, the dream fails and leaves its cutoff and proposals unchanged. Repairing and recovering the conversation makes that history eligible for the next dream. New empty chats can still dream from notes and proposals.

If relevant conversation history changes between its readiness check and transcript selection, the dream fails before calling the model. Run it again to read the updated history; its cutoff and proposals stay unchanged until a dream succeeds.

Dreaming must be enabled for the daemon and for the individual bot. You can also run a bot's dream now from its Dreaming controls. The status shows the last run, next run, and any error.

## Read the result

Hexbot posts each summary in the bot's chat, as a message from the bot. The bot does not see it as something it said, and later dreams skip it. The dream log is also in the bot's settings, Memory, at the bottom. Select a log entry to open the bot's chat. On an older daemon with several conversations, Hexbot asks which one to continue; cancelling opens nothing. Each dream that changed memory shows what it looked like before and after, with a button to restore the memory from before that dream.

A dream reads the bot's own [notes](/docs/memory/#notes) first: the days from the start of its last successful dream, already condensed by the bot as it worked. Then it reads only that bot's chat, its conversations with other bots, and the rooms it belongs to, and only what you and the bot said there: pages the bot fetched and other tool output stay out of the transcripts it reads, and so do the bot's own earlier dream summaries and the hidden reminders Hexbot adds to a chat, such as its todo list after older messages are summarised or the notice that the fallback model took over. Long transcripts are capped, with the newest part kept for review; when the chat or that bot's room conversation was compacted during the day, the dream also reads the summaries written at those points, so the morning of a busy conversation still counts. Those summaries were written with tool output still in view, so they can mention what a page said; the dream is told to treat them as it treats a job's proposals and to keep only what you or the bot clearly established. Summaries without a valid timestamp are skipped. Titles and room names are shortened too. On a busy day the dream keeps the most recent conversations that fit in one prompt.

## What a dream may change

A dream writes only to the bot's own memory. It never edits the bot's soul or your About you text, so who the bot is and what it knows about you stay in your hands. Notes are not memory: the dream keeps what lasts from them and leaves the notes where they are, and Hexbot removes days older than 30 days before the dream starts and when notes are read, listed, or added.

If an older client still has a conversation containing old dream reports open, Hexbot waits for it to close or retire before moving it to a chat without those reports in the bot's context. Accepted messages and replies finish in that conversation. After the move, open the bot's chat again to continue; the old conversation refuses new input.

## Proposals from scheduled jobs

A scheduled job cannot change memory or notes while it runs unattended. When a job asks to add, replace, or remove something, or to note it, Hexbot saves the request as a proposal instead. The bot's next dream reads pending proposals created before it started, newest first, treats them as suggestions that may contain text from the web, keeps the ones it agrees with, and says in its summary which it applied or ignored. A proposed note must contain text and can hold up to 4,000 characters after trimming; a proposed memory change uses the bot's memory limit. Every proposal must also fit the dream's 10,000-byte limit after JSON encoding, including its metadata. Hexbot refuses oversized proposals before saving them. A proposal stays pending until a dream completes; a failed dream leaves it for the next one. Deleting the bot deletes its proposals.

Every text field in a proposal passes the injection scan and the bot's memory cap before Hexbot saves it, including text to remove or replace.

Jobs and their delegates cannot message other bots or write memory and soul files directly. Jobs set to Bypass run in Auto, including scheduled scripts; Manual stays Manual.

## Room memory

A room with a main bot gets its own daily room dream. Its summary becomes shared room memory, which Hexbot includes in later prompts for every bot in that room. Each bot may also keep durable facts about the room in its own memory.
