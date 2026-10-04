# Hexbot Installer

The windowed installer: a small Tauri app (`.dmg` on macOS, AppImage on
Linux) that installs Hexbot **Headless**, **Client**, or **Full** and fetches
only the chosen option's files. Run again, it offers Update or repair,
Change, or Uninstall. It drives the same engine as the terminal installer,
`backend/hexbot-installer`; the screens are React and Tailwind with the app's
tokens and the site's display face.

- `src/` is the page. `machine.ts` is the screen state machine (a pure
  reducer), `App.tsx` runs the engine calls, `api.ts` lists the commands.
- `src-tauri/` is the Rust side. Every command wraps one engine call on a
  worker thread and streams `Progress` over a channel. The page asks the
  user every question first, so the engine's confirmations always answer
  yes. The webview has no filesystem or shell access of its own.

## Develop

```sh
pnpm --filter ./apps/installer run dev        # the screens in a browser, against a fake engine
pnpm --filter ./apps/installer run dev:fake   # the real window, against a fake update server
```

`dev` previews the screens without Tauri. Query parameters choose the start:
`?installed=full`, `?unsupported`, `?fail=apply`, `?hold=python`, `?speed=0`
(see `src/dev/preview.ts`).

`dev:fake` builds a synthetic release in a temp directory (a fake Full and
Client app and a native archive whose `hexbot` script stands in for the
daemon), serves it from `127.0.0.1`, and runs `tauri dev` with `HOME`,
`HEXBOT_HOME`, `HEXBOT_INSTALL_APPS_DIR`, and `HEXBOT_SERVICE_ROOT` in that
directory and `HEXBOT_SERVICE_NO_LOAD=1`. It prints the paths. It never
touches `~/.hexbot`, `/Applications`, or `~/Library/LaunchAgents`. Pass
`--root DIR` to run again on the same directory and see the installed
screens, or `--server-only` to drive `hexbot-install` against it instead.

## Check and build

```sh
pnpm --filter ./apps/installer run typecheck && pnpm --filter ./apps/installer run test --run && pnpm --filter ./apps/installer run lint
cargo clippy --locked --manifest-path apps/installer/src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --locked --manifest-path apps/installer/src-tauri/Cargo.toml
pnpm --filter ./apps/installer run tauri build --bundles app   # or dmg, appimage
```

The version comes from `apps/desktop/package.json`; `release.yml` also
passes it with `--config`. `src-tauri/Cargo.lock` pins the engine's
dependencies too, so refresh it (`cargo update -p hexbot-installer`) when
`backend/hexbot-installer/Cargo.toml` changes. Linux builds need
`libwebkit2gtk-4.1-dev` and the other libraries listed in `release.yml`.
The icons in `src-tauri/icons` come from
`pnpm tauri icon ../desktop/build/icon.png -o src-tauri/icons`, keeping the
desktop sizes only.
