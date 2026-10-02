---
layout: ../../layouts/Docs.astro
title: CLI
description: Start, pair, and manage Hexbot from the command line.
---

The native `hexbot` command starts the daemon and manages bots, devices and Hex Connect. It can also list rooms.

## Start a daemon

```sh
hexbot serve
```

The daemon listens on localhost by default. Use its LAN option or network settings only when another device needs access. Run `hexbot --help` for the current host and port flags.

## Create a pairing code

```sh
hexbot pair
```

This prints reachable addresses and a one-time code. A code expires after ten minutes. Do not publish it or paste it into an unrelated chat.

## Manage bots

```sh
hexbot bots list
hexbot bots create <name>
hexbot bots delete <name>
```

Run `hexbot --help` for bot creation flags. Deleting a bot removes its settings and associated sections when the daemon accepts the request.

## Send a message

```sh
hexbot send <bot> <text>
```

The named bot uses its configured provider, model, persona, skills, and memory.

## Available commands

Run `hexbot --help` to see the native commands. Legacy core administration
commands are not part of the native daemon. Manage provider keys and settings
in the app.
