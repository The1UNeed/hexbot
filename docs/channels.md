# Channels

Hexbot ships in three channels. All three build from the same `main` branch
and the same code; a channel changes the name, the version suffix, where the
build is published, and who it is for. The model is the one T3 Code uses for
its desktop app (see "Borrowed from T3 Code" at the end).

| | Stable | Nightly | Dev |
| --- | --- | --- | --- |
| Who | Users. Early ones while the version is `0.x` | Testers who want yesterday's fixes | Contributors and agents working on the code |
| App name | `Hexbot [alpha]`, `Hexbot Client [alpha]` until 1.0, then `Hexbot`, `Hexbot Client` | `Hexbot Nightly`, `Hexbot Client Nightly` | `Hexbot (dev)` (packaged) or the source tree |
| Version | `X.Y.Z` or `X.Y.Z-alpha.N`, from `apps/desktop/package.json` | `X.Y.Z-nightly.YYYYMMDD.<run>` | whatever `apps/desktop/package.json` says |
| App id | `app.hexbot.desktop`, `app.hexbot.client` | `app.hexbot.desktop.nightly`, `app.hexbot.client.nightly` | `app.hexbot.desktop.dev`, `app.hexbot.client.dev` |
| Trigger | Push of a `v<version>` tag, or by hand on `main` | 09:00 UTC daily when `main` moved, or by hand | You |
| GitHub release | `v<version>`; "latest" for a plain `X.Y.Z`, prerelease otherwise | `v<version>` prerelease, last 14 kept | None |
| Update feed | `latest-*.yml` on `updates.hexbot.app` | `nightly-*.yml` and `nightlies.json` on `updates.hexbot.app` | None |
| Auto-updates | Yes, stable track | Yes, nightly track | No |
| Website | hexbot.app/download once published, Homebrew casks | hexbot.app/download until the first stable release, read from the nightly feed at build time | `README.md`, "Develop" |
| Data directory | `~/.hexbot` | `~/.hexbot` (shared with stable; back it up) | `<checkout>/.hexbot`, never `~/.hexbot` |

Stable and Nightly can be installed side by side because their app ids
differ. They share `~/.hexbot`, so a nightly can migrate state a stable build
cannot read back. Back up the directory before opening a nightly.

## Which files belong to which channel

Everything under `hexbot/`, `apps/`, and the Hermes core is shared. Channel
behaviour lives in a small set of files:

| File | Channel | Role |
| --- | --- | --- |
| `.github/workflows/ci.yml` | all | Tests and builds on every push and pull request. Publishes nothing. Also called by `release.yml`. Ends with `release-smoke.mjs` |
| `.github/workflows/release.yml` | stable, nightly | One workflow for both channels: `preflight` picks the channel and version, `check` runs CI, `build` makes six packages, `publish` uploads the feed, creates the GitHub release, and after a nightly redeploys the site, `finalize` (stable only) commits the website manifest and casks |
| `scripts/desktop/release-version.mjs` | stable, nightly | Channel and version rules: tag must match `package.json`, nightly version format, product names. Tested in `packaging.test.mjs` |
| `scripts/desktop/set-version.mjs` | all | Writes one version into `apps/desktop/package.json` and `hexbot/__init__.py` |
| `scripts/desktop/dist.mjs` | all | `--channel stable\|nightly\|dev` sets the product name and app id passed to electron-builder |
| `scripts/desktop/make-update-feed.mjs` | stable, nightly | Builds the `updates.hexbot.app` directory tree from a build output: artifacts plus `latest-*.yml` or `nightly-*.yml` |
| `scripts/desktop/finalize-release.mjs` | stable | Rewrites `apps/site/public/downloads/manifest.json` and both Homebrew casks for a version |
| `scripts/desktop/release-smoke.mjs` | stable, nightly | Runs the scripts above the way `release.yml` does, against synthetic packages. CI runs it on every push |
| `scripts/dev/run.mjs` | dev | `pnpm dev`: daemon and web bundle (or Electron) from the checkout with a per-checkout home and ports |
| `.devcontainer/devcontainer.json` | dev | One-command development environment with Python 3.11, uv, and Node 26 |
| `apps/desktop/electron-builder.yml`, `electron-builder.client.yml` | all | Full and client-only package definitions and their feed URLs; channel flags override `productName` and `appId` |
| `apps/desktop/src/main/updater.ts`, `update-state.ts`, `desktop-state.ts` | stable, nightly | The in-app updater: a check 15 s after launch and every 4 minutes, one action at a time, logged to `<home>/logs/desktop.log`. The track defaults to the one the build came from and can be switched in Settings, Updates |
| `apps/desktop/src/main/remote-update.ts`, `hexbot/update.py` | stable, nightly | A daemon updating on a client's request: the app that runs it updates itself, or a service-run daemon fetches `daemon/hexbot-src-<v>.tar.gz` and restarts |
| `apps/web/src/app/update-pill.tsx`, `stores/updates.ts` | all | The roster pill and the Settings, Updates page: download, restart, and "Update daemon" |
| `apps/site/public/downloads/manifest.json` | stable | Names the downloadable artifacts on hexbot.app; written by `finalize` |
| `scripts/desktop/update-nightly-index.mjs` | nightly | Prepends each nightly to `nightlies.json` on `updates.hexbot.app` (last 30) so hexbot.app can list earlier builds. Tested in `packaging.test.mjs` |
| `apps/site/src/lib/nightly.ts` | nightly | Reads the `nightly-*.yml` feed on `updates.hexbot.app` while the site builds, so the download page can offer the current nightly before the first stable release |
| `packaging/homebrew/*.rb` | stable | Homebrew casks pointing at `updates.hexbot.app`; written by `finalize` |
| `docs/releases/<version>.md` | stable | Release notes; `release.yml` uses this file as the GitHub release body when it exists, otherwise GitHub generates notes |

