---
layout: ../../layouts/Docs.astro
title: Install
description: Install Hexbot on macOS or Linux.
---

# Install Hexbot

Hexbot has a desktop app and a background daemon, shipped as two packages:

- **Full package** (`Hexbot`): the desktop app plus the daemon runtime. Install this on the computer that will run your bots.
- **Client only** (`Hexbot Client`): the desktop app alone. Install this on any other computer, and pair it with a full package over LAN, Tailscale, or Hex Connect. It never installs Python or a daemon.

Both packages update independently and can be installed side by side.

## Download

Pick a package, then choose the build for your computer from the [home page](/):

- Apple Silicon for Macs with an M-series chip
- Intel for older Macs
- AppImage for a portable Linux app
- deb for Debian, Ubuntu, and related distributions

Release downloads will replace the placeholder links before the first public release.

## First launch

The full package asks where Hexbot should run:

1. **Run on this machine.** Hexbot installs its daemon under `~/.hexbot`. You can let it start at login and continue running after the desktop window closes. The first run may download Python 3.11, uv, Git, and ripgrep. Hexbot keeps these managed tools inside `~/.hexbot`; it does not replace system copies.
2. **Connect to a daemon.** Use a pairing link or enter the daemon address and one-time code.

The client-only package opens straight on the connect screen.

## macOS

Open the DMG and drag Hexbot to Applications. Public releases are signed and notarized. If macOS reports a damaged or unidentified app, verify that you downloaded it from `hexbot.app` and try the current release again.

## Linux

Make an AppImage executable before opening it:

```sh
chmod +x Hexbot-0.1.2-linux-x64.AppImage
./Hexbot-0.1.2-linux-x64.AppImage
```

Install a deb package with your usual package manager:

```sh
sudo apt install ./Hexbot-0.1.2-linux-x64.deb
```

## Data and updates

Hexbot stores configuration, bots, memory, and its managed runtime in `~/.hexbot`. Back up that directory before moving a daemon to another machine. The client-only package keeps only window state and pairing tokens there.

The desktop app checks `hexbot.app` for signed updates. The website does not receive your conversations, provider keys, or pairing codes.
