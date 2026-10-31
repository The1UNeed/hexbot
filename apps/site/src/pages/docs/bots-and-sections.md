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
| Tools      | Workspace tools, senses, working with other bots, and the working directory. Computer use is in Settings, Manuals. |
| Connectors | Outside services and MCP servers this bot can use.                   |
| Skills     | Instructions for particular kinds of work.                           |
| Approvals  | A bot-specific override of the daemon's approval mode.               |
| Memory     | Durable notes, dreaming controls, and the dream log.                 |

The teammate description tells other bots when to ask this one for help. For example, "Reviews database changes and checks migration safety" is more useful than "Helpful assistant." If you leave it blank, Hexbot derives a description from the soul.

## Faces and colours

In Profile, pick a shape and a colour for the bot's face, or use a photo. A picked face is kept with the bot on the daemon, so the web app, the desktop app, and the mobile app all draw it. The bot's message bubbles take a light wash of its face colour in chats and rooms, so you can tell bots apart at a glance. A bot with a photo keeps grey bubbles. The mobile app shows faces and can switch a bot to a photo, but faces are picked in the web or desktop app. On an older daemon a picked face is saved only as a picture: the web and desktop apps still draw it live, and the mobile app shows the picture.

Faces have two capsule eyes, as on the Hexbot icon. In the web and desktop apps, a face sways, glances, and blinks while idle. While the bot thinks, the face folds into three bobbing dots; while it writes, into a pencil; while it searches, it peers around; while it works, it bobs and narrows its eyes in concentration. Now and then a busy or happy face turns all the way round. Faces in the roster and in chat and room headers, including every face in a room, match their status dot: working, listening (a tilt from side to side) when it needs you, or happy (a hop) when an unseen reply is done. Two bots asking each other turn toward each other. The Hexbot mark dozes while the app has lost its connection. Reduced motion keeps each expression without animation. Mobile draws the same settled expressions.

Faces also react to what happens. A bot looks shy when you thank it, surprised when something is urgent, and curious about other requests. It looks confused when a step fails and frustrated after several, sad when a reply fails or it has to apologise, proud after a long job, and it celebrates passing tests, merges, and deploys. Left alone in an open chat it gets bored, then drowsy, and wakes when something happens. Hexbot reads these from the conversation; it never asks the model, so they cost nothing. The mobile app shows them in a bot's chat.

To hear when a bot starts, finishes, or needs you, turn on **Sounds** in Settings, Appearance. The tones play for the conversation you have open while the window is in view; otherwise notifications speak for the bot. Sounds are off by default and set for each app or browser. The mobile app has no Sounds switch yet.

## The primary bot

HexBot is your primary bot. Setup creates it, and it looks after the rest: in its chat it can list, create, change, and delete your bots, create rooms and change who is in them, schedule jobs for any bot, and change settings, skills, and connectors. It always asks before it deletes a bot, room, or job, removes a room's last bot (which deletes the room), changes a bot's or room's approval mode or a bot's or job's working folder, changes a setting, or turns a skill or connector on or off, even in Bypass. It never sees API keys or connector credentials, and it can't change network or service settings.

There is one primary bot, pinned at the top of the roster, and it can't be deleted. You can rename it and change its soul, model, and tools like any other bot. If you used Hexbot before the primary bot existed, the bot list asks you to add HexBot or to make one of your bots primary; on the phone app, choose Make primary in a bot's profile. A bot made primary gets the extra tools in its chat from your next message. Its tools don't work in rooms or scheduled jobs.

## Heartbeat

Every bot has a heartbeat. Every 30 minutes, day and night, it works through its own checklist, `HEARTBEAT.md`, on its own. It looks each item up in its memory and notes, its files, what its connectors show (your email, calendar, or Notion), and the web. It doesn't read your chat. Most heartbeats end quietly. When something needs you, it writes one short message in its chat with what you need to act on it.

Write the checklist under Heartbeat in the bot's settings, or in its profile on the phone app, one check per line:

```md
- Has Sam replied to my email about the lease?
- Is flight BA 286 on Friday delayed?
- Has the Sony WH-1000XM6 dropped below $300?
- Did anything on my calendar change today?
```

You can also ask the bot in its chat to keep an eye on something; it adds the line itself, and takes it off once it's settled. A new bot's checklist holds only an example, and while there is nothing on it, the heartbeat doesn't run and costs nothing.

The message shows in the bot's chat and as a notification in the app, in a browser tab you allowed (browsers notify only over HTTPS, such as through Hex Connect), and on your phone. Reply in the chat and the bot knows what it told you. Each bot sends at most one message per heartbeat and eight a day. Its Notify me switch silences the notifications; the messages still arrive in the chat.

The same page shows when the next heartbeat runs, runs one now, and lists recent heartbeats with what each looked at. Turn heartbeats off for every bot there or in Settings. A heartbeat runs unattended, like a scheduled job, with your keys. It only looks: it can read files, search and read the web, and read its connectors, including Notion and Airtable, but it can't run commands, use the browser or the computer, change anything through a connector, or ask you anything, and it suggests memory changes for its next dream instead of writing them.

The heartbeat replaced your primary bot's check-ins. If it sent you any, its Check-ins conversation stays until you delete it under Heartbeat in its settings or in its profile on the phone app.

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

## Formulas

Bots write math in LaTeX. The desktop app and the browser typeset it, in chats and rooms. The phone app shows it as plain text that reads like the formula, such as `3/(2√x)` or `x⁻¹`. A lone `$` stays a dollar sign, so prices are never mistaken for math.

## Dream reports

A [dream](/docs/dreaming/) posts nothing in the chat; its summary is in the bot's settings, Memory. Reports an earlier version posted stay in the chat. The bot does not see them as something it said, and later dreams skip them.

## Stop and delete

Use **Stop** to interrupt a running answer. The chat stays available, and you can send another message once the bot is idle. Queued background results run before your next message. A result accepted just after Stop finishes can start the next answer itself. A background result arriving while the answer stops waits until it has stopped, then continues the chat. The new answer can ask questions and request approvals. A question or approval the bot was waiting on goes away in every app.

When an answer fails, the bot shows Stopped. In the web and desktop apps, Retry is available when the daemon can identify the input that failed. Older daemons offer no Retry for failed sends or answers. A failed send keeps its draft for you to check and send manually. Retry, or any new message you send in that chat, shows it as Working as soon as the answer starts, in every app. Work the bot starts on its own, such as a background result, leaves Stopped while it runs; any answer that finishes cleanly clears it. A room's failure stays until a room turn finishes. A bot shows Working only while it answers in its chat or a room; heartbeats, scheduled jobs, dreams and subagents run without it.

A failed send or upload keeps the bot's current answer and Stop available, including with an older daemon. If the app cannot confirm whether your message was sent, it keeps your draft and offers no Retry. Check the chat before sending again.

Close a Stopped card with its **×** once you have read it. If the bot shows Stopped for this chat, that clears too. On the phone, the error under the chat has the same button.

## Recall a message

While the bot is working on your latest message, or after its answer stopped, you can take that message back. In the web and desktop apps, hover over it and choose **Recall**. On the phone, long-press it. A running answer stops first. The message and what the bot said after it leave the chat in every app, and the bot forgets them. The text goes back in the message box to edit; attached files do not, so attach them again. Anything the bot already did, such as changing a file, stays done.

Only your latest message can be recalled, and only in a bot's chat, not in a room, a conversation between bots, or an earlier Check-ins. Recalling keeps the conversation before that message as it was, so the bot's next answer still uses the provider's prompt cache.

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
