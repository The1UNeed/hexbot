# Release process

For maintainers. `docs/channels.md` explains Stable, Nightly, and Dev; this
page is the procedure and the one-time setup. Modelled on T3 Code's
`docs/operations/release.md`.

## What `release.yml` does

- Triggers: a `v*` tag push (stable), the 09:00 UTC schedule (nightly), or a
  manual dispatch (either channel).
- `preflight` picks the channel, checks that a stable tag matches
  `apps/desktop/package.json` (a manual stable run takes the version from
  that file and refuses one that is already tagged), computes the nightly
  version, and stops a scheduled nightly when `main` has not moved.
- `check` runs `ci.yml`: Rust/Pi, service handoff, web, desktop, site, Connect, and the
  desktop script tests. Nothing is built until it passes.
- `build` makes six packages in parallel: full and client for macOS arm64,
  macOS x64, and Linux x64, signed and notarized when the Apple secrets are
  present.
- `publish` builds the update feed, uploads it to `updates.hexbot.app` when
  the R2 secrets are present, reads the feed back through the public URL to
  confirm it announces the new version, then creates the GitHub release with
  every DMG, ZIP, AppImage, deb, and blockmap. Stable notes come from
  `docs/releases/<version>.md`, or GitHub generates them from the commits
  since the previous stable release. A nightly also prepends itself to
  `nightlies.json` in the bucket, which hexbot.app lists as earlier builds;
  the packages themselves are never deleted from the bucket. GitHub
  releases beyond the last 14 nightlies are deleted, and a nightly ends by
  asking Vercel to rebuild hexbot.app through `SITE_DEPLOY_HOOK_URL`,
  because the download page reads the nightly feed while it builds.
- `finalize` (stable only) runs `scripts/desktop/finalize-release.mjs` and
  commits `apps/site/public/downloads/manifest.json` and both Homebrew casks
  to `main` as `github-actions[bot]`. That push does not trigger CI, but it
  does trigger a production build of hexbot.app on Vercel (`docs/deploy.md`).

`ci.yml` runs `scripts/desktop/release-smoke.mjs` on every push: the version
resolution, feed, manifest, and cask scripts against synthetic packages, so
a broken release script fails before tag day.

Full packages bundle the native daemon, pinned Node and Pi, checksum-verified
ripgrep and fd, web assets and skills. Targets are macOS arm64, macOS x64 and Linux x64. Both macOS jobs use
the arm64 `macos-26` runner; the Intel job builds with Cargo's
`x86_64-apple-darwin` target, downloads darwin-x64 Node and installs npm
packages with `--cpu=x64 --os=darwin`. Rosetta runs the Intel runtime probe.
`rust-toolchain.toml` is the single toolchain pin. CI and releases cache Cargo
artifacts with `Swatinem/rust-cache`. Third-party actions are pinned to commit SHAs.
Node archive SHA-256 values are pinned beside `NODE_VERSION` in
`scripts/desktop/native-runtime.mjs` and must change with each Node bump.

The pinned agent still loads extensions through jiti. Precompiling our extension
alone would not remove that runtime dependency, so the loaders remain bundled.

Native archives and SHA-256 manifests live under
`daemon/native/<version>/<os>-<arch>/`. Every release also publishes
`daemon/hexbot-src-<version>.tar.gz` using `stage-python-src --native-transition`.
A client asks an old Python service to update to the client's own version, so
each version needs its own archive for as long as such services may exist.
The archive contains only `backend/python-handoff/` plus transition and build
metadata, with no runtime dependencies. Its empty `all` extra accepts the old
updater's `uv sync --extra all --locked`. Existing Python background services
follow that source feed, validate the native
bundle and version, then replace their process with the native daemon. Their
home, conversations and bot memory stay in place. If the native download or
validation fails, the version probe exits non-zero and the installed old
daemon reports failure without restarting. The old updater has already synced
its venv to the handoff package by then, so before failing the probe re-syncs
the newest legacy source in `runtime/src/`, or the one before it if that
fails, and the Python daemon keeps its packages and survives a restart. A `serve` that finds the
handoff package installed tries the native install, then the same restore,
and execs the restored Python daemon. If both fail, `serve` stays up and
retries with backoff (30 seconds, doubling to an hour) rather than exiting
into a launchd or systemd restart loop. Native startup refuses a home
whose previous listener is still reachable. Python rollback packages,
`HEXBOT_BACKEND` selection and `pnpm dev --backend python` are removed.

