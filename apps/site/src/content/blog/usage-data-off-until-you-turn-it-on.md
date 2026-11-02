---
title: Usage data, off until you turn it on
description: The apps and the daemon can now send anonymous counts that help us improve Hexbot. Nothing is sent unless you turn it on.
date: 2026-11-01
---

We know how many people visit hexbot.app, but not how many use Hexbot, or which parts break. Starting with today's nightly, you can help with that, if you want to. Nothing is sent until you say yes.

## Where you choose

- The last step of setup asks once. The switch starts off.
- Settings has a new **Privacy** tab with a switch for this app and one for your daemon, plus the switch for crash reports.
- The phone app asks on its first screen, and in Settings.
- On a Headless install, run `hexbot usage-data on` or `off`.

Bots can't change it. On a computer, `DO_NOT_TRACK=1` turns it off too.

## What's sent

Counts, not content. Each install gets a random ID, which is deleted when you turn the switch off. There's no profile of you and no location lookup.

- The apps send that they were used today, and the type of an error.
- The daemon sends that it ran today with how many bots, rooms, and chats it has, a count when a message is sent or a bot or room is made, and the method and code of an error.

Events never include text, names, file paths, or error messages. Only release builds can send at all. A build from source never does.

[Usage data](/docs/usage-data/) lists every event, and the [privacy policy](/privacy/) covers the rest.
