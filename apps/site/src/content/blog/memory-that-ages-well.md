---
title: Memory that ages well
description: Bots now keep daily notes, date what they learn, and read the summaries of long conversations when they dream.
date: 2026-10-11
---

A bot's memory is small on purpose. It's in every prompt, so it has to stay short. Until today, that was also the only place a bot could write anything down during a conversation, so the memory filled up within weeks and the nightly dream had to judge each day by the last few messages of each conversation.

Today's nightly gives memory some room to breathe.

## Daily notes

Bots now keep **notes**: one short file per day, written at natural pauses in a conversation. Notes stay out of the prompt until a bot looks a day up. Each night the dream reads them first and folds what lasts into memory.

You can read, edit, or delete any day from the bot's Memory tab. Days older than 30 days are removed.

## Facts with a date

Each memory entry now carries the month it was learned, like `[2026-10]`. When the dream finds two facts that disagree, it can tell which one is current.

## Dreams that see the whole conversation

When a long conversation outgrows the model's context, Hexbot summarises the older part. The dream now reads those summaries, so a long conversation isn't judged by its last few messages alone. And a long conversation can now pick up changes to the bot's soul and memory after it's summarised, without waiting for a new conversation. If the bot is in the middle of a reply when that happens, the changes wait for the next summary.

## Scheduled jobs suggest instead of write

A scheduled job runs while nobody is watching, so it no longer writes to memory directly. It suggests what to remember, and the next dream decides. See [Memory](/docs/memory/) and [Dreaming](/docs/dreaming/).
