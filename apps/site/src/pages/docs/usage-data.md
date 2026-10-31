---
layout: ../../layouts/Docs.astro
title: Usage data
description: What the Hexbot apps and daemon share when you turn on anonymous usage data, and how to turn it off.
---

Hexbot can share a small amount of anonymous usage data with the Hexbot team, so we can see how many people use it and what breaks. It is off until you turn it on, and nothing is sent before you do. This page lists every event. The [Privacy Policy](/privacy/#app) covers the legal side.

## Turn it on or off

Each place that can send usage data has its own switch, so turning on one does not turn on another.

- **Desktop app** (macOS, Windows, Linux): the "Help improve Hexbot" step at the end of setup, then Settings, Privacy, "This app".
- **Daemon**: the same setup step, then Settings, Privacy, "Daemon", or in a terminal `hexbot usage-data on` and `hexbot usage-data off`.
- **Phone and tablet app**: the switch on the first screen, then Settings, Privacy.
- **hexbot.app and Hex Connect**: the cookie notice, reopened with Cookies at the foot of any page.

On a computer, setting `DO_NOT_TRACK=1` or `HEXBOT_USAGE_DATA=0` in the environment stops the app and the daemon from sending usage data, whatever the switch says. Builds made from source never send it, because they carry no project key.

## What it holds

Every event carries a random install ID, the Hexbot version, the operating system, and which part of Hexbot sent it. The install ID is made when you turn usage data on and deleted when you turn it off, so turning it on again starts a new one. It is not linked to your Connect account, your email address, or any other install. PostHog is told not to look up a location from your IP address and not to build a profile of you.

| Event | Sent by | When | Also carries |
| --- | --- | --- | --- |
| `app_active` | Desktop app | Once a day while it runs | Edition (full or client) and update track |
| `app_error` | Desktop app | A window or helper process stops unexpectedly | Which process and Electron's reason, such as `crashed` |
| `app_active` | Phone app | Once a day while it is used | Whether it is a phone or a tablet |
| `app_error` | Phone app | An unexpected error in the app | The error's type, such as `TypeError`, and whether the app closed |
| `daemon_paired` | Phone app | You pair it with a daemon | Whether you used a code or a link |
| `daemon_active` | Daemon | Once a day while it runs | How many bots, rooms, open chats, and users it has, whether LAN access is on, and the approval mode |
| `message_sent` | Daemon | You send a message | Whether it was in a chat or a room |
| `bot_created` | Daemon | A bot is created | Nothing more |
| `room_created` | Daemon | A room is created | Nothing more |
| `daemon_error` | Daemon | An internal error | The request type and the error number |

## What it never holds

What you or your bots write, bot memory, About you, file names or contents, bot, room, and daemon names, provider keys, passwords, IP addresses, locations, and error messages. Counts are counts: the daemon reports how many chats you have, never what is in them.

## Where it goes

Events go to PostHog's servers in the United States, where PostHog processes them for Lumora Studio. They are kept for up to a year. Because they are anonymous we cannot find yours unless you tell us your install ID: it is `id` in `usage.json` in the Hexbot home for the daemon (`~/.hexbot` by default) and `usageId` in `desktop-state.json` there for the desktop app. Email it to [lumora.studio@hotmail.com](mailto:lumora.studio@hotmail.com) and we will delete its events. The phone app does not show its ID; turning usage data off there deletes it, after which its past events cannot be tied to your phone.
