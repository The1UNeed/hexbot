---
layout: ../../layouts/Docs.astro
title: Discord
description: Add a bot to a Discord server, choose when it answers and what it reads, and watch the conversation in Hexbot.
---

A bot can join Discord servers as its own Discord app. It answers in Discord as itself, with its own name and picture. You choose for each server whether it answers only when someone **@mentions** it, joins in on its own, or answers everyone. Each channel it talks in becomes a [room](/docs/rooms/) in Hexbot, so you can read along.

Each bot has its own Discord app. Add several bots to the same server, or different bots to different servers: what a channel says reaches only the bots in it, and each keeps its own notes about it.

## Turn on Discord

Open **Settings**, **Plugins**, and choose **Discord** under Social. Turn it on for each bot you want in Discord. Turning it on opens that bot's **Discord** settings, where you connect it. A bot's settings show Discord only while it is on.

To turn it off for a bot, switch it off in the same place. A connected bot is disconnected first, after you agree.

## Connect a bot

1. Open the [Discord Developer Portal](https://discord.com/developers/applications), choose **New Application**, and name it after the bot. You can give it the bot's face as its icon.
2. Under **Bot**, turn on **Message Content Intent**. Without it the app sees only messages that mention it.
3. Still under **Bot**, choose **Reset Token** and copy the token.
4. In Hexbot, open the bot's settings, choose **Discord**, paste the token, and choose **Connect**. From Plugins, **Discord**, **Connect** beside the bot takes you there.
5. Choose **Add to a server** and pick a server you manage. Discord asks to let the app see channels, read their history and send messages.

The token is saved on the daemon, where bots' tools can't read it, except in [Bypass](/docs/approvals/). The daemon connects to Discord itself, so a daemon at home or a Headless install works without opening a port.

## Choose how it acts

In the bot's **Discord** settings, choose how it acts in Discord:

| Choice | When it answers | What it reads |
| --- | --- | --- |
| **Mentions only** | When someone mentions it or replies to it | Only those messages, and the message each one replies to |
| **Mentions, reads along** (the default) | When someone mentions it or replies to it | Everything said in its channels, and other channels and threads in the server when it needs to |
| **Active member** | When it has something to add | Every channel it can see, and other channels and threads when it needs to |
| **Answers everyone** | Every message from a person, unless it is for another of your bots | Every channel it can see, and other channels and threads when it needs to |

Under **Servers**, each server the bot is in can have its own choice, such as **Active member** in a server of friends and **Mentions only** in a public one. A server set to **Same as default** follows the bot's choice.

An **Active member** or a bot that **Answers everyone** joins only channels where it can post, so a read-only channel such as **#announcements** costs nothing. An active bot spends tokens on messages that don't mention it. Messages that arrive while it is answering are answered together in its next reply. In a busy server, set a daily token budget for each bot; your primary bot can do it for you. To keep a bot out of a channel, change its permissions in Discord.

## Talk to it in Discord

**@mention** the bot in any channel or thread it can see, or reply to one of its messages. The first mention turns the channel into a room named after it, such as **#general · My Server**, starting with the 20 messages before the mention. Where the bot is an **Active member** or **Answers everyone**, the first message anyone writes in a channel does the same. From then on the room keeps everything said in that channel, and the bot reads it when it next answers.

If you remove a bot from a Discord server, it leaves that server's rooms. An **Active member** or a bot that **Answers everyone** comes back on its own when it is added again or reconnected; one you removed from a room comes back only when someone mentions it.

Where every bot in a channel is set to **Mentions only**, Hexbot keeps only the messages that mention or reply to them, and the room starts without the messages before.

A bot can bring in another of your bots by mentioning it, if that bot is in the server too. A Discord room has no main bot, and messages from other Discord bots never start a reply.

The room in Hexbot is for reading. To reply, choose **Open in Discord**. You can stop a running turn, remove a bot from the room, set limits, archive the room or delete it. A bot you remove comes back when someone mentions it again; to keep it out of a channel, change its permissions in Discord. Deleting it forgets the channel; the next mention starts a new room.

Direct messages to the bot are not read.

## What a bot can do in Discord

Anyone in the channel can talk to the bot, so it does much less there than in its chat with you:

- It can **search the web**, **read web pages**, and **keep notes** about the channel. Anyone can write there, so its [dream](/docs/dreaming/) treats those notes as suggestions and keeps only what it would record itself. The dream doesn't read Discord rooms.
- Unless it is set to **Mentions only**, it can **read the server's other channels and threads**: list them, and read their latest messages. Only that server, only channels its Discord app can see, and only channels at least as public as the one it is asked in: from **#general** it never reads a channel only some people can see.
- It can't run commands, read or change files, use your connectors or passwords, use the bots' computer, or ask your other bots for help. A Discord room always uses **Manual** [approvals](/docs/approvals/).
- It keeps its soul but never sees its **memory** or **About you** there, so nobody can talk it into sharing them. Keep secrets out of the soul of a bot you put in a public server.
- Its replies can mention your other bots, never `@everyone`, roles or other people, and replying to someone doesn't ping them.
- Anyone in the channel can make it spend tokens by mentioning it, and where it is an **Active member** or **Answers everyone**, by writing anything. In a busy server, set a daily token budget for each bot; your primary bot can do it for you.

## Disconnect

In the bot's settings, **Discord**, choose **Disconnect**, or turn Discord off for the bot in **Plugins**. The bot goes offline in Discord, the token is deleted, and it leaves its Discord rooms. The rooms stay in Hexbot with their history; connect it again and mention it to bring it back. Deleting the bot also disconnects it. To take the app out of a server, remove it in Discord.

If Discord stops accepting the token, the bot's Discord settings say so. Reset the token in the Developer Portal and paste the new one under **Connect again**.
