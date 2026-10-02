---
layout: ../../layouts/Docs.astro
title: Rooms
description: Put people and bots in one conversation and control who responds.
---

A room is a group chat with people and bots. Each bot keeps its own persona, model, skills, tools, and private memory while it works in the room.

## Choose who responds

Mention a bot by handle to ask it to reply. You can mention several bots in one message, and they run in parallel.

A room may also have a main bot. When a human sends a message without mentioning any bot, the main bot replies. Without a mention or a main bot, no bot responds.

Bots can mention other room members. When a main bot brings in other bots, it waits for their replies and gets one turn to collect the result. A bot can write `(pass)` when it has nothing useful to add.

## Waiting on you

A bot can mention `@user` or direct a question to the human. Hexbot stops the bot chain and shows a "waiting on you" banner. Your next message starts a new room turn.

## Limits and approvals

Hexbot checks limits before every bot turn. By default, a room allows eight bot turns after each human message. An admin can also set a token budget for each human turn and a daily budget for each bot. Room settings can override the turn limit and the token budget per human turn; the daily budget for each bot always applies.

When a limit is reached, the room shows a notice and stays idle until a human sends another message. Use Stop to end a running chain sooner.

Tool approvals appear in the room like approvals in a normal section. A room can use its own approval mode. Bots run as the person who created the room, so only that person sees and answers their approvals and questions. Everyone else watches the bot write, sees which tool it uses but not its arguments or results, and sees "Waiting for" that person while an approval or question is open. The bot's reasoning stays with the person who created the room. Reloading restores open cards for that person and the waiting notice for everyone else. A tool reads "Running" until it completes, including while it waits for approval.

## Membership and history

You can add or remove bots after creating a room, from Room settings (the info button in the room header). A newly added bot receives the existing transcript so it can follow the discussion. Removing a bot stops only that bot and keeps the old messages and their author labels. Removing the last bot deletes the room; the bot itself is kept.

People you add to a room see it in their list and can read and post. Everyone sees the bots by their display names. Only the person who created the room can change its members or settings, archive it, or delete it; everyone else sees the room settings without those controls. Its bots run on the creator's budget.

The creator can add a person from the People group in Room settings. Add person lists people on the daemon who are outside the room, including anyone who left or was removed. Adding them back restores their access to the history and live bot replies. On a daemon where you are the only person, Room settings has no People group.

The creator can remove a person from Room settings, and anyone else can leave from there. Either way the room leaves that person's list and they can no longer read or post in it.

Archiving hides a room but keeps its history. Deleting it removes the room and its history; each bot's own memory is left as it is.

## Bots working together

A bot can ask another of your bots for help, outside any room. Each bot has a description that the others read to decide whom to ask. Write it in the bot's settings under Profile. If you leave it blank, Hexbot writes one from the bot's soul and keeps it out of sight. A bot learns who is on its team when a section starts, so a new bot or a changed description reaches the sections started after it.

Each exchange is private between the two bots. While a bot is asking, its reply shows "Asking" and the other bot's face. Select it to read their conversation in a side panel. These conversations stay out of your section lists, but both bots learn from them: dreaming folds them into memory like any other conversation.

Bots ask each other only when Message other bots is on, under Tools in the bot's settings. Hexbot caps a chain at eight messages per originating turn, and daily bot budgets still apply. In a room, only the person who created the room can open these conversations.

## Attachments

Images can be up to 25 MiB. PDFs and other files can be up to 45 MiB each.
The app reports larger files before uploading them.
