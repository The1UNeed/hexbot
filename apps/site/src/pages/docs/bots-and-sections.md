---
layout: ../../layouts/Docs.astro
title: Bots and chats
description: Configure a Hexbot bot and keep one ongoing chat with it.
---

A bot has a name, face, model, soul, skills, and memory. You have one chat with each bot, like a contact in a messaging app. It keeps going: there is no new conversation to start and nothing to archive.

## Give a bot a role

Use Bot settings to configure how it works:

| Setting    | What it controls                                                     |
| ---------- | -------------------------------------------------------------------- |
| Profile    | Display name, face, and teammate description.                        |
| Soul       | How the bot behaves and speaks. You and the bot can edit it.         |
| Model      | The provider and model this bot uses.                                |
| Tools      | Local capabilities and the working directory on the daemon computer. |
| Connectors | Outside services and MCP servers this bot can use.                   |
| Skills     | Instructions for particular kinds of work.                           |
| Approvals  | A bot-specific override of the daemon's approval mode.               |
| Memory     | Durable notes, dreaming controls, and the dream log.                 |

The teammate description tells other bots when to ask this one for help. For example, "Reviews database changes and checks migration safety" is more useful than "Helpful assistant." If you leave it blank, Hexbot derives a description from the soul.

## Faces and colours

In Profile, pick a shape and a colour for the bot's face, or use a photo. A picked face is kept with the bot on the daemon, so the web app, the desktop app, and the mobile app all draw it. The bot's message bubbles take a light wash of its face colour in chats and rooms, so you can tell bots apart at a glance. A bot with a photo keeps grey bubbles. The mobile app shows faces and can switch a bot to a photo, but faces are picked in the web or desktop app. On an older daemon a picked face is saved only as a picture: the web and desktop apps still draw it live, and the mobile app shows the picture.

Faces have two hexagonal eyes. In the web and desktop apps, a face breathes, glances, and blinks while idle. While the bot thinks, it tilts and thought dots rise; while it searches, it sways and scans; while it writes, it nods over a line; while it works, its eyes turn like small gears. Faces in the roster and in chat and room headers, including every face in a room, match their status dot: working, listening (a nod) when it needs you, or happy (a hop) when an unseen reply is done. Two bots asking each other lean together. The Hexbot mark dozes while the app has lost its connection. Reduced motion keeps each expression without animation. Mobile draws the same settled expressions.

To hear when a bot starts, finishes, or needs you, turn on **Sounds** in Settings, Appearance. The tones play for the conversation you have open while the window is in view; otherwise notifications speak for the bot. Sounds are off by default and set for each app or browser.

## The primary bot

HexBot is your primary bot. Setup creates it, and it looks after the rest: in its chat it can list, create, change, and delete your bots, create rooms and change who is in them, schedule jobs for any bot, and change settings, skills, and connectors. It always asks before it deletes a bot, room, or job, removes a room's last bot (which deletes the room), changes a bot's or room's approval mode or a bot's or job's working folder, changes a setting, turns a skill or connector on or off, or cancels a [check-in](#check-ins) wake-up, even in Bypass. It never sees API keys or connector credentials, and it can't change network or service settings.

There is one primary bot, pinned at the top of the roster, and it can't be deleted. You can rename it and change its soul, model, and tools like any other bot. If you used Hexbot before the primary bot existed, the bot list asks you to add HexBot or to make one of your bots primary; on the phone app, choose Make primary in a bot's profile. A bot made primary gets the extra tools in its chat from your next message. Its tools don't work in rooms or scheduled jobs.

## Check-ins

Your primary bot also checks in on its own. Every hour between 08:00 and 22:00 it looks at what is going on: its memory and notes, and what its connectors show, like your calendar, email, or Notion. When it learns about something with a time to it, like a deadline tonight, it sets a wake-up to look again at the right moment. Most check-ins end quietly. When something needs you, it sends one short message with what you need to act on it.

Messages land in its **Check-ins** conversation, apart from your chat with it, and show as a notification in the app, in a browser tab you allowed (browsers notify only over HTTPS, such as through Hex Connect), and on your phone. Reply there and it knows what it told you, and its next check-ins see your reply. It sends at most one message per check-in and eight a day. Its Notify me switch silences the notifications; the messages still arrive there. Delete Check-ins under Check-ins in the primary bot's settings, or in its profile on the phone app, to remove what it said there; the next check-in message starts it again.

Turn check-ins off, change how often they run, or change your hours in the primary bot's settings, under Check-ins. The same page shows the wake-ups waiting, lets you cancel one, and lists recent check-ins and what came of them. A check-in runs unattended, like a scheduled job, with your keys. It only looks: it can read files and its connectors, including Notion and Airtable, but it can't run commands, browse, use the computer, change anything through a connector, or ask you anything, and it suggests memory changes for its next dream instead of writing them. If a check-in fails, its wake-ups wait for the next one.

## Keep the chat going

Select a bot in the sidebar to open its chat and carry on where you left off. Closing the app or restarting the daemon does not end it. Behind the chat is one persistent Pi conversation.

Changes reach the chat at different times:

