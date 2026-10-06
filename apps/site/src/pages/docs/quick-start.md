---
layout: ../../layouts/Docs.astro
title: Quick start
description: Connect a provider, create your first Hexbot bot, and start working.
---

You need a running daemon and a model provider before a bot can reply. Full runs the daemon on your computer. Client and a browser connect to a daemon elsewhere, such as a [Headless](/docs/install/#headless) one. Follow [Install](/docs/install/) first if you have not set up either one.

## 1. Choose where bots run

Open Hexbot and choose **Run on this machine**. Let setup finish installing the managed runtime. Closing the desktop window can leave the app and daemon running. To run the daemon without the app, install [Headless](/docs/install/#headless).

On another computer, choose **Connect to a daemon** and use its address and pairing code. You can also choose **Sign in with Hex Connect** if the daemon is registered. The daemon computer must stay awake and running for either connection to work.

## 2. Tell bots about yourself

Setup first asks for your name, what you do, and how bots should speak to you. This becomes **About you**, one text that every bot you own reads. Edit it later in Settings, Memory. Only you can write this text.

Keep it practical. Your preferred language, units, and working hours are useful. Passwords and provider keys belong in their credential settings.

## 3. Connect a model provider

Next, sign in to a subscription provider or paste an API key. Choose a default model for new bots and, optionally, a fallback for provider outages or rate limits. Add more providers later in Settings, Providers.

Model credentials and tool credentials are separate. A model key does not configure web search, image generation, or other connectors. Setup offers those tools next; skip any of them and add them later. See [Providers and billing](/docs/providers/).

## 4. Create your first bot

Setup ends by creating your first bot. Choose its name, face, and model, then describe what you want it to do. Hexbot opens the bot's first section, where it introduces itself and may ask a few questions to write its soul and memory. Create more bots later from the roster.

Give it a small first task, such as "Help me plan this week's work. Ask for the deadlines you need." In Bot settings, you can change its Soul, Model, Tools, Connectors, and Skills.

## 5. Give it a workspace

For file work, set **Working directory** in Bot settings, Tools to the project folder on the daemon computer. Enable the tools the task needs. Auto is the default [approval mode](/docs/approvals/): commands run in a sandbox, and requests for more access wait for your approval.

If you connect remotely, files and commands still belong to the daemon computer. Attach a file from your device when the bot needs to read it. Images can be up to 25 MiB; PDFs and other files can be up to 45 MiB each.

## Next tasks

- Start a new [section](/docs/bots-and-sections/) for a different topic without deleting the bot's memory.
- Create a [room](/docs/rooms/) and mention two bots to get both perspectives.
- Turn on Message other bots and give each teammate a description so bots can ask the right one for help.
- Enable [Scheduling](/docs/scheduling/) when you want a job to run while you are away.
- [Pair another device](/docs/pairing-and-lan/) or use [Hex Connect](/docs/connect/) to reach the same daemon.
