---
layout: ../../layouts/Docs.astro
title: Updates
description: Choose a Hexbot update track and control crash reports.
---

The packaged desktop app checks `updates.hexbot.app` for signed updates 15 seconds after it starts and every 4 minutes while it runs. Development builds do not check. You can also choose "Check for Updates" from the application menu on macOS, or open Settings, Updates.

Hexbot does not download an update during the check. When one is available, a pill at the bottom of the roster says "Download update"; once the download is done it says "Restart to update". Settings, Updates shows the same state, the time of the last check, and any error. The app does not install an update on its own when you quit. On Linux only the AppImage updates itself.

## Updating a daemon from another computer

The app and the daemon it talks to can be on different computers. When the daemon runs an older Hexbot than the app, the pill says "Update daemon" and Settings, Updates offers to update it. What happens depends on how the daemon runs on its computer:

- **The Hexbot app runs the daemon.** That app downloads the update on its own track, then closes and reopens on the new version. The daemon comes back with it.
- **The daemon runs at login** (Settings, Network, "Start the daemon at login"). The daemon downloads the new version, installs it, and restarts itself.
- **Started by hand** or from a source checkout. Update Hexbot on that computer yourself.

Bots stop while the daemon restarts; sections and memory stay. The client waits for the daemon to come back and reports a failure if it does not. Only an administrator can start a daemon update.

## Stable and nightly

Hexbot ships on two tracks:

- **Stable** is the tagged releases. While Hexbot is in alpha the app is named `Hexbot [alpha]` and every release is an early build, but each one was checked before it was tagged.
- **Nightly** is built from the main branch every day. It is named `Hexbot Nightly`, installs next to the stable app, and updates itself to the next nightly. It may break; back up `~/.hexbot` before opening one, because the two share it.

A stable install follows the stable track and a nightly install follows the nightly track. You can switch in Settings, Updates. Switching affects the next update check: a stable app on the nightly track is replaced by the next nightly, and a nightly app on the stable track by the next stable release, even when that release has a lower version number. The installed app is not changed until an update is installed.

Dev builds run from a source checkout and do not check for updates.

## What an update check sends

The updater requests package, platform, and architecture-specific metadata from `updates.hexbot.app` (the client-only package uses a separate path), then downloads the selected release artifact from the URL in that metadata. Conversations, provider credentials, bot memory, and pairing codes are not part of the request.

## Crash reports

Crash reporting is off by default. If you opt in through desktop settings, Electron may upload a report when the desktop process crashes. Turning the setting off stops later uploads.

Crash reporting concerns the desktop app, not your model conversations. Review the setting before enabling it on a machine where process diagnostics may contain sensitive system details.