Activation retains the selected runtime and the previous one, plus any older
runtime still in use. Failed validation leaves the selection alone. Successful
handoff removes the old Python environment and source copies. A small forwarding
script can remain at the old launchd path until the app reloads the service.
Bootstrap rewrites old launchd/systemd definitions and removes the venv PATH.

Known gap: update manifests are not signed yet. HTTPS and archive SHA-256 checks
protect transport and detect corruption, but do not authenticate a manifest
independently of the update server. Manifest signing is a follow-up.

Native staging and the dev runner share the pins in
`apps/desktop/src/main/backend/tools.ts`. They verify ripgrep 15.2.0 and fd
10.5.0 against the pinned archive SHA-256. Native bundles include both tools,
including archives used by headless installs and Python service handoff. Before
each bot starts, its launcher copies these verified tools into Pi's managed
bin directory unless the same size and SHA-256 are already there; a failed
copy is logged and skipped when PATH already has the verified tool. The
desktop app no longer downloads search tools on first launch. First launch installs uv 0.12.18 from its pinned archive,
managed Python 3.11 for code tools and edge-tts 7.2.7 for voice, with every Python package pinned by hash in
`apps/desktop/src/main/backend/edge-tts.requirements.txt`, the independent voice dependency lock.
These are not daemon dependencies.

The bundled Node is the Node 22 LTS line, because Node 23 and later need macOS
13.5 and the app runs on macOS 12. The release packaged-app test below checks that
bundled executables need no newer macOS than the packaged Electron app.
Linux daemons are built on Ubuntu 22.04 and need glibc 2.35 or later; bootstrap runs both bundled
executables before it selects a runtime and reports a system it cannot run on.

Developer ID builds use the hardened runtime. Electron and its helpers inherit
`allow-jit`; only bundled Node receives `allow-unsigned-executable-memory`, through
`scripts/desktop/mac-sign.cjs` and `apps/desktop/entitlements.node.plist`. Intel
Node 22 LTS needs that exception: the pinned x64 probe under Rosetta traps in V8's
`OS::SetPermissions` with `allow-jit` alone. Client-only builds have no Node
exception. Ad-hoc Dev builds omit the hardened runtime so Electron's
frameworks can load without a Team ID.

Release jobs inspect the signatures and entitlements inside the packaged app,
check the packaged macOS minimum, launch Electron, run a Node JIT loop and probe
the packaged Pi and daemon versions.
They do not re-sign the binaries being checked:

```sh
HEXBOT_PACKAGED_TEST_DIR="$PWD/apps/desktop/release" \
  node --test scripts/desktop/runtime-signing.test.mjs
```

Use `stage-runtime.mjs` to stage a runtime and `make-native-update.mjs` to create
its update archive and manifest. macOS archives exclude AppleDouble files and
extended attributes. Release jobs archive the runtime inside the signed `.app`,
so daemon self-updates carry the same signatures as the full package. Archiving
recomputes the runtime manifest's file hashes after signing without changing the
signed app. Activation preserves those hashes for desktop verification. Both the
app and service updater keep the runtime with the newer manifest `builtAt`,
including when switching between Stable and Nightly.

The September 27 darwin-arm64 staging check reduced dependency files from
463,982,503 to 86,636,413 bytes, about 81%. The complete bundle contains
259,448,216 bytes, down from 636,794,306 before pruning; its archive is
75,642,999 bytes. An Intel cross-build on the same Apple Silicon host also
stages successfully and passes its runtime probe. Both updaters allow 1 GiB of
compressed data and 4 GiB unpacked, with archive path/type checks unchanged.

Local native package verification does not publish:

