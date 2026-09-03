---
layout: ../../layouts/Docs.astro
title: CLI
description: Start, pair, and manage Hexbot from the command line.
---

# Hexbot CLI

The `hexbot` command wraps the agent core and adds commands for the Hexbot daemon and data model.

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

Use command help before destructive actions. Deleting a bot removes its profile and associated sections when the daemon accepts the request.

## Send a message

```sh
hexbot send <bot> <text>
```

The named bot uses its configured provider, model, persona, skills, and memory.

## Reach the underlying CLI

Every retained Hermes command is available through:

```sh
hexbot hermes <args>
```

Run `hexbot --help` and command-specific `--help` output for the installed version's exact options. Behavioral settings belong in `~/.hexbot/config.yaml`; API keys and other credentials belong in the private environment file managed by setup.
