# Hexbot installer

Standalone crate with a blocking library, `hexbot_installer`, and the terminal
front end, `hexbot-install`. The binary reports the version compiled from
`apps/desktop/package.json`. It uses rustls and has no OpenSSL dependency.

A windowed front end can construct `Installer::from_env()`, call `detect()`,
then run `apply`, `change`, `repair`, or `uninstall` on a worker thread. Each
operation accepts a `FnMut(Progress)` callback. `change` also accepts a
confirmation callback. The library does not print. `InstallResult` contains
the receipt, daemon status JSON when available, and warnings.

`fetch_manifest(base, track)` and `default_track(base)` fetch metadata only.
`Manifest::artifact(target, option)` exposes the selected download size before
installation. `apply` fetches only that option's payload. `repair` uses the
receipt's option and track with the current manifest version. Receipts are
written atomically after successful operations. If a later step fails, the
previous receipt is retained; files already installed by setup may remain.
Status is best-effort after installation. Headless repair preserves the LAN
setting; a first install or a change into Headless enables LAN. Without a
receipt or an app, detection requires an owned service or CLI wrapper before
it offers Headless repair. Runtime files alone leave the option to the user.
Foreign services and wrappers do not block Client or Full installs and are
left alone during uninstall. Track selection falls back to Nightly only when
the Stable manifest returns 404.

`Paths::from_env()` respects `HOME`, `HEXBOT_HOME`, `HEXBOT_INSTALL_APPS_DIR`,
`HEXBOT_SERVICE_ROOT`, and `HEXBOT_SERVICE_NO_LOAD`. Explicit `Paths` let tests
and other front ends avoid global environment changes. `HEXBOT_UPDATE_URL`
sets the update server; `HEXBOT_TRACK` is a terminal default. Flags override it.

The bootstrap at `apps/site/public/install.sh` reads `install/<track>.txt`,
published beside the JSON manifest. It contains no header and one line per
target, with single spaces between these fields:

```text
<target> <64 lowercase hex sha256 characters> <absolute installer URL without whitespace>
```

The bootstrap verifies the executable before running it, reads prompts from
`/dev/tty` when available, and removes its temporary files after the child
exits. Without a terminal, pass an install flag and `--yes` for changes or
uninstall. `--json` produces one JSON object per line.

Native archives reject links and special files as well as absolute paths and
parent traversal. The release builder already materializes native archive
links. macOS installs stage a complete app on the destination volume before
replacing the previous bundle. Linux installs write an executable AppImage
and desktop entry; icon extraction is skipped and reported as a warning.
Detected deb installs must be removed with the package manager before a
change or uninstall. Installer operations do not run sudo.

Uninstall keeps bot data unless `remove_data` is true. It removes the active
runtime launcher and selection file so retained runtime caches are not
mistaken for an installed Headless service on the next run.

Run checks from the repository root:

```sh
cargo test --locked --manifest-path backend/hexbot-installer/Cargo.toml
cargo clippy --locked --manifest-path backend/hexbot-installer/Cargo.toml --all-targets -- -D warnings
cargo build --release --locked --manifest-path backend/hexbot-installer/Cargo.toml
sh -n apps/site/public/install.sh
```

Tests use a local HTTP server on a dynamically allocated port, fake native
commands, and isolated homes, apps, and service directories. They never load
launchd or systemd services or read the developer's daemon state.
