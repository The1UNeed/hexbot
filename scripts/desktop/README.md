# Desktop packaging scripts

`docs/channels.md` explains the Stable, Nightly, and Dev channels and
`docs/release.md` the release procedure. These scripts are what
`.github/workflows/release.yml` runs; every one also runs locally.

| Script | Role |
| --- | --- |
| `release-version.mjs` | Resolves channel and version (tag must match `package.json`; nightly is `<next>-nightly.<date>.<run>`) and the product name per channel. Prints GitHub Actions outputs. |
| `set-version.mjs <version>` | Writes the version into `apps/desktop/package.json` and `hexbot/__init__.py`. |
| `dist.mjs --mac\|--linux [--client] [--channel stable\|nightly\|dev]` | Builds one package. The channel sets the product name (`Hexbot [alpha]`, `Hexbot Nightly`, `Hexbot (dev)`) and app id. |
| `stage-python-src.mjs`, `python-src-manifest.mjs` | Copy the daemon's Python source into `apps/desktop/resources/hexbot-src` for the full package. |
| `after-pack.cjs` | Ad-hoc signs macOS builds when no Developer ID is configured, so they launch on Apple Silicon. |
| `make-update-feed.mjs --channel stable\|nightly [--version v] [--client] <builder-output> [feed-root]` | Builds the `updates.hexbot.app` tree: artifacts plus `latest-*.yml` or `nightly-*.yml`. |
| `finalize-release.mjs <version> <full-dir> <client-dir>` | Rewrites the website downloads manifest and both Homebrew casks after a stable release. |
| `release-smoke.mjs` | Runs `release-version`, `set-version`, `make-update-feed`, and `finalize-release` the way `release.yml` does, against synthetic packages in a temporary directory. CI runs it on every push. |
| `update-cask.mjs [--client] <release-dir> [version]` | The cask part of finalize, on its own. |
| `make-channel-icons.mjs [dev\|nightly]` | Compiles `build/icon-dev.icon` and `build/icon-nightly.icon` into their ICNS and PNG fallbacks using Xcode 26. |
| `make-icons.py` | Renders `build/icon.png`, `build/icon.icns`, and the tray images from `apps/desktop/build/Hexbot.icon`. |

Tests: `node --test scripts/desktop/*.test.mjs && node scripts/desktop/release-smoke.mjs`.

## Packages

Two packages are built from one code base:

- **full** (`Hexbot-*`, `electron-builder.yml`): bundles the Python source in `resources/hexbot-src` and installs the daemon runtime on first launch.
- **client** (`HexbotClient-*`, `electron-builder.client.yml`, built with `HEXBOT_EDITION=client`): the same app with no runtime; it can only pair with a daemon elsewhere. `apps/desktop/src/main/edition.ts` reads the edition at runtime.

Each is built for macOS arm64, macOS x64, and Linux x64.

## Update feed

`make-update-feed.mjs` generates `latest-mac.yml` (or `nightly-mac.yml`) per architecture from the artifacts (sha512 and size) because electron-builder writes a single `latest-mac.yml` that the second architecture overwrites. Linux reuses electron-builder's manifest after checking that every referenced file exists. The output layout mirrors the publish URLs in the electron-builder configs: `full/<os>/<arch>` and `client/<os>/<arch>`.

## Icons

The icon source is the Icon Composer bundle `apps/desktop/build/Hexbot.icon`. `dist.mjs` passes it to electron-builder as `mac.icon` when Xcode 26's `actool` is installed, which produces the layered macOS 26 icon. Everything else (older macOS, Linux, the CI runners, and the menu bar) uses files rendered from the same bundle:

```sh
./venv/bin/python scripts/desktop/make-icons.py
```

Run it and commit the outputs whenever the bundle changes.

Nightly and Dev each have their own bundle next to it, `build/icon-nightly.icon`
(purple) and `build/icon-dev.icon` (blue), so installs are easy to tell apart.
Rebuild their fallbacks on a Mac with Xcode 26 or newer:

```sh
node scripts/desktop/make-channel-icons.mjs          # both, or name one: dev | nightly
```

Commit `apps/desktop/build/icon-<channel>.icns` and
`apps/desktop/resources/icon-<channel>.png` with the source. Apple's compiler
renders the 256px fallback with the macOS padding and shadow. The source
launcher, Linux, and older build machines use these files; macOS packages
built with Xcode 26 use the layered `.icon` directly.

`pnpm dev --desktop` prepares a separate `Hexbot (dev).app` inside the
ignored `apps/desktop/.electron-runtime/` directory. The launcher refreshes it
when Electron or the icon changes and leaves the installed dependency intact.

## Signing

Release signing uses electron-builder's standard environment variables. Set `CSC_LINK` to the Developer ID certificate and `CSC_KEY_PASSWORD` to its password. macOS notarization runs only when `APPLE_API_KEY` (a path to the `.p8` file), `APPLE_API_KEY_ID`, and `APPLE_API_ISSUER` are all set; `release.yml` writes the key secret to a file first. Local unsigned builds disable certificate auto-discovery when neither `CSC_LINK` nor `CSC_NAME` is present.

## Crash reports

Crash reports remain off unless the user opts in and the build sets `HEXBOT_CRASH_URL` (`release.yml` takes it from the repository variable of the same name). Pass the URL when building, for example `HEXBOT_CRASH_URL=https://crashes.example.com/minidump node scripts/desktop/dist.mjs --mac --channel stable`. The endpoint must accept Electron Crashpad multipart minidump uploads. An empty URL leaves uploads disabled even when the saved preference is true.
