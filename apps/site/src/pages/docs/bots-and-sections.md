---
layout: ../../layouts/Docs.astro
title: Bots and sections
description: Configure a Hexbot bot and manage its persistent conversations.
---

A bot has a name, face, model, soul, skills, and memory. A section is one persistent conversation with that bot. Start separate sections for separate tasks; each has its own context and history.

## Give a bot a role

Use Bot settings to configure how it works:

| Setting | What it controls |
| --- | --- |
| Profile | Display name, face, and teammate description. |
| Soul | How the bot behaves and speaks. You and the bot can edit it. |
| Model | The provider and model this bot uses. |
| Tools | Local capabilities and the working directory on the daemon computer. |
| Connectors | Outside services and MCP servers this bot can use. |
| Skills | Instructions for particular kinds of work. |
| Approvals | A bot-specific override of the daemon's approval mode. |
| Memory | Durable notes, dreaming controls, and the dream log. |

The teammate description tells other bots when to ask this one for help. For example, "Reviews database changes and checks migration safety" is more useful than "Helpful assistant." If you leave it blank, Hexbot derives a description from the soul.

## The primary bot

HexBot is your primary bot. Setup creates it, and it looks after the rest: in its own sections it can list, create, change, and delete your bots, create rooms and change who is in them, schedule jobs for any bot, and change settings, skills, and connectors. It always asks before it deletes a bot, room, or job, changes a bot's or room's approval mode or a bot's or job's working folder, or changes a setting, even in Bypass. It never sees API keys or connector credentials, and it can't change network or service settings.

There is one primary bot, pinned at the top of the roster, and it can't be deleted. You can rename it and change its soul, model, and tools like any other bot. If you used Hexbot before the primary bot existed, the bot list asks you to add HexBot or to make one of your bots primary; on the phone app, choose Make primary in a bot's profile. A bot made primary gets the extra tools in its next new section. Its tools don't work in rooms or scheduled jobs.

## Check-ins

Your primary bot also checks in on its own. Every hour between 08:00 and 22:00 it looks at what is going on: its memory and notes, and what its connectors show, like your calendar, email, or Notion. When it learns about something with a time to it, like a deadline tonight, it sets a wake-up to look again at the right moment. Most check-ins end quietly. When something needs you, it sends one short message with what you need to act on it.

Messages land in its **Check-ins** section and show as a notification in the app, in a browser tab you allowed, and on your phone. Reply there and it knows what it told you. It sends at most one message per check-in and eight a day.

Turn check-ins off, change how often they run, or change your hours in the primary bot's settings, under Check-ins. The same page shows the wake-ups waiting, lets you cancel one, and lists recent check-ins and what came of them. A check-in runs unattended, like a scheduled job, with your keys: it can't ask you anything, and it suggests memory changes for its next dream instead of writing them.

## Keep a conversation going

Reopen a section to continue the same task. Closing the app or restarting the daemon does not delete it. Each section keeps a persistent Pi conversation; a fresh section starts with a new context window and the bot's current settings.

Soul, selected skills, tool definitions, and the teammate list stay fixed for an existing conversation. Start a new section after changing them so the bot receives the new setup. Credentials and runtime settings can update separately; a temporary section model override does not change the bot's default model.

The context meter at the top right of a section shows how much of the model's context window the conversation fills, as a percentage, with the plain numbers on hover. A tick on its bar marks the summary point: when the conversation exceeds it, Hexbot summarises the older messages so the section can go on, and the pill reads "Summarising" while that happens. If the model's window is too small to keep any messages before that point, the tooltip says older messages are summarised after every reply. After a summary, the meter reads "Context" until the next reply is measured, even after the daemon restarts. The summary keeps the thread of the work but not every detail, and a long section makes the bot slower and less accurate, so when the meter is high, start a new section for the next task. The bot can still search earlier sections when it needs them.

## Section titles

A new section takes a title from your first message. The bot can rename its own section as the topic becomes clearer, and the roster shows that title. Names you set yourself are kept until you or the bot change them.

Use a title that lets you find the task later. The conversation history is also searchable by the bot, so a new section can build on earlier work without carrying the whole transcript in its context.

When the bot searches, it leaves out the section it is in, which it already has in view. A deleted section stops showing up in the bot's next search.

## Stop, archive, and delete

Use **Stop** to interrupt a running answer. The section stays available, and you can send another message.

Archiving hides a section from the active list and keeps its history. To bring it back, find it in Settings, Archive, where you can search titles, first messages, and bot names, or filter by bot, and choose Restore. The bot's Sections settings list its archived sections too. Deleting removes that section and its history permanently. It leaves the bot's memory alone; edit Memory separately when you want to remove a remembered fact.

Deleting the bot removes its profile, sections, memory, and scheduled jobs. Stop its active work first. Back up the daemon's data directory before removing a bot you may need again.

## Work with other bots

In a [room](/docs/rooms/), everyone sees the shared conversation. With **Message other bots** enabled, a bot can instead ask one of your teammates for help in a private conversation. Open the help row under its reply to read that exchange.

**Delegate** creates an isolated subagent for a subtask and returns the result to the originating conversation. It is a separate capability from asking a named teammate. Both use model tokens and the daemon's usage limits.
