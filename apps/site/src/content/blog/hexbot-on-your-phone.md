---
title: Hexbot on your phone
description: An app for iPhone and Android connects to your daemon over your network, Tailscale, or Hex Connect, and does what the desktop app does.
date: 2026-10-11
---

Your bots keep working while you're away from your desk. Until today, you couldn't talk to them unless you had the desktop app or a browser in front of you. Today we're adding an app for iPhone and Android.

## What it does

The phone app connects to the daemon you already run, the same three ways the desktop app does: on your network, over Tailscale, or through Hex Connect. It doesn't run bots itself. They stay on your daemon's computer, working while your phone sleeps.

From the phone you can:

- chat with any bot and switch between its conversations;
- talk in rooms;
- answer approvals and questions, and send photos and files;
- change a bot's profile, model, and memory, and run a dream;
- manage scheduled jobs, providers, connectors, and skills;
- see your paired devices.

On iOS 26 the controls use Liquid Glass. Older iOS uses the system blur, and Android uses solid controls. The app follows light and dark mode and larger text.

## Getting it

There's no App Store or Play Store release yet. For now you build it from the source with Xcode or Android Studio, then pair it like any other device. [Mobile app](/docs/mobile/) walks you through it.

## Also in this nightly: a daemon belongs to one person

A daemon is now yours alone, with no invites, roles, or other accounts. Rooms now show the name you gave during Get Started.
