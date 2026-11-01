---
title: A computer your bots share
description: Your bots now have a Linux desktop of their own. Watch them use it live, see whose cursor is whose, and take control when you need to.
date: 2026-10-27
image: /screens/computer.webp
---

Some jobs only exist behind a web page with no API: a supplier's order form, a market's booking site, an old admin panel. Until today, a bot doing that kind of job drove your own computer, and you couldn't see what it was doing or stop it halfway.

Starting with today's nightly, your bots have a computer of their own.

## One computer, all your bots

It's a Linux desktop with a browser and a terminal, made with [Cua](https://cua.ai) in Docker on the daemon's computer and kept apart from yours. Every bot can use it. They take turns, one action at a time.

![Your bots' computer, open large, with Juniper's pink cursor filling in a Night Market booking form and Scout's blue cursor beside it.](/screens/computer.webp)

## Watch, and step in

Open the **Computer** tab beside a chat, in the app or the browser, or open it on your phone, and watch the screen live. Each bot working there has a cursor wearing its own face, so you can tell who is doing what.

If something goes wrong, choose **Take control**. The bots stop after the action they're on, and the mouse and keyboard are yours. Choose **Give back** when you're done.

You can turn the computer on or off, restart it, reset it, or change its size from a bot's Tools settings, or with `hexbot computer` in a terminal. It needs Docker and the `cua` command on the daemon's computer. Without them, the Computer tab tells you what's missing. See [Your bots' computer](/docs/tools-and-skills/#your-bots-computer).

## Also in this nightly: Recall

Sent something you regret? You can now **Recall** your latest message while the bot is still working on it, or after its turn stopped. Hover over the message and choose Recall next to Copy, or long-press it on the phone. The bot stops, the message and anything after it leave the chat, and the text goes back in the message box to edit.

![Copy and Recall beside Maya's latest message while Ledger is still working on it.](/screens/recall.webp)

The rest of the chat stays exactly as it was, so the next reply still uses the prompt cache. Anything the bot already did stays done. Error cards now have a close button too.
