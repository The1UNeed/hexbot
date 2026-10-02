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

The full package runs on macOS 12 or later, and on x86-64 Linux with glibc 2.35 or later, such as Ubuntu 22.04 or Debian 12. If the daemon cannot run on your system, first launch says so.

## First launch

The full package asks where Hexbot should run:

1. **Run on this machine.** Hexbot installs its daemon under `~/.hexbot`. You can let it start at login and continue running after the desktop window closes. The app includes the daemon, the agent runtime, and the search tools bots use. First launch downloads Python 3.11 for code tools and the voice tools, each checked against a pinned checksum. Hexbot keeps all of these inside `~/.hexbot`; it does not replace system copies.
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

The deb package depends on `bubblewrap`; with the AppImage, install it yourself (`sudo apt install bubblewrap`). Hexbot uses it to keep shell commands, Python code, and scheduled scripts away from your credentials. Without it, Manual asks before every shell command and code run, Auto sends them to you instead of its approver, scheduled scripts wait, and Settings, Approvals shows a notice. Restart the daemon after installing it. See [Approvals](/docs/approvals/).

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

Hexbot stores configuration, bots, memory, and its managed runtime in `~/.hexbot`. Back up that directory before moving a daemon to another machine. The client-only package keeps only window state and pairing tokens there.

The desktop app checks `updates.hexbot.app` for signed updates. The update server does not receive your conversations, provider keys, or pairing codes.


## Development app

From a source checkout, run `pnpm dev --desktop` to launch
`Hexbot (dev)` with its blue Dev icon. On macOS it has its own app identity in
the Dock and app switcher, so you can distinguish it from Stable and Nightly.
The source app keeps its data in the checkout's `.hexbot` directory.
