---
layout: ../../layouts/Docs.astro
title: Run from source
description: Set up Hexbot development or build the Rust daemon with Pi from source.
---

The repository contains the Rust daemon, pinned Pi agent runtime, React web app, Electron app, Astro website, and optional Hex Connect service. Use the source checkout when developing Hexbot. To run a daemon without the app, install [Headless](/docs/install/#headless) instead; it sets up the runtime, a service, and the `hexbot` command for you.

## Prerequisites

Install Git, rustup, Node.js 26.5.0, and pnpm 10.29.3. The repository pins the Rust toolchain in `rust-toolchain.toml` and the package manager in the root `package.json`. Rust builds need the platform's compiler tools, such as Xcode Command Line Tools on macOS or a C compiler on Linux.

```sh
git clone https://github.com/The1UNeed/hexbot.git
cd hexbot
rustup show active-toolchain
pnpm install --frozen-lockfile
```

The development runner builds the daemon and installs the locked Pi dependencies. There is no Python daemon to install. Python is still needed if you use code execution tools.

## Start development

```sh
pnpm dev
```

Open the sign-in URL printed by the runner. It chooses daemon and web ports from the checkout path, so read the output instead of assuming port 5173 or 9119.

To run the Electron app:

```sh
pnpm dev --desktop
```

The development app is named `Hexbot (dev)`. Its state lives in the checkout's `.hexbot` directory. It uses its own app identity and does not check for desktop updates.

The runner accepts `--home DIR` for another data directory and `--port N` for a fixed daemon port. It deliberately ignores an ambient `HEXBOT_HOME` and refuses `~/.hexbot`, which may contain your real installation. Each worktree can run independently.

## Build the daemon from source

From the repository root, install Pi and build the web bundle and native binary:

```sh
npm ci --prefix backend/pi-runtime --ignore-scripts
pnpm --filter ./apps/web run build
cargo build --release --locked --manifest-path backend/hexbot-core/Cargo.toml --bin hexbot
```

For a first run with disposable data:

```sh
test_home=$(mktemp -d)
HEXBOT_HOME="$test_home" \
HEXBOT_PI_EXECUTABLE="$PWD/backend/pi-runtime/node_modules/.bin/pi" \
HEXBOT_WEB_DIST="$PWD/apps/web/dist" \
  backend/hexbot-core/target/release/hexbot serve --port 9119
```

Run this in a terminal to receive a one-time browser sign-in link. For another browser, use the same data directory when running `hexbot pair`. A different home creates codes for a different daemon.

For persistent use, choose a dedicated data directory and use it consistently for the daemon and CLI. Keep Node and the Pi runtime available. Copying the Rust binary alone does not install Pi, the web bundle, or bundled skills. See the [native daemon guide](https://github.com/The1UNeed/hexbot/blob/main/backend/hexbot-core/README.md) for runtime paths and packaging details.

A daemon built from source needs its own optional tool dependencies. Install Python for code execution, Poppler for PDF page rendering, and a browser or computer-use driver when enabling those tools. Linux needs bubblewrap for sandboxed commands and scheduled scripts; follow [Install](/docs/install/#linux).

The daemon defaults to localhost. Enable LAN access only when you want other devices to connect, then follow [Pairing and LAN](/docs/pairing-and-lan/), [Tailscale](/docs/tailscale/), or [Hex Connect](/docs/connect/). A service-managed or redirected process does not print a sign-in link; use a pairing code instead.

## Work on the website or Connect

```sh
pnpm site:dev
pnpm connect:dev
```

The website runs on port 4321 and Connect on port 3000. Developing the website does not require a daemon. Connect requires its own service configuration, described in [apps/connect/README.md](https://github.com/The1UNeed/hexbot/blob/main/apps/connect/README.md).

## Check changes

Run the checks for the part you changed:

```sh
pnpm --filter ./apps/site run check
cargo test --locked --manifest-path backend/hexbot-core/Cargo.toml
pnpm --filter ./apps/web run typecheck
```

Read [AGENTS.md](https://github.com/The1UNeed/hexbot/blob/main/AGENTS.md) before contributing, and [docs/testing.md](https://github.com/The1UNeed/hexbot/blob/main/docs/testing.md) for the complete test commands. The [API guide](https://github.com/The1UNeed/hexbot/blob/main/docs/api.md) documents the daemon's WebSocket contract.
