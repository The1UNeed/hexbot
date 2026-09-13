# Release process

For maintainers. `docs/channels.md` explains Stable, Nightly, and Dev; this
page is the procedure and the one-time setup. Modelled on T3 Code's
`docs/operations/release.md`.

## What `release.yml` does

- Triggers: a `v*` tag push (stable), the 09:00 UTC schedule (nightly), or a
  manual dispatch (nightly).
- `preflight` picks the channel, checks that a stable tag matches
  `apps/desktop/package.json`, computes the nightly version, and stops a
  scheduled nightly when `main` has not moved.
- `check` runs `ci.yml`: Python, web, desktop, site, Connect, and the
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
  releases beyond the last 14 nightlies are deleted,
  and a nightly ends by asking Vercel to redeploy hexbot.app when
  `SITE_DEPLOY_HOOK_URL` is set, because the download page reads the nightly
  feed while it builds.
- `finalize` (stable only) runs `scripts/desktop/finalize-release.mjs` and
  commits `apps/site/public/downloads/manifest.json` and both Homebrew casks
  to `main` as `github-actions[bot]`. That push does not trigger CI. When the
  `SITE_DEPLOY_HOOK_URL` secret is set it then asks Vercel to redeploy
  hexbot.app.

`ci.yml` runs `scripts/desktop/release-smoke.mjs` on every push: the version
resolution, feed, manifest, and cask scripts against synthetic packages, so
a broken release script fails before tag day.

## Cut a stable release

1. `main` is green.
2. Pick the version. While Hexbot is `0.x` it is `0.x.y-alpha.N`. Run
   `node scripts/desktop/set-version.mjs 0.x.y-alpha.N`; it writes
   `apps/desktop/package.json` and `hexbot/__init__.py`.
3. Write `docs/releases/0.x.y-alpha.N.md`: user-visible changes, upgrade
   concerns, known issues. Without it GitHub generates notes from commits.
4. If `apps/desktop/build/Hexbot.icon` changed, run
   `./venv/bin/python scripts/desktop/make-icons.py` and commit the icons.
5. Run the desktop suite and the script tests (`docs/testing.md`). Build one
   package locally if the packaging changed:
   `node scripts/desktop/dist.mjs --mac --channel stable`.
6. Commit, then tag and push:

   ```sh
   git tag v0.x.y-alpha.N && git push origin main v0.x.y-alpha.N
   ```

7. Watch the run: preflight, check, six builds, publish, finalize. Confirm
   the GitHub release lists 6 DMGs, 4 ZIPs, 2 AppImages, 2 debs, and that
   `finalize` pushed a commit to `main`.
8. The site redeploys on its own when the `hexbot-site` Vercel project
   deploys from Git or `SITE_DEPLOY_HOOK_URL` is set; otherwise deploy it
   (`docs/deploy.md`). Publish the updated casks through the Homebrew tap.
9. Smoke test (below).

## Cut a nightly by hand

Actions, Release, "Run workflow", channel `nightly`. This publishes a real
nightly (GitHub prerelease and the nightly feed) even when `main` has not
moved. Use it to exercise the whole release graph without touching the
stable track; there is no dry-run mode, and a test tag such as
`v0.0.0-test.1` would be a real stable release.

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

- `SITE_DEPLOY_HOOK_URL` (secret): a Vercel deploy hook for the `hexbot-site`
  project. `finalize` calls it after committing the manifest. Skip it when
  the project deploys from Git on every push to `main`.
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

- `preflight` fails with "does not match": the tag and
  `apps/desktop/package.json` disagree. Delete the tag, fix the version with
  `set-version.mjs`, commit, re-tag.
- macOS build unsigned when expected signed: check that all five Apple
  secrets are populated.
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
