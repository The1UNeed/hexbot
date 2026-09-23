---
layout: ../../layouts/Docs.astro
title: Multi-user
description: Share one daemon while keeping ownership, memory, and usage separate.
---

One Hexbot daemon can serve a household or small group. The first user is the admin. Other people join as members through invites.

## Admin and members

The admin manages users, provider credentials, network settings, system limits, and usage for the whole daemon. Members manage their own bots, sections, rooms, memory, and paired devices.

Hexbot assigns every bot, section, room, dream, and device to a user. Members see their own items plus bots that another owner has made shareable. Each user has their own About you text, and only that user's bots receive it.

## Invite someone

Open the Users settings and create an invite with a display name and role. Hexbot returns a pairing code bound to the new user. The invitee uses that code when pairing their first device.

The admin can rename or disable a user later. Disabling a user blocks their devices and new requests without transferring their data.

## Shareable bots

A bot owner can mark a bot as shareable. Other members may then add it to their rooms. The bot keeps its owner's soul, skills, and memory. It does not gain access to the room owner's About you text.

Usage in that room counts against the member who invited the shared bot. This keeps the cost attached to the person who started the work.

## Budgets and usage

The admin can set a daily token budget for each user. A null budget means no Hexbot limit. Once a user reaches the limit, Hexbot refuses new section and room turns until the next daily period.

The Usage view reports input tokens, output tokens, estimated cost, and a breakdown by bot. Members can view only their own usage. The admin can view usage for any user.

Provider invoices remain the final record of charges. Hexbot's cost number is an estimate based on the model information available to the daemon.
