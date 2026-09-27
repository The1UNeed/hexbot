---
layout: ../../layouts/Docs.astro
title: CLI
description: Start, pair, and manage Hexbot from the command line.
---

The native `hexbot` command starts the daemon and manages bots, rooms, devices and Hex Connect.

## Start a daemon

```sh
hexbot serve
```

The daemon listens on localhost by default. Use its LAN option or network settings only when another device needs access. Run `hexbot serve --help` for the current host and port flags.

## Create a pairing code

```sh
hexbot pair
```

This prints reachable addresses and a one-time code. A code expires after ten minutes. Do not publish it or paste it into an unrelated chat.

## Manage bots

```sh
hexbot bots list
hexbot bots create
hexbot bots delete
```

Use command help before destructive actions. Deleting a bot removes its settings and associated sections when the daemon accepts the request.

## Send a message

```sh
hexbot send <bot> <text>
```

The named bot uses its configured provider, model, persona, skills, and memory.

## Available commands

Run `hexbot --help` to see the native commands. Legacy core administration
commands are not part of the native daemon. Manage provider keys and settings
in the app.
