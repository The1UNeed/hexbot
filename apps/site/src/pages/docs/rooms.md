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

Hexbot checks limits before every bot turn. By default, a room allows eight bot turns after each human message. An admin can also set a token budget for each human turn and a daily budget for each bot. Rooms can override the system room limits.

When a limit is reached, the room shows a notice and stays idle until a human sends another message. Use Stop to end a running chain sooner.

Tool approvals appear in the room like approvals in a normal section. A room can use its own approval mode.

## Membership and history

You can add or remove bots after creating a room. A newly added bot receives the existing transcript so it can follow the discussion. Removing a bot keeps the old messages and their author labels.

Archiving hides a room but keeps its history. Deleting it removes the room and can purge memory made from it.

## Bot-to-bot messages

Bots can use `message_bot` to contact another bot outside a room. The receiving bot keeps these messages in a section named `From <sender>`. The sender may wait for the reply or continue while Hexbot delivers the reply later.

Hexbot caps a bot-to-bot chain at eight messages per originating human turn. Daily bot budgets still apply.

Open Activity to see which bots have messaged each other, message counts, and the latest exchange. Select a bot pair to read the messages and open the related section.
