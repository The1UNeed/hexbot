# Desktop packaging scripts

`docs/channels.md` explains the Stable, Nightly, and Dev channels and
`docs/release.md` the release procedure. These scripts are what
`.github/workflows/release.yml` runs; every one also runs locally.

| Script | Role |
| --- | --- |
| `release-version.mjs` | Resolves channel and version (tag must match `package.json`; nightly is `<next>-nightly.<date>.<run>`) and the product name and app id per channel. Prints GitHub Actions outputs. |
| `set-version.mjs <version>` | Writes `apps/desktop/package.json`, also read by Rust at build time. |
| `dist.mjs --mac\|--linux [--client] [--channel stable\|nightly\|dev]` | Builds one package. The channel sets the product name (`Hexbot [alpha]`, `Hexbot Nightly`, `Hexbot (dev)`) and app id. |
| `stage-runtime.mjs`, `native-runtime.mjs`, `native-build.mjs` | Build Rust for the target, bundle Node and locked agent dependencies, prune unused files and verify the result. |
| `make-native-update.mjs` | Write a relocatable archive and SHA-256 manifest under `daemon/native/<version>/<target>/`. |
| `stage-python-src.mjs`, `python-src-manifest.mjs` | Stage only `backend/python-handoff/` and transition metadata for the service handoff. `--native-transition` remains accepted. |
| `mac-sign.cjs` | Keeps the bundled Node entitlement separate from Electron during Developer ID signing. |
| `after-pack.cjs` | Ad-hoc signs macOS builds when no Developer ID is configured, so they launch on Apple Silicon. |
| `make-update-feed.mjs --channel stable\|nightly [--version v] [--client] <builder-output> [feed-root]` | Builds the `updates.hexbot.app` tree: artifacts plus `latest-*.yml` or `nightly-*.yml`. |
| `make-install-manifest.mjs --channel stable\|nightly --version V <updates-root> [--base-url URL] [--allow-missing]` | Reads app feeds, native manifests and installer artifacts, verifies payloads, and writes `install/<channel>.json` and `.txt`. |
| `finalize-release.mjs <version> <full-dir> <client-dir>` | Rewrites the website downloads manifest and both Homebrew casks after a stable release. |
| `release-smoke.mjs` | Runs `release-version`, `set-version`, `make-update-feed`, `make-install-manifest`, and `finalize-release` the way `release.yml` does, against synthetic packages in a temporary directory. CI runs it on every push. |
| `update-cask.mjs [--client] <release-dir> [version]` | The cask part of finalize, on its own. |
| `make-channel-icons.mjs [dev\|nightly]` | Compiles `build/icon-dev.icon` and `build/icon-nightly.icon` into their ICNS and PNG fallbacks using Xcode 26. |
| `make-icons.py` | Renders `build/icon.png`, `build/icon.icns`, and the tray images from `apps/desktop/build/Hexbot.icon`. |

Tests: `node --test scripts/desktop/*.test.mjs && node scripts/desktop/release-smoke.mjs`.

## Packages

Two packages are built from one code base:

- **full** (`Hexbot-*`, `electron-builder.yml`): bundles the native daemon, Node, agent dependencies, web assets and skills in `resources/hexbot-native`. First launch installs managed Python for code tools and edge-tts for voice.
- **client** (`HexbotClient-*`, `electron-builder.client.yml`, built with `HEXBOT_EDITION=client`): the same app with no runtime; it can only pair with a daemon elsewhere. `apps/desktop/src/main/edition.ts` reads the edition at runtime.

Each is built for macOS arm64, macOS x64, and Linux x64.

## Update feed

`make-update-feed.mjs` generates `latest-mac.yml` (or `nightly-mac.yml`) per architecture from the artifacts (sha512 and size) because electron-builder writes a single `latest-mac.yml` that the second architecture overwrites. Linux reuses electron-builder's manifest after checking that every referenced file exists. The output layout mirrors the publish URLs in the electron-builder configs: `full/<os>/<arch>` and `client/<os>/<arch>`.

## Install manifests

Run `make-install-manifest.mjs` after app feeds, native archives and installers
have been collected into the update tree:

```sh
node scripts/desktop/make-install-manifest.mjs --channel stable --version 0.1.5-alpha.1 dist/updates
```

The JSON has schema version 1 and entries for `macos-aarch64`, `macos-x86_64`
and `linux-x86_64`. Full and Client use the macOS ZIP or Linux AppImage from
the app feed, including its SHA-512, size, product name and app id. Headless
uses the native archive's SHA-256 manifest. Terminal and windowed installer
artifacts are read from `install/<version>/` and hashed with SHA-256.
`minInstaller` is the release version. The default base URL is
`https://updates.hexbot.app`; `--base-url` selects another origin or prefix.

Missing options fail by default. `--allow-missing` omits absent options or
targets, but a feed or native manifest that references a missing file still
fails, as do stale versions, sizes or checksums. The release workflow uses
this flag only until `apps/installer/package.json` exists, and separately
requires Full, Client, Headless and the terminal installer for every target.

`install/<channel>.txt` contains only terminal installers, one line per target:
`<target> <sha256> <url>`. The POSIX bootstrap reads it without jq.
Both channel files use `no-cache`; versioned artifacts are immutable.

## Icons

The icon source is the Icon Composer bundle `apps/desktop/build/Hexbot.icon`. `dist.mjs` passes it to electron-builder as `mac.icon` when Xcode 26's `actool` is installed, which produces the layered macOS 26 icon. Everything else (older macOS, Linux, the CI runners, and the menu bar) uses files rendered from the same bundle:

```sh
uv run --no-project --with pillow python scripts/desktop/make-icons.py
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

The installer job imports the same certificate to sign the terminal binary,
then submits a ZIP to Apple's notary service when the API secrets are set.
For Tauri it maps those secrets to `APPLE_CERTIFICATE`,
`APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_API_KEY` as the
key ID, `APPLE_API_ISSUER` and `APPLE_API_KEY_PATH`.
Without a certificate, macOS installers use an ad-hoc signature.

## Crash reports

Crash reports remain off unless the user opts in and the build sets `HEXBOT_CRASH_URL` (`release.yml` takes it from the repository variable of the same name). Pass the URL when building, for example `HEXBOT_CRASH_URL=https://crashes.example.com/minidump node scripts/desktop/dist.mjs --mac --channel stable`. The endpoint must accept Electron Crashpad multipart minidump uploads. An empty URL leaves uploads disabled even when the saved preference is true.

Native staging uses `native-build.mjs` for target validation and
`native-runtime.mjs` to build Rust, download the target Node binary and install
locked npm dependencies. It removes foreign optional binaries, source maps,
type declarations and development docs/examples, then probes the packaged
runtime. The Intel macOS target can be built on Apple Silicon with Rosetta.
`make-native-update.mjs` writes archives and manifests below `daemon/native/`.
Source staging copies only `pyproject.toml`, `uv.lock`, and the three Python
files in `backend/python-handoff/hexbot/`, then writes
`HEXBOT_NATIVE_TRANSITION.json` and `HEXBOT_BUILD.json`. Tests, caches and web
assets never enter `resources/hexbot-src`. Both staging CLI forms always write
the transition marker. This is only the service handoff described
in `docs/release.md`.
