# Desktop releases

Create a `v*` tag only after updating the version in `apps/desktop/package.json`. CI builds two packages for macOS arm64, macOS x64, and Linux x64:

- **full** (`Hexbot-*`, `electron-builder.yml`): bundles the Python source in `resources/hexbot-src` and installs the daemon runtime on first launch.
- **client** (`HexbotClient-*`, `electron-builder.client.yml`, built with `HEXBOT_EDITION=client`): the same app with no runtime; it can only pair with a daemon elsewhere. `apps/desktop/src/main/edition.ts` reads the edition at runtime.

Each job uploads its `apps/desktop/release` directory as a workflow artifact. Locally, `node scripts/desktop/dist.mjs --mac|--linux [--client]` builds one package.

Download the three build artifacts into one directory. Preserve the per-architecture macOS metadata as `latest-mac-arm64.yml` and `latest-mac-x64.yml` if the downloads both contain `latest-mac.yml`. Then prepare the generic update feed:

```sh
node scripts/desktop/make-update-feed.mjs path/to/builder-output
```

The script checks every file named by the YAML metadata and writes `dist/updates/mac/arm64`, `dist/updates/mac/x64`, and `dist/updates/linux/x64`. Run it again with `--client` on the client package's output to write the same layout under `dist/updates/client/`. Copy those directories to `apps/site/public/updates`, then publish the site. The URL layout must remain `https://hexbot.app/updates/<os>/<arch>` for the full package and `https://hexbot.app/updates/client/<os>/<arch>` for the client package.

Release signing uses electron-builder's standard environment variables. Set `CSC_LINK` to the Developer ID certificate and `CSC_KEY_PASSWORD` to its password. macOS notarization runs only when `APPLE_API_KEY`, `APPLE_API_KEY_ID`, and `APPLE_API_ISSUER` are all set. Local unsigned builds disable certificate auto-discovery when neither `CSC_LINK` nor `CSC_NAME` is present.

After collecting both macOS DMGs, update the Homebrew cask's version and SHA-256 values:

```sh
node scripts/desktop/update-cask.mjs path/to/builder-output
```

The command expects `Hexbot-<version>-mac-arm64.dmg` and `Hexbot-<version>-mac-x64.dmg` and updates `packaging/homebrew/hexbot.rb` in place. With `--client` it expects the `HexbotClient-*` DMGs and updates `packaging/homebrew/hexbot-client.rb`. Review the diffs before publishing the casks.

Crash reports remain off unless the user opts in and the build sets `HEXBOT_CRASH_URL`. Pass the URL when building, for example `HEXBOT_CRASH_URL=https://crashes.example.com/minidump npm run dist:mac -w apps/desktop`. The endpoint must accept Electron Crashpad multipart minidump uploads. An empty URL leaves uploads disabled even when the saved preference is true.

## Notes added after the first build

- Unsigned builds are ad-hoc signed by `after-pack.cjs` (only when
  `CSC_LINK`/`CSC_NAME` are unset). Without that step Apple Silicon kills the
  app at launch.
- `make-update-feed.mjs` generates `latest-mac.yml` per architecture from the
  artifacts (sha512 and size) because electron-builder writes a single
  `latest-mac.yml` that the second architecture overwrites. Usage:
  `node scripts/desktop/make-update-feed.mjs apps/desktop/release [dist/updates]`.
