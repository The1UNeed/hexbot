---
layout: ../../layouts/Docs.astro
title: Updates
description: Choose a Hexbot update track and control crash reports.
---

The packaged desktop app checks `updates.hexbot.app` for updates 15 seconds after it starts and every 4 minutes while it runs. Development builds do not check. You can also choose "Check for Updates" from the application menu on macOS, or open Settings, Updates.

Hexbot does not download an update during the check. When one is available, a pill at the bottom of the roster says "Update". Clicking it downloads the update, with progress in the pill. Once it is downloaded the pill says "Restart to update"; clicking that asks "Are you sure you want to update to version X?". Yes quits Hexbot, installs the update, and reopens. No leaves the download in place for later. Settings, Updates shows the same state, the time of the last check, and any error. The app does not install an update on its own when you quit. On Linux only the AppImage updates itself.

## Updating a daemon from another computer

The app and the daemon it talks to can be on different computers. When the daemon runs an older Hexbot than the app, the pill says "Update daemon" and Settings, Updates offers to update it. What happens depends on how the daemon runs on its computer:

- **The Hexbot app runs the daemon.** That app downloads the update on its own track, then closes and reopens on the new version. If the app is already up to date and only its daemon is behind, the app checks the available runtime and restarts its own daemon without another download. This works only for a daemon the app started itself, and on Linux it also works outside the AppImage. If preparation fails, the daemon keeps running and the client reports the failure.
- **The daemon runs as a service**, because it was installed as [Headless](/docs/install/#headless) or with Settings, Network, "Start the daemon at login". The daemon downloads the new version, installs it, and restarts itself.
- **Started by hand** or from a source checkout. Update Hexbot on that computer yourself.

Bots stop while the daemon restarts; chats and memory stay. The client waits for the daemon to come back and reports a failure if it does not. A daemon service only updates automatically to a build made from newer source, on either track. These automatic updates refuse a build from equally old source even when its version number is higher. An app can also move its own daemon to a later Nightly with the same version base, as described in [Channels](https://github.com/The1UNeed/hexbot/blob/main/docs/channels.md). When a service or another copy of the app already runs the daemon, the app connects to it and does not stop it.

The app refuses a runtime it cannot verify. When preparing its local daemon, damaged runtime records can stop the Full app from starting or connecting to it. Full has no installer repair for these records. On a Headless computer, run the installer again and choose Update or repair ([Install](/docs/install/)).

Native daemon and installer manifests require a signature from a trusted Hexbot
release key. Their signed checksums pin the downloaded packages. If verification
fails, the installer or Settings, Updates reports: "The update is not signed by
the Hexbot release key. Nothing was installed." The existing installation stays
in place. The installer reports a missing signature file separately from an
unpublished release.
Retry later; if it persists, report the error and version to the maintainer.

For HTTPS mirrors, `HEXBOT_UPDATE_URL` selects the base URL. Signed manifests
keep an absolute `url` for older clients and add a relative `path` that new
clients prefer. Copy manifests, signatures, and packages without changing the
signed files. New clients resolve `path` under the mirror's base path; manifests
without it still use `url`. Downloads must stay on the configured origin.

These signatures do not cover Electron's app update feeds, the initial installer
download, or the legacy Python handoff source package. macOS app updates rely on
code signing; Linux AppImage updates use checksums only. The legacy source
package trusts HTTPS before its native signature check can run.

Existing Python background services try to install the native daemon during their
next update. If the download or runtime validation fails, the update reports failure
and the running daemon keeps going unchanged. Try the update again later.

## Stable and nightly

Hexbot ships on two tracks:

- **Stable** is the tagged releases. While Hexbot is in alpha the app is named `Hexbot [alpha]` and every release is an early build, but each one was checked before it was tagged.
- **Nightly** is built from the main branch every day. It is named `Hexbot Nightly`, installs next to the stable app, and updates itself to the next nightly. It may break; back up `~/.hexbot` before opening one, because the two share it.

Hexbot is in alpha, in very early development, so for now only the nightly track has builds.

A stable install follows the stable track and a nightly install follows the nightly track. You can switch in Settings, Updates. Switching affects the next update check: a stable app on the nightly track is replaced by the next nightly, and a nightly app on the stable track by the next stable release, even when that release has a lower version number. The installed app is not changed until an update is installed.

Dev builds run from a source checkout and do not check for updates.

The [installer](/docs/install/#run-it-again) installs from a track too. A new install uses Stable once it is published and Nightly until then; `--stable` or `--nightly` chooses. Update or repair keeps the installed track and refuses a version older than the highest valid version in the receipt, installed apps, or selected native runtime. An app counts for the track of its version, so an app moved to Nightly in Settings does not block Update or repair on Stable. The installer rechecks after downloading and holds a shared lock until replacement and receipt writing finish; a second installer says "Waiting for another Hexbot installer to finish." until then. Headless also waits while the daemon installs an update, then checks again. A fresh install or an explicit track change may install an older version.

## What an update check sends

The updater requests package, platform, and architecture-specific metadata from `updates.hexbot.app` (the client-only package uses a separate path), then downloads the selected release artifact from the URL in that metadata. Conversations, provider credentials, bot memory, and pairing codes are not part of the request.

## Crash reports

Crash reporting is off by default. Turn it on in Settings, Privacy, "Send crash reports", and Electron uploads a report when the desktop process crashes. Turning the setting off stops later uploads. Builds without a crash report address do not show the switch. Anonymous usage data is a separate switch on the same page; see [Usage data](/docs/usage-data/).

Crash reporting concerns the desktop app, not your model conversations. Review the setting before enabling it on a machine where process diagnostics may contain sensitive system details.
