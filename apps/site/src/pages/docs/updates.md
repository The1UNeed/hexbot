---
layout: ../../layouts/Docs.astro
title: Updates
description: Choose a Hexbot desktop release channel and control crash reports.
---

# Updates

The packaged desktop app checks `hexbot.app` for signed updates after it starts. Development builds do not check. You can also choose "Check for Updates" from the application menu on macOS.

Hexbot does not download an update during the check. When an update is available, the app shows its progress after you choose to download and install it. It does not install an update automatically when you quit.

## Stable and beta channels

Stable is the default. It receives regular releases intended for general use.

Beta receives prerelease builds as well as stable releases. Beta builds may have unfinished behavior or upgrade problems. Choose it only if you are prepared to report issues and restore your `~/.hexbot` backup if needed.

Changing channels affects future checks. It does not downgrade the installed app or replace it immediately.

## What an update check sends

The updater requests platform and architecture-specific metadata from `hexbot.app`, then downloads the selected release artifact from the URL in that metadata. Conversations, provider credentials, bot memory, and pairing codes are not part of the request.

## Crash reports

Crash reporting is off by default. If you opt in through desktop settings, Electron may upload a report when the desktop process crashes. Turning the setting off stops later uploads.

Crash reporting concerns the desktop app, not your model conversations. Review the setting before enabling it on a machine where process diagnostics may contain sensitive system details.
