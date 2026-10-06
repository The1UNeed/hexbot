---
layout: ../../layouts/Docs.astro
title: CLI
description: Start, pair, and manage the native Hexbot daemon from a terminal.
---

The native `hexbot` command starts the daemon, runs it as a service, manages bots, devices and Hex Connect, lists rooms, and sends one-shot messages.

A [Headless](/docs/install/#headless) install puts the command in `~/.local/bin/hexbot`. It always runs the daemon version that is currently installed, so it keeps working after an update.

```sh
hexbot --help
hexbot --version
```

Commands use `~/.hexbot` by default. Set `HEXBOT_HOME` to select another data directory. Use the same directory for the server and administrative commands; a pairing code from another home will not authenticate with your daemon.

## Start a daemon

```sh
hexbot serve
```

The default port is 9119. A fresh daemon listens on localhost. You can choose a numeric bind address and port:

```sh
hexbot serve --host 127.0.0.1 --port 9119
```

Turn on "Allow other devices" only when another device needs access: `hexbot lan on` turns it on, whether or not the daemon is running, and `hexbot lan off` turns it off. `hexbot serve --lan` and `--no-lan` do the same as they start; without either flag, the saved setting applies. A daemon run by the app or by the service is already running; stop it before you start one by hand.

When started directly in an interactive terminal, the daemon prints a one-time browser sign-in link. It does not print one when supervised as a service or redirected to a log.

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

This prints a reachable address, one-time code, pairing link, and terminal QR code. The code works once and expires after ten minutes. Creating it does not turn on LAN access. Enable LAN first if another device needs to reach the daemon.

Enter the address and code in the app or on the browser sign-in page. Do not publish the code. See [Pairing and LAN](/docs/pairing-and-lan/) for device setup and troubleshooting.

## Manage bots

```sh
hexbot bots list
hexbot bots create writer --description "Reviews drafts and edits copy"
```

Creation accepts `--title`, `--description`, `--persona`, `--provider`, `--model`, and `--reasoning-effort`, each followed by its value. The description helps teammates choose whom to ask. Use the app to configure provider credentials before sending a message.

To remove a bot:

```sh
hexbot bots delete writer
```

Deletion removes the bot's profile, conversations, memory, and scheduled jobs. Stop any active work first. This operation is permanent.

## Send a message and list rooms

Quote the message so the shell passes it as one argument:

```sh
hexbot send writer "Summarize the unfinished work in my notes"
hexbot rooms list
```

The named bot uses its configured model, soul, skills, and memory. When a daemon is already running, the CLI sends the request to it. If none is running, one-shot chat can start the runtime for that request. Interactive approvals and clarification questions are answered in the terminal.

The native CLI lists rooms; create rooms and manage their members in the app or browser.

## List and revoke devices

```sh
hexbot devices list
hexbot devices revoke "DEVICE_ID"
```

Replace `DEVICE_ID` with an ID from the list. Revoking a device invalidates its token and ends its access. Pair it again to restore access.

## Manage Hex Connect

```sh
hexbot connect --name "Studio Mac"
hexbot connect status
hexbot connect disconnect
```

Registration prints an address and code for browser approval. `status` shows the registration and tunnel. `disconnect` stops the tunnel, clears local credentials, and asks Connect to revoke the registration; if Connect cannot be reached, revoke the daemon from your daemons page. The daemon keeps working locally.

See [Hex Connect](/docs/connect/) for browser and app sign-in, remote access, and self-hosting the service.

## Source and custom homes

For a source binary, point commands at the same home as the server:

```sh
HEXBOT_HOME="$PWD/.hexbot" backend/hexbot-core/target/debug/hexbot bots list
HEXBOT_HOME="$PWD/.hexbot" backend/hexbot-core/target/debug/hexbot pair
```

The development runner may choose a different port; CLI commands read the running daemon's address from that home. Manage provider keys, connectors, budgets, and bot settings in the app. Legacy administration commands for the former Python daemon are not part of this CLI.
