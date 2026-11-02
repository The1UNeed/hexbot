---
layout: ../../layouts/Docs.astro
title: Mobile app
description: Build the Hexbot Expo app for iPhone and Android and connect to your daemons.
---

The Expo app in `apps/mobile` runs on iOS and Android. Its controls cover bots,
their chats, rooms, approvals, models, memory, scheduled jobs and paired
devices.
Bots run on your daemon's computer while your phone is asleep.

## Get the iPhone beta

Hexbot for iPhone is in beta on TestFlight. On your iPhone or iPad, open
[the TestFlight invite](https://testflight.apple.com/join/byKAKWMW), install
TestFlight if asked, then install Hexbot and pair it with your daemon as
described in [Connect locally](#connect-locally).

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

## TestFlight builds

The iOS beta is distributed through TestFlight. Maintainers use Expo EAS
Workflows to check the app, create a production build and upload it. Apple
processes the binary afterward. The GitHub Release action starts Expo for
nightly releases after checks pass, using the exact release commit. Stable
releases currently skip iOS. Ordinary pushes to `main` do not release iOS.
The Expo project must be linked to the repository with `apps/mobile` as its
base directory, and GitHub needs the `EXPO_TOKEN` repository secret.
Enable automatic
distribution on an internal TestFlight group to deliver new builds to its
testers.

From the repository root, `pnpm mobile:testflight` starts the same workflow
and waits for its result. If uploading fails after a successful build,
`pnpm mobile:testflight:upload --input build_id=YOUR_EAS_BUILD_ID` retries
the upload without rebuilding. Both workflows show their stages and logs in
Expo. Apple review remains separate. Maintainer setup is in
`apps/mobile/README.md` and `docs/release.md`.

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

Bots lists each bot with its role and description. Tap a bot to open your chat
with it; each bot has one, which keeps going. Long-press a bot, or use the
button at the top right of the chat, for its settings, where you pick its model
and thinking level from the providers you have connected. A new model applies
from the chat's next message.

Rooms shows one room at a time, with a switcher when you have several. Daemon shows what your bots are doing now and
opens settings, models, plugins (connectors, MCP servers, skills and built-in tools), jobs, About you, usage, bot
activity, devices, network, Hex Connect and updates. Settings and
editors open as cards over the screen you came from. One person owns the daemon; paired devices access that person’s bots and rooms.

A room opens at its latest messages; Show earlier messages loads older ones.
Rooms take messages while bots work. A bot's chat takes one at a time, so Stop
replaces Send until its bot finishes. Removing a room's last bot deletes the
room, and the app asks first.

Job details show the last status, error and up to 12,000 characters of output
saved on the daemon. Attachments can be sent without text. The app asks the bot
to review the files and keeps attachment chips until the send succeeds. A
message carries only the files picked for it, and files picked for a chat you
leave without sending are removed from the daemon. Older
daemons show an update notice for unavailable attachment or job controls.

When a bot's [heartbeat](/docs/bots-and-sections#heartbeat) writes to you,
the phone gets a notification, if you allowed notifications and the daemon is
on Hex Connect. The notification only says one of your bots has a message;
the message stays on your daemon until you open it. Tap it to open that bot's
chat, on the right daemon if you have several. Each bot's checklist is under
Heartbeat in its profile. The app does not
provide computer power controls. For development checks and native simulator flows,
see `apps/mobile/README.md` and `docs/testing.md` in the repository.
