# Release process

## Prepare the version

1. Update `apps/desktop/package.json`. Use a SemVer prerelease suffix such as `0.2.0-beta.1` for beta builds.
2. Run the desktop typecheck, tests, and build listed in `docs/testing.md`.
3. Run `node --test scripts/desktop/*.test.mjs`.
4. Review the generated Python source at `apps/desktop/resources/hexbot-src`. It must not contain development virtual environments, tests, docs, or `node_modules`.
5. Commit the release changes, then create and push the matching `v<version>` tag.

## Collect CI artifacts

The tag build produces two packages, the full package (`Hexbot-*`) and the client-only package (`HexbotClient-*`), each for macOS arm64, macOS x64, and Linux x64. Download all six `apps/desktop/release` outputs into one release directory. Keep every DMG, macOS ZIP, AppImage, and Debian package, and their builder metadata (note that `latest-linux.yml` differs per package; keep the full and client artifacts in separate directories if you download them by hand).

Build one package locally with `npm run dist:mac -w apps/desktop` (full) or `npm run dist:mac:client -w apps/desktop` (client), or the `dist:linux` variants.

## Build and publish update feeds

Run:

```sh
node scripts/desktop/make-update-feed.mjs path/to/release/full
node scripts/desktop/make-update-feed.mjs --client path/to/release/client
```

Copy `dist/updates/mac/arm64`, `dist/updates/mac/x64`, `dist/updates/linux/x64`, and the same layout under `dist/updates/client/` into `apps/site/public/updates`. A prerelease version also produces `beta-mac.yml` and `beta-linux.yml`. Upload the site and confirm that every YAML URL returns the named artifact. Do not cache update metadata.

Upload the DMGs to `https://hexbot.app/downloads/` with their electron-builder filenames and update `apps/site/public/downloads/manifest.json`. Then update both Homebrew casks:

```sh
node scripts/desktop/update-cask.mjs path/to/release/full
node scripts/desktop/update-cask.mjs --client path/to/release/client
```

Check the cask diffs, publish them through the Homebrew tap, and verify every architecture hash against the uploaded files.

## Publish the GitHub release

Create the GitHub release from the tag. Attach the DMGs, macOS ZIP files, AppImages, and Debian packages for both packages. Write release notes that name user-visible changes, upgrade concerns, and known issues. Mark prerelease versions as prereleases.

## Smoke checks

Use clean machines or clean virtual machines, not development hosts.

On macOS arm64 and x64:

- Install the DMG and launch `Hexbot.app` through Finder.
- Confirm Gatekeeper accepts the signature and notarization.
- Start the bundled daemon, quit and reopen the app, then pair another client.
- Check stable or beta update discovery against the selected channel.
- Install through the cask and launch the installed app.
- Install the client-only DMG on a second machine, confirm it opens on the connect screen with no runtime install, and pair it with the first.

On Linux x86_64:

- Launch the AppImage and install the Debian package on a clean supported distribution.
- Confirm the application menu entry uses the Hexbot name, Utility category, and correct window grouping.
- Start the daemon, pair a client, restart the machine, and confirm saved state remains available.
- Check update discovery from the matching channel.

