---
layout: ../../layouts/Docs.astro
title: Scheduled work
description: Ask a Hexbot bot to create reminders, recurring jobs, and scheduled scripts.
---

The daemon can run work while the app window is closed. It must be running and the computer must be awake when a job is due. Quitting an app-owned daemon stops its jobs; use an independent daemon if the desktop app should be able to quit. Turn on **Scheduling** in Bot settings, Tools, then start a new section and ask the bot to create the job.

## Create a job in chat

Describe the task, timing, and result you need. For example:

> Every weekday at 9am, read the notes in my workspace and write a short list of unfinished tasks. Save the result locally. Tell me the job ID and next run time.

The scheduler accepts intervals such as `every 2h`, a one-time delay such as `in 30m`, daily or weekday times, five-field cron expressions, and explicit timestamps. Wall-clock schedules use the daemon's local timezone. If your client is elsewhere, confirm the next run time with the bot.

Jobs belong to the bot that creates them. By default, an agent job starts a fresh conversation using that bot's configuration. It can also select a model or skills for the job. Provider usage is billed as usual.

## Where results go

Scheduled output is saved locally, not delivered into the conversation that created the job. Output files live under `profiles/<bot>/cron/output/` in the daemon's data directory. Ask the bot to read the latest result or error for a named job.

Hexbot currently supports local delivery only. Do not rely on a reminder appearing as a chat message, email, or push notification. Ask the bot to confirm where it saved the result.

## Manage jobs

There is no separate job-management page. Ask the bot to:

- List its jobs, including paused jobs, and their next run times.
- Update a job's prompt or schedule.
- Pause a job, then resume it when needed.
- Run a job now to check the output.
- Remove a job you no longer need.

Use the job ID when two jobs have similar names. Deleting a bot also removes its scheduled jobs. Pausing a job preserves its definition.

## Scripts and unattended access

A job can run a script in the bot's scripts folder or workspace. Scheduling an absolute script path asks for approval. Scripts run inside the workspace sandbox in Manual and Auto, without model provider credentials. On Linux, scheduled scripts need working bubblewrap unless an admin chooses Bypass.

An autonomous agent job cannot wait for you to answer a question or approve a tool. Give it enough detail and access to finish on its own. If a required approval has no person to answer it, the job reports an error; inspect that error before broadening access.

For memory reviews, use [Dreaming](/docs/dreaming/). Dreaming has its own controls and saves summaries in the bot's dream log.