## Stable

A stable release is a `v<version>` tag on `main`, where `<version>` is
exactly what `apps/desktop/package.json` says (`release.yml` refuses any
other tag). While Hexbot is `0.x`, every version carries a suffix such as
`-alpha.1`, the app is named `Hexbot [alpha]`, and the GitHub release is a
prerelease. The first plain `X.Y.Z` becomes the repository's "latest"
release and drops the suffix from the app name; `productName()` in
`release-version.mjs` encodes that rule, so nobody removes `[alpha]` by hand.

Release steps are in `docs/release.md`. In short: `node
scripts/desktop/set-version.mjs 0.x.y-alpha.N`, write
`docs/releases/0.x.y-alpha.N.md`, commit, then either run the Release
workflow on `main` with channel `stable` (it creates the tag) or push the
`v0.x.y-alpha.N` tag yourself. The workflow does the rest, including the update feed, the website manifest,
and the casks.

## Nightly

`release.yml` runs at 09:00 UTC. If `main` has not moved since the last
nightly it stops in `preflight`. Otherwise it builds all six packages as
`<base>-nightly.<YYYYMMDD>.<run number>` and publishes a GitHub prerelease
with that tag. `<base>` is the version the nightly leads to: the next patch
after a plain `X.Y.Z` in `package.json`, or the same `X.Y.Z` when
`package.json` already carries a suffix (`0.1.5-alpha.1` builds
`0.1.5-nightly.20260906.42`). SemVer orders `nightly` after `alpha`, so a
nightly always sorts above the stable build it was cut from and the nightly
track never sees a downgrade.

A manual nightly run (`workflow_dispatch`) builds even when nothing changed. Only the
last 14 nightlies are kept on GitHub; the update feed keeps every artifact.

Nightly packages carry the purple icon from
`apps/desktop/build/icon-nightly.icon`, so a nightly install is easy to tell
apart from stable in the Dock.

Nightlies are signed when the signing secrets are present and ad-hoc signed
otherwise. They are notarized only when the Apple secrets are set.

## Dev

The dev channel is the source tree. `pnpm dev` starts the daemon and the
web bundle from the checkout with `HEXBOT_HOME=<checkout>/.hexbot` and ports
derived from the checkout path; `pnpm dev --desktop` starts the Electron
app as `Hexbot (dev)` instead (it runs the daemon itself). Its window, app
menus, Dock, and app switcher use this name and the blue icon from the
`apps/desktop/build/icon-dev.icon` bundle. Its data stays in the checkout's
`.hexbot` directory.
On macOS, `scripts/dev/electron-launcher.mjs` creates an ad-hoc signed copy
of Electron under `apps/desktop/.electron-runtime/` with a bundle id unique
to the checkout and edition. The installed Electron dependency stays unchanged.
See `README.md`, "Develop", and
`scripts/dev/run.mjs`. Or open the repository in the dev container.

A packaged dev build (`node scripts/desktop/dist.mjs --mac` without
`--channel`) is named `Hexbot (dev)` and uses its own app id so it never
collides with an installed stable or nightly build. Both editions use the Dev
icon; the client-only app is named
`Hexbot Client (dev)`. Dev builds do not check for updates, including packaged
builds. `HEXBOT_CHANNEL` is set at build time by `dist.mjs`.

## The update server

`updates.hexbot.app` is a Cloudflare R2 bucket behind a custom domain. The
desktop app's electron-updater uses the generic provider against it, so
updates do not depend on the GitHub repository being public and no code runs
on the server. `release.yml` uploads this tree on every stable and nightly
release:

```
full/mac/arm64/latest-mac.yml       stable feed  (electron-updater channel "latest")
full/mac/arm64/nightly-mac.yml      nightly feed
full/mac/arm64/Hexbot-<v>-mac-arm64.zip|.dmg
full/mac/x64/...
full/linux/x64/latest-linux.yml, nightly-linux.yml, Hexbot-<v>-linux-x64.AppImage|.deb
client/...                          the same for HexbotClient-*
daemon/hexbot-src-<v>.tar.gz        the daemon source the full package stages, for daemons updating themselves
```