```sh
node scripts/desktop/dist.mjs --mac --dir
```

## Cut a stable release

1. `main` is green.
2. Pick the version. While Hexbot is `0.x` it is `0.x.y-alpha.N`. Run
   `node scripts/desktop/set-version.mjs 0.x.y-alpha.N`; it writes
   `apps/desktop/package.json`, which Rust reads at build time.
3. Write `docs/releases/0.x.y-alpha.N.md`: user-visible changes, upgrade
   concerns, known issues. Without it GitHub generates notes from commits.
   hexbot.app renders every file in that directory at `/changelog/`.
4. If `apps/desktop/build/Hexbot.icon` changed, run
   `uv run --no-project --with pillow python scripts/desktop/make-icons.py` and commit the icons.
5. Run the desktop suite and the script tests (`docs/testing.md`). Build one
   package locally if the packaging changed:
   `node scripts/desktop/dist.mjs --mac --channel stable`.
6. Commit and push `main`, then start the release one of two ways:

   - Actions, Release, "Run workflow" on `main`, channel `stable` (or
     `gh workflow run release.yml --ref main -f channel=stable`). The run
     releases the version in `apps/desktop/package.json` and creates the
     `v0.x.y-alpha.N` tag on the commit it built.
   - Or tag and push: `git tag v0.x.y-alpha.N && git push origin v0.x.y-alpha.N`.

7. Watch the run: preflight, check, six builds, publish, finalize. Confirm
   the GitHub release lists 6 DMGs, 4 ZIPs, 2 AppImages, 2 debs, and that
   `finalize` pushed a commit to `main`.
8. The site rebuilds on its own from the `finalize` commit (`docs/deploy.md`).
   Publish the updated casks through the Homebrew tap.
9. Smoke test (below).

## Cut a nightly by hand

Actions, Release, "Run workflow", channel `nightly`. This publishes a real
nightly (GitHub prerelease and the nightly feed) even when `main` has not
moved. Use it to exercise the whole release graph without touching the
stable track; there is no dry-run mode, and channel `stable` or a test tag
such as `v0.0.0-test.1` would be a real stable release.

## One-time setup

### Update server (Cloudflare R2)

1. In the Cloudflare account that holds the `hexbot.app` zone, create an R2
   bucket named `hexbot-updates` (or set the repository variable
   `R2_UPDATES_BUCKET`).
2. Add the custom domain `updates.hexbot.app` to the bucket (R2, Settings,
   Custom Domains). Cloudflare creates the DNS record.
