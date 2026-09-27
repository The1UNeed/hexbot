---
layout: ../../layouts/Docs.astro
title: Install
description: Install Hexbot on macOS or Linux.
---

Hexbot has a desktop app and a background daemon, shipped as two packages:

- **Full package** (`Hexbot`): the desktop app plus the daemon runtime. Install this on the computer that will run your bots.
- **Client only** (`Hexbot Client`): the desktop app alone. Install this on any other computer, and pair it with a full package over LAN, Tailscale, or Hex Connect. It never installs Python or a daemon.

Both packages update independently and can be installed side by side.

## Download

Hexbot is in nightly early access, so the [download page](/download/) offers the current nightly build. It picks the build for your computer and lists every other one. Every nightly is also listed on [GitHub](https://github.com/The1UNeed/hexbot/releases?q=nightly), and the two tracks are described under [Updates](/docs/updates/):

- Apple Silicon for Macs with an M-series chip
- Intel for older Macs
- AppImage for a portable Linux app
- deb for Debian, Ubuntu, and related distributions

## First launch

The full package asks where Hexbot should run:

1. **Run on this machine.** Hexbot installs its daemon under `~/.hexbot`. You can let it start at login and continue running after the desktop window closes. The first run may download Python 3.11, uv, Git, and ripgrep. Hexbot keeps these managed tools inside `~/.hexbot`; it does not replace system copies.
2. **Connect to a daemon.** Use a pairing link or enter the daemon address and one-time code.

The client-only package opens straight on the connect screen.

Setup then asks for a model provider, your default models, and the tools that need their own account: web search, cloud browser, image and video generation, and premium voice. Pick a provider for a tool and paste its key, or skip it. A bot cannot use a tool that is not set up; add it later under a bot's Connectors.

## macOS

Open the DMG and drag Hexbot to Applications. Public releases are signed and notarized. If macOS reports a damaged or unidentified app, verify that you downloaded it from `hexbot.app` and try the current release again.

## Linux

Make an AppImage executable before opening it:

```sh
chmod +x Hexbot-0.1.5-alpha.1-linux-x86_64.AppImage
./Hexbot-0.1.5-alpha.1-linux-x86_64.AppImage
```

Install a deb package with your usual package manager:

```sh
sudo apt install ./Hexbot-0.1.5-alpha.1-linux-amd64.deb
```

## Data and updates

Hexbot stores configuration, bots, memory, and its managed runtime in `~/.hexbot`. Back up that directory before moving a daemon to another machine. The client-only package keeps only window state and pairing tokens there.

The desktop app checks `updates.hexbot.app` for signed updates. The update server does not receive your conversations, provider keys, or pairing codes.


## Development app

From a source checkout, run `pnpm dev --desktop` to launch
`Hexbot (dev)` with its blue Dev icon. On macOS it has its own app identity in
the Dock and app switcher, so you can distinguish it from Stable and Nightly.
The source app keeps its data in the checkout's `.hexbot` directory.
