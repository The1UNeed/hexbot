---
layout: ../../layouts/Docs.astro
title: Mobile app
description: Build the Hexbot Expo app for iPhone and Android and connect to your daemons.
---

The Expo app in `apps/mobile` runs on iOS and Android. Its controls cover bots,
threads, rooms, approvals, models, memory, scheduled jobs and paired
devices.
Bots run on your daemon's computer while your phone is asleep.

iOS 26 uses native Liquid Glass for floating controls. Older iOS uses system
blur. Android and Reduce Transparency use solid controls. The app follows
light and dark appearance and supports larger text.

## Build from source

There is no App Store or Play Store release yet. From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm mobile:ios
pnpm mobile:android
```

The iOS command needs Xcode and a simulator or signed device. Android needs
Android Studio, its SDK and a device or emulator. `apps/mobile/eas.json` also
provides development, internal preview and production build profiles.

## Connect locally

Enable local connections on your daemon. Open Settings, Devices on an
existing client, or run `hexbot pair` on that computer. Enter its LAN or
Tailscale address and the one-time code on your phone. A `hexbot://pair` link
opens the installed app with the address filled in. Check the host shown above
Pair and tap to confirm. Allow the iPhone's local network permission.

Use the computer's reachable address rather than `localhost` on a physical
phone. Pairing works independently of Hex Connect.

## Use Hex Connect

Choose Sign in with Hex Connect, sign in in the system browser, then select
an online registered daemon. The app verifies its pinned identity when supplied
by Connect and exchanges a device-bound grant directly with that daemon.
Chat travels to the daemon rather than through Connect.

The app saves credentials and its proof key in native secure storage. Tap the
daemon's name above Bots to switch daemons, add one, or forget one. Revoking
the phone from Devices returns it to pairing.

## Control a daemon

Bots lists each bot with its role and description. Open a bot to see its
threads, start a new conversation, or change its bot settings. Each thread is a
separate conversation with its own context. Tap the model under New
conversation to pick the bot's model and thinking level from the providers you
have connected; it shows the level the model actually runs at. Existing threads
following its defaults also change when idle; threads with overrides keep them.

Rooms shows one room at a time, with a switcher when you have several. Daemon shows what your bots are doing now and
opens settings, models, connectors, skills, jobs, About you, usage, bot
activity, devices, network, Hex Connect and updates. Settings and
editors open as cards over the screen you came from. One person owns the daemon; paired devices access that person’s bots and rooms.

A room opens at its latest messages; Show earlier messages loads older ones.
Rooms take messages while bots work. A thread takes one at a time, so Stop
replaces Send until its bot finishes. Removing a room's last bot deletes the
room, and the app asks first.

Job details show the last status, error and up to 12,000 characters of output
saved on the daemon. Attachments can be sent without text. The app asks the bot
to review the files and keeps attachment chips until the send succeeds. A
message carries only the files picked for it, and files picked for a thread you
leave without sending are removed from the daemon. Older
daemons show an update notice for unavailable attachment or job controls. The app does not provide push notifications
or computer power controls. For development checks and native simulator flows,
see `apps/mobile/README.md` and `docs/testing.md` in the repository.
