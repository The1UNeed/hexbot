---
layout: ../../layouts/Docs.astro
title: CLI
description: Start, pair, and manage Hexbot from the command line.
---

The native `hexbot` command starts the daemon, runs it as a service, and manages bots, devices and Hex Connect. It can also list rooms.

A [Headless](/docs/install/#headless) install puts the command in `~/.local/bin/hexbot`. It always runs the daemon version that is currently installed, so it keeps working after an update.

## Start a daemon

```sh
hexbot serve
```

The daemon listens on localhost by default. Turn on "Allow other devices" only when another device needs access: `hexbot lan on` turns it on, whether or not the daemon is running, and `hexbot lan off` turns it off. `hexbot serve --lan` and `--no-lan` do the same as they start. Run `hexbot --help` for the current host and port flags. A daemon run by the app or by the service is already running; stop it before you start one by hand.

## Check the daemon

```sh
hexbot status
hexbot status --json
```

Shows whether the daemon is running, its version and port, its LAN addresses when "Allow other devices" is on, its Tailscale address when `tailscale ip -4` answers, its Hex Connect hostname, whether the service is installed and running, and whether the sandbox is available. It works before the daemon has ever started.

## Run the daemon as a service

```sh
hexbot service install
hexbot service start
hexbot service stop
hexbot service restart
hexbot service status
hexbot service logs
hexbot service logs -f
hexbot service uninstall
```

`install` writes a per-user service and starts it: a launchd agent at `~/Library/LaunchAgents/app.hexbot.daemon.plist` on macOS, a systemd user unit at `~/.config/systemd/user/hexbot.service` on Linux. These are the same files the app writes for "Start the daemon at login". The service starts the daemon at login and restarts it if it stops, and it lets an app on another computer update the daemon. On Linux, `install` also enables lingering so the daemon keeps running after you log out. `status --json` prints `installed`, `running`, `manager`, and `file`. `logs -f` follows the log until you press Ctrl-C. `uninstall` stops the service and removes its file; your data stays.

## Set up an installed runtime

```sh
hexbot setup
```

Installs the code tools (uv, Python 3.11, and the voice tools) into `~/.hexbot` and writes the `hexbot` command in `~/.local/bin`, or repairs them. If `~/.local/bin` is not on your `PATH`, it prints the line to add. `--no-code-tools` skips Python and the voice tools, and `--json` prints progress as one JSON object per line. The installer runs `hexbot setup --activate` from a downloaded daemon runtime, which also checks every file against the runtime's manifest and makes it the current daemon; you rarely need it yourself.

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
