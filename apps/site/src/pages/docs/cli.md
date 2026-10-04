---
layout: ../../layouts/Docs.astro
title: CLI
description: Start, pair, and manage the native Hexbot daemon from a terminal.
---

The native `hexbot` command starts the daemon, manages bots and devices, registers Hex Connect, and sends one-shot messages. Use a native binary from a full installation or build it with [Run from source](/docs/development/). If it is not on your PATH, use its full path.

```sh
hexbot --help
hexbot --version
```

Commands use `~/.hexbot` by default. Set `HEXBOT_HOME` to select another data directory. Use the same directory for the server and administrative commands; a pairing code from another home will not authenticate with your daemon.

## Start a daemon

```sh
hexbot serve
```

The default port is 9119. A fresh daemon listens on localhost. You can choose a numeric bind address and port, or enable LAN access:

```sh
hexbot serve --host 127.0.0.1 --port 9119
hexbot serve --lan --port 9119
```

Run one of these commands, not both against the same home. `--lan` saves the LAN setting; `--no-lan` turns it off. Without either flag, the saved setting applies. Settings, Network can also change LAN access while the daemon runs.

When started directly in an interactive terminal, the daemon prints a one-time browser sign-in link. It does not print one when supervised as a service or redirected to a log. The standalone release binary needs a Pi launcher configured through `HEXBOT_PI_EXECUTABLE`.

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

Creation accepts `--title`, `--description`, `--persona`, `--provider`, and `--model`, each followed by its value. The description helps teammates choose whom to ask. Use the app to configure provider credentials before sending a message.

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

Registration prints an address and code for browser approval. `status` shows the registration and tunnel. `disconnect` stops the tunnel, clears local credentials, and revokes the registration. The daemon keeps working locally.

See [Hex Connect](/docs/connect/) for browser and app sign-in, remote access, and self-hosting the service.

## Source and custom homes

For a source binary, point commands at the same home as the server:

```sh
HEXBOT_HOME="$PWD/.hexbot" backend/hexbot-core/target/debug/hexbot bots list
HEXBOT_HOME="$PWD/.hexbot" backend/hexbot-core/target/debug/hexbot pair
```

The development runner may choose a different port; CLI commands read the running daemon's address from that home. Manage provider keys, connectors, budgets, and bot settings in the app. Legacy administration commands for the former Python daemon are not part of this CLI.
