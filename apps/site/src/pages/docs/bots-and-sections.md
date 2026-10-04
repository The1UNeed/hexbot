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
| Profile | Display name, face, teammate description, and sharing with other users. |
| Soul | How the bot behaves and speaks. You and the bot can edit it. |
| Model | The provider and model this bot uses. |
| Tools | Local capabilities and the working directory on the daemon computer. |
| Connectors | Outside services and MCP servers this bot can use. |
| Skills | Instructions for particular kinds of work. |
| Approvals | A bot-specific override of the daemon's approval mode. |
| Memory | Durable notes, dreaming controls, and the dream log. |

The teammate description tells other bots when to ask this one for help. For example, "Reviews database changes and checks migration safety" is more useful than "Helpful assistant." If you leave it blank, Hexbot derives a description from the soul.

## Keep a conversation going

Reopen a section to continue the same task. Closing the app or restarting the daemon does not delete it. Each section keeps a persistent Pi conversation; a fresh section starts with a new context window and the bot's current settings.

Soul, selected skills, tool definitions, and the teammate list stay fixed for an existing conversation. Start a new section after changing them so the bot receives the new setup. Credentials and runtime settings can update separately; a temporary section model override does not change the bot's default model.

## Section titles

A new section takes a title from your first message. The bot can rename its own section as the topic becomes clearer, and the roster shows that title. Names you set yourself are kept until you or the bot change them.

Use a title that lets you find the task later. The conversation history is also searchable by the bot, so a new section can build on earlier work without carrying the whole transcript in its context.

## Stop, archive, and delete

Use **Stop** to interrupt a running answer. The section stays available, and you can send another message.

Archiving hides a section from the active list and keeps its history. Unarchive it from the bot's Sections settings to bring it back. Deleting removes that section and its history permanently. It leaves the bot's memory alone; edit Memory separately when you want to remove a remembered fact.

Deleting the bot removes its profile, sections, memory, and scheduled jobs. Stop its active work first. Back up the daemon's data directory before removing a bot you may need again.

## Work with other bots

In a [room](/docs/rooms/), everyone sees the shared conversation. With **Message other bots** enabled, a bot can instead ask one of your teammates for help in a private conversation. Open the help row under its reply to read that exchange.

**Delegate** creates an isolated subagent for a subtask and returns the result to the originating conversation. It is a separate capability from asking a named teammate. Both use model tokens and the daemon's usage limits.
