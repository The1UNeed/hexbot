---
layout: ../../layouts/Docs.astro
title: Install
description: Install Hexbot on macOS or Linux as Full, Client, or Headless.
---

Hexbot has two parts: the **daemon**, which runs your bots, rooms, and memory, and the **app** you talk to them in. Install one of three options on each computer:

- **Full** (`Hexbot`): the app and the daemon. Install this on the computer that will run your bots.
- **Client** (`Hexbot Client`): the app alone. Install it on any other computer and connect it to a daemon over LAN pairing, Tailscale, or Hex Connect. It never installs Python or a daemon.
- **Headless**: the daemon alone, as a background service, with the `hexbot` command. Install it on a server or any computer you reach over SSH, and use it from another computer with Client or Full. See [Headless](#headless).

Full and Client install side by side and update independently.

Hexbot runs on macOS 12 or later (Apple Silicon or Intel) and on x86-64 Linux with glibc 2.35 or later, such as Ubuntu 22.04 or Debian 12. If the daemon cannot run on your system, the installer or first launch says so.

## Two ways to install

Both ways offer the same three options and download only the files for the option you choose.

### Hexbot Installer

The [download page](/download/) offers the Hexbot Installer for your computer: a .dmg for macOS, an AppImage for Linux. Open it, choose Full, Client, or Headless, and install. On Linux, make the AppImage executable first (right-click it, or `chmod +x` it).

### Terminal

```sh
curl -fsSL https://hexbot.app/install.sh | sh
```

This works over SSH. The script picks the build for your computer, downloads the terminal installer, checks its SHA-256 checksum, and asks which option to install. To skip the question, name the option:

```sh
curl -fsSL https://hexbot.app/install.sh | sh -s -- --headless
```

| Flag | What it does |
| --- | --- |
| `--headless`, `--client`, `--full` | Install this option. |
| `--stable`, `--nightly` | Choose the track. A new install uses Stable once it is published and Nightly until then; an installed copy keeps its track. `HEXBOT_TRACK=nightly` works too. |
| `--repair` | Update or repair what is installed. |
| `--uninstall` | Remove Hexbot. Your data in `~/.hexbot` is kept. |
| `--remove-data` | With `--uninstall`, also delete `~/.hexbot`. |
| `--yes` | Confirm a change or an uninstall without asking. |
| `--json` | Print progress as one JSON object per line. |

Without a terminal to answer questions, as in a provisioning script, pass an option, and `--yes` for a change or an uninstall.

### Run it again

When Hexbot is already installed, either way in offers:

- **Update or repair**: install the current build of the same option on the same track, and put back anything missing.
- **Change**: switch to another option. Your data is kept. Going from Headless to Full keeps the daemon service, and the app uses it; going to Client stops and removes the service.
- **Uninstall**: remove the app or the daemon service. `~/.hexbot` is kept unless you choose to delete it.

If only daemon files are found, the installer asks you to choose an option. It does not assume Headless or enable LAN access. Services and CLI wrappers belonging to another installation are left alone.

The installer never replaces or removes an app while it runs. If Hexbot is open, it asks you to quit it and run the installer again.

### Where it installs

- **macOS**: Full and Client go to `/Applications`, or to `~/Applications` when `/Applications` is not writable.
- **Linux**: Full and Client are AppImages in `~/.local/share/hexbot`, with a desktop entry, an icon, and a handler for `hexbot://` pairing links. The installer never uses `sudo`. If you installed a deb package yourself, remove it with your package manager before you change or uninstall with the installer.
- **Headless**: see [What Headless sets up](#what-headless-sets-up).

The installer records what it installed in `~/.hexbot/install.json`.

### Direct downloads

The Full and Client packages are still on the [download page](/download/#all) under "All downloads", and every nightly is on [GitHub](https://github.com/The1UNeed/hexbot/releases?q=nightly). The two tracks are described under [Updates](/docs/updates/).

- Apple Silicon for Macs with an M-series chip
- Intel for older Macs
- AppImage for a portable Linux app
- deb for Debian, Ubuntu, and related distributions

## First launch

Full asks where Hexbot should run:

1. **Run on this machine.** Hexbot installs its daemon under `~/.hexbot`. You can let it start at login and continue running after the desktop window closes. The app includes the daemon, the agent runtime, and the search tools bots use. First launch downloads Python 3.11 for code tools and the voice tools, each checked against a pinned checksum. Hexbot keeps all of these inside `~/.hexbot`; it does not replace system copies.
2. **Connect to a daemon.** Use a pairing link or enter the daemon address and one-time code.

Client opens straight on the connect screen.

Setup then asks for a model provider, your default models, and the tools that need their own account: web search, cloud browser, image and video generation, and premium voice. Pick a provider for a tool and paste its key, or skip it. A bot cannot use a tool that is not set up; add it later under a bot's Connectors.

## Headless

Headless runs the daemon without the app, for a server, a spare computer, or a Mac mini in a closet. You set up model keys and bots from the app on another computer once it is paired.

```sh
curl -fsSL https://hexbot.app/install.sh | sh -s -- --headless
```

Or open the Hexbot Installer and choose Headless. When it finishes, the installer prints the daemon's port, its addresses, and the commands below.

### What Headless sets up

- The daemon runtime in `~/.hexbot/runtime`, checked against its SHA-256 checksum.
- Python 3.11 for code tools and the voice tools, inside `~/.hexbot`, each checked against a pinned checksum, as Full does on first launch.
- A user service that starts the daemon at login and restarts it if it stops: `~/Library/LaunchAgents/app.hexbot.daemon.plist` on macOS, `~/.config/systemd/user/hexbot.service` on Linux. On Linux the installer also enables lingering (`loginctl enable-linger`), so the daemon keeps running after you log out and starts at boot; if that fails it says so.
- The `hexbot` command in `~/.local/bin`. If that directory is not on your `PATH`, setup prints the line to add to your shell profile.

On Linux, install bubblewrap for the sandbox; see [Linux](#linux). The installer reminds you when it is missing.

### Connect from another computer

A first Headless install, or a change to Headless, turns on "Allow other devices" (LAN access), so the daemon listens on your network and on Tailscale. Update or repair keeps your LAN setting. Turn it off with `hexbot lan off` if you only use [Hex Connect](/docs/connect/), and back on with `hexbot lan on`.

Run `hexbot pair` and pair the Client or Full app on your other computer, by link or by address and code. See [Pairing and LAN](/docs/pairing-and-lan/), [Tailscale](/docs/tailscale/), or, to reach the daemon from anywhere without opening a port, [Hex Connect](/docs/connect/). After pairing, add a model key and your first bot from the app.

### Commands

```sh
hexbot status            # running or not, version, port, addresses, service, sandbox
hexbot pair              # a one-time pairing code, link, and QR code
hexbot connect           # register the daemon with Hex Connect
hexbot lan on            # allow other devices; hexbot lan off stops it
hexbot service status    # installed and running
hexbot service restart   # also start, stop
hexbot service logs -f   # follow the daemon log
```

`hexbot service uninstall` removes the service and `hexbot service install` puts it back. `hexbot setup` repairs the code tools and the `hexbot` command. The [CLI](/docs/cli/) page lists everything.

### Update

When the app on another computer is newer than the daemon, its "Update" pill says "Update daemon"; the daemon downloads the new version, checks it, and restarts. See [Updates](/docs/updates/#updating-a-daemon-from-another-computer). You can also run the installer again on the daemon computer and choose Update or repair:

```sh
curl -fsSL https://hexbot.app/install.sh | sh -s -- --repair
```

### Uninstall

```sh
curl -fsSL https://hexbot.app/install.sh | sh -s -- --uninstall
```

This stops and removes the service, the daemon runtime, and the `hexbot` command. Bots, memory, and settings stay in `~/.hexbot`; add `--remove-data` to delete them too.

## macOS

The Hexbot Installer and the direct downloads are .dmg files. Open the installer from the .dmg; for a direct download, drag Hexbot to Applications. Public releases are signed and notarized. If macOS says it cannot check the app, open System Settings, Privacy and Security, and choose Open Anyway. If macOS reports a damaged or unidentified app, verify that you downloaded it from `hexbot.app` and try the current release again.

## Linux

The installer installs the AppImage for you. To run a downloaded AppImage yourself, make it executable first:

```sh
chmod +x Hexbot-0.1.5-alpha.1-linux-x86_64.AppImage
./Hexbot-0.1.5-alpha.1-linux-x86_64.AppImage
```

Install a deb package with your usual package manager:

```sh
sudo apt install ./Hexbot-0.1.5-alpha.1-linux-amd64.deb
```

The deb package depends on `bubblewrap`; with the AppImage or Headless, install it yourself (`sudo apt install bubblewrap`). Hexbot uses it to keep shell commands, Python code, and scheduled scripts inside the workspace and away from your credentials. Without it, Manual and Auto ask before every shell command and code run, scheduled scripts run only in Bypass, and Settings, Approvals shows a notice. Restart the daemon after installing it (`hexbot service restart` on Headless). See [Approvals](/docs/approvals/).

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

Run the `bwrap` command above again; it should print nothing and exit 0. Then restart the daemon. The profile loads again on every boot. Other distributions that restrict user namespaces need the same kind of exception; one with `sysctl kernel.unprivileged_userns_clone=0` needs that setting turned on. On Headless, `hexbot status` shows whether the sandbox is available.

## Data and updates

Hexbot stores configuration, bots, memory, and its managed runtime in `~/.hexbot`. Back up that directory before moving a daemon to another machine. Client keeps only window state and pairing tokens there. Uninstalling keeps it unless you ask the installer to delete it.

The desktop app checks `updates.hexbot.app` for signed updates. The update server does not receive your conversations, provider keys, or pairing codes.

## Development app

From a source checkout, run `pnpm dev --desktop` to launch
`Hexbot (dev)` with its blue Dev icon. On macOS it has its own app identity in
the Dock and app switcher, so you can distinguish it from Stable and Nightly.
The source app keeps its data in the checkout's `.hexbot` directory.