Artifacts are immutable (their names carry the version); the `.yml` files are
served with `no-cache` and rewritten each release. After uploading,
`release.yml` reads every feed file back through `updates.hexbot.app` and
fails if one does not announce the new version. The download page and the
Homebrew casks link to the same files. The feed files are not attached to
the GitHub release; the packages are.

## Updating

The packaged app checks its track 15 seconds after launch and every 4
minutes after that (`apps/desktop/src/main/updater.ts`). It never downloads
on its own: when a version is available, a pill in the roster footer and the
Settings, Updates page offer "Download update", then "Restart to update".
Restarting shows an "Installing update" notice with no buttons until the app
closes and reopens on the new version.
Every check, download, and failure is written to `<home>/logs/desktop.log`.
A nightly install ignores a stable version in the bucket and the other way
round; switching tracks in Settings runs a check on the new track at once,
with downgrades allowed.

### Updating a daemon from a client

The app and the daemon it talks to can run on different machines and drift
apart. When the daemon is behind the app (two nightlies compare their whole
version, everything else compares `major.minor.patch`), the roster pill says
"Update daemon" and Settings, Updates offers to update it without a shell on
its machine. The daemon says how, through `update_capability` in
`hexbot.info`, read from `HEXBOT_SUPERVISOR`:

- `desktop`: the full package on that machine spawned the daemon
  (`backend/manager.ts` sets the variable). The daemon prints
  `HEXBOT_UPDATE_REQUESTED version=<v>`; the app checks its own track,
  downloads, and installs, writing progress to
  `<home>/runtime/update-status.json` for `hexbot.update.status`, then
  relaunches and starts the new daemon. The app's track decides what is
  installed, so an app on the stable track cannot be pushed a nightly.
- `service`: launchd or systemd runs the daemon (`service-files.ts` sets the
  variable). The daemon downloads `daemon/hexbot-src-<v>.tar.gz` from
  `updates.hexbot.app` into `<home>/runtime/src/<v>`, runs
  `uv sync --extra all --locked` into the shared runtime venv the way the
  app's bootstrap does, checks that `hexbot version` prints `<v>`, and
  restarts itself. `HEXBOT_UPDATE_URL` points a daemon at another server.
- unset: a checkout or a hand-started daemon. The page says to update by
  hand.

The client polls `hexbot.update.status` every two seconds and treats the
connection dropping and coming back on the requested version as success,
the same proof T3 Code uses. A failure, including "nothing to install",
stays on the page until dismissed.

## Borrowed from T3 Code

[T3 Code](https://github.com/pingdotgg/t3code) ships an Electron app plus a
server with the same stable-and-nightly model, and its
`.github/workflows/release.yml` and `docs/operations/release.md` are the
reference for Hexbot's. Kept as-is:

- One release workflow for both channels. `preflight` resolves the channel
  and version, quality checks run before any build, a matrix builds every
  package, `publish` creates the GitHub release, `finalize` commits version
  bookkeeping back to `main` after a stable release.
- Stable is a `vX.Y.Z` tag; a suffix (`-alpha.1`) makes a prerelease and only
  a plain `X.Y.Z` is "latest".
- Nightly is scheduled, skipped when nothing changed, versioned
  `X.Y.Z-nightly.YYYYMMDD.<run>` where `X.Y.Z` is the next release, always a
  prerelease, never "latest", never committed back to `main`.
- Concurrency is per channel and never cancels a running publisher.
- The updater's track defaults to the one the build came from (a nightly
  version means the nightly track) and downgrades are allowed only when the
  user switches tracks. The check cadence (15 s after launch, then every
  4 minutes), the single-action updater, the sidebar pill, and the
  "server behind the client, update it from here" flow are T3 Code's.
- Signing and notarization are optional and detected from secrets. The
  `.p8` key is stored as text and written to a file on the runner.
- Release notes compare against the previous release in the same channel.
- Release-only scripts run in CI against synthetic packages (T3 Code's
  `release-smoke`).
- A private, branded Electron bundle gives the source app its Dev name and
  icon in the Dock. See T3 Code's `apps/desktop/scripts/electron-launcher.mjs`.
- Dev state lives inside the checkout, ports derive from the checkout path,
  and an ambient home variable is ignored so nobody lands on the live install.

Different on purpose:

- The feed is a generic electron-updater feed on `updates.hexbot.app`, not
  GitHub Releases. The repository is private today and Hexbot is
  self-hosted; switching to `provider: github` is a one-line change in
  `electron-builder.base.yml` if that ever makes sense.
- Nightlies run once a day, not every 30 minutes with a six-hour gap.
- Two editions (full and client) instead of one app, and no Windows build
  yet.
- No npm package to publish: the daemon ships inside the full package and the
  app updates it on launch.
- Old nightlies are pruned to the last 14 on GitHub.
