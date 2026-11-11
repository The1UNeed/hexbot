---
layout: ../../layouts/Docs.astro
title: Scheduled work
description: Ask a Hexbot bot to create reminders, recurring jobs, and scheduled scripts.
---

The daemon can run work while the app window is closed. It must be running and the computer must be awake when a job is due. Quitting an app-owned daemon stops its jobs; use an independent daemon if the desktop app should be able to quit. Turn on **Scheduling** in Bot settings, Tools, then ask the bot in its chat to create the job.

## Create a job in chat

Describe the task, timing, and result you need. For example:

> Every weekday at 9am, read the notes in my workspace and write a short list of unfinished tasks.

The scheduler accepts intervals such as `every 2h`, a one-time delay such as `in 30m`, daily or weekday times, five-field cron expressions, and explicit timestamps. Wall-clock schedules use the daemon's local timezone. If your client is elsewhere, confirm the next run time with the bot.

Jobs belong to the bot that creates them. By default, an agent job starts a fresh conversation using that bot's configuration. It can also select a model or skills for the job. Provider usage is billed as usual.

## Where results go

When a bot schedules a job, it tells you what it scheduled and when it first runs. Each time the job finishes, its result, or why it failed, is posted in that bot's chat and notifies your app, browser, and phone. The bot's Notify me switch silences the notifications; the message still lands in the chat. A monitor job that found nothing new posts nothing.

If you don't want to hear from a job, say so when you ask for it, or later: "run this quietly", "stop notifying me about the inbox check". The bot turns notifications off for that job, and its results are only saved. Jobs you create in the mobile app are quiet the same way.

Every result is also saved under `profiles/<bot>/cron/output/` in the daemon's data directory. A message in the chat holds up to 4,000 characters; ask the bot for the whole result or the latest error of a named job. Jobs cannot send email. For something to watch until it changes, ask a bot to add it to its [heartbeat](/docs/bots-and-sections#heartbeat) checklist instead.

## Manage jobs

In the mobile app, open Daemon, Jobs to create, edit, pause, resume, run or remove jobs. Bot settings also shows that bot's jobs. The desktop and browser clients can manage jobs through chat. Ask the bot to:

- List its jobs, including paused jobs, and their next run times.
- Update a job's prompt or schedule.
- Pause a job, then resume it when needed.
- Run a job now to check the output.
- Remove a job you no longer need.

Use the job ID when two jobs have similar names. Deleting a bot also removes its scheduled jobs. Pausing a job preserves its definition.

## Scripts and unattended access

A job can run a script in the bot's scripts folder or workspace. Scheduling an absolute script path asks for approval. Scripts run read-only in Manual and inside the workspace sandbox in Auto or Bypass, without model provider credentials. On Linux, scheduled scripts need working bubblewrap.

An autonomous agent job and its delegates cannot wait for you to answer a question or approve a tool. Give the job enough detail and access to finish on its own. Actions that need approval are refused immediately; inspect the error before broadening access.

## Jobs and memory

A job can read the bot's memory and notes but not write them. When a job asks to add, replace, or remove a memory entry, or to note something, Hexbot saves the request as a proposal, and the bot's next dream decides whether to keep it. This keeps text a job fetched from the web out of memory until the bot has looked at it with the rest of the day. See [Dreaming](/docs/dreaming/#proposals-from-scheduled-jobs). A job cannot change the bot's soul either; the bot tells you when it wants a soul change, and you make it in its chat.

For memory reviews, use [Dreaming](/docs/dreaming/). Dreaming has its own controls and saves summaries in the bot's dream log.

Jobs and their delegates run in Auto when the bot uses Bypass; Manual stays Manual. They cannot message other bots, because a recipient's chat could change memory without a dream reviewing it. Their results reach you only in the bot's own chat.
