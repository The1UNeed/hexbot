---
layout: ../../layouts/Docs.astro
title: Bots and chats
description: Configure a Hexbot bot and keep one ongoing chat with it.
---

A bot has a name, face, model, soul, skills, and memory. You have one chat with each bot, like a contact in a messaging app. It keeps going: there is no new conversation to start and nothing to archive.

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

## Faces and colours

In Profile, pick a shape and a colour for the bot's face, or use a photo. A picked face is kept with the bot on the daemon, so the web app, the desktop app, and the mobile app all draw it. The bot's message bubbles take a light wash of its face colour in chats and rooms, so you can tell bots apart at a glance. A bot with a photo keeps grey bubbles. The mobile app shows faces and can switch a bot to a photo, but faces are picked in the web or desktop app. On an older daemon a picked face is saved only as a picture: the web and desktop apps still draw it live, and the mobile app shows the picture.

## Keep the chat going

Select a bot in the sidebar to open its chat and carry on where you left off. Closing the app or restarting the daemon does not end it. Behind the chat is one persistent Pi conversation.

Changes reach the chat at different times:

| Change | When the chat has it |
| --- | --- |
| Model or reasoning level | From your next message. |
| Tools, connectors, or MCP servers | From your next message. That one reply rereads the conversation without the provider's prompt cache, so it costs more than usual. |
| Soul, memory, About you, skills, and teammates | After the chat next summarises older messages, as described below. |

The context meter at the top right of the chat shows how much of the model's context window the conversation fills, as a percentage, with the plain numbers on hover. A tick on its bar marks the summary point: when the conversation exceeds it, Hexbot summarises the older messages so the chat can go on, and the pill reads "Summarising" while that happens. When the meter is high, it says summarising starts soon. If the model's window is too small to keep any messages before that point, the tooltip says older messages are summarised after every reply. After a summary, the meter reads "Context" until the next reply is measured, even after the daemon restarts.

A summary keeps the thread of the work but not every detail. What lasts goes into the bot's memory and notes, and the bot can search the chat's history from before its latest summary when it needs an exact detail.

## Dream reports

Each night's [dream](/docs/dreaming/) report appears in the chat as a message from the bot. It is there for you to read; the bot does not see it as something it said, and later dreams skip it.

## Stop and delete

Use **Stop** to interrupt a running answer. The chat stays available, and you can send another message once the bot is idle. Queued background results run before your next message. A result accepted just after Stop finishes can start the next answer itself. A background result arriving while the answer stops waits until it has stopped, then continues the chat. The new answer can ask questions and request approvals.

Deleting the bot removes its profile, chat, memory, and scheduled jobs. Stop its active work first, then wait for Stop cleanup and any queued results to finish. Deletion is refused while that work remains. Back up the daemon's data directory before removing a bot you may need again.

While deletion runs, new bot starts are refused, including jobs and CLI runs. Closing the app lets the daemon finish deletion. If deletion fails, the bot can work again.

While deletion runs, new bot starts are refused, including jobs and CLI runs. Closing the app lets the daemon finish deletion. If deletion fails, the bot can work again.

If deletion leaves cleanup pending, its name stays reserved until a daemon restart finishes cleanup. An interrupted deletion from an older build can conflict with a recreated bot or leave a profile whose owner is uncertain. Hexbot preserves that data and reports the conflict in the daemon log for manual recovery.

An older app or API client can still delete a section and ask to keep its history. That conversation stays closed after a restart, and deleting the bot removes its retained history too. Deletion waits for task list and skill writes already in progress, even when their waiting calls were cancelled. Changing the bot's model leaves retained conversation settings alone. If deletion fails, any conversations deleted earlier stay closed with their saved retention choices. Restarting the daemon or deleting the bot skips history cleanup that already succeeded.

If the bot's deletion cannot be saved, its profile and history stay, including conversations you had already deleted with their history kept. Once the deletion is saved, an interrupted cleanup keeps the name reserved until a restart finishes it.

When updating after an interrupted deletion from an older build, a restart restores the conversations still belonging to a surviving section, owned room mapping or uncommitted bot deletion. Conversations with a recorded committed deletion stay closed. History already erased by the older build cannot be restored.

## Updating from earlier versions

Earlier versions let you keep many sections per bot. The first time the updated daemon starts, it keeps one section of each bot as its chat and deletes the others with their history. It prefers a section with real conversation, then one you had not archived, then the newest. Old Dreams logs containing human conversation compete the same way; a log containing only dream reports gives way to a conversation. Dream reports never make a mixed log's conversation newer. If a report followed its last conversation, or its message times are missing or invalid, the update keeps all of that bot's sections and opens the chat with the newest known conversation. A bot left with no section gets a new chat when you first open it. The bot's memory and notes stay.

This happens once, at the first start of the updated daemon, before any app or browser can connect. Before it deletes anything, the daemon makes a full copy of its databases and its conversation files in `backups/one-chat-per-bot-<date>-<time>/` in its data directory (`~/.hexbot` by default). The copy is about as large as those files, so the disk needs that much free space.

If anything goes wrong, such as the copy or a history cleanup failing, the daemon deletes nothing more and starts as usual. Sections already removed stay deleted. After a committed removal, a later start retries that request's leftover native history and identifiable history in an older bot database. If that older history belongs to another owner or links to a conversation Hexbot must keep, cleanup stays pending and the daemon logs the reason. Restarting alone cannot resolve that conflict. It never resumes deleting the untouched remaining sections. Older untagged tombstones have no legacy ownership to recover. A section that was not removed keeps its history, even if the daemon stops part way.

If a bot's conversations couldn't be read, or the daemon found one of them damaged, the update deletes none of that bot's sections, so their history stays on the daemon. Its chat is then chosen the same way among the sections that open, so a report-only log never outranks a conversation, and the daemon makes a new chat only when none of them can be the chat. Unreadable conversations stay for repair; a later daemon start checks them again. The app shows only that chat and doesn't open the others. Sections an older version makes later are kept too, and the chat is chosen among them the same way. Recreated Dream logs are checked again at chat lookup and before dreaming, so their reports stay out of future dreams.

An updated app connected to a daemon that hasn't been updated yet goes back to the section you were last in. When you select a bot, the app opens a section by itself only if at most one has something said; otherwise it asks which one to continue, once per bot while the app runs. To choose again, restart the app or reload the page, then select the bot. The app saves your choice on the daemon and brings it out of the archive if needed. That conversation stays when the daemon updates, even if you haven't sent another message. Old reports and saved choices used the same update time. If the last message in a mixed log is a report, the daemon cannot reliably recover which chat you chose, including when another report arrived after your choice. It keeps both histories and opens the chat with the newest known conversation instead. When the log's last conversation came after its reports, your saved choice still decides the chat. A log containing only dream reports still gives way to a real conversation. Cancelling saves nothing. If saving fails, retry your choice.

For sections kept from an earlier version, archiving hides the section's own failed-turn status; restoring it brings that status back. Archiving leaves failures from its subagents visible. Deleting a section clears its own turn failures and removes its delegated conversations. Connector problems and failures in other surviving rooms, sections, or background runs remain.

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