| Change                                         | When the chat has it                                                                                                              |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Model or reasoning level                       | From your next message.                                                                                                           |
| Tools, connectors, or MCP servers              | From your next message. That one reply rereads the conversation without the provider's prompt cache, so it costs more than usual. |
| Soul, memory, About you, skills, and teammates | After the chat next summarises older messages, as described below.                                                                |

When a chat grows past what the model can hold, Hexbot summarises the older messages so the chat can go on.

A summary keeps the thread of the work but not every detail. What lasts goes into the bot's memory and notes, and the bot can search the chat's history from before its latest summary when it needs an exact detail.

## Dream reports

A [dream](/docs/dreaming/) posts nothing in the chat; its summary is in the bot's settings, Memory. Reports an earlier version posted stay in the chat. The bot does not see them as something it said, and later dreams skip them.

## Stop and delete

Use **Stop** to interrupt a running answer. The chat stays available, and you can send another message once the bot is idle. Queued background results run before your next message. A result accepted just after Stop finishes can start the next answer itself. A background result arriving while the answer stops waits until it has stopped, then continues the chat. The new answer can ask questions and request approvals. A question or approval the bot was waiting on goes away in every app.

When an answer fails, the bot shows Stopped. In the web and desktop apps, Retry is available when the daemon can identify the input that failed. Older daemons offer no Retry for failed sends or answers. A failed send keeps its draft for you to check and send manually. Retry, or any new message you send in that chat, shows it as Working as soon as the answer starts, in every app. Work the bot starts on its own, such as a background result, leaves Stopped while it runs; any answer that finishes cleanly clears it. A room's failure stays until a room turn finishes. A bot shows Working only while it answers in its chat or a room; check-ins, scheduled jobs, dreams and subagents run without it.

A failed send or upload keeps the bot's current answer and Stop available, including with an older daemon. If the app cannot confirm whether your message was sent, it keeps your draft and offers no Retry. Check the chat before sending again.

A chat can't be deleted on its own, even from an older app; deleting the bot removes its profile, chat, memory, and scheduled jobs. Stop its active work first, then wait for Stop cleanup and any queued results to finish; deletion is refused until they do. Back up the daemon's data directory before removing a bot you may need again. Private conversations between bots can still be deleted. While a bot is being deleted it can't start new work; if deletion fails, it can work again.

An older app or API client can still delete a private conversation between bots and ask to keep its history. That conversation stays closed after a restart, and deleting the bot removes its retained history too. Deletion waits for task list and skill writes already in progress, even when their waiting calls were cancelled. Changing the bot's model leaves retained conversation settings alone. If deletion fails, any conversations deleted earlier stay closed with their saved retention choices. Restarting the daemon or deleting the bot skips history cleanup that already succeeded.

If the bot's deletion cannot be saved, its profile and history stay, including conversations you had already deleted with their history kept. Once the deletion is saved, an interrupted cleanup keeps the name reserved until a restart finishes it.

When updating after an interrupted deletion from an older build, a restart restores the conversations still belonging to a surviving section, owned room mapping or uncommitted bot deletion. Conversations with a recorded committed deletion stay closed. History already erased by the older build cannot be restored.

## Updating from earlier versions

Earlier versions let you keep many conversations per bot. The first time the updated daemon starts, before any app can connect, it keeps one of each bot's conversations as its chat: the one with the latest real conversation, not a log of dream reports. It deletes the others with their history, after copying the daemon's databases and conversation files to `backups/one-chat-per-bot-<date>-<time>/` in its data directory (`~/.hexbot` by default), so the disk needs about that much free space. The bot's memory and notes stay. It happens once; if the copy or anything else fails, it deletes nothing more. A bot whose conversations can't be read, or whose choice the update can't be sure of, keeps all of them, and the app opens the one most likely to be its chat.

An updated app connected to a daemon that hasn't been updated yet asks which conversation to keep as the chat when a bot has several, once per bot while the app runs. Your choice is saved on the daemon and kept when it updates. Cancelling opens nothing.

The daemon API reference, `docs/api.md` in the source, describes the update and what clients can rely on in detail.

For sections kept from an earlier version, archiving hides the section's own failed-turn status; restoring it brings that status back. Archiving leaves failures from its subagents visible. Deleting a private conversation between bots clears its own turn failures and removes its delegated conversations. Connector problems and failures in other surviving rooms, sections, or background runs remain.

## Work with other bots

In a [room](/docs/rooms/), everyone sees the shared conversation. With **Message other bots** enabled, a bot can instead ask one of your teammates for help in a private conversation. The bot it asks does the work itself and can't hand the request back. Open the help row under its reply to read that exchange.

**Delegate** creates an isolated subagent for a subtask and returns the result to the originating conversation. It is a separate capability from asking a named teammate. Both use model tokens and the daemon's usage limits.

Saved chat links also resolve the daemon's current chat before you can send.
On mobile, a waiting item in Pulse opens the conversation containing its question
or approval, including a private conversation between bots.

If an old Dream log was already imported into Pi with reports in its context,
Hexbot starts a separate owner conversation using its original human dialogue.
It keeps the original conversation file and frozen prompt unchanged. The new
chat shows the old reports, but its model context omits them and rebuilds old
summaries from the original dialogue. Memory and notes stay. Dreaming reads that
copied dialogue once and excludes the original report-containing summaries.
