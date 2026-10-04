---
layout: ../../layouts/Docs.astro
title: Install
description: Install Hexbot on macOS or Linux.
---

Hexbot has a desktop app and a background daemon, shipped as two packages:

- **Full package** (`Hexbot`): the desktop app plus the daemon runtime. Install this on the computer that will run your bots.
- **Client only** (`Hexbot Client`): the desktop app alone. Install this on any other computer, and pair it with a full package over LAN, Tailscale, or Hex Connect. It never installs Python or a daemon.

Both packages update independently and can be installed side by side. You need only one daemon for the devices that share the same bots. A phone or tablet can use the daemon's browser UI without installing the desktop app.

Packages and channels are separate choices. Full and client-only describe what is installed; Stable and Nightly describe which builds you receive. Stable and Nightly share the same `~/.hexbot` data, so back it up before trying a nightly.

## Download

Hexbot is in nightly early access, so the [download page](/download/) offers the current nightly build. It picks the build for your computer and lists every other one. Every nightly is also listed on [GitHub](https://github.com/The1UNeed/hexbot/releases?q=nightly), and the two tracks are described under [Updates](/docs/updates/):

- Apple Silicon for Macs with an M-series chip
- Intel for older Macs
- AppImage for a portable Linux app
- deb for Debian, Ubuntu, and related distributions

The full package runs on macOS 12 or later, and on x86-64 Linux with glibc 2.35 or later, such as Ubuntu 22.04 or Debian 12. If the daemon cannot run on your system, first launch says so.

Windows and Linux ARM packages are not currently provided. To run on a server without the desktop app, use [Run from source](/docs/development/).

## First launch

The full package asks where Hexbot should run:

1. **Run on this machine.** Hexbot installs its daemon under `~/.hexbot`. The full package includes the native Rust daemon, Node, the Pi agent runtime, the web UI, bundled skills, and search tools. First launch provisions Python 3.11 for code tools and voice dependencies through pinned, checksum-verified downloads. You do not need to install Rust or Node yourself, and Hexbot does not replace system copies.
2. **Connect to a daemon.** Use a pairing link, enter the daemon address and one-time code, or sign in with Hex Connect to choose a registered daemon.

The client-only package opens straight on the connect screen.

Setup then asks for a model provider, your default models, and the tools that need their own account: web search, cloud browser, image and video generation, and premium voice. Pick a provider for a tool and paste its key, or skip it. A bot cannot use a tool that is not set up; add it later under a bot's Connectors.

The first-run About you page asks for your name, work, and preferred way of speaking. After setup, follow [Quick start](/docs/quick-start/) to create a bot and send its first message. Model providers and optional tool services bill your own accounts.

The daemon must keep running and the computer must remain awake for remote devices and scheduled work. Quitting the app stops an app-owned daemon unless a background service is already installed. For an independent daemon, use [Run from source](/docs/development/). For a second device, enable **Allow other devices** in Settings, Network and follow [Pairing and LAN](/docs/pairing-and-lan/).

## macOS

Open the DMG and drag Hexbot to Applications, then launch it from there. Choose Apple Silicon or Intel to match your Mac. Release signing and notarization depend on the build; consult that build's release notes if macOS raises a warning. Download through [hexbot.app](/download/) or the official GitHub releases.

## Linux

Use the exact filename you downloaded. Replace `<version>` below with its full version, including any nightly suffix. Client-only files start with `HexbotClient` instead of `Hexbot`.

Make an AppImage executable before opening it:

```sh
chmod +x "./Hexbot-<version>-linux-x86_64.AppImage"
"./Hexbot-<version>-linux-x86_64.AppImage"
```

Install a deb package with your usual package manager:

```sh
sudo apt install "./Hexbot-<version>-linux-amd64.deb"
```

The deb package depends on `bubblewrap`; with the AppImage, install it yourself (`sudo apt install bubblewrap`). Hexbot uses it to keep shell commands, Python code, and scheduled scripts inside the workspace and away from your credentials. Without it, Manual and Auto ask before every shell command and code run, scheduled scripts run only in Bypass, and Settings, Approvals shows a notice. Restart the daemon after installing it. See [Approvals](/docs/approvals/).

### Ubuntu 24.04 and later

Ubuntu 24.04 confines unprivileged user namespaces with AppArmor, and the `bubblewrap` package ships no profile, so a fresh install still has no sandbox: `bwrap --ro-bind / / --unshare-pid --proc /proc -- true` prints `bwrap: setting up uid map: Permission denied`, and Settings, Approvals keeps its notice. Give bubblewrap its own profile; it lets only `bwrap` create user namespaces and leaves the system-wide restriction in place:

```sh
sudo tee /etc/apparmor.d/bwrap >/dev/null <<'EOF'
abi <abi/4.0>,
include <tunables/global>

# bubblewrap builds its sandbox in an unprivileged user namespace.
profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
}
EOF
sudo apparmor_parser -r /etc/apparmor.d/bwrap
```

Run the `bwrap` command above again; it should print nothing and exit 0. Then restart the daemon. The profile loads again on every boot. Other distributions that restrict user namespaces need the same kind of exception; one with `sysctl kernel.unprivileged_userns_clone=0` needs that setting turned on.

## Data and updates

Hexbot stores configuration, bots, conversations, memory, and its managed runtime in `~/.hexbot`. The default workspace for bot file work is `~/Hexbot`, outside the daemon's private data directory. Choose another project folder in Bot settings, Tools.

Stop the daemon before copying its whole data directory for a backup or move. Back up project files separately. Client-only installs keep window state and pairing tokens locally; the connected daemon holds the bots and history.

The desktop app checks `updates.hexbot.app` for updates and waits for your confirmation before downloading and installing one. The update server does not receive your conversations, provider keys, or pairing codes. See [Updates](/docs/updates/) for tracks, remote daemon updates, and native manifest verification.

## If setup fails

- Check that the computer meets the full package's OS requirements and can download the managed dependencies.
- On Linux, check the sandbox notice in Settings, Approvals after installing bubblewrap.
- If a provider cannot connect, check its error and credentials in Settings, Providers. Tool connectors have their own setup and test actions.
- If another device cannot connect, confirm the daemon is running, LAN access is enabled, and the pairing code has not expired.
- If Hexbot says another daemon owns the home directory, stop that daemon before starting a replacement. Two daemons cannot use one data directory at once.

## Development app

From a source checkout, run `pnpm dev --desktop` to launch
`Hexbot (dev)` with its blue Dev icon. On macOS it has its own app identity in
the Dock and app switcher, so you can distinguish it from Stable and Nightly.
The source app keeps its data in the checkout's `.hexbot` directory. [Run from source](/docs/development/) has the prerequisites, installation commands, and standalone daemon instructions.
