# Desktop releases

Create a `v*` tag only after updating the version in `apps/desktop/package.json`. CI builds macOS arm64, macOS x64, and Linux x64 packages. Each job uploads its `apps/desktop/release` directory as a workflow artifact.

Download the three build artifacts into one directory. Preserve the per-architecture macOS metadata as `latest-mac-arm64.yml` and `latest-mac-x64.yml` if the downloads both contain `latest-mac.yml`. Then prepare the generic update feed:

```sh
node scripts/desktop/make-update-feed.mjs path/to/builder-output
```

The script checks every file named by the YAML metadata and writes `dist/updates/mac/arm64`, `dist/updates/mac/x64`, and `dist/updates/linux/x64`. Copy those directories to `apps/site/public/updates`, then publish the site. The URL layout must remain `https://hexbot.app/updates/<os>/<arch>`.

Release signing uses electron-builder's standard environment variables. Set `CSC_LINK` to the Developer ID certificate and `CSC_KEY_PASSWORD` to its password. macOS notarization runs only when `APPLE_API_KEY`, `APPLE_API_KEY_ID`, and `APPLE_API_ISSUER` are all set. Local unsigned builds disable certificate auto-discovery when neither `CSC_LINK` nor `CSC_NAME` is present.


## Notes added after the first build

- Unsigned builds are ad-hoc signed by `after-pack.cjs` (only when
  `CSC_LINK`/`CSC_NAME` are unset). Without that step Apple Silicon kills the
  app at launch.
- `make-update-feed.mjs` generates `latest-mac.yml` per architecture from the
  artifacts (sha512 and size) because electron-builder writes a single
  `latest-mac.yml` that the second architecture overwrites. Usage:
  `node scripts/desktop/make-update-feed.mjs apps/desktop/release [dist/updates]`.
