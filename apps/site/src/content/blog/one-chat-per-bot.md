---
title: One chat per bot
description: A bot is now like a contact in a messaging app. You have one chat with it, and it never ends.
date: 2026-10-21
---

Until today, each bot had a list of conversations. You started a new one for each topic, then archived the old ones, then wondered which one had that detail from last Tuesday.

Starting with today's nightly, a bot works like a contact in a messaging app. You have **one chat** with it, and it goes on for as long as the bot does.

## How it keeps going

Every model has a limit on how much it can read at once. When a chat reaches it, Hexbot summarises the older messages and carries on. What matters goes into the bot's memory through notes and dreams, and the bot can still search its older history when it needs an exact detail.

There's no "new chat", archive, or delete. To remove a chat, delete the bot.

## What stays separate

Rooms keep their own conversations, and so do the private conversations bots have when they ask each other for help. You can still open one of those from the line where one bot asks another.

## Updating

When you update, Hexbot backs up your conversations before it changes anything, then gives each bot its chat. Nothing in your memory or notes changes. If your app updates before your daemon does, it asks you which conversation to open.

The phone app works the same way: tap a bot and you're in its chat.
