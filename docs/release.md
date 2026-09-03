# Release process

## Prepare the version

1. Update `apps/desktop/package.json`. Use a SemVer prerelease suffix such as `0.2.0-beta.1` for beta builds.
2. Run the desktop typecheck, tests, and build listed in `docs/testing.md`.
3. Run `node --test scripts/desktop/*.test.mjs`.
4. Review the generated Python source at `apps/desktop/resources/hexbot-src`. It must not contain development virtual environments, tests, docs, or `node_modules`.
5. Commit the release changes, then create and push the matching `v<version>` tag.

## Collect CI artifacts

The tag build produces macOS arm64, macOS x64, and Linux x64 workflow artifacts. Download all three `apps/desktop/release` outputs into one release directory. Keep both DMGs, both macOS ZIP files, the AppImage, the Debian package, and their builder metadata.

## Build and publish update feeds

Run:

```sh
node scripts/desktop/make-update-feed.mjs path/to/release
```

Copy `dist/updates/mac/arm64`, `dist/updates/mac/x64`, and `dist/updates/linux/x64` into `apps/site/public/updates`. A prerelease version also produces `beta-mac.yml` and `beta-linux.yml`. Upload the site and confirm that every YAML URL returns the named artifact. Do not cache update metadata.

Upload the DMGs to `https://hexbot.app/downloads/` with their electron-builder filenames. Then update the Homebrew cask:

```sh
node scripts/desktop/update-cask.mjs path/to/release
```

Check the cask diff, publish it through the Homebrew tap, and verify both architecture hashes against the uploaded files.

## Publish the GitHub release

Create the GitHub release from the tag. Attach the DMGs, macOS ZIP files, AppImage, and Debian package. Write release notes that name user-visible changes, upgrade concerns, and known issues. Mark prerelease versions as prereleases.

## Smoke checks

Use clean machines or clean virtual machines, not development hosts.

On macOS arm64 and x64:

- Install the DMG and launch `Hexbot.app` through Finder.
- Confirm Gatekeeper accepts the signature and notarization.
- Start the bundled daemon, quit and reopen the app, then pair another client.
- Check stable or beta update discovery against the selected channel.
- Install through the cask and launch the installed app.

On Linux x86_64:

- Launch the AppImage and install the Debian package on a clean supported distribution.
- Confirm the application menu entry uses the Hexbot name, Utility category, and correct window grouping.
- Start the daemon, pair a client, restart the machine, and confirm saved state remains available.
- Check update discovery from the matching channel.

