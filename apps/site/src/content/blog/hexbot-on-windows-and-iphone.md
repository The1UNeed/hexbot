---
title: Hexbot on Windows, and on every iPhone
description: Hexbot now runs on 64-bit Windows as Full, Client, or Headless. Anyone can install the iPhone app from TestFlight, and every nightly reaches it.
date: 2026-11-11
---

Hexbot started on the Mac and Linux. From today it's officially on Windows too, and the iPhone app is open to everyone through TestFlight.

## Windows

Hexbot runs on Windows 10 or later, 64-bit, with the same three options as on a Mac or Linux:

- **Full**: the app and the daemon, for the computer your bots live on.
- **Client**: the app alone, for your other computers. It connects to a daemon elsewhere.
- **Headless**: the daemon alone, started by a logon task in Task Scheduler.

The [download page](/download/) offers the terminal installer and, under "All downloads", the Full and Client packages (.exe). Run the installer in PowerShell:

```powershell
.\hexbot-install-<version>-windows-x86_64.exe --full
```

Use `--client` or `--headless` instead, or run it again with `--repair` or `--uninstall`. Full and Client install for your user only, in `%LOCALAPPDATA%\Hexbot\apps`, with no administrator rights.

Your bots are contained on Windows too. In Auto and Manual, their shell commands and scheduled scripts run in an AppContainer, the app sandbox built into Windows, with no network and no way into your user folder or saved credentials. They use the BusyBox shell that ships with Hexbot. Windows has no full access, so a command that needs the internet or a file outside the workspace runs only in Bypass, which uses Git Bash from Git for Windows. [Approvals](/docs/approvals/) has the details.

Not yet on Windows: the windowed Hexbot Installer, and builds for ARM.

## iPhone, for everyone

Anyone can install Hexbot for iPhone. Open [the TestFlight link](https://testflight.apple.com/join/byKAKWMW) on your iPhone or iPad, install TestFlight if asked, then install Hexbot and pair it with your daemon. You don't need an invite.

From today, every nightly goes to everyone who joined through that link, once Apple has reviewed it, and TestFlight updates the app for you. Like Client, the iPhone app runs no bots itself. They stay on your daemon, and the phone reaches them over your network, Tailscale, or Hex Connect. [Mobile app](/docs/mobile/) covers pairing.

Android is still built from source for now.

## Get it

[Download Hexbot](/download/) for Windows, Mac, or Linux, or [get it on TestFlight](https://testflight.apple.com/join/byKAKWMW) for iPhone. It's free and open source under Apache-2.0. If something breaks, [open an issue on GitHub](https://github.com/The1UNeed/hexbot/issues).