3. Create an R2 API token with Object Read & Write on that bucket.
4. Add the GitHub Actions secrets `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, and
   `R2_SECRET_ACCESS_KEY`:

   ```sh
   gh secret set R2_ACCOUNT_ID
   gh secret set R2_ACCESS_KEY_ID
   gh secret set R2_SECRET_ACCESS_KEY
   ```

Until these exist the `publish` job skips the upload and the release is only
on GitHub; installed apps then find no update. The bucket layout is in
`docs/channels.md`. Nothing in the bucket is ever rewritten except the
`.yml` feed files, so a bad release is fixed by cutting the next one.

### Apple signing and notarization

Secrets: `CSC_LINK` (base64 Developer ID Application `.p12`),
`CSC_KEY_PASSWORD`, `APPLE_API_KEY` (contents of the App Store Connect `.p8`),
`APPLE_API_KEY_ID`, `APPLE_API_ISSUER`. electron-builder signs when the first
two are set and notarizes when all five are. The workflow writes the `.p8`
contents to a file on the runner because electron-builder expects
`APPLE_API_KEY` to be a path. Without the secrets macOS builds are ad-hoc
signed by `scripts/desktop/after-pack.cjs` so they still launch on Apple
Silicon, but Gatekeeper warns.

```sh
gh secret set CSC_LINK < developer-id.p12.base64
gh secret set CSC_KEY_PASSWORD
gh secret set APPLE_API_KEY < AuthKey_XXXXXXXXXX.p8
gh secret set APPLE_API_KEY_ID
gh secret set APPLE_API_ISSUER
```

Linux packages are not signed.

### Optional

- `SITE_DEPLOY_HOOK_URL` (secret): the `release-workflow` deploy hook on the
  `hexbot-site` Vercel project, for the `main` branch. A nightly calls it so
  the download page picks up the new feed; without it the page shows the
  previous nightly until the next push to `main`. Recreate it with
  `vercel deploy-hooks create release-workflow --ref main` from `apps/site`
  and `gh secret set SITE_DEPLOY_HOOK_URL`.
- `HEXBOT_CRASH_URL` (variable): the Crashpad endpoint baked into every
  package (`scripts/desktop/README.md`, "Crash reports"). Unset means crash
  reports stay off.
- `R2_UPDATES_BUCKET` (variable): the bucket name when it is not
  `hexbot-updates`.

Secrets and variables live at the repository level (`gh secret list`,
`gh variable list`). No GitHub environment is involved.

## Verify by hand

Build one package locally:

```sh
node scripts/desktop/dist.mjs --mac --channel stable            # full
node scripts/desktop/dist.mjs --mac --channel stable --client   # client
node scripts/desktop/dist.mjs --linux --channel stable
```

Then build the feed from it and inspect the tree:

```sh
node scripts/desktop/make-update-feed.mjs --channel stable apps/desktop/release
node scripts/desktop/make-update-feed.mjs --channel stable --client apps/desktop/release
find dist/updates -type f
```

A nightly needs a nightly version first:
`node scripts/desktop/set-version.mjs 0.1.5-nightly.20260906.1`, then
`--channel nightly`. Do not commit that version.

## Smoke checks

Use clean machines or clean virtual machines, not development hosts.

On macOS arm64 and x64:

- Install the DMG and launch the app through Finder.
- Confirm Gatekeeper accepts the signature and notarization.
- Start the bundled daemon, quit and reopen the app, then pair another client.
- Settings, Updates: "Check now" reports up to date. Switch the track to
  Nightly and check again; a nightly newer than the build is offered.
- Install through the cask and launch the installed app.
- Install the client-only DMG on a second machine, confirm it opens on the
  connect screen with no runtime install, and pair it with the first.

On Linux x86_64:

- Launch the AppImage and install the Debian package on a clean supported
  distribution.
- Confirm the application menu entry uses the Hexbot name, Utility category,
  and correct window grouping.
- Start the daemon, pair a client, restart the machine, and confirm saved
  state remains available.
- Check update discovery from the matching track.

## Troubleshooting

- `preflight` fails with "already exists" on a manual stable run: that
  version was released before. Set the next one with `set-version.mjs`,
  commit, and run again.
- `preflight` fails with "needs a v* tag or a manual run on main": a manual
  stable run was started from another branch. Run it on `main`.
- `preflight` fails with "does not match": the tag and
  `apps/desktop/package.json` disagree. Delete the tag, fix the version with
  `set-version.mjs`, commit, re-tag.
- macOS build unsigned when expected signed: check that all five Apple
  secrets are populated.
- macOS build fails in `set-key-partition-list` with "SecKeychainUnlock: The
  user name or passphrase you entered is not correct": the secrets are fine
  (the `.p12` import just before it succeeded). electron-builder older than
  26.16.1 passes the `.p12` password where the keychain's own password
  belongs, and the `macos-26` runner rejects it. Keep electron-builder at
  26.16.1 or newer.
- `publish` skipped the upload: the R2 secrets are missing. Add them and run
  a manual nightly to confirm, then re-run the stable workflow from the tag.
- "does not announce" in `publish`: the upload succeeded but
  `https://updates.hexbot.app/...` serves something else. Check the custom
  domain on the bucket and that `R2_UPDATES_BUCKET` names the same bucket.
- macOS notarization skipped although the secrets exist: the "Prepare macOS
  signing" step lists which of the five it found empty.
- The app says "Up to date" after a release: the `.yml` for that edition,
  OS, and arch was not rewritten. Check
  `https://updates.hexbot.app/full/mac/arm64/latest-mac.yml`.
