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
| Trigger | Push of a `v<version>` tag | 09:00 UTC daily when `main` moved, or by hand | You |
| GitHub release | `v<version>`; "latest" for a plain `X.Y.Z`, prerelease otherwise | `v<version>` prerelease, last 14 kept | None |
| Update feed | `latest-*.yml` on `updates.hexbot.app` | `nightly-*.yml` on `updates.hexbot.app` | None |
| Auto-updates | Yes, stable track | Yes, nightly track | No |
| Website | Landing page downloads, Homebrew casks | Linked to GitHub | `README.md`, "Develop" |
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
| `.github/workflows/release.yml` | stable, nightly | One workflow for both channels: `preflight` picks the channel and version, `check` runs CI, `build` makes six packages, `publish` uploads the feed and creates the GitHub release, `finalize` (stable only) commits the website manifest and casks |
| `scripts/desktop/release-version.mjs` | stable, nightly | Channel and version rules: tag must match `package.json`, nightly version format, product names. Tested in `packaging.test.mjs` |
| `scripts/desktop/set-version.mjs` | all | Writes one version into `apps/desktop/package.json` and `hexbot/__init__.py` |
| `scripts/desktop/dist.mjs` | all | `--channel stable\|nightly\|dev` sets the product name and app id passed to electron-builder |
| `scripts/desktop/make-update-feed.mjs` | stable, nightly | Builds the `updates.hexbot.app` directory tree from a build output: artifacts plus `latest-*.yml` or `nightly-*.yml` |
| `scripts/desktop/finalize-release.mjs` | stable | Rewrites `apps/site/public/downloads/manifest.json` and both Homebrew casks for a version |
| `scripts/desktop/release-smoke.mjs` | stable, nightly | Runs the scripts above the way `release.yml` does, against synthetic packages. CI runs it on every push |
| `scripts/dev/run.mjs` | dev | `npm run dev`: daemon and web bundle (or Electron) from the checkout with a per-checkout home and ports |
| `.devcontainer/devcontainer.json` | dev | One-command development environment with Python 3.11, uv, and Node 26 |
| `apps/desktop/electron-builder.yml`, `electron-builder.client.yml` | all | Full and client-only package definitions and their feed URLs; channel flags override `productName` and `appId` |
| `apps/desktop/src/main/updater.ts`, `desktop-state.ts` | stable, nightly | The in-app updater. The track defaults to the one the build came from and can be switched in Settings, Updates |
| `apps/site/public/downloads/manifest.json` | stable | Names the downloadable artifacts on hexbot.app; written by `finalize` |
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
`docs/releases/0.x.y-alpha.N.md`, commit, tag `v0.x.y-alpha.N`, push the tag.
The workflow does the rest, including the update feed, the website manifest,
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

A manual run (`workflow_dispatch`) builds even when nothing changed. Only the
last 14 nightlies are kept on GitHub; the update feed keeps every artifact.

Nightlies are signed when the signing secrets are present and ad-hoc signed
otherwise. They are notarized only when the Apple secrets are set.

## Dev

The dev channel is the source tree. `npm run dev` starts the daemon and the
web bundle from the checkout with `HEXBOT_HOME=<checkout>/.hexbot` and ports
derived from the checkout path; `npm run dev -- --desktop` starts the Electron
app as `Hexbot (dev)` instead (it runs the daemon itself). Its window, app
menus, Dock, and app switcher use this name and the blue icon from the root
`icon-dev.icon` bundle. Its data stays in the checkout's `.hexbot` directory.
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
```

Artifacts are immutable (their names carry the version); the `.yml` files are
served with `no-cache` and rewritten each release. After uploading,
`release.yml` reads every feed file back through `updates.hexbot.app` and
fails if one does not announce the new version. The landing page and the
Homebrew casks link to the same files. The feed files are not attached to
the GitHub release; the packages are.

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
  user switches tracks.
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
